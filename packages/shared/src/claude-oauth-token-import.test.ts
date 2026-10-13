import { describe, expect, it } from "vitest";
import { importClaudeOauthTokenSchema, aiConnectionNeedsTokenValidation } from "./ai-connections.js";

const token = `sk-ant-oat01-${"fixture_token".repeat(4)}`;
const input = { token, name: "My Claude account", ownership: "personal" };
describe("Claude OAuth token import", () => {
  it("accepts only the opaque setup-token shape and trims surrounding whitespace", () => {
    expect(importClaudeOauthTokenSchema.parse({ ...input, token: `\n ${token} \n` }))
      .toEqual({ ...input, agentIds: [], allAgents: false });
  });
  it.each(["", "sk-ant-oat01-short", "sk-ant-api03-example", "sk-ant-ort01-refresh", "eyJ.jwt.value",
    `Bearer ${token}`, `${token}\nfragment`, `export CLAUDE_CODE_OAUTH_TOKEN=${token}`,
    `sk-ant-oat01-${"a".repeat(32768)}`])("rejects unsupported credentials without echoing them", value => {
    const result = importClaudeOauthTokenSchema.safeParse({ ...input, token: value });
    expect(result.success).toBe(false);
    if (!result.success && value) expect(JSON.stringify(result.error.issues)).not.toContain(value);
  });
  it.each([{ provider: "openai" }, { method: "api_key" }, { apiKey: "fixture" }, { ownerUserId: "other" }])
    ("rejects caller-controlled provider, method and owner fields", fields => {
      expect(importClaudeOauthTokenSchema.safeParse({ ...input, ...fields }).success).toBe(false);
    });
  it("recognizes pending validation only for an explicitly imported Claude subscription", () => {
    const config = { ai: { provider: "anthropic", method: "subscription" }, aiOAuthTokenImport: true, aiCredentialValidationPending: true };
    expect(aiConnectionNeedsTokenValidation(config)).toBe(true);
    expect(aiConnectionNeedsTokenValidation({ ...config, ai: { provider: "anthropic", method: "api_key" } })).toBe(false);
    expect(aiConnectionNeedsTokenValidation({ ...config, aiCredentialValidationPending: false })).toBe(false);
  });
});
