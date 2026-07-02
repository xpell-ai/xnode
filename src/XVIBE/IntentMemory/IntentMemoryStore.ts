import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { _x, _xlog, _xu } from "@xpell/core";
import type {
  XVibeIntentActionStatus,
  XVibeIntentActionType,
  XVibeIntentExecutionLevel,
  XVibeIntentMessageType,
  XVibeIntentResult,
} from "../XVibeTypes.js";

const DEFAULT_WORK_FOLDER = "./work";
const XVM_APPS_FOLDER = "xvm/apps";
const INTENT_MEMORY_FOLDER = "intent-memory";
const LEARNED_INTENTS_FILE = "learned-intents.json";
const LEARNED_INTENT_VERSION = 1;

export const LEARNED_SELECTED_OBJECT_PLACEHOLDERS = {
  _target_id: "$selected._json_id",
  _target_type: "$selected._type",
  _source_view_id: "$selected._source_view_id",
  _path: "$selected._path",
} as const;

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

export type XVibeLearnedIntentEntry = {
  _version: 1;
  _normalized_prompt: string;
  _selected_type?: string;
  _intent: XVibeIntentResult;
  _source: "semantic";
  _hits: number;
  _created_at: string;
  _updated_at: string;
};

export type IntentMemoryLearnInput = {
  _app_id: string;
  _env: string;
  _normalized_prompt: string;
  _selected_type?: string;
  _intent: XVibeIntentResult;
  _source: "semantic";
  _verified: true;
};

export type IntentMemoryLearnResult =
  | {
    _ok: true;
    _path: string;
    _entry: XVibeLearnedIntentEntry;
    _created: boolean;
    _updated: boolean;
  }
  | {
    _ok: false;
    _reason: string;
    _path?: string;
    _error?: unknown;
  };

export type IntentMemoryHitResult =
  | {
    _ok: true;
    _path: string;
    _updated: boolean;
    _hits?: number;
  }
  | {
    _ok: false;
    _reason: string;
    _path?: string;
    _error?: unknown;
  };

export type IntentMemoryStoreReadResult =
  | {
    _ok: true;
    _path: string;
    _entries: unknown[];
    _missing?: boolean;
  }
  | {
    _ok: false;
    _reason: string;
    _path?: string;
    _error?: unknown;
  };

export type IntentMemoryStoreOptions = {
  _work_folder?: string;
};

function is_not_found_error(error: unknown): boolean {
  return (
    _xu.is_plain_object(error) &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function file_exists_for_diagnostics(file_path: string): Promise<boolean> {
  try {
    const file_stat = await stat(file_path);
    return file_stat.isFile();
  } catch {
    return false;
  }
}

async function directory_exists_for_diagnostics(
  directory_path: string,
): Promise<boolean> {
  try {
    const directory_stat = await stat(directory_path);
    return directory_stat.isDirectory();
  } catch {
    return false;
  }
}

export function normalize_learned_intent_prompt(message: string): string {
  return message
    .toLowerCase()
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/\p{P}+$/gu, "")
    .trim();
}

function read_non_empty_string(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function clone_intent(intent: XVibeIntentResult): XVibeIntentResult {
  return JSON.parse(JSON.stringify(intent)) as XVibeIntentResult;
}

function placeholderize_selected_object_params(
  params: Record<string, unknown>,
): void {
  for (const [field, placeholder] of Object.entries(
    LEARNED_SELECTED_OBJECT_PLACEHOLDERS,
  )) {
    if (params[field] !== undefined) {
      params[field] = placeholder;
    }
  }
}

function placeholderize_learned_intent(
  intent: XVibeIntentResult,
): XVibeIntentResult {
  const cloned = clone_intent(intent);
  for (const action of cloned._actions) {
    if (
      action._action_type === "apply-view-edit" &&
      _xu.is_plain_object(action._params)
    ) {
      placeholderize_selected_object_params(action._params);
    }
  }

  return cloned;
}

function normalize_optional_selected_type(value: unknown): string | undefined {
  return read_non_empty_string(value) ?? undefined;
}

function same_learned_intent_key(
  entry: Pick<XVibeLearnedIntentEntry, "_normalized_prompt" | "_selected_type">,
  input: Pick<XVibeLearnedIntentEntry, "_normalized_prompt" | "_selected_type">,
): boolean {
  return (
    entry._normalized_prompt === input._normalized_prompt &&
    (entry._selected_type ?? undefined) === (input._selected_type ?? undefined)
  );
}

export type LearnedIntentValidationResult =
  | {
    _ok: true;
  }
  | {
    _ok: false;
    _validation_error: string;
  };

function invalid_learned_intent(
  validation_error: string,
): LearnedIntentValidationResult {
  return {
    _ok: false,
    _validation_error: validation_error,
  };
}

export function validate_learned_intent_result(
  value: unknown,
): LearnedIntentValidationResult {
  if (!_xu.is_plain_object(value)) {
    return invalid_learned_intent("intent_must_be_object");
  }

  if (!MESSAGE_TYPES.includes(value._message_type as XVibeIntentMessageType)) {
    return invalid_learned_intent("intent._message_type_invalid");
  }

  if (
    !EXECUTION_LEVELS.includes(
      value._execution_level as XVibeIntentExecutionLevel,
    )
  ) {
    return invalid_learned_intent("intent._execution_level_invalid");
  }

  if (typeof value._should_mutate !== "boolean") {
    return invalid_learned_intent("intent._should_mutate_must_be_boolean");
  }

  if (
    typeof value._confidence !== "number" ||
    !Number.isFinite(value._confidence)
  ) {
    return invalid_learned_intent("intent._confidence_must_be_number");
  }

  if (value._reason !== undefined && typeof value._reason !== "string") {
    return invalid_learned_intent("intent._reason_must_be_string");
  }

  if (!Array.isArray(value._actions)) {
    return invalid_learned_intent("intent._actions_must_be_array");
  }

  if (
    value._warnings !== undefined &&
    (
      !Array.isArray(value._warnings) ||
      value._warnings.some((warning) => typeof warning !== "string")
    )
  ) {
    return invalid_learned_intent("intent._warnings_must_be_string_array");
  }

  for (const [index, action] of value._actions.entries()) {
    const prefix = `intent._actions[${index}]`;
    if (!_xu.is_plain_object(action)) {
      return invalid_learned_intent(`${prefix}_must_be_object`);
    }

    if (typeof action._id !== "string" || action._id.trim().length === 0) {
      return invalid_learned_intent(`${prefix}._id_required`);
    }

    if (
      typeof action._title !== "string" ||
      action._title.trim().length === 0
    ) {
      return invalid_learned_intent(`${prefix}._title_required`);
    }

    if (
      !ACTION_TYPES.includes(action._action_type as XVibeIntentActionType)
    ) {
      return invalid_learned_intent(`${prefix}._action_type_invalid`);
    }

    if (
      !ACTION_STATUSES.includes(action._status as XVibeIntentActionStatus)
    ) {
      return invalid_learned_intent(`${prefix}._status_invalid`);
    }

    if (
      action._description !== undefined &&
      typeof action._description !== "string"
    ) {
      return invalid_learned_intent(`${prefix}._description_must_be_string`);
    }

    if (action._params !== undefined && !_xu.is_plain_object(action._params)) {
      return invalid_learned_intent(`${prefix}._params_must_be_object`);
    }

    if (
      action._action_type === "apply-view-edit" &&
      !_xu.is_plain_object(action._params)
    ) {
      return invalid_learned_intent(
        `${prefix}._params_required_for_apply_view_edit`,
      );
    }

    if (
      action._requires_approval !== undefined &&
      typeof action._requires_approval !== "boolean"
    ) {
      return invalid_learned_intent(
        `${prefix}._requires_approval_must_be_boolean`,
      );
    }

    if (
      action._action_type === "apply-view-edit" &&
      action._requires_approval !== true
    ) {
      return invalid_learned_intent(
        `${prefix}._requires_approval_required_for_apply_view_edit`,
      );
    }

    if (
      action._confidence !== undefined &&
      (
        typeof action._confidence !== "number" ||
        !Number.isFinite(action._confidence)
      )
    ) {
      return invalid_learned_intent(`${prefix}._confidence_must_be_number`);
    }

    if (action._reason !== undefined && typeof action._reason !== "string") {
      return invalid_learned_intent(`${prefix}._reason_must_be_string`);
    }
  }

  return {
    _ok: true,
  };
}

function validate_intent_result(value: unknown): value is XVibeIntentResult {
  return validate_learned_intent_result(value)._ok;
}

export function read_valid_learned_intent_entry(
  value: unknown,
): XVibeLearnedIntentEntry | null {
  if (!_xu.is_plain_object(value)) {
    return null;
  }

  if (
    value._version !== undefined &&
    value._version !== LEARNED_INTENT_VERSION
  ) {
    return null;
  }

  const normalized_prompt =
    read_non_empty_string(value._normalized_prompt);
  if (!normalized_prompt) {
    return null;
  }

  const selected_type =
    value._selected_type === undefined
      ? undefined
      : read_non_empty_string(value._selected_type);
  if (value._selected_type !== undefined && !selected_type) {
    return null;
  }

  if (value._source !== "semantic") {
    return null;
  }

  if (
    typeof value._hits !== "number" ||
    !Number.isFinite(value._hits) ||
    value._hits < 0
  ) {
    return null;
  }

  const created_at = read_non_empty_string(value._created_at);
  if (!created_at) {
    return null;
  }

  const updated_at = read_non_empty_string(value._updated_at);
  if (!updated_at) {
    return null;
  }

  if (!validate_intent_result(value._intent)) {
    return null;
  }

  return {
    _version: LEARNED_INTENT_VERSION,
    _normalized_prompt: normalized_prompt,
    ...(selected_type ? { _selected_type: selected_type } : {}),
    _intent: value._intent,
    _source: "semantic",
    _hits: value._hits,
    _created_at: created_at,
    _updated_at: updated_at,
  };
}

function path_is_inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
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

  return DEFAULT_WORK_FOLDER;
}

export class IntentMemoryStore {
  private readonly work_folder?: string;

  constructor(options: IntentMemoryStoreOptions = {}) {
    this.work_folder =
      typeof options._work_folder === "string" &&
      options._work_folder.trim().length > 0
        ? options._work_folder
        : undefined;
  }

  async read_learned_intents(input: {
    _env: string;
    _app_id: string;
  }): Promise<IntentMemoryStoreReadResult> {
    const resolved_path = this.learned_intents_path(input);
    if (!resolved_path._ok) {
      return {
        _ok: false,
        _reason: resolved_path._reason,
      };
    }

    let text: string;
    try {
      text = await readFile(resolved_path._path, "utf-8");
    } catch (error) {
      if (is_not_found_error(error)) {
        return {
          _ok: true,
          _path: resolved_path._path,
          _entries: [],
          _missing: true,
        };
      }

      return {
        _ok: false,
        _path: resolved_path._path,
        _reason: "learned_intents_read_failed",
        _error: error,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return {
        _ok: false,
        _path: resolved_path._path,
        _reason: "learned_intents_json_invalid",
        _error: error,
      };
    }

    if (!Array.isArray(parsed)) {
      return {
        _ok: false,
        _path: resolved_path._path,
        _reason: "learned_intents_root_must_be_array",
      };
    }

    return {
      _ok: true,
      _path: resolved_path._path,
      _entries: parsed,
    };
  }

  async learn(input: IntentMemoryLearnInput): Promise<IntentMemoryLearnResult> {
    _xlog.log("[xvibe] learned intent learn begin", {
      _app_id: input._app_id,
      _env: input._env,
      _normalized_prompt: input._normalized_prompt,
      _selected_type: input._selected_type,
    });

    const resolved_path = this.learned_intents_path(input);
    if (!resolved_path._ok) {
      _xlog.warn("[xvibe] learned intent skipped", {
        _reason: resolved_path._reason,
      });

      return {
        _ok: false,
        _reason: resolved_path._reason,
      };
    }

    const directory = path.dirname(resolved_path._path);
    _xlog.log("[xvibe] learned intent path", {
      _directory: directory,
      _file: resolved_path._path,
    });

    const normalized_prompt =
      normalize_learned_intent_prompt(input._normalized_prompt);
    const selected_type =
      normalize_optional_selected_type(input._selected_type);
    if (!normalized_prompt) {
      _xlog.warn("[xvibe] learned intent skipped", {
        _reason: "empty_normalized_prompt",
        _file: resolved_path._path,
      });

      return {
        _ok: false,
        _path: resolved_path._path,
        _reason: "empty_normalized_prompt",
      };
    }

    if (input._source !== "semantic" || input._verified !== true) {
      _xlog.warn("[xvibe] learned intent skipped", {
        _reason: "learned_intent_not_verified",
        _file: resolved_path._path,
      });

      return {
        _ok: false,
        _path: resolved_path._path,
        _reason: "learned_intent_not_verified",
      };
    }

    const learned_intent = placeholderize_learned_intent(input._intent);
    if (!validate_intent_result(learned_intent)) {
      _xlog.warn("[xvibe] learned intent skipped", {
        _reason: "learned_intent_invalid_intent",
        _file: resolved_path._path,
      });

      return {
        _ok: false,
        _path: resolved_path._path,
        _reason: "learned_intent_invalid_intent",
      };
    }

    const file_existed_before =
      await file_exists_for_diagnostics(resolved_path._path);
    const ensure_result =
      await this.ensure_entries_file(resolved_path._path);
    if (!ensure_result._ok) {
      _xlog.warn("[xvibe] learned intent skipped", {
        _reason: ensure_result._reason,
        _file: ensure_result._path,
        _error: ensure_result._error,
      });

      return ensure_result;
    }

    _xlog.log("[xvibe] learned intent directory ready", {
      _exists: await directory_exists_for_diagnostics(directory),
    });

    const entries_result = await this.read_valid_entries_for_write(input);
    if (!entries_result._ok) {
      _xlog.warn("[xvibe] learned intent skipped", {
        _reason: entries_result._reason,
        _file: entries_result._path ?? resolved_path._path,
        _error: entries_result._error,
      });

      return {
        _ok: false,
        _path: entries_result._path ?? resolved_path._path,
        _reason: entries_result._reason,
        _error: entries_result._error,
      };
    }

    const now = new Date().toISOString();
    const key = {
      _normalized_prompt: normalized_prompt,
      ...(selected_type ? { _selected_type: selected_type } : {}),
    };
    const existing_index =
      entries_result._entries.findIndex((entry) =>
        same_learned_intent_key(entry, key),
      );
    const created = existing_index < 0;
    const existing =
      created ? undefined : entries_result._entries[existing_index];
    const entry: XVibeLearnedIntentEntry = {
      _version: LEARNED_INTENT_VERSION,
      _normalized_prompt: normalized_prompt,
      ...(selected_type ? { _selected_type: selected_type } : {}),
      _intent: learned_intent,
      _source: "semantic",
      _hits: existing?._hits ?? 0,
      _created_at: existing?._created_at ?? now,
      _updated_at: now,
    };

    const entries =
      created
        ? [...entries_result._entries, entry]
        : entries_result._entries.map((candidate, index) =>
          index === existing_index ? entry : candidate,
        );

    const write_result =
      await this.write_entries(resolved_path._path, entries);
    if (!write_result._ok) {
      _xlog.warn("[xvibe] learned intent skipped", {
        _reason: write_result._reason,
        _file: write_result._path,
        _error: write_result._error,
      });

      return write_result;
    }

    _xlog.log("[xvibe] learned intent stored", {
      _file: resolved_path._path,
      _entries: entries.length,
      _created: !file_existed_before,
      _updated: file_existed_before,
    });

    return {
      _ok: true,
      _path: resolved_path._path,
      _entry: entry,
      _created: created,
      _updated: !created,
    };
  }

  async record_hit(input: {
    _env: string;
    _app_id: string;
    _normalized_prompt: string;
    _selected_type?: string;
  }): Promise<IntentMemoryHitResult> {
    const resolved_path = this.learned_intents_path(input);
    if (!resolved_path._ok) {
      return {
        _ok: false,
        _reason: resolved_path._reason,
      };
    }

    const entries_result = await this.read_valid_entries_for_write(input);
    if (!entries_result._ok) {
      return {
        _ok: false,
        _path: entries_result._path ?? resolved_path._path,
        _reason: entries_result._reason,
        _error: entries_result._error,
      };
    }

    const normalized_prompt =
      normalize_learned_intent_prompt(input._normalized_prompt);
    const selected_type =
      normalize_optional_selected_type(input._selected_type);
    const target = {
      _normalized_prompt: normalized_prompt,
      ...(selected_type ? { _selected_type: selected_type } : {}),
    };
    const index =
      entries_result._entries.findIndex((entry) =>
        same_learned_intent_key(entry, target),
      );
    if (index < 0) {
      return {
        _ok: true,
        _path: resolved_path._path,
        _updated: false,
      };
    }

    const updated_entry: XVibeLearnedIntentEntry = {
      ...entries_result._entries[index],
      _hits: entries_result._entries[index]._hits + 1,
    };
    const entries =
      entries_result._entries.map((entry, entry_index) =>
        entry_index === index ? updated_entry : entry,
      );

    const write_result =
      await this.write_entries(resolved_path._path, entries);
    if (!write_result._ok) {
      return write_result;
    }

    return {
      _ok: true,
      _path: resolved_path._path,
      _updated: true,
      _hits: updated_entry._hits,
    };
  }

  learned_intents_path(input: {
    _env: string;
    _app_id: string;
  }): { _ok: true; _path: string } | { _ok: false; _reason: string } {
    const work_folder = this.work_folder ?? resolve_xvibe_work_folder();
    const apps_root = path.resolve(work_folder, XVM_APPS_FOLDER);
    const file_path = path.resolve(
      apps_root,
      input._env,
      input._app_id,
      INTENT_MEMORY_FOLDER,
      LEARNED_INTENTS_FILE,
    );

    if (!path_is_inside(apps_root, file_path)) {
      return {
        _ok: false,
        _reason: "invalid_intent_memory_path",
      };
    }

    return {
      _ok: true,
      _path: file_path,
    };
  }

  private async read_valid_entries_for_write(input: {
    _env: string;
    _app_id: string;
  }): Promise<
    | {
      _ok: true;
      _path: string;
      _entries: XVibeLearnedIntentEntry[];
    }
    | {
      _ok: false;
      _path?: string;
      _reason: string;
      _error?: unknown;
    }
  > {
    const memory = await this.read_learned_intents(input);
    if (!memory._ok) {
      return memory;
    }

    const entries: XVibeLearnedIntentEntry[] = [];
    for (const raw_entry of memory._entries) {
      const entry = read_valid_learned_intent_entry(raw_entry);
      if (!entry) {
        return {
          _ok: false,
          _path: memory._path,
          _reason: "learned_intents_entry_invalid",
        };
      }

      entries.push(entry);
    }

    return {
      _ok: true,
      _path: memory._path,
      _entries: entries,
    };
  }

  private async write_entries(
    file_path: string,
    entries: XVibeLearnedIntentEntry[],
  ): Promise<{ _ok: true } | { _ok: false; _path: string; _reason: string; _error?: unknown }> {
    try {
      const dir = path.dirname(file_path);
      await mkdir(dir, { recursive: true });
      const temp_path = path.resolve(
        dir,
        `.learned-intents.${Date.now()}-${Math.random().toString(36).slice(2, 10)}.tmp`,
      );
      if (!path_is_inside(dir, temp_path)) {
        return {
          _ok: false,
          _path: file_path,
          _reason: "invalid_intent_memory_temp_path",
        };
      }

      await writeFile(
        temp_path,
        `${JSON.stringify(entries, null, 2)}\n`,
        "utf-8",
      );
      await rename(temp_path, file_path);
      return {
        _ok: true,
      };
    } catch (error) {
      return {
        _ok: false,
        _path: file_path,
        _reason: "learned_intents_write_failed",
        _error: error,
      };
    }
  }

  private async ensure_entries_file(
    file_path: string,
  ): Promise<{ _ok: true } | { _ok: false; _path: string; _reason: string; _error?: unknown }> {
    try {
      const dir = path.dirname(file_path);
      await mkdir(dir, { recursive: true });

      try {
        await readFile(file_path, "utf-8");
      } catch (error) {
        if (!is_not_found_error(error)) {
          throw error;
        }

        await writeFile(file_path, "[]\n", "utf-8");
      }

      return {
        _ok: true,
      };
    } catch (error) {
      return {
        _ok: false,
        _path: file_path,
        _reason: "learned_intents_file_create_failed",
        _error: error,
      };
    }
  }
}
