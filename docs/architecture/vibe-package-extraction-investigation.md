# @xpell/vibe Package Extraction Investigation

Status: Proposed  
Scope: Architecture and licensing boundary investigation  
Implementation state: No extraction performed  
Primary motivation: Separate XVibe into a source-available/non-commercial package before launch

This document persists the completed repository investigation for extracting XVibe from `@xpell/node` into a future `@xpell/vibe` package. It is an architecture and launch-boundary assessment only. No files have been moved, no package has been created, and no production code changes are implied by this document.

Path references use monorepo-relative link text. Markdown targets are relative to this document so they remain usable from `packages/xnode/docs/architecture`.

## 1. Executive Summary

Do not perform a direct file move yet.

XVibe is currently embedded inside `@xpell/node` as a server-side Xpell generation, intent, planning, structured editing, conversation, and artifact orchestration layer. The source tree under `packages/xnode/src/XVIBE/**` is conceptually extractable, but the current implementation still reaches into `@xpell/node` server composition through ServerXVM, Wormholes broadcasting, XAI generation, EntityManager record migration, Project Memory, and filesystem-backed app state.

The intended dependency direction is:

```text
@xpell/core
        ↑
@xpell/node-core
        ↑
@xpell/vibe
        ↑
@xpell/node host adapters/composition
```

That direction is valid only after concrete server dependencies are inverted. In the current source, `@xpell/vibe` cannot safely depend only on `@xpell/core` and `@xpell/node-core` without introducing host contracts for app/view/flow/entity/project-memory access, model generation, broadcasting, events, and file persistence.

The recommended path is a staged extraction:

- First introduce in-place host contracts inside the current `packages/xnode/src/XVIBE` tree.
- Then migrate direct `server-xvm`, XAI, Wormholes, EntityManager, Project Memory, and filesystem dependencies behind default `@xpell/node` adapters.
- Only after those contracts are tested should the source move into a new package.

The launch/licensing conclusion is also material: `@xpell/vibe` should become a separately licensed source-available/non-commercial package, while generic commercial runtime applications should not automatically receive a mandatory non-commercial dependency. Therefore `@xpell/node` may need optional Vibe integration instead of an unconditional dependency on `@xpell/vibe`.

This is a repository-level technical assessment, not legal advice.

## 2. Current XVibe Architecture

Current truth:

- `XVibeModule` is an `XModule` with module name `xvibe`.
- Its skill requirements are currently declared as `["xmodule", "xai", "server-xvm", "module-creator"]` in [`packages/xnode/src/XVIBE/XVibeModule.ts:10732`](../../src/XVIBE/XVibeModule.ts#L10732).
- `@xpell/node` re-exports XVibe from [`packages/xnode/src/index.ts:135`](../../src/index.ts#L135) through `packages/xnode/src/XVIBE/index.ts`.
- `XNode.start()` boot-loads `new XVibeModule()` in [`packages/xnode/src/XServer/XNode.ts:176`](../../src/XServer/XNode.ts#L176).
- XVibe does not currently import XDB directly, but it reaches XDB-backed state through EntityManager and ServerXVM commands.

XVibe owns or orchestrates these responsibilities:

- Intent analysis through `XVibeIntentEngine` and ordered processors.
- App, view, flow, entity, command, module, and CRUD artifact planning.
- Deterministic structured view editing through `xvibe.apply-view-edit`.
- Mutation-plan analysis and sequential execution through `xvibe.apply-mutation-plan`.
- Conversation storage and tool-message intent recording.
- Learned intent storage and reuse.
- Runtime Project Memory awareness.
- Run archive diagnostics.
- Guide and capability recommendations.
- Starter app generation and app shell generation coordination.

XVibe does not own these boundaries:

- ServerXVM persistence and realtime app/view/flow state.
- Wormholes transport.
- XAI provider registration and provider secrets.
- EntityManager and XDB persistence.
- FlowManager runtime execution.
- XNode server bootstrap.
- XStudio server routes or browser UI execution.

Source drift correction preserved from the investigation: the current source exposes `append-flow-success-command` in `_ops` and implements `_append_flow_success_command`, even though the skill/API map previously omitted it. The relevant implementation points are [`packages/xnode/src/XVIBE/XVibeModule.ts:10910`](../../src/XVIBE/XVibeModule.ts#L10910) and [`packages/xnode/src/XVIBE/XVibeModule.ts:17707`](../../src/XVIBE/XVibeModule.ts#L17707).

## 3. Complete File / Responsibility Inventory

Candidate XVibe source files for eventual package extraction:

| Area | Files | Responsibility |
| --- | --- | --- |
| Module, exports, and types | `packages/xnode/src/XVIBE/index.ts`, `packages/xnode/src/XVIBE/XVibeModule.ts`, `packages/xnode/src/XVIBE/XVibeTypes.ts` | Public barrel, XModule command surface, core types. |
| Planning and generation | `packages/xnode/src/XVIBE/XVibePlanner.ts`, `packages/xnode/src/XVIBE/VibeIntentPlanner.ts`, `packages/xnode/src/XVIBE/VibeBehaviorPlanner.ts`, `packages/xnode/src/XVIBE/VibePromptBuilder.ts`, `packages/xnode/src/XVIBE/VibeKnowledgeSelector.ts`, `packages/xnode/src/XVIBE/VibeViewBuilder.ts`, `packages/xnode/src/XVIBE/VibeOutputParser.ts`, `packages/xnode/src/XVIBE/VibeArtifactFactory.ts` | Prompt construction, plan generation, artifact parsing, view generation, knowledge selection. |
| Intent engine and processors | `packages/xnode/src/XVIBE/XVibeIntentEngine.ts`, `packages/xnode/src/XVIBE/Processors/*.ts` | Ordered intent analysis, deterministic and semantic processors, CRUD/entity/flow/form/table planning. |
| Structured editing | `packages/xnode/src/XVIBE/StructuredEditing/StructuredViewEdit.ts`, `packages/xnode/src/XVIBE/StructuredEditing/ProjectViewResolution.ts`, `packages/xnode/src/XVIBE/StructuredEditing/ViewTargetResolution.ts`, `packages/xnode/src/XVIBE/StructuredEditing/SemanticViewEditPreflight.ts` | Canonical view-edit execution, project view resolution, target resolution, semantic preflight. |
| Artifact execution | `packages/xnode/src/XVIBE/Artifact/*.ts` | Artifact request execution, CRUD artifact application, entity and record mutation orchestration. |
| Execution graph | `packages/xnode/src/XVIBE/ExecutionGraph/*.ts` | Execution graph planning and execution, currently with a capability registry cycle where one edge is type-only. |
| Runtime context | `packages/xnode/src/XVIBE/Runtime/RuntimeContextManager.ts` | Work-folder resolution, Project Memory snapshot loading, runtime asset collection. |
| Conversation state | `packages/xnode/src/XVIBE/Conversation/ConversationManager.ts`, `packages/xnode/src/XVIBE/Intent/IntentConversationBridge.ts` | File-backed conversations, tool-message intent analysis, action and artifact status updates. |
| Intent memory and archives | `packages/xnode/src/XVIBE/IntentMemory/IntentMemoryStore.ts`, `packages/xnode/src/XVIBE/Archive/RunArchiveManager.ts` | Learned intent persistence and run archive diagnostics. |
| Capability and guide | `packages/xnode/src/XVIBE/Capability/*.ts`, `packages/xnode/src/XVIBE/Guide/GuideRecommendationEngine.ts` | User-visible capabilities and guide recommendations. |

Known non-XVibe files currently involved in XVibe composition or behavior:

| File | Current role |
| --- | --- |
| [`packages/xnode/src/XServer/XNode.ts:176`](../../src/XServer/XNode.ts#L176) | Boot-loads `XVibeModule`. |
| [`packages/xnode/src/index.ts:135`](../../src/index.ts#L135) | Re-exports XVibe from `@xpell/node`. |
| [`packages/xnode/src/XStudio/XStudioModule.ts:517`](../../src/XStudio/XStudioModule.ts#L517) | Server-side XStudio integration/forwarding surface. |
| [`packages/xnode/src/XVM/ProjectMemoryAchievements.ts:144`](../../src/XVM/ProjectMemoryAchievements.ts#L144) | Project Memory achievement logic currently coupled to ServerXVM state. |
| [`packages/xnode/src/XVM/ProjectMemoryMilestones.ts:1`](../../src/XVM/ProjectMemoryMilestones.ts#L1) | Project Memory milestone definitions. |
| [`packages/xnode/src/XVM/ProjectMemoryStage.ts:32`](../../src/XVM/ProjectMemoryStage.ts#L32) | Project Memory stage logic. |
| [`packages/xnode/src/XVM/ServerXVMModule.ts:523`](../../src/XVM/ServerXVMModule.ts#L523) | ServerXVM app/view/flow/project-memory persistence boundary. |
| [`packages/xnode/src/test.ts:23`](../../src/test.ts#L23) | Current maintained XVibe test coverage entry. |

## 4. Dependency Graph

Current direct and hidden dependency shape:

```text
packages/xnode/src/XVIBE/**
  -> @xpell/core
     XModule, XCommand, XResponse helpers, _x, _xlog, utility types

  -> @xpell/node local infrastructure
     _xu, _xem, work-folder utilities, settings-adjacent helpers

  -> ServerXVM through _x.execute
     app/view/flow/project-memory reads and writes

  -> XAI through _x.execute
     semantic intent generation and CRUD generation

  -> ModuleCreator through _x.execute
     generated module specs and module creation flows

  -> EntityManager through _x.execute
     entity registration, record mutation, record migration

  -> Wormholes
     scoped realtime broadcasts

  -> Node filesystem
     conversations, learned intents, run archives, starter app copying
```

Important source references:

- XAI generation calls are present in [`packages/xnode/src/XVIBE/Processors/SemanticIntentProcessor.ts:2428`](../../src/XVIBE/Processors/SemanticIntentProcessor.ts#L2428) and [`packages/xnode/src/XVIBE/Processors/CrudProcessor.ts:220`](../../src/XVIBE/Processors/CrudProcessor.ts#L220).
- Hidden XDB coupling appears through returned runtime entity data, `indexAll`, and `commit` behavior in [`packages/xnode/src/XVIBE/Artifact/ArtifactExecutor.ts:1052`](../../src/XVIBE/Artifact/ArtifactExecutor.ts#L1052).
- Wormholes is a direct compile dependency through `wsBroadcastScoped` in [`packages/xnode/src/XVIBE/XVibeModule.ts:7`](../../src/XVIBE/XVibeModule.ts#L7) and [`packages/xnode/src/XVIBE/StructuredEditing/StructuredViewEdit.ts:4`](../../src/XVIBE/StructuredEditing/StructuredViewEdit.ts#L4).
- `ExecutionGraphPlanner.ts` and `CapabilityRegistry.ts` currently form a cycle, with one edge type-only.

Extraction must remove all `@xpell/node` runtime imports from the future `@xpell/vibe` package. A package that imports `@xpell/node` cannot sit below `@xpell/node` in the dependency graph.

## 5. Proposed @xpell/vibe Boundary

The future `@xpell/vibe` package should own:

- `XVibeModule` and the `xvibe` XModule command surface.
- XVibe intent engine and processors.
- Prompt builders, planners, parsers, and artifact factories.
- Structured view edit canonicalization, resolution, and mutation logic.
- Mutation-plan compilation and execution orchestration.
- Artifact request and execution graph logic.
- Conversation, learned-intent, and run archive domain logic.
- Runtime context enrichment logic, after host-backed reads are injected.
- Capability and guide recommendation logic.
- Public XVibe types and stable helper exports.

`@xpell/vibe` should not own:

- XNode boot lifecycle.
- ServerXVM file layout and persistence mechanics.
- Wormholes transport implementation.
- XAI provider registry or API key settings.
- EntityManager/XDB implementation.
- FlowManager runtime execution.
- XStudio server routes.
- Package-level compatibility exports from `@xpell/node`.

The proposed dependency direction remains:

```text
@xpell/core
        ↑
@xpell/node-core
        ↑
@xpell/vibe
        ↑
@xpell/node host adapters/composition
```

This direction is only valid after concrete server dependencies are inverted behind contracts. Until then, moving files directly would either create circular dependencies or force `@xpell/vibe` to depend on `@xpell/node`, which defeats the extraction.

Uncertain packaging area: bundled/default skill JSON resources and any runtime prompt assets should be audited before publication. The current source consumes runtime skills and external folders; package files and npm pack behavior need a dedicated resource audit.

## 6. Components That Must Remain In @xpell/node

These components should remain in `@xpell/node`:

- `XNode` startup, runtime composition, module load order, XDB bootstrap, settings, and server lifecycle.
- `ServerXVMModule`, including app/view/flow/project-memory persistence and realtime app state.
- Wormholes transport and `wsBroadcastScoped`.
- XAI provider registration, provider settings, and model availability policy.
- EntityManager and XDB-backed entity providers.
- FlowManager execution and client/server flow trigger pipeline.
- ModuleCreator and generated XModule handling.
- XStudio server routes and API forwarding.
- Auth, settings, web server bootstrap, and deployment policy.

`@xpell/node` should become the host/composition package for XVibe. It should adapt its existing server modules into host contracts and then instantiate the Vibe module.

## 7. Required Abstractions And Host Contracts

The extraction should introduce an in-place host contract layer before moving files. The target factory shape is:

```ts
createXVibeModule({
  commandBus,
  appHost,
  projectMemoryStore,
  modelRouter,
  entityRecords,
  broadcaster,
  eventManager,
  fileStore,
  logger,
  settings,
  clock
})
```

Minimum contract responsibilities:

| Contract | Required responsibility |
| --- | --- |
| `commandBus` | Execute Xpell module commands without importing `@xpell/node` internals. |
| `appHost` | Read and mutate app, view, flow, and entity definitions with app/env scoping. |
| `projectMemoryStore` | Read and patch Project Memory snapshots without direct ServerXVM calls. |
| `modelRouter` | Generate structured model output without importing XAI. |
| `entityRecords` | Add, find, update, delete, rename, migrate, re-index, and commit entity records without direct XDB or EntityManager coupling. |
| `broadcaster` | Send scoped realtime app/view updates without importing Wormholes. |
| `eventManager` | Fire runtime events without importing node-local event manager singletons. |
| `fileStore` | Persist conversations, learned intents, run archives, attachments, starter copies, and Vibe diagnostics through a root-safe file abstraction. |
| `logger` | Log XVibe diagnostics without coupling to node-local logging imports. |
| `settings` | Read feature flags and runtime configuration without binding to package-local settings files. |
| `clock` | Produce deterministic timestamps in tests and runtime code. |

The first contract introduced should be `projectMemoryStore`, because `RuntimeContextManager` currently reads Project Memory through `server-xvm.get-project-memory`. That change can be done in place while preserving existing behavior through a default `@xpell/node` adapter.

## 8. Proposed Public API

Recommended stable public API for `@xpell/vibe`:

```ts
export {
  XVibeModule,
  XVibeIntentEngine,
  XVibePlanner,
  VibeIntentPlanner,
  VibeBehaviorPlanner,
  VibePromptBuilder,
  VibeOutputParser,
  VibeOutputParserError,
  VibeKnowledgeSelector,
  XVibeCapabilityRegistry
};

export type {
  XVibeIntentRequest,
  XVibeIntentResult,
  XVibeRuntimeContext,
  XVibeArtifact,
  XVibeActionDescriptor,
  XVibeConversation,
  XVibeHostContracts
};
```

Advanced exports may be exposed only if needed by tested consumers:

- Structured edit canonicalization and resolution helpers.
- Processor classes.
- `RuntimeContextManager`.
- `ConversationManager`.
- `IntentMemoryStore`.
- Execution graph planner and executor.
- `ArtifactExecutor`.

Internal implementation details should stay private:

- Private helpers inside `XVibeModule.ts`.
- Generation pipeline internals not needed by consumers.
- Archive path helpers.
- Prompt repair helpers.
- Default `@xpell/node` host adapters.

Host adapters should live in `@xpell/node`, not in `@xpell/vibe`.

## 9. Compatibility And Migration Impact

Recommended compatibility strategy: preserve the `@xpell/node` public entrypoint while making Vibe optional or adapter-composed.

Preferred runtime compatibility:

```ts
import { XVibeModule } from "@xpell/node";
import { XVibeModule } from "@xpell/vibe";
```

When both are installed through the same physical package graph, these should resolve to the same class identity. `@xpell/node` should re-export the stable `@xpell/vibe` root API rather than wrapping or subclassing `XVibeModule`.

The `xvibe` module name and existing command operations should remain stable. The known command surface includes:

- `generate`
- `plan-app`
- `generate-view`
- `get-guide-recommendation`
- `confirm-project-plan`
- `apply-view-edit`
- `apply-mutation-plan`
- `fix-project-views`
- `analyze-project-views`
- `apply-artifact-request`
- `execute-execution-graph`
- `generate-app`
- `create_app_from_starter`
- `generate-module-spec`
- `get-latest-run`
- `create-conversation`
- `list-conversations`
- `get-conversation`
- `append-message`
- `analyze-message`
- `get-last-messages`
- `update-conversation-action`
- `update-conversation-artifact`
- `append-flow-success-command`
- `sync-skills`

Deep imports are a compatibility risk. The monorepo search in the prior investigation found no direct external XVibe deep imports, but `@xpell/node` currently has no restrictive `exports` map, so deep imports are technically possible. If external consumers are found, add staged forwarders or explicit migration warnings.

## 10. Package / Workspace Impact

Future package layout:

```text
packages/vibe/
  package.json
  tsconfig.json
  src/
  tests/
  docs/
  LICENSE
```

Recommended package properties:

- ESM package output consistent with the existing workspace.
- Explicit `exports` map.
- `types`, `main`, `module`, and `files` entries.
- Node version aligned with the workspace baseline, currently no lower than the runtime supported by `@xpell/node`.
- `@xpell/core` and `@xpell/node-core` as peer/dev dependencies where singleton identity matters.
- No dependency on `@xpell/node`.

Direct third-party runtime dependencies are not currently required by XVibe itself if host contracts own model generation, broadcasting, and persistence. Any dependency introduced by file storage, prompt assets, or package tooling should be audited during the package creation phase.

`@xpell/node` package impact:

- Replace local XVibe imports with `@xpell/vibe` imports after contracts are in place.
- Keep public re-exports for compatibility if licensing allows.
- Compose default host adapters for ServerXVM, Project Memory, XAI, EntityManager, Wormholes, file storage, settings, events, and logging.
- Consider optional integration so generic `@xpell/node` users do not receive a mandatory non-commercial dependency.

## 11. Licensing Audit And Launch Implications

Current repository facts from the prior investigation:

- `@xpell/node` is currently MIT in [`packages/xnode/package.json:27`](../../package.json#L27).
- The package license file starts as MIT in [`packages/xnode/LICENSE:1`](../../LICENSE#L1).
- The README also describes the package as MIT.
- No source file license headers were found in `packages/xnode/src/XVIBE/**`.
- Inspected Git history for XVibe and Project Memory files showed commits by `Captain Crypto <tamir@crypto-knight.tech>`.

Direct dependency licenses observed in the prior investigation:

| Dependency | License observed |
| --- | --- |
| `@xpell/core` | MIT |
| `@xpell/node-core` | MIT |
| `better-sqlite3` | MIT |
| `express` | MIT |
| `ws` | MIT |
| `mongoose` | MIT |
| `bcryptjs` | BSD-3-Clause |
| `typescript` | Apache-2.0 |

No direct GPL/copyleft dependency was found in the inspected dependency set. A full transitive scan should still be run before launch.

Key launch conclusion:

- `@xpell/vibe` should become a separately licensed source-available/non-commercial package.
- Generic commercial runtime applications should not automatically receive a mandatory non-commercial dependency.
- `@xpell/node` may therefore need optional Vibe integration rather than an unconditional dependency.
- This is a repository-level technical assessment, not legal advice.

Launch implications:

- Existing MIT releases of `@xpell/node` likely remain MIT as released.
- A new `packages/vibe/LICENSE`, package metadata, README, npm metadata, and source distribution must scope non-commercial terms to `@xpell/vibe`.
- Legal review should cover contributor rights, historical MIT publication, npm wording, and whether a hard `@xpell/node -> @xpell/vibe` dependency would contaminate commercial runtime adoption.
- If `@xpell/node` keeps Vibe as an unconditional dependency, generic users may inherit a non-commercial package even when they do not use Vibe.

## 12. Deployment And Consumer Impact

Known consumer impact from the prior investigation:

- `xpell-vibe-starter` and `xai-router` rely on `XNode.start()` from `@xpell/node`.
- System flows call `_module: "xvibe"` in `flow-generate-app.json` and `flow-create-app-from-starter.json`.
- Visual/XStudio UI sends `xvibe` commands through `_send_xvibe_command` in [`packages/xpell-ui/src/XStudio/XStudioModule.ts:12990`](../../../xpell-ui/src/XStudio/XStudioModule.ts#L12990).

Deployment guidance:

- Vibe products should install `@xpell/vibe` directly once it exists.
- Generic commercial apps that only need the MIT runtime should not receive a mandatory source-available/non-commercial dependency.
- `@xpell/node` should either expose optional Vibe host integration or provide a separate Vibe-enabled distribution/profile.
- Runtime module registration should make absence of Vibe explicit: generic servers should boot without `xvibe`, while Vibe-enabled servers should register it through the host adapter composition.
- Flows or UI surfaces that assume `_module: "xvibe"` must detect whether Vibe is installed/enabled and produce a clear error or feature-gating response.

## 13. Risk Table

| Risk | Severity | Likelihood | Detection | Mitigation |
| --- | --- | --- | --- | --- |
| Circular package dependency | High | Medium | Build graph, package import linting | Ensure `@xpell/vibe` never imports `@xpell/node`; adapters live in `@xpell/node`. |
| Duplicate runtime singletons | High | Medium | Identity tests for `XModule`, `_x`, events, and exports | Use peer/dev dependencies and package graph constraints. |
| Broken deep imports | Medium | Medium | Monorepo and npm consumer grep | Provide staged forwarders or explicit migration warnings. |
| Startup order regression | High | Medium | `XNode.start()` smoke tests | Compose XVibe lazily through host adapters and preserve module name. |
| Hidden XDB coupling | High | High | CRUD rename and record migration tests | Introduce `entityRecords` host interface. |
| Hidden XAI coupling | Medium | High | Semantic intent tests | Introduce `modelRouter` host interface. |
| Settings/work-folder drift | Medium | Medium | Archive and conversation persistence tests | Inject `fileStore`, settings, and work-folder policy. |
| Resource packaging miss | Medium | Medium | `npm pack` inspection and fixture tests | Use explicit package `files` and resource manifest tests. |
| Prompt/skill files missing | Medium | Medium | Prompt acceptance tests | Package default prompt/skill assets explicitly. |
| License ambiguity | High | High | Legal and package review | Scope package-specific license and documentation before publication. |
| Version skew | High | Medium | Matrix tests | Align peer ranges and workspace release process. |
| Startup regression in consumers | High | Medium | Real app smoke tests | Validate starter, router, Visual/XStudio, and generic apps. |
| App/env isolation regression | High | Medium | Multi-app tests | Require app/env parameters in host contracts. |
| Broadcast regression | Medium | Medium | UI live update tests | Use explicit `broadcaster` adapter contract. |

## 14. Recommended Phased Extraction Plan

1. Phase 0: Freeze the current public XVibe surface, including `append-flow-success-command`.
2. Phase 1: Add `XVibeHostContracts` inside `packages/xnode/src/XVIBE` without moving files.
3. Phase 2: Migrate direct `server-xvm`, XAI, Wormholes, EntityManager, Project Memory, and filesystem calls behind default host adapters.
4. Phase 3: Split Project Memory pure logic from ServerXVM persistence.
5. Phase 4: Create `packages/vibe` and copy source only after in-place contract tests pass.
6. Phase 5: Make `@xpell/node` compose adapters and re-export stable APIs.
7. Phase 6: Add compatibility forwarders or explicit migration warnings for any discovered deep imports.
8. Phase 7: Move tests, docs, prompts, skill/resource assets, and run `npm pack` validation.
9. Phase 8: Apply package-specific source-available/non-commercial license terms and complete legal review.
10. Phase 9: Validate `xpell-vibe-starter`, `xai-router`, Visual Xpell/XStudio, and generic `@xpell/node` apps.

## 15. Immediate Next Codex Task

Introduce an in-place `XVibeHostContracts` layer and migrate `RuntimeContextManager` Project Memory reads to an injected `projectMemoryStore`, while keeping the existing ServerXVM behavior through a default adapter.

Scope for that task:

- Add contract types under `packages/xnode/src/XVIBE`.
- Add a default Project Memory adapter that delegates to current `server-xvm.get-project-memory`.
- Update `RuntimeContextManager` to use the injected `projectMemoryStore`.
- Preserve current runtime behavior, line of authority, app/env scoping, and tests.
- Do not move files into a new package during that task.

## 16. Final Recommendation

Partially extract XVibe only after host contracts are introduced and tested. Do not perform a direct file move.

The first required inversions are:

- ServerXVM app/view/flow/project-memory access.
- Project Memory reads and patches.
- Wormholes broadcasting.
- XAI generation.
- EntityManager record migration and hidden XDB coupling.
- Filesystem persistence for conversations, learned intents, run archives, and attachments.

After those boundaries are inverted, `@xpell/vibe` can become a source-available/non-commercial package that depends on `@xpell/core` and `@xpell/node-core`, while `@xpell/node` remains the MIT server host/composition layer with optional Vibe integration.
