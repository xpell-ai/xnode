import { _xlog, _xu } from "@xpell/core";
import type {
  XVibeIntentEngineRequest,
  XVibeIntentResult,
} from "../XVibeTypes.js";
import type { XVibeIntentProcessor } from "./XVibeIntentProcessor.js";

const ADD_FIELD_PATTERN =
  /^\s*add\s+(?:field\s+)?([a-zA-Z0-9_-]+)(?:\s+field)?\s+to\s+([\s\S]+?)(?:\s+crud)?\s*[.!?]?\s*$/iu;

function normalize_request_id(value: string): string | null {
  const normalized = _xu.normalize_id(value);
  return normalized || null;
}

export class AddFieldProcessor implements XVibeIntentProcessor {
  private diagnostic_reason = "add_field_processor_no_match";

  async analyze(
    request: XVibeIntentEngineRequest,
  ): Promise<XVibeIntentResult | null> {
    const message = request._message.trim();
    if (!message) {
      return this.skip("empty_message");
    }

    const match = ADD_FIELD_PATTERN.exec(message);
    const raw_field_name = match?.[1]?.trim();
    const raw_entity_name = match?.[2]?.trim();
    if (!raw_field_name || !raw_entity_name) {
      return this.skip("add_field_pattern_no_match");
    }

    const field_name = normalize_request_id(raw_field_name);
    if (!field_name) {
      return this.skip("invalid_field_name");
    }

    const entity_name = normalize_request_id(raw_entity_name);
    if (!entity_name) {
      return this.skip("invalid_entity_name");
    }

    this.diagnostic_reason = "add_field_processor_matched";
    _xlog.log("[xvibe] add field processor matched", {
      _entity_name: entity_name,
      _field_name: field_name,
    });

    return {
      _message_type: "generate",
      _execution_level: "artifact",
      _should_mutate: true,
      _confidence: 1,
      _reason: "Add field to existing CRUD artifacts.",
      _artifact_type: "crud-evolution",
      _artifact_request: {
        _operation: "add-field",
        _entity_name: entity_name,
        _field_name: field_name,
      },
      _actions: [],
    };
  }

  _diagnostic_reason(): string | undefined {
    return this.diagnostic_reason;
  }

  private skip(reason: string): null {
    this.diagnostic_reason = reason;
    _xlog.log("[xvibe] add field processor skipped", {
      _reason: reason,
    });
    return null;
  }
}
