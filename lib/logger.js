/* --------------------
 * worker-server module
 * Logger
 * ------------------*/

// Modules
const pathModule = require('path'),
	bunyanesque = require('bunyanesque'),
	_ = require('lodash');

// Imports
const Errors = require('./errors');

// Exports

/**
 * Creates logger
 *
 * With default streams:
 * 1. stdout for INFO and above
 * 2. `main.log` for all output
 * 3. `error.log` for WARN and above
 *
 * @param {string} name - Application name
 * @param {string} logName - Name used in log file filenames
 * @param {path} path - Absolute path to folder for log files
 * @param {Object} [streams] - Logging streams
 * @returns {Function} - Logging function
 */
module.exports = function(name, logName, path, streams) {
	// Conform options
	// Assumes name and path provided
	streams = _.mapValues(streams || {}, stream => {
		if (stream === false || stream === null) return false;
		if (!stream) return {};
		if (typeof stream == 'string') return {type: stream};
		return _.clone(stream);
	});

	// Create default main and error logs
	_.forIn({
		main: {level: 'trace'},
		error: {level: 'warn'}
	}, (defaults, streamName) => {
		let stream = streams[streamName];
		if (stream === false) return;
		if (!stream) stream = streams[streamName] = {};

		_.defaults(stream, defaults);
	});

	// Init streams array
	const streamsArr = [
		{ // Log INFO and above to stdout
			level: 'info',
			stream: process.stdout
		}
	];

	_.forIn(streams, (stream, streamName) => {
		if (stream === false) return;

		if (!stream.filename) stream.filename = `${logName}-${streamName}.log`;

		_.defaults(stream, {
			level: 'info',
			path: pathModule.join(path, stream.filename),
			type: 'file'
		});

		if (stream.type == 'rotating-file') {
			_.defaults(stream, {period: '1d', count: 7}); // Default rotating daily, keeping 1 week logs
		} else if (stream.type != 'file') {
			throw new Errors.Base(`Log file type '${stream.type}' is illegal`);
		}

		streamsArr.push(stream);
	});

	// Init bunyan
	const logger = bunyanesque.createLogger({
		name,
		streams: streamsArr,
		serializers: bunyanesque.stdSerializers
	});

	// Attach streams object to logger
	logger.options = streams;

	// Return logger
	return logger;
};
