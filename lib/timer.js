/* --------------------
 * worker-server module
 * Timer constructor
 *
 * Timer runs functions which are provided with `timer.now()` in series.
 * Each only starts executing after the previous has finished.
 * Functions are executed in same order as they are provided with `timer.now()`.
 *
 * A function can be scheduled to execute in the future with `timer.future()`.
 * Only one function can be scheduled at a time - if a function is already scheduled,
 * further calls to `timer.schedule()` are ignored.
 *
 * `timer.now()` overrides scheduled functions - if `timer.now()` is called before a scheduled
 * function starts running, the scheduled function is cancelled.
 *
 * `timer.stop()` disables the timer. Any further calls to `timer.now()` or `timer.future()`
 * are ignored.
 * ------------------*/

// Modules
var moment = require('moment'),
	cow = require('co-bluebird').wrap;

// Imports
var defer = require('./defer');

// Exports

/**
 * Timer constructor
 */
function Timer() {
	this._active = true;
	this._nowPromise = null;
	this._timer = null;
	this._scheduledTime = null;
}

module.exports = Timer;

/**
 * Run function now.
 * And first cancel timer for any future run.
 * `fn` should return a promise.
 *
 * @param {Function} fn - Function to be run
 * @returns {Promise} - Promise result of running `fn`
 */
Timer.prototype.now = cow(function*(fn) {
	// If timer stopped, exit
	if (!this._active) return;

	// Cancel existing timer
	this.cancel();

	// Save promise that resolves when `fn` resolves/rejects
	var waitFor = this._nowPromise;
	var deferred = defer();
	this._nowPromise = deferred.promise;

	// If currently running, await run to end
	if (waitFor) yield waitFor;

	// Run function
	try {
		return yield fn();
	} finally {
		// Whether `fn()` resolves or rejects, resolve running promise
		deferred.resolve();
		if (this._nowPromise == deferred.promise) this._nowPromise = null;
	}
});

/**
 * Schedule function to run in future.
 * @param {Function} fn - Function to be run
 * @param {number} ms - Milliseconds to wait before running function
 * @returns {undefined}
 */
Timer.prototype.future = function(fn, ms) {
	// If timer stopped, or already running, exit
	if (!this._active || this._nowPromise) return;

	// If already scheduled to run before this time, exit
	var newScheduledTime = moment().add(ms, 'ms');
	if (this._scheduledTime && newScheduledTime.isAfter(this._scheduledTime)) return;

	// clear timer
	this.cancel();

	// Set timer to run function
	var self = this;
    this._scheduledTime = newScheduledTime;
    this._timer = setTimeout(cow(function*() {
		try {
			yield self.now(fn);
		} catch (err) {}

		this._scheduledTime = null;
	}), ms);
};

/**
 * Cancel any scheduled run.
 * NB If is currently running, does not stop that.
 * @returns {undefined}
 */
Timer.prototype.cancel = function() {
	if (!this._scheduledTime) return;

	this._scheduledTime = null;
	clearTimeout(this._timer);
};

/**
 * Stop timer.
 * No further runs will be accepted, but any current runs continue to completion.
 * @returns {undefined}
 */
Timer.prototype.stop = function() {
	this._active = false;
};
