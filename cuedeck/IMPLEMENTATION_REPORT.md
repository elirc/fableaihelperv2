# CueDeck implementation report

Built: 2026-07-10 • Location: `cuedeck/` • Version 0.1.0 • Electron 43.1.0, Node 22, TypeScript 5.9 (strict)

## Verification summary

| Gate                                                                      | Result                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run format:check`                                                    | pass                                                                                                                                                                                               |
| `npm run lint` (ESLint 9 + typescript-eslint 8)                           | pass, 0 problems                                                                                                                                                                                   |
| `npm run typecheck` (strict)                                              | pass                                                                                                                                                                                               |
| `npm test` (unit)                                                         | **93/93**                                                                                                                                                                                          |
| `npm run test:integration` (fake HTTP servers)                            | **33/33**                                                                                                                                                                                          |
| `npm run test:e2e` (end-to-end: Playwright driving the real Electron app) | **10/10**                                                                                                                                                                                          |
| `npm run make` (Windows)                                                  | pass — `out/make/squirrel.windows/x64/CueDeck-Setup.exe`, `out/make/zip/win32/x64/CueDeck-win32-x64-0.1.0.zip`, `SHASUMS256.txt`                                                                   |
| `npm audit --omit=dev`                                                    | 0 vulnerabilities                                                                                                                                                                                  |
| `npm audit` (full)                                                        | 28 findings, all **build-toolchain only** (Forge CLI transitive `tar`/`tmp`, Vite 5/esbuild dev-server); none ship in the packaged app. Documented exception; revisit when Forge supports Vite 6+. |

## MVP acceptance criteria (spec §22)

1. **Local mode without account/key/payment** — onboarding local path never shows a key form (E2E `onboarding` test asserts zero password inputs); defaults are `local-whisper` + `ollama`.
2. **Offline flow after downloads** — all local processing (Transformers.js utility process, Ollama loopback); outbound allowlist blocks everything else. Full offline run needs the manual Windows check below.
3. **Live meter + silence warning** — AudioWorklet meter at ~15 Hz, `silentSoFar` tracking, 3-second silence banner (`Coach.tsx`); unit-tested in the reducer.
4. **5–90 s clip → editable transcript or specific error** — WAV validation, `AUDIO_TOO_SHORT/TOO_LONG`, `CAPTURE_SILENT`, `TRANSCRIPT_EMPTY` (integration `pipeline.test.ts`); transcript textarea is editable with "Respond to edited text".
5. **Local Ollama streamed answer grounded in profile** — NDJSON adapter with discovery/probe (integration); profile blocks in prompt (unit); live streaming proven E2E against a fake Ollama server.
6. **Cancel suppresses every obsolete delta** — coordinator retires sessions and aborts signals (integration), renderer ignores retired IDs and non-monotonic sequences (unit), cancel E2E asserts the answer text never changes after cancel.
7. **Copy/Clear/Regenerate/Shorter/Bullets/STAR** — implemented in `Coach.tsx`; copy/clear/regenerate E2E-tested; mode follow-ups reuse the regenerate path without retranscribing.
8. **No credential exposure** — patch schema rejects `credentials`; vault stores DPAPI ciphertext only (unit); E2E saves a real secret and asserts it never appears in public settings; diagnostics redaction unit-tested.
9. **Sandbox/isolation/navigation/sender/payload validation** — `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`; `secureHandle` checks sender frame + Zod on every method; E2E asserts no Node/raw-IPC surface, denied `window.open`, denied navigation, denied unarmed `getDisplayMedia`.
10. **Raw audio deleted after transcription** — capture buffers released on encode (`recorder.ts`), WAV bytes are scoped to the session pipeline, history schema has no audio field.
11. **History off by default** — `DEFAULT_SETTINGS.historyEnabled: false`; coordinator writes history only when enabled (integration).
12. **No capture exclusion / suppressible indicator** — `setContentProtection` is never called; the only mentions of it in `src/` are comments documenting its deliberate absence. The recording indicator renders in normal and compact layouts whenever phase is `recording`; indicator-during-real-capture is in the manual matrix.
13. **All suites pass** — see table above.
14. **Installer + checksums** — Squirrel setup + zip built on this Windows machine; SHA-256 sums in `out/make/SHASUMS256.txt`. Artifacts are unsigned (no funded certificate) — SmartScreen warning expected and documented.
15. **License notices** — `THIRD_PARTY_NOTICES.md` covers packaged deps and on-demand model artifacts.

## Provider behavior: mocked vs real

- **Verified against real services:** none — no real cloud calls were required for the build. All adapters use current documented endpoints/model IDs isolated in `src/shared/catalog.ts` (Groq `whisper-large-v3-turbo` / `llama-3.1-8b-instant`, `gemini-2.5-flash`, `openrouter/free`, Ollama `/api/chat`), so a provider-side rename is a one-line change.
- **Verified with local fakes (integration/E2E):** Ollama discovery/streaming/404/unreachable/abort; Groq SSE (server-sent events) success/EOF-flush/401/429+Retry-After/500/malformed frames; Groq Whisper multipart upload; Gemini inline-audio transcription + SSE generation; OpenRouter free-model filtering and paid-model rejection.
- **Local STT (speech-to-text):** worker protocol, model manifest, and progress/cancel paths implemented (`sttWorker.ts`, `sttWorkerManager.ts`); pure audio pipeline fully unit-tested. Real model download + inference is hardware/network-dependent (below).

## Remaining manual Windows verification (hardware-dependent, not missing code)

1. Real loopback capture across Zoom/Teams/Meet/browser playback, device switch, 44.1/48 kHz, Bluetooth/USB audio (spec §20.4), including recording-indicator visibility through resize/minimize/restore.
2. First real `onnx-community/whisper-base` download (progress/cancel/manifest) and local transcription latency benchmark on minimum hardware.
3. End-to-end run against a real installed Ollama model, and optionally real Groq/Gemini/OpenRouter keys.
4. Clean install → upgrade → uninstall of `CueDeck-Setup.exe`, and an antivirus/SmartScreen false-positive check.
5. Full offline pass after models are downloaded.

## Notable engineering decisions

- Onboarding renders as a first-run route inside the coach window; preferences is a true separate `BrowserWindow`.
- CSP is enforced centrally via `onHeadersReceived` (strict policy when packaged, Vite-compatible in dev) instead of a meta tag, keeping one audited policy source. `file://` loading retained over a custom `app://` protocol ("where practical", spec §17.3).
- `npm run build` performs standalone Vite builds mirroring the Forge plugin's output layout so Playwright can drive the exact production bundles; Forge start/package/make use the same configs.
- Cancellation of local STT kills the utility process (also freeing model memory); the next request respawns it.
- No production TODOs, placeholder handlers, or fake success paths remain (`grep -rn "TODO\|FIXME" src` is clean).
