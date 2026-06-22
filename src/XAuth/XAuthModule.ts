import { XModule, _xlog, type XCommand, 
  type XpellSkill,
  type XpellSkillCommand} 
from "@xpell/core";

import type {
  XAuthLoginParams,
  XAuthLoginResult,
  XAuthAuthorizeReqParams,
  XAuthAuthorizeResult,
  XAuthCreateApiKeyParams,
  XAuthCreateApiKeyResult,
  XAuthHashSecretParams,
  XAuthHashSecretResult,
  XAuthVerifySecretParams,
  XAuthVerifySecretResult,
  XAuthVerifyJwtParams,
  XAuthVerifyJwtResult,
  XAuthCreateJwtParams,
  XAuthCreateJwtResult
} from "./XAuthTypes.js";
import {
  create_api_key,
  detect_token_type,
  get_jwt_config,
  hash_secret,
  is_local_dev_mode,
  pick_safe_jwt_claims,
  sign_jwt,
  verify_secret,
  verify_jwt,
  XAUTH_ERR,
  xauth_unauthorized
} from "./XAuthUtils.js";

const DEV_EMAIL = "admin@local.dev";
const DEV_PASSWORD = "admin";
const DEV_USER_ID = "dev-user";
const DEV_ACCOUNT_ID = "dev-account";
const DEV_CLEARANCE_LEVEL = 100;
const SUPER_USER_CLEARANCE_LEVEL = 999;



export const XAUTH_OPS: Record<string, XpellSkillCommand> = {
  login: {
    _name: "login",
    _scope: "module",
    _description: "Authenticate dev/local credentials and return a JWT.",
    _params: {
      email: "Login email.",
      password: "Login password."
    }
  },

  verify_jwt: {
    _name: "verify_jwt",
    _scope: "module",
    _description: "Verify a JWT and return authenticated auth context.",
    _params: {
      _token: "JWT token."
    }
  },

  create_jwt: {
    _name: "create_jwt",
    _scope: "module",
    _description: "Create a JWT for an authenticated runtime user.",
    _params: {
      _user_id: "Authenticated user id.",
      _account_id: "Authenticated account id.",
      _clearance_level: "Optional clearance level.",
      _auth_type: "JWT auth type.",
      _email: "Optional safe email claim.",
      _role: "Optional safe role claim.",
      _roles: "Optional safe roles claim."
    }
  },

  authorize_req: {
    _name: "authorize_req",
    _scope: "module",
    _description: "Authorize a request context using JWT, API key, or super-user token.",
    _params: {
      _ctx: "Request context.",
      _token: "Optional token override."
    }
  },

  create_api_key: {
    _name: "create_api_key",
    _scope: "module",
    _description: "Create an API key and its hash.",
    _params: {
      _prefix: "Optional key prefix.",
      _env: "Optional environment."
    }
  },

  hash_secret: {
    _name: "hash_secret",
    _scope: "module",
    _description: "Hash a secret for later verification.",
    _params: {
      _secret: "Secret value."
    }
  },

  verify_secret: {
    _name: "verify_secret",
    _scope: "module",
    _description: "Verify a secret against a hash.",
    _params: {
      _secret: "Secret value.",
      _hash: "Stored hash."
    }
  }
};

export const XAUTH_SKILL: XpellSkill = {
  _id: "xauth",
  _title: "XAuth Runtime Module",
  _version: "1.0.0",
  _active: true,
  _type: "server-module-api",
  _requires: ["xmodule"],

  _description:
    "Server-side authentication and authorization module for JWT login, API keys, secret hashing, and request auth context resolution.",

  _exports: {
    _modules: [
      {
        _name: "xauth",
        _scope: "server",
        _description:
          "Authentication and authorization runtime module.",
        _ops: Object.values(XAUTH_OPS)
      }
    ]
  },

  _core_rules: [
    "Use xauth.authorize_req to resolve auth context for incoming requests.",
    "Use xauth.verify_jwt when a JWT token must be validated directly.",
    "Use xauth.create_jwt only after upstream authentication has already succeeded.",
    "Use xauth.create_api_key only for issuing API keys; store only the hash.",
    "Use xauth.hash_secret and xauth.verify_secret for secret comparison.",
    "Do not expose JWT secrets, API key hashes, or raw credentials in generated views or logs."
  ],

  _anti_patterns: [
    "Hardcoding production credentials.",
    "Returning secrets in UI artifacts.",
    "Using create_api_key from browser/client-side flows.",
    "Treating api_key authorization as complete without project-level verification."
  ],

  _canonical_examples: [
    {
      _module: "xauth",
      _op: "authorize_req",
      _params: {
        _ctx: {
          _meta: {
            _token: "$token"
          }
        }
      }
    },
    {
      _module: "xauth",
      _op: "verify_jwt",
      _params: {
        _token: "$token"
      }
    }
  ]
};


export class XAuthModule extends XModule {
  static _name = "xauth";
  static _skill = XAUTH_SKILL;
  static _ops = XAUTH_OPS;
  
  constructor() {
    super({ _name: XAuthModule._name });
  }

  protected async onLoad(): Promise<void> {
    const config = get_jwt_config();
    if (config._is_dev_secret) {
      _xlog.warn("[xauth] XAUTH_JWT_SECRET missing; using deterministic local/dev secret");
    }
    _xlog.log("[xauth] module loaded");
  }

  async _login(xcmd: XCommand): Promise<XAuthLoginResult> {
    const params = (xcmd._params ?? {}) as XAuthLoginParams;
    const email = typeof params.email === "string" ? params.email.trim() : "";
    const password = typeof params.password === "string" ? params.password : "";

    const expected_email = process.env.XAUTH_DEV_EMAIL ?? (is_local_dev_mode() ? DEV_EMAIL : "");
    const expected_password = process.env.XAUTH_DEV_PASSWORD ?? (is_local_dev_mode() ? DEV_PASSWORD : "");

    if (!expected_email || !expected_password || email !== expected_email || password !== expected_password) {
      _xlog.warn("[xauth] dev login failed", { email });
      throw xauth_unauthorized("Invalid credentials", XAUTH_ERR.INVALID_CREDENTIALS);
    }

    const token = sign_jwt({
      _user_id: DEV_USER_ID,
      _account_id: DEV_ACCOUNT_ID,
      _clearance_level: DEV_CLEARANCE_LEVEL,
      _auth_type: "jwt"
    });

    _xlog.log("[xauth] dev login success", {
      _user_id: DEV_USER_ID,
      email
    });

    return {
      _ok: true,
      _token: token,
      _user: {
        _id: DEV_USER_ID,
        email,
        _clearance_level: DEV_CLEARANCE_LEVEL
      }
    };
  }

  async _verify_jwt(xcmd: XCommand): Promise<XAuthVerifyJwtResult> {
    const params = (xcmd._params ?? {}) as XAuthVerifyJwtParams;

    if (typeof params._token !== "string" || !params._token.trim()) {
      _xlog.warn("[xauth] jwt verification failed", { _reason: "missing_token" });
      throw xauth_unauthorized("Missing token", XAUTH_ERR.INVALID_TOKEN);
    }

    try {
      const payload = verify_jwt(params._token.trim());

      _xlog.log("[xauth] jwt verification success", {
        _user_id: payload._user_id
      });

      return {
        _ok: true,
        _valid: true,
        _auth: {
          _authenticated: true,
          _auth_type: "jwt",
          _user_id: payload._user_id,
          _account_id: payload._account_id,
          _clearance_level: payload._clearance_level,
          ...pick_safe_jwt_claims(payload)
        }
      };
    } catch (err) {
      _xlog.warn("[xauth] jwt verification failed");
      throw err;
    }
  }

  async _create_jwt(xcmd: XCommand): Promise<XAuthCreateJwtResult> {
    const params = (xcmd._params ?? {}) as XAuthCreateJwtParams;
    const user_id = typeof params._user_id === "string" ? params._user_id.trim() : "";
    const account_id = typeof params._account_id === "string" ? params._account_id.trim() : "";
    const clearance_level =
      typeof params._clearance_level === "number"
        ? params._clearance_level
        : DEV_CLEARANCE_LEVEL;
    const auth_type = params._auth_type === "jwt" ? "jwt" : "jwt";

    if (!user_id || !account_id) {
      throw xauth_unauthorized("Invalid JWT claims", XAUTH_ERR.INVALID_PARAM);
    }

    const token = sign_jwt({
      _user_id: user_id,
      _account_id: account_id,
      _clearance_level: clearance_level,
      _auth_type: auth_type,
      ...pick_safe_jwt_claims(params as Record<string, unknown>)
    });

    _xlog.log("[xauth] jwt created", {
      _user_id: user_id,
      _account_id: account_id
    });

    return {
      _ok: true,
      _token: token
    };
  }

  async _create_api_key(xcmd: XCommand): Promise<XAuthCreateApiKeyResult> {
    const params = (xcmd._params ?? {}) as XAuthCreateApiKeyParams;
    const prefix = typeof params._prefix === "string" ? params._prefix : "";
    const env = typeof params._env === "string" ? params._env : "";
    const api_key = create_api_key(prefix, env);
    const hash = hash_secret(api_key);

    _xlog.log("[xauth] api key created", {
      _prefix: prefix,
      _env: env
    });

    return {
      _ok: true,
      _api_key: api_key,
      _hash: hash,
      _prefix: prefix.trim().toLowerCase(),
      _env: env.trim().toLowerCase()
    };
  }

  async _hash_secret(xcmd: XCommand): Promise<XAuthHashSecretResult> {
    const params = (xcmd._params ?? {}) as XAuthHashSecretParams;
    if (typeof params._secret !== "string") {
      throw xauth_unauthorized("Invalid _secret", XAUTH_ERR.INVALID_PARAM);
    }

    return {
      _ok: true,
      _hash: hash_secret(params._secret)
    };
  }

  async _verify_secret(xcmd: XCommand): Promise<XAuthVerifySecretResult> {
    const params = (xcmd._params ?? {}) as XAuthVerifySecretParams;

    return {
      _ok: true,
      _valid: verify_secret(
        typeof params._secret === "string" ? params._secret : "",
        typeof params._hash === "string" ? params._hash : ""
      )
    };
  }

  async _authorize_req(xcmd: XCommand): Promise<XAuthAuthorizeResult> {
    const params = (xcmd._params ?? {}) as XAuthAuthorizeReqParams;
    const ctx = is_record(params._ctx) ? params._ctx : {};
    const meta = is_record(ctx._meta) ? ctx._meta : {};

    const token =
      read_token(params._token) ??
      read_token(meta._token);

    const token_type = token ? detect_token_type(token) : "unknown";

    if (token_type === "super_user") {
      _xlog.log("[xauth] authorize req super user");
      return {
        _authenticated: true,
        _auth_type: "super_user",
        _clearance_level: SUPER_USER_CLEARANCE_LEVEL
      };
    }

    if (token_type === "jwt" && token) {
      const verified = await this._verify_jwt({
        _module: XAuthModule._name,
        _op: "verify_jwt",
        _params: { _token: token }
      } as unknown as XCommand);

      return verified._auth;
    }

    if (token_type === "api_key") {
      _xlog.log("[xauth] authorize req api key requires project verifier");
      return {
        _authenticated: false,
        _auth_type: "api_key",
        _requires_project_verifier: true
      };
    }

    _xlog.warn("[xauth] authorize req unauthenticated", {
      _token_type: token_type
    });

    return {
      _authenticated: false,
      _auth_type: "unknown"
    };
  }
}

function read_token(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  return token ? token : undefined;
}

function is_record(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export default XAuthModule;
