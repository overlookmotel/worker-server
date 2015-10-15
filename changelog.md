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

## Next

* Fix: Don't wait for timer before starting job
