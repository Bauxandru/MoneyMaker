import crypto from "crypto";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config();

const BASE = process.env.KALSHI_BASE_URL ?? "https://api.elections.kalshi.com/trade-api/v2";
function loadPK() { return process.env.KALSHI_PRIVATE_KEY ? process.env.KALSHI_PRIVATE_KEY.replace(/\\n/g, "\n") : fs.readFileSync(process.env.KALSHI_PRIVATE_KEY_PATH!, "utf8"); }
function sign(m: string, p: string, ts: string, pk: string) { const s = crypto.createSign("RSA-SHA256"); s.update(`${ts}${m.toUpperCase()}${p}`); s.end(); return s.sign({key:pk,padding:crypto.constants.RSA_PKCS1_PSS_PADDING,saltLength:32},"base64"); }
async function kalGet(path: string) {
  const kid = process.env.KALSHI_API_KEY_ID!;
  const pk = loadPK();
  const url = new URL(`${BASE}${path}`);
  const ts = Date.now().toString();
  const sig = sign("GET", url.pathname, ts, pk);
  const res = await fetch(url.toString(), { headers: { "KALSHI-ACCESS-KEY": kid, "KALSHI-ACCESS-SIGNATURE": sig, "KALSHI-ACCESS-TIMESTAMP": ts }});
  return res.json();
}

async function main() {
  const resp = await kalGet("/portfolio/fills?limit=3") as any;
  const fills = resp.fills ?? [];
  for (const f of fills) {
    console.log(JSON.stringify(f, null, 2));
    console.log("---");
  }

  // Also get a settlement
  const sResp = await kalGet("/portfolio/settlements?limit=2") as any;
  const setts = sResp.settlements ?? [];
  for (const s of setts) {
    console.log("SETTLEMENT:", JSON.stringify(s, null, 2));
    console.log("---");
  }
}
main();
