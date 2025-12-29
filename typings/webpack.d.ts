// Dependency of unplugin but we never use it, just make the compiler happy
declare module 'webpack' {
  export type Compilation = any
  export type Compiler = any
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  export type LoaderContext<T> = any
  export type WebpackPluginInstance = any
}
