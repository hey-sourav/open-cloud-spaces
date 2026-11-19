import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  target: 'es2022',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  // This dependency is ESM-only; bundle it for the CommonJS entry point too.
  noExternal: ['@nodable/entities'],
});
