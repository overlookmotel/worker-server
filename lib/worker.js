// --------------------
// worker-server module
// Worker constructor
// --------------------

// modules
var promisify = require('promisify-any'),
	Promise = require('bluebird'),
	_ = require('lodash');

// imports
var Errors = require('./errors');

// exports
var Worker = module.exports = function(name, params, server) {
	// record worker name
	this.name = name;

	// record reference to server
	this.server = server;

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

Worker.prototype.cancel = function(job) {
	job.log.warn('Worker has no cancel method');
	return Promise.resolve();
};
