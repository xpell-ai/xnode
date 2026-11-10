import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import express, { type Request, type Response, type Router } from "express";
import { XError, _xlog } from "@xpell/core";

export const XAPP_DOWNLOAD_ROUTE = "/xapp/download";
export const XAPP_UPLOAD_ROUTE = "/xapp/upload";
export const XAPP_CONTENT_TYPE = "application/vnd.xpell.xapp+zip";
export const DEFAULT_XAPP_DOWNLOAD_CORS_ORIGINS = ["http://localhost:5173"];

const DEFAULT_XAPP_DOWNLOAD_TTL_MS = 15 * 60 * 1000;
const DEFAULT_XAPP_UPLOAD_TTL_MS = 60 * 60 * 1000;
export const DEFAULT_XAPP_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;
const XAPP_PACKAGE_REF_PREFIX = "xapp-upload:";
const TOKEN_RE = /^[a-zA-Z0-9_-]{32,128}$/u;
const PACKAGE_REF_RE = /^xapp-upload:[a-zA-Z0-9_-]{32,128}$/u;
const CRLF = Buffer.from("\r\n");
const HEADER_BREAK = Buffer.from("\r\n\r\n");

export type XAppDownloadTransfer = {
  _type: "http";
  _url: string;
  _path: string;
  _expires_at: string;
};

export type XAppUploadTransfer = {
  _package_ref: string;
  _filename: string;
  _size: number;
  _sha256: string;
  _expires_at: string;
};

type XAppDownloadRecord = {
  _token: string;
  _file_path: string;
  _filename: string;
  _content_type: string;
  _size: number;
  _sha256?: string;
  _expires_at_ms: number;
  _delete_on_expire: boolean;
};

type RegisterXAppDownloadInput = {
  _file_path: string;
  _filename: string;
  _content_type?: string;
  _sha256?: string;
  _ttl_ms?: number;
  _delete_on_expire?: boolean;
  _base_url?: string;
};

type XAppUploadRecord = {
  _package_ref: string;
  _file_path: string;
  _filename: string;
  _size: number;
  _sha256: string;
  _expires_at_ms: number;
};

type StoreXAppUploadInput = {
  _work_folder: string;
  _filename?: string;
  _bytes: Buffer;
  _ttl_ms?: number;
  _max_bytes?: number;
};

export type XAppPackageRefResolution = {
  _package_ref: string;
  _file_path: string;
  _filename: string;
  _size: number;
  _sha256: string;
};

export type XAppPackageTransferRouterOptions = {
  _work_folder: string;
  _max_upload_bytes?: number;
  _upload_ttl_ms?: number;
  _cors_origins?: string[];
  _cors_allow_credentials?: boolean;
};

type XAppCorsConfig = {
  _origins: Set<string>;
  _allow_credentials: boolean;
};

type MultipartFilePart = {
  _filename?: string;
  _bytes: Buffer;
};

const downloads = new Map<string, XAppDownloadRecord>();
const uploads = new Map<string, XAppUploadRecord>();

function xapp_download_error(code: string, message: string) {
  return new XError(code, message);
}

function xapp_upload_error(code: string, message: string) {
  return new XError(code, message);
}

function normalize_base_url(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function normalize_origin(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function resolve_xapp_cors_config(options: XAppPackageTransferRouterOptions): XAppCorsConfig {
  const raw_origins = Array.isArray(options._cors_origins)
    ? options._cors_origins
    : DEFAULT_XAPP_DOWNLOAD_CORS_ORIGINS;
  const origins = new Set<string>();
  for (const raw of raw_origins) {
    const origin = normalize_origin(raw);
    if (origin) origins.add(origin);
  }
  return {
    _origins: origins,
    _allow_credentials: options._cors_allow_credentials !== false,
  };
}

function add_vary_origin(res: Response) {
  const current = res.getHeader("Vary");
  const values = Array.isArray(current) ? current.join(",") : String(current ?? "");
  const parts = values.split(",").map((part) => part.trim()).filter(Boolean);
  if (!parts.some((part) => part.toLowerCase() === "origin")) parts.push("Origin");
  res.setHeader("Vary", parts.join(", "));
}

function apply_xapp_download_cors(req: Request, res: Response, config: XAppCorsConfig): boolean {
  const origin = normalize_origin(get_header_value(req.headers.origin));
  if (!origin || !config._origins.has(origin)) {
    res.removeHeader("Access-Control-Allow-Origin");
    res.removeHeader("Access-Control-Allow-Credentials");
    res.removeHeader("Access-Control-Allow-Methods");
    res.removeHeader("Access-Control-Expose-Headers");
    return false;
  }

  res.setHeader("Access-Control-Allow-Origin", origin);
  if (config._allow_credentials) {
    res.setHeader("Access-Control-Allow-Credentials", "true");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "Content-Disposition, Content-Length, X-XApp-SHA256");
  add_vary_origin(res);
  return true;
}

function cleanup_record(record: XAppDownloadRecord) {
  downloads.delete(record._token);
  if (!record._delete_on_expire) return;
  try {
    fs.rmSync(record._file_path, { force: true });
  } catch {
  }
}

function cleanup_upload_record(record: XAppUploadRecord) {
  uploads.delete(record._package_ref);
  try {
    fs.rmSync(record._file_path, { force: true });
  } catch {
  }
}

export function cleanup_expired_xapp_downloads(now_ms = Date.now()) {
  for (const record of downloads.values()) {
    if (record._expires_at_ms <= now_ms) cleanup_record(record);
  }
}

export function cleanup_expired_xapp_uploads(now_ms = Date.now()) {
  for (const record of uploads.values()) {
    if (record._expires_at_ms <= now_ms) cleanup_upload_record(record);
  }
}

export function register_xapp_download(input: RegisterXAppDownloadInput): XAppDownloadTransfer {
  cleanup_expired_xapp_downloads();

  let stat: fs.Stats;
  try {
    stat = fs.statSync(input._file_path);
  } catch {
    throw xapp_download_error("E_XAPP_DOWNLOAD_SOURCE_MISSING", "Download artifact is not available");
  }
  if (!stat.isFile()) {
    throw xapp_download_error("E_XAPP_DOWNLOAD_SOURCE_MISSING", "Download artifact is not a file");
  }

  const ttl_ms =
    Number.isFinite(input._ttl_ms) && typeof input._ttl_ms === "number"
      ? input._ttl_ms
      : DEFAULT_XAPP_DOWNLOAD_TTL_MS;
  const token = randomBytes(32).toString("base64url");
  const expires_at_ms = Date.now() + ttl_ms;
  const record: XAppDownloadRecord = {
    _token: token,
    _file_path: input._file_path,
    _filename: input._filename,
    _content_type: input._content_type ?? XAPP_CONTENT_TYPE,
    _size: stat.size,
    _sha256: input._sha256,
    _expires_at_ms: expires_at_ms,
    _delete_on_expire: input._delete_on_expire === true,
  };
  downloads.set(token, record);

  const transfer_path = `${XAPP_DOWNLOAD_ROUTE}/${encodeURIComponent(token)}`;
  const base_url = normalize_base_url(input._base_url);
  return {
    _type: "http",
    _url: base_url ? `${base_url}${transfer_path}` : transfer_path,
    _path: transfer_path,
    _expires_at: new Date(expires_at_ms).toISOString(),
  };
}

export function store_xapp_upload(input: StoreXAppUploadInput): XAppUploadTransfer {
  cleanup_expired_xapp_uploads();

  const max_bytes = input._max_bytes ?? DEFAULT_XAPP_UPLOAD_MAX_BYTES;
  if (input._bytes.length > max_bytes) {
    throw xapp_upload_error("E_XAPP_UPLOAD_TOO_LARGE", "Uploaded package exceeds size limit");
  }

  const token = randomBytes(32).toString("base64url");
  const package_ref = `${XAPP_PACKAGE_REF_PREFIX}${token}`;
  const filename = sanitize_upload_filename(input._filename);
  const root = path.resolve(input._work_folder, ".xapp", "uploads");
  const file_path = path.join(root, `${token}.xapp`);
  const ttl_ms =
    Number.isFinite(input._ttl_ms) && typeof input._ttl_ms === "number"
      ? input._ttl_ms
      : DEFAULT_XAPP_UPLOAD_TTL_MS;
  const expires_at_ms = Date.now() + ttl_ms;
  const sha256 = createHash("sha256").update(input._bytes).digest("hex");

  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(file_path, input._bytes);

  const record: XAppUploadRecord = {
    _package_ref: package_ref,
    _file_path: file_path,
    _filename: filename,
    _size: input._bytes.length,
    _sha256: sha256,
    _expires_at_ms: expires_at_ms,
  };
  uploads.set(package_ref, record);

  _xlog.log("[xapp] package upload prepared", {
    _filename: filename,
    _size: input._bytes.length,
    _has_package_ref: true,
  });

  return {
    _package_ref: package_ref,
    _filename: filename,
    _size: input._bytes.length,
    _sha256: sha256,
    _expires_at: new Date(expires_at_ms).toISOString(),
  };
}

export function resolve_xapp_package_ref(package_ref: unknown): XAppPackageRefResolution {
  if (typeof package_ref !== "string" || !PACKAGE_REF_RE.test(package_ref)) {
    throw xapp_upload_error("E_XAPP_PACKAGE_REF_NOT_FOUND", "Package reference was not found");
  }

  const record = uploads.get(package_ref);
  if (!record) {
    throw xapp_upload_error("E_XAPP_PACKAGE_REF_NOT_FOUND", "Package reference was not found");
  }

  if (record._expires_at_ms <= Date.now()) {
    cleanup_upload_record(record);
    throw xapp_upload_error("E_XAPP_PACKAGE_REF_EXPIRED", "Package reference has expired");
  }

  if (!fs.existsSync(record._file_path) || !fs.statSync(record._file_path).isFile()) {
    uploads.delete(package_ref);
    throw xapp_upload_error("E_XAPP_PACKAGE_REF_FILE_MISSING", "Package reference is no longer available");
  }

  return {
    _package_ref: record._package_ref,
    _file_path: record._file_path,
    _filename: record._filename,
    _size: record._size,
    _sha256: record._sha256,
  };
}

export function consume_xapp_package_ref(package_ref: unknown, operation: "import") {
  const record =
    typeof package_ref === "string" && PACKAGE_REF_RE.test(package_ref)
      ? uploads.get(package_ref)
      : undefined;
  if (record) cleanup_upload_record(record);
  _xlog.log("[xapp] package upload consumed", {
    _operation: operation,
  });
}

function resolve_xapp_download(token: unknown): XAppDownloadRecord {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) {
    throw xapp_download_error("E_XAPP_DOWNLOAD_NOT_FOUND", "Download artifact was not found");
  }

  const record = downloads.get(token);
  if (!record) {
    throw xapp_download_error("E_XAPP_DOWNLOAD_NOT_FOUND", "Download artifact was not found");
  }

  if (record._expires_at_ms <= Date.now()) {
    cleanup_record(record);
    throw xapp_download_error("E_XAPP_DOWNLOAD_EXPIRED", "Download artifact has expired");
  }

  if (!fs.existsSync(record._file_path) || !fs.statSync(record._file_path).isFile()) {
    downloads.delete(token);
    throw xapp_download_error("E_XAPP_DOWNLOAD_FILE_MISSING", "Download artifact is no longer available");
  }

  return record;
}

function status_for_error(error: unknown): number {
  const code = error instanceof XError ? error._code : undefined;
  if (code === "E_XAPP_UPLOAD_TOO_LARGE") return 413;
  if (code === "E_XAPP_UPLOAD_INVALID_REQUEST" || code === "E_XAPP_UPLOAD_EMPTY") return 400;
  if (code === "E_XAPP_DOWNLOAD_EXPIRED" || code === "E_XAPP_DOWNLOAD_FILE_MISSING") return 410;
  if (code === "E_XAPP_PACKAGE_REF_EXPIRED" || code === "E_XAPP_PACKAGE_REF_FILE_MISSING") return 410;
  if (code === "E_XAPP_PACKAGE_REF_NOT_FOUND") return 404;
  if (code === "E_XAPP_DOWNLOAD_NOT_FOUND") return 404;
  return 500;
}

function send_transfer_error(res: Response, error: unknown) {
  const xerror =
    error instanceof XError
      ? error
      : xapp_upload_error("E_XAPP_TRANSFER_FAILED", "XApp transfer failed");
  res.status(status_for_error(xerror)).json({
    _ok: false,
    _result: xerror.toXData(),
  });
}

function content_disposition(filename: string): string {
  const safe = filename.replaceAll("\\", "_").replaceAll("\"", "_").replaceAll("\r", "_").replaceAll("\n", "_");
  return `attachment; filename="${safe}"`;
}

function sanitize_upload_filename(value: unknown): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : "package.xapp";
  const base = path.basename(raw.replaceAll("\\", "/"));
  const safe = base
    .replaceAll("\0", "")
    .replace(/[^a-zA-Z0-9._-]/gu, "_")
    .slice(0, 160);
  return safe || "package.xapp";
}

function get_header_value(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function read_request_body(req: Request, max_bytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let too_large = false;

    req.on("data", (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (total > max_bytes) {
        too_large = true;
        return;
      }
      if (!too_large) chunks.push(bytes);
    });
    req.on("end", () => {
      if (too_large) {
        reject(xapp_upload_error("E_XAPP_UPLOAD_TOO_LARGE", "Uploaded package exceeds size limit"));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => reject(error));
  });
}

function read_boundary(content_type: string): string | undefined {
  const match = content_type.match(/(?:^|;)\s*boundary=(?:"([^"]+)"|([^;]+))/iu);
  return match?.[1] ?? match?.[2]?.trim();
}

function parse_content_disposition(value: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!value) return out;
  for (const part of value.split(";")) {
    const trimmed = part.trim();
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    const key = trimmed.slice(0, index).trim().toLowerCase();
    let field_value = trimmed.slice(index + 1).trim();
    if (field_value.startsWith("\"") && field_value.endsWith("\"")) {
      field_value = field_value.slice(1, -1);
    }
    out[key] = field_value;
  }
  return out;
}

function parse_multipart_file(bytes: Buffer, content_type: string): MultipartFilePart {
  const boundary = read_boundary(content_type);
  if (!boundary) {
    throw xapp_upload_error("E_XAPP_UPLOAD_INVALID_REQUEST", "Multipart upload is missing a boundary");
  }

  const delimiter = Buffer.from(`--${boundary}`);
  let cursor = bytes.indexOf(delimiter);
  while (cursor >= 0) {
    cursor += delimiter.length;
    if (bytes.subarray(cursor, cursor + 2).equals(Buffer.from("--"))) break;
    if (bytes.subarray(cursor, cursor + 2).equals(CRLF)) cursor += 2;

    const header_end = bytes.indexOf(HEADER_BREAK, cursor);
    if (header_end < 0) break;

    const headers_raw = bytes.subarray(cursor, header_end).toString("utf-8");
    const headers: Record<string, string> = {};
    for (const line of headers_raw.split(/\r\n/u)) {
      const index = line.indexOf(":");
      if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
    }

    const body_start = header_end + HEADER_BREAK.length;
    const next_delimiter = bytes.indexOf(Buffer.from(`\r\n--${boundary}`), body_start);
    if (next_delimiter < 0) break;

    const disposition = parse_content_disposition(headers["content-disposition"]);
    const filename = disposition.filename;
    if (filename || disposition.name === "file" || disposition.name === "package") {
      return {
        _filename: filename,
        _bytes: Buffer.from(bytes.subarray(body_start, next_delimiter)),
      };
    }

    cursor = next_delimiter + CRLF.length;
    cursor = bytes.indexOf(delimiter, cursor);
  }

  throw xapp_upload_error("E_XAPP_UPLOAD_INVALID_REQUEST", "Multipart upload did not include a package file");
}

function package_bytes_from_request(input: {
  _bytes: Buffer;
  _content_type: string;
  _filename?: string;
}): { _bytes: Buffer; _filename?: string } {
  if (input._content_type.toLowerCase().includes("multipart/form-data")) {
    return parse_multipart_file(input._bytes, input._content_type);
  }
  return {
    _bytes: input._bytes,
    _filename: input._filename,
  };
}

export function createXAppPackageTransferRouter(options: XAppPackageTransferRouterOptions): Router {
  const router = express.Router();
  const max_upload_bytes = options._max_upload_bytes ?? DEFAULT_XAPP_UPLOAD_MAX_BYTES;
  const download_cors = resolve_xapp_cors_config(options);

  router.options(`${XAPP_DOWNLOAD_ROUTE}/:token`, (req: Request, res: Response) => {
    apply_xapp_download_cors(req, res, download_cors);
    res.status(204).end();
  });

  router.get(`${XAPP_DOWNLOAD_ROUTE}/:token`, (req: Request, res: Response) => {
    apply_xapp_download_cors(req, res, download_cors);

    let record: XAppDownloadRecord;
    try {
      record = resolve_xapp_download(req.params.token);
    } catch (error) {
      send_transfer_error(res, error);
      return;
    }

    res.setHeader("Content-Type", record._content_type);
    res.setHeader("Content-Length", String(record._size));
    res.setHeader("Content-Disposition", content_disposition(record._filename));
    if (record._sha256) res.setHeader("X-XApp-SHA256", record._sha256);

    const stream = fs.createReadStream(record._file_path);
    stream.on("error", () => {
      downloads.delete(record._token);
      if (!res.headersSent) {
        send_transfer_error(res, xapp_download_error("E_XAPP_DOWNLOAD_FAILED", "Download failed"));
      } else {
        res.destroy();
      }
    });
    stream.pipe(res);
  });

  router.post(XAPP_UPLOAD_ROUTE, async (req: Request, res: Response) => {
    try {
      const content_type = get_header_value(req.headers["content-type"]) ?? "";
      const requested_filename =
        get_header_value(req.headers["x-xapp-filename"]) ??
        (typeof req.query.filename === "string" ? req.query.filename : undefined);
      const request_bytes = await read_request_body(req, max_upload_bytes);
      const package_file = package_bytes_from_request({
        _bytes: request_bytes,
        _content_type: content_type,
        _filename: requested_filename,
      });

      if (package_file._bytes.length === 0) {
        throw xapp_upload_error("E_XAPP_UPLOAD_EMPTY", "Uploaded package is empty");
      }

      const upload = store_xapp_upload({
        _work_folder: options._work_folder,
        _filename: package_file._filename,
        _bytes: package_file._bytes,
        _ttl_ms: options._upload_ttl_ms,
        _max_bytes: max_upload_bytes,
      });

      res.status(200).json({
        _ok: true,
        _result: upload,
      });
    } catch (error) {
      send_transfer_error(res, error);
    }
  });

  return router;
}

export function createXAppDownloadRouter(options: XAppPackageTransferRouterOptions): Router {
  return createXAppPackageTransferRouter(options);
}
