import { _xlog, _xu } from "@xpell/core";
import {
  IntentMemoryStore,
  LEARNED_SELECTED_OBJECT_PLACEHOLDERS,
  normalize_learned_intent_prompt,
  read_valid_learned_intent_entry,
  type XVibeLearnedIntentEntry,
} from "../IntentMemory/IntentMemoryStore.js";
import type {
  XVibeIntentEngineRequest,
  XVibeIntentResult,
} from "../XVibeTypes.js";
import type { XVibeIntentProcessor } from "./XVibeIntentProcessor.js";

export type LearnedIntentProcessorOptions = {
  _store?: IntentMemoryStore;
};

function read_non_empty_string(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function selected_type_from_request(
  request: XVibeIntentEngineRequest,
): string | null {
  const selected_object = request._runtime_context._selected_object;
  if (!_xu.is_plain_object(selected_object)) {
    return null;
  }

  return read_non_empty_string(selected_object._type);
}

function clone_intent(intent: XVibeIntentResult): XVibeIntentResult {
  return JSON.parse(JSON.stringify(intent)) as XVibeIntentResult;
}

function clone_json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type PlaceholderResolutionResult =
  | {
    _ok: true;
    _intent: XVibeIntentResult;
    _resolved_fields: string[];
  }
  | {
    _ok: false;
    _field: string;
    _reason: string;
  };

const SELECTED_PLACEHOLDER_FIELDS = [
  {
    _field: "_target_id",
    _placeholder: LEARNED_SELECTED_OBJECT_PLACEHOLDERS._target_id,
    _selected_field: "_json_id",
    _requires_string: true,
  },
  {
    _field: "_target_type",
    _placeholder: LEARNED_SELECTED_OBJECT_PLACEHOLDERS._target_type,
    _selected_field: "_type",
    _requires_string: true,
  },
  {
    _field: "_source_view_id",
    _placeholder: LEARNED_SELECTED_OBJECT_PLACEHOLDERS._source_view_id,
    _selected_field: "_source_view_id",
    _requires_string: true,
  },
  {
    _field: "_path",
    _placeholder: LEARNED_SELECTED_OBJECT_PLACEHOLDERS._path,
    _selected_field: "_path",
    _requires_string: false,
  },
] as const;

function resolve_selected_placeholder_value(input: {
  _field: string;
  _selected_field: string;
  _requires_string: boolean;
  _selected_object: unknown;
}): { _ok: true; _value: unknown } | { _ok: false; _field: string; _reason: string } {
  if (!_xu.is_plain_object(input._selected_object)) {
    return {
      _ok: false,
      _field: input._field,
      _reason: "missing_selected_object",
    };
  }

  const value = input._selected_object[input._selected_field];
  if (
    value === undefined ||
    value === null ||
    (
      input._requires_string &&
      (typeof value !== "string" || value.trim().length === 0)
    )
  ) {
    return {
      _ok: false,
      _field: input._field,
      _reason: "missing_selected_value",
    };
  }

  return {
    _ok: true,
    _value: clone_json(value),
  };
}

function resolve_learned_intent_placeholders(
  intent: XVibeIntentResult,
  request: XVibeIntentEngineRequest,
): PlaceholderResolutionResult {
  const resolved_intent = clone_intent(intent);
  const resolved_fields: string[] = [];

  for (const action of resolved_intent._actions) {
    if (
      action._action_type !== "apply-view-edit" ||
      !_xu.is_plain_object(action._params)
    ) {
      continue;
    }

    for (const field of SELECTED_PLACEHOLDER_FIELDS) {
      if (action._params[field._field] !== field._placeholder) {
        continue;
      }

      const resolved_value =
        resolve_selected_placeholder_value({
          _field: field._field,
          _selected_field: field._selected_field,
          _requires_string: field._requires_string,
          _selected_object: request._runtime_context._selected_object,
        });
      if (!resolved_value._ok) {
        return resolved_value;
      }

      action._params[field._field] = resolved_value._value;
      if (!resolved_fields.includes(field._field)) {
        resolved_fields.push(field._field);
      }
    }
  }

  return {
    _ok: true,
    _intent: resolved_intent,
    _resolved_fields: resolved_fields,
  };
}

export class LearnedIntentProcessor implements XVibeIntentProcessor {
  private readonly store: IntentMemoryStore;
  private diagnostic_reason = "learned_intent_no_match";

  constructor(options: LearnedIntentProcessorOptions = {}) {
    this.store = options._store ?? new IntentMemoryStore();
  }

  async analyze(
    request: XVibeIntentEngineRequest,
  ): Promise<XVibeIntentResult | null> {
    const normalized_prompt =
      normalize_learned_intent_prompt(request._message);
    const selected_type = selected_type_from_request(request);

    _xlog.log("[xvibe] learned intent lookup", {
      _app_id: request._runtime_context._app_id,
      _env: request._runtime_context._env,
      _prompt_chars: normalized_prompt.length,
      ...(selected_type ? { _selected_type: selected_type } : {}),
    });

    if (!normalized_prompt) {
      return this.skip("empty_normalized_prompt");
    }

    const memory = await this.store.read_learned_intents({
      _app_id: request._runtime_context._app_id,
      _env: request._runtime_context._env,
    });

    if (!memory._ok) {
      return this.skip(memory._reason);
    }

    if (memory._missing || memory._entries.length === 0) {
      return this.skip("learned_intents_missing");
    }

    const prompt_matches: XVibeLearnedIntentEntry[] = [];
    let invalid_prompt_match = false;
    for (const raw_entry of memory._entries) {
      if (
        !_xu.is_plain_object(raw_entry) ||
        raw_entry._normalized_prompt !== normalized_prompt
      ) {
        continue;
      }

      const entry = read_valid_learned_intent_entry(raw_entry);
      if (!entry) {
        invalid_prompt_match = true;
        continue;
      }

      prompt_matches.push(entry);
    }

    if (prompt_matches.length === 0) {
      return this.skip(
        invalid_prompt_match
          ? "learned_intent_invalid_match"
          : "learned_intent_no_match",
      );
    }

    const matched_entry =
      selected_type
        ? (
          prompt_matches.find(
            (entry) => entry._selected_type === selected_type,
          ) ??
          prompt_matches.find((entry) => entry._selected_type === undefined)
        )
        : prompt_matches.find((entry) => entry._selected_type === undefined);

    if (!matched_entry) {
      return this.skip("learned_intent_selected_type_mismatch");
    }

    _xlog.log("[xvibe] learned intent matched", {
      _app_id: request._runtime_context._app_id,
      _env: request._runtime_context._env,
      ...(matched_entry._selected_type
        ? { _selected_type: matched_entry._selected_type }
        : {}),
    });

    const resolved_intent =
      resolve_learned_intent_placeholders(matched_entry._intent, request);
    if (!resolved_intent._ok) {
      _xlog.log("[xvibe] learned intent placeholder missing", {
        _field: resolved_intent._field,
        _reason: resolved_intent._reason,
      });
      return this.skip("learned_intent_placeholder_missing");
    }

    if (resolved_intent._resolved_fields.length > 0) {
      _xlog.log("[xvibe] learned intent placeholders resolved", {
        _resolved_fields: resolved_intent._resolved_fields,
      });
    }

    this.diagnostic_reason = "learned_intent_matched";
    await this.store.record_hit({
      _app_id: request._runtime_context._app_id,
      _env: request._runtime_context._env,
      _normalized_prompt: matched_entry._normalized_prompt,
      ...(matched_entry._selected_type
        ? { _selected_type: matched_entry._selected_type }
        : {}),
    });
    return resolved_intent._intent;
  }

  _diagnostic_reason(): string | undefined {
    return this.diagnostic_reason;
  }

  private skip(reason: string): null {
    this.diagnostic_reason = reason;
    _xlog.log("[xvibe] learned intent skipped", {
      _reason: reason,
    });
    return null;
  }
}
