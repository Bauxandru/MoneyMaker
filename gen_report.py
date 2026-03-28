import json
from collections import defaultdict

with open('data/discovery_test_results.json', 'r', encoding='utf-8') as f:
    data = json.load(f)

lines = []
lines.append('DISCOVERY RESULTS')
lines.append('=' * 120)
lines.append('')

by_series = defaultdict(list)
for r in data:
    by_series[r['series']].append(r)

mt = 0
nf = 0

for series in sorted(by_series.keys()):
    entries = by_series[series]
    matched = [e for e in entries if e['matchMethod'] != 'NOT FOUND']
    not_found = [e for e in entries if e['matchMethod'] == 'NOT FOUND']
    mt += len(matched)
    nf += len(not_found)
    lines.append(f'--- {series} ({len(matched)} matched, {len(not_found)} not found) ---')
    lines.append('')
    for r in entries:
        found = r['matchMethod'] != 'NOT FOUND'
        status = 'MATCHED' if found else 'NOT FOUND'
        kal_sum = int((r['kal1YesAsk'] + r['kal2YesAsk']) * 100)
        p1 = r['p1']
        p2 = r['p2']
        date = r['date'] or 'no-date'
        k1 = int(r['kal1YesAsk'] * 100)
        k2 = int(r['kal2YesAsk'] * 100)
        lines.append(f'  [{status}] {p1} vs {p2}  ({date})  KAL: {k1}c/{k2}c  sum={kal_sum}c')
        if found:
            slug = r['pmSlug']
            if 'ufc' in r.get('matchMethod', ''):
                pm_url = f'https://polymarket.com/sports/ufc/{slug}'
            elif r['series'].startswith('KXATP'):
                pm_url = f'https://polymarket.com/sports/tennis/{slug}'
            else:
                pm_url = f'https://polymarket.com/event/{slug}'
            o1 = r['pmOutcome1']
            o2 = r['pmOutcome2']
            meth = r['matchMethod']
            lines.append(f'    PM:  {pm_url}')
            lines.append(f'    Outcomes: [{o1}] vs [{o2}]')
            lines.append(f'    Method: {meth}')
        lines.append('')

lines.append('=' * 120)
lines.append(f'TOTAL: {len(data)} pairs | {mt} matched | {nf} not found')

with open('data/discovery_report.txt', 'w', encoding='utf-8') as f:
    f.write('\n'.join(lines))
print(f'Written to data/discovery_report.txt ({len(lines)} lines)')
