import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/shared/constants';
import {
  publicSettingsPatchSchema,
  publicSettingsSchema,
  sessionIdSchema,
  sessionSubmitMetaSchema,
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
});
