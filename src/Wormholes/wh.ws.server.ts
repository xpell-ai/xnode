/**
 * Wormholes v2 — WebSocket Server Transport (xnode)
 *
 * Responsibilities:
 * - Accept WS connections
 * - Create a WHSession + WHContext per connection
 * - Send HELLO on connect
 * - Parse incoming envelopes and route them to gateway.handleEnvelope()
 * - Send returned envelopes back to the peer
 *
 * Rules:
 * - No business logic here (no _x.execute). That lives in wh.gateway.ts.
 * - Always catch errors and respond with RES when possible.
 */

import type http from "node:http";
import WebSocket, { WebSocketServer } from "ws";

import { _xlog, _xu } from "@xpell/core";

import type { WHContext, WHEnvelope, WHEvt, WHEventPayload } from "./wh.types.js";
import { parseEnvelope, stringifyEnvelope, makeHello, makeEvt } from "./wh.codec.js";
import { handleEnvelope, type WHGatewayOptions } from "./wh.gateway.js";
import WHSession from "./wh.session.js";
import { whInternal } from "./wh.errors.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type WHWSServerOptions = WHGatewayOptions & {
  _path?: string;
  _max_payload_bytes?: number;
  _log_connect?: boolean;
  _log_messages?: boolean;
};

export type WHWSConn = {
  _ws: WebSocket;
  _session: WHSession;
  _ctx: WHContext;
};

type WHScope = {
  _app_id?: string;
  _env?: string;
};

/* -------------------------------------------------------------------------- */
/* Connection Registry                                                        */
/* -------------------------------------------------------------------------- */

const connections = new Map<string, WHWSConn>();

function getWid(conn: WHWSConn): string | undefined {
  return conn._ctx._meta?._wid;
}

function isOpen(ws: WebSocket): boolean {
  return ws.readyState === WebSocket.OPEN;
}

function getBearerToken(header: unknown): string | undefined {
  if (!header) return undefined;
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== "string") return undefined;
  const match = value.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function safeMetaForLog(meta: WHContext["_meta"]): WHContext["_meta"] {
  if (!meta) return meta;
  const { _token, ...safe_meta } = meta;
  return safe_meta;
}

/* -------------------------------------------------------------------------- */
/* Server                                                                     */
/* -------------------------------------------------------------------------- */

export function createWormholesWSServer(
  server: http.Server,
  opts: WHWSServerOptions
): WebSocketServer {
  const ws_path = opts._path ?? "/wh/v2";
  const maxPayload = opts._max_payload_bytes ?? 50 * 1024 * 1024;
  const logConnect = opts._log_connect !== false;
  const logMessages = opts._log_messages === true;

  const wss = new WebSocketServer({
    server,
    path: ws_path,
    maxPayload,
  });

  wss.on("connection", (ws: WebSocket, req) => {
    const wid = _xu.guid();
    const sid_local = _xu.guid();
    const session = new WHSession(sid_local);
    const token = getBearerToken(req?.headers?.authorization);

    const ctx: WHContext = {
      _sid: session._sid,
      _auth: { _authenticated: false },
      _meta: {
        _wid: wid,
        _user_agent: req?.headers?.["user-agent"] as string | undefined,
        _ip: (req?.socket?.remoteAddress as string | undefined) ?? undefined,
        ...(token ? { _token: token } : {}),
      },
      _route: {
        _from: { _client: "ws" },
        _to: opts._node ? { _node: opts._node } : undefined,
      },
    };

    const conn: WHWSConn = { _ws: ws, _session: session, _ctx: ctx };
    connections.set(wid, conn);

    if (logConnect) {
      _xlog.log(`[WH/WS] connect wid=${wid} ip=${ctx._meta?._ip ?? "-"} ua=${ctx._meta?._user_agent ?? "-"}`);
    }

    try {
      const hello = makeHello(
        {
          _node: opts._node,
          _xpell: opts._xpell,
          _caps: opts._caps ?? ["reqres", "evt", "ping", "ws"],
        } as any,
        { _sid: session._sid }
      );

      ws.send(stringifyEnvelope(hello));
    } catch (e) {
      _xlog.error("[WH/WS] failed to send HELLO", e);
    }

    ws.on("message", async (data: WebSocket.RawData) => {
      session.touch();

      let raw: string;
      try {
        raw = typeof data === "string" ? data : data.toString("utf8");
      } catch (e) {
        _xlog.error("[WH/WS] message decode error", e);
        return;
      }

      if (logMessages) _xlog.log("[WH/WS] <-", raw.slice(0, 500));

      try {
        const env = parseEnvelope(raw);

        if (session._sid) ctx._sid = session._sid;

        const out = await handleEnvelope(env, ctx, opts);

        if (ctx._sid) session.setSid(ctx._sid);
        if (ctx._auth) session.setAuth(ctx._auth);

        if (!out) return;

        const outStr = stringifyEnvelope(out as WHEnvelope<any>);
        if (logMessages) _xlog.log("[WH/WS] ->", outStr.slice(0, 500));

        ws.send(outStr);
      } catch (e) {
        try {
          const evt: WHEvt = makeEvt(
            {
              _name: "wh.error",
              _args: [whInternal("WS message handling failed", e).toXData()],
            } as WHEventPayload,
            { _sid: session._sid }
          );

          ws.send(stringifyEnvelope(evt));
        } catch (e2) {
          _xlog.error("[WH/WS] fatal error sending wh.error evt", e2);
        }
      }
    });

    ws.once("close", (code, reason) => {
      session.rejectAllPending({
        _code: "E_WH_CLOSED",
        _reason: reason?.toString?.() ?? "",
        _ws_code: code,
      });

      connections.delete(wid);

      if (logConnect) {
        _xlog.log(`[WH/WS] close wid=${wid} code=${code} reason=${reason?.toString?.() ?? ""}`);
      }
    });

    ws.on("error", (err) => {
      _xlog.error(`[WH/WS] error wid=${wid}`, err);
    });
  });

  return wss;
}

/* -------------------------------------------------------------------------- */
/* Registry Helpers                                                           */
/* -------------------------------------------------------------------------- */

export function wsGetConn(wid: string): WHWSConn | undefined {
  return connections.get(wid);
}

export function wsGetConnections(): WHWSConn[] {
  return Array.from(connections.values());
}

export function wsSetScope(wid: string, scope: WHScope): boolean {
  const conn = connections.get(wid);
  if (!conn) return false;

  const meta = (conn._ctx._meta ??= {}) as WHContext["_meta"] & WHScope;

  if (scope._app_id !== undefined) meta._app_id = scope._app_id;
  if (scope._env !== undefined) meta._env = scope._env;

  return true;
}

/* -------------------------------------------------------------------------- */
/* Server Push Helpers                                                        */
/* -------------------------------------------------------------------------- */

export function wsSendEvt(ws: WebSocket, payload: WHEventPayload, sid?: string): void {
  if (!isOpen(ws)) return;

  const evt = makeEvt(payload, { _sid: sid });
  ws.send(stringifyEnvelope(evt));
}

export function wsSendToWid(wid: string, payload: WHEventPayload): boolean {
  const conn = connections.get(wid);
  if (!conn) return false;

  wsSendEvt(conn._ws, payload, conn._ctx._sid);
  return true;
}

export function wsBroadcastScoped(
  app_id: string,
  env: string,
  payload: WHEventPayload,
  opts: { _exclude_wid?: string } = {}
): number {
  let sent = 0;
  _xlog.log("[WH] broadcastScoped", {
    _app_id: app_id,
    _env: env,
    _connections: connections.size
  });
  for (const conn of connections.values()) {

    const wid = getWid(conn);
    if (opts._exclude_wid && wid === opts._exclude_wid) continue;

    const meta = conn._ctx._meta as (WHContext["_meta"] & WHScope) | undefined;

    if (meta?._app_id === app_id && meta?._env === env) {
      wsSendEvt(conn._ws, payload, conn._ctx._sid);
      sent++;
    }
    _xlog.log("[WH] checking conn", {
      wid,
      meta: safeMetaForLog(conn._ctx._meta)
    });
  }

  return sent;
}

export function wsBroadcastAll(
  payload: WHEventPayload,
  opts: { _exclude_wid?: string } = {}
): number {
  let sent = 0;

  for (const conn of connections.values()) {
    const wid = getWid(conn);
    if (opts._exclude_wid && wid === opts._exclude_wid) continue;

    wsSendEvt(conn._ws, payload, conn._ctx._sid);
    sent++;
  }

  return sent;
}
