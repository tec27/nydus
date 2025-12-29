// Dependency of unplugin whose typings seem to have issues, but we never use it ourselves
// anyway
declare module '@rspack/core' {
  export type Compilation = any
  export type Compiler = any
  export type LoaderContext = any
  export type RspackPluginInstance = any
}
