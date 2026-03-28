# LIVE trading — hardcoded markets (Dota 2 etc.)
Get-Content .env | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
        [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim())
    }
}
$env:DRY_RUN = 'false'
$env:HARDCODED_MARKETS = 'true'
npx tsx src/tradeTennis.ts
