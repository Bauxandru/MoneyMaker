# LIVE trading — ATP tennis, auto-discovers all cross-listed matches on Kalshi + Polymarket
Get-Content .env | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
        [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim())
    }
}
$env:DRY_RUN = 'false'
npx tsx src/tradeTennis.ts
