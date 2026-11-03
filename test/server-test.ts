/* eslint-disable @typescript-eslint/no-unused-expressions */

import * as chai from 'chai'
import { expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'
import { Socket } from 'engine.io-client'
import { EventEmitter } from 'events'
import http from 'http'
import { AddressInfo } from 'net'
import { protocolVersion as clientProtocolVersion } from 'nydus-client'
import {
  decode,
  encode,
  MessageType,
  NydusErrorMessage,
  NydusInvokeMessage,
  NydusMessage,
  UnvalidatedMessage,
} from 'nydus-protocol'

import nydus, { InvokeError, NydusClient, NydusServer } from '../index.js'

chai.use(chaiAsPromised)

function packet<T>({ type, data, id, path }: UnvalidatedMessage<T>): NydusMessage<T> {
  return { type, data, id, path } as any as NydusMessage<T>
}

function idGen() {
  return '4' // chosen by a fair dice roll
}

describe('server', () => {
  it('should expose a protocolVersion', () => {
    expect(NydusServer.protocolVersion).to.be.a('number')
  })

  it('should have the same protocolVersion as the client', () => {
    expect(NydusServer.protocolVersion).to.equal(clientProtocolVersion)
  })
})

describe('nydus(httpServer)', () => {
  let server: http.Server
  let n: NydusServer
  let port: number
  let client: Socket | undefined

  beforeEach(async () => {
    server = http.createServer()
    n = nydus(server)
    n.setIdGen(idGen)
    port = await new Promise(resolve => {
      server.listen(0, () => resolve((server.address() as AddressInfo).port))
    })
  })

  afterEach(() => {
    if (client) {
      client.close()
      client = undefined
    }
    n.close()
    server.close()

    // These will never be undefined during a test so we don't have this in their types
    n = undefined as any
    server = undefined as any
  })

  async function connectClient() {
    client = new Socket('ws://localhost:' + port, { transports: ['websocket'] })
    return await new Promise<Socket>((resolve, reject) => {
      client!.on('open', () => resolve(client!)).on('error', err => reject(err))
    })
  }

  it('should return a NydusServer', () => {
    expect(n).to.be.an.instanceOf(NydusServer)
  })

  it('should attach to the http server', async () => {
    return await connectClient()
  })

  it('should send welcome message to clients', done => {
    connectClient()
    client!.on('message', msg => {
      expect(decode(msg as string)).to.eql(
        packet({ type: MessageType.Welcome, data: NydusServer.protocolVersion }),
      )
      client!.close()
      done()
    })
  })

  it('should emit connection events', done => {
    let promise: Promise<Socket> | null = null
    n.on('connection', socket => {
      expect(socket).not.to.be.null
      promise!.then(
        () => done(),
        () => done(),
      )
    })

    promise = connectClient()
  })

  it('should publish to subscribed clients', done => {
    connectClient()
    let i = 0
    client!.on('message', msg => {
      if (i++ < 1) return

      expect(decode(msg as string)).to.eql(
        packet({ type: MessageType.Publish, data: 'hi', path: '/hello' }),
      )
      done()
    })

    n.on('connection', c => {
      n.subscribeClient(c, '/hello')
      n.publish('/hello', 'hi')
    })
  })

  it('should support subscribing clients and pushing initial data', async () => {
    let readyResolve: () => void
    const readyPromise = new Promise<void>(resolve => {
      readyResolve = resolve
    })

    let cNum = 0
    n.on('connection', c => {
      if (cNum++ < 1) {
        readyPromise.then(() => {
          n.subscribeClient(c, '/hello')
        })
      } else {
        readyPromise.then(() => {
          n.subscribeClient(c, '/hello', 'hi')
        })
      }
    })

    const noInitial = await connectClient()
    const withInitial = await connectClient()

    await new Promise<void>((resolve, reject) => {
      noInitial.on('message', () => {
        reject(new Error("first client shouldn't have received another message"))
      })

      withInitial.on('message', msg => {
        try {
          expect(decode(msg as string)).to.eql(
            packet({ type: MessageType.Publish, data: 'hi', path: '/hello' }),
          )
        } catch (err) {
          reject(err)
        }
        resolve()
      })

      readyResolve()
    })
  })

  it('should support subscribing clients and pushing initial data async-ly', async () => {
    let readyResolve: () => void
    const readyPromise = new Promise<void>(resolve => {
      readyResolve = resolve
    })

    let cNum = 0
    n.on('connection', c => {
      if (cNum++ < 1) {
        readyPromise.then(() => {
          n.subscribeClient(c, '/hello')
        })
      } else {
        readyPromise.then(() => {
          n.subscribeClient(c, '/hello', Promise.resolve('hi'))
        })
      }
    })

    const noInitial = await connectClient()
    const withInitial = await connectClient()

    await new Promise<void>((resolve, reject) => {
      noInitial.on('message', () => {
        reject(new Error("first client shouldn't have received another message"))
      })

      withInitial.on('message', msg => {
        try {
          expect(decode(msg as string)).to.eql(
            packet({ type: MessageType.Publish, data: 'hi', path: '/hello' }),
          )
        } catch (err) {
          reject(err)
        }
        resolve()
      })

      readyResolve()
    })
  })

  it('should not cause unhandled rejections when async initial data fails', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    const otherListeners = process.listeners('unhandledRejection')
    process.removeAllListeners('unhandledRejection')
    process.on('unhandledRejection', onUnhandled)

    try {
      const connected = new Promise<NydusClient>(resolve => n.once('connection', resolve))
      await connectClient()
      const c = await connected

      const initialData = Promise.reject(new Error('failed to load'))
      initialData.catch(() => {}) // the caller handles its own rejection
      n.subscribeClient(c, '/hello', initialData)

      await new Promise(resolve => setTimeout(resolve, 30))
      expect(unhandled).to.be.empty
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
      for (const l of otherListeners) process.on('unhandledRejection', l)
    }
  })

  it("should not send async initial data from a subscription that's since ended", async () => {
    const connected = new Promise<NydusClient>(resolve => n.once('connection', resolve))
    const socket = await connectClient()
    const c = await connected
    const received: NydusMessage<unknown>[] = []
    socket.on('message', msg => received.push(decode(msg as string)))

    let resolveStale: (value: string) => void
    n.subscribeClient(
      c,
      '/hello',
      new Promise<string>(resolve => {
        resolveStale = resolve
      }),
    )
    n.unsubscribeClient(c, '/hello')
    n.subscribeClient(c, '/hello', 'fresh')
    resolveStale!('stale')

    await new Promise(resolve => setTimeout(resolve, 30))
    expect(received.filter(m => m.type === MessageType.Publish)).to.eql([
      packet({ type: MessageType.Publish, data: 'fresh', path: '/hello' }),
    ])
  })

  it('should allow unsubscribing individual clients', done => {
    connectClient()
    let i = 0
    client!.on('message', () => {
      if (i++ < 1) return
      done(new Error("client shouldn't have received a message"))
    })

    n.on('connection', c => {
      n.subscribeClient(c, '/hello')
      let result = n.unsubscribeClient(c, '/hello')
      expect(result).to.be.true
      result = n.unsubscribeClient(c, '/hello')
      expect(result).to.be.false
      n.publish('/hello', 'hi')
      setTimeout(() => done(), 30)
    })
  })

  it('should allow unsubscribing all clients from a path', done => {
    connectClient()
    let i = 0
    client!.on('message', () => {
      if (i++ < 1) return
      done(new Error("client shouldn't have received a message"))
    })

    connectClient()
    let j = 0
    client!.on('message', () => {
      if (j++ < 1) return
      done(new Error("client shouldn't have received a message"))
    })

    let numClients = 0
    n.on('connection', c => {
      try {
        numClients++
        n.subscribeClient(c, '/hello')

        if (numClients === 2) {
          let result = n.unsubscribeAll('/hello')
          expect(result).to.be.true
          result = n.unsubscribeAll('/hello')
          expect(result).to.be.false
          result = n.unsubscribeClient(c, '/hello')
          expect(result).to.be.false

          n.publish('/hello', 'hi')
          setTimeout(() => {
            done()
          }, 30)
        }
      } catch (err: any) {
        done(err)
      }
    })
  })

  it('should accept invokes from clients on registered routes', done => {
    n.registerRoute('/hello', async () => {
      return 'hi'
    })

    connectClient()
    let i = 0
    client!.on('message', msg => {
      if (i++ === 0) {
        client!.send(encode(MessageType.Invoke, 'hi', '27', '/hello'), undefined)
      } else {
        expect(decode(msg as string)).to.be.eql(
          packet({ type: MessageType.Result, data: 'hi', id: '27' }),
        )
        done()
      }
    })
  })

  it('should send an error when a client invokes on an unregistered path', done => {
    connectClient()
    let i = 0
    client!.on('message', msg => {
      if (i++ === 0) {
        client!.send(encode(MessageType.Invoke, 'hi', '27', '/hello'), undefined)
      } else {
        expect(decode(msg as string)).to.be.eql(
          packet({
            type: MessageType.Error,
            data: { status: 404, message: 'Not Found' },
            id: '27',
          }),
        )
        done()
      }
    })
  })

  it('should send back errors when invoke handlers cause a rejection', done => {
    n.registerRoute('/hello', async () => {
      throw new InvokeError('Custom Error', 527)
    })

    connectClient()
    let i = 0
    client!.on('message', msg => {
      if (i++ === 0) {
        client!.send(encode(MessageType.Invoke, 'hi', '27', '/hello'), undefined)
      } else {
        expect(decode(msg as string)).to.be.eql(
          packet({
            type: MessageType.Error,
            data: { status: 527, message: 'Custom Error' },
            id: '27',
          }),
        )
        done()
      }
    })
  })

  it('should send back a 500 if no status is set on invoke rejections', done => {
    n.registerRoute('/hello', async () => {
      const err = new Error('Omg error')
      throw err
    })
    let invokeErrorParams: {
      err?: Error
      client?: NydusClient
      msg?: NydusInvokeMessage<unknown>
    } = {}
    n.on('invokeError', (err, client, msg) => {
      invokeErrorParams = {
        err,
        client,
        msg,
      }
    })

    connectClient()
    let i = 0
    client!.on('message', msg => {
      if (i++ === 0) {
        client!.send(encode(MessageType.Invoke, 'hi', '27', '/hello'), undefined)
      } else {
        const decoded = decode(msg as string) as NydusErrorMessage<any>
        expect(decoded.type).to.be.eql(MessageType.Error)
        expect(decoded.id).to.be.eql('27')
        expect(decoded.data.message).to.be.eql('Omg error')
        expect(decoded.data.status).to.be.eql(500)
        expect(decoded.data.body).to.have.length.above(0)

        expect(invokeErrorParams.err).to.exist
        expect(invokeErrorParams.client).to.exist
        expect(invokeErrorParams.msg).to.exist
        done()
      }
    })
  })

  it("should still reply to failed invokes if the converted error can't be encoded", async () => {
    const otherServer = http.createServer()
    const other = nydus(otherServer, { invokeErrorConverter: () => ({ status: 500, count: 10n }) })
    other.registerRoute('/hello', async () => {
      throw new Error('Omg error')
    })
    const errors: Error[] = []
    other.on('error', err => errors.push(err))
    const otherPort = await new Promise<number>(resolve => {
      otherServer.listen(0, () => resolve((otherServer.address() as AddressInfo).port))
    })
    const socket = new Socket('ws://localhost:' + otherPort, { transports: ['websocket'] })

    try {
      const reply = await new Promise<string>((resolve, reject) => {
        let i = 0
        socket.on('error', reject).on('message', msg => {
          if (i++ === 0) {
            socket.send(encode(MessageType.Invoke, 'hi', '27', '/hello'), undefined)
          } else {
            resolve(msg as string)
          }
        })
      })

      expect(decode(reply)).to.be.eql(
        packet({
          type: MessageType.Error,
          data: { status: 500, message: 'Internal Server Error' },
          id: '27',
        }),
      )
      expect(errors).to.have.length(1)
    } finally {
      socket.close()
      other.close()
      otherServer.close()
    }
  })

  it('should send back a 500 if invoke handlers reject without an error', done => {
    n.registerRoute('/hello', () => Promise.reject())
    let invokeErrors = 0
    n.on('invokeError', () => invokeErrors++)

    connectClient()
    let i = 0
    client!.on('message', msg => {
      if (i++ === 0) {
        client!.send(encode(MessageType.Invoke, 'hi', '27', '/hello'), undefined)
      } else {
        const decoded = decode(msg as string) as NydusErrorMessage<any>
        expect(decoded.type).to.be.eql(MessageType.Error)
        expect(decoded.id).to.be.eql('27')
        expect(decoded.data.status).to.be.eql(500)
        expect(invokeErrors).to.be.eql(1)
        done()
      }
    })
  })

  it('should allow sending bodies along with invoke rejections', done => {
    n.registerRoute('/hello', async (data, next) => {
      throw new InvokeError('Big error', 527, { hello: 'world' })
    })

    connectClient()
    let i = 0
    client!.on('message', msg => {
      if (i++ === 0) {
        client!.send(encode(MessageType.Invoke, 'hi', '27', '/hello'), undefined)
      } else {
        expect(decode(msg as string)).to.be.eql(
          packet({
            type: MessageType.Error,
            data: { status: 527, message: 'Big error', body: { hello: 'world' } },
            id: '27',
          }),
        )
        done()
      }
    })
  })

  it('should provide params and splats to route handlers', done => {
    n.registerRoute('/hello/:who/*', async data => {
      try {
        expect(data.get('params').get('who')).to.be.eql('me')
        expect(data.get('splats').toArray()).to.be.eql(['whatever'])
      } catch (err) {
        done(err)
        throw err
      }
      done()
    })

    connectClient()
    ;(client as any as EventEmitter).once('message', () => {
      client!.send(encode(MessageType.Invoke, 'hi', '27', '/hello/me/whatever'), undefined)
    })
  })

  it('should forget clients and their subscriptions once they disconnect', async () => {
    const connected = new Promise<NydusClient>(resolve => n.once('connection', resolve))
    await connectClient()
    const c = await connected
    n.subscribeClient(c, '/hello')
    expect(n.clients.has(c.id)).to.be.true

    const closed = new Promise<void>(resolve => c.once('close', () => resolve()))
    client!.close()
    await closed

    expect(n.clients.has(c.id)).to.be.false
    expect((n as any).subscriptions.has('/hello')).to.be.false
  })

  it('should ignore subscriptions for clients that have already disconnected', async () => {
    const connected = new Promise<NydusClient>(resolve => n.once('connection', resolve))
    await connectClient()
    const c = await connected

    const closed = new Promise<void>(resolve => c.once('close', () => resolve()))
    client!.close()
    await closed

    n.subscribeClient(c, '/hello', 'hi')
    expect(c.subscriptions.has('/hello')).to.be.false
    expect((n as any).subscriptions.has('/hello')).to.be.false
  })

  it('should drop paths once their last client unsubscribes', async () => {
    const connected = new Promise<NydusClient>(resolve => n.once('connection', resolve))
    await connectClient()
    const c = await connected
    n.subscribeClient(c, '/hello')

    expect(n.unsubscribeClient(c, '/hello')).to.be.true
    expect((n as any).subscriptions.has('/hello')).to.be.false
    expect(n.unsubscribeClient(c, '/hello')).to.be.false
  })

  it('should treat malformed percent-encoding in message paths as a parser error', async () => {
    const parserError = new Promise<string>(resolve =>
      n.once('parserError', (_, msg) => resolve(msg)),
    )
    const socket = await connectClient()
    const closed = new Promise<void>(resolve => socket.once('close', () => resolve()))
    socket.send('1$27~/hello/%|', undefined)

    expect(await parserError).to.equal('1$27~/hello/%|')
    await closed
  })

  it('should send an error for invokes with malformed percent-encoding in params', done => {
    n.registerRoute('/hello/:who', async () => 'hi')

    connectClient()
    let i = 0
    client!.on('message', msg => {
      if (i++ === 0) {
        // The protocol decodes this path to `/hello/%`, which isn't a valid URI component
        client!.send('1$27~/hello/%25|"hi"', undefined)
      } else {
        expect(decode(msg as string)).to.be.eql(
          packet({
            type: MessageType.Error,
            data: { status: 400, message: 'Bad Request' },
            id: '27',
          }),
        )
        done()
      }
    })
  })

  it('should provide invoke payloads to route handlers', done => {
    n.registerRoute('/hello', async data => {
      try {
        expect(data.get('body')).to.be.eql({ who: 'me' })
      } catch (err) {
        done(err)
        throw err
      }
      done()
    })

    connectClient()
    ;(client as any as EventEmitter).once('message', () => {
      client!.send(encode(MessageType.Invoke, { who: 'me' }, '27', '/hello'), undefined)
    })
  })
})
