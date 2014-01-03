var EventEmitter = require('events').EventEmitter
  , util = require('util')
  , protocol = require('nydus-protocol')

module.exports = Socket

function Socket(websocket, id) {
  EventEmitter.call(this)
  this.id = id
  this._websocket = websocket
  this.connected = true

  this._websocket.on('close', function(code, message) {
    var wasConnected = this.connected
    this.connected = false
    this.emit('close', code, message)
    if (wasConnected) {
      this.emit('disconnect')
    }
  }.bind(this)).on('ping', function(data, flags) {
    this.emit('ping', data, flags)
  }.bind(this)).on('pong', function(data, flags) {
    this.emit('pong', data, flags)
  }.bind(this))

  this._websocket.on('message', this._onMessage.bind(this))
    .on('error', this._onError.bind(this))
}
util.inherits(Socket, EventEmitter)

// Send data over the websocket (this is a "raw" function and doesn't do any sort of encoding)
Socket.prototype._send = function(data, cb) {
  this._websocket.send(data, function(err) {
    if (cb) {
      cb(err)
    } else {
      // Swallow the error so that we don't crash because a socket closed before the data got there.
      // If no callback was provided, its assumed that this was a 'fire and forget' type message and
      // therefore this error is rather irrelevant
    }
  })
}

Socket.prototype._onMessage = function(data, flags) {
  try {
    var message = protocol.decode(data)
  } catch (err) {
    this._websocket.close(1002, 'Invalid nydus message')
    this._onError(err)
    return
  }

  this.emit('message', message)
  switch (message.type) {
    case protocol.WELCOME:
      this.emit('message:welcome', message)
      break
    case protocol.CALL:
      this.emit('message:call', message)
      break
    case protocol.RESULT:
      this.emit('message:result', message)
      break
    case protocol.ERROR:
      this.emit('message:error', message)
      break
    case protocol.SUBSCRIBE:
      this.emit('message:subscribe', message)
      break
    case protocol.UNSUBSCRIBE:
      this.emit('message:unsubscribe', message)
      break
    case protocol.PUBLISH:
      this.emit('message:publish', message)
      break
    case protocol.EVENT:
      this.emit('message:event', message)
      break
  }
}

Socket.prototype._onError = function(err) {
  var wasConnected = this.connected
  this.connected = false
  this.emit('error', err)
  if (wasConnected) {
    this.emit('disconnect')
  }
}

Socket.prototype.sendResult = function(callId, results, cb) {
  if (typeof results == 'function') {
    cb = results
    results = undefined
  }
  var message = { type: protocol.RESULT
                , callId: callId
                , results: results
                }
  this._send(protocol.encode(message), cb)
}

Socket.prototype.sendError = function(callId, errorCode, errorDesc, errorDetails, cb) {
  if (typeof errorDetails == 'function') {
    cb = errorDetails
    errorDetails = undefined
  }
  var message = { type: protocol.ERROR
                , callId: callId
                , errorCode: errorCode
                , errorDesc: errorDesc
                , errorDetails: errorDetails
                }
  this._send(protocol.encode(message), cb)
}
