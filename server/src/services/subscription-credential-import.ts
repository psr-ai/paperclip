import { unprocessable } from "../errors.js";

const MAX_CREDENTIAL_BYTES = 131072;
const MAX_TOKEN_LENGTH = 32768;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const GROK_IDENTITY = /^(https:\/\/auth\.x\.ai)::[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const GROK_OPTIONAL_STRINGS = ["email", "first_name", "last_name", "profile_image_asset_id", "principal_type",
  "principal_id", "team_id", "team_name", "team_role", "organization_id", "organization_name", "organization_role", "user_blocked_reason"];

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function token(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TOKEN_LENGTH && !/\s/.test(value);
}

function timestamp(value: unknown): boolean {
  return typeof value === "string" && ISO_DATE.test(value) && Number.isFinite(Date.parse(value));
}

/** Format validation only. Never fetch a submitted issuer or infer provider validity. */
export function normalizeSubscriptionCredential(provider: "openai" | "xai", raw: string): string {
  const reject = (): never => {
    throw unprocessable(provider === "openai"
      ? "Import the complete Codex auth.json from a separate ChatGPT sign-in, including its refresh token and last_refresh."
      : "Import the complete Grok auth.json from a separate Grok sign-in, including its refresh token and expires_at.");
  };
  if (Buffer.byteLength(raw, "utf8") > MAX_CREDENTIAL_BYTES) return reject();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return reject(); }
  if (!object(value)) return reject();
  if (provider === "openai") {
    const tokens = value.tokens;
    if (!object(tokens) || !token(tokens.access_token) || !token(tokens.refresh_token) || !token(tokens.id_token)
      || !token(tokens.account_id) || tokens.account_id.length > 512 || !timestamp(value.last_refresh)
      || (value.auth_mode !== undefined && value.auth_mode !== "chatgpt")
      || (value.OPENAI_API_KEY !== undefined && value.OPENAI_API_KEY !== null && value.OPENAI_API_KEY !== "")) return reject();
    // A native ID token is a JWT. It is not verified here: only a successful
    // explicit runtime test can authorize this imported credential generation.
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(tokens.id_token)) return reject();
    return JSON.stringify({ auth_mode: "chatgpt", tokens: {
      access_token: tokens.access_token, refresh_token: tokens.refresh_token,
      id_token: tokens.id_token, account_id: tokens.account_id,
    }, last_refresh: value.last_refresh });
  }
  const entries = Object.entries(value);
  if (entries.length !== 1) return reject();
  const [identity, credential] = entries[0]!;
  if (!GROK_IDENTITY.test(identity) || !object(credential) || !token(credential.key) || !token(credential.refresh_token)
    || credential.auth_mode !== "oidc" || !timestamp(credential.create_time) || !token(credential.user_id)
    || credential.user_id.length > 512 || credential.oidc_issuer !== "https://auth.x.ai"
    || credential.oidc_client_id !== identity.slice(identity.lastIndexOf("::") + 2)) return reject();
  const expiry = credential.expires_at;
  const expiryMs = timestamp(expiry) ? Date.parse(expiry as string) : NaN;
  // Existing copyback needs a readable native expiry on both sides and rejects
  // implausibly future values. Keep the representation the CLI generated.
  if (!Number.isFinite(expiryMs) || expiryMs <= 0 || expiryMs > Date.now() + 400 * 86400000) return reject();
  const normalized: Record<string, unknown> = {
    key: credential.key, refresh_token: credential.refresh_token, expires_at: expiry,
    auth_mode: "oidc", create_time: credential.create_time, user_id: credential.user_id,
    oidc_issuer: credential.oidc_issuer, oidc_client_id: credential.oidc_client_id,
  };
  for (const name of GROK_OPTIONAL_STRINGS) {
    if (credential[name] === undefined) continue;
    if (credential[name] !== null && (typeof credential[name] !== "string" || (credential[name] as string).length > 4096)) return reject();
    normalized[name] = credential[name];
  }
  for (const name of ["coding_data_retention_opt_out", "can_administer_team", "has_grok_code_access"]) {
    if (credential[name] === undefined) continue;
    if (typeof credential[name] !== "boolean" && !(name !== "coding_data_retention_opt_out" && credential[name] === null)) return reject();
    normalized[name] = credential[name];
  }
  if (credential.team_blocked_reasons !== undefined) {
    const reasons = credential.team_blocked_reasons;
    if (!Array.isArray(reasons) || reasons.length > 100 || reasons.some(reason => typeof reason !== "string" || reason.length > 4096)) return reject();
    normalized.team_blocked_reasons = reasons;
  }
  return JSON.stringify({ [identity]: normalized });
}
