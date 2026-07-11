import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  timeout: 60_000,
  // Electron apps share a single user-data dir per launch; keep runs serial.
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
  },
});
