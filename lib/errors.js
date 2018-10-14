/* --------------------
 * worker-server module
 * Error constructors
 * ------------------*/

// Modules
const util = require('util');

// Exports
const Errors = module.exports = {};

// Base error - all other errors subclassed from this
const BaseError = Errors.Base = function(message, err) {
	const tmp = Error.call(this, message);
	tmp.name = this.name = 'WorkerServerError';
	this.message = tmp.message;
	if (err) this.parent = err;

	Error.captureStackTrace(this, this.constructor);
};
util.inherits(BaseError, Error);

// Master server connection error
Errors.Connection = function(message, err) {
	BaseError.call(this, message, err);
	this.name = 'WorkerServerConnectionError';
};
util.inherits(Errors.Connection, BaseError);

// API error
Errors.Api = function(message, errors) {
	BaseError.call(this, message);
	this.name = 'WorkerServerApiError';
	this.errors = errors;
};
util.inherits(Errors.Api, BaseError);

// Worker error
Errors.Worker = function(message) {
	BaseError.call(this, message);
	this.name = 'WorkerServerWorkerError';
};
util.inherits(Errors.Worker, BaseError);

// Job error
Errors.Job = function(message) {
	BaseError.call(this, message);
	this.name = 'WorkerServerJobError';
};
util.inherits(Errors.Job, BaseError);

// Job cancelled error
Errors.Job.Cancelled = function() {
	Errors.Job.call(this, 'Job cancelled');
	this.name = 'WorkerServerJobCancelledError';
};
util.inherits(Errors.Job.Cancelled, Errors.Job);
