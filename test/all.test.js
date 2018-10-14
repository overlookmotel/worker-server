/* --------------------
 * worker-server module
 * Tests
 * ------------------*/

// Modules
const chai = require('chai'),
	expect = chai.expect,
	workerServer = require('../lib/');

// Init
chai.config.includeStack = true;

// Tests

/* jshint expr: true */
/* global describe, it */

describe('Tests', function() {
	it.skip('all', function() {
		expect(workerServer).to.be.ok;
	});
});
