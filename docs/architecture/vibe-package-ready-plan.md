# XVibe Package-Ready Extraction Plan

Date: 2026-07-17
Scope: current working tree under `packages/xnode`
Task constraint: investigation and file mapping only. No source move, production code edit, or new package creation has been performed.

## 1. Package-Readiness Verdict

Verdict: package-ready for a first copy-based extraction, with host-runtime integration risks that must be handled in `@xpell/node`.

Current source truth:

- Static import scan covered all 53 TypeScript files under `src/XVIBE/**`.
- No static relative import escapes `src/XVIBE/**`.
- No `src/XVIBE/**` file statically imports any file from `packages/xnode/src/**` outside XVIBE.
- Static dependencies under XVIBE are only:
  - Node built-ins: `node:fs`, `node:fs/promises`, `node:path`, `node:url`.
  - Packages: `@xpell/core`, `@xpell/node-core`.
  - Internal XVIBE relative imports.
- The prior direct `../XVM/ProjectMemoryAchievements.js`, `../XVM/ProjectMemoryMilestones.js`, and `../Wormholes/wh.index.js` compile-time blockers are no longer present in current `src/XVIBE/**`.

Import scan summary:

| Metric | Current value |
| --- | ---: |
| TypeScript files inspected | 53 |
| Import/export specifiers classified | 231 |
| Internal XVIBE specifiers | 161 |
| Package specifiers | 57 |
| Node built-in specifiers | 13 |
| Relative imports outside `src/XVIBE` | 0 |

This means XVibe can be copied into `packages/vibe` without carrying direct compile-time dependencies on `@xpell/node` implementation files.

Package readiness is not the same as standalone runtime readiness. XVibe still assumes host modules at runtime through `_x.execute(...)` and `_x.getModule(...)`: `server-xvm`, `xai`, `module-creator`, `wormholes`, `flow`, and `entity-manager`. That is acceptable if `@xpell/vibe` is defined as a server-side Xpell module package hosted by `@xpell/node`, not as an independent server runtime.

## 2. Exact Files/Resources To Extract

### Source Files

Copy these files exactly first:

```text
packages/xnode/src/XVIBE/Archive/RunArchiveManager.ts
packages/xnode/src/XVIBE/Artifact/ArtifactExecutor.ts
packages/xnode/src/XVIBE/Artifact/ArtifactRelationshipRegistry.ts
packages/xnode/src/XVIBE/Artifact/ArtifactResolver.ts
packages/xnode/src/XVIBE/Capability/CapabilityRegistry.ts
packages/xnode/src/XVIBE/Capability/index.ts
packages/xnode/src/XVIBE/Conversation/ConversationManager.ts
packages/xnode/src/XVIBE/ExecutionGraph/CapabilityRegistry.ts
packages/xnode/src/XVIBE/ExecutionGraph/ExecutionGraphExecutor.ts
packages/xnode/src/XVIBE/ExecutionGraph/ExecutionGraphPlanner.ts
packages/xnode/src/XVIBE/ExecutionGraph/ExecutionRecipes.ts
packages/xnode/src/XVIBE/Generation/GenerationManager.ts
packages/xnode/src/XVIBE/Guide/GuideRecommendationEngine.ts
packages/xnode/src/XVIBE/Intent/IntentConversationBridge.ts
packages/xnode/src/XVIBE/IntentMemory/IntentMemoryStore.ts
packages/xnode/src/XVIBE/Processors/AddFieldProcessor.ts
packages/xnode/src/XVIBE/Processors/CapabilityGuidanceProcessor.ts
packages/xnode/src/XVIBE/Processors/CrudProcessor.ts
packages/xnode/src/XVIBE/Processors/DeleteFieldProcessor.ts
packages/xnode/src/XVIBE/Processors/DeprecateFieldProcessor.ts
packages/xnode/src/XVIBE/Processors/DeterministicIntentProcessor.ts
packages/xnode/src/XVIBE/Processors/EntityProcessor.ts
packages/xnode/src/XVIBE/Processors/FlowProcessor.ts
packages/xnode/src/XVIBE/Processors/FormProcessor.ts
packages/xnode/src/XVIBE/Processors/LearnedIntentProcessor.ts
packages/xnode/src/XVIBE/Processors/MutationPlanningProcessor.ts
packages/xnode/src/XVIBE/Processors/PlanningProcessor.ts
packages/xnode/src/XVIBE/Processors/PlanningSessionProcessor.ts
packages/xnode/src/XVIBE/Processors/ProjectMemoryFocusProcessor.ts
packages/xnode/src/XVIBE/Processors/RenameFieldProcessor.ts
packages/xnode/src/XVIBE/Processors/RestoreDeprecatedFieldProcessor.ts
packages/xnode/src/XVIBE/Processors/SemanticIntentProcessor.ts
packages/xnode/src/XVIBE/Processors/TableProcessor.ts
packages/xnode/src/XVIBE/Processors/XVibeIntentProcessor.ts
packages/xnode/src/XVIBE/ProjectMemory/Milestones.ts
packages/xnode/src/XVIBE/ProjectMemoryAchievements.ts
packages/xnode/src/XVIBE/Runtime/RuntimeContextManager.ts
packages/xnode/src/XVIBE/StructuredEditing/ProjectViewResolution.ts
packages/xnode/src/XVIBE/StructuredEditing/SemanticViewEditPreflight.ts
packages/xnode/src/XVIBE/StructuredEditing/StructuredViewEdit.ts
packages/xnode/src/XVIBE/StructuredEditing/ViewTargetResolution.ts
packages/xnode/src/XVIBE/VibeArtifactFactory.ts
packages/xnode/src/XVIBE/VibeBehaviorPlanner.ts
packages/xnode/src/XVIBE/VibeIntentPlanner.ts
packages/xnode/src/XVIBE/VibeKnowledgeSelector.ts
packages/xnode/src/XVIBE/VibeOutputParser.ts
packages/xnode/src/XVIBE/VibePromptBuilder.ts
packages/xnode/src/XVIBE/VibeViewBuilder.ts
packages/xnode/src/XVIBE/XVibeIntentEngine.ts
packages/xnode/src/XVIBE/XVibeModule.ts
packages/xnode/src/XVIBE/XVibePlanner.ts
packages/xnode/src/XVIBE/XVibeTypes.ts
packages/xnode/src/XVIBE/index.ts
```

### Tests

Current maintained XVibe coverage lives inside the monolithic:

```text
packages/xnode/src/test.ts
```

Extraction map:

- Split XVibe-specific imports, helpers, fixtures, and assertions from `packages/xnode/src/test.ts` into `packages/vibe/src/test.ts` or `packages/vibe/tests/xvibe.test.ts`.
- Keep `@xpell/node` integration smoke coverage in `packages/xnode/src/test.ts` after compatibility re-export and optional registration changes.
- Do not move unrelated XDB, XVM, Wormholes, XAuth, FlowManager, or EntityManager tests into `@xpell/vibe`.

The first implementation task should not try to perfectly refactor the whole monolithic test file. Copy the file into the new package as a temporary package test harness, prune only the clearly unrelated imports/blocks needed to compile, then follow up with a focused test split.

### Docs

Move or copy into `packages/vibe/docs/architecture/`:

```text
packages/xnode/docs/architecture/vibe-package-extraction-investigation.md
packages/xnode/docs/architecture/vibe-remaining-dependencies.md
packages/xnode/docs/architecture/project-memory-ownership.md
packages/xnode/docs/architecture/vibe-package-ready-plan.md
```

Keep in `packages/xnode/docs/architecture/` as node-host context, or replace with links after extraction:

```text
packages/xnode/docs/architecture/wormholes-xmodule-investigation.md
packages/xnode/docs/architecture/node-core-package-investigation.md
```

`packages/xnode/docs/AGENTS.md` is repo-local guidance, not package runtime content. If `packages/vibe` is created, add its own `docs/AGENTS.md` or root `AGENTS.md` with the same server-only Xpell contract.

### Skills And Prompt Resources

Current `src/XVIBE/**` does not bundle prompt template files. Prompt contracts are TypeScript literals in:

```text
packages/xnode/src/XVIBE/VibePromptBuilder.ts
packages/xnode/src/XVIBE/Processors/SemanticIntentProcessor.ts
```

Current `VibeKnowledgeSelector` can load static skill JSON from:

```text
<process.cwd()>/skills/xpell
<process.cwd()>/../skills/xpell
```

No `skills/xpell` tree exists inside `packages/xnode`. The Vibe product starter currently has one:

```text
xpell-vibe-starter/skills/xpell/index.json
xpell-vibe-starter/skills/xpell/entity-runtime.json
xpell-vibe-starter/skills/xpell/xdashboard.json
xpell-vibe-starter/skills/xpell/xdb-entity.json
xpell-vibe-starter/skills/xpell/xfm-flow.json
xpell-vibe-starter/skills/xpell/xpell-contract.json
xpell-vibe-starter/skills/xpell/xpell-core.json
xpell-vibe-starter/skills/xpell/xui-core.json
xpell-vibe-starter/skills/xpell/xui-data-binding.json
xpell-vibe-starter/skills/xpell/xui-events.json
xpell-vibe-starter/skills/xpell/xui-flow-trigger.json
xpell-vibe-starter/skills/xpell-skill.schema.json
```

Packaging decision:

- Do not silently move app-owned starter skills into core `@xpell/vibe` unless they are intended as default Vibe prompt knowledge.
- If they are defaults, package them under `packages/vibe/skills/xpell/**` and update `VibeKnowledgeSelector` defaults to check `XVIBE_PACKAGE_ROOT/skills/xpell` before cwd fallbacks.
- If they remain product-owned, document that Vibe apps must provide `skills/xpell` or call `xvibe.sync-skills` with runtime snapshots.

### Starter Assets

Current `@xpell/node` package starters used by `XVibeModule.create_app_from_starter`:

```text
packages/xnode/system-xapps/app-starters/dashboard/app.json
packages/xnode/system-xapps/app-starters/dashboard/views/main.json
packages/xnode/system-xapps/app-starters/dashboard/assets/empty-state.svg
packages/xnode/system-xapps/app-starters/dashboard/assets/logo.svg
packages/xnode/system-xapps/app-starters/dashboard/assets/placeholder-record.svg
packages/xnode/system-xapps/app-starters/dashboard/style/custom.css
```

Extraction map:

```text
packages/xnode/system-xapps/app-starters/** -> packages/vibe/system-xapps/app-starters/**
```

Do not move `packages/xnode/system-xapps/view-starters/**` into `@xpell/vibe` as part of this extraction. ServerXVM owns view starter lookup and currently resolves view starters through node/system-xapps paths.

Product starter resources found outside `packages/xnode`:

```text
xpell-vibe-starter/server/system-xapps/vibe-system/**
xpell-vibe-starter/server/system-xapps/app-starters/**
xai-router/server/system-xapps/vibe-system/**
```

These are product app resources, not required core `@xpell/vibe` package resources. They do depend on the `xvibe` module name and must be validated after optional loading is introduced.

### Runtime Resources And Stores

These resources are runtime-generated and must not be packaged as static source:

```text
<work_folder>/xvm/apps/<env>/<app_id>/conversations/**
<work_folder>/xvm/apps/<env>/<app_id>/intent-memory/learned-intents.json
<work_folder>/xvm/apps/<env>/<app_id>/vibe-runs/**
<work_folder>/xvm/apps/<env>/<app_id>/project-memory.json
<work_folder>/public/<app_id>/**
```

The package must preserve path-safe file handling for those stores, but they remain host work-folder data.

## 3. Target Package Structure

Recommended first target:

```text
packages/vibe/
  package.json
  tsconfig.json
  README.md
  LICENSE
  docs/
    AGENTS.md
    architecture/
      vibe-package-ready-plan.md
      vibe-package-extraction-investigation.md
      vibe-remaining-dependencies.md
      project-memory-ownership.md
  src/
    index.ts
    XVIBE/
      index.ts
      XVibeModule.ts
      XVibeTypes.ts
      ...
  system-xapps/
    app-starters/
      dashboard/
        app.json
        views/main.json
        assets/*.svg
        style/custom.css
  skills/
    xpell/
      index.json
      *.json
    xpell-skill.schema.json
  tests/
    xvibe.test.ts
```

Keep the `src/XVIBE/**` folder in the first extraction. `XVibeModule.ts` currently computes:

```ts
const XVIBE_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
```

That resolves correctly only if compiled files live under `dist/XVIBE/**`. Flattening files into `src/` would make the compiled `dist/XVibeModule.js` resolve one directory too high. Either keep `src/XVIBE/**` or update the package-root calculation in the same extraction task.

`packages/vibe/src/index.ts` should be a small root barrel:

```ts
export * from "./XVIBE/index.js";
```

### package.json

Recommended initial package manifest:

```json
{
  "name": "@xpell/vibe",
  "version": "2.0.4",
  "publishConfig": {
    "access": "public"
  },
  "description": "XVibe server-side generation, planning, intent, and structured editing module for Xpell.",
  "type": "module",
  "types": "./dist/index.d.ts",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./XVIBE": {
      "types": "./dist/XVIBE/index.d.ts",
      "import": "./dist/XVIBE/index.js"
    },
    "./package.json": "./package.json"
  },
  "files": [
    "dist",
    "src",
    "types",
    "docs",
    "system-xapps",
    "skills",
    "README.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "tsc -p .",
    "test": "npm run build && node ./dist/test.js"
  },
  "peerDependencies": {
    "@xpell/core": "workspace:*"
  },
  "dependencies": {
    "@xpell/node-core": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^14.18.63",
    "@xpell/core": "^2.0.4",
    "typescript": "^4.9.5"
  },
  "engines": {
    "node": ">=14.0.0"
  }
}
```

No direct dependency on `@xpell/node` should be added to `@xpell/vibe`.

If the license is intended to differ from `@xpell/node`, set the package license explicitly during package creation and do not inherit the MIT package metadata by copy/paste.

### tsconfig

Use the `@xpell/node-core` convention:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ES2022",
    "rootDir": "./src",
    "outDir": "./dist",
    "moduleResolution": "node",
    "types": ["node"],
    "declaration": true,
    "declarationMap": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "**/*.test.ts"]
}
```

If the test file is placed in `src/test.ts`, keep the same current script shape. If tests move to `tests/`, add a test-specific `tsconfig.test.json` or include test files in the package build intentionally.

## 4. Required Node Compatibility Changes

### Dependency Wiring

In `packages/xnode/package.json`:

- Add `@xpell/vibe` only if Vibe remains bundled by default.
- Prefer `peerDependenciesMeta` optional wiring if licensing separation requires generic `@xpell/node` users to avoid the Vibe package:

```json
{
  "peerDependencies": {
    "@xpell/vibe": "workspace:*"
  },
  "peerDependenciesMeta": {
    "@xpell/vibe": {
      "optional": true
    }
  }
}
```

For a workspace-only first step, use a dev/workspace dependency while building the split, then decide final publish wiring before release.

### XNode Module Registration

Current source imports and loads XVibe directly:

```text
packages/xnode/src/XServer/XNode.ts
  import { XVibeModule } from "../XVIBE/XVibeModule.js";
  await _x.loadModuleAsync(new XVibeModule());
```

Later required change:

- Replace the local import with a package import when Vibe is enabled:

```ts
import { XVibeModule } from "@xpell/vibe";
```

- Or use a dynamic optional loader:

```ts
const vibe = await import("@xpell/vibe");
await _x.loadModuleAsync(new vibe.XVibeModule());
```

- Add an explicit `XNodeOptions` switch, for example `_vibe?: boolean | { _enabled?: boolean }`.
- Load Vibe after the host modules it uses are registered: `wormholes`, `xai`, `module-creator`, `server-xvm`, `flow`, and `entity-manager`. The current source can instantiate earlier because its dependencies are mostly command-bus lookups at operation time, but optional package loading should make the host contract explicit.

### Compatibility Re-Exports

Current public top-level export:

```text
packages/xnode/src/index.ts
  export * from "./XVIBE/index.js"
```

Later required change:

```ts
export * from "@xpell/vibe";
```

Compatibility options:

- Keep `@xpell/node` root re-exports for existing consumers:
  - `import { XVibeModule } from "@xpell/node"`
- Add `packages/xnode/src/XVIBE/index.ts` as a forwarder to preserve package-file-path imports inside the monorepo:
  - `export * from "@xpell/vibe";`
- Avoid preserving every deep private helper import unless an external consumer audit proves it is required. Root exports should be the stable surface.

### Optional Vibe Loading For Licensing Separation

Recommended policy:

- Generic `@xpell/node` boots without Vibe unless explicitly enabled.
- Vibe products install `@xpell/vibe` and enable it in `XNode.start(...)`.
- When Vibe is disabled or missing, node should log a clear "Vibe not enabled" diagnostic, not fail generic server boot.
- Product flows and XStudio surfaces that send `_module: "xvibe"` must detect module absence and show a clear feature-gating error.
- If `@xpell/node` keeps Vibe loaded by default, generic consumers inherit the Vibe package and its license. That weakens the intended separation.

## 5. Runtime/Resource Risks

### XVIBE_PACKAGE_ROOT

Current `XVIBE_PACKAGE_ROOT` is used by `XVibeModule.resolve_starters_root()` as the fallback:

```text
XVIBE_PACKAGE_ROOT/system-xapps/app-starters
```

Risk:

- If `src/XVIBE/XVibeModule.ts` is flattened to `src/XVibeModule.ts`, the root calculation breaks.
- If `system-xapps/app-starters` is not included in the `@xpell/vibe` package `files` list, `create_app_from_starter` fails unless `server-xvm._system_xapps_path` is configured.

Recommendation:

- Preserve `src/XVIBE/**` in the first copy.
- Include `system-xapps/app-starters/**` in `@xpell/vibe`.
- Add a package-root smoke test for `create_app_from_starter`.

### Static Skill Root

Current `VibeKnowledgeSelector` default roots are cwd-based:

```text
skills/xpell
../skills/xpell
```

Risk:

- Packaged `@xpell/vibe/skills/xpell` would not be discovered without a code change.
- Product-owned `xpell-vibe-starter/skills/xpell` works only when the process cwd matches that app layout.

Recommendation:

- Decide whether `skills/xpell` is a Vibe package default or a product starter resource.
- If package default, update root resolution to include `XVIBE_PACKAGE_ROOT/skills/xpell`.
- If product-owned, document the runtime requirement and keep it out of package `files`.

### Host Module Runtime Dependencies

The source has no compile-time import of these host modules, but runtime behavior requires them:

| Host module | Current use |
| --- | --- |
| `server-xvm` | App/view/flow/entity/project-memory reads and writes, starter loading, work-folder discovery. |
| `xai` | Semantic intent and AI artifact generation through command bus. |
| `module-creator` | Generated module spec validation/generation/loading. |
| `wormholes` | Generation stage/complete/failed broadcast through command bus. |
| `flow` | Generated flow command contracts and runtime execution by host. |
| `entity-manager` | Entity registration and record migration through generated/planned commands. |

Risk:

- `@xpell/vibe` can compile without `@xpell/node`, but operations fail at runtime if the host has not registered the required modules.

Recommendation:

- Keep `_skill._requires` aligned with current runtime requirements.
- Add host-readiness checks or clear structured errors around operations that require missing modules.
- Keep generic `@xpell/vibe` docs explicit that it is a server module hosted by a Xpell runtime.

### Work-Folder Stores

Conversation, learned intent, and run archive stores are file-backed under the host work folder. They are package-ready because they use Node built-ins and path-inside validation, but they are not portable browser resources.

Recommendation:

- Mark `@xpell/vibe` as server-only.
- Keep `types: ["node"]`.
- Do not add DOM/browser targets.

### Dirty-Tree Context

This investigation used the current working tree, which already contains uncommitted changes and untracked architecture docs/source files related to Wormholes and Project Memory. The readiness verdict applies to that current tree, not necessarily to the last committed revision.

## 6. Recommended First Implementation Task

First implementation task: copy, do not move.

Reasoning:

- Copying preserves the current `@xpell/node` module, tests, and public exports while `@xpell/vibe` is made to compile independently.
- It avoids breaking Vibe products while compatibility re-exports and optional node loading are implemented.
- It allows package-root, starter asset, and skill-root behavior to be tested before deleting the old tree.
- The worktree is already dirty, so a move would make review and rollback harder.

Concrete first task:

1. Create `packages/vibe` with `package.json`, `tsconfig.json`, `src/index.ts`, and copied `src/XVIBE/**`.
2. Copy `packages/xnode/system-xapps/app-starters/**` into `packages/vibe/system-xapps/app-starters/**`.
3. Copy the current architecture docs listed above.
4. Add a temporary package test harness from the XVibe portions of `packages/xnode/src/test.ts`.
5. Build `@xpell/vibe`.
6. Only after that succeeds, update `@xpell/node` to import/re-export `@xpell/vibe` and add optional registration.
7. After compatibility tests pass, remove or replace the old `packages/xnode/src/XVIBE/**` implementation with forwarders.

Validation commands used for this report:

```text
rg --files src/XVIBE
rg -n "^\\s*(import|export)\\s.+from\\s+['\\\"]|^\\s*import\\s*\\(['\\\"]|require\\(['\\\"]" src/XVIBE
node -e '<static import classifier for src/XVIBE>'
rg -n "XVIBE_PACKAGE_ROOT|system-xapps|app-starters|skills/xpell|runtime_skills|starter" src/XVIBE
find system-xapps -maxdepth 5 -type f
find ../../../xpell.ai/xpell-vibe-starter/skills/xpell -maxdepth 2 -type f
```
