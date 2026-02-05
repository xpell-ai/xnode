/**
 * Wormholes v2 — Gateway (xnode)
 *
 * The gateway is the ONLY place that:
 * - validates high-level protocol intent (kind gating)
 * - performs AUTH decisions
 * - executes REQ payloads via _x.execute()
 * - returns RES payloads as XResponseData (protocol envelope)
 *
 * Transports (WS/REST) should:
 * - parseEnvelope(raw)
 * - pass env + ctx into handleEnvelope()
 * - send back the returned envelope (if not null)
 *
 * Rules:
 * - Keep transport-agnostic (no ws/express imports).
 * - Inject connection/session metadata into XCmd._params (snake_case keys).
 * - Errors are always normalized to XError.toXData() inside XResponseData._result.
 */

import { _x } from "@xpell/core";
import {XError} from "@xpell/core";

import type { XResponseData } from "@xpell/core";

import type {
  WHAny,
  WHEnvelope,
  WHHelloPayload,
  WHAuthPayload,
  WHReq,
  WHRes,
  WHContext,
  XCmd,
  WHEventPayload,
} from "./wh.types.js";

import { makeHello, makeRes, makeEnvelope } from "./wh.codec.js";
import {
  whUnauthorized,
  whForbidden,
  whUnknownKind,
  whInternal,
  whBadEnvelope,
} from "./wh.errors.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type WHAuthResult = {
  _authenticated: boolean;

  // optional session id (recommended for WS)
  _sid?: string;

  // optional identity + clearance
  _clearance_level?: number;
  _user_id?: string;
  _agent_id?: string;

  // extra payload returned to client in AUTH RES
  _result?: any;
};

export type WHGatewayOptions = {
  _node?: string;          // server node name/id
  _xpell?: string;         // xpell version (optional)
  _caps?: string[];        // hello caps override
  _require_auth?: boolean; // default true

  /**
   * AUTH handler for your environment.
   * Return {_authenticated:false} to reject.
   */
  _auth?: (payload: WHAuthPayload, ctx: WHContext) => Promise<WHAuthResult> | WHAuthResult;

  /**
   * Optional policy hook: called before executing REQ.
   * Throw XError to block.
   */
  _authorize_req?: (cmd: XCmd, ctx: WHContext) => Promise<void> | void;

  /**
   * Optional: allow inbound EVT from peers (default false).
   */
  _allow_inbound_evt?: boolean;
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function now(): number {
  return Date.now();
}

function isXResponseData(v: any): v is XResponseData {
  return v && typeof v === "object" && typeof v._ok === "boolean" && "_result" in v;
}

function ok(result: any, started_at: number): XResponseData {
  const ts = started_at || now();
  return {
    _ok: true,
    _ts: ts,
    _pt: now() - ts,
    _result: result,
  };
}

function err(error: any, started_at: number): XResponseData {
  const ts = started_at || now();

  const xe =
    error instanceof XError
      ? error
      : new XError("E_INTERNAL", error?.message ?? String(error), { _cause: error });

  return {
    _ok: false,
    _ts: ts,
    _pt: now() - ts,
    _result: xe.toXData(),
  };
}

function ensureParams(cmd: XCmd): Record<string, any> {
  if (!cmd._params || typeof cmd._params !== "object") cmd._params = {};
  return cmd._params;
}

function injectMeta(cmd: XCmd, ctx: WHContext): XCmd {
  const p = ensureParams(cmd);

  // Snake_case contract keys for command params (xpell convention)
  if (ctx?._meta?._wid) p._wid = ctx._meta._wid;
  if (ctx?._sid) p._sid = ctx._sid;

  // optional routing hints
  if (ctx?._route?._from) p._from = ctx._route._from;
  if (ctx?._route?._to) p._to = ctx._route._to;

  return cmd;
}

function requireAuthed(opts: WHGatewayOptions, ctx: WHContext): void {
  const require_auth = opts._require_auth !== false; // default true
  if (!require_auth) return;

  if (!ctx?._auth?._authenticated) {
    throw whUnauthorized("AUTH required");
  }
}

/* -------------------------------------------------------------------------- */
/* Gateway                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Handle a single envelope and return an optional response envelope.
 * - Returns null when no response should be sent.
 */
export async function handleEnvelope(
  env: WHAny,
  ctx: WHContext,
  opts: WHGatewayOptions
): Promise<WHEnvelope<any> | null> {
  try {
    switch (env._kind) {
      case "HELLO": {
        // In most flows server sends HELLO proactively.
        // If a peer sends HELLO, we reply with HELLO too (harmless).
        const helloPayload: Partial<WHHelloPayload> = {
          _node: opts._node,
          _xpell: opts._xpell,
          _caps: opts._caps ?? ["reqres", "evt", "ping", "rest"],
        };
        return makeHello(helloPayload as any, { _sid: ctx?._sid, _from: env._to, _to: env._from });
      }

      case "PING": {
        // Return PONG (no XResponse envelope needed)
        const sent_ts = env?._payload?._ts;
        const rtt = typeof sent_ts === "number" ? now() - sent_ts : undefined;
        return makeEnvelope("PONG", { _ts: now(), _rtt_ms: rtt }, { _sid: ctx?._sid });
      }

      case "PONG": {
        // Usually client-side only. Server can ignore.
        return null;
      }

      case "AUTH": {
        const started = now();
        const payload = env._payload as WHAuthPayload | undefined;

        if (!opts._auth) {
          // No auth configured: reject hard (security default)
          const xres = err(whUnauthorized("AUTH not supported on this node"), started);
          return makeRes(env._id, xres);
        }

        const out = await opts._auth(payload ?? {}, ctx);

        if (!out || out._authenticated !== true) {
          ctx._auth = { _authenticated: false };
          const xres = err(whUnauthorized("Invalid credentials"), started);
          return makeRes(env._id, xres);
        }

        // commit auth into ctx
        ctx._auth = {
          _authenticated: true,
          _clearance_level: out._clearance_level,
          _user_id: out._user_id,
          _agent_id: out._agent_id,
        };

        if (out._sid) ctx._sid = out._sid;

        const result_payload = {
          _sid: ctx._sid,
          _clearance_level: out._clearance_level,
          _user_id: out._user_id,
          _agent_id: out._agent_id,
          ...(out._result ? { _data: out._result } : {}),
        };

        const xres = ok(result_payload, started);
        return makeRes(env._id, xres);
      }

      case "REQ": {
        requireAuthed(opts, ctx);

        const started = now();

        const req = env as WHReq;
        const cmd = req._payload as XCmd;

        if (!cmd || typeof cmd !== "object" || typeof cmd._module !== "string" || typeof cmd._op !== "string") {
          const xres = err(whBadEnvelope("REQ payload must be XCmd", { _payload: req._payload }), started);
          return makeRes(req._id, xres);
        }

        // inject transport/session meta
        injectMeta(cmd, ctx);

        // optional authz hook
        if (opts._authorize_req) {
          await opts._authorize_req(cmd, ctx);
        }

        try {
          const out = await _x.execute(cmd as any);

          // If _x.execute already returns XResponseData, pass it through.
          // Otherwise wrap raw result as ok().
          const xres = isXResponseData(out) ? (out as XResponseData) : ok(out, started);

          // If pass-through, ensure _pt at least exists (legacy safety).
          if (typeof xres._pt !== "number") xres._pt = now() - started;

          return makeRes(req._id, xres);
        } catch (e) {
          const xres = err(e, started);
          return makeRes(req._id, xres);
        }
      }

      case "RES": {
        // Server usually shouldn't receive RES (client-side concern).
        // Ignore by default.
        return null;
      }

      case "EVT": {
        // Inbound EVT from peers is disabled by default.
        if (opts._allow_inbound_evt !== true) {
          throw whForbidden("Inbound EVT not allowed");
        }

        // If you enable inbound EVT, you can handle it here (or route to _xem).
        // For now, acknowledge with RES(ok) so callers can debug.
        const started = now();
        const payload = env._payload as WHEventPayload | undefined;
        const xres = ok({ _accepted: true, _event: payload?._name }, started);
        return makeRes(env._id, xres);
      }

      default:
        throw whUnknownKind((env as any)?._kind);
    }
  } catch (e) {
    // If we can correlate, answer as RES. Otherwise return null.
    const started = now();

    // Try to respond with RES for REQ/AUTH/EVT/HELLO/PING kinds that have _id
    const rid = (env as any)?._id;
    if (typeof rid === "string" && rid.length) {
      const xres = err(e, started);
      return makeRes(rid, xres);
    }

    // nothing to reply with
    return null;
  }
}
