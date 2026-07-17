import {
  XError,
  XModule,
  XResponseError,
  XResponseOK,
  _xlog,
  type XCommand,
  type XpellSkill,
  type XpellSkillCommand,
} from "@xpell/core";
import { _xu } from "@xpell/node-core";

import { wsBroadcastScoped } from "./wh.ws.server.js";

const DEFAULT_ENV = "default";
const WORMHOLES_BROADCAST_OP = "broadcast";

export const WORMHOLES_OPS: Record<string, XpellSkillCommand> = {
  broadcast: {
    _name: WORMHOLES_BROADCAST_OP,
    _scope: "module",
    _description: "Broadcast an event to Wormholes clients subscribed to an app/env scope.",
    _params: {
      _app_id: "Target app id.",
      _env: "Optional environment. Defaults to default.",
      _event: "Event name to broadcast.",
      _payload: "Optional JSON-compatible event payload.",
    },
  },
};

export const WORMHOLES_SKILL: XpellSkill = {
  _id: "wormholes",
  _title: "Wormholes Server Module",
  _version: "1.0.0",
  _active: true,
  _type: "server-module-api",
  _requires: ["xmodule", "wormholes-protocol"],
  _description:
    "Server-side command-bus facade over Wormholes scoped broadcast helpers.",

  _exports: {
    _modules: [
      {
        _name: "wormholes",
        _scope: "server",
        _description:
          "Trusted server facade for app/env-scoped Wormholes broadcasts.",
        _ops: Object.values(WORMHOLES_OPS),
      },
    ],
  },

  _core_rules: [
    "V1 exposes only broadcast.",
    "Broadcast delegates to the existing Wormholes WebSocket registry.",
    "No transport, connection registry, or websocket server is created by this module.",
    "Do not expose broadcast to external callers without explicit authorization policy.",
  ],
};

function invalid_param(code: string, message: string, meta?: Record<string, unknown>): XError {
  return new XError(code, message, {
    _level: "warn",
    _meta: meta,
  });
}

function read_required_string(params: Record<string, unknown>, key: string, code: string): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid_param(code, `Invalid ${key}: expected non-empty string`, { [key]: value });
  }
  return value.trim();
}

function read_optional_env(params: Record<string, unknown>): string {
  const value = params._env;
  if (value === undefined || value === null || value === "") return DEFAULT_ENV;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw invalid_param("E_WH_INVALID_SCOPE", "Invalid _env: expected non-empty string", {
      _env: value,
    });
  }
  return value.trim();
}

export class WormholesModule extends XModule {
  static _name = "wormholes";
  static _ops = WORMHOLES_OPS;
  static _skill = WORMHOLES_SKILL;

  constructor() {
    super({
      _name: WormholesModule._name,
    });
  }

  async _broadcast(xcmd: XCommand) {
    try {
      const params = _xu.ensure_params(xcmd?._params) as Record<string, unknown>;

      const app_id = read_required_string(params, "_app_id", "E_WH_INVALID_SCOPE");
      const env = read_optional_env(params);
      const event = read_required_string(params, "_event", "E_WH_INVALID_EVENT");
      const payload = params._payload;

      // TODO: Add authorization/capability checks here before allowing external
      // callers to execute wormholes.broadcast through transport-originated XCommands.
      const delivered = wsBroadcastScoped(app_id, env, {
        _name: event,
        ...(payload !== undefined ? { _args: [payload] } : {}),
      });

      _xlog.log("[WH] xmodule broadcast", {
        _app_id: app_id,
        _env: env,
        _event: event,
        _delivered: delivered,
      });

      return new XResponseOK({
        _delivered: delivered,
        _app_id: app_id,
        _env: env,
        _event: event,
      }).toXData();
    } catch (err) {
      _xlog.warn("[WH] xmodule broadcast rejected", {
        _error:
          err instanceof Error
            ? err.message
            : typeof err === "object" && err !== null && "_message" in err
              ? (err as any)._message
              : String(err),
      });
      return new XResponseError(err).toXData();
    }
  }
}

export default WormholesModule;
