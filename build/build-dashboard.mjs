/**
 * Build dashboard into a standalone Windows .exe
 *
 * Usage:   node build/build-dashboard.mjs
 */

import { execSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { randomBytes, createCipheriv } from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");

if (!existsSync(DIST)) mkdirSync(DIST, { recursive: true });

// ── Step 0: Embed config ────────────────────────────────────────────────────

console.log("=== Step 0: Embedding config ===");
const envOverrides = {};
const envPath = join(ROOT, ".env");
if (existsSync(envPath)) {
  const lines = readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    envOverrides[key] = val;
  }
}

// Dashboard-specific overrides
envOverrides["DASHBOARD_PORT"] = envOverrides["DASHBOARD_PORT"] || "3456";
// Use the ingest secret for accepting pushes from remote bots
envOverrides["DASHBOARD_INGEST_SECRET"] = envOverrides["DASHBOARD_INGEST_SECRET"] || "";

// Only keep dashboard-relevant vars (no trading keys needed)
const dashboardVars = [
  "DASHBOARD_PORT", "DASHBOARD_INGEST_SECRET", "DASHBOARD_MIN_DATE",
  "DASHBOARD_PUSH_INTERVAL_MS", "LICENSE_SERVER", "LICENSE_TOKEN",
  "KALSHI_API_KEY_ID", "KALSHI_PRIVATE_KEY_PATH", "KALSHI_PRIVATE_KEY",
  "POLY_WALLET_PRIVATE_KEY", "POLY_API_KEY", "POLY_API_SECRET",
  "POLY_PASSPHRASE", "POLY_CLOB_URL", "POLY_CHAIN_ID", "POLY_RPC_URL",
  "POLY_SIGNATURE_TYPE", "POLY_FUNDER", "POLYGON_WSS_URL",
];

// Embed Kalshi PEM for dashboard's exchange data fetching
const pemPath = envOverrides["KALSHI_PRIVATE_KEY_PATH"];
if (pemPath) {
  const fullPem = join(ROOT, pemPath);
  if (existsSync(fullPem)) {
    envOverrides["KALSHI_PRIVATE_KEY"] = readFileSync(fullPem, "utf8").trim();
    delete envOverrides["KALSHI_PRIVATE_KEY_PATH"];
    console.log("  Embedded Kalshi PEM key");
  }
}

// Encrypt embedded values — see build.mjs for rationale. `strings dashboard.exe`
// should not reveal plaintext secrets (DASHBOARD_INGEST_SECRET, Kalshi PEM,
// etc.). Same AES-256-GCM scheme as the trading bot build.
const _filteredEntries = Object.entries(envOverrides)
  .filter(([k]) => dashboardVars.includes(k) || k.startsWith("DASHBOARD_") || k.startsWith("POLY_") || k.startsWith("KALSHI_"));
const _aesKey = randomBytes(32);
const _scramble = randomBytes(32);
const _scrambledKey = Buffer.alloc(32);
for (let i = 0; i < 32; i++) _scrambledKey[i] = _aesKey[i] ^ _scramble[i];
const _enc = [];
for (const [k, v] of _filteredEntries) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", _aesKey, iv);
  const ct = Buffer.concat([c.update(String(v), "utf8"), c.final()]);
  _enc.push([k, iv.toString("hex"), c.getAuthTag().toString("hex"), ct.toString("hex")]);
}
function _chunkHex(buf, n = 8) {
  const step = Math.ceil(buf.length / n);
  const out = [];
  for (let i = 0; i < buf.length; i += step) out.push(buf.slice(i, i + step).toString("hex"));
  return out;
}
const envBanner = `(function(){
var c=require("crypto");
var kp=${JSON.stringify(_chunkHex(_scrambledKey))}.map(function(s){return Buffer.from(s,"hex");});
var pp=${JSON.stringify(_chunkHex(_scramble))}.map(function(s){return Buffer.from(s,"hex");});
var k=Buffer.concat(kp),p=Buffer.concat(pp),key=Buffer.alloc(k.length);
for(var i=0;i<k.length;i++)key[i]=k[i]^p[i];
function D(i,t,x){var d=c.createDecipheriv("aes-256-gcm",key,Buffer.from(i,"hex"));d.setAuthTag(Buffer.from(t,"hex"));return Buffer.concat([d.update(Buffer.from(x,"hex")),d.final()]).toString("utf8");}
var E=${JSON.stringify(_enc)};
for(var j=0;j<E.length;j++){var e=E[j];if(!process.env[e[0]])process.env[e[0]]=D(e[1],e[2],e[3]);}
})();`;

console.log(`  Config embedded`);

// ── Step 1: esbuild bundle ──────────────────────────────────────────────────

console.log("\n=== Step 1/4: Bundle with esbuild ===");
try {
  execSync(
    [
      "npx esbuild src/dashboard.ts",
      "--bundle",
      "--platform=node",
      "--target=node20",
      "--format=cjs",
      "--minify",
      "--outfile=dist/dashboard-bot.cjs",
      "--external:fs",
      "--external:path",
      "--external:crypto",
      "--external:os",
      "--external:url",
      "--external:net",
      "--external:tls",
      "--external:http",
      "--external:https",
      "--external:http2",
      "--external:stream",
      "--external:zlib",
      "--external:events",
      "--external:util",
      "--external:buffer",
      "--external:child_process",
      "--external:worker_threads",
      "--external:assert",
      "--external:dns",
      "--external:dgram",
      "--external:readline",
      "--external:string_decoder",
      "--external:querystring",
      "--external:async_hooks",
      "--external:perf_hooks",
      "--external:diagnostics_channel",
      "--external:v8",
      "--external:constants",
      "--external:vm",
    ].join(" "),
    { cwd: ROOT, stdio: "inherit" }
  );
} catch (err) {
  console.error("esbuild failed:", err.message);
  process.exit(1);
}

// ── Step 2: Prepare loader ──────────────────────────────────────────────────

console.log("\n=== Step 2/4: Prepare loader ===");
{
  const bundlePath = join(DIST, "dashboard-bot.cjs");
  const bundle = readFileSync(bundlePath, "utf8");
  writeFileSync(join(DIST, "dashboard-loader.cjs"), envBanner + "\n" + bundle);
  try { unlinkSync(bundlePath); } catch {}
  console.log("Loader ready");
}

// ── Step 3: Generate SEA blob ───────────────────────────────────────────────

console.log("\n=== Step 3/4: Generate SEA blob ===");
const seaConfig = {
  main: "dist/dashboard-loader.cjs",
  output: "dist/dashboard-sea.blob",
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: true,
};
writeFileSync(join(ROOT, "build", "sea-dashboard-config.json"), JSON.stringify(seaConfig, null, 2));

try {
  execSync("node --experimental-sea-config build/sea-dashboard-config.json", {
    cwd: ROOT, stdio: "inherit",
  });
} catch (err) {
  console.error("SEA blob generation failed:", err.message);
  process.exit(1);
}

// ── Step 4: Create executable ───────────────────────────────────────────────

console.log("\n=== Step 4/4: Create executable ===");
const exePath = join(DIST, "dashboard.exe");
try {
  copyFileSync(process.execPath, exePath);
  try {
    execSync(
      `npx postject --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 "${exePath}" NODE_SEA_BLOB dist/dashboard-sea.blob`,
      { cwd: ROOT, stdio: "inherit" }
    );
  } catch {
    execSync(
      `npx postject --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 "${exePath}" NODE_SEA_BLOB dist/dashboard-sea.blob --overwrite`,
      { cwd: ROOT, stdio: "inherit" }
    );
  }
  try { unlinkSync(join(DIST, "dashboard-loader.cjs")); } catch {}
  try { unlinkSync(join(DIST, "dashboard-sea.blob")); } catch {}

  console.log(`\n========================================`);
  console.log(`  DASHBOARD BUILD SUCCESSFUL`);
  console.log(`  ${exePath}`);
  console.log(`========================================\n`);
} catch (err) {
  console.error("Executable creation failed:", err.message);
  process.exit(1);
}
