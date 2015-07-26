import eio from 'engine.io'
import { STATUS_CODES } from 'http'
import { EventEmitter } from 'events'
import cuid from 'cuid'
import { fromJS, Map, Set } from 'immutable'
import ruta from 'ruta3'
import compose from './composer'
import {
  encode,
  decode,
  protocolVersion,
  WELCOME,
  INVOKE,
  RESULT,
  ERROR,
  PUBLISH,
  PARSER_ERROR,
} from './protocol'

export { protocolVersion }

export class NydusClient extends EventEmitter {
  constructor(id, conn, onInvoke, idGen = cuid) {
    super()
    this.id = id
    this.conn = conn
    this._onInvoke = onInvoke
    this._idGen = idGen
    this._subscriptions = Set()
    this._outstanding = Map()

    conn.on('error', err => this.emit('error', err))
      .on('close', ::this._onClose)
      .on('message', ::this._onMessage)
  }

  get readyState() {
    return this.conn.readyState
  }

  valueOf() {
    // This will make things slightly easier for ImmutableJS (otherwise it'd use a WeakMap)
    return this.id
  }

  // Closes the underlying connection
  close() {
    this.conn.close()
  }

  // Invoke a remote method on a client. Path should be a proper URI-encoded path, data is optional
  // and will be JSON encoded to send to the client. Returns a promise that will be resolved or
  // rejected with the client's response
  invoke(path, data) {
    const id = this._idGen()
    const result = new Promise((resolve, reject) => {
      this._outstanding = this._outstanding.set(id, { resolve, reject })
      this.conn.send(encode(INVOKE, data, id, path))
    })

    result.then(() => {
      this._outstanding = this._outstanding.delete(id)
    }, () => {
      this._outstanding = this._outstanding.delete(id)
    })

    return result
  }

  _send(encoded) {
    this.conn.send(encoded)
  }

  _onMessage(msg) {
    const decoded = decode(msg)
    switch (decoded.type) {
      case PARSER_ERROR:
        this.conn.close() // will cause a call to onClose
        break
      case INVOKE:
        this._onInvoke(this, decoded)
        break
      case RESULT:
        this._onResult(decoded)
        break
      case ERROR:
        this._onErrorResult(decoded)
        break
    }
  }

  _onClose(reason, description) {
    for (const p of this._outstanding.values()) {
      p.reject(new Error('Connection closed before response'))
    }
    this._outstanding = this._outstanding.clear()
    this.emit('close', reason, description)
  }

  _getOutstandingOrClose(id) {
    const promise = this._outstanding.get(id)
    if (!promise) {
      this.conn.close()
    }
    return promise
  }

  _onResult({ id, data }) {
    const promise = this._getOutstandingOrClose(id)
    if (promise) {
      promise.resolve(data)
    }
  }

  _onErrorResult({ id, data }) {
    const promise = this._getOutstandingOrClose(id)
    if (promise) {
      promise.reject(data)
    }
  }
}

const NOT_FOUND = { status: 404, message: 'Not Found' }

export class NydusServer extends EventEmitter {
  constructor(options) {
    super()
    this.eioServer = eio(options)
    this._idGen = cuid
    this.clients = Map()
    this._subscriptions = Map()
    this._router = ruta()
    this._onInvokeFunc = ::this._onInvoke

    this.eioServer.on('error', err => this.emit('error', err))
      .on('connection', ::this._onConnection)
  }

  // Attach this NydusServer to a particular HTTP(S) server, making it listen to UPGRADE requests.
  attach(httpServer, options) {
    this.eioServer.attach(httpServer, options)
  }

  // Close any open connections and then stop this Nydus server.
  close() {
    for (const client of this.clients.values()) {
      client.close()
    }
    this.clients = this.clients.clear()
    this.eioServer.close()
  }

  // Set the function used to generate IDs for messages. Should return a string of 32 characters or
  // less, matching /[A-z0-9-]+/.
  //
  // This is mainly useful for testing, generally this shouldn't need to be used.
  setIdGen(idGenFunc) {
    this._idGen = idGenFunc
  }

  // Registers one or more handlers to respond to INVOKEs on paths matching a pattern. Handlers are
  // ES7 async functions (and thus return promises when called) of the form:
  // async function(data, next)
  //
  // Handlers will be composed in order, and are expected to call next(data, next) to make execution
  // continue further down the chain. Data is an immutable map that can be changed before passing it
  // to the next function, but should present the same API (or ideally, be an ImmutableJS map) for
  // compatibility with other handlers.
  //
  // The final resolved value will be sent to the client (as a RESULT if the promise was
  // successfully resolved, an ERROR if it was rejected).
  registerRoute(pathPattern, ...handlers) {
    if (!handlers.length) {
      throw new Error('At least one handler function is required')
    }

    this._router.addRoute(pathPattern, compose(handlers))
  }

  // Add a subscription to a publish path for a client. Whenever messages are published to that
  // path, this client will receive a message (until unsubscribed). If initialData is specified and
  // the client was not previously subscribed, this data will be published to the client
  // immediately (but not to the other subscribed clients).
  subscribeClient(client, path, initialData = null) {
    const newSubs = this._subscriptions.update(path, Set(), s => s.add(client))
    if (newSubs === this._subscriptions) {
      return // client was previously subscribed
    }
    this._subscriptions = newSubs
    client._subscriptions = client._subscriptions.add(path)
    if (initialData != null) {
      client._send(encode(PUBLISH, initialData, null, path))
    }
  }

  // Remove a client's subsription to a path (if it was subscribed).
  unsubscribeClient(client, path) {
    const newSubs = this._subscriptions.update(path, s => s && s.delete(client))
    if (newSubs === this._subscriptions) {
      return false // client wasn't subscribed before
    }
    this._subscriptions = newSubs
    client._subscriptions = client._subscriptions.delete(path)
    return true
  }

  unsubscribeAll(path) {
    const subs = this._subscriptions.get(path)
    if (!subs) {
      return false
    }

    for (const c of subs.values()) {
      c._subscriptions = c._subscriptions.delete(path)
    }
    this._subscriptions = this._subscriptions.delete(path)
    return true
  }

  publish(path, data) {
    const subs = this._subscriptions.get(path)
    if (!subs) return

    const packet = encode(PUBLISH, data, null, path)
    for (const c of subs.values()) {
      c._send(packet)
    }
  }

  _onConnection(socket) {
    const client = new NydusClient(cuid(), socket, this._onInvokeFunc, this._idGen)
    this.clients = this.clients.set(client.id, client)
    socket.send(encode(WELCOME, protocolVersion))
    this.emit('connection', client)
  }

  _onInvoke(client, msg) {
    const route = this._router.match(msg.path)
    if (!route) {
      client._send(encode(ERROR, NOT_FOUND, msg.id))
      return
    }

    const initData = Map({
      server: this,
      client,
      path: route.route,
      params: fromJS(route.params),
      splats: fromJS(route.splats),
    })

    route.action(initData).then(result => {
      client._send(encode(RESULT, result, msg.id))
    }, err => {
      const status = err.status || 500
      const message = err.message || STATUS_CODES[status]
      const body = err.body
      client._send(encode(ERROR, { status, message, body }, msg.id))
    })
  }
}

NydusServer.protocolVersion = protocolVersion

export default function createNydusServer(httpServer, ...args) {
  const nydus = new NydusServer(...args)
  nydus.attach(httpServer, ...args)
  return nydus
}
