import fs from "node:fs";
import path from "node:path";
import { XModule, type XCommand, _xlog, _x, XError } from "@xpell/core";
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
  _system: boolean;
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

const EVT_UPDATE = "server-xvm:update";

function app_scope_key(app_id: string, env: string): string {
  return `${env}::${app_id}`;
}

/* -------------------------------------------------------------------------- */

export class ServerXVMModule extends XModule {
  static _name = "server-xvm";

  private _apps_root: string;
  private _apps: Map<string, XVMAppBundle> = new Map();
  private _system_xapps_path?: string;

  constructor(opts: any = {}) {
    super({ _name: ServerXVMModule._name });

    const work_folder = opts._work_folder ?? DEFAULT_WORK_FOLDER;
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

  /* ------------------------------------------------------------------------ */
  /* GET APP                                                                  */
  /* ------------------------------------------------------------------------ */

  async _get_app(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd?._params);

    const app_id = _xu.ensure_string(params._app_id, "_app_id");
    const env = this.resolve_env(params);
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
    const apps = Array.from(this._apps.values())
      .map(bundle => bundle._app)
      .filter(app => !env || app._env === env);

    return {
      _ok: true,
      _result: {
        _app_ids: apps.map(app => app._app_id),
        _apps: apps
      }
    };
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

    return {
      _ok: true,
      _result: {
        _flows: Object.keys(bundle._flows || {}),
      },
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

    const normalized: any = {
      ...entity,
      _id: entity_id
    };

    bundle._entities[entity_id] = normalized;
    bundle._app._meta._version++;
    bundle._app._meta._updated_at = _xu.to_iso_now();

    this.persist_bundle(bundle);

    await _x.execute({
      _module: "entity-manager",
      _op: "register",
      _params: {
        _app_id: app_id,
        _env: env,
        _entity: normalized
      }
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
    await _x.execute({
      _module: "entity-manager",
      _op: "unregister",
      _params: {
        _app_id: app_id,
        _env: env,
        _entity_id: entity_id
      }
    });
    return {
      _ok: true,
      _result: {
        _entity_id: entity_id
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

    this.persist_bundle(bundle);

    /* -------------------- payload -------------------- */

    const payload = {
      _app_id: app_id,
      _env: env,
      _view_id: view_id,
      _version: bundle._app._meta._version,
      _view: normalized,
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

  private assert_mutable_bundle(bundle: XVMAppBundle) {
    if (bundle._app._system === true) {
      _xlog.warn("[server-xvm] readonly system app blocked", {
        _app_id: bundle._app._app_id,
        _env: bundle._app._env
      });
      throw new XError("E_XVM_READONLY", "System apps are readonly");
    }
  }





  private resolve_env(params: Record<string, any>): string {
    return typeof params._env === "string" ? params._env : DEFAULT_ENV;
  }

  private persist_bundle(bundle: XVMAppBundle) {
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

    for (const view_id of Object.keys(bundle._views || {})) {
      fs.writeFileSync(
        path.join(views_dir, `${view_id}.json`),
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
