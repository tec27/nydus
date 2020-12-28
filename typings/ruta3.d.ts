declare module 'ruta3' {
  export interface RouteMatch<T> {
    /** The action passed to `addRoute`. Using a function is recommended. */
    action: T
    /** Fall through to the next route, pass it as the `startAt` parameter to match. */
    next: number
    /** The route passed to `addRoute` as the first argument. */
    route: string
    /** An object containing the values for named parameters in the route. */
    params: Record<string, string>
    /** An array filled with values for wildcard parameters. */
    splats: string[]
  }

  export interface Router<T> {
    /** Add a new route to match against. */
    addRoute(path: string, action: T): void
    /** Find the first matching route. If none match, null will be returned. */
    match(uri: string, startAt?: number): RouteMatch<T> | null
  }

  export default function ruta3<T>(): Router<T>
}
