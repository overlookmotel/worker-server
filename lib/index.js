// --------------------
// worker-server module
// --------------------

// modules
var pathModule = require('path'),
    Promise = require('bluebird'),
    fs = require('fs-extra-promise'),
    co = require('co-bluebird'),
    cow = co.wrap,
    cos = require('co-series'),
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
    wait = require('./wait'),
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
    co: co,
    coSeries: cos,
    _: _
};

/*
 * `init` method
 * Called by Server constructor
 */
Server.prototype.init = function(options) {
    // conform options
    if (typeof options == 'string') options = {paths: {root: options}};
    options = _.clone(options || {});

    var paths = options.paths || {};
    if (typeof paths == 'string') paths = {root: paths};
    paths = options.paths = _.extend({root: process.cwd()}, paths);

    // get server version
    this.version = require(pathModule.join(paths.root, 'package.json')).version;

    // load config
    var configPath = paths.config || pathModule.join(paths.root, 'config');

    console.log('Initializing server', {version: this.version});
    console.log('Loading config', {path: configPath});

    if (configPath && fs.existsSync(configPath)) {
        var config = configLoad(configPath, {selectors: {local: null}});
        options = _.merge(config, options);
        paths = options.paths;
    }

    // default options
    _.defaults(options, {
        name: 'worker-server app',
        port: 3000,
        jobInterval: 30000,
        messageInterval: 10000,
        connectInterval: 10000,
        log: {}
    });

    if (!options.logName) options.logName = kebabCase(options.name);

    // save options to server object
    this.options = options;

    // define paths
    ['config', 'workers', 'jobs', 'log'].forEach(function(pathType) {
        if (!paths[pathType]) paths[pathType] = pathModule.join(paths.root, pathType);
    });

    console.log('Loaded config', options);

    // create logger
    this.log = logger(options.name, options.logName, paths.log, options.log);
    options.log = this.log.options;

    this.log('Initialized server', {configPath: configPath, version: this.version, options: options});

    // load attributes
    this.serverId = options.serverId;
    this.password = options.password;
    this.master = options.master;

    if (options.onConnecting) this.onConnecting = promisify(options.onConnecting, 1);
    if (options.onConnected) this.onConnected = promisify(options.onConnected, 0);

    // load workers
    this.log('Loading workers', {path: paths.workers});

    var workers = requireFolderTree(paths.workers, {flatten: true, flattenCamel: true});

    this.workers = _.mapValues(workers, function(worker, name) {
        this.log('Loading worker', {worker: name});
        return new Worker(name, worker);
    }.bind(this));

    this.log('Loaded workers');

    // create jobs object
    this.jobs = {};

    // create timers object
    this.timers = {};

    // create lock for connecting
    this.connectLock = new Locker();

    // flag as not started
    this.started = false;

    // done
    this.log('Initialized server');
    return this;
};

/*
 * `start` method
 * Should be called to start server
 */
Server.prototype.start = cow(function*() {
    // set handler for shutdown (SIGINT for ctrl-C in terminal, SIGTERM for `pm2 stop`)
    process.once('SIGINT', this.stopped.bind(this, 'SIGINT'));
    process.once('SIGTERM', this.stopped.bind(this, 'SIGTERM'));

    this.log('Starting server');

    try {
        // connect to master server
        yield this.connect();
    } catch (err) {
        if (!(err instanceof Errors.Cancelled)) throw err;
    }

    // return server object
    return this;
});

/*
 * Attempt to connect/reconnect to master server once
 * If succeeds in connecting, sends the job cache + sends 'online' status message
 */
var connectDo = cow(function*() {
    // flag server as offline
    this.connected = false;

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

/*
 * Attempt to connect/reconnect repeatedly until succeeds
 */
Server.prototype.connect = cow(function*() {
    while (true) {
        try {
            // try to connect
            yield this.connectLock.lock(function*() {
                yield connectDo.call(this);
            }, this);

            // connect succeeded - exit
            return;
        } catch (err) {
            // failed - wait and try again
            var cont = yield this.wait('connect', this.options.connectInterval);
            if (!cont) throw new Errors.Cancelled('Connecting to master server cancelled');
        }
    }
});

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

    // clear timers
    this.connectTimerClear();
    this.jobTimerClear();

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

/*
 * Send message to master server
 */
Server.prototype.sendMessage = cow(function*(path, data, override) {
    // if not connected, throw error
    if (!override && !this.connected) throw new Errors.Connection('Not connected to server');

    try {
        return yield this._sendMessage(path, data);
    } catch (err) {
        // if not already reconnecting, reconnect
        if (this.connected) {
            this.jobTimerClear();
            ignoreErrors(this.connect(), Errors.Cancelled).done();
        }
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
            // rethrow if unexpected error
            if (!(err instanceof Errors.Connection) && !(err instanceof Errors.Api)) throw err;

            // sending message failed - record to file cache instead
            var json = JSON.stringify({status: status, data: data});
            try {
                yield fs.writeFileAsync(pathModule.join(this.options.paths.jobs, jobId + '.json'), json);
            } catch (err) {
                this.log.error('Could not write job to disc', err);
                throw new Errors.Base('Could not write job to disc', err);
            }
        }
    }, this);
});

/*
 * Get next job to execute from master server
 */
Server.prototype.nextJob = function() {
    this._nextJob().done();
};

Server.prototype._nextJob = cow(function*() {
    // clear timer
    this.jobTimerClear();

    // ask master server for next job
    var jobParams;
    try {
        this.log('Requesting next job from server');
        jobParams = yield this.sendMessage(this.master.paths.jobNext);
    } catch (err) {
        this.log.warn('Failed to get next job from server');
    }

    if (!jobParams) {
        this.log('No jobs available');

        // no job found - delay and then try again
        var cont = yield this.wait('job', this.options.jobInterval);
        if (cont) this.nextJob();
        return;
    }

    this.log('Job received', jobParams);

    // run the job
    var jobPromise = this.startJob(jobParams);

    // get another job
    this.nextJob(); // NB no yield - continues on

    // when job complete, get another job
    yield jobPromise;
    this.nextJob();
});

Server.prototype.connectTimerClear = function() {
    if (this.timers.connect) this.timers.connect.cancel();
};

Server.prototype.jobTimerClear = function() {
    if (this.timers.job) this.timers.job.cancel();
};

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

Server.prototype.wait = wait;

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
