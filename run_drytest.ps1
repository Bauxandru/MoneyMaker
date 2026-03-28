# Dry-run test script — safe to run, DRY_RUN forced to true
Get-Content .env | ForEach-Object {
    if ($_ -match '^\s*([^#][^=]+)=(.*)$') {
        [System.Environment]::SetEnvironmentVariable($matches[1].Trim(), $matches[2].Trim())
    }
}
$env:DRY_RUN = 'true'
npx tsx src/tradeTennis.ts
