import type { ProviderMeta } from './domain';

/**
 * Typed provider catalog. Cloud model IDs live here — never inline in
 * adapters — so a provider-side rename is a one-line release change.
 * Verified against provider documentation on 2026-07-10.
 */

export const PROVIDERS: Record<string, ProviderMeta> = {
  'local-whisper': {
    id: 'local-whisper',
    displayName: 'Local Whisper (Transformers.js)',
    location: 'local',
    freePolicy: 'always-free-local',
    supportsAbort: true,
    kind: 'stt',
  },
  ollama: {
    id: 'ollama',
    displayName: 'Ollama (local)',
    location: 'local',
    freePolicy: 'always-free-local',
    supportsAbort: true,
    kind: 'llm',
  },
  'groq-whisper': {
    id: 'groq-whisper',
    displayName: 'Groq Whisper',
    location: 'cloud',
    freePolicy: 'provider-free-tier',
    supportsAbort: true,
    kind: 'stt',
    credentialId: 'groq',
    dataUseUrl: 'https://groq.com/privacy-policy',
    disclosure:
      'Audio clips are sent to Groq for transcription. Free-tier quotas apply and may change.',
  },
  groq: {
    id: 'groq',
    displayName: 'Groq',
    location: 'cloud',
    freePolicy: 'provider-free-tier',
    supportsAbort: true,
    kind: 'llm',
    dataUseUrl: 'https://groq.com/privacy-policy',
    disclosure:
      'Transcripts, your profile, and session notes are sent to Groq. Free-tier quotas apply and may change.',
  },
  'gemini-audio': {
    id: 'gemini-audio',
    displayName: 'Gemini (audio)',
    location: 'cloud',
    freePolicy: 'provider-free-tier',
    supportsAbort: true,
    kind: 'stt',
    credentialId: 'gemini',
    dataUseUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    disclosure:
      'Audio clips are sent to Google. Content submitted on the Gemini API free tier may be used to improve Google products.',
  },
  gemini: {
    id: 'gemini',
    displayName: 'Gemini',
    location: 'cloud',
    freePolicy: 'provider-free-tier',
    supportsAbort: true,
    kind: 'llm',
    dataUseUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
    disclosure:
      'Transcripts, your profile, and session notes are sent to Google. Content submitted on the Gemini API free tier may be used to improve Google products.',
  },
  cerebras: {
    id: 'cerebras',
    displayName: 'Cerebras (fastest free tier)',
    location: 'cloud',
    freePolicy: 'provider-free-tier',
    supportsAbort: true,
    kind: 'llm',
    dataUseUrl: 'https://www.cerebras.ai/privacy',
    disclosure:
      'Transcripts, your profile, and session notes are sent to Cerebras. Free-tier quotas apply and may change.',
  },
  openrouter: {
    id: 'openrouter',
    displayName: 'OpenRouter (free models)',
    location: 'cloud',
    freePolicy: 'provider-free-tier',
    supportsAbort: true,
    kind: 'llm',
    dataUseUrl: 'https://openrouter.ai/privacy',
    disclosure:
      'Transcripts, your profile, and session notes are routed to third-party model hosts chosen by OpenRouter. Free models have low daily quotas and variable availability.',
  },
};

export interface CatalogModel {
  id: string;
  displayName: string;
  providerId: string;
  /** Approximate download size for local models. */
  sizeBytes?: number;
  license?: string;
}

/** Local Whisper-compatible ONNX models runnable by Transformers.js. */
export const LOCAL_STT_MODELS: CatalogModel[] = [
  {
    id: 'onnx-community/whisper-tiny',
    displayName: 'Whisper Tiny (fastest, ~120 MB)',
    providerId: 'local-whisper',
    sizeBytes: 120_000_000,
    license: 'MIT (OpenAI Whisper weights, ONNX conversion)',
  },
  {
    id: 'onnx-community/whisper-base',
    displayName: 'Whisper Base (recommended, ~200 MB)',
    providerId: 'local-whisper',
    sizeBytes: 200_000_000,
    license: 'MIT (OpenAI Whisper weights, ONNX conversion)',
  },
  {
    id: 'onnx-community/whisper-small',
    displayName: 'Whisper Small (best quality, ~600 MB)',
    providerId: 'local-whisper',
    sizeBytes: 600_000_000,
    license: 'MIT (OpenAI Whisper weights, ONNX conversion)',
  },
];

/** Cloud model IDs, isolated per spec §12. */
export const CLOUD_MODELS = {
  groqSttModel: 'whisper-large-v3-turbo',
  /** 70B is the default: 8B-class models fabricate framework specifics on
   *  technical questions, and Groq's speed keeps 70B well under a second
   *  to first token. The 8B stays available as the fastest fallback. */
  groqLlmModel: 'llama-3.3-70b-versatile',
  groqLlmFastModel: 'llama-3.1-8b-instant',
  geminiModel: 'gemini-2.5-flash',
  cerebrasModel: 'llama-3.3-70b',
  cerebrasFastModel: 'llama3.1-8b',
  openRouterDefaultModel: 'openrouter/free',
} as const;

/**
 * Instruct models suggested in the UI when Ollama has none installed. The
 * 7-8B coder/general models are markedly better on technical interview
 * questions and need ~16 GB RAM; the 3B models fit smaller machines.
 */
export const RECOMMENDED_OLLAMA_MODELS = [
  'qwen2.5-coder:7b-instruct',
  'qwen3:8b',
  'qwen2.5:3b-instruct',
  'llama3.2:3b',
] as const;

/**
 * Vocabulary hint handed to cloud speech-to-text as a decoding bias. Whisper
 * conditions on this text, so domain terms it would otherwise mis-hear
 * ("I innumerable", "link") resolve to the intended spelling. Kept well
 * under Whisper's ~224-token prompt window.
 */
export const STT_TECHNICAL_GLOSSARY =
  'Software engineering interview. Terms: JavaScript, TypeScript, React, Node.js, Next.js, ' +
  'npm, async/await, Promise, closure, event loop, useEffect, useState, Redux, C#, .NET, ' +
  'ASP.NET Core, LINQ, IEnumerable, IQueryable, Entity Framework Core, Task, ValueTask, ' +
  'dependency injection, middleware, NuGet, Blazor, SQL Server, PostgreSQL, Redis, REST API, ' +
  'GraphQL, gRPC, JWT, OAuth, CORS, idempotent, microservices, Kubernetes, Docker, Azure, AWS, ' +
  'CI/CD, unit tests, Big O notation.';
