import crypto from "crypto";
import { XError } from "@xpell/core";
import { XPELL_MCP_OAUTH_SCOPES } from "@xpell/mcp";
import type { XAuthVerifiedAuth } from "./XAuthTypes.js";
import {
  get_jwt_config,
  get_oauth_mcp_access_token_jwt_config,
  parse_expires_in,
  sign_jwt,
  verify_jwt,
} from "./XAuthUtils.js";
import { XDB, XDBEntity } from "../XDB/index.js";

const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
const PENDING_REQUEST_TTL_SECONDS = 10 * 60;
const CLIENT_METADATA_TIMEOUT_MS = 3000;
const DEFAULT_REFRESH_TOKEN_EXPIRES_IN = "90d";
const DEFAULT_GRANT_EXPIRES_IN = "90d";
const OAUTH_REFRESH_TOKEN_RANDOM_BYTES = 48;
const OAUTH_GRANT_ENTITY_NAME = "xauth_oauth_refresh_tokens";

const OAUTH_GRANT_SCHEMA = {
  id: { _type: "String", _required: true, _index: { _unique: true } },
  token_hash: { _type: "String", _required: true, _index: { _unique: true } },
  grant_id: { _type: "String", _required: true, _index: true },
  family_id: { _type: "String", _required: true, _index: true },
  previous_token_id: { _type: "String" },
  replaced_by: { _type: "String" },
  client_id: { _type: "String", _required: true, _index: true },
  user_id: { _type: "String", _required: true, _index: true },
  account_id: { _type: "String", _required: true, _index: true },
  clearance_level: { _type: "Number", _required: true },
  resource: { _type: "String", _required: true, _index: true },
  scope: { _type: "String", _required: true },
  scopes: { _type: "Array", _required: true },
  issuer: { _type: "String", _required: true },
  created_at: { _type: "Date", _required: true },
  expires_at: { _type: "Date", _required: true },
  grant_expires_at: { _type: "Date", _required: true },
  used_at: { _type: "Date" },
  revoked_at: { _type: "Date" },
  revoked_reason: { _type: "String" },
};

export class XAuthOAuthError extends Error {
  _error: string;
  _status: number;

  constructor(error: string, message: string, status = 400) {
    super(message);
    this.name = "XAuthOAuthError";
    this._error = error;
    this._status = status;
  }
}

export type XAuthOAuthAuthorizeRequest = {
  response_type: "code";
  client_id: string;
  redirect_uri: string;
  scope: string;
  scopes: string[];
  state?: string;
  code_challenge: string;
  code_challenge_method: "S256";
  resource: string;
  issuer: string;
  client_name: string;
};

export type XAuthOAuthPendingRequest = XAuthOAuthAuthorizeRequest & {
  request_id: string;
  expires_at: number;
};

export type XAuthOAuthAuthorizationCodeRecord = {
  code: string;
  client_id: string;
  redirect_uri: string;
  resource: string;
  scope: string;
  scopes: string[];
  code_challenge: string;
  code_challenge_method: "S256";
  issuer: string;
  user_id: string;
  account_id: string;
  clearance_level: number;
  expires_at: number;
};

export type XAuthOAuthRefreshTokenRecord = {
  _id: string;
  id: string;
  token_hash: string;
  grant_id: string;
  family_id: string;
  previous_token_id?: string;
  replaced_by?: string;
  client_id: string;
  user_id: string;
  account_id: string;
  clearance_level: number;
  resource: string;
  scope: string;
  scopes: string[];
  issuer: string;
  created_at: Date | string;
  expires_at: Date | string;
  grant_expires_at: Date | string;
  used_at?: Date | string;
  revoked_at?: Date | string;
  revoked_reason?: string;
};

const pending_requests = new Map<string, XAuthOAuthPendingRequest>();
const authorization_codes = new Map<string, XAuthOAuthAuthorizationCodeRecord>();
let oauth_grant_entity: XDBEntity | undefined;
let oauth_grant_entity_engine: unknown;
let oauth_grant_entity_ready: Promise<XDBEntity> | undefined;
let oauth_refresh_queue: Promise<unknown> = Promise.resolve();

export function normalizeXAuthOAuthAuthorizeRequest(
  raw: Record<string, unknown>,
  options: {
    _resource: string;
    _issuer: string;
    _supported_scopes?: string[];
  },
): Omit<XAuthOAuthAuthorizeRequest, "client_name"> {
  const response_type = readRequiredString(raw.response_type, "response_type");
  if (response_type !== "code") {
    throw new XAuthOAuthError("unsupported_response_type", "Only response_type=code is supported.");
  }

  const client_id = readRequiredString(raw.client_id, "client_id");
  const redirect_uri = readRequiredString(raw.redirect_uri, "redirect_uri");
  const code_challenge = readRequiredString(raw.code_challenge, "code_challenge");
  const code_challenge_method = readRequiredString(raw.code_challenge_method, "code_challenge_method");
  const resource = readRequiredString(raw.resource, "resource");

  if (code_challenge_method !== "S256") {
    throw new XAuthOAuthError("invalid_request", "Only PKCE S256 is supported.");
  }

  if (resource !== options._resource) {
    throw new XAuthOAuthError("invalid_request", "Invalid resource.");
  }

  assertRedirectUriSyntax(redirect_uri);

  const supported_scopes = normalizeSupportedScopes(options._supported_scopes);
  const scopes = normalizeRequestedScopes(raw.scope, supported_scopes);

  return {
    response_type: "code",
    client_id,
    redirect_uri,
    scope: scopes.join(" "),
    scopes,
    ...(typeof raw.state === "string" ? { state: raw.state } : {}),
    code_challenge,
    code_challenge_method: "S256",
    resource,
    issuer: options._issuer,
  };
}

export async function resolveXAuthOAuthClient(
  request: Omit<XAuthOAuthAuthorizeRequest, "client_name">,
): Promise<XAuthOAuthAuthorizeRequest> {
  const client_url = parseClientMetadataUrl(request.client_id);
  const metadata = await fetchClientMetadata(client_url);
  const redirect_uris = Array.isArray(metadata.redirect_uris)
    ? metadata.redirect_uris.filter((entry): entry is string => typeof entry === "string")
    : [];

  const auth_methods = Array.isArray(metadata.token_endpoint_auth_methods_supported)
    ? metadata.token_endpoint_auth_methods_supported
    : typeof metadata.token_endpoint_auth_method === "string"
      ? [metadata.token_endpoint_auth_method]
      : ["none"];

  if (!auth_methods.includes("none")) {
    throw new XAuthOAuthError("invalid_client", "Client does not support public token exchange.");
  }

  if (!isRedirectUriAllowedByClientMetadata(request.redirect_uri, redirect_uris, {
    allow_native_loopback_port: auth_methods.includes("none"),
  })) {
    throw new XAuthOAuthError("invalid_redirect_uri", "Invalid redirect URI.");
  }

  return {
    ...request,
    client_name: typeof metadata.client_name === "string" && metadata.client_name.trim()
      ? metadata.client_name.trim()
      : request.client_id,
  };
}

export function createXAuthOAuthPendingRequest(
  request: XAuthOAuthAuthorizeRequest,
): XAuthOAuthPendingRequest {
  cleanupOAuthStores();
  const request_id = randomBase64Url(32);
  const pending = {
    ...request,
    request_id,
    expires_at: nowSeconds() + PENDING_REQUEST_TTL_SECONDS,
  };
  pending_requests.set(request_id, pending);
  return pending;
}

export function readXAuthOAuthPendingRequest(request_id: string): XAuthOAuthPendingRequest {
  cleanupOAuthStores();
  const request = pending_requests.get(request_id);
  if (!request) {
    throw new XAuthOAuthError("invalid_request", "OAuth authorization request expired.");
  }
  return request;
}

export function deleteXAuthOAuthPendingRequest(request_id: string): void {
  pending_requests.delete(request_id);
}

export function createXAuthOAuthAuthorizationCode(
  params: {
    client_id?: unknown;
    redirect_uri?: unknown;
    resource?: unknown;
    scopes?: unknown;
    code_challenge?: unknown;
    code_challenge_method?: unknown;
    issuer?: unknown;
  },
  auth: XAuthVerifiedAuth,
): { _ok: true; _code: string; _expires_at: number } {
  cleanupOAuthStores();

  if (auth._authenticated !== true || !auth._user_id || !auth._account_id) {
    throw new XError("E_XAUTH_OAUTH_UNAUTHORIZED", "Authenticated browser session required.");
  }

  const client_id = readRequiredString(params.client_id, "client_id");
  const redirect_uri = readRequiredString(params.redirect_uri, "redirect_uri");
  const resource = readRequiredString(params.resource, "resource");
  const code_challenge = readRequiredString(params.code_challenge, "code_challenge");
  const code_challenge_method = readRequiredString(params.code_challenge_method, "code_challenge_method");
  const issuer = readRequiredString(params.issuer, "issuer");
  const scopes = Array.isArray(params.scopes)
    ? params.scopes.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];

  if (code_challenge_method !== "S256" || scopes.length === 0) {
    throw new XError("E_XAUTH_OAUTH_INVALID_REQUEST", "Invalid OAuth authorization code request.");
  }

  const code = randomBase64Url(32);
  const expires_at = nowSeconds() + AUTHORIZATION_CODE_TTL_SECONDS;
  authorization_codes.set(code, {
    code,
    client_id,
    redirect_uri,
    resource,
    scope: scopes.join(" "),
    scopes,
    code_challenge,
    code_challenge_method: "S256",
    issuer,
    user_id: auth._user_id,
    account_id: auth._account_id,
    clearance_level: auth._clearance_level,
    expires_at,
  });

  return {
    _ok: true,
    _code: code,
    _expires_at: expires_at,
  };
}

export async function exchangeXAuthOAuthAuthorizationCode(
  params: {
    grant_type?: unknown;
    code?: unknown;
    client_id?: unknown;
    redirect_uri?: unknown;
    resource?: unknown;
    code_verifier?: unknown;
    refresh_token?: unknown;
    scope?: unknown;
  },
): Promise<{ access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string }> {
  cleanupOAuthStores();
  const grant_type = readRequiredString(params.grant_type, "grant_type");
  if (grant_type === "refresh_token") {
    return exchangeXAuthOAuthRefreshToken(params);
  }

  if (grant_type !== "authorization_code") {
    throw new XAuthOAuthError("unsupported_grant_type", "Only authorization_code and refresh_token grants are supported.");
  }

  return runOAuthRefreshStoreTransaction(async () =>
    exchangeXAuthOAuthAuthorizationCodeGrant(params)
  );
}

export async function revokeXAuthOAuthToken(
  params: {
    token?: unknown;
    token_type_hint?: unknown;
    client_id?: unknown;
    resource?: unknown;
  },
): Promise<{ _ok: true }> {
  const token = typeof params.token === "string" ? params.token.trim() : "";
  if (!token) {
    throw new XAuthOAuthError("invalid_request", "Missing token.");
  }

  await runOAuthRefreshStoreTransaction(async () => {
    const record = await findRefreshTokenRecordByToken(token);
    if (!record) return;

    const client_id = typeof params.client_id === "string" ? params.client_id.trim() : "";
    const resource = typeof params.resource === "string" ? params.resource.trim() : "";
    if (client_id && client_id !== record.client_id) return;
    if (resource && resource !== record.resource) return;

    await revokeRefreshTokenFamily(record.family_id, "revoked");
  });

  return { _ok: true };
}

export async function listXAuthOAuthRefreshTokenRecordsForTests(): Promise<XAuthOAuthRefreshTokenRecord[]> {
  const entity = await getOAuthGrantEntity();
  await entity.waitUntilLoaded?.();
  const result = entity.find({}, 0, 100000);
  return Array.isArray(result?._data)
    ? result._data.map((record: any) => ({ ...record }))
    : [];
}

async function exchangeXAuthOAuthAuthorizationCodeGrant(
  params: {
    code?: unknown;
    client_id?: unknown;
    redirect_uri?: unknown;
    resource?: unknown;
    code_verifier?: unknown;
  },
): Promise<{ access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string }> {
  const code = readRequiredString(params.code, "code");
  const record = authorization_codes.get(code);
  authorization_codes.delete(code);

  if (!record || record.expires_at <= nowSeconds()) {
    throw new XAuthOAuthError("invalid_grant", "Invalid authorization code.");
  }

  const client_id = readRequiredString(params.client_id, "client_id");
  const redirect_uri = readRequiredString(params.redirect_uri, "redirect_uri");
  const resource = readRequiredString(params.resource, "resource");
  const code_verifier = readRequiredString(params.code_verifier, "code_verifier");

  if (
    client_id !== record.client_id ||
    redirect_uri !== record.redirect_uri ||
    resource !== record.resource
  ) {
    throw new XAuthOAuthError("invalid_grant", "Authorization code binding mismatch.");
  }

  if (pkceS256(code_verifier) !== record.code_challenge) {
    throw new XAuthOAuthError("invalid_grant", "PKCE verification failed.");
  }

  const now = nowSeconds();
  const grant_id = randomBase64Url(16);
  const family_id = grant_id;
  const grant_expires_at = now + oauthGrantExpiresInSeconds();

  return issueOAuthTokenResponse({
    client_id: record.client_id,
    user_id: record.user_id,
    account_id: record.account_id,
    clearance_level: record.clearance_level,
    resource: record.resource,
    scope: record.scope,
    scopes: record.scopes,
    issuer: record.issuer,
    grant_id,
    family_id,
    grant_expires_at,
  });
}

async function exchangeXAuthOAuthRefreshToken(
  params: {
    refresh_token?: unknown;
    client_id?: unknown;
    resource?: unknown;
    scope?: unknown;
  },
): Promise<{ access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string }> {
  return runOAuthRefreshStoreTransaction(async () => {
    const refresh_token = readRequiredString(params.refresh_token, "refresh_token");
    const client_id = readRequiredString(params.client_id, "client_id");
    const resource = readRequiredString(params.resource, "resource");
    const record = await findRefreshTokenRecordByToken(refresh_token);
    const now = nowSeconds();

    if (!record) {
      throw new XAuthOAuthError("invalid_grant", "Invalid refresh token.");
    }

    if (client_id !== record.client_id || resource !== record.resource) {
      throw new XAuthOAuthError("invalid_grant", "Invalid refresh token.");
    }

    if (record.revoked_at || record.revoked_reason) {
      throw new XAuthOAuthError("invalid_grant", "Invalid refresh token.");
    }

    if (record.used_at || record.replaced_by) {
      await revokeRefreshTokenFamily(record.family_id, "reuse_detected");
      throw new XAuthOAuthError("invalid_grant", "Invalid refresh token.");
    }

    if (
      dateToSeconds(record.expires_at) <= now ||
      dateToSeconds(record.grant_expires_at) <= now
    ) {
      throw new XAuthOAuthError("invalid_grant", "Invalid refresh token.");
    }

    const scopes = normalizeRefreshScopes(params.scope, record.scopes);
    const scope = scopes.join(" ");
    const replacement_id = randomBase64Url(16);
    const entity = await getOAuthGrantEntity();
    const used_at = new Date(now * 1000);
    await entity.update({ _id: record._id }, {
      used_at,
      replaced_by: replacement_id,
    });

    return issueOAuthTokenResponse({
      client_id: record.client_id,
      user_id: record.user_id,
      account_id: record.account_id,
      clearance_level: record.clearance_level,
      resource: record.resource,
      scope,
      scopes,
      issuer: record.issuer,
      grant_id: record.grant_id,
      family_id: record.family_id,
      grant_expires_at: dateToSeconds(record.grant_expires_at),
      previous_token_id: record.id,
      token_id: replacement_id,
    });
  });
}

async function issueOAuthTokenResponse(input: {
  client_id: string;
  user_id: string;
  account_id: string;
  clearance_level: number;
  resource: string;
  scope: string;
  scopes: string[];
  issuer: string;
  grant_id: string;
  family_id: string;
  grant_expires_at: number;
  previous_token_id?: string;
  token_id?: string;
}): Promise<{ access_token: string; token_type: "Bearer"; expires_in: number; refresh_token: string; scope: string }> {
  const now = nowSeconds();
  if (input.grant_expires_at <= now) {
    throw new XAuthOAuthError("invalid_grant", "Invalid refresh token.");
  }

  const refresh_token = createOpaqueRefreshToken();
  const refresh_token_id = input.token_id ?? randomBase64Url(16);
  const refresh_expires_at = Math.min(
    now + oauthRefreshTokenExpiresInSeconds(),
    input.grant_expires_at,
  );
  const entity = await getOAuthGrantEntity();
  await entity.add({
    _id: refresh_token_id,
    id: refresh_token_id,
    token_hash: hashOAuthRefreshToken(refresh_token),
    grant_id: input.grant_id,
    family_id: input.family_id,
    ...(input.previous_token_id ? { previous_token_id: input.previous_token_id } : {}),
    client_id: input.client_id,
    user_id: input.user_id,
    account_id: input.account_id,
    clearance_level: input.clearance_level,
    resource: input.resource,
    scope: input.scope,
    scopes: input.scopes,
    issuer: input.issuer,
    created_at: new Date(now * 1000),
    expires_at: new Date(refresh_expires_at * 1000),
    grant_expires_at: new Date(input.grant_expires_at * 1000),
  });

  const token_config = get_oauth_mcp_access_token_jwt_config(input.issuer);
  const access_token = sign_jwt({
    _user_id: input.user_id,
    _account_id: input.account_id,
    _clearance_level: input.clearance_level,
    _auth_type: "jwt",
    _token_purpose: "mcp",
    _audience: "mcp",
    sub: input.user_id,
    aud: input.resource,
    resource: input.resource,
    scope: input.scope,
    client_id: input.client_id,
    grant_id: input.grant_id,
    family_id: input.family_id,
    jti: randomBase64Url(16),
  }, token_config);
  const payload = verify_jwt(access_token, token_config);

  return {
    access_token,
    token_type: "Bearer",
    expires_in: Math.max(0, payload.exp - payload.iat),
    refresh_token,
    scope: input.scope,
  };
}

export function toOAuthRedirect(
  redirect_uri: string,
  params: Record<string, string | undefined>,
): string {
  const url = new URL(redirect_uri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

export function isXAuthOAuthError(error: unknown): error is XAuthOAuthError {
  return error instanceof XAuthOAuthError;
}

function normalizeRequestedScopes(value: unknown, supported_scopes: string[]): string[] {
  const scope_text = typeof value === "string" && value.trim()
    ? value.trim()
    : supported_scopes.join(" ");
  const requested = Array.from(new Set(scope_text.split(/\s+/).filter(Boolean)));

  if (requested.length === 0) {
    throw new XAuthOAuthError("invalid_scope", "At least one scope is required.");
  }

  const allowed = new Set(supported_scopes);
  if (requested.some((scope) => !allowed.has(scope))) {
    throw new XAuthOAuthError("invalid_scope", "Unsupported scope requested.");
  }

  return requested;
}

function normalizeRefreshScopes(value: unknown, current_scopes: string[]): string[] {
  const requested = typeof value === "string" && value.trim()
    ? Array.from(new Set(value.trim().split(/\s+/).filter(Boolean)))
    : [...current_scopes];
  const allowed = new Set(current_scopes);

  if (requested.length === 0 || requested.some((scope) => !allowed.has(scope))) {
    throw new XAuthOAuthError("invalid_scope", "Requested scope exceeds original grant.");
  }

  return requested;
}

function normalizeSupportedScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return [...XPELL_MCP_OAUTH_SCOPES];
  const scopes = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return scopes.length > 0 ? Array.from(new Set(scopes)) : [...XPELL_MCP_OAUTH_SCOPES];
}

function parseClientMetadataUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new XAuthOAuthError("invalid_client", "Client metadata URL is required.");
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new XAuthOAuthError("invalid_client", "Client metadata URL must not include credentials, query, or fragment.");
  }

  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url;

  throw new XAuthOAuthError("invalid_client", "Client metadata URL must use HTTPS.");
}

async function fetchClientMetadata(url: URL): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CLIENT_METADATA_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new XAuthOAuthError("invalid_client", "Client metadata could not be fetched.");
    }
    const body = await response.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new XAuthOAuthError("invalid_client", "Client metadata must be a JSON object.");
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (isXAuthOAuthError(error)) throw error;
    throw new XAuthOAuthError("invalid_client", "Client metadata could not be fetched.");
  } finally {
    clearTimeout(timeout);
  }
}

function assertRedirectUriSyntax(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new XAuthOAuthError("invalid_redirect_uri", "Invalid redirect URI.");
  }

  if (url.username || url.password || url.hash) {
    throw new XAuthOAuthError("invalid_request", "Invalid redirect URI.");
  }

  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return;

  throw new XAuthOAuthError("invalid_redirect_uri", "Redirect URI must use HTTPS or localhost.");
}

function isRedirectUriAllowedByClientMetadata(
  requested_uri: string,
  registered_uris: string[],
  options: { allow_native_loopback_port: boolean },
): boolean {
  if (registered_uris.includes(requested_uri)) return true;
  if (!options.allow_native_loopback_port) return false;

  let requested: URL;
  try {
    requested = new URL(requested_uri);
  } catch {
    return false;
  }

  for (const registered_uri of registered_uris) {
    if (nativeLoopbackRedirectMatches(registered_uri, requested)) {
      return true;
    }
  }

  return false;
}

function nativeLoopbackRedirectMatches(registered_uri: string, requested: URL): boolean {
  let registered: URL;
  try {
    registered = new URL(registered_uri);
  } catch {
    return false;
  }

  if (!isValidRedirectComparisonUrl(registered) || !isValidRedirectComparisonUrl(requested)) {
    return false;
  }

  if (registered.protocol !== "http:" || requested.protocol !== "http:") return false;
  if (!isLoopbackHost(registered.hostname) || !isLoopbackHost(requested.hostname)) return false;
  if (registered.hostname !== requested.hostname) return false;
  if (registered.pathname !== requested.pathname) return false;
  if (registered.hash || requested.hash) return false;
  if (!queryParamsEquivalent(registered.searchParams, requested.searchParams)) return false;

  return true;
}

function isValidRedirectComparisonUrl(url: URL): boolean {
  return !url.username && !url.password && !url.hash;
}

function queryParamsEquivalent(left: URLSearchParams, right: URLSearchParams): boolean {
  const left_entries = normalizedQueryEntries(left);
  const right_entries = normalizedQueryEntries(right);
  if (left_entries.length !== right_entries.length) return false;
  for (let i = 0; i < left_entries.length; i += 1) {
    if (left_entries[i] !== right_entries[i]) return false;
  }
  return true;
}

function normalizedQueryEntries(params: URLSearchParams): string[] {
  return Array.from(params.entries())
    .map(([key, value]) => `${key}\u0000${value}`)
    .sort();
}

function pkceS256(verifier: string): string {
  return crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
}

function createOpaqueRefreshToken(): string {
  return `xrt_${randomBase64Url(OAUTH_REFRESH_TOKEN_RANDOM_BYTES)}`;
}

function hashOAuthRefreshToken(token: string): string {
  const secret = process.env.XAUTH_MCP_OAUTH_REFRESH_TOKEN_HASH_SECRET
    || get_jwt_config()._secret;
  const digest = crypto
    .createHmac("sha256", secret)
    .update(token)
    .digest("base64url");

  return `hmac-sha256.v1.${digest}`;
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

async function findRefreshTokenRecordByToken(token: string): Promise<XAuthOAuthRefreshTokenRecord | null> {
  const token_hash = hashOAuthRefreshToken(token);
  const entity = await getOAuthGrantEntity();
  await entity.waitUntilLoaded?.();
  const result = entity.find({ token_hash }, 0, 2);
  const records = Array.isArray(result?._data) ? result._data : [];
  for (const record of records) {
    if (
      typeof record?.token_hash === "string" &&
      timingSafeStringEqual(record.token_hash, token_hash)
    ) {
      return record as unknown as XAuthOAuthRefreshTokenRecord;
    }
  }
  return null;
}

async function revokeRefreshTokenFamily(family_id: string, reason: string): Promise<void> {
  const entity = await getOAuthGrantEntity();
  const revoked_at = new Date();
  const records = await findRefreshTokenFamilyRecords(family_id);
  for (const record of records) {
    if (record.revoked_at) continue;
    await entity.update({ _id: record._id }, {
      revoked_at,
      revoked_reason: reason,
    });
  }
}

async function findRefreshTokenFamilyRecords(family_id: string): Promise<XAuthOAuthRefreshTokenRecord[]> {
  const entity = await getOAuthGrantEntity();
  await entity.waitUntilLoaded?.();
  const result = entity.find({ family_id }, 0, 100000);
  return Array.isArray(result?._data)
    ? result._data as unknown as XAuthOAuthRefreshTokenRecord[]
    : [];
}

async function getOAuthGrantEntity(): Promise<XDBEntity> {
  if (!(XDB as any).ready || !(XDB as any)._engine) {
    throw new XAuthOAuthError("server_error", "OAuth grant storage is unavailable.", 500);
  }

  const engine = (XDB as any)._engine;
  if (oauth_grant_entity && oauth_grant_entity_engine === engine) {
    return oauth_grant_entity;
  }

  if (oauth_grant_entity_ready && oauth_grant_entity_engine === engine) {
    return oauth_grant_entity_ready;
  }

  oauth_grant_entity_engine = engine;
  oauth_grant_entity_ready = (async () => {
    const entity = XDB.create({
      _type: XDBEntity._xtype,
      _id: OAUTH_GRANT_ENTITY_NAME,
      _name: OAUTH_GRANT_ENTITY_NAME,
      _schema: OAUTH_GRANT_SCHEMA,
      _meta: {
        _version: 1,
        _description: "XAuth OAuth refresh-token grants for MCP access.",
      },
    }) as XDBEntity;
    await entity.waitUntilLoaded?.();
    await entity.syncSchema(OAUTH_GRANT_SCHEMA as any, {
      _version: 1,
      _description: "XAuth OAuth refresh-token grants for MCP access.",
    });
    oauth_grant_entity = entity;
    return entity;
  })();

  return oauth_grant_entity_ready;
}

function runOAuthRefreshStoreTransaction<T>(handler: () => Promise<T>): Promise<T> {
  const next = oauth_refresh_queue.then(handler, handler);
  oauth_refresh_queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

function oauthRefreshTokenExpiresInSeconds(): number {
  return parse_expires_in(
    process.env.XAUTH_MCP_OAUTH_REFRESH_TOKEN_EXPIRES_IN
      || DEFAULT_REFRESH_TOKEN_EXPIRES_IN,
  );
}

function oauthGrantExpiresInSeconds(): number {
  return parse_expires_in(
    process.env.XAUTH_MCP_OAUTH_GRANT_EXPIRES_IN
      || DEFAULT_GRANT_EXPIRES_IN,
  );
}

function dateToSeconds(value: Date | string | number | undefined): number {
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === "number") return Math.floor(value / 1000);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
  }
  return 0;
}

function cleanupOAuthStores(): void {
  const now = nowSeconds();
  for (const [key, value] of pending_requests.entries()) {
    if (value.expires_at <= now) pending_requests.delete(key);
  }
  for (const [key, value] of authorization_codes.entries()) {
    if (value.expires_at <= now) authorization_codes.delete(key);
  }
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new XAuthOAuthError("invalid_request", `Missing ${field}.`);
  }
  return value.trim();
}

function randomBase64Url(bytes: number): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
}
