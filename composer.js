function noop() {}

export default function compose(fns) {
  let next = noop
  let i = fns.length
  while (i--) {
    const fn = fns[i]
    const curNext = next
    next = function (data) {
      return fn(data, curNext)
    }
  }

  return async function (data) {
    return await next(data)
  }
}
