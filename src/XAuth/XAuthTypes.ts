export type XAuthType = "jwt" | "api_key" | "super_user";
export type XAuthTokenType = XAuthType | "unknown";

export type XAuthJWTClaims = {
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

export type XAuthVerifiedAuth = {
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

export type XAuthLoginParams = {
  email?: unknown;
  password?: unknown;
};

export type XAuthVerifyJwtParams = {
  _token?: unknown;
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
  _token: string;
  _user: XAuthUser;
};

export type XAuthVerifyJwtResult = {
  _ok: true;
  _valid: true;
  _auth: XAuthVerifiedAuth;
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
