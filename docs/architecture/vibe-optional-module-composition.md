# XVibe Optional Module Composition Investigation

Date: 2026-07-17

Scope: architecture investigation only. No production code, dependencies, automatic XVibe loading, or licenses were changed.

Validation performed:

- Inspected `XNode.start()` startup and module loading in `src/XServer/XNode.ts`.
- Inspected duplicate and sync/async module loading behavior in `packages/xpell-core/src/Xpell.ts` and `packages/xpell-core/src/XModule.ts`.
- Inspected package dependencies, current exports, and XVIBE compatibility forwarders in `package.json`, `src/index.ts`, and `src/XVIBE/**`.
- Searched source consumers with `rg` across `xpell-vibe-starter`, `xai-router`, `reut-music-player`, `xpell-agent`, `xpell-node-test`, `packages`, and `examples`.
- Inspected persisted Vibe system flows that execute `_module: "xvibe"`.

## 1. Executive Summary

`@xpell/node` currently treats XVibe as a built-in server module. `XNode.start()` statically imports `XVibeModule` from `@xpell/vibe`, auto-instantiates it, and `@xpell/node` re-exports the `@xpell/vibe` public API. That preserves compatibility for existing Vibe apps, but it also means generic `@xpell/node` servers receive XVibe and the `@xpell/vibe` package even when they do not use it.

The clean migration is staged, not breaking:

1. Add generic module composition to `XNode.start()` through a server-side `_modules` option.
2. Keep implicit XVibe loading temporarily.
3. Add `_load_vibe` as a compatibility switch that defaults to `true` during migration.
4. Warn only when XVibe is loaded implicitly and the application did not explicitly request it.
5. Migrate Vibe consumers to import `XVibeModule` from `@xpell/vibe` and pass it through `_modules`.
6. Validate generic no-Vibe startup with `_load_vibe: false`.
7. Only after consumers are explicit, remove implicit loading, the static import, the dependency, root re-export, and `src/XVIBE/**` forwarders in a breaking release or clearly marked compatibility release.

Immediate breaking removal is not recommended. It would break `xpell-vibe-starter`, `xai-router`, `reut-music-player`, XStudio flows, and any persisted flow that executes `_module: "xvibe"`.

## 2. Current Startup Architecture

### How `XNode.start()` is called

Current source consumers construct a node instance and call `start()`:

- `xpell-vibe-starter/server/src/main.ts`: `const node = new XNode(); await node.start({ _work_folder, _system_xapps_path, _xdb })`.
- `xai-router/server/src/main.ts`: same pattern with `_work_folder`, `_system_xapps_path`, and `_xdb`.
- `reut-music-player/server/src/main.ts`: same pattern.
- `xpell-node-test/xnode-test/src/test.ts`: `const xs = new XNode(); await xs.start();`.
- `xpell-agent/packages/agent-core/src/runtime/AgentRuntime.ts`: creates `new XNode()` inside `start_transport()`, but this package is pinned to older `@xpell/node` `2.0.0-alpha.10` and uses non-underscored option names (`work_folder`, `host`, `port`, `web_settings`, `routes`) that do not match the current `XNodeOptions` source.

No other non-doc `XNode.start()` source consumers were found in the inspected workspace.

### Current options shape

Current `XNodeOptions` in `src/XServer/XNode.ts`:

```ts
type XNodeOptions = {
  _settings_path?: string;
  _work_folder?: string;
  _web_settings?: Partial<XWebSettings>;
  _system_xapps_path?: string;
  _port?: number;
  _host?: string;
  _xdb?: XDBOptions;
};
```

Current observations:

- `_work_folder` defaults to `"./work"`.
- `_web_settings`, `_port`, and `_host` are merged into XWeb settings.
- `_system_xapps_path` is passed only to `ServerXVMModule`.
- `_xdb` configures XDB storage and cache/vector options.
- `_settings_path` is declared but not used in the inspected source.
- There is no `_modules` option.
- There is no active `routes` option on `XNode.start()`. `XWebServer.useRoutes()` exists, but `XNode.start()` comments out route option support.

### Current built-in load order

`XNode.start()` is idempotent through `_started`. The current startup flow is:

1. Bind settings events once.
2. `ensureSetup(work_folder)`:
   - first boot creates work folders, calls `_xs.onSetup(work_folder)`, ensures settings `modules`, calls `XWebServer.onSetup(work_folder)`, writes `.xpell-initialized`;
   - later boot calls `init(work_folder)`.
3. `_x.start()` loads core modules `xd` and `xem` and starts the frame loop.
4. Apply web settings overrides.
5. `XWebServer.load()`.
6. `XWebServer.start()`.
7. Initialize and load XDB.
8. Load `PingModule`.
9. Load `WormholesModule`.
10. Load `XAuthModule`.
11. Load singleton `XAI`.
12. Load `XModuleCreatorModule`, whose `onLoad()` autoloads registered generated modules from the work-folder registry.
13. Load `XMutatorModule`.
14. Load `new XVibeModule()`.
15. Load `FlowManagerModule` (`_name: "flow"`).
16. Load `XEntityManager`.
17. Load `XStudioModule`.
18. Load `ServerXVMModule`; its `onLoad()` calls `init_on_boot()`.
19. Mark `_started = true`.
20. Fire `_xem.fire("server:started", { work_folder })`.

Source drift to record: older docs/skills said XDB was not auto-loaded and ServerXVM was loaded earlier. Current source auto-loads XDB and loads ServerXVM last, with `init_on_boot()` inside `ServerXVMModule.onLoad()`.

### Where XVibe is instantiated

`src/XServer/XNode.ts` statically imports:

```ts
import { XVibeModule } from "@xpell/vibe";
```

and later runs:

```ts
await _x.loadModuleAsync(new XVibeModule());
```

This makes `@xpell/vibe` a hard runtime dependency of `@xpell/node`.

### Duplicate module handling

The authoritative registry is `_x` in `@xpell/core`.

Current `XpellEngine.addModule()` behavior:

- if `this._modules` already has `xModule._name`, it logs `"Module <name> already loaded"` and returns `false`;
- duplicate modules are not replaced;
- duplicate module `load()` is not called;
- callers do not receive a thrown error.

`loadModule()` and `loadModuleAsync()` both call `addModule()` first. If `addModule()` returns `false`, the duplicate is skipped.

Important failure detail: `addModule()` registers the module before `xModule.load()` is awaited. If `load()` throws, `loadModuleAsync()` rejects, but the module object remains in `_modules` with `_loaded` unset. `XNode.start()` does not catch built-in module load errors internally, so startup rejects and `_started` remains `false`, but the global module registry may contain a partially loaded module.

### Sync/async module loading conventions

Current conventions are mixed:

- `loadModule()` is fire-and-forget legacy behavior. It calls `xModule.load()` without awaiting.
- `loadModuleAsync()` is deterministic startup behavior and awaits `xModule.load()`.
- `XNode.start()` uses `await _x.loadModuleAsync(...)` for built-ins.
- Downstream apps mostly use `await _x.loadModuleAsync(...)` after `node.start()`.
- `xpell-agent` and `xpell-node-test` still use sync `_x.loadModule(...)` for some modules.

## 3. Existing Extension Points

Current server extension points exist, but not through `XNode.start()` options.

### Direct module registration

Applications can register modules directly on the global runtime:

```ts
await _x.loadModuleAsync(new MyModule());
```

Observed downstream patterns:

- `xpell-vibe-starter` starts XNode, registers XAI provider/default, then loads `XTestModule`.
- `xai-router` starts XNode, then loads `XAIRouterModule`, `XAimeAuthModule`, and `XTestModule`.
- `reut-music-player` starts XNode, then loads `XTestModule` and `MusicPlayer`.
- `xpell-agent` loads its own modules before starting XNode transport.
- `xpell-node-test` starts XNode, then loads XDB and `XDBUser` using sync `loadModule()`.

### Route registration

`XWebServer.useRoutes(handler)` exists and applies immediately if the Express app is already loaded. `XNode.start()` does not currently expose it as a public option.

`xpell-agent` uses a `routes` option against an older pinned `@xpell/node`; that option is not active in current `src/XServer/XNode.ts`.

### Generic `_modules` option

No generic server `_modules` option exists today. It fits cleanly because:

- `XUIRuntime` already has a client-side `_modules?: any[]` composition pattern.
- `XNode.start()` already has a single deterministic async load sequence.
- Most consumers already think in terms of `new Module()` plus `_x.loadModuleAsync(...)`.
- Adding `_modules` would move app composition from global side effects after boot into startup configuration while preserving the underlying XModule contract.

Recommended future shape:

```ts
type XNodeOptions = {
  _modules?: XModule[];
  _load_vibe?: boolean;
  // existing fields...
};
```

Keep the initial contract narrow: accept module instances, load them sequentially with `loadModuleAsync()`, and fail startup on supplied module load failure.

### Generated module autoload

`XModuleCreatorModule.onLoad()` calls `autoload_registered_modules()`. It reads the generated module registry under the configured work folder, validates registered artifacts, skips existing module names, and loads generated modules through its own module operation.

This is a module-specific autoload facility, not generic application composition. It should remain separate from `XNodeOptions._modules`.

## 4. Consumer Migration Map

| Consumer | Needs XVibe? | Relies on implicit loading today? | Evidence | Explicit migration point |
| --- | --- | --- | --- | --- |
| `xpell-vibe-starter/server` | Yes | Yes | `system-xapps/vibe-system/flows/flow-generate-app.json` executes `xvibe.generate_app`; `flow-create-app-from-starter.json` executes `xvibe.create_app_from_starter`. | In `server/src/main.ts`, import `XVibeModule` from `@xpell/vibe` and pass `new XVibeModule()` in `node.start({ _modules: [...] })`. |
| `xai-router/server` | Yes | Yes | `system-xapps/vibe-system/flows/flow-generate-app.json` executes `xvibe.generate_app`. | In `server/src/main.ts`, import `XVibeModule` from `@xpell/vibe` and pass it through `_modules`. |
| `reut-music-player/server` | Yes | Yes | Same Vibe system flows as starter, plus the app uses the same Visual/XStudio pattern. | In `server/src/main.ts`, import `XVibeModule` from `@xpell/vibe` and pass it through `_modules`. |
| `xpell-agent/packages/agent-core` | No direct need found | It would inherit implicit loading if moved to current `@xpell/node` | No `_module: "xvibe"` commands found under `xpell-agent/packages`; it is a generic agent runtime with its own modules and transport. | Eventually call `xnode.start({ _load_vibe: false, ... })`. No `XVibeModule` import. Also reconcile current non-underscored option names before adopting current `@xpell/node`. |
| `xpell-node-test/xnode-test` | No | Yes, only by calling `XNode.start()` | Test is XDB/user-module focused and has no `xvibe` commands. | Eventually call `start({ _load_vibe: false })`. No `XVibeModule` import. Also update old `xpell-node` package import if this test is brought to current package naming. |
| `packages/xpell-ui` XStudio surfaces | Vibe features need it | Runtime assumes server has module `xvibe` for Vibe actions | `_send_xvibe_command()` sends module commands to `xvibe`; tests include `xvibe` command envelopes. | Do not import server XVibe in UI. Gate Vibe UI actions by server capabilities/module availability and surface `E_XVIBE_NOT_ENABLED` cleanly. |
| `@xpell/node` `XStudioModule` | Vibe features need it | Yes | Server Studio ops forward to `_x.execute({ _module: "xvibe", ... })`. | Keep loading after the Vibe decision; guard Vibe-only ops when `xvibe` is absent. |

Other scanned source consumers:

- No downstream app directly imports `@xpell/vibe`.
- No downstream app imports `@xpell/node/.../XVIBE/...`.
- `xai-providers` consumes generic `@xpell/node` APIs but does not start XNode or require XVibe.

## 5. Recommended Compatibility Strategy

### Strategy A: Add `_modules` while keeping automatic XVibe loading temporarily

Assessment: good first step, but incomplete by itself.

Pros:

- Backward compatible.
- Lets Vibe apps move to explicit composition.
- Gives generic server composition a clean API.

Cons:

- If implicit XVibe remains silent forever, applications have no migration signal.
- Generic servers still get XVibe unless another switch exists.

### Strategy B: Add `_modules` plus a deprecation warning for implicit XVibe loading

Assessment: recommended, with a scoped warning.

The warning should fire only when:

- `_load_vibe` is not explicitly set;
- no supplied module has `_name === "xvibe"`;
- `XNode` loads XVibe through compatibility behavior.

Avoid warning when:

- the app explicitly supplies `XVibeModule`;
- the app sets `_load_vibe: false`;
- the app sets `_load_vibe: true` intentionally.

### Strategy C: Add compatibility option `_load_vibe`

Assessment: required for no-Vibe validation and generic server adoption.

Recommended behavior during migration:

```ts
_load_vibe?: boolean; // default true in compatibility phase
```

- `undefined`: load XVibe implicitly for backward compatibility and warn once.
- `true`: load XVibe implicitly if no explicit `xvibe` module is supplied; no deprecation warning because the app opted in.
- `false`: do not load XVibe implicitly.

This option should not remove automatic loading in the first implementation.

### Strategy D: Introduce a separate Vibe-enabled XNode preset/helper

Assessment: useful later, not sufficient as the first step.

Examples:

```ts
import { XVibeModule } from "@xpell/vibe";

await node.start({
  ...createVibeNodeOptions(),
  _modules: [new XVibeModule()]
});
```

or a small package such as `@xpell/node-vibe` that depends on both `@xpell/node` and `@xpell/vibe`.

This is attractive after `@xpell/node` no longer depends on `@xpell/vibe`. It should not replace generic `_modules`, because host apps still need to compose their own modules.

### Strategy E: Immediate breaking removal

Assessment: reject.

Immediate removal would break:

- existing Vibe demo/product servers;
- persisted system flows that execute `_module: "xvibe"`;
- server XStudio operations that forward to XVibe;
- UI Studio flows that send `xvibe` commands;
- the current `@xpell/node` root XVibe export contract.

### Recommended staged strategy

Use A + B + C now, optionally D later:

1. Add `_modules`.
2. Add `_load_vibe` defaulting to `true`.
3. Keep automatic XVibe loading.
4. Warn only for implicit compatibility loading.
5. Skip implicit XVibe when an explicit supplied module named `xvibe` exists.
6. Migrate consumers.
7. Validate generic startup with `_load_vibe: false`.
8. In a later breaking phase, flip/remove implicit loading.

## 6. Module Ordering and Duplicate Policy

### Current ordering risk

Current source loads XVibe before FlowManager, EntityManager, XStudio, and ServerXVM. This works today because XVibe mostly resolves host modules at operation time through `_x.execute(...)` or `_x.getModule(...)`, not during `onLoad()`.

For explicit optional composition, the order should become more contract-driven.

### Recommended host order before XVibe

Before loading XVibe explicitly or implicitly, XNode should load host infrastructure that XVibe can require at runtime:

1. core runtime from `_x.start()` (`xd`, `xem`);
2. XDB when configured by XNode;
3. `ping`;
4. `wormholes`;
5. `xauth`;
6. `xai`;
7. `module-creator`;
8. `xmutator`;
9. `flow`;
10. `entity-manager`;
11. `server-xvm` with `init_on_boot()`.

Strictly required by `XVibeModule._skill`: `xmodule`, `xai`, `server-xvm`, and `module-creator`.

Operationally required by common XVibe features:

- `server-xvm` for app/view/flow/entity/project-memory persistence;
- `xai` for generation;
- `module-creator` for generated module specs;
- `flow` for persisted flow execution paths;
- `entity-manager` for CRUD/entity artifact paths;
- `wormholes` and XVM broadcasting support for live updates;
- XDB when entity/runtime persistence is in play.

`XStudioModule` should load after the Vibe decision and should guard Vibe-only ops if `xvibe` is absent.

### Recommended `_modules` order

Recommended first implementation:

1. Load host built-ins through `server-xvm`.
2. Inspect `options._modules` for a module named `xvibe`.
3. If an explicit `xvibe` module exists:
   - do not load implicit XVibe;
   - load supplied modules sequentially in the order provided.
4. If no explicit `xvibe` exists and `_load_vibe !== false`:
   - load compatibility XVibe;
   - then load supplied modules sequentially.
5. If `_load_vibe === false`:
   - do not load compatibility XVibe;
   - load supplied modules sequentially.
6. Load `XStudioModule` after this sequence, or gate its Vibe-only ops if it remains auto-loaded without Vibe.

This preserves old behavior for apps that expect `xvibe` to exist by the time app modules load, while giving explicit Vibe apps control by including `new XVibeModule()` in `_modules`.

### Duplicate module-name policy

Current core behavior is "first wins, duplicates are skipped." That is too quiet for explicit startup composition.

Recommended XNode-level policy:

- Built-in duplicate caused by compatibility implicit XVibe:
  - if `_modules` contains `_name: "xvibe"`, skip implicit XVibe.
  - do not warn about implicit loading because it did not happen.
- Duplicate names inside `options._modules`:
  - fail startup with a structured error such as `E_XNODE_DUPLICATE_MODULE`.
- Supplied module duplicates an already loaded non-Vibe built-in:
  - fail startup by default. Do not silently skip a user-supplied module.
- Existing global preloaded module duplicate:
  - for migration, detect with `_x.getModule(name)` before loading supplied modules and fail with a clear message unless an explicit documented override policy is added later.

Do not introduce replacement/override semantics until there is a clear module unload or override contract in core.

### Supplied module load failure

Current `loadModuleAsync()` can leave a failed module registered because it registers before awaiting `load()`.

Recommended XNode behavior:

- load supplied modules sequentially;
- if a supplied module throws during load, reject `XNode.start()`;
- include module `_name` in the error;
- do not continue loading later modules;
- keep `_started = false`;
- document the current core limitation that the failed module may remain in `_x` until core has an unload/rollback primitive.

Do not silently continue after a supplied module fails. Optional modules must fail loudly when explicitly supplied.

## 7. Package and Export Transition

Current package state:

- `@xpell/node` has dependency `"@xpell/vibe": "workspace:*"`.
- `src/XServer/XNode.ts` statically imports `XVibeModule` from `@xpell/vibe`.
- `src/index.ts` has `export * from "@xpell/vibe"`.
- `src/XVIBE/**` files are compatibility forwarders to `@xpell/vibe/XVIBE/**`.
- `@xpell/vibe` currently has its own package with `@xpell/core` peer dependency and `@xpell/node-core` dependency.
- Both `@xpell/node` and `@xpell/vibe` currently declare MIT license in package metadata.

Static imports and root static re-exports make `@xpell/vibe` mandatory. `@xpell/node` cannot become a generic no-Vibe package while those remain.

Later removal sequence:

1. Keep `@xpell/vibe` as a hard dependency while implicit loading and root re-exports remain.
2. Add `_modules` and `_load_vibe` without changing dependencies.
3. Migrate Vibe consumers to direct `@xpell/vibe` dependency/import and explicit `new XVibeModule()` composition.
4. Add feature gates for XStudio and flows when `xvibe` is absent.
5. Change `XNode` compatibility loading from static import to dynamic optional import only after the package dependency plan is ready.
6. Remove `export * from "@xpell/vibe"` from `src/index.ts` in a breaking release or replace it with a separately documented Vibe entrypoint/package.
7. Remove `src/XVIBE/**` compatibility forwarders in the same breaking window, or keep them only in a dedicated compatibility package that depends on `@xpell/vibe`.
8. Remove `@xpell/vibe` from `@xpell/node` dependencies.
9. If needed, declare `@xpell/vibe` as an optional peer for documentation/tooling only, but do not statically import it from the generic entrypoint.
10. Apply a separate license to `@xpell/vibe` only after `@xpell/node` no longer has a mandatory dependency on it.

Licensing implication:

- If `@xpell/vibe` later becomes source-available/non-commercial, `@xpell/node` should not keep it as an unconditional dependency for generic commercial runtime users.
- Do not change `@xpell/node` license as part of the module-composition migration.

## 8. Missing-Module Behavior

Current low-level behavior:

- `_x.execute({ _module: "xvibe", ... })` throws the string `"Xpell module xvibe not loaded"` if `xvibe` is absent.
- Wormholes wraps that as a generic internal failed response.
- FlowManager catches step execution throws and returns `FLOW_STEP_ERROR` with raw error details.
- XStudio UI currently checks server readiness, not `xvibe` capability specifically.

Recommended behavior when `xvibe` is not installed or not enabled:

- Generic servers should boot successfully with no `xvibe` module.
- `XNode.start({ _load_vibe: false })` should be a supported no-Vibe path.
- Server XStudio Vibe-only ops should check `_x.getModule("xvibe")` and return a structured failure such as:

```json
{
  "_ok": false,
  "_result": {
    "_code": "E_XVIBE_NOT_ENABLED",
    "_message": "XVibe is not enabled on this XNode runtime."
  }
}
```

- UI Studio should discover server capabilities or handle `E_XVIBE_NOT_ENABLED` by disabling Vibe actions and showing a product-level unavailable state, not a raw transport/internal error.
- FlowManager should eventually preflight step module availability and return a clearer flow error such as `FLOW_MODULE_NOT_AVAILABLE` with `_module`, `_op`, `_flow_id`, and `_step_id`.
- Persisted flows that reference `xvibe` may still exist on disk. They should fail only when executed on a no-Vibe server, not during generic server boot or app load.
- Generic server docs should state that Vibe flows and Studio generation require explicit installation and module composition.

## 9. Risks

| Risk | Severity | Notes | Mitigation |
| --- | --- | --- | --- |
| Silent duplicate skip hides misconfiguration | High | Core currently skips duplicates without throwing. | Add XNode-level duplicate checks for supplied modules. |
| Startup order regression | High | XVibe currently loads before some host modules, but optional composition should make host readiness explicit. | Move host modules before Vibe in the composition path and add smoke tests. |
| Static export keeps dependency mandatory | High | `export * from "@xpell/vibe"` requires the package even when Vibe is disabled. | Remove root re-export only after consumer migration and breaking-release notice. |
| XStudio assumes Vibe exists | High | Server and UI Studio send many `xvibe` commands. | Add capability checks and `E_XVIBE_NOT_ENABLED` handling. |
| Persisted flows break on no-Vibe servers | Medium | Vibe system flows execute `xvibe.generate_app` and `xvibe.create_app_from_starter`. | Keep flows loadable; fail clearly only on execution; migrate Vibe apps to explicit composition. |
| `xpell-agent` option shape drift | Medium | It uses old non-underscored XNode options and pinned older `@xpell/node`. | Reconcile options before moving it to current `@xpell/node`; use `_load_vibe: false`. |
| Partial module registration on load failure | Medium | Core registers before `load()` resolves. | Fail startup loudly and document limitation until core supports unload/rollback. |
| License boundary confusion | High | A mandatory non-commercial Vibe dependency would affect generic node adoption. | Make Vibe optional before applying separate Vibe license. |

## 10. Phased Plan

1. Add generic module composition:
   - add `XNodeOptions._modules?: XModule[]`;
   - add `XNodeOptions._load_vibe?: boolean`;
   - keep automatic XVibe loading defaulted on;
   - add scoped deprecation warning for implicit loading.

2. Define and test duplicate behavior:
   - explicit `XVibeModule` prevents implicit loading;
   - supplied duplicate module names fail;
   - implicit XVibe never replaces an explicit module.

3. Migrate Vibe consumers:
   - `xpell-vibe-starter/server`;
   - `xai-router/server`;
   - `reut-music-player/server`;
   - any package that ships Vibe system flows.

4. Gate Vibe-dependent surfaces:
   - server `XStudioModule`;
   - UI XStudio actions;
   - FlowManager step errors for missing modules.

5. Validate generic no-Vibe startup:
   - `XNode.start({ _load_vibe: false })` boots;
   - no `@xpell/vibe` module is registered;
   - generic `ping`, Wormholes, XDB, XAuth, XAI, ServerXVM, FlowManager, EntityManager, and app modules still work as applicable.

6. Remove implicit loading in a breaking phase:
   - require explicit `new XVibeModule()` for Vibe apps;
   - keep a clear migration note.

7. Remove package coupling:
   - remove static XVibe import from `XNode`;
   - remove `export * from "@xpell/vibe"`;
   - remove `src/XVIBE/**` compatibility forwarders;
   - remove `@xpell/vibe` from `@xpell/node` dependencies.

8. Apply separate Vibe license:
   - license `@xpell/vibe` independently;
   - keep `@xpell/node` generic runtime licensing separate;
   - add legal/package docs for Vibe-enabled apps.

## 11. Immediate Next Implementation Task

Implement the compatibility composition layer only:

- add `XNodeOptions._modules?: XModule[]`;
- add `XNodeOptions._load_vibe?: boolean`;
- keep automatic XVibe loading;
- skip implicit XVibe when `_modules` already contains a module with `_name === "xvibe"`;
- emit one deprecation warning only for implicit compatibility loading;
- load supplied modules with `await _x.loadModuleAsync(...)`;
- add focused tests for implicit Vibe, explicit Vibe, no-Vibe startup, and duplicate supplied module names.

Do not remove automatic XVibe loading, dependencies, exports, forwarders, or licenses in that task.
