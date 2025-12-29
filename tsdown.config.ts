import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['index.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  target: false,
  exports: true,
})
