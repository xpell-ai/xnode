import { _x, _xlog, _xu } from "@xpell/core";
import type {
  XVibeIntentAction,
  XVibeIntentActionStatus,
  XVibeIntentActionType,
  XVibeIntentEngineRequest,
  XVibeIntentExecutionLevel,
  XVibeIntentMessageType,
  XVibeIntentResult,
} from "../XVibeTypes.js";
import type { XVibeIntentProcessor } from "./XVibeIntentProcessor.js";
import { resolveProjectViewId } from "../StructuredEditing/ProjectViewResolution.js";
import { preflightSemanticViewEdit } from "../StructuredEditing/SemanticViewEditPreflight.js";
import {
  canonicalizeSemanticViewEditParams,
  isStructuredViewEditAction,
} from "../StructuredEditing/StructuredViewEdit.js";

const SEMANTIC_INTENT_ENABLED_ENV = "XVIBE_SEMANTIC_INTENT_ENABLED";
const SEMANTIC_INTENT_PROVIDER_ENV = "XVIBE_SEMANTIC_INTENT_PROVIDER";
const SEMANTIC_ROUTING_CAPABILITY = "semantic-routing";
const SEMANTIC_INTENT_SYSTEM_PROMPT =
  [
    "You are an intent extractor for XVibe.",
    "Return only direct valid JSON matching XVibeIntentResult.",
    "The JSON object must include _message_type, _execution_level, _should_mutate, _confidence, _reason, and _actions.",
    "_message_type must be one of: conversation, question, inspect, edit, generate, planning, debug.",
    "Never use XVibeIntentResult as _message_type.",
    "_execution_level must be one of: none, deterministic, artifact, planning, model.",
    "Never use TYPED_OBJECT or TYPED_RUNTIME as _execution_level.",
    "Do not wrap the result in query, intent, object_type, object_id, or any other envelope.",
    "Do not execute actions. Do not generate code. Do not use markdown.",
  ].join(" ");

const MESSAGE_TYPES: readonly XVibeIntentMessageType[] = [
  "conversation",
  "question",
  "inspect",
  "edit",
  "generate",
  "planning",
  "debug",
];

const EXECUTION_LEVELS: readonly XVibeIntentExecutionLevel[] = [
  "none",
  "deterministic",
  "artifact",
  "planning",
  "model",
];

const ACTION_TYPES: readonly XVibeIntentActionType[] = [
  "apply-view-edit",
  "generate-artifact",
  "inspect-runtime",
  "module-op",
  "module-generate",
  "module-edit",
  "open-panel",
  "ask-user",
  "reply",
];

const ACTION_STATUSES: readonly XVibeIntentActionStatus[] = [
  "suggested",
  "approved",
  "running",
  "done",
  "failed",
  "rejected",
];

const MESSAGE_TYPE_ALIASES: Record<string, XVibeIntentMessageType> = {
  chat: "conversation",
  message: "conversation",
  ask: "question",
  query: "question",
  "runtime-inspect": "inspect",
  "inspect-runtime": "inspect",
  "view-edit": "edit",
  "ui-edit": "edit",
  "artifact-generate": "generate",
  "generate-artifact": "generate",
  plan: "planning",
};

const EXECUTION_LEVEL_ALIASES: Record<string, XVibeIntentExecutionLevel> = {
  noop: "none",
  "no-op": "none",
  noexecution: "none",
  "no-execution": "none",
  static: "deterministic",
  rules: "deterministic",
  "rule-based": "deterministic",
  artifactgeneration: "artifact",
  "artifact-generation": "artifact",
  artifactgenerate: "artifact",
  "artifact-generate": "artifact",
  plan: "planning",
  planner: "planning",
  ai: "model",
  llm: "model",
  semantic: "model",
  "model-based": "model",
};

const ACTION_TYPE_ALIASES: Record<string, XVibeIntentActionType> = {
  "apply-view": "apply-view-edit",
  applyviewedit: "apply-view-edit",
  "apply-viewedit": "apply-view-edit",
  "apply-view-edit": "apply-view-edit",
  edit: "apply-view-edit",
  viewedit: "apply-view-edit",
  "view-edit": "apply-view-edit",
  editview: "apply-view-edit",
  "edit-view": "apply-view-edit",
  modifyview: "apply-view-edit",
  "modify-view": "apply-view-edit",
  updateview: "apply-view-edit",
  "update-view": "apply-view-edit",
  editartifact: "apply-view-edit",
  "edit-artifact": "apply-view-edit",
  modifyartifact: "apply-view-edit",
  "modify-artifact": "apply-view-edit",
  updateartifact: "apply-view-edit",
  "update-artifact": "apply-view-edit",
  addsection: "apply-view-edit",
  "add-section": "apply-view-edit",
  addviewsection: "apply-view-edit",
  "add-view-section": "apply-view-edit",
  addcomponent: "apply-view-edit",
  "add-component": "apply-view-edit",
  addui: "apply-view-edit",
  "add-ui": "apply-view-edit",
  "ui-edit": "apply-view-edit",
  hide: "apply-view-edit",
  "hide-object": "apply-view-edit",
  show: "apply-view-edit",
  "show-object": "apply-view-edit",
  remove: "apply-view-edit",
  "remove-object": "apply-view-edit",
  delete: "apply-view-edit",
  "delete-object": "apply-view-edit",
  duplicate: "apply-view-edit",
  "duplicate-object": "apply-view-edit",
  copy: "apply-view-edit",
  "copy-object": "apply-view-edit",
  move: "apply-view-edit",
  "move-object": "apply-view-edit",
  generate: "generate-artifact",
  generateartifact: "generate-artifact",
  "generate-artifact": "generate-artifact",
  artifactgenerate: "generate-artifact",
  "artifact-generate": "generate-artifact",
  createartifact: "generate-artifact",
  "create-artifact": "generate-artifact",
  inspect: "inspect-runtime",
  inspectruntime: "inspect-runtime",
  "inspect-runtime": "inspect-runtime",
  module: "module-op",
  moduleop: "module-op",
  "module-op": "module-op",
  moduleoperation: "module-op",
  "module-operation": "module-op",
  modulegenerate: "module-generate",
  "module-generate": "module-generate",
  generatemodule: "module-generate",
  "generate-module": "module-generate",
  moduleedit: "module-edit",
  "module-edit": "module-edit",
  editmodule: "module-edit",
  "edit-module": "module-edit",
  panel: "open-panel",
  openpanel: "open-panel",
  "open-panel": "open-panel",
  ask: "ask-user",
  askuser: "ask-user",
  "ask-user": "ask-user",
  clarify: "ask-user",
  question: "ask-user",
  respond: "reply",
  answer: "reply",
  chat: "reply",
  conversation: "reply",
};

const ACTION_STATUS_ALIASES: Record<string, XVibeIntentActionStatus> = {
  suggest: "suggested",
  proposal: "suggested",
  proposed: "suggested",
  approve: "approved",
  accepted: "approved",
  confirmed: "approved",
  inprogress: "running",
  "in-progress": "running",
  processing: "running",
  complete: "done",
  completed: "done",
  success: "done",
  succeeded: "done",
  error: "failed",
  failure: "failed",
  decline: "rejected",
  declined: "rejected",
  deny: "rejected",
  denied: "rejected",
  cancel: "rejected",
  canceled: "rejected",
  cancelled: "rejected",
};

const VIEW_EDIT_ACTION_ALIASES: Record<string, string> = {
  hide: "hide-object",
  "hide-object": "hide-object",
  show: "show-object",
  "show-object": "show-object",
  remove: "remove-object",
  "remove-object": "remove-object",
  delete: "remove-object",
  "delete-object": "remove-object",
  duplicate: "duplicate-object",
  "duplicate-object": "duplicate-object",
  copy: "duplicate-object",
  "copy-object": "duplicate-object",
  move: "move-object",
  "move-object": "move-object",
  "set-styles": "set-styles",
  setstyles: "set-styles",
  "update-style": "set-styles",
  updatestyle: "set-styles",
  "update-styles": "set-styles",
  updatestyles: "set-styles",
  addsection: "add-child",
  "add-section": "add-child",
  addviewsection: "add-child",
  "add-view-section": "add-child",
  addcomponent: "add-child",
  "add-component": "add-child",
  addobject: "add-child",
  "add-object": "add-child",
  addui: "add-child",
  "add-ui": "add-child",
  addtoolbar: "create-toolbar",
  "add-toolbar": "create-toolbar",
  addtoptoolbar: "create-toolbar",
  "add-top-toolbar": "create-toolbar",
  createtoolbar: "create-toolbar",
  "create-toolbar": "create-toolbar",
  createtoptoolbar: "create-toolbar",
  "create-top-toolbar": "create-toolbar",
  inserttoolbar: "create-toolbar",
  "insert-toolbar": "create-toolbar",
  inserttoptoolbar: "create-toolbar",
  "insert-top-toolbar": "create-toolbar",
  setproperty: "set-property",
  "set-property": "set-property",
  updateproperty: "update-property",
  "update-property": "update-property",
};

const SEMANTIC_STRUCTURED_VIEW_EDIT_ACTIONS = new Set([
  "set-property",
  "update-property",
  "remove-property",
  "set-style",
  "set-styles",
  "remove-style",
  "add-class",
  "remove-class",
  "replace-class",
  "toggle-class",
  "remove-object",
  "hide-object",
  "show-object",
  "move-object",
  "replace-object",
  "duplicate-object",
  "add-child",
  "create-toolbar",
  "set-interaction",
]);

const APPLY_VIEW_EDIT_MESSAGE_TYPE_ALIASES = new Set([
  "xvibe-intent-result",
  "intent-result",
  "edit-intent",
  "view-edit-intent",
]);

const APPLY_VIEW_EDIT_EXECUTION_LEVEL_ALIASES = new Set([
  "artifact",
  "model",
  "typed-object",
  "typedobject",
  "typed-runtime",
  "typedruntime",
]);

const SEMANTIC_SET_STYLES_ACTION_ALIASES = new Set([
  "set-style",
  "set-styles",
  "update-style",
  "update-styles",
]);

const SEMANTIC_GENERIC_PROPERTIES_ACTION_ALIASES = new Set([
  "update-properties",
  "set-properties",
]);

const SEMANTIC_STYLE_PROPERTY_ALIASES: Record<string, string> = {
  "font-size": "font-size",
  "font-weight": "font-weight",
  "margin-bottom": "margin-bottom",
  "background-color": "background-color",
};

type NormalizedValue<T extends string> = {
  _value: T;
  _normalized: boolean;
};

type NormalizedSemanticIntent = {
  _intent: XVibeIntentResult;
  _normalized_fields: string[];
};

type SemanticViewEditPayloadNormalization = {
  _action: XVibeIntentAction;
  _normalized_fields: string[];
};

type SemanticProviderFailureDiagnostics = {
  _error?: unknown;
  _reason?: unknown;
  _status?: unknown;
};

class SemanticProviderError extends Error {
  readonly _diagnostics: SemanticProviderFailureDiagnostics;

  constructor(
    message: string,
    diagnostics: SemanticProviderFailureDiagnostics,
  ) {
    super(message);
    this.name = "SemanticProviderError";
    this._diagnostics = diagnostics;
  }
}

class SemanticResponseParseError extends Error {
  readonly _text_sample: string;

  constructor(message: string, text: string) {
    super(message);
    this.name = "SemanticResponseParseError";
    this._text_sample = text.slice(0, 300);
  }
}

export type XVibeSemanticIntentGenerateJsonInput = {
  prompt: string;
  system: string;
  context: Record<string, unknown>;
  response_format: {
    type: "json_object";
  };
  _task?: string;
  _capability?: string;
  _provider?: string;
};

export type XVibeSemanticIntentGenerateJson = (
  input: XVibeSemanticIntentGenerateJsonInput,
) => Promise<unknown>;

export type SemanticIntentProcessorOptions = {
  _generate_json?: XVibeSemanticIntentGenerateJson;
};

function semantic_intent_enabled(): boolean {
  return process.env[SEMANTIC_INTENT_ENABLED_ENV] === "true";
}

function semantic_intent_provider(): string | undefined {
  const provider =
    process.env[SEMANTIC_INTENT_PROVIDER_ENV];

  return typeof provider === "string" && provider.trim().length > 0
    ? provider.trim()
    : undefined;
}

function semantic_log_safe_value(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value instanceof Error) {
    const status =
      (value as Error & { _status?: unknown; status?: unknown })._status ??
      (value as Error & { status?: unknown }).status;
    return {
      _error: value.message,
      ...(status !== undefined
        ? {
          _status: semantic_log_safe_value(status, depth + 1),
        }
        : {}),
    };
  }

  if (depth >= 5) {
    return "[truncated]";
  }

  if (Array.isArray(value)) {
    return value.map((item) => semantic_log_safe_value(item, depth + 1));
  }

  if (_xu.is_plain_object(value)) {
    const safe: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (
        /(?:api[_-]?key|token|secret|password|authorization|credential|bearer)/iu
          .test(key)
      ) {
        safe[key] = "[redacted]";
        continue;
      }

      safe[key] = semantic_log_safe_value(item, depth + 1);
    }

    return safe;
  }

  return String(value);
}

function semantic_provider_diagnostics(
  value: unknown,
): SemanticProviderFailureDiagnostics {
  const value_record =
    _xu.is_plain_object(value)
      ? value
      : undefined;
  const source =
    _xu.is_plain_object(value_record?._error) ||
      _xu.is_plain_object(value_record?._result)
      ? (value_record?._error ?? value_record?._result)
      : value;
  const diagnostics: SemanticProviderFailureDiagnostics = {};

  if (_xu.is_plain_object(source)) {
    if (source._error !== undefined) {
      diagnostics._error =
        semantic_log_safe_value(source._error);
    }
    if (source._reason !== undefined) {
      diagnostics._reason =
        semantic_log_safe_value(source._reason);
    }
    if (source._status !== undefined) {
      diagnostics._status =
        semantic_log_safe_value(source._status);
    }
  }

  if (value_record) {
    if (diagnostics._error === undefined && value_record._error !== undefined) {
      diagnostics._error =
        semantic_log_safe_value(value_record._error);
    }
    if (diagnostics._reason === undefined && value_record._reason !== undefined) {
      diagnostics._reason =
        semantic_log_safe_value(value_record._reason);
    }
    if (diagnostics._status === undefined && value_record._status !== undefined) {
      diagnostics._status =
        semantic_log_safe_value(value_record._status);
    }
  }

  if (
    diagnostics._error === undefined &&
    diagnostics._reason === undefined &&
    diagnostics._status === undefined
  ) {
    diagnostics._error =
      semantic_log_safe_value(value);
  }

  return diagnostics;
}

function unwrap_command_result(value: unknown): unknown {
  if (!_xu.is_plain_object(value) || typeof value._ok !== "boolean") {
    return value;
  }

  if (value._ok === false) {
    throw new SemanticProviderError(
      "semantic provider command failed",
      semantic_provider_diagnostics(value),
    );
  }

  return Object.prototype.hasOwnProperty.call(value, "_result")
    ? value._result
    : value;
}

function parse_json_text(value: string): unknown {
  try {
    return JSON.parse(value.trim());
  } catch (error) {
    throw new SemanticResponseParseError(
      error instanceof Error ? error.message : String(error),
      value,
    );
  }
}

function semantic_alias_key(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase()
    .replace(/[\s_]+/gu, "-")
    .replace(/[^a-z0-9-]+/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function normalize_contract_value<T extends string>(
  value: unknown,
  allowed: readonly T[],
  aliases: Record<string, T>,
): NormalizedValue<T> | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const allowed_value = allowed.find((item) => item === trimmed);
  if (allowed_value) {
    return {
      _value: allowed_value,
      _normalized: false,
    };
  }

  const key = semantic_alias_key(trimmed);
  const normalized_allowed = allowed.find((item) =>
    semantic_alias_key(item) === key,
  );
  if (normalized_allowed) {
    return {
      _value: normalized_allowed,
      _normalized: normalized_allowed !== trimmed,
    };
  }

  const alias = aliases[key];
  return alias
    ? {
      _value: alias,
      _normalized: true,
    }
    : null;
}

function normalize_view_edit_action(value: unknown): NormalizedValue<string> | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const key = semantic_alias_key(trimmed);
  const alias = VIEW_EDIT_ACTION_ALIASES[key];
  return alias
    ? {
      _value: alias,
      _normalized: alias !== trimmed,
    }
    : null;
}

function semantic_trimmed_string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function semantic_clone_json_object(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

function semantic_raw_edit_action_for_log(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (_xu.is_plain_object(value)) {
    return semantic_read_string(value, [
      "action",
      "_action",
      "type",
      "_type",
    ]) ?? "object";
  }
  return value === undefined || value === null
    ? undefined
    : typeof value;
}

function semantic_style_log_summary(params: Record<string, unknown>): {
  _style_count: number;
  _style_properties: string[];
} {
  const styles =
    _xu.is_plain_object(params._styles)
      ? params._styles as Record<string, unknown>
      : undefined;
  const style_properties =
    styles ? Object.keys(styles).sort() : [];
  return {
    _style_count: style_properties.length,
    _style_properties: style_properties,
  };
}

function semantic_title_case(value: string): string {
  return value
    .split(/\s+/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function semantic_safe_id(value: string, fallback: string): string {
  const id = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");

  return id || fallback;
}

function semantic_read_string(
  source: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = semantic_trimmed_string(source[key]);
    if (value) return value;
  }

  return undefined;
}

function semantic_runtime_current_view_id(
  request: XVibeIntentEngineRequest,
): string | undefined {
  const runtime_context =
    request._runtime_context as unknown as Record<string, unknown>;
  const direct =
    semantic_read_string(runtime_context, [
      "_view_id",
      "view_id",
      "_active_view_id",
      "active_view_id",
      "_current_view_id",
      "current_view_id",
    ]);
  if (direct) return direct;

  if (_xu.is_plain_object(runtime_context._current_view)) {
    const view_id =
      semantic_trimmed_string(runtime_context._current_view._id);
    if (view_id) return view_id;
  }

  if (_xu.is_plain_object(runtime_context._selected_object)) {
    return semantic_read_string(runtime_context._selected_object, [
      "_source_view_id",
      "source_view_id",
    ]);
  }

  return undefined;
}

function semantic_runtime_available_view_ids(
  request: XVibeIntentEngineRequest,
): string[] {
  const runtime_context =
    request._runtime_context as unknown as Record<string, unknown>;
  const available_artifacts =
    _xu.is_plain_object(runtime_context._available_artifacts)
      ? runtime_context._available_artifacts as Record<string, unknown>
      : undefined;
  const available_views =
    available_artifacts?._views;
  const views =
    Array.isArray(available_views)
      ? available_views
      : [];

  const ids =
    views
      .map((view_id) => semantic_trimmed_string(view_id))
      .filter((view_id): view_id is string => Boolean(view_id));

  if (_xu.is_plain_object(runtime_context._current_view)) {
    const current_view_id =
      semantic_trimmed_string(runtime_context._current_view._id);
    if (current_view_id) ids.push(current_view_id);
  }

  return [...new Set(ids)];
}

function semantic_runtime_current_view(
  request: XVibeIntentEngineRequest,
): unknown {
  const runtime_context =
    request._runtime_context as unknown as Record<string, unknown>;
  return runtime_context._current_view;
}

function semantic_runtime_selected_object(
  request: XVibeIntentEngineRequest,
): Record<string, unknown> | undefined {
  return _xu.is_plain_object(request._runtime_context._selected_object)
    ? request._runtime_context._selected_object
    : undefined;
}

function semantic_view_edit_child_value(
  params: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const child =
    params._child ??
    params.child ??
    params._edit_child_value ??
    params.edit_child_value ??
    params._edit_object_value ??
    params.edit_object_value ??
    params._object_value ??
    params.object_value;

  return _xu.is_plain_object(child)
    ? semantic_clone_json_object(child)
    : undefined;
}

function semantic_section_title_from_prompt(prompt: string): string | undefined {
  const match =
    prompt.match(/\b(?:add|create|insert)\s+(?:a|an|the)?\s*([^.!?]*?)\s+section\b/iu);
  const raw_title =
    match?.[1]
      ?.replace(/\b(?:new|ui|view|current|root)\b/giu, " ")
      .replace(/\s+/gu, " ")
      .trim();
  if (!raw_title) return undefined;

  return semantic_title_case(raw_title);
}

function semantic_section_title(input: {
  _params: Record<string, unknown>;
  _request: XVibeIntentEngineRequest;
}): string {
  const param_title =
    semantic_read_string(input._params, [
      "_section_name",
      "section_name",
      "_section_title",
      "section_title",
      "_title",
      "title",
      "_label",
      "label",
    ]);
  if (param_title) return param_title;

  return semantic_section_title_from_prompt(input._request._message) ?? "Section";
}

function semantic_prompt_mentions_section(prompt: string): boolean {
  return /\bsection\b/iu.test(prompt);
}

function semantic_prompt_mentions_list_or_table(prompt: string): boolean {
  return /\b(?:list|table)\b/iu.test(prompt);
}

function semantic_can_synthesize_section_child(input: {
  _params: Record<string, unknown>;
  _request: XVibeIntentEngineRequest;
  _explicit_target_type?: string;
}): boolean {
  if (!semantic_is_semantic_view_add_child(input._params)) {
    return false;
  }

  if (
    input._explicit_target_type &&
    !semantic_is_view_target_type(input._explicit_target_type)
  ) {
    return false;
  }

  if (
    semantic_read_string(input._params, [
      "_section_name",
      "section_name",
      "_section_title",
      "section_title",
      "_section_type",
      "section_type",
    ])
  ) {
    return true;
  }

  return semantic_prompt_mentions_section(input._request._message);
}

function semantic_synthesize_section_child(input: {
  _params: Record<string, unknown>;
  _request: XVibeIntentEngineRequest;
  _explicit_target_type?: string;
}): Record<string, unknown> | undefined {
  if (!semantic_can_synthesize_section_child(input)) {
    return undefined;
  }

  const title =
    semantic_section_title({
      _params: input._params,
      _request: input._request,
    });
  const base_id =
    `${semantic_safe_id(title, "section")}-section`;
  const child: Record<string, unknown> = {
    _type: "xsection",
    _id: base_id,
    _children: [
      {
        _type: "label",
        _id: `${base_id}-title`,
        _text: title,
      },
    ],
  };

  if (semantic_prompt_mentions_list_or_table(input._request._message)) {
    (child._children as Record<string, unknown>[]).push({
      _type: "table",
      _id: `${base_id}-table`,
      _columns: [],
      _empty_text: "No data yet.",
    });
  }

  _xlog.log("[xvibe] semantic child synthesized", {
    _strategy: semantic_prompt_mentions_list_or_table(input._request._message)
      ? "section-with-table"
      : "section",
    _child_type: child._type,
    _child_id: child._id,
  });

  return child;
}

function semantic_add_child_location_label(value: unknown): "Header" | "Footer" {
  const location =
    semantic_trimmed_string(value);
  if (!location) return "Footer";

  const normalized = semantic_alias_key(location);
  return normalized === "header" ||
    normalized === "top" ||
    normalized === "toolbar"
    ? "Header"
    : "Footer";
}

function semantic_normalize_component_type(value: unknown): string | undefined {
  const component_type =
    semantic_trimmed_string(value);
  if (!component_type) return undefined;

  const normalized = semantic_alias_key(component_type);
  if (
    normalized === "label" ||
    normalized === "textlabel" ||
    normalized === "text-label" ||
    normalized === "text"
  ) {
    return "label";
  }

  return component_type;
}

function semantic_add_object_props_payload(params: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw =
    params._new_object_props ?? params.new_object_props;
  return _xu.is_plain_object(raw)
    ? raw as Record<string, unknown>
    : undefined;
}

function semantic_properties_payload(params: Record<string, unknown>): Record<string, unknown> | undefined {
  const raw =
    params._properties ?? params.properties;
  return _xu.is_plain_object(raw)
    ? raw as Record<string, unknown>
    : undefined;
}

function semantic_normalize_style_property_name(value: string): string {
  const trimmed = value.trim();
  const normalized =
    SEMANTIC_STYLE_PROPERTY_ALIASES[semantic_alias_key(trimmed)];
  return normalized ?? trimmed;
}

function semantic_normalize_style_properties(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [property_name, property_value] of Object.entries(value)) {
    normalized[semantic_normalize_style_property_name(property_name)] =
      property_value;
  }
  return normalized;
}

function semantic_nested_style_payload(
  edit_action: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const raw =
    edit_action.properties ??
    edit_action._properties ??
    edit_action.styles ??
    edit_action._styles;
  return _xu.is_plain_object(raw)
    ? raw as Record<string, unknown>
    : undefined;
}

function semantic_multi_style_payload(
  params: Record<string, unknown>,
): { _field: string; _styles: Record<string, unknown> } | undefined {
  const candidates: Array<[string, unknown]> = [
    ["_style_properties", params._style_properties],
    ["_styles", params._styles],
    ["_properties", params._properties],
    ["properties", params.properties],
    ["styles", params.styles],
  ];

  for (const [field, value] of candidates) {
    if (_xu.is_plain_object(value) && Object.keys(value).length > 0) {
      return {
        _field: field,
        _styles: value as Record<string, unknown>,
      };
    }
  }

  return undefined;
}

function semantic_generic_properties_payload(
  params: Record<string, unknown>,
): { _field: "_properties" | "properties"; _properties: Record<string, unknown> } | undefined {
  if (_xu.is_plain_object(params._properties)) {
    return {
      _field: "_properties",
      _properties: params._properties as Record<string, unknown>,
    };
  }

  if (_xu.is_plain_object(params.properties)) {
    return {
      _field: "properties",
      _properties: params.properties as Record<string, unknown>,
    };
  }

  return undefined;
}

function semantic_properties_style_payload(
  properties: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const raw =
    properties.styles ??
    properties._styles ??
    properties.style ??
    properties._style;
  return _xu.is_plain_object(raw) && Object.keys(raw).length > 0
    ? raw as Record<string, unknown>
    : undefined;
}

function semantic_is_generic_properties_action(value: unknown): boolean {
  const edit_action =
    semantic_trimmed_string(value);
  return edit_action
    ? SEMANTIC_GENERIC_PROPERTIES_ACTION_ALIASES.has(semantic_alias_key(edit_action))
    : false;
}

function semantic_normalize_generic_properties_payload(
  params: Record<string, unknown>,
): string[] {
  if (!semantic_is_generic_properties_action(params._edit_action)) {
    return [];
  }

  const normalized_fields: string[] = [];
  const payload =
    semantic_generic_properties_payload(params);
  if (!payload) {
    params._semantic_non_executable_reason = "unsupported_property_batch";
    normalized_fields.push("_semantic_non_executable_reason");
    return normalized_fields;
  }

  const style_payload =
    semantic_properties_style_payload(payload._properties);
  if (style_payload) {
    params._edit_action = "set-styles";
    params._styles = semantic_normalize_style_properties(style_payload);
    normalized_fields.push("_edit_action", "_styles");
    for (const field of ["_properties", "properties"]) {
      if (Object.prototype.hasOwnProperty.call(params, field)) {
        delete params[field];
        normalized_fields.push(field);
      }
    }
    return [...new Set(normalized_fields)];
  }

  const entries =
    Object.entries(payload._properties);
  if (entries.length === 1) {
    const [property_name, property_value] = entries[0];
    params._edit_action = "update-property";
    params._property_name = property_name;
    params._property_value = property_value;
    normalized_fields.push("_edit_action", "_property_name", "_property_value");
    for (const field of ["_properties", "properties"]) {
      if (Object.prototype.hasOwnProperty.call(params, field)) {
        delete params[field];
        normalized_fields.push(field);
      }
    }
    return [...new Set(normalized_fields)];
  }

  params._semantic_non_executable_reason = "unsupported_property_batch";
  normalized_fields.push("_semantic_non_executable_reason");
  return normalized_fields;
}

function semantic_is_multi_style_action(value: unknown): boolean {
  const edit_action =
    semantic_trimmed_string(value);
  return edit_action
    ? SEMANTIC_SET_STYLES_ACTION_ALIASES.has(semantic_alias_key(edit_action))
    : false;
}

function semantic_normalize_multi_style_payload(
  params: Record<string, unknown>,
): string[] {
  if (!semantic_is_multi_style_action(params._edit_action)) {
    return [];
  }

  const payload =
    semantic_multi_style_payload(params);
  if (!payload) {
    return [];
  }

  const normalized_fields: string[] = [];
  if (params._edit_action !== "set-styles") {
    params._edit_action = "set-styles";
    normalized_fields.push("_edit_action");
  }

  params._styles = semantic_normalize_style_properties(payload._styles);
  normalized_fields.push("_styles");

  for (const field of ["_style_properties", "_properties", "properties", "styles"]) {
    if (Object.prototype.hasOwnProperty.call(params, field)) {
      delete params[field];
      normalized_fields.push(field);
    }
  }

  return [...new Set(normalized_fields)];
}

function semantic_normalize_nested_edit_action(
  params: Record<string, unknown>,
): string[] {
  if (!_xu.is_plain_object(params._edit_action)) {
    return [];
  }

  const normalized_fields: string[] = [];
  const edit_action =
    params._edit_action as Record<string, unknown>;
  const nested_action =
    semantic_read_string(edit_action, [
      "action",
      "_action",
      "type",
      "_type",
    ]);
  if (!nested_action) {
    return normalized_fields;
  }

  const nested_action_key =
    semantic_alias_key(nested_action);
  if (SEMANTIC_SET_STYLES_ACTION_ALIASES.has(nested_action_key)) {
    params._edit_action = "set-styles";
    normalized_fields.push("_edit_action");

    const styles =
      semantic_nested_style_payload(edit_action);
    if (styles) {
      params._styles = semantic_normalize_style_properties(styles);
      normalized_fields.push("_styles");
    }

    return normalized_fields;
  }

  const normalized_action =
    normalize_view_edit_action(nested_action);
  if (normalized_action) {
    params._edit_action = normalized_action._value;
    normalized_fields.push("_edit_action");
  }

  return normalized_fields;
}

function semantic_normalize_add_object_props(
  params: Record<string, unknown>,
): string[] {
  const normalized_fields: string[] = [];
  const new_object_props = semantic_add_object_props_payload(params);
  if (!new_object_props) return normalized_fields;

  const component_type =
    semantic_normalize_component_type(
      new_object_props._object_type ??
      new_object_props.object_type ??
      new_object_props._type ??
      new_object_props.type,
    );
  if (component_type && params._component_type !== component_type) {
    params._component_type = component_type;
    normalized_fields.push("_component_type");
  }

  const layout_position =
    semantic_trimmed_string(
      new_object_props.layoutPosition ??
      new_object_props._layoutPosition ??
      new_object_props.layout_position ??
      new_object_props._layout_position ??
      new_object_props._location ??
      new_object_props.location,
    );
  if (layout_position && params._location !== layout_position) {
    params._location = layout_position;
    normalized_fields.push("_location");
  }

  const content =
    semantic_trimmed_string(
      new_object_props.content ??
      new_object_props._content ??
      new_object_props.text ??
      new_object_props._text,
    );
  if (content) {
    const props =
      _xu.is_plain_object(params._props)
        ? { ...(params._props as Record<string, unknown>) }
        : {};
    if (props._text !== content) {
      props._text = content;
      params._props = props;
      normalized_fields.push("_props");
    }
  }

  return normalized_fields;
}

function semantic_normalize_add_child_alternate_fields(
  params: Record<string, unknown>,
): string[] {
  if (semantic_trimmed_string(params._edit_action) !== "add-child") {
    return [];
  }

  const normalized_fields: string[] = [];
  const target_type =
    semantic_read_string(params, [
      "_target_type",
      "target_type",
    ]);
  const component_type =
    semantic_normalize_component_type(
      params._component_type ??
      params.component_type ??
      target_type,
    );
  if (component_type === "label" && params._component_type !== component_type) {
    params._component_type = component_type;
    normalized_fields.push("_component_type");
  }
  if (target_type && semantic_normalize_component_type(target_type) === "label") {
    if (Object.prototype.hasOwnProperty.call(params, "_target_type")) {
      delete params._target_type;
      normalized_fields.push("_target_type");
    }
    if (Object.prototype.hasOwnProperty.call(params, "target_type")) {
      delete params.target_type;
      normalized_fields.push("target_type");
    }
  }

  const parent_slot =
    semantic_trimmed_string(params._parent_slot ?? params.parent_slot);
  if (parent_slot && params._location !== parent_slot) {
    params._location = parent_slot;
    normalized_fields.push("_location");
  }

  const properties = semantic_properties_payload(params);
  if (properties) {
    const props =
      _xu.is_plain_object(params._props)
        ? { ...(params._props as Record<string, unknown>) }
        : {};
    const text =
      semantic_trimmed_string(properties._text ?? properties.text);
    if (text && props._text !== text) {
      props._text = text;
      normalized_fields.push("_props");
    }
    const class_name =
      semantic_trimmed_string(properties.class ?? properties._class);
    if (class_name && props.class !== class_name) {
      props.class = class_name;
      normalized_fields.push("_props");
    }
    if (Object.keys(props).length > 0) {
      params._props = props;
    }
  }

  return [...new Set(normalized_fields)];
}

function semantic_normalize_set_styles_alternate_fields(
  params: Record<string, unknown>,
): string[] {
  if (semantic_trimmed_string(params._edit_action) !== "set-styles") {
    return [];
  }

  const normalized_fields: string[] = [];
  const properties = semantic_properties_payload(params);
  if (properties && params._styles !== properties) {
    params._styles = semantic_normalize_style_properties(properties);
    normalized_fields.push("_styles");
  }

  return normalized_fields;
}

function semantic_validate_set_styles_contract(value: unknown): string | null {
  if (!_xu.is_plain_object(value)) {
    return "invalid_styles";
  }

  const entries =
    Object.entries(value);
  if (entries.length === 0) {
    return "missing_styles";
  }

  for (const [raw_property, raw_value] of entries) {
    const style_property =
      semantic_normalize_style_property_name(raw_property);
    if (!style_property) {
      return "missing_style_property";
    }

    if (typeof raw_value !== "string" || raw_value.trim().length === 0) {
      return "invalid_style_value";
    }
  }

  return null;
}

function semantic_style_contract_error(
  params: Record<string, unknown>,
  edit_action: string,
): string | null {
  if (edit_action === "set-style") {
    if (!semantic_trimmed_string(params._style_property)) {
      return "missing_style_property";
    }
    if (!semantic_trimmed_string(params._style_value)) {
      return "missing_style_value";
    }
  }

  if (edit_action === "set-styles") {
    return semantic_validate_set_styles_contract(params._styles);
  }

  return null;
}

function semantic_structured_view_edit_action_error(edit_action: string): string | null {
  return SEMANTIC_STRUCTURED_VIEW_EDIT_ACTIONS.has(edit_action)
    ? null
    : "unsupported_edit_action";
}

function semantic_add_child_text(params: Record<string, unknown>, label: "Header" | "Footer"): string {
  if (_xu.is_plain_object(params._props)) {
    const props_text =
      semantic_trimmed_string((params._props as Record<string, unknown>)._text);
    if (props_text) return props_text;
  }

  return `New ${label} Label`;
}

function semantic_add_child_class(params: Record<string, unknown>, label: "Header" | "Footer"): string {
  if (_xu.is_plain_object(params._props)) {
    const props_class =
      semantic_trimmed_string((params._props as Record<string, unknown>).class);
    if (props_class) return props_class;
  }

  const class_location = label.toLocaleLowerCase();
  return `xvibe-generated-label xvibe-${class_location}-label`;
}

function semantic_explicit_add_child_parent_id(params: Record<string, unknown>): string | undefined {
  return semantic_read_string(params, [
    "_parent_id",
    "parent_id",
    "_target_parent_id",
    "target_parent_id",
    "_container_id",
    "container_id",
  ]);
}

function semantic_raw_target_id(params: Record<string, unknown>): string | undefined {
  return semantic_read_string(params, [
    "_target_id",
    "target_id",
  ]);
}

function semantic_add_child_component_type(params: Record<string, unknown>): string | undefined {
  return semantic_normalize_component_type(
    params._component_type ??
    params.component_type ??
    params._target_type ??
    params.target_type ??
    params._child_type ??
    params.child_type,
  );
}

function semantic_is_root_add_child_alias(value: string, view_id: string): boolean {
  return value === view_id || value === "main";
}

function semantic_is_generated_child_id_hint(input: {
  _id: string;
  _view_id: string;
  _params: Record<string, unknown>;
}): boolean {
  const id_key = semantic_alias_key(input._id);
  const view_key = semantic_alias_key(input._view_id);

  if (view_key && id_key.startsWith(`${view_key}-`)) return true;
  if (id_key.startsWith("main-")) return true;

  return false;
}

function semantic_should_root_target_win_for_add_child(input: {
  _params: Record<string, unknown>;
  _view_id: string | undefined;
  _raw_target_id: string | undefined;
  _explicit_parent_id: string | undefined;
}): boolean {
  if (!input._view_id) return false;
  if (semantic_trimmed_string(input._params._edit_action) !== "add-child") {
    return false;
  }
  if (!semantic_is_semantic_view_add_child(input._params)) return false;
  if (!semantic_can_fill_root_add_child_target(input._params)) return false;

  const component_type =
    semantic_add_child_component_type(input._params);
  if (component_type !== "label") return false;

  const raw_target_id = input._raw_target_id;
  if (raw_target_id && semantic_is_root_add_child_alias(raw_target_id, input._view_id)) {
    return true;
  }

  const explicit_parent_id = input._explicit_parent_id;
  if (!explicit_parent_id) {
    return raw_target_id
      ? semantic_is_generated_child_id_hint({
        _id: raw_target_id,
        _view_id: input._view_id,
        _params: input._params,
      })
      : true;
  }
  if (semantic_is_root_add_child_alias(explicit_parent_id, input._view_id)) {
    return true;
  }
  if (raw_target_id && explicit_parent_id === raw_target_id) {
    return semantic_is_generated_child_id_hint({
      _id: raw_target_id,
      _view_id: input._view_id,
      _params: input._params,
    });
  }
  if (!raw_target_id) {
    return semantic_is_generated_child_id_hint({
      _id: explicit_parent_id,
      _view_id: input._view_id,
      _params: input._params,
    });
  }

  return false;
}

function semantic_synthesize_simple_child(
  params: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const component_type =
    semantic_add_child_component_type(params);
  if (component_type !== "label") {
    return undefined;
  }

  const label = semantic_add_child_location_label(params._location ?? params.location);
  const child_id =
    semantic_read_string(params, [
      "_child_id",
      "child_id",
      "_new_object_id",
      "new_object_id",
      "_object_id",
      "object_id",
    ]);
  return {
    ...(child_id ? { _id: child_id } : {}),
    _type: "label",
    _text: semantic_add_child_text(params, label),
    class: semantic_add_child_class(params, label),
  };
}

function semantic_view_edit_non_executable_reason(
  params: Record<string, unknown>,
): string | null {
  if (!semantic_trimmed_string(params._app_id)) return "missing_app_id";
  if (!semantic_trimmed_string(params._env)) return "missing_env";
  const semantic_non_executable_reason =
    semantic_trimmed_string(params._semantic_non_executable_reason);
  if (semantic_non_executable_reason) return semantic_non_executable_reason;
  if (!semantic_trimmed_string(params._view_id)) return "missing_view_id";

  const edit_action =
    semantic_trimmed_string(params._edit_action);
  if (_xu.is_plain_object(params._edit_action)) return "invalid_edit_action";
  if (!edit_action) return "missing_edit_action";

  const structured_action_error =
    semantic_structured_view_edit_action_error(edit_action);
  if (structured_action_error) return structured_action_error;

  const style_contract_error =
    semantic_style_contract_error(params, edit_action);
  if (style_contract_error) return style_contract_error;

  if (
    edit_action !== "create-toolbar" &&
    !semantic_trimmed_string(params._target_id)
  ) {
    return "missing_target_id";
  }

  if (edit_action === "add-child") {
    if (!_xu.is_plain_object(params._child)) {
      return "missing_child";
    }
    if (!semantic_trimmed_string(params._child._type)) {
      return "missing_child_type";
    }
  }

  return null;
}

function semantic_is_view_target_type(value: unknown): boolean {
  const target_type =
    semantic_trimmed_string(value);
  if (!target_type) return true;

  return [
    "view",
    "xview",
    "root-view",
    "current-view",
  ].includes(semantic_alias_key(target_type));
}

function semantic_is_semantic_view_add_child(
  params: Record<string, unknown>,
): boolean {
  if (semantic_trimmed_string(params._edit_action) !== "add-child") {
    return false;
  }

  if (
    semantic_trimmed_string(params._entity_name) ||
    semantic_trimmed_string(params.entity_name) ||
    semantic_trimmed_string(params._field_name) ||
    semantic_trimmed_string(params.field_name) ||
    semantic_trimmed_string(params._flow_id) ||
    semantic_trimmed_string(params.flow_id) ||
    semantic_trimmed_string(params._module_id) ||
    semantic_trimmed_string(params.module_id) ||
    semantic_trimmed_string(params._module_name) ||
    semantic_trimmed_string(params.module_name)
  ) {
    return false;
  }

  const artifact_type =
    semantic_trimmed_string(params._artifact_type ?? params.artifact_type);
  if (artifact_type && semantic_alias_key(artifact_type) !== "view") {
    return false;
  }

  return true;
}

function semantic_selected_object_container_id(
  selected_object: Record<string, unknown> | undefined,
): string | undefined {
  if (!selected_object) return undefined;

  const selected_id =
    semantic_read_string(selected_object, [
      "_json_id",
      "json_id",
      "_id",
      "id",
    ]);
  if (!selected_id) return undefined;

  if (
    Array.isArray(selected_object._children) ||
    selected_object._can_have_children === true ||
    selected_object.can_have_children === true ||
    selected_object._is_container === true ||
    selected_object.is_container === true
  ) {
    return selected_id;
  }

  return undefined;
}

function semantic_can_fill_root_add_child_target(params: Record<string, unknown>): boolean {
  const target_type =
    params._target_type ?? params.target_type;
  const target_type_value =
    semantic_trimmed_string(target_type);
  if (!target_type_value) return true;
  if (semantic_is_view_target_type(target_type)) return true;
  return semantic_normalize_component_type(target_type) === "label";
}

async function normalize_semantic_view_edit_payload(input: {
  _action: XVibeIntentAction;
  _index: number;
  _request: XVibeIntentEngineRequest;
}): Promise<SemanticViewEditPayloadNormalization> {
  const action =
    input._action as XVibeIntentAction & Record<string, unknown>;
  const normalized_fields: string[] = [];
  const runtime_context =
    input._request._runtime_context as unknown as Record<string, unknown>;
  const selected_object =
    semantic_runtime_selected_object(input._request);
  const params =
    _xu.is_plain_object(action._params)
      ? { ...(action._params as Record<string, unknown>) }
      : {};
  const raw_edit_action =
    semantic_raw_edit_action_for_log(params._edit_action);
  const raw_requested_view_id =
    semantic_read_string(params, [
      "_view_id",
      "view_id",
      "_source_view_id",
      "source_view_id",
    ]);
  _xlog.log("[xvibe] semantic raw action", {
    _action_type: action._action_type,
    _raw_edit_action: raw_edit_action,
    _requested_view_id: raw_requested_view_id,
    _target_id: semantic_raw_target_id(params),
    _target_type: semantic_read_string(params, [
      "_target_type",
      "target_type",
    ]),
  });

  const action_id =
    semantic_trimmed_string(action._id) ??
    `action-${input._index + 1}`;
  if (action._id !== action_id) {
    normalized_fields.push(`_actions[${input._index}]._id`);
  }

  const app_id =
    semantic_trimmed_string(params._app_id) ??
    semantic_trimmed_string(runtime_context._app_id);
  if (app_id && params._app_id !== app_id) {
    params._app_id = app_id;
    normalized_fields.push(`_actions[${input._index}]._params._app_id`);
  }

  const env =
    semantic_trimmed_string(params._env) ??
    semantic_trimmed_string(runtime_context._env);
  if (env && params._env !== env) {
    params._env = env;
    normalized_fields.push(`_actions[${input._index}]._params._env`);
  }

  const current_view_id =
    semantic_runtime_current_view_id(input._request);
  const requested_view_id =
    semantic_read_string(params, [
      "_view_id",
      "view_id",
      "_source_view_id",
      "source_view_id",
    ]) ??
    current_view_id;
  let view_id = requested_view_id;
  const view_resolution =
    resolveProjectViewId({
      app_id,
      env,
      requested_view_id,
      current_view_id,
      available_views: semantic_runtime_available_view_ids(input._request),
      target_id: semantic_raw_target_id(params),
      target_text: semantic_read_string(params, [
        "_target_text",
        "target_text",
        "_target_id",
        "target_id",
      ]),
    });
  if (view_resolution._ok) {
    view_id = view_resolution._view_id;
    if (params._semantic_non_executable_reason === "view_not_found") {
      delete params._semantic_non_executable_reason;
      normalized_fields.push(`_actions[${input._index}]._params._semantic_non_executable_reason`);
    }
    _xlog.log("[xvibe] semantic view resolved", {
      _requested_view_id: requested_view_id,
      _resolved_view_id: view_id,
      _strategy: view_resolution._strategy,
    });
  } else if (requested_view_id) {
    params._semantic_non_executable_reason = "view_not_found";
    normalized_fields.push(`_actions[${input._index}]._params._semantic_non_executable_reason`);
  }

  if (view_id && params._view_id !== view_id) {
    params._view_id = view_id;
    normalized_fields.push(`_actions[${input._index}]._params._view_id`);
  }

  const canonical_view_edit =
    canonicalizeSemanticViewEditParams(params);
  for (const normalized_field of canonical_view_edit._normalized_fields) {
    normalized_fields.push(`_actions[${input._index}]._params.${normalized_field}`);
  }
  Object.keys(params).forEach((key) => {
    delete params[key];
  });
  Object.assign(params, canonical_view_edit._params);
  const canonical_style_summary =
    semantic_style_log_summary(params);
  _xlog.log("[xvibe] semantic action canonicalized", {
    _raw_edit_action: raw_edit_action,
    _canonical_edit_action: semantic_trimmed_string(params._edit_action),
    _style_count: canonical_style_summary._style_count,
    _style_properties: canonical_style_summary._style_properties,
    _changes: canonical_view_edit._normalized_fields,
  });

  for (const normalized_field of semantic_normalize_add_object_props(params)) {
    normalized_fields.push(`_actions[${input._index}]._params.${normalized_field}`);
  }
  for (const normalized_field of semantic_normalize_add_child_alternate_fields(params)) {
    normalized_fields.push(`_actions[${input._index}]._params.${normalized_field}`);
  }

  const explicit_target_type =
    semantic_read_string(params, [
      "_target_type",
      "target_type",
    ]);
  const target_type =
    explicit_target_type ??
    semantic_read_string(params, [
      "_target_type",
      "target_type",
      "_parent_type",
      "parent_type",
    ]) ??
    (selected_object
      ? semantic_read_string(selected_object, ["_type", "type"])
      : undefined);
  if (target_type && params._target_type !== target_type) {
    params._target_type = target_type;
    normalized_fields.push(`_actions[${input._index}]._params._target_type`);
  }

  const is_semantic_view_add_child =
    semantic_is_semantic_view_add_child(params);
  const is_semantic_create_toolbar =
    semantic_trimmed_string(params._edit_action) === "create-toolbar";
  const raw_target_id =
    semantic_raw_target_id(params);
  const explicit_parent_id =
    semantic_explicit_add_child_parent_id(params);
  let target_id =
    explicit_parent_id ??
    raw_target_id;
  if (
    semantic_should_root_target_win_for_add_child({
      _params: params,
      _view_id: view_id,
      _raw_target_id: raw_target_id,
      _explicit_parent_id: explicit_parent_id,
    })
  ) {
    const child_id =
      raw_target_id && !semantic_is_root_add_child_alias(raw_target_id, view_id as string)
        ? raw_target_id
        : explicit_parent_id && !semantic_is_root_add_child_alias(explicit_parent_id, view_id as string)
          ? explicit_parent_id
          : undefined;
    if (child_id && !semantic_trimmed_string(params._child_id)) {
      params._child_id = child_id;
      normalized_fields.push(`_actions[${input._index}]._params._child_id`);
    }
    target_id = view_id;
    _xlog.log("[xvibe] semantic action target resolved", {
      _strategy: "root-view",
      _target_id: target_id,
    });
  }
  if (!target_id && view_id && is_semantic_create_toolbar) {
    target_id = view_id;
    if (!semantic_trimmed_string(params._target_type)) {
      params._target_type = "view";
      normalized_fields.push(`_actions[${input._index}]._params._target_type`);
    }
    _xlog.log("[xvibe] semantic action target resolved", {
      _strategy: "root-view",
      _target_id: target_id,
    });
  }
  if (!target_id && selected_object && !is_semantic_view_add_child) {
    target_id =
      semantic_read_string(selected_object, [
        "_json_id",
        "json_id",
        "_id",
        "id",
      ]);
  }
  if (
    !target_id &&
    view_id &&
    is_semantic_view_add_child
  ) {
    const selected_container_id =
      semantic_selected_object_container_id(selected_object);
    if (selected_container_id) {
      target_id = selected_container_id;
      _xlog.log("[xvibe] semantic action target resolved", {
        _strategy: "selected-object",
        _target_id: target_id,
      });
    } else if (semantic_can_fill_root_add_child_target(params)) {
      target_id = view_id;
      _xlog.log("[xvibe] semantic action target resolved", {
        _strategy: "root-view",
        _target_id: target_id,
      });
    }
  }
  if (target_id && params._target_id !== target_id) {
    params._target_id = target_id;
    normalized_fields.push(`_actions[${input._index}]._params._target_id`);
  }
  if (
    target_id &&
    view_id &&
    is_semantic_view_add_child &&
    params._parent_id !== target_id
  ) {
    params._parent_id = target_id;
    normalized_fields.push(`_actions[${input._index}]._params._parent_id`);
  }

  if (semantic_trimmed_string(params._edit_action) === "add-child") {
    const child =
      semantic_view_edit_child_value(params) ??
      semantic_synthesize_simple_child(params) ??
      semantic_synthesize_section_child({
        _params: params,
        _request: input._request,
        _explicit_target_type: explicit_target_type,
      });
    if (child) {
      params._child = child;
      normalized_fields.push(`_actions[${input._index}]._params._child`);
    }
  }

  let non_executable_reason =
    semantic_view_edit_non_executable_reason(params);
  if (non_executable_reason === null) {
    const preflight =
      await preflightSemanticViewEdit({
        app_id,
        env,
        current_view_id,
        available_views: semantic_runtime_available_view_ids(input._request),
        current_view: semantic_runtime_current_view(input._request),
        prompt: input._request._message,
        params,
      });
    for (const normalized_field of preflight._normalized_fields) {
      normalized_fields.push(`_actions[${input._index}]._params.${normalized_field}`);
    }
    Object.keys(params).forEach((key) => {
      delete params[key];
    });
    Object.assign(params, preflight._params);
    non_executable_reason =
      preflight._ok
        ? semantic_view_edit_non_executable_reason(params)
        : preflight._reason;
  }
  if (
    non_executable_reason === null &&
    !isStructuredViewEditAction(params._edit_action)
  ) {
    non_executable_reason = "unsupported_edit_action";
  }
  if (Object.prototype.hasOwnProperty.call(params, "_semantic_non_executable_reason")) {
    delete params._semantic_non_executable_reason;
    normalized_fields.push(`_actions[${input._index}]._params._semantic_non_executable_reason`);
  }
  const executable =
    non_executable_reason === null;
  const normalized_action: Record<string, unknown> = {
    ...action,
    _id: action_id,
    _params: params,
    _executable: executable,
    ...(executable
      ? {
        _execution_payload: {
          _module: "xvibe",
          _op: "apply-view-edit",
          _params: semantic_clone_json_object(params),
        },
      }
      : {
        _non_executable_reason: non_executable_reason,
        _requires_approval: false,
      }),
  };

  if (executable) {
    delete normalized_action._non_executable_reason;
  } else {
    delete normalized_action._execution_payload;
  }

  normalized_fields.push(`_actions[${input._index}]._executable`);
  if (executable) {
    normalized_fields.push(`_actions[${input._index}]._execution_payload`);
  } else {
    normalized_fields.push(`_actions[${input._index}]._non_executable_reason`);
    normalized_fields.push(`_actions[${input._index}]._requires_approval`);
  }

  _xlog.log("[xvibe] semantic action finalized", {
    _canonical_edit_action: semantic_trimmed_string(params._edit_action),
    _executable: executable,
    ...(non_executable_reason
      ? { _non_executable_reason: non_executable_reason }
      : {}),
    _has_execution_payload: executable,
  });

  return {
    _action: normalized_action as unknown as XVibeIntentAction,
    _normalized_fields: normalized_fields,
  };
}

function semantic_action_type_edit_action(
  action_type: unknown,
): NormalizedValue<string> | null {
  if (typeof action_type !== "string") {
    return null;
  }

  return normalize_view_edit_action(action_type);
}

function semantic_missing_or_empty_string(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" && value.trim().length === 0)
  );
}

function normalize_semantic_action(
  value: unknown,
  index: number,
): { _action: XVibeIntentAction; _normalized_fields: string[] } | null {
  if (!_xu.is_plain_object(value)) {
    return null;
  }

  const action = value as Record<string, unknown>;
  const normalized_fields: string[] = [];
  const action_type =
    normalize_contract_value(
      action._action_type,
      ACTION_TYPES,
      ACTION_TYPE_ALIASES,
    );
  if (!action_type) {
    return null;
  }
  if (action_type._normalized) {
    _xlog.log("[xvibe] semantic action alias", {
      _received_action_type:
        typeof action._action_type === "string"
          ? action._action_type
          : "",
      _normalized_action_type: action_type._value,
    });
    normalized_fields.push(`_actions[${index}]._action_type`);
  }
  const is_apply_view_edit =
    action_type._value === "apply-view-edit";

  const status =
    is_apply_view_edit && semantic_missing_or_empty_string(action._status)
      ? {
        _value: "suggested" as const,
        _normalized: true,
      }
      : normalize_contract_value(
        action._status,
        ACTION_STATUSES,
        ACTION_STATUS_ALIASES,
      );
  if (!status) {
    return null;
  }
  if (status._normalized) {
    normalized_fields.push(`_actions[${index}]._status`);
  }

  const normalized_action: Record<string, unknown> = {
    ...action,
    _action_type: action_type._value,
    _status: status._value,
  };

  if (
    is_apply_view_edit &&
    normalized_action._requires_approval === undefined
  ) {
    normalized_action._requires_approval = true;
    normalized_fields.push(`_actions[${index}]._requires_approval`);
  }

  const edit_action =
    is_apply_view_edit
      ? semantic_action_type_edit_action(action._action_type)
      : null;
  if (edit_action) {
    const params = _xu.is_plain_object(action._params)
      ? {
        ...(action._params as Record<string, unknown>),
      }
      : {};
    if (params._edit_action === undefined) {
      params._edit_action = edit_action._value;
      normalized_fields.push(`_actions[${index}]._params._edit_action`);
    }
    normalized_action._params = params;
  }

  if (
    is_apply_view_edit &&
    _xu.is_plain_object(normalized_action._params)
  ) {
    const params =
      normalized_action._params as Record<string, unknown>;
    const edit_action_param =
      normalize_view_edit_action(params._edit_action);
    if (edit_action_param && edit_action_param._normalized) {
      normalized_action._params = {
        ...params,
        _edit_action: edit_action_param._value,
      };
      normalized_fields.push(`_actions[${index}]._params._edit_action`);
    }
  }

  return {
    _action: normalized_action as unknown as XVibeIntentAction,
    _normalized_fields: normalized_fields,
  };
}

function has_apply_view_edit_action(actions: readonly XVibeIntentAction[]): boolean {
  return actions.some((action) => action._action_type === "apply-view-edit");
}

function normalize_semantic_message_type(
  value: unknown,
  actions: readonly XVibeIntentAction[],
): NormalizedValue<XVibeIntentMessageType> | null {
  if (typeof value !== "string") {
    return null;
  }

  if (
    APPLY_VIEW_EDIT_MESSAGE_TYPE_ALIASES.has(semantic_alias_key(value)) &&
    has_apply_view_edit_action(actions)
  ) {
    return {
      _value: "edit",
      _normalized: true,
    };
  }

  return normalize_contract_value(
    value,
    MESSAGE_TYPES,
    MESSAGE_TYPE_ALIASES,
  );
}

function normalize_semantic_execution_level(
  value: unknown,
  actions: readonly XVibeIntentAction[],
): NormalizedValue<XVibeIntentExecutionLevel> | null {
  if (
    typeof value === "string" &&
    has_apply_view_edit_action(actions) &&
    APPLY_VIEW_EDIT_EXECUTION_LEVEL_ALIASES.has(semantic_alias_key(value))
  ) {
    return {
      _value: "deterministic",
      _normalized: value.trim() !== "deterministic",
    };
  }

  return normalize_contract_value(
    value,
    EXECUTION_LEVELS,
    EXECUTION_LEVEL_ALIASES,
  );
}

async function normalize_semantic_intent_result(
  value: unknown,
  request: XVibeIntentEngineRequest,
): Promise<NormalizedSemanticIntent | null> {
  if (!_xu.is_plain_object(value)) {
    return null;
  }

  const result = value as Record<string, unknown>;
  const normalized_fields: string[] = [];
  if (!Array.isArray(result._actions)) {
    return null;
  }

  const actions: XVibeIntentAction[] = [];
  for (const [index, action] of result._actions.entries()) {
    const normalized_action =
      normalize_semantic_action(action, index);
    if (!normalized_action) {
      return null;
    }

    if (normalized_action._action._action_type === "apply-view-edit") {
      const payload_action =
        await normalize_semantic_view_edit_payload({
          _action: normalized_action._action,
          _index: index,
          _request: request,
        });
      actions.push(payload_action._action);
      normalized_fields.push(...payload_action._normalized_fields);
      continue;
    }

    actions.push(normalized_action._action);
    normalized_fields.push(...normalized_action._normalized_fields);
  }

  const message_type =
    normalize_semantic_message_type(result._message_type, actions);
  if (!message_type) {
    return null;
  }
  if (message_type._normalized) {
    normalized_fields.push("_message_type");
  }

  const execution_level =
    normalize_semantic_execution_level(
      result._execution_level,
      actions,
    );
  if (!execution_level) {
    return null;
  }
  if (execution_level._normalized) {
    normalized_fields.push("_execution_level");
  }

  return {
    _intent: {
      ...result,
      _message_type: message_type._value,
      _execution_level: execution_level._value,
      _actions: actions,
    } as unknown as XVibeIntentResult,
    _normalized_fields: Array.from(new Set(normalized_fields)),
  };
}

function read_semantic_intent_result(value: unknown): unknown {
  const unwrapped =
    unwrap_command_result(value);

  if (typeof unwrapped === "string") {
    return parse_json_text(unwrapped);
  }

  if (_xu.is_plain_object(unwrapped)) {
    if (typeof unwrapped._text === "string") {
      return parse_json_text(unwrapped._text);
    }

    if (_xu.is_plain_object(unwrapped._object)) {
      return unwrapped._object;
    }
  }

  return unwrapped;
}

function validate_semantic_intent_result(value: unknown): string | null {
  if (!_xu.is_plain_object(value)) {
    return "semantic intent result must be an object";
  }

  if (!MESSAGE_TYPES.includes(value._message_type as XVibeIntentMessageType)) {
    return "_message_type must be valid XVibeIntentMessageType";
  }

  if (
    !EXECUTION_LEVELS.includes(
      value._execution_level as XVibeIntentExecutionLevel,
    )
  ) {
    return "_execution_level must be valid XVibeIntentExecutionLevel";
  }

  if (typeof value._should_mutate !== "boolean") {
    return "_should_mutate must be boolean";
  }

  if (
    typeof value._confidence !== "number" ||
    !Number.isFinite(value._confidence)
  ) {
    return "_confidence must be number";
  }

  if (!Array.isArray(value._actions)) {
    return "_actions must be array";
  }

  for (const [index, action] of value._actions.entries()) {
    if (!_xu.is_plain_object(action)) {
      return `_actions[${index}] must be object`;
    }

    if (!ACTION_TYPES.includes(action._action_type as XVibeIntentActionType)) {
      return `_actions[${index}]._action_type must be valid XVibeIntentActionType`;
    }

    if (
      !ACTION_STATUSES.includes(
        action._status as XVibeIntentActionStatus,
      )
    ) {
      return `_actions[${index}]._status must be valid XVibeIntentActionStatus`;
    }
  }

  return null;
}

function semantic_normalization_error(value: unknown): string {
  if (!_xu.is_plain_object(value)) {
    return "semantic intent result must be an object";
  }

  const result = value as Record<string, unknown>;
  if (!Array.isArray(result._actions)) {
    return "_actions must be array";
  }

  const actions: XVibeIntentAction[] = [];
  for (const [index, action] of result._actions.entries()) {
    if (!_xu.is_plain_object(action)) {
      return `_actions[${index}] must be object`;
    }

    if (
      !normalize_contract_value(
        action._action_type,
        ACTION_TYPES,
        ACTION_TYPE_ALIASES,
      )
    ) {
      return `_actions[${index}]._action_type must be valid or supported alias`;
    }

    const normalized_action =
      normalize_semantic_action(action, index);
    if (normalized_action) {
      actions.push(normalized_action._action);
      continue;
    }

    if (
      !normalize_contract_value(
        action._status,
        ACTION_STATUSES,
        ACTION_STATUS_ALIASES,
      )
    ) {
      return `_actions[${index}]._status must be valid or supported alias`;
    }

    return `_actions[${index}] must be valid or supported action`;
  }

  if (!normalize_semantic_message_type(result._message_type, actions)) {
    return "_message_type must be valid or supported alias";
  }

  if (
    !normalize_semantic_execution_level(
      result._execution_level,
      actions,
    )
  ) {
    return "_execution_level must be valid or supported alias";
  }

  return "semantic intent result contains unsupported contract values";
}

function semantic_path_value(source: unknown, path: string): unknown {
  const parts =
    path.match(/[^[.\]]+/gu) ?? [];
  let current = source;

  for (const part of parts) {
    if (Array.isArray(current)) {
      const index = Number(part);
      current = Number.isInteger(index)
        ? current[index]
        : undefined;
      continue;
    }

    if (!_xu.is_plain_object(current)) {
      return undefined;
    }

    current = current[part];
  }

  return current;
}

function semantic_normalization_changes(
  before: unknown,
  after: unknown,
  fields: string[],
) {
  return fields.map((field) => ({
    _field: field,
    _before:
      semantic_log_safe_value(semantic_path_value(before, field)),
    _after:
      semantic_log_safe_value(semantic_path_value(after, field)),
  }));
}

function semantic_xai_available(): boolean {
  const get_module =
    (_x as unknown as { getModule?: (name: string) => unknown }).getModule;
  return typeof get_module === "function"
    ? Boolean(get_module.call(_x, "xai"))
    : true;
}

function semantic_provider_error_from_unknown(
  error: unknown,
): SemanticProviderFailureDiagnostics {
  if (error instanceof SemanticProviderError) {
    return error._diagnostics;
  }

  if (_xu.is_plain_object(error)) {
    return semantic_provider_diagnostics(error);
  }

  return {
    _error:
      error instanceof Error
        ? error.message
        : String(error),
  };
}

async function default_generate_json(
  input: XVibeSemanticIntentGenerateJsonInput,
): Promise<unknown> {
  return _x.execute({
    _module: "xai",
    _op: "generate",
    _params: {
      _prompt: input.prompt,
      _task: input._task,
      _capability: input._capability,
      system: input.system,
      context: input.context,
      response_format: input.response_format,
      ...(input._provider
        ? {
          _provider: input._provider,
        }
        : {}),
    },
  } as any);
}

export class SemanticIntentProcessor implements XVibeIntentProcessor {
  private readonly generate_json: XVibeSemanticIntentGenerateJson;
  private readonly uses_default_generate_json: boolean;
  private last_diagnostic_reason: string | undefined;

  constructor(options: SemanticIntentProcessorOptions = {}) {
    this.uses_default_generate_json =
      options._generate_json === undefined;
    this.generate_json =
      options._generate_json ?? default_generate_json;
  }

  _diagnostic_reason(): string | undefined {
    return this.last_diagnostic_reason;
  }

  async analyze(
    request: XVibeIntentEngineRequest,
  ): Promise<XVibeIntentResult | null> {
    this.last_diagnostic_reason = undefined;
    const enabled =
      semantic_intent_enabled();
    const provider =
      semantic_intent_provider();
    const has_xai =
      this.uses_default_generate_json
        ? semantic_xai_available()
        : true;

    _xlog.log("[xvibe] semantic processor", {
      _enabled: enabled,
      _has_xai: has_xai,
      _provider: provider ?? "default",
      _task: SEMANTIC_ROUTING_CAPABILITY,
      _capability: SEMANTIC_ROUTING_CAPABILITY,
    });

    if (!enabled) {
      this.last_diagnostic_reason = "semantic_disabled";
      _xlog.log("[xvibe] semantic disabled", {
        _enabled: enabled,
      });
      return null;
    }

    if (this.uses_default_generate_json && !has_xai) {
      _xlog.warn("[xvibe] semantic xai unavailable", {
        _has_xai: has_xai,
      });
    }

    const conversation_id =
      request._conversation_id ?? request._runtime_context._conversation_id;
    const context = {
      _schema: "XVibeIntentResult",
      _request: {
        _message: request._message,
        _runtime_context: request._runtime_context,
        _conversation_id: conversation_id ?? null,
      },
    };
    const generate_input = {
      prompt: [
        "Extract an XVibe intent from the request.",
        "Response schema name: XVibeIntentResult",
        "Return the XVibeIntentResult JSON object directly.",
        "Required top-level fields:",
        "- _message_type",
        "_message_type must be one of: conversation, question, inspect, edit, generate, planning, debug.",
        "Never use XVibeIntentResult as _message_type.",
        "- _execution_level",
        "_execution_level must be one of: none, deterministic, artifact, planning, model.",
        "Never use TYPED_OBJECT or TYPED_RUNTIME as _execution_level.",
        "- _should_mutate",
        "- _confidence",
        "- _reason",
        "- _actions",
        "Do not wrap the result in query, intent, object_type, or object_id.",
        "Do not execute actions.",
        "For selected-object edit intents, use an action shaped like:",
        JSON.stringify({
          _action_type: "apply-view-edit",
          _status: "suggested",
          _requires_approval: true,
          _params: {
            _view_id: "...",
            _target_id: "...",
            _target_type: "...",
            _edit_action: "hide-object",
          },
        }),
        "request._message:",
        request._message,
        "request._conversation_id:",
        conversation_id ?? "",
        "request._runtime_context:",
        JSON.stringify(request._runtime_context),
      ].join("\n"),
      system: SEMANTIC_INTENT_SYSTEM_PROMPT,
      context,
      response_format: {
        type: "json_object" as const,
      },
      _task: SEMANTIC_ROUTING_CAPABILITY,
      _capability: SEMANTIC_ROUTING_CAPABILITY,
      ...(provider
        ? {
          _provider: provider,
        }
        : {}),
    };

    _xlog.log("[xvibe] semantic request begin", {
      _provider: provider ?? "default",
      _task: SEMANTIC_ROUTING_CAPABILITY,
      _capability: SEMANTIC_ROUTING_CAPABILITY,
    });

    let raw_response: unknown;
    try {
      raw_response =
        await this.generate_json(generate_input);
    } catch (error) {
      this.last_diagnostic_reason = "semantic_provider_failed";
      _xlog.warn(
        "[xvibe] semantic provider failed",
        semantic_provider_error_from_unknown(error),
      );
      return null;
    }

    _xlog.log("[xvibe] semantic xai response received", {
      _provider: provider ?? "default",
      _has_response: raw_response !== undefined,
    });

    let result: unknown;
    try {
      result =
        read_semantic_intent_result(raw_response);
    } catch (error) {
      if (error instanceof SemanticProviderError) {
        this.last_diagnostic_reason = "semantic_provider_failed";
        _xlog.warn(
          "[xvibe] semantic provider failed",
          error._diagnostics,
        );
        return null;
      }

      if (error instanceof SemanticResponseParseError) {
        this.last_diagnostic_reason = "semantic_response_parse_failed";
        _xlog.warn("[xvibe] semantic response parse failed", {
          _error: error.message,
          _text_sample: error._text_sample,
        });
        return null;
      }

      this.last_diagnostic_reason = "semantic_response_parse_failed";
      _xlog.warn("[xvibe] semantic response parse failed", {
        _error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    const normalized_result =
      await normalize_semantic_intent_result(result, request);
    if (!normalized_result) {
      const normalization_error =
        semantic_normalization_error(result);
      this.last_diagnostic_reason = "semantic_normalization_failed";
      _xlog.warn("[xvibe] semantic normalization failed", {
        _received: semantic_log_safe_value(result),
        _reason: normalization_error,
      });
      return null;
    }

    if (normalized_result._normalized_fields.length > 0) {
      _xlog.log("[xvibe] semantic edit intent normalized", {
        _changes:
          semantic_normalization_changes(
            result,
            normalized_result._intent,
            normalized_result._normalized_fields,
          ),
      });
    }

    _xlog.log("[xvibe] semantic normalized successfully", {
      _normalized_fields: normalized_result._normalized_fields,
    });

    const validation_error =
      validate_semantic_intent_result(normalized_result._intent);
    if (validation_error) {
      this.last_diagnostic_reason = "semantic_response_validation_failed";
      _xlog.warn("[xvibe] semantic response validation failed", {
        _received: semantic_log_safe_value(result),
        _normalized: semantic_log_safe_value(normalized_result._intent),
        _validation_error: validation_error,
      });
      return null;
    }

    _xlog.log("[xvibe] semantic accepted", {
      _message_type: normalized_result._intent._message_type,
      _execution_level: normalized_result._intent._execution_level,
      _confidence: normalized_result._intent._confidence,
    });

    return normalized_result._intent;
  }
}
