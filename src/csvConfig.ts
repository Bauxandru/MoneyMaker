import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

/**
 * Load settings from a two-column CSV file and populate process.env.
 * Format: setting,value (lines starting with # are comments, blank lines skipped)
 * Falls back to dotenv if CSV file not found.
 */
export function loadCsvConfig(csvPath: string = "./settings.csv"): boolean {
  const abs = resolve(csvPath);
  if (!existsSync(abs)) {
    return false; // caller can fall back to dotenv
  }

  const raw = readFileSync(abs, "utf8");
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Split on first comma only (value may contain commas)
    const idx = trimmed.indexOf(",");
    if (idx === -1) continue;

    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();

    if (key) {
      // Support multi-line values (like PEM keys) pasted with literal \n
      process.env[key] = value.replace(/\\n/g, "\n");
    }
  }

  console.log(`[CONFIG] Loaded settings from ${abs}`);
  return true;
}
