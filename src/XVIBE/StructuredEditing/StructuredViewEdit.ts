import { _x, _xlog, type XCommand } from "@xpell/core";
import { _xem } from "../../XEM/XEventManager.js";
import { _xu } from "../../XNUtils/XUtils.js";
import { wsBroadcastScoped } from "../../Wormholes/wh.index.js";
import type { XVibeJsonObject } from "../VibeOutputParser.js";
import type { XVibeResolvedTask } from "../XVibeTypes.js";

const DEFAULT_ENV = "default";

export type StructuredViewEditAction =
  | "set-property"
  | "remove-property"
  | "set-style"
  | "remove-style"
  | "add-class"
  | "remove-class"
  | "replace-class"
  | "toggle-class"
  | "remove-object"
  | "hide-object"
  | "show-object"
  | "move-object"
  | "replace-object"
  | "duplicate-object"
  | "add-child";

export type StructuredViewEditIntent = XVibeJsonObject & {
  _action:
    | "remove"
    | "hide"
    | "show"
    | "update"
    | "add-class"
    | "remove-class"
    | "replace-class"
    | "toggle-class"
    | "set-style"
    | "remove-style"
    | "set-style-class-rule"
    | "remove-style-class-rule"
    | "set-property"
    | "remove-property"
    | "move-object"
    | "replace-object"
    | "duplicate-object"
    | "add-child";
  _target_id?: string;
  _field?: string;
  _target_text?: string;
  _replacement_text?: string;
  _class_name?: string;
  _old_class_name?: string;
  _new_class_name?: string;
  _style_property?: string;
  _style_value?: string;
  _property_name?: string;
  _property_value?: unknown;
  _object_value?: XVibeJsonObject;
  _move_position?: "before" | "after" | "top" | "bottom";
  _anchor_id?: string;
  _anchor_text?: string;
  _anchor_type?: string;
  _target_type?: string;
  _child?: XVibeJsonObject;
  _warnings?: string[];
};

export type StructuredViewEditEligibility = {
  _eligible: boolean;
  _action?:
    | "update-text"
    | "remove-object"
    | "hide-object"
    | "show-object"
    | "add-class"
    | "remove-class"
    | "replace-class"
    | "toggle-class"
    | "set-style"
    | "remove-style"
    | "set-style-class-rule"
    | "remove-style-class-rule"
    | "set-property"
    | "remove-property"
    | "move-object"
    | "replace-object"
    | "duplicate-object"
    | "add-child";
  _target_id?: string;
  _field?: "_text";
  _reason?: string;
  _details?: unknown;
};

export type StructuredViewEditMutation = XVibeJsonObject & {
  _type: "deterministic-view-edit";
  _action: string;
  _target_id?: string;
};

export type StructuredViewEditDeterministicResult = {
  _ok: boolean;
  _view?: unknown;
  _mutation?: StructuredViewEditMutation;
  _reason?: string;
  _details?: unknown;
};

export type StructuredViewEditReferencedView = {
  _view_id: string;
  _view: XVibeJsonObject;
};

export type StructuredViewEditReferenceLoadResult = {
  _referenced_view_ids: string[];
  _loaded_views: StructuredViewEditReferencedView[];
  _missing_view_ids: string[];
  _warnings: string[];
};

export type StructuredViewEditSourceResolution =
  | {
    _eligible: true;
    _view_id: string;
    _view: unknown;
    _resolved_via: "current-view" | "xvm-view";
    _eligibility: StructuredViewEditEligibility;
    _warnings: string[];
  }
  | {
    _eligible: false;
    _eligibility: StructuredViewEditEligibility;
    _warnings: string[];
  };

export type StructuredViewEditRunArchiveData = {
  _generation_id?: string;
  _app_id?: string;
  _env?: string;
  _view_id?: string;
  _requested_view_id?: string;
  _source_view_id?: string;
  _mode?: "full" | "refine";
  _artifact_type?: string;
  _created_at?: string;
  _resolved_task?: XVibeResolvedTask;
  _deterministic_mutation?: unknown;
  _result?: XVibeJsonObject;
  _duration_ms?: number;
  _timeline?: Array<{
    _stage: string;
    _message?: string;
    _t_ms: number;
    _at: string;
    _details?: Record<string, unknown>;
  }>;
};

export type StructuredViewEditDependencies = {
  _load_current_view_for_refine: (input: {
    _app_id: string;
    _env: string;
    _view_id: string;
  }) => Promise<XVibeJsonObject>;
  _load_xvm_view_references_for_refine: (input: {
    _app_id: string;
    _env: string;
    _view_id: string;
    _current_view: unknown;
  }) => Promise<StructuredViewEditReferenceLoadResult>;
  _can_apply_deterministic_view_edit: (input: {
    _resolved_task: XVibeResolvedTask;
    _current_view: unknown;
    _edit_intent?: StructuredViewEditIntent;
  }) => StructuredViewEditEligibility;
  _apply_deterministic_view_edit: (input: {
    _resolved_task: XVibeResolvedTask;
    _current_view: unknown;
    _edit_intent?: StructuredViewEditIntent;
  }) => StructuredViewEditDeterministicResult;
  _resolve_deterministic_view_edit_source: (input: {
    _requested_view_id: string;
    _current_view: unknown;
    _referenced_views: StructuredViewEditReferencedView[];
    _reference_warnings: string[];
    _resolved_task: XVibeResolvedTask;
    _edit_intent?: StructuredViewEditIntent;
  }) => StructuredViewEditSourceResolution;
  _structured_error_payload: (error: unknown) => XVibeJsonObject | undefined;
  _archive_vibe_run: (archive: StructuredViewEditRunArchiveData) => void;
};

function read_required_string(value: unknown, field_name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid '${field_name}': expected non-empty string`);
  }

  return value.trim();
}

function read_optional_string(value: unknown, field_name: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid '${field_name}': expected non-empty string`);
  }

  return value.trim();
}

function read_optional_generation_id(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error("Invalid '_generation_id': expected string");
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function error_summary(error: unknown): XVibeJsonObject | string {
  if (error instanceof Error) {
    return {
      _name: error.name,
      _message: error.message,
    };
  }

  return String(error);
}

function safe_short_id(): string {
  return Math.random().toString(36).slice(2, 10);
}

function record_archive_stage(
  archive: StructuredViewEditRunArchiveData | undefined,
  started_at: number | undefined,
  stage: string,
  message?: string,
  details?: Record<string, unknown>,
): void {
  try {
    if (!archive || typeof started_at !== "number") return;

    archive._timeline =
      archive._timeline ?? [];
    archive._timeline.push({
      _stage: stage,
      ...(message ? { _message: message } : {}),
      _t_ms: Date.now() - started_at,
      _at: new Date().toISOString(),
      ...(details && Object.keys(details).length > 0
        ? { _details: details }
        : {}),
    });
  } catch (error) {
    _xlog.warn("[xvibe] run archive failed", {
      _error: error_summary(error),
    });
  }
}

function extract_persisted_version(value: unknown): number | string | undefined {
  if (!_xu.is_plain_object(value)) return undefined;

  if (
    typeof value._version === "number" ||
    typeof value._version === "string"
  ) {
    return value._version;
  }

  if (_xu.is_plain_object(value._result)) {
    return extract_persisted_version(value._result);
  }

  return undefined;
}

function explicit_error(code: string, message: string, details?: XVibeJsonObject) {
  return {
    _ok: false,
    _error: {
      _code: code,
      _message: message,
      ...(details ? { _details: details } : {}),
    },
  };
}

function read_structured_view_edit_action(value: unknown): StructuredViewEditAction {
  if (
    value === "set-property" ||
    value === "remove-property" ||
    value === "set-style" ||
    value === "remove-style" ||
    value === "add-class" ||
    value === "remove-class" ||
    value === "replace-class" ||
    value === "toggle-class" ||
    value === "remove-object" ||
    value === "hide-object" ||
    value === "show-object" ||
    value === "move-object" ||
    value === "replace-object" ||
    value === "duplicate-object" ||
    value === "add-child"
  ) {
    return value;
  }

  throw new Error("Invalid '_edit_action': unsupported deterministic view edit action");
}

function read_structured_property_value(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    Array.isArray(value) ||
    _xu.is_plain_object(value)
  ) {
    return value;
  }

  throw new Error("Invalid '_property_value': expected JSON-compatible value");
}

function read_structured_object_value(value: unknown): XVibeJsonObject {
  if (_xu.is_plain_object(value)) {
    return value;
  }

  throw new Error("Invalid '_object_value': expected object");
}

function read_structured_child_value(value: unknown): XVibeJsonObject {
  if (!_xu.is_plain_object(value)) {
    throw new Error("Invalid '_child': expected object");
  }

  if (typeof value._type !== "string" || value._type.trim().length === 0) {
    throw new Error("Invalid '_child._type': expected non-empty string");
  }

  return value;
}

function read_structured_source_view_id(params: XVibeJsonObject): string | undefined {
  const direct_source_view_id =
    read_optional_string(params._source_view_id, "_source_view_id");
  if (direct_source_view_id) {
    return direct_source_view_id;
  }

  if (_xu.is_plain_object(params._selected_object)) {
    return read_optional_string(
      params._selected_object._source_view_id,
      "_selected_object._source_view_id",
    );
  }

  if (_xu.is_plain_object(params._target)) {
    return read_optional_string(
      params._target._source_view_id,
      "_target._source_view_id",
    );
  }

  return undefined;
}

async function resolve_structured_view_edit_source(input: {
  app_id: string;
  env: string;
  view_id: string;
  source_view_id?: string;
  current_view: XVibeJsonObject;
  resolved_task: XVibeResolvedTask;
  edit_intent: StructuredViewEditIntent;
  deps: StructuredViewEditDependencies;
}): Promise<StructuredViewEditSourceResolution> {
  if (input.source_view_id) {
    if (input.source_view_id === input.view_id) {
      const eligibility =
        input.deps._can_apply_deterministic_view_edit({
          _resolved_task: input.resolved_task,
          _current_view: input.current_view,
          _edit_intent: input.edit_intent,
        });

      if (!eligibility._eligible) {
        return {
          _eligible: false,
          _eligibility: eligibility,
          _warnings: [],
        };
      }

      return {
        _eligible: true,
        _view_id: input.view_id,
        _view: input.current_view,
        _resolved_via: "current-view",
        _eligibility: eligibility,
        _warnings: [],
      };
    }

    const references =
      await input.deps._load_xvm_view_references_for_refine({
        _app_id: input.app_id,
        _env: input.env,
        _view_id: input.view_id,
        _current_view: input.current_view,
      });
    const source_view =
      references._loaded_views.find((view) => view._view_id === input.source_view_id);

    if (!references._referenced_view_ids.includes(input.source_view_id)) {
      return {
        _eligible: false,
        _eligibility: {
          _eligible: false,
          _reason: "source_view_not_referenced",
          _details: {
            _view_id: input.view_id,
            _source_view_id: input.source_view_id,
            _referenced_view_ids: references._referenced_view_ids,
          },
        },
        _warnings: references._warnings,
      };
    }

    if (!source_view) {
      return {
        _eligible: false,
        _eligibility: {
          _eligible: false,
          _reason: "source_view_not_loaded",
          _details: {
            _view_id: input.view_id,
            _source_view_id: input.source_view_id,
          },
        },
        _warnings: references._warnings,
      };
    }

    const eligibility =
      input.deps._can_apply_deterministic_view_edit({
        _resolved_task: input.resolved_task,
        _current_view: source_view._view,
        _edit_intent: input.edit_intent,
      });

    if (!eligibility._eligible) {
      return {
        _eligible: false,
        _eligibility: eligibility,
        _warnings: references._warnings,
      };
    }

    return {
      _eligible: true,
      _view_id: input.source_view_id,
      _view: source_view._view,
      _resolved_via: "xvm-view",
      _eligibility: eligibility,
      _warnings: references._warnings,
    };
  }

  const references =
    await input.deps._load_xvm_view_references_for_refine({
      _app_id: input.app_id,
      _env: input.env,
      _view_id: input.view_id,
      _current_view: input.current_view,
    });

  return input.deps._resolve_deterministic_view_edit_source({
    _requested_view_id: input.view_id,
    _current_view: input.current_view,
    _referenced_views: references._loaded_views,
    _reference_warnings: references._warnings,
    _resolved_task: input.resolved_task,
    _edit_intent: input.edit_intent,
  });
}

function push_structured_view_edit_active_view_refresh(input: {
  app_id: string;
  env: string;
  view_id: string;
  source_view_id: string;
  current_view: XVibeJsonObject;
  version?: number;
  generation_id?: string;
  target_id: string;
  edit_action: string;
}): void {
  if (input.source_view_id === input.view_id) {
    return;
  }

  try {
    wsBroadcastScoped(input.app_id, input.env, {
      _name: "xvm:update",
      _args: [{
        _app_id: input.app_id,
        _env: input.env,
        _view_id: input.view_id,
        _view:
          typeof input.current_view._id === "string"
            ? input.current_view
            : { ...input.current_view, _id: input.view_id },
        ...(input.version !== undefined ? { _version: input.version } : {}),
        ...(input.generation_id ? { _generation_id: input.generation_id } : {}),
        _meta: {
          _source: "xstudio:intent-action-refresh",
          _force_refresh: true,
          _source_view_id: input.source_view_id,
          _persisted_view_id: input.source_view_id,
          _target_id: input.target_id,
          _edit_action: input.edit_action,
        },
      }],
    });
  } catch (error) {
    _xlog.warn("[xvibe] structured view edit active view refresh failed", {
      _app_id: input.app_id,
      _env: input.env,
      _view_id: input.view_id,
      _source_view_id: input.source_view_id,
      _error: error_summary(error),
    });
  }
}

function build_structured_view_edit_task(input: {
  view_id: string;
  action: StructuredViewEditAction;
  target_id: string;
  target_type?: string;
  params: XVibeJsonObject;
}): {
  resolved_task: XVibeResolvedTask;
  edit_intent: StructuredViewEditIntent;
} {
  const deterministic_action =
    input.action === "remove-object"
      ? "remove"
      : input.action === "hide-object"
        ? "hide"
        : input.action === "show-object"
          ? "show"
          : input.action;
  const resolved_task: XVibeResolvedTask = {
    _action: "update",
    _artifact_type: "view",
    _target_id: input.view_id,
    _edit_action: deterministic_action,
    _edit_target_id: input.target_id,
    ...(input.target_type ? { _edit_target_type: input.target_type } : {}),
    _explicit_artifact_type: true,
    _explicit_target_id: true,
    _module_ops: [],
    _source: "xvibe.apply-view-edit",
    _confidence: 1,
    _warnings: [],
  };
  const edit_intent: StructuredViewEditIntent = {
    _action: deterministic_action,
    _target_id: input.target_id,
    ...(input.target_type ? { _target_type: input.target_type } : {}),
    _structured_apply_view_edit: true,
  };

  if (
    input.action === "remove-object" ||
    input.action === "hide-object" ||
    input.action === "show-object"
  ) {
    return { resolved_task, edit_intent };
  }

  if (input.action === "duplicate-object") {
    if (!input.target_type) {
      throw new Error("Invalid '_target_type': expected non-empty string");
    }

    const after_id =
      read_optional_string(input.params._after_id, "_after_id");
    const before_id =
      read_optional_string(input.params._before_id, "_before_id");
    if (after_id) {
      resolved_task._edit_move_position = "after";
      resolved_task._edit_anchor_id = after_id;
      edit_intent._move_position = "after";
      edit_intent._anchor_id = after_id;
    } else if (before_id) {
      resolved_task._edit_move_position = "before";
      resolved_task._edit_anchor_id = before_id;
      edit_intent._move_position = "before";
      edit_intent._anchor_id = before_id;
    }

    return { resolved_task, edit_intent };
  }

  if (input.action === "replace-object") {
    const object_value =
      read_structured_object_value(input.params._object_value);
    resolved_task._edit_object_value = object_value;
    edit_intent._object_value = object_value;
    return { resolved_task, edit_intent };
  }

  if (input.action === "add-child") {
    const child_value =
      read_structured_child_value(input.params._child);
    resolved_task._edit_child_value = child_value;
    edit_intent._child = child_value;
    return { resolved_task, edit_intent };
  }

  if (input.action === "move-object") {
    if (!input.target_type) {
      throw new Error("Invalid '_target_type': expected non-empty string");
    }

    const before_id =
      read_optional_string(input.params._before_id, "_before_id");
    const after_id =
      read_optional_string(input.params._after_id, "_after_id");
    if (Boolean(before_id) === Boolean(after_id)) {
      throw new Error("Invalid move-object anchors: exactly one of '_before_id' or '_after_id' is required");
    }

    resolved_task._edit_move_position = before_id ? "before" : "after";
    resolved_task._edit_anchor_id = before_id ?? after_id;
    edit_intent._move_position = resolved_task._edit_move_position;
    edit_intent._anchor_id = resolved_task._edit_anchor_id;
    return { resolved_task, edit_intent };
  }

  if (input.action === "set-property" || input.action === "remove-property") {
    const property_name =
      read_required_string(input.params._property_name, "_property_name");
    resolved_task._edit_property_name = property_name;
    edit_intent._property_name = property_name;

    if (input.action === "set-property") {
      const property_value =
        read_structured_property_value(input.params._property_value);
      if (property_value === undefined) {
        throw new Error("Invalid '_property_value': expected value for set-property");
      }
      if (property_name === "class" && typeof property_value !== "string") {
        throw new Error("Invalid '_property_value': class value must be a string");
      }
      resolved_task._edit_property_value = property_value;
      edit_intent._property_value = property_value;
    }

    return { resolved_task, edit_intent };
  }

  if (input.action === "set-style" || input.action === "remove-style") {
    const style_property =
      read_required_string(input.params._style_property, "_style_property");
    resolved_task._edit_style_property = style_property;
    edit_intent._style_property = style_property;

    if (input.action === "set-style") {
      const style_value =
        read_required_string(input.params._style_value, "_style_value");
      resolved_task._edit_style_value = style_value;
      edit_intent._style_value = style_value;
    }

    return { resolved_task, edit_intent };
  }

  if (input.action === "replace-class") {
    const old_class_name =
      read_required_string(input.params._old_class_name, "_old_class_name");
    const new_class_name =
      read_required_string(input.params._new_class_name, "_new_class_name");
    resolved_task._edit_old_class_name = old_class_name;
    resolved_task._edit_new_class_name = new_class_name;
    edit_intent._old_class_name = old_class_name;
    edit_intent._new_class_name = new_class_name;
    return { resolved_task, edit_intent };
  }

  const class_name =
    read_required_string(input.params._class_name, "_class_name");
  resolved_task._edit_class_name = class_name;
  edit_intent._class_name = class_name;
  return { resolved_task, edit_intent };
}

function apply_view_edit_failure(input: {
  code: string;
  message: string;
  app_id?: string;
  env?: string;
  view_id?: string;
  action?: string;
  target_id?: string;
  reason?: string;
  details?: unknown;
  archive?: StructuredViewEditRunArchiveData;
}) {
  const details: XVibeJsonObject = {
    ...(input.app_id ? { _app_id: input.app_id } : {}),
    ...(input.env ? { _env: input.env } : {}),
    ...(input.view_id ? { _view_id: input.view_id } : {}),
    ...(input.action ? { _mutation_action: input.action } : {}),
    ...(input.target_id ? { _target_id: input.target_id } : {}),
    ...(input.reason ? { _reason: input.reason } : {}),
    ...(input.details !== undefined ? { _details: input.details } : {}),
  };

  if (input.archive) {
    input.archive._deterministic_mutation = {
      _eligible: false,
      ...(input.reason ? { _reason: input.reason } : {}),
      ...(input.details !== undefined ? { _details: input.details } : {}),
    };
    input.archive._result = {
      _artifact_type: "view",
      ...(input.view_id ? { _artifact_id: input.view_id, _view_id: input.view_id } : {}),
      _success: false,
      _deterministic: true,
      ...(input.action ? { _mutation_action: input.action } : {}),
      ...(input.target_id ? { _mutation_target_id: input.target_id } : {}),
      _error: {
        _code: input.code,
        _message: input.message,
        ...(Object.keys(details).length > 0 ? { _details: details } : {}),
      },
    };
  }

  return {
    _ok: false,
    _artifact_type: "view",
    ...(input.view_id ? { _artifact_id: input.view_id, _view_id: input.view_id } : {}),
    _deterministic: true,
    ...(input.action ? { _mutation_action: input.action } : {}),
    ...(input.target_id ? { _target_id: input.target_id } : {}),
    ...(input.reason ? { _reason: input.reason } : {}),
    _error: {
      _code: input.code,
      _message: input.message,
      ...(Object.keys(details).length > 0 ? { _details: details } : {}),
    },
  };
}

export class StructuredViewEdit {
  static async apply(input: {
    _cmd: XCommand;
    _deps: StructuredViewEditDependencies;
  }) {
    const archive_started_at = Date.now();
    const archive_created_at = new Date().toISOString();
    let archive: StructuredViewEditRunArchiveData | undefined;
    const deps = input._deps;

    try {
      const params = _xu.is_plain_object(input._cmd?._params) ? input._cmd._params : {};
      const app_id = read_required_string(params._app_id, "_app_id");
      const env = read_required_string(params._env ?? DEFAULT_ENV, "_env");
      const view_id = read_required_string(params._view_id, "_view_id");
      const action = read_structured_view_edit_action(params._edit_action);
      const target_id = read_required_string(params._target_id, "_target_id");
      const target_type = read_optional_string(params._target_type, "_target_type");
      const requested_source_view_id = read_structured_source_view_id(params);
      const generation_id = read_optional_generation_id(params._generation_id) ?? safe_short_id();
      const task =
        build_structured_view_edit_task({
          view_id,
          action,
          target_id,
          ...(target_type ? { target_type } : {}),
          params,
        });

      archive = {
        _generation_id: generation_id,
        _app_id: app_id,
        _env: env,
        _view_id: view_id,
        ...(requested_source_view_id && requested_source_view_id !== view_id
          ? { _source_view_id: requested_source_view_id, _requested_view_id: view_id }
          : {}),
        _mode: "refine",
        _artifact_type: "view",
        _created_at: archive_created_at,
        _resolved_task: task.resolved_task,
      };

      record_archive_stage(
        archive,
        archive_started_at,
        "loading-view",
        "Loading current view...",
        {
          _view_id: view_id,
          _mutation_action: action,
          _target_id: target_id,
        },
      );

      const current_view =
        await deps._load_current_view_for_refine({
          _app_id: app_id,
          _env: env,
          _view_id: view_id,
        });

      const deterministic_source =
        await resolve_structured_view_edit_source({
          app_id,
          env,
          view_id,
          ...(requested_source_view_id ? { source_view_id: requested_source_view_id } : {}),
          current_view,
          resolved_task: task.resolved_task,
          edit_intent: task.edit_intent,
          deps,
        });
      const eligibility = deterministic_source._eligibility;
      const source_view_id =
        deterministic_source._eligible ? deterministic_source._view_id : requested_source_view_id ?? view_id;

      if (!eligibility._eligible) {
        _xlog.log("[xvibe] structured view edit not eligible", {
          _app_id: app_id,
          _env: env,
          _view_id: view_id,
          ...(source_view_id !== view_id ? { _source_view_id: source_view_id } : {}),
          _action: action,
          _target_id: target_id,
          _reason: eligibility._reason,
          ...(eligibility._details !== undefined ? { _details: eligibility._details } : {}),
        });

        return apply_view_edit_failure({
          code: "E_XVIBE_APPLY_VIEW_EDIT_NOT_ELIGIBLE",
          message: `Deterministic view edit is not eligible: ${eligibility._reason}`,
          app_id,
          env,
          view_id,
          action,
          target_id,
          reason: eligibility._reason,
          details: eligibility._details,
          archive,
        });
      }

      record_archive_stage(
        archive,
        archive_started_at,
        "deterministic-mutating",
        "Applying deterministic view edit...",
        {
          _view_id: view_id,
          _source_view_id: source_view_id,
          _action: eligibility._action,
          _target_id: eligibility._target_id,
        },
      );

      _xlog.log("[xvibe] structured view edit source resolved", {
        _app_id: app_id,
        _env: env,
        _view_id: view_id,
        _source_view_id: source_view_id,
        _persisted_view_id: source_view_id,
        _target_id: eligibility._target_id ?? target_id,
        _edit_action: eligibility._action ?? action,
        ...(deterministic_source._eligible
          ? { _resolved_via: deterministic_source._resolved_via }
          : {}),
      });

      const deterministic_result =
        deps._apply_deterministic_view_edit({
          _resolved_task: task.resolved_task,
          _current_view: deterministic_source._eligible
            ? deterministic_source._view
            : current_view,
          _edit_intent: task.edit_intent,
        });

      if (!deterministic_result._ok || !deterministic_result._view || !deterministic_result._mutation) {
        return apply_view_edit_failure({
          code: "E_XVIBE_APPLY_VIEW_EDIT_FAILED",
          message: `Deterministic view edit failed: ${deterministic_result._reason ?? "unknown"}`,
          app_id,
          env,
          view_id,
          action,
          target_id,
          reason: deterministic_result._reason ?? "deterministic_mutation_failed",
          details: deterministic_result._details,
          archive,
        });
      }

      const view_to_persist = deterministic_result._view as XVibeJsonObject;
      const mutated_view_id =
        typeof view_to_persist._id === "string" ? view_to_persist._id.trim() : "";
      if (mutated_view_id !== source_view_id) {
        return apply_view_edit_failure({
          code: "E_XVIBE_SOURCE_VIEW_PERSIST_MISMATCH",
          message: "Structured view edit attempted to persist a non-source view",
          app_id,
          env,
          view_id,
          action,
          target_id,
          reason: "source_view_id_mismatch",
          details: {
            _requested_view_id: view_id,
            _source_view_id: source_view_id,
            _view_id: mutated_view_id,
          },
          archive,
        });
      }

      archive._deterministic_mutation = {
        _eligible: true,
        _reason: eligibility._reason,
        ...deterministic_result._mutation,
        _target_view_id: source_view_id,
        _source_view_id: source_view_id,
        _requested_view_id: view_id,
        ...(deterministic_source._eligible && deterministic_source._resolved_via === "xvm-view"
          ? { _resolved_via: "xvm-view" }
          : {}),
      };

      record_archive_stage(
        archive,
        archive_started_at,
        "saving",
        "Saving view...",
        {
          _view_id: view_id,
          _source_view_id: source_view_id,
          _persisted_view_id: source_view_id,
          _action: deterministic_result._mutation._action,
          _target_id: deterministic_result._mutation._target_id,
        },
      );

      const persist_response = await _x.execute({
        _module: "server-xvm",
        _op: "push_update",
        _params: {
          _app_id: app_id,
          _env: env,
          _generation_id: generation_id,
          _view: view_to_persist,
        },
      } as any);
      const persisted_version =
        extract_persisted_version(persist_response);
      push_structured_view_edit_active_view_refresh({
        app_id,
        env,
        view_id,
        source_view_id,
        current_view,
        ...(typeof persisted_version === "number" ? { version: persisted_version } : {}),
        generation_id,
        target_id,
        edit_action: deterministic_result._mutation._action,
      });
      const mutation_target_id =
        deterministic_result._mutation._target_id ?? target_id;
      const mutation = deterministic_result._mutation;
      const persisted_view_id = source_view_id;

      _xlog.log("[xvibe] structured view edit persisted source view", {
        _app_id: app_id,
        _env: env,
        _view_id: view_id,
        _source_view_id: source_view_id,
        _persisted_view_id: persisted_view_id,
        _target_id: mutation_target_id,
        _edit_action: mutation._action,
        ...(persisted_version !== undefined
          ? { _persisted_version: persisted_version }
          : {}),
      });

      if (mutation._action === "add-child") {
        _xlog.log("[xvibe] structured add child", {
          _app_id: app_id,
          _env: env,
          _view_id: view_id,
          _source_view_id: source_view_id,
          _persisted_view_id: persisted_view_id,
          _target_id: mutation_target_id,
          _child_type: mutation._child_type,
          _child_id: mutation._child_id,
        });
      }

      const result_details: XVibeJsonObject = {
        _ok: true,
        _artifact_type: "view",
        _artifact_id: persisted_view_id,
        _view_id: view_id,
        _source_view_id: source_view_id,
        _persisted_view_id: persisted_view_id,
        _deterministic: true,
        _edit_action: mutation._action,
        _mutation_action: mutation._action,
        _target_id: mutation_target_id,
        ...(typeof mutation._previous_index === "number"
          ? { _previous_index: mutation._previous_index }
          : {}),
        ...(typeof mutation._next_index === "number"
          ? { _next_index: mutation._next_index }
          : {}),
        ...(typeof mutation._insert_index === "number"
          ? { _insert_index: mutation._insert_index }
          : {}),
        ...(typeof mutation._original_target_id === "string"
          ? { _original_target_id: mutation._original_target_id }
          : {}),
        ...(typeof mutation._new_target_id === "string"
          ? { _new_target_id: mutation._new_target_id }
          : {}),
        ...(typeof mutation._parent_id === "string"
          ? { _parent_id: mutation._parent_id }
          : {}),
        ...(typeof mutation._before_id === "string"
          ? { _before_id: mutation._before_id }
          : {}),
        ...(typeof mutation._after_id === "string"
          ? { _after_id: mutation._after_id }
          : {}),
        ...(typeof mutation._removed_type === "string"
          ? { _removed_type: mutation._removed_type }
          : {}),
        ...(typeof mutation._removed_text === "string"
          ? { _removed_text: mutation._removed_text }
          : {}),
        ...(typeof mutation._hide_mechanism === "string"
          ? { _hide_mechanism: mutation._hide_mechanism }
          : {}),
        ...(typeof mutation._show_mechanism === "string"
          ? { _show_mechanism: mutation._show_mechanism }
          : {}),
        _mutation: mutation,
        ...(persisted_version !== undefined
          ? { _persisted_version: persisted_version }
          : {}),
      };

      archive._result = {
        _artifact_type: "view",
        _artifact_id: persisted_view_id,
        _view_id: view_id,
        _source_view_id: source_view_id,
        _persisted_view_id: persisted_view_id,
        _success: true,
        _deterministic: true,
        _edit_action: mutation._action,
        _mutation_action: mutation._action,
        _mutation_target_id: mutation_target_id,
        ...(typeof mutation._previous_index === "number"
          ? { _previous_index: mutation._previous_index }
          : {}),
        ...(typeof mutation._next_index === "number"
          ? { _next_index: mutation._next_index }
          : {}),
        ...(typeof mutation._insert_index === "number"
          ? { _insert_index: mutation._insert_index }
          : {}),
        ...(typeof mutation._original_target_id === "string"
          ? { _original_target_id: mutation._original_target_id }
          : {}),
        ...(typeof mutation._new_target_id === "string"
          ? { _new_target_id: mutation._new_target_id }
          : {}),
        ...(typeof mutation._parent_id === "string"
          ? { _parent_id: mutation._parent_id }
          : {}),
        ...(typeof mutation._before_id === "string"
          ? { _before_id: mutation._before_id }
          : {}),
        ...(typeof mutation._after_id === "string"
          ? { _after_id: mutation._after_id }
          : {}),
        ...(typeof mutation._removed_type === "string"
          ? { _removed_type: mutation._removed_type }
          : {}),
        ...(typeof mutation._removed_text === "string"
          ? { _removed_text: mutation._removed_text }
          : {}),
        ...(typeof mutation._hide_mechanism === "string"
          ? { _hide_mechanism: mutation._hide_mechanism }
          : {}),
        ...(typeof mutation._show_mechanism === "string"
          ? { _show_mechanism: mutation._show_mechanism }
          : {}),
        ...(persisted_version !== undefined
          ? { _persisted_version: persisted_version }
          : {}),
      };

      _xem.fire("vibe:view-updated", {
        _app_id: app_id,
        _env: env,
        _view_id: persisted_view_id,
        _source_view_id: source_view_id,
        _requested_view_id: view_id,
      });

      _xlog.log("[xvibe] structured view edit applied", {
        _app_id: app_id,
        _env: env,
        _view_id: view_id,
        _source_view_id: source_view_id,
        _persisted_view_id: persisted_view_id,
        _action: deterministic_result._mutation._action,
        _target_id: mutation_target_id,
      });

      return {
        ...result_details,
        _result: result_details,
      };
    } catch (error) {
      const structured = deps._structured_error_payload(error);
      if (structured) {
        _xlog.error("[xvibe] apply_view_edit failed", error);
        return structured;
      }

      const message = error instanceof Error ? error.message : String(error);
      _xlog.error("[xvibe] apply_view_edit failed", error);
      if (archive) {
        archive._result = {
          _artifact_type: "view",
          ...(archive._view_id ? { _artifact_id: archive._view_id, _view_id: archive._view_id } : {}),
          _success: false,
          _deterministic: true,
          _error: {
            _code: "E_XVIBE_APPLY_VIEW_EDIT",
            _message: message,
          },
        };
      }
      return explicit_error("E_XVIBE_APPLY_VIEW_EDIT", message);
    } finally {
      if (archive) {
        archive._duration_ms = Date.now() - archive_started_at;
        deps._archive_vibe_run(archive);
      }
    }
  }
}
