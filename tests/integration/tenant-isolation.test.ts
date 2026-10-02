import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { integrationEnabled, PLATFORM_KEY, startTestPlatform } from "./harness.js";

type Platform = Awaited<ReturnType<typeof startTestPlatform>>;

describe.skipIf(!integrationEnabled)("multi-tenant SaaS platform (PostgreSQL RLS + Redis)", () => {
  let p: Platform;
  const tenants: Record<string, { id: string; token: string }> = {};

  const platformCall = (method: "GET" | "POST" | "PATCH" | "PUT", url: string, payload?: object) =>
    p.app.inject({ method, url, payload, headers: { "x-platform-api-key": PLATFORM_KEY } });

  const as = (tenant: string, token = tenants[tenant]!.token) => ({
    get: (url: string) => p.app.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } }),
    send: (
      method: "POST" | "PUT" | "PATCH",
      url: string,
      payload: object,
      headers: Record<string, string> = {},
    ) => p.app.inject({ method, url, payload, headers: { authorization: `Bearer ${token}`, ...headers } }),
  });

  const login = async (tenant: string, email: string, password: string) =>
    p.app.inject({ method: "POST", url: "/auth/login", payload: { tenant, email, password } });

  const provision = async (slug: string, plan: string, placement = "pooled") => {
    const res = await platformCall("POST", "/platform/tenants", {
      slug,
      name: slug.toUpperCase(),
      plan,
      region: "eu-west",
      placement,
      admin: { email: "admin@example.com", displayName: "Admin", password: "admin-password-123" },
    });
    expect(res.statusCode).toBe(201);
    const token = (await login(slug, "admin@example.com", "admin-password-123")).json().accessToken;
    tenants[slug] = { id: res.json().tenantId, token };
  };

  beforeAll(async () => {
    p = await startTestPlatform();
    await provision("acme", "professional");
    await provision("globex", "starter");
    await provision("initech", "enterprise", "dedicated-eu-1");
  });
  afterAll(async () => p?.stop());

  describe("platform operator API", () => {
    it("requires the operator credential", async () => {
      expect((await p.app.inject({ method: "GET", url: "/platform/tenants" })).statusCode).toBe(401);
      expect((await platformCall("GET", "/platform/tenants")).json()).toHaveLength(3);
    });

    it("rejects duplicate slugs and unknown plans", async () => {
      const base = {
        name: "X",
        region: "eu-west",
        admin: { email: "a@b.co", displayName: "A", password: "long-enough-pass" },
      };
      expect(
        (await platformCall("POST", "/platform/tenants", { ...base, slug: "acme", plan: "starter" }))
          .statusCode,
      ).toBe(409);
      expect(
        (await platformCall("POST", "/platform/tenants", { ...base, slug: "newco", plan: "gold" }))
          .statusCode,
      ).toBe(400);
    });
  });

  describe("tenant-aware authentication", () => {
    it("the same email is a different identity in each tenant", async () => {
      const me = (await as("acme").get("/me")).json();
      expect(me.tenant.slug).toBe("acme");
      expect(me.permissions).toContain("users:write");
      expect((await as("globex").get("/me")).json().tenant.slug).toBe("globex");
    });

    it("rejects bad credentials and unknown tenants with the same response", async () => {
      expect((await login("acme", "admin@example.com", "wrong-password")).statusCode).toBe(401);
      expect((await login("no-such-tenant", "admin@example.com", "admin-password-123")).statusCode).toBe(401);
      expect((await p.app.inject({ method: "GET", url: "/me" })).statusCode).toBe(401);
      expect((await as("acme", "not-a-jwt").get("/me")).statusCode).toBe(401);
    });
  });

  describe("tenant isolation", () => {
    let acmeAssetId: string;

    beforeAll(async () => {
      const res = await as("acme").send("POST", "/assets", {
        tag: "PUMP-101",
        name: "Feed pump",
        location: "Plant 1",
      });
      expect(res.statusCode).toBe(201);
      acmeAssetId = res.json().id;
      await as("globex").send("POST", "/assets", { tag: "PUMP-101", name: "Globex pump" }); // same tag, other tenant
    });

    it("lists only the caller's assets even though the SQL has no tenant filter", async () => {
      const acme = (await as("acme").get("/assets")).json().items;
      const globex = (await as("globex").get("/assets")).json().items;
      expect(acme.map((a: { name: string }) => a.name)).toEqual(["Feed pump"]);
      expect(globex.map((a: { name: string }) => a.name)).toEqual(["Globex pump"]);
    });

    it("another tenant's resource id behaves as not found", async () => {
      expect((await as("acme").get(`/assets/${acmeAssetId}`)).statusCode).toBe(200);
      expect((await as("globex").get(`/assets/${acmeAssetId}`)).statusCode).toBe(404);
    });

    it("RLS: the app role sees nothing without a tenant context and cannot write across tenants", async () => {
      const c = await p.appRole.connect();
      try {
        expect((await c.query("SELECT count(*)::int AS n FROM assets")).rows[0].n).toBe(0);
        await c.query("BEGIN");
        await c.query("SELECT set_config('app.tenant_id', $1, true)", [tenants.globex!.id]);
        expect((await c.query("SELECT count(*)::int AS n FROM assets")).rows[0].n).toBe(1);
        await expect(
          c.query(
            "INSERT INTO assets (id, tenant_id, tag, name, created_by) VALUES (gen_random_uuid(), $1, 'X-1', 'x', gen_random_uuid())",
            [tenants.acme!.id],
          ),
        ).rejects.toThrow(/row-level security/);
        await c.query("ROLLBACK");
      } finally {
        c.release();
      }
    });

    it("the audit log is append-only for the application role", async () => {
      const c = await p.appRole.connect();
      try {
        await expect(c.query("UPDATE audit_events SET action = 'tampered'")).rejects.toThrow(
          /permission denied/,
        );
        await expect(c.query("DELETE FROM audit_events")).rejects.toThrow(/permission denied/);
      } finally {
        c.release();
      }
    });

    it("a tenant placed on a dedicated cluster stores its data there", async () => {
      const res = await as("initech").send("POST", "/assets", { tag: "COMP-7", name: "Compressor" });
      expect(res.statusCode).toBe(201);
      const inDedicated = await p.inspect.dedicated.query(
        "SELECT count(*)::int AS n FROM assets WHERE tag = 'COMP-7'",
      );
      const inPooled = await p.inspect.pooled.query(
        "SELECT count(*)::int AS n FROM assets WHERE tag = 'COMP-7'",
      );
      expect(inDedicated.rows[0].n).toBe(1);
      expect(inPooled.rows[0].n).toBe(0);
    });
  });

  describe("RBAC", () => {
    let viewerToken: string;
    let viewerId: string;

    beforeAll(async () => {
      const res = await as("acme").send("POST", "/users", {
        email: "viewer@example.com",
        displayName: "Viewer",
        password: "viewer-password-1",
        roles: ["viewer"],
      });
      expect(res.statusCode).toBe(201);
      viewerId = res.json().id;
      viewerToken = (await login("acme", "viewer@example.com", "viewer-password-1")).json().accessToken;
    });

    it("enforces permissions per route", async () => {
      expect((await as("acme", viewerToken).get("/assets")).statusCode).toBe(200);
      const denied = await as("acme", viewerToken).send("POST", "/assets", { tag: "FAN-1", name: "Fan" });
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error).toBe("PERMISSION_DENIED");
      expect((await as("acme", viewerToken).get("/users")).statusCode).toBe(403);
    });

    it("role changes apply immediately, without waiting for token expiry", async () => {
      expect(
        (await as("acme").send("PUT", `/users/${viewerId}/roles`, { roles: ["asset-manager"] })).statusCode,
      ).toBe(200);
      expect(
        (await as("acme", viewerToken).send("POST", "/assets", { tag: "FAN-1", name: "Fan" })).statusCode,
      ).toBe(201);
    });

    it("disabled users lose access immediately", async () => {
      expect((await as("acme").send("PATCH", `/users/${viewerId}`, { status: "DISABLED" })).statusCode).toBe(
        200,
      );
      expect((await as("acme", viewerToken).get("/assets")).statusCode).toBe(401);
    });

    it("prevents a tenant from removing its last administrator", async () => {
      const me = (await as("acme").get("/me")).json();
      const res = await as("acme").send("PUT", `/users/${me.userId}/roles`, { roles: ["viewer"] });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("LAST_ADMIN");
    });

    it("custom roles may only use catalogue permissions and reserved names are refused", async () => {
      expect(
        (
          await as("acme").send("POST", "/roles", {
            name: "planner",
            permissions: ["assets:read", "assets:write"],
          })
        ).statusCode,
      ).toBe(201);
      expect(
        (await as("acme").send("POST", "/roles", { name: "hacker", permissions: ["platform:admin"] }))
          .statusCode,
      ).toBe(400);
      expect(
        (await as("acme").send("POST", "/roles", { name: "viewer", permissions: ["assets:read"] }))
          .statusCode,
      ).toBe(400);
    });
  });

  describe("plans, entitlements and limits", () => {
    it("starter plan: custom roles and audit log are not entitled", async () => {
      const role = await as("globex").send("POST", "/roles", {
        name: "planner",
        permissions: ["assets:read"],
      });
      expect(role.statusCode).toBe(403);
      expect(role.json().error).toBe("FEATURE_NOT_ENTITLED");
      expect((await as("globex").get("/audit-events")).statusCode).toBe(403);
    });

    it("a per-tenant override enables a feature without changing the plan", async () => {
      expect(
        (
          await platformCall("PUT", `/platform/tenants/${tenants.globex!.id}/features/audit-log`, {
            enabled: true,
          })
        ).statusCode,
      ).toBe(200);
      expect((await as("globex").get("/audit-events")).statusCode).toBe(200);
    });

    it("starter plan: max 5 active users", async () => {
      for (let i = 1; i <= 4; i++) {
        const r = await as("globex").send("POST", "/users", {
          email: `user${i}@globex.example`,
          displayName: `User ${i}`,
          password: "user-password-123",
          roles: ["viewer"],
        });
        expect(r.statusCode).toBe(201);
      }
      const sixth = await as("globex").send("POST", "/users", {
        email: "user6@globex.example",
        displayName: "User 6",
        password: "user-password-123",
        roles: ["viewer"],
      });
      expect(sixth.statusCode).toBe(402);
      expect(sixth.json().error).toBe("PLAN_LIMIT_REACHED");
    });

    it("rate limits per tenant according to the plan, without affecting other tenants", async () => {
      await platformCall("PUT", `/platform/tenants/${tenants.globex!.id}/features/api-rate-limit`, {
        enabled: true,
        limit: 3,
      });
      await p.redis.flushdb();
      const statuses = [];
      for (let i = 0; i < 5; i++) statuses.push((await as("globex").get("/me")).statusCode);
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
      const limited = await as("globex").get("/me");
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      expect((await as("acme").get("/me")).statusCode).toBe(200);
      await platformCall("PUT", `/platform/tenants/${tenants.globex!.id}/features/api-rate-limit`, {
        enabled: true,
        limit: 1000,
      });
    });
  });

  describe("audit, settings, notifications, suspension", () => {
    it("records audit events with the request correlation id", async () => {
      await as("acme").send(
        "POST",
        "/assets",
        { tag: "VALVE-9", name: "Valve" },
        { "x-correlation-id": "corr-audit-1" },
      );
      const items = (await as("acme").get("/audit-events?action=asset.created")).json().items;
      expect(items[0]).toMatchObject({
        action: "asset.created",
        correlationId: "corr-audit-1",
        resourceType: "asset",
      });
      const actions = (await as("acme").get("/audit-events?limit=200"))
        .json()
        .items.map((e: { action: string }) => e.action);
      expect(actions).toEqual(
        expect.arrayContaining(["tenant.provisioned", "auth.login", "user.created", "user.roles_changed"]),
      );
    });

    it("validates tenant settings strictly", async () => {
      expect(
        (await as("acme").send("PATCH", "/tenant/settings", { timezone: "Europe/Berlin", locale: "de-DE" }))
          .statusCode,
      ).toBe(200);
      expect((await as("acme").send("PATCH", "/tenant/settings", { unknownKey: true })).statusCode).toBe(400);
      expect((await as("acme").get("/tenant/settings")).json()).toEqual({
        timezone: "Europe/Berlin",
        locale: "de-DE",
      });
    });

    it("dispatches outbox events to notifications per tenant", async () => {
      expect(await p.dispatcher.runOnce()).toBeGreaterThan(0);
      expect(await p.dispatcher.runOnce()).toBe(0);
      const pooled = await p.inspect.pooled.query(
        "SELECT template, recipient FROM notifications ORDER BY created_at",
      );
      expect(pooled.rows.map((r) => r.template)).toEqual(
        expect.arrayContaining(["tenant-welcome", "user-invitation"]),
      );
      const dedicated = await p.inspect.dedicated.query("SELECT template FROM notifications");
      expect(dedicated.rows.map((r) => r.template)).toEqual(["tenant-welcome"]);
    });

    it("reports usage metered in Redis", async () => {
      const usage = (await as("acme").get("/tenant/usage")).json();
      expect(usage.daily).toHaveLength(7);
      expect(usage.daily[0].requests).toBeGreaterThan(0);
    });

    it("a suspended tenant is blocked immediately and cannot sign in", async () => {
      await platformCall("PATCH", `/platform/tenants/${tenants.globex!.id}`, { status: "SUSPENDED" });
      const res = await as("globex").get("/me");
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe("TENANT_SUSPENDED");
      expect((await login("globex", "admin@example.com", "admin-password-123")).statusCode).toBe(401);
      expect((await as("acme").get("/me")).statusCode).toBe(200);
    });

    it("locks sign-in after repeated failures", async () => {
      let last = 0;
      for (let i = 0; i < 11; i++)
        last = (await login("initech", "admin@example.com", "wrong-password!")).statusCode;
      expect(last).toBe(429);
    });

    it("exposes health and bounded-cardinality metrics", async () => {
      expect((await p.app.inject({ url: "/health/ready" })).json()).toMatchObject({ status: "ready" });
      const metrics = (await p.app.inject({ url: "/metrics" })).body;
      expect(metrics).toContain('route="/assets/:id"');
      expect(metrics).not.toContain(tenants.acme!.id);
    });

    it("degrades gracefully when Redis is down: requests are served, readiness reports it", async () => {
      p.redis.disconnect();
      expect((await as("acme").get("/me")).statusCode).toBe(200);
      const ready = await p.app.inject({ url: "/health/ready" });
      expect(ready.statusCode).toBe(503);
      expect(ready.json().checks).toEqual({ database: true, redis: false });
    });
  });
});
