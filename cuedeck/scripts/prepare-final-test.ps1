$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$kitDir = Join-Path $projectDir 'out/final-test'
New-Item -ItemType Directory -Path $kitDir -Force | Out-Null

$question = 'How does async await help a web API handle slow external HTTP requests? Please explain one benefit and one limitation.'
$audioFile = Join-Path $kitDir 'audio-check.wav'
Add-Type -AssemblyName System.Speech
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $speaker.Rate = -1
    $speaker.Volume = 100
    $format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(
        16000,
        [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,
        [System.Speech.AudioFormat.AudioChannel]::Mono
    )
    $speaker.SetOutputToWaveFile($audioFile, $format)
    $speaker.Speak($question)
} finally {
    $speaker.Dispose()
}
Set-Content -LiteralPath (Join-Path $kitDir 'audio-check.txt') -Value $question -Encoding UTF8

$resultsFile = Join-Path $kitDir 'test-results.md'
if (-not (Test-Path -LiteralPath $resultsFile)) {
    @'
# CueDeck final manual test results

Date:
Groq response model:
Audio output device:

- [ ] Current packaged build opens and shows Personalize
- [ ] Groq response and speech probes show ready
- [ ] System instructions and active profile survive restart
- [ ] Initial answer is direct, concise, correct, and targeted
- [ ] Missing personal experience is not invented
- [ ] Go deeper explains mechanism and trade-offs without replacing original
- [ ] Show an example gives a useful worked example
- [ ] Likely follow-ups includes three questions with sample answers
- [ ] Original and detail copy separately
- [ ] Expansions work with conversation memory off
- [ ] Cancel/retry and edited-question context work
- [ ] Known speech sample transcribes accurately and generates an answer
- [ ] Automatic pause detection works
- [ ] Manual stop and Esc stop capture/generation
- [ ] Silence and network failure show recoverable errors
- [ ] Second Groq response model works
- [ ] Optional history/compact layout checked if used
- [ ] Optional live API suite: 4 passed, 0 skipped (include audio sample)

For each failed item:
Step / question:
Expected:
Actual:
Status/error text and model:
First-word/total time:
Diagnostics (without API key):

Overall: NOT RUN
'@ | Set-Content -LiteralPath $resultsFile -Encoding UTF8
}

$artifacts = @(
    (Join-Path $projectDir 'out/CueDeck-win32-x64/cuedeck.exe'),
    (Join-Path $projectDir 'out/CueDeck-win32-x64/resources/app.asar'),
    $audioFile
)
$hashes = foreach ($artifact in $artifacts) {
    $item = Get-FileHash -LiteralPath $artifact -Algorithm SHA256
    '{0}  {1}' -f $item.Hash, $artifact.Substring($projectDir.Length + 1)
}
$hashes | Set-Content -LiteralPath (Join-Path $kitDir 'SHA256SUMS.txt') -Encoding UTF8
Write-Output "Final-test kit ready: $kitDir"
Write-Output 'Includes a synthetic speech sample, expected transcript, results checklist, and build hashes.'
