import { _x, _xlog, XCommand, XModule, type XpellSkill, type XpellSkillCommand } from "@xpell/core";
import { _xem } from "../XEM/XEventManager.js";
import { VibeKnowledgeSelector } from "./VibeKnowledgeSelector.js";
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
import {
  infer_artifact_type,
  VibePromptBuilder,
} from "./VibePromptBuilder.js";
import { VibeViewBuilder } from "./VibeViewBuilder.js";
import type { VibeArtifactFactoryDiagnostic } from "./VibeArtifactFactory.js";

import type { VibeArtifactType, VibeRequestedArtifactType } from "./XVibeTypes.js";
import {
  XVibePlanner,
  type XVibeAppPlan,
  type XVibeArtifactExecutionItem,
  type XVibeArtifactPlanType,
} from "./XVibePlanner.js";
import {
  VibeIntentPlanner,
  type VibeIntentPlan,
} from "./VibeIntentPlanner.js";

type VibeAIMode = "full" | "refine";
const DEFAULT_ENV = "default";
const DEFAULT_VIEW_ID = "view-main";
const DEFAULT_SCAFFOLD_ROOT_TYPE = "view";
const MAX_VALIDATION_ERRORS = 50;
const MAX_REPAIR_ERRORS = 20;

type XVibeGeneratedArtifact =
  | XVibeViewArtifact
  | XVibeFlowArtifact
  | XVibeEntityArtifact
  | XVibeCommandArtifact;

type XVibeArtifactValidationResult =
  | { _ok: true; _errors: [] }
  | { _ok: false; _errors: string[] };

type XVibeRuntimeRegistry = {
  _xui_types: Set<string>;
  _modules: Set<string>;
};

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

function read_generated_text(value: unknown): string {
  if (is_plain_object(value) && typeof value._text === "string" && value._text.trim().length > 0) {
    return value._text;
  }

  throw new Error("Invalid xai response: missing '_text'");
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

function prompt_requests_styling(prompt: string): boolean {
  return /\b(style|styled|styling|theme|themed|color|colors|css|stylesheet|style-sheet|visual|design|polish|beautiful|pretty)\b/i.test(prompt);
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
  const matches = prompt.match(/\bflow-[a-z0-9][a-z0-9_-]*\b/gi) ?? [];
  return Array.from(new Set(matches.map((match) => match.toLowerCase())));
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
  _generated_artifacts?: unknown;
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

  private push_generation_stage(app_id: string, env: string, stage: string, message: string) {
    wsBroadcastScoped(app_id, env, {
      _name: "vibe:generation-stage",
      _args: [{
        _app_id: app_id,
        _env: env,
        _stage: stage,
        _message: message,
      }],
    });
  }

  private async collect_runtime_awareness_context(
    _input: XVibeRuntimeContextInput,
  ): Promise<XVibeJsonObject> {

    return {
      _app_id: _input._app_id,
      _env: _input._env,

      ...(_input._view_id
        ? {
          _view_id: _input._view_id
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

    const intent_prompt = [
      "You are an Xpell runtime intent planner.",
      "Return strict JSON only.",
      "Refine the deterministic shallow intent IR. Do not replace it with unrelated inventory.",
      "Runtime capabilities are available options and validation candidates only.",
      "Do not include runtime capabilities as selected _capabilities unless the user/app intent explicitly needs them.",
      'Schema: { "_ir_version": 1, "_intent_type": "", "_artifact_types": [], "_entities": [], "_regions": [], "_objects": [], "_actions": [], "_bindings": [], "_modules": [], "_style": {}, "_xui_objects": [], "_capabilities": [], "_crud_ops": [], "_ui_patterns": [], "_ui_keywords": [], "_flow_keywords": [], "_entity_keywords": [] }',
      'Entity shape: { "_id": "customers", "_fields": ["name", "email", "status"] }',
      'Action shape: { "_id": "add-customer", "_type": "flow", "_label": "Add Customer", "_entity": "customers", "_op": "add", "_target_region": "create_modal" }',
      'Binding shape: { "_target": "customers-table", "_source": "customers:records" }',
      'Style shape: { "_theme": "dark", "_density": "comfortable", "_layout": "dashboard" }',
      "Allowed _regions: sidebar, toolbar, kpi_grid, records_table, create_modal, details_drawer, filters, content.",
      "Allowed _objects: sidebar, navlist, toolbar, field, button, xsection, grid, card, kpi-card, table, modal, form, xselect, drawer, style-sheet.",
      "Keep this IR shallow. Do not output _children trees, final XUI JSON, or deeply nested UI structures.",
      "_objects and _xui_objects must be selected XUI object ids from the runtime registry.",
      "_modules must be selected runtime module ids from the runtime registry.",
      "_entities must be inferred entity descriptors only.",
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

      this.log_intent_plan("app", plan);

      return plan;
    } catch (error) {
      _xlog.warn("[xvibe] intent planning fallback", {
        _reason: error instanceof Error ? error.message : String(error),
      });
      return this.intent_planner.normalize_intent_plan({}, runtime_capabilities, inferred_intent);
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
        (field === "_style" && is_plain_object(field_value) && Object.keys(field_value).length > 0) ||
        (field === "_ir_version" && field_value === 1)
      );
    });
  }

  private create_artifact_intent_plan(params: {
    prompt: string;
    artifact_type: VibeArtifactType;
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
      return this.intent_planner.normalize_intent_plan(
        params.supplied_intent_plan,
        runtime_capabilities,
        artifact_intent,
      );
    }

    return artifact_intent;
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

    if (handler._module !== undefined || handler._op !== undefined) {
      if (typeof handler._module !== "string" || handler._module.trim().length === 0) {
        this.push_validation_error(errors, `${path} command requires non-empty _module`);
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
      if (!non_empty_string(node._text) && !non_empty_string(node._label)) {
        this.push_validation_error(errors, `${path} button requires visible _text or _label`);
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
    const registry = collect_runtime_registry(input._runtime_skills);
    const errors: string[] = [];

    if (input._artifact_type === "view") {
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
  }): Promise<XVibeGeneratedArtifact> {
    const validation = this.validate_generated_artifact(input);

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

    let repaired: XVibeGeneratedArtifact;

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
      throw error;
    }

    const repaired_validation =
      this.validate_generated_artifact({
        ...input,
        _artifact: repaired,
      });

    if (!repaired_validation._ok) {
      _xlog.warn("[xvibe] repair failed", {
        _artifact_type: input._artifact_type,
        _errors: repaired_validation._errors,
      });
      throw new Error(
        `Invalid repaired AI output: ${this.validation_error_summary(repaired_validation._errors)}`
      );
    }

    _xlog.log("[xvibe] repair success", {
      _artifact_type: input._artifact_type,
    });

    return repaired;
  }

  private build_artifact_generation_context(input: {
    _plan: XVibeAppPlan;
    _intent_plan?: XVibeJsonObject;
    _app_id: string;
    _env: string;
  }): XVibeArtifactGenerationContext {
    return {
      _plan: input._plan,
      ...(input._intent_plan ? { _intent_plan: input._intent_plan } : {}),
      _app_id: input._app_id,
      _env: input._env,
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

  private async generate_artifact(params: XVibeJsonObject, forced_artifact_type?: VibeArtifactType) {
    const prompt = resolve_prompt(params);
    const mode = read_mode(params._mode);
    const app_id = read_required_string(params._app_id, "_app_id");
    const env = read_optional_string(params._env, "_env") ?? DEFAULT_ENV;
    const requested_view_id = read_optional_string(params._view_id, "_view_id");
    const requested_artifact_type = read_artifact_type(params._artifact_type);
    const capabilities = read_optional_string_array(params._capabilities, "_capabilities");
    const planned_flow_ids = read_optional_string_array(params._planned_flow_ids, "_planned_flow_ids");
    const supplied_intent_plan = is_plain_object(params._intent_plan) ? params._intent_plan : {};
    const artifact_type = forced_artifact_type ?? infer_artifact_type(prompt, requested_artifact_type);

    if (mode === "refine" && artifact_type !== "view") {
      throw new Error("Invalid '_mode': refine is only supported for view artifacts");
    }

    if (mode === "refine" && !requested_view_id) {
      throw new Error("Invalid '_view_id': expected non-empty string for refine mode");
    }

    _xlog.log("[xvibe] generate", {
      _mode: mode,
      _artifact_type: artifact_type,
      ...(capabilities.length > 0 ? { _capabilities: capabilities } : {}),
      _app_id: app_id,
      _env: env,
    });

    const runtime_mode = app_id === "vibe-system" ? "system" : "runtime";

    const runtime_skills = this.get_runtime_skills(app_id, env, runtime_mode);

    const intent_plan = this.create_artifact_intent_plan({
      prompt,
      artifact_type,
      supplied_intent_plan,
      runtime_skills,
    });

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

    const runtime_context = await this.collect_runtime_awareness_context({
      _app_id: app_id,
      _env: env,

      ...(requested_view_id
        ? { _view_id: requested_view_id }
        : {}),

      ...(is_plain_object(params._generated_artifacts)
        ? { _generated_artifacts: params._generated_artifacts }
        : {}),
    });

    verbose_log("[xvibe] runtime context", runtime_context);

    let deterministic_skeleton: XVibeViewArtifact | undefined;

    if (artifact_type === "view") {
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

    const final_prompt = this.prompt_builder.build({
      prompt,
      _mode: mode,
      _artifact_type: artifact_type,
      selection,
      runtime_context,
      ...(deterministic_skeleton ? { deterministic_skeleton } : {}),
    });

    verbose_log("[xvibe] FINAL PROMPT", { _prompt: final_prompt });

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

    verbose_log("[xvibe] raw ai output", { _result: xai_result });

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
        include_artifact_type: forced_artifact_type !== "view",
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

      const flow = await this.validate_or_repair_generated_artifact({
        _prompt: prompt,
        _artifact_type: "flow",
        _artifact: parsed._flow,
        _runtime_skills: runtime_skills,
      }) as XVibeFlowArtifact;

      return this.persist_flow_artifact(app_id, env, flow);
    }

    if (artifact_type === "entity") {
      if (!parsed._entity) {
        throw new Error("Invalid AI output: expected parsed entity artifact");
      }

      const entity = await this.validate_or_repair_generated_artifact({
        _prompt: prompt,
        _artifact_type: "entity",
        _artifact: parsed._entity,
        _runtime_skills: runtime_skills,
      }) as XVibeEntityArtifact;

      return this.persist_entity_artifact(app_id, env, entity);
    }

    if (!parsed._command) {
      throw new Error("Invalid AI output: expected parsed command artifact");
    }

    const command = await this.validate_or_repair_generated_artifact({
      _prompt: prompt,
      _artifact_type: "command",
      _artifact: parsed._command,
      _runtime_skills: runtime_skills,
    }) as XVibeCommandArtifact;

    return this.return_command_artifact(app_id, env, command);
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
    include_artifact_type: boolean;
  }) {
    let view_to_persist: XVibeJsonObject = input.parsed_view;

    if (input.mode === "refine") {
      const current_result = unwrap_command_result(await _x.execute({
        _module: "server-xvm",
        _op: "get_view",
        _params: {
          _app_id: input.app_id,
          _env: input.env,
          _view_id: input.requested_view_id,
        },
      } as any));

      if (!is_plain_object(current_result) || !is_plain_object(current_result._view)) {
        throw new Error("Invalid server-xvm get_view response");
      }

      view_to_persist = merge_refined_view(current_result._view, {
        ...input.parsed_view,
        _id: input.requested_view_id,
      });
    } else {
      normalize_full_view_id(view_to_persist, input.requested_view_id);
    }

    ensure_valid_xui_root(view_to_persist);

    view_to_persist =
      await this.validate_or_repair_generated_artifact({
        _prompt: input.prompt,
        _artifact_type: "view",
        _artifact: view_to_persist as XVibeViewArtifact,
        _runtime_skills: input.runtime_skills,
        _generated_artifacts: input.generated_artifacts,
        _planned_flow_ids: input.planned_flow_ids,
      }) as XVibeJsonObject;

    const view_id = read_required_string(view_to_persist._id, "_view._id");
    _xlog.log("[xvibe] persist artifact", {
      _artifact_type: "view",
      _artifact_id: view_id,
    });

    await _x.execute({
      _module: "server-xvm",
      _op: "push_update",
      _params: {
        _app_id: input.app_id,
        ...(input.env ? { _env: input.env } : {}),
        _view: view_to_persist,
      },
    } as any);

    _xem.fire("vibe:view-updated", {
      _app_id: input.app_id,
      _env: input.env,
      _view_id: view_id,
    });

    _xlog.log("[xvibe] result", {
      _artifact_type: "view",
      _artifact_id: view_id,
    });

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

    await _x.execute({
      _module: "server-xvm",
      _op: "set_flow",
      _params: {
        _app_id: app_id,
        ...(env ? { _env: env } : {}),
        _flow: flow,
      },
    } as any);

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

    await _x.execute({
      _module: "server-xvm",
      _op: "set_entity",
      _params: {
        _app_id: app_id,
        ...(env ? { _env: env } : {}),
        _entity: entity,
      },
    } as any);

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
    try {
      const params = is_plain_object(xcmd?._params) ? xcmd._params : {};
      return await this.generate_artifact(params);
    } catch (error) {
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
    try {
      const params = is_plain_object(xcmd?._params) ? xcmd._params : {};
      return await this.generate_artifact(params, "view");
    } catch (error) {
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

    const prompt = resolve_prompt(params);
    const app_id =
      read_optional_string(params._app_id, "_app_id") ?? "xvibe-app";
    const env =
      read_optional_string(params._env, "_env") ?? DEFAULT_ENV;
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
      "Creating application..."
    );

    await _x.execute({
      _module: "server-xvm",
      _op: "push_update",
      _params: {
        _app_id: app_id,
        _env: env,
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
      "Planning application..."
    );

    const intent_plan = await this.create_intent_plan({
      prompt,
      app_plan: plan,
      app_id,
      env,
    });

    this.push_generation_stage(
      app_id,
      env,
      "planned",
      "Application plan created"
    );

    this.log_intent_plan("artifact_type", intent_plan);
    const execution_plan = this.planner.build_execution_plan(plan);
    _xlog.log("[xvibe] execution plan created", {
      _app_id: app_id,
      _execution_plan: execution_plan,
    });

    this.push_generation_stage(
      app_id,
      env,
      "generating",
      "Generating artifacts..."
    );
    const context = this.build_artifact_generation_context({
      _plan: plan,
      _intent_plan: intent_plan,
      _app_id: app_id,
      _env: env,
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
      "Application ready"
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
