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

import { _xlog } from "xpell-core";

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

function getSid(req: Request): string | undefined {
    const h = req.headers["x-wormholes-sid"];
    if (!h) return undefined;
    return Array.isArray(h) ? h[0] : h;
}

function mkCtx(req: Request, opts: WHGatewayOptions): WHContext {
    const token = getBearerToken(req);
    const sid = getSid(req);

    return {
        _sid: sid,
        _auth: {
            // For REST we can treat "has token" as "authenticated pending gateway AUTH"
            // But gateway currently requires ctx._auth._authenticated true for REQ.
            // So: if you use Bearer token as stateless auth, you should set _require_auth=false
            // and implement opts._authorize_req to validate token per request OR
            // implement a REST middleware that does AUTH per request and sets ctx._auth.
            _authenticated: false,
        },
        _meta: {
            _wid:
                (req.headers["x-request-id"] as string | undefined) ??
                (req.headers["x-correlation-id"] as string | undefined),
            _user_agent: req.headers["user-agent"] as string | undefined,
            _ip: req.ip,
        },

        _route: {
            _from: { _client: "rest" },
            _to: opts._node ? { _node: opts._node } : undefined,
        },
    };
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

            // IMPORTANT: For REST stateless auth, you probably want to:
            // - set opts._require_auth = false
            // - validate Authorization bearer token per request inside opts._authorize_req
            //
            // OR do a middleware that runs opts._auth and sets ctx._auth._authenticated=true
            // for each call.

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
