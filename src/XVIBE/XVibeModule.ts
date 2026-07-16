import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _x, _xlog, XCommand, XModule, type XpellSkill, type XpellSkillCommand } from "@xpell/core";
import { _xem } from "../XEM/XEventManager.js";
import { VibeKnowledgeSelector, type VibeKnowledgeSelection } from "./VibeKnowledgeSelector.js";
import { wsBroadcastScoped } from "../Wormholes/wh.index.js";



import {
  extract_balanced_json,
  repair_json,
  VibeOutputParser,
  VibeOutputParserError,
  type XVibeCommandArtifact,
  type XVibeEntityArtifact,
  type XVibeFlowArtifact,
  type XVibeJsonObject,
  type XVibeParserDiagnostic,
  type VibeParsedOutput,
  type XVibeViewArtifact,
} from "./VibeOutputParser.js";
import { _xu } from "../XNUtils/XUtils.js";
import { VibePromptBuilder } from "./VibePromptBuilder.js";
import { ensure_view_ids, VibeViewBuilder } from "./VibeViewBuilder.js";
import {
  RunArchiveManager,
  type XVibeRunArchiveData,
  type XVibeRunDiagnosticSummary,
} from "./Archive/RunArchiveManager.js";
import { ConversationManager } from "./Conversation/ConversationManager.js";
import { GenerationManager } from "./Generation/GenerationManager.js";
import { IntentConversationBridge } from "./Intent/IntentConversationBridge.js";
import {
  RuntimeContextManager,
  type XVibeRuntimeContextInput,
} from "./Runtime/RuntimeContextManager.js";
import {
  canonicalizeSemanticViewEditParams,
  isStructuredViewEditAction,
  StructuredViewEdit,
} from "./StructuredEditing/StructuredViewEdit.js";
import { resolveViewTarget } from "./StructuredEditing/ViewTargetResolution.js";
import { ArtifactExecutor } from "./Artifact/ArtifactExecutor.js";
import { ExecutionGraphExecutor } from "./ExecutionGraph/ExecutionGraphExecutor.js";
import { GuideRecommendationEngine } from "./Guide/GuideRecommendationEngine.js";
import { record_project_memory_achievement } from "../XVM/ProjectMemoryAchievements.js";
import { complete_project_memory_focus_milestone_item } from "../XVM/ProjectMemoryMilestones.js";
import type { VibeArtifactFactoryDiagnostic } from "./VibeArtifactFactory.js";

import type {
  XVibeArtifactAction,
  XVibeArtifactActionPlan,
  XVibeArtifactExecutionPlan,
  XVibeArtifactIntent,
  VibeArtifactType,
  VibeRequestedArtifactType,
  XVibeInferredArtifactPlan,
  XVibeInferredArtifactType,
  XVibeGuideRecommendation,
  XVibeProjectMemory,
  XVibeResolvedTask,
  XVibeRuntimeAssetRef,
  XVibeRuntimeAssets,
  XVibeRuntimePlan,
  XVibeValidationPlan,
} from "./XVibeTypes.js";
import {
  XVibePlanner,
  type XVibeAppPlan,
  type XVibeArtifactExecutionItem,
  type XVibeArtifactPlanType,
} from "./XVibePlanner.js";
import {
  create_module_intent_plan_from_resolved_task,
  extract_prompt_flow_ids as extract_intent_prompt_flow_ids,
  has_explicit_data_or_crud_intent,
  has_explicit_flow_intent,
  resolve_xvibe_task,
  VibeIntentPlanner,
  warn_if_plan_violates_resolved_task,
  type VibeIntentPlan,
} from "./VibeIntentPlanner.js";
import {
  VibeBehaviorPlanner,
  type VibeBehaviorIntent,
} from "./VibeBehaviorPlanner.js";
import { XVibeIntentEngine } from "./XVibeIntentEngine.js";

type VibeAIMode = "full" | "refine";
type GuideRecommendationCacheEntry = {
  _expires_at: number;
  _recommendation: XVibeGuideRecommendation | null;
};

const DEFAULT_ENV = "default";
const DEFAULT_VIEW_ID = "view-main";
const DEFAULT_SCAFFOLD_ROOT_TYPE = "view";
const GUIDE_RECOMMENDATION_CACHE_TTL_MS = 1000;
const XVIBE_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const MAX_VALIDATION_ERRORS = 50;
const MAX_REPAIR_ERRORS = 20;
const GENERATED_MODULE_IMPLEMENTATION_MAX_ATTEMPTS = 3;
const XVIBE_ARTIFACT_ACTION_NOT_SUPPORTED = "E_XVIBE_ARTIFACT_ACTION_NOT_SUPPORTED";
const XVIBE_INVALID_STARTER_ID = "E_XVIBE_INVALID_STARTER_ID";
const XVIBE_INVALID_APP_ID = "E_XVIBE_INVALID_APP_ID";
const XVIBE_INVALID_ENV = "E_XVIBE_INVALID_ENV";
const XVIBE_INVALID_CONVERSATION_ID = "E_XVIBE_INVALID_CONVERSATION_ID";
const PLANNING_DRAFT_NOT_FOUND = "E_PLANNING_DRAFT_NOT_FOUND";
const PLANNING_INCOMPLETE = "E_PLANNING_INCOMPLETE";
const PROJECT_MEMORY_PATCH_FAILED = "E_PROJECT_MEMORY_PATCH_FAILED";
const XVIBE_STARTER_NOT_FOUND = "E_XVIBE_STARTER_NOT_FOUND";
const XVIBE_APP_ALREADY_EXISTS = "E_XVIBE_APP_ALREADY_EXISTS";
const XVIBE_STARTER_COPY_FAILED = "E_XVIBE_STARTER_COPY_FAILED";
const XVIBE_STARTER_LOAD_FAILED = "E_XVIBE_STARTER_LOAD_FAILED";
const BUILTIN_SERVER_MODULES = new Set([
  "xvm",
  "xd",
  "xem",
  "xui",
  "xdb-client",
  "flow-client",
  "entity-client",
  "server-xvm",
  "xvibe",
  "xai",
  "module-creator",
  "studio",
  "xtest",
]);
const FALLBACK_XUI_VALIDATION_TYPES = new Set([
  "view",
  "style-sheet",
  "label",
  "grid",
  "button",
  "toolbar",
  "field",
  "textarea",
  "card",
  "xsection",
  "table",
  "navlist",
  "badge",
  "modal",
  "drawer",
  "xvm-view",
]);
const RESERVED_VIEW_IDS = new Set([
  "a",
  "an",
  "and",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "the",
  "to",
  "with",
  "named",
  "called",
  "id",
  "new",
]);
const XVIBE_PLAN_VALIDATION_FAILED = "E_XVIBE_PLAN_VALIDATION_FAILED";
const XVIBE_DETERMINISTIC_HIDE_MECHANISM = "style.display:none";
const XVIBE_DETERMINISTIC_SHOW_MECHANISM = "remove-style.display:none";
const XVIBE_DETERMINISTIC_BUILTIN_PROPERTY_NAMES = new Set([
  "_text",
  "_on",
  "_once",
  "_on_mount",
  "_requires",
  "class",
  "_class",
  "style",
  "_style",
  "disabled",
  "placeholder",
  "value",
]);
const XVIBE_DETERMINISTIC_BUILTIN_JSON_PROPERTY_NAMES = new Set([
  "_on",
  "_once",
  "_on_mount",
  "_requires",
]);
const XVIBE_DETERMINISTIC_BLOCKED_PROPERTY_NAMES = new Set([
  "_id",
  "_type",
  "_children",
]);
const XVIBE_VALIDATION_REJECTED_TARGET_IDS = new Set([
  "and",
  "with",
  "for",
  "from",
  "to",
  "of",
  "in",
  "on",
  "the",
  "a",
  "an",
]);

type XVibeGeneratedArtifact =
  | XVibeViewArtifact
  | XVibeFlowArtifact
  | XVibeEntityArtifact
  | XVibeCommandArtifact;

type XVibeArtifactValidationResult =
  | { _ok: true; _errors: [] }
  | { _ok: false; _errors: string[] };

type XVibeViewMutationOperation = XVibeJsonObject & {
  _op_type: "update_props";
  _target_id: string;
  _props: XVibeJsonObject;
};

type XVibeViewMutationArtifact = XVibeJsonObject & {
  _artifact_type: "view-mutation";
  _contract_version: 1;
  _ops: XVibeViewMutationOperation[];
};

type XVibeInteractionScope = "_on" | "_once";
type XVibeMoveObjectPosition = "append" | "prepend" | "before" | "after";
type XVibeCreateToolbarLocation = "top" | "bottom" | "before" | "after";

type XVibeMutationPlanPrimitive = {
  _module: "xvibe";
  _op: "apply-view-edit";
  _params: XVibeJsonObject;
};

type XVibeMutationPlanStep = XVibeJsonObject & {
  _id: string;
  _title?: string;
  _status: "planned" | "unsupported" | "running" | "done" | "failed";
  _primitive?: XVibeMutationPlanPrimitive;
  _reason?: string;
};

type XVibeMutationPlanArtifact = XVibeJsonObject & {
  _type: "mutation-plan";
  _steps: XVibeMutationPlanStep[];
  _can_apply: boolean;
  _unsupported_steps: number;
};

type XVibeMutationPlanExecutionStep = XVibeJsonObject & {
  _id: string;
  _status: "running" | "done" | "failed";
  _result?: unknown;
  _error?: XVibeJsonObject;
};

type XVibeMutationPlanValidationResult =
  | { _ok: true; _plan: XVibeMutationPlanArtifact; _steps: XVibeMutationPlanStep[] }
  | { _ok: false; _code: string; _message: string; _details?: XVibeJsonObject };

type XVibeViewEditIntent = XVibeJsonObject & {
  _action: "remove" | "hide" | "show" | "update" | "add-class" | "remove-class" | "replace-class" | "toggle-class" | "set-style" | "set-styles" | "remove-style" | "set-style-class-rule" | "remove-style-class-rule" | "set-property" | "update-property" | "remove-property" | "move-object" | "replace-object" | "duplicate-object" | "add-child" | "create-toolbar" | "set-interaction" | "bind-flow";
  _target_id?: string;
  _field?: string;
  _target_text?: string;
  _replacement_text?: string;
  _class_name?: string;
  _old_class_name?: string;
  _new_class_name?: string;
  _style_property?: string;
  _style_value?: string;
  _styles?: XVibeJsonObject;
  _property_name?: string;
  _property_value?: unknown;
  _interaction_scope?: XVibeInteractionScope;
  _trigger?: string;
  _handler?: Record<string, any> | null;
  _flow?: { _id: string; _payload?: XVibeJsonObject };
  _flow_event?: string;
  _flow_auto?: boolean;
  _object_value?: XVibeJsonObject;
  _move_position?: "before" | "after" | "top" | "bottom";
  _position?: XVibeMoveObjectPosition;
  _anchor_id?: string;
  _anchor_text?: string;
  _anchor_type?: string;
  _destination_id?: string;
  _destination_text?: string;
  _destination_type?: string;
  _target_type?: string;
  _child?: XVibeJsonObject;
  _location?: string;
  _component_type?: string;
  _props?: XVibeJsonObject;
  _toolbar_props?: XVibeJsonObject;
  _warnings?: string[];
};

type XVibeDeterministicViewEditEligibility = {
  _eligible: boolean;
  _action?: "update-text" | "remove-object" | "hide-object" | "show-object" | "add-class" | "remove-class" | "replace-class" | "toggle-class" | "set-style" | "set-styles" | "remove-style" | "set-style-class-rule" | "remove-style-class-rule" | "set-property" | "remove-property" | "move-object" | "replace-object" | "duplicate-object" | "add-child" | "create-toolbar" | "set-interaction" | "bind-flow";
  _target_id?: string;
  _target_path?: string[];
  _field?: "_text";
  _property_name?: string;
  _reason: string;
  _details?: unknown;
};

type XVibeDeterministicViewEditResult = {
  _ok: boolean;
  _view?: unknown;
  _mutation?: {
    _type: "deterministic-view-edit";
    _action: "update-text" | "remove-object" | "hide-object" | "show-object" | "add-class" | "remove-class" | "replace-class" | "toggle-class" | "set-style" | "set-styles" | "remove-style" | "set-style-class-rule" | "remove-style-class-rule" | "set-property" | "remove-property" | "move-object" | "replace-object" | "duplicate-object" | "add-child" | "create-toolbar" | "set-interaction" | "bind-flow";
    _target_id?: string;
    _target_path?: string[];
    _field?: "_text";
    _previous_text?: string;
    _replacement_text?: string;
    _resolved_by?: "id" | "text" | "normalized_text" | "text_type_id";
    _class_name?: string;
    _old_class_name?: string;
    _new_class_name?: string;
    _class_field?: "class" | "_class";
    _previous_class?: string;
    _next_class?: string;
    _style_property?: string;
    _styles_applied?: XVibeJsonObject;
    _previous_styles?: XVibeJsonObject;
    _previous_value?: unknown;
    _next_value?: unknown;
    _property_name?: string;
    _interaction_scope?: XVibeInteractionScope;
    _trigger?: string;
    _handler_removed?: boolean;
    _handler_module?: string;
    _handler_op?: string;
    _flow?: { _id: string; _payload?: XVibeJsonObject };
    _flow_event?: string;
    _flow_auto?: boolean;
    _previous_object?: XVibeJsonObject;
    _next_object?: XVibeJsonObject;
    _move_position?: "before" | "after" | "top" | "bottom";
    _position?: XVibeMoveObjectPosition;
    _anchor_id?: string;
    _before_id?: string;
    _after_id?: string;
    _anchor_resolved_by?: "id" | "text" | "normalized_text" | "text_type_id";
    _parent_id?: string;
    _source_parent_id?: string;
    _destination_parent_id?: string;
    _moved_id?: string;
    _previous_index?: number;
    _next_index?: number;
    _insert_index?: number;
    _original_target_id?: string;
    _new_target_id?: string;
    _removed_type?: string;
    _removed_text?: string;
    _hide_mechanism?: typeof XVIBE_DETERMINISTIC_HIDE_MECHANISM;
    _show_mechanism?: typeof XVIBE_DETERMINISTIC_SHOW_MECHANISM;
    _target_view_id?: string;
    _source_view_id?: string;
    _requested_view_id?: string;
    _resolved_via?: "xvm-view";
    _location?: XVibeCreateToolbarLocation;
    _child_id?: string;
    _child_type?: string;
    _toolbar_id?: string;
    _created?: boolean;
    _reason?: string;
    _warnings?: string[];
  };
  _reason?: string;
  _details?: unknown;
};

type XVibeReferencedView = {
  _view_id: string;
  _view: XVibeJsonObject;
};

type XVibeXVMViewReferenceLoadResult = {
  _referenced_view_ids: string[];
  _loaded_views: XVibeReferencedView[];
  _missing_view_ids: string[];
  _warnings: string[];
};

type XVibeDeterministicViewEditSourceResolution =
  | {
    _eligible: true;
    _view_id: string;
    _view: unknown;
    _resolved_via: "current-view" | "xvm-view";
    _eligibility: XVibeDeterministicViewEditEligibility;
    _warnings: string[];
  }
  | {
    _eligible: false;
    _eligibility: XVibeDeterministicViewEditEligibility;
    _warnings: string[];
  };

type XVibeViewMutationDecisionReason =
  | "eligible"
  | "not_refine"
  | "not_view"
  | "missing_view_id"
  | "missing_current_view"
  | "prompt_not_safe"
  | "excluded_keyword"
  | "no_target_hint";

type XVibeViewMutationDecisionLog = {
  _eligible: boolean;
  _mode: VibeAIMode;
  _artifact_type: string;
  _view_id: string | null;
  _prompt: string;
  _reason: XVibeViewMutationDecisionReason;
  _has_current_view: boolean;
  _current_view_id: string | null;
  _children_count: number;
};

type XVibeRunValidationArchive = {
  _validation_result?: XVibeArtifactValidationResult;
  _repair_attempts?: XVibeJsonObject[];
  _repair_errors?: unknown[];
  _repaired_validation_result?: XVibeArtifactValidationResult;
  _implementation_attempts?: XVibeJsonObject[];
};

type XVibeRunDiagnosticResult = {
  _ok: true;
  _run_id: string;
  _run_dir: string;
  _generation_id?: string;
  _summary: XVibeRunDiagnosticSummary;
  _files: Record<string, unknown>;
  _file_errors?: Array<{
    _file: string;
    _message: string;
  }>;
};

type XVibeRuntimeRegistry = {
  _xui_types: Set<string>;
  _modules: Set<string>;
  _ops: Map<string, Set<string>>;
};

type XVibeGeneratedModuleOpTarget = {
  _module: string;
  _op: string;
};

type XVibeServerModuleRequirement = {
  _module_target: "server";
  _module_name: string;
  _module_ops: string[];
  _module_reason?: string;
};

type XVibeServerModuleEnsureResult = {
  _intent_plan: VibeIntentPlan;
  _module_name?: string;
  _module_ops: string[];
  _created?: boolean;
  _available?: boolean;
};

type XVibeViewServerModuleEnsureResult = {
  _runtime_skills: unknown;
  _created_modules: string[];
};

type XVibeModuleCreatorSpec = {
  _id: string;
  _name: string;
  _target: "server";
  _description: string;
  _version: string;
  _imports: Array<{ _from: string }>;
  _permissions: unknown[];
  _ops: Array<{
    _name: string;
    _description: string;
    _params?: Record<string, unknown>;
    _result?: Record<string, unknown>;
  }>;
  _meta?: Record<string, unknown>;
};

type XVibeGeneratedModuleImplementationMethods =
  Record<string, string>;

type XVibeGeneratedModuleImplementationSources = {
  _method_sources: Record<string, string>;
  _helper_sources: Record<string, string>;
};

type XVibeServerModuleCallGraph =
  Record<string, string[]>;

type XVibeGeneratedModuleImplementationValidationCategory =
  | "placeholder_content"
  | "forbidden_content"
  | "syntax_or_shape_error"
  | "weak_behavior"
  | "helper_method_misplaced"
  | "unknown";

type XVibeGeneratedModuleRejectedAttempt = {
  _attempt: number;
  _category: XVibeGeneratedModuleImplementationValidationCategory;
  _validation_errors: unknown;
  _method_sources?: Record<string, string>;
  _method_source_excerpts?: Record<string, string>;
  _helper_sources?: Record<string, string>;
  _helper_source_excerpts?: Record<string, string>;
};

type XVibeGenerationProgressCallback = (
  stage: string,
  message: string,
  details?: Record<string, unknown>,
) => void;

type XVibeArtifactScopeLock = {
  _locked: true;
  _action: "create" | "update";
  _artifact_type: "view" | "flow" | "entity" | "module";
  _target_id?: string;
  _forbidden_targets?: string[];
  _reason: "resolver_lock";
};

class XVibeStructuredError extends Error {
  readonly _payload: XVibeJsonObject;

  constructor(payload: XVibeJsonObject) {
    const message =
      _xu.is_plain_object(payload._error) && typeof payload._error._message === "string"
        ? payload._error._message
        : "XVibe structured error";

    super(message);
    this._payload = payload;
  }
}

const ENTITY_OPS = new Set([
  "register",
  "unregister",
  "has",
  "get_schema",
  "get-schema",
  "get_entity",
  "get-entity",
  "add",
  "get",
  "find",
  "update",
  "delete",
  "list",
]);

const CALC_SAFE_EVALUATION_OPS = new Set([
  "evaluate",
  "evaluate_expression",
  "evaluate-expression",
  "calculate",
  "calculate_expression",
  "calculate-expression",
]);

function debug_enabled(): boolean {
  return Boolean((_xlog as unknown as { _debug?: boolean })._debug);
}

function verbose_log(message: string, data: XVibeJsonObject): void {
  if (debug_enabled()) {
    _xlog.log(message, data);
  }
}

function read_prompt(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0
  ) {
    throw new Error(
      "Invalid '_prompt': expected non-empty string"
    );
  }

  return _xu.normalizePrompt(value);
}

function resolve_prompt(
  params: Record<string, unknown>
): string {

  /*
    Canonical runtime param:
    _prompt
  */

  if (
    typeof params._prompt === "string" &&
    params._prompt.trim().length > 0
  ) {
    return read_prompt(params._prompt);
  }

  /*
    Legacy/internal compatibility:
    prompt
  */

  if (
    typeof params.prompt === "string" &&
    params.prompt.trim().length > 0
  ) {
    _xlog.warn('Using legacy "prompt" parameter. Please switch to "_prompt" for better compatibility.');
    return read_prompt(params.prompt);
  }

  throw new Error(
    "Missing '_prompt'"
  );
}

function read_required_string(value: unknown, field_name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid '${field_name}': expected non-empty string`);
  }

  return value.trim();
}

function read_optional_string(value: unknown, field_name: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid '${field_name}': expected non-empty string`);
  }

  return value.trim();
}

function read_optional_generation_id(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error("Invalid '_generation_id': expected string");
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function read_optional_string_array(value: unknown, field_name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Invalid '${field_name}': expected string array`);
  }

  return value.map((item) => read_required_string(item, field_name));
}

function read_mode(value: unknown): VibeAIMode {
  if (value === undefined) {
    return "full";
  }

  if (value === "full" || value === "refine") {
    return value;
  }

  throw new Error("Invalid '_mode': expected 'full' or 'refine'");
}

function read_artifact_type(value: unknown): VibeRequestedArtifactType | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (
    value === "view" ||
    value === "flow" ||
    value === "entity" ||
    value === "command" ||
    value === "auto"
  ) {
    return value;
  }

  throw new Error("Invalid '_artifact_type': expected view, flow, entity, command, or auto");
}

function normalize_safe_view_id(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const normalized =
    value
      .trim()
      .replace(/^["'`]+|["'`.,;:]+$/g, "")
      .trim()
      .toLowerCase();

  if (
    !/^[a-z][a-z0-9_-]*$/u.test(normalized) ||
    RESERVED_VIEW_IDS.has(normalized)
  ) {
    return undefined;
  }

  return normalized;
}

function resolve_final_view_id(
  resolved_task: XVibeResolvedTask,
  params_view_id: unknown,
): string {
  return (
    normalize_safe_view_id(resolved_task._target_id) ??
    normalize_safe_view_id(params_view_id) ??
    "main"
  );
}

function read_existing_resolved_task(value: unknown): XVibeResolvedTask | undefined {
  if (!_xu.is_plain_object(value)) {
    return undefined;
  }

  if (
    typeof value._action !== "string" ||
    typeof value._artifact_type !== "string" ||
    typeof value._explicit_artifact_type !== "boolean" ||
    typeof value._explicit_target_id !== "boolean" ||
    !Array.isArray(value._module_ops) ||
    typeof value._source !== "string" ||
    typeof value._confidence !== "number" ||
    !Array.isArray(value._warnings)
  ) {
    return undefined;
  }

  return value as XVibeResolvedTask;
}

function log_xvibe_planning_cycle(
  params: XVibeJsonObject,
  generation_id: string,
): number {
  const previous_count =
    typeof params._planning_cycle_count === "number"
      ? params._planning_cycle_count
      : 0;
  const count = previous_count + 1;
  params._planning_cycle_count = count;
  _xlog.log("[xvibe] planning cycle", {
    _generation_id: generation_id,
    _count: count,
  });
  return count;
}

function should_inline_single_refine_view_execution_plan(input: {
  _mode: VibeAIMode;
  _artifact_type: VibeArtifactType;
  _execution_plan?: XVibeArtifactExecutionPlan;
  _requested_view_id?: string;
}): boolean {
  if (input._mode !== "refine" || input._artifact_type !== "view") {
    return false;
  }

  const artifacts = input._execution_plan?._artifacts;
  if (!Array.isArray(artifacts) || artifacts.length !== 1) {
    return false;
  }

  const item = artifacts[0];
  return (
    item._artifact_type === "view" &&
    item._action === "update" &&
    (!Array.isArray(item._depends_on) || item._depends_on.length === 0) &&
    (
      !item._artifact_id ||
      !input._requested_view_id ||
      item._artifact_id === input._requested_view_id
    )
  );
}

function unique_normalized_ids(ids: string[]): string[] {
  return Array.from(new Set(
    ids
      .map((id) => id.trim().toLowerCase())
      .filter((id) => id.length > 0),
  ));
}

function extract_named_flow_ids(prompt: string): string[] {
  const ids: string[] = [];
  ids.push(...(prompt.match(/\bflow-[a-z0-9][a-z0-9_-]*\b/gi) ?? []));

  const named_flow_pattern =
    /\b(?:run|trigger|call|execute)?\s*(?:a\s+|the\s+)?flow\s+named\s+([a-z][a-z0-9_-]*)\b/giu;

  for (const match of prompt.matchAll(named_flow_pattern)) {
    ids.push(match[1]);
  }

  return unique_normalized_ids(ids);
}

function prompt_has_explicit_flow_only_language(prompt: string): boolean {
  const text = _xu.normalizePrompt(prompt).toLowerCase();

  return (
    /\bonly\s+create\s+(?:a\s+|the\s+)?flow\b/u.test(text) &&
    /\bdo\s+not\s+create\s+(?:a\s+|the\s+)?entities\b/u.test(text) &&
    /\bdo\s+not\s+create\s+(?:a\s+|the\s+)?views\b/u.test(text) &&
    /\bflow\s+named\s+[a-z][a-z0-9_-]*\b/u.test(text)
  );
}

function artifact_inference_branch_for_plan(
  plan: XVibeInferredArtifactPlan,
): string {
  const reason = plan._reason ?? "";

  if (reason === "explicit_requested_artifact_type") return "explicit_requested_artifact_type";
  if (reason === "requested_view_with_explicit_flow_dependency") return "requested_view_with_explicit_flow_dependency";
  if (reason.includes("flow_dependency") && plan._primary_artifact_type === "view") return "strong_view_intent_with_explicit_flow_dependency";
  if (
    plan._primary_artifact_type === "view" &&
    (
      reason === "explicit_view_intent" ||
      reason === "strong_view_intent"
    )
  ) {
    return "strong_view_intent";
  }
  if (plan._primary_artifact_type === "entity") return "explicit_entity_or_persistence_intent";
  if (plan._primary_artifact_type === "flow") return "flow_intent";
  if (plan._primary_artifact_type === "module") return "module_intent";
  if (plan._flow_ids?.length) return "default_view_with_explicit_flow_dependency";

  return "default_view";
}

function log_artifact_inference_branch(
  plan: XVibeInferredArtifactPlan,
): void {
  _xlog.log("[xvibe] artifact inference branch", {
    _branch: artifact_inference_branch_for_plan(plan),
    _reason: plan._reason,
    _primary_artifact_type: plan._primary_artifact_type,
    _artifact_types: plan._artifact_types,
    _flow_ids: plan._flow_ids,
    _entity_ids: plan._entity_ids,
  });
}

function warn_suspicious_entity_override(
  prompt: string,
  plan: XVibeInferredArtifactPlan,
): void {
  if (
    plan._primary_artifact_type !== "entity" ||
    !prompt_has_explicit_flow_only_language(prompt)
  ) {
    return;
  }

  _xlog.warn("[xvibe] artifact inference suspicious entity override", {
    _prompt: prompt,
    _flow_ids: plan._flow_ids ?? extract_named_flow_ids(prompt),
    _reason: plan._reason,
    _primary_artifact_type: plan._primary_artifact_type,
    _artifact_types: plan._artifact_types,
  });
}

type XVibeArtifactResolverLayer =
  | "explicit_requested_artifact_type"
  | "explicit_only_intent"
  | "named_artifact_intent"
  | "action_intent"
  | "fallback_classifier";

type XVibeNamedArtifactIntent = {
  _artifact_type: XVibeInferredArtifactType;
  _artifact_id: string;
};

type XVibeActionArtifactIntent = {
  _action: XVibeArtifactAction;
  _artifact_type: XVibeInferredArtifactType;
  _artifact_id: string;
};

type XVibeResolvedArtifactPlan = XVibeInferredArtifactPlan & {
  _action_intent?: XVibeActionArtifactIntent;
};

function log_intent_layer_resolved(
  layer: XVibeArtifactResolverLayer,
  artifact_type: XVibeInferredArtifactType,
): void {
  _xlog.log("[xvibe] intent layer resolved", {
    _layer: layer,
    _artifact_type: artifact_type,
  });
}

function artifact_types_for_primary_artifact(
  artifact_type: XVibeInferredArtifactType,
): XVibeInferredArtifactType[] {
  return [artifact_type];
}

function create_resolved_artifact_plan(input: {
  _layer: XVibeArtifactResolverLayer;
  _primary_artifact_type: XVibeInferredArtifactType;
  _artifact_id?: string;
  _flow_ids?: string[];
  _entity_ids?: string[];
  _module_names?: string[];
  _action_intent?: XVibeActionArtifactIntent;
}): XVibeResolvedArtifactPlan {
  const plan: XVibeResolvedArtifactPlan = {
    _primary_artifact_type: input._primary_artifact_type,
    _artifact_types: artifact_types_for_primary_artifact(input._primary_artifact_type),
    ...(input._flow_ids?.length ? { _flow_ids: input._flow_ids } : {}),
    ...(input._entity_ids?.length ? { _entity_ids: input._entity_ids } : {}),
    ...(input._module_names?.length ? { _module_names: input._module_names } : {}),
    ...(input._action_intent ? { _action_intent: input._action_intent } : {}),
    _reason: input._layer,
  };

  log_intent_layer_resolved(
    input._layer,
    input._primary_artifact_type,
  );
  log_artifact_inference_branch(plan);

  return plan;
}

function explicit_requested_artifact_plan(
  prompt: string,
  requested_artifact_type?: VibeRequestedArtifactType,
): XVibeResolvedArtifactPlan | undefined {
  if (
    requested_artifact_type !== "view" &&
    requested_artifact_type !== "flow" &&
    requested_artifact_type !== "entity" &&
    requested_artifact_type !== "command"
  ) {
    return undefined;
  }

  const flow_ids = extract_named_flow_ids(prompt);
  if (requested_artifact_type === "view" && flow_ids.length > 0) {
    const plan: XVibeResolvedArtifactPlan = {
      _primary_artifact_type: "view",
      _artifact_types: ["flow", "view"],
      _flow_ids: flow_ids,
      _reason: "requested_view_with_explicit_flow_dependency",
    };
    log_intent_layer_resolved("explicit_requested_artifact_type", "view");
    log_artifact_inference_branch(plan);
    return plan;
  }

  return create_resolved_artifact_plan({
    _layer: "explicit_requested_artifact_type",
    _primary_artifact_type: requested_artifact_type,
    ...(requested_artifact_type === "flow" && flow_ids.length > 0
      ? { _flow_ids: flow_ids }
      : {}),
  });
}

function explicit_only_artifact_type(prompt: string): XVibeInferredArtifactType | undefined {
  const text = _xu.normalizePrompt(prompt).toLowerCase();
  const target_words: Array<{
    _artifact_type: XVibeInferredArtifactType;
    _words: string[];
  }> = [
    { _artifact_type: "flow", _words: ["flow", "flows"] },
    { _artifact_type: "entity", _words: ["entity", "entities"] },
    { _artifact_type: "view", _words: ["view", "views"] },
    { _artifact_type: "module", _words: ["module", "modules"] },
  ];

  for (const target of target_words) {
    const word_pattern = target._words.join("|");
    if (
      new RegExp(String.raw`\b(?:${word_pattern})\s+only\b`, "u").test(text) ||
      new RegExp(String.raw`\bonly\s+create\s+(?:a\s+|an\s+|the\s+)?(?:${word_pattern})\b`, "u").test(text)
    ) {
      return target._artifact_type;
    }
  }

  return undefined;
}

function explicit_only_artifact_plan(prompt: string): XVibeResolvedArtifactPlan | undefined {
  const artifact_type = explicit_only_artifact_type(prompt);
  if (!artifact_type) return undefined;

  const flow_ids = artifact_type === "flow" ? extract_named_flow_ids(prompt) : [];
  return create_resolved_artifact_plan({
    _layer: "explicit_only_intent",
    _primary_artifact_type: artifact_type,
    ...(flow_ids.length > 0 ? { _flow_ids: flow_ids } : {}),
  });
}

function extract_named_artifact_intent(prompt: string): XVibeNamedArtifactIntent | undefined {
  const named_patterns: Array<{
    _artifact_type: XVibeInferredArtifactType;
    _pattern: RegExp;
  }> = [
    {
      _artifact_type: "flow",
      _pattern: /\bflow\s+(?:named|called|id)\s+["']?([a-z][a-z0-9_-]*)["']?\b/iu,
    },
    {
      _artifact_type: "entity",
      _pattern: /\bentity\s+(?:named|called|id)\s+["']?([a-z][a-z0-9_-]*)["']?\b/iu,
    },
    {
      _artifact_type: "module",
      _pattern: /\b(?:server\s+module|client\s+module|xmodule|module)\s+(?:named|called|id)\s+["']?([a-z][a-z0-9_-]*)["']?\b/iu,
    },
    {
      _artifact_type: "view",
      _pattern: /\bview\s+(?:named|called|id)\s+["']?([a-z][a-z0-9_-]*)["']?\b/iu,
    },
  ];

  for (const item of named_patterns) {
    const match = prompt.match(item._pattern);
    const artifact_id = normalize_artifact_action_id(match?.[1]);
    if (!artifact_id) continue;
    if (item._artifact_type === "flow" && match?.index !== undefined) {
      const prefix = prompt.slice(0, match.index).toLowerCase();
      if (/\b(?:run|trigger|call|execute)\s+(?:a\s+|the\s+)?$/u.test(prefix)) {
        continue;
      }
    }

    const named_intent = {
      _artifact_type: item._artifact_type,
      _artifact_id: artifact_id,
    };
    _xlog.log("[xvibe] named artifact intent", named_intent);

    return named_intent;
  }

  return undefined;
}

function named_artifact_plan(prompt: string): XVibeResolvedArtifactPlan | undefined {
  const named_intent = extract_named_artifact_intent(prompt);
  if (!named_intent) return undefined;

  return create_resolved_artifact_plan({
    _layer: "named_artifact_intent",
    _primary_artifact_type: named_intent._artifact_type,
    ...(named_intent._artifact_type === "flow"
      ? { _flow_ids: [named_intent._artifact_id] }
      : {}),
    ...(named_intent._artifact_type === "entity"
      ? { _entity_ids: [named_intent._artifact_id] }
      : {}),
    ...(named_intent._artifact_type === "module"
      ? { _module_names: [named_intent._artifact_id] }
      : {}),
  });
}

function extract_action_artifact_intent(prompt: string): XVibeActionArtifactIntent | undefined {
  const normalized_prompt =
    _xu.normalizePrompt(prompt)
      .replace(/\s+/g, " ")
      .trim();
  const action_match =
    normalized_prompt.match(
      /\b(delete|remove|rename|archive|disable)\s+(?:the\s+)?(view|flow|entity|module)\s+(?:named\s+|called\s+|id\s+)?["']?([a-z][a-z0-9_-]*)["']?\b/iu,
    );

  if (!action_match) return undefined;

  const raw_action = action_match[1].toLowerCase();
  const artifact_id = normalize_artifact_action_id(action_match[3]);
  if (!artifact_id) return undefined;

  return {
    _action: raw_action === "remove" ? "delete" : raw_action as XVibeArtifactAction,
    _artifact_type: action_match[2].toLowerCase() as XVibeInferredArtifactType,
    _artifact_id: artifact_id,
  };
}

function action_artifact_plan(prompt: string): XVibeResolvedArtifactPlan | undefined {
  const action_intent = extract_action_artifact_intent(prompt);
  if (!action_intent) return undefined;

  _xlog.log("[xvibe] action intent detected", action_intent);

  return create_resolved_artifact_plan({
    _layer: "action_intent",
    _primary_artifact_type: action_intent._artifact_type,
    ...(action_intent._artifact_type === "flow"
      ? { _flow_ids: [action_intent._artifact_id] }
      : {}),
    ...(action_intent._artifact_type === "entity"
      ? { _entity_ids: [action_intent._artifact_id] }
      : {}),
    ...(action_intent._artifact_type === "module"
      ? { _module_names: [action_intent._artifact_id] }
      : {}),
    _action_intent: action_intent,
  });
}

function fallback_artifact_plan(
  prompt: string,
  requested_artifact_type?: VibeRequestedArtifactType,
): XVibeResolvedArtifactPlan {
  const planner = new VibeIntentPlanner();
  const intent = planner.infer_artifact_intent(prompt);
  const plan =
    planner.build_artifact_plan_from_intent(
      prompt,
      intent,
      requested_artifact_type,
    ) as XVibeResolvedArtifactPlan;

  _xlog.log("[xvibe] fallback classifier used", {
    _primary_artifact_type: plan._primary_artifact_type,
    _artifact_types: plan._artifact_types,
    _flow_ids: plan._flow_ids,
    _entity_ids: plan._entity_ids,
    _reason: plan._reason,
  });

  log_intent_layer_resolved(
    "fallback_classifier",
    plan._primary_artifact_type,
  );
  log_artifact_inference_branch(plan);
  warn_suspicious_entity_override(prompt, plan);

  return plan;
}

const ARTIFACT_ACTION_PREFIX =
  String.raw`^\s*(?:(?:please|kindly)\s+|(?:can|could|would)\s+you\s+|(?:i|we)\s+(?:want|need)\s+to\s+)?`;
const ARTIFACT_ACTION_ID_PATTERN = String.raw`["']?([a-z][a-z0-9_-]*)["']?`;
const ARTIFACT_ACTION_TRAILING_PATTERN = String.raw`(?:[\s.,;:!?]|$)`;

function normalize_artifact_action_id(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const normalized = value.trim().replace(/^["'`]+|["'`.,;:]+$/g, "");
  return /^[a-z][a-z0-9_-]*$/iu.test(normalized) ? normalized : undefined;
}

function artifact_entity_action_requires_confirmation(
  artifact_type: XVibeArtifactActionPlan["_artifact_type"],
  action: XVibeArtifactAction,
): boolean {
  return (
    artifact_type === "entity" &&
    (action === "delete" || action === "archive" || action === "rename")
  );
}

function with_artifact_action_safety(plan: XVibeArtifactActionPlan): XVibeArtifactActionPlan {
  if (artifact_entity_action_requires_confirmation(plan._artifact_type, plan._action)) {
    return {
      ...plan,
      _requires_confirmation: true,
    };
  }

  return plan;
}

export function infer_xvibe_artifact_action_plan(
  prompt: string,
): XVibeArtifactActionPlan | undefined {
  const normalized_prompt =
    _xu.normalizePrompt(prompt)
      .replace(/\s+/g, " ")
      .trim();

  const rename_pattern = new RegExp(
    ARTIFACT_ACTION_PREFIX +
    String.raw`rename\s+(?:the\s+)?(view|flow|entity|module)\s+(?:named\s+|called\s+|id\s+)?` +
    ARTIFACT_ACTION_ID_PATTERN +
    String.raw`\s+(?:to|as)\s+` +
    ARTIFACT_ACTION_ID_PATTERN +
    ARTIFACT_ACTION_TRAILING_PATTERN,
    "iu",
  );
  const rename_match = normalized_prompt.match(rename_pattern);
  if (rename_match) {
    const target_id = normalize_artifact_action_id(rename_match[2]);
    const new_id = normalize_artifact_action_id(rename_match[3]);
    if (target_id && new_id) {
      return with_artifact_action_safety({
        _artifact_type: rename_match[1].toLowerCase() as XVibeArtifactActionPlan["_artifact_type"],
        _action: "rename",
        _target_id: target_id,
        _new_id: new_id,
      });
    }
  }

  const action_pattern = new RegExp(
    ARTIFACT_ACTION_PREFIX +
    String.raw`(delete|remove|disable|archive)\s+(?:the\s+)?(view|flow|entity|module)\s+(?:named\s+|called\s+|id\s+)?` +
    ARTIFACT_ACTION_ID_PATTERN +
    ARTIFACT_ACTION_TRAILING_PATTERN,
    "iu",
  );
  const action_match = normalized_prompt.match(action_pattern);
  if (!action_match) {
    return undefined;
  }

  const target_id = normalize_artifact_action_id(action_match[3]);
  if (!target_id) {
    return undefined;
  }

  const raw_action = action_match[1].toLowerCase();
  const action: XVibeArtifactAction = raw_action === "remove" ? "delete" : raw_action as XVibeArtifactAction;

  return with_artifact_action_safety({
    _artifact_type: action_match[2].toLowerCase() as XVibeArtifactActionPlan["_artifact_type"],
    _action: action,
    _target_id: target_id,
  });
}

export function infer_xvibe_artifact_plan(
  prompt: string,
  requested_artifact_type?: VibeRequestedArtifactType,
): XVibeInferredArtifactPlan {
  const explicit_requested_plan =
    explicit_requested_artifact_plan(prompt, requested_artifact_type);
  if (explicit_requested_plan) {
    warn_suspicious_entity_override(prompt, explicit_requested_plan);
    return explicit_requested_plan;
  }

  const explicit_only_plan =
    explicit_only_artifact_plan(prompt);
  if (explicit_only_plan) {
    warn_suspicious_entity_override(prompt, explicit_only_plan);
    return explicit_only_plan;
  }

  const named_plan =
    named_artifact_plan(prompt);
  if (named_plan) {
    warn_suspicious_entity_override(prompt, named_plan);
    return named_plan;
  }

  const action_plan =
    action_artifact_plan(prompt);
  if (action_plan) {
    warn_suspicious_entity_override(prompt, action_plan);
    return action_plan;
  }

  return fallback_artifact_plan(prompt, requested_artifact_type);
}

export function infer_xvibe_artifact_type(
  prompt: string,
  requested_artifact_type?: VibeRequestedArtifactType,
): XVibeInferredArtifactType {
  return infer_xvibe_artifact_plan(
    prompt,
    requested_artifact_type,
  )._primary_artifact_type;
}

function read_generated_text(value: unknown): string {
  if (_xu.is_plain_object(value) && typeof value._text === "string" && value._text.trim().length > 0) {
    return value._text;
  }

  throw new Error("Invalid xai response: missing '_text'");
}

function generated_module_method_name(op_name: string): string {
  return `_${op_name.replaceAll("-", "_")}`;
}

export function build_generated_module_implementation_prompt(input: {
  spec: XVibeModuleCreatorSpec;
  user_request: string;
  project_memory?: unknown;
  current_or_generated_view?: unknown;
  originating_view?: unknown;
  server_module_call_graph?: XVibeServerModuleCallGraph;
  validation_errors?: unknown;
  rejected_attempts?: XVibeGeneratedModuleRejectedAttempt[];
}): string {
  const module_ops =
    input.spec._ops.map((op) => op._name);
  const current_or_generated_view =
    input.current_or_generated_view ?? input.originating_view;
  const implementation_context: XVibeJsonObject = {
    _original_user_prompt: input.user_request,
    _module_name: input.spec._name,
    _module_ops: module_ops,
    ...(input.project_memory !== undefined
      ? { _project_memory: input.project_memory }
      : {}),
    _server_module_call_graph: input.server_module_call_graph ?? {},
    ...(current_or_generated_view !== undefined
      ? { _current_or_generated_view: current_or_generated_view }
      : {}),
    ...(input.validation_errors !== undefined
      ? { _previous_validation_errors: input.validation_errors }
      : {}),
    ...(input.rejected_attempts && input.rejected_attempts.length > 0
      ? { _previous_rejected_attempts: input.rejected_attempts }
      : {}),
  };

  const rejected_categories =
    new Set(
      (input.rejected_attempts ?? []).map((attempt) => attempt._category)
    );
  const retry_instructions: string[] =
    [];

  if (rejected_categories.has("placeholder_content")) {
    retry_instructions.push(
      "Previous implementation was rejected for placeholder code.",
      "Every returned method must have a complete method body.",
      "Ban TODO comments, placeholder comments, and not implemented text."
    );
  }

  if (rejected_categories.has("weak_behavior")) {
    retry_instructions.push(
      "Previous implementation was rejected because it was a stub.",
      "Implement state mutation, calculation, validation, or meaningful transformation according to the prompt and view context.",
      "Return JSON-safe results that the generated view can consume."
    );
  }

  if (rejected_categories.has("forbidden_content")) {
    retry_instructions.push(
      "Previous implementation was rejected for forbidden runtime content.",
      "Keep implementation local and deterministic, without filesystem, network, eval, Function, dynamic import, timers, process, or child_process access."
    );
  }

  if (rejected_categories.has("syntax_or_shape_error")) {
    retry_instructions.push(
      "Previous implementation was rejected for syntax or method shape.",
      "Return exactly one method declaration string for each declared method, with the correct underscore method name.",
      "Return helper methods using method syntax under _helper_sources."
    );
  }

  if (rejected_categories.has("helper_method_misplaced")) {
    retry_instructions.push(
      "checkWinner and makeState must be returned under _helper_sources without leading underscores.",
      "Do not put helper methods in _method_sources.",
      "Do not prefix helper names with underscores."
    );
  }

  return [
    "You are implementing declared methods for a generated Xpell server XModule.",
    "Return strict JSON only.",
    "",
    "Output contract:",
    '{ "_method_sources": { "_methodName": "async _methodName(xcmd) { ... }" }, "_helper_sources": { "helperName": "helperName(value) { ... }" } }',
    "",
    "Rules:",
    "Public command methods go in _method_sources.",
    "Internal helpers go in _helper_sources.",
    "Do not prefix helper names with '_'.",
    "Do not put helper methods in _method_sources.",
    "Return method implementations only.",
    "Do not return full module.js.",
    "Do not include imports, exports, class declarations, static metadata, or constructor.",
    "Implement only declared operation methods listed below.",
    "Helper methods must not be runtime ops and must not modify static _ops or the manifest.",
    "Use only local JavaScript.",
    "Use xcmd and xcmd._params for inputs.",
    "Return JSON-safe objects.",
    "Do not use fetch, filesystem APIs, child_process, eval, Function, timers, dynamic import, process.exit, or globalThis.process.",
    "Do not return placeholder code.",
    "Do not include TODO, FIXME, implement here, implement logic, not implemented, or placeholder text.",
    "Use the implementation context to infer concrete behavior from the original prompt, view wiring, and server call graph.",
    ...(retry_instructions.length > 0
      ? [
        "",
        "Retry instructions:",
        ...retry_instructions,
      ]
      : []),
    "",
    "Implementation context:",
    JSON.stringify(implementation_context, null, 2),
    "",
    "Module manifest:",
    JSON.stringify({
      _id: input.spec._id,
      _name: input.spec._name,
      _description: input.spec._description,
      _target: input.spec._target,
      _ops: input.spec._ops.map((op) => ({
        _name: op._name,
        _method: generated_module_method_name(op._name),
        _description: op._description,
        ...(op._params ? { _params: op._params } : {}),
        ...(op._result ? { _result: op._result } : {}),
      })),
    }, null, 2),
    "",
    "User request:",
    input.user_request,
    "",
    ...(input.validation_errors !== undefined
      ? [
        "Previous implementation validation errors:",
        JSON.stringify(input.validation_errors, null, 2),
        "",
      ]
      : []),
    ...(input.rejected_attempts && input.rejected_attempts.length > 0
      ? [
        "Previous rejected method sources/excerpts:",
        JSON.stringify(input.rejected_attempts, null, 2),
        "",
      ]
      : []),
    "Return JSON now.",
  ].join("\n");
}

function parse_generated_module_implementation_methods(
  value: unknown
): XVibeGeneratedModuleImplementationSources {
  const parsed =
    JSON.parse(
      repair_json(
        extract_balanced_json(
          read_generated_text(value)
        )
      )
    ) as unknown;

  if (!_xu.is_plain_object(parsed)) {
    throw new Error("Invalid generated module implementation response: expected object");
  }

  const raw_method_sources =
    _xu.is_plain_object(parsed._method_sources)
      ? parsed._method_sources
      : _xu.is_plain_object(parsed._methods)
        ? parsed._methods
        : {};
  const raw_helper_sources =
    _xu.is_plain_object(parsed._helper_sources)
      ? parsed._helper_sources
      : {};

  const method_sources: XVibeGeneratedModuleImplementationMethods =
    {};
  const helper_sources: XVibeGeneratedModuleImplementationMethods =
    {};

  for (const [method_name, method_source] of Object.entries(raw_method_sources)) {
    if (
      typeof method_name !== "string" ||
      !method_name.startsWith("_") ||
      typeof method_source !== "string" ||
      method_source.trim().length === 0
    ) {
      throw new Error("Invalid generated module implementation response: method sources must be non-empty strings");
    }

    method_sources[method_name] =
      method_source;
  }

  for (const [helper_name, helper_source] of Object.entries(raw_helper_sources)) {
    if (
      typeof helper_name !== "string" ||
      typeof helper_source !== "string" ||
      helper_source.trim().length === 0
    ) {
      throw new Error("Invalid generated module implementation response: helper sources must be non-empty strings");
    }

    helper_sources[helper_name] =
      helper_source;
  }

  if (
    Object.keys(method_sources).length === 0 &&
    Object.keys(helper_sources).length === 0
  ) {
    throw new Error("Invalid generated module implementation response: no method or helper sources returned");
  }

  return {
    _method_sources: method_sources,
    _helper_sources: helper_sources,
  };
}

function unwrap_command_result(value: unknown): unknown {
  if (!_xu.is_plain_object(value) || typeof value._ok !== "boolean") {
    return value;
  }

  if (value._ok === false) {
    throw new Error(`Command failed: ${JSON.stringify(value._error ?? value._result ?? value)}`);
  }

  return Object.prototype.hasOwnProperty.call(value, "_result")
    ? value._result
    : value;
}

function read_command_error_code(value: unknown): string | undefined {
  if (!_xu.is_plain_object(value)) {
    return undefined;
  }

  if (_xu.is_plain_object(value._error) && typeof value._error._code === "string") {
    return value._error._code;
  }

  if (_xu.is_plain_object(value._result)) {
    return read_command_error_code(value._result);
  }

  return undefined;
}

function read_command_error_category(
  value: unknown
): XVibeGeneratedModuleImplementationValidationCategory | undefined {
  if (!_xu.is_plain_object(value)) {
    return undefined;
  }

  if (
    _xu.is_plain_object(value._error) &&
    typeof value._error._category === "string"
  ) {
    return normalize_implementation_validation_category(value._error._category);
  }

  if (_xu.is_plain_object(value._result)) {
    return read_command_error_category(value._result);
  }

  return undefined;
}

function normalize_implementation_validation_category(
  value: unknown
): XVibeGeneratedModuleImplementationValidationCategory {
  if (
    value === "placeholder_content" ||
    value === "forbidden_content" ||
    value === "syntax_or_shape_error" ||
    value === "weak_behavior" ||
    value === "helper_method_misplaced" ||
    value === "unknown"
  ) {
    return value;
  }

  return "unknown";
}

function classify_implementation_validation_failure(
  value: unknown
): XVibeGeneratedModuleImplementationValidationCategory {
  const category =
    read_command_error_category(value);

  if (category) {
    return category;
  }

  const code =
    read_command_error_code(value);

  if (code === "E_MODULE_CREATOR_IMPLEMENTATION_PLACEHOLDER") {
    return "placeholder_content";
  }

  if (
    code === "E_MODULE_CREATOR_IMPLEMENTATION_FORBIDDEN_CONTENT" ||
    code === "E_MODULE_CREATOR_FORBIDDEN_CONTENT"
  ) {
    return "forbidden_content";
  }

  if (code === "E_MODULE_CREATOR_IMPLEMENTATION_WEAK_BEHAVIOR") {
    return "weak_behavior";
  }

  if (code === "E_MODULE_CREATOR_HELPER_METHOD_MISPLACED") {
    return "helper_method_misplaced";
  }

  if (
    code?.includes("METHOD") ||
    code?.includes("SCOPE") ||
    code?.includes("VALIDATION") ||
    code?.includes("SYNTAX") ||
    code?.includes("SHAPE")
  ) {
    return "syntax_or_shape_error";
  }

  return "unknown";
}

function method_source_excerpts(
  methods: XVibeGeneratedModuleImplementationMethods
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(methods).map(([method_name, method_source]) => [
      method_name,
      method_source.length > 700
        ? `${method_source.slice(0, 700)}...`
        : method_source,
    ])
  );
}

function structured_implementation_attempt_error(input: {
  module_name: string;
  module_ops: string[];
  attempts: XVibeGeneratedModuleRejectedAttempt[];
}): XVibeJsonObject {
  return {
    _ok: false,
    _error: {
      _code: "E_XVIBE_GENERATED_MODULE_IMPLEMENTATION_FAILED",
      _message: "Generated module implementation failed validation after bounded attempts.",
      _category: "unknown",
      _details: {
        _module_name: input.module_name,
        _module_ops: input.module_ops,
        _max_attempts: GENERATED_MODULE_IMPLEMENTATION_MAX_ATTEMPTS,
        _attempts: input.attempts,
        _validation_errors: input.attempts.map((attempt) => ({
          _attempt: attempt._attempt,
          _category: attempt._category,
          _validation_errors: attempt._validation_errors,
        })),
      },
    },
  };
}

function structured_error_payload(
  error: unknown
): XVibeJsonObject | undefined {
  return (
    error instanceof XVibeStructuredError
      ? error._payload
      : undefined
  ) ??
    RunArchiveManager.errorPayload(error) ??
    RuntimeContextManager.errorPayload(error);
}

function unsupported_artifact_action_result(input: {
  _action: string;
  _artifact_type: string;
  _artifact_id?: string;
}): XVibeJsonObject {
  return {
    _ok: false,
    _error: {
      _code: XVIBE_ARTIFACT_ACTION_NOT_SUPPORTED,
      _message: `Artifact action '${input._action}' is not supported from Vibe prompts yet.`,
      _action: input._action,
      _artifact_type: input._artifact_type,
      ...(input._artifact_id ? { _artifact_id: input._artifact_id } : {}),
    },
  };
}

function module_generation_requirement_error_result(input: {
  _code: "E_XVIBE_MODULE_NAME_REQUIRED" | "E_XVIBE_MODULE_OPS_REQUIRED";
  _resolved_task: XVibeResolvedTask;
}): XVibeJsonObject {
  return {
    _ok: false,
    _error: {
      _code: input._code,
      _message:
        input._code === "E_XVIBE_MODULE_NAME_REQUIRED"
          ? "Module generation requires an explicit module name."
          : "Module generation requires at least one explicit module operation.",
      _artifact_type: "module",
      _resolved_task: input._resolved_task,
    },
  };
}

function validation_plan_error_result(input: {
  _validation_plan: XVibeValidationPlan;
  _resolved_task: XVibeResolvedTask;
}): XVibeJsonObject {
  return {
    _ok: false,
    _error: {
      _code: XVIBE_PLAN_VALIDATION_FAILED,
      _message: "XVibe generation plan validation failed.",
      _validation_plan: input._validation_plan,
      _resolved_task: input._resolved_task,
    },
  };
}

function error_summary(error: unknown): XVibeJsonObject | string {
  if (error instanceof Error) {
    return {
      _name: error.name,
      _message: error.message,
    };
  }

  return String(error);
}

function mutation_plan_error_result(input: {
  _code: string;
  _message: string;
  _details?: XVibeJsonObject;
}): XVibeJsonObject {
  return {
    _ok: false,
    _status: "failed",
    _completed_steps: 0,
    _failed_steps: 0,
    _steps: [],
    _error: {
      _code: input._code,
      _message: input._message,
      ...(input._details ? { _details: input._details } : {}),
    },
  };
}

function mutation_plan_step_error(value: unknown): XVibeJsonObject {
  if (_xu.is_plain_object(value)) {
    const error =
      _xu.is_plain_object(value._error)
        ? value._error
        : _xu.is_plain_object(value._result)
          ? value._result
          : value;
    const code =
      typeof error._code === "string" && error._code.trim()
        ? error._code.trim()
        : typeof error.code === "string" && error.code.trim()
          ? error.code.trim()
          : "E_XVIBE_MUTATION_PLAN_STEP_FAILED";
    const message =
      typeof error._message === "string" && error._message.trim()
        ? error._message.trim()
        : typeof error.message === "string" && error.message.trim()
          ? error.message.trim()
          : "Mutation plan step failed.";
    return {
      _code: code,
      _message: message,
      _details: error,
    };
  }

  if (value instanceof Error) {
    return {
      _code: "E_XVIBE_MUTATION_PLAN_STEP_FAILED",
      _message: value.message,
    };
  }

  return {
    _code: "E_XVIBE_MUTATION_PLAN_STEP_FAILED",
    _message: "Mutation plan step failed.",
    _details: {
      _error: String(value),
    },
  };
}

function validate_mutation_plan_primitive(input: {
  _primitive: unknown;
  _app_id: string;
  _env: string;
  _step_id: string;
}): XVibeMutationPlanPrimitive | { _error: XVibeJsonObject } {
  if (!_xu.is_plain_object(input._primitive)) {
    return {
      _error: {
        _code: "E_XVIBE_MUTATION_PLAN_INVALID_PRIMITIVE",
        _message: `Mutation plan step '${input._step_id}' is missing a primitive descriptor.`,
      },
    };
  }

  if (
    input._primitive._module !== "xvibe" ||
    input._primitive._op !== "apply-view-edit"
  ) {
    return {
      _error: {
        _code: "E_XVIBE_MUTATION_PLAN_PRIMITIVE_NOT_ALLOWED",
        _message: `Mutation plan step '${input._step_id}' uses an unsupported primitive.`,
        _details: {
          _module: input._primitive._module,
          _op: input._primitive._op,
        },
      },
    };
  }

  if (!_xu.is_plain_object(input._primitive._params)) {
    return {
      _error: {
        _code: "E_XVIBE_MUTATION_PLAN_INVALID_PRIMITIVE_PARAMS",
        _message: `Mutation plan step '${input._step_id}' has invalid primitive params.`,
      },
    };
  }

  const canonical =
    canonicalizeSemanticViewEditParams(input._primitive._params);
  if (!canonical._ok) {
    return {
      _error: {
        _code: "E_XVIBE_MUTATION_PLAN_INVALID_PRIMITIVE_PARAMS",
        _message: `Mutation plan step '${input._step_id}' failed primitive contract validation.`,
        _details: {
          _reason: canonical._reason,
        },
      },
    };
  }

  const params = canonical._params;
  if (!isStructuredViewEditAction(params._edit_action)) {
    return {
      _error: {
        _code: "E_XVIBE_MUTATION_PLAN_UNSUPPORTED_EDIT_ACTION",
        _message: `Mutation plan step '${input._step_id}' has an unsupported edit action.`,
        _details: {
          _edit_action: params._edit_action,
        },
      },
    };
  }

  const primitive_app_id =
    typeof params._app_id === "string" ? params._app_id.trim() : "";
  const primitive_env =
    typeof params._env === "string" ? params._env.trim() : "";
  const primitive_view_id =
    typeof params._view_id === "string" ? params._view_id.trim() : "";
  if (!primitive_app_id || !primitive_env || !primitive_view_id) {
    return {
      _error: {
        _code: "E_XVIBE_MUTATION_PLAN_PRIMITIVE_CONTEXT_MISSING",
        _message: `Mutation plan step '${input._step_id}' is missing app/env/view context.`,
      },
    };
  }

  if (primitive_app_id !== input._app_id || primitive_env !== input._env) {
    return {
      _error: {
        _code: "E_XVIBE_MUTATION_PLAN_CONTEXT_MISMATCH",
        _message: `Mutation plan step '${input._step_id}' does not match the active app/env context.`,
        _details: {
          _app_id: input._app_id,
          _env: input._env,
          _primitive_app_id: primitive_app_id,
          _primitive_env: primitive_env,
        },
      },
    };
  }

  return {
    _module: "xvibe",
    _op: "apply-view-edit",
    _params: { ...params },
  };
}

function validate_mutation_plan_for_execution(input: {
  _plan: unknown;
  _app_id: string;
  _env: string;
}): XVibeMutationPlanValidationResult {
  if (!_xu.is_plain_object(input._plan)) {
    return {
      _ok: false,
      _code: "E_XVIBE_MUTATION_PLAN_INVALID",
      _message: "Mutation plan is required.",
    };
  }

  if (input._plan._type !== "mutation-plan") {
    return {
      _ok: false,
      _code: "E_XVIBE_MUTATION_PLAN_INVALID_TYPE",
      _message: "Mutation plan must have _type 'mutation-plan'.",
    };
  }

  if (input._plan._can_apply !== true) {
    return {
      _ok: false,
      _code: "E_XVIBE_MUTATION_PLAN_NOT_READY",
      _message: "Mutation plan is not ready to apply.",
    };
  }

  const raw_steps =
    Array.isArray(input._plan._steps) ? input._plan._steps : undefined;
  if (!raw_steps || raw_steps.length === 0) {
    return {
      _ok: false,
      _code: "E_XVIBE_MUTATION_PLAN_EMPTY",
      _message: "Mutation plan must contain executable steps.",
    };
  }

  const unsupported_steps =
    raw_steps.filter((step) =>
      _xu.is_plain_object(step) && step._status === "unsupported"
    );
  if (
    input._plan._unsupported_steps !== 0 ||
    unsupported_steps.length > 0
  ) {
    return {
      _ok: false,
      _code: "E_XVIBE_MUTATION_PLAN_UNSUPPORTED_STEPS",
      _message: "Mutation plan contains unsupported steps.",
      _details: {
        _unsupported_steps:
          unsupported_steps.map((step) => step._id).filter(Boolean),
      },
    };
  }

  const steps: XVibeMutationPlanStep[] = [];
  for (const [index, raw_step] of raw_steps.entries()) {
    if (!_xu.is_plain_object(raw_step)) {
      return {
        _ok: false,
        _code: "E_XVIBE_MUTATION_PLAN_INVALID_STEP",
        _message: `Mutation plan step ${index} is invalid.`,
      };
    }

    const step_id =
      typeof raw_step._id === "string" && raw_step._id.trim()
        ? raw_step._id.trim()
        : `step-${index + 1}`;
    const primitive =
      validate_mutation_plan_primitive({
        _primitive: raw_step._primitive,
        _app_id: input._app_id,
        _env: input._env,
        _step_id: step_id,
      });
    if ("_error" in primitive) {
      return {
        _ok: false,
        _code: primitive._error._code as string,
        _message: primitive._error._message as string,
        _details: _xu.is_plain_object(primitive._error._details)
          ? primitive._error._details as XVibeJsonObject
          : undefined,
      };
    }

    steps.push({
      ...raw_step,
      _id: step_id,
      _status: "planned",
      _primitive: primitive,
    } as XVibeMutationPlanStep);
  }

  return {
    _ok: true,
    _plan: input._plan as XVibeMutationPlanArtifact,
    _steps: steps,
  };
}

function mutation_plan_existing_stable_child_result(input: {
  _view: XVibeJsonObject;
  _params: XVibeJsonObject;
}): XVibeJsonObject | undefined {
  if (input._params._edit_action !== "add-child") return undefined;
  if (!_xu.is_plain_object(input._params._child)) return undefined;

  const target_id =
    typeof input._params._target_id === "string" && input._params._target_id.trim()
      ? input._params._target_id.trim()
      : "";
  const child_id =
    typeof input._params._child._id === "string" && input._params._child._id.trim()
      ? input._params._child._id.trim()
      : "";
  if (!target_id || !child_id) return undefined;

  const target =
    find_view_node_by_id(input._view, target_id);
  if (!target || !Array.isArray(target._children)) {
    return undefined;
  }

  const existing_child =
    target._children.find((child) =>
      _xu.is_plain_object(child) && child._id === child_id
    );
  if (!existing_child) return undefined;

  return {
    _ok: true,
    _artifact_type: "view",
    _artifact_id: input._params._view_id,
    _view_id: input._params._view_id,
    _deterministic: true,
    _mutation_action: "add-child",
    _target_id: target_id,
    _child_id: child_id,
    _created: false,
    _reason: "already_exists",
    _idempotent: true,
  };
}

function mutation_plan_existing_completed_move_result(input: {
  _view: XVibeJsonObject;
  _params: XVibeJsonObject;
}): XVibeJsonObject | undefined {
  if (input._params._edit_action !== "move-object") return undefined;

  const destination_id =
    typeof input._params._destination_id === "string" && input._params._destination_id.trim()
      ? input._params._destination_id.trim()
      : "";
  const target_id =
    typeof input._params._target_id === "string" && input._params._target_id.trim()
      ? input._params._target_id.trim()
      : "";
  const target_text =
    typeof input._params._target_text === "string" && input._params._target_text.trim()
      ? input._params._target_text.trim()
      : target_id;
  const target_type =
    typeof input._params._target_type === "string" && input._params._target_type.trim()
      ? input._params._target_type.trim()
      : "";
  if (!destination_id || (!target_id && !target_text)) return undefined;

  const destination_resolution =
    resolveViewTarget(input._view, {
      _target_id: destination_id,
      _target_text:
        typeof input._params._destination_text === "string" &&
        input._params._destination_text.trim()
          ? input._params._destination_text.trim()
          : undefined,
      _target_type:
        typeof input._params._destination_type === "string" &&
        input._params._destination_type.trim()
          ? input._params._destination_type.trim()
          : undefined,
      _target_id_text_fallback: true,
      _include_id: true,
      _allow_root: false,
    });
  if (
    !destination_resolution._ok ||
    !Array.isArray(destination_resolution.object._children)
  ) {
    return undefined;
  }

  const source_resolution =
    resolveViewTarget(input._view, {
      _target_id: target_id || undefined,
      _target_text: target_text || undefined,
      _target_type: target_type || undefined,
      _target_id_text_fallback: true,
      _include_id: Boolean(target_id),
    });
  if (!source_resolution._ok) return undefined;
  if (source_resolution.parent !== destination_resolution.object) {
    return undefined;
  }

  const moved_id =
    typeof source_resolution._resolved_target_id === "string" &&
    source_resolution._resolved_target_id.trim()
      ? source_resolution._resolved_target_id.trim()
      : undefined;

  return {
    _ok: true,
    _artifact_type: "view",
    _artifact_id: input._params._view_id,
    _view_id: input._params._view_id,
    _deterministic: true,
    _mutation_action: "move-object",
    ...(moved_id ? { _target_id: moved_id, _moved_id: moved_id } : {}),
    ...(moved_id ? {} : { _target_path: source_resolution._resolved_target_path }),
    _destination_id:
      typeof destination_resolution._resolved_target_id === "string"
        ? destination_resolution._resolved_target_id
        : destination_id,
    _moved: false,
    _reason: "already_exists",
    _idempotent: true,
  };
}

function mutation_plan_existing_completed_bind_flow_result(input: {
  _view: XVibeJsonObject;
  _params: XVibeJsonObject;
}): XVibeJsonObject | undefined {
  if (input._params._edit_action !== "bind-flow") return undefined;

  const target_id =
    typeof input._params._target_id === "string" && input._params._target_id.trim()
      ? input._params._target_id.trim()
      : "";
  const target_text =
    typeof input._params._target_text === "string" && input._params._target_text.trim()
      ? input._params._target_text.trim()
      : target_id;
  const target_type =
    typeof input._params._target_type === "string" && input._params._target_type.trim()
      ? input._params._target_type.trim()
      : "";
  const flow =
    _xu.is_plain_object(input._params._flow) ? input._params._flow : undefined;
  const flow_id =
    typeof flow?._id === "string" && flow._id.trim()
      ? flow._id.trim()
      : "";
  const flow_payload =
    flow && _xu.is_plain_object(flow._payload) ? flow._payload : {};
  const flow_event =
    typeof input._params._flow_event === "string" && input._params._flow_event.trim()
      ? input._params._flow_event.trim()
      : "click";
  const flow_auto =
    typeof input._params._flow_auto === "boolean"
      ? input._params._flow_auto
      : true;
  if ((!target_id && !target_text) || !flow_id) return undefined;

  const target_resolution =
    resolveViewTarget(input._view, {
      _target_id: target_id || undefined,
      _target_text: target_text || undefined,
      _target_type: target_type || undefined,
      _target_id_text_fallback: true,
      _include_id: Boolean(target_id),
    });
  if (!target_resolution._ok) return undefined;

  const existing_flow =
    _xu.is_plain_object(target_resolution.object._flow)
      ? target_resolution.object._flow
      : undefined;
  if (
    existing_flow?._id !== flow_id ||
    JSON.stringify(existing_flow?._payload ?? {}) !== JSON.stringify(flow_payload) ||
    target_resolution.object._flow_event !== flow_event ||
    target_resolution.object._flow_auto !== flow_auto
  ) {
    return undefined;
  }

  const resolved_target_id =
    typeof target_resolution._resolved_target_id === "string" &&
    target_resolution._resolved_target_id.trim()
      ? target_resolution._resolved_target_id.trim()
      : undefined;

  return {
    _ok: true,
    _artifact_type: "view",
    _artifact_id: input._params._view_id,
    _view_id: input._params._view_id,
    _deterministic: true,
    _mutation_action: "bind-flow",
    ...(resolved_target_id ? { _target_id: resolved_target_id } : {}),
    ...(resolved_target_id ? {} : { _target_path: target_resolution._resolved_target_path }),
    _flow: {
      _id: flow_id,
      _payload: clone_json(flow_payload),
    },
    _flow_event: flow_event,
    _flow_auto: flow_auto,
    _created: false,
    _reason: "already_exists",
    _idempotent: true,
  };
}

function mutation_plan_existing_completed_property_result(input: {
  _view: XVibeJsonObject;
  _params: XVibeJsonObject;
}): XVibeJsonObject | undefined {
  if (
    input._params._edit_action !== "set-property" &&
    input._params._edit_action !== "update-property"
  ) {
    return undefined;
  }

  const property_name =
    typeof input._params._property_name === "string" &&
    input._params._property_name.trim()
      ? input._params._property_name.trim()
      : "";
  if (!property_name) return undefined;

  const target_id =
    typeof input._params._target_id === "string" && input._params._target_id.trim()
      ? input._params._target_id.trim()
      : "";
  const target_text =
    typeof input._params._target_text === "string" && input._params._target_text.trim()
      ? input._params._target_text.trim()
      : target_id;
  const target_type =
    typeof input._params._target_type === "string" && input._params._target_type.trim()
      ? input._params._target_type.trim()
      : "";
  if (!target_id && !target_text) return undefined;

  const target_resolution =
    resolveViewTarget(input._view, {
      _target_id: target_id || undefined,
      _target_text: target_text || undefined,
      _target_type: target_type || undefined,
      _target_id_text_fallback: true,
      _include_id: Boolean(target_id),
      _allow_root: deterministic_target_type_is_view(target_type),
    });
  if (!target_resolution._ok) return undefined;

  const current_value =
    target_resolution.object[property_name];
  const next_value =
    input._params._property_value;
  if (JSON.stringify(current_value) !== JSON.stringify(next_value)) {
    return undefined;
  }

  const resolved_target_id =
    typeof target_resolution._resolved_target_id === "string" &&
    target_resolution._resolved_target_id.trim()
      ? target_resolution._resolved_target_id.trim()
      : undefined;

  return {
    _ok: true,
    _artifact_type: "view",
    _artifact_id: input._params._view_id,
    _view_id: input._params._view_id,
    _deterministic: true,
    _mutation_action: "set-property",
    ...(resolved_target_id ? { _target_id: resolved_target_id } : {}),
    ...(resolved_target_id ? {} : { _target_path: target_resolution._resolved_target_path }),
    _property_name: property_name,
    _next_value: clone_json(next_value),
    _created: false,
    _reason: "already_exists",
    _idempotent: true,
  };
}

function extract_project_memory(value: unknown): Record<string, any> | undefined {
  if (!_xu.is_plain_object(value)) return undefined;

  if (_xu.is_plain_object(value._memory)) {
    return value._memory;
  }

  if (_xu.is_plain_object(value._result)) {
    return extract_project_memory(value._result);
  }

  return undefined;
}

function clone_json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function planning_answer_is_complete(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === "string" && value.trim().length > 0;
}

function read_planning_answer(
  draft: XVibeJsonObject,
  question: XVibeJsonObject,
): unknown {
  if (_xu.is_plain_object(draft._answers)) {
    const answer = draft._answers[question._id as string];
    if (planning_answer_is_complete(answer)) return answer;
  }

  return question._answer;
}

function is_active_project_plan_question(question_id: unknown): boolean {
  return question_id !== "runtime";
}

function validate_project_plan_draft(draft: unknown): {
  _ok: true;
  _draft: XVibeJsonObject;
  _questions: XVibeJsonObject[];
} | {
  _ok: false;
  _errors: string[];
} {
  const errors: string[] = [];
  if (!_xu.is_plain_object(draft)) {
    return {
      _ok: false,
      _errors: ["planning_draft_missing"],
    };
  }

  if (draft._type !== "project-plan") errors.push("draft_type_invalid");
  if (draft._stage !== "planning") errors.push("draft_stage_invalid");
  const active_unanswered =
    Array.isArray(draft._unanswered)
      ? draft._unanswered.filter((question_id) =>
        is_active_project_plan_question(question_id)
      )
      : [];
  const active_current_question =
    _xu.is_plain_object(draft._current_question) &&
    is_active_project_plan_question(draft._current_question._id);
  if (
    draft._status !== "ready-for-confirmation" &&
    (active_unanswered.length > 0 || active_current_question)
  ) {
    errors.push("draft_not_ready_for_confirmation");
  }
  if (active_unanswered.length > 0) {
    errors.push("required_questions_unanswered");
  }
  if (draft._current_question !== null && active_current_question) {
    errors.push("current_question_not_cleared");
  }
  if (typeof draft._goal !== "string" || draft._goal.trim().length === 0) {
    errors.push("goal_missing");
  }
  if (!Array.isArray(draft._questions)) {
    errors.push("questions_missing");
  }

  const questions = Array.isArray(draft._questions)
    ? draft._questions.filter((question): question is XVibeJsonObject =>
      _xu.is_plain_object(question) &&
      typeof question._id === "string" &&
      typeof question._question === "string",
    )
    : [];

  for (const question of questions) {
    if (!is_active_project_plan_question(question._id)) continue;
    if (question._required === false) continue;
    const answer = read_planning_answer(draft, question);
    if (!planning_answer_is_complete(answer)) {
      errors.push(`required_question_unanswered:${question._id}`);
    }
  }

  if (!_xu.is_plain_object(draft._proposed)) {
    errors.push("proposed_artifacts_missing");
  }
  if (!Array.isArray(draft._milestones) || draft._milestones.length === 0) {
    errors.push("milestones_missing");
  }

  return errors.length === 0
    ? {
      _ok: true,
      _draft: draft,
      _questions: questions,
    }
    : {
      _ok: false,
      _errors: [...new Set(errors)],
    };
}

function unwrap_project_plan_payload(value: unknown): XVibeJsonObject | undefined {
  if (!_xu.is_plain_object(value)) return undefined;

  if (value._type === "project-plan") {
    return value;
  }

  if (
    value._artifact_type === "project-plan" &&
    _xu.is_plain_object(value._artifact_request)
  ) {
    return unwrap_project_plan_payload(value._artifact_request);
  }

  if (_xu.is_plain_object(value._project_plan)) {
    return unwrap_project_plan_payload(value._project_plan);
  }

  if (_xu.is_plain_object(value._artifact)) {
    return unwrap_project_plan_payload(value._artifact);
  }

  return undefined;
}

function read_confirm_project_plan_fallback(params: XVibeJsonObject): XVibeJsonObject | undefined {
  return unwrap_project_plan_payload(params._project_plan) ??
    unwrap_project_plan_payload(params._artifact);
}

function normalize_project_plan_milestones(value: unknown): XVibeJsonObject[] {
  if (!Array.isArray(value)) return [];

  const milestones: XVibeJsonObject[] = [];
  for (const raw_milestone of value) {
    if (!_xu.is_plain_object(raw_milestone)) continue;

    const title =
      typeof raw_milestone._title === "string" && raw_milestone._title.trim()
        ? raw_milestone._title.trim()
        : typeof raw_milestone._id === "string" && raw_milestone._id.trim()
          ? raw_milestone._id.trim()
          : "";
    const id =
      _xu.normalize_id(raw_milestone._id) ||
      _xu.normalize_id(title);
    if (!id || !title) continue;

    const items: XVibeJsonObject[] = [];
    const raw_items = Array.isArray(raw_milestone._items)
      ? raw_milestone._items
      : [];
    for (const raw_item of raw_items) {
      const item_title =
        typeof raw_item === "string"
          ? raw_item.trim()
          : _xu.is_plain_object(raw_item) &&
              typeof raw_item._title === "string" &&
              raw_item._title.trim()
            ? raw_item._title.trim()
            : _xu.is_plain_object(raw_item) &&
                typeof raw_item._id === "string" &&
                raw_item._id.trim()
              ? raw_item._id.trim()
              : "";
      const item_id =
        _xu.is_plain_object(raw_item)
          ? _xu.normalize_id(raw_item._id) || _xu.normalize_id(item_title)
          : _xu.normalize_id(item_title);
      if (!item_id || !item_title) continue;

      items.push({
        _id: item_id,
        _title: item_title,
        _completed: _xu.is_plain_object(raw_item)
          ? raw_item._completed === true
          : false,
      });
    }

    milestones.push({
      _id: id,
      _title: title,
      _items: items,
    });
  }

  return milestones;
}

function project_plan_decisions(input: {
  _draft: XVibeJsonObject;
  _questions: XVibeJsonObject[];
}): XVibeJsonObject[] {
  return input._questions.map((question) => {
    const answer = read_planning_answer(input._draft, question);
    return {
      _id: question._id,
      _type: "planning-answer",
      _title: question._question,
      ...(answer !== undefined ? { _answer: clone_json(answer) } : {}),
    };
  });
}

function project_plan_memory_patch(input: {
  _draft: XVibeJsonObject;
  _questions: XVibeJsonObject[];
}): XVibeJsonObject {
  const proposed = _xu.is_plain_object(input._draft._proposed)
    ? input._draft._proposed
    : {};
  const milestones = normalize_project_plan_milestones(input._draft._milestones);
  const first_focus =
    typeof milestones[0]?._title === "string"
      ? milestones[0]._title
      : "";

  return {
    _stage: "building",
    _goal: input._draft._goal,
    ...(typeof input._draft._summary === "string"
      ? { _summary: input._draft._summary }
      : {}),
    _decisions: project_plan_decisions(input),
    _proposed: {
      _entities: Array.isArray(proposed._entities)
        ? clone_json(proposed._entities)
        : [],
      _views: Array.isArray(proposed._views)
        ? clone_json(proposed._views)
        : [],
      _flows: Array.isArray(proposed._flows)
        ? clone_json(proposed._flows)
        : [],
      _server_modules: Array.isArray(proposed._server_modules)
        ? clone_json(proposed._server_modules)
        : [],
    },
    _milestones: milestones,
    _current_focus: first_focus,
  };
}

function guide_recommendation_cache_key(input: {
  _app_id: string;
  _env: string;
  _project_memory: unknown;
}): string | undefined {
  if (!_xu.is_plain_object(input._project_memory)) return undefined;

  const current_focus =
    typeof input._project_memory._current_focus === "string"
      ? input._project_memory._current_focus.trim()
      : "";
  const updated_at =
    typeof input._project_memory._updated_at === "string"
      ? input._project_memory._updated_at.trim()
      : "";

  if (!current_focus || !updated_at) return undefined;

  return [
    input._app_id,
    input._env,
    current_focus,
    updated_at,
  ].join("\u0000");
}

function project_memory_has_achievement(
  memory: unknown,
  achievement_id: string,
): boolean {
  if (!_xu.is_plain_object(memory) || !Array.isArray(memory._achievements)) {
    return false;
  }

  return memory._achievements.some((achievement) =>
    _xu.is_plain_object(achievement) &&
    achievement._id === achievement_id
  );
}

function generation_artifact_stage_fields(result: unknown): XVibeJsonObject {
  if (!_xu.is_plain_object(result) || !_xu.is_plain_object(result._result)) {
    return {};
  }

  const artifact = result._result;
  return {
    ...(typeof artifact._artifact_type === "string" && artifact._artifact_type.trim()
      ? { _artifact_type: artifact._artifact_type.trim() }
      : {}),
    ...(typeof artifact._artifact_id === "string" && artifact._artifact_id.trim()
      ? { _artifact_id: artifact._artifact_id.trim() }
      : {}),
  };
}

function extract_persisted_version(value: unknown): number | string | undefined {
  if (!_xu.is_plain_object(value)) return undefined;

  if (
    typeof value._version === "number" ||
    typeof value._version === "string"
  ) {
    return value._version;
  }

  if (_xu.is_plain_object(value._result)) {
    return extract_persisted_version(value._result);
  }

  return undefined;
}

function prompt_requests_module_only(prompt: string): boolean {
  const normalized_prompt =
    _xu.normalizePrompt(prompt).toLowerCase();

  return (
    /\bserver\s+module\s+only\b/u.test(normalized_prompt) ||
    /\bmodule\s+only\b/u.test(normalized_prompt) ||
    /\bdo\s+not\s+wire\s+(?:the\s+)?ui\b/u.test(normalized_prompt) ||
    /\bonly\s+(?:create|load|create\/load|create\s+and\s+load|create\s+or\s+load)\s+(?:the\s+)?(?:server\s+)?module\b/u
      .test(normalized_prompt)
  );
}

function normalize_full_view_id(
  view: XVibeJsonObject,
  requested_view_id?: string,
): string {
  const parsed_view_id = read_optional_string(view._id, "_view._id");
  const view_id = requested_view_id ?? parsed_view_id ?? DEFAULT_VIEW_ID;

  view._id = view_id;
  return view_id;
}

function ensure_valid_xui_root(view: XVibeJsonObject): asserts view is XVibeViewArtifact {
  if (typeof view._type !== "string" || view._type.trim().length === 0) {
    throw new Error("Invalid AI output: '_view._type' must be a non-empty string");
  }
}

function ensure_artifact_id(artifact: XVibeJsonObject, field_name: string): string {
  return read_required_string(artifact._id, field_name);
}

function read_child_id(value: unknown): string | undefined {
  return _xu.is_plain_object(value) && typeof value._id === "string" && value._id.trim().length > 0
    ? value._id.trim()
    : undefined;
}

function merge_child_object(existing_child: unknown, next_child: unknown): unknown {
  if (!_xu.is_plain_object(existing_child) || !_xu.is_plain_object(next_child)) {
    return next_child;
  }

  const merged = {
    ...existing_child,
    ...next_child,
  };

  if (Array.isArray(next_child._children)) {
    merged._children = merge_children_by_id(existing_child._children, next_child._children);
  }

  return merged;
}

function merge_children_by_id(existing_children: unknown, next_children: unknown): unknown {
  assert_no_duplicate_child_ids(existing_children, "existing_children");
  assert_no_duplicate_child_ids(next_children, "next_children");
  if (!Array.isArray(next_children) || next_children.length === 0) {
    return existing_children;
  }

  if (!Array.isArray(existing_children) || existing_children.length === 0) {
    return next_children;
  }

  const merged = [...existing_children];
  const existing_index_by_id = new Map<string, number>();

  existing_children.forEach((child, index) => {
    const child_id = read_child_id(child);
    if (child_id) existing_index_by_id.set(child_id, index);
  });

  for (const next_child of next_children) {
    const next_child_id = read_child_id(next_child);

    if (next_child_id && existing_index_by_id.has(next_child_id)) {
      const index = existing_index_by_id.get(next_child_id);
      if (index !== undefined) {
        merged[index] = merge_child_object(merged[index], next_child);
      }
      continue;
    }

    merged.push(next_child);
  }

  return merged;
}

export function merge_refined_view(
  current_view: XVibeJsonObject,
  next_view: XVibeJsonObject,
): XVibeJsonObject {
  const merged: XVibeJsonObject = {
    ...current_view,
  };

  for (const [key, value] of Object.entries(next_view)) {
    if (value !== undefined && key !== "_children") {
      merged[key] = value;
    }
  }

  merged._id = next_view._id ?? current_view._id;
  merged._type = next_view._type ?? current_view._type;

  merged._children = merge_children_by_id(current_view._children, next_view._children);

  return merged;
}

function server_xvm_has_op(op: "get_flow" | "set_flow" | "set_entity"): boolean {
  const get_module = (_x as unknown as { getModule?: (name: string) => unknown }).getModule;
  if (typeof get_module !== "function") {
    return true;
  }

  const module = get_module.call(_x, "server-xvm");
  if (!module || typeof module !== "object") {
    return false;
  }

  const method_name = `_${op}`;
  return typeof (module as XVibeJsonObject)[method_name] === "function";
}

function explicit_error(code: string, message: string, details?: XVibeJsonObject) {
  return {
    _ok: false,
    _error: {
      _code: code,
      _message: message,
      ...(details ? { _details: details } : {}),
    },
  };
}

function throw_explicit_error(code: string, message: string, details?: XVibeJsonObject): never {
  throw new XVibeStructuredError(explicit_error(code, message, details));
}

function flow_success_command_equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function append_flow_success_command_value(input: {
  _existing: unknown;
  _command: XVibeJsonObject;
}): {
  _value: unknown;
  _changed: boolean;
} {
  const command = clone_json(input._command);

  if (input._existing === undefined) {
    return {
      _value: command,
      _changed: true,
    };
  }

  if (flow_success_command_equal(input._existing, command)) {
    return {
      _value: clone_json(input._existing),
      _changed: false,
    };
  }

  const existing_list =
    Array.isArray(input._existing)
      ? clone_json(input._existing)
      : [clone_json(input._existing)];
  if (existing_list.some((item) => flow_success_command_equal(item, command))) {
    return {
      _value: clone_json(input._existing),
      _changed: false,
    };
  }

  return {
    _value: [...existing_list, command],
    _changed: true,
  };
}

function read_safe_path_segment(
  value: unknown,
  field_name: string,
  code: string,
): string {
  if (typeof value !== "string") {
    throw_explicit_error(code, `Invalid '${field_name}': expected safe path segment`);
  }

  const segment = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(segment)) {
    throw_explicit_error(code, `Invalid '${field_name}': expected safe path segment`);
  }

  return segment;
}

function normalize_safe_app_id(value: unknown): string {
  if (typeof value !== "string") {
    throw_explicit_error(XVIBE_INVALID_APP_ID, "Invalid '_app_id': expected safe app id");
  }

  const raw = value.trim();
  if (
    raw.length === 0 ||
    raw.includes("/") ||
    raw.includes("\\") ||
    raw.includes("..")
  ) {
    throw_explicit_error(XVIBE_INVALID_APP_ID, "Invalid '_app_id': expected safe app id");
  }

  const normalized =
    raw
      .normalize("NFKC")
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-_]+|[-_]+$/g, "");

  if (!/^[a-z0-9][a-z0-9_-]*$/u.test(normalized)) {
    throw_explicit_error(XVIBE_INVALID_APP_ID, "Invalid '_app_id': expected safe app id");
  }

  return normalized;
}

function optional_trimmed_string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function assert_path_inside(root: string, candidate: string, code: string, message: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw_explicit_error(code, message);
  }
}

function resolve_target_app_dir(env: string, app_id: string): string {
  return RuntimeContextManager.resolveTargetAppDir(env, app_id);
}

const STARTER_PUBLIC_FOLDERS = new Set(["style", "assets"]);

function resolve_target_public_app_dir(app_id: string): string {
  const public_root =
    path.resolve(RuntimeContextManager.resolveXvibeWorkFolder(), "public");
  const public_app_dir = path.resolve(public_root, app_id);
  assert_path_inside(
    public_root,
    public_app_dir,
    XVIBE_INVALID_APP_ID,
    "Invalid target public app path",
  );

  return public_app_dir;
}

function copy_starter_runtime_files(starter_dir: string, target_dir: string): void {
  fs.mkdirSync(target_dir, { recursive: true });

  for (const entry of fs.readdirSync(starter_dir, { withFileTypes: true })) {
    if (STARTER_PUBLIC_FOLDERS.has(entry.name)) {
      continue;
    }

    const src_path = path.join(starter_dir, entry.name);
    const target_path = path.join(target_dir, entry.name);

    if (entry.isDirectory()) {
      try {
        _xu.copyDirRecursive(src_path, target_path);
      } catch (error) {
        throw_explicit_error(XVIBE_STARTER_COPY_FAILED, "Failed to copy starter runtime folder", {
          _path: src_path,
          _target_path: target_path,
          _error: error instanceof Error ? error.message : String(error),
        });
      }
    } else if (entry.isFile()) {
      try {
        fs.copyFileSync(src_path, target_path);
      } catch (error) {
        throw_explicit_error(XVIBE_STARTER_COPY_FAILED, "Failed to copy starter runtime file", {
          _path: src_path,
          _target_path: target_path,
          _error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

function copy_starter_public_files(
  starter_dir: string,
  public_app_dir: string,
  app_id: string,
): void {
  fs.mkdirSync(public_app_dir, { recursive: true });

  for (const folder of STARTER_PUBLIC_FOLDERS) {
    const src_path = path.join(starter_dir, folder);
    if (!fs.existsSync(src_path)) {
      continue;
    }

    if (!fs.statSync(src_path).isDirectory()) {
      throw_explicit_error(XVIBE_STARTER_COPY_FAILED, "Starter public path is not a directory", {
        _app_id: app_id,
        _path: src_path,
      });
    }

    const target_path = path.join(public_app_dir, folder);
    try {
      _xu.copyDirRecursive(src_path, target_path);
    } catch (error) {
      throw_explicit_error(XVIBE_STARTER_COPY_FAILED, "Failed to copy starter public folder", {
        _app_id: app_id,
        _path: src_path,
        _target_path: target_path,
        _error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function rewrite_starter_public_reference(value: string, app_id: string): string {
  for (const folder of STARTER_PUBLIC_FOLDERS) {
    if (value.startsWith(`${folder}/`)) {
      return `/public/${app_id}/${value}`;
    }
  }

  return value;
}

function rewrite_starter_public_references(value: unknown, app_id: string): unknown {
  if (typeof value === "string") {
    return rewrite_starter_public_reference(value, app_id);
  }

  if (Array.isArray(value)) {
    return value.map((item) => rewrite_starter_public_references(item, app_id));
  }

  if (_xu.is_plain_object(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = rewrite_starter_public_references(item, app_id);
    }

    return out;
  }

  return value;
}

function rewrite_json_files_in_dir(dir: string, app_id: string): void {
  if (!fs.existsSync(dir)) {
    return;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file_path = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      rewrite_json_files_in_dir(file_path, app_id);
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".json")) {
      continue;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(file_path, "utf-8"));
      const rewritten = rewrite_starter_public_references(parsed, app_id);
      fs.writeFileSync(file_path, `${JSON.stringify(rewritten, null, 2)}\n`, "utf-8");
    } catch (error) {
      throw_explicit_error(XVIBE_STARTER_COPY_FAILED, "Failed to rewrite starter JSON public references", {
        _app_id: app_id,
        _path: file_path,
        _error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function read_json_object_file(file_path: string, code: string, message: string): XVibeJsonObject {
  try {
    const parsed = JSON.parse(fs.readFileSync(file_path, "utf-8"));
    if (!_xu.is_plain_object(parsed)) {
      throw new Error("Expected JSON object");
    }

    return parsed;
  } catch (error) {
    throw_explicit_error(code, message, {
      _path: file_path,
      _error: error instanceof Error ? error.message : String(error),
    });
  }
}

function write_json_object_file(file_path: string, value: XVibeJsonObject): void {
  fs.writeFileSync(file_path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function parser_diagnostic(error: unknown): XVibeParserDiagnostic | undefined {
  return error instanceof VibeOutputParserError ? error._diagnostic : undefined;
}

function parser_diagnostics(error: unknown): XVibeParserDiagnostic[] | undefined {
  return error instanceof VibeOutputParserError ? error._diagnostics : undefined;
}

function assert_no_duplicate_child_ids(children: unknown, context: string): void {
  if (!Array.isArray(children)) return;

  const seen = new Set<string>();

  for (const child of children) {
    const child_id = read_child_id(child);

    if (child_id) {
      if (seen.has(child_id)) {
        throw new Error(`E_VIBE_DUPLICATE_CHILD_ID: duplicate child _id '${child_id}' in ${context}`);
      }
      seen.add(child_id);
    }

    if (_xu.is_plain_object(child)) {
      assert_no_duplicate_child_ids(child._children, `${context}.${child_id ?? "anonymous"}`);
    }
  }
}

function add_string(target: Set<string>, value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed.length > 0) target.add(trimmed);
}

function read_string_array_value(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function unique_runtime_items(items: unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];

  for (const item of items) {
    const key =
      _xu.is_plain_object(item)
        ? String(item._id ?? item._name ?? JSON.stringify(item))
        : JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}

function merge_runtime_skill_payloads(
  existing_runtime_skills: unknown,
  engine_runtime_skills: unknown,
): XVibeJsonObject {
  const existing_payload = unwrap_runtime_skills_payload(existing_runtime_skills);
  const engine_payload = unwrap_runtime_skills_payload(engine_runtime_skills);
  const existing = _xu.is_plain_object(existing_payload) ? existing_payload : {};
  const engine = _xu.is_plain_object(engine_payload) ? engine_payload : {};

  return {
    ...existing,
    ...engine,
    _skills: unique_runtime_items([
      ...(Array.isArray(existing._skills) ? existing._skills : []),
      ...(Array.isArray(engine._skills) ? engine._skills : []),
    ]),
    _objects: unique_runtime_items([
      ...(Array.isArray(existing._objects) ? existing._objects : []),
      ...(Array.isArray(engine._objects) ? engine._objects : []),
    ]),
    _modules: unique_runtime_items([
      ...(Array.isArray(existing._modules) ? existing._modules : []),
      ...(Array.isArray(engine._modules) ? engine._modules : []),
    ]),
  };
}

function unwrap_runtime_skills_payload(runtime_skills: unknown): unknown {
  if (
    _xu.is_plain_object(runtime_skills) &&
    _xu.is_plain_object(runtime_skills._skills)
  ) {
    return runtime_skills._skills;
  }

  return runtime_skills;
}

function collect_xui_types_from_skill(
  target: Set<string>,
  skill: unknown,
  include_identity: boolean,
): void {
  if (!_xu.is_plain_object(skill)) return;

  if (include_identity) {
    add_string(target, skill._id);
    add_string(target, skill._xtype);
    add_string(target, skill._xui_type);
    add_string(target, skill._object_type);
  }

  for (const value of read_string_array_value(skill._xui_objects)) {
    target.add(value);
  }

  if (_xu.is_plain_object(skill._exports)) {
    for (const value of read_string_array_value(skill._exports._xui_objects)) {
      target.add(value);
    }
  }
}

function read_runtime_ops(value: unknown): string[] {
  const ops =
    Array.isArray(value)
      ? value
      : _xu.is_plain_object(value)
        ? Object.values(value)
        : [];

  return ops
    .map((op) => {
      if (typeof op === "string") return op.trim();
      if (!_xu.is_plain_object(op)) return "";
      if (typeof op._name === "string") return op._name.trim();
      if (typeof op._op === "string") return op._op.trim();
      return "";
    })
    .filter((op) => op.length > 0);
}

function add_runtime_registry_module_op(
  registry: XVibeRuntimeRegistry,
  module_name: unknown,
  op_name: unknown,
): void {
  if (typeof module_name !== "string" || typeof op_name !== "string") return;
  const module_id = module_name.trim();
  const op = op_name.trim();
  if (!module_id || !op) return;

  add_string(registry._modules, module_id);
  const key = module_id.toLowerCase();
  const ops = registry._ops.get(key) ?? new Set<string>();
  ops.add(op);
  registry._ops.set(key, ops);
}

function collect_runtime_module_ops_from_item(
  registry: XVibeRuntimeRegistry,
  module_item: unknown,
): void {
  if (!_xu.is_plain_object(module_item)) return;

  const module_name =
    typeof module_item._name === "string" && module_item._name.trim()
      ? module_item._name.trim()
      : typeof module_item._id === "string"
        ? module_item._id.trim()
        : "";
  if (!module_name) return;

  for (const op of read_runtime_ops(module_item._ops)) {
    add_runtime_registry_module_op(registry, module_name, op);
  }
}

function collect_runtime_module_ops_from_skill(
  registry: XVibeRuntimeRegistry,
  skill: unknown,
): void {
  if (!_xu.is_plain_object(skill)) return;

  const module_name =
    typeof skill._name === "string" && skill._name.trim()
      ? skill._name.trim()
      : typeof skill._module === "string" && skill._module.trim()
        ? skill._module.trim()
        : (
          skill._type === "server-module-api" ||
          skill._type === "client-module-api" ||
          skill._type === "runtime-api-skill"
        ) && typeof skill._id === "string"
          ? skill._id.trim()
          : "";

  if (module_name) {
    for (const op of read_runtime_ops(skill._ops)) {
      add_runtime_registry_module_op(registry, module_name, op);
    }
  }

  if (_xu.is_plain_object(skill._exports) && Array.isArray(skill._exports._modules)) {
    for (const module_item of skill._exports._modules) {
      collect_runtime_module_ops_from_item(registry, module_item);
    }
  }
}

function skill_marks_generated_module(skill: unknown): boolean {
  if (!_xu.is_plain_object(skill)) return false;

  const core_rules =
    read_string_array_value(skill._core_rules)
      .map((rule) => rule.toLowerCase());

  return core_rules.some((rule) =>
    rule.includes("generated module artifact derived from manifest.json")
  );
}

function add_generated_module_target(
  target: Map<string, XVibeGeneratedModuleOpTarget[]>,
  module_name: unknown,
  op_name: unknown,
): void {
  if (typeof module_name !== "string" || typeof op_name !== "string") return;
  const module_id = module_name.trim();
  const op = op_name.trim();
  if (!module_id || !op) return;

  const existing = target.get(op) ?? [];
  if (!existing.some((item) => item._module === module_id && item._op === op)) {
    target.set(op, [
      ...existing,
      {
        _module: module_id,
        _op: op,
      },
    ]);
  }
}

function collect_generated_module_targets_from_skill(
  target: Map<string, XVibeGeneratedModuleOpTarget[]>,
  skill: unknown,
): void {
  if (!skill_marks_generated_module(skill) || !_xu.is_plain_object(skill)) return;
  const exports_obj = _xu.is_plain_object(skill._exports) ? skill._exports : {};

  if (Array.isArray(exports_obj._modules)) {
    for (const module_item of exports_obj._modules) {
      if (!_xu.is_plain_object(module_item)) continue;
      const module_name =
        typeof module_item._name === "string"
          ? module_item._name
          : module_item._id;

      for (const op of read_runtime_ops(module_item._ops)) {
        add_generated_module_target(target, module_name, op);
      }
    }
  }
}

function collect_generated_module_op_targets(
  runtime_skills: unknown,
): Map<string, XVibeGeneratedModuleOpTarget[]> {
  const payload = unwrap_runtime_skills_payload(runtime_skills);
  const target = new Map<string, XVibeGeneratedModuleOpTarget[]>();

  if (!_xu.is_plain_object(payload)) {
    return target;
  }

  if (Array.isArray(payload._skills)) {
    for (const skill of payload._skills) {
      collect_generated_module_targets_from_skill(target, skill);
    }
  }

  if (Array.isArray(payload._modules)) {
    for (const module_item of payload._modules) {
      if (!_xu.is_plain_object(module_item)) continue;

      let module_is_generated = skill_marks_generated_module(module_item);

      if (Array.isArray(module_item._skills)) {
        for (const skill of module_item._skills) {
          if (skill_marks_generated_module(skill)) {
            module_is_generated = true;
          }
          collect_generated_module_targets_from_skill(target, skill);
        }
      }

      if (module_is_generated) {
        const module_name =
          typeof module_item._name === "string"
            ? module_item._name
            : module_item._id;
        for (const op of read_runtime_ops(module_item._ops)) {
          add_generated_module_target(target, module_name, op);
        }
      }
    }
  }

  return target;
}

function resolve_generated_module_op_target(
  command_module: string,
  command_op: string,
  generated_module_ops: Map<string, XVibeGeneratedModuleOpTarget[]>,
): XVibeGeneratedModuleOpTarget | undefined {
  const normalized_op =
    command_op.startsWith("_")
      ? command_op.slice(1)
      : command_op;
  if (!normalized_op) return undefined;

  const targets = generated_module_ops.get(normalized_op) ?? [];
  if (targets.length === 0) return undefined;

  const current_module_match =
    targets.find((target) => target._module === command_module);
  if (current_module_match) return current_module_match;

  return targets.length === 1
    ? targets[0]
    : undefined;
}

function normalize_known_generated_module_commands(
  value: unknown,
  runtime_skills: unknown,
): number {
  const generated_module_ops =
    collect_generated_module_op_targets(runtime_skills);

  if (generated_module_ops.size === 0) {
    return 0;
  }

  return normalize_known_generated_module_commands_internal(
    value,
    generated_module_ops,
  );
}

function normalize_known_generated_module_commands_internal(
  value: unknown,
  generated_module_ops: Map<string, XVibeGeneratedModuleOpTarget[]>,
): number {
  if (Array.isArray(value)) {
    return value.reduce(
      (count, item) =>
        count + normalize_known_generated_module_commands_internal(item, generated_module_ops),
      0,
    );
  }

  if (!_xu.is_plain_object(value)) {
    return 0;
  }

  let normalized = 0;

  if (
    typeof value._module === "string" &&
    typeof value._op === "string"
  ) {
    const target =
      resolve_generated_module_op_target(
        value._module.trim(),
        value._op.trim(),
        generated_module_ops,
      );

    if (target) {
      if (value._module !== target._module) {
        value._module = target._module;
        normalized += 1;
      }

      if (value._op !== target._op) {
        value._op = target._op;
        normalized += 1;
      }
    }
  }

  for (const child of Object.values(value)) {
    normalized += normalize_known_generated_module_commands_internal(
      child,
      generated_module_ops,
    );
  }

  return normalized;
}

function collect_runtime_registry(runtime_skills: unknown): XVibeRuntimeRegistry {
  const payload = unwrap_runtime_skills_payload(runtime_skills);
  const registry: XVibeRuntimeRegistry = {
    _xui_types: new Set(),
    _modules: new Set(),
    _ops: new Map(),
  };

  if (!_xu.is_plain_object(payload)) {
    return registry;
  }

  if (Array.isArray(payload._skills)) {
    for (const skill of payload._skills) {
      collect_xui_types_from_skill(registry._xui_types, skill, false);
      collect_runtime_module_ops_from_skill(registry, skill);
      if (_xu.is_plain_object(skill)) {
        add_string(registry._modules, skill._name);
        if (
          skill._type === "server-module-api" ||
          skill._type === "client-module-api" ||
          skill._type === "runtime-api-skill"
        ) {
          add_string(registry._modules, skill._id);
        }
      }
    }
  }

  if (Array.isArray(payload._modules)) {
    for (const module_item of payload._modules) {
      if (!_xu.is_plain_object(module_item)) continue;

      add_string(registry._modules, module_item._id);
      add_string(registry._modules, module_item._name);
      collect_runtime_module_ops_from_item(registry, module_item);

      if (Array.isArray(module_item._skills)) {
        for (const skill of module_item._skills) {
          collect_xui_types_from_skill(registry._xui_types, skill, false);
          collect_runtime_module_ops_from_skill(registry, skill);
        }
      }

      if (Array.isArray(module_item._objects)) {
        for (const object_skill of module_item._objects) {
          collect_xui_types_from_skill(registry._xui_types, object_skill, true);
        }
      }
    }
  }

  return registry;
}

function skill_xui_types(skill: unknown): string[] {
  if (!_xu.is_plain_object(skill)) return [];
  const exports_obj =
    _xu.is_plain_object(skill._exports)
      ? skill._exports
      : {};

  return unique_normalized_ids([
    ...read_string_array_value(skill._xui_objects),
    ...read_string_array_value(skill._xui_type),
    ...read_string_array_value(exports_obj._xui_objects),
    ...read_string_array_value(exports_obj._xui_type),
  ]);
}

function selection_with_supported_xui_skills(
  selection: VibeKnowledgeSelection,
  runtime_skills: unknown,
): VibeKnowledgeSelection {
  const registry =
    collect_runtime_registry(runtime_skills);

  if (registry._xui_types.size === 0) {
    return selection;
  }

  const skills =
    selection.skills.filter((skill) => {
      const xui_types =
        skill_xui_types(skill);
      if (xui_types.length === 0) return true;

      const unsupported =
        xui_types.filter((type) => !registry._xui_types.has(type));
      if (unsupported.length === 0) return true;

      _xlog.warn("[xvibe] dropping unsupported xui skill", {
        _skill_id: skill._id,
        _unsupported_xui_types: unsupported,
      });
      return false;
    });
  const skill_ids =
    skills.map((skill) => skill._id);
  const allowed_ids =
    new Set(skill_ids);

  return {
    skill_ids,
    skills,
    diagnostics:
      selection.diagnostics.filter((diagnostic) =>
        allowed_ids.has(diagnostic._id),
    ),
  };
}

function runtime_asset_ids(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(new Set(
    value
      .map((item) => {
        if (typeof item === "string") return item.trim();
        if (_xu.is_plain_object(item) && typeof item._id === "string") return item._id.trim();
        return "";
      })
      .filter((id) => id.length > 0),
  ));
}

function runtime_asset_refs_from_ids(ids: string[]): XVibeRuntimeAssetRef[] {
  return ids.map((_id) => ({ _id }));
}

function runtime_assets_from_plan(
  runtime_plan: XVibeRuntimePlan,
): XVibeRuntimeAssets {
  return {
    _views: runtime_asset_refs_from_ids(runtime_plan._existing_views),
    _flows: runtime_asset_refs_from_ids(runtime_plan._existing_flows),
    _entities: runtime_asset_refs_from_ids(runtime_plan._existing_entities),
    _modules: runtime_asset_refs_from_ids(runtime_plan._existing_modules),
  };
}

function runtime_allowed_ops_payload(
  registry: XVibeRuntimeRegistry,
): Record<string, string[]> {
  const payload: Record<string, string[]> = {};

  for (const [module_name, ops] of registry._ops.entries()) {
    payload[module_name] = Array.from(ops).sort();
  }

  return payload;
}

function runtime_registry_from_plan(
  runtime_plan: XVibeRuntimePlan | undefined,
): XVibeRuntimeRegistry | undefined {
  if (!runtime_plan) return undefined;

  const registry: XVibeRuntimeRegistry = {
    _xui_types: new Set(runtime_plan._allowed_xui_types),
    _modules: new Set(runtime_plan._allowed_modules),
    _ops: new Map(),
  };

  for (const [module_name, ops] of Object.entries(runtime_plan._allowed_ops)) {
    const module_id = module_name.trim();
    if (!module_id) continue;
    registry._modules.add(module_id);
    registry._ops.set(
      module_id.toLowerCase(),
      new Set(ops.map((op) => op.trim()).filter((op) => op.length > 0)),
    );
  }

  return registry;
}

export function build_xvibe_runtime_plan(input: {
  _runtime_assets: XVibeRuntimeAssets;
  _runtime_skills: unknown;
  _resolved_task: XVibeResolvedTask;
  _intent_plan?: VibeIntentPlan;
}): XVibeRuntimePlan {
  const registry = collect_runtime_registry(input._runtime_skills);
  const constraints: string[] = [
    "runtime_constraints_only",
  ];
  const warnings: string[] = [];

  if (registry._xui_types.size === 0) {
    warnings.push("missing_runtime_xui_registry");
  }

  return {
    _existing_views: runtime_asset_ids(input._runtime_assets._views),
    _existing_flows: runtime_asset_ids(input._runtime_assets._flows),
    _existing_entities: runtime_asset_ids(input._runtime_assets._entities),
    _existing_modules: runtime_asset_ids(input._runtime_assets._modules),
    _allowed_xui_types: Array.from(registry._xui_types).sort(),
    _allowed_modules: Array.from(registry._modules).sort(),
    _allowed_ops: runtime_allowed_ops_payload(registry),
    _constraints: constraints,
    _warnings: warnings,
  };
}

function validation_normalize_id(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function validation_add_target_id(
  ids: Set<string>,
  value: unknown,
): void {
  const id = validation_normalize_id(value);
  if (id) ids.add(id);
}

function validation_collect_plan_artifact_types(
  value: unknown,
  types = new Set<string>(),
): Set<string> {
  if (!_xu.is_plain_object(value)) return types;

  validation_add_target_id(types, value._primary_artifact_type);
  validation_add_target_id(types, value._artifact_type);

  if (Array.isArray(value._artifact_types)) {
    for (const item of value._artifact_types) {
      validation_add_target_id(types, item);
    }
  }

  if (Array.isArray(value._artifacts)) {
    for (const item of value._artifacts) {
      validation_collect_plan_artifact_types(item, types);
    }
  }

  if (_xu.is_plain_object(value._execution_plan)) {
    validation_collect_plan_artifact_types(value._execution_plan, types);
  }

  return types;
}

function validation_collect_plan_target_ids(
  value: unknown,
  ids = new Set<string>(),
): Set<string> {
  if (!_xu.is_plain_object(value)) return ids;

  validation_add_target_id(ids, value._target_id);
  validation_add_target_id(ids, value._artifact_id);
  validation_add_target_id(ids, value._view_id);
  validation_add_target_id(ids, value._flow_id);
  validation_add_target_id(ids, value._entity_id);

  for (const key of ["_flow_ids", "_entity_ids", "_module_names"] as const) {
    const items = value[key];
    if (Array.isArray(items)) {
      for (const item of items) {
        validation_add_target_id(ids, item);
      }
    }
  }

  if (Array.isArray(value._artifacts)) {
    for (const item of value._artifacts) {
      validation_collect_plan_target_ids(item, ids);
    }
  }

  if (_xu.is_plain_object(value._execution_plan)) {
    validation_collect_plan_target_ids(value._execution_plan, ids);
  }

  return ids;
}

function validation_has_non_empty_string(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function validate_xvibe_generation_plan(input: {
  resolved_task: XVibeResolvedTask;
  artifact_plan?: unknown;
  intent_plan?: VibeIntentPlan;
  runtime_plan?: XVibeRuntimePlan;
}): XVibeValidationPlan {
  const errors: string[] = [];
  const warnings: string[] = [];
  const artifact_types =
    validation_collect_plan_artifact_types(input.artifact_plan);
  const target_ids =
    validation_collect_plan_target_ids(input.artifact_plan);

  validation_add_target_id(target_ids, input.resolved_task._target_id);

  for (const target_id of target_ids) {
    if (XVIBE_VALIDATION_REJECTED_TARGET_IDS.has(target_id)) {
      errors.push(`invalid_target_id:${target_id}`);
    }
  }

  if (input.resolved_task._artifact_type === "module") {
    if (!validation_has_non_empty_string(input.resolved_task._module_name)) {
      errors.push("module_name_required");
    }
    if (input.resolved_task._module_ops.length === 0) {
      errors.push("module_ops_required");
    }

    for (const type of ["entity", "view", "flow"]) {
      if (
        artifact_types.has(type) ||
        input.intent_plan?._artifact_types.includes(type)
      ) {
        errors.push(`module_route_forbidden_artifact:${type}`);
      }
    }

    if (input.intent_plan) {
      const module_name =
        typeof input.resolved_task._module_name === "string"
          ? input.resolved_task._module_name.trim()
          : "";
      const module_key = module_name.toLowerCase();
      const unexpected_modules =
        input.intent_plan._modules.filter((name) =>
          name.trim().toLowerCase() !== module_key,
        );

      if (input.intent_plan._entities.length > 0) {
        errors.push("module_route_entity_leakage");
      }
      if (input.intent_plan._actions.length > 0) {
        errors.push("module_route_action_leakage");
      }
      if (input.intent_plan._crud_ops.length > 0) {
        errors.push("module_route_crud_leakage");
      }
      if (input.intent_plan._xui_objects.length > 0) {
        errors.push("module_route_xui_leakage");
      }
      if (unexpected_modules.length > 0) {
        errors.push(`module_route_unexpected_modules:${unexpected_modules.join(",")}`);
      }
    }
  }

  if (input.resolved_task._artifact_type === "view") {
    const primary_artifact_type =
      _xu.is_plain_object(input.artifact_plan) &&
        typeof input.artifact_plan._primary_artifact_type === "string"
        ? input.artifact_plan._primary_artifact_type
        : undefined;

    if (primary_artifact_type && primary_artifact_type !== "view") {
      errors.push(`view_route_primary_artifact:${primary_artifact_type}`);
    }

    if (
      artifact_types.has("entity") ||
      (input.intent_plan?._artifact_types.includes("entity") ?? false) ||
      (input.intent_plan?._entities.length ?? 0) > 0 ||
      (input.intent_plan?._entity_keywords.length ?? 0) > 0
    ) {
      errors.push("view_route_entity_leakage");
    }

    if (
      artifact_types.has("module") ||
      (input.intent_plan?._artifact_types.includes("module") ?? false) ||
      (input.intent_plan?._modules.length ?? 0) > 0 ||
      input.intent_plan?._requires_module === true ||
      validation_has_non_empty_string(input.intent_plan?._module_name)
    ) {
      errors.push("view_route_module_leakage");
    }
  }

  if (
    input.runtime_plan &&
    input.runtime_plan._allowed_xui_types.length > 0 &&
    input.intent_plan
  ) {
    const allowed =
      new Set(input.runtime_plan._allowed_xui_types.map((type) => type.trim().toLowerCase()));
    const referenced =
      unique_normalized_ids([
        ...input.intent_plan._xui_objects,
        ...input.intent_plan._objects,
      ]);
    for (const type of referenced) {
      if (!allowed.has(type)) {
        errors.push(`unsupported_xui_type:${type}`);
      }
    }
  }

  return {
    _ok: errors.length === 0,
    _errors: Array.from(new Set(errors)),
    _warnings: Array.from(new Set(warnings)),
  };
}

function defer_view_child_edit_validation_leakage(input: {
  validation_plan: XVibeValidationPlan;
  resolved_task: XVibeResolvedTask;
  deterministic_attempted: boolean;
}): XVibeValidationPlan {
  if (
    input.validation_plan._ok ||
    !input.deterministic_attempted ||
    !resolved_task_is_explicit_view_child_edit(input.resolved_task)
  ) {
    return input.validation_plan;
  }

  const deferrable_errors = new Set(["view_route_entity_leakage"]);
  const non_deferrable_errors =
    input.validation_plan._errors.filter((error) => !deferrable_errors.has(error));
  if (non_deferrable_errors.length > 0) {
    return input.validation_plan;
  }

  return {
    _ok: true,
    _errors: [],
    _warnings: Array.from(new Set([
      ...input.validation_plan._warnings,
      ...input.validation_plan._errors.map((error) => `deferred:${error}`),
    ])),
  };
}

function supported_intent_xui_objects(
  value: unknown,
  runtime_skills: unknown,
): string[] {
  const requested =
    unique_normalized_ids(read_string_array_value(value));
  if (requested.length === 0) {
    return [];
  }

  const registry =
    collect_runtime_registry(runtime_skills);
  if (registry._xui_types.size === 0) {
    return requested;
  }

  return requested.filter((type) => registry._xui_types.has(type));
}

function normalize_edit_lookup(value: unknown): string {
  return typeof value === "string"
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, "").trim()
    : "";
}

function normalized_edit_text(value: unknown): string {
  return typeof value === "string"
    ? _xu.normalizePrompt(value).toLowerCase()
    : "";
}

function prompt_edit_target_types(prompt: string): string[] {
  const text = normalized_edit_text(prompt);
  const types: string[] = [];
  const candidates = [
    "button",
    "label",
    "input",
    "field",
    "form",
    "card",
    "table",
    "row",
    "column",
    "toolbar",
    "sidebar",
    "modal",
    "drawer",
    "section",
    "text",
    "title",
    "image",
    "icon",
    "link",
  ];

  for (const candidate of candidates) {
    const pattern = new RegExp(`\\b${candidate}s?\\b`, "u");
    if (pattern.test(text)) {
      types.push(candidate === "field" ? "input" : candidate);
    }
  }

  return Array.from(new Set(types));
}

function parse_prompt_text_replacement(prompt: string): {
  _target_text?: string;
  _replacement_text?: string;
} {
  const match =
    prompt.match(/\b(?:change|replace|update)\s+["']([^"']+)["']\s+(?:to|with)\s+["']([^"']+)["']/iu);

  return {
    ...(match?.[1]?.trim() ? { _target_text: match[1].trim() } : {}),
    ...(match?.[2]?.trim() ? { _replacement_text: match[2].trim() } : {}),
  };
}

function collect_view_nodes(node: unknown, out: XVibeJsonObject[] = []): XVibeJsonObject[] {
  if (Array.isArray(node)) {
    for (const item of node) {
      collect_view_nodes(item, out);
    }
    return out;
  }

  if (!_xu.is_plain_object(node)) {
    return out;
  }

  out.push(node);
  if (Array.isArray(node._children)) {
    collect_view_nodes(node._children, out);
  }

  return out;
}

function collect_xvm_view_reference_ids(current_view: unknown): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) {
        visit(item);
      }
      return;
    }

    if (!_xu.is_plain_object(node)) {
      return;
    }

    if (node._type === "xvm-view") {
      const view_id = normalize_safe_view_id(node._view_id);
      if (view_id && !seen.has(view_id)) {
        seen.add(view_id);
        ids.push(view_id);
      }
    }

    if (Array.isArray(node._children)) {
      visit(node._children);
    }
  };

  visit(current_view);
  return ids;
}

function find_view_node_by_id(current_view: unknown, target_id: string | undefined): XVibeJsonObject | undefined {
  if (!target_id) return undefined;
  return collect_view_nodes(current_view)
    .find((node) => node._id === target_id);
}

type XVibeViewTargetResolutionStrategy =
  | "id"
  | "root"
  | "text"
  | "normalized_id"
  | "normalized_text"
  | "text_type_id";

type XVibeViewTargetLocation = {
  object: XVibeJsonObject;
  parent?: XVibeJsonObject;
  index?: number;
  path: string[];
};

type XVibeViewTargetResolution =
  | (XVibeViewTargetLocation & {
    _ok: true;
    resolution_strategy: XVibeViewTargetResolutionStrategy;
    _resolved_target_id?: string;
    _resolved_target_path: string[];
  })
  | {
    _ok: false;
    _reason: string;
    _details?: unknown;
  };

function view_target_path_segment(node: XVibeJsonObject, index?: number): string {
  const id =
    typeof node._id === "string" && node._id.trim()
      ? node._id.trim()
      : "";
  if (id) return id;
  return typeof index === "number" ? String(index) : "$root";
}

function collect_view_target_locations(current_view: unknown): XVibeViewTargetLocation[] {
  if (!_xu.is_plain_object(current_view)) return [];

  const locations: XVibeViewTargetLocation[] = [];
  const visit = (
    node: XVibeJsonObject,
    path: string[],
    parent?: XVibeJsonObject,
    index?: number,
  ) => {
    locations.push({
      object: node,
      ...(parent ? { parent } : {}),
      ...(typeof index === "number" ? { index } : {}),
      path,
    });

    if (!Array.isArray(node._children)) return;
    for (let child_index = 0; child_index < node._children.length; child_index += 1) {
      const child = node._children[child_index];
      if (!_xu.is_plain_object(child)) continue;
      visit(
        child,
        [...path, view_target_path_segment(child, child_index)],
        node,
        child_index,
      );
    }
  };

  visit(
    current_view,
    [view_target_path_segment(current_view)],
  );

  return locations;
}

function resolve_add_child_target_id(input: {
  _current_view: unknown;
  _view_id?: string;
  _target_id?: string;
}): string | undefined {
  const target_id =
    typeof input._target_id === "string" ? input._target_id.trim() : "";
  if (!target_id) return undefined;

  if (
    _xu.is_plain_object(input._current_view) &&
    Array.isArray(input._current_view._children)
  ) {
    const root_id =
      typeof input._current_view._id === "string"
        ? input._current_view._id.trim()
        : "";
    const view_id =
      typeof input._view_id === "string" ? input._view_id.trim() : "";

    if (
      target_id === root_id ||
      (view_id && target_id === view_id) ||
      target_id === "main"
    ) {
      return root_id || view_id || target_id;
    }
  }

  return target_id;
}

const XVIBE_VIEW_TARGET_TEXT_IGNORED_WORDS = new Set([
  "button",
  "buttons",
  "label",
  "labels",
  "object",
  "objects",
]);

function view_node_visible_target_values(
  node: XVibeJsonObject,
  options?: { _include_id?: boolean },
): string[] {
  const values = [
    ...(options?._include_id === true ? [node._id] : []),
    node._text,
    node.text,
    node.label,
    node.title,
    node._label,
    node._title,
  ];

  return values
    .filter((value): value is string =>
      typeof value === "string" && value.trim().length > 0
    );
}

function normalized_visible_target_text(value: unknown): string {
  if (typeof value !== "string") return "";

  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .trim()
    .split(/\s+/gu)
    .filter((part) => part.length > 0 && !XVIBE_VIEW_TARGET_TEXT_IGNORED_WORDS.has(part))
    .join(" ");
}

function normalized_view_target_type(value: unknown): string {
  return typeof value === "string"
    ? value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "")
    : "";
}

function view_target_type_aliases(value: unknown): Set<string> {
  const target_type =
    normalized_view_target_type(value);
  if (!target_type) return new Set();

  if (target_type === "button" || target_type === "xbutton") {
    return new Set(["button", "xbutton"]);
  }
  if (
    target_type === "label" ||
    target_type === "xlabel" ||
    target_type === "text" ||
    target_type === "textlabel" ||
    target_type === "title" ||
    target_type === "heading"
  ) {
    return new Set(["label", "xlabel", "text", "textlabel", "title", "heading"]);
  }

  return new Set([
    target_type,
    target_type.startsWith("x") ? target_type.slice(1) : `x${target_type}`,
  ].filter((item) => item.length > 0));
}

function view_node_matches_target_type(node: XVibeJsonObject, target_type: string | undefined): boolean {
  const aliases =
    view_target_type_aliases(target_type);
  if (aliases.size === 0) return true;

  const node_type =
    normalized_view_target_type(node._type);
  return Boolean(node_type) && aliases.has(node_type);
}

function deterministic_target_type_is_view(value: unknown): boolean {
  const target_type =
    normalized_view_target_type(value);
  return (
    target_type === "view" ||
    target_type === "xview" ||
    target_type === "rootview" ||
    target_type === "currentview"
  );
}

function deterministic_property_target_is_label_or_title(node: XVibeJsonObject): boolean {
  const node_type =
    normalized_view_target_type(node._type);
  return (
    node_type === "label" ||
    node_type === "xlabel" ||
    node_type === "text" ||
    node_type === "textlabel" ||
    node_type === "title" ||
    node_type === "heading" ||
    typeof node._text === "string"
  );
}

function deterministic_normalize_property_name_for_target(
  node: XVibeJsonObject,
  property_name: string,
): string {
  if (property_name === "title" && deterministic_property_target_is_label_or_title(node)) {
    return "_text";
  }

  return property_name;
}

function filter_view_target_nodes_by_type(
  nodes: XVibeJsonObject[],
  target_type: string | undefined,
): XVibeJsonObject[] {
  const aliases =
    view_target_type_aliases(target_type);
  if (aliases.size === 0) return nodes;

  return nodes.filter((node) => view_node_matches_target_type(node, target_type));
}

function filter_view_target_locations_by_type(
  locations: XVibeViewTargetLocation[],
  target_type: string | undefined,
): XVibeViewTargetLocation[] {
  const aliases =
    view_target_type_aliases(target_type);
  if (aliases.size === 0) return locations;

  return locations.filter((location) =>
    view_node_matches_target_type(location.object, target_type)
  );
}

function view_target_locations_for_details(
  locations: XVibeViewTargetLocation[],
): string[] {
  return view_target_ids_for_details(locations.map((location) => location.object));
}

function view_target_identity_resolution(
  location: XVibeViewTargetLocation,
  strategy: XVibeViewTargetResolutionStrategy,
): XVibeViewTargetResolution {
  const resolved_target_id =
    typeof location.object._id === "string" && location.object._id.trim()
      ? location.object._id.trim()
      : undefined;
  const resolved_target_path =
    location.path.length > 0 ? location.path : undefined;

  if (!resolved_target_id && !resolved_target_path) {
    return {
      _ok: false,
      _reason: "target_missing_identity",
      _details: {
        _path: location.path,
      },
    };
  }

  return {
    _ok: true,
    object: location.object,
    ...(location.parent ? { parent: location.parent } : {}),
    ...(typeof location.index === "number" ? { index: location.index } : {}),
    path: location.path,
    ...(resolved_target_id ? { _resolved_target_id: resolved_target_id } : {}),
    _resolved_target_path: resolved_target_path ?? location.path,
    resolution_strategy: strategy,
  };
}

function resolve_unique_view_target_location(input: {
  _locations: XVibeViewTargetLocation[];
  _strategy: XVibeViewTargetResolutionStrategy;
  _target_value: string;
  _target_type?: string;
  _ambiguous_reason: string;
  _not_found_reason: string;
  _details?: XVibeJsonObject;
}): XVibeViewTargetResolution {
  if (input._locations.length > 1) {
    return {
      _ok: false,
      _reason: input._ambiguous_reason,
      _details: {
        _target_text: input._target_value,
        ...(input._target_type ? { _target_type: input._target_type } : {}),
        _match_count: input._locations.length,
        _target_ids: view_target_locations_for_details(input._locations),
        ...(input._details ?? {}),
      },
    };
  }

  const location = input._locations[0];
  if (!location) {
    return {
      _ok: false,
      _reason: input._not_found_reason,
      _details: {
        _target_text: input._target_value,
        ...(input._target_type ? { _target_type: input._target_type } : {}),
        ...(input._details ?? {}),
      },
    };
  }

  return view_target_identity_resolution(location, input._strategy);
}

function deterministic_move_object_position(
  resolved_task: XVibeResolvedTask,
): XVibeMoveObjectPosition | undefined {
  const structured_position =
    (resolved_task as XVibeJsonObject)._edit_position;
  if (
    structured_position === "append" ||
    structured_position === "prepend" ||
    structured_position === "before" ||
    structured_position === "after"
  ) {
    return structured_position;
  }

  if (resolved_task._edit_move_position === "before") return "before";
  if (resolved_task._edit_move_position === "after") return "after";
  if (resolved_task._edit_move_position === "top") return "prepend";
  if (resolved_task._edit_move_position === "bottom") return "append";
  return undefined;
}

function deterministic_legacy_move_position(
  resolved_task: XVibeResolvedTask,
): "before" | "after" | "top" | "bottom" | undefined {
  return resolved_task._edit_move_position;
}

function deterministic_move_destination_fields(input: {
  _resolved_task: XVibeResolvedTask;
  _position: XVibeMoveObjectPosition;
}): {
  _target_id?: string;
  _target_text?: string;
  _target_type?: string;
  _legacy_anchor: boolean;
} {
  const task = input._resolved_task as XVibeJsonObject;
  const destination_id =
    typeof task._edit_destination_id === "string"
      ? task._edit_destination_id
      : undefined;
  const destination_text =
    typeof task._edit_destination_text === "string"
      ? task._edit_destination_text
      : undefined;
  const destination_type =
    typeof task._edit_destination_type === "string"
      ? task._edit_destination_type
      : undefined;

  if (destination_id || destination_text || destination_type) {
    return {
      ...(destination_id ? { _target_id: destination_id } : {}),
      ...(destination_text ? { _target_text: destination_text } : {}),
      ...(destination_type ? { _target_type: destination_type } : {}),
      _legacy_anchor: false,
    };
  }

  if (input._position === "before" || input._position === "after") {
    return {
      ...(input._resolved_task._edit_anchor_id
        ? { _target_id: input._resolved_task._edit_anchor_id }
        : {}),
      ...(input._resolved_task._edit_anchor_text
        ? { _target_text: input._resolved_task._edit_anchor_text }
        : {}),
      ...(input._resolved_task._edit_anchor_type
        ? { _target_type: input._resolved_task._edit_anchor_type }
        : {}),
      _legacy_anchor: true,
    };
  }

  return { _legacy_anchor: true };
}

function deterministic_move_missing_destination_reason(legacy_anchor: boolean): string {
  return legacy_anchor ? "anchor_not_found" : "destination_not_found";
}

function deterministic_move_resolution_failure(input: {
  _resolution: Extract<XVibeViewTargetResolution, { _ok: false }>;
  _legacy_anchor: boolean;
}): { _reason: string; _details?: unknown } {
  if (
    input._resolution._reason === "ambiguous_text_target" ||
    input._resolution._reason === "ambiguous_normalized_text_target"
  ) {
    return {
      _reason: input._resolution._reason,
      ...(input._resolution._details !== undefined
        ? { _details: input._resolution._details }
        : {}),
    };
  }

  return {
    _reason: deterministic_move_missing_destination_reason(input._legacy_anchor),
    ...(input._resolution._details !== undefined
      ? { _details: input._resolution._details }
      : {}),
  };
}

function view_node_contains_node(
  parent: XVibeJsonObject,
  candidate: XVibeJsonObject,
): boolean {
  if (parent === candidate) return true;
  if (!Array.isArray(parent._children)) return false;

  for (const child of parent._children) {
    if (!_xu.is_plain_object(child)) continue;
    if (view_node_contains_node(child, candidate)) return true;
  }

  return false;
}

function find_view_nodes_by_exact_text(
  current_view: unknown,
  target_text: string,
  target_type?: string,
  options?: { _include_id?: boolean },
): XVibeJsonObject[] {
  const matches =
    collect_view_nodes(current_view)
      .filter((node) =>
        view_node_visible_target_values(node, options).some((value) => value === target_text)
      );

  return filter_view_target_nodes_by_type(matches, target_type);
}

function normalized_deterministic_target_text(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .trim()
    .replace(/\s+/g, " ");
}

function find_view_nodes_by_normalized_text(
  current_view: unknown,
  target_text: string,
  target_type?: string,
  options?: { _include_id?: boolean },
): XVibeJsonObject[] {
  const normalized_target_text =
    normalized_visible_target_text(target_text);
  if (!normalized_target_text) return [];

  const matches =
    collect_view_nodes(current_view)
      .filter((node) =>
        view_node_visible_target_values(node, options)
          .some((value) => normalized_visible_target_text(value) === normalized_target_text)
      );

  return filter_view_target_nodes_by_type(matches, target_type);
}

function view_target_ids_for_details(nodes: XVibeJsonObject[]): string[] {
  return nodes
    .map((node) => typeof node._id === "string" ? node._id : undefined)
    .filter((id): id is string => Boolean(id));
}

function deterministic_text_type_target_id(input: {
  _target_text?: string;
  _target_type?: string;
}): string | undefined {
  const normalized_text =
    normalized_deterministic_target_text(input._target_text);
  const target_type =
    typeof input._target_type === "string"
      ? input._target_type.trim().toLowerCase()
      : "";
  if (!normalized_text || !target_type) return undefined;

  const text_id =
    normalized_text
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const type_id =
    target_type
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  if (!text_id || !type_id) return undefined;

  return `${text_id}-${type_id}`;
}

function resolve_deterministic_view_edit_text_target(input: {
  _current_view: unknown;
  _target_text: string;
  _target_type?: string;
  _include_id?: boolean;
}): (
  | {
    _ok: true;
    _target_id: string;
    _target_node: XVibeJsonObject;
    _resolved_by: "text" | "normalized_text" | "text_type_id";
    _reason: "eligible_text_match" | "eligible_normalized_text_match" | "eligible_id_from_text_type";
  }
  | {
    _ok: false;
    _reason: string;
    _details?: unknown;
  }
) {
  const target_text =
    typeof input._target_text === "string"
      ? input._target_text
      : "";
  if (!target_text) {
    return { _ok: false, _reason: "missing_target_id" };
  }

  const text_matches =
    find_view_nodes_by_exact_text(
      input._current_view,
      target_text,
      input._target_type,
      { _include_id: input._include_id === true },
    );
  if (text_matches.length > 1) {
    return {
      _ok: false,
      _reason: "ambiguous_text_target",
      _details: {
        _target_text: target_text,
        ...(input._target_type ? { _target_type: input._target_type } : {}),
        _match_count: text_matches.length,
        _target_ids: view_target_ids_for_details(text_matches),
      },
    };
  }

  const normalized_text_matches =
    find_view_nodes_by_normalized_text(
      input._current_view,
      target_text,
      input._target_type,
      { _include_id: input._include_id === true },
    );
  if (normalized_text_matches.length > 1) {
    return {
      _ok: false,
      _reason: "ambiguous_normalized_text_target",
      _details: {
        _target_text: target_text,
        _normalized_text: normalized_visible_target_text(target_text),
        ...(input._target_type ? { _target_type: input._target_type } : {}),
        _match_count: normalized_text_matches.length,
        _target_ids: view_target_ids_for_details(normalized_text_matches),
      },
    };
  }

  let resolved_node = text_matches[0];
  let resolved_by: "text" | "normalized_text" | "text_type_id" = "text";
  let resolved_reason: "eligible_text_match" | "eligible_normalized_text_match" | "eligible_id_from_text_type" =
    "eligible_text_match";

  if (!resolved_node && normalized_text_matches.length === 1) {
    resolved_node = normalized_text_matches[0];
    resolved_by = "normalized_text";
    resolved_reason = "eligible_normalized_text_match";
  }

  if (!resolved_node) {
    const text_type_target_id =
      deterministic_text_type_target_id({
        _target_text: target_text,
        _target_type: input._target_type,
      });
    const text_type_target_node =
      find_view_node_by_id(input._current_view, text_type_target_id);
    if (
      text_type_target_node &&
      view_node_matches_target_type(text_type_target_node, input._target_type)
    ) {
      resolved_node = text_type_target_node;
      resolved_by = "text_type_id";
      resolved_reason = "eligible_id_from_text_type";
    }
  }

  if (!resolved_node) {
    return {
      _ok: false,
      _reason: "text_target_not_found",
      _details: {
        _target_text: target_text,
        ...(input._target_type ? { _target_type: input._target_type } : {}),
      },
    };
  }

  const resolved_id =
    typeof resolved_node._id === "string"
      ? resolved_node._id.trim()
      : "";
  if (!resolved_id) {
    return { _ok: false, _reason: "missing_target_id" };
  }

  if (!_xu.is_plain_object(resolved_node)) {
    return {
      _ok: false,
      _reason: "target_not_object",
      _details: {
        _target_text: target_text,
      },
    };
  }

  if (resolved_node === input._current_view) {
    return {
      _ok: false,
      _reason: "target_is_root",
      _details: {
        _target_id: resolved_id,
      },
    };
  }

  return {
    _ok: true,
    _target_id: resolved_id,
    _target_node: resolved_node,
    _resolved_by: resolved_by,
    _reason: resolved_reason,
  };
}

function find_view_node_location_by_id(
  current_view: unknown,
  target_id: string | undefined,
): {
  _node: XVibeJsonObject;
  _parent?: XVibeJsonObject;
  _children?: unknown[];
  _index?: number;
} | undefined {
  if (!target_id || !_xu.is_plain_object(current_view)) return undefined;
  if (current_view._id === target_id) {
    return {
      _node: current_view,
    };
  }

  const visit = (node: XVibeJsonObject): {
    _node: XVibeJsonObject;
    _parent?: XVibeJsonObject;
    _children?: unknown[];
    _index?: number;
  } | undefined => {
    if (!Array.isArray(node._children)) return undefined;

    for (let index = 0; index < node._children.length; index += 1) {
      const child = node._children[index];
      if (!_xu.is_plain_object(child)) continue;

      if (child._id === target_id) {
        return {
          _node: child,
          _parent: node,
          _children: node._children,
          _index: index,
        };
      }

      const nested = visit(child);
      if (nested) return nested;
    }

    return undefined;
  };

  return visit(current_view);
}

function view_node_text_by_id(current_view: unknown, target_id: string | undefined): string | undefined {
  const node = find_view_node_by_id(current_view, target_id);
  return typeof node?._text === "string"
    ? node._text
    : undefined;
}

function clone_deterministic_view_json(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => clone_deterministic_view_json(item));
  }

  const clone: XVibeJsonObject = {};
  for (const [key, child] of Object.entries(value)) {
    clone[key] = clone_deterministic_view_json(child);
  }

  return clone;
}

type XVibeProjectViewIdAddition = {
  _path: string;
  _type: string;
  _id: string;
  _base_id: string;
  _collision_resolved: boolean;
};

type XVibeProjectViewFixViewReport = {
  _view_id: string;
  _objects_scanned: number;
  _ids_added: number;
  _collisions_resolved: number;
  _updated: boolean;
  _added_ids: XVibeProjectViewIdAddition[];
};

type XVibeProjectViewFixReport = {
  _app_id: string;
  _env: string;
  _dry_run: boolean;
  _views_scanned: number;
  _views_updated: number;
  _objects_scanned: number;
  _ids_added: number;
  _collisions_resolved: number;
  _views: XVibeProjectViewFixViewReport[];
};

function project_view_integrity_string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function project_view_integrity_slug(value: unknown): string {
  return typeof value === "string"
    ? value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]+/gu, " ")
      .trim()
      .split(/\s+/gu)
      .filter((part) => part.length > 0)
      .join("-")
    : "";
}

function project_view_integrity_type_slug(type: unknown): string {
  const slug = project_view_integrity_slug(type);
  return slug || "object";
}

function project_view_integrity_visible_text(node: XVibeJsonObject): string | undefined {
  return (
    project_view_integrity_string(node._text) ??
    project_view_integrity_string(node.text) ??
    project_view_integrity_string(node.label) ??
    project_view_integrity_string(node.title) ??
    project_view_integrity_string(node._label) ??
    project_view_integrity_string(node._title)
  );
}

function project_view_integrity_id_base(node: XVibeJsonObject): {
  _base: string;
  _start_index?: number;
} {
  const type_slug =
    project_view_integrity_type_slug(node._type);
  const visible_slug =
    project_view_integrity_slug(project_view_integrity_visible_text(node));

  if (!visible_slug) {
    return {
      _base: type_slug,
      _start_index: 1,
    };
  }

  if (
    type_slug === "label" ||
    type_slug === "text" ||
    type_slug === "text-label" ||
    type_slug === "xlabel"
  ) {
    return { _base: visible_slug };
  }

  if (visible_slug === type_slug || visible_slug.endsWith(`-${type_slug}`)) {
    return { _base: visible_slug };
  }

  return {
    _base: `${visible_slug}-${type_slug}`,
  };
}

function project_view_integrity_unique_id(input: {
  _base: string;
  _start_index?: number;
  _used_ids: Set<string>;
}): {
  _id: string;
  _collision_resolved: boolean;
} {
  const start_index = input._start_index;
  if (typeof start_index === "number") {
    for (let index = start_index; ; index += 1) {
      const candidate = `${input._base}-${index}`;
      if (!input._used_ids.has(candidate)) {
        input._used_ids.add(candidate);
        return {
          _id: candidate,
          _collision_resolved: index !== start_index,
        };
      }
    }
  }

  if (!input._used_ids.has(input._base)) {
    input._used_ids.add(input._base);
    return {
      _id: input._base,
      _collision_resolved: false,
    };
  }

  for (let index = 2; ; index += 1) {
    const candidate = `${input._base}-${index}`;
    if (!input._used_ids.has(candidate)) {
      input._used_ids.add(candidate);
      return {
        _id: candidate,
        _collision_resolved: true,
      };
    }
  }
}

function project_view_integrity_visit_nodes(
  value: unknown,
  visitor: (node: XVibeJsonObject, path: string) => void,
  path_value = "$",
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      project_view_integrity_visit_nodes(item, visitor, `${path_value}[${index}]`)
    );
    return;
  }

  if (!_xu.is_plain_object(value)) {
    return;
  }

  if (project_view_integrity_string(value._type)) {
    visitor(value, path_value);
  }

  for (const [key, child] of Object.entries(value)) {
    if (key === "_id") continue;
    if (Array.isArray(child) || _xu.is_plain_object(child)) {
      project_view_integrity_visit_nodes(child, visitor, `${path_value}.${key}`);
    }
  }
}

function project_view_integrity_existing_ids(view: unknown): Set<string> {
  const ids = new Set<string>();
  project_view_integrity_visit_nodes(view, (node) => {
    const id =
      project_view_integrity_string(node._id);
    if (id) ids.add(id);
  });
  return ids;
}

function fix_project_view_ids_for_view(input: {
  _view_id: string;
  _view: XVibeJsonObject;
}): XVibeProjectViewFixViewReport {
  const used_ids =
    project_view_integrity_existing_ids(input._view);
  const report: XVibeProjectViewFixViewReport = {
    _view_id: input._view_id,
    _objects_scanned: 0,
    _ids_added: 0,
    _collisions_resolved: 0,
    _updated: false,
    _added_ids: [],
  };

  project_view_integrity_visit_nodes(input._view, (node, node_path) => {
    report._objects_scanned += 1;

    const existing_id =
      project_view_integrity_string(node._id);
    if (existing_id) {
      return;
    }

    const type =
      project_view_integrity_string(node._type) ?? "object";
    const id_base =
      project_view_integrity_id_base(node);
    const generated =
      project_view_integrity_unique_id({
        _base: id_base._base,
        ...(typeof id_base._start_index === "number"
          ? { _start_index: id_base._start_index }
          : {}),
        _used_ids: used_ids,
      });

    node._id = generated._id;
    report._ids_added += 1;
    report._updated = true;
    if (generated._collision_resolved) {
      report._collisions_resolved += 1;
    }
    report._added_ids.push({
      _path: node_path,
      _type: type,
      _id: generated._id,
      _base_id: id_base._base,
      _collision_resolved: generated._collision_resolved,
    });
  });

  return report;
}

function extract_project_view_list_ids(response: unknown): string[] {
  if (!_xu.is_plain_object(response) || !_xu.is_plain_object(response._result)) {
    return [];
  }

  const views =
    Array.isArray(response._result._views)
      ? response._result._views
      : [];
  return views
    .map((view) =>
      _xu.is_plain_object(view)
        ? project_view_integrity_string(view._id)
        : undefined
    )
    .filter((id): id is string => Boolean(id));
}

function extract_project_view_from_response(response: unknown): XVibeJsonObject | undefined {
  if (
    _xu.is_plain_object(response) &&
    _xu.is_plain_object(response._result) &&
    _xu.is_plain_object(response._result._view)
  ) {
    return response._result._view as XVibeJsonObject;
  }

  return undefined;
}

function deterministic_duplicate_id_base(value: unknown, fallback_type: unknown): string {
  const source_id =
    typeof value === "string" ? value.trim() : "";
  if (source_id) return `${source_id}-copy`;

  const source_type =
    typeof fallback_type === "string" ? fallback_type.trim() : "";
  const normalized_type =
    source_type
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "");
  return `${normalized_type || "object"}-copy`;
}

function deterministic_next_duplicate_id(base: string, used_ids: Set<string>): string {
  if (!used_ids.has(base)) {
    used_ids.add(base);
    return base;
  }

  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!used_ids.has(candidate)) {
      used_ids.add(candidate);
      return candidate;
    }
  }
}

function clone_deterministic_duplicate_subtree(
  source_node: XVibeJsonObject,
  used_ids: Set<string>,
): XVibeJsonObject {
  const clone =
    clone_deterministic_view_json(source_node) as XVibeJsonObject;

  const assign_ids = (node: unknown): void => {
    if (!_xu.is_plain_object(node)) return;
    if (typeof node._type !== "string" || !node._type.trim()) return;

    const base =
      deterministic_duplicate_id_base(node._id, node._type);
    node._id = deterministic_next_duplicate_id(base, used_ids);

    if (Array.isArray(node._children)) {
      for (const child of node._children) {
        assign_ids(child);
      }
    }
  };

  assign_ids(clone);
  return clone;
}

function deterministic_new_child_id_base(type: unknown): string {
  const source_type =
    typeof type === "string" ? type.trim() : "";
  const normalized_type =
    source_type
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "");
  return normalized_type || "object";
}

function collect_child_declared_ids(input: {
  _child: XVibeJsonObject;
}): string[] {
  const ids: string[] = [];

  const visit = (node: unknown): void => {
    if (!_xu.is_plain_object(node)) return;

    if (typeof node._id === "string" && node._id.trim().length > 0) {
      ids.push(node._id.trim());
    }

    if (Array.isArray(node._children)) {
      for (const child of node._children) {
        visit(child);
      }
    }
  };

  visit(input._child);
  return ids;
}

function first_duplicate_child_declared_id(child: XVibeJsonObject): string | undefined {
  const seen = new Set<string>();

  for (const id of collect_child_declared_ids({ _child: child })) {
    if (seen.has(id)) return id;
    seen.add(id);
  }

  return undefined;
}

function normalize_added_child_ids(input: {
  _child: XVibeJsonObject;
  _used_ids: Set<string>;
}): XVibeJsonObject {
  const child =
    clone_deterministic_view_json(input._child) as XVibeJsonObject;

  const assign_ids = (node: unknown): void => {
    if (!_xu.is_plain_object(node)) return;
    if (typeof node._type !== "string" || !node._type.trim()) return;

    const declared_id =
      typeof node._id === "string" ? node._id.trim() : "";

    if (declared_id && !input._used_ids.has(declared_id)) {
      node._id = declared_id;
      input._used_ids.add(declared_id);
    } else {
      node._id =
        deterministic_next_duplicate_id(
          declared_id || deterministic_new_child_id_base(node._type),
          input._used_ids,
        );
    }

    if (Array.isArray(node._children)) {
      for (const nested_child of node._children) {
        assign_ids(nested_child);
      }
    }
  };

  assign_ids(child);
  return child;
}

function existing_identical_child_by_id(input: {
  _parent: XVibeJsonObject;
  _child: XVibeJsonObject;
}): XVibeJsonObject | undefined {
  const child_id =
    typeof input._child._id === "string" && input._child._id.trim()
      ? input._child._id.trim()
      : "";
  if (!child_id || !Array.isArray(input._parent._children)) {
    return undefined;
  }

  return input._parent._children.find((candidate) =>
    _xu.is_plain_object(candidate) &&
    candidate._id === child_id &&
    JSON.stringify(candidate) === JSON.stringify(input._child)
  ) as XVibeJsonObject | undefined;
}

function normalize_add_child_location(value: unknown): "top" | "bottom" {
  if (typeof value !== "string") return "bottom";
  const normalized = value.trim().toLowerCase().replace(/\s+/gu, " ");
  if (
    normalized === "header" ||
    normalized === "top" ||
    normalized === "toolbar"
  ) {
    return "top";
  }

  return "bottom";
}

function normalize_create_toolbar_location(value: unknown): XVibeCreateToolbarLocation {
  if (typeof value !== "string") return "top";
  const normalized =
    value
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/gu, "-")
      .replace(/-+/gu, "-");
  if (normalized === "bottom" || normalized === "footer") return "bottom";
  if (normalized === "before" || normalized === "above") return "before";
  if (normalized === "after" || normalized === "below") return "after";
  return "top";
}

function add_child_location_label(value: unknown): "Header" | "Footer" {
  return normalize_add_child_location(value) === "top" ? "Header" : "Footer";
}

function synthesized_add_child_text(props: unknown, label: "Header" | "Footer"): string {
  if (_xu.is_plain_object(props)) {
    const text =
      typeof props._text === "string" ? props._text.trim() : "";
    if (text) return text;
  }

  return `New ${label} Label`;
}

function synthesized_add_child_class(props: unknown, label: "Header" | "Footer"): string {
  if (_xu.is_plain_object(props)) {
    const class_name =
      typeof props.class === "string" ? props.class.trim() : "";
    if (class_name) return class_name;
  }

  const location_class = label.toLowerCase();
  return `xvibe-generated-label xvibe-${location_class}-label`;
}

function synthesized_add_child(input: {
  _child?: unknown;
  _component_type?: unknown;
  _location?: unknown;
  _props?: unknown;
}): XVibeJsonObject | undefined {
  if (_xu.is_plain_object(input._child)) {
    return input._child;
  }

  const component_type =
    typeof input._component_type === "string" && input._component_type.trim()
      ? input._component_type.trim()
      : "label";
  if (component_type !== "label") return undefined;

  const location_label = add_child_location_label(input._location);
  return {
    _type: "label",
    _text: synthesized_add_child_text(input._props, location_label),
    class: synthesized_add_child_class(input._props, location_label),
  };
}

function deterministic_toolbar_id_base(view_id: unknown): string {
  const normalized =
    typeof view_id === "string"
      ? view_id
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, "-")
        .replace(/-+/gu, "-")
        .replace(/^-|-$/gu, "")
      : "";
  return `${normalized || "main"}-toolbar`;
}

function deterministic_toolbar_props(value: unknown): XVibeJsonObject {
  return _xu.is_plain_object(value)
    ? clone_deterministic_view_json(value) as XVibeJsonObject
    : {};
}

function synthesized_create_toolbar(input: {
  _view_id?: unknown;
  _toolbar_props?: unknown;
}): XVibeJsonObject {
  const props =
    deterministic_toolbar_props(input._toolbar_props);
  const toolbar_id =
    typeof props._id === "string" && props._id.trim()
      ? props._id.trim()
      : deterministic_toolbar_id_base(input._view_id);
  return {
    ...props,
    _type: "toolbar",
    _id: toolbar_id,
  };
}

function find_existing_toolbar_node(current_view: unknown): XVibeJsonObject | undefined {
  return collect_view_nodes(current_view)
    .find((node) => node._type === "toolbar");
}

function xvibe_style_has_display_none(style: unknown): boolean {
  return (
    typeof style === "string" &&
    /(?:^|;)\s*display\s*:\s*none\s*(?:;|$)/iu.test(style)
  );
}

function xvibe_style_without_display(style: string): string {
  return style
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !/^display\s*:/iu.test(part))
    .join("; ");
}

function xvibe_deterministic_hide_style(style: unknown): string {
  const base =
    typeof style === "string"
      ? xvibe_style_without_display(style)
      : "";
  return base
    ? `${base}; display:none`
    : "display:none";
}

function xvibe_style_without_display_none(style: string): string {
  return style
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !/^display\s*:\s*none\s*$/iu.test(part))
    .join("; ");
}

function deterministic_class_field(node: XVibeJsonObject): "class" | "_class" {
  return typeof node.class === "string" || typeof node._class !== "string"
    ? "class"
    : "_class";
}

function deterministic_class_tokens(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function deterministic_next_class_value(input: {
  _action: "add-class" | "remove-class" | "replace-class" | "toggle-class";
  _previous_class: unknown;
  _class_name?: string;
  _old_class_name?: string;
  _new_class_name?: string;
}): string | undefined {
  const tokens = deterministic_class_tokens(input._previous_class);
  if (input._action === "add-class") {
    if (input._class_name && !tokens.includes(input._class_name)) {
      tokens.push(input._class_name);
    }
  } else if (input._action === "remove-class") {
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      if (tokens[index] === input._class_name) {
        tokens.splice(index, 1);
      }
    }
  } else if (input._action === "toggle-class") {
    if (input._class_name && tokens.includes(input._class_name)) {
      for (let index = tokens.length - 1; index >= 0; index -= 1) {
        if (tokens[index] === input._class_name) {
          tokens.splice(index, 1);
        }
      }
    } else if (input._class_name) {
      tokens.push(input._class_name);
    }
  } else {
    const old_class_name = input._old_class_name ?? "";
    const new_class_name = input._new_class_name ?? "";
    if (old_class_name && new_class_name) {
      if (old_class_name === new_class_name) {
        const unique_tokens = Array.from(new Set(tokens));
        tokens.splice(0, tokens.length, ...unique_tokens);
        return tokens.length > 0 ? tokens.join(" ") : undefined;
      }

      const old_class_present = tokens.includes(old_class_name);
      const new_class_present = tokens.includes(new_class_name);
      const next_tokens: string[] = [];
      let inserted_new_class = false;

      for (const token of tokens) {
        if (token === old_class_name) {
          if (!new_class_present && !inserted_new_class) {
            next_tokens.push(new_class_name);
            inserted_new_class = true;
          }
          continue;
        }

        if (token === new_class_name) {
          if (!inserted_new_class) {
            next_tokens.push(token);
            inserted_new_class = true;
          }
          continue;
        }

        next_tokens.push(token);
      }

      if (!old_class_present && !inserted_new_class) {
        next_tokens.push(new_class_name);
      }

      tokens.splice(0, tokens.length, ...next_tokens);
    }
  }

  return tokens.length > 0 ? tokens.join(" ") : undefined;
}

function deterministic_style_object(value: unknown): XVibeJsonObject {
  return _xu.is_plain_object(value) ? value : {};
}

function deterministic_style_is_empty(value: XVibeJsonObject): boolean {
  return Object.keys(value).length === 0;
}

const XVIBE_DETERMINISTIC_STYLE_PROPERTY_ALIASES: Record<string, string> = {
  fontSize: "font-size",
  fontWeight: "font-weight",
  marginBottom: "margin-bottom",
  backgroundColor: "background-color",
};

function deterministic_normalize_style_property_name(value: string): string {
  const trimmed = value.trim();
  return XVIBE_DETERMINISTIC_STYLE_PROPERTY_ALIASES[trimmed] ?? trimmed;
}

function deterministic_normalize_set_styles(value: unknown):
  | { _ok: true; _styles: XVibeJsonObject }
  | { _ok: false; _reason: string; _details?: XVibeJsonObject } {
  if (!_xu.is_plain_object(value)) {
    return { _ok: false, _reason: "invalid_styles" };
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    return { _ok: false, _reason: "missing_styles" };
  }

  const styles: XVibeJsonObject = {};
  for (const [raw_property, raw_value] of entries) {
    const style_property =
      deterministic_normalize_style_property_name(raw_property);
    if (!style_property) {
      return {
        _ok: false,
        _reason: "missing_style_property",
        _details: {
          _style_property: raw_property,
        },
      };
    }

    if (typeof raw_value !== "string" || raw_value.trim().length === 0) {
      return {
        _ok: false,
        _reason: "invalid_style_value",
        _details: {
          _style_property: style_property,
        },
      };
    }

    styles[style_property] = raw_value.trim();
  }

  return { _ok: true, _styles: styles };
}

function deterministic_is_primitive_or_null(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function deterministic_is_json_property_value(value: unknown, seen = new Set<object>()): boolean {
  if (value === null) return true;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);

  if (Array.isArray(value)) {
    return value.every((item) => deterministic_is_json_property_value(item, seen));
  }

  if (!_xu.is_plain_object(value)) return false;
  return Object.values(value)
    .every((item) => deterministic_is_json_property_value(item, seen));
}

function deterministic_interaction_scope(value: unknown): XVibeInteractionScope {
  return value === "_once" ? "_once" : "_on";
}

function deterministic_interaction_handler_validation(
  handler: unknown,
): { _ok: true } | { _ok: false; _reason: string; _details?: XVibeJsonObject } {
  if (handler === null) {
    return { _ok: true };
  }

  if (!_xu.is_plain_object(handler)) {
    return {
      _ok: false,
      _reason: "invalid_handler",
      _details: {
        _handler_type: Array.isArray(handler) ? "array" : typeof handler,
      },
    };
  }

  if (typeof handler._module !== "string" || handler._module.trim().length === 0) {
    return {
      _ok: false,
      _reason: "invalid_handler",
      _details: {
        _field: "_module",
      },
    };
  }

  if (typeof handler._op !== "string" || handler._op.trim().length === 0) {
    return {
      _ok: false,
      _reason: "invalid_handler",
      _details: {
        _field: "_op",
      },
    };
  }

  if (
    Object.prototype.hasOwnProperty.call(handler, "_params") &&
    handler._params !== undefined &&
    !_xu.is_plain_object(handler._params)
  ) {
    return {
      _ok: false,
      _reason: "invalid_handler",
      _details: {
        _field: "_params",
      },
    };
  }

  return { _ok: true };
}

function deterministic_runtime_skill_payloads(): unknown[] {
  try {
    const get_skills = (_x as any).getSkills;
    const runtime_skills =
      typeof get_skills === "function" ? get_skills.call(_x) : undefined;
    return runtime_skills === undefined ? [] : [runtime_skills];
  } catch {
    return [];
  }
}

function deterministic_collect_object_skills(value: unknown, out: XVibeJsonObject[] = []): XVibeJsonObject[] {
  if (!_xu.is_plain_object(value)) return out;

  if (_xu.is_plain_object(value._skill)) {
    deterministic_collect_object_skills(value._skill, out);
  }

  if (_xu.is_plain_object(value._design)) {
    out.push(value);
  }

  if (Array.isArray(value._skills)) {
    for (const skill of value._skills) {
      deterministic_collect_object_skills(skill, out);
    }
  }

  if (Array.isArray(value._modules)) {
    for (const module_item of value._modules) {
      deterministic_collect_object_skills(module_item, out);
    }
  }

  if (Array.isArray(value._objects)) {
    for (const object_skill of value._objects) {
      deterministic_collect_object_skills(object_skill, out);
    }
  }

  return out;
}

function deterministic_skill_matches_type(skill: XVibeJsonObject, target_type: string): boolean {
  return [
    skill._id,
    skill._xtype,
    skill._xui_type,
    skill._object_type,
    skill._type,
  ].some((value) => typeof value === "string" && value.trim() === target_type);
}

function deterministic_inspector_field_keys_from_skill(skill: XVibeJsonObject): {
  _field_keys: string[];
  _json_field_keys: string[];
} {
  const fields =
    _xu.is_plain_object(skill._design) &&
    _xu.is_plain_object(skill._design._inspector) &&
    Array.isArray(skill._design._inspector._fields)
      ? skill._design._inspector._fields
      : [];
  const field_keys: string[] = [];
  const json_field_keys: string[] = [];

  for (const field of fields) {
    if (!_xu.is_plain_object(field)) continue;
    const key =
      typeof field._key === "string" ? field._key.trim() : "";
    if (!key) continue;

    field_keys.push(key);
    if (field._input === "json") {
      json_field_keys.push(key);
    }
  }

  return {
    _field_keys: Array.from(new Set(field_keys)),
    _json_field_keys: Array.from(new Set(json_field_keys)),
  };
}

function deterministic_inspector_fields_for_node(target_node: XVibeJsonObject): {
  _skill_design_found: boolean;
  _field_keys: string[];
  _json_field_keys: string[];
} {
  const target_type =
    typeof target_node._type === "string" ? target_node._type.trim() : "";
  const candidate_skills = deterministic_collect_object_skills(target_node);
  for (const payload of deterministic_runtime_skill_payloads()) {
    deterministic_collect_object_skills(payload, candidate_skills);
  }

  const matching_skills =
    target_type
      ? candidate_skills.filter((skill) => deterministic_skill_matches_type(skill, target_type))
      : candidate_skills.filter((skill) => _xu.is_plain_object(skill._design));
  const field_keys = new Set<string>();
  const json_field_keys = new Set<string>();

  for (const skill of matching_skills) {
    const fields = deterministic_inspector_field_keys_from_skill(skill);
    for (const key of fields._field_keys) field_keys.add(key);
    for (const key of fields._json_field_keys) json_field_keys.add(key);
  }

  return {
    _skill_design_found: field_keys.size > 0,
    _field_keys: Array.from(field_keys),
    _json_field_keys: Array.from(json_field_keys),
  };
}

function deterministic_existing_primitive_field_keys(target_node: XVibeJsonObject): string[] {
  return Object.keys(target_node)
    .filter((key) => {
      const value = target_node[key];
      return (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      );
    });
}

function deterministic_set_property_eligibility(input: {
  _target_node: XVibeJsonObject;
  _property_name: string;
  _next_value?: unknown;
  _is_set: boolean;
}): {
  _ok: boolean;
  _reason?: string;
  _details?: XVibeJsonObject;
} {
  const property_name = input._property_name;
  const target_type =
    typeof input._target_node._type === "string" ? input._target_node._type : "";
  const design = deterministic_inspector_fields_for_node(input._target_node);
  const design_field_keys = new Set(design._field_keys);
  const json_field_keys = new Set(design._json_field_keys);
  const existing_primitive_field_keys =
    deterministic_existing_primitive_field_keys(input._target_node);
  const current_exists =
    Object.prototype.hasOwnProperty.call(input._target_node, property_name);
  const current_value = input._target_node[property_name];
  const current_is_primitive_or_null =
    deterministic_is_primitive_or_null(current_value);
  const existing_allows_null =
    input._is_set &&
    input._next_value === null &&
    current_exists &&
    current_is_primitive_or_null;
  const allowed_field_keys = Array.from(new Set([
    ...XVIBE_DETERMINISTIC_BUILTIN_PROPERTY_NAMES,
    ...design._field_keys,
    ...existing_primitive_field_keys,
    ...(existing_allows_null ? [property_name] : []),
  ]))
    .filter((key) => !XVIBE_DETERMINISTIC_BLOCKED_PROPERTY_NAMES.has(key))
    .sort();
  const unsupported_details = {
    _target_type: target_type,
    _property_name: property_name,
    _skill_design_found: design._skill_design_found,
    _allowed_field_keys: allowed_field_keys,
  };

  if (XVIBE_DETERMINISTIC_BLOCKED_PROPERTY_NAMES.has(property_name)) {
    return {
      _ok: false,
      _reason: "unsupported_property",
      _details: unsupported_details,
    };
  }

  const property_allowed =
    XVIBE_DETERMINISTIC_BUILTIN_PROPERTY_NAMES.has(property_name) ||
    design_field_keys.has(property_name) ||
    existing_primitive_field_keys.includes(property_name) ||
    existing_allows_null;

  if (!property_allowed) {
    return {
      _ok: false,
      _reason: "unsupported_property",
      _details: unsupported_details,
    };
  }

  if (!input._is_set) {
    return { _ok: true };
  }

  const next_value = input._next_value;
  const is_json_field =
    json_field_keys.has(property_name) ||
    XVIBE_DETERMINISTIC_BUILTIN_JSON_PROPERTY_NAMES.has(property_name);
  const next_is_object_or_array =
    typeof next_value === "object" && next_value !== null;

  if (next_is_object_or_array) {
    if (!is_json_field || !deterministic_is_json_property_value(next_value)) {
      return {
        _ok: false,
        _reason: "unsupported_property_value",
        _details: {
          ...unsupported_details,
          _value_type: Array.isArray(next_value) ? "array" : "object",
          _json_field: is_json_field,
        },
      };
    }

    return { _ok: true };
  }

  if (
    typeof next_value === "string" ||
    typeof next_value === "number" ||
    typeof next_value === "boolean"
  ) {
    return { _ok: true };
  }

  if (next_value === null && existing_allows_null) {
    return { _ok: true };
  }

  return {
    _ok: false,
    _reason: "unsupported_property_value",
    _details: {
      ...unsupported_details,
      _value_type: next_value === null ? "null" : typeof next_value,
      _json_field: is_json_field,
    },
  };
}

function find_first_style_sheet_node(current_view: unknown): XVibeJsonObject | undefined {
  return collect_view_nodes(current_view)
    .find((node) => node._type === "style-sheet");
}

function find_first_inline_style_sheet_node(current_view: unknown): XVibeJsonObject | undefined {
  const style_sheet = find_first_style_sheet_node(current_view);
  if (!style_sheet) return undefined;
  if (typeof style_sheet._href === "string" && style_sheet._href.trim()) {
    return undefined;
  }

  return _xu.is_plain_object(style_sheet._classes)
    ? style_sheet
    : undefined;
}

function deterministic_mutation_allows_inline_style(
  mutation: XVibeDeterministicViewEditResult["_mutation"] | undefined,
): boolean {
  return (
    mutation?._action === "set-style" ||
    mutation?._action === "set-styles" ||
    mutation?._action === "remove-style"
  );
}

function deterministic_target_text_is_id_phrase(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return /^(?:button|label|object|input|field|form|card|table|row|column|toolbar|sidebar|modal|drawer|section|xsection|text|title|heading|image|icon|link)\s+id$/u
    .test(value.trim().toLowerCase().replace(/\s+/g, " "));
}

function deterministic_edit_target_id(input: {
  _resolved_task: XVibeResolvedTask;
  _edit_intent?: XVibeViewEditIntent;
}): string | undefined {
  const intent_target_id =
    typeof input._edit_intent?._target_id === "string"
      ? input._edit_intent._target_id.trim()
      : "";
  const resolved_target_id =
    typeof input._resolved_task._edit_target_id === "string"
      ? input._resolved_task._edit_target_id.trim()
      : "";
  if (resolved_target_id) {
    return intent_target_id || resolved_target_id;
  }

  if (
    intent_target_id &&
    deterministic_target_text_is_id_phrase(input._resolved_task._edit_target_text)
  ) {
    return intent_target_id;
  }

  return undefined;
}

function resolve_deterministic_view_edit_target(input: {
  _current_view: unknown;
  _target_id?: string;
  _target_text?: string;
  _target_type?: string;
  _target_id_text_fallback?: boolean;
  _allow_root?: boolean;
}): (
  | {
    _ok: true;
    _target_id: string;
    _target_node: XVibeJsonObject;
    _resolved_by: "id" | "text" | "normalized_text" | "text_type_id";
    _reason: "eligible" | "eligible_text_match" | "eligible_normalized_text_match" | "eligible_id_from_text_type";
  }
  | {
    _ok: false;
    _reason: string;
    _details?: unknown;
  }
) {
  const resolution =
    resolveViewTarget(input._current_view, {
      _target_id: input._target_id,
      _target_text: input._target_text,
      _target_type: input._target_type,
      _include_id:
        typeof input._target_id === "string" &&
        input._target_id.trim().length > 0 &&
        input._target_id_text_fallback === true,
      _target_id_text_fallback: input._target_id_text_fallback,
      _allow_root: input._allow_root,
    });
  if (!resolution._ok) {
    const requested_target_id =
      typeof input._target_id === "string" ? input._target_id.trim() : "";
    if (requested_target_id && resolution._reason === "text_target_not_found") {
      return {
        _ok: false,
        _reason: "target_not_found",
        _details: {
          _target_id: requested_target_id,
        },
      };
    }

    return {
      _ok: false,
      _reason: resolution._reason,
      ...(resolution._details !== undefined
        ? { _details: resolution._details }
        : {}),
    };
  }

  const target_id =
    typeof resolution.object._id === "string"
      ? resolution.object._id.trim()
      : "";
  if (!target_id) {
    return { _ok: false, _reason: "missing_target_id" };
  }

  const resolved_by =
    resolution.resolution_strategy === "text"
      ? "text"
      : resolution.resolution_strategy === "text_type_id"
        ? "text_type_id"
        : resolution.resolution_strategy === "normalized_text" ||
          resolution.resolution_strategy === "normalized_id"
          ? "normalized_text"
          : "id";
  const reason =
    resolved_by === "text"
      ? "eligible_text_match"
      : resolved_by === "text_type_id"
        ? "eligible_id_from_text_type"
        : resolved_by === "normalized_text"
          ? "eligible_normalized_text_match"
          : "eligible";

  if (
    typeof input._target_id === "string" &&
    input._target_id.trim() &&
    resolved_by !== "id"
  ) {
    _xlog.log("[xvibe] view target resolved by text", {
      _target_id: input._target_id.trim(),
      _resolved_target_id: target_id,
      _resolved_by: resolved_by,
      _resolution_strategy: resolution.resolution_strategy,
      ...(input._target_type ? { _target_type: input._target_type } : {}),
    });
  }

  return {
    _ok: true,
    _target_id: target_id,
    _target_node: resolution.object,
    _resolved_by: resolved_by,
    _reason: reason,
  };
}

function deterministic_resolved_by_from_eligibility(
  eligibility: XVibeDeterministicViewEditEligibility,
): "id" | "text" | "normalized_text" | "text_type_id" {
  if (
    eligibility._details &&
    _xu.is_plain_object(eligibility._details) &&
    (
      eligibility._details._resolved_by === "text" ||
      eligibility._details._resolved_by === "normalized_text" ||
      eligibility._details._resolved_by === "text_type_id"
    )
  ) {
    return eligibility._details._resolved_by;
  }

  if (eligibility._reason === "eligible_text_match") return "text";
  if (eligibility._reason === "eligible_normalized_text_match") return "normalized_text";
  if (eligibility._reason === "eligible_id_from_text_type") return "text_type_id";
  return "id";
}

function deterministic_resolved_by_from_view_target_strategy(
  strategy: XVibeViewTargetResolutionStrategy,
): "id" | "text" | "normalized_text" | "text_type_id" {
  if (strategy === "text") return "text";
  if (strategy === "text_type_id") return "text_type_id";
  if (strategy === "normalized_text" || strategy === "normalized_id") {
    return "normalized_text";
  }
  return "id";
}

function deterministic_reason_from_view_target_strategy(
  strategy: XVibeViewTargetResolutionStrategy,
): "eligible" | "eligible_text_match" | "eligible_normalized_text_match" | "eligible_id_from_text_type" {
  const resolved_by =
    deterministic_resolved_by_from_view_target_strategy(strategy);
  if (resolved_by === "text") return "eligible_text_match";
  if (resolved_by === "text_type_id") return "eligible_id_from_text_type";
  if (resolved_by === "normalized_text") return "eligible_normalized_text_match";
  return "eligible";
}

export function can_apply_deterministic_view_edit(input: {
  _resolved_task: XVibeResolvedTask;
  _current_view?: unknown;
  _edit_intent?: XVibeViewEditIntent;
}): XVibeDeterministicViewEditEligibility {
  const resolved_task = input._resolved_task;
  if (resolved_task._artifact_type !== "view") {
    return { _eligible: false, _reason: "not_view_artifact" };
  }

  if (resolved_task._action !== "update") {
    return { _eligible: false, _reason: "not_update_action" };
  }

  if (
    resolved_task._edit_action !== "update" &&
    resolved_task._edit_action !== "remove" &&
    resolved_task._edit_action !== "hide" &&
    resolved_task._edit_action !== "show" &&
    resolved_task._edit_action !== "add-class" &&
    resolved_task._edit_action !== "remove-class" &&
    resolved_task._edit_action !== "replace-class" &&
    resolved_task._edit_action !== "toggle-class" &&
    resolved_task._edit_action !== "set-style" &&
    resolved_task._edit_action !== "set-styles" &&
    resolved_task._edit_action !== "remove-style" &&
    resolved_task._edit_action !== "set-style-class-rule" &&
    resolved_task._edit_action !== "remove-style-class-rule" &&
    resolved_task._edit_action !== "set-property" &&
    resolved_task._edit_action !== "update-property" &&
    resolved_task._edit_action !== "remove-property" &&
    resolved_task._edit_action !== "move-object" &&
    resolved_task._edit_action !== "replace-object" &&
    resolved_task._edit_action !== "duplicate-object" &&
    resolved_task._edit_action !== "add-child" &&
    resolved_task._edit_action !== "create-toolbar" &&
    resolved_task._edit_action !== "set-interaction" &&
    resolved_task._edit_action !== "bind-flow"
  ) {
    return { _eligible: false, _reason: "unsupported_edit_action" };
  }

  if (input._current_view === undefined || input._current_view === null) {
    return { _eligible: false, _reason: "missing_current_view" };
  }

  const target_id =
    deterministic_edit_target_id({
      _resolved_task: resolved_task,
      _edit_intent: input._edit_intent,
    });

  if (resolved_task._edit_action === "update") {
    if (resolved_task._edit_field !== "_text") {
      return {
        _eligible: false,
        _reason: "unsupported_field",
        _details: {
          _field: resolved_task._edit_field,
        },
      };
    }

    const replacement_text =
      typeof resolved_task._edit_replacement_text === "string"
        ? resolved_task._edit_replacement_text
        : "";
    if (!replacement_text.trim()) {
      return { _eligible: false, _reason: "missing_replacement_text" };
    }

    const target_resolution =
      resolve_deterministic_view_edit_target({
        _current_view: input._current_view,
        _target_id: target_id,
        _target_text: resolved_task._edit_target_text,
        _target_type: resolved_task._edit_target_type,
        _target_id_text_fallback: true,
      });
    if (!target_resolution._ok) {
      return {
        _eligible: false,
        _reason: target_resolution._reason,
        ...(target_resolution._details !== undefined
          ? { _details: target_resolution._details }
          : {}),
      };
    }

    if (
      target_resolution._resolved_by === "id" &&
      typeof resolved_task._edit_target_text === "string" &&
      target_resolution._target_node._text !== resolved_task._edit_target_text
    ) {
      return {
        _eligible: false,
        _reason: "text_mismatch",
        _details: {
          _target_id: target_resolution._target_id,
          _expected_text: resolved_task._edit_target_text,
          _actual_text: target_resolution._target_node._text,
        },
      };
    }

    return {
      _eligible: true,
      _action: "update-text",
      _target_id: target_resolution._target_id,
      _field: "_text",
      _reason: target_resolution._reason,
    };
  }

  if (
    resolved_task._edit_action === "set-styles"
  ) {
    const styles_value =
      resolved_task._edit_styles ??
      (input._edit_intent?._styles as unknown);
    if (styles_value === undefined || styles_value === null) {
      return { _eligible: false, _reason: "missing_styles" };
    }

    const styles_validation =
      deterministic_normalize_set_styles(styles_value);
    if (!styles_validation._ok) {
      return {
        _eligible: false,
        _reason: styles_validation._reason,
        ...(styles_validation._details !== undefined
          ? { _details: styles_validation._details }
          : {}),
      };
    }

    const target_resolution =
      resolveViewTarget(input._current_view, {
        _target_id: target_id,
        _target_text: resolved_task._edit_target_text,
        _target_type: resolved_task._edit_target_type,
        _target_id_text_fallback: Boolean(target_id),
        _include_id: Boolean(target_id),
      });
    if (!target_resolution._ok) {
      return {
        _eligible: false,
        _reason: target_resolution._reason === "text_target_not_found"
          ? "target_not_found"
          : target_resolution._reason,
        ...(target_resolution._details !== undefined
          ? { _details: target_resolution._details }
          : {}),
      };
    }

    if (target_resolution.object === input._current_view) {
      return {
        _eligible: false,
        _reason: "target_is_root",
        _details: {
          _target_id: target_id,
        },
      };
    }

    const resolved_target_id =
      typeof target_resolution.object._id === "string" &&
      target_resolution.object._id.trim()
        ? target_resolution.object._id.trim()
        : target_id;

    return {
      _eligible: true,
      _action: "set-styles",
      _target_id: resolved_target_id,
      _reason: deterministic_reason_from_view_target_strategy(
        target_resolution.resolution_strategy,
      ),
      _details: {
        _resolved_by: deterministic_resolved_by_from_view_target_strategy(
          target_resolution.resolution_strategy,
        ),
        _styles_applied: styles_validation._styles,
      },
    };
  }

  if (
    resolved_task._edit_action === "set-style" ||
    resolved_task._edit_action === "remove-style"
  ) {
    const style_property =
      typeof resolved_task._edit_style_property === "string"
        ? resolved_task._edit_style_property.trim()
        : "";
    const style_value =
      typeof resolved_task._edit_style_value === "string"
        ? resolved_task._edit_style_value.trim()
        : "";

    if (!style_property) {
      return { _eligible: false, _reason: "missing_style_property" };
    }

    if (resolved_task._edit_action === "set-style" && !style_value) {
      return { _eligible: false, _reason: "missing_style_value" };
    }

    const target_resolution =
      resolve_deterministic_view_edit_target({
        _current_view: input._current_view,
        _target_id: target_id,
        _target_text: resolved_task._edit_target_text,
        _target_type: resolved_task._edit_target_type,
        _target_id_text_fallback: Boolean(target_id),
      });
    if (!target_resolution._ok) {
      return {
        _eligible: false,
        _reason: target_resolution._reason,
        ...(target_resolution._details !== undefined
          ? { _details: target_resolution._details }
          : {}),
      };
    }

    return {
      _eligible: true,
      _action: resolved_task._edit_action,
      _target_id: target_resolution._target_id,
      _reason: target_resolution._reason,
      _details: {
        _resolved_by: target_resolution._resolved_by,
      },
    };
  }

  if (
    resolved_task._edit_action === "set-style-class-rule" ||
    resolved_task._edit_action === "remove-style-class-rule"
  ) {
    const class_name =
      typeof resolved_task._edit_class_name === "string"
        ? resolved_task._edit_class_name.trim()
        : "";
    const style_property =
      typeof resolved_task._edit_style_property === "string"
        ? resolved_task._edit_style_property.trim()
        : "";
    const style_value =
      typeof resolved_task._edit_style_value === "string"
        ? resolved_task._edit_style_value.trim()
        : "";

    if (!class_name) {
      return { _eligible: false, _reason: "missing_class_name" };
    }

    if (!style_property) {
      return { _eligible: false, _reason: "missing_style_property" };
    }

    if (resolved_task._edit_action === "set-style-class-rule" && !style_value) {
      return { _eligible: false, _reason: "missing_style_value" };
    }

    const style_sheet = find_first_style_sheet_node(input._current_view);
    if (!style_sheet) {
      return { _eligible: false, _reason: "missing_style_sheet" };
    }

    if (typeof style_sheet._href === "string" && style_sheet._href.trim()) {
      return { _eligible: false, _reason: "external_style_sheet" };
    }

    if (!_xu.is_plain_object(style_sheet._classes)) {
      return { _eligible: false, _reason: "missing_inline_style_classes" };
    }

    const existing_rule = style_sheet._classes[class_name];
    if (existing_rule !== undefined && !_xu.is_plain_object(existing_rule)) {
      return {
        _eligible: false,
        _reason: "class_rule_not_object",
        _details: {
          _class_name: class_name,
        },
      };
    }

    return {
      _eligible: true,
      _action: resolved_task._edit_action,
      _reason: "eligible_style_class_rule",
    };
  }

  const is_set_property_action =
    resolved_task._edit_action === "set-property" ||
    resolved_task._edit_action === "update-property";

  if (
    is_set_property_action ||
    resolved_task._edit_action === "remove-property"
  ) {
    const property_name =
      typeof resolved_task._edit_property_name === "string"
        ? resolved_task._edit_property_name.trim()
        : "";

    if (!property_name) {
      return { _eligible: false, _reason: "missing_property_name" };
    }

    if (
      is_set_property_action &&
      resolved_task._edit_property_value === undefined
    ) {
      return { _eligible: false, _reason: "missing_property_value" };
    }

    const target_resolution =
      resolveViewTarget(input._current_view, {
        _target_id: target_id,
        _target_text: resolved_task._edit_target_text,
        _target_type: resolved_task._edit_target_type,
        _target_id_text_fallback: true,
        _include_id: Boolean(target_id),
        _allow_root: deterministic_target_type_is_view(resolved_task._edit_target_type),
        _view_id: resolved_task._target_id,
      });
    if (!target_resolution._ok) {
      return {
        _eligible: false,
        _reason: target_resolution._reason === "text_target_not_found"
          ? "target_not_found"
          : target_resolution._reason,
        ...(target_resolution._details !== undefined
          ? { _details: target_resolution._details }
          : {}),
      };
    }

    const resolved_target_id =
      typeof target_resolution.object._id === "string" &&
      target_resolution.object._id.trim()
        ? target_resolution.object._id.trim()
        : target_id;
    const resolved_by =
      deterministic_resolved_by_from_view_target_strategy(
        target_resolution.resolution_strategy,
      );
    const resolved_reason =
      deterministic_reason_from_view_target_strategy(
        target_resolution.resolution_strategy,
      );
    const normalized_property_name =
      deterministic_normalize_property_name_for_target(
        target_resolution.object,
        property_name,
      );
    const property_eligibility =
      deterministic_set_property_eligibility({
        _target_node: target_resolution.object,
        _property_name: normalized_property_name,
        _next_value: resolved_task._edit_property_value,
        _is_set: is_set_property_action,
      });
    if (!property_eligibility._ok) {
      return {
        _eligible: false,
        _reason: property_eligibility._reason ?? "unsupported_property",
        ...(property_eligibility._details !== undefined
          ? { _details: property_eligibility._details }
          : {}),
      };
    }

    return {
      _eligible: true,
      _action: is_set_property_action ? "set-property" : "remove-property",
      _target_id: resolved_target_id,
      _target_path: target_resolution.path,
      _property_name: normalized_property_name,
      _reason: resolved_reason,
      _details: {
        _resolved_by: resolved_by,
        _resolution_strategy: target_resolution.resolution_strategy,
        ...(normalized_property_name !== property_name
          ? { _property_name: normalized_property_name, _requested_property_name: property_name }
          : {}),
      },
    };
  }

  if (resolved_task._edit_action === "set-interaction") {
    const interaction_scope = resolved_task._edit_interaction_scope ?? "_on";
    if (interaction_scope !== "_on" && interaction_scope !== "_once") {
      return {
        _eligible: false,
        _reason: "unsupported_interaction_scope",
        _details: {
          _interaction_scope: interaction_scope,
        },
      };
    }

    const trigger =
      typeof resolved_task._edit_trigger === "string"
        ? resolved_task._edit_trigger.trim()
        : "";
    if (!trigger) {
      return { _eligible: false, _reason: "missing_trigger" };
    }

    if (trigger !== "click") {
      return {
        _eligible: false,
        _reason: "unsupported_trigger",
        _details: {
          _trigger: trigger,
        },
      };
    }

    const has_handler =
      Object.prototype.hasOwnProperty.call(resolved_task, "_edit_handler");
    if (!has_handler) {
      return { _eligible: false, _reason: "missing_handler" };
    }

    const handler_validation =
      deterministic_interaction_handler_validation(resolved_task._edit_handler);
    if (!handler_validation._ok) {
      return {
        _eligible: false,
        _reason: handler_validation._reason,
        ...(handler_validation._details !== undefined
          ? { _details: handler_validation._details }
          : {}),
      };
    }

    const target_resolution =
      resolve_deterministic_view_edit_target({
        _current_view: input._current_view,
        _target_id: target_id,
        _target_text: resolved_task._edit_target_text,
        _target_type: resolved_task._edit_target_type,
        _target_id_text_fallback: Boolean(target_id),
      });
    if (!target_resolution._ok) {
      return {
        _eligible: false,
        _reason: target_resolution._reason,
        ...(target_resolution._details !== undefined
          ? { _details: target_resolution._details }
          : {}),
      };
    }

    const existing_scope = target_resolution._target_node[interaction_scope];
    if (existing_scope !== undefined && !_xu.is_plain_object(existing_scope)) {
      return {
        _eligible: false,
        _reason: "interaction_scope_not_object",
        _details: {
          _target_id: target_resolution._target_id,
          _interaction_scope: interaction_scope,
        },
      };
    }

    return {
      _eligible: true,
      _action: "set-interaction",
      _target_id: target_resolution._target_id,
      _reason: target_resolution._reason,
      _details: {
        _resolved_by: target_resolution._resolved_by,
        _interaction_scope: interaction_scope,
        _trigger: trigger,
      },
    };
  }

  if (resolved_task._edit_action === "bind-flow") {
    const flow =
      resolved_task._edit_flow;
    const flow_id =
      _xu.is_plain_object(flow) && typeof flow._id === "string"
        ? flow._id.trim()
        : "";
    if (!flow_id) {
      return { _eligible: false, _reason: "missing_flow_id" };
    }

    const flow_payload =
      _xu.is_plain_object(flow) && _xu.is_plain_object(flow._payload)
        ? flow._payload
        : {};
    if (!_xu.is_plain_object(flow_payload)) {
      return { _eligible: false, _reason: "invalid_flow_payload" };
    }

    const flow_event =
      typeof resolved_task._edit_flow_event === "string"
        ? resolved_task._edit_flow_event.trim()
        : "click";
    if (!flow_event) {
      return { _eligible: false, _reason: "missing_flow_event" };
    }

    const flow_auto =
      resolved_task._edit_flow_auto;
    if (flow_auto !== undefined && typeof flow_auto !== "boolean") {
      return { _eligible: false, _reason: "invalid_flow_auto" };
    }

    const target_resolution =
      resolveViewTarget(input._current_view, {
        _target_id: target_id,
        _target_text: resolved_task._edit_target_text,
        _target_type: resolved_task._edit_target_type,
        _target_id_text_fallback: true,
        _include_id: Boolean(target_id),
        _view_id: resolved_task._target_id,
      });
    if (!target_resolution._ok) {
      return {
        _eligible: false,
        _reason: target_resolution._reason === "text_target_not_found"
          ? "target_not_found"
          : target_resolution._reason,
        ...(target_resolution._details !== undefined
          ? { _details: target_resolution._details }
          : {}),
      };
    }

    if (target_resolution.object === input._current_view) {
      return {
        _eligible: false,
        _reason: "target_is_root",
        _details: {
          _target_id: target_id,
        },
      };
    }

    const resolved_target_id =
      typeof target_resolution._resolved_target_id === "string" &&
      target_resolution._resolved_target_id.trim()
        ? target_resolution._resolved_target_id.trim()
        : undefined;
    const resolved_target_path =
      target_resolution._resolved_target_path.length > 0
        ? target_resolution._resolved_target_path
        : target_resolution.path;
    if (!resolved_target_id && resolved_target_path.length === 0) {
      return { _eligible: false, _reason: "target_missing_identity" };
    }

    return {
      _eligible: true,
      _action: "bind-flow",
      ...(resolved_target_id ? { _target_id: resolved_target_id } : {}),
      _target_path: resolved_target_path,
      _reason: deterministic_reason_from_view_target_strategy(
        target_resolution.resolution_strategy,
      ),
      _details: {
        _resolved_by: deterministic_resolved_by_from_view_target_strategy(
          target_resolution.resolution_strategy,
        ),
        _resolution_strategy: target_resolution.resolution_strategy,
        _flow_id: flow_id,
        _flow_event: flow_event,
        _flow_auto: flow_auto ?? true,
      },
    };
  }

  if (resolved_task._edit_action === "replace-object") {
    const object_value = input._edit_intent?._object_value;

    if (!_xu.is_plain_object(object_value)) {
      return { _eligible: false, _reason: "missing_object_value" };
    }

    const target_resolution =
      resolve_deterministic_view_edit_target({
        _current_view: input._current_view,
        _target_id: target_id,
        _target_text: resolved_task._edit_target_text,
        _target_type: resolved_task._edit_target_type,
        _target_id_text_fallback: Boolean(target_id),
      });
    if (!target_resolution._ok) {
      return {
        _eligible: false,
        _reason: target_resolution._reason,
        ...(target_resolution._details !== undefined
          ? { _details: target_resolution._details }
          : {}),
      };
    }

    const target_location =
      find_view_node_location_by_id(input._current_view, target_resolution._target_id);
    if (
      !target_location?._parent ||
      !Array.isArray(target_location._children) ||
      typeof target_location._index !== "number"
    ) {
      return {
        _eligible: false,
        _reason: "target_is_root",
        _details: {
          _target_id: target_resolution._target_id,
        },
      };
    }

    const next_id =
      typeof object_value._id === "string" ? object_value._id.trim() : "";
    if (next_id !== target_resolution._target_id) {
      return {
        _eligible: false,
        _reason: "object_id_mismatch",
        _details: {
          _target_id: target_resolution._target_id,
          _object_id: next_id,
        },
      };
    }

    const current_type =
      typeof target_resolution._target_node._type === "string"
        ? target_resolution._target_node._type.trim()
        : "";
    const next_type =
      typeof object_value._type === "string" ? object_value._type.trim() : "";
    const requested_type =
      typeof resolved_task._edit_target_type === "string"
        ? resolved_task._edit_target_type.trim()
        : "";
    const expected_type = requested_type || current_type;

    if (!next_type || (expected_type && next_type !== expected_type)) {
      return {
        _eligible: false,
        _reason: "object_type_mismatch",
        _details: {
          _target_id: target_resolution._target_id,
          _expected_type: expected_type,
          _object_type: next_type,
        },
      };
    }

    if (current_type && next_type !== current_type) {
      return {
        _eligible: false,
        _reason: "object_type_mismatch",
        _details: {
          _target_id: target_resolution._target_id,
          _expected_type: current_type,
          _object_type: next_type,
        },
      };
    }

    return {
      _eligible: true,
      _action: "replace-object",
      _target_id: target_resolution._target_id,
      _reason: target_resolution._reason,
      _details: {
        _resolved_by: target_resolution._resolved_by,
      },
    };
  }

  if (resolved_task._edit_action === "create-toolbar") {
    const existing_toolbar =
      find_existing_toolbar_node(input._current_view);
    const requested_location =
      input._edit_intent?._location ??
      (resolved_task as XVibeJsonObject)._edit_location;
    const location =
      normalize_create_toolbar_location(requested_location);
    if (existing_toolbar) {
      const existing_toolbar_id =
        typeof existing_toolbar._id === "string" && existing_toolbar._id.trim()
          ? existing_toolbar._id.trim()
          : "toolbar";
      return {
        _eligible: true,
        _action: "create-toolbar",
        _target_id: existing_toolbar_id,
        _reason: "already_exists",
        _details: {
          _toolbar_id: existing_toolbar_id,
          _created: false,
          _location: location,
        },
      };
    }

    const toolbar_value =
      synthesized_create_toolbar({
        _view_id: resolved_task._target_id,
        _toolbar_props:
          input._edit_intent?._toolbar_props ??
          (resolved_task as XVibeJsonObject)._edit_toolbar_props,
      });
    const toolbar_id =
      typeof toolbar_value._id === "string" ? toolbar_value._id.trim() : "";
    if (!toolbar_id) {
      return { _eligible: false, _reason: "missing_toolbar_id" };
    }

    if (location === "before" || location === "after") {
      const anchor_id =
        target_id && target_id !== resolved_task._target_id
          ? target_id
          : typeof resolved_task._edit_anchor_id === "string"
            ? resolved_task._edit_anchor_id.trim()
            : "";
      if (!anchor_id && typeof resolved_task._edit_target_text !== "string") {
        return { _eligible: false, _reason: "missing_target_id" };
      }
      const anchor_resolution =
        resolveViewTarget(input._current_view, {
          ...(anchor_id ? { _target_id: anchor_id } : {}),
          _target_text: resolved_task._edit_target_text,
          _target_type: resolved_task._edit_target_type,
          _target_id_text_fallback: true,
          _include_id: true,
          _view_id: resolved_task._target_id,
        });
      if (!anchor_resolution._ok) {
        return {
          _eligible: false,
          _reason: anchor_resolution._reason === "text_target_not_found"
            ? "target_not_found"
            : anchor_resolution._reason,
          ...(anchor_resolution._details !== undefined
            ? { _details: anchor_resolution._details }
            : {}),
        };
      }
      const anchor_target_id =
        typeof anchor_resolution.object._id === "string"
          ? anchor_resolution.object._id.trim()
          : anchor_id;
      const anchor_location =
        find_view_node_location_by_id(input._current_view, anchor_target_id);
      if (
        !anchor_location?._parent ||
        !Array.isArray(anchor_location._children) ||
        typeof anchor_location._index !== "number"
      ) {
        return {
          _eligible: false,
          _reason: "target_is_root",
          _details: {
            _target_id: anchor_target_id,
          },
        };
      }
      return {
        _eligible: true,
        _action: "create-toolbar",
        _target_id:
          typeof anchor_location._parent._id === "string"
            ? anchor_location._parent._id
            : resolved_task._target_id,
        _reason: deterministic_reason_from_view_target_strategy(
          anchor_resolution.resolution_strategy,
        ),
        _details: {
          _resolved_by: deterministic_resolved_by_from_view_target_strategy(
            anchor_resolution.resolution_strategy,
          ),
          _toolbar_id: toolbar_id,
          _created: true,
          _location: location,
          _anchor_id: anchor_target_id,
        },
      };
    }

    const root_target_id =
      resolve_add_child_target_id({
        _current_view: input._current_view,
        _view_id: resolved_task._target_id,
        _target_id: resolved_task._target_id,
      });
    const target_resolution =
      resolveViewTarget(input._current_view, {
        _target_id: root_target_id,
        _target_type: "view",
        _target_id_text_fallback: true,
        _include_id: true,
        _allow_root: true,
        _view_id: resolved_task._target_id,
      });
    if (!target_resolution._ok) {
      return {
        _eligible: false,
        _reason: target_resolution._reason,
        ...(target_resolution._details !== undefined
          ? { _details: target_resolution._details }
          : {}),
      };
    }
    const target_node = target_resolution.object;
    if (!Array.isArray(target_node._children)) {
      return {
        _eligible: false,
        _reason: "target_without_children",
        _details: {
          _target_id:
            typeof target_node._id === "string" ? target_node._id : root_target_id,
        },
      };
    }

    return {
      _eligible: true,
      _action: "create-toolbar",
      _target_id:
        typeof target_node._id === "string" ? target_node._id : root_target_id,
      _reason: "eligible",
      _details: {
        _resolved_by: "id",
        _toolbar_id: toolbar_id,
        _created: true,
        _location: location,
      },
    };
  }

  if (resolved_task._edit_action === "add-child") {
    const resolved_add_target_id =
      resolve_add_child_target_id({
        _current_view: input._current_view,
        _view_id: resolved_task._target_id,
        _target_id: target_id,
      });
    const target_resolution =
      resolveViewTarget(input._current_view, {
        _target_id: resolved_add_target_id,
        _target_type: resolved_task._edit_target_type,
        _target_id_text_fallback: true,
        _include_id: true,
        _allow_root: true,
        _view_id: resolved_task._target_id,
      });
    if (!target_resolution._ok) {
      return {
        _eligible: false,
        _reason: target_resolution._reason,
        ...(target_resolution._details !== undefined
          ? { _details: target_resolution._details }
          : {}),
      };
    }

    const target_node = target_resolution.object;
    if (!Array.isArray(target_node._children)) {
      return {
        _eligible: false,
        _reason: "target_without_children",
        _details: {
          _target_id:
            typeof target_node._id === "string" ? target_node._id : resolved_add_target_id,
        },
      };
    }

    const child_value =
      synthesized_add_child({
        _child: input._edit_intent?._child,
        _component_type:
          input._edit_intent?._component_type ??
          (resolved_task as XVibeJsonObject)._edit_component_type,
        _location:
          input._edit_intent?._location ??
          (resolved_task as XVibeJsonObject)._edit_location,
        _props:
          input._edit_intent?._props ??
          (resolved_task as XVibeJsonObject)._edit_props,
      });

    if (!_xu.is_plain_object(child_value)) {
      return { _eligible: false, _reason: "missing_child" };
    }
    const child_type =
      typeof child_value._type === "string" ? child_value._type.trim() : "";
    if (!child_type) {
      return { _eligible: false, _reason: "missing_child_type" };
    }

    const duplicate_child_id =
      first_duplicate_child_declared_id(child_value);
    if (duplicate_child_id) {
      return {
        _eligible: false,
        _reason: "duplicate_child_id",
        _details: {
        _id: duplicate_child_id,
        },
      };
    }

    return {
      _eligible: true,
      _action: "add-child",
      _target_id:
        typeof target_node._id === "string" ? target_node._id : resolved_add_target_id,
      _reason: target_resolution.resolution_strategy === "id" ||
        target_resolution.resolution_strategy === "root"
        ? "eligible"
        : target_resolution.resolution_strategy === "text"
          ? "eligible_text_match"
          : target_resolution.resolution_strategy === "text_type_id"
            ? "eligible_id_from_text_type"
            : "eligible_normalized_text_match",
      _details: {
        _resolved_by:
          target_resolution.resolution_strategy === "text"
            ? "text"
            : target_resolution.resolution_strategy === "text_type_id"
              ? "text_type_id"
              : target_resolution.resolution_strategy === "normalized_text" ||
                target_resolution.resolution_strategy === "normalized_id"
                ? "normalized_text"
                : "id",
        _resolution_strategy: target_resolution.resolution_strategy,
        _child_type: child_type,
        _previous_index: target_node._children.length,
        _location: normalize_add_child_location(
          input._edit_intent?._location ??
          (resolved_task as XVibeJsonObject)._edit_location,
        ),
      },
    };
  }

  if (resolved_task._edit_action === "move-object") {
    const move_position =
      deterministic_move_object_position(resolved_task);
    if (!move_position) {
      return { _eligible: false, _reason: "missing_move_position" };
    }
    const destination_fields =
      deterministic_move_destination_fields({
        _resolved_task: resolved_task,
        _position: move_position,
      });
    const edit_intent_target_id =
      typeof input._edit_intent?._target_id === "string" &&
      input._edit_intent._target_id.trim()
        ? input._edit_intent._target_id.trim()
        : undefined;
    const resolved_task_target_id =
      typeof resolved_task._edit_target_id === "string" &&
      resolved_task._edit_target_id.trim()
        ? resolved_task._edit_target_id.trim()
        : undefined;

    _xlog.log("[xvibe] move object eligibility input", {
      _target_id: target_id,
      _target_text: resolved_task._edit_target_text,
      _target_type: resolved_task._edit_target_type,
      _destination_id: destination_fields._target_id,
      _edit_intent_target_id: edit_intent_target_id,
      _resolved_task_target_id: resolved_task_target_id,
    });

    const source_candidates: Array<{
      _requested_source: string;
      _target_id?: string;
      _target_text?: string;
      _include_id: boolean;
    }> = [];
    const add_source_candidate = (candidate: {
      _requested_source?: string;
      _target_id?: string;
      _target_text?: string;
      _include_id: boolean;
    }) => {
      const requested_source =
        typeof candidate._requested_source === "string" &&
        candidate._requested_source.trim()
          ? candidate._requested_source.trim()
          : undefined;
      if (!requested_source) return;
      if (source_candidates.some((item) => item._requested_source === requested_source)) {
        return;
      }
      source_candidates.push({
        _requested_source: requested_source,
        ...(candidate._target_id ? { _target_id: candidate._target_id } : {}),
        ...(candidate._target_text ? { _target_text: candidate._target_text } : {}),
        _include_id: candidate._include_id,
      });
    };
    const explicit_target_text =
      typeof resolved_task._edit_target_text === "string" &&
      resolved_task._edit_target_text.trim()
        ? resolved_task._edit_target_text.trim()
        : undefined;
    add_source_candidate({
      _requested_source: explicit_target_text,
      _target_text: explicit_target_text,
      _include_id: false,
    });
    const original_target_id =
      edit_intent_target_id ?? resolved_task_target_id;
    add_source_candidate({
      _requested_source: original_target_id,
      _target_id: original_target_id,
      _include_id: true,
    });
    add_source_candidate({
      _requested_source: target_id,
      _target_id: target_id,
      _include_id: true,
    });

    let requested_source =
      source_candidates[0]?._requested_source ?? target_id ?? "";
    let target_resolution: XVibeViewTargetResolution | undefined;
    for (const candidate of source_candidates) {
      requested_source = candidate._requested_source;
      const resolution =
        resolveViewTarget(input._current_view, {
          _target_id: candidate._target_id,
          _target_text: candidate._target_text,
          _target_type: resolved_task._edit_target_type,
          _target_id_text_fallback: true,
          _include_id: candidate._include_id,
        });
      target_resolution = resolution;
      if (resolution._ok) break;
    }
    target_resolution ??=
      resolveViewTarget(input._current_view, {
        _target_id: target_id,
        _target_text: resolved_task._edit_target_text,
        _target_type: resolved_task._edit_target_type,
        _target_id_text_fallback: true,
        _include_id: Boolean(target_id),
      });
    _xlog.log("[xvibe] move object eligibility resolution", {
      _requested_source: requested_source,
      _ok: target_resolution._ok,
      ...(target_resolution._ok
        ? {
          _resolved_target_id: target_resolution._resolved_target_id,
          _resolved_target_path: target_resolution._resolved_target_path,
          _strategy: target_resolution.resolution_strategy,
        }
        : {
          _reason: target_resolution._reason,
        }),
    });
    if (!target_resolution._ok) {
      return {
        _eligible: false,
        _reason: target_resolution._reason === "text_target_not_found"
          ? "target_not_found"
          : target_resolution._reason,
        ...(target_resolution._details !== undefined
          ? { _details: target_resolution._details }
          : {}),
      };
    }

    if (
      target_resolution.object === input._current_view ||
      !target_resolution.parent ||
      !Array.isArray(target_resolution.parent._children) ||
      typeof target_resolution.index !== "number"
    ) {
      return {
        _eligible: false,
        _reason: "target_is_root",
        _details: {
          _target_id:
            typeof target_resolution.object._id === "string"
              ? target_resolution.object._id
              : target_id,
        },
      };
    }

    const moved_id =
      typeof target_resolution._resolved_target_id === "string" &&
      target_resolution._resolved_target_id.trim()
        ? target_resolution._resolved_target_id.trim()
        : "";
    const moved_path =
      target_resolution._resolved_target_path.length > 0
        ? target_resolution._resolved_target_path
        : target_resolution.path;
    if (!moved_id && moved_path.length === 0) {
      return { _eligible: false, _reason: "target_missing_identity" };
    }

    const source_parent = target_resolution.parent;
    const source_parent_id =
      typeof source_parent._id === "string" ? source_parent._id : undefined;

    if (
      (move_position === "append" || move_position === "prepend") &&
      !destination_fields._target_id &&
      !destination_fields._target_text &&
      !destination_fields._target_type
    ) {
      return {
        _eligible: true,
        _action: "move-object",
        ...(moved_id ? { _target_id: moved_id } : {}),
        _target_path: moved_path,
        _reason: deterministic_reason_from_view_target_strategy(
          target_resolution.resolution_strategy,
        ),
        _details: {
          _resolved_by: deterministic_resolved_by_from_view_target_strategy(
            target_resolution.resolution_strategy,
          ),
          _resolution_strategy: target_resolution.resolution_strategy,
          _position: move_position,
          ...(deterministic_legacy_move_position(resolved_task)
            ? { _move_position: deterministic_legacy_move_position(resolved_task) }
            : {}),
          _source_parent_id: source_parent_id,
          _destination_parent_id: source_parent_id,
          _previous_index: target_resolution.index,
          ...(moved_id ? {} : { _target_missing_id: true }),
        },
      };
    }

    const destination_resolution =
      resolveViewTarget(input._current_view, {
        _target_id: destination_fields._target_id,
        _target_text: destination_fields._target_text,
        _target_type: destination_fields._target_type,
        _target_id_text_fallback: true,
        _include_id: Boolean(destination_fields._target_id),
        _allow_root: move_position === "append" || move_position === "prepend",
        _view_id: resolved_task._target_id,
      });
    if (!destination_resolution._ok) {
      const failure =
        deterministic_move_resolution_failure({
          _resolution: destination_resolution,
          _legacy_anchor: destination_fields._legacy_anchor,
        });
      return {
        _eligible: false,
        _reason: failure._reason,
        ...(failure._details !== undefined
          ? { _details: failure._details }
          : {}),
      };
    }

    if (destination_resolution.object === target_resolution.object) {
      return {
        _eligible: false,
        _reason: "target_is_destination",
        _details: {
          _target_id: moved_id,
        },
      };
    }

    const destination_parent =
      move_position === "append" || move_position === "prepend"
        ? destination_resolution.object
        : destination_resolution.parent;
    const destination_index =
      move_position === "append" || move_position === "prepend"
        ? undefined
        : destination_resolution.index;

    if (
      !destination_parent ||
      !Array.isArray(destination_parent._children) ||
      (
        (move_position === "before" || move_position === "after") &&
        typeof destination_index !== "number"
      )
    ) {
      return {
        _eligible: false,
        _reason:
          move_position === "before" || move_position === "after"
            ? deterministic_move_missing_destination_reason(destination_fields._legacy_anchor)
            : "destination_without_children",
        _details: {
          _destination_id:
            typeof destination_resolution.object._id === "string"
              ? destination_resolution.object._id
              : destination_fields._target_id,
        },
      };
    }

    if (view_node_contains_node(target_resolution.object, destination_parent)) {
      return {
        _eligible: false,
        _reason: "destination_is_descendant",
        _details: {
        _target_id: moved_id,
        _destination_parent_id:
            typeof destination_parent._id === "string"
              ? destination_parent._id
              : undefined,
        },
      };
    }

    const destination_parent_id =
      typeof destination_parent._id === "string" ? destination_parent._id : undefined;
    const destination_id =
      typeof destination_resolution.object._id === "string"
        ? destination_resolution.object._id
        : undefined;

    return {
      _eligible: true,
      _action: "move-object",
      ...(moved_id ? { _target_id: moved_id } : {}),
      _target_path: moved_path,
      _reason: deterministic_reason_from_view_target_strategy(
        target_resolution.resolution_strategy,
      ),
      _details: {
        _resolved_by: deterministic_resolved_by_from_view_target_strategy(
          target_resolution.resolution_strategy,
        ),
        _resolution_strategy: target_resolution.resolution_strategy,
        _position: move_position,
        ...(deterministic_legacy_move_position(resolved_task)
          ? { _move_position: deterministic_legacy_move_position(resolved_task) }
          : {}),
        ...(destination_id ? { _destination_id: destination_id } : {}),
        ...(move_position === "before" || move_position === "after"
          ? {
            _anchor_id: destination_id,
            _anchor_resolved_by: deterministic_resolved_by_from_view_target_strategy(
              destination_resolution.resolution_strategy,
            ),
          }
          : {}),
        _source_parent_id: source_parent_id,
        _destination_parent_id: destination_parent_id,
        _previous_index: target_resolution.index,
        ...(moved_id ? {} : { _target_missing_id: true }),
      },
    };
  }

  if (resolved_task._edit_action === "duplicate-object") {
    const target_resolution =
      resolve_deterministic_view_edit_target({
        _current_view: input._current_view,
        _target_id: target_id,
        _target_text: resolved_task._edit_target_text,
        _target_type: resolved_task._edit_target_type,
      });
    if (!target_resolution._ok) {
      return {
        _eligible: false,
        _reason: target_resolution._reason,
        ...(target_resolution._details !== undefined
          ? { _details: target_resolution._details }
          : {}),
      };
    }

    const target_location =
      find_view_node_location_by_id(input._current_view, target_resolution._target_id);
    if (!target_location?._parent || !Array.isArray(target_location._children)) {
      return {
        _eligible: false,
        _reason: "target_is_root",
        _details: {
          _target_id: target_resolution._target_id,
        },
      };
    }

    const anchor_id = resolved_task._edit_anchor_id;
    if (anchor_id) {
      const anchor_resolution =
        resolve_deterministic_view_edit_target({
          _current_view: input._current_view,
          _target_id: anchor_id,
        });
      if (!anchor_resolution._ok) {
        return {
          _eligible: false,
          _reason: anchor_resolution._reason === "target_not_found" ||
            anchor_resolution._reason === "text_target_not_found" ||
            anchor_resolution._reason === "missing_target_id"
            ? "anchor_not_found"
            : anchor_resolution._reason,
          ...(anchor_resolution._details !== undefined
            ? { _details: anchor_resolution._details }
            : {}),
        };
      }

      const anchor_location =
        find_view_node_location_by_id(input._current_view, anchor_resolution._target_id);
      if (!anchor_location?._parent || !Array.isArray(anchor_location._children)) {
        return {
          _eligible: false,
          _reason: "anchor_not_found",
          _details: {
            _anchor_id: anchor_resolution._target_id,
          },
        };
      }

      if (target_location._parent !== anchor_location._parent) {
        return {
          _eligible: false,
          _reason: "different_parent",
          _details: {
            _target_id: target_resolution._target_id,
            _anchor_id: anchor_resolution._target_id,
          },
        };
      }
    }

    return {
      _eligible: true,
      _action: "duplicate-object",
      _target_id: target_resolution._target_id,
      _reason: target_resolution._reason,
      _details: {
        _resolved_by: target_resolution._resolved_by,
        ...(resolved_task._edit_anchor_id
          ? {
            _anchor_id: resolved_task._edit_anchor_id,
            _move_position: resolved_task._edit_move_position,
          }
          : {}),
        _parent_id: typeof target_location._parent._id === "string"
          ? target_location._parent._id
          : undefined,
        _previous_index: target_location._index,
      },
    };
  }

  if (
    resolved_task._edit_action === "add-class" ||
    resolved_task._edit_action === "remove-class" ||
    resolved_task._edit_action === "toggle-class" ||
    resolved_task._edit_action === "replace-class"
  ) {
    const class_name =
      typeof resolved_task._edit_class_name === "string"
        ? resolved_task._edit_class_name.trim()
        : "";
    const old_class_name =
      typeof resolved_task._edit_old_class_name === "string"
        ? resolved_task._edit_old_class_name.trim()
        : "";
    const new_class_name =
      typeof resolved_task._edit_new_class_name === "string"
        ? resolved_task._edit_new_class_name.trim()
        : "";

    if (
      resolved_task._edit_action === "replace-class" &&
      (!old_class_name || !new_class_name)
    ) {
      return { _eligible: false, _reason: "missing_class_name" };
    }

    if (
      resolved_task._edit_action !== "replace-class" &&
      !class_name
    ) {
      return { _eligible: false, _reason: "missing_class_name" };
    }

    const target_resolution =
      resolve_deterministic_view_edit_target({
        _current_view: input._current_view,
        _target_id: target_id,
        _target_text: resolved_task._edit_target_text,
        _target_type: resolved_task._edit_target_type,
        _target_id_text_fallback: Boolean(target_id),
      });
    if (!target_resolution._ok) {
      return {
        _eligible: false,
        _reason: target_resolution._reason,
        ...(target_resolution._details !== undefined
          ? { _details: target_resolution._details }
          : {}),
      };
    }

    return {
      _eligible: true,
      _action: resolved_task._edit_action,
      _target_id: target_resolution._target_id,
      _reason: target_resolution._reason,
      _details: {
        _resolved_by: target_resolution._resolved_by,
      },
    };
  }

  const target_resolution =
    resolve_deterministic_view_edit_target({
      _current_view: input._current_view,
      _target_id: target_id,
      _target_text: resolved_task._edit_target_text,
      _target_type: resolved_task._edit_target_type,
      _target_id_text_fallback:
        resolved_task._edit_action === "remove" ||
        resolved_task._edit_action === "hide",
    });
  if (!target_resolution._ok) {
    return {
      _eligible: false,
      _reason: target_resolution._reason,
      ...(target_resolution._details !== undefined
        ? { _details: target_resolution._details }
        : {}),
    };
  }

  if (resolved_task._edit_action === "remove") {
    const target_location =
      find_view_node_location_by_id(input._current_view, target_resolution._target_id);
    if (
      !target_location ||
      !target_location._parent ||
      !Array.isArray(target_location._children) ||
      typeof target_location._index !== "number"
    ) {
      return {
        _eligible: false,
        _reason: "target_parent_not_found",
        _details: {
          _target_id: target_resolution._target_id,
        },
      };
    }
  }

  return {
    _eligible: true,
    _action:
      resolved_task._edit_action === "hide"
        ? "hide-object"
        : resolved_task._edit_action === "show"
          ? "show-object"
          : "remove-object",
    _target_id: target_resolution._target_id,
    _reason: target_resolution._reason,
    _details: {
      _resolved_by: target_resolution._resolved_by,
    },
  };
}

function deterministic_view_edit_should_search_references(
  eligibility: XVibeDeterministicViewEditEligibility,
  resolved_task: XVibeResolvedTask,
): boolean {
  if (eligibility._eligible) return false;

  if (
    resolved_task._edit_action === "set-style-class-rule" ||
    resolved_task._edit_action === "remove-style-class-rule"
  ) {
    return false;
  }

  return (
    eligibility._reason === "target_not_found" ||
    eligibility._reason === "text_target_not_found" ||
    eligibility._reason === "missing_target_id" ||
    (
      resolved_task._edit_action === "move-object" &&
      (eligibility._reason === "anchor_not_found" ||
        eligibility._reason === "destination_not_found")
    )
  );
}

function deterministic_view_edit_ambiguity_details(input: {
  _target_view_ids: string[];
  _ambiguous_view_ids?: string[];
}): XVibeJsonObject {
  return {
    _target_view_ids: Array.from(new Set(input._target_view_ids)),
    ...(input._ambiguous_view_ids && input._ambiguous_view_ids.length > 0
      ? { _ambiguous_view_ids: Array.from(new Set(input._ambiguous_view_ids)) }
      : {}),
  };
}

function deterministic_view_edit_is_ambiguous_reason(reason: string): boolean {
  return reason === "ambiguous_text_target" || reason === "ambiguous_normalized_text_target";
}

function resolve_deterministic_view_edit_target_sources(input: {
  _sources: Array<{
    _view_id: string;
    _view: unknown;
    _resolved_via: "current-view" | "xvm-view";
  }>;
  _target_id?: string;
  _target_text?: string;
  _target_type?: string;
}): Array<{
  _view_id: string;
  _resolved_via: "current-view" | "xvm-view";
  _target_id: string;
}> {
  const matches: Array<{
    _view_id: string;
    _resolved_via: "current-view" | "xvm-view";
    _target_id: string;
  }> = [];

  for (const source of input._sources) {
    const resolution =
      resolve_deterministic_view_edit_target({
        _current_view: source._view,
        _target_id: input._target_id,
        _target_text: input._target_text,
        _target_type: input._target_type,
      });
    if (!resolution._ok) continue;

    matches.push({
      _view_id: source._view_id,
      _resolved_via: source._resolved_via,
      _target_id: resolution._target_id,
    });
  }

  return matches;
}

function resolve_deterministic_view_edit_source(input: {
  _requested_view_id: string;
  _current_view: unknown;
  _referenced_views: XVibeReferencedView[];
  _reference_warnings: string[];
  _resolved_task: XVibeResolvedTask;
  _edit_intent?: XVibeViewEditIntent;
}): XVibeDeterministicViewEditSourceResolution {
  const current_eligibility =
    can_apply_deterministic_view_edit({
      _resolved_task: input._resolved_task,
      _current_view: input._current_view,
      _edit_intent: input._edit_intent,
    });

  if (current_eligibility._eligible) {
    return {
      _eligible: true,
      _view_id: input._requested_view_id,
      _view: input._current_view,
      _resolved_via: "current-view",
      _eligibility: current_eligibility,
      _warnings: input._reference_warnings,
    };
  }

  if (
    input._referenced_views.length === 0 ||
    !deterministic_view_edit_should_search_references(current_eligibility, input._resolved_task)
  ) {
    return {
      _eligible: false,
      _eligibility: current_eligibility,
      _warnings: input._reference_warnings,
    };
  }

  const current_move_target_with_missing_anchor =
    input._resolved_task._edit_action === "move-object" &&
    (
      current_eligibility._reason === "anchor_not_found" ||
      current_eligibility._reason === "destination_not_found"
    );
  const referenced_eligible: Array<{
    _view_id: string;
    _view: unknown;
    _eligibility: XVibeDeterministicViewEditEligibility;
  }> = [];
  const ambiguous_view_ids: string[] = [];
  let first_ambiguous_eligibility: XVibeDeterministicViewEditEligibility | undefined;

  for (const referenced_view of input._referenced_views) {
    const eligibility =
      can_apply_deterministic_view_edit({
        _resolved_task: input._resolved_task,
        _current_view: referenced_view._view,
        _edit_intent: input._edit_intent,
      });

    if (eligibility._eligible) {
      referenced_eligible.push({
        _view_id: referenced_view._view_id,
        _view: referenced_view._view,
        _eligibility: eligibility,
      });
      continue;
    }

    if (deterministic_view_edit_is_ambiguous_reason(eligibility._reason)) {
      ambiguous_view_ids.push(referenced_view._view_id);
      first_ambiguous_eligibility ??= eligibility;
    }
  }

  if (
    !current_move_target_with_missing_anchor &&
    (referenced_eligible.length > 1 || (referenced_eligible.length > 0 && ambiguous_view_ids.length > 0))
  ) {
    return {
      _eligible: false,
      _eligibility: {
        _eligible: false,
        _reason: "ambiguous_xvm_view_target",
        _details: deterministic_view_edit_ambiguity_details({
          _target_view_ids: referenced_eligible.map((item) => item._view_id),
          _ambiguous_view_ids: ambiguous_view_ids,
        }),
      },
      _warnings: input._reference_warnings,
    };
  }

  if (!current_move_target_with_missing_anchor && referenced_eligible.length === 1) {
    const source = referenced_eligible[0];
    return {
      _eligible: true,
      _view_id: source._view_id,
      _view: source._view,
      _resolved_via: "xvm-view",
      _eligibility: source._eligibility,
      _warnings: input._reference_warnings,
    };
  }

  if (input._resolved_task._edit_action === "move-object") {
    const sources = [
      {
        _view_id: input._requested_view_id,
        _view: input._current_view,
        _resolved_via: "current-view" as const,
      },
      ...input._referenced_views.map((referenced_view) => ({
        _view_id: referenced_view._view_id,
        _view: referenced_view._view,
        _resolved_via: "xvm-view" as const,
      })),
    ];
    const target_matches =
      resolve_deterministic_view_edit_target_sources({
        _sources: sources,
        _target_id:
          deterministic_edit_target_id({
            _resolved_task: input._resolved_task,
            _edit_intent: input._edit_intent,
          }),
        _target_text: input._resolved_task._edit_target_text,
        _target_type: input._resolved_task._edit_target_type,
      });
    const referenced_target_view_ids =
      target_matches
        .filter((match) => match._resolved_via === "xvm-view")
        .map((match) => match._view_id);
    if (referenced_target_view_ids.length > 1) {
      return {
        _eligible: false,
        _eligibility: {
          _eligible: false,
          _reason: "ambiguous_xvm_view_target",
          _details: deterministic_view_edit_ambiguity_details({
            _target_view_ids: referenced_target_view_ids,
          }),
        },
        _warnings: input._reference_warnings,
      };
    }

    const move_position =
      deterministic_move_object_position(input._resolved_task);
    const destination_fields: {
      _target_id?: string;
      _target_text?: string;
      _target_type?: string;
      _legacy_anchor: boolean;
    } =
      move_position
        ? deterministic_move_destination_fields({
          _resolved_task: input._resolved_task,
          _position: move_position,
        })
        : { _legacy_anchor: true };
    const anchor_matches =
      resolve_deterministic_view_edit_target_sources({
        _sources: sources,
        _target_id: destination_fields._target_id,
        _target_text: destination_fields._target_text,
        _target_type: destination_fields._target_type,
      });

    const target_match_for_source_check =
      current_move_target_with_missing_anchor
        ? target_matches.find((match) => match._resolved_via === "current-view")
        : target_matches.length === 1
          ? target_matches[0]
          : undefined;

    if (
      target_match_for_source_check &&
      anchor_matches.length === 1 &&
      target_match_for_source_check._view_id !== anchor_matches[0]._view_id
    ) {
      return {
        _eligible: false,
        _eligibility: {
          _eligible: false,
          _reason: "different_source_view",
          _details: {
            _target_view_id: target_match_for_source_check._view_id,
            _target_id: target_match_for_source_check._target_id,
            _anchor_view_id: anchor_matches[0]._view_id,
            _anchor_id: anchor_matches[0]._target_id,
            _destination_view_id: anchor_matches[0]._view_id,
            _destination_id: anchor_matches[0]._target_id,
          },
        },
        _warnings: input._reference_warnings,
      };
    }
  }

  if (first_ambiguous_eligibility) {
    return {
      _eligible: false,
      _eligibility: first_ambiguous_eligibility,
      _warnings: input._reference_warnings,
    };
  }

  return {
    _eligible: false,
    _eligibility: current_eligibility,
    _warnings: input._reference_warnings,
  };
}

function resolved_task_is_explicit_view_child_edit(
  resolved_task: XVibeResolvedTask,
): boolean {
  if (
    resolved_task._artifact_type !== "view" ||
    resolved_task._action !== "update" ||
    typeof resolved_task._edit_action !== "string" ||
    resolved_task._edit_action.trim().length === 0
  ) {
    return false;
  }

  return (
    typeof resolved_task._edit_target_id === "string" ||
    typeof resolved_task._edit_target_text === "string" ||
    typeof resolved_task._edit_class_name === "string" ||
    typeof resolved_task._edit_old_class_name === "string" ||
    typeof resolved_task._edit_new_class_name === "string" ||
    typeof resolved_task._edit_style_property === "string" ||
    typeof resolved_task._edit_style_value === "string" ||
    typeof resolved_task._edit_property_name === "string" ||
    Object.prototype.hasOwnProperty.call(resolved_task, "_edit_property_value") ||
    typeof resolved_task._edit_move_position === "string" ||
    typeof (resolved_task as XVibeJsonObject)._edit_position === "string" ||
    typeof resolved_task._edit_anchor_id === "string" ||
    typeof resolved_task._edit_anchor_text === "string" ||
    typeof resolved_task._edit_anchor_type === "string" ||
    typeof (resolved_task as XVibeJsonObject)._edit_destination_id === "string" ||
    typeof (resolved_task as XVibeJsonObject)._edit_destination_text === "string" ||
    typeof (resolved_task as XVibeJsonObject)._edit_destination_type === "string"
  );
}

export function apply_deterministic_view_edit(input: {
  _resolved_task: XVibeResolvedTask;
  _current_view: unknown;
  _edit_intent?: XVibeViewEditIntent;
}): XVibeDeterministicViewEditResult {
  const eligibility =
    can_apply_deterministic_view_edit({
      _resolved_task: input._resolved_task,
      _current_view: input._current_view,
      _edit_intent: input._edit_intent,
    });
  if (!eligibility._eligible) {
    return {
      _ok: false,
      _reason: eligibility._reason,
      ...(eligibility._details !== undefined
        ? { _details: eligibility._details }
        : {}),
    };
  }

  if (
    !eligibility._target_id &&
    eligibility._action !== "set-style-class-rule" &&
    eligibility._action !== "remove-style-class-rule" &&
    eligibility._action !== "set-property" &&
    eligibility._action !== "remove-property" &&
    eligibility._action !== "move-object" &&
    eligibility._action !== "bind-flow"
  ) {
    return {
      _ok: false,
      _reason: "unsupported_edit_action",
      _details: eligibility,
    };
  }

  const next_view =
    clone_deterministic_view_json(input._current_view);

  if (eligibility._action === "create-toolbar") {
    const requested_location =
      input._edit_intent?._location ??
      (input._resolved_task as XVibeJsonObject)._edit_location;
    const location =
      normalize_create_toolbar_location(requested_location);
    const existing_toolbar =
      find_existing_toolbar_node(next_view);
    if (existing_toolbar) {
      const existing_toolbar_id =
        typeof existing_toolbar._id === "string" && existing_toolbar._id.trim()
          ? existing_toolbar._id.trim()
          : "toolbar";
      return {
        _ok: true,
        _view: next_view,
        _mutation: {
          _type: "deterministic-view-edit",
          _action: "create-toolbar",
          _target_id: existing_toolbar_id,
          _resolved_by: "id",
          _toolbar_id: existing_toolbar_id,
          _created: false,
          _location: location,
          _reason: "already_exists",
        },
      };
    }

    const toolbar_value =
      synthesized_create_toolbar({
        _view_id: input._resolved_task._target_id,
        _toolbar_props:
          input._edit_intent?._toolbar_props ??
          (input._resolved_task as XVibeJsonObject)._edit_toolbar_props,
      });
    const duplicate_child_id =
      first_duplicate_child_declared_id(toolbar_value);
    if (duplicate_child_id) {
      return {
        _ok: false,
        _reason: "duplicate_child_id",
        _details: {
          _id: duplicate_child_id,
        },
      };
    }

    const used_ids = new Set(
      collect_view_nodes(next_view)
        .map((node) => typeof node._id === "string" ? node._id.trim() : "")
        .filter((id) => id.length > 0),
    );
    const next_toolbar =
      normalize_added_child_ids({
        _child: toolbar_value,
        _used_ids: used_ids,
      });
    const toolbar_id =
      typeof next_toolbar._id === "string" ? next_toolbar._id : "";

    let parent_id = eligibility._target_id;
    let insert_index = 0;
    let anchor_id: string | undefined;
    let children: unknown[] | undefined;

    if (location === "before" || location === "after") {
      const target_id =
        deterministic_edit_target_id({
          _resolved_task: input._resolved_task,
          _edit_intent: input._edit_intent,
        });
      const requested_anchor_id =
        target_id && target_id !== input._resolved_task._target_id
          ? target_id
          : typeof input._resolved_task._edit_anchor_id === "string"
            ? input._resolved_task._edit_anchor_id.trim()
            : "";
      const anchor_resolution =
        resolveViewTarget(next_view, {
          ...(requested_anchor_id ? { _target_id: requested_anchor_id } : {}),
          _target_text: input._resolved_task._edit_target_text,
          _target_type: input._resolved_task._edit_target_type,
          _target_id_text_fallback: true,
          _include_id: true,
          _view_id: input._resolved_task._target_id,
        });
      if (!anchor_resolution._ok) {
        return {
          _ok: false,
          _reason: anchor_resolution._reason,
          ...(anchor_resolution._details !== undefined
            ? { _details: anchor_resolution._details }
            : {}),
        };
      }
      const resolved_anchor_id =
        typeof anchor_resolution.object._id === "string"
          ? anchor_resolution.object._id.trim()
          : requested_anchor_id;
      const anchor_location =
        find_view_node_location_by_id(next_view, resolved_anchor_id);
      if (
        !anchor_location?._parent ||
        !Array.isArray(anchor_location._children) ||
        typeof anchor_location._index !== "number"
      ) {
        return {
          _ok: false,
          _reason: "target_is_root",
          _details: {
            _target_id: resolved_anchor_id,
          },
        };
      }
      anchor_id = resolved_anchor_id;
      parent_id =
        typeof anchor_location._parent._id === "string"
          ? anchor_location._parent._id
          : parent_id;
      children = anchor_location._children;
      insert_index =
        location === "before"
          ? anchor_location._index
          : anchor_location._index + 1;
    } else {
      const target_resolution =
        resolveViewTarget(next_view, {
          _target_id: eligibility._target_id,
          _allow_root: true,
        });
      if (!target_resolution._ok) {
        return {
          _ok: false,
          _reason: target_resolution._reason,
          ...(target_resolution._details !== undefined
            ? { _details: target_resolution._details }
            : {}),
        };
      }
      const target_node = target_resolution.object;
      if (!Array.isArray(target_node._children)) {
        return {
          _ok: false,
          _reason: "target_without_children",
          _details: {
            _target_id: eligibility._target_id,
          },
        };
      }
      children = target_node._children;
      parent_id =
        typeof target_node._id === "string" ? target_node._id : parent_id;
      insert_index =
        location === "top" ? 0 : target_node._children.length;
    }

    children.splice(insert_index, 0, next_toolbar);

    return {
      _ok: true,
      _view: next_view,
      _mutation: {
        _type: "deterministic-view-edit",
        _action: "create-toolbar",
        _target_id: parent_id,
        _resolved_by: deterministic_resolved_by_from_eligibility(eligibility),
        _parent_id: parent_id,
        _insert_index: insert_index,
        _location: location,
        ...(anchor_id ? { _anchor_id: anchor_id } : {}),
        _toolbar_id: toolbar_id,
        _created: true,
        _child_id: toolbar_id,
        _child_type: "toolbar",
        _next_object: next_toolbar,
      },
    };
  }

  if (eligibility._action === "set-interaction") {
    const target_node =
      find_view_node_by_id(next_view, eligibility._target_id);
    if (!target_node) {
      return {
        _ok: false,
        _reason: "target_not_found",
        _details: {
          _target_id: eligibility._target_id,
        },
      };
    }

    const interaction_scope =
      deterministic_interaction_scope(input._resolved_task._edit_interaction_scope);
    const trigger =
      typeof input._resolved_task._edit_trigger === "string"
        ? input._resolved_task._edit_trigger.trim()
        : "";
    if (trigger !== "click") {
      return {
        _ok: false,
        _reason: trigger ? "unsupported_trigger" : "missing_trigger",
        ...(trigger ? { _details: { _trigger: trigger } } : {}),
      };
    }

    const handler = input._resolved_task._edit_handler;
    const handler_validation =
      deterministic_interaction_handler_validation(handler);
    if (!handler_validation._ok) {
      return {
        _ok: false,
        _reason: handler_validation._reason,
        ...(handler_validation._details !== undefined
          ? { _details: handler_validation._details }
          : {}),
      };
    }

    const existing_scope = target_node[interaction_scope];
    if (existing_scope !== undefined && !_xu.is_plain_object(existing_scope)) {
      return {
        _ok: false,
        _reason: "interaction_scope_not_object",
        _details: {
          _target_id: eligibility._target_id,
          _interaction_scope: interaction_scope,
        },
      };
    }

    const previous_handler =
      _xu.is_plain_object(existing_scope)
        ? existing_scope[trigger]
        : undefined;

    if (handler === null) {
      if (_xu.is_plain_object(existing_scope)) {
        delete existing_scope[trigger];
        if (Object.keys(existing_scope).length === 0) {
          delete target_node[interaction_scope];
        }
      }

      return {
        _ok: true,
        _view: next_view,
        _mutation: {
          _type: "deterministic-view-edit",
          _action: "set-interaction",
          _target_id: eligibility._target_id,
          _resolved_by: deterministic_resolved_by_from_eligibility(eligibility),
          _interaction_scope: interaction_scope,
          _trigger: trigger,
          _handler_removed: true,
          ...(previous_handler !== undefined ? { _previous_object: previous_handler } : {}),
        },
      };
    }

    if (!_xu.is_plain_object(handler)) {
      return { _ok: false, _reason: "invalid_handler" };
    }

    const next_handler =
      clone_deterministic_view_json(handler) as XVibeJsonObject;
    const next_scope =
      _xu.is_plain_object(existing_scope) ? existing_scope : {};
    next_scope[trigger] = next_handler;
    target_node[interaction_scope] = next_scope;

    return {
      _ok: true,
      _view: next_view,
      _mutation: {
        _type: "deterministic-view-edit",
        _action: "set-interaction",
        _target_id: eligibility._target_id,
        _resolved_by: deterministic_resolved_by_from_eligibility(eligibility),
        _interaction_scope: interaction_scope,
        _trigger: trigger,
        _handler_removed: false,
        _handler_module: next_handler._module as string,
        _handler_op: next_handler._op as string,
        ...(previous_handler !== undefined ? { _previous_object: previous_handler } : {}),
        _next_object: next_handler,
      },
    };
  }

  if (eligibility._action === "bind-flow") {
    const flow =
      input._resolved_task._edit_flow;
    const flow_id =
      _xu.is_plain_object(flow) && typeof flow._id === "string"
        ? flow._id.trim()
        : "";
    if (!flow_id) {
      return { _ok: false, _reason: "missing_flow_id" };
    }

    const flow_payload =
      _xu.is_plain_object(flow) && _xu.is_plain_object(flow._payload)
        ? flow._payload
        : {};
    if (!_xu.is_plain_object(flow_payload)) {
      return { _ok: false, _reason: "invalid_flow_payload" };
    }

    const flow_event =
      typeof input._resolved_task._edit_flow_event === "string" &&
      input._resolved_task._edit_flow_event.trim()
        ? input._resolved_task._edit_flow_event.trim()
        : "click";
    const flow_auto =
      typeof input._resolved_task._edit_flow_auto === "boolean"
        ? input._resolved_task._edit_flow_auto
        : true;
    const requested_target_id =
      typeof input._resolved_task._edit_target_id === "string" &&
      input._resolved_task._edit_target_id.trim()
        ? input._resolved_task._edit_target_id.trim()
        : eligibility._target_id;
    const target_resolution =
      resolveViewTarget(next_view, {
        _target_id: requested_target_id,
        _target_text: input._resolved_task._edit_target_text,
        _target_type: input._resolved_task._edit_target_type,
        _target_id_text_fallback: true,
        _include_id: Boolean(requested_target_id),
        _view_id: input._resolved_task._target_id,
      });
    if (!target_resolution._ok) {
      return {
        _ok: false,
        _reason: target_resolution._reason === "text_target_not_found"
          ? "target_not_found"
          : target_resolution._reason,
        ...(target_resolution._details !== undefined
          ? { _details: target_resolution._details }
          : {}),
      };
    }

    const resolved_target_id =
      typeof target_resolution._resolved_target_id === "string" &&
      target_resolution._resolved_target_id.trim()
        ? target_resolution._resolved_target_id.trim()
        : undefined;
    const resolved_target_path =
      target_resolution._resolved_target_path.length > 0
        ? target_resolution._resolved_target_path
        : target_resolution.path;
    const eligibility_path = eligibility._target_path ?? [];
    const target_identity_matches =
      eligibility._target_id
        ? resolved_target_id === eligibility._target_id
        : JSON.stringify(resolved_target_path) === JSON.stringify(eligibility_path);
    if (!target_identity_matches) {
      return {
        _ok: false,
        _reason: "target_resolution_mismatch",
        _details: {
          _eligibility_target_id: eligibility._target_id,
          _eligibility_target_path: eligibility_path,
          _execution_target_id: resolved_target_id,
          _execution_target_path: resolved_target_path,
        },
      };
    }

    const target_node = target_resolution.object;
    if (target_node === next_view) {
      return {
        _ok: false,
        _reason: "target_is_root",
        _details: {
          _target_id: eligibility._target_id,
        },
      };
    }

    const previous_flow =
      target_node._flow;
    const previous_flow_event =
      target_node._flow_event;
    const previous_flow_auto =
      target_node._flow_auto;
    const next_flow = {
      _id: flow_id,
      _payload: clone_deterministic_view_json(flow_payload) as XVibeJsonObject,
    };
    target_node._flow = next_flow;
    target_node._flow_event = flow_event;
    target_node._flow_auto = flow_auto;

    return {
      _ok: true,
      _view: next_view,
      _mutation: {
        _type: "deterministic-view-edit",
        _action: "bind-flow",
        ...(resolved_target_id ? { _target_id: resolved_target_id } : {}),
        ...(resolved_target_id ? {} : { _target_path: resolved_target_path }),
        _resolved_by: deterministic_resolved_by_from_eligibility(eligibility),
        _flow: next_flow,
        _flow_event: flow_event,
        _flow_auto: flow_auto,
        _previous_object: {
          ...(previous_flow !== undefined ? { _flow: previous_flow } : {}),
          ...(previous_flow_event !== undefined ? { _flow_event: previous_flow_event } : {}),
          ...(previous_flow_auto !== undefined ? { _flow_auto: previous_flow_auto } : {}),
        },
      },
    };
  }

  if (eligibility._action === "add-child") {
    const target_resolution =
      resolveViewTarget(next_view, {
        _target_id: eligibility._target_id,
        _allow_root: true,
      });
    if (!target_resolution._ok) {
      return {
        _ok: false,
        _reason: target_resolution._reason,
        ...(target_resolution._details !== undefined
          ? { _details: target_resolution._details }
          : {}),
      };
    }

    const target_node = target_resolution.object;
    if (!Array.isArray(target_node._children)) {
      return {
        _ok: false,
        _reason: "target_without_children",
        _details: {
          _target_id: eligibility._target_id,
        },
      };
    }

    const child_value =
      synthesized_add_child({
        _child: input._edit_intent?._child,
        _component_type:
          input._edit_intent?._component_type ??
          (input._resolved_task as XVibeJsonObject)._edit_component_type,
        _location:
          input._edit_intent?._location ??
          (input._resolved_task as XVibeJsonObject)._edit_location,
        _props:
          input._edit_intent?._props ??
          (input._resolved_task as XVibeJsonObject)._edit_props,
      });
    if (!_xu.is_plain_object(child_value)) {
      return { _ok: false, _reason: "missing_child" };
    }

    const child_type =
      typeof child_value._type === "string" ? child_value._type.trim() : "";
    if (!child_type) {
      return { _ok: false, _reason: "missing_child_type" };
    }

    const duplicate_child_id =
      first_duplicate_child_declared_id(child_value);
    if (duplicate_child_id) {
      return {
        _ok: false,
        _reason: "duplicate_child_id",
        _details: {
          _id: duplicate_child_id,
        },
      };
    }

    const existing_identical_child =
      existing_identical_child_by_id({
        _parent: target_node,
        _child: child_value,
      });
    if (existing_identical_child) {
      const child_id =
        typeof existing_identical_child._id === "string"
          ? existing_identical_child._id
          : "";
      return {
        _ok: true,
        _view: next_view,
        _mutation: {
          _type: "deterministic-view-edit",
          _action: "add-child",
          _target_id: eligibility._target_id,
          _resolved_by: deterministic_resolved_by_from_eligibility(eligibility),
          _parent_id: eligibility._target_id,
          _insert_index: target_node._children.indexOf(existing_identical_child),
          _location: normalize_add_child_location(
            input._edit_intent?._location ??
            (input._resolved_task as XVibeJsonObject)._edit_location,
          ),
          _child_id: child_id,
          _child_type: child_type,
          _next_object: existing_identical_child,
          _created: false,
          _reason: "already_exists",
        },
      };
    }

    const used_ids = new Set(
      collect_view_nodes(next_view)
        .map((node) => typeof node._id === "string" ? node._id.trim() : "")
        .filter((id) => id.length > 0),
    );
    const next_child =
      normalize_added_child_ids({
        _child: child_value,
        _used_ids: used_ids,
      });
    const child_id =
      typeof next_child._id === "string" ? next_child._id : "";
    const insert_location =
      normalize_add_child_location(
        input._edit_intent?._location ??
        (input._resolved_task as XVibeJsonObject)._edit_location,
      );
    const insert_index =
      insert_location === "top" ? 0 : target_node._children.length;
    target_node._children.splice(insert_index, 0, next_child);

    return {
      _ok: true,
      _view: next_view,
      _mutation: {
        _type: "deterministic-view-edit",
        _action: "add-child",
        _target_id: eligibility._target_id,
        _resolved_by: deterministic_resolved_by_from_eligibility(eligibility),
        _parent_id: eligibility._target_id,
        _insert_index: insert_index,
        _location: insert_location,
        _child_id: child_id,
        _child_type: child_type,
        _next_object: next_child,
      },
    };
  }

  if (eligibility._action === "duplicate-object") {
    const target_location =
      find_view_node_location_by_id(next_view, eligibility._target_id);
    if (
      !target_location?._parent ||
      !Array.isArray(target_location._children) ||
      typeof target_location._index !== "number"
    ) {
      return {
        _ok: false,
        _reason: "target_is_root",
        _details: {
          _target_id: eligibility._target_id,
        },
      };
    }

    const siblings = target_location._children;
    const previous_index = target_location._index;
    const move_position = input._resolved_task._edit_move_position;
    const anchor_id = input._resolved_task._edit_anchor_id;
    let insert_index = previous_index + 1;

    if (anchor_id) {
      const anchor_location =
        find_view_node_location_by_id(next_view, anchor_id);
      if (
        !anchor_location?._parent ||
        !Array.isArray(anchor_location._children) ||
        typeof anchor_location._index !== "number"
      ) {
        return {
          _ok: false,
          _reason: "anchor_not_found",
          _details: {
            _anchor_id: anchor_id,
          },
        };
      }

      if (anchor_location._parent !== target_location._parent) {
        return {
          _ok: false,
          _reason: "different_parent",
          _details: {
            _target_id: eligibility._target_id,
            _anchor_id: anchor_id,
          },
        };
      }

      insert_index =
        move_position === "before"
          ? anchor_location._index
          : anchor_location._index + 1;
    }

    if (insert_index < 0) insert_index = 0;
    if (insert_index > siblings.length) insert_index = siblings.length;

    const used_ids = new Set(
      collect_view_nodes(next_view)
        .map((node) => typeof node._id === "string" ? node._id.trim() : "")
        .filter((id) => id.length > 0),
    );
    const duplicate_node =
      clone_deterministic_duplicate_subtree(target_location._node, used_ids);
    const new_target_id =
      typeof duplicate_node._id === "string" ? duplicate_node._id : "";
    siblings.splice(insert_index, 0, duplicate_node);

    return {
      _ok: true,
      _view: next_view,
      _mutation: {
        _type: "deterministic-view-edit",
        _action: "duplicate-object",
        _target_id: eligibility._target_id,
        _original_target_id: eligibility._target_id,
        _new_target_id: new_target_id,
        _resolved_by: deterministic_resolved_by_from_eligibility(eligibility),
        ...(move_position === "before" && anchor_id ? { _before_id: anchor_id } : {}),
        ...(move_position === "after" && anchor_id ? { _after_id: anchor_id } : {}),
        ...(typeof target_location._parent._id === "string"
          ? { _parent_id: target_location._parent._id }
          : {}),
        _previous_index: previous_index,
        _next_index: insert_index,
        _insert_index: insert_index,
      },
    };
  }

  if (eligibility._action === "replace-object") {
    const object_value = input._edit_intent?._object_value;
    if (!_xu.is_plain_object(object_value)) {
      return { _ok: false, _reason: "missing_object_value" };
    }

    const target_location =
      find_view_node_location_by_id(next_view, eligibility._target_id);
    if (
      !target_location?._parent ||
      !Array.isArray(target_location._children) ||
      typeof target_location._index !== "number"
    ) {
      return {
        _ok: false,
        _reason: "target_is_root",
        _details: {
          _target_id: eligibility._target_id,
        },
      };
    }

    const next_object =
      clone_deterministic_view_json(object_value) as XVibeJsonObject;
    target_location._children[target_location._index] = next_object;

    return {
      _ok: true,
      _view: next_view,
      _mutation: {
        _type: "deterministic-view-edit",
        _action: "replace-object",
        _target_id: eligibility._target_id,
        _resolved_by: deterministic_resolved_by_from_eligibility(eligibility),
        ...(typeof target_location._parent._id === "string"
          ? { _parent_id: target_location._parent._id }
          : {}),
        _previous_index: target_location._index,
        _next_index: target_location._index,
        _previous_object: target_location._node,
        _next_object: next_object,
      },
    };
  }

  if (eligibility._action === "move-object") {
    const move_position =
      deterministic_move_object_position(input._resolved_task);
    if (!move_position) {
      return { _ok: false, _reason: "missing_move_position" };
    }

    const requested_target =
      typeof input._resolved_task._edit_target_text === "string" &&
      input._resolved_task._edit_target_text.trim()
        ? input._resolved_task._edit_target_text.trim()
        : typeof input._resolved_task._edit_target_id === "string" &&
          input._resolved_task._edit_target_id.trim()
          ? input._resolved_task._edit_target_id.trim()
          : eligibility._target_id;
    const requested_target_id =
      typeof input._resolved_task._edit_target_id === "string" &&
      input._resolved_task._edit_target_id.trim()
        ? input._resolved_task._edit_target_id.trim()
        : eligibility._target_id;
    let target_resolution =
      resolveViewTarget(next_view, {
        _target_id: requested_target_id,
        _target_text: input._resolved_task._edit_target_text,
        _target_type: input._resolved_task._edit_target_type,
        _target_id_text_fallback: true,
        _include_id: true,
      });
    if (!target_resolution._ok && requested_target_id !== eligibility._target_id) {
      target_resolution =
        resolveViewTarget(next_view, {
          _target_id: eligibility._target_id,
          _target_text: input._resolved_task._edit_target_text,
          _target_type: input._resolved_task._edit_target_type,
          _target_id_text_fallback: true,
          _include_id: true,
        });
    }
    if (!target_resolution._ok) {
      return {
        _ok: false,
        _reason: target_resolution._reason === "text_target_not_found"
          ? "target_not_found"
          : target_resolution._reason,
        ...(target_resolution._details !== undefined
          ? { _details: target_resolution._details }
          : {}),
      };
    }
    _xlog.log("[xvibe] move object source resolved", {
      _requested_target: requested_target,
      _resolved_target_id: target_resolution._resolved_target_id,
      _resolved_target_path: target_resolution._resolved_target_path,
      _strategy: target_resolution.resolution_strategy,
    });

    if (
      target_resolution.object === next_view ||
      !target_resolution.parent ||
      !Array.isArray(target_resolution.parent._children) ||
      typeof target_resolution.index !== "number"
    ) {
      return {
        _ok: false,
        _reason: "target_is_root",
        _details: {
          _target_id: eligibility._target_id,
        },
      };
    }

    const moved_id =
      typeof target_resolution._resolved_target_id === "string" &&
      target_resolution._resolved_target_id.trim()
        ? target_resolution._resolved_target_id.trim()
        : undefined;
    const moved_path =
      target_resolution._resolved_target_path.length > 0
        ? target_resolution._resolved_target_path
        : target_resolution.path;
    const eligibility_path = eligibility._target_path ?? [];
    const target_identity_matches =
      eligibility._target_id
        ? moved_id === eligibility._target_id
        : JSON.stringify(moved_path) === JSON.stringify(eligibility_path);
    if (!target_identity_matches) {
      return {
        _ok: false,
        _reason: "target_resolution_mismatch",
        _details: {
          _eligibility_target_id: eligibility._target_id,
          _eligibility_target_path: eligibility_path,
          _execution_target_id: moved_id,
          _execution_target_path: moved_path,
          _requested_target: requested_target,
        },
      };
    }
    const source_parent = target_resolution.parent;
    const source_children = source_parent._children as XVibeJsonObject[];
    const previous_index = target_resolution.index;
    const source_parent_id =
      typeof source_parent._id === "string" ? source_parent._id : undefined;
    const destination_fields =
      deterministic_move_destination_fields({
        _resolved_task: input._resolved_task,
        _position: move_position,
      });
    let destination_parent: XVibeJsonObject = source_parent;
    let destination_index: number | undefined;
    let destination_id: string | undefined;
    let destination_resolved_by:
      | "id"
      | "text"
      | "normalized_text"
      | "text_type_id"
      | undefined;

    if (
      destination_fields._target_id ||
      destination_fields._target_text ||
      destination_fields._target_type
    ) {
      const requested_destination =
        destination_fields._target_text ??
        destination_fields._target_id ??
        destination_fields._target_type;
      const destination_resolution =
        resolveViewTarget(next_view, {
          _target_id: destination_fields._target_id,
          _target_text: destination_fields._target_text,
          _target_type: destination_fields._target_type,
          _target_id_text_fallback: true,
          _include_id: Boolean(destination_fields._target_id),
          _allow_root: move_position === "append" || move_position === "prepend",
          _view_id: input._resolved_task._target_id,
        });
      if (!destination_resolution._ok) {
        const failure =
          deterministic_move_resolution_failure({
            _resolution: destination_resolution,
            _legacy_anchor: destination_fields._legacy_anchor,
          });
        return {
          _ok: false,
          _reason: failure._reason,
          ...(failure._details !== undefined
            ? { _details: failure._details }
            : {}),
        };
      }
      _xlog.log("[xvibe] move object destination resolved", {
        _requested_destination: requested_destination,
        _resolved_destination_id: destination_resolution._resolved_target_id,
        _resolved_destination_path: destination_resolution._resolved_target_path,
        _strategy: destination_resolution.resolution_strategy,
      });

      if (destination_resolution.object === target_resolution.object) {
        return {
          _ok: false,
          _reason: "target_is_destination",
          _details: {
            _target_id: moved_id,
          },
        };
      }

      if (
        (move_position === "append" || move_position === "prepend") &&
        !Array.isArray(destination_resolution.object._children)
      ) {
        return {
          _ok: false,
          _reason: "destination_without_children",
          _details: {
            _destination_id:
              typeof destination_resolution.object._id === "string"
                ? destination_resolution.object._id
                : destination_fields._target_id,
          },
        };
      }

      destination_parent =
        move_position === "append" || move_position === "prepend"
          ? destination_resolution.object
          : destination_resolution.parent as XVibeJsonObject;
      destination_index =
        move_position === "append" || move_position === "prepend"
          ? undefined
          : destination_resolution.index;
      destination_id =
        typeof destination_resolution.object._id === "string"
          ? destination_resolution.object._id
          : undefined;
      destination_resolved_by =
        deterministic_resolved_by_from_view_target_strategy(
          destination_resolution.resolution_strategy,
        );

      if (
        !destination_parent ||
        !Array.isArray(destination_parent._children) ||
        (
          (move_position === "before" || move_position === "after") &&
          typeof destination_index !== "number"
        )
      ) {
        return {
          _ok: false,
          _reason:
            move_position === "before" || move_position === "after"
              ? deterministic_move_missing_destination_reason(destination_fields._legacy_anchor)
              : "destination_without_children",
          _details: {
            _destination_id: destination_id ?? destination_fields._target_id,
          },
        };
      }
    }

    if (view_node_contains_node(target_resolution.object, destination_parent)) {
      return {
        _ok: false,
        _reason: "destination_is_descendant",
        _details: {
          _target_id: moved_id,
          _destination_parent_id:
            typeof destination_parent._id === "string"
              ? destination_parent._id
              : undefined,
        },
      };
    }

    let next_index: number;
    const destination_children =
      destination_parent._children as XVibeJsonObject[];

    if (move_position === "prepend") {
      next_index = 0;
    } else if (move_position === "append") {
      next_index = destination_children.length;
    } else {
      next_index = destination_index ?? 0;
      if (move_position === "after") {
        next_index += 1;
      }
    }

    if (source_parent === destination_parent && previous_index < next_index) {
      next_index -= 1;
    }

    const [target_node] = source_children.splice(previous_index, 1);
    if (next_index < 0) next_index = 0;
    if (next_index > destination_children.length) {
      next_index = destination_children.length;
    }
    destination_children.splice(next_index, 0, target_node);

    const destination_parent_id =
      typeof destination_parent._id === "string" ? destination_parent._id : undefined;
    const legacy_move_position =
      deterministic_legacy_move_position(input._resolved_task);

    return {
      _ok: true,
      _view: next_view,
      _mutation: {
        _type: "deterministic-view-edit",
        _action: "move-object",
        ...(moved_id ? { _target_id: moved_id, _moved_id: moved_id } : {}),
        ...(moved_id ? {} : { _target_path: moved_path }),
        _resolved_by: deterministic_resolved_by_from_eligibility(eligibility),
        _position: move_position,
        ...(legacy_move_position ? { _move_position: legacy_move_position } : {}),
        ...(destination_id ? { _destination_id: destination_id } : {}),
        ...(move_position === "before" && destination_id ? { _anchor_id: destination_id, _before_id: destination_id } : {}),
        ...(move_position === "after" && destination_id ? { _anchor_id: destination_id, _after_id: destination_id } : {}),
        ...(destination_resolved_by ? { _anchor_resolved_by: destination_resolved_by } : {}),
        ...(destination_parent_id
          ? { _parent_id: destination_parent_id }
          : {}),
        ...(source_parent_id ? { _source_parent_id: source_parent_id } : {}),
        ...(destination_parent_id ? { _destination_parent_id: destination_parent_id } : {}),
        _previous_index: previous_index,
        _next_index: next_index,
      },
    };
  }

  if (
    eligibility._action === "set-style-class-rule" ||
    eligibility._action === "remove-style-class-rule"
  ) {
    const class_name =
      typeof input._resolved_task._edit_class_name === "string"
        ? input._resolved_task._edit_class_name.trim()
        : "";
    const style_property =
      typeof input._resolved_task._edit_style_property === "string"
        ? input._resolved_task._edit_style_property.trim()
        : "";
    const style_value =
      typeof input._resolved_task._edit_style_value === "string"
        ? input._resolved_task._edit_style_value.trim()
        : "";

    if (!class_name) {
      return { _ok: false, _reason: "missing_class_name" };
    }

    if (!style_property) {
      return { _ok: false, _reason: "missing_style_property" };
    }

    if (eligibility._action === "set-style-class-rule" && !style_value) {
      return { _ok: false, _reason: "missing_style_value" };
    }

    const style_sheet =
      find_first_inline_style_sheet_node(next_view);
    if (!style_sheet) {
      return { _ok: false, _reason: "missing_inline_style_classes" };
    }

    const classes = style_sheet._classes as XVibeJsonObject;
    const existing_rule = classes[class_name];
    if (existing_rule !== undefined && !_xu.is_plain_object(existing_rule)) {
      return {
        _ok: false,
        _reason: "class_rule_not_object",
        _details: {
          _class_name: class_name,
        },
      };
    }

    if (eligibility._action === "set-style-class-rule") {
      const class_rule =
        _xu.is_plain_object(existing_rule) ? existing_rule : {};
      const previous_value = class_rule[style_property];
      class_rule[style_property] = style_value;
      classes[class_name] = class_rule;

      return {
        _ok: true,
        _view: next_view,
        _mutation: {
          _type: "deterministic-view-edit",
          _action: "set-style-class-rule",
          _class_name: class_name,
          _style_property: style_property,
          ...(previous_value !== undefined ? { _previous_value: previous_value } : {}),
          _next_value: style_value,
        },
      };
    }

    const class_rule =
      _xu.is_plain_object(existing_rule) ? existing_rule : undefined;
    const previous_value = class_rule?.[style_property];
    if (class_rule) {
      delete class_rule[style_property];
      if (Object.keys(class_rule).length === 0) {
        delete classes[class_name];
      }
    }

    return {
      _ok: true,
      _view: next_view,
      _mutation: {
        _type: "deterministic-view-edit",
        _action: "remove-style-class-rule",
        _class_name: class_name,
        _style_property: style_property,
        ...(previous_value !== undefined ? { _previous_value: previous_value } : {}),
      },
    };
  }

  if (eligibility._action === "set-property" || eligibility._action === "remove-property") {
    const requested_property_target_id =
      typeof input._resolved_task._edit_target_id === "string" &&
      input._resolved_task._edit_target_id.trim()
        ? input._resolved_task._edit_target_id.trim()
        : eligibility._target_id;
    const target_resolution =
      resolveViewTarget(next_view, {
        _target_id: requested_property_target_id,
        _target_text: input._resolved_task._edit_target_text,
        _target_type: input._resolved_task._edit_target_type,
        _target_id_text_fallback: true,
        _include_id: Boolean(requested_property_target_id),
        _allow_root: deterministic_target_type_is_view(input._resolved_task._edit_target_type),
      });
    if (!target_resolution._ok) {
      return {
        _ok: false,
        _reason: target_resolution._reason === "text_target_not_found"
          ? "target_not_found"
          : target_resolution._reason,
        ...(target_resolution._details !== undefined
          ? { _details: target_resolution._details }
          : {}),
      };
    }

    const target_node = target_resolution.object;
    if (
      target_node === next_view &&
      !deterministic_target_type_is_view(input._resolved_task._edit_target_type)
    ) {
      return {
        _ok: false,
        _reason: "target_is_root",
        _details: {
          _target_id: eligibility._target_id,
        },
      };
    }

    const property_name =
      typeof eligibility._property_name === "string" && eligibility._property_name.trim()
        ? eligibility._property_name.trim()
        : typeof input._resolved_task._edit_property_name === "string"
          ? input._resolved_task._edit_property_name.trim()
          : "";
    if (!property_name) {
      return { _ok: false, _reason: "missing_property_name" };
    }

    const property_eligibility =
      deterministic_set_property_eligibility({
        _target_node: target_node,
        _property_name: property_name,
        _next_value: input._resolved_task._edit_property_value,
        _is_set: eligibility._action === "set-property",
      });
    if (!property_eligibility._ok) {
      return {
        _ok: false,
        _reason: property_eligibility._reason ?? "unsupported_property",
        ...(property_eligibility._details !== undefined
          ? { _details: property_eligibility._details }
          : {}),
      };
    }

    const previous_value = target_node[property_name];

    if (eligibility._action === "set-property") {
      if (input._resolved_task._edit_property_value === undefined) {
        return { _ok: false, _reason: "missing_property_value" };
      }

      const next_value = input._resolved_task._edit_property_value;
      target_node[property_name] = next_value;

      return {
        _ok: true,
        _view: next_view,
        _mutation: {
          _type: "deterministic-view-edit",
          _action: "set-property",
          _target_id: eligibility._target_id,
          _resolved_by: deterministic_resolved_by_from_eligibility(eligibility),
          _property_name: property_name,
          ...(previous_value !== undefined ? { _previous_value: previous_value } : {}),
          _next_value: next_value,
        },
      };
    }

    delete target_node[property_name];

    return {
      _ok: true,
      _view: next_view,
      _mutation: {
        _type: "deterministic-view-edit",
        _action: "remove-property",
        _target_id: eligibility._target_id,
        _resolved_by: deterministic_resolved_by_from_eligibility(eligibility),
        _property_name: property_name,
        ...(previous_value !== undefined ? { _previous_value: previous_value } : {}),
      },
    };
  }

  if (eligibility._action === "set-styles") {
    const requested_target_id =
      typeof input._resolved_task._edit_target_id === "string" &&
      input._resolved_task._edit_target_id.trim()
        ? input._resolved_task._edit_target_id.trim()
        : eligibility._target_id;
    const styles_value =
      input._resolved_task._edit_styles ??
      (input._edit_intent?._styles as unknown);
    if (styles_value === undefined || styles_value === null) {
      return { _ok: false, _reason: "missing_styles" };
    }

    const styles_validation =
      deterministic_normalize_set_styles(styles_value);
    if (!styles_validation._ok) {
      return {
        _ok: false,
        _reason: styles_validation._reason,
        ...(styles_validation._details !== undefined
          ? { _details: styles_validation._details }
          : {}),
      };
    }

    const target_resolution =
      resolveViewTarget(next_view, {
        _target_id: requested_target_id,
        _target_text: input._resolved_task._edit_target_text,
        _target_type: input._resolved_task._edit_target_type,
        _target_id_text_fallback: Boolean(requested_target_id),
        _include_id: Boolean(requested_target_id),
      });
    if (!target_resolution._ok) {
      return {
        _ok: false,
        _reason: target_resolution._reason === "text_target_not_found"
          ? "target_not_found"
          : target_resolution._reason,
        ...(target_resolution._details !== undefined
          ? { _details: target_resolution._details }
          : {}),
      };
    }

    const target_node = target_resolution.object;
    if (target_node === next_view) {
      return {
        _ok: false,
        _reason: "target_is_root",
        _details: {
          _target_id: eligibility._target_id,
        },
      };
    }

    const style_object =
      deterministic_style_object(target_node._style);
    const previous_styles: XVibeJsonObject = {};
    for (const style_property of Object.keys(styles_validation._styles)) {
      if (Object.prototype.hasOwnProperty.call(style_object, style_property)) {
        previous_styles[style_property] = style_object[style_property];
      }
    }

    target_node._style = {
      ...style_object,
      ...styles_validation._styles,
    };

    return {
      _ok: true,
      _view: next_view,
      _mutation: {
        _type: "deterministic-view-edit",
        _action: "set-styles",
        _target_id: eligibility._target_id,
        _resolved_by: deterministic_resolved_by_from_eligibility(eligibility),
        _styles_applied: styles_validation._styles,
        _previous_styles: previous_styles,
      },
    };
  }

  if (eligibility._action === "set-style" || eligibility._action === "remove-style") {
    const requested_target_id =
      typeof input._resolved_task._edit_target_id === "string" &&
      input._resolved_task._edit_target_id.trim()
        ? input._resolved_task._edit_target_id.trim()
        : eligibility._target_id;
    const target_resolution =
      resolveViewTarget(next_view, {
        _target_id: requested_target_id,
        _target_text: input._resolved_task._edit_target_text,
        _target_type: input._resolved_task._edit_target_type,
        _target_id_text_fallback: Boolean(requested_target_id),
        _include_id: Boolean(requested_target_id),
      });
    if (!target_resolution._ok) {
      return {
        _ok: false,
        _reason:
          target_resolution._reason === "text_target_not_found"
            ? "target_not_found"
            : target_resolution._reason,
        ...(target_resolution._details !== undefined
          ? { _details: target_resolution._details }
          : {}),
      };
    }

    const target_node = target_resolution.object;
    if (target_node === next_view) {
      return {
        _ok: false,
        _reason: "target_is_root",
        _details: {
          _target_id: eligibility._target_id,
        },
      };
    }

    const style_property =
      typeof input._resolved_task._edit_style_property === "string"
        ? input._resolved_task._edit_style_property.trim()
        : "";
    const style_value =
      typeof input._resolved_task._edit_style_value === "string"
        ? input._resolved_task._edit_style_value.trim()
        : "";
    if (!style_property) {
      return { _ok: false, _reason: "missing_style_property" };
    }

    if (eligibility._action === "set-style" && !style_value) {
      return { _ok: false, _reason: "missing_style_value" };
    }

    const style_object =
      deterministic_style_object(target_node._style);
    const previous_value = style_object[style_property];

    if (eligibility._action === "set-style") {
      style_object[style_property] = style_value;
      target_node._style = style_object;

      return {
        _ok: true,
        _view: next_view,
        _mutation: {
          _type: "deterministic-view-edit",
          _action: "set-style",
          _target_id: eligibility._target_id,
          _resolved_by: deterministic_resolved_by_from_eligibility(eligibility),
          _style_property: style_property,
          ...(previous_value !== undefined ? { _previous_value: previous_value } : {}),
          _next_value: style_value,
        },
      };
    }

    delete style_object[style_property];
    if (deterministic_style_is_empty(style_object)) {
      delete target_node._style;
    } else {
      target_node._style = style_object;
    }

    return {
      _ok: true,
      _view: next_view,
      _mutation: {
        _type: "deterministic-view-edit",
        _action: "remove-style",
        _target_id: eligibility._target_id,
        _resolved_by: deterministic_resolved_by_from_eligibility(eligibility),
        _style_property: style_property,
        ...(previous_value !== undefined ? { _previous_value: previous_value } : {}),
      },
    };
  }

  if (
    eligibility._action === "add-class" ||
    eligibility._action === "remove-class" ||
    eligibility._action === "replace-class" ||
    eligibility._action === "toggle-class"
  ) {
    const requested_target_id =
      typeof input._resolved_task._edit_target_id === "string" &&
      input._resolved_task._edit_target_id.trim()
        ? input._resolved_task._edit_target_id.trim()
        : eligibility._target_id;
    const target_resolution =
      resolveViewTarget(next_view, {
        _target_id: requested_target_id,
        _target_text: input._resolved_task._edit_target_text,
        _target_type: input._resolved_task._edit_target_type,
        _target_id_text_fallback: Boolean(requested_target_id),
        _include_id: Boolean(requested_target_id),
      });
    if (!target_resolution._ok) {
      return {
        _ok: false,
        _reason:
          target_resolution._reason === "text_target_not_found"
            ? "target_not_found"
            : target_resolution._reason,
        ...(target_resolution._details !== undefined
          ? { _details: target_resolution._details }
          : {}),
      };
    }

    const target_node = target_resolution.object;
    if (target_node === next_view) {
      return {
        _ok: false,
        _reason: "target_is_root",
        _details: {
          _target_id: eligibility._target_id,
        },
      };
    }

    const class_name =
      typeof input._resolved_task._edit_class_name === "string"
        ? input._resolved_task._edit_class_name.trim()
        : "";
    const old_class_name =
      typeof input._resolved_task._edit_old_class_name === "string"
        ? input._resolved_task._edit_old_class_name.trim()
        : "";
    const new_class_name =
      typeof input._resolved_task._edit_new_class_name === "string"
        ? input._resolved_task._edit_new_class_name.trim()
        : "";

    if (
      eligibility._action === "replace-class" &&
      (!old_class_name || !new_class_name)
    ) {
      return { _ok: false, _reason: "missing_class_name" };
    }

    if (
      eligibility._action !== "replace-class" &&
      !class_name
    ) {
      return { _ok: false, _reason: "missing_class_name" };
    }

    const class_field = deterministic_class_field(target_node);
    const previous_class_value = target_node[class_field];
    const previous_class =
      typeof previous_class_value === "string"
        ? previous_class_value
        : undefined;
    const next_class =
      deterministic_next_class_value({
        _action: eligibility._action,
        _previous_class: previous_class,
        ...(eligibility._action === "replace-class"
          ? {
            _old_class_name: old_class_name,
            _new_class_name: new_class_name,
          }
          : { _class_name: class_name }),
      });

    if (next_class) {
      target_node[class_field] = next_class;
    } else {
      delete target_node[class_field];
    }

    return {
      _ok: true,
      _view: next_view,
      _mutation: {
        _type: "deterministic-view-edit",
        _action: eligibility._action,
        _target_id: eligibility._target_id,
        _resolved_by: deterministic_resolved_by_from_eligibility(eligibility),
        ...(eligibility._action === "replace-class"
          ? {
            _old_class_name: old_class_name,
            _new_class_name: new_class_name,
          }
          : { _class_name: class_name }),
        _class_field: class_field,
        ...(previous_class !== undefined ? { _previous_class: previous_class } : {}),
        ...(next_class !== undefined ? { _next_class: next_class } : {}),
      },
    };
  }

  if (eligibility._action === "hide-object") {
    const target_location =
      resolveViewTarget(next_view, {
        _target_id: eligibility._target_id,
      });
    if (!target_location._ok) {
      return {
        _ok: false,
        _reason: target_location._reason,
        ...(target_location._details !== undefined
          ? { _details: target_location._details }
          : {}),
      };
    }

    if (target_location.object === next_view) {
      return {
        _ok: false,
        _reason: "target_is_root",
        _details: {
          _target_id: eligibility._target_id,
        },
      };
    }

    const target_node = target_location.object;
    target_node.style =
      xvibe_deterministic_hide_style(target_node.style);
    target_node._visible = false;
    delete target_node._hidden;

    return {
      _ok: true,
      _view: next_view,
      _mutation: {
        _type: "deterministic-view-edit",
        _action: "hide-object",
        _target_id: eligibility._target_id,
        _resolved_by: deterministic_resolved_by_from_eligibility(eligibility),
        ...(typeof target_location.parent?._id === "string"
          ? { _parent_id: target_location.parent._id }
          : {}),
        _hide_mechanism: XVIBE_DETERMINISTIC_HIDE_MECHANISM,
      },
    };
  }

  if (eligibility._action === "show-object") {
    const target_location =
      resolveViewTarget(next_view, {
        _target_id: eligibility._target_id,
      });
    if (!target_location._ok) {
      return {
        _ok: false,
        _reason: target_location._reason,
        ...(target_location._details !== undefined
          ? { _details: target_location._details }
          : {}),
      };
    }

    if (target_location.object === next_view) {
      return {
        _ok: false,
        _reason: "target_is_root",
        _details: {
          _target_id: eligibility._target_id,
        },
      };
    }

    const target_node = target_location.object;
    if (typeof target_node.style === "string") {
      const next_style =
        xvibe_style_without_display_none(target_node.style);
      if (next_style) {
        target_node.style = next_style;
      } else {
        delete target_node.style;
      }
    }
    target_node._visible = true;

    return {
      _ok: true,
      _view: next_view,
      _mutation: {
        _type: "deterministic-view-edit",
        _action: "show-object",
        _target_id: eligibility._target_id,
        _resolved_by: deterministic_resolved_by_from_eligibility(eligibility),
        ...(typeof target_location.parent?._id === "string"
          ? { _parent_id: target_location.parent._id }
          : {}),
        _show_mechanism: XVIBE_DETERMINISTIC_SHOW_MECHANISM,
      },
    };
  }

  if (eligibility._action === "remove-object") {
    const target_location =
      resolveViewTarget(next_view, {
        _target_id: eligibility._target_id,
      });
    if (!target_location._ok) {
      return {
        _ok: false,
        _reason: target_location._reason,
        ...(target_location._details !== undefined
          ? { _details: target_location._details }
          : {}),
      };
    }

    if (target_location.object === next_view) {
      return {
        _ok: false,
        _reason: "target_is_root",
        _details: {
          _target_id: eligibility._target_id,
        },
      };
    }

    if (
      !target_location.parent ||
      !Array.isArray(target_location.parent._children) ||
      typeof target_location.index !== "number"
    ) {
      return {
        _ok: false,
        _reason: "target_parent_not_found",
        _details: {
          _target_id: eligibility._target_id,
        },
      };
    }

    const removed_node = target_location.object;
    target_location.parent._children.splice(target_location.index, 1);

    return {
      _ok: true,
      _view: next_view,
      _mutation: {
        _type: "deterministic-view-edit",
        _action: "remove-object",
        _target_id: eligibility._target_id,
        _resolved_by: deterministic_resolved_by_from_eligibility(eligibility),
        ...(typeof target_location.parent._id === "string"
          ? { _parent_id: target_location.parent._id }
          : {}),
        ...(typeof removed_node._type === "string"
          ? { _removed_type: removed_node._type }
          : {}),
        ...(typeof removed_node._text === "string"
          ? { _removed_text: removed_node._text }
          : {}),
      },
    };
  }

  if (eligibility._action !== "update-text" || eligibility._field !== "_text") {
    return {
      _ok: false,
      _reason: "unsupported_edit_action",
      _details: eligibility,
    };
  }

  const replacement_text =
    typeof input._resolved_task._edit_replacement_text === "string"
      ? input._resolved_task._edit_replacement_text
      : "";
  if (!replacement_text.trim()) {
    return { _ok: false, _reason: "missing_replacement_text" };
  }

  const target_node =
    find_view_node_by_id(next_view, eligibility._target_id);
  if (!target_node) {
    return {
      _ok: false,
      _reason: "target_not_found",
      _details: {
        _target_id: eligibility._target_id,
      },
    };
  }

  if (target_node === next_view) {
    return {
      _ok: false,
      _reason: "target_is_root",
      _details: {
        _target_id: eligibility._target_id,
      },
    };
  }

  const previous_text =
    typeof target_node._text === "string"
      ? target_node._text
      : undefined;
  if (
    eligibility._reason === "eligible" &&
    typeof input._resolved_task._edit_target_text === "string" &&
    previous_text !== input._resolved_task._edit_target_text
  ) {
    return {
      _ok: false,
      _reason: "text_mismatch",
      _details: {
        _target_id: eligibility._target_id,
        _expected_text: input._resolved_task._edit_target_text,
        _actual_text: previous_text,
      },
    };
  }

  target_node._text = replacement_text;

  return {
    _ok: true,
    _view: next_view,
    _mutation: {
      _type: "deterministic-view-edit",
      _action: "update-text",
      _target_id: eligibility._target_id,
      _field: "_text",
      ...(previous_text !== undefined ? { _previous_text: previous_text } : {}),
      _replacement_text: replacement_text,
      _resolved_by: deterministic_resolved_by_from_eligibility(eligibility),
    },
  };
}

function edit_target_match_score(input: {
  node: XVibeJsonObject;
  target_id?: string;
  target_text?: string;
  target_types: string[];
}): number {
  const node_id = typeof input.node._id === "string" ? input.node._id : "";
  const node_text =
    typeof input.node._text === "string"
      ? input.node._text
      : typeof input.node._label === "string"
        ? input.node._label
        : typeof input.node._title === "string"
          ? input.node._title
          : "";
  const node_type = typeof input.node._type === "string" ? input.node._type : "";
  const node_id_text = normalized_edit_text(node_id);
  const node_id_lookup = normalize_edit_lookup(node_id);
  const node_text_normalized = normalized_edit_text(node_text);
  const node_text_lookup = normalize_edit_lookup(node_text);
  const target_id_text = normalized_edit_text(input.target_id);
  const target_id_lookup = normalize_edit_lookup(input.target_id);
  const target_text_normalized = normalized_edit_text(input.target_text);
  const target_text_lookup = normalize_edit_lookup(input.target_text);
  const type_match =
    input.target_types.length === 0 ||
    input.target_types.includes(node_type);
  let score = type_match && input.target_types.length > 0 ? 25 : 0;

  if (target_id_text) {
    if (node_id_text === target_id_text) score += 120;
    else if (node_id_lookup === target_id_lookup) score += 110;
    else if (target_id_lookup && node_id_lookup.includes(target_id_lookup)) score += 85;
  }

  if (target_text_normalized) {
    if (node_text_normalized === target_text_normalized) score += 100;
    else if (node_text_lookup === target_text_lookup) score += 95;
    else if (target_text_lookup && node_text_lookup.includes(target_text_lookup)) score += 70;

    if (node_id_lookup && target_text_lookup && node_id_lookup.includes(target_text_lookup)) {
      score += 80;
    }
  }

  if (!type_match && score > 0) {
    score -= 20;
  }

  return score;
}

function resolve_view_edit_target_id(input: {
  current_view: unknown;
  prompt: string;
  target_id?: string;
  target_text?: string;
}): { _target_id?: string; _warnings: string[] } {
  const warnings: string[] = [];
  const nodes = collect_view_nodes(input.current_view);
  if (input.target_id) {
    if (nodes.length > 0 && !nodes.some((node) => node._id === input.target_id)) {
      warnings.push(`edit_target_id_not_found:${input.target_id}`);
    }
    return {
      _target_id: input.target_id,
      _warnings: warnings,
    };
  }

  if (!input.target_text) {
    return { _warnings: warnings };
  }

  const target_types = prompt_edit_target_types(input.prompt);
  let best: { _id: string; _score: number } | undefined;

  for (const node of nodes) {
    const node_id = typeof node._id === "string" && node._id.trim()
      ? node._id.trim()
      : undefined;
    if (!node_id) continue;

    const score =
      edit_target_match_score({
        node,
        target_text: input.target_text,
        target_types,
      });
    if (score <= 0) continue;
    if (!best || score > best._score) {
      best = { _id: node_id, _score: score };
    }
  }

  if (!best) {
    warnings.push(`edit_target_text_not_found:${input.target_text}`);
  }

  return {
    ...(best?._id ? { _target_id: best._id } : {}),
    _warnings: warnings,
  };
}

function view_node_type_by_id(current_view: unknown, target_id: string | undefined): string | undefined {
  if (!target_id) return undefined;
  const nodes = collect_view_nodes(current_view);
  for (const node of nodes) {
    if (node._id === target_id && typeof node._type === "string" && node._type.trim()) {
      return node._type.trim();
    }
  }

  return undefined;
}

function build_view_edit_intent(input: {
  resolved_task: XVibeResolvedTask;
  prompt: string;
  current_view?: unknown;
}): XVibeViewEditIntent | undefined {
  const action = input.resolved_task._edit_action;
  if (
    input.resolved_task._artifact_type !== "view" ||
    (
      action !== "remove" &&
      action !== "hide" &&
      action !== "show" &&
      action !== "update" &&
      action !== "add-class" &&
      action !== "remove-class" &&
      action !== "replace-class" &&
      action !== "toggle-class" &&
      action !== "set-style" &&
      action !== "set-styles" &&
      action !== "remove-style" &&
      action !== "set-style-class-rule" &&
      action !== "remove-style-class-rule" &&
      action !== "set-property" &&
      action !== "update-property" &&
      action !== "remove-property" &&
      action !== "move-object"
    )
  ) {
    return undefined;
  }

  const replacement =
    parse_prompt_text_replacement(input.prompt);
  const replacement_text =
    input.resolved_task._edit_replacement_text ??
    replacement._replacement_text;
  const field =
    input.resolved_task._edit_field ??
    (action === "update" && replacement_text ? "_text" : undefined);
  const prompt_target_text =
    input.resolved_task._edit_target_text ??
    replacement._target_text;
  const target_resolution =
    resolve_view_edit_target_id({
      current_view: input.current_view,
      prompt: input.prompt,
      target_id: input.resolved_task._edit_target_id,
      target_text: prompt_target_text,
    });
  const target_id = target_resolution._target_id;
  const current_target_text =
    field === "_text"
      ? view_node_text_by_id(input.current_view, target_id)
      : undefined;
  const target_text =
    prompt_target_text ??
    current_target_text;
  const warnings = [...target_resolution._warnings];
  if (
    field === "_text" &&
    prompt_target_text &&
    current_target_text &&
    current_target_text !== prompt_target_text
  ) {
    warnings.push(`edit_target_text_mismatch:${target_id ?? "unknown"}`);
  }
  const target_type =
    prompt_edit_target_types(input.prompt)[0] ??
    view_node_type_by_id(input.current_view, target_id);
  const resolved_task_json = input.resolved_task as XVibeJsonObject;
  const edit_position =
    resolved_task_json._edit_position === "append" ||
    resolved_task_json._edit_position === "prepend" ||
    resolved_task_json._edit_position === "before" ||
    resolved_task_json._edit_position === "after"
      ? resolved_task_json._edit_position
      : undefined;
  const edit_destination_id =
    typeof resolved_task_json._edit_destination_id === "string"
      ? resolved_task_json._edit_destination_id
      : undefined;
  const edit_destination_text =
    typeof resolved_task_json._edit_destination_text === "string"
      ? resolved_task_json._edit_destination_text
      : undefined;
  const edit_destination_type =
    typeof resolved_task_json._edit_destination_type === "string"
      ? resolved_task_json._edit_destination_type
      : undefined;
  const edit_styles =
    _xu.is_plain_object(resolved_task_json._edit_styles)
      ? resolved_task_json._edit_styles
      : undefined;

  return {
    _action: action,
    ...(target_id ? { _target_id: target_id } : {}),
    ...(field ? { _field: field } : {}),
    ...(target_text ? { _target_text: target_text } : {}),
    ...(replacement_text ? { _replacement_text: replacement_text } : {}),
    ...(input.resolved_task._edit_class_name
      ? { _class_name: input.resolved_task._edit_class_name }
      : {}),
    ...(input.resolved_task._edit_old_class_name
      ? { _old_class_name: input.resolved_task._edit_old_class_name }
      : {}),
    ...(input.resolved_task._edit_new_class_name
      ? { _new_class_name: input.resolved_task._edit_new_class_name }
      : {}),
    ...(input.resolved_task._edit_style_property
      ? { _style_property: input.resolved_task._edit_style_property }
      : {}),
    ...(input.resolved_task._edit_style_value
      ? { _style_value: input.resolved_task._edit_style_value }
      : {}),
    ...(edit_styles
      ? { _styles: edit_styles }
      : {}),
    ...(input.resolved_task._edit_property_name
      ? { _property_name: input.resolved_task._edit_property_name }
      : {}),
    ...(input.resolved_task._edit_property_value !== undefined
      ? { _property_value: input.resolved_task._edit_property_value }
      : {}),
    ...(input.resolved_task._edit_move_position
      ? { _move_position: input.resolved_task._edit_move_position }
      : {}),
    ...(edit_position
      ? { _position: edit_position }
      : {}),
    ...(input.resolved_task._edit_anchor_id
      ? { _anchor_id: input.resolved_task._edit_anchor_id }
      : {}),
    ...(input.resolved_task._edit_anchor_text
      ? { _anchor_text: input.resolved_task._edit_anchor_text }
      : {}),
    ...(input.resolved_task._edit_anchor_type
      ? { _anchor_type: input.resolved_task._edit_anchor_type }
      : {}),
    ...(edit_destination_id
      ? { _destination_id: edit_destination_id }
      : {}),
    ...(edit_destination_text
      ? { _destination_text: edit_destination_text }
      : {}),
    ...(edit_destination_type
      ? { _destination_type: edit_destination_type }
      : {}),
    ...(target_type ? { _target_type: target_type } : {}),
    ...(warnings.length > 0 ? { _warnings: Array.from(new Set(warnings)) } : {}),
  };
}

function prompt_explicitly_requests_event_handling(prompt: string): boolean {
  return /\b(?:event|events|on\s+click|onclick|click\s+handler|handler|_on|xem|fire|submit|hover|keyboard|keypress|on\s+submit)\b/iu
    .test(prompt);
}

function filter_selection_for_view_edit(
  selection: VibeKnowledgeSelection,
  prompt: string,
  edit_intent: XVibeViewEditIntent | undefined,
): VibeKnowledgeSelection {
  if (!edit_intent) {
    return selection;
  }

  const allow_flow = prompt_allows_view_flow_triggers(prompt);
  const allow_events = prompt_explicitly_requests_event_handling(prompt);
  const should_keep = (id: string): boolean => {
    const normalized = id.trim().toLowerCase();
    if (!allow_flow && (normalized === "xui-flow-trigger" || normalized === "xfm-flow")) {
      return false;
    }
    if (!allow_events && normalized === "xui-events") {
      return false;
    }
    if (
      normalized === "entity-runtime" ||
      normalized === "xdb-entity" ||
      normalized === "entity-client" ||
      normalized.includes("entity")
    ) {
      return false;
    }
    return true;
  };
  const skills =
    selection.skills.filter((skill) =>
      typeof skill._id !== "string" || should_keep(skill._id),
    );
  const skill_ids =
    selection.skill_ids.filter(should_keep);
  const allowed_ids = new Set(skill_ids);

  return {
    skill_ids,
    skills,
    diagnostics:
      selection.diagnostics.filter((diagnostic) =>
        allowed_ids.has(diagnostic._id),
    ),
  };
}

function ensure_selection_includes_xui_type(
  selection: VibeKnowledgeSelection,
  xui_type: unknown,
): VibeKnowledgeSelection {
  if (typeof xui_type !== "string" || xui_type.trim().length === 0) {
    return selection;
  }

  const id = xui_type.trim();
  if (selection.skill_ids.includes(id)) {
    return selection;
  }

  const skill = {
    _id: id,
    _type: "xui-object",
    _exports: {
      _xui_objects: [id],
    },
    _core_rules: [
      `Use existing ${id} nodes when editing matching current-view objects.`,
    ],
  } as unknown as VibeKnowledgeSelection["skills"][number];

  return {
    skill_ids: [...selection.skill_ids, id],
    skills: [...selection.skills, skill],
    diagnostics: [
      ...selection.diagnostics,
      {
        _id: id,
        _score: 0,
        _reasons: ["resolved-edit-target-type"],
        _selected_as: "required",
      },
    ],
  };
}

type XVibeViewScopeWarning =
  | "view_scope_removed_entity"
  | "view_scope_removed_module"
  | "view_scope_removed_flow"
  | "view_scope_removed_crud";

type XVibeViewScopeLockResult = {
  _artifact_plan?: XVibeInferredArtifactPlan;
  _intent_plan?: VibeIntentPlan;
  _behavior_intent?: VibeBehaviorIntent;
  _warnings: XVibeViewScopeWarning[];
};

function prompt_has_explicit_server_module_request(prompt: string): boolean {
  const text = _xu.normalizePrompt(prompt).toLowerCase();
  return (
    /\bcreate\s+(?:a\s+|an\s+|the\s+)?server\s+(?:xmodule|module)\b/u.test(text) ||
    /\bwith\s+(?:a\s+|an\s+|the\s+)?server\s+(?:xmodule|module)\b/u.test(text) ||
    /\bcall\s+(?:a\s+|an\s+|the\s+)?server\s+(?:xmodule|module)\b/u.test(text) ||
    /\bxvm\.call-server\s+(?:module|server\s+module)\b/u.test(text)
  );
}

function view_scope_lock_warnings(
  input: {
    allow_entity: boolean;
    allow_module: boolean;
    allow_flow: boolean;
    artifact_plan?: XVibeInferredArtifactPlan;
    intent_plan?: VibeIntentPlan;
    behavior_intent?: VibeBehaviorIntent;
  },
): XVibeViewScopeWarning[] {
  const warnings: XVibeViewScopeWarning[] = [];
  const add = (warning: XVibeViewScopeWarning, condition: boolean): void => {
    if (condition && !warnings.includes(warning)) warnings.push(warning);
  };

  add(
    "view_scope_removed_entity",
    !input.allow_entity &&
    (
      (input.artifact_plan?._artifact_types.includes("entity") ?? false) ||
      (input.artifact_plan?._entity_ids?.length ?? 0) > 0 ||
      (input.intent_plan?._entities.length ?? 0) > 0 ||
      (input.intent_plan?._entity_keywords.length ?? 0) > 0 ||
      (input.behavior_intent?._entity_targets?.length ?? 0) > 0 ||
      Boolean(input.behavior_intent?._entity)
    ),
  );
  add(
    "view_scope_removed_module",
    !input.allow_module &&
    (
      (input.artifact_plan?._artifact_types.includes("module") ?? false) ||
      (input.artifact_plan?._module_names?.length ?? 0) > 0 ||
      (input.intent_plan?._modules.length ?? 0) > 0 ||
      input.intent_plan?._requires_module === true ||
      Boolean(input.intent_plan?._module_name)
    ),
  );
  add(
    "view_scope_removed_flow",
    !input.allow_flow &&
    (
      (input.artifact_plan?._artifact_types.includes("flow") ?? false) ||
      (input.artifact_plan?._flow_ids?.length ?? 0) > 0 ||
      (input.intent_plan?._flow_keywords.length ?? 0) > 0 ||
      (input.behavior_intent?._flow_targets?.length ?? 0) > 0 ||
      Boolean(input.behavior_intent?._flow_goal)
    ),
  );
  add(
    "view_scope_removed_crud",
    !input.allow_entity &&
    (
      (input.intent_plan?._crud_ops.length ?? 0) > 0 ||
      (input.intent_plan?._actions.length ?? 0) > 0 ||
      Boolean(input.behavior_intent?._crud_intent) ||
      Boolean(input.behavior_intent?._crud)
    ),
  );

  return warnings;
}

function view_scope_execution_action(
  resolved_task: XVibeResolvedTask,
): XVibeArtifactExecutionPlan["_artifacts"][number]["_action"] {
  if (
    resolved_task._action === "create" ||
    resolved_task._action === "update" ||
    resolved_task._action === "delete" ||
    resolved_task._action === "disable" ||
    resolved_task._action === "archive"
  ) {
    return resolved_task._action;
  }

  return "create";
}

function apply_view_scope_lock(input: {
  prompt: string;
  resolved_task: XVibeResolvedTask;
  artifact_plan?: XVibeInferredArtifactPlan;
  intent_plan?: VibeIntentPlan;
  behavior_intent?: VibeBehaviorIntent;
}): XVibeViewScopeLockResult {
  if (input.resolved_task._artifact_type !== "view") {
    return {
      ...(input.artifact_plan ? { _artifact_plan: input.artifact_plan } : {}),
      ...(input.intent_plan ? { _intent_plan: input.intent_plan } : {}),
      ...(input.behavior_intent ? { _behavior_intent: input.behavior_intent } : {}),
      _warnings: [],
    };
  }

  const normalized_prompt = _xu.normalizePrompt(input.prompt).toLowerCase();
  const allow_flow = has_explicit_flow_intent(normalized_prompt);
  const allow_entity = has_explicit_data_or_crud_intent(input.prompt);
  const allow_module = prompt_has_explicit_server_module_request(input.prompt);
  const warnings =
    view_scope_lock_warnings({
      allow_entity,
      allow_module,
      allow_flow,
      artifact_plan: input.artifact_plan,
      intent_plan: input.intent_plan,
      behavior_intent: input.behavior_intent,
    });

  for (const warning of warnings) {
    _xlog.warn("[xvibe] view scope lock removed plan leakage", {
      _warning: warning,
      _resolved_task: input.resolved_task,
    });
  }

  let artifact_plan = input.artifact_plan;
  if (artifact_plan) {
    const flow_ids =
      allow_flow
        ? Array.from(new Set([
          ...(artifact_plan._flow_ids ?? []),
          ...extract_prompt_flow_ids(input.prompt),
        ]))
        : [];
    const entity_ids =
      allow_entity
        ? artifact_plan._entity_ids
        : undefined;
    const module_names =
      allow_module
        ? artifact_plan._module_names
        : undefined;
    const artifact_types: XVibeInferredArtifactType[] = [
      ...(allow_entity && (entity_ids?.length || artifact_plan._artifact_types.includes("entity"))
        ? ["entity" as const]
        : []),
      ...(allow_flow && (flow_ids.length > 0 || artifact_plan._artifact_types.includes("flow"))
        ? ["flow" as const]
        : []),
      "view",
    ];
    const view_artifact_id =
      normalize_safe_view_id(input.resolved_task._target_id);
    const execution_artifacts: XVibeArtifactExecutionPlan["_artifacts"] = [
      ...(allow_entity && entity_ids
        ? entity_ids.map((id) => ({
          _artifact_type: "entity",
          _action: "create" as const,
          _artifact_id: id,
        }))
        : []),
      ...(allow_flow
        ? (flow_ids.length > 0 ? flow_ids : [undefined]).map((id) => ({
          _artifact_type: "flow",
          _action: "create" as const,
          ...(id ? { _artifact_id: id } : {}),
        }))
        : []),
      {
        _artifact_type: "view",
        _action: view_scope_execution_action(input.resolved_task),
        ...(view_artifact_id ? { _artifact_id: view_artifact_id } : {}),
        ...(allow_flow && flow_ids.length > 0 ? { _depends_on: flow_ids } : {}),
      },
    ];

    artifact_plan = {
      ...artifact_plan,
      _primary_artifact_type: "view",
      _artifact_types: Array.from(new Set(artifact_types)),
      ...(allow_flow && flow_ids.length > 0 ? { _flow_ids: flow_ids } : { _flow_ids: undefined }),
      ...(allow_entity && entity_ids && entity_ids.length > 0 ? { _entity_ids: entity_ids } : { _entity_ids: undefined }),
      ...(allow_module && module_names && module_names.length > 0 ? { _module_names: module_names } : { _module_names: undefined }),
      _reason: "resolved_view_scope_lock",
      _execution_plan: {
        _primary_artifact_type: "view",
        _artifacts: execution_artifacts,
      },
    };
  }

  let intent_plan = input.intent_plan;
  if (intent_plan) {
    const flow_keywords =
      allow_flow
        ? Array.from(new Set([
          ...intent_plan._flow_keywords,
          ...extract_prompt_flow_ids(input.prompt),
        ]))
        : [];
    intent_plan = {
      ...intent_plan,
      _intent_type:
        intent_plan._intent_type === "module"
          ? "view"
          : intent_plan._intent_type,
      _artifact_types: Array.from(new Set([
        ...(allow_entity && intent_plan._artifact_types.includes("entity") ? ["entity"] : []),
        ...(allow_flow && (flow_keywords.length > 0 || intent_plan._artifact_types.includes("flow")) ? ["flow"] : []),
        "view",
      ])),
      _entities: allow_entity ? intent_plan._entities : [],
      _actions:
        allow_entity || allow_flow
          ? intent_plan._actions.filter((action) =>
            (allow_entity && Boolean(action._entity)) ||
            (allow_flow && action._type === "flow" && !action._entity)
          )
          : [],
      _bindings: allow_entity ? intent_plan._bindings : [],
      _modules: allow_module ? intent_plan._modules : [],
      _capabilities:
        intent_plan._capabilities.filter((capability) => {
          if (!allow_entity && ["entity", "crud", "storage"].includes(capability)) return false;
          if (!allow_module && ["module", "server-module", "client-module"].includes(capability)) return false;
          return true;
        }),
      _crud_ops: allow_entity ? intent_plan._crud_ops : [],
      _flow_keywords: flow_keywords,
      _entity_keywords: allow_entity ? intent_plan._entity_keywords : [],
      _requires_module: allow_module ? intent_plan._requires_module : false,
      _module_target: allow_module ? intent_plan._module_target : null,
      _module_name: allow_module ? intent_plan._module_name : undefined,
      _module_ops: allow_module ? intent_plan._module_ops : [],
      _module_reason: allow_module ? intent_plan._module_reason : undefined,
    };
  }

  let behavior_intent = input.behavior_intent;
  if (behavior_intent) {
    behavior_intent = {
      ...behavior_intent,
      ...(!allow_entity
        ? {
          _crud_intent: undefined,
          _entity_targets: [],
          _entity: undefined,
          _crud: undefined,
          _source_fields: undefined,
          _target_fields: undefined,
        }
        : {}),
      ...(!allow_flow
        ? {
          _flow_targets: [],
          _flow_goal: undefined,
        }
        : {}),
      ...(!allow_entity && !allow_flow
        ? { _steps: [] }
        : {}),
    };
  }

  return {
    ...(artifact_plan ? { _artifact_plan: artifact_plan } : {}),
    ...(intent_plan ? { _intent_plan: intent_plan } : {}),
    ...(behavior_intent ? { _behavior_intent: behavior_intent } : {}),
    _warnings: warnings,
  };
}

function apply_view_scope_lock_to_app_plan(input: {
  prompt: string;
  resolved_task: XVibeResolvedTask;
  plan: XVibeAppPlan;
}): {
  _plan: XVibeAppPlan;
  _warnings: XVibeViewScopeWarning[];
} {
  if (input.resolved_task._artifact_type !== "view") {
    return {
      _plan: input.plan,
      _warnings: [],
    };
  }

  const normalized_prompt = _xu.normalizePrompt(input.prompt).toLowerCase();
  const allow_flow = has_explicit_flow_intent(normalized_prompt);
  const allow_entity = has_explicit_data_or_crud_intent(input.prompt);
  const allow_module = prompt_has_explicit_server_module_request(input.prompt);
  const warnings: XVibeViewScopeWarning[] = [];
  const add = (warning: XVibeViewScopeWarning, condition: boolean): void => {
    if (condition && !warnings.includes(warning)) warnings.push(warning);
  };

  add("view_scope_removed_entity", !allow_entity && input.plan._artifacts.includes("entity"));
  add("view_scope_removed_flow", !allow_flow && input.plan._artifacts.includes("flow"));
  add(
    "view_scope_removed_module",
    !allow_module && (input.plan._artifacts.includes("module-spec") || input.plan._requires_module),
  );

  for (const warning of warnings) {
    _xlog.warn("[xvibe] view scope lock removed app plan leakage", {
      _warning: warning,
      _resolved_task: input.resolved_task,
    });
  }

  const artifacts: XVibeArtifactPlanType[] = [
    ...(allow_entity && input.plan._artifacts.includes("entity") ? ["entity" as const] : []),
    ...(allow_flow && input.plan._artifacts.includes("flow") ? ["flow" as const] : []),
    ...(allow_module && input.plan._artifacts.includes("module-spec") ? ["module-spec" as const] : []),
    "view",
  ];

  return {
    _plan: {
      ...input.plan,
      _artifacts: Array.from(new Set(artifacts)),
      _requires_module: allow_module ? input.plan._requires_module : false,
      _logic_level:
        allow_module
          ? input.plan._logic_level
          : allow_flow && input.plan._logic_level === "flow"
            ? "flow"
            : "none",
      ...(allow_flow && input.plan._flow_ids?.length
        ? { _flow_ids: input.plan._flow_ids }
        : { _flow_ids: undefined }),
    },
    _warnings: warnings,
  };
}

function runtime_module_exists(
  module_name: string,
  registry: XVibeRuntimeRegistry,
): boolean {
  if (registry._modules.has(module_name)) return true;

  const get_module =
    (_x as unknown as { getModule?: (name: string) => unknown }).getModule;

  if (typeof get_module !== "function") {
    return false;
  }

  return Boolean(get_module.call(_x, module_name));
}

function runtime_registry_has_module(
  module_name: string,
  registry: XVibeRuntimeRegistry,
): boolean {
  const normalized = module_name.trim().toLowerCase();
  if (!normalized) return false;

  return Array.from(registry._modules)
    .some((item) => item.trim().toLowerCase() === normalized);
}

function normalize_view_server_module_op(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith("_")
    ? trimmed.slice(1)
    : trimmed;
}

function add_view_server_module_call(
  calls: Map<string, Set<string>>,
  module_name: string,
  op_name: string,
): void {
  const normalized_module = module_name.trim();
  const normalized_op = normalize_view_server_module_op(op_name);

  if (!normalized_module || !normalized_op) return;

  let ops = calls.get(normalized_module);
  if (!ops) {
    ops = new Set();
    calls.set(normalized_module, ops);
  }

  ops.add(normalized_op);
}

function collect_view_server_module_calls(
  value: unknown,
  calls = new Map<string, Set<string>>(),
): Map<string, Set<string>> {
  if (Array.isArray(value)) {
    for (const item of value) {
      collect_view_server_module_calls(item, calls);
    }
    return calls;
  }

  if (!_xu.is_plain_object(value)) {
    return calls;
  }

  if (
    value._module === "xvm" &&
    value._op === "call-server" &&
    _xu.is_plain_object(value._params) &&
    _xu.is_plain_object(value._params._cmd) &&
    typeof value._params._cmd._module === "string" &&
    typeof value._params._cmd._op === "string"
  ) {
    add_view_server_module_call(
      calls,
      value._params._cmd._module,
      value._params._cmd._op,
    );
  }

  for (const child of Object.values(value)) {
    collect_view_server_module_calls(child, calls);
  }

  return calls;
}

function view_server_module_calls_to_data(
  calls: Map<string, Set<string>>,
): Record<string, string[]> {
  return Object.fromEntries(
    [...calls.entries()].map(([module_name, ops]) => [
      module_name,
      [...ops].sort(),
    ]),
  );
}

function prompt_requests_styling(prompt: string): boolean {
  return /\b(style|styled|styling|theme|themed|color|colors|css|stylesheet|style-sheet|visual|design|polish|beautiful|pretty)\b/i.test(prompt);
}
export function prompt_allows_view_flow_triggers(
  prompt: string
): boolean {

  const text =
    prompt.toLowerCase();

  // Explicit flow id always wins.
  if (
    /\bflow-[a-z0-9][a-z0-9_-]*\b/i
      .test(text)
  ) {
    return true;
  }

  if (
    /\bflow\s+named\s+[a-z][a-z0-9_-]*\b/i
      .test(text)
  ) {
    return true;
  }

  // Generic flow trigger language.
  if (
    /\b(?:trigger|triggers|triggering|run|runs|execute|call)\s+(?:(?:a|an|the)\s+)?flow\b/i
      .test(text)
  ) {
    return true;
  }

  // Button-specific phrasing.
  if (
    /\bbutton\b.*\b(?:trigger|triggers|triggering|run|runs|execute|call)\b.*\bflow\b/i
      .test(text)
  ) {
    return true;
  }

  // "button should trigger flow"
  if (
    /\bbutton\b.*\bshould\b.*\b(?:trigger|run|execute|call)\b.*\bflow\b/i
      .test(text)
  ) {
    return true;
  }

  return false;
}

export function strip_unrequested_flow_triggers(node: unknown): number {
  if (Array.isArray(node)) {
    return node.reduce(
      (count, item) => count + strip_unrequested_flow_triggers(item),
      0,
    );
  }

  if (!_xu.is_plain_object(node)) {
    return 0;
  }

  let removed = 0;

  if (Object.prototype.hasOwnProperty.call(node, "_flow")) {
    delete node._flow;
    removed += 1;
  }

  for (const value of Object.values(node)) {
    removed += strip_unrequested_flow_triggers(value);
  }

  return removed;
}

function validation_path(parent: string, key: string | number): string {
  return typeof key === "number"
    ? `${parent}[${key}]`
    : `${parent}.${key}`;
}

function non_empty_string(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function non_empty_array(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

function is_visible_false(node: XVibeJsonObject): boolean {
  return (
    node._visible === false ||
    node.hidden === true ||
    xvibe_style_has_display_none(node.style)
  );
}

function has_non_empty_object(value: unknown): boolean {
  return _xu.is_plain_object(value) && Object.keys(value).length > 0;
}

function has_valid_data_source(value: unknown): boolean {
  return non_empty_string(value) || has_non_empty_object(value);
}

function has_content_value(node: XVibeJsonObject): boolean {
  return [
    "_text",
    "_label",
    "_title",
    "_value",
    "_content",
    "_placeholder",
  ].some((key) => non_empty_string(node[key]));
}

function has_non_empty_children(node: XVibeJsonObject): boolean {
  return non_empty_array(node._children);
}

function has_typed_children(node: XVibeJsonObject): boolean {
  if (!Array.isArray(node._children)) return false;

  return node._children.some((child) => {
    if (!_xu.is_plain_object(child)) return false;
    if (child._type === "style-sheet") return false;
    return non_empty_string(child._type);
  });
}

function has_content_or_non_empty_children(node: XVibeJsonObject): boolean {
  return has_content_value(node) || has_non_empty_object(node._content) || has_typed_children(node);
}

function collect_view_flow_ids(node: unknown, target = new Set<string>()): string[] {
  if (!_xu.is_plain_object(node)) return [...target];

  if (_xu.is_plain_object(node._flow) && typeof node._flow._id === "string" && node._flow._id.trim().length > 0) {
    target.add(node._flow._id.trim());
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === "_flow") continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        collect_view_flow_ids(item, target);
      }
    } else if (_xu.is_plain_object(value)) {
      collect_view_flow_ids(value, target);
    }
  }

  return [...target];
}

function collect_generated_flow_ids(value: unknown): string[] {
  if (!_xu.is_plain_object(value) || !Array.isArray(value._flows)) {
    return [];
  }

  const ids = value._flows
    .map((flow) => {
      if (!_xu.is_plain_object(flow)) return undefined;
      const id = flow._flow_id ?? flow._artifact_id;
      return typeof id === "string" && id.trim().length > 0
        ? id.trim()
        : undefined;
    })
    .filter((id): id is string => typeof id === "string");

  return Array.from(new Set(ids));
}

function extract_prompt_flow_ids(prompt: string): string[] {
  return Array.from(new Set([
    ...extract_named_flow_ids(prompt),
    ...extract_intent_prompt_flow_ids(prompt),
  ]));
}

function field_control_requires_name(control_type: string): boolean {
  return ![
    "label",
    "static",
    "display",
    "readonly",
  ].includes(control_type);
}

type XVibeGenerateModuleSpecResult = {
  _ok: boolean;
  _spec?: {
    _id: string;
    _name: string;
    _target: "server";
    _description?: string;
    _version?: string;
    _imports: [{ _from: "@xpell/node" }];
    _permissions: [];
    _ops: {
      _name: string;
      _description: string;
      _params?: Record<string, string>;
      _result?: Record<string, string>;
    }[];
  };
  _needs_module_creator: true;
  _error?: {
    _code: string;
    _message: string;
    _details?: unknown;
  };
};

type XVibePlanAppResult = {
  _ok: true;
  _result: XVibeAppPlan;
} | {
  _ok: false;
  _error: {
    _code: string;
    _message: string;
  };
};

type XVibeGeneratedArtifactSummary = {
  _artifact_type: XVibeArtifactPlanType;
  _artifact_id: string;
};

type XVibeArtifactGenerationContext = {
  _plan: XVibeAppPlan;
  _intent_plan?: XVibeJsonObject;
  _resolved_task?: XVibeResolvedTask;
  _app_id: string;
  _env: string;
  _generation_id?: string;
  _generated: {
    _views: XVibeGeneratedArtifactSummary[];
    _flows: XVibeGeneratedArtifactSummary[];
    _entities: XVibeGeneratedArtifactSummary[];
    _module_specs: XVibeGeneratedArtifactSummary[];
  };
};

type XVibePlannedArtifactInput = {
  _prompt: string;
  _entry_view_id: string;
  _item: XVibeArtifactExecutionItem;
  _context: XVibeArtifactGenerationContext;
};

type XVibeArtifactExecutionPlanInput = {
  _prompt: string;
  _params: XVibeJsonObject;
  _execution_plan: XVibeArtifactExecutionPlan;
  _app_id: string;
  _env: string;
  _mode: VibeAIMode;
  _entry_view_id?: string;
  _generation_id?: string;
};

export class XVibeModule extends XModule {
  static _name = "xvibe";
  static _skill: XpellSkill = {
    _id: "xvibe",
    _title: "XVibe Server Module",
    _version: "1.0.0",
    _active: true,
    _type: "server-module-api",
    _requires: ["xmodule", "xai", "server-xvm", "module-creator"],
    _description:
      "Server-side AI generation module for Xpell artifacts, including views, apps, flows, entities, commands, and generated module specs.",
    _core_rules: [
      "XVibe owns AI prompting, knowledge selection, output parsing, and artifact orchestration.",
      "XVibe must not compile, import, or load generated XModules directly.",
      "Use module-creator for generated module validation, artifact generation, and runtime loading.",
      "Generated persisted artifacts must remain data-only JSON unless explicitly handled by module-creator.",
      "Use snake_case params."
    ]
  };

  static _ops: Record<string, XpellSkillCommand> = {
    generate: {
      _name: "generate",
      _scope: "module",
      _description:
        "Generate a Xpell artifact from a prompt. Artifact type may be inferred or specified.",
      _params: {
        _prompt: "User prompt.",
        _app_id: "Target app id.",
        _env: "Optional environment. Default: default.",
        _mode: "Generation mode: full or refine.",
        _artifact_type: "Optional artifact type: view, flow, entity, command, or auto.",
        _capabilities: "Optional skill/capability filters."
      }
    },

    "plan-app": {
      _name: "plan-app",
      _scope: "module",
      _description:
        "Create a deterministic app artifact plan from a prompt without AI calls or persistence.",
      _params: {
        _prompt: "User prompt."
      },
      _example: {
        _module: "xvibe",
        _op: "plan-app",
        _params: {
          _prompt: "create puzzle game"
        }
      }
    },

    "generate-view": {
      _name: "generate-view",
      _scope: "module",
      _description:
        "Generate or refine a XUI view artifact and persist it through server-xvm.",
      _params: {
        _prompt: "User prompt.",
        _app_id: "Target app id.",
        _env: "Optional environment. Default: default.",
        _view_id: "Optional target view id.",
        _mode: "Generation mode: full or refine."
      }
    },

    "get-guide-recommendation": {
      _name: "get-guide-recommendation",
      _scope: "module",
      _description:
        "Return one deterministic next suggested development step from Project Memory and current app state without AI generation.",
      _params: {
        _app_id: "Target app id.",
        _env: "Optional environment. Default: default."
      }
    },

    "confirm-project-plan": {
      _name: "confirm-project-plan",
      _scope: "module",
      _description:
        "Confirm the current conversation planning draft and persist it into Project Memory without creating app artifacts.",
      _params: {
        _app_id: "Target app id.",
        _env: "Optional environment. Default: default.",
        _conversation_id: "Conversation id containing the current planning draft.",
        _message_id: "Optional message id for caller correlation.",
        _artifact: "Optional project-plan artifact fallback.",
        _project_plan: "Optional project-plan payload fallback."
      }
    },

    "apply-view-edit": {
      _name: "apply-view-edit",
      _scope: "module",
      _description:
        "Apply a structured deterministic view edit and persist it through server-xvm without AI fallback.",
      _params: {
        _app_id: "Target app id.",
        _env: "Target environment.",
        _view_id: "Target/source view id.",
        _edit_action: "set-property, update-property, remove-property, set-interaction, bind-flow, set-style, set-styles, remove-style, add-class, remove-class, replace-class, toggle-class, remove-object, hide-object, show-object, move-object, replace-object, duplicate-object, add-child, or create-toolbar.",
        _target_id: "Target XUI object id.",
        _target_type: "Optional target XUI type.",
        _before_id: "Anchor XUI object id for move-object or duplicate-object before placement.",
        _after_id: "Anchor XUI object id for move-object or duplicate-object after placement.",
        _child: "Child XUI object for add-child.",
        _property_name: "Property name for property edits.",
        _property_value: "Property value for set-property.",
        _interaction_scope: "Interaction scope for set-interaction: _on or _once. Default: _on.",
        _trigger: "Interaction trigger for set-interaction. V1 supports click.",
        _handler: "Interaction handler object for set-interaction, or null to remove the trigger.",
        _flow: "Flow binding for bind-flow: string flow id or { _id, _payload } object.",
        _flow_event: "Flow event for bind-flow. Default: click.",
        _flow_auto: "Whether XUI auto-binds the flow. Default: true.",
        _style_property: "Style property for style edits.",
        _style_value: "Style value for set-style.",
        _styles: "Style object for set-styles.",
        _class_name: "Class name for add/remove/toggle class edits.",
        _old_class_name: "Old class name for replace-class.",
        _new_class_name: "New class name for replace-class.",
        _object_value: "Replacement object for replace-object."
      }
    },

    "apply-mutation-plan": {
      _name: "apply-mutation-plan",
      _scope: "module",
      _description:
        "Apply a compiled mutation-plan artifact by executing its validated primitive descriptors sequentially. Stops on first failure and does not roll back completed steps.",
      _params: {
        _app_id: "Target app id.",
        _env: "Target environment.",
        _conversation_id: "Optional conversation id for caller correlation.",
        _message_id: "Optional message id for caller correlation.",
        _action_id: "Optional action id inside the conversation message for action-state persistence.",
        _plan: "Compiled mutation-plan artifact with _can_apply true and executable primitive descriptors."
      }
    },

    "fix-project-views": {
      _name: "fix-project-views",
      _scope: "module",
      _description:
        "Scan all persisted project views and add deterministic stable _id values to XUI objects that are missing them.",
      _params: {
        _app_id: "Target app id.",
        _env: "Optional environment. Default: default."
      }
    },

    "analyze-project-views": {
      _name: "analyze-project-views",
      _scope: "module",
      _description:
        "Analyze all persisted project views for missing XUI object _id values without persisting fixes.",
      _params: {
        _app_id: "Target app id.",
        _env: "Optional environment. Default: default."
      }
    },

    "apply-artifact-request": {
      _name: "apply-artifact-request",
      _scope: "module",
      _description:
        "Apply a structured artifact request intent through explicit server persistence without AI routing.",
      _params: {
        _app_id: "Target app id.",
        _env: "Target environment.",
        _artifact_type: "Artifact type. v1 supports entity.",
        _artifact_request: "Artifact request payload. v1 supports entity create.",
        _conversation_id: "Optional source conversation id.",
        _message_id: "Optional source message id."
      }
    },

    "append-flow-success-command": {
      _name: "append-flow-success-command",
      _scope: "module",
      _description:
        "Append a local XUI command to a persisted flow _on_success handler without changing the flow steps.",
      _params: {
        _app_id: "Target app id.",
        _env: "Target environment.",
        _flow_id: "Persisted flow id.",
        _command: "Local XUI command object to run after successful flow completion."
      }
    },

    "execute-execution-graph": {
      _name: "execute-execution-graph",
      _scope: "module",
      _description:
        "Re-plan and execute a supported XVibe execution graph through explicit artifact request persistence without AI routing.",
      _params: {
        _app_id: "Target app id.",
        _env: "Target environment.",
        _graph_type: "Execution graph type. v1 supports crud.",
        _entity_name: "Target entity name.",
        _execution_graph: "Optional client graph payload. Ignored by the server executor."
      }
    },

    "generate-app": {
      _name: "generate-app",
      _scope: "module",
      _description:
        "Create an app shell and orchestrate planner-driven artifact generation.",
      _params: {
        _prompt: "User prompt.",
        _app_id: "Target/generated app id.",
        _env: "Optional environment. Default: default."
      }
    },

    create_app_from_starter: {
      _name: "create_app_from_starter",
      _scope: "module",
      _description:
        "Create a mutable user app by copying a deterministic starter folder without AI generation.",
      _params: {
        _starter_id: "Starter id from system-xapps/app-starters.",
        _app_id: "Target app id.",
        _env: "Optional environment. Default: default.",
        _vision: "Optional user description stored in app metadata."
      }
    },

    "generate-module-spec": {
      _name: "generate-module-spec",
      _scope: "module",
      _description:
        "Generate a manifest-first XModule spec from a user prompt. The result is a spec only; module-creator validates, generates, and loads artifacts.",
      _params: {
        _prompt: "User request describing the desired server module capability.",
        _module_id: "Optional requested module id.",
        _module_name: "Optional requested module name.",
        _target: "Optional target. v1 should be server.",
        _context: "Optional app/runtime context.",
        _debug: "Optional debug flag."
      },
    },
    "get-latest-run": {
      _name: "get-latest-run",
      _scope: "module",
      _description:
        "Return safe diagnostic files for the latest archived vibe-run for an app/env, or a specific generation id.",
      _params: {
        _app_id: "Target app id.",
        _env: "Optional environment. Default: default.",
        _generation_id: "Optional generation id. When provided, loads that specific run."
      }
    },
    "create-conversation": {
      _name: "create-conversation",
      _scope: "module",
      _description:
        "Create deterministic JSON/JSONL conversation storage for an app/env without AI routing.",
      _params: {
        _app_id: "Target app id.",
        _env: "Optional environment. Default: default.",
        _conversation_id: "Optional safe conversation id.",
        _title: "Optional conversation title.",
        _metadata: "Optional JSON-compatible metadata."
      }
    },
    "list-conversations": {
      _name: "list-conversations",
      _scope: "module",
      _description:
        "List conversation summaries from the app/env conversation index.",
      _params: {
        _app_id: "Target app id.",
        _env: "Optional environment. Default: default."
      }
    },
    "get-conversation": {
      _name: "get-conversation",
      _scope: "module",
      _description:
        "Read a conversation document and its JSONL messages.",
      _params: {
        _app_id: "Target app id.",
        _env: "Optional environment. Default: default.",
        _conversation_id: "Conversation id."
      }
    },
    "append-message": {
      _name: "append-message",
      _scope: "module",
      _description:
      "Append one JSON-compatible message line to a conversation messages.jsonl file.",
      _params: {
        _app_id: "Target app id.",
        _env: "Optional environment. Default: default.",
        _conversation_id: "Conversation id.",
        _message: "Message object with _role and _text, or pass message fields at top level."
      }
    },
    "analyze-message": {
      _name: "analyze-message",
      _scope: "module",
      _description:
        "Analyze one conversation message with the XVibe Intent Engine stub and append the result to the conversation.",
      _params: {
        _app_id: "Target app id.",
        _env: "Target environment.",
        _conversation_id: "Conversation id.",
        _message_id: "Optional source message id.",
        _message: "Message text to analyze.",
        _runtime_context: "Optional runtime context for the intent engine."
      }
    },
    "get-last-messages": {
      _name: "get-last-messages",
      _scope: "module",
      _description:
      "Return the last N messages from a conversation JSONL file.",
      _params: {
        _app_id: "Target app id.",
        _env: "Optional environment. Default: default.",
        _conversation_id: "Conversation id.",
        _limit: "Optional number of messages. Default: 20."
      }
    },
    "update-conversation-action": {
      _name: "update-conversation-action",
      _scope: "module",
      _description:
        "Persist one conversation intent action execution state in messages.jsonl without XDB.",
      _params: {
        _app_id: "Target app id.",
        _env: "Target environment.",
        _conversation_id: "Conversation id.",
        _message_id: "Message id containing the intent action.",
        _action_id: "Action id inside message._intent._actions.",
        _status: "suggested, running, done, failed, or dismissed.",
        _result: "Optional JSON-compatible action result object.",
        _error: "Optional action error string.",
        _metadata: "Optional JSON-compatible action metadata object."
      }
    },
    "update-conversation-artifact": {
      _name: "update-conversation-artifact",
      _scope: "module",
      _description:
        "Persist one conversation artifact request status in messages.jsonl without executing it.",
      _params: {
        _app_id: "Target app id.",
        _env: "Target environment.",
        _conversation_id: "Conversation id.",
        _message_id: "Message id containing the artifact request intent.",
        _artifact_type: "Optional artifact type identity check.",
        _artifact_request: "Optional artifact request identity check.",
        _artifact_status: "done, failed, or dismissed.",
        _artifact_result: "Optional JSON-compatible artifact result object.",
        _artifact_error: "Optional artifact error string or JSON-compatible object."
      }
    },
    "sync-skills": {
      _name: "sync-skills",
      _scope: "module",
      _description:
        "Store runtime/client skill registry snapshots for XVibe knowledge selection.",
      _params: {
        _app_id: "App id that provided the skills.",
        _env: "Runtime environment.",
        _mode: "Runtime mode: system, build, or runtime.",
        _skills: "Runtime skills snapshot from _x.getSkills()."
      }
    }
  };
  private readonly selector: VibeKnowledgeSelector;
  private readonly prompt_builder: VibePromptBuilder;
  private readonly view_builder: VibeViewBuilder;
  private readonly output_parser: VibeOutputParser;
  private readonly planner: XVibePlanner;
  private readonly intent_planner: VibeIntentPlanner;
  private readonly behavior_planner: VibeBehaviorPlanner;
  private readonly intent_engine: XVibeIntentEngine;
  private readonly generation_manager: GenerationManager;
  private readonly artifact_executor: ArtifactExecutor;
  private readonly execution_graph_executor: ExecutionGraphExecutor;
  private readonly guide_recommendation_engine: GuideRecommendationEngine;
  private readonly guide_recommendation_cache =
    new Map<string, GuideRecommendationCacheEntry>();

  constructor() {
    super({ _name: XVibeModule._name });
    this.selector = new VibeKnowledgeSelector();
    this.prompt_builder = new VibePromptBuilder();
    this.view_builder = new VibeViewBuilder();
    this.output_parser = new VibeOutputParser();
    this.planner = new XVibePlanner();
    this.intent_planner = new VibeIntentPlanner();
    this.behavior_planner = new VibeBehaviorPlanner();
    this.intent_engine = new XVibeIntentEngine();
    this.generation_manager = new GenerationManager({
      _planner: this.planner,
      _generate_artifact: (params, forced_artifact_type) =>
        this.generate_artifact(params, forced_artifact_type),
      _broadcast_generation_failed:
        this.broadcast_generation_failed.bind(this),
      _structured_error_payload: structured_error_payload,
      _parser_diagnostic: parser_diagnostic,
      _parser_diagnostics: parser_diagnostics,
      _resolve_prompt: resolve_prompt,
      _read_optional_string: read_optional_string,
      _read_safe_path_segment: read_safe_path_segment,
      _explicit_error: explicit_error,
      _resolve_xvibe_task: resolve_xvibe_task,
      _read_existing_resolved_task: read_existing_resolved_task,
      _push_generation_stage: this.push_generation_stage.bind(this),
      _build_live_shell_view: this.build_live_shell_view.bind(this),
      _apply_view_scope_lock_to_app_plan: apply_view_scope_lock_to_app_plan,
      _apply_view_scope_lock: apply_view_scope_lock,
      _warn_if_plan_violates_resolved_task: warn_if_plan_violates_resolved_task,
      _create_intent_plan: this.create_intent_plan.bind(this),
      _ensure_server_module_for_intent:
        this.ensure_server_module_for_intent.bind(this),
      _log_intent_plan: this.log_intent_plan.bind(this),
      _build_execution_plan_for_intent:
        this.build_execution_plan_for_intent.bind(this),
      _build_artifact_generation_context:
        this.build_artifact_generation_context.bind(this),
      _generate_planned_artifacts:
        this.generate_planned_artifacts.bind(this),
    });
    this.artifact_executor = new ArtifactExecutor();
    this.execution_graph_executor = new ExecutionGraphExecutor(
      undefined,
      this.artifact_executor,
    );
    this.guide_recommendation_engine = new GuideRecommendationEngine();
  }

  override async onLoad() {
    _xlog.log("XVibe initialized ✅");
  }


  get_runtime_skills(
    app_id?: string,
    env?: string,
    mode?: string,
  ) {
    return this.generation_manager.getRuntimeSkills(app_id, env, mode);
  }

  private get_cached_guide_recommendation(
    cache_key: string | undefined,
  ): XVibeGuideRecommendation | null | undefined {
    if (!cache_key) return undefined;

    const cached = this.guide_recommendation_cache.get(cache_key);
    if (!cached) return undefined;

    if (cached._expires_at < Date.now()) {
      this.guide_recommendation_cache.delete(cache_key);
      return undefined;
    }

    return cached._recommendation;
  }

  private set_cached_guide_recommendation(input: {
    _cache_key: string | undefined;
    _recommendation: XVibeGuideRecommendation | null;
  }) {
    if (!input._cache_key) return;

    if (this.guide_recommendation_cache.size > 100) {
      this.guide_recommendation_cache.clear();
    }

    this.guide_recommendation_cache.set(input._cache_key, {
      _expires_at: Date.now() + GUIDE_RECOMMENDATION_CACHE_TTL_MS,
      _recommendation: input._recommendation,
    });
  }

  async getGuideRecommendation(input: {
    _app_id: string;
    _env?: string;
    _project_memory?: Partial<XVibeProjectMemory> | null;
    _runtime_assets?: Partial<XVibeRuntimeAssets> | null;
  }): Promise<XVibeGuideRecommendation | null> {
    const app_id = _xu.ensure_string(input._app_id, "_app_id");
    const env =
      typeof input._env === "string" && input._env.trim().length > 0
        ? input._env.trim()
        : DEFAULT_ENV;

    const has_project_memory_override =
      Object.prototype.hasOwnProperty.call(input, "_project_memory");
    const project_memory =
      has_project_memory_override
        ? (_xu.is_plain_object(input._project_memory)
          ? input._project_memory
          : undefined)
        : await RuntimeContextManager.loadProjectMemory({
          _app_id: app_id,
          _env: env,
        });

    const cache_key = guide_recommendation_cache_key({
      _app_id: app_id,
      _env: env,
      _project_memory: project_memory,
    });
    const cached_recommendation =
      this.get_cached_guide_recommendation(cache_key);
    if (cached_recommendation !== undefined) {
      return cached_recommendation;
    }

    const has_runtime_assets_override =
      Object.prototype.hasOwnProperty.call(input, "_runtime_assets");
    const runtime_assets =
      has_runtime_assets_override
        ? (_xu.is_plain_object(input._runtime_assets)
          ? input._runtime_assets
          : undefined)
        : await RuntimeContextManager.collectRuntimeAssets({
          _app_id: app_id,
          _env: env,
          _runtime_skills: this.get_runtime_skills(app_id, env),
        });

    const recommendation =
      this.guide_recommendation_engine.recommend({
        _project_memory: project_memory,
        _runtime_assets: runtime_assets,
      });

    if (recommendation) {
      _xlog.log("[xvibe] guide recommendation", {
        _title: recommendation._title,
        _reason: recommendation._reason,
        _priority: recommendation._priority,
      });
      if (
        !project_memory_has_achievement(
          project_memory,
          "first-guide-recommendation",
        )
      ) {
        const achievement_result = await record_project_memory_achievement({
          _app_id: app_id,
          _env: env,
          _achievement_id: "first-guide-recommendation",
        });
        const achievement_cache_key = guide_recommendation_cache_key({
          _app_id: app_id,
          _env: env,
          _project_memory: achievement_result?._memory,
        });
        this.set_cached_guide_recommendation({
          _cache_key: achievement_cache_key,
          _recommendation: recommendation,
        });
      }
    }

    this.set_cached_guide_recommendation({
      _cache_key: cache_key,
      _recommendation: recommendation,
    });

    return recommendation;
  }

  private async record_crud_milestone_completion(input: {
    _app_id: string;
    _env: string;
    _entity_name: string;
    _result: unknown;
  }): Promise<void> {
    if (!_xu.is_plain_object(input._result)) return;
    if (input._result._ok !== true) return;
    if (!_xu.is_plain_object(input._result._summary)) return;
    if (input._result._summary._failed !== 0) return;

    const entity_id = _xu.normalize_id(input._entity_name);
    if (!entity_id) return;

    try {
      const memory_response = await _x.execute({
        _module: "server-xvm",
        _op: "get-project-memory",
        _params: {
          _app_id: input._app_id,
          _env: input._env,
        },
      } as any);

      if (_xu.is_plain_object(memory_response) && memory_response._ok === false) {
        return;
      }

      const memory = extract_project_memory(memory_response);
      if (!memory) return;

      const completion = complete_project_memory_focus_milestone_item({
        _memory: memory,
        _item_id: `${entity_id}-crud`,
      });
      if (!completion._completed) return;

      const patch_response = await _x.execute({
        _module: "server-xvm",
        _op: "patch-project-memory",
        _params: {
          _app_id: input._app_id,
          _env: input._env,
          _patch: {
            _milestones: completion._memory._milestones,
          },
        },
      } as any);

      if (_xu.is_plain_object(patch_response) && patch_response._ok === false) {
        return;
      }

      _xlog.log("[xvibe] project memory milestone item completed", {
        _app_id: input._app_id,
        _env: input._env,
        _milestone_id: completion._milestone?._id,
        _item_id: completion._item?._id,
      });
    } catch (error) {
      _xlog.log("[xvibe] project memory milestone item completion skipped", {
        _app_id: input._app_id,
        _env: input._env,
        _entity_name: entity_id,
        _error: error_summary(error),
      });
    }
  }

  private resolve_starters_root(): string {
    const get_module =
      (_x as unknown as { getModule?: (name: string) => unknown }).getModule;

    if (typeof get_module === "function") {
      const server_xvm =
        get_module.call(_x, "server-xvm");
      const system_xapps_path =
        _xu.is_plain_object(server_xvm) &&
          typeof server_xvm._system_xapps_path === "string" &&
          server_xvm._system_xapps_path.trim().length > 0
          ? server_xvm._system_xapps_path.trim()
          : undefined;

      if (system_xapps_path) {
        const starters_root =
          path.resolve(system_xapps_path, "app-starters");

        _xlog.log("[xvibe] starters root resolved", {
          _source: "server-xvm",
          _path: starters_root,
        });

        if (
          !fs.existsSync(starters_root) ||
          !fs.statSync(starters_root).isDirectory()
        ) {
          throw_explicit_error(XVIBE_STARTER_NOT_FOUND, "Configured starters folder not found", {
            _path: starters_root,
          });
        }

        return starters_root;
      }
    }

    const fallback_root =
      path.resolve(XVIBE_PACKAGE_ROOT, "system-xapps", "app-starters");

    _xlog.log("[xvibe] starters root resolved", {
      _source: "fallback",
      _path: fallback_root,
    });

    return fallback_root;
  }

  private resolve_starter_source_dir(starter_id: string): string {
    const starters_root = this.resolve_starters_root();
    const starter_dir = path.resolve(starters_root, starter_id);
    assert_path_inside(
      starters_root,
      starter_dir,
      XVIBE_INVALID_STARTER_ID,
      "Invalid '_starter_id': path traversal is not allowed",
    );

    _xlog.log("[xvibe] starter resolved", {
      _starter_id: starter_id,
      _path: starter_dir,
    });

    return starter_dir;
  }

  private refresh_runtime_skills_after_module_creation(
    app_id: string,
    env: string,
    mode: string,
  ): unknown {
    return this.generation_manager.refreshRuntimeSkillsAfterModuleCreation(
      app_id,
      env,
      mode,
    );
  }

  private module_requirement_from_intent(
    intent_plan: VibeIntentPlan,
  ): XVibeServerModuleRequirement | undefined {
    if (
      intent_plan._requires_module !== true ||
      intent_plan._module_target !== "server" ||
      typeof intent_plan._module_name !== "string" ||
      intent_plan._module_name.trim().length === 0 ||
      intent_plan._module_ops.length === 0
    ) {
      return undefined;
    }

    return {
      _module_target: "server",
      _module_name: intent_plan._module_name.trim(),
      _module_ops: intent_plan._module_ops,
      ...(intent_plan._module_reason ? { _module_reason: intent_plan._module_reason } : {}),
    };
  }

  private build_server_module_spec(
    requirement: XVibeServerModuleRequirement,
  ): XVibeModuleCreatorSpec {
    const op_specs = requirement._module_ops.map((op_name) => {
      if (
        requirement._module_name === "calc" &&
        CALC_SAFE_EVALUATION_OPS.has(op_name)
      ) {
        return {
          _name: op_name,
          _description:
            "Evaluate a safe arithmetic expression containing only numbers, spaces, +, and -.",
          _params: {
            expression: "Expression string. Supports numbers, spaces, +, and - only.",
            _xdata_key: "Optional XData key to read expression from when expression is not provided.",
            _output_key: "Optional XData key where result should be written."
          },
          _result: {
            result: "Numeric evaluation result."
          }
        };
      }

      return {
        _name: op_name,
        _description: `Generated operation '${op_name}' for module '${requirement._module_name}'.`,
        _params: {
          _input: "Optional input payload."
        }
      };
    });

    const op_behaviors =
      requirement._module_name === "calc"
        ? requirement._module_ops.reduce<Record<string, string>>((behaviors, op_name) => {
          if (CALC_SAFE_EVALUATION_OPS.has(op_name)) {
            behaviors[op_name] = "safe_arithmetic_add_sub";
          }
          return behaviors;
        }, {})
        : {};

    return {
      _id: requirement._module_name,
      _name: requirement._module_name,
      _target: "server",
      _description:
        requirement._module_reason ??
        `Generated server module '${requirement._module_name}'.`,
      _version: "0.1.0",
      _imports: [
        {
          _from: "@xpell/node"
        }
      ],
      _permissions: [],
      _ops: op_specs,
      _meta: {
        _xvibe: {
          _module_requirement: requirement,
        },
        ...(Object.keys(op_behaviors).length > 0
          ? {
            _op_behaviors: op_behaviors
          }
          : {}),
      },
    };
  }

  private async implement_generated_module_from_spec(input: {
    spec: XVibeModuleCreatorSpec;
    user_request: string;
    project_memory?: unknown;
    current_or_generated_view?: unknown;
    originating_view?: unknown;
    server_module_call_graph?: XVibeServerModuleCallGraph;
    _allow_skeleton_fallback?: boolean;
    _progress?: XVibeGenerationProgressCallback;
    _archive?: XVibeRunArchiveData;
  }): Promise<unknown> {
    const module_ops =
      input.spec._ops.map((op) => op._name);
    const current_or_generated_view =
      input.current_or_generated_view ?? input.originating_view;
    const server_module_call_graph =
      input.server_module_call_graph ??
      (current_or_generated_view !== undefined
        ? view_server_module_calls_to_data(
          collect_view_server_module_calls(current_or_generated_view)
        )
        : {});

    _xlog.log("[xvibe] generated module implementation requested", {
      _module_name: input.spec._name,
      _module_ops: module_ops,
    });

    _xlog.log("[xvibe] module implementation context", {
      _original_user_prompt: input.user_request,
      _module_name: input.spec._name,
      _module_ops: module_ops,
      _server_module_call_graph: server_module_call_graph,
      ...(current_or_generated_view !== undefined
        ? { _current_or_generated_view: current_or_generated_view }
        : {}),
    });

    let validation_errors: unknown;
    const rejected_attempts: XVibeGeneratedModuleRejectedAttempt[] =
      [];

    for (
      let attempt = 1;
      attempt <= GENERATED_MODULE_IMPLEMENTATION_MAX_ATTEMPTS;
      attempt++
    ) {
      _xlog.log("[module-creator] implementation attempt started", {
        _module_name: input.spec._name,
        _module_ops: module_ops,
        _attempt: attempt,
        _max_attempts: GENERATED_MODULE_IMPLEMENTATION_MAX_ATTEMPTS,
      });
      input._progress?.(
        "module-implementing",
        "Implementing module...",
        {
          _module_name: input.spec._name,
          _module_ops: module_ops,
          _attempt: attempt,
        },
      );

      const implementation_prompt =
        build_generated_module_implementation_prompt({
          spec: input.spec,
          user_request: input.user_request,
          ...(input.project_memory !== undefined
            ? { project_memory: input.project_memory }
            : {}),
          server_module_call_graph,
          ...(current_or_generated_view !== undefined
            ? { current_or_generated_view }
            : {}),
          ...(validation_errors !== undefined
            ? { validation_errors }
            : {}),
          ...(rejected_attempts.length > 0
            ? { rejected_attempts }
            : {}),
        });
      const attempt_archive: XVibeJsonObject = {
        _attempt: attempt,
        _module_name: input.spec._name,
        _module_ops: module_ops,
        _implementation_prompt: implementation_prompt,
      };
      const archive = input._archive;
      const archive_validation =
        archive && _xu.is_plain_object(archive._validation)
          ? archive._validation as XVibeRunValidationArchive
          : undefined;
      if (archive_validation) {
        archive_validation._implementation_attempts =
          archive_validation._implementation_attempts ?? [];
        archive_validation._implementation_attempts.push(attempt_archive);
      }
      if (archive) {
        archive._final_prompt = implementation_prompt;
      }

      if (attempt > 1) {
        _xlog.log("[module-creator] implementation retry prompt prepared", {
          _module_name: input.spec._name,
          _module_ops: module_ops,
          _attempt: attempt,
          _previous_attempts: rejected_attempts.length,
          _validation_errors: validation_errors,
        });
      }

      let implementation_sources: XVibeGeneratedModuleImplementationSources | undefined;

      try {
        const xai_response =
          await _x.execute({
            _module: "xai",
            _op: "generate",
            _params: {
              _prompt: implementation_prompt,
              response_format: {
                type: "json_object",
              },
            },
          } as any);
        attempt_archive._raw_ai_response = xai_response;
        if (archive) {
          archive._ai_output = xai_response;
        }
        const xai_result =
          unwrap_command_result(
            xai_response,
          );

        implementation_sources =
          parse_generated_module_implementation_methods(xai_result);
        attempt_archive._parsed_method_sources =
          implementation_sources._method_sources;
        attempt_archive._parsed_helper_sources =
          implementation_sources._helper_sources;
      } catch (error) {
        validation_errors = {
          _ok: false,
          _error: {
            _code: "E_XVIBE_GENERATED_MODULE_IMPLEMENTATION_SHAPE",
            _message: error instanceof Error ? error.message : String(error),
            _category: "syntax_or_shape_error",
          },
        };
        attempt_archive._validation_result = validation_errors;
        attempt_archive._rejection_category = "syntax_or_shape_error";

        rejected_attempts.push({
          _attempt: attempt,
          _category: "syntax_or_shape_error",
          _validation_errors: validation_errors,
        });

        _xlog.warn("[module-creator] implementation validation failed", {
          _module_name: input.spec._name,
          _module_ops: module_ops,
          _attempt: attempt,
          _validation_errors: validation_errors,
        });

        continue;
      }

      _xlog.log("[xvibe] generated module implementation received", {
        _module_name: input.spec._name,
        _methods: Object.keys(implementation_sources._method_sources),
        _method_sources: implementation_sources._method_sources,
        _helper_sources: implementation_sources._helper_sources,
      });

      let implementation_response: unknown;

      try {
        input._progress?.(
          "module-validating",
          "Validating module...",
          {
            _module_name: input.spec._name,
            _module_ops: module_ops,
            _attempt: attempt,
          },
        );
        implementation_response =
          await _x.execute({
            _module: "module-creator",
            _op: "implement-generated-module",
            _params: {
              _id: input.spec._id,
              _implementation_request: input.user_request,
              _context: {
                _methods: implementation_sources._method_sources,
                _method_sources: implementation_sources._method_sources,
                _helper_sources: implementation_sources._helper_sources,
              },
            },
          } as any);
        attempt_archive._implementation_response =
          implementation_response;
      } catch (error) {
        validation_errors = {
          _ok: false,
          _error: {
            _code: "E_XVIBE_GENERATED_MODULE_IMPLEMENTATION_APPLY_FAILED",
            _message: error instanceof Error ? error.message : String(error),
            _category: "unknown",
          },
        };
        attempt_archive._validation_result = validation_errors;
        attempt_archive._rejection_category = "unknown";

        rejected_attempts.push({
          _attempt: attempt,
          _category: "unknown",
          _validation_errors: validation_errors,
          _method_sources: implementation_sources._method_sources,
          _method_source_excerpts: method_source_excerpts(implementation_sources._method_sources),
          _helper_sources: implementation_sources._helper_sources,
          _helper_source_excerpts: method_source_excerpts(implementation_sources._helper_sources),
        });

        _xlog.warn("[module-creator] implementation validation failed", {
          _module_name: input.spec._name,
          _module_ops: module_ops,
          _attempt: attempt,
          _category: "unknown",
          _validation_errors: validation_errors,
        });

        continue;
      }

      const implementation_result =
        _xu.is_plain_object(implementation_response) && implementation_response._ok === false
          ? implementation_response
          : unwrap_command_result(
            implementation_response
          );

      if (_xu.is_plain_object(implementation_result) && implementation_result._ok === false) {
        validation_errors = implementation_result;
        const category =
          classify_implementation_validation_failure(implementation_result);
        attempt_archive._validation_result = implementation_result;
        attempt_archive._rejection_category = category;

        rejected_attempts.push({
          _attempt: attempt,
          _category: category,
          _validation_errors: implementation_result,
          _method_sources: implementation_sources._method_sources,
          _method_source_excerpts: method_source_excerpts(implementation_sources._method_sources),
          _helper_sources: implementation_sources._helper_sources,
          _helper_source_excerpts: method_source_excerpts(implementation_sources._helper_sources),
        });

        _xlog.warn("[module-creator] implementation validation failed", {
          _module_name: input.spec._name,
          _module_ops: module_ops,
          _attempt: attempt,
          _category: category,
          _validation_errors: validation_errors,
        });

        continue;
      }

      _xlog.log("[module-creator] implementation attempt passed", {
        _module_name: input.spec._name,
        _module_ops: module_ops,
        _attempt: attempt,
        _result: implementation_result,
      });
      attempt_archive._validation_result = implementation_result;

      _xlog.log("[xvibe] generated module implementation applied", {
        _module_name: input.spec._name,
        _result: implementation_result,
      });

      return implementation_result;
    }

    const failure =
      structured_implementation_attempt_error({
        module_name: input.spec._name,
        module_ops,
        attempts: rejected_attempts,
      });

    _xlog.warn("[module-creator] implementation attempts exhausted", {
      _module_name: input.spec._name,
      _module_ops: module_ops,
      _max_attempts: GENERATED_MODULE_IMPLEMENTATION_MAX_ATTEMPTS,
      _attempts: rejected_attempts,
    });

    if (input._allow_skeleton_fallback === true) {
      _xlog.warn("[xvibe] generated module implementation failed; using explicitly requested skeleton module", {
        _module_name: input.spec._name,
        _failure: failure,
      });

      return {
        _implemented: false,
        _fallback: "skeleton",
        _failure: failure,
      };
    }

    throw new XVibeStructuredError(failure);
  }

  private async ensure_server_module_for_intent(input: {
    app_id: string;
    env: string;
    runtime_mode: string;
    prompt: string;
    intent_plan: VibeIntentPlan;
    _progress?: XVibeGenerationProgressCallback;
    _archive?: XVibeRunArchiveData;
  }): Promise<XVibeServerModuleEnsureResult> {
    if (
      input.intent_plan._requires_module === true &&
      input.intent_plan._module_target === "client"
    ) {
      _xlog.warn("[xvibe] client module requirement unsupported", {
        _module_name: input.intent_plan._module_name,
        _module_ops: input.intent_plan._module_ops,
      });
      return {
        _intent_plan: input.intent_plan,
        _module_ops: [],
      };
    }

    const requirement =
      this.module_requirement_from_intent(input.intent_plan);

    if (!requirement) {
      return {
        _intent_plan: input.intent_plan,
        ...(input.intent_plan._module_name
          ? { _module_name: input.intent_plan._module_name }
          : {}),
        _module_ops: input.intent_plan._module_ops,
        _available:
          Boolean(
            input.intent_plan._module_name &&
            input.intent_plan._modules.includes(input.intent_plan._module_name)
          ),
      };
    }

    _xlog.log("[xvibe] module requirement detected", {
      _module_target: requirement._module_target,
      _module_name: requirement._module_name,
      _module_ops: requirement._module_ops,
      ...(requirement._module_reason ? { _module_reason: requirement._module_reason } : {}),
    });
    input._progress?.(
      "module-planning",
      "Planning module...",
      {
        _module_name: requirement._module_name,
        _module_ops: requirement._module_ops,
      },
    );

    const spec =
      this.build_server_module_spec(requirement);

    _xlog.log("[xvibe] creating server module", {
      _module_name: spec._name,
      _module_ops: spec._ops.map((op) => op._name),
    });
    const module_create_started_at = Date.now();
    input._progress?.(
      "module-creating",
      "Creating module...",
      {
        _module_name: spec._name,
        _module_ops: spec._ops.map((op) => op._name),
      },
    );

    const create_result = unwrap_command_result(
      await _x.execute({
        _module: "module-creator",
        _op: "create-module-spec",
        _params: {
          _spec: spec
        },
      } as any)
    );

    const module_implement_started_at = Date.now();
    const implementation_result =
      await this.implement_generated_module_from_spec({
        spec,
        user_request: input.prompt,
        project_memory:
          await RuntimeContextManager.loadProjectMemory({
            _app_id: input.app_id,
            _env: input.env,
          }),
        server_module_call_graph: {},
        _progress: input._progress,
        _archive: input._archive,
      });

    input._progress?.(
      "module-loading",
      "Loading module...",
      {
        _module_name: spec._name,
        _module_ops: spec._ops.map((op) => op._name),
        _duration_ms: Date.now() - module_implement_started_at,
        _create_duration_ms: module_implement_started_at - module_create_started_at,
      },
    );
    const load_result = unwrap_command_result(
      await _x.execute({
        _module: "module-creator",
        _op: "load-generated-module",
        _params: {
          _id: spec._id
        },
      } as any)
    );

    _xlog.log("[xvibe] module creator result", {
      _create_result: create_result,
      _implementation_result: implementation_result,
      _load_result: load_result,
    });

    _xlog.log("[xvibe] server module created", {
      _module_name: spec._name,
      _module_ops: spec._ops.map((op) => op._name),
    });

    const runtime_skills =
      this.refresh_runtime_skills_after_module_creation(
        input.app_id,
        input.env,
        input.runtime_mode,
      );
    const runtime_capabilities =
      this.intent_planner.extract_runtime_capabilities(runtime_skills);

    const normalized_intent_plan =
      this.intent_planner.normalize_intent_plan(
        {
          ...input.intent_plan,
          _requires_module: false,
          _module_target: null,
          _modules: [
            ...input.intent_plan._modules,
            spec._name,
          ],
        },
        runtime_capabilities,
        input.intent_plan,
      );

    return {
      _intent_plan: normalized_intent_plan,
      _module_name: spec._name,
      _module_ops: spec._ops.map((op) => op._name),
      _created:
        _xu.is_plain_object(create_result) &&
        create_result._ok === true &&
        create_result._saved === true,
      _available:
        _xu.is_plain_object(load_result)
          ? load_result._ok === true || load_result._loaded === true
          : true,
    };
  }

  private async execute_module_generation_route(input: {
    app_id: string;
    env: string;
    runtime_mode: string;
    prompt: string;
    runtime_skills: unknown;
    resolved_task: XVibeResolvedTask;
    generation_id: string;
    _progress?: XVibeGenerationProgressCallback;
  }): Promise<unknown> {
    const archive_started_at = Date.now();
    const archive_validation: XVibeRunValidationArchive = {
      _implementation_attempts: [],
    };
    const project_memory =
      await RuntimeContextManager.loadProjectMemory({
        _app_id: input.app_id,
        _env: input.env,
      });
    const archive: XVibeRunArchiveData = {
      _generation_id: input.generation_id,
      _app_id: input.app_id,
      _env: input.env,
      _mode: "full",
      _artifact_type: "module",
      _resolved_task: input.resolved_task,
      _created_at: new Date().toISOString(),
      _user_prompt: input.prompt,
      _runtime_context: {
        _runtime_mode: input.runtime_mode,
        _runtime_skills: input.runtime_skills,
        ...(project_memory !== undefined
          ? { _project_memory: project_memory }
          : {}),
      },
      _validation: archive_validation,
    };
    archive._runtime_plan =
      build_xvibe_runtime_plan({
        _runtime_assets: {
          _views: [],
          _flows: [],
          _entities: [],
          _modules: [],
        },
        _runtime_skills: input.runtime_skills,
        _resolved_task: input.resolved_task,
      });
    const module_name =
      typeof input.resolved_task._module_name === "string" &&
      input.resolved_task._module_name.trim().length > 0
        ? input.resolved_task._module_name.trim()
        : undefined;
    const module_ops =
      Array.isArray(input.resolved_task._module_ops)
        ? input.resolved_task._module_ops
        : [];
    archive._module_plan = {
      _artifact_type: "module",
      ...(module_name ? { _module_name: module_name } : {}),
      _module_ops: module_ops,
      _source: "resolved_task",
    };
    const module_progress: XVibeGenerationProgressCallback =
      (stage_name, message, details = {}) => {
        RunArchiveManager.recordStage(
          archive,
          archive_started_at,
          stage_name,
          message,
          {
            _artifact_type: "module",
            ...details,
          },
        );
        input._progress?.(stage_name, message, details);
      };

    try {
      if (!module_name) {
        const result =
          module_generation_requirement_error_result({
            _code: "E_XVIBE_MODULE_NAME_REQUIRED",
            _resolved_task: input.resolved_task,
          });
        archive._result = {
          _success: false,
          _artifact_type: "module",
          _module_ops: module_ops,
          _error: result._error,
        };
        RunArchiveManager.recordStage(
          archive,
          archive_started_at,
          "failed",
          "Module generation failed",
          {
            _artifact_type: "module",
            _module_ops: module_ops,
            _error: result._error,
          },
        );
        return result;
      }

      if (module_ops.length === 0) {
        const result =
          module_generation_requirement_error_result({
            _code: "E_XVIBE_MODULE_OPS_REQUIRED",
            _resolved_task: input.resolved_task,
          });
        archive._result = {
          _success: false,
          _artifact_type: "module",
          _module_name: module_name,
          _module_ops: module_ops,
          _error: result._error,
        };
        RunArchiveManager.recordStage(
          archive,
          archive_started_at,
          "failed",
          "Module generation failed",
          {
            _artifact_type: "module",
            _module_name: module_name,
            _module_ops: module_ops,
            _error: result._error,
          },
        );
        return result;
      }

      const runtime_capabilities =
        this.intent_planner.extract_runtime_capabilities(input.runtime_skills);
      const intent_plan =
        this.intent_planner.enforce_module_intent_plan(
          create_module_intent_plan_from_resolved_task(
            input.resolved_task,
            input.prompt,
            runtime_capabilities,
          ),
        );
      archive._intent_plan = intent_plan;
      archive._module_plan = {
        _artifact_type: "module",
        _module_target: intent_plan._module_target,
        _module_name: intent_plan._module_name,
        _module_ops: intent_plan._module_ops,
        _source: "resolved_task",
      };
      const validation_plan =
        validate_xvibe_generation_plan({
          resolved_task: input.resolved_task,
          artifact_plan: archive._module_plan,
          intent_plan,
          runtime_plan: archive._runtime_plan,
        });
      archive._validation_plan = validation_plan;
      _xlog.log("[xvibe] validation plan", validation_plan);
      if (!validation_plan._ok) {
        const result =
          validation_plan_error_result({
            _validation_plan: validation_plan,
            _resolved_task: input.resolved_task,
          });
        archive._result = {
          _success: false,
          _artifact_type: "module",
          _module_name: module_name,
          _module_ops: module_ops,
          _error: result._error,
        };
        RunArchiveManager.recordStage(
          archive,
          archive_started_at,
          "failed",
          "Generation plan validation failed",
          {
            _artifact_type: "module",
            _module_name: module_name,
            _module_ops: module_ops,
            _validation_plan: validation_plan,
          },
        );
        return result;
      }

      _xlog.log("[xvibe] module execution route", {
        _module_name: intent_plan._module_name,
        _module_ops: intent_plan._module_ops,
      });
      _xlog.log("[xvibe] module generation bypassed artifact planner");

      const module_ensure_result =
        await this.ensure_server_module_for_intent({
          app_id: input.app_id,
          env: input.env,
          runtime_mode: input.runtime_mode,
          prompt: input.prompt,
          intent_plan,
          _progress: module_progress,
          _archive: archive,
        });

      if (!module_ensure_result._module_name) {
        throw new Error("Unable to infer module requirement from prompt");
      }

      _xlog.log("[xvibe] module-only request completed", {
        _module_name: module_ensure_result._module_name,
        _module_ops: module_ensure_result._module_ops,
        _created: module_ensure_result._created,
        _available: module_ensure_result._available,
      });

      archive._intent_plan = module_ensure_result._intent_plan;
      warn_if_plan_violates_resolved_task(
        input.resolved_task,
        module_ensure_result._intent_plan,
      );
      archive._result = {
        _success: true,
        _artifact_type: "module",
        _module_name: module_ensure_result._module_name,
        _module_ops: module_ensure_result._module_ops,
        ...(module_ensure_result._created !== undefined
          ? { _created: module_ensure_result._created }
          : {}),
        ...(module_ensure_result._available !== undefined
          ? { _available: module_ensure_result._available }
          : {}),
      };

      return {
        _ok: true,
        _result: {
          _artifact_type: "module",
          _module_name: module_ensure_result._module_name,
          _module_ops: module_ensure_result._module_ops,
          ...(module_ensure_result._created !== undefined
            ? { _created: module_ensure_result._created }
            : {}),
          ...(module_ensure_result._available !== undefined
            ? { _available: module_ensure_result._available }
            : {}),
        },
      };
    } catch (error) {
      archive._result = {
        _success: false,
        _artifact_type: "module",
        ...(module_name ? { _module_name: module_name } : {}),
        _module_ops: module_ops,
        _error: error_summary(error),
        _attempts: archive_validation._implementation_attempts ?? [],
      };
      RunArchiveManager.recordStage(
        archive,
        archive_started_at,
        "failed",
        "Module generation failed",
        {
          _artifact_type: "module",
          ...(module_name ? { _module_name: module_name } : {}),
          _module_ops: module_ops,
          _error: error_summary(error),
        },
      );
      input._progress?.(
        "failed",
        "Module generation failed",
        {
          ...(module_name ? { _module_name: module_name } : {}),
          _module_ops: module_ops,
          _error: error_summary(error),
        },
      );
      this.broadcast_generation_failed(
        {
          _app_id: input.app_id,
          _env: input.env,
          _generation_id: input.generation_id,
        },
        error,
        "E_VIBE_AI_GENERATE_MODULE",
      );

      return {
        _ok: false,
        _error: {
          _code: "E_VIBE_AI_GENERATE_MODULE",
          _message: error instanceof Error ? error.message : String(error),
          ...(module_name ? { _module_name: module_name } : {}),
          _module_ops: module_ops,
        },
      };
    } finally {
      archive._duration_ms = Date.now() - archive_started_at;
      RunArchiveManager.archiveVibeRun(archive);
    }
  }

  private async ensure_missing_server_modules_from_view(input: {
    app_id: string;
    env: string;
    runtime_mode: string;
    prompt: string;
    view: XVibeJsonObject;
    runtime_skills: unknown;
    _progress?: XVibeGenerationProgressCallback;
  }): Promise<XVibeViewServerModuleEnsureResult> {
    const calls =
      collect_view_server_module_calls(input.view);

    if (calls.size === 0) {
      return {
        _runtime_skills: input.runtime_skills,
        _created_modules: [],
      };
    }

    _xlog.log("[xvibe] view server module calls detected", {
      _calls: view_server_module_calls_to_data(calls),
    });

    const registry =
      collect_runtime_registry(input.runtime_skills);
    const created_modules: string[] = [];

    for (const [module_name, ops] of calls.entries()) {
      if (BUILTIN_SERVER_MODULES.has(module_name)) {
        continue;
      }

      if (runtime_registry_has_module(module_name, registry)) {
        continue;
      }

      const requirement: XVibeServerModuleRequirement = {
        _module_target: "server",
        _module_name: module_name,
        _module_ops: [...ops].sort(),
        _module_reason: "Generated view references this server module via xvm.call-server.",
      };
      input._progress?.(
        "module-planning",
        "Planning module...",
        {
          _module_name: requirement._module_name,
          _module_ops: requirement._module_ops,
        },
      );
      const spec =
        this.build_server_module_spec(requirement);

      _xlog.log("[xvibe] creating missing server module from view wiring", {
        _module_name: spec._name,
        _module_ops: spec._ops.map((op) => op._name),
      });
      const module_create_started_at = Date.now();
      input._progress?.(
        "module-creating",
        "Creating module...",
        {
          _module_name: spec._name,
          _module_ops: spec._ops.map((op) => op._name),
        },
      );

      const create_result = unwrap_command_result(
        await _x.execute({
          _module: "module-creator",
          _op: "create-module-spec",
          _params: {
            _spec: spec,
          },
        } as any),
      );

      input._progress?.(
        "module-loading",
        "Loading module...",
        {
          _module_name: spec._name,
          _module_ops: spec._ops.map((op) => op._name),
          _create_duration_ms: Date.now() - module_create_started_at,
        },
      );
      const load_result = unwrap_command_result(
        await _x.execute({
          _module: "module-creator",
          _op: "load-generated-module",
          _params: {
            _id: spec._id,
          },
        } as any),
      );

      _xlog.log("[xvibe] module creator result", {
        _module_name: spec._name,
        _create_result: create_result,
        _load_result: load_result,
      });

      registry._modules.add(spec._name);
      created_modules.push(spec._name);
    }

    if (created_modules.length === 0) {
      _xlog.log("[xvibe] view server module calls satisfied", {
        _calls: view_server_module_calls_to_data(calls),
      });

      return {
        _runtime_skills: input.runtime_skills,
        _created_modules: [],
      };
    }

    const refreshed_runtime_skills =
      this.refresh_runtime_skills_after_module_creation(
        input.app_id,
        input.env,
        input.runtime_mode,
      );
    const runtime_skills =
      merge_runtime_skill_payloads(
        input.runtime_skills,
        refreshed_runtime_skills,
      );

    return {
      _runtime_skills: runtime_skills,
      _created_modules: created_modules,
    };
  }

  private push_generation_stage(
    app_id: string,
    env: string,
    stage: string,
    message: string,
    generation_id?: string,
    details: XVibeJsonObject = {},
  ) {
    try {
      wsBroadcastScoped(app_id, env, {
        _name: "vibe:generation-stage",
        _args: [{
          ...details,
          _app_id: app_id,
          _env: env,
          _stage: stage,
          _message: message,
          ...(generation_id ? { _generation_id: generation_id } : {}),
        }],
      });

      _xlog.log("[xvibe] generation event emitted", {
        ...(generation_id ? { _generation_id: generation_id } : {}),
        _artifact_type:
          typeof details._artifact_type === "string"
            ? details._artifact_type
            : undefined,
        _stage: stage,
      });
    } catch (error) {
      _xlog.error("[xvibe] generation stage broadcast failed", {
        _app_id: app_id,
        _env: env,
        _stage: stage,
        ...(generation_id ? { _generation_id: generation_id } : {}),
        _error: error_summary(error),
      });
    }
  }

  private push_generation_archive_stage(input: {
    archive?: XVibeRunArchiveData;
    started_at?: number;
    app_id: string;
    env: string;
    stage: string;
    message: string;
    generation_id?: string;
    details?: Record<string, unknown>;
  }): void {
    RunArchiveManager.recordStage(
      input.archive,
      input.started_at,
      input.stage,
      input.message,
      input.details,
    );

    this.push_generation_stage(
      input.app_id,
      input.env,
      input.stage,
      input.message,
      input.generation_id,
      input.details as XVibeJsonObject | undefined,
    );
  }

  private push_generation_complete(input: {
    app_id: string;
    env: string;
    artifact_type: string;
    artifact_id: string;
    message: string;
    generation_id?: string;
    details?: XVibeJsonObject;
  }): void {
    const payload = {
      ...(input.details ?? {}),
      _app_id: input.app_id,
      _env: input.env,
      _artifact_type: input.artifact_type,
      _artifact_id: input.artifact_id,
      _message: input.message,
      ...(input.generation_id ? { _generation_id: input.generation_id } : {}),
    };

    try {
      wsBroadcastScoped(input.app_id, input.env, {
        _name: "vibe:generation-complete",
        _args: [payload],
      });

      _xlog.log("[xvibe] generation event emitted", {
        ...(input.generation_id ? { _generation_id: input.generation_id } : {}),
        _artifact_type: input.artifact_type,
        _stage: "complete",
      });
    } catch (error) {
      _xlog.error("[xvibe] generation complete broadcast failed", {
        _app_id: input.app_id,
        _env: input.env,
        _artifact_type: input.artifact_type,
        _artifact_id: input.artifact_id,
        ...(input.generation_id ? { _generation_id: input.generation_id } : {}),
        _error: error_summary(error),
      });
    }
  }

  private broadcast_generation_failed(
    params: XVibeJsonObject,
    error: unknown,
    fallback_code: string,
  ) {
    const app_id =
      typeof params._app_id === "string" && params._app_id.trim()
        ? params._app_id.trim()
        : undefined;
    if (!app_id) return;

    const env =
      typeof params._env === "string" && params._env.trim()
        ? params._env.trim()
        : DEFAULT_ENV;
    const generation_id =
      typeof params._generation_id === "string" && params._generation_id.trim()
        ? params._generation_id.trim()
        : undefined;
    const view_id =
      typeof params._view_id === "string" && params._view_id.trim()
        ? params._view_id.trim()
        : undefined;
    const structured = structured_error_payload(error);
    const structured_error =
      structured && _xu.is_plain_object(structured._error)
        ? structured._error as XVibeJsonObject
        : undefined;
    const diagnostic = parser_diagnostic(error);
    const diagnostics = parser_diagnostics(error);
    const message =
      typeof structured_error?._message === "string"
        ? structured_error._message
        : error instanceof Error
          ? error.message
          : String(error);
    const details =
      structured_error?._details ??
      (diagnostics ? { _diagnostics: diagnostics } : undefined) ??
      (diagnostic ? { _diagnostic: diagnostic } : undefined);

    const payload = {
      _app_id: app_id,
      _env: env,
      ...(view_id ? { _view_id: view_id } : {}),
      ...(generation_id ? { _generation_id: generation_id } : {}),
      _code:
        typeof structured_error?._code === "string"
          ? structured_error._code
          : fallback_code,
      _message: message,
      ...(details !== undefined ? { _details: details } : {}),
    };

    wsBroadcastScoped(app_id, env, {
      _name: "vibe:generation-failed",
      _args: [payload],
    });

    _xlog.log("[xvibe] generation failed event broadcast", {
      _app_id: app_id,
      _env: env,
      ...(view_id ? { _view_id: view_id } : {}),
      ...(generation_id ? { _generation_id: generation_id } : {}),
      _code: payload._code,
    });
  }

  private finalize_early_generation_failure(input: {
    params: XVibeJsonObject;
    app_id: string;
    env: string;
    generation_id?: string;
    prompt: string;
    artifact_type: string;
    result: XVibeJsonObject;
    fallback_code: string;
    resolved_task?: XVibeResolvedTask;
    artifact_plan?: unknown;
    view_id?: string;
  }): void {
    const started_at = Date.now();
    const archive: XVibeRunArchiveData = {
      _generation_id: input.generation_id,
      _app_id: input.app_id,
      _env: input.env,
      ...(input.view_id ? { _view_id: input.view_id } : {}),
      _artifact_type: input.artifact_type,
      ...(input.resolved_task ? { _resolved_task: input.resolved_task } : {}),
      ...(input.artifact_plan ? { _artifact_plan: input.artifact_plan } : {}),
      _created_at: new Date().toISOString(),
      _user_prompt: input.prompt,
      _result: RunArchiveManager.structuredFailureResult({
        artifact_type: input.artifact_type,
        result: input.result,
        requested_view_id: input.view_id,
      }),
    };
    const error_payload =
      _xu.is_plain_object(input.result._error)
        ? input.result._error as XVibeJsonObject
        : input.result;
    const failure_details: Record<string, unknown> = {
      _artifact_type: input.artifact_type,
      ...(input.view_id ? { _view_id: input.view_id } : {}),
      _error: error_payload,
    };

    RunArchiveManager.recordStage(
      archive,
      started_at,
      "failed",
      "Generation failed",
      failure_details,
    );
    archive._duration_ms = Date.now() - started_at;
    RunArchiveManager.archiveVibeRun(archive);
    this.broadcast_generation_failed(
      {
        ...input.params,
        _app_id: input.app_id,
        _env: input.env,
        ...(input.view_id ? { _view_id: input.view_id } : {}),
        ...(input.generation_id ? { _generation_id: input.generation_id } : {}),
      },
      new XVibeStructuredError(input.result),
      input.fallback_code,
    );
  }

  private async collect_runtime_awareness_context(
    _input: XVibeRuntimeContextInput,
  ): Promise<XVibeJsonObject> {
    return RuntimeContextManager.collectRuntimeAwarenessContext(_input);
  }

  private async load_current_view_for_refine(input: {
    _app_id: string;
    _env: string;
    _view_id: string;
  }): Promise<XVibeJsonObject> {
    const current_result = unwrap_command_result(await _x.execute({
      _module: "server-xvm",
      _op: "get_view",
      _params: {
        _app_id: input._app_id,
        _env: input._env,
        _view_id: input._view_id,
      },
    } as any));

    if (!_xu.is_plain_object(current_result) || !_xu.is_plain_object(current_result._view)) {
      throw new Error("Invalid server-xvm get_view response");
    }

    _xlog.log("[xvibe] refine current view loaded", {
      _app_id: input._app_id,
      _env: input._env,
      _view_id: input._view_id,
    });

    return current_result._view;
  }

  private async load_xvm_view_references_for_refine(input: {
    _app_id: string;
    _env: string;
    _view_id: string;
    _current_view: unknown;
  }): Promise<XVibeXVMViewReferenceLoadResult> {
    const referenced_view_ids =
      collect_xvm_view_reference_ids(input._current_view)
        .filter((view_id) => view_id !== input._view_id);
    const loaded_views: XVibeReferencedView[] = [];
    const missing_view_ids: string[] = [];
    const warnings: string[] = [];

    for (const referenced_view_id of referenced_view_ids) {
      try {
        const referenced_view =
          await this.load_current_view_for_refine({
            _app_id: input._app_id,
            _env: input._env,
            _view_id: referenced_view_id,
          });

        loaded_views.push({
          _view_id: referenced_view_id,
          _view: referenced_view,
        });
      } catch (error) {
        missing_view_ids.push(referenced_view_id);
        warnings.push(`missing_xvm_view_reference:${referenced_view_id}`);
        _xlog.warn("[xvibe] xvm-view reference missing", {
          _app_id: input._app_id,
          _env: input._env,
          _view_id: input._view_id,
          _referenced_view_id: referenced_view_id,
          _error: error_summary(error),
        });
      }
    }

    _xlog.log("[xvibe] xvm-view references resolved", {
      _view_id: input._view_id,
      _referenced_view_ids: referenced_view_ids,
      _loaded_count: loaded_views.length,
      _missing_view_ids: missing_view_ids,
    });

    return {
      _referenced_view_ids: referenced_view_ids,
      _loaded_views: loaded_views,
      _missing_view_ids: missing_view_ids,
      _warnings: warnings,
    };
  }

  private async try_apply_deterministic_view_edit_for_refine(input: {
    app_id: string;
    env: string;
    mode: VibeAIMode;
    prompt: string;
    runtime_skills: unknown;
    requested_view_id: string;
    current_view: XVibeJsonObject;
    edit_intent: XVibeViewEditIntent;
    generated_artifacts?: unknown;
    planned_flow_ids?: string[];
    runtime_plan?: XVibeRuntimePlan;
    resolved_task: XVibeResolvedTask;
    generation_id: string;
    archive: XVibeRunArchiveData;
    archive_started_at: number;
    progress: XVibeGenerationProgressCallback;
  }): Promise<unknown | undefined> {
    const xvm_view_references =
      await this.load_xvm_view_references_for_refine({
        _app_id: input.app_id,
        _env: input.env,
        _view_id: input.requested_view_id,
        _current_view: input.current_view,
      });
    const deterministic_source =
      resolve_deterministic_view_edit_source({
        _requested_view_id: input.requested_view_id,
        _current_view: input.current_view,
        _referenced_views: xvm_view_references._loaded_views,
        _reference_warnings: xvm_view_references._warnings,
        _resolved_task: input.resolved_task,
        _edit_intent: input.edit_intent,
      });

    if (!deterministic_source._eligible) {
      const deterministic_eligibility = deterministic_source._eligibility;
      input.archive._deterministic_mutation = {
        _eligible: false,
        _reason: deterministic_eligibility._reason,
        ...(deterministic_source._warnings.length > 0
          ? { _warnings: deterministic_source._warnings }
          : {}),
        ...(deterministic_eligibility._details !== undefined
          ? { _details: deterministic_eligibility._details }
          : {}),
      };
      _xlog.log("[xvibe] deterministic view edit not eligible", {
        _reason: deterministic_eligibility._reason,
        ...(deterministic_eligibility._details !== undefined
          ? { _details: deterministic_eligibility._details }
          : {}),
      });

      return undefined;
    }

    const deterministic_eligibility = deterministic_source._eligibility;
    _xlog.log("[xvibe] deterministic view edit eligible", {
      _action: deterministic_eligibility._action,
      _target_id: deterministic_eligibility._target_id,
      _field: deterministic_eligibility._field,
      _target_view_id: deterministic_source._view_id,
      _resolved_via: deterministic_source._resolved_via,
    });
    input.progress(
      "deterministic-mutating",
      "Applying deterministic view edit...",
      {
        _action: deterministic_eligibility._action,
        _target_id: deterministic_eligibility._target_id,
        _target_view_id: deterministic_source._view_id,
      },
    );
    const deterministic_result =
      apply_deterministic_view_edit({
        _resolved_task: input.resolved_task,
        _current_view: deterministic_source._view,
        _edit_intent: input.edit_intent,
      });

    if (!deterministic_result._ok || !deterministic_result._view || !deterministic_result._mutation) {
      input.archive._deterministic_mutation = {
        _eligible: false,
        _reason: deterministic_result._reason ?? "deterministic_mutation_failed",
        ...(deterministic_source._warnings.length > 0
          ? { _warnings: deterministic_source._warnings }
          : {}),
        ...(deterministic_result._details !== undefined
          ? { _details: deterministic_result._details }
          : {}),
      };
      _xlog.warn("[xvibe] deterministic view edit failed after eligibility", {
        _reason: deterministic_result._reason,
        ...(deterministic_result._details !== undefined
          ? { _details: deterministic_result._details }
          : {}),
      });

      return undefined;
    }

    if (deterministic_source._resolved_via === "xvm-view") {
      const deterministic_view = deterministic_result._view as XVibeJsonObject;
      const deterministic_view_id =
        typeof deterministic_view._id === "string" ? deterministic_view._id.trim() : "";
      if (deterministic_view_id !== deterministic_source._view_id) {
        input.archive._deterministic_mutation = {
          _eligible: false,
          _reason: "source_view_id_mismatch",
          _details: {
            _requested_view_id: input.requested_view_id,
            _source_view_id: deterministic_source._view_id,
            _view_id: deterministic_view_id,
          },
        };
        _xlog.warn("[xvibe] deterministic referenced view id mismatch", {
          _requested_view_id: input.requested_view_id,
          _source_view_id: deterministic_source._view_id,
          _view_id: deterministic_view_id,
        });

        return undefined;
      }
    }

    input.archive._deterministic_mutation = {
      _eligible: true,
      _reason: deterministic_eligibility._reason,
      ...deterministic_result._mutation,
      ...(deterministic_source._warnings.length > 0
        ? { _warnings: deterministic_source._warnings }
        : {}),
      ...(deterministic_source._resolved_via === "xvm-view"
        ? {
          _target_view_id: deterministic_source._view_id,
          _source_view_id: deterministic_source._view_id,
          _requested_view_id: input.requested_view_id,
          _resolved_via: "xvm-view",
        }
        : {}),
    };
    if (deterministic_result._mutation._action === "hide-object") {
      _xlog.log("[xvibe] deterministic hide applied", {
        _target_id: deterministic_result._mutation._target_id,
        _hide_mechanism: deterministic_result._mutation._hide_mechanism,
      });
    }
    if (deterministic_result._mutation._action === "show-object") {
      _xlog.log("[xvibe] deterministic show applied", {
        _target_id: deterministic_result._mutation._target_id,
        _show_mechanism: deterministic_result._mutation._show_mechanism,
      });
    }
    if (deterministic_source._resolved_via === "xvm-view") {
      _xlog.log("[xvibe] deterministic referenced view edit", {
        _requested_view_id: input.requested_view_id,
        _target_view_id: deterministic_source._view_id,
        _action: deterministic_result._mutation._action,
        _target_id: deterministic_result._mutation._target_id,
      });
    }

    return this.persist_view_artifact({
      app_id: input.app_id,
      env: input.env,
      mode: input.mode,
      prompt: input.prompt,
      runtime_skills: input.runtime_skills,
      requested_view_id: input.requested_view_id,
      ...(deterministic_source._resolved_via === "xvm-view"
        ? { source_view_id: deterministic_source._view_id }
        : {}),
      parsed_view: deterministic_result._view as XVibeViewArtifact,
      generated_artifacts: input.generated_artifacts,
      planned_flow_ids: input.planned_flow_ids,
      runtime_plan: input.runtime_plan,
      resolved_task: input.resolved_task,
      generation_id: input.generation_id,
      project_memory:
        _xu.is_plain_object(input.archive._runtime_context)
          ? input.archive._runtime_context._project_memory
          : undefined,
      deterministic_mutation:
        input.archive._deterministic_mutation as XVibeDeterministicViewEditResult["_mutation"],
      include_artifact_type: true,
      archive: input.archive,
      archive_started_at: input.archive_started_at,
      progress: input.progress,
    });
  }

  private get_view_mutation_prompt_decision(
    prompt: string,
    current_view: unknown
  ): {
    _eligible: boolean;
    _reason: XVibeViewMutationDecisionReason;
  } {
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      return {
        _eligible: false,
        _reason: "prompt_not_safe",
      };
    }

    if (!_xu.is_plain_object(current_view)) {
      return {
        _eligible: false,
        _reason: "missing_current_view",
      };
    }

    const normalized_prompt =
      prompt
        .toLowerCase()
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const full_generation_patterns = [
      /\bcreate\b.*\bapp\b/,
      /\brebuild\b/,
      /\bredesign\b/,
      /\bregenerate\b/,
      /\bnew game\b/,
      /\bdashboard\b/,
      /\bform\b/,
      /\blayout\b/,
      /\bpage\b/,
    ];

    if (
      full_generation_patterns.some((pattern) =>
        pattern.test(normalized_prompt)
      )
    ) {
      return {
        _eligible: false,
        _reason: "excluded_keyword",
      };
    }

    const mutation_patterns = [
      /\bchange\b/,
      /\bupdate\b/,
      /\breplace\b/,
      /\brename\b/,
      /\bmove\b/,
      /\badd class\b/,
      /\bchange text\b/,
      /\bchange href\b/,
      /\bchange target\b/,
      /\bchange label\b/,
      /\bchange button\b/,
    ];

    if (
      !mutation_patterns.some((pattern) =>
        pattern.test(normalized_prompt)
      )
    ) {
      return {
        _eligible: false,
        _reason: "no_target_hint",
      };
    }

    return {
      _eligible: true,
      _reason: "eligible",
    };
  }

  private should_use_view_mutation(
    prompt: string,
    current_view: unknown
  ): boolean {
    return this.get_view_mutation_prompt_decision(prompt, current_view)._eligible;
  }

  private build_view_mutation_refine_decision(input: {
    _mode: VibeAIMode;
    _artifact_type: string;
    _view_id?: string;
    _prompt: string;
    _current_view: unknown;
    _eligible?: boolean;
  }): XVibeViewMutationDecisionLog {
    const current_view = input._current_view;
    const has_current_view = _xu.is_plain_object(current_view);
    const current_view_id =
      has_current_view && typeof current_view._id === "string"
        ? current_view._id
        : null;
    const children_count =
      has_current_view && Array.isArray(current_view._children)
        ? current_view._children.length
        : 0;

    let prompt_decision:
      | {
        _eligible: boolean;
        _reason: XVibeViewMutationDecisionReason;
      }
      | undefined;

    let reason: XVibeViewMutationDecisionReason;
    if (input._mode !== "refine") {
      reason = "not_refine";
    } else if (input._artifact_type !== "view") {
      reason = "not_view";
    } else if (!input._view_id) {
      reason = "missing_view_id";
    } else {
      prompt_decision =
        this.get_view_mutation_prompt_decision(input._prompt, current_view);
      reason = prompt_decision._reason;
    }

    const eligible =
      input._eligible ??
      (prompt_decision
        ? prompt_decision._eligible
        : false);

    return {
      _eligible: eligible,
      _mode: input._mode,
      _artifact_type: input._artifact_type,
      _view_id: input._view_id ?? null,
      _prompt: input._prompt,
      _reason: reason,
      _has_current_view: has_current_view,
      _current_view_id: current_view_id,
      _children_count: children_count,
    };
  }

  private log_view_mutation_refine_decision(input: {
    _mode: VibeAIMode;
    _artifact_type: string;
    _view_id?: string;
    _prompt: string;
    _current_view: unknown;
    _eligible?: boolean;
  }): XVibeViewMutationDecisionLog {
    const decision = this.build_view_mutation_refine_decision(input);
    _xlog.log("[xvibe] mutation refine decision", decision);
    return decision;
  }

  private assign_view_ids(view: unknown): number {
    const result = ensure_view_ids(view);
    const view_id =
      _xu.is_plain_object(view) && typeof view._id === "string" && view._id.trim().length > 0
        ? view._id.trim()
        : null;

    _xlog.log("[xvibe] assigned view ids", {
      _count: result._count,
      _view_id: view_id,
    });

    return result._count;
  }

  private collect_view_target_ids(
    value: unknown,
    ids: string[] = [],
  ): string[] {
    if (Array.isArray(value)) {
      for (const item of value) {
        this.collect_view_target_ids(item, ids);
      }
      return ids;
    }

    if (!_xu.is_plain_object(value)) {
      return ids;
    }

    if (typeof value._id === "string" && value._id.trim().length > 0) {
      ids.push(value._id);
    }

    for (const child of Object.values(value)) {
      if (_xu.is_plain_object(child) || Array.isArray(child)) {
        this.collect_view_target_ids(child, ids);
      }
    }

    return ids;
  }

  private find_view_node_by_id(
    value: unknown,
    target_id: string,
  ): XVibeJsonObject | undefined {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.find_view_node_by_id(item, target_id);
        if (found) return found;
      }
      return undefined;
    }

    if (!_xu.is_plain_object(value)) {
      return undefined;
    }

    if (value._id === target_id) {
      return value;
    }

    for (const child of Object.values(value)) {
      if (_xu.is_plain_object(child) || Array.isArray(child)) {
        const found = this.find_view_node_by_id(child, target_id);
        if (found) return found;
      }
    }

    return undefined;
  }

  private stable_json(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((item) => this.stable_json(item)).join(",")}]`;
    }

    if (_xu.is_plain_object(value)) {
      return `{${Object.keys(value)
        .sort()
        .map((key) =>
          `${JSON.stringify(key)}:${this.stable_json(value[key])}`
        )
        .join(",")}}`;
    }

    return JSON.stringify(value) ?? "undefined";
  }

  private json_values_equal(a: unknown, b: unknown): boolean {
    return this.stable_json(a) === this.stable_json(b);
  }

  private prompt_explicitly_requests_mutation_key(
    prompt: string,
    key: string,
  ): boolean {
    const normalized_prompt =
      prompt
        .toLowerCase()
        .replace(/[_-]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    const escaped_key =
      key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    if (new RegExp(`\\b${escaped_key}\\b`, "i").test(prompt)) {
      return true;
    }

    if (key === "_on") {
      return /\b(event handler|handlers|wiring|click handler|on click)\b/.test(normalized_prompt);
    }

    if (key === "_on_mount") {
      return /\b(on mount|mount handler|mount behavior)\b/.test(normalized_prompt);
    }

    if (key === "_data_source") {
      return /\b(data source|data binding|datasource)\b/.test(normalized_prompt);
    }

    if (key === "_on_data") {
      return /\b(on data|data handler|data handling)\b/.test(normalized_prompt);
    }

    if (key === "_children") {
      return /\b(children|child nodes|child objects)\b/.test(normalized_prompt);
    }

    return false;
  }

  private build_view_mutation_prompt(input: {
    prompt: string;
    current_view: unknown;
  }): string {
    const target_ids =
      this.collect_view_target_ids(input.current_view)
        .filter((id, index, ids) => ids.indexOf(id) === index)
        .slice(0, 200);

    const mutation_prompt = [
      "You are an Xpell view mutation planner.",
      "Return strict JSON only.",
      "Generate mutation operations instead of full view JSON.",
      "",
      "Output contract:",
      JSON.stringify(
        {
          _artifact_type: "view-mutation",
          _contract_version: 1,
          _ops: [
            {
              _op_type: "update_props",
              _target_id: "...",
              _props: {},
            },
          ],
        },
        null,
        2,
      ),
      "",
      "Rules:",
      "- Use update_props only.",
      "- update_props is required for text, class, style, href, target, title, and value changes.",
      "- _target_id must already exist in Current View JSON.",
      "- _props must contain only the changed properties.",
      "- If _props includes _id, it must equal _target_id.",
      "- Preserve existing wiring.",
      "- Never include _on, _on_mount, _data_source, _on_data, or _children in _props unless explicitly requested.",
      "- Return only the minimal operations needed for the requested edit.",
      "- Do not return _view.",
      "- Do not return full view JSON.",
      "",
      "Existing target ids:",
      target_ids.length > 0 ? target_ids.join(", ") : "(none)",
      "",
      "Current View JSON:",
      JSON.stringify(input.current_view, null, 2),
      "",
      "User Edit Request:",
      input.prompt,
    ].join("\n");

    _xlog.log("[xvibe] mutation prompt built");

    return mutation_prompt;
  }

  private parse_view_mutation_output(input: {
    xai_result: unknown;
    prompt: string;
    current_view: unknown;
  }): XVibeViewMutationArtifact {
    const parsed =
      JSON.parse(
        repair_json(
          extract_balanced_json(
            read_generated_text(input.xai_result),
          ),
        ),
      ) as unknown;

    if (!_xu.is_plain_object(parsed)) {
      throw new Error("Invalid mutation output: expected object root");
    }

    if (parsed._artifact_type !== "view-mutation") {
      throw new Error("Invalid mutation output: expected _artifact_type 'view-mutation'");
    }

    if (parsed._contract_version !== 1) {
      throw new Error("Invalid mutation output: expected _contract_version 1");
    }

    if (!Array.isArray(parsed._ops)) {
      throw new Error("Invalid mutation output: expected _ops array");
    }

    if (parsed._ops.length === 0) {
      throw new Error("Invalid mutation output: expected at least one op");
    }

    const protected_props =
      ["_on", "_on_mount", "_data_source", "_on_data", "_children"];

    for (const [index, op] of parsed._ops.entries()) {
      if (!_xu.is_plain_object(op)) {
        throw new Error(`Invalid mutation op at index ${index}: expected object`);
      }

      if (op._op_type !== "update_props") {
        throw new Error(`Invalid mutation op at index ${index}: update_props only`);
      }

      if (typeof op._target_id !== "string" || op._target_id.trim().length === 0) {
        throw new Error(`Invalid mutation op at index ${index}: expected _target_id`);
      }

      const target_id = op._target_id;

      if (!_xu.is_plain_object(op._props)) {
        throw new Error(`Invalid mutation op at index ${index}: expected _props object`);
      }

      if (Object.keys(op._props).length === 0) {
        throw new Error(`Invalid mutation op at index ${index}: expected non-empty _props`);
      }

      if (
        op._props._id !== undefined &&
        op._props._id !== target_id
      ) {
        throw new Error(`Invalid mutation op at index ${index}: _props._id must equal _target_id when present`);
      }

      const current_target =
        this.find_view_node_by_id(input.current_view, target_id);
      if (!current_target) {
        throw new Error(`Invalid mutation op at index ${index}: target '${target_id}' does not exist`);
      }

      for (const protected_key of protected_props) {
        if (
          protected_key in op._props &&
          !this.prompt_explicitly_requests_mutation_key(input.prompt, protected_key)
        ) {
          throw new Error(`Invalid mutation op at index ${index}: _props must not include ${protected_key} unless explicitly requested`);
        }
      }
    }

    return parsed as XVibeViewMutationArtifact;
  }

  private async try_apply_view_mutation(input: {
    app_id: string;
    env: string;
    view_id: string;
    prompt: string;
    current_view: unknown;
    include_artifact_type: boolean;
    archive: XVibeRunArchiveData;
    progress: XVibeGenerationProgressCallback;
    archive_started_at: number;
  }): Promise<unknown | undefined> {
    const fallback = (reason: unknown): undefined => {
      const details = {
        _app_id: input.app_id,
        _env: input.env,
        _view_id: input.view_id,
        _error: error_summary(reason),
      };

      _xlog.log("[xvibe] mutation fallback", details);
      input.progress(
        "mutation-fallback",
        "Falling back to full refine...",
        details as Record<string, unknown>,
      );

      return undefined;
    };

    try {
      input.progress(
        "planning-mutation",
        "Planning mutation...",
        {
          _view_id: input.view_id,
        },
      );

      const mutation_prompt =
        this.build_view_mutation_prompt({
          prompt: input.prompt,
          current_view: input.current_view,
        });
      input.archive._final_prompt = mutation_prompt;

      input.progress(
        "generating-mutation",
        "Generating mutation...",
        {
          _view_id: input.view_id,
        },
      );

      const xai_result: any =
        unwrap_command_result(
          await _x.execute({
            _module: "xai",
            _op: "generate",
            _params: {
              _prompt: mutation_prompt,
              response_format: {
                type: "json_object",
              },
            },
          } as any),
        );
      input.archive._ai_output = xai_result;

      input.progress(
        "parsing-mutation",
        "Parsing mutation...",
        {
          _view_id: input.view_id,
        },
      );

      const mutation =
        this.parse_view_mutation_output({
          xai_result,
          prompt: input.prompt,
          current_view: input.current_view,
        });

      _xlog.log("[xvibe] mutation ops parsed", {
        _app_id: input.app_id,
        _env: input.env,
        _view_id: input.view_id,
        _ops_count: mutation._ops.length,
      });

      input.progress(
        "mutating",
        "Applying mutation...",
        {
          _view_id: input.view_id,
          _ops_count: mutation._ops.length,
        },
      );

      const raw_mutation_response =
        await _x.execute({
          _module: "xmutator",
          _op: "mutate-view",
          _params: {
            _app_id: input.app_id,
            _env: input.env,
            _view_id: input.view_id,
            _dry_run: false,
            _ops: mutation._ops,
          },
        } as any);
      const mutation_result =
        unwrap_command_result(
          unwrap_command_result(raw_mutation_response),
        );

      if (!_xu.is_plain_object(mutation_result)) {
        throw new Error("Invalid xmutator mutate-view response");
      }

      _xlog.log("[xvibe] mutation applied", {
        _app_id: input.app_id,
        _env: input.env,
        _view_id: input.view_id,
        _ops_count: mutation._ops.length,
      });

      input.archive._result = {
        _artifact_type: "view",
        _artifact_id: input.view_id,
        _view_id: input.view_id,
        _success: true,
        _mutation: true,
        _ops_count: mutation._ops.length,
      };

      _xem.fire("vibe:view-updated", {
        _app_id: input.app_id,
        _env: input.env,
        _view_id: input.view_id,
      });

      input.progress(
        "complete",
        "View updated",
        {
          _artifact_type: "view",
          _view_id: input.view_id,
          _mutation: true,
          _ops_count: mutation._ops.length,
          _duration_ms: Date.now() - input.archive_started_at,
        },
      );

      return {
        _ok: true,
        _result: input.include_artifact_type
          ? {
            _artifact_type: "view",
            _artifact_id: input.view_id,
            _view_id: input.view_id,
          }
          : {
            _view_id: input.view_id,
          },
      };
    } catch (error) {
      return fallback(error);
    }
  }

  protected async create_intent_plan(params: {
    prompt: string;
    app_plan: any;
    app_id: string;
    env: string;
  }): Promise<VibeIntentPlan> {
    const runtime_mode =
      params.app_id === "vibe-system"
        ? "system"
        : "runtime";
    const runtime_skills = this.get_runtime_skills(params.app_id, params.env, runtime_mode);
    const runtime_capabilities =
      this.intent_planner.extract_runtime_capabilities(runtime_skills);
    const inferred_intent =
      this.intent_planner.infer_intent_plan(params.prompt, params.app_plan, runtime_capabilities);
    const project_memory =
      await RuntimeContextManager.loadProjectMemory({
        _app_id: params.app_id,
        _env: params.env,
      });

    verbose_log("[xvibe] intent planning:start", {
      _app_id: params.app_id,
      _env: params.env,
      _runtime_mode: runtime_mode,
    });

    if (inferred_intent._intent_type === "module") {
      const module_intent =
        this.intent_planner.enforce_module_intent_plan(inferred_intent);
      this.log_intent_plan("app", module_intent);
      return module_intent;
    }

    const intent_prompt = [
      "You are an Xpell runtime intent planner.",
      "Return strict JSON only.",
      "Refine the deterministic shallow intent IR. Do not replace it with unrelated inventory.",
      "Runtime capabilities are available options and validation candidates only.",
      "Do not include runtime capabilities as selected _capabilities unless the user/app intent explicitly needs them.",
      'Schema: { "_ir_version": 1, "_intent_type": "", "_artifact_types": [], "_entities": [], "_regions": [], "_objects": [], "_actions": [], "_bindings": [], "_modules": [], "_requires_module": false, "_module_target": null, "_module_name": "", "_module_ops": [], "_module_reason": "", "_style": {}, "_xui_objects": [], "_capabilities": [], "_crud_ops": [], "_ui_patterns": [], "_ui_keywords": [], "_flow_keywords": [], "_entity_keywords": [] }',
      'Entity shape: { "_id": "customers", "_fields": ["name", "email", "status"] }',
      'Action shape: { "_id": "add-customer", "_type": "flow", "_label": "Add Customer", "_entity": "customers", "_op": "add", "_target_region": "create_modal" }',
      'Binding shape: { "_target": "customers-table", "_source": "customers:records" }',
      'Style shape: { "_theme": "dark", "_density": "comfortable", "_layout": "dashboard" }',
      "Allowed _regions: sidebar, toolbar, kpi_grid, records_table, create_modal, details_drawer, filters, content.",
      "Allowed _objects: sidebar, navlist, toolbar, field, button, xsection, grid, card, kpi-card, table, modal, form, xselect, drawer, style-sheet.",
      "Keep this IR shallow. Do not output _children trees, final XUI JSON, or deeply nested UI structures.",
      "_objects and _xui_objects must be selected XUI object ids from the runtime registry.",
      "_modules must be selected runtime module ids from the runtime registry.",
      "Use _requires_module/_module_target/_module_name/_module_ops only when the deterministic plan already indicates missing custom behavior or runtime capabilities do not satisfy it.",
      "Do not require modules for XData state get/set/patch/delete, XEM events, entity CRUD, simple XUI nano-command behavior, or pure layout/style changes.",
      "_entities must be inferred entity descriptors only.",
      'The words "view", "page", "screen", "layout", "dashboard", "form", "button", "grid", "row", and "column" are UI concepts by default.',
      'Do NOT create entities from these words.',
      'Never create entities named "views", "pages", "screens", "layouts", "buttons", "grids", "rows", or "columns" unless the user explicitly asks for data records, CRUD, database, collection, schema, persistence, or entity management.',
      "Prefer explicit business data nouns after CRUD/table/entity/records language.",
      "Do not treat UI/control words as entities: xpell, statistics, status, buttons, operations, filters, refresh, search, dashboard, navigation, toolbar, sidebar, modal, drawer.",
      "For dashboard/CRUD, return one primary entity unless the user explicitly requests multiple entities.",
      "Derive _actions from CRUD intent for the primary entity only.",
      "_capabilities, _crud_ops, and _ui_patterns must be selected intent signals only.",
      "Use [] when array fields have no selected values.",
      "",
      "Deterministic intent plan:",
      JSON.stringify(inferred_intent),
      "",
      "Runtime capability registry:",
      JSON.stringify(runtime_capabilities),
      "",
      ...(project_memory
        ? [
          "Project Memory:",
          JSON.stringify(project_memory),
          "",
        ]
        : []),
      "User prompt:",
      params.prompt,
      "",
      "App plan:",
      JSON.stringify(params.app_plan),
    ].join("\n");

    try {
      const xai_result: any =
        unwrap_command_result(
          await _x.execute({
            _module: "xai",
            _op: "generate",
            _params: {
              _prompt: intent_prompt,
              response_format: {
                type: "json_object"
              }
            }
          } as any)
        );

      const parsed = JSON.parse(
        repair_json(
          extract_balanced_json(
            read_generated_text(xai_result)
          )
        )
      ) as unknown;

      const plan = this.intent_planner.normalize_intent_plan(
        parsed,
        runtime_capabilities,
        inferred_intent,
      );
      const guarded_plan = this.intent_planner.apply_ui_only_guard(
        params.prompt,
        plan,
      );

      this.log_intent_plan("app", guarded_plan);

      return guarded_plan;
    } catch (error) {
      _xlog.warn("[xvibe] intent planning fallback", {
        _reason: error instanceof Error ? error.message : String(error),
      });
      return this.intent_planner.apply_ui_only_guard(
        params.prompt,
        this.intent_planner.normalize_intent_plan({}, runtime_capabilities, inferred_intent),
      );
    }
  }

  private log_intent_plan(scope: string, plan: VibeIntentPlan): void {
    verbose_log("[xvibe] intent finalized", {
      _scope: scope,
      _ir_version: plan._ir_version,
      _intent_type: plan._intent_type,
      _artifact_types: plan._artifact_types,
      _entities: plan._entities,
      _regions: plan._regions,
      _objects: plan._objects,
      _actions: plan._actions,
      _bindings: plan._bindings,
      _modules: plan._modules,
      _requires_module: plan._requires_module,
      _module_target: plan._module_target,
      _module_name: plan._module_name,
      _module_ops: plan._module_ops,
      _module_reason: plan._module_reason,
      _style: plan._style,
    });
  }

  private has_supplied_intent_plan(value: unknown): boolean {
    if (!_xu.is_plain_object(value)) return false;

    const intent_fields = [
      "_ir_version",
      "_artifact_types",
      "_xui_objects",
      "_objects",
      "_modules",
      "_requires_module",
      "_module_target",
      "_module_name",
      "_module_ops",
      "_module_reason",
      "_entities",
      "_regions",
      "_actions",
      "_bindings",
      "_capabilities",
      "_crud_ops",
      "_ui_patterns",
      "_ui_keywords",
      "_flow_keywords",
      "_entity_keywords",
      "_style",
    ];

    return intent_fields.some((field) => {
      const field_value = value[field];
      return (
        (Array.isArray(field_value) && field_value.length > 0) ||
        (typeof field_value === "boolean") ||
        (typeof field_value === "string" && field_value.trim().length > 0) ||
        (field === "_style" && _xu.is_plain_object(field_value) && Object.keys(field_value).length > 0) ||
        (field === "_ir_version" && field_value === 1)
      );
    });
  }

  private create_artifact_intent_plan(params: {
    prompt: string;
    artifact_type: XVibeInferredArtifactType;
    supplied_intent_plan: unknown;
    runtime_skills: unknown;
  }): VibeIntentPlan {
    const runtime_capabilities =
      this.intent_planner.extract_runtime_capabilities(params.runtime_skills);
    const inferred_intent =
      this.intent_planner.infer_intent_plan(
        params.prompt,
        { _artifact_types: [params.artifact_type] },
        runtime_capabilities,
      );
    const artifact_intent =
      this.intent_planner.normalize_intent_plan(
        { _artifact_types: [params.artifact_type] },
        runtime_capabilities,
        inferred_intent,
      );

    if (this.has_supplied_intent_plan(params.supplied_intent_plan)) {
      const supplied_artifact_intent = this.intent_planner.apply_ui_only_guard(
        params.prompt,
        this.intent_planner.normalize_intent_plan(
          params.supplied_intent_plan,
          runtime_capabilities,
          artifact_intent,
        ),
      );

      _xlog.log("[xvibe] artifact intent plan", {
        _prompt: params.prompt,
        _artifact_type: params.artifact_type,
        _intent_type: supplied_artifact_intent._intent_type,
        _artifact_types: supplied_artifact_intent._artifact_types,
        _entities: supplied_artifact_intent._entities,
        _actions: supplied_artifact_intent._actions,
        _modules: supplied_artifact_intent._modules,
        _requires_module: supplied_artifact_intent._requires_module,
        _module_name: supplied_artifact_intent._module_name,
        _module_ops: supplied_artifact_intent._module_ops,
      });

      return supplied_artifact_intent;
    }

    const guarded_artifact_intent =
      this.intent_planner.apply_ui_only_guard(params.prompt, artifact_intent);

    _xlog.log("[xvibe] artifact intent plan", {
      _prompt: params.prompt,
      _artifact_type: params.artifact_type,
      _intent_type: guarded_artifact_intent._intent_type,
      _artifact_types: guarded_artifact_intent._artifact_types,
      _entities: guarded_artifact_intent._entities,
      _actions: guarded_artifact_intent._actions,
      _modules: guarded_artifact_intent._modules,
      _requires_module: guarded_artifact_intent._requires_module,
      _module_name: guarded_artifact_intent._module_name,
      _module_ops: guarded_artifact_intent._module_ops,
    });

    return guarded_artifact_intent;
  }

  private create_artifact_scope_lock(intent: XVibeArtifactIntent): XVibeArtifactScopeLock | undefined {
    if (intent._action !== "create" && intent._action !== "update") {
      return undefined;
    }

    if (
      intent._target !== "view" &&
      intent._target !== "flow" &&
      intent._target !== "entity" &&
      intent._target !== "module"
    ) {
      return undefined;
    }

    return {
      _locked: true,
      _action: intent._action,
      _artifact_type: intent._target,
      ...(intent._target_id ? { _target_id: intent._target_id } : {}),
      ...(intent._forbidden_targets.length > 0
        ? { _forbidden_targets: intent._forbidden_targets }
        : {}),
      _reason: "resolver_lock",
    };
  }

  private apply_artifact_scope_lock_to_plan(
    lock: XVibeArtifactScopeLock | undefined,
    plan: XVibeInferredArtifactPlan,
  ): XVibeInferredArtifactPlan {
    if (!lock || lock._artifact_type !== "view") {
      return plan;
    }

    return {
      ...plan,
      _primary_artifact_type: "view",
      _artifact_types: ["view"],
      _flow_ids: undefined,
      _entity_ids: undefined,
      _module_names: undefined,
      _reason: lock._reason,
      _execution_plan: {
        _primary_artifact_type: "view",
        _artifacts: [
          {
            _artifact_type: "view",
            _action: lock._action,
            ...(lock._target_id ? { _artifact_id: lock._target_id } : {}),
          },
        ],
      },
    };
  }

  private apply_artifact_scope_lock_to_intent_plan(
    lock: XVibeArtifactScopeLock | undefined,
    plan: VibeIntentPlan,
  ): VibeIntentPlan {
    if (!lock || lock._artifact_type !== "view") {
      return plan;
    }

    const locked_plan: VibeIntentPlan = {
      ...plan,
      _intent_type: "view-design",
      _artifact_types: ["view"],
      _entities: [],
      _actions: [],
      _bindings: [],
      _modules: [],
      _capabilities: plan._capabilities.filter(
        (capability) =>
          capability !== "entity" &&
          capability !== "crud" &&
          capability !== "storage",
      ),
      _crud_ops: [],
      _flow_keywords: [],
      _entity_keywords: [],
      _requires_module: false,
      _module_target: null,
      _module_name: "",
      _module_ops: [],
      _module_reason: undefined,
    };

    return locked_plan;
  }

  private artifact_envelope(
    artifact_type: VibeArtifactType,
    artifact: XVibeGeneratedArtifact,
  ): XVibeJsonObject {
    if (artifact_type === "view") {
      return {
        _artifact_type: "view",
        _contract_version: 1,
        _view: artifact,
      };
    }

    if (artifact_type === "flow") {
      return {
        _artifact_type: "flow",
        _contract_version: 1,
        _flow: artifact,
      };
    }

    if (artifact_type === "entity") {
      return {
        _artifact_type: "entity",
        _contract_version: 1,
        _entity: artifact,
      };
    }

    return {
      _artifact_type: "command",
      _contract_version: 1,
      _command: artifact,
    };
  }

  private push_validation_error(
    errors: string[],
    message: string,
  ): void {
    if (errors.length < MAX_VALIDATION_ERRORS) {
      errors.push(message);
    }
  }

  private validate_event_handler(
    handler: unknown,
    path: string,
    errors: string[],
  ): void {
    if (typeof handler === "string") return;

    if (Array.isArray(handler)) {
      handler.forEach((item, index) =>
        this.validate_event_handler(item, validation_path(path, index), errors)
      );
      return;
    }

    if (!_xu.is_plain_object(handler)) {
      this.push_validation_error(errors, `${path} must be a string, command object, or array`);
      return;
    }

    if (handler._flow !== undefined) {
      this.validate_flow_trigger(handler._flow, validation_path(path, "_flow"), errors);
      return;
    }

    if (
      handler._module !== undefined ||
      handler._object !== undefined ||
      handler._op !== undefined
    ) {
      const has_module =
        typeof handler._module === "string" &&
        handler._module.trim().length > 0;
      const has_object =
        typeof handler._object === "string" &&
        handler._object.trim().length > 0;

      if (!has_module && !has_object) {
        this.push_validation_error(errors, `${path} command requires non-empty _module or _object`);
      }

      if (handler._module !== undefined && !has_module) {
        this.push_validation_error(errors, `${path} command _module must be non-empty string`);
      }

      if (handler._object !== undefined && !has_object) {
        this.push_validation_error(errors, `${path} command _object must be non-empty string`);
      }

      if (typeof handler._op !== "string" || handler._op.trim().length === 0) {
        this.push_validation_error(errors, `${path} command requires non-empty _op`);
      }

      if (handler._params !== undefined && !_xu.is_plain_object(handler._params)) {
        this.push_validation_error(errors, `${path}._params must be an object when present`);
      }

      return;
    }

    this.push_validation_error(errors, `${path} has invalid event handler structure`);
  }

  private validate_event_map(
    value: unknown,
    path: string,
    errors: string[],
  ): void {
    if (!_xu.is_plain_object(value)) {
      this.push_validation_error(errors, `${path} must be an object keyed by event name`);
      return;
    }

    for (const [event_name, handler] of Object.entries(value)) {
      if (!event_name.trim()) {
        this.push_validation_error(errors, `${path} contains an empty event name`);
        continue;
      }

      this.validate_event_handler(handler, validation_path(path, event_name), errors);
    }
  }

  private validate_flow_trigger(
    value: unknown,
    path: string,
    errors: string[],
  ): void {
    if (!_xu.is_plain_object(value)) {
      this.push_validation_error(errors, `${path} must be { "_id": "..." }`);
      return;
    }

    if (typeof value._id !== "string" || value._id.trim().length === 0) {
      this.push_validation_error(errors, `${path} requires non-empty _id`);
    }
  }

  private validate_view_node(
    node: unknown,
    path: string,
    registry: XVibeRuntimeRegistry,
    errors: string[],
    options?: {
      _allow_inline_style?: boolean;
    },
  ): void {
    if (!_xu.is_plain_object(node)) {
      this.push_validation_error(errors, `${path} must be an object`);
      return;
    }

    const node_type =
      typeof node._type === "string"
        ? node._type.trim()
        : "";

    if (!node_type) {
      this.push_validation_error(errors, `${path} requires non-empty _type`);
    } else if (!registry._xui_types.has(node_type)) {
      this.push_validation_error(errors, `${path} has unknown runtime _type '${node_type}'`);
    }

    if (
      node_type &&
      (typeof node._id !== "string" || node._id.trim().length === 0)
    ) {
      _xlog.warn("[xvibe] view node missing id", {
        _type: node_type,
        _path: path,
      });
    }

    if (
      Object.prototype.hasOwnProperty.call(node, "_style") &&
      !options?._allow_inline_style
    ) {
      this.push_validation_error(errors, `${path} uses forbidden inline _style`);
    } else if (
      Object.prototype.hasOwnProperty.call(node, "_style") &&
      !_xu.is_plain_object(node._style)
    ) {
      this.push_validation_error(errors, `${path}._style must be an object when present`);
    }

    if (node._module === "xui-flow-trigger") {
      this.push_validation_error(errors, `${path} uses invalid xui-flow-trigger module; use _flow: { "_id": "..." }`);
    }

    if (node._flow !== undefined) {
      this.validate_flow_trigger(node._flow, validation_path(path, "_flow"), errors);
    }

    if (node._on !== undefined) {
      this.validate_event_map(node._on, validation_path(path, "_on"), errors);
    }

    if (node._once !== undefined) {
      this.validate_event_map(node._once, validation_path(path, "_once"), errors);
    }

    this.validate_semantic_view_node(node, node_type, path, errors);

    if (node._children !== undefined && !Array.isArray(node._children)) {
      this.push_validation_error(errors, `${path}._children must be an array when present`);
      return;
    }

    if (Array.isArray(node._children)) {
      node._children.forEach((child, index) =>
        this.validate_view_node(child, validation_path(path, `_children[${index}]`), registry, errors, options)
      );
    }
  }

  private validate_semantic_view_node(
    node: XVibeJsonObject,
    node_type: string,
    path: string,
    errors: string[],
  ): void {
    if (node_type === "button") {
      const has_visible_content =
        non_empty_string(node._text) ||
        non_empty_string(node._label);

      const has_dynamic_behavior =
        node._data_source !== undefined ||
        node._on_data !== undefined ||
        node._on !== undefined ||
        node._flow !== undefined;

      if (!has_visible_content && !has_dynamic_behavior) {
        this.push_validation_error(
          errors,
          `${path} button requires visible _text/_label or dynamic behavior`
        );
      }

      const has_action_metadata =
        node._action !== undefined ||
        node._module !== undefined ||
        node._op !== undefined ||
        node._command !== undefined ||
        node._params !== undefined;

      if (has_action_metadata && node._on === undefined && node._flow === undefined) {
        this.push_validation_error(errors, `${path} action button requires _on or _flow`);
      }
    }

    if (node_type === "xvm-view") {
      if (!normalize_safe_view_id(node._view_id)) {
        this.push_validation_error(errors, `${path} xvm-view requires valid _view_id`);
      }
    }

    if (node_type === "table") {
      if (node._columns !== undefined && !Array.isArray(node._columns)) {
        this.push_validation_error(errors, `${path} table _columns must be an array`);
      }

      if (node._rows !== undefined && !Array.isArray(node._rows)) {
        this.push_validation_error(errors, `${path} table _rows must be an array`);
      }

      if (!non_empty_array(node._columns) && !has_valid_data_source(node._data_source)) {
        this.push_validation_error(errors, `${path} table requires non-empty _columns or valid _data_source`);
      }
    }

    if (node_type === "field") {
      if (node._name !== undefined) {
        this.push_validation_error(errors, `${path} field must not put _name directly on field; use _control.name or _control._name`);
      }

      if (node._placeholder !== undefined) {
        this.push_validation_error(errors, `${path} field must not put _placeholder directly on field; use _control.placeholder`);
      }

      if (!_xu.is_plain_object(node._control)) {
        this.push_validation_error(errors, `${path} field requires _control object`);
        return;
      }

      const control_type =
        typeof node._control._type === "string"
          ? node._control._type.trim()
          : "";

      if (!control_type) {
        this.push_validation_error(errors, `${path}._control requires non-empty _type`);
      }

      if (
        control_type &&
        field_control_requires_name(control_type) &&
        !non_empty_string(node._control.name) &&
        !non_empty_string(node._control._name)
      ) {
        this.push_validation_error(errors, `${path}._control requires name or _name for input-like controls`);
      }

      for (const key of ["_label", "_hint", "_error", "_size", "class"] as const) {
        if (node[key] !== undefined && typeof node[key] !== "string") {
          this.push_validation_error(errors, `${path} field ${key} must be a string when present`);
        }
      }

      for (const key of ["_required", "_inline"] as const) {
        if (node[key] !== undefined && typeof node[key] !== "boolean") {
          this.push_validation_error(errors, `${path} field ${key} must be a boolean when present`);
        }
      }

      for (const key of ["name", "_name", "placeholder", "_placeholder"] as const) {
        if (node._control[key] !== undefined && typeof node._control[key] !== "string") {
          this.push_validation_error(errors, `${path}._control ${key} must be a string when present`);
        }
      }

      if (
        !is_visible_false(node) &&
        !non_empty_string(node._label) &&
        !non_empty_string(node._control.placeholder) &&
        !non_empty_string(node._control._placeholder)
      ) {
        this.push_validation_error(errors, `${path} visible field requires _label or _control.placeholder`);
      }
    }

    if (node_type === "navlist" || node_type === "nav-list") {
      if (!non_empty_array(node._items) && !has_typed_children(node)) {
        this.push_validation_error(errors, `${path} navlist requires _items or non-empty navigation children`);
      }
    }

    if (node_type === "kpi-card") {
      const has_label = non_empty_string(node._label) || non_empty_string(node._title);
      const has_value = non_empty_string(node._value) || typeof node._value === "number";
      if (!(has_label && has_value) && !has_typed_children(node)) {
        this.push_validation_error(errors, `${path} kpi-card requires _label/_title and _value, or non-empty children`);
      }
    }

    if (node_type === "modal" || node_type === "drawer") {
      if (!has_content_or_non_empty_children(node)) {
        this.push_validation_error(errors, `${path} ${node_type} requires non-empty content or children`);
      }
    }

    if (
      node_type === "xsection" ||
      node_type === "card" ||
      node_type === "grid" ||
      node_type === "sidebar" ||
      node_type === "toolbar"
    ) {
      if (!has_non_empty_children(node)) {
        this.push_validation_error(errors, `${path} ${node_type} requires non-empty _children`);
      } else if (!has_typed_children(node)) {
        this.push_validation_error(errors, `${path} ${node_type} requires _children with non-empty _type values`);
      }
    }
  }

  private validate_view_artifact(
    view: XVibeViewArtifact,
    prompt: string,
    registry: XVibeRuntimeRegistry,
    errors: string[],
    flow_context?: {
      _generated_artifacts?: unknown;
      _planned_flow_ids?: string[];
      _allow_inline_style?: boolean;
    },
  ): void {
    if (registry._xui_types.size === 0) {
      this.push_validation_error(errors, "runtime XUI object registry is empty");
    }

    this.validate_view_node(
      view,
      "_view",
      registry,
      errors,
      {
        _allow_inline_style: flow_context?._allow_inline_style === true,
      },
    );

    if (prompt_requests_styling(prompt) && flow_context?._allow_inline_style !== true) {
      const children = Array.isArray(view._children) ? view._children : [];
      const first_child = children[0];
      const first_type =
        _xu.is_plain_object(first_child) && typeof first_child._type === "string"
          ? first_child._type.trim()
          : "";

      if (first_type !== "style-sheet") {
        this.push_validation_error(errors, "_view requires style-sheet as first child when styling is requested");
      }
    }

    const referenced_flow_ids = collect_view_flow_ids(view);
    if (referenced_flow_ids.length > 0) {
      const generated_flow_ids = new Set(
        collect_generated_flow_ids(flow_context?._generated_artifacts)
          .map((flow_id) => flow_id.toLowerCase())
      );
      const prompt_flow_ids = new Set(extract_prompt_flow_ids(prompt));
      const planned_flow_ids = new Set(
        (flow_context?._planned_flow_ids ?? []).map((flow_id) => flow_id.toLowerCase())
      );

      for (const flow_id of referenced_flow_ids) {
        const normalized_flow_id = flow_id.toLowerCase();
        const prompt_requested_planned_flow =
          prompt_flow_ids.has(normalized_flow_id) &&
          planned_flow_ids.has(normalized_flow_id);

        if (!generated_flow_ids.has(normalized_flow_id) && !prompt_requested_planned_flow) {
          this.push_validation_error(
            errors,
            `_view references missing flow '${flow_id}'`
          );
        }
      }
    }
  }

  private validate_command_shape(
    command: unknown,
    path: string,
    registry: XVibeRuntimeRegistry,
    errors: string[],
  ): void {
    if (!_xu.is_plain_object(command)) {
      this.push_validation_error(errors, `${path} must be an object`);
      return;
    }

    const module_name =
      typeof command._module === "string"
        ? command._module.trim()
        : "";
    const op_name =
      typeof command._op === "string"
        ? command._op.trim()
        : "";

    if (!module_name) {
      this.push_validation_error(errors, `${path} requires non-empty _module`);
    } else if (!runtime_module_exists(module_name, registry)) {
      this.push_validation_error(errors, `${path} uses unknown runtime module '${module_name}'`);
    }

    if (!op_name) {
      this.push_validation_error(errors, `${path} requires non-empty _op`);
    } else if (module_name) {
      const allowed_ops = registry._ops.get(module_name.toLowerCase());
      if (allowed_ops && allowed_ops.size > 0 && !allowed_ops.has(op_name)) {
        this.push_validation_error(errors, `${path} uses unknown op '${op_name}' for runtime module '${module_name}'`);
      }
    }

    if (command._params !== undefined && !_xu.is_plain_object(command._params)) {
      this.push_validation_error(errors, `${path}._params must be an object when present`);
    }

    if (
      module_name === "entity-manager" ||
      module_name === "entity-client"
    ) {
      if (!ENTITY_OPS.has(op_name)) {
        this.push_validation_error(errors, `${path} uses invalid entity op '${op_name}'`);
      }
    }
  }

  private validate_flow_step(
    step: unknown,
    path: string,
    registry: XVibeRuntimeRegistry,
    errors: string[],
  ): void {
    if (!_xu.is_plain_object(step)) {
      this.push_validation_error(errors, `${path} must be an object`);
      return;
    }

    if (
      step._type !== undefined ||
      step._children !== undefined ||
      step._view !== undefined ||
      step._artifact_type === "view"
    ) {
      this.push_validation_error(errors, `${path} contains UI/view structure inside flow _steps`);
    }

    if (step._command !== undefined) {
      this.push_validation_error(errors, `${path} must use top-level _module/_op/_params, not _command`);
    }

    this.validate_command_shape(step, path, registry, errors);

    if (step._input !== undefined) {
      if (!_xu.is_plain_object(step._input)) {
        this.push_validation_error(errors, `${path}._input must be an object`);
      } else {
        for (const [key, input_def] of Object.entries(step._input)) {
          if (
            !_xu.is_plain_object(input_def) ||
            input_def._from !== "xdata" ||
            typeof input_def._key !== "string" ||
            input_def._key.trim().length === 0
          ) {
            this.push_validation_error(errors, `${path}._input.${key} must be { "_from": "xdata", "_key": "..." }`);
          }
        }
      }
    }

    if (step._output !== undefined) {
      if (
        !_xu.is_plain_object(step._output) ||
        !_xu.is_plain_object(step._output._to) ||
        step._output._to._type !== "xdata" ||
        typeof step._output._to._key !== "string" ||
        step._output._to._key.trim().length === 0
      ) {
        this.push_validation_error(errors, `${path}._output must target { "_type": "xdata", "_key": "..." }`);
      }
    }

    if (step._when !== undefined) {
      if (
        !_xu.is_plain_object(step._when) ||
        (
          step._when._type !== "xdata" &&
          step._when._type !== "event"
        ) ||
        typeof step._when._key !== "string" ||
        step._when._key.trim().length === 0
      ) {
        this.push_validation_error(errors, `${path}._when must include _type xdata/event and _key`);
      }
    }
  }

  private validate_flow_artifact(
    flow: XVibeFlowArtifact,
    registry: XVibeRuntimeRegistry,
    errors: string[],
  ): void {
    if (typeof flow._id !== "string" || flow._id.trim().length === 0) {
      this.push_validation_error(errors, "_flow requires non-empty _id");
    }

    if ((flow as XVibeJsonObject)._output !== undefined) {
      this.push_validation_error(errors, "_flow._output is not supported; use step-level _output only");
    }

    if (!Array.isArray(flow._steps)) {
      this.push_validation_error(errors, "_flow._steps must be an array");
      return;
    }

    flow._steps.forEach((step, index) =>
      this.validate_flow_step(step, `_flow._steps[${index}]`, registry, errors)
    );
  }

  private validate_entity_artifact(
    entity: XVibeEntityArtifact,
    errors: string[],
  ): void {
    if (typeof entity._id !== "string" || entity._id.trim().length === 0) {
      this.push_validation_error(errors, "_entity requires non-empty _id");
    }

    if (!_xu.is_plain_object(entity._schema)) {
      this.push_validation_error(errors, "_entity._schema must be an object");
      return;
    }

    for (const [field_name, field] of Object.entries(entity._schema)) {
      if (!_xu.is_plain_object(field)) {
        this.push_validation_error(errors, `_entity._schema.${field_name} must be an object`);
        continue;
      }

      if (typeof field._type !== "string" || field._type.trim().length === 0) {
        this.push_validation_error(errors, `_entity._schema.${field_name} requires non-empty _type`);
      }
    }
  }

  private validate_generated_artifact(input: {
    _artifact_type: VibeArtifactType;
    _artifact: XVibeGeneratedArtifact;
    _prompt: string;
    _runtime_skills: unknown;
    _runtime_plan?: XVibeRuntimePlan;
    _generated_artifacts?: unknown;
    _planned_flow_ids?: string[];
    _deterministic_mutation?: XVibeDeterministicViewEditResult["_mutation"];
  }): XVibeArtifactValidationResult {
    let registry =
      runtime_registry_from_plan(input._runtime_plan) ??
      collect_runtime_registry(input._runtime_skills);
    const errors: string[] = [];

    if (input._artifact_type === "view") {
      if (registry._xui_types.size === 0) {
        _xlog.warn("[xvibe] runtime XUI registry empty; using fallback validation types");
        registry = {
          ...registry,
          _xui_types: new Set(FALLBACK_XUI_VALIDATION_TYPES),
          _ops: registry._ops,
        };
      }
      registry = {
        ...registry,
        _xui_types: new Set([...registry._xui_types, "xvm-view"]),
      };

      this.validate_view_artifact(
        input._artifact as XVibeViewArtifact,
        input._prompt,
        registry,
        errors,
        {
          _generated_artifacts: input._generated_artifacts,
          _planned_flow_ids: input._planned_flow_ids,
          _allow_inline_style:
            deterministic_mutation_allows_inline_style(input._deterministic_mutation),
        },
      );
    } else if (input._artifact_type === "flow") {
      this.validate_flow_artifact(
        input._artifact as XVibeFlowArtifact,
        registry,
        errors,
      );
    } else if (input._artifact_type === "entity") {
      this.validate_entity_artifact(
        input._artifact as XVibeEntityArtifact,
        errors,
      );
    } else {
      this.validate_command_shape(input._artifact, "_command", registry, errors);
    }

    return errors.length === 0
      ? { _ok: true, _errors: [] }
      : { _ok: false, _errors: errors };
  }

  private validation_error_summary(errors: string[]): string {
    return errors
      .slice(0, MAX_REPAIR_ERRORS)
      .map((error, index) => `${index + 1}. ${error}`)
      .join("\n");
  }

  private parsed_artifact_for_type(
    parsed: VibeParsedOutput,
    artifact_type: VibeArtifactType,
  ): XVibeGeneratedArtifact {
    if (artifact_type === "view" && parsed._view) return parsed._view;
    if (artifact_type === "flow" && parsed._flow) return parsed._flow;
    if (artifact_type === "entity" && parsed._entity) return parsed._entity;
    if (artifact_type === "command" && parsed._command) return parsed._command;

    throw new Error(`Invalid repaired AI output: expected '${artifact_type}' artifact`);
  }

  private async repair_generated_artifact(input: {
    _prompt: string;
    _artifact_type: VibeArtifactType;
    _artifact: XVibeGeneratedArtifact;
    _validation_errors: string[];
    _project_memory?: unknown;
  }): Promise<XVibeGeneratedArtifact> {
    const repair_prompt = [
      "You are an Xpell JSON artifact repairer.",
      "Return corrected JSON only.",
      `Preserve requested artifact type: ${input._artifact_type}.`,
      `Corrected JSON MUST keep _artifact_type as "${input._artifact_type}".`,
      ...(input._artifact_type === "view"
        ? [
          "Reject and fix empty semantic shells.",
          "Buttons require visible _text or _label; action buttons require _on or _flow.",
          "Do NOT add _flow to buttons unless the user explicitly mentions a flow id or asks for a button to trigger/run/execute/call a flow.",
          "If no explicit flow is requested, remove _flow from buttons.",
          "Never invent missing flows to satisfy validation.",
          "Event handlers under _on / _once may be strings, command objects, or arrays of command objects.",
          'Module commands use { "_module": "...", "_op": "...", "_params": {} }.',
          'Object nano-commands use { "_object": "...", "_op": "...", "_params": {} }.',
          "Do not put _params directly under _on.",
          "Do not use _command on buttons.",
          "Use _on._click for button click handlers.",
          "field is a wrapper only; input config goes in _control.",
          "Never put _name or _placeholder directly on field.",
          "Fields require _control with _type and name or _name for input-like controls.",
          "Tables require _columns or valid _data_source.",
          "KPI cards require _label/_title and _value, or meaningful children.",
          "Navlists require _items or navigation children.",
          "Modals and drawers require content or children.",
          "Cards, grids, sidebars, toolbars, and xsections require meaningful non-empty children.",
        ]
        : []),
      ...(input._artifact_type === "flow"
        ? [
          'Flow steps must use top-level fields: { "_id": "...", "_module": "...", "_op": "...", "_params": {} }.',
          "Flow steps must not use nested _command objects.",
          "Do not use root-level _flow._output; use step-level _output only.",
        ]
        : []),
      "",
      "Original prompt:",
      input._prompt,
      "",
      ...(input._project_memory !== undefined
        ? [
          "Project Memory:",
          JSON.stringify(input._project_memory),
          "",
        ]
        : []),
      "Generated JSON:",
      JSON.stringify(this.artifact_envelope(input._artifact_type, input._artifact), null, 2),
      "",
      "Validation errors:",
      this.validation_error_summary(input._validation_errors),
      "",
      "Return corrected JSON only.",
    ].join("\n");

    const xai_result: any =
      unwrap_command_result(
        await _x.execute({
          _module: "xai",
          _op: "generate",
          _params: {
            _prompt: repair_prompt,
            response_format: {
              type: "json_object"
            }
          }
        } as any)
      );

    const parsed =
      this.output_parser.parse(
        read_generated_text(xai_result),
        input._artifact_type,
      );

    if (parsed._artifact_type !== input._artifact_type) {
      throw new Error(
        `Invalid repaired AI output: expected '${input._artifact_type}' artifact but received '${parsed._artifact_type}'`,
      );
    }

    return this.parsed_artifact_for_type(parsed, input._artifact_type);
  }

  private async validate_or_repair_generated_artifact(input: {
    _prompt: string;
    _artifact_type: VibeArtifactType;
    _artifact: XVibeGeneratedArtifact;
    _runtime_skills: unknown;
    _runtime_plan?: XVibeRuntimePlan;
    _generated_artifacts?: unknown;
    _planned_flow_ids?: string[];
    _deterministic_mutation?: XVibeDeterministicViewEditResult["_mutation"];
    _project_memory?: unknown;
    _archive_validation?: XVibeRunValidationArchive;
    _progress?: XVibeGenerationProgressCallback;
  }): Promise<XVibeGeneratedArtifact> {
    const validation = this.validate_generated_artifact(input);
    if (input._archive_validation) {
      input._archive_validation._validation_result = validation;
    }

    if (validation._ok) {
      return input._artifact;
    }

    _xlog.warn("[xvibe] validation failed", {
      _artifact_type: input._artifact_type,
      _errors: validation._errors,
    });

    _xlog.log("[xvibe] repair attempt", {
      _artifact_type: input._artifact_type,
    });
    input._progress?.(
      "repairing",
      "Repairing artifact...",
      {
        _artifact_type: input._artifact_type,
        _repair_attempt: 1,
      },
    );

    let repaired: XVibeGeneratedArtifact;
    if (input._archive_validation) {
      input._archive_validation._repair_attempts =
        input._archive_validation._repair_attempts ?? [];
      input._archive_validation._repair_attempts.push({
        _artifact_type: input._artifact_type,
        _started_at: new Date().toISOString(),
        _validation_errors: validation._errors,
      });
    }

    try {
      repaired = await this.repair_generated_artifact({
        _prompt: input._prompt,
        _artifact_type: input._artifact_type,
        _artifact: input._artifact,
        _validation_errors: validation._errors,
        ...(input._project_memory !== undefined
          ? { _project_memory: input._project_memory }
          : {}),
      });
    } catch (error) {
      _xlog.warn("[xvibe] repair failed", {
        _artifact_type: input._artifact_type,
        _reason: error instanceof Error ? error.message : String(error),
      });
      if (input._archive_validation) {
        input._archive_validation._repair_errors =
          input._archive_validation._repair_errors ?? [];
        input._archive_validation._repair_errors.push(error_summary(error));
        const last_attempt =
          input._archive_validation._repair_attempts?.[
          input._archive_validation._repair_attempts.length - 1
          ];
        if (last_attempt) {
          last_attempt._ok = false;
          last_attempt._error = error_summary(error);
          last_attempt._completed_at = new Date().toISOString();
        }
      }
      throw error;
    }

    if (
      input._artifact_type === "view" &&
      !prompt_allows_view_flow_triggers(input._prompt)
    ) {
      const removed = strip_unrequested_flow_triggers(repaired);
      if (removed > 0) {
        _xlog.warn("[xvibe] stripped unrequested view flow triggers", {
          _count: removed,
          _artifact_type: "view"
        });
      }
    }

    if (input._artifact_type === "view") {
      this.assign_view_ids(repaired);
    }

    const repaired_validation =
      this.validate_generated_artifact({
        ...input,
        _artifact: repaired,
      });
    if (input._archive_validation) {
      input._archive_validation._repaired_validation_result =
        repaired_validation;
    }

    if (!repaired_validation._ok) {
      _xlog.warn("[xvibe] repair failed", {
        _artifact_type: input._artifact_type,
        _errors: repaired_validation._errors,
      });
      if (input._archive_validation) {
        input._archive_validation._repair_errors =
          input._archive_validation._repair_errors ?? [];
        input._archive_validation._repair_errors.push({
          _errors: repaired_validation._errors,
        });
        const last_attempt =
          input._archive_validation._repair_attempts?.[
          input._archive_validation._repair_attempts.length - 1
          ];
        if (last_attempt) {
          last_attempt._ok = false;
          last_attempt._errors = repaired_validation._errors;
          last_attempt._completed_at = new Date().toISOString();
        }
      }
      throw new Error(
        `Invalid repaired AI output: ${this.validation_error_summary(repaired_validation._errors)}`
      );
    }

    _xlog.log("[xvibe] repair success", {
      _artifact_type: input._artifact_type,
    });
    if (input._archive_validation) {
      const last_attempt =
        input._archive_validation._repair_attempts?.[
        input._archive_validation._repair_attempts.length - 1
        ];
      if (last_attempt) {
        last_attempt._ok = true;
        last_attempt._completed_at = new Date().toISOString();
      }
    }

    return repaired;
  }

  private build_artifact_generation_context(input: {
    _plan: XVibeAppPlan;
    _intent_plan?: XVibeJsonObject;
    _resolved_task?: XVibeResolvedTask;
    _app_id: string;
    _env: string;
    _generation_id?: string;
  }): XVibeArtifactGenerationContext {
    return {
      _plan: input._plan,
      ...(input._intent_plan ? { _intent_plan: input._intent_plan } : {}),
      ...(input._resolved_task ? { _resolved_task: input._resolved_task } : {}),
      _app_id: input._app_id,
      _env: input._env,
      ...(input._generation_id ? { _generation_id: input._generation_id } : {}),
      _generated: {
        _views: [],
        _flows: [],
        _entities: [],
        _module_specs: [],
      },
    };
  }

  private record_generated_artifact(
    context: XVibeArtifactGenerationContext,
    summary: XVibeGeneratedArtifactSummary,
  ): void {
    if (summary._artifact_type === "view") {
      context._generated._views.push(summary);
      return;
    }

    if (summary._artifact_type === "flow") {
      context._generated._flows.push(summary);
      return;
    }

    if (summary._artifact_type === "entity") {
      context._generated._entities.push(summary);
      return;
    }


    context._generated._module_specs.push(summary);
  }

  private resolve_generated_artifact_id(
    artifact_type: XVibeArtifactPlanType,
    result: XVibeJsonObject,
  ): string {
    const candidate =
      result._artifact_id ??
      result._view_id ??
      result._flow_id ??
      result._entity_id ??
      result._module_spec_id;

    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return candidate.trim();
    }

    throw new Error(
      `Invalid '${artifact_type}' generation result: missing artifact id`
    );
  }

  private summarize_generated_artifact(
    artifact_type: XVibeArtifactPlanType,
    response: unknown,
  ): XVibeGeneratedArtifactSummary {
    if (!_xu.is_plain_object(response) || response._ok !== true) {
      throw new Error(
        `XVibe planned artifact generation failed: ${JSON.stringify(response)}`
      );
    }

    const result = _xu.is_plain_object(response._result)
      ? response._result
      : {};

    return {
      _artifact_type: artifact_type,
      _artifact_id: this.resolve_generated_artifact_id(artifact_type, result),
    };
  }

  private async generate_planned_artifact(
    input: XVibePlannedArtifactInput,
  ): Promise<XVibeGeneratedArtifactSummary> {
    const artifact_type = input._item._artifact_type;

    _xlog.log("[xvibe] artifact generation started", {
      _artifact_type: artifact_type,
      _app_id: input._context._app_id,
    });


    if (artifact_type === "module-spec") {
      const module_spec = await this._generate_module_spec(new XCommand({
        _module: "xvibe",
        _op: "generate-module-spec",
        _params: {
          _prompt: input._prompt,
          _module_id: `${input._context._app_id}-module`,
          _module_name: `${input._context._app_id}-module`,
          _context: input._context,
        },
      }));

      if (module_spec._ok !== true || !module_spec._spec) {
        throw new Error(
          module_spec._error?._message ??
          "XVibe planned module-spec generation failed"
        );
      }

      const summary: XVibeGeneratedArtifactSummary = {
        _artifact_type: "module-spec",
        _artifact_id: module_spec._spec._id,
      };

      _xlog.log("[xvibe] artifact generation completed", {
        _artifact_type: summary._artifact_type,
        _artifact_id: summary._artifact_id,
        _app_id: input._context._app_id,
      });

      return summary;
    }

    const generated = await this.generate_artifact(
      {
        _prompt: input._prompt,
        _app_id: input._context._app_id,
        _env: input._context._env,

        _generated_artifacts:
          input._context._generated,

        ...(input._context._plan._flow_ids
          ? {
            _planned_flow_ids:
              input._context._plan._flow_ids
          }
          : {}),

        ...(input._context._intent_plan
          ? {
            _intent_plan:
              input._context._intent_plan
          }
          : {}),

        ...(input._context._resolved_task
          ? {
            _resolved_task:
              input._context._resolved_task
          }
          : {}),

        ...(artifact_type === "view"
          ? {
            _view_id: input._entry_view_id
          }
          : {}),
        ...(input._context._generation_id
          ? {
            _generation_id: input._context._generation_id
          }
          : {}),
      },
      artifact_type,
    );

    const summary =
      this.summarize_generated_artifact(artifact_type, generated);

    _xlog.log("[xvibe] artifact generation completed", {
      _artifact_type: summary._artifact_type,
      _artifact_id: summary._artifact_id,
      _app_id: input._context._app_id,
    });

    return summary;
  }

  private async generate_planned_artifacts(input: {
    _prompt: string;
    _entry_view_id: string;
    _execution_plan: XVibeArtifactExecutionItem[];
    _context: XVibeArtifactGenerationContext;
  }): Promise<XVibeGeneratedArtifactSummary[]> {
    const generated_artifacts: XVibeGeneratedArtifactSummary[] = [];

    for (const item of input._execution_plan) {
      const summary = await this.generate_planned_artifact({
        _prompt: input._prompt,
        _entry_view_id: input._entry_view_id,
        _item: item,
        _context: input._context,
      });

      this.record_generated_artifact(input._context, summary);
      generated_artifacts.push(summary);
    }

    return generated_artifacts;
  }

  private execution_artifact_type(
    artifact_type: string,
  ): VibeArtifactType | undefined {
    if (
      artifact_type === "view" ||
      artifact_type === "flow" ||
      artifact_type === "entity" ||
      artifact_type === "command"
    ) {
      return artifact_type;
    }

    return undefined;
  }

  private generated_artifacts_payload(
    params: XVibeJsonObject,
    generated_artifacts: XVibeGeneratedArtifactSummary[],
  ): XVibeJsonObject {
    const existing =
      _xu.is_plain_object(params._generated_artifacts)
        ? params._generated_artifacts
        : {};
    const existing_items = (key: string): unknown[] =>
      Array.isArray(existing[key]) ? existing[key] as unknown[] : [];

    return {
      ...existing,
      _views: [
        ...existing_items("_views"),
        ...generated_artifacts.filter((item) => item._artifact_type === "view"),
      ],
      _flows: [
        ...existing_items("_flows"),
        ...generated_artifacts.filter((item) => item._artifact_type === "flow"),
      ],
      _entities: [
        ...existing_items("_entities"),
        ...generated_artifacts.filter((item) => item._artifact_type === "entity"),
      ],
      _module_specs: [
        ...existing_items("_module_specs"),
        ...generated_artifacts.filter((item) => item._artifact_type === "module-spec"),
      ],
    };
  }

  private async execute_artifact_execution_plan(
    input: XVibeArtifactExecutionPlanInput,
  ): Promise<unknown> {
    const pending = [...input._execution_plan._artifacts];
    const completed_ids = new Set<string>();
    const generated_artifacts: XVibeGeneratedArtifactSummary[] = [];
    const skipped_artifacts: XVibeArtifactExecutionPlan["_artifacts"] = [];
    let last_result: unknown;

    _xlog.log("[xvibe] execution start", {
      _app_id: input._app_id,
      _env: input._env,
      _primary_artifact_type: input._execution_plan._primary_artifact_type,
      _artifacts_count: pending.length,
    });

    while (pending.length > 0) {
      let progressed = false;

      for (let index = 0; index < pending.length; index += 1) {
        const item = pending[index];
        const dependencies = item._depends_on ?? [];
        const unresolved_dependencies =
          dependencies.filter((dependency) => !completed_ids.has(dependency));

        if (unresolved_dependencies.length > 0) {
          continue;
        }

        pending.splice(index, 1);
        index -= 1;
        progressed = true;

        _xlog.log("[xvibe] execution artifact", {
          _artifact_type: item._artifact_type,
          _action: item._action,
          ...(item._artifact_id ? { _artifact_id: item._artifact_id } : {}),
          ...(dependencies.length > 0 ? { _depends_on: dependencies } : {}),
        });

        if (item._action !== "create" && item._action !== "update") {
          _xlog.warn("[xvibe] artifact action not supported", {
            _artifact_type: item._artifact_type,
            _action: item._action,
            ...(item._artifact_id ? { _artifact_id: item._artifact_id } : {}),
          });

          const unsupported_result =
            unsupported_artifact_action_result({
              _artifact_type: item._artifact_type,
              _action: item._action,
              ...(item._artifact_id ? { _artifact_id: item._artifact_id } : {}),
            });

          this.finalize_early_generation_failure({
            params: input._params,
            app_id: input._app_id,
            env: input._env,
            ...(input._generation_id ? { generation_id: input._generation_id } : {}),
            prompt: input._prompt,
            artifact_type: item._artifact_type,
            result: unsupported_result,
            fallback_code: XVIBE_ARTIFACT_ACTION_NOT_SUPPORTED,
            ...(read_existing_resolved_task(input._params._resolved_task)
              ? { resolved_task: read_existing_resolved_task(input._params._resolved_task) }
              : {}),
            artifact_plan: input._execution_plan,
            ...(typeof input._params._view_id === "string"
              ? { view_id: input._params._view_id }
              : {}),
          });

          return unsupported_result;
        }

        const artifact_type = this.execution_artifact_type(item._artifact_type);
        if (!artifact_type || artifact_type === "command") {
          _xlog.log("[xvibe] execution artifact skipped", {
            _artifact_type: item._artifact_type,
            _action: item._action,
            ...(item._artifact_id ? { _artifact_id: item._artifact_id } : {}),
            _reason: "unsupported_artifact_type",
          });
          skipped_artifacts.push(item);
          continue;
        }

        const generated_artifacts_payload =
          this.generated_artifacts_payload(input._params, generated_artifacts);
        const execution_params: XVibeJsonObject = {
          ...input._params,
          _prompt: input._prompt,
          _app_id: input._app_id,
          _env: input._env,
          _mode: input._mode,
          _artifact_type: artifact_type,
          _skip_artifact_plan: true,
          _generated_artifacts: generated_artifacts_payload,
          ...(input._generation_id ? { _generation_id: input._generation_id } : {}),
        };

        if (artifact_type === "flow" && item._artifact_id) {
          execution_params._planned_flow_ids = [item._artifact_id];
        }

        if (artifact_type === "view") {
          execution_params._view_id =
            item._artifact_id ??
            input._entry_view_id ??
            input._params._view_id;
          if (dependencies.length > 0) {
            execution_params._planned_flow_ids = dependencies;
          }
        }

        last_result =
          await this.generate_artifact(
            execution_params,
            artifact_type,
          );

        const summary =
          this.summarize_generated_artifact(artifact_type, last_result);
        generated_artifacts.push(summary);
        completed_ids.add(summary._artifact_id);
        if (item._artifact_id) {
          completed_ids.add(item._artifact_id);
        }
      }

      if (!progressed) {
        for (const item of pending.splice(0)) {
          _xlog.log("[xvibe] execution artifact skipped", {
            _artifact_type: item._artifact_type,
            _action: item._action,
            ...(item._artifact_id ? { _artifact_id: item._artifact_id } : {}),
            ...(item._depends_on ? { _depends_on: item._depends_on } : {}),
            _reason: "unresolved_dependencies",
          });
          skipped_artifacts.push(item);
        }
      }
    }

    _xlog.log("[xvibe] execution completed", {
      _app_id: input._app_id,
      _env: input._env,
      _generated_artifacts: generated_artifacts,
      _skipped_artifacts: skipped_artifacts,
    });

    return last_result ?? {
      _ok: true,
      _result: {
        _execution_plan: input._execution_plan,
        _generated_artifacts: generated_artifacts,
        _skipped_artifacts: skipped_artifacts,
      },
    };
  }

  private build_execution_plan_for_intent(
    plan: XVibeAppPlan,
    intent_plan: VibeIntentPlan,
  ): XVibeArtifactExecutionItem[] {
    const base_plan =
      this.planner.build_execution_plan(plan);

    if (
      intent_plan._requires_module !== true &&
      intent_plan._module_ops.length === 0
    ) {
      return base_plan;
    }

    const by_type =
      new Map<XVibeArtifactPlanType, XVibeArtifactExecutionItem>();

    for (const item of base_plan) {
      by_type.set(item._artifact_type, item);
    }

    if (!by_type.has("flow")) {
      by_type.set("flow", {
        _artifact_type: "flow",
        _priority: 30,
      });
    }

    if (!by_type.has("view")) {
      by_type.set("view", {
        _artifact_type: "view",
        _priority: 40,
      });
    }

    return [...by_type.values()]
      .sort((left, right) => left._priority - right._priority);
  }

  private async generate_artifact(params: XVibeJsonObject, forced_artifact_type?: VibeArtifactType) {
    const user_prompt =
      typeof params._prompt === "string"
        ? params._prompt
        : typeof params.prompt === "string"
          ? params.prompt
          : undefined;
    const prompt = resolve_prompt(params);
    const requested_artifact_type = read_artifact_type(params._artifact_type);
    let requested_view_id = read_optional_string(params._view_id, "_view_id");
    const resolved_task =
      read_existing_resolved_task(params._resolved_task) ??
      resolve_xvibe_task({
        _prompt: prompt,
        _requested_artifact_type: requested_artifact_type ?? forced_artifact_type,
        ...(requested_view_id ? { _view_id: requested_view_id } : {}),
      });
    params._resolved_task = resolved_task;
    _xlog.log("[xvibe] resolved task", resolved_task);

    if (
      resolved_task._artifact_type === "view" ||
      requested_artifact_type === "view" ||
      forced_artifact_type === "view"
    ) {
      requested_view_id =
        resolve_final_view_id(resolved_task, requested_view_id);
      params._view_id = requested_view_id;
    } else if (requested_view_id && !normalize_safe_view_id(requested_view_id)) {
      requested_view_id = undefined;
      delete params._view_id;
    }

    if (resolved_task._artifact_type === "module") {
      const app_id = read_required_string(params._app_id, "_app_id");
      const env = read_optional_string(params._env, "_env") ?? DEFAULT_ENV;
      const generation_id = read_optional_generation_id(params._generation_id);
      const effective_generation_id = generation_id ?? RunArchiveManager.safeShortId();
      params._generation_id = effective_generation_id;
      if (generation_id) {
        _xlog.log("[xvibe] generation_id received", {
          _generation_id: generation_id,
        });
      } else {
        _xlog.log("[xvibe] generation_id generated", {
          _generation_id: effective_generation_id,
        });
      }
      const runtime_mode = app_id === "vibe-system" ? "system" : "runtime";
      const runtime_skills =
        this.get_runtime_skills(app_id, env, runtime_mode);

      return this.execute_module_generation_route({
        app_id,
        env,
        runtime_mode,
        prompt: user_prompt ?? prompt,
        runtime_skills,
        resolved_task,
        generation_id: effective_generation_id,
        _progress:
          (stage_name, message, details = {}) => {
            this.push_generation_stage(
              app_id,
              env,
              stage_name,
              message,
              effective_generation_id,
              {
                _artifact_type: "module",
                ...details,
              },
            );
          },
      });
    }

    let planned_flow_ids = read_optional_string_array(params._planned_flow_ids, "_planned_flow_ids");
    const skip_artifact_plan = params._skip_artifact_plan === true;

    _xlog.log("[xvibe] intent classifier input", {
      _prompt: prompt,
      _requested_artifact_type: requested_artifact_type,
      _forced_artifact_type: forced_artifact_type,
      _skip_artifact_plan: skip_artifact_plan,
      _planned_flow_ids: planned_flow_ids,
    });

    const artifact_intent = this.intent_planner.infer_artifact_intent(prompt);
    _xlog.log("[xvibe] artifact intent", {
      _prompt: prompt,
      _intent: artifact_intent,
    });
    const artifact_scope_lock =
      this.create_artifact_scope_lock(artifact_intent);

    const artifact_action_plan = infer_xvibe_artifact_action_plan(prompt);
    if (artifact_action_plan) {
      warn_if_plan_violates_resolved_task(resolved_task, artifact_action_plan);
    }
    if (artifact_action_plan && typeof params._app_id !== "string") {
      _xlog.log("[xvibe] intent-resolution-trace", {
        _prompt: prompt,
        _llm_intent: artifact_action_plan._artifact_type,
        _negative_intents: artifact_intent._forbidden_targets,
        _artifact_action: artifact_action_plan._action,
        _artifact_plan: [artifact_action_plan._artifact_type],
        _final_artifact_type: artifact_action_plan._artifact_type,
      });
      _xlog.log("[xvibe] artifact action intent detected", {
        _artifact_action: artifact_action_plan,
      });

      return {
        _ok: true,
        _artifact_action: artifact_action_plan,
      };
    }

    let mode = read_mode(params._mode);
    const app_id = read_required_string(params._app_id, "_app_id");
    const env = read_optional_string(params._env, "_env") ?? DEFAULT_ENV;
    if (resolved_task._artifact_type === "view" || artifact_scope_lock?._artifact_type === "view") {
      const locked_view_id =
        normalize_safe_view_id(resolved_task._target_id) ??
        normalize_safe_view_id(artifact_scope_lock?._target_id);
      if (locked_view_id && !requested_view_id) {
        requested_view_id = locked_view_id;
        params._view_id = requested_view_id;
      }
      const locked_action =
        resolved_task._artifact_type === "view"
          ? resolved_task._action
          : artifact_scope_lock?._action;
      if (locked_action === "update" && requested_view_id) {
        mode = "refine";
      }
      if (locked_action === "create") {
        mode = "full";
      }

      _xlog.log("[xvibe] artifact scope locked", {
        _artifact_type: "view",
        _action: locked_action,
        ...(locked_view_id ? { _target_id: locked_view_id } : {}),
        _mode: mode,
        _reason:
          resolved_task._artifact_type === "view"
            ? "resolved_view_scope_lock"
            : artifact_scope_lock?._reason,
      });
    }
    const capabilities = read_optional_string_array(params._capabilities, "_capabilities");
    const generation_id = read_optional_generation_id(params._generation_id);
    const effective_generation_id = generation_id ?? RunArchiveManager.safeShortId();
    params._generation_id = effective_generation_id;
    if (generation_id) {
      _xlog.log("[xvibe] generation_id received", {
        _generation_id: generation_id,
      });
    } else {
      _xlog.log("[xvibe] generation_id generated", {
        _generation_id: effective_generation_id,
      });
    }
    log_xvibe_planning_cycle(params, effective_generation_id);
    const supplied_intent_plan = _xu.is_plain_object(params._intent_plan) ? params._intent_plan : {};
    const base_artifact_plan =
      this.intent_planner.build_artifact_plan_from_intent(
        prompt,
        artifact_intent,
        requested_artifact_type,
      );
    warn_if_plan_violates_resolved_task(resolved_task, base_artifact_plan);
    log_artifact_inference_branch(base_artifact_plan);
    warn_suspicious_entity_override(prompt, base_artifact_plan);

    const single_inferred_artifact_type =
      forced_artifact_type ??
      base_artifact_plan._primary_artifact_type;
    let inferred_artifact_plan: XVibeInferredArtifactPlan =
      forced_artifact_type || skip_artifact_plan
        ? {
          _primary_artifact_type: single_inferred_artifact_type,
          _artifact_types: [single_inferred_artifact_type],
          ...(planned_flow_ids.length > 0 ? { _flow_ids: planned_flow_ids } : {}),
          _intent: artifact_intent,
          _reason: forced_artifact_type
            ? "forced_artifact_type"
            : "artifact_plan_skipped",
        }
        : base_artifact_plan;

    let view_scope_warnings: string[] = [];
    if (resolved_task._artifact_type === "view") {
      const view_scope_lock =
        apply_view_scope_lock({
          prompt,
          resolved_task,
          artifact_plan: inferred_artifact_plan,
        });
      inferred_artifact_plan = view_scope_lock._artifact_plan ?? inferred_artifact_plan;
      view_scope_warnings = [
        ...view_scope_warnings,
        ...view_scope_lock._warnings,
      ];
    } else {
      inferred_artifact_plan =
        this.apply_artifact_scope_lock_to_plan(
          artifact_scope_lock,
          inferred_artifact_plan,
        );
    }
    warn_if_plan_violates_resolved_task(resolved_task, inferred_artifact_plan);

    if (artifact_scope_lock?._artifact_type === "view") {
      _xlog.log("[xvibe] artifact scope applied", {
        _artifact_type: artifact_scope_lock._artifact_type,
        _action: artifact_scope_lock._action,
        ...(artifact_scope_lock._target_id ? { _target_id: artifact_scope_lock._target_id } : {}),
        _mode: mode,
      });
    }

    _xlog.log("[xvibe] intent classifier result", {
      _primary_artifact_type: inferred_artifact_plan._primary_artifact_type,
      _artifact_types: inferred_artifact_plan._artifact_types,
      _flow_ids: inferred_artifact_plan._flow_ids,
      _entity_ids: inferred_artifact_plan._entity_ids,
      _reason: inferred_artifact_plan._reason,
    });
    warn_suspicious_entity_override(prompt, inferred_artifact_plan);

    const inferred_artifact_type = inferred_artifact_plan._primary_artifact_type;
    if (inferred_artifact_type === "view" && !requested_view_id) {
      requested_view_id =
        resolve_final_view_id(resolved_task, params._view_id);
      params._view_id = requested_view_id;
    }

    _xlog.log("[xvibe] final artifact selection", {
      _forced_artifact_type: forced_artifact_type,
      _requested_artifact_type: requested_artifact_type,
      _skip_artifact_plan: skip_artifact_plan,
      _primary_artifact_type: inferred_artifact_plan._primary_artifact_type,
      _artifact_types: inferred_artifact_plan._artifact_types,
      _final_artifact_type: inferred_artifact_type,
      _reason: inferred_artifact_plan._reason,
    });
    _xlog.log("[xvibe] intent-resolution-trace", {
      _prompt: prompt,
      _llm_intent: artifact_intent._target,
      _negative_intents: artifact_intent._forbidden_targets,
      _artifact_action: artifact_intent._action,
      _artifact_plan:
        inferred_artifact_plan._execution_plan?._artifacts
          .map((artifact) => artifact._artifact_type) ??
        inferred_artifact_plan._artifact_types,
      _final_artifact_type: inferred_artifact_type,
    });

    if (planned_flow_ids.length === 0 && inferred_artifact_plan._flow_ids?.length) {
      planned_flow_ids = inferred_artifact_plan._flow_ids;
      params._planned_flow_ids = planned_flow_ids;
    } else if (resolved_task._artifact_type === "view" && !inferred_artifact_plan._flow_ids?.length) {
      planned_flow_ids = [];
      delete params._planned_flow_ids;
    }

    _xlog.log("[xvibe] final artifact plan", {
      _primary_artifact_type: inferred_artifact_plan._primary_artifact_type,
      _artifact_types: inferred_artifact_plan._artifact_types,
      ...(planned_flow_ids.length > 0 ? { _flow_ids: planned_flow_ids } : {}),
      ...(inferred_artifact_plan._reason ? { _reason: inferred_artifact_plan._reason } : {}),
    });

    if (inferred_artifact_type === "module") {
      const runtime_mode = app_id === "vibe-system" ? "system" : "runtime";
      const runtime_skills =
        this.get_runtime_skills(app_id, env, runtime_mode);

      return this.execute_module_generation_route({
        app_id,
        env,
        runtime_mode,
        prompt: user_prompt ?? prompt,
        runtime_skills,
        resolved_task,
        generation_id: effective_generation_id,
        _progress:
          (stage_name, message, details = {}) => {
            this.push_generation_stage(
              app_id,
              env,
              stage_name,
              message,
              effective_generation_id,
              {
                _artifact_type: "module",
                ...details,
              },
            );
          },
      });
    }

    const artifact_type: VibeArtifactType = inferred_artifact_type;

    const should_inline_execution_plan =
      should_inline_single_refine_view_execution_plan({
        _mode: mode,
        _artifact_type: artifact_type,
        _execution_plan: inferred_artifact_plan._execution_plan,
        ...(requested_view_id ? { _requested_view_id: requested_view_id } : {}),
      });

    if (
      !forced_artifact_type &&
      !skip_artifact_plan &&
      inferred_artifact_plan._execution_plan?._artifacts.length &&
      !should_inline_execution_plan
    ) {
      return this.execute_artifact_execution_plan({
        _prompt: prompt,
        _params: params,
        _execution_plan: inferred_artifact_plan._execution_plan,
        _app_id: app_id,
        _env: env,
        _mode: mode,
        ...(requested_view_id ? { _entry_view_id: requested_view_id } : {}),
        _generation_id: effective_generation_id,
      });
    }

    if (should_inline_execution_plan) {
      _xlog.log("[xvibe] execution plan inlined", {
        _generation_id: effective_generation_id,
        _artifact_type: artifact_type,
        ...(requested_view_id ? { _view_id: requested_view_id } : {}),
        _reason: "single_refine_view_artifact",
      });
    }

    if (!forced_artifact_type) {
      _xlog.log("[xvibe] inferred artifact type", {
        _prompt: prompt,
        _inferred_artifact_type: inferred_artifact_type,
        _requested_artifact_type: requested_artifact_type ?? null,
      });
    }

    const archive_started_at = Date.now();
    const archive_created_at = new Date().toISOString();
    const archive_validation: XVibeRunValidationArchive = {};
    const archive: XVibeRunArchiveData = {
      _generation_id: effective_generation_id,
      _app_id: app_id,
      _env: env,
      ...(requested_view_id ? { _view_id: requested_view_id } : {}),
      _mode: mode,
      _artifact_type: inferred_artifact_type,
      _resolved_task: resolved_task,
      _artifact_plan: inferred_artifact_plan,
      ...(view_scope_warnings.length > 0 ? { _scope_lock_warnings: view_scope_warnings } : {}),
      _created_at: archive_created_at,
      _user_prompt: user_prompt ?? prompt,
      _validation: archive_validation,
    };
    let behavior_intent: VibeBehaviorIntent = {};
    const stage: XVibeGenerationProgressCallback =
      (stage_name, message, details = {}) => {
        this.push_generation_archive_stage({
          archive,
          started_at: archive_started_at,
          app_id,
          env,
          stage: stage_name,
          message,
          generation_id: archive._generation_id,
          details: {
            _artifact_type: inferred_artifact_type,
            ...(requested_view_id ? { _view_id: requested_view_id } : {}),
            ...details,
          },
        });
      };
    const view_stage: XVibeGenerationProgressCallback =
      (stage_name, message, details) => {
        if (inferred_artifact_type !== "view") return;
        stage(stage_name, message, details);
      };

    try {
      stage(
        "preparing",
        "Preparing generation...",
      );

      if (mode !== "refine") {
        this.log_view_mutation_refine_decision({
          _mode: mode,
          _artifact_type: inferred_artifact_type,
          ...(requested_view_id ? { _view_id: requested_view_id } : {}),
          _prompt: prompt,
          _current_view: undefined,
          _eligible: false,
        });
      }

      if (mode === "refine" && inferred_artifact_type !== "view") {
        this.log_view_mutation_refine_decision({
          _mode: mode,
          _artifact_type: inferred_artifact_type,
          ...(requested_view_id ? { _view_id: requested_view_id } : {}),
          _prompt: prompt,
          _current_view: undefined,
          _eligible: false,
        });

        throw new Error("Invalid '_mode': refine is only supported for view artifacts");
      }

      if (mode === "refine" && !requested_view_id) {
        this.log_view_mutation_refine_decision({
          _mode: mode,
          _artifact_type: inferred_artifact_type,
          _prompt: prompt,
          _current_view: undefined,
          _eligible: false,
        });

        throw new Error("Invalid '_view_id': expected non-empty string for refine mode");
      }

      _xlog.log("[xvibe] generate", {
        _mode: mode,
        _artifact_type: inferred_artifact_type,
        ...(capabilities.length > 0 ? { _capabilities: capabilities } : {}),
        _app_id: app_id,
        _env: env,
        _generation_id: effective_generation_id,
      });

      const runtime_mode = app_id === "vibe-system" ? "system" : "runtime";

      let runtime_skills = this.get_runtime_skills(app_id, env, runtime_mode);

      stage(
        "planning",
        "Planning intent...",
      );
      const planning_started_at = Date.now();
      let intent_plan = this.create_artifact_intent_plan({
        prompt,
        artifact_type: inferred_artifact_type,
        supplied_intent_plan,
        runtime_skills,
      });
      if (resolved_task._artifact_type === "view") {
        const view_scope_lock =
          apply_view_scope_lock({
            prompt,
            resolved_task,
            intent_plan,
          });
        intent_plan = view_scope_lock._intent_plan ?? intent_plan;
        view_scope_warnings = [
          ...view_scope_warnings,
          ...view_scope_lock._warnings,
        ];
        if (view_scope_warnings.length > 0) {
          archive._scope_lock_warnings = Array.from(new Set(view_scope_warnings));
        }
      } else {
        intent_plan =
          this.apply_artifact_scope_lock_to_intent_plan(
            artifact_scope_lock,
            intent_plan,
          );
      }
      warn_if_plan_violates_resolved_task(resolved_task, intent_plan);
      _xlog.log("[xvibe] artifact intent selected", {
        _artifact_type: inferred_artifact_type,
        _intent_plan: intent_plan,
      });
      archive._intent_plan = intent_plan;

      // View generation now discovers server modules from
      // actual xvm.call-server wiring later.
      // Prevent generic placeholder modules from being created.

      if (
        artifact_type === "view" &&
        intent_plan._module_name === "generated-module"
      ) {
        _xlog.log("[xvibe] suppressing generic module inference", {
          _artifact_type: inferred_artifact_type,
          _module_name: intent_plan._module_name,
        });

        intent_plan = {
          ...intent_plan,
          _requires_module: false,
          _module_target: null,
          _module_name: "",
          _module_ops: [],
          _module_reason: "",
        };
        archive._intent_plan = intent_plan;
      }

      behavior_intent =
        this.behavior_planner.infer_behavior_intent({
          _prompt: prompt,
          _artifact_type: artifact_type,
          _artifact_action_plan: artifact_action_plan,
          _artifact_intent: artifact_intent,
          _intent_plan: intent_plan,
        }) ?? { _behavior: "unknown" };
      if (resolved_task._artifact_type === "view") {
        const view_scope_lock =
          apply_view_scope_lock({
            prompt,
            resolved_task,
            behavior_intent,
          });
        behavior_intent = view_scope_lock._behavior_intent ?? behavior_intent;
        view_scope_warnings = [
          ...view_scope_warnings,
          ...view_scope_lock._warnings,
        ];
        if (view_scope_warnings.length > 0) {
          archive._scope_lock_warnings = Array.from(new Set(view_scope_warnings));
        }
      }
      _xlog.log("[xvibe] behavior intent", behavior_intent);
      _xlog.log("[xvibe] behavior planning completed", {
        _artifact_type: artifact_type,
        _behavior: behavior_intent?._behavior,
      });
      archive._behavior_intent = behavior_intent;

      const module_ensure_result =
        await this.ensure_server_module_for_intent({
          app_id,
          env,
          runtime_mode,
          prompt,
          intent_plan,
          _progress: stage,
        });

      intent_plan = module_ensure_result._intent_plan;
      if (resolved_task._artifact_type === "view") {
        const view_scope_lock =
          apply_view_scope_lock({
            prompt,
            resolved_task,
            intent_plan,
          });
        intent_plan = view_scope_lock._intent_plan ?? intent_plan;
        view_scope_warnings = [
          ...view_scope_warnings,
          ...view_scope_lock._warnings,
        ];
        if (view_scope_warnings.length > 0) {
          archive._scope_lock_warnings = Array.from(new Set(view_scope_warnings));
        }
      } else {
        intent_plan =
          this.apply_artifact_scope_lock_to_intent_plan(
            artifact_scope_lock,
            intent_plan,
          );
      }
      warn_if_plan_violates_resolved_task(resolved_task, intent_plan);
      archive._intent_plan = intent_plan;

      if (prompt_requests_module_only(prompt)) {
        if (!module_ensure_result._module_name) {
          throw new Error("Unable to infer module requirement from prompt");
        }

        _xlog.log("[xvibe] module-only request completed", {
          _module_name: module_ensure_result._module_name,
          _module_ops: module_ensure_result._module_ops,
          _created: module_ensure_result._created,
          _available: module_ensure_result._available,
        });

        archive._result = {
          _artifact_type: "module",
          _artifact_id: module_ensure_result._module_name,
          _module_name: module_ensure_result._module_name,
          _module_ops: module_ensure_result._module_ops,
          _success: true,
          ...(module_ensure_result._created !== undefined
            ? { _created: module_ensure_result._created }
            : {}),
          ...(module_ensure_result._available !== undefined
            ? { _available: module_ensure_result._available }
            : {}),
        };

        stage(
          "selecting-skills",
          "Selecting skills...",
        );
        stage(
          "skills-selected",
          "Skills selected",
          {
            _module_name: module_ensure_result._module_name,
            _module_ops: module_ensure_result._module_ops,
          },
        );
        stage(
          "building-prompt",
          "Building prompt...",
        );
        stage(
          "generating",
          "Generating module...",
        );
        stage(
          "parsing",
          "Parsing module...",
        );
        stage(
          "validating",
          "Validating artifact...",
          {
            _artifact_id: module_ensure_result._module_name,
            _module_name: module_ensure_result._module_name,
          },
        );
        stage(
          "saving",
          "Saving module...",
          {
            _artifact_id: module_ensure_result._module_name,
            _module_name: module_ensure_result._module_name,
          },
        );
        stage(
          "complete",
          "Module ready",
          {
            _artifact_id: module_ensure_result._module_name,
            _module_name: module_ensure_result._module_name,
          },
        );
        this.push_generation_complete({
          app_id,
          env,
          artifact_type: "module",
          artifact_id: module_ensure_result._module_name,
          message: "Module ready",
          generation_id: archive._generation_id,
          details: {
            _module_name: module_ensure_result._module_name,
            _module_ops: module_ensure_result._module_ops,
          },
        });

        return {
          _ok: true,
          _result: {
            _artifact_type: "module",
            _module_name: module_ensure_result._module_name,
            _module_ops: module_ensure_result._module_ops,
            ...(module_ensure_result._created !== undefined
              ? { _created: module_ensure_result._created }
              : {}),
            ...(module_ensure_result._available !== undefined
              ? { _available: module_ensure_result._available }
              : {}),
          },
        };
      }

      runtime_skills = this.get_runtime_skills(app_id, env, runtime_mode);

      const selection_started_at = Date.now();
      stage(
        "selecting-skills",
        "Selecting skills...",
      );
      const raw_selection = this.selector.select(
        prompt,
        artifact_type,
        capabilities,
        runtime_skills,
        intent_plan
      );
      const selection =
        artifact_type === "view"
          ? selection_with_supported_xui_skills(raw_selection, runtime_skills)
          : raw_selection;
      const preliminary_edit_intent =
        build_view_edit_intent({
          resolved_task,
          prompt,
        });
      let final_selection =
        artifact_type === "view"
          ? filter_selection_for_view_edit(selection, prompt, preliminary_edit_intent)
          : selection;

      _xlog.log("[xvibe] selected skills", {
        _artifact_type: artifact_type,
        _skill_ids: final_selection.skill_ids,
      });
      archive._selected_skill_ids = final_selection.skill_ids;
      archive._selected_skills = RunArchiveManager.selectedSkillsPayload(final_selection);
      stage(
        "skills-selected",
        "Skills selected",
        {
          _skill_ids: final_selection.skill_ids,
          _duration_ms: Date.now() - selection_started_at,
          _planning_duration_ms: selection_started_at - planning_started_at,
        },
      );

      if (mode === "refine" && requested_view_id) {
        view_stage(
          "loading-view",
          "Loading current view...",
          {
            _view_id: requested_view_id,
          },
        );
      }
      const current_view =
        mode === "refine" && requested_view_id
          ? await this.load_current_view_for_refine({
            _app_id: app_id,
            _env: env,
            _view_id: requested_view_id,
          })
          : undefined;

      let use_view_mutation = false;
      const edit_intent =
        build_view_edit_intent({
          resolved_task,
          prompt,
          current_view,
        });
      if (edit_intent) {
        final_selection =
          ensure_selection_includes_xui_type(
            final_selection,
            "view",
          );
        archive._selected_skill_ids = final_selection.skill_ids;
        archive._selected_skills = RunArchiveManager.selectedSkillsPayload(final_selection);
      }
      if (edit_intent?._target_type) {
        final_selection =
          ensure_selection_includes_xui_type(
            final_selection,
            edit_intent._target_type,
          );
        archive._selected_skill_ids = final_selection.skill_ids;
        archive._selected_skills = RunArchiveManager.selectedSkillsPayload(final_selection);
      }
      if (mode === "refine" && artifact_type === "view") {
        use_view_mutation =
          edit_intent
            ? false
            : this.should_use_view_mutation(prompt, current_view);

        this.log_view_mutation_refine_decision({
          _mode: mode,
          _artifact_type: artifact_type,
          ...(requested_view_id ? { _view_id: requested_view_id } : {}),
          _prompt: prompt,
          _current_view: current_view,
          _eligible: use_view_mutation,
        });
      }

      const runtime_context = await this.collect_runtime_awareness_context({
        _app_id: app_id,
        _env: env,

        ...(requested_view_id
          ? { _view_id: requested_view_id }
          : {}),

        ...(current_view
          ? { _current_view: current_view }
          : {}),

        ...(_xu.is_plain_object(params._generated_artifacts)
          ? { _generated_artifacts: params._generated_artifacts }
          : {}),

        _runtime_skills: runtime_skills,
      });
      const project_memory = runtime_context._project_memory;
      if (edit_intent) {
        runtime_context._edit_intent = edit_intent;
      }
      const runtime_plan =
        build_xvibe_runtime_plan({
          _runtime_assets:
            _xu.is_plain_object(runtime_context._runtime_assets)
              ? runtime_context._runtime_assets as XVibeRuntimeAssets
              : {
                _views: [],
                _flows: [],
                _entities: [],
                _modules: [],
              },
          _runtime_skills: runtime_skills,
          _resolved_task: resolved_task,
          _intent_plan: intent_plan,
        });
      runtime_context._runtime_plan = runtime_plan;
      runtime_context._behavior_intent = behavior_intent;
      if (artifact_type === "view") {
        const selected_xui_objects =
          supported_intent_xui_objects(intent_plan._xui_objects, runtime_skills);
        runtime_context._selected_xui_objects = selected_xui_objects;
        runtime_context._allowed_xui_objects = selected_xui_objects;
      }
      archive._runtime_plan = runtime_plan;
      archive._runtime_context = {
        ...runtime_context,
        _selected_modules: intent_plan._modules,
        _selected_objects: intent_plan._objects,
        _selected_xui_objects:
          artifact_type === "view"
            ? runtime_context._selected_xui_objects
            : intent_plan._xui_objects,
        _selected_entities: intent_plan._entities,
      };

      let deterministic_view_edit_attempted = false;
      if (
        mode === "refine" &&
        artifact_type === "view" &&
        edit_intent &&
        current_view &&
        requested_view_id &&
        resolved_task_is_explicit_view_child_edit(resolved_task)
      ) {
        deterministic_view_edit_attempted = true;
        const deterministic_persist_result =
          await this.try_apply_deterministic_view_edit_for_refine({
            app_id,
            env,
            mode,
            prompt,
            runtime_skills,
            requested_view_id,
            current_view,
            edit_intent,
            generated_artifacts: params._generated_artifacts,
            planned_flow_ids,
            runtime_plan,
            resolved_task,
            generation_id: effective_generation_id,
            archive,
            archive_started_at,
            progress: stage,
          });

        if (deterministic_persist_result) {
          return deterministic_persist_result;
        }
      }

      let validation_plan =
        validate_xvibe_generation_plan({
          resolved_task,
          artifact_plan: inferred_artifact_plan,
          intent_plan,
          runtime_plan,
        });
      validation_plan =
        defer_view_child_edit_validation_leakage({
          validation_plan,
          resolved_task,
          deterministic_attempted: deterministic_view_edit_attempted,
        });
      archive._validation_plan = validation_plan;
      _xlog.log("[xvibe] validation plan", validation_plan);
      if (!validation_plan._ok) {
        const result =
          validation_plan_error_result({
            _validation_plan: validation_plan,
            _resolved_task: resolved_task,
          });
        archive._result = {
          _success: false,
          _artifact_type: artifact_type,
          ...(requested_view_id ? { _artifact_id: requested_view_id } : {}),
          _error: result._error,
        };
        stage(
          "failed",
          "Generation plan validation failed",
          {
            _artifact_type: artifact_type,
            ...(requested_view_id ? { _view_id: requested_view_id } : {}),
            _validation_plan: validation_plan,
          },
        );
        return result;
      }

      if (
        mode === "refine" &&
        artifact_type === "view" &&
        edit_intent &&
        current_view &&
        requested_view_id &&
        !deterministic_view_edit_attempted
      ) {
        const deterministic_persist_result =
          await this.try_apply_deterministic_view_edit_for_refine({
            app_id,
            env,
            mode,
            prompt,
            runtime_skills,
            requested_view_id,
            current_view,
            edit_intent,
            generated_artifacts: params._generated_artifacts,
            planned_flow_ids,
            runtime_plan,
            resolved_task,
            generation_id: effective_generation_id,
            archive,
            archive_started_at,
            progress: stage,
          });

        if (deterministic_persist_result) {
          return deterministic_persist_result;
        }
      }

      // verbose_log("[xvibe] runtime context", runtime_context);

      if (use_view_mutation && requested_view_id) {
        const mutation_response =
          await this.try_apply_view_mutation({
            app_id,
            env,
            view_id: requested_view_id,
            prompt,
            current_view,
            include_artifact_type: forced_artifact_type !== "view",
            archive,
            progress: view_stage,
            archive_started_at,
          });

        if (mutation_response) {
          return mutation_response;
        }
      }

      let deterministic_skeleton: XVibeViewArtifact | undefined;

      if (artifact_type === "view" && mode !== "refine") {
        const artifact_factory_diagnostics: VibeArtifactFactoryDiagnostic[] = [];
        deterministic_skeleton = this.view_builder.build({
          _intent_ir: intent_plan,
          _prompt: prompt,
          _runtime_context: runtime_context,
          _runtime_skills: runtime_skills,
          _planned_flow_ids: planned_flow_ids,
          _selected_skills: final_selection.skills,
          _artifact_factory_diagnostics: artifact_factory_diagnostics,
        });

        verbose_log("[xvibe] artifact factory diagnostics", {
          _diagnostics: artifact_factory_diagnostics,
        });

        const skeleton_validation = this.validate_generated_artifact({
          _prompt: prompt,
          _artifact_type: "view",
          _artifact: deterministic_skeleton,
          _runtime_skills: runtime_skills,
          _runtime_plan: runtime_plan,
          _generated_artifacts: params._generated_artifacts,
          _planned_flow_ids: planned_flow_ids,
        });

        if (!skeleton_validation._ok) {
          throw new Error(
            `Invalid deterministic view skeleton: ${this.validation_error_summary(skeleton_validation._errors)}`
          );
        }

        verbose_log("[xvibe] resolved skeleton flow ids", {
          _flow_ids: collect_view_flow_ids(deterministic_skeleton),
        });

        verbose_log("[xvibe] deterministic skeleton validation success", {
          _artifact_type: "view",
          _view_id: deterministic_skeleton._id,
        });

        verbose_log("[xvibe] deterministic view skeleton", {
          _view: deterministic_skeleton,
        });
      }

      const prompt_started_at = Date.now();
      stage(
        "building-prompt",
        "Building prompt...",
      );
      const final_prompt = this.prompt_builder.build({
        prompt,
        _mode: mode,
        _artifact_type: artifact_type,
        selection: final_selection,
        runtime_context,
        ...(deterministic_skeleton ? { deterministic_skeleton } : {}),
      });
      archive._final_prompt = final_prompt;

      if (mode === "refine") {
        _xlog.log("[xvibe] refine prompt mode", {
          _app_id: app_id,
          _env: env,
          _view_id: requested_view_id,
        });
      }

      // verbose_log("[xvibe] FINAL PROMPT", { _prompt: final_prompt });

      const generation_started_at = Date.now();
      stage(
        "generating",
        "Generating JSON...",
        {
          _duration_ms: generation_started_at - prompt_started_at,
        },
      );
      const xai_result: any = unwrap_command_result(
        await _x.execute({
          _module: "xai",
          _op: "generate",
          _params: {
            _prompt: final_prompt,
            response_format: {
              type: "json_object",
            },
          },
        } as any)
      );
      archive._ai_output = xai_result;

      // verbose_log("[xvibe] raw ai output", { _result: xai_result });

      stage(
        "parsing",
        "Parsing response...",
        {
          _duration_ms: Date.now() - generation_started_at,
        },
      );
      const parsed = this.output_parser.parse(
        read_generated_text(xai_result),
        artifact_type
      );

      if (parsed._artifact_type !== artifact_type) {
        throw new Error(
          `Invalid AI output: expected '${artifact_type}' artifact but received '${parsed._artifact_type}'`
        );
      }

      if (artifact_type === "view") {
        if (!parsed._view) {
          throw new Error("Invalid AI output: expected parsed view artifact");
        }

        return this.persist_view_artifact({
          app_id,
          env,
          mode,
          prompt,
          runtime_skills,
          requested_view_id,
          parsed_view: parsed._view,
          generated_artifacts: params._generated_artifacts,
          planned_flow_ids,
          runtime_plan,
          resolved_task,
          generation_id: effective_generation_id,
          ...(project_memory !== undefined
            ? { project_memory }
            : {}),
          include_artifact_type: forced_artifact_type !== "view",
          archive,
          archive_started_at,
          progress: stage,
        });
      }

      if (artifact_type === "flow") {
        if (!parsed._flow) {
          throw new Error("Invalid AI output: expected parsed flow artifact");
        }

        if (planned_flow_ids.length === 1) {
          parsed._flow._id = planned_flow_ids[0];

          verbose_log("[xvibe] forced planned flow id", {
            _flow_id: planned_flow_ids[0],
          });
        }

        const validation_started_at = Date.now();
        stage(
          "validating",
          "Validating artifact...",
          {
            _artifact_type: "flow",
          },
        );
        const flow = await this.validate_or_repair_generated_artifact({
          _prompt: prompt,
          _artifact_type: "flow",
          _artifact: parsed._flow,
          _runtime_skills: runtime_skills,
          _runtime_plan: runtime_plan,
          ...(project_memory !== undefined
            ? { _project_memory: project_memory }
            : {}),
          _archive_validation: archive_validation,
          _progress: stage,
        }) as XVibeFlowArtifact;

        const flow_id = ensure_artifact_id(flow, "_flow._id");
        const saving_started_at = Date.now();
        stage(
          "saving",
          "Saving flow...",
          {
            _artifact_type: "flow",
            _artifact_id: flow_id,
            _flow_id: flow_id,
            _duration_ms: saving_started_at - validation_started_at,
          },
        );
        const result = await this.persist_flow_artifact(app_id, env, flow, archive);
        if (_xu.is_plain_object(result) && result._ok === false) {
          throw new XVibeStructuredError(result);
        }
        if (!archive._result) {
          archive._result = RunArchiveManager.archiveResultFromResponse("flow", result);
        }
        stage(
          "complete",
          "Flow updated",
          {
            _artifact_type: "flow",
            _artifact_id: flow_id,
            _flow_id: flow_id,
            _duration_ms: Date.now() - archive_started_at,
            _save_duration_ms: Date.now() - saving_started_at,
          },
        );
        this.push_generation_complete({
          app_id,
          env,
          artifact_type: "flow",
          artifact_id: flow_id,
          message: "Flow updated",
          generation_id: archive._generation_id,
          details: {
            _flow_id: flow_id,
          },
        });
        return result;
      }

      if (artifact_type === "entity") {
        if (!parsed._entity) {
          throw new Error("Invalid AI output: expected parsed entity artifact");
        }

        const validation_started_at = Date.now();
        stage(
          "validating",
          "Validating artifact...",
          {
            _artifact_type: "entity",
          },
        );
        const entity = await this.validate_or_repair_generated_artifact({
          _prompt: prompt,
          _artifact_type: "entity",
          _artifact: parsed._entity,
          _runtime_skills: runtime_skills,
          _runtime_plan: runtime_plan,
          ...(project_memory !== undefined
            ? { _project_memory: project_memory }
            : {}),
          _archive_validation: archive_validation,
          _progress: stage,
        }) as XVibeEntityArtifact;

        const entity_id = ensure_artifact_id(entity, "_entity._id");
        const saving_started_at = Date.now();
        stage(
          "saving",
          "Saving entity...",
          {
            _artifact_type: "entity",
            _artifact_id: entity_id,
            _entity_id: entity_id,
            _duration_ms: saving_started_at - validation_started_at,
          },
        );
        const result = await this.persist_entity_artifact(app_id, env, entity, archive);
        if (_xu.is_plain_object(result) && result._ok === false) {
          throw new XVibeStructuredError(result);
        }
        if (!archive._result) {
          archive._result = RunArchiveManager.archiveResultFromResponse("entity", result);
        }
        stage(
          "complete",
          "Entity updated",
          {
            _artifact_type: "entity",
            _artifact_id: entity_id,
            _entity_id: entity_id,
            _duration_ms: Date.now() - archive_started_at,
            _save_duration_ms: Date.now() - saving_started_at,
          },
        );
        this.push_generation_complete({
          app_id,
          env,
          artifact_type: "entity",
          artifact_id: entity_id,
          message: "Entity updated",
          generation_id: archive._generation_id,
          details: {
            _entity_id: entity_id,
          },
        });
        return result;
      }

      if (!parsed._command) {
        throw new Error("Invalid AI output: expected parsed command artifact");
      }

      const validation_started_at = Date.now();
      stage(
        "validating",
        "Validating artifact...",
        {
          _artifact_type: "command",
        },
      );
      const command = await this.validate_or_repair_generated_artifact({
        _prompt: prompt,
        _artifact_type: "command",
        _artifact: parsed._command,
        _runtime_skills: runtime_skills,
        _runtime_plan: runtime_plan,
        ...(project_memory !== undefined
          ? { _project_memory: project_memory }
          : {}),
        _archive_validation: archive_validation,
        _progress: stage,
      }) as XVibeCommandArtifact;

      const module_name = read_required_string(command._module, "_command._module");
      const op_name = read_required_string(command._op, "_command._op");
      const command_id = `${module_name}.${op_name}`;
      const saving_started_at = Date.now();
      stage(
        "saving",
        "Saving command...",
        {
          _artifact_type: "command",
          _artifact_id: command_id,
          _module: module_name,
          _op: op_name,
          _duration_ms: saving_started_at - validation_started_at,
        },
      );
      const result = this.return_command_artifact(app_id, env, command, archive);
      if (!archive._result) {
        archive._result = RunArchiveManager.archiveResultFromResponse("command", result);
      }
      stage(
        "complete",
        "Command generated",
        {
          _artifact_type: "command",
          _artifact_id: command_id,
          _module: module_name,
          _op: op_name,
          _duration_ms: Date.now() - archive_started_at,
          _save_duration_ms: Date.now() - saving_started_at,
        },
      );
      this.push_generation_complete({
        app_id,
        env,
        artifact_type: "command",
        artifact_id: command_id,
        message: "Command generated",
        generation_id: archive._generation_id,
        details: {
          _module: module_name,
          _op: op_name,
        },
      });
      return result;
    } catch (error) {
      const diagnostic = parser_diagnostic(error);
      const diagnostics = parser_diagnostics(error);
      const structured = structured_error_payload(error);
      const error_details: Record<string, unknown> = {
        _artifact_type: artifact_type,
        ...(requested_view_id ? { _view_id: requested_view_id } : {}),
        _error: error_summary(error),
        ...(diagnostic ? { _diagnostic: diagnostic } : {}),
        ...(diagnostics ? { _diagnostics: diagnostics } : {}),
      };
      RunArchiveManager.recordStage(
        archive,
        archive_started_at,
        "failed",
        "Generation failed",
        error_details,
      );
      this.push_generation_stage(
        app_id,
        env,
        "failed",
        "Generation failed",
        archive._generation_id,
        error_details as XVibeJsonObject,
      );
      archive._result =
        RunArchiveManager.failureResult(
          artifact_type,
          error,
          requested_view_id,
          {
            ...(diagnostic ? { _diagnostic: diagnostic } : {}),
            ...(diagnostics ? { _diagnostics: diagnostics } : {}),
            ...(structured ? { _structured_error_payload: structured } : {}),
          },
        );
      throw error;
    } finally {
      archive._duration_ms = Date.now() - archive_started_at;
      if (
        _xu.is_plain_object(archive._validation) &&
        Object.keys(archive._validation).length === 0
      ) {
        delete archive._validation;
      }
      RunArchiveManager.archiveVibeRun(archive);
    }
  }

  private async persist_view_artifact(input: {
    app_id: string;
    env: string;
    mode: VibeAIMode;
    prompt: string;
    runtime_skills: unknown;
    requested_view_id?: string;
    parsed_view: XVibeViewArtifact;
    generated_artifacts?: unknown;
    planned_flow_ids?: string[];
    runtime_plan?: XVibeRuntimePlan;
    resolved_task?: XVibeResolvedTask;
    generation_id?: string;
    project_memory?: unknown;
    deterministic_mutation?: XVibeDeterministicViewEditResult["_mutation"];
    source_view_id?: string;
    include_artifact_type: boolean;
    archive?: XVibeRunArchiveData;
    archive_started_at?: number;
    progress?: XVibeGenerationProgressCallback;
  }) {
    let view_to_persist: XVibeJsonObject = input.parsed_view;
    let runtime_skills = input.runtime_skills;
    let runtime_plan = input.runtime_plan;
    const runtime_mode = input.app_id === "vibe-system" ? "system" : "runtime";
    const source_view_id = input.source_view_id ?? input.requested_view_id;
    const source_view_result_fields: XVibeJsonObject =
      input.source_view_id && input.requested_view_id && input.source_view_id !== input.requested_view_id
        ? {
          _source_view_id: input.source_view_id,
          _requested_view_id: input.requested_view_id,
        }
        : {};

    if (input.mode === "refine") {
      _xlog.log("[xvibe] refine full-view replacement", {
        _app_id: input.app_id,
        _env: input.env,
        _view_id: input.requested_view_id,
        ...(source_view_id && source_view_id !== input.requested_view_id
          ? { _source_view_id: source_view_id }
          : {}),
      });
      if (source_view_id) {
        view_to_persist._id = source_view_id;
      }
    } else {
      normalize_full_view_id(view_to_persist, input.requested_view_id);
    }

    ensure_valid_xui_root(view_to_persist);
    this.assign_view_ids(view_to_persist);

    const normalized_commands =
      normalize_known_generated_module_commands(
        view_to_persist,
        runtime_skills,
      );
    if (normalized_commands > 0) {
      _xlog.log("[xvibe] normalized generated module view wiring", {
        _count: normalized_commands,
        _artifact_type: "view",
      });
    }

    const view_module_result =
      await this.ensure_missing_server_modules_from_view({
        app_id: input.app_id,
        env: input.env,
        runtime_mode,
        prompt: input.prompt,
        view: view_to_persist,
        runtime_skills,
        _progress: input.progress,
      });
    runtime_skills = view_module_result._runtime_skills;

    if (view_module_result._created_modules.length > 0) {
      const normalized_after_module_creation =
        normalize_known_generated_module_commands(
          view_to_persist,
          runtime_skills,
        );

      if (normalized_after_module_creation > 0) {
        _xlog.log("[xvibe] normalized generated module view wiring", {
          _count: normalized_after_module_creation,
          _artifact_type: "view",
        });
      }

      if (runtime_plan && input.resolved_task) {
        runtime_plan =
          build_xvibe_runtime_plan({
            _runtime_assets: runtime_assets_from_plan(runtime_plan),
            _runtime_skills: runtime_skills,
            _resolved_task: input.resolved_task,
          });
        if (input.archive) {
          input.archive._runtime_plan = runtime_plan;
        }
      }
    }

    if (!prompt_allows_view_flow_triggers(input.prompt)) {
      const removed = strip_unrequested_flow_triggers(view_to_persist);
      if (removed > 0) {
        _xlog.warn("[xvibe] stripped unrequested view flow triggers", {
          _count: removed,
          _artifact_type: "view"
        });
      }
    }

    const validation_started_at = Date.now();
    input.progress?.(
      "validating",
      "Validating artifact...",
      {
        _artifact_type: "view",
        ...(input.requested_view_id ? { _view_id: input.requested_view_id } : {}),
      },
    );
    view_to_persist =
      await this.validate_or_repair_generated_artifact({
        _prompt: input.prompt,
        _artifact_type: "view",
        _artifact: view_to_persist as XVibeViewArtifact,
        _runtime_skills: runtime_skills,
        _runtime_plan: runtime_plan,
        _generated_artifacts: input.generated_artifacts,
        _planned_flow_ids: input.planned_flow_ids,
        _deterministic_mutation: input.deterministic_mutation,
        ...(input.project_memory !== undefined
          ? { _project_memory: input.project_memory }
          : {}),
        _archive_validation:
          input.archive?._validation as XVibeRunValidationArchive | undefined,
        _progress: input.progress,
      }) as XVibeJsonObject;
    if (input.mode === "refine" && source_view_id) {
      view_to_persist._id = source_view_id;
    } else if (input.mode !== "refine") {
      normalize_full_view_id(view_to_persist, input.requested_view_id);
    }
    this.assign_view_ids(view_to_persist);

    const normalized_repaired_commands =
      normalize_known_generated_module_commands(
        view_to_persist,
        runtime_skills,
      );
    if (normalized_repaired_commands > 0) {
      _xlog.log("[xvibe] normalized generated module view wiring", {
        _count: normalized_repaired_commands,
        _artifact_type: "view",
      });
    }

    this.assign_view_ids(view_to_persist);
    const view_id = read_required_string(view_to_persist._id, "_view._id");
    const saving_started_at = Date.now();
    input.progress?.(
      "saving",
      "Saving view...",
      {
        _artifact_type: "view",
        _view_id: view_id,
        _created_modules: view_module_result._created_modules,
        _duration_ms: saving_started_at - validation_started_at,
      },
    );
    _xlog.log("[xvibe] persist artifact", {
      _artifact_type: "view",
      _artifact_id: view_id,
    });

    if (input.source_view_id && input.requested_view_id && input.source_view_id !== input.requested_view_id) {
      const referenced_persist_context = {
        _requested_view_id: input.requested_view_id,
        _source_view_id: input.source_view_id,
        _view_id: view_id,
        ...(input.deterministic_mutation?._target_id
          ? { _target_id: input.deterministic_mutation._target_id }
          : {}),
        ...(input.deterministic_mutation?._action
          ? { _action: input.deterministic_mutation._action }
          : {}),
      };
      _xlog.log("[xvibe] deterministic referenced view persist", referenced_persist_context);
      if (view_id !== input.source_view_id) {
        _xlog.warn("[xvibe] deterministic referenced view persist mismatch", referenced_persist_context);
        if (input.archive) {
          input.archive._result = {
            _artifact_type: "view",
            _artifact_id: view_id,
            _view_id: view_id,
            ...source_view_result_fields,
            _success: false,
            _error: {
              _code: "E_XVIBE_SOURCE_VIEW_PERSIST_MISMATCH",
              _message: "Deterministic referenced view edit attempted to persist a non-source view",
              _details: referenced_persist_context,
            },
          };
        }
        return explicit_error(
          "E_XVIBE_SOURCE_VIEW_PERSIST_MISMATCH",
          "Deterministic referenced view edit attempted to persist a non-source view",
          referenced_persist_context,
        );
      }
    }

    const persist_response = await _x.execute({
      _module: "server-xvm",
      _op: "push_update",
      _params: {
        _app_id: input.app_id,
        ...(input.env ? { _env: input.env } : {}),
        ...(input.generation_id ? { _generation_id: input.generation_id } : {}),
        _view: view_to_persist,
      },
    } as any);
    const persisted_version =
      extract_persisted_version(persist_response);

    if (input.archive) {
      input.archive._view_id = view_id;
      if (input.source_view_id && input.requested_view_id && input.source_view_id !== input.requested_view_id) {
        input.archive._source_view_id = input.source_view_id;
        input.archive._requested_view_id = input.requested_view_id;
      }
      input.archive._result = {
        _artifact_type: "view",
        _artifact_id: view_id,
        _view_id: view_id,
        ...source_view_result_fields,
        _success: true,
        ...(input.deterministic_mutation
          ? {
            _deterministic: true,
            _mutation_action: input.deterministic_mutation._action,
            _mutation_target_id: input.deterministic_mutation._target_id,
            ...(input.deterministic_mutation._target_path
              ? { _mutation_target_path: input.deterministic_mutation._target_path }
              : {}),
          }
          : {}),
        ...(persisted_version !== undefined
          ? { _persisted_version: persisted_version }
          : {}),
      };
    }

    _xem.fire("vibe:view-updated", {
      _app_id: input.app_id,
      _env: input.env,
      _view_id: view_id,
    });

    _xlog.log("[xvibe] result", {
      _artifact_type: "view",
      _artifact_id: view_id,
    });
    input.progress?.(
      "complete",
      "View updated",
      {
        _artifact_type: "view",
        _view_id: view_id,
        _duration_ms:
          typeof input.archive_started_at === "number"
            ? Date.now() - input.archive_started_at
            : Date.now() - saving_started_at,
        _save_duration_ms: Date.now() - saving_started_at,
      },
    );

    return {
      _ok: true,
      _result: input.deterministic_mutation
        ? {
          _artifact_type: "view",
          _artifact_id: view_id,
          _view_id: view_id,
          ...source_view_result_fields,
          _deterministic: true,
          _mutation_action: input.deterministic_mutation._action,
          _mutation_target_id: input.deterministic_mutation._target_id,
          ...(input.deterministic_mutation._target_path
            ? { _mutation_target_path: input.deterministic_mutation._target_path }
            : {}),
        }
        : input.include_artifact_type
        ? {
          _artifact_type: "view",
          _artifact_id: view_id,
          _view_id: view_id,
        }
        : {
          _view_id: view_id,
        },
    };
  }

  private async persist_flow_artifact(
    app_id: string,
    env: string,
    flow: XVibeFlowArtifact,
    archive?: XVibeRunArchiveData,
  ) {
    if (!server_xvm_has_op("set_flow")) {
      return explicit_error(
        "E_VIBE_AI_SERVER_XVM_OP_MISSING",
        "server-xvm op 'set_flow' is not available",
      );
    }

    const flow_id = ensure_artifact_id(flow, "_flow._id");

    _xlog.log("[xvibe] persist artifact", {
      _artifact_type: "flow",
      _artifact_id: flow_id,
    });

    const persist_response = await _x.execute({
      _module: "server-xvm",
      _op: "set_flow",
      _params: {
        _app_id: app_id,
        ...(env ? { _env: env } : {}),
        _flow: flow,
      },
    } as any);
    const persisted_version =
      extract_persisted_version(persist_response);

    if (archive) {
      archive._result = {
        _artifact_type: "flow",
        _artifact_id: flow_id,
        _flow_id: flow_id,
        _success: true,
        ...(persisted_version !== undefined
          ? { _persisted_version: persisted_version }
          : {}),
      };
    }

    _xem.fire("vibe:flow-updated", {
      _app_id: app_id,
      _env: env,
      _flow_id: flow_id,
    });

    return {
      _ok: true,
      _result: {
        _artifact_type: "flow",
        _artifact_id: flow_id,
        _flow_id: flow_id,
      },
    };
  }

  private async persist_entity_artifact(
    app_id: string,
    env: string,
    entity: XVibeEntityArtifact,
    archive?: XVibeRunArchiveData,
  ) {
    if (!server_xvm_has_op("set_entity")) {
      return explicit_error(
        "E_VIBE_AI_SERVER_XVM_OP_MISSING",
        "server-xvm op 'set_entity' is not available",
      );
    }

    const entity_id = ensure_artifact_id(entity, "_entity._id");

    _xlog.log("[xvibe] persist artifact", {
      _artifact_type: "entity",
      _artifact_id: entity_id,
    });

    const persist_response = await _x.execute({
      _module: "server-xvm",
      _op: "set_entity",
      _params: {
        _app_id: app_id,
        ...(env ? { _env: env } : {}),
        _entity: entity,
      },
    } as any);
    const persisted_version =
      extract_persisted_version(persist_response);

    if (archive) {
      archive._result = {
        _artifact_type: "entity",
        _artifact_id: entity_id,
        _entity_id: entity_id,
        _success: true,
        ...(persisted_version !== undefined
          ? { _persisted_version: persisted_version }
          : {}),
      };
    }

    _xem.fire("vibe:entity-updated", {
      _app_id: app_id,
      _env: env,
      _entity_id: entity_id,
    });

    return {
      _ok: true,
      _result: {
        _artifact_type: "entity",
        _artifact_id: entity_id,
        _entity_id: entity_id,
      },
    };
  }

  private return_command_artifact(
    app_id: string,
    env: string,
    command: XVibeCommandArtifact,
    archive?: XVibeRunArchiveData,
  ) {
    const module_name = read_required_string(command._module, "_command._module");
    const op_name = read_required_string(command._op, "_command._op");
    const command_id = `${module_name}.${op_name}`;

    _xlog.log("[xvibe] generated artifact", {
      _artifact_type: "command",
      _artifact_id: command_id,
    });

    _xem.fire("vibe:command-generated", {
      _app_id: app_id,
      _env: env,
      _module: module_name,
      _op: op_name,
    });

    if (archive) {
      archive._result = {
        _artifact_type: "command",
        _artifact_id: command_id,
        _success: true,
      };
    }

    return {
      _ok: true,
      _result: {
        _artifact_type: "command",
        _artifact_id: command_id,
        _command: command,
      },
    };
  }

  async _apply_view_edit(xcmd: XCommand) {
    return StructuredViewEdit.apply({
      _cmd: xcmd,
      _deps: {
        _list_project_view_ids: async (input) => {
          const list_response = await _x.execute({
            _module: "server-xvm",
            _op: "list_views",
            _params: {
              _app_id: input._app_id,
              _env: input._env,
            },
          } as any);
          return extract_project_view_list_ids(list_response);
        },
        _load_current_view_for_refine:
          this.load_current_view_for_refine.bind(this),
        _load_xvm_view_references_for_refine:
          this.load_xvm_view_references_for_refine.bind(this),
        _can_apply_deterministic_view_edit: can_apply_deterministic_view_edit,
        _apply_deterministic_view_edit: apply_deterministic_view_edit,
        _resolve_deterministic_view_edit_source: resolve_deterministic_view_edit_source,
        _structured_error_payload: structured_error_payload,
        _archive_vibe_run: (archive) =>
          RunArchiveManager.archiveVibeRun(archive as XVibeRunArchiveData),
      },
    });
  }

  async _apply_mutation_plan(xcmd: XCommand) {
    const params =
      _xu.is_plain_object(xcmd?._params) ? xcmd._params : {};
    const app_id =
      read_required_string(params._app_id, "_app_id");
    const env =
      read_required_string(params._env ?? DEFAULT_ENV, "_env");
    const conversation_id =
      read_optional_string(params._conversation_id, "_conversation_id");
    const message_id =
      read_optional_string(params._message_id, "_message_id");
    const action_id =
      read_optional_string(params._action_id, "_action_id");

    const validation =
      validate_mutation_plan_for_execution({
        _plan: params._plan,
        _app_id: app_id,
        _env: env,
      });
    if (!validation._ok) {
      const result =
        mutation_plan_error_result({
        _code: validation._code,
        _message: validation._message,
        ...(validation._details ? { _details: validation._details } : {}),
        });
      await this.persist_mutation_plan_conversation_execution({
        _app_id: app_id,
        _env: env,
        _conversation_id: conversation_id,
        _message_id: message_id,
        _action_id: action_id,
        _plan: params._plan,
        _result: result,
      });
      return result;
    }

    const execution_steps: XVibeMutationPlanExecutionStep[] = [];
    let completed_steps = 0;

    _xlog.log("[xvibe] mutation plan execution started", {
      _step_count: validation._steps.length,
      _app_id: app_id,
      _env: env,
    });

    for (const [index, step] of validation._steps.entries()) {
      const running_step: XVibeMutationPlanExecutionStep = {
        _id: step._id,
        _status: "running",
      };
      execution_steps.push(running_step);
      _xlog.log("[xvibe] mutation plan step", {
        _step_id: step._id,
        _index: index,
        _status: "running",
      });

      try {
        const primitive =
          step._primitive as XVibeMutationPlanPrimitive;
        let result: unknown;
        const existing_completed_result =
          await this.mutation_plan_existing_completed_result(primitive._params);
        if (existing_completed_result) {
          result = existing_completed_result;
        } else {
          const command_context =
            (xcmd as any)?._ctx;
          result = await _x.execute({
            _module: primitive._module,
            _op: primitive._op,
            _params: primitive._params,
            ...(command_context ? { _ctx: command_context } : {}),
          } as any);
        }

        if (_xu.is_plain_object(result) && result._ok === false) {
          const error =
            mutation_plan_step_error(result);
          running_step._status = "failed";
          running_step._result = result;
          running_step._error = error;
          _xlog.log("[xvibe] mutation plan step", {
            _step_id: step._id,
            _index: index,
            _status: "failed",
          });
          _xlog.log("[xvibe] mutation plan execution completed", {
            _completed_steps: completed_steps,
            _failed_steps: 1,
            _status: "failed",
          });
          const terminal_result: XVibeJsonObject = {
            _ok: false,
            _status: "failed",
            _completed_steps: completed_steps,
            _failed_steps: 1,
            _failed_step_id: step._id,
            _error: error,
            _steps: execution_steps,
          };
          await this.persist_mutation_plan_conversation_execution({
            _app_id: app_id,
            _env: env,
            _conversation_id: conversation_id,
            _message_id: message_id,
            _action_id: action_id,
            _plan: validation._plan,
            _result: terminal_result,
          });
          return terminal_result;
        }

        running_step._status = "done";
        running_step._result = result;
        completed_steps += 1;
        _xlog.log("[xvibe] mutation plan step", {
          _step_id: step._id,
          _index: index,
          _status: "done",
        });
      } catch (error) {
        const step_error =
          mutation_plan_step_error(error);
        running_step._status = "failed";
        running_step._error = step_error;
        _xlog.log("[xvibe] mutation plan step", {
          _step_id: step._id,
          _index: index,
          _status: "failed",
        });
        _xlog.log("[xvibe] mutation plan execution completed", {
          _completed_steps: completed_steps,
          _failed_steps: 1,
          _status: "failed",
        });
        const result: XVibeJsonObject = {
          _ok: false,
          _status: "failed",
          _completed_steps: completed_steps,
          _failed_steps: 1,
          _failed_step_id: step._id,
          _error: step_error,
          _steps: execution_steps,
        };
        await this.persist_mutation_plan_conversation_execution({
          _app_id: app_id,
          _env: env,
          _conversation_id: conversation_id,
          _message_id: message_id,
          _action_id: action_id,
          _plan: validation._plan,
          _result: result,
        });
        return result;
      }
    }

    _xlog.log("[xvibe] mutation plan execution completed", {
      _completed_steps: completed_steps,
      _failed_steps: 0,
      _status: "done",
    });

    const result: XVibeJsonObject = {
      _ok: true,
      _status: "done",
      _completed_steps: completed_steps,
      _failed_steps: 0,
      _steps: execution_steps,
    };
    await this.persist_mutation_plan_conversation_execution({
      _app_id: app_id,
      _env: env,
      _conversation_id: conversation_id,
      _message_id: message_id,
      _action_id: action_id,
      _plan: validation._plan,
      _result: result,
    });
    return result;
  }

  private mutation_plan_execution_artifact_result(input: {
    _result: XVibeJsonObject;
    _completed_at: string;
  }): XVibeJsonObject {
    const result =
      clone_json(input._result) as XVibeJsonObject;
    const steps =
      Array.isArray(result._steps)
        ? result._steps
        : [];
    const status =
      result._status === "done" && result._ok === true
        ? "done"
        : "failed";
    const completed_steps =
      typeof result._completed_steps === "number" && Number.isFinite(result._completed_steps)
        ? result._completed_steps
        : steps.filter((step) =>
          _xu.is_plain_object(step) && step._status === "done").length;
    const failed_steps =
      typeof result._failed_steps === "number" && Number.isFinite(result._failed_steps)
        ? result._failed_steps
        : steps.filter((step) =>
          _xu.is_plain_object(step) && step._status === "failed").length;

    return {
      ...result,
      _status: status,
      _completed_steps: completed_steps,
      _failed_steps: failed_steps,
      _completed_at: input._completed_at,
    };
  }

  private mutation_plan_execution_error_payload(
    result: XVibeJsonObject,
  ): unknown {
    if (result._status !== "failed" && result._ok !== false) return undefined;
    if (result._error !== undefined) return result._error;
    return {
      _code: "E_XVIBE_MUTATION_PLAN_FAILED",
      _message: "Mutation plan failed.",
    };
  }

  private async persist_mutation_plan_conversation_execution(input: {
    _app_id: string;
    _env: string;
    _conversation_id?: string;
    _message_id?: string;
    _action_id?: string;
    _plan: unknown;
    _result: XVibeJsonObject;
  }): Promise<void> {
    if (!input._conversation_id || !input._message_id) return;

    const completed_at =
      new Date().toISOString();
    const artifact_result =
      this.mutation_plan_execution_artifact_result({
        _result: input._result,
        _completed_at: completed_at,
      });
    const status =
      artifact_result._status === "done" ? "done" : "failed";
    const artifact_error =
      this.mutation_plan_execution_error_payload(artifact_result);
    const artifact_params: XVibeJsonObject = {
      _app_id: input._app_id,
      _env: input._env,
      _conversation_id: input._conversation_id,
      _message_id: input._message_id,
      _artifact_type: "mutation-plan",
      _artifact_status: status,
      _artifact_result: artifact_result,
      ...(artifact_error !== undefined ? { _artifact_error: artifact_error } : {}),
      ...(_xu.is_plain_object(input._plan)
        ? { _artifact_request: input._plan }
        : {}),
    };
    const artifact_update =
      await ConversationManager.updateConversationArtifact({
        _params: artifact_params,
      } as any);
    if (!_xu.is_plain_object(artifact_update) || artifact_update._ok !== true) {
      _xlog.warn("[xvibe] mutation plan conversation artifact persistence skipped", {
        _app_id: input._app_id,
        _env: input._env,
        _conversation_id: input._conversation_id,
        _message_id: input._message_id,
        _status: status,
        _error:
          _xu.is_plain_object(artifact_update) && _xu.is_plain_object(artifact_update._error)
            ? artifact_update._error
            : artifact_update,
      });
      return;
    }

    if (!input._action_id) return;
    const action_update =
      await ConversationManager.updateConversationAction({
        _params: {
          _app_id: input._app_id,
          _env: input._env,
          _conversation_id: input._conversation_id,
          _message_id: input._message_id,
          _action_id: input._action_id,
          _status: status,
          _result: artifact_result,
          ...(artifact_error !== undefined ? { _error: JSON.stringify(artifact_error) } : {}),
          _metadata: {
            _source: "xvibe.apply-mutation-plan",
            _artifact_type: "mutation-plan",
            _completed_at: completed_at,
          },
        },
      } as any);
    if (!_xu.is_plain_object(action_update) || action_update._ok !== true) {
      _xlog.warn("[xvibe] mutation plan conversation action persistence skipped", {
        _app_id: input._app_id,
        _env: input._env,
        _conversation_id: input._conversation_id,
        _message_id: input._message_id,
        _action_id: input._action_id,
        _status: status,
        _error:
          _xu.is_plain_object(action_update) && _xu.is_plain_object(action_update._error)
            ? action_update._error
            : action_update,
      });
    }
  }

  private async mutation_plan_existing_completed_result(
    params: XVibeJsonObject,
  ): Promise<XVibeJsonObject | undefined> {
    try {
      const app_id =
        read_required_string(params._app_id, "_app_id");
      const env =
        read_required_string(params._env ?? DEFAULT_ENV, "_env");
      const view_id =
        read_required_string(params._view_id, "_view_id");
      const current_view =
        await this.load_current_view_for_refine({
          _app_id: app_id,
          _env: env,
          _view_id: view_id,
        });
      return (
        mutation_plan_existing_stable_child_result({
          _view: current_view,
          _params: params,
        }) ??
        mutation_plan_existing_completed_move_result({
          _view: current_view,
          _params: params,
        }) ??
        mutation_plan_existing_completed_bind_flow_result({
          _view: current_view,
          _params: params,
        }) ??
        mutation_plan_existing_completed_property_result({
          _view: current_view,
          _params: params,
        })
      );
    } catch {
      return undefined;
    }
  }

  private async fix_project_views_internal(input: {
    _app_id: string;
    _env: string;
    _dry_run: boolean;
  }): Promise<XVibeProjectViewFixReport> {
    const list_response = await _x.execute({
      _module: "server-xvm",
      _op: "list_views",
      _params: {
        _app_id: input._app_id,
        _env: input._env,
      },
    } as any);
    if (_xu.is_plain_object(list_response) && list_response._ok === false) {
      throw new Error("server-xvm.list_views failed");
    }

    const view_ids =
      extract_project_view_list_ids(list_response);
    const report: XVibeProjectViewFixReport = {
      _app_id: input._app_id,
      _env: input._env,
      _dry_run: input._dry_run,
      _views_scanned: 0,
      _views_updated: 0,
      _objects_scanned: 0,
      _ids_added: 0,
      _collisions_resolved: 0,
      _views: [],
    };

    for (const view_id of view_ids) {
      const view_response = await _x.execute({
        _module: "server-xvm",
        _op: "get_view",
        _params: {
          _app_id: input._app_id,
          _env: input._env,
          _view_id: view_id,
        },
      } as any);
      if (_xu.is_plain_object(view_response) && view_response._ok === false) {
        throw new Error(`server-xvm.get_view failed: ${view_id}`);
      }

      const current_view =
        extract_project_view_from_response(view_response);
      if (!current_view) {
        throw new Error(`server-xvm.get_view returned no view: ${view_id}`);
      }

      const next_view =
        clone_deterministic_view_json(current_view) as XVibeJsonObject;
      const view_report =
        fix_project_view_ids_for_view({
          _view_id: view_id,
          _view: next_view,
        });

      report._views_scanned += 1;
      report._objects_scanned += view_report._objects_scanned;
      report._ids_added += view_report._ids_added;
      report._collisions_resolved += view_report._collisions_resolved;
      report._views.push(view_report);

      if (view_report._updated && !input._dry_run) {
        await _x.execute({
          _module: "server-xvm",
          _op: "push_update",
          _params: {
            _app_id: input._app_id,
            _env: input._env,
            _view: next_view,
          },
        } as any);
        report._views_updated += 1;
      }
    }

    return report;
  }

  async _fix_project_views(xcmd: XCommand) {
    try {
      const params = _xu.ensure_params(xcmd?._params);
      const app_id = _xu.ensure_string(params._app_id, "_app_id");
      const env =
        read_optional_string(params._env, "_env") ?? DEFAULT_ENV;

      const report =
        await this.fix_project_views_internal({
          _app_id: app_id,
          _env: env,
          _dry_run: false,
        });

      _xlog.log("[xvibe] project views fixed", {
        _app_id: app_id,
        _env: env,
        _views_scanned: report._views_scanned,
        _views_updated: report._views_updated,
        _objects_scanned: report._objects_scanned,
        _ids_added: report._ids_added,
        _collisions_resolved: report._collisions_resolved,
      });

      return {
        _ok: true,
        _result: report,
        ...report,
      };
    } catch (error) {
      const structured = structured_error_payload(error);
      if (structured) return structured;

      return explicit_error(
        "E_XVIBE_FIX_PROJECT_VIEWS_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async _analyze_project_views(xcmd: XCommand) {
    try {
      const params = _xu.ensure_params(xcmd?._params);
      const app_id = _xu.ensure_string(params._app_id, "_app_id");
      const env =
        read_optional_string(params._env, "_env") ?? DEFAULT_ENV;

      const report =
        await this.fix_project_views_internal({
          _app_id: app_id,
          _env: env,
          _dry_run: true,
        });

      return {
        _ok: true,
        _result: report,
        ...report,
      };
    } catch (error) {
      const structured = structured_error_payload(error);
      if (structured) return structured;

      return explicit_error(
        "E_XVIBE_ANALYZE_PROJECT_VIEWS_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async _append_flow_success_command(xcmd: XCommand) {
    try {
      const params = _xu.ensure_params(xcmd?._params);
      const app_id =
        read_required_string(params._app_id, "_app_id");
      const env =
        read_required_string(params._env ?? DEFAULT_ENV, "_env");
      const flow_id =
        read_required_string(params._flow_id, "_flow_id");
      if (!_xu.is_plain_object(params._command)) {
        return explicit_error(
          "E_XVIBE_FLOW_SUCCESS_COMMAND_INVALID",
          "Invalid '_command': expected a command object.",
        );
      }
      const command = params._command as XVibeJsonObject;

      if (!server_xvm_has_op("get_flow") || !server_xvm_has_op("set_flow")) {
        return explicit_error(
          "E_VIBE_AI_SERVER_XVM_OP_MISSING",
          "server-xvm flow persistence ops are not available",
        );
      }

      let flow_response: any;
      try {
        flow_response = await _x.execute({
          _module: "server-xvm",
          _op: "get_flow",
          _params: {
            _app_id: app_id,
            _env: env,
            _flow_id: flow_id,
          },
        } as any);
      } catch (error) {
        return explicit_error(
          "E_XVIBE_FLOW_NOT_FOUND",
          `Flow not found: ${flow_id}`,
          { _error: error instanceof Error ? error.message : String(error) },
        );
      }

      const flow =
        _xu.is_plain_object(flow_response?._result) &&
        _xu.is_plain_object(flow_response._result._flow)
          ? clone_json(flow_response._result._flow as XVibeJsonObject)
          : null;
      if (!flow) {
        return explicit_error(
          "E_XVIBE_FLOW_NOT_FOUND",
          `Flow not found: ${flow_id}`,
        );
      }

      const success_handler =
        append_flow_success_command_value({
          _existing: flow._on_success,
          _command: command,
        });
      if (!success_handler._changed) {
        return {
          _ok: true,
          _artifact_type: "flow",
          _operation: "append-on-success-command",
          _flow_id: flow_id,
          _changed: false,
          _already_exists: true,
        };
      }

      flow._on_success = success_handler._value;
      const persist_response = await _x.execute({
        _module: "server-xvm",
        _op: "set_flow",
        _params: {
          _app_id: app_id,
          _env: env,
          _flow: flow,
        },
      } as any);
      if (!persist_response?._ok) {
        return explicit_error(
          "E_XVIBE_SERVER_XVM_ERROR",
          "Failed to persist flow success handler.",
          { _error: persist_response?._result ?? persist_response?._error },
        );
      }

      _xem.fire("vibe:flow-updated", {
        _app_id: app_id,
        _env: env,
        _flow_id: flow_id,
      });

      return {
        _ok: true,
        _artifact_type: "flow",
        _operation: "append-on-success-command",
        _flow_id: flow_id,
        _changed: true,
      };
    } catch (error) {
      const structured = structured_error_payload(error);
      if (structured) return structured;

      return explicit_error(
        "E_XVIBE_FLOW_SUCCESS_COMMAND_FAILED",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  async _apply_artifact_request(xcmd: XCommand) {
    return this.artifact_executor.apply(xcmd);
  }

  async _execute_execution_graph(xcmd: XCommand) {
    const result = await this.execution_graph_executor.apply(xcmd);
    const params = _xu.is_plain_object(xcmd?._params) ? xcmd._params : {};
    if (params._graph_type === "crud") {
      await this.record_crud_milestone_completion({
        _app_id:
          typeof params._app_id === "string" && params._app_id.trim().length > 0
            ? params._app_id.trim()
            : "",
        _env:
          typeof params._env === "string" && params._env.trim().length > 0
            ? params._env.trim()
            : DEFAULT_ENV,
        _entity_name:
          typeof params._entity_name === "string"
            ? params._entity_name
            : "",
        _result: result,
      });
    }

    return result;
  }

  async _generate(xcmd: XCommand) {
    return this.generation_manager.generate(xcmd);
  }

  async _generate_view(xcmd: XCommand) {
    return this.generation_manager.generateView(xcmd);
  }

  async _get_latest_run(xcmd: XCommand) {
    return this.generation_manager.getLatestRun(xcmd);
  }

  async _plan_app(xcmd: XCommand): Promise<XVibePlanAppResult> {
    return this.generation_manager.planApp(xcmd) as Promise<XVibePlanAppResult>;
  }

  async _generate_module_spec(xcmd: XCommand): Promise<XVibeGenerateModuleSpecResult> {
    return this.generation_manager.generateModuleSpec(xcmd) as Promise<XVibeGenerateModuleSpecResult>;
  }

  async _get_guide_recommendation(xcmd: XCommand) {
    try {
      const params = _xu.ensure_params(xcmd?._params);
      const recommendation =
        await this.getGuideRecommendation({
          _app_id: _xu.ensure_string(params._app_id, "_app_id"),
          _env:
            typeof params._env === "string" && params._env.trim().length > 0
              ? params._env.trim()
              : DEFAULT_ENV,
          ...(_xu.is_plain_object(params._project_memory)
            ? { _project_memory: params._project_memory as Partial<XVibeProjectMemory> }
            : {}),
          ...(_xu.is_plain_object(params._runtime_assets)
            ? { _runtime_assets: params._runtime_assets as Partial<XVibeRuntimeAssets> }
            : {}),
        });

      return {
        _ok: true,
        _result: {
          _recommendation: recommendation,
        },
        _recommendation: recommendation,
      };
    } catch (error) {
      const structured = structured_error_payload(error);
      if (structured) {
        _xlog.error("[xvibe] guide recommendation failed", error);
        return structured;
      }

      const message = error instanceof Error ? error.message : String(error);
      _xlog.error("[xvibe] guide recommendation failed", error);
      return explicit_error("E_XVIBE_GUIDE_RECOMMENDATION_FAILED", message);
    }
  }

  async _create_app_from_starter(xcmd: XCommand) {
    const params = _xu.is_plain_object(xcmd?._params) ? xcmd._params : {};
    if(params._debug) {
      _xlog.log("[xvibe] create_app_from_starter params", params);
    }

    try {
      const starter_id =
        read_safe_path_segment(params._starter_id, "_starter_id", XVIBE_INVALID_STARTER_ID);
      const app_id =
        normalize_safe_app_id(params._app_id);
      const env =
        read_safe_path_segment(params._env ?? DEFAULT_ENV, "_env", XVIBE_INVALID_ENV);
      const vision =
        optional_trimmed_string(params._vision);

      _xlog.log("[xvibe] create app from starter requested", {
        _starter_id: starter_id,
        _app_id: app_id,
        _env: env,
      });

      const starter_dir = this.resolve_starter_source_dir(starter_id);
      if (
        !fs.existsSync(starter_dir) ||
        !fs.statSync(starter_dir).isDirectory()
      ) {
        throw_explicit_error(XVIBE_STARTER_NOT_FOUND, `Starter not found: ${starter_id}`, {
          _starter_id: starter_id,
        });
      }

      const target_dir = resolve_target_app_dir(env, app_id);
      const public_app_dir = resolve_target_public_app_dir(app_id);
      if (fs.existsSync(target_dir)) {
        throw_explicit_error(XVIBE_APP_ALREADY_EXISTS, `Target app already exists: ${app_id}`, {
          _app_id: app_id,
          _env: env,
        });
      }
      if (fs.existsSync(public_app_dir)) {
        throw_explicit_error(XVIBE_APP_ALREADY_EXISTS, `Target app public folder already exists: ${app_id}`, {
          _app_id: app_id,
          _env: env,
          _path: public_app_dir,
        });
      }

      try {
        copy_starter_runtime_files(starter_dir, target_dir);
        copy_starter_public_files(starter_dir, public_app_dir, app_id);
        rewrite_json_files_in_dir(target_dir, app_id);
      } catch (error) {
        const structured = structured_error_payload(error);
        const structured_error =
          _xu.is_plain_object(structured?._error)
            ? structured?._error
            : undefined;
        const structured_details =
          _xu.is_plain_object(structured_error)
            ? structured_error._details
            : undefined;
        const failure_details =
          _xu.is_plain_object(structured_details)
            ? structured_details
            : undefined;
        _xlog.error("[xvibe] starter copy/rewrite failed", {
          _starter_id: starter_id,
          _app_id: app_id,
          _env: env,
          _target_dir: target_dir,
          _public_app_dir: public_app_dir,
          ...(failure_details ? { _failed_path: failure_details._path } : {}),
          ...(failure_details ? { _failed_target_path: failure_details._target_path } : {}),
          _error: error instanceof Error ? error.message : String(error),
        });

        try {
          fs.rmSync(target_dir, { recursive: true, force: true });
          fs.rmSync(public_app_dir, { recursive: true, force: true });
        } catch {
          // Best effort cleanup of a failed deterministic starter copy.
        }

        throw_explicit_error(XVIBE_STARTER_COPY_FAILED, "Failed to copy starter app", {
          _starter_id: starter_id,
          _app_id: app_id,
          _env: env,
          _target_dir: target_dir,
          _public_app_dir: public_app_dir,
          ...(failure_details ? { _failed_path: failure_details._path } : {}),
          ...(failure_details ? { _failed_target_path: failure_details._target_path } : {}),
          _error: error instanceof Error ? error.message : String(error),
        });
      }

      _xlog.log("[xvibe] starter copied", {
        _starter_id: starter_id,
        _app_id: app_id,
        _env: env,
        _target_dir: target_dir,
        _public_app_dir: public_app_dir,
      });

      const app_file_path = path.join(target_dir, "app.json");
      if (!fs.existsSync(app_file_path)) {
        throw_explicit_error(XVIBE_STARTER_COPY_FAILED, "Starter app.json is missing", {
          _starter_id: starter_id,
        });
      }

      const now = _xu.to_iso_now();
      const starter_app = read_json_object_file(
        app_file_path,
        XVIBE_STARTER_COPY_FAILED,
        "Starter app.json is invalid",
      );
      const starter_meta =
        _xu.is_plain_object(starter_app._meta)
          ? starter_app._meta
          : {};
      const meta: XVibeJsonObject = {
        ...starter_meta,
        _starter_id: starter_id,
        ...(vision ? { _vision: vision } : {}),
        _created_at:
          typeof starter_meta._created_at === "string" && starter_meta._created_at.trim()
            ? starter_meta._created_at
            : now,
        _updated_at: now,
        _entry_view_id:
          typeof starter_meta._entry_view_id === "string" && starter_meta._entry_view_id.trim()
            ? starter_meta._entry_view_id
            : "main",
      };

      const app_file: XVibeJsonObject = {
        ...starter_app,
        _app_id: app_id,
        _env: env,
        _system: false,
        _meta: meta,
        _config:
          _xu.is_plain_object(starter_app._config)
            ? starter_app._config
            : {},
      };

      write_json_object_file(app_file_path, app_file);

      let load_response: any;
      try {
        load_response = await _x.execute({
          _module: "server-xvm",
          _op: "load_app_from_disk",
          _params: {
            _app_id: app_id,
            _env: env,
          },
        } as any);
      } catch (error) {
        throw_explicit_error(XVIBE_STARTER_LOAD_FAILED, "Failed to load starter app", {
          _app_id: app_id,
          _env: env,
          _starter_id: starter_id,
          _error: error instanceof Error ? error.message : String(error),
        });
      }

      if (!load_response?._ok) {
        throw_explicit_error(XVIBE_STARTER_LOAD_FAILED, "Failed to load starter app", {
          _app_id: app_id,
          _env: env,
          _starter_id: starter_id,
          _error: load_response?._error ?? load_response?._result ?? load_response,
        });
      }

      _xlog.log("[xvibe] starter app created", {
        _starter_id: starter_id,
        _app_id: app_id,
        _env: env,
      });

      return {
        _ok: true,
        _result: {
          _app_id: app_id,
          _env: env,
          _starter_id: starter_id,
          _entry_view_id: meta._entry_view_id,
          _created: true,
        },
      };
    } catch (error) {
      const structured = structured_error_payload(error);
      if (structured) {
        _xlog.error("[xvibe] create_app_from_starter failed", error);
        return structured;
      }

      const message = error instanceof Error ? error.message : String(error);
      _xlog.error("[xvibe] create_app_from_starter failed", error);
      return explicit_error("E_XVIBE_CREATE_APP_FROM_STARTER_FAILED", message);
    }
  }


  async _create_conversation(xcmd: XCommand) {
    return ConversationManager.createConversation(xcmd);
  }

  async _list_conversations(xcmd: XCommand) {
    return ConversationManager.listConversations(xcmd);
  }

  async _get_conversation(xcmd: XCommand) {
    return ConversationManager.getConversation(xcmd);
  }

  async _append_message(xcmd: XCommand) {
    return ConversationManager.appendMessage(xcmd);
  }

  async _analyze_message(xcmd: XCommand) {
    return IntentConversationBridge.analyze({
      _cmd: xcmd,
      _intent_engine: this.intent_engine,
      _structured_error_payload: structured_error_payload,
    });
  }

  async _confirm_project_plan(xcmd: XCommand) {
    try {
      const params = _xu.is_plain_object(xcmd?._params) ? xcmd._params : {};
      const app_id = normalize_safe_app_id(params._app_id);
      const env = read_safe_path_segment(params._env ?? DEFAULT_ENV, "_env", XVIBE_INVALID_ENV);
      const conversation_id =
        read_safe_path_segment(
          params._conversation_id,
          "_conversation_id",
          XVIBE_INVALID_CONVERSATION_ID,
        );
      const message_id = read_optional_string(params._message_id, "_message_id");
      _xlog.log("[xvibe] confirm project plan requested", {
        _app_id: app_id,
        _env: env,
        _conversation_id: conversation_id,
        ...(message_id ? { _message_id: message_id } : {}),
      });

      const stored_draft = ConversationManager.readPlanningDraft({
        _app_id: app_id,
        _env: env,
        _conversation_id: conversation_id,
      });
      const fallback_draft = read_confirm_project_plan_fallback(params);
      const draft = stored_draft ?? fallback_draft;
      if (!draft) {
        return explicit_error(
          PLANNING_DRAFT_NOT_FOUND,
          "Current conversation planning draft was not found.",
          {
            _app_id: app_id,
            _env: env,
            _conversation_id: conversation_id,
            _fallback_provided: fallback_draft !== undefined,
          },
        );
      }

      const validation = validate_project_plan_draft(draft);
      if (!validation._ok) {
        return explicit_error(
          PLANNING_INCOMPLETE,
          "Project plan draft is not ready for confirmation.",
          {
            _errors: validation._errors,
            _source: stored_draft ? "conversation-draft" : "fallback-payload",
          },
        );
      }

      const patch = project_plan_memory_patch({
        _draft: validation._draft,
        _questions: validation._questions,
      });
      const patch_result = await _x.execute({
        _module: "server-xvm",
        _op: "patch-project-memory",
        _params: {
          _app_id: app_id,
          _env: env,
          _patch: patch,
        },
      });
      if (!_xu.is_plain_object(patch_result) || patch_result._ok !== true) {
        return explicit_error(
          PROJECT_MEMORY_PATCH_FAILED,
          "Project Memory patch failed.",
          {
            _result: patch_result,
          },
        );
      }

      if (stored_draft) {
        ConversationManager.clearPlanningDraft({
          _app_id: app_id,
          _env: env,
          _conversation_id: conversation_id,
        });
      }

      const memory = extract_project_memory(patch_result);
      _xlog.log("[xvibe] project plan confirmed", {
        _app_id: app_id,
        _env: env,
        _conversation_id: conversation_id,
      });

      return {
        _ok: true,
        _result: {
          _app_id: app_id,
          _env: env,
          _conversation_id: conversation_id,
          _confirmed: true,
          _memory: memory,
        },
      };
    } catch (error) {
      const structured =
        structured_error_payload(error) ??
        ConversationManager.errorPayload(error);
      if (structured) return structured;

      const message = error instanceof Error ? error.message : String(error);
      _xlog.error("[xvibe] confirm_project_plan failed", error);
      return explicit_error(PROJECT_MEMORY_PATCH_FAILED, message);
    }
  }

  async _update_conversation_action(xcmd: XCommand) {
    return ConversationManager.updateConversationAction(xcmd);
  }

  async _update_conversation_artifact(xcmd: XCommand) {
    return ConversationManager.updateConversationArtifact(xcmd);
  }

  async _get_last_messages(xcmd: XCommand) {
    return ConversationManager.getLastMessages(xcmd);
  }


  private async bootstrap_scaffold_app(params: XVibeJsonObject) {
    const app_id = read_optional_string(params._app_id, "_app_id") ?? "generated-app";
    const env = read_optional_string(params._env, "_env") ?? DEFAULT_ENV;
    const entry_view_id = read_optional_string(params._entry_view_id, "_entry_view_id") ?? "main";
    const app_name = read_optional_string(params._name, "_name") ?? "Generated App";
    const root_type = read_optional_string(params._root_type, "_root_type")
      ?? read_optional_string(params._scaffold_root_type, "_scaffold_root_type")
      ?? DEFAULT_SCAFFOLD_ROOT_TYPE;

    await _x.execute({
      _module: "server-xvm",
      _op: "create_app",
      _params: {
        _app_id: app_id,
        _env: env,
        _entry_view_id: entry_view_id,
        _name: app_name
      }
    });

    await _x.execute({
      _module: "server-xvm",
      _op: "push_update",
      _params: {
        _app_id: app_id,
        _env: env,
        _view_id: entry_view_id,
        _view: {
          _id: entry_view_id,
          _type: root_type,
          _children: [
            {
              _type: "label",
              _text: "Hello from generated app"
            }
          ]
        }
      }
    });

    return {
      _app_id: app_id,
      _env: env,
      _entry_view_id: entry_view_id,
      _root_type: root_type,
    };
  }

  private build_live_shell_view(
    app_id: string,
    env: string,
    entry_view_id: string,
  ): XVibeViewArtifact {
    const runtime_mode =
      app_id === "vibe-system"
        ? "system"
        : "runtime";
    const runtime_skills = this.get_runtime_skills(app_id, env, runtime_mode);
    const runtime_registry = collect_runtime_registry(runtime_skills);
    const supports_shell_objects =
      runtime_registry._xui_types.has("xsection") &&
      runtime_registry._xui_types.has("style-sheet");

    if (!supports_shell_objects) {
      return {
        _id: entry_view_id,
        _type: "view",
        _children: [
          {
            _type: "label",
            _id: "vibe-build-status",
            _text: "XVibe is creating your application."
          }
        ]
      };
    }

    return {
      _id: entry_view_id,
      _type: "view",
      _children: [
        {
          _type: "style-sheet",
          _id: "vibe-build-style"
        },
        {
          _type: "xsection",
          _id: "vibe-build-section",
          _title: "Building your app...",
          _children: [
            {
              _type: "label",
              _id: "vibe-build-status",
              _text: "XVibe is creating your application."
            }
          ]
        }
      ]
    };
  }

  async _generate_app(cmd: XCommand) {
    return this.generation_manager.generateApp(cmd);
  }

  async _sync_skills(xcmd: XCommand) {
    return this.generation_manager.syncSkills(xcmd);
  }


}
