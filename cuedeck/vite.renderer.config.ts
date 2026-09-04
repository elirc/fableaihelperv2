import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { CSP_META_POLICY } from './src/shared/csp';

/**
 * Production builds load index.html over file://, where Chromium ignores the
 * CSP header the main process injects, so the policy is stamped into the
 * document itself. The dev server keeps the header path (Vite's client needs
 * the looser dev policy, and headers work over http).
 */
function cspMetaTag(): Plugin {
  return {
    name: 'cuedeck-csp-meta',
    apply: 'build',
    transformIndexHtml() {
      return [
        {
          tag: 'meta',
          attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP_META_POLICY },
          injectTo: 'head-prepend',
        },
      ];
    },
  };
}

export default defineConfig({
  plugins: [react(), cspMetaTag()],
  base: './',
  build: {
    outDir: '.vite/renderer/main_window',
    emptyOutDir: true,
    sourcemap: true,
  },
});
