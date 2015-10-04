import chai, { expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'
import http from 'http'
import eio from 'engine.io-client'
import { decode, encode, WELCOME, INVOKE, ERROR, RESULT, PUBLISH } from 'nydus-protocol'

import nydus, { NydusServer } from '../'

chai.use(chaiAsPromised)

function packet({ type, id, path, data }) {
  return { type, id, path, data }
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
  let server
  let n
  let port
  let client

  beforeEach(async () => {
    server = http.createServer()
    n = nydus(server)
    n.setIdGen(idGen)
    port = await new Promise((resolve, reject) => {
      server.listen(0, function(err) {
        if (err) return reject(err)
        resolve(server.address().port)
      })
    })
  })

  afterEach(() => {
    if (client) {
      client.close()
    }
    n.close()
    server.close()
  })

  async function connectClient() {
    client = eio('ws://localhost:' + port)
    return await new Promise((resolve, reject) => {
      client.on('open', () => resolve(client))
        .on('error', err => reject(err))
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
      expect(decode(msg)).to.eql(packet({ type: WELCOME, data: NydusServer.protocolVersion }))
      client.close()
      done()
    })
  })

  it('should emit connection events', done => {
    n.on('connection', socket => {
      expect(socket).not.to.be.null
      done()
    })

    connectClient()
  })

  it('should publish to subscribed clients', done => {
    connectClient()
    let i = 0
    client.on('message', msg => {
      if (i++ < 1) return

      expect(decode(msg)).to.eql(packet({ type: PUBLISH, data: 'hi', path: '/hello' }))
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
    client.on('message', msg => {
      if (i++ < 1) return
      done(new Error('first client shouldn\'t have received another message'))
    })
    connectClient()
    let j = 0
    client.on('message', msg => {
      if (j++ < 1) return

      expect(decode(msg)).to.eql(packet({ type: PUBLISH, data: 'hi', path: '/hello' }))
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
    client.on('message', msg => {
      if (i++ < 1) return
      done(new Error('client shouldn\'t have received a message'))
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
    client.on('message', msg => {
      if (i++ < 1) return
      done(new Error('client shouldn\'t have received a message'))
    })

    connectClient()
    let j = 0
    client.on('message', msg => {
      if (j++ < 1) return
      done(new Error('client shouldn\'t have received a message'))
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
    n.registerRoute('/hello', async (data, next) => {
      return 'hi'
    })

    connectClient()
    let i = 0
    client.on('message', msg => {
      if (i++ === 0) {
        client.send(encode(INVOKE, 'hi', '27', '/hello'))
      } else {
        expect(decode(msg)).to.be.eql(packet({ type: RESULT, data: 'hi', id: '27' }))
        done()
      }
    })
  })

  it('should send an error when a client invokes on an unregistered path', done => {
    connectClient()
    let i = 0
    client.on('message', msg => {
      if (i++ === 0) {
        client.send(encode(INVOKE, 'hi', '27', '/hello'))
      } else {
        expect(decode(msg)).to.be.eql(packet({
          type: ERROR,
          data: { status: 404, message: 'Not Found' },
          id: '27'
        }))
        done()
      }
    })
  })

  it('should send back errors when invoke handlers cause a rejection', done => {
    n.registerRoute('/hello', async (data, next) => {
      const err = new Error('Custom Error')
      err.status = 527
      throw err
    })

    connectClient()
    let i = 0
    client.on('message', msg => {
      if (i++ === 0) {
        client.send(encode(INVOKE, 'hi', '27', '/hello'))
      } else {
        expect(decode(msg)).to.be.eql(packet({
          type: ERROR,
          data: { status: 527, message: 'Custom Error' },
          id: '27'
        }))
        done()
      }
    })
  })

  it('should send back a 500 if no status is set on invoke rejections', done => {
    n.registerRoute('/hello', async (data, next) => {
      const err = new Error('Omg error')
      throw err
    })

    connectClient()
    let i = 0
    client.on('message', msg => {
      if (i++ === 0) {
        client.send(encode(INVOKE, 'hi', '27', '/hello'))
      } else {
        expect(decode(msg)).to.be.eql(packet({
          type: ERROR,
          data: { status: 500, message: 'Omg error' },
          id: '27'
        }))
        done()
      }
    })
  })

  it('should allow sending bodies along with invoke rejections', done => {
    n.registerRoute('/hello', async (data, next) => {
      const err = new Error('Big error')
      err.status = 527
      err.body = { hello: 'world' }
      throw err
    })

    connectClient()
    let i = 0
    client.on('message', msg => {
      if (i++ === 0) {
        client.send(encode(INVOKE, 'hi', '27', '/hello'))
      } else {
        expect(decode(msg)).to.be.eql(packet({
          type: ERROR,
          data: { status: 527, message: 'Big error', body: { hello: 'world' } },
          id: '27'
        }))
        done()
      }
    })
  })

  it('should provide params and splats to router handlers', done => {
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
    client.once('message', msg => {
      client.send(encode(INVOKE, 'hi', '27', '/hello/me/whatever'))
    })
  })
})
