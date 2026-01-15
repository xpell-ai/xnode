/**
 * Wormholes v2 — Protocol Types (xnode)
 *
 * Transport-agnostic envelope used over WebSocket and REST.
 * - WS supports: HELLO/AUTH/REQ/RES/EVT/PING/PONG
 * - REST supports: REQ/RES (+ optional HELLO/AUTH endpoints)
 *
 * Design rules:
 * - Envelope is ALWAYS JSON (no "JSON inside JSON" strings).
 * - REQ.payload is an XCmd (input to _x.execute()).
 * - RES.payload is XResponseData (xpell-core response envelope).
 * - EVT.payload is an event payload using Xpell "_" naming convention.
 *
 * NOTE: Keep this file pure types. No Node/WS/Express imports.
 */

import type { XResponseData } from "xpell-core";

/* -------------------------------------------------------------------------- */
/* Versioning                                                                 */
/* -------------------------------------------------------------------------- */

export const WH_VERSION = 2 as const;
export type WHVersion = typeof WH_VERSION;

/* -------------------------------------------------------------------------- */
/* Kinds                                                                      */
/* -------------------------------------------------------------------------- */

export type WHKind =
  | "HELLO"
  | "AUTH"
  | "REQ"
  | "RES"
  | "EVT"
  | "PING"
  | "PONG";

/* -------------------------------------------------------------------------- */
/* Identity & Routing                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Optional identity fields for routing. Keep minimal for alpha.
 * Extend later without breaking the envelope shape.
 *
 * Xpell convention: underscore-prefixed fields.
 */
export type WHPeer = {
  _node?: string;   // xnode id/name
  _agent?: string;  // agent id/name
  _client?: string; // client id/name (web/app)
};

export type WHRoute = {
  _from?: WHPeer;
  _to?: WHPeer;
};

/* -------------------------------------------------------------------------- */
/* Payloads                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Canonical command payload for REQ (goes into _x.execute()).
 * `_params` MUST be an object when present.
 *
 * Xpell convention: underscore-prefixed fields.
 */
export type XCmd = {
  _module: string;
  _op: string;
  _params?: Record<string, any>;
};

/**
 * HELLO payload: server declares protocol + capabilities.
 *
 * Keep keys underscore-prefixed to match Xpell conventions.
 */
export type WHHelloPayload = {
  _protocol: "wormholes";
  _v: WHVersion;
  _node?: string;     // server node name/id
  _xpell?: string;    // xpell version (e.g. "2.0.0-alpha.0")
  _caps?: string[];   // e.g. ["reqres","evt","ping","rest"]
  _ts?: number;       // server timestamp (ms)
};

/**
 * AUTH request payload.
 * Minimal v2: token-based auth. Server returns sid in RES._result.
 */
export type WHAuthPayload = {
  _token?: string;
  _owner_entity_id?: string;

  // optional: xnode-to-xnode auth
  _server_name?: string;
  _server_token?: string;
};

/**
 * EVT payload: event name with optional args array.
 * Maps naturally to: _xem.fire(_name, ...(_args ?? []))
 */
export type WHEventPayload = {
  _name: string;
  _args?: any[];
};

/**
 * PING payload (optional).
 */
export type WHPingPayload = {
  _ts?: number;
  _msg?: string;
};

/**
 * PONG payload (optional).
 */
export type WHPongPayload = {
  _ts?: number;
  _rtt_ms?: number;
};

/* -------------------------------------------------------------------------- */
/* Envelope                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Wormholes v2 Envelope
 *
 * Required fields:
 * - _v, _id, _kind
 *
 * Correlation:
 * - RES MUST include _rid (request id it answers)
 *
 * Auth/session:
 * - _sid is returned by AUTH and then sent on REQ/EVT
 *
 * Timing/debug:
 * - _ts: send timestamp
 * - _trace: correlation id for logs
 *
 * Xpell convention: underscore-prefixed fields.
 */
export type WHEnvelope<TPayload = any> = WHRoute & {
  _v: WHVersion;
  _id: string;
  _kind: WHKind;

  // Correlation (RES -> _rid of REQ)
  _rid?: string;

  // Session / auth
  _sid?: string;
  _token?: string;

  // Debug / telemetry
  _ts?: number;
  _trace?: string;

  // Actual payload
  _payload?: TPayload;
};

/* -------------------------------------------------------------------------- */
/* Typed Envelopes (helpers)                                                  */
/* -------------------------------------------------------------------------- */

export type WHHello = WHEnvelope<WHHelloPayload> & { _kind: "HELLO" };
export type WHAuth = WHEnvelope<WHAuthPayload> & { _kind: "AUTH" };
export type WHReq = WHEnvelope<XCmd> & { _kind: "REQ" };
export type WHRes = WHEnvelope<XResponseData> & { _kind: "RES"; _rid: string };
export type WHEvt = WHEnvelope<WHEventPayload> & { _kind: "EVT" };
export type WHPing = WHEnvelope<WHPingPayload> & { _kind: "PING" };
export type WHPong = WHEnvelope<WHPongPayload> & { _kind: "PONG" };

export type WHAny = WHHello | WHAuth | WHReq | WHRes | WHEvt | WHPing | WHPong;

/* -------------------------------------------------------------------------- */
/* Options / Context Types (for gateway use)                                  */
/* -------------------------------------------------------------------------- */

/**
 * Connection/session auth state shared by WS + REST gateways.
 * Keep minimal; transport-specific details belong elsewhere.
 */
export type WHAuthState = {
  _authenticated: boolean;
  _clearance_level?: number;
  _user_id?: string;
  _agent_id?: string;
};

/**
 * Connection metadata (optional).
 */
export type WHConnMeta = {
  _wid?: string;        // connection id (ws) or request id (rest)
  _user_agent?: string;
  _ip?: string;
};

/**
 * Gateway context passed alongside envelope handling.
 */
export type WHContext = {
  _sid?: string;
  _auth: WHAuthState;
  _meta?: WHConnMeta;
  _route?: WHRoute;
};
