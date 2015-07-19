// --------------------
// worker-server module
// Job constructor
// --------------------

// modules
var co = require('co-bluebird'),
    cow = co.wrap,
    _ = require('lodash');

// imports
var Errors = require('./errors'),
    Queue = require('./queue');

// exports
var Job = module.exports = function(params, server) {
    // record details to job object
    this.id = params.jobId;
    this.server = server;

    this.params = params;
    delete params.jobId;

    this.workerName = params.worker;
    this.worker = server.workers[params.worker];
};

Job.prototype.start = cow(function*() {
    // run job
    this.log('Starting job', this);

    var result;
    try {
        result = yield this.run();
    } catch (err) {
        // job failed - record error
        yield this.failed(err);
        return;
    }

    // job complete - record result
    yield this.done(result);
});

Job.prototype.run = cow(function*() {
    // get worker
    var worker = this.worker;
    if (!worker) throw new Errors.Worker("No worker with name '" + this.workerName + "'");

    // record initial progress message and start progress timer running
    this.progress = {};
    this.queue = new Queue();
    yield this.timerDone();

    // run worker
    return yield worker.run(this);
});

Job.prototype.done = cow(function*(result) {
    return yield this.finished('Done', result);
});

Job.prototype.failed = cow(function*(err) {
    return yield this.finished('Failed', {error: {message: err.message, name: err.name, stack: err.stack}});
});

Job.prototype.finished = cow(function*(status, data) {
    this.timerClear();
    return yield this.recordStatus(status, data);
});

Job.prototype.progressed = function(done, total) {
    if (total !== undefined) this.progress.total = total;
    if (done !== undefined) this.progress.done = done;
};

Job.prototype.timerStart = function() {
    this.timer = setTimeout(function() {
        return this.timerDone();
    }.bind(this), this.server.options.messageInterval);
};

Job.prototype.timerDone = cow(function*() {
    // delete timer object
    delete this.timer;

    // prepare progress object
    var progress = {};
    if (this.progress.total) {
        progress = {
            total: this.progress.total,
            done: this.progress.done,
            percent: Math.floor(this.progress.done / this.progress.total * 100)
        };
    }

    // record message
    yield this.recordStatus('Processing', {progress: progress});

    // start timer again
    this.timerStart();
});

Job.prototype.timerClear = function() {
    if (this.timer) {
        clearTimeout(this.timer);
        delete this.timer;
    }
};

Job.prototype.recordStatus = cow(function*(status, data) {
    this.log(status, data);

    return yield this.queue.add(function*() {
        return yield this.server.recordJobStatus(this.id, status, data);
    }, this);
});

Job.prototype.log = function(status, data) {
    data = _.extend({
        jobId: this.id,
        worker: this.workerName
    }, data || {});

    this.server.log(status, data);
};
