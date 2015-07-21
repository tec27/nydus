import eio from 'engine.io'
import { EventEmitter } from 'events'
import cuid from 'cuid'
import { Map } from 'immutable'
import {
  encode,
  decode,
  protocolVersion,
  WELCOME,
  INVOKE,
  PARSER_ERROR,
} from './protocol'

export { protocolVersion }

export class NydusClient extends EventEmitter {
  constructor(id, conn, idGen = cuid) {
    super()
    this.id = id
    this.conn = conn
    this._idGen = idGen
    this._outstanding = Map()

    conn.on('error', err => this.emit('error', err))
      .on('close', ::this._onClose)
      .on('message', ::this._onMessage)
  }

  get readyState() {
    return this.conn.readyState
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
    return new Promise((resolve, reject) => {
      this._outstanding = this._outstanding.set(id, { resolve, reject })
      this.conn.send(encode(INVOKE, data, id, path))
    }).then(() => {
      this._outstanding = this._outstanding.delete(id)
    }, () => {
      this._outstanding = this._outstanding.delete(id)
    })
  }

  _onMessage(msg) {
    const decoded = decode(msg)
    if (decoded.type === PARSER_ERROR) {
      this._onClose('parser error')
      return
    }
  }

  _onClose(reason, description) {
    for (const p of this._outstanding.values()) {
      console.dir(p)
      p.reject(new Error('Connection closed before response'))
    }
    this._outstanding = this._outstanding.clear()

    this.emit('close', reason, description)
  }
}

export class NydusServer extends EventEmitter {
  constructor(options) {
    super()
    this.eioServer = eio(options)
    this._idGen = cuid
    this.clients = Map()

    this.eioServer.on('error', err => this.emit('error', err))
      .on('connection', ::this._onConnection)
  }

  attach(httpServer, options) {
    this.eioServer.attach(httpServer, options)
  }

  // Set the function used to generate IDs for messages. Should return a string of 32 characters or
  // less, matching /[A-z0-9-]+/.
  //
  // This is mainly useful for testing, generally this shouldn't need to be used.
  setIdGen(idGenFunc) {
    this._idGen = idGenFunc
  }

  _onConnection(socket) {
    const client = new NydusClient(cuid(), socket, this._idGen)
    this.clients = this.clients.set(client.id, client)
    socket.send(encode(WELCOME, protocolVersion))
    this.emit('connection', client)
  }
}

NydusServer.protocolVersion = protocolVersion

export default function createNydusServer(httpServer, ...args) {
  const nydus = new NydusServer(...args)
  nydus.attach(httpServer, ...args)
  return nydus
}
