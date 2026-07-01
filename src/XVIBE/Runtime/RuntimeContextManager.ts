import path from "node:path";
import { _x, _xlog } from "@xpell/core";
import { _xu } from "../../XNUtils/XUtils.js";
import type { XVibeJsonObject } from "../VibeOutputParser.js";
import type {
  XVibeRuntimeAssetRef,
  XVibeRuntimeAssets,
} from "../XVibeTypes.js";

const DEFAULT_ENV = "default";
const XVIBE_INVALID_APP_ID = "E_XVIBE_INVALID_APP_ID";

export type XVibeRuntimeContextInput = {
  _app_id: string;
  _env: string;
  _view_id?: string;
  _current_view?: unknown;
  _generated_artifacts?: unknown;
  _runtime_skills?: unknown;
};

class RuntimeContextManagerError extends Error {
  readonly _payload: XVibeJsonObject;

  constructor(payload: XVibeJsonObject) {
    const message =
      _xu.is_plain_object(payload._error) && typeof payload._error._message === "string"
        ? payload._error._message
        : "XVibe runtime context error";

    super(message);
    this._payload = payload;
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

function throw_explicit_error(code: string, message: string, details?: XVibeJsonObject): never {
  throw new RuntimeContextManagerError(explicit_error(code, message, details));
}

function assert_path_inside(root: string, candidate: string, code: string, message: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw_explicit_error(code, message);
  }
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

function unwrap_command_result(value: unknown): unknown {
  if (!_xu.is_plain_object(value) || typeof value._ok !== "boolean") {
    return value;
  }

  if (value._ok === false) {
    throw new Error(`Command failed: ${JSON.stringify(value._error ?? value._result ?? value)}`);
  }

  return Object.prototype.hasOwnProperty.call(value, "_result")
    ? value._result
    : value;
}

function unwrap_runtime_skills_payload(runtime_skills: unknown): unknown {
  if (
    _xu.is_plain_object(runtime_skills) &&
    _xu.is_plain_object(runtime_skills._skills)
  ) {
    return runtime_skills._skills;
  }

  return runtime_skills;
}

function read_string_array_value(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter((item) => item.length > 0);
}

function skill_marks_generated_module(skill: unknown): boolean {
  if (!_xu.is_plain_object(skill)) return false;

  const core_rules =
    read_string_array_value(skill._core_rules)
      .map((rule) => rule.toLowerCase());

  return core_rules.some((rule) =>
    rule.includes("generated module artifact derived from manifest.json")
  );
}

function normalize_runtime_asset_ids(value: unknown): XVibeRuntimeAssetRef[] {
  const source =
    Array.isArray(value)
      ? value
      : [];

  return Array.from(
    new Set(
      source
        .map((item) => {
          if (typeof item === "string") return item.trim();
          if (_xu.is_plain_object(item) && typeof item._id === "string") {
            return item._id.trim();
          }
          if (_xu.is_plain_object(item) && typeof item._name === "string") {
            return item._name.trim();
          }
          return "";
        })
        .filter((id) => id.length > 0)
    )
  )
    .sort()
    .map((id) => ({ _id: id }));
}

function collect_generated_module_asset_ids(runtime_skills: unknown): XVibeRuntimeAssetRef[] {
  const payload = unwrap_runtime_skills_payload(runtime_skills);
  const ids: string[] = [];

  if (!_xu.is_plain_object(payload)) {
    return [];
  }

  const collect_module_id = (module_item: unknown): void => {
    if (!_xu.is_plain_object(module_item)) return;

    let is_generated = skill_marks_generated_module(module_item);
    if (Array.isArray(module_item._skills)) {
      is_generated =
        is_generated ||
        module_item._skills.some((skill) => skill_marks_generated_module(skill));
    }

    if (!is_generated) return;

    if (typeof module_item._id === "string" && module_item._id.trim()) {
      ids.push(module_item._id.trim());
    } else if (typeof module_item._name === "string" && module_item._name.trim()) {
      ids.push(module_item._name.trim());
    }
  };

  if (Array.isArray(payload._modules)) {
    for (const module_item of payload._modules) {
      collect_module_id(module_item);
    }
  }

  if (Array.isArray(payload._skills)) {
    for (const skill of payload._skills) {
      if (
        !skill_marks_generated_module(skill) ||
        !_xu.is_plain_object(skill) ||
        !_xu.is_plain_object(skill._exports)
      ) {
        continue;
      }
      const exported_modules = Array.isArray(skill._exports._modules)
        ? skill._exports._modules
        : [];
      for (const module_item of exported_modules) {
        collect_module_id({
          ...(_xu.is_plain_object(module_item) ? module_item : {}),
          _skills: [skill],
        });
      }
    }
  }

  return normalize_runtime_asset_ids(ids);
}

export class RuntimeContextManager {
  static errorPayload(error: unknown): XVibeJsonObject | undefined {
    return error instanceof RuntimeContextManagerError
      ? error._payload
      : undefined;
  }

  static resolveXvibeWorkFolder(): string {
    const get_module =
      (_x as unknown as { getModule?: (name: string) => unknown }).getModule;

    if (typeof get_module === "function") {
      const server_xvm =
        get_module.call(_x, "server-xvm");

      if (
        _xu.is_plain_object(server_xvm) &&
        typeof server_xvm._work_folder === "string" &&
        server_xvm._work_folder.trim().length > 0
      ) {
        return server_xvm._work_folder;
      }
    }

    return "./work";
  }

  static resolveTargetAppDir(env: string, app_id: string): string {
    const apps_root = path.resolve(RuntimeContextManager.resolveXvibeWorkFolder(), "xvm", "apps");
    const app_dir = path.resolve(apps_root, env || DEFAULT_ENV, app_id);
    assert_path_inside(
      apps_root,
      app_dir,
      XVIBE_INVALID_APP_ID,
      "Invalid target app path",
    );

    return app_dir;
  }

  static async collectRuntimeAwarenessContext(
    input: XVibeRuntimeContextInput,
  ): Promise<XVibeJsonObject> {
    const runtime_assets =
      await RuntimeContextManager.collectRuntimeAssets({
        _app_id: input._app_id,
        _env: input._env,
        _runtime_skills: input._runtime_skills,
      });

    _xlog.log("[xvibe] runtime asset awareness", {
      _views_count: runtime_assets._views.length,
      _flows_count: runtime_assets._flows.length,
      _entities_count: runtime_assets._entities.length,
      _modules_count: runtime_assets._modules.length,
    });

    return {
      _app_id: input._app_id,
      _env: input._env,
      _runtime_assets: runtime_assets,

      ...(input._view_id
        ? {
          _view_id: input._view_id
        }
        : {}),

      ...(input._current_view
        ? {
          _current_view: input._current_view
        }
        : {}),

      ...(input._generated_artifacts
        ? {
          _generated_artifacts:
            input._generated_artifacts
        }
        : {})
    };
  }

  static async collectRuntimeAssets(input: {
    _app_id: string;
    _env: string;
    _runtime_skills?: unknown;
  }): Promise<XVibeRuntimeAssets> {
    let views: XVibeRuntimeAssetRef[] = [];
    let flows: XVibeRuntimeAssetRef[] = [];
    let entities: XVibeRuntimeAssetRef[] = [];

    try {
      const app_result = unwrap_command_result(
        await _x.execute({
          _module: "server-xvm",
          _op: "get_app",
          _params: {
            _app_id: input._app_id,
            _env: input._env,
            _include_views: false,
            _include_flows: false,
          },
        } as any),
      );

      if (_xu.is_plain_object(app_result)) {
        views = normalize_runtime_asset_ids(app_result._view_ids);
        flows = normalize_runtime_asset_ids(app_result._flow_ids);
        entities = normalize_runtime_asset_ids(app_result._entity_ids);
      }
    } catch (error) {
      _xlog.warn("[xvibe] runtime asset collection failed", {
        _app_id: input._app_id,
        _env: input._env,
        _error: error_summary(error),
      });
    }

    const assets: XVibeRuntimeAssets = {
      _views: views,
      _flows: flows,
      _entities: entities,
      _modules: collect_generated_module_asset_ids(input._runtime_skills),
    };

    return assets;
  }
}
