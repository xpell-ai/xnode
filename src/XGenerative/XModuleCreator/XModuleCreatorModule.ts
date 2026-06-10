import {
  mkdir,
  readFile,
  readdir,
  rename,
  symlink,
  writeFile
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  XModule,
  _x,
  _xlog,
  type XCommand
} from "../../index.js";

import {
  XMODULE_CREATOR_OPS,
  XMODULE_CREATOR_SKILL
} from "./XModuleCreator.skill.js";

import type {
  XGeneratedModuleImport,
  XGeneratedModuleOpSpec,
  XGeneratedModuleSpec,
  XModuleCreatorCreateSpecResult,
  XModuleCreatorError,
  XModuleCreatorGenerateJsResult,
  XModuleCreatorGetSpecResult,
  XModuleCreatorImplementGeneratedModuleResult,
  XModuleCreatorListSpecsResult,
  XModuleCreatorLoadGeneratedModuleResult,
  XModuleCreatorModuleOptions,
  XModuleCreatorResult,
  XModuleCreatorValidateGeneratedModuleResult,
  XModuleCreatorValidationResult
} from "./XModuleCreator.types.js";

const ARTIFACT_ROOT =
  "generated/xmodules";

const MANIFEST_FILE =
  "manifest.json";

const MODULE_FILE =
  "module.js";

const PACKAGE_FILE =
  "package.json";

const REGISTRY_FILE =
  "registry.json";

const PACKAGE_ROOT =
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../.."
  );

const SAFE_MODULE_OR_OP_NAME =
  /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

const SAFE_PARAM_NAME =
  /^_?[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

const SAFE_JS_IDENTIFIER =
  /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const FORBIDDEN_GENERATED_PATTERNS = [
  /\beval\s*\(/,
  /\bFunction\s*\(/,
  /\bchild_process\b/,
  /\bprocess\.exit\b/,
  /\bimport\s*\(/,
  /\bfetch\s*\(/,
  /\bhttps?\./,
  /\bfs\./,
  /\bsetInterval\s*\(/,
  /\bsetTimeout\s*\(/,
  /\bWorker\s*\(/,
  /\bglobalThis\.process\b/,
  /\bnode:vm\b/,
  /\brequire\(["']vm["']\)/,
];

const PLACEHOLDER_IMPLEMENTATION_PATTERNS = [
  { _label: "TODO", _pattern: /\bTODO\b/i },
  { _label: "FIXME", _pattern: /\bFIXME\b/i },
  { _label: "implement here", _pattern: /\bimplement\b[\s\S]{0,80}\bhere\b/i },
  { _label: "implement logic", _pattern: /\bimplement\b[\s\S]{0,80}\blogic\b/i },
  { _label: "not implemented", _pattern: /\bnot\s+implemented\b/i },
  { _label: "placeholder", _pattern: /\bplaceholder\b/i },
];

type XModuleCreatorValidationCategory =
  NonNullable<XModuleCreatorError["_category"]>;

function ok<T extends Record<string, unknown>>(
  payload: T
): XModuleCreatorResult<T> {
  return {
    _ok: true,
    ...payload
  };
}

function fail(
  _code: string,
  _message: string,
  _details?: Record<string, unknown>,
  _category?: XModuleCreatorValidationCategory
): XModuleCreatorResult {
  return {
    _ok: false,
    _error: {
      _code,
      _message,
      ...(_category ? { _category } : {}),
      ...(_details ? { _details } : {})
    }
  };
}

function is_record(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function read_spec(
  params: unknown
): XGeneratedModuleSpec | undefined {
  if (!is_record(params)) {
    return undefined;
  }

  return is_record(params._spec)
    ? params._spec as XGeneratedModuleSpec
    : undefined;
}

function read_id_param(
  params: unknown
) {
  if (!is_record(params)) {
    return undefined;
  }

  return typeof params._id === "string"
    ? params._id
    : undefined;
}

function read_generated_module_name_param(
  params: unknown
) {
  if (!is_record(params)) {
    return undefined;
  }

  if (typeof params._name === "string") {
    return {
      _field: "_name",
      _value: params._name
    };
  }

  if (typeof params._module_name === "string") {
    return {
      _field: "_module_name",
      _value: params._module_name
    };
  }

  return undefined;
}

function read_reload_param(
  params: unknown
) {
  return is_record(params) &&
    params._reload === true;
}

function read_repair_max_attempts_param(
  params: unknown
) {
  if (
    !is_record(params) ||
    params._max_attempts === undefined
  ) {
    return 3;
  }

  if (
    typeof params._max_attempts !== "number" ||
    !Number.isInteger(params._max_attempts) ||
    params._max_attempts < 1
  ) {
    return undefined;
  }

  return Math.min(
    params._max_attempts,
    5
  );
}

function planned_artifact_path(
  work_folder: string,
  module_id: string
) {
  return path.join(
    work_folder,
    ARTIFACT_ROOT,
    module_id
  );
}

function manifest_path(
  artifact_path: string
) {
  return path.join(
    artifact_path,
    MANIFEST_FILE
  );
}

function module_file_path(
  artifact_path: string
) {
  return path.join(
    artifact_path,
    MODULE_FILE
  );
}

function registry_path(
  work_folder: string
) {
  return path.join(
    work_folder,
    ARTIFACT_ROOT,
    REGISTRY_FILE
  );
}

async function ensure_generated_package_resolution(
  artifact_path: string
) {
  const scope_path =
    path.join(
      artifact_path,
      "node_modules",
      "@xpell"
    );
  const link_path =
    path.join(
      scope_path,
      "node"
    );

  await mkdir(
    scope_path,
    { recursive: true }
  );

  try {
    await symlink(
      PACKAGE_ROOT,
      link_path,
      "dir"
    );
  } catch (err: unknown) {
    const code =
      is_record(err)
        ? err.code
        : undefined;

    if (code !== "EEXIST") {
      throw err;
    }
  }
}

function to_pascal_case(
  value: string
) {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("");
}

function module_class_name(
  module_name: string
) {
  const pascal =
    to_pascal_case(module_name);

  return pascal.endsWith("Module")
    ? `X${pascal}`
    : `X${pascal}Module`;
}

function op_method_name(
  op_name: string
) {
  return `_${op_name.replaceAll("-", "_")}`;
}

function escape_regexp(
  text: string
) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function generated_json(
  value: unknown
) {
  return JSON.stringify(value, null, 2);
}

function content_sha256(
  content: string
) {
  return createHash("sha256")
    .update(content, "utf-8")
    .digest("hex");
}

function manifest_sha256(
  manifest_json: string
) {
  return content_sha256(manifest_json);
}

type XGeneratedModuleRegistryState =
  | "pending_implementation"
  | "implemented"
  | "disabled";

type XGeneratedModuleRegistryEntry = {
  _id: string;
  _name: string;
  _target: "server";
  _artifact_path: string;
  _manifest_file: string;
  _module_file: string;
  _manifest_sha256: string;
  _module_sha256: string;
  _ops?: string[];
  _autoload: boolean;
  _state?: XGeneratedModuleRegistryState;
  _implementation_complete?: boolean;
  _created_by: "module-creator";
  _created_at: number;
  _updated_at: number;
};

type XGeneratedModuleRegistry = {
  _version: 1;
  _modules: Record<string, XGeneratedModuleRegistryEntry | unknown>;
};

type XModuleCreatorAutoloadStats = {
  _loaded_count: number;
  _skipped_count: number;
  _failed_count: number;
};

type XModuleCreatorGeneratedModuleInspectionResult =
  XModuleCreatorResult<{
    _name: string;
    _state: XGeneratedModuleRegistryState;
    _autoload: boolean;
    _ops: string[];
    _manifest: XGeneratedModuleSpec;
    _source: string;
    _artifact_path: string;
    _module_file: string;
  }>;

type XModuleCreatorSaveGeneratedModuleSourceResult =
  XModuleCreatorResult<{
    _name: string;
    _state: XGeneratedModuleRegistryState;
    _autoload: boolean;
    _ops: string[];
    _manifest: XGeneratedModuleSpec;
    _source: string;
    _artifact_path: string;
    _module_file: string;
    _backup_file: string;
    _module_sha256: string;
    _validation: XModuleCreatorValidateGeneratedModuleResult;
  }>;

type XModuleCreatorGeneratedModuleImplementationMethods =
  Record<string, string>;

type XModuleCreatorGeneratedModuleImplementationSources = {
  _method_sources: Record<string, string>;
  _helper_sources: Record<string, string>;
};

type XModuleCreatorGeneratedModuleImplementationValidationCategory =
  | "placeholder_content"
  | "forbidden_content"
  | "syntax_or_shape_error"
  | "weak_behavior"
  | "helper_method_misplaced"
  | "unknown";

type XModuleCreatorGeneratedModuleRejectedAttempt = {
  _attempt: number;
  _category: XModuleCreatorGeneratedModuleImplementationValidationCategory;
  _validation_errors: unknown;
  _method_sources?: Record<string, string>;
  _method_source_excerpts?: Record<string, string>;
  _helpers?: Record<string, string>;
  _helper_excerpts?: Record<string, string>;
  _helper_sources?: Record<string, string>;
  _helper_source_excerpts?: Record<string, string>;
};

type XModuleCreatorRepairGeneratedModuleResult =
  XModuleCreatorResult<{
    _name: string;
    _state: XGeneratedModuleRegistryState;
    _autoload: boolean;
    _ops: string[];
    _manifest: XGeneratedModuleSpec;
    _source: string;
    _artifact_path: string;
    _module_file: string;
    _module_sha256: string;
    _attempt: number;
    _validation: XModuleCreatorValidateGeneratedModuleResult;
    _implementation: XModuleCreatorImplementGeneratedModuleResult;
  }>;

type XModuleCreatorDisableGeneratedModuleResult =
  XModuleCreatorResult<{
    _name: string;
    _state: XGeneratedModuleRegistryState;
    _autoload: boolean;
  }>;

type XModuleCreatorDeleteGeneratedModuleResult =
  XModuleCreatorResult<{
    _name: string;
    _deleted: true;
  }>;

function module_creator_debug_log(
  message: string,
  data?: Record<string, unknown>
) {
  if (Boolean((_xlog as unknown as { _debug?: boolean })._debug)) {
    _xlog.log(
      message,
      data
    );
  }
}

function fresh_generated_module_registry(): XGeneratedModuleRegistry {
  return {
    _version: 1,
    _modules: {}
  };
}

async function read_generated_module_registry(
  registry_file: string
): Promise<XGeneratedModuleRegistry> {
  try {
    const registry_json =
      await readFile(
        registry_file,
        "utf-8"
      );

    const registry =
      JSON.parse(registry_json) as unknown;

    if (
      is_record(registry) &&
      registry._version === 1 &&
      is_record(registry._modules)
    ) {
      return {
        _version: 1,
        _modules: { ...registry._modules }
      };
    }
  } catch (err: unknown) {
    const code =
      is_record(err)
        ? err.code
        : undefined;

    if (code === "ENOENT") {
      return fresh_generated_module_registry();
    }
  }

  _xlog.warn("[module-creator] malformed registry ignored", {
    _registry_file: registry_file
  });

  return fresh_generated_module_registry();
}

function is_trusted_autoload_registry_entry(
  entry: unknown
): entry is XGeneratedModuleRegistryEntry {
  return (
    is_record(entry) &&
    entry._autoload === true &&
    entry._state !== "disabled" &&
    entry._created_by === "module-creator" &&
    entry._target === "server" &&
    typeof entry._id === "string" &&
    SAFE_MODULE_OR_OP_NAME.test(entry._id) &&
    typeof entry._name === "string" &&
    SAFE_MODULE_OR_OP_NAME.test(entry._name) &&
    typeof entry._manifest_sha256 === "string" &&
    entry._manifest_sha256.trim().length > 0 &&
    typeof entry._module_sha256 === "string" &&
    entry._module_sha256.trim().length > 0
  );
}

function is_generated_module_registry_entry(
  entry: unknown
): entry is XGeneratedModuleRegistryEntry {
  return (
    is_record(entry) &&
    entry._created_by === "module-creator" &&
    entry._target === "server" &&
    typeof entry._id === "string" &&
    SAFE_MODULE_OR_OP_NAME.test(entry._id) &&
    typeof entry._name === "string" &&
    SAFE_MODULE_OR_OP_NAME.test(entry._name) &&
    typeof entry._manifest_sha256 === "string" &&
    entry._manifest_sha256.trim().length > 0 &&
    typeof entry._module_sha256 === "string" &&
    entry._module_sha256.trim().length > 0
  );
}

function registry_entry_state(
  entry: unknown
): XGeneratedModuleRegistryState {
  if (
    is_record(entry) &&
    entry._state === "pending_implementation"
  ) {
    return "pending_implementation";
  }

  if (
    is_record(entry) &&
    entry._state === "disabled"
  ) {
    return "disabled";
  }

  return "implemented";
}

function registry_entry_pending_implementation(
  entry: unknown
) {
  return registry_entry_state(entry) === "pending_implementation";
}

function registry_entry_disabled(
  entry: unknown
) {
  return registry_entry_state(entry) === "disabled";
}

async function read_generated_module_registry_entry(
  work_folder: string,
  module_id: string
) {
  const registry =
    await read_generated_module_registry(
      registry_path(work_folder)
    );

  return registry._modules[module_id];
}

async function write_generated_module_registry(
  registry_file: string,
  registry: XGeneratedModuleRegistry
) {
  await writeFile(
    `${registry_file}.tmp`,
    JSON.stringify(registry, null, 2),
    "utf-8"
  );

  await rename(
    `${registry_file}.tmp`,
    registry_file
  );
}

async function resolve_generated_module_registry_record(
  work_folder: string,
  module_name: string
) {
  const registry_file =
    registry_path(work_folder);
  const registry =
    await read_generated_module_registry(
      registry_file
    );

  for (const [key, entry] of Object.entries(registry._modules)) {
    if (
      is_generated_module_registry_entry(entry) &&
      (
        entry._name === module_name ||
        entry._id === module_name
      )
    ) {
      return {
        registry_file,
        registry,
        key,
        entry
      };
    }
  }

  return undefined;
}

async function resolve_generated_module_registry_entry(
  work_folder: string,
  module_name: string
) {
  const resolved =
    await resolve_generated_module_registry_record(
      work_folder,
      module_name
    );

  return resolved?.entry;
}

async function update_generated_module_registry(
  work_folder: string,
  spec: XGeneratedModuleSpec,
  manifest_json: string,
  module_js: string,
  state: XGeneratedModuleRegistryState
) {
  const artifact_path =
    planned_artifact_path(
      work_folder,
      spec._id
    );
  const manifest_file =
    manifest_path(artifact_path);
  const module_file =
    module_file_path(artifact_path);
  const registry_file =
    registry_path(work_folder);
  const registry =
    await read_generated_module_registry(
      registry_file
    );
  const now =
    Date.now();
  const existing_entry =
    registry._modules[spec._id];
  const existing_created_at =
    is_record(existing_entry) &&
      typeof existing_entry._created_at === "number"
      ? existing_entry._created_at
      : undefined;
  const manifest_hash =
    manifest_sha256(manifest_json);
  const module_hash =
    content_sha256(module_js);
  const implementation_complete =
    state === "implemented";

  registry._modules[spec._id] = {
    _id: spec._id,
    _name: spec._name,
    _target: "server",
    _artifact_path: artifact_path,
    _manifest_file: manifest_file,
    _module_file: module_file,
    _manifest_sha256: manifest_hash,
    _module_sha256: module_hash,
    _ops: spec._ops.map((op) => op._name),
    _autoload: implementation_complete,
    _state: state,
    _implementation_complete: implementation_complete,
    _created_by: "module-creator",
    _created_at: existing_created_at ?? now,
    _updated_at: now
  };

  await writeFile(
    `${registry_file}.tmp`,
    JSON.stringify(registry, null, 2),
    "utf-8"
  );

  await rename(
    `${registry_file}.tmp`,
    registry_file
  );

  _xlog.log("[module-creator] registry updated", {
    _module_id: spec._id,
    _registry_file: registry_file,
    _state: state,
    _autoload: implementation_complete,
    _manifest_sha256: manifest_hash,
    _module_sha256: module_hash
  });
}

function empty_generated_module_checks() {
  return {
    _manifest_exists: false,
    _module_exists: false,
    _generated_metadata_valid: false,
    _manifest_hash_valid: false,
    _imports_valid: false,
    _class_name_valid: false,
    _extends_xmodule: false,
    _module_name_valid: false,
    _ops_match: false,
    _skill_exists: false,
    _skill_valid: false,
    _public_methods_valid: false,
    _forbidden_content: false
  };
}

function has_forbidden_generated_content(
  module_js: string
) {
  return FORBIDDEN_GENERATED_PATTERNS.some((pattern) =>
    pattern.test(module_js)
  );
}

function detect_placeholder_implementation_patterns(
  method_source: string
) {
  return PLACEHOLDER_IMPLEMENTATION_PATTERNS
    .filter((pattern) =>
      pattern._pattern.test(method_source)
    )
    .map((pattern) => pattern._label);
}

function extract_generated_method_names(
  module_js: string
) {
  const method_names: string[] =
    [];

  const method_pattern =
    /^\s{2}(?:async\s+)?(_[a-z][a-z0-9_]*)\([^)]*\)\s*\{/gm;

  let match: RegExpExecArray | null;

  while ((match = method_pattern.exec(module_js)) !== null) {
    method_names.push(match[1]);
  }

  return method_names;
}

function extract_public_method_names(
  module_js: string
) {
  return Array.from(
    extract_class_methods(module_js).keys()
  );
}

type XDeclaredGeneratedMethod = {
  _method_name: string;
  _start: number;
  _end: number;
  _body_start: number;
  _body_end: number;
  _source: string;
};

function extract_class_methods(
  module_js: string
) {
  const methods =
    new Map<string, XDeclaredGeneratedMethod>();
  const method_pattern =
    /^\s{2}(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\([^)]*\)\s*\{/gm;

  let match: RegExpExecArray | null;

  while ((match = method_pattern.exec(module_js)) !== null) {
    const body_start =
      module_js.indexOf(
        "{",
        match.index
      );
    const body_end =
      find_matching_brace(
        module_js,
        body_start
      );

    if (
      body_start < 0 ||
      body_end < 0
    ) {
      continue;
    }

    methods.set(
      match[1],
      {
        _method_name: match[1],
        _start: match.index,
        _end: body_end + 1,
        _body_start: body_start,
        _body_end: body_end,
        _source: module_js.slice(
          match.index,
          body_end + 1
        )
      }
    );
  }

  return methods;
}

function extract_static_ops_names(
  module_js: string
) {
  const ops_block =
    /static _ops = \{([\s\S]*?)\n  \};/.exec(module_js)?.[1] ?? "";

  const op_names: string[] =
    [];

  const op_pattern =
    /^\s{4}"([^"]+)":\s*\{/gm;

  let match: RegExpExecArray | null;

  while ((match = op_pattern.exec(ops_block)) !== null) {
    op_names.push(match[1]);
  }

  return op_names;
}

function same_string_set(
  a: string[],
  b: string[]
) {
  if (a.length !== b.length) {
    return false;
  }

  const left =
    new Set(a);

  const right =
    new Set(b);

  if (left.size !== right.size) {
    return false;
  }

  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }

  return true;
}

function imports_are_valid(
  module_js: string
) {
  const import_lines =
    module_js.match(/^\s*import\s+[^;]+;$/gm)?.map((line) => line.trim()) ?? [];

  return (
    import_lines.length === 1 &&
    import_lines[0] === 'import { XModule } from "@xpell/node";' &&
    !module_js.includes("import(")
  );
}

function module_ops_match_manifest(
  spec: XGeneratedModuleSpec,
  module_js: string
) {
  const manifest_ops =
    spec._ops.map((op) => op._name);

  const expected_methods =
    spec._ops.map((op) => op_method_name(op._name));

  const actual_ops =
    extract_static_ops_names(module_js);

  const actual_methods =
    extract_generated_method_names(module_js);

  return (
    same_string_set(manifest_ops, actual_ops) &&
    same_string_set(expected_methods, actual_methods)
  );
}

function helper_method_name_is_valid(
  helper_name: string,
  op_method_names: Set<string>
) {
  return (
    SAFE_JS_IDENTIFIER.test(helper_name) &&
    !helper_name.startsWith("_") &&
    helper_name !== "constructor" &&
    !op_method_names.has(helper_name)
  );
}

function helper_method_source_is_valid(
  helper_source: string
) {
  return (
    !has_forbidden_generated_content(helper_source) &&
    detect_placeholder_implementation_patterns(helper_source).length === 0 &&
    !/^\s*import\s+/m.test(helper_source) &&
    !/^\s*export\s+/m.test(helper_source) &&
    !/\bclass\s+[A-Za-z_$]/.test(helper_source) &&
    !/\bfunction\b/.test(helper_source) &&
    !/\bstatic\s+_/.test(helper_source)
  );
}

function public_methods_match_manifest(
  spec: XGeneratedModuleSpec,
  module_js: string
) {
  const op_method_names =
    new Set(
      spec._ops.map((op) => op_method_name(op._name))
    );

  for (const [method_name, method] of extract_class_methods(module_js)) {
    if (
      method_name === "constructor" ||
      op_method_names.has(method_name)
    ) {
      continue;
    }

    if (
      !helper_method_name_is_valid(
        method_name,
        op_method_names
      ) ||
      !helper_method_source_is_valid(method._source)
    ) {
      return false;
    }
  }

  const public_underscore_methods =
    extract_public_method_names(module_js)
      .filter((method_name) => method_name.startsWith("_"));

  return same_string_set(
    Array.from(op_method_names),
    public_underscore_methods
  );
}

function find_matching_brace(
  source: string,
  open_index: number
) {
  let depth =
    0;
  let quote:
    | "\""
    | "'"
    | "`"
    | undefined;
  let escaped =
    false;
  let in_line_comment =
    false;
  let in_block_comment =
    false;

  for (let index = open_index; index < source.length; index++) {
    const char =
      source[index];
    const next =
      source[index + 1];

    if (in_line_comment) {
      if (char === "\n") {
        in_line_comment = false;
      }
      continue;
    }

    if (in_block_comment) {
      if (
        char === "*" &&
        next === "/"
      ) {
        in_block_comment = false;
        index++;
      }
      continue;
    }

    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === quote) {
        quote = undefined;
      }
      continue;
    }

    if (
      char === "/" &&
      next === "/"
    ) {
      in_line_comment = true;
      index++;
      continue;
    }

    if (
      char === "/" &&
      next === "*"
    ) {
      in_block_comment = true;
      index++;
      continue;
    }

    if (
      char === "\"" ||
      char === "'" ||
      char === "`"
    ) {
      quote = char;
      continue;
    }

    if (char === "{") {
      depth++;
      continue;
    }

    if (char === "}") {
      depth--;

      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

function extract_declared_generated_methods(
  module_js: string,
  spec: XGeneratedModuleSpec
) {
  const methods =
    new Map<string, XDeclaredGeneratedMethod>();

  for (const op of spec._ops) {
    const method_name =
      op_method_name(op._name);
    const method_pattern =
      new RegExp(
        `^  (?:async\\s+)?${escape_regexp(method_name)}\\([^)]*\\)\\s*\\{`,
        "m"
      );
    const match =
      method_pattern.exec(module_js);

    if (!match) {
      continue;
    }

    const body_start =
      module_js.indexOf(
        "{",
        match.index
      );
    const body_end =
      find_matching_brace(
        module_js,
        body_start
      );

    if (
      body_start < 0 ||
      body_end < 0
    ) {
      continue;
    }

    methods.set(
      method_name,
      {
        _method_name: method_name,
        _start: match.index,
        _end: body_end + 1,
        _body_start: body_start,
        _body_end: body_end,
        _source: module_js.slice(
          match.index,
          body_end + 1
        )
      }
    );
  }

  return methods;
}

function strip_declared_method_bodies(
  module_js: string,
  spec: XGeneratedModuleSpec
) {
  const methods =
    Array.from(
      extract_declared_generated_methods(
        module_js,
        spec
      ).values()
    ).sort((a, b) => b._body_start - a._body_start);

  let out =
    module_js;

  for (const method of methods) {
    out =
      `${out.slice(0, method._body_start + 1)}/*__generated_method_body__*/${out.slice(method._body_end)}`;
  }

  return out;
}

function normalize_replacement_body(
  body_source: string
) {
  const lines =
    body_source
      .trim()
      .split("\n");
  const non_empty_indents =
    lines
      .filter((line) => line.trim().length > 0)
      .map((line) => /^(\s*)/.exec(line)?.[1].length ?? 0);
  const common_indent =
    non_empty_indents.length > 0
      ? Math.min(...non_empty_indents)
      : 0;

  return lines
    .map((line) =>
      line.trim().length === 0
        ? ""
        : `    ${line.slice(common_indent).trimEnd()}`
    )
    .join("\n");
}

function strip_js_comments(
  source: string
) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

function is_explicitly_trivial_generated_op(
  op?: XGeneratedModuleOpSpec
) {
  if (!op) {
    return false;
  }

  const param_count =
    op._params && is_record(op._params)
      ? Object.keys(op._params).length
      : 0;
  const result_count =
    op._result && is_record(op._result)
      ? Object.keys(op._result).length
      : 0;

  if (param_count > 0 || result_count > 0) {
    return false;
  }

  return /^(ping|pong|health|status|version|noop|no-op)$/i.test(op._name);
}

function is_non_trivial_generated_op(
  op?: XGeneratedModuleOpSpec
) {
  if (!op) {
    return true;
  }

  if (is_explicitly_trivial_generated_op(op)) {
    return false;
  }

  const has_params =
    op._params && is_record(op._params) &&
    Object.keys(op._params).length > 0;
  const has_result =
    op._result && is_record(op._result) &&
    Object.keys(op._result).length > 0;

  if (has_params || has_result) {
    return true;
  }

  return !/^(ping|pong|health|status|version|noop|no-op)$/i.test(op._name);
}

function method_body_has_meaningful_behavior(
  body_source: string
) {
  const source =
    strip_js_comments(body_source);

  return (
    /\b(?:if|switch|for|while|catch|throw|await)\b/.test(source) ||
    /\?[\s\S]*:/.test(source) ||
    /\bthis\.[A-Za-z_$][A-Za-z0-9_$]*\s*=/.test(source) ||
    /\bthis\.[A-Za-z_$][A-Za-z0-9_$]*\.(?:push|set|add|delete|clear|splice)\s*\(/.test(source) ||
    /\b(?:Math\.[A-Za-z]+|Number|String|Boolean|JSON\.parse|Date\.now)\s*\(/.test(source) ||
    /\.(?:map|reduce|filter|sort|trim|split|join|toLowerCase|toUpperCase|replace|slice|substring|includes|match|test|find|some|every)\s*\(/.test(source) ||
    /(?:\+\+|--|[-+*/%]=)/.test(source) ||
    /[A-Za-z0-9_$)\]]\s*[-+*/%]\s*[A-Za-z0-9_$([{"']/.test(source)
  );
}

function method_body_returns_params_only(
  body_source: string
) {
  return /return\s+(?:params|xcmd\._params|xcmd\s*&&\s*xcmd\._params)\s*;/.test(body_source) ||
    /return\s*\{\s*(?:_ok\s*:\s*true\s*,\s*)?(?:_result\s*:\s*)?(?:params|xcmd\._params)\s*,?\s*\}\s*;?/s.test(body_source);
}

function method_body_returns_success_only(
  body_source: string
) {
  return /return\s*\{\s*_ok\s*:\s*true\s*,?\s*\}\s*;?\s*$/s.test(body_source);
}

function method_body_returns_constant_message(
  body_source: string
) {
  return /return\s*\{[\s\S]*(?:_message|message)\s*:\s*["'`][^"'`]*["'`][\s\S]*\}\s*;?\s*$/s.test(body_source) &&
    !/\$\{/.test(body_source) &&
    !method_body_has_meaningful_behavior(body_source);
}

function validate_weak_method_behavior(
  method_name: string,
  body_source: string,
  op?: XGeneratedModuleOpSpec,
  module_id?: string
): XModuleCreatorResult<{ _body: string }> | undefined {
  if (!is_non_trivial_generated_op(op)) {
    return undefined;
  }

  const weak_reasons: string[] =
    [];

  if (method_body_returns_params_only(body_source)) {
    weak_reasons.push("returns params without implementing behavior");
  }

  if (method_body_returns_success_only(body_source)) {
    weak_reasons.push("returns only success true");
  }

  if (method_body_returns_constant_message(body_source)) {
    weak_reasons.push("returns a constant message");
  }

  if (!method_body_has_meaningful_behavior(body_source)) {
    weak_reasons.push("contains no branching, state mutation, calculation, validation, or meaningful transform");
  }

  if (weak_reasons.length === 0) {
    return undefined;
  }

  return fail(
    "E_MODULE_CREATOR_IMPLEMENTATION_WEAK_BEHAVIOR",
    "Method replacement appears to be stub behavior for a non-trivial generated op",
    {
      ...(module_id ? { _id: module_id } : {}),
      _method_name: method_name,
      ...(op ? { _op_name: op._name } : {}),
      _reasons: weak_reasons
    },
    "weak_behavior"
  ) as XModuleCreatorResult<{ _body: string }>;
}

function validate_method_replacement_source(
  method_name: string,
  method_source: string,
  module_id?: string,
  op?: XGeneratedModuleOpSpec
): XModuleCreatorResult<{ _body: string }> {
  if (
    typeof method_source !== "string" ||
    method_source.trim().length === 0
  ) {
    return fail(
      "E_MODULE_CREATOR_IMPLEMENTATION_METHOD_EMPTY",
      "Method replacement source must be a non-empty string",
      { _method_name: method_name },
      "syntax_or_shape_error"
    ) as XModuleCreatorResult<{ _body: string }>;
  }

  const placeholder_patterns =
    detect_placeholder_implementation_patterns(
      method_source
    );

  if (placeholder_patterns.length > 0) {
    _xlog.warn(
      "[module-creator] placeholder implementation rejected",
      {
        ...(module_id ? { _module_id: module_id } : {}),
        _method_name: method_name,
        _placeholders: placeholder_patterns,
        _source: method_source
      }
    );

    return fail(
      "E_MODULE_CREATOR_IMPLEMENTATION_PLACEHOLDER",
      "Method replacement contains placeholder implementation text",
      {
        ...(module_id ? { _id: module_id } : {}),
        _method_name: method_name,
        _placeholders: placeholder_patterns
      },
      "placeholder_content"
    ) as XModuleCreatorResult<{ _body: string }>;
  }

  if (has_forbidden_generated_content(method_source)) {
    return fail(
      "E_MODULE_CREATOR_IMPLEMENTATION_FORBIDDEN_CONTENT",
      "Method replacement contains forbidden runtime content",
      { _method_name: method_name },
      "forbidden_content"
    ) as XModuleCreatorResult<{ _body: string }>;
  }

  if (
    /^\s*import\s+/m.test(method_source) ||
    /^\s*export\s+/m.test(method_source) ||
    /\bclass\s+[A-Za-z_$]/.test(method_source) ||
    /\bstatic\s+_/.test(method_source) ||
    /\bconstructor\s*\(/.test(method_source)
  ) {
    return fail(
      "E_MODULE_CREATOR_IMPLEMENTATION_SCOPE_VIOLATION",
      "Method replacement may not change imports, exports, classes, static metadata, or constructor",
      { _method_name: method_name },
      "syntax_or_shape_error"
    ) as XModuleCreatorResult<{ _body: string }>;
  }

  const trimmed =
    method_source.trim();
  const method_header_pattern =
    new RegExp(
      `^(?:async\\s+)?${escape_regexp(method_name)}\\s*\\(([^)]*)\\)\\s*\\{`
    );
  const method_match =
    method_header_pattern.exec(trimmed);

  let body_source =
    trimmed;
  let argument_alias:
    | string
    | undefined;

  if (method_match) {
    const body_start =
      trimmed.indexOf(
        "{",
        method_match.index
      );
    const body_end =
      find_matching_brace(
        trimmed,
        body_start
      );

    if (
      body_start < 0 ||
      body_end < 0 ||
      trimmed.slice(body_end + 1).trim().length > 0
    ) {
      return fail(
        "E_MODULE_CREATOR_IMPLEMENTATION_METHOD_INVALID",
        "Method replacement must contain exactly one method declaration",
        { _method_name: method_name },
        "syntax_or_shape_error"
      ) as XModuleCreatorResult<{ _body: string }>;
    }

    body_source =
      trimmed.slice(
        body_start + 1,
        body_end
      );

    const first_param =
      method_match[1]
        ?.split(",")[0]
        ?.trim();

    if (
      first_param &&
      SAFE_PARAM_NAME.test(first_param) &&
      new RegExp(`\\b${escape_regexp(first_param)}\\b`).test(body_source) &&
      !new RegExp(`\\b(?:const|let|var)\\s+${escape_regexp(first_param)}\\b`).test(body_source)
    ) {
      argument_alias =
        `const ${first_param} = arguments[0];`;
    }
  } else if (/^(?:async\s+)?_[a-z][a-z0-9_]*\s*\(/.test(trimmed)) {
    return fail(
      "E_MODULE_CREATOR_IMPLEMENTATION_METHOD_MISMATCH",
      "Method replacement declaration does not match the declared manifest op method",
      { _method_name: method_name },
      "syntax_or_shape_error"
    ) as XModuleCreatorResult<{ _body: string }>;
  }

  const weak_behavior =
    validate_weak_method_behavior(
      method_name,
      body_source,
      op,
      module_id
    );

  if (weak_behavior) {
    return weak_behavior;
  }

  return ok({
    _body: normalize_replacement_body(
      argument_alias
        ? `${argument_alias}\n${body_source}`
        : body_source
    )
  });
}

function normalize_helper_method_source(
  helper_name: string,
  helper_source: string
): XModuleCreatorResult<{ _source: string }> {
  const trimmed =
    helper_source.trim();
  const method_header_pattern =
    new RegExp(
      `^(async\\s+)?${escape_regexp(helper_name)}\\s*\\(([^)]*)\\)\\s*\\{`
    );
  const method_match =
    method_header_pattern.exec(trimmed);

  if (!method_match) {
    return fail(
      "E_MODULE_CREATOR_HELPER_METHOD_INVALID",
      "Helper source must define exactly the helper method name using method syntax",
      { _helper_name: helper_name },
      "syntax_or_shape_error"
    ) as XModuleCreatorResult<{ _source: string }>;
  }

  const body_start =
    trimmed.indexOf(
      "{",
      method_match.index
    );
  const body_end =
    find_matching_brace(
      trimmed,
      body_start
    );

  if (
    body_start < 0 ||
    body_end < 0 ||
    trimmed.slice(body_end + 1).trim().length > 0
  ) {
    return fail(
      "E_MODULE_CREATOR_HELPER_METHOD_INVALID",
      "Helper source must contain exactly one method declaration",
      { _helper_name: helper_name },
      "syntax_or_shape_error"
    ) as XModuleCreatorResult<{ _source: string }>;
  }

  const params =
    method_match[2].trim();
  const body_source =
    trimmed.slice(
      body_start + 1,
      body_end
    );
  const async_prefix =
    method_match[1] ? "async " : "";

  return ok({
    _source: `  ${async_prefix}${helper_name}(${params}) {\n${normalize_replacement_body(body_source)}\n  }`
  });
}

function validate_helper_method_source(
  helper_name: string,
  helper_source: unknown,
  op_method_names: Set<string>,
  module_id?: string
): XModuleCreatorResult<{ _source: string }> {
  if (
    typeof helper_name !== "string" ||
    !helper_method_name_is_valid(
      helper_name,
      op_method_names
    )
  ) {
    _xlog.warn("[module-creator] helper method rejected", {
      ...(module_id ? { _module_id: module_id } : {}),
      _helper_name: helper_name
    });

    return fail(
      helper_name.startsWith("_")
        ? "E_MODULE_CREATOR_HELPER_METHOD_MISPLACED"
        : "E_MODULE_CREATOR_HELPER_METHOD_NAME_INVALID",
      helper_name.startsWith("_")
        ? "Helper methods must be returned under '_helpers' without leading underscores"
        : "Invalid helper method name",
      {
        ...(module_id ? { _id: module_id } : {}),
        _helper_name: helper_name
      },
      helper_name.startsWith("_")
        ? "helper_method_misplaced"
        : "syntax_or_shape_error"
    ) as XModuleCreatorResult<{ _source: string }>;
  }

  if (
    typeof helper_source !== "string" ||
    helper_source.trim().length === 0
  ) {
    _xlog.warn("[module-creator] helper method rejected", {
      ...(module_id ? { _module_id: module_id } : {}),
      _helper_name: helper_name
    });

    return fail(
      "E_MODULE_CREATOR_HELPER_METHOD_EMPTY",
      "Helper source must be a non-empty string",
      {
        ...(module_id ? { _id: module_id } : {}),
        _helper_name: helper_name
      },
      "syntax_or_shape_error"
    ) as XModuleCreatorResult<{ _source: string }>;
  }

  const placeholder_patterns =
    detect_placeholder_implementation_patterns(
      helper_source
    );

  if (placeholder_patterns.length > 0) {
    _xlog.warn("[module-creator] helper method rejected", {
      ...(module_id ? { _module_id: module_id } : {}),
      _helper_name: helper_name,
      _placeholders: placeholder_patterns
    });

    return fail(
      "E_MODULE_CREATOR_HELPER_METHOD_PLACEHOLDER",
      "Helper source contains placeholder implementation text",
      {
        ...(module_id ? { _id: module_id } : {}),
        _helper_name: helper_name,
        _placeholders: placeholder_patterns
      },
      "placeholder_content"
    ) as XModuleCreatorResult<{ _source: string }>;
  }

  if (!helper_method_source_is_valid(helper_source)) {
    _xlog.warn("[module-creator] helper method rejected", {
      ...(module_id ? { _module_id: module_id } : {}),
      _helper_name: helper_name
    });

    return fail(
      "E_MODULE_CREATOR_HELPER_METHOD_FORBIDDEN_CONTENT",
      "Helper source contains forbidden runtime or module content",
      {
        ...(module_id ? { _id: module_id } : {}),
        _helper_name: helper_name
      },
      has_forbidden_generated_content(helper_source)
        ? "forbidden_content"
        : "syntax_or_shape_error"
    ) as XModuleCreatorResult<{ _source: string }>;
  }

  const normalized =
    normalize_helper_method_source(
      helper_name,
      helper_source
    );

  if (!normalized._ok) {
    _xlog.warn("[module-creator] helper method rejected", {
      ...(module_id ? { _module_id: module_id } : {}),
      _helper_name: helper_name,
      _error: normalized
    });
  }

  return normalized;
}

function replace_generated_method(
  module_js: string,
  method: XDeclaredGeneratedMethod,
  method_body: string
) {
  return `${module_js.slice(0, method._body_start + 1)}\n${method_body}\n  ${module_js.slice(method._body_end)}`;
}

function find_generated_class_body_end(
  module_js: string,
  class_name: string
) {
  const class_pattern =
    new RegExp(
      `export class ${escape_regexp(class_name)} extends XModule\\s*\\{`
    );
  const match =
    class_pattern.exec(module_js);

  if (!match) {
    return -1;
  }

  const body_start =
    module_js.indexOf(
      "{",
      match.index
    );

  return find_matching_brace(
    module_js,
    body_start
  );
}

function apply_helper_methods(
  module_js: string,
  class_name: string,
  helper_sources: Record<string, string>
) {
  const existing_methods =
    extract_class_methods(module_js);
  const replacements =
    Object.entries(helper_sources)
      .filter(([helper_name]) => existing_methods.has(helper_name))
      .map(([helper_name, source]) => ({
        method: existing_methods.get(helper_name)!,
        source
      }))
      .sort((left, right) => right.method._start - left.method._start);
  const inserts =
    Object.entries(helper_sources)
      .filter(([helper_name]) => !existing_methods.has(helper_name))
      .map(([, source]) => source);

  let next_module_js =
    module_js;

  for (const replacement of replacements) {
    next_module_js =
      `${next_module_js.slice(0, replacement.method._start)}${replacement.source}${next_module_js.slice(replacement.method._end)}`;
  }

  if (inserts.length === 0) {
    return next_module_js;
  }

  const class_body_end =
    find_generated_class_body_end(
      next_module_js,
      class_name
    );

  if (class_body_end < 0) {
    return next_module_js;
  }

  return `${next_module_js.slice(0, class_body_end)}\n${inserts.join("\n\n")}\n${next_module_js.slice(class_body_end)}`;
}

function unwrap_command_result(
  value: unknown
): unknown {
  if (!is_record(value) || typeof value._ok !== "boolean") {
    return value;
  }

  if (value._ok === false) {
    throw new Error(
      `Command failed: ${JSON.stringify(value._error ?? value._result ?? value)}`
    );
  }

  return Object.prototype.hasOwnProperty.call(
    value,
    "_result"
  )
    ? value._result
    : value;
}

function read_generated_text(
  value: unknown
) {
  if (
    is_record(value) &&
    typeof value._text === "string" &&
    value._text.trim().length > 0
  ) {
    return value._text;
  }

  if (
    is_record(value) &&
    typeof value.text === "string" &&
    value.text.trim().length > 0
  ) {
    return value.text;
  }

  throw new Error("Invalid xai response: missing '_text'");
}

function extract_json_object_text(
  source: string
) {
  const start =
    source.indexOf("{");

  if (start < 0) {
    throw new Error("Invalid generated module repair response: missing JSON object");
  }

  const end =
    find_matching_brace(
      source,
      start
    );

  if (end < 0) {
    throw new Error("Invalid generated module repair response: unbalanced JSON object");
  }

  return source.slice(
    start,
    end + 1
  );
}

function parse_generated_module_implementation_methods(
  value: unknown
): XModuleCreatorGeneratedModuleImplementationSources {
  const parsed =
    JSON.parse(
      extract_json_object_text(
        read_generated_text(value)
      )
    ) as unknown;

  if (!is_record(parsed)) {
    throw new Error("Invalid generated module implementation response: expected object");
  }

  const raw_method_sources =
    is_record(parsed._method_sources)
      ? parsed._method_sources
      : is_record(parsed._methods)
        ? parsed._methods
        : {};
  const raw_helper_sources =
    is_record(parsed._helpers)
      ? parsed._helpers
      : is_record(parsed._helper_sources)
      ? parsed._helper_sources
      : {};

  const method_sources: Record<string, string> =
    {};
  const helper_sources: Record<string, string> =
    {};

  for (const [method_name, method_source] of Object.entries(raw_method_sources)) {
    if (
      typeof method_name !== "string" ||
      !method_name.startsWith("_") ||
      typeof method_source !== "string" ||
      method_source.trim().length === 0
    ) {
      throw new Error("Invalid generated module implementation response: method sources must be non-empty strings");
    }

    method_sources[method_name] =
      method_source;
  }

  for (const [helper_name, helper_source] of Object.entries(raw_helper_sources)) {
    if (
      typeof helper_name !== "string" ||
      typeof helper_source !== "string" ||
      helper_source.trim().length === 0
    ) {
      throw new Error("Invalid generated module implementation response: helper sources must be non-empty strings");
    }

    helper_sources[helper_name] =
      helper_source;
  }

  if (
    Object.keys(method_sources).length === 0 &&
    Object.keys(helper_sources).length === 0
  ) {
    throw new Error("Invalid generated module implementation response: no method or helper sources returned");
  }

  return {
    _method_sources: method_sources,
    _helper_sources: helper_sources
  };
}

function normalize_implementation_validation_category(
  value: unknown
): XModuleCreatorGeneratedModuleImplementationValidationCategory {
  if (
    value === "placeholder_content" ||
    value === "forbidden_content" ||
    value === "syntax_or_shape_error" ||
    value === "weak_behavior" ||
    value === "helper_method_misplaced" ||
    value === "unknown"
  ) {
    return value;
  }

  return "unknown";
}

function read_command_error_code(
  value: unknown
): string | undefined {
  if (!is_record(value)) {
    return undefined;
  }

  if (
    is_record(value._error) &&
    typeof value._error._code === "string"
  ) {
    return value._error._code;
  }

  if (is_record(value._result)) {
    return read_command_error_code(value._result);
  }

  return undefined;
}

function read_command_error_category(
  value: unknown
): XModuleCreatorGeneratedModuleImplementationValidationCategory | undefined {
  if (!is_record(value)) {
    return undefined;
  }

  if (
    is_record(value._error) &&
    typeof value._error._category === "string"
  ) {
    return normalize_implementation_validation_category(
      value._error._category
    );
  }

  if (is_record(value._result)) {
    return read_command_error_category(value._result);
  }

  return undefined;
}

function classify_implementation_validation_failure(
  value: unknown
): XModuleCreatorGeneratedModuleImplementationValidationCategory {
  const category =
    read_command_error_category(value);

  if (category) {
    return category;
  }

  const code =
    read_command_error_code(value);

  if (code === "E_MODULE_CREATOR_IMPLEMENTATION_PLACEHOLDER") {
    return "placeholder_content";
  }

  if (
    code === "E_MODULE_CREATOR_IMPLEMENTATION_FORBIDDEN_CONTENT" ||
    code === "E_MODULE_CREATOR_FORBIDDEN_CONTENT"
  ) {
    return "forbidden_content";
  }

  if (code === "E_MODULE_CREATOR_IMPLEMENTATION_WEAK_BEHAVIOR") {
    return "weak_behavior";
  }

  if (code === "E_MODULE_CREATOR_HELPER_METHOD_MISPLACED") {
    return "helper_method_misplaced";
  }

  if (
    code?.includes("METHOD") ||
    code?.includes("SCOPE") ||
    code?.includes("VALIDATION") ||
    code?.includes("SYNTAX") ||
    code?.includes("SHAPE")
  ) {
    return "syntax_or_shape_error";
  }

  return "unknown";
}

function method_source_excerpts(
  methods: XModuleCreatorGeneratedModuleImplementationMethods
) {
  return Object.fromEntries(
    Object.entries(methods).map(([method_name, method_source]) => [
      method_name,
      method_source.length > 700
        ? `${method_source.slice(0, 700)}...`
        : method_source
    ])
  );
}

function build_generated_module_repair_prompt(input: {
  spec: XGeneratedModuleSpec;
  source: string;
  prompt: string;
  context?: unknown;
  errors?: unknown;
  view?: unknown;
  validation_errors?: unknown;
  rejected_attempts?: XModuleCreatorGeneratedModuleRejectedAttempt[];
}) {
  const module_ops =
    input.spec._ops.map((op) => op._name);
  const rejected_categories =
    new Set(
      (input.rejected_attempts ?? []).map((attempt) => attempt._category)
    );
  const retry_instructions: string[] =
    [];

  if (rejected_categories.has("placeholder_content")) {
    retry_instructions.push(
      "Previous repair was rejected for placeholder code.",
      "Every returned method must have a complete method body.",
      "Ban TODO comments, placeholder comments, and not implemented text."
    );
  }

  if (rejected_categories.has("weak_behavior")) {
    retry_instructions.push(
      "Previous repair was rejected because it was stub behavior.",
      "Implement state mutation, calculation, validation, or meaningful transformation according to the prompt and context.",
      "Return JSON-safe results that callers can consume."
    );
  }

  if (rejected_categories.has("forbidden_content")) {
    retry_instructions.push(
      "Previous repair was rejected for forbidden runtime content.",
      "Keep implementation local and deterministic, without filesystem, network, eval, Function, dynamic import, timers, process, or child_process access."
    );
  }

  if (rejected_categories.has("syntax_or_shape_error")) {
    retry_instructions.push(
      "Previous repair was rejected for syntax or method shape.",
      "Return exactly one method declaration string for each changed declared method, with the correct underscore method name.",
      "Return helper methods using method syntax under _helpers."
    );
  }

  if (rejected_categories.has("helper_method_misplaced")) {
    retry_instructions.push(
      "Helpers must go in _helpers without leading underscores.",
      "Do not put helper methods in _methods.",
      "Do not prefix helper names with underscores."
    );
  }

  const repair_context = {
    _repair_prompt: input.prompt,
    _module_name: input.spec._name,
    _module_ops: module_ops,
    ...(input.context !== undefined ? { _context: input.context } : {}),
    ...(input.view !== undefined ? { _view: input.view } : {}),
    ...(input.errors !== undefined ? { _errors: input.errors } : {}),
    ...(input.validation_errors !== undefined
      ? { _previous_validation_errors: input.validation_errors }
      : {}),
    ...(input.rejected_attempts && input.rejected_attempts.length > 0
      ? { _previous_rejected_attempts: input.rejected_attempts }
      : {})
  };

  return [
    "You are repairing declared methods in an existing generated Xpell server XModule.",
    "Return strict JSON only.",
    "",
    "Output contract:",
    '{ "_methods": { "_methodName": "async _methodName(xcmd) { ... }" }, "_helpers": { "helperName": "helperName(value) { ... }" } }',
    "",
    "Rules:",
    "Public command methods go in _methods.",
    "Internal helpers go in _helpers.",
    "Do not prefix helper names with '_'.",
    "Do not put helper methods in _methods.",
    "Return method implementations only.",
    "Do not return full module.js.",
    "Do not include imports, exports, class declarations, static metadata, or constructor.",
    "Implement only declared operation methods listed in the manifest.",
    "Helper methods must not be runtime ops and must not modify static _ops or the manifest.",
    "Use only local JavaScript.",
    "Use xcmd and xcmd._params for inputs.",
    "Return JSON-safe objects.",
    "Do not use fetch, filesystem APIs, child_process, eval, Function, timers, dynamic import, process.exit, or globalThis.process.",
    "Do not return placeholder code.",
    "Do not include TODO, FIXME, implement here, implement logic, not implemented, or placeholder text.",
    "Use the current source, manifest, repair prompt, and optional context to infer the minimal method repairs.",
    ...(retry_instructions.length > 0
      ? [
        "",
        "Retry instructions:",
        ...retry_instructions
      ]
      : []),
    "",
    "Repair context:",
    JSON.stringify(repair_context, null, 2),
    "",
    "Module manifest:",
    JSON.stringify({
      _id: input.spec._id,
      _name: input.spec._name,
      _description: input.spec._description,
      _target: input.spec._target,
      _ops: input.spec._ops.map((op) => ({
        _name: op._name,
        _method: op_method_name(op._name),
        _description: op._description,
        ...(op._params ? { _params: op._params } : {}),
        ...(op._result ? { _result: op._result } : {})
      }))
    }, null, 2),
    "",
    "Current module.js source:",
    input.source,
    "",
    "User repair prompt:",
    input.prompt,
    "",
    ...(input.errors !== undefined
      ? [
        "Reported errors:",
        JSON.stringify(input.errors, null, 2),
        ""
      ]
      : []),
    ...(input.rejected_attempts && input.rejected_attempts.length > 0
      ? [
        "Previous rejected method sources/excerpts:",
        JSON.stringify(input.rejected_attempts, null, 2),
        ""
      ]
      : []),
    "Return JSON now."
  ].join("\n");
}

async function update_generated_module_registry_after_module_change(
  work_folder: string,
  spec: XGeneratedModuleSpec,
  manifest_json: string,
  module_js: string
) {
  await update_generated_module_registry(
    work_folder,
    spec,
    manifest_json,
    module_js,
    "implemented"
  );
}

function generated_metadata_valid(
  spec: XGeneratedModuleSpec,
  module_js: string
) {
  return (
    module_js.includes("@xmodule_generated") &&
    module_js.includes(`@generated_from_manifest ${spec._id}`) &&
    /@artifact_version\s+\S+/.test(module_js)
  );
}

function manifest_hash_valid(
  module_js: string,
  manifest_hash: string
) {
  return module_js.includes(`@manifest_sha256 ${manifest_hash}`);
}

async function read_manifest_file(
  artifact_path: string
) {
  const manifest_json =
    await readFile(
      manifest_path(artifact_path),
      "utf-8"
    );

  return {
    manifest_json,
    spec: JSON.parse(manifest_json) as unknown
  };
}

function generated_skill_valid(
  spec: XGeneratedModuleSpec,
  module_js: string
) {
  const skill_block =
    /static _skill = \{([\s\S]*?)\n  \};/.exec(module_js)?.[1] ?? "";

  return (
    skill_block.includes(`"_id": ${JSON.stringify(spec._id)}`) &&
    skill_block.includes(`"_name": ${JSON.stringify(spec._name)}`)
  );
}

function render_generated_module_js(
  spec: XGeneratedModuleSpec,
  manifest_hash: string
) {
  const class_name =
    module_class_name(spec._name);

  const description =
    spec._description ??
    `Generated server module: ${spec._name}.`;

  const ops =
    spec._ops.reduce<Record<string, {
      _name: string;
      _scope: "module";
      _description: string;
      _params?: Record<string, unknown>;
      _result?: Record<string, unknown>;
    }>>((
      acc,
      op
    ) => {
      acc[op._name] = {
        _name: op._name,
        _scope: "module",
        _description: op._description,
        ...(op._params ? { _params: op._params } : {}),
        ...(op._result ? { _result: op._result } : {})
      };
      return acc;
    }, {});

  const skill_export_ops =
    spec._ops.map((op) => ({
      _name: op._name,
      _scope: "module",
      _description: op._description,
      ...(op._params ? { _params: op._params } : {}),
      ...(op._result ? { _result: op._result } : {})
    }));

  const skill_prefix =
    generated_json({
      _id: spec._id,
      _title: class_name,
      _version: spec._version ?? "0.1.0",
      _active: true,
      _type: "server-module-api",
      _requires: [
        "xmodule"
      ],
      _description: description,
      _exports: {
        _modules: [
          {
            _name: spec._name,
            _scope: "server",
            _description: description,
            _ops: skill_export_ops
          }
        ]
      },
      _core_rules: [
        "Generated module artifact derived from manifest.json.",
        "manifest.json is the authoritative source.",
        "Generated module code must not add undeclared ops.",
        "Generated module code must not add undeclared imports."
      ]
    });

  const op_behaviors =
    is_record(spec._meta) && is_record(spec._meta._op_behaviors)
      ? spec._meta._op_behaviors
      : {};

  const methods =
    spec._ops.map((op) => {
      const behavior =
        typeof op_behaviors[op._name] === "string"
          ? op_behaviors[op._name]
          : undefined;

      if (behavior === "safe_arithmetic_add_sub") {
        return `  async ${op_method_name(op._name)}(xcmd) {
    const params =
      xcmd && typeof xcmd._params === "object" && xcmd._params !== null && !Array.isArray(xcmd._params)
        ? xcmd._params
        : {};
    let expression =
      typeof params.expression === "string"
        ? params.expression
        : typeof params._expression === "string"
          ? params._expression
          : "";

    if (typeof params._xdata_key === "string" && params._xdata_key.trim()) {
      return {
        _ok: false,
        _error: {
          _code: "E_CALC_XDATA_UNSUPPORTED",
          _message: "_xdata_key is unsupported in generated server modules because server xd is not client xd."
        }
      };
    }

    const normalized_expression = expression.trim().replace(/=$/, "");

    if (!/^[0-9+\\-.\\s]+$/.test(normalized_expression) || !/[0-9]/.test(normalized_expression)) {
      return {
        _ok: false,
        _error: {
          _code: "E_CALC_UNSAFE_EXPRESSION",
          _message: "Expression may contain only numbers, spaces, +, -, decimal point, and an optional trailing =."
        }
      };
    }

    const tokens = normalized_expression.match(/[+-]?\\s*(?:\\d+(?:\\.\\d+)?|\\.\\d+)/g) ?? [];
    const compact = normalized_expression.replace(/\\s+/g, "");
    if (tokens.join("").replace(/\\s+/g, "") !== compact) {
      return {
        _ok: false,
        _error: {
          _code: "E_CALC_INVALID_EXPRESSION",
          _message: "Expression is not a valid addition/subtraction expression."
        }
      };
    }

    const result = tokens.reduce((sum, token) => sum + Number(token.replace(/\\s+/g, "")), 0);

    return {
      _ok: true,
      _result: {
        result,
        value: String(result)
      }
    };
  }`;
      }

      return `  ${op_method_name(op._name)}() {
    return {
      _ok: true,
      _message: "Not implemented"
    };
  }`;
    }).join("\n\n");

  return `/**
 * @xmodule_generated
 * @generated_from_manifest ${spec._id}
 * @artifact_version 1
 * @manifest_sha256 ${manifest_hash}
 */
// Generated by Xpell.AI module creator. Do not edit manually.
// Source of truth: manifest.json.
// Do not edit structure manually. Editable method bodies may be updated by controlled generation.

import { XModule } from "@xpell/node";

export class ${class_name} extends XModule {
  static _name = ${generated_json(spec._name)};

  static _ops = ${generated_json(ops).replaceAll("\n", "\n  ")};

  static _skill = ${skill_prefix.replaceAll("\n", "\n  ")};

  constructor() {
    super({
      _name: ${class_name}._name
    });
  }

${methods}
}

export default ${class_name};
`;
}

function push_error(
  errors: XModuleCreatorError[],
  _code: string,
  _message: string,
  _details?: Record<string, unknown>
) {
  errors.push({
    _code,
    _message,
    ...(_details ? { _details } : {})
  });
}

function validate_safe_name(
  errors: XModuleCreatorError[],
  value: unknown,
  field: string
) {
  if (
    typeof value !== "string" ||
    !SAFE_MODULE_OR_OP_NAME.test(value)
  ) {
    push_error(
      errors,
      "E_MODULE_CREATOR_INVALID_NAME",
      `Invalid '${field}': expected snake_case/kebab-case safe name`,
      { _field: field }
    );
  }
}

function validate_imports(
  imports: unknown,
  errors: XModuleCreatorError[]
) {
  if (imports === undefined) {
    return;
  }

  if (!Array.isArray(imports)) {
    push_error(
      errors,
      "E_MODULE_CREATOR_INVALID_IMPORTS",
      "Invalid '_imports': expected array",
      { _field: "_imports" }
    );
    return;
  }

  imports.forEach((
    import_spec: unknown,
    index: number
  ) => {
    if (!is_record(import_spec)) {
      push_error(
        errors,
        "E_MODULE_CREATOR_INVALID_IMPORT",
        "Invalid import: expected object",
        { _field: `_imports.${index}` }
      );
      return;
    }

    const generated_import =
      import_spec as XGeneratedModuleImport;

    if (generated_import._from !== "@xpell/node") {
      push_error(
        errors,
        "E_MODULE_CREATOR_IMPORT_NOT_ALLOWED",
        "Invalid import: only '@xpell/node' is allowed in v1",
        {
          _field: `_imports.${index}._from`,
          _from: generated_import._from
        }
      );
    }
  });
}

function validate_permissions(
  permissions: unknown,
  errors: XModuleCreatorError[]
) {
  if (permissions === undefined) {
    return;
  }

  if (
    !Array.isArray(permissions) ||
    permissions.length > 0
  ) {
    push_error(
      errors,
      "E_MODULE_CREATOR_PERMISSION_NOT_ALLOWED",
      "Invalid '_permissions': filesystem, network, and package permissions are not allowed in v1",
      { _field: "_permissions" }
    );
  }
}

function validate_param_names(
  op: XGeneratedModuleOpSpec,
  index: number,
  errors: XModuleCreatorError[]
) {
  if (op._params === undefined) {
    return;
  }

  if (!is_record(op._params)) {
    push_error(
      errors,
      "E_MODULE_CREATOR_INVALID_OP_PARAMS",
      "Invalid op '_params': expected object",
      { _field: `_ops.${index}._params` }
    );
    return;
  }

  for (const param_name of Object.keys(op._params)) {
    if (!SAFE_PARAM_NAME.test(param_name)) {
      push_error(
        errors,
        "E_MODULE_CREATOR_INVALID_PARAM_NAME",
        "Invalid op param name: expected snake_case",
        {
          _field: `_ops.${index}._params.${param_name}`,
          _param: param_name
        }
      );
    }
  }
}

function validate_ops(
  ops: unknown,
  errors: XModuleCreatorError[]
) {
  if (!Array.isArray(ops)) {
    push_error(
      errors,
      "E_MODULE_CREATOR_INVALID_OPS",
      "Invalid '_ops': expected array",
      { _field: "_ops" }
    );
    return;
  }

  const seen =
    new Set<string>();

  ops.forEach((
    op_spec: unknown,
    index: number
  ) => {
    if (!is_record(op_spec)) {
      push_error(
        errors,
        "E_MODULE_CREATOR_INVALID_OP",
        "Invalid op: expected object",
        { _field: `_ops.${index}` }
      );
      return;
    }

    const op =
      op_spec as XGeneratedModuleOpSpec;

    validate_safe_name(
      errors,
      op._name,
      `_ops.${index}._name`
    );

    if (
      typeof op._description !== "string" ||
      !op._description.trim()
    ) {
      push_error(
        errors,
        "E_MODULE_CREATOR_INVALID_OP_DESCRIPTION",
        "Invalid op: expected non-empty '_description'",
        { _field: `_ops.${index}._description` }
      );
    }

    if (typeof op._name === "string") {
      if (seen.has(op._name)) {
        push_error(
          errors,
          "E_MODULE_CREATOR_DUPLICATE_OP",
          "Invalid '_ops': duplicate op name",
          {
            _field: `_ops.${index}._name`,
            _name: op._name
          }
        );
      }
      seen.add(op._name);
    }

    validate_param_names(
      op,
      index,
      errors
    );
  });
}

function validate_spec(
  spec: unknown
): XModuleCreatorError[] {
  const errors: XModuleCreatorError[] =
    [];

  if (!is_record(spec)) {
    push_error(
      errors,
      "E_MODULE_CREATOR_INVALID_SPEC",
      "Invalid '_spec': expected object",
      { _field: "_spec" }
    );
    return errors;
  }

  validate_safe_name(
    errors,
    spec._id,
    "_id"
  );

  validate_safe_name(
    errors,
    spec._name,
    "_name"
  );

  if (spec._target !== "server") {
    push_error(
      errors,
      "E_MODULE_CREATOR_INVALID_TARGET",
      "Invalid '_target': only 'server' is allowed in v1",
      { _field: "_target" }
    );
  }

  validate_imports(
    spec._imports,
    errors
  );

  validate_permissions(
    spec._permissions,
    errors
  );

  validate_ops(
    spec._ops,
    errors
  );

  return errors;
}

export class XModuleCreatorModule extends XModule {
  static _name =
    "module-creator";

  static _skill =
    XMODULE_CREATOR_SKILL;

  static _ops =
    {
      ...XMODULE_CREATOR_OPS,
      "generate-module-js": {
        _name: "generate-module-js",
        _scope: "module",
        _description:
          "Regenerate deterministic module.js from a persisted module manifest.",
        _params: {
          _id: "string"
        }
      },
      "validate-generated-module": {
        _name: "validate-generated-module",
        _scope: "module",
        _description:
          "Validate generated module.js against its authoritative manifest without loading or executing it.",
        _params: {
          _id: "string"
        }
      },
      "load-generated-module": {
        _name: "load-generated-module",
        _scope: "module",
        _description:
          "Validate and load a deterministic generated module artifact into the runtime.",
        _params: {
          _id: "string",
          _reload: "boolean"
        }
      },
      "get-generated-module": {
        _name: "get-generated-module",
        _scope: "module",
        _description:
          "Inspect a generated server module manifest and source by safe module name.",
        _params: {
          _name: "string",
          _module_name: "string"
        }
      },
      "save-generated-module-source": {
        _name: "save-generated-module-source",
        _scope: "module",
        _description:
          "Validate and save manual source edits for a generated server module.",
        _params: {
          _name: "string",
          _module_name: "string",
          _source: "string"
        }
      },
      "repair-generated-module": {
        _name: "repair-generated-module",
        _scope: "module",
        _description:
          "Repair an existing generated server module by prompt using controlled method replacement.",
        _params: {
          _name: "string",
          _module_name: "string",
          _prompt: "string",
          _context: "Record<string, unknown>",
          _errors: "unknown",
          _view: "unknown",
          _max_attempts: "number"
        }
      },
      "disable-generated-module": {
        _name: "disable-generated-module",
        _scope: "module",
        _description:
          "Disable a generated server module from future autoload while keeping files.",
        _params: {
          _name: "string",
          _module_name: "string"
        }
      },
      "delete-generated-module": {
        _name: "delete-generated-module",
        _scope: "module",
        _description:
          "Move a generated server module artifact to the deleted area and remove its registry entry.",
        _params: {
          _name: "string",
          _module_name: "string"
        }
      },
      "implement-generated-module": {
        _name: "implement-generated-module",
        _scope: "module",
        _description:
          "Apply controlled method-body replacements to declared ops in a generated module artifact.",
        _params: {
          _id: "string",
          _implementation_request: "string",
          _context: "Record<string, unknown>"
        }
      }
    };

  private readonly _work_folder?: string;

  constructor(
    opts: XModuleCreatorModuleOptions = {}
  ) {
    super({
      _name: XModuleCreatorModule._name
    });
    this._work_folder =
      typeof opts._work_folder === "string" &&
        opts._work_folder.trim()
        ? opts._work_folder
        : undefined;
  }

  override async onLoad() {
    _xlog.log("[module-creator] loaded");
    await this.autoload_registered_modules();
  }

  private warn_autoload_skip(
    module_id: string,
    reason: string,
    error?: unknown
  ) {
    _xlog.warn("[module-creator] registered module autoload skipped", {
      _module_id: module_id,
      _reason: reason,
      ...(error
        ? { _error: error instanceof Error ? error.message : String(error) }
        : {})
    });
  }

  private warn_autoload_failed(
    module_id: string,
    reason: string,
    error?: unknown
  ) {
    _xlog.warn("[module-creator] registered module autoload failed", {
      _module_id: module_id,
      _reason: reason,
      ...(error
        ? { _error: error instanceof Error ? error.message : String(error) }
        : {})
    });
  }

  private warn_autoload_pending_implementation(
    module_id: string
  ) {
    _xlog.warn("[module-creator] autoload skipped pending implementation", {
      _module_id: module_id,
      _state: "pending_implementation"
    });
  }

  private warn_autoload_disabled(
    module_id: string
  ) {
    _xlog.warn("[module-creator] autoload skipped disabled module", {
      _module_id: module_id,
      _state: "disabled"
    });
  }

  private async autoload_registered_module(
    entry: XGeneratedModuleRegistryEntry,
    stats: XModuleCreatorAutoloadStats
  ) {
    const id =
      entry._id;
    const artifact_path =
      planned_artifact_path(
        this._work_folder!,
        id
      );
    const manifest_file =
      manifest_path(artifact_path);
    const module_file =
      module_file_path(artifact_path);

    let manifest_json: string;
    let module_js: string;
    let spec: unknown;

    try {
      manifest_json =
        await readFile(
          manifest_file,
          "utf-8"
        );
      module_js =
        await readFile(
          module_file,
          "utf-8"
        );
      spec =
        JSON.parse(manifest_json);
    } catch (err: unknown) {
      stats._skipped_count++;
      this.warn_autoload_skip(
        id,
        "artifact_read_failed",
        err
      );
      return;
    }

    const manifest_hash =
      content_sha256(manifest_json);
    const module_hash =
      content_sha256(module_js);

    if (
      manifest_hash !== entry._manifest_sha256 ||
      module_hash !== entry._module_sha256
    ) {
      stats._skipped_count++;
      this.warn_autoload_skip(
        id,
        "hash_mismatch"
      );
      return;
    }

    const validation =
      await this._validate_generated_module({
        _module: XModuleCreatorModule._name,
        _op: "validate-generated-module",
        _params: {
          _id: id
        }
      } as unknown as XCommand);

    if (
      !validation._ok ||
      !validation._valid
    ) {
      stats._skipped_count++;
      this.warn_autoload_skip(
        id,
        "validation_failed"
      );
      return;
    }

    if (!is_record(spec)) {
      stats._skipped_count++;
      this.warn_autoload_skip(
        id,
        "invalid_manifest"
      );
      return;
    }

    const valid_spec =
      spec as XGeneratedModuleSpec;

    if (
      valid_spec._id !== entry._id ||
      valid_spec._name !== entry._name
    ) {
      stats._skipped_count++;
      this.warn_autoload_skip(
        id,
        "registry_manifest_mismatch"
      );
      return;
    }

    if (_x.getModule(valid_spec._name)) {
      stats._skipped_count++;
      _xlog.log("[module-creator] registered module already loaded", {
        _module_id: id,
        _name: valid_spec._name
      });
      return;
    }

    const load_result =
      await this._load_generated_module({
        _module: XModuleCreatorModule._name,
        _op: "load-generated-module",
        _params: {
          _id: id
        }
      } as unknown as XCommand);

    if (!load_result._ok) {
      stats._failed_count++;
      this.warn_autoload_failed(
        id,
        "load_failed",
        JSON.stringify(load_result)
      );
      return;
    }

    stats._loaded_count++;
    _xlog.log("[module-creator] registered module autoloaded", {
      _module_id: id,
      _name: load_result._name
    });
  }

  private async autoload_registered_modules() {
    const stats: XModuleCreatorAutoloadStats =
    {
      _loaded_count: 0,
      _skipped_count: 0,
      _failed_count: 0
    };

    if (!this._work_folder) {
      module_creator_debug_log(
        "[module-creator] autoload skipped; work folder missing"
      );
      return;
    }

    _xlog.log("[module-creator] autoload registered modules start");

    const registry_file =
      registry_path(this._work_folder);

    try {
      let registry_json: string;

      try {
        registry_json =
          await readFile(
            registry_file,
            "utf-8"
          );
      } catch (err: unknown) {
        const code =
          is_record(err)
            ? err.code
            : undefined;

        if (code === "ENOENT") {
          _xlog.log("[module-creator] autoload registered modules complete", stats);
          return;
        }

        throw err;
      }

      let registry: unknown;

      try {
        registry =
          JSON.parse(registry_json);
      } catch (err: unknown) {
        _xlog.warn("[module-creator] malformed registry ignored", {
          _registry_file: registry_file,
          _error: err instanceof Error ? err.message : String(err)
        });
        _xlog.log("[module-creator] autoload registered modules complete", stats);
        return;
      }

      if (
        !is_record(registry) ||
        registry._version !== 1 ||
        !is_record(registry._modules)
      ) {
        _xlog.warn("[module-creator] malformed registry ignored", {
          _registry_file: registry_file
        });
        _xlog.log("[module-creator] autoload registered modules complete", stats);
        return;
      }

      for (const [module_id, entry] of Object.entries(registry._modules)) {
        if (registry_entry_disabled(entry)) {
          stats._skipped_count++;
          this.warn_autoload_disabled(module_id);
          continue;
        }

        if (registry_entry_pending_implementation(entry)) {
          stats._skipped_count++;
          this.warn_autoload_pending_implementation(module_id);
          continue;
        }

        if (!is_trusted_autoload_registry_entry(entry)) {
          stats._skipped_count++;
          this.warn_autoload_skip(
            module_id,
            "untrusted_registry_entry"
          );
          continue;
        }

        try {
          await this.autoload_registered_module(
            entry,
            stats
          );
        } catch (err: unknown) {
          stats._failed_count++;
          this.warn_autoload_failed(
            entry._id,
            "unexpected_autoload_error",
            err
          );
        }
      }
    } catch (err: unknown) {
      _xlog.warn("[module-creator] registered module autoload failed", {
        _module_id: "*",
        _reason: "autoload_registry_failed",
        _error: err instanceof Error ? err.message : String(err)
      });
    }

    _xlog.log("[module-creator] autoload registered modules complete", stats);
  }

  async _create_module_spec(
    xcmd: XCommand
  ): Promise<XModuleCreatorCreateSpecResult> {
    const spec =
      read_spec(xcmd._params);

    const validation =
      validate_spec(spec);

    if (validation.length > 0 || !spec) {
      return fail(
        "E_MODULE_CREATOR_INVALID_SPEC",
        "Module spec failed validation",
        { _errors: validation }
      ) as XModuleCreatorCreateSpecResult;
    }

    if (!this._work_folder) {
      return fail(
        "E_MODULE_CREATOR_WORK_FOLDER_REQUIRED",
        "XModuleCreatorModule requires '_work_folder' for manifest persistence"
      ) as XModuleCreatorCreateSpecResult;
    }

    const artifact_path =
      planned_artifact_path(
        this._work_folder,
        spec._id
      );

    await mkdir(
      artifact_path,
      { recursive: true }
    );

    await writeFile(
      manifest_path(artifact_path),
      JSON.stringify(spec, null, 2),
      "utf-8"
    );

    _xlog.log("[module-creator] manifest saved", {
      _module_id: spec._id,
      _artifact_path: artifact_path
    });

    const generation =
      await this.generate_module_js_from_manifest(
        spec._id,
        "generated"
      );

    if (!generation._ok) {
      return generation as XModuleCreatorCreateSpecResult;
    }

    const saved_manifest_json =
      await readFile(
        manifest_path(artifact_path),
        "utf-8"
      );
    const saved_module_js =
      await readFile(
        module_file_path(artifact_path),
        "utf-8"
      );

    await update_generated_module_registry(
      this._work_folder,
      generation._spec,
      saved_manifest_json,
      saved_module_js,
      "pending_implementation"
    );

    _xlog.log("[module-creator] module created in pending state", {
      _module_id: spec._id,
      _artifact_path: artifact_path
    });

    return ok({
      _spec: generation._spec,
      _artifact_path: generation._artifact_path,
      _saved: true,
      _module_file: generation._module_file,
      _generated: true
    });
  }

  _validate_module_spec(
    xcmd: XCommand
  ): XModuleCreatorValidationResult {
    const spec =
      read_spec(xcmd._params);

    const errors =
      validate_spec(spec);

    return ok({
      _valid: errors.length === 0,
      _errors: errors
    });
  }

  async _list_module_specs(
    _xcmd: XCommand
  ): Promise<XModuleCreatorListSpecsResult> {
    if (!this._work_folder) {
      return fail(
        "E_MODULE_CREATOR_WORK_FOLDER_REQUIRED",
        "XModuleCreatorModule requires '_work_folder' for manifest persistence"
      ) as XModuleCreatorListSpecsResult;
    }

    const artifact_root =
      path.join(
        this._work_folder,
        ARTIFACT_ROOT
      );

    const specs: XGeneratedModuleSpec[] =
      [];

    let entries: Awaited<ReturnType<typeof readdir>>;

    try {
      entries =
        await readdir(
          artifact_root,
          { withFileTypes: true }
        );
    } catch (err: unknown) {
      const code =
        is_record(err)
          ? err.code
          : undefined;

      if (code !== "ENOENT") {
        return fail(
          "E_MODULE_CREATOR_LIST_FAILED",
          "Failed to list module manifests",
          { _artifact_root: artifact_root }
        ) as XModuleCreatorListSpecsResult;
      }

      _xlog.log("[module-creator] manifests listed", {
        _artifact_root: artifact_root,
        _count: 0
      });

      return ok({
        _specs: [],
        _artifact_root: artifact_root,
        _storage_enabled: true
      });
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const file_path =
        manifest_path(
          path.join(
            artifact_root,
            entry.name
          )
        );

      try {
        const raw =
          await readFile(
            file_path,
            "utf-8"
          );

        const spec =
          JSON.parse(raw) as unknown;

        if (validate_spec(spec).length === 0) {
          specs.push(spec as XGeneratedModuleSpec);
        }
      } catch {
        continue;
      }
    }

    _xlog.log("[module-creator] manifests listed", {
      _artifact_root: artifact_root,
      _count: specs.length
    });

    return ok({
      _specs: specs,
      _artifact_root: artifact_root,
      _storage_enabled: true
    });
  }

  async _get_module_spec(
    xcmd: XCommand
  ): Promise<XModuleCreatorGetSpecResult> {
    const params =
      is_record(xcmd._params)
        ? xcmd._params
        : {};

    const id =
      params._id;

    if (
      typeof id !== "string" ||
      !SAFE_MODULE_OR_OP_NAME.test(id)
    ) {
      return fail(
        "E_MODULE_CREATOR_INVALID_ID",
        "Invalid '_id': expected snake_case/kebab-case safe module id",
        { _field: "_id" }
      ) as XModuleCreatorGetSpecResult;
    }

    if (!this._work_folder) {
      return fail(
        "E_MODULE_CREATOR_WORK_FOLDER_REQUIRED",
        "XModuleCreatorModule requires '_work_folder' for manifest persistence"
      ) as XModuleCreatorGetSpecResult;
    }

    const artifact_path =
      planned_artifact_path(
        this._work_folder,
        id
      );

    const file_path =
      manifest_path(artifact_path);

    let spec: unknown;

    try {
      spec =
        JSON.parse(
          await readFile(
            file_path,
            "utf-8"
          )
        );
    } catch (err: unknown) {
      const code =
        is_record(err)
          ? err.code
          : undefined;

      return fail(
        code === "ENOENT"
          ? "E_MODULE_CREATOR_SPEC_NOT_FOUND"
          : "E_MODULE_CREATOR_READ_FAILED",
        code === "ENOENT"
          ? "Module spec manifest was not found"
          : "Failed to read module spec manifest",
        {
          _id: id,
          _artifact_path: artifact_path
        }
      ) as XModuleCreatorGetSpecResult;
    }

    const errors =
      validate_spec(spec);

    if (errors.length > 0) {
      return fail(
        "E_MODULE_CREATOR_INVALID_STORED_SPEC",
        "Stored module spec failed validation",
        {
          _id: id,
          _artifact_path: artifact_path,
          _errors: errors
        }
      ) as XModuleCreatorGetSpecResult;
    }

    _xlog.log("[module-creator] manifest loaded", {
      _module_id: id,
      _artifact_path: artifact_path
    });

    return ok({
      _spec: spec as XGeneratedModuleSpec,
      _artifact_path: artifact_path
    });
  }

  async _get_generated_module(
    xcmd: XCommand
  ): Promise<XModuleCreatorGeneratedModuleInspectionResult> {
    const name_param =
      read_generated_module_name_param(xcmd._params);
    const module_name =
      name_param?._value;

    if (
      typeof module_name !== "string" ||
      !SAFE_MODULE_OR_OP_NAME.test(module_name)
    ) {
      return fail(
        "E_MODULE_CREATOR_INVALID_NAME",
        "Invalid generated module name: expected snake_case/kebab-case safe module name",
        { _field: name_param?._field ?? "_name" }
      ) as XModuleCreatorGeneratedModuleInspectionResult;
    }

    if (!this._work_folder) {
      return fail(
        "E_MODULE_CREATOR_WORK_FOLDER_REQUIRED",
        "XModuleCreatorModule requires '_work_folder' for generated module inspection"
      ) as XModuleCreatorGeneratedModuleInspectionResult;
    }

    _xlog.log("[module-creator] get generated module", {
      _module_name: module_name
    });

    const registry_entry =
      await resolve_generated_module_registry_entry(
        this._work_folder,
        module_name
      );

    if (!registry_entry) {
      return fail(
        "E_MODULE_CREATOR_GENERATED_MODULE_NOT_FOUND",
        "Generated module registry entry was not found",
        { _name: module_name }
      ) as XModuleCreatorGeneratedModuleInspectionResult;
    }

    const artifact_path =
      planned_artifact_path(
        this._work_folder,
        registry_entry._id
      );

    let manifest_json: string;
    let source: string;
    let spec: unknown;

    try {
      const manifest =
        await read_manifest_file(artifact_path);

      manifest_json =
        manifest.manifest_json;
      spec =
        manifest.spec;
      source =
        await readFile(
          module_file_path(artifact_path),
          "utf-8"
        );
    } catch {
      return fail(
        "E_MODULE_CREATOR_READ_FAILED",
        "Failed to read generated module manifest or source",
        {
          _name: registry_entry._name,
          _artifact_path: artifact_path
        }
      ) as XModuleCreatorGeneratedModuleInspectionResult;
    }

    const errors =
      validate_spec(spec);

    if (errors.length > 0) {
      return fail(
        "E_MODULE_CREATOR_INVALID_STORED_SPEC",
        "Stored module spec failed validation",
        {
          _name: registry_entry._name,
          _artifact_path: artifact_path,
          _errors: errors
        }
      ) as XModuleCreatorGeneratedModuleInspectionResult;
    }

    const valid_spec =
      spec as XGeneratedModuleSpec;

    if (
      valid_spec._id !== registry_entry._id ||
      valid_spec._name !== registry_entry._name
    ) {
      return fail(
        "E_MODULE_CREATOR_REGISTRY_MANIFEST_MISMATCH",
        "Generated module registry entry does not match manifest identity",
        {
          _name: registry_entry._name,
          _manifest_sha256: manifest_sha256(manifest_json)
        }
      ) as XModuleCreatorGeneratedModuleInspectionResult;
    }

    return ok({
      _name: valid_spec._name,
      _state: registry_entry_state(registry_entry),
      _autoload: registry_entry._autoload === true,
      _ops: valid_spec._ops.map((op) => op._name),
      _manifest: valid_spec,
      _source: source,
      _artifact_path: artifact_path,
      _module_file: module_file_path(artifact_path)
    });
  }

  async _save_generated_module_source(
    xcmd: XCommand
  ): Promise<XModuleCreatorSaveGeneratedModuleSourceResult> {
    const params =
      is_record(xcmd._params)
        ? xcmd._params
        : {};
    const name_param =
      read_generated_module_name_param(params);
    const module_name =
      name_param?._value;
    const source =
      params._source;

    if (
      typeof module_name !== "string" ||
      !SAFE_MODULE_OR_OP_NAME.test(module_name)
    ) {
      return fail(
        "E_MODULE_CREATOR_INVALID_NAME",
        "Invalid generated module name: expected snake_case/kebab-case safe module name",
        { _field: name_param?._field ?? "_name" }
      ) as XModuleCreatorSaveGeneratedModuleSourceResult;
    }

    if (typeof source !== "string") {
      return fail(
        "E_MODULE_CREATOR_SOURCE_REQUIRED",
        "save-generated-module-source requires string '_source'",
        { _field: "_source" }
      ) as XModuleCreatorSaveGeneratedModuleSourceResult;
    }

    if (!this._work_folder) {
      return fail(
        "E_MODULE_CREATOR_WORK_FOLDER_REQUIRED",
        "XModuleCreatorModule requires '_work_folder' for generated module source editing"
      ) as XModuleCreatorSaveGeneratedModuleSourceResult;
    }

    _xlog.log("[module-creator] save generated module source", {
      _module_name: module_name
    });

    const registry_entry =
      await resolve_generated_module_registry_entry(
        this._work_folder,
        module_name
      );

    if (!registry_entry) {
      return fail(
        "E_MODULE_CREATOR_GENERATED_MODULE_NOT_FOUND",
        "Generated module registry entry was not found",
        { _name: module_name }
      ) as XModuleCreatorSaveGeneratedModuleSourceResult;
    }

    const artifact_path =
      planned_artifact_path(
        this._work_folder,
        registry_entry._id
      );
    const module_file =
      module_file_path(artifact_path);

    let manifest_json: string;
    let previous_source: string;
    let spec: unknown;

    try {
      const manifest =
        await read_manifest_file(artifact_path);

      manifest_json =
        manifest.manifest_json;
      spec =
        manifest.spec;
      previous_source =
        await readFile(
          module_file,
          "utf-8"
        );
    } catch {
      return fail(
        "E_MODULE_CREATOR_READ_FAILED",
        "Failed to read generated module artifact before saving source",
        {
          _name: registry_entry._name,
          _artifact_path: artifact_path
        }
      ) as XModuleCreatorSaveGeneratedModuleSourceResult;
    }

    const errors =
      validate_spec(spec);

    if (errors.length > 0) {
      return fail(
        "E_MODULE_CREATOR_INVALID_STORED_SPEC",
        "Stored module spec failed validation",
        {
          _name: registry_entry._name,
          _artifact_path: artifact_path,
          _errors: errors
        }
      ) as XModuleCreatorSaveGeneratedModuleSourceResult;
    }

    const valid_spec =
      spec as XGeneratedModuleSpec;

    if (
      valid_spec._id !== registry_entry._id ||
      valid_spec._name !== registry_entry._name
    ) {
      return fail(
        "E_MODULE_CREATOR_REGISTRY_MANIFEST_MISMATCH",
        "Generated module registry entry does not match manifest identity",
        { _name: registry_entry._name }
      ) as XModuleCreatorSaveGeneratedModuleSourceResult;
    }

    const backup_file =
      path.join(
        artifact_path,
        `${MODULE_FILE}.${Date.now()}.bak`
      );

    try {
      await writeFile(
        backup_file,
        previous_source,
        "utf-8"
      );

      await writeFile(
        module_file,
        source,
        "utf-8"
      );
    } catch {
      return fail(
        "E_MODULE_CREATOR_WRITE_FAILED",
        "Failed to backup previous module source or write new source",
        {
          _name: registry_entry._name,
          _module_file: module_file,
          _backup_file: backup_file
        }
      ) as XModuleCreatorSaveGeneratedModuleSourceResult;
    }

    const validation =
      await this._validate_generated_module({
        _module: XModuleCreatorModule._name,
        _op: "validate-generated-module",
        _params: {
          _id: registry_entry._id
        }
      } as unknown as XCommand);

    if (
      !validation._ok ||
      !validation._valid
    ) {
      let restore_error: string | undefined;

      try {
        await writeFile(
          module_file,
          previous_source,
          "utf-8"
        );
      } catch (err: unknown) {
        restore_error =
          err instanceof Error
            ? err.message
            : String(err);
      }

      return fail(
        "E_MODULE_CREATOR_VALIDATION_FAILED",
        "Generated module source failed validation; previous source restored",
        {
          _name: registry_entry._name,
          _backup_file: backup_file,
          _validation: validation,
          ...(restore_error ? { _restore_error: restore_error } : {})
        }
      ) as XModuleCreatorSaveGeneratedModuleSourceResult;
    }

    await update_generated_module_registry_after_module_change(
      this._work_folder,
      valid_spec,
      manifest_json,
      source
    );

    return ok({
      _name: valid_spec._name,
      _state: "implemented",
      _autoload: true,
      _ops: valid_spec._ops.map((op) => op._name),
      _manifest: valid_spec,
      _source: source,
      _artifact_path: artifact_path,
      _module_file: module_file,
      _backup_file: backup_file,
      _module_sha256: content_sha256(source),
      _validation: validation
    });
  }

  async _repair_generated_module(
    xcmd: XCommand
  ): Promise<XModuleCreatorRepairGeneratedModuleResult> {
    const params =
      is_record(xcmd._params)
        ? xcmd._params
        : {};
    const name_param =
      read_generated_module_name_param(params);
    const module_name =
      name_param?._value;
    const prompt =
      params._prompt;
    const max_attempts =
      read_repair_max_attempts_param(params);

    if (
      typeof module_name !== "string" ||
      !SAFE_MODULE_OR_OP_NAME.test(module_name)
    ) {
      return fail(
        "E_MODULE_CREATOR_INVALID_NAME",
        "Invalid generated module name: expected snake_case/kebab-case safe module name",
        { _field: name_param?._field ?? "_name" }
      ) as XModuleCreatorRepairGeneratedModuleResult;
    }

    if (
      typeof prompt !== "string" ||
      prompt.trim().length === 0
    ) {
      return fail(
        "E_MODULE_CREATOR_REPAIR_PROMPT_REQUIRED",
        "repair-generated-module requires non-empty string '_prompt'",
        { _field: "_prompt" }
      ) as XModuleCreatorRepairGeneratedModuleResult;
    }

    if (max_attempts === undefined) {
      return fail(
        "E_MODULE_CREATOR_REPAIR_MAX_ATTEMPTS_INVALID",
        "Invalid '_max_attempts': expected positive integer",
        { _field: "_max_attempts" }
      ) as XModuleCreatorRepairGeneratedModuleResult;
    }

    if (!this._work_folder) {
      return fail(
        "E_MODULE_CREATOR_WORK_FOLDER_REQUIRED",
        "XModuleCreatorModule requires '_work_folder' for generated module repair"
      ) as XModuleCreatorRepairGeneratedModuleResult;
    }

    _xlog.log("[module-creator] repair generated module", {
      _module_name: module_name,
      _max_attempts: max_attempts
    });

    const registry_entry =
      await resolve_generated_module_registry_entry(
        this._work_folder,
        module_name
      );

    if (!registry_entry) {
      return fail(
        "E_MODULE_CREATOR_GENERATED_MODULE_NOT_FOUND",
        "Generated module registry entry was not found",
        { _name: module_name }
      ) as XModuleCreatorRepairGeneratedModuleResult;
    }

    const artifact_path =
      planned_artifact_path(
        this._work_folder,
        registry_entry._id
      );
    const module_file =
      module_file_path(artifact_path);

    let current_source: string;
    let spec: unknown;

    try {
      const manifest =
        await read_manifest_file(artifact_path);

      spec =
        manifest.spec;
      current_source =
        await readFile(
          module_file,
          "utf-8"
        );
    } catch {
      return fail(
        "E_MODULE_CREATOR_READ_FAILED",
        "Failed to read generated module artifact before repair",
        {
          _name: registry_entry._name,
          _artifact_path: artifact_path
        }
      ) as XModuleCreatorRepairGeneratedModuleResult;
    }

    const manifest_errors =
      validate_spec(spec);

    if (manifest_errors.length > 0) {
      return fail(
        "E_MODULE_CREATOR_INVALID_STORED_SPEC",
        "Stored module spec failed validation",
        {
          _name: registry_entry._name,
          _artifact_path: artifact_path,
          _errors: manifest_errors
        }
      ) as XModuleCreatorRepairGeneratedModuleResult;
    }

    const valid_spec =
      spec as XGeneratedModuleSpec;

    if (
      valid_spec._id !== registry_entry._id ||
      valid_spec._name !== registry_entry._name
    ) {
      return fail(
        "E_MODULE_CREATOR_REGISTRY_MANIFEST_MISMATCH",
        "Generated module registry entry does not match manifest identity",
        { _name: registry_entry._name }
      ) as XModuleCreatorRepairGeneratedModuleResult;
    }

    let validation_errors: unknown;
    const rejected_attempts: XModuleCreatorGeneratedModuleRejectedAttempt[] =
      [];

    for (
      let attempt = 1;
      attempt <= max_attempts;
      attempt++
    ) {
      const repair_prompt =
        build_generated_module_repair_prompt({
          spec: valid_spec,
          source: current_source,
          prompt,
          ...(params._context !== undefined ? { context: params._context } : {}),
          ...(params._errors !== undefined ? { errors: params._errors } : {}),
          ...(params._view !== undefined ? { view: params._view } : {}),
          ...(validation_errors !== undefined ? { validation_errors } : {}),
          ...(rejected_attempts.length > 0 ? { rejected_attempts } : {})
        });

      let implementation_sources: XModuleCreatorGeneratedModuleImplementationSources | undefined;

      try {
        const xai_result =
          unwrap_command_result(
            await _x.execute({
              _module: "xai",
              _op: "generate",
              _params: {
                _prompt: repair_prompt,
                response_format: {
                  type: "json_object"
                }
              }
            } as unknown as XCommand)
          );

        implementation_sources =
          parse_generated_module_implementation_methods(xai_result);
      } catch (err: unknown) {
        validation_errors = {
          _ok: false,
          _error: {
            _code: "E_MODULE_CREATOR_REPAIR_GENERATION_SHAPE",
            _message: err instanceof Error ? err.message : String(err),
            _category: "syntax_or_shape_error"
          }
        };

        rejected_attempts.push({
          _attempt: attempt,
          _category: "syntax_or_shape_error",
          _validation_errors: validation_errors
        });

        _xlog.warn("[module-creator] repair validation failed", {
          _module_name: valid_spec._name,
          _attempt: attempt,
          _max_attempts: max_attempts,
          _validation_errors: validation_errors
        });

        continue;
      }

      let implementation_response: XModuleCreatorImplementGeneratedModuleResult;

      try {
        implementation_response =
          await this._implement_generated_module({
            _module: XModuleCreatorModule._name,
            _op: "implement-generated-module",
            _params: {
              _id: valid_spec._id,
              _implementation_request: prompt,
              _context: {
                _repair: true,
                _methods: implementation_sources._method_sources,
                _helpers: implementation_sources._helper_sources
              }
            }
          } as unknown as XCommand);
      } catch (err: unknown) {
        validation_errors = {
          _ok: false,
          _error: {
            _code: "E_MODULE_CREATOR_REPAIR_APPLY_FAILED",
            _message: err instanceof Error ? err.message : String(err),
            _category: "unknown"
          }
        };

        rejected_attempts.push({
          _attempt: attempt,
          _category: "unknown",
          _validation_errors: validation_errors,
          _method_sources: implementation_sources._method_sources,
          _method_source_excerpts: method_source_excerpts(implementation_sources._method_sources),
          _helpers: implementation_sources._helper_sources,
          _helper_excerpts: method_source_excerpts(implementation_sources._helper_sources),
          _helper_sources: implementation_sources._helper_sources,
          _helper_source_excerpts: method_source_excerpts(implementation_sources._helper_sources)
        });

        await writeFile(
          module_file,
          current_source,
          "utf-8"
        );

        _xlog.warn("[module-creator] repair validation failed", {
          _module_name: valid_spec._name,
          _attempt: attempt,
          _max_attempts: max_attempts,
          _validation_errors: validation_errors
        });

        continue;
      }

      if (!implementation_response._ok) {
        validation_errors =
          implementation_response;
        const category =
          classify_implementation_validation_failure(
            implementation_response
          );

        rejected_attempts.push({
          _attempt: attempt,
          _category: category,
          _validation_errors: implementation_response,
          _method_sources: implementation_sources._method_sources,
          _method_source_excerpts: method_source_excerpts(implementation_sources._method_sources),
          _helpers: implementation_sources._helper_sources,
          _helper_excerpts: method_source_excerpts(implementation_sources._helper_sources),
          _helper_sources: implementation_sources._helper_sources,
          _helper_source_excerpts: method_source_excerpts(implementation_sources._helper_sources)
        });

        await writeFile(
          module_file,
          current_source,
          "utf-8"
        );

        _xlog.warn("[module-creator] repair validation failed", {
          _module_name: valid_spec._name,
          _attempt: attempt,
          _max_attempts: max_attempts,
          _category: category,
          _validation_errors: validation_errors
        });

        continue;
      }

      const repaired_source =
        await readFile(
          module_file,
          "utf-8"
        );

      _xlog.log("[module-creator] repair success", {
        _module_name: valid_spec._name,
        _attempt: attempt,
        _module_sha256: content_sha256(repaired_source)
      });

      return ok({
        _name: valid_spec._name,
        _state: "implemented",
        _autoload: true,
        _ops: valid_spec._ops.map((op) => op._name),
        _manifest: valid_spec,
        _source: repaired_source,
        _artifact_path: artifact_path,
        _module_file: module_file,
        _module_sha256: content_sha256(repaired_source),
        _attempt: attempt,
        _validation: implementation_response._validation,
        _implementation: implementation_response
      });
    }

    await writeFile(
      module_file,
      current_source,
      "utf-8"
    );

    return fail(
      "E_MODULE_CREATOR_REPAIR_FAILED",
      "Generated module repair failed validation after bounded attempts; existing source unchanged",
      {
        _name: valid_spec._name,
        _max_attempts: max_attempts,
        _attempts: rejected_attempts
      }
    ) as XModuleCreatorRepairGeneratedModuleResult;
  }

  async _disable_generated_module(
    xcmd: XCommand
  ): Promise<XModuleCreatorDisableGeneratedModuleResult> {
    const name_param =
      read_generated_module_name_param(xcmd._params);
    const module_name =
      name_param?._value;

    if (
      typeof module_name !== "string" ||
      !SAFE_MODULE_OR_OP_NAME.test(module_name)
    ) {
      return fail(
        "E_MODULE_CREATOR_INVALID_NAME",
        "Invalid generated module name: expected snake_case/kebab-case safe module name",
        { _field: name_param?._field ?? "_name" }
      ) as XModuleCreatorDisableGeneratedModuleResult;
    }

    if (!this._work_folder) {
      return fail(
        "E_MODULE_CREATOR_WORK_FOLDER_REQUIRED",
        "XModuleCreatorModule requires '_work_folder' for generated module lifecycle management"
      ) as XModuleCreatorDisableGeneratedModuleResult;
    }

    _xlog.log("[module-creator] disable generated module", {
      _module_name: module_name
    });

    const resolved =
      await resolve_generated_module_registry_record(
        this._work_folder,
        module_name
      );

    if (!resolved) {
      return fail(
        "E_MODULE_CREATOR_GENERATED_MODULE_NOT_FOUND",
        "Generated module registry entry was not found",
        { _name: module_name }
      ) as XModuleCreatorDisableGeneratedModuleResult;
    }

    const now =
      Date.now();
    const disabled_entry: XGeneratedModuleRegistryEntry =
      {
        ...resolved.entry,
        _autoload: false,
        _state: "disabled",
        _implementation_complete: false,
        _updated_at: now
      };

    resolved.registry._modules[resolved.key] =
      disabled_entry;

    await write_generated_module_registry(
      resolved.registry_file,
      resolved.registry
    );

    return ok({
      _name: disabled_entry._name,
      _state: "disabled",
      _autoload: false
    });
  }

  async _delete_generated_module(
    xcmd: XCommand
  ): Promise<XModuleCreatorDeleteGeneratedModuleResult> {
    const name_param =
      read_generated_module_name_param(xcmd._params);
    const module_name =
      name_param?._value;

    if (
      typeof module_name !== "string" ||
      !SAFE_MODULE_OR_OP_NAME.test(module_name)
    ) {
      return fail(
        "E_MODULE_CREATOR_INVALID_NAME",
        "Invalid generated module name: expected snake_case/kebab-case safe module name",
        { _field: name_param?._field ?? "_name" }
      ) as XModuleCreatorDeleteGeneratedModuleResult;
    }

    if (!this._work_folder) {
      return fail(
        "E_MODULE_CREATOR_WORK_FOLDER_REQUIRED",
        "XModuleCreatorModule requires '_work_folder' for generated module lifecycle management"
      ) as XModuleCreatorDeleteGeneratedModuleResult;
    }

    _xlog.log("[module-creator] delete generated module", {
      _module_name: module_name
    });

    const resolved =
      await resolve_generated_module_registry_record(
        this._work_folder,
        module_name
      );

    if (!resolved) {
      return fail(
        "E_MODULE_CREATOR_GENERATED_MODULE_NOT_FOUND",
        "Generated module registry entry was not found",
        { _name: module_name }
      ) as XModuleCreatorDeleteGeneratedModuleResult;
    }

    const artifact_path =
      planned_artifact_path(
        this._work_folder,
        resolved.entry._id
      );
    const deleted_root =
      path.join(
        this._work_folder,
        ARTIFACT_ROOT,
        ".deleted"
      );
    const deleted_path =
      path.join(
        deleted_root,
        `${resolved.entry._id}-${Date.now()}`
      );

    try {
      await mkdir(
        deleted_root,
        { recursive: true }
      );

      await rename(
        artifact_path,
        deleted_path
      );
    } catch (err: unknown) {
      const code =
        is_record(err)
          ? err.code
          : undefined;

      return fail(
        code === "ENOENT"
          ? "E_MODULE_CREATOR_ARTIFACT_NOT_FOUND"
          : "E_MODULE_CREATOR_DELETE_FAILED",
        code === "ENOENT"
          ? "Generated module artifact directory was not found"
          : "Failed to move generated module artifact directory to deleted area",
        {
          _name: resolved.entry._name,
          _artifact_path: artifact_path
        }
      ) as XModuleCreatorDeleteGeneratedModuleResult;
    }

    delete resolved.registry._modules[resolved.key];

    await write_generated_module_registry(
      resolved.registry_file,
      resolved.registry
    );

    return ok({
      _name: resolved.entry._name,
      _deleted: true
    });
  }

  async _generate_module_js(
    xcmd: XCommand
  ): Promise<XModuleCreatorGenerateJsResult> {
    const params =
      is_record(xcmd._params)
        ? xcmd._params
        : {};

    const id =
      params._id;

    if (
      typeof id !== "string" ||
      !SAFE_MODULE_OR_OP_NAME.test(id)
    ) {
      return fail(
        "E_MODULE_CREATOR_INVALID_ID",
        "Invalid '_id': expected snake_case/kebab-case safe module id",
        { _field: "_id" }
      ) as XModuleCreatorGenerateJsResult;
    }

    return this.generate_module_js_from_manifest(
      id,
      "regenerated"
    );
  }

  async _implement_generated_module(
    xcmd: XCommand
  ): Promise<XModuleCreatorImplementGeneratedModuleResult> {
    const id =
      read_id_param(xcmd._params);
    const params =
      is_record(xcmd._params)
        ? xcmd._params
        : {};
    const context =
      is_record(params._context)
        ? params._context
        : {};
    const method_sources =
      is_record(context._method_sources)
        ? context._method_sources
        : is_record(context._methods)
        ? context._methods
        : {};
    const helper_sources =
      is_record(context._helpers)
        ? context._helpers
        : is_record(context._helper_sources)
        ? context._helper_sources
        : {};
    const repair_mode =
      context._repair === true;

    if (
      typeof id !== "string" ||
      !SAFE_MODULE_OR_OP_NAME.test(id)
    ) {
      return fail(
        "E_MODULE_CREATOR_INVALID_ID",
        "Invalid '_id': expected snake_case/kebab-case safe module id",
        { _field: "_id" }
      ) as XModuleCreatorImplementGeneratedModuleResult;
    }

    if (!this._work_folder) {
      return fail(
        "E_MODULE_CREATOR_WORK_FOLDER_REQUIRED",
        "XModuleCreatorModule requires '_work_folder' for generated module implementation"
      ) as XModuleCreatorImplementGeneratedModuleResult;
    }

    if (
      Object.keys(method_sources).length === 0 &&
      Object.keys(helper_sources).length === 0
    ) {
      return fail(
        "E_MODULE_CREATOR_IMPLEMENTATION_METHODS_REQUIRED",
        "implement-generated-module requires '_context._methods' or '_context._helpers'",
        {
          _id: id,
          _implementation_request:
            typeof params._implementation_request === "string"
              ? params._implementation_request
              : undefined
        }
      ) as XModuleCreatorImplementGeneratedModuleResult;
    }

    const artifact_path =
      planned_artifact_path(
        this._work_folder,
        id
      );
    const module_file =
      module_file_path(artifact_path);

    const validation_before =
      await this._validate_generated_module({
        _module: XModuleCreatorModule._name,
        _op: "validate-generated-module",
        _params: {
          _id: id
        }
      } as unknown as XCommand);

    if (
      !validation_before._ok ||
      !validation_before._valid
    ) {
      if (!repair_mode) {
        return fail(
          "E_MODULE_CREATOR_VALIDATION_FAILED",
          "Generated module validation failed before implementation; refusing to edit",
          {
            _id: id,
            _validation: validation_before
          }
        ) as XModuleCreatorImplementGeneratedModuleResult;
      }
    }

    let manifest_json: string;
    let module_js: string;
    let spec: unknown;

    try {
      const manifest =
        await read_manifest_file(artifact_path);

      manifest_json =
        manifest.manifest_json;
      spec =
        manifest.spec;
      module_js =
        await readFile(
          module_file,
          "utf-8"
        );
    } catch {
      return fail(
        "E_MODULE_CREATOR_READ_FAILED",
        "Failed to read generated module artifact for implementation",
        { _id: id, _artifact_path: artifact_path }
      ) as XModuleCreatorImplementGeneratedModuleResult;
    }

    const manifest_errors =
      validate_spec(spec);

    if (manifest_errors.length > 0) {
      return fail(
        "E_MODULE_CREATOR_INVALID_STORED_SPEC",
        "Stored module spec failed validation",
        {
          _id: id,
          _artifact_path: artifact_path,
          _errors: manifest_errors
        }
      ) as XModuleCreatorImplementGeneratedModuleResult;
    }

    const valid_spec =
      spec as XGeneratedModuleSpec;
    const declared_methods =
      extract_declared_generated_methods(
        module_js,
        valid_spec
      );
    const declared_method_names =
      new Set(
        valid_spec._ops.map((op) => op_method_name(op._name))
      );
    const declared_ops_by_method =
      new Map<string, XGeneratedModuleOpSpec>(
        valid_spec._ops.map((op) => [
          op_method_name(op._name),
          op
        ])
      );
    const requested_method_names =
      Object.keys(method_sources);
    const requested_helper_names =
      Object.keys(helper_sources);

    const misplaced_helper_method_names =
      requested_method_names.filter((method_name) =>
        !declared_method_names.has(method_name) &&
        /^_[A-Za-z][A-Za-z0-9_$]*$/.test(method_name)
      );

    if (misplaced_helper_method_names.length > 0) {
      const helper_names =
        misplaced_helper_method_names.map((method_name) =>
          `${method_name.charAt(1).toLowerCase()}${method_name.slice(2)}`
        );

      _xlog.warn("[module-creator] helper method rejected", {
        _module_id: id,
        _method_names: misplaced_helper_method_names,
        _helper_names: helper_names,
        _reason: "helper_method_misplaced"
      });

      return fail(
        "E_MODULE_CREATOR_HELPER_METHOD_MISPLACED",
        "Helper methods must be returned under '_helpers' without leading underscores",
        {
          _id: id,
          _method_names: misplaced_helper_method_names,
          _helper_names: helper_names
        },
        "helper_method_misplaced"
      ) as XModuleCreatorImplementGeneratedModuleResult;
    }

    for (const method_name of requested_method_names) {
      if (!declared_method_names.has(method_name)) {
        return fail(
          "E_MODULE_CREATOR_IMPLEMENTATION_UNDECLARED_METHOD",
          "Method replacement is not declared by manifest ops",
          {
            _id: id,
            _method_name: method_name
          }
        ) as XModuleCreatorImplementGeneratedModuleResult;
      }

      if (!declared_methods.has(method_name)) {
        return fail(
          "E_MODULE_CREATOR_IMPLEMENTATION_METHOD_NOT_FOUND",
          "Declared generated method was not found in module.js",
          {
            _id: id,
            _method_name: method_name
          }
        ) as XModuleCreatorImplementGeneratedModuleResult;
      }
    }

    let next_module_js =
      module_js;
    const replacements =
      requested_method_names
        .map((method_name) => ({
          method: declared_methods.get(method_name)!,
          source: method_sources[method_name]
        }))
        .sort((a, b) => b.method._body_start - a.method._body_start);
    const implemented_methods: string[] =
      [];
    const accepted_helper_sources: Record<string, string> =
      {};

    for (const replacement of replacements) {
      if (typeof replacement.source !== "string") {
        return fail(
          "E_MODULE_CREATOR_IMPLEMENTATION_METHOD_INVALID",
          "Method replacement source must be a string",
          {
            _id: id,
            _method_name: replacement.method._method_name
          }
        ) as XModuleCreatorImplementGeneratedModuleResult;
      }

      _xlog.log(
        "[module-creator] validating implementation source",
        {
          _module_id: id,
          _method_name: replacement.method._method_name,
          _source: replacement.source
        }
      );

      const validated_replacement =
        validate_method_replacement_source(
          replacement.method._method_name,
          replacement.source,
          id,
          declared_ops_by_method.get(replacement.method._method_name)
        );

      if (!validated_replacement._ok) {
        _xlog.warn(
          "[module-creator] implementation validation failed",
          {
            _module_id: id,
            _method_name: replacement.method._method_name,
            _source: replacement.source,
            _error: validated_replacement
          }
        );

        return validated_replacement as XModuleCreatorImplementGeneratedModuleResult;
      }

      next_module_js =
        replace_generated_method(
          next_module_js,
          replacement.method,
          validated_replacement._body
        );
      implemented_methods.push(
        replacement.method._method_name
      );
    }

    for (const helper_name of requested_helper_names) {
      const validated_helper =
        validate_helper_method_source(
          helper_name,
          helper_sources[helper_name],
          declared_method_names,
          id
        );

      if (!validated_helper._ok) {
        return validated_helper as XModuleCreatorImplementGeneratedModuleResult;
      }

      accepted_helper_sources[helper_name] =
        validated_helper._source;
    }

    if (Object.keys(accepted_helper_sources).length > 0) {
      _xlog.log("[module-creator] helper methods accepted", {
        _module_id: id,
        _helper_methods: Object.keys(accepted_helper_sources)
      });
    }

    if (
      strip_declared_method_bodies(
        module_js,
        valid_spec
      ) !==
      strip_declared_method_bodies(
        next_module_js,
        valid_spec
      )
    ) {
      return fail(
        "E_MODULE_CREATOR_IMPLEMENTATION_SCOPE_VIOLATION",
        "Implementation changed generated module content outside declared method bodies",
        { _id: id }
      ) as XModuleCreatorImplementGeneratedModuleResult;
    }

    const expected_class_name =
      module_class_name(valid_spec._name);

    if (Object.keys(accepted_helper_sources).length > 0) {
      next_module_js =
        apply_helper_methods(
          next_module_js,
          expected_class_name,
          accepted_helper_sources
        );

      _xlog.log("[module-creator] helper methods applied", {
        _module_id: id,
        _helper_methods: Object.keys(accepted_helper_sources)
      });
    }

    const manifest_hash =
      manifest_sha256(manifest_json);
    const candidate_valid =
      generated_metadata_valid(valid_spec, next_module_js) &&
      manifest_hash_valid(next_module_js, manifest_hash) &&
      imports_are_valid(next_module_js) &&
      new RegExp(
        `export class ${escape_regexp(expected_class_name)}\\b`
      ).test(next_module_js) &&
      new RegExp(
        `export class ${escape_regexp(expected_class_name)} extends XModule\\b`
      ).test(next_module_js) &&
      next_module_js.includes(
        `static _name = ${JSON.stringify(valid_spec._name)};`
      ) &&
      module_ops_match_manifest(valid_spec, next_module_js) &&
      generated_skill_valid(valid_spec, next_module_js) &&
      public_methods_match_manifest(valid_spec, next_module_js) &&
      !has_forbidden_generated_content(next_module_js);

    if (!candidate_valid) {
      return fail(
        "E_MODULE_CREATOR_IMPLEMENTATION_VALIDATION_FAILED",
        "Implemented module candidate failed static validation before write",
        { _id: id }
      ) as XModuleCreatorImplementGeneratedModuleResult;
    }

    await writeFile(
      module_file,
      next_module_js,
      "utf-8"
    );

    const validation_after =
      await this._validate_generated_module({
        _module: XModuleCreatorModule._name,
        _op: "validate-generated-module",
        _params: {
          _id: id
        }
      } as unknown as XCommand);

    if (
      !validation_after._ok ||
      !validation_after._valid
    ) {
      return fail(
        "E_MODULE_CREATOR_IMPLEMENTATION_VALIDATION_FAILED",
        "Implemented module failed validate-generated-module after write",
        {
          _id: id,
          _validation: validation_after
        }
      ) as XModuleCreatorImplementGeneratedModuleResult;
    }

    await update_generated_module_registry_after_module_change(
      this._work_folder,
      valid_spec,
      manifest_json,
      next_module_js
    );

    _xlog.log("[module-creator] module marked implemented", {
      _module_id: id,
      _implemented_methods: implemented_methods
    });

    _xlog.log("[module-creator] generated module implemented", {
      _module_id: id,
      _implemented_methods: implemented_methods
    });

    return ok({
      _id: id,
      _artifact_path: artifact_path,
      _module_file: module_file,
      _implemented_methods: implemented_methods,
      _module_sha256: content_sha256(next_module_js),
      _validation: validation_after
    });
  }

  async _load_generated_module(
    xcmd: XCommand
  ): Promise<XModuleCreatorLoadGeneratedModuleResult> {
    const id =
      read_id_param(xcmd._params);

    const reload =
      read_reload_param(xcmd._params);

    if (
      typeof id !== "string" ||
      !SAFE_MODULE_OR_OP_NAME.test(id)
    ) {
      return fail(
        "E_MODULE_CREATOR_INVALID_ID",
        "Invalid '_id': expected snake_case/kebab-case safe module id",
        { _field: "_id" }
      ) as XModuleCreatorLoadGeneratedModuleResult;
    }

    if (!this._work_folder) {
      return fail(
        "E_MODULE_CREATOR_WORK_FOLDER_REQUIRED",
        "XModuleCreatorModule requires '_work_folder' for generated module loading"
      ) as XModuleCreatorLoadGeneratedModuleResult;
    }

    const artifact_path =
      planned_artifact_path(
        this._work_folder,
        id
      );

    const module_file =
      module_file_path(artifact_path);

    _xlog.log("[module-creator] generated module loading started", {
      _module_id: id,
      _artifact_path: artifact_path,
      _reload: reload
    });

    const registry_entry =
      await read_generated_module_registry_entry(
        this._work_folder,
        id
      );

    if (registry_entry_pending_implementation(registry_entry)) {
      _xlog.log("[module-creator] generated module load failed", {
        _module_id: id,
        _reason: "pending_implementation"
      });

      return fail(
        "E_MODULE_CREATOR_PENDING_IMPLEMENTATION",
        "Generated module implementation has not completed; refusing to load",
        {
          _id: id,
          _state: "pending_implementation"
        }
      ) as XModuleCreatorLoadGeneratedModuleResult;
    }

    const validation =
      await this._validate_generated_module({
        _module: XModuleCreatorModule._name,
        _op: "validate-generated-module",
        _params: {
          _id: id
        }
      } as unknown as XCommand);

    if (
      !validation._ok ||
      !validation._valid
    ) {
      _xlog.log("[module-creator] generated module load failed", {
        _module_id: id,
        _reason: "validation_failed"
      });

      return fail(
        "E_MODULE_CREATOR_VALIDATION_FAILED",
        "Generated module validation failed; refusing to import",
        {
          _id: id,
          _validation: validation
        }
      ) as XModuleCreatorLoadGeneratedModuleResult;
    }

    _xlog.log("[module-creator] validation gate passed", {
      _module_id: id,
      _module_file: module_file
    });

    let manifest_json: string;
    let spec: unknown;

    try {
      const manifest =
        await read_manifest_file(artifact_path);

      manifest_json =
        manifest.manifest_json;
      spec =
        manifest.spec;
    } catch {
      return fail(
        "E_MODULE_CREATOR_READ_FAILED",
        "Failed to read validated module manifest",
        { _artifact_path: artifact_path }
      ) as XModuleCreatorLoadGeneratedModuleResult;
    }

    const manifest_errors =
      validate_spec(spec);

    if (manifest_errors.length > 0) {
      return fail(
        "E_MODULE_CREATOR_INVALID_STORED_SPEC",
        "Stored module spec failed validation",
        {
          _id: id,
          _artifact_path: artifact_path,
          _errors: manifest_errors
        }
      ) as XModuleCreatorLoadGeneratedModuleResult;
    }

    const valid_spec =
      spec as XGeneratedModuleSpec;

    const existing =
      _x.getModule(valid_spec._name);

    if (existing) {
      return fail(
        reload
          ? "E_MODULE_CREATOR_RELOAD_UNSUPPORTED"
          : "E_MODULE_CREATOR_MODULE_ALREADY_LOADED",
        reload
          ? "Generated module reload is unsupported by the current runtime"
          : "A module with the same name is already loaded",
        {
          _id: id,
          _name: valid_spec._name
        }
      ) as XModuleCreatorLoadGeneratedModuleResult;
    }

    const manifest_hash =
      manifest_sha256(manifest_json);

    const import_url =
      pathToFileURL(module_file);

    if (reload) {
      import_url.searchParams.set(
        "manifest_sha256",
        manifest_hash
      );
    }

    let imported_module: Record<string, unknown>;

    try {
      imported_module =
        await import(import_url.href) as Record<string, unknown>;
    } catch (err: unknown) {
      _xlog.log("[module-creator] generated module load failed", {
        _module_id: id,
        _reason: "dynamic_import_failed"
      });

      return fail(
        "E_MODULE_CREATOR_DYNAMIC_IMPORT_FAILED",
        "Failed to dynamically import validated generated module",
        {
          _id: id,
          _module_file: module_file,
          _message: err instanceof Error ? err.message : "Unknown import error"
        }
      ) as XModuleCreatorLoadGeneratedModuleResult;
    }

    _xlog.log("[module-creator] dynamic import completed", {
      _module_id: id,
      _module_file: module_file
    });

    const class_name =
      module_class_name(valid_spec._name);

    const module_class =
      imported_module.default ??
      imported_module[class_name];

    if (typeof module_class !== "function") {
      return fail(
        "E_MODULE_CREATOR_MODULE_CLASS_INVALID",
        "Generated module export did not contain the expected module class",
        {
          _id: id,
          _expected_class_name: class_name
        }
      ) as XModuleCreatorLoadGeneratedModuleResult;
    }

    const generated_class =
      module_class as unknown as {
        _name?: unknown;
        _ops?: unknown;
        _skill?: unknown;
        new(): unknown;
      };

    if (
      generated_class._name !== valid_spec._name ||
      !is_record(generated_class._ops) ||
      !is_record(generated_class._skill)
    ) {
      return fail(
        "E_MODULE_CREATOR_MODULE_CLASS_INVALID",
        "Generated module class statics do not match manifest expectations",
        {
          _id: id,
          _expected_name: valid_spec._name
        }
      ) as XModuleCreatorLoadGeneratedModuleResult;
    }

    let instance: unknown;

    try {
      instance =
        new generated_class();
    } catch (err: unknown) {
      return fail(
        "E_MODULE_CREATOR_MODULE_INSTANTIATION_FAILED",
        "Failed to instantiate generated module class",
        {
          _id: id,
          _message: err instanceof Error ? err.message : "Unknown instantiation error"
        }
      ) as XModuleCreatorLoadGeneratedModuleResult;
    }

    if (
      !(instance instanceof XModule) &&
      (
        !is_record(instance) ||
        instance._name !== valid_spec._name ||
        typeof instance.load !== "function" ||
        typeof instance.execute !== "function"
      )
    ) {
      return fail(
        "E_MODULE_CREATOR_MODULE_INSTANCE_INVALID",
        "Generated module instance does not match XModule runtime shape",
        {
          _id: id,
          _name: valid_spec._name
        }
      ) as XModuleCreatorLoadGeneratedModuleResult;
    }

    const xmodule_instance =
      instance as XModule;

    try {
      await _x.loadModuleAsync(xmodule_instance);
    } catch (err: unknown) {
      _xlog.log("[module-creator] generated module load failed", {
        _module_id: id,
        _reason: "runtime_load_failed"
      });

      return fail(
        "E_MODULE_CREATOR_RUNTIME_LOAD_FAILED",
        "Runtime failed to load generated module instance",
        {
          _id: id,
          _name: valid_spec._name,
          _message: err instanceof Error ? err.message : "Unknown runtime load error"
        }
      ) as XModuleCreatorLoadGeneratedModuleResult;
    }

    const skills_available =
      this.runtime_skills_include_module(valid_spec._name);

    _xlog.log("[module-creator] generated module loaded", {
      _module_id: id,
      _name: valid_spec._name,
      _skills_available: skills_available
    });

    return ok({
      _id: id,
      _name: valid_spec._name,
      _artifact_path: artifact_path,
      _module_file: module_file,
      _loaded: true,
      _reloaded: false,
      _skills_available: skills_available
    });
  }

  async _validate_generated_module(
    xcmd: XCommand
  ): Promise<XModuleCreatorValidateGeneratedModuleResult> {
    const params =
      is_record(xcmd._params)
        ? xcmd._params
        : {};

    const id =
      params._id;

    if (
      typeof id !== "string" ||
      !SAFE_MODULE_OR_OP_NAME.test(id)
    ) {
      return fail(
        "E_MODULE_CREATOR_INVALID_ID",
        "Invalid '_id': expected snake_case/kebab-case safe module id",
        { _field: "_id" }
      ) as XModuleCreatorValidateGeneratedModuleResult;
    }

    if (!this._work_folder) {
      return fail(
        "E_MODULE_CREATOR_WORK_FOLDER_REQUIRED",
        "XModuleCreatorModule requires '_work_folder' for generated artifact validation"
      ) as XModuleCreatorValidateGeneratedModuleResult;
    }

    const artifact_path =
      planned_artifact_path(
        this._work_folder,
        id
      );

    const module_file =
      module_file_path(artifact_path);

    const checks =
      empty_generated_module_checks();

    const errors: XModuleCreatorError[] =
      [];

    _xlog.log("[module-creator] generated module validation started", {
      _module_id: id,
      _artifact_path: artifact_path
    });

    let manifest_json = "";
    let spec: unknown;

    try {
      manifest_json =
        await readFile(
          manifest_path(artifact_path),
          "utf-8"
        );

      spec =
        JSON.parse(manifest_json);

      checks._manifest_exists = true;
    } catch {
      push_error(
        errors,
        "E_MODULE_CREATOR_MANIFEST_NOT_FOUND",
        "Manifest file was not found or could not be read",
        { _artifact_path: artifact_path }
      );
    }

    let valid_spec: XGeneratedModuleSpec | undefined;

    if (checks._manifest_exists) {
      const manifest_errors =
        validate_spec(spec);

      if (manifest_errors.length > 0) {
        errors.push(...manifest_errors);
      } else {
        valid_spec =
          spec as XGeneratedModuleSpec;
      }
    }

    let module_js = "";

    try {
      module_js =
        await readFile(
          module_file,
          "utf-8"
        );
      checks._module_exists = true;
    } catch {
      push_error(
        errors,
        "E_MODULE_CREATOR_MODULE_FILE_NOT_FOUND",
        "Generated module.js file was not found or could not be read",
        { _module_file: module_file }
      );
    }

    if (valid_spec && checks._module_exists) {
      const expected_class_name =
        module_class_name(valid_spec._name);

      const manifest_hash =
        manifest_sha256(manifest_json);

      _xlog.log("[module-creator] checksum validated", {
        _module_id: id,
        _manifest_sha256: manifest_hash
      });

      checks._generated_metadata_valid =
        generated_metadata_valid(
          valid_spec,
          module_js
        );

      checks._manifest_hash_valid =
        manifest_hash_valid(
          module_js,
          manifest_hash
        );

      checks._imports_valid =
        imports_are_valid(module_js);

      checks._class_name_valid =
        new RegExp(
          `export class ${escape_regexp(expected_class_name)}\\b`
        ).test(module_js);

      checks._extends_xmodule =
        new RegExp(
          `export class ${escape_regexp(expected_class_name)} extends XModule\\b`
        ).test(module_js);

      checks._module_name_valid =
        module_js.includes(
          `static _name = ${JSON.stringify(valid_spec._name)};`
        );

      checks._ops_match =
        module_ops_match_manifest(
          valid_spec,
          module_js
        );

      checks._skill_exists =
        module_js.includes("static _skill =");

      checks._skill_valid =
        checks._skill_exists &&
        generated_skill_valid(
          valid_spec,
          module_js
        );

      checks._public_methods_valid =
        public_methods_match_manifest(
          valid_spec,
          module_js
        );

      checks._forbidden_content =
        has_forbidden_generated_content(module_js);

      if (checks._forbidden_content) {
        const matched =
          FORBIDDEN_GENERATED_PATTERNS
            .filter(pattern => pattern.test(module_js))
            .map(pattern => pattern.toString());

        _xlog.warn("[module-creator] forbidden content matched", {
          _module_id: id,
          _matched: matched
        });
      }

      if (!checks._generated_metadata_valid) {
        push_error(
          errors,
          "E_MODULE_CREATOR_GENERATED_METADATA_INVALID",
          "Generated artifact metadata header is missing or does not match manifest"
        );
      }

      if (!checks._manifest_hash_valid) {
        push_error(
          errors,
          "E_MODULE_CREATOR_MANIFEST_HASH_MISMATCH",
          "Generated artifact manifest checksum does not match manifest.json",
          { _expected_sha256: manifest_hash }
        );
      }

      if (!checks._imports_valid) {
        push_error(
          errors,
          "E_MODULE_CREATOR_IMPORTS_INVALID",
          "Generated module imports are not restricted to XModule from @xpell/node"
        );
      }

      if (!checks._class_name_valid) {
        push_error(
          errors,
          "E_MODULE_CREATOR_CLASS_NAME_MISMATCH",
          "Generated class name does not match manifest-derived class name",
          { _expected_class_name: expected_class_name }
        );
      }

      if (!checks._extends_xmodule) {
        push_error(
          errors,
          "E_MODULE_CREATOR_CLASS_INHERITANCE_INVALID",
          "Generated class does not extend XModule",
          { _expected_class_name: expected_class_name }
        );
      }

      if (!checks._module_name_valid) {
        push_error(
          errors,
          "E_MODULE_CREATOR_MODULE_NAME_MISMATCH",
          "Generated static _name does not match manifest _name",
          { _expected_name: valid_spec._name }
        );
      }

      if (!checks._ops_match) {
        push_error(
          errors,
          "E_MODULE_CREATOR_OPS_MISMATCH",
          "Generated ops do not match manifest ops",
          { _expected_ops: valid_spec._ops.map((op) => op._name) }
        );
      }

      if (!checks._skill_exists) {
        push_error(
          errors,
          "E_MODULE_CREATOR_SKILL_MISSING",
          "Generated module does not expose static _skill"
        );
      }

      if (!checks._skill_valid) {
        push_error(
          errors,
          "E_MODULE_CREATOR_SKILL_INVALID",
          "Generated static _skill does not match manifest identity"
        );
      }

      if (!checks._public_methods_valid) {
        push_error(
          errors,
          "E_MODULE_CREATOR_PUBLIC_METHODS_INVALID",
          "Generated public method surface does not match manifest ops",
          {
            _expected_methods: [
              "constructor",
              ...valid_spec._ops.map((op) => op_method_name(op._name))
            ]
          }
        );
      }

      if (checks._forbidden_content) {
        push_error(
          errors,
          "E_MODULE_CREATOR_FORBIDDEN_CONTENT",
          "Generated module contains forbidden runtime content"
        );
      }
    }

    const valid =
      checks._manifest_exists &&
      checks._module_exists &&
      checks._generated_metadata_valid &&
      checks._manifest_hash_valid &&
      checks._imports_valid &&
      checks._class_name_valid &&
      checks._extends_xmodule &&
      checks._module_name_valid &&
      checks._ops_match &&
      checks._skill_exists &&
      checks._skill_valid &&
      checks._public_methods_valid &&
      !checks._forbidden_content &&
      errors.length === 0;

    _xlog.log(
      valid
        ? "[module-creator] generated module validation passed"
        : "[module-creator] generated module validation failed",
      {
        _module_id: id,
        _artifact_path: artifact_path,
        _valid: valid
      }
    );

    return ok({
      _valid: valid,
      _artifact_path: artifact_path,
      _module_file: module_file,
      _checks: checks,
      _errors: errors
    });
  }

  private runtime_skills_include_module(
    module_name: string
  ) {
    if (typeof _x.getSkills !== "function") {
      return false;
    }

    try {
      const skills =
        _x.getSkills();

      return Array.isArray(skills?._modules) &&
        skills._modules.some((module_info: unknown) =>
          is_record(module_info) &&
          module_info._name === module_name
        );
    } catch {
      return false;
    }
  }

  private async generate_module_js_from_manifest(
    id: string,
    log_action: "generated" | "regenerated"
  ): Promise<XModuleCreatorGenerateJsResult> {
    if (!this._work_folder) {
      return fail(
        "E_MODULE_CREATOR_WORK_FOLDER_REQUIRED",
        "XModuleCreatorModule requires '_work_folder' for module artifact generation"
      ) as XModuleCreatorGenerateJsResult;
    }

    const artifact_path =
      planned_artifact_path(
        this._work_folder,
        id
      );

    const manifest_file =
      manifest_path(artifact_path);

    let manifest_json: string;
    let spec: unknown;

    try {
      manifest_json =
        await readFile(
          manifest_file,
          "utf-8"
        );

      spec =
        JSON.parse(manifest_json);
    } catch (err: unknown) {
      const code =
        is_record(err)
          ? err.code
          : undefined;

      return fail(
        code === "ENOENT"
          ? "E_MODULE_CREATOR_SPEC_NOT_FOUND"
          : "E_MODULE_CREATOR_READ_FAILED",
        code === "ENOENT"
          ? "Module spec manifest was not found"
          : "Failed to read module spec manifest",
        {
          _id: id,
          _artifact_path: artifact_path
        }
      ) as XModuleCreatorGenerateJsResult;
    }

    const errors =
      validate_spec(spec);

    if (errors.length > 0) {
      return fail(
        "E_MODULE_CREATOR_INVALID_STORED_SPEC",
        "Stored module spec failed validation",
        {
          _id: id,
          _artifact_path: artifact_path,
          _errors: errors
        }
      ) as XModuleCreatorGenerateJsResult;
    }

    const valid_spec =
      spec as XGeneratedModuleSpec;

    const module_file =
      module_file_path(artifact_path);

    const manifest_hash =
      manifest_sha256(manifest_json);

    _xlog.log("[module-creator] checksum generated", {
      _module_id: id,
      _manifest_sha256: manifest_hash
    });

    await writeFile(
      module_file,
      render_generated_module_js(
        valid_spec,
        manifest_hash
      ),
      "utf-8"
    );

    await writeFile(
      path.join(artifact_path, PACKAGE_FILE),
      JSON.stringify({
        type: "module"
      }, null, 2),
      "utf-8"
    );

    await ensure_generated_package_resolution(
      artifact_path
    );

    _xlog.log("[module-creator] artifact metadata generated", {
      _module_id: id,
      _manifest_sha256: manifest_hash
    });

    _xlog.log(
      log_action === "generated"
        ? "[module-creator] module.js generated"
        : "[module-creator] module.js regenerated",
      {
        _module_id: id,
        _module_file: module_file
      }
    );

    return ok({
      _spec: valid_spec,
      _artifact_path: artifact_path,
      _module_file: module_file,
      _generated: true
    });
  }
}
