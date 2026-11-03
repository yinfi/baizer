# Extract text + positions from a PNG with the Windows built-in OCR engine.
#
# Windows PowerShell 5.1 only: PowerShell 7 does not project WinRT types, so run
# this through powershell.exe, not pwsh.
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File ocr.ps1 -Path shot.png
#
# Emits JSON on stdout:
#   { "image": {"width":W,"height":H}, "languages":["zh-Hans-CN"],
#     "lines": [ {"x":N,"y":N,"text":"..."} ] }
#
# This exists because the agent driving the capture cannot view images: OCR is
# how the framing and the on-screen state of a capture are compared against the
# committed baseline without a human looking at the pixels.
param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string]$LanguageTag = ''
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($op, $resultType) {
    $asTask = $asTaskGeneric.MakeGenericMethod($resultType)
    $netTask = $asTask.Invoke($null, @($op))
    $netTask.Wait(-1) | Out-Null
    $netTask.Result
}

[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

$full = (Resolve-Path -LiteralPath $Path).Path
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($full)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

$available = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag })

if ($LanguageTag) {
    $language = New-Object Windows.Globalization.Language($LanguageTag)
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
} else {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
}

if ($null -eq $engine) {
    [pscustomobject]@{
        image     = @{ width = $decoder.PixelWidth; height = $decoder.PixelHeight }
        languages = $available
        error     = 'no OCR engine available for the requested/current language'
        lines     = @()
    } | ConvertTo-Json -Depth 6
    exit 2
}

$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])

$lines = @()
foreach ($line in $result.Lines) {
    $minX = [double]::MaxValue
    $minY = [double]::MaxValue
    foreach ($word in $line.Words) {
        if ($word.BoundingRect.X -lt $minX) { $minX = $word.BoundingRect.X }
        if ($word.BoundingRect.Y -lt $minY) { $minY = $word.BoundingRect.Y }
    }
    $lines += [pscustomobject]@{
        x    = [int][math]::Round($minX)
        y    = [int][math]::Round($minY)
        text = $line.Text
    }
}

[pscustomobject]@{
    image       = @{ width = $decoder.PixelWidth; height = $decoder.PixelHeight }
    languages   = $available
    engineLanguage = $engine.RecognizerLanguage.LanguageTag
    lineCount   = $lines.Count
    lines       = $lines
} | ConvertTo-Json -Depth 6
