param(
  [string]$WorkbookPath = "c:\Users\Zighy\Desktop\mIHAI\Polymarket germania\arbitraj markets.xlsx",
  [string]$BaseDataDir = "data",
  [string]$OutputDataDir = "data/excel_similar",
  [double]$MinSimilarity = 0.12,
  [double]$MinCrossSimilarity = 0.05,
  [int]$TopPmCandidates = 30,
  [int]$TopKalCandidates = 40,
  [int]$MaxPairsPerRow = 30
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

function Get-PmSlugCore {
  param([string]$Slug)
  if ([string]::IsNullOrWhiteSpace($Slug)) { return "" }
  $s = $Slug.ToLower().Trim()
  $s = [regex]::Replace($s, "-\d{4}-\d{2}-\d{2}.*$", "")
  $s = [regex]::Replace(
    $s,
    "-(january|february|march|april|may|june|july|august|september|october|november|december)-\d{1,2}.*$",
    ""
  )
  $s = [regex]::Replace($s, "-\d+$", "")
  return $s.Trim("-")
}

$STOPWORDS = New-Object "System.Collections.Generic.HashSet[string]"
@(
  "the","a","an","of","and","to","in","on","for","by","at","from","with",
  "will","be","is","are","this","that","week","what","which","who","before",
  "after","top","global","us","u","s"
) | ForEach-Object { $null = $STOPWORDS.Add($_) }

$ANCHOR_STOPWORDS = New-Object "System.Collections.Generic.HashSet[string]"
@(
  "the","a","an","of","and","to","in","on","for","by","at","from","with",
  "will","be","is","are","this","that","week","what","which","who","before",
  "after","top","global","us","u","s","released","release","date","today",
  "month","chart","rank","runnerup","movie","show","song","artist","call",
  "house","white","market","markets","yes","no","map","winner","game","games",
  "january","february","march","april","may","june","july","august",
  "september","october","november","december"
) | ForEach-Object { $null = $ANCHOR_STOPWORDS.Add($_) }

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

function Get-AnchorTokensFromTokens {
  param([string[]]$Tokens)
  $seen = New-Object "System.Collections.Generic.HashSet[string]"
  foreach ($t in $Tokens) {
    if ([string]::IsNullOrWhiteSpace($t)) { continue }
    if ($t.Length -lt 3) { continue }
    if ($ANCHOR_STOPWORDS.Contains($t)) { continue }
    if ($t -match "^\d+$") { continue }
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

$pmMarketsPath = Join-Path $BaseDataDir "polymarket_markets.json"
$kalMarketsPath = Join-Path $BaseDataDir "kalshi_markets.json"
if (-not (Test-Path -LiteralPath $pmMarketsPath)) {
  throw "Missing market cache: $pmMarketsPath"
}
if (-not (Test-Path -LiteralPath $kalMarketsPath)) {
  throw "Missing market cache: $kalMarketsPath"
}

$pmMarketsRaw = Get-Content -Raw -Path $pmMarketsPath | ConvertFrom-Json
$kalMarketsRaw = Get-Content -Raw -Path $kalMarketsPath | ConvertFrom-Json

$pmIndex = @(
  foreach ($m in $pmMarketsRaw) {
    if (-not (Is-PmOpen $m)) { continue }
    $slug = [string]$m.marketSlug
    if ([string]::IsNullOrWhiteSpace($slug)) { continue }
    $eventSlug = [string]$m.eventSlug
    $question = [string]$m.question
    $tokens = Get-Tokens "$slug $eventSlug $question"
    if ($tokens.Count -eq 0) { continue }
    [pscustomobject]@{
      slug      = $slug.ToLower()
      eventSlug = $eventSlug.ToLower()
      question  = $question
      endDate   = [string]$m.endDate
      tokens    = $tokens
    }
  }
)

$kalIndex = @(
  foreach ($k in $kalMarketsRaw) {
    if (-not (Is-KalOpen $k)) { continue }
    $ticker = [string]$k.ticker
    if ([string]::IsNullOrWhiteSpace($ticker)) { continue }
    $eventTicker = [string]$k.eventTicker
    $title = [string]$k.title
    $subtitle = [string]$k.subtitle
    $tokens = Get-Tokens "$ticker $eventTicker $title $subtitle"
    if ($tokens.Count -eq 0) { continue }
    [pscustomobject]@{
      ticker      = $ticker.ToUpper()
      eventTicker = $eventTicker.ToUpper()
      title       = $title
      subtitle    = $subtitle
      closeTime   = [string]$k.closeTime
      tokens      = $tokens
    }
  }
)

Write-Output "[EXCEL_SIM] index_loaded pm=$($pmIndex.Count) kal=$($kalIndex.Count)"

$pairRows = @()
$diagnostics = @()
$seenPairs = New-Object "System.Collections.Generic.HashSet[string]"

foreach ($w in $watchRows) {
  $pmSlug = (Get-PolymarketSlug -Url $w.PolymarketUrl).ToLower()
  $kalRoot = (Get-KalshiRoot -Url $w.KalshiUrl).ToUpper()
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

  $pmCore = Get-PmSlugCore -Slug $pmSlug
  $pmNeedleTokens = Get-Tokens "$pmSlug $pmCore"
  $kalNeedleTokens = Get-Tokens $kalRoot
  $rowAnchorTokens = Get-AnchorTokensFromTokens -Tokens @($pmNeedleTokens + $kalNeedleTokens)
  if ($rowAnchorTokens.Count -eq 0) {
    $rowAnchorTokens = @($pmNeedleTokens | Where-Object { $_.Length -ge 3 })
  }
  $rowAnchorSet = New-Object "System.Collections.Generic.HashSet[string]"
  foreach ($t in $rowAnchorTokens) { $null = $rowAnchorSet.Add($t) }
  $kalVariants = Get-KalshiRootVariants -Root $kalRoot

  $pmScored = @(
    foreach ($m in $pmIndex) {
      $anchorHit = OverlapCount -A $rowAnchorTokens -B $m.tokens
      if ($anchorHit -le 0) { continue }
      $bonus = 0.0
      if ($m.slug -eq $pmSlug -or $m.eventSlug -eq $pmSlug) {
        $bonus += 8.0
      }
      if (
        $m.slug.StartsWith($pmSlug) -or $pmSlug.StartsWith($m.slug) -or
        $m.eventSlug.StartsWith($pmSlug) -or $pmSlug.StartsWith($m.eventSlug)
      ) {
        $bonus += 3.0
      }
      if (-not [string]::IsNullOrWhiteSpace($pmCore)) {
        if ($m.slug.StartsWith($pmCore) -or $m.eventSlug.StartsWith($pmCore)) {
          $bonus += 2.0
        } elseif ($m.slug.Contains($pmCore) -or $m.eventSlug.Contains($pmCore)) {
          $bonus += 1.0
        }
      }
      $j = Jaccard -A $pmNeedleTokens -B $m.tokens
      $ov = OverlapCount -A $pmNeedleTokens -B $m.tokens
      $score = $bonus + $j + (0.08 * $ov) + (0.25 * $anchorHit)
      if ($score -lt $MinSimilarity -and $bonus -le 0) { continue }

      $matchedRowAnchors = @(
        foreach ($t in $m.tokens) {
          if ($rowAnchorSet.Contains($t)) { $t }
        }
      )

      [pscustomobject]@{
        slug = $m.slug
        question = $m.question
        endDate = $m.endDate
        tokens = $m.tokens
        rowAnchors = $matchedRowAnchors
        score = $score
      }
    }
  )
  $pmTop = @($pmScored | Sort-Object score -Descending | Select-Object -First $TopPmCandidates)

  $kalScored = @(
    foreach ($k in $kalIndex) {
      $anchorHit = OverlapCount -A $rowAnchorTokens -B $k.tokens
      if ($anchorHit -le 0) { continue }
      $rootBonus = 0.0
      if ($k.ticker -eq $kalRoot -or $k.eventTicker -eq $kalRoot) {
        $rootBonus += 8.0
      }
      if ($k.ticker.StartsWith($kalRoot) -or $k.eventTicker.StartsWith($kalRoot)) {
        $rootBonus += 4.0
      }
      foreach ($variant in $kalVariants) {
        if ([string]::IsNullOrWhiteSpace($variant)) { continue }
        if ($k.ticker.StartsWith($variant) -or $k.eventTicker.StartsWith($variant)) {
          $rootBonus += [Math]::Max(1.0, [Math]::Min(3.0, [double]$variant.Length / 10.0))
          break
        }
      }

      $jKal = Jaccard -A $kalNeedleTokens -B $k.tokens
      $jPm = Jaccard -A $pmNeedleTokens -B $k.tokens
      $ovPm = OverlapCount -A $pmNeedleTokens -B $k.tokens
      $score = $rootBonus + [Math]::Max($jKal, $jPm) + (0.08 * $ovPm) + (0.25 * $anchorHit)
      if ($score -lt $MinSimilarity -and $rootBonus -le 0) { continue }

      $matchedRowAnchors = @(
        foreach ($t in $k.tokens) {
          if ($rowAnchorSet.Contains($t)) { $t }
        }
      )

      [pscustomobject]@{
        ticker = $k.ticker
        title = $k.title
        subtitle = $k.subtitle
        closeTime = $k.closeTime
        tokens = $k.tokens
        rowAnchors = $matchedRowAnchors
        score = $score
      }
    }
  )
  $kalTop = @($kalScored | Sort-Object score -Descending | Select-Object -First $TopKalCandidates)

  $addedForRow = 0
  if ($pmTop.Count -gt 0 -and $kalTop.Count -gt 0) {
    $pairCandidates = @(
      foreach ($pmc in $pmTop) {
        foreach ($kalc in $kalTop) {
          $sharedRowAnchors = OverlapCount -A $pmc.rowAnchors -B $kalc.rowAnchors
          if ($sharedRowAnchors -le 0) { continue }
          $crossOverlap = OverlapCount -A $pmc.tokens -B $kalc.tokens
          $crossJ = Jaccard -A $pmc.tokens -B $kalc.tokens
          if ($crossOverlap -eq 0 -and $crossJ -lt $MinCrossSimilarity) {
            continue
          }
          $score = (0.35 * $pmc.score) + (0.35 * $kalc.score) + $crossJ + (0.10 * $crossOverlap) + (0.40 * $sharedRowAnchors)
          [pscustomobject]@{
            pm_market_slug = $pmc.slug
            pm_question = $pmc.question
            pm_end_date = $pmc.endDate
            kal_ticker = $kalc.ticker
            kal_title = $kalc.title
            kal_subtitle = $kalc.subtitle
            kal_close_time = $kalc.closeTime
            match_score = ("similar_{0:N4}" -f $score)
            _score = $score
          }
        }
      }
    )

    $selected = @($pairCandidates | Sort-Object _score -Descending | Select-Object -First $MaxPairsPerRow)
    foreach ($p in $selected) {
      $key = "$($p.pm_market_slug)::$($p.kal_ticker)"
      if ($seenPairs.Contains($key)) { continue }
      $null = $seenPairs.Add($key)
      $pairRows += [pscustomobject]@{
        pm_market_slug = $p.pm_market_slug
        pm_question = $p.pm_question
        pm_end_date = $p.pm_end_date
        kal_ticker = $p.kal_ticker
        kal_title = $p.kal_title
        kal_subtitle = $p.kal_subtitle
        kal_close_time = $p.kal_close_time
        match_score = $p.match_score
      }
      $addedForRow += 1
    }
  }

  if ($addedForRow -eq 0 -and $pmTop.Count -gt 0 -and $kalTop.Count -gt 0) {
    $pmBest = $pmTop[0]
    $kalBest = $kalTop[0]
    $fallbackKey = "$($pmBest.slug)::$($kalBest.ticker)"
    if (-not $seenPairs.Contains($fallbackKey)) {
      $null = $seenPairs.Add($fallbackKey)
      $pairRows += [pscustomobject]@{
        pm_market_slug = $pmBest.slug
        pm_question = $pmBest.question
        pm_end_date = $pmBest.endDate
        kal_ticker = $kalBest.ticker
        kal_title = $kalBest.title
        kal_subtitle = $kalBest.subtitle
        kal_close_time = $kalBest.closeTime
        match_score = "fallback_top1"
      }
      $addedForRow = 1
    }
  }

  $diagnostics += [pscustomobject]@{
    row_index = $w.RowIndex
    pm_slug = $pmSlug
    kal_root = $kalRoot
    pm_core = $pmCore
    pm_candidates = $pmTop.Count
    kal_candidates = $kalTop.Count
    selected_pairs = $addedForRow
    note = if ($addedForRow -gt 0) { "similar_pairs_selected" } else { "no_similar_pair_selected" }
  }
}

$pairsPath = Join-Path $OutputDataDir "market_matches_high.csv"
$diagPath = Join-Path $OutputDataDir "excel_pair_selection.csv"
Write-CsvNoBom -Rows $diagnostics -Path $diagPath
if ($pairRows.Count -gt 0) {
  Write-CsvNoBom -Rows $pairRows -Path $pairsPath
} else {
  Write-Output "[EXCEL_SIM] No pair candidates could be built. See $diagPath"
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

Write-Output "[EXCEL_SIM] watch_rows=$($watchRows.Count) selected_pairs=$($pairRows.Count)"
Write-Output "[EXCEL_SIM] opportunities=$($oppRows.Count)"
Write-Output "[EXCEL_SIM] pair_file=$pairsPath"
Write-Output "[EXCEL_SIM] arbs_file=$arbsPath"
Write-Output "[EXCEL_SIM] diag_file=$diagPath"
if ($top.Count -gt 0) {
  Write-Output "[EXCEL_SIM] Top opportunities:"
  $top |
    Select-Object ts,pair_id,direction,cost,edge,depth_1pct,capital_1pct,profit_1pct,roi_1pct,days_to_settle,roi_1pct_annualized |
    Format-Table -AutoSize
}
