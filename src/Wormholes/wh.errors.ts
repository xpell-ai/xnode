/**
 * Wormholes v2 — Protocol Errors (xnode)
 *
 * Central place for Wormholes error codes and helpers.
 * Uses XError + XResponseData contract (via XResponse in protocol layer).
 *
 * Rules:
 * - Throw XError for protocol/gateway failures.
 * - Transport layers (WS/REST) catch and convert to XResponseData via XResponse.error().
 * - Keep this file platform-neutral (no ws/express imports).
 */

import {  XError,type XErrorLevel, type XErrorMeta } from "@xpell/core";

/* -------------------------------------------------------------------------- */
/* Error Codes                                                                */
/* -------------------------------------------------------------------------- */

export const WH_ERR = {
  BAD_ENVELOPE: "E_WH_BAD_ENVELOPE",
  UNSUPPORTED_VERSION: "E_WH_UNSUPPORTED_VERSION",
  UNKNOWN_KIND: "E_WH_UNKNOWN_KIND",
  MISSING_RID: "E_WH_MISSING_RID",
  UNAUTHORIZED: "E_WH_UNAUTHORIZED",
  FORBIDDEN: "E_WH_FORBIDDEN",
  TIMEOUT: "E_WH_TIMEOUT",
  INTERNAL: "E_WH_INTERNAL",
} as const;

export type WHErrorCode = (typeof WH_ERR)[keyof typeof WH_ERR];

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function mk(
  code: WHErrorCode,
  message: string,
  opts?: { _level?: XErrorLevel; _meta?: XErrorMeta; _cause?: unknown }
): XError {
  return new XError(code, message, {
    _level: opts?._level ?? "error",
    _meta: opts?._meta,
    _cause: opts?._cause,
  });
}

/**
 * Envelope parsing / validation failures.
 */
export function whBadEnvelope(message: string, meta?: XErrorMeta, cause?: unknown): XError {
  return mk(WH_ERR.BAD_ENVELOPE, message, { _meta: meta, _cause: cause, _level: "warn" });
}

/**
 * Version mismatch (client/server not aligned).
 */
export function whUnsupportedVersion(got: any, expected: number): XError {
  return mk(
    WH_ERR.UNSUPPORTED_VERSION,
    `Unsupported wormholes protocol version: got=${String(got)} expected=${expected}`,
    { _meta: { got, expected }, _level: "warn" }
  );
}

/**
 * Unknown/unsupported message kind.
 */
export function whUnknownKind(kind: any): XError {
  return mk(
    WH_ERR.UNKNOWN_KIND,
    `Unknown wormholes message kind: ${String(kind)}`,
    { _meta: { kind }, _level: "warn" }
  );
}

/**
 * RES without _rid.
 */
export function whMissingRid(meta?: XErrorMeta): XError {
  return mk(WH_ERR.MISSING_RID, "Missing _rid on RES envelope", { _meta: meta, _level: "warn" });
}

/**
 * Auth required.
 */
export function whUnauthorized(message = "Unauthorized", meta?: XErrorMeta): XError {
  return mk(WH_ERR.UNAUTHORIZED, message, { _meta: meta, _level: "warn" });
}

/**
 * Auth ok but insufficient clearance.
 */
export function whForbidden(message = "Forbidden", meta?: XErrorMeta): XError {
  return mk(WH_ERR.FORBIDDEN, message, { _meta: meta, _level: "warn" });
}

/**
 * Request timeout (usually client-side).
 */
export function whTimeout(message = "Request timed out", meta?: XErrorMeta): XError {
  return mk(WH_ERR.TIMEOUT, message, { _meta: meta, _level: "warn" });
}

/**
 * Unexpected internal failure.
 */
export function whInternal(message = "Internal wormholes error", cause?: unknown, meta?: XErrorMeta): XError {
  return mk(WH_ERR.INTERNAL, message, { _meta: meta, _cause: cause, _level: "error" });
}
