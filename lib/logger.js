// --------------------
// worker-server module
// Logger
// --------------------

// modules
var pathModule = require('path'),
    bunyanesque = require('bunyanesque'),
    _ = require('lodash');

// imports
var Errors = require('./errors');

// exports

/*
 * Creates logger
 *
 * With default streams:
 * 1. stdout for INFO and above
 * 2. `main.log` for all output
 * 3. `error.log` for WARN and above
 */
module.exports = function(name, path, streams) {
    // conform options
    // assumes name and path provided
    streams = _.mapValues(streams || {}, function(stream) {
        if (stream === false || stream === null) return false;
        if (!stream) return {};
        if (typeof stream == 'string') return {type: stream};
        return _.clone(stream);
    });

    // create default main and error logs
    _.forIn({
        main: {level: 'trace'},
        error: {level: 'warn'}
    }, function(defaults, streamName) {
        var stream = streams[streamName];
        if (stream === false) return;
        if (!stream) stream = streams[streamName] = {};

        _.defaults(stream, defaults);
    });

    // init streams array
    var streamsArr = [
        { // log INFO and above to stdout
            level: 'info',
            stream: process.stdout
        }
    ];

    _.forIn(streams, function(stream, streamName) {
        if (stream === false) return;

        _.defaults(stream, {
            level: 'info',
            path: pathModule.join(path, streamName + '.log'),
            type: 'file'
        });

        if (stream.type == 'rotating-file') {
            _.defaults(stream, {period: '1d', count: 7}); // default rotating daily, keeping 1 week logs
        } else if (stream.type != 'file') {
            throw new Errors.Base("Log file type '" + stream.type + "' is illegal");
        }

        streamsArr.push(stream);
    });

    // init bunyan
    var logger = bunyanesque.createLogger({
        name: name,
        streams: streamsArr
    });

    // attach streams object to logger
    logger.options = streams;

    // return logger
    return logger;
};
