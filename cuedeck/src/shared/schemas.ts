import { z } from 'zod';
import { PUBLIC_ERROR_CODES } from './domain';

export const answerModeSchema = z.enum(['natural', 'concise', 'bullets', 'star', 'clarify']);
export const targetSecondsSchema = z.union([z.literal(15), z.literal(30), z.literal(60)]);
/** Session ids are renderer-generated UUIDs; rejecting anything else keeps
 *  ids safe to use in filenames and log lines. */
export const sessionIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'invalid session id');

export const publicErrorSchema = z.object({
  code: z.enum(PUBLIC_ERROR_CODES),
  message: z.string(),
  retryable: z.boolean(),
  action: z
    .enum(['open-diagnostics', 'replace-key', 'download-model', 'switch-provider'])
    .optional(),
  detail: z.string().optional(),
});

export const publicSettingsSchema = z.object({
  schemaVersion: z.number().int().min(1),
  theme: z.enum(['dark', 'system']),
  alwaysOnTop: z.boolean(),
  compactMode: z.boolean(),
  historyEnabled: z.boolean(),
  historyRetentionDays: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(0)]),
  sttProviderId: z.string().min(1),
  sttModelId: z.string().min(1),
  sttLanguage: z.string().min(1),
  llmProviderId: z.string().min(1),
  llmModelId: z.string(),
  answerMode: answerModeSchema,
  targetSeconds: targetSecondsSchema,
  fontScale: z.number().min(0.9).max(1.6),
  maxClipSeconds: z.number().int().min(30).max(120),
  autoStopOnSilence: z.boolean(),
  activeProfileId: z.string().optional(),
  ollamaBaseUrl: z.string().url(),
  onboardingComplete: z.boolean(),
  consentAcknowledgedAt: z.string().nullable(),
  credentials: z.record(z.string(), z.object({ configured: z.boolean() })),
});

/** Patch accepted from the renderer. Credentials are intentionally excluded:
 *  they are managed only through secrets:set / secrets:remove. */
export const publicSettingsPatchSchema = publicSettingsSchema
  .omit({ schemaVersion: true, credentials: true })
  .partial()
  .strict();

export const profileSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(120),
  summary: z.string().max(20_000),
  roleContext: z.string().max(20_000),
  emphasisNotes: z.string().max(8_000),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const historyItemSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string(),
  transcript: z.string(),
  answer: z.string(),
  sttProviderId: z.string(),
  sttModelId: z.string(),
  llmProviderId: z.string(),
  llmModelId: z.string(),
  answerMode: z.string(),
  timings: z.object({
    encodeMs: z.number(),
    transcribeMs: z.number(),
    firstTokenMs: z.number().optional(),
    totalMs: z.number(),
  }),
});

export const sessionOptionsSchema = z.object({
  answerMode: answerModeSchema,
  targetSeconds: targetSecondsSchema,
  language: z.string().max(16).optional(),
  sessionNotes: z.string().max(4_000).optional(),
});

// ---- IPC request payloads -------------------------------------------------

export const secretsSetSchema = z.object({
  providerId: z.string().min(1).max(64),
  value: z.string().min(1).max(4_096),
});

export const secretsRemoveSchema = z.object({ providerId: z.string().min(1).max(64) });

export const providersProbeSchema = z.object({ providerId: z.string().min(1).max(64) });

export const modelsListSchema = z.object({ providerId: z.string().min(1).max(64) });

export const modelsDownloadSchema = z.object({ modelId: z.string().min(1).max(200) });

export const captureArmSchema = z.object({ sessionId: sessionIdSchema });

/** Bounds for a submitted WAV clip. 16 kHz mono 16-bit for up to 120 s plus
 *  header slack; anything outside is rejected before further parsing. */
export const WAV_MIN_BYTES = 16_044; // >= 0.5 s of 16 kHz mono 16-bit audio
export const WAV_MAX_BYTES = 16_000 * 2 * 120 + 65_536;

export const sessionSubmitMetaSchema = z.object({
  sessionId: sessionIdSchema,
  options: sessionOptionsSchema,
  encodeMs: z.number().min(0).max(600_000),
});

export const sessionRegenerateSchema = z.object({
  sessionId: sessionIdSchema,
  transcript: z.string().min(1).max(40_000),
  options: sessionOptionsSchema,
});

export const sessionCancelSchema = z.object({ sessionId: sessionIdSchema });

export const historyListQuerySchema = z.object({
  limit: z.number().int().min(1).max(500).default(100),
});

export const historyDeleteSchema = z.object({ id: z.string().min(1) });

export const profileSaveSchema = profileSchema
  .omit({ createdAt: true, updatedAt: true })
  .extend({ id: z.string().min(1).max(64).optional() });

export const profileDeleteSchema = z.object({ id: z.string().min(1) });

export const openExternalSchema = z.object({ url: z.string().url() });

export const diagnosticsExportSchema = z.object({
  includeTranscripts: z.boolean().default(false),
  includeProfile: z.boolean().default(false),
});
