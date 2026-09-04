# Real-call test guide (production build, Groq free tier)

The full runbook for the first test of the **installed** CueDeck build, using one free Groq key
for both speech-to-text and responses. Every screen name, button label, and message quoted here
is the literal text in the app, so you can match what you see against what should happen.

Budget about 45 minutes: 10 to prepare, 10 to install and set up, 15 for the dry run, then the
call itself.

Reminder before anything else: CueDeck records what this computer **plays** (the other
participant), never your microphone. A recording indicator is visible the whole time capture is
active, and the app has no concealment features. You are responsible for telling participants
and for the rules that apply to your call — including proctored assessments, where any outside
help is prohibited. See [PRIVACY.md](../PRIVACY.md).

---

## Part 0 — Prepare (do this before the day of the call)

### 0.1 What you need

| Item                      | Detail                                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows 10 or 11, x64     | CueDeck is Windows-only (system loopback audio, DPAPI key storage).                                                                                  |
| The installer             | `out/make/squirrel.windows/x64/CueDeck-Setup.exe` plus `out/make/SHASUMS256.txt`, both from `npm run release`.                                       |
| A Groq API key            | Free plan, no credit card. Steps in 0.2.                                                                                                             |
| A second screen or window | The coach window needs to be visible while you are on the call. A second monitor is ideal; otherwise use compact mode plus always-on-top (Part 2.4). |
| 15 minutes of test audio  | Any mock-interview video on YouTube works for the dry run.                                                                                           |
| Optional: a Gemini key    | <https://aistudio.google.com/apikey>, also card-free. Configure it as the backup response model so one provider's rate limit cannot end your call.   |

Ollama and the local Whisper download are **not** needed for this test. Everything runs through
Groq.

### 0.2 Get the Groq key

1. Go to <https://console.groq.com/keys> and sign in (email or GitHub).
2. Stay on the **Free** plan. The Developer plan is pay-as-you-go and only raises limits; you do
   not need it, and the free plan never asks for a card.
3. Click **Create API Key**, name it something like `cuedeck`, and copy the value. It starts with
   `gsk_`. The console shows it once — paste it somewhere safe before closing the dialog.
4. Sanity-check the key from PowerShell before you install anything:

   ```powershell
   $key = "gsk_your_key_here"
   curl.exe -s -H "Authorization: Bearer $key" https://api.groq.com/openai/v1/models |
     Select-String -Pattern "gpt-oss-120b"
   ```

   A line containing `openai/gpt-oss-120b` means the key works and the model CueDeck defaults to
   is available to you. An empty result or a 401 means the key is wrong.

### 0.3 Understand what gets captured (this is the part people get wrong)

CueDeck captures the **output** of your default playback device — what Windows is sending to your
speakers or headphones. That means:

- **The other participant's voice is captured.** Their audio comes out of your speakers, so it is
  in the loopback stream.
- **Your own voice is not captured.** CueDeck never opens the microphone. The transcript contains
  only what you heard, which is exactly what you want to answer.
- **Everything else the PC plays is captured too** — notification chimes, another browser tab, a
  music player. Mute or close them before the call, and turn on Windows **Do not disturb**
  (Settings → System → Notifications) so a chime does not land in the middle of a question.
- **Headphones work fine.** Loopback follows the render device, not the speakers physically making
  sound.

Audio-quality notes that affect transcription accuracy:

- A **Bluetooth headset used as both mic and speaker** drops into hands-free mode, which
  downgrades playback to narrowband mono. Whisper's accuracy suffers noticeably. Prefer wired
  headphones, or use the laptop's built-in mic with Bluetooth headphones in music mode.
- **Set your output device before starting** and do not change it mid-call. Capture attaches to
  the device that was default when the clip began.
- Keep system volume at a normal level. Very low volume can fall under the silence threshold and
  produce "The recording was silent."

### 0.4 Decide the consent wording

Have a sentence ready, and say it before the substantive conversation begins. Something like:

> "Before we start — I use a live transcription assistant that captures this call's audio on my
> machine to help me organise my answers. Are you comfortable with that?"

If the answer is no, close CueDeck. If the call is a proctored assessment or the organiser has
said no outside help, do not run this test on it — use the practice deck and a mock-interview
video instead (Part 3), which exercises exactly the same pipeline.

---

## Part 1 — Build, verify, install

### 1.1 Build the installer (skip if you already have it)

```powershell
cd C:\Users\E\Desktop\helperv2\fableaihelperv2\cuedeck
npm run check          # optional but fast: format, lint, types, 299 + 149 tests
npm run release        # electron-forge make, then SHASUMS256.txt
```

Output lands in `out/make/`:

```text
out/make/squirrel.windows/x64/CueDeck-Setup.exe    ~171 MB, the installer
out/make/squirrel.windows/x64/cuedeck-0.1.0-full.nupkg
out/make/zip/win32/x64/CueDeck-win32-x64-0.1.0.zip  portable, no installer
out/make/SHASUMS256.txt                             checksums for all of the above
```

### 1.2 Verify the download

```powershell
cd out\make
Get-FileHash .\squirrel.windows\x64\CueDeck-Setup.exe -Algorithm SHA256
Get-Content .\SHASUMS256.txt
```

The hash must match the `CueDeck-Setup.exe` line. This matters because the installer is unsigned:
the checksum is the only integrity check there is.

### 1.3 Install

1. Run `CueDeck-Setup.exe`.
2. SmartScreen will say **"Windows protected your PC"** because the binary is unsigned. Click
   **More info → Run anyway**. This warning is expected on every build until code signing is
   funded.
3. Squirrel installs to `%LocalAppData%\cuedeck\`, creates a Start-menu shortcut, and launches the
   app itself. There is no install wizard and no options to choose.

**Pass:** a window titled **CueDeck** opens showing **"Welcome to CueDeck"**.

**If nothing appears:** run it from a terminal so you can see the error text —

```powershell
& "$env:LocalAppData\cuedeck\cuedeck.exe"
```

**Starting completely fresh:** close the app and delete `%APPDATA%\CueDeck\`. That removes
settings, the encrypted key, profiles, history, and any downloaded models, and re-triggers
onboarding. (`%LocalAppData%\cuedeck\` is the program itself; `%APPDATA%\CueDeck\` is your data.)

---

## Part 2 — First-run setup, screen by screen

### 2.1 Welcome to CueDeck (consent)

Read the warning panel, tick **"I am responsible for obtaining participant consent and following
the rules that apply to my calls, interviews, and jurisdiction."**, then click
**I understand — continue**. The button stays disabled until the box is ticked.

### 2.2 Choose how CueDeck processes audio

Two options: **Local — always free, private (recommended)** and **Cloud free tier — easier on
older computers**. For this test choose the **cloud** option. (Local is genuinely better for
privacy, but it needs a Whisper download and Ollama, and it is slower — test it another day.)

### 2.3 Cloud free tier

1. **Provider**: select **Groq (fast; audio + responses)**.
2. Read the disclosure banner: audio clips and transcripts go to Groq; free-plan quotas apply.
3. Paste the key into **API key (stored encrypted with Windows account protection; removable any
   time)**.
4. Click **Save and test**.

| What you see                                          | What it means                                                                                                    |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **✓ Provider is reachable.**                          | Key is good and Groq is up. **Continue** is now enabled — click it.                                              |
| `Provider check: missing-credential API key rejected` | The key is wrong or revoked. Re-copy it from the Groq console; it begins `gsk_`.                                 |
| `Provider check: unreachable …`                       | A firewall, proxy, or VPN is blocking `api.groq.com`. CueDeck has no proxy setting; fix it at the network level. |
| `Provider check: quota-limited`                       | You are already rate-limited on this key. Wait a minute and press **Save and test** again.                       |

If the check fails you can still press **Continue anyway** — but note that the app then leaves
your providers unchanged (it only switches to Groq after a successful check), so you would end up
in local mode needing the Whisper download. Prefer to fix the key.

### 2.4 Test system audio

1. Start playing something with speech on this PC (a YouTube video) and leave it playing.
2. Click **Run 5-second test**. A **Recording test** indicator appears and the level meter moves.

| Result                                                                                               | Next step                                                                                                                            |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **✓ System audio is healthy.**                                                                       | Click **Continue**.                                                                                                                  |
| **"The test heard only silence. Make sure audio is playing and the right output device is active."** | Audio is going to a different device, volume is very low, or playback stopped. Check the Windows volume mixer, then re-run the test. |
| **"Capture failed. Try again, or continue and use diagnostics later."**                              | Re-run once. If it persists, continue and check Preferences → Diagnostics after setup.                                               |

### 2.5 Add your background (optional — but do it)

This is the single biggest lever on answer quality. The model is instructed never to invent
experience you did not list, so a thin profile produces vague answers and a detailed one produces
answers you could actually say.

- **Profile name** — anything, e.g. `Backend interviews`.
- **Your background / resume summary** — aim for 200–500 words. Include employers with dates,
  the stack you actually used, two or three projects with concrete numbers (team size, scale,
  latency, cost), and the outcomes. Write it in first person.
- **Role or call context (job description, account, meeting goal)** — paste the job description
  or a summary of it, plus what you want to emphasise.

Click **Finish setup**. You land on the coach window.

### 2.6 Confirm the wiring

Open **Settings** (top right of the coach window) → **Providers**. Under **Processing summary**
you should see speech-to-text `groq-whisper` (cloud) and responses `groq` (cloud). At the bottom
of the coach window the status rail should read something like:

```text
groq-whisper (whisper-large-v3-turbo) • openai/gpt-oss-120b via groq
```

---

## Part 3 — Tune before the call (5 minutes)

### 3.1 Preferences → General

| Setting                                                             | Recommended for a live call                                                                                                       |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Keep the coach window on top of other windows**                   | **On** if you have one screen. It keeps CueDeck visible over the meeting window.                                                  |
| **Compact coach layout (recording indicator always stays visible)** | **On** for one screen — hides the practice, transcript, notes and mode cards, leaving capture controls plus the answer.           |
| Conversation context (last two exchanges)                           | **On**. Follow-ups like "and how would you scale that?" only work with it.                                                        |
| **Text size**                                                       | Raise to 110–125% if you are reading from across a desk.                                                                          |
| **Maximum clip length**                                             | 90 seconds is fine. Only raise it if questions in your interviews routinely run longer.                                           |
| **Target speaking time**                                            | **30 seconds** for behavioural questions; **90 seconds (technical explanations)** for deep technical rounds. Changeable mid-call. |
| **Transcription language**                                          | Set **English** explicitly rather than "Detect automatically" — it is slightly faster and avoids mis-detection on short clips.    |

### 3.2 Preferences → Providers → Backup response model

Free tiers rate-limit at the worst moment. Setting a backup on a _different_ provider means one
limit cannot end your call.

1. Expand **Backup response model (used only if the primary fails)**.
2. **Backup provider**: Gemini. If no key is saved yet, scroll to **Cloud API keys (optional)**,
   paste the Gemini key next to **Gemini**, click **Save**, and accept the disclosure — free-tier
   Gemini content may be used to improve Google products.
3. Back in the backup section click **Check & list models** and choose `gemini-2.5-flash`.

The backup is used only when the primary fails **before producing any text**; when it answers, the
status rail says `(backup — primary failed)`.

### 3.3 Test both providers now, not during the call

In **Preferences → Providers**, click **Test speech-to-text** and the **Test** button next to each
saved key. All should report ready.

### 3.4 Session notes (on the coach window, expanded layout)

Before the call, type the company, role, and two or three points you want to land into
**Session notes**. It is sent with every request and cleared when the app closes — nothing is
stored. Example:

```text
Acme Corp, senior backend role. Emphasise the payments migration (12M rows, zero downtime)
and mentoring two juniors. Keep answers concrete, no buzzwords.
```

---

## Part 4 — Dry run (do this before any real call)

Two passes: one without audio to check the response path, one with audio to check the whole
pipeline. Nothing here needs a real participant.

### 4.1 Response path only (no audio needed)

1. In the **Practice** card pick a category (60 questions across Background, Behavioral,
   Motivation, Teamwork, Curveballs, JavaScript & TypeScript, .NET & C#, Web APIs & data, System
   design) and click **Draw a question**.
2. The question lands in the **Heard** box. Answer it out loud yourself first — that is the point
   of the deck.
3. Click **Respond to edited text**. An answer should stream in within about a second.
4. Check the stats line under the answer, e.g. `~29 s spoken (73 words) — about right for your 30 s target`.
5. Try the mode buttons: **Shorter**, **Bullets**, **STAR**, **Technical**, **More concise**,
   **Try again**.
6. Click **Interviewer follow-up**. It should produce a sensible next question based on what was
   said and drop it into **Heard**.

If all of that works, your key, model, prompt, and profile are correct.

### 4.2 Full pipeline with audio

Play a mock-interview video and work through this table. This is the part that matters — item 4 in
particular re-checks a bug fixed this week.

| #      | Do                                                                                   | Pass when                                                                                                                                                                                   |
| ------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | Press **Listen** (or `Ctrl+L`) as a question starts; let the speaker finish.         | The **Recording** dot appears, the timer counts up, the level meter moves. About 1.6 s after the speaker stops, capture ends by itself and the answer streams in.                           |
| **2**  | Read the **Heard** box.                                                              | The question is transcribed accurately, including technical terms.                                                                                                                          |
| **3**  | Read the status rail after the answer.                                               | Something like `2.3 s total (transcribed during the pause) (0.8 s to first words)`. First words under ~2.5 s on a normal connection.                                                        |
| **4**  | Press **Listen**, then `Esc` within a second, while the chip still says "Starting…". | The Recording dot never appears or disappears immediately, the chip returns to **Ready**, and nothing is sent. **The dot must not stay on.**                                                |
| **5**  | Press `Esc` while an answer is streaming.                                            | Streaming stops within a moment; no further text appears afterwards.                                                                                                                        |
| **6**  | Click into the **Heard** box, type a word, press `Esc`, then press `Esc` again.      | The first `Esc` just leaves the text box (no cancel); the second cancels if something is running.                                                                                           |
| **7**  | Ask a follow-up question via the video, or click **Interviewer follow-up**.          | The **Heard** header shows `context: 1 exchange`, then `context: 2 exchanges`; the answer refers to what was said before.                                                                   |
| **8**  | Open **Settings**, change **Target speaking time**, close Preferences.               | The next answer's stats line compares against the **new** target. (Settings now propagate between windows.)                                                                                 |
| **9**  | Click **Clear** on the Response card.                                                | Answer and transcript clear, `context: …` disappears, and the next question is answered with no memory of the earlier ones.                                                                 |
| **10** | Type into **Session notes**, then ask a question.                                    | The answer visibly reflects the notes (mentions the company or the points you listed).                                                                                                      |
| **11** | Toggle **Compact** in the header.                                                    | Practice, Heard, notes and mode cards hide; capture controls, the recording indicator and the answer stay visible.                                                                          |
| **12** | Turn off Wi-Fi, press **Listen**, let a question play.                               | A red banner appears with a real message and a **Dismiss** button. With a backup configured and reachable it would answer instead; offline, expect `The provider is currently unavailable.` |
| **13** | Turn Wi-Fi back on, click **Dismiss**, ask another question.                         | Recovers cleanly to **Ready** and answers normally.                                                                                                                                         |
| **14** | Open **Settings → Diagnostics**.                                                     | The report lists app/Electron/OS versions and any recent errors in readable form, with **no key material** anywhere.                                                                        |

If item 4 fails — the Recording dot stays on after cancelling — stop and report it. That is the
consent-visible behaviour and it is the one regression worth blocking on.

---

## Part 5 — The real call

### 5.1 Five minutes before

1. Close music, other video tabs, and anything that makes noise. Turn on **Do not disturb**.
2. Confirm your output device and volume, and do not change them afterwards.
3. Open CueDeck, check the chip reads **Cloud • Ready** and the status rail names Groq.
4. Fill in **Session notes** for this specific call.
5. Position windows: with one screen, turn on always-on-top and compact mode and park CueDeck in a
   corner. With two screens, keep the expanded layout on the second screen.
6. Have your consent sentence ready.

### 5.2 The loop, per question

1. Press `Ctrl+L` (or click **Listen**) when the other person starts asking.
2. Keep quiet and let them finish. Auto-respond fires after the pause length you chose; you can
   also press `Ctrl+L` again to stop immediately.
3. Read the answer as it streams. Use it as a prompt, not a script — speak in your own words.
4. If the answer is off: **Shorter**, **More concise**, **Technical**, **STAR**, or **Try again**
   re-runs on the same transcript in about a second.
5. `Ctrl+Shift+C` copies the answer if you want it elsewhere.
6. `Esc` cancels anything in flight.

### 5.3 Tuning while you are live

- Firing mid-sentence (answers start while they are still talking)? Switch the pause length select
  to **Patient pause (2.4 s)**.
- Feels sluggish and their questions are crisp? **Quick pause (1.0 s)**.
- Want full manual control? Untick **Auto-respond when the speaker pauses** and use `Ctrl+L` to
  start and stop.
- Long, layered question? Nothing to do — clips run up to 90 seconds.

### 5.4 What the status rail is telling you

```text
groq-whisper (whisper-large-v3-turbo) • openai/gpt-oss-120b via groq • 2.3 s total (transcribed during the pause) (0.8 s to first words)
```

- **transcribed during the pause** — speculative transcription paid off; the transcript was ready
  before you stopped recording. This is the good case.
- **(1.4 s transcribe)** — the transcript had to be produced after you stopped, so the turn was
  slower. Usually means the speaker had no clear pause.
- **(backup — primary failed)** — Groq failed and Gemini answered.

### 5.5 Free-tier headroom

| Limit (Groq free plan)                   | What it means in a call                                                                |
| ---------------------------------------- | -------------------------------------------------------------------------------------- |
| Responses: 30 requests/min, 1,000/day    | Far more than a conversation produces.                                                 |
| Responses: 8,000 tokens/min, 200,000/day | ~1.5–2.5K tokens per answer, so **3–4 answers per minute** is the real ceiling.        |
| Whisper: 20 requests/min                 | Each Listen costs up to 4 requests (3 speculative passes plus the final one).          |
| Whisper: 7,200 audio-seconds/hour        | Speculation can bill a question up to ~3× its length, so roughly 80 questions an hour. |

An hour-long interview does not come close to any of these. If you do hit one, the banner reads
`The provider rate-limited this request. Wait a moment and try again.` — CueDeck already retried
once automatically, and switches to the backup model when one is configured.

---

## Part 6 — Failure playbook

Every message below is the literal banner text.

| Message                                                                                                                | Cause                                                                                 | Do this                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **"The recording was silent. Check that the right output device is playing audio."**                                   | Nothing audible in the clip.                                                          | Check the Windows volume mixer and that the meeting app is playing to your default device. Raise system volume.                                                                                                              |
| **"No audio detected yet — check that the conversation audio is playing on this computer."** (yellow, while recording) | Same, caught live.                                                                    | Do not wait for the clip to end — press `Esc`, fix the audio, start again.                                                                                                                                                   |
| **"Nothing intelligible was heard in the clip."**                                                                      | Audio was present but not speech, or far too quiet.                                   | Usually a very short or noisy clip. Retry; if it repeats, check for a Bluetooth headset in hands-free (narrowband) mode.                                                                                                     |
| **"The provider rate-limited this request. Wait a moment and try again."**                                             | Groq free-tier limit, most likely tokens-per-minute.                                  | Wait ~30 s. Configure the Gemini backup so this is handled automatically next time.                                                                                                                                          |
| **"The provider rejected the saved API key."**                                                                         | Key revoked, deleted, or mistyped.                                                    | **Open settings** → Providers → Cloud API keys → **Replace** with a fresh key.                                                                                                                                               |
| **"This provider needs an API key before it can be used."**                                                            | Provider selected but no key saved.                                                   | Same place: paste the key and click **Save**.                                                                                                                                                                                |
| **"The provider is currently unavailable."**                                                                           | Network down, or a Groq incident.                                                     | Check <https://groqstatus.com>. Dismiss and retry; the backup model covers this if configured.                                                                                                                               |
| **"The provider took too long to respond."**                                                                           | Stage timeout — usually a stalled connection.                                         | Retry. Persistent timeouts on a good connection are worth reporting.                                                                                                                                                         |
| **"System audio capture was not permitted. Start recording from the Listen button."**                                  | Capture was requested without a valid grant.                                          | Always start from the **Listen** button, never from a browser-style prompt. Restart the app if it repeats.                                                                                                                   |
| **"The clip was too short to transcribe. Record at least half a second."**                                             | Stop pressed almost immediately.                                                      | Let at least half a second of audio through.                                                                                                                                                                                 |
| **"The selected model is not installed yet."**                                                                         | Local Whisper selected without a downloaded model.                                    | You are not in cloud mode. Preferences → Providers → Speech-to-text → Groq Whisper (or download the local model).                                                                                                            |
| **"The local model server could not be reached. Is Ollama running?"**                                                  | Responses set to Ollama, which is not running.                                        | Preferences → Providers → Response model → Groq.                                                                                                                                                                             |
| **"No response model is selected. Choose one under Settings → Providers → Response model."**                           | Ollama is running but has no models, or a cloud provider was left without a model id. | Pull a model (`ollama pull qwen2.5:3b-instruct`) or click **Open settings** → Response model → **Check & list models** and choose one. If a model _is_ installed the app picks it for you automatically on the next request. |

Non-error symptoms:

- **Answers are generic or hedge a lot** — your profile is too thin. Preferences → Profiles, expand
  the background summary with concrete projects and numbers.
- **The answer invents something you did not do** — report it with the transcript and profile; the
  prompt explicitly forbids it and that is a real bug.
- **Transcript mangles technical terms** — expected with a narrowband Bluetooth headset; try wired
  headphones. Groq Whisper is already biased toward a JavaScript/.NET glossary.
- **First words consistently slower than ~3 s** — check the rail: a large `transcribe` figure means
  no usable pause; a large first-token figure points at the network or Groq load.

---

## Part 7 — After the test

### 7.1 What to capture for anything that failed

1. The exact banner text and the full status-rail line.
2. **Settings → Diagnostics → Export**. It never includes API keys; leave the transcript and
   profile checkboxes off unless the problem is about answer content.
3. Whether it reproduced on a second attempt, and whether <https://groqstatus.com> showed an
   incident at the time.
4. Roughly how far into the call it happened, in case it is quota-related.

### 7.2 Worth reporting even if nothing broke

- Median "first words" time across the call — the rail shows it per turn.
- How often the rail said **transcribed during the pause** (the speculative path paying off).
- Whether the default pause length felt right, or you switched preset.
- Whether answers were usable as spoken material, and which mode button you reached for most.

### 7.3 Reset

Close the app and delete `%APPDATA%\CueDeck\` to wipe settings, the encrypted key, profiles,
history, and models, and return to onboarding. Uninstall from Windows Settings → Apps if you also
want the program gone.

---

## Known limitations in this build

- The installer is **unsigned**; SmartScreen warns on every install. Checksums are published
  instead.
- The app icon is a single 256 px image, so small taskbar sizes look soft, and Add/Remove Programs
  shows a default icon.
- No automated test drives the real packaged binary through a Listen (the Electron fuses disable
  the debugging port Playwright needs), which is exactly why this manual pass exists.
