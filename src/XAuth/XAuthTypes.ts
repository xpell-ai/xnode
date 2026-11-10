export type XAuthType = "jwt" | "api_key" | "super_user";
export type XAuthTokenType = XAuthType | "unknown";
export type XAuthTokenPurpose = "session" | "mcp";
export type XAuthTokenAudience = "browser" | "mcp";

export type XAuthSafeJWTClaims = {
  _email?: string;
  _role?: string;
  _roles?: string[];
  _token_purpose?: XAuthTokenPurpose;
  _audience?: XAuthTokenAudience;
  aud?: string;
  resource?: string;
  scope?: string;
  client_id?: string;
  jti?: string;
  sub?: string;
  grant_id?: string;
  family_id?: string;
};

export type XAuthJWTClaims = XAuthSafeJWTClaims & {
  _user_id: string;
  _account_id: string;
  _clearance_level: number;
  _auth_type: "jwt";
};

export type XAuthJWTPayload = XAuthJWTClaims & {
  iss?: string;
  iat: number;
  exp: number;
};

export type XAuthVerifiedAuth = XAuthSafeJWTClaims & {
  _authenticated: true;
  _auth_type: XAuthType;
  _user_id?: string;
  _account_id?: string;
  _owner_entity_id?: string;
  _project_id?: string;
  _clearance_level: number;
};

export type XAuthUser = {
  _id: string;
  email: string;
  _clearance_level: number;
};

export type XAuthAccount = {
  _id: string;
};

export type XAuthSession = {
  _authenticated: true;
  _auth_type: "jwt";
  _token: string;
  _user_id: string;
  _account_id: string;
  _clearance_level: number;
  _user: XAuthUser;
  _account: XAuthAccount;
  _issued_at?: number;
  _expires_at?: number;
};

export type XAuthLoginParams = {
  email?: unknown;
  password?: unknown;
};

export type XAuthVerifyJwtParams = {
  _token?: unknown;
};

export type XAuthCreateJwtParams = {
  _user_id?: unknown;
  _account_id?: unknown;
  _clearance_level?: unknown;
  _auth_type?: unknown;
  _email?: unknown;
  _role?: unknown;
  _roles?: unknown;
  _token_purpose?: unknown;
  _audience?: unknown;
  aud?: unknown;
  resource?: unknown;
  scope?: unknown;
  client_id?: unknown;
  jti?: unknown;
  sub?: unknown;
  grant_id?: unknown;
  family_id?: unknown;
};

export type XAuthCreateMcpTokenParams = {
  _expires_in?: unknown;
};

export type XAuthCreateApiKeyParams = {
  _prefix?: unknown;
  _env?: unknown;
};

export type XAuthHashSecretParams = {
  _secret?: unknown;
};

export type XAuthVerifySecretParams = {
  _secret?: unknown;
  _hash?: unknown;
};

export type XAuthAuthorizeReqParams = {
  _cmd?: unknown;
  _ctx?: unknown;
  _token?: unknown;
};

export type XAuthLoginResult = {
  _ok: true;
  _authenticated: true;
  _token: string;
  _user: XAuthUser;
  _account: XAuthAccount;
  _session: XAuthSession;
};

export type XAuthVerifyJwtResult = {
  _ok: true;
  _valid: true;
  _auth: XAuthVerifiedAuth;
};

export type XAuthCreateJwtResult = {
  _ok: true;
  _token: string;
};

export type XAuthCreateMcpTokenResult = {
  _ok: true;
  _token: string;
  _expires_at: number;
  _clearance_level: number;
};

export type XAuthCreateOAuthAuthorizationCodeParams = {
  client_id?: unknown;
  redirect_uri?: unknown;
  resource?: unknown;
  scopes?: unknown;
  code_challenge?: unknown;
  code_challenge_method?: unknown;
  issuer?: unknown;
};

export type XAuthCreateOAuthAuthorizationCodeResult = {
  _ok: true;
  _code: string;
  _expires_at: number;
};

export type XAuthExchangeOAuthAuthorizationCodeParams = {
  grant_type?: unknown;
  code?: unknown;
  client_id?: unknown;
  redirect_uri?: unknown;
  resource?: unknown;
  code_verifier?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
};

export type XAuthExchangeOAuthAuthorizationCodeResult = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
};

export type XAuthRevokeOAuthTokenParams = {
  token?: unknown;
  token_type_hint?: unknown;
  client_id?: unknown;
  resource?: unknown;
};

export type XAuthRevokeOAuthTokenResult = {
  _ok: true;
};

export type XAuthCreateApiKeyResult = {
  _ok: true;
  _api_key: string;
  _hash: string;
  _prefix: string;
  _env: string;
};

export type XAuthHashSecretResult = {
  _ok: true;
  _hash: string;
};

export type XAuthVerifySecretResult = {
  _ok: true;
  _valid: boolean;
};

export type XAuthApiKeyAuthResult = {
  _authenticated: false;
  _auth_type: "api_key";
  _requires_project_verifier: true;
};

export type XAuthUnknownAuthResult = {
  _authenticated: false;
  _auth_type: "unknown";
};

export type XAuthAuthorizeResult =
  | XAuthVerifiedAuth
  | XAuthApiKeyAuthResult
  | XAuthUnknownAuthResult;

export type XAuthJWTConfig = {
  _secret: string;
  _issuer?: string;
  _expires_in: string;
  _is_dev_secret: boolean;
};
