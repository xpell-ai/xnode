import { _xlog, type XCommand } from "@xpell/core";
import { _xu } from "../../XNUtils/XUtils.js";
import { ConversationManager } from "../Conversation/ConversationManager.js";
import { normalize_learned_intent_prompt } from "../IntentMemory/IntentMemoryStore.js";
import type { XVibeJsonObject } from "../VibeOutputParser.js";
import type { XVibeIntentEngine } from "../XVibeIntentEngine.js";
import type {
  XVibeIntentResult,
  XVibeIntentRuntimeContext,
} from "../XVibeTypes.js";

const XVIBE_INVALID_INTENT_REQUEST = "E_XVIBE_INVALID_INTENT_REQUEST";
const XVIBE_INVALID_INTENT_RESULT = "E_XVIBE_INVALID_INTENT_RESULT";

type IntentConversationBridgeAnalyzeInput = {
  _cmd: XCommand;
  _intent_engine: XVibeIntentEngine;
  _structured_error_payload?: (error: unknown) => XVibeJsonObject | undefined;
};

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

function normalize_intent_action_ids(intent: XVibeIntentResult | undefined): void {
  if (!intent || !Array.isArray(intent._actions)) {
    return;
  }

  let normalized = false;
  const action_ids: string[] = [];
  for (const [index, action] of intent._actions.entries()) {
    if (!_xu.is_plain_object(action)) {
      continue;
    }

    if (typeof action._id !== "string" || action._id.trim().length === 0) {
      action._id = `action-${index + 1}`;
      normalized = true;
    }

    action_ids.push(String(action._id));
  }

  if (normalized) {
    _xlog.log("[xvibe] intent action ids normalized", {
      _action_ids: action_ids,
    });
  }
}

function runtime_type(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value !== "object") return typeof value;
  return value.constructor?.name ?? "object";
}

function find_non_json_compatible_value(
  value: unknown,
  path = "$",
): { _path: string; _runtime_type: string } | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value)
      ? null
      : { _path: path, _runtime_type: runtime_type(value) };
  }

  if (typeof value !== "object") {
    return { _path: path, _runtime_type: runtime_type(value) };
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const child =
        find_non_json_compatible_value(value[index], `${path}[${index}]`);
      if (child) return child;
    }
    return null;
  }

  if (!_xu.is_plain_object(value)) {
    return { _path: path, _runtime_type: runtime_type(value) };
  }

  for (const [key, child_value] of Object.entries(value)) {
    const child =
      find_non_json_compatible_value(child_value, `${path}.${key}`);
    if (child) return child;
  }

  return null;
}

function selected_type_from_runtime_context(
  runtime_context: XVibeIntentRuntimeContext,
): string | undefined {
  const selected_object = runtime_context._selected_object;
  if (!_xu.is_plain_object(selected_object)) {
    return undefined;
  }

  return typeof selected_object._type === "string" &&
    selected_object._type.trim().length > 0
    ? selected_object._type.trim()
    : undefined;
}

export class IntentConversationBridge {
  static async analyze(input: IntentConversationBridgeAnalyzeInput) {
    try {
      const request =
        ConversationManager.readAnalyzeMessageRequest(input._cmd);

      _xlog.log("[xvibe] analyze-message", {
        _app_id: request._app_id,
        _env: request._env,
        _conversation_id: request._conversation_id,
      });

      const intent_result =
        await input._intent_engine.analyze({
          _message: request._message,
          _conversation_id: request._conversation_id,
          _runtime_context: request._runtime_context,
          ...(request._message_id
            ? {
              _metadata: {
                _message_id: request._message_id,
              },
            }
            : {}),
        });

      if (!intent_result._ok) {
        return explicit_error(
          XVIBE_INVALID_INTENT_REQUEST,
          intent_result._reason ?? "Invalid intent request",
          {
            _error: intent_result._error ?? "invalid_intent_request",
          },
        );
      }

      normalize_intent_action_ids(intent_result._intent);
      const json_issue =
        find_non_json_compatible_value(intent_result._intent);
      if (json_issue) {
        _xlog.error("[xvibe] intent result is not JSON-compatible before conversation append", {
          _path: json_issue._path,
          _runtime_type: json_issue._runtime_type,
        });
        return explicit_error(
          XVIBE_INVALID_INTENT_RESULT,
          "Intent result must be JSON-compatible before conversation append.",
          json_issue,
        );
      }

      const selected_type =
        selected_type_from_runtime_context(request._runtime_context);

      const append_result: any = await ConversationManager.appendMessage({
        _params: {
          _app_id: request._app_id,
          _env: request._env,
          _conversation_id: request._conversation_id,
          _message: {
            _role: "tool",
            _text: "Intent analyzed.",
            _intent: intent_result._intent,
            _metadata: {
              _source: "xvibe.analyze-message",
              ...(intent_result._processor
                ? { _intent_processor: intent_result._processor }
                : {}),
              _normalized_prompt:
                normalize_learned_intent_prompt(request._message),
              ...(selected_type ? { _selected_type: selected_type } : {}),
            },
          },
        },
      } as unknown as XCommand);
      if (!append_result?._ok) {
        return append_result;
      }

      return {
        _ok: true,
        _intent: intent_result._intent,
        _result: {
          _intent: intent_result._intent,
          _message: append_result._result?._message,
          _conversation: append_result._result?._conversation,
        },
      };
    } catch (error) {
      const structured =
        input._structured_error_payload?.(error) ??
        ConversationManager.errorPayload(error);
      if (structured) {
        _xlog.error("[xvibe] analyze_message failed", error);
        return structured;
      }

      const message = error instanceof Error ? error.message : String(error);
      _xlog.error("[xvibe] analyze_message failed", error);
      return explicit_error(XVIBE_INVALID_INTENT_REQUEST, message);
    }
  }
}
