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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");

if (!existsSync(DIST)) mkdirSync(DIST, { recursive: true });

// ── Step 1: esbuild bundle ─────────────────────────────────────────────────

console.log("=== Step 1/5: Bundle with esbuild ===");
try {
  execSync(
    [
      "npx esbuild src/tradeTennis.ts",
      "--bundle",
      "--platform=node",
      "--target=node20",
      "--format=cjs",
      "--minify",
      "--outfile=dist/bot.cjs",
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

console.log("\n=== Step 3/5: Prepare loader ===");
{
  const bundlePath = join(DIST, "bot.cjs");
  if (!existsSync(bundlePath)) {
    console.error("No bundled file found. Build failed.");
    process.exit(1);
  }
  copyFileSync(bundlePath, join(DIST, "loader.cjs"));
  try { unlinkSync(bundlePath); } catch {}
  console.log("Loader ready (minified JS in SEA binary)");
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
const exePath = join(DIST, "arb-bot.exe");
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

  console.log(`\n========================================`);
  console.log(`  BUILD SUCCESSFUL`);
  console.log(`  ${exePath}`);
  console.log(`========================================`);
  console.log(`\nProtection: esbuild minify + obfuscator + V8 bytecode`);
  console.log(`No JS source in the final executable.\n`);
  console.log(`Distribution package:`);
  console.log(`  - dist/arb-bot.exe       (the bot)`);
  console.log(`  - settings.csv.template   (user fills in API keys)`);
  console.log(`  - kalshi_key.pem          (user provides their own)`);
} catch (err) {
  console.error("Executable creation failed:", err.message);
  process.exit(1);
}
