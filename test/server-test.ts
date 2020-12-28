import chai, { expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'
import http from 'http'
import { EventEmitter } from 'events'
import eio from 'engine.io-client'
import { AddressInfo } from 'net'
import {
  decode,
  encode,
  MessageType,
  NydusErrorMessage,
  NydusMessage,
  UnvalidatedMessage,
} from 'nydus-protocol'

import nydus, { InvokeError, NydusServer } from '../index'

chai.use(chaiAsPromised)

function packet<T>({ type, data, id, path }: UnvalidatedMessage<T>): NydusMessage<T> {
  return ({ type, data, id, path } as any) as NydusMessage<T>
}

function idGen() {
  return '4' // chosen by a fair dice roll
}

describe('server', () => {
  it('should expose a protocolVersion', () => {
    expect(NydusServer.protocolVersion).to.be.a('number')
  })

  it('should have the same protocolVersion as the client', () => {
    expect(NydusServer.protocolVersion).to.equal(require('nydus-client').protocolVersion)
  })
})

describe('nydus(httpServer)', () => {
  let server: http.Server
  let n: NydusServer
  let port: number
  let client: eio.Socket | undefined

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

    n = undefined
    server = undefined
  })

  async function connectClient() {
    client = eio('ws://localhost:' + port, { transports: ['websocket'] })
    return await new Promise<eio.Socket>((resolve, reject) => {
      client.on('open', () => resolve(client)).on('error', (err: Error) => reject(err))
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
    client.on('message', msg => {
      expect(decode(msg as string)).to.eql(
        packet({ type: MessageType.Welcome, data: NydusServer.protocolVersion }),
      )
      client.close()
      done()
    })
  })

  it('should emit connection events', done => {
    let promise: Promise<eio.Socket> = null
    n.on('connection', socket => {
      expect(socket).not.to.be.null
      promise.then(
        () => done(),
        () => done(),
      )
    })

    promise = connectClient()
  })

  it('should publish to subscribed clients', done => {
    connectClient()
    let i = 0
    client.on('message', msg => {
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

  it('should support subscribing clients and pushing initial data', done => {
    connectClient()
    let i = 0
    client.on('message', () => {
      if (i++ < 1) return
      done(new Error("first client shouldn't have received another message"))
    })
    connectClient()
    let j = 0
    client.on('message', msg => {
      if (j++ < 1) return

      expect(decode(msg as string)).to.eql(
        packet({ type: MessageType.Publish, data: 'hi', path: '/hello' }),
      )
      done()
    })

    let cNum = 0
    n.on('connection', c => {
      if (cNum++ < 1) n.subscribeClient(c, '/hello')
      else n.subscribeClient(c, '/hello', 'hi')
    })
  })

  it('should allow unsubscribing individual clients', done => {
    connectClient()
    let i = 0
    client.on('message', () => {
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
    client.on('message', () => {
      if (i++ < 1) return
      done(new Error("client shouldn't have received a message"))
    })

    connectClient()
    let j = 0
    client.on('message', () => {
      if (j++ < 1) return
      done(new Error("client shouldn't have received a message"))
    })

    let numClients = 0
    n.on('connection', c => {
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
        setTimeout(() => done(), 30)
      }
    })
  })

  it('should accept invokes from clients on registered routes', done => {
    n.registerRoute('/hello', async () => {
      return 'hi'
    })

    connectClient()
    let i = 0
    client.on('message', msg => {
      if (i++ === 0) {
        client.send(encode(MessageType.Invoke, 'hi', '27', '/hello'))
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
    client.on('message', msg => {
      if (i++ === 0) {
        client.send(encode(MessageType.Invoke, 'hi', '27', '/hello'))
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
    client.on('message', msg => {
      if (i++ === 0) {
        client.send(encode(MessageType.Invoke, 'hi', '27', '/hello'))
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

    connectClient()
    let i = 0
    client.on('message', msg => {
      if (i++ === 0) {
        client.send(encode(MessageType.Invoke, 'hi', '27', '/hello'))
      } else {
        const decoded = decode(msg as string) as NydusErrorMessage<any>
        expect(decoded.type).to.be.eql(MessageType.Error)
        expect(decoded.id).to.be.eql('27')
        expect(decoded.data.message).to.be.eql('Omg error')
        expect(decoded.data.status).to.be.eql(500)
        expect(decoded.data.body).to.have.length.above(0)
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
    client.on('message', msg => {
      if (i++ === 0) {
        client.send(encode(MessageType.Invoke, 'hi', '27', '/hello'))
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
    ;((client as any) as EventEmitter).once('message', () => {
      client.send(encode(MessageType.Invoke, 'hi', '27', '/hello/me/whatever'))
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
    ;((client as any) as EventEmitter).once('message', () => {
      client.send(encode(MessageType.Invoke, { who: 'me' }, '27', '/hello'))
    })
  })
})
