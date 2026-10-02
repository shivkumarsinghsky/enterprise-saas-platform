import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";
import { TokenService } from "../../src/modules/identity/tokens.js";
import { TtlCache, tenantKey } from "../../src/platform/cache.js";
import { AppError } from "../../src/platform/errors.js";
import { DUMMY_HASH, hashPassword, verifyPassword } from "../../src/platform/passwords.js";

describe("passwords", () => {
  it("hashes with a random salt and verifies", async () => {
    const a = await hashPassword("correct horse battery");
    const b = await hashPassword("correct horse battery");
    expect(a).not.toBe(b);
    expect(await verifyPassword("correct horse battery", a)).toBe(true);
    expect(await verifyPassword("wrong", a)).toBe(false);
    expect(await verifyPassword("anything", DUMMY_HASH)).toBe(false);
    expect(await verifyPassword("x", "md5$abc")).toBe(false);
  });
});

describe("tokens", () => {
  const opts = { issuer: "https://issuer.test/", audience: "saas-api", ttlSeconds: 60 };

  it("issues and verifies RS256 tokens carrying user and tenant", async () => {
    const svc = new TokenService(opts);
    const { accessToken } = await svc.issue({ sub: "u1", tid: "t1" });
    expect(await svc.verify(accessToken)).toEqual({ sub: "u1", tid: "t1" });
    expect(svc.usesEphemeralKey).toBe(true);
  });

  it("rejects tokens for another audience, from another key, or tampered", async () => {
    const svc = new TokenService(opts);
    const other = new TokenService({ ...opts, audience: "other-api" });
    const { accessToken } = await other.issue({ sub: "u1", tid: "t1" });
    await expect(svc.verify(accessToken)).rejects.toBeInstanceOf(AppError);

    const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
      type: "pkcs8",
      format: "pem",
    });
    const foreign = new TokenService({ ...opts, privateKeyPem: pem.toString() });
    await expect(svc.verify((await foreign.issue({ sub: "u1", tid: "t1" })).accessToken)).rejects.toThrow(
      "invalid",
    );

    const good = (await svc.issue({ sub: "u1", tid: "t1" })).accessToken;
    const [h, , s] = good.split(".");
    const forged = Buffer.from(
      JSON.stringify({ sub: "u1", tid: "t2", iss: opts.issuer, aud: opts.audience }),
    ).toString("base64url");
    await expect(svc.verify(`${h}.${forged}.${s}`)).rejects.toThrow("invalid");
  });
});

describe("TtlCache", () => {
  it("caches until TTL and supports tenant-prefix invalidation", async () => {
    let now = 0;
    let loads = 0;
    const cache = new TtlCache<number>(1_000, 100, () => now);
    const load = async () => ++loads;
    await cache.getOrLoad(tenantKey("t1", "perms", "u1"), load);
    await cache.getOrLoad(tenantKey("t1", "perms", "u1"), load);
    expect(loads).toBe(1);
    now = 1_001;
    await cache.getOrLoad(tenantKey("t1", "perms", "u1"), load);
    expect(loads).toBe(2);
    cache.invalidatePrefix(tenantKey("t1", "perms"));
    await cache.getOrLoad(tenantKey("t1", "perms", "u1"), load);
    expect(loads).toBe(3);
    expect(tenantKey("abc", "x", "y")).toBe("t:abc:x:y");
  });
});

describe("configuration", () => {
  const base = {
    DATABASE_URL: "postgres://saas_app:x@localhost:5432/saas",
    REDIS_URL: "redis://localhost:6379",
    PLATFORM_API_KEY: "a-long-platform-operator-key-123",
  };

  it("parses dedicated database placements", () => {
    const c = loadConfig({
      ...base,
      DEDICATED_DATABASES: '{"dedicated-eu-1":"postgres://saas_app:x@db2:5432/saas"}',
    });
    expect(Object.keys(c.DEDICATED_DATABASES)).toEqual(["dedicated-eu-1"]);
  });

  it("rejects weak platform keys and malformed placement maps", () => {
    expect(() => loadConfig({ ...base, PLATFORM_API_KEY: "short" })).toThrow(/PLATFORM_API_KEY/);
    expect(() => loadConfig({ ...base, DEDICATED_DATABASES: "not json" })).toThrow(/DEDICATED_DATABASES/);
  });
});
