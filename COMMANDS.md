# Commands (PowerShell)

## Full Index (markets + matches)
```powershell
$env:MATCH_WORKERS="20"; npm run discover
```
Outputs:
- `data/polymarket_markets.json`, `data/kalshi_markets.json`, `data/limitless_markets.json`, `data/probable_markets.json`
- `data/market_matches_high.csv`, `data/market_matches_review.csv`

## Fresh Index (only new markets + only new matches)
```powershell
$env:DISCOVER_FRESH="true"; npm run discover; Remove-Item Env:DISCOVER_FRESH -ErrorAction SilentlyContinue
```
Outputs (delta):
- `data/market_matches_high_fresh.csv`, `data/market_matches_review_fresh.csv`

## Full Arbscan (scan all high matches)
```powershell
Remove-Item Env:SCAN_FRESH -ErrorAction SilentlyContinue
npm run scan:high
```
Outputs:
- `data/latest_arbs_high.csv`, `data/latest_arbs_high_timeleft.csv`, `data/latest_quotes_high.csv`, `data/latest_arbs_summary_high.csv`

## Fresh Arbscan (Option A: scan only newly-added high matches/groups)
```powershell
$env:SCAN_FRESH="true"; npm run scan:high; Remove-Item Env:SCAN_FRESH -ErrorAction SilentlyContinue
```
Outputs (delta):
- `data/latest_arbs_high_fresh.csv`, `data/latest_arbs_high_timeleft_fresh.csv`, `data/latest_quotes_high_fresh.csv`, `data/latest_arbs_summary_high_fresh.csv`

## Fresh Pipeline (Fresh Index + Fresh Arbscan)
```powershell
$env:DISCOVER_FRESH="true"; npm run discover; Remove-Item Env:DISCOVER_FRESH -ErrorAction SilentlyContinue
$env:SCAN_FRESH="true"; npm run scan:high; Remove-Item Env:SCAN_FRESH -ErrorAction SilentlyContinue
```

## NegRisk Strategy Scan
```powershell
npm run scan:negrisk
```
Outputs:
- `data/latest_neg_risk_strategy_high.csv`
- `data/latest_neg_risk_strategy_review.csv`
