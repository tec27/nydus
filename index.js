var ws = require('ws')
  , protocol = require('nydus-protocol')
  , EventEmitter = require('events').EventEmitter
  , util = require('util')
  , uuid = require('node-uuid')
  , Socket = require('./socket')
  , createRouter = require('./router')

module.exports = function(httpServer, options) {
  return new NydusServer(httpServer, options)
}

NydusServer.defaults =  { serverAgent: 'NydusServer/0.0.1'
                        }

function NydusServer(httpServer, options) {
  EventEmitter.call(this)
  this._ws = new ws.Server({ server: httpServer })
  this.router = createRouter()

  this._sockets = Object.create(null)
  this._options = options || {}
  for (var key in NydusServer.defaults) {
    if (typeof this._options[key] == 'undefined') {
      this._options[key] = NydusServer.defaults[key]
    }
  }

  ; [ '_onError'
    , '_onConnection'
    ].forEach(function(fn) {
      this[fn] = this[fn].bind(this)
    }, this)

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

  var self = this
  socket.on('disconnect', function() {
    delete self._sockets[id]
    self.emit('disconnect', socket)
  }).on('error', function() {}) // swallow socket errors if no one else handles them

  socket.on('message:call', function(message) {
    self._onCall(socket, message)
  })

  socket._send(this._welcomeMessage)
  this.emit('connection', socket)
}

NydusServer.prototype._onError = function(err) {
  this.emit('error', err)
}

NydusServer.prototype._onCall = function(socket, message) {
  var route = this.router.matchCall(message.procPath)
  if (!route) {
    return socket.sendError(message.callId, 404, 'not found',
        { message: message.procPath + ' could not be found' })
  }

  var req = createReq(socket, message.callId, route)
    , res = createRes(this, socket, message.callId)
    , args = [ req, res ].concat(message.params)

  route.fn.apply(this, args)
}

function createReq(socket, callId, route) {
  return  { socket: socket
          , callId: callId
          , route: route.route
          , params: route.params
          , splats: route.splats
          }
}

function createRes(server, socket, callId) {
  var sent = false

  function succeed(results) {
    if (sent) {
      server.emit('error', new Error('Only one response can be sent for a CALL.'))
      return
    }
    var args = Array.prototype.slice.apply(arguments)
    socket.sendResult(callId, args)
    sent = true
  }

  function fail(errorCode, errorDesc, errorDetails) {
    if (sent) {
      server.emit('error', new Error('Only one response can be sent for a CALL.'))
      return
    }
    socket.sendError(callId, errorCode, errorDesc, errorDetails)
    sent = true
  }

  return { succeed: succeed, fail: fail }
}
