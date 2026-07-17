# XVibe Consumer Compatibility Report

Date: 2026-07-17

Scope: downstream compatibility after making `@xpell/vibe` the canonical XVibe implementation consumed by `@xpell/node`.

No application imports were changed during this validation.

## 1. Consumers found

### Downstream applications

| Consumer | Files / resources | XVibe usage |
| --- | --- | --- |
| `xpell-vibe-starter/server` | `src/main.ts`, `src/modules/Test/XTest.ts`, `server/package.json`, `system-xapps/vibe-system/flows/*.json` | Imports `XNode` and runtime helpers from `@xpell/node`; system flows execute `_module: "xvibe"`. |
| `xpell-vibe-starter/client` | `src/xapp.ts`, `src/studio/XStudioEditor.ts`, `src/style/xvibe-app.css` | Runtime state/UI usage only: `xvibe.active_app`, `xvibe-shell`, and XVibe CSS naming. |
| `xai-router/server` | `src/main.ts`, `src/modules/**`, `server/package.json`, `system-xapps/vibe-system/flows/flow-generate-app.json`, `test/*.test.mjs` | Imports `XNode`, `_x`, `_xai`, and module base APIs from `@xpell/node`; system flow executes `_module: "xvibe"`. |
| `xai-router/client` | `src/xapp.ts`, `src/studio/XStudioEditor.ts` | Runtime state/UI usage only: `xvibe.active_app`, `xvibe-app`, `xvibe-shell`. |
| `reut-music-player/server` | `src/main.ts`, `src/modules/Test/*.ts`, `server/package.json`, `system-xapps/vibe-system/flows/*.json` | Imports `@xpell/node`; system flows execute `_module: "xvibe"`. |
| `reut-music-player/client` | `src/xapp.ts`, `src/studio/XStudioEditor.ts`, `src/style/xvibe-app.css` | Runtime state/UI usage only. |
| `packages/xpell-ui` | `src/XStudio/XStudioModule.ts`, `src/XVM/XVM.ts`, `src/XFM/FlowManagerClient.ts`, `tests/xuiobject-dom-projection.test.mjs` | Runtime command user only: sends commands to module name `xvibe`, consumes `xvibe.active_app`, and tests XVibe command envelopes. |
| `xai-providers` | `src/**Provider.ts`, `package.json` | Generic `@xpell/node` API consumer for XAI provider contracts and helpers; no XVibe class/package usage. |

### Other workspace users

Searches also found generic `@xpell/node` consumers in `xpell-agent` packages and `xpell-node-test`. Those are root API consumers, but no direct XVibe dependency was found there.

Internal migration files in `packages/xnode` and `packages/xvibe` were excluded from downstream classification. They intentionally include:

- `packages/xnode/src/XServer/XNode.ts`: imports `XVibeModule` from `@xpell/vibe`.
- `packages/xnode/src/index.ts`: compatibility re-export from `@xpell/vibe`.
- `packages/xnode/src/XVIBE/**`: compatibility forwarders to `@xpell/vibe/XVIBE/**`.
- `packages/xnode/src/test.ts`: compatibility and class-identity assertions.

## 2. Import categories

### Runtime command user only

- `packages/xpell-ui`
- `xpell-vibe-starter/client`
- `xai-router/client`
- `reut-music-player/client`
- System XApp flows in `xpell-vibe-starter/server`, `xai-router/server`, and `reut-music-player/server`

These consumers depend on the runtime module name `xvibe`, not on XVibe source files.

### `@xpell/node` root API consumer

- `xpell-vibe-starter/server`
- `xai-router/server`
- `reut-music-player/server`
- `xai-providers`
- Generic workspace consumers such as `xpell-agent` and `xpell-node-test`

These consumers do not need import changes for the current extracted-package state.

### Old deep-import consumer

No downstream application imports `@xpell/node/.../XVIBE/...` or `packages/xnode/src/XVIBE/...`.

The remaining `/XVIBE/` imports are internal `packages/xnode` tests and compatibility forwarders. They are expected during the compatibility period.

### Direct `@xpell/vibe` consumer

No downstream application directly imports `@xpell/vibe`.

Direct `@xpell/vibe` usage is currently limited to `@xpell/node` itself and internal tests. That preserves the compatibility contract that existing apps continue to enter XVibe through `@xpell/node` or runtime commands.

## 3. Build, test, and smoke results

### Builds

| Command | Result |
| --- | --- |
| `pnpm -C packages/xvibe build` | Pass |
| `pnpm -C packages/xnode build` | Pass |
| `pnpm -C xai-providers build` | Pass |
| `pnpm -C packages/xpell-ui build` | Pass |
| `pnpm -C xpell-vibe-starter/server build` | Pass |
| `pnpm -C xpell-vibe-starter/client build` | Pass, with Vite chunk-size warning only |
| `pnpm -C xai-router/server build` | Pass |
| `pnpm -C xai-router/client build` | Pass |
| `pnpm -C reut-music-player/server build` | Pass |
| `pnpm -C reut-music-player/client build` | Pass, with Vite chunk-size warning only |

The Reut builds required filesystem approval because that app is outside the `packages/xnode` writable root. The initial failures were sandbox `EPERM` write failures, not build failures.

### Tests

| Command | Result |
| --- | --- |
| `pnpm -C packages/xnode test` | Pass on Node 22.23.1; includes XVibe compatibility and identity assertions. |
| `pnpm -C packages/xpell-ui test` | Pass. |
| `node --test test/*.test.mjs` in `xai-router/server` | Partial pass: `AimeAuthModule.test.mjs` and `XAIRouteRunLogger.test.mjs` pass; `XAIRouterModule.test.mjs` has 60/61 passing with one pre-existing route-trace filesystem failure. |

The `xai-router/server` failing subtest is:

`generate creates one parseable filesystem route trace without secrets`

Failure:

`ENOENT: no such file or directory, scandir '/var/folders/.../xai-router-trace-.../xai-routes'`

This failure does not reference `@xpell/vibe`, `/XVIBE/`, `XVibeModule`, or `_module: "xvibe"`. It appears isolated to route-trace test setup/output and was not fixed because it is not an XVibe package compatibility issue.

### Startup smoke tests

| Target | Result |
| --- | --- |
| `xpell-vibe-starter/server/dist/main.js` | Pass. Started with temp work folder, `system-xapps` symlink, port `0`, wormholes disabled, and reached `[vibe-server] ready`. |
| `xai-router/server/dist/main.js` | Pass. Started with temp work folder, `system-xapps` symlink, port `0`, wormholes disabled, and reached `[vibe-server] ready`. |

### Runtime compatibility smoke

A temporary smoke script started `XNode` from built `@xpell/node`, imported `XVibeModule` from `@xpell/vibe`, and asserted:

- `XNode.start()` registered exactly one module with `_name: "xvibe"`.
- `_x.getModule("xvibe") instanceof XVibeModule` is true.
- `_x.getModule("xvibe").constructor === XVibeModule` is true.
- A persisted FlowManager flow with a step command `{ _module: "xvibe", _op: "get-guide-recommendation" }` executed successfully.
- `xvibe.create_app_from_starter` succeeded when the host app provided `system-xapps/app-starters/Empty`.

Result:

```json
{
  "ok": true,
  "xvibe_module_count": 1,
  "xvibe_constructor_identity": true,
  "flow_ok": true,
  "flow_step_ok": true,
  "starter_ok": true
}
```

The first run hit sandbox `listen EPERM` on the local HTTP server. The approved rerun passed.

## 4. Runtime resource issues

No missing runtime resource was observed for the validated downstream applications.

Current resource behavior:

- `xpell-vibe-starter/server` passes `_system_xapps_path: "./system-xapps"` and contains `system-xapps/app-starters/Empty` and `system-xapps/app-starters/dashboard`.
- `reut-music-player/server` follows the same pattern and contains app-owned starter resources.
- `xai-router/server` contains `system-xapps/vibe-system` and uses `flow-generate-app`; it does not currently depend on `flow-create-app-from-starter`.
- `packages/xpell-ui` uses runtime commands and XData keys only; it does not load package resources.

Remaining risk:

`@xpell/vibe` does not currently package starter apps, system XApps, or skills. That is compatible with the current host-app pattern, but `XVibeModule` still has a package-root fallback for starter lookup. A host that calls `create_app_from_starter` without providing `_system_xapps_path` will depend on `@xpell/vibe` packaging `system-xapps/app-starters`, which is not true yet.

Before licensing separation, decide whether starters and skills remain app-owned resources or become package resources shipped by `@xpell/vibe`.

## 5. Required fixes, if any

No import changes are required for XVibe extraction compatibility.

No downstream direct `@xpell/vibe` adoption is required yet. No old deep imports were found outside `packages/xnode` compatibility/test files.

Required non-extraction cleanup:

- Fix the unrelated `xai-router/server/test/XAIRouterModule.test.mjs` route-trace filesystem failure before using the full xai-router suite as a release gate.

Required before optional/licensing separation:

- Add feature gating or graceful absence handling for runtime command users that assume `_module: "xvibe"` exists.
- Decide and document resource ownership for `system-xapps`, app starters, prompts, and skills.
- If `@xpell/vibe` becomes optional in `@xpell/node`, keep class identity true when installed and ensure `@xpell/node` root compatibility exports fail deterministically or are conditionally documented.
- Preserve the current `xvibe` module name and FlowManager command behavior.

## 6. Readiness for licensing separation

Consumer compatibility is ready for the current non-optional extracted package state:

- Existing downstream applications continue through `@xpell/node` root APIs and runtime command envelopes.
- There are no downstream old deep-import consumers to migrate.
- There are no downstream direct `@xpell/vibe` consumers to coordinate.
- `@xpell/node` loads one canonical `@xpell/vibe` `XVibeModule`.
- `_module: "xvibe"` flows still execute through FlowManager.

Not ready for licensing separation yet:

- Runtime consumers still assume `xvibe` is always registered.
- Starter/system-app/skill ownership is not finalized.
- Optional package loading and deterministic missing-license/missing-package errors have not been implemented.
