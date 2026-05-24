import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: 'src/index.ts',
  outDir: 'dist',
  format: 'cjs',
  target: 'es2017',
  platform: 'neutral',
  clean: true,
  dts: false,
  minify: false,
});
