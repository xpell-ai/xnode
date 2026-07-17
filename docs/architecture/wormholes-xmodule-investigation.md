# Wormholes XModule Boundary Investigation

Status: Facade implemented after investigation  
Scope: Define the smallest safe command-bus facade for server-side Wormholes broadcast  
Implementation state: Wormholes XModule facade implemented after the investigation  
Primary goal: Remove direct Wormholes imports from consumers such as XVibe without changing existing Wormholes APIs

Path references use monorepo-relative link text. Markdown targets are relative to this document in `packages/xnode/docs/architecture`.

## Implementation Status

Current status:

- Wormholes XModule implemented as `WormholesModule` with module name `wormholes`.
- V1 exposes only `_op: "broadcast"`.
- The facade delegates to the existing `wsBroadcastScoped(...)` implementation and does not create a WebSocket server, connection registry, or singleton.
- Existing Wormholes APIs and exports are preserved.
- No consumers have been migrated yet; ServerXVM, EntityManager, and XVibe still use their existing direct imports.

## 1. Executive Summary

Add a server-only `wormholes` XModule facade inside `@xpell/node`, but keep the existing direct Wormholes APIs and exports intact.

The smallest safe V1 surface is one trusted operation:

```ts
await _x.execute({
  _module: "wormholes",
  _op: "broadcast",
  _params: {
    _app_id: "my-app",
    _env: "default",
    _event: "vibe:generation-stage",
    _payload: {
      _app_id: "my-app",
      _env: "default",
      _stage: "planning"
    }
  }
});
```

V1 `broadcast` should be server-internal or trusted-module-only. It should not be callable by arbitrary browser/client-originated Wormholes `REQ` commands. Current `XWebServer` installs Wormholes with `_require_auth: false` in [`packages/xnode/src/XServer/XWebServer.ts:206`](../../src/XServer/XWebServer.ts#L206) and [`packages/xnode/src/XServer/XWebServer.ts:215`](../../src/XServer/XWebServer.ts#L215), so exposing broadcast through `_x.execute()` without an allowlist would let any reachable command client attempt cross-app realtime pushes.

The facade must delegate to the existing `wsBroadcastScoped(...)` helper exported from [`packages/xnode/src/Wormholes/wh.index.ts:42`](../../src/Wormholes/wh.index.ts#L42). That preserves the existing module-scoped connection registry in [`packages/xnode/src/Wormholes/wh.ws.server.ts:53`](../../src/Wormholes/wh.ws.server.ts#L53) and avoids creating a second WebSocket server, singleton, or connection map.

Do not merge the `@xpell/ui` Wormholes folder into this module. UI Wormholes is a browser transport client/facade that opens sockets, sends server XCommands, and consumes server EVT pushes. The proposed XModule is a Node/server facade over existing server push helpers.

## 2. Current Node and UI Wormholes Implementations

Current Node implementation inventory:

- `packages/xnode/src/Wormholes/wh.types.ts` defines the server protocol types: `WH_VERSION = 2`, `WHEnvelope`, `XCmd`, `WHEventPayload`, auth/session state, and `WHContext`. `WHConnMeta` already contains `_wid`, `_app_id`, and `_env` fields for scoped broadcast in [`packages/xnode/src/Wormholes/wh.types.ts:202`](../../src/Wormholes/wh.types.ts#L202).
- `packages/xnode/src/Wormholes/wh.codec.ts` parses and validates envelopes, constructs `HELLO`, `RES`, and `EVT`, and serializes envelopes with `JSON.stringify(...)` in [`packages/xnode/src/Wormholes/wh.codec.ts:220`](../../src/Wormholes/wh.codec.ts#L220).
- `packages/xnode/src/Wormholes/wh.errors.ts` defines the current `E_WH_*` protocol error helpers.
- `packages/xnode/src/Wormholes/wh.gateway.ts` is the transport-agnostic gateway. It requires auth by default, injects `_wid`, `_sid`, `_from`, `_to`, and sanitized `_auth` into command params, attaches `xcmd._ctx`, calls optional `_authorize_req`, then routes `REQ` to `_x.execute(...)` in [`packages/xnode/src/Wormholes/wh.gateway.ts:247`](../../src/Wormholes/wh.gateway.ts#L247).
- `packages/xnode/src/Wormholes/wh.rest.router.ts` exposes `GET /wh/v2/hello`, `POST /wh/v2/auth`, and `POST /wh/v2/call`. REST explicitly does not support server-to-client push in [`packages/xnode/src/Wormholes/wh.rest.router.ts:13`](../../src/Wormholes/wh.rest.router.ts#L13).
- `packages/xnode/src/Wormholes/wh.ws.server.ts` owns the WebSocket server transport and connection registry. It exposes `wsSetScope`, `wsSendToWid`, `wsBroadcastScoped`, and `wsBroadcastAll`.
- `packages/xnode/src/Wormholes/wh.session.ts` stores per-link session/auth/pending correlation state.
- `packages/xnode/src/Wormholes/wh.ws.client.ts` is a Node-side Wormholes client for xnode-to-xnode or similar WS calls.
- `packages/xnode/src/Wormholes/wh.index.ts` is the public Node Wormholes entrypoint, and `packages/xnode/src/index.ts` re-exports it from [`packages/xnode/src/index.ts:129`](../../src/index.ts#L129).

Current UI implementation inventory:

- `packages/xpell-ui/src/Wormholes/Wormholes.ts` exports a singleton `Wormholes` facade and `WormholesFacade`. It chooses V2 when the URL contains `/wh/v2`; legacy V1 is opt-in in [`packages/xpell-ui/src/Wormholes/Wormholes.ts:69`](../../../xpell-ui/src/Wormholes/Wormholes.ts#L69).
- `packages/xpell-ui/src/Wormholes/Wormholes.v2.ts` is the browser WS client. It opens a socket, sends `HELLO`, sends XCommands as `REQ`, tracks waiters, and dispatches received `EVT` payloads into `_xem`.
- `packages/xpell-ui/src/Wormholes/Wormholes.v1.ts` is a legacy client plus a V1 adapter for the facade.
- `packages/xpell-ui/src/Wormholes/wh.types.ts` duplicates the V2 protocol concepts for UI. It is aligned by convention with xnode but is not imported from a shared package.
- `packages/xpell-ui/src/Wormholes/wh.codec.ts` creates and stringifies UI envelopes. Its parser is currently plain `JSON.parse(...)` in [`packages/xpell-ui/src/Wormholes/wh.codec.ts:64`](../../../xpell-ui/src/Wormholes/wh.codec.ts#L64), not the deeper server validator.
- `packages/xpell-ui/src/Wormholes/wh.xdata.ts` mirrors Wormholes state into client `_xd`.
- `packages/xpell-ui/src/index.ts` exports UI Wormholes types, codec helpers, V1/V2 classes, and the facade in [`packages/xpell-ui/src/index.ts:87`](../../../xpell-ui/src/index.ts#L87).

Shared protocol/types:

- There is no separate shared Wormholes package today.
- Node and UI both define V2 envelope types and helpers, but they are duplicated.
- The duplicated types are close but not identical. For example, UI `WHKind` includes `"ERR"` in [`packages/xpell-ui/src/Wormholes/wh.types.ts:41`](../../../xpell-ui/src/Wormholes/wh.types.ts#L41), while Node `WHKind` does not include `"ERR"` in [`packages/xnode/src/Wormholes/wh.types.ts:30`](../../src/Wormholes/wh.types.ts#L30). UI `WHEventPayload` also permits `_data`, while Node only types `_name` and `_args`.

Public exports:

- Node exports protocol types/errors, `handleEnvelope`, `WHSession`, WS server helpers, `WHWSClient`, and `createWormholesRestRouter` through `wh.index.ts`.
- UI exports the Wormholes facade, V1/V2 clients, UI protocol types, and UI codec helpers through `src/index.ts`.

Direct consumers:

- `XWebServer` installs REST and WS Wormholes transports through the public Node entrypoint in [`packages/xnode/src/XServer/XWebServer.ts:21`](../../src/XServer/XWebServer.ts#L21).
- `ServerXVMModule` imports `wsBroadcastScoped` and `wsSetScope` in [`packages/xnode/src/XVM/ServerXVMModule.ts:8`](../../src/XVM/ServerXVMModule.ts#L8).
- `XEntityManager` imports `wsBroadcastScoped` in [`packages/xnode/src/XEntityManager/XEntityManager.ts:13`](../../src/XEntityManager/XEntityManager.ts#L13).
- `XVibeModule` imports `wsBroadcastScoped` in [`packages/xnode/src/XVIBE/XVibeModule.ts:7`](../../src/XVIBE/XVibeModule.ts#L7).
- `StructuredViewEdit` imports `wsBroadcastScoped` in [`packages/xnode/src/XVIBE/StructuredEditing/StructuredViewEdit.ts:4`](../../src/XVIBE/StructuredEditing/StructuredViewEdit.ts#L4).
- UI direct Wormholes consumers include `XVMClient`, `XVM`, `XAIClient`, `ProjectMemoryClient`, and `XStudioModule`. `FlowManagerClient` and `XDBSyncManager` use a client object that provides `sendXcmd(...)`.

Lifecycle and singleton ownership:

- The authoritative server connection registry is the module-level `connections` map in `wh.ws.server.ts`.
- `createWormholesWSServer(...)` creates the WS server and stores each connection in that registry.
- `wsSetScope(...)`, `wsSendToWid(...)`, `wsBroadcastScoped(...)`, and `wsBroadcastAll(...)` all use the same registry from the same imported module instance.
- A future `wormholes` XModule must not construct a new WebSocket server or a new registry. It should import the existing public helper and delegate.
- UI has a separate singleton `new WormholesFacade()` in [`packages/xpell-ui/src/Wormholes/Wormholes.ts:121`](../../../xpell-ui/src/Wormholes/Wormholes.ts#L121). That singleton is not the server connection registry.

Existing app/environment scoping:

- Server connections start with `_meta._app_id` and `_meta._env` unset.
- `server-xvm.subscribe` reads the trusted transport `_wid` from `xcmd._ctx._meta._wid`, not from params, in [`packages/xnode/src/XVM/ServerXVMModule.ts:1006`](../../src/XVM/ServerXVMModule.ts#L1006).
- `server-xvm.subscribe` then calls `wsSetScope(wid, { _app_id, _env })` in [`packages/xnode/src/XVM/ServerXVMModule.ts:1017`](../../src/XVM/ServerXVMModule.ts#L1017).
- `wsBroadcastScoped(app_id, env, ...)` delivers only to connections whose connection metadata exactly matches that `_app_id` and `_env` in [`packages/xnode/src/Wormholes/wh.ws.server.ts:267`](../../src/Wormholes/wh.ws.server.ts#L267).
- `XVMClient` also filters received `xvm:update` payloads by `_app_id` and `_env` in [`packages/xpell-ui/src/XVM/XVMClient.ts:1306`](../../../xpell-ui/src/XVM/XVMClient.ts#L1306).

## 3. Proposed XModule Contract

Recommendation: add a server-only XModule named `wormholes` in `@xpell/node`.

V1 should expose exactly one operation:

```ts
{
  _module: "wormholes",
  _op: "broadcast",
  _params: {
    _app_id: string,
    _env?: string,
    _event: string,
    _payload?: JsonValue,
    _exclude_connection_id?: string,
    _audience?: "app"
  }
}
```

Parameter decisions:

- `_app_id`: required for trusted server callers unless the module can derive scope from a trusted command context. Current XVibe callers already have app id values, so requiring this is the smallest migration path.
- `_env`: optional only if the module defaults it to `"default"` consistently with ServerXVM and FlowManager conventions. Prefer passing it explicitly in migrations.
- `_event`: required. It maps to `WHEventPayload._name`.
- `_payload`: optional JSON-compatible payload. If present, the facade maps it to `WHEventPayload._args: [_payload]`.
- `_exclude_connection_id`: optional trusted server-only field. It maps to `wsBroadcastScoped(..., { _exclude_wid })` only after same-scope/capability checks.
- `_audience`: optional, default and only accepted V1 value should be `"app"`, meaning app/env-scoped subscribed connections.
- `_channel`: do not include in V1. There is no current channel registry or channel-scoped API in the source.
- `_connection_id`: do not include in V1. Exposing arbitrary targeted send would bypass app/env fanout isolation.
- `_scope`: do not include as a public V1 input. Internally the module may normalize an effective scope object, but the public operation should stay aligned with existing Xpell `_app_id`/`_env` module conventions.

Recommended result:

```ts
new XResponseOK({
  _event,
  _app_id,
  _env,
  _audience: "app",
  _delivered: sent_count
})
```

Recommended errors:

- `E_WH_BROADCAST_FORBIDDEN`
- `E_WH_INVALID_SCOPE`
- `E_WH_INVALID_EVENT`
- `E_WH_INVALID_AUDIENCE`
- `E_WH_INVALID_PAYLOAD`
- `E_WH_PAYLOAD_TOO_LARGE`
- `E_WH_SERIALIZATION_FAILED`

These should be `XError`/`XResponseError` results at the XModule boundary. The existing protocol-level `E_WH_*` prefix is already used in `wh.errors.ts`.

Recommended module metadata:

- `static _name = "wormholes"`
- `static _ops = { broadcast: { _name: "broadcast", _scope: "module", ... } }`
- `static _skill` should use `_type: "server-module-api"`, `_scope: "server"`, and `_requires: ["xmodule", "wormholes-protocol"]` or equivalent current skill vocabulary.

## 4. Current API Mapping

Current direct API:

```ts
wsBroadcastScoped(app_id, env, {
  _name: "xvm:update",
  _args: [payload]
});
```

Proposed command mapping:

```ts
await _x.execute({
  _module: "wormholes",
  _op: "broadcast",
  _params: {
    _app_id: app_id,
    _env: env,
    _event: "xvm:update",
    _payload: payload
  }
});
```

Internal facade mapping:

```ts
const sent = wsBroadcastScoped(app_id, env, {
  _name: event,
  _args: payload === undefined ? undefined : [payload]
}, exclude ? { _exclude_wid: exclude } : {});
```

Parameter normalization:

- Validate `_params` with `_xu.ensure_params(...)`.
- Normalize `_app_id` and `_env` as non-empty safe strings. Use `"default"` only as the documented default for missing `_env`.
- Validate `_event` as a non-empty event name. Prefer a conservative event-name pattern such as `^[a-z][a-z0-9._:-]{0,127}$`.
- Reject `_audience` values other than missing or `"app"`.
- Reject `_connection_id` and `_channel` if present in V1.
- Accept `_exclude_connection_id` only for trusted/internal callers and map it to `_exclude_wid`.
- Validate `_payload` as JSON-compatible and below a module-level byte limit before calling `wsBroadcastScoped(...)`.

Return value:

- Current `wsBroadcastScoped(...)` returns the number of matching open connections sent to.
- The XModule should return that count under `_delivered`.

No-connection behavior:

- Current behavior returns `0`. It is not an error.
- The XModule should preserve this behavior and return `_delivered: 0`.

Error behavior:

- Current callers usually wrap direct broadcast in `try/catch`. Examples include `ServerXVMModule._push_update` in [`packages/xnode/src/XVM/ServerXVMModule.ts:1082`](../../src/XVM/ServerXVMModule.ts#L1082), `XEntityManager.broadcastEntityMutation` in [`packages/xnode/src/XEntityManager/XEntityManager.ts:1848`](../../src/XEntityManager/XEntityManager.ts#L1848), and XVibe generation event helpers.
- `wsBroadcastScoped(...)` can throw if event construction, JSON serialization, or `ws.send(...)` throws.
- The XModule should catch failures and return `XResponseError`, not leak raw transport exceptions through `_x.execute()`.

Logging:

- Current `wsBroadcastScoped(...)` logs `[WH] broadcastScoped` with app/env and connection count in [`packages/xnode/src/Wormholes/wh.ws.server.ts:257`](../../src/Wormholes/wh.ws.server.ts#L257).
- The facade should log the module/op, app/env, event, delivered count, and rejection reasons without logging payload bodies by default.

Serialization behavior:

- Current server EVT send path calls `makeEvt(...)` then `stringifyEnvelope(...)`, which uses `JSON.stringify(...)`.
- Cyclic payloads and server objects will fail serialization. Oversized but serializable payloads are not blocked at the broadcast helper layer.
- The facade should preflight serialization once before iterating connections so invalid payloads fail before partial delivery.

App/environment isolation:

- Current delivery is app/env-scoped by exact connection metadata match.
- The XModule must keep using `wsBroadcastScoped(...)` for V1 and must not use `wsBroadcastAll(...)` or `wsSendToWid(...)` for `broadcast`.

Delivery semantics:

- Delivery is synchronous best-effort over currently open WS connections.
- It is not queued, not durable, and not acknowledged by clients.
- REST cannot receive server push.

## 5. Backward Compatibility Strategy

Keep all existing direct APIs and exports working:

- Do not remove `wsBroadcastScoped`, `wsSetScope`, `wsSendToWid`, `wsBroadcastAll`, or other public exports from `wh.index.ts`.
- Do not change `wsBroadcastScoped(...)` signature or behavior during the facade addition.
- Do not move UI Wormholes files.
- Do not alter client V1/V2 Wormholes API during the server facade addition.

Additive migration path:

1. Add a new `WormholesModule` or `WormholesXModule` under `packages/xnode/src/Wormholes/`.
2. Export it from `packages/xnode/src/Wormholes/wh.index.ts` and therefore from `packages/xnode/src/index.ts`.
3. Register it during `XNode.start()` with `await _x.loadModuleAsync(new WormholesModule())`.
4. Implement `_broadcast(...)` by delegating to the existing `wsBroadcastScoped(...)`.
5. Leave `ServerXVMModule`, `XEntityManager`, and XVibe direct imports untouched at first.
6. Migrate XVibe call sites independently to `_x.execute({ _module: "wormholes", _op: "broadcast" })`.
7. Later migrate other direct consumers only if the facade proves stable.
8. Later deprecate direct imports in docs, not in code, until consumers are migrated.

Singleton and connection-registry identity:

- The future module must import the existing helper from the same `wh.ws.server.ts` module instance.
- Do not create another `connections` map.
- Do not create another `createWormholesWSServer(...)` call from the module.
- Do not package-copy server Wormholes helpers into a separate module for V1.
- Verify identity with a test that scopes a connection via `server-xvm.subscribe` or `wsSetScope`, broadcasts through `wormholes.broadcast`, and observes the same connection receives the EVT.

XVibe migration:

- XVibe currently broadcasts generation stage, complete, and failed events through direct imports in [`packages/xnode/src/XVIBE/XVibeModule.ts:12475`](../../src/XVIBE/XVibeModule.ts#L12475), [`packages/xnode/src/XVIBE/XVibeModule.ts:12554`](../../src/XVIBE/XVibeModule.ts#L12554), and [`packages/xnode/src/XVIBE/XVibeModule.ts:12630`](../../src/XVIBE/XVibeModule.ts#L12630).
- `StructuredViewEdit` currently broadcasts active-view refresh through direct import in [`packages/xnode/src/XVIBE/StructuredEditing/StructuredViewEdit.ts:1631`](../../src/XVIBE/StructuredEditing/StructuredViewEdit.ts#L1631).
- Those are good first migration targets after the facade exists because the user-visible behavior is event fanout, not transport ownership.

## 6. Security and Authorization Analysis

Main finding: `broadcast` is a server push primitive and must not be exposed as a generic externally callable command.

Risk: callers spoofing `_app_id` or `_env`.

- Current scoped broadcast trusts the app/env passed by the direct caller.
- A public command-bus op would let a client submit any `_app_id` and `_env` unless blocked.
- Recommendation: V1 is trusted server-only. If a remote command reaches the module, derive effective app/env from trusted command context when possible and reject mismatches with raw params.

Risk: cross-tenant broadcasts.

- `wsBroadcastScoped(...)` isolates by connection metadata, but `server-xvm.subscribe` currently accepts `_app_id` and `_env` params and sets that scope for the caller's `_wid`.
- Without authz, a client could subscribe to another app/env and then receive scoped broadcasts.
- Recommendation: authorization for app/env access must be enforced before `server-xvm.subscribe`, before `wormholes.broadcast`, and in the gateway allowlist.

Risk: broadcasting to arbitrary connections.

- `wsSendToWid(...)` exists, but exposing `_connection_id` in V1 would bypass app/env fanout.
- Recommendation: V1 does not expose `_connection_id`. Only `_exclude_connection_id` may exist for trusted same-scope exclusion.

Risk: exposing internal/server-only events.

- Current internal event names include `xvm:update`, `vibe:generation-stage`, `vibe:generation-complete`, and `vibe:generation-failed`.
- Recommendation: use an allowlist or prefix policy. Do not allow arbitrary `server-*`, `xauth:*`, or infrastructure event names from untrusted callers.

Risk: oversized payloads.

- WS server max payload defaults to 50 MB in [`packages/xnode/src/Wormholes/wh.ws.server.ts:86`](../../src/Wormholes/wh.ws.server.ts#L86), and REST JSON parsing uses `10mb` in [`packages/xnode/src/Wormholes/wh.rest.router.ts:105`](../../src/Wormholes/wh.rest.router.ts#L105).
- Broadcast payloads are not separately capped.
- Recommendation: the XModule should enforce a much smaller default broadcast payload limit, configurable by server options later.

Risk: cyclic or non-serializable payloads.

- `JSON.stringify(...)` is the current serialization boundary.
- Recommendation: preflight `JSON.stringify({ _payload })` or `_xu.safe_json_stringify` if suitable, reject serialization failures, and avoid partial delivery.

Risk: denial-of-service or broadcast storms.

- Broadcast loops over all open connections and sends synchronously.
- Recommendation: block external access by default, log rate-sensitive metadata only, and later add per-event/app rate limits if public usage is ever required.

Risk: unauthenticated command execution.

- Gateway auth defaults to required in `wh.gateway.ts`, but `XWebServer._installWormholesV2()` currently passes `_require_auth: false`.
- Recommendation: production deployments must use `_require_auth: true` and `_authorize_req`; V1 facade must also self-guard because current default bootstrap is permissive.

Risk: privilege escalation through client-originated XCommands.

- Gateway `REQ` payload is any `{ _module, _op, _params }` and routes to `_x.execute(...)`.
- Recommendation: enforce a gateway command allowlist. `wormholes:broadcast` should be absent from any client allowlist by default.

Risk: leaking secrets or server objects in payloads.

- `_xlog` has no automatic redaction guarantee, and JSON serialization can expose object fields.
- Recommendation: callers must construct minimal payloads; the module should not log payload bodies; reject obvious non-JSON values.

Risk: event-name injection.

- Current `makeEvt(...)` requires a non-empty `_name`, but does not restrict characters beyond string length.
- Recommendation: validate event names with a conservative pattern and/or allowlist.

Risk: bypassing existing authorization checks.

- Direct server imports currently bypass the gateway but are in trusted server code.
- A command-bus facade adds a new route that can be called by anything with `_x.execute` access.
- Recommendation: combine dispatcher/gateway allowlisting, Wormholes XModule capability checks, and caller-side discipline.

Authorization placement:

- Command-bus dispatcher/gateway: enforce authentication and command allowlist for client-originated Wormholes `REQ`. This is the first external boundary.
- Wormholes XModule: validate params, reject untrusted/external calls, enforce event/scope policy, cap payload size, and use trusted context before raw params.
- Caller: pass only app/env/event/payload required for the user-visible update. Do not include tokens or server objects.
- Transport layer: keep envelope validation, max payload, session/auth context injection, and no raw transport objects in modules.

## 7. Server/client Boundary

Recommendation: `wormholes` should mean a server-only XModule in V1.

Why:

- The requested operation is server push to subscribed clients.
- The current server implementation owns the WS connection registry.
- The current UI implementation is a client transport facade, not a broadcast registry.
- `_x.execute()` on the server is the command-bus path that can replace direct server imports in XVibe.

Do not assume `packages/xpell-ui/src/Wormholes/**` should move into `@xpell/node` or into the same module. Its role is to:

- open browser WebSocket connections;
- send server commands as Wormholes `REQ`;
- receive server `EVT` pushes;
- bridge incoming events into client `_xem`;
- maintain client connection state in `_xd`.

The shared concept is the Wormholes V2 JSON envelope, not a shared runtime implementation. A later extraction could split protocol types/codecs into a small shared package, but the server facade should not block on that.

Externally callable operations:

- V1 `broadcast` should be server-internal/trusted-module-only.
- It should be blocked from authenticated clients unless a deployment explicitly grants that capability.
- Do not add a public variant in V1.
- If a future public event operation is needed, design it around derived caller scope, event allowlists, and payload caps. Do not expose raw `wsBroadcastScoped`, `wsBroadcastAll`, or `wsSendToWid` semantics.

## 8. Future Package Implications

Implement the facade now inside `@xpell/node`.

Rationale:

- Server Wormholes transport and connection registry already live in `@xpell/node`.
- The facade must share the existing registry and server helpers.
- `@xpell/node` currently has no package `exports` map and exposes its public surface through `dist/index.js` and `dist/index.d.ts` in [`packages/xnode/package.json:16`](../../package.json#L16).
- Adding a module inside `@xpell/node` is additive and backward-compatible.

Do not extract a full `@xpell/wormholes` package for this task.

Future direction, if package extraction becomes necessary:

- `@xpell/wormholes-protocol`: shared JSON-only envelope types, codecs, and error codes.
- Node adapter in `@xpell/node` or future `@xpell/wormholes-node`: WS server, REST router, gateway, registry, push helpers, and server XModule facade.
- UI adapter in `@xpell/ui` or future `@xpell/wormholes-ui`: browser facade, reconnect behavior, XData/XEM integration, and V1 compatibility.

This should remain a future evaluation. V1 should keep the runtime dependency graph stable.

## 9. Risks

- The default XWebServer Wormholes install is permissive (`_require_auth: false`), so a new module op can become remotely callable unless gateway policy blocks it.
- `server-xvm.subscribe` sets app/env scope from params after reading the trusted `_wid`; without app/env authorization, subscription itself can be abused.
- UI and Node protocol types are duplicated and drift slightly; do not treat UI types as authoritative for server module behavior.
- Current broadcast serialization can fail after entering the send loop; the facade should preflight JSON compatibility.
- Payload size limits exist at transport ingress but not at server broadcast creation.
- Direct migration of all consumers at once would increase risk. Start with facade tests, then migrate XVibe call sites.
- Future package extraction could accidentally duplicate the connection registry if helpers are copied instead of imported.

## 10. Recommended Implementation Phases

Phase 1: add server `wormholes` XModule facade.

- Create a server module under `packages/xnode/src/Wormholes/`.
- Expose only `broadcast`.
- Delegate to the current `wsBroadcastScoped(...)`.
- Register the module in `XNode.start()`.
- Add focused tests for success, no-connection return, invalid params, serialization failure, external/unauthorized rejection, and singleton registry identity.

Phase 2: preserve direct API forwarding.

- Keep all direct Wormholes public exports.
- Optionally document direct helpers as lower-level transport APIs.
- Do not deprecate in code yet.

Phase 3: migrate XVibe direct imports to `_x.execute()`.

- Replace XVibe generation event broadcasts with `_x.execute({ _module: "wormholes", _op: "broadcast" })`.
- Replace `StructuredViewEdit` active-view refresh broadcast the same way if tests show equivalent behavior.
- Keep payload shapes identical.

Phase 4: add security and isolation tests.

- Verify unauthenticated or client-originated `wormholes.broadcast` is blocked by policy.
- Verify app/env mismatch is rejected or does not deliver.
- Verify `_connection_id` and unknown `_audience` are rejected.
- Verify payload size and serialization guards.
- Verify subscribers in a different app/env do not receive events.

Phase 5: evaluate package extraction later.

- Consider shared protocol extraction only after the XModule facade is stable and UI/Node type drift is assessed.

## 11. Immediate Next Codex Task

Add the server-only `wormholes` XModule facade without migrating consumers:

- Create `packages/xnode/src/Wormholes/WormholesModule.ts`.
- Implement `static _name = "wormholes"`, `static _ops`, `static _skill`, and `_broadcast(xcmd)`.
- Validate `_app_id`, `_env`, `_event`, `_payload`, `_audience`, and `_exclude_connection_id`.
- Reject `_connection_id`, `_channel`, and non-`"app"` audiences.
- Delegate to the existing `wsBroadcastScoped(...)`.
- Export the module from `packages/xnode/src/Wormholes/wh.index.ts`.
- Load it in `packages/xnode/src/XServer/XNode.ts`.
- Add focused tests, but do not migrate XVibe, ServerXVM, or EntityManager call sites yet.
