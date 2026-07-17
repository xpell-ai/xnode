import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  _current_focus: string;
  _completed: unknown[];
  _achievements: unknown[];
  _milestones: unknown[];
  _parking_lot: unknown[];
  _decisions: unknown[];
  _notes: unknown[];
  _updated_at: string;
};

/* -------------------------------------------------------------------------- */

const DEFAULT_ENV = "default";
const DEFAULT_WORK_FOLDER = "./work";
const XVM_FOLDER = "xvm/apps";
const GENERATED_MODULE_REGISTRY_FILE = "generated/xmodules/registry.json";
const ACTIVE_APPS_SETTINGS_KEY = "_active_apps";
const XNODE_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ALLOWED_VIEW_STARTER_TEMPLATES = new Set(["blank", "page", "component"]);

const EVT_UPDATE = "server-xvm:update";

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
      }
    }

    const key = app_scope_key(app_file._app_id, app_file._env);
    if (this._apps.has(key)) {
      _xlog.warn("[server-xvm] app id collision", {
        _app_id: app_file._app_id,
        _env: app_file._env
      });
    }

    this._apps.set(key, {
      _app: app_file,
      _views: views,
      _flows: flows,
      _entities: entities
    });

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
      _current_focus: typeof raw._current_focus === "string"
        ? raw._current_focus
        : current._current_focus,
      _completed: Array.isArray(raw._completed) ? raw._completed : current._completed,
      _achievements: Array.isArray(raw._achievements) ? raw._achievements : current._achievements,
      _milestones: normalize_project_memory_milestones(raw._milestones),
      _parking_lot: Array.isArray(raw._parking_lot) ? raw._parking_lot : current._parking_lot,
      _decisions: Array.isArray(raw._decisions) ? raw._decisions : current._decisions,
      _notes: Array.isArray(raw._notes) ? raw._notes : current._notes,
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
