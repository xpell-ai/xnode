import { _xlog, type XCommand } from "@xpell/core";
import { _xu } from "../../XNUtils/XUtils.js";
import { ConversationManager } from "../Conversation/ConversationManager.js";
import type { XVibeJsonObject } from "../VibeOutputParser.js";
import type { XVibeIntentEngine } from "../XVibeIntentEngine.js";
import type { XVibeIntentResult } from "../XVibeTypes.js";

const XVIBE_INVALID_INTENT_REQUEST = "E_XVIBE_INVALID_INTENT_REQUEST";

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
