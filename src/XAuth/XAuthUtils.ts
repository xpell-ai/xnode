import crypto from "crypto";
import { XError } from "@xpell/core";
import type {
  XAuthJWTClaims,
  XAuthJWTConfig,
  XAuthJWTPayload,
  XAuthTokenType
} from "./XAuthTypes.js";

const DEFAULT_DEV_SECRET = "xauth-local-dev-secret";
const DEFAULT_EXPIRES_IN = "1h";
const DEFAULT_ISSUER = "xpell-node";
const API_KEY_RANDOM_BYTES = 32;
const SCRYPT_KEY_LENGTH = 32;

export const XAUTH_ERR = {
  INVALID_CREDENTIALS: "E_XAUTH_INVALID_CREDENTIALS",
  UNAUTHORIZED: "E_XAUTH_UNAUTHORIZED",
  INVALID_TOKEN: "E_XAUTH_INVALID_TOKEN",
  INVALID_CONFIG: "E_XAUTH_INVALID_CONFIG",
  INVALID_PARAM: "E_XAUTH_INVALID_PARAM"
} as const;

export function xauth_unauthorized(
  message = "Unauthorized",
  code: string = XAUTH_ERR.UNAUTHORIZED
): XError {
  return new XError(code, message, { _level: "warn" });
}

export function is_local_dev_mode(): boolean {
  const env = process.env.NODE_ENV;
  const xenv = process.env.XPELL_ENV ?? process.env.XNODE_ENV;
  return env !== "production" && xenv !== "production";
}

export function get_jwt_config(): XAuthJWTConfig {
  const raw_secret = process.env.XAUTH_JWT_SECRET;
  const is_dev = is_local_dev_mode();

  if (!raw_secret && !is_dev) {
    throw new XError(
      XAUTH_ERR.INVALID_CONFIG,
      "XAUTH_JWT_SECRET is required outside local/dev mode",
      { _level: "error" }
    );
  }

  return {
    _secret: raw_secret ?? DEFAULT_DEV_SECRET,
    _issuer: process.env.XAUTH_JWT_ISSUER ?? DEFAULT_ISSUER,
    _expires_in: process.env.XAUTH_JWT_EXPIRES_IN ?? DEFAULT_EXPIRES_IN,
    _is_dev_secret: !raw_secret
  };
}

export function parse_expires_in(value: string): number {
  const text = value.trim();
  const match = text.match(/^(\d+)([smhdy])?$/);
  if (!match) {
    throw new XError(
      XAUTH_ERR.INVALID_CONFIG,
      "Invalid XAUTH_JWT_EXPIRES_IN format",
      { _level: "error" }
    );
  }

  const amount = Number.parseInt(match[1], 10);
  const unit = match[2] ?? "s";
  const multipliers: Record<string, number> = {
    s: 1,
    m: 60,
    h: 60 * 60,
    d: 24 * 60 * 60,
    y: 365 * 24 * 60 * 60
  };

  return amount * multipliers[unit];
}

export function sign_jwt(
  claims: XAuthJWTClaims,
  config: XAuthJWTConfig = get_jwt_config()
): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: XAuthJWTPayload = {
    ...claims,
    iss: config._issuer,
    iat: now,
    exp: now + parse_expires_in(config._expires_in)
  };

  const header = {
    alg: "HS256",
    typ: "JWT"
  };

  const unsigned = [
    base64url_json(header),
    base64url_json(payload)
  ].join(".");

  const signature = sign(unsigned, config._secret);
  return `${unsigned}.${signature}`;
}

export function verify_jwt(
  token: string,
  config: XAuthJWTConfig = get_jwt_config()
): XAuthJWTPayload {
  const parts = token.split(".");
  if (parts.length !== 3) {
    throw xauth_unauthorized("Invalid token", XAUTH_ERR.INVALID_TOKEN);
  }

  const [header_part, payload_part, signature_part] = parts;
  const unsigned = `${header_part}.${payload_part}`;
  const expected = sign(unsigned, config._secret);

  if (!constant_time_equal(signature_part, expected)) {
    throw xauth_unauthorized("Invalid token", XAUTH_ERR.INVALID_TOKEN);
  }

  const header = parse_base64url_json(header_part);
  if (header.alg !== "HS256" || header.typ !== "JWT") {
    throw xauth_unauthorized("Invalid token", XAUTH_ERR.INVALID_TOKEN);
  }

  const payload = parse_base64url_json(payload_part) as Partial<XAuthJWTPayload>;
  const now = Math.floor(Date.now() / 1000);

  if (typeof payload.exp !== "number" || payload.exp <= now) {
    throw xauth_unauthorized("Token expired", XAUTH_ERR.INVALID_TOKEN);
  }

  if (config._issuer && payload.iss !== config._issuer) {
    throw xauth_unauthorized("Invalid token issuer", XAUTH_ERR.INVALID_TOKEN);
  }

  if (
    typeof payload._user_id !== "string" ||
    typeof payload._account_id !== "string" ||
    typeof payload._clearance_level !== "number" ||
    payload._auth_type !== "jwt"
  ) {
    throw xauth_unauthorized("Invalid token payload", XAUTH_ERR.INVALID_TOKEN);
  }

  return payload as XAuthJWTPayload;
}

export function create_api_key(
  _prefix: string,
  _env: string
): string {
  const prefix = normalize_key_part(_prefix, "_prefix");
  const env = normalize_api_key_env(_env);
  const random = random_base64url(API_KEY_RANDOM_BYTES);
  return `${prefix}_sk_${env}_${random}`;
}

export function hash_secret(secret: string): string {
  if (typeof secret !== "string" || !secret.length) {
    throw new XError(
      XAUTH_ERR.INVALID_PARAM,
      "Invalid _secret",
      { _level: "warn" }
    );
  }

  const salt = random_base64url(16);
  const derived = crypto
    .scryptSync(secret, salt, SCRYPT_KEY_LENGTH)
    .toString("base64");

  return `scrypt.v1.${salt}.${to_base64url(derived)}`;
}

export function verify_secret(
  secret: string,
  hash: string
): boolean {
  if (
    typeof secret !== "string" ||
    typeof hash !== "string"
  ) {
    return false;
  }

  const parts = hash.split(".");
  if (parts.length !== 4 || parts[0] !== "scrypt" || parts[1] !== "v1") {
    return false;
  }

  const salt = parts[2];
  const expected = parts[3];

  const derived = to_base64url(
    crypto
      .scryptSync(secret, salt, SCRYPT_KEY_LENGTH)
      .toString("base64")
  );

  return constant_time_equal(derived, expected);
}

export function detect_token_type(token: string): XAuthTokenType {
  if (typeof token !== "string" || !token.trim()) return "unknown";

  const trimmed = token.trim();
  const super_user_key = process.env.SUPER_USER_KEY;
  if (super_user_key && trimmed === super_user_key) return "super_user";

  if (looks_like_jwt(trimmed)) return "jwt";
  if (looks_like_api_key(trimmed)) return "api_key";

  return "unknown";
}

function normalize_key_part(value: string, field: string): string {
  if (typeof value !== "string") {
    throw new XError(
      XAUTH_ERR.INVALID_PARAM,
      `Invalid ${field}`,
      { _level: "warn" }
    );
  }

  const normalized = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9]*$/.test(normalized)) {
    throw new XError(
      XAUTH_ERR.INVALID_PARAM,
      `Invalid ${field}`,
      { _level: "warn" }
    );
  }

  return normalized;
}

function normalize_api_key_env(value: string): "test" | "live" {
  const normalized = normalize_key_part(value, "_env");
  if (normalized !== "test" && normalized !== "live") {
    throw new XError(
      XAUTH_ERR.INVALID_PARAM,
      "Invalid _env: expected test or live",
      { _level: "warn" }
    );
  }

  return normalized;
}

function looks_like_api_key(token: string): boolean {
  return /^[a-z][a-z0-9]*_sk_[a-z][a-z0-9]*_[A-Za-z0-9_-]{32,}$/.test(token);
}

function looks_like_jwt(token: string): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;

  try {
    const header = parse_base64url_json(parts[0]);
    return header.alg === "HS256" && header.typ === "JWT";
  } catch {
    return false;
  }
}

function sign(unsigned: string, secret: string): string {
  const signature = crypto
    .createHmac("sha256", secret)
    .update(unsigned)
    .digest("base64");
  return to_base64url(signature);
}

function base64url_json(value: unknown): string {
  const encoded = Buffer
    .from(JSON.stringify(value), "utf8")
    .toString("base64");
  return to_base64url(encoded);
}

function parse_base64url_json(value: string): Record<string, unknown> {
  try {
    const decoded = Buffer
      .from(from_base64url(value), "base64")
      .toString("utf8");
    const parsed = JSON.parse(decoded);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("JWT part is not an object");
    }
    return parsed;
  } catch {
    throw xauth_unauthorized("Invalid token", XAUTH_ERR.INVALID_TOKEN);
  }
}

function constant_time_equal(a: string, b: string): boolean {
  const a_buf = Buffer.from(a);
  const b_buf = Buffer.from(b);
  if (a_buf.length !== b_buf.length) return false;
  return crypto.timingSafeEqual(a_buf, b_buf);
}

function to_base64url(value: string): string {
  return value
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function from_base64url(value: string): string {
  const base64 = value
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const pad = base64.length % 4;
  return pad === 0 ? base64 : `${base64}${"=".repeat(4 - pad)}`;
}

function random_base64url(bytes: number): string {
  return to_base64url(
    crypto
      .randomBytes(bytes)
      .toString("base64")
  );
}
