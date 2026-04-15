/**
 * Build probeExecutionSpeed.ts into a standalone binary.
 *
 * Produces TWO outputs:
 *   1. dist/probe-speed.exe     — Windows SEA binary, zero deps, run anywhere
 *   2. dist/probe-speed.cjs     — Node-runnable CJS bundle, for Linux/Mac VPS
 *                                 (install node once: `apt install nodejs`)
 *
 * Usage:
 *   node build/build-bench.mjs
 *
 * Deploy to Toronto VPS:
 *   Linux:  scp dist/probe-speed.cjs user@vps:/path/ && ssh user@vps 'node probe-speed.cjs'
 *   Windows: scp dist/probe-speed.exe user@vps:/path/ && ssh user@vps probe-speed.exe
 *
 * Reads SERVER_ID and KALSHI_/POLY_ credentials from .env at build time so
 * the bench can access the same APIs without a local .env on the target box.
 */
import { execSync } from "child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");
const BUILD = join(ROOT, "build");

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

// Embed Kalshi PEM so signed-auth benchmarks work without a local key file
const pemPath = envOverrides["KALSHI_PRIVATE_KEY_PATH"];
if (pemPath) {
  const fullPem = join(ROOT, pemPath);
  if (existsSync(fullPem)) {
    envOverrides["KALSHI_PRIVATE_KEY"] = readFileSync(fullPem, "utf8").trim();
    delete envOverrides["KALSHI_PRIVATE_KEY_PATH"];
    console.log("  Embedded Kalshi PEM key");
  }
}

// SERVER_ID is set at BUILD TIME — not runtime — so each server gets a unique tag.
// Override per-binary: run build with SERVER_ID_OVERRIDE=toronto-vps for the VPS copy.
if (process.env.SERVER_ID_OVERRIDE) {
  envOverrides["SERVER_ID"] = process.env.SERVER_ID_OVERRIDE;
  console.log(`  SERVER_ID override: ${process.env.SERVER_ID_OVERRIDE}`);
}

const benchVars = [
  "SERVER_ID",
  "KALSHI_API_KEY_ID", "KALSHI_PRIVATE_KEY_PATH", "KALSHI_PRIVATE_KEY", "KALSHI_BASE_URL",
  "POLY_WALLET_PRIVATE_KEY", "POLY_FUNDER", "POLY_CLOB_URL", "POLY_CHAIN_ID",
  "POLY_DATA_URL", "POLY_GAMMA_URL", "POLY_RPC_URL", "POLYGON_WSS_URL",
];

const envBanner = `(function(){${Object.entries(envOverrides)
  .filter(([k]) => benchVars.includes(k) || k.startsWith("POLY_") || k.startsWith("KALSHI_") || k === "SERVER_ID")
  .map(([k, v]) => `process.env[${JSON.stringify(k)}]=process.env[${JSON.stringify(k)}]||${JSON.stringify(v)};`)
  .join("")}})();`;

console.log(`  Config embedded (${Object.keys(envOverrides).length} vars, ${benchVars.length} allowlisted)`);

// ── Step 1: esbuild bundle ──────────────────────────────────────────────────

console.log("\n=== Step 1/4: Bundle with esbuild ===");
try {
  execSync(
    [
      "npx esbuild src/probeExecutionSpeed.ts",
      "--bundle",
      "--platform=node",
      "--target=node20",
      "--format=cjs",
      "--outfile=dist/probe-speed-raw.cjs",
      // Keep node built-ins external (resolved at runtime)
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

// ── Step 2: Prepend config banner ────────────────────────────────────────────

console.log("\n=== Step 2/4: Prepend config banner ===");
const rawPath = join(DIST, "probe-speed-raw.cjs");
const cjsPath = join(DIST, "probe-speed.cjs");
const bundle = readFileSync(rawPath, "utf8");
writeFileSync(cjsPath, envBanner + "\n" + bundle);
try { unlinkSync(rawPath); } catch {}
console.log(`  Produced: ${cjsPath} (run with: node ${cjsPath})`);

// ── Step 3: Generate SEA blob ───────────────────────────────────────────────

console.log("\n=== Step 3/4: Generate SEA blob ===");
const seaConfig = {
  main: "dist/probe-speed.cjs",
  output: "dist/probe-speed-sea.blob",
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: true,
};
writeFileSync(join(BUILD, "sea-probe-config.json"), JSON.stringify(seaConfig, null, 2));

try {
  execSync("node --experimental-sea-config build/sea-probe-config.json", {
    cwd: ROOT, stdio: "inherit",
  });
} catch (err) {
  console.error("SEA blob generation failed:", err.message);
  process.exit(1);
}

// ── Step 4: Create Windows .exe ──────────────────────────────────────────────

console.log("\n=== Step 4/4: Create executable ===");
const exePath = join(DIST, "probe-speed.exe");
try {
  copyFileSync(process.execPath, exePath);
  try {
    execSync(
      `npx postject --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 "${exePath}" NODE_SEA_BLOB dist/probe-speed-sea.blob`,
      { cwd: ROOT, stdio: "inherit" }
    );
  } catch {
    execSync(
      `npx postject --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 "${exePath}" NODE_SEA_BLOB dist/probe-speed-sea.blob --overwrite`,
      { cwd: ROOT, stdio: "inherit" }
    );
  }
  try { unlinkSync(join(DIST, "probe-speed-sea.blob")); } catch {}

  console.log(`\n========================================`);
  console.log(`  PROBE-SPEED BUILD SUCCESSFUL`);
  console.log(`========================================`);
  console.log(`  Windows:  ${exePath}`);
  console.log(`  Linux/Mac: ${cjsPath}  (requires: apt install nodejs)`);
  console.log(`\nUsage on local machine:`);
  console.log(`  ${exePath}`);
  console.log(`\nUsage on Linux VPS:`);
  console.log(`  scp dist/probe-speed.cjs user@vps:~/`);
  console.log(`  ssh user@vps 'SERVER_ID=ashburn-vps node probe-speed.cjs'`);
  console.log();
} catch (err) {
  console.error("Executable creation failed:", err.message);
  process.exit(1);
}
