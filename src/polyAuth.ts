import { ClobClient } from "@polymarket/clob-client";
import type { ApiKeyCreds } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";

type ResolveOpts = {
  host: string;
  chainId: number;
  sigType: number;
  wallet: Wallet;
};

let cachedCreds: ApiKeyCreds | null = null;
let _derivingPromise: Promise<ApiKeyCreds> | null = null;

function stripQuotes(value: string) {
  return value.replace(/^["']|["']$/g, "");
}

function readEnvValue(name: string): string | null {
  const raw = process.env[name];
  if (!raw) return null;
  let v = stripQuotes(raw.trim());
  if (!v) return null;
  const lowered = v.toLowerCase();
  if (lowered === "undefined" || lowered === "null") return null;
  return v;
}

export function normalizeBase64Secret(value: string) {
  let v = stripQuotes(value.trim());
  v = v.replace(/\s+/g, "");
  if (v.startsWith("s_")) v = v.slice(2);
  v = v.replace(/-/g, "+").replace(/_/g, "/");
  const pad = v.length % 4;
  if (pad) v = v + "=".repeat(4 - pad);
  if (/[^A-Za-z0-9+/=]/.test(v)) {
    throw new Error("POLY_API_SECRET contains invalid characters after normalization.");
  }
  const roundTrip = Buffer.from(v, "base64").toString("base64");
  return roundTrip;
}

export function readPolyApiCredsFromEnv(): ApiKeyCreds | null {
  const key = readEnvValue("POLY_API_KEY");
  const secretRaw = readEnvValue("POLY_API_SECRET");
  const passphrase = readEnvValue("POLY_PASSPHRASE");

  const any = Boolean(key || secretRaw || passphrase);
  if (!any) return null;
  if (!key || !secretRaw || !passphrase) {
    throw new Error(
      "Provide POLY_API_KEY, POLY_API_SECRET, and POLY_PASSPHRASE together or omit all three."
    );
  }

  return {
    key,
    secret: normalizeBase64Secret(secretRaw),
    passphrase
  };
}

function readPolyApiNonce(): number | undefined {
  const raw = readEnvValue("POLY_API_NONCE");
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error("POLY_API_NONCE must be a finite number.");
  }
  return value;
}

async function tryDerive(
  client: ClobClient,
  nonce?: number
): Promise<ApiKeyCreds | null> {
  const res = await client.deriveApiKey(nonce);
  if (!res?.key) return null;
  return {
    key: res.key,
    secret: normalizeBase64Secret(res.secret),
    passphrase: res.passphrase
  };
}

async function tryCreate(
  client: ClobClient,
  nonce?: number
): Promise<ApiKeyCreds | null> {
  const res = await client.createApiKey(nonce);
  if (!res?.key) return null;
  return {
    key: res.key,
    secret: normalizeBase64Secret(res.secret),
    passphrase: res.passphrase
  };
}

export async function resolvePolyApiCreds(opts: ResolveOpts): Promise<ApiKeyCreds> {
  if (cachedCreds) return cachedCreds;

  const envCreds = readPolyApiCredsFromEnv();
  if (envCreds) {
    cachedCreds = envCreds;
    return envCreds;
  }

  // Prevent concurrent derivation race condition
  if (_derivingPromise) return _derivingPromise;
  _derivingPromise = _resolvePolyApiCredsInner(opts);
  try {
    return await _derivingPromise;
  } finally {
    _derivingPromise = null;
  }
}

async function _resolvePolyApiCredsInner(opts: ResolveOpts): Promise<ApiKeyCreds> {
  const nonce = readPolyApiNonce();
  const client = new ClobClient(opts.host, opts.chainId, opts.wallet, undefined, opts.sigType);

  let deriveErr: unknown;
  let createErr: unknown;

  try {
    const derived = await tryDerive(client, nonce);
    if (derived) {
      cachedCreds = derived;
      return derived;
    }
  } catch (err) {
    deriveErr = err;
  }

  try {
    const created = await tryCreate(client, nonce);
    if (created) {
      cachedCreds = created;
      return created;
    }
  } catch (err) {
    createErr = err;
  }

  const nonceLabel = nonce === undefined ? "0 (default)" : String(nonce);
  const deriveMsg = deriveErr ? ` deriveApiKey: ${(deriveErr as Error).message}` : "";
  const createMsg = createErr ? ` createApiKey: ${(createErr as Error).message}` : "";
  throw new Error(
    `Failed to derive or create API key with nonce=${nonceLabel}.${deriveMsg}${createMsg} ` +
      "If nonce=0 fails, set POLY_API_NONCE to a new integer and retry, or use the proxy-wallet flow."
  );
}
