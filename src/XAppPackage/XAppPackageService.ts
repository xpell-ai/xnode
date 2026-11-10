import fs from "node:fs";
import path from "node:path";
import { XError, _x, _xlog } from "@xpell/core";
import {
  DEFAULT_XAPP_UPLOAD_MAX_BYTES,
  consume_xapp_package_ref,
  register_xapp_download,
  resolve_xapp_package_ref,
  store_xapp_upload,
  XAPP_CONTENT_TYPE,
  type XAppDownloadTransfer,
  type XAppPackageRefResolution,
} from "./XAppDownloadTransfer.js";
import {
  create_xapp_zip,
  inspect_xapp_zip,
  verify_xapp_inventory_hashes,
  type XAppArchiveFile,
} from "./XAppArchive.js";
import {
  DEFAULT_XAPP_LIMITS,
  XAPP_FORMAT,
  XAPP_FORMAT_VERSION,
  calculate_manifest_self_hash,
  finalize_xapp_manifest,
  infer_xapp_file_kind,
  is_allowed_xapp_path,
  is_safe_xapp_segment,
  normalize_xapp_package_path,
  sha256_buffer,
  stable_json_buffer,
  validate_xapp_manifest_shape,
  type XAppManifest,
  type XAppManifestFile,
  type XAppPackageLimits,
  type XAppValidationIssue,
} from "./XAppManifest.js";
import type { XVMAppBundle, XVMAppFile, XVMFlow, XVMView } from "../XVM/ServerXVMModule.js";

export type XAppPackageServerAdapter = {
  _work_folder: string;
  _apps_root: string;
  _get_bundle(app_id: string, env: string): XVMAppBundle;
  _resolve_user_app_dir(env: string, app_id: string): string;
  _validate_bundle(bundle: XVMAppBundle): void;
  _load_app_from_disk(app_id: string, env: string, options?: { _expected_replace?: boolean }): Promise<unknown>;
  _read_loaded_bundle(app_id: string, env: string): XVMAppBundle;
};

export type XAppPackageServiceOptions = {
  _work_folder: string;
  _apps_root: string;
  _server: XAppPackageServerAdapter;
  _limits?: Partial<XAppPackageLimits>;
};

type StagedImport = {
  _staging_root: string;
  _runtime_app_dir: string;
  _runtime_public_dir: string;
  _target_app_id: string;
  _env: string;
  _manifest: XAppManifest;
  _bundle: XVMAppBundle;
  _package_sha256: string;
  _package_ref?: string;
  _warnings: string[];
  _public_files: Map<string, Buffer>;
};

type XAppPackageSource = {
  _package_path: string;
  _package_ref?: string;
  _filename?: string;
  _size?: number;
  _sha256?: string;
};

const DEFAULT_ENV = "default";
const XAPP_FOLDER = ".xapp";
const XAPP_EXPORTS_FOLDER = "exports";
const XAPP_STAGING_FOLDER = "staging";
const XAPP_SNAPSHOT_FOLDER = "snapshots";
const PACKAGE_OWNED_APP_ENTRIES = ["app.json", "views", "flows", "entities"] as const;
const PACKAGE_OWNED_PUBLIC_ENTRIES = ["assets", "style"] as const;

function clone_json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function now_id(prefix: string): string {
  return `${prefix}-${Date.now()}-${process.pid}`;
}

function read_json_bytes(bytes: Buffer, package_path: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf-8"));
  } catch (error) {
    throw new XError("E_XAPP_INVALID_JSON", `Invalid JSON file in package: ${package_path}`, {
      _meta: {
        _path: package_path,
        _error: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

function write_json_file(file_path: string, value: unknown) {
  fs.mkdirSync(path.dirname(file_path), { recursive: true });
  fs.writeFileSync(file_path, stable_json_buffer(value));
}

function write_bytes_file(file_path: string, bytes: Buffer) {
  fs.mkdirSync(path.dirname(file_path), { recursive: true });
  fs.writeFileSync(file_path, bytes);
}

function safe_resolve_under(root: string, relative_path: string, code = "E_XAPP_INVALID_PATH"): string {
  const resolved = path.resolve(root, relative_path);
  const relative = path.relative(path.resolve(root), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new XError(code, "Path escapes allowed root", {
      _meta: { _root: root, _path: relative_path },
    });
  }
  return resolved;
}

function collect_files_recursive(root: string, prefix: "assets" | "style", limits: XAppPackageLimits): XAppArchiveFile[] {
  if (!fs.existsSync(root)) return [];
  const out: XAppArchiveFile[] = [];

  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
      const package_path = `${prefix}/${relative}`;

      if (!is_allowed_xapp_path(package_path)) {
        throw new XError("E_XAPP_INVALID_PUBLIC_PATH", "Public file path is not allowed in .xapp", {
          _meta: { _path: package_path },
        });
      }

      if (entry.isSymbolicLink()) {
        throw new XError("E_XAPP_UNSAFE_PUBLIC_FILE", "Symlinks are not allowed in .xapp public files", {
          _meta: { _path: package_path },
        });
      }

      if (entry.isDirectory()) {
        visit(absolute);
        return;
      }

      if (!entry.isFile()) return;
      const bytes = fs.readFileSync(absolute);
      if (bytes.length > limits._max_file_bytes) {
        throw new XError("E_XAPP_PUBLIC_FILE_TOO_LARGE", "Public file exceeds .xapp file size limit", {
          _meta: { _path: package_path },
        });
      }
      out.push({ _path: package_path, _bytes: bytes });
    }
  };

  visit(root);
  return out;
}

function replace_public_refs(value: unknown, replacements: Array<[string, string]>): unknown {
  if (typeof value === "string") {
    for (const [from, to] of replacements) {
      if (value === from || value.startsWith(`${from}/`)) {
        return `${to}${value.slice(from.length)}`;
      }
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => replace_public_refs(item, replacements));
  }

  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = replace_public_refs(child, replacements);
    }
    return out;
  }

  return value;
}

function public_to_portable_refs(app_id: string, value: unknown): unknown {
  return replace_public_refs(value, [
    [`/public/${app_id}/assets`, "assets"],
    [`/public/${app_id}/style`, "style"],
  ]);
}

function portable_to_public_refs(app_id: string, value: unknown): unknown {
  return replace_public_refs(value, [
    ["assets", `/public/${app_id}/assets`],
    ["style", `/public/${app_id}/style`],
  ]);
}

function rewrite_structured_scope_refs(input: {
  _value: unknown;
  _source_app_id: string;
  _source_env: string;
  _target_app_id: string;
  _target_env: string;
}): unknown {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map((item) => visit(item));
    }

    if (!value || typeof value !== "object") {
      return value;
    }

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (
        key === "_app_id" &&
        typeof child === "string" &&
        child === input._source_app_id
      ) {
        out[key] = input._target_app_id;
        continue;
      }
      if (
        key === "_env" &&
        typeof child === "string" &&
        child === input._source_env
      ) {
        out[key] = input._target_env;
        continue;
      }
      out[key] = visit(child);
    }
    return out;
  };

  return visit(input._value);
}

function diff_ids(previous: string[], next: string[]) {
  const old_set = new Set(previous);
  const next_set = new Set(next);
  return {
    _added: next.filter((id) => !old_set.has(id)).sort(),
    _modified: next.filter((id) => old_set.has(id)).sort(),
    _deleted: previous.filter((id) => !next_set.has(id)).sort(),
  };
}

function hash_record_values(values: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values || {})) {
    out[key] = sha256_buffer(stable_json_buffer(value));
  }
  return out;
}

function diff_artifact_records(previous: Record<string, unknown>, next: Record<string, unknown>) {
  const previous_hashes = hash_record_values(previous);
  const next_hashes = hash_record_values(next);
  const ids = diff_ids(Object.keys(previous_hashes), Object.keys(next_hashes));
  return {
    _added: ids._added,
    _modified: Object.keys(next_hashes)
      .filter((id) => previous_hashes[id] && previous_hashes[id] !== next_hashes[id])
      .sort(),
    _deleted: ids._deleted,
  };
}

function list_public_files(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!fs.existsSync(root)) return out;

  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
        return;
      }
      if (!entry.isFile()) return;
      const relative = path.relative(root, absolute).replaceAll(path.sep, "/");
      out[relative] = sha256_buffer(fs.readFileSync(absolute));
    }
  };
  visit(root);
  return out;
}

export class XAppPackageService {
  private _work_folder: string;
  private _apps_root: string;
  private _server: XAppPackageServerAdapter;
  private _limits: XAppPackageLimits;

  constructor(options: XAppPackageServiceOptions) {
    this._work_folder = options._work_folder;
    this._apps_root = options._apps_root;
    this._server = options._server;
    this._limits = {
      ...DEFAULT_XAPP_LIMITS,
      ...(options._limits ?? {}),
    };
  }

  async export_app(params: Record<string, any>) {
    const app_id = this.resolve_segment(params._app_id, "_app_id");
    const env = this.resolve_env(params._env);
    const output_path = this.resolve_export_path(params._output_path, app_id);
    const include_public = params._include_public !== false;
    const bundle = this._server._get_bundle(app_id, env);

    this._server._validate_bundle(bundle);

    const files: XAppArchiveFile[] = [];
    const portable_app = public_to_portable_refs(app_id, clone_json(bundle._app));
    files.push({ _path: "app.json", _bytes: stable_json_buffer(portable_app) });

    for (const view_id of Object.keys(bundle._views || {}).sort()) {
      files.push({
        _path: `views/${view_id}.json`,
        _bytes: stable_json_buffer(public_to_portable_refs(app_id, bundle._views[view_id])),
      });
    }
    for (const flow_id of Object.keys(bundle._flows || {}).sort()) {
      files.push({
        _path: `flows/${flow_id}.json`,
        _bytes: stable_json_buffer(public_to_portable_refs(app_id, bundle._flows[flow_id])),
      });
    }
    for (const entity_id of Object.keys(bundle._entities || {}).sort()) {
      files.push({
        _path: `entities/${entity_id}.json`,
        _bytes: stable_json_buffer(bundle._entities[entity_id]),
      });
    }

    if (include_public) {
      const public_root = this.public_app_root(app_id);
      files.push(...collect_files_recursive(path.join(public_root, "assets"), "assets", this._limits));
      files.push(...collect_files_recursive(path.join(public_root, "style"), "style", this._limits));
    }

    this.assert_file_limits(files);

    const inventory: XAppManifestFile[] = files
      .map((file) => {
        const kind = infer_xapp_file_kind(file._path);
        if (!kind) {
          throw new XError("E_XAPP_INVALID_EXPORT_PATH", "Exported file path is not allowed", {
            _meta: { _path: file._path },
          });
        }
        return {
          _path: file._path,
          _kind: kind,
          _size: file._bytes.length,
          _sha256: sha256_buffer(file._bytes),
        };
      })
      .sort((a, b) => a._path.localeCompare(b._path));

    const manifest: XAppManifest = {
      _format: XAPP_FORMAT,
      _format_version: XAPP_FORMAT_VERSION,
      _app: {
        _app_id: app_id,
        _name: bundle._app._meta?._name ?? app_id,
        _version: String(bundle._app._meta?._app_version ?? bundle._app._meta?._version ?? "1.0.0"),
        _entry_view_id: bundle._app._meta?._entry_view_id,
      },
      _content: {
        _files: inventory,
      },
      _build: {
        _created_at: new Date(0).toISOString(),
        _source_app_id: app_id,
        _source_env: env,
      },
    };

    const finalized = finalize_xapp_manifest(manifest);
    files.push({ _path: "manifest.json", _bytes: finalized._bytes });

    const archive = create_xapp_zip(files);
    fs.mkdirSync(path.dirname(output_path), { recursive: true });
    fs.writeFileSync(output_path, archive);
    const package_hash = sha256_buffer(archive);
    const filename = `${app_id}.xapp`;
    const zip_magic_ok = archive.length >= 2 && archive[0] === 0x50 && archive[1] === 0x4b;

    _xlog.log("[xapp] export archive prepared", {
      _app_id: app_id,
      _env: env,
      _filename: filename,
      _size: archive.length,
      _sha256: package_hash,
      _zip_magic_ok: zip_magic_ok,
    });

    const transfer: XAppDownloadTransfer = register_xapp_download({
      _file_path: output_path,
      _filename: filename,
      _content_type: XAPP_CONTENT_TYPE,
      _sha256: package_hash,
      _delete_on_expire: params._output_path === undefined || params._output_path === null || params._output_path === "",
      _base_url: params._download_base_url,
    });

    _xlog.log("[xapp] export transfer prepared", {
      _filename: filename,
      _size: archive.length,
      _sha256: package_hash,
      _transfer_mode: transfer._type,
    });

    return {
      _ok: true,
      _result: {
        _filename: filename,
        _content_type: XAPP_CONTENT_TYPE,
        _package_type: "xapp",
        _size: archive.length,
        _sha256: package_hash,
        _download: transfer,
        _download_url: transfer._url,
        _download_path: transfer._path,
        _file_count: files.length,
        _manifest: finalized._manifest,
        _warnings: [],
      },
    };
  }

  upload_app_package(params: Record<string, any>) {
    const upload_params = this.resolve_upload_params(params);
    const upload = store_xapp_upload({
      _work_folder: this._work_folder,
      _filename: upload_params._filename,
      _bytes: upload_params._bytes,
      _max_bytes: DEFAULT_XAPP_UPLOAD_MAX_BYTES,
    });

    return {
      _ok: true,
      _result: upload,
    };
  }

  inspect_app_package(params: Record<string, any>) {
    const source = this.resolve_package_source(params);
    const package_path = source._package_path;
    const archive_bytes = fs.readFileSync(package_path);
    const package_hash = sha256_buffer(archive_bytes);
    const inspection = this.inspect_archive_bytes(archive_bytes);

    if (!inspection._ok) {
      return {
        _ok: false,
        _result: {
          ...this.package_source_response(source),
          _sha256: package_hash,
          _errors: inspection._issues,
        },
      };
    }

    return {
      _ok: true,
      _result: {
        ...this.package_source_response(source),
        _sha256: package_hash,
        _manifest: inspection._manifest,
        _app: inspection._manifest._app,
        _file_count: inspection._files.size,
        _warnings: [],
      },
    };
  }

  async preview_app_import(params: Record<string, any>) {
    const staged = await this.stage_import(params);
    const changes = this.calculate_changes(staged);
    this.cleanup(staged._staging_root);
    return {
      _ok: true,
      _result: {
        _target_app_id: staged._target_app_id,
        _env: staged._env,
        _package_sha256: staged._package_sha256,
        _manifest: staged._manifest,
        _changes: changes,
        _warnings: staged._warnings,
      },
    };
  }

  async import_app(params: Record<string, any>) {
    const mode = this.resolve_import_mode(params._mode);
    const staged = await this.stage_import(params);
    const target_app_dir = this._server._resolve_user_app_dir(staged._env, staged._target_app_id);
    const target_public_dir = this.public_app_root(staged._target_app_id);
    const existing_app = fs.existsSync(target_app_dir);

    if (mode === "create" && existing_app) {
      this.cleanup(staged._staging_root);
      throw new XError("E_XAPP_IMPORT_TARGET_EXISTS", "Target app already exists");
    }
    if (mode === "replace" && !existing_app) {
      this.cleanup(staged._staging_root);
      throw new XError("E_XAPP_IMPORT_TARGET_MISSING", "Target app does not exist");
    }

    const snapshot_root = path.join(this.work_xapp_root(), XAPP_SNAPSHOT_FOLDER, now_id("snapshot"));
    const app_snapshot = path.join(snapshot_root, "app");
    const public_snapshot = path.join(snapshot_root, "public");
    let app_snapshot_taken = false;
    let public_snapshot_taken = false;
    let package_owned_app_applied = false;
    let package_owned_public_applied = false;
    let created_target_app = false;
    const previous_bundle = existing_app
      ? this.read_bundle_from_app_dir(target_app_dir, staged._env, staged._target_app_id)
      : undefined;

    try {
      fs.mkdirSync(snapshot_root, { recursive: true });

      if (existing_app) {
        this.snapshot_package_owned_app_entries(target_app_dir, app_snapshot);
        this.snapshot_package_owned_public_entries(target_public_dir, public_snapshot);
        app_snapshot_taken = true;
        public_snapshot_taken = true;

        this.apply_package_owned_app_entries(staged._runtime_app_dir, target_app_dir);
        package_owned_app_applied = true;
      } else {
        fs.mkdirSync(path.dirname(target_app_dir), { recursive: true });
        fs.renameSync(staged._runtime_app_dir, target_app_dir);
        created_target_app = true;
      }

      if (!public_snapshot_taken && fs.existsSync(target_public_dir)) {
        this.snapshot_package_owned_public_entries(target_public_dir, public_snapshot);
        public_snapshot_taken = true;
      }

      this.apply_package_owned_public_entries(staged._runtime_public_dir, target_public_dir);
      package_owned_public_applied = true;

      if (previous_bundle) {
        await this.try_unregister_removed_entities(previous_bundle, staged._bundle);
      }
      await this._server._load_app_from_disk(staged._target_app_id, staged._env, {
        _expected_replace: existing_app,
      });

      this.cleanup(staged._staging_root);
      this.cleanup(snapshot_root);
      if (staged._package_ref) {
        consume_xapp_package_ref(staged._package_ref, "import");
      }

      return {
        _ok: true,
        _result: {
          _app_id: staged._target_app_id,
          _env: staged._env,
          _package_sha256: staged._package_sha256,
          _reloaded: true,
          _mode: existing_app ? "replace" : "create",
          _previous_entity_ids: previous_bundle ? Object.keys(previous_bundle._entities || {}) : [],
          _warnings: staged._warnings,
        },
      };
    } catch (error) {
      const rollback = await this.rollback_activation({
        _target_app_dir: target_app_dir,
        _target_public_dir: target_public_dir,
        _app_snapshot: app_snapshot,
        _public_snapshot: public_snapshot,
        _existing_app: existing_app,
        _app_snapshot_taken: app_snapshot_taken,
        _public_snapshot_taken: public_snapshot_taken,
        _package_owned_app_applied: package_owned_app_applied,
        _package_owned_public_applied: package_owned_public_applied,
        _created_target_app: created_target_app,
        _app_id: staged._target_app_id,
        _env: staged._env,
      });
      this.cleanup(staged._staging_root);
      throw new XError("E_XAPP_IMPORT_FAILED", "App import failed and rollback was attempted", {
        _meta: {
          _error: error instanceof Error ? error.message : String(error),
          _rollback: rollback,
        },
      });
    }
  }

  private inspect_archive_bytes(archive_bytes: Buffer): {
    _ok: boolean;
    _manifest: XAppManifest;
    _files: Map<string, Buffer>;
    _issues: XAppValidationIssue[];
  } {
    const zip = inspect_xapp_zip(archive_bytes, this._limits);
    const files = zip._files;
    const issues = [...zip._issues];
    const manifest_bytes = files.get("manifest.json");

    if (!manifest_bytes) {
      issues.push({
        _code: "E_XAPP_MISSING_MANIFEST",
        _message: "Package is missing manifest.json",
        _path: "manifest.json",
      });
      return { _ok: false, _manifest: {} as XAppManifest, _files: files, _issues: issues };
    }

    let raw_manifest: unknown;
    try {
      raw_manifest = read_json_bytes(manifest_bytes, "manifest.json");
    } catch (error) {
      issues.push({
        _code: "E_XAPP_INVALID_MANIFEST_JSON",
        _message: error instanceof Error ? error.message : String(error),
        _path: "manifest.json",
      });
      return { _ok: false, _manifest: {} as XAppManifest, _files: files, _issues: issues };
    }

    const manifest_result = validate_xapp_manifest_shape(raw_manifest);
    issues.push(...manifest_result._issues);
    if (!manifest_result._manifest) {
      return { _ok: false, _manifest: {} as XAppManifest, _files: files, _issues: issues };
    }

    const manifest_self_hash = calculate_manifest_self_hash(manifest_result._manifest);
    issues.push(...verify_xapp_inventory_hashes({
      _files: files,
      _inventory: manifest_result._manifest._content._files,
      _manifest_self_hash: manifest_self_hash,
    }));

    return {
      _ok: issues.length === 0,
      _manifest: manifest_result._manifest,
      _files: files,
      _issues: issues,
    };
  }

  private async stage_import(params: Record<string, any>): Promise<StagedImport> {
    const source = this.resolve_package_source(params);
    const package_path = source._package_path;
    const archive_bytes = fs.readFileSync(package_path);
    const package_sha256 = sha256_buffer(archive_bytes);
    const inspected = this.inspect_archive_bytes(archive_bytes);

    if (!inspected._ok) {
      throw new XError("E_XAPP_INVALID_PACKAGE", "Package validation failed", {
        _meta: { _errors: inspected._issues },
      });
    }

    const target_app_id =
      params._target_app_id === undefined || params._target_app_id === null || params._target_app_id === ""
        ? inspected._manifest._app._app_id
        : this.resolve_segment(params._target_app_id, "_target_app_id");
    const env = this.resolve_env(params._env);
    const staging_root = path.join(this.work_xapp_root(), XAPP_STAGING_FOLDER, now_id("import"));
    const runtime_app_dir = path.join(staging_root, "runtime", "app");
    const runtime_public_dir = path.join(staging_root, "runtime", "public", target_app_id);
    const warnings: string[] = [];
    const source_app_id = inspected._manifest._build._source_app_id;
    const source_env = inspected._manifest._build._source_env;
    const app_file = this.rewrite_import_app_json(
      read_json_bytes(this.required_file(inspected._files, "app.json"), "app.json"),
      target_app_id,
      env,
      source_app_id,
      source_env,
    );

    const views: Record<string, XVMView> = {};
    const flows: Record<string, XVMFlow> = {};
    const entities: Record<string, any> = {};
    const public_files = new Map<string, Buffer>();

    for (const [package_path_name, bytes] of inspected._files.entries()) {
      if (package_path_name === "manifest.json" || package_path_name === "app.json") continue;

      if (package_path_name.startsWith("views/")) {
        const artifact = this.rewrite_import_runtime_artifact({
          _artifact: read_json_bytes(bytes, package_path_name),
          _source_app_id: source_app_id,
          _source_env: source_env,
          _target_app_id: target_app_id,
          _target_env: env,
        }) as XVMView;
        views[String(artifact._id)] = artifact;
        write_json_file(path.join(runtime_app_dir, package_path_name), artifact);
      } else if (package_path_name.startsWith("flows/")) {
        const artifact = this.rewrite_import_runtime_artifact({
          _artifact: read_json_bytes(bytes, package_path_name),
          _source_app_id: source_app_id,
          _source_env: source_env,
          _target_app_id: target_app_id,
          _target_env: env,
        }) as XVMFlow;
        flows[String(artifact._id)] = artifact;
        write_json_file(path.join(runtime_app_dir, package_path_name), artifact);
      } else if (package_path_name.startsWith("entities/")) {
        const artifact = read_json_bytes(bytes, package_path_name) as Record<string, any>;
        const entity = (artifact as any)?._entity ?? artifact;
        entities[String(entity._id)] = entity;
        write_json_file(path.join(runtime_app_dir, package_path_name), entity);
      } else if (package_path_name.startsWith("assets/") || package_path_name.startsWith("style/")) {
        const target_public_file = safe_resolve_under(runtime_public_dir, package_path_name);
        write_bytes_file(target_public_file, bytes);
        public_files.set(package_path_name, bytes);
      }
    }

    write_json_file(path.join(runtime_app_dir, "app.json"), app_file);

    const bundle: XVMAppBundle = {
      _app: app_file,
      _views: views,
      _flows: flows,
      _entities: entities,
    };

    this._server._validate_bundle(bundle);
    warnings.push(...this.entity_change_warnings(target_app_id, env, entities));

    return {
      _staging_root: staging_root,
      _runtime_app_dir: runtime_app_dir,
      _runtime_public_dir: runtime_public_dir,
      _target_app_id: target_app_id,
      _env: env,
      _manifest: inspected._manifest,
      _bundle: bundle,
      _package_sha256: package_sha256,
      _package_ref: source._package_ref,
      _warnings: warnings,
      _public_files: public_files,
    };
  }

  private rewrite_import_app_json(
    raw_app: unknown,
    target_app_id: string,
    env: string,
    source_app_id: string,
    source_env: string,
  ): XVMAppFile {
    const rewritten =
      rewrite_structured_scope_refs({
        _value: portable_to_public_refs(target_app_id, raw_app),
        _source_app_id: source_app_id,
        _source_env: source_env,
        _target_app_id: target_app_id,
        _target_env: env,
      });
    const app = rewritten && typeof rewritten === "object" && !Array.isArray(rewritten)
      ? rewritten as Record<string, any>
      : {};
    const meta = app._meta && typeof app._meta === "object" && !Array.isArray(app._meta)
      ? app._meta
      : {};

    return {
      ...app,
      _app_id: target_app_id,
      _env: env,
      _system: false,
      _meta: {
        ...meta,
        _version: typeof meta._version === "number" ? meta._version : 1,
        _entry_view_id: typeof meta._entry_view_id === "string" && meta._entry_view_id
          ? meta._entry_view_id
          : "view-main",
        _updated_at: new Date().toISOString(),
      },
      _config: app._config && typeof app._config === "object" && !Array.isArray(app._config)
        ? app._config
        : {},
    };
  }

  private calculate_changes(staged: StagedImport) {
    let previous: XVMAppBundle | undefined;
    try {
      previous = this._server._get_bundle(staged._target_app_id, staged._env);
    } catch {
      previous = undefined;
    }

    const public_root = this.public_app_root(staged._target_app_id);
    const current_public = list_public_files(public_root);
    const staged_public: Record<string, string> = {};
    for (const [package_path, bytes] of staged._public_files.entries()) {
      staged_public[package_path] = sha256_buffer(bytes);
    }

    return {
      _views: diff_artifact_records(previous?._views ?? {}, staged._bundle._views),
      _flows: diff_artifact_records(previous?._flows ?? {}, staged._bundle._flows),
      _entities: diff_artifact_records(previous?._entities ?? {}, staged._bundle._entities),
      _public_files: {
        _added: Object.keys(staged_public).filter((id) => !current_public[id]).sort(),
        _modified: Object.keys(staged_public)
          .filter((id) => current_public[id] && current_public[id] !== staged_public[id])
          .sort(),
        _deleted: Object.keys(current_public).filter((id) => !staged_public[id]).sort(),
      },
    };
  }

  private rewrite_import_runtime_artifact(input: {
    _artifact: unknown;
    _source_app_id: string;
    _source_env: string;
    _target_app_id: string;
    _target_env: string;
  }): unknown {
    return rewrite_structured_scope_refs({
      _value: portable_to_public_refs(input._target_app_id, input._artifact),
      _source_app_id: input._source_app_id,
      _source_env: input._source_env,
      _target_app_id: input._target_app_id,
      _target_env: input._target_env,
    });
  }

  private async try_unregister_removed_entities(previous: XVMAppBundle, next_bundle: XVMAppBundle): Promise<XVMAppBundle | undefined> {
    if (!previous) return undefined;
    const next_ids = new Set(Object.keys(next_bundle._entities || {}));
    const removed = Object.keys(previous._entities || {}).filter((id) => !next_ids.has(id));

    for (const entity_id of removed) {
      const response = await _x.execute({
        _module: "entity-manager",
        _op: "unregister",
        _params: {
          _app_id: next_bundle._app._app_id,
          _env: next_bundle._app._env,
          _entity_id: entity_id,
        },
      });
      if (!response?._ok) {
        throw new XError("E_XAPP_ENTITY_UNREGISTER_FAILED", "Failed to unregister removed entity definition", {
          _meta: { _entity_id: entity_id, _response: response },
        });
      }
    }
    return previous;
  }

  private read_bundle_from_app_dir(app_dir: string, env: string, app_id: string): XVMAppBundle | undefined {
    const app_file = path.join(app_dir, "app.json");
    if (!fs.existsSync(app_file)) return undefined;

    const read_dir = (folder: string) => {
      const out: Record<string, any> = {};
      const dir = path.join(app_dir, folder);
      if (!fs.existsSync(dir)) return out;
      for (const file of fs.readdirSync(dir).filter((item) => item.endsWith(".json"))) {
        const raw = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
        const artifact = raw?._entity ?? raw;
        if (artifact?._id) out[artifact._id] = artifact;
      }
      return out;
    };

    return {
      _app: {
        ...JSON.parse(fs.readFileSync(app_file, "utf-8")),
        _app_id: app_id,
        _env: env,
      },
      _views: read_dir("views"),
      _flows: read_dir("flows"),
      _entities: read_dir("entities"),
    };
  }

  private async rollback_activation(input: {
    _target_app_dir: string;
    _target_public_dir: string;
    _app_snapshot: string;
    _public_snapshot: string;
    _existing_app: boolean;
    _app_snapshot_taken: boolean;
    _public_snapshot_taken: boolean;
    _package_owned_app_applied: boolean;
    _package_owned_public_applied: boolean;
    _created_target_app: boolean;
    _app_id: string;
    _env: string;
  }) {
    const result: Record<string, any> = { _attempted: true, _ok: false };
    try {
      if (input._created_target_app) {
        this.cleanup(input._target_app_dir);
      } else if (input._package_owned_app_applied && input._app_snapshot_taken) {
        this.restore_package_owned_app_entries(input._app_snapshot, input._target_app_dir);
      }
      if (input._package_owned_public_applied) {
        this.restore_package_owned_public_entries(input._public_snapshot_taken ? input._public_snapshot : undefined, input._target_public_dir);
      }
      if (input._existing_app) {
        try {
          await this._server._load_app_from_disk(input._app_id, input._env);
        } catch (error) {
          _xlog.warn("[xapp] rollback reload failed", {
            _app_id: input._app_id,
            _env: input._env,
            _error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      result._ok = true;
    } catch (error) {
      result._error = error instanceof Error ? error.message : String(error);
    }
    return result;
  }

  private snapshot_package_owned_app_entries(target_app_dir: string, snapshot_dir: string) {
    fs.mkdirSync(snapshot_dir, { recursive: true });
    for (const entry of PACKAGE_OWNED_APP_ENTRIES) {
      this.copy_existing_path(path.join(target_app_dir, entry), path.join(snapshot_dir, entry));
    }
  }

  private snapshot_package_owned_public_entries(target_public_dir: string, snapshot_dir: string) {
    fs.mkdirSync(snapshot_dir, { recursive: true });
    for (const entry of PACKAGE_OWNED_PUBLIC_ENTRIES) {
      this.copy_existing_path(path.join(target_public_dir, entry), path.join(snapshot_dir, entry));
    }
  }

  private apply_package_owned_app_entries(staged_app_dir: string, target_app_dir: string) {
    const staged_app_file = path.join(staged_app_dir, "app.json");
    if (!fs.existsSync(staged_app_file)) {
      throw new XError("E_XAPP_STAGED_APP_MISSING", "Staged import is missing app.json");
    }

    fs.mkdirSync(target_app_dir, { recursive: true });
    for (const entry of PACKAGE_OWNED_APP_ENTRIES) {
      this.replace_path_from_stage(path.join(staged_app_dir, entry), path.join(target_app_dir, entry));
    }
  }

  private apply_package_owned_public_entries(staged_public_dir: string, target_public_dir: string) {
    fs.mkdirSync(target_public_dir, { recursive: true });
    for (const entry of PACKAGE_OWNED_PUBLIC_ENTRIES) {
      this.replace_path_from_stage(path.join(staged_public_dir, entry), path.join(target_public_dir, entry));
    }
  }

  private restore_package_owned_app_entries(snapshot_dir: string, target_app_dir: string) {
    fs.mkdirSync(target_app_dir, { recursive: true });
    for (const entry of PACKAGE_OWNED_APP_ENTRIES) {
      this.replace_path_from_stage(path.join(snapshot_dir, entry), path.join(target_app_dir, entry));
    }
  }

  private restore_package_owned_public_entries(snapshot_dir: string | undefined, target_public_dir: string) {
    fs.mkdirSync(target_public_dir, { recursive: true });
    for (const entry of PACKAGE_OWNED_PUBLIC_ENTRIES) {
      this.replace_path_from_stage(snapshot_dir ? path.join(snapshot_dir, entry) : undefined, path.join(target_public_dir, entry));
    }
  }

  private copy_existing_path(from: string, to: string) {
    if (!fs.existsSync(from)) return;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
  }

  private replace_path_from_stage(from: string | undefined, to: string) {
    this.cleanup(to);
    if (!from || !fs.existsSync(from)) return;
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.cpSync(from, to, { recursive: true });
  }

  private entity_change_warnings(app_id: string, env: string, next_entities: Record<string, any>): string[] {
    const warnings: string[] = [];
    let previous: XVMAppBundle | undefined;
    try {
      previous = this._server._get_bundle(app_id, env);
    } catch {
      previous = undefined;
    }
    if (!previous) return warnings;

    const previous_hashes = hash_record_values(previous._entities || {});
    const next_hashes = hash_record_values(next_entities);
    for (const entity_id of Object.keys(previous_hashes)) {
      if (!next_hashes[entity_id]) {
        warnings.push(`Entity definition '${entity_id}' will be removed from runtime; existing XDB records are preserved.`);
      } else if (previous_hashes[entity_id] !== next_hashes[entity_id]) {
        warnings.push(`Entity definition '${entity_id}' will change; existing XDB records are preserved.`);
      }
    }
    return warnings;
  }

  private assert_file_limits(files: XAppArchiveFile[]) {
    if (files.length + 1 > this._limits._max_file_count) {
      throw new XError("E_XAPP_TOO_MANY_FILES", "Export exceeds .xapp file count limit");
    }
    const total = files.reduce((sum, file) => {
      if (file._bytes.length > this._limits._max_file_bytes) {
        throw new XError("E_XAPP_FILE_TOO_LARGE", "Exported file exceeds .xapp file size limit", {
          _meta: { _path: file._path },
        });
      }
      return sum + file._bytes.length;
    }, 0);
    if (total > this._limits._max_total_uncompressed_bytes) {
      throw new XError("E_XAPP_PACKAGE_TOO_LARGE", "Export exceeds .xapp package size limit");
    }
  }

  private required_file(files: Map<string, Buffer>, package_path: string): Buffer {
    const bytes = files.get(package_path);
    if (!bytes) {
      throw new XError("E_XAPP_MISSING_FILE", `Package is missing ${package_path}`, {
        _meta: { _path: package_path },
      });
    }
    return bytes;
  }

  private resolve_segment(value: unknown, field_name: string): string {
    if (!is_safe_xapp_segment(value)) {
      throw new XError("E_XAPP_INVALID_SEGMENT", `Invalid ${field_name}`, {
        _meta: { _field: field_name },
      });
    }
    return value;
  }

  private resolve_env(value: unknown): string {
    if (value === undefined || value === null || value === "") return DEFAULT_ENV;
    return this.resolve_segment(value, "_env");
  }

  private resolve_import_mode(value: unknown): "create" | "replace" | "upsert" {
    if (value === undefined || value === null || value === "") return "upsert";
    if (value === "create" || value === "replace" || value === "upsert") return value;
    throw new XError("E_XAPP_INVALID_IMPORT_MODE", "Invalid import mode");
  }

  private resolve_upload_params(params: Record<string, any>): { _filename?: string; _bytes: Buffer } {
    const file =
      params._file && typeof params._file === "object" && !Array.isArray(params._file)
        ? params._file as Record<string, any>
        : undefined;
    const source = file ?? params;
    const filename =
      source._filename ??
      source._file_name ??
      source.filename ??
      source.name ??
      params._filename ??
      params._file_name;
    const bytes = this.resolve_upload_bytes(source);

    if (bytes.length === 0) {
      throw new XError("E_XAPP_UPLOAD_EMPTY", "Uploaded package is empty");
    }

    return {
      _filename: typeof filename === "string" ? filename : undefined,
      _bytes: bytes,
    };
  }

  private resolve_upload_bytes(params: Record<string, any>): Buffer {
    const direct = params._bytes ?? params._package_bytes ?? params.bytes;
    if (Buffer.isBuffer(direct)) return direct;
    if (direct instanceof Uint8Array) return Buffer.from(direct);
    if (Array.isArray(direct)) return Buffer.from(direct);

    const encoded =
      params._bytes_base64 ??
      params._package_base64 ??
      params._base64 ??
      params._data_base64 ??
      params.data_base64 ??
      params._data ??
      params.data;

    if (typeof encoded === "string") {
      const trimmed = encoded.trim();
      const payload =
        trimmed.startsWith("data:")
          ? trimmed.slice(trimmed.indexOf(",") + 1)
          : trimmed;
      const compact = payload.replace(/\s+/gu, "");
      if (!compact || !/^[a-zA-Z0-9+/=_-]+$/u.test(compact)) {
        throw new XError("E_XAPP_UPLOAD_INVALID_REQUEST", "upload-app-package requires valid package bytes");
      }
      return Buffer.from(compact.replaceAll("-", "+").replaceAll("_", "/"), "base64");
    }

    throw new XError("E_XAPP_UPLOAD_INVALID_REQUEST", "upload-app-package requires _bytes_base64 or _bytes");
  }

  private resolve_existing_package_path(value: unknown): string {
    if (typeof value !== "string" || !value.trim()) {
      throw new XError("E_XAPP_PACKAGE_PATH_REQUIRED", "_package_path is required");
    }
    const resolved = path.resolve(value);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw new XError("E_XAPP_PACKAGE_NOT_FOUND", "Package file not found", {
        _meta: { _package_path: resolved },
      });
    }
    return resolved;
  }

  private resolve_package_source(params: Record<string, any>): XAppPackageSource {
    if (params._package_ref !== undefined && params._package_ref !== null && params._package_ref !== "") {
      const resolved: XAppPackageRefResolution = resolve_xapp_package_ref(params._package_ref);
      return {
        _package_path: resolved._file_path,
        _package_ref: resolved._package_ref,
        _filename: resolved._filename,
        _size: resolved._size,
        _sha256: resolved._sha256,
      };
    }

    if (this.is_transport_request(params)) {
      throw new XError("E_XAPP_PACKAGE_REF_REQUIRED", "Browser package operations require _package_ref");
    }

    return {
      _package_path: this.resolve_existing_package_path(params._package_path),
    };
  }

  private package_source_response(source: XAppPackageSource): Record<string, any> {
    if (source._package_ref) {
      return {
        _package_ref: source._package_ref,
        _filename: source._filename,
        _size: source._size,
      };
    }
    return {
      _package_path: source._package_path,
    };
  }

  private is_transport_request(params: Record<string, any>): boolean {
    return Boolean(params._from && typeof params._from === "object");
  }

  private resolve_export_path(value: unknown, app_id: string): string {
    if (typeof value === "string" && value.trim()) {
      return path.resolve(value);
    }
    return path.join(this.work_xapp_root(), XAPP_EXPORTS_FOLDER, now_id("export"), `${app_id}.xapp`);
  }

  private work_xapp_root(): string {
    return path.join(this._work_folder, XAPP_FOLDER);
  }

  private public_app_root(app_id: string): string {
    const public_root = path.resolve(this._work_folder, "public");
    return safe_resolve_under(public_root, app_id);
  }

  private cleanup(target: string) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
    }
  }
}

export default XAppPackageService;
