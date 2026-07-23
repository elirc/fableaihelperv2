import { _electron as electron, type ElectronApplication } from '@playwright/test';
import http from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface LaunchOptions {
  seedSettings?: Record<string, unknown>;
}

export async function launchApp(options: LaunchOptions = {}): Promise<{
  app: ElectronApplication;
  userData: string;
}> {
  const userData = mkdtempSync(path.join(os.tmpdir(), 'cuedeck-e2e-'));
  mkdirSync(userData, { recursive: true });
  if (options.seedSettings) {
    writeFileSync(
      path.join(userData, 'settings.json'),
      JSON.stringify({ schemaVersion: 1, ...options.seedSettings }, null, 2),
    );
  }
  // VS Code terminals export ELECTRON_RUN_AS_NODE=1; if it leaks into the
  // child, electron.exe boots as plain Node and rejects Playwright's
  // --remote-debugging-port flag with "bad option".
  const env = { ...process.env, CUEDECK_USER_DATA: userData } as Record<string, string>;
  delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({
    args: ['.vite/build/main.js'],
    cwd: path.resolve(__dirname, '../..'),
    env,
  });
  return { app, userData };
}

export const READY_SETTINGS = {
  onboardingComplete: true,
  consentAcknowledgedAt: '2026-07-10T00:00:00.000Z',
  llmModelId: 'fake-model',
};

/** Minimal fake Ollama server driven from the test process. */
export async function startFakeOllama(behavior: { deltas: string[]; delayMs?: number }): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
  chatCalls: () => number;
  /** Raw /api/chat request bodies, for asserting what the app sent. */
  chatBodies: () => string[];
}> {
  let chatCalls = 0;
  const chatBodies: string[] = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ models: [{ name: 'fake-model', size: 1 }] }));
      return;
    }
    if (req.url === '/api/chat') {
      chatCalls += 1;
      const bodyChunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => bodyChunks.push(chunk));
      req.on('end', () => chatBodies.push(Buffer.concat(bodyChunks).toString('utf8')));
      res.setHeader('content-type', 'application/x-ndjson');
      void (async () => {
        for (const [i, delta] of behavior.deltas.entries()) {
          const done = i === behavior.deltas.length - 1;
          res.write(`${JSON.stringify({ message: { content: delta }, done })}\n`);
          if (behavior.delayMs)
            await new Promise((resolve) => setTimeout(resolve, behavior.delayMs));
        }
        res.end();
      })();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    chatCalls: () => chatCalls,
    chatBodies: () => [...chatBodies],
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
