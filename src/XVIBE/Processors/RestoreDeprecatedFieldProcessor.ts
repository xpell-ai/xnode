import { _xlog, _xu } from "@xpell/core";
import type {
  XVibeIntentEngineRequest,
  XVibeIntentResult,
} from "../XVibeTypes.js";
import type { XVibeIntentProcessor } from "./XVibeIntentProcessor.js";

const RESTORE_FIELD_PATTERNS = [
  /^\s*restore\s+([a-zA-Z0-9_-]+)(?:\s+field)?(?:\s+(?:in|to)\s+([\s\S]+?)(?:\s+crud)?)?\s*[.!?]?\s*$/iu,
  /^\s*undeprecate\s+([a-zA-Z0-9_-]+)(?:\s+field)?(?:\s+in\s+([\s\S]+?)(?:\s+crud)?)?\s*[.!?]?\s*$/iu,
  /^\s*bring\s+back\s+([a-zA-Z0-9_-]+)(?:\s+field)?(?:\s+(?:in|to)\s+([\s\S]+?)(?:\s+crud)?)?\s*[.!?]?\s*$/iu,
];

function normalize_request_id(value: string): string | null {
  const normalized = _xu.normalize_id(value);
  return normalized || null;
}

function infer_single_context_entity(
  request: XVibeIntentEngineRequest,
): string | null {
  const entities = request._runtime_context._available_artifacts?._entities;
  if (!Array.isArray(entities)) {
    return null;
  }

  const normalized_entities = Array.from(
    new Set(
      entities
        .map((entity) =>
          typeof entity === "string" ? normalize_request_id(entity) : null,
        )
        .filter((entity): entity is string => entity !== null),
    ),
  );

  return normalized_entities.length === 1 ? normalized_entities[0] : null;
}

export class RestoreDeprecatedFieldProcessor implements XVibeIntentProcessor {
  private diagnostic_reason = "restore_deprecated_field_processor_no_match";

  async analyze(
    request: XVibeIntentEngineRequest,
  ): Promise<XVibeIntentResult | null> {
    const message = request._message.trim();
    if (!message) {
      return this.skip("empty_message");
    }

    const match = RESTORE_FIELD_PATTERNS
      .map((pattern) => pattern.exec(message))
      .find((result) => result !== null);
    const raw_field_name = match?.[1]?.trim();
    const raw_entity_name = match?.[2]?.trim();
    if (!raw_field_name) {
      return this.skip("restore_field_pattern_no_match");
    }

    const field_name = normalize_request_id(raw_field_name);
    if (!field_name) {
      return this.skip("invalid_field_name");
    }

    const entity_name = raw_entity_name
      ? normalize_request_id(raw_entity_name)
      : infer_single_context_entity(request);
    if (!entity_name) {
      return this.skip("missing_entity_name");
    }

    this.diagnostic_reason = "restore_deprecated_field_processor_matched";
    _xlog.log("[xvibe] restore deprecated field processor matched", {
      _entity_name: entity_name,
      _field_name: field_name,
    });

    return {
      _message_type: "generate",
      _execution_level: "artifact",
      _should_mutate: true,
      _confidence: 1,
      _reason: "Restore deprecated field in existing CRUD artifacts.",
      _artifact_type: "crud-evolution",
      _artifact_request: {
        _operation: "restore-field",
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
    _xlog.log("[xvibe] restore deprecated field processor skipped", {
      _reason: reason,
    });
    return null;
  }
}
