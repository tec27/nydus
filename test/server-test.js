import { expect } from 'chai'
import http from 'http'
import eio from 'engine.io-client'
import { decode, WELCOME, INVOKE } from '../protocol'

import nydus, { NydusServer } from '../'

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
})
