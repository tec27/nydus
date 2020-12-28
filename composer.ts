import { Map } from 'immutable'

const noop: NextFunc = async () => {}

export type NextFunc = (data: Map<string, any>) => Promise<unknown>

export type ComposableFunc = (data: Map<string, any>, next: NextFunc) => Promise<unknown>

export default function compose(fns: ComposableFunc[]): NextFunc {
  let next = noop
  let i = fns.length
  while (i--) {
    const fn = fns[i]
    const curNext = next
    next = data => fn(data, curNext)
  }

  return async (data: Map<any, any>) => next(data)
}
