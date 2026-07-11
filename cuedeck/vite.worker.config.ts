import { builtinModules } from 'node:module';
import { defineConfig } from 'vite';

// Local STT utility process. `@huggingface/transformers` stays external and
// is resolved from node_modules at runtime (unpacked native ONNX runtime).
export default defineConfig({
  build: {
    lib: {
      entry: 'src/main/workers/sttWorker.ts',
      formats: ['cjs'],
      fileName: () => 'sttWorker.js',
    },
    outDir: '.vite/build',
    emptyOutDir: false,
    sourcemap: true,
    rollupOptions: {
      external: [
        'electron',
        '@huggingface/transformers',
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
      ],
      output: {
        entryFileNames: 'sttWorker.js',
      },
    },
  },
});
