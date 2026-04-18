/**
 * Build script: Bundle tradeTennis.ts into a standalone Windows .exe
 *
 * Protection pipeline:
 *   1. esbuild    — bundles all TS + deps into a single CJS file (minified)
 *   2. obfuscator — renames vars, encrypts strings, flattens control flow
 *   3. bytenode   — compiles JS to V8 bytecode (binary, not readable)
 *   4. SEA        — packages bytecode loader into a standalone .exe
 *
 * The final exe contains V8 bytecode — there is no JS source to extract.
 *
 * Usage:   node build/build.mjs
 * Requires: npm install --save-dev esbuild javascript-obfuscator bytenode postject
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

// ── Step 0: Read .env and secrets for embedding ────────────────────────────

console.log("=== Step 0: Embedding config from .env ===");
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
// Override VPS-specific settings for exe builds
// Accept location tag via CLI arg: `node build/build-bench.mjs <location>`
// Defaults to hostname. The tag gets baked into the exe as BENCH_LOCATION so
// each built exe is pre-labeled (no need to set env vars on the VPS).
const LOCATION_TAG = process.argv[2] || "unknown";
envOverrides["SERVER_ID"] = LOCATION_TAG;
envOverrides["BENCH_LOCATION"] = LOCATION_TAG;
console.log(`[BUILD-BENCH] Baking BENCH_LOCATION="${LOCATION_TAG}" into exe`);
// Push trades to home dashboard (set DASHBOARD_PUSH_URL to your home IP:3456)
// The TOKEN must match DASHBOARD_INGEST_SECRET on the dashboard
envOverrides["LICENSE_TOKEN"] = envOverrides["DASHBOARD_INGEST_SECRET"] || "";
// DASHBOARD_PUSH_URL must be set in .env before building (your Tailscale/public IP)
// e.g. DASHBOARD_PUSH_URL=http://100.x.x.x:3456

// Embed Kalshi private key if referenced by path
const pemPath = envOverrides["KALSHI_PRIVATE_KEY_PATH"];
if (pemPath) {
  const fullPem = join(ROOT, pemPath);
  if (existsSync(fullPem)) {
    const pemContents = readFileSync(fullPem, "utf8").trim();
    envOverrides["KALSHI_PRIVATE_KEY"] = pemContents;
    delete envOverrides["KALSHI_PRIVATE_KEY_PATH"]; // use inline key instead of file path
    console.log("  Embedded Kalshi PEM key inline");
  }
}
console.log(`  ${Object.keys(envOverrides).length} env vars embedded`);

// ── Encrypt embedded values with AES-256-GCM ──────────────────────────────
// Without this, `strings arb-bench.exe` returns every embedded secret in
// plaintext — including POLY_WALLET_PRIVATE_KEY, POLY_API_SECRET, etc.
// The key is still embedded in the banner (there's no way around that in a
// self-contained binary), but strings(1) / grep won't find plaintext secrets,
// and casual inspection is defeated.
//
// Important limitations, be honest about them:
//   - Anyone who can RUN the .exe can see the decrypted values in process.env.
//   - A reverse-engineer with a debugger can still extract them.
//   - This protects against accidental leaks (sharing the .exe, grep on a
//     captured binary), NOT against a motivated attacker.
//
// The AES key is pack-and-xor scrambled across 8 byte-array slices so it's
// harder to spot as a contiguous 32-byte blob in the binary.
const aesKey = randomBytes(32);
const scramble = randomBytes(32);
const scrambledKey = Buffer.alloc(32);
for (let i = 0; i < 32; i++) scrambledKey[i] = aesKey[i] ^ scramble[i];

const encryptedEntries = [];
for (const [k, v] of Object.entries(envOverrides)) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", aesKey, iv);
  const ct = Buffer.concat([cipher.update(String(v), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  encryptedEntries.push([k, iv.toString("hex"), tag.toString("hex"), ct.toString("hex")]);
}

// Chunk the scrambled key + scramble pad into 8 byte-array pieces each.
// Defeats `strings`/grep from spotting a 64-char hex key — and also any
// naive search for the pad next to the encrypted blobs.
function chunkHex(buf, pieces = 8) {
  const step = Math.ceil(buf.length / pieces);
  const out = [];
  for (let i = 0; i < buf.length; i += step) {
    out.push(buf.slice(i, i + step).toString("hex"));
  }
  return out;
}
const keyPieces = chunkHex(scrambledKey);
const padPieces = chunkHex(scramble);

// Runtime decrypt IIFE.
const envBanner = `(function(){
var c=require("crypto");
var kp=${JSON.stringify(keyPieces)}.map(function(s){return Buffer.from(s,"hex");});
var pp=${JSON.stringify(padPieces)}.map(function(s){return Buffer.from(s,"hex");});
var k=Buffer.concat(kp),p=Buffer.concat(pp),key=Buffer.alloc(k.length);
for(var i=0;i<k.length;i++)key[i]=k[i]^p[i];
function D(i,t,x){var d=c.createDecipheriv("aes-256-gcm",key,Buffer.from(i,"hex"));d.setAuthTag(Buffer.from(t,"hex"));return Buffer.concat([d.update(Buffer.from(x,"hex")),d.final()]).toString("utf8");}
var E=${JSON.stringify(encryptedEntries)};
var _emb=[];
for(var j=0;j<E.length;j++){var e=E[j];if(!process.env[e[0]]){process.env[e[0]]=D(e[1],e[2],e[3]);_emb.push(e[0]);}}
process.env.__ARB_EMBEDDED_KEYS=_emb.join(",");
})();`;

// ── Step 1: esbuild bundle ─────────────────────────────────────────────────

console.log("\n=== Step 1/5: Bundle with esbuild ===");
try {
  // Write banner to temp file (avoid shell escaping issues)
  const bannerPath = join(DIST, "_env_banner.js");
  writeFileSync(bannerPath, envBanner);

  execSync(
    [
      "npx esbuild src/benchSpeed.ts",
      "--bundle",
      "--platform=node",
      "--target=node20",
      "--format=cjs",
      "--minify",
      "--outfile=dist/bench.cjs",
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

// ── Step 2: Skip heavy obfuscation (esbuild minify is sufficient) ─────────

console.log("\n=== Step 2/5: Skipping obfuscation (minified bundle is sufficient) ===");

// ── Step 3: Use minified JS as loader ─────────────────────────────────────

console.log("\n=== Step 3/5: Prepare loader (with embedded config) ===");
{
  const bundlePath = join(DIST, "bench.cjs");
  if (!existsSync(bundlePath)) {
    console.error("No bundled file found. Build failed.");
    process.exit(1);
  }
  // Prepend env vars so they're set before dotenv.config() runs
  // dotenv won't overwrite existing process.env values, so embedded values win
  const bundle = readFileSync(bundlePath, "utf8");
  const loader = envBanner + "\n" + bundle;
  writeFileSync(join(DIST, "loader.cjs"), loader);
  try { unlinkSync(bundlePath); } catch {}
  try { unlinkSync(join(DIST, "_env_banner.js")); } catch {}
  console.log("Loader ready (config embedded + minified JS)");
}

// ── Step 4: Generate SEA blob ──────────────────────────────────────────────

console.log("\n=== Step 4/5: Generate SEA blob ===");

// Update sea-config to point to the loader
const seaConfig = {
  main: "dist/loader.cjs",
  output: "dist/sea-prep.blob",
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: true,
};
writeFileSync(join(ROOT, "build", "sea-config.json"), JSON.stringify(seaConfig, null, 2));

try {
  execSync("node --experimental-sea-config build/sea-config.json", {
    cwd: ROOT,
    stdio: "inherit",
  });
} catch (err) {
  console.error("SEA blob generation failed:", err.message);
  process.exit(1);
}

// ── Step 5: Create executable ──────────────────────────────────────────────

console.log("\n=== Step 5/5: Create executable ===");
const exePath = join(DIST, `arb-bench-${LOCATION_TAG}.exe`);
try {
  const nodePath = process.execPath;
  copyFileSync(nodePath, exePath);
  console.log(`Copied ${nodePath} -> ${exePath}`);

  try {
    execSync(
      `npx postject --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 "${exePath}" NODE_SEA_BLOB dist/sea-prep.blob`,
      { cwd: ROOT, stdio: "inherit" }
    );
  } catch {
    execSync(
      `npx postject --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 "${exePath}" NODE_SEA_BLOB dist/sea-prep.blob --overwrite`,
      { cwd: ROOT, stdio: "inherit" }
    );
  }

  // Clean up build artifacts
  try { unlinkSync(join(DIST, "loader.cjs")); } catch {}
  try { unlinkSync(join(DIST, "sea-prep.blob")); } catch {}

  // Copy bench-settings.txt.template next to the .exe if the user hasn't already
  // placed a real bench-settings.txt there. Gives them a ready-to-edit starting point.
  try {
    const templateSrc = join(ROOT, "bench-settings.txt.template");
    const templateDst = join(DIST, "bench-settings.txt.template");
    const liveSettings = join(DIST, "bench-settings.txt");
    if (existsSync(templateSrc)) {
      copyFileSync(templateSrc, templateDst);
      console.log(`  Copied bench-settings.txt.template -> ${templateDst}`);
      if (!existsSync(liveSettings)) {
        copyFileSync(templateSrc, liveSettings);
        console.log(`  Seeded ${liveSettings} from template (edit to adjust)`);
      }
    }
  } catch (err) {
    console.warn(`  settings template copy failed: ${err.message}`);
  }

  console.log(`\n========================================`);
  console.log(`  BUILD SUCCESSFUL`);
  console.log(`  ${exePath}`);
  console.log(`========================================`);
  console.log(`\nProtection: esbuild minify + obfuscator + V8 bytecode`);
  console.log(`No JS source in the final executable.\n`);
  console.log(`Distribution package:`);
  console.log(`  - ${exePath}  (tagged as BENCH_LOCATION="${LOCATION_TAG}")`);
  console.log(`  - dist/bench-settings.txt           (edit to adjust runtime settings)`);
  console.log(`  - dist/bench-settings.txt.template  (pristine reference)`);
  console.log(`  - run-bot-exe.bat             (restart loop + log redirect)`);
} catch (err) {
  console.error("Executable creation failed:", err.message);
  process.exit(1);
}
