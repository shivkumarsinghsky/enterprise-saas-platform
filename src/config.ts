import { z } from "zod";

const schema = z.object({
  SERVICE_NAME: z.string().default("saas-platform"),
  /** api: HTTP API; worker: outbox dispatcher. One image, roles chosen per deployment. */
  ROLES: z.string().default("api,worker"),
  HTTP_PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  /** Pooled cluster (also the control plane: tenants, plans). Connects as the RLS-restricted app role. */
  DATABASE_URL: z.url(),
  /** Optional dedicated clusters for tenants with placement != 'pooled': {"dedicated-eu-1": "postgres://..."} */
  DEDICATED_DATABASES: z
    .string()
    .default("{}")
    .transform((s, ctx) => {
      try {
        return z.record(z.string(), z.url()).parse(JSON.parse(s));
      } catch {
        ctx.addIssue({ code: "custom", message: "must be a JSON object of placement -> postgres URL" });
        return z.NEVER;
      }
    }),
  REDIS_URL: z.url(),
  JWT_ISSUER: z.string().default("https://saas.local/"),
  JWT_AUDIENCE: z.string().default("saas-api"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  /** PKCS#8 PEM private key (RS256). If absent, an ephemeral key pair is generated (development only). */
  JWT_PRIVATE_KEY: z.string().optional(),
  /** Platform operator credential for /platform/* (tenant provisioning). Store in a secret manager. */
  PLATFORM_API_KEY: z.string().min(24),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(1000),
});

export type Config = z.infer<typeof schema> & { roles: Set<string> };

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid configuration: ${issues}`);
  }
  return { ...parsed.data, roles: new Set(parsed.data.ROLES.split(",").map((r) => r.trim())) };
}
