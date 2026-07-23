# Test Additions — Rationale

This document explains every test added alongside the 2026-07 feature round: what each one
verifies and why it exists. The features themselves (all local-first, none adding a new IPC
channel or external dependency):

- **Auto-respond on pause** — a silence endpointer (`src/shared/endpointing.ts`) stops and
  submits the clip when the speaker finishes, removing human reaction time from the
  latency-critical path. Toggleable per the `autoStopOnSilence` setting (default on).
- **Prewarm on arm** — `SessionCoordinator.prewarm()` fires when capture is armed, so the LLM
  loads while the other person is still talking instead of during transcription.
- **Session notes UI** — the `sessionNotes` plumbing (schema, prompt fencing, coordinator)
  already existed end to end; the Coach now exposes it, so per-call context (company, role,
  points to hit) grounds every response.
- **Practice deck** (`src/shared/practice.ts`) — a built-in question bank with categories and
  a no-repeat shuffle, feeding the existing transcript → respond pipeline.
- **Speaking-pace estimate** (`src/shared/answerStats.ts`) — words and estimated speaking
  seconds vs. the user's target, shown under each finished answer.
- **History search** (`src/shared/historySearch.ts`) — a text filter for saved sessions.
- **Keyboard shortcuts** (`src/renderer/state/shortcuts.ts`) — Ctrl+L listen/stop, Esc cancel,
  Ctrl+Shift+C copy, resolved by a pure function.

Tier placement follows [TESTING.md](TESTING.md): pure logic → unit; module cooperation and
what-reaches-the-provider → integration; anything only the real Electron app can prove → e2e.

---

## Unit tier (`test/unit/`)

### `endpointing.test.ts` — new file (10 tests)

The endpointer decides, from the live level meter alone, when to submit a clip. A wrong
decision either cuts off the speaker (submits too early) or throws away the latency win
(never fires). Each test pins one branch of that decision, driven through a scripted level
feed at the real ~15 Hz meter cadence:

| Test | What it verifies | Why it was added |
|---|---|---|
| never fires on pure silence | No speech → no submit, ever | Nothing was asked; auto-submitting silence would produce a `CAPTURE_SILENT` error loop |
| never fires while speech continues | Continuous talk never triggers | Firing mid-question is the worst failure mode: it truncates the very audio the user needs |
| fires after speech + trailing window | Fires within one meter tick of speech end + 1.6 s | This is the feature: the submit must come fast and at a predictable moment |
| short pause does not fire | A pause shorter than the window is survived | Mid-sentence breaths are common; firing on them would clip questions constantly |
| resumed sentence resets silence | Talk–pause–talk–silence fires only after the real end | The silence counter must reset on resumed speech or the second half of a question is lost |
| minimum speech required | A 300 ms blip never arms the endpointer | Notification dings and UI sounds must not submit a clip |
| interrupted speech accumulates | Two short bursts totalling ≥ minSpeech still arm | Halting speakers should not be locked out of auto-stop |
| fires exactly once | Continued silence after firing returns false forever | The Coach calls `stopRecording` on `true`; a second fire would double-submit |
| hysteresis band holds state | Levels between the two thresholds keep the previous state | Breathy trailing audio hovers between thresholds; flapping would reset the silence run and delay the submit |
| custom configuration respected | Injected thresholds/windows are honored | Documents the constructor contract that makes all the tests above deterministic |

### `practice.test.ts` — new file (12 tests)

Two groups. The **bank sanity** tests (unique ids; non-empty prompt-like text; every question
in a listed category; ≥ 5 questions per category) exist because the bank is static data that
future edits will touch casually — a duplicated id would silently break the deck's no-repeat
invariant, and an empty category would make `PracticeDeck`'s constructor throw at runtime in
the UI. The **`questionsForCategory`** tests pin the 'all' merge, category filtering, and that
callers get a copy (mutating a result must not corrupt the module-level bank — a classic
shared-static-array bug).

The **`PracticeDeck`** tests pin the dealing contract:

- *deals every question exactly once before reshuffling* — the point of a deck over
  `Math.random` picks: no repeats inside a cycle.
- *keeps dealing after exhaustion* — each subsequent cycle is again a full permutation.
- *never deals the same question twice in a row across many reshuffles* — 25 seeds × 4
  cycles, because the repeat-across-boundary bug only appears when a reshuffle happens to put
  the last-dealt card on top; many seeds actually exercise that path.
- *deterministic for the same injected rng* — documents why the rng is injectable; without
  this the previous tests would be flaky by construction.
- *size/remaining through a full cycle* — pins the lazy-fill counter the UI's "N of M"
  progress label is computed from.

### `answerStats.test.ts` — new file (15 tests)

- **`countWords`** (6): plain sentence, whitespace runs, empty/whitespace-only, markdown
  bullets and dashes ignored, numbers counted, accented letters counted. The bullet/dash test
  matters most: 'bullets' answer mode emits `- ` markers, and counting them would inflate the
  estimate exactly when the user asked for the tersest format.
- **`estimateSpokenSeconds`** (3): zero case; conversion pinned *to the shared
  `SPOKEN_WORDS_PER_SECOND` constant* rather than a hard-coded 2.5, so the test fails if the
  estimate and the prompt's word target ever stop sharing one pace; rounding behavior.
- **`comparePace`** (4): clear short/long; the ±25% acceptance band; exclusive boundaries one
  second outside the band (off-by-one guards); the 5-second tolerance floor at the
  15-second target, which is the only target where the floor and the percentage disagree.
- **`answerStats`** (2): null for nothing-to-measure (the UI hides the line rather than
  showing "~0 s"); the bundled words/seconds/verdict agree with the individual functions.

### `historySearch.test.ts` — new file (9 tests)

`filterHistory` is trivial on purpose, and the tests mostly pin *negative space* — what it
must **not** do:

- empty and whitespace-only queries return everything (the input starts empty; filtering to
  zero rows on load would look like data loss);
- case-insensitive matching in transcript and in answer (the two fields users remember);
- multi-term AND semantics where terms may match *different* fields — the natural way people
  narrow a search;
- no match → empty list, and original order preserved (history is newest-first from the
  store; a filter must not reorder);
- **provider/model ids are not searched** — "gemini" must not return every session that ran
  on Gemini;
- regex metacharacters are literal ("c++" must not throw or mis-match — guards against a
  future refactor to `RegExp`).

### `shortcuts.test.ts` — new file (11 tests)

`resolveShortcut` is the only thing standing between a keystroke and starting/stopping a
recording, so every phase × modifier combination that must *not* fire gets its own assertion:

- Ctrl+L starts from `ready`/`complete`/`failed`, stops during `recording`, and is a no-op in
  all seven busy/unconfigured phases (a double-toggle during `encoding` would corrupt the
  session);
- Cmd+L parity;
- **plain `l` never fires** — the user is usually typing in the transcript or notes field;
- Ctrl+Shift+L and Alt combinations are rejected (reserved/no-accidental-matches);
- Escape cancels in every active phase and only there — Escape at `ready` must not reset
  state someone is reading; modifier+Escape is ignored;
- Ctrl+Shift+C maps to copy, and **plain Ctrl+C is never intercepted** — stealing native copy
  from a text selection would be the most user-hostile bug this feature could have.

### `schemas.test.ts` — 2 added tests

`autoStopOnSilence` must be a boolean in the full settings schema, and must be patchable from
the renderer through `publicSettingsPatchSchema`. The second one exists because the patch
schema is `.strict()` — a field added to the settings object but forgotten in the patch path
would make the Coach toggle throw `UNKNOWN` on every click, and only a test at this layer
catches that before the UI does.

### `stores.test.ts` — 2 added tests

Settings-file compatibility for the new field: a `settings.json` written by a build that
predates `autoStopOnSilence` must load with the default **without discarding the user's other
settings** (the migration merges defaults before validating — this pins that), and a user who
turned the toggle off must find it still off after restart. Both guard the exact upgrade path
every existing install will take.

### `prompt.test.ts` — 1 added test (×3 targets)

The system prompt's word target must be derived from `SPOKEN_WORDS_PER_SECOND` and be a whole
number. Before this round the prompt said "about 37.5 words" for the 15-second target; the
test pins the rounding fix and, more importantly, fails if the prompt and the pace estimate
ever diverge onto different constants — they would then contradict each other in the UI.

### `sessionMachine.test.ts` — 2 added tests

The practice deck writes drawn questions via the `edit-transcript` action, which made its
phase rules load-bearing for the first time:

- allowed in `ready` (practice draw) and `complete` (rewrite-and-regenerate);
- ignored during `transcribing`/`generating`, when the pipeline owns the transcript — a draw
  landing mid-generation would silently desync the visible question from the streaming answer.

---

## Integration tier (`test/integration/`)

### `promptFlow.test.ts` — new file (8 tests)

`prompt.test.ts` proves `buildPrompt` is correct *given its inputs*; these tests prove the
**coordinator actually feeds it the right inputs** after the full pipeline runs. The fake LLM
records every `AnswerRequest`, so assertions run against the literal system/user strings a
provider adapter would serialize onto the wire:

| Test | Why it was added |
|---|---|
| notes fenced on the submit path | The submit path passes `options` through WAV validation, STT, and `generate`; a dropped field anywhere shows up here and nowhere else |
| notes fenced on the regenerate path | Regenerate builds its options separately in the Coach; both call sites are now pinned |
| no notes → no `session_notes` block | The prompt must not contain an empty fenced block for the model to fixate on |
| injection in notes defanged end-to-end | The unit test proves `escapeBlock` works; this proves the coordinator actually routes notes *through* it — the security property users rely on |
| STT transcript fenced on submit | Pins that the transcript the model sees is the transcription result, fenced, not some intermediate |
| profile embedded / absent correctly | `getProfile` is only consulted when `activeProfileId` is set; both sides pinned |
| mode + target shape the system prompt at submit time | The per-session override knobs ("Shorter", "Bullets") must reach the provider, not just the settings defaults |
| grounding rules always present | The never-invent-experience and blocks-are-data instructions are the product's honesty contract; asserting them here means no pipeline change can silently drop them |

### `pipeline.test.ts` — 3 added tests

Prewarm is a main-process latency feature triggered by the `capture:arm` IPC handler. The
handler itself needs Electron (untestable in vitest — see TESTING.md's house pattern), so the
tests pin the coordinator method the handler delegates to:

- *prewarm loads the configured LLM model outside any session* — asserts the correct model id
  reaches `warmup` and that **zero session events** are emitted (there is no session; any
  event would hit the renderer with an unknown sessionId).
- *prewarm swallows warmup failures silently* — best-effort by contract; a cold Ollama must
  not surface an error banner before the user has even finished recording.
- *prewarm is a no-op without warmup support* — providers without `warmup` (or unknown
  providers) must not throw at arm time; the real generate call reports problems with proper
  error mapping.

---

## E2E tier (`test/e2e/`)

### `app.spec.ts` — 3 added tests (in the coach workflow group)

- **practice question → streamed answer → pace stats** — the one test that exercises the new
  features as a user does: draws a question (asserts it is a real prompt-like string and the
  "1 of N" progress renders), sends it through the real renderer → preload → IPC → coordinator
  → fake Ollama path, and asserts the finished card shows the speaking-pace line. Placed in
  e2e because the drawn-question flow crosses the real IPC boundary and the stats line only
  renders on the real `complete` state.
- **session notes reach the model server** — fills the notes field, regenerates, then asserts
  the *fake Ollama's recorded request body* contains the fenced notes text. This is the only
  tier where the assertion covers the full chain including the preload bridge and the real
  Ollama adapter's wire format; the helper (`startFakeOllama`) was extended with `chatBodies()`
  for exactly this.
- **Escape cancels from the keyboard** — the unit tier proves the key maps to `cancel`; this
  proves the window-level listener is actually installed and wired: a slow stream is cancelled
  by pressing Escape with no button click, and the phase chip returns to Ready.

**Helper fix found by running the suite:** `launchApp` now strips `ELECTRON_RUN_AS_NODE` from
the environment it hands the app. VS Code terminals export that variable; inherited by the
child, it makes electron.exe boot as plain Node, which rejects Playwright's
`--remote-debugging-port` flag — every e2e test then fails at launch with
`Process failed to launch!` before reaching any assertion.

Not e2e-tested, deliberately: the endpointer firing (requires real system-loopback audio the
CI/e2e machine cannot produce — the same gap TESTING.md documents for the Listen button; the
capture-path decomposition covers it piecewise), Ctrl+L start (same capture limitation), and
history search (pure filter fully covered at unit tier; an e2e run would only re-test React's
controlled input).

---

## Coverage summary

| Tier | Before | After | Added |
|---|---|---|---|
| Unit | 178 | 235 | +57 (3 new modules' files, endpointing, shortcuts, plus 7 across 4 existing files) |
| Integration | 82 | 93 | +11 (promptFlow.test.ts, prewarm) |
| E2E | 10 | 13 | +3 (practice/stats, notes-on-the-wire, keyboard cancel) |
