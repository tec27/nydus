import chai, { expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'
import http from 'http'
import eio from 'engine.io-client'
import { decode, encode, WELCOME, INVOKE, ERROR, RESULT, PUBLISH } from '../protocol'

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
    expect(NydusServer.protocolVersion).to.equal(require('../client').protocolVersion)
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

  it('should send invokes to clients', done => {
    connectClient()
    let i = 0
    client.on('message', msg => {
      if (i++ < 1) return

      expect(decode(msg)).to.eql(packet({ type: INVOKE, data: 'hi', id: idGen(), path: '/hello' }))
      done()
    })

    n.on('connection', c => c.invoke('/hello', 'hi'))
  })

  it('should reject promises on error responses', done => {
    connectClient()
    let i = 0
    client.on('message', msg => {
      if (i++ < 1) return

      const id = decode(msg).id
      client.send(encode(ERROR, { code: 418, message: 'I am a teapot' }, id))
    })

    n.on('connection', c => {
      const p = c.invoke('/hello', 'hi')
      expect(p).to.eventually.be.rejectedWith({ code: 418, message: 'I am a teapot' })
        .and.notify(done)
    })
  })

  it('should resolve promises on success responses', done => {
    connectClient()
    let i = 0
    client.on('message', msg => {
      if (i++ < 1) return

      const id = decode(msg).id
      client.send(encode(RESULT, { message: 'sup' }, id))
    })

    n.on('connection', c => {
      const p = c.invoke('/hello', 'hi')
      expect(p).to.eventually.eql({ message: 'sup' }).and.notify(done)
    })
  })

  it('should close client connection on response to unknown request ID', done => {
    connectClient()
    client.once('message', () => {
      client.send(encode(RESULT, 'boo', 27))
    }).on('close', function() {
      done()
    })
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
})
