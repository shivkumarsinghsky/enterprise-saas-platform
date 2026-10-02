import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { unauthorized } from "../../platform/errors.js";

export interface AccessTokenClaims {
  /** user id */
  sub: string;
  /** tenant id */
  tid: string;
}

/**
 * Issues and verifies RS256 access tokens. Tokens carry identity only (user + tenant); permissions are resolved
 * server-side per request so that role changes take effect without waiting for token expiry (ADR-004).
 */
export class TokenService {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;

  constructor(
    private readonly opts: { issuer: string; audience: string; ttlSeconds: number; privateKeyPem?: string },
  ) {
    if (opts.privateKeyPem) {
      this.privateKey = createPrivateKey(opts.privateKeyPem);
    } else {
      // Development convenience: ephemeral key; tokens become invalid on restart. Never rely on this in production.
      this.privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    }
    this.publicKey = createPublicKey(this.privateKey);
  }

  get usesEphemeralKey(): boolean {
    return !this.opts.privateKeyPem;
  }

  async issue(claims: AccessTokenClaims): Promise<{ accessToken: string; expiresIn: number }> {
    const accessToken = await new SignJWT({ tid: claims.tid })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setSubject(claims.sub)
      .setIssuer(this.opts.issuer)
      .setAudience(this.opts.audience)
      .setIssuedAt()
      .setExpirationTime(`${this.opts.ttlSeconds}s`)
      .sign(this.privateKey);
    return { accessToken, expiresIn: this.opts.ttlSeconds };
  }

  async verify(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        issuer: this.opts.issuer,
        audience: this.opts.audience,
        algorithms: ["RS256"],
      });
      if (typeof payload.sub !== "string" || typeof payload.tid !== "string")
        throw new Error("missing claims");
      return { sub: payload.sub, tid: payload.tid };
    } catch {
      throw unauthorized("invalid or expired access token");
    }
  }
}
