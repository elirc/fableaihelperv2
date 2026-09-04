import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

export default defineConfig({
  // `public/` holds renderer assets; the lib builds must not copy it too.
  publicDir: false,
  build: {
    lib: {
      entry: 'src/preload/preload.ts',
      formats: ['cjs'],
      fileName: () => 'preload.js',
    },
    outDir: '.vite/build',
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: {
      external: ['electron', ...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
      output: {
        entryFileNames: 'preload.js',
      },
    },
  },
});
