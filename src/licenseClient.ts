import https from "https";
import http from "http";
import { execSync } from "child_process";
import { createInterface } from "readline";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename_lc = fileURLToPath(import.meta.url);
const __dirname_lc = dirname(__filename_lc);

function getLocalVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname_lc, "..", "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function askYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "yes" || a === "y");
    });
  });
}

async function performAutoUpdate(): Promise<void> {
  console.log("\n[UPDATE] Pulling latest code from git...");
  try {
    execSync("git pull", { stdio: "inherit", cwd: join(__dirname_lc, "..") });
    console.log("[UPDATE] Installing dependencies...");
    execSync("npm install", { stdio: "inherit", cwd: join(__dirname_lc, "..") });
    console.log("[UPDATE] Update complete! Restarting bot...\n");
    // Re-exec the process with same args
    const args = process.argv.slice(1);
    execSync(`"${process.argv[0]}" ${args.map(a => `"${a}"`).join(" ")}`, {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    process.exit(0);
  } catch (err: any) {
    console.error(`[UPDATE] Auto-update failed: ${err.message}`);
    console.error("[UPDATE] Please update manually: git pull && npm install");
    process.exit(1);
  }
}

const LICENSE_SERVER = () => process.env.LICENSE_SERVER || "";
const LICENSE_TOKEN = () => process.env.LICENSE_TOKEN || "";
const REVALIDATE_MS = () =>
  parseInt(process.env.LICENSE_REVALIDATE_INTERVAL_MS || "300000", 10); // 5 min

let _licenseValid = false;
let _userName = "";
let _userId = 0;
let _consecutiveFailures = 0;
let _revalidateTimer: ReturnType<typeof setInterval> | null = null;

/**
 * POST JSON to the license server. Accepts self-signed certs.
 * Does NOT affect TLS for other connections (Kalshi, Polymarket).
 */
function licensePost(url: string, body: object): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const isHttps = parsed.protocol === "https:";
    const mod = isHttps ? https : http;

    const options: https.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      timeout: 10_000,
      // Accept self-signed certs for license server only
      ...(isHttps ? { rejectUnauthorized: false } : {}),
    };

    const req = mod.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk) => { raw += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode || 0, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode || 0, data: { error: raw } });
        }
      });
    });

    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Timeout")); });
    req.write(JSON.stringify(body));
    req.end();
  });
}

export function isLicenseValid(): boolean {
  return _licenseValid;
}

export function getLicenseUser(): { name: string; id: number } {
  return { name: _userName, id: _userId };
}

/**
 * Validate license with the remote server. Throws on failure (for startup).
 */
export async function validateLicense(): Promise<void> {
  const server = LICENSE_SERVER();
  const token = LICENSE_TOKEN();

  if (!server || !token) {
    throw new Error(
      "[LICENSE] Missing LICENSE_SERVER or LICENSE_TOKEN in settings. Cannot start."
    );
  }

  const url = `${server.replace(/\/+$/, "")}/validate`;

  let result: { status: number; data: any };
  try {
    result = await licensePost(url, { token });
  } catch (err: any) {
    throw new Error(
      `[LICENSE] Cannot reach license server at ${server}: ${err.message}`
    );
  }

  if (result.status < 200 || result.status >= 300 || !result.data.valid) {
    throw new Error(
      `[LICENSE] Validation failed: ${result.data.error || "status " + result.status}`
    );
  }

  _licenseValid = true;
  _userName = result.data.user_name || "";
  _userId = result.data.user_id || 0;
  _consecutiveFailures = 0;
  console.log(`[LICENSE] Validated as "${_userName}" (id=${_userId})`);

  // ── Version check ──
  const minVersion = result.data.min_version;
  if (minVersion) {
    const localVersion = getLocalVersion();
    if (compareVersions(localVersion, minVersion) < 0) {
      console.log(`\n${"=".repeat(60)}`);
      console.log(`  UPDATE REQUIRED`);
      console.log(`  Your version:    ${localVersion}`);
      console.log(`  Required version: ${minVersion}`);
      console.log(`${"=".repeat(60)}\n`);

      const doUpdate = await askYesNo("[UPDATE] Do you want to update now? (yes/no): ");
      if (doUpdate) {
        await performAutoUpdate();
      } else {
        console.log("[UPDATE] Update declined. Bot cannot start with an outdated version.");
        process.exit(1);
      }
    } else {
      console.log(`[LICENSE] Version check OK (local=${localVersion}, required>=${minVersion})`);
    }
  }
}

/**
 * Start periodic re-validation. Call after initial validateLicense() succeeds.
 */
export function startPeriodicRevalidation(): void {
  if (_revalidateTimer) return;

  const intervalMs = REVALIDATE_MS();
  console.log(
    `[LICENSE] Periodic revalidation every ${Math.round(intervalMs / 60000)} min`
  );

  _revalidateTimer = setInterval(async () => {
    try {
      const server = LICENSE_SERVER();
      const token = LICENSE_TOKEN();
      const url = `${server.replace(/\/+$/, "")}/validate`;

      const result = await licensePost(url, { token });

      if (result.status >= 200 && result.status < 300 && result.data.valid) {
        _licenseValid = true;
        _consecutiveFailures = 0;

        // Version check on every revalidation
        const minVersion = result.data.min_version;
        if (minVersion) {
          const localVersion = getLocalVersion();
          if (compareVersions(localVersion, minVersion) < 0) {
            console.log(`\n${"=".repeat(60)}`);
            console.log(`  UPDATE REQUIRED — BOT STOPPING`);
            console.log(`  Your version:    ${localVersion}`);
            console.log(`  Required version: ${minVersion}`);
            console.log(`${"=".repeat(60)}\n`);

            const doUpdate = await askYesNo("[UPDATE] Do you want to update now? (yes/no): ");
            if (doUpdate) {
              await performAutoUpdate();
            } else {
              console.log("[UPDATE] Update declined. Bot cannot continue with an outdated version.");
              process.exit(1);
            }
          }
        }
      } else {
        _licenseValid = false;
        _consecutiveFailures++;
        console.warn(
          `[LICENSE] Revalidation failed (${_consecutiveFailures}): ${result.data.error || "status " + result.status}`
        );
      }
    } catch (err: any) {
      _licenseValid = false;
      _consecutiveFailures++;
      console.warn(
        `[LICENSE] Revalidation error (${_consecutiveFailures}): ${err.message}`
      );
    }

    if (_consecutiveFailures >= 10) {
      console.error(
        "[LICENSE] 10 consecutive revalidation failures. Shutting down."
      );
      process.exit(1);
    }
  }, intervalMs);
}

/**
 * Stop periodic revalidation (for clean shutdown).
 */
export function stopPeriodicRevalidation(): void {
  if (_revalidateTimer) {
    clearInterval(_revalidateTimer);
    _revalidateTimer = null;
  }
}
