/**
 * Wormholes v2 — Session (xnode)
 *
 * Represents connection/session state for a single Wormholes transport link.
 * Used by both WS server connections and (optionally) WS client connections.
 *
 * Rules:
 * - Store only protocol/session state here (sid/auth/meta/pending).
 * - Do NOT store transport objects here (ws, req, res). Transport owns those.
 * - Pending map is for REQ/RES correlation (client-side call()).
 */

import type { XResponseData } from "xpell-core";
import type { WHAuthState, WHConnMeta, WHRoute, WHRes } from "./wh.types.js";
import { whTimeout } from "./wh.errors.js";

/* -------------------------------------------------------------------------- */
/* Pending (client-side correlation)                                           */
/* -------------------------------------------------------------------------- */

export type WHPendingEntry = {
  _ts: number;
  _timeout_ms: number;
  _resolve: (res: WHRes) => void;
  _reject: (err: any) => void;
};

export type WHPendingMap = Map<string, WHPendingEntry>;

/* -------------------------------------------------------------------------- */
/* Session                                                                     */
/* -------------------------------------------------------------------------- */

export class WHSession {
  readonly _id: string; // local session instance id (not protocol sid)

  // Protocol session id (after AUTH)
  _sid?: string;

  // Auth state (server assigns)
  _auth: WHAuthState = { _authenticated: false };

  // Connection meta (optional)
  _meta: WHConnMeta = {};

  // Route hints (optional)
  _route?: WHRoute;

  // Liveness
  _created_at: number = Date.now();
  _last_seen: number = Date.now();

  // Pending REQ correlation (client mode)
  protected _pending: WHPendingMap = new Map();

  constructor(local_id: string) {
    this._id = local_id;
  }

  /* ------------------------------------------------------------------------ */
  /* Liveness                                                                 */
  /* ------------------------------------------------------------------------ */

  touch(): void {
    this._last_seen = Date.now();
  }

  /* ------------------------------------------------------------------------ */
  /* Auth                                                                      */
  /* ------------------------------------------------------------------------ */

  setAuth(auth: Partial<WHAuthState>): void {
    this._auth = {
      ...this._auth,
      ...(auth ?? {}),
    };
  }

  setSid(sid?: string): void {
    if (sid) this._sid = sid;
  }

  /* ------------------------------------------------------------------------ */
  /* Pending (client-side)                                                     */
  /* ------------------------------------------------------------------------ */

  /**
   * Register a pending request (REQ.id).
   * Returns a cleanup function (call on success/failure).
   */
  addPending(
    rid: string,
    resolve: (res: WHRes) => void,
    reject: (err: any) => void,
    timeout_ms: number
  ): () => void {
    const entry: WHPendingEntry = {
      _ts: Date.now(),
      _timeout_ms: timeout_ms,
      _resolve: resolve,
      _reject: reject,
    };

    this._pending.set(rid, entry);

    return () => {
      this._pending.delete(rid);
    };
  }

  /**
   * Resolve a pending request by rid.
   * Returns true if resolved.
   */
  resolvePending(res: WHRes): boolean {
    const rid = res?._rid;
    if (!rid) return false;

    const entry = this._pending.get(rid);
    if (!entry) return false;

    this._pending.delete(rid);
    entry._resolve(res);
    return true;
  }

  /**
   * Reject all pending requests (e.g., connection closed).
   */
  rejectAllPending(reason: any): void {
    for (const [rid, entry] of this._pending.entries()) {
      try {
        entry._reject(reason);
      } catch {
        // ignore
      }
      this._pending.delete(rid);
    }
  }

  /**
   * Sweep timeouts for pending entries.
   * Call periodically from transport (client).
   */
  sweepTimeouts(now_ms: number = Date.now()): void {
    for (const [rid, entry] of this._pending.entries()) {
      const age = now_ms - entry._ts;
      if (age > entry._timeout_ms) {
        this._pending.delete(rid);
        try {
          entry._reject(
            whTimeout("Wormholes request timeout", { _rid: rid, _timeout_ms: entry._timeout_ms })
          );
        } catch {
          // ignore
        }
      }
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Convenience                                                               */
  /* ------------------------------------------------------------------------ */

  isAuthenticated(): boolean {
    return this._auth?._authenticated === true;
  }

  clearanceLevel(): number {
    return typeof this._auth?._clearance_level === "number" ? this._auth._clearance_level : -1;
  }
}

export default WHSession;
