param(
  [string]$BaseDataDir = "data",
  [string]$OutputDataDir = "data/focus",
  [double]$MinTitleScore = 0.82,
  [double]$PoliticalTitleMin = 0.90,
  [switch]$UseRescored = $false,
  [switch]$IncludeReview = $true,
  [switch]$SkipDiscover = $false
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

function To-DoubleOrNull {
  param([object]$Value)
  if ($null -eq $Value) { return $null }
  $raw = [string]$Value
  if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
  $n = 0.0
  if ([double]::TryParse($raw, [ref]$n)) { return $n }
  return $null
}

function Format-Num {
  param([Nullable[double]]$Value)
  if ($null -eq $Value) { return "" }
  return ([double]$Value).ToString("0.0000", [System.Globalization.CultureInfo]::InvariantCulture)
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

function Normalize-Text {
  param([string]$Value)
  if ([string]::IsNullOrWhiteSpace($Value)) { return "" }
  return ([string]$Value).ToLower()
}

function Get-LinksFromPairId {
  param([string]$PairId)

  $pmSlug = ""
  $kalTicker = ""
  $raw = [string]$PairId

  if ($raw -match "^polymarket_(.+)__kalshi_(.+)$") {
    $pmSlug = [string]$Matches[1]
    $kalTicker = [string]$Matches[2]
  } elseif ($raw -match "^kalshi_(.+)__polymarket_(.+)$") {
    $kalTicker = [string]$Matches[1]
    $pmSlug = [string]$Matches[2]
  }

  $pmUrl = ""
  if (-not [string]::IsNullOrWhiteSpace($pmSlug)) {
    $pmUrl = "https://polymarket.com/event/$($pmSlug.ToLower())"
  }

  $kalUrl = ""
  if (-not [string]::IsNullOrWhiteSpace($kalTicker)) {
    $kalUrl = "https://kalshi.com/markets/$($kalTicker.ToUpper())"
  }

  return [pscustomobject]@{
    polymarket_url = $pmUrl
    kalshi_url = $kalUrl
  }
}

function Get-CategoryTags {
  param(
    [string]$Text,
    [double]$TitleScore,
    [double]$PoliticalMin
  )
  $tags = New-Object "System.Collections.Generic.HashSet[string]"
  $t = Normalize-Text $Text

  if ($t -match "\b(sport|sports|nba|wnba|nfl|nhl|mlb|epl|premier league|la liga|bundesliga|serie a|uefa|fifa|world cup|olympic|tennis|golf|boxing|ufc|mma|nascar|formula ?1|f1|cricket|counter-?strike|cs2|esport)\b") {
    $null = $tags.Add("sports")
  }
  if ($t -match "\b(fomc|federal reserve|fed funds|fed rate|rate cut|rate hike|interest rate|powell|dot plot)\b") {
    $null = $tags.Add("fomc")
  }
  if ($t -match "\b(netflix|nflx)\b") {
    $null = $tags.Add("netflix")
  }
  if ($t -match "\b(billboard|hot 100|top 100|song|album|artist|grammy|spotify|apple music|itunes|music)\b") {
    $null = $tags.Add("billboard_music")
  }
  if ($TitleScore -ge $PoliticalMin) {
    if ($t -match "\b(politic|election|president|trump|biden|senate|house|congress|governor|white house|state of the union|sotu|prime minister|parliament|minister|campaign|democrat|republican|poll)\b") {
      $null = $tags.Add("political")
    }
  }
  return @($tags | ForEach-Object { [string]$_ })
}

function Restore-Env {
  param([hashtable]$Saved)
  foreach ($k in $Saved.Keys) {
    if ($null -eq $Saved[$k]) {
      Remove-Item "Env:$k" -ErrorAction SilentlyContinue
    } else {
      Set-Item -Path "Env:$k" -Value ([string]$Saved[$k])
    }
  }
}

$null = New-Item -ItemType Directory -Path $OutputDataDir -Force

if (-not $SkipDiscover) {
  Write-Output "[FOCUS] Running fresh full discover for all Polymarket/Kalshi markets..."
  $saved = @{
    DISCOVER_INCREMENTAL   = $env:DISCOVER_INCREMENTAL
    DISCOVER_STOP_ON_KNOWN = $env:DISCOVER_STOP_ON_KNOWN
    POLY_REFRESH_EVENTS    = $env:POLY_REFRESH_EVENTS
    KALSHI_REFRESH_EVENTS  = $env:KALSHI_REFRESH_EVENTS
    MATCH_WORKERS          = $env:MATCH_WORKERS
  }
  try {
    $env:DISCOVER_INCREMENTAL = "false"
    $env:DISCOVER_STOP_ON_KNOWN = "false"
    $env:POLY_REFRESH_EVENTS = "true"
    $env:KALSHI_REFRESH_EVENTS = "true"
    $env:MATCH_WORKERS = "8"
    & npm run discover
    if ($LASTEXITCODE -ne 0) {
      throw "discover failed with exit code $LASTEXITCODE"
    }
  } finally {
    Restore-Env -Saved $saved
  }
}

$high = Join-Path $BaseDataDir "market_matches_high.csv"
$review = Join-Path $BaseDataDir "market_matches_review.csv"
$highRescored = Join-Path $BaseDataDir "market_matches_high_rescored.csv"
$reviewRescored = Join-Path $BaseDataDir "market_matches_review_rescored.csv"

$highPath = if ($UseRescored -and (Test-Path -LiteralPath $highRescored)) { $highRescored } else { $high }
$reviewPath = if ($UseRescored -and (Test-Path -LiteralPath $reviewRescored)) { $reviewRescored } else { $review }

if (-not (Test-Path -LiteralPath $highPath)) {
  throw "Missing high matches file: $highPath"
}

$allRows = @()
$highRows = @(Import-Csv -Path $highPath)
foreach ($r in $highRows) {
  $copy = $r.PSObject.Copy()
  Add-Member -InputObject $copy -MemberType NoteProperty -Name _source_tier -Value "high"
  $allRows += $copy
}
if ($IncludeReview -and (Test-Path -LiteralPath $reviewPath)) {
  $reviewRows = @(Import-Csv -Path $reviewPath)
  foreach ($r in $reviewRows) {
    $copy = $r.PSObject.Copy()
    Add-Member -InputObject $copy -MemberType NoteProperty -Name _source_tier -Value "review"
    $allRows += $copy
  }
}

if ($allRows.Count -eq 0) {
  throw "No rows loaded from high/review match files."
}

Write-Output "[FOCUS] Reading matches high=$($highRows.Count) review=$(if ($IncludeReview -and (Test-Path -LiteralPath $reviewPath)) { @(Import-Csv -Path $reviewPath).Count } else { 0 })"

$selectedRows = @()
$similarRows = @()
$expandedRows = @()
$seenPairs = New-Object "System.Collections.Generic.HashSet[string]"
$categoryCounts = @{
  sports = 0
  fomc = 0
  netflix = 0
  billboard_music = 0
  political = 0
}

foreach ($r in $allRows) {
  $aEx = ([string]$r.a_exchange).ToLower()
  $bEx = ([string]$r.b_exchange).ToLower()
  $isPmKal = ($aEx -eq "polymarket" -and $bEx -eq "kalshi") -or ($aEx -eq "kalshi" -and $bEx -eq "polymarket")
  if (-not $isPmKal) { continue }

  $pmId = ""
  $pmTitle = ""
  $pmSubtitle = ""
  $pmEnd = ""
  $kalTicker = ""
  $kalTitle = ""
  $kalSubtitle = ""
  $kalEnd = ""

  if ($aEx -eq "polymarket") {
    $pmId = [string]$r.a_id
    $pmTitle = [string]$r.a_title
    $pmSubtitle = [string]$r.a_subtitle
    $pmEnd = [string]$r.a_end_date
    $kalTicker = [string]$r.b_id
    $kalTitle = [string]$r.b_title
    $kalSubtitle = [string]$r.b_subtitle
    $kalEnd = [string]$r.b_end_date
  } else {
    $pmId = [string]$r.b_id
    $pmTitle = [string]$r.b_title
    $pmSubtitle = [string]$r.b_subtitle
    $pmEnd = [string]$r.b_end_date
    $kalTicker = [string]$r.a_id
    $kalTitle = [string]$r.a_title
    $kalSubtitle = [string]$r.a_subtitle
    $kalEnd = [string]$r.a_end_date
  }

  if ([string]::IsNullOrWhiteSpace($pmId) -or [string]::IsNullOrWhiteSpace($kalTicker)) {
    continue
  }

  $titleScore = To-DoubleOrZero $r.title_score
  if ($titleScore -lt $MinTitleScore) { continue }
  $joined = "$pmId $pmTitle $pmSubtitle $kalTicker $kalTitle $kalSubtitle"
  $tags = @(Get-CategoryTags -Text $joined -TitleScore $titleScore -PoliticalMin $PoliticalTitleMin)
  if ($tags.Count -eq 0) { continue }

  $pairKey = "$pmId::$kalTicker"
  if ($seenPairs.Contains($pairKey)) { continue }
  $null = $seenPairs.Add($pairKey)

  $selectedRows += $r

  foreach ($tag in $tags) {
    if ($categoryCounts.ContainsKey($tag)) {
      $categoryCounts[$tag] = [int]$categoryCounts[$tag] + 1
    }
    $expandedRows += [pscustomobject]@{
      category      = $tag
      pm_market_slug = $pmId
      kal_ticker    = $kalTicker
      score         = $r.score
      title_score   = $r.title_score
      number_score  = $r.number_score
      time_diff_days = $r.time_diff_days
      pm_title      = $pmTitle
      kal_title     = $kalTitle
      pm_end_date   = $pmEnd
      kal_close_time = $kalEnd
      reasons       = $r.reasons
    }
  }

  $similarRows += [pscustomobject]@{
    source_tier     = [string]$r._source_tier
    categories      = ($tags -join "|")
    pm_market_slug  = $pmId
    kal_ticker      = $kalTicker
    score           = $r.score
    title_score     = $r.title_score
    number_score    = $r.number_score
    outcome_score   = $r.outcome_score
    rules_score     = $r.rules_score
    time_diff_days  = $r.time_diff_days
    pm_title        = $pmTitle
    pm_subtitle     = $pmSubtitle
    pm_end_date     = $pmEnd
    kal_title       = $kalTitle
    kal_subtitle    = $kalSubtitle
    kal_close_time  = $kalEnd
    reasons         = $r.reasons
  }
}

if ($selectedRows.Count -eq 0) {
  throw "No PM/Kalshi focus-category pairs found in $srcPath"
}

$focusMatchesPath = Join-Path $OutputDataDir "market_matches_high.csv"
$similarPath = Join-Path $OutputDataDir "similar_markets_focus.csv"
$expandedPath = Join-Path $OutputDataDir "similar_markets_focus_by_category.csv"
$summaryPath = Join-Path $OutputDataDir "focus_category_counts.csv"

Write-CsvNoBom -Rows $selectedRows -Path $focusMatchesPath
Write-CsvNoBom -Rows $similarRows -Path $similarPath
Write-CsvNoBom -Rows $expandedRows -Path $expandedPath

$summaryRows = @(
  [pscustomobject]@{ category = "sports"; count = $categoryCounts["sports"] },
  [pscustomobject]@{ category = "fomc"; count = $categoryCounts["fomc"] },
  [pscustomobject]@{ category = "netflix"; count = $categoryCounts["netflix"] },
  [pscustomobject]@{ category = "billboard_music"; count = $categoryCounts["billboard_music"] },
  [pscustomobject]@{ category = "political"; count = $categoryCounts["political"] }
)
Write-CsvNoBom -Rows $summaryRows -Path $summaryPath

Write-Output "[FOCUS] selected_pairs=$($selectedRows.Count)"
Write-Output "[FOCUS] sports=$($categoryCounts['sports']) fomc=$($categoryCounts['fomc']) netflix=$($categoryCounts['netflix']) billboard_music=$($categoryCounts['billboard_music']) political=$($categoryCounts['political'])"

$savedScan = @{
  DATA_DIR = $env:DATA_DIR
  SCAN_PREFER_RESCORED = $env:SCAN_PREFER_RESCORED
}
try {
  $env:DATA_DIR = $OutputDataDir
  $env:SCAN_PREFER_RESCORED = "false"
  & npm run scan:high
  if ($LASTEXITCODE -ne 0) {
    throw "scan:high failed with exit code $LASTEXITCODE"
  }
} finally {
  Restore-Env -Saved $savedScan
}

$arbsPath = Join-Path $OutputDataDir "latest_arbs_high_timeleft.csv"
if (-not (Test-Path -LiteralPath $arbsPath)) {
  throw "Missing output file: $arbsPath"
}

$arbRows = @(Import-Csv -Path $arbsPath)
$opps = @(
  $arbRows | Where-Object {
    $ts = ([string]$_.ts).Trim().ToUpper()
    $pairId = ([string]$_.pair_id).Trim()
    $dir = ([string]$_.direction).Trim().ToUpper()
    if ($ts -eq "TOTAL") { return $false }
    if ($pairId -eq "TOTAL" -or [string]::IsNullOrWhiteSpace($pairId)) { return $false }
    if ($dir.StartsWith("STEP_")) { return $false }
    return (To-DoubleOrZero $_.edge) -gt 0
  }
)

$oppsSorted = @(
  $opps | Sort-Object @{
    Expression = { To-DoubleOrZero $_.profit_1pct }
    Descending = $true
  }, @{
    Expression = { To-DoubleOrZero $_.edge }
    Descending = $true
  }
)

$directSorted = @(
  $oppsSorted | Where-Object { ([string]$_.direction).ToUpper() -ne "GROUPED" }
)

$directWithLinks = @()
foreach ($row in $directSorted) {
  $copy = $row.PSObject.Copy()
  $links = Get-LinksFromPairId -PairId ([string]$row.pair_id)
  Add-Member -InputObject $copy -MemberType NoteProperty -Name polymarket_url -Value ([string]$links.polymarket_url) -Force
  Add-Member -InputObject $copy -MemberType NoteProperty -Name kalshi_url -Value ([string]$links.kalshi_url) -Force
  $directWithLinks += $copy
}

$totalCapital = 0.0
$totalProfit = 0.0
$totalWeightedDays = 0.0
$totalCapitalForDays = 0.0
foreach ($row in $directWithLinks) {
  $capital = To-DoubleOrNull $row.capital_1pct
  $profit = To-DoubleOrNull $row.profit_1pct
  if ($null -eq $capital -or $null -eq $profit) { continue }
  $totalCapital += [double]$capital
  $totalProfit += [double]$profit

  $days = To-DoubleOrNull $row.days_to_settle
  if ($null -ne $days) {
    $totalWeightedDays += ([double]$capital * [double]$days)
    $totalCapitalForDays += [double]$capital
  }
}

$totalRoi = $null
if ($totalCapital -gt 0) {
  $totalRoi = $totalProfit / $totalCapital
}

$avgDaysToSettle = $null
if ($totalCapitalForDays -gt 0) {
  $avgDaysToSettle = $totalWeightedDays / $totalCapitalForDays
}

$totalRoiAnnualized = $null
if ($null -ne $totalRoi -and $null -ne $avgDaysToSettle -and $avgDaysToSettle -gt 0) {
  $totalRoiAnnualized = [double]$totalRoi * (365.0 / [double]$avgDaysToSettle)
}

$directWithTotals = @($directWithLinks)
$directWithTotals += [pscustomobject]@{
  ts                 = "TOTAL"
  pair_id            = ""
  direction          = ""
  cost               = ""
  edge               = ""
  depth_1pct         = ""
  capital_1pct       = (Format-Num $totalCapital)
  profit_1pct        = (Format-Num $totalProfit)
  roi_1pct           = (Format-Num $totalRoi)
  days_to_settle     = (Format-Num $avgDaysToSettle)
  roi_1pct_annualized = (Format-Num $totalRoiAnnualized)
  yes_legs           = ""
  no_legs            = ""
  polymarket_url     = ""
  kalshi_url         = ""
}

$oppsPath = Join-Path $OutputDataDir "arbitrage_opportunities_focus.csv"
$directPath = Join-Path $OutputDataDir "arbitrage_opportunities_focus_direct.csv"
Write-CsvNoBom -Rows $oppsSorted -Path $oppsPath
Write-CsvNoBom -Rows $directWithTotals -Path $directPath

Write-Output "[FOCUS] similar_markets_file=$similarPath"
Write-Output "[FOCUS] opportunities_file=$oppsPath"
Write-Output "[FOCUS] direct_opportunities_file=$directPath"
Write-Output "[FOCUS] opportunities=$($oppsSorted.Count) direct=$($directSorted.Count)"
