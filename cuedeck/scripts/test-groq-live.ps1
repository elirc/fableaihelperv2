param([string]$AudioPath)

$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
if (-not $AudioPath) {
    $AudioPath = Join-Path $projectDir 'out/final-test/audio-check.wav'
}
$audioFile = (Resolve-Path -LiteralPath $AudioPath).Path
if ([IO.Path]::GetExtension($audioFile).ToLowerInvariant() -notin @('.wav', '.flac')) {
    throw 'The audio sample must be WAV or FLAC.'
}

Write-Output 'This checks both Groq response models and uploads the selected speech sample to Groq.'
Write-Output "Audio sample: $audioFile"
Write-Output 'The key is entered privately for this test process; it is not saved to the app or a file.'
$previousKey = $env:GROQ_API_KEY
$previousAudio = $env:CUEDECK_GROQ_AUDIO
$testExitCode = 1
Push-Location $projectDir
try {
    $secureKey = Read-Host 'Paste your Groq API key (hidden)' -AsSecureString
    try {
        $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
        try {
            $env:GROQ_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer).Trim()
        } finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer)
        }
    } finally {
        $secureKey.Dispose()
    }
    if ([string]::IsNullOrWhiteSpace($env:GROQ_API_KEY)) {
        throw 'No key entered. Live tests were not run.'
    }
    $env:CUEDECK_GROQ_AUDIO = $audioFile
    & npm.cmd run test:groq
    $testExitCode = $LASTEXITCODE
} finally {
    $env:GROQ_API_KEY = $previousKey
    $env:CUEDECK_GROQ_AUDIO = $previousAudio
    Pop-Location
}
exit $testExitCode
