/**
 * Wormholes v2 — WebSocket Client (xnode)
 *
 * Use-cases:
 * - xnode -> xnode
 * - xnode -> xpell-py (when python exposes WS wormholes v2)
 *
 * Features (v2 alpha):
 * - connect() + HELLO handling
 * - auth() (token-based)
 * - call() => REQ/RES correlation with pending map
 * - server-push EVT handler hook
 *
 * Rules:
 * - No business logic here. This is a protocol client.
 * - Uses WHSession pending map for REQ/RES.
 */

import WebSocket from "ws";
import { _xlog, _xu } from "@xpell/core";

import type { XResponseData } from "@xpell/core";
import type {
  WHAny,
  WHAuthPayload,
  WHContext,
  WHEventPayload,
  WHHelloPayload,
  WHRes,
  XCmd,
} from "./wh.types.js";

import { parseEnvelope, stringifyEnvelope, makeEnvelope, makeEvt } from "./wh.codec.js";
import WHSession from "./wh.session.js";
import { whTimeout, whUnauthorized, whInternal } from "./wh.errors.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type WHWSClientOptions = {
  _url: string;
  _node?: string; // local node/client name for routing hint
  _client?: string;
  _connect_timeout_ms?: number; // default 10s
  _call_timeout_ms?: number;    // default 30s
  _auto_reconnect?: boolean;    // default false (keep simple for alpha)
  _log?: boolean;               // default true
};

export type WHWSEventHandler = (evt: WHEventPayload) => void;

export class WHWSClient {
  readonly _id: string = _xu.guid();

  protected _opts: WHWSClientOptions;
  protected _ws: WebSocket | null = null;
  protected _session: WHSession;
  protected _ctx: WHContext;

  protected _hello?: WHHelloPayload;
  protected _on_evt?: WHWSEventHandler;

  protected _timer_sweep: any = null;

  constructor(opts: WHWSClientOptions) {
    this._opts = opts;
    this._session = new WHSession(_xu.guid());

    this._ctx = {
      _sid: undefined,
      _auth: { _authenticated: false },
      _meta: { _wid: this._id },
      _route: {
        _from: {
          _node: opts._node,
          _client: opts._client ?? "xnode-ws-client",
        },
      },
    };
  }

  /* ------------------------------------------------------------------------ */
  /* Hooks                                                                     */
  /* ------------------------------------------------------------------------ */

  onEvt(handler: WHWSEventHandler): this {
    this._on_evt = handler;
    return this;
  }

  /* ------------------------------------------------------------------------ */
  /* Lifecycle                                                                 */
  /* ------------------------------------------------------------------------ */

  async connect(): Promise<void> {
    if (this._ws && this._ws.readyState === WebSocket.OPEN) return;

    const log = this._opts._log !== false;

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this._opts._url, {
        maxPayload: 50 * 1024 * 1024, // 50MB default
      });

      this._ws = ws;

      const to = setTimeout(() => {
        try {
          ws.terminate();
        } catch {}
        reject(whTimeout("WS connect timeout", { _url: this._opts._url }));
      }, this._opts._connect_timeout_ms ?? 10_000);

      ws.onopen = () => {
        clearTimeout(to);
        if (log) _xlog.log(`[WH/WS:client] connected url=${this._opts._url}`);
        this._startSweep();
        resolve();
      };

      ws.onerror = (e: any) => {
        clearTimeout(to);
        reject(whInternal("WS connect error", e, { _url: this._opts._url }));
      };

      ws.onclose = () => {
        clearTimeout(to);
        this._stopSweep();
        this._session.rejectAllPending({ _code: "E_WH_CLOSED", _url: this._opts._url });
      };

      ws.onmessage = (evt: any) => {
        const raw = typeof evt.data === "string" ? evt.data : evt.data?.toString?.("utf8") ?? "";
        this._handleIncoming(raw).catch((err) => {
          if (log) _xlog.error("[WH/WS:client] incoming error", err);
        });
      };
    });
  }

  close(): void {
    this._stopSweep();

    if (this._ws) {
      try {
        this._ws.removeAllListeners();
      } catch {}
      try {
        this._ws.terminate();
      } catch {}
      this._ws = null;
    }
  }

  isOpen(): boolean {
    return !!this._ws && this._ws.readyState === WebSocket.OPEN;
  }

  /* ------------------------------------------------------------------------ */
  /* Auth                                                                      */
  /* ------------------------------------------------------------------------ */

  async auth(payload: WHAuthPayload): Promise<XResponseData> {
    await this.connect();

    const resEnv = await this._callEnvelope<XResponseData>("AUTH", payload, {
      _call_timeout_ms: this._opts._call_timeout_ms ?? 30_000,
    });

    const xres = resEnv._payload as XResponseData;

    if (xres?._ok) {
      // expected: _result contains sid + clearance
      const sid = xres?._result?._sid;
      if (typeof sid === "string" && sid.length) {
        this._ctx._sid = sid;
        this._session.setSid(sid);
      }
      this._ctx._auth = {
        _authenticated: true,
        _clearance_level: xres?._result?._clearance_level,
        _user_id: xres?._result?._user_id,
        _agent_id: xres?._result?._agent_id,
      };
      this._session.setAuth(this._ctx._auth);
    } else {
      this._ctx._auth = { _authenticated: false };
      this._session.setAuth(this._ctx._auth);
    }

    return xres;
  }

  /* ------------------------------------------------------------------------ */
  /* Calls                                                                     */
  /* ------------------------------------------------------------------------ */

  async call(cmd: XCmd, timeout_ms?: number): Promise<XResponseData> {
    if (!this._ctx._auth._authenticated) {
      throw whUnauthorized("Client is not authenticated");
    }

    const resEnv = await this._callEnvelope<XResponseData>("REQ", cmd, {
      _call_timeout_ms: timeout_ms ?? (this._opts._call_timeout_ms ?? 30_000),
    });

    const xres = resEnv._payload as XResponseData;

    if (xres?._ok) return xres;
    throw xres?._result ?? xres;
  }

  /* ------------------------------------------------------------------------ */
  /* Internals                                                                 */
  /* ------------------------------------------------------------------------ */

  protected async _callEnvelope<TPayload>(
    kind: "REQ" | "AUTH",
    payload: any,
    opts?: { _call_timeout_ms: number }
  ): Promise<WHRes> {
    await this.connect();

    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      throw whInternal("WS not open", undefined, { _url: this._opts._url });
    }

    const timeout_ms = opts?._call_timeout_ms ?? 30_000;

    const env = makeEnvelope<any>(kind, payload, {
      _sid: this._ctx._sid,
      _from: this._ctx._route?._from,
    });

    const rid = env._id;

    return await new Promise<WHRes>((resolve, reject) => {
      const cleanup = this._session.addPending(
        rid,
        (res) => resolve(res),
        (err) => reject(err),
        timeout_ms
      );

      try {
        this._ws!.send(stringifyEnvelope(env));
      } catch (e) {
        cleanup();
        reject(whInternal("WS send failed", e));
      }
    });
  }

  protected async _handleIncoming(raw: string): Promise<void> {
    const env = parseEnvelope(raw) as WHAny;

    this._session.touch();

    switch (env._kind) {
      case "HELLO": {
        this._hello = env._payload as WHHelloPayload;
        return;
      }

      case "EVT": {
        const payload = env._payload as WHEventPayload | undefined;
        if (payload && this._on_evt) {
          try {
            this._on_evt(payload);
          } catch (e) {
            // Never crash client loop
            _xlog.error("[WH/WS:client] EVT handler error", e);
          }
        }
        return;
      }

      case "RES": {
        const res = env as WHRes;
        // Resolve pending
        const resolved = this._session.resolvePending(res);
        if (!resolved) {
          // Unknown rid - ignore (or log)
          if (this._opts._log !== false) {
            _xlog.log("[WH/WS:client] RES with unknown _rid", res._rid);
          }
        }
        return;
      }

      case "PING": {
        // Reply PONG
        if (this._ws && this._ws.readyState === WebSocket.OPEN) {
          const pong = makeEnvelope("PONG", { _ts: Date.now() }, { _sid: this._ctx._sid });
          this._ws.send(stringifyEnvelope(pong));
        }
        return;
      }

      case "PONG":
      default:
        return;
    }
  }

  protected _startSweep(): void {
    if (this._timer_sweep) return;

    // Sweep timeouts once per second (cheap)
    this._timer_sweep = setInterval(() => {
      try {
        this._session.sweepTimeouts(Date.now());
      } catch {
        // ignore
      }
    }, 1000);
  }

  protected _stopSweep(): void {
    if (this._timer_sweep) {
      clearInterval(this._timer_sweep);
      this._timer_sweep = null;
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Optional: fire EVT (no response)                                          */
  /* ------------------------------------------------------------------------ */

  fireEvt(payload: WHEventPayload): void {
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) return;

    const evt = makeEvt(payload, { _sid: this._ctx._sid });
    try {
      this._ws.send(stringifyEnvelope(evt));
    } catch (e) {
      if (this._opts._log !== false) _xlog.error("[WH/WS:client] fireEvt failed", e);
    }
  }
}

export default WHWSClient;
