/**
 * loadSettings.ts -- side-effect-only module that loads `settings.txt` into
 * process.env BEFORE any other module runs.
 *
 * Import this FIRST in the entry file: `import "./loadSettings.js";`
 *
 * Lookup order for the file:
 *   1. Same directory as the running executable (dist/settings.txt next to .exe)
 *   2. process.cwd() (dev mode / fallback)
 *
 * Precedence of values (highest wins):
 *   1. Real shell environment variables (anything set before the bot launched)
 *   2. settings.txt
 *   3. Build-time embedded defaults (from the .exe banner)
 *   4. .env (loaded later by dotenv — won't override anything already set)
 *
 * Detection of shell-set keys: a snapshot of process.env is captured at module
 * load. Only keys NOT in the snapshot get overridden by settings.txt values.
 * This means shell vars stay winning, but embedded/.env defaults lose to the
 * file — which matches the "edit a file to tune the bot" workflow.
 */
import fs from "fs";
import path from "path";

// Snapshot the shell env FIRST — anything in here is user-set and stays.
// (In the packaged .exe, the banner runs BEFORE this module and already
//  populated process.env from embedded defaults. We need to distinguish
//  those from real shell vars. We do that by looking for the banner's own
//  marker below.)
const shellEnvKeys = new Set(
  Object.keys(process.env).filter(k => {
    // Skip the banner's marker key, if any
    if (k === "__ARB_EMBEDDED_KEYS") return false;
    return true;
  })
);

// The banner (built into the .exe) writes a comma-separated list of keys it
// set into process.env.__ARB_EMBEDDED_KEYS. We use that to know which existing
// values came from the banner (overridable) vs the shell (not overridable).
const bannerSetKeys = new Set(
  (process.env.__ARB_EMBEDDED_KEYS ?? "").split(",").map(s => s.trim()).filter(Boolean)
);

function isBannerOnly(key: string): boolean {
  return bannerSetKeys.has(key);
}

function isShellSet(key: string): boolean {
  if (bannerSetKeys.has(key)) return false; // it was set by banner, not shell
  return shellEnvKeys.has(key);
}

function locateSettingsFile(): string | null {
  const candidates: string[] = [];
  const exe = process.execPath ?? "";
  // Same dir as the .exe when packaged (skip when running via node.exe itself)
  if (exe && !/node\.exe$/i.test(exe) && !/tsx\.cmd$/i.test(exe)) {
    candidates.push(path.join(path.dirname(exe), "settings.txt"));
  }
  candidates.push(path.join(process.cwd(), "settings.txt"));
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch {}
  }
  return null;
}

(function applySettingsFile() {
  const filePath = locateSettingsFile();
  if (!filePath) return;
  try {
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    let applied = 0, skipped = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (isShellSet(key)) { skipped++; continue; } // real shell var wins
      // Either unset OR banner-set — settings.txt overrides both
      process.env[key] = value;
      applied++;
    }
    const noun = applied === 1 ? "value" : "values";
    console.log(`[SETTINGS] applied ${applied} ${noun} from ${filePath}${skipped > 0 ? ` (${skipped} skipped — already set by shell)` : ""}`);
  } catch (err) {
    console.warn(`[SETTINGS] could not load ${filePath}: ${(err as Error).message}`);
  }
})();
