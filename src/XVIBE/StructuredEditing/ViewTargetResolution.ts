import { _xu } from "@xpell/node-core";
import type { XVibeJsonObject } from "../VibeOutputParser.js";

export type XVibeViewTargetResolutionStrategy =
  | "id"
  | "root"
  | "text"
  | "normalized_id"
  | "normalized_text"
  | "text_type_id";

export type XVibeViewTargetLocation = {
  object: XVibeJsonObject;
  parent?: XVibeJsonObject;
  index?: number;
  path: string[];
};

export type XVibeViewTargetResolution =
  | (XVibeViewTargetLocation & {
    _ok: true;
    resolution_strategy: XVibeViewTargetResolutionStrategy;
    _resolved_target_id?: string;
    _resolved_target_path: string[];
  })
  | {
    _ok: false;
    _reason: string;
    _details?: unknown;
  };

const XVIBE_VIEW_TARGET_TEXT_IGNORED_WORDS = new Set([
  "button",
  "buttons",
  "label",
  "labels",
  "object",
  "objects",
]);

function view_target_path_segment(node: XVibeJsonObject, index?: number): string {
  const id =
    typeof node._id === "string" && node._id.trim()
      ? node._id.trim()
      : "";
  if (id) return id;
  return typeof index === "number" ? String(index) : "$root";
}

function collect_view_target_locations(current_view: unknown): XVibeViewTargetLocation[] {
  if (!_xu.is_plain_object(current_view)) return [];

  const locations: XVibeViewTargetLocation[] = [];
  const visit = (
    node: XVibeJsonObject,
    path: string[],
    parent?: XVibeJsonObject,
    index?: number,
  ) => {
    locations.push({
      object: node,
      ...(parent ? { parent } : {}),
      ...(typeof index === "number" ? { index } : {}),
      path,
    });

    if (!Array.isArray(node._children)) return;
    for (let child_index = 0; child_index < node._children.length; child_index += 1) {
      const child = node._children[child_index];
      if (!_xu.is_plain_object(child)) continue;
      visit(
        child,
        [...path, view_target_path_segment(child, child_index)],
        node,
        child_index,
      );
    }
  };

  visit(
    current_view,
    [view_target_path_segment(current_view)],
  );

  return locations;
}

function view_node_visible_target_values(
  node: XVibeJsonObject,
  options?: { _include_id?: boolean },
): string[] {
  const values = [
    ...(options?._include_id === true ? [node._id] : []),
    node._text,
    node.text,
    node.label,
    node.title,
    node._label,
    node._title,
  ];

  return values
    .filter((value): value is string =>
      typeof value === "string" && value.trim().length > 0
    );
}

export function normalizedVisibleTargetText(value: unknown): string {
  if (typeof value !== "string") return "";

  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .trim()
    .split(/\s+/gu)
    .filter((part) => part.length > 0 && !XVIBE_VIEW_TARGET_TEXT_IGNORED_WORDS.has(part))
    .join(" ");
}

function normalized_view_target_type(value: unknown): string {
  return typeof value === "string"
    ? value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "")
    : "";
}

function view_target_type_aliases(value: unknown): Set<string> {
  const target_type =
    normalized_view_target_type(value);
  if (!target_type) return new Set();

  if (target_type === "button" || target_type === "xbutton") {
    return new Set(["button", "xbutton"]);
  }
  if (
    target_type === "label" ||
    target_type === "xlabel" ||
    target_type === "text" ||
    target_type === "textlabel" ||
    target_type === "title" ||
    target_type === "heading"
  ) {
    return new Set(["label", "xlabel", "text", "textlabel", "title", "heading"]);
  }

  return new Set([
    target_type,
    target_type.startsWith("x") ? target_type.slice(1) : `x${target_type}`,
  ].filter((item) => item.length > 0));
}

function view_node_matches_target_type(node: XVibeJsonObject, target_type: string | undefined): boolean {
  const aliases =
    view_target_type_aliases(target_type);
  if (aliases.size === 0) return true;

  const node_type =
    normalized_view_target_type(node._type);
  return Boolean(node_type) && aliases.has(node_type);
}

function deterministic_text_type_target_id(input: {
  _target_text?: string;
  _target_type?: string;
}): string | undefined {
  const normalized_text =
    typeof input._target_text === "string"
      ? input._target_text
        .trim()
        .toLowerCase()
        .replace(/^[^\p{L}\p{N}]+/u, "")
        .trim()
        .replace(/\s+/g, " ")
      : "";
  const target_type =
    typeof input._target_type === "string"
      ? input._target_type.trim().toLowerCase()
      : "";
  if (!normalized_text || !target_type) return undefined;

  const text_id =
    normalized_text
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  const type_id =
    target_type
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  if (!text_id || !type_id) return undefined;

  return `${text_id}-${type_id}`;
}

function filter_view_target_locations_by_type(
  locations: XVibeViewTargetLocation[],
  target_type: string | undefined,
): XVibeViewTargetLocation[] {
  const aliases =
    view_target_type_aliases(target_type);
  if (aliases.size === 0) return locations;

  return locations.filter((location) =>
    view_node_matches_target_type(location.object, target_type)
  );
}

function view_target_locations_for_details(
  locations: XVibeViewTargetLocation[],
): string[] {
  return locations
    .map((location) => typeof location.object._id === "string" ? location.object._id : undefined)
    .filter((id): id is string => Boolean(id));
}

function view_target_identity_resolution(
  location: XVibeViewTargetLocation,
  strategy: XVibeViewTargetResolutionStrategy,
): XVibeViewTargetResolution {
  const resolved_target_id =
    typeof location.object._id === "string" && location.object._id.trim()
      ? location.object._id.trim()
      : undefined;
  const resolved_target_path =
    location.path.length > 0 ? location.path : undefined;

  if (!resolved_target_id && !resolved_target_path) {
    return {
      _ok: false,
      _reason: "target_missing_identity",
      _details: {
        _path: location.path,
      },
    };
  }

  return {
    _ok: true,
    object: location.object,
    ...(location.parent ? { parent: location.parent } : {}),
    ...(typeof location.index === "number" ? { index: location.index } : {}),
    path: location.path,
    ...(resolved_target_id ? { _resolved_target_id: resolved_target_id } : {}),
    _resolved_target_path: resolved_target_path ?? location.path,
    resolution_strategy: strategy,
  };
}

function resolve_unique_view_target_location(input: {
  _locations: XVibeViewTargetLocation[];
  _strategy: XVibeViewTargetResolutionStrategy;
  _target_value: string;
  _target_type?: string;
  _ambiguous_reason: string;
  _not_found_reason: string;
  _details?: XVibeJsonObject;
}): XVibeViewTargetResolution {
  if (input._locations.length > 1) {
    return {
      _ok: false,
      _reason: input._ambiguous_reason,
      _details: {
        _target_text: input._target_value,
        ...(input._target_type ? { _target_type: input._target_type } : {}),
        _match_count: input._locations.length,
        _target_ids: view_target_locations_for_details(input._locations),
        ...(input._details ?? {}),
      },
    };
  }

  const location = input._locations[0];
  if (!location) {
    return {
      _ok: false,
      _reason: input._not_found_reason,
      _details: {
        _target_text: input._target_value,
        ...(input._target_type ? { _target_type: input._target_type } : {}),
        ...(input._details ?? {}),
      },
    };
  }

  return view_target_identity_resolution(location, input._strategy);
}

export function resolveViewTarget(
  view: unknown,
  target: {
    _target_id?: string;
    _target_text?: string;
    _target_type?: string;
    _include_id?: boolean;
    _target_id_text_fallback?: boolean;
    _allow_root?: boolean;
    _view_id?: string;
  },
): XVibeViewTargetResolution {
  const locations =
    collect_view_target_locations(view);
  if (locations.length === 0) {
    return { _ok: false, _reason: "target_not_found" };
  }

  const root_location = locations[0];
  const target_id =
    typeof target._target_id === "string"
      ? target._target_id.trim()
      : "";
  const target_text =
    typeof target._target_text === "string"
      ? target._target_text.trim()
      : "";

  if (target_id) {
    const exact_id_location =
      locations.find((location) => location.object._id === target_id);
    if (
      exact_id_location &&
      view_node_matches_target_type(exact_id_location.object, target._target_type)
    ) {
      if (exact_id_location.object === root_location.object && target._allow_root !== true) {
        return {
          _ok: false,
          _reason: "target_is_root",
          _details: { _target_id: target_id },
        };
      }

      return view_target_identity_resolution(
        exact_id_location,
        exact_id_location.object === root_location.object ? "root" : "id",
      );
    }

    const root_id =
      typeof root_location.object._id === "string"
        ? root_location.object._id.trim()
        : "";
    const view_id =
      typeof target._view_id === "string"
        ? target._view_id.trim()
        : "";
    if (
      target._allow_root === true &&
      (
        (root_id && target_id === root_id) ||
        (view_id && target_id === view_id) ||
        target_id === "main"
      )
    ) {
      return view_target_identity_resolution(root_location, "root");
    }
  }

  const fallback_text =
    target_text ||
    (target._target_id_text_fallback === true ? target_id : "");
  if (!fallback_text) {
    return target_id
      ? {
        _ok: false,
        _reason: "target_not_found",
        _details: { _target_id: target_id },
      }
      : { _ok: false, _reason: "missing_target_id" };
  }

  const exact_text_locations =
    filter_view_target_locations_by_type(
      locations.filter((location) =>
        view_node_visible_target_values(location.object, {
          _include_id: target._include_id === true,
        }).some((value) => value === fallback_text)
      ),
      target._target_type,
    )
      .filter((location) => target._allow_root === true || location.object !== root_location.object);
  const exact_text_resolution =
    resolve_unique_view_target_location({
      _locations: exact_text_locations,
      _strategy: "text",
      _target_value: fallback_text,
      _target_type: target._target_type,
      _ambiguous_reason: "ambiguous_text_target",
      _not_found_reason: "text_target_not_found",
    });
  if (exact_text_resolution._ok || exact_text_resolution._reason === "ambiguous_text_target") {
    return exact_text_resolution;
  }

  const normalized_target =
    normalizedVisibleTargetText(fallback_text);
  if (normalized_target) {
    const normalized_text_locations =
      filter_view_target_locations_by_type(
        locations.filter((location) =>
          view_node_visible_target_values(location.object, {
            _include_id: target._include_id === true,
          }).some((value) => normalizedVisibleTargetText(value) === normalized_target)
        ),
        target._target_type,
      )
        .filter((location) => target._allow_root === true || location.object !== root_location.object);
    const normalized_text_resolution =
      resolve_unique_view_target_location({
        _locations: normalized_text_locations,
        _strategy: "normalized_text",
        _target_value: fallback_text,
        _target_type: target._target_type,
        _ambiguous_reason: "ambiguous_normalized_text_target",
        _not_found_reason: "text_target_not_found",
        _details: { _normalized_text: normalized_target },
      });
    if (
      normalized_text_resolution._ok ||
      normalized_text_resolution._reason === "ambiguous_normalized_text_target"
    ) {
      return normalized_text_resolution;
    }

    const text_type_target_id =
      deterministic_text_type_target_id({
        _target_text: fallback_text,
        _target_type: target._target_type,
      });
    if (text_type_target_id) {
      const text_type_location =
        locations.find((location) => location.object._id === text_type_target_id);
      if (
        text_type_location &&
        view_node_matches_target_type(text_type_location.object, target._target_type) &&
        (target._allow_root === true || text_type_location.object !== root_location.object)
      ) {
        return view_target_identity_resolution(text_type_location, "text_type_id");
      }
    }

    const normalized_id_locations =
      filter_view_target_locations_by_type(
        locations.filter((location) =>
          typeof location.object._id === "string" &&
          normalizedVisibleTargetText(location.object._id) === normalized_target
        ),
        target._target_type,
      )
        .filter((location) => target._allow_root === true || location.object !== root_location.object);
    const normalized_id_resolution =
      resolve_unique_view_target_location({
        _locations: normalized_id_locations,
        _strategy: "normalized_id",
        _target_value: fallback_text,
        _target_type: target._target_type,
        _ambiguous_reason: "ambiguous_normalized_text_target",
        _not_found_reason: "text_target_not_found",
        _details: { _normalized_text: normalized_target },
      });
    if (
      normalized_id_resolution._ok ||
      normalized_id_resolution._reason === "ambiguous_normalized_text_target"
    ) {
      return normalized_id_resolution;
    }
  }

  return {
    _ok: false,
    _reason: target_id && !target_text
      ? "target_not_found"
      : "text_target_not_found",
    _details: target_id && !target_text
      ? { _target_id: target_id }
      : {
        _target_text: fallback_text,
        ...(target._target_type ? { _target_type: target._target_type } : {}),
      },
  };
}
