import fs from "node:fs";
import path from "node:path";
import { XModule, type XCommand, _x, _xlog } from "@xpell/core";
import { _xem } from "../XEM/XEventManager.js";

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
    "show", "hide", "toggle", "add-class", "remove-class", "toggle-class",
    "set-text", "set-text-from-data", "set-attr", "set-data", "set-value",
    "clear-value", "focus", "blur", "fire", "navigate", "open-url", "noop",
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
        this._allow_open_url = opts._allow_open_url === true;
        this._allowed_open_url_hosts = new Set(
            (opts._allowed_open_url_hosts ?? []).map(h => h.trim().toLowerCase()).filter(Boolean)
        );

        this._send_wormholes_event = opts._send_wormholes_event;
    }

    // ✅ NEW OPS
    async _create_app(xcmd: XCommand) { return this.create_app_impl(xcmd); }
    async _op_create_app(xcmd: XCommand) { return this.create_app_impl(xcmd); }

    private create_app_impl(xcmd: XCommand) {
        const params = this.ensure_params(xcmd?._params);

        const app_id = ensure_string(params._app_id, "_app_id");
        const env = this.resolve_env(params);

        const existing = this._apps.get(app_scope_key(app_id, env));
        if (existing) {
            return { _ok: true, _app: existing._app, _created: false };
        }

        const name = typeof params._name === "string" ? params._name : app_id;

        const app_file: XVMAppFile = {
            _app_id: app_id,
            _env: env,
            _meta: {
                _name: name,
                _version: 1,
                _updated_at: to_iso_now(),
            },
            _config: {},
        };

        const bundle: XVMAppBundle = {
            _app: app_file,
            _views: {},
        };

        this._apps.set(app_scope_key(app_id, env), bundle);
        this.persist_bundle(bundle);

        _xlog.log(`[server-xvm] created app app=${app_id} env=${env}`);

        return { _ok: true, _app: app_file, _created: true };
    }

    // ---------------- EXISTING CODE (UNCHANGED BELOW) ----------------

    async init_on_boot(): Promise<{ _apps_loaded: number; _views_loaded: number }> {
        fs.mkdirSync(this._apps_root, { recursive: true });
        this._apps.clear();
        this._subscriptions.clear();
        return { _apps_loaded: 0, _views_loaded: 0 };
    }

    async _push_update(xcmd: XCommand) { return this.push_update_impl(xcmd); }
    async _op_push_update(xcmd: XCommand) { return this.push_update_impl(xcmd); }

    private async push_update_impl(xcmd: XCommand) {
        const params = this.ensure_params(xcmd?._params);
        const app_id = ensure_string(params._app_id, "_app_id");
        const env = this.resolve_env(params);

        const view_data = params._view;
        if (!is_plain_object(view_data)) throw new Error("Missing '_view'");

        const view_id = ensure_string(view_data._id, "_view._id");

        const bundle = this.get_bundle(app_id, env);

        const normalized_view: XVMView = {
            ...view_data,
            _id: view_id,
        };

        bundle._views[view_id] = normalized_view; bundle._app._meta._version += 1;

        this.persist_bundle(bundle);

        return {
            _ok: true,
            _app_id: app_id,
            _env: env,
            _view_id: view_id,
            _version: bundle._app._meta._version,
            _notified_subscribers: [],
        };
    }

    private get_bundle(app_id: string, env: string): XVMAppBundle {
        const bundle = this._apps.get(app_scope_key(app_id, env));
        if (!bundle) throw new Error(`App not found: ${app_id}`);
        return bundle;
    }

    private ensure_params(raw: unknown): Record<string, any> {
        return is_plain_object(raw) ? raw : {};
    }

    private resolve_env(params: Record<string, any>): string {
        return typeof params._env === "string" ? params._env : DEFAULT_ENV;
    }

    private persist_bundle(bundle: XVMAppBundle): void {
        const dir = path.join(this._apps_root, bundle._app._env, bundle._app._app_id);
        fs.mkdirSync(path.join(dir, "views"), { recursive: true });

        fs.writeFileSync(
            path.join(dir, "app.json"),
            JSON.stringify(bundle._app, null, 2)
        );
    }
}

export default ServerXVMModule;