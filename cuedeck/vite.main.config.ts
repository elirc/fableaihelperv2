import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// Built by the Forge Vite plugin during start/package/make, and directly by
// `npm run build` (used by the Playwright E2E suite).
export default defineConfig({
  build: {
    lib: {
      entry: 'src/main/main.ts',
      formats: ['cjs'],
      fileName: () => 'main.js',
    },
    outDir: '.vite/build',
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: {
      external: [
        'electron',
        'electron-squirrel-startup',
        '@huggingface/transformers',
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
      ],
    },
  },
});
