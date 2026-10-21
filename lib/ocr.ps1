# dsh-screenshot-xn OCR script (Windows PowerShell 5.1 compatible).
#
# Recognizes the text inside one PNG with the Windows built-in OCR engine
# (`Windows.Media.Ocr`), which ships with Windows 10/11 and needs no API key,
# no network access and no third-party dependency. The engine is created from a
# requested BCP-47 language tag (-Language) or from the user's own profile
# languages when no tag is given.
#
# Contract (see index.js and README.md): print machine-readable JSON between the
# markers below on stdout, and exit non-zero with ok=false on failure.
#
#   ---JSON-BEGIN---
#   { ... one JSON object ... }
#   ---JSON-END---
#
# Result fields (index.js parses exactly these):
#   ok           boolean  true only when recognition finished
#   text         string   the whole recognized text (engine line breaks kept)
#   language     string   BCP-47 tag of the engine that actually ran
#   engine       string   which engine factory succeeded (diagnostics only)
#   lines        array    [ { text, words: [ { text, x, y, width, height } ] } ]
#   word_count   integer  total words in `lines`
#   image_width  integer  device pixels of the bitmap OCR actually saw
#   image_height integer  device pixels of the bitmap OCR actually saw
#   scaled       boolean  true when the bitmap had to be downscaled for the engine
#   max_edge     integer  OcrEngine.MaxImageDimension of this machine
#   available    array    language tags installed on this machine (diagnostics)
#   elapsed_ms   integer  decode + convert + recognize, measured end to end
#   powershell   string   reporting engine version
#   process_id   integer  this process id
#   error        string   failure text (null on success)
#
# Why this file exists as a separate script instead of a Node addon:
#   - the whole plugin already runs Windows-native work through powershell.exe
#     (lib/capture.ps1, lib/overlay-host.ps1), and the host's `defaultPowerShellPath()`
#     pins the Windows PowerShell 5.1 engine, which is the only one that still
#     projects the WinRT types below (PowerShell 7 / .NET Core dropped them);
#   - the OCR engine is part of Windows, so the feature stays offline and free.
#
# Safety rules:
#   1. -Path is read as an image only; the file is never written or deleted here
#      (the host owns the temp file it created and removes it in a finally block).
#   2. A bitmap larger than OcrEngine.MaxImageDimension is downscaled at decode
#      time instead of failing: a full-screen region on a huge monitor must still
#      be recognized.
#   3. No language installed, or an uninstalled -Language, is reported as a
#      readable error that lists the tags this machine does have - never as a
#      silent empty result.
#
# ASCII only on purpose: Windows PowerShell 5.1 mis-parses non-BOM UTF-8 files
# that contain non-ASCII comments, and this file is loaded by powershell.exe with
# -ExecutionPolicy Bypass. (The first probe of this feature drew its CJK sample
# text from [char] code points for exactly this reason.)

param(
  [string]$Path = '',
  [string]$Language = '',
  [switch]$ListLanguages
)

$ErrorActionPreference = 'Stop'

# PowerShell 5.1 writes stdout in the **console output encoding**, which on a redirected
# pipe is the OEM code page (936 / GBK on a Chinese Windows) - not UTF-8. The host reads
# this pipe as UTF-8, so every CJK character of the recognition result would arrive as
# U+FFFD and the feature would look like it "recognizes nothing but question
# marks". capture.ps1 never hit this because its whole JSON payload is ASCII. Pinning the
# encoding here, on the writing side, is the only place that fixes it for every consumer.
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {
  # A host without a console (some CI runners) has nothing to reconfigure; the JSON below
  # is still valid, only non-ASCII text would suffer.
}

$script:result = [ordered]@{
  ok           = $false
  text         = ''
  language     = ''
  engine       = $null
  lines        = @()
  word_count   = 0
  image_width  = 0
  image_height = 0
  scaled       = $false
  max_edge     = 0
  available    = @()
  elapsed_ms   = 0
  powershell   = $PSVersionTable.PSVersion.ToString()
  process_id   = $PID
  error        = $null
}

# Emit the result and terminate with the given exit code. `exit` inside a
# function ends the script, which is what we want on every path.
function Write-Result {
  param([int]$Code = 0)
  $script:result['ok'] = ($Code -eq 0)
  Write-Host '---JSON-BEGIN---'
  Write-Host ($script:result | ConvertTo-Json -Depth 8 -Compress)
  Write-Host '---JSON-END---'
  exit $Code
}

function Fail {
  param([string]$Message, [int]$Code = 3)
  $script:result['error'] = $Message
  Write-Result -Code $Code
}

# ------------------------------------------------------------- WinRT plumbing
# PowerShell 5.1 projects WinRT types only when each one is named explicitly
# together with its assembly and ContentType; naming them lazily inside a
# function is not enough because the parser resolves the type literal first.
$winrtTypes = @(
  'Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime',
  'Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType=WindowsRuntime',
  'Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime',
  'Windows.Storage.StorageFile, Windows.Storage, ContentType=WindowsRuntime',
  'Windows.Storage.FileAccessMode, Windows.Storage, ContentType=WindowsRuntime',
  'Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType=WindowsRuntime',
  'Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType=WindowsRuntime',
  'Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType=WindowsRuntime',
  'Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType=WindowsRuntime',
  'Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Graphics.Imaging, ContentType=WindowsRuntime',
  'Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Graphics.Imaging, ContentType=WindowsRuntime',
  'Windows.Graphics.Imaging.ExifOrientationMode, Windows.Graphics.Imaging, ContentType=WindowsRuntime',
  'Windows.Graphics.Imaging.ColorManagementMode, Windows.Graphics.Imaging, ContentType=WindowsRuntime'
)
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  foreach ($typeName in $winrtTypes) { $null = Invoke-Expression "[$typeName]" }
} catch {
  Fail "this Windows build cannot project the WinRT OCR types ($($_.Exception.Message))"
}

# The generic AsTask adapter is what turns a WinRT IAsyncOperation into a .NET
# Task we can block on; PowerShell has no `await` keyword.
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]
if ($null -eq $asTaskGeneric) { Fail 'System.Runtime.WindowsRuntime exposes no AsTask(IAsyncOperation<T>) adapter' }

function Await {
  param($Operation, [Type]$ResultType)
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $task = $asTask.Invoke($null, @($Operation))
  $null = $task.Wait(-1)
  return $task.Result
}

# Tags installed on this machine; reported on every failure so the fix is
# actionable ("install the language pack" vs "your tag is wrong").
function Get-AvailableLanguages {
  try {
    return @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })
  } catch {
    return @()
  }
}

# @(...) at the assignment site matters: PowerShell unwraps a one-element array
# on return, so a machine with a single language pack would otherwise report
# `available` as a bare string ("zh-Hans-CN") and index into its characters.
$script:result['available'] = @(Get-AvailableLanguages)
try { $script:result['max_edge'] = [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension } catch { }

if ($ListLanguages) {
  $script:result['language'] = if ($script:result['available'].Count -gt 0) { $script:result['available'][0] } else { '' }
  Write-Result -Code 0
}

if ($Path -eq '') { Fail '-Path is required' }
if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { Fail "image not found: $Path" }

$startedAt = Get-Date

# --------------------------------------------------------------- create engine
$engine = $null
if ($Language -ne '') {
  try {
    $languageObject = New-Object Windows.Globalization.Language $Language
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($languageObject)
  } catch {
    Fail "language tag '$Language' is not usable ($($_.Exception.Message)); installed: $($script:result['available'] -join ', ')"
  }
  if ($null -eq $engine) {
    Fail "no OCR language pack for '$Language'; installed: $($script:result['available'] -join ', ')"
  }
  $script:result['engine'] = "language:$Language"
} else {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
  if ($null -eq $engine) {
    Fail "no OCR language is installed for this Windows user; install one (Settings > Time & Language > Language) or set ocrLanguage; installed: $($script:result['available'] -join ', ')"
  }
  $script:result['engine'] = 'user-profile'
}
$script:result['language'] = $engine.RecognizerLanguage.LanguageTag

# ------------------------------------------------------------ decode the image
try {
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
} catch {
  Fail "the image could not be decoded ($($_.Exception.Message))"
}

$width = [int]$decoder.PixelWidth
$height = [int]$decoder.PixelHeight
$maxEdge = [int]$script:result['max_edge']

# Decode straight into the format the OCR engine wants (BGRA8/Premultiplied) and
# shrink it when it exceeds the engine's own ceiling, in one call - decoding to
# the native format first and converting afterwards would cost a second copy of
# a potentially huge bitmap.
try {
  if ($maxEdge -gt 0 -and ($width -gt $maxEdge -or $height -gt $maxEdge)) {
    $scale = [Math]::Min($maxEdge / [double]$width, $maxEdge / [double]$height)
    $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
    $transform.ScaledWidth = [uint32][Math]::Max(1, [Math]::Floor($width * $scale))
    $transform.ScaledHeight = [uint32][Math]::Max(1, [Math]::Floor($height * $scale))
    $script:result['scaled'] = $true
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync(
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
        $transform,
        [Windows.Graphics.Imaging.ExifOrientationMode]::IgnoreExifOrientation,
        [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
  } else {
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync(
        [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
        [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied)) ([Windows.Graphics.Imaging.SoftwareBitmap])
  }
} catch {
  Fail "the bitmap could not be prepared for OCR ($($_.Exception.Message))"
}

$script:result['image_width'] = [int]$bitmap.PixelWidth
$script:result['image_height'] = [int]$bitmap.PixelHeight

# ------------------------------------------------------------------ recognize
try {
  $ocr = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
} catch {
  Fail "recognition failed ($($_.Exception.Message))"
}

# The engine hands back lines of words; the host re-joins them with its own rule
# (lib/ocr.mjs joinWords), so this side only needs to report what the engine said.
$lines = New-Object System.Collections.ArrayList
$wordCount = 0
foreach ($line in $ocr.Lines) {
  $words = New-Object System.Collections.ArrayList
  foreach ($word in $line.Words) {
    $rect = $word.BoundingRect
    $null = $words.Add([ordered]@{
        text   = $word.Text
        x      = [Math]::Round([double]$rect.X, 2)
        y      = [Math]::Round([double]$rect.Y, 2)
        width  = [Math]::Round([double]$rect.Width, 2)
        height = [Math]::Round([double]$rect.Height, 2)
      })
    $wordCount += 1
  }
  $null = $lines.Add([ordered]@{
      text  = $line.Text
      words = @($words)
    })
}

$script:result['lines'] = @($lines)
$script:result['word_count'] = $wordCount
$script:result['text'] = $ocr.Text
$script:result['elapsed_ms'] = [int]((Get-Date) - $startedAt).TotalMilliseconds

Write-Result -Code 0
