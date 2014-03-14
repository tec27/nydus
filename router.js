var Router = require('routes')

module.exports = function() {
  return new NydusRouter()
}

function NydusRouter() {
  this._callRouter = new Router()
  this._subRouter = new Router()
}

NydusRouter.prototype.call = function(path, fn) {
  this._callRouter.addRoute(path, fn)
  return this
}

NydusRouter.prototype.subscribe = function(path, fn) {
  this._subRouter.addRoute(path, fn)
  return this
}

NydusRouter.prototype.matchCall = function(path) {
  return this._callRouter.match(path)
}

NydusRouter.prototype.matchSubscribe = function(path) {
  return this._subRouter.match(path)
}