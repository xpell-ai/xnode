import { _xlog, _xu } from "@xpell/core";
import type {
  XVibeIntentEngineRequest,
  XVibeIntentResult,
} from "../XVibeTypes.js";
import type { XVibeIntentProcessor } from "./XVibeIntentProcessor.js";

const CREATE_ENTITY_PATTERN =
  /^\s*(?:create|add|make)\s+(?:an?\s+)?(?:xdb\s+)?entity(?:\s+(?:called|named))?\s+([\s\S]+?)\s*[.!?]?\s*$/iu;
const ENTITY_FIELDS_PATTERN =
  /^([\s\S]+?)(?:\s+with\s*:?\s*([\s\S]*))?$/iu;
const FORBIDDEN_ENTITY_ACTION_PATTERN =
  /\bentity\b/iu;
const FORBIDDEN_ACTION_PATTERN =
  /\b(?:delete|modify|rename|update)\b/iu;
const FIELD_ITEM_PATTERN = /[\n,]+/u;
const RESERVED_ENTITY_FIELDS = new Set([
  "_id",
  "_created_at",
  "_updated_at",
]);

function normalize_field_name(value: string): string | undefined {
  const cleaned = value
    .trim()
    .replace(/^[-*]\s*/u, "")
    .replace(/^\d+[.)]\s*/u, "")
    .trim();
  if (RESERVED_ENTITY_FIELDS.has(cleaned.toLowerCase())) {
    return undefined;
  }
  const normalized = _xu.normalize_id(cleaned);
  return normalized || undefined;
}

function extract_entity_request_parts(raw_request: string): {
  _entity_name: string;
  _fields: { _name: string }[];
} | null {
  const request_match = ENTITY_FIELDS_PATTERN.exec(raw_request.trim());
  const raw_entity_name = request_match?.[1]?.trim();
  if (!raw_entity_name) {
    return null;
  }

  const entity_name = _xu.normalize_id(raw_entity_name);
  if (!entity_name) {
    return null;
  }

  const raw_fields = request_match?.[2]?.trim();
  if (!raw_fields) {
    return {
      _entity_name: entity_name,
      _fields: [],
    };
  }

  const seen_fields = new Set<string>();
  const fields = raw_fields
    .split(FIELD_ITEM_PATTERN)
    .map((field) => normalize_field_name(field))
    .filter((field): field is string => {
      if (!field || seen_fields.has(field)) {
        return false;
      }
      seen_fields.add(field);
      return true;
    })
    .map((field) => ({ _name: field }));

  return {
    _entity_name: entity_name,
    _fields: fields,
  };
}

export class EntityProcessor implements XVibeIntentProcessor {
  private diagnostic_reason = "entity_processor_no_match";

  async analyze(
    request: XVibeIntentEngineRequest,
  ): Promise<XVibeIntentResult | null> {
    const message = request._message.trim();
    if (!message) {
      return this.skip("empty_message");
    }

    if (
      FORBIDDEN_ENTITY_ACTION_PATTERN.test(message) &&
      FORBIDDEN_ACTION_PATTERN.test(message)
    ) {
      return this.skip("forbidden_entity_action");
    }

    const match = CREATE_ENTITY_PATTERN.exec(message);
    const raw_entity_request = match?.[1]?.trim();
    if (!raw_entity_request) {
      return this.skip("entity_create_pattern_no_match");
    }

    const entity_request = extract_entity_request_parts(raw_entity_request);
    if (!entity_request) {
      return this.skip("invalid_entity_name");
    }
    const entity_name = entity_request._entity_name;

    if (entity_request._fields.length > 0) {
      _xlog.log("[xvibe] entity fields extracted", {
        _entity_name: entity_name,
        _field_count: entity_request._fields.length,
      });
    }

    this.diagnostic_reason = "entity_processor_matched";
    _xlog.log("[xvibe] entity processor matched", {
      _entity_name: entity_name,
    });

    return {
      _message_type: "generate",
      _execution_level: "artifact",
      _should_mutate: true,
      _confidence: 1,
      _reason: "Create entity artifact request.",
      _artifact_type: "entity",
      _artifact_request: {
        _operation: "create",
        _entity_name: entity_name,
        ...(entity_request._fields.length > 0
          ? { _fields: entity_request._fields }
          : {}),
      },
      _actions: [],
    };
  }

  _diagnostic_reason(): string | undefined {
    return this.diagnostic_reason;
  }

  private skip(reason: string): null {
    this.diagnostic_reason = reason;
    _xlog.log("[xvibe] entity processor skipped", {
      _reason: reason,
    });
    return null;
  }
}
