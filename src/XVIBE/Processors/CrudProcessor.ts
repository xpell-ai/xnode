import { _xlog, _xu } from "@xpell/core";
import {
  ExecutionGraphPlanner,
  normalizeExecutionGraphFields,
  type ExecutionGraphFieldDescriptor,
} from "../ExecutionGraph/ExecutionGraphPlanner.js";
import type {
  XVibeIntentEngineRequest,
  XVibeIntentResult,
} from "../XVibeTypes.js";
import type { XVibeIntentProcessor } from "./XVibeIntentProcessor.js";

const ENTITY_CRUD_PATTERN =
  /^\s*(?:create|build|generate)\s+([\s\S]+?)\s+crud(?:\s*(?::|\bwith\b|\bhaving\b)\s*([\s\S]*))?\s*[.!?]?\s*$/iu;
const CRUD_FOR_ENTITY_PATTERN =
  /^\s*create\s+crud\s+for\s+([\s\S]+?)(?:\s*(?::|\bwith\b|\bhaving\b)\s*([\s\S]*))?\s*[.!?]?\s*$/iu;
const FIELD_ITEM_PATTERN = /[\n,]+/u;

function normalize_request_id(value: string): string | null {
  const normalized = _xu.normalize_id(value);
  return normalized || null;
}

function extract_field_descriptors(
  raw_fields: string | undefined,
): ExecutionGraphFieldDescriptor[] {
  if (!raw_fields?.trim()) {
    return [];
  }

  return normalizeExecutionGraphFields(
    raw_fields
      .split(FIELD_ITEM_PATTERN)
      .map((field) => field.trim())
      .filter((field) => field.length > 0),
  );
}

export class CrudProcessor implements XVibeIntentProcessor {
  private readonly execution_graph_planner: ExecutionGraphPlanner;
  private diagnostic_reason = "crud_processor_no_match";

  constructor(execution_graph_planner = new ExecutionGraphPlanner()) {
    this.execution_graph_planner = execution_graph_planner;
  }

  async analyze(
    request: XVibeIntentEngineRequest,
  ): Promise<XVibeIntentResult | null> {
    const message = request._message.trim();
    if (!message) {
      return this.skip("empty_message");
    }

    const crud_for_match = CRUD_FOR_ENTITY_PATTERN.exec(message);
    const entity_crud_match = crud_for_match
      ? null
      : ENTITY_CRUD_PATTERN.exec(message);
    const raw_entity_name =
      crud_for_match?.[1]?.trim() ?? entity_crud_match?.[1]?.trim();
    const fields = extract_field_descriptors(
      crud_for_match?.[2] ?? entity_crud_match?.[2],
    );
    if (!raw_entity_name) {
      return this.skip("crud_create_pattern_no_match");
    }

    const entity_name = normalize_request_id(raw_entity_name);
    if (!entity_name) {
      return this.skip("invalid_entity_name");
    }

    const execution_graph =
      await this.execution_graph_planner.planCrud({
        _app_id: request._runtime_context._app_id,
        _env: request._runtime_context._env,
        _entity_name: entity_name,
        _fields: fields,
      });

    this.diagnostic_reason = "crud_processor_matched";
    if (fields.length > 0) {
      _xlog.log("[xvibe] crud fields parsed", {
        _entity_name: entity_name,
        _fields: fields,
      });
    }
    _xlog.log("[xvibe] crud processor matched", {
      _entity_name: entity_name,
    });

    return {
      _message_type: "plan",
      _execution_level: "artifact",
      _should_mutate: true,
      _confidence: 1,
      _reason: "Create CRUD execution plan.",
      _artifact_type: "execution-graph",
      _artifact_request: {
        _operation: "plan",
        _graph_type: "crud",
        _entity_name: entity_name,
        ...(fields.length > 0 ? { _fields: fields } : {}),
        _execution_graph: execution_graph,
      },
      _actions: [],
    };
  }

  _diagnostic_reason(): string | undefined {
    return this.diagnostic_reason;
  }

  private skip(reason: string): null {
    this.diagnostic_reason = reason;
    return null;
  }
}
