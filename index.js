var ws = require('ws')
  , protocol = require('nydus-protocol')
  , EventEmitter = require('events').EventEmitter
  , util = require('util')
  , uuid = require('node-uuid')
  , Socket = require('./socket')

module.exports = function(httpServer, options) {
  return new NydusServer(httpServer, options)
}

NydusServer.defaults =  { serverAgent: 'NydusServer/0.0.1'
                        }

function NydusServer(httpServer, options) {
  EventEmitter.call(this)
  this._ws = new ws.Server({ server: httpServer })
  this._sockets = Object.create(null)
  this._options = options || {}
  for (var key in NydusServer.defaults) {
    if (typeof this._options[key] == 'undefined') {
      this._options[key] = NydusServer.defaults[key]
    }
  }

  this._onError = this._onError.bind(this)
  this._onConnection = this._onConnection.bind(this)

  this._ws.on('error', this._onError)
    .on('connection', this._onConnection)

  // construct a welcome message to save time, since it will never change
  this._welcomeMessage = protocol.encode( { type: protocol.WELCOME
                                          , serverAgent: this._options.serverAgent
                                          })
}
util.inherits(NydusServer, EventEmitter)

NydusServer.prototype._onConnection = function(websocket) {
  var id
  do {
    id = uuid.v4()
  } while (this._sockets[id]) // avoid collisions (however unlikely)
  var socket = new Socket(websocket, id)
  this._sockets[id] = socket

  socket.on('disconnect', function() {
    delete this._sockets[id]
    this.emit('disconnect', socket)
  }.bind(this)).on('error', function() {}) // swallow socket errors if no one else handles them

  socket._send(this._welcomeMessage)
  this.emit('connection', socket)
}

NydusServer.prototype._onError = function(err) {
  this.emit('error', err)
}
