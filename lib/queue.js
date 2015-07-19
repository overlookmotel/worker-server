// --------------------
// worker-server module
// Queue constructor
// --------------------

// modules
var Promise = require('bluebird'),
    promisify = require('promisify-any');

// exports

/*
 * Queue constructor
 *
 * Queue is a list of functions, which are executed serially, in the order they are added to the queue.
 * Add to the queue with `Queue#add(fn)`.
 */
var Queue = module.exports = function() {
    this.items = [];
    this.executing = false;
};

/*
 * Adds function `fn` to queue
 *
 * `fn` must be a promise-returning function.
 * `ctx` is the `this` context `fn` will be called with.
 * Returns a promise which is resolved/rejected when `fn` is executed
 */
Queue.prototype.add = function(fn, ctx) {
    // promisify fn
    fn = promisify(fn, 0);

    // create queue item
    var item = defer();
    item.fn = fn;
    item.ctx = ctx;

    // add to queue
    this.items.push(item);

    // execute queue
    this.execute();

    // return promise
    return item.promise;
};

/*
 * Executes next function in queue
 *
 * Called internally every time an item is added to the queue
 * but should be no need to call this externally.
 */
Queue.prototype.execute = function() {
    // if already running, return
    if (this.executing) return;

    // if no items left, return
    if (this.items.length == 0) return;

    // get next from queue
    var item = this.items.shift();

    // run item's fn
    this.executing = true;

    item.fn.call(item.ctx).bind(this).then(function(result) {
        item.resolve(result);
        done.call(this);
    }).catch(function(err) {
        item.reject(err);
        done.call(this);
    });

    function done() {
        this.executing = false;
        this.execute();
    }
};

function defer() {
    var resolve, reject;
    var promise = new Promise(function() {
        resolve = arguments[0];
        reject = arguments[1];
    });

    return {
        resolve: resolve,
        reject: reject,
        promise: promise
    };
}
