import { _xlog, _xu } from "@xpell/core";
import type {
  XVibeIntentEngineRequest,
  XVibeIntentResult,
} from "../XVibeTypes.js";
import type { XVibeIntentProcessor } from "./XVibeIntentProcessor.js";

const CREATE_FLOW_PATTERN =
  /^\s*(?:create|add)\s+(?:a\s+)?flow\s+(?:called\s+|named\s+)?([\s\S]+?)(?=\s+(?:that|for|to|with)\b|[.!?]?\s*$)/iu;
const CREATE_XDATA_SET_FLOW_PATTERN =
  /^\s*(?:create|add)\s+(?:a\s+)?flow\s+(?:called\s+|named\s+)?([\s\S]+?)\s+with\s+one\s+step\s+that\s+sets?\s+xdata\s+key\s+([^\s"'`]+)\s+to\s+(["'])([\s\S]*?)\3\s*[.!?]?\s*$/iu;
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

function build_xdata_set_flow_request(input: {
  _flow_id: string;
  _xdata_key: string;
  _xdata_value: string;
}) {
  return {
    _operation: "create",
    _flow_id: input._flow_id,
    _action: "xdata-set",
    _xdata_key: input._xdata_key,
    _xdata_value: input._xdata_value,
  };
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

    const xdata_set_match =
      CREATE_XDATA_SET_FLOW_PATTERN.exec(message);
    if (xdata_set_match) {
      const flow_id =
        normalize_request_id(strip_trailing_punctuation(xdata_set_match[1] ?? ""));
      if (!flow_id) {
        return this.skip("invalid_flow_id");
      }

      const xdata_key = (xdata_set_match[2] ?? "").trim();
      if (!xdata_key) {
        return this.skip("invalid_xdata_key");
      }

      const xdata_value = xdata_set_match[4] ?? "";
      const artifact_request =
        build_xdata_set_flow_request({
          _flow_id: flow_id,
          _xdata_key: xdata_key,
          _xdata_value: xdata_value,
        });
      const action_params = {
        _app_id: request._runtime_context._app_id,
        _env: request._runtime_context._env,
        _artifact_type: "flow",
        _artifact_request: artifact_request,
      };

      this.diagnostic_reason = "flow_processor_matched";
      _xlog.log("[xvibe] flow creation intent matched", {
        _flow_id: flow_id,
        _step_count: 1,
      });
      _xlog.log("[xvibe] flow creation compiled", {
        _flow_id: flow_id,
        _step_ops: ["xd.set"],
      });

      return {
        _message_type: "generate",
        _execution_level: "artifact",
        _should_mutate: true,
        _confidence: 1,
        _reason: "Create flow artifact request.",
        _artifact_type: "flow",
        _artifact_request: artifact_request,
        _actions: [
          {
            _id: `create-flow-${flow_id}`,
            _title: `Create flow ${flow_id}`,
            _description: `Persist flow ${flow_id}.`,
            _action_type: "module-op",
            _status: "suggested",
            _requires_approval: true,
            _executable: true,
            _params: action_params,
            _execution_payload: {
              _module: "xvibe",
              _op: "apply-artifact-request",
              _params: action_params,
            },
          },
        ],
      };
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
      return this.skip("flow_step_request_no_match");
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
