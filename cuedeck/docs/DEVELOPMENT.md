# CueDeck Development Guide

How to make the most common kinds of changes safely. Read `docs/ARCHITECTURE.md` first if you have not; this document assumes you know the process model and the session pipeline.

## Prerequisites and daily commands

Scripts are defined in `package.json`:

```
npm run dev              # electron-forge start (Vite dev server + Electron)
npm run typecheck        # tsc --noEmit (strict mode)
npm run lint             # eslint src test *.ts
npm run format           # prettier --write
npm test                 # unit tests (vitest, test/unit)
npm run test:integration # vitest, test/integration
npm run test:e2e         # builds, then Playwright drives the real app
npm run check            # format:check + lint + typecheck + unit + integration
```

`npm run check` is the pre-commit bar; run it before pushing anything.

## Adding a new LLM provider

This is the most instructive change in the codebase because it touches every layer deliberately kept apart. Suppose you are adding a provider called "Acme". Walk these files in order:

1. **`src/shared/catalog.ts`** — add an entry to `PROVIDERS`:
   ```ts
   acme: {
     id: 'acme',
     displayName: 'Acme',
     location: 'cloud',
     freePolicy: 'provider-free-tier',
     supportsAbort: true,
     kind: 'llm',
     dataUseUrl: 'https://acme.example/privacy',
     disclosure: 'Transcripts, your profile, and session notes are sent to Acme. ...',
   },
   ```
   The `disclosure` string is not decorative: the Preferences UI shows it before the provider can be enabled, and it is part of the app's consent posture. Cloud model IDs go in `CLOUD_MODELS` here too — never hardcode a model ID inside an adapter (the file's header comment explains why: a provider-side rename should be a one-line release change).

2. **`src/shared/constants.ts`** — add the API hostname to `ALLOWED_HOSTS`. If you skip this, `allowlistedFetch` (`src/main/security/http.ts`) will throw `PROVIDER_UNAVAILABLE: host not allowed` before a socket ever opens. This is by design — the allowlist is the audit trail of everywhere the app can talk to. If the Preferences UI should link to the provider's key console or privacy policy, also add those exact URLs to `EXTERNAL_LINK_ALLOWLIST` (matched by host + path prefix in `src/main/security/urlPolicy.ts`).

3. **`src/main/providers/llm/acme.ts`** — the adapter, implementing `LlmProvider` from `src/main/providers/contracts.ts` (`meta`, `probe`, `listModels`, `generate`). Two paths:
   - *OpenAI-compatible API* (the common case): copy `src/main/providers/llm/groq.ts`. It is ~45 lines because all the real work — SSE parsing, `Bearer` auth, HTTP-status-to-error-code mapping, the single Retry-After honor on 429 — lives in `src/main/providers/llm/openAiCompatible.ts` (`streamChatCompletions`, `probeOpenAiCompatible`, `mapHttpStatus`). Reuse it.
   - *Custom wire format*: copy `src/main/providers/llm/gemini.ts` (SSE with a custom JSON shape) or `ollama.ts` (NDJSON). Use `SseParser`/`NdjsonParser` from `src/shared/streaming.ts` and `bodyChunks` from `contracts.ts`; both parsers survive arbitrary chunk boundaries and unterminated final frames, and there are already tests proving it.

   Conventions the existing adapters all follow:
   - Constructor takes `(getApiKey: () => Promise<string | null>, baseUrl = DEFAULT)`. The injectable `baseUrl` is what lets integration tests point the adapter at a loopback fake server.
   - Missing key → throw `new CoachError('CREDENTIAL_MISSING', ...)` **before** any network call (there is a test asserting the server is never contacted).
   - Every fetch goes through `allowlistedFetch` with a `timeoutMs` from `TIMEOUTS` and the caller's `AbortSignal`.
   - Parse provider JSON with a local Zod schema and `safeParse`; skip malformed frames rather than crashing the stream.
   - Throw only `CoachError` with codes from `PUBLIC_ERROR_CODES` (`src/shared/domain.ts`). Users see the template message from `src/shared/errors.ts`, not your string — your string becomes `detail`.

4. **`src/main/main.ts`** — register it in `bootstrap()`:
   ```ts
   registry.registerLlm(new AcmeProvider(keyFor('acme')));
   ```
   `keyFor('acme')` closes over `SecretVault.getForAdapter('acme')`, so the key the user saves under provider id `acme` reaches your adapter and nothing else. The provider id string must match the `PROVIDERS` key — the secret vault, the credential flags in settings, and the registry are all keyed by it.

5. **`src/shared/redact.ts`** — if the provider's API keys have a recognizable prefix (like `gsk_` for Groq or `sk-or-` for OpenRouter), add a pattern so a leaked key can never appear in diagnostics exports.

6. **Tests** — add a `describe` block in `test/integration/providersHttp.test.ts` using `startFakeServer` from `test/helpers/fakeServer.ts`. At minimum cover: streaming happy path across odd chunk boundaries (`writeChunked`), 401 → `CREDENTIAL_REJECTED`, missing key → `CREDENTIAL_MISSING` with zero requests, and abort mid-stream. See `docs/TESTING.md`.

Nothing in the renderer needs to change: the Preferences providers section builds its UI from `providers:list` (which returns every registered `ProviderMeta`) and `providers:probe`/`models:list`. An STT provider is the same recipe with `SttProvider`/`registerStt` and a `transcribe` method instead of `generate` (see `src/main/providers/stt/groqWhisper.ts` for the multipart-upload pattern).

## Adding an IPC channel safely

There are five places a channel exists, and all five must agree. Using an imaginary `notes:save` as the example:

1. **Schema first** — `src/shared/schemas.ts`. Define a Zod schema for the request payload with explicit bounds (`z.string().min(1).max(...)`); look at `profileSaveSchema` or `sessionRegenerateSchema` for the house style. Every size limit here is a defence: the renderer is the least-trusted process, so nothing it sends is believed.

2. **Handler** — `src/main/ipc/register.ts`. Always use `secureHandle`, never raw `ipcMain.handle`:
   ```ts
   secureHandle('notes:save', async (_event, raw) => {
     const input = noteSaveSchema.parse(raw);
     return services.notes.save(input);
   });
   ```
   `secureHandle` gives you, for free: trusted-sender + main-frame verification, and conversion of any thrown error (Zod errors included) into a structured `PublicError` — so never `throw new Error('...')` with internal details; throw `CoachError` with a public code. Return values must be plain JSON-serializable data (they cross a process boundary). If the operation is long-running, follow the `models:download` pattern instead: return an `operationId` immediately and stream progress via `broadcast('operation:event', ...)`.

3. **Preload** — `src/preload/preload.ts`. Add a named method to the `api` object:
   ```ts
   saveNote: (note: NoteInput) => invoke<Note>('notes:save', note),
   ```
   Do not expose the channel name, `ipcRenderer`, or anything generic. The e2e suite literally asserts `window.cuedeck` has no `invoke`/`send` keys.

4. **Types** — nothing extra to do: `CueDeckApi = typeof api` is exported from the preload and `src/renderer/global.d.ts` maps it onto `window.cuedeck`, so the renderer gets full type safety automatically. Put any new domain types in `src/shared/domain.ts` (kept as the static mirror of the Zod schemas).

5. **Renderer** — call `window.cuedeck.saveNote(...)`. Rejections arrive as `PublicError` objects (`{ code, message, retryable, action? }`), already unwrapped by the preload's `invoke` helper; handle them like `Coach.tsx`'s `asPublicError` does.

Events flowing main → renderer are a separate, deliberately narrow path: there are exactly two broadcast channels, `session:event` and `operation:event` (`broadcast` in `src/main/main.ts`, `onSessionEvent`/`onOperationEvent` in the preload). Prefer adding a variant to `SessionEvent`/`OperationEvent` in `src/shared/domain.ts` over inventing a third channel.

## Adding a renderer route

Routing is a ~10-line hash router in `src/renderer/App.tsx` (`useHashRoute`), not a routing library. To add a screen:

1. Create `src/renderer/routes/MyScreen.tsx`. The existing routes all take `{ settings: PublicSettings; onSettingsChanged: () => Promise<void> }` and call `onSettingsChanged` after any `updatePublicSettings` so `App` re-fetches and re-renders everything with fresh settings.
2. Add a branch in `App()`:
   ```tsx
   if (route.startsWith('/myscreen')) return <MyScreen settings={settings} onSettingsChanged={refresh} />;
   ```
   Note the precedence in `App`: `/preferences` wins over everything, then the onboarding gate (`!settings.onboardingComplete`), then Coach as the default.
3. If the screen should open in its own OS window (like Preferences), add a factory in `src/main/windows/windows.ts` — reuse `SECURE_PREFERENCES`, call `hardenWebContents(win)`, and load the same renderer bundle with your hash (`{ hash: '/myscreen' }` in the packaged branch, `#/myscreen` on the dev URL). Then expose an `app:openMyScreen`-style channel following the IPC recipe above.
4. Styling is a single plain-CSS file, `src/renderer/styles.css`, with CSS variables for theming. No CSS-in-JS, no Tailwind.
5. Give interactive elements `data-testid` attributes — the e2e suite selects exclusively by test id (`listen-button`, `phase-chip`, `nav-providers`, ...).

## Where validation lives

There are three distinct validation rings; know which one you are in:

1. **The IPC boundary** — `src/shared/schemas.ts`, enforced in `src/main/ipc/register.ts`. Everything the renderer sends is parsed here. Special cases worth knowing: `publicSettingsPatchSchema` is `.strict()` and omits `credentials`/`schemaVersion` so the renderer can never forge credential flags; `session:submit` checks raw WAV byte bounds (`WAV_MIN_BYTES`/`WAV_MAX_BYTES`) before any parsing.
2. **Content validation in the pipeline** — `src/main/sessions/coordinator.ts` re-validates the audio semantically (`parseWavHeader`, duration, silence RMS) using pure helpers from `src/shared/audio.ts`.
3. **Provider responses** — each adapter Zod-parses what the provider returns (e.g. `tagsSchema`/`chatChunkSchema` in `ollama.ts`, `transcriptionSchema` in `groqWhisper.ts`). Cloud APIs are just as untrusted as the renderer. Use `safeParse` + skip for stream frames, `parse` for one-shot responses.

Persistence uses a fourth, softer ring: stores `safeParse` each record on read and silently drop invalid ones (`historyStore.ts`, `profileStore.ts`), and settings run through migrations with a defaults fallback (`src/main/settings/migrations.ts`). Corrupt files degrade, never crash.

## Coding conventions observed in this repo

These are patterns the existing code follows consistently; match them.

- **TypeScript strict mode everywhere** (`tsconfig.json`), one config for src and test. `noImplicitOverride`, `noFallthroughCasesInSwitch` are on.
- **Dependency injection by constructor closure.** Classes receive narrow getter functions, not service objects: `OllamaProvider(getBaseUrl)`, `SecretVault(userDataDir, safeStorage)`, `SessionCoordinator(deps)` with a `CoordinatorDeps` interface. This is what makes the unit/integration tests possible without Electron, so keep new code injectable the same way.
- **`src/shared/` is pure.** No Electron imports, no Node-only APIs beyond what both sides have; it must be importable from the renderer, the main process, and vitest's node environment alike. If your "shared" code needs `electron`, it is not shared — put it in `src/main/`.
- **Errors are a closed taxonomy.** Internal code throws `CoachError(code, detail?)`; codes come from `PUBLIC_ERROR_CODES` in `src/shared/domain.ts`; user-facing text lives only in the templates in `src/shared/errors.ts`. Adding a new code means updating the enum, the template map, and (if the renderer should react specially) the reducer/UI.
- **Cancellation is `AbortSignal` end-to-end.** Compose with `AbortSignal.any([...])` and `AbortSignal.timeout(...)`; treat `AbortError`/`TimeoutError` names as meaningful (`toPublicError` maps them to `REQUEST_CANCELLED`/`PROVIDER_TIMEOUT`). Long-running child work is cancelled by killing the utility process (`SttWorkerManager.stop`).
- **All magic numbers live in `src/shared/constants.ts`** (`TIMEOUTS`, caps, thresholds, allowlists) and are imported, not repeated.
- **File I/O goes through `readJsonFile`/`writeJsonFile`** (`src/main/storage/jsonFile.ts`) for atomicity and the Windows rename-retry.
- **Comment style**: a block comment at the top of each file states its contract, often citing spec sections (`spec §14`) and requirement IDs (`CAP-10`) from the original — not-in-repo — spec. Keep writing intent-level comments like these; they are the closest thing to a spec the repo has.
- **Lint rules that will bite you** (`eslint.config.mjs`): `no-console` (only `warn`/`error` allowed), inline type imports (`import { type Foo }`), unused args must be `_`-prefixed. Prettier is enforced by `npm run check`.
- **React style**: function components, hooks, `useReducer` with a pure reducer for anything stateful enough to test (`sessionMachine.ts`), `useCallback` for handlers passed downward, refs for mutable non-render state (`recorderRef`, `sessionRef`). No state library.
- **Never weaken the security defaults.** `SECURE_PREFERENCES`, `secureHandle`, `allowlistedFetch`, the CSP, and the fuses config are load-bearing. A PR that adds `nodeIntegration: true`, a raw `ipcMain.handle`, a raw `fetch` to a new host, or `setContentProtection` should be treated as wrong until proven otherwise.
