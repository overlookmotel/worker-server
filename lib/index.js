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
    request = require('request'),
    configLoad = require('config-load'),
    requireFolderTree = require('require-folder-tree'),
    _ = require('lodash');

// promisify
request.postAsync = Promise.promisify(request.post, request);

// imports
var Errors = require('./errors'),
    Worker = require('./worker'),
    Job = require('./job');

// exports
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

Server.prototype.init = function(options) {
    // conform options
    if (!options) {
        options = {};
    } else if (typeof options == 'string') {
        options = {paths: {root: options}};
    }

    options = _.extend({
        paths: {},
        port: 3000,
        jobInterval: 30000,
        messageInterval: 10000
    }, options);

    var paths = options.paths = _.extend({root: process.cwd()}, options.paths);

    // save options to server object
    this.options = options;

    // load config
    var configPath = paths.config || pathModule.join(paths.root, 'config');

    this.log('Initializing server');
    this.log('Loading config', {path: configPath});

    if (configPath && fs.existsSync(configPath)) {
        var config = configLoad(configPath, {selectors: {local: null}});
        _.merge(options, config);
        paths.config = configPath;
    }

    // define paths
    ['config', 'workers', 'jobs'].forEach(function(pathType) {
        if (!paths[pathType]) paths[pathType] = pathModule.join(paths.root, pathType);
    });

    this.log('Loaded config', options);

    // load attributes
    this.serverId = options.serverId;
    this.password = options.password;
    this.master = options.master;

    if (options.onStart) this.onStart = options.onStart;

    // load workers
    this.log('Loading workers', {path: paths.workers});

    this.workers = requireFolderTree(paths.workers, {flatten: true, flattenCamel: true});

    _.forIn(this.workers, function(worker, workerName) { // jshint ignore:line
        // check worker has run method
        if (!worker.run) throw new Errors.Worker("Worker '" + workerName + "' has no run method");

        // promisify run method and all generators
        worker.run = promisify(worker.run, 1);
        promisify.generators(worker);

        this.log('Loaded worker', {worker: workerName});
    }.bind(this));

    this.log('Loaded workers');

    // done
    this.log('Initialized server');
    return this;
};

Server.prototype.start = cow(function*() {
    // set handler for shutdown (SIGINT for ctrl-C in terminal)
    process.on('SIGINT', this.stopped.bind(this));

    // tell master that server is starting
    this.log('Starting server');
    yield this.sendServerStatus('Starting');
    this.log('Connected to master server');

    // check job folders for data not yet transmitted to server and transmit
    this.log('Sending job cache');

    var jobsPath = this.options.paths.jobs;
    var files = yield fs.readdirAsync(jobsPath);
    yield files.map(cos(function*(filename) { //xxx doesn't need to execute in series
        if (pathModule.extname(filename) != '.json') return;

        var jobId = filename.slice(0, -5) * 1,
            path = pathModule.join(jobsPath, filename);

        var job = yield fs.readFileAsync(path, {encoding: 'utf8'});
        job = JSON.parse(job);

        yield this.sendJobStatus(jobId, job.status, job.data);

        yield fs.unlinkAsync(path);
    }).bind(this));

    this.log('Sent job cache');

    // run onStart handler
    var startData = {workers: Object.keys(this.workers)};
    if (this.onStart) {
        this.log('Running onStart handler');
        yield this.onStart(startData);
        this.log('Run onStart handler');
    }

    // tell master that server is online
    this.log('Onlining server', startData);
    yield this.sendServerStatus('Online', startData);
    this.log('Onlined server');

    // get a job from server
    this.nextJob();

    // return server object
    return this;
});

// called on SIGINT (ctrl-C in terminal)
Server.prototype.stopped = cow(function*() {
    this.timerClear();

    var data = {reason: 'Process stopped externally'};
    this.log('Stopping server', data);
    yield this.sendServerStatus('Offline', data);
    this.log('Stopped server');

    process.exit();
});

Server.prototype.sendServerStatus = cow(function*(status, data) {
    var path = this.master.paths.serverStatus.replace(':serverId', this.serverId);
    return yield this.sendMessage(path, {status: status, data: JSON.stringify(data)});
});

Server.prototype.sendJobStatus = cow(function*(jobId, status, data) {
    var path = this.master.paths.jobStatus.replace(':jobId', jobId);
    return yield this.sendMessage(path, {status: status, data: JSON.stringify(data)});
});

Server.prototype.sendMessage = cow(function*(path, data) {
    // add serverId and password to data
    if (!data) data = {};
    data.serverId = this.serverId;
    data.serverPassword = this.password;

    // hit API
    var url = this.master.host + path,
        response;
    try {
        response = yield request.postAsync({
            url: url,
            form: data,
            followRedirect: false,
            headers: {Accept: 'application/json'}
        });
        response = response[0];
    } catch (err) {
        throw new Errors.Connection('Could not connect to master server', err);
    }

    // parse API JSON response
    var result;
    try {
        result = JSON.parse(response.body);
    } catch (err) {
        throw new Errors.Connection('Bad response from master server', err);
    }

    // check for login fail
    // xxx implement sessions
    if (result.redirect == '/login') throw new Errors.Api('Login fail');

    // check API action completed successfully
    // xxx do a whitelist test rather than blacklist here
    if (result.formErrors) throw new Errors.Api('API error', result.formErrors);

    // done
    return result.data;
});

Server.prototype.recordJobStatus = cow(function*(jobId, status, data) {
    // try to send message to server
    try {
        yield this.sendJobStatus(jobId, status, data);
    } catch (err) {
        // rethrow if unexpected error
        if (!(err instanceof Errors.Connection) && !(err instanceof Errors.Api)) throw err;

        // sending message failed - record to file instead
        var json = JSON.stringify({status: status, data: data});
        try {
            yield fs.writeFileAsync(pathModule.join(this.options.paths.jobs, jobId + '.json'), json);
        } catch (err) {
            throw new Errors.Base('Could not write job to disc', err);
        }
    }
});

Server.prototype.nextJob = cow(function*() {
    // clear timer
    this.timerClear();

    // ask master server for next job
    var jobParams;
    try {
        this.log('Requesting next job from server');
        jobParams = yield this.sendMessage(this.master.paths.jobNext);
    } catch (err) {
        this.log('Server connection error');
    }

    if (!jobParams) {
        this.log('No jobs available');

        // no job found - delay before trying again
        this.timer = setTimeout(function() {
            delete this.timer;
            return this.nextJob();
        }.bind(this), this.options.jobInterval);
        return;
    }

    this.log('Job received', jobParams);

    // run the job
    var jobPromise = this.startJob(jobParams);

    // get another job
    this.nextJob(); // NB no yield - continues on

    // when job complete, get another job
    yield jobPromise;
    yield this.nextJob();
});

Server.prototype.timerClear = function() {
    if (this.timer) {
        clearTimeout(this.timer);
        delete this.timer;
    }
};

Server.prototype.startJob = cow(function*(params) {
    // create job
    var job = new Job(params, this);

    // start job
    return yield job.start();
});

Server.prototype.log = function(status, data) {
    if (data) return console.log(status, data);
    console.log(status);
};
