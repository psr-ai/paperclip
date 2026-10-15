// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatEndpointDetail } from "./ChatEndpointDetail";
import { TooltipProvider } from "@/components/ui/tooltip";

const mocks = vi.hoisted(() => ({
  get: vi.fn(), resources: vi.fn(), update: vi.fn(), agent: vi.fn(), toast: vi.fn(),
}));
vi.mock("@/api/chatEndpoints", () => ({ chatEndpointsApi: {
  get: mocks.get, listResources: mocks.resources,
  update: (endpointId: string, input: unknown) => mocks.update(endpointId, input),
} }));
vi.mock("@/api/agents", () => ({ agentsApi: { get: mocks.agent } }));
vi.mock("./SlackToolSettings", () => ({ SlackToolsSettings: () => null, SlackSearchAccess: () => null }));
vi.mock("./SlackAvatarStep", () => ({ SlackAvatarSettings: () => null }));
vi.mock("./ChatCommunicationInstructions", () => ({ ChatCommunicationInstructions: () => null }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: () => {} }) }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => ({ pushToast: mocks.toast }) }));
vi.mock("@/lib/router", () => ({
  useParams: () => ({ endpointId: "slack-endpoint", tab: "settings" }), useNavigate: () => () => {},
  Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) => <a href={to} {...props}>{children}</a>,
  Navigate: () => null,
}));

describe("Slack reply settings", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  const endpoint = {
    id: "slack-endpoint", companyId: "company", provider: "slack", status: "active",
    assignedAgentId: "chief", assignedAgentName: "Chief", allowUnlinkedPeople: false,
    allowDirectMessages: true, setup: { step: "complete" },
  };
  const selector = '[role="switch"][aria-label="Require an @mention for every message"]';
  const toggle = () => container.querySelector<HTMLButtonElement>(selector)!;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.get.mockResolvedValue(endpoint);
    mocks.resources.mockResolvedValue([]);
    mocks.agent.mockResolvedValue({ id: "chief", name: "Chief", appearance: null });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });
  async function render() {
    await act(async () => root.render(
      <QueryClientProvider client={client}><TooltipProvider><ChatEndpointDetail /></TooltipProvider></QueryClientProvider>,
    ));
    await vi.waitFor(() => expect(container.textContent).toContain("Where this agent can work"));
  }

  it("starts with subscribed behavior and saves strict mode only after the update succeeds", async () => {
    let finish!: (value: unknown) => void;
    mocks.update.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("including replies in channel threads and direct messages");
    await act(async () => toggle().click());
    await vi.waitFor(() => expect(toggle().disabled).toBe(true));
    expect(mocks.update).toHaveBeenCalledWith("slack-endpoint", { replyMode: "mention_each_reply" });
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    await act(async () => finish({ ...endpoint, replyMode: "mention_each_reply" }));
    await vi.waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
    expect(toggle().disabled).toBe(false);
  });

  it("shows the saved strict mode and can restore subscribed behavior", async () => {
    mocks.get.mockResolvedValue({ ...endpoint, replyMode: "mention_each_reply" });
    mocks.update.mockResolvedValue({ ...endpoint, replyMode: "subscribed" });
    await render();
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle().click());
    await vi.waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("false"));
    expect(mocks.update).toHaveBeenCalledWith("slack-endpoint", { replyMode: "subscribed" });
  });

  it("retains the saved mode and reports a failed update", async () => {
    mocks.update.mockRejectedValue(new Error("Settings could not be saved"));
    await render();
    await act(async () => toggle().click());
    await vi.waitFor(() => expect(mocks.toast).toHaveBeenCalledWith({
      title: "Couldn't update settings", body: "Settings could not be saved", tone: "error",
    }));
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(toggle().disabled).toBe(false);
  });

  it("does not offer Slack reply mode for other providers", async () => {
    mocks.get.mockResolvedValue({ ...endpoint, provider: "discord" });
    await render();
    expect(toggle()).toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
