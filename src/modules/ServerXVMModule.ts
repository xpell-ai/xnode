import fs from "node:fs";
import path from "node:path";
import { XModule, type XCommand, _x, _xlog } from "@xpell/core";
import {_xem} from "../XEM/XEventManager.js";

export type XVMEnv = string;

export type XVMView = Record<string, any> & {
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
};

export type SubscriberTarget = {
    _subscriber_id: string;
    _sid?: string;
    _wid: string;
};

export type PushEventArgs = {
    _subscriber_targets: SubscriberTarget[];
    _event_name: string;
    _payload: Record<string, any>;
};

export type PushEventResult = {
    _notified_subscribers: string[];
};

export type ViewScope = {
    _app_id: string;
    _env: string;
    _allowed_view_ids: Set<string>;
    _entry_view_id?: string;
    _fallback_view_id?: string;
    _start_view_id?: string;
};

export type ValidationCtx = {
    _app_id: string;
    _env: string;
    _view_id: string;
    _path: string;
    _source: string;
    _scope: ViewScope;
};

export type ServerXVMModuleOptions = {
    _work_folder?: string;
    _apps_root?: string;
    _allow_cross_object_mutation?: boolean;
    _allowed_nano_ops?: string[];

    _allow_navigate?: boolean;
    _allow_open_url?: boolean;
    _allowed_open_url_hosts?: string[];

    _send_wormholes_event?: (args: PushEventArgs) => Promise<PushEventResult> | PushEventResult;
};

type SubscriptionStore = Map<string, Map<string, SubscriberTarget>>;

const DEFAULT_ENV = "default";
const DEFAULT_WORK_FOLDER = "./work";
const XVM_FOLDER = "xvm/apps";

const SOURCE_LOAD = "server-xvm:load";
const SOURCE_PUSH = "server-xvm:push";

const DEFAULT_ALLOWED_NANO_OPS = new Set<string>([
    "show",
    "hide",
    "toggle",
    "add-class",
    "remove-class",
    "toggle-class",
    "set-text",
    "set-text-from-data",
    "set-attr",
    "set-data",
    "set-value",
    "clear-value",
    "focus",
    "blur",
    "fire",
    "navigate",
    "open-url",
    "noop",
]);

const RISKY_OPS = new Set<string>(["open-url", "navigate"]);

function app_scope_key(app_id: string, env: string): string {
    return `${env}::${app_id}`;
}

function to_iso_now(): string {
    return new Date().toISOString();
}

function is_plain_object(value: unknown): value is Record<string, any> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensure_string(value: unknown, field_name: string): string {
    if (typeof value !== "string" || value.trim().length === 0) {
        throw new Error(`Invalid '${field_name}': expected non-empty string`);
    }
    return value.trim();
}

function parse_command_name(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return "";
    const match = trimmed.match(/^[a-zA-Z0-9:_-]+/);
    return match ? match[0] : "";
}

export class ServerXVMModule extends XModule {
    static _name = "server-xvm";

    private _apps_root: string;
    private _allow_cross_object_mutation: boolean;
    private _allowed_nano_ops: Set<string>;

    private _allow_navigate: boolean;
    private _allow_open_url: boolean;
    private _allowed_open_url_hosts: Set<string>;

    private _send_wormholes_event?: (args: PushEventArgs) => Promise<PushEventResult> | PushEventResult;

    private _apps: Map<string, XVMAppBundle> = new Map();
    private _subscriptions: SubscriptionStore = new Map();

    constructor(opts: ServerXVMModuleOptions = {}) {
        super({ _name: ServerXVMModule._name });

        const work_folder = opts._work_folder ?? DEFAULT_WORK_FOLDER;
        this._apps_root = opts._apps_root ?? path.join(work_folder, XVM_FOLDER);

        this._allow_cross_object_mutation = opts._allow_cross_object_mutation === true;

        this._allowed_nano_ops = new Set(DEFAULT_ALLOWED_NANO_OPS);
        for (const op of opts._allowed_nano_ops ?? []) {
            if (typeof op === "string" && op.trim()) {
                this._allowed_nano_ops.add(op.trim());
            }
        }

        this._allow_navigate = opts._allow_navigate !== false;
        // Secure-by-default:
        // - open-url is disabled unless explicitly enabled
        // - when enabled: relative "/..." is allowed
        // - absolute URLs must be https + host in allowlist
        // - empty allowlist means all absolute URLs are rejected (expected)
        this._allow_open_url = opts._allow_open_url === true;
        this._allowed_open_url_hosts = new Set(
            (opts._allowed_open_url_hosts ?? []).map((host) => host.trim().toLowerCase()).filter(Boolean)
        );

        this._send_wormholes_event = opts._send_wormholes_event;
    }

    async init_on_boot(): Promise<{ _apps_loaded: number; _views_loaded: number }> {
        fs.mkdirSync(this._apps_root, { recursive: true });

        this._apps.clear();
        this._subscriptions.clear();

        let loaded_views = 0;

        const env_dirs = fs
            .readdirSync(this._apps_root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort();

        for (const env of env_dirs) {
            const env_dir = path.join(this._apps_root, env);
            const app_dirs = fs
                .readdirSync(env_dir, { withFileTypes: true })
                .filter((entry) => entry.isDirectory())
                .map((entry) => entry.name)
                .sort();

            for (const app_id of app_dirs) {
                const app_dir = path.join(env_dir, app_id);
                const app_json_path = path.join(app_dir, "app.json");

                if (!fs.existsSync(app_json_path)) {
                    this.log_boot_error(env, app_id, app_json_path, "missing app.json");
                    continue;
                }

                let app_file: XVMAppFile;
                try {
                    const raw_app_file = this.read_json_file(app_json_path);
                    app_file = this.validate_and_normalize_app_file(raw_app_file, {
                        _expected_env: env,
                        _expected_app_id: app_id,
                        _source: SOURCE_LOAD,
                    });
                } catch (err: any) {
                    this.log_boot_error(env, app_id, app_json_path, err?.message ?? String(err));
                    continue;
                }

                const views_dir = path.join(app_dir, "views");
                const candidate_views: Record<string, XVMView> = {};

                if (fs.existsSync(views_dir)) {
                    const view_files = fs
                        .readdirSync(views_dir, { withFileTypes: true })
                        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
                        .map((entry) => entry.name)
                        .sort();

                    for (const file_name of view_files) {
                        const file_path = path.join(views_dir, file_name);
                        try {
                            const expected_view_id = file_name.replace(/\.json$/i, "");
                            const raw_view = this.read_json_file(file_path);
                            const view_id = ensure_string(raw_view?._id, "_id");

                            if (view_id !== expected_view_id) {
                                throw new Error(`view id mismatch _id='${view_id}' expected='${expected_view_id}'`);
                            }

                            candidate_views[view_id] = { ...raw_view, _id: view_id };
                        } catch (err: any) {
                            this.log_boot_error(env, app_id, file_path, err?.message ?? String(err));
                        }
                    }
                }

                const scope = this.create_view_scope(app_file, candidate_views);
                const valid_views: Record<string, XVMView> = {};

                const sorted_view_ids = Object.keys(candidate_views).sort();
                for (const view_id of sorted_view_ids) {
                    const view = candidate_views[view_id];
                    const file_path = path.join(views_dir, `${view_id}.json`);

                    try {
                        this.validate_view_data(view, {
                            _app_id: app_file._app_id,
                            _env: app_file._env,
                            _view_id: view_id,
                            _path: "$",
                            _source: SOURCE_LOAD,
                            _scope: scope,
                        });
                        valid_views[view_id] = view;
                        loaded_views += 1;
                    } catch (err: any) {
                        this.log_boot_error(env, app_id, file_path, err?.message ?? String(err));
                    }
                }

                this._apps.set(app_scope_key(app_file._app_id, app_file._env), {
                    _app: app_file,
                    _views: valid_views,
                });
            }
        }

        const loaded_apps = this._apps.size;
        _xlog.log(`[server-xvm] boot apps_loaded=${loaded_apps} views_loaded=${loaded_views} root=${this._apps_root}`);
        return { _apps_loaded: loaded_apps, _views_loaded: loaded_views };
    }

    async _list_apps(xcmd: XCommand) { return this.list_apps_impl(xcmd); }
    async _op_list_apps(xcmd: XCommand) { return this.list_apps_impl(xcmd); }

    async _get_app(xcmd: XCommand) { return this.get_app_impl(xcmd); }
    async _op_get_app(xcmd: XCommand) { return this.get_app_impl(xcmd); }

    async _get_view(xcmd: XCommand) { return this.get_view_impl(xcmd); }
    async _op_get_view(xcmd: XCommand) { return this.get_view_impl(xcmd); }

    async _subscribe(xcmd: XCommand) { return this.subscribe_impl(xcmd); }
    async _op_subscribe(xcmd: XCommand) { return this.subscribe_impl(xcmd); }

    async _unsubscribe(xcmd: XCommand) { return this.unsubscribe_impl(xcmd); }
    async _op_unsubscribe(xcmd: XCommand) { return this.unsubscribe_impl(xcmd); }

    async _push_update(xcmd: XCommand) { return this.push_update_impl(xcmd); }
    async _op_push_update(xcmd: XCommand) { return this.push_update_impl(xcmd); }

    private list_apps_impl(xcmd: XCommand) {
        const params = this.ensure_params(xcmd?._params);
        const env_filter = typeof params._env === "string" && params._env.trim() ? params._env.trim() : undefined;

        const apps = Array.from(this._apps.values())
            .filter((bundle) => (env_filter ? bundle._app._env === env_filter : true))
            .map((bundle) => ({
                _app_id: bundle._app._app_id,
                _env: bundle._app._env,
                _name: bundle._app._meta._name ?? bundle._app._app_id,
                _version: bundle._app._meta._version,
                _entry_view_id: bundle._app._meta._entry_view_id,
                _views_count: Object.keys(bundle._views).length,
                _updated_at: bundle._app._meta._updated_at,
            }))
            .sort((a, b) => {
                const env_cmp = a._env.localeCompare(b._env);
                if (env_cmp !== 0) return env_cmp;
                return a._app_id.localeCompare(b._app_id);
            });

        return {
            _apps: apps,
            _count: apps.length,
            ...(env_filter ? { _env: env_filter } : {}),
        };
    }

    private get_app_impl(xcmd: XCommand) {
        const params = this.ensure_params(xcmd?._params);
        const app_id = ensure_string(params._app_id, "_app_id");
        const env = this.resolve_env(params);

        const bundle = this.get_bundle(app_id, env);
        const include_views = params._include_views === true;

        return {
            _app: bundle._app,
            _view_ids: Object.keys(bundle._views).sort(),
            ...(include_views ? { _views: bundle._views } : {}),
        };
    }

    private get_view_impl(xcmd: XCommand) {
        const params = this.ensure_params(xcmd?._params);
        const app_id = ensure_string(params._app_id, "_app_id");
        const view_id = ensure_string(params._view_id, "_view_id");
        const env = this.resolve_env(params);

        const bundle = this.get_bundle(app_id, env);
        const view = bundle._views[view_id];

        if (!view) {
            throw new Error(`View not found: app='${app_id}' env='${env}' view='${view_id}'`);
        }

        return {
            _app_id: app_id,
            _env: env,
            _version: bundle._app._meta._version,
            _view: view,
        };
    }

    private subscribe_impl(xcmd: XCommand) {
        const params = this.ensure_params(xcmd?._params);
        const app_id = ensure_string(params._app_id, "_app_id");
        const env = this.resolve_env(params);
        this.get_bundle(app_id, env);

        const target = this.resolve_transport_target_from_xcmd(xcmd);

        const scope_key = app_scope_key(app_id, env);
        const scope_subscribers = this._subscriptions.get(scope_key) ?? new Map<string, SubscriberTarget>();
        scope_subscribers.set(target._subscriber_id, target);
        this._subscriptions.set(scope_key, scope_subscribers);

        return {
            _ok: true,
            _app_id: app_id,
            _env: env,
            _subscriber_id: target._subscriber_id,
            _subscribers_count: scope_subscribers.size,
        };
    }

    private unsubscribe_impl(xcmd: XCommand) {
        const params = this.ensure_params(xcmd?._params);
        const app_id = ensure_string(params._app_id, "_app_id");
        const env = this.resolve_env(params);
        this.get_bundle(app_id, env);

        const target = this.resolve_transport_target_from_xcmd(xcmd);

        const scope_key = app_scope_key(app_id, env);
        const scope_subscribers = this._subscriptions.get(scope_key) ?? new Map<string, SubscriberTarget>();
        scope_subscribers.delete(target._subscriber_id);

        if (scope_subscribers.size === 0) {
            this._subscriptions.delete(scope_key);
        } else {
            this._subscriptions.set(scope_key, scope_subscribers);
        }

        return {
            _ok: true,
            _app_id: app_id,
            _env: env,
            _subscriber_id: target._subscriber_id,
            _subscribers_count: scope_subscribers.size,
        };
    }

    private async push_update_impl(xcmd: XCommand) {
        const params = this.ensure_params(xcmd?._params);
        const app_id = ensure_string(params._app_id, "_app_id");
        const env = this.resolve_env(params);
        const source = typeof params._source === "string" && params._source.trim() ? params._source.trim() : SOURCE_PUSH;

        const view_data = is_plain_object(params._view) ? params._view : undefined;
        if (!view_data) {
            throw new Error("Missing '_view' object in push-update");
        }

        const view_id = ensure_string(view_data._id, "_view._id");
        const normalized_view: XVMView = { ...view_data, _id: view_id };

        const bundle = this.get_bundle(app_id, env);
        const scope = this.create_view_scope(bundle._app, {
            ...bundle._views,
            [view_id]: normalized_view,
        });

        this.validate_view_data(normalized_view, {
            _app_id: app_id,
            _env: env,
            _view_id: view_id,
            _path: "$",
            _source: source,
            _scope: scope,
        });

        bundle._views[view_id] = normalized_view;
        bundle._app._meta._version += 1;
        bundle._app._meta._updated_at = to_iso_now();

        this.persist_bundle(bundle);

        const scope_key = app_scope_key(app_id, env);
        const subscriber_targets = Array.from(this._subscriptions.get(scope_key)?.values() ?? []);

        const payload = {
            _app_id: app_id,
            _env: env,
            _view_id: view_id,
            _version: bundle._app._meta._version,
            _source: source,
            _view: normalized_view,
        };

        _xem.fire("server-xvm:update", payload);

        let notified_subscribers: string[] = [];
        if (this._send_wormholes_event) {
            const push_result = await this._send_wormholes_event({
                _subscriber_targets: subscriber_targets,
                _event_name: "server-xvm:update",
                _payload: payload,
            });
            notified_subscribers = Array.from(new Set(push_result._notified_subscribers));
        }

        _xlog.log(
            `[server-xvm] pushed view app=${app_id} env=${env} view=${view_id} version=${bundle._app._meta._version} notified=${notified_subscribers.length}`
        );

        return {
            _ok: true,
            _app_id: app_id,
            _env: env,
            _view_id: view_id,
            _version: bundle._app._meta._version,
            _notified_subscribers: notified_subscribers,
        };
    }

    private resolve_transport_target_from_xcmd(xcmd: XCommand): SubscriberTarget {
        const cmd = xcmd as any;
        const ctx = is_plain_object(cmd?._ctx) ? cmd._ctx : undefined;
        const params = is_plain_object(cmd?._params) ? cmd._params : {};

        let source: "ctx" | "params_ctx" | "params_direct" = "ctx";

        let wid = typeof ctx?._wid === "string" && ctx._wid.trim() ? ctx._wid.trim() : undefined;
        let sid = typeof ctx?._sid === "string" && ctx._sid.trim() ? ctx._sid.trim() : undefined;

        if (!wid && is_plain_object(params._ctx)) {
            const pctx = params._ctx as Record<string, any>;
            wid = typeof pctx._wid === "string" && pctx._wid.trim() ? pctx._wid.trim() : undefined;
            sid = typeof pctx._sid === "string" && pctx._sid.trim() ? pctx._sid.trim() : sid;
            if (wid) source = "params_ctx";
        }

        if (!wid) {
            wid = typeof params._wid === "string" && params._wid.trim() ? params._wid.trim() : undefined;
            sid = typeof params._sid === "string" && params._sid.trim() ? params._sid.trim() : sid;
            if (wid) source = "params_direct";
        }

        if (!wid) {
            throw new Error("Missing transport context: _ctx._wid");
        }

        if (source !== "ctx" && _x._verbose) {
            _xlog.log(
                `[server-xvm] transport ctx fallback used source=${source} wid=${wid} sid=${sid ?? "-"}`
            );
        }

        return {
            _subscriber_id: sid ?? wid,
            ...(sid ? { _sid: sid } : {}),
            _wid: wid,
        };
    }

    private create_view_scope(app: XVMAppFile, views: Record<string, XVMView>): ViewScope {
        const config = is_plain_object(app._config) ? app._config : {};
        const router = is_plain_object(config._router) ? config._router : {};
        const start = is_plain_object(config._start) ? config._start : {};

        const fallback_view_id = typeof router._fallback_view_id === "string" && router._fallback_view_id.trim()
            ? router._fallback_view_id.trim()
            : undefined;

        const start_view_id = typeof start._view_id === "string" && start._view_id.trim()
            ? start._view_id.trim()
            : undefined;

        return {
            _app_id: app._app_id,
            _env: app._env,
            _allowed_view_ids: new Set(Object.keys(views)),
            _entry_view_id: app._meta._entry_view_id,
            _fallback_view_id: fallback_view_id,
            _start_view_id: start_view_id,
        };
    }

    private get_bundle(app_id: string, env: string): XVMAppBundle {
        const bundle = this._apps.get(app_scope_key(app_id, env));
        if (!bundle) {
            throw new Error(`App not found: app='${app_id}' env='${env}'`);
        }
        return bundle;
    }

    private ensure_params(raw: unknown): Record<string, any> {
        if (!is_plain_object(raw)) return {};
        return raw;
    }

    private resolve_env(params: Record<string, any>): string {
        if (typeof params._env === "string" && params._env.trim()) {
            return params._env.trim();
        }
        return DEFAULT_ENV;
    }

    private app_dir_path(app_id: string, env: string): string {
        return path.join(this._apps_root, env, app_id);
    }

    private persist_bundle(bundle: XVMAppBundle): void {
        const app_dir = this.app_dir_path(bundle._app._app_id, bundle._app._env);
        const views_dir = path.join(app_dir, "views");

        fs.mkdirSync(views_dir, { recursive: true });

        const app_json_path = path.join(app_dir, "app.json");
        this.write_json_file(app_json_path, bundle._app);

        const view_ids = Object.keys(bundle._views).sort();
        for (const view_id of view_ids) {
            const file_path = path.join(views_dir, `${view_id}.json`);
            this.write_json_file(file_path, bundle._views[view_id]);
        }
    }

    private validate_and_normalize_app_file(
        raw: unknown,
        ctx: { _expected_env: string; _expected_app_id: string; _source: string }
    ): XVMAppFile {
        if (!is_plain_object(raw)) {
            throw new Error(`[server-xvm:validate] app file must be object source='${ctx._source}'`);
        }

        this.walk_forbidden_functions(raw, {
            _app_id: ctx._expected_app_id,
            _env: ctx._expected_env,
            _view_id: "app",
            _source: ctx._source,
            _path: "$app",
        });

        const app_id = ensure_string(raw._app_id, "_app_id");
        const env = ensure_string(raw._env, "_env");

        if (app_id !== ctx._expected_app_id) {
            throw new Error(
                `[server-xvm:validate] _app_id mismatch expected='${ctx._expected_app_id}' got='${app_id}' source='${ctx._source}'`
            );
        }
        if (env !== ctx._expected_env) {
            throw new Error(
                `[server-xvm:validate] _env mismatch expected='${ctx._expected_env}' got='${env}' source='${ctx._source}'`
            );
        }

        if (!is_plain_object(raw._meta)) {
            throw new Error(`[server-xvm:validate] app._meta must be object app='${app_id}' source='${ctx._source}'`);
        }
        if (!Number.isFinite(raw._meta._version)) {
            throw new Error(`[server-xvm:validate] app._meta._version must be number app='${app_id}' source='${ctx._source}'`);
        }
        if (!is_plain_object(raw._config)) {
            throw new Error(`[server-xvm:validate] app._config must be object app='${app_id}' source='${ctx._source}'`);
        }

        return {
            _app_id: app_id,
            _env: env,
            _meta: {
                ...raw._meta,
                _version: Number(raw._meta._version),
            },
            _config: raw._config,
        };
    }

    private read_json_file(file_path: string): any {
        const raw = fs.readFileSync(file_path, "utf-8");
        try {
            return JSON.parse(raw);
        } catch (err: any) {
            throw new Error(`Invalid JSON in '${file_path}': ${err?.message ?? err}`);
        }
    }

    private write_json_file(file_path: string, value: any): void {
        fs.writeFileSync(file_path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    }

    private log_boot_error(env: string, app_id: string, file_path: string, message: string) {
        _xlog.error(`[server-xvm:boot-skip] env='${env}' app_id='${app_id}' file='${file_path}' error='${message}'`);
    }

    private validate_view_data(view_data: unknown, ctx: ValidationCtx): void {
        if (!is_plain_object(view_data)) {
            throw new Error(`Invalid view data for app='${ctx._app_id}' view='${ctx._view_id}': expected object`);
        }

        this.walk_and_validate_node(view_data, ctx);
    }

    private walk_forbidden_functions(
        node: unknown,
        ctx: {
            _app_id: string;
            _env: string;
            _view_id: string;
            _source: string;
            _path: string;
        }
    ): void {
        if (typeof node === "function") {
            throw new Error(
                this.validation_error(
                    {
                        _app_id: ctx._app_id,
                        _env: ctx._env,
                        _view_id: ctx._view_id,
                        _path: ctx._path,
                        _source: ctx._source,
                        _scope: {
                            _app_id: ctx._app_id,
                            _env: ctx._env,
                            _allowed_view_ids: new Set<string>(),
                        },
                    },
                    "Functions are forbidden in persisted JSON"
                )
            );
        }

        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i += 1) {
                this.walk_forbidden_functions(node[i], {
                    ...ctx,
                    _path: `${ctx._path}[${i}]`,
                });
            }
            return;
        }

        if (!is_plain_object(node)) return;

        for (const [k, v] of Object.entries(node)) {
            this.walk_forbidden_functions(v, {
                ...ctx,
                _path: `${ctx._path}.${k}`,
            });
        }
    }

    private walk_and_validate_node(node: unknown, ctx: ValidationCtx): void {
        if (typeof node === "function") {
            throw new Error(this.validation_error(ctx, "Functions are forbidden in persisted views"));
        }

        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i += 1) {
                this.walk_and_validate_node(node[i], { ...ctx, _path: `${ctx._path}[${i}]` });
            }
            return;
        }

        if (!is_plain_object(node)) return;

        if (typeof node._op === "string") {
            this.validate_nano_command(node, ctx);
        }

        for (const [key, value] of Object.entries(node)) {
            const next_path = `${ctx._path}.${key}`;

            if (key === "_on") {
                this.validate_on_map(value, { ...ctx, _path: next_path });
                continue;
            }

            if (key.startsWith("_on_")) {
                this.validate_handler_value(value, { ...ctx, _path: next_path });
                continue;
            }

            this.walk_and_validate_node(value, { ...ctx, _path: next_path });
        }
    }

    private validate_on_map(raw: unknown, ctx: ValidationCtx): void {
        if (!is_plain_object(raw)) {
            throw new Error(this.validation_error(ctx, "_on must be an object map"));
        }

        for (const [event_name, handler] of Object.entries(raw)) {
            this.validate_handler_value(handler, { ...ctx, _path: `${ctx._path}.${event_name}` });
        }
    }

    private validate_handler_value(handler: unknown, ctx: ValidationCtx): void {
        if (typeof handler === "function") {
            throw new Error(this.validation_error(ctx, "Handler functions are forbidden"));
        }

        if (typeof handler === "string") {
            this.validate_handler_string(handler, ctx);
            return;
        }

        if (Array.isArray(handler)) {
            for (let i = 0; i < handler.length; i += 1) {
                this.validate_handler_value(handler[i], { ...ctx, _path: `${ctx._path}[${i}]` });
            }
            return;
        }

        if (is_plain_object(handler)) {
            if (typeof handler._op === "string") {
                this.validate_nano_command(handler, ctx);
                return;
            }

            for (const [name, value] of Object.entries(handler)) {
                this.validate_handler_value(value, { ...ctx, _path: `${ctx._path}.${name}` });
            }
            return;
        }

        throw new Error(this.validation_error(ctx, "Handler must be string, command object, or sequence"));
    }

    private validate_handler_string(command_raw: string, ctx: ValidationCtx): void {
        const op = parse_command_name(command_raw);
        if (!op) {
            throw new Error(this.validation_error(ctx, `Invalid command string '${command_raw}'`));
        }

        if (!this._allowed_nano_ops.has(op)) {
            throw new Error(this.validation_error(ctx, `Unknown nano-op '${op}' in command string`));
        }

        if (RISKY_OPS.has(op)) {
            throw new Error(
                this.validation_error(ctx, `Risky op '${op}' must be JSON command with explicit _params policy checks`)
            );
        }
    }

    private validate_nano_command(command: Record<string, any>, ctx: ValidationCtx): void {
        const op = ensure_string(command._op, `${ctx._path}._op`);

        if (!this._allowed_nano_ops.has(op)) {
            throw new Error(this.validation_error(ctx, `Unknown nano-op '${op}'`));
        }

        if (!this._allow_cross_object_mutation) {
            if (typeof command._object === "string" && command._object.trim()) {
                throw new Error(this.validation_error(ctx, "Cross-object mutation is not allowed (_object)"));
            }
            if (
                is_plain_object(command._params) &&
                typeof command._params._object === "string" &&
                command._params._object.trim()
            ) {
                throw new Error(this.validation_error(ctx, "Cross-object mutation is not allowed (_params._object)"));
            }
        }

        this.enforce_risky_op_policy(command, ctx);

        if (is_plain_object(command._params)) {
            this.walk_and_validate_node(command._params, { ...ctx, _path: `${ctx._path}._params` });
        }
    }

    private enforce_risky_op_policy(command: Record<string, any>, ctx: ValidationCtx) {
        const op = command._op;
        const params = is_plain_object(command._params) ? command._params : {};

        if (op === "navigate") {
            if (!this._allow_navigate) {
                throw new Error(this.validation_error(ctx, "'navigate' is disabled by policy"));
            }

            const target_view =
                (typeof params._view_id === "string" && params._view_id.trim()) ||
                (typeof params._view === "string" && params._view.trim());

            if (!target_view) {
                throw new Error(this.validation_error(ctx, "'navigate' requires '_params._view_id' or '_params._view'"));
            }

            const allowed =
                ctx._scope._allowed_view_ids.has(target_view) ||
                target_view === ctx._scope._entry_view_id ||
                target_view === ctx._scope._fallback_view_id ||
                target_view === ctx._scope._start_view_id;

            if (!allowed) {
                throw new Error(this.validation_error(ctx, "navigate target view is outside app scope"));
            }

            if (typeof params._url === "string" && params._url.trim()) {
                throw new Error(this.validation_error(ctx, "'navigate' must not include URL fields"));
            }
        }

        if (op === "open-url") {
            if (!this._allow_open_url) {
                throw new Error(this.validation_error(ctx, "'open-url' is disabled by policy"));
            }

            if (!is_plain_object(command._params)) {
                throw new Error(this.validation_error(ctx, "'open-url' requires '_params' object"));
            }

            const raw_url = ensure_string(params._url, `${ctx._path}._params._url`);

            if (raw_url.startsWith("/")) {
                return;
            }

            let parsed: URL;
            try {
                parsed = new URL(raw_url);
            } catch {
                throw new Error(this.validation_error(ctx, `Invalid URL '${raw_url}'`));
            }

            if (parsed.protocol !== "https:") {
                throw new Error(this.validation_error(ctx, "'open-url' must use https protocol"));
            }

            const host = parsed.hostname.toLowerCase();
            if (!this._allowed_open_url_hosts.has(host)) {
                throw new Error(this.validation_error(ctx, `URL host '${host}' is not in allowlist`));
            }
        }
    }

    private validation_error(ctx: ValidationCtx, message: string): string {
        return `[server-xvm:validate] app='${ctx._app_id}' env='${ctx._env}' view='${ctx._view_id}' source='${ctx._source}' path='${ctx._path}' ${message}`;
    }
}

export default ServerXVMModule;
