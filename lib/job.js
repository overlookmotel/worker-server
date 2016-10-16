// --------------------
// worker-server module
// Job constructor
// --------------------

// modules
var co = require('co-bluebird'),
	cow = co.wrap,
	Locker = require('lock-queue'),
	_ = require('lodash');

// imports
var Errors = require('./errors'),
	Timer = require('./timer');

// exports
var Job = module.exports = function(params, server) {
	// record details to job object
	this.id = params.jobId;
	delete params.jobId;

	this.params = params;

	this.server = server;

	this.workerName = params.worker;
	this.worker = server.workers[params.worker];

	// create logger
	this.log = server.log.child({jobId: this.id, worker: this.workerName});

	// create locker and timer for messaging
	this.locker = new Locker();
	this.timer = new Timer();

	// create empty progress object
	this.progress = {};

	// flag as not complete
	this.complete = false;
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
		this.log.warn('Job failed', err);
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
	this.sendProgress();

	// run worker
	return yield worker.run(this);
});

Job.prototype.done = cow(function*(result) {
	this.progress.done = this.progress.total;
	this.progress.percent = 100;

	yield this.finished('Done', result);
});

Job.prototype.failed = cow(function*(err) {
	yield this.finished('Failed', {error: _.extend({message: err.message, name: err.name, stack: err.stack}, err)});
});

Job.prototype.finished = cow(function*(status, data) {
	// Flag job as complete
	this.complete = true;

	// Clear timer (so progress does not send in future)
	this.timer.clear();

	// After any current message finished, send this message
	yield this.locker.lock(function*() {
		// Record job status
		yield this.recordStatus(status, data);

		// Delete record of job from server
		this.server.finishedJob(this);
	}, this);
});

Job.prototype.progressed = function(done, total) {
	var first = !this.progress.total && total;

	if (total !== undefined) this.progress.total = total;
	if (done !== undefined) this.progress.done = done;

	if (first) this.sendProgress();
};

Job.prototype.sendProgress = function() {
	this._sendProgress().done();
};

Job.prototype._sendProgress = cow(function*() {
	// If job complete, exit
	if (this.complete) return;

	// If timer scheduled, cancel it
	this.timer.clear();

	// Send progress message
	yield this.locker.run(function*() {
		// Prepare progress object
		var progress = {};
		if (this.progress.total) {
			progress = {
				total: this.progress.total,
				done: this.progress.done,
				percent: Math.floor(this.progress.done / this.progress.total * 100)
			};
		}

		// Record status
		yield this.recordStatus('Processing', {progress: progress});
	}, this);

	// If job complete, exit
	if (this.complete) return;

	// Schedule to report progress again after delay
	this.timer.schedule(this.sendProgress, this, this.server.options.messageInterval);
});

Job.prototype.recordStatus = cow(function*(status, data) {
	this.log(status, data);

	yield this.server.recordJobStatus(this.id, status, data);
});

Job.prototype.cancel = cow(function*() {
	this.log('Cancelling job');

	// cancel the job
	yield this.worker.cancel(this);
	if (this.promise) this.promise.cancel(new Errors.Job.Cancelled());

	this.log('Cancelled job');
});
