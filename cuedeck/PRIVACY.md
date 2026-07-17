# CueDeck privacy model

## Principles

1. **Local by default.** In local mode (the recommended default), audio, transcripts, profiles,
   and responses never leave this computer. There is no account, hosted backend, or telemetry.
2. **Recording is always visible.** Capture starts only from an explicit user action, a
   recording indicator is shown for the entire capture period (including compact mode), and the
   app has no feature to hide itself from screen sharing or recording — by design, permanently.
3. **You own consent.** You are responsible for obtaining participant consent and following the
   laws and rules that apply to your calls, interviews, and jurisdiction. The first-run flow
   requires acknowledging this before the app can be used.

## What is stored, where

All app data lives in the per-user application-data folder `%APPDATA%\CueDeck\` (Electron's
`userData` directory). Every file below is plain JSON unless noted otherwise.

| Data                            | File / location                                                                                                                                                                                                                                                                                                                                                                                 | Default                                                                                                                                                                     |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public settings                 | `settings.json` — theme, provider choices, window options. When you save an API key, this file records only a `configured: true` flag for that provider — never the key itself (`src/main/settings/publicStore.ts`).                                                                                                                                                                            | created on first run                                                                                                                                                        |
| Cloud API keys (optional)       | `secrets.json` — each key is encrypted with Windows **DPAPI** (the OS's per-user Data Protection API) via Electron `safeStorage`, and stored as base64 ciphertext plus a timestamp. Keys are **write-only from the UI**: after entry, no code path returns them to the interface — only provider adapters in the privileged main process can decrypt them (`src/main/settings/secretVault.ts`). | none                                                                                                                                                                        |
| Profiles (your background text) | `profiles.json` — plain text you wrote (summary, role context, emphasis notes)                                                                                                                                                                                                                                                                                                                  | empty                                                                                                                                                                       |
| History (transcript + response) | `history.json` — transcript, generated answer, provider/model IDs, and timing numbers. No audio field exists in the schema.                                                                                                                                                                                                                                                                     | **off**; retention 1 / 7 (default) / 30 days, or session-only (with session-only retention nothing is persisted to disk); per-item delete, delete-all, JSON/Markdown export |
| Local STT models                | `models\` — Whisper model files plus `manifest.json` recording each model's ID, install time, and file sizes                                                                                                                                                                                                                                                                                    | downloaded only when you ask                                                                                                                                                |
| Raw audio                       | **never written to disk**; capture buffers are released after transcription                                                                                                                                                                                                                                                                                                                     | —                                                                                                                                                                           |

## What leaves this computer, and when

The privileged process enforces a hardcoded outbound host allowlist
(`src/main/security/http.ts`): any request to a host not listed below (or to the local
machine) is refused before a network connection opens.

**In local mode**, the only network traffic is:

- **Ollama on loopback** (`http://127.0.0.1:11434` by default) — your transcript, active
  profile, and session notes go to the Ollama server running on your own machine.
- **Model downloads you initiate** — fetching a Whisper model contacts Hugging Face
  (`huggingface.co`, `cdn-lfs.huggingface.co`, `cdn-lfs-us-1.huggingface.co`,
  `cas-bridge.xethub.hf.co`). Only the download request goes out; none of your content is sent.

**Cloud providers are optional and opt-in.** Each is labeled _free tier; limits may change_
and shows its data-use disclosure and privacy-policy link before you enable it. When selected:

- **Cloud speech-to-text** (`api.groq.com` or `generativelanguage.googleapis.com`) receives the
  current audio clip, your language setting, and the model ID — nothing else.
- **Cloud text generation** (`api.groq.com`, `generativelanguage.googleapis.com`, or
  `openrouter.ai`) receives the current transcript, your active profile (summary, role
  context, emphasis notes), your session notes, and the answer-mode instructions.
- Your API key for that provider is sent in a request header, as required to authenticate.

Never sent: history, inactive profiles, screen contents, keystrokes, or anything while you are
not in an active session. The app never falls back from local to cloud silently — the provider
you picked is the provider that runs. Gemini free-tier note: per Google's published pricing
terms, free-tier content may be used to improve Google products. OpenRouter free models route
to third-party hosts chosen by OpenRouter.

## Diagnostics

The diagnostics page shows app/OS/provider status and the 20 most recent errors. Error
messages are kept in memory only (never written to disk), truncated, and passed through a
secret-redaction filter before they are stored. Exports exclude transcripts and profile text
unless you explicitly tick those options, and the entire export text passes the redaction
filter again on the way out (`src/shared/redact.ts`, `src/main/diagnostics.ts`).

## Permitted use

CueDeck describes live use as **disclosed assistance only**. Interview features are framed as
rehearsal unless assistance is explicitly permitted by the other party. The app must not be
used in proctored or evaluated settings that prohibit outside help, and generated responses are
instructed never to invent qualifications, employment, achievements, or personal experience.
