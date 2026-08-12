import {
  XError,
  XModule,
  XResponseError,
  XResponseOK,
  _x,
  _xlog,
  type XCommand,
  type XpellSkill,
  type XpellSkillCommand,
} from "@xpell/core";
import { _xu } from "@xpell/node-core";

import {
  XNODE_PLANNING_ERR,
  XNodePlanningError,
  assert_planning_context,
  extract_xvibe_planning_state,
  normalize_xvibe_planning_state,
  resolve_xnode_confirmed_runtime_lifecycle,
  resolve_xnode_planning_runtime_lifecycle,
  resolve_xnode_project_memory_runtime_lifecycle,
  validate_xvibe_planning_answer,
  type XNodeRuntimeLifecycleState,
  type XNodePlanningReadiness,
  type XNodePlanningState,
} from "./XPlanningContract.js";

const DEFAULT_ENV = "default";

type PlanningCommandParams = Record<string, unknown> & {
  _app_id: string;
  _env: string;
  _conversation_id?: string;
};

export const XPLANNING_OPS: Record<string, XpellSkillCommand> = {
  "start-planning": {
    _name: "start-planning",
    _scope: "module",
    _description:
      "Start an XVibe initial-planning session and return a validated XNode planning boundary DTO.",
    _params: {
      _app_id: "Target app id.",
      _env: "Optional environment. Defaults to default.",
      _conversation_id: "Conversation id used by XVibe for draft storage.",
      _message: "User's initial planning message.",
      _runtime_context: "Optional XVibe runtime context.",
    },
  },
  "get-planning-state": {
    _name: "get-planning-state",
    _scope: "module",
    _description:
      "Read an existing XVibe conversation planning draft and validate it at the XNode boundary.",
    _params: {
      _app_id: "Target app id.",
      _env: "Optional environment. Defaults to default.",
      _conversation_id: "Conversation id containing the planning draft.",
    },
  },
  "answer-planning-question": {
    _name: "answer-planning-question",
    _scope: "module",
    _description:
      "Validate a planning answer against the supplied planning state, then forward it to XVibe.",
    _params: {
      _app_id: "Target app id.",
      _env: "Optional environment. Defaults to default.",
      _conversation_id: "Conversation id used by XVibe for draft storage.",
      _question_id: "Current planning question id.",
      _answer: "Answer value. Single choice is a string; multi choice is string array.",
      _planning_state: "Current validated planning state used for boundary answer validation.",
      _message: "Optional message text. Defaults to the answer text.",
      _runtime_context: "Optional XVibe runtime context.",
    },
  },
  "resume-planning": {
    _name: "resume-planning",
    _scope: "module",
    _description:
      "Alias for get-planning-state. It validates the persisted draft without changing it.",
    _params: {
      _app_id: "Target app id.",
      _env: "Optional environment. Defaults to default.",
      _conversation_id: "Conversation id containing the planning draft.",
    },
  },
  "validate-planning-state": {
    _name: "validate-planning-state",
    _scope: "module",
    _description:
      "Validate and normalize an XVibe project-plan payload without invoking XVibe.",
    _params: {
      _planning_state: "XVibe project-plan payload or analyze-message response.",
    },
  },
  "confirm-project-plan": {
    _name: "confirm-project-plan",
    _scope: "module",
    _description:
      "Evaluate XVibe planning readiness, then invoke xvibe.confirm-project-plan when the plan is ready.",
    _params: {
      _app_id: "Target app id.",
      _env: "Optional environment. Defaults to default.",
      _conversation_id: "Conversation id containing the planning draft.",
      _planning_state: "Optional validated planning state or project-plan fallback.",
      _project_plan: "Optional XVibe project-plan fallback.",
      _message_id: "Optional XVibe message id.",
    },
  },
  "get-guide-recommendation": {
    _name: "get-guide-recommendation",
    _scope: "module",
    _description:
      "Return a lifecycle-gated XVibe guide recommendation only after project planning has been confirmed.",
    _params: {
      _app_id: "Target app id.",
      _env: "Optional environment. Defaults to default.",
      _conversation_id: "Optional conversation id used to inspect an active planning draft.",
      _planning_state: "Optional planning state. Unconfirmed planning states block executable guide actions.",
      _runtime_assets: "Optional runtime asset snapshot forwarded to XVibe only when guide actions are available.",
      _runtime_skills: "Optional runtime skill snapshot forwarded to XVibe only when guide actions are available.",
    },
  },
  "execute-guide-recommendation": {
    _name: "execute-guide-recommendation",
    _scope: "module",
    _description:
      "Validate and execute a confirmed XVibe guide recommendation by forwarding its canonical execution payload through XVibe.",
    _params: {
      _app_id: "Target app id.",
      _env: "Optional environment. Defaults to default.",
      _conversation_id: "Optional source conversation id for artifact status persistence.",
      _message_id: "Optional source message id for artifact status persistence.",
      _recommendation: "Canonical XVibe guide recommendation returned by get-guide-recommendation.",
      _runtime_assets: "Optional runtime asset snapshot forwarded only when fetching the next guide recommendation.",
      _runtime_skills: "Optional runtime skill snapshot forwarded only when fetching the next guide recommendation.",
    },
  },
  "save-planning-state": {
    _name: "save-planning-state",
    _scope: "module",
    _description:
      "Return an explicit boundary error because XVibe analyze-message owns current planning draft persistence.",
    _params: {
      _app_id: "Target app id.",
      _env: "Optional environment. Defaults to default.",
      _conversation_id: "Conversation id containing the planning draft.",
      _planning_state: "Planning state the caller attempted to save.",
    },
  },
};

export const XPLANNING_SKILL: XpellSkill = {
  _id: "planning",
  _title: "XNode Planning Boundary Module",
  _version: "1.0.0",
  _active: true,
  _type: "server-module-api",
  _requires: ["xmodule", "xvibe"],
  _description:
    "Server-side boundary module for invoking XVibe planning and validating/transporting planning DTOs without owning semantic planning decisions.",

  _exports: {
    _modules: [
      {
        _name: "planning",
        _scope: "server",
        _description:
          "XNode planning operations that forward to XVibe and validate returned project-plan data.",
        _ops: Object.values(XPLANNING_OPS),
      },
    ],
  },

  _core_rules: [
    "XNode owns operation validation, app/conversation context, transport, result keys, errors, and logging.",
    "XVibe owns app archetype, scope, question selection, proposed entities, proposed views, and proposed flows.",
    "Normalize structural defaults only.",
    "Do not convert unknown or custom semantic fields into business defaults.",
    "All XVibe calls route through _x.execute.",
  ],
};

function read_required_string(
  params: Record<string, unknown>,
  key: string,
): string {
  const value = params[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid ${key}: expected non-empty string`);
  }

  return value.trim();
}

function read_env(params: Record<string, unknown>): string {
  const value = params._env;
  if (value === undefined || value === null || value === "") return DEFAULT_ENV;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("Invalid _env: expected non-empty string");
  }

  return value.trim();
}

function read_params(params: unknown): PlanningCommandParams {
  const record = _xu.ensure_params(params) as Record<string, unknown>;
  return {
    ...record,
    _app_id: read_required_string(record, "_app_id"),
    _env: read_env(record),
    ...(typeof record._conversation_id === "string" &&
      record._conversation_id.trim().length > 0
      ? { _conversation_id: record._conversation_id.trim() }
      : {}),
  };
}

function normalize_runtime_context(
  params: PlanningCommandParams,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const runtime_context = _xu.is_plain_object(params._runtime_context)
    ? { ...params._runtime_context }
    : {};
  delete runtime_context._guide_active_recommendation;
  delete runtime_context._runtime_lifecycle;

  const runtime_lifecycle = resolve_xnode_planning_runtime_lifecycle({
    _planning_status: "collecting-information",
    _ready: false,
  });

  return {
    ...runtime_context,
    ...extra,
    _app_id: params._app_id,
    _env: params._env,
    _stage: "planning",
    _runtime_lifecycle: runtime_lifecycle,
    ...(params._conversation_id
      ? { _conversation_id: params._conversation_id }
      : {}),
  };
}

function answer_to_message(answer: unknown): string {
  if (Array.isArray(answer)) {
    return answer.map((item) => String(item)).join(", ");
  }
  return String(answer ?? "");
}

function planning_response(
  planning: XNodePlanningState,
  details: Record<string, unknown> = {},
) {
  return new XResponseOK({
    ...details,
    _planning: planning,
    _runtime_lifecycle: planning._runtime_lifecycle,
  }).toXData();
}

function guide_response(input: {
  _recommendation: unknown;
  _runtime_lifecycle: XNodeRuntimeLifecycleState;
  _blocked_reason?: string;
  _details?: Record<string, unknown>;
}) {
  return {
    _ok: true,
    _result: {
      ...(input._details ?? {}),
      _recommendation: input._recommendation,
      _guide: {
        _available: input._runtime_lifecycle._guide_available,
        _executable_actions_available:
          input._runtime_lifecycle._executable_guide_actions_available,
        ...(input._blocked_reason
          ? { _blocked_reason: input._blocked_reason }
          : {}),
      },
      _runtime_lifecycle: input._runtime_lifecycle,
    },
    _recommendation: input._recommendation,
    _runtime_lifecycle: input._runtime_lifecycle,
  };
}

function readiness_error_details(readiness: XNodePlanningReadiness) {
  return {
    _blockers: readiness._blockers,
    _warnings: readiness._warnings,
    _unresolved_required_decisions:
      readiness._unresolved_required_decisions,
    _unresolved_optional_decisions:
      readiness._unresolved_optional_decisions,
    _summary: readiness._summary,
  };
}

function planning_xerror_response(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  return new XResponseError(
    new XError(code, message, {
      _meta: details,
    }),
  ).toXData();
}

function planning_error_response(err: unknown) {
  if (err instanceof XNodePlanningError) {
    return planning_xerror_response(err._code, err.message, err._details);
  }
  return new XResponseError(err).toXData();
}

function runtime_type_name(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "Array";
  if (value instanceof Date) return "Date";
  if (value instanceof Map) return "Map";
  if (value instanceof Set) return "Set";
  if (typeof value === "object") {
    const ctor = (value as { constructor?: { name?: string } }).constructor;
    return typeof ctor?.name === "string" ? ctor.name : "Object";
  }
  return typeof value;
}

function find_non_json_compatible_value(
  value: unknown,
  path: string,
): Record<string, unknown> | undefined {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return undefined;
  }

  if (typeof value === "number") {
    return Number.isFinite(value)
      ? undefined
      : {
        _path: path,
        _runtime_type: "number",
        _reason: "number must be finite",
      };
  }

  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    return {
      _path: path,
      _runtime_type: runtime_type_name(value),
      _reason: "value cannot be represented in JSON",
    };
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const invalid = find_non_json_compatible_value(value[index], `${path}[${index}]`);
      if (invalid) return invalid;
    }
    return undefined;
  }

  if (!_xu.is_plain_object(value)) {
    return {
      _path: path,
      _runtime_type: runtime_type_name(value),
      _reason: "value must be a plain JSON object",
    };
  }

  for (const [key, item] of Object.entries(value)) {
    const invalid = find_non_json_compatible_value(item, `${path}.${key}`);
    if (invalid) return invalid;
  }
  return undefined;
}

function clone_json_compatible<T>(value: T, label: string): T {
  const invalid = find_non_json_compatible_value(value, label);
  if (invalid) {
    throw new XNodePlanningError(
      XNODE_PLANNING_ERR.GUIDE_RECOMMENDATION_INVALID,
      `Invalid ${label}: expected JSON-compatible data.`,
      { _invalid_value: invalid },
    );
  }

  return JSON.parse(JSON.stringify(value)) as T;
}

function read_optional_execution_string(
  value: unknown,
): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function get_path(value: unknown, path: string[]): unknown {
  let current = value;
  for (const part of path) {
    if (!_xu.is_plain_object(current)) return undefined;
    current = current[part];
  }
  return current;
}

function semantic_plan_refs_from_recommendation(
  recommendation: Record<string, unknown>,
): Record<string, unknown>[] {
  const candidates = [
    recommendation._semantic_plan_ref,
    get_path(recommendation, ["_action", "_semantic_plan_ref"]),
    get_path(recommendation, ["_action", "_requirement", "_semantic_plan_ref"]),
    get_path(recommendation, ["_action", "_requirement", "_semantic_generation_plan_ref"]),
  ];

  return candidates.filter((item): item is Record<string, unknown> =>
    _xu.is_plain_object(item)
  );
}

function assert_semantic_plan_ref_current(input: {
  _recommendation: Record<string, unknown>;
  _project_memory: Record<string, unknown>;
}) {
  const refs = semantic_plan_refs_from_recommendation(input._recommendation);
  if (refs.length === 0) return;

  const current =
    _xu.is_plain_object(input._project_memory._semantic_generation_plan)
      ? input._project_memory._semantic_generation_plan
      : undefined;
  if (!current) {
    throw new XNodePlanningError(
      XNODE_PLANNING_ERR.GUIDE_PLAN_STALE,
      "Guide recommendation references a semantic plan that is no longer available.",
      { _reason: "semantic-plan-missing" },
    );
  }

  for (const ref of refs) {
    const mismatches: string[] = [];
    for (const key of ["_type", "_version", "_source"] as const) {
      if (
        ref[key] !== undefined &&
        current[key] !== undefined &&
        ref[key] !== current[key]
      ) {
        mismatches.push(key);
      }
    }

    if (mismatches.length > 0) {
      throw new XNodePlanningError(
        XNODE_PLANNING_ERR.GUIDE_PLAN_STALE,
        "Guide recommendation was built from a stale semantic plan.",
        {
          _reason: "semantic-plan-version-mismatch",
          _mismatches: mismatches,
          _expected: ref,
          _actual: {
            _type: current._type,
            _version: current._version,
            _source: current._source,
          },
        },
      );
    }
  }
}

function command_payload_missing_fields(
  payload: Record<string, unknown>,
): string[] {
  const missing: string[] = [];
  if (!read_optional_execution_string(payload._module)) {
    missing.push("_action._execution_payload._module");
  }
  if (!read_optional_execution_string(payload._op)) {
    missing.push("_action._execution_payload._op");
  }
  if (!_xu.is_plain_object(payload._params)) {
    missing.push("_action._execution_payload._params");
  }
  return missing;
}

function assert_execution_payload_supported(
  recommendation: Record<string, unknown>,
): {
  _recommendation: Record<string, unknown>;
  _execution_payload: {
    _module: string;
    _op: string;
    _params: Record<string, unknown>;
  };
  _executor_route: "xvibe.apply-artifact-request" | "xvibe.execute-execution-graph";
} {
  const action = recommendation._action;
  if (!_xu.is_plain_object(action)) {
    throw new XNodePlanningError(
      XNODE_PLANNING_ERR.GUIDE_RECOMMENDATION_INVALID,
      "Invalid guide recommendation: missing _action object.",
      { _missing_fields: ["_action"] },
    );
  }

  const payload = action._execution_payload;
  if (!_xu.is_plain_object(payload)) {
    throw new XNodePlanningError(
      XNODE_PLANNING_ERR.GUIDE_RECOMMENDATION_INVALID,
      "Invalid guide recommendation: missing executable action payload.",
      { _missing_fields: ["_action._execution_payload"] },
    );
  }

  const missing = command_payload_missing_fields(payload);
  if (missing.length > 0) {
    throw new XNodePlanningError(
      XNODE_PLANNING_ERR.GUIDE_RECOMMENDATION_INVALID,
      "Invalid guide recommendation: executable action payload is incomplete.",
      { _missing_fields: missing },
    );
  }

  const module_name = (payload._module as string).trim();
  const op = (payload._op as string).trim();
  const params = payload._params as Record<string, unknown>;

  if (module_name !== "xvibe") {
    throw new XNodePlanningError(
      XNODE_PLANNING_ERR.GUIDE_RECOMMENDATION_INVALID,
      "Invalid guide recommendation: executable action must target XVibe.",
      { _module: module_name, _op: op },
    );
  }

  if (op === "apply-artifact-request") {
    const artifact_missing: string[] = [];
    if (!read_optional_execution_string(params._app_id)) {
      artifact_missing.push("_action._execution_payload._params._app_id");
    }
    if (!read_optional_execution_string(params._env)) {
      artifact_missing.push("_action._execution_payload._params._env");
    }
    if (!read_optional_execution_string(params._artifact_type)) {
      artifact_missing.push("_action._execution_payload._params._artifact_type");
    }
    if (!_xu.is_plain_object(params._artifact_request)) {
      artifact_missing.push("_action._execution_payload._params._artifact_request");
    }
    if (artifact_missing.length > 0) {
      throw new XNodePlanningError(
        XNODE_PLANNING_ERR.GUIDE_RECOMMENDATION_INVALID,
        "Invalid guide recommendation: artifact execution payload is incomplete.",
        { _missing_fields: artifact_missing },
      );
    }

    return {
      _recommendation: recommendation,
      _execution_payload: {
        _module: module_name,
        _op: op,
        _params: params,
      },
      _executor_route: "xvibe.apply-artifact-request",
    };
  }

  if (op === "execute-execution-graph") {
    const graph_missing: string[] = [];
    if (params._graph_type !== "crud") {
      graph_missing.push("_action._execution_payload._params._graph_type");
    }
    if (!read_optional_execution_string(params._app_id)) {
      graph_missing.push("_action._execution_payload._params._app_id");
    }
    if (!read_optional_execution_string(params._env)) {
      graph_missing.push("_action._execution_payload._params._env");
    }
    if (!read_optional_execution_string(params._entity_name)) {
      graph_missing.push("_action._execution_payload._params._entity_name");
    }
    if (graph_missing.length > 0) {
      throw new XNodePlanningError(
        XNODE_PLANNING_ERR.GUIDE_RECOMMENDATION_INVALID,
        "Invalid guide recommendation: CRUD execution graph payload is incomplete.",
        { _missing_fields: graph_missing },
      );
    }

    return {
      _recommendation: recommendation,
      _execution_payload: {
        _module: module_name,
        _op: op,
        _params: params,
      },
      _executor_route: "xvibe.execute-execution-graph",
    };
  }

  throw new XNodePlanningError(
    XNODE_PLANNING_ERR.GUIDE_RECOMMENDATION_INVALID,
    "Invalid guide recommendation: unsupported executable action route.",
    { _module: module_name, _op: op },
  );
}

function assert_payload_app_context(input: {
  _params: PlanningCommandParams;
  _payload_params: Record<string, unknown>;
}) {
  const payload_app_id = read_optional_execution_string(input._payload_params._app_id);
  const payload_env = read_optional_execution_string(input._payload_params._env);
  const mismatches: string[] = [];
  if (payload_app_id !== input._params._app_id) mismatches.push("_app_id");
  if (payload_env !== input._params._env) mismatches.push("_env");
  if (mismatches.length === 0) return;

  throw new XNodePlanningError(
    XNODE_PLANNING_ERR.GUIDE_PLAN_STALE,
    "Guide recommendation app/environment context does not match the execution request.",
    {
      _reason: "app-context-mismatch",
      _mismatches: mismatches,
      _expected: {
        _app_id: input._params._app_id,
        _env: input._params._env,
      },
      _actual: {
        _app_id: payload_app_id,
        _env: payload_env,
      },
    },
  );
}

function guide_execution_status(result: unknown): string {
  if (!_xu.is_plain_object(result)) return "done";
  if (result._already_exists === true) return "already-exists";
  if (
    _xu.is_plain_object(result._summary) &&
    typeof result._summary._created === "number" &&
    typeof result._summary._existing === "number" &&
    typeof result._summary._failed === "number" &&
    result._summary._created === 0 &&
    result._summary._existing > 0 &&
    result._summary._failed === 0
  ) {
    return "already-exists";
  }
  return "done";
}

function executor_failure_response(input: {
  _recommendation: Record<string, unknown>;
  _executor_route: string;
  _execution_result: unknown;
}) {
  return planning_xerror_response(
    XNODE_PLANNING_ERR.GUIDE_EXECUTION_FAILED,
    "Guide recommendation execution failed.",
    {
      _recommendation: input._recommendation,
      _executor_route: input._executor_route,
      _execution_result: input._execution_result,
    },
  );
}

async function persist_guide_execution_status(input: {
  _params: PlanningCommandParams;
  _recommendation: Record<string, unknown>;
  _executor_route: string;
  _execution_result: unknown;
  _status: "done" | "failed";
}) {
  const conversation_id = input._params._conversation_id;
  const message_id =
    typeof input._params._message_id === "string" &&
      input._params._message_id.trim().length > 0
      ? input._params._message_id.trim()
      : undefined;
  if (!conversation_id || !message_id) return;

  const artifact_result = clone_json_compatible({
    _type: "guide-recommendation-execution",
    _recommendation: input._recommendation,
    _executor_route: input._executor_route,
    _execution_result: input._execution_result,
  }, "_artifact_result");

  const update_result = await _x.execute({
    _module: "xvibe",
    _op: "update-conversation-artifact",
    _params: {
      _app_id: input._params._app_id,
      _env: input._params._env,
      _conversation_id: conversation_id,
      _message_id: message_id,
      _artifact_status: input._status,
      _artifact_result: artifact_result,
    },
  } as any);
  if (!_xu.is_plain_object(update_result) || update_result._ok !== true) {
    _xlog.warn("[planning] guide execution conversation artifact update skipped", {
      _app_id: input._params._app_id,
      _env: input._params._env,
      _conversation_id: conversation_id,
      _message_id: message_id,
      _status: input._status,
      _error:
        _xu.is_plain_object(update_result) && _xu.is_plain_object(update_result._error)
          ? update_result._error
          : update_result,
    });
  }
}

function extract_project_memory(value: unknown): Record<string, unknown> | undefined {
  if (!_xu.is_plain_object(value)) return undefined;

  if (
    _xu.is_plain_object(value._result) &&
    _xu.is_plain_object(value._result._memory)
  ) {
    return value._result._memory;
  }

  if (_xu.is_plain_object(value._memory)) return value._memory;
  return undefined;
}

async function read_project_memory(params: PlanningCommandParams) {
  const result = await _x.execute({
    _module: "server-xvm",
    _op: "get-project-memory",
    _params: {
      _app_id: params._app_id,
      _env: params._env,
    },
  } as any);

  if (_xu.is_plain_object(result) && result._ok === false) return undefined;
  return extract_project_memory(result);
}

async function read_conversation_planning_state(
  params: PlanningCommandParams,
): Promise<XNodePlanningState | undefined> {
  if (!params._conversation_id) return undefined;

  try {
    const xvibe_state = await _x.execute({
      _module: "xvibe",
      _op: "get-conversation",
      _params: {
        _app_id: params._app_id,
        _env: params._env,
        _conversation_id: params._conversation_id,
      },
    } as any);
    const raw_plan = extract_xvibe_planning_state(xvibe_state);
    if (!_xu.is_plain_object(raw_plan)) return undefined;
    return normalize_xvibe_planning_state(raw_plan);
  } catch {
    return undefined;
  }
}

function log_readiness(
  planning: XNodePlanningState,
  context: Record<string, unknown>,
) {
  _xlog.log("[planning] readiness evaluated", {
    ...context,
    _ready: planning._ready,
    _blocker_count: planning._blockers.length,
    _warning_count: planning._warnings.length,
    _unresolved_required_decision_count:
      planning._unresolved_required_decisions.length,
    _unresolved_optional_decision_count:
      planning._unresolved_optional_decisions.length,
  });
}

export class XPlanningModule extends XModule {
  static _name = "planning";
  static _ops = XPLANNING_OPS;
  static _skill = XPLANNING_SKILL;

  constructor() {
    super({
      _name: XPlanningModule._name,
    });
  }

  async _start_planning(xcmd: XCommand) {
    try {
      const params = read_params(xcmd?._params);
      const message = read_required_string(params, "_message");

      _xlog.log("[planning] start", {
        _app_id: params._app_id,
        _env: params._env,
        _conversation_id: params._conversation_id,
      });

      const xvibe_result = await _x.execute({
        _module: "xvibe",
        _op: "analyze-message",
        _params: {
          _app_id: params._app_id,
          _env: params._env,
          _conversation_id: params._conversation_id,
          _message: message,
          _message_id: params._message_id,
          _runtime_context: normalize_runtime_context(params),
        },
      } as any);

      const planning = normalize_xvibe_planning_state(xvibe_result);
      log_readiness(planning, {
        _app_id: params._app_id,
        _env: params._env,
        _conversation_id: params._conversation_id,
        _xvibe_op: "analyze-message",
      });
      return planning_response(planning, {
        _app_id: params._app_id,
        _env: params._env,
        _conversation_id: params._conversation_id,
        _xvibe_op: "analyze-message",
      });
    } catch (err) {
      _xlog.warn("[planning] start rejected", err);
      return planning_error_response(err);
    }
  }

  async _get_planning_state(xcmd: XCommand) {
    try {
      const params = read_params(xcmd?._params);
      if (!params._conversation_id) {
        throw new XNodePlanningError(
          XNODE_PLANNING_ERR.MISSING_PLANNING_CONTEXT,
          "Missing planning context: _conversation_id is required.",
        );
      }

      _xlog.log("[planning] get state", {
        _app_id: params._app_id,
        _env: params._env,
        _conversation_id: params._conversation_id,
      });

      const xvibe_result = await _x.execute({
        _module: "xvibe",
        _op: "get-conversation",
        _params: {
          _app_id: params._app_id,
          _env: params._env,
          _conversation_id: params._conversation_id,
        },
      } as any);

      const planning = normalize_xvibe_planning_state(xvibe_result);
      log_readiness(planning, {
        _app_id: params._app_id,
        _env: params._env,
        _conversation_id: params._conversation_id,
        _xvibe_op: "get-conversation",
      });
      return planning_response(planning, {
        _app_id: params._app_id,
        _env: params._env,
        _conversation_id: params._conversation_id,
        _xvibe_op: "get-conversation",
      });
    } catch (err) {
      _xlog.warn("[planning] get state rejected", err);
      return planning_error_response(err);
    }
  }

  async _resume_planning(xcmd: XCommand) {
    return this._get_planning_state(xcmd);
  }

  async _answer_planning_question(xcmd: XCommand) {
    try {
      const params = read_params(xcmd?._params);
      assert_planning_context(params._planning_state);
      const question_id = read_required_string(params, "_question_id");
      const answer = validate_xvibe_planning_answer({
        _planning_state: params._planning_state,
        _question_id: question_id,
        _answer: params._answer,
      });

      _xlog.log("[planning] answer question", {
        _app_id: params._app_id,
        _env: params._env,
        _conversation_id: params._conversation_id,
        _question_id: question_id,
      });

      const xvibe_result = await _x.execute({
        _module: "xvibe",
        _op: "analyze-message",
        _params: {
          _app_id: params._app_id,
          _env: params._env,
          _conversation_id: params._conversation_id,
          _message:
            typeof params._message === "string" && params._message.trim()
              ? params._message.trim()
              : answer_to_message(answer),
          _runtime_context: normalize_runtime_context(params, {
            _current_project_plan: params._planning_state,
            _planning_answer: answer,
          }),
        },
      } as any);

      const planning = normalize_xvibe_planning_state(xvibe_result);
      log_readiness(planning, {
        _app_id: params._app_id,
        _env: params._env,
        _conversation_id: params._conversation_id,
        _question_id: question_id,
        _xvibe_op: "analyze-message",
      });
      return planning_response(planning, {
        _app_id: params._app_id,
        _env: params._env,
        _conversation_id: params._conversation_id,
        _question_id: question_id,
        _xvibe_op: "analyze-message",
      });
    } catch (err) {
      _xlog.warn("[planning] answer rejected", err);
      return planning_error_response(err);
    }
  }

  async _validate_planning_state(xcmd: XCommand) {
    try {
      const params = _xu.ensure_params(xcmd?._params) as Record<string, unknown>;
      if (params._planning_state === undefined) {
        throw new Error("Invalid _planning_state: expected object");
      }

      const planning = normalize_xvibe_planning_state(params._planning_state);
      log_readiness(planning, {
        _validated: true,
      });
      return planning_response(planning, {
        _validated: true,
      });
    } catch (err) {
      _xlog.warn("[planning] validate rejected", err);
      return planning_error_response(err);
    }
  }

  async _confirm_project_plan(xcmd: XCommand) {
    try {
      const params = read_params(xcmd?._params);
      let raw_plan = extract_xvibe_planning_state(
        params._planning_state ?? params._project_plan ?? params._artifact,
      );
      let confirm_plan = raw_plan;
      let source = "params";

      if (!raw_plan && params._conversation_id) {
        const xvibe_state = await _x.execute({
          _module: "xvibe",
          _op: "get-conversation",
          _params: {
            _app_id: params._app_id,
            _env: params._env,
            _conversation_id: params._conversation_id,
          },
        } as any);
        raw_plan = extract_xvibe_planning_state(xvibe_state);
        source = "conversation-draft";
      }

      if (raw_plan) {
        const planning = normalize_xvibe_planning_state(raw_plan);
        confirm_plan = planning;
        log_readiness(planning, {
          _app_id: params._app_id,
          _env: params._env,
          _conversation_id: params._conversation_id,
          _source: source,
          _xvibe_op: "confirm-project-plan",
        });

        if (!planning._ready) {
          _xlog.warn("[planning] confirmation blocked", {
            _app_id: params._app_id,
            _env: params._env,
            _conversation_id: params._conversation_id,
            _source: source,
            _blocker_count: planning._blockers.length,
            _warning_count: planning._warnings.length,
            _unresolved_required_decisions:
              planning._unresolved_required_decisions,
          });
          return planning_xerror_response(
            XNODE_PLANNING_ERR.PLANNING_INCOMPLETE,
            "Project plan draft is not ready for confirmation.",
            readiness_error_details(planning),
          );
        }
      }

      const xvibe_result = await _x.execute({
        _module: "xvibe",
        _op: "confirm-project-plan",
        _params: {
          _app_id: params._app_id,
          _env: params._env,
          _conversation_id: params._conversation_id,
          _message_id: params._message_id,
          ...(confirm_plan ? { _project_plan: confirm_plan } : {}),
        },
      } as any);

      if ((xvibe_result as any)?._ok === true) {
        const runtime_lifecycle = resolve_xnode_confirmed_runtime_lifecycle(
          extract_project_memory(xvibe_result),
        );
        _xlog.log("[planning] confirmation succeeded", {
          _app_id: params._app_id,
          _env: params._env,
          _conversation_id: params._conversation_id,
        });

        if (_xu.is_plain_object((xvibe_result as any)._result)) {
          return {
            ...(xvibe_result as any),
            _result: {
              ...(xvibe_result as any)._result,
              _runtime_lifecycle: runtime_lifecycle,
            },
            _runtime_lifecycle: runtime_lifecycle,
          };
        }
      }

      return xvibe_result;
    } catch (err) {
      if ((err as any)?._code === XNODE_PLANNING_ERR.MALFORMED_XVIBE_READINESS) {
        _xlog.error("[planning] malformed readiness output", err);
      } else {
        _xlog.warn("[planning] confirmation rejected", err);
      }
      return planning_error_response(err);
    }
  }

  async _save_planning_state() {
    return new XResponseError(
      new XNodePlanningError(
        XNODE_PLANNING_ERR.MISSING_PLANNING_CONTEXT,
        "XNode does not own XVibe planning persistence. Current planning drafts are saved by XVibe analyze-message.",
      ),
    ).toXData();
  }

  async _get_guide_recommendation(xcmd: XCommand) {
    try {
      const params = read_params(xcmd?._params);
      let project_memory: Record<string, unknown> | undefined;
      let runtime_lifecycle: XNodeRuntimeLifecycleState | undefined;

      try {
        project_memory = await read_project_memory(params);
        if (project_memory) {
          runtime_lifecycle =
            resolve_xnode_project_memory_runtime_lifecycle(project_memory);
        }
      } catch (err) {
        _xlog.warn("[planning] guide project memory unavailable", {
          _app_id: params._app_id,
          _env: params._env,
          _error: err instanceof Error ? err.message : String(err),
        });
      }

      if (!runtime_lifecycle?._guide_available) {
        const raw_plan = extract_xvibe_planning_state(
          params._planning_state ?? params._project_plan ?? params._artifact,
        );
        const planning =
          _xu.is_plain_object(raw_plan)
            ? normalize_xvibe_planning_state(raw_plan)
            : await read_conversation_planning_state(params);
        if (planning) {
          runtime_lifecycle = planning._runtime_lifecycle;
        }
      }

      runtime_lifecycle ??= resolve_xnode_planning_runtime_lifecycle({
        _planning_status: "unknown",
        _ready: false,
      });

      if (!runtime_lifecycle._guide_available) {
        _xlog.log("[planning] guide recommendation blocked before confirmation", {
          _app_id: params._app_id,
          _env: params._env,
          _conversation_id: params._conversation_id,
          _lifecycle_status: runtime_lifecycle._status,
          _lifecycle_phase: runtime_lifecycle._phase,
        });
        return guide_response({
          _recommendation: null,
          _runtime_lifecycle: runtime_lifecycle,
          _blocked_reason: "planning-not-confirmed",
          _details: {
            _app_id: params._app_id,
            _env: params._env,
            _conversation_id: params._conversation_id,
          },
        });
      }

      const xvibe_result = await _x.execute({
        _module: "xvibe",
        _op: "get-guide-recommendation",
        _params: {
          _app_id: params._app_id,
          _env: params._env,
          ...(project_memory ? { _project_memory: project_memory } : {}),
          ...(_xu.is_plain_object(params._runtime_assets)
            ? { _runtime_assets: params._runtime_assets }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(params, "_runtime_skills")
            ? { _runtime_skills: params._runtime_skills }
            : {}),
        },
      } as any);

      if (_xu.is_plain_object(xvibe_result) && xvibe_result._ok === false) {
        return xvibe_result;
      }

      const raw_recommendation =
        _xu.is_plain_object(xvibe_result) &&
          _xu.is_plain_object(xvibe_result._result)
          ? xvibe_result._result._recommendation ?? xvibe_result._recommendation ?? null
          : null;
      const recommendation =
        raw_recommendation === null || raw_recommendation === undefined
          ? null
          : clone_json_compatible(raw_recommendation, "_recommendation");
      const guide_state =
        _xu.is_plain_object(xvibe_result) &&
          _xu.is_plain_object(xvibe_result._result)
          ? clone_json_compatible(
            xvibe_result._result._guide_state ?? xvibe_result._guide_state ?? null,
            "_guide_state",
          )
          : null;
      const blocked_reason =
        !recommendation && _xu.is_plain_object(guide_state) &&
          typeof guide_state._reason === "string" &&
          guide_state._reason !== "ready"
          ? guide_state._reason
          : undefined;

      return guide_response({
        _recommendation: recommendation,
        _runtime_lifecycle: runtime_lifecycle,
        ...(blocked_reason ? { _blocked_reason: blocked_reason } : {}),
        _details: {
          _app_id: params._app_id,
          _env: params._env,
          _conversation_id: params._conversation_id,
          _xvibe_op: "get-guide-recommendation",
          ...(_xu.is_plain_object(guide_state) ? { _guide_state: guide_state } : {}),
        },
      });
    } catch (err) {
      _xlog.warn("[planning] guide recommendation rejected", err);
      return planning_error_response(err);
    }
  }

  async _execute_guide_recommendation(xcmd: XCommand) {
    try {
      const params = read_params(xcmd?._params);
      if (params._recommendation === undefined) {
        throw new XNodePlanningError(
          XNODE_PLANNING_ERR.GUIDE_RECOMMENDATION_INVALID,
          "Invalid guide recommendation: _recommendation is required.",
          { _missing_fields: ["_recommendation"] },
        );
      }

      const recommendation =
        clone_json_compatible(params._recommendation, "_recommendation");
      if (!_xu.is_plain_object(recommendation)) {
        throw new XNodePlanningError(
          XNODE_PLANNING_ERR.GUIDE_RECOMMENDATION_INVALID,
          "Invalid guide recommendation: expected object.",
          { _field: "_recommendation" },
        );
      }

      const executable =
        assert_execution_payload_supported(recommendation);

      const project_memory = await read_project_memory(params);
      const runtime_lifecycle = project_memory
        ? resolve_xnode_project_memory_runtime_lifecycle(project_memory)
        : resolve_xnode_planning_runtime_lifecycle({
          _planning_status: "unknown",
          _ready: false,
        });
      if (
        !runtime_lifecycle._guide_available ||
        !runtime_lifecycle._executable_guide_actions_available
      ) {
        _xlog.log("[planning] guide execution blocked before confirmation", {
          _app_id: params._app_id,
          _env: params._env,
          _conversation_id: params._conversation_id,
          _lifecycle_status: runtime_lifecycle._status,
          _lifecycle_phase: runtime_lifecycle._phase,
        });
        throw new XNodePlanningError(
          XNODE_PLANNING_ERR.GUIDE_PLAN_NOT_CONFIRMED,
          "Guide recommendation execution requires a confirmed project plan.",
          {
            _runtime_lifecycle: runtime_lifecycle,
            _blocked_reason: "planning-not-confirmed",
          },
        );
      }

      assert_semantic_plan_ref_current({
        _recommendation: recommendation,
        _project_memory: project_memory ?? {},
      });
      assert_payload_app_context({
        _params: params,
        _payload_params: executable._execution_payload._params,
      });

      const execution_params =
        clone_json_compatible(
          executable._execution_payload._params,
          "_action._execution_payload._params",
        ) as Record<string, unknown>;
      if (
        params._conversation_id &&
        execution_params._conversation_id === undefined
      ) {
        execution_params._conversation_id = params._conversation_id;
      }
      if (
        typeof params._message_id === "string" &&
        params._message_id.trim().length > 0 &&
        execution_params._message_id === undefined
      ) {
        execution_params._message_id = params._message_id.trim();
      }

      const command = {
        _module: executable._execution_payload._module,
        _op: executable._execution_payload._op,
        _params: execution_params,
      };

      _xlog.log("[planning] guide recommendation executing", {
        _app_id: params._app_id,
        _env: params._env,
        _conversation_id: params._conversation_id,
        _executor_route: executable._executor_route,
        _title:
          typeof recommendation._title === "string"
            ? recommendation._title
            : undefined,
      });

      const execution_result = await _x.execute(command as any);
      if (_xu.is_plain_object(execution_result) && execution_result._ok === false) {
        const cloned_failure =
          clone_json_compatible(execution_result, "_execution_result");
        await persist_guide_execution_status({
          _params: params,
          _recommendation: recommendation,
          _executor_route: executable._executor_route,
          _execution_result: cloned_failure,
          _status: "failed",
        });
        return executor_failure_response({
          _recommendation: recommendation,
          _executor_route: executable._executor_route,
          _execution_result: cloned_failure,
        });
      }

      const cloned_execution_result =
        clone_json_compatible(execution_result, "_execution_result");
      await persist_guide_execution_status({
        _params: params,
        _recommendation: recommendation,
        _executor_route: executable._executor_route,
        _execution_result: cloned_execution_result,
        _status: "done",
      });

      const refreshed_project_memory = await read_project_memory(params);
      const refreshed_lifecycle = refreshed_project_memory
        ? resolve_xnode_project_memory_runtime_lifecycle(refreshed_project_memory)
        : runtime_lifecycle;

      const next_guide_result = await _x.execute({
        _module: "xvibe",
        _op: "get-guide-recommendation",
        _params: {
          _app_id: params._app_id,
          _env: params._env,
          ...(refreshed_project_memory
            ? { _project_memory: refreshed_project_memory }
            : {}),
          ...(_xu.is_plain_object(params._runtime_assets)
            ? { _runtime_assets: params._runtime_assets }
            : {}),
          ...(Object.prototype.hasOwnProperty.call(params, "_runtime_skills")
            ? { _runtime_skills: params._runtime_skills }
            : {}),
        },
      } as any);

      const next_recommendation =
        _xu.is_plain_object(next_guide_result) &&
          _xu.is_plain_object(next_guide_result._result) &&
          next_guide_result._result._recommendation !== undefined
          ? clone_json_compatible(
            next_guide_result._result._recommendation,
            "_next_recommendation",
          )
          : _xu.is_plain_object(next_guide_result) &&
              next_guide_result._recommendation !== undefined
            ? clone_json_compatible(
              next_guide_result._recommendation,
              "_next_recommendation",
            )
            : null;
      const next_guide_state =
        _xu.is_plain_object(next_guide_result) &&
          _xu.is_plain_object(next_guide_result._result)
          ? clone_json_compatible(
            next_guide_result._result._guide_state ?? next_guide_result._guide_state ?? null,
            "_next_guide_state",
          )
          : null;

      const status = guide_execution_status(cloned_execution_result);

      return {
        _ok: true,
        _result: {
          _status: status,
          _executed: true,
          _recommendation: recommendation,
          _execution_payload: command,
          _executor_route: executable._executor_route,
          _execution_result: cloned_execution_result,
          ...(refreshed_project_memory
            ? { _project_memory: refreshed_project_memory }
            : {}),
          _next_recommendation: next_recommendation,
          _guide_state: next_guide_state,
          _runtime_lifecycle: refreshed_lifecycle,
        },
        _status: status,
        _recommendation: recommendation,
        _execution_result: cloned_execution_result,
        _next_recommendation: next_recommendation,
        _runtime_lifecycle: refreshed_lifecycle,
      };
    } catch (err) {
      _xlog.warn("[planning] guide recommendation execution rejected", err);
      return planning_error_response(err);
    }
  }
}

export default XPlanningModule;
