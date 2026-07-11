import type { CueDeckApi } from '../preload/preload';

declare global {
  interface Window {
    cuedeck: CueDeckApi;
  }
}

export {};
