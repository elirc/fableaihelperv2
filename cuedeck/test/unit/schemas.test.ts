import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import {
  historyListQuerySchema,
  profileSchema,
  publicSettingsPatchSchema,
  publicSettingsSchema,
  secretsSetSchema,
  sessionIdSchema,
  sessionOptionsSchema,
  sessionRegenerateSchema,
  sessionSubmitMetaSchema,
  targetSecondsSchema,
} from '../../src/shared/schemas';

describe('publicSettingsSchema', () => {
  it('accepts the defaults', () => {
    expect(publicSettingsSchema.parse(DEFAULT_SETTINGS)).toBeTruthy();
  });

  it('rejects out-of-range font scale and clip length', () => {
    expect(publicSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, fontScale: 3 }).success).toBe(
      false,
    );
    expect(
      publicSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, maxClipSeconds: 500 }).success,
    ).toBe(false);
  });

  it('accepts the boundary values for font scale and clip length', () => {
    expect(
      publicSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, fontScale: 0.9, maxClipSeconds: 30 })
        .success,
    ).toBe(true);
    expect(
      publicSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, fontScale: 1.6, maxClipSeconds: 120 })
        .success,
    ).toBe(true);
  });

  it('rejects retention periods outside the fixed set', () => {
    expect(
      publicSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, historyRetentionDays: 14 }).success,
    ).toBe(false);
  });

  it('rejects a non-URL Ollama base URL', () => {
    expect(
      publicSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, ollamaBaseUrl: 'not a url' }).success,
    ).toBe(false);
  });

  it('requires autoStopOnSilence to be a boolean', () => {
    expect(
      publicSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, autoStopOnSilence: 'yes' }).success,
    ).toBe(false);
    expect(
      publicSettingsSchema.safeParse({ ...DEFAULT_SETTINGS, autoStopOnSilence: false }).success,
    ).toBe(true);
  });
});

describe('targetSecondsSchema', () => {
  it('accepts only the fixed choices', () => {
    expect(targetSecondsSchema.safeParse(15).success).toBe(true);
    expect(targetSecondsSchema.safeParse(30).success).toBe(true);
    expect(targetSecondsSchema.safeParse(60).success).toBe(true);
    expect(targetSecondsSchema.safeParse(45).success).toBe(false);
    expect(targetSecondsSchema.safeParse('30').success).toBe(false);
  });
});

describe('publicSettingsPatchSchema', () => {
  it('rejects attempts to write credential flags from the renderer', () => {
    const result = publicSettingsPatchSchema.safeParse({
      credentials: { groq: { configured: true } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown fields', () => {
    expect(publicSettingsPatchSchema.safeParse({ apiKey: 'x' }).success).toBe(false);
  });

  it('accepts a valid partial patch', () => {
    expect(publicSettingsPatchSchema.parse({ alwaysOnTop: true, targetSeconds: 60 })).toEqual({
      alwaysOnTop: true,
      targetSeconds: 60,
    });
  });

  it('accepts the auto-stop toggle as a patch from the renderer', () => {
    expect(publicSettingsPatchSchema.parse({ autoStopOnSilence: false })).toEqual({
      autoStopOnSilence: false,
    });
  });

  it('rejects attempts to change the schema version from the renderer', () => {
    expect(publicSettingsPatchSchema.safeParse({ schemaVersion: 99 }).success).toBe(false);
  });
});

describe('sessionIdSchema', () => {
  it('accepts UUIDs and rejects arbitrary strings', () => {
    expect(sessionIdSchema.safeParse('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee').success).toBe(true);
    expect(sessionIdSchema.safeParse('../../../etc/passwd').success).toBe(false);
    expect(sessionIdSchema.safeParse('').success).toBe(false);
  });
});

describe('sessionSubmitMetaSchema', () => {
  it('validates options and bounds', () => {
    const meta = {
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      options: { answerMode: 'star', targetSeconds: 30 },
      encodeMs: 12,
    };
    expect(sessionSubmitMetaSchema.parse(meta).options.answerMode).toBe('star');
    expect(
      sessionSubmitMetaSchema.safeParse({
        ...meta,
        options: { answerMode: 'haiku', targetSeconds: 30 },
      }).success,
    ).toBe(false);
  });

  it('rejects negative or absurd encode times', () => {
    const meta = {
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      options: { answerMode: 'natural', targetSeconds: 30 },
    };
    expect(sessionSubmitMetaSchema.safeParse({ ...meta, encodeMs: -1 }).success).toBe(false);
    expect(sessionSubmitMetaSchema.safeParse({ ...meta, encodeMs: 600_001 }).success).toBe(false);
  });
});

describe('sessionOptionsSchema', () => {
  it('caps session notes at 4000 characters', () => {
    const base = { answerMode: 'natural', targetSeconds: 30 } as const;
    expect(
      sessionOptionsSchema.safeParse({ ...base, sessionNotes: 'x'.repeat(4_000) }).success,
    ).toBe(true);
    expect(
      sessionOptionsSchema.safeParse({ ...base, sessionNotes: 'x'.repeat(4_001) }).success,
    ).toBe(false);
  });
});

describe('sessionRegenerateSchema', () => {
  it('bounds the edited transcript', () => {
    const base = {
      sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      options: { answerMode: 'natural', targetSeconds: 30 },
    };
    expect(
      sessionRegenerateSchema.safeParse({ ...base, transcript: 'x'.repeat(40_000) }).success,
    ).toBe(true);
    expect(
      sessionRegenerateSchema.safeParse({ ...base, transcript: 'x'.repeat(40_001) }).success,
    ).toBe(false);
    expect(sessionRegenerateSchema.safeParse({ ...base, transcript: '' }).success).toBe(false);
  });
});

describe('profileSchema', () => {
  const validProfile = {
    id: 'p1',
    name: 'Interview prep',
    summary: 'Engineer.',
    roleContext: '',
    emphasisNotes: '',
    createdAt: '2026-07-16T00:00:00.000Z',
    updatedAt: '2026-07-16T00:00:00.000Z',
  };

  it('accepts field lengths at the documented maxima', () => {
    expect(
      profileSchema.safeParse({
        ...validProfile,
        summary: 'x'.repeat(20_000),
        roleContext: 'x'.repeat(20_000),
        emphasisNotes: 'x'.repeat(8_000),
      }).success,
    ).toBe(true);
  });

  it('rejects fields one character over the maxima', () => {
    expect(profileSchema.safeParse({ ...validProfile, summary: 'x'.repeat(20_001) }).success).toBe(
      false,
    );
    expect(
      profileSchema.safeParse({ ...validProfile, emphasisNotes: 'x'.repeat(8_001) }).success,
    ).toBe(false);
    expect(profileSchema.safeParse({ ...validProfile, name: '' }).success).toBe(false);
  });
});

describe('secretsSetSchema', () => {
  it('bounds the credential value', () => {
    expect(
      secretsSetSchema.safeParse({ providerId: 'groq', value: 'k'.repeat(4_096) }).success,
    ).toBe(true);
    expect(
      secretsSetSchema.safeParse({ providerId: 'groq', value: 'k'.repeat(4_097) }).success,
    ).toBe(false);
    expect(secretsSetSchema.safeParse({ providerId: 'groq', value: '' }).success).toBe(false);
    expect(secretsSetSchema.safeParse({ providerId: '', value: 'key' }).success).toBe(false);
  });
});

describe('historyListQuerySchema', () => {
  it('defaults the limit and enforces its range', () => {
    expect(historyListQuerySchema.parse({}).limit).toBe(100);
    expect(historyListQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(historyListQuerySchema.safeParse({ limit: 501 }).success).toBe(false);
    expect(historyListQuerySchema.safeParse({ limit: 2.5 }).success).toBe(false);
  });
});
