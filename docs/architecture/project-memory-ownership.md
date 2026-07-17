# Project Memory Ownership Boundary

Date: 2026-07-17

Scope:

- `packages/xnode/src/**`
- `packages/xpell-ui/src/**`
- existing architecture docs under `packages/xnode/docs/**`

Runtime/generated work files under `packages/work/**` were excluded from ownership conclusions.

## Executive Summary

Project Memory should not be owned entirely by `@xpell/vibe`.

Current source shows Project Memory is app-scoped runtime metadata persisted beside ServerXVM app artifacts, consumed by XVibe for AI/planning context, consumed by XStudio/UI for the Guide panel, and accessed through a client bridge in `@xpell/ui`. The right boundary is split ownership:

- shared schema and pure normalization helpers should move to a shared package;
- server persistence and command surface should remain in `@xpell/node`;
- AI/planning interpretation should live in `@xpell/vibe`;
- browser bridge/rendering should remain in `@xpell/ui`.

Recommended package placement: **C. Shared models/helpers in one package, persistence in another.**

Use `@xpell/node-core` for shared Project Memory types and pure helpers in the near term. Keep file persistence and `server-xvm` commands in `@xpell/node`. Do not create a dedicated package until Project Memory becomes a cross-package product surface large enough to justify it.

XVibe extraction should not wait for a full Project Memory ownership migration, but it should wait for removal of direct XVibe imports from `src/XVM/ProjectMemoryAchievements.ts` and `src/XVM/ProjectMemoryMilestones.ts`.

## Inventory

### Files

| File | Role | Responsibility class |
| --- | --- | --- |
| `packages/xnode/src/XVM/ServerXVMModule.ts` | Defines `XVMProjectMemory`, `server-xvm` Project Memory ops, file path, defaults, normalization, read/write, and patch behavior. | persistence, CRUD operations, shared model, generic runtime metadata |
| `packages/xnode/src/XVM/ProjectMemoryStage.ts` | Defines stage union and `resolveProjectStage(...)`. | shared model, generic runtime metadata |
| `packages/xnode/src/XVM/ProjectMemoryMilestones.ts` | Defines milestone/item/focus helper types and pure focus/milestone helpers. Includes default auth/entity-management milestone templates. | shared model plus AI/Vibe domain logic |
| `packages/xnode/src/XVM/ProjectMemoryAchievements.ts` | Defines achievement ids/types, append/log helpers, and `record_project_memory_achievement(...)`. | shared model plus AI/Vibe domain logic; one helper crosses into persistence through `_x.execute` |
| `packages/xnode/src/XVIBE/XVibeTypes.ts` | Duplicates `XVibeProjectMemory` shape and exposes `_project_memory` in runtime context. | AI/Vibe domain logic, shared model duplicate |
| `packages/xnode/src/XVIBE/Runtime/RuntimeContextManager.ts` | Loads Project Memory through `server-xvm.get-project-memory`, freezes it, attaches `_stage` and `_project_memory` to XVibe runtime context. | AI/Vibe domain logic, CRUD consumer |
| `packages/xnode/src/XVIBE/Processors/ProjectMemoryFocusProcessor.ts` | Detects focus-change prompts and emits executable `server-xvm.patch-project-memory` action. | AI/Vibe domain logic, CRUD consumer |
| `packages/xnode/src/XVIBE/Processors/PlanningProcessor.ts` | Reads Project Memory stage from runtime context to gate planning behavior. | AI/Vibe domain logic |
| `packages/xnode/src/XVIBE/Processors/PlanningSessionProcessor.ts` | Uses Project Memory stage to continue/skip planning session behavior. | AI/Vibe domain logic |
| `packages/xnode/src/XVIBE/Guide/GuideRecommendationEngine.ts` | Uses current focus, milestones, runtime assets, completed/parking-lot data to suggest next action. | AI/Vibe domain logic |
| `packages/xnode/src/XVIBE/StructuredEditing/StructuredViewEdit.ts` | Records completed view-section items and suggested-action achievements after deterministic edits. | AI/Vibe domain logic, CRUD consumer |
| `packages/xnode/src/XVIBE/XVibeModule.ts` | Loads Project Memory for prompts/recommendations, records guide achievements, completes CRUD milestones, confirms project plans by patching Project Memory. | AI/Vibe domain logic, CRUD consumer |
| `packages/xnode/src/XVIBE/XVibeIntentEngine.ts` | Loads Project Memory into runtime context before processor execution. | AI/Vibe domain logic |
| `packages/xnode/src/index.ts` | Re-exports `resolveProjectStage` and `XVMProjectMemoryStage`. | public shared model surface |
| `packages/xpell-ui/src/XProjectMemory/ProjectMemoryClient.ts` | Client module `project-memory-client`; sends Wormholes commands to `server-xvm`, mirrors returned memory to XData, emits Project Memory events. | UI, transport bridge, CRUD consumer |
| `packages/xpell-ui/src/XStudio/XStudioModule.ts` | Loads Project Memory, renders Guide card, milestones, achievements, focus input, and patches focus through `project-memory-client`. | UI consumer |
| `packages/xpell-ui/src/XUI/XUIRuntime.ts` | Loads `project-memory-client` by default. | UI runtime integration |
| `packages/xpell-ui/src/index.ts` | Exports `ProjectMemoryClient`, `ProjectMemory`, `_project_memory`. | public UI surface |
| `packages/xnode/src/test.ts` | Tests ServerXVM Project Memory persistence, XVibe Project Memory context, focus/guide/planning/structured-edit behaviors. | validation |

### Types

| Type | Current file | Classification | Recommended owner |
| --- | --- | --- | --- |
| `XVMProjectMemory` | `ServerXVMModule.ts` | shared model, generic runtime metadata | shared model package |
| `XVibeProjectMemory` | `XVibeTypes.ts` | duplicate shared model in Vibe namespace | replace with/import shared model |
| `XVMProjectMemoryStage` | `ProjectMemoryStage.ts` | shared model | shared model package |
| `XVMProjectMemoryMilestone`, `XVMProjectMemoryMilestoneItem` | `ProjectMemoryMilestones.ts` | shared model | shared model package |
| `XVMProjectMemoryFocusAliasResolution`, `XVMProjectMemoryFocusTemplateResolution` | `ProjectMemoryMilestones.ts` | helper result model | shared model package if kept generic; Vibe if templates remain product-specific |
| `XVMProjectMemoryAchievementId`, `XVMProjectMemoryAchievement`, `XVMProjectMemoryAchievementAppendResult` | `ProjectMemoryAchievements.ts` | shared model plus Vibe-specific achievement ids | split: generic achievement shape shared, Vibe achievement catalog in `@xpell/vibe` |

### Helper Functions

| Helper | Current file | Classification | Recommended owner |
| --- | --- | --- | --- |
| `resolveProjectStage(...)` | `ProjectMemoryStage.ts` | generic runtime metadata | shared model package |
| `normalize_project_memory_milestones(...)` | `ProjectMemoryMilestones.ts` | shared model normalization | shared model package |
| `project_memory_focus_template_resolution(...)` | `ProjectMemoryMilestones.ts` | AI/Vibe domain logic | `@xpell/vibe`, unless generalized |
| `project_memory_focus_alias_resolution(...)` | `ProjectMemoryMilestones.ts` | AI/Vibe domain logic | `@xpell/vibe`, unless generalized |
| `default_project_memory_milestone_for_focus(...)` | `ProjectMemoryMilestones.ts` | AI/Vibe domain logic | `@xpell/vibe` |
| `project_memory_focus_milestone(...)` | `ProjectMemoryMilestones.ts` | shared helper plus Vibe focus semantics | shared only if templates are injected; otherwise `@xpell/vibe` |
| `complete_project_memory_focus_milestone_item(...)` | `ProjectMemoryMilestones.ts` | shared mutation helper for milestone state | shared model package |
| `apply_project_memory_milestones(...)` | `ProjectMemoryMilestones.ts` | normalization/enrichment before persistence | shared model package, with template injection if Vibe-specific defaults are removed |
| `append_project_memory_achievement(...)` | `ProjectMemoryAchievements.ts` | shared append/dedupe helper | shared model package |
| `log_project_memory_achievement_result(...)` | `ProjectMemoryAchievements.ts` | server/Vibe logging | `@xpell/node` or `@xpell/vibe`; not shared model |
| `record_project_memory_achievement(...)` | `ProjectMemoryAchievements.ts` | persistence command helper | should become `server-xvm` command or Vibe adapter call; not shared model |

### Commands

| Command | Owner today | Consumer(s) | Classification | Recommended owner |
| --- | --- | --- | --- | --- |
| `server-xvm.get-project-memory` / `_get_project_memory` | `ServerXVMModule` | XVibe runtime, ProjectMemoryClient, tests | CRUD operation, persistence boundary | `@xpell/node` |
| `server-xvm.save-project-memory` / `_save_project_memory` | `ServerXVMModule` | ProjectMemoryClient, tests | CRUD operation, persistence boundary | `@xpell/node` |
| `server-xvm.patch-project-memory` / `_patch_project_memory` | `ServerXVMModule` | XVibe focus/planning/edit flows, ProjectMemoryClient, XStudio via client | CRUD operation, persistence boundary | `@xpell/node` |
| `project-memory-client.get` | `ProjectMemoryClient` | XStudio/UI | UI bridge over transport | `@xpell/ui` |
| `project-memory-client.patch` | `ProjectMemoryClient` | XStudio/UI | UI bridge over transport | `@xpell/ui` |
| `project-memory-client.save` | `ProjectMemoryClient` | UI callers | UI bridge over transport | `@xpell/ui` |

### Persistence

Current persistence is file-backed in `ServerXVMModule`:

- path: `<work_folder>/xvm/apps/<env>/<app_id>/project-memory.json`
- created lazily by `load_or_create_project_memory(...)`
- validated through app/env safe segment checks and app existence checks
- written with `write_json_file_atomic(...)`
- normalized by `normalize_project_memory(...)`

Classification: persistence and generic runtime metadata. Recommended owner: `@xpell/node`.

### UI Consumers

- `ProjectMemoryClient` is the browser bridge. It sends `server-xvm` commands over Wormholes, stores returned memory in XData under `project.memory` by default, and emits `project-memory:loaded`, `project-memory:saved`, and `project-memory:error`.
- `XUIRuntime` loads `ProjectMemoryClient` by default.
- `XStudioModule` renders the Guide panel from Project Memory, allows focus edits, listens to Project Memory events, and refreshes guide recommendations after changes.

Classification: UI and transport bridge. Recommended owner: `@xpell/ui`.

### XVibe Consumers

- `RuntimeContextManager` loads Project Memory and injects it into XVibe runtime context.
- `XVibeIntentEngine` attaches Project Memory before processors run.
- `PlanningProcessor` and `PlanningSessionProcessor` use `_stage`.
- `ProjectMemoryFocusProcessor` creates executable focus patch actions.
- `GuideRecommendationEngine` interprets focus/milestones/assets to suggest next work.
- `StructuredViewEdit` records completed items and achievements after deterministic edits.
- `XVibeModule` confirms plans, records guide achievements, completes CRUD milestones, and passes Project Memory to prompt/runtime plan paths.

Classification: AI/Vibe domain logic and CRUD consumers. Recommended owner: `@xpell/vibe` for interpretation/generation; persistence stays behind `server-xvm` commands or a host adapter.

### ServerXVM Consumers

`ServerXVMModule` is both owner and consumer today:

- owns the Project Memory file path under the app directory;
- owns default memory shape and normalization;
- owns get/save/patch commands;
- applies milestone normalization on save/patch;
- appends `first-project-memory-focus` on focus patch.

Classification: persistence, CRUD, generic runtime metadata, and some Vibe-specific enrichment. Recommended owner: keep persistence/commands in `@xpell/node`, move model/helpers out.

## Responsibility Classification

| Component | AI/Vibe domain logic | Generic runtime metadata | Persistence | UI | Transport | Shared model |
| --- | --- | --- | --- | --- | --- | --- |
| Project Memory schema fields | Partial | Yes | No | No | No | Yes |
| Stage resolution | No | Yes | No | No | No | Yes |
| Focus text as state | Partial | Yes | No | UI edits it | No | Yes |
| Focus prompt detection | Yes | No | No | No | No | No |
| Milestone item shape | Partial | Yes | No | UI renders it | No | Yes |
| Default milestone templates | Yes | No | No | No | No | No |
| Achievement item shape | Partial | Yes | No | UI renders it | No | Yes |
| Vibe achievement catalog | Yes | No | No | No | No | No |
| `project-memory.json` storage | No | Yes | Yes | No | No | No |
| Server get/save/patch ops | No | Yes | Yes | No | command API | No |
| ProjectMemoryClient | No | No | No | Yes | Yes | No |
| XStudio Guide rendering | No | No | No | Yes | No | No |
| XVibe guide recommendations | Yes | No | No | No | No | No |

## Ownership Recommendation

| Responsibility | Recommended owner |
| --- | --- |
| Project Memory schema | shared model package, near-term `@xpell/node-core` |
| Stage | shared model package |
| Generic focus field | shared model package |
| Focus prompt interpretation | `@xpell/vibe` |
| Milestone item/milestone model | shared model package |
| Milestone normalization/completion helpers | shared model package |
| Default milestone templates for app-building guidance | `@xpell/vibe` |
| Achievement item model and append/dedupe helper | shared model package |
| Vibe/XStudio achievement ids such as `first-guide-recommendation` | `@xpell/vibe` or a Vibe-provided catalog |
| Persistence path and file IO | `@xpell/node` |
| CRUD operations | `@xpell/node` |
| `server-xvm.get/save/patch-project-memory` commands | `@xpell/node` |
| Client bridge and XData mirror | `@xpell/ui` |
| XStudio Guide panel | `@xpell/ui` |
| Runtime context use in prompts/planning | `@xpell/vibe` |

## Package Placement Evaluation

### A. Project Memory belongs inside `@xpell/vibe`

Not recommended.

This would match the current AI/planning usage, but it would put app-scoped runtime metadata and UI-visible state behind the planned source-available Vibe package. Generic Xpell runtime applications and XStudio would either need to depend on `@xpell/vibe` for project metadata or lose the current Project Memory client/guide capability. That is too much licensing and product coupling for data that is persisted beside app artifacts.

### B. Project Memory belongs inside `@xpell/node`

Partly true, but incomplete.

`@xpell/node` should own persistence and commands because Project Memory is stored under the ServerXVM app directory. However, pure schema and helper logic are already consumed by XVibe and UI concepts. Keeping all model logic in `@xpell/node` forces `@xpell/vibe` to import back into node implementation files after extraction.

### C. Shared models/helpers in one package, persistence in another

Recommended.

Shared schema, stage, milestone model, and pure mutation helpers should live in a shared package. Server persistence and command exposure should remain in `@xpell/node`. XVibe should own AI interpretation, guide recommendation logic, focus intent detection, and Vibe-specific achievement/milestone catalogs.

Near-term shared package: `@xpell/node-core`, because it already provides server-adjacent shared utilities and is an allowed dependency in the planned XVibe extraction boundary.

### D. Dedicated package

Not recommended yet.

A dedicated Project Memory package would be clean if Project Memory becomes a standalone public product contract used equally by node, UI, Vibe, and non-Xpell host apps. Current source does not justify creating that package now. The lower-risk move is to extract pure shared contracts into `@xpell/node-core` first and revisit a dedicated package when the API surface stabilizes.

## Licensing Impact

The planned `@xpell/vibe` source-available license is a reason not to move all Project Memory into `@xpell/vibe`.

Project Memory currently serves three audiences:

- server runtime persistence in `@xpell/node`;
- UI/XStudio display and editing in `@xpell/ui`;
- AI/planning context in XVibe.

If the Project Memory schema and persistence moved into `@xpell/vibe`, generic runtime applications would need a source-available Vibe dependency for app metadata such as goal, stage, focus, notes, decisions, and milestones. That does not fit the current layering. Generic runtime apps may still want project-level metadata without AI generation.

The Vibe-specific parts that do fit the source-available package are:

- prompt/focus interpretation;
- guide recommendation policy;
- default app-building milestone templates;
- achievement triggers tied to Vibe suggested actions and guide recommendations.

## Proposed Package Boundary

Recommended boundary:

```text
@xpell/node-core
  Project Memory shared types
  stage resolution
  schema/default normalization
  pure milestone/achievement append helpers

@xpell/node
  server-xvm Project Memory persistence
  project-memory.json path ownership
  get/save/patch commands
  atomic file writes
  app/env validation

@xpell/vibe
  focus intent processor
  guide recommendation engine
  project plan -> memory patch construction
  Vibe-specific milestone templates
  Vibe-specific achievement triggers/catalog
  uses Project Memory through host adapter or server-xvm commands

@xpell/ui
  project-memory-client bridge
  XData mirror
  project-memory UI events
  XStudio Guide rendering and focus controls
```

## Migration Recommendation

1. Move only shared Project Memory model and pure helpers first.
   - `XVMProjectMemoryStage`
   - `resolveProjectStage(...)`
   - Project Memory document type
   - milestone item/milestone types
   - milestone normalization/completion helpers
   - generic achievement item and append/dedupe helper

2. Keep ServerXVM commands and file persistence in `@xpell/node`.
   - Preserve `server-xvm.get-project-memory`
   - Preserve `server-xvm.save-project-memory`
   - Preserve `server-xvm.patch-project-memory`
   - Keep `project-memory.json` beside `app.json`

3. Move Vibe-specific interpretation out of XVM helper files.
   - Focus alias/template resolution
   - default auth/entity-management milestone templates
   - guide recommendation logic
   - Vibe achievement trigger catalog

4. Replace XVibe direct imports from `src/XVM/ProjectMemoryAchievements.ts` and `src/XVM/ProjectMemoryMilestones.ts`.
   - Use shared helpers from `@xpell/node-core`.
   - Use `_x.execute({ _module: "server-xvm", _op: "patch-project-memory" })` for persistence.
   - Do not import `ServerXVMModule` or XVM implementation files from `@xpell/vibe`.

5. Keep `ProjectMemoryClient` in `@xpell/ui`.
   - It should continue to call server commands over Wormholes and mirror only server-returned state into XData.

## Should XVibe Extraction Wait?

XVibe extraction should not wait for a complete Project Memory package redesign.

It should wait for the narrow compile-time blockers:

- remove direct XVibe imports from `src/XVM/ProjectMemoryAchievements.ts`;
- remove direct XVibe imports from `src/XVM/ProjectMemoryMilestones.ts`;
- replace duplicated `XVibeProjectMemory` with a shared type or local adapter type that does not depend on XVM implementation files.

The broader ownership cleanup can happen after extraction if `@xpell/vibe` talks to Project Memory through a host adapter or through `server-xvm` commands supplied by `@xpell/node`.

## Final Recommendation

- Recommended ownership: split ownership.
- Recommended package option: **C. Shared models/helpers in one package, persistence in another.**
- Recommended shared package now: `@xpell/node-core`.
- Recommended persistence owner: `@xpell/node` / `server-xvm`.
- Recommended Vibe owner scope: AI interpretation, recommendation policy, Vibe-specific milestones/achievements, and Project Memory-aware prompt/runtime context use.
- Migration priority: remove direct XVibe imports from XVM Project Memory helper files before extracting `@xpell/vibe`; defer dedicated package creation.

## Validation

- Searched for `ProjectMemory`, `project-memory`, and `project_memory`.
- Inventoried 19 source files across `packages/xnode/src` and `packages/xpell-ui/src`.
- Read the current server persistence, helper, UI client, XStudio, and XVibe consumer implementations.
- Did not modify production code.
- Created this report at `packages/xnode/docs/architecture/project-memory-ownership.md`.
