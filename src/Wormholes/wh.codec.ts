/**
 * Wormholes v2 — Codec (xnode)
 *
 * Responsibilities:
 * - Parse raw input (string/object) into a WHEnvelope
 * - Validate envelope shape (version/kind/required fields)
 * - Provide small constructors for common envelopes (HELLO/RES/EVT)
 *
 * Rules:
 * - Envelope is ALWAYS JSON object (no JSON-inside-JSON strings).
 * - Throw XError (from wh.errors.ts) on any invalid input.
 * - Keep transport-agnostic (no ws/express imports).
 */

import { _xu } from "../XNUtils/XUtils.js";
import type { XResponseData } from "xpell-core";

import {
  WH_VERSION,
  type WHAny,
  type WHEnvelope,
  type WHKind,
  type WHHello,
  type WHHelloPayload,
  type WHRes,
  type WHEvt,
  type WHEventPayload,
  type WHPeer,
} from "./wh.types.js";

import {
  whBadEnvelope,
  whUnsupportedVersion,
  whUnknownKind,
  whMissingRid,
} from "./wh.errors.js";

/* -------------------------------------------------------------------------- */
/* Guards                                                                      */
/* -------------------------------------------------------------------------- */

function isObj(v: any): v is Record<string, any> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isKind(v: any): v is WHKind {
  return (
    v === "HELLO" ||
    v === "AUTH" ||
    v === "REQ" ||
    v === "RES" ||
    v === "EVT" ||
    v === "PING" ||
    v === "PONG"
  );
}

/* -------------------------------------------------------------------------- */
/* Parse + Validate                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Parse raw JSON (string) or already-parsed object into WHEnvelope.
 * Throws XError on invalid input.
 */
export function parseEnvelope(raw: unknown): WHAny {
  let env: any = raw;

  if (typeof raw === "string") {
    try {
      env = JSON.parse(raw);
    } catch (e) {
      throw whBadEnvelope("Invalid JSON", { raw_preview: raw.slice(0, 200) }, e);
    }
  }

  if (!isObj(env)) {
    throw whBadEnvelope("Envelope must be an object", { typeof: typeof env });
  }

  assertEnvelope(env);

  return env as WHAny;
}

/**
 * Validate required fields and basic shape.
 * Throws XError on failures.
 */
export function assertEnvelope(env: any): asserts env is WHEnvelope<any> {
  if (!isObj(env)) throw whBadEnvelope("Envelope must be an object");

  // Required fields
  if (!("_v" in env)) throw whBadEnvelope("Missing required field: _v");
  if (!("_id" in env)) throw whBadEnvelope("Missing required field: _id");
  if (!("_kind" in env)) throw whBadEnvelope("Missing required field: _kind");

  if (env._v !== WH_VERSION) {
    throw whUnsupportedVersion(env._v, WH_VERSION);
  }

  if (typeof env._id !== "string" || env._id.length < 6) {
    throw whBadEnvelope("Invalid _id", { _id: env._id });
  }

  if (!isKind(env._kind)) {
    throw whUnknownKind(env._kind);
  }

  // RES must have _rid
  if (env._kind === "RES") {
    if (typeof env._rid !== "string" || env._rid.length < 6) {
      throw whMissingRid({ _rid: env._rid });
    }
  }

  // Optional but typed fields sanity checks
  if ("_sid" in env && env._sid != null && typeof env._sid !== "string") {
    throw whBadEnvelope("Invalid _sid", { _sid: env._sid });
  }
  if ("_token" in env && env._token != null && typeof env._token !== "string") {
    throw whBadEnvelope("Invalid _token", { _token: typeof env._token });
  }
  if ("_ts" in env && env._ts != null && typeof env._ts !== "number") {
    throw whBadEnvelope("Invalid _ts", { _ts: env._ts });
  }
  if ("_trace" in env && env._trace != null && typeof env._trace !== "string") {
    throw whBadEnvelope("Invalid _trace", { _trace: env._trace });
  }

  if ("_from" in env && env._from != null && !isObj(env._from)) {
    throw whBadEnvelope("Invalid _from", { _from: env._from });
  }
  if ("_to" in env && env._to != null && !isObj(env._to)) {
    throw whBadEnvelope("Invalid _to", { _to: env._to });
  }

  // payload can be any object; no deep validation here (gateway handles per-kind)
}

/* -------------------------------------------------------------------------- */
/* Constructors                                                                */
/* -------------------------------------------------------------------------- */

export function whId(): string {
  // Prefer Xpell's guid helper for consistency
  return _xu.guid();
}

/**
 * Create a basic envelope.
 */
export function makeEnvelope<T>(
  kind: WHKind,
  payload?: T,
  opts?: Partial<Omit<WHEnvelope<T>, "_v" | "_id" | "_kind" | "_payload">>
): WHEnvelope<T> {
  return {
    _v: WH_VERSION,
    _id: whId(),
    _kind: kind,
    _ts: Date.now(),
    ...(opts ?? {}),
    _payload: payload,
  };
}

/**
 * HELLO constructor.
 */
export function makeHello(payload: Omit<WHHelloPayload, "_protocol" | "_v"> & Partial<Pick<WHHelloPayload, "_caps" | "_node" | "_xpell" | "_ts">>, opts?: Partial<WHHello>): WHHello {
  const p: WHHelloPayload = {
    _protocol: "wormholes",
    _v: WH_VERSION,
    _node: payload._node,
    _xpell: payload._xpell,
    _caps: payload._caps ?? ["reqres", "evt", "ping"],
    _ts: payload._ts ?? Date.now(),
  };

  return {
    ...makeEnvelope("HELLO", p, opts),
    _kind: "HELLO",
  } as WHHello;
}

/**
 * RES constructor (wraps XResponseData).
 * IMPORTANT: caller must pass the rid it is answering.
 */
export function makeRes(rid: string, xres: XResponseData, opts?: Partial<WHRes>): WHRes {
  if (!rid || typeof rid !== "string") throw whMissingRid({ rid });
  return {
    ...makeEnvelope<XResponseData>("RES", xres, { ...(opts ?? {}), _rid: rid }),
    _kind: "RES",
    _rid: rid,
  };
}

/**
 * EVT constructor.
 */
export function makeEvt(payload: WHEventPayload, opts?: Partial<WHEvt>): WHEvt {
  if (!payload || typeof payload._name !== "string" || payload._name.length === 0) {
    throw whBadEnvelope("EVT payload missing _name", { payload });
  }
  if (payload._args != null && !Array.isArray(payload._args)) {
    throw whBadEnvelope("EVT payload _args must be an array when provided", { _args: payload._args });
  }
  return {
    ...makeEnvelope<WHEventPayload>("EVT", payload, opts),
    _kind: "EVT",
  } as WHEvt;
}

/* -------------------------------------------------------------------------- */
/* Serialization                                                               */
/* -------------------------------------------------------------------------- */

export function stringifyEnvelope(env: WHEnvelope<any>): string {
  // Keep deterministic + JSON-safe
  return JSON.stringify(env);
}

/* -------------------------------------------------------------------------- */
/* Optional helpers                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Lightweight peer helper.
 */
export function makePeer(p?: Partial<WHPeer>): WHPeer | undefined {
  if (!p) return undefined;
  const out: WHPeer = {};
  if (p._node) out._node = p._node;
  if (p._agent) out._agent = p._agent;
  if (p._client) out._client = p._client;
  return Object.keys(out).length ? out : undefined;
}
