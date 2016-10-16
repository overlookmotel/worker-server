# Changelog

## 0.1.0

* Initial release

## 0.1.1

* Config use `local` override settings

## 0.1.2

* Fix: Stop jobs sending Processing message after job finished

## 0.1.3

* Fix: Bug with flagging jobs as finished

## 0.1.4

* Throw Connection error if master server returns invalid JSON

## 0.2.0

* Refactor message sending
* Job cancellation
* Promise-based timers in `Job`
* Deferred promise implementation
* Locker implementation
* Handle failure sending 'stopped' status to master server
* Use `bunyan` for logging
* Job uses child logger
* Additional logging
* Workers instances of `Worker` class
* Update dependencies
* Update dev dependencies

## 0.2.1

* Complete `onConnected` handler before requesting job
* Send server version to master server
* Message IDs for logging

## 0.3.0

* Move `Locker` into `lock-queue` module
* Remove `Utils.Locker` export
* Update `co-series` dependency

## 0.4.0

* Options from `new Server()` priority over read from config files
* Trigger server stop on SIGTERM signal (`pm2 stop`)
* Log filenames based on app name
* Use bunyan serializers on logged objects
* Update `bunyanesque` dependency

## 0.4.1

* Fix: Don't wait for timer before starting job

## 0.4.2

* Export `promisify-any` module as `Utils.promisify`

## 0.4.3

* Split `Server#init()` into separate methods
* Save reference to `server` on workers

## 0.4.4

* Log job failures at 'warn' level

## 0.4.5

* Send first progress update immediately

## 0.4.6

* Return all attributes of error object when job fails

## 0.5.0

* Next job from master server in `job` attribute + rename call 'ping'
* `onPing` hook

## 0.6.0

* `ping` action calls server item path

## 0.6.1

* Fix: `onPing` only called if ping successful

## 0.7.0

* Fix: Prevent out of control pinging
* Remove default port number
* Fix: Incorrect statement in log message
* Drop support for Node before v4.x
* Update dependencies
* Update dev dependencies
* Replace `Makefile` with npm scripts
* Travis CI runs on all branches (to enable `greenkeeper.io`)
* Update license
* Whitespace
