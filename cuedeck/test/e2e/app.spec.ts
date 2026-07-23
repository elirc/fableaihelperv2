import { expect, test } from '@playwright/test';
import { launchApp, READY_SETTINGS, startFakeOllama } from './helpers';

test.describe('first run', () => {
  test('opens onboarding with a required consent acknowledgement', async () => {
    const { app } = await launchApp();
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('onboarding-consent')).toBeVisible();
      // Continue is gated on the acknowledgement checkbox.
      await expect(page.getByTestId('consent-continue')).toBeDisabled();
      await page.getByTestId('consent-checkbox').check();
      await expect(page.getByTestId('consent-continue')).toBeEnabled();
      await page.getByTestId('consent-continue').click();
      await expect(page.getByTestId('onboarding-mode')).toBeVisible();
      // The recommended local path never shows an API-key field.
      await page.getByTestId('choose-local').click();
      await expect(page.getByTestId('onboarding-local-setup')).toBeVisible();
      await expect(page.locator('input[type="password"]')).toHaveCount(0);
    } finally {
      await app.close();
    }
  });
});

test.describe('renderer security', () => {
  test('renderer is sandboxed with no Node or raw IPC access', async () => {
    const { app } = await launchApp({ seedSettings: READY_SETTINGS });
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('listen-button')).toBeVisible();
      const surface = await page.evaluate(() => ({
        hasRequire: typeof (window as never as Record<string, unknown>).require !== 'undefined',
        hasProcess: typeof (window as never as Record<string, unknown>).process !== 'undefined',
        hasIpcRenderer: 'ipcRenderer' in window,
        hasCueDeck: typeof (window as never as { cuedeck?: unknown }).cuedeck === 'object',
        cuedeckKeys: Object.keys((window as never as { cuedeck: object }).cuedeck),
      }));
      expect(surface.hasRequire).toBe(false);
      expect(surface.hasProcess).toBe(false);
      expect(surface.hasIpcRenderer).toBe(false);
      expect(surface.hasCueDeck).toBe(true);
      // Only the fixed API, no generic invoke/send.
      expect(surface.cuedeckKeys).not.toContain('invoke');
      expect(surface.cuedeckKeys).not.toContain('send');
    } finally {
      await app.close();
    }
  });

  test('window.open and external navigation are denied', async () => {
    const { app } = await launchApp({ seedSettings: READY_SETTINGS });
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('listen-button')).toBeVisible();
      const before = page.url();
      const opened = await page.evaluate(() => window.open('https://example.com') !== null);
      expect(opened).toBe(false);
      await page
        .evaluate(() => {
          window.location.href = 'https://example.com/';
        })
        .catch(() => undefined);
      await page.waitForTimeout(500);
      expect(page.url()).toBe(before);
      expect(app.windows().length).toBe(1);
    } finally {
      await app.close();
    }
  });

  test('getDisplayMedia without an armed grant is denied', async () => {
    const { app } = await launchApp({ seedSettings: READY_SETTINGS });
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('listen-button')).toBeVisible();
      const result = await page.evaluate(async () => {
        try {
          const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
          stream.getTracks().forEach((t) => t.stop());
          return 'granted';
        } catch (err) {
          return (err as Error).name;
        }
      });
      expect(result).not.toBe('granted');
    } finally {
      await app.close();
    }
  });

  test('saved credentials never appear in public settings', async () => {
    const { app } = await launchApp({ seedSettings: READY_SETTINGS });
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('listen-button')).toBeVisible();
      const settingsJson = await page.evaluate(async () => {
        const cuedeck = (
          window as never as {
            cuedeck: {
              setSecret: (p: string, v: string) => Promise<unknown>;
              getPublicSettings: () => Promise<unknown>;
            };
          }
        ).cuedeck;
        await cuedeck.setSecret('groq', 'gsk_e2e_super_secret_value_123');
        return JSON.stringify(await cuedeck.getPublicSettings());
      });
      expect(settingsJson).not.toContain('gsk_e2e_super_secret_value_123');
      expect(JSON.parse(settingsJson).credentials.groq).toEqual({ configured: true });
    } finally {
      await app.close();
    }
  });
});

test.describe('coach workflow', () => {
  test('preferences opens as a separate window', async () => {
    const { app } = await launchApp({ seedSettings: READY_SETTINGS });
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('open-preferences')).toBeVisible();
      const [prefsWindow] = await Promise.all([
        app.waitForEvent('window'),
        page.getByTestId('open-preferences').click(),
      ]);
      await expect(prefsWindow.getByTestId('nav-providers')).toBeVisible();
      expect(app.windows().length).toBe(2);
      // Coach window is still interactive underneath.
      await expect(page.getByTestId('listen-button')).toBeVisible();
    } finally {
      await app.close();
    }
  });

  test('transcript edit streams a response from the local model server', async () => {
    const ollama = await startFakeOllama({ deltas: ['I would ', 'say this ', 'clearly.'] });
    const { app } = await launchApp({
      seedSettings: { ...READY_SETTINGS, ollamaBaseUrl: ollama.baseUrl },
    });
    try {
      const page = await app.firstWindow();
      await page.getByTestId('transcript-input').fill('Tell me about your background.');
      await page.getByTestId('regenerate-button').click();
      await expect(page.getByTestId('answer-text')).toContainText('I would say this clearly.', {
        timeout: 15_000,
      });
      // Status rail shows the provider/model actually used.
      await expect(page.getByTestId('status-rail')).toContainText('ollama');
      // Copy puts plain text on the clipboard and confirms.
      await page.getByTestId('copy-button').click();
      await expect(page.getByTestId('copy-button')).toContainText('Copied');
      // Clear resets the card.
      await page.getByTestId('clear-button').click();
      await expect(page.getByTestId('answer-text')).not.toContainText('clearly');
    } finally {
      await app.close();
      await ollama.close();
    }
  });

  test('cancel stops a slow generation and suppresses late deltas', async () => {
    const ollama = await startFakeOllama({
      deltas: Array.from({ length: 40 }, (_, i) => `chunk${i} `),
      delayMs: 250,
    });
    const { app } = await launchApp({
      seedSettings: { ...READY_SETTINGS, ollamaBaseUrl: ollama.baseUrl },
    });
    try {
      const page = await app.firstWindow();
      await page.getByTestId('transcript-input').fill('A question that takes a while.');
      await page.getByTestId('regenerate-button').click();
      await expect(page.getByTestId('answer-text')).toContainText('chunk0', { timeout: 15_000 });
      await page.getByTestId('cancel-button').click();
      await expect(page.getByTestId('phase-chip')).toContainText('Ready', { timeout: 10_000 });
      const answerAfterCancel = await page.getByTestId('answer-text').textContent();
      await page.waitForTimeout(1_000);
      const answerLater = await page.getByTestId('answer-text').textContent();
      expect(answerLater).toBe(answerAfterCancel);
    } finally {
      await app.close();
      await ollama.close();
    }
  });

  test('provider failure surfaces a structured, recoverable error', async () => {
    // No server on this port: local provider unreachable.
    const { app } = await launchApp({
      seedSettings: { ...READY_SETTINGS, ollamaBaseUrl: 'http://127.0.0.1:59999' },
    });
    try {
      const page = await app.firstWindow();
      await page.getByTestId('transcript-input').fill('Anything.');
      await page.getByTestId('regenerate-button').click();
      await expect(page.getByTestId('error-banner')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId('error-banner')).toContainText(/Ollama|unavailable|reached/i);
      // Dismiss recovers to ready.
      await page.getByRole('button', { name: 'Dismiss' }).click();
      await expect(page.getByTestId('phase-chip')).toContainText('Ready');
    } finally {
      await app.close();
    }
  });

  test('drawing a practice question fills the transcript and streams an answer with pace stats', async () => {
    const ollama = await startFakeOllama({
      deltas: ['I would focus on ', 'the outcome and ', 'what I learned.'],
    });
    const { app } = await launchApp({
      seedSettings: { ...READY_SETTINGS, ollamaBaseUrl: ollama.baseUrl },
    });
    try {
      const page = await app.firstWindow();
      await page.getByTestId('practice-draw').click();
      const question = await page.getByTestId('transcript-input').inputValue();
      expect(question.length).toBeGreaterThan(10);
      expect(/[?.]$/.test(question)).toBe(true);
      await expect(page.getByTestId('practice-progress')).toContainText('1 of');
      // A drawn question flows through the normal respond pipeline.
      await page.getByTestId('regenerate-button').click();
      await expect(page.getByTestId('answer-text')).toContainText('what I learned.', {
        timeout: 15_000,
      });
      // The finished answer shows the speaking-pace estimate.
      await expect(page.getByTestId('answer-stats')).toContainText('words');
      await expect(page.getByTestId('answer-stats')).toContainText('s target');
    } finally {
      await app.close();
      await ollama.close();
    }
  });

  test('session notes are sent to the model server inside the fenced block', async () => {
    const ollama = await startFakeOllama({ deltas: ['Noted.'] });
    const { app } = await launchApp({
      seedSettings: { ...READY_SETTINGS, ollamaBaseUrl: ollama.baseUrl },
    });
    try {
      const page = await app.firstWindow();
      await page.getByTestId('session-notes-input').fill('Screening call with Acme for QA lead.');
      await page.getByTestId('transcript-input').fill('Why do you want this job?');
      await page.getByTestId('regenerate-button').click();
      await expect(page.getByTestId('answer-text')).toContainText('Noted.', { timeout: 15_000 });
      const body = ollama.chatBodies()[0];
      expect(body).toContain('<session_notes>');
      expect(body).toContain('Screening call with Acme for QA lead.');
    } finally {
      await app.close();
      await ollama.close();
    }
  });

  test('Escape cancels a slow generation from the keyboard', async () => {
    const ollama = await startFakeOllama({
      deltas: Array.from({ length: 40 }, (_, i) => `chunk${i} `),
      delayMs: 250,
    });
    const { app } = await launchApp({
      seedSettings: { ...READY_SETTINGS, ollamaBaseUrl: ollama.baseUrl },
    });
    try {
      const page = await app.firstWindow();
      await page.getByTestId('transcript-input').fill('A question that takes a while.');
      await page.getByTestId('regenerate-button').click();
      await expect(page.getByTestId('answer-text')).toContainText('chunk0', { timeout: 15_000 });
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('phase-chip')).toContainText('Ready', { timeout: 10_000 });
    } finally {
      await app.close();
      await ollama.close();
    }
  });

  test('compact mode keeps capture controls and status visible', async () => {
    const { app } = await launchApp({ seedSettings: { ...READY_SETTINGS, compactMode: true } });
    try {
      const page = await app.firstWindow();
      await expect(page.getByTestId('listen-button')).toBeVisible();
      await expect(page.getByTestId('phase-chip')).toBeVisible();
      // Expand restores the full layout.
      await page.getByRole('button', { name: 'Expand' }).click();
      await expect(page.getByTestId('transcript-input')).toBeVisible();
    } finally {
      await app.close();
    }
  });
});
