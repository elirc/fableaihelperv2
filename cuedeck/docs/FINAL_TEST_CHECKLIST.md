# CueDeck final test: personalization, Groq, and system audio

Use the packaged build prepared for this test. Allow about 30–45 minutes. Run each request to
completion before starting the next. Groq authentication, answer quality, and real audio capture
remain unverified until you complete the live steps with your own key.

## 1. Open the correct build

Close any CueDeck windows first, including an older installed copy. Open
[the updated CueDeck executable](../out/CueDeck-win32-x64/cuedeck.exe).
Keep it inside its `CueDeck-win32-x64` folder; the adjacent files are required.

You should see **Personalize** near the top of the Coach window and **Go deeper**, **Show an
example**, and **Likely follow-ups** under the response. If the header says **Expand**, click it
to show the transcript, notes, and style controls. If these controls are missing, close all
CueDeck windows and reopen this exact executable. The app's single-instance behavior can
otherwise focus an already-running older copy.

The prepared test kit is in [out/final-test](../out/final-test). It contains a speech sample,
its expected transcript, a [results checklist](../out/final-test/test-results.md), and
[SHA-256 hashes](../out/final-test/SHA256SUMS.txt) identifying the tested build and sample.

Build outputs and test recordings are generated locally. To recreate them after cloning the
repository, install dependencies with `npm.cmd ci`, then run these commands from `cuedeck/` on Windows:

```powershell
npm.cmd run package
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\prepare-final-test.ps1
```

## 2. Create and save a Groq key

Create an API key in the [Groq console](https://console.groq.com/keys). See
[Groq's quickstart](https://console.groq.com/docs/quickstart) for account/key setup.
Paste the key into CueDeck's password field; do not put it in your profile, system instructions,
screenshots, test notes, or this chat.

If the app opens the welcome wizard: complete its acknowledgement, choose **Cloud free tier**,
choose **Groq (fast; audio + responses)**, paste the key, and click **Save and test**. Continue
after the provider check succeeds. For **Run 5-second test**, play the supplied speech sample
through this computer. Finish setup, then verify the settings below.

If you already completed setup: open **Settings → Providers**, scroll to **Cloud API keys
(optional)**, paste the key in the Groq row, and click **Save**. The row should show **key saved**.
Click **Test** and expect **ready**. Cloud provider choices become available after a key is saved.

## 3. Set both processing paths to Groq

In **Settings → Providers**, make these selections:

| Setting                   | Value / action          | Expected result                                                                   |
| ------------------------- | ----------------------- | --------------------------------------------------------------------------------- |
| Speech-to-text → Provider | Groq Whisper            | Processing summary shows `groq-whisper`; speech model is `whisper-large-v3-turbo` |
| Speech-to-text test       | **Test speech-to-text** | `ready`                                                                           |
| Response model → Provider | Groq                    | Processing summary shows responses `groq`                                         |
| Response model list       | **Check & list models** | Model dropdown appears                                                            |
| Response model → Model    | `openai/gpt-oss-120b`   | Selected ID matches; do not leave the selection blank                             |
| Backup provider           | **None** for this test  | Failures are attributable to Groq                                                 |

These response and speech model IDs appear in the [Groq model catalog](https://console.groq.com/docs/models).
The Processing summary shows provider IDs; the Coach's bottom status rail shows the selected
model IDs, including `whisper-large-v3-turbo`.
The **Test** buttons check credentials/reachability. They do not record audio or generate an answer;
the later steps verify those operations.

In **Settings → General**, select **15 seconds**, **English**, and enable **Remember the last
two exchanges**. Keep the full layout visible. On the Coach window select **Concise** under
**Default answer style**. Start with empty **Session notes**.

## 4. Set up your personal instructions and factual profile

Click **Personalize**. In **Your instructions**, start with:

```text
Use plain English and tailor answers to my target role and technical background.
For initial answers, give the direct answer first in two or three short sentences.
Avoid filler. When I request more depth, explain the mechanism and trade-offs.
When I request an example, walk through a concrete example using my technologies.
Clearly label hypothetical examples and never invent my experience.
```

Click **Save instructions** and check for the saved confirmation.

Create or edit a background profile. Include your real skills, experience, one project, and
your target role. Use only outcomes or metrics you can support. Save it and choose **Make active**
if necessary. Confirm its name appears near **Personalize** in the Coach window.

Close and reopen this exact executable. Confirm the instructions, active profile, Groq model,
and **Concise** setting survived. The Groq row should still say **key saved**, while keeping the
actual key hidden.

## 5. Test the concise answer without audio

In **Heard**, type:

> How does async/await help a web API handle slow external HTTP requests?

Click **Respond to edited text**. Expect text to stream into **Response**, then the state to
become **Done**. The status rail must name `groq` and `openai/gpt-oss-120b`.

Check the substance, not exact wording:

- The first sentence answers the question directly.
- The initial answer has at most three short sentences, usually around 25–60 words for this test.
- It explains that waiting on I/O need not block a request thread, helping concurrency; it does
  not claim async makes the remote server itself faster or always creates a new thread.
- Terminology fits your profile without claiming you personally built something you never listed.
- It finishes cleanly rather than stopping midway through a sentence.

Record the displayed first-word time and total time. Use these as measurements, not promises:
network conditions, model load, and provider limits can change latency.

## 6. Test deeper explanations, examples, and follow-ups

Use the same completed answer. Click each action in order, waiting for **Done** each time:

| Action                | Pass criteria                                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Go deeper**         | The original answer remains unchanged above; a separate section explains the mechanism, steps, and trade-offs in useful detail                           |
| **Show an example**   | The same original remains; a worked example explains its inputs, steps, and result, using your technologies when relevant; code, if present, is coherent |
| **Likely follow-ups** | Three relevant follow-up questions appear, each with a useful sample answer; they build on the original topic                                            |
| **Copy**              | Pasting into Notepad produces the original answer                                                                                                        |
| **Copy detail**       | Pasting into Notepad produces the expansion rather than the original                                                                                     |

For examples about your own career, invented scenarios must be identified as hypothetical.
The deeper answer should add useful information; merely repeating the initial answer is a quality failure.

## 7. Check that personalization actually changes the output

Add a temporary instruction: **Explain technical examples for a beginner and include a simple
analogy when I ask for more depth.** Save it, return to the same question, click **Try again**,
then **Go deeper**. Check that the explanation follows this request. Remove the temporary
instruction and save again when done.

Click **Clear**. Ask **Which specific project from my background best demonstrates my fit for
this role?** A good answer uses the real project and role from your profile without inventing metrics.

Click **Clear** again. Ask about an employer or achievement you deliberately did not include,
for example **Tell me about the team I managed at Example Corp.** It should acknowledge the
missing background or request details; it must not fabricate a career story.

## 8. Check memory, cancellation, and stale context

Turn off **Remember the last two exchanges** in **Settings → General**. Generate a fresh answer
to the async/await question, then use **Show an example** and **Likely follow-ups**. Both should
still understand that question because the expansion explicitly includes its source answer.

Start **Go deeper** and press **Cancel** or `Esc` while it is generating. If generation finishes
too quickly, repeat with a more complex question. The original answer must stay visible, new
text must stop arriving, and another expansion must work afterward.

After an expansion, edit **Heard** to **What is a database index?** The old detail should clear
and expansion buttons should be disabled until you generate a new answer. After generation,
**Show an example** must discuss indexes rather than async/await.

Click **Clear**. The answer, transcript, expansions, and remembered-exchange indicator should
clear. Re-enable memory for normal conversation follow-ups. Generate one answer, then click
**Interviewer follow-up**: this separate feature creates one next question in **Heard**. Click
**Respond to edited text** to answer it.

## 9. Test the complete audio → transcript → answer path

Use [audio-check.wav](../out/final-test/audio-check.wav). The expected question is:

> How does async await help a web API handle slow external HTTP requests? Please explain one
> benefit and one limitation.

CueDeck captures what this PC plays through its speakers/headphones, not your microphone.
Choose the playback device before recording and pause other audio.

First, turn **Auto-respond when the speaker pauses** off. Click **Listen**, then play the WAV
in your media player. You should see the recording indicator, advancing timer, and moving meter.
After the clip ends, click **Stop & respond**.

Pass when **Heard** contains the substance of the supplied question, an answer streams in, and
the status rail identifies Groq for both stages. Small punctuation or async/await spelling
differences are acceptable; missing clauses or a changed technical meaning are failures.

Repeat with **Auto-respond when the speaker pauses** on and **Normal pause (1.6 s)** selected.
Click **Listen**, play the sample, and let the app stop automatically after speech ends. It
must not require a manual stop or cut off the final clause.

Then repeat with two different short questions from a mock-interview recording played on the
PC, or a disclosed practice call with a consenting participant. This checks less predictable
speech in addition to the clean synthetic sample. Compare each actual question with **Heard**.

## 10. Check failures and recovery

| Test                                                                              | Expected result                                                                                                                |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| While recording, press `Esc`                                                      | Recording stops; indicator disappears; state returns to **Ready**; another recording can start                                 |
| While an answer streams, press `Esc`                                              | New text stops; the app remains usable                                                                                         |
| With all playback paused, record 2–3 seconds and click **Stop & respond**         | A silence warning/error appears rather than a made-up transcript; **Dismiss** and retry with real audio                        |
| Temporarily disconnect the network, submit a typed question, and wait for failure | A visible connection/timeout error appears; reconnect, **Dismiss**, re-enter the question if cleared, and retry successfully   |
| A quota/rate-limit error occurs naturally                                         | The app shows an actionable error; wait for the provider's reset and retry; do not hammer requests to manufacture a rate limit |

Use a disconnected network only when it will not interrupt other work or a real call.
To collect failure details, reopen **Settings → Diagnostics** and use **Copy diagnostics to
clipboard**. Leave profile/transcript export unchecked unless those details are needed.

## 11. Check the other model and optional daily-use features

Switch the Groq response model to `openai/gpt-oss-20b`. Repeat the typed question and **Show an
example**; check the status rail reports the new model. Restore `openai/gpt-oss-120b` afterward
if that is your preferred model.

If you will use history: enable it under **Settings → History**, generate a test answer, confirm
it appears, search for it, and delete that test entry. Restore your preferred history setting.
If you will use **Compact**, larger text, or always-on-top, try them now and ensure recording
controls, the status rail, and answers remain usable. Optional backup providers require their
own credentials and a separate test; they are outside this Groq-only run.

## 12. Optional automated live Groq check

This complements the UI checks; it does not test Windows loopback capture. It sends synthetic
prompts and the prepared audio sample to Groq using the actual provider adapters.

Open PowerShell and run:

```powershell
Set-Location 'C:\Users\E\Desktop\helperv2\fableaihelperv2\cuedeck'
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-groq-live.ps1
```

Paste the key at the hidden prompt. It is used for this test process and is not written into
source code or saved into the app by the script. The execution-policy option applies to this
PowerShell process, leaving the system policy unchanged.

Expect **4 passed, 0 skipped**: shared-key authentication, concise answer plus worked example on
each Groq response model, and transcription of the WAV. A skipped suite is not a live pass.
If rate-limited, wait before rerunning. Real answers still need the human quality checks above.

## Record the result

Fill in [test-results.md](../out/final-test/test-results.md). For any failure, record the step,
question, expected/actual behavior, model, timing, and error text. Keep your API key out of reports.

The core test passes when Groq completes both typed and audio requests, personalization persists
and changes answers appropriately, initial responses stay concise, expansions add useful depth,
and cancellation/errors recover. A successful provider probe or automated mock test alone does
not establish that result.
