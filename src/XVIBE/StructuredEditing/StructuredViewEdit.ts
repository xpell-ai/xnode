import { _x, _xlog, type XCommand } from "@xpell/core";
import { _xem } from "@xpell/node-core";
import { _xu } from "@xpell/node-core";
import { wsBroadcastScoped } from "../../Wormholes/wh.index.js";
import { record_project_memory_achievement } from "../../XVM/ProjectMemoryAchievements.js";
import type { XVibeJsonObject } from "../VibeOutputParser.js";
import type { XVibeResolvedTask } from "../XVibeTypes.js";
import { resolveProjectViewId } from "./ProjectViewResolution.js";

const DEFAULT_ENV = "default";

const STRUCTURED_MULTI_STYLE_ACTION_ALIASES = new Set([
  "set-style",
  "set-styles",
  "update-style",
  "update-styles",
  "update-properties",
  "set-properties",
]);

const STRUCTURED_GENERIC_PROPERTIES_ACTION_ALIASES = new Set([
  "update-properties",
  "set-properties",
]);

const STRUCTURED_VIEW_EDIT_ACTION_ALIASES: Record<string, string> = {
  hide: "hide-object",
  "hide-object": "hide-object",
  show: "show-object",
  "show-object": "show-object",
  remove: "remove-object",
  "remove-object": "remove-object",
  delete: "remove-object",
  "delete-object": "remove-object",
  duplicate: "duplicate-object",
  "duplicate-object": "duplicate-object",
  copy: "duplicate-object",
  "copy-object": "duplicate-object",
  move: "move-object",
  "move-object": "move-object",
  addclass: "add-class",
  "add-class": "add-class",
  removeclass: "remove-class",
  "remove-class": "remove-class",
  replaceclass: "replace-class",
  "replace-class": "replace-class",
  toggleclass: "toggle-class",
  "toggle-class": "toggle-class",
  setstyle: "set-style",
  "set-style": "set-style",
  setstyles: "set-styles",
  "set-styles": "set-styles",
  updatestyle: "set-styles",
  "update-style": "set-styles",
  updatestyles: "set-styles",
  "update-styles": "set-styles",
  setproperty: "set-property",
  "set-property": "set-property",
  updateproperty: "update-property",
  "update-property": "update-property",
  removeproperty: "remove-property",
  "remove-property": "remove-property",
  setproperties: "set-properties",
  "set-properties": "set-properties",
  updateproperties: "update-properties",
  "update-properties": "update-properties",
  addchild: "add-child",
  "add-child": "add-child",
  addsection: "add-child",
  "add-section": "add-child",
  addviewsection: "add-child",
  "add-view-section": "add-child",
  addcomponent: "add-child",
  "add-component": "add-child",
  addobject: "add-child",
  "add-object": "add-child",
  addui: "add-child",
  "add-ui": "add-child",
  addtoolbar: "create-toolbar",
  "add-toolbar": "create-toolbar",
  addtoptoolbar: "create-toolbar",
  "add-top-toolbar": "create-toolbar",
  createtoolbar: "create-toolbar",
  "create-toolbar": "create-toolbar",
  createtoptoolbar: "create-toolbar",
  "create-top-toolbar": "create-toolbar",
  inserttoolbar: "create-toolbar",
  "insert-toolbar": "create-toolbar",
  inserttoptoolbar: "create-toolbar",
  "insert-top-toolbar": "create-toolbar",
  setinteraction: "set-interaction",
  "set-interaction": "set-interaction",
  bindflow: "bind-flow",
  "bind-flow": "bind-flow",
  connectflow: "bind-flow",
  "connect-flow": "bind-flow",
  replaceobject: "replace-object",
  "replace-object": "replace-object",
};

export type StructuredViewEditAction =
  | "set-property"
  | "update-property"
  | "remove-property"
  | "set-style"
  | "set-styles"
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
  | "add-child"
  | "create-toolbar"
  | "set-interaction"
  | "bind-flow";

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
    | "set-styles"
    | "remove-style"
    | "set-style-class-rule"
    | "remove-style-class-rule"
    | "set-property"
    | "update-property"
    | "remove-property"
    | "move-object"
    | "replace-object"
    | "duplicate-object"
    | "add-child"
    | "create-toolbar"
    | "set-interaction"
    | "bind-flow";
  _target_id?: string;
  _field?: string;
  _target_text?: string;
  _replacement_text?: string;
  _class_name?: string;
  _old_class_name?: string;
  _new_class_name?: string;
  _style_property?: string;
  _style_value?: string;
  _styles?: XVibeJsonObject;
  _property_name?: string;
  _property_value?: unknown;
  _interaction_scope?: "_on" | "_once";
  _trigger?: string;
  _handler?: Record<string, any> | null;
  _flow?: { _id: string; _payload?: XVibeJsonObject };
  _flow_event?: string;
  _flow_auto?: boolean;
  _object_value?: XVibeJsonObject;
  _move_position?: "before" | "after" | "top" | "bottom";
  _position?: "append" | "prepend" | "before" | "after";
  _anchor_id?: string;
  _anchor_text?: string;
  _anchor_type?: string;
  _destination_id?: string;
  _destination_text?: string;
  _destination_type?: string;
  _target_type?: string;
  _child?: XVibeJsonObject;
  _location?: string;
  _component_type?: string;
  _props?: XVibeJsonObject;
  _toolbar_props?: XVibeJsonObject;
  _warnings?: string[];
};

export type SemanticViewEditCanonicalizationRejectionReason =
  | "invalid_edit_action"
  | "unsupported_edit_action"
  | "unsupported_property_batch"
  | "ambiguous_edit_action";

export type SemanticViewEditCanonicalizationResult =
  | {
    _ok: true;
    _params: Record<string, unknown>;
    _normalized_fields: string[];
  }
  | {
    _ok: false;
    _reason: SemanticViewEditCanonicalizationRejectionReason;
    _params: Record<string, unknown>;
    _normalized_fields: string[];
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
    | "set-styles"
    | "remove-style"
    | "set-style-class-rule"
    | "remove-style-class-rule"
    | "set-property"
    | "update-property"
    | "remove-property"
    | "move-object"
    | "replace-object"
    | "duplicate-object"
    | "add-child"
    | "create-toolbar"
    | "set-interaction"
    | "bind-flow";
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
  _list_project_view_ids: (input: {
    _app_id: string;
    _env: string;
  }) => Promise<string[]>;
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

function extract_project_memory(value: unknown): XVibeJsonObject | undefined {
  if (!_xu.is_plain_object(value)) return undefined;

  if (_xu.is_plain_object(value._memory)) {
    return value._memory;
  }

  if (_xu.is_plain_object(value._result)) {
    return extract_project_memory(value._result);
  }

  return undefined;
}

function trimmed_project_memory_string(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function project_memory_section_title(input: {
  params: XVibeJsonObject;
  child: XVibeJsonObject;
}): string | undefined {
  const param_title =
    trimmed_project_memory_string(input.params._section_name) ??
    trimmed_project_memory_string(input.params.section_name) ??
    trimmed_project_memory_string(input.params._section_title) ??
    trimmed_project_memory_string(input.params.section_title);
  if (param_title) return param_title;

  const child_title =
    trimmed_project_memory_string(input.child._title) ??
    trimmed_project_memory_string(input.child._label) ??
    trimmed_project_memory_string(input.child._text);
  if (child_title) return child_title;

  const child_nodes =
    Array.isArray(input.child._children) ? input.child._children : [];
  for (const node of child_nodes) {
    if (!_xu.is_plain_object(node)) continue;
    if (trimmed_project_memory_string(node._type) !== "label") continue;

    const label_title =
      trimmed_project_memory_string(node._title) ??
      trimmed_project_memory_string(node._label) ??
      trimmed_project_memory_string(node._text);
    if (label_title) return label_title;
  }

  return undefined;
}

function normalize_project_memory_section_title(title: string): string {
  return /\bsection$/iu.test(title)
    ? title
    : `${title} section`;
}

function build_project_memory_completed_item(input: {
  params: XVibeJsonObject;
  mutation: StructuredViewEditMutation;
}): XVibeJsonObject | undefined {
  if (input.mutation._action !== "add-child") return undefined;

  const child =
    _xu.is_plain_object(input.params._child)
      ? input.params._child
      : undefined;
  const child_type =
    trimmed_project_memory_string(child?._type) ??
    trimmed_project_memory_string(input.mutation._child_type);
  if (child_type !== "xsection") return undefined;

  const item_id =
    trimmed_project_memory_string(child?._id) ??
    trimmed_project_memory_string(input.mutation._child_id);
  if (!item_id || !child) return undefined;

  const title =
    project_memory_section_title({
      params: input.params,
      child,
    });
  if (!title) return undefined;

  return {
    _id: item_id,
    _title: normalize_project_memory_section_title(title),
    _type: "view-section",
    _source: "suggested-action",
    _created_at: new Date().toISOString(),
  };
}

async function record_project_memory_completed_item(input: {
  app_id: string;
  env: string;
  view_id: string;
  item: XVibeJsonObject;
}): Promise<void> {
  const item_id = trimmed_project_memory_string(input.item._id);
  if (!item_id) {
    _xlog.log("[xvibe] project memory completed item skipped", {
      _app_id: input.app_id,
      _env: input.env,
      _view_id: input.view_id,
      _reason: "missing_completed_item_id",
    });
    return;
  }

  try {
    const memory_response = await _x.execute({
      _module: "server-xvm",
      _op: "get-project-memory",
      _params: {
        _app_id: input.app_id,
        _env: input.env,
      },
    } as any);

    if (_xu.is_plain_object(memory_response) && memory_response._ok === false) {
      _xlog.log("[xvibe] project memory completed item skipped", {
        _app_id: input.app_id,
        _env: input.env,
        _view_id: input.view_id,
        _completed_item_id: item_id,
        _reason: "memory_load_failed",
      });
      return;
    }

    const memory = extract_project_memory(memory_response);
    if (!memory) {
      _xlog.log("[xvibe] project memory completed item skipped", {
        _app_id: input.app_id,
        _env: input.env,
        _view_id: input.view_id,
        _completed_item_id: item_id,
        _reason: "memory_missing",
      });
      return;
    }

    const completed =
      Array.isArray(memory._completed) ? memory._completed : [];
    const already_completed =
      completed.some((item) =>
        _xu.is_plain_object(item) &&
        trimmed_project_memory_string(item._id) === item_id
      );

    if (already_completed) {
      _xlog.log("[xvibe] project memory completed item skipped", {
        _app_id: input.app_id,
        _env: input.env,
        _view_id: input.view_id,
        _completed_item_id: item_id,
        _reason: "duplicate",
      });
      return;
    }

    const patch_response = await _x.execute({
      _module: "server-xvm",
      _op: "patch-project-memory",
      _params: {
        _app_id: input.app_id,
        _env: input.env,
        _patch: {
          _completed: [
            ...completed,
            input.item,
          ],
        },
      },
    } as any);

    if (_xu.is_plain_object(patch_response) && patch_response._ok === false) {
      _xlog.log("[xvibe] project memory completed item skipped", {
        _app_id: input.app_id,
        _env: input.env,
        _view_id: input.view_id,
        _completed_item_id: item_id,
        _reason: "memory_patch_failed",
      });
      return;
    }

    _xlog.log("[xvibe] project memory completed item recorded", {
      _app_id: input.app_id,
      _env: input.env,
      _view_id: input.view_id,
      _completed_item_id: item_id,
    });
  } catch (error) {
    _xlog.log("[xvibe] project memory completed item skipped", {
      _app_id: input.app_id,
      _env: input.env,
      _view_id: input.view_id,
      _completed_item_id: item_id,
      _reason: "memory_update_failed",
      _error: error_summary(error),
    });
  }
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

async function structured_flow_exists(input: {
  app_id: string;
  env: string;
  flow_id: string;
}): Promise<boolean> {
  try {
    const response = await _x.execute({
      _module: "server-xvm",
      _op: "get_flow",
      _params: {
        _app_id: input.app_id,
        _env: input.env,
        _flow_id: input.flow_id,
      },
    } as any);
    return _xu.is_plain_object(response) && response._ok === true;
  } catch {
    return false;
  }
}

function read_structured_view_edit_action(value: unknown): StructuredViewEditAction {
  if (
    value === "set-property" ||
    value === "update-property" ||
    value === "remove-property" ||
    value === "set-style" ||
    value === "set-styles" ||
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
    value === "add-child" ||
    value === "create-toolbar" ||
    value === "set-interaction" ||
    value === "bind-flow"
  ) {
    return value;
  }

  throw new Error("Invalid '_edit_action': unsupported deterministic view edit action");
}

export function readStructuredViewEditAction(value: unknown): StructuredViewEditAction {
  return read_structured_view_edit_action(value);
}

export function isStructuredViewEditAction(value: unknown): value is StructuredViewEditAction {
  try {
    read_structured_view_edit_action(value);
    return true;
  } catch {
    return false;
  }
}

function structured_target_type_is_view(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const normalized =
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "");
  return (
    normalized === "view" ||
    normalized === "xview" ||
    normalized === "rootview" ||
    normalized === "currentview"
  );
}

function read_structured_target_id(input: {
  params: XVibeJsonObject;
  view_id: string;
  target_type?: string;
}): string {
  const target_id =
    read_optional_string(input.params._target_id, "_target_id");
  if (target_id) return target_id;
  if (structured_target_type_is_view(input.target_type)) return input.view_id;
  return read_required_string(input.params._target_id, "_target_id");
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

function read_structured_styles_value(value: unknown): XVibeJsonObject {
  if (!_xu.is_plain_object(value)) {
    throw new Error("Invalid '_styles': expected object");
  }

  if (Object.keys(value).length === 0) {
    throw new Error("Invalid '_styles': expected at least one style property");
  }

  return value;
}

function read_structured_flow_value(value: unknown): { _id: string; _payload?: XVibeJsonObject } {
  if (typeof value === "string" && value.trim()) {
    return { _id: value.trim(), _payload: {} };
  }

  if (!_xu.is_plain_object(value)) {
    throw new Error("Invalid '_flow': expected string flow id or object");
  }

  const flow_id =
    read_required_string(value._id, "_flow._id");
  const payload =
    value._payload === undefined
      ? {}
      : value._payload;
  if (!_xu.is_plain_object(payload)) {
    throw new Error("Invalid '_flow._payload': expected object");
  }

  return {
    _id: flow_id,
    _payload: payload,
  };
}

function read_structured_flow_event(value: unknown): string {
  if (value === undefined || value === null) return "click";
  return read_required_string(value, "_flow_event");
}

function read_structured_flow_auto(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "boolean") {
    throw new Error("Invalid '_flow_auto': expected boolean");
  }
  return value;
}

function structured_style_action_key(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase()
    .replace(/[\s_]+/gu, "-")
    .replace(/[^a-z0-9-]+/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function structured_read_string(
  source: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function structured_normalize_view_edit_action(value: unknown): string | undefined {
  const key = structured_style_action_key(value);
  if (!key) return undefined;
  return STRUCTURED_VIEW_EDIT_ACTION_ALIASES[key] ?? key;
}

function structured_normalize_style_property_name(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .replace(/[\s_]+/gu, "-")
    .toLowerCase();
}

function structured_normalize_style_properties(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [property_name, property_value] of Object.entries(value)) {
    normalized[structured_normalize_style_property_name(property_name)] =
      property_value;
  }
  return normalized;
}

function structured_read_style_entry_property(entry: Record<string, unknown>): string | undefined {
  return structured_read_string(entry, [
    "property",
    "_property",
    "name",
    "_name",
    "key",
    "_key",
  ]);
}

function structured_normalize_style_collection(value: unknown):
  | { _ok: true; _styles: Record<string, unknown> }
  | { _ok: false } {
  if (_xu.is_plain_object(value)) {
    const entries =
      Object.entries(value);
    if (entries.length === 0) return { _ok: false };

    const styles: Record<string, unknown> = {};
    for (const [property_name, property_value] of entries) {
      const normalized_property =
        structured_normalize_style_property_name(property_name);
      if (!normalized_property) return { _ok: false };
      styles[normalized_property] = property_value;
    }
    return { _ok: true, _styles: styles };
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return { _ok: false };

    const styles: Record<string, unknown> = {};
    for (const entry of value) {
      if (!_xu.is_plain_object(entry)) return { _ok: false };

      const property_name =
        structured_read_style_entry_property(entry);
      if (!property_name) return { _ok: false };
      if (!Object.prototype.hasOwnProperty.call(entry, "value")) {
        return { _ok: false };
      }

      const normalized_property =
        structured_normalize_style_property_name(property_name);
      if (!normalized_property) return { _ok: false };
      styles[normalized_property] = entry.value;
    }

    return Object.keys(styles).length > 0
      ? { _ok: true, _styles: styles }
      : { _ok: false };
  }

  return { _ok: false };
}

function structured_nested_edit_action_payload(input: {
  params: Record<string, unknown>;
  edit_action: Record<string, unknown>;
  normalized_fields: string[];
}): void {
  const properties =
    _xu.is_plain_object(input.edit_action.properties)
      ? input.edit_action.properties
      : _xu.is_plain_object(input.edit_action._properties)
        ? input.edit_action._properties
        : undefined;
  if (properties && input.params._properties !== properties) {
    input.params._properties = properties;
    input.normalized_fields.push("_properties");
  }

  const styles =
    _xu.is_plain_object(input.edit_action.styles)
      ? input.edit_action.styles
      : _xu.is_plain_object(input.edit_action._styles)
        ? input.edit_action._styles
        : undefined;
  if (styles && input.params._styles !== styles) {
    input.params._styles = styles;
    input.normalized_fields.push("_styles");
  }
}

function structured_properties_payload(
  params: Record<string, unknown>,
): { _field: "_properties" | "properties"; _properties: Record<string, unknown> } | undefined {
  if (_xu.is_plain_object(params._properties)) {
    return {
      _field: "_properties",
      _properties: params._properties as Record<string, unknown>,
    };
  }
  if (_xu.is_plain_object(params.properties)) {
    return {
      _field: "properties",
      _properties: params.properties as Record<string, unknown>,
    };
  }
  return undefined;
}

function structured_properties_style_payload(
  properties: Record<string, unknown>,
): unknown {
  for (const field of ["styles", "_styles", "style", "_style"]) {
    if (Object.prototype.hasOwnProperty.call(properties, field)) {
      return properties[field];
    }
  }
  return undefined;
}

function structured_canonical_multi_style_payload(input: {
  params: Record<string, unknown>;
  include_properties_object?: boolean;
}):
  | { _ok: true; _styles: Record<string, unknown>; _source: string }
  | { _ok: false; _source: string }
  | undefined {
  const candidates: Array<{ _source: string; _value: unknown }> = [];
  for (const field of ["_styles", "styles", "_style_properties", "styleProperties"]) {
    if (Object.prototype.hasOwnProperty.call(input.params, field)) {
      candidates.push({
        _source: field,
        _value: input.params[field],
      });
    }
  }

  const properties =
    structured_properties_payload(input.params);
  if (properties) {
    const style_value =
      structured_properties_style_payload(properties._properties);
    if (style_value !== undefined) {
      candidates.push({
        _source: `${properties._field}.styles`,
        _value: style_value,
      });
    } else if (input.include_properties_object === true) {
      candidates.push({
        _source: properties._field,
        _value: properties._properties,
      });
    }
  }

  for (const candidate of candidates) {
    const normalized =
      structured_normalize_style_collection(candidate._value);
    if (normalized._ok) {
      return {
        _ok: true,
        _source: candidate._source,
        _styles: normalized._styles,
      };
    }
    return {
      _ok: false,
      _source: candidate._source,
    };
  }

  return undefined;
}

function structured_delete_payload_wrappers(
  params: Record<string, unknown>,
  normalized_fields: string[],
): void {
  for (const field of ["_style_properties", "styleProperties", "_properties", "properties", "styles"]) {
    if (Object.prototype.hasOwnProperty.call(params, field)) {
      delete params[field];
      normalized_fields.push(field);
    }
  }
}

function structured_action_contains_style(value: unknown): boolean {
  const action_key =
    structured_style_action_key(value);
  return action_key
    ? action_key.split("-").some((part) => part === "style" || part === "styles")
    : false;
}

function structured_reject_canonical_view_edit(input: {
  params: Record<string, unknown>;
  normalized_fields: string[];
  reason: SemanticViewEditCanonicalizationRejectionReason;
}): SemanticViewEditCanonicalizationResult {
  if (input.params._semantic_non_executable_reason !== input.reason) {
    input.params._semantic_non_executable_reason = input.reason;
    input.normalized_fields.push("_semantic_non_executable_reason");
  }
  return {
    _ok: false,
    _reason: input.reason,
    _params: input.params,
    _normalized_fields: [...new Set(input.normalized_fields)],
  };
}

export function canonicalizeSemanticViewEditParams(
  params: Record<string, unknown>,
): SemanticViewEditCanonicalizationResult {
  const canonical_params = { ...params };
  const normalized_fields: string[] = [];
  const nested_edit_action =
    _xu.is_plain_object(canonical_params._edit_action)
      ? canonical_params._edit_action as Record<string, unknown>
      : undefined;

  if (nested_edit_action) {
    const nested_action =
      structured_read_string(nested_edit_action, [
        "action",
        "_action",
        "type",
        "_type",
      ]);
    if (!nested_action) {
      return structured_reject_canonical_view_edit({
        params: canonical_params,
        normalized_fields,
        reason: "invalid_edit_action",
      });
    }

    canonical_params._edit_action = nested_action;
    normalized_fields.push("_edit_action");
    structured_nested_edit_action_payload({
      params: canonical_params,
      edit_action: nested_edit_action,
      normalized_fields,
    });
  } else if (
    canonical_params._edit_action !== undefined &&
    typeof canonical_params._edit_action !== "string"
  ) {
    return structured_reject_canonical_view_edit({
      params: canonical_params,
      normalized_fields,
      reason: "invalid_edit_action",
    });
  }

  const normalized_action =
    structured_normalize_view_edit_action(canonical_params._edit_action);
  if (!normalized_action) {
    return {
      _ok: true,
      _params: canonical_params,
      _normalized_fields: [...new Set(normalized_fields)],
    };
  }
  if (canonical_params._edit_action !== normalized_action) {
    canonical_params._edit_action = normalized_action;
    normalized_fields.push("_edit_action");
  }

  if (STRUCTURED_GENERIC_PROPERTIES_ACTION_ALIASES.has(normalized_action)) {
    const properties =
      structured_properties_payload(canonical_params);
    const style_payload =
      structured_canonical_multi_style_payload({
        params: canonical_params,
      });
    if (style_payload?._ok) {
      canonical_params._edit_action = "set-styles";
      canonical_params._styles = style_payload._styles;
      normalized_fields.push("_edit_action", "_styles");
      structured_delete_payload_wrappers(canonical_params, normalized_fields);
    } else if (style_payload && !style_payload._ok) {
      return structured_reject_canonical_view_edit({
        params: canonical_params,
        normalized_fields,
        reason: "ambiguous_edit_action",
      });
    } else if (properties) {
      const entries =
        Object.entries(properties._properties);
      if (entries.length === 1) {
        const [property_name, property_value] = entries[0];
        canonical_params._edit_action = "update-property";
        canonical_params._property_name = property_name;
        canonical_params._property_value = property_value;
        normalized_fields.push("_edit_action", "_property_name", "_property_value");
        structured_delete_payload_wrappers(canonical_params, normalized_fields);
      } else {
        return structured_reject_canonical_view_edit({
          params: canonical_params,
          normalized_fields,
          reason: "unsupported_property_batch",
        });
      }
    } else {
      return structured_reject_canonical_view_edit({
        params: canonical_params,
        normalized_fields,
        reason: "unsupported_property_batch",
      });
    }
  }

  const final_action =
    typeof canonical_params._edit_action === "string"
      ? canonical_params._edit_action
      : undefined;
  const multi_style_payload =
    final_action === "set-style" ||
      final_action === "set-styles" ||
      (
        final_action !== undefined &&
        structured_action_contains_style(final_action)
      )
      ? structured_canonical_multi_style_payload({
        params: canonical_params,
        include_properties_object: true,
      })
      : undefined;
  if (multi_style_payload?._ok) {
    canonical_params._edit_action = "set-styles";
    canonical_params._styles = multi_style_payload._styles;
    normalized_fields.push("_edit_action", "_styles");
    structured_delete_payload_wrappers(canonical_params, normalized_fields);
  } else if (
    multi_style_payload &&
    !multi_style_payload._ok &&
    final_action &&
    structured_action_contains_style(final_action)
  ) {
    return structured_reject_canonical_view_edit({
      params: canonical_params,
      normalized_fields,
      reason: "ambiguous_edit_action",
    });
  }

  if (
    canonical_params._edit_action === "set-style" &&
    typeof canonical_params._style_property === "string"
  ) {
    const normalized_property =
      structured_normalize_style_property_name(canonical_params._style_property);
    if (
      normalized_property &&
      canonical_params._style_property !== normalized_property
    ) {
      canonical_params._style_property = normalized_property;
      normalized_fields.push("_style_property");
    }
  }

  if (canonical_params._edit_action !== undefined) {
    try {
      read_structured_view_edit_action(canonical_params._edit_action);
    } catch {
      return structured_reject_canonical_view_edit({
        params: canonical_params,
        normalized_fields,
        reason: "unsupported_edit_action",
      });
    }
  }

  return {
    _ok: true,
    _params: canonical_params,
    _normalized_fields: [...new Set(normalized_fields)],
  };
}

function structured_multi_style_payload(
  params: XVibeJsonObject,
  action_key: string,
): XVibeJsonObject | undefined {
  if (STRUCTURED_GENERIC_PROPERTIES_ACTION_ALIASES.has(action_key)) {
    const properties =
      _xu.is_plain_object(params._properties)
        ? params._properties
        : _xu.is_plain_object(params.properties)
          ? params.properties
          : undefined;
    if (!properties) return undefined;

    const styles =
      properties.styles ??
      properties._styles ??
      properties.style ??
      properties._style;
    return _xu.is_plain_object(styles) && Object.keys(styles).length > 0
      ? styles
      : undefined;
  }

  const candidates = [
    params._style_properties,
    params._styles,
    params._properties,
    params.properties,
    params.styles,
  ];

  for (const value of candidates) {
    if (_xu.is_plain_object(value) && Object.keys(value).length > 0) {
      return value;
    }
  }

  return undefined;
}

function canonicalize_structured_view_edit_style_params(
  params: XVibeJsonObject,
): XVibeJsonObject {
  const action_key =
    structured_style_action_key(params._edit_action);
  if (
    !action_key ||
    !STRUCTURED_MULTI_STYLE_ACTION_ALIASES.has(action_key)
  ) {
    return params;
  }

  const styles =
    structured_multi_style_payload(params, action_key);
  if (!styles) {
    return params;
  }

  const canonical_params: XVibeJsonObject = {
    ...params,
    _edit_action: "set-styles",
    _styles: styles,
  };
  delete canonical_params._style_properties;
  delete canonical_params._properties;
  delete canonical_params.properties;
  delete canonical_params.styles;
  return canonical_params;
}

function read_structured_interaction_scope(value: unknown): "_on" | "_once" {
  if (value === undefined || value === null) {
    return "_on";
  }

  if (value === "_on" || value === "_once") {
    return value;
  }

  throw new Error("Invalid '_interaction_scope': expected '_on' or '_once'");
}

function read_structured_interaction_trigger(value: unknown): string {
  const trigger =
    read_required_string(value, "_trigger");

  if (trigger !== "click") {
    throw new Error("Invalid '_trigger': unsupported interaction trigger");
  }

  return trigger;
}

function read_structured_interaction_handler(value: unknown): Record<string, any> | null {
  if (value === null) {
    return null;
  }

  if (!_xu.is_plain_object(value)) {
    throw new Error("Invalid '_handler': expected object or null");
  }

  if (typeof value._module !== "string" || value._module.trim().length === 0) {
    throw new Error("Invalid '_handler._module': expected non-empty string");
  }

  if (typeof value._op !== "string" || value._op.trim().length === 0) {
    throw new Error("Invalid '_handler._op': expected non-empty string");
  }

  if (
    Object.prototype.hasOwnProperty.call(value, "_params") &&
    value._params !== undefined &&
    !_xu.is_plain_object(value._params)
  ) {
    throw new Error("Invalid '_handler._params': expected object");
  }

  return value;
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

function read_structured_component_type(value: unknown): string | undefined {
  const component_type =
    read_optional_string(value, "_component_type");
  if (!component_type) return undefined;

  return component_type;
}

function read_structured_location(value: unknown): string | undefined {
  const location =
    read_optional_string(value, "_location");
  if (!location) return undefined;

  return location;
}

function read_structured_move_position(value: unknown): "append" | "prepend" | "before" | "after" {
  const position =
    read_required_string(value, "_position");
  if (
    position === "append" ||
    position === "prepend" ||
    position === "before" ||
    position === "after"
  ) {
    return position;
  }

  throw new Error("Invalid '_position': expected append, prepend, before, or after");
}

function structured_location_label(value: unknown): "Header" | "Footer" {
  if (typeof value !== "string") return "Footer";
  const normalized = value.trim().toLowerCase().replace(/\s+/gu, " ");
  return (
    normalized === "header" ||
    normalized === "top" ||
    normalized === "toolbar"
  )
    ? "Header"
    : "Footer";
}

function structured_child_text(params: XVibeJsonObject, label: "Header" | "Footer"): string {
  if (_xu.is_plain_object(params._props)) {
    const text =
      read_optional_string(params._props._text, "_props._text");
    if (text) return text;
  }

  return `New ${label} Label`;
}

function structured_child_class(params: XVibeJsonObject, label: "Header" | "Footer"): string {
  if (_xu.is_plain_object(params._props)) {
    const class_name =
      read_optional_string(params._props.class, "_props.class");
    if (class_name) return class_name;
  }

  const class_location = label.toLowerCase();
  return `xvibe-generated-label xvibe-${class_location}-label`;
}

function read_or_synthesize_structured_child(params: XVibeJsonObject): XVibeJsonObject {
  if (_xu.is_plain_object(params._child)) {
    return read_structured_child_value(params._child);
  }

  const component_type =
    read_structured_component_type(params._component_type) ?? "label";
  if (component_type !== "label") {
    throw new Error("Invalid '_child': expected object");
  }

  const location = read_structured_location(params._location);
  const label = structured_location_label(location);
  return {
    _type: "label",
    _text: structured_child_text(params, label),
    class: structured_child_class(params, label),
  };
}

function read_structured_toolbar_props(value: unknown): XVibeJsonObject {
  if (value === undefined || value === null) return {};
  if (!_xu.is_plain_object(value)) {
    throw new Error("Invalid '_toolbar_props': expected object");
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
  const target_text =
    read_optional_string(input.params._target_text, "_target_text");
  const deterministic_action =
    input.action === "remove-object"
      ? "remove"
      : input.action === "hide-object"
        ? "hide"
        : input.action === "show-object"
          ? "show"
          : input.action === "update-property"
            ? "set-property"
            : input.action;
  const resolved_task: XVibeResolvedTask = {
    _action: "update",
    _artifact_type: "view",
    _target_id: input.view_id,
    _edit_action: deterministic_action,
    _edit_target_id: input.target_id,
    ...(target_text ? { _edit_target_text: target_text } : {}),
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
    ...(target_text ? { _target_text: target_text } : {}),
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
      read_or_synthesize_structured_child(input.params);
    resolved_task._edit_child_value = child_value;
    const location = read_structured_location(input.params._location);
    const component_type = read_structured_component_type(input.params._component_type);
    if (location) {
      (resolved_task as XVibeJsonObject)._edit_location = location;
      edit_intent._location = location;
    }
    if (component_type) {
      (resolved_task as XVibeJsonObject)._edit_component_type = component_type;
      edit_intent._component_type = component_type;
    }
    if (_xu.is_plain_object(input.params._props)) {
      edit_intent._props = input.params._props;
    }
    edit_intent._child = child_value;
    return { resolved_task, edit_intent };
  }

  if (input.action === "create-toolbar") {
    const location =
      read_structured_location(input.params._location) ?? "top";
    const toolbar_props =
      read_structured_toolbar_props(input.params._toolbar_props);
    (resolved_task as XVibeJsonObject)._edit_location = location;
    (resolved_task as XVibeJsonObject)._edit_toolbar_props = toolbar_props;
    edit_intent._location = location;
    edit_intent._toolbar_props = toolbar_props;
    if (location === "before" || location === "after") {
      resolved_task._edit_move_position = location;
      resolved_task._edit_anchor_id = input.target_id;
      edit_intent._move_position = location;
      edit_intent._anchor_id = input.target_id;
    } else {
      resolved_task._edit_target_id = input.view_id;
      edit_intent._target_id = input.view_id;
      edit_intent._target_type = "view";
      resolved_task._edit_target_type = "view";
    }
    return { resolved_task, edit_intent };
  }

  if (input.action === "move-object") {
    if (!input.target_type) {
      throw new Error("Invalid '_target_type': expected non-empty string");
    }

    const structured_position =
      input.params._position === undefined
        ? undefined
        : read_structured_move_position(input.params._position);
    if (structured_position) {
      const destination_id =
        read_required_string(input.params._destination_id, "_destination_id");
      const destination_type =
        read_optional_string(input.params._destination_type, "_destination_type");
      const destination_text =
        read_optional_string(input.params._destination_text, "_destination_text");
      (resolved_task as XVibeJsonObject)._edit_position = structured_position;
      (resolved_task as XVibeJsonObject)._edit_destination_id = destination_id;
      if (destination_text) {
        (resolved_task as XVibeJsonObject)._edit_destination_text = destination_text;
      }
      if (destination_type) {
        (resolved_task as XVibeJsonObject)._edit_destination_type = destination_type;
      }
      edit_intent._position = structured_position;
      edit_intent._destination_id = destination_id;
      if (destination_text) {
        edit_intent._destination_text = destination_text;
      }
      if (destination_type) {
        edit_intent._destination_type = destination_type;
      }
      if (structured_position === "before" || structured_position === "after") {
        resolved_task._edit_move_position = structured_position;
        resolved_task._edit_anchor_id = destination_id;
        if (destination_type) {
          resolved_task._edit_anchor_type = destination_type;
        }
        edit_intent._move_position = structured_position;
        edit_intent._anchor_id = destination_id;
        if (destination_type) {
          edit_intent._anchor_type = destination_type;
        }
      } else {
        resolved_task._edit_move_position =
          structured_position === "prepend" ? "top" : "bottom";
        edit_intent._move_position = resolved_task._edit_move_position;
      }
      return { resolved_task, edit_intent };
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

  if (
    input.action === "set-property" ||
    input.action === "update-property" ||
    input.action === "remove-property"
  ) {
    const property_name =
      read_required_string(input.params._property_name, "_property_name");
    resolved_task._edit_property_name = property_name;
    edit_intent._property_name = property_name;

    if (input.action === "set-property" || input.action === "update-property") {
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

  if (input.action === "set-interaction") {
    const interaction_scope =
      read_structured_interaction_scope(input.params._interaction_scope);
    const trigger =
      read_structured_interaction_trigger(input.params._trigger);
    const handler =
      read_structured_interaction_handler(input.params._handler);

    resolved_task._edit_interaction_scope = interaction_scope;
    resolved_task._edit_trigger = trigger;
    resolved_task._edit_handler = handler;
    edit_intent._interaction_scope = interaction_scope;
    edit_intent._trigger = trigger;
    edit_intent._handler = handler;
    return { resolved_task, edit_intent };
  }

  if (input.action === "bind-flow") {
    const flow =
      read_structured_flow_value(input.params._flow);
    const flow_event =
      read_structured_flow_event(input.params._flow_event);
    const flow_auto =
      read_structured_flow_auto(input.params._flow_auto);

    resolved_task._edit_flow = flow;
    resolved_task._edit_flow_event = flow_event;
    resolved_task._edit_flow_auto = flow_auto;
    edit_intent._flow = flow;
    edit_intent._flow_event = flow_event;
    edit_intent._flow_auto = flow_auto;
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

  if (input.action === "set-styles") {
    const styles =
      read_structured_styles_value(input.params._styles ?? input.params._properties);
    resolved_task._edit_styles = styles;
    edit_intent._styles = styles;
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
      const params =
        canonicalize_structured_view_edit_style_params(
          _xu.is_plain_object(input._cmd?._params) ? input._cmd._params : {},
        );
      const app_id = read_required_string(params._app_id, "_app_id");
      const env = read_required_string(params._env ?? DEFAULT_ENV, "_env");
      const requested_view_id = read_required_string(params._view_id, "_view_id");
      const action = read_structured_view_edit_action(params._edit_action);
      const available_view_ids =
        await deps._list_project_view_ids({
          _app_id: app_id,
          _env: env,
        });
      const current_view_id =
        read_optional_string(
          params._current_view_id ?? params.current_view_id ?? params._active_view_id ?? params.active_view_id,
          "_current_view_id",
        );
      const view_resolution =
        resolveProjectViewId({
          app_id,
          env,
          requested_view_id,
          current_view_id,
          available_views: available_view_ids,
          target_id: read_optional_string(params._target_id, "_target_id"),
          target_text: read_optional_string(params._target_text, "_target_text"),
        });
      if (!view_resolution._ok) {
        return apply_view_edit_failure({
          code: "E_XVIBE_APPLY_VIEW_EDIT_VIEW_NOT_FOUND",
          message: `View not found: ${requested_view_id}`,
          app_id,
          env,
          view_id: requested_view_id,
          action,
          reason: "view_not_found",
          details: {
            _requested_view_id: requested_view_id,
          },
          archive,
        });
      }

      const view_id = view_resolution._view_id;
      if (params._view_id !== view_id) {
        _xlog.log("[xvibe] semantic view resolved", {
          _requested_view_id: requested_view_id,
          _resolved_view_id: view_id,
          _strategy: view_resolution._strategy,
        });
        params._view_id = view_id;
      }
      const target_type = read_optional_string(params._target_type, "_target_type");
      const target_id =
        action === "create-toolbar"
          ? read_optional_string(params._target_id, "_target_id") ?? view_id
          : action === "bind-flow"
            ? read_optional_string(params._target_id, "_target_id") ??
              read_optional_string(params._target_text, "_target_text") ??
              read_required_string(params._target_text, "_target_text")
          : read_structured_target_id({
            params,
            view_id,
            ...(target_type ? { target_type } : {}),
          });
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

      if (action === "bind-flow") {
        const flow_id =
          typeof task.resolved_task._edit_flow?._id === "string"
            ? task.resolved_task._edit_flow._id.trim()
            : "";
        if (!flow_id || !(await structured_flow_exists({ app_id, env, flow_id }))) {
          return apply_view_edit_failure({
            code: "E_XVIBE_FLOW_NOT_FOUND",
            message: flow_id ? `Flow not found: ${flow_id}` : "Flow not found",
            app_id,
            env,
            view_id,
            action,
            target_id,
            reason: "flow_not_found",
            details: {
              _flow_id: flow_id,
            },
            archive,
          });
        }
      }

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
      if (_xu.is_plain_object(persist_response) && persist_response._ok === false) {
        return apply_view_edit_failure({
          code: "E_XVIBE_APPLY_VIEW_EDIT_PERSIST_FAILED",
          message: "Deterministic view edit failed while saving view",
          app_id,
          env,
          view_id,
          action,
          target_id,
          reason: "persist_failed",
          details: persist_response._error ?? persist_response,
          archive,
        });
      }
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
      const mutation = deterministic_result._mutation;
      const mutation_target_id = mutation._target_id;
      const mutation_target_path =
        Array.isArray(mutation._target_path)
          ? mutation._target_path
          : undefined;
      const persisted_view_id = source_view_id;

      _xlog.log("[xvibe] structured view edit persisted source view", {
        _app_id: app_id,
        _env: env,
        _view_id: view_id,
        _source_view_id: source_view_id,
        _persisted_view_id: persisted_view_id,
        ...(mutation_target_id ? { _target_id: mutation_target_id } : {}),
        ...(mutation_target_path ? { _target_path: mutation_target_path } : {}),
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
          ...(mutation_target_id ? { _target_id: mutation_target_id } : {}),
          ...(mutation_target_path ? { _target_path: mutation_target_path } : {}),
          _child_type: mutation._child_type,
          _child_id: mutation._child_id,
        });
      }

      const completed_item =
        build_project_memory_completed_item({
          params,
          mutation,
        });
      if (completed_item) {
        await record_project_memory_completed_item({
          app_id,
          env,
          view_id,
          item: completed_item,
        });
      }

      await record_project_memory_achievement({
        _app_id: app_id,
        _env: env,
        _achievement_id: "first-suggested-action-applied",
      });

      if (mutation._action === "set-interaction") {
        _xlog.log("[xvibe] structured set interaction", {
          _app_id: app_id,
          _env: env,
          _view_id: view_id,
          _source_view_id: source_view_id,
          _persisted_view_id: persisted_view_id,
          ...(mutation_target_id ? { _target_id: mutation_target_id } : {}),
          ...(mutation_target_path ? { _target_path: mutation_target_path } : {}),
          ...(target_type ? { _target_type: target_type } : {}),
          _interaction_scope: mutation._interaction_scope,
          _trigger: mutation._trigger,
          _handler_removed: mutation._handler_removed === true,
          ...(typeof mutation._handler_module === "string"
            ? { _handler_module: mutation._handler_module }
            : {}),
          ...(typeof mutation._handler_op === "string"
            ? { _handler_op: mutation._handler_op }
            : {}),
        });
      }

      if (mutation._action === "bind-flow") {
        _xlog.log("[xvibe] structured bind flow", {
          _app_id: app_id,
          _env: env,
          _view_id: view_id,
          _source_view_id: source_view_id,
          _persisted_view_id: persisted_view_id,
          ...(mutation_target_id ? { _target_id: mutation_target_id } : {}),
          ...(mutation_target_path ? { _target_path: mutation_target_path } : {}),
          _flow_id:
            _xu.is_plain_object(mutation._flow) &&
            typeof mutation._flow._id === "string"
              ? mutation._flow._id
              : undefined,
          ...(typeof mutation._flow_event === "string"
            ? { _flow_event: mutation._flow_event }
            : {}),
          ...(typeof mutation._flow_auto === "boolean"
            ? { _flow_auto: mutation._flow_auto }
            : {}),
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
        ...(mutation_target_id ? { _target_id: mutation_target_id } : {}),
        ...(mutation_target_path ? { _target_path: mutation_target_path } : {}),
        ...(mutation_target_path ? { _mutation_target_path: mutation_target_path } : {}),
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
        ...(typeof mutation._moved_id === "string"
          ? { _moved_id: mutation._moved_id }
          : {}),
        ...(typeof mutation._source_parent_id === "string"
          ? { _source_parent_id: mutation._source_parent_id }
          : {}),
        ...(typeof mutation._destination_parent_id === "string"
          ? { _destination_parent_id: mutation._destination_parent_id }
          : {}),
        ...(typeof mutation._position === "string"
          ? { _position: mutation._position }
          : {}),
        ...(typeof mutation._location === "string"
          ? { _location: mutation._location }
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
        ...(typeof mutation._interaction_scope === "string"
          ? { _interaction_scope: mutation._interaction_scope }
          : {}),
        ...(typeof mutation._trigger === "string"
          ? { _trigger: mutation._trigger }
          : {}),
        ...(typeof mutation._handler_removed === "boolean"
          ? { _handler_removed: mutation._handler_removed }
          : {}),
        ...(_xu.is_plain_object(mutation._flow)
          ? { _flow: mutation._flow }
          : {}),
        ...(typeof mutation._flow_event === "string"
          ? { _flow_event: mutation._flow_event }
          : {}),
        ...(typeof mutation._flow_auto === "boolean"
          ? { _flow_auto: mutation._flow_auto }
          : {}),
        ...(typeof mutation._hide_mechanism === "string"
          ? { _hide_mechanism: mutation._hide_mechanism }
          : {}),
        ...(typeof mutation._show_mechanism === "string"
          ? { _show_mechanism: mutation._show_mechanism }
          : {}),
        ...(typeof mutation._toolbar_id === "string"
          ? { _toolbar_id: mutation._toolbar_id }
          : {}),
        ...(typeof mutation._created === "boolean"
          ? { _created: mutation._created }
          : {}),
        ...(typeof mutation._reason === "string"
          ? { _reason: mutation._reason }
          : {}),
        ...(_xu.is_plain_object(mutation._styles_applied)
          ? { _styles_applied: mutation._styles_applied }
          : {}),
        ...(_xu.is_plain_object(mutation._previous_styles)
          ? { _previous_styles: mutation._previous_styles }
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
        ...(mutation_target_id ? { _mutation_target_id: mutation_target_id } : {}),
        ...(mutation_target_path ? { _mutation_target_path: mutation_target_path } : {}),
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
        ...(typeof mutation._moved_id === "string"
          ? { _moved_id: mutation._moved_id }
          : {}),
        ...(typeof mutation._source_parent_id === "string"
          ? { _source_parent_id: mutation._source_parent_id }
          : {}),
        ...(typeof mutation._destination_parent_id === "string"
          ? { _destination_parent_id: mutation._destination_parent_id }
          : {}),
        ...(typeof mutation._position === "string"
          ? { _position: mutation._position }
          : {}),
        ...(typeof mutation._location === "string"
          ? { _location: mutation._location }
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
        ...(typeof mutation._interaction_scope === "string"
          ? { _interaction_scope: mutation._interaction_scope }
          : {}),
        ...(typeof mutation._trigger === "string"
          ? { _trigger: mutation._trigger }
          : {}),
        ...(typeof mutation._handler_removed === "boolean"
          ? { _handler_removed: mutation._handler_removed }
          : {}),
        ...(_xu.is_plain_object(mutation._flow)
          ? { _flow: mutation._flow }
          : {}),
        ...(typeof mutation._flow_event === "string"
          ? { _flow_event: mutation._flow_event }
          : {}),
        ...(typeof mutation._flow_auto === "boolean"
          ? { _flow_auto: mutation._flow_auto }
          : {}),
        ...(typeof mutation._hide_mechanism === "string"
          ? { _hide_mechanism: mutation._hide_mechanism }
          : {}),
        ...(typeof mutation._show_mechanism === "string"
          ? { _show_mechanism: mutation._show_mechanism }
          : {}),
        ...(typeof mutation._toolbar_id === "string"
          ? { _toolbar_id: mutation._toolbar_id }
          : {}),
        ...(typeof mutation._created === "boolean"
          ? { _created: mutation._created }
          : {}),
        ...(typeof mutation._reason === "string"
          ? { _reason: mutation._reason }
          : {}),
        ...(_xu.is_plain_object(mutation._styles_applied)
          ? { _styles_applied: mutation._styles_applied }
          : {}),
        ...(_xu.is_plain_object(mutation._previous_styles)
          ? { _previous_styles: mutation._previous_styles }
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
        ...(mutation_target_id ? { _target_id: mutation_target_id } : {}),
        ...(mutation_target_path ? { _target_path: mutation_target_path } : {}),
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
