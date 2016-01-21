# nydus

WebSocket server using the [nydus protocol](https://github.com/tec27/nydus-protocol), a simple RPC/PubSub protocol.

[![Build Status](https://img.shields.io/travis/tec27/nydus.svg?style=flat)](https://travis-ci.org/tec27/nydus)
[![NPM](https://img.shields.io/npm/v/nydus.svg?style=flat)](https://www.npmjs.org/package/nydus)

[![NPM](https://nodei.co/npm/nydus.png)](https://nodei.co/npm/nydus/)

## Usage
#### `import nydus from 'nydus'`

<b><code>const nydusServer = nydus(httpServer[, options])</code></b>

Create a nydus server and attach it to a particular `httpServer`. An optional `options` object can
be passed as the second argument.
For the list of acceptable options, check the [constructor method](https://github.com/socketio/engine.io#methods-1) of engine.io.

##API

<b><code>nydusServer.registerRoute(pathPattern, ...handlers)</code></b>

Register one or more handlers to respond to `INVOKE` messages on a path matching the specified
pattern. Handlers are ES7 async functions (and thus return promises when called) of the form:
`async function(data, next)`

Handlers will be composed in order, and are expected to call `next(data, next)` to make execution
continue further down the chain. Data is an immutable map that can be changed before passing it to
the next function, but should present the same API (or ideally, be an ImmutableJS map) for
compatibility with other handlers.

The final resolved value will be sent to the client (as a RESULT if the promise was successfully
resolved, or an ERROR if it was rejected).

<b><code>nydusServer.subscribeClient(client, path[, initialData])</code></b>

Add a subscription to a publish path for a client. Whenever messages are published to that path,
this client will receive a message (until unsubscribed). If `initialData` is specified and the
client was previously not subscribed, this data will be published to the client immediately (but
not to the other subscribed clients).

<b><code>nydusServer.publish(path, data)</code></b>

Publish the given `data` to all of the clients subscribed on the specified `path`.

<b><code>nydusServer.unsubscribeClient(client, path)</code></b>

Remove a client's subscription to a particular path (if it was subscribed).

<b><code>nydusServer.close()</code></b>

Close any open connections and then stop the nydus server.

## License

MIT
