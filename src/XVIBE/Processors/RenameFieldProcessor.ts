import { _xlog, _xu } from "@xpell/core";
import type {
  XVibeIntentEngineRequest,
  XVibeIntentResult,
} from "../XVibeTypes.js";
import type { XVibeIntentProcessor } from "./XVibeIntentProcessor.js";

const RENAME_FIELD_PATTERN =
  /^\s*rename\s+([a-zA-Z0-9_-]+)(?:\s+field)?\s+to\s+([a-zA-Z0-9_-]+)(?:\s+in\s+([\s\S]+?)(?:\s+crud)?)?\s*[.!?]?\s*$/iu;

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

export class RenameFieldProcessor implements XVibeIntentProcessor {
  private diagnostic_reason = "rename_field_processor_no_match";

  async analyze(
    request: XVibeIntentEngineRequest,
  ): Promise<XVibeIntentResult | null> {
    const message = request._message.trim();
    if (!message) {
      return this.skip("empty_message");
    }

    const match = RENAME_FIELD_PATTERN.exec(message);
    const raw_old_field = match?.[1]?.trim();
    const raw_new_field = match?.[2]?.trim();
    const raw_entity_name = match?.[3]?.trim();
    if (!raw_old_field || !raw_new_field) {
      return this.skip("rename_field_pattern_no_match");
    }

    const old_field = normalize_request_id(raw_old_field);
    if (!old_field) {
      return this.skip("invalid_old_field");
    }

    const new_field = normalize_request_id(raw_new_field);
    if (!new_field) {
      return this.skip("invalid_new_field");
    }

    const entity_name = raw_entity_name
      ? normalize_request_id(raw_entity_name)
      : infer_single_context_entity(request);
    if (!entity_name) {
      return this.skip("missing_entity_name");
    }

    this.diagnostic_reason = "rename_field_processor_matched";
    _xlog.log("[xvibe] rename field processor matched", {
      _entity_name: entity_name,
      _old_field: old_field,
      _new_field: new_field,
    });

    return {
      _message_type: "generate",
      _execution_level: "artifact",
      _should_mutate: true,
      _confidence: 1,
      _reason: "Rename field in existing CRUD artifacts.",
      _artifact_type: "crud-evolution",
      _artifact_request: {
        _operation: "rename-field",
        _entity_name: entity_name,
        _old_field: old_field,
        _new_field: new_field,
      },
      _actions: [],
    };
  }

  _diagnostic_reason(): string | undefined {
    return this.diagnostic_reason;
  }

  private skip(reason: string): null {
    this.diagnostic_reason = reason;
    _xlog.log("[xvibe] rename field processor skipped", {
      _reason: reason,
    });
    return null;
  }
}
