import { expect, test } from '@playwright/test';
import { launchApp, READY_SETTINGS, startFakeOllama } from './helpers';

function userPrompt(body: string): string {
  const request = JSON.parse(body) as { messages: Array<{ role: string; content: string }> };
  return request.messages
    .filter((message) => message.role === 'user')
    .map((message) => message.content)
    .join('\n');
}

function answerBodies(server: Awaited<ReturnType<typeof startFakeOllama>>): string[] {
  return server.chatBodies().filter((body) => userPrompt(body).includes('<heard_transcript>'));
}

test('personal instructions and an active background profile persist and reach the response provider', async () => {
  const server = await startFakeOllama({ deltas: ['A concise, targeted response.'] });
  const { app } = await launchApp({
    seedSettings: { ...READY_SETTINGS, ollamaBaseUrl: server.baseUrl },
  });
  try {
    const page = await app.firstWindow();
    await expect(
      page
        .getByRole('group', { name: 'answer mode', exact: true })
        .getByRole('button', { name: 'Concise', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    const [prefs] = await Promise.all([
      app.waitForEvent('window'),
      page.getByTestId('open-profiles').click(),
    ]);
    await expect(prefs.getByTestId('nav-profiles')).toHaveAttribute('aria-current', 'true');
    await prefs
      .getByTestId('system-prompt-input')
      .fill('Use plain language and emphasize backend reliability.');
    await prefs.getByTestId('save-system-prompt').click();
    await expect(prefs.getByTestId('personalization-saved')).toContainText(
      'Personal instructions saved',
    );
    await prefs.getByTestId('new-profile').click();
    await expect(prefs.getByTestId('save-profile')).toBeDisabled();
    await prefs.getByTestId('profile-name').fill('Backend interview');
    await prefs
      .getByTestId('profile-summary')
      .fill('I maintained a PostgreSQL service for a logistics team.');
    await prefs.getByTestId('profile-role-context').fill('Senior backend engineer');
    await prefs.getByTestId('profile-emphasis').fill('Reliability and practical trade-offs');
    await prefs.getByTestId('save-profile').click();
    await expect(prefs.getByTestId('profile-card')).toContainText('active');
    await expect(page.getByTestId('active-profile-label')).toContainText('Backend interview');
    await prefs.reload();
    await expect(prefs.getByTestId('system-prompt-input')).toHaveValue(
      'Use plain language and emphasize backend reliability.',
    );
    await expect(prefs.getByTestId('profile-card')).toContainText('Backend interview');

    await page
      .getByTestId('transcript-input')
      .fill('How do you approach reliable database services?');
    await page.getByTestId('regenerate-button').click();
    await expect(page.getByTestId('phase-chip')).toContainText('Done');
    expect(answerBodies(server)[0]).toContain(
      'Use plain language and emphasize backend reliability.',
    );
    expect(answerBodies(server)[0]).toContain(
      'I maintained a PostgreSQL service for a logistics team.',
    );

    await prefs.getByTestId('system-prompt-input').fill('');
    await prefs.getByTestId('save-system-prompt').click();
    await expect(prefs.getByTestId('personalization-saved')).toContainText(
      'Personal instructions saved',
    );
    await prefs
      .getByTestId('profile-card')
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await expect(page.getByTestId('active-profile-label')).toContainText('Add your background');
    await page.getByTestId('try-again-button').click();
    await expect(page.getByTestId('phase-chip')).toContainText('Done');
    expect(answerBodies(server)[1]).not.toContain(
      'Use plain language and emphasize backend reliability.',
    );
    expect(answerBodies(server)[1]).not.toContain(
      'I maintained a PostgreSQL service for a logistics team.',
    );
  } finally {
    await app.close();
    await server.close();
  }
});

test('depth, examples, and likely follow-ups preserve the original answer with conversation memory off', async () => {
  const original = 'An index speeds up frequent database lookups.';
  const question = 'How do database indexes work?';
  const deltas = [original];
  const server = await startFakeOllama({ deltas, delayMs: 250 });
  const { app } = await launchApp({
    seedSettings: { ...READY_SETTINGS, ollamaBaseUrl: server.baseUrl, conversationMemory: false },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByTestId('go-deeper-button')).toBeDisabled();
    await page.getByTestId('transcript-input').fill(question);
    await page.getByTestId('regenerate-button').click();
    await expect(page.getByTestId('phase-chip')).toContainText('Done');
    await expect(page.getByTestId('answer-text')).toHaveText(original);

    const actions = [
      { id: 'go-deeper-button', intent: 'deeper', text: 'A deeper explanation with trade-offs.' },
      { id: 'show-example-button', intent: 'example', text: 'For example, index the customer ID.' },
      {
        id: 'likely-follow-ups-button',
        intent: 'follow-ups',
        text: 'When would an index slow down writes?',
      },
    ];
    for (const [i, action] of actions.entries()) {
      deltas.splice(0, deltas.length, action.text.slice(0, 8), action.text.slice(8), '');
      await page.getByTestId(action.id).click();
      await expect(page.getByTestId('phase-chip')).toContainText('Generating');
      await expect(page.getByTestId('answer-text')).toHaveText(original);
      await expect(page.getByTestId('show-example-button')).toBeDisabled();
      await expect(page.getByTestId('phase-chip')).toContainText('Done');
      await expect(page.getByTestId('answer-detail-text')).toHaveText(action.text);
      await expect(page.getByTestId('answer-text')).toHaveText(original);
      const body = answerBodies(server)[i + 1];
      expect(body).toContain(question);
      expect(body).toContain('<reference_answer>');
      expect(body).toContain(original);
      expect(body).toContain(`Requested expansion: ${action.intent}`);
      expect(userPrompt(body)).not.toContain('<previous_exchanges>');
      if (i > 0) expect(body).not.toContain(actions[i - 1].text);
    }
    await page.getByTestId('copy-button').click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(original);
    await page.getByTestId('copy-detail-button').click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(actions[2].text);
    await page.getByTestId('clear-button').click();
    await expect(page.getByTestId('answer-detail')).toHaveCount(0);
    await expect(page.getByTestId('answer-text')).toBeEmpty();
    await expect(page.getByTestId('go-deeper-button')).toBeDisabled();
  } finally {
    await app.close();
    await server.close();
  }
});

test('cancelling detail keeps the initial answer retryable and editing clears stale expansion context', async () => {
  const original = 'Start with a clear, short answer.';
  const deltas = [original];
  const server = await startFakeOllama({ deltas, delayMs: 500 });
  const { app } = await launchApp({
    seedSettings: { ...READY_SETTINGS, ollamaBaseUrl: server.baseUrl, conversationMemory: false },
  });
  try {
    const page = await app.firstWindow();
    await page.getByTestId('transcript-input').fill('How should I explain an idea?');
    await page.getByTestId('regenerate-button').click();
    await expect(page.getByTestId('phase-chip')).toContainText('Done');
    deltas.splice(0, deltas.length, 'First, ', 'explain ', 'the main ', 'reason.');
    await page.getByTestId('go-deeper-button').click();
    await expect(page.getByTestId('answer-detail-text')).toContainText('First,');
    await page.getByTestId('cancel-button').click();
    await expect(page.getByTestId('phase-chip')).toContainText('Ready');
    await expect(page.getByTestId('answer-text')).toHaveText(original);
    await expect(page.getByTestId('show-example-button')).toBeEnabled();
    await page.getByTestId('show-example-button').click();
    await expect(page.getByTestId('phase-chip')).toContainText('Done');
    await expect(page.getByTestId('answer-text')).toHaveText(original);
    expect(answerBodies(server)[2]).toContain(original);

    await page.getByTestId('transcript-input').fill('A different question');
    await expect(page.getByTestId('answer-detail')).toHaveCount(0);
    await expect(page.getByTestId('answer-text')).toBeEmpty();
    await expect(page.getByTestId('go-deeper-button')).toBeDisabled();
    await page.getByTestId('regenerate-button').click();
    await expect(page.getByTestId('phase-chip')).toContainText('Done');
    expect(userPrompt(answerBodies(server)[3])).not.toContain('<reference_answer>');
    await expect(page.getByTestId('go-deeper-button')).toBeEnabled();
    await page.getByTestId('transcript-input').fill('An edited initial question');
    await expect(page.getByTestId('go-deeper-button')).toBeDisabled();
  } finally {
    await app.close();
    await server.close();
  }
});
