import { _xlog, _xu } from "@xpell/core";
import type {
  XVibeIntentEngineRequest,
  XVibeIntentResult,
} from "../XVibeTypes.js";
import type { XVibeIntentProcessor } from "./XVibeIntentProcessor.js";

const CREATE_FLOW_PATTERN =
  /^\s*(?:create|add)\s+(?:a\s+)?flow\s+(?:called\s+|named\s+)?([\s\S]+?)(?=\s+(?:that|for|to)\b|[.!?]?\s*$)/iu;
const FORBIDDEN_FLOW_ACTION_PATTERN = /\bflow\b/iu;
const FORBIDDEN_ACTION_PATTERN =
  /\b(?:delete|modify|rename|update|remove|edit)\b/iu;
const UNSUPPORTED_FLOW_STEP_PATTERN =
  /\b(?:delete|modify|rename|update|remove|edit)\b/iu;

function normalize_request_id(value: string): string | null {
  const normalized = _xu.normalize_id(value);
  return normalized || null;
}

function strip_trailing_punctuation(value: string): string {
  return value.trim().replace(/[.!?]+$/u, "").trim();
}

function extract_entity_name(flow_request_tail: string): string | null {
  const entity_manager_add_match =
    /\bentity-manager\s*\.\s*add\s+for\s+([\s\S]+?)(?:[.!?]?\s*)$/iu.exec(
      flow_request_tail,
    );
  const entity_from_entity_manager =
    entity_manager_add_match?.[1]?.trim();
  if (entity_from_entity_manager) {
    return normalize_request_id(strip_trailing_punctuation(entity_from_entity_manager));
  }

  const entity_add_with_suffix_match =
    /\badds?\s+([\s\S]+?)\s+entity(?:[.!?]?\s*)$/iu.exec(
      flow_request_tail,
    );
  const entity_from_add_with_suffix =
    entity_add_with_suffix_match?.[1]?.trim();
  if (entity_from_add_with_suffix) {
    return normalize_request_id(entity_from_add_with_suffix);
  }

  const entity_add_match =
    /\badds?\s+([\s\S]+?)(?:[.!?]?\s*)$/iu.exec(flow_request_tail);
  const entity_from_add = entity_add_match?.[1]?.trim();
  if (entity_from_add) {
    return normalize_request_id(strip_trailing_punctuation(entity_from_add));
  }

  const for_entity_match =
    /\bfor\s+([\s\S]+?)(?:\s+entity)?(?:[.!?]?\s*)$/iu.exec(
      flow_request_tail,
    );
  const entity_from_for = for_entity_match?.[1]?.trim();
  if (entity_from_for) {
    return normalize_request_id(strip_trailing_punctuation(entity_from_for));
  }

  return null;
}

export class FlowProcessor implements XVibeIntentProcessor {
  private diagnostic_reason = "flow_processor_no_match";

  async analyze(
    request: XVibeIntentEngineRequest,
  ): Promise<XVibeIntentResult | null> {
    const message = request._message.trim();
    if (!message) {
      return this.skip("empty_message");
    }

    if (
      FORBIDDEN_FLOW_ACTION_PATTERN.test(message) &&
      FORBIDDEN_ACTION_PATTERN.test(message)
    ) {
      return this.skip("forbidden_flow_action");
    }

    const flow_match = CREATE_FLOW_PATTERN.exec(message);
    const raw_flow_id = flow_match?.[1]?.trim();
    if (!flow_match || !raw_flow_id) {
      return this.skip("flow_create_pattern_no_match");
    }

    const flow_id = normalize_request_id(raw_flow_id);
    if (!flow_id) {
      return this.skip("invalid_flow_id");
    }

    const after_flow_id = message.slice(flow_match.index + flow_match[0].length);
    if (UNSUPPORTED_FLOW_STEP_PATTERN.test(after_flow_id)) {
      return this.skip("unsupported_flow_step_action");
    }

    const entity_name = extract_entity_name(after_flow_id);
    if (!entity_name) {
      return this.skip("entity_add_request_no_match");
    }

    this.diagnostic_reason = "flow_processor_matched";
    _xlog.log("[xvibe] flow processor matched", {
      _flow_id: flow_id,
      _entity_name: entity_name,
    });

    return {
      _message_type: "generate",
      _execution_level: "artifact",
      _should_mutate: true,
      _confidence: 1,
      _reason: "Create flow artifact request.",
      _artifact_type: "flow",
      _artifact_request: {
        _operation: "create",
        _flow_id: flow_id,
        _entity_name: entity_name,
        _action: "entity-add",
      },
      _actions: [],
    };
  }

  _diagnostic_reason(): string | undefined {
    return this.diagnostic_reason;
  }

  private skip(reason: string): null {
    this.diagnostic_reason = reason;
    _xlog.log("[xvibe] flow processor skipped", {
      _reason: reason,
    });
    return null;
  }
}
