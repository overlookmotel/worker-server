// --------------------
// worker-server module
// --------------------

// modules
var pathModule = require('path'),
	Promise = require('bluebird'),
	fs = require('fs-extra-promise').usePromise(Promise),
	co = require('co-bluebird'),
	cow = co.wrap,
	cos = require('co-series').use(Promise),
	promisify = require('promisify-any'),
	Locker = require('lock-queue'),
	request = require('request'),
	configLoad = require('config-load'),
	requireFolderTree = require('require-folder-tree'),
	uuid = require('uuid'),
	_ = require('lodash');

// promisify
request.postAsync = Promise.promisify(request.post, request);

// imports
var Errors = require('./errors'),
	Worker = require('./worker'),
	Job = require('./job'),
	Timer = require('./timer'),
	logger = require('./logger');

// exports

/*
 * Server constructor
 */
var Server = module.exports = function(options) {
	if (!(this instanceof Server)) return new Server(options);

	if (!options || !options.noInit) this.init(options);
};

Server.Errors = Errors;
Server.Job = Job;
Server.Worker = Worker;

Server.Utils = {
	Promise: Promise,
	promisify: promisify,
	co: co,
	coSeries: cos,
	_: _
};

/*
 * `init` method
 * Called by Server constructor
 */
Server.prototype.init = function(options) {
	// get options
	options = this.getOptions(options, console.log);

	console.log('Loaded config', options);

	var paths = options.paths;

	// get server version
	this.version = require(pathModule.join(paths.root, 'package.json')).version;

	// create logger
	this.createLogger();

	// log server initialized
	this.log('Initialized server', {version: this.version, options: options});

	// init onConnecting + onConnected methods
	if (options.onConnecting) this.onConnecting = promisify(options.onConnecting, 1);
	if (options.onConnected) this.onConnected = promisify(options.onConnected, 0);
	if (options.onPing) this.onPing = promisify(options.onPing, 1);

	// load workers
	this.log('Loading workers', {path: paths.workers});

	var workers = requireFolderTree(paths.workers, {flatten: true, flattenCamel: true});

	this.workers = _.mapValues(workers, function(worker, name) {
		this.log('Loading worker', {worker: name});
		return new Worker(name, worker, this);
	}.bind(this));

	this.log('Loaded workers');

	// create jobs object
	this.jobs = {};

	// create timer for getting next job
	this.jobTimer = new Timer();

	// create lock for connecting
	this.connectLock = new Locker();

	// flag as not started
	this.started = false;
	this.connected = false;
	this.stopped = false;

	// done
	this.log('Initialized server');
	return this;
};

/*
 * `getOptions` method
 * Reads config from file and combines with options provided
 */
Server.prototype.getOptions = function(options, log) {
	// default logger
	if (!log) log = function() {};

	// conform options
	if (typeof options == 'string') options = {paths: {root: options}};
	options = _.clone(options || {});

	var paths = options.paths || {};
	if (typeof paths == 'string') paths = {root: paths};
	paths = options.paths = _.extend({root: process.cwd()}, paths);

	// load config
	var configPath = paths.config || pathModule.join(paths.root, 'config');

	log('Initializing server', {version: this.version});
	log('Loading config', {path: configPath});

	if (configPath && fs.existsSync(configPath)) {
		var config = configLoad(configPath, {selectors: {local: null}});
		options = _.merge(config, options);
		paths = options.paths;
	}

	// default options
	_.defaults(options, {
		name: 'worker-server app',
		jobInterval: 30000,
		messageInterval: 10000,
		connectInterval: 10000,
		log: {}
	});

	if (!options.logName) options.logName = kebabCase(options.name);

	// define paths
	['config', 'workers', 'jobs', 'log'].forEach(function(pathType) {
		if (!paths[pathType]) paths[pathType] = pathModule.join(paths.root, pathType);
	});

	// save some options to server
	this.serverId = options.serverId;
	this.password = options.password;
	this.master = options.master;

	// save options to this + return
	this.options = options;
	return options;
};

/*
 * `createLogger` method
 * Creates logger
 */
Server.prototype.createLogger = function() {
	// create logger
	var options = this.options;
	this.log = logger(options.name, options.logName, options.paths.log, options.log);

	// save logging options to server options
	options.log = this.log.options;

	return this.log;
};

/**
 * `start` method
 * Call to start server.
 * @returns {Promise} - Resolved when server connects to master or server is stopped externally
 */
Server.prototype.start = cow(function*() {
	// set handler for shutdown (SIGINT for ctrl-C in terminal, SIGTERM for `pm2 stop`)
	process.once('SIGINT', this.stopped.bind(this, 'SIGINT'));
	process.once('SIGTERM', this.stopped.bind(this, 'SIGTERM'));

	this.log('Starting server');

	// connect to master server
	yield this.connect();
});

/*
 * Attempt to connect/reconnect to master server once.
 * If succeeds in connecting, sends the job cache + sends 'online' status message
 * @returns {Promise} - Resolved if success, rejected if failed
 */
var connectDo = cow(function*() {
	// connect to server
	var status = (this.started ? 'Reconnecting' : 'Connecting');
	this.log(status + ' to master server');
	try {
		yield this.sendServerStatus(status);
	} catch (err) {
		this.log.warn(status + ' to master server failed', err);
		throw new Errors.Connection('Could not connect to master server', err);
	}
	this.log(status.slice(0, -3) + 'ed to master server');

	// send job cache
	yield this.sendJobCache();

	// send server online message
	this.log('Onlining server');
	try {
		var data = {};
		if (!this.started) data = {startup: true, version: this.version, workers: Object.keys(this.workers)};
		if (this.onConnecting) yield this.onConnecting(data);

		yield this.sendServerStatus('Online', data);
	} catch (err) {
		this.log.warn('Onlining server failed', err);
		throw err;
	}

	// flag as connected
	this.connected = true;
	this.started = true;

	this.log('Onlined server');

	// run onConnected handler
	if (this.onConnected) yield this.onConnected();

	// get a job from server
	this.nextJob();
});

/**
 * Attempt to connect/reconnect repeatedly until succeeds.
 * @returns {Promise} - Promise resolved upon successful connection, or if `.stopped()` called
 */
Server.prototype.connect = cow(function*() {
	// if already connected or connecting or stopped, exit
	if (this.connected || this.connectLock.locked || this.stopped) return;

	// connect to master, and retry until succeed
	try {
		// try to connect
		yield this.connectLock.lock(function*() {
			if (this.stopped) return;
			yield connectDo.call(this);
		}, this);
	} catch (err) {
		// failed - wait and try again
		yield Promise.delay(this.options.connectInterval);
		yield this.connect();
		return;
	}
});

/**
 * Called when server is disconnected.
 * @returns {undefined}
 */
Server.prototype.disconnected = function() {
	// flag server as disconnected
	this.connected = false;

	// cancel get next job timer
	this.jobTimer.cancel();

	// reconnect
	this.connect();
};

/*
 * Send the job cache from disc to master server
 */
Server.prototype.sendJobCache = cow(function*() {
	try {
		this.log('Sending job cache');

		// read all job cache and send to master server
		var jobsPath = this.options.paths.jobs;
		var files = yield fs.readdirAsync(jobsPath);

		yield files.map(cow(function*(filename) {
			if (filename.slice(-5) != '.json') return;

			var jobId = filename.slice(0, -5) * 1,
				path = pathModule.join(jobsPath, filename);

			var job = yield fs.readFileAsync(path, {encoding: 'utf8'});
			job = JSON.parse(job);

			yield this.sendJobStatus(jobId, job.status, job.data, true);

			yield fs.unlinkAsync(path);
		}).bind(this));

		this.log('Sent job cache');
	} catch (err) {
		this.log.warn('Sending job cache failed', err);
		throw err;
	}
});

/*
 * Called on SIGINT (ctrl-C in terminal) or SIGTERM (`pm2 stop`)
 * Sends 'Offline' status message to master server
 */
Server.prototype.stopped = cow(function*(signal) {
	this.log.warn('Received signal', {signal: signal});
	this.log('Stopping server');

	// flag as stopped
	this.stopped = true;
	this.connected = false;

	// stop pinging for new jobs
	this.jobTimer.stop();

	// if connecting, wait until finished
	yield this.connectLock.lock(function() {
		this.connected = false;
	});

	// send 'Stopping' status to master server
	var data = {reason: 'Process stopped externally'};
	yield ignoreErrors(this.sendServerStatus('Stopping', data));

	// cancel running jobs
	yield _.mapValues(this.jobs, cow(function*(job) {
		yield job.cancel();
	}));

	// send 'Offline' status to master server
	yield ignoreErrors(this.sendServerStatus('Offline'));

	this.log('Stopped server');

	// exit application
	process.exit();
});

/*
 * Send server status message
 */
Server.prototype.sendServerStatus = cow(function*(status, data) {
	var path = this.master.paths.serverStatus.replace(':serverId', this.serverId);
	return yield this.sendMessage(path, {status: status, data: JSON.stringify(data)}, true);
});

/*
 * Send job status message
 * If fails, attempts reconnect to server.
 * Should not be used externally - use `recordJobStatus` instead.
 */
Server.prototype.sendJobStatus = cow(function*(jobId, status, data, override) {
	// send job status
	var path = this.master.paths.jobStatus.replace(':jobId', jobId);
	return yield this.sendMessage(path, {status: status, data: JSON.stringify(data)}, override);
});

/**
 * Send message to master server.
 * @returns {Promise} - Resolves/rejects dependent on whether message sent successfully
 */
Server.prototype.sendMessage = cow(function*(path, data, override) {
	// if not connected, throw error
	if (!override && !this.connected) throw new Errors.Connection('Not connected to server');

	try {
		return yield this._sendMessage(path, data);
	} catch (err) {
		// server disconnected
		this.disconnected();
		throw err;
	}
});

Server.prototype._sendMessage = cow(function*(path, data) {
	// add serverId and password to data
	if (!data) data = {};
	data.serverId = this.serverId;
	data.serverPassword = this.password;

	// hit API
	var url = this.master.host + path,
		response;

	// create logger for this request
	var log = this.log.child({messageId: uuid.v4()});

	log('Sending message', {path: path, data: data});

	try {
		response = yield request.postAsync({
			url: url,
			form: data,
			followRedirect: false,
			headers: {Accept: 'application/json'}
		});
		response = response[0];
	} catch (err) {
		log.warn('Server connection error', err);
		throw new Errors.Connection('Could not connect to master server', err);
	}

	// parse API JSON response
	var result;
	try {
		result = JSON.parse(response.body);
		log('Received response', {result: result});
	} catch (err) {
		log.warn('Server bad response', err);
		throw new Errors.Connection('Bad response from master server', err);
	}

	// check for login fail
	// xxx implement sessions
	var err;
	if (result.redirect == '/login') {
		err = new Errors.Api('Login fail');
		log.error('Login fail', err);
		throw err;
	}

	// check for errors
	// xxx should these errors be sent?
	if (result.error) {
		err = new Errors.Api('API error', result.error);
		log.error('API error', err);
		throw err;
	}

	// check API action completed successfully
	// xxx do a whitelist test rather than blacklist here
	// xxx generalize for standard APIs
	if (result.formErrors) {
		err = new Errors.Api('API error', result.formErrors);
		log.error('API error', err);
		throw err;
	}

	// done
	log('Received response data', {data: result.data});
	return result.data;
});

/*
 * Record job status
 * Tries to send to master server, if fails then records to job cache on disc
 */
Server.prototype.recordJobStatus = cow(function*(jobId, status, data) {
	// get non-exclusive lock on connect - i.e. if currently connecting, wait until finished attempt
	yield this.connectLock.run(function*() {
		// try to send message to server
		try {
			yield this.sendJobStatus(jobId, status, data);
		} catch (err) {
			// sending message failed - record to file cache instead
			var json = JSON.stringify({status: status, data: data});
			try {
				yield fs.writeFileAsync(pathModule.join(this.options.paths.jobs, jobId + '.json'), json);
			} catch (err) {
				this.log.error('Could not write job to disc', err);
				throw new Errors.Base('Could not write job to disc', err);
			}

			// rethrow if unexpected error
			if (!(err instanceof Errors.Connection) && !(err instanceof Errors.Api)) throw err;
		}
	}, this);
});

/*
 * Get next job to execute from master server
 */
Server.prototype.nextJob = function() {
	this.jobTimer.now(this._nextJob.bind(this));
};

Server.prototype._nextJob = cow(function*() {
	// ask master server for next job
	var result;
	try {
		this.log('Requesting next job from server');
		var path = this.master.paths.ping.replace(':serverId', this.serverId);
		result = yield this.sendMessage(path);
	} catch (err) {
		this.log.warn('Failed to get next job from server');
	}

	// run onPing function
	if (result && this.onPing) yield this.onPing(result);

	// if no job found, schedule to ping again for new job after delay
	var jobParams = (result || {}).job;
	if (!jobParams) {
		this.log('No jobs available');

		this.jobTimer.future(this._nextJob.bind(this), this.options.jobInterval);
		return;
	}

	this.log('Job received', jobParams);

	// run the job
	var jobPromise = this.startJob(jobParams);

	// get another job
	this.nextJob();

	// when job complete, get another job
	yield jobPromise;
	this.nextJob();
});

/*
 * Create new job from params and run it
 */
Server.prototype.startJob = cow(function*(params) {
	// create job
	var job = new Job(params, this);

	// record job in jobs object
	this.jobs[job.id] = job;

	// start job
	return yield job.start();
});

/*
 * Called when a job finishes (either success or failure)
 */
Server.prototype.finishedJob = function(job) {
	// remove job from jobs object
	delete this.jobs[job.id];
};

function ignoreErrors(promise, type) {
	if (type) return promise.catch(type, function() {});
	return promise.catch(function() {});
}

function kebabCase(txt) {
	return txt.replace(/[A-Z]/g, function(c) {return ' ' + c.toLowerCase();})
		.replace(/^\s+/, '')
		.replace(/\s+$/, '')
		.replace(/\s+/g, '-');
}
