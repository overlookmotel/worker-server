// --------------------
// worker-server module
// wait method
// --------------------

// modules
var Promise = require('bluebird'),
    cow = require('co-bluebird').wrap;

// exports
/*
 * Creates a promise which resolves in interval milliseconds
 * Promise is stored in `this.timers` and can be cancelled by another process using `this.timers.x.cancel()`
 * Promise resolves true if completed the wait, false if was cancelled.
 * Promise is deleted from `this.timers` on completion.
 */
module.exports = cow(function*(name, interval) {
    // create promise that waits for interval ms
    var completed = true;
    var promise = Promise.delay(interval).cancellable().catch(function() {completed = false;});

    // save promise to `this.timers` object
    this.timers[name] = promise;

    // await promise resolution (i.e. timeout or cancellation)
    yield promise;

    // delete promise from `this.timers` object
    delete this.timers[name];

    // return true if timed out, false if cancelled
    return completed;
});
