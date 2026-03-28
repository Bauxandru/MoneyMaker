param(
  [string]$WorkbookPath = "c:\Users\Zighy\Desktop\mIHAI\Polymarket germania\arbitraj markets.xlsx",
  [string]$ArbsPath = "data/latest_arbs_high_timeleft.csv",
  [string]$OutputDir = "data"
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

function Copy-WorkbookSnapshot {
  param(
    [string]$SourcePath,
    [string]$SnapshotPath
  )

  if (-not (Test-Path -LiteralPath $SourcePath)) {
    throw "Workbook not found: $SourcePath"
  }

  $src = [System.IO.Path]::GetFullPath($SourcePath)
  $dst = [System.IO.Path]::GetFullPath($SnapshotPath)
  $dstDir = [System.IO.Path]::GetDirectoryName($dst)
  if (-not [string]::IsNullOrWhiteSpace($dstDir)) {
    $null = New-Item -ItemType Directory -Path $dstDir -Force
  }

  $inStream = [System.IO.File]::Open(
    $src,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::ReadWrite
  )
  try {
    $outStream = [System.IO.File]::Open(
      $dst,
      [System.IO.FileMode]::Create,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::None
    )
    try {
      $inStream.CopyTo($outStream)
    } finally {
      $outStream.Dispose()
    }
  } finally {
    $inStream.Dispose()
  }
}

function Get-CellText {
  param(
    [object]$Cell,
    [hashtable]$SharedStrings
  )
  if ($null -eq $Cell) { return "" }

  $ctype = [string]$Cell.t
  if ($ctype -eq "s") {
    $idxText = [string]$Cell.v
    $idx = 0
    if ([int]::TryParse($idxText, [ref]$idx) -and $SharedStrings.ContainsKey($idx)) {
      return [string]$SharedStrings[$idx]
    }
    return ""
  }

  if ($ctype -eq "inlineStr") {
    return [string]$Cell.is.t
  }

  return [string]$Cell.v
}

function Get-WatchlistRowsFromXlsx {
  param([string]$XlsxPath)

  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [System.IO.Compression.ZipFile]::OpenRead($XlsxPath)
  try {
    $shared = @{}
    $sharedEntry = $zip.Entries | Where-Object { $_.FullName -eq "xl/sharedStrings.xml" } | Select-Object -First 1
    if ($sharedEntry) {
      $sr = New-Object System.IO.StreamReader($sharedEntry.Open())
      try {
        $sharedXml = [xml]$sr.ReadToEnd()
      } finally {
        $sr.Close()
      }
      $i = 0
      foreach ($si in $sharedXml.sst.si) {
        if ($si.t) {
          $shared[$i] = [string]$si.t
        } elseif ($si.r) {
          $shared[$i] = (($si.r | ForEach-Object { $_.t }) -join "")
        } else {
          $shared[$i] = ""
        }
        $i += 1
      }
    }

    $sheetEntry = $zip.Entries | Where-Object { $_.FullName -eq "xl/worksheets/sheet1.xml" } | Select-Object -First 1
    if (-not $sheetEntry) {
      throw "Workbook does not contain xl/worksheets/sheet1.xml"
    }

    $srSheet = New-Object System.IO.StreamReader($sheetEntry.Open())
    try {
      $sheetXml = [xml]$srSheet.ReadToEnd()
    } finally {
      $srSheet.Close()
    }

    $rows = @()
    foreach ($row in $sheetXml.worksheet.sheetData.row) {
      $vals = @()
      foreach ($cell in $row.c) {
        $vals += (Get-CellText -Cell $cell -SharedStrings $shared)
      }
      if ($vals.Count -lt 2) {
        while ($vals.Count -lt 2) { $vals += "" }
      }
      $rows += [pscustomobject]@{
        RowIndex       = [int][string]$row.r
        PolymarketUrl  = [string]$vals[0]
        KalshiUrl      = [string]$vals[1]
      }
    }

    if ($rows.Count -le 1) { return @() }
    return $rows | Select-Object -Skip 1 | Where-Object {
      -not [string]::IsNullOrWhiteSpace($_.PolymarketUrl) -or
      -not [string]::IsNullOrWhiteSpace($_.KalshiUrl)
    }
  } finally {
    $zip.Dispose()
  }
}

function Get-PolymarketSlug {
  param([string]$Url)
  if ([string]::IsNullOrWhiteSpace($Url)) { return "" }
  try {
    $uri = [Uri]$Url
    $parts = $uri.AbsolutePath.Trim("/") -split "/"
    if ($parts.Length -eq 0) { return "" }
    if ($parts[0].ToLower() -eq "event" -and $parts.Length -ge 2) {
      return $parts[1].ToLower()
    }
    return $parts[$parts.Length - 1].ToLower()
  } catch {
    return ""
  }
}

function Get-KalshiTicker {
  param([string]$Url)
  if ([string]::IsNullOrWhiteSpace($Url)) { return "" }
  try {
    $uri = [Uri]$Url
    $parts = $uri.AbsolutePath.Trim("/") -split "/"
    if ($parts.Length -eq 0) { return "" }
    return $parts[$parts.Length - 1].ToUpper()
  } catch {
    return ""
  }
}

function Get-MatchRows {
  param(
    [object[]]$ArbRows,
    [string]$PmSlug,
    [string]$KalTicker
  )

  if ([string]::IsNullOrWhiteSpace($PmSlug) -or [string]::IsNullOrWhiteSpace($KalTicker)) {
    return @()
  }

  $pmNeed = "polymarket:$($PmSlug.ToLower())"
  $kalNeed = "kalshi:$($KalTicker.ToLower())"
  $pmPairNeed = "polymarket_$($PmSlug.ToLower())"
  $kalPairNeed = "kalshi_$($KalTicker.ToLower())"

  return @(
    $ArbRows | Where-Object {
      $pairIdLower = ([string]$_.pair_id).ToLower()
      $yes = ([string]$_.yes_legs).ToLower()
      $no = ([string]$_.no_legs).ToLower()

      $direct = $pairIdLower.Contains($pmPairNeed) -and $pairIdLower.Contains($kalPairNeed)
      $legs = (
        $pairIdLower.Contains($pmPairNeed) -or $yes.Contains($pmNeed) -or $no.Contains($pmNeed)
      ) -and (
        $pairIdLower.Contains($kalPairNeed) -or $yes.Contains($kalNeed) -or $no.Contains($kalNeed)
      )
      $direct -or $legs
    }
  )
}

if (-not (Test-Path -LiteralPath $ArbsPath)) {
  throw "Arbitrage file not found: $ArbsPath"
}

$null = New-Item -ItemType Directory -Path $OutputDir -Force

$snapshotPath = Join-Path $OutputDir "arbitraj_markets_snapshot.xlsx"
Copy-WorkbookSnapshot -SourcePath $WorkbookPath -SnapshotPath $snapshotPath

$watchRows = Get-WatchlistRowsFromXlsx -XlsxPath $snapshotPath
$arbRows = Import-Csv -Path $ArbsPath

$fullRows = @()
$bestRows = @()
$missingRows = @()
$currentPairSet = New-Object "System.Collections.Generic.HashSet[string]"

foreach ($w in $watchRows) {
  $pmSlug = Get-PolymarketSlug -Url $w.PolymarketUrl
  $kalTicker = Get-KalshiTicker -Url $w.KalshiUrl
  $matches = @(Get-MatchRows -ArbRows $arbRows -PmSlug $pmSlug -KalTicker $kalTicker)

  if ($matches.Count -eq 0) {
    $missingRows += [pscustomobject]@{
      row_index       = $w.RowIndex
      polymarket_url  = $w.PolymarketUrl
      kalshi_url      = $w.KalshiUrl
      polymarket_slug = $pmSlug
      kalshi_ticker   = $kalTicker
    }
    continue
  }

  $sorted = $matches | Sort-Object @{
    Expression = { To-DoubleOrZero $_.profit_1pct }
    Descending = $true
  }, @{
    Expression = { To-DoubleOrZero $_.edge }
    Descending = $true
  }

  foreach ($m in $sorted) {
    $pairId = [string]$m.pair_id
    if (-not [string]::IsNullOrWhiteSpace($pairId)) {
      $null = $currentPairSet.Add($pairId)
    }

    $fullRows += [pscustomobject]@{
      row_index           = $w.RowIndex
      polymarket_slug     = $pmSlug
      kalshi_ticker       = $kalTicker
      polymarket_url      = $w.PolymarketUrl
      kalshi_url          = $w.KalshiUrl
      ts                  = $m.ts
      pair_id             = $m.pair_id
      direction           = $m.direction
      cost                = $m.cost
      edge                = $m.edge
      depth_1pct          = $m.depth_1pct
      capital_1pct        = $m.capital_1pct
      profit_1pct         = $m.profit_1pct
      roi_1pct            = $m.roi_1pct
      days_to_settle      = $m.days_to_settle
      roi_1pct_annualized = $m.roi_1pct_annualized
      yes_legs            = $m.yes_legs
      no_legs             = $m.no_legs
    }
  }

  $best = $sorted[0]
  $bestRows += [pscustomobject]@{
    row_index           = $w.RowIndex
    polymarket_slug     = $pmSlug
    kalshi_ticker       = $kalTicker
    polymarket_url      = $w.PolymarketUrl
    kalshi_url          = $w.KalshiUrl
    ts                  = $best.ts
    pair_id             = $best.pair_id
    direction           = $best.direction
    cost                = $best.cost
    edge                = $best.edge
    depth_1pct          = $best.depth_1pct
    capital_1pct        = $best.capital_1pct
    profit_1pct         = $best.profit_1pct
    roi_1pct            = $best.roi_1pct
    days_to_settle      = $best.days_to_settle
    roi_1pct_annualized = $best.roi_1pct_annualized
    yes_legs            = $best.yes_legs
    no_legs             = $best.no_legs
  }
}

$seenPath = Join-Path $OutputDir "watchlist_seen_pairs.json"
$seenSet = New-Object "System.Collections.Generic.HashSet[string]"
if (Test-Path -LiteralPath $seenPath) {
  try {
    $seenRaw = Get-Content -Raw -Path $seenPath | ConvertFrom-Json
    foreach ($item in $seenRaw) {
      if (-not [string]::IsNullOrWhiteSpace([string]$item)) {
        $null = $seenSet.Add([string]$item)
      }
    }
  } catch {
    # Ignore malformed history and start fresh.
  }
}

$newPairRows = @()
if ($fullRows.Count -gt 0) {
  $newIds = New-Object "System.Collections.Generic.HashSet[string]"
  foreach ($r in $fullRows) {
    if ([string]::IsNullOrWhiteSpace([string]$r.pair_id)) { continue }
    if (-not $seenSet.Contains([string]$r.pair_id)) {
      $null = $newIds.Add([string]$r.pair_id)
    }
  }

  if ($newIds.Count -gt 0) {
    $newPairRows = $fullRows | Where-Object { $newIds.Contains([string]$_.pair_id) }
  }

  foreach ($id in $currentPairSet) {
    $null = $seenSet.Add($id)
  }
}

$fullPath = Join-Path $OutputDir "watchlist_arbs_full.csv"
$bestPath = Join-Path $OutputDir "watchlist_arbs_best.csv"
$missingPath = Join-Path $OutputDir "watchlist_arbs_missing.csv"
$newPath = Join-Path $OutputDir "watchlist_arbs_new.csv"

if ($fullRows.Count -gt 0) {
  $fullRows | Export-Csv -NoTypeInformation -Encoding UTF8 -Path $fullPath
} else {
  "" | Set-Content -Path $fullPath -Encoding UTF8
}

if ($bestRows.Count -gt 0) {
  $bestRows | Export-Csv -NoTypeInformation -Encoding UTF8 -Path $bestPath
} else {
  "" | Set-Content -Path $bestPath -Encoding UTF8
}

if ($missingRows.Count -gt 0) {
  $missingRows | Export-Csv -NoTypeInformation -Encoding UTF8 -Path $missingPath
} else {
  "" | Set-Content -Path $missingPath -Encoding UTF8
}

if ($newPairRows.Count -gt 0) {
  $newPairRows | Export-Csv -NoTypeInformation -Encoding UTF8 -Path $newPath
} else {
  "" | Set-Content -Path $newPath -Encoding UTF8
}

$seenOut = @($seenSet | Sort-Object)
$seenOut | ConvertTo-Json | Set-Content -Path $seenPath -Encoding UTF8

$watchCount = $watchRows.Count
$matchedWatchCount = $bestRows.Count
$matchedRowCount = $fullRows.Count
$missingCount = $missingRows.Count
$newCount = $newPairRows.Count

Write-Output "[WATCHLIST] workbook=$WorkbookPath"
Write-Output "[WATCHLIST] watched_markets=$watchCount matched_markets=$matchedWatchCount missing_markets=$missingCount"
Write-Output "[WATCHLIST] matched_rows=$matchedRowCount new_rows=$newCount"
Write-Output "[WATCHLIST] outputs: $bestPath ; $fullPath ; $newPath ; $missingPath"

if ($bestRows.Count -gt 0) {
  Write-Output "[WATCHLIST] Top opportunities by profit_1pct:"
  $bestRows |
    Sort-Object @{ Expression = { To-DoubleOrZero $_.profit_1pct }; Descending = $true } |
    Select-Object -First 10 row_index, pair_id, direction, cost, edge, capital_1pct, profit_1pct, roi_1pct_annualized |
    Format-Table -AutoSize
}
