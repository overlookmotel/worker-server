/* --------------------
 * worker-server module
 * Timer constructor
 * ------------------*/

// Exports

/**
 * Timer constructor
 */
function Timer() {
	this._timer = null;
}

module.exports = Timer;

/**
 * Schedule a function to run in future.
 * If another function is already scheduled, it is cancelled first.
 *
 * @param {Function} fn - Function to be run
 * @param {*} [ctx=undefined] - `this` context to run `fn` in
 * @param {number} [ms=0] - Wait in milliseconds before running `fn`
 * @returns {undefined}
 */
Timer.prototype.schedule = function(fn, ctx, ms) {
	// Conform arguments
	if (typeof ctx == 'number' && ms === undefined) {
		ms = ctx;
		ctx = undefined;
	} else if (!ms) {
		ms = 0;
	}

	// Clear current timer
	this.clear();

	// Set new timer
	var self = this;
	this._timer = setTimeout(function() {
		self._timer = null;
		fn.call(ctx);
	}, ms);
};

/**
 * Cancel any timer currently scheduled.
 * @returns {undefined}
 */
Timer.prototype.clear = function() {
	if (this._timer) {
		clearTimeout(this._timer);
		this._timer = null;
	}
};
