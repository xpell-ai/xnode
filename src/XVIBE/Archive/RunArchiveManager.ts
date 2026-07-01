import fs from "node:fs";
import path from "node:path";
import { _x, _xlog } from "@xpell/core";
import { _xu } from "../../XNUtils/XUtils.js";
import type { VibeKnowledgeSelection } from "../VibeKnowledgeSelector.js";
import type { XVibeJsonObject } from "../VibeOutputParser.js";
import type { XVibeRuntimePlan } from "../XVibeTypes.js";

const DEFAULT_ENV = "default";
const XVIBE_INVALID_APP_ID = "E_XVIBE_INVALID_APP_ID";
const XVIBE_RUN_NOT_FOUND = "E_XVIBE_RUN_NOT_FOUND";
const XVIBE_INVALID_GENERATION_ID = "E_XVIBE_INVALID_GENERATION_ID";

const VIBE_RUN_DIAGNOSTIC_FILE_TYPES = {
  "request.json": "json",
  "resolved-task.json": "json",
  "runtime-plan.json": "json",
  "validation-plan.json": "json",
  "artifact-plan.json": "json",
  "module-plan.json": "json",
  "intent-plan.json": "json",
  "selected-skills.json": "json",
  "runtime-context.json": "json",
  "ai-output.json": "json",
  "validation.json": "json",
  "deterministic-mutation.json": "json",
  "timeline.json": "json",
  "result.json": "json",
  "summary.json": "json",
  "prompt.txt": "text",
  "final-prompt.txt": "text",
} as const;

export type XVibeRunArchiveTimelineItem = {
  _stage: string;
  _message?: string;
  _t_ms: number;
  _at: string;
  _details?: Record<string, unknown>;
};

export type XVibeRunArchiveData = XVibeJsonObject & {
  _generation_id?: string;
  _app_id?: string;
  _env?: string;
  _view_id?: string;
  _requested_view_id?: string;
  _source_view_id?: string;
  _artifact_type?: string;
  _mode?: string;
  _created_at?: string;
  _user_prompt?: string;
  _final_prompt?: string;
  _resolved_task?: unknown;
  _runtime_plan?: XVibeRuntimePlan;
  _validation_plan?: unknown;
  _artifact_plan?: unknown;
  _module_plan?: unknown;
  _intent_plan?: unknown;
  _behavior_intent?: unknown;
  _scope_lock_warnings?: string[];
  _selected_skill_ids?: string[];
  _selected_skills?: unknown;
  _runtime_context?: unknown;
  _ai_output?: unknown;
  _validation?: unknown;
  _deterministic_mutation?: unknown;
  _timeline?: XVibeRunArchiveTimelineItem[];
  _result?: XVibeJsonObject;
  _duration_ms?: number;
};

export type XVibeRunDiagnosticSummary = {
  _generation_id?: string;
  _artifact_type?: string;
  _mode?: string;
  _status: "deterministic" | "fallback" | "failed" | "completed";
  _deterministic_eligible: boolean;
  _deterministic_reason?: string;
  _deterministic_action?: string;
  _error_code?: string;
  _has_final_prompt: boolean;
};

class RunArchiveManagerError extends Error {
  readonly _payload: XVibeJsonObject;

  constructor(payload: XVibeJsonObject) {
    const message =
      _xu.is_plain_object(payload._error) && typeof payload._error._message === "string"
        ? payload._error._message
        : "XVibe run archive error";

    super(message);
    this._payload = payload;
  }
}

function explicit_error(code: string, message: string, details?: XVibeJsonObject) {
  return {
    _ok: false,
    _error: {
      _code: code,
      _message: message,
      ...(details ? { _details: details } : {}),
    },
  };
}

function throw_explicit_error(code: string, message: string, details?: XVibeJsonObject): never {
  throw new RunArchiveManagerError(explicit_error(code, message, details));
}

function error_summary(error: unknown): XVibeJsonObject | string {
  if (error instanceof Error) {
    return {
      _name: error.name,
      _message: error.message,
    };
  }

  return String(error);
}

function assert_path_inside(root: string, candidate: string, code: string, message: string): void {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw_explicit_error(code, message);
  }
}

function generation_result_is_ok(result: unknown): boolean {
  return !_xu.is_plain_object(result) || result._ok !== false;
}

function compact_view_summary(view: unknown): XVibeJsonObject | undefined {
  if (!_xu.is_plain_object(view)) return undefined;

  return {
    ...(typeof view._id === "string" ? { _id: view._id } : {}),
    ...(typeof view._type === "string" ? { _type: view._type } : {}),
    ...(typeof view._title === "string" ? { _title: view._title } : {}),
    ...(typeof view._label === "string" ? { _label: view._label } : {}),
    _children_count:
      Array.isArray(view._children)
        ? view._children.length
        : 0,
  };
}

function diagnostic_file_object(
  files: Record<string, unknown>,
  file_name: string,
): XVibeJsonObject | undefined {
  const value = files[file_name];
  return _xu.is_plain_object(value) ? value : undefined;
}

function first_string_value(
  ...values: unknown[]
): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }

  return undefined;
}

function diagnostic_error_code(value: unknown): string | undefined {
  if (!_xu.is_plain_object(value)) return undefined;

  const direct =
    first_string_value(value._code, value.code);
  if (direct) return direct;

  return (
    diagnostic_error_code(value._error) ??
    diagnostic_error_code(value._result) ??
    diagnostic_error_code(value._details)
  );
}

export class RunArchiveManager {
  static errorPayload(error: unknown): XVibeJsonObject | undefined {
    return error instanceof RunArchiveManagerError
      ? error._payload
      : undefined;
  }

  static safeShortId(): string {
    return Math.random().toString(36).slice(2, 10);
  }

  static safeArchiveSegment(value: unknown, fallback: string): string {
    const raw =
      typeof value === "string" && value.trim().length > 0
        ? value.trim()
        : fallback;
    const safe =
      raw.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);

    return safe.length > 0 ? safe : fallback;
  }

  static recordStage(
    archive: XVibeRunArchiveData | undefined,
    started_at: number | undefined,
    stage: string,
    message?: string,
    details?: Record<string, unknown>,
  ): void {
    try {
      if (!archive || typeof started_at !== "number") return;

      archive._timeline =
        archive._timeline ?? [];
      archive._timeline.push({
        _stage: stage,
        ...(message ? { _message: message } : {}),
        _t_ms: Date.now() - started_at,
        _at: new Date().toISOString(),
        ...(details && Object.keys(details).length > 0
          ? { _details: details }
          : {}),
      });
    } catch (error) {
      _xlog.warn("[xvibe] run archive failed", {
        _error: error_summary(error),
      });
    }
  }

  static runtimeContextArchivePayload(
    runtime_context: unknown,
  ): unknown {
    if (!_xu.is_plain_object(runtime_context)) {
      return runtime_context;
    }

    const current_view =
      runtime_context._current_view;

    return {
      ...runtime_context,
      ...(_xu.is_plain_object(current_view)
        ? {
          _current_view_id:
            typeof current_view._id === "string"
              ? current_view._id
              : runtime_context._view_id,
          _current_view_summary:
            compact_view_summary(current_view),
        }
        : {}),
    };
  }

  static selectedSkillsPayload(
    selection?: VibeKnowledgeSelection,
  ): XVibeJsonObject | undefined {
    if (!selection) return undefined;

    return {
      _selected_skill_ids: selection.skill_ids,
      _skills: selection.skills,
      _diagnostics: selection.diagnostics,
    };
  }

  static archiveResultFromResponse(
    artifact_type: string,
    response: unknown,
  ): XVibeJsonObject {
    const result =
      _xu.is_plain_object(response) && _xu.is_plain_object(response._result)
        ? response._result
        : {};

    return {
      _artifact_type:
        typeof result._artifact_type === "string"
          ? result._artifact_type
          : artifact_type,
      ...(typeof result._artifact_id === "string"
        ? { _artifact_id: result._artifact_id }
        : {}),
      ...(typeof result._view_id === "string"
        ? { _view_id: result._view_id }
        : {}),
      ...(typeof result._flow_id === "string"
        ? { _flow_id: result._flow_id }
        : {}),
      ...(typeof result._entity_id === "string"
        ? { _entity_id: result._entity_id }
        : {}),
      _success: generation_result_is_ok(response),
      ...(_xu.is_plain_object(response) && response._ok === false
        ? { _error: response._error ?? response._result ?? response }
        : {}),
    };
  }

  static failureResult(
    artifact_type: string,
    error: unknown,
    requested_view_id?: string,
    options?: {
      _diagnostic?: unknown;
      _diagnostics?: unknown;
      _structured_error_payload?: unknown;
    },
  ): XVibeJsonObject {
    return {
      _artifact_type: artifact_type,
      ...(requested_view_id ? { _view_id: requested_view_id } : {}),
      _success: false,
      _error: error_summary(error),
      ...(options?._diagnostic ? { _diagnostic: options._diagnostic } : {}),
      ...(options?._diagnostics ? { _diagnostics: options._diagnostics } : {}),
      ...(options?._structured_error_payload
        ? { _structured_error_payload: options._structured_error_payload }
        : {}),
    };
  }

  static structuredFailureResult(input: {
    artifact_type: string;
    result: XVibeJsonObject;
    requested_view_id?: string;
  }): XVibeJsonObject {
    return {
      _artifact_type: input.artifact_type,
      ...(input.requested_view_id ? { _view_id: input.requested_view_id } : {}),
      _success: false,
      _error:
        input.result._error ??
        input.result._result ??
        input.result,
    };
  }

  static archiveTimestamp(value?: string): string {
    const timestamp =
      value && value.trim()
        ? value
        : new Date().toISOString();

    return timestamp.replace(/[:.]/g, "-");
  }

  static writeArchiveFile(file_path: string, content: string): void {
    const temp_path = `${file_path}.${Date.now()}-${RunArchiveManager.safeShortId()}.tmp`;
    fs.writeFileSync(temp_path, content, "utf-8");
    fs.renameSync(temp_path, file_path);
  }

  static writeArchiveJson(file_path: string, value: unknown): void {
    RunArchiveManager.writeArchiveFile(file_path, `${JSON.stringify(value, null, 2)}\n`);
  }

  static hasArchiveValue(value: unknown): boolean {
    if (value === undefined || value === null) return false;
    if (typeof value === "string") return value.length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (_xu.is_plain_object(value)) return Object.keys(value).length > 0;
    return true;
  }

  static resolveXvibeWorkFolder(): string {
    const get_module =
      (_x as unknown as { getModule?: (name: string) => unknown }).getModule;

    if (typeof get_module === "function") {
      const server_xvm =
        get_module.call(_x, "server-xvm");

      if (
        _xu.is_plain_object(server_xvm) &&
        typeof server_xvm._work_folder === "string" &&
        server_xvm._work_folder.trim().length > 0
      ) {
        return server_xvm._work_folder;
      }
    }

    return "./work";
  }

  static archiveVibeRun(data: XVibeRunArchiveData): void {
    try {
      if (
        typeof data._app_id !== "string" ||
        data._app_id.trim().length === 0
      ) {
        return;
      }

      const created_at = data._created_at ?? new Date().toISOString();
      const generation_id =
        data._generation_id && data._generation_id.trim()
          ? data._generation_id.trim()
          : RunArchiveManager.safeShortId();
      const app_id = data._app_id.trim();
      const env =
        typeof data._env === "string" && data._env.trim()
          ? data._env.trim()
          : DEFAULT_ENV;
      const run_dir =
        path.join(
          RunArchiveManager.resolveXvibeWorkFolder(),
          "xvm",
          "apps",
          RunArchiveManager.safeArchiveSegment(env, DEFAULT_ENV),
          RunArchiveManager.safeArchiveSegment(app_id, "app"),
          "vibe-runs",
          `${RunArchiveManager.archiveTimestamp(created_at)}_${RunArchiveManager.safeArchiveSegment(generation_id, "run")}`,
        );

      fs.mkdirSync(run_dir, { recursive: true });

      const request_payload: XVibeJsonObject = {
        _generation_id: generation_id,
        _app_id: app_id,
        _env: env,
        ...(data._view_id ? { _view_id: data._view_id } : {}),
        ...(data._requested_view_id ? { _requested_view_id: data._requested_view_id } : {}),
        ...(data._source_view_id ? { _source_view_id: data._source_view_id } : {}),
        ...(data._mode ? { _mode: data._mode } : {}),
        ...(data._artifact_type ? { _artifact_type: data._artifact_type } : {}),
        ...(data._resolved_task ? { _resolved_task: data._resolved_task } : {}),
        ...(data._runtime_plan ? { _runtime_plan: data._runtime_plan } : {}),
        ...(data._validation_plan ? { _validation_plan: data._validation_plan } : {}),
        ...(data._deterministic_mutation ? { _deterministic_mutation: data._deterministic_mutation } : {}),
        _created_at: created_at,
        ...(data._user_prompt !== undefined ? { _user_prompt: data._user_prompt } : {}),
      };

      RunArchiveManager.writeArchiveJson(path.join(run_dir, "request.json"), request_payload);

      if (data._user_prompt !== undefined) {
        RunArchiveManager.writeArchiveFile(path.join(run_dir, "prompt.txt"), data._user_prompt);
      }

      if (data._final_prompt !== undefined) {
        RunArchiveManager.writeArchiveFile(path.join(run_dir, "final-prompt.txt"), data._final_prompt);
      }

      if (RunArchiveManager.hasArchiveValue(data._resolved_task)) {
        RunArchiveManager.writeArchiveJson(path.join(run_dir, "resolved-task.json"), data._resolved_task);
      }

      if (RunArchiveManager.hasArchiveValue(data._runtime_plan)) {
        RunArchiveManager.writeArchiveJson(path.join(run_dir, "runtime-plan.json"), data._runtime_plan);
      }

      if (RunArchiveManager.hasArchiveValue(data._validation_plan)) {
        RunArchiveManager.writeArchiveJson(path.join(run_dir, "validation-plan.json"), data._validation_plan);
      }

      if (RunArchiveManager.hasArchiveValue(data._artifact_plan)) {
        RunArchiveManager.writeArchiveJson(path.join(run_dir, "artifact-plan.json"), data._artifact_plan);
      }

      if (RunArchiveManager.hasArchiveValue(data._module_plan)) {
        RunArchiveManager.writeArchiveJson(path.join(run_dir, "module-plan.json"), data._module_plan);
      }

      if (RunArchiveManager.hasArchiveValue(data._intent_plan)) {
        RunArchiveManager.writeArchiveJson(path.join(run_dir, "intent-plan.json"), data._intent_plan);
      }

      const selected_skills =
        RunArchiveManager.hasArchiveValue(data._selected_skills)
          ? data._selected_skills
          : RunArchiveManager.hasArchiveValue(data._selected_skill_ids)
            ? { _selected_skill_ids: data._selected_skill_ids }
            : undefined;
      if (selected_skills !== undefined) {
        RunArchiveManager.writeArchiveJson(path.join(run_dir, "selected-skills.json"), selected_skills);
      }

      if (RunArchiveManager.hasArchiveValue(data._runtime_context)) {
        RunArchiveManager.writeArchiveJson(
          path.join(run_dir, "runtime-context.json"),
          RunArchiveManager.runtimeContextArchivePayload(data._runtime_context),
        );
      }

      if (RunArchiveManager.hasArchiveValue(data._ai_output)) {
        RunArchiveManager.writeArchiveJson(path.join(run_dir, "ai-output.json"), data._ai_output);
      }

      if (RunArchiveManager.hasArchiveValue(data._validation)) {
        RunArchiveManager.writeArchiveJson(path.join(run_dir, "validation.json"), data._validation);
      }

      if (RunArchiveManager.hasArchiveValue(data._deterministic_mutation)) {
        RunArchiveManager.writeArchiveJson(path.join(run_dir, "deterministic-mutation.json"), data._deterministic_mutation);
      }

      if (RunArchiveManager.hasArchiveValue(data._timeline)) {
        RunArchiveManager.writeArchiveJson(path.join(run_dir, "timeline.json"), data._timeline);
      }

      if (RunArchiveManager.hasArchiveValue(data._result)) {
        RunArchiveManager.writeArchiveJson(path.join(run_dir, "result.json"), data._result);
      }

      RunArchiveManager.writeArchiveJson(path.join(run_dir, "summary.json"), {
        _generation_id: generation_id,
        _app_id: app_id,
        _env: env,
        ...(data._view_id ? { _view_id: data._view_id } : {}),
        ...(data._requested_view_id ? { _requested_view_id: data._requested_view_id } : {}),
        ...(data._source_view_id ? { _source_view_id: data._source_view_id } : {}),
        ...(data._artifact_type ? { _artifact_type: data._artifact_type } : {}),
        ...(data._mode ? { _mode: data._mode } : {}),
        ...(data._resolved_task ? { _resolved_task: data._resolved_task } : {}),
        ...(data._deterministic_mutation ? { _deterministic_mutation: data._deterministic_mutation } : {}),
        _success: data._result?._success === true,
        _selected_skill_ids: data._selected_skill_ids ?? [],
        ...(typeof data._duration_ms === "number" ? { _duration_ms: data._duration_ms } : {}),
        _created_at: created_at,
      });

      _xlog.log("[xvibe] run archived", {
        _app_id: app_id,
        _env: env,
        _generation_id: generation_id,
        _archive_dir: run_dir,
      });
    } catch (error) {
      _xlog.warn("[xvibe] run archive failed", {
        _error: error_summary(error),
      });
    }
  }

  static readSafeVibeRunGenerationId(value: unknown): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    if (typeof value !== "string") {
      throw_explicit_error(
        XVIBE_INVALID_GENERATION_ID,
        "Invalid '_generation_id': expected safe generation id",
      );
    }

    const generation_id = value.trim();
    if (
      generation_id.length === 0 ||
      generation_id.includes("/") ||
      generation_id.includes("\\") ||
      generation_id.includes("..") ||
      !/^[a-zA-Z0-9._-]+$/u.test(generation_id)
    ) {
      throw_explicit_error(
        XVIBE_INVALID_GENERATION_ID,
        "Invalid '_generation_id': expected safe generation id",
      );
    }

    return generation_id;
  }

  static resolveVibeRunsDir(input: {
    _app_id: string;
    _env: string;
  }): string {
    const apps_root = path.resolve(RunArchiveManager.resolveXvibeWorkFolder(), "xvm", "apps");
    const runs_dir =
      path.resolve(apps_root, input._env, input._app_id, "vibe-runs");

    assert_path_inside(
      apps_root,
      runs_dir,
      XVIBE_INVALID_APP_ID,
      "Invalid vibe-run scope path",
    );

    return runs_dir;
  }

  static relativeVibeRunDir(input: {
    _app_id: string;
    _env: string;
    _run_id: string;
  }): string {
    return path.posix.join(
      "xvm",
      "apps",
      input._env,
      input._app_id,
      "vibe-runs",
      input._run_id,
    );
  }

  static listVibeRunDirs(runs_dir: string): string[] {
    if (!fs.existsSync(runs_dir)) {
      return [];
    }

    return fs.readdirSync(runs_dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) =>
        !name.includes("/") &&
        !name.includes("\\") &&
        !name.includes("..")
      )
      .sort();
  }

  static readVibeRunJsonFileIfPresent(
    file_path: string,
  ): XVibeJsonObject | undefined {
    try {
      const stat = fs.lstatSync(file_path);
      if (!stat.isFile() || stat.isSymbolicLink()) return undefined;
      const parsed = JSON.parse(fs.readFileSync(file_path, "utf-8"));
      return _xu.is_plain_object(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  static vibeRunGenerationIdFromDir(run_dir: string): string | undefined {
    const summary =
      RunArchiveManager.readVibeRunJsonFileIfPresent(path.join(run_dir, "summary.json"));
    if (typeof summary?._generation_id === "string" && summary._generation_id.trim()) {
      return summary._generation_id.trim();
    }

    const request =
      RunArchiveManager.readVibeRunJsonFileIfPresent(path.join(run_dir, "request.json"));
    if (typeof request?._generation_id === "string" && request._generation_id.trim()) {
      return request._generation_id.trim();
    }

    return undefined;
  }

  static resolveVibeRunDir(input: {
    _runs_dir: string;
    _generation_id?: string;
  }): { _run_id: string; _run_dir: string; _generation_id?: string } {
    const run_ids = RunArchiveManager.listVibeRunDirs(input._runs_dir);
    if (run_ids.length === 0) {
      throw_explicit_error(
        XVIBE_RUN_NOT_FOUND,
        "No vibe-runs found for app/env",
      );
    }

    if (!input._generation_id) {
      const run_id = run_ids[run_ids.length - 1];
      const run_dir = path.join(input._runs_dir, run_id);
      assert_path_inside(
        input._runs_dir,
        run_dir,
        XVIBE_RUN_NOT_FOUND,
        "Invalid vibe-run path",
      );

      return {
        _run_id: run_id,
        _run_dir: run_dir,
        _generation_id: RunArchiveManager.vibeRunGenerationIdFromDir(run_dir),
      };
    }

    const safe_generation_segment =
      RunArchiveManager.safeArchiveSegment(input._generation_id, "run");

    for (const run_id of [...run_ids].reverse()) {
      const run_dir = path.join(input._runs_dir, run_id);
      assert_path_inside(
        input._runs_dir,
        run_dir,
        XVIBE_RUN_NOT_FOUND,
        "Invalid vibe-run path",
      );

      const archived_generation_id =
        RunArchiveManager.vibeRunGenerationIdFromDir(run_dir);

      if (
        archived_generation_id === input._generation_id ||
        run_id.endsWith(`_${safe_generation_segment}`)
      ) {
        return {
          _run_id: run_id,
          _run_dir: run_dir,
          _generation_id: archived_generation_id ?? input._generation_id,
        };
      }
    }

    throw_explicit_error(
      XVIBE_RUN_NOT_FOUND,
      "Requested vibe-run was not found",
      {
        _generation_id: input._generation_id,
      },
    );
  }

  static readVibeRunDiagnosticFiles(
    runs_dir: string,
    run_dir: string,
  ): {
    _files: Record<string, unknown>;
    _file_errors: Array<{ _file: string; _message: string }>;
  } {
    assert_path_inside(
      runs_dir,
      run_dir,
      XVIBE_RUN_NOT_FOUND,
      "Invalid vibe-run path",
    );

    const files: Record<string, unknown> = {};
    const file_errors: Array<{ _file: string; _message: string }> = [];

    for (const [file_name, file_type] of Object.entries(VIBE_RUN_DIAGNOSTIC_FILE_TYPES)) {
      const file_path = path.join(run_dir, file_name);
      assert_path_inside(
        run_dir,
        file_path,
        XVIBE_RUN_NOT_FOUND,
        "Invalid vibe-run file path",
      );

      if (!fs.existsSync(file_path)) {
        continue;
      }

      try {
        const stat = fs.lstatSync(file_path);
        if (!stat.isFile() || stat.isSymbolicLink()) {
          continue;
        }

        const content = fs.readFileSync(file_path, "utf-8");
        files[file_name] =
          file_type === "json"
            ? JSON.parse(content)
            : content;
      } catch (error) {
        file_errors.push({
          _file: file_name,
          _message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { _files: files, _file_errors: file_errors };
  }

  static summarizeVibeRunDiagnostics(input: {
    _generation_id?: string;
    _files: Record<string, unknown>;
  }): XVibeRunDiagnosticSummary {
    const request = diagnostic_file_object(input._files, "request.json");
    const summary = diagnostic_file_object(input._files, "summary.json");
    const result = diagnostic_file_object(input._files, "result.json");
    const resolved_task = diagnostic_file_object(input._files, "resolved-task.json");
    const deterministic =
      diagnostic_file_object(input._files, "deterministic-mutation.json");
    const has_final_prompt =
      typeof input._files["final-prompt.txt"] === "string";
    const deterministic_eligible =
      deterministic?._eligible === true;
    const error_code =
      diagnostic_error_code(result?._error) ??
      diagnostic_error_code(result);
    const failed =
      result?._success === false ||
      result?._ok === false ||
      Boolean(error_code);
    const status: XVibeRunDiagnosticSummary["_status"] =
      failed
        ? "failed"
        : deterministic_eligible || result?._deterministic === true
          ? "deterministic"
          : deterministic?._eligible === false && has_final_prompt
            ? "fallback"
            : "completed";

    return {
      _generation_id:
        first_string_value(
          input._generation_id,
          request?._generation_id,
          summary?._generation_id,
        ),
      _artifact_type:
        first_string_value(
          result?._artifact_type,
          request?._artifact_type,
          summary?._artifact_type,
          resolved_task?._artifact_type,
        ),
      _mode:
        first_string_value(
          request?._mode,
          summary?._mode,
        ),
      _status: status,
      _deterministic_eligible: deterministic_eligible,
      _deterministic_reason:
        first_string_value(deterministic?._reason),
      _deterministic_action:
        first_string_value(
          deterministic?._action,
          result?._mutation_action,
        ),
      ...(error_code ? { _error_code: error_code } : {}),
      _has_final_prompt: has_final_prompt,
    };
  }
}
