import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
let app: express.Express;
let service: ReturnType<typeof aiConnectionService>;
const companyId = randomUUID(), foreignCompanyId = randomUUID(), agentId = randomUUID();
const endpoint = `/api/companies/${companyId}/ai-connections/subscription-credential`;
const intent = { name: "Imported subscription", ownership: "personal" as const, agentIds: [], allAgents: false };
const grokIdentity = "https://auth.x.ai::00000000-0000-4000-8000-000000000001";
const fixtureTime = Date.now();
function fixture(provider: "openai" | "xai", generation = 0) {
  const access = `private-subscription-access-${provider}-${generation}`;
  const refresh = `private-subscription-refresh-${provider}-${generation}`;
  return provider === "openai" ? { auth_mode: "chatgpt", tokens: {
    access_token: access, refresh_token: refresh,
    id_token: `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: "fixture-user", email: "fixture@example.invalid" })).toString("base64url")}.fixture`,
    account_id: "fixture-account" }, last_refresh: new Date(fixtureTime - 60000 + generation * 1000).toISOString() }
    : { [grokIdentity]: { key: access, refresh_token: refresh, expires_at: new Date(fixtureTime + 3600000 + generation * 1000).toISOString(),
      auth_mode: "oidc", create_time: new Date(fixtureTime - 60000).toISOString(), user_id: "fixture-user",
      oidc_issuer: "https://auth.x.ai", oidc_client_id: "00000000-0000-4000-8000-000000000001" } };
}

beforeAll(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "paperclip-subscription-import-"));
  vi.stubEnv("PAPERCLIP_HOME", home); vi.stubEnv("PAPERCLIP_INSTANCE_ID", "subscription-import-fixture");
  database = await startEmbeddedPostgresTestDatabase("paperclip-subscription-import-db-");
  db = createDb(database.connectionString); service = aiConnectionService(db);
  await db.insert(companies).values([{ id: companyId, name: "Import", issuePrefix: "SUB" }, { id: foreignCompanyId, name: "Foreign", issuePrefix: "SBF" }]);
  await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", adapterType: "codex_local" });
  await db.insert(companyMemberships).values(["alice", "bob"].map(principalId => ({ companyId, principalId, principalType: "user", status: "active", membershipRole: "member" })));
  app = express(); app.use(express.json({ limit: "256kb" }));
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

describe.each(["openai", "xai"] as const)("native %s subscription import", provider => {
  const adapterType = provider === "openai" ? "codex_local" : "grok_local";
  const binding = { provider, method: "subscription", mode: "responsible_user" } as const;
  const runtime = () => ({ companyId, agentId, responsibleUserId: "alice", adapterType, binding, config: {}, allowUninstalledPersonal: true });
  const save = (credential = fixture(provider)) => request(app).post(endpoint).send({ ...intent, provider, credential: JSON.stringify(credential) });

  it("encrypts pending credentials without provider access, blocks ordinary runs, and preserves tested refreshes", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Import must not contact provider"));
    try {
      const saved = await save();
      expect(saved.status).toBe(201); expect(saved.headers["cache-control"]).toBe("no-store");
      expect(Object.keys(saved.body).sort()).toEqual(["connectionId", "grantId", "validationStatus"]);
      expect(saved.body.validationStatus).toBe("pending");
      await service.setDefault(companyId, "alice", saved.body.grantId);
      expect((await service.list(companyId, "alice")).find(row => row.id === saved.body.connectionId))
        .toMatchObject({ status: "needs_attention", credentialValidationPending: true, usageProbeSupported: true });
      const [connection] = await db.select().from(toolConnections).where(eq(toolConnections.id, saved.body.connectionId));
      const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, saved.body.grantId));
      const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, grant.credentialSecretRefs[0]!.secretId));
      expect(secret).toMatchObject({ scope: "user", ownerUserId: "alice", provider: "local_encrypted" });
      expect(grant.providerTenant).toEqual({}); // Unverified JWT claims are not an account label.
      expect(JSON.stringify({ connection, grant, secret, versions: await db.select().from(companySecretVersions), activity: await db.select().from(activityLog) }))
        .not.toContain("private-subscription-");
      await expect(prepareManagedAiRuntime(db, runtime())).rejects.toThrow("Reconnect or validate");
      const startedAt = new Date();
      const managed = await prepareManagedAiRuntime(db, { ...runtime(), allowLegacyValidation: true });
      const providerHome = String(managed.config.env[provider === "openai" ? "CODEX_HOME" : "GROK_HOME"]);
      expect(JSON.parse(await readFile(path.join(providerHome, "auth.json"), "utf8"))).toMatchObject(fixture(provider, 0));
      const refreshed = fixture(provider, 1);
      await writeFile(path.join(providerHome, "auth.json"), JSON.stringify(refreshed));
      // The tested generation is still authoritative in the vault until cleanup.
      await service.markTokenValidated({ companyId, runStartedAt: startedAt, attribution: { ...managed.attribution, identity: managed.identity } });
      await managed.cleanup();
      expect((await service.list(companyId, "alice")).find(row => row.id === saved.body.connectionId)).toMatchObject({ status: "connected" });
      const next = await prepareManagedAiRuntime(db, runtime());
      try {
        const nextHome = String(next.config.env[provider === "openai" ? "CODEX_HOME" : "GROK_HOME"]);
        expect(JSON.parse(await readFile(path.join(nextHome, "auth.json"), "utf8"))).toEqual(refreshed);
      } finally { await next.cleanup(); }
      expect(network).not.toHaveBeenCalled();
    } finally { network.mockRestore(); }
  });

  it("enforces actor, company, ownership and format boundaries without echoing credentials", async () => {
    const body = { ...intent, provider, credential: JSON.stringify(fixture(provider)) };
    const personal = await request(app).post(endpoint).send(body);
    for (const header of ["x-agent", "x-anonymous", "x-viewer"])
      expect((await request(app).post(endpoint).set(header, "yes").send(body)).status).toBe(403);
    expect((await request(app).post(endpoint.replace(companyId, foreignCompanyId)).send(body)).status).toBe(403);
    expect((await request(app).post(endpoint).send({ ...body, ownership: "shared" })).status).toBe(403);
    expect((await request(app).post(endpoint).set("x-user", "bob").send({ ...body, connectionId: personal.body.connectionId })).status).toBe(403);
    for (const credential of ["private-invalid-canary", JSON.stringify({ OPENAI_API_KEY: "private-invalid-canary" })]) {
      const rejected = await request(app).post(endpoint).send({ ...body, credential });
      expect(rejected.status).toBe(422); expect(rejected.headers["cache-control"]).toBe("no-store");
      expect(JSON.stringify(rejected.body)).not.toContain("private-invalid-canary");
    }
  });

  it("preserves reconnect identity/access and cannot validate a replaced or revoked generation", async () => {
    const saved = await request(app).post(endpoint).set("x-manager", "yes").send({ ...intent, provider, credential: JSON.stringify(fixture(provider)), agentIds: [agentId] });
    await service.setDefault(companyId, "alice", saved.body.grantId);
    const before = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, saved.body.connectionId));
    const startedAt = new Date();
    const managed = await prepareManagedAiRuntime(db, { ...runtime(), allowLegacyValidation: true });
    try {
      const replaced = await request(app).post(endpoint).send({ ...intent, provider, credential: JSON.stringify(fixture(provider, 2)), connectionId: saved.body.connectionId, allAgents: true });
      expect(replaced.body).toEqual(saved.body);
      expect(await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, saved.body.connectionId))).toEqual(before);
      await service.markTokenValidated({ companyId, runStartedAt: startedAt, attribution: { ...managed.attribution, identity: managed.identity } });
      expect((await service.list(companyId, "alice")).find(row => row.id === saved.body.connectionId)).toMatchObject({ credentialValidationPending: true });
      // The old runtime may refresh after reconnect and advertise a newer
      // provider timestamp. Its secret epoch must still prevent writeback.
      const oldHome = String(managed.config.env[provider === "openai" ? "CODEX_HOME" : "GROK_HOME"]);
      await writeFile(path.join(oldHome, "auth.json"), JSON.stringify(fixture(provider, 9)));
      await managed.cleanup();
      const current = await prepareManagedAiRuntime(db, { ...runtime(), allowLegacyValidation: true });
      try {
        const currentHome = String(current.config.env[provider === "openai" ? "CODEX_HOME" : "GROK_HOME"]);
        expect(JSON.parse(await readFile(path.join(currentHome, "auth.json"), "utf8"))).toEqual(fixture(provider, 2));
      } finally { await current.cleanup(); }
      await db.update(connectionGrants).set({ status: "revoked" }).where(eq(connectionGrants.id, saved.body.grantId));
      await expect(prepareManagedAiRuntime(db, { ...runtime(), allowLegacyValidation: true })).rejects.toThrow("Reconnect or validate");
    } finally { await managed.cleanup().catch(() => {}); }
  });
});
