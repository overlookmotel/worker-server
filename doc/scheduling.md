# Scheduling

This document explains the concurrency model for message sending to master server.

## Server

### Start up

* Connect to master server

### Connect to master

When connecting to server:

* If currently connecting to master, do nothing
* If currently stopping server, do nothing
* If currently sending messages to master, wait until all finished, then connect
* If connecting succeeds, send all messages in cache
* If connecting fails, schedule another attempt to connect after interval

### Stop server

When stopping server:

* Prevent any further messages or connection attempts in future
* If currently connecting to master or sending messages, wait until finished
* Stop server

### Send job message to master

* If server stopping, write message to file cache instead
* If currently connecting to master, wait until finished, before continuing with steps below
* If connected to master, send this message (concurrently with any other messages being sent)
* If disconnected from master, write message to file cache instead
* If sending message fails:
  * Write message to file cache
  * Follow process for disconnection (below)

### Disconnected

* Prevent any messages being sent
* Reconnect

## Pinging

The worker pings master server for new jobs periodically.

* When server connects or reconnects, ping for job
* If job received:
  * ping for another job immediately
  * wait for job to complete and then ping for another job
* If no job received, schedule another ping after interval

## Job

Messages about completion/progress of a job are sent one by one, in order they are queued.

### Job completion (done/failed)

* Prevent further progress messages being queued
* If progress messages queued for sending, cancel them
* If progress message currently being sent, wait until finished, before continuing with steps below
* Send message about job completion

### Job progress

* If job complete, do nothing
* If progress currently sending or queued for sending, do nothing
* Send message about job progress
* Schedule sending progress again after interval
