// --------------------
// worker-server module
// Error constructors
// --------------------

// modules
var util = require('util');

// exports
var Errors = module.exports = {};

// base error - all other errors subclassed from this
var BaseError = Errors.Base = function(message, err) {
	var tmp = Error.call(this, message);
	tmp.name = this.name = 'WorkerServerError';
	this.message = tmp.message;
	if (err) this.parent = err;

	Error.captureStackTrace(this, this.constructor);
};
util.inherits(BaseError, Error);

// master server connection error
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

// worker error
Errors.Worker = function(message) {
	BaseError.call(this, message);
	this.name = 'WorkerServerWorkerError';
};
util.inherits(Errors.Worker, BaseError);

// job error
Errors.Job = function(message) {
	BaseError.call(this, message);
	this.name = 'WorkerServerJobError';
};
util.inherits(Errors.Job, BaseError);

// job cancelled error
Errors.Job.Cancelled = function() {
	Errors.Job.call(this, 'Job cancelled');
	this.name = 'WorkerServerJobCancelledError';
};
util.inherits(Errors.Job.Cancelled, Errors.Job);
