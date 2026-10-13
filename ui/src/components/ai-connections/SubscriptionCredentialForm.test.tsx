// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubscriptionCredentialForm, type SubscriptionCredentialFormProps } from "./SubscriptionCredentialForm";

const api = vi.hoisted(() => ({ importClaudeOauthToken: vi.fn(), importSubscriptionCredential: vi.fn() }));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: api }));
const saved = { connectionId: "connection-1", grantId: "grant-1", validationStatus: "pending" };
const credential = JSON.stringify({ tokens: { access_token: "fixture-access", refresh_token: "fixture-refresh", id_token: "fixture-id" } });
let root: Root | undefined;
let host: HTMLDivElement;
beforeEach(() => { api.importSubscriptionCredential.mockReset().mockResolvedValue(saved); api.importClaudeOauthToken.mockReset(); localStorage.clear(); });
afterEach(() => { flushSync(() => root?.unmount()); root = undefined; host?.remove(); });
function mount(provider: "openai" | "xai" = "openai", overrides: Partial<SubscriptionCredentialFormProps> = {}) {
  const props: SubscriptionCredentialFormProps = { companyId: "company-1", provider,
    intent: { provider, method: "subscription", name: "My account", ownership: "personal", agentIds: [], allAgents: true },
    onSaved: vi.fn(), onCancel: vi.fn(), ...overrides };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  flushSync(() => root!.render(<SubscriptionCredentialForm {...props} />));
  return props;
}
function paste(value = credential) {
  const input = host.querySelector<HTMLInputElement>('input[type="password"]')!;
  flushSync(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}
function submit() { flushSync(() => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }
function cancel() { flushSync(() => [...host.querySelectorAll("button")].find(button => button.textContent === "Cancel")!.click()); }
function choose(file: { size: number; text: () => Promise<string> }) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  flushSync(() => input.dispatchEvent(new Event("change", { bubbles: true })));
}
describe("subscription auth.json import", () => {
  it.each(["openai", "xai"] as const)("sends %s only on explicit submit and clears private input", async provider => {
    const props = mount(provider); const input = paste();
    expect(input.type).toBe("password"); expect(input.autocomplete).toBe("off");
    expect(api.importSubscriptionCredential).not.toHaveBeenCalled();
    expect(host.textContent).not.toContain("fixture-refresh"); expect(localStorage.length).toBe(0);
    submit(); expect(input.value).toBe("");
    await vi.waitFor(() => expect(props.onSaved).toHaveBeenCalledWith(saved));
    expect(api.importSubscriptionCredential).toHaveBeenCalledExactlyOnceWith("company-1", {
      provider, credential, name: "My account", ownership: "personal", connectionId: undefined, agentIds: [], allAgents: true,
    });
    expect(api.importClaudeOauthToken).not.toHaveBeenCalled(); expect(localStorage.length).toBe(0);
  });
  it("reads a credential file without submitting or displaying its contents", async () => {
    const props = mount("xai"); choose({ size: credential.length, text: async () => credential });
    await vi.waitFor(() => expect(host.textContent).toContain("Credential file loaded"));
    expect(host.textContent).not.toContain("fixture-refresh");
    expect(api.importSubscriptionCredential).not.toHaveBeenCalled(); submit();
    await vi.waitFor(() => expect(props.onSaved).toHaveBeenCalledWith(saved));
    expect(api.importSubscriptionCredential).toHaveBeenCalledWith("company-1", expect.objectContaining({ provider: "xai", credential }));
  });
  it("rejects an oversized file before reading it", () => {
    mount(); const text = vi.fn(); choose({ size: 131073, text });
    expect(text).not.toHaveBeenCalled(); expect(host.textContent).toContain("128 KiB");
    expect(api.importSubscriptionCredential).not.toHaveBeenCalled();
  });
  it("recovers when an oversized selection replaces a pending file read", async () => {
    let finish!: (value: string) => void;
    mount(); choose({ size: 10, text: () => new Promise(resolve => { finish = resolve; }) });
    expect(host.textContent).toContain("Reading credential file");
    choose({ size: 131073, text: vi.fn() });
    expect(host.textContent).not.toContain("Reading credential file");
    finish(credential); await Promise.resolve(); await Promise.resolve();
    expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
    paste(); expect(host.querySelector<HTMLButtonElement>('button[type="submit"]')!.disabled).toBe(false);
  });
  it.each(["not-json", "[]", "null"])("rejects malformed input without persisting or echoing it (%s)", async value => {
    mount(); const input = paste(value); submit();
    await vi.waitFor(() => expect(host.textContent).toContain("Could not save"));
    expect(input.value).toBe(""); expect(api.importSubscriptionCredential).not.toHaveBeenCalled();
  });
  it("clears failure input and suppresses credential-bearing transport errors", async () => {
    api.importSubscriptionCredential.mockRejectedValueOnce(new Error(credential));
    const props = mount(); const input = paste(); submit();
    await vi.waitFor(() => expect(host.textContent).toContain("Could not save"));
    expect(input.value).toBe(""); expect(host.textContent).not.toContain("fixture-refresh"); expect(props.onSaved).not.toHaveBeenCalled();
  });
  it("preserves reconnect scope and retries post-save work using IDs only", async () => {
    const onSaved = vi.fn().mockRejectedValueOnce(new Error("failed selection")).mockResolvedValue(undefined);
    mount("xai", { onSaved, intent: { provider: "xai", method: "subscription", name: "Team Grok", ownership: "shared", connectionId: "existing", agentIds: ["agent"], allAgents: false } });
    expect(host.textContent).toContain("replaces this connection’s existing sign-in"); paste(); submit();
    await vi.waitFor(() => expect(host.textContent).toContain("Retry connection"));
    expect(host.querySelector("input")).toBeNull(); submit();
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledTimes(2));
    expect(api.importSubscriptionCredential).toHaveBeenCalledExactlyOnceWith("company-1", expect.objectContaining({ provider: "xai", connectionId: "existing", ownership: "shared", agentIds: ["agent"], allAgents: false }));
  });
  it("ignores file completion after cancellation or provider change", async () => {
    let finish!: (value: string) => void;
    const props = mount(); choose({ size: 10, text: () => new Promise(resolve => { finish = resolve; }) });
    cancel(); finish(credential); await Promise.resolve(); await Promise.resolve();
    expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
    expect(props.onCancel).toHaveBeenCalledOnce(); expect(api.importSubscriptionCredential).not.toHaveBeenCalled();
    paste();
    flushSync(() => root!.render(<SubscriptionCredentialForm {...props} provider="xai" intent={{ ...props.intent, provider: "xai" }} />));
    expect(host.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("");
  });
  it("ignores an import response after cancel and clears the input on unmount", async () => {
    let finish!: (value: typeof saved) => void;
    api.importSubscriptionCredential.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const props = mount(); const input = paste(); submit(); cancel(); finish(saved);
    await Promise.resolve(); await Promise.resolve(); expect(props.onSaved).not.toHaveBeenCalled();
    paste(); flushSync(() => root!.unmount()); root = undefined;
    expect(input.value).toBe("");
  });
});
