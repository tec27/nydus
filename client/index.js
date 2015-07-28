import eio from 'engine.io-client'
import { EventEmitter } from 'events'
import { Map } from 'immutable'
import cuid from 'cuid'
import ruta from 'ruta3'
import Backoff from 'backo'
import {
  encode,
  decode,
  WELCOME,
  INVOKE,
  RESULT,
  ERROR,
  PUBLISH,
  PARSER_ERROR,
  protocolVersion,
} from 'nydus-protocol'

export { protocolVersion }

export class NydusClient extends EventEmitter {
  constructor(host, opts = {}) {
    super()
    this.host = host
    this.opts = opts
    this.conn = null
    this._outstanding = Map()
    this._router = ruta()

    this.opts.reconnectionAttempts = this.opts.reconnectionAttempts || Infinity
    this._backoff = new Backoff({
      min: opts.reconnectionDelay || 1000,
      max: opts.reconnectionDelayMax || 10000,
      jitter: opts.reconnectionJitter || 0.5,
    })
    this._backoffTimer = null
    this._connectTimer = null

    this._wasOpened = false
    this._skipReconnect = false
  }

  // One of: opening, open, closing, closed.
  get readyState() {
    return this.conn != null ? this.conn.readyState : 'closed'
  }

  _doConnect() {
    if (this.opts.connectTimeout) {
      this._connectTimer = setTimeout(() => {
        this.emit('connect_timeout')
        this.disconnect()
        this._skipReconnect = false
        this._onClose('connect timeout')
      }, this.opts.connectTimeout)
    }

    this.conn = eio(this.host, this.opts)
    this.conn.on('open', ::this._onOpen)
      .on('message', ::this._onMessage)
      .on('close', ::this._onClose)
      .on('error', ::this._onError)
  }

  // Connect to the server. If already connected, this will be a no-op.
  connect() {
    if (this.conn) return

    this._skipReconnect = false
    this._wasOpened = false
    this._doConnect()
  }

  reconnect() {
    if (this.conn || this._skipReconnect || this._backoffTimer) {
      return
    }

    if (this._backoff.attempts >= this.opts.reconnectionAttempts) {
      this._backoff.reset()
      this.emit('reconnect_failed')
      return
    }

    this._backoffTimer = setTimeout(() => {
      this._backoffTimer = null
      this.emit('reconnecting', this._backoff.attempts)

      if (this._skipReconnect || this.conn) return

      this._doConnect()
    }, this._backoff.duration())
  }

  // Disconnect from the server. If not already connected, this will be a no-op.
  disconnect() {
    this._skipReconnect = true
    if (this._backoffTimer) {
      clearTimeout(this._backoffTimer)
      this._backoffTimer = null
    }

    if (!this.conn) return

    this.conn.close()
  }

  // Registers a handler function to respond to PUBLISHes to paths matching a specified pattern.
  // Handlers are normal functions of the form:
  // function({ route, params, splats }, data)
  //
  // PUBLISHes that don't match a route will be emitted as an 'unhandled' event on this object,
  // which can be useful to track in development mode.
  registerRoute(pathPattern, handler) {
    this._router.addRoute(pathPattern, handler)
  }

  _onPublish({ path, data }) {
    const route = this._router.match(path)
    if (!route) {
      this.emit('unhandled', { path, data })
      return
    }

    route.action({ route: route.route, params: route.params, splats: route.splats }, data)
  }

  // Invoke a remote method on the server, specified via a path. Optionally, data can be specified
  // to send along with the call (will be JSON encoded). A Promise will be returned, resolved or
  // rejected with the result or error (respectively) from the server.
  invoke(path, data) {
    const id = cuid()
    const p = new Promise((resolve, reject) => {
      if (!this.conn) return reject(new Error('Not connected'))

      this._outstanding = this._outstanding.set(id, { resolve, reject })
      this.conn.send(encode(INVOKE, data, id, path))
    }).catch(err => {
      // Convert error-like objects back to Errors
      if (err.message && err.status) {
        const converted = new Error(err.message)
        converted.status = err.status
        converted.body = err.body
        throw converted
      }

      throw err
    })

    p.then(() => this._outstanding = this._outstanding.delete(id),
      () => this._outstanding = this._outstanding.delete(id))

    return p
  }

  _onInvokeResponse({ type, id, data }) {
    const p = this._outstanding.get(id)
    if (!p) {
      this.emit('error', 'Unknown invoke id')
      return
    }

    p[type === RESULT ? 'resolve' : 'reject'](data)
  }

  _onOpen() {
    this._clearConnectTimer()
    this._wasOpened = true
    this._backoff.reset()
    this.emit('connect')
  }

  _onMessage(msg) {
    const decoded = decode(msg)
    switch (decoded.type) {
      case PARSER_ERROR:
        this.conn.close() // will cause a call to _onClose
        break
      case WELCOME:
        if (decoded.data !== protocolVersion) {
          this.emit('error', 'Server has incompatible protocol version: ' + protocolVersion)
          this.conn.close()
        }
        break
      case RESULT:
      case ERROR:
        this._onInvokeResponse(decoded)
        break
      case PUBLISH:
        this._onPublish(decoded)
        break
    }
  }

  _onClose(reason, details) {
    this._clearConnectTimer()
    this.conn = null

    if (!this._wasOpened) {
      this.emit('connect_failed')
      this.reconnect()
      // Sockets can emit 'close' even if the connection was never actually opened. Don't emit emits
      // upstream in that case, since they're rather unnecessary
      return
    }

    this.emit('disconnect', reason, details)
    this._outstanding = this._outstanding.clear()
    this._wasOpened = false
    this.reconnect()
  }

  _onError(err) {
    this._clearConnectTimer()
    if (err.type === 'TransportError' && err.message === 'xhr poll error') {
      this._onClose(err)
      return
    }

    this.emit('error', err)
  }

  _clearConnectTimer() {
    if (this._connectTimer) {
      clearTimeout(this._connectTimer)
      this._connectTimer = null
    }
  }
}

export default function createClient(host, opts) {
  return new NydusClient(host, opts)
}
