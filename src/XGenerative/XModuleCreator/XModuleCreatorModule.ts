import {
  mkdir,
  readFile,
  readdir,
  writeFile
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

const SAFE_MODULE_OR_OP_NAME =
  /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

const SAFE_PARAM_NAME =
  /^_?[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

const FORBIDDEN_GENERATED_CONTENT = [
  "eval(",
  "Function(",
  "child_process",
  "process.exit",
  "import(",
  "fetch(",
  "http.",
  "https.",
  "fs.",
  "setInterval(",
  "setTimeout(",
  "Worker(",
  "vm.",
  "globalThis.process"
];

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
  _details?: Record<string, unknown>
): XModuleCreatorResult {
  return {
    _ok: false,
    _error: {
      _code,
      _message,
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

function manifest_sha256(
  manifest_json: string
) {
  return createHash("sha256")
    .update(manifest_json, "utf-8")
    .digest("hex");
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
  return FORBIDDEN_GENERATED_CONTENT.some((token) =>
    module_js.includes(token)
  );
}

function extract_generated_method_names(
  module_js: string
) {
  const method_names: string[] =
    [];

  const method_pattern =
    /^\s{2}(_[a-z][a-z0-9_]*)\(\)\s*\{/gm;

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
    /^\s{2}([A-Za-z_$][A-Za-z0-9_$]*)\(\)\s*\{/gm;

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
            _ops: "__XMODULE_CREATOR_OPS__"
          }
        ]
      },
      _core_rules: [
        "Generated module artifact derived from manifest.json.",
        "manifest.json is the authoritative source.",
        "Generated module code must not add undeclared ops.",
        "Generated module code must not add undeclared imports."
      ]
    })
      .replace(
        "\"__XMODULE_CREATOR_OPS__\"",
        `Object.values(${class_name}._ops)`
      );

  const methods =
    spec._ops.map((op) => `  ${op_method_name(op._name)}() {
    return {
      _ok: true,
      _message: "Not implemented"
    };
  }`).join("\n\n");

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
