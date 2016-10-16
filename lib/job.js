/* --------------------
 * worker-server module
 * Job constructor
 * ------------------*/

// Modules
var co = require('co-bluebird'),
	cow = co.wrap,
	Locker = require('lock-queue'),
	_ = require('lodash');

// Imports
var Errors = require('./errors'),
	Timer = require('./timer');

// Exports

/**
 * Job constructor.
 * @param {Object} params - Job parameters
 * @param {Server} server - Server job is running on.
 */
function Job(params, server) {
	// Record details to job object
	this.id = params.jobId;
	delete params.jobId;

	this.params = params;

	this.server = server;

	this.workerName = params.worker;
	this.worker = server.workers[params.worker];

	// Create logger
	this.log = server.log.child({jobId: this.id, worker: this.workerName});

	// Create locker and timer for messaging
	this.locker = new Locker();
	this.timer = new Timer();

	// Create empty progress object
	this.progress = {};

	// Flag as not complete
	this.complete = false;
}

module.exports = Job;

/**
 * Start job
 * Returns promise that resolves when job completes (either success or fail).
 * Promise will never reject.
 * @returns {Promise}
 */
Job.prototype.start = cow(function*() {
	// Run job
	this.log('Starting job', this);

	var result;
	try {
		this.promise = this.run().cancellable();
		result = yield this.promise;
	} catch (err) {
		// Job failed - record error
		this.log.warn('Job failed', err);
		yield this.failed(err);
		return;
	}

	// Job complete - record result
	yield this.done(result);
});

/**
 * Run job.
 * Called by `.start()`.
 * @returns {Promise} - Resolves or rejects depending on success/fail of job
 */
Job.prototype.run = cow(function*() {
	// Get worker
	var worker = this.worker;
	if (!worker) throw new Errors.Worker("No worker with name '" + this.workerName + "'");

	// Record initial progress message and start progress timer running
	this.sendProgress();

	// Run worker
	return yield worker.run(this);
});

/**
 * Job is done.
 * @param {Object} result - Result of job
 * @returns {Promise} - Resolves when job status recorded, rejects if failed to record
 */
Job.prototype.done = cow(function*(result) {
	this.progress.done = this.progress.total;
	this.progress.percent = 100;

	yield this.finished('Done', result);
});

/**
 * Job is failed.
 * @param {Error} err - Error from job
 * @returns {Promise} - Resolves when job status recorded, rejects if failed to record
 */
Job.prototype.failed = cow(function*(err) {
	yield this.finished('Failed', {error: _.extend({message: err.message, name: err.name, stack: err.stack}, err)});
});

/**
 * Job is finished.
 * Called by `.done()` and `.failed()`.
 * @param {string} status - Status code i.e. 'Done', 'Failed'
 * @param {Error} data - Message payload
 * @returns {Promise} - Resolves when job status recorded, rejects if failed to record
 */
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

/**
 * Called when job progressed.
 * If first time `total` provided, progress message sent immediately.
 * Otherwise, progress recorded in memory for perioidic update sending.
 * @param {number} [done] - Amount of work done
 * @param {number} [total] - Total amount of work to do
 * @returns {undefined}
 */
Job.prototype.progressed = function(done, total) {
	var first = !this.progress.total && total;

	if (total !== undefined) this.progress.total = total;
	if (done !== undefined) this.progress.done = done;

	if (first) this.sendProgress();
};

/**
 * Send current progress to master server.
 * If recording progress message fails, will throw and crash process.
 * @returns {undefined}
 */
Job.prototype.sendProgress = function() {
	this._sendProgress().done();
};

/**
 * Send current progress to master server.
 * If recording progress message fails, will throw and crash process.
 * Schedules self to run again after interval.
 * @returns {Promise} - Resolves when progress recorded, rejects if failed to record
 */
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

/**
 * Record job status.
 * @param {string} status - Status code i.e. 'Done', 'Failed', 'Processing'
 * @param {Error} data - Message payload
 * @returns {Promise} - Resolves when job status recorded, rejects if failed to record
 */
Job.prototype.recordStatus = cow(function*(status, data) {
	this.log(status, data);

	yield this.server.recordJobStatus(this.id, status, data);
});

/**
 * Cancel job.
 * Called when server is stopped.
 * Cancellation is effected by calling `.cancel()` on the job's promise.
 * @returns {Promise} - Resolved when cancelled
 */
Job.prototype.cancel = cow(function*() {
	this.log('Cancelling job');

	// cancel the job
	yield this.worker.cancel(this);
	if (this.promise) this.promise.cancel(new Errors.Job.Cancelled());

	this.log('Cancelled job');
});
