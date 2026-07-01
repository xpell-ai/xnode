import fs from "node:fs";
import path from "node:path";
import { _x, _xlog, type XCommand } from "@xpell/core";
import { _xu } from "../../XNUtils/XUtils.js";
import type { XVibeJsonObject } from "../VibeOutputParser.js";
import type { XVibeIntentRuntimeContext } from "../XVibeTypes.js";

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

type XVibeConversationRole = "user" | "assistant" | "system" | "tool";

type XVibeConversationActionStatus =
  | "suggested"
  | "running"
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

    return {
      _app_id: app_id,
      _env: env,
      _conversation_id: conversation_id,
      _message: params._message,
      ...(message_id ? { _message_id: message_id } : {}),
      _runtime_context:
        normalize_analyze_message_runtime_context({
          _app_id: app_id,
          _env: env,
          _conversation_id: conversation_id,
          _runtime_context: params._runtime_context,
        }),
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
