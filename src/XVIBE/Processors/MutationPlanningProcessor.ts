import { _x, _xlog, _xu } from "@xpell/core";
import type {
  XVibeIntentEngineRequest,
  XVibeIntentRuntimeContext,
  XVibeIntentResult,
} from "../XVibeTypes.js";
import {
  canonicalizeSemanticViewEditParams,
  isStructuredViewEditAction,
} from "../StructuredEditing/StructuredViewEdit.js";
import { resolveProjectViewId } from "../StructuredEditing/ProjectViewResolution.js";
import { resolveViewTarget } from "../StructuredEditing/ViewTargetResolution.js";
import type { XVibeIntentProcessor } from "./XVibeIntentProcessor.js";

type MutationPlanPrimitiveDescriptor = {
  _module: "xvibe";
  _op: "apply-view-edit";
  _params: Record<string, unknown>;
};

type MutationPlanStep = {
  _id: string;
  _title: string;
  _status: "planned" | "unsupported";
  _primitive?: MutationPlanPrimitiveDescriptor;
  _reason?: string;
  _target_text?: string;
  _button_id?: string;
  _button_text?: string;
  _parent_id?: string;
  _flow_id?: string;
  _view_id?: string;
  _target_id?: string;
  _target_type?: string;
  _child?: Record<string, unknown>;
  _property_name?: string;
  _property_value?: unknown;
};

type MutationPlanButton = {
  _id: "apply-plan" | "edit-plan" | "cancel-plan";
  _title: "Apply Plan" | "Edit Plan" | "Cancel";
  _status: "placeholder";
};

type MutationPlanArtifact = {
  _type: "mutation-plan";
  _title: string;
  _goal: string;
  _summary: string;
  _steps: MutationPlanStep[];
  _estimated_mutations: number;
  _executable_steps: number;
  _unsupported_steps: number;
  _can_apply: boolean;
  _status: "planned";
  _buttons: MutationPlanButton[];
};

type MutationPlanMatch = {
  _title: string;
  _goal: string;
  _steps: MutationPlanStep[];
};

const PLACEHOLDER_BUTTONS: MutationPlanButton[] = [
  {
    _id: "apply-plan",
    _title: "Apply Plan",
    _status: "placeholder",
  },
  {
    _id: "edit-plan",
    _title: "Edit Plan",
    _status: "placeholder",
  },
  {
    _id: "cancel-plan",
    _title: "Cancel",
    _status: "placeholder",
  },
];

function normalize_prompt(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[“”]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .replace(/[^a-z0-9\s"'-]+/gu, " ")
    .replace(/\s+/gu, " ");
}

function title_case(value: string): string {
  return value
    .split(/\s+/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function title_from_id(value: string): string {
  return value
    .split(/[-_\s]+/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function sentence_goal(value: string): string {
  const trimmed = value.trim().replace(/\s+/gu, " ");
  if (!trimmed) return "Plan deterministic mutations.";
  return /[.!?]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
}

function safe_step_id(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "mutation-step";
}

function planned_step(id: string, title: string): MutationPlanStep {
  return {
    _id: id,
    _title: title,
    _status: "planned",
  };
}

function planned_move_step(target_text: string): MutationPlanStep {
  return {
    _id: `move-${safe_step_id(target_text)}-button`,
    _title: `Move ${target_text} button`,
    _status: "planned",
    _target_text: target_text,
  };
}

function planned_add_button_step(input: {
  button_id: string;
  button_text: string;
  parent_id: string;
}): MutationPlanStep {
  return {
    _id: `add-${safe_step_id(input.button_text)}-button-to-toolbar`,
    _title: `Add ${input.button_text} button to toolbar`,
    _status: "planned",
    _button_id: input.button_id,
    _button_text: input.button_text,
    _parent_id: input.parent_id,
  };
}

function planned_bind_button_flow_step(input: {
  button_id: string;
  button_text: string;
  flow_id: string;
}): MutationPlanStep {
  return {
    _id: `bind-${safe_step_id(input.button_text)}-button-to-${safe_step_id(input.flow_id)}`,
    _title: `Bind ${input.button_text} button to ${input.flow_id}`,
    _status: "planned",
    _button_id: input.button_id,
    _button_text: input.button_text,
    _flow_id: input.flow_id,
  };
}

function unsupported_step(id: string, title: string, reason: string): MutationPlanStep {
  return {
    _id: id,
    _title: title,
    _status: "unsupported",
    _reason: reason,
  };
}

function omit_undefined_properties<T extends Record<string, unknown>>(value: T): T {
  const next: Record<string, unknown> = {};
  for (const [key, property_value] of Object.entries(value)) {
    if (property_value !== undefined) {
      next[key] = property_value;
    }
  }
  return next as T;
}

function read_non_empty_string(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function read_current_view_id(runtime_context: XVibeIntentRuntimeContext): string {
  const current_artifact =
    _xu.is_plain_object(runtime_context._current_artifact)
      ? runtime_context._current_artifact
      : undefined;
  return (
    read_non_empty_string(runtime_context._active_view_id) ??
    read_non_empty_string(current_artifact?._id) ??
    "main"
  );
}

function has_explicit_view_context(runtime_context: XVibeIntentRuntimeContext): boolean {
  const current_artifact =
    _xu.is_plain_object(runtime_context._current_artifact)
      ? runtime_context._current_artifact
      : undefined;
  return Boolean(
    read_non_empty_string(runtime_context._active_view_id) ??
    read_non_empty_string(current_artifact?._id) ??
    (_xu.is_plain_object(runtime_context._current_view) ? "current_view" : null)
  );
}

function deterministic_toolbar_id(view_id: string): string {
  const normalized =
    view_id
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/-+/gu, "-")
      .replace(/^-|-$/gu, "");
  return `${normalized || "main"}-toolbar`;
}

function validate_primitive_params(
  params: Record<string, unknown>,
): { _ok: true; _params: Record<string, unknown> } | { _ok: false; _reason: string } {
  const canonical =
    canonicalizeSemanticViewEditParams(params);
  if (!canonical._ok) {
    return { _ok: false, _reason: canonical._reason };
  }

  const edit_action =
    canonical._params._edit_action;
  if (!isStructuredViewEditAction(edit_action)) {
    return { _ok: false, _reason: "unsupported_edit_action" };
  }

  if (!read_non_empty_string(canonical._params._app_id)) {
    return { _ok: false, _reason: "missing_app_id" };
  }
  if (!read_non_empty_string(canonical._params._env)) {
    return { _ok: false, _reason: "missing_env" };
  }
  if (!read_non_empty_string(canonical._params._view_id)) {
    return { _ok: false, _reason: "missing_view_id" };
  }

  if (edit_action === "add-child") {
    const child =
      canonical._params._child;
    if (!_xu.is_plain_object(child)) {
      return { _ok: false, _reason: "missing_child" };
    }
    if (!read_non_empty_string(child._type)) {
      return { _ok: false, _reason: "missing_child_type" };
    }
    if (!read_non_empty_string(canonical._params._target_id)) {
      return { _ok: false, _reason: "missing_target_id" };
    }
  }

  if (edit_action === "move-object") {
    if (!read_non_empty_string(canonical._params._target_id)) {
      return { _ok: false, _reason: "missing_target_id" };
    }
    if (!read_non_empty_string(canonical._params._target_type)) {
      return { _ok: false, _reason: "missing_target_type" };
    }
    if (!read_non_empty_string(canonical._params._position)) {
      return { _ok: false, _reason: "missing_move_position" };
    }
    if (!read_non_empty_string(canonical._params._destination_id)) {
      return { _ok: false, _reason: "missing_destination_id" };
    }
  }

  if (edit_action === "bind-flow") {
    if (!read_non_empty_string(canonical._params._target_id)) {
      return { _ok: false, _reason: "missing_target_id" };
    }
    if (!read_non_empty_string(canonical._params._target_type)) {
      return { _ok: false, _reason: "missing_target_type" };
    }
    const flow =
      canonical._params._flow;
    if (!_xu.is_plain_object(flow)) {
      return { _ok: false, _reason: "missing_flow" };
    }
    if (!read_non_empty_string(flow._id)) {
      return { _ok: false, _reason: "missing_flow_id" };
    }
    if (!read_non_empty_string(canonical._params._flow_event)) {
      return { _ok: false, _reason: "missing_flow_event" };
    }
  }

  if (edit_action === "set-property" || edit_action === "update-property") {
    if (!read_non_empty_string(canonical._params._target_id)) {
      return { _ok: false, _reason: "missing_target_id" };
    }
    if (!read_non_empty_string(canonical._params._target_type)) {
      return { _ok: false, _reason: "missing_target_type" };
    }
    if (!read_non_empty_string(canonical._params._property_name)) {
      return { _ok: false, _reason: "missing_property_name" };
    }
    if (!Object.prototype.hasOwnProperty.call(canonical._params, "_property_value")) {
      return { _ok: false, _reason: "missing_property_value" };
    }
  }

  return {
    _ok: true,
    _params: canonical._params,
  };
}

function compile_primitive_step(input: {
  id: string;
  title: string;
  params: Record<string, unknown>;
}): MutationPlanStep {
  const validation =
    validate_primitive_params(input.params);
  if (!validation._ok) {
    return unsupported_step(input.id, input.title, validation._reason);
  }

  return {
    _id: input.id,
    _title: input.title,
    _status: "planned",
    _primitive: {
      _module: "xvibe",
      _op: "apply-view-edit",
      _params: validation._params,
    },
  };
}

function compile_mutation_plan_steps(input: {
  steps: MutationPlanStep[];
  runtime_context: XVibeIntentRuntimeContext;
}): MutationPlanStep[] {
  const app_id =
    read_non_empty_string(input.runtime_context._app_id);
  const env =
    read_non_empty_string(input.runtime_context._env);
  const view_id =
    read_current_view_id(input.runtime_context);
  const toolbar_id =
    deterministic_toolbar_id(view_id);
  const base_params = {
    _app_id: app_id,
    _env: env,
    _view_id: view_id,
  };

  return input.steps.map((step) => {
    if (step._status === "unsupported") {
      return omit_undefined_properties({
        ...step,
      });
    }

    if (step._id === "create-toolbar") {
      return compile_primitive_step({
        id: step._id,
        title: step._title,
        params: {
          ...base_params,
          _edit_action: "create-toolbar",
          _location: "top",
          _toolbar_props: {
            _id: toolbar_id,
            _children: [],
          },
        },
      });
    }

    if (step._id === "create-save-button") {
      return compile_primitive_step({
        id: step._id,
        title: "Add Save button to toolbar",
        params: {
          ...base_params,
          _target_id: toolbar_id,
          _target_type: "toolbar",
          _edit_action: "add-child",
          _location: "bottom",
          _child: {
            _type: "button",
            _id: "save-button",
            _text: "Save",
          },
        },
      });
    }

    if (step._id === "create-cancel-button") {
      return compile_primitive_step({
        id: step._id,
        title: "Add Cancel button to toolbar",
        params: {
          ...base_params,
          _target_id: toolbar_id,
          _target_type: "toolbar",
          _edit_action: "add-child",
          _location: "bottom",
          _child: {
            _type: "button",
            _id: "cancel-button",
            _text: "Cancel",
          },
        },
      });
    }

    if (step._id.startsWith("move-") && step._target_text) {
      return compile_primitive_step({
        id: step._id,
        title: step._title,
        params: {
          ...base_params,
          _target_id: step._target_text,
          _target_text: step._target_text,
          _target_type: "button",
          _edit_action: "move-object",
          _position: "append",
          _destination_id: toolbar_id,
          _destination_type: "toolbar",
        },
      });
    }

    if (step._button_id && step._button_text && step._parent_id && !step._flow_id) {
      return compile_primitive_step({
        id: step._id,
        title: step._title,
        params: {
          ...base_params,
          _target_id: step._parent_id,
          _target_type: "toolbar",
          _edit_action: "add-child",
          _location: "bottom",
          _child: {
            _type: "button",
            _id: step._button_id,
            _text: step._button_text,
          },
        },
      });
    }

    if (step._button_id && step._flow_id) {
      return compile_primitive_step({
        id: step._id,
        title: step._title,
        params: {
          ...base_params,
          _target_id: step._button_id,
          _target_type: "button",
          _edit_action: "bind-flow",
          _flow: {
            _id: step._flow_id,
            _payload: {},
          },
          _flow_event: "click",
          _flow_auto: true,
        },
      });
    }

    if (step._child && step._target_id && step._target_type) {
      return compile_primitive_step({
        id: step._id,
        title: step._title,
        params: {
          ...base_params,
          ...(step._view_id ? { _view_id: step._view_id } : {}),
          _target_id: step._target_id,
          _target_type: step._target_type,
          _edit_action: "add-child",
          _location: "bottom",
          _child: step._child,
        },
      });
    }

    if (
      step._target_id &&
      step._target_type &&
      step._property_name &&
      Object.prototype.hasOwnProperty.call(step, "_property_value")
    ) {
      return compile_primitive_step({
        id: step._id,
        title: step._title,
        params: {
          ...base_params,
          ...(step._view_id ? { _view_id: step._view_id } : {}),
          _target_id: step._target_id,
          _target_type: step._target_type,
          _edit_action: "update-property",
          _property_name: step._property_name,
          _property_value: step._property_value,
        },
      });
    }

    return unsupported_step(
      step._id,
      step._title,
      "no_supported_primitive_mapping",
    );
  });
}

function is_simple_primitive_prompt(prompt: string): boolean {
  if (
    /\b(?:hide|show|delete|remove|duplicate|copy|move)\s+(?:selected|this|object|button|label|title|card|section)\b/u
      .test(prompt)
  ) {
    return true;
  }

  if (
    /\b(?:change|update|replace|rename)\b/u.test(prompt) &&
    (
      /\b(?:text|label|title|heading|copy)\b/u.test(prompt) ||
      /["'][^"']+["']\s+(?:to|with)\s+["'][^"']+["']/u.test(prompt)
    )
  ) {
    return true;
  }

  if (
    /\b(?:set|make|change|update|remove)\b/u.test(prompt) &&
    (
      /\b(?:style|styles|color|background|font|class|padding|margin)\b/u
        .test(prompt) ||
      /\b(?:bold|italic|underline|uppercase|lowercase|larger|smaller)\b/u
        .test(prompt) ||
      /\b\d+(?:px|rem|em|vh|vw)\b/u.test(prompt)
    )
  ) {
    return true;
  }

  if (
    /\b(?:create|add|insert|build)\s+(?:a\s+|an\s+|the\s+)?(?:top\s+|bottom\s+)?toolbar\b/u
      .test(prompt) &&
    !/\b(?:with|including|and)\b/u.test(prompt)
  ) {
    return true;
  }

  return false;
}

const TOOLBAR_MOVE_TARGETS = [
  "Refresh",
  "New Record",
  "Save",
  "Cancel",
];

function find_view_node_by_id(value: unknown, id: string): Record<string, unknown> | undefined {
  if (!_xu.is_plain_object(value)) return undefined;
  if (value._id === id) return value;
  const children =
    Array.isArray(value._children) ? value._children : [];
  for (const child of children) {
    const found =
      find_view_node_by_id(child, id);
    if (found) return found;
  }
  return undefined;
}

async function load_runtime_view(input: {
  runtime_context: XVibeIntentRuntimeContext;
  view_id: string;
}): Promise<Record<string, unknown> | undefined> {
  if (_xu.is_plain_object(input.runtime_context._current_view)) {
    return input.runtime_context._current_view;
  }

  const app_id =
    read_non_empty_string(input.runtime_context._app_id);
  const env =
    read_non_empty_string(input.runtime_context._env);
  if (!app_id || !env) return undefined;

  try {
    const response =
      await _x.execute({
        _module: "server-xvm",
        _op: "get_view",
        _params: {
          _app_id: app_id,
          _env: env,
          _view_id: input.view_id,
        },
      } as any);
    const result =
      _xu.is_plain_object(response?._result) ? response._result : undefined;
    return _xu.is_plain_object(result?._view)
      ? result._view
      : undefined;
  } catch {
    return undefined;
  }
}

async function load_available_view_ids(
  runtime_context: XVibeIntentRuntimeContext,
): Promise<string[]> {
  const app_id =
    read_non_empty_string(runtime_context._app_id);
  const env =
    read_non_empty_string(runtime_context._env);
  if (!app_id || !env) return [];

  try {
    const response =
      await _x.execute({
        _module: "server-xvm",
        _op: "list_views",
        _params: {
          _app_id: app_id,
          _env: env,
        },
      } as any);
    const result =
      _xu.is_plain_object(response?._result) ? response._result : undefined;
    if (Array.isArray(result?._view_ids)) {
      return result._view_ids.filter((id: unknown): id is string =>
        typeof id === "string" && id.trim().length > 0
      );
    }
    return Array.isArray(result?._views)
      ? result._views
        .map((view: unknown) =>
          _xu.is_plain_object(view) && typeof view._id === "string"
            ? view._id
            : undefined
        )
        .filter((id: unknown): id is string =>
          typeof id === "string" && id.trim().length > 0
        )
      : [];
  } catch {
    return [];
  }
}

function clone_json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const ENTITY_RUNTIME_READY_REQUIREMENT = "system.ready.wormhole";

function entity_runtime_ready_requirement(input?: {
  app_id?: string;
  env?: string;
}): string {
  const app_id =
    read_non_empty_string(input?.app_id);
  const env =
    read_non_empty_string(input?.env);
  if (!app_id || !env) {
    return ENTITY_RUNTIME_READY_REQUIREMENT;
  }
  return `system.ready.server-xvm.${env}.${app_id}.subscribed`;
}

const RESERVED_ENTITY_FIELDS = new Set([
  "_id",
  "_created_at",
  "_updated_at",
]);

function entity_schema_field_names(schema: Record<string, unknown>): string[] {
  return Object.keys(schema).filter(
    (field_name) => !RESERVED_ENTITY_FIELDS.has(field_name),
  );
}

function entity_manager_call_server_command(
  op: "find" | "aggregate",
  params: Record<string, unknown>,
  output?: {
    key: string;
    path: string;
  },
): Record<string, unknown> {
  return {
    _module: "xvm",
    _op: "call-server",
    _fail_on_error: true,
    _params: {
      _cmd: {
        _module: "entity-manager",
        _op: op,
        _params: params,
      },
    },
    ...(output
      ? {
        _output: {
          _target: "xdata",
          _key: output.key,
          _path: output.path,
        },
      }
      : {}),
  };
}

function entity_list_fetch_command(input: {
  app_id: string;
  env: string;
  entity_name: string;
  data_source: string;
}): Record<string, unknown> {
  return {
    _mode: "chain",
    _stop_on_error: true,
    _commands: [
      {
        _module: "xd",
        _op: "set",
        _params: {
          key: input.data_source,
          value: [],
          source: "entity-list:on-mount",
        },
      },
      entity_manager_call_server_command(
        "find",
        {
          _app_id: input.app_id,
          _env: input.env,
          _entity: input.entity_name,
          _filter: {},
          _sort: {
            _sort_by: "_created_at",
            _sort_order: "desc",
          },
          _limit: 10,
        },
        {
          key: input.data_source,
          path: "_records._data",
        },
      ),
    ],
  };
}

function entity_aggregation_xdata_key(input: {
  entity_name: string;
  op: "sum";
  field_name: string;
}): string {
  return `${input.entity_name}:${input.op}:${input.field_name}`;
}

function entity_aggregation_mount_command(input: {
  app_id: string;
  env: string;
  entity_name: string;
  records_key: string;
  fields: string[];
}): Record<string, unknown> {
  const commands: Record<string, unknown>[] = [
    {
      _module: "xd",
      _op: "set",
      _params: {
        key: input.records_key,
        value: [],
        source: "entity-aggregation:on-mount",
      },
    },
    ...input.fields.map((field_name) => ({
      _module: "xd",
      _op: "set",
      _params: {
        key: entity_aggregation_xdata_key({
          entity_name: input.entity_name,
          op: "sum",
          field_name,
        }),
        value: 0,
        source: "entity-aggregation:on-mount",
      },
    })),
    entity_manager_call_server_command(
      "find",
      {
        _app_id: input.app_id,
        _env: input.env,
        _entity: input.entity_name,
        _filter: {},
        _sort: {
          _sort_by: "_created_at",
          _sort_order: "desc",
        },
        _limit: 10,
      },
      {
        key: input.records_key,
        path: "_records._data",
      },
    ),
  ];

  for (const field_name of input.fields) {
    const total_key =
      entity_aggregation_xdata_key({
        entity_name: input.entity_name,
        op: "sum",
        field_name,
      });
    commands.push(
      entity_manager_call_server_command(
        "aggregate",
        {
          _app_id: input.app_id,
          _env: input.env,
          _entity: input.entity_name,
          _records: `$xdata:${input.records_key}`,
          _aggregation: {
            _op: "sum",
            _field: field_name,
          },
          _result_xdata_key: total_key,
        },
        {
          key: total_key,
          path: "_value",
        },
      ),
    );
  }

  return {
    _mode: "chain",
    _stop_on_error: true,
    _commands: commands,
  };
}

function entity_list_aggregation_mount_command(input: {
  app_id: string;
  env: string;
  entity_name: string;
  records_key: string;
  fields: string[];
}): Record<string, unknown> {
  const list_command =
    entity_list_fetch_command({
      app_id: input.app_id,
      env: input.env,
      entity_name: input.entity_name,
      data_source: input.records_key,
    });
  const commands =
    Array.isArray(list_command._commands)
      ? clone_json(list_command._commands) as Record<string, unknown>[]
      : [];
  const clear_aggregate_commands: Record<string, unknown>[] = [];

  for (const field_name of input.fields) {
    const total_key =
      entity_aggregation_xdata_key({
        entity_name: input.entity_name,
        op: "sum",
        field_name,
      });
    clear_aggregate_commands.push({
      _module: "xd",
      _op: "set",
      _params: {
        key: total_key,
        value: 0,
        source: "entity-aggregation:on-mount",
      },
    });
    commands.push(
      entity_manager_call_server_command(
        "aggregate",
        {
          _app_id: input.app_id,
          _env: input.env,
          _entity: input.entity_name,
          _records: `$xdata:${input.records_key}`,
          _aggregation: {
            _op: "sum",
            _field: field_name,
          },
          _result_xdata_key: total_key,
        },
        {
          key: total_key,
          path: "_value",
        },
      ),
    );
  }

  if (clear_aggregate_commands.length > 0) {
    commands.splice(1, 0, ...clear_aggregate_commands);
  }

  return {
    _mode: "chain",
    _stop_on_error: true,
    _commands: commands,
  };
}

function parse_entity_aggregation_request(prompt: string): {
  entity_name: string;
  requested_view_id: string;
  aggregations: Array<{
    op: "sum";
    requested_field: string;
  }>;
} | null {
  const match =
    /^\s*display\s+(.+?)\s+from\s+([a-z0-9][a-z0-9 _-]*?)\s+records\s+on\s+(?:the\s+)?(.+?)\s*\.?\s*$/iu
      .exec(prompt);
  if (!match?.[1] || !match?.[2] || !match?.[3]) {
    return null;
  }

  const aggregation_text =
    match[1].trim();
  const entity_name =
    _xu.normalize_id(match[2]);
  if (!entity_name) {
    return null;
  }

  const aggregations: Array<{
    op: "sum";
    requested_field: string;
  }> = [];
  const aggregate_re =
    /\bsum\s+of\s+([a-z0-9][a-z0-9 _-]*?)(?=\s+(?:and\s+)?(?:the\s+)?sum\s+of|,|$)/giu;
  let aggregate_match: RegExpExecArray | null;
  while ((aggregate_match = aggregate_re.exec(aggregation_text)) !== null) {
    const requested_field =
      aggregate_match[1]?.trim();
    if (requested_field) {
      aggregations.push({
        op: "sum",
        requested_field,
      });
    }
  }

  if (aggregations.length === 0) {
    return null;
  }

  const destination =
    match[3].trim().replace(/\.$/u, "");
  const requested_view_id =
    /^(?:home\s?page|homepage)$/iu.test(destination)
      ? "homepage"
      : destination;

  return {
    entity_name,
    requested_view_id,
    aggregations,
  };
}

function parse_entity_list_aggregation_request(prompt: string): {
  entity_name: string;
  requested_view_id: string;
  aggregations: Array<{
    op: "sum";
    requested_field: string;
  }>;
} | null {
  const match =
    /^\s*show\s+recent\s+([a-z0-9][a-z0-9 _-]*?)\s+records\s+on\s+(?:the\s+)?(.+?)\s+and\s+display\s+(?:the\s+)?(.+?)\s*$/u
      .exec(prompt);
  if (!match?.[1] || !match?.[2] || !match?.[3]) {
    return null;
  }

  const entity_name =
    _xu.normalize_id(match[1]);
  if (!entity_name) {
    return null;
  }

  const destination =
    match[2].trim();
  const requested_view_id =
    /^(?:home\s?page|homepage)$/u.test(destination)
      ? "homepage"
      : destination;
  const fields_text =
    match[3]
      .trim()
      .replace(/^(?:the\s+)?(?:sum\s+of\s+|total\s+)/u, "")
      .replace(/\s+and\s+(?:the\s+)?(?:sum\s+of\s+|total\s+)/gu, " and ");
  const aggregations =
    fields_text
      .split(/\s+and\s+|,\s*/u)
      .map((field) => field.trim())
      .filter((field) => field.length > 0)
      .map((requested_field) => ({
        op: "sum" as const,
        requested_field,
      }));

  if (aggregations.length === 0) {
    return null;
  }

  return {
    entity_name,
    requested_view_id,
    aggregations,
  };
}

function is_numeric_entity_field(field: unknown): boolean {
  return validate_numeric_entity_field({
    entity_name: "entity",
    requested_field: "field",
    resolved_field: "field",
    field,
  })._is_numeric;
}

function resolve_schema_field_name(
  schema: Record<string, unknown>,
  requested_field: string,
): string | undefined {
  const normalized_requested =
    _xu.normalize_id(requested_field);
  if (!normalized_requested) return undefined;

  return Object.keys(schema).find(
    (field_name) =>
      field_name === requested_field ||
      _xu.normalize_id(field_name) === normalized_requested,
  );
}

const NUMERIC_ENTITY_FIELD_TYPES = new Set([
  "number",
  "integer",
  "int",
  "float",
  "double",
  "decimal",
  "numeric",
  "long",
  "bigint",
]);

function declared_entity_field_type(field: unknown): string | undefined {
  if (typeof field === "string") {
    return field.trim() || undefined;
  }
  if (!_xu.is_plain_object(field)) {
    return undefined;
  }
  return typeof field._type === "string" && field._type.trim().length > 0
    ? field._type.trim()
    : undefined;
}

function normalize_entity_field_type(value: string | undefined): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "");
}

function validate_numeric_entity_field(input: {
  entity_name: string;
  requested_field: string;
  resolved_field: string | undefined;
  field: unknown;
}): {
  _requested_field: string;
  _resolved_field?: string;
  _declared_type?: string;
  _normalized_type: string;
  _is_numeric: boolean;
  _reason?: string;
} {
  const declared_type =
    declared_entity_field_type(input.field);
  const normalized_type =
    normalize_entity_field_type(declared_type);
  const is_numeric =
    NUMERIC_ENTITY_FIELD_TYPES.has(normalized_type);
  const result = {
    _requested_field: input.requested_field,
    ...(input.resolved_field ? { _resolved_field: input.resolved_field } : {}),
    ...(declared_type ? { _declared_type: declared_type } : {}),
    _normalized_type: normalized_type,
    _is_numeric: is_numeric,
    ...(is_numeric || !input.resolved_field
      ? {}
      : {
        _reason:
          `field_not_numeric: ${input.resolved_field} is ${declared_type ?? "unknown"}`,
      }),
  };

  _xlog.log("[xvibe] entity aggregation field validation", {
    _entity_name: input.entity_name,
    _requested_aggregate_field: input.requested_field,
    _resolved_schema_field: input.resolved_field,
    _declared_field_type: declared_type,
    _normalized_numeric_type: normalized_type,
    _validation_result: is_numeric,
  });

  return result;
}

function entity_aggregation_summary_child(input: {
  entity_name: string;
  fields: string[];
}): Record<string, unknown> {
  return {
    _id: `${input.entity_name}-aggregation-summary`,
    _type: "view",
    _role: "summary",
    _aggregations: input.fields.map((field_name) => ({
      _op: "sum",
      _field: field_name,
      _data_source: entity_aggregation_xdata_key({
        entity_name: input.entity_name,
        op: "sum",
        field_name,
      }),
    })),
    _children: input.fields.map((field_name) => {
      const total_key =
        entity_aggregation_xdata_key({
          entity_name: input.entity_name,
          op: "sum",
          field_name,
        });
      return {
        _id: `${input.entity_name}-sum-${field_name}`,
        _type: "view",
        _children: [
          {
            _id: `${input.entity_name}-sum-${field_name}-label`,
            _type: "label",
            _text: `Total ${title_from_id(field_name)}`,
          },
          {
            _id: `${input.entity_name}-sum-${field_name}-value`,
            _type: "label",
            _text: "0",
            _data_source: total_key,
            _on_data: {
              _op: "set-field",
              _params: {
                name: "_text",
                value: "$data",
              },
            },
          },
        ],
      };
    }),
  };
}

function entity_list_table_child(input: {
  entity_name: string;
  data_source: string;
  field_names: string[];
}): Record<string, unknown> {
  return {
    _id: `recent-${input.entity_name}-records`,
    _type: "table",
    _data_source: input.data_source,
    _empty_text: `No ${input.entity_name} records yet.`,
    _query: {
      _entity: input.entity_name,
      _filter: {},
      _sort: {
        _sort_by: "_created_at",
        _sort_order: "desc",
      },
      _limit: 10,
    },
    _columns: input.field_names.map((field_name) => ({
      _key: field_name,
      _label: title_from_id(field_name),
    })),
  };
}

function same_json(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function merge_view_requires(
  existing_requires: unknown,
  runtime?: {
    app_id?: string;
    env?: string;
  },
): string[] {
  return _xu.unique_strings([
    ..._xu.ensure_array<string>(existing_requires)
      .filter((item) => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
    entity_runtime_ready_requirement(runtime),
  ]);
}

function command_array(value: unknown): Record<string, unknown>[] | undefined {
  if (!_xu.is_plain_object(value)) return undefined;
  return Array.isArray(value._commands)
    ? value._commands.filter(_xu.is_plain_object)
    : undefined;
}

function command_param_string(
  command: Record<string, unknown>,
  key: string,
): string | undefined {
  const params =
    _xu.is_plain_object(command._params) ? command._params : undefined;
  const value =
    params?.[key];
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function command_aggregation_field(command: Record<string, unknown>): string | undefined {
  const params =
    _xu.is_plain_object(command._params) ? command._params : undefined;
  const aggregation =
    _xu.is_plain_object(params?._aggregation) ? params?._aggregation : undefined;
  const field =
    aggregation?._field;
  return typeof field === "string" && field.trim()
    ? field.trim()
    : undefined;
}

function entity_manager_server_command(
  command: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (command._module === "entity-manager") {
    return command;
  }

  if (command._module !== "xvm" || command._op !== "call-server") {
    return undefined;
  }

  const params =
    _xu.is_plain_object(command._params) ? command._params : undefined;
  const server_command =
    _xu.is_plain_object(params?._cmd) ? params?._cmd : undefined;

  return server_command?._module === "entity-manager"
    ? server_command as Record<string, unknown>
    : undefined;
}

function entity_mount_signature(value: unknown): {
  entity_name?: string;
  records_key?: string;
  aggregate_keys: string[];
  aggregate_fields: string[];
} | undefined {
  const commands =
    command_array(value);
  if (!commands || commands.length === 0) return undefined;

  let entity_name: string | undefined;
  let records_key: string | undefined;
  const aggregate_keys: string[] = [];
  const aggregate_fields: string[] = [];

  for (const command of commands) {
    const server_command =
      entity_manager_server_command(command);

    if (
      server_command &&
      server_command._op === "find"
    ) {
      entity_name =
        command_param_string(server_command, "_entity") ??
        command_param_string(server_command, "_entity_id") ??
        entity_name;

      const output =
        _xu.is_plain_object(command._output) ? command._output : undefined;
      const output_key =
        typeof output?._key === "string" && output._key.trim()
          ? output._key.trim()
          : undefined;
      if (output?._target === "xdata" && output_key) {
        records_key =
          output_key;
      }
    }

    if (
      server_command &&
      server_command._op === "aggregate"
    ) {
      const field =
        command_aggregation_field(server_command);
      if (field) aggregate_fields.push(field);

      const result_key =
        command_param_string(server_command, "_result_xdata_key") ??
        command_param_string(server_command, "_xdata_destination");
      if (result_key) aggregate_keys.push(result_key);

      const output =
        _xu.is_plain_object(command._output) ? command._output : undefined;
      const output_key =
        typeof output?._key === "string" && output._key.trim()
          ? output._key.trim()
          : undefined;
      if (output?._target === "xdata" && output_key) {
        aggregate_keys.push(output_key);
      }
    }

    if (
      command._module === "xd" &&
      command._op === "set"
    ) {
      const params =
        _xu.is_plain_object(command._params) ? command._params : undefined;
      const key =
        typeof params?.key === "string" && params.key.trim()
          ? params.key.trim()
          : undefined;
      const value =
        typeof params?.value === "string" ? params.value.trim() : undefined;
      const source =
        typeof params?.source === "string" ? params.source.trim() : "";

      if (
        key &&
        (
          value === "$prev._records._data" ||
          value === "$prev._result._records._data"
        )
      ) {
        records_key =
          key;
      }

      if (
        key &&
        (
          source === "entity-aggregation:on-mount" ||
          value === "$prev._value" ||
          value === "$prev._result._value" ||
          value === "$prev._result" ||
          value === "$prev"
        ) &&
        key !== records_key
      ) {
        aggregate_keys.push(key);
      }
    }
  }

  if (!entity_name && !records_key && aggregate_keys.length === 0) {
    return undefined;
  }

  return {
    entity_name,
    records_key,
    aggregate_keys: _xu.unique_strings(aggregate_keys),
    aggregate_fields: _xu.unique_strings(aggregate_fields),
  };
}

function entity_mount_matches_signature(
  value: unknown,
  signature: ReturnType<typeof entity_mount_signature>,
): boolean {
  if (!signature) return false;
  const candidate =
    entity_mount_signature(value);
  if (!candidate) return false;

  if (
    signature.entity_name &&
    candidate.entity_name &&
    signature.entity_name !== candidate.entity_name
  ) {
    return false;
  }

  if (
    signature.records_key &&
    candidate.records_key &&
    signature.records_key !== candidate.records_key
  ) {
    return false;
  }

  if (
    signature.records_key &&
    candidate.records_key &&
    signature.records_key === candidate.records_key
  ) {
    return true;
  }

  if (signature.aggregate_keys.length > 0) {
    return signature.aggregate_keys.some((key) =>
      candidate.aggregate_keys.includes(key)
    );
  }

  return Boolean(
    signature.records_key &&
    candidate.records_key === signature.records_key
  );
}

function entity_mount_legacy_reasons(
  existing_on_mount: unknown,
  next_command: Record<string, unknown>,
): string[] {
  if (same_json(existing_on_mount, next_command)) return [];

  const reasons: string[] = [];
  const existing_commands =
    Array.isArray(existing_on_mount)
      ? existing_on_mount.filter(_xu.is_plain_object)
      : _xu.is_plain_object(existing_on_mount)
        ? command_array(existing_on_mount) ?? [existing_on_mount]
        : [];
  const next_signature =
    entity_mount_signature(next_command);
  const existing_signature =
    entity_mount_signature(existing_on_mount);

  if (Array.isArray(existing_on_mount)) {
    reasons.push("array_wrapped_loader");
  }

  if (
    next_signature?.aggregate_keys.length &&
    existing_signature &&
    existing_signature.aggregate_keys.length < next_signature.aggregate_keys.length
  ) {
    reasons.push("missing_aggregate_loader");
  }

  for (const command of existing_commands) {
    const server_command =
      entity_manager_server_command(command);

    if (
      command._module === "entity-manager" &&
      (
        command._op === "find" ||
        command._op === "aggregate"
      )
    ) {
      reasons.push("server_module_loader");
    }

    if (server_command && server_command._op === "aggregate") {
      const params =
        _xu.is_plain_object(server_command._params) ? server_command._params : undefined;
      if (typeof params?._xdata_destination === "string") {
        reasons.push("aggregate_xdata_destination");
      }
    }

    if (command._module === "xd" && command._op === "set") {
      const params =
        _xu.is_plain_object(command._params) ? command._params : undefined;
      const source =
        typeof params?.source === "string" ? params.source : "";
      const key =
        typeof params?.key === "string" ? params.key : "";
      if (
        source === "entity-aggregation:on-mount" &&
        key &&
        params?.value !== 0 &&
        params?.value !== "$prev._value"
      ) {
        reasons.push("aggregate_value_not_primitive");
      }
    }
  }

  if (reasons.length === 0) {
    reasons.push("command_shape_differs");
  }

  return _xu.unique_strings(reasons);
}

function merge_on_mount_command(
  existing_on_mount: unknown,
  command: Record<string, unknown>,
): unknown {
  const next_command =
    clone_json(command);
  if (existing_on_mount === undefined) {
    return next_command;
  }

  const next_signature =
    entity_mount_signature(next_command);

  if (
    next_signature &&
    entity_mount_matches_signature(existing_on_mount, next_signature)
  ) {
    if (same_json(existing_on_mount, next_command)) {
      _xlog.log("[xvibe] entity on-mount loader identical", {
        _decision: "identical",
        _action: "no-op",
        _entity_name: next_signature.entity_name,
        _records_key: next_signature.records_key,
        _aggregate_keys: next_signature.aggregate_keys,
      });
      return clone_json(existing_on_mount);
    }

    const reasons =
      entity_mount_legacy_reasons(existing_on_mount, next_command);
    _xlog.log("[xvibe] entity on-mount legacy loader detected", {
      _decision: "legacy-loader-detected",
      _entity_name: next_signature.entity_name,
      _records_key: next_signature.records_key,
      _aggregate_keys: next_signature.aggregate_keys,
      _reasons: reasons,
    });
    _xlog.log("[xvibe] entity on-mount loader upgraded", {
      _decision: "loader-upgraded",
      _entity_name: next_signature.entity_name,
      _records_key: next_signature.records_key,
      _aggregate_keys: next_signature.aggregate_keys,
      _reasons: reasons,
    });
    return next_command;
  }

  const commands =
    Array.isArray(existing_on_mount)
      ? clone_json(existing_on_mount)
      : [clone_json(existing_on_mount)];

  if (!next_signature) {
    if (commands.some((item) => same_json(item, next_command))) {
      return clone_json(existing_on_mount);
    }

    return [...commands, next_command];
  }

  let inserted = false;
  const merged_commands: unknown[] = [];

  for (const item of commands) {
    if (entity_mount_matches_signature(item, next_signature)) {
      if (!inserted) {
        if (same_json(item, next_command)) {
          _xlog.log("[xvibe] entity on-mount loader identical", {
            _decision: "identical",
            _action: "no-op",
            _entity_name: next_signature.entity_name,
            _records_key: next_signature.records_key,
            _aggregate_keys: next_signature.aggregate_keys,
          });
          merged_commands.push(clone_json(item));
        } else {
          const reasons =
            entity_mount_legacy_reasons(item, next_command);
          _xlog.log("[xvibe] entity on-mount legacy loader detected", {
            _decision: "legacy-loader-detected",
            _entity_name: next_signature.entity_name,
            _records_key: next_signature.records_key,
            _aggregate_keys: next_signature.aggregate_keys,
            _reasons: reasons,
          });
          _xlog.log("[xvibe] entity on-mount loader upgraded", {
            _decision: "loader-upgraded",
            _entity_name: next_signature.entity_name,
            _records_key: next_signature.records_key,
            _aggregate_keys: next_signature.aggregate_keys,
            _reasons: reasons,
          });
          merged_commands.push(next_command);
        }
        inserted = true;
      }
      continue;
    }

    merged_commands.push(item);
  }

  if (inserted) {
    return merged_commands;
  }

  if (commands.some((item) => same_json(item, next_command))) {
    _xlog.log("[xvibe] entity on-mount loader identical", {
      _decision: "identical",
      _action: "no-op",
      _entity_name: next_signature.entity_name,
      _records_key: next_signature.records_key,
      _aggregate_keys: next_signature.aggregate_keys,
    });
    return clone_json(existing_on_mount);
  }

  return [...commands, next_command];
}

function merge_open_modal_handler(existing_on: unknown): Record<string, unknown> {
  const next_on =
    _xu.is_plain_object(existing_on)
      ? clone_json(existing_on)
      : {};
  next_on._click = {
    _op: "open-object",
    _params: {
      _id: "create-meal-modal",
    },
  };
  return next_on;
}

function parse_entity_list_request(prompt: string): {
  entity_name: string;
  requested_view_id: string;
} | null {
  const match =
    /^\s*show\s+(?:recent\s+)?([a-z0-9][a-z0-9 _-]*?)\s+records\s+on\s+(?:the\s+)?(.+?)\s*$/u
      .exec(prompt);
  if (!match?.[1] || !match?.[2]) {
    return null;
  }

  const entity_name =
    _xu.normalize_id(match[1]);
  if (!entity_name) {
    return null;
  }

  const destination =
    match[2].trim();
  const requested_view_id =
    /^(?:home\s?page|homepage)$/u.test(destination)
      ? "homepage"
      : destination;

  return {
    entity_name,
    requested_view_id,
  };
}

async function load_entity_artifact(input: {
  runtime_context: XVibeIntentRuntimeContext;
  entity_name: string;
}): Promise<Record<string, unknown> | undefined> {
  const app_id =
    read_non_empty_string(input.runtime_context._app_id);
  const env =
    read_non_empty_string(input.runtime_context._env);
  if (!app_id || !env) return undefined;

  try {
    const response =
      await _x.execute({
        _module: "server-xvm",
        _op: "get_entity",
        _params: {
          _app_id: app_id,
          _env: env,
          _entity_id: input.entity_name,
        },
      } as any);
    const result =
      _xu.is_plain_object(response?._result) ? response._result : undefined;
    return _xu.is_plain_object(result?._entity)
      ? result._entity
      : undefined;
  } catch {
    return undefined;
  }
}

async function entity_aggregation_plan(
  prompt: string,
  original: string,
  runtime_context: XVibeIntentRuntimeContext,
): Promise<MutationPlanMatch | null> {
  const request =
    parse_entity_aggregation_request(prompt);
  if (!request) return null;

  const available_view_ids =
    await load_available_view_ids(runtime_context);
  const current_view_id =
    read_current_view_id(runtime_context);
  const view_resolution =
    resolveProjectViewId({
      requested_view_id: request.requested_view_id,
      current_view_id,
      available_views: available_view_ids,
    });
  const entity =
    await load_entity_artifact({
      runtime_context,
      entity_name: request.entity_name,
    });

  const title =
    `${title_from_id(request.entity_name)} Entity Summary`;
  const view_id =
    view_resolution._ok ? view_resolution._view_id : request.requested_view_id;
  const unsupported_ids =
    [
      "load-records",
      ...request.aggregations.map((aggregation) =>
        `${aggregation.op}-${_xu.normalize_id(aggregation.requested_field) ?? "field"}`,
      ),
      "display-summary",
    ];

  if (!view_resolution._ok) {
    return {
      _title: title,
      _goal: sentence_goal(original),
      _steps: unsupported_ids.map((id) =>
        unsupported_step(
          `${request.entity_name}-aggregation-${id}`,
          id === "display-summary"
            ? `Display ${title_from_id(request.entity_name)} summary`
            : `Prepare ${title_from_id(request.entity_name)} aggregation`,
          "target_view_not_found",
        ),
      ),
    };
  }

  if (!entity) {
    return {
      _title: title,
      _goal: sentence_goal(original),
      _steps: unsupported_ids.map((id) =>
        unsupported_step(
          `${request.entity_name}-aggregation-${id}`,
          id === "display-summary"
            ? `Display ${title_from_id(request.entity_name)} summary`
            : `Prepare ${title_from_id(request.entity_name)} aggregation`,
          "entity_not_found",
        ),
      ),
    };
  }

  const app_id =
    read_non_empty_string(runtime_context._app_id);
  const env =
    read_non_empty_string(runtime_context._env);
  if (!app_id || !env) {
    return {
      _title: title,
      _goal: sentence_goal(original),
      _steps: unsupported_ids.map((id) =>
        unsupported_step(
          `${request.entity_name}-aggregation-${id}`,
          id === "display-summary"
            ? `Display ${title_from_id(request.entity_name)} summary`
            : `Prepare ${title_from_id(request.entity_name)} aggregation`,
          "runtime_context_missing",
        ),
      ),
    };
  }

  const schema =
    _xu.is_plain_object(entity._schema)
      ? entity._schema as Record<string, unknown>
      : {};
  const field_validations =
    request.aggregations.map((aggregation) => {
      const field_name =
        resolve_schema_field_name(schema, aggregation.requested_field);
      return {
        _aggregation: aggregation,
        _field_name: field_name,
        ...(field_name
          ? {
            _numeric_validation: validate_numeric_entity_field({
              entity_name: request.entity_name,
              requested_field: aggregation.requested_field,
              resolved_field: field_name,
              field: schema[field_name],
            }),
          }
          : {}),
      };
    });
  const invalid_field =
    field_validations.find((validation) => !validation._field_name);
  if (invalid_field) {
    return {
      _title: title,
      _goal: sentence_goal(original),
      _steps: unsupported_ids.map((id) =>
        unsupported_step(
          `${request.entity_name}-aggregation-${id}`,
          id === "display-summary"
            ? `Display ${title_from_id(request.entity_name)} summary`
            : `Prepare ${title_from_id(request.entity_name)} aggregation`,
          "field_not_found",
        ),
      ),
    };
  }

  const non_numeric_field =
    field_validations.find((validation) =>
      validation._numeric_validation?._is_numeric === false
    );
  if (non_numeric_field) {
    const reason =
      non_numeric_field._numeric_validation?._reason ??
      "field_not_numeric";
    return {
      _title: title,
      _goal: sentence_goal(original),
      _steps: unsupported_ids.map((id) =>
        unsupported_step(
          `${request.entity_name}-aggregation-${id}`,
          id === "display-summary"
            ? `Display ${title_from_id(request.entity_name)} summary`
            : `Prepare ${title_from_id(request.entity_name)} aggregation`,
          reason,
        ),
      ),
    };
  }

  const unique_fields =
    field_validations
      .map((validation) => validation._field_name)
      .filter((field_name): field_name is string => typeof field_name === "string")
      .filter((field_name, index, arr) =>
      arr.indexOf(field_name) === index
    );
  const records_key =
    `${request.entity_name}:records`;
  const mount_command =
    entity_aggregation_mount_command({
      app_id,
      env,
      entity_name: request.entity_name,
      records_key,
      fields: unique_fields,
    });
  const view =
    await load_runtime_view({
      runtime_context,
      view_id,
    });
  const summary_child =
    entity_aggregation_summary_child({
      entity_name: request.entity_name,
      fields: unique_fields,
    });

  _xlog.log("[xvibe] composed entity aggregation mutation plan", {
    _goal: sentence_goal(original),
    _primitive_count: 5,
    _composition: ["update-property", "update-property", "update-property", "update-property", "add-child"],
    _view_id: view_id,
    _entity_name: request.entity_name,
    _records_key: records_key,
    _requires: merge_view_requires(view?._requires, { app_id, env }),
    _aggregations: unique_fields.map((field_name) => ({
      _op: "sum",
      _field: field_name,
      _data_source: entity_aggregation_xdata_key({
        entity_name: request.entity_name,
        op: "sum",
        field_name,
      }),
    })),
  });

  const property_value =
    merge_on_mount_command(view?._on_mount, mount_command);

  return {
    _title: title,
    _goal: sentence_goal(original),
    _steps: [
      {
        _id: `require-wormhole-for-${request.entity_name}-aggregation`,
        _title: `Wait for ${title_from_id(request.entity_name)} runtime connection`,
        _status: "planned",
        _view_id: view_id,
        _target_id: view_id,
        _target_type: "view",
        _property_name: "_requires",
        _property_value: merge_view_requires(view?._requires, { app_id, env }),
      },
      {
        _id: `load-${request.entity_name}-records-for-aggregation`,
        _title: `Load ${title_from_id(request.entity_name)} records`,
        _status: "planned",
        _view_id: view_id,
        _target_id: view_id,
        _target_type: "view",
        _property_name: "_on_mount",
        _property_value: property_value,
      },
      ...unique_fields.map((field_name) => ({
        _id: `compute-${request.entity_name}-sum-${field_name}`,
        _title: `Compute sum of ${title_from_id(field_name)}`,
        _status: "planned" as const,
        _view_id: view_id,
        _target_id: view_id,
        _target_type: "view",
        _property_name: "_on_mount",
        _property_value: property_value,
      })),
      {
        _id: `display-${request.entity_name}-aggregation-summary`,
        _title: `Display ${title_from_id(request.entity_name)} summary`,
        _status: "planned",
        _view_id: view_id,
        _target_id: view_id,
        _target_type: "view",
        _child: summary_child,
      },
    ],
  };
}

async function entity_list_aggregation_plan(
  prompt: string,
  original: string,
  runtime_context: XVibeIntentRuntimeContext,
): Promise<MutationPlanMatch | null> {
  const request =
    parse_entity_list_aggregation_request(prompt);
  if (!request) return null;

  const available_view_ids =
    await load_available_view_ids(runtime_context);
  const current_view_id =
    read_current_view_id(runtime_context);
  const view_resolution =
    resolveProjectViewId({
      requested_view_id: request.requested_view_id,
      current_view_id,
      available_views: available_view_ids,
    });
  const entity =
    await load_entity_artifact({
      runtime_context,
      entity_name: request.entity_name,
    });

  const title =
    `${title_from_id(request.entity_name)} Entity List Summary`;
  const view_id =
    view_resolution._ok ? view_resolution._view_id : request.requested_view_id;
  const unsupported_ids =
    [
      `load-recent-${request.entity_name}-records`,
      `add-recent-${request.entity_name}-records-table`,
      ...request.aggregations.map((aggregation) =>
        `compute-${request.entity_name}-${aggregation.op}-${_xu.normalize_id(aggregation.requested_field) ?? "field"}`
      ),
      `display-${request.entity_name}-aggregation-summary`,
    ];
  const unsupported_steps = (reason: string): MutationPlanStep[] =>
    unsupported_ids.map((id) =>
      unsupported_step(
        id,
        id.startsWith("add-recent-")
          ? `Add recent ${title_from_id(request.entity_name)} records table`
          : id.startsWith("display-")
            ? `Display ${title_from_id(request.entity_name)} summary`
            : id.startsWith("compute-")
              ? `Compute ${title_from_id(request.entity_name)} aggregation`
              : `Load recent ${title_from_id(request.entity_name)} records`,
        reason,
      )
    );

  if (!view_resolution._ok) {
    return {
      _title: title,
      _goal: sentence_goal(original),
      _steps: unsupported_steps("target_view_not_found"),
    };
  }

  if (!entity) {
    return {
      _title: title,
      _goal: sentence_goal(original),
      _steps: unsupported_steps("entity_not_found"),
    };
  }

  const app_id =
    read_non_empty_string(runtime_context._app_id);
  const env =
    read_non_empty_string(runtime_context._env);
  if (!app_id || !env) {
    return {
      _title: title,
      _goal: sentence_goal(original),
      _steps: unsupported_steps("runtime_context_missing"),
    };
  }

  const schema =
    _xu.is_plain_object(entity._schema)
      ? entity._schema as Record<string, unknown>
      : {};
  const field_names =
    entity_schema_field_names(schema);
  const field_validations =
    request.aggregations.map((aggregation) => {
      const field_name =
        resolve_schema_field_name(schema, aggregation.requested_field);
      const numeric_validation =
        field_name
          ? validate_numeric_entity_field({
            entity_name: request.entity_name,
            requested_field: aggregation.requested_field,
            resolved_field: field_name,
            field: schema[field_name],
          })
          : undefined;
      return {
        _aggregation: aggregation,
        _field_name: field_name,
        _reason: !field_name
          ? "field_not_found"
          : numeric_validation?._is_numeric === false
            ? numeric_validation._reason ?? "field_not_numeric"
            : undefined,
      };
    });
  const valid_fields =
    field_validations
      .filter((validation) => !validation._reason && validation._field_name)
      .map((validation) => validation._field_name as string);
  const invalid_validations =
    field_validations.filter((validation) => validation._reason);
  const unique_fields =
    valid_fields.filter((field_name, index, arr) =>
      arr.indexOf(field_name) === index
    );
  const records_key =
    `${request.entity_name}:records`;
  const mount_command =
    unique_fields.length > 0
      ? entity_list_aggregation_mount_command({
        app_id,
        env,
        entity_name: request.entity_name,
        records_key,
        fields: unique_fields,
      })
      : entity_list_fetch_command({
        app_id,
        env,
        entity_name: request.entity_name,
        data_source: records_key,
      });
  const view =
    await load_runtime_view({
      runtime_context,
      view_id,
    });
  const property_value =
    merge_on_mount_command(view?._on_mount, mount_command);

  _xlog.log("[xvibe] composed entity list aggregation mutation plan", {
    _goal: sentence_goal(original),
    _primitive_count: 6,
    _composition: [
      "update-property",
      "update-property",
      "add-child",
      "update-property",
      "update-property",
      "add-child",
    ],
    _view_id: view_id,
    _entity_name: request.entity_name,
    _xdata_destination: records_key,
    _table_data_source: records_key,
    _requires: merge_view_requires(view?._requires, { app_id, env }),
    _limit: 10,
    _sort: "newest-first",
    _invalid_aggregations: invalid_validations.map((validation) => ({
      _requested_field: validation._aggregation.requested_field,
      _reason: validation._reason,
    })),
    _aggregations: unique_fields.map((field_name) => ({
      _op: "sum",
      _field: field_name,
      _data_source: entity_aggregation_xdata_key({
        entity_name: request.entity_name,
        op: "sum",
        field_name,
      }),
    })),
  });

  return {
    _title: title,
    _goal: sentence_goal(original),
    _steps: [
      {
        _id: `require-wormhole-for-${request.entity_name}-records`,
        _title: `Wait for ${title_from_id(request.entity_name)} runtime connection`,
        _status: "planned",
        _view_id: view_id,
        _target_id: view_id,
        _target_type: "view",
        _property_name: "_requires",
        _property_value: merge_view_requires(view?._requires, { app_id, env }),
      },
      {
        _id: `load-recent-${request.entity_name}-records`,
        _title: `Load recent ${title_from_id(request.entity_name)} records`,
        _status: "planned",
        _view_id: view_id,
        _target_id: view_id,
        _target_type: "view",
        _property_name: "_on_mount",
        _property_value: property_value,
      },
      {
        _id: `add-recent-${request.entity_name}-records-table`,
        _title: `Add recent ${title_from_id(request.entity_name)} records table`,
        _status: "planned",
        _view_id: view_id,
        _target_id: view_id,
        _target_type: "view",
        _child: entity_list_table_child({
          entity_name: request.entity_name,
          data_source: records_key,
          field_names,
        }),
      },
      ...field_validations.map((validation) =>
        validation._reason || !validation._field_name
          ? unsupported_step(
            `compute-${request.entity_name}-sum-${_xu.normalize_id(validation._aggregation.requested_field) ?? "field"}`,
            `Compute sum of ${title_from_id(validation._aggregation.requested_field)}`,
            validation._reason ?? "field_not_found",
          )
          : {
            _id: `compute-${request.entity_name}-sum-${validation._field_name}`,
            _title: `Compute sum of ${title_from_id(validation._field_name)}`,
            _status: "planned" as const,
            _view_id: view_id,
            _target_id: view_id,
            _target_type: "view",
            _property_name: "_on_mount",
            _property_value: property_value,
          }
      ),
      invalid_validations.length > 0 || unique_fields.length === 0
        ? unsupported_step(
          `display-${request.entity_name}-aggregation-summary`,
          `Display ${title_from_id(request.entity_name)} summary`,
          invalid_validations[0]?._reason ?? "field_not_found",
        )
        : {
          _id: `display-${request.entity_name}-aggregation-summary`,
          _title: `Display ${title_from_id(request.entity_name)} summary`,
          _status: "planned",
          _view_id: view_id,
          _target_id: view_id,
          _target_type: "view",
          _child: entity_aggregation_summary_child({
            entity_name: request.entity_name,
            fields: unique_fields,
          }),
        },
    ],
  };
}

async function entity_list_plan(
  prompt: string,
  original: string,
  runtime_context: XVibeIntentRuntimeContext,
): Promise<MutationPlanMatch | null> {
  const request =
    parse_entity_list_request(prompt);
  if (!request) return null;

  const available_view_ids =
    await load_available_view_ids(runtime_context);
  const current_view_id =
    read_current_view_id(runtime_context);
  const view_resolution =
    resolveProjectViewId({
      requested_view_id: request.requested_view_id,
      current_view_id,
      available_views: available_view_ids,
    });
  const entity =
    await load_entity_artifact({
      runtime_context,
      entity_name: request.entity_name,
    });

  const title =
    `${title_from_id(request.entity_name)} Entity List`;
  const view_id =
    view_resolution._ok ? view_resolution._view_id : request.requested_view_id;

  if (!view_resolution._ok) {
    return {
      _title: title,
      _goal: sentence_goal(original),
      _steps: [
        unsupported_step(
          `load-recent-${request.entity_name}-records`,
          `Load recent ${title_from_id(request.entity_name)} records`,
          "target_view_not_found",
        ),
        unsupported_step(
          `add-recent-${request.entity_name}-records-table`,
          `Add recent ${title_from_id(request.entity_name)} records table`,
          "target_view_not_found",
        ),
      ],
    };
  }

  if (!entity) {
    return {
      _title: title,
      _goal: sentence_goal(original),
      _steps: [
        unsupported_step(
          `load-recent-${request.entity_name}-records`,
          `Load recent ${title_from_id(request.entity_name)} records`,
          "entity_not_found",
        ),
        unsupported_step(
          `add-recent-${request.entity_name}-records-table`,
          `Add recent ${title_from_id(request.entity_name)} records table`,
          "entity_not_found",
        ),
      ],
    };
  }

  const app_id =
    read_non_empty_string(runtime_context._app_id);
  const env =
    read_non_empty_string(runtime_context._env);
  if (!app_id || !env) {
    return {
      _title: title,
      _goal: sentence_goal(original),
      _steps: [
        unsupported_step(
          `load-recent-${request.entity_name}-records`,
          `Load recent ${title_from_id(request.entity_name)} records`,
          "runtime_context_missing",
        ),
        unsupported_step(
          `add-recent-${request.entity_name}-records-table`,
          `Add recent ${title_from_id(request.entity_name)} records table`,
          "runtime_context_missing",
        ),
      ],
    };
  }

  const view =
    await load_runtime_view({
      runtime_context,
      view_id,
    });
  const schema =
    _xu.is_plain_object(entity._schema)
      ? entity._schema as Record<string, unknown>
      : {};
  const field_names =
    entity_schema_field_names(schema);
  const data_source =
    `${request.entity_name}:records`;
  const fetch_command =
    entity_list_fetch_command({
      app_id,
      env,
      entity_name: request.entity_name,
      data_source,
    });

  _xlog.log("[xvibe] composed mutation plan", {
    _goal: sentence_goal(original),
    _primitive_count: 3,
    _composition: ["update-property", "update-property", "add-child"],
    _view_id: view_id,
    _entity_name: request.entity_name,
    _xdata_destination: data_source,
    _table_data_source: data_source,
    _data_source: data_source,
    _requires: merge_view_requires(view?._requires, { app_id, env }),
    _limit: 10,
    _sort: "newest-first",
  });

  return {
    _title: title,
    _goal: sentence_goal(original),
    _steps: [
      {
        _id: `require-wormhole-for-${request.entity_name}-records`,
        _title: `Wait for ${title_from_id(request.entity_name)} runtime connection`,
        _status: "planned",
        _view_id: view_id,
        _target_id: view_id,
        _target_type: "view",
        _property_name: "_requires",
        _property_value: merge_view_requires(view?._requires, { app_id, env }),
      },
      {
        _id: `load-recent-${request.entity_name}-records`,
        _title: `Load recent ${title_from_id(request.entity_name)} records`,
        _status: "planned",
        _view_id: view_id,
        _target_id: view_id,
        _target_type: "view",
        _property_name: "_on_mount",
        _property_value: merge_on_mount_command(view?._on_mount, fetch_command),
      },
      {
        _id: `add-recent-${request.entity_name}-records-table`,
        _title: `Add recent ${title_from_id(request.entity_name)} records table`,
        _status: "planned",
        _view_id: view_id,
        _target_id: view_id,
        _target_type: "view",
        _child: entity_list_table_child({
          entity_name: request.entity_name,
          data_source,
          field_names,
        }),
      },
    ],
  };
}

async function meal_modal_plan(
  prompt: string,
  original: string,
  runtime_context: XVibeIntentRuntimeContext,
): Promise<MutationPlanMatch | null> {
  if (
    !/\badd\s+meal\s+button\b/u.test(prompt) ||
    !/\bopen\b/u.test(prompt) ||
    !/\bcreate[-\s]+meal\b/u.test(prompt) ||
    !/\bmodal\b/u.test(prompt)
  ) {
    return null;
  }

  const available_view_ids =
    await load_available_view_ids(runtime_context);
  const current_view_id =
    read_current_view_id(runtime_context);
  const main_resolution =
    resolveProjectViewId({
      requested_view_id: current_view_id || "main",
      current_view_id,
      available_views: available_view_ids,
      target_id: "add-meal-button",
      target_text: "Add Meal",
    });
  const create_meal_resolution =
    resolveProjectViewId({
      requested_view_id: "create-meal",
      current_view_id,
      available_views: available_view_ids,
    });

  if (!main_resolution._ok) {
    return {
      _title: "Add Meal Modal",
      _goal: sentence_goal(original),
      _steps: [
        unsupported_step(
          "create-create-meal-modal",
          "Create Add Meal modal",
          "main_view_not_found",
        ),
        unsupported_step(
          "bind-add-meal-button-to-modal",
          "Open Add Meal modal from Add Meal button",
          "main_view_not_found",
        ),
      ],
    };
  }

  if (!create_meal_resolution._ok) {
    return {
      _title: "Add Meal Modal",
      _goal: sentence_goal(original),
      _steps: [
        unsupported_step(
          "create-create-meal-modal",
          "Create Add Meal modal",
          "create_meal_view_not_found",
        ),
        unsupported_step(
          "bind-add-meal-button-to-modal",
          "Open Add Meal modal from Add Meal button",
          "create_meal_view_not_found",
        ),
      ],
    };
  }

  const main_view =
    await load_runtime_view({
      runtime_context,
      view_id: main_resolution._view_id,
    });
  const button_resolution =
    resolveViewTarget(main_view, {
      _target_id: "add-meal-button",
      _target_text: "Add Meal",
      _target_type: "button",
      _target_id_text_fallback: true,
      _include_id: true,
      _allow_root: false,
      _view_id: main_resolution._view_id,
    });
  if (!button_resolution._ok) {
    return {
      _title: "Add Meal Modal",
      _goal: sentence_goal(original),
      _steps: [
        unsupported_step(
          "create-create-meal-modal",
          "Create Add Meal modal",
          "add_meal_button_not_found",
        ),
        unsupported_step(
          "bind-add-meal-button-to-modal",
          "Open Add Meal modal from Add Meal button",
          "add_meal_button_not_found",
        ),
      ],
    };
  }

  const button_id =
    typeof button_resolution._resolved_target_id === "string" &&
    button_resolution._resolved_target_id.trim()
      ? button_resolution._resolved_target_id.trim()
      : "add-meal-button";

  _xlog.log("[xvibe] composed mutation plan", {
    _goal: sentence_goal(original),
    _primitive_count: 2,
    _composition: ["add-child", "update-property"],
    _view_id: main_resolution._view_id,
    _referenced_view_id: create_meal_resolution._view_id,
    _button_id: button_id,
    _modal_id: "create-meal-modal",
  });

  return {
    _title: "Add Meal Modal",
    _goal: sentence_goal(original),
    _steps: [
      {
        _id: "create-create-meal-modal",
        _title: "Create Add Meal modal",
        _status: "planned",
        _view_id: main_resolution._view_id,
        _target_id: main_resolution._view_id,
        _target_type: "view",
        _child: {
          _type: "modal",
          _id: "create-meal-modal",
          _open: false,
          _title: "Add Meal",
          _size: "lg",
          _closable: true,
          _close_on_backdrop: true,
          _children: [
            {
              _type: "xvm-view",
              _view_id: create_meal_resolution._view_id,
            },
          ],
        },
      },
      {
        _id: "bind-add-meal-button-to-modal",
        _title: "Open Add Meal modal from Add Meal button",
        _status: "planned",
        _view_id: main_resolution._view_id,
        _target_id: button_id,
        _target_type: "button",
        _property_name: "_on",
        _property_value: merge_open_modal_handler(button_resolution.object._on),
      },
    ],
  };
}

async function flow_exists(input: {
  runtime_context: XVibeIntentRuntimeContext;
  flow_id: string;
}): Promise<boolean> {
  const app_id =
    read_non_empty_string(input.runtime_context._app_id);
  const env =
    read_non_empty_string(input.runtime_context._env);
  if (!app_id || !env) return false;

  try {
    const response =
      await _x.execute({
        _module: "server-xvm",
        _op: "get_flow",
        _params: {
          _app_id: app_id,
          _env: env,
          _flow_id: input.flow_id,
        },
      } as any);
    return response?._ok === true;
  } catch {
    return false;
  }
}

function extract_button_flow_binding_request(prompt: string): {
  button_text: string;
  button_id: string;
  parent_id: string;
  flow_id: string;
} | null {
  if (!/\b(?:create|add)\b/u.test(prompt) || !/\bbutton\b/u.test(prompt)) {
    return null;
  }
  if (!/\b(?:bind|connect|run)\b/u.test(prompt)) {
    return null;
  }
  if (!/\b(?:main\s+toolbar|toolbar)\b/u.test(prompt)) {
    return null;
  }

  const button_match =
    /\b(?:create|add)\s+(?:a\s+|an\s+|the\s+)?([a-z0-9][a-z0-9 -]*?)\s+button\b/u
      .exec(prompt);
  const flow_match =
    /\b(?:bind|connect|run)\s+(?:it|this|that|the\s+[a-z0-9 -]+?\s+button)?\s*(?:to|with|against)?\s+(?:the\s+)?([a-z0-9][a-z0-9-]*)\b/u
      .exec(prompt);
  if (!button_match?.[1] || !flow_match?.[1]) {
    return null;
  }

  const button_text =
    title_case(button_match[1].trim());
  const flow_id =
    flow_match[1].trim().toLowerCase();
  if (!button_text || !flow_id) return null;

  return {
    button_text,
    button_id: `${safe_step_id(button_text)}-button`,
    parent_id: "main-toolbar",
    flow_id,
  };
}

async function button_flow_binding_plan(
  prompt: string,
  original: string,
  runtime_context: XVibeIntentRuntimeContext,
): Promise<MutationPlanMatch | null> {
  const request =
    extract_button_flow_binding_request(prompt);
  if (!request) return null;

  const view_id =
    read_current_view_id(runtime_context);
  const view =
    await load_runtime_view({
      runtime_context,
      view_id,
    });
  const toolbar =
    find_view_node_by_id(view, request.parent_id);
  const has_toolbar =
    Boolean(toolbar && (!toolbar._type || toolbar._type === "toolbar"));
  const has_flow =
    await flow_exists({
      runtime_context,
      flow_id: request.flow_id,
    });

  const steps: MutationPlanStep[] = [
    has_toolbar
      ? planned_add_button_step(request)
      : unsupported_step(
        `add-${safe_step_id(request.button_text)}-button-to-toolbar`,
        `Add ${request.button_text} button to toolbar`,
        "toolbar_not_found",
      ),
    has_flow
      ? planned_bind_button_flow_step(request)
      : unsupported_step(
        `bind-${safe_step_id(request.button_text)}-button-to-${safe_step_id(request.flow_id)}`,
        `Bind ${request.button_text} button to ${request.flow_id}`,
        "flow_not_found",
      ),
  ];

  _xlog.log("[xvibe] composed mutation plan", {
    _goal: sentence_goal(original),
    _primitive_count: steps.length,
    _composition: ["add-child", "bind-flow"],
    _button_id: request.button_id,
    _flow_id: request.flow_id,
  });

  return {
    _title: `${request.button_text} Button Flow Binding`,
    _goal: sentence_goal(original),
    _steps: steps,
  };
}

function prompt_toolbar_move_targets(prompt: string): string[] {
  return TOOLBAR_MOVE_TARGETS.filter((target) => {
    const pattern =
      new RegExp(`\\b${target.toLowerCase().replace(/\s+/gu, "\\s+")}\\b`, "u");
    return pattern.test(prompt);
  });
}

function toolbar_move_plan(prompt: string, original: string): MutationPlanMatch | null {
  if (
    !/\b(?:add|create|insert|build)\b/u.test(prompt) ||
    !/\btoolbar\b/u.test(prompt)
  ) {
    return null;
  }

  const target_texts =
    prompt_toolbar_move_targets(prompt);
  if (target_texts.length === 0) {
    return null;
  }

  const explicit_move =
    /\b(?:move|place|put)\b/u.test(prompt) ||
    /\b(?:inside|into)\b/u.test(prompt) ||
    /\bto\s+(?:the\s+)?toolbar\b/u.test(prompt);
  const shorthand_existing_objects =
    /\bwith\b/u.test(prompt) &&
    target_texts.some((target) => target === "Refresh" || target === "New Record");
  if (!explicit_move && !shorthand_existing_objects) {
    return null;
  }

  const steps = [
    planned_step("create-toolbar", "Create toolbar"),
    ...target_texts.map((target_text) => planned_move_step(target_text)),
  ];

  _xlog.log("[xvibe] composed mutation plan", {
    _goal: sentence_goal(original),
    _primitive_count: steps.length,
    _composition: [
      "create-toolbar",
      ...target_texts.map(() => "move-object"),
    ],
  });

  return {
    _title: "Toolbar",
    _goal: sentence_goal(original),
    _steps: steps,
  };
}

function toolbar_plan(prompt: string, original: string): MutationPlanMatch | null {
  if (
    !/\b(?:add|create|insert|build)\b/u.test(prompt) ||
    !/\btoolbar\b/u.test(prompt)
  ) {
    return null;
  }

  const has_multiple_buttons =
    /\bwith\b/u.test(prompt) &&
      /\b(?:save|cancel|done|close|submit|back|next)\b/u.test(prompt) &&
      /\band\b/u.test(prompt);
  if (!has_multiple_buttons) {
    return null;
  }

  const steps = [
    planned_step("create-toolbar", "Create toolbar"),
  ];
  if (/\bsave\b/u.test(prompt)) {
    steps.push(planned_step("create-save-button", "Create Save button"));
  }
  if (/\bcancel\b/u.test(prompt)) {
    steps.push(planned_step("create-cancel-button", "Create Cancel button"));
  }
  if (steps.length < 3) {
    steps.push(planned_step("create-toolbar-button", "Create toolbar button"));
  }

  return {
    _title: "Toolbar",
    _goal: sentence_goal(original),
    _steps: steps,
  };
}

function dashboard_plan(prompt: string, original: string): MutationPlanMatch | null {
  if (
    !/\bdashboard\b/u.test(prompt) ||
    !/\b(?:build|create|redesign|design|make)\b/u.test(prompt)
  ) {
    return null;
  }

  const subject_match =
    /\b(?:build|create|make)\s+(?:a\s+|an\s+|the\s+)?([a-z0-9 -]+?)\s+dashboard\b/u
      .exec(prompt);
  const subject =
    subject_match?.[1]?.trim();
  const title = subject
    ? `${title_case(subject)} Dashboard`
    : "Dashboard";

  return {
    _title: title,
    _goal: sentence_goal(original),
    _steps: [
      planned_step("create-dashboard-section", "Create dashboard section"),
      planned_step("create-dashboard-summary", "Create summary area"),
      planned_step("create-dashboard-actions", "Create dashboard actions"),
    ],
  };
}

function redesign_plan(prompt: string, original: string): MutationPlanMatch | null {
  if (
    !/\b(?:redesign|rework|revamp)\b/u.test(prompt) ||
    !/\b(?:page|screen|view|dashboard|this)\b/u.test(prompt)
  ) {
    return null;
  }

  return {
    _title: "Redesign",
    _goal: sentence_goal(original),
    _steps: [
      planned_step("review-current-layout", "Review current layout"),
      planned_step("update-layout-structure", "Update layout structure"),
      planned_step("update-visual-styling", "Update visual styling"),
    ],
  };
}

function screen_plan(prompt: string, original: string): MutationPlanMatch | null {
  if (
    !/\b(?:create|build|make|design)\b/u.test(prompt) ||
    !/\b(?:screen|page)\b/u.test(prompt)
  ) {
    return null;
  }

  if (/\btoolbar\b/u.test(prompt)) {
    return null;
  }

  const crm = /\bcrm\b/u.test(prompt);
  const customer_management =
    /\bcustomer\s+management\b/u.test(prompt);
  const title = crm
    ? "CRM Screen"
    : customer_management
      ? "Customer Management Page"
      : /\bpage\b/u.test(prompt)
        ? "Page"
        : "Screen";

  return {
    _title: title,
    _goal: sentence_goal(original),
    _steps: [
      planned_step(`create-${safe_step_id(title)}`, `Create ${title}`),
      planned_step("create-primary-section", "Create primary section"),
      planned_step("create-primary-actions", "Create primary actions"),
    ],
  };
}

async function match_mutation_plan(
  message: string,
  runtime_context: XVibeIntentRuntimeContext,
): Promise<MutationPlanMatch | null> {
  const prompt = normalize_prompt(message);
  if (!prompt || is_simple_primitive_prompt(prompt)) {
    return null;
  }

  return (
    await entity_list_aggregation_plan(prompt, message, runtime_context) ??
    await entity_aggregation_plan(prompt, message, runtime_context) ??
    await entity_list_plan(prompt, message, runtime_context) ??
    await meal_modal_plan(prompt, message, runtime_context) ??
    await button_flow_binding_plan(prompt, message, runtime_context) ??
    toolbar_move_plan(prompt, message) ??
    toolbar_plan(prompt, message) ??
    redesign_plan(prompt, message) ??
    dashboard_plan(prompt, message) ??
    screen_plan(prompt, message)
  );
}

export class MutationPlanningProcessor implements XVibeIntentProcessor {
  async analyze(
    request: XVibeIntentEngineRequest,
  ): Promise<XVibeIntentResult | null> {
    if (
      request._runtime_context._stage === "planning" &&
      !has_explicit_view_context(request._runtime_context)
    ) {
      return null;
    }

    const match = await match_mutation_plan(
      request._message,
      request._runtime_context,
    );
    if (!match || match._steps.length < 2) {
      return null;
    }

    const compiled_steps =
      compile_mutation_plan_steps({
        steps: match._steps,
        runtime_context: request._runtime_context,
      });
    const executable_steps =
      compiled_steps.filter((step) => step._primitive).length;
    const unsupported_steps =
      compiled_steps.filter((step) => step._status === "unsupported").length;
    const can_apply =
      compiled_steps.length > 0 &&
      executable_steps === compiled_steps.length &&
      unsupported_steps === 0;

    const artifact: MutationPlanArtifact = {
      _type: "mutation-plan",
      _title: match._title,
      _goal: match._goal,
      _summary: "This change requires several deterministic mutations.",
      _steps: compiled_steps,
      _estimated_mutations: compiled_steps.length,
      _executable_steps: executable_steps,
      _unsupported_steps: unsupported_steps,
      _can_apply: can_apply,
      _status: "planned",
      _buttons: PLACEHOLDER_BUTTONS.map((button) => ({ ...button })),
    };

    _xlog.log("[xvibe] mutation plan created", {
      _goal: artifact._goal,
      _steps: artifact._steps.map((step) => step._id),
      _estimated_mutations: artifact._estimated_mutations,
    });
    _xlog.log("[xvibe] mutation plan compiled", {
      _step_count: artifact._steps.length,
      _executable_steps: artifact._executable_steps,
      _unsupported_steps: artifact._unsupported_steps,
      _can_apply: artifact._can_apply,
    });

    return {
      _message_type: "planning",
      _execution_level: "planning",
      _should_mutate: false,
      _confidence: 1,
      _reason: "deterministic_mutation_plan",
      _artifact_type: "mutation-plan",
      _artifact_request: artifact,
      _actions: [],
      _warnings: [],
    };
  }
}
