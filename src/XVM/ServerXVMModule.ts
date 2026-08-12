import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { XModule, type XCommand, _xlog, _x, XError, type XpellSkill, type XpellSkillCommand } from "@xpell/core";
import { _xem } from "@xpell/node-core";
import { _xu } from "@xpell/node-core";
import { _xs } from "@xpell/node-core";
import { wsBroadcastScoped, wsSetScope } from "../Wormholes/wh.index.js";
import {
  append_project_memory_achievement,
  log_project_memory_achievement_result,
} from "./ProjectMemoryAchievements.js";
import {
  complete_project_memory_focus_milestone_item,
  apply_project_memory_milestones,
  normalize_project_memory_milestones,
} from "./ProjectMemoryMilestones.js";
import {
  resolveProjectStage,
  type XVMProjectMemoryStage,
} from "./ProjectMemoryStage.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type XVMEnv = string;

export type XVMView = Record<string, any> & {
  _id: string;
};

export type XVMFlow = Record<string, any> & {
  _id: string;
};

export type XVMAppMeta = {
  _name?: string;
  _version: number;
  _entry_view_id?: string;
  _updated_at?: string;
  [k: string]: any;
};

export type XVMAppFile = {
  _app_id: string;
  _env: XVMEnv;
  _system?: boolean;
  _meta: XVMAppMeta;
  _config: Record<string, any>;
};

export type XVMAppBundle = {
  _app: XVMAppFile;
  _views: Record<string, XVMView>;
  _flows: Record<string, XVMFlow>;
  _entities: Record<string, any>;
};

export type XVMProjectMemory = {
  _version: number;
  _stage: XVMProjectMemoryStage;
  _vision: string;
  _goal: string;
  _summary?: string;
  _proposed?: {
    _entities?: unknown[];
    _views?: unknown[];
    _flows?: unknown[];
    _server_modules?: unknown[];
  };
  _confirmed_initial_plan?: Record<string, any>;
  _semantic_generation_plan?: Record<string, any>;
  _current_focus: string;
  _completed: unknown[];
  _achievements: unknown[];
  _milestones: unknown[];
  _parking_lot: unknown[];
  _decisions: unknown[];
  _notes: unknown[];
  _updated_at: string;
  _last_change_plan_execution?: Record<string, any>;
  _change_plan_executions?: unknown[];
};

type XVMGeneratedOperationKind = "view.create" | "view.replace";

type XVMGeneratedOperation = Record<string, any> & {
  _type: "xvibe-generated-operation";
  _contract_version: 1;
  _id: string;
  _source_step_id: string;
  _kind: XVMGeneratedOperationKind;
  _target: {
    _app_id: string;
    _env: string;
    _view_id: string;
  };
  _artifact: {
    _artifact_type: "view";
    _contract_version: 1;
    _view: XVMView;
  };
  _validation: Record<string, any>;
};

type XVMChangePlanOperation =
  | {
    _type: "deterministic";
    _id?: string;
    _primitive: {
      _module: string;
      _op: string;
      _params?: Record<string, any>;
    };
  }
  | {
    _type: "generated";
    _id?: string;
    _operation: XVMGeneratedOperation;
  };

type XVMDeterministicViewEditPreflight = {
  _view_id: string;
  _edit_action?: string;
  _target_id?: string;
  _idempotent_result?: Record<string, any>;
};

/* -------------------------------------------------------------------------- */

const DEFAULT_ENV = "default";
const DEFAULT_WORK_FOLDER = "./work";
const XVM_FOLDER = "xvm/apps";
const GENERATED_MODULE_REGISTRY_FILE = "generated/xmodules/registry.json";
const ACTIVE_APPS_SETTINGS_KEY = "_active_apps";
const XVM_VISIBILITY_PROPERTY = "_visible";
const XNODE_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ALLOWED_VIEW_STARTER_TEMPLATES = new Set(["blank", "page", "component"]);

const EVT_UPDATE = "server-xvm:update";

function clone_json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function app_scope_key(app_id: string, env: string): string {
  return `${env}::${app_id}`;
}

function server_xvm_verbose_log(message: string, data?: Record<string, unknown>) {
  const logger = _xlog as unknown as { _debug?: boolean; _verbose?: boolean };
  if (logger._debug === true || logger._verbose === true) {
    _xlog.log(message, data);
  }
}

function registry_entry_state(entry: Record<string, any>): string {
  return typeof entry._state === "string" && entry._state.trim()
    ? entry._state
    : "implemented";
}

function registry_entry_ops(entry: Record<string, any>): string[] {
  return Array.isArray(entry._ops)
    ? entry._ops
      .map((op: unknown) => {
        if (typeof op === "string") return op;
        if (_xu.is_plain_object(op) && typeof op._name === "string") return op._name;
        return undefined;
      })
      .filter((op: unknown): op is string => typeof op === "string")
    : [];
}

function runtime_type(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value !== "object") return typeof value;
  return value.constructor?.name ?? "object";
}

function find_non_json_compatible_value(
  value: unknown,
  path_name = "$",
): { _path: string; _runtime_type: string } | null {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return null;
  }

  if (typeof value === "number") {
    return Number.isFinite(value)
      ? null
      : { _path: path_name, _runtime_type: runtime_type(value) };
  }

  if (typeof value !== "object") {
    return { _path: path_name, _runtime_type: runtime_type(value) };
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const child =
        find_non_json_compatible_value(value[index], `${path_name}[${index}]`);
      if (child) return child;
    }
    return null;
  }

  if (!_xu.is_plain_object(value)) {
    return { _path: path_name, _runtime_type: runtime_type(value) };
  }

  for (const [key, child_value] of Object.entries(value)) {
    const child =
      find_non_json_compatible_value(child_value, `${path_name}.${key}`);
    if (child) return child;
  }

  return null;
}

function stable_json_hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function read_non_empty_string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

const SERVER_FLOW_DYNAMIC_REFERENCE_ROOTS = new Set(["event", "xdata", "step"]);
const SERVER_FLOW_DYNAMIC_REFERENCE_PATTERN =
  /^\$([a-zA-Z][a-zA-Z0-9_]*)(?:\.([a-zA-Z0-9_:-]+(?:\.[a-zA-Z0-9_:-]+)*))$/u;

function xvm_error_result(
  code: string,
  message: string,
  details?: Record<string, any>,
) {
  return {
    _ok: false,
    _result: {
      _code: code,
      _message: message,
      ...(details ? { _details: details } : {}),
    },
  };
}

function xvm_error_from_unknown(error: unknown, fallback_code: string) {
  if (error instanceof XError) {
    return xvm_error_result(
      error._code,
      error.message,
      error._meta,
    );
  }

  return xvm_error_result(
    fallback_code,
    error instanceof Error ? error.message : String(error),
  );
}

function normalize_generated_operation_kind(value: unknown): XVMGeneratedOperationKind {
  if (value === "view.create" || value === "view.replace") {
    return value;
  }

  throw new XError("E_XVM_GENERATED_OPERATION_UNSUPPORTED_KIND", "Unsupported generated operation kind", {
    _meta: {
      _kind: value,
      _supported_kinds: ["view.create", "view.replace"],
    },
  });
}

/* -------------------------------------------------------------------------- */

export const SERVER_XVM_OPS: Record<string, XpellSkillCommand> = {
  create_app: {
    _name: "create_app",
    _scope: "module",
    _description: "Create application container."
  },

  get_app: {
    _name: "get_app",
    _scope: "module",
    _description: "Load application bundle."
  },

  get_view: {
    _name: "get_view",
    _scope: "module",
    _description: "Load view artifact."
  },

  get_project_memory: {
    _name: "get_project_memory",
    _scope: "module",
    _description: "Load or initialize application project memory."
  },

  save_project_memory: {
    _name: "save_project_memory",
    _scope: "module",
    _description: "Persist application project memory."
  },

  patch_project_memory: {
    _name: "patch_project_memory",
    _scope: "module",
    _description: "Patch and persist application project memory."
  },

  create_view: {
    _name: "create_view",
    _scope: "module",
    _description: "Create a deterministic persisted view artifact."
  },

  push_update: {
    _name: "push_update",
    _scope: "module",
    _description: "Persist and broadcast view updates."
  },

  apply_generated_operation: {
    _name: "apply_generated_operation",
    _scope: "module",
    _description: "Validate and persist one canonical XVibe generated artifact operation."
  },

  apply_change_plan_operations: {
    _name: "apply_change_plan_operations",
    _scope: "module",
    _description: "Apply an ordered Change Plan operation batch with generated-operation rollback support."
  },

  subscribe: {
    _name: "subscribe",
    _scope: "module",
    _description: "Subscribe runtime client to updates."
  },

  set_flow: {
    _name: "set_flow",
    _scope: "module",
    _description: "Persist flow artifact."
  },

  set_entity: {
    _name: "set_entity",
    _scope: "module",
    _description: "Persist entity artifact."
  },

  delete_entity: {
    _name: "delete_entity",
    _scope: "module",
    _description: "Delete entity artifact and unregister runtime schema."
  },

  set_active_app: {
    _name: "set_active_app",
    _scope: "module",
    _description: "Set active application."
  },

  get_active_app: {
    _name: "get_active_app",
    _scope: "module",
    _description: "Get active application."
  },
  list_apps: {
    _name: "list_apps",
    _scope: "module",
    _description: "List loaded runtime applications."
  },

  load_app_from_disk: {
    _name: "load_app_from_disk",
    _scope: "module",
    _description: "Load or reload a user application from persisted disk storage."
  },

  reload_app: {
    _name: "reload_app",
    _scope: "module",
    _description: "Reload a user application from persisted disk storage."
  },

  list_views: {
    _name: "list_views",
    _scope: "module",
    _description: "List view artifacts for an application."
  },

  list_flows: {
    _name: "list_flows",
    _scope: "module",
    _description: "List flow artifacts for an application."
  },

  list_entities: {
    _name: "list_entities",
    _scope: "module",
    _description: "List entity artifacts for an application."
  },

  list_generated_modules: {
    _name: "list_generated_modules",
    _scope: "module",
    _description: "List generated runtime modules."
  },

  save_view_json: {
    _name: "save_view_json",
    _scope: "module",
    _description: "Persist a view JSON artifact."
  }
};

export const SERVER_XVM_SKILL: XpellSkill = {
  _id: "server-xvm",
  _title: "Server XVM",
  _version: "1.0.0",
  _active: true,
  _type: "server-module-api",
  _requires: ["xmodule"],

  _description:
    "Application runtime persistence, view storage, flow storage, entity storage, versioning, subscriptions, and live update broadcasting.",

  _exports: {
    _modules: [
      {
        _name: "server-xvm",
        _scope: "server",
        _description:
          "Runtime application manager.",
        _ops: Object.values(SERVER_XVM_OPS)
      }
    ]
  },

  _core_rules: [
    "Views are persisted through push_update.",
    "Flows are persisted through set_flow.",
    "Entities are persisted through set_entity.",
    "Project memory is persisted as project-memory.json next to app.json.",
    "Version changes broadcast runtime updates.",
    "server-xvm is the source of truth for runtime artifacts."
  ]
};


export class ServerXVMModule extends XModule {
  static _name = "server-xvm";
  static _skill = SERVER_XVM_SKILL;
  static _ops = SERVER_XVM_OPS;

  private _work_folder: string;
  private _apps_root: string;
  private _apps: Map<string, XVMAppBundle> = new Map();
  private _active_app_by_env: Map<string, string> = new Map();
  private _system_xapps_path?: string;
  private _package_system_xapps_path: string;

  constructor(opts: any = {}) {
    super({ _name: ServerXVMModule._name });

    const work_folder = opts._work_folder ?? DEFAULT_WORK_FOLDER;
    this._work_folder = work_folder;
    this._apps_root = opts._apps_root ?? path.join(work_folder, XVM_FOLDER);
    this._system_xapps_path = typeof opts._system_xapps_path === "string" && opts._system_xapps_path
      ? path.resolve(opts._system_xapps_path)
      : undefined;
    this._package_system_xapps_path =
      typeof opts._package_system_xapps_path === "string" &&
      opts._package_system_xapps_path
      ? path.resolve(opts._package_system_xapps_path)
      : path.resolve(XNODE_PACKAGE_ROOT, "system-xapps");
  }

  /* ------------------------------------------------------------------------ */
  /* CREATE APP                                                               */
  /* ------------------------------------------------------------------------ */

  async _create_app(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);

    const app_id = _xu.ensure_string(params._app_id, "_app_id");
    const env = this.resolve_env(params);

    const key = app_scope_key(app_id, env);
    const existing = this._apps.get(key);

    if (existing) {
      return { _ok: true, _result: { _app: existing._app, _created: false } };
    }

    const app_file: XVMAppFile = {
      _app_id: app_id,
      _env: env,
      _system: false,
      _meta: {
        _name: params._name ?? app_id,
        _version: 1,
        _entry_view_id: params._entry_view_id ?? "view-main",
        _updated_at: _xu.to_iso_now(),
      },
      _config: params._config ?? {},
    };

    const bundle: XVMAppBundle = {
      _app: app_file,
      _views: {},
      _flows: {},
      _entities: {},
    };

    this._apps.set(key, bundle);
    this.persist_bundle(bundle);

    return { _ok: true, _result: { _app: app_file, _created: true } };
  }


  async _set_active_app(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);

    const app_id = _xu.ensure_string(params._app_id, "_app_id");
    const env = this.resolve_env(params);

    this.get_bundle(app_id, env);

    this.persist_active_app(env, app_id);
    this._active_app_by_env.set(env, app_id);

    _xlog.log("[server-xvm] active app set", {
      _app_id: app_id,
      _env: env,
      _persisted: true
    });

    return {
      _ok: true,
      _result: {
        _app_id: app_id,
        _env: env,
        _persisted: true
      }
    };
  }

  async _get_active_app(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);
    const env = this.resolve_env(params);

    const app_id = this.resolve_default_app_id(env);

    return {
      _ok: true,
      _result: {
        _app_id: app_id,
        _env: env
      }
    };
  }

  /* ------------------------------------------------------------------------ */
  /* GET APP                                                                  */
  /* ------------------------------------------------------------------------ */

  async _get_app(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);

    const env = this.resolve_env(params);

    const app_id = this.resolve_app_id(params, env);
    const include_views = params._include_views === true;
    const include_flows = params._include_flows === true;

    const bundle = this.get_bundle(app_id, env);

    const res: any = {
      _app: bundle._app,
      _view_ids: Object.keys(bundle._views || {}),
      _flow_ids: Object.keys(bundle._flows || {}),
      _entity_ids: Object.keys(bundle._entities || {}),
      _entities: bundle._entities || {},
    };

    if (include_views) res._views = bundle._views || {};
    if (include_flows) res._flows = bundle._flows || {};

    return { _ok: true, _result: res };
  }

  async _list_apps(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);
    const env = typeof params._env === "string" ? params._env : undefined;
    const include_system = params._include_system === true;

    const apps = Array.from(this._apps.values())
      .map(bundle => bundle._app)
      .filter(app => !env || app._env === env)
      .filter(app => include_system || app._system !== true);

    return {
      _ok: true,
      _result: {
        _app_ids: apps.map(app => app._app_id),
        _apps: apps
      }
    };
  }

  async _load_app_from_disk(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);
    const app_id = this.resolve_safe_segment(params._app_id, "_app_id", "E_XVM_INVALID_APP_ID");
    const env = this.resolve_safe_segment(
      typeof params._env === "string" ? params._env : DEFAULT_ENV,
      "_env",
      "E_XVM_INVALID_ENV"
    );
    const app_dir = this.resolve_user_app_dir(env, app_id);

    if (!fs.existsSync(path.join(app_dir, "app.json"))) {
      throw new XError("E_XVM_APP_NOT_FOUND", `App not found on disk: ${app_id}`);
    }

    const loaded = await this.loadAppFromDir(app_dir, env, false);

    if (loaded._apps < 1) {
      throw new XError("E_XVM_APP_LOAD_FAILED", `Failed to load app from disk: ${app_id}`);
    }

    const bundle = this.get_bundle(app_id, env);

    _xlog.log("[server-xvm] user app loaded/reloaded", {
      _app_id: app_id,
      _env: env
    });

    return {
      _ok: true,
      _result: {
        _app: bundle._app,
        _view_ids: Object.keys(bundle._views || {}),
        _flow_ids: Object.keys(bundle._flows || {}),
        _entity_ids: Object.keys(bundle._entities || {}),
        _reloaded: true
      }
    };
  }

  async _reload_app(xcmd: XCommand) {
    return this._load_app_from_disk(xcmd);
  }

  /* ------------------------------------------------------------------------ */
  /* GET VIEW                                                                 */
  /* ------------------------------------------------------------------------ */

  async _get_view(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);

    const app_id = _xu.ensure_string(params._app_id, "_app_id");
    const view_id = _xu.ensure_string(params._view_id, "_view_id");
    const env = this.resolve_env(params);

    const bundle = this.get_bundle(app_id, env);
    const view = bundle._views[view_id];

    if (!view) throw new XError("E_XVM_VIEW_NOT_FOUND", `View not found: ${view_id}`);

    return {
      _ok: true,
      _result: {
        _app_id: app_id,
        _env: env,
        _version: bundle._app._meta._version,
        _view: view,
      },
    };
  }

  async _get_project_memory(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);
    const context = this.resolve_project_memory_context(params);
    const memory = this.load_or_create_project_memory(
      context._app_id,
      context._env,
      context._memory_path
    );

    return {
      _ok: true,
      _result: {
        _memory: this.normalize_project_memory(memory, {
          _touch_updated_at: false
        })
      }
    };
  }

  async _save_project_memory(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);
    const context = this.resolve_project_memory_context(params);

    if (!_xu.is_plain_object(params._memory)) {
      throw new XError("E_XVM_INVALID_PAYLOAD", "Missing _memory");
    }

    const memory = apply_project_memory_milestones(
      this.normalize_project_memory(params._memory)
    ) as XVMProjectMemory;
    this.save_project_memory_file(context._app_id, context._env, context._memory_path, memory);

    return {
      _ok: true,
      _result: {
        _memory: memory
      }
    };
  }

  async _patch_project_memory(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);
    const context = this.resolve_project_memory_context(params);

    if (!_xu.is_plain_object(params._patch)) {
      throw new XError("E_XVM_INVALID_PAYLOAD", "Missing _patch");
    }

    const current = this.normalize_project_memory(
      this.load_or_create_project_memory(
        context._app_id,
        context._env,
        context._memory_path
      ),
      {
        _touch_updated_at: false
      }
    );
    let memory = apply_project_memory_milestones(
      this.normalize_project_memory({
        ...current,
        ...params._patch
      })
    ) as XVMProjectMemory;

    if (
      typeof params._patch._current_focus === "string" &&
      params._patch._current_focus.trim().length > 0
    ) {
      const achievement_result = append_project_memory_achievement({
        _memory: memory,
        _achievement_id: "first-project-memory-focus",
      });
      memory = achievement_result._memory as XVMProjectMemory;
      log_project_memory_achievement_result({
        _app_id: context._app_id,
        _env: context._env,
        _achievement_id: "first-project-memory-focus",
        _result: achievement_result,
      });
    }

    this.save_project_memory_file(context._app_id, context._env, context._memory_path, memory);

    return {
      _ok: true,
      _result: {
        _memory: memory
      }
    };
  }

  async _list_views(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);

    const app_id = _xu.ensure_string(params._app_id, "_app_id");
    const env = this.resolve_env(params);

    const bundle = this.get_bundle(app_id, env);
    const views = Object.values(bundle._views || {});

    server_xvm_verbose_log("[server-xvm] list views", {
      _app_id: app_id,
      _env: env,
      _count: views.length
    });

    return {
      _ok: true,
      _result: {
        _views: views.map((view) => ({
          _id: view._id,
          _type: view._type,
          _title: view._title ?? view._name ?? view._id,
          _children_count: Array.isArray(view._children)
            ? view._children.length
            : 0
        })),
      },
    };
  }

  async _create_view(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);

    const app_id = this.resolve_safe_segment(
      params._app_id,
      "_app_id",
      "E_XVM_INVALID_APP_ID"
    );
    const env = this.resolve_safe_segment(
      params._env,
      "_env",
      "E_XVM_INVALID_ENV"
    );
    const view_id = this.resolve_safe_view_id(params._view_id);
    const template = this.resolve_view_template(params._template);
    const title = typeof params._title === "string" && params._title.trim()
      ? params._title.trim()
      : undefined;

    _xlog.log("[xstudio] create view requested", {
      _app_id: app_id,
      _env: env,
      _view_id: view_id,
      _template: template
    });

    const bundle = this.get_bundle(app_id, env);
    this.assert_mutable_bundle(bundle);

    const app_dir = this.resolve_user_app_dir(env, app_id);
    const views_dir = path.join(app_dir, "views");
    const view_file = this.resolve_view_file_path(views_dir, view_id);

    if (bundle._views[view_id] || fs.existsSync(view_file)) {
      throw new XError("E_XVM_VIEW_ALREADY_EXISTS", `View already exists: ${view_id}`);
    }

    const view = this.load_view_starter_template(view_id, title ?? view_id, template);
    this.validate_view_artifact({
      view,
      view_id,
      app_id,
      env,
      available_view_ids: new Set([
        ...Object.keys(bundle._views || {}),
        view_id,
      ]),
      available_entity_ids: new Set(Object.keys(bundle._entities || {})),
      available_flow_ids: new Set(Object.keys(bundle._flows || {})),
    });
    const next_app: XVMAppFile = {
      ...bundle._app,
      _meta: {
        ...bundle._app._meta,
        _version: bundle._app._meta._version + 1,
        _updated_at: _xu.to_iso_now()
      }
    };

    fs.mkdirSync(views_dir, { recursive: true });
    this.write_new_json_file(view_file, view);

    try {
      this.write_json_file_atomic(
        path.join(app_dir, "app.json"),
        next_app
      );
    } catch (err) {
      try {
        fs.unlinkSync(view_file);
      } catch {
      }

      throw err;
    }

    bundle._app = next_app;
    bundle._views[view_id] = view;

    _xlog.log("[xstudio] create view created", {
      _app_id: app_id,
      _env: env,
      _view_id: view_id,
      _path: view_file
    });

    return {
      _ok: true,
      _view_id: view_id,
      _path: view_file,
      _view: view
    };
  }

  /* ------------------------------------------------------------------------ */
  /* FLOW APIs                                                                */
  /* ------------------------------------------------------------------------ */

  async _set_flow(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);

    const app_id = _xu.ensure_string(params._app_id, "_app_id");
    const env = this.resolve_env(params);

    const flow = params._flow;
    if (!_xu.is_plain_object(flow)) throw new XError("E_XVM_INVALID_PAYLOAD", "Missing _flow");

    const flow_id = _xu.ensure_string(flow._id, "_flow._id");

    const bundle = this.get_bundle(app_id, env);
    this.assert_mutable_bundle(bundle);

    const normalized: XVMFlow = {
      ...flow,
      _id: flow_id
    };
    const available_flow_ids = new Set(Object.keys(bundle._flows || {}));
    available_flow_ids.add(flow_id);
    this.validate_flow_artifact({
      flow: normalized,
      flow_id,
      app_id,
      env,
      available_entity_ids: new Set(Object.keys(bundle._entities || {})),
      available_flow_ids,
    });

    bundle._flows[flow_id] = normalized;
    bundle._app._meta._version++;
    bundle._app._meta._updated_at = _xu.to_iso_now();

    this.persist_bundle(bundle);

    return { _ok: true, _result: { _flow_id: flow_id } };
  }

  async _get_flow(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);

    const app_id = _xu.ensure_string(params._app_id, "_app_id");
    const flow_id = _xu.ensure_string(params._flow_id, "_flow_id");
    const env = this.resolve_env(params);

    const bundle = this.get_bundle(app_id, env);
    const flow = bundle._flows?.[flow_id];

    if (!flow) throw new XError("E_XVM_FLOW_NOT_FOUND", `Flow not found: ${flow_id}`);

    return {
      _ok: true,
      _result: {
        _app_id: app_id,
        _env: env,
        _version: bundle._app._meta._version,
        _flow: flow,
      },
    };
  }

  async _list_flows(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);

    const app_id = _xu.ensure_string(params._app_id, "_app_id");
    const env = this.resolve_env(params);

    const bundle = this.get_bundle(app_id, env);
    const flows = Object.values(bundle._flows || {});

    server_xvm_verbose_log("[server-xvm] list flows", {
      _app_id: app_id,
      _env: env,
      _count: flows.length
    });

    return {
      _ok: true,
      _result: {
        _flows: flows.map((flow) => ({
          _id: flow._id,
          _type: flow._type,
          _title: flow._title ?? flow._name ?? flow._id
        })),
      },
    };
  }

  async _list_generated_modules(_xcmd: XCommand) {
    const modules = this.read_generated_module_registry_modules();

    server_xvm_verbose_log("[server-xvm] list generated modules", {
      _count: modules.length
    });

    return {
      _ok: true,
      _result: {
        _modules: modules
      }
    };
  }


  async _get_entity(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);

    const app_id = _xu.ensure_string(params._app_id, "_app_id");
    const entity_id = _xu.ensure_string(params._entity_id, "_entity_id");
    const env = this.resolve_env(params);

    const bundle = this.get_bundle(app_id, env);
    const entity = bundle._entities?.[entity_id];

    if (!entity) throw new XError("E_XVM_ENTITY_NOT_FOUND", `Entity not found: ${entity_id}`);

    return {
      _ok: true,
      _result: {
        _app_id: app_id,
        _env: env,
        _version: bundle._app._meta._version,
        _entity: entity,
      },
    };
  }


  async _set_entity(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);

    const app_id = _xu.ensure_string(params._app_id, "_app_id");
    const env = this.resolve_env(params);

    const entity = params._entity;
    if (!_xu.is_plain_object(entity)) throw new XError("E_XVM_INVALID_PAYLOAD", "Missing _entity");

    const entity_id = _xu.ensure_string(entity._id, "_entity._id");

    const bundle = this.get_bundle(app_id, env);
    this.assert_mutable_bundle(bundle);
    const action = bundle._entities[entity_id] ? "update" : "create";

    const normalized: any = {
      ...entity,
      _id: entity_id
    };
    this.validate_entity_artifact({
      entity: normalized,
      entity_id,
    });

    bundle._entities[entity_id] = normalized;
    bundle._app._meta._version++;
    bundle._app._meta._updated_at = _xu.to_iso_now();

    this.persist_bundle(bundle);

    const sync_response = await _x.execute({
      _module: "entity-manager",
      _op: "register",
      _params: {
        _app_id: app_id,
        _env: env,
        _entity: normalized
      }
    });

    if (!sync_response?._ok) {
      throw new XError("E_XVM_ENTITY_SYNC_FAILED", "Failed to sync entity runtime schema", {
        _meta: {
          _app_id: app_id,
          _env: env,
          _entity_id: entity_id,
          _error: sync_response?._result
        }
      });
    }

    _xlog.warn("[xvm/entity-sync] entity schema synced", {
      _app_id: app_id,
      _env: env,
      _entity_id: entity_id,
      _action: action,
      _records_migrated: false
    });

    return { _ok: true, _result: { _entity_id: entity_id } };
  }

  async _delete_entity(xcmd: XCommand) {

    const params = _xu.ensure_params(xcmd?._params);

    const app_id =
      _xu.ensure_string(params._app_id, "_app_id");

    const env = this.resolve_env(params);

    const entity_id =
      _xu.ensure_string(
        params._entity_id,
        "_entity_id"
      );

    const bundle =
      this.get_bundle(app_id, env);
    this.assert_mutable_bundle(bundle);

    const remaining_entity_ids =
      new Set(Object.keys(bundle._entities || {}).filter((id) => id !== entity_id));
    const flow_ids =
      new Set(Object.keys(bundle._flows || {}));
    for (const view_id of Object.keys(bundle._views || {})) {
      this.validate_view_artifact({
        view: bundle._views[view_id],
        view_id,
        app_id,
        env,
        available_view_ids: new Set(Object.keys(bundle._views || {})),
        available_entity_ids: remaining_entity_ids,
        available_flow_ids: flow_ids,
      });
    }
    for (const flow_id of Object.keys(bundle._flows || {})) {
      this.validate_flow_artifact({
        flow: bundle._flows[flow_id],
        flow_id,
        app_id,
        env,
        available_entity_ids: remaining_entity_ids,
        available_flow_ids: flow_ids,
      });
    }

    delete bundle._entities[entity_id];

    bundle._app._meta._version++;
    bundle._app._meta._updated_at =
      _xu.to_iso_now();

    this.persist_bundle(bundle);
    const sync_response = await _x.execute({
      _module: "entity-manager",
      _op: "unregister",
      _params: {
        _app_id: app_id,
        _env: env,
        _entity_id: entity_id
      }
    });

    if (!sync_response?._ok) {
      throw new XError("E_XVM_ENTITY_SYNC_FAILED", "Failed to unregister entity runtime schema", {
        _meta: {
          _app_id: app_id,
          _env: env,
          _entity_id: entity_id,
          _error: sync_response?._result
        }
      });
    }

    _xlog.warn("[xvm/entity-sync] entity runtime unregistered", {
      _app_id: app_id,
      _env: env,
      _entity_id: entity_id
    });

    _xlog.warn("[xvm/entity-sync] entity schema removed from runtime; records were not deleted", {
      _app_id: app_id,
      _env: env,
      _entity_id: entity_id
    });

    return {
      _ok: true,
      _result: {
        _artifact_type: "entity",
        _action: "delete",
        _entity_id: entity_id,
        _runtime_unregistered: true
      }
    };
  }

  async _list_entities(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);

    const app_id = _xu.ensure_string(params._app_id, "_app_id");
    const env = this.resolve_env(params);
    const bundle = this.get_bundle(app_id, env);

    return {
      _ok: true,
      _result: {
        _entities: Object.keys(bundle._entities || {}),
      },
    };
  }





  /* ------------------------------------------------------------------------ */
  /* SUBSCRIBE                                                                */
  /* ------------------------------------------------------------------------ */

  async _subscribe(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);

    const app_id = _xu.ensure_string(params._app_id, "_app_id");
    const env = this.resolve_env(params);

    // 🔥 FIX: read wid from transport context, not params
    const ctx = (xcmd as any)?._ctx;
    const wid = ctx?._meta?._wid;
    const sid = ctx?._sid;

    if (!wid) {
      _xlog.warn("[server-xvm] subscribe without wid (ctx)");
      return { _ok: true };
    }

    /* 🔥 Bind this connection to app/env (Wormholes-native scope) */
    wsSetScope(wid, {
      _app_id: app_id,
      _env: env,
    });

    _xlog.log("[server-xvm] subscribed", {
      _wid: wid,
      _sid: sid,
      _app_id: app_id,
      _env: env,
    });

    return { _ok: true };
  }

  private normalize_generated_operation(input: {
    operation: unknown;
    app_id: string;
    env: string;
  }): XVMGeneratedOperation {
    if (!_xu.is_plain_object(input.operation)) {
      throw new XError("E_XVM_GENERATED_OPERATION_INVALID", "Generated operation must be an object");
    }

    const operation = input.operation;
    if (operation._type !== "xvibe-generated-operation") {
      throw new XError("E_XVM_GENERATED_OPERATION_INVALID_TYPE", "Generated operation must have _type 'xvibe-generated-operation'");
    }
    if (operation._contract_version !== 1) {
      throw new XError("E_XVM_GENERATED_OPERATION_CONTRACT_VERSION", "Unsupported generated operation contract version", {
        _meta: {
          _contract_version: operation._contract_version,
          _supported_contract_version: 1,
        },
      });
    }

    const operation_id = read_non_empty_string(operation._id);
    const source_step_id = read_non_empty_string(operation._source_step_id);
    if (!operation_id || !source_step_id) {
      throw new XError("E_XVM_GENERATED_OPERATION_ID_MISSING", "Generated operation requires _id and _source_step_id");
    }

    const kind = normalize_generated_operation_kind(operation._kind);
    if (!_xu.is_plain_object(operation._target)) {
      throw new XError("E_XVM_GENERATED_OPERATION_TARGET_INVALID", "Generated operation target must be an object");
    }

    const target_app_id = read_non_empty_string(operation._target._app_id);
    const target_env = read_non_empty_string(operation._target._env);
    const target_view_id = read_non_empty_string(operation._target._view_id);
    if (!target_app_id || !target_env || !target_view_id) {
      throw new XError("E_XVM_GENERATED_OPERATION_TARGET_MISSING", "Generated operation target requires app, env, and view id");
    }
    if (target_app_id !== input.app_id || target_env !== input.env) {
      throw new XError("E_XVM_GENERATED_OPERATION_CONTEXT_MISMATCH", "Generated operation target does not match active app/env", {
        _meta: {
          _app_id: input.app_id,
          _env: input.env,
          _target_app_id: target_app_id,
          _target_env: target_env,
        },
      });
    }

    if (!_xu.is_plain_object(operation._validation)) {
      throw new XError("E_XVM_GENERATED_OPERATION_NOT_VALIDATED", "Generated operation is missing validation metadata");
    }
    const validation_state = read_non_empty_string(operation._validation._state);
    if (validation_state !== "generated" && validation_state !== "validated") {
      throw new XError("E_XVM_GENERATED_OPERATION_NOT_VALIDATED", "Generated operation validation state is not executable", {
        _meta: {
          _validation_state: validation_state ?? null,
        },
      });
    }

    if (
      !_xu.is_plain_object(operation._artifact) ||
      operation._artifact._artifact_type !== "view" ||
      operation._artifact._contract_version !== 1 ||
      !_xu.is_plain_object(operation._artifact._view)
    ) {
      throw new XError("E_XVM_GENERATED_OPERATION_ARTIFACT_INVALID", "Generated operation must contain a v1 view artifact");
    }

    const view = clone_json(operation._artifact._view) as XVMView;
    this.validate_generated_view_artifact(view, target_view_id);
    const json_issue = find_non_json_compatible_value(operation);
    if (json_issue) {
      throw new XError("E_XVM_GENERATED_OPERATION_NOT_JSON", "Generated operation must be JSON-compatible", {
        _meta: json_issue,
      });
    }

    return {
      ...clone_json(operation),
      _type: "xvibe-generated-operation",
      _contract_version: 1,
      _id: operation_id,
      _source_step_id: source_step_id,
      _kind: kind,
      _target: {
        ...clone_json(operation._target),
        _app_id: target_app_id,
        _env: target_env,
        _view_id: target_view_id,
      },
      _artifact: {
        ...clone_json(operation._artifact),
        _artifact_type: "view",
        _contract_version: 1,
        _view: view,
      },
      _validation: clone_json(operation._validation),
    };
  }

  private validate_generated_view_artifact(view: unknown, expected_view_id: string): asserts view is XVMView {
    if (!_xu.is_plain_object(view)) {
      throw new XError("E_XVM_GENERATED_OPERATION_VIEW_INVALID", "Generated view must be an object");
    }
    if (view._id !== expected_view_id) {
      throw new XError("E_XVM_GENERATED_OPERATION_VIEW_ID_MISMATCH", "Generated view id must match target view id", {
        _meta: {
          _view_id: view._id,
          _target_view_id: expected_view_id,
        },
      });
    }
    if (view._type !== "view") {
      throw new XError("E_XVM_GENERATED_OPERATION_VIEW_INVALID", "Generated view root _type must be view");
    }

    this.validate_xui_json_tree(view, "$._artifact._view");
  }

  private validate_json_artifact(value: unknown, artifact_path: string): void {
    const json_issue = find_non_json_compatible_value(value, artifact_path);
    if (json_issue) {
      throw new XError("E_XVM_ARTIFACT_NOT_JSON", "Runtime artifacts must be JSON-compatible", {
        _meta: json_issue,
      });
    }
  }

  private validate_artifact_id(input: {
    value: unknown;
    expected_id: string;
    field_path: string;
    code: string;
  }): string {
    const id = _xu.ensure_string(input.value, input.field_path);
    if (id !== input.expected_id) {
      throw new XError(input.code, "Artifact id does not match persistence key", {
        _meta: {
          _expected_id: input.expected_id,
          _actual_id: id,
          _field: input.field_path,
        },
      });
    }
    return id;
  }

  private assert_ref_exists(input: {
    kind: "entity" | "flow";
    id: string;
    path: string;
    available_ids: Set<string>;
  }): void {
    if (input.available_ids.has(input.id)) return;

    throw new XError(
      input.kind === "entity"
        ? "E_XVM_MISSING_ENTITY_REFERENCE"
        : "E_XVM_MISSING_FLOW_REFERENCE",
      `Runtime artifact references missing ${input.kind}: ${input.id}`,
      {
        _meta: {
          _ref_kind: input.kind,
          _ref_id: input.id,
          _path: input.path,
        },
      },
    );
  }

  private validate_entity_ref_value(
    value: unknown,
    path_name: string,
    available_entity_ids: Set<string>,
  ): void {
    const entity_id = read_non_empty_string(value);
    if (!entity_id) return;
    this.assert_ref_exists({
      kind: "entity",
      id: entity_id,
      path: path_name,
      available_ids: available_entity_ids,
    });
  }

  private validate_flow_ref_value(
    value: unknown,
    path_name: string,
    available_flow_ids: Set<string>,
  ): void {
    const flow_id = read_non_empty_string(value);
    if (!flow_id) return;
    this.assert_ref_exists({
      kind: "flow",
      id: flow_id,
      path: path_name,
      available_ids: available_flow_ids,
    });
  }

  private validate_reference_scope(input: {
    value: Record<string, any>;
    path: string;
    app_id: string;
    env: string;
    code: string;
    allow_dynamic?: boolean;
  }): void {
    if ("_app_id" in input.value) {
      const target_app_id = this.validate_reference_scope_target({
        value: input.value._app_id,
        path: `${input.path}._app_id`,
        current_value: input.app_id,
        current_field: "_app_id",
        target_field: "_target_app_id",
        code: input.code,
        allow_dynamic: input.allow_dynamic === true,
      });
      if (target_app_id === "dynamic") {
        // The concrete value is resolved and validated by the executing flow.
      } else if (target_app_id !== input.app_id) {
        throw new XError(input.code, "Runtime artifact reference targets an invalid app", {
          _meta: {
            _path: `${input.path}._app_id`,
            _app_id: input.app_id,
            _target_app_id: target_app_id,
          },
        });
      }
    }

    if ("_env" in input.value) {
      const target_env = this.validate_reference_scope_target({
        value: input.value._env,
        path: `${input.path}._env`,
        current_value: input.env,
        current_field: "_env",
        target_field: "_target_env",
        code: input.code,
        allow_dynamic: input.allow_dynamic === true,
      });
      if (target_env === "dynamic") {
        // The concrete value is resolved and validated by the executing flow.
      } else if (target_env !== input.env) {
        throw new XError(input.code, "Runtime artifact reference targets an invalid environment", {
          _meta: {
            _path: `${input.path}._env`,
            _env: input.env,
            _target_env: target_env,
          },
        });
      }
    }
  }

  private validate_reference_scope_target(input: {
    value: unknown;
    path: string;
    current_value: string;
    current_field: "_app_id" | "_env";
    target_field: "_target_app_id" | "_target_env";
    code: string;
    allow_dynamic: boolean;
  }): string | "dynamic" {
    const target_value = read_non_empty_string(input.value);
    if (!target_value) {
      throw new XError(input.code, "Runtime artifact reference target must be a non-empty string", {
        _meta: {
          _path: input.path,
          [input.current_field]: input.current_value,
          [input.target_field]: null,
        },
      });
    }

    if (!target_value.startsWith("$")) {
      return target_value;
    }

    if (!input.allow_dynamic) {
      throw new XError("E_XVM_DYNAMIC_REFERENCE_NOT_ALLOWED", "Dynamic reference is not allowed for this artifact field", {
        _meta: {
          _path: input.path,
          _expression: target_value,
        },
      });
    }

    const match = SERVER_FLOW_DYNAMIC_REFERENCE_PATTERN.exec(target_value);
    if (!match) {
      throw new XError("E_XVM_MALFORMED_DYNAMIC_REFERENCE", "Malformed dynamic reference expression", {
        _meta: {
          _path: input.path,
          _expression: target_value,
        },
      });
    }

    const root = match[1];
    if (!SERVER_FLOW_DYNAMIC_REFERENCE_ROOTS.has(root)) {
      throw new XError("E_XVM_UNSUPPORTED_DYNAMIC_REFERENCE", "Unsupported dynamic reference root", {
        _meta: {
          _path: input.path,
          _expression: target_value,
          _root: root,
          _supported_roots: Array.from(SERVER_FLOW_DYNAMIC_REFERENCE_ROOTS),
        },
      });
    }

    return "dynamic";
  }

  private validate_view_ref_value(input: {
    value: unknown;
    path: string;
    available_view_ids: Set<string>;
    app_id: string;
    env: string;
  }): void {
    if (!_xu.is_plain_object(input.value)) {
      throw new XError("E_XVM_INVALID_VIEW_REFERENCE", "xvm-view reference must be an object", {
        _meta: {
          _path: input.path,
        },
      });
    }

    this.validate_reference_scope({
      value: input.value,
      path: input.path,
      app_id: input.app_id,
      env: input.env,
      code: "E_XVM_INVALID_VIEW_REFERENCE_TARGET",
    });

    const view_id = read_non_empty_string(input.value._view_id);
    if (!view_id) {
      throw new XError("E_XVM_INVALID_VIEW_REFERENCE", "xvm-view requires _view_id", {
        _meta: {
          _path: `${input.path}._view_id`,
        },
      });
    }

    if (!input.available_view_ids.has(view_id)) {
      throw new XError("E_XVM_MISSING_VIEW_REFERENCE", `Runtime artifact references missing view: ${view_id}`, {
        _meta: {
          _ref_kind: "view",
          _ref_id: view_id,
          _path: `${input.path}._view_id`,
        },
      });
    }
  }

  private validate_binding_refs(
    value: unknown,
    path_name: string,
    available_entity_ids: Set<string>,
    app_id: string,
    env: string,
  ): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) =>
        this.validate_binding_refs(item, `${path_name}[${index}]`, available_entity_ids, app_id, env));
      return;
    }

    if (!_xu.is_plain_object(value)) return;

    this.validate_reference_scope({
      value,
      path: path_name,
      app_id,
      env,
      code: "E_XVM_INVALID_ENTITY_REFERENCE_TARGET",
    });

    for (const key of ["_entity", "_entity_id", "_entity_ref", "_entity_name"]) {
      if (key in value) {
        this.validate_entity_ref_value(value[key], `${path_name}.${key}`, available_entity_ids);
      }
    }

    for (const [key, child] of Object.entries(value)) {
      if (_xu.is_plain_object(child) || Array.isArray(child)) {
        this.validate_binding_refs(child, `${path_name}.${key}`, available_entity_ids, app_id, env);
      }
    }
  }

  private validate_command_refs(
    value: Record<string, any>,
    path_name: string,
    available_entity_ids: Set<string>,
    available_flow_ids: Set<string>,
    app_id: string,
    env: string,
    allow_dynamic_scope: boolean,
  ): void {
    const module_name = read_non_empty_string(value._module);
    if (
      _xu.is_plain_object(value._params) &&
      this.should_validate_server_command_scope(module_name)
    ) {
      this.validate_reference_scope({
        value: value._params,
        path: `${path_name}._params`,
        app_id,
        env,
        code: "E_XVM_INVALID_ACTION_REFERENCE_TARGET",
        allow_dynamic: allow_dynamic_scope,
      });
    }

    if (module_name === "flow" && _xu.is_plain_object(value._params)) {
      this.validate_flow_ref_value(
        value._params._flow_id,
        `${path_name}._params._flow_id`,
        available_flow_ids,
      );
    }

    if (module_name === "entity-manager" && _xu.is_plain_object(value._params)) {
      const entity_ref =
        value._params._entity_id ??
        value._params._entity ??
        value._params._entity_name;
      this.validate_entity_ref_value(
        entity_ref,
        `${path_name}._params`,
        available_entity_ids,
      );
    }
  }

  private should_validate_server_command_scope(module_name: string | undefined): boolean {
    return module_name !== "xvm" &&
      module_name !== "flow-client" &&
      module_name !== "xdb-client";
  }

  private validate_flow_trigger_ref(
    value: unknown,
    path_name: string,
    available_flow_ids: Set<string>,
    app_id: string,
    env: string,
  ): void {
    if (typeof value === "string") {
      this.validate_flow_ref_value(value, path_name, available_flow_ids);
      return;
    }

    if (_xu.is_plain_object(value)) {
      this.validate_reference_scope({
        value,
        path: path_name,
        app_id,
        env,
        code: "E_XVM_INVALID_FLOW_REFERENCE_TARGET",
      });
      this.validate_flow_ref_value(value._id, `${path_name}._id`, available_flow_ids);
    }
  }

  private validate_xui_view_semantics(input: {
    view: XVMView;
    view_id: string;
    app_id: string;
    env: string;
    available_view_ids: Set<string>;
    available_entity_ids: Set<string>;
    available_flow_ids: Set<string>;
  }): void {
    const object_ids = new Map<string, string>();
    const semantic_ids = new Map<string, string>();

    const visit = (value: unknown, path_name: string): void => {
      if (Array.isArray(value)) {
        value.forEach((child, index) => visit(child, `${path_name}[${index}]`));
        return;
      }

      if (!_xu.is_plain_object(value)) return;

      const is_xui_object = read_non_empty_string(value._type) !== undefined;
      if (is_xui_object) {
        if (value._type === "xvm-view") {
          this.validate_view_ref_value({
            value,
            path: path_name,
            available_view_ids: input.available_view_ids,
            app_id: input.app_id,
            env: input.env,
          });
        }

        const object_id = read_non_empty_string(value._id);
        if (object_id) {
          const previous_path = object_ids.get(object_id);
          if (previous_path) {
            throw new XError("E_XVM_DUPLICATE_OBJECT_ID", "View contains duplicate object _id values", {
              _meta: {
                _view_id: input.view_id,
                _id: object_id,
                _first_path: previous_path,
                _duplicate_path: `${path_name}._id`,
              },
            });
          }
          object_ids.set(object_id, `${path_name}._id`);
        }

        const semantic_id = read_non_empty_string(value._semantic_id);
        if (semantic_id) {
          const previous_path = semantic_ids.get(semantic_id);
          if (previous_path) {
            throw new XError("E_XVM_DUPLICATE_SEMANTIC_ID", "View contains duplicate semantic ids", {
              _meta: {
                _view_id: input.view_id,
                _semantic_id: semantic_id,
                _first_path: previous_path,
                _duplicate_path: `${path_name}._semantic_id`,
              },
            });
          }
          semantic_ids.set(semantic_id, `${path_name}._semantic_id`);
        }

        for (const key of ["_entity", "_entity_id", "_entity_ref", "_entity_name"]) {
          if (key in value) {
            this.validate_reference_scope({
              value,
              path: path_name,
              app_id: input.app_id,
              env: input.env,
              code: "E_XVM_INVALID_ENTITY_REFERENCE_TARGET",
            });
            this.validate_entity_ref_value(
              value[key],
              `${path_name}.${key}`,
              input.available_entity_ids,
            );
          }
        }

        if ("_flow" in value) {
          this.validate_flow_trigger_ref(
            value._flow,
            `${path_name}._flow`,
            input.available_flow_ids,
            input.app_id,
            input.env,
          );
        }
        if ("_flow_id" in value) {
          this.validate_reference_scope({
            value,
            path: path_name,
            app_id: input.app_id,
            env: input.env,
            code: "E_XVM_INVALID_FLOW_REFERENCE_TARGET",
          });
          this.validate_flow_ref_value(
            value._flow_id,
            `${path_name}._flow_id`,
            input.available_flow_ids,
          );
        }
      }

      this.validate_command_refs(
        value,
        path_name,
        input.available_entity_ids,
        input.available_flow_ids,
        input.app_id,
        input.env,
        false,
      );

      for (const key of ["_data_source", "_binding", "_bindings", "_data_binding", "_data_bindings"]) {
        if (key in value) {
          this.validate_binding_refs(
            value[key],
            `${path_name}.${key}`,
            input.available_entity_ids,
            input.app_id,
            input.env,
          );
        }
      }

      for (const [key, child] of Object.entries(value)) {
        if (_xu.is_plain_object(child) || Array.isArray(child)) {
          visit(child, `${path_name}.${key}`);
        }
      }
    };

    visit(input.view, "$");
  }

  private validate_view_artifact(input: {
    view: unknown;
    view_id: string;
    app_id: string;
    env: string;
    available_view_ids: Set<string>;
    available_entity_ids: Set<string>;
    available_flow_ids: Set<string>;
    path?: string;
  }): asserts input is {
    view: XVMView;
    view_id: string;
    app_id: string;
    env: string;
    available_view_ids: Set<string>;
    available_entity_ids: Set<string>;
    available_flow_ids: Set<string>;
    path?: string;
  } {
    const artifact_path = input.path ?? "$._view";
    this.validate_json_artifact(input.view, artifact_path);

    if (!_xu.is_plain_object(input.view)) {
      throw new XError("E_XVM_INVALID_VIEW", "View artifact must be an object", {
        _meta: { _path: artifact_path },
      });
    }

    this.validate_artifact_id({
      value: input.view._id,
      expected_id: input.view_id,
      field_path: `${artifact_path}._id`,
      code: "E_XVM_VIEW_ID_MISMATCH",
    });

    if (input.view._type !== "view") {
      throw new XError("E_XVM_INVALID_VIEW", "View root _type must be view", {
        _meta: {
          _view_id: input.view_id,
          _path: `${artifact_path}._type`,
        },
      });
    }

    this.validate_xui_json_tree(input.view, artifact_path);
    this.validate_xui_view_semantics({
      view: input.view as XVMView,
      view_id: input.view_id,
      app_id: input.app_id,
      env: input.env,
      available_view_ids: input.available_view_ids,
      available_entity_ids: input.available_entity_ids,
      available_flow_ids: input.available_flow_ids,
    });
  }

  private validate_flow_artifact(input: {
    flow: unknown;
    flow_id: string;
    app_id: string;
    env: string;
    available_entity_ids: Set<string>;
    available_flow_ids: Set<string>;
    path?: string;
  }): asserts input is {
    flow: XVMFlow;
    flow_id: string;
    app_id: string;
    env: string;
    available_entity_ids: Set<string>;
    available_flow_ids: Set<string>;
    path?: string;
  } {
    const artifact_path = input.path ?? "$._flow";
    this.validate_json_artifact(input.flow, artifact_path);

    if (!_xu.is_plain_object(input.flow)) {
      throw new XError("E_XVM_INVALID_FLOW", "Flow artifact must be an object", {
        _meta: { _path: artifact_path },
      });
    }

    this.validate_artifact_id({
      value: input.flow._id,
      expected_id: input.flow_id,
      field_path: `${artifact_path}._id`,
      code: "E_XVM_FLOW_ID_MISMATCH",
    });

    if (!Array.isArray(input.flow._steps)) {
      throw new XError("E_XVM_INVALID_FLOW", "Flow artifact requires _steps array", {
        _meta: {
          _flow_id: input.flow_id,
          _path: `${artifact_path}._steps`,
        },
      });
    }

    const step_ids = new Map<string, string>();
    const semantic_ids = new Map<string, string>();

    input.flow._steps.forEach((step: unknown, index: number) => {
      const step_path = `${artifact_path}._steps[${index}]`;
      if (!_xu.is_plain_object(step)) {
        throw new XError("E_XVM_INVALID_FLOW", "Flow step must be an object", {
          _meta: {
            _flow_id: input.flow_id,
            _path: step_path,
          },
        });
      }

      const step_id = read_non_empty_string(step._id);
      if (step_id) {
        const previous_path = step_ids.get(step_id);
        if (previous_path) {
          throw new XError("E_XVM_DUPLICATE_FLOW_STEP_ID", "Flow contains duplicate step ids", {
            _meta: {
              _flow_id: input.flow_id,
              _id: step_id,
              _first_path: previous_path,
              _duplicate_path: `${step_path}._id`,
            },
          });
        }
        step_ids.set(step_id, `${step_path}._id`);
      }

      const semantic_id = read_non_empty_string(step._semantic_id);
      if (semantic_id) {
        const previous_path = semantic_ids.get(semantic_id);
        if (previous_path) {
          throw new XError("E_XVM_DUPLICATE_SEMANTIC_ID", "Flow contains duplicate semantic ids", {
            _meta: {
              _flow_id: input.flow_id,
              _semantic_id: semantic_id,
              _first_path: previous_path,
              _duplicate_path: `${step_path}._semantic_id`,
            },
          });
        }
        semantic_ids.set(semantic_id, `${step_path}._semantic_id`);
      }

      if (!_xu.is_plain_object(step._command)) {
        throw new XError("E_XVM_INVALID_FLOW", "Flow step requires _command object", {
          _meta: {
            _flow_id: input.flow_id,
            _path: `${step_path}._command`,
          },
        });
      }

      _xu.ensure_string(step._command._module, `${step_path}._command._module`);
      _xu.ensure_string(step._command._op, `${step_path}._command._op`);
      if (step._command._params !== undefined && !_xu.is_plain_object(step._command._params)) {
        throw new XError("E_XVM_INVALID_FLOW", "Flow step _command._params must be an object", {
          _meta: {
            _flow_id: input.flow_id,
            _path: `${step_path}._command._params`,
          },
        });
      }

      this.validate_command_refs(
        step._command,
        `${step_path}._command`,
        input.available_entity_ids,
        input.available_flow_ids,
        input.app_id,
        input.env,
        true,
      );
    });
  }

  private validate_entity_artifact(input: {
    entity: unknown;
    entity_id: string;
    path?: string;
  }): asserts input is { entity: Record<string, any>; entity_id: string; path?: string } {
    const artifact_path = input.path ?? "$._entity";
    this.validate_json_artifact(input.entity, artifact_path);

    if (!_xu.is_plain_object(input.entity)) {
      throw new XError("E_XVM_INVALID_ENTITY", "Entity artifact must be an object", {
        _meta: { _path: artifact_path },
      });
    }

    this.validate_artifact_id({
      value: input.entity._id,
      expected_id: input.entity_id,
      field_path: `${artifact_path}._id`,
      code: "E_XVM_ENTITY_ID_MISMATCH",
    });
  }

  private validate_bundle_runtime_contract(bundle: XVMAppBundle): void {
    this.validate_json_artifact(bundle._app, "$._app");

    const entity_ids = new Set(Object.keys(bundle._entities || {}));
    const flow_ids = new Set(Object.keys(bundle._flows || {}));

    for (const entity_id of Object.keys(bundle._entities || {})) {
      this.validate_entity_artifact({
        entity: bundle._entities[entity_id],
        entity_id,
        path: `$._entities.${entity_id}`,
      });
    }

    for (const flow_id of Object.keys(bundle._flows || {})) {
      this.validate_flow_artifact({
        flow: bundle._flows[flow_id],
        flow_id,
        app_id: bundle._app._app_id,
        env: bundle._app._env,
        available_entity_ids: entity_ids,
        available_flow_ids: flow_ids,
        path: `$._flows.${flow_id}`,
      });
    }

    for (const view_id of Object.keys(bundle._views || {})) {
      this.validate_view_artifact({
        view: bundle._views[view_id],
        view_id,
        app_id: bundle._app._app_id,
        env: bundle._app._env,
        available_view_ids: new Set(Object.keys(bundle._views || {})),
        available_entity_ids: entity_ids,
        available_flow_ids: flow_ids,
        path: `$._views.${view_id}`,
      });
    }
  }

  private validate_xui_json_tree(value: unknown, path_name: string): void {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        this.validate_xui_json_tree(value[index], `${path_name}[${index}]`);
      }
      return;
    }

    if (!_xu.is_plain_object(value)) {
      return;
    }

    if ("_type" in value && read_non_empty_string(value._type) === undefined) {
      throw new XError("E_XVM_GENERATED_OPERATION_XUI_INVALID", "XUI object _type must be a non-empty string", {
        _meta: { _path: `${path_name}._type` },
      });
    }
    if ("_children" in value && !Array.isArray(value._children)) {
      throw new XError("E_XVM_GENERATED_OPERATION_XUI_INVALID", "XUI object _children must be an array", {
        _meta: { _path: `${path_name}._children` },
      });
    }
    if (Array.isArray(value._children)) {
      value._children.forEach((child: unknown, index: number) => {
        if (!_xu.is_plain_object(child)) {
          throw new XError("E_XVM_GENERATED_OPERATION_XUI_INVALID", "XUI _children entries must be objects", {
            _meta: { _path: `${path_name}._children[${index}]` },
          });
        }
      });
    }

    for (const [key, child] of Object.entries(value)) {
      if (_xu.is_plain_object(child) || Array.isArray(child)) {
        this.validate_xui_json_tree(child, `${path_name}.${key}`);
      }
    }
  }

  private assert_generated_operation_current_context(input: {
    operation: XVMGeneratedOperation;
    bundle: XVMAppBundle;
  }): void {
    const operation = input.operation;
    const view_id = operation._target._view_id;
    const current_view = input.bundle._views[view_id];
    const precondition =
      _xu.is_plain_object(operation._precondition)
        ? operation._precondition
        : _xu.is_plain_object(operation._context)
          ? operation._context
          : {};

    if (operation._kind === "view.replace" && !current_view) {
      throw new XError("E_XVM_CHANGE_PLAN_STALE_CONTEXT", "Generated operation target view no longer exists", {
        _meta: {
          _operation_id: operation._id,
          _view_id: view_id,
          _reason: "target_missing",
        },
      });
    }

    if (operation._kind === "view.create" && current_view) {
      const generated_view = operation._artifact._view;
      if (JSON.stringify(current_view) === JSON.stringify(generated_view)) {
        return;
      }
      throw new XError("E_XVM_GENERATED_OPERATION_DUPLICATE_ARTIFACT", "Generated operation would duplicate an existing view", {
        _meta: {
          _operation_id: operation._id,
          _view_id: view_id,
        },
      });
    }

    const expected_app_version =
      typeof precondition._app_version === "number"
        ? precondition._app_version
        : typeof precondition._target_version === "number"
          ? precondition._target_version
          : undefined;
    if (
      expected_app_version !== undefined &&
      input.bundle._app._meta._version !== expected_app_version
    ) {
      throw new XError("E_XVM_CHANGE_PLAN_STALE_CONTEXT", "Generated operation app version precondition failed", {
        _meta: {
          _operation_id: operation._id,
          _expected_app_version: expected_app_version,
          _actual_app_version: input.bundle._app._meta._version,
        },
      });
    }

    const expected_hash =
      read_non_empty_string(precondition._target_hash) ??
      read_non_empty_string(precondition._view_hash) ??
      read_non_empty_string(precondition._existing_view_hash);
    if (expected_hash && current_view) {
      const actual_hash = stable_json_hash(current_view);
      if (actual_hash !== expected_hash) {
        throw new XError("E_XVM_CHANGE_PLAN_STALE_CONTEXT", "Generated operation target hash precondition failed", {
          _meta: {
            _operation_id: operation._id,
            _view_id: view_id,
            _expected_hash: expected_hash,
            _actual_hash: actual_hash,
          },
        });
      }
    }
  }

  private generated_operation_sets_default_view(operation: XVMGeneratedOperation, params: Record<string, any>): boolean {
    return operation._set_default_view === true ||
      operation._update_default_view === true ||
      params._set_default_view === true ||
      read_non_empty_string(params._set_default_view_id) === operation._target._view_id;
  }

  private apply_default_view_request(input: {
    bundle: XVMAppBundle;
    view_id: string;
  }): void {
    input.bundle._app._meta = {
      ...input.bundle._app._meta,
      _entry_view_id: input.view_id,
    };
    const config = _xu.is_plain_object(input.bundle._app._config)
      ? input.bundle._app._config
      : {};
    const start = _xu.is_plain_object(config._start)
      ? config._start
      : {};
    input.bundle._app._config = {
      ...config,
      _start: {
        ...start,
        _view_id: input.view_id,
      },
    };
  }

  private app_runtime_assets(bundle: XVMAppBundle) {
    return {
      _views: Object.keys(bundle._views || {}).map((_id) => ({ _id })),
      _flows: Object.keys(bundle._flows || {}).map((_id) => ({ _id })),
      _entities: Object.keys(bundle._entities || {}).map((_id) => ({ _id })),
    };
  }

  private load_project_memory_for_refresh(app_id: string, env: string): XVMProjectMemory | undefined {
    try {
      const memory_path = this.get_project_memory_path(app_id, env);
      return this.normalize_project_memory(
        this.load_or_create_project_memory(app_id, env, memory_path),
        { _touch_updated_at: false },
      );
    } catch (error) {
      _xlog.warn("[server-xvm] project memory refresh failed", {
        _app_id: app_id,
        _env: env,
        _error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private record_change_plan_project_memory_success(input: {
    app_id: string;
    env: string;
    operations: unknown[];
    results: unknown[];
  }): XVMProjectMemory | undefined {
    try {
      const memory_path = this.get_project_memory_path(input.app_id, input.env);
      const current = this.normalize_project_memory(
        this.load_or_create_project_memory(input.app_id, input.env, memory_path),
        { _touch_updated_at: false },
      );
      const achievement_result =
        append_project_memory_achievement({
          _memory: current,
          _achievement_id: "first-suggested-action-applied",
        });
      log_project_memory_achievement_result({
        _app_id: input.app_id,
        _env: input.env,
        _achievement_id: "first-suggested-action-applied",
        _result: achievement_result,
      });

      const completed_refs =
        input.operations
          .reduce<Record<string, any>[]>((items, operation) => {
            if (!_xu.is_plain_object(operation)) return items;
            const generated_operation =
              operation._type === "xvibe-generated-operation"
                ? operation
                : _xu.is_plain_object(operation._operation)
                  ? operation._operation
                  : undefined;
            if (!_xu.is_plain_object(generated_operation)) return items;
            const view_id =
              _xu.is_plain_object(generated_operation._target)
                ? read_non_empty_string(generated_operation._target._view_id)
                : undefined;
            items.push({
              _type: "change-plan-operation",
              _operation_id: read_non_empty_string(generated_operation._id),
              _kind: read_non_empty_string(generated_operation._kind),
              ...(view_id ? { _view_id: view_id, _title: view_id } : {}),
              _completed_at: _xu.to_iso_now(),
            });
            return items;
          }, []);
      const execution_record = {
        _id: `change-plan-${Date.now()}`,
        _type: "change-plan-execution",
        _completed_at: _xu.to_iso_now(),
        _operations: clone_json(input.operations),
        _results: clone_json(input.results),
      };
      const previous_executions =
        Array.isArray(achievement_result._memory._change_plan_executions)
          ? achievement_result._memory._change_plan_executions
          : [];
      const milestone_result =
        completed_refs.reduce((memory, completed_ref) => {
          const completed = Array.isArray(memory._completed) ? memory._completed : [];
          const with_completed = {
            ...memory,
            _completed: [...completed, completed_ref],
          };
          const completion =
            complete_project_memory_focus_milestone_item({
              _memory: with_completed,
              _item_id: read_non_empty_string(completed_ref._view_id),
              _item_title: read_non_empty_string(completed_ref._title),
            });
          return completion._memory;
        }, achievement_result._memory);
      const memory = apply_project_memory_milestones(
        this.normalize_project_memory({
          ...milestone_result,
          _last_change_plan_execution: execution_record,
          _change_plan_executions: [
            ...previous_executions.slice(-19),
            execution_record,
          ],
        })
      ) as XVMProjectMemory;

      this.save_project_memory_file(input.app_id, input.env, memory_path, memory);
      return memory;
    } catch (error) {
      _xlog.warn("[server-xvm] change plan project memory refresh failed", {
        _app_id: input.app_id,
        _env: input.env,
        _error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private refreshed_change_plan_state(app_id: string, env: string) {
    const bundle = this.get_bundle(app_id, env);
    const memory = this.load_project_memory_for_refresh(app_id, env);
    return {
      _app: clone_json(bundle._app),
      _view_ids: Object.keys(bundle._views || {}),
      _flow_ids: Object.keys(bundle._flows || {}),
      _entity_ids: Object.keys(bundle._entities || {}),
      _views: clone_json(bundle._views || {}),
      _flows: clone_json(bundle._flows || {}),
      _entities: clone_json(bundle._entities || {}),
      _runtime_assets: this.app_runtime_assets(bundle),
      ...(memory ? { _project_memory: memory } : {}),
      _default_view_id: bundle._app._meta._entry_view_id,
    };
  }

  private snapshot_bundle(app_id: string, env: string): XVMAppBundle {
    return clone_json(this.get_bundle(app_id, env));
  }

  private restore_bundle_snapshot(snapshot: XVMAppBundle): void {
    this._apps.set(
      app_scope_key(snapshot._app._app_id, snapshot._app._env),
      clone_json(snapshot),
    );
    this.persist_bundle(this.get_bundle(snapshot._app._app_id, snapshot._app._env));
  }

  private async apply_generated_operation_internal(input: {
    params: Record<string, any>;
    defer_project_memory_refresh?: boolean;
  }) {
    const app_id = _xu.ensure_string(input.params._app_id, "_app_id");
    const env = this.resolve_env(input.params);
    const operation =
      this.normalize_generated_operation({
        operation: input.params._operation,
        app_id,
        env,
      });
    const view_id = operation._target._view_id;
    const bundle = this.get_bundle(app_id, env);
    this.assert_mutable_bundle(bundle);
    this.assert_generated_operation_current_context({
      operation,
      bundle,
    });

    const current_view = bundle._views[view_id];
    const next_view = clone_json(operation._artifact._view);
    if (current_view && JSON.stringify(current_view) === JSON.stringify(next_view)) {
      const memory =
        input.defer_project_memory_refresh
          ? undefined
          : this.record_change_plan_project_memory_success({
            app_id,
            env,
            operations: [operation],
            results: [{
              _operation_id: operation._id,
              _kind: operation._kind,
              _view_id: view_id,
              _already_completed: true,
            }],
          });
      return {
        _ok: true,
        _result: {
          _operation: operation,
          _operation_id: operation._id,
          _kind: operation._kind,
          _view_id: view_id,
          _already_completed: true,
          _changed: false,
          _refresh: this.refreshed_change_plan_state(app_id, env),
          ...(memory ? { _project_memory: memory } : {}),
        },
      };
    }

    const snapshot =
      this.snapshot_bundle(app_id, env);
    try {
      if (this.generated_operation_sets_default_view(operation, input.params)) {
        this.apply_default_view_request({
          bundle,
          view_id,
        });
      }

      const persist_result =
        await this._push_update({
          _params: {
            _app_id: app_id,
            _env: env,
            _view: next_view,
            ...(read_non_empty_string(input.params._generation_id)
              ? { _generation_id: read_non_empty_string(input.params._generation_id) }
              : {}),
          },
        } as unknown as XCommand);
      if (_xu.is_plain_object(persist_result) && persist_result._ok === false) {
        throw new XError("E_XVM_GENERATED_OPERATION_PERSIST_FAILED", "Generated operation persistence failed", {
          _meta: { _result: persist_result },
        });
      }

      const memory =
        input.defer_project_memory_refresh
          ? undefined
          : this.record_change_plan_project_memory_success({
            app_id,
            env,
            operations: [operation],
            results: [persist_result],
          });

      return {
        _ok: true,
        _result: {
          _operation: operation,
          _operation_id: operation._id,
          _kind: operation._kind,
          _view_id: view_id,
          _changed: true,
          _persist_result: persist_result,
          _refresh: this.refreshed_change_plan_state(app_id, env),
          ...(memory ? { _project_memory: memory } : {}),
        },
      };
    } catch (error) {
      this.restore_bundle_snapshot(snapshot);
      throw error;
    }
  }

  async _apply_generated_operation(xcmd: XCommand) {
    try {
      return await this.apply_generated_operation_internal({
        params: _xu.ensure_params(xcmd?._params),
      });
    } catch (error) {
      return xvm_error_from_unknown(
        error,
        "E_XVM_GENERATED_OPERATION_FAILED",
      );
    }
  }

  private normalize_change_plan_operations(value: unknown): XVMChangePlanOperation[] {
    if (!Array.isArray(value) || value.length === 0) {
      throw new XError("E_XVM_CHANGE_PLAN_EMPTY", "Change Plan operations must be a non-empty array");
    }

    return value.map((raw_operation, index) => {
      if (!_xu.is_plain_object(raw_operation)) {
        throw new XError("E_XVM_CHANGE_PLAN_INVALID_OPERATION", `Change Plan operation ${index} is invalid`);
      }

      if (raw_operation._type === "xvibe-generated-operation") {
        return {
          _type: "generated",
          _id: read_non_empty_string(raw_operation._id),
          _operation: raw_operation as XVMGeneratedOperation,
        };
      }

      if (_xu.is_plain_object(raw_operation._operation)) {
        return {
          _type: "generated",
          _id: read_non_empty_string(raw_operation._id),
          _operation: raw_operation._operation as XVMGeneratedOperation,
        };
      }

      const primitive =
        _xu.is_plain_object(raw_operation._primitive)
          ? raw_operation._primitive
          : raw_operation;
      if (!_xu.is_plain_object(primitive)) {
        throw new XError("E_XVM_CHANGE_PLAN_INVALID_OPERATION", `Change Plan operation ${index} is missing a primitive`);
      }

      const module_name = read_non_empty_string(primitive._module);
      const op_name = read_non_empty_string(primitive._op);
      if (module_name !== "xvibe" || op_name !== "apply-view-edit") {
        throw new XError("E_XVM_CHANGE_PLAN_UNSUPPORTED_PRIMITIVE", "Change Plan deterministic primitive is not allowed", {
          _meta: {
            _index: index,
            _module: module_name,
            _op: op_name,
          },
        });
      }

      return {
        _type: "deterministic",
        _id: read_non_empty_string(raw_operation._id),
        _primitive: {
          _module: module_name,
          _op: op_name,
          _params: _xu.is_plain_object(primitive._params)
            ? clone_json(primitive._params)
            : {},
        },
      };
    });
  }

  private sorted_change_plan_operations(operations: XVMChangePlanOperation[]): XVMChangePlanOperation[] {
    return [
      ...operations.filter((operation) => operation._type === "deterministic"),
      ...operations.filter((operation) => operation._type === "generated"),
    ];
  }

  private find_view_object_by_id(value: unknown, object_id: string): Record<string, any> | undefined {
    if (!value || typeof value !== "object") return undefined;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.find_view_object_by_id(item, object_id);
        if (found) return found;
      }
      return undefined;
    }

    const object = value as Record<string, any>;
    if (object._id === object_id) return object;
    for (const child of Object.values(object)) {
      const found = this.find_view_object_by_id(child, object_id);
      if (found) return found;
    }
    return undefined;
  }

  private deterministic_visibility_property_name(params: Record<string, any>): string | undefined {
    return read_non_empty_string(params._property_name) ??
      read_non_empty_string(params._property) ??
      read_non_empty_string(params.property_name) ??
      read_non_empty_string(params.property);
  }

  private deterministic_visibility_property_value(params: Record<string, any>): boolean | undefined {
    return typeof params._property_value === "boolean"
      ? params._property_value
      : typeof params.property_value === "boolean"
        ? params.property_value
        : typeof params._value === "boolean"
          ? params._value
          : typeof params.value === "boolean"
            ? params.value
            : undefined;
  }

  private deterministic_view_precondition(params: Record<string, any>): Record<string, any> {
    return _xu.is_plain_object(params._precondition)
      ? params._precondition
      : _xu.is_plain_object(params._context)
        ? params._context
        : {};
  }

  private assert_deterministic_view_context_current(input: {
    operation_id: string;
    bundle: XVMAppBundle;
    view_id: string;
    params: Record<string, any>;
  }): void {
    const precondition = this.deterministic_view_precondition(input.params);
    const expected_app_version =
      typeof input.params._app_version === "number"
        ? input.params._app_version
        : typeof input.params._target_version === "number"
          ? input.params._target_version
          : typeof precondition._app_version === "number"
            ? precondition._app_version
            : typeof precondition._target_version === "number"
              ? precondition._target_version
              : undefined;
    if (
      expected_app_version !== undefined &&
      input.bundle._app._meta._version !== expected_app_version
    ) {
      throw new XError("E_XVM_CHANGE_PLAN_STALE_CONTEXT", "Deterministic operation app version precondition failed", {
        _meta: {
          _operation_id: input.operation_id,
          _expected_app_version: expected_app_version,
          _actual_app_version: input.bundle._app._meta._version,
        },
      });
    }

    const expected_hash =
      read_non_empty_string(input.params._target_hash) ??
      read_non_empty_string(input.params._view_hash) ??
      read_non_empty_string(input.params._existing_view_hash) ??
      read_non_empty_string(precondition._target_hash) ??
      read_non_empty_string(precondition._view_hash) ??
      read_non_empty_string(precondition._existing_view_hash);
    if (expected_hash) {
      const current_view = input.bundle._views[input.view_id];
      const actual_hash = stable_json_hash(current_view);
      if (actual_hash !== expected_hash) {
        throw new XError("E_XVM_CHANGE_PLAN_STALE_CONTEXT", "Deterministic operation target hash precondition failed", {
          _meta: {
            _operation_id: input.operation_id,
            _view_id: input.view_id,
            _expected_hash: expected_hash,
            _actual_hash: actual_hash,
          },
        });
      }
    }
  }

  private preflight_deterministic_view_edit(input: {
    app_id: string;
    env: string;
    index: number;
    operation: Extract<XVMChangePlanOperation, { _type: "deterministic" }>;
  }): XVMDeterministicViewEditPreflight {
    const params = input.operation._primitive._params ?? {};
    const operation_id = input.operation._id ?? `deterministic-${input.index + 1}`;
    const primitive_app_id = read_non_empty_string(params._app_id);
    const primitive_env = read_non_empty_string(params._env);
    if (primitive_app_id && primitive_app_id !== input.app_id) {
      throw new XError("E_XVM_CHANGE_PLAN_CONTEXT_MISMATCH", "Deterministic operation app context does not match active app", {
        _meta: {
          _operation_id: operation_id,
          _app_id: input.app_id,
          _primitive_app_id: primitive_app_id,
        },
      });
    }
    if (primitive_env && primitive_env !== input.env) {
      throw new XError("E_XVM_CHANGE_PLAN_CONTEXT_MISMATCH", "Deterministic operation environment does not match active environment", {
        _meta: {
          _operation_id: operation_id,
          _env: input.env,
          _primitive_env: primitive_env,
        },
      });
    }

    const view_id = read_non_empty_string(params._view_id);
    if (!view_id) {
      throw new XError("E_XVM_CHANGE_PLAN_VIEW_MISSING", "Deterministic operation requires _view_id", {
        _meta: {
          _operation_id: operation_id,
        },
      });
    }

    const bundle = this.get_bundle(input.app_id, input.env);
    this.assert_mutable_bundle(bundle);
    const current_view = bundle._views[view_id];
    if (!current_view) {
      throw new XError("E_XVM_CHANGE_PLAN_VIEW_NOT_FOUND", "Deterministic operation target view does not exist", {
        _meta: {
          _operation_id: operation_id,
          _view_id: view_id,
        },
      });
    }
    this.assert_deterministic_view_context_current({
      operation_id,
      bundle,
      view_id,
      params,
    });

    const edit_action = read_non_empty_string(params._edit_action);
    if (!edit_action) {
      throw new XError("E_XVM_CHANGE_PLAN_EDIT_ACTION_MISSING", "Deterministic operation requires _edit_action", {
        _meta: {
          _operation_id: operation_id,
          _view_id: view_id,
        },
      });
    }

    const is_visibility_action =
      edit_action === "hide-object" ||
      edit_action === "show-object" ||
      edit_action === "set-property" ||
      edit_action === "update-property";
    if (!is_visibility_action) {
      return {
        _view_id: view_id,
        _edit_action: edit_action,
      };
    }

    const property_name = this.deterministic_visibility_property_name(params);
    if (
      (edit_action === "set-property" || edit_action === "update-property") &&
      property_name !== XVM_VISIBILITY_PROPERTY
    ) {
      throw new XError("E_XVM_CHANGE_PLAN_INVALID_PROPERTY", "Deterministic visibility operation requested an invalid property", {
        _meta: {
          _operation_id: operation_id,
          _view_id: view_id,
          _property_name: property_name ?? null,
          _allowed_properties: [XVM_VISIBILITY_PROPERTY],
        },
      });
    }
    if (
      (edit_action === "hide-object" || edit_action === "show-object") &&
      property_name !== undefined &&
      property_name !== XVM_VISIBILITY_PROPERTY
    ) {
      throw new XError("E_XVM_CHANGE_PLAN_INVALID_PROPERTY", "Deterministic visibility operation requested an invalid property", {
        _meta: {
          _operation_id: operation_id,
          _view_id: view_id,
          _property_name: property_name,
          _allowed_properties: [XVM_VISIBILITY_PROPERTY],
        },
      });
    }

    const target_id = read_non_empty_string(params._target_id);
    if (!target_id) {
      throw new XError("E_XVM_CHANGE_PLAN_TARGET_MISSING", "Deterministic visibility operation requires _target_id", {
        _meta: {
          _operation_id: operation_id,
          _view_id: view_id,
        },
      });
    }
    const target = this.find_view_object_by_id(current_view, target_id);
    if (!target) {
      throw new XError("E_XVM_CHANGE_PLAN_TARGET_OBJECT_NOT_FOUND", "Deterministic visibility target object does not exist", {
        _meta: {
          _operation_id: operation_id,
          _view_id: view_id,
          _target_id: target_id,
        },
      });
    }

    const requested_visible =
      edit_action === "hide-object"
        ? false
        : edit_action === "show-object"
          ? true
          : this.deterministic_visibility_property_value(params);
    if (
      (edit_action === "set-property" || edit_action === "update-property") &&
      typeof requested_visible !== "boolean"
    ) {
      throw new XError("E_XVM_CHANGE_PLAN_INVALID_PROPERTY", "Deterministic visibility property update requires a boolean value", {
        _meta: {
          _operation_id: operation_id,
          _view_id: view_id,
          _target_id: target_id,
          _property_name: XVM_VISIBILITY_PROPERTY,
        },
      });
    }

    if (requested_visible === false && target[XVM_VISIBILITY_PROPERTY] === false) {
      return {
        _view_id: view_id,
        _edit_action: edit_action,
        _target_id: target_id,
        _idempotent_result: {
          _ok: true,
          _artifact_type: "view",
          _artifact_id: view_id,
          _view_id: view_id,
          _deterministic: true,
          _edit_action: edit_action,
          _mutation_action: edit_action,
          _target_id: target_id,
          _property_name: XVM_VISIBILITY_PROPERTY,
          _already_hidden: true,
          _already_completed: true,
          _changed: false,
        },
      };
    }

    if (requested_visible === true && target[XVM_VISIBILITY_PROPERTY] === true) {
      return {
        _view_id: view_id,
        _edit_action: edit_action,
        _target_id: target_id,
        _idempotent_result: {
          _ok: true,
          _artifact_type: "view",
          _artifact_id: view_id,
          _view_id: view_id,
          _deterministic: true,
          _edit_action: edit_action,
          _mutation_action: edit_action,
          _target_id: target_id,
          _property_name: XVM_VISIBILITY_PROPERTY,
          _already_visible: true,
          _already_completed: true,
          _changed: false,
        },
      };
    }

    return {
      _view_id: view_id,
      _edit_action: edit_action,
      _target_id: target_id,
    };
  }

  private deterministic_view_edit_status(input: {
    preflight: XVMDeterministicViewEditPreflight;
    result: unknown;
  }): string {
    if (input.preflight._idempotent_result?._already_hidden === true) return "already_hidden";
    if (input.preflight._idempotent_result?._already_visible === true) return "already_visible";
    if (_xu.is_plain_object(input.result) && input.result._ok === false) {
      return "failed";
    }
    if (
      input.preflight._edit_action === "hide-object" ||
      input.preflight._edit_action === "show-object" ||
      input.preflight._edit_action === "set-property" ||
      input.preflight._edit_action === "update-property"
    ) {
      return "updated";
    }
    return "executed";
  }

  async _apply_change_plan_operations(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);
    const app_id = _xu.ensure_string(params._app_id, "_app_id");
    const env = this.resolve_env(params);
    const snapshot = this.snapshot_bundle(app_id, env);
    const memory_path = this.get_project_memory_path(app_id, env);
    const memory_snapshot =
      fs.existsSync(memory_path)
        ? fs.readFileSync(memory_path, "utf-8")
        : undefined;

    let ordered_operations: XVMChangePlanOperation[];
    try {
      ordered_operations =
        this.sorted_change_plan_operations(
          this.normalize_change_plan_operations(params._operations),
        );

      for (const operation of ordered_operations) {
        if (operation._type !== "generated") continue;
        operation._operation = this.normalize_generated_operation({
          operation: operation._operation,
          app_id,
          env,
        });
      }

      const results: unknown[] = [];
      for (const [index, operation] of ordered_operations.entries()) {
        if (operation._type === "deterministic") {
          const preflight =
            this.preflight_deterministic_view_edit({
              app_id,
              env,
              index,
              operation,
            });
          if (preflight._idempotent_result) {
            results.push({
              _index: index,
              _type: "deterministic",
              _operation_id: operation._id ?? `deterministic-${index + 1}`,
              _view_id: preflight._view_id,
              ...(preflight._target_id ? { _target_id: preflight._target_id } : {}),
              ...(preflight._edit_action ? { _edit_action: preflight._edit_action } : {}),
              _status: this.deterministic_view_edit_status({
                preflight,
                result: preflight._idempotent_result,
              }),
              _result: preflight._idempotent_result,
            });
            continue;
          }

          const result = await _x.execute({
            _module: operation._primitive._module,
            _op: operation._primitive._op,
            _params: {
              ...(operation._primitive._params ?? {}),
              _app_id: app_id,
              _env: env,
            },
          } as any);
          results.push({
            _index: index,
            _type: "deterministic",
            _operation_id: operation._id ?? `deterministic-${index + 1}`,
            _view_id: preflight._view_id,
            ...(preflight._target_id ? { _target_id: preflight._target_id } : {}),
            ...(preflight._edit_action ? { _edit_action: preflight._edit_action } : {}),
            _status: this.deterministic_view_edit_status({
              preflight,
              result,
            }),
            _result: result,
          });
          if (_xu.is_plain_object(result) && result._ok === false) {
            throw new XError("E_XVM_CHANGE_PLAN_STEP_FAILED", "Deterministic Change Plan operation failed", {
              _meta: {
                _index: index,
                _result: result,
              },
            });
          }
          continue;
        }

        const result =
          await this.apply_generated_operation_internal({
            params: {
              _app_id: app_id,
              _env: env,
              _operation: operation._operation,
              _set_default_view: params._set_default_view === true,
            },
            defer_project_memory_refresh: true,
          });
        results.push({
          _index: index,
          _type: "generated",
          _operation_id: operation._operation._id,
          _result: result,
        });
        if (_xu.is_plain_object(result) && result._ok === false) {
          throw new XError("E_XVM_CHANGE_PLAN_STEP_FAILED", "Generated Change Plan operation failed", {
            _meta: {
              _index: index,
              _result: result,
            },
          });
        }
      }

      const memory =
        this.record_change_plan_project_memory_success({
          app_id,
          env,
          operations: ordered_operations.map((operation) =>
            operation._type === "generated" ? operation._operation : operation
          ),
          results,
        });

      return {
        _ok: true,
        _result: {
          _app_id: app_id,
          _env: env,
          _operations: clone_json(ordered_operations),
          _results: results,
          _refresh: this.refreshed_change_plan_state(app_id, env),
          ...(memory ? { _project_memory: memory } : {}),
        },
      };
    } catch (error) {
      let rollback: Record<string, any> = {
        _attempted: true,
        _ok: false,
      };
      try {
        this.restore_bundle_snapshot(snapshot);
        if (memory_snapshot !== undefined) {
          this.write_json_file_atomic(memory_path, JSON.parse(memory_snapshot));
        } else if (fs.existsSync(memory_path)) {
          fs.unlinkSync(memory_path);
        }
        rollback = {
          _attempted: true,
          _ok: true,
        };
      } catch (rollback_error) {
        rollback = {
          _attempted: true,
          _ok: false,
          _error: rollback_error instanceof Error
            ? rollback_error.message
            : String(rollback_error),
        };
      }

      const failed =
        xvm_error_from_unknown(error, "E_XVM_CHANGE_PLAN_FAILED");
      return {
        _ok: false,
        _result: {
          ...failed._result,
          _rollback: rollback,
        },
      };
    }
  }
  /* ------------------------------------------------------------------------ */
  /* PUSH UPDATE                                                              */
  /* ------------------------------------------------------------------------ */


  async _push_update(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);

    const app_id = _xu.ensure_string(params._app_id, "_app_id");
    const env = this.resolve_env(params);

    const view_data = params._view;
    if (!_xu.is_plain_object(view_data)) throw new XError("E_XVM_INVALID_PAYLOAD", "Missing _view");

    const view_id = _xu.ensure_string(view_data._id, "_view._id");

    const bundle = this.get_bundle(app_id, env);
    this.assert_mutable_bundle(bundle);

    const normalized: XVMView = { ...view_data, _id: view_id };
    this.validate_view_artifact({
      view: normalized,
      view_id,
      app_id,
      env,
      available_view_ids: new Set([
        ...Object.keys(bundle._views || {}),
        view_id,
      ]),
      available_entity_ids: new Set(Object.keys(bundle._entities || {})),
      available_flow_ids: new Set(Object.keys(bundle._flows || {})),
    });

    /* -------------------- mutate state -------------------- */

    bundle._views[view_id] = normalized;

    bundle._app._meta._version++;
    bundle._app._meta._updated_at = _xu.to_iso_now();

    this.persist_bundle(bundle, {
      _backup_view_ids: [view_id]
    });

    /* -------------------- payload -------------------- */

    const payload = {
      _app_id: app_id,
      _env: env,
      _view_id: view_id,
      _version: bundle._app._meta._version,
      _view: normalized,
      ...(typeof params._generation_id === "string" && params._generation_id.trim()
        ? { _generation_id: params._generation_id.trim() }
        : {}),
    };

    /* -------------------- internal event -------------------- */

    _xem.fire(EVT_UPDATE, payload);

    /* -------------------- 🔥 REAL FIX: broadcast via Wormholes -------------------- */

    try {

      wsBroadcastScoped(app_id, env, {
        _name: "xvm:update",
        _args: [payload],
      });
    } catch (err) {
      _xlog.error("[server-xvm] wsSendEvt failed", err);
    }

    _xlog.log("[server-xvm] push_update + broadcast", {
      _app_id: app_id,
      _env: env,
      _view_id: view_id,
      _version: payload._version,
    });

    return {
      _ok: true,
      _result: {
        _view_id: view_id,
        _version: bundle._app._meta._version,
      },
    };
  }

  async _save_view_json(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);

    const app_id = _xu.ensure_string(params._app_id, "_app_id");
    const env = this.resolve_env(params);
    const view_id = _xu.ensure_string(params._view_id, "_view_id");
    const view = params._view;

    if (!_xu.is_plain_object(view)) {
      throw new XError("E_XVM_INVALID_PAYLOAD", "Missing _view");
    }

    if (view._type !== "view") {
      throw new XError("E_XVM_INVALID_PAYLOAD", "_view._type must be view");
    }

    const normalized: XVMView = {
      ...view,
      _id: view_id
    };
    const bundle = this.get_bundle(app_id, env);
    this.validate_view_artifact({
      view: normalized,
      view_id,
      app_id,
      env,
      available_view_ids: new Set([
        ...Object.keys(bundle._views || {}),
        view_id,
      ]),
      available_entity_ids: new Set(Object.keys(bundle._entities || {})),
      available_flow_ids: new Set(Object.keys(bundle._flows || {})),
    });

    server_xvm_verbose_log("[server-xvm] save view json", {
      _app_id: app_id,
      _env: env,
      _view_id: view_id
    });

    return this._push_update({
      ...xcmd,
      _params: {
        ...params,
        _app_id: app_id,
        _env: env,
        _view: normalized
      }
    } as unknown as XCommand);
  }

  override async onLoad() {
    await super.onLoad();
    await this.init_on_boot();
  }
  /* ------------------------------------------------------------------------ */
  /* INIT (called auto by onLoad)                                                                    */
  /* ------------------------------------------------------------------------ */

  async init_on_boot() {

    fs.mkdirSync(this._apps_root, {
      recursive: true
    });

    this._apps.clear();
    this._active_app_by_env.clear();
    this.prepare_server_settings();
    const system_stats = await this.loadSystemApps();
    const user_stats = await this.loadUserApps();
    const active_apps_restored = this.restore_active_apps_from_settings();

    _xlog.log(
      "[server-xvm] loaded",
      {
        _apps: this._apps.size,
        _views: system_stats._views + user_stats._views,
        _flows: system_stats._flows + user_stats._flows,
        _entities: system_stats._entities + user_stats._entities,
        _active_apps: active_apps_restored
      }
    );

    return {
      _apps_loaded: this._apps.size,
      _views_loaded: system_stats._views + user_stats._views,
      _flows_loaded: system_stats._flows + user_stats._flows,
      _entities_loaded: system_stats._entities + user_stats._entities,
      _active_apps_restored: active_apps_restored
    };
  }

  /* ------------------------------------------------------------------------ */
  /* LOADERS                                                                  */
  /* ------------------------------------------------------------------------ */

  private async loadSystemApps() {
    const stats = { _apps: 0, _views: 0, _flows: 0, _entities: 0 };
    const root = this._system_xapps_path;
    if (!root || !fs.existsSync(root)) {
      _xlog.warn("[server-xvm] missing system apps path", {
        _path: root
      });
      return stats;
    }

    const apps = fs.readdirSync(root, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);

    for (const app_id of apps) {
      const app_dir = path.join(root, app_id);
      const loaded = await this.loadAppFromDir(app_dir, DEFAULT_ENV, true);
      stats._apps += loaded._apps;
      stats._views += loaded._views;
      stats._flows += loaded._flows;
      stats._entities += loaded._entities;
    }

    return stats;
  }

  private async loadUserApps() {
    const stats = { _apps: 0, _views: 0, _flows: 0, _entities: 0 };
    const envs = fs.readdirSync(this._apps_root, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);

    for (const env of envs) {
      const env_dir = path.join(this._apps_root, env);
      const apps = fs.readdirSync(env_dir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);

      for (const app_id of apps) {
        const loaded = await this.loadAppFromDir(path.join(env_dir, app_id), env, false);
        stats._apps += loaded._apps;
        stats._views += loaded._views;
        stats._flows += loaded._flows;
        stats._entities += loaded._entities;
      }
    }

    return stats;
  }

  private async loadAppFromDir(app_dir: string, env: string, system: boolean) {
    const app_file_path = path.join(app_dir, "app.json");
    const stats = { _apps: 0, _views: 0, _flows: 0, _entities: 0 };
    if (!fs.existsSync(app_file_path)) return stats;

    const raw_app = this.read_json_file(app_file_path);
    const app_file = this.normalize_app_file(raw_app, app_dir, env, system);

    const views: Record<string, XVMView> = {};
    const flows: Record<string, XVMFlow> = {};
    const entities: Record<string, any> = {};

    const views_dir = path.join(app_dir, "views");
    if (fs.existsSync(views_dir)) {
      for (const file of fs.readdirSync(views_dir).filter(f => f.endsWith(".json"))) {
        const view = this.read_json_file(path.join(views_dir, file));
        if (view?._id) {
          views[view._id] = view;
          stats._views++;
        }
      }
    }

    const flows_dir = path.join(app_dir, "flows");
    if (fs.existsSync(flows_dir)) {
      for (const file of fs.readdirSync(flows_dir).filter(f => f.endsWith(".json"))) {
        const flow = this.read_json_file(path.join(flows_dir, file));
        if (flow?._id) {
          flows[flow._id] = flow;
          stats._flows++;
        }
      }
    }

    const entities_dir = path.join(app_dir, "entities");
    if (fs.existsSync(entities_dir)) {
      for (const file of fs.readdirSync(entities_dir).filter(f => f.endsWith(".json"))) {
        const raw_entity = this.read_json_file(path.join(entities_dir, file));
        const entity = raw_entity?._entity ?? raw_entity;
        if (entity?._id) {
          entities[entity._id] = entity;
          stats._entities++;
        }
      }
    }

    const loaded_bundle = {
      _app: app_file,
      _views: views,
      _flows: flows,
      _entities: entities
    };
    this.validate_bundle_runtime_contract(loaded_bundle);

    for (const entity of Object.values(entities)) {
      await _x.execute({
        _module: "entity-manager",
        _op: "register",
        _params: {
          _app_id: app_file._app_id,
          _env: app_file._env,
          _entity: entity
        }
      });
    }

    const key = app_scope_key(app_file._app_id, app_file._env);
    if (this._apps.has(key)) {
      _xlog.warn("[server-xvm] app id collision", {
        _app_id: app_file._app_id,
        _env: app_file._env
      });
    }

    this._apps.set(key, loaded_bundle);

    stats._apps++;
    _xlog.log(system ? "[server-xvm] system app loaded" : "[server-xvm] user app loaded", {
      _app_id: app_file._app_id,
      _env: app_file._env
    });

    return stats;
  }

  /* ------------------------------------------------------------------------ */
  /* HELPERS                                                                  */
  /* ------------------------------------------------------------------------ */

  private get_bundle(app_id: string, env: string) {
    const bundle = this._apps.get(app_scope_key(app_id, env));
    if (!bundle) throw new XError("E_XVM_APP_NOT_FOUND", `App not found: ${app_id}`);
    return bundle;
  }

  private resolve_default_app_id(env: string): string {
    return this._active_app_by_env.get(env) ?? "vibe-system";
  }

  private resolve_app_id(params: Record<string, any>, env: string): string {
    return typeof params._app_id === "string" && params._app_id.trim()
      ? params._app_id.trim()
      : this.resolve_default_app_id(env);
  }

  private resolve_server_settings_file(): string {
    return path.resolve(
      path.join(this._work_folder, "settings", "server-settings.json")
    );
  }

  private prepare_server_settings(): boolean {
    const settings_file = this.resolve_server_settings_file();
    const settings_folder = path.dirname(settings_file);

    fs.mkdirSync(settings_folder, { recursive: true });

    if (!fs.existsSync(settings_file)) {
      fs.writeFileSync(settings_file, "{}", "utf-8");
    }

    const loaded = _xs.load(settings_file);
    if (!loaded) {
      _xlog.warn("[server-xvm] active app settings load failed", {
        _path: settings_file
      });
    }

    return loaded;
  }

  private read_active_apps_setting(): Record<string, string> {
    if (!this.prepare_server_settings()) {
      return {};
    }

    const raw = _xs.get(ACTIVE_APPS_SETTINGS_KEY);
    if (!_xu.is_plain_object(raw)) {
      return {};
    }

    const active_apps: Record<string, string> = {};
    for (const [env, app_id] of Object.entries(raw)) {
      if (
        typeof env === "string" &&
        env.trim().length > 0 &&
        typeof app_id === "string" &&
        app_id.trim().length > 0
      ) {
        active_apps[env.trim()] = app_id.trim();
      }
    }

    return active_apps;
  }

  private persist_active_app(env: string, app_id: string) {
    if (!this.prepare_server_settings()) {
      throw new XError("E_XVM_SETTINGS_LOAD_FAILED", "Failed to load server settings");
    }

    _xs.set(ACTIVE_APPS_SETTINGS_KEY, {
      ...this.read_active_apps_setting(),
      [env]: app_id,
    });

    let persisted = false;
    try {
      const saved = JSON.parse(fs.readFileSync(this.resolve_server_settings_file(), "utf-8"));
      persisted =
        _xu.is_plain_object(saved?._active_apps) &&
        saved._active_apps[env] === app_id;
    } catch {
      persisted = false;
    }

    if (!persisted) {
      throw new XError("E_XVM_SETTINGS_SAVE_FAILED", "Failed to persist active app setting");
    }
  }

  private restore_active_apps_from_settings(): number {
    const active_apps = this.read_active_apps_setting();
    let restored = 0;

    for (const [raw_env, raw_app_id] of Object.entries(active_apps)) {
      let env: string;
      let app_id: string;

      try {
        env = this.resolve_safe_segment(raw_env, "_active_apps env", "E_XVM_INVALID_ENV");
        app_id = this.resolve_safe_segment(raw_app_id, "_active_apps app_id", "E_XVM_INVALID_APP_ID");
      } catch (err) {
        _xlog.warn("[server-xvm] skipped invalid persisted active app", {
          _env: raw_env,
          _app_id: raw_app_id,
          _error: err instanceof Error ? err.message : String(err)
        });
        continue;
      }

      if (!this._apps.has(app_scope_key(app_id, env))) {
        _xlog.warn("[server-xvm] skipped missing persisted active app", {
          _env: env,
          _app_id: app_id
        });
        continue;
      }

      this._active_app_by_env.set(env, app_id);
      restored++;
    }

    return restored;
  }

  private normalize_app_file(raw_input: any, app_dir: string, env: string, system: boolean): XVMAppFile {
    const raw = _xu.is_plain_object(raw_input) ? raw_input : {};
    const meta = _xu.is_plain_object(raw._meta) ? raw._meta : {};

    return {
      ...raw,
      _app_id: typeof raw._app_id === "string" && raw._app_id ? raw._app_id : path.basename(app_dir),
      _env: typeof raw._env === "string" && raw._env ? raw._env : env,
      _system: system,
      _meta: {
        ...meta,
        _version: typeof meta._version === "number" ? meta._version : 1,
        _entry_view_id: typeof meta._entry_view_id === "string" && meta._entry_view_id ? meta._entry_view_id : "view-main",
        _updated_at: typeof meta._updated_at === "string" ? meta._updated_at : _xu.to_iso_now()
      },
      _config: _xu.is_plain_object(raw._config) ? raw._config : {}
    };
  }

  private read_json_file(file_path: string) {
    try {
      return JSON.parse(fs.readFileSync(file_path, "utf-8"));
    } catch (err) {
      _xlog.warn("[server-xvm] invalid json file", {
        _path: file_path,
        _error: err instanceof Error ? err.message : String(err)
      });
      return {};
    }
  }

  private read_generated_module_registry_modules() {
    const registry_file = path.join(
      this._work_folder,
      GENERATED_MODULE_REGISTRY_FILE
    );

    if (!fs.existsSync(registry_file)) {
      return [];
    }

    let registry: any;
    try {
      registry = JSON.parse(fs.readFileSync(registry_file, "utf-8"));
    } catch {
      return [];
    }

    const modules = registry?._version === 1 && _xu.is_plain_object(registry?._modules)
      ? registry._modules
      : {};

    return Object.values(modules)
      .filter((entry): entry is Record<string, any> => _xu.is_plain_object(entry))
      .map((entry) => ({
        _id: typeof entry._id === "string"
          ? entry._id
          : typeof entry._name === "string"
            ? entry._name
            : "",
        _name: typeof entry._name === "string"
          ? entry._name
          : "",
        _title: typeof entry._title === "string"
          ? entry._title
          : typeof entry._name === "string"
            ? entry._name
            : undefined,
        _path: typeof entry._artifact_path === "string"
          ? entry._artifact_path
          : undefined,
        _enabled: entry._autoload === true && registry_entry_state(entry) !== "disabled",
        _state: registry_entry_state(entry),
        _autoload: entry._autoload === true,
        _ops: registry_entry_ops(entry)
      }));
  }

  private assert_mutable_bundle(bundle: XVMAppBundle) {
    if (bundle._app._system === true) {
      _xlog.warn("[server-xvm] readonly system app blocked", {
        _app_id: bundle._app._app_id,
        _env: bundle._app._env
      });
      throw new XError("E_XVM_READONLY", "System apps are readonly");
    }
  }

  private resolve_project_memory_context(params: Record<string, any>): {
    _app_id: string;
    _env: string;
    _memory_path: string;
  } {
    const app_id = this.resolve_safe_segment(
      params._app_id,
      "_app_id",
      "E_XVM_INVALID_APP_ID"
    );
    const env = this.resolve_safe_segment(
      typeof params._env === "string" ? params._env : DEFAULT_ENV,
      "_env",
      "E_XVM_INVALID_ENV"
    );
    const bundle = this.get_bundle(app_id, env);
    this.assert_mutable_bundle(bundle);

    const memory_path = this.get_project_memory_path(app_id, env);
    const app_json_path = path.join(path.dirname(memory_path), "app.json");
    if (!fs.existsSync(app_json_path)) {
      throw new XError("E_XVM_APP_NOT_FOUND", `App not found on disk: ${app_id}`);
    }

    return {
      _app_id: app_id,
      _env: env,
      _memory_path: memory_path
    };
  }

  private get_project_memory_path(app_id: string, env: string): string {
    const safe_app_id = this.resolve_safe_segment(
      app_id,
      "_app_id",
      "E_XVM_INVALID_APP_ID"
    );
    const safe_env = this.resolve_safe_segment(
      env,
      "_env",
      "E_XVM_INVALID_ENV"
    );
    const app_dir = this.resolve_user_app_dir(safe_env, safe_app_id);
    const memory_path = path.resolve(app_dir, "project-memory.json");
    const relative = path.relative(app_dir, memory_path);

    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw new XError("E_XVM_INVALID_APP_PATH", "Invalid project memory path");
    }

    return memory_path;
  }

  private default_project_memory(): XVMProjectMemory {
    return {
      _version: 1,
      _stage: "planning",
      _vision: "",
      _goal: "",
      _current_focus: "",
      _completed: [],
      _achievements: [],
      _milestones: [],
      _parking_lot: [],
      _decisions: [],
      _notes: [],
      _updated_at: ""
    };
  }

  private normalize_project_memory(
    raw_input: unknown,
    opts: {
      _touch_updated_at?: boolean;
    } = {}
  ): XVMProjectMemory {
    const raw = _xu.is_plain_object(raw_input) ? raw_input : {};
    const current = this.default_project_memory();

    return {
      _version: typeof raw._version === "number" && Number.isFinite(raw._version)
        ? raw._version
        : current._version,
      _stage: resolveProjectStage(raw),
      _vision: typeof raw._vision === "string" ? raw._vision : current._vision,
      _goal: typeof raw._goal === "string" ? raw._goal : current._goal,
      ...(typeof raw._summary === "string" ? { _summary: raw._summary } : {}),
      ...(_xu.is_plain_object(raw._proposed)
        ? {
          _proposed: {
            ...(Array.isArray(raw._proposed._entities)
              ? { _entities: raw._proposed._entities }
              : {}),
            ...(Array.isArray(raw._proposed._views)
              ? { _views: raw._proposed._views }
              : {}),
            ...(Array.isArray(raw._proposed._flows)
              ? { _flows: raw._proposed._flows }
              : {}),
            ...(Array.isArray(raw._proposed._server_modules)
              ? { _server_modules: raw._proposed._server_modules }
              : {}),
          },
        }
        : {}),
      ...(_xu.is_plain_object(raw._confirmed_initial_plan)
        ? { _confirmed_initial_plan: clone_json(raw._confirmed_initial_plan) }
        : {}),
      ...(_xu.is_plain_object(raw._semantic_generation_plan)
        ? { _semantic_generation_plan: clone_json(raw._semantic_generation_plan) }
        : {}),
      _current_focus: typeof raw._current_focus === "string"
        ? raw._current_focus
        : current._current_focus,
      _completed: Array.isArray(raw._completed) ? raw._completed : current._completed,
      _achievements: Array.isArray(raw._achievements) ? raw._achievements : current._achievements,
      _milestones: normalize_project_memory_milestones(raw._milestones),
      _parking_lot: Array.isArray(raw._parking_lot) ? raw._parking_lot : current._parking_lot,
      _decisions: Array.isArray(raw._decisions) ? raw._decisions : current._decisions,
      _notes: Array.isArray(raw._notes) ? raw._notes : current._notes,
      ...(_xu.is_plain_object(raw._last_change_plan_execution)
        ? { _last_change_plan_execution: clone_json(raw._last_change_plan_execution) }
        : {}),
      ...(Array.isArray(raw._change_plan_executions)
        ? { _change_plan_executions: clone_json(raw._change_plan_executions) }
        : {}),
      _updated_at: opts._touch_updated_at === false
        ? typeof raw._updated_at === "string"
          ? raw._updated_at
          : current._updated_at
        : _xu.to_iso_now()
    };
  }

  private load_or_create_project_memory(
    app_id: string,
    env: string,
    memory_path: string
  ): XVMProjectMemory {
    if (fs.existsSync(memory_path)) {
      _xlog.log("[server-xvm] project memory loaded", {
        _app_id: app_id,
        _env: env
      });
      return this.read_project_memory_file(app_id, env, memory_path);
    }

    const memory = this.default_project_memory();
    this.write_json_file_atomic(memory_path, memory);

    _xlog.log("[server-xvm] project memory created", {
      _app_id: app_id,
      _env: env
    });

    return memory;
  }

  private read_project_memory_file(
    app_id: string,
    env: string,
    memory_path: string
  ): XVMProjectMemory {
    try {
      return JSON.parse(fs.readFileSync(memory_path, "utf-8")) as XVMProjectMemory;
    } catch (err) {
      _xlog.warn("[server-xvm] invalid project memory", {
        _app_id: app_id,
        _env: env,
        _error: err instanceof Error ? err.message : String(err)
      });
      throw new XError("E_XVM_INVALID_PROJECT_MEMORY", "Invalid project memory JSON");
    }
  }

  private save_project_memory_file(
    app_id: string,
    env: string,
    memory_path: string,
    memory: XVMProjectMemory
  ) {
    this.write_json_file_atomic(memory_path, memory);

    _xlog.log("[server-xvm] project memory saved", {
      _app_id: app_id,
      _env: env
    });
  }


  private resolve_safe_segment(value: unknown, field_name: string, code: string): string {
    if (typeof value !== "string") {
      throw new XError(code, `Invalid ${field_name}`);
    }

    const segment = value.trim();
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(segment)) {
      throw new XError(code, `Invalid ${field_name}`);
    }

    return segment;
  }

  private resolve_safe_view_id(value: unknown): string {
    if (typeof value !== "string") {
      throw new XError("E_XVM_INVALID_VIEW_ID", "Invalid _view_id");
    }

    const view_id = value.trim();
    if (!/^[a-z0-9][a-z0-9_-]*$/u.test(view_id)) {
      throw new XError("E_XVM_INVALID_VIEW_ID", "Invalid _view_id");
    }

    return view_id;
  }

  private resolve_view_template(value: unknown): "blank" | "page" | "component" {
    if (value === undefined || value === null || value === "") {
      return "blank";
    }

    if (
      typeof value === "string" &&
      ALLOWED_VIEW_STARTER_TEMPLATES.has(value)
    ) {
      return value as "blank" | "page" | "component";
    }

    throw new XError("E_XVM_INVALID_VIEW_TEMPLATE", "Invalid _template");
  }

  private resolve_work_system_xapps_root(): string {
    return path.resolve(this._work_folder, "system-xapps");
  }

  private resolve_package_system_xapps_root(): string {
    return path.resolve(this._package_system_xapps_path);
  }

  private resolve_view_starter_candidate(
    system_xapps_root: string,
    template: string
  ): string {
    const starters_root =
      path.resolve(system_xapps_root, "view-starters");
    const starter_file =
      path.resolve(starters_root, template, "view.json");
    const relative =
      path.relative(starters_root, starter_file);

    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw new XError("E_XVM_INVALID_VIEW_TEMPLATE", "Invalid _template");
    }

    return starter_file;
  }

  private resolve_view_starter_file(template: string): {
    _path: string;
    _source: "work" | "package";
    _work_path: string;
    _package_path: string;
  } {
    const work_path =
      this.resolve_view_starter_candidate(
        this.resolve_work_system_xapps_root(),
        template
      );
    const package_path =
      this.resolve_view_starter_candidate(
        this.resolve_package_system_xapps_root(),
        template
      );

    if (fs.existsSync(work_path)) {
      _xlog.log("[xstudio] view starter resolved", {
        _template: template,
        _source: "work",
        _path: work_path
      });

      return {
        _path: work_path,
        _source: "work",
        _work_path: work_path,
        _package_path: package_path
      };
    }

    if (fs.existsSync(package_path)) {
      _xlog.log("[xstudio] view starter resolved", {
        _template: template,
        _source: "package",
        _path: package_path
      });

      return {
        _path: package_path,
        _source: "package",
        _work_path: work_path,
        _package_path: package_path
      };
    }

    throw new XError(
      "E_XVM_VIEW_STARTER_NOT_FOUND",
      `View starter not found: ${template}`,
      {
        _meta: {
          _template: template,
          _work_path: work_path,
          _package_path: package_path
        }
      }
    );
  }

  private resolve_user_app_dir(env: string, app_id: string): string {
    const root = path.resolve(this._apps_root);
    const app_dir = path.resolve(root, env, app_id);
    const relative = path.relative(root, app_dir);

    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw new XError("E_XVM_INVALID_APP_PATH", "Invalid user app path");
    }

    return app_dir;
  }

  private resolve_view_file_path(views_dir: string, view_id: string): string {
    const root = path.resolve(views_dir);
    const view_file = path.resolve(root, `${view_id}.json`);
    const relative = path.relative(root, view_file);

    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative)
    ) {
      throw new XError("E_XVM_INVALID_VIEW_PATH", "Invalid view path");
    }

    return view_file;
  }

  private load_view_starter_template(
    view_id: string,
    title: string,
    template: "blank" | "page" | "component"
  ): XVMView {
    const starter =
      this.resolve_view_starter_file(template);

    let raw: unknown;
    try {
      raw = JSON.parse(
        fs.readFileSync(starter._path, "utf-8")
      );
    } catch (err) {
      throw new XError(
        "E_XVM_VIEW_STARTER_INVALID",
        `Invalid view starter JSON: ${template}`,
        {
          _meta: {
            _template: template,
            _path: starter._path,
            _source: starter._source,
            _error: err instanceof Error ? err.message : String(err)
          }
        }
      );
    }

    const view =
      this.replace_view_starter_placeholders(raw, {
        view_id,
        title
      });

    if (
      !_xu.is_plain_object(view) ||
      view._id !== view_id ||
      view._type !== "view"
    ) {
      throw new XError(
        "E_XVM_VIEW_STARTER_INVALID",
        `Invalid view starter shape: ${template}`,
        {
          _meta: {
            _template: template,
            _path: starter._path,
            _source: starter._source
          }
        }
      );
    }

    return view as XVMView;
  }

  private replace_view_starter_placeholders(
    value: unknown,
    replacements: {
      view_id: string;
      title: string;
    }
  ): unknown {
    if (typeof value === "string") {
      return value
        .replaceAll("{{view_id}}", replacements.view_id)
        .replaceAll("{{title}}", replacements.title);
    }

    if (Array.isArray(value)) {
      return value.map(item =>
        this.replace_view_starter_placeholders(item, replacements)
      );
    }

    if (_xu.is_plain_object(value)) {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) {
        out[key] =
          this.replace_view_starter_placeholders(item, replacements);
      }

      return out;
    }

    return value;
  }

  private write_new_json_file(file_path: string, data: unknown) {
    const file = fs.openSync(file_path, "wx");
    try {
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
    } finally {
      fs.closeSync(file);
    }
  }

  private write_json_file_atomic(file_path: string, data: unknown) {
    const temp_file =
      `${file_path}.${process.pid}.${Date.now()}.tmp`;

    fs.writeFileSync(
      temp_file,
      JSON.stringify(data, null, 2)
    );
    fs.renameSync(temp_file, file_path);
  }




  private resolve_env(params: Record<string, any>): string {
    return typeof params._env === "string" ? params._env : DEFAULT_ENV;
  }

  private backup_existing_view_file(input: {
    app_id: string;
    env: string;
    view_id: string;
    app_dir: string;
    view_file: string;
  }) {
    if (!fs.existsSync(input.view_file)) {
      return;
    }

    try {
      const old_views_dir =
        path.join(input.app_dir, "old_views");
      const timestamp =
        new Date().toISOString().replace(/[:.]/g, "-");
      const backup_file =
        path.join(
          old_views_dir,
          `${input.view_id}.${timestamp}.json`
        );

      fs.mkdirSync(old_views_dir, { recursive: true });
      fs.copyFileSync(input.view_file, backup_file);

      _xlog.log("[server-xvm] view backup created", {
        _app_id: input.app_id,
        _env: input.env,
        _view_id: input.view_id,
        _backup_file: backup_file
      });
    } catch (err) {
      _xlog.warn("[server-xvm] view backup failed", {
        _app_id: input.app_id,
        _env: input.env,
        _view_id: input.view_id,
        _error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  private persist_bundle(
    bundle: XVMAppBundle,
    opts: {
      _backup_view_ids?: string[];
    } = {}
  ) {
    this.assert_mutable_bundle(bundle);
    this.validate_bundle_runtime_contract(bundle);

    const app_dir = path.join(
      this._apps_root,
      bundle._app._env,
      bundle._app._app_id
    );

    const views_dir = path.join(app_dir, "views");
    const flows_dir = path.join(app_dir, "flows");
    const entities_dir = path.join(app_dir, "entities");

    fs.mkdirSync(app_dir, { recursive: true });
    fs.mkdirSync(entities_dir, { recursive: true });

    fs.mkdirSync(views_dir, { recursive: true });
    fs.mkdirSync(flows_dir, { recursive: true });

    fs.writeFileSync(
      path.join(app_dir, "app.json"),
      JSON.stringify(bundle._app, null, 2)
    );

    const backup_view_ids =
      new Set(opts._backup_view_ids ?? []);

    for (const view_id of Object.keys(bundle._views || {})) {
      const view_file =
        path.join(views_dir, `${view_id}.json`);

      if (backup_view_ids.has(view_id)) {
        this.backup_existing_view_file({
          app_id: bundle._app._app_id,
          env: bundle._app._env,
          view_id,
          app_dir,
          view_file
        });
      }

      fs.writeFileSync(
        view_file,
        JSON.stringify(bundle._views[view_id], null, 2)
      );
    }

    for (const flow_id of Object.keys(bundle._flows || {})) {
      fs.writeFileSync(
        path.join(flows_dir, `${flow_id}.json`),
        JSON.stringify(bundle._flows[flow_id], null, 2)
      );
    }

    for (const entity_id of Object.keys(bundle._entities || {})) {
      fs.writeFileSync(
        path.join(entities_dir, `${entity_id}.json`),
        JSON.stringify(bundle._entities[entity_id], null, 2)
      );
    }

    this.prune_deleted_json_files(views_dir, Object.keys(bundle._views || {}));
    this.prune_deleted_json_files(flows_dir, Object.keys(bundle._flows || {}));
    this.prune_deleted_json_files(entities_dir, Object.keys(bundle._entities || {}));
  }

  private prune_deleted_json_files(dir: string, ids: string[]) {
    const keep = new Set(ids.map(id => `${id}.json`));
    for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
      if (keep.has(file)) continue;
      const file_path = path.join(dir, file);
      const file_id = path.basename(file, ".json");
      try {
        const data = JSON.parse(fs.readFileSync(file_path, "utf-8"));
        if (data?._id === file_id) fs.unlinkSync(file_path);
      } catch {
      }
    }
  }
}

export default ServerXVMModule;
