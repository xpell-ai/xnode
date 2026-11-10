import { inflateRawSync, deflateRawSync } from "node:zlib";
import {
  DEFAULT_XAPP_LIMITS,
  type XAppPackageLimits,
  type XAppValidationIssue,
  is_allowed_xapp_path,
  normalize_xapp_package_path,
  sha256_buffer,
} from "./XAppManifest.js";

export type XAppArchiveFile = {
  _path: string;
  _bytes: Buffer;
};

export type XAppArchiveInspection = {
  _ok: boolean;
  _files: Map<string, Buffer>;
  _issues: XAppValidationIssue[];
};

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_COMPRESSION_STORE = 0;
const ZIP_COMPRESSION_DEFLATE = 8;
const ZIP_FIXED_DOS_TIME = 0;
const ZIP_FIXED_DOS_DATE = 33;
const ZIP_UNIX_VERSION_MADE_BY = (3 << 8) | 20;
const ZIP_VERSION_NEEDED = 20;

const CRC32_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i += 1) {
  let c = i;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC32_TABLE[i] = c >>> 0;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function concat_buffers(buffers: Buffer[]): Buffer {
  return Buffer.concat(buffers);
}

function write_u16(value: number): Buffer {
  const out = Buffer.allocUnsafe(2);
  out.writeUInt16LE(value);
  return out;
}

function write_u32(value: number): Buffer {
  const out = Buffer.allocUnsafe(4);
  out.writeUInt32LE(value >>> 0);
  return out;
}

function assert_zip32_size(value: number, path_name: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`ZIP32 size limit exceeded for ${path_name}`);
  }
}

export function create_xapp_zip(files: XAppArchiveFile[]): Buffer {
  const sorted = [...files].sort((a, b) => a._path.localeCompare(b._path));
  const local_parts: Buffer[] = [];
  const central_parts: Buffer[] = [];
  let offset = 0;

  for (const file of sorted) {
    const file_name = Buffer.from(file._path, "utf-8");
    const uncompressed = Buffer.from(file._bytes);
    const compressed = deflateRawSync(uncompressed, { level: 9 });
    const method =
      compressed.length < uncompressed.length
        ? ZIP_COMPRESSION_DEFLATE
        : ZIP_COMPRESSION_STORE;
    const payload = method === ZIP_COMPRESSION_DEFLATE ? compressed : uncompressed;
    const checksum = crc32(uncompressed);

    assert_zip32_size(offset, file._path);
    assert_zip32_size(payload.length, file._path);
    assert_zip32_size(uncompressed.length, file._path);

    const local_header = concat_buffers([
      write_u32(ZIP_LOCAL_FILE_HEADER),
      write_u16(ZIP_VERSION_NEEDED),
      write_u16(0x0800),
      write_u16(method),
      write_u16(ZIP_FIXED_DOS_TIME),
      write_u16(ZIP_FIXED_DOS_DATE),
      write_u32(checksum),
      write_u32(payload.length),
      write_u32(uncompressed.length),
      write_u16(file_name.length),
      write_u16(0),
      file_name,
    ]);

    local_parts.push(local_header, payload);

    const central_header = concat_buffers([
      write_u32(ZIP_CENTRAL_DIRECTORY_HEADER),
      write_u16(ZIP_UNIX_VERSION_MADE_BY),
      write_u16(ZIP_VERSION_NEEDED),
      write_u16(0x0800),
      write_u16(method),
      write_u16(ZIP_FIXED_DOS_TIME),
      write_u16(ZIP_FIXED_DOS_DATE),
      write_u32(checksum),
      write_u32(payload.length),
      write_u32(uncompressed.length),
      write_u16(file_name.length),
      write_u16(0),
      write_u16(0),
      write_u16(0),
      write_u16(0),
      write_u32(0o100644 << 16),
      write_u32(offset),
      file_name,
    ]);
    central_parts.push(central_header);
    offset += local_header.length + payload.length;
  }

  const central = concat_buffers(central_parts);
  assert_zip32_size(offset, "central-directory-offset");
  assert_zip32_size(central.length, "central-directory-size");

  const eocd = concat_buffers([
    write_u32(ZIP_END_OF_CENTRAL_DIRECTORY),
    write_u16(0),
    write_u16(0),
    write_u16(sorted.length),
    write_u16(sorted.length),
    write_u32(central.length),
    write_u32(offset),
    write_u16(0),
  ]);

  return concat_buffers([...local_parts, central, eocd]);
}

function find_eocd(buffer: Buffer): number {
  const min = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === ZIP_END_OF_CENTRAL_DIRECTORY) {
      return offset;
    }
  }
  return -1;
}

function is_symlink_or_hardlink(external_attrs: number): boolean {
  const unix_mode = (external_attrs >>> 16) & 0xffff;
  if (unix_mode === 0) return false;
  const file_type = unix_mode & 0o170000;
  return file_type === 0o120000 || file_type === 0o010000;
}

export function inspect_xapp_zip(
  archive_bytes: Buffer,
  limits: XAppPackageLimits = DEFAULT_XAPP_LIMITS,
): XAppArchiveInspection {
  const issues: XAppValidationIssue[] = [];
  const files = new Map<string, Buffer>();
  const eocd_offset = find_eocd(archive_bytes);

  if (eocd_offset < 0) {
    return {
      _ok: false,
      _files: files,
      _issues: [{
        _code: "E_XAPP_INVALID_ZIP",
        _message: "Package is not a valid ZIP archive",
      }],
    };
  }

  const total_entries = archive_bytes.readUInt16LE(eocd_offset + 10);
  const central_size = archive_bytes.readUInt32LE(eocd_offset + 12);
  const central_offset = archive_bytes.readUInt32LE(eocd_offset + 16);

  if (total_entries > limits._max_file_count) {
    issues.push({
      _code: "E_XAPP_TOO_MANY_FILES",
      _message: "Package contains too many files",
      _details: { _file_count: total_entries, _max_file_count: limits._max_file_count },
    });
  }

  if (central_offset + central_size > archive_bytes.length) {
    issues.push({
      _code: "E_XAPP_INVALID_ZIP",
      _message: "ZIP central directory is outside the package",
    });
    return { _ok: false, _files: files, _issues: issues };
  }

  let cursor = central_offset;
  let total_uncompressed = 0;

  for (let index = 0; index < total_entries; index += 1) {
    if (cursor + 46 > archive_bytes.length || archive_bytes.readUInt32LE(cursor) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
      issues.push({
        _code: "E_XAPP_INVALID_ZIP",
        _message: "Invalid ZIP central directory entry",
      });
      break;
    }

    const method = archive_bytes.readUInt16LE(cursor + 10);
    const expected_crc = archive_bytes.readUInt32LE(cursor + 16);
    const compressed_size = archive_bytes.readUInt32LE(cursor + 20);
    const uncompressed_size = archive_bytes.readUInt32LE(cursor + 24);
    const name_length = archive_bytes.readUInt16LE(cursor + 28);
    const extra_length = archive_bytes.readUInt16LE(cursor + 30);
    const comment_length = archive_bytes.readUInt16LE(cursor + 32);
    const external_attrs = archive_bytes.readUInt32LE(cursor + 38);
    const local_offset = archive_bytes.readUInt32LE(cursor + 42);
    const name_start = cursor + 46;
    const name_end = name_start + name_length;

    if (name_end > archive_bytes.length) {
      issues.push({ _code: "E_XAPP_INVALID_ZIP", _message: "ZIP entry path is truncated" });
      break;
    }

    const package_path = normalize_xapp_package_path(archive_bytes.subarray(name_start, name_end).toString("utf-8"));
    cursor = name_end + extra_length + comment_length;

    if (files.has(package_path)) {
      issues.push({
        _code: "E_XAPP_DUPLICATE_ARCHIVE_ENTRY",
        _message: "Package contains a duplicate archive entry",
        _path: package_path,
      });
      continue;
    }

    if (!is_allowed_xapp_path(package_path)) {
      issues.push({
        _code: "E_XAPP_UNEXPECTED_ARCHIVE_ENTRY",
        _message: "Package contains an unexpected or unsafe archive entry",
        _path: package_path,
      });
      continue;
    }

    if (is_symlink_or_hardlink(external_attrs)) {
      issues.push({
        _code: "E_XAPP_UNSAFE_ARCHIVE_ENTRY",
        _message: "Package contains a symlink or hardlink entry",
        _path: package_path,
      });
      continue;
    }

    if (uncompressed_size > limits._max_file_bytes) {
      issues.push({
        _code: "E_XAPP_FILE_TOO_LARGE",
        _message: "Package file exceeds the configured file size limit",
        _path: package_path,
      });
      continue;
    }

    total_uncompressed += uncompressed_size;
    if (total_uncompressed > limits._max_total_uncompressed_bytes) {
      issues.push({
        _code: "E_XAPP_PACKAGE_TOO_LARGE",
        _message: "Package exceeds the configured uncompressed size limit",
      });
      continue;
    }

    if (
      compressed_size > 0 &&
      uncompressed_size / compressed_size > limits._max_compression_ratio
    ) {
      issues.push({
        _code: "E_XAPP_ARCHIVE_BOMB",
        _message: "Package entry compression ratio exceeds the configured limit",
        _path: package_path,
      });
      continue;
    }

    if (method !== ZIP_COMPRESSION_STORE && method !== ZIP_COMPRESSION_DEFLATE) {
      issues.push({
        _code: "E_XAPP_UNSUPPORTED_ZIP_COMPRESSION",
        _message: "Package entry uses an unsupported ZIP compression method",
        _path: package_path,
      });
      continue;
    }

    if (local_offset + 30 > archive_bytes.length || archive_bytes.readUInt32LE(local_offset) !== ZIP_LOCAL_FILE_HEADER) {
      issues.push({
        _code: "E_XAPP_INVALID_ZIP",
        _message: "ZIP local file header is invalid",
        _path: package_path,
      });
      continue;
    }

    const local_name_length = archive_bytes.readUInt16LE(local_offset + 26);
    const local_extra_length = archive_bytes.readUInt16LE(local_offset + 28);
    const data_start = local_offset + 30 + local_name_length + local_extra_length;
    const data_end = data_start + compressed_size;
    if (data_end > archive_bytes.length) {
      issues.push({
        _code: "E_XAPP_INVALID_ZIP",
        _message: "ZIP file payload is outside the package",
        _path: package_path,
      });
      continue;
    }

    const compressed = archive_bytes.subarray(data_start, data_end);
    let bytes: Buffer;
    try {
      bytes = method === ZIP_COMPRESSION_DEFLATE
        ? Buffer.from(inflateRawSync(compressed))
        : Buffer.from(compressed);
    } catch (error) {
      issues.push({
        _code: "E_XAPP_INVALID_ZIP_PAYLOAD",
        _message: error instanceof Error ? error.message : String(error),
        _path: package_path,
      });
      continue;
    }

    if (bytes.length !== uncompressed_size || crc32(bytes) !== expected_crc) {
      issues.push({
        _code: "E_XAPP_INVALID_ZIP_CHECKSUM",
        _message: "ZIP entry checksum or size does not match",
        _path: package_path,
      });
      continue;
    }

    files.set(package_path, bytes);
  }

  return {
    _ok: issues.length === 0,
    _files: files,
    _issues: issues,
  };
}

export function verify_xapp_inventory_hashes(input: {
  _files: Map<string, Buffer>;
  _inventory: Array<{ _path: string; _size: number; _sha256: string }>;
  _manifest_self_hash?: string;
}): XAppValidationIssue[] {
  const issues: XAppValidationIssue[] = [];
  const inventory_paths = new Set<string>();

  for (const item of input._inventory) {
    inventory_paths.add(item._path);
    const bytes = input._files.get(item._path);
    if (!bytes) {
      issues.push({
        _code: "E_XAPP_MANIFEST_FILE_MISSING",
        _message: "Manifest inventory file is missing from archive",
        _path: item._path,
      });
      continue;
    }

    const expected_hash =
      item._path === "manifest.json" && input._manifest_self_hash
        ? input._manifest_self_hash
        : sha256_buffer(bytes);

    if (bytes.length !== item._size || expected_hash !== item._sha256) {
      issues.push({
        _code: "E_XAPP_MANIFEST_FILE_MISMATCH",
        _message: "Archive file does not match manifest size/hash",
        _path: item._path,
      });
    }
  }

  for (const path_name of input._files.keys()) {
    if (!inventory_paths.has(path_name)) {
      issues.push({
        _code: "E_XAPP_ARCHIVE_ENTRY_NOT_IN_MANIFEST",
        _message: "Archive entry is not listed in manifest",
        _path: path_name,
      });
    }
  }

  return issues;
}
