import fs from "node:fs";
import path from "node:path";
import { _x, _xlog, type XCommand } from "@xpell/core";
import { _xu } from "../../XNUtils/XUtils.js";
import {
  IntentMemoryStore,
  normalize_learned_intent_prompt,
  validate_learned_intent_result,
} from "../IntentMemory/IntentMemoryStore.js";
import type { XVibeJsonObject } from "../VibeOutputParser.js";
import type {
  XVibeIntentResult,
  XVibeIntentRuntimeContext,
} from "../XVibeTypes.js";

const DEFAULT_ENV = "default";
const XVIBE_INVALID_APP_ID = "E_XVIBE_INVALID_APP_ID";
const XVIBE_INVALID_ENV = "E_XVIBE_INVALID_ENV";
const XVIBE_INVALID_CONVERSATION_ID = "E_XVIBE_INVALID_CONVERSATION_ID";
const XVIBE_CONVERSATION_NOT_FOUND = "E_XVIBE_CONVERSATION_NOT_FOUND";
const XVIBE_CONVERSATION_ALREADY_EXISTS = "E_XVIBE_CONVERSATION_ALREADY_EXISTS";
const XVIBE_INVALID_CONVERSATION_MESSAGE = "E_XVIBE_INVALID_CONVERSATION_MESSAGE";
const XVIBE_CONVERSATION_MESSAGE_NOT_FOUND = "E_XVIBE_CONVERSATION_MESSAGE_NOT_FOUND";
const XVIBE_INVALID_CONVERSATION_ACTION = "E_XVIBE_INVALID_CONVERSATION_ACTION";
const XVIBE_CONVERSATION_ACTION_NOT_FOUND = "E_XVIBE_CONVERSATION_ACTION_NOT_FOUND";
const XVIBE_INVALID_CONVERSATION_ACTION_STATUS = "E_XVIBE_INVALID_CONVERSATION_ACTION_STATUS";
const XVIBE_INVALID_CONVERSATION_ARTIFACT_STATUS = "E_XVIBE_INVALID_CONVERSATION_ARTIFACT_STATUS";
const XVIBE_INVALID_INTENT_REQUEST = "E_XVIBE_INVALID_INTENT_REQUEST";
const XVIBE_CONVERSATION_STORAGE_FAILED = "E_XVIBE_CONVERSATION_STORAGE_FAILED";
const XVIBE_CONVERSATION_LAST_MESSAGES_MAX_LIMIT = 100;
const XVIBE_CONVERSATION_ACTION_STATUSES = new Set([
  "suggested",
  "running",
  "done",
  "failed",
  "dismissed",
]);
const XVIBE_CONVERSATION_ARTIFACT_STATUSES = new Set([
  "done",
  "failed",
  "dismissed",
]);

type XVibeConversationRole = "user" | "assistant" | "system" | "tool";

type XVibeConversationActionStatus =
  | "suggested"
  | "running"
  | "done"
  | "failed"
  | "dismissed";

type XVibeConversationArtifactStatus =
  | "done"
  | "failed"
  | "dismissed";

export type XVibeConversationMessage = XVibeJsonObject & {
  _id: string;
  _role: XVibeConversationRole;
  _text: string;
  _created_at: string;
  _attachments?: unknown;
  _intent?: unknown;
  _actions?: unknown;
  _result?: unknown;
  _metadata?: unknown;
};

export type XVibeConversationDocument = XVibeJsonObject & {
  _id: string;
  _app_id: string;
  _env: string;
  _created_at: string;
  _updated_at: string;
  _message_count: number;
  _title?: string;
  _metadata?: unknown;
  _planning_draft?: unknown;
};

type XVibeConversationIndexEntry = XVibeJsonObject & {
  _id: string;
  _created_at: string;
  _updated_at: string;
  _message_count: number;
  _last_message_at?: string;
  _title?: string;
  _metadata?: unknown;
};

type XVibeConversationIndex = XVibeJsonObject & {
  _version: 1;
  _app_id: string;
  _env: string;
  _updated_at: string;
  _conversations: XVibeConversationIndexEntry[];
};

export type XVibeAnalyzeMessageRequest = {
  _app_id: string;
  _env: string;
  _conversation_id: string;
  _message: string;
  _message_id?: string;
  _runtime_context: XVibeIntentRuntimeContext;
};

class ConversationManagerError extends Error {
  readonly _payload: XVibeJsonObject;

  constructor(payload: XVibeJsonObject) {
    const message =
      _xu.is_plain_object(payload._error) && typeof payload._error._message === "string"
        ? payload._error._message
        : "XVibe conversation error";

    super(message);
    this._payload = payload;
  }
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
  throw new ConversationManagerError(explicit_error(code, message, details));
}

function structured_error_payload(error: unknown): XVibeJsonObject | undefined {
  return error instanceof ConversationManagerError
    ? error._payload
    : undefined;
}

function safe_short_id(): string {
  return Math.random().toString(36).slice(2, 10);
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

function assert_path_inside(root: string, candidate: string, code: string, message: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw_explicit_error(code, message);
  }
}

function resolve_xvibe_work_folder(): string {
  const get_module =
    (_x as unknown as { getModule?: (name: string) => unknown }).getModule;

  if (typeof get_module === "function") {
    const server_xvm =
      get_module.call(_x, "server-xvm");

    if (
      _xu.is_plain_object(server_xvm) &&
      typeof server_xvm._work_folder === "string" &&
      server_xvm._work_folder.trim().length > 0
    ) {
      return server_xvm._work_folder;
    }
  }

  return "./work";
}

function resolve_target_app_dir(env: string, app_id: string): string {
  const apps_root = path.resolve(resolve_xvibe_work_folder(), "xvm", "apps");
  const app_dir = path.resolve(apps_root, env, app_id);
  assert_path_inside(
    apps_root,
    app_dir,
    XVIBE_INVALID_APP_ID,
    "Invalid target app path",
  );

  return app_dir;
}

function resolve_conversations_dir(input: {
  _app_id: string;
  _env: string;
}): string {
  const app_dir = resolve_target_app_dir(input._env, input._app_id);
  const conversations_dir = path.resolve(app_dir, "conversations");
  assert_path_inside(
    app_dir,
    conversations_dir,
    XVIBE_INVALID_APP_ID,
    "Invalid conversations path",
  );

  return conversations_dir;
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

function conversation_index_path(conversations_dir: string): string {
  const index_path = path.resolve(conversations_dir, "index.json");
  assert_path_inside(
    conversations_dir,
    index_path,
    XVIBE_CONVERSATION_STORAGE_FAILED,
    "Invalid conversation index path",
  );

  return index_path;
}

function conversation_dir_path(conversations_dir: string, conversation_id: string): string {
  const conversation_dir = path.resolve(conversations_dir, conversation_id);
  assert_path_inside(
    conversations_dir,
    conversation_dir,
    XVIBE_INVALID_CONVERSATION_ID,
    "Invalid conversation path",
  );

  return conversation_dir;
}

function normalize_safe_conversation_id(value: unknown): string {
  if (value === undefined || value === null) {
    return `conv-${safe_short_id()}`;
  }

  return read_safe_path_segment(
    value,
    "_conversation_id",
    XVIBE_INVALID_CONVERSATION_ID,
  );
}

function is_json_compatible_value(value: unknown): boolean {
  if (value === null) return true;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return Number.isFinite(value as number) || typeof value !== "number";
  }
  if (Array.isArray(value)) {
    return value.every((item) => item !== undefined && is_json_compatible_value(item));
  }
  if (_xu.is_plain_object(value)) {
    return Object.values(value).every((item) => item !== undefined && is_json_compatible_value(item));
  }

  return false;
}

function read_optional_json_value(
  value: unknown,
  field_name: string,
  code = XVIBE_INVALID_CONVERSATION_MESSAGE,
): unknown {
  if (value === undefined) return undefined;
  if (!is_json_compatible_value(value)) {
    throw_explicit_error(
      code,
      `Invalid '${field_name}': expected JSON-compatible value`,
    );
  }

  return value;
}

function read_optional_json_object(
  value: unknown,
  field_name: string,
  code: string,
): XVibeJsonObject | undefined {
  if (value === undefined) return undefined;
  if (!_xu.is_plain_object(value) || !is_json_compatible_value(value)) {
    throw_explicit_error(
      code,
      `Invalid '${field_name}': expected JSON-compatible object`,
    );
  }

  return value as XVibeJsonObject;
}

function read_optional_conversation_action_error(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw_explicit_error(
      XVIBE_INVALID_CONVERSATION_ACTION,
      "Invalid '_error': expected string",
    );
  }

  return value;
}

function read_conversation_action_status(value: unknown): XVibeConversationActionStatus {
  if (
    typeof value !== "string" ||
    !XVIBE_CONVERSATION_ACTION_STATUSES.has(value)
  ) {
    throw_explicit_error(
      XVIBE_INVALID_CONVERSATION_ACTION_STATUS,
      "Invalid '_status': expected suggested, running, done, failed, or dismissed",
    );
  }

  return value as XVibeConversationActionStatus;
}

function read_conversation_artifact_status(value: unknown): XVibeConversationArtifactStatus {
  if (
    typeof value !== "string" ||
    !XVIBE_CONVERSATION_ARTIFACT_STATUSES.has(value)
  ) {
    throw_explicit_error(
      XVIBE_INVALID_CONVERSATION_ARTIFACT_STATUS,
      "Invalid '_artifact_status': expected done, failed, or dismissed",
    );
  }

  return value as XVibeConversationArtifactStatus;
}

function json_compatible_deep_equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null) return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((item, index) =>
      json_compatible_deep_equal(item, right[index]));
  }
  if (_xu.is_plain_object(left) || _xu.is_plain_object(right)) {
    if (!_xu.is_plain_object(left) || !_xu.is_plain_object(right)) return false;
    const left_keys = Object.keys(left).sort();
    const right_keys = Object.keys(right).sort();
    if (!json_compatible_deep_equal(left_keys, right_keys)) return false;
    return left_keys.every((key) =>
      json_compatible_deep_equal(left[key], right[key]));
  }

  return false;
}

function mutation_plan_step_ids_for_identity(value: unknown): string[] | undefined {
  if (!_xu.is_plain_object(value) || value._type !== "mutation-plan" || !Array.isArray(value._steps)) {
    return undefined;
  }

  const ids: string[] = [];
  for (const step of value._steps) {
    if (!_xu.is_plain_object(step) || typeof step._id !== "string" || !step._id.trim()) {
      return undefined;
    }
    ids.push(step._id.trim());
  }

  return ids;
}

function mutation_plan_request_identity_matches(
  expected: XVibeJsonObject,
  actual: unknown,
): boolean {
  if (!_xu.is_plain_object(actual)) return false;
  if (actual._type !== "mutation-plan") return false;
  const expected_ids = mutation_plan_step_ids_for_identity(expected);
  const actual_ids = mutation_plan_step_ids_for_identity(actual);
  if (!expected_ids || !actual_ids) return false;
  if (!json_compatible_deep_equal(expected_ids, actual_ids)) return false;

  for (const key of ["_title", "_goal"]) {
    if (
      typeof expected[key] === "string" &&
      typeof actual[key] === "string" &&
      expected[key] !== actual[key]
    ) {
      return false;
    }
  }

  return true;
}

function conversation_artifact_request_matches(input: {
  _artifact_type?: string;
  _expected: XVibeJsonObject;
  _actual: unknown;
}): boolean {
  if (input._artifact_type === "mutation-plan" || input._expected._type === "mutation-plan") {
    return mutation_plan_request_identity_matches(input._expected, input._actual);
  }

  return json_compatible_deep_equal(input._expected, input._actual);
}

function read_optional_conversation_artifact_error(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (_xu.is_plain_object(value) && is_json_compatible_value(value)) {
    return value;
  }

  throw_explicit_error(
    XVIBE_INVALID_CONVERSATION_MESSAGE,
    "Invalid '_artifact_error': expected string or JSON-compatible object",
  );
}

function clone_json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function read_trimmed_string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function derive_verified_learned_action_title(action: XVibeJsonObject): string {
  const title = read_trimmed_string(action._title);
  if (title) {
    return title;
  }

  const params = _xu.is_plain_object(action._params)
    ? action._params
    : {};
  switch (read_trimmed_string(params._edit_action)) {
    case "hide-object":
      return "Hide selected object";
    case "show-object":
      return "Show selected object";
    case "remove-object":
      return "Delete selected object";
    case "duplicate-object":
      return "Duplicate selected object";
    case "move-object":
      return "Move selected object";
    default:
      return "Apply view edit";
  }
}

type XVibeConversationLearningMetadata = {
  _processor?: string;
  _normalized_prompt?: string;
  _source_message_id?: string;
  _selected_type?: string;
};

type XVibeConversationLearningEligibility = {
  _processor?: string;
  _status: XVibeConversationActionStatus;
  _result_ok: boolean;
  _action_type?: string;
  _has_user_prompt: boolean;
  _selected_type?: string;
  _eligible: boolean;
  _reason: string;
  _normalized_prompt?: string;
  _intent?: XVibeIntentResult;
  _sanitized_intent?: XVibeJsonObject;
  _validation_error?: string;
};

function read_learning_metadata(
  message: XVibeConversationMessage,
): XVibeConversationLearningMetadata {
  if (!_xu.is_plain_object(message._metadata)) {
    return {};
  }

  const processor =
    typeof message._metadata._intent_processor === "string"
      ? message._metadata._intent_processor.trim()
      : undefined;
  const normalized_prompt =
    typeof message._metadata._normalized_prompt === "string"
      ? message._metadata._normalized_prompt.trim()
      : undefined;
  const source_message_id =
    typeof message._metadata._message_id === "string" &&
      message._metadata._message_id.trim().length > 0
      ? message._metadata._message_id.trim()
      : undefined;

  const selected_type =
    typeof message._metadata._selected_type === "string" &&
    message._metadata._selected_type.trim().length > 0
      ? message._metadata._selected_type.trim()
      : undefined;

  return {
    ...(processor ? { _processor: processor } : {}),
    ...(normalized_prompt ? { _normalized_prompt: normalized_prompt } : {}),
    ...(source_message_id ? { _source_message_id: source_message_id } : {}),
    ...(selected_type ? { _selected_type: selected_type } : {}),
  };
}

function resolve_learning_prompt(input: {
  _message: XVibeConversationMessage;
  _messages: XVibeConversationMessage[];
  _metadata: XVibeConversationLearningMetadata;
}): string | undefined {
  if (input._metadata._normalized_prompt) {
    return input._metadata._normalized_prompt;
  }

  if (!input._metadata._source_message_id) {
    return undefined;
  }

  const source_message =
    input._messages.find((message) =>
      message._id === input._metadata._source_message_id,
    );
  if (
    !source_message ||
    source_message._role !== "user" ||
    typeof source_message._text !== "string"
  ) {
    return undefined;
  }

  const normalized_prompt =
    normalize_learned_intent_prompt(source_message._text);
  return normalized_prompt || undefined;
}

function sanitize_verified_learned_intent(
  intent: XVibeJsonObject,
  action: XVibeJsonObject,
): XVibeJsonObject {
  const action_id = read_trimmed_string(action._id);
  const title = derive_verified_learned_action_title(action);
  const description = read_trimmed_string(action._description);
  const action_reason = read_trimmed_string(action._reason);
  const action_params =
    _xu.is_plain_object(action._params)
      ? clone_json(action._params)
      : undefined;
  if (_xu.is_plain_object(action_params)) {
    delete action_params._app_id;
    delete action_params._env;
  }
  const sanitized_action: XVibeJsonObject = {
    ...(action_id ? { _id: action_id } : {}),
    _title: title,
    ...(description ? { _description: description } : {}),
    _action_type: "apply-view-edit",
    _status: "suggested",
    ...(action_params ? { _params: action_params } : {}),
    _requires_approval: true,
    ...(action_reason ? { _reason: action_reason } : {}),
  };

  const reason = read_trimmed_string(intent._reason);
  return {
    _message_type: "edit",
    _execution_level: "deterministic",
    _should_mutate: true,
    ...(typeof intent._confidence === "number" &&
      Number.isFinite(intent._confidence)
      ? { _confidence: intent._confidence }
      : {}),
    _reason: reason ?? "verified_semantic_apply_view_edit",
    _actions: [sanitized_action],
    ...(Array.isArray(intent._warnings) &&
      intent._warnings.every((warning) => typeof warning === "string")
      ? { _warnings: [...intent._warnings] as string[] }
      : {}),
  };
}

function evaluate_learning_eligibility(input: {
  _app_id: string;
  _env: string;
  _message: XVibeConversationMessage;
  _messages: XVibeConversationMessage[];
  _intent: XVibeJsonObject | undefined;
  _action: XVibeJsonObject;
  _status: XVibeConversationActionStatus;
}): XVibeConversationLearningEligibility {
  const metadata = read_learning_metadata(input._message);
  const action_type =
    typeof input._action._action_type === "string"
      ? input._action._action_type
      : undefined;
  const result_ok =
    _xu.is_plain_object(input._action._result) &&
    input._action._result._ok === true;
  const normalized_prompt =
    resolve_learning_prompt({
      _message: input._message,
      _messages: input._messages,
      _metadata: metadata,
    });
  const base = {
    ...(metadata._processor ? { _processor: metadata._processor } : {}),
    _status: input._status,
    _result_ok: result_ok,
    ...(action_type ? { _action_type: action_type } : {}),
    _has_user_prompt: normalized_prompt !== undefined,
    ...(metadata._selected_type ? { _selected_type: metadata._selected_type } : {}),
  };

  if (metadata._processor !== "SemanticIntentProcessor") {
    return {
      ...base,
      _eligible: false,
      _reason: metadata._processor
        ? "processor_not_semantic"
        : "missing_processor",
    };
  }

  if (input._status !== "done") {
    return {
      ...base,
      _eligible: false,
      _reason: "status_not_done",
    };
  }

  if (!result_ok) {
    return {
      ...base,
      _eligible: false,
      _reason: "result_not_ok",
    };
  }

  if (action_type !== "apply-view-edit") {
    return {
      ...base,
      _eligible: false,
      _reason: "action_type_not_apply_view_edit",
    };
  }

  if (!normalized_prompt) {
    return {
      ...base,
      _eligible: false,
      _reason: "missing_user_prompt",
    };
  }

  if (!input._intent) {
    return {
      ...base,
      _eligible: false,
      _reason: "missing_intent",
    };
  }

  const intent =
    sanitize_verified_learned_intent(input._intent, input._action);
  const validation = validate_learned_intent_result(intent);
  if (!validation._ok) {
    return {
      ...base,
      _eligible: false,
      _reason: "invalid_intent",
      _sanitized_intent: intent,
      _validation_error: validation._validation_error,
    };
  }

  return {
    ...base,
    _eligible: true,
    _reason: "eligible",
    _normalized_prompt: normalized_prompt,
    _intent: intent as unknown as XVibeIntentResult,
  };
}

async function learn_verified_conversation_action(input: {
  _app_id: string;
  _env: string;
  _message: XVibeConversationMessage;
  _messages: XVibeConversationMessage[];
  _intent: XVibeJsonObject | undefined;
  _action: XVibeJsonObject;
  _status: XVibeConversationActionStatus;
}): Promise<void> {
  const eligibility = evaluate_learning_eligibility(input);
  _xlog.log("[xvibe] learned intent eligibility", {
    _processor: eligibility._processor,
    _status: eligibility._status,
    _result_ok: eligibility._result_ok,
    _action_type: eligibility._action_type,
    _has_user_prompt: eligibility._has_user_prompt,
    _selected_type: eligibility._selected_type,
    _eligible: eligibility._eligible,
    _reason: eligibility._reason,
  });

  if (eligibility._reason === "invalid_intent") {
    _xlog.warn("[xvibe] learned intent invalid", {
      _validation_error: eligibility._validation_error,
      _sanitized_intent: eligibility._sanitized_intent,
    });
  }

  if (
    !eligibility._eligible ||
    !eligibility._normalized_prompt ||
    !eligibility._intent
  ) {
    return;
  }

  const learn_result =
    await new IntentMemoryStore().learn({
      _app_id: input._app_id,
      _env: input._env,
      _normalized_prompt: eligibility._normalized_prompt,
      ...(eligibility._selected_type
        ? { _selected_type: eligibility._selected_type }
        : {}),
      _intent: eligibility._intent,
      _source: "semantic",
      _verified: true,
    });

  if (!learn_result._ok) {
    _xlog.warn("[xvibe] learned intent store skipped", {
      _app_id: input._app_id,
      _env: input._env,
      _reason: learn_result._reason,
    });
  }
}

function read_conversation_index(
  conversations_dir: string,
  app_id: string,
  env: string,
): XVibeConversationIndex {
  const index_file = conversation_index_path(conversations_dir);
  if (!fs.existsSync(index_file)) {
    return {
      _version: 1,
      _app_id: app_id,
      _env: env,
      _updated_at: new Date().toISOString(),
      _conversations: [],
    };
  }

  const parsed =
    read_json_object_file(
      index_file,
      XVIBE_CONVERSATION_STORAGE_FAILED,
      "Conversation index is invalid",
    );
  const conversations =
    Array.isArray(parsed._conversations)
      ? parsed._conversations.filter((item) => _xu.is_plain_object(item)) as XVibeConversationIndexEntry[]
      : [];

  return {
    _version: 1,
    _app_id: typeof parsed._app_id === "string" ? parsed._app_id : app_id,
    _env: typeof parsed._env === "string" ? parsed._env : env,
    _updated_at:
      typeof parsed._updated_at === "string"
        ? parsed._updated_at
        : new Date().toISOString(),
    _conversations: conversations,
  };
}

function write_conversation_index(
  conversations_dir: string,
  index: XVibeConversationIndex,
): void {
  fs.mkdirSync(conversations_dir, { recursive: true });
  const index_path = conversation_index_path(conversations_dir);
  const temp_path = path.resolve(
    conversations_dir,
    `.index.${Date.now()}-${safe_short_id()}.tmp`,
  );
  assert_path_inside(
    conversations_dir,
    temp_path,
    XVIBE_CONVERSATION_STORAGE_FAILED,
    "Invalid conversation index temp path",
  );
  fs.writeFileSync(temp_path, `${JSON.stringify(index, null, 2)}\n`, "utf-8");
  fs.renameSync(temp_path, index_path);
}

function read_conversation_index_safe(
  conversations_dir: string,
  app_id: string,
  env: string,
): { _index: XVibeConversationIndex; _recovered: boolean; _error?: string } {
  try {
    return {
      _index: read_conversation_index(conversations_dir, app_id, env),
      _recovered: false,
    };
  } catch (error) {
    return {
      _index: {
        _version: 1,
        _app_id: app_id,
        _env: env,
        _updated_at: new Date().toISOString(),
        _conversations: [],
      },
      _recovered: true,
      _error: error instanceof Error ? error.message : String(error),
    };
  }
}

function conversation_index_entry(
  conversation: XVibeConversationDocument,
): XVibeConversationIndexEntry {
  return {
    _id: conversation._id,
    _created_at: conversation._created_at,
    _updated_at: conversation._updated_at,
    _message_count: conversation._message_count,
    ...(typeof conversation._last_message_at === "string"
      ? { _last_message_at: conversation._last_message_at }
      : {}),
    ...(typeof conversation._title === "string" ? { _title: conversation._title } : {}),
    ...(conversation._metadata !== undefined ? { _metadata: conversation._metadata } : {}),
  };
}

function upsert_conversation_index_entry(
  index: XVibeConversationIndex,
  conversation: XVibeConversationDocument,
): XVibeConversationIndex {
  const entry = conversation_index_entry(conversation);
  const entries =
    index._conversations.filter((item) => item._id !== conversation._id);
  entries.push(entry);
  entries.sort((a, b) => String(b._updated_at).localeCompare(String(a._updated_at)));

  return {
    ...index,
    _updated_at: conversation._updated_at,
    _conversations: entries,
  };
}

function read_conversation_document(
  conversation_dir: string,
): XVibeConversationDocument {
  const conversation =
    read_json_object_file(
      path.join(conversation_dir, "conversation.json"),
      XVIBE_CONVERSATION_NOT_FOUND,
      "Conversation not found",
    );

  if (
    typeof conversation._id !== "string" ||
    typeof conversation._app_id !== "string" ||
    typeof conversation._env !== "string" ||
    typeof conversation._created_at !== "string" ||
    typeof conversation._updated_at !== "string" ||
    typeof conversation._message_count !== "number"
  ) {
    throw_explicit_error(
      XVIBE_CONVERSATION_STORAGE_FAILED,
      "Conversation file is invalid",
    );
  }

  return conversation as XVibeConversationDocument;
}

function write_conversation_document_with_index(input: {
  _conversations_dir: string;
  _conversation_dir: string;
  _conversation: XVibeConversationDocument;
}): void {
  write_json_object_file(
    path.join(input._conversation_dir, "conversation.json"),
    input._conversation,
  );
  write_conversation_index(
    input._conversations_dir,
    upsert_conversation_index_entry(
      read_conversation_index(
        input._conversations_dir,
        input._conversation._app_id,
        input._conversation._env,
      ),
      input._conversation,
    ),
  );
}

function read_conversation_messages(
  conversation_dir: string,
): XVibeConversationMessage[] {
  const messages_file = path.join(conversation_dir, "messages.jsonl");
  if (!fs.existsSync(messages_file)) {
    return [];
  }

  const content = fs.readFileSync(messages_file, "utf-8");
  return content
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as XVibeConversationMessage);
}

function write_conversation_messages(
  conversation_dir: string,
  messages: XVibeConversationMessage[],
): void {
  const messages_file = path.resolve(conversation_dir, "messages.jsonl");
  assert_path_inside(
    conversation_dir,
    messages_file,
    XVIBE_CONVERSATION_STORAGE_FAILED,
    "Invalid conversation messages path",
  );

  const temp_path = path.resolve(
    conversation_dir,
    `.messages.${Date.now()}-${safe_short_id()}.jsonl.tmp`,
  );
  assert_path_inside(
    conversation_dir,
    temp_path,
    XVIBE_CONVERSATION_STORAGE_FAILED,
    "Invalid conversation messages temp path",
  );

  const content =
    messages.length > 0
      ? `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`
      : "";
  fs.writeFileSync(temp_path, content, "utf-8");
  fs.renameSync(temp_path, messages_file);
}

function normalize_conversation_message(value: unknown): XVibeConversationMessage {
  const source = _xu.is_plain_object(value) ? value : {};
  const role = source._role;
  if (
    role !== "user" &&
    role !== "assistant" &&
    role !== "system" &&
    role !== "tool"
  ) {
    throw_explicit_error(
      XVIBE_INVALID_CONVERSATION_MESSAGE,
      "Invalid '_role': expected user, assistant, system, or tool",
    );
  }

  if (typeof source._text !== "string") {
    throw_explicit_error(
      XVIBE_INVALID_CONVERSATION_MESSAGE,
      "Invalid '_text': expected string",
    );
  }

  const created_at =
    typeof source._created_at === "string" && source._created_at.trim()
      ? source._created_at.trim()
      : new Date().toISOString();
  const id =
    typeof source._id === "string" && source._id.trim()
      ? read_safe_path_segment(source._id, "_id", XVIBE_INVALID_CONVERSATION_MESSAGE)
      : `msg-${safe_short_id()}`;

  return {
    _id: id,
    _role: role,
    _text: source._text,
    _created_at: created_at,
    ...(source._attachments !== undefined
      ? { _attachments: read_optional_json_value(source._attachments, "_attachments") }
      : {}),
    ...(source._intent !== undefined
      ? { _intent: read_optional_json_value(source._intent, "_intent") }
      : {}),
    ...(source._actions !== undefined
      ? { _actions: read_optional_json_value(source._actions, "_actions") }
      : {}),
    ...(source._result !== undefined
      ? { _result: read_optional_json_value(source._result, "_result") }
      : {}),
    ...(source._metadata !== undefined
      ? { _metadata: read_optional_json_value(source._metadata, "_metadata") }
      : {}),
  };
}

function read_optional_intent_context_string(
  value: unknown,
  field_name: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw_explicit_error(
      XVIBE_INVALID_INTENT_REQUEST,
      `Invalid '${field_name}': expected non-empty string`,
    );
  }

  return value.trim();
}

function read_optional_intent_context_string_array(
  value: unknown,
  field_name: string,
): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw_explicit_error(
      XVIBE_INVALID_INTENT_REQUEST,
      `Invalid '${field_name}': expected string array`,
    );
  }

  return value.map((item) => {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw_explicit_error(
        XVIBE_INVALID_INTENT_REQUEST,
        `Invalid '${field_name}': expected string array`,
      );
    }

    return item.trim();
  });
}

function normalize_analyze_message_runtime_context(input: {
  _app_id: string;
  _env: string;
  _conversation_id: string;
  _runtime_context?: unknown;
}): XVibeIntentRuntimeContext {
  const context: XVibeIntentRuntimeContext = {
    _app_id: input._app_id,
    _env: input._env,
    _conversation_id: input._conversation_id,
  };

  if (input._runtime_context === undefined || input._runtime_context === null) {
    return context;
  }

  if (!_xu.is_plain_object(input._runtime_context)) {
    throw_explicit_error(
      XVIBE_INVALID_INTENT_REQUEST,
      "Invalid '_runtime_context': expected object",
    );
  }

  const active_view_id =
    read_optional_intent_context_string(
      input._runtime_context._active_view_id,
      "_runtime_context._active_view_id",
    );
  if (active_view_id) {
    context._active_view_id = active_view_id;
  }

  const stage =
    read_optional_intent_context_string(
      input._runtime_context._stage,
      "_runtime_context._stage",
    );
  if (
    stage === "planning" ||
    stage === "building" ||
    stage === "review" ||
    stage === "completed"
  ) {
    context._stage = stage;
  } else if (stage) {
    throw_explicit_error(
      XVIBE_INVALID_INTENT_REQUEST,
      "Invalid '_runtime_context._stage': expected planning, building, review, or completed",
    );
  }

  if (input._runtime_context._selected_object !== undefined) {
    if (!_xu.is_plain_object(input._runtime_context._selected_object)) {
      throw_explicit_error(
        XVIBE_INVALID_INTENT_REQUEST,
        "Invalid '_runtime_context._selected_object': expected object",
      );
    }

    context._selected_object = read_optional_json_value(
      input._runtime_context._selected_object,
      "_runtime_context._selected_object",
      XVIBE_INVALID_INTENT_REQUEST,
    ) as Record<string, any>;
  }

  if (input._runtime_context._current_artifact !== undefined) {
    if (!_xu.is_plain_object(input._runtime_context._current_artifact)) {
      throw_explicit_error(
        XVIBE_INVALID_INTENT_REQUEST,
        "Invalid '_runtime_context._current_artifact': expected object",
      );
    }

    context._current_artifact =
      read_optional_json_value(
        input._runtime_context._current_artifact,
        "_runtime_context._current_artifact",
        XVIBE_INVALID_INTENT_REQUEST,
      ) as Record<string, any>;
  }

  if (input._runtime_context._current_project_plan !== undefined) {
    if (!_xu.is_plain_object(input._runtime_context._current_project_plan)) {
      throw_explicit_error(
        XVIBE_INVALID_INTENT_REQUEST,
        "Invalid '_runtime_context._current_project_plan': expected object",
      );
    }

    context._current_project_plan =
      read_optional_json_value(
        input._runtime_context._current_project_plan,
        "_runtime_context._current_project_plan",
        XVIBE_INVALID_INTENT_REQUEST,
      ) as Record<string, any>;
  }

  if (input._runtime_context._planning_answer !== undefined) {
    if (Array.isArray(input._runtime_context._planning_answer)) {
      context._planning_answer =
        read_optional_intent_context_string_array(
          input._runtime_context._planning_answer,
          "_runtime_context._planning_answer",
        );
    } else {
      const planning_answer =
        read_optional_intent_context_string(
          input._runtime_context._planning_answer,
          "_runtime_context._planning_answer",
        );
      if (planning_answer) {
        context._planning_answer = planning_answer;
      }
    }
  }

  if (input._runtime_context._available_artifacts !== undefined) {
    if (!_xu.is_plain_object(input._runtime_context._available_artifacts)) {
      throw_explicit_error(
        XVIBE_INVALID_INTENT_REQUEST,
        "Invalid '_runtime_context._available_artifacts': expected object",
      );
    }

    const available_artifacts: NonNullable<XVibeIntentRuntimeContext["_available_artifacts"]> = {};
    const views =
      read_optional_intent_context_string_array(
        input._runtime_context._available_artifacts._views,
        "_runtime_context._available_artifacts._views",
      );
    const entities =
      read_optional_intent_context_string_array(
        input._runtime_context._available_artifacts._entities,
        "_runtime_context._available_artifacts._entities",
      );
    const flows =
      read_optional_intent_context_string_array(
        input._runtime_context._available_artifacts._flows,
        "_runtime_context._available_artifacts._flows",
      );
    const modules =
      read_optional_intent_context_string_array(
        input._runtime_context._available_artifacts._modules,
        "_runtime_context._available_artifacts._modules",
      );

    if (views) available_artifacts._views = views;
    if (entities) available_artifacts._entities = entities;
    if (flows) available_artifacts._flows = flows;
    if (modules) available_artifacts._modules = modules;
    context._available_artifacts = available_artifacts;
  }

  return context;
}

function resolve_existing_conversation(input: {
  _app_id: string;
  _env: string;
  _conversation_id: string;
}): {
  _conversations_dir: string;
  _conversation_dir: string;
} {
  const conversations_dir = resolve_conversations_dir({
    _app_id: input._app_id,
    _env: input._env,
  });
  const conversation_dir = conversation_dir_path(conversations_dir, input._conversation_id);

  if (!fs.existsSync(conversation_dir)) {
    throw_explicit_error(
      XVIBE_CONVERSATION_NOT_FOUND,
      `Conversation not found: ${input._conversation_id}`,
      {
        _conversation_id: input._conversation_id,
      },
    );
  }

  return {
    _conversations_dir: conversations_dir,
    _conversation_dir: conversation_dir,
  };
}

export class ConversationManager {
  static errorPayload(error: unknown): XVibeJsonObject | undefined {
    return structured_error_payload(error);
  }

  static readPlanningDraft(input: {
    _app_id: string;
    _env: string;
    _conversation_id?: string;
  }): XVibeJsonObject | undefined {
    if (
      typeof input._conversation_id !== "string" ||
      input._conversation_id.trim().length === 0
    ) {
      return undefined;
    }

    try {
      const app_id = normalize_safe_app_id(input._app_id);
      const env = read_safe_path_segment(input._env, "_env", XVIBE_INVALID_ENV);
      const conversation_id =
        read_safe_path_segment(
          input._conversation_id,
          "_conversation_id",
          XVIBE_INVALID_CONVERSATION_ID,
        );
      const { _conversation_dir: conversation_dir } =
        resolve_existing_conversation({
          _app_id: app_id,
          _env: env,
          _conversation_id: conversation_id,
        });
      const conversation = read_conversation_document(conversation_dir);
      return _xu.is_plain_object(conversation._planning_draft)
        ? clone_json(conversation._planning_draft as XVibeJsonObject)
        : undefined;
    } catch (error) {
      _xlog.warn("[xvibe] planning draft read failed", {
        _app_id: input._app_id,
        _env: input._env,
        _conversation_id: input._conversation_id,
        _error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  static writePlanningDraft(input: {
    _app_id: string;
    _env: string;
    _conversation_id?: string;
    _draft: Record<string, any>;
  }): void {
    if (
      typeof input._conversation_id !== "string" ||
      input._conversation_id.trim().length === 0
    ) {
      return;
    }

    if (
      !_xu.is_plain_object(input._draft) ||
      !is_json_compatible_value(input._draft)
    ) {
      throw_explicit_error(
        XVIBE_CONVERSATION_STORAGE_FAILED,
        "Invalid planning draft: expected JSON-compatible object",
      );
    }

    const app_id = normalize_safe_app_id(input._app_id);
    const env = read_safe_path_segment(input._env, "_env", XVIBE_INVALID_ENV);
    const conversation_id =
      read_safe_path_segment(
        input._conversation_id,
        "_conversation_id",
        XVIBE_INVALID_CONVERSATION_ID,
      );
    const {
      _conversations_dir: conversations_dir,
      _conversation_dir: conversation_dir,
    } =
      resolve_existing_conversation({
        _app_id: app_id,
        _env: env,
        _conversation_id: conversation_id,
      });
    const conversation = read_conversation_document(conversation_dir);
    const updated_conversation: XVibeConversationDocument = {
      ...conversation,
      _updated_at: new Date().toISOString(),
      _planning_draft: clone_json(input._draft),
    };

    write_conversation_document_with_index({
      _conversations_dir: conversations_dir,
      _conversation_dir: conversation_dir,
      _conversation: updated_conversation,
    });

    _xlog.log("[xvibe] planning draft stored", {
      _app_id: app_id,
      _env: env,
      _conversation_id: conversation_id,
    });
  }

  static clearPlanningDraft(input: {
    _app_id: string;
    _env: string;
    _conversation_id?: string;
  }): void {
    if (
      typeof input._conversation_id !== "string" ||
      input._conversation_id.trim().length === 0
    ) {
      return;
    }

    const app_id = normalize_safe_app_id(input._app_id);
    const env = read_safe_path_segment(input._env, "_env", XVIBE_INVALID_ENV);
    const conversation_id =
      read_safe_path_segment(
        input._conversation_id,
        "_conversation_id",
        XVIBE_INVALID_CONVERSATION_ID,
      );
    const {
      _conversations_dir: conversations_dir,
      _conversation_dir: conversation_dir,
    } =
      resolve_existing_conversation({
        _app_id: app_id,
        _env: env,
        _conversation_id: conversation_id,
      });
    const conversation = read_conversation_document(conversation_dir);
    const updated_conversation: XVibeConversationDocument = {
      ...conversation,
      _updated_at: new Date().toISOString(),
    };
    delete updated_conversation._planning_draft;

    write_conversation_document_with_index({
      _conversations_dir: conversations_dir,
      _conversation_dir: conversation_dir,
      _conversation: updated_conversation,
    });

    _xlog.log("[xvibe] planning draft cleared", {
      _app_id: app_id,
      _env: env,
      _conversation_id: conversation_id,
    });
  }

  static readAnalyzeMessageRequest(xcmd: XCommand): XVibeAnalyzeMessageRequest {
    const params = _xu.is_plain_object(xcmd?._params) ? xcmd._params : {};
    const app_id = normalize_safe_app_id(params._app_id);
    const env = read_safe_path_segment(params._env, "_env", XVIBE_INVALID_ENV);
    const conversation_id = normalize_safe_conversation_id(params._conversation_id);
    if (typeof params._message !== "string") {
      throw_explicit_error(
        XVIBE_INVALID_CONVERSATION_MESSAGE,
        "Invalid '_message': expected string",
      );
    }

    const message_id =
      read_optional_intent_context_string(params._message_id, "_message_id");
    resolve_existing_conversation({
      _app_id: app_id,
      _env: env,
      _conversation_id: conversation_id,
    });

    const runtime_context =
      normalize_analyze_message_runtime_context({
        _app_id: app_id,
        _env: env,
        _conversation_id: conversation_id,
        _runtime_context: params._runtime_context,
      });
    if (!_xu.is_plain_object(runtime_context._current_project_plan)) {
      const planning_draft =
        ConversationManager.readPlanningDraft({
          _app_id: app_id,
          _env: env,
          _conversation_id: conversation_id,
        });
      if (planning_draft) {
        runtime_context._current_project_plan =
          planning_draft as Record<string, any>;
      }
    }

    return {
      _app_id: app_id,
      _env: env,
      _conversation_id: conversation_id,
      _message: params._message,
      ...(message_id ? { _message_id: message_id } : {}),
      _runtime_context: runtime_context,
    };
  }

  static async createConversation(xcmd: XCommand) {
    const params = _xu.is_plain_object(xcmd?._params) ? xcmd._params : {};

    try {
      const app_id = normalize_safe_app_id(params._app_id);
      const env = read_safe_path_segment(params._env ?? DEFAULT_ENV, "_env", XVIBE_INVALID_ENV);
      const conversation_id = normalize_safe_conversation_id(params._conversation_id);
      const conversations_dir = resolve_conversations_dir({
        _app_id: app_id,
        _env: env,
      });
      const conversation_dir = conversation_dir_path(conversations_dir, conversation_id);

      if (fs.existsSync(conversation_dir)) {
        throw_explicit_error(
          XVIBE_CONVERSATION_ALREADY_EXISTS,
          `Conversation already exists: ${conversation_id}`,
          {
            _conversation_id: conversation_id,
          },
        );
      }

      const now = new Date().toISOString();
      const title = read_optional_string(params._title, "_title");
      const metadata =
        read_optional_json_value(
          params._metadata,
          "_metadata",
          XVIBE_CONVERSATION_STORAGE_FAILED,
        );
      const conversation: XVibeConversationDocument = {
        _id: conversation_id,
        _app_id: app_id,
        _env: env,
        _created_at: now,
        _updated_at: now,
        _message_count: 0,
        ...(title ? { _title: title } : {}),
        ...(metadata !== undefined ? { _metadata: metadata } : {}),
      };

      fs.mkdirSync(path.join(conversation_dir, "attachments"), { recursive: true });
      write_json_object_file(path.join(conversation_dir, "conversation.json"), conversation);
      fs.writeFileSync(path.join(conversation_dir, "messages.jsonl"), "", "utf-8");

      const index =
        upsert_conversation_index_entry(
          read_conversation_index(conversations_dir, app_id, env),
          conversation,
        );
      write_conversation_index(conversations_dir, index);

      return {
        _ok: true,
        _result: {
          _conversation: conversation,
          _path: path.posix.join(
            "xvm",
            "apps",
            env,
            app_id,
            "conversations",
            conversation_id,
          ),
        },
      };
    } catch (error) {
      const structured = structured_error_payload(error);
      if (structured) {
        _xlog.error("[xvibe] create_conversation failed", error);
        return structured;
      }

      const message = error instanceof Error ? error.message : String(error);
      _xlog.error("[xvibe] create_conversation failed", error);
      return explicit_error(XVIBE_CONVERSATION_STORAGE_FAILED, message);
    }
  }

  static async listConversations(xcmd: XCommand) {
    const params = _xu.is_plain_object(xcmd?._params) ? xcmd._params : {};

    try {
      const app_id = normalize_safe_app_id(params._app_id);
      const env = read_safe_path_segment(params._env ?? DEFAULT_ENV, "_env", XVIBE_INVALID_ENV);
      const conversations_dir = resolve_conversations_dir({
        _app_id: app_id,
        _env: env,
      });
      fs.mkdirSync(conversations_dir, { recursive: true });
      const index_result = read_conversation_index_safe(conversations_dir, app_id, env);
      const index = index_result._index;
      write_conversation_index(conversations_dir, index);

      return {
        _ok: true,
        _result: {
          _app_id: app_id,
          _env: env,
          _conversations: index._conversations,
          _count: index._conversations.length,
          ...(index_result._recovered
            ? {
              _index_recovered: true,
              _index_error: index_result._error,
            }
            : {}),
        },
      };
    } catch (error) {
      const structured = structured_error_payload(error);
      if (structured) {
        _xlog.error("[xvibe] list_conversations failed", error);
        return structured;
      }

      const message = error instanceof Error ? error.message : String(error);
      _xlog.error("[xvibe] list_conversations failed", error);
      return explicit_error(XVIBE_CONVERSATION_STORAGE_FAILED, message);
    }
  }

  static async getConversation(xcmd: XCommand) {
    const params = _xu.is_plain_object(xcmd?._params) ? xcmd._params : {};

    try {
      const app_id = normalize_safe_app_id(params._app_id);
      const env = read_safe_path_segment(params._env ?? DEFAULT_ENV, "_env", XVIBE_INVALID_ENV);
      const conversation_id = normalize_safe_conversation_id(params._conversation_id);
      const { _conversation_dir: conversation_dir } =
        resolve_existing_conversation({
          _app_id: app_id,
          _env: env,
          _conversation_id: conversation_id,
        });

      const conversation = read_conversation_document(conversation_dir);
      const messages = read_conversation_messages(conversation_dir);

      return {
        _ok: true,
        _result: {
          _conversation: conversation,
          _messages: messages,
          _attachments_path: path.posix.join(
            "xvm",
            "apps",
            env,
            app_id,
            "conversations",
            conversation_id,
            "attachments",
          ),
        },
      };
    } catch (error) {
      const structured = structured_error_payload(error);
      if (structured) {
        _xlog.error("[xvibe] get_conversation failed", error);
        return structured;
      }

      const message = error instanceof Error ? error.message : String(error);
      _xlog.error("[xvibe] get_conversation failed", error);
      return explicit_error(XVIBE_CONVERSATION_STORAGE_FAILED, message);
    }
  }

  static async appendMessage(xcmd: XCommand) {
    const params = _xu.is_plain_object(xcmd?._params) ? xcmd._params : {};

    try {
      const app_id = normalize_safe_app_id(params._app_id);
      const env = read_safe_path_segment(params._env ?? DEFAULT_ENV, "_env", XVIBE_INVALID_ENV);
      const conversation_id = normalize_safe_conversation_id(params._conversation_id);
      const {
        _conversations_dir: conversations_dir,
        _conversation_dir: conversation_dir,
      } =
        resolve_existing_conversation({
          _app_id: app_id,
          _env: env,
          _conversation_id: conversation_id,
        });

      const message =
        normalize_conversation_message(
          _xu.is_plain_object(params._message)
            ? params._message
            : params,
        );
      const conversation = read_conversation_document(conversation_dir);
      const updated_conversation: XVibeConversationDocument = {
        ...conversation,
        _updated_at: message._created_at,
        _last_message_at: message._created_at,
        _message_count: conversation._message_count + 1,
      };

      fs.appendFileSync(
        path.join(conversation_dir, "messages.jsonl"),
        `${JSON.stringify(message)}\n`,
        "utf-8",
      );
      write_json_object_file(
        path.join(conversation_dir, "conversation.json"),
        updated_conversation,
      );
      write_conversation_index(
        conversations_dir,
        upsert_conversation_index_entry(
          read_conversation_index(conversations_dir, app_id, env),
          updated_conversation,
        ),
      );

      return {
        _ok: true,
        _result: {
          _conversation: updated_conversation,
          _message: message,
        },
      };
    } catch (error) {
      const structured = structured_error_payload(error);
      if (structured) {
        _xlog.error("[xvibe] append_message failed", error);
        return structured;
      }

      const message = error instanceof Error ? error.message : String(error);
      _xlog.error("[xvibe] append_message failed", error);
      return explicit_error(XVIBE_CONVERSATION_STORAGE_FAILED, message);
    }
  }

  static async updateConversationAction(xcmd: XCommand) {
    const params = _xu.is_plain_object(xcmd?._params) ? xcmd._params : {};
    _xlog.log("[xvibe] conversation action update received", {
      _conversation_id:
        typeof params._conversation_id === "string"
          ? params._conversation_id
          : undefined,
      _message_id:
        typeof params._message_id === "string"
          ? params._message_id
          : undefined,
      _action_id:
        typeof params._action_id === "string"
          ? params._action_id
          : undefined,
      _status:
        typeof params._status === "string"
          ? params._status
          : undefined,
      _has_result: params._result !== undefined,
      _result_ok:
        _xu.is_plain_object(params._result) &&
        (params._result as XVibeJsonObject)._ok === true,
    });

    try {
      const app_id = normalize_safe_app_id(params._app_id);
      const env = read_safe_path_segment(params._env, "_env", XVIBE_INVALID_ENV);
      const conversation_id =
        read_safe_path_segment(
          params._conversation_id,
          "_conversation_id",
          XVIBE_INVALID_CONVERSATION_ID,
        );
      const message_id =
        read_safe_path_segment(
          params._message_id,
          "_message_id",
          XVIBE_INVALID_CONVERSATION_MESSAGE,
        );
      const action_id =
        read_safe_path_segment(
          params._action_id,
          "_action_id",
          XVIBE_INVALID_CONVERSATION_ACTION,
        );
      const status = read_conversation_action_status(params._status);
      const result =
        read_optional_json_object(
          params._result,
          "_result",
          XVIBE_INVALID_CONVERSATION_ACTION,
        );
      const metadata =
        read_optional_json_object(
          params._metadata,
          "_metadata",
          XVIBE_INVALID_CONVERSATION_ACTION,
        );
      const error_message =
        read_optional_conversation_action_error(params._error);
      const { _conversation_dir: conversation_dir } =
        resolve_existing_conversation({
          _app_id: app_id,
          _env: env,
          _conversation_id: conversation_id,
        });

      read_conversation_document(conversation_dir);
      const messages = read_conversation_messages(conversation_dir);
      const message =
        messages.find((item) => item._id === message_id);
      if (!message) {
        throw_explicit_error(
          XVIBE_CONVERSATION_MESSAGE_NOT_FOUND,
          `Conversation message not found: ${message_id}`,
          {
            _conversation_id: conversation_id,
            _message_id: message_id,
          },
        );
      }

      const intent =
        _xu.is_plain_object(message._intent)
          ? message._intent as XVibeJsonObject
          : undefined;
      const actions =
        intent && Array.isArray(intent._actions)
          ? intent._actions
          : [];
      let action: XVibeJsonObject | undefined;
      for (const candidate of actions) {
        if (
          _xu.is_plain_object(candidate) &&
          candidate._id === action_id
        ) {
          action = candidate as XVibeJsonObject;
          break;
        }
      }

      if (!action) {
        throw_explicit_error(
          XVIBE_CONVERSATION_ACTION_NOT_FOUND,
          `Conversation action not found: ${action_id}`,
          {
            _conversation_id: conversation_id,
            _message_id: message_id,
            _action_id: action_id,
          },
        );
      }

      action._status = status;
      if (result !== undefined) {
        action._result = result;
      }
      if (error_message !== undefined) {
        action._error = error_message;
      }
      if (metadata !== undefined) {
        action._metadata = metadata;
      }

      write_conversation_messages(conversation_dir, messages);

      await learn_verified_conversation_action({
        _app_id: app_id,
        _env: env,
        _message: message,
        _messages: messages,
        _intent: intent,
        _action: action,
        _status: status,
      });

      return {
        _ok: true,
        _result: {
          _app_id: app_id,
          _env: env,
          _conversation_id: conversation_id,
          _message_id: message_id,
          _action_id: action_id,
          _status: status,
          _message: message,
          _action: action,
        },
      };
    } catch (error) {
      const structured = structured_error_payload(error);
      if (structured) {
        _xlog.error("[xvibe] update_conversation_action failed", error);
        return structured;
      }

      const message = error instanceof Error ? error.message : String(error);
      _xlog.error("[xvibe] update_conversation_action failed", error);
      return explicit_error(XVIBE_CONVERSATION_STORAGE_FAILED, message);
    }
  }

  static async updateConversationArtifact(xcmd: XCommand) {
    const params = _xu.is_plain_object(xcmd?._params) ? xcmd._params : {};
    _xlog.log("[xvibe] conversation artifact status update received", {
      _conversation_id:
        typeof params._conversation_id === "string"
          ? params._conversation_id
          : undefined,
      _message_id:
        typeof params._message_id === "string"
          ? params._message_id
          : undefined,
      _artifact_status:
        typeof params._artifact_status === "string"
          ? params._artifact_status
          : undefined,
      _has_artifact_result: params._artifact_result !== undefined,
      _has_artifact_error: params._artifact_error !== undefined,
    });

    try {
      const app_id = normalize_safe_app_id(params._app_id);
      const env = read_safe_path_segment(params._env, "_env", XVIBE_INVALID_ENV);
      const conversation_id =
        read_safe_path_segment(
          params._conversation_id,
          "_conversation_id",
          XVIBE_INVALID_CONVERSATION_ID,
        );
      const message_id =
        read_safe_path_segment(
          params._message_id,
          "_message_id",
          XVIBE_INVALID_CONVERSATION_MESSAGE,
        );
      const artifact_status =
        read_conversation_artifact_status(params._artifact_status);
      const artifact_type =
        read_optional_string(params._artifact_type, "_artifact_type");
      const artifact_request =
        read_optional_json_object(
          params._artifact_request,
          "_artifact_request",
          XVIBE_INVALID_CONVERSATION_MESSAGE,
        );
      const artifact_result =
        read_optional_json_object(
          params._artifact_result,
          "_artifact_result",
          XVIBE_INVALID_CONVERSATION_MESSAGE,
        );
      const artifact_error =
        read_optional_conversation_artifact_error(params._artifact_error);
      const { _conversation_dir: conversation_dir } =
        resolve_existing_conversation({
          _app_id: app_id,
          _env: env,
          _conversation_id: conversation_id,
        });

      read_conversation_document(conversation_dir);
      const messages = read_conversation_messages(conversation_dir);
      const message =
        messages.find((item) => item._id === message_id);
      if (!message) {
        throw_explicit_error(
          XVIBE_CONVERSATION_MESSAGE_NOT_FOUND,
          `Conversation message not found: ${message_id}`,
          {
            _conversation_id: conversation_id,
            _message_id: message_id,
          },
        );
      }

      if (!_xu.is_plain_object(message._intent)) {
        throw_explicit_error(
          XVIBE_INVALID_CONVERSATION_MESSAGE,
          `Conversation message intent not found: ${message_id}`,
          {
            _conversation_id: conversation_id,
            _message_id: message_id,
          },
        );
      }

      const intent = message._intent as XVibeJsonObject;
      if (artifact_type && intent._artifact_type !== artifact_type) {
        throw_explicit_error(
          XVIBE_INVALID_CONVERSATION_MESSAGE,
          `Conversation artifact type mismatch: ${message_id}`,
          {
            _conversation_id: conversation_id,
            _message_id: message_id,
            _expected_artifact_type: artifact_type,
            _actual_artifact_type:
              typeof intent._artifact_type === "string"
                ? intent._artifact_type
                : undefined,
          },
        );
      }
      if (
        artifact_request !== undefined &&
        !conversation_artifact_request_matches({
          _artifact_type:
            artifact_type ??
            (typeof intent._artifact_type === "string" ? intent._artifact_type : undefined),
          _expected: artifact_request,
          _actual: intent._artifact_request,
        })
      ) {
        throw_explicit_error(
          XVIBE_INVALID_CONVERSATION_MESSAGE,
          `Conversation artifact request mismatch: ${message_id}`,
          {
            _conversation_id: conversation_id,
            _message_id: message_id,
            _artifact_type:
              artifact_type ??
              (typeof intent._artifact_type === "string" ? intent._artifact_type : undefined),
          },
        );
      }

      intent._artifact_status = artifact_status;
      if (artifact_result !== undefined) {
        intent._artifact_result = artifact_result;
      }
      if (artifact_error !== undefined) {
        intent._artifact_error = artifact_error;
      }

      write_conversation_messages(conversation_dir, messages);

      _xlog.log("[xvibe] conversation artifact status updated", {
        _app_id: app_id,
        _env: env,
        _conversation_id: conversation_id,
        _message_id: message_id,
        _artifact_status: artifact_status,
      });

      return {
        _ok: true,
        _result: {
          _app_id: app_id,
          _env: env,
          _conversation_id: conversation_id,
          _message_id: message_id,
          _artifact_status: artifact_status,
          _message: message,
          _intent: intent,
        },
      };
    } catch (error) {
      const structured = structured_error_payload(error);
      if (structured) {
        _xlog.error("[xvibe] update_conversation_artifact failed", error);
        return structured;
      }

      const message = error instanceof Error ? error.message : String(error);
      _xlog.error("[xvibe] update_conversation_artifact failed", error);
      return explicit_error(XVIBE_CONVERSATION_STORAGE_FAILED, message);
    }
  }

  static async getLastMessages(xcmd: XCommand) {
    const params = _xu.is_plain_object(xcmd?._params) ? xcmd._params : {};

    try {
      const app_id = normalize_safe_app_id(params._app_id);
      const env = read_safe_path_segment(params._env ?? DEFAULT_ENV, "_env", XVIBE_INVALID_ENV);
      const conversation_id = normalize_safe_conversation_id(params._conversation_id);
      const limit =
        typeof params._limit === "number" && Number.isInteger(params._limit) && params._limit > 0
          ? Math.min(params._limit, XVIBE_CONVERSATION_LAST_MESSAGES_MAX_LIMIT)
          : 20;
      const { _conversation_dir: conversation_dir } =
        resolve_existing_conversation({
          _app_id: app_id,
          _env: env,
          _conversation_id: conversation_id,
        });

      const messages = read_conversation_messages(conversation_dir);

      return {
        _ok: true,
        _result: {
          _conversation_id: conversation_id,
          _messages: messages.slice(-limit),
          _count: Math.min(messages.length, limit),
          _total: messages.length,
        },
      };
    } catch (error) {
      const structured = structured_error_payload(error);
      if (structured) {
        _xlog.error("[xvibe] get_last_messages failed", error);
        return structured;
      }

      const message = error instanceof Error ? error.message : String(error);
      _xlog.error("[xvibe] get_last_messages failed", error);
      return explicit_error(XVIBE_CONVERSATION_STORAGE_FAILED, message);
    }
  }
}
