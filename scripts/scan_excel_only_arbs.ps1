param(
  [string]$WorkbookPath = "c:\Users\Zighy\Desktop\mIHAI\Polymarket germania\arbitraj markets.xlsx",
  [string]$BaseDataDir = "data",
  [string]$OutputDataDir = "data/excel_only",
  [double]$MinSimilarity = 0.12
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

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
    return @(
      $rows |
        Select-Object -Skip 1 |
        Where-Object {
          -not [string]::IsNullOrWhiteSpace($_.PolymarketUrl) -or
          -not [string]::IsNullOrWhiteSpace($_.KalshiUrl)
        }
    )
  } finally {
    $zip.Dispose()
  }
}

function Get-PolymarketSlug {
  param([string]$Url)
  if ([string]::IsNullOrWhiteSpace($Url)) { return "" }
  try {
    $uri = [Uri]$Url
    $parts = @($uri.AbsolutePath.Trim("/") -split "/")
    if ($parts.Count -eq 0) { return "" }
    if ($parts[0].ToLower() -eq "event" -and $parts.Count -ge 2) {
      return $parts[1].ToLower()
    }
    return $parts[$parts.Count - 1].ToLower()
  } catch {
    return ""
  }
}

function Get-KalshiRoot {
  param([string]$Url)
  if ([string]::IsNullOrWhiteSpace($Url)) { return "" }
  try {
    $uri = [Uri]$Url
    $parts = @($uri.AbsolutePath.Trim("/") -split "/")
    if ($parts.Count -eq 0) { return "" }
    return $parts[$parts.Count - 1].ToUpper()
  } catch {
    return ""
  }
}

function Get-KalshiRootVariants {
  param([string]$Root)
  $set = New-Object "System.Collections.Generic.HashSet[string]"
  if ([string]::IsNullOrWhiteSpace($Root)) { return @() }
  $full = $Root.ToUpper()
  $null = $set.Add($full)
  $m = [regex]::Match($full, "^(.*?)-\d{2}[A-Z]{3}\d{2}.*$")
  if ($m.Success -and $m.Groups.Count -ge 2) {
    $base = [string]$m.Groups[1].Value
    if (-not [string]::IsNullOrWhiteSpace($base)) {
      $null = $set.Add($base)
    }
  }
  $first = ($full -split "-")[0]
  if (-not [string]::IsNullOrWhiteSpace($first)) {
    $null = $set.Add($first)
  }
  return @($set | ForEach-Object { [string]$_ })
}

$STOPWORDS = New-Object "System.Collections.Generic.HashSet[string]"
@(
  "the","a","an","of","and","to","in","on","for","by","at","from","with",
  "will","be","is","are","this","that","week","what","which","who","before",
  "after","top","global","us","u","s"
) | ForEach-Object { $null = $STOPWORDS.Add($_) }

function Normalize-Text {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  $v = $Value.ToLower()
  $v = [regex]::Replace($v, "[^a-z0-9]+", " ")
  $v = [regex]::Replace($v, "\s+", " ").Trim()
  return $v
}

function Get-Tokens {
  param([string]$Value)
  $norm = Normalize-Text $Value
  if (-not $norm) { return @() }
  $seen = New-Object "System.Collections.Generic.HashSet[string]"
  foreach ($t in ($norm -split " ")) {
    if ([string]::IsNullOrWhiteSpace($t)) { continue }
    if ($t.Length -lt 2) { continue }
    if ($STOPWORDS.Contains($t)) { continue }
    $null = $seen.Add($t)
  }
  return @($seen | ForEach-Object { [string]$_ })
}

function Jaccard {
  param([string[]]$A, [string[]]$B)
  if ($A.Count -eq 0 -or $B.Count -eq 0) { return 0.0 }
  $aSet = New-Object "System.Collections.Generic.HashSet[string]"
  foreach ($t in $A) { $null = $aSet.Add($t) }
  $bSet = New-Object "System.Collections.Generic.HashSet[string]"
  foreach ($t in $B) { $null = $bSet.Add($t) }
  $inter = 0
  foreach ($t in $aSet) {
    if ($bSet.Contains($t)) { $inter += 1 }
  }
  $union = $aSet.Count + $bSet.Count - $inter
  if ($union -le 0) { return 0.0 }
  return [double]$inter / [double]$union
}

function Is-PmOpen {
  param([object]$M)
  if ($null -eq $M) { return $false }
  if ($M.active -eq $false) { return $false }
  if ($M.closed -eq $true) { return $false }
  return $true
}

function Is-KalOpen {
  param([object]$M)
  if ($null -eq $M) { return $false }
  return ([string]$M.status).ToLower() -eq "active"
}

function To-DoubleOrZero {
  param([object]$Value)
  if ($null -eq $Value) { return 0.0 }
  $raw = [string]$Value
  if ([string]::IsNullOrWhiteSpace($raw)) { return 0.0 }
  $n = 0.0
  if ([double]::TryParse($raw, [ref]$n)) { return $n }
  return 0.0
}

function OverlapCount {
  param([string[]]$A, [string[]]$B)
  if ($A.Count -eq 0 -or $B.Count -eq 0) { return 0 }
  $setA = New-Object "System.Collections.Generic.HashSet[string]"
  foreach ($t in $A) { $null = $setA.Add($t) }
  $n = 0
  foreach ($t in $B) {
    if ($setA.Contains($t)) { $n += 1 }
  }
  return $n
}

function Write-CsvNoBom {
  param(
    [object[]]$Rows,
    [string]$Path
  )
  $enc = New-Object System.Text.UTF8Encoding($false)
  if ($Rows.Count -eq 0) {
    [System.IO.File]::WriteAllText($Path, "", $enc)
    return
  }
  $lines = @($Rows | ConvertTo-Csv -NoTypeInformation)
  [System.IO.File]::WriteAllLines($Path, $lines, $enc)
}

$null = New-Item -ItemType Directory -Path $OutputDataDir -Force

$snapshotPath = Join-Path $OutputDataDir "arbitraj_markets_snapshot.xlsx"
Copy-WorkbookSnapshot -SourcePath $WorkbookPath -SnapshotPath $snapshotPath
$watchRows = Get-WatchlistRowsFromXlsx -XlsxPath $snapshotPath

if ($watchRows.Count -eq 0) {
  throw "No watchlist rows found in $WorkbookPath"
}

$pairRows = @()
$diagnostics = @()
$seenPairs = New-Object "System.Collections.Generic.HashSet[string]"

foreach ($w in $watchRows) {
  $pmSlug = Get-PolymarketSlug -Url $w.PolymarketUrl
  $kalRoot = Get-KalshiRoot -Url $w.KalshiUrl
  if ([string]::IsNullOrWhiteSpace($pmSlug) -or [string]::IsNullOrWhiteSpace($kalRoot)) {
    $diagnostics += [pscustomobject]@{
      row_index = $w.RowIndex
      pm_slug = $pmSlug
      kal_root = $kalRoot
      pm_candidates = 0
      kal_candidates = 0
      selected_pairs = 0
      note = "missing_id_from_link"
    }
    continue
  }

  $key = "$pmSlug::$kalRoot"
  if ($seenPairs.Contains($key)) {
    $diagnostics += [pscustomobject]@{
      row_index = $w.RowIndex
      pm_slug = $pmSlug
      kal_root = $kalRoot
      pm_candidates = 1
      kal_candidates = 1
      selected_pairs = 0
      note = "duplicate_exact_pair"
    }
    continue
  }
  $null = $seenPairs.Add($key)

  $pairRows += [pscustomobject]@{
    pm_market_slug = $pmSlug
    pm_question = ""
    pm_end_date = ""
    kal_ticker = $kalRoot
    kal_title = ""
    kal_subtitle = ""
    kal_close_time = ""
    match_score = "exact_link"
  }

  $diagnostics += [pscustomobject]@{
    row_index = $w.RowIndex
    pm_slug = $pmSlug
    kal_root = $kalRoot
    pm_candidates = 1
    kal_candidates = 1
    selected_pairs = 1
    note = "exact_pair_from_excel_link"
  }
}

$pairsPath = Join-Path $OutputDataDir "market_matches_high.csv"
$diagPath = Join-Path $OutputDataDir "excel_pair_selection.csv"
Write-CsvNoBom -Rows $diagnostics -Path $diagPath
if ($pairRows.Count -gt 0) {
  Write-CsvNoBom -Rows $pairRows -Path $pairsPath
} else {
  Write-Output "[EXCEL_ONLY] No pair candidates could be built. See $diagPath"
  throw "No pair candidates could be built from Excel links."
}

$oldDataDir = $env:DATA_DIR
$oldPreferRescored = $env:SCAN_PREFER_RESCORED
try {
  $env:DATA_DIR = $OutputDataDir
  $env:SCAN_PREFER_RESCORED = "false"
  & npm run scan:high
  if ($LASTEXITCODE -ne 0) {
    throw "scan:high failed with exit code $LASTEXITCODE"
  }
} finally {
  $env:DATA_DIR = $oldDataDir
  $env:SCAN_PREFER_RESCORED = $oldPreferRescored
}

$arbsPath = Join-Path $OutputDataDir "latest_arbs_high_timeleft.csv"
if (-not (Test-Path -LiteralPath $arbsPath)) {
  throw "Missing output: $arbsPath"
}

$arbRows = @(Import-Csv -Path $arbsPath)
$oppRows = @(
  $arbRows | Where-Object {
    $ts = ([string]$_.ts).Trim().ToUpper()
    $pairId = ([string]$_.pair_id).Trim()
    $dir = ([string]$_.direction).Trim().ToUpper()
    if ($ts -eq "TOTAL") { return $false }
    if ($pairId -eq "TOTAL" -or [string]::IsNullOrWhiteSpace($pairId)) { return $false }
    if ($dir.StartsWith("STEP_")) { return $false }
    return $true
  }
)
$top = @(
  $oppRows |
    Sort-Object @{
      Expression = { To-DoubleOrZero $_.profit_1pct }
      Descending = $true
    }, @{
      Expression = { To-DoubleOrZero $_.edge }
      Descending = $true
    } |
    Select-Object -First 20
)

Write-Output "[EXCEL_ONLY] watch_rows=$($watchRows.Count) selected_pairs=$($pairRows.Count)"
Write-Output "[EXCEL_ONLY] opportunities=$($oppRows.Count)"
Write-Output "[EXCEL_ONLY] pair_file=$pairsPath"
Write-Output "[EXCEL_ONLY] arbs_file=$arbsPath"
Write-Output "[EXCEL_ONLY] diag_file=$diagPath"
if ($top.Count -gt 0) {
  Write-Output "[EXCEL_ONLY] Top opportunities:"
  $top |
    Select-Object ts,pair_id,direction,cost,edge,depth_1pct,capital_1pct,profit_1pct,roi_1pct,days_to_settle,roi_1pct_annualized |
    Format-Table -AutoSize
}
