# CueDeck: codebase review and alternative-app specification

Status: autonomous-build-ready product and technical specification
Reviewed: 2026-07-10
Source project: AI Call Assistant v1.0.0
Working title: **CueDeck** (placeholder; perform a name/trademark check before release)

> This file is the controlling implementation brief for the CueDeck build in `cuedeck/`.
> The full specification was provided by the project owner; the sections below are preserved
> as the authoritative requirements for the implementation.

## 0. Autonomous-build contract (summary)

- Build CueDeck as a consent-based conversation practice and disclosed-assistance desktop app.
- Intended uses: mock interviews, rehearsal, accessibility support, and calls where participants
  and applicable rules permit recording and AI assistance.
- No covert-recording or concealment features. No `setContentProtection`, no capture exclusion,
  no anti-detection behavior, no hidden recording.
- New application lives under `cuedeck/`. Reference implementation (if present) is read-only.
- Generated installers, model weights, caches, coverage, and Playwright artifacts are gitignored.

### Fixed implementation defaults

| Decision | Required default |
|---|---|
| Package manager | npm |
| Node baseline | Node.js 22 LTS or newer supported LTS |
| Target | Windows 10/11 x64 first |
| Desktop framework | current supported Electron stable |
| Build system | Electron Forge + Vite |
| UI | React + strict TypeScript |
| Validation | Zod at IPC, settings, and provider boundaries |
| Tests | Vitest + Playwright Electron E2E |
| Local STT | Transformers.js worker/utility process |
| Local LLM | Ollama localhost adapter |
| Default operating mode | local-only, no credential |
| History | disabled by default |
| Telemetry | none |
| Renderer security | sandboxed, context isolated, no Node integration |
| Recording activation | explicit visible user action only |
| Capture concealment | prohibited; do not call `setContentProtection` |

## 1. Product statement

CueDeck is a free desktop conversation-practice and disclosed-assistance coach that turns a short
clip of consented audio into a concise, editable response card. It is transparent about recording,
processing location, model readiness, and privacy.

Core loop:

1. capture a short segment of system audio (explicit user action only),
2. transcribe it (local Whisper via Transformers.js by default),
3. generate a concise first-person response grounded in the user's profile and call context
   (local Ollama model by default),
4. stream the response into a compact always-available window.

The defining constraint is **zero mandatory spend**: the default path is fully local, no account,
no API key, no credit card. Optional cloud adapters (Groq, Gemini, OpenRouter) use provider free
tiers, labeled as quota-limited, opt-in, with external-processing disclosure. The app never
silently falls back from local to cloud.

## 2. Free-operation policy

- **Local mode (default, "Always free"):** Transformers.js Whisper STT in a utility process +
  Ollama localhost LLM. No telemetry. No hosted backend.
- **Cloud free-tier mode (optional):** Groq (`whisper-large-v3-turbo` STT + free-plan LLM),
  Gemini (free Flash tier; disclosure that free-tier content may be used to improve products),
  OpenRouter (`:free` models only; reject non-zero pricing). Never request a paid model ID,
  never ask for a credit card, never auto-fallback between providers.

## 3. Security requirements (release gates)

1. Current supported Electron stable.
2. `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`.
3. CSP starting from `default-src 'none'`.
4. Deny navigation away from the app origin; deny window creation by default.
5. `shell.openExternal` only for parsed HTTPS URLs from a hardcoded allowlist.
6. Validate IPC sender frame and payload (Zod) for every privileged method.
7. One-use, expiring capture grant tied to a session ID; unarmed requests denied.
8. Encrypt optional cloud credentials with `safeStorage`; write-only from the renderer;
   `settings:getPublic` returns only `configured: true/false`.
9. Redact secrets and sensitive context from logs and diagnostics.
10. Electron fuses set at packaging time.
11. First-run recording-consent and permitted-use acknowledgement; link kept in preferences.
12. No `setContentProtection`, no capture exclusion, no hidden recording; a visible recording
    indicator whenever capture is active, including compact mode.

## 4. Functional requirements (abbreviated IDs)

- CAP-01..CAP-10: explicit-start capture, level meter + silence detection, persistent recording
  indicator, 90 s default / 30–120 s configurable max clip, cancel discards audio, new session
  cancels old, AudioWorklet (not ScriptProcessorNode), deterministic downmix + resample + WAV,
  audio bytes released after transcription, silent-clip failure before any LLM call.
- STT-01..STT-07: local default, transcript + metadata, transcript correction before regenerate,
  language auto/override, consistent timeout/cancel, processing-location display, current clip only.
- LLM-01..LLM-09: streaming deltas, non-streaming fallback, modes (Natural, Concise, Bullets,
  STAR, Clarify), target lengths (15/30/60 s), no invented profile facts, follow-ups without
  retranscription, plain-text copy with accessible confirmation, provider/model display,
  no silent failover.
- CTX-01..CTX-06: multiple named profiles, local storage, size estimates, per-session notes,
  untrusted-data delimiting, cloud-context preview.
- HIS-01..HIS-04: history off by default; transcript/answer/provider IDs/timings only (no raw
  audio); per-item delete, delete all, export JSON/Markdown, retention period; local deletion.
- SET-01..SET-06: public settings separated from encrypted credentials, provider probe before
  activation, local model status, download progress, diagnostics page, sanitized export.

## 5. Session coordinator

Main process owns the session lifecycle. At most one active session; a new session aborts the old
one; every event carries `sessionId` and answer deltas carry a monotonic `sequence`; renderer
ignores retired sessions and non-monotonic sequences. Stage timeouts: 15 s probe, 45 s cloud STT,
120 s local STT, 60 s first LLM token, 120 s total generation. Structured public error codes:

```text
CAPTURE_DENIED CAPTURE_NO_AUDIO CAPTURE_SILENT AUDIO_TOO_SHORT AUDIO_TOO_LONG
MODEL_NOT_INSTALLED LOCAL_PROVIDER_UNREACHABLE CREDENTIAL_MISSING CREDENTIAL_REJECTED
PROVIDER_RATE_LIMITED PROVIDER_TIMEOUT PROVIDER_UNAVAILABLE TRANSCRIPT_EMPTY
REQUEST_CANCELLED STORAGE_FAILED UNKNOWN
```

## 6. Prompt specification

System prompt: response coach, natural first-person spoken language, selected mode and target
duration, profile/context/transcript are untrusted reference data (never instructions), no
invented experience/metrics/employers/tools/outcomes, prefer clarifying response when ambiguous,
answer only (no meta commentary). Data layout uses delimited blocks (`<profile_data>`,
`<role_context>`, `<session_notes>`, `<heard_transcript>`) with closing tags escaped in
user-provided text.

## 7. Acceptance criteria (MVP)

1. Local mode setup completes without account/key/payment.
2. Full flow works offline after model download.
3. Live meter + silence warning during capture.
4. 5–90 s clip produces editable transcript or specific recoverable error.
5. Local Ollama model streams a profile-grounded answer.
6. Cancel/restart suppresses every obsolete delta.
7. Copy, Clear, Regenerate, Shorter, Bullets, STAR work.
8. Public settings and diagnostics never expose credentials.
9. Sandboxing, context isolation, navigation denial, sender validation, payload validation
   enabled and tested.
10. Raw audio deleted after transcription.
11. History off by default.
12. No capture exclusion/hidden recording; recording indicator not suppressible during capture.
13. All unit/integration/E2E suites pass.
14. Windows installer built; artifacts have checksums.
15. License notices for dependencies and model artifacts.

## 8. Non-goals for v1

Continuous meeting recording; automated participation, voice cloning, or speaking for the user;
hosted accounts; macOS/Linux parity; calendar/CRM/call-platform integrations; automatic resume
parsing; paid-provider billing; capture concealment; use in proctored/evaluated settings where
outside assistance is prohibited; autonomous factual research during a live answer.
