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

| Data                            | Location                                                                                                             | Default                                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Public settings                 | `%APPDATA%/cuedeck/settings.json`                                                                                    | created on first run                                                                              |
| Cloud API keys (optional)       | `%APPDATA%/cuedeck/secrets.json`, encrypted with Windows DPAPI (`safeStorage`); never returned to the UI after entry | none                                                                                              |
| Profiles (your background text) | `%APPDATA%/cuedeck/profiles.json`                                                                                    | empty                                                                                             |
| History (transcript + response) | `%APPDATA%/cuedeck/history.json`                                                                                     | **off**; retention 1/7/30 days or session-only; per-item delete, delete-all, JSON/Markdown export |
| Local STT models                | `%APPDATA%/cuedeck/models/`                                                                                          | downloaded on demand                                                                              |
| Raw audio                       | **never stored**; capture buffers are released after transcription                                                   | —                                                                                                 |

## What leaves the device, and only with explicit opt-in

Cloud providers are optional, labeled _free tier; limits may change_, and each shows its
data-use policy before you enable it. When selected, a provider receives only:

- the current audio clip (cloud STT) **or** the current transcript (cloud LLM),
- your active profile, role context, and session notes.

Never sent: history, other profiles, screen contents, keystrokes, or anything while you are not
in an active session. The app never falls back from local to cloud silently. Gemini free-tier
note: per Google's published pricing terms, free-tier content may be used to improve Google
products. OpenRouter free models route to third-party hosts chosen by OpenRouter.

## Diagnostics

The diagnostics page shows app/OS/provider status and recent errors with credentials redacted.
Exports exclude transcripts and profile text unless you explicitly tick those options, and all
export text passes a secret-redaction pass.

## Permitted use

CueDeck describes live use as **disclosed assistance only**. Interview features are framed as
rehearsal unless assistance is explicitly permitted by the other party. The app must not be
used in proctored or evaluated settings that prohibit outside help, and generated responses are
instructed never to invent qualifications, employment, achievements, or personal experience.
