import eio from 'engine.io'
import http, { STATUS_CODES } from 'http'
import { EventEmitter } from 'events'
import cuid from 'cuid'
import { fromJS, Map, Set } from 'immutable'
import ruta, { Router } from 'ruta3'
import compose, { ComposableFunc, NextFunc } from './composer'
import { encode, decode, protocolVersion, MessageType, NydusInvokeMessage } from 'nydus-protocol'

export { protocolVersion }

const PACKAGE_ONLY = Symbol('nydus-package-only')

interface NydusClientEvents {
  /** Fired when the client has disconnected. */
  close: (reason: string, description?: Error) => void
  /** Fired when a general error occurs. */
  error: (err: Error) => void
}

export declare interface NydusClient {
  emit<U extends keyof NydusClientEvents>(
    event: U,
    ...args: Parameters<NydusClientEvents[U]>
  ): boolean
  on<U extends keyof NydusClientEvents>(event: U, listener: NydusClientEvents[U]): this
  once<U extends keyof NydusClientEvents>(event: U, listener: NydusClientEvents[U]): this
}

/** A client that is connected to the server. */
// eslint-disable-next-line no-redeclare
export class NydusClient extends EventEmitter {
  readonly id: string
  readonly conn: eio.Socket
  private onInvokeFunc: (client: NydusClient, message: NydusInvokeMessage<unknown>) => void
  private onCloseFunc: (client: NydusClient) => void
  subscriptions: Set<string>

  constructor(
    id: string,
    conn: eio.Socket,
    onInvoke: (client: NydusClient, message: NydusInvokeMessage<unknown>) => void,
    onClose: (client: NydusClient) => void,
  ) {
    super()
    this.id = id
    this.conn = conn
    this.onInvokeFunc = onInvoke
    this.onCloseFunc = onClose
    this.subscriptions = Set()

    conn
      .on('error', err => this.emit('error', err))
      .on('close', this.onClose.bind(this))
      .on('message', msg => this.onMessage(msg as string))
  }

  /** Returns the current `readyState` of the connection. */
  get readyState() {
    return this.conn.readyState
  }

  equals(other: unknown) {
    return other === this || (other instanceof NydusClient && other.id === this.id)
  }

  // This is taken from immutable's String hashing code
  hashCode(): number {
    const string = this.id
    let hashed = 0
    for (let ii = 0; ii < string.length; ii++) {
      hashed = (31 * hashed + string.charCodeAt(ii)) | 0
    }
    return ((hashed >>> 1) & 0x40000000) | (hashed & 0xbfffffff)
  }

  /** Closes the underlying connection. */
  close() {
    this.conn.close()
  }

  send(packageOnlyKey: typeof PACKAGE_ONLY, encoded: string) {
    if (packageOnlyKey === PACKAGE_ONLY) {
      this.conn.send(encoded)
    }
  }

  private onMessage(msg: string) {
    const decoded = decode(msg)
    switch (decoded.type) {
      case MessageType.ParserError:
        this.conn.close() // will cause a call to onClose
        break
      case MessageType.Invoke:
        this.onInvokeFunc(this, decoded)
        break
    }
  }

  private onClose(reason: string, description?: Error) {
    this.onCloseFunc(this)
    this.emit('close', reason, description)
  }
}

export class InvokeError extends Error {
  readonly status: number
  readonly body: any

  constructor(message: string, status: number, body?: any) {
    super(message)
    this.status = status
    this.body = body
  }
}

function isInvokeError(err: Error): err is InvokeError {
  return (err as any).hasOwnProperty('status')
}

function defaultErrorConverter(err: Error): unknown {
  const isDev = process.env.NODE_ENV !== 'production'
  let status = 500
  let message = STATUS_CODES[500]
  let body: any | undefined

  if (isInvokeError(err)) {
    status = err.status
    message = err.message
    body = err.body
  } else if (isDev) {
    message = err.message
    body ??= err.stack
  }

  message ??= STATUS_CODES[status]

  return { message, status, body }
}

const NOT_FOUND = { message: 'Not Found', status: 404 }

export interface NydusServerOptions extends eio.ServerOptions, eio.AttachOptions {
  /**
   * A function to convert errors to a sanitized version before sending them to clients. Optional,
   * the default implementation passes a status code, message, and body if present. In development
   * mode, it will include the stack trace as the body if there isn't a body already.
   */
  invokeErrorConverter: (err: Error, client: NydusClient) => unknown
}

export type RouteHandler = ComposableFunc

interface NydusServerEvents {
  /** Fired when a new client has connected. */
  connection: (client: NydusClient) => void
  /** Fired when a general error occurs. */
  error: (err: Error) => void
}

export declare interface NydusServer {
  emit<U extends keyof NydusServerEvents>(
    event: U,
    ...args: Parameters<NydusServerEvents[U]>
  ): boolean
  on<U extends keyof NydusServerEvents>(event: U, listener: NydusServerEvents[U]): this
  once<U extends keyof NydusServerEvents>(event: U, listener: NydusServerEvents[U]): this
}

// eslint-disable-next-line no-redeclare
export class NydusServer extends EventEmitter {
  static readonly protocolVersion = protocolVersion

  /** A map of client ID -> client. */
  clients: Map<string, NydusClient>

  private eioServer: eio.Server
  private invokeErrorConverter: (err: Error, client: NydusClient) => unknown
  private idGen: () => string
  private subscriptions: Map<string, Set<NydusClient>>
  private router: Router<NextFunc>

  private onInvokeFunc = this.onInvoke.bind(this)
  private onCloseFunc = this.onDisconnect.bind(this)

  constructor(options: Partial<NydusServerOptions> = {}) {
    super()
    this.eioServer = new eio.Server(options)
    this.invokeErrorConverter = options.invokeErrorConverter ?? defaultErrorConverter
    this.idGen = cuid
    this.clients = Map()
    this.subscriptions = Map()
    this.router = ruta()
    ;(this.eioServer as EventEmitter)
      .on('error', err => this.emit('error', err))
      .on('connection', this.onConnection.bind(this))
  }

  /**
   * Attach this NydusServer to a particular HTTP(S) server, making it listen to UPGRADE requests.
   */
  attach(httpServer: http.Server, options: eio.AttachOptions) {
    this.eioServer.attach(httpServer, options)
  }

  /** Close any open connections and then stop this Nydus server. */
  close() {
    for (const client of this.clients.values()) {
      client.close()
    }
    this.clients = this.clients.clear()
    this.eioServer.close()
  }

  /**
   * Set the function used to generate IDs for messages. Should return a string of 32 characters or
   * less, matching /[A-z0-9-]+/.
   *
   * This is mainly useful for testing, generally this shouldn't need to be used.
   */
  setIdGen(idGenFunc: () => string) {
    this.idGen = idGenFunc
  }

  /**
   * Registers one or more handlers to respond to INVOKEs on paths matching a pattern. Handlers are
   * async functions (and thus return promises when called) of the form:
   *   `(data, next) => Promise<any>`
   *
   * Handlers will be composed in order, and are expected to call next(data, next) to make execution
   * continue further down the chain. Data is an immutable map that can be changed before passing it
   * to the next function, but should present the same API (or ideally, be an ImmutableJS map) for
   * compatibility with other handlers.
   *
   * The final resolved value will be sent to the client (as a RESULT if the promise was
   * successfully resolved, an ERROR if it was rejected).
   */
  registerRoute(pathPattern: string, ...handlers: RouteHandler[]) {
    if (!handlers.length) {
      throw new Error('At least one handler function is required')
    }

    this.router.addRoute(pathPattern, compose(handlers))
  }

  /**
   * Add a subscription to a publish path for a client. Whenever messages are published to that
   * path, this client will receive a message (until unsubscribed). If initialData is specified and
   * the client was not previously subscribed, this data will be published to the client
   * immediately (but not to the other subscribed clients).
   */
  subscribeClient(client: NydusClient, path: string, initialData?: any) {
    const newSubs = this.subscriptions.update(path, Set(), s => s.add(client))
    if (newSubs === this.subscriptions) {
      return // client was previously subscribed
    }
    this.subscriptions = newSubs
    client.subscriptions = client.subscriptions.add(path)
    if (initialData !== undefined) {
      client.send(PACKAGE_ONLY, encode(MessageType.Publish, initialData, undefined, path))
    }
  }

  /** Remove a client's subsription to a path (if it was subscribed). */
  unsubscribeClient(client: NydusClient, path: string) {
    const newSubs = this.subscriptions.update(path, s => s && s.delete(client))
    if (newSubs === this.subscriptions) {
      return false // client wasn't subscribed before
    }
    this.subscriptions = newSubs
    client.subscriptions = client.subscriptions.delete(path)
    return true
  }

  /**
   * Unsubscribe all the clients currently subscribed to a path.
   */
  unsubscribeAll(path: string) {
    const subs = this.subscriptions.get(path)
    if (!subs) {
      return false
    }

    for (const c of subs.values()) {
      c.subscriptions = c.subscriptions.delete(path)
    }
    this.subscriptions = this.subscriptions.delete(path)
    return true
  }

  /**
   * Publish a message to all clients subscribed to `path`.
   */
  publish(path: string, data?: any) {
    const subs = this.subscriptions.get(path)
    if (!subs) return

    const packet = encode(MessageType.Publish, data, undefined, path)
    for (const c of subs.values()) {
      c.send(PACKAGE_ONLY, packet)
    }
  }

  private onConnection(socket: eio.Socket) {
    const client = new NydusClient(this.idGen(), socket, this.onInvokeFunc, this.onCloseFunc)
    this.clients = this.clients.set(client.id, client)
    socket.send(encode(MessageType.Welcome, protocolVersion))
    this.emit('connection', client)
  }

  private onDisconnect(client: NydusClient) {
    const subs = client.subscriptions
    for (const path of subs.values()) {
      this.subscriptions = this.subscriptions.update(path, s => s && s.delete(client))
    }
  }

  private onInvoke(client: NydusClient, msg: NydusInvokeMessage<unknown>) {
    const route = this.router.match(msg.path)
    if (!route) {
      client.send(PACKAGE_ONLY, encode(MessageType.Error, NOT_FOUND, msg.id))
      return
    }

    const initData = Map({
      server: this,
      client,
      path: route.route,
      params: fromJS(route.params),
      splats: fromJS(route.splats),
      body: msg.data,
    })

    route
      .action(initData)
      .then(result => {
        client.send(PACKAGE_ONLY, encode(MessageType.Result, result, msg.id))
      })
      .catch(err => {
        let result
        try {
          result = this.invokeErrorConverter(err, client)
        } catch (convertErr) {
          result = { status: 500, message: STATUS_CODES[500] }
        }
        client.send(PACKAGE_ONLY, encode(MessageType.Error, result, msg.id))
      })
  }
}

export default function createNydusServer(
  httpServer: http.Server,
  opts: Partial<NydusServerOptions> = {},
) {
  const nydus = new NydusServer(opts)
  nydus.attach(httpServer, opts)
  return nydus
}
