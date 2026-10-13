// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeOauthTokenForm } from "./ClaudeOauthTokenForm";

const api = vi.hoisted(() => ({ importClaudeOauthToken: vi.fn() }));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: api }));
const TOKEN = "sk-ant-oat01-fixture_fixture_fixture_0123456789";
const saved = { connectionId: "connection-1", grantId: "grant-1", validationStatus: "pending" };
let root: Root | undefined;
let host: HTMLDivElement;
beforeEach(() => { api.importClaudeOauthToken.mockReset().mockResolvedValue(saved); localStorage.clear(); });
afterEach(() => { flushSync(() => root?.unmount()); root = undefined; host?.remove(); });
function mount(overrides: Partial<Parameters<typeof ClaudeOauthTokenForm>[0]> = {}) {
  const props = { companyId: "company-1", intent: { provider: "anthropic" as const,
    method: "subscription" as const, name: "My Claude subscription", ownership: "personal" as const,
    agentIds: [], allAgents: true }, onSaved: vi.fn(), onCancel: vi.fn(), ...overrides };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  flushSync(() => root!.render(<ClaudeOauthTokenForm {...props} />));
  return props;
}
function typeToken() {
  const input = host.querySelector("input")!;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, TOKEN);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}
function submit() {
  flushSync(() => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
}
describe("Claude OAuth token import", () => {
  it("masks transient input, sends only on explicit submit, and clears immediately", async () => {
    const props = mount(); const input = typeToken();
    expect(input.type).toBe("password"); expect(input.autocomplete).toBe("off");
    expect(api.importClaudeOauthToken).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0); expect(host.textContent).not.toContain(TOKEN);
    submit();
    expect(input.value).toBe("");
    await vi.waitFor(() => expect(props.onSaved).toHaveBeenCalledWith(saved));
    expect(api.importClaudeOauthToken).toHaveBeenCalledExactlyOnceWith("company-1", {
      token: TOKEN, name: "My Claude subscription", ownership: "personal", agentIds: [], allAgents: true,
      connectionId: undefined,
    });
    expect(localStorage.length).toBe(0);
  });
  it("clears failed input and never echoes error details", async () => {
    api.importClaudeOauthToken.mockRejectedValueOnce(new Error(`rejected ${TOKEN}`));
    const props = mount(); typeToken(); submit();
    await vi.waitFor(() => expect(host.textContent).toContain("Could not save"));
    expect(host.querySelector("input")!.value).toBe("");
    expect(host.textContent).not.toContain(TOKEN); expect(props.onSaved).not.toHaveBeenCalled();
  });
  it("retries post-save work using IDs without importing or retaining the token again", async () => {
    const onSaved = vi.fn().mockRejectedValueOnce(new Error("default unavailable")).mockResolvedValue(undefined);
    mount({ onSaved }); typeToken(); submit();
    await vi.waitFor(() => expect(host.textContent).toContain("Retry connection"));
    expect(host.querySelector("input")).toBeNull(); submit();
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    expect(api.importClaudeOauthToken).toHaveBeenCalledOnce(); expect(host.textContent).not.toContain(TOKEN);
  });
  it("ignores completion after cancellation and drops input on remount", async () => {
    let finish!: (value: typeof saved) => void;
    api.importClaudeOauthToken.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const props = mount(); typeToken(); submit();
    flushSync(() => [...host.querySelectorAll("button")].find(button => button.textContent === "Cancel")!.click());
    finish(saved);
    await Promise.resolve(); await Promise.resolve();
    expect(props.onSaved).not.toHaveBeenCalled(); expect(props.onCancel).toHaveBeenCalledOnce();
    flushSync(() => root!.unmount()); root = undefined; host.remove(); mount();
    expect(host.querySelector("input")!.value).toBe("");
  });
  it("preserves reconnect scope and explains replacement before submission", async () => {
    mount({ intent: { provider: "anthropic", method: "subscription", name: "Team Claude", ownership: "shared",
      connectionId: "existing-connection", agentIds: ["agent-1"], allAgents: false } });
    expect(host.textContent).toContain("replaces this connection’s existing token");
    expect(api.importClaudeOauthToken).not.toHaveBeenCalled(); typeToken(); submit();
    await vi.waitFor(() => expect(api.importClaudeOauthToken).toHaveBeenCalledWith("company-1", expect.objectContaining({
      connectionId: "existing-connection", ownership: "shared", agentIds: ["agent-1"], allAgents: false,
    })));
  });
});
