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

- **Speech-to-text:** a Whisper-compatible ONNX model (~200 MB, downloaded once) running on
  device via [Transformers.js](https://huggingface.co/docs/transformers.js) in an isolated
  utility process.
- **Responses:** any local model served by [Ollama](https://ollama.com) at
  `http://127.0.0.1:11434` (e.g. `ollama pull qwen2.5:3b-instruct`).
- No account, API key, credit card, telemetry, or hosted backend. After the one-time model
  downloads, the full flow works offline.

Optional **cloud free-tier** adapters (Groq, Google Gemini, OpenRouter `:free` models) are
available for older hardware. They are labeled _free tier; limits may change_, require your own
API key (stored encrypted with Windows DPAPI), show each provider's data-use policy before use,
and are never fallen back to silently. Paid model IDs are rejected by design.

## Getting started (development)

Requirements: Node.js 22 LTS+, Windows 10/11 x64.

```bash
npm install
npm run dev          # launch the app with hot reload
```

First run walks through: consent acknowledgement → local/cloud mode choice → STT model
download → Ollama detection → 5-second system-audio test → optional profile.

## Scripts

| Script                            | What it does                                                           |
| --------------------------------- | ---------------------------------------------------------------------- |
| `npm run dev` / `npm start`       | Electron Forge dev app (Vite HMR)                                      |
| `npm run build`                   | production bundles (main, preload, STT worker, renderer) into `.vite/` |
| `npm run typecheck`               | strict TypeScript, no emit                                             |
| `npm run lint`                    | ESLint over `src`, `test`, and configs                                 |
| `npm run format:check` / `format` | Prettier verification / write                                          |
| `npm test`                        | unit tests (Vitest)                                                    |
| `npm run test:integration`        | provider/IPC integration tests against local fake servers              |
| `npm run test:e2e`                | builds, then Playwright drives the real Electron app                   |
| `npm run make`                    | Windows distributables (Squirrel setup + zip) into `out/make/`         |
| `npm run check`                   | format + lint + typecheck + unit + integration                         |

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
  │    └─ optional HTTPS: Groq / Gemini / OpenRouter (host allowlist)
  └─ optional local history + diagnostics (secret-redacted)
```

Key directories: `src/main` (privileged), `src/preload` (bridge), `src/renderer` (UI),
`src/shared` (pure, unit-tested domain/schemas/audio/prompt/streaming), `test/{unit,integration,e2e}`.

## Packaging & releases

`npm run make` produces an **unsigned** installer (`out/make/squirrel.windows/x64/CueDeck-Setup.exe`)
plus a zip. Windows SmartScreen will warn on unsigned installers; publish SHA-256 checksums
alongside artifacts (`scripts/checksums.mjs` writes `out/make/SHASUMS256.txt`) so users can
verify downloads. Code signing requires funding and is on the post-MVP list.

## Security

See [SECURITY.md](SECURITY.md). Highlights: sandboxed renderer, context isolation, no Node
integration, IPC sender + payload validation, one-use capture grant, outbound host allowlist,
`safeStorage`-encrypted credentials, no `setContentProtection` or any capture-concealment API.

## License

MIT. Third-party license notices: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
