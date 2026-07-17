# GPT review of CueDeck

Reviewed: 2026-07-10  
Scope: product concept, onboarding and coach UI, provider setup, privacy/security architecture,
storage, prompts, packaging, and automated tests.

## Overall assessment

CueDeck is a strong, unusually responsible MVP. Its best quality is not any single AI feature;
it is the consistency between the product promise and the implementation. Local processing is the
default, cloud use is explicit, recording is visible, history is opt-in, secrets are isolated, and
the code has tests for the failure paths that many early AI apps ignore.

The main weakness is readiness for ordinary users. The core flow can work, but the app still asks
users to understand models, providers, API keys, Ollama, and audio capture. It also treats completed
onboarding as equivalent to a working configuration. That makes the product feel more finished in
engineering terms than it is in day-to-day usability and release operations.

**Verdict:** a credible technical MVP and a good foundation for a trustworthy product, but not yet
a frictionless consumer release.

## What is good

### Product and ethics

- The intended use is clear: practice, accessibility, and disclosed assistance. The app explicitly
  rejects covert recording and prohibited assessment use instead of hiding those concerns in legal
  text.
- The free/local-first positioning is genuinely implemented. Local Whisper and Ollama are the
  defaults; there is no mandatory account, hosted backend, subscription, or telemetry.
- Recording requires a deliberate action and has a persistent, high-contrast indicator. This is a
  good trust feature as well as an ethical safeguard.
- History is off by default, raw audio is not stored, and users can control retention, deletion, and
  export.
- Generated answers are framed as editable cues, not authoritative output. The transcript can be
  corrected before regeneration, and useful transformations such as Shorter, Bullets, and STAR are
  one click away.

### User experience

- The central workflow is easy to understand: Listen, Stop & respond, review the transcript, then
  copy or regenerate the answer.
- Live audio level, elapsed time, silence warning, streaming text, cancellation, and structured
  errors provide good feedback during a multi-stage operation.
- Compact mode, adjustable font size, visible focus styles, reduced-motion handling, semantic
  status regions, and minimum button sizes show real accessibility awareness.
- Provider disclosures appear at the point of selection, where they are more useful than a privacy
  policy alone.
- Diagnostics are privacy-conscious: sensitive profile/transcript data is excluded unless the user
  explicitly opts in.

### Engineering

- The Electron security boundary is well designed: sandboxed renderer, context isolation, no Node
  integration, a fixed preload API, sender checks, schema validation, navigation denial, CSP,
  outbound URL allowlists, and hardened Electron fuses.
- Credentials are write-only from the renderer and encrypted with Windows account protection.
- Session IDs, event sequencing, abort signals, timeouts, and suppression of late events make the
  asynchronous audio/STT/LLM pipeline much safer and more predictable.
- Provider adapters are separated behind contracts, and cloud model IDs are centralized rather
  than scattered through the codebase.
- Prompt inputs are clearly fenced as untrusted data, with explicit anti-invention rules. This does
  not guarantee truthful model output, but it is the right baseline.
- The test suite is substantive. The current standard check passes formatting, linting, strict type
  checking, 93 unit tests, and 33 integration tests. Tests cover security, storage, audio, streaming,
  provider errors, retry behavior, cancellation, and prompt construction—not only happy paths.
- Packaging, checksums, privacy documentation, security documentation, and third-party notices are
  already present. That is excellent release hygiene for version 0.1.0.

## What could be better

### High priority

1. **The coach can say “Ready” when its providers are not ready.** `Coach.tsx` derives readiness
   from `onboardingComplete`, not from live STT and LLM probes. A removed model, stopped Ollama
   process, expired key, or lost network connection is discovered only after the user records a
   clip. Probe the selected providers on startup and after settings changes; disable Listen or show
   a precise degraded state until transcription is available.

2. **The OpenRouter onboarding path can produce an incomplete setup.** OpenRouter handles responses
   only, so speech-to-text stays local. The cloud setup checks OpenRouter but does not ensure that a
   local Whisper model is installed. A user can finish onboarding and then fail on the first clip.
   The flow should explicitly add and verify the local STT download before continuing.

3. **The current E2E suite is broken at launch.** `npm run test:e2e` builds successfully, but all 10
   tests fail before their assertions because Playwright launches Electron with
   `--remote-debugging-port=0`, which the installed Electron executable rejects as a bad option.
   This appears to be a Playwright/Electron compatibility problem, not 10 independent product
   failures, but it means the implementation report's “10/10” result is not currently reproducible.
   Pin a known-compatible pair or update the harness, then make this suite part of the normal check.

4. **Real-world validation is still the largest unknown.** Automated provider tests use local fake
   servers, and the implementation report correctly lists loopback audio, real Whisper inference,
   real Ollama/cloud providers, clean install/upgrade/uninstall, and offline use as manual work.
   These checks should be release blockers because they validate the actual product promise.

5. **Local setup is too technical for the target audience.** Requiring users to install Ollama,
   open a terminal, and run a model-pull command is a large drop-off point. Provide OS-appropriate
   step-by-step guidance, copyable commands, recommended model sizing based on available RAM, and a
   single “Check setup” result that explains exactly what remains.

6. **Model downloads are checked by file size, not cryptographic hash.** The local model manifest
   detects missing or truncated files, but not same-size tampering or upstream replacement. Pin a
   model revision and verify trusted hashes where the model distribution mechanism permits it.

### Medium priority

7. **The onboarding is honest but text-heavy.** Consent and cloud disclosures matter, yet the user
   meets several dense screens before experiencing value. Use shorter summaries with expandable
   detail, show progress such as “Step 2 of 5,” and preserve/recover the current step after a restart.

8. **Setup and runtime failures need more direct recovery.** Errors can open Preferences, but that
   action does not deep-link to the failing provider or automatically rerun its check. Error actions
   should say things like “Start Ollama,” “Download Whisper Base,” “Replace API key,” or “Retry.”

9. **Destructive actions lack confirmation or undo.** Profile deletion, individual history deletion,
   and Delete all execute immediately. Add confirmation for bulk deletion and a short undo window for
   single-item deletion.

10. **The app offers little help judging an answer.** The prompt asks models not to invent experience,
    but users cannot see whether an answer is grounded in their profile or generic. Consider a small
    “Profile used / no matching profile detail” indicator and make the limitation clear without
    cluttering the response card.

11. **Provider policy and model metadata can go stale.** Free-tier quotas, data-use terms, model IDs,
    and recommended Ollama models are hardcoded. Keep a dated review checklist, link to the current
    provider terms in the UI, and treat provider-catalog validation as release maintenance.

12. **The release story is incomplete.** Unsigned Windows installers will trigger SmartScreen, and
    there is no visible update mechanism. Checksums are good for technical users but will not solve
    mainstream trust or safe upgrade adoption. Code signing and a signed update channel should be
    post-MVP priorities.

13. **Some interface operations fail silently.** Many settings updates and clipboard/export actions
    assume success. Add a consistent toast/status pattern and restore the previous UI value when a
    write fails.

### Lower priority and polish

- Add keyboard shortcuts for Listen/Stop, Cancel, Copy, and compact mode, while preventing accidental
  capture and showing the shortcuts in the UI.
- Clarify wording that says capture lasts “while you hold” Listen; the implemented interaction is
  click-to-start and click-to-stop.
- Add an empty-state example showing what a useful profile contains. Better profile input will likely
  improve answer quality more than another response mode.
- Add narrow-window/responsive treatment for the Preferences sidebar and long provider/model names.
- Show estimated download time, disk use, and a clearer loading phase for first local inference.
- Consider separate status for “transcription ready, response model unavailable,” since transcript-
  only use is intentionally supported.
- Add visible app-version and links to the privacy/security documents in the About screen.

## Suggested order of work

1. Repair the Playwright/Electron E2E launch and restore a reproducible release gate.
2. Make provider readiness truthful and repair the OpenRouter onboarding path.
3. Complete the manual hardware/provider/install test matrix and fix findings.
4. Reduce local setup friction and improve actionable recovery messages.
5. Add model revision/integrity controls and a provider-metadata review process.
6. Add confirmations, failure notifications, keyboard shortcuts, and onboarding polish.
7. Plan code signing and updates before promoting the app to nontechnical users.

## Scorecard

| Area                 | Assessment                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| Product concept      | Strong and differentiated by trust/local-first design                                                          |
| Core workflow        | Clear, with good feedback and cancellation                                                                     |
| Onboarding           | Responsible but too technical and text-heavy                                                                   |
| Privacy and security | Excellent for an MVP, with a model-integrity gap                                                               |
| Accessibility        | Good baseline; keyboard workflow can improve                                                                   |
| Reliability          | Strong unit/integration foundation; E2E launch is currently broken and real hardware/services still need proof |
| Maintainability      | Clean separation, strict types, and meaningful tests                                                           |
| Release readiness    | Suitable for technical testers; not yet a polished public release                                              |
