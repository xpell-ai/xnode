/**
 * XStudioModule
 * -----------------------------
 * Live visual editing/orchestration module for Xpell applications.
 *
 * Responsibilities:
 * - Coordinates build/edit studio sessions.
 * - Generates preview views from prompts.
 * - Applies validated view updates to server-xvm.
 * - Bridges live editing workflows with XVibe AI generation.
 * - Manages real-time preview/apply cycles for XUI views.
 * - Can initiate runtime skill synchronization during build mode.
 *
 * Architectural role:
 * - XStudioModule is NOT the AI intelligence layer.
 * - XVibeModule owns:
 *   - skill registry
 *   - knowledge selection
 *   - prompt building
 *   - LLM orchestration
 * - XStudioModule owns:
 *   - live editing workflows
 *   - preview/apply orchestration
 *   - editor/build-mode runtime coordination
 *   - studio session interactions
 *
 * Runtime flow:
 * client(build mode)
 *   -> studio.preview-view
 *   -> xvibe.generate-ui
 *   -> studio.apply-view
 *   -> server-xvm.push_update
 *
 * Notes:
 * - Generated/persisted views must remain data-only JSON.
 * - No JavaScript functions may be persisted in generated views.
 * - server-xvm remains the authoritative runtime view persistence layer.
 * - Studio operations are intended for build/editor contexts only.
 */

import { _x, _xlog, type XCommand, XModule, } from "@xpell/core";
import { type XpellSkill, type XpellSkillCommand } from "@xpell/core";

import { XStudioService } from "./XStudio.service.js";
import type {
  XStudioApplyViewParams,
  XStudioApplyViewResult,
  XStudioArtifactType,
  XStudioErrorResult,
  XStudioGenerateArtifactParams,
  XStudioGenerateViewParams,
  XStudioGenerateViewResult,
  XStudioViewData,
} from "./XStudio.types.js";

const DEFAULT_ENV = "default";
const RUNTIME_SKILL_MAX_APP_ID_LENGTH = 120;
const RUNTIME_SKILL_MAX_ENV_LENGTH = 120;
const RUNTIME_SKILL_MAX_JSON_BYTES = 2_000_000;
const RUNTIME_SKILL_MAX_MODULES = 128;
const RUNTIME_SKILL_MAX_SKILLS = 512;
const RUNTIME_SKILL_MAX_OBJECTS = 1024;
const RUNTIME_SKILL_MAX_TOTAL_OBJECTS = 1024;
const RUNTIME_SKILL_MAX_TOTAL_RECORDS = 16_384;
const RUNTIME_SKILL_MAX_DEPTH = 12;
const RUNTIME_SKILL_MAX_ARRAY_LENGTH = 2_048;
const RUNTIME_SKILL_MAX_STRING_LENGTH = 16_384;
const RUNTIME_SKILL_BLOCKED_KEYS = new Set([
  "_auth",
  "auth",
  "_token",
  "token",
  "authorization",
  "cookie",
  "cookies",
  "_clearance_level",
  "clearance_level",
  "_user_id",
  "user_id",
  "_account_id",
  "account_id",
  "_agent_id",
  "agent_id",
]);
const SUPPORTED_ARTIFACT_TYPES = new Set<XStudioArtifactType>([
  "view",
  "entity",
  "flow",
  "module",
  "auto",
]);

type ServerXvmGetViewResult = {
  _app_id: string;
  _env: string;
  _version: number;
  _view: Record<string, unknown>;
};

type ServerXvmPushUpdateResult = {
  _ok: boolean;
  _app_id: string;
  _env: string;
  _view_id: string;
  _version: number;
  _notified_subscribers: string[];
};

type XStudioArtifactSummary = {
  _id: string;
  _title?: string;
  _path?: string;
  _enabled?: boolean;
};

function is_plain_object(_value: unknown): _value is Record<string, unknown> {
  return typeof _value === "object" && _value !== null && !Array.isArray(_value);
}

function bounded_error_message(_value: unknown): string {
  if (_value instanceof Error) return _value.message;
  if (is_plain_object(_value)) {
    const message = _value._message ?? _value.message ?? _value._reason;
    if (typeof message === "string" && message.trim()) return message.trim();
    const code = _value._code ?? _value.code;
    if (typeof code === "string" && code.trim()) return code.trim();
  }
  if (typeof _value === "string" && _value.trim()) return _value.trim();
  return "Runtime skill storage failed.";
}

function bounded_xvibe_failure(_value: unknown): Record<string, unknown> {
  const result = is_plain_object(_value) && is_plain_object(_value._result)
    ? _value._result
    : is_plain_object(_value)
      ? _value
      : {};

  const code = typeof result._code === "string" && result._code.trim()
    ? result._code.trim()
    : typeof result.code === "string" && result.code.trim()
      ? result.code.trim()
      : "E_XVIBE_SYNC_SKILLS_FAILED";

  return {
    _code: code,
    _message: bounded_error_message(result),
  };
}

function runtime_skill_object_count(skills: unknown): number {
  if (!is_plain_object(skills)) return 0;
  let count = Array.isArray(skills._objects) ? skills._objects.length : 0;
  if (Array.isArray(skills._modules)) {
    for (const module_skill of skills._modules) {
      if (is_plain_object(module_skill) && Array.isArray(module_skill._objects)) {
        count += module_skill._objects.length;
      }
    }
  }
  return count;
}

type RuntimeSkillPayloadMetrics = {
  _payload_bytes: number;
  _root_object_count: number;
  _module_object_count: number;
  _object_count: number;
  _module_count: number;
  _root_skill_count: number;
};

function safe_json_stringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function runtime_skill_payload_metrics(
  skills: unknown,
  json?: string,
): RuntimeSkillPayloadMetrics {
  const payload = is_plain_object(skills) ? skills : {};
  const modules = Array.isArray(payload._modules) ? payload._modules : [];
  const root_objects = Array.isArray(payload._objects) ? payload._objects : [];
  const root_skills = Array.isArray(payload._skills) ? payload._skills : [];
  let module_object_count = 0;

  for (const module_item of modules) {
    if (is_plain_object(module_item) && Array.isArray(module_item._objects)) {
      module_object_count += module_item._objects.length;
    }
  }

  const serialized = json ?? safe_json_stringify(skills);
  return {
    _payload_bytes: serialized ? Buffer.byteLength(serialized, "utf8") : 0,
    _root_object_count: root_objects.length,
    _module_object_count: module_object_count,
    _object_count: root_objects.length + module_object_count,
    _module_count: modules.length,
    _root_skill_count: root_skills.length,
  };
}

function runtime_skill_limit_details(
  metrics: RuntimeSkillPayloadMetrics & { _record_count?: number },
  limit_name: string,
  configured_limit: number,
  extra: Record<string, unknown> = {},
) {
  return {
    ...metrics,
    _limit: limit_name,
    _configured_limit: configured_limit,
    ...extra,
  };
}

function read_bounded_runtime_skill_string(
  value: unknown,
  field_name: string,
  max_length: number,
): string {
  if (typeof value !== "string") {
    throw create_error_result(
      "E_STUDIO_INVALID_RUNTIME_SKILL_SYNC",
      `Invalid '${field_name}': expected bounded string`,
    );
  }
  const out = value.trim();
  if (!out || out.length > max_length) {
    throw create_error_result(
      "E_STUDIO_INVALID_RUNTIME_SKILL_SYNC",
      `Invalid '${field_name}': expected bounded string`,
    );
  }
  return out;
}

function validate_runtime_skill_json_value(
  value: unknown,
  state: {
    _depth: number;
    _records: number;
    _metrics: RuntimeSkillPayloadMetrics;
  },
): { _records: number } {
  if (state._depth > RUNTIME_SKILL_MAX_DEPTH) {
    throw create_error_result(
      "E_STUDIO_INVALID_RUNTIME_SKILL_SYNC",
      "Runtime skill payload is too deep",
      runtime_skill_limit_details(
        state._metrics,
        "max_depth",
        RUNTIME_SKILL_MAX_DEPTH,
        { _depth: state._depth },
      ),
    );
  }

  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw create_error_result(
        "E_STUDIO_INVALID_RUNTIME_SKILL_SYNC",
        "Runtime skill payload contains invalid numeric value",
        runtime_skill_limit_details(state._metrics, "json_value", 0),
      );
    }
    return { _records: state._records };
  }

  if (typeof value === "string") {
    if (value.length > RUNTIME_SKILL_MAX_STRING_LENGTH) {
      throw create_error_result(
        "E_STUDIO_INVALID_RUNTIME_SKILL_SYNC",
        "Runtime skill payload string is too large",
        runtime_skill_limit_details(
          state._metrics,
          "max_string_length",
          RUNTIME_SKILL_MAX_STRING_LENGTH,
          { _string_length: value.length },
        ),
      );
    }
    return { _records: state._records };
  }

  if (Array.isArray(value)) {
    if (value.length > RUNTIME_SKILL_MAX_ARRAY_LENGTH) {
      throw create_error_result(
        "E_STUDIO_INVALID_RUNTIME_SKILL_SYNC",
        "Runtime skill payload array is too large",
        runtime_skill_limit_details(
          state._metrics,
          "max_array_length",
          RUNTIME_SKILL_MAX_ARRAY_LENGTH,
          { _array_length: value.length },
        ),
      );
    }
    let records = state._records;
    for (const item of value) {
      records = validate_runtime_skill_json_value(item, {
        _depth: state._depth + 1,
        _records: records,
        _metrics: state._metrics,
      })._records;
    }
    return { _records: records };
  }

  if (!is_plain_object(value)) {
    throw create_error_result(
      "E_STUDIO_INVALID_RUNTIME_SKILL_SYNC",
      "Runtime skill payload must be JSON-compatible metadata",
      runtime_skill_limit_details(state._metrics, "json_value", 0),
    );
  }

  let records = state._records + 1;
  for (const [key, nested] of Object.entries(value)) {
    if (RUNTIME_SKILL_BLOCKED_KEYS.has(key.toLowerCase())) {
      throw create_error_result(
        "E_STUDIO_INVALID_RUNTIME_SKILL_SYNC",
        "Runtime skill payload contains disallowed auth field",
        runtime_skill_limit_details(
          state._metrics,
          "blocked_key",
          0,
          { _field: key },
        ),
      );
    }
    records = validate_runtime_skill_json_value(nested, {
      _depth: state._depth + 1,
      _records: records,
      _metrics: state._metrics,
    })._records;
    if (records > RUNTIME_SKILL_MAX_TOTAL_RECORDS) break;
  }
  return { _records: records };
}

function validate_runtime_skill_sync_params(params: Record<string, unknown>) {
  const app_id = read_bounded_runtime_skill_string(
    params._app_id,
    "_app_id",
    RUNTIME_SKILL_MAX_APP_ID_LENGTH,
  );
  const env = read_bounded_runtime_skill_string(
    params._env,
    "_env",
    RUNTIME_SKILL_MAX_ENV_LENGTH,
  );
  if (params._mode !== "runtime") {
    throw create_error_result(
      "E_STUDIO_INVALID_RUNTIME_SKILL_SYNC",
      "Runtime skill sync requires _mode runtime",
    );
  }
  const skills = params._skills;
  if (!is_plain_object(skills)) {
    throw create_error_result(
      "E_STUDIO_INVALID_RUNTIME_SKILL_SYNC",
      "Runtime skill sync requires compact _skills object",
    );
  }
  const json = safe_json_stringify(skills);
  const metrics = runtime_skill_payload_metrics(skills, json);
  if (!json || metrics._payload_bytes > RUNTIME_SKILL_MAX_JSON_BYTES) {
    throw create_error_result(
      "E_STUDIO_INVALID_RUNTIME_SKILL_SYNC",
      "Runtime skill payload is too large",
      runtime_skill_limit_details(
        metrics,
        "max_json_bytes",
        RUNTIME_SKILL_MAX_JSON_BYTES,
      ),
    );
  }
  if (!Array.isArray(skills._modules) || !Array.isArray(skills._skills) || !Array.isArray(skills._objects)) {
    throw create_error_result(
      "E_STUDIO_INVALID_RUNTIME_SKILL_SYNC",
      "Runtime skill sync requires compact metadata arrays",
    );
  }
  if (skills._modules.length > RUNTIME_SKILL_MAX_MODULES) {
    throw create_error_result(
      "E_STUDIO_INVALID_RUNTIME_SKILL_SYNC",
      "Runtime skill payload is too large",
      runtime_skill_limit_details(metrics, "max_modules", RUNTIME_SKILL_MAX_MODULES),
    );
  }
  if (skills._skills.length > RUNTIME_SKILL_MAX_SKILLS) {
    throw create_error_result(
      "E_STUDIO_INVALID_RUNTIME_SKILL_SYNC",
      "Runtime skill payload is too large",
      runtime_skill_limit_details(metrics, "max_root_skills", RUNTIME_SKILL_MAX_SKILLS),
    );
  }
  if (skills._objects.length > RUNTIME_SKILL_MAX_OBJECTS) {
    throw create_error_result(
      "E_STUDIO_INVALID_RUNTIME_SKILL_SYNC",
      "Runtime skill payload is too large",
      runtime_skill_limit_details(metrics, "max_root_objects", RUNTIME_SKILL_MAX_OBJECTS),
    );
  }
  if (metrics._object_count > RUNTIME_SKILL_MAX_TOTAL_OBJECTS) {
    throw create_error_result(
      "E_STUDIO_INVALID_RUNTIME_SKILL_SYNC",
      "Runtime skill payload is too large",
      runtime_skill_limit_details(
        metrics,
        "max_total_objects",
        RUNTIME_SKILL_MAX_TOTAL_OBJECTS,
      ),
    );
  }
  const counts = validate_runtime_skill_json_value(skills, {
    _depth: 0,
    _records: 0,
    _metrics: metrics,
  });
  if (counts._records > RUNTIME_SKILL_MAX_TOTAL_RECORDS) {
    throw create_error_result(
      "E_STUDIO_INVALID_RUNTIME_SKILL_SYNC",
      "Runtime skill payload is too large",
      runtime_skill_limit_details(
        { ...metrics, _record_count: counts._records },
        "max_total_records",
        RUNTIME_SKILL_MAX_TOTAL_RECORDS,
      ),
    );
  }
  return {
    _app_id: app_id,
    _env: env,
    _mode: "runtime",
    _skills: skills,
  };
}

function is_failed_generation_result(_value: unknown): boolean {
  return is_plain_object(_value) && _value._ok === false;
}

function read_required_string(
  _value: unknown,
  _field_name: string,
): string {
  if (typeof _value !== "string") {
    throw new Error(`Invalid '${_field_name}': expected non-empty string`);
  }

  const _trimmed = _value.trim();
  if (_trimmed.length === 0) {
    throw new Error(`Invalid '${_field_name}': expected non-empty string`);
  }

  return _trimmed;
}

function read_optional_string(
  _value: unknown,
  _field_name: string,
): string | undefined {
  if (_value === undefined || _value === null) {
    return undefined;
  }

  if (typeof _value !== "string") {
    throw new Error(`Invalid '${_field_name}': expected string`);
  }

  const _trimmed = _value.trim();
  return _trimmed.length > 0 ? _trimmed : undefined;
}

function read_safe_segment(
  _value: unknown,
  _field_name: string,
  _code: string,
): string {
  const _segment = read_required_string(_value, _field_name);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/u.test(_segment)) {
    throw create_error_result(
      _code,
      `Invalid '${_field_name}': expected safe path segment`,
    );
  }

  return _segment;
}

function clone_view(_view: XStudioViewData): XStudioViewData {
  return JSON.parse(JSON.stringify(_view)) as XStudioViewData;
}

function create_error_result(
  _code: string,
  _message: string,
  _details?: Record<string, unknown>,
): XStudioErrorResult {
  return {
    _ok: false,
    _error: {
      _code,
      _message,
      ...(_details ? { _details } : {}),
    },
  };
}

function is_error_result(_value: unknown): _value is XStudioErrorResult {
  return (
    is_plain_object(_value) &&
    _value._ok === false &&
    is_plain_object(_value._error) &&
    typeof _value._error._code === "string" &&
    typeof _value._error._message === "string"
  );
}

function extract_command_error_result(_value: unknown): XStudioErrorResult | null {
  if (is_error_result(_value)) {
    return _value;
  }

  if (!is_plain_object(_value) || _value._ok !== false) {
    return null;
  }

  if (is_plain_object(_value._result)) {
    const _code =
      typeof _value._result._code === "string"
        ? _value._result._code
        : "E_STUDIO_COMMAND_FAILED";
    const _message =
      typeof _value._result._message === "string"
        ? _value._result._message
        : "Command failed";
    const _details = is_plain_object(_value._result._details)
      ? _value._result._details
      : undefined;

    return create_error_result(_code, _message, _details);
  }

  return create_error_result(
    "E_STUDIO_COMMAND_FAILED",
    "Command failed",
  );
}

function log_generation_id_forwarded(
  _route: string,
  _generation_id?: string,
): void {
  if (!_generation_id) return;

  _xlog.log("[xstudio] generation_id forwarded", {
    _route,
    _generation_id,
  });
}

function is_server_xvm_get_view_result(
  _value: unknown,
): _value is ServerXvmGetViewResult {
  return (
    is_plain_object(_value) &&
    typeof _value._app_id === "string" &&
    typeof _value._env === "string" &&
    typeof _value._version === "number" &&
    is_plain_object(_value._view)
  );
}

function is_server_xvm_push_update_result(
  _value: unknown,
): _value is ServerXvmPushUpdateResult {
  return (
    is_plain_object(_value) &&
    _value._ok === true &&
    typeof _value._app_id === "string" &&
    typeof _value._env === "string" &&
    typeof _value._view_id === "string" &&
    typeof _value._version === "number" &&
    Array.isArray(_value._notified_subscribers)
  );
}

function stringify_inspector_value(_value: unknown): string {
  if (_value === undefined || _value === null) return "";
  if (typeof _value === "string") return _value;

  try {
    return JSON.stringify(_value, null, 2);
  } catch {
    return String(_value);
  }
}

function read_summary_string(
  _summary: Record<string, unknown>,
  _field_name: string,
): string {
  const _value = _summary[_field_name];
  return typeof _value === "string" && _value.trim().length > 0
    ? _value.trim()
    : "-";
}

function read_summary_bool(
  _summary: Record<string, unknown>,
  _field_name: string,
): string {
  return _summary[_field_name] === true ? "true" : "false";
}

function format_runtime_inspector_summary(
  _summary: Record<string, unknown>,
): string {
  const _deterministic_reason =
    read_summary_string(_summary, "_deterministic_reason");
  const _deterministic_action =
    read_summary_string(_summary, "_deterministic_action");

  return [
    `generation_id: ${read_summary_string(_summary, "_generation_id")}`,
    `artifact_type: ${read_summary_string(_summary, "_artifact_type")}`,
    `mode: ${read_summary_string(_summary, "_mode")}`,
    `status: ${read_summary_string(_summary, "_status")}`,
    `deterministic eligible: ${read_summary_bool(_summary, "_deterministic_eligible")}`,
    `deterministic reason/action: ${_deterministic_reason} / ${_deterministic_action}`,
    `error code: ${read_summary_string(_summary, "_error_code")}`,
    `final-prompt exists: ${read_summary_bool(_summary, "_has_final_prompt")}`,
  ].join("\n");
}

function build_runtime_inspector_payload(
  _run: Record<string, unknown>,
): Record<string, unknown> {
  const _files =
    is_plain_object(_run._files)
      ? _run._files
      : {};
  const _summary =
    is_plain_object(_run._summary)
      ? _run._summary
      : {};

  const _sections = [
    {
      _id: "resolved-task",
      _label: "Resolved Task",
      _file: "resolved-task.json",
      _content: _files["resolved-task.json"] ?? null,
      _preview: stringify_inspector_value(_files["resolved-task.json"]),
    },
    {
      _id: "deterministic",
      _label: "Deterministic",
      _file: "deterministic-mutation.json",
      _content: _files["deterministic-mutation.json"] ?? null,
      _preview: stringify_inspector_value(_files["deterministic-mutation.json"]),
    },
    {
      _id: "result",
      _label: "Result",
      _file: "result.json",
      _content: _files["result.json"] ?? null,
      _preview: stringify_inspector_value(_files["result.json"]),
    },
    {
      _id: "prompt",
      _label: "Prompt",
      _file: "final-prompt.txt",
      _content: _files["final-prompt.txt"] ?? _files["prompt.txt"] ?? null,
      _preview: stringify_inspector_value(
        _files["final-prompt.txt"] ?? _files["prompt.txt"],
      ),
    },
    {
      _id: "runtime-context",
      _label: "Runtime Context",
      _file: "runtime-context.json",
      _content: _files["runtime-context.json"] ?? null,
      _preview: stringify_inspector_value(_files["runtime-context.json"]),
    },
  ];

  return {
    _title: "Runtime Inspector",
    _button_label: "Inspect Last Run",
    _status:
      typeof _summary._status === "string"
        ? _summary._status
        : "completed",
    _summary,
    _summary_text: format_runtime_inspector_summary(_summary),
    _sections,
  };
}

export const XSTUDIO_OPS: Record<string, XpellSkillCommand> = {
  "generate-view": {
    _name: "generate-view",
    _scope: "module",
    _description:
      "Generate a preview view for an existing server-xvm view using a prompt.",
    _params: {
      _app_id: "Target XVM app id.",
      _env: "Optional environment. Defaults to default.",
      _view_id: "Target view id.",
      _prompt: "User prompt describing the requested view changes."
    }
  },

  "generate-artifact": {
    _name: "generate-artifact",
    _scope: "module",
    _description:
      "Generate a Studio artifact by routing view, entity, flow, module, or auto requests to the correct generation path.",
    _params: {
      _prompt: "User prompt describing the requested artifact.",
      _app_id: "Target XVM app id.",
      _env: "Optional environment. Defaults to default.",
      _artifact_type: "Artifact type: view, entity, flow, module, or auto.",
      _generation_id: "Optional client generation id forwarded to XVibe events."
    }
  },

  "apply-view": {
    _name: "apply-view",
    _scope: "module",
    _description:
      "Apply a validated preview view through server-xvm push-update.",
    _params: {
      _app_id: "Target XVM app id.",
      _env: "Optional environment. Defaults to default.",
      _view_id: "Target view id.",
      _view: "Data-only XUI view JSON to persist/apply."
    }
  },

  "sync-client-skills": {
    _name: "sync-client-skills",
    _scope: "module",
    _description:
      "Accept a build-mode client runtime skill snapshot and forward/store it through XVibe.",
    _params: {
      _app_id: "Target app id.",
      _env: "Optional environment.",
      _client_id: "Client/session id.",
      _mode: "Must be runtime.",
      _skills_hash: "Optional hash of the client skill snapshot.",
      _skills: "Client _x.getSkills() runtime skill snapshot."
    }
  },

  "get-skills": {
    _name: "get-skills",
    _scope: "module",
    _description:
      "Return the current server runtime skill snapshot for Studio diagnostics.",
    _params: {
      _include_objects: "Optional flag to include object skill chains.",
      _include_modules: "Optional flag to include module skills."
    }
  },

  "inspect-latest-run": {
    _name: "inspect-latest-run",
    _scope: "module",
    _description:
      "Fetch and format the latest XVibe run diagnostics for the current Studio app/env.",
    _params: {
      _app_id: "Target XVM app id.",
      _env: "Optional environment. Defaults to default.",
      _generation_id: "Optional generation id. Defaults to the latest vibe-run."
    }
  },

  "list-app-artifacts": {
    _name: "list-app-artifacts",
    _scope: "module",
    _description:
      "Return read-only XVM app artifact summaries for Studio App Explorer.",
    _params: {
      _app_id: "Target XVM app id.",
      _env: "Target environment."
    }
  },

  "create-module": {
    _name: "create-module",
    _scope: "module",
    _description:
      "Create a generated runtime module from a Studio prompt by asking XVibe for a manifest and module-creator to generate/load it.",
    _params: {
      _prompt: "User prompt describing the desired runtime module capability.",
      _module_id: "Optional requested module id.",
      _module_name: "Optional requested module name.",
      _load: "Optional. Load generated module after creation. Default true."
    }
  }
};

export const XSTUDIO_SKILL: XpellSkill = {
  _id: "studio",
  _title: "XStudio Server Module",
  _version: "1.0.0",
  _active: true,
  _type: "server-module-api",
  _requires: ["xmodule", "server-xvm", "xvibe", "module-creator"],
  _description:
    "Server-side Studio module for view generation, entity generation, flow generation, module generation, live view apply/publish orchestration, and build-mode skill synchronization.",

  _exports: {
    _modules: [
      {
        _name: "studio",
        _scope: "server",
        _ops: Object.values(XSTUDIO_OPS)
      }
    ]
  },

  _core_rules: [
    "Use studio only for build/edit/system contexts.",
    "Runtime users should not call studio ops directly.",
    "server-xvm remains the authoritative persistence and subscriber notification layer.",
    "XVibe owns skill registry, knowledge selection, prompt building, and LLM generation.",
    "Studio coordinates preview/apply workflows and may trigger client skill synchronization during build mode.",
    "Generated and persisted views must remain data-only JSON.",
    "Do not persist JavaScript functions in views.",
    "Use snake_case params."
  ]
};

export class XStudioModule extends XModule {
  static _name = "studio";
  static _skill = XSTUDIO_SKILL;
  static _ops = XSTUDIO_OPS;

  private readonly _service: XStudioService;

  constructor() {
    super({ _name: XStudioModule._name });
    this._service = new XStudioService();
  }

  async _sync_client_skills(xcmd: XCommand) {
    const raw_params = is_plain_object(xcmd?._params) ? xcmd._params : {};
    let params: ReturnType<typeof validate_runtime_skill_sync_params>;
    try {
      params = validate_runtime_skill_sync_params(raw_params);
    } catch (error) {
      const validation_error = is_error_result(error)
        ? error._error
        : {
          _code: "E_STUDIO_INVALID_RUNTIME_SKILL_SYNC",
          _message: bounded_error_message(error),
        };
      _xlog.warn("[studio] sync-client-skills rejected", {
        _app_id: raw_params._app_id,
        _env: raw_params._env,
        _mode: raw_params._mode,
        _error: validation_error,
      });
      return {
        _ok: false,
        _result: {
          _synced: false,
          _forwarded_to_xvibe: false,
          _mode: raw_params._mode,
          _app_id: raw_params._app_id,
          _env: raw_params._env,
          _skills_count: 0,
          _object_count: 0,
          _error: validation_error,
        }
      };
    }

    const skills_count = Array.isArray((params._skills as any)?._modules)
      ? (params._skills as any)._modules.length
      : 0;
    const object_count = runtime_skill_object_count(params._skills);

    _xlog.log("[studio] sync-client-skills received", {
      _app_id: params._app_id,
      _env: params._env,
      _mode: params._mode,
      _skills_count: skills_count,
      _object_count: object_count
    });

    let xvibe_result: unknown;
    try {
      xvibe_result = await _x.execute({
        _module: "xvibe",
        _op: "sync-skills",
        _params: params
      } as any);
    } catch (error) {
      const failure = bounded_xvibe_failure(error);
      _xlog.error("[studio] sync-client-skills failed", {
        _app_id: params._app_id,
        _env: params._env,
        _mode: params._mode,
        _skills_count: skills_count,
        _object_count: object_count,
        _error: failure
      });
      return {
        _ok: false,
        _result: {
          _synced: false,
          _forwarded_to_xvibe: true,
          _mode: params._mode,
          _app_id: params._app_id,
          _env: params._env,
          _skills_count: skills_count,
          _object_count: object_count,
          _error: {
            _code: "E_STUDIO_SYNC_CLIENT_SKILLS_FAILED",
            _message: "Runtime skill storage failed.",
            _xvibe: failure
          }
        }
      };
    }

    const xvibe_synced =
      is_plain_object(xvibe_result) &&
      xvibe_result._ok === true &&
      is_plain_object(xvibe_result._result) &&
      xvibe_result._result._synced === true;

    if (!xvibe_synced) {
      const failure = bounded_xvibe_failure(xvibe_result);
      _xlog.error("[studio] sync-client-skills failed", {
        _app_id: params._app_id,
        _env: params._env,
        _mode: params._mode,
        _skills_count: skills_count,
        _object_count: object_count,
        _error: failure
      });
      return {
        _ok: false,
        _result: {
          _synced: false,
          _forwarded_to_xvibe: true,
          _mode: params._mode,
          _app_id: params._app_id,
          _env: params._env,
          _skills_count: skills_count,
          _object_count: object_count,
          _error: {
            _code: "E_STUDIO_SYNC_CLIENT_SKILLS_FAILED",
            _message: "Runtime skill storage failed.",
            _xvibe: failure
          }
        }
      };
    }

    _xlog.log("[studio] sync-client-skills confirmed", {
      _app_id: params._app_id,
      _env: params._env,
      _mode: params._mode,
      _skills_count: skills_count,
      _object_count: object_count
    });

    return {
      _ok: true,
      _result: {
        _synced: true,
        _forwarded_to_xvibe: true,
        _xvibe_result: xvibe_result,
        _mode: params._mode,
        _app_id: params._app_id,
        _env: params._env,
        _skills_count: skills_count,
        _object_count: object_count
      }
    };
  }
  
  async onLoad() {
    
  }

  async _op_create_module(xcmd: XCommand) {
    const params = is_plain_object(xcmd?._params) ? xcmd._params : {};
    const prompt = read_required_string(params._prompt, "_prompt");

    const spec_result: any = await _x.execute({
      _module: "xvibe",
      _op: "generate-module-spec",
      _params: {
        _prompt: prompt,
        _module_id: params._module_id,
        _module_name: params._module_name,
        _target: "server"
      }
    } as any);

    if (!spec_result?._ok || !is_plain_object(spec_result._spec)) {
      return create_error_result(
        "E_STUDIO_MODULE_SPEC_FAILED",
        "XVibe failed to generate module spec",
        { _result: spec_result }
      );
    }

    const create_result: any = await _x.execute({
      _module: "module-creator",
      _op: "create-module-spec",
      _params: {
        _spec: spec_result._spec
      }
    } as any);

    if (!create_result?._ok) {
      return create_error_result(
        "E_STUDIO_MODULE_CREATE_FAILED",
        "module-creator failed to create module artifact",
        { _result: create_result }
      );
    }

    if (params._load === false) {
      return {
        _ok: true,
        _loaded: false,
        _spec: spec_result._spec,
        _create_result: create_result
      };
    }

    const load_result: any = await _x.execute({
      _module: "module-creator",
      _op: "load-generated-module",
      _params: {
        _id: spec_result._spec._id
      }
    } as any);

    if (!load_result?._ok) {
      return create_error_result(
        "E_STUDIO_MODULE_LOAD_FAILED",
        "module-creator failed to load generated module",
        { _result: load_result }
      );
    }

    return {
      _ok: true,
      _loaded: true,
      _spec: spec_result._spec,
      _create_result: create_result,
      _load_result: load_result,
      _skills: typeof _x.getSkills === "function" ? _x.getSkills() : undefined
    };
  }

  async _generate_view(xcmd: XCommand) {
    return this._op_generate_view(xcmd);
  }

  async _generate_artifact(xcmd: XCommand) {
    return this._op_generate_artifact(xcmd);
  }

  async _op_generate_view(xcmd: XCommand): Promise<XStudioGenerateViewResult> {
    try {
      const _params = this.parse_generate_view_params(xcmd?._params);
      const _view_result = await _x.execute({
        _module: "server-xvm",
        _op: "get_view",
        _params: {
          _app_id: _params._app_id,
          _env: _params._env,
          _view_id: _params._view_id,
        },
      } as any);

      const _command_error = extract_command_error_result(_view_result);
      if (_command_error) {
        return _command_error;
      }

      if (!is_server_xvm_get_view_result(_view_result)) {
        return create_error_result(
          "E_STUDIO_INVALID_GET_VIEW_RESPONSE",
          "server-xvm returned an invalid get_view result",
          {
            _app_id: _params._app_id,
            _env: _params._env,
            _view_id: _params._view_id,
          },
        );
      }

      return this._service.generate_view_preview({
        _app_id: _view_result._app_id,
        _env: _view_result._env,
        _view_id: _params._view_id,
        _prompt: _params._prompt,
        _version: _view_result._version,
        _current_view: clone_view(_view_result._view),
      });
    } catch (_error) {
      _xlog.error("[studio] generate_view failed", _error);
      return this.normalize_error(
        _error,
        "E_STUDIO_GENERATE_VIEW",
        "Failed to generate a preview view",
      );
    }
  }

  async _op_generate_artifact(xcmd: XCommand) {
    try {
      const _params = this.parse_generate_artifact_params(xcmd?._params);

      _xlog.log("[xstudio] generate-artifact HIT", {
        _app_id: _params._app_id,
        _env: _params._env,
        _artifact_type: _params._artifact_type,
        _prompt: _params._prompt,
        ...(_params._generation_id ? { _generation_id: _params._generation_id } : {}),
      });

      _xlog.log("[xstudio] artifact generation requested", {
        _prompt: _params._prompt,
        _artifact_type: _params._artifact_type,
        _app_id: _params._app_id,
        _env: _params._env,
        ...(_params._generation_id ? { _generation_id: _params._generation_id } : {}),
      });

      if (_params._artifact_type === "view") {
        const _view_params = this.parse_generate_view_params(xcmd?._params);

        _xlog.log("[xstudio] artifact generation routed", {
          _route: "view->generate_view_preview",
        });
        log_generation_id_forwarded(
          "view->generate_view_preview",
          _view_params._generation_id,
        );

        const _result = await this._op_generate_view({
          _params: _view_params,
        } as unknown as XCommand);
        if (is_failed_generation_result(_result)) {
          _xlog.warn("[xstudio] artifact generation failed", {
            _artifact_type: "view",
          });
          return _result;
        }
        _xlog.log("[xstudio] artifact generation completed", {
          _artifact_type: "view",
        });
        return _result;
      }

      if (_params._artifact_type === "module") {
        _xlog.log("[xstudio] artifact generation routed", {
          _route: "module->xvibe.generate-module-spec",
        });
        log_generation_id_forwarded(
          "module->xvibe.generate-module-spec",
          _params._generation_id,
        );

        const _result = await _x.execute({
          _module: "xvibe",
          _op: "generate-module-spec",
          _params: {
            _prompt: _params._prompt,
            _app_id: _params._app_id,
            _env: _params._env,
            ...(_params._generation_id ? { _generation_id: _params._generation_id } : {}),
          },
        } as any);
        if (is_failed_generation_result(_result)) {
          _xlog.warn("[xstudio] artifact generation failed", {
            _artifact_type: "module",
          });
          return _result;
        }
        _xlog.log("[xstudio] artifact generation completed", {
          _artifact_type: "module",
        });
        return _result;
      }

      const _route_params = {
        _prompt: _params._prompt,
        _app_id: _params._app_id,
        _env: _params._env,
        ...(_params._generation_id ? { _generation_id: _params._generation_id } : {}),
        ...(_params._artifact_type === "auto"
          ? {}
          : { _artifact_type: _params._artifact_type }),
      };

      _xlog.log("[xstudio] artifact generation routed", {
        _route: `${_params._artifact_type}->xvibe.generate`,
      });
      log_generation_id_forwarded(
        `${_params._artifact_type}->xvibe.generate`,
        _params._generation_id,
      );

      const _result = await _x.execute({
        _module: "xvibe",
        _op: "generate",
        _params: _route_params,
      } as any);
      if (is_failed_generation_result(_result)) {
        _xlog.warn("[xstudio] artifact generation failed", {
          _artifact_type: _params._artifact_type,
        });
        return _result;
      }
      _xlog.log("[xstudio] artifact generation completed", {
        _artifact_type: _params._artifact_type,
      });
      return _result;
    } catch (_error) {
      _xlog.error("[studio] generate_artifact failed", _error);
      return this.normalize_error(
        _error,
        "E_STUDIO_GENERATE_ARTIFACT",
        "Failed to generate an artifact",
      );
    }
  }

  async _op_apply_view(xcmd: XCommand): Promise<XStudioApplyViewResult> {
    try {
      const _params = this.parse_apply_view_params(xcmd?._params);
      const _normalized_view = this.normalize_view_for_apply(
        _params._view_id,
        _params._view,
      );

      const _apply_result = await _x.execute({
        _module: "server-xvm",
        _op: "push_update",
        _params: {
          _app_id: _params._app_id,
          _env: _params._env,
          _view_id: _params._view_id,
          _source: "studio:apply_view",
          _view: _normalized_view,
        },
      } as any);

      const _command_error = extract_command_error_result(_apply_result);
      if (_command_error) {
        return _command_error;
      }

      if (!is_server_xvm_push_update_result(_apply_result)) {
        return create_error_result(
          "E_STUDIO_INVALID_APPLY_RESPONSE",
          "server-xvm returned an invalid push_update result",
          {
            _app_id: _params._app_id,
            _env: _params._env,
            _view_id: _params._view_id,
          },
        );
      }

      return {
        _ok: true,
        _app_id: _apply_result._app_id,
        _env: _apply_result._env,
        _view_id: _apply_result._view_id,
        _version: _apply_result._version,
        _notified_subscribers: _apply_result._notified_subscribers,
      };
    } catch (_error) {
      _xlog.error("[studio] apply_view failed", _error);
      return this.normalize_error(
        _error,
        "E_STUDIO_APPLY_VIEW",
        "Failed to apply the view",
      );
    }
  }

  async _inspect_latest_run(xcmd: XCommand) {
    return this._op_inspect_latest_run(xcmd);
  }

  async _list_app_artifacts(xcmd: XCommand) {
    return this._op_list_app_artifacts(xcmd);
  }

  async _op_list_app_artifacts(xcmd: XCommand) {
    try {
      const _params = this.parse_list_app_artifacts_params(xcmd?._params);

      _xlog.log("[xstudio] list app artifacts", {
        _app_id: _params._app_id,
        _env: _params._env,
      });

      const [_views, _flows, _entities, _modules] = await Promise.all([
        this.read_server_xvm_artifact_list(
          "list_views",
          "_views",
          _params,
        ),
        this.read_server_xvm_artifact_list(
          "list_flows",
          "_flows",
          _params,
        ),
        this.read_server_xvm_artifact_list(
          "list_entities",
          "_entities",
          _params,
        ),
        this.read_server_xvm_artifact_list(
          "list_generated_modules",
          "_modules",
          _params,
        ),
      ]);

      return {
        _ok: true,
        _app_id: _params._app_id,
        _env: _params._env,
        _artifacts: {
          _views: this.normalize_artifact_summaries(_views, "views"),
          _flows: this.normalize_artifact_summaries(_flows, "flows"),
          _entities: this.normalize_artifact_summaries(_entities, "entities"),
          _modules: this.normalize_artifact_summaries(_modules, "modules"),
        },
      };
    } catch (_error) {
      _xlog.error("[xstudio] list app artifacts failed", _error);
      return this.normalize_error(
        _error,
        "E_STUDIO_LIST_APP_ARTIFACTS",
        "Failed to list app artifacts",
      );
    }
  }

  async _op_inspect_latest_run(xcmd: XCommand) {
    try {
      const _params = this.parse_inspect_latest_run_params(xcmd?._params);
      const _run_result: unknown = await _x.execute({
        _module: "xvibe",
        _op: "get-latest-run",
        _params,
      } as any);

      const _command_error = extract_command_error_result(_run_result);
      if (_command_error) {
        return _command_error;
      }

      if (!is_plain_object(_run_result) || _run_result._ok !== true) {
        return create_error_result(
          "E_STUDIO_INVALID_INSPECT_RESPONSE",
          "XVibe returned an invalid run inspector response",
          {
            _app_id: _params._app_id,
            _env: _params._env,
          },
        );
      }

      return {
        ..._run_result,
        _inspector: build_runtime_inspector_payload(_run_result),
      };
    } catch (_error) {
      _xlog.error("[studio] inspect_latest_run failed", _error);
      return this.normalize_error(
        _error,
        "E_STUDIO_INSPECT_LATEST_RUN",
        "Failed to inspect the latest XVibe run",
      );
    }
  }

  private parse_list_app_artifacts_params(
    _params: unknown,
  ): { _app_id: string; _env: string } {
    if (!is_plain_object(_params)) {
      throw new Error("Invalid '_params': expected object");
    }

    return {
      _app_id: read_safe_segment(
        _params._app_id,
        "_app_id",
        "E_STUDIO_INVALID_APP_ID",
      ),
      _env: read_safe_segment(
        _params._env,
        "_env",
        "E_STUDIO_INVALID_ENV",
      ),
    };
  }

  private async read_server_xvm_artifact_list(
    _op: string,
    _result_key: "_views" | "_flows" | "_entities" | "_modules",
    _params: { _app_id: string; _env: string },
  ): Promise<unknown[]> {
    const _response = await _x.execute({
      _module: "server-xvm",
      _op,
      _params,
    } as any);

    const _command_error = extract_command_error_result(_response);
    if (_command_error) {
      throw _command_error;
    }

    if (
      !is_plain_object(_response) ||
      _response._ok !== true ||
      !is_plain_object(_response._result) ||
      !Array.isArray(_response._result[_result_key])
    ) {
      throw create_error_result(
        "E_STUDIO_INVALID_ARTIFACT_LIST_RESPONSE",
        "server-xvm returned an invalid artifact list response",
        {
          _op,
          _result_key,
          _app_id: _params._app_id,
          _env: _params._env,
        },
      );
    }

    return _response._result[_result_key] as unknown[];
  }

  private normalize_artifact_summaries(
    _items: unknown[],
    _kind: "views" | "flows" | "entities" | "modules",
  ): XStudioArtifactSummary[] {
    return _items
      .map((_item): XStudioArtifactSummary | undefined => {
        if (typeof _item === "string") {
          return {
            _id: _item,
            _path: `${_kind}/${_item}.json`,
          };
        }

        if (!is_plain_object(_item)) {
          return undefined;
        }

        const _id_value =
          typeof _item._id === "string" && _item._id.trim().length > 0
            ? _item._id.trim()
            : typeof _item._name === "string" && _item._name.trim().length > 0
              ? _item._name.trim()
              : undefined;

        if (!_id_value) {
          return undefined;
        }

        const _title =
          typeof _item._title === "string" && _item._title.trim().length > 0
            ? _item._title.trim()
            : typeof _item._name === "string" && _item._name.trim().length > 0
              ? _item._name.trim()
              : undefined;
        const _path =
          typeof _item._path === "string" && _item._path.trim().length > 0
            ? _item._path.trim()
            : typeof _item._artifact_path === "string" && _item._artifact_path.trim().length > 0
              ? _item._artifact_path.trim()
              : _kind === "modules"
                ? undefined
                : `${_kind}/${_id_value}.json`;

        return {
          _id: _id_value,
          ...(_title ? { _title } : {}),
          ...(_path ? { _path } : {}),
          ...(typeof _item._enabled === "boolean" ? { _enabled: _item._enabled } : {}),
        };
      })
      .filter((_item): _item is XStudioArtifactSummary => _item !== undefined);
  }

  private parse_generate_view_params(
    _params: unknown,
  ): XStudioGenerateViewParams & { _generation_id?: string } {
    if (!is_plain_object(_params)) {
      throw new Error("Invalid '_params': expected object");
    }

    const _generation_id =
      read_optional_string(_params._generation_id, "_generation_id");

    return {
      _app_id: read_required_string(_params._app_id, "_app_id"),
      _env:
        typeof _params._env === "string" && _params._env.trim().length > 0
          ? _params._env.trim()
          : DEFAULT_ENV,
      _view_id: read_required_string(_params._view_id, "_view_id"),
      _prompt: read_required_string(_params._prompt, "_prompt"),
      ...(_generation_id ? { _generation_id } : {}),
    };
  }

  private parse_generate_artifact_params(
    _params: unknown,
  ): XStudioGenerateArtifactParams & { _generation_id?: string } {
    if (!is_plain_object(_params)) {
      throw new Error("Invalid '_params': expected object");
    }

    let _resolved_artifact_type: string = "auto";
    if (_params._artifact_type !== undefined && _params._artifact_type !== null) {
      if (typeof _params._artifact_type !== "string") {
        throw new Error(
          "Invalid '_artifact_type': expected view, entity, flow, module, or auto",
        );
      }

      const _artifact_type = _params._artifact_type.trim();
      if (_artifact_type.length > 0) {
        _resolved_artifact_type = _artifact_type;
      }
    }

    if (
      !SUPPORTED_ARTIFACT_TYPES.has(
        _resolved_artifact_type as XStudioArtifactType,
      )
    ) {
      throw new Error(
        "Invalid '_artifact_type': expected view, entity, flow, module, or auto",
      );
    }

    const _generation_id =
      read_optional_string(_params._generation_id, "_generation_id");

    return {
      _prompt: read_required_string(_params._prompt, "_prompt"),
      _app_id: read_required_string(_params._app_id, "_app_id"),
      _env:
        typeof _params._env === "string" && _params._env.trim().length > 0
          ? _params._env.trim()
          : DEFAULT_ENV,
      _artifact_type: _resolved_artifact_type as XStudioArtifactType,
      ...(_generation_id ? { _generation_id } : {}),
    };
  }

  private parse_apply_view_params(_params: unknown): XStudioApplyViewParams {
    if (!is_plain_object(_params)) {
      throw new Error("Invalid '_params': expected object");
    }

    if (!is_plain_object(_params._view)) {
      throw new Error("Invalid '_view': expected object");
    }

    return {
      _app_id: read_required_string(_params._app_id, "_app_id"),
      _env:
        typeof _params._env === "string" && _params._env.trim().length > 0
          ? _params._env.trim()
          : DEFAULT_ENV,
      _view_id: read_required_string(_params._view_id, "_view_id"),
      _view: clone_view(_params._view),
    };
  }

  private parse_inspect_latest_run_params(
    _params: unknown,
  ): { _app_id: string; _env: string; _generation_id?: string } {
    if (!is_plain_object(_params)) {
      throw new Error("Invalid '_params': expected object");
    }

    const _generation_id =
      read_optional_string(_params._generation_id, "_generation_id");

    return {
      _app_id: read_required_string(_params._app_id, "_app_id"),
      _env:
        typeof _params._env === "string" && _params._env.trim().length > 0
          ? _params._env.trim()
          : DEFAULT_ENV,
      ...(_generation_id ? { _generation_id } : {}),
    };
  }

  private normalize_view_for_apply(
    _view_id: string,
    _view: XStudioViewData,
  ): Record<string, unknown> {
    const _normalized_view = clone_view(_view);
    const _existing_view_id =
      typeof _normalized_view._id === "string"
        ? _normalized_view._id.trim()
        : undefined;

    if (_existing_view_id && _existing_view_id !== _view_id) {
      throw new Error(
        `Invalid '_view._id': expected '${_view_id}' but received '${_existing_view_id}'`,
      );
    }

    return {
      ..._normalized_view,
      _id: _view_id,
    };
  }

  private normalize_error(
    _error: unknown,
    _fallback_code: string,
    _fallback_message: string,
  ): XStudioErrorResult {
    if (is_error_result(_error)) {
      return _error;
    }

    if (
      is_plain_object(_error) &&
      typeof _error._code === "string" &&
      typeof _error._message === "string"
    ) {
      return create_error_result(
        _error._code,
        _error._message,
        is_plain_object(_error._details) ? _error._details : undefined,
      );
    }

    const _message =
      _error instanceof Error && _error.message.trim().length > 0
        ? _error.message
        : _fallback_message;

    return create_error_result(_fallback_code, _message);
  }
}
