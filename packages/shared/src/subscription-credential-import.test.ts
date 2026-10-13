import { describe, expect, it } from "vitest";
import { importSubscriptionCredentialSchema, aiConnectionNeedsTokenValidation } from "./ai-connections.js";

describe("native subscription import contract", () => {
  const input = { provider: "openai", credential: "{}", name: "Codex", ownership: "personal" };
  it("accepts only the supported write-only import fields and providers", () => {
    expect(importSubscriptionCredentialSchema.parse(input)).toMatchObject({ agentIds: [], allAgents: false });
    expect(importSubscriptionCredentialSchema.safeParse({ ...input, provider: "xai" }).success).toBe(true);
    for (const change of [{ provider: "anthropic" }, { method: "api_key" }, { credential: "" }, { credential: "a".repeat(131073) }, { apiKey: "secret" }])
      expect(importSubscriptionCredentialSchema.safeParse({ ...input, ...change }).success).toBe(false);
  });
  it.each(["anthropic", "openai", "xai"])("keeps %s pending imports gated to explicit validation", provider => {
    const config = { ai: { provider, method: "subscription" }, aiOAuthTokenImport: true, aiCredentialValidationPending: true };
    expect(aiConnectionNeedsTokenValidation(config)).toBe(true);
    expect(aiConnectionNeedsTokenValidation({ ...config, ai: { provider, method: "api_key" } })).toBe(false);
    expect(aiConnectionNeedsTokenValidation({ ...config, aiCredentialValidationPending: false })).toBe(false);
  });
});
