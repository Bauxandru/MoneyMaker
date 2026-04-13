import dotenv from "dotenv";
dotenv.config();

import express from "express";
import crypto from "crypto";
import https from "https";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = join(__dirname, "..");

const PORT = parseInt(process.env.LICENSE_PORT || "3457", 10);
const ADMIN_KEY = process.env.LICENSE_ADMIN_KEY;

if (!ADMIN_KEY) {
  console.error("[LICENSE] Set LICENSE_ADMIN_KEY env var to secure admin endpoints.");
  process.exit(1);
}

// -- JSON file storage (no native deps) --------------------------------------

interface User {
  id: number;
  name: string;
  token: string;
  allowed_ips: string;
  active: boolean;
  created_at: string;
}

interface LogEntry {
  token: string;
  ip: string;
  result: string;
  user_name: string;
  ts: string;
}

interface LicenseData {
  users: User[];
  logs: LogEntry[];
  nextId: number;
  min_version?: string;
}

const DB_PATH = join(ROOT, "data", "license.json");

function loadDb(): LicenseData {
  if (!existsSync(DB_PATH)) {
    return { users: [], logs: [], nextId: 1 };
  }
  try {
    return JSON.parse(readFileSync(DB_PATH, "utf8"));
  } catch {
    return { users: [], logs: [], nextId: 1 };
  }
}

function saveDb(data: LicenseData): void {
  writeFileSync(DB_PATH, JSON.stringify(data, null, 2), "utf8");
}

function addLog(data: LicenseData, token: string, ip: string, result: string, user_name: string): void {
  data.logs.push({ token, ip, result, user_name, ts: new Date().toISOString() });
  // Keep last 500 entries
  if (data.logs.length > 500) data.logs = data.logs.slice(-500);
  saveDb(data);
}

// -- Helpers -----------------------------------------------------------------

function generateToken(): string {
  return crypto.randomUUID();
}

function extractIp(req: express.Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = typeof forwarded === "string"
    ? forwarded.split(",")[0].trim()
    : req.socket.remoteAddress || "unknown";
  return raw.replace(/^::ffff:/, "");
}

function checkAdmin(req: express.Request, res: express.Response): boolean {
  const key = req.headers["x-admin-key"];
  if (key !== ADMIN_KEY) {
    res.status(401).json({ error: "Invalid admin key" });
    return false;
  }
  return true;
}

// -- Rate Limiting -----------------------------------------------------------

const rateLimitMap = new Map<string, { count: number; resetAt: number; blocked: boolean }>();
const RATE_WINDOW_MS = 60_000;    // 1 minute window
const RATE_MAX_REQUESTS = 20;     // max 20 requests per minute per IP
const BLOCK_DURATION_MS = 600_000; // block for 10 minutes after exceeding limit

function rateLimit(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const ip = extractIp(req);
  const now = Date.now();

  let entry = rateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS, blocked: false };
    rateLimitMap.set(ip, entry);
  }

  if (entry.blocked && now < entry.resetAt) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    console.warn(`[RATE] Blocked request from ${ip} (${retryAfter}s remaining)`);
    res.status(429).json({ error: "Too many requests", retry_after: retryAfter });
    return;
  }

  entry.count++;
  if (entry.count > RATE_MAX_REQUESTS) {
    entry.blocked = true;
    entry.resetAt = now + BLOCK_DURATION_MS;
    console.warn(`[RATE] IP ${ip} blocked for ${BLOCK_DURATION_MS / 1000}s -- exceeded ${RATE_MAX_REQUESTS} req/min`);
    res.status(429).json({ error: "Rate limit exceeded. Blocked for 10 minutes." });
    return;
  }

  next();
}

// Clean up stale rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now > entry.resetAt) rateLimitMap.delete(ip);
  }
}, 300_000);

// -- SSL Certificate --------------------------------------------------------

const CERTS_DIR = join(ROOT, "certs");

function ensureSelfSignedCert(): { key: string; cert: string } {
  const keyPath = join(CERTS_DIR, "server.key");
  const certPath = join(CERTS_DIR, "server.crt");

  if (existsSync(keyPath) && existsSync(certPath)) {
    return {
      key: readFileSync(keyPath, "utf8"),
      cert: readFileSync(certPath, "utf8"),
    };
  }

  console.log("[SSL] Generating self-signed certificate...");
  if (!existsSync(CERTS_DIR)) mkdirSync(CERTS_DIR, { recursive: true });

  try {
    execSync(
      `openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/CN=arb-license-server"`,
      { stdio: "pipe" }
    );
    console.log("[SSL] Self-signed certificate created (valid 365 days)");
  } catch {
    console.warn("[SSL] openssl not found -- falling back to HTTP only");
    return { key: "", cert: "" };
  }

  return {
    key: readFileSync(keyPath, "utf8"),
    cert: readFileSync(certPath, "utf8"),
  };
}

// -- Express App -------------------------------------------------------------

const app = express();
app.use(express.json());
app.use(rateLimit);

// -- Validate License (called by bots) ---------------------------------------

app.post("/validate", (req, res) => {
  const { token } = req.body || {};
  const ip = extractIp(req);
  const data = loadDb();

  if (!token) {
    addLog(data, "", ip, "missing_token", "");
    res.status(400).json({ valid: false, error: "Missing token" });
    return;
  }

  const user = data.users.find(u => u.token === token);

  if (!user) {
    addLog(data, token, ip, "unknown_token", "");
    res.status(403).json({ valid: false, error: "Unknown token" });
    return;
  }

  if (!user.active) {
    addLog(data, token, ip, "deactivated", user.name);
    res.status(403).json({ valid: false, error: "License deactivated" });
    return;
  }

  // Check IP whitelist
  const allowedIps = user.allowed_ips
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  if (allowedIps.length > 0 && !allowedIps.includes(ip)) {
    addLog(data, token, ip, "ip_denied", user.name);
    res.status(403).json({ valid: false, error: `IP ${ip} not whitelisted` });
    return;
  }

  addLog(data, token, ip, "valid", user.name);
  res.json({ valid: true, user_name: user.name, user_id: user.id, min_version: data.min_version || null });
});

// -- Admin: List Users -------------------------------------------------------

app.get("/users", (req, res) => {
  if (!checkAdmin(req, res)) return;
  res.json(loadDb().users);
});

// -- Admin: Add User ---------------------------------------------------------

app.post("/users", (req, res) => {
  if (!checkAdmin(req, res)) return;

  const { name, allowed_ips } = req.body || {};
  if (!name) {
    res.status(400).json({ error: "Name required" });
    return;
  }

  const data = loadDb();
  const token = generateToken();
  const ips = allowed_ips || "";
  const id = data.nextId++;

  const user: User = {
    id,
    name,
    token,
    allowed_ips: ips,
    active: true,
    created_at: new Date().toISOString(),
  };

  data.users.push(user);
  saveDb(data);

  console.log(`[LICENSE] Added user: ${name} (id=${id}, ips=${ips || "any"})`);

  res.status(201).json({
    id,
    name,
    token,
    allowed_ips: ips,
    active: true,
  });
});

// -- Admin: Deactivate User --------------------------------------------------

app.delete("/users/:id", (req, res) => {
  if (!checkAdmin(req, res)) return;
  const id = parseInt(req.params.id, 10);
  const data = loadDb();
  const user = data.users.find(u => u.id === id);
  if (user) {
    user.active = false;
    saveDb(data);
    console.log(`[LICENSE] Deactivated user id=${id} (${user.name})`);
  }
  res.json({ ok: true });
});

// -- Admin: Reactivate User --------------------------------------------------

app.post("/users/:id/activate", (req, res) => {
  if (!checkAdmin(req, res)) return;
  const id = parseInt(req.params.id, 10);
  const data = loadDb();
  const user = data.users.find(u => u.id === id);
  if (user) {
    user.active = true;
    saveDb(data);
    console.log(`[LICENSE] Reactivated user id=${id} (${user.name})`);
  }
  res.json({ ok: true });
});

// -- Admin: Update Allowed IPs -----------------------------------------------

app.patch("/users/:id", (req, res) => {
  if (!checkAdmin(req, res)) return;
  const id = parseInt(req.params.id, 10);
  const { allowed_ips } = req.body || {};

  if (allowed_ips === undefined) {
    res.status(400).json({ error: "Provide allowed_ips" });
    return;
  }

  const data = loadDb();
  const user = data.users.find(u => u.id === id);
  if (user) {
    user.allowed_ips = allowed_ips;
    saveDb(data);
    console.log(`[LICENSE] Updated IPs for user id=${id}: ${allowed_ips}`);
  }
  res.json({ ok: true });
});

// -- Admin: View Validation Logs ---------------------------------------------

app.get("/logs", (req, res) => {
  if (!checkAdmin(req, res)) return;
  const logs = loadDb().logs.slice(-100).reverse();
  res.json(logs);
});

// -- Admin: Get/Set Minimum Version ---------------------------------------

app.get("/version", (req, res) => {
  if (!checkAdmin(req, res)) return;
  const data = loadDb();
  res.json({ min_version: data.min_version || null });
});

app.post("/version", (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { min_version } = req.body || {};
  if (!min_version || !/^\d+\.\d+\.\d+$/.test(min_version)) {
    res.status(400).json({ error: "Provide min_version in semver format (e.g. 1.0.0)" });
    return;
  }
  const data = loadDb();
  data.min_version = min_version;
  saveDb(data);
  console.log(`[LICENSE] Minimum version set to ${min_version}`);
  res.json({ ok: true, min_version });
});

// -- Admin Dashboard (browser UI) --------------------------------------------

app.get("/admin", (req, res) => {
  const key = req.query.key as string;
  if (key !== ADMIN_KEY) {
    res.status(401).send("Add ?key=YOUR_ADMIN_KEY to the URL");
    return;
  }
  res.type("html").send(ADMIN_HTML.replace(/\{\{ADMIN_KEY\}\}/g, key));
});

const ADMIN_HTML = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>License Admin</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:Consolas,monospace; background:#0d1117; color:#c9d1d9; padding:24px; }
  h1 { color:#58a6ff; margin-bottom:16px; }
  h2 { color:#8b949e; margin:20px 0 10px; font-size:14px; }
  table { width:100%; border-collapse:collapse; margin-bottom:20px; }
  th,td { padding:8px 12px; text-align:left; border-bottom:1px solid #21262d; font-size:13px; }
  th { color:#8b949e; }
  .active { color:#3fb950; }
  .inactive { color:#f85149; }
  button { background:#21262d; color:#c9d1d9; border:1px solid #30363d; padding:4px 12px; border-radius:4px; cursor:pointer; font-family:inherit; font-size:12px; }
  button:hover { background:#30363d; }
  button.danger { border-color:#f85149; color:#f85149; }
  button.success { border-color:#3fb950; color:#3fb950; }
  input { background:#0d1117; color:#c9d1d9; border:1px solid #30363d; padding:6px 10px; border-radius:4px; font-family:inherit; font-size:13px; margin-right:8px; }
  .form-row { display:flex; gap:8px; margin-bottom:16px; align-items:center; }
  .token { font-size:11px; color:#f0883e; user-select:all; cursor:pointer; }
  .log-entry { font-size:12px; padding:4px 8px; }
  .log-valid { color:#3fb950; }
  .log-denied { color:#f85149; }
  #status { padding:8px; margin:8px 0; border-radius:4px; display:none; }
</style></head><body>
<h1>License Server Admin</h1>
<div id="status"></div>

<h2>Add User</h2>
<div class="form-row">
  <input id="newName" placeholder="User name" />
  <input id="newIps" placeholder="Allowed IPs (comma-separated, empty=any)" style="width:300px" />
  <button class="success" onclick="addUser()">+ Add User</button>
</div>

<h2>Minimum Version</h2>
<div class="form-row">
  <span style="color:#8b949e">Current:</span> <span id="curVersion" style="color:#f0883e">loading...</span>
  <input id="newVersion" placeholder="e.g. 1.1.0" style="width:120px" />
  <button class="success" onclick="setVersion()">Set Min Version</button>
</div>

<h2>Users</h2>
<table id="usersTable"><thead><tr><th>ID</th><th>Name</th><th>Token</th><th>Allowed IPs</th><th>Status</th><th>Created</th><th>Actions</th></tr></thead><tbody></tbody></table>

<h2>Recent Validation Logs</h2>
<table id="logsTable"><thead><tr><th>Time</th><th>User</th><th>IP</th><th>Result</th></tr></thead><tbody></tbody></table>

<script>
var KEY = "{{ADMIN_KEY}}";
var headers = {"Content-Type":"application/json","X-Admin-Key":KEY};

function showStatus(msg, ok) {
  var el = document.getElementById("status");
  el.textContent = msg;
  el.style.display = "block";
  el.style.background = ok ? "#0f2d1a" : "#2d0f0f";
  el.style.color = ok ? "#3fb950" : "#f85149";
  setTimeout(function(){ el.style.display="none"; }, 3000);
}

function loadUsers() {
  fetch("/users", {headers:headers}).then(function(r){return r.json();}).then(function(users){
    var tb = document.querySelector("#usersTable tbody");
    tb.innerHTML = "";
    users.forEach(function(u){
      var tr = document.createElement("tr");
      tr.innerHTML = '<td>'+u.id+'</td><td>'+u.name+'</td><td class="token">'+u.token+'</td>'
        +'<td>'+( u.allowed_ips || '<em style="color:#484f58">any</em>')+'</td>'
        +'<td class="'+(u.active?'active':'inactive')+'">'+(u.active?'Active':'Inactive')+'</td>'
        +'<td style="color:#484f58">'+new Date(u.created_at).toLocaleDateString()+'</td>'
        +'<td>'+(u.active
          ? '<button class="danger" onclick="deactivate('+u.id+')">Deactivate</button>'
          : '<button class="success" onclick="activate('+u.id+')">Activate</button>')
        +' <button onclick="editIps('+u.id+',\\''+u.allowed_ips+'\\')">Edit IPs</button></td>';
      tb.appendChild(tr);
    });
  });
}

function loadLogs() {
  fetch("/logs", {headers:headers}).then(function(r){return r.json();}).then(function(logs){
    var tb = document.querySelector("#logsTable tbody");
    tb.innerHTML = "";
    logs.slice(0,50).forEach(function(l){
      var cls = l.result === "valid" ? "log-valid" : "log-denied";
      var tr = document.createElement("tr");
      tr.className = "log-entry " + cls;
      tr.innerHTML = '<td>'+new Date(l.ts).toLocaleString()+'</td><td>'+l.user_name+'</td><td>'+l.ip+'</td><td>'+l.result+'</td>';
      tb.appendChild(tr);
    });
  });
}

function addUser() {
  var name = document.getElementById("newName").value.trim();
  var ips = document.getElementById("newIps").value.trim();
  if (!name) { showStatus("Name required", false); return; }
  fetch("/users", {method:"POST",headers:headers,body:JSON.stringify({name:name,allowed_ips:ips})})
    .then(function(r){return r.json();})
    .then(function(u){
      showStatus("Added "+u.name+" -- token: "+u.token, true);
      document.getElementById("newName").value = "";
      document.getElementById("newIps").value = "";
      loadUsers();
    });
}

function deactivate(id) {
  fetch("/users/"+id, {method:"DELETE",headers:headers}).then(function(){
    showStatus("User deactivated", true); loadUsers();
  });
}

function activate(id) {
  fetch("/users/"+id+"/activate", {method:"POST",headers:headers}).then(function(){
    showStatus("User activated", true); loadUsers();
  });
}

function editIps(id, current) {
  var ips = prompt("Allowed IPs (comma-separated, empty=any):", current);
  if (ips === null) return;
  fetch("/users/"+id, {method:"PATCH",headers:headers,body:JSON.stringify({allowed_ips:ips})})
    .then(function(){ showStatus("IPs updated", true); loadUsers(); });
}

function loadVersion() {
  fetch("/version", {headers:headers}).then(function(r){return r.json();}).then(function(d){
    document.getElementById("curVersion").textContent = d.min_version || "not set";
  });
}

function setVersion() {
  var v = document.getElementById("newVersion").value.trim();
  if (!v) { showStatus("Version required (e.g. 1.1.0)", false); return; }
  fetch("/version", {method:"POST",headers:headers,body:JSON.stringify({min_version:v})})
    .then(function(r){return r.json();})
    .then(function(d){
      if (d.error) { showStatus(d.error, false); return; }
      showStatus("Min version set to "+d.min_version, true);
      document.getElementById("newVersion").value = "";
      loadVersion();
    });
}

loadVersion();
loadUsers();
loadLogs();
setInterval(loadLogs, 15000);
</script></body></html>`;

// -- Start -------------------------------------------------------------------

const ssl = ensureSelfSignedCert();

if (ssl.key && ssl.cert) {
  // HTTPS server
  const httpsServer = https.createServer({ key: ssl.key, cert: ssl.cert }, app);
  httpsServer.listen(PORT, "0.0.0.0", () => {
    console.log(`[LICENSE] HTTPS server running at https://0.0.0.0:${PORT}`);
    console.log(`[LICENSE] Rate limit: ${RATE_MAX_REQUESTS} req/min per IP, 10min block on exceed`);
    console.log(`[LICENSE] Admin: https://your-ip:${PORT}/admin?key=YOUR_KEY`);
    console.log(`[LICENSE] Note: self-signed cert -- users set LICENSE_SERVER=https://your-ip:${PORT}`);
  });
} else {
  // Fallback to HTTP if openssl not available
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`[LICENSE] HTTP server running at http://0.0.0.0:${PORT} (no SSL -- install openssl for HTTPS)`);
    console.log(`[LICENSE] Rate limit: ${RATE_MAX_REQUESTS} req/min per IP, 10min block on exceed`);
    console.log(`[LICENSE] Admin: http://your-ip:${PORT}/admin?key=YOUR_KEY`);
  });
}
