param(
  [string]$InputCsv = "data/focus/similar_markets_focus.csv",
  [string]$OutputPath = "config/markets.sotu.json",
  [double]$MinTitleScore = 0.85
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function To-DoubleOrZero {
  param([object]$Value)
  if ($null -eq $Value) { return 0.0 }
  $raw = [string]$Value
  if ([string]::IsNullOrWhiteSpace($raw)) { return 0.0 }
  $n = 0.0
  if ([double]::TryParse($raw, [ref]$n)) { return $n }
  return 0.0
}

if (-not (Test-Path -LiteralPath $InputCsv)) {
  throw "Missing input file: $InputCsv"
}

$rows = @(Import-Csv -Path $InputCsv)
$sotu = @(
  $rows | Where-Object {
    $pmSlug = [string]$_.pm_market_slug
    $kalTicker = [string]$_.kal_ticker
    $titleScore = To-DoubleOrZero $_.title_score
    if ([string]::IsNullOrWhiteSpace($pmSlug) -or [string]::IsNullOrWhiteSpace($kalTicker)) {
      return $false
    }
    if ($titleScore -lt $MinTitleScore) { return $false }
    $kalHit = $kalTicker.ToUpper().StartsWith("KXATTENDSOTU-")
    $pmHit = $pmSlug.ToLower().Contains("state-of-the-union")
    return $kalHit -or $pmHit
  }
)

$seen = New-Object "System.Collections.Generic.HashSet[string]"
$pairs = New-Object System.Collections.ArrayList

foreach ($r in ($sotu | Sort-Object pm_market_slug, kal_ticker)) {
  $pmSlug = ([string]$r.pm_market_slug).Trim().ToLower()
  $kalTicker = ([string]$r.kal_ticker).Trim().ToUpper()
  if ([string]::IsNullOrWhiteSpace($pmSlug) -or [string]::IsNullOrWhiteSpace($kalTicker)) {
    continue
  }

  $key = "$pmSlug::$kalTicker"
  if ($seen.Contains($key)) { continue }
  $null = $seen.Add($key)

  $id = "polymarket_$pmSlug" + "__kalshi_$kalTicker"
  $pair = [ordered]@{
    id = $id
    polymarket = [ordered]@{
      marketSlug = $pmSlug
    }
    kalshi = [ordered]@{
      ticker = $kalTicker
      side = "YES"
    }
    notes = "SOTU attendee pair"
  }
  $null = $pairs.Add($pair)
}

$outDir = Split-Path -Parent $OutputPath
if (-not [string]::IsNullOrWhiteSpace($outDir)) {
  $null = New-Item -ItemType Directory -Path $outDir -Force
}

$payload = [ordered]@{
  autoPairs = @()
  pairs = @($pairs)
}

$json = $payload | ConvertTo-Json -Depth 8
$enc = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($OutputPath, $json + [Environment]::NewLine, $enc)

Write-Output "[SOTU_CONFIG] input_rows=$($rows.Count) selected_rows=$($sotu.Count) unique_pairs=$($pairs.Count)"
Write-Output "[SOTU_CONFIG] output=$OutputPath"
