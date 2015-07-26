import eio from 'engine.io-client'
import { EventEmitter } from 'events'
import { Map } from 'immutable'
import cuid from 'cuid'
import {
  encode,
  decode,
  WELCOME,
  INVOKE,
  RESULT,
  ERROR,
  PARSER_ERROR,
  protocolVersion,
} from '../protocol'

export { protocolVersion }

export class NydusClient extends EventEmitter {
  constructor(host, opts) {
    super()
    this.host = host
    this.opts = opts
    this.conn = null
    this._outstanding = Map()
  }

  // One of: opening, open, closing, closed.
  get readyState() {
    return this.conn != null ? this.conn.readyState : 'closed'
  }

  // Connect to the server. If already connected, this will be a no-op.
  connect() {
    if (this.conn) return

    this.conn = eio(this.host, this.opts)
    this.conn.on('open', ::this._onOpen)
      .on('message', ::this._onMessage)
      .on('close', ::this._onClose)
      .on('error', ::this._onError)
  }

  // Disconnect from the server. If not already connected, this will be a no-op.
  disconnect() {
    if (!this.conn) return

    this.conn.close()
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
    }
  }

  _onClose() {
    this.emit('disconnect')
    this.conn = null
    this._outstanding = this._outstanding.clear()
  }

  _onError(err) {
    this.emit('error', err)
  }
}

export default function createClient(host, opts) {
  return new NydusClient(host, opts)
}
