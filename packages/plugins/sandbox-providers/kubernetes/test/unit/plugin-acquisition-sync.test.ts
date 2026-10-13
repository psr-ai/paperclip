import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  clients: {},
  claim: vi.fn(async () => ({ uid: "sandbox-uid" })),
  findPod: vi.fn(async () => "sandbox-pod"),
  waitForCompletion: vi.fn(async () => undefined),
}));

vi.mock("../../src/kube-client.js", () => ({
  createKubeConfig: vi.fn(() => ({})),
  makeKubeClients: vi.fn(() => h.clients),
}));
vi.mock("../../src/tenant-orchestrator.js", () => ({ ensureTenant: vi.fn(async () => undefined) }));
vi.mock("../../src/secret-manager.js", () => ({ createPerRunSecret: vi.fn(async () => undefined) }));
vi.mock("../../src/sandbox-cr-orchestrator.js", () => ({
  SandboxCrTimeoutError: class extends Error {},
  sandboxCrOrchestrator: { claim: h.claim, findPod: h.findPod, waitForCompletion: h.waitForCompletion },
}));

import plugin from "../../src/plugin.js";

describe("acquired lease native sync", () => {
  it("confines native sync to the mounted workspace before realization metadata is merged", async () => {
    const params = {
      driverKey: "kubernetes",
      companyId: "acme",
      environmentId: "environment-1",
      runId: "run-1",
      config: {
        inCluster: true,
        backend: "sandbox-cr",
        adapters: [{ adapterType: "claude_local", runtimeImage: "example.test/agent:v1", envKeys: [], allowFqdns: [] }],
      },
    };
    const lease = await plugin.definition.onEnvironmentAcquireLease!(params);
    // Use the original lease as the adapter Test route does, without invoking
    // realizeWorkspace or hand-inserting metadata into this test fixture.
    await expect(plugin.definition.onEnvironmentSyncIn!({
      ...params, lease, operations: [],
    })).resolves.toEqual({ operations: [] });
    expect(h.waitForCompletion).toHaveBeenCalled();

    // The default makes a concrete root available; it must not bypass native
    // sync's lexical confinement for a target outside that mounted root.
    await expect(plugin.definition.onEnvironmentSyncIn!({
      ...params, lease,
      operations: [{ operationId: "escape", files: [{ kind: "file", sourcePath: "/unused-fixture",
        targetPath: "/tmp/outside-workspace" }] }],
    })).rejects.toThrow(/escapes the workspace remote dir/);
  });
});
