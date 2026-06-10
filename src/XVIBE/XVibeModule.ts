import fs from "node:fs";
import path from "node:path";
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
} from "./XVibeTypes.js";
import {
  XVibePlanner,
  type XVibeAppPlan,
  type XVibeArtifactExecutionItem,
  type XVibeArtifactPlanType,
} from "./XVibePlanner.js";
import {
  extract_explicit_module_id_from_prompt,
  extract_module_operation_matches_from_prompt,
  VibeIntentPlanner,
  type VibeIntentPlan,
} from "./VibeIntentPlanner.js";
import {
  VibeBehaviorPlanner,
  type VibeBehaviorIntent,
} from "./VibeBehaviorPlanner.js";

type VibeAIMode = "full" | "refine";
const DEFAULT_ENV = "default";
const DEFAULT_VIEW_ID = "view-main";
const DEFAULT_SCAFFOLD_ROOT_TYPE = "view";
const MAX_VALIDATION_ERRORS = 50;
const MAX_REPAIR_ERRORS = 20;
const GENERATED_MODULE_IMPLEMENTATION_MAX_ATTEMPTS = 3;
const XVIBE_ARTIFACT_ACTION_NOT_SUPPORTED = "E_XVIBE_ARTIFACT_ACTION_NOT_SUPPORTED";
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

type XVibeRunArchiveTimelineItem = {
  _stage: string;
  _message?: string;
  _t_ms: number;
  _at: string;
  _details?: Record<string, unknown>;
};

type XVibeRunArchiveData = {
  _generation_id?: string;
  _app_id?: string;
  _env?: string;
  _view_id?: string;
  _mode?: VibeAIMode;
  _artifact_type?: string;
  _created_at?: string;
  _user_prompt?: string;
  _final_prompt?: string;
  _intent_plan?: unknown;
  _behavior_intent?: unknown;
  _selected_skill_ids?: string[];
  _selected_skills?: unknown;
  _runtime_context?: unknown;
  _ai_output?: unknown;
  _validation?: XVibeRunValidationArchive | XVibeJsonObject;
  _result?: XVibeJsonObject;
  _duration_ms?: number;
  _timeline?: XVibeRunArchiveTimelineItem[];
};

type XVibeRuntimeRegistry = {
  _xui_types: Set<string>;
  _modules: Set<string>;
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
      is_plain_object(payload._error) && typeof payload._error._message === "string"
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

function is_plain_object(value: unknown): value is XVibeJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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
  if (is_plain_object(value) && typeof value._text === "string" && value._text.trim().length > 0) {
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

  if (!is_plain_object(parsed)) {
    throw new Error("Invalid generated module implementation response: expected object");
  }

  const raw_method_sources =
    is_plain_object(parsed._method_sources)
      ? parsed._method_sources
      : is_plain_object(parsed._methods)
        ? parsed._methods
        : {};
  const raw_helper_sources =
    is_plain_object(parsed._helper_sources)
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
  if (!is_plain_object(value) || typeof value._ok !== "boolean") {
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
  if (!is_plain_object(value)) {
    return undefined;
  }

  if (is_plain_object(value._error) && typeof value._error._code === "string") {
    return value._error._code;
  }

  if (is_plain_object(value._result)) {
    return read_command_error_code(value._result);
  }

  return undefined;
}

function read_command_error_category(
  value: unknown
): XVibeGeneratedModuleImplementationValidationCategory | undefined {
  if (!is_plain_object(value)) {
    return undefined;
  }

  if (
    is_plain_object(value._error) &&
    typeof value._error._category === "string"
  ) {
    return normalize_implementation_validation_category(value._error._category);
  }

  if (is_plain_object(value._result)) {
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
  return error instanceof XVibeStructuredError
    ? error._payload
    : undefined;
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

function error_summary(error: unknown): XVibeJsonObject | string {
  if (error instanceof Error) {
    return {
      _name: error.name,
      _message: error.message,
    };
  }

  return String(error);
}

function safe_archive_segment(value: unknown, fallback: string): string {
  const raw =
    typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : fallback;
  const safe =
    raw.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);

  return safe.length > 0 ? safe : fallback;
}

function safe_short_id(): string {
  return Math.random().toString(36).slice(2, 10);
}

function archive_timestamp(value?: string): string {
  const timestamp =
    value && value.trim()
      ? value
      : new Date().toISOString();

  return timestamp.replace(/[:.]/g, "-");
}

function write_archive_file(file_path: string, content: string): void {
  const temp_path = `${file_path}.${Date.now()}-${safe_short_id()}.tmp`;
  fs.writeFileSync(temp_path, content, "utf-8");
  fs.renameSync(temp_path, file_path);
}

function write_archive_json(file_path: string, value: unknown): void {
  write_archive_file(file_path, `${JSON.stringify(value, null, 2)}\n`);
}

function has_archive_value(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (is_plain_object(value)) return Object.keys(value).length > 0;
  return true;
}

function record_archive_stage(
  archive: XVibeRunArchiveData | undefined,
  started_at: number | undefined,
  stage: string,
  message?: string,
  details?: Record<string, unknown>,
): void {
  try {
    if (!archive || typeof started_at !== "number") return;

    archive._timeline =
      archive._timeline ?? [];
    archive._timeline.push({
      _stage: stage,
      ...(message ? { _message: message } : {}),
      _t_ms: Date.now() - started_at,
      _at: new Date().toISOString(),
      ...(details && Object.keys(details).length > 0
        ? { _details: details }
        : {}),
    });
  } catch (error) {
    _xlog.warn("[xvibe] run archive failed", {
      _error: error_summary(error),
    });
  }
}

function compact_view_summary(view: unknown): XVibeJsonObject | undefined {
  if (!is_plain_object(view)) return undefined;

  return {
    ...(typeof view._id === "string" ? { _id: view._id } : {}),
    ...(typeof view._type === "string" ? { _type: view._type } : {}),
    ...(typeof view._title === "string" ? { _title: view._title } : {}),
    ...(typeof view._label === "string" ? { _label: view._label } : {}),
    _children_count:
      Array.isArray(view._children)
        ? view._children.length
        : 0,
  };
}

function runtime_context_archive_payload(
  runtime_context: unknown,
): unknown {
  if (!is_plain_object(runtime_context)) {
    return runtime_context;
  }

  const current_view =
    runtime_context._current_view;

  return {
    ...runtime_context,
    ...(is_plain_object(current_view)
      ? {
        _current_view_id:
          typeof current_view._id === "string"
            ? current_view._id
            : runtime_context._view_id,
        _current_view_summary:
          compact_view_summary(current_view),
      }
      : {}),
  };
}

function selected_skills_archive_payload(
  selection?: VibeKnowledgeSelection,
): XVibeJsonObject | undefined {
  if (!selection) return undefined;

  return {
    _selected_skill_ids: selection.skill_ids,
    _skills: selection.skills,
    _diagnostics: selection.diagnostics,
  };
}

function extract_persisted_version(value: unknown): number | string | undefined {
  if (!is_plain_object(value)) return undefined;

  if (
    typeof value._version === "number" ||
    typeof value._version === "string"
  ) {
    return value._version;
  }

  if (is_plain_object(value._result)) {
    return extract_persisted_version(value._result);
  }

  return undefined;
}

function archive_result_from_response(
  artifact_type: string,
  response: unknown,
): XVibeJsonObject {
  const result =
    is_plain_object(response) && is_plain_object(response._result)
      ? response._result
      : {};

  return {
    _artifact_type:
      typeof result._artifact_type === "string"
        ? result._artifact_type
        : artifact_type,
    ...(typeof result._artifact_id === "string"
      ? { _artifact_id: result._artifact_id }
      : {}),
    ...(typeof result._view_id === "string"
      ? { _view_id: result._view_id }
      : {}),
    ...(typeof result._flow_id === "string"
      ? { _flow_id: result._flow_id }
      : {}),
    ...(typeof result._entity_id === "string"
      ? { _entity_id: result._entity_id }
      : {}),
    _success: generation_result_is_ok(response),
    ...(is_plain_object(response) && response._ok === false
      ? { _error: response._error ?? response._result ?? response }
      : {}),
  };
}

function resolve_xvibe_work_folder(): string {
  const get_module =
    (_x as unknown as { getModule?: (name: string) => unknown }).getModule;

  if (typeof get_module === "function") {
    const server_xvm =
      get_module.call(_x, "server-xvm");

    if (
      is_plain_object(server_xvm) &&
      typeof server_xvm._work_folder === "string" &&
      server_xvm._work_folder.trim().length > 0
    ) {
      return server_xvm._work_folder;
    }
  }

  return "./work";
}

function archive_vibe_run(data: XVibeRunArchiveData): void {
  try {
    if (
      typeof data._app_id !== "string" ||
      data._app_id.trim().length === 0
    ) {
      return;
    }

    const created_at = data._created_at ?? new Date().toISOString();
    const generation_id =
      data._generation_id && data._generation_id.trim()
        ? data._generation_id.trim()
        : safe_short_id();
    const app_id = data._app_id.trim();
    const env =
      typeof data._env === "string" && data._env.trim()
        ? data._env.trim()
        : DEFAULT_ENV;
    const run_dir =
      path.join(
        resolve_xvibe_work_folder(),
        "xvm",
        "apps",
        safe_archive_segment(env, DEFAULT_ENV),
        safe_archive_segment(app_id, "app"),
        "vibe-runs",
        `${archive_timestamp(created_at)}_${safe_archive_segment(generation_id, "run")}`,
      );

    fs.mkdirSync(run_dir, { recursive: true });

    const request_payload: XVibeJsonObject = {
      _generation_id: generation_id,
      _app_id: app_id,
      _env: env,
      ...(data._view_id ? { _view_id: data._view_id } : {}),
      ...(data._mode ? { _mode: data._mode } : {}),
      ...(data._artifact_type ? { _artifact_type: data._artifact_type } : {}),
      _created_at: created_at,
      ...(data._user_prompt !== undefined ? { _user_prompt: data._user_prompt } : {}),
    };

    write_archive_json(path.join(run_dir, "request.json"), request_payload);

    if (data._user_prompt !== undefined) {
      write_archive_file(path.join(run_dir, "prompt.txt"), data._user_prompt);
    }

    if (data._final_prompt !== undefined) {
      write_archive_file(path.join(run_dir, "final-prompt.txt"), data._final_prompt);
    }

    if (has_archive_value(data._intent_plan)) {
      write_archive_json(path.join(run_dir, "intent-plan.json"), data._intent_plan);
    }

    const selected_skills =
      has_archive_value(data._selected_skills)
        ? data._selected_skills
        : has_archive_value(data._selected_skill_ids)
          ? { _selected_skill_ids: data._selected_skill_ids }
          : undefined;
    if (selected_skills !== undefined) {
      write_archive_json(path.join(run_dir, "selected-skills.json"), selected_skills);
    }

    if (has_archive_value(data._runtime_context)) {
      write_archive_json(
        path.join(run_dir, "runtime-context.json"),
        runtime_context_archive_payload(data._runtime_context),
      );
    }

    if (has_archive_value(data._ai_output)) {
      write_archive_json(path.join(run_dir, "ai-output.json"), data._ai_output);
    }

    if (has_archive_value(data._validation)) {
      write_archive_json(path.join(run_dir, "validation.json"), data._validation);
    }

    if (has_archive_value(data._timeline)) {
      write_archive_json(path.join(run_dir, "timeline.json"), data._timeline);
    }

    if (has_archive_value(data._result)) {
      write_archive_json(path.join(run_dir, "result.json"), data._result);
    }

    write_archive_json(path.join(run_dir, "summary.json"), {
      _generation_id: generation_id,
      _app_id: app_id,
      _env: env,
      ...(data._view_id ? { _view_id: data._view_id } : {}),
      ...(data._artifact_type ? { _artifact_type: data._artifact_type } : {}),
      ...(data._mode ? { _mode: data._mode } : {}),
      _success: data._result?._success === true,
      _selected_skill_ids: data._selected_skill_ids ?? [],
      ...(typeof data._duration_ms === "number" ? { _duration_ms: data._duration_ms } : {}),
      _created_at: created_at,
    });

    _xlog.log("[xvibe] run archived", {
      _app_id: app_id,
      _env: env,
      _generation_id: generation_id,
      _archive_dir: run_dir,
    });
  } catch (error) {
    _xlog.warn("[xvibe] run archive failed", {
      _error: error_summary(error),
    });
  }
}

function generation_artifact_stage_fields(result: unknown): XVibeJsonObject {
  if (!is_plain_object(result) || !is_plain_object(result._result)) {
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

function generation_result_is_ok(result: unknown): boolean {
  return !is_plain_object(result) || result._ok !== false;
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
  return is_plain_object(value) && typeof value._id === "string" && value._id.trim().length > 0
    ? value._id.trim()
    : undefined;
}

function merge_child_object(existing_child: unknown, next_child: unknown): unknown {
  if (!is_plain_object(existing_child) || !is_plain_object(next_child)) {
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

function server_xvm_has_op(op: "set_flow" | "set_entity"): boolean {
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

function explicit_error(code: string, message: string) {
  return {
    _ok: false,
    _error: {
      _code: code,
      _message: message,
    },
  };
}

function parser_diagnostic(error: unknown): XVibeParserDiagnostic | undefined {
  return error instanceof VibeOutputParserError ? error._diagnostic : undefined;
}

function parser_diagnostics(error: unknown): XVibeParserDiagnostic[] | undefined {
  return error instanceof VibeOutputParserError ? error._diagnostics : undefined;
}

function archive_failure_result(
  artifact_type: VibeArtifactType,
  error: unknown,
  requested_view_id?: string,
): XVibeJsonObject {
  const diagnostic = parser_diagnostic(error);
  const diagnostics = parser_diagnostics(error);
  const structured = structured_error_payload(error);

  return {
    _artifact_type: artifact_type,
    ...(requested_view_id ? { _view_id: requested_view_id } : {}),
    _success: false,
    _error: error_summary(error),
    ...(diagnostic ? { _diagnostic: diagnostic } : {}),
    ...(diagnostics ? { _diagnostics: diagnostics } : {}),
    ...(structured ? { _structured_error_payload: structured } : {}),
  };
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

    if (is_plain_object(child)) {
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
      is_plain_object(item)
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
  const existing = is_plain_object(existing_payload) ? existing_payload : {};
  const engine = is_plain_object(engine_payload) ? engine_payload : {};

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
    is_plain_object(runtime_skills) &&
    is_plain_object(runtime_skills._skills)
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
  if (!is_plain_object(skill)) return;

  if (include_identity) {
    add_string(target, skill._id);
    add_string(target, skill._xtype);
    add_string(target, skill._xui_type);
    add_string(target, skill._object_type);
  }

  for (const value of read_string_array_value(skill._xui_objects)) {
    target.add(value);
  }

  if (is_plain_object(skill._exports)) {
    for (const value of read_string_array_value(skill._exports._xui_objects)) {
      target.add(value);
    }
  }
}

function read_runtime_ops(value: unknown): string[] {
  const ops =
    Array.isArray(value)
      ? value
      : is_plain_object(value)
        ? Object.values(value)
        : [];

  return ops
    .map((op) => {
      if (typeof op === "string") return op.trim();
      if (!is_plain_object(op)) return "";
      if (typeof op._name === "string") return op._name.trim();
      if (typeof op._op === "string") return op._op.trim();
      return "";
    })
    .filter((op) => op.length > 0);
}

function skill_marks_generated_module(skill: unknown): boolean {
  if (!is_plain_object(skill)) return false;

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
  if (!skill_marks_generated_module(skill) || !is_plain_object(skill)) return;
  const exports_obj = is_plain_object(skill._exports) ? skill._exports : {};

  if (Array.isArray(exports_obj._modules)) {
    for (const module_item of exports_obj._modules) {
      if (!is_plain_object(module_item)) continue;
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

  if (!is_plain_object(payload)) {
    return target;
  }

  if (Array.isArray(payload._skills)) {
    for (const skill of payload._skills) {
      collect_generated_module_targets_from_skill(target, skill);
    }
  }

  if (Array.isArray(payload._modules)) {
    for (const module_item of payload._modules) {
      if (!is_plain_object(module_item)) continue;

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

  if (!is_plain_object(value)) {
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
  };

  if (!is_plain_object(payload)) {
    return registry;
  }

  if (Array.isArray(payload._skills)) {
    for (const skill of payload._skills) {
      collect_xui_types_from_skill(registry._xui_types, skill, false);
      if (is_plain_object(skill)) {
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
      if (!is_plain_object(module_item)) continue;

      add_string(registry._modules, module_item._id);
      add_string(registry._modules, module_item._name);

      if (Array.isArray(module_item._skills)) {
        for (const skill of module_item._skills) {
          collect_xui_types_from_skill(registry._xui_types, skill, false);
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

  if (!is_plain_object(value)) {
    return calls;
  }

  if (
    value._module === "xvm" &&
    value._op === "call-server" &&
    is_plain_object(value._params) &&
    is_plain_object(value._params._cmd) &&
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

  if (!is_plain_object(node)) {
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
  return node._visible === false || node._hidden === true;
}

function has_non_empty_object(value: unknown): boolean {
  return is_plain_object(value) && Object.keys(value).length > 0;
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
    if (!is_plain_object(child)) return false;
    if (child._type === "style-sheet") return false;
    return non_empty_string(child._type);
  });
}

function has_content_or_non_empty_children(node: XVibeJsonObject): boolean {
  return has_content_value(node) || has_non_empty_object(node._content) || has_typed_children(node);
}

function collect_view_flow_ids(node: unknown, target = new Set<string>()): string[] {
  if (!is_plain_object(node)) return [...target];

  if (is_plain_object(node._flow) && typeof node._flow._id === "string" && node._flow._id.trim().length > 0) {
    target.add(node._flow._id.trim());
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === "_flow") continue;

    if (Array.isArray(value)) {
      for (const item of value) {
        collect_view_flow_ids(item, target);
      }
    } else if (is_plain_object(value)) {
      collect_view_flow_ids(value, target);
    }
  }

  return [...target];
}

function collect_generated_flow_ids(value: unknown): string[] {
  if (!is_plain_object(value) || !Array.isArray(value._flows)) {
    return [];
  }

  const ids = value._flows
    .map((flow) => {
      if (!is_plain_object(flow)) return undefined;
      const id = flow._flow_id ?? flow._artifact_id;
      return typeof id === "string" && id.trim().length > 0
        ? id.trim()
        : undefined;
    })
    .filter((id): id is string => typeof id === "string");

  return Array.from(new Set(ids));
}

function extract_prompt_flow_ids(prompt: string): string[] {
  return extract_named_flow_ids(prompt);
}

function normalize_runtime_asset_ids(value: unknown): XVibeRuntimeAssetRef[] {
  const source =
    Array.isArray(value)
      ? value
      : [];

  return Array.from(
    new Set(
      source
        .map((item) => {
          if (typeof item === "string") return item.trim();
          if (is_plain_object(item) && typeof item._id === "string") {
            return item._id.trim();
          }
          if (is_plain_object(item) && typeof item._name === "string") {
            return item._name.trim();
          }
          return "";
        })
        .filter((id) => id.length > 0)
    )
  )
    .sort()
    .map((id) => ({ _id: id }));
}

function collect_generated_module_asset_ids(runtime_skills: unknown): XVibeRuntimeAssetRef[] {
  const payload = unwrap_runtime_skills_payload(runtime_skills);
  const ids: string[] = [];

  if (!is_plain_object(payload)) {
    return [];
  }

  const collect_module_id = (module_item: unknown): void => {
    if (!is_plain_object(module_item)) return;

    let is_generated = skill_marks_generated_module(module_item);
    if (Array.isArray(module_item._skills)) {
      is_generated =
        is_generated ||
        module_item._skills.some((skill) => skill_marks_generated_module(skill));
    }

    if (!is_generated) return;

    if (typeof module_item._id === "string" && module_item._id.trim()) {
      ids.push(module_item._id.trim());
    } else if (typeof module_item._name === "string" && module_item._name.trim()) {
      ids.push(module_item._name.trim());
    }
  };

  if (Array.isArray(payload._modules)) {
    for (const module_item of payload._modules) {
      collect_module_id(module_item);
    }
  }

  if (Array.isArray(payload._skills)) {
    for (const skill of payload._skills) {
      if (
        !skill_marks_generated_module(skill) ||
        !is_plain_object(skill) ||
        !is_plain_object(skill._exports)
      ) {
        continue;
      }
      const exported_modules = Array.isArray(skill._exports._modules)
        ? skill._exports._modules
        : [];
      for (const module_item of exported_modules) {
        collect_module_id({
          ...(is_plain_object(module_item) ? module_item : {}),
          _skills: [skill],
        });
      }
    }
  }

  return normalize_runtime_asset_ids(ids);
}

function field_control_requires_name(control_type: string): boolean {
  return ![
    "label",
    "static",
    "display",
    "readonly",
  ].includes(control_type);
}

type XVibeRuntimeContextInput = {
  _app_id: string;
  _env: string;
  _view_id?: string;
  _current_view?: unknown;
  _generated_artifacts?: unknown;
  _runtime_skills?: unknown;
};

type XVibeRuntimeAssetRef = {
  _id: string;
};

type XVibeRuntimeAssets = {
  _views: XVibeRuntimeAssetRef[];
  _flows: XVibeRuntimeAssetRef[];
  _entities: XVibeRuntimeAssetRef[];
  _modules: XVibeRuntimeAssetRef[];
};

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
  private readonly runtime_skills_by_scope = new Map<string, any>();
  private latest_runtime_skills: any = null;

  constructor() {
    super({ _name: XVibeModule._name });
    this.selector = new VibeKnowledgeSelector();
    this.prompt_builder = new VibePromptBuilder();
    this.view_builder = new VibeViewBuilder();
    this.output_parser = new VibeOutputParser();
    this.planner = new XVibePlanner();
    this.intent_planner = new VibeIntentPlanner();
    this.behavior_planner = new VibeBehaviorPlanner();
  }

  override async onLoad() {
    _xlog.log("XVibe initialized ✅");
  }


  private runtime_skill_scope(
    app_id: unknown,
    env: unknown,
    mode: unknown,
  ): string {
    return [
      typeof env === "string" ? env : "default",
      typeof app_id === "string" ? app_id : "unknown",
      typeof mode === "string" ? mode : "runtime"
    ].join("::");
  }

  get_runtime_skills(
    app_id?: string,
    env?: string,
    mode?: string,
  ) {

    // v1 global fallback
    if (
      app_id == null &&
      env == null &&
      mode == null
    ) {
      return this.latest_runtime_skills;
    }

    const scope =
      this.runtime_skill_scope(
        app_id,
        env,
        mode
      );

    return (
      this.runtime_skills_by_scope.get(scope)
      ?? this.latest_runtime_skills
    );
  }

  private refresh_runtime_skills_after_module_creation(
    app_id: string,
    env: string,
    mode: string,
  ): unknown {
    const get_skills =
      (_x as unknown as { getSkills?: () => unknown }).getSkills;

    if (typeof get_skills !== "function") {
      return this.get_runtime_skills(app_id, env, mode);
    }

    const existing =
      this.get_runtime_skills(app_id, env, mode);
    const engine_skills =
      get_skills.call(_x);
    const merged_skills =
      merge_runtime_skill_payloads(existing, engine_skills);
    const scope =
      this.runtime_skill_scope(app_id, env, mode);
    const skills_count =
      Array.isArray(merged_skills._modules)
        ? merged_skills._modules.length
        : 0;
    const snapshot = {
      _app_id: app_id,
      _env: env,
      _mode: mode,
      _skills: merged_skills,
      _skills_count: skills_count,
      _synced_at: new Date().toISOString()
    };

    this.runtime_skills_by_scope.set(scope, snapshot);
    this.latest_runtime_skills = snapshot;

    _xlog.log("[xvibe] runtime skills refreshed after module creation", {
      _scope: scope,
      _app_id: app_id,
      _env: env,
      _mode: mode,
      _skills_count: skills_count,
    });

    return snapshot;
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
        archive && is_plain_object(archive._validation)
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
        is_plain_object(implementation_response) && implementation_response._ok === false
          ? implementation_response
          : unwrap_command_result(
            implementation_response
          );

      if (is_plain_object(implementation_result) && implementation_result._ok === false) {
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
        is_plain_object(create_result) &&
        create_result._ok === true &&
        create_result._saved === true,
      _available:
        is_plain_object(load_result)
          ? load_result._ok === true || load_result._loaded === true
          : true,
    };
  }

  private async execute_module_generation_route(input: {
    app_id: string;
    env: string;
    runtime_mode: string;
    prompt: string;
    supplied_intent_plan: unknown;
    runtime_skills: unknown;
    inferred_artifact_plan: XVibeInferredArtifactPlan;
    generation_id: string;
    _progress?: XVibeGenerationProgressCallback;
  }): Promise<unknown> {
    let intent_plan =
      this.create_artifact_intent_plan({
        prompt: input.prompt,
        artifact_type: "module",
        supplied_intent_plan: input.supplied_intent_plan,
        runtime_skills: input.runtime_skills,
      });

    const module_op_extraction =
      extract_module_operation_matches_from_prompt(input.prompt);
    const explicit_module_ops =
      module_op_extraction._module_ops;
    const explicit_module_name =
      extract_explicit_module_id_from_prompt(input.prompt);
    const planned_module_name =
      explicit_module_name ??
      input.inferred_artifact_plan._module_names?.[0];

    _xlog.log("[xvibe] extracted module ops", {
      _module_name:
        planned_module_name ??
        intent_plan._module_name,
      _positive_matches: module_op_extraction._positive_matches,
      _negative_matches: module_op_extraction._negative_matches,
      _module_ops: explicit_module_ops,
    });
    const planned_module_target =
      intent_plan._module_target === "client"
        ? "client"
        : "server";

    if (
      planned_module_name &&
      (
        typeof intent_plan._module_name !== "string" ||
        intent_plan._module_name.trim().length === 0 ||
        intent_plan._module_name === "generated-module"
      )
    ) {
      intent_plan = {
        ...intent_plan,
        _requires_module: true,
        _module_target: planned_module_target,
        _module_name: planned_module_name,
        _module_ops:
          explicit_module_ops.length > 0
            ? explicit_module_ops
            : intent_plan._module_ops.length > 0
            ? intent_plan._module_ops
            : ["run"],
        _module_reason: "User explicitly requested creation of a server module.",
      };
    }

    if (explicit_module_ops.length > 0) {
      intent_plan = {
        ...intent_plan,
        _requires_module: true,
        _module_target: planned_module_target,
        ...(planned_module_name ? { _module_name: planned_module_name } : {}),
        _module_ops: explicit_module_ops,
        _module_reason:
          intent_plan._module_reason ??
          "User explicitly requested creation of a server module.",
      };
    }

    intent_plan =
      this.intent_planner.enforce_module_intent_plan(intent_plan);

    _xlog.log("[xvibe] module execution route", {
      _module_name: intent_plan._module_name,
      _module_ops: intent_plan._module_ops,
    });
    _xlog.log("[xvibe] module generation bypassed artifact planner");

    const archive_started_at = Date.now();
    const archive_validation: XVibeRunValidationArchive = {
      _implementation_attempts: [],
    };
    const archive: XVibeRunArchiveData = {
      _generation_id: input.generation_id,
      _app_id: input.app_id,
      _env: input.env,
      _mode: "full",
      _artifact_type: "module",
      _created_at: new Date().toISOString(),
      _user_prompt: input.prompt,
      _intent_plan: intent_plan,
      _runtime_context: {
        _runtime_mode: input.runtime_mode,
        _runtime_skills: input.runtime_skills,
        _artifact_plan: input.inferred_artifact_plan,
      },
      _validation: archive_validation,
    };
    const module_progress: XVibeGenerationProgressCallback =
      (stage_name, message, details = {}) => {
        record_archive_stage(
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
      const module_name =
        typeof intent_plan._module_name === "string" && intent_plan._module_name.trim()
          ? intent_plan._module_name.trim()
          : planned_module_name;
      const module_ops = intent_plan._module_ops;
      archive._result = {
        _success: false,
        _artifact_type: "module",
        ...(module_name ? { _module_name: module_name } : {}),
        _module_ops: module_ops,
        _error: error_summary(error),
        _attempts: archive_validation._implementation_attempts ?? [],
      };
      record_archive_stage(
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
      archive_vibe_run(archive);
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

      if (runtime_module_exists(module_name, registry)) {
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

      const module_implement_started_at = Date.now();
      const implementation_result =
        await this.implement_generated_module_from_spec({
          spec,
          user_request: input.prompt,
          current_or_generated_view: input.view,
          server_module_call_graph: view_server_module_calls_to_data(calls),
          _progress: input._progress,
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
            _id: spec._id,
          },
        } as any),
      );

      _xlog.log("[xvibe] module creator result", {
        _module_name: spec._name,
        _create_result: create_result,
        _implementation_result: implementation_result,
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
    record_archive_stage(
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
      structured && is_plain_object(structured._error)
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

  private async collect_runtime_awareness_context(
    _input: XVibeRuntimeContextInput,
  ): Promise<XVibeJsonObject> {
    const runtime_assets =
      await this.collect_runtime_assets({
        _app_id: _input._app_id,
        _env: _input._env,
        _runtime_skills: _input._runtime_skills,
      });

    _xlog.log("[xvibe] runtime asset awareness", {
      _views_count: runtime_assets._views.length,
      _flows_count: runtime_assets._flows.length,
      _entities_count: runtime_assets._entities.length,
      _modules_count: runtime_assets._modules.length,
    });

    return {
      _app_id: _input._app_id,
      _env: _input._env,
      _runtime_assets: runtime_assets,

      ...(_input._view_id
        ? {
          _view_id: _input._view_id
        }
        : {}),

      ...(_input._current_view
        ? {
          _current_view: _input._current_view
        }
        : {}),

      ...(_input._generated_artifacts
        ? {
          _generated_artifacts:
            _input._generated_artifacts
        }
        : {})
    };
  }

  private async collect_runtime_assets(input: {
    _app_id: string;
    _env: string;
    _runtime_skills?: unknown;
  }): Promise<XVibeRuntimeAssets> {
    let views: XVibeRuntimeAssetRef[] = [];
    let flows: XVibeRuntimeAssetRef[] = [];
    let entities: XVibeRuntimeAssetRef[] = [];

    try {
      const app_result = unwrap_command_result(
        await _x.execute({
          _module: "server-xvm",
          _op: "get_app",
          _params: {
            _app_id: input._app_id,
            _env: input._env,
            _include_views: false,
            _include_flows: false,
          },
        } as any),
      );

      if (is_plain_object(app_result)) {
        views = normalize_runtime_asset_ids(app_result._view_ids);
        flows = normalize_runtime_asset_ids(app_result._flow_ids);
        entities = normalize_runtime_asset_ids(app_result._entity_ids);
      }
    } catch (error) {
      _xlog.warn("[xvibe] runtime asset collection failed", {
        _app_id: input._app_id,
        _env: input._env,
        _error: error_summary(error),
      });
    }

    const assets: XVibeRuntimeAssets = {
      _views: views,
      _flows: flows,
      _entities: entities,
      _modules: collect_generated_module_asset_ids(input._runtime_skills),
    };

    return assets;
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

    if (!is_plain_object(current_result) || !is_plain_object(current_result._view)) {
      throw new Error("Invalid server-xvm get_view response");
    }

    _xlog.log("[xvibe] refine current view loaded", {
      _app_id: input._app_id,
      _env: input._env,
      _view_id: input._view_id,
    });

    return current_result._view;
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

    if (!is_plain_object(current_view)) {
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
    const has_current_view = is_plain_object(current_view);
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
      is_plain_object(view) && typeof view._id === "string" && view._id.trim().length > 0
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

    if (!is_plain_object(value)) {
      return ids;
    }

    if (typeof value._id === "string" && value._id.trim().length > 0) {
      ids.push(value._id);
    }

    for (const child of Object.values(value)) {
      if (is_plain_object(child) || Array.isArray(child)) {
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

    if (!is_plain_object(value)) {
      return undefined;
    }

    if (value._id === target_id) {
      return value;
    }

    for (const child of Object.values(value)) {
      if (is_plain_object(child) || Array.isArray(child)) {
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

    if (is_plain_object(value)) {
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

    if (!is_plain_object(parsed)) {
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
      if (!is_plain_object(op)) {
        throw new Error(`Invalid mutation op at index ${index}: expected object`);
      }

      if (op._op_type !== "update_props") {
        throw new Error(`Invalid mutation op at index ${index}: update_props only`);
      }

      if (typeof op._target_id !== "string" || op._target_id.trim().length === 0) {
        throw new Error(`Invalid mutation op at index ${index}: expected _target_id`);
      }

      const target_id = op._target_id;

      if (!is_plain_object(op._props)) {
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

      if (!is_plain_object(mutation_result)) {
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
    if (!is_plain_object(value)) return false;

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
        (field === "_style" && is_plain_object(field_value) && Object.keys(field_value).length > 0) ||
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

    if (!is_plain_object(handler)) {
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

      if (handler._params !== undefined && !is_plain_object(handler._params)) {
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
    if (!is_plain_object(value)) {
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
    if (!is_plain_object(value)) {
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
  ): void {
    if (!is_plain_object(node)) {
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

    if (Object.prototype.hasOwnProperty.call(node, "_style")) {
      this.push_validation_error(errors, `${path} uses forbidden inline _style`);
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
        this.validate_view_node(child, validation_path(path, `_children[${index}]`), registry, errors)
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

      if (!is_plain_object(node._control)) {
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
    },
  ): void {
    if (registry._xui_types.size === 0) {
      this.push_validation_error(errors, "runtime XUI object registry is empty");
    }

    this.validate_view_node(view, "_view", registry, errors);

    if (prompt_requests_styling(prompt)) {
      const children = Array.isArray(view._children) ? view._children : [];
      const first_child = children[0];
      const first_type =
        is_plain_object(first_child) && typeof first_child._type === "string"
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
    if (!is_plain_object(command)) {
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
    }

    if (command._params !== undefined && !is_plain_object(command._params)) {
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
    if (!is_plain_object(step)) {
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
      if (!is_plain_object(step._input)) {
        this.push_validation_error(errors, `${path}._input must be an object`);
      } else {
        for (const [key, input_def] of Object.entries(step._input)) {
          if (
            !is_plain_object(input_def) ||
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
        !is_plain_object(step._output) ||
        !is_plain_object(step._output._to) ||
        step._output._to._type !== "xdata" ||
        typeof step._output._to._key !== "string" ||
        step._output._to._key.trim().length === 0
      ) {
        this.push_validation_error(errors, `${path}._output must target { "_type": "xdata", "_key": "..." }`);
      }
    }

    if (step._when !== undefined) {
      if (
        !is_plain_object(step._when) ||
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

    if (!is_plain_object(entity._schema)) {
      this.push_validation_error(errors, "_entity._schema must be an object");
      return;
    }

    for (const [field_name, field] of Object.entries(entity._schema)) {
      if (!is_plain_object(field)) {
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
    _generated_artifacts?: unknown;
    _planned_flow_ids?: string[];
  }): XVibeArtifactValidationResult {
    let registry = collect_runtime_registry(input._runtime_skills);
    const errors: string[] = [];

    if (input._artifact_type === "view") {
      if (registry._xui_types.size === 0) {
        _xlog.warn("[xvibe] runtime XUI registry empty; using fallback validation types");
        registry = {
          ...registry,
          _xui_types: new Set(FALLBACK_XUI_VALIDATION_TYPES),
        };
      }

      this.validate_view_artifact(
        input._artifact as XVibeViewArtifact,
        input._prompt,
        registry,
        errors,
        {
          _generated_artifacts: input._generated_artifacts,
          _planned_flow_ids: input._planned_flow_ids,
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
    _generated_artifacts?: unknown;
    _planned_flow_ids?: string[];
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
    _app_id: string;
    _env: string;
    _generation_id?: string;
  }): XVibeArtifactGenerationContext {
    return {
      _plan: input._plan,
      ...(input._intent_plan ? { _intent_plan: input._intent_plan } : {}),
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
    if (!is_plain_object(response) || response._ok !== true) {
      throw new Error(
        `XVibe planned artifact generation failed: ${JSON.stringify(response)}`
      );
    }

    const result = is_plain_object(response._result)
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
      is_plain_object(params._generated_artifacts)
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

          this.broadcast_generation_failed(
            {
              ...input._params,
              _app_id: input._app_id,
              _env: input._env,
              ...(input._generation_id ? { _generation_id: input._generation_id } : {}),
            },
            new XVibeStructuredError(unsupported_result),
            XVIBE_ARTIFACT_ACTION_NOT_SUPPORTED,
          );

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
    let requested_view_id = read_optional_string(params._view_id, "_view_id");
    if (artifact_scope_lock?._artifact_type === "view") {
      if (artifact_scope_lock._target_id) {
        requested_view_id = artifact_scope_lock._target_id;
        params._view_id = requested_view_id;
      }
      if (artifact_scope_lock._action === "update" && requested_view_id) {
        mode = "refine";
      }
      if (artifact_scope_lock._action === "create") {
        mode = "full";
      }

      _xlog.log("[xvibe] artifact scope locked", {
        _artifact_type: artifact_scope_lock._artifact_type,
        _action: artifact_scope_lock._action,
        ...(artifact_scope_lock._target_id ? { _target_id: artifact_scope_lock._target_id } : {}),
        _mode: mode,
        _reason: artifact_scope_lock._reason,
      });
    }
    const capabilities = read_optional_string_array(params._capabilities, "_capabilities");
    const generation_id = read_optional_generation_id(params._generation_id);
    const effective_generation_id = generation_id ?? safe_short_id();
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
    const supplied_intent_plan = is_plain_object(params._intent_plan) ? params._intent_plan : {};
    const base_artifact_plan =
      this.intent_planner.build_artifact_plan_from_intent(
        prompt,
        artifact_intent,
        requested_artifact_type,
      );
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

    inferred_artifact_plan =
      this.apply_artifact_scope_lock_to_plan(
        artifact_scope_lock,
        inferred_artifact_plan,
      );

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
        supplied_intent_plan,
        runtime_skills,
        inferred_artifact_plan,
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

    if (
      !forced_artifact_type &&
      !skip_artifact_plan &&
      inferred_artifact_plan._execution_plan?._artifacts.length
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
      intent_plan =
        this.apply_artifact_scope_lock_to_intent_plan(
          artifact_scope_lock,
          intent_plan,
        );
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
      intent_plan =
        this.apply_artifact_scope_lock_to_intent_plan(
          artifact_scope_lock,
          intent_plan,
        );
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
      const selection = this.selector.select(
        prompt,
        artifact_type,
        capabilities,
        runtime_skills,
        intent_plan
      );

      _xlog.log("[xvibe] selected skills", {
        _artifact_type: artifact_type,
        _skill_ids: selection.skill_ids,
      });
      archive._selected_skill_ids = selection.skill_ids;
      archive._selected_skills = selected_skills_archive_payload(selection);
      stage(
        "skills-selected",
        "Skills selected",
        {
          _skill_ids: selection.skill_ids,
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
      if (mode === "refine" && artifact_type === "view") {
        use_view_mutation =
          this.should_use_view_mutation(prompt, current_view);

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

        ...(is_plain_object(params._generated_artifacts)
          ? { _generated_artifacts: params._generated_artifacts }
          : {}),

        _runtime_skills: runtime_skills,
      });
      runtime_context._behavior_intent = behavior_intent;
      archive._runtime_context = {
        ...runtime_context,
        _selected_modules: intent_plan._modules,
        _selected_objects: intent_plan._objects,
        _selected_xui_objects: intent_plan._xui_objects,
        _selected_entities: intent_plan._entities,
      };

      verbose_log("[xvibe] runtime context", runtime_context);

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
          _selected_skills: selection.skills,
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
        selection,
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

      verbose_log("[xvibe] FINAL PROMPT", { _prompt: final_prompt });

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

      verbose_log("[xvibe] raw ai output", { _result: xai_result });

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
          generation_id: effective_generation_id,
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
        if (is_plain_object(result) && result._ok === false) {
          throw new XVibeStructuredError(result);
        }
        if (!archive._result) {
          archive._result = archive_result_from_response("flow", result);
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
        if (is_plain_object(result) && result._ok === false) {
          throw new XVibeStructuredError(result);
        }
        if (!archive._result) {
          archive._result = archive_result_from_response("entity", result);
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
        archive._result = archive_result_from_response("command", result);
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
      const error_details: Record<string, unknown> = {
        _artifact_type: artifact_type,
        ...(requested_view_id ? { _view_id: requested_view_id } : {}),
        _error: error_summary(error),
        ...(diagnostic ? { _diagnostic: diagnostic } : {}),
        ...(diagnostics ? { _diagnostics: diagnostics } : {}),
      };
      record_archive_stage(
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
        archive_failure_result(
          artifact_type,
          error,
          requested_view_id,
        );
      throw error;
    } finally {
      archive._duration_ms = Date.now() - archive_started_at;
      if (
        is_plain_object(archive._validation) &&
        Object.keys(archive._validation).length === 0
      ) {
        delete archive._validation;
      }
      archive_vibe_run(archive);
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
    generation_id?: string;
    include_artifact_type: boolean;
    archive?: XVibeRunArchiveData;
    archive_started_at?: number;
    progress?: XVibeGenerationProgressCallback;
  }) {
    let view_to_persist: XVibeJsonObject = input.parsed_view;
    let runtime_skills = input.runtime_skills;
    const runtime_mode = input.app_id === "vibe-system" ? "system" : "runtime";

    if (input.mode === "refine") {
      _xlog.log("[xvibe] refine full-view replacement", {
        _app_id: input.app_id,
        _env: input.env,
        _view_id: input.requested_view_id,
      });
      if (input.requested_view_id) {
        view_to_persist._id = input.requested_view_id;
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
        _generated_artifacts: input.generated_artifacts,
        _planned_flow_ids: input.planned_flow_ids,
        _archive_validation:
          input.archive?._validation as XVibeRunValidationArchive | undefined,
        _progress: input.progress,
      }) as XVibeJsonObject;
    if (input.mode === "refine" && input.requested_view_id) {
      view_to_persist._id = input.requested_view_id;
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
      input.archive._result = {
        _artifact_type: "view",
        _artifact_id: view_id,
        _view_id: view_id,
        _success: true,
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
      _result: input.include_artifact_type
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


  async _generate(xcmd: XCommand) {
    const params = is_plain_object(xcmd?._params) ? xcmd._params : {};
    try {
      const result = await this.generate_artifact(params);
      return result;
    } catch (error) {
      this.broadcast_generation_failed(params, error, "E_VIBE_AI_GENERATE");
      const structured = structured_error_payload(error);
      if (structured) {
        _xlog.error("[xvibe] generate failed", error);
        return structured;
      }

      const message = error instanceof Error ? error.message : String(error);
      const diagnostic = parser_diagnostic(error);
      const diagnostics = parser_diagnostics(error);
      _xlog.error("[xvibe] generate failed", error);
      return {
        _ok: false,
        _error: {
          _code: "E_VIBE_AI_GENERATE",
          _message: message,
          ...(diagnostic ? { _diagnostic: diagnostic } : {}),
          ...(diagnostics ? { _diagnostics: diagnostics } : {}),
        },
      };
    }
  }

  async _generate_view(xcmd: XCommand) {
    const params = is_plain_object(xcmd?._params) ? xcmd._params : {};
    try {
      return await this.generate_artifact(params, "view");
    } catch (error) {
      this.broadcast_generation_failed(params, error, "E_VIBE_AI_GENERATE_VIEW");
      const structured = structured_error_payload(error);
      if (structured) {
        _xlog.error("[xvibe] generate_view failed", error);
        return structured;
      }

      const message = error instanceof Error ? error.message : String(error);
      const diagnostic = parser_diagnostic(error);
      const diagnostics = parser_diagnostics(error);
      _xlog.error("[xvibe] generate_view failed", error);
      return {
        _ok: false,
        _error: {
          _code: "E_VIBE_AI_GENERATE_VIEW",
          _message: message,
          ...(diagnostic ? { _diagnostic: diagnostic } : {}),
          ...(diagnostics ? { _diagnostics: diagnostics } : {}),
        },
      };
    }
  }

  async _plan_app(xcmd: XCommand): Promise<XVibePlanAppResult> {
    try {
      const params = is_plain_object(xcmd?._params) ? xcmd._params : {};
      const prompt = resolve_prompt(params);
      const plan = this.planner.plan_app(prompt);

      _xlog.log("[xvibe] app plan created", {
        _app_type: plan._app_type,
        _logic_level: plan._logic_level,
        _artifacts: plan._artifacts,
        ...(plan._flow_ids ? { _flow_ids: plan._flow_ids } : {}),
        _requires_module: plan._requires_module,
      });

      return {
        _ok: true,
        _result: plan,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      _xlog.error("[xvibe] plan_app failed", error);
      return {
        _ok: false,
        _error: {
          _code: "E_VIBE_PLAN_APP",
          _message: message,
        },
      };
    }
  }

  async _generate_module_spec(xcmd: XCommand): Promise<XVibeGenerateModuleSpecResult> {
    const params = xcmd._params ?? {};
    const prompt = String(params._prompt ?? "").trim();

    if (!prompt) {
      return {
        _ok: false,
        _needs_module_creator: true,
        _error: {
          _code: "E_XVIBE_EMPTY_PROMPT",
          _message: "Missing _prompt for module spec generation."
        }
      };
    }

    // v1: use LLM only to produce manifest JSON, not code.
    // module-creator remains responsible for validation/generation/loading.

    const spec: any = {
      _id: String(params._module_id ?? "generated-module"),
      _name: String(params._module_name ?? params._module_id ?? "generated-module"),
      _target: "server" as const,
      _description: `Generated server module from prompt: ${prompt}`,
      _version: "0.1.0",
      _imports: [
        {
          _from: "@xpell/node"
        }
      ],
      _permissions: [],
      _ops: [
        {
          _name: "run",
          _description: "Default generated operation.",
          _params: {
            _input: "Optional input payload."
          }
        }
      ]
    };

    return {
      _ok: true,
      _spec: spec,
      _needs_module_creator: true
    };
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

    const params =
      is_plain_object(cmd?._params)
        ? cmd._params
        : {};

    try {
      const prompt = resolve_prompt(params);
      const app_id =
        read_optional_string(params._app_id, "_app_id") ?? "xvibe-app";
      const env =
        read_optional_string(params._env, "_env") ?? DEFAULT_ENV;
      const generation_id = read_optional_string(params._generation_id, "_generation_id");
      const entry_view_id = "main";

      _xlog.log("[xvibe] generate_app:start", {
        _prompt: prompt,
        _app_id: app_id,
        _env: env,
      });

      await _x.execute({
        _module: "server-xvm",
        _op: "create_app",
        _params: {
          _app_id: app_id,
          _env: env,
          _name: app_id,
          _entry_view_id: entry_view_id,
        }
      });

      this.push_generation_stage(
        app_id,
        env,
        "shell",
        "Creating application...",
        generation_id
      );

      await _x.execute({
        _module: "server-xvm",
        _op: "push_update",
        _params: {
          _app_id: app_id,
          _env: env,
          ...(generation_id ? { _generation_id: generation_id } : {}),
          _view: this.build_live_shell_view(app_id, env, entry_view_id),
        }
      });

      _xlog.log("[xvibe] live shell pushed", {
        _app_id: app_id,
        _env: env,
        _view_id: entry_view_id,
      });

      await _x.execute({
        _module: "server-xvm",
        _op: "set_active_app",
        _params: {
          _app_id: app_id,
          _env: env
        }
      });

      _xlog.log("[xvibe] active app set early", {
        _app_id: app_id,
        _env: env,
      });

      const plan = this.planner.plan_app(prompt);
      _xlog.log("[xvibe] app plan created", {
        _app_type: plan._app_type,
        _logic_level: plan._logic_level,
        _artifacts: plan._artifacts,
        ...(plan._flow_ids ? { _flow_ids: plan._flow_ids } : {}),
        _requires_module: plan._requires_module,
      });

      this.push_generation_stage(
        app_id,
        env,
        "planning",
        "Planning application...",
        generation_id
      );

      let intent_plan = await this.create_intent_plan({
        prompt,
        app_plan: plan,
        app_id,
        env,
      });
      const module_ensure_result =
        await this.ensure_server_module_for_intent({
          app_id,
          env,
          runtime_mode:
            app_id === "vibe-system"
              ? "system"
              : "runtime",
          prompt,
          intent_plan,
        });
      intent_plan = module_ensure_result._intent_plan;

      this.push_generation_stage(
        app_id,
        env,
        "planned",
        "Application plan created",
        generation_id
      );

      this.log_intent_plan("artifact_type", intent_plan);
      const execution_plan = this.build_execution_plan_for_intent(plan, intent_plan);
      _xlog.log("[xvibe] execution plan created", {
        _app_id: app_id,
        _execution_plan: execution_plan,
      });

      this.push_generation_stage(
        app_id,
        env,
        "generating",
        "Generating artifacts...",
        generation_id
      );
      const context = this.build_artifact_generation_context({
        _plan: plan,
        _intent_plan: intent_plan,
        _app_id: app_id,
        _env: env,
        ...(generation_id ? { _generation_id: generation_id } : {}),
      });

      const generated_artifacts =
        await this.generate_planned_artifacts({
          _prompt: prompt,
          _entry_view_id: entry_view_id,
          _execution_plan: execution_plan,
          _context: context,
        });



      await _x.execute({
        _module: "server-xvm",
        _op: "set_active_app",
        _params: {
          _app_id: app_id,
          _env: env
        }
      });

      _xlog.log("[xvibe] app orchestration completed", {
        _app_id: app_id,
        _env: env,
        _generated_artifacts: generated_artifacts,
      });

      this.push_generation_stage(
        app_id,
        env,
        "complete",
        "Application ready",
        generation_id
      );

      return {
        _ok: true,
        _result: {
          _app_id: app_id,
          _env: env,
          _entry_view_id: entry_view_id,
          _plan: plan,
          _intent_plan: intent_plan,
          _generated_artifacts: generated_artifacts,
        }
      };
    } catch (error) {
      this.broadcast_generation_failed(
        {
          ...params,
          _app_id:
            typeof params._app_id === "string" && params._app_id.trim()
              ? params._app_id.trim()
              : "xvibe-app",
          _env:
            typeof params._env === "string" && params._env.trim()
              ? params._env.trim()
              : DEFAULT_ENV,
        },
        error,
        "E_VIBE_AI_GENERATE_APP",
      );
      const structured = structured_error_payload(error);
      if (structured) {
        _xlog.error("[xvibe] generate_app failed", error);
        return structured;
      }

      const message = error instanceof Error ? error.message : String(error);
      const diagnostic = parser_diagnostic(error);
      const diagnostics = parser_diagnostics(error);
      _xlog.error("[xvibe] generate_app failed", error);
      return {
        _ok: false,
        _error: {
          _code: "E_VIBE_AI_GENERATE_APP",
          _message: message,
          ...(diagnostic ? { _diagnostic: diagnostic } : {}),
          ...(diagnostics ? { _diagnostics: diagnostics } : {}),
        },
      };
    }
  }

  async _sync_skills(xcmd: XCommand) {
    const params =
      is_plain_object(xcmd?._params)
        ? xcmd._params
        : {};

    const skills =
      is_plain_object(params._skills)
        ? params._skills
        : {};

    const skills_count =
      Array.isArray((skills as any)._modules)
        ? (skills as any)._modules.length
        : 0;

    const scope =
      this.runtime_skill_scope(
        params._app_id,
        params._env,
        params._mode
      );

    this.runtime_skills_by_scope.set(scope, {
      _app_id: params._app_id,
      _env: params._env,
      _mode: params._mode,
      _skills: skills,
      _skills_count: skills_count,
      _synced_at: new Date().toISOString()
    });

    this.latest_runtime_skills = {
      _app_id: params._app_id,
      _env: params._env,
      _mode: params._mode,
      _skills: skills,
      _skills_count: skills_count,
      _synced_at: new Date().toISOString()
    };

    _xlog.log("[xvibe] runtime skills synced", {
      _scope: scope,
      _app_id: params._app_id,
      _env: params._env,
      _mode: params._mode,
      _skills_count: skills_count
    });

    return {
      _ok: true,
      _result: {
        _synced: true,
        _scope: scope,
        _skills_count: skills_count
      }
    };
  }


}
