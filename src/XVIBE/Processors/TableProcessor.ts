import { _xlog, _xu } from "@xpell/core";
import type {
  XVibeIntentEngineRequest,
  XVibeIntentResult,
} from "../XVibeTypes.js";
import type { XVibeIntentProcessor } from "./XVibeIntentProcessor.js";

const CREATE_TABLE_FOR_PATTERN =
  /^\s*(?:create|make|add)\s+(?:a\s+)?(?:table|list)(?:\s+view)?\s+for\s+([\s\S]+?)(?:\s+(?:called|named)\s+([\s\S]+?))?\s*[.!?]?\s*$/iu;
const CREATE_ENTITY_TABLE_PATTERN =
  /^\s*(?:create|make|add)\s+([\s\S]+?)\s+(?:table|list)(?:\s+view)?(?:\s+(?:called|named)\s+([\s\S]+?))?\s*[.!?]?\s*$/iu;
const FORBIDDEN_TABLE_ACTION_PATTERN = /\b(?:table|list)\b/iu;
const FORBIDDEN_ACTION_PATTERN =
  /\b(?:delete|modify|rename|update|remove|edit)\b/iu;

function normalize_request_id(value: string): string | null {
  const normalized = _xu.normalize_id(value);
  return normalized || null;
}

function extract_table_request(raw_value: string, raw_view_id?: string): {
  _entity_name: string;
  _view_id: string;
} | null {
  if (/\bwith\b/iu.test(raw_value)) {
    return null;
  }

  const entity_name = normalize_request_id(raw_value);
  if (!entity_name) {
    return null;
  }

  if (raw_view_id !== undefined) {
    const view_id = normalize_request_id(raw_view_id);
    if (!view_id) {
      return null;
    }

    return {
      _entity_name: entity_name,
      _view_id: view_id,
    };
  }

  return {
    _entity_name: entity_name,
    _view_id: `${entity_name}-list`,
  };
}

export class TableProcessor implements XVibeIntentProcessor {
  private diagnostic_reason = "table_processor_no_match";

  async analyze(
    request: XVibeIntentEngineRequest,
  ): Promise<XVibeIntentResult | null> {
    const message = request._message.trim();
    if (!message) {
      return this.skip("empty_message");
    }

    if (
      FORBIDDEN_TABLE_ACTION_PATTERN.test(message) &&
      FORBIDDEN_ACTION_PATTERN.test(message)
    ) {
      return this.skip("forbidden_table_action");
    }

    const table_for_match = CREATE_TABLE_FOR_PATTERN.exec(message);
    const entity_table_match = table_for_match
      ? null
      : CREATE_ENTITY_TABLE_PATTERN.exec(message);
    const raw_table_request =
      table_for_match?.[1]?.trim() ?? entity_table_match?.[1]?.trim();
    const raw_view_id =
      table_for_match?.[2]?.trim() ?? entity_table_match?.[2]?.trim();
    if (!raw_table_request) {
      return this.skip("table_create_pattern_no_match");
    }

    const table_request = extract_table_request(
      raw_table_request,
      raw_view_id,
    );
    if (!table_request) {
      return this.skip("invalid_table_request");
    }

    this.diagnostic_reason = "table_processor_matched";
    _xlog.log("[xvibe] table processor matched", {
      _entity_name: table_request._entity_name,
      _view_id: table_request._view_id,
    });

    return {
      _message_type: "generate",
      _execution_level: "artifact",
      _should_mutate: true,
      _confidence: 1,
      _reason: "Create table artifact request.",
      _artifact_type: "table",
      _artifact_request: {
        _operation: "create",
        _entity_name: table_request._entity_name,
        _view_id: table_request._view_id,
      },
      _actions: [],
    };
  }

  _diagnostic_reason(): string | undefined {
    return this.diagnostic_reason;
  }

  private skip(reason: string): null {
    this.diagnostic_reason = reason;
    _xlog.log("[xvibe] table processor skipped", {
      _reason: reason,
    });
    return null;
  }
}
