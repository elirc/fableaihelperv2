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
policy before use, and are never fallen back to silently. Paid model IDs are rejected by default;
an explicit opt-in in Preferences unlocks paid OpenRouter models (billed to your own OpenRouter
credits — set a spending limit on the key at openrouter.ai/keys), with per-million-token prices
shown in the model list. Groq and Gemini paid tiers need no app change: the same key simply
gains higher limits when billing is enabled on the provider's side.

## Recommended setup: cheap and reliable

For realistic mock interviews the practical trade-off is speed and answer quality against zero
spend. The configuration that works best in practice:

| Role                | Pick                                                           | Why                                                                                                                                                                                                                                                                                                                      |
| ------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Speech-to-text      | **Groq Whisper** (`whisper-large-v3-turbo`)                    | Far more accurate than the local Tiny/Base models on technical vocabulary, and faster than real time. One free Groq key covers both STT and responses. Local Whisper Small is the offline alternative.                                                                                                                   |
| Responses (primary) | **Groq `openai/gpt-oss-120b`** or **Cerebras `gpt-oss-120b`**  | 120B-class answers with sub-second first token on the free tier (the app requests low reasoning effort so the first word is not delayed). Materially better than a local 3B–8B model on .NET/JS specifics. Groq retired its Llama 3.x free models on 2026-08-26; the app remaps a saved Llama ID to these automatically. |
| Responses (backup)  | **The other one of the two above**                             | Free-tier limits are per provider, so a rate limit on one rarely coincides with the other. Set it under Preferences → Providers → Backup response model.                                                                                                                                                                 |
| Offline fallback    | Local Whisper + Ollama (`qwen2.5-coder:7b-instruct` on ≥16 GB) | Always free, works with no network. Slower and less accurate; keep it configured for travel days.                                                                                                                                                                                                                        |

Both cloud providers are free tiers with published limits that can change (as of 2026-09-02: Groq
free plan is 30 requests/min, 1,000/day, 8K tokens/min and 200K tokens/day per gpt-oss model, plus
7,200 audio-seconds/hour for Whisper; Cerebras free trial is 5 requests/min and 1M tokens/day per
model). A Groq key needs no card. **Cerebras now requires a verified payment method to activate a
key** (it grants $5 of trial credit and charges nothing unless you upgrade). Gemini's free tier
(`gemini-2.5-flash`, ~10 requests/min, no card) and OpenRouter's `openrouter/free` router (20
requests/min, 50/day without purchased credits) remain the card-free alternatives. The app shows
each provider's data-use disclosure before it can be enabled. Nothing is ever billed unless you
opt into paid OpenRouter models explicitly.

## Testing the production build on a real call

[docs/REAL_CALL_TEST_GUIDE.md](docs/REAL_CALL_TEST_GUIDE.md) is the step-by-step checklist for
the installed build with one free Groq key: install + checksum, first-run setup, a ten-item
smoke test, what to expect during the call, and what to capture when something fails.
Build the installer with `npm run release` (writes `out/make/.../CueDeck-Setup.exe` and
`SHASUMS256.txt`).

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
  audio level and stops + submits by itself once the speaker has paused for the chosen length
  (quick 1.0 s / normal 1.6 s / patient 2.4 s, selectable next to the toggle) — no
  reaction-time lag from clicking Stop. Turn it off to control the clip manually.
- **Transcription starts during the pause**: about 0.7 s into any pause the app snapshots the
  clip so far and starts transcribing it in the background. If the speaker turns out to be
  done, the transcript is already finished (or well under way) by the time auto-respond fires,
  so the response starts sooner; if they carry on talking, the snapshot is simply discarded and
  the final clip is transcribed normally. The status rail says "transcribed during the pause"
  when this paid off. Works with auto-respond off too (the transcript is usually ready when you
  click Stop).
- **Low-latency pipeline**: both models are pre-warmed the moment recording starts (and once at
  app start): the local Whisper model is loaded and its first-run cost paid, and the response
  model is loaded with the real system prompt + profile already evaluated into its prompt
  cache, so the cold start and most of the prompt processing happen while the other person is
  still talking. Answers stream token by token. The status rail shows the timing split
  (transcribe / first words / total) after each response.
- **Session notes**: a small free-text field (company, role, points to hit) sent with every
  request and used to ground the response, alongside your profile. Cleared per call, never
  stored.
- **Conversation context**: the last two question/answer pairs travel with each request, so
  follow-ups like "and how would you scale that?" are answered in context and consistent with
  what was already said. The "Heard" card shows how many exchanges are remembered; **Clear**
  forgets them and starts a new conversation. Toggle in Preferences → General (it costs a few
  hundred tokens per response).
- **Practice deck**: draw from ~60 built-in interview questions (by category) into the
  transcript box, answer aloud, then generate a suggested response to compare. Works fully
  offline — it reuses the same respond pipeline.
- **Interviewer follow-up**: once there is at least one exchange, this button asks the model to
  play the interviewer and generate the next question from what has been said (probing a claim,
  a trade-off, a gap). It lands in the "Heard" box like a deck question, so a single drawn
  question becomes a realistic multi-turn mock interview. One short request (~150 tokens).
- **Backup response model** (Preferences → Providers): free tiers rate-limit and occasionally go
  down mid-interview. You can name a second provider/model to be used only when the primary
  fails before producing anything; the status rail says "(backup — primary failed)" when it
  answered. It is never chosen silently and needs its own key and accepted disclosure.
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
`node_modules` at runtime (its ONNX runtime contains native binaries). Packaged builds copy
only that package's production closure into the asar (`ignore` allowlist in `forge.config.ts`)
and store `onnxruntime-node`, `sharp` and `@img` outside it (`asar.unpack`) so their DLLs load. If it fails to load in dev, delete `node_modules`
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
4. [docs/REVIEW_2026-09-02.md](docs/REVIEW_2026-09-02.md) — the deploy-readiness review: what
   was broken in the packaged build, the free-tier status, and what is still open.

## Security & privacy

- [SECURITY.md](SECURITY.md) — threat model and controls: sandboxed renderer, context
  isolation, no Node integration, IPC sender + payload validation, one-use capture grant,
  outbound host allowlist, `safeStorage`-encrypted credentials (DPAPI on Windows), and no
  `setContentProtection` or any capture-concealment API, ever.
- [PRIVACY.md](PRIVACY.md) — exactly what is stored, where, and what leaves the machine in
  each mode (in local mode: nothing).

## License

MIT. Third-party license notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
