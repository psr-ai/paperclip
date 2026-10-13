import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { createDb, companies, agents, companyMemberships, companySecrets, companySecretVersions,
  connectionGrants, toolConnections, toolConnectionInstalls, activityLog } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { aiConnectionRoutes } from "../routes/ai-connections.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import { errorHandler } from "../middleware/error-handler.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: ReturnType<typeof createDb>;
let home: string;
let service: ReturnType<typeof aiConnectionService>;
let app: express.Express;
const companyId = randomUUID();
const foreignCompanyId = randomUUID();
const agentId = randomUUID();
const token = `sk-ant-oat01-${"opaque_fixture_canary".repeat(4)}`;
const url = `/api/companies/${companyId}/ai-connections/claude-oauth-token`;
const intent = { name: "Imported token", ownership: "personal" as const, agentIds: [], allAgents: false };
const binding = { provider: "anthropic", method: "subscription", mode: "responsible_user" } as const;

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-token-import-"));
  vi.stubEnv("PAPERCLIP_HOME", home);
  vi.stubEnv("PAPERCLIP_INSTANCE_ID", "token-import-fixture");
  database = await startEmbeddedPostgresTestDatabase("paperclip-token-import-db-");
  db = createDb(database.connectionString);
  service = aiConnectionService(db);
  await db.insert(companies).values([{ id: companyId, name: "Import", issuePrefix: "OAT" }, { id: foreignCompanyId, name: "Foreign", issuePrefix: "OAF" }]);
  await db.insert(agents).values({ id: agentId, companyId, name: "Claude", adapterType: "claude_local" });
  await db.insert(companyMemberships).values(["alice", "bob"].map(principalId => ({ companyId, principalId, principalType: "user", status: "active", membershipRole: "member" })));
  app = express(); app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = req.header("x-agent") ? { type: "agent", agentId, companyId, companyIds: [companyId], onBehalfOfUserId: "alice" }
      : req.header("x-anonymous") ? { type: "none" }
      : { type: "board", source: "session", userId: req.header("x-user") ?? "alice", companyIds: [companyId],
        isInstanceAdmin: req.header("x-manager") === "yes",
        memberships: [{ companyId, status: "active", membershipRole: req.header("x-viewer") ? "viewer" : "member" }] };
    next();
  });
  app.use("/api", aiConnectionRoutes(db, { deploymentMode: "authenticated", deploymentExposure: "public", trustedLocalStdioRuntimeHost: "" }));
  app.use(errorHandler);
}, 90000);
afterAll(async () => { await database?.cleanup(); vi.unstubAllEnvs(); if (home) await rm(home, { recursive: true, force: true }); });

describe("native Claude token import", () => {
  it("stores an encrypted pending personal credential without network calls and routes it only for explicit validation", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Import must not contact a provider"));
    try {
      const saved = await request(app).post(url).send({ ...intent, token });
      expect(saved.status).toBe(201);
      expect(saved.headers["cache-control"]).toBe("no-store");
      expect(saved.body).toMatchObject({ connectionId: expect.any(String), grantId: expect.any(String), validationStatus: "pending" });
      expect(Object.keys(saved.body).sort()).toEqual(["connectionId", "grantId", "validationStatus"]);
      await service.setDefault(companyId, "alice", saved.body.grantId);
      const summary = (await service.list(companyId, "alice")).find(row => row.id === saved.body.connectionId);
      expect(summary).toMatchObject({ method: "subscription", ownership: "personal", status: "needs_attention", credentialValidationPending: true, usageProbeSupported: false });
      const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, saved.body.connectionId));
      const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, saved.body.grantId));
      const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, grant.credentialSecretRefs[0]!.secretId));
      expect(secret).toMatchObject({ scope: "user", ownerUserId: "alice", provider: "local_encrypted" });
      expect(JSON.stringify({ connection, grant, secret, summary, versions: await db.select().from(companySecretVersions), activity: await db.select().from(activityLog) })).not.toContain(token);
      const runtimeInput = { companyId, agentId, responsibleUserId: "alice", adapterType: "claude_local", binding, config: {}, allowUninstalledPersonal: true };
      await expect(prepareManagedAiRuntime(db, runtimeInput)).rejects.toThrow("Reconnect or validate");
      const startedAt = new Date();
      const managed = await prepareManagedAiRuntime(db, { ...runtimeInput, allowLegacyValidation: true });
      try {
        expect(managed.config.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(token);
        expect(managed.config.env.ANTHROPIC_API_KEY).toBe("");
        await service.markTokenValidated({ companyId, runStartedAt: startedAt, attribution: { ...managed.attribution, identity: managed.identity } });
      } finally { await managed.cleanup(); }
      expect((await service.list(companyId, "alice")).find(row => row.id === saved.body.connectionId)).toMatchObject({ status: "connected" });
      expect(await service.probeUsage(companyId, "alice", saved.body.connectionId, saved.body.grantId)).toMatchObject({ status: "unsupported", errorCode: "unsupported" });
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });
  it("offers reconnect after an imported token fails authentication", async () => {
    const saved = await request(app).post(url).send({ ...intent, token });
    await service.setDefault(companyId, "alice", saved.body.grantId);
    const startedAt = new Date();
    const managed = await prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: "alice", adapterType: "claude_local", binding, config: {}, allowUninstalledPersonal: true, allowLegacyValidation: true });
    try {
      await service.markAuthenticationFailed({ companyId, runStartedAt: startedAt, attribution: { ...managed.attribution, identity: managed.identity } });
      const summary = (await service.list(companyId, "alice")).find(row => row.id === saved.body.connectionId);
      expect(summary).toMatchObject({ status: "needs_attention" });
      expect(summary?.credentialValidationPending).not.toBe(true);
      expect(summary?.unavailableReason).not.toBe("Token saved. Run an agent test to verify it.");
      const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, saved.body.grantId));
      expect(grant.status).toBe("needs_reauthorization");
      await expect(service.select({ companyId, agentId, userId: "alice", adapterType: "claude_local", binding, allowLegacyValidation: true })).rejects.toThrow("Reconnect or validate");
      const repaired = await request(app).post(url).send({ ...intent, token: `${token}-repaired`, connectionId: saved.body.connectionId });
      expect(repaired.status).toBe(201);
      expect(repaired.body).toEqual(saved.body);
      expect((await service.list(companyId, "alice")).find(row => row.id === saved.body.connectionId)).toMatchObject({ credentialValidationPending: true });
    } finally { await managed.cleanup(); }
  });
  it("enforces actor, company, viewer, shared-access, and reconnect ownership boundaries", async () => {
    const personal = await request(app).post(url).send({ ...intent, token });
    for (const header of ["x-agent", "x-anonymous", "x-viewer"])
      expect((await request(app).post(url).set(header, "yes").send({ ...intent, token })).status).toBe(403);
    expect((await request(app).post(url.replace(companyId, foreignCompanyId)).send({ ...intent, token })).status).toBe(403);
    expect((await request(app).post(url).send({ ...intent, token, ownership: "shared" })).status).toBe(403);
    expect((await request(app).post(url).send({ ...intent, token, allAgents: true })).status).toBe(403);
    expect((await request(app).post(url).set("x-user", "bob").send({ ...intent, token, connectionId: personal.body.connectionId })).status).toBe(403);
    const apiKey = await service.save(companyId, "alice", { ...intent, provider: "anthropic", method: "api_key", apiKey: "fixture" }, "fixture");
    expect((await request(app).post(url).send({ ...intent, token, connectionId: apiKey.connectionId })).status).toBe(422);
    const invalid = await request(app).post(url).send({ ...intent, token: "sk-ant-api03-not-oauth" });
    expect(invalid.status).toBe(400);
    expect(invalid.headers["cache-control"]).toBe("no-store");
  });
  it("preserves reconnect identity/installations and never promotes a replaced credential", async () => {
    const saved = await request(app).post(url).set("x-manager", "yes").send({ ...intent, token, agentIds: [agentId] });
    await service.setDefault(companyId, "alice", saved.body.grantId);
    const before = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, saved.body.connectionId));
    const startedAt = new Date();
    const managed = await prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: "alice", adapterType: "claude_local", binding, config: {}, allowLegacyValidation: true });
    try {
      const replacement = await request(app).post(url).send({ ...intent, token: `${token}-replacement`, connectionId: saved.body.connectionId, allAgents: true });
      expect(replacement.body).toEqual(saved.body);
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, saved.body.connectionId))).toEqual(before);
      await service.markTokenValidated({ companyId, runStartedAt: startedAt, attribution: { ...managed.attribution, identity: managed.identity } });
      expect((await service.list(companyId, "alice")).find(row => row.id === saved.body.connectionId)).toMatchObject({ status: "needs_attention", credentialValidationPending: true });
      await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, saved.body.grantId));
      await expect(service.select({ companyId, agentId, userId: "alice", adapterType: "claude_local", binding, allowLegacyValidation: true })).rejects.toThrow("Reconnect or validate");
    } finally { await managed.cleanup(); }
  });
});
