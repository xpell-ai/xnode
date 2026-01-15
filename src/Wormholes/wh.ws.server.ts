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

import { _xlog, _xu } from "xpell-core";

import type { WHContext, WHEnvelope, WHEvt, WHEventPayload } from "./wh.types.js";
import { parseEnvelope, stringifyEnvelope, makeHello, makeEvt } from "./wh.codec.js";
import { handleEnvelope, type WHGatewayOptions } from "./wh.gateway.js";
import WHSession from "./wh.session.js";
import { whInternal } from "./wh.errors.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type WHWSServerOptions = WHGatewayOptions & {
  _path?: string;                 // default "/wh/v2"
  _max_payload_bytes?: number;    // default 50MB
  _log_connect?: boolean;         // default true
  _log_messages?: boolean;        // default false
};

/**
 * Active WS connection handle.
 * Transport owns ws; session owns protocol state.
 */
export type WHWSConn = {
  _ws: WebSocket;
  _session: WHSession;
  _ctx: WHContext;
};

/* -------------------------------------------------------------------------- */
/* Server                                                                     */
/* -------------------------------------------------------------------------- */

export function createWormholesWSServer(
  server: http.Server,
  opts: WHWSServerOptions
): WebSocketServer {
  const path = opts._path ?? "/wh/v2";
  const maxPayload = opts._max_payload_bytes ?? 50 * 1024 * 1024; // 50MB
  const logConnect = opts._log_connect !== false;
  const logMessages = opts._log_messages === true;

  const wss = new WebSocketServer({
    server,
    path,
    maxPayload,
  });

  wss.on("connection", (ws: WebSocket, req) => {
    const wid = _xu.guid();
    const sid_local = _xu.guid(); // local session instance id
    const session = new WHSession(sid_local);

    const ctx: WHContext = {
      _sid: session._sid,
      _auth: { _authenticated: false },
      _meta: {
        _wid: wid,
        _user_agent: req?.headers?.["user-agent"] as string | undefined,
        _ip: (req?.socket?.remoteAddress as string | undefined) ?? undefined,
      },
      _route: {
        _from: { _client: "ws" }, // optional hint
        _to: opts._node ? { _node: opts._node } : undefined,
      },
    };

    const conn: WHWSConn = { _ws: ws, _session: session, _ctx: ctx };

    if (logConnect) {
      _xlog.log(`[WH/WS] connect wid=${wid} ip=${ctx._meta?._ip ?? "-"} ua=${ctx._meta?._user_agent ?? "-"}`);
    }

    // Send HELLO immediately
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

        // Sync ctx.sid with session (server may set it during AUTH)
        if (session._sid) ctx._sid = session._sid;

        const out = await handleEnvelope(env, ctx, opts);

        // If AUTH succeeded, gateway may have updated ctx._sid and ctx._auth
        if (ctx._sid) session.setSid(ctx._sid);
        if (ctx._auth) session.setAuth(ctx._auth);

        if (!out) return;

        const outStr = stringifyEnvelope(out as WHEnvelope<any>);
        if (logMessages) _xlog.log("[WH/WS] ->", outStr.slice(0, 500));

        ws.send(outStr);
      } catch (e) {
        // If parseEnvelope throws XError, we can't always correlate.
        // Best effort: send an EVT "wh.error" (non-fatal) so client sees it.
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
      session.rejectAllPending({ _code: "E_WH_CLOSED", _reason: reason?.toString?.() ?? "", _ws_code: code });
      if (logConnect) _xlog.log(`[WH/WS] close wid=${wid} code=${code} reason=${reason?.toString?.() ?? ""}`);
    });

    ws.on("error", (err) => {
      _xlog.error(`[WH/WS] error wid=${wid}`, err);
    });
  });

  return wss;
}

/* -------------------------------------------------------------------------- */
/* Server push helpers                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Send a server-initiated EVT on a specific websocket.
 * (Transport helper — you can also expose a higher-level API later.)
 */
export function wsSendEvt(ws: WebSocket, payload: WHEventPayload, sid?: string): void {
  const evt = makeEvt(payload, { _sid: sid });
  ws.send(stringifyEnvelope(evt));
}
