import { _x, _xlog, _xu } from "@xpell/core";
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
const DEFAULT_SUGGESTION_FALLBACK_FIELDS = ["name", "description", "status"];
const PRODUCT_SUGGESTION_FALLBACK_FIELDS = [
  "name",
  "description",
  "price",
  "category",
  "stock",
  "status",
];
const MAX_SUGGESTED_FIELDS = 8;
const MANAGED_FIELD_NAMES = new Set([
  "_id",
  "id",
  "created_at",
  "updated_at",
  "_created_at",
  "_updated_at",
]);
const crud_field_suggestion_cache = new Map<
  string,
  ExecutionGraphFieldDescriptor[]
>();

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

function normalize_entity_prefix_candidates(entity_name: string): string[] {
  const normalized = entity_name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const without_numeric_suffix = normalized.replace(/\d+$/u, "");
  return [...new Set([normalized, without_numeric_suffix])].filter(
    (candidate) => candidate.length > 0,
  );
}

function remove_entity_prefix(
  field_name: string,
  entity_name: string,
): string {
  for (const prefix of normalize_entity_prefix_candidates(entity_name)) {
    const prefix_with_separator = `${prefix}_`;
    if (field_name.startsWith(prefix_with_separator)) {
      return field_name.slice(prefix_with_separator.length);
    }
  }

  return field_name;
}

function is_disallowed_suggested_field(field_name: string): boolean {
  return MANAGED_FIELD_NAMES.has(field_name) || field_name.endsWith("_id");
}

function normalize_suggested_field_name(
  value: unknown,
  entity_name: string,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const raw_normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_");
  if (is_disallowed_suggested_field(raw_normalized)) {
    return null;
  }

  const normalized = remove_entity_prefix(
    value
      .trim()
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, ""),
    entity_name,
  );

  if (!normalized || is_disallowed_suggested_field(normalized)) {
    return null;
  }

  return normalized;
}

function normalize_suggested_fields(
  values: unknown,
  entity_name: string,
): ExecutionGraphFieldDescriptor[] {
  const raw_values = Array.isArray(values) ? values : [];
  const fields: ExecutionGraphFieldDescriptor[] = [];
  const seen = new Set<string>();

  for (const value of raw_values) {
    const raw_name =
      typeof value === "string"
        ? value
        : _xu.is_plain_object(value)
          ? value._name ?? value.name ?? value._field ?? value.field
          : null;
    const field_name = normalize_suggested_field_name(raw_name, entity_name);
    if (!field_name || seen.has(field_name)) {
      continue;
    }

    seen.add(field_name);
    fields.push({ _name: field_name });
    if (fields.length >= MAX_SUGGESTED_FIELDS) {
      break;
    }
  }

  return fields;
}

function read_xai_suggestion_fields(
  value: unknown,
  entity_name: string,
): ExecutionGraphFieldDescriptor[] {
  const result = _xu.is_plain_object(value) ? value._result ?? value : value;
  const object_payload =
    _xu.is_plain_object(result) && _xu.is_plain_object(result._object)
      ? result._object
      : result;

  if (_xu.is_plain_object(object_payload)) {
    const direct_fields =
      object_payload._fields ??
      object_payload.fields ??
      object_payload.suggested_fields ??
      object_payload._suggested_fields;
    const direct_result = normalize_suggested_fields(
      direct_fields,
      entity_name,
    );
    if (direct_result.length > 0) {
      return direct_result;
    }
  }

  const text =
    _xu.is_plain_object(result) && typeof result._text === "string"
      ? result._text
      : typeof result === "string"
        ? result
        : null;
  if (!text) {
    return [];
  }

  const parsed = _xu.safe_json_parse(text, null);
  if (_xu.is_plain_object(parsed)) {
    return read_xai_suggestion_fields(parsed, entity_name);
  }

  return normalize_suggested_fields(text.split(FIELD_ITEM_PATTERN), entity_name);
}

function fallback_suggested_fields(entity_name: string): string[] {
  if (entity_name.startsWith("product")) {
    return PRODUCT_SUGGESTION_FALLBACK_FIELDS;
  }

  return DEFAULT_SUGGESTION_FALLBACK_FIELDS;
}

async function suggest_crud_fields(
  entity_name: string,
): Promise<ExecutionGraphFieldDescriptor[]> {
  const cached = crud_field_suggestion_cache.get(entity_name);
  if (cached) {
    _xlog.log("[xvibe] crud field suggestion cache hit", {
      _entity_name: entity_name,
    });
    return cached.map((field) => ({ ...field }));
  }

  try {
    const xai_response = await _x.execute({
      _module: "xai",
      _op: "generate",
      _params: {
        _task: "crud-field-suggestion",
        _capability: "json",
        _prompt:
          `Suggest minimal CRUD starter fields for entity '${entity_name}'. ` +
          `Return JSON only as {"_fields":["field_name"]}. Include at most ${MAX_SUGGESTED_FIELDS} fields. ` +
          "Use snake_case lowercase field ids only. Prefer user-facing application fields. " +
          "Do not include entity-prefixed fields. Do not include id fields, *_id fields, created_at, or updated_at.",
        response_format: {
          type: "json_object",
        },
      },
    } as any);

    if (xai_response?._ok) {
      const xai_fields = read_xai_suggestion_fields(xai_response, entity_name);
      if (xai_fields.length > 0) {
        crud_field_suggestion_cache.set(
          entity_name,
          xai_fields.map((field) => ({ ...field })),
        );
        _xlog.log("[xvibe] crud field suggestion xai received", {
          _entity_name: entity_name,
          _fields: xai_fields,
        });
        return xai_fields;
      }
    }
  } catch (error) {
    _xlog.log("[xvibe] crud field suggestion xai unavailable", {
      _entity_name: entity_name,
      _error: error instanceof Error ? error.message : String(error),
    });
  }

  const fallback_fields = normalize_suggested_fields(
    fallback_suggested_fields(entity_name),
    entity_name,
  );
  crud_field_suggestion_cache.set(
    entity_name,
    fallback_fields.map((field) => ({ ...field })),
  );
  _xlog.log("[xvibe] crud field suggestion fallback used", {
    _entity_name: entity_name,
    _fields: fallback_fields,
  });
  return fallback_fields;
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

    if (fields.length === 0) {
      const suggested_fields = await suggest_crud_fields(entity_name);
      this.diagnostic_reason = "crud_processor_field_suggestion";
      _xlog.log("[xvibe] crud field suggestion returned", {
        _entity_name: entity_name,
        _fields: suggested_fields,
      });

      return {
        _message_type: "generate",
        _execution_level: "artifact",
        _should_mutate: true,
        _confidence: 1,
        _reason: "Suggest CRUD fields before generating artifacts.",
        _artifact_type: "crud-field-suggestion",
        _artifact_request: {
          _operation: "suggest-fields",
          _entity_name: entity_name,
          _fields: suggested_fields,
        },
        _actions: [],
      };
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
