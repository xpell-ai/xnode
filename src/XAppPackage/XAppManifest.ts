import { createHash } from "node:crypto";
import path from "node:path";

export const XAPP_FORMAT = "xpell-app";
export const XAPP_FORMAT_VERSION = "1.0";
export const XAPP_MANIFEST_PATH = "manifest.json";

export type XAppPackageFileKind =
  | "manifest"
  | "app"
  | "view"
  | "flow"
  | "entity"
  | "asset"
  | "style";

export type XAppManifestFile = {
  _path: string;
  _kind: XAppPackageFileKind;
  _size: number;
  _sha256: string;
};

export type XAppManifest = {
  _format: "xpell-app";
  _format_version: "1.0";
  _app: {
    _app_id: string;
    _name?: string;
    _version: string;
    _entry_view_id?: string;
  };
  _content: {
    _files: XAppManifestFile[];
  };
  _build: {
    _created_at: string;
    _source_app_id: string;
    _source_env: string;
  };
};

export type XAppValidationIssue = {
  _code: string;
  _message: string;
  _path?: string;
  _details?: Record<string, unknown>;
};

export type XAppPackageLimits = {
  _max_file_count: number;
  _max_file_bytes: number;
  _max_total_uncompressed_bytes: number;
  _max_compression_ratio: number;
};

export const DEFAULT_XAPP_LIMITS: XAppPackageLimits = {
  _max_file_count: 1000,
  _max_file_bytes: 25 * 1024 * 1024,
  _max_total_uncompressed_bytes: 100 * 1024 * 1024,
  _max_compression_ratio: 100,
};

export const XAPP_MANIFEST_SELF_HASH_PLACEHOLDER = "0".repeat(64);

const SAFE_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u;
const SAFE_JSON_ARTIFACT_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*\.json$/u;
const FORBIDDEN_PUBLIC_SEGMENTS = new Set([
  ".env",
  "secret",
  "secrets",
  "credential",
  "credentials",
]);
const FORBIDDEN_PUBLIC_EXTENSIONS = new Set([
  ".bash",
  ".cjs",
  ".command",
  ".dll",
  ".dylib",
  ".exe",
  ".js",
  ".jsx",
  ".key",
  ".mjs",
  ".node",
  ".pem",
  ".ps1",
  ".sh",
  ".so",
  ".ts",
  ".tsx",
  ".wasm",
  ".zsh",
]);
const ALLOWED_ASSET_EXTENSIONS = new Set([
  ".css",
  ".gif",
  ".ico",
  ".jpeg",
  ".jpg",
  ".json",
  ".mp3",
  ".mp4",
  ".otf",
  ".png",
  ".svg",
  ".ttf",
  ".txt",
  ".wav",
  ".webm",
  ".webp",
  ".woff",
  ".woff2",
]);
const ALLOWED_STYLE_EXTENSIONS = new Set([".css"]);

export function sha256_buffer(buffer: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function is_safe_xapp_segment(value: unknown): value is string {
  return typeof value === "string" && SAFE_SEGMENT_RE.test(value);
}

export function stable_json_stringify(value: unknown): string {
  return `${stable_json_stringify_inner(value)}\n`;
}

function stable_json_stringify_inner(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stable_json_stringify_inner(item)).join(",")}]`;
  }

  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stable_json_stringify_inner(object[key])}`)
    .join(",")}}`;
}

export function stable_json_buffer(value: unknown): Buffer {
  return Buffer.from(stable_json_stringify(value), "utf-8");
}

export function normalize_xapp_package_path(raw_path: string): string {
  return raw_path.replaceAll("\\", "/");
}

export function is_allowed_xapp_path(raw_path: string): boolean {
  const package_path = normalize_xapp_package_path(raw_path);

  if (!package_path || package_path.includes("\0")) return false;
  if (package_path.startsWith("/") || package_path.startsWith("\\")) return false;
  if (/^[a-zA-Z]:[\\/]/u.test(raw_path)) return false;
  if (path.isAbsolute(package_path)) return false;
  if (package_path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return false;
  }

  if (package_path === "manifest.json") return true;
  if (package_path === "app.json") return true;
  if (/^views\/[^/]+\.json$/u.test(package_path)) {
    return SAFE_JSON_ARTIFACT_RE.test(package_path.slice("views/".length));
  }
  if (/^flows\/[^/]+\.json$/u.test(package_path)) {
    return SAFE_JSON_ARTIFACT_RE.test(package_path.slice("flows/".length));
  }
  if (/^entities\/[^/]+\.json$/u.test(package_path)) {
    return SAFE_JSON_ARTIFACT_RE.test(package_path.slice("entities/".length));
  }
  if (package_path.startsWith("assets/")) {
    return is_safe_public_package_path(package_path, ALLOWED_ASSET_EXTENSIONS);
  }
  if (package_path.startsWith("style/")) {
    return is_safe_public_package_path(package_path, ALLOWED_STYLE_EXTENSIONS);
  }

  return false;
}

function is_safe_public_package_path(package_path: string, allowed_extensions: Set<string>): boolean {
  if (package_path.endsWith("/")) return false;
  const segments = package_path.split("/").map((segment) => segment.toLowerCase());
  if (segments.some((segment) => FORBIDDEN_PUBLIC_SEGMENTS.has(segment))) return false;
  const ext = path.extname(package_path).toLowerCase();
  if (FORBIDDEN_PUBLIC_EXTENSIONS.has(ext)) return false;
  return allowed_extensions.has(ext);
}

export function infer_xapp_file_kind(package_path: string): XAppPackageFileKind | undefined {
  if (package_path === "manifest.json") return "manifest";
  if (package_path === "app.json") return "app";
  if (package_path.startsWith("views/") && package_path.endsWith(".json")) return "view";
  if (package_path.startsWith("flows/") && package_path.endsWith(".json")) return "flow";
  if (package_path.startsWith("entities/") && package_path.endsWith(".json")) return "entity";
  if (package_path.startsWith("assets/")) return "asset";
  if (package_path.startsWith("style/")) return "style";
  return undefined;
}

export function validate_xapp_manifest_shape(raw: unknown): {
  _manifest?: XAppManifest;
  _issues: XAppValidationIssue[];
} {
  const issues: XAppValidationIssue[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      _issues: [{
        _code: "E_XAPP_INVALID_MANIFEST",
        _message: "manifest.json must contain a JSON object",
        _path: "manifest.json",
      }],
    };
  }

  const manifest = raw as Record<string, any>;

  if (manifest._format !== XAPP_FORMAT) {
    issues.push({ _code: "E_XAPP_INVALID_FORMAT", _message: "Unsupported package format", _path: "manifest.json._format" });
  }

  if (manifest._format_version !== XAPP_FORMAT_VERSION) {
    issues.push({
      _code: "E_XAPP_UNSUPPORTED_FORMAT_VERSION",
      _message: "Unsupported package format version",
      _path: "manifest.json._format_version",
    });
  }

  if (!manifest._app || typeof manifest._app !== "object" || Array.isArray(manifest._app)) {
    issues.push({ _code: "E_XAPP_INVALID_MANIFEST_APP", _message: "Manifest requires _app object", _path: "manifest.json._app" });
  } else {
    if (!is_safe_xapp_segment(manifest._app._app_id)) {
      issues.push({ _code: "E_XAPP_INVALID_APP_ID", _message: "Manifest app id is invalid", _path: "manifest.json._app._app_id" });
    }
    if (typeof manifest._app._version !== "string" || !manifest._app._version.trim()) {
      issues.push({
        _code: "E_XAPP_INVALID_APP_VERSION",
        _message: "Manifest app version must be a non-empty string",
        _path: "manifest.json._app._version",
      });
    }
  }

  if (!manifest._build || typeof manifest._build !== "object" || Array.isArray(manifest._build)) {
    issues.push({ _code: "E_XAPP_INVALID_BUILD", _message: "Manifest requires _build object", _path: "manifest.json._build" });
  } else {
    if (typeof manifest._build._created_at !== "string" || !manifest._build._created_at.trim()) {
      issues.push({
        _code: "E_XAPP_INVALID_BUILD_CREATED_AT",
        _message: "Manifest build timestamp is required",
        _path: "manifest.json._build._created_at",
      });
    }
    if (!is_safe_xapp_segment(manifest._build._source_app_id)) {
      issues.push({
        _code: "E_XAPP_INVALID_SOURCE_APP_ID",
        _message: "Manifest source app id is invalid",
        _path: "manifest.json._build._source_app_id",
      });
    }
    if (!is_safe_xapp_segment(manifest._build._source_env)) {
      issues.push({
        _code: "E_XAPP_INVALID_SOURCE_ENV",
        _message: "Manifest source env is invalid",
        _path: "manifest.json._build._source_env",
      });
    }
  }

  if (!manifest._content || typeof manifest._content !== "object" || Array.isArray(manifest._content)) {
    issues.push({ _code: "E_XAPP_INVALID_CONTENT", _message: "Manifest requires _content object", _path: "manifest.json._content" });
  } else if (!Array.isArray(manifest._content._files)) {
    issues.push({
      _code: "E_XAPP_INVALID_CONTENT_FILES",
      _message: "Manifest requires _content._files array",
      _path: "manifest.json._content._files",
    });
  } else {
    const seen = new Set<string>();
    let has_app_json = false;
    let has_manifest_json = false;

    manifest._content._files.forEach((file: unknown, index: number) => {
      const file_path = `manifest.json._content._files[${index}]`;
      if (!file || typeof file !== "object" || Array.isArray(file)) {
        issues.push({
          _code: "E_XAPP_INVALID_CONTENT_FILE",
          _message: "Manifest file inventory entry must be an object",
          _path: file_path,
        });
        return;
      }

      const entry = file as Record<string, any>;
      const package_path = typeof entry._path === "string" ? normalize_xapp_package_path(entry._path) : "";
      const kind = infer_xapp_file_kind(package_path);

      if (!is_allowed_xapp_path(package_path) || !kind) {
        issues.push({
          _code: "E_XAPP_INVALID_CONTENT_PATH",
          _message: "Manifest file inventory contains an invalid path",
          _path: `${file_path}._path`,
        });
      } else if (entry._kind !== kind) {
        issues.push({
          _code: "E_XAPP_INVALID_CONTENT_KIND",
          _message: "Manifest file inventory kind does not match path",
          _path: `${file_path}._kind`,
          _details: { _expected_kind: kind, _actual_kind: entry._kind },
        });
      }

      if (seen.has(package_path)) {
        issues.push({
          _code: "E_XAPP_DUPLICATE_MANIFEST_FILE",
          _message: "Manifest file inventory contains a duplicate path",
          _path: `${file_path}._path`,
        });
      }
      seen.add(package_path);

      if (package_path === "app.json") has_app_json = true;
      if (package_path === "manifest.json") has_manifest_json = true;

      if (!Number.isSafeInteger(entry._size) || entry._size < 0) {
        issues.push({
          _code: "E_XAPP_INVALID_CONTENT_SIZE",
          _message: "Manifest file size must be a non-negative safe integer",
          _path: `${file_path}._size`,
        });
      }

      if (typeof entry._sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(entry._sha256)) {
        issues.push({
          _code: "E_XAPP_INVALID_CONTENT_HASH",
          _message: "Manifest file hash must be a SHA-256 hex digest",
          _path: `${file_path}._sha256`,
        });
      }
    });

    if (!has_manifest_json) {
      issues.push({
        _code: "E_XAPP_MISSING_MANIFEST_INVENTORY",
        _message: "Manifest inventory must include manifest.json",
        _path: "manifest.json._content._files",
      });
    }
    if (!has_app_json) {
      issues.push({
        _code: "E_XAPP_MISSING_APP_JSON",
        _message: "Package manifest must include app.json",
        _path: "manifest.json._content._files",
      });
    }
  }

  return issues.length > 0 ? { _issues: issues } : { _manifest: raw as XAppManifest, _issues: [] };
}

export function calculate_manifest_self_hash(manifest: XAppManifest): string {
  const copy = JSON.parse(JSON.stringify(manifest)) as XAppManifest;
  const entry = copy._content._files.find((file) => file._path === XAPP_MANIFEST_PATH);
  if (!entry) return "";
  entry._sha256 = XAPP_MANIFEST_SELF_HASH_PLACEHOLDER;
  return sha256_buffer(stable_json_buffer(copy));
}

export function finalize_xapp_manifest(manifest: XAppManifest): {
  _manifest: XAppManifest;
  _bytes: Buffer;
} {
  const next = JSON.parse(JSON.stringify(manifest)) as XAppManifest;
  let manifest_entry = next._content._files.find((file) => file._path === XAPP_MANIFEST_PATH);
  if (!manifest_entry) {
    manifest_entry = {
      _path: XAPP_MANIFEST_PATH,
      _kind: "manifest",
      _size: 0,
      _sha256: XAPP_MANIFEST_SELF_HASH_PLACEHOLDER,
    };
    next._content._files.unshift(manifest_entry);
  }

  manifest_entry._kind = "manifest";
  manifest_entry._sha256 = XAPP_MANIFEST_SELF_HASH_PLACEHOLDER;
  next._content._files.sort((a, b) => a._path.localeCompare(b._path));

  for (let index = 0; index < 5; index += 1) {
    const bytes = stable_json_buffer(next);
    if (manifest_entry._size === bytes.length) break;
    manifest_entry._size = bytes.length;
  }

  manifest_entry._sha256 = calculate_manifest_self_hash(next);
  return {
    _manifest: next,
    _bytes: stable_json_buffer(next),
  };
}
