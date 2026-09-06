import { expect, test } from '@playwright/test';
import { CLOUD_MODELS } from '../../src/shared/catalog';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import { launchApp, READY_SETTINGS, startFakeOllama } from './helpers';

test('provider changes choose compatible speech models and restore usable local settings', async () => {
  const ollama = await startFakeOllama({ deltas: ['Local response.'] });
  const { app } = await launchApp({
    seedSettings: {
      ...READY_SETTINGS,
      ollamaBaseUrl: ollama.baseUrl,
      // Enables the provider options without storing a key or contacting Groq.
      credentials: { groq: { configured: true } },
    },
  });
  try {
    const page = await app.firstWindow();
    const [prefs] = await Promise.all([
      app.waitForEvent('window'),
      page.getByTestId('open-preferences').click(),
    ]);
    await prefs.getByTestId('nav-providers').click();
    const speech = prefs
      .locator('section')
      .filter({ has: prefs.getByRole('heading', { name: 'Speech-to-text', exact: true }) });
    const response = prefs
      .locator('section')
      .filter({ has: prefs.getByRole('heading', { name: 'Response model', exact: true }) });

    for (let round = 0; round < 2; round += 1) {
      await speech.getByRole('combobox').first().selectOption('groq-whisper');
      await expect
        .poll(() =>
          page.evaluate(async () => (await window.cuedeck.getPublicSettings()).sttModelId),
        )
        .toBe(CLOUD_MODELS.groqSttModel);
      await response.getByRole('combobox').first().selectOption('groq');
      if (round === 0) {
        // No saved key means the probe stops locally. The catalog remains
        // available so choosing a response model never requires a live request.
        await response.getByRole('button', { name: 'Check & list models', exact: true }).click();
      }
      await response.getByRole('combobox').nth(1).selectOption(CLOUD_MODELS.groqLlmModel);
      await prefs.getByRole('button', { name: 'Switch everything to local-only' }).click();
      await expect
        .poll(() =>
          page.evaluate(async () => (await window.cuedeck.getPublicSettings()).sttModelId),
        )
        .toBe(DEFAULT_SETTINGS.sttModelId);
      if (round === 0) {
        await response.getByRole('button', { name: 'Check & list models', exact: true }).click();
      }
      await expect(response.getByRole('combobox').nth(1)).toHaveValue('fake-model');
    }
    await prefs.close();
    await page.getByTestId('transcript-input').fill('How would you explain an API?');
    await page.getByTestId('regenerate-button').click();
    await expect(page.getByTestId('answer-text')).toContainText('Local response.');
  } finally {
    await app.close();
    await ollama.close();
  }
});
