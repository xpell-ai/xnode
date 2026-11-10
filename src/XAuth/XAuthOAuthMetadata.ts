import { XPELL_MCP_OAUTH_SCOPES } from "@xpell/mcp";

export const XAUTH_OAUTH_AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";
export const XAUTH_OAUTH_AUTHORIZATION_ENDPOINT = "/oauth/authorize";
export const XAUTH_OAUTH_TOKEN_ENDPOINT = "/oauth/token";
export const XAUTH_OAUTH_REVOCATION_ENDPOINT = "/oauth/revoke";

export type XAuthOAuthMetadataOptions = {
  _issuer: string;
  _scopes?: string[];
};

export type XAuthAuthorizationServerMetadata = {
  issuer: string;
  authorization_response_iss_parameter_supported: true;
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
  response_types_supported: ["code"];
  grant_types_supported: ["authorization_code", "refresh_token"];
  code_challenge_methods_supported: ["S256"];
  scopes_supported: string[];
  client_id_metadata_document_supported: true;
  token_endpoint_auth_methods_supported: ["none"];
  revocation_endpoint_auth_methods_supported: ["none"];
};

export function createXAuthAuthorizationServerMetadata(
  options: XAuthOAuthMetadataOptions,
): XAuthAuthorizationServerMetadata {
  const issuer = options._issuer.replace(/\/+$/, "");

  return {
    issuer,
    authorization_response_iss_parameter_supported: true,
    authorization_endpoint: `${issuer}${XAUTH_OAUTH_AUTHORIZATION_ENDPOINT}`,
    token_endpoint: `${issuer}${XAUTH_OAUTH_TOKEN_ENDPOINT}`,
    revocation_endpoint: `${issuer}${XAUTH_OAUTH_REVOCATION_ENDPOINT}`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: normalizeScopes(options._scopes),
    client_id_metadata_document_supported: true,
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
  };
}

function normalizeScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return [...XPELL_MCP_OAUTH_SCOPES];

  const scopes = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);

  return scopes.length > 0 ? Array.from(new Set(scopes)) : [...XPELL_MCP_OAUTH_SCOPES];
}
