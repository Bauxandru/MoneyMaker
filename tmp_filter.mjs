import { readFileSync } from 'node:fs';
const t = readFileSync('tmp_tsc.txt', 'utf8');
const skip = ['TS18028','TS1192','TS1259','TS2802','TS1252'];
const lines = t.split('\n').filter(l => {
  if (l.indexOf('tradeTennis') === -1) return false;
  for (const s of skip) { if (l.indexOf(s) !== -1) return false; }
  return true;
});
console.log(lines.join('\n') || 'No new errors');
