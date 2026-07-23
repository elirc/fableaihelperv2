# CueDeck Testing Guide

CueDeck has three test tiers plus a small set of shared helpers. The split is unusual only in one respect: **both the unit and integration tiers run in plain Node via vitest** (`vitest.config.ts`, `environment: 'node'`) and import directly from `src/` — no Electron involved. Only the e2e tier launches the real app. That constraint drives most of the "which tier does my test belong in" decisions below.

## Commands

```
npm test                 # unit tier        (vitest run test/unit)
npm run test:watch       # unit tier, watch mode
npm run test:integration # integration tier (vitest run test/integration)
npm run test:e2e         # npm run build, then playwright test (test/e2e)
npm run check            # format + lint + typecheck + unit + integration (NOT e2e)
```

Notes:
- `test:e2e` **builds first** — Playwright launches `.vite/build/main.js` directly (`test/e2e/helpers.ts`), so a stale build means you are testing old code. If e2e results look impossible, rebuild.
- e2e runs with `workers: 1, fullyParallel: false` (`playwright.config.ts`) because each Electron launch owns a user-data dir; keep it serial.
- The vitest `testTimeout` is 15 s; Playwright's per-test timeout is 60 s.

## Tier 1: unit tests (`test/unit/`)

**What they cover:** pure logic with no I/O — everything importable without a network, filesystem side effects beyond a temp dir, or Electron. Read them as executable documentation of the invariants:

| File | Subject | Representative invariants |
|---|---|---|
| `audio.test.ts` | `src/shared/audio.ts` | WAV round-trip through the RIFF container, resampler behavior, clamping, RMS/peak, rejection of malformed/truncated files |
| `streaming.test.ts` | `src/shared/streaming.ts` | `SseParser`/`NdjsonParser` are chunk-boundary agnostic, handle CRLF, flush a final frame with no trailing newline, survive UTF-8 split across chunks; `capText` never splits a surrogate pair |
| `prompt.test.ts` | `src/shared/prompt.ts` | every data category is fenced in its named block, closing-tag injection attempts are defanged, mode rules vary the system prompt |
| `redact.test.ts` | `src/shared/redact.ts` | bearer tokens and each known provider key shape are masked; ordinary text is untouched |
| `schemas.test.ts` | `src/shared/schemas.ts` | settings bounds, `publicSettingsPatchSchema` rejects credential writes and unknown fields, session-id format |
| `security.test.ts` | `captureGrant.ts`, `http.ts`, `errors.ts`, OpenRouter policy | grant is one-use and TTL-expiring (uses the injectable `now` clock); host allowlist allows documented hosts + loopback and nothing else; abort→`REQUEST_CANCELLED`, timeout→`PROVIDER_TIMEOUT`; `:free`-with-zero-pricing model policy |
| `sessionMachine.test.ts` | `src/renderer/state/sessionMachine.ts` | happy-path phase walk, retired-session events ignored, non-monotonic sequences dropped, cancel holds until confirmation, regenerate adopts a new session id, edit-transcript phase rules |
| `endpointing.test.ts` | `src/shared/endpointing.ts` | silence endpointer: never fires without speech, fires once after speech + trailing silence, survives short pauses, minimum-speech arming, hysteresis band |
| `practice.test.ts` | `src/shared/practice.ts` | question-bank sanity (unique ids, categories populated), deck deals full permutations, never repeats a question back-to-back across reshuffles, deterministic with injected rng |
| `answerStats.test.ts` | `src/shared/answerStats.ts` | word counting ignores bullets/punctuation tokens, seconds derived from the shared pace constant, pace verdict boundaries incl. the 5 s tolerance floor |
| `historySearch.test.ts` | `src/shared/historySearch.ts` | empty query returns all, case-insensitive AND terms across transcript+answer only, order preserved, regex metacharacters literal |
| `shortcuts.test.ts` | `src/renderer/state/shortcuts.ts` | Ctrl/Cmd+L phase gating, Escape only during active phases, plain keystrokes and Ctrl+C never intercepted |
| `stores.test.ts` | settings/secret/history/profile stores | migrations fall back to defaults on corrupt input; the vault stores only ciphertext (uses a fake `SafeStorageLike`, which is exactly why `SecretVault` takes `safeStorage` as a constructor argument); retention windows |
| `urlPolicy.test.ts` | `src/main/security/urlPolicy.ts` | external-link allowlist blocks lookalike hosts and non-HTTPS |

Note that "unit" here is about *dependencies*, not directory: `captureGrant.ts` and `urlPolicy.ts` live under `src/main/` but are unit-testable because they were deliberately written without Electron imports (see the header comment in `urlPolicy.ts`).

**Helper:** `test/helpers/wav.ts` — `sineWav(seconds)` / `silentWav(seconds)` build deterministic in-memory WAV fixtures with the app's own `encodeWav`.

## Tier 2: integration tests (`test/integration/`)

**What they cover:** several real modules wired together, crossing a real (loopback) HTTP boundary, but still no Electron.

- **`pipeline.test.ts`** — the `SessionCoordinator` + `ProviderRegistry` with *fake in-process providers* (hand-written `SttProvider`/`LlmProvider` objects). This is where session-lifecycle semantics are pinned: WAV → transcript → ordered deltas → complete; silent/short clips rejected before any provider call; empty transcript never reaches the LLM; a second session aborts the first and suppresses its late deltas; cancel emits no error and no completion; regenerate skips STT; history saved only when enabled. The harness (`makeHarness`) shows the intended way to test the coordinator — inject `CoordinatorDeps`, collect emitted events into an array, assert on the event stream.
- **`promptFlow.test.ts`** — the `SessionCoordinator` with a fake LLM that *records every `AnswerRequest`*, pinning what actually reaches the provider after the full pipeline: session notes fenced on both the submit and regenerate paths, injection defanged end-to-end, the active profile embedded (or absent), per-session mode/target shaping the system prompt, and the grounding rules always present. `prompt.test.ts` proves the builder is correct given its inputs; this file proves the coordinator feeds it the right inputs.
- **`providersHttp.test.ts`** — the *real provider adapters* (Ollama, Groq LLM + Whisper, Gemini LLM + audio, OpenRouter) speaking real HTTP to a fake server. Covers wire-format parsing under adversarial chunking, HTTP-status → `CoachError` code mapping (401→`CREDENTIAL_REJECTED`, 429→`PROVIDER_RATE_LIMITED` with one Retry-After retry, 404→`MODEL_NOT_INSTALLED` for Ollama, 500→`PROVIDER_UNAVAILABLE`), missing-key short-circuits (asserting `s.requests` stays empty), mid-stream aborts, malformed-frame tolerance, and request-shape assertions (auth headers, multipart upload, `think: false` for Ollama).

**Helper:** `test/helpers/fakeServer.ts` — `startFakeServer(handler)` spins an `http.Server` on `127.0.0.1:<random port>`, records every request (method, url, headers, raw body Buffer) into `server.requests`, and lets you swap behavior mid-test with `setHandler`. `writeChunked(res, body, chunkSize)` writes the response in odd-sized chunks with 2 ms delays — this is the tool that proves the stream parsers do not depend on chunk boundaries; use it for any new streaming test. `collect(iterable)` drains an `AsyncIterable` into an array.

Two things make this tier possible, and you must preserve them when adding providers: adapters accept an injectable `baseUrl` constructor parameter, and `allowlistedFetch` always permits loopback hosts (`src/main/security/http.ts`), so the fake server needs no allowlist changes.

## Tier 3: end-to-end tests (`test/e2e/`)

**What they cover:** the packaged-shape app — real main process, real preload, real sandboxed renderer — driven by Playwright's `_electron` launcher.

`test/e2e/helpers.ts` provides:
- `launchApp({ seedSettings })` — creates a fresh temp dir, optionally writes a `settings.json` into it, and launches Electron with `CUEDECK_USER_DATA` pointing at it (the hook in `src/main/main.ts` redirects `userData` there). `READY_SETTINGS` seeds a completed-onboarding state so tests land directly on the Coach screen. It strips `ELECTRON_RUN_AS_NODE` from the inherited environment — VS Code terminals export it, and if it leaks into the child, electron.exe boots as plain Node and every launch fails with `bad option: --remote-debugging-port`.
- `startFakeOllama({ deltas, delayMs })` — a minimal loopback Ollama (`/api/tags`, `/api/chat` NDJSON streaming with configurable per-delta delay). Tests point the app at it via `seedSettings: { ollamaBaseUrl: ollama.baseUrl }`. `chatBodies()` returns the raw `/api/chat` request bodies so tests can assert what the app actually sent (used by the session-notes test).

`test/e2e/app.spec.ts` groups:
- **first run** — consent checkbox gates Continue; the local path shows no API-key field.
- **renderer security** — the assertions that *cannot exist in any other tier*: no `window.require`/`process`/`ipcRenderer`; `window.cuedeck` has no generic `invoke`/`send`; `window.open` and external navigation are denied; `getDisplayMedia` without an armed grant is rejected; a saved secret never appears in `getPublicSettings()` output.
- **coach workflow** — Preferences opens as a second window; editing the transcript and clicking Regenerate streams a visible answer from the fake Ollama; Cancel stops a slow stream and *no late deltas repaint the answer* (it snapshots the text, waits 1 s, snapshots again); a dead Ollama port surfaces the structured error banner and Dismiss recovers to Ready; compact mode keeps the capture controls visible; a drawn practice question flows through the respond pipeline and the finished card shows the speaking-pace stats; typed session notes appear fenced inside the fake Ollama's recorded request body; Escape cancels a slow generation from the keyboard.

The rationale for every test added in the 2026-07 feature round (auto-stop endpointing, prewarm-on-arm, session notes UI, practice deck, pace stats, history search, shortcuts) is documented per-test in [TEST_ADDITIONS.md](TEST_ADDITIONS.md).

Selectors are exclusively `data-testid` (`listen-button`, `transcript-input`, `answer-text`, `phase-chip`, `error-banner`, ...). When you add UI, add test ids at the same time.

One real-world gap to know: no e2e test presses the actual **Listen** button, because that requires real system-audio loopback capture on the CI machine. The capture path is covered piecewise — grant logic in unit tests, denial-without-grant in e2e, everything downstream of the WAV in the integration pipeline — while the workflow e2e tests enter through the editable transcript + Regenerate instead.

## Choosing a tier for a new test

Work down this list and stop at the first match:

1. **Is the behavior a property of a pure function or a class with injectable dependencies** (a parser, the reducer, a policy check, a store against a temp dir)? → **unit** (`test/unit/`). Cheapest to run and debug; also the right place for regression tests on edge cases (a WAV that crashed the parser, a weird SSE frame).
2. **Does it involve real HTTP, the wire format of a provider, or multiple modules cooperating** (adapter parsing, status-code mapping, coordinator event ordering, abort propagation across a socket)? → **integration** (`test/integration/`), with `fakeServer` / fake providers. Rule of thumb: if the bug you are guarding against lives in *how bytes arrive* or *how components hand off*, it belongs here — a unit test with a mocked `fetch` would not have caught the chunk-boundary bugs these tests exist for.
3. **Does it depend on Electron itself** — window `webPreferences`, the preload bridge surface, IPC sender validation, the display-media handler, CSP, multi-window behavior, or anything the user literally sees and clicks? → **e2e** (`test/e2e/`). This is the only tier where `src/main/main.ts`, `register.ts`'s `secureHandle`, `windows.ts`, and the preload actually execute. It is also the slowest and flakiest tier, so keep each test focused on what *only* it can verify; push every assertable detail down a tier first.

Corollaries of the "vitest has no Electron" constraint: you cannot unit-test anything that imports `electron` (that is why `registerIpc`, `SttWorkerManager`'s process handling, and `windowSecurity.hardenSession` have no direct unit tests — their pure parts were extracted into `captureGrant.ts`, `urlPolicy.ts`, `http.ts` instead). If you find yourself wanting to unit-test main-process code that touches Electron, first try extracting the logic into a pure module the way those files do; that refactor is the house pattern, not a workaround.

Finally: the local Whisper worker (`sttWorker.ts`) and real model downloads have **no automated coverage at any tier** (they need a multi-hundred-MB download and ONNX runtime). Changes there require a manual `npm run dev` pass: download a model in Preferences, run a transcription, cancel a download mid-flight.
