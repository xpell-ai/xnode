/**
 * Wormholes v2 — REST Router (xnode)
 *
 * REST is a transport for Wormholes v2 request/response.
 * It reuses the SAME protocol envelope + SAME gateway as WebSocket.
 *
 * Supported endpoints (recommended):
 * - GET  /wh/v2/hello     -> returns WH HELLO envelope (no auth required)
 * - POST /wh/v2/auth      -> AUTH envelope in body, returns RES envelope
 * - POST /wh/v2/call      -> REQ envelope in body, returns RES envelope
 *
 * Notes:
 * - REST does NOT support server->client EVT push (use WS for that).
 * - Auth can be:
 *   - stateless: Authorization: Bearer <token> (recommended for REST)
 *   - or session: return _sid from /auth and client passes x-wormholes-sid header
 */

import type { Request, Response, Router } from "express";
import express from "express";

import { _xlog } from "@xpell/core";

import type { WHAny, WHContext, WHEnvelope } from "./wh.types.js";
import { parseEnvelope, stringifyEnvelope, makeHello } from "./wh.codec.js";
import { handleEnvelope, type WHGatewayOptions } from "./wh.gateway.js";
import { whBadEnvelope, whInternal } from "./wh.errors.js";

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function getBearerToken(req: Request): string | undefined {
    const h = req.headers["authorization"];
    if (!h) return undefined;
    const s = Array.isArray(h) ? h[0] : h;
    const m = s.match(/^Bearer\s+(.+)$/i);
    return m?.[1];
}

function getCookieToken(req: Request, name: string | undefined): string | undefined {
    if (!name) return undefined;
    const header = req.headers.cookie;
    if (typeof header !== "string" || !header.trim()) return undefined;

    for (const part of header.split(";")) {
        const separator = part.indexOf("=");
        if (separator < 0) continue;

        const key = part.slice(0, separator).trim();
        if (key !== name) continue;

        const raw = part.slice(separator + 1).trim();
        try {
            return decodeURIComponent(raw);
        } catch {
            return raw;
        }
    }

    return undefined;
}

function getSid(req: Request): string | undefined {
    const h = req.headers["x-wormholes-sid"];
    if (!h) return undefined;
    return Array.isArray(h) ? h[0] : h;
}

function getHeaderValue(value: unknown): string | undefined {
    const header = Array.isArray(value) ? value[0] : value;
    return typeof header === "string" && header.trim() ? header.trim() : undefined;
}

function getForwardedFirst(value: string | undefined): string | undefined {
    return value?.split(",")[0]?.trim() || undefined;
}

function mkCtx(req: Request, opts: WHGatewayOptions): WHContext {
    const token = getBearerToken(req) ?? getCookieToken(req, opts._auth_cookie_name);
    const sid = getSid(req);
    const forwarded_proto = getForwardedFirst(getHeaderValue(req.headers["x-forwarded-proto"]));
    const forwarded_host = getForwardedFirst(getHeaderValue(req.headers["x-forwarded-host"]));

    return {
        _sid: sid,
        _auth: {
            // Resolved per REQ from bearer/cookie token before gateway execution.
            _authenticated: false,
        },
        _meta: {
            _wid:
                (req.headers["x-request-id"] as string | undefined) ??
                (req.headers["x-correlation-id"] as string | undefined),
            _user_agent: req.headers["user-agent"] as string | undefined,
            _ip: req.ip,
            _host: getHeaderValue(req.headers.host),
            _protocol: forwarded_proto === "https" || forwarded_proto === "http" ? forwarded_proto : req.protocol,
            _origin: getHeaderValue(req.headers.origin),
            _x_forwarded_host: forwarded_host,
            _x_forwarded_proto: forwarded_proto,
            ...(token ? { _token: token } : {}),
        },

        _route: {
            _from: { _client: "rest" },
            _to: opts._node ? { _node: opts._node } : undefined,
        },
    };
}

async function resolveReqAuth(env: WHAny, ctx: WHContext, opts: WHGatewayOptions): Promise<void> {
    if (!opts._auth) return;

    const env_token = typeof env._token === "string" && env._token.trim()
        ? env._token.trim()
        : undefined;
    const token = env_token ?? ctx._meta?._token;
    if (!token) return;

    try {
        const auth = await opts._auth({ _token: token }, ctx);
        ctx._auth = auth?._authenticated === true
            ? {
                _authenticated: true,
                _clearance_level: auth._clearance_level,
                _user_id: auth._user_id,
                _account_id: auth._account_id,
                _agent_id: auth._agent_id,
                _auth_type: auth._auth_type,
            }
            : { _authenticated: false };
        if (auth?._sid) ctx._sid = auth._sid;
    } catch {
        ctx._auth = { _authenticated: false };
    }
}

/**
 * Read JSON body safely. Supports:
 * - already parsed object (express.json)
 * - string body
 */
function getBody(req: Request): any {
    return (req as any).body;
}

/* -------------------------------------------------------------------------- */
/* Router                                                                     */
/* -------------------------------------------------------------------------- */

export type WHRestRouterOptions = WHGatewayOptions & {
    _base_path?: string; // default "/wh/v2"
    _log?: boolean;      // default true
};

/**
 * Create an Express router implementing Wormholes v2 over REST.
 */
export function createWormholesRestRouter(opts: WHRestRouterOptions): Router {
    const base = opts._base_path ?? "/wh/v2";
    const log = opts._log !== false;

    const r = express.Router();

    // Ensure JSON parsing (caller can also apply globally)
    r.use(express.json({ limit: "10mb" }));

    /* --------------------------------- HELLO -------------------------------- */

    r.get(`${base}/hello`, (req: Request, res: Response) => {
        try {
            const hello = makeHello(
                {
                    _node: opts._node,
                    _xpell: opts._xpell,
                    _caps: opts._caps ?? ["reqres", "ping", "rest"],
                } as any
            );
            res.status(200).type("application/json").send(stringifyEnvelope(hello));
        } catch (e) {
            const xe = whInternal("REST /hello failed", e);
            res.status(500).json({ _ok: false, _result: xe.toXData() });
        }
    });

    /* ---------------------------------- AUTH -------------------------------- */

    r.post(`${base}/auth`, async (req: Request, res: Response) => {
        const ctx = mkCtx(req, opts);

        try {
            const raw = getBody(req);
            const env = parseEnvelope(raw) as WHAny;

            if (env._kind !== "AUTH") {
                throw whBadEnvelope("Expected AUTH envelope", { got: env._kind });
            }

            const out = await handleEnvelope(env, ctx, opts);

            if (!out) {
                res.status(204).end();
                return;
            }

            res.status(200).type("application/json").send(stringifyEnvelope(out as WHEnvelope<any>));
        } catch (e: any) {
            if (log) _xlog.error("[WH/REST] /auth error", e);
            // best-effort protocol-shaped error
            const xe = e?.toXData ? e : whInternal("REST /auth failed", e);
            res.status(400).json({ _ok: false, _result: xe.toXData ? xe.toXData() : xe });
        }
    });

    /* ---------------------------------- CALL -------------------------------- */

    r.post(`${base}/call`, async (req: Request, res: Response) => {
        const ctx = mkCtx(req, opts);

        try {
            const raw = getBody(req);
            const env = parseEnvelope(raw) as WHAny;

            if (env._kind !== "REQ") {
                throw whBadEnvelope("Expected REQ envelope", { got: env._kind });
            }

            await resolveReqAuth(env, ctx, opts);

            const out = await handleEnvelope(env, ctx, opts);

            if (!out) {
                res.status(204).end();
                return;
            }

            res.status(200).type("application/json").send(stringifyEnvelope(out as WHEnvelope<any>));
        } catch (e: any) {
            if (log) _xlog.error("[WH/REST] /call error", e);
            const xe = e?.toXData ? e : whInternal("REST /call failed", e);
            res.status(400).json({ _ok: false, _result: xe.toXData ? xe.toXData() : xe });
        }
    });

    return r;
}

export default createWormholesRestRouter;
