// --------------------
// worker-server module
// Worker constructor
// --------------------

// modules
var promisify = require('promisify-any'),
    _ = require('lodash');

// imports
var Errors = require('./errors');

// exports
module.exports = function(name, params) {
    // record worker name
    this.name = name;

    // save parameters to worker
    _.extend(this, params);

    // check worker has run method
    if (!this.run) throw new Errors.Worker("Worker '" + name + "' has no run method");

    // promisify run method and all generators
    this.run = promisify(this.run, 1);
    promisify.generators(this);

    // return worker object
    return this;
};
