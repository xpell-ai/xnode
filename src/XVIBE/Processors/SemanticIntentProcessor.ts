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
  viewedit: "apply-view-edit",
  "view-edit": "apply-view-edit",
  editview: "apply-view-edit",
  "edit-view": "apply-view-edit",
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
};

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

type NormalizedValue<T extends string> = {
  _value: T;
  _normalized: boolean;
};

type NormalizedSemanticIntent = {
  _intent: XVibeIntentResult;
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

function normalize_semantic_intent_result(
  value: unknown,
): NormalizedSemanticIntent | null {
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
      normalize_semantic_intent_result(result);
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
