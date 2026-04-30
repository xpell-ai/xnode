import fs from "node:fs";
import path from "node:path";
import { XModule, type XCommand, _xlog } from "@xpell/core";
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
  _meta: XVMAppMeta;
  _config: Record<string, any>;
};

export type XVMAppBundle = {
  _app: XVMAppFile;
  _views: Record<string, XVMView>;
  _flows: Record<string, XVMFlow>; // ✅ NEW
};

type SubscriptionStore = Map<string, Map<string, { _wid: string; _sid?: string }>>;

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
  private _subscriptions: SubscriptionStore = new Map();

  constructor(opts: any = {}) {
    super({ _name: ServerXVMModule._name });

    const work_folder = opts._work_folder ?? DEFAULT_WORK_FOLDER;
    this._apps_root = opts._apps_root ?? path.join(work_folder, XVM_FOLDER);
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
      _flows: {}, // ✅
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
      _view_ids: Object.keys(bundle._views),
      _flow_ids: Object.keys(bundle._flows || {}),
    };

    if (include_views) res._views = bundle._views;
    if (include_flows) res._flows = bundle._flows;

    return { _ok: true, _result: res };
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

    if (!view) throw new Error(`View not found: ${view_id}`);

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
    if (!_xu.is_plain_object(flow)) throw new Error("Missing _flow");

    const flow_id = _xu.ensure_string(flow._id, "_flow._id");

    const bundle = this.get_bundle(app_id, env);

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

    if (!flow) throw new Error(`Flow not found: ${flow_id}`);

    return { _ok: true, _result: { _flow: flow } };
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
    if (!_xu.is_plain_object(view_data)) throw new Error("Missing _view");

    const view_id = _xu.ensure_string(view_data._id, "_view._id");

    const bundle = this.get_bundle(app_id, env);

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

  /* ------------------------------------------------------------------------ */
  /* INIT                                                                     */
  /* ------------------------------------------------------------------------ */

  async init_on_boot() {
    fs.mkdirSync(this._apps_root, { recursive: true });

    this._apps.clear();

    let views_count = 0;
    let flows_count = 0;

    const envs = fs.readdirSync(this._apps_root, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);

    for (const env of envs) {
      const env_dir = path.join(this._apps_root, env);

      const apps = fs.readdirSync(env_dir, { withFileTypes: true })
        .filter(e => e.isDirectory())
        .map(e => e.name);

      for (const app_id of apps) {
        const app_dir = path.join(env_dir, app_id);
        const app_file_path = path.join(app_dir, "app.json");

        if (!fs.existsSync(app_file_path)) continue;

        const app_file = JSON.parse(fs.readFileSync(app_file_path, "utf-8"));

        const views: Record<string, XVMView> = {};
        const flows: Record<string, XVMFlow> = {};

        /* views */
        const views_dir = path.join(app_dir, "views");
        if (fs.existsSync(views_dir)) {
          for (const file of fs.readdirSync(views_dir).filter(f => f.endsWith(".json"))) {
            const view = JSON.parse(fs.readFileSync(path.join(views_dir, file), "utf-8"));
            if (view._id) {
              views[view._id] = view;
              views_count++;
            }
          }
        }

        /* flows */
        const flows_dir = path.join(app_dir, "flows");
        if (fs.existsSync(flows_dir)) {
          for (const file of fs.readdirSync(flows_dir).filter(f => f.endsWith(".json"))) {
            const flow = JSON.parse(fs.readFileSync(path.join(flows_dir, file), "utf-8"));
            if (flow._id) {
              flows[flow._id] = flow;
              flows_count++;
            }
          }
        }

        this._apps.set(app_scope_key(app_file._app_id, app_file._env), {
          _app: app_file,
          _views: views,
          _flows: flows,
        });
      }
    }

    _xlog.log(`[server-xvm] loaded apps=${this._apps.size} views=${views_count} flows=${flows_count}`);

    return {
      _apps_loaded: this._apps.size,
      _views_loaded: views_count,
      _flows_loaded: flows_count,
    };
  }

  /* ------------------------------------------------------------------------ */
  /* HELPERS                                                                  */
  /* ------------------------------------------------------------------------ */

  private get_bundle(app_id: string, env: string) {
    const bundle = this._apps.get(app_scope_key(app_id, env));
    if (!bundle) throw new Error(`App not found: ${app_id}`);
    return bundle;
  }



  private resolve_env(params: Record<string, any>): string {
    return typeof params._env === "string" ? params._env : DEFAULT_ENV;
  }

  private persist_bundle(bundle: XVMAppBundle) {
    const app_dir = path.join(
      this._apps_root,
      bundle._app._env,
      bundle._app._app_id
    );

    const views_dir = path.join(app_dir, "views");
    const flows_dir = path.join(app_dir, "flows");

    fs.mkdirSync(views_dir, { recursive: true });
    fs.mkdirSync(flows_dir, { recursive: true });

    fs.writeFileSync(
      path.join(app_dir, "app.json"),
      JSON.stringify(bundle._app, null, 2)
    );

    for (const view_id of Object.keys(bundle._views)) {
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
  }
}

export default ServerXVMModule;