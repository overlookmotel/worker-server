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

## Next

* Update `co-series` dependency
