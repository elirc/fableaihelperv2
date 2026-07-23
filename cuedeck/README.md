# CueDeck

CueDeck is a **free, local-first conversation practice and disclosed-assistance coach** for
Windows. Press **Listen**, let it hear a short clip of this computer's audio (a mock-interview
question, a permitted call), and it transcribes the clip and streams a concise first-person
response card grounded in _your_ profile — nothing invented.

Built for: mock interviews and rehearsal, disclosed response cues on permitted calls,
accessibility support, and anyone who wants a call assistant without a subscription.

**Not built for:** covert recording, proctored assessments, or any setting where outside help
is prohibited. CueDeck always shows a recording indicator while capturing, has no
hidden-recording or screen-share-concealment features, and never will. You are responsible for
participant consent and the rules that apply to your calls. See [PRIVACY.md](PRIVACY.md).

## Zero mandatory spend

Local mode is the default and the only mode labeled **Always free**:

- **Speech-to-text:** a Whisper-compatible ONNX model (~120–600 MB depending on size choice,
  downloaded once) running on device via
  [Transformers.js](https://huggingface.co/docs/transformers.js) in an isolated Electron
  utility process (a helper process separate from both the UI and the main process).
- **Responses:** any local model served by [Ollama](https://ollama.com) at
  `http://127.0.0.1:11434` (e.g. `ollama pull qwen2.5:3b-instruct`).
- No account, API key, credit card, telemetry, or hosted backend. After the one-time model
  downloads, the full flow works offline.

Optional **cloud free-tier** adapters (Groq, Cerebras, Google Gemini, OpenRouter `:free` models) are
available for older hardware. They are labeled _free tier; limits may change_, require your own
API key (stored encrypted with Windows DPAPI — the OS's built-in Data Protection API, which
encrypts data so only your Windows user account can decrypt it), show each provider's data-use
policy before use, and are never fallen back to silently. Paid model IDs are rejected by design.

## Prerequisites

| Requirement       | Version / notes                                                                                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows           | 10 or 11, x64. CueDeck targets Windows only (system loopback audio, DPAPI).                                                                                                                     |
| Node.js           | 22 LTS or newer (the project pins `@types/node` 22). Includes npm.                                                                                                                              |
| Ollama (optional) | Needed for local responses: install from <https://ollama.com/download>, then `ollama pull qwen2.5:3b-instruct` (or `llama3.2:3b`, `phi3.5:3.8b`). Skip it if you plan to use a cloud free tier. |
| Disk space        | ~120 MB (Whisper Tiny) to ~600 MB (Whisper Small) for the one-time local speech-to-text model download, plus whatever Ollama model you pull.                                                    |

No global CLI installs are required — Electron, Electron Forge, Vite, and all tooling are local
dev dependencies installed by `npm install`. You do not need Python, Visual Studio, or any
native build toolchain: the native pieces (the ONNX runtime used by Transformers.js) ship as
prebuilt binaries.

## First run (development)

```bash
git clone <repo-url>
cd cuedeck
npm install
npm run dev
```

`npm run dev` runs Electron Forge, which starts Vite dev servers (with hot reload for the UI)
and launches the Electron app pointing at them. The first window is the onboarding flow:

1. **Consent acknowledgement** — you confirm you understand the visible-recording and
   participant-consent rules. Required before anything else works.
2. **Mode choice** — local (recommended, always free) or cloud free tier.
3. **Local setup** (local mode) — pick and download a Whisper ONNX model (Tiny ~120 MB /
   Base ~200 MB, recommended / Small ~600 MB) and let the app detect Ollama. Models download
   from Hugging Face into `%APPDATA%\CueDeck\models`. **Cloud setup** (cloud mode) — pick a
   provider, read its data-use disclosure, and paste your API key.
4. **Audio test** — play any audio on the computer, then run a 5-second capture test to verify
   system loopback audio works. Loopback audio means the app records what the computer is
   _playing_ (speakers/headphones output), not your microphone.
5. **Optional profile** — background text about you that responses are grounded in.

After onboarding you land on the Coach window: press **Listen**, let it capture a clip, and a
response card streams in. Settings live in a separate Preferences window.

## The coach window

Everything is tuned for one loop: someone asks a question, you get a speakable response fast.

- **Auto-respond on pause** (on by default, toggleable): while listening, the app watches the
  audio level and stops + submits by itself about 1.6 s after the speaker finishes — no
  reaction-time lag from clicking Stop. Turn it off to control the clip manually.
- **Low-latency pipeline**: the response model is pre-warmed the moment recording starts (the
  cold start happens while the other person is still talking), the LLM warms again during
  transcription, and answers stream token by token. The status rail shows the timing split
  (transcribe / first words / total) after each response.
- **Session notes**: a small free-text field (company, role, points to hit) sent with every
  request and used to ground the response, alongside your profile. Cleared per call, never
  stored.
- **Practice deck**: draw from ~30 built-in interview questions (by category) into the
  transcript box, answer aloud, then generate a suggested response to compare. Works fully
  offline — it reuses the same respond pipeline.
- **Speaking-pace estimate**: each finished answer shows its word count and estimated speaking
  time against your target (15/30/60 s), so you know whether the draft fits before you use it.
- **Keyboard shortcuts**: `Ctrl+L` listen / stop &amp; respond, `Esc` cancel, `Ctrl+Shift+C`
  copy the response.
- **History search** (Preferences → History, only if history is enabled): filter saved
  sessions by any words in the transcript or response.

App data (settings, encrypted keys, profiles, optional history, downloaded models) lives under
`%APPDATA%\CueDeck\`. Deleting that folder resets the app, including onboarding. See
[PRIVACY.md](PRIVACY.md) for the full file-by-file list.

## npm scripts

| Script                      | What it does                                                                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev` / `npm start` | Same command (`electron-forge start`): dev app with Vite hot reload.                                                                                                                              |
| `npm run build`             | Production bundles — main, preload, STT worker (into `.vite/build/`) and renderer (into `.vite/renderer/`). Used by the E2E suite; you rarely run it alone.                                       |
| `npm run typecheck`         | Strict TypeScript over the whole project, no output files (`tsc --noEmit`).                                                                                                                       |
| `npm run lint`              | ESLint over `src`, `test`, and the root `*.ts` configs.                                                                                                                                           |
| `npm run format`            | Prettier, write mode (rewrites files).                                                                                                                                                            |
| `npm run format:check`      | Prettier, check-only (fails if formatting is off; used in `check`).                                                                                                                               |
| `npm test`                  | Unit tests (`test/unit`) with Vitest, single run.                                                                                                                                                 |
| `npm run test:watch`        | Same unit tests in watch mode.                                                                                                                                                                    |
| `npm run test:integration`  | Provider/IPC integration tests (`test/integration`) against local fake HTTP servers — no real network or API keys needed.                                                                         |
| `npm run test:e2e`          | Runs `npm run build`, then Playwright launches the real packaged-style Electron app (`test/e2e`). Serial by design (one worker); each run gets an isolated user-data dir via `CUEDECK_USER_DATA`. |
| `npm run package`           | Electron Forge package step: the app folder without an installer.                                                                                                                                 |
| `npm run make`              | Windows distributables (Squirrel installer + zip) into `out/make/`.                                                                                                                               |
| `npm run check`             | The full local gate: `format:check` + `lint` + `typecheck` + unit + integration. Run this before pushing.                                                                                         |

## Project layout

```text
cuedeck/
├─ src/
│  ├─ main/                 Privileged Electron main process (Node access lives here, and only here)
│  │  ├─ main.ts            App entry: bootstraps stores, providers, windows, capture handler
│  │  ├─ ipc/register.ts    All IPC methods: sender-checked, Zod-validated
│  │  ├─ providers/         Provider registry + adapters
│  │  │  ├─ stt/            Speech-to-text: localWhisper, groqWhisper, geminiAudio
│  │  │  └─ llm/            Responses: ollama, groq, cerebras, gemini, openRouter (+ shared OpenAI-compatible base)
│  │  ├─ security/          Capture grant, outbound host allowlist, URL policy, window hardening
│  │  ├─ sessions/          Session coordinator: stage timeouts, abort, structured errors
│  │  ├─ settings/          Public settings store (JSON + migrations) and encrypted secret vault
│  │  ├─ storage/           Optional history, profiles, JSON-file helper
│  │  ├─ windows/           Coach + Preferences BrowserWindow creation
│  │  └─ workers/           STT utility process (sttWorker.ts) and its manager
│  ├─ preload/preload.ts    The preload script: a small, fixed, typed API bridged into the page
│  ├─ renderer/             Sandboxed React UI (no Node access)
│  │  ├─ routes/            Coach, Onboarding, Preferences screens
│  │  ├─ audio/recorder.ts  Clip recording via getDisplayMedia + audio worklet
│  │  └─ state/             Session state machine
│  └─ shared/               Pure TypeScript shared by all processes: domain types, Zod schemas,
│                           audio math, prompt building, stream parsing, redaction, constants,
│                           catalog, silence endpointing, practice deck, answer stats, history search
├─ test/
│  ├─ unit/                 Vitest unit tests for src/shared and pure main-process logic
│  ├─ integration/          Pipeline + provider HTTP tests against fake local servers
│  ├─ e2e/                  Playwright specs driving the real Electron app
│  └─ helpers/              Fake server + WAV fixtures
├─ public/                  Static assets served to the renderer (audio-capture worklet)
├─ scripts/                 Release helpers (checksums.mjs, generateIcon.mjs)
├─ assets/                  App icons
├─ forge.config.ts          Electron Forge: packaging, makers, Vite plugin, Electron fuses
├─ vite.*.config.ts         One Vite config per bundle: main, preload, worker, renderer
├─ playwright.config.ts     E2E runner config
├─ vitest.config.ts         Unit/integration runner config
└─ .env.example             Documents the one env var tooling uses (no secrets ever go in .env)
```

Electron vocabulary, in one pass: an Electron app has a **main process** (Node.js, full OS
access) and one or more **renderer processes** (Chromium pages that show the UI). They talk
over **IPC** (inter-process communication — structured messages, here validated with Zod on
every call). The renderer runs with **contextIsolation** (the page's JavaScript world is
separated from Electron internals, so web code can't reach Node APIs) and is exposed exactly
one bridge: the **preload** script, which runs before the page loads and publishes a fixed,
typed API via `contextBridge`. CueDeck's renderer is additionally sandboxed with Node
integration off, and the packaged binary flips Electron **fuses** (build-time switches that
permanently disable escape hatches like `ELECTRON_RUN_AS_NODE`).

## Architecture

```text
Sandboxed React renderer  (contextIsolation, no Node, fixed preload API)
  │  Zod-validated IPC, sender-checked, sessionId + sequence on every event
  ▼
Electron main process
  ├─ window/session hardening (CSP from default-src 'none', nav denial, fuses)
  ├─ one-use expiring capture grant → Windows loopback audio
  ├─ session coordinator (abort, stage timeouts, structured errors)
  ├─ public settings (JSON + migrations) / secret vault (safeStorage ciphertext)
  ├─ provider registry
  │    ├─ local Whisper STT → utility process (Transformers.js)
  │    ├─ Ollama localhost NDJSON streaming
  │    └─ optional HTTPS: Groq / Cerebras / Gemini / OpenRouter (host allowlist)
  └─ optional local history + diagnostics (secret-redacted)
```

Notes on the diagram: the **capture grant** means the renderer must explicitly arm a one-use,
8-second-TTL permission before Windows loopback audio can be captured — any other
`getDisplayMedia` request is denied. **NDJSON** (newline-delimited JSON) is Ollama's streaming
format: one JSON object per line, which the app parses incrementally to stream tokens into the
response card. The main process may only contact loopback plus a short hardcoded host allowlist
(Groq, Google, OpenRouter, Hugging Face model CDN — see `src/shared/constants.ts`).

## Troubleshooting

**`npm run dev` fails to launch or the window is blank.**
Check the terminal first — Forge prints Vite build errors there. If a previous dev instance is
still running, close it: the app takes a single-instance lock, so a second launch quits
immediately and just focuses the first window. If a port collision is reported (another Vite
dev server running elsewhere, `EADDRINUSE`), stop the other dev server and retry.

**Errors mentioning `onnxruntime` or native modules.**
`@huggingface/transformers` is deliberately kept out of the app bundles and loaded from
`node_modules` at runtime (its ONNX runtime contains native binaries; packaged builds unpack
them from the asar archive automatically). If it fails to load in dev, delete `node_modules`
and `package-lock.json`-driven state and reinstall (`Remove-Item -Recurse -Force node_modules;
npm install`), and make sure you are on x64 Node 22+. No manual `electron-rebuild` step exists
or is needed in this project.

**The Whisper model download is slow or fails.**
Models are 120–600 MB and come from Hugging Face (`huggingface.co` and its CDN hosts are on
the allowlist). Downloaded files are cached in `%APPDATA%\CueDeck\models`; if a download went
wrong, delete that model's folder there and use "Download / verify selected model" in
Preferences to fetch it again. Behind a proxy or firewall, those hosts must be reachable —
there is no mirror setting.

**"Ollama not detected" or responses never start.**
Ollama must be running and reachable at `http://127.0.0.1:11434` (changeable in Preferences).
Check with `ollama list` in a terminal. If Ollama runs but has no models, pull one:
`ollama pull qwen2.5:3b-instruct`. The app never silently falls back to a cloud provider.

**The audio test says "silent".**
Loopback capture records what the computer plays, not your microphone — so play music or a
video _during_ the 5-second test. Very low system volume can also fall under the silence
threshold. Capture requests are denied unless armed by the app itself, so run the test from the
onboarding/UI button, and note the recording indicator is always visible while capturing.

**E2E tests are slow or flaky when run in parallel.**
They are intentionally serial (`workers: 1` in `playwright.config.ts`) because an Electron app
owns one user-data directory per launch. `npm run test:e2e` always rebuilds first; each run
isolates its data via the `CUEDECK_USER_DATA` env var (see `.env.example`).

**Windows SmartScreen warns when installing a build.**
Expected: `npm run make` produces an unsigned installer. Verify downloads against the published
SHA-256 checksums instead (see below).

**Where is my data? How do I reset?**
Everything is under `%APPDATA%\CueDeck\`. Deleting the folder wipes settings, encrypted keys,
profiles, history, and models, and re-triggers onboarding. Diagnostics output is
secret-redacted before display.

## Packaging & releases

`npm run make` produces an **unsigned** installer (`out/make/squirrel.windows/x64/CueDeck-Setup.exe`)
plus a zip. Windows SmartScreen will warn on unsigned installers; publish SHA-256 checksums
alongside artifacts (`scripts/checksums.mjs` writes `out/make/SHASUMS256.txt`) so users can
verify downloads. Code signing requires funding and is on the post-MVP list.

## Contributor documentation

New to the codebase? Read these in order — they assume only basic Node/React knowledge and
explain the Electron-specific pieces as they go:

1. [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — the process model and a step-by-step trace of
   one "Listen" session, from button press through capture, transcription, and the streamed
   response card.
2. [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — how to make common changes safely: adding an LLM
   provider, adding an IPC channel, adding a renderer route, and where validation lives.
3. [docs/TESTING.md](docs/TESTING.md) — what each test tier covers and how to decide where a new
   test belongs.

## Security & privacy

- [SECURITY.md](SECURITY.md) — threat model and controls: sandboxed renderer, context
  isolation, no Node integration, IPC sender + payload validation, one-use capture grant,
  outbound host allowlist, `safeStorage`-encrypted credentials (DPAPI on Windows), and no
  `setContentProtection` or any capture-concealment API, ever.
- [PRIVACY.md](PRIVACY.md) — exactly what is stored, where, and what leaves the machine in
  each mode (in local mode: nothing).

## License

MIT. Third-party license notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
