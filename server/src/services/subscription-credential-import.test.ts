import { describe, expect, it } from "vitest";
import { normalizeSubscriptionCredential } from "./subscription-credential-import.js";

describe("native subscription credential normalization", () => {
  const codex = { auth_mode: "chatgpt", OPENAI_API_KEY: null,
    tokens: { access_token: "private-access", refresh_token: "private-refresh", id_token: "eyJhbGciOiJub25lIn0.eyJzdWIiOiJmaXh0dXJlIn0.fixture", account_id: "account" },
    last_refresh: "2026-10-13T12:00:00Z" };
  const identity = "https://auth.x.ai::00000000-0000-4000-8000-000000000001";
  const grok = { [identity]: { key: "private-access", refresh_token: "private-refresh", expires_at: new Date(Date.now() + 3600000).toISOString(),
    auth_mode: "oidc", create_time: "2026-10-13T12:00:00Z", user_id: "fixture-user", email: null,
    oidc_issuer: "https://auth.x.ai", oidc_client_id: "00000000-0000-4000-8000-000000000001", coding_data_retention_opt_out: true } };
  it("retains refresh and identity data while dropping non-credential configuration", () => {
    const value = JSON.parse(normalizeSubscriptionCredential("openai", JSON.stringify({ ...codex, arbitrary_url: "https://attacker.invalid" })));
    expect(value).toEqual({ auth_mode: "chatgpt", tokens: codex.tokens, last_refresh: codex.last_refresh });
    expect(JSON.parse(normalizeSubscriptionCredential("xai", JSON.stringify(grok)))).toEqual(grok);
  });
  it.each(["openai", "xai"] as const)("rejects malformed, oversized, or bare tokens for %s without echoing them", provider => {
    for (const raw of ["private-canary", JSON.stringify("private-canary"), "[]", "null", "{}", "x".repeat(131073), JSON.stringify({ x: "é".repeat(70000) })]) {
      try { normalizeSubscriptionCredential(provider, raw); throw new Error("accepted-invalid"); }
      catch (error) { expect(String(error)).not.toContain("private-canary"); expect(String(error)).not.toContain("accepted-invalid"); }
    }
  });
  it("rejects API-key Codex homes, missing refresh/freshness fields and non-JWT identity", () => {
    for (const change of [{ OPENAI_API_KEY: "sk-secret" }, { auth_mode: "apikey" }, { last_refresh: null }, { last_refresh: "tomorrow" },
      { tokens: { ...codex.tokens, refresh_token: "" } }, { tokens: { ...codex.tokens, id_token: "sk-secret" } }, { tokens: { ...codex.tokens, account_id: "" } }])
      expect(() => normalizeSubscriptionCredential("openai", JSON.stringify({ ...codex, ...change }))).toThrow("complete Codex auth.json");
  });
  it("rejects custom Grok issuers, ambiguous identities and unusable expiry", () => {
    for (const value of [{ [identity.replace("auth.x.ai", "attacker.invalid")]: grok[identity] }, { ...grok, other: {} },
      { [identity]: { ...grok[identity], refresh_token: "" } }, { [identity]: { ...grok[identity], expires_at: null } },
      { [identity]: { ...grok[identity], expires_at: new Date(Date.now() + 401 * 86400000).toISOString() } },
      { [identity]: { ...grok[identity], oidc_client_id: "wrong-client" } }, { [identity]: { ...grok[identity], auth_mode: "api_key" } },
      { [identity]: { ...grok[identity], user_id: null } }, { [identity]: { ...grok[identity], oidc_issuer: "https://attacker.invalid" } }])
      expect(() => normalizeSubscriptionCredential("xai", JSON.stringify(value))).toThrow("complete Grok auth.json");
  });
});
