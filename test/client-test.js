import chai, { expect } from 'chai'
import chaiAsPromised from 'chai-as-promised'
import http from 'http'

import nydus from '../'
import client from '../client'

chai.use(chaiAsPromised)

async function helloHandler(data, next) {
  return 'hi'
}

async function errorMeHandler(data, next) {
  const err = new Error('Ya done goofed')
  err.status = 420
  throw err
}

describe('client', () => {
  let httpServer
  let nydusServer
  let port

  beforeEach(async () => {
    httpServer = http.createServer()
    nydusServer = nydus(httpServer)
    nydusServer.registerRoute('/hello', helloHandler)
    nydusServer.registerRoute('/errorMe', errorMeHandler)

    port = await new Promise((resolve, reject) => {
      httpServer.listen(0, function(err) {
        if (err) return reject(err)
        resolve(httpServer.address().port)
      })
    })
  })

  afterEach(() => {
    nydusServer.close()
    httpServer.close()
  })

  async function connectClient(fn) {
    const c = client('ws://localhost:' + port)
    if (fn) fn(c)
    const p = new Promise((resolve, reject) => {
      c.once('connect', () => resolve(c))
        .once('error', () => reject(c))
    })
    c.connect()
    return await p
  }

  it('should connect to a server', async () => {
    return await connectClient()
  })

  it('should disconnect from a server', async () => {
    const sDisc = new Promise(resolve => {
      nydusServer.on('connection', c => {
        c.on('close', () => resolve())
      })
    })
    const c = await connectClient()
    const cDisc = new Promise(resolve => c.on('disconnect', () => resolve()))

    c.disconnect()
    return await Promise.all([sDisc, cDisc])
  })

  it('should support INVOKEing server methods', async () => {
    const c = await connectClient()

    const response = await c.invoke('/hello')
    expect(response).to.be.eql('hi')
  })

  it('should support errors from INVOKE', async() => {
    const c = await connectClient()

    let result
    try {
      await c.invoke('/errorMe')
      result = 'where\'s my exception?'
    } catch (err) {
      result = err
    }
    expect(result).to.be.eql({ status: 420, message: 'Ya done goofed' })
  })
})
