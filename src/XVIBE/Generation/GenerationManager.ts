import { _x, _xlog, type XCommand } from "@xpell/core";
import { _xu } from "../../XNUtils/XUtils.js";
import { RunArchiveManager } from "../Archive/RunArchiveManager.js";
import type { XVibeJsonObject } from "../VibeOutputParser.js";

const DEFAULT_ENV = "default";
const XVIBE_INVALID_APP_ID = "E_XVIBE_INVALID_APP_ID";
const XVIBE_INVALID_ENV = "E_XVIBE_INVALID_ENV";

type GenerationManagerDeps = {
  _planner: {
    plan_app(prompt: string): any;
  };
  _generate_artifact: (
    params: XVibeJsonObject,
    forced_artifact_type?: any,
  ) => Promise<unknown>;
  _broadcast_generation_failed: (
    params: XVibeJsonObject,
    error: unknown,
    fallback_code: string,
  ) => void;
  _structured_error_payload: (error: unknown) => XVibeJsonObject | undefined;
  _parser_diagnostic: (error: unknown) => unknown;
  _parser_diagnostics: (error: unknown) => unknown;
  _resolve_prompt: (params: XVibeJsonObject) => string;
  _read_optional_string: (value: unknown, field_name: string) => string | undefined;
  _read_safe_path_segment: (
    value: unknown,
    field_name: string,
    code: string,
  ) => string;
  _explicit_error: (
    code: string,
    message: string,
    details?: XVibeJsonObject,
  ) => XVibeJsonObject;
  _resolve_xvibe_task: (input: any) => any;
  _read_existing_resolved_task: (value: unknown) => any;
  _push_generation_stage: (
    app_id: string,
    env: string,
    stage: string,
    message: string,
    generation_id?: string,
    details?: XVibeJsonObject,
  ) => void;
  _build_live_shell_view: (
    app_id: string,
    env: string,
    entry_view_id: string,
  ) => XVibeJsonObject;
  _apply_view_scope_lock_to_app_plan: (input: any) => {
    _plan: any;
    _warnings: any[];
  };
  _apply_view_scope_lock: (input: any) => {
    _intent_plan?: any;
    _warnings: any[];
  };
  _warn_if_plan_violates_resolved_task: (
    resolved_task: any,
    plan: unknown,
  ) => void;
  _create_intent_plan: (params: {
    prompt: string;
    app_plan: any;
    app_id: string;
    env: string;
  }) => Promise<any>;
  _ensure_server_module_for_intent: (input: {
    app_id: string;
    env: string;
    runtime_mode: string;
    prompt: string;
    intent_plan: any;
  }) => Promise<any>;
  _log_intent_plan: (scope: string, plan: any) => void;
  _build_execution_plan_for_intent: (plan: any, intent_plan: any) => any[];
  _build_artifact_generation_context: (input: any) => any;
  _generate_planned_artifacts: (input: any) => Promise<unknown>;
};

function unique_runtime_items(items: unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];

  for (const item of items) {
    const key =
      _xu.is_plain_object(item)
        ? String(item._id ?? item._name ?? JSON.stringify(item))
        : JSON.stringify(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result;
}

function unwrap_runtime_skills_payload(runtime_skills: unknown): unknown {
  if (
    _xu.is_plain_object(runtime_skills) &&
    _xu.is_plain_object(runtime_skills._skills)
  ) {
    return runtime_skills._skills;
  }

  return runtime_skills;
}

function merge_runtime_skill_payloads(
  existing_runtime_skills: unknown,
  engine_runtime_skills: unknown,
): XVibeJsonObject {
  const existing_payload = unwrap_runtime_skills_payload(existing_runtime_skills);
  const engine_payload = unwrap_runtime_skills_payload(engine_runtime_skills);
  const existing = _xu.is_plain_object(existing_payload) ? existing_payload : {};
  const engine = _xu.is_plain_object(engine_payload) ? engine_payload : {};

  return {
    ...existing,
    ...engine,
    _skills: unique_runtime_items([
      ...(Array.isArray(existing._skills) ? existing._skills : []),
      ...(Array.isArray(engine._skills) ? engine._skills : []),
    ]),
    _objects: unique_runtime_items([
      ...(Array.isArray(existing._objects) ? existing._objects : []),
      ...(Array.isArray(engine._objects) ? engine._objects : []),
    ]),
    _modules: unique_runtime_items([
      ...(Array.isArray(existing._modules) ? existing._modules : []),
      ...(Array.isArray(engine._modules) ? engine._modules : []),
    ]),
  };
}

export class GenerationManager {
  private readonly runtime_skills_by_scope = new Map<string, any>();
  private latest_runtime_skills: any = null;

  constructor(
    private readonly deps: GenerationManagerDeps,
  ) {}

  private runtimeSkillScope(
    app_id: unknown,
    env: unknown,
    mode: unknown,
  ): string {
    return [
      typeof env === "string" ? env : "default",
      typeof app_id === "string" ? app_id : "unknown",
      typeof mode === "string" ? mode : "runtime"
    ].join("::");
  }

  getRuntimeSkills(
    app_id?: string,
    env?: string,
    mode?: string,
  ) {
    if (
      app_id == null &&
      env == null &&
      mode == null
    ) {
      return this.latest_runtime_skills;
    }

    const scope =
      this.runtimeSkillScope(
        app_id,
        env,
        mode,
      );

    return (
      this.runtime_skills_by_scope.get(scope)
      ?? this.latest_runtime_skills
    );
  }

  refreshRuntimeSkillsAfterModuleCreation(
    app_id: string,
    env: string,
    mode: string,
  ): unknown {
    const get_skills =
      (_x as unknown as { getSkills?: () => unknown }).getSkills;

    if (typeof get_skills !== "function") {
      return this.getRuntimeSkills(app_id, env, mode);
    }

    const existing =
      this.getRuntimeSkills(app_id, env, mode);
    const engine_skills =
      get_skills.call(_x);
    const merged_skills =
      merge_runtime_skill_payloads(existing, engine_skills);
    const scope =
      this.runtimeSkillScope(app_id, env, mode);
    const skills_count =
      Array.isArray(merged_skills._modules)
        ? merged_skills._modules.length
        : 0;
    const snapshot = {
      _app_id: app_id,
      _env: env,
      _mode: mode,
      _skills: merged_skills,
      _skills_count: skills_count,
      _synced_at: new Date().toISOString()
    };

    this.runtime_skills_by_scope.set(scope, snapshot);
    this.latest_runtime_skills = snapshot;

    _xlog.log("[xvibe] runtime skills refreshed after module creation", {
      _scope: scope,
      _app_id: app_id,
      _env: env,
      _mode: mode,
      _skills_count: skills_count,
    });

    return snapshot;
  }

  async generate(xcmd: XCommand) {
    const params = _xu.is_plain_object(xcmd?._params) ? xcmd._params : {};
    try {
      const result = await this.deps._generate_artifact(params);
      return result;
    } catch (error) {
      this.deps._broadcast_generation_failed(params, error, "E_VIBE_AI_GENERATE");
      const structured = this.deps._structured_error_payload(error);
      if (structured) {
        _xlog.error("[xvibe] generate failed", error);
        return structured;
      }

      const message = error instanceof Error ? error.message : String(error);
      const diagnostic = this.deps._parser_diagnostic(error);
      const diagnostics = this.deps._parser_diagnostics(error);
      _xlog.error("[xvibe] generate failed", error);
      return {
        _ok: false,
        _error: {
          _code: "E_VIBE_AI_GENERATE",
          _message: message,
          ...(diagnostic ? { _diagnostic: diagnostic } : {}),
          ...(diagnostics ? { _diagnostics: diagnostics } : {}),
        },
      };
    }
  }

  async generateView(xcmd: XCommand) {
    const params = _xu.is_plain_object(xcmd?._params) ? xcmd._params : {};
    try {
      return await this.deps._generate_artifact(params, "view");
    } catch (error) {
      this.deps._broadcast_generation_failed(params, error, "E_VIBE_AI_GENERATE_VIEW");
      const structured = this.deps._structured_error_payload(error);
      if (structured) {
        _xlog.error("[xvibe] generate_view failed", error);
        return structured;
      }

      const message = error instanceof Error ? error.message : String(error);
      const diagnostic = this.deps._parser_diagnostic(error);
      const diagnostics = this.deps._parser_diagnostics(error);
      _xlog.error("[xvibe] generate_view failed", error);
      return {
        _ok: false,
        _error: {
          _code: "E_VIBE_AI_GENERATE_VIEW",
          _message: message,
          ...(diagnostic ? { _diagnostic: diagnostic } : {}),
          ...(diagnostics ? { _diagnostics: diagnostics } : {}),
        },
      };
    }
  }

  async getLatestRun(xcmd: XCommand) {
    try {
      const params = _xu.is_plain_object(xcmd?._params) ? xcmd._params : {};
      const app_id =
        this.deps._read_safe_path_segment(params._app_id, "_app_id", XVIBE_INVALID_APP_ID);
      const env =
        this.deps._read_safe_path_segment(params._env ?? DEFAULT_ENV, "_env", XVIBE_INVALID_ENV);
      const generation_id =
        RunArchiveManager.readSafeVibeRunGenerationId(params._generation_id);
      const runs_dir =
        RunArchiveManager.resolveVibeRunsDir({
          _app_id: app_id,
          _env: env,
        });
      const run =
        RunArchiveManager.resolveVibeRunDir({
          _runs_dir: runs_dir,
          ...(generation_id ? { _generation_id: generation_id } : {}),
        });
      const diagnostics =
        RunArchiveManager.readVibeRunDiagnosticFiles(runs_dir, run._run_dir);
      const summary =
        RunArchiveManager.summarizeVibeRunDiagnostics({
          _generation_id: run._generation_id ?? generation_id,
          _files: diagnostics._files,
        });
      const result = {
        _ok: true,
        _run_id: run._run_id,
        _run_dir: RunArchiveManager.relativeVibeRunDir({
          _app_id: app_id,
          _env: env,
          _run_id: run._run_id,
        }),
        ...(summary._generation_id ? { _generation_id: summary._generation_id } : {}),
        _summary: summary,
        _files: diagnostics._files,
        ...(diagnostics._file_errors.length > 0
          ? { _file_errors: diagnostics._file_errors }
          : {}),
      };

      return result;
    } catch (error) {
      const structured =
        this.deps._structured_error_payload(error) ??
        RunArchiveManager.errorPayload(error);
      if (structured) {
        _xlog.error("[xvibe] get_latest_run failed", error);
        return structured;
      }

      const message = error instanceof Error ? error.message : String(error);
      _xlog.error("[xvibe] get_latest_run failed", error);
      return this.deps._explicit_error("E_XVIBE_GET_LATEST_RUN_FAILED", message);
    }
  }

  async planApp(xcmd: XCommand) {
    try {
      const params = _xu.is_plain_object(xcmd?._params) ? xcmd._params : {};
      const prompt = this.deps._resolve_prompt(params);
      const plan = this.deps._planner.plan_app(prompt);

      _xlog.log("[xvibe] app plan created", {
        _app_type: plan._app_type,
        _logic_level: plan._logic_level,
        _artifacts: plan._artifacts,
        ...(plan._flow_ids ? { _flow_ids: plan._flow_ids } : {}),
        _requires_module: plan._requires_module,
      });

      return {
        _ok: true,
        _result: plan,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      _xlog.error("[xvibe] plan_app failed", error);
      return {
        _ok: false,
        _error: {
          _code: "E_VIBE_PLAN_APP",
          _message: message,
        },
      };
    }
  }

  async generateModuleSpec(xcmd: XCommand) {
    const params = xcmd._params ?? {};
    const prompt = String(params._prompt ?? "").trim();

    if (!prompt) {
      return {
        _ok: false,
        _needs_module_creator: true,
        _error: {
          _code: "E_XVIBE_EMPTY_PROMPT",
          _message: "Missing _prompt for module spec generation."
        }
      };
    }

    const resolved_task =
      this.deps._resolve_xvibe_task({
        _prompt: prompt,
      });
    _xlog.log("[xvibe] resolved task", resolved_task);

    const module_id =
      String(
        params._module_id ??
        resolved_task._module_name ??
        "generated-module",
      );
    const module_name =
      String(
        params._module_name ??
        params._module_id ??
        resolved_task._module_name ??
        "generated-module",
      );

    const spec: any = {
      _id: module_id,
      _name: module_name,
      _target: "server" as const,
      _description: `Generated server module from prompt: ${prompt}`,
      _version: "0.1.0",
      _imports: [
        {
          _from: "@xpell/node"
        }
      ],
      _permissions: [],
      _ops:
        resolved_task._module_ops.map((op_name: string) => ({
          _name: op_name,
          _description: `Generated operation '${op_name}' for module '${module_name}'.`,
          _params: {
            _input: "Optional input payload."
          }
        }))
    };

    return {
      _ok: true,
      _spec: spec,
      _needs_module_creator: true
    };
  }

  async generateApp(cmd: XCommand) {
    const params =
      _xu.is_plain_object(cmd?._params)
        ? cmd._params
        : {};

    try {
      const prompt = this.deps._resolve_prompt(params);
      const resolved_task =
        this.deps._read_existing_resolved_task(params._resolved_task) ??
        this.deps._resolve_xvibe_task({
          _prompt: prompt,
        });
      params._resolved_task = resolved_task;
      _xlog.log("[xvibe] resolved task", resolved_task);
      const app_id =
        this.deps._read_optional_string(params._app_id, "_app_id") ?? "xvibe-app";
      const env =
        this.deps._read_optional_string(params._env, "_env") ?? DEFAULT_ENV;
      const generation_id = this.deps._read_optional_string(params._generation_id, "_generation_id");
      const entry_view_id = "main";

      _xlog.log("[xvibe] generate_app:start", {
        _prompt: prompt,
        _app_id: app_id,
        _env: env,
      });

      await _x.execute({
        _module: "server-xvm",
        _op: "create_app",
        _params: {
          _app_id: app_id,
          _env: env,
          _name: app_id,
          _entry_view_id: entry_view_id,
        }
      });

      this.deps._push_generation_stage(
        app_id,
        env,
        "shell",
        "Creating application...",
        generation_id
      );

      await _x.execute({
        _module: "server-xvm",
        _op: "push_update",
        _params: {
          _app_id: app_id,
          _env: env,
          ...(generation_id ? { _generation_id: generation_id } : {}),
          _view: this.deps._build_live_shell_view(app_id, env, entry_view_id),
        }
      });

      _xlog.log("[xvibe] live shell pushed", {
        _app_id: app_id,
        _env: env,
        _view_id: entry_view_id,
      });

      await _x.execute({
        _module: "server-xvm",
        _op: "set_active_app",
        _params: {
          _app_id: app_id,
          _env: env
        }
      });

      _xlog.log("[xvibe] active app set early", {
        _app_id: app_id,
        _env: env,
      });

      let plan = this.deps._planner.plan_app(prompt);
      let view_scope_warnings: string[] = [];
      const app_view_scope_lock =
        this.deps._apply_view_scope_lock_to_app_plan({
          prompt,
          resolved_task,
          plan,
        });
      plan = app_view_scope_lock._plan;
      view_scope_warnings = [
        ...view_scope_warnings,
        ...app_view_scope_lock._warnings,
      ];
      this.deps._warn_if_plan_violates_resolved_task(resolved_task, plan);
      _xlog.log("[xvibe] app plan created", {
        _app_type: plan._app_type,
        _logic_level: plan._logic_level,
        _artifacts: plan._artifacts,
        ...(plan._flow_ids ? { _flow_ids: plan._flow_ids } : {}),
        _requires_module: plan._requires_module,
      });

      this.deps._push_generation_stage(
        app_id,
        env,
        "planning",
        "Planning application...",
        generation_id
      );

      let intent_plan = await this.deps._create_intent_plan({
        prompt,
        app_plan: plan,
        app_id,
        env,
      });
      if (resolved_task._artifact_type === "view") {
        const view_scope_lock =
          this.deps._apply_view_scope_lock({
            prompt,
            resolved_task,
            intent_plan,
          });
        intent_plan = view_scope_lock._intent_plan ?? intent_plan;
        view_scope_warnings = [
          ...view_scope_warnings,
          ...view_scope_lock._warnings,
        ];
      }
      const module_ensure_result =
        await this.deps._ensure_server_module_for_intent({
          app_id,
          env,
          runtime_mode:
            app_id === "vibe-system"
              ? "system"
              : "runtime",
          prompt,
          intent_plan,
        });
      intent_plan = module_ensure_result._intent_plan;
      if (resolved_task._artifact_type === "view") {
        const view_scope_lock =
          this.deps._apply_view_scope_lock({
            prompt,
            resolved_task,
            intent_plan,
          });
        intent_plan = view_scope_lock._intent_plan ?? intent_plan;
        view_scope_warnings = [
          ...view_scope_warnings,
          ...view_scope_lock._warnings,
        ];
      }
      this.deps._warn_if_plan_violates_resolved_task(resolved_task, intent_plan);
      if (view_scope_warnings.length > 0) {
        _xlog.warn("[xvibe] view scope lock warnings", {
          _warnings: Array.from(new Set(view_scope_warnings)),
        });
      }

      this.deps._push_generation_stage(
        app_id,
        env,
        "planned",
        "Application plan created",
        generation_id
      );

      this.deps._log_intent_plan("artifact_type", intent_plan);
      const execution_plan = this.deps._build_execution_plan_for_intent(plan, intent_plan);
      this.deps._warn_if_plan_violates_resolved_task(resolved_task, {
        _primary_artifact_type: execution_plan[execution_plan.length - 1]?._artifact_type,
        _artifacts: execution_plan,
      });
      _xlog.log("[xvibe] execution plan created", {
        _app_id: app_id,
        _execution_plan: execution_plan,
      });

      this.deps._push_generation_stage(
        app_id,
        env,
        "generating",
        "Generating artifacts...",
        generation_id
      );
      const context = this.deps._build_artifact_generation_context({
        _plan: plan,
        _intent_plan: intent_plan,
        _resolved_task: resolved_task,
        _app_id: app_id,
        _env: env,
        ...(generation_id ? { _generation_id: generation_id } : {}),
      });

      const generated_artifacts =
        await this.deps._generate_planned_artifacts({
          _prompt: prompt,
          _entry_view_id: entry_view_id,
          _execution_plan: execution_plan,
          _context: context,
        });

      await _x.execute({
        _module: "server-xvm",
        _op: "set_active_app",
        _params: {
          _app_id: app_id,
          _env: env
        }
      });

      _xlog.log("[xvibe] app orchestration completed", {
        _app_id: app_id,
        _env: env,
        _generated_artifacts: generated_artifacts,
      });

      this.deps._push_generation_stage(
        app_id,
        env,
        "complete",
        "Application ready",
        generation_id
      );

      return {
        _ok: true,
        _result: {
          _app_id: app_id,
          _env: env,
          _entry_view_id: entry_view_id,
          _plan: plan,
          _intent_plan: intent_plan,
          _generated_artifacts: generated_artifacts,
        }
      };
    } catch (error) {
      this.deps._broadcast_generation_failed(
        {
          ...params,
          _app_id:
            typeof params._app_id === "string" && params._app_id.trim()
              ? params._app_id.trim()
              : "xvibe-app",
          _env:
            typeof params._env === "string" && params._env.trim()
              ? params._env.trim()
              : DEFAULT_ENV,
        },
        error,
        "E_VIBE_AI_GENERATE_APP",
      );
      const structured = this.deps._structured_error_payload(error);
      if (structured) {
        _xlog.error("[xvibe] generate_app failed", error);
        return structured;
      }

      const message = error instanceof Error ? error.message : String(error);
      const diagnostic = this.deps._parser_diagnostic(error);
      const diagnostics = this.deps._parser_diagnostics(error);
      _xlog.error("[xvibe] generate_app failed", error);
      return {
        _ok: false,
        _error: {
          _code: "E_VIBE_AI_GENERATE_APP",
          _message: message,
          ...(diagnostic ? { _diagnostic: diagnostic } : {}),
          ...(diagnostics ? { _diagnostics: diagnostics } : {}),
        },
      };
    }
  }

  async syncSkills(xcmd: XCommand) {
    const params =
      _xu.is_plain_object(xcmd?._params)
        ? xcmd._params
        : {};

    const skills =
      _xu.is_plain_object(params._skills)
        ? params._skills
        : {};

    const skills_count =
      Array.isArray((skills as any)._modules)
        ? (skills as any)._modules.length
        : 0;

    const scope =
      this.runtimeSkillScope(
        params._app_id,
        params._env,
        params._mode
      );

    this.runtime_skills_by_scope.set(scope, {
      _app_id: params._app_id,
      _env: params._env,
      _mode: params._mode,
      _skills: skills,
      _skills_count: skills_count,
      _synced_at: new Date().toISOString()
    });

    this.latest_runtime_skills = {
      _app_id: params._app_id,
      _env: params._env,
      _mode: params._mode,
      _skills: skills,
      _skills_count: skills_count,
      _synced_at: new Date().toISOString()
    };

    _xlog.log("[xvibe] runtime skills synced", {
      _scope: scope,
      _app_id: params._app_id,
      _env: params._env,
      _mode: params._mode,
      _skills_count: skills_count
    });

    return {
      _ok: true,
      _result: {
        _synced: true,
        _scope: scope,
        _skills_count: skills_count
      }
    };
  }
}
