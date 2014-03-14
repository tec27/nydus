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
  this._subscriptions = Object.create(null)
  this._socketSubs = Object.create(null)
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

NydusServer.prototype.publish = function(topicPath, event) {
  var socketIds = Object.keys(this._subscriptions[topicPath] || {})
  if (!socketIds.length) {
    return
  }
  var sockets = socketIds.map(function(id) {
    return this._sockets[id]
  }, this)
  Socket.sendEventToAll(sockets, topicPath, event)
}

NydusServer.prototype._onConnection = function(websocket) {
  var id = uuid.v4()
  var socket = new Socket(websocket, id)
  this._sockets[id] = socket
  this._socketSubs[id] = Object.create(null)

  var self = this
  socket.on('disconnect', function() {
    delete self._sockets[id]
    for (var topic in self._socketSubs[id]) {
      delete self._subscriptions[topic][id]
    }
    delete self._socketSubs[id]
    self.emit('disconnect', socket)
  }).on('error', function() {}) // swallow socket errors if no one else handles them

  socket.on('message:call', function(message) {
    self._onCall(socket, message)
  }).on('message:subscribe', function(message) {
    self._onSubscribe(socket, message)
  }).on('message:unsubscribe', function(message) {
    self._onUnsubscribe(socket, message)
  }).on('message:publish', function(message) {
    self._onPublish(socket, message)
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
    , res = createRes(responseCallback, this, socket, message.callId)
    , args = [ req, res ].concat(message.params)

  route.fn.apply(this, args)

  function responseCallback() {}
}

NydusServer.prototype._onSubscribe = function(socket, message) {
  var self = this
    , route = this.router.matchSubscribe(message.topicPath)
  if (!route) {
    return socket.sendError(message.requestId, 404, 'not found',
        { message: message.procPath + ' could not be found' })
  }

  var req = createReq(socket, message.requestId, route)
    , res = createRes(responseCallback, this, socket, message.requestId)
    , args = [ req, res ].concat(message.params)

  route.fn.apply(this, args)

  function responseCallback(erred) {
    if (erred) {
      return
    }

    var sub = self._subscriptions[message.topicPath]
      , socketSub = self._socketSubs[socket.id]
    if (!sub) {
      sub = self._subscriptions[message.topicPath] = Object.create(null)
    }

    sub[socket.id] = (sub[socket.id] || 0) + 1
    socketSub[message.topicPath] = (socketSub[message.topicPath] || 0) + 1
  }
}

NydusServer.prototype._onUnsubscribe = function(socket, message) {
  var self = this
    , sub = self._subscriptions[message.topicPath]
    , socketSub = self._socketSubs[socket.id]
  if (!sub || !sub[socket.id]) {
    socket.sendError(message.requestId, 400, 'bad request', 'no subscriptions exist for this topic')
    return
  }

  sub[socket.id]--
  socketSub[message.topicPath]--
  if (!sub[socket.id]) {
    delete sub[socket.id]
    delete socketSub[message.topicPath]
  }

  socket.sendResult(message.requestId)
}

NydusServer.prototype._onPublish = function(socket, message) {
  var self = this
    , route = this.router.matchPublish(message.topicPath)
  if (!route) {
    return socket.sendError(message.requestId, 404, 'not found',
        { message: message.procPath + ' could not be found' })
  }

  

  var req = createReq(socket, message.requestId, route)
    , args = [ req, message.event, complete ]

  route.fn.apply(this, args)

  function complete(event) {
    var socketIds = Object.keys(self._subscriptions[message.topicPath] || {})
    if (!socketIds.length) {
      return
    }
    var sockets = socketIds.map(function(id) {
      return self._sockets[id]
    })

    if (message.excludeMe) {
      var index = sockets.indexOf(socket);
      if (index != -1) {
        sockets.splice(index, 1)
      }
    }

    Socket.sendEventToAll(sockets, message.topicPath, event)
  }
}

function createReq(socket, requestId, route) {
  return  { socket: socket
          , requestId: requestId
          , route: route.route
          , params: route.params
          , splats: route.splats
          }
}

function createRes(cb, server, socket, requestId) {
  var sent = false

  function complete(results) {
    if (sent) {
      server.emit('error', new Error('Only one response can be sent for a CALL.'))
      return
    }
    cb(false)
    var args = Array.prototype.slice.apply(arguments)
    socket.sendResult(requestId, args)
    sent = true
  }

  function fail(errorCode, errorDesc, errorDetails) {
    if (sent) {
      server.emit('error', new Error('Only one response can be sent for a CALL.'))
      return
    }
    cb(true)
    socket.sendError(requestId, errorCode, errorDesc, errorDetails)
    sent = true
  }

  return { complete: complete, fail: fail }
}
