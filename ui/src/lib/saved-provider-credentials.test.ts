import { describe, expect, it } from "vitest";
import type { AiManagedConnectionSummary, CompanySecret } from "@paperclipai/shared";
import type { MyUserSecretEntry } from "../api/secrets";
import {
  savedProviderKeys,
  savedCodexSubscriptions,
  savedManagedProviderAccounts,
} from "./saved-provider-credentials";
const secret = (overrides = {}) =>
  ({
    id: "s1",
    companyId: "c1",
    key: "ANTHROPIC_API_KEY",
    name: "Claude",
    scope: "company",
    status: "active",
    ...overrides,
  }) as CompanySecret;
const personal = (key = "ANTHROPIC_API_KEY.setup.abc", overrides = {}) =>
  ({
    definition: {
      id: "d1",
      companyId: "c1",
      key,
      name: "My Claude",
      status: "active",
      ...overrides,
    },
    secret: secret({ scope: "user" }),
  }) as MyUserSecretEntry;
describe("saved provider keys", () => {
  it("keeps an imported unverified default selectable for explicit testing without accepting revoked accounts", () => {
    const account = { id: "connection", grantId: "grant", companyId: "c1", provider: "anthropic", method: "subscription",
      name: "Imported Claude", ownership: "personal", ownerUserId: "user", isDefault: true,
      status: "needs_attention", credentialValidationPending: true } as AiManagedConnectionSummary;
    const choices = savedManagedProviderAccounts("c1", "anthropic", "user", [account]);
    expect(choices).toEqual([expect.objectContaining({ credentialValidationPending: true,
      label: "Imported Claude (Your default) · Test required",
      aiConnection: { provider: "anthropic", method: "subscription", mode: "responsible_user" },
    })]);
    expect(savedManagedProviderAccounts("c1", "anthropic", "user", [{ ...account, status: "revoked" }])).toEqual([]);
    expect(savedManagedProviderAccounts("c2", "anthropic", "user", [account])).toEqual([]);
  });
  it("reuses canonical and setup keys with references, including normalized organization keys", () => {
    expect(
      savedProviderKeys(
        "c1",
        "ANTHROPIC_API_KEY",
        [personal()],
        [secret({ key: "anthropic_api_key" })],
      ),
    ).toEqual([
      {
        id: "user:d1",
        label: "My Claude (Your key)",
        binding: {
          type: "user_secret_ref",
          key: "ANTHROPIC_API_KEY.setup.abc",
          version: "latest",
        },
      },
      {
        id: "company:s1",
        label: "Claude (Organization key)",
        binding: { type: "secret_ref", secretId: "s1", version: "latest" },
      },
    ]);
  });
  it("excludes unavailable, wrong-provider, and foreign-company credentials", () => {
    expect(
      savedProviderKeys(
        "c1",
        "ANTHROPIC_API_KEY",
        [
          personal("OPENAI_API_KEY"),
          personal(undefined, { status: "disabled" }),
          { ...personal(), secret: null },
          { ...personal(), secret: secret({ status: "archived" }) },
          personal(undefined, { companyId: "c2" }),
        ],
        [
          secret({ companyId: "c2" }),
          secret({ status: "disabled" }),
          secret({ scope: "user" }),
          secret({ key: "ANTHROPIC_API_KEY_OTHER" }),
        ],
      ),
    ).toEqual([]);
  });
});

it("lists only active company Codex account connections", () => {
  const account = secret({ name: "CODEX_HOME_team" });
  expect(
    savedCodexSubscriptions("c1", [
      account,
      { ...account, status: "disabled" },
      { ...account, companyId: "c2" },
      secret(),
    ]),
  ).toEqual([
    {
      id: "company:s1",
      label: "ChatGPT account · team",
      binding: { type: "secret_ref", secretId: "s1", version: "latest" },
    },
  ]);
});
