// --------------------
// worker-server module
// Job constructor
// --------------------

// modules
var co = require('co-bluebird'),
    cow = co.wrap;

// imports
var Errors = require('./errors'),
    Queue = require('./queue'),
    wait = require('./wait');

// exports
var Job = module.exports = function(params, server) {
    // record details to job object
    this.id = params.jobId;
    this.server = server;

    this.params = params;
    delete params.jobId;

    this.workerName = params.worker;
    this.worker = server.workers[params.worker];

    // create logger
    this.log = server.log.child({jobId: this.id, worker: this.workerName});

    // create timers object
    this.timers = {};
};

Job.prototype.start = cow(function*() {
    // run job
    this.log('Starting job', this);

    var result;
    try {
        this.promise = this.run().cancellable();
        result = yield this.promise;
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
    this.progress.done = this.progress.total;
    this.progress.percent = 100;

    yield this.finished('Done', result);
});

Job.prototype.failed = cow(function*(err) {
    yield this.finished('Failed', {error: {message: err.message, name: err.name, stack: err.stack}});
});

Job.prototype.finished = cow(function*(status, data) {
    this.complete = true;
    this.timerClear();
    yield this.recordStatus(status, data);

    this.server.finishedJob(this);
});

Job.prototype.progressed = function(done, total) {
    if (total !== undefined) this.progress.total = total;
    if (done !== undefined) this.progress.done = done;
};

Job.prototype.timerDone = cow(function*() {
    // if finished, return
    if (this.complete) return;

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
    var cont = yield this.wait('progress', this.server.options.messageInterval);
    if (cont) this.timerDone();
});

Job.prototype.timerClear = function() {
    if (this.timers.progress) this.timers.progress.cancel();
};

Job.prototype.recordStatus = cow(function*(status, data) {
    this.log(status, data);

    return yield this.queue.add(function*() {
        return yield this.server.recordJobStatus(this.id, status, data);
    }, this);
});

Job.prototype.cancel = cow(function*() {
    this.log('Cancelling job');

    // cancel the job
    yield this.worker.cancel(this);
    if (this.promise) this.promise.cancel(new Errors.Job.Cancelled());

    this.log('Cancelled job');
});

Job.prototype.wait = wait;
