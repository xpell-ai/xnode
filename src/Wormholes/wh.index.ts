/**
 * Wormholes v2 — Public Entry (xnode)
 *
 * This file is the single public surface for Wormholes in xnode.
 * Other parts of the system should ONLY import from here.
 *
 * It wires together:
 * - Protocol types
 * - WS server transport
 * - WS client
 * - REST router
 *
 * Rules:
 * - Do not export internal helpers unless they are part of the public API.
 * - Keep this file thin and declarative.
 */

/* -------------------------------------------------------------------------- */
/* Types & Protocol                                                           */
/* -------------------------------------------------------------------------- */

export * from "./wh.types.js";
export * from "./wh.errors.js";

/* -------------------------------------------------------------------------- */
/* Core                                                                       */
/* -------------------------------------------------------------------------- */

export { handleEnvelope } from "./wh.gateway.js";
export type { WHGatewayOptions } from "./wh.gateway.js";

export {
  WormholesModule,
  WORMHOLES_OPS,
  WORMHOLES_SKILL,
  default as WormholesXModule,
} from "./WormholesModule.js";

/* -------------------------------------------------------------------------- */
/* Session                                                                    */
/* -------------------------------------------------------------------------- */

export { default as WHSession } from "./wh.session.js";

/* -------------------------------------------------------------------------- */
/* WebSocket                                                                  */
/* -------------------------------------------------------------------------- */

export { createWormholesWSServer, wsSendEvt , wsBroadcastScoped ,wsSetScope,wsGetConn,wsSendToWid,wsGetConnections,wsBroadcastAll} from "./wh.ws.server.js";
export type { WHWSServerOptions,WHWSConn } from "./wh.ws.server.js";

export { default as WHWSClient } from "./wh.ws.client.js";
export type { WHWSClientOptions, WHWSEventHandler } from "./wh.ws.client.js";

/* -------------------------------------------------------------------------- */
/* REST                                                                       */
/* -------------------------------------------------------------------------- */

export { createWormholesRestRouter } from "./wh.rest.router.js";
export type { WHRestRouterOptions } from "./wh.rest.router.js";
