import { _xlog, _xu } from "@xpell/core";
import type {
  XVibeIntentEngineRequest,
  XVibeIntentResult,
} from "../XVibeTypes.js";
import type { XVibeIntentProcessor } from "./XVibeIntentProcessor.js";

const CREATE_FORM_FOR_PATTERN =
  /^\s*(?:create|make|add)\s+(?:a\s+)?form(?:\s+view)?\s+for\s+([\s\S]+?)(?:\s+(?:called|named)\s+([\s\S]+?))?\s*[.!?]?\s*$/iu;
const CREATE_ENTITY_FORM_PATTERN =
  /^\s*(?:create|make|add)\s+([\s\S]+?)\s+form(?:\s+view)?(?:\s+(?:called|named)\s+([\s\S]+?))?\s*[.!?]?\s*$/iu;
const FORBIDDEN_FORM_ACTION_PATTERN = /\bform\b/iu;
const FORBIDDEN_ACTION_PATTERN =
  /\b(?:delete|modify|rename|update|remove|edit)\b/iu;

function normalize_request_id(value: string): string | null {
  const normalized = _xu.normalize_id(value);
  return normalized || null;
}

function extract_form_request(raw_value: string, raw_view_id?: string): {
  _entity_name: string;
  _view_id: string;
} | null {
  const normalized = normalize_request_id(raw_value);
  if (!normalized) {
    return null;
  }

  if (raw_view_id !== undefined) {
    const view_id = normalize_request_id(raw_view_id);
    if (!view_id) {
      return null;
    }

    return {
      _entity_name: normalized,
      _view_id: view_id,
    };
  }

  if (normalized.startsWith("create-") && normalized.length > "create-".length) {
    const entity_name = normalize_request_id(normalized.slice("create-".length));
    if (!entity_name) {
      return null;
    }

    return {
      _entity_name: entity_name,
      _view_id: normalized,
    };
  }

  return {
    _entity_name: normalized,
    _view_id: `create-${normalized}`,
  };
}

export class FormProcessor implements XVibeIntentProcessor {
  private diagnostic_reason = "form_processor_no_match";

  async analyze(
    request: XVibeIntentEngineRequest,
  ): Promise<XVibeIntentResult | null> {
    const message = request._message.trim();
    if (!message) {
      return this.skip("empty_message");
    }

    if (
      FORBIDDEN_FORM_ACTION_PATTERN.test(message) &&
      FORBIDDEN_ACTION_PATTERN.test(message)
    ) {
      return this.skip("forbidden_form_action");
    }

    const form_for_match = CREATE_FORM_FOR_PATTERN.exec(message);
    const entity_form_match = form_for_match
      ? null
      : CREATE_ENTITY_FORM_PATTERN.exec(message);
    const raw_form_request =
      form_for_match?.[1]?.trim() ?? entity_form_match?.[1]?.trim();
    const raw_view_id =
      form_for_match?.[2]?.trim() ?? entity_form_match?.[2]?.trim();
    if (!raw_form_request) {
      return this.skip("form_create_pattern_no_match");
    }

    const form_request = extract_form_request(raw_form_request, raw_view_id);
    if (!form_request) {
      return this.skip("invalid_form_request");
    }

    this.diagnostic_reason = "form_processor_matched";
    _xlog.log("[xvibe] form processor matched", {
      _entity_name: form_request._entity_name,
      _view_id: form_request._view_id,
    });

    return {
      _message_type: "generate",
      _execution_level: "artifact",
      _should_mutate: true,
      _confidence: 1,
      _reason: "Create form artifact request.",
      _artifact_type: "form",
      _artifact_request: {
        _operation: "create",
        _entity_name: form_request._entity_name,
        _view_id: form_request._view_id,
      },
      _actions: [],
    };
  }

  _diagnostic_reason(): string | undefined {
    return this.diagnostic_reason;
  }

  private skip(reason: string): null {
    this.diagnostic_reason = reason;
    _xlog.log("[xvibe] form processor skipped", {
      _reason: reason,
    });
    return null;
  }
}
