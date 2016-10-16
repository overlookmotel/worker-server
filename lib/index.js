/* --------------------
 * worker-server module
 * ------------------*/

// Modules
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

// Promisify
request.postAsync = Promise.promisify(request.post, request);

// Imports
var Errors = require('./errors'),
	Worker = require('./worker'),
	Job = require('./job'),
	Timer = require('./timer'),
	logger = require('./logger');

// Exports

/**
 * Server constructor.
 *
 * @param {Object} [options] - Options object
 */
function Server(options) {
	if (!(this instanceof Server)) return new Server(options);

	if (!options || !options.noInit) this.init(options);
}

module.exports = Server;

/*
 * Server static attributes.
 */
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

/**
 * Called by Server constructor.
 *
 * @param {Object} [options] - Options object
 * @returns {Object} - Server object
 */
Server.prototype.init = function(options) {
	// Get options
	options = this.getOptions(options, console.log);

	console.log('Loaded config', options);

	var paths = options.paths;

	// Get server version
	this.version = require(pathModule.join(paths.root, 'package.json')).version;

	// Create logger
	this.createLogger();

	// Log server initialized
	this.log('Initialized server', {version: this.version, options: options});

	// Init onConnecting + onConnected methods
	if (options.onConnecting) this.onConnecting = promisify(options.onConnecting, 1);
	if (options.onConnected) this.onConnected = promisify(options.onConnected, 0);
	if (options.onPing) this.onPing = promisify(options.onPing, 1);

	// Load workers
	this.log('Loading workers', {path: paths.workers});

	var workers = requireFolderTree(paths.workers, {flatten: true, flattenCamel: true});

	this.workers = _.mapValues(workers, function(worker, name) {
		this.log('Loading worker', {worker: name});
		return new Worker(name, worker, this);
	}.bind(this));

	this.log('Loaded workers');

	// Create jobs object
	this.jobs = {};

	// Create timer and lock for getting next job
	this.jobLock = new Locker();
	this.jobTimer = new Timer();

	// Create lock for connecting to master
	this.connectLock = new Locker();

	// Flag as not started
	this.started = false;
	this.connected = false;
	this.stopped = false;

	// Done
	this.log('Initialized server');
	return this;
};

/**
 * Reads config from file and combines with options provided.
 * @param {Object} [options] - Options object
 * @returns {Object} - Options object
 */
Server.prototype.getOptions = function(options, log) {
	// Default logger
	if (!log) log = function() {};

	// Conform options
	if (typeof options == 'string') options = {paths: {root: options}};
	options = _.clone(options || {});

	var paths = options.paths || {};
	if (typeof paths == 'string') paths = {root: paths};
	paths = options.paths = _.extend({root: process.cwd()}, paths);

	// Load config
	var configPath = paths.config || pathModule.join(paths.root, 'config');

	log('Initializing server', {version: this.version});
	log('Loading config', {path: configPath});

	if (configPath && fs.existsSync(configPath)) {
		var config = configLoad(configPath, {selectors: {local: null}});
		options = _.merge(config, options);
		paths = options.paths;
	}

	// Default options
	_.defaults(options, {
		name: 'worker-server app',
		jobInterval: 30000,
		messageInterval: 10000,
		connectInterval: 10000,
		log: {}
	});

	if (!options.logName) options.logName = kebabCase(options.name);

	// Define paths
	['config', 'workers', 'jobs', 'log'].forEach(function(pathType) {
		if (!paths[pathType]) paths[pathType] = pathModule.join(paths.root, pathType);
	});

	// Save some options to server
	this.serverId = options.serverId;
	this.password = options.password;
	this.master = options.master;

	// Save options to server + return
	this.options = options;
	return options;
};

/**
 * Creates logger and attaches to `server`.
 * @returns {Function} - Logging function
 */
Server.prototype.createLogger = function() {
	// Create logger
	var options = this.options;
	this.log = logger(options.name, options.logName, options.paths.log, options.log);

	// Save logging options to server options
	options.log = this.log.options;

	return this.log;
};

/**
 * Start server.
 * Returns promise that resolves when server connects to master
 * or server is stopped externally before connection occurs.
 * Promise never rejects.
 *
 * @returns {Promise<undefined>}
 */
Server.prototype.start = cow(function*() {
	// Set handler for shutdown (SIGINT for ctrl-C in terminal, SIGTERM for `pm2 stop`)
	process.once('SIGINT', this.stop.bind(this, 'SIGINT'));
	process.once('SIGTERM', this.stop.bind(this, 'SIGTERM'));

	this.log('Starting server');

	// Connect to master server
	yield this.connect();
});

/**
 * Attempt to connect/reconnect to master server once.
 * If succeeds in connecting, sends the job cache + sends 'online' status message.
 * @returns {Promise} - Resolved if success, rejected if failed
 */
var connectDo = cow(function*() {
	// Connect to server
	var status = (this.started ? 'Reconnecting' : 'Connecting');
	this.log(status + ' to master server');
	try {
		yield this.sendServerStatus(status);
	} catch (err) {
		this.log.warn(status + ' to master server failed', err);
		throw new Errors.Connection('Could not connect to master server', err);
	}
	this.log(status.slice(0, -3) + 'ed to master server');

	// Send job cache
	yield this.sendJobCache();

	// Send server online message
	this.log('Onlining server');
	try {
		var data = {};
		if (!this.started) {
			var workers = _.toPairs(this.workers).map(function(pair) {
				return {code: pair[0], version: pair[1].version};
			});
			data = {startup: true, version: this.version, workers: workers};
		}
		if (this.onConnecting) yield this.onConnecting(data);

		yield this.sendServerStatus('Online', data);
	} catch (err) {
		this.log.warn('Onlining server failed', err);
		throw err;
	}

	// Flag as connected
	this.connected = true;
	this.started = true;

	this.log('Onlined server');

	// Run onConnected handler
	if (this.onConnected) yield this.onConnected();

	// Get a job from master server
	this.nextJob();
});

/**
 * Attempt to connect/reconnect repeatedly until succeeds.
 * Returns a promise that resolves when successfully connected, or if `.stopped()` called.
 * Promise never rejects.
 * @returns {Promise}
 */
Server.prototype.connect = cow(function*() {
	// Connect to master, and retry until succeed
	while (!this.connected && !this.stopped) {
		try {
			// Wait for any currently running connection/stopping/sending messages to complete
			// then try to connect
			yield this.connectLock.lock(function*() {
				// If connected or stopped by time get lock, exit
				if (this.connected || this.stopped) return;

				// Connect
				yield connectDo.call(this);
			}, this);
		} catch (err) {
			// Failed - wait and try again
			yield Promise.delay(this.options.connectInterval);
		}
	}
});

/**
 * Called internally when server is disconnected.
 * @returns {undefined}
 */
Server.prototype.disconnected = function() {
	// If already disconnected, exit
	if (!this.connected) return;

	// Flag server as disconnected
	this.connected = false;

	// Cancel get next job timer
	this.jobTimer.cancel();

	// Reconnect
	this.connect();
};

/**
 * Send the job cache from disc to master server.
 * @returns {Promise} - Resolves if sent OK, rejected if failed
 */
Server.prototype.sendJobCache = cow(function*() {
	try {
		this.log('Sending job cache');

		// Read all job cache and send to master server
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

/**
 * Called on SIGINT (ctrl-C in terminal) or SIGTERM (`pm2 stop`).
 * Cancels all running jobs and sends 'Offline' status message to master server.
 * Then terminates process.
 * @param {string} signal - Name of signal received that stopped process i.e. 'SIGINT'/'SIGTERM'
 */
Server.prototype.stop = cow(function*(signal) {
	this.log.warn('Received signal', {signal: signal});
	this.log('Stopping server');

	// Flag as stopped
	this.stopped = true;
	this.connected = false;

	// Stop pinging for new jobs
	this.jobTimer.clear();

	// If connecting or sending jobs, wait until finished
	yield this.connectLock.lock(function() {
		this.connected = false;
	});

	// Send 'Stopping' status to master server (ignore failure)
	var data = {reason: 'Process stopped externally'};
	yield this.sendServerStatus('Stopping', data).catch(function() {});

	// Cancel running jobs (ignore failures)
	yield _.mapValues(this.jobs, cow(function*(job) {
		yield job.cancel().catch(function() {});
	}));

	// Send 'Offline' status to master server (ignore failure)
	yield this.sendServerStatus('Offline').catch(function() {});

	this.log('Stopped server');

	// Terminate process
	process.exit();
});

/**
 * Send server status message.
 * Will attempt to send even if server is disconnected.
 * If fails, attempts reconnect to server.
 * @param {string} status - Status e.g. 'Connecting'
 * @param {Object} data - Status message payload
 * @returns {Promise} - Resolved if sent, rejected if not.
 */
Server.prototype.sendServerStatus = cow(function*(status, data) {
	var path = this.master.paths.serverStatus.replace(':serverId', this.serverId);
	return yield this.sendMessage(path, {status: status, data: JSON.stringify(data)}, true);
});

/**
 * Send job status message
 * If fails, attempts reconnect to server.
 * Should not be used externally - use `recordJobStatus` instead.
 *
 * @param {number} jobId - Job ID
 * @param {string} status - Status e.g. 'Connecting'
 * @param {Object} data - Status message payload
 * @param {boolean} override - If `true` will try to send even if server is disconnected.
 * @returns {Promise} - Resolved if sent, rejected if not.
 */
Server.prototype.sendJobStatus = cow(function*(jobId, status, data, override) {
	var path = this.master.paths.jobStatus.replace(':jobId', jobId);
	return yield this.sendMessage(path, {status: status, data: JSON.stringify(data)}, override);
});

/**
 * Send message to master server.
 * If fails, attempts reconnect to server.
 *
 * @param {string} path - URL path to hit on master server.
 * @param {Object} data - Message payload
 * @param {boolean} override - If `true` will try to send even if server is disconnected.
 * @returns {Promise} - Resolves/rejects dependent on whether message sent successfully
 */
Server.prototype.sendMessage = cow(function*(path, data, override) {
	// If not connected, throw error (unless override flag set)
	if (!override && !this.connected) throw new Errors.Connection('Not connected to server');

	try {
		return yield this._sendMessage(path, data);
	} catch (err) {
		// Server disconnected
		this.disconnected();
		throw err;
	}
});

/**
 * Send message to master server.
 * @returns {Promise} - Resolves/rejects dependent on whether message sent successfully
 */
Server.prototype._sendMessage = cow(function*(path, data) {
	// Add serverId and password to data
	if (!data) data = {};
	data.serverId = this.serverId;
	data.serverPassword = this.password;

	// Hit API
	var url = this.master.host + path,
		response;

	// Create logger for this request
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

	// Parse API JSON response
	var result;
	try {
		result = JSON.parse(response.body);
		log('Received response', {result: result});
	} catch (err) {
		log.warn('Server bad response', err);
		throw new Errors.Connection('Bad response from master server', err);
	}

	// Check for login fail
	// TODO Implement sessions
	var err;
	if (result.redirect == '/login') {
		err = new Errors.Api('Login fail');
		log.error('Login fail', err);
		throw err;
	}

	// Check for errors
	if (result.error) {
		err = new Errors.Api('API error', result.error);
		log.error('API error', err);
		throw err;
	}

	// Check API action completed successfully
	// TODO Do a whitelist test rather than blacklist here
	// TODO generalize for standard APIs
	if (result.formErrors) {
		err = new Errors.Api('API error', result.formErrors);
		log.error('API error', err);
		throw err;
	}

	// Done
	log('Received response data', {data: result.data});
	return result.data;
});

/**
 * Record job status
 * Tries to send to master server, if fails then records to job cache on disc.
 *
 * @param {number} jobId - Job ID
 * @param {string} status - Status e.g. 'Connecting'
 * @param {Object} data - Status message payload
 * @returns {Promise} - Resolved if sent, rejected if not (NB rejects if writes to disc)
 */
Server.prototype.recordJobStatus = cow(function*(jobId, status, data) {
	// Get non-exclusive lock on connect
	// i.e. if currently connecting, wait until finished trying to connect
	yield this.connectLock.run(function*() {
		// Try to send message to server
		try {
			yield this.sendJobStatus(jobId, status, data);
		} catch (err) {
			// Sending message failed - record to file cache instead
			var json = JSON.stringify({status: status, data: data});
			try {
				yield fs.writeFileAsync(pathModule.join(this.options.paths.jobs, jobId + '.json'), json);
			} catch (err) {
				this.log.error('Could not write job to disc', err);
				throw new Errors.Base('Could not write job to disc', err);
			}

			// Rethrow unexpected errors
			if (!(err instanceof Errors.Connection) && !(err instanceof Errors.Api)) throw err;
		}
	}, this);
});

/**
 * Get next job to execute from master server
 * @returns {undefined}
 */
Server.prototype.nextJob = function() {
	this._nextJob().done();
};

/**
 * Get next job to execute from master server.
 * Do not call directly - use `.nextJob()`.
 * Returns promise which will only reject if there is an error in `onPing` handler.
 * @returns {Promise}
 */
Server.prototype._nextJob = cow(function*() {
	// If timer running, cancel it
	this.jobTimer.clear();

	// If not connected, exit - server will request another job once connected
	if (!this.connected) return;

	// If already getting job, exit
	if (this.jobLock.locked) return;

	var result;
	yield this.jobLock.lock(function*() {
		// Ask master server for next job
		try {
			this.log('Requesting next job from server');
			var path = this.master.paths.ping.replace(':serverId', this.serverId);
			result = yield this.sendMessage(path);
		} catch (err) {
			this.log.warn('Failed to get next job from server');
		}

		// Run onPing function
		if (result && this.onPing) yield this.onPing(result);
	}, this);

	// If no job found, schedule to ping again for new job after delay
	var jobParams = (result || {}).job;
	if (!jobParams) {
		this.log('No jobs available');

		this.jobTimer.schedule(this.nextJob, this, this.options.jobInterval);
		return;
	}

	this.log('Job received', jobParams);

	// Run the job
	var jobPromise = this.startJob(jobParams);

	// Get another job
	this.nextJob();

	// When job complete, get another job
	yield jobPromise;
	this.nextJob();
});

/**
 * Create new job from params and run it.
 * Returns promise that resolves when job completes (success or fail).
 * Promise will never reject.
 * @param {Object} params - Job parameters
 * @returns {Promise}
 */
Server.prototype.startJob = cow(function*(params) {
	// Create job
	var job = new Job(params, this);

	// Record job in jobs object
	this.jobs[job.id] = job;

	// Start job
	return yield job.start();
});

/**
 * Call when a job finishes (either success or failure).
 * Deletes job from the job list.
 * @param {Job} job
 */
Server.prototype.finishedJob = function(job) {
	// Remove job from jobs object
	delete this.jobs[job.id];
};

/**
 * Utility function: Convert camel case or human case to kebab-case
 * @param {string} txt
 * @return {string} - `txt` converted to kebab case
 */
function kebabCase(txt) {
	return txt.replace(/[A-Z]/g, function(c) {return ' ' + c.toLowerCase();})
		.replace(/^\s+/, '')
		.replace(/\s+$/, '')
		.replace(/\s+/g, '-');
}
