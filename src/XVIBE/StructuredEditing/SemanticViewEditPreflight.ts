import { _x, _xlog } from "@xpell/core";
import { _xu } from "../../XNUtils/XUtils.js";
import { ensure_view_ids } from "../VibeViewBuilder.js";
import type { XVibeJsonObject } from "../VibeOutputParser.js";
import { resolveProjectViewId } from "./ProjectViewResolution.js";
import {
  canonicalizeSemanticViewEditParams,
  readStructuredViewEditAction,
  type SemanticViewEditCanonicalizationRejectionReason,
  type StructuredViewEditAction,
} from "./StructuredViewEdit.js";
import {
  normalizedVisibleTargetText,
  resolveViewTarget,
  type XVibeViewTargetResolution,
} from "./ViewTargetResolution.js";

type SemanticViewEditPreflightInput = {
  app_id?: string;
  env?: string;
  current_view_id?: string;
  available_views?: string[];
  current_view?: unknown;
  prompt?: string;
  params: Record<string, unknown>;
};

export type SemanticViewEditPreflightResult =
  | {
    _ok: true;
    _params: Record<string, unknown>;
    _normalized_fields: string[];
  }
  | {
    _ok: false;
    _reason: "view_not_found" | "target_not_found" | "target_ambiguous" | SemanticViewEditCanonicalizationRejectionReason;
    _params: Record<string, unknown>;
    _normalized_fields: string[];
    _details?: unknown;
  };

const SEMANTIC_PREFLIGHT_TARGET_ACTIONS = new Set<StructuredViewEditAction>([
  "set-property",
  "update-property",
  "remove-property",
  "set-style",
  "set-styles",
  "remove-style",
  "add-class",
  "remove-class",
  "replace-class",
  "toggle-class",
  "hide-object",
  "show-object",
  "remove-object",
  "move-object",
  "replace-object",
  "duplicate-object",
  "set-interaction",
  "bind-flow",
]);

const TARGET_ID_TRAILING_HINT_WORDS = new Set([
  "button",
  "buttons",
  "field",
  "fields",
  "input",
  "inputs",
  "label",
  "labels",
  "title",
  "titles",
  "heading",
  "headings",
  "text",
  "object",
  "objects",
]);

function semantic_preflight_string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function semantic_preflight_read_string(
  source: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = semantic_preflight_string(source[key]);
    if (value) return value;
  }
  return undefined;
}

function semantic_preflight_extract_view_ids(response: unknown): string[] {
  if (!_xu.is_plain_object(response) || !_xu.is_plain_object(response._result)) {
    return [];
  }

  const views =
    Array.isArray(response._result._views)
      ? response._result._views
      : [];

  return views
    .map((view) => {
      if (typeof view === "string") return view.trim();
      if (_xu.is_plain_object(view)) return semantic_preflight_string(view._id);
      return undefined;
    })
    .filter((view_id): view_id is string => Boolean(view_id));
}

function semantic_preflight_extract_view(response: unknown): XVibeJsonObject | undefined {
  if (_xu.is_plain_object(response)) {
    if (_xu.is_plain_object(response._view)) return response._view as XVibeJsonObject;
    if (_xu.is_plain_object(response._result)) {
      if (_xu.is_plain_object(response._result._view)) {
        return response._result._view as XVibeJsonObject;
      }
      if (_xu.is_plain_object(response._result.view)) {
        return response._result.view as XVibeJsonObject;
      }
    }
  }
  return undefined;
}

async function semantic_preflight_list_project_views(input: {
  app_id: string;
  env: string;
  fallback_views: string[];
}): Promise<string[]> {
  try {
    const response = await _x.execute({
      _module: "server-xvm",
      _op: "list_views",
      _params: {
        _app_id: input.app_id,
        _env: input.env,
      },
    } as any);
    const ids = semantic_preflight_extract_view_ids(response);
    return ids.length > 0 ? ids : input.fallback_views;
  } catch {
    return input.fallback_views;
  }
}

async function semantic_preflight_load_view(input: {
  app_id: string;
  env: string;
  view_id: string;
  current_view?: unknown;
}): Promise<{ _view?: XVibeJsonObject; _persisted: boolean }> {
  try {
    const response = await _x.execute({
      _module: "server-xvm",
      _op: "get_view",
      _params: {
        _app_id: input.app_id,
        _env: input.env,
        _view_id: input.view_id,
      },
    } as any);
    const view = semantic_preflight_extract_view(response);
    if (view) return { _view: view, _persisted: true };
  } catch {
    // Fall through to explicit runtime view context when provided by the caller.
  }

  if (
    _xu.is_plain_object(input.current_view) &&
    semantic_preflight_string(input.current_view._id) === input.view_id
  ) {
    return { _view: input.current_view as XVibeJsonObject, _persisted: false };
  }

  return { _persisted: false };
}

async function semantic_preflight_persist_ids_if_needed(input: {
  app_id: string;
  env: string;
  view_id: string;
  view: XVibeJsonObject;
  persisted: boolean;
}): Promise<void> {
  const result = ensure_view_ids(input.view);
  if (result._count <= 0 || !input.persisted) return;

  await _x.execute({
    _module: "server-xvm",
    _op: "push_update",
    _params: {
      _app_id: input.app_id,
      _env: input.env,
      _view: input.view,
    },
  } as any);
}

function semantic_preflight_title_case(parts: string[]): string {
  return parts
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function semantic_preflight_target_text_from_id(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const parts = value
    .split(/[^a-z0-9]+/giu)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  while (parts.length > 1 && TARGET_ID_TRAILING_HINT_WORDS.has(parts[parts.length - 1].toLowerCase())) {
    parts.pop();
  }
  if (parts.length === 0) return undefined;
  return semantic_preflight_title_case(parts);
}

function semantic_preflight_prompt_hints(prompt: string | undefined): string[] {
  if (!prompt) return [];
  const hints: string[] = [];
  for (const match of prompt.matchAll(/["'“”‘’]([^"'“”‘’]+)["'“”‘’]/gu)) {
    const value = semantic_preflight_string(match[1]);
    if (value) hints.push(value);
  }
  for (const match of prompt.matchAll(/\b(?:the\s+)?([\p{Lu}][\p{L}\p{N}]*(?:\s+[\p{Lu}][\p{L}\p{N}]*){0,3})\s+(?:title|button|field|label|heading)\b/gu)) {
    const value = semantic_preflight_string(match[1]);
    if (value) hints.push(value);
  }
  return hints;
}

function semantic_preflight_quoted_values(prompt: string | undefined): string[] {
  if (!prompt) return [];
  return [...prompt.matchAll(/["'“”‘’]([^"'“”‘’]+)["'“”‘’]/gu)]
    .map((match) => semantic_preflight_string(match[1]))
    .filter((value): value is string => Boolean(value));
}

function semantic_preflight_quoted_source_text(prompt: string | undefined): string | undefined {
  return semantic_preflight_quoted_values(prompt)[0];
}

function semantic_preflight_is_root_target_id(value: unknown, view_id: string): boolean {
  const target_id =
    semantic_preflight_string(value);
  if (!target_id) return false;
  return target_id === view_id || target_id === "main";
}

function semantic_preflight_is_view_type(value: unknown): boolean {
  const target_type =
    semantic_preflight_string(value);
  if (!target_type) return false;
  const normalized =
    target_type
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "");
  return (
    normalized === "view" ||
    normalized === "xview" ||
    normalized === "rootview" ||
    normalized === "currentview"
  );
}

function semantic_preflight_is_text_property_edit(
  action: StructuredViewEditAction,
  params: Record<string, unknown>,
): boolean {
  if (action !== "set-property" && action !== "update-property") {
    return false;
  }
  const property_name =
    semantic_preflight_string(params._property_name);
  if (!property_name) return false;
  const normalized =
    property_name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "");
  return (
    normalized === "text" ||
    normalized === "_text" ||
    normalized === "title" ||
    normalized === "label"
  );
}

function semantic_preflight_target_text_hints(input: {
  params: Record<string, unknown>;
  prompt?: string;
  target_id?: string;
  target_text?: string;
}): string[] {
  const hints = [
    input.target_text,
    semantic_preflight_read_string(input.params, [
      "_target_text",
      "target_text",
      "_target_label",
      "target_label",
      "_target_title",
      "target_title",
      "_label",
      "label",
      "_title",
      "title",
    ]),
    semantic_preflight_target_text_from_id(input.target_id),
    ...semantic_preflight_prompt_hints(input.prompt),
  ];

  const seen = new Set<string>();
  return hints
    .filter((hint): hint is string => Boolean(semantic_preflight_string(hint)))
    .filter((hint) => {
      const normalized = normalizedVisibleTargetText(hint);
      if (!normalized || seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
}

function semantic_preflight_is_ambiguous_resolution(
  resolution: Extract<XVibeViewTargetResolution, { _ok: false }>,
): boolean {
  return (
    resolution._reason === "ambiguous_text_target" ||
    resolution._reason === "ambiguous_normalized_text_target"
  );
}

function semantic_preflight_target_failure(
  resolution: Extract<XVibeViewTargetResolution, { _ok: false }>,
): { _ok: false; _reason: "target_not_found" | "target_ambiguous"; _details?: unknown } {
  if (semantic_preflight_is_ambiguous_resolution(resolution)) {
    return {
      _ok: false,
      _reason: "target_ambiguous",
      _details: resolution._details,
    };
  }
  return {
    _ok: false,
    _reason: "target_not_found",
    _details: resolution._details,
  };
}

async function semantic_preflight_resolve_target(input: {
  app_id: string;
  env: string;
  view_id: string;
  view: XVibeJsonObject;
  persisted: boolean;
  params: Record<string, unknown>;
  prompt?: string;
  target_id?: string;
  target_text?: string;
  target_type?: string;
  allow_root?: boolean;
}): Promise<
  | {
    _ok: true;
    _target_id: string;
    _resolved_target_path: string[];
    _resolved_by: string;
  }
  | {
    _ok: false;
    _reason: "target_not_found" | "target_ambiguous";
    _details?: unknown;
  }
> {
  const direct =
    resolveViewTarget(input.view, {
      ...(input.target_id ? { _target_id: input.target_id } : {}),
      ...(input.target_text ? { _target_text: input.target_text } : {}),
      ...(input.target_type ? { _target_type: input.target_type } : {}),
      _target_id_text_fallback: true,
      _allow_root: input.allow_root === true,
      _view_id: input.view_id,
    });
  if (direct._ok) {
    await semantic_preflight_persist_ids_if_needed({
      app_id: input.app_id,
      env: input.env,
      view_id: input.view_id,
      view: input.view,
      persisted: input.persisted,
    });
    const target_id = semantic_preflight_string(direct.object._id);
    if (target_id) {
      return {
        _ok: true,
        _target_id: target_id,
        _resolved_target_path: direct.path,
        _resolved_by: direct.resolution_strategy,
      };
    }
  } else if (semantic_preflight_is_ambiguous_resolution(direct)) {
    return semantic_preflight_target_failure(direct);
  }

  for (const hint of semantic_preflight_target_text_hints({
    params: input.params,
    prompt: input.prompt,
    target_id: input.target_id,
    target_text: input.target_text,
  })) {
    const hinted =
      resolveViewTarget(input.view, {
        _target_text: hint,
        ...(input.target_type ? { _target_type: input.target_type } : {}),
        _include_id: true,
        _allow_root: input.allow_root === true,
        _view_id: input.view_id,
      });
    if (hinted._ok) {
      await semantic_preflight_persist_ids_if_needed({
        app_id: input.app_id,
        env: input.env,
        view_id: input.view_id,
        view: input.view,
        persisted: input.persisted,
      });
      const target_id = semantic_preflight_string(hinted.object._id);
      if (target_id) {
        return {
          _ok: true,
          _target_id: target_id,
          _resolved_target_path: hinted.path,
          _resolved_by: hinted.resolution_strategy,
        };
      }
    } else if (semantic_preflight_is_ambiguous_resolution(hinted)) {
      return semantic_preflight_target_failure(hinted);
    }
  }

  return direct._ok
    ? { _ok: false, _reason: "target_not_found" }
    : semantic_preflight_target_failure(direct);
}

function semantic_preflight_record_rejection(input: {
  params: Record<string, unknown>;
  reason: "view_not_found" | "target_not_found" | "target_ambiguous" | SemanticViewEditCanonicalizationRejectionReason;
  details?: unknown;
  normalized_fields?: string[];
}): SemanticViewEditPreflightResult {
  input.params._semantic_non_executable_reason = input.reason;
  return {
    _ok: false,
    _reason: input.reason,
    _params: input.params,
    _normalized_fields: [
      ...(input.normalized_fields ?? []),
      "_semantic_non_executable_reason",
    ],
    ...(input.details !== undefined ? { _details: input.details } : {}),
  };
}

function semantic_preflight_requested_target(params: Record<string, unknown>): string | undefined {
  return semantic_preflight_string(params._target_id) ??
    semantic_preflight_string(params.target_id) ??
    semantic_preflight_read_string(params, [
      "_target_text",
      "target_text",
      "_target_label",
      "target_label",
      "_target_title",
      "target_title",
    ]);
}

export async function preflightSemanticViewEdit(
  input: SemanticViewEditPreflightInput,
): Promise<SemanticViewEditPreflightResult> {
  const canonicalization =
    canonicalizeSemanticViewEditParams(input.params);
  const params = { ...canonicalization._params };
  if (!canonicalization._ok) {
    return semantic_preflight_record_rejection({
      params,
      reason: canonicalization._reason,
      normalized_fields: canonicalization._normalized_fields,
    });
  }
  let action: StructuredViewEditAction;
  try {
    action = readStructuredViewEditAction(params._edit_action);
  } catch {
    return semantic_preflight_record_rejection({
      params,
      reason: "invalid_edit_action",
      normalized_fields: canonicalization._normalized_fields,
    });
  }

  if (!SEMANTIC_PREFLIGHT_TARGET_ACTIONS.has(action)) {
    return {
      _ok: true,
      _params: params,
      _normalized_fields: canonicalization._normalized_fields,
    };
  }

  const app_id =
    semantic_preflight_string(input.app_id) ??
    semantic_preflight_string(params._app_id);
  const env =
    semantic_preflight_string(input.env) ??
    semantic_preflight_string(params._env);
  const requested_view_id =
    semantic_preflight_string(params._view_id);
  if (!app_id || !env || !requested_view_id) {
    return {
      _ok: true,
      _params: params,
      _normalized_fields: canonicalization._normalized_fields,
    };
  }

  const available_views =
    await semantic_preflight_list_project_views({
      app_id,
      env,
      fallback_views: input.available_views ?? [],
    });
  const view_resolution =
    resolveProjectViewId({
      app_id,
      env,
      requested_view_id,
      current_view_id: input.current_view_id,
      available_views,
      target_id: semantic_preflight_string(params._target_id),
      target_text: semantic_preflight_read_string(params, [
        "_target_text",
        "target_text",
        "_target_label",
        "target_label",
        "_target_title",
        "target_title",
      ]),
    });
  if (!view_resolution._ok) {
    return semantic_preflight_record_rejection({
      params,
      reason: "view_not_found",
      details: {
        _requested_view_id: requested_view_id,
      },
    });
  }

  const view_id = view_resolution._view_id;
  params._view_id = view_id;
  const loaded =
    await semantic_preflight_load_view({
      app_id,
      env,
      view_id,
      current_view: input.current_view,
    });
  if (!loaded._view) {
    return semantic_preflight_record_rejection({
      params,
      reason: "view_not_found",
      details: {
        _requested_view_id: requested_view_id,
        _resolved_view_id: view_id,
      },
    });
  }

  const normalized_fields: string[] = [
    ...canonicalization._normalized_fields,
  ];
  if (requested_view_id !== view_id) {
    normalized_fields.push("_view_id");
  }

  const quoted_source_text =
    semantic_preflight_quoted_source_text(input.prompt);
  if (
    quoted_source_text &&
    semantic_preflight_is_text_property_edit(action, params) &&
    semantic_preflight_is_root_target_id(params._target_id, view_id) &&
    semantic_preflight_is_view_type(params._target_type)
  ) {
    params._target_id = quoted_source_text;
    params._target_type = "label";
    normalized_fields.push("_target_id", "_target_type");
  }

  const target_type =
    semantic_preflight_string(params._target_type);
  const requested_target_for_log =
    semantic_preflight_requested_target(params);
  const source_resolution =
    await semantic_preflight_resolve_target({
      app_id,
      env,
      view_id,
      view: loaded._view,
      persisted: loaded._persisted,
      params,
      prompt: input.prompt,
      target_id: semantic_preflight_string(params._target_id),
      target_text: semantic_preflight_read_string(params, ["_target_text", "target_text"]),
      ...(target_type ? { target_type } : {}),
    });
  if (!source_resolution._ok) {
    _xlog.log("[xvibe] semantic target preflight", {
      _requested_target: requested_target_for_log,
      _resolved_target_id: undefined,
      _resolved_target_path: undefined,
      _strategy: undefined,
      _ok: false,
      _reason: source_resolution._reason,
    });
    return semantic_preflight_record_rejection({
      params,
      reason: source_resolution._reason,
      details: source_resolution._details,
    });
  }

  if (params._target_id !== source_resolution._target_id) {
    params._target_id = source_resolution._target_id;
      normalized_fields.push("_target_id");
  }
  params._resolved_target_path = source_resolution._resolved_target_path;
  params._resolved_by = source_resolution._resolved_by;
  normalized_fields.push("_resolved_target_path", "_resolved_by");
  _xlog.log("[xvibe] semantic target preflight", {
    _requested_target: requested_target_for_log,
    _resolved_target_id: source_resolution._target_id,
    _resolved_target_path: source_resolution._resolved_target_path,
    _strategy: source_resolution._resolved_by,
    _ok: true,
    _reason: undefined,
  });

  if (action === "move-object") {
    const destination_type =
      semantic_preflight_string(params._destination_type);
    const destination_id =
      semantic_preflight_string(params._destination_id) ??
      semantic_preflight_string(params._before_id) ??
      semantic_preflight_string(params._after_id);
    const destination_text =
      semantic_preflight_read_string(params, ["_destination_text", "destination_text"]);
    const destination_resolution =
      await semantic_preflight_resolve_target({
        app_id,
        env,
        view_id,
        view: loaded._view,
        persisted: loaded._persisted,
        params,
        prompt: input.prompt,
        target_id: destination_id,
        target_text: destination_text,
        ...(destination_type ? { target_type: destination_type } : {}),
      });
    if (!destination_resolution._ok) {
      return semantic_preflight_record_rejection({
        params,
        reason: destination_resolution._reason,
        details: {
          _role: "destination",
          ...(destination_resolution._details && _xu.is_plain_object(destination_resolution._details)
            ? destination_resolution._details
            : {}),
        },
      });
    }
    if (params._destination_id !== destination_resolution._target_id) {
      params._destination_id = destination_resolution._target_id;
      normalized_fields.push("_destination_id");
    }
    if (params._position === "before") {
      params._before_id = destination_resolution._target_id;
      normalized_fields.push("_before_id");
    } else if (params._position === "after") {
      params._after_id = destination_resolution._target_id;
      normalized_fields.push("_after_id");
    }
    params._resolved_destination_path = destination_resolution._resolved_target_path;
    params._destination_resolved_by = destination_resolution._resolved_by;
    normalized_fields.push("_resolved_destination_path", "_destination_resolved_by");
  }

  return {
    _ok: true,
    _params: params,
    _normalized_fields: normalized_fields,
  };
}
