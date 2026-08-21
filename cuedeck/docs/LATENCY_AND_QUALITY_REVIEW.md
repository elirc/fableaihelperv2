# CueDeck Latency & Answer-Quality Review

Reviewed: 2026-08-20
Scope: the full `Listen → transcribe → respond` pipeline, prompt assembly, provider adapters,
and the practice deck — focused on (1) end-to-end latency and (2) getting good model responses
to **technical software-engineering questions** (full-stack, primarily JS/TypeScript and C#/.NET),
which is the reviewer's primary interview-prep use case.

This complements the earlier general review in `gpt/APP_REVIEW.md`; findings there
(provider-readiness UI, onboarding gaps, E2E harness) are not repeated here.

---

## TL;DR — the five changes that matter most

| # | Change | Why | Effort |
|---|--------|-----|--------|
| 1 | **Teach the prompt to answer technical questions** — today the system prompt actively suppresses them | Quality: the app is currently a *behavioral* coach; technical questions get hedged or refused | Small (prompt text only) |
| 2 | **Pre-warm the local Whisper model** (it is never warmed today; only the LLM is) | Latency: the first Listen of every app run pays the full ONNX model load inside "transcribing…" | Small |
| 3 | **Upgrade default models for technical Q&A** — 8B/3B models hallucinate .NET/JS specifics; Groq & Cerebras free tiers both offer Llama 3.3 70B | Quality: single biggest accuracy lever, one-line catalog change | Trivial |
| 4 | **Transcribe incrementally while recording** instead of batch-after-stop | Latency: turns transcription from O(clip length) on the critical path into O(final 2 s) | Large |
| 5 | **Set sampling params consistently on all providers** (Groq/Cerebras/OpenRouter currently send *no* temperature or max_tokens) and set `num_ctx` for Ollama | Quality: default temp 1.0 on the exact providers recommended for technical answers; silent context overflow on Ollama | Small |

---

## Implementation status (2026-08-20)

The following findings were implemented the same day, and the full gate (`npm run check`:
format, lint, strict typecheck, 237 unit tests, 95 integration tests) plus a production build
passes:

- **Q1 + Q2 + Q4.2** — split experience/knowledge grounding rules, new `technical` answer mode
  (Coach mode row + follow-up button), transcript-repair instruction (`prompt.ts`).
- **Q3** — Groq default `llama-3.3-70b-versatile`, Cerebras default `llama-3.3-70b` (8B kept as
  the "fastest" fallback in both pickers); Ollama suggestions now lead with
  `qwen2.5-coder:7b-instruct` / `qwen3:8b` (`catalog.ts`).
- **Q4.1** — Groq STT now sends a JS/.NET vocabulary glossary as its Whisper `prompt` bias.
- **Q5** — temperature (0.3 technical/concise, 0.6 otherwise) and a target-derived token budget
  now flow through `AnswerRequest` to every adapter, including Groq/Cerebras/OpenRouter which
  previously sent none.
- **Q6** — Ollama requests set `num_ctx: 8192`.
- **Q8 + Q9** — 30 new technical practice questions in four categories (JS/TS, .NET/C#,
  Web/APIs/data, system design); 90 s and 120 s speaking targets.
- **L1** — capture-arm now pre-warms local Whisper too (never downloads, only loads an installed
  model), and concurrent loads of the same model coalesce instead of restarting.
- **Paid-API testing path** — a Preferences opt-in (`allowPaidModels`, off by default) unlocks
  paid OpenRouter models: prices per million tokens shown in the picker, cheapest first, gated
  in the adapter, billed to the user's own OpenRouter key (set a spend cap at openrouter.ai/keys).
  Groq/Gemini paid tiers work with no app change (same endpoint, upgraded key).

Still open: L2 (speculative / incremental transcription), L3–L5 (endpointer tuning, real-prompt
LLM warmup, FLAC upload), Q7 (previous-exchange context).

---

## Part 1 — Latency

### Where a turn's time actually goes

The pipeline is: endpointer waits for trailing silence → renderer merges/resamples/encodes WAV →
IPC → validate → **STT over the whole clip** → prompt build → LLM stream. Approximate budget for a
15-second question, steady state:

| Stage | Local mode (Whisper Base + Ollama 3B, CPU) | Cloud mode (Groq Whisper turbo + Cerebras/Groq LLM) |
|---|---|---|
| Trailing-silence wait | 1.6 s (fixed) | 1.6 s (fixed) |
| Encode (merge + resample + WAV) | ~10–50 ms | ~10–50 ms |
| Transcribe | **~2–8 s** (scales with clip length) | ~0.5–1.5 s (upload + inference) |
| LLM first token | ~0.3–1.5 s warm | ~0.2–0.6 s |
| **First words on screen** | **~4–11 s** | **~2.5–4 s** |

Two structural facts dominate: transcription starts only after the clip ends, and its cost scales
with clip length. Everything below attacks those two facts first. Things already done well: LLM
warmup fired at capture-arm and again during transcription (`coordinator.ts:128`, `:225`),
Ollama `keep_alive: '15m'`, Gemini `thinkingBudget: 0`, token streaming end to end, and the
status-rail timing split — this is a genuinely well-engineered latency baseline.

### L1. The local Whisper model is never pre-warmed (first-turn cliff)

`SessionCoordinator.prewarm()` (`src/main/sessions/coordinator.ts:128`) warms only the **LLM**.
The STT worker's `ensureModel` is reached exclusively through `transcribe()`
(`src/main/workers/sttWorkerManager.ts:210`), so the first Listen of every app run pays the full
utility-process spawn + ONNX model load + first-inference kernel warm-up **inside** the
"Transcribing…" stage — typically several seconds, and the worst first impression the app makes.

**Fix:**
- At `capture:arm` (`src/main/ipc/register.ts:180`), when `sttProviderId === 'local-whisper'`,
  also fire `sttWorkers.ensureModel(settings.sttModelId, noop, signal)` best-effort, mirroring
  the existing LLM prewarm. Recording lasts many seconds — plenty of cover for the load.
- Optionally also warm at app start when onboarding is complete (bootstrap in `main.ts`), and
  follow the load with a ~0.5 s silent-buffer inference: ONNX Runtime's first run compiles/plans
  kernels, so the first *real* inference is slower than steady state even after the weights load.
- The worker is deliberately killed to free memory (`stop()`); keep that behavior, but only
  reclaim after a long idle (e.g. 10–15 min, symmetrical with `OLLAMA_KEEP_ALIVE`) instead of
  never warming.

**Win:** removes a multi-second cliff from the first turn of every session.

### L2. Batch transcription puts the whole clip on the critical path

The recorder buffers everything and only hands audio over at stop (`recorder.ts:80`). For local
Whisper on CPU, transcription of a long question (30–60 s of interviewer audio) can take longer
than the question itself — and all of it is serialized after the speaker finishes.

**Fix (staged, biggest structural win in the app):**
1. **Speculative early start (small step, real win):** the endpointer knows silence *onset* long
   before it fires at 1.6 s. When continuous silence passes ~600 ms, snapshot the buffered audio,
   encode, and start STT speculatively; if speech resumes, abort (the coordinator already has
   clean abort plumbing). If the endpointer then fires, most or all of the transcript is already
   done — you overlap up to ~1 s of dead wait plus the encode with real work.
2. **Incremental transcription (larger step):** stream PCM chunks to the STT worker during
   recording and transcribe the accumulated audio in rolling passes (Whisper is stateless per
   call; re-transcribing the last ~10 s window and stitching at segment boundaries is the
   standard trick). At stop, only the tail needs a final pass. This turns transcribe latency from
   O(clip) into O(tail) and also enables a live "heard so far" preview in the UI — useful
   feedback that the capture is working.
3. Cloud STT gains less (Groq turbo is far faster than real time), but early upload start still
   removes the encode + connection setup from the tail.

### L3. The endpointer adds a fixed 1.6 s to every single turn

`ENDPOINT_DEFAULTS.trailingSilenceMs = 1600` (`src/shared/endpointing.ts:29`) is a sane default,
but it is a constant tax on every exchange and is not user-tunable. Combined with L2's
speculative start, the *perceived* cost can drop to near zero (the wait overlaps STT). Two
further suggestions:

- Expose trailing-silence (e.g. 1.2 / 1.6 / 2.0 s) in Preferences; interview questions end with
  question intonation and rarely need the full conservative window.
- The fixed RMS thresholds (`speechRms: 0.004`) are tied to system volume. A rolling noise-floor
  estimate (arm relative to the observed floor rather than absolute RMS) would make auto-stop
  robust at low volumes instead of silently never arming.

### L4. Warm the LLM with the real system prompt, not an empty request

Ollama's warmup posts `messages: []` (`ollama.ts:83`) — it loads weights but leaves the KV cache
empty. Ollama reuses the prompt-prefix KV cache between requests when the prefix matches, and the
system prompt is deterministic per mode/target. Warming with the actual system prompt (and
`num_predict: 0` or 1) means the real request's prompt-eval starts at the profile block instead of
token zero. On CPU boxes prompt eval is often the visible chunk of "first token" — this is a cheap
few-hundred-ms win. Keep the stable content (profile) *early* in the user message — it already is —
so the prefix cache keeps helping across turns.

### L5. Smaller items

- **Regenerate path** (`coordinator.ts:204`) never warms the LLM; after a >15 min pause the
  "Respond to edited text" button pays a cold start with no overlapping work. Fire `warmupLlm`
  when the user begins editing the transcript, or at regenerate start (harmless if warm).
- **Groq STT upload:** clips go up as 16-bit WAV (~1.9 MB/min). FLAC halves that losslessly and
  `groqWhisper.ts` already names `clip.flac` as a supported branch; on hotel/interview-day Wi-Fi
  the upload is a real fraction of cloud-STT latency.
- **Duplicate decode:** `coordinator.submit` fully decodes + RMS-scans the WAV, then
  `localWhisper.transcribe` decodes it again (`localWhisper.ts:49`). Milliseconds, not seconds —
  fix only in passing.
- **Show the wait in metrics:** the status rail reports transcribe / first words / total, but not
  the endpointer wait. Adding it makes the fixed 1.6 s visible instead of feeling like app slowness.

---

## Part 2 — Getting good answers to technical SWE questions

This is the larger gap. CueDeck today is tuned as a **behavioral** coach — the prompt, the modes,
the practice deck, the 15/30/60 s pacing, and the default models all assume "tell me about a
time…" questions grounded in the user's profile. Technical interview questions ("explain the
event loop", "difference between `IEnumerable` and `IQueryable`", "how would you scale this
endpoint?") hit three compounding problems: the prompt forbids the knowledge needed, the models
are too small to have it reliably, and the STT layer garbles the vocabulary.

### Q1. The system prompt actively suppresses technical answers

`buildSystemPrompt` (`src/shared/prompt.ts:61`) instructs:

> "Ground every claim in the profile data provided. Never invent experience, employers, job
> titles, metrics, tools, credentials, or personal history. **If the profile does not cover what
> was asked, say so plainly or keep the response generic and honest.**"

That rule is exactly right for claims *about the user* — and exactly wrong for knowledge
questions. Asked "what's the difference between `Task` and `ValueTask`?", a compliant model
should answer from general knowledge; instead it is told to stay generic or disclaim. The fix
costs only prompt text — split the grounding rule by claim type:

```text
Questions come in two kinds; treat them differently:
- Experience questions (about the user's history, projects, skills, opinions): ground every
  claim strictly in the profile data. Never invent experience, employers, metrics, tools,
  credentials, or personal history. If the profile does not cover it, say so plainly.
- Knowledge questions (technical concepts, tools, languages, design, trade-offs): answer
  directly and correctly from general knowledge — the profile is not the source of truth for
  facts about technology. Be specific and concrete, not generic. When an example would help,
  prefer the user's stack as described in role_context.
A single question can mix both (e.g. "have you used X, and how does it work?") — apply each
rule to its part.
```

This keeps the anti-hallucination protection where it protects (the user's biography) and removes
it where it lobotomizes (technical content).

### Q2. Add a `technical` answer mode

`MODE_RULES` (`prompt.ts:34`) offers natural / concise / bullets / STAR / clarify — all shaped for
behavioral answers. Strong spoken technical answers have their own well-known shape. Add:

```ts
technical:
  'For a technical question: give the direct answer in the first sentence, then briefly explain
   how/why it works, then one concrete example (prefer the user's stack from role_context), then
   one trade-off, limitation, or follow-up consideration. Spoken style, no code unless asked.',
```

and surface it in the Coach mode row + follow-up buttons (`AnswerMode` union in
`domain.ts:13`, mode buttons in `Coach.tsx`). Answer-first ordering matters doubly here because
answers stream: the user can start speaking the first sentence while the rest renders.

### Q3. Default models are too small for technical accuracy

Current defaults (`src/shared/catalog.ts:131`): Ollama suggestions `qwen2.5:3b` / `llama3.2:3b` /
`phi3.5:3.8b`; Groq pinned to `llama-3.1-8b-instant`; Cerebras to `llama3.1-8b`. 3B–8B models are
fine for rephrasing behavioral talking points, but they routinely fabricate .NET APIs, confuse
`IEnumerable`/`IQueryable` semantics, and produce shallow system-design answers — the exact
content this user needs to trust.

**Recommendations** (verify current free-tier IDs at release time — the catalog header says IDs
were last verified 2026-07-10):

| Slot | Today | Recommend | Note |
|---|---|---|---|
| Groq free tier | `llama-3.1-8b-instant` | `llama-3.3-70b-versatile` | Same free tier; Groq speed keeps 70B first-token well under a second |
| Cerebras free tier | `llama3.1-8b` | `llama-3.3-70b` | Cerebras streams ~2000+ tok/s; 70B stays effectively instant |
| Gemini | `gemini-2.5-flash`, thinking off | keep — but allow a "let it think" toggle | A small thinking budget measurably helps hard system-design questions; latency trade-off should be the user's choice per question |
| Ollama suggestions | 3B instruct models | add `qwen2.5-coder:7b-instruct` / `qwen3:8b` for machines with ≥16 GB RAM | Keep a 3B as the low-RAM option; `capabilities()` already reports `totalMemoryMb`, so the UI can recommend by RAM |

For this user specifically: **Cerebras or Groq with a 70B model is the sweet spot** — materially
better technical answers than local 3B at *lower* latency than local inference. The catalog
change is one line per provider.

### Q4. STT garbles technical vocabulary, and nothing corrects it

Whisper Tiny/Base mis-hears exactly the words that matter: "IEnumerable" → "I innumerable",
"LINQ" → "link", "useEffect" → "use effect", "idempotent" → "item potent". A wrong transcript
then produces a confidently wrong answer. Three cheap layers of defense:

1. **Bias the cloud transcriber.** Groq's transcription endpoint accepts a `prompt` field that
   biases decoding; `groqWhisper.ts` doesn't send it. Pass a short glossary assembled from a
   built-in SWE term list (JS/TS + .NET: `IEnumerable, IQueryable, LINQ, EF Core, ASP.NET,
   middleware, async/await, closure, event loop, React, hooks, useEffect, TypeScript, Kubernetes,
   idempotent, …`) plus the session notes (which already carry company/role context).
2. **Let the LLM repair the transcript.** Add one system-prompt line: *"The transcript comes from
   speech recognition and may mis-hear technical terms; infer the intended term from context
   (e.g. 'I innumerable' → IEnumerable) instead of answering the literal words."* Large models do
   this reliably; it is free.
3. **Steer model choice by session type.** For technical sessions recommend Whisper Small locally
   or Groq `whisper-large-v3-turbo` — the accuracy gap between Tiny/Base and Small is largest on
   domain vocabulary. Worth a sentence in the README and in the Preferences model picker.

### Q5. Sampling parameters are inconsistent — and absent on the best providers

- **Ollama** (`ollama.ts:107`): `temperature: 0.6`, `num_predict: 700`.
- **Gemini** (`gemini.ts:109`): `temperature: 0.6`, `maxOutputTokens: 1024`.
- **Groq / Cerebras / OpenRouter** (`openAiCompatible.ts:64`): **no temperature, no max_tokens** —
  provider defaults apply (typically temperature 1.0), i.e. the highest-variance settings on
  precisely the providers recommended above for technical answers.

**Fix:** set params in one shared place (the request builder in `streamChatCompletions` plus each
adapter) rather than per-adapter drift:
- `temperature` ~0.3 for `technical`/`concise` modes, ~0.6 for `natural`/`star`.
- Derive max tokens from the target instead of hardcoding: the prompt already computes a word
  target (`targetSeconds × 2.5 words/s`); tokens ≈ words × 1.4 plus ~40% headroom. This also
  fixes the current mismatch where Ollama's `num_predict: 700` (~2,800 chars) silently truncates
  long STAR answers mid-sentence well before `ANSWER_CHAR_CAP` (4,000 chars) — nothing tells the
  user the answer was cut.

### Q6. Ollama context window can silently swallow the system prompt

No `num_ctx` is set on the Ollama request. Many Ollama models default to a 2048–4096-token
context, while the transcript alone is allowed 40,000 chars (~10k tokens, `prompt.ts:32`) plus
profile and notes. On overflow Ollama truncates *from the front* — the system prompt (with all the
grounding and injection-defense rules) is the first thing to go, silently. Set
`options.num_ctx: 8192` explicitly, and cap profile + notes at prompt-assembly time the way the
transcript already is.

### Q7. No conversation memory, so follow-up questions get blind answers

Every session is independent. Real interviews chain: "…and how would you scale that?" /
"what's the downside of the approach you just described?" get answered with zero knowledge of
what was just said. Keep the last 1–2 exchanges (transcript + chosen answer) in coordinator
session state and include them as a fenced `<previous_exchange>` block in the user prompt (same
escaping discipline as the other blocks), cleared with Clear/session end and off by default if
prompt size is a concern. This is the single biggest *realism* improvement for mock-interview
flow, and it reuses the existing fencing machinery.

### Q8. The practice deck has zero technical questions

All 30 questions in `src/shared/practice.ts` are behavioral/motivation/curveball. For a full-stack
JS/.NET user, add technical categories — pure data change, works fully offline like the rest of
the deck. Suggested starter set:

- **JavaScript/TypeScript:** event loop & microtasks; closures; `==` vs `===` and coercion;
  `var`/`let`/`const` + TDZ; promises vs async/await error handling; prototypal inheritance;
  TypeScript generics & `unknown` vs `any`; debounce vs throttle.
- **C#/.NET:** `IEnumerable` vs `IQueryable`; `async`/`await` and `ConfigureAwait`; `Task` vs
  `ValueTask`; DI lifetimes (transient/scoped/singleton); middleware pipeline order; EF Core
  tracking vs no-tracking; garbage collection generations; `record` vs `class`.
- **Web/API:** HTTP caching headers; idempotency & safe methods; CORS; REST vs RPC trade-offs;
  authN vs authZ, JWT pitfalls; pagination strategies.
- **Data/System design:** SQL indexing basics & N+1; transactions/isolation levels; horizontal
  vs vertical scaling; caching layers & invalidation; queue-based load leveling; designing a
  rate limiter / URL shortener (classic warm-ups).

### Q9. Pacing targets don't fit technical answers

`TargetSeconds = 15 | 30 | 60` (`domain.ts:16`). A good spoken answer to a system-design or
architecture question runs 90–120 s; at 60 s max the prompt (75–150-word target) forces
superficial answers, and the pace verdict flags any thorough answer as "long". Add 90 and 120,
and consider defaulting the `technical` mode to 60–90.

---

## Priority roadmap

| Priority | Item | Type | Effort |
|---|---|---|---|
| 1 | Q1 + Q2 + Q4.2 — technical-question prompt rules, `technical` mode, transcript-repair line | Quality | Small — prompt/text only |
| 2 | Q3 — 70B free-tier defaults (Groq/Cerebras), coder-model Ollama suggestions | Quality | Trivial |
| 3 | L1 — pre-warm local Whisper at capture-arm (+ app start) | Latency | Small |
| 4 | Q5 + Q6 — unified sampling params, target-derived max tokens, `num_ctx` | Quality | Small |
| 5 | Q8 + Q9 — technical practice categories; 90/120 s targets | Quality | Small (data) |
| 6 | L2.1 — speculative STT start at silence onset | Latency | Medium |
| 7 | Q7 — previous-exchange context for follow-ups | Quality | Medium |
| 8 | Q4.1 — Groq STT `prompt` glossary biasing | Quality | Small |
| 9 | L3 + L4 + L5 — endpointer tuning/adaptivity, real-prompt LLM warmup, FLAC upload | Latency | Small each |
| 10 | L2.2 — incremental transcription during recording (+ live preview) | Latency | Large |

Items 1–5 are roughly a day of work combined and would transform the app for its actual intended
use; item 10 is the flagship engineering project when latency next needs a step change.
