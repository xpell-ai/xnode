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

function read_reload_param(
  params: unknown
) {
  return is_record(params) &&
    params._reload === true;
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
  | "implemented";

type XGeneratedModuleRegistryEntry = {
  _id: string;
  _name: string;
  _target: "server";
  _artifact_path: string;
  _manifest_file: string;
  _module_file: string;
  _manifest_sha256: string;
  _module_sha256: string;
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

  return "implemented";
}

function registry_entry_pending_implementation(
  entry: unknown
) {
  return registry_entry_state(entry) === "pending_implementation";
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
  const method_names: string[] =
    [];

  const method_pattern =
    /^\s{2}(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\([^)]*\)\s*\{/gm;

  let match: RegExpExecArray | null;

  while ((match = method_pattern.exec(module_js)) !== null) {
    method_names.push(match[1]);
  }

  return method_names;
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

function public_methods_match_manifest(
  spec: XGeneratedModuleSpec,
  module_js: string
) {
  const expected_methods =
    [
      "constructor",
      ...spec._ops.map((op) => op_method_name(op._name))
    ];

  return same_string_set(
    expected_methods,
    extract_public_method_names(module_js)
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

function replace_generated_method(
  module_js: string,
  method: XDeclaredGeneratedMethod,
  method_body: string
) {
  return `${module_js.slice(0, method._body_start + 1)}\n${method_body}\n  ${module_js.slice(method._body_end)}`;
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
// Generated by XModuleCreator.
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
      is_record(context._methods)
        ? context._methods
        : undefined;

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

    if (!method_sources) {
      return fail(
        "E_MODULE_CREATOR_IMPLEMENTATION_METHODS_REQUIRED",
        "implement-generated-module requires '_context._methods' with method replacements keyed by declared method name",
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
      return fail(
        "E_MODULE_CREATOR_VALIDATION_FAILED",
        "Generated module validation failed before implementation; refusing to edit",
        {
          _id: id,
          _validation: validation_before
        }
      ) as XModuleCreatorImplementGeneratedModuleResult;
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

    if (requested_method_names.length === 0) {
      return fail(
        "E_MODULE_CREATOR_IMPLEMENTATION_METHODS_REQUIRED",
        "No method replacements were provided",
        { _id: id }
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

    const manifest_hash =
      manifest_sha256(manifest_json);
    const expected_class_name =
      module_class_name(valid_spec._name);
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
