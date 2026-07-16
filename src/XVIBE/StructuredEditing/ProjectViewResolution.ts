export type ProjectViewResolutionStrategy =
  | "exact"
  | "current-view"
  | "normalized"
  | "root-alias"
  | "target-content-current";

export type ProjectViewResolutionResult =
  | {
    _ok: true;
    _view_id: string;
    _strategy: ProjectViewResolutionStrategy;
  }
  | {
    _ok: false;
    _reason: "view_not_found";
  };

export type ProjectViewResolutionInput = {
  app_id?: string;
  env?: string;
  requested_view_id?: string;
  current_view_id?: string;
  available_views?: unknown;
  target_id?: string;
  target_text?: string;
};

function project_view_trimmed_string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function normalizeProjectViewId(value: string): string {
  return value
    .trim()
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase()
    .replace(/[\s_]+/gu, "-")
    .replace(/[^a-z0-9-]+/gu, "")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function project_view_ids(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => {
      if (typeof item === "string") {
        return project_view_trimmed_string(item);
      }

      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        const record = item as Record<string, unknown>;
        return project_view_trimmed_string(record._id ?? record.id ?? record._view_id);
      }

      return undefined;
    })
    .filter((id): id is string => Boolean(id));
}

function unique_view_ids(ids: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push(id);
  }

  return unique;
}

function is_root_view_alias(value: string): boolean {
  return [
    "main",
    "current",
    "active",
    "current-view",
    "main-view",
    "home",
    "homepage",
  ].includes(normalizeProjectViewId(value));
}

export function resolveProjectViewId(
  input: ProjectViewResolutionInput,
): ProjectViewResolutionResult {
  const requested_view_id =
    project_view_trimmed_string(input.requested_view_id);
  const current_view_id =
    project_view_trimmed_string(input.current_view_id);
  const available_view_ids =
    unique_view_ids([
      ...project_view_ids(input.available_views),
      current_view_id,
    ]);

  if (available_view_ids.length === 0) {
    return { _ok: false, _reason: "view_not_found" };
  }

  if (!requested_view_id) {
    return current_view_id && available_view_ids.includes(current_view_id)
      ? { _ok: true, _view_id: current_view_id, _strategy: "current-view" }
      : { _ok: false, _reason: "view_not_found" };
  }

  if (available_view_ids.includes(requested_view_id)) {
    return {
      _ok: true,
      _view_id: requested_view_id,
      _strategy: "exact",
    };
  }

  const normalized_requested =
    normalizeProjectViewId(requested_view_id);
  const normalized_match =
    available_view_ids.find((view_id) =>
      normalizeProjectViewId(view_id) === normalized_requested
    );
  if (normalized_match) {
    return {
      _ok: true,
      _view_id: normalized_match,
      _strategy: "normalized",
    };
  }

  if (is_root_view_alias(requested_view_id)) {
    const main_view =
      available_view_ids.find((view_id) => normalizeProjectViewId(view_id) === "main");
    const home_view =
      available_view_ids.find((view_id) =>
        normalizeProjectViewId(view_id) === "home" ||
        normalizeProjectViewId(view_id) === "homepage"
      );
    const alias_view =
      normalized_requested === "current" || normalized_requested === "active" || normalized_requested === "current-view"
        ? current_view_id
        : normalized_requested === "home" || normalized_requested === "homepage"
          ? home_view ?? main_view ?? current_view_id
          : main_view ?? current_view_id;
    if (alias_view && available_view_ids.includes(alias_view)) {
      return {
        _ok: true,
        _view_id: alias_view,
        _strategy: "root-alias",
      };
    }
  }

  if (
    current_view_id &&
    available_view_ids.includes(current_view_id) &&
    (
      project_view_trimmed_string(input.target_id) ||
      project_view_trimmed_string(input.target_text)
    )
  ) {
    return {
      _ok: true,
      _view_id: current_view_id,
      _strategy: "target-content-current",
    };
  }

  return { _ok: false, _reason: "view_not_found" };
}
