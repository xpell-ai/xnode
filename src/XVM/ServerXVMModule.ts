import fs from "node:fs";
import path from "node:path";
import { XModule, type XCommand, _xlog, _x, XError, type XpellSkill, type XpellSkillCommand } from "@xpell/core";
import { _xem } from "../XEM/XEventManager.js";
import { _xu } from "../XNUtils/XUtils.js";
import { wsBroadcastScoped, wsSetScope } from "../Wormholes/wh.index.js";

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

/* -------------------------------------------------------------------------- */

const DEFAULT_ENV = "default";
const DEFAULT_WORK_FOLDER = "./work";
const XVM_FOLDER = "xvm/apps";
const GENERATED_MODULE_REGISTRY_FILE = "generated/xmodules/registry.json";

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

  constructor(opts: any = {}) {
    super({ _name: ServerXVMModule._name });

    const work_folder = opts._work_folder ?? DEFAULT_WORK_FOLDER;
    this._work_folder = work_folder;
    this._apps_root = opts._apps_root ?? path.join(work_folder, XVM_FOLDER);
    this._system_xapps_path = typeof opts._system_xapps_path === "string" && opts._system_xapps_path
      ? path.resolve(opts._system_xapps_path)
      : undefined;
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

    this._active_app_by_env.set(env, app_id);

    _xlog.log("[server-xvm] active app set", {
      _app_id: app_id,
      _env: env
    });

    return {
      _ok: true,
      _result: {
        _app_id: app_id,
        _env: env
      }
    };
  }

  async _get_active_app(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);
    const env = this.resolve_env(params);

    const app_id =
      this._active_app_by_env.get(env) ??
      "vibe-system";

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

    const app_id =
      typeof params._app_id === "string" && params._app_id.trim()
        ? params._app_id.trim()
        : this._active_app_by_env.get(env) ?? "vibe-system";
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
    const system_stats = await this.loadSystemApps();
    const user_stats = await this.loadUserApps();

    _xlog.log(
      "[server-xvm] loaded",
      {
        _apps: this._apps.size,
        _views: system_stats._views + user_stats._views,
        _flows: system_stats._flows + user_stats._flows,
        _entities: system_stats._entities + user_stats._entities
      }
    );

    return {
      _apps_loaded: this._apps.size,
      _views_loaded: system_stats._views + user_stats._views,
      _flows_loaded: system_stats._flows + user_stats._flows,
      _entities_loaded: system_stats._entities + user_stats._entities
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
        _name: typeof entry._name === "string"
          ? entry._name
          : "",
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
