# XVibe Remaining Compile-Time Dependencies

Date: 2026-07-17

Scope: every TypeScript file under `src/XVIBE/**`.

Allowed and excluded from the remaining dependency count:

- `@xpell/core`
- `@xpell/node-core`
- imports resolving inside `src/XVIBE/**`

Command-bus module calls are not counted as compile-time dependencies. This includes current `_x.execute(...)` calls to `server-xvm`, `xai`, `entity-manager`, `module-creator`, `xvibe`, and Wormholes.

## Summary

- Inspected TypeScript files: 51
- Static import declarations found: 211
- Allowed `@xpell/core` imports: 39
- Allowed `@xpell/node-core` imports: 15
- Internal XVIBE imports: 140
- Remaining external import records: 17
- Unique remaining external module/file targets: 6
- Relative source imports outside XVIBE: 4 records, 2 unique XVM files

The biggest remaining extraction blocker is Project Memory helper coupling from XVIBE into `src/XVM/ProjectMemoryAchievements.ts` and `src/XVM/ProjectMemoryMilestones.ts`.

The next single dependency to remove after Wormholes should be `record_project_memory_achievement` from `src/XVM/ProjectMemoryAchievements.ts`.

## Remaining Imports By Subsystem

### Project Memory

| Imported symbol(s) | Source file | Imported module/file | Why XVibe uses it | Kind | Runtime dependency? | Classification |
| --- | --- | --- | --- | --- | --- | --- |
| `project_memory_focus_alias_resolution`, `project_memory_focus_milestone`, `project_memory_focus_template_resolution`, `type XVMProjectMemoryMilestone`, `type XVMProjectMemoryMilestoneItem` | `src/XVIBE/Guide/GuideRecommendationEngine.ts:7` | `../../XVM/ProjectMemoryMilestones.js` -> `src/XVM/ProjectMemoryMilestones.ts` | Builds guide recommendations from current Project Memory focus, aliases, focus templates, and milestone completion state. | Runtime import with additional type specifiers | Yes, helper functions are executed | 📦 shared type/helper that should move to another package |
| `record_project_memory_achievement` | `src/XVIBE/StructuredEditing/StructuredViewEdit.ts:4` | `../../XVM/ProjectMemoryAchievements.js` -> `src/XVM/ProjectMemoryAchievements.ts` | Records the `first-suggested-action-applied` achievement after a structured view edit succeeds. | Runtime import | Yes, helper internally calls `server-xvm.get-project-memory` and `server-xvm.patch-project-memory` | 🔄 should become an `_x.execute()` module call |
| `record_project_memory_achievement` | `src/XVIBE/XVibeModule.ts:47` | `../XVM/ProjectMemoryAchievements.js` -> `src/XVM/ProjectMemoryAchievements.ts` | Records the `first-guide-recommendation` achievement when a guide recommendation is first returned. | Runtime import | Yes, helper internally calls `server-xvm.get-project-memory` and `server-xvm.patch-project-memory` | 🔄 should become an `_x.execute()` module call |
| `complete_project_memory_focus_milestone_item` | `src/XVIBE/XVibeModule.ts:48` | `../XVM/ProjectMemoryMilestones.js` -> `src/XVM/ProjectMemoryMilestones.ts` | Marks the active Project Memory focus milestone item complete after CRUD artifact execution succeeds, then XVibe patches Project Memory through `server-xvm`. | Runtime import | Yes, helper function is executed | 📦 shared type/helper that should move to another package |

### Filesystem And Node APIs

| Imported symbol(s) | Source file | Imported module/file | Why XVibe uses it | Kind | Runtime dependency? | Classification |
| --- | --- | --- | --- | --- | --- | --- |
| `fs` | `src/XVIBE/Archive/RunArchiveManager.ts:1` | `node:fs` | Writes and reads diagnostic `vibe-runs` archive files under the app work folder. | Runtime import | Yes | ✅ acceptable package dependency |
| `path` | `src/XVIBE/Archive/RunArchiveManager.ts:2` | `node:path` | Resolves and validates `vibe-runs` archive paths and relative archive paths. | Runtime import | Yes | ✅ acceptable package dependency |
| `path` | `src/XVIBE/Artifact/ArtifactExecutor.ts:1` | `node:path` | Builds app-scoped entity, flow, and view file paths from `server-xvm._apps_root` for artifact diagnostics/resolution. | Runtime import | Yes | ✅ acceptable package dependency |
| `fs` | `src/XVIBE/Conversation/ConversationManager.ts:1` | `node:fs` | Owns conversation file storage: index JSON, conversation JSON, messages JSONL, and attachments folder creation. | Runtime import | Yes | ✅ acceptable package dependency |
| `path` | `src/XVIBE/Conversation/ConversationManager.ts:2` | `node:path` | Resolves and validates app conversation storage paths under the ServerXVM work folder. | Runtime import | Yes | ✅ acceptable package dependency |
| `mkdir`, `readFile`, `rename`, `stat`, `writeFile` | `src/XVIBE/IntentMemory/IntentMemoryStore.ts:1` | `node:fs/promises` | Reads, creates, and atomically writes learned intent memory files. | Runtime import | Yes | ✅ acceptable package dependency |
| `path` | `src/XVIBE/IntentMemory/IntentMemoryStore.ts:2` | `node:path` | Resolves and validates learned intent file paths under `xvm/apps/<env>/<app_id>/intent-memory/`. | Runtime import | Yes | ✅ acceptable package dependency |
| `path` | `src/XVIBE/Runtime/RuntimeContextManager.ts:1` | `node:path` | Resolves and validates app directories from the ServerXVM work folder while constructing runtime context. | Runtime import | Yes | ✅ acceptable package dependency |
| `fs` | `src/XVIBE/VibeKnowledgeSelector.ts:1` | `node:fs` | Loads local skill index/schema/skill JSON files from `skills/xpell`. | Runtime import | Yes | ✅ acceptable package dependency |
| `path` | `src/XVIBE/VibeKnowledgeSelector.ts:2` | `node:path` | Resolves local skill root, schema, and skill document paths. | Runtime import | Yes | ✅ acceptable package dependency |
| `fs` | `src/XVIBE/XVibeModule.ts:1` | `node:fs` | Copies starter app files, verifies starter folders, rewrites starter JSON files, and performs cleanup on failed starter creation. | Runtime import | Yes | ✅ acceptable package dependency |
| `path` | `src/XVIBE/XVibeModule.ts:2` | `node:path` | Resolves starter, app, public asset, and package-root paths. | Runtime import | Yes | ✅ acceptable package dependency |
| `fileURLToPath` | `src/XVIBE/XVibeModule.ts:3` | `node:url` | Computes `XVIBE_PACKAGE_ROOT` from `import.meta.url` for fallback starter app lookup. | Runtime import | Yes | ✅ acceptable package dependency |

### ServerXVM

No remaining direct import from `src/XVIBE/**` to `src/XVM/ServerXVMModule.ts` was found.

ServerXVM is still heavily used through `_x.execute(...)` and selected module lookups for work-folder/apps-root metadata. Those are runtime integration points, not compile-time imports, so they are ignored for this investigation. Project Memory helper imports are listed under Project Memory because they are direct relative source imports into `src/XVM`.

### XAI

No remaining XAI compile-time import was found. XAI use is through `_x.execute({ _module: "xai", ... })` and module availability checks.

Classification: ignored command-bus dependency.

### EntityManager

No remaining EntityManager compile-time import was found. EntityManager use is through generated/planned commands and `_x.execute({ _module: "entity-manager", ... })`.

Classification: ignored command-bus dependency.

### XFM / Flow

No remaining FlowManager/XFM compile-time import was found. Flow-related behavior appears as generated flow fields or flow command/module names rather than imported code.

Classification: ignored command-bus or data-contract dependency.

### XStudio

No remaining XStudio compile-time import was found. The only observed coupling is string-level event/source metadata such as `xstudio:intent-action-refresh`, not an import.

Classification: ignored string/data-contract dependency.

### Module Creator

No remaining Module Creator compile-time import was found. Module Creator use is through `_x.execute({ _module: "module-creator", ... })`.

Classification: ignored command-bus dependency.

### Wormholes

No remaining Wormholes compile-time import was found under `src/XVIBE/**`. Existing Wormholes work is already command-bus based and is ignored per the investigation instructions.

Classification: ignored command-bus dependency.

### Utilities

No remaining utility package dependency outside the allowed packages was found.

`@xpell/node-core` utility imports are allowed by scope and excluded from the count.

## Prioritized Remaining Blockers

1. Remove direct imports of `record_project_memory_achievement` from `src/XVM/ProjectMemoryAchievements.ts`.
   - Easiest because the helper already wraps `server-xvm` Project Memory reads/writes.
   - Recommended next task: expose/route achievement recording through a `server-xvm` Project Memory command and call it from XVibe through `_x.execute(...)`.

2. Move Project Memory milestone helper functions/types out of `src/XVM/ProjectMemoryMilestones.ts`.
   - `GuideRecommendationEngine` and `XVibeModule` need pure milestone/focus logic, not ServerXVM implementation code.
   - Best target is a shared package already allowed by the extraction boundary, likely `@xpell/node-core`, unless a dedicated Project Memory package is chosen.

3. Decide whether XVibe-owned file stores remain direct Node filesystem code in `@xpell/vibe`.
   - Conversations, learned intents, run archives, skill selection, and starter-copy logic all use Node built-ins directly.
   - This is not a compile-time source blocker if `@xpell/vibe` is a Node/server package, but it is a package contract decision.

4. Decide packaged starter asset ownership.
   - `XVibeModule` computes `XVIBE_PACKAGE_ROOT` and falls back to `system-xapps/app-starters`.
   - This is not an external source import, but extraction must ensure starter assets are packaged with the new package or resolved through ServerXVM configuration.

## Recommended Next Task

Remove only the `record_project_memory_achievement` dependency next.

Do not start with a broad Project Memory refactor. The narrow task is to stop importing `src/XVM/ProjectMemoryAchievements.ts` from XVibe by routing achievement recording through a `server-xvm` command. After that, the remaining Project Memory dependency is the pure milestone/focus helper set, which can be moved as a shared helper/type package decision.

## Validation

- Inspected all 51 TypeScript files under `src/XVIBE/**`.
- Parsed static import declarations and checked for dynamic `import()` and `require()` usage.
- Found no dynamic `import()` or `require()` calls under `src/XVIBE/**`.
- Did not modify production files.
- Created this report at `docs/architecture/vibe-remaining-dependencies.md`.
