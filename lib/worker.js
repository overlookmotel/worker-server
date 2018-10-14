/* --------------------
 * worker-server module
 * Worker constructor
 * ------------------*/

// Modules
const promisify = require('promisify-any'),
	Promise = require('bluebird');

// Imports
const Errors = require('./errors');

// Exports

/**
 * Worker constructor.
 * @param {string} name - Worker name
 * @param {Object} params - Worker parameters
 * @param {Server} server - Server worker is running on.
 */
function Worker(name, params, server) {
	// Record worker name
	this.name = name;

	// Record reference to server
	this.server = server;

	// Save parameters to worker
	Object.assign(this, params);

	// Check worker has run method
	if (!this.run) throw new Errors.Worker(`Worker '${name}' has no run method`);

	// Promisify run method and all generators
	this.run = promisify(this.run, 1);
	promisify.generators(this);

	// Return worker object
	return this;
}

module.exports = Worker;

/**
 * Default `.cancel()` method.
 * `worker.cancel()` is called when server is stopping.
 * Does nothing. Intended to be overriden in worker definition.
 * @returns {Promise} - Always resolves.
 */
Worker.prototype.cancel = function(job) {
	job.log.warn('Worker has no cancel method');
	return Promise.resolve();
};
