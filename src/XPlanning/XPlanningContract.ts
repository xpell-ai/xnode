import {
  create_xvibe_initial_planning_from_project_plan,
  evaluate_xvibe_initial_planning_confirmation_readiness,
  XVIBE_INITIAL_PLANNING_CONTRACT_VERSION,
  type XVibeInitialPlanningConfirmationReadiness,
  type XVibeInitialPlanningConfirmationSummary,
  type XVibeInitialPlanningDecisionEffect,
  type XVibeInitialPlanningDecisionSummary,
  type XVibeInitialPlanningReadinessBlocker,
  type XVibeInitialPlanningReadinessWarning,
} from "@xpell/vibe";

export const XNODE_XVIBE_PLANNING_CONTRACT_VERSION =
  XVIBE_INITIAL_PLANNING_CONTRACT_VERSION;

export const XNODE_PLANNING_ERR = {
  INVALID_XVIBE_PLANNING_RESPONSE: "E_XNODE_INVALID_XVIBE_PLANNING_RESPONSE",
  MALFORMED_XVIBE_READINESS:
    "E_XNODE_MALFORMED_XVIBE_PLANNING_READINESS",
  UNSUPPORTED_CONTRACT_VERSION:
    "E_XNODE_UNSUPPORTED_XVIBE_PLANNING_CONTRACT_VERSION",
  INVALID_QUESTION_ANSWER: "E_XNODE_INVALID_PLANNING_QUESTION_ANSWER",
  UNKNOWN_QUESTION: "E_XNODE_UNKNOWN_PLANNING_QUESTION",
  MISSING_PLANNING_CONTEXT: "E_XNODE_MISSING_PLANNING_CONTEXT",
  MALFORMED_LEGACY_STATE: "E_XNODE_MALFORMED_LEGACY_PLANNING_STATE",
  PLANNING_INCOMPLETE: "E_PLANNING_INCOMPLETE",
  GUIDE_PLAN_NOT_CONFIRMED: "E_XNODE_GUIDE_PLAN_NOT_CONFIRMED",
  GUIDE_PLAN_STALE: "E_XNODE_GUIDE_PLAN_STALE",
  GUIDE_RECOMMENDATION_INVALID: "E_XNODE_GUIDE_RECOMMENDATION_INVALID",
  GUIDE_EXECUTION_FAILED: "E_XNODE_GUIDE_EXECUTION_FAILED",
} as const;

export type XNodePlanningErrorCode =
  (typeof XNODE_PLANNING_ERR)[keyof typeof XNODE_PLANNING_ERR];

export type XNodePlanningQuestionType =
  | "single"
  | "multi"
  | "text"
  | "single_choice"
  | "multiple_choice"
  | "boolean"
  | "short_text"
  | "long_text"
  | "number"
  | "confirmation";
export type XNodePlanningAnswer = string | string[] | boolean | number;

export type XNodePlanningReadiness = {
  _ready: boolean;
  _blockers: XVibeInitialPlanningReadinessBlocker[];
  _warnings: XVibeInitialPlanningReadinessWarning[];
  _unresolved_required_decisions: string[];
  _unresolved_optional_decisions: string[];
  _confirmed_decisions: XVibeInitialPlanningDecisionSummary[];
  _inferred_assumptions: XVibeInitialPlanningDecisionSummary[];
  _decision_effects: XVibeInitialPlanningDecisionEffect[];
  _summary: XVibeInitialPlanningConfirmationSummary;
};

export type XNodeRuntimeLifecycleStatus =
  | "planning"
  | "confirmed"
  | "executing";

export type XNodeRuntimeLifecyclePhase =
  | "collecting-decisions"
  | "ready-for-confirmation"
  | "confirmed"
  | "building";

export type XNodeRuntimeLifecycleState = {
  _status: XNodeRuntimeLifecycleStatus;
  _phase: XNodeRuntimeLifecyclePhase;
  _planning_status?: string;
  _project_stage?: string;
  _plan_ready: boolean;
  _confirmed: boolean;
  _guide_available: boolean;
  _executable_guide_actions_available: boolean;
};

export type XNodePlanningQuestion = {
  _id: string;
  _type: XNodePlanningQuestionType;
  _question: string;
  _options: string[];
  _required: boolean;
  _answer: XNodePlanningAnswer | null;
  _metadata?: Record<string, unknown>;
};

export type XNodePlanningState = Record<string, unknown> & {
  _contract_version: typeof XNODE_XVIBE_PLANNING_CONTRACT_VERSION;
  _type: "project-plan";
  _stage: "planning";
  _status: string;
  _questions: XNodePlanningQuestion[];
  _answers: Record<string, XNodePlanningAnswer>;
  _unanswered: string[];
  _current_question: XNodePlanningQuestion | null;
  _proposed: {
    _entities: unknown[];
    _views: unknown[];
    _flows: unknown[];
    _server_modules: unknown[];
  };
  _metadata: Record<string, unknown>;
  _runtime_lifecycle: XNodeRuntimeLifecycleState;
  _compatibility?: {
    _legacy_project_plan?: boolean;
    _mapped_fields: string[];
  };
} & XNodePlanningReadiness;

export class XNodePlanningError extends Error {
  _ok = false;
  _code: XNodePlanningErrorCode;
  _details: Record<string, unknown>;

  constructor(
    code: XNodePlanningErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "XNodePlanningError";
    this._code = code;
    this._details = details;
  }

  toXData() {
    return {
      _ok: false,
      _error: {
        _code: this._code,
        _message: this.message,
        _details: this._details,
      },
    };
  }
}

function is_plain_object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clone_json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function planning_error(
  code: XNodePlanningErrorCode,
  message: string,
  details: Record<string, unknown> = {},
): XNodePlanningError {
  return new XNodePlanningError(code, message, details);
}

function read_normalized_string(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized.length > 0 ? normalized : undefined;
}

function normalize_string_array(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  const result: string[] = [];
  for (const item of value) {
    const normalized = read_normalized_string(item);
    if (normalized && !result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function normalize_question_options(value: unknown): {
  _options: string[];
  _semantic_options?: { _id: string; _label: string }[];
} {
  if (!Array.isArray(value)) return { _options: [] };

  const options: string[] = [];
  const semantic_options: { _id: string; _label: string }[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const label = read_normalized_string(item);
      if (label && !options.includes(label)) options.push(label);
      continue;
    }

    if (!is_plain_object(item)) continue;
    const id = read_normalized_string(item._id);
    const label = read_normalized_string(item._label);
    if (!id || !label) continue;
    if (!options.includes(label)) options.push(label);
    if (!semantic_options.some((option) => option._id === id)) {
      semantic_options.push({ _id: id, _label: label });
    }
  }

  return {
    _options: options,
    ...(semantic_options.length > 0 ? { _semantic_options: semantic_options } : {}),
  };
}

function normalize_optional_array(value: unknown): unknown[] {
  return Array.isArray(value) ? clone_json(value) : [];
}

function read_question_type(value: unknown): XNodePlanningQuestionType | undefined {
  return value === "single" ||
    value === "multi" ||
    value === "text" ||
    value === "single_choice" ||
    value === "multiple_choice" ||
    value === "boolean" ||
    value === "short_text" ||
    value === "long_text" ||
    value === "number" ||
    value === "confirmation"
    ? value
    : undefined;
}

function read_answer_value(value: unknown): unknown {
  return is_plain_object(value) && "_value" in value
    ? value._value
    : value;
}

function semantic_options_for(
  question: Pick<XNodePlanningQuestion, "_metadata">,
): { _id: string; _label: string }[] {
  const value = question._metadata?._semantic_options;
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is { _id: string; _label: string } =>
    is_plain_object(item) &&
    typeof item._id === "string" &&
    typeof item._label === "string"
  );
}

function canonical_option(
  question: Pick<XNodePlanningQuestion, "_options" | "_metadata">,
  value: unknown,
): string | undefined {
  const normalized = read_normalized_string(value);
  if (!normalized) return undefined;

  const options = question._options;
  if (options.length === 0) return normalized;

  const exact = options.find((option) => option === normalized);
  if (exact) return exact;

  const lower = normalized.toLocaleLowerCase();
  const label = options.find((option) => option.toLocaleLowerCase() === lower);
  if (label) return label;

  const semantic_option = semantic_options_for(question).find((option) =>
    option._id.toLocaleLowerCase() === lower ||
    option._label.toLocaleLowerCase() === lower
  );
  return semantic_option?._label;
}

function validate_answer_value(
  question: Pick<XNodePlanningQuestion, "_id" | "_type" | "_options">,
  value: unknown,
  source: string,
): XNodePlanningAnswer | undefined {
  if (value === undefined || value === null) return undefined;
  const answer_value = read_answer_value(value);

  if (
    question._type === "text" ||
    question._type === "short_text" ||
    question._type === "long_text"
  ) {
    const text = read_normalized_string(answer_value);
    if (text) return text;

    throw planning_error(
      XNODE_PLANNING_ERR.INVALID_QUESTION_ANSWER,
      "Invalid planning answer: expected non-empty text.",
      { _question_id: question._id, _source: source },
    );
  }

  if (question._type === "boolean") {
    if (typeof answer_value === "boolean") return answer_value;
    throw planning_error(
      XNODE_PLANNING_ERR.INVALID_QUESTION_ANSWER,
      "Invalid planning answer: expected boolean.",
      { _question_id: question._id, _source: source },
    );
  }

  if (question._type === "number") {
    if (typeof answer_value === "number" && Number.isFinite(answer_value)) {
      return answer_value;
    }
    throw planning_error(
      XNODE_PLANNING_ERR.INVALID_QUESTION_ANSWER,
      "Invalid planning answer: expected finite number.",
      { _question_id: question._id, _source: source },
    );
  }

  if (question._type === "confirmation" && question._options.length === 0) {
    if (Array.isArray(answer_value)) {
      throw planning_error(
        XNODE_PLANNING_ERR.INVALID_QUESTION_ANSWER,
        "Invalid planning answer: confirmation question accepts one answer.",
        { _question_id: question._id, _source: source },
      );
    }
    if (typeof answer_value === "boolean" || typeof answer_value === "number") {
      return answer_value;
    }
    const text = read_normalized_string(answer_value);
    if (text) return text;
    throw planning_error(
      XNODE_PLANNING_ERR.INVALID_QUESTION_ANSWER,
      "Invalid planning answer: missing confirmation answer.",
      { _question_id: question._id, _source: source },
    );
  }

  const raw_values = Array.isArray(answer_value) ? answer_value : [answer_value];
  const answers: string[] = [];
  for (const raw_value of raw_values) {
    const answer = canonical_option(question, raw_value);
    if (!answer || !question._options.includes(answer)) {
      throw planning_error(
        XNODE_PLANNING_ERR.INVALID_QUESTION_ANSWER,
        "Invalid planning answer: answer is not one of the question options.",
        {
          _question_id: question._id,
          _source: source,
          _answer: raw_value,
          _options: question._options,
        },
      );
    }
    if (!answers.includes(answer)) answers.push(answer);
  }

  if (answers.length === 0) return undefined;

  if (
    question._type === "single" ||
    question._type === "single_choice" ||
    question._type === "confirmation"
  ) {
    if (answers.length > 1) {
      throw planning_error(
        XNODE_PLANNING_ERR.INVALID_QUESTION_ANSWER,
        "Invalid planning answer: single-choice question accepts one answer.",
        { _question_id: question._id, _source: source, _answers: answers },
      );
    }
    return answers[0];
  }

  return answers;
}

function normalize_question(raw_question: unknown): XNodePlanningQuestion {
  if (!is_plain_object(raw_question)) {
    throw planning_error(
      XNODE_PLANNING_ERR.INVALID_XVIBE_PLANNING_RESPONSE,
      "Malformed planning question: expected object.",
    );
  }

  const id = read_normalized_string(raw_question._id);
  const text = read_normalized_string(raw_question._question);
  const type = read_question_type(raw_question._type);
  if (!id || !text || !type) {
    throw planning_error(
      XNODE_PLANNING_ERR.INVALID_XVIBE_PLANNING_RESPONSE,
      "Malformed planning question: missing _id, _type, or _question.",
      {
        _id: raw_question._id,
        _type: raw_question._type,
        _has_question: typeof raw_question._question === "string",
      },
    );
  }

  const normalized_options = normalize_question_options(
    Array.isArray(raw_question._options)
      ? raw_question._options
      : raw_question._suggestions,
  );
  const options = normalized_options._options;
  if (
    (
      type === "single" ||
      type === "multi" ||
      type === "single_choice" ||
      type === "multiple_choice"
    ) &&
    options.length === 0
  ) {
    throw planning_error(
      XNODE_PLANNING_ERR.INVALID_XVIBE_PLANNING_RESPONSE,
      "Malformed planning question: choice questions require _options.",
      { _question_id: id },
    );
  }

  const question: XNodePlanningQuestion = {
    _id: id,
    _type: type,
    _question: text,
    _options: options,
    _required:
      typeof raw_question._required === "boolean"
        ? raw_question._required
        : true,
    _answer: null,
    ...(is_plain_object(raw_question._metadata) ||
      normalized_options._semantic_options
      ? {
        _metadata: {
          ...(is_plain_object(raw_question._metadata)
            ? clone_json(raw_question._metadata)
            : {}),
          ...(normalized_options._semantic_options
            ? {
              _semantic_options: clone_json(
                normalized_options._semantic_options,
              ),
            }
            : {}),
        },
      }
      : {}),
  };

  const answer = validate_answer_value(question, raw_question._answer, "question");
  question._answer = answer ?? null;

  return question;
}

function ensure_unique_ids(
  values: string[],
  field: string,
): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }

  if (duplicates.size > 0) {
    throw planning_error(
      XNODE_PLANNING_ERR.INVALID_XVIBE_PLANNING_RESPONSE,
      `Invalid planning response: duplicate ${field}.`,
      { _duplicates: Array.from(duplicates) },
    );
  }
}

function item_id(value: unknown): string | undefined {
  return is_plain_object(value) ? read_normalized_string(value._id) : undefined;
}

function ensure_unique_item_ids(items: unknown[], field: string): void {
  const ids = items.map(item_id).filter((id): id is string => id !== undefined);
  ensure_unique_ids(ids, field);
}

function normalize_status(value: unknown): string {
  const status = read_normalized_string(value);
  if (!status) {
    throw planning_error(
      XNODE_PLANNING_ERR.INVALID_XVIBE_PLANNING_RESPONSE,
      "Invalid planning response: missing _status.",
    );
  }

  return status;
}

function is_collecting_status(status: string): boolean {
  return status === "awaiting-answer" || status === "collecting-information";
}

function is_complete_status(status: string): boolean {
  return status === "complete" ||
    status === "ready-for-confirmation" ||
    status === "ready-to-confirm" ||
    status === "confirmed";
}

function read_project_stage(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const normalized = value.trim().toLowerCase();
  return normalized === "planning" ||
    normalized === "building" ||
    normalized === "review" ||
    normalized === "completed"
    ? normalized
    : undefined;
}

export function resolve_xnode_planning_runtime_lifecycle(input: {
  _planning_status?: string;
  _ready: boolean;
}): XNodeRuntimeLifecycleState {
  return {
    _status: "planning",
    _phase: input._ready
      ? "ready-for-confirmation"
      : "collecting-decisions",
    ...(input._planning_status
      ? { _planning_status: input._planning_status }
      : {}),
    _plan_ready: input._ready,
    _confirmed: false,
    _guide_available: false,
    _executable_guide_actions_available: false,
  };
}

export function resolve_xnode_confirmed_runtime_lifecycle(
  project_memory?: unknown,
): XNodeRuntimeLifecycleState {
  const memory = is_plain_object(project_memory) ? project_memory : {};
  const project_stage = read_project_stage(memory._stage);

  return {
    _status: "confirmed",
    _phase: "confirmed",
    ...(project_stage ? { _project_stage: project_stage } : {}),
    _plan_ready: true,
    _confirmed: true,
    _guide_available: true,
    _executable_guide_actions_available: true,
  };
}

export function resolve_xnode_project_memory_runtime_lifecycle(
  project_memory: unknown,
): XNodeRuntimeLifecycleState {
  const memory = is_plain_object(project_memory) ? project_memory : {};
  const project_stage = read_project_stage(memory._stage);
  const has_confirmed_plan = is_plain_object(memory._confirmed_initial_plan);

  if (has_confirmed_plan) {
    const executing = project_stage === "building";
    return {
      _status: executing ? "executing" : "confirmed",
      _phase: executing ? "building" : "confirmed",
      ...(project_stage ? { _project_stage: project_stage } : {}),
      _plan_ready: true,
      _confirmed: true,
      _guide_available: true,
      _executable_guide_actions_available: true,
    };
  }

  return {
    _status: "planning",
    _phase: "collecting-decisions",
    ...(project_stage ? { _project_stage: project_stage } : {}),
    _plan_ready: false,
    _confirmed: false,
    _guide_available: false,
    _executable_guide_actions_available: false,
  };
}

function extract_current_question_id(value: unknown): string | undefined {
  if (!is_plain_object(value)) return undefined;
  return read_normalized_string(value._id) ??
    read_normalized_string(value._question_id);
}

function normalize_current_question(
  raw_current_question: unknown,
  questions_by_id: Map<string, XNodePlanningQuestion>,
): XNodePlanningQuestion | null {
  if (raw_current_question === undefined || raw_current_question === null) {
    return null;
  }

  const id = extract_current_question_id(raw_current_question);
  if (!id || !questions_by_id.has(id)) {
    throw planning_error(
      XNODE_PLANNING_ERR.INVALID_XVIBE_PLANNING_RESPONSE,
      "Invalid planning response: _current_question does not match a question.",
      { _current_question_id: id ?? null },
    );
  }

  return clone_json(questions_by_id.get(id)!);
}

function normalize_answers(
  raw_answers: unknown,
  questions_by_id: Map<string, XNodePlanningQuestion>,
): Record<string, XNodePlanningAnswer> {
  const answers: Record<string, XNodePlanningAnswer> = {};

  if (is_plain_object(raw_answers)) {
    for (const [question_id, raw_answer] of Object.entries(raw_answers)) {
      const question = questions_by_id.get(question_id);
      if (!question) {
        throw planning_error(
          XNODE_PLANNING_ERR.UNKNOWN_QUESTION,
          "Planning answer references an unknown question.",
          { _question_id: question_id },
        );
      }

      const answer = validate_answer_value(question, raw_answer, "answers");
      if (answer !== undefined) answers[question_id] = answer;
    }
  }

  for (const question of questions_by_id.values()) {
    if (answers[question._id] !== undefined || question._answer === null) {
      continue;
    }
    answers[question._id] = clone_json(question._answer);
  }

  return answers;
}

function normalize_unanswered(
  raw_unanswered: unknown,
  questions: XNodePlanningQuestion[],
  answers: Record<string, XNodePlanningAnswer>,
): string[] {
  const question_ids = new Set(questions.map((question) => question._id));
  const unanswered = Array.isArray(raw_unanswered)
    ? normalize_string_array(raw_unanswered)
    : questions
      .filter((question) => question._required && answers[question._id] === undefined)
      .map((question) => question._id);

  for (const question_id of unanswered) {
    if (!question_ids.has(question_id)) {
      throw planning_error(
        XNODE_PLANNING_ERR.UNKNOWN_QUESTION,
        "Planning _unanswered references an unknown question.",
        { _question_id: question_id },
      );
    }
  }

  ensure_unique_ids(unanswered, "_unanswered ids");
  return unanswered;
}

function normalize_proposed(raw_proposed: unknown) {
  const proposed = is_plain_object(raw_proposed) ? raw_proposed : {};
  const result = {
    _entities: normalize_optional_array(proposed._entities),
    _views: normalize_optional_array(proposed._views),
    _flows: normalize_optional_array(proposed._flows),
    _server_modules: normalize_optional_array(proposed._server_modules),
  };

  ensure_unique_item_ids(result._entities, "_proposed._entities ids");
  ensure_unique_item_ids(result._views, "_proposed._views ids");
  ensure_unique_item_ids(result._flows, "_proposed._flows ids");
  ensure_unique_item_ids(result._server_modules, "_proposed._server_modules ids");

  return result;
}

function prepare_xvibe_planning_input(
  raw_plan: Record<string, unknown>,
): Record<string, unknown> {
  const plan = clone_json(raw_plan);
  if (!Array.isArray(plan._questions)) return plan;

  plan._questions = plan._questions.map((question) => {
    if (
      !is_plain_object(question) ||
      Array.isArray(question._options) ||
      !Array.isArray(question._suggestions)
    ) {
      return question;
    }

    return {
      ...question,
      _options: clone_json(question._suggestions),
    };
  });

  return plan;
}

function validate_lifecycle(input: {
  status: string;
  current_question: XNodePlanningQuestion | null;
  unanswered: string[];
  answers: Record<string, XNodePlanningAnswer>;
  questions: XNodePlanningQuestion[];
}): void {
  if (is_collecting_status(input.status)) {
    if (!input.current_question) {
      throw planning_error(
        XNODE_PLANNING_ERR.INVALID_XVIBE_PLANNING_RESPONSE,
        "Invalid planning response: collecting state requires _current_question.",
        { _status: input.status },
      );
    }
    if (input.unanswered[0] !== input.current_question._id) {
      throw planning_error(
        XNODE_PLANNING_ERR.INVALID_XVIBE_PLANNING_RESPONSE,
        "Invalid planning response: _current_question must match first _unanswered question.",
        {
          _status: input.status,
          _current_question_id: input.current_question._id,
          _first_unanswered: input.unanswered[0] ?? null,
        },
      );
    }
  }

  if (is_complete_status(input.status)) {
    if (input.current_question) {
      throw planning_error(
        XNODE_PLANNING_ERR.INVALID_XVIBE_PLANNING_RESPONSE,
        "Invalid planning response: completed state cannot have _current_question.",
        { _status: input.status },
      );
    }
    if (input.unanswered.length > 0) {
      throw planning_error(
        XNODE_PLANNING_ERR.INVALID_XVIBE_PLANNING_RESPONSE,
        "Invalid planning response: completed state cannot have _unanswered questions.",
        { _status: input.status, _unanswered: input.unanswered },
      );
    }
  }

  for (const question of input.questions) {
    if (
      question._required &&
      is_complete_status(input.status) &&
      input.answers[question._id] === undefined
    ) {
      throw planning_error(
        XNODE_PLANNING_ERR.INVALID_XVIBE_PLANNING_RESPONSE,
        "Invalid planning response: completed state has missing required answers.",
        { _question_id: question._id, _status: input.status },
      );
    }
  }
}

function assert_string_array(value: unknown, field: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw planning_error(
      XNODE_PLANNING_ERR.MALFORMED_XVIBE_READINESS,
      `Malformed XVibe readiness response: ${field} must be a string array.`,
      { _field: field },
    );
  }
}

function assert_readiness_items(
  value: unknown,
  field: string,
): asserts value is Array<Record<string, unknown>> {
  if (!Array.isArray(value)) {
    throw planning_error(
      XNODE_PLANNING_ERR.MALFORMED_XVIBE_READINESS,
      `Malformed XVibe readiness response: ${field} must be an array.`,
      { _field: field },
    );
  }

  for (const item of value) {
    if (
      !is_plain_object(item) ||
      typeof item._id !== "string" ||
      typeof item._message !== "string" ||
      typeof item._section !== "string" ||
      (item._question_id !== undefined && typeof item._question_id !== "string")
    ) {
      throw planning_error(
        XNODE_PLANNING_ERR.MALFORMED_XVIBE_READINESS,
        `Malformed XVibe readiness response: invalid ${field} item.`,
        { _field: field },
      );
    }
  }
}

function assert_decision_summaries(
  value: unknown,
  field: string,
): asserts value is XVibeInitialPlanningDecisionSummary[] {
  if (!Array.isArray(value)) {
    throw planning_error(
      XNODE_PLANNING_ERR.MALFORMED_XVIBE_READINESS,
      `Malformed XVibe readiness response: ${field} must be an array.`,
      { _field: field },
    );
  }

  for (const item of value) {
    if (
      !is_plain_object(item) ||
      typeof item._id !== "string" ||
      typeof item._label !== "string" ||
      typeof item._state !== "string" ||
      !Array.isArray(item._affected_plan_sections)
    ) {
      throw planning_error(
        XNODE_PLANNING_ERR.MALFORMED_XVIBE_READINESS,
        `Malformed XVibe readiness response: invalid ${field} item.`,
        { _field: field },
      );
    }
    assert_string_array(item._affected_plan_sections, `${field}._affected_plan_sections`);
  }
}

function assert_decision_effects(
  value: unknown,
): asserts value is XVibeInitialPlanningDecisionEffect[] {
  if (!Array.isArray(value)) {
    throw planning_error(
      XNODE_PLANNING_ERR.MALFORMED_XVIBE_READINESS,
      "Malformed XVibe readiness response: _decision_effects must be an array.",
      { _field: "_decision_effects" },
    );
  }

  for (const item of value) {
    if (
      !is_plain_object(item) ||
      typeof item._decision_id !== "string" ||
      typeof item._question_id !== "string" ||
      typeof item._state !== "string" ||
      !Array.isArray(item._affected_plan_sections)
    ) {
      throw planning_error(
        XNODE_PLANNING_ERR.MALFORMED_XVIBE_READINESS,
        "Malformed XVibe readiness response: invalid _decision_effects item.",
        { _field: "_decision_effects" },
      );
    }
    assert_string_array(
      item._affected_plan_sections,
      "_decision_effects._affected_plan_sections",
    );
  }
}

function assert_readiness_summary(
  value: unknown,
): asserts value is XVibeInitialPlanningConfirmationSummary {
  if (
    !is_plain_object(value) ||
    typeof value._goal !== "string" ||
    typeof value._scope !== "string" ||
    typeof value._archetype !== "string"
  ) {
    throw planning_error(
      XNODE_PLANNING_ERR.MALFORMED_XVIBE_READINESS,
      "Malformed XVibe readiness response: invalid _summary.",
      { _field: "_summary" },
    );
  }

  assert_decision_summaries(value._confirmed_decisions, "_summary._confirmed_decisions");
  assert_decision_summaries(value._inferred_assumptions, "_summary._inferred_assumptions");
  assert_string_array(value._proposed_entities, "_summary._proposed_entities");
  assert_string_array(value._proposed_views, "_summary._proposed_views");
  assert_string_array(value._proposed_flows, "_summary._proposed_flows");
  assert_string_array(value._capabilities, "_summary._capabilities");
  assert_string_array(value._milestones, "_summary._milestones");
  assert_string_array(value._warnings, "_summary._warnings");
  assert_string_array(value._blockers, "_summary._blockers");
}

export function validate_xvibe_planning_readiness(
  value: unknown,
): XVibeInitialPlanningConfirmationReadiness {
  if (
    !is_plain_object(value) ||
    value._type !== "xvibe-initial-planning-confirmation-readiness" ||
    typeof value._ready !== "boolean"
  ) {
    throw planning_error(
      XNODE_PLANNING_ERR.MALFORMED_XVIBE_READINESS,
      "Malformed XVibe readiness response: expected readiness object.",
    );
  }

  assert_readiness_items(value._blockers, "_blockers");
  assert_readiness_items(value._warnings, "_warnings");
  assert_string_array(
    value._unresolved_required_decisions,
    "_unresolved_required_decisions",
  );
  assert_string_array(
    value._unresolved_optional_decisions,
    "_unresolved_optional_decisions",
  );
  assert_decision_summaries(value._confirmed_decisions, "_confirmed_decisions");
  assert_decision_summaries(value._inferred_assumptions, "_inferred_assumptions");
  assert_decision_effects(value._decision_effects);
  assert_readiness_summary(value._summary);

  const normalized_plan = value._normalized_plan;
  if (!is_plain_object(normalized_plan)) {
    throw planning_error(
      XNODE_PLANNING_ERR.MALFORMED_XVIBE_READINESS,
      "Malformed XVibe readiness response: missing _normalized_plan.",
      { _field: "_normalized_plan" },
    );
  }

  return clone_json(value) as XVibeInitialPlanningConfirmationReadiness;
}

function readiness_transport_fields(
  readiness: XVibeInitialPlanningConfirmationReadiness,
): XNodePlanningReadiness {
  return {
    _ready: readiness._ready,
    _blockers: clone_json(readiness._blockers),
    _warnings: clone_json(readiness._warnings),
    _unresolved_required_decisions: clone_json(
      readiness._unresolved_required_decisions,
    ),
    _unresolved_optional_decisions: clone_json(
      readiness._unresolved_optional_decisions,
    ),
    _confirmed_decisions: clone_json(readiness._confirmed_decisions),
    _inferred_assumptions: clone_json(readiness._inferred_assumptions),
    _decision_effects: clone_json(readiness._decision_effects),
    _summary: clone_json(readiness._summary),
  };
}

export function evaluate_xvibe_planning_readiness(
  raw_value: unknown,
): XVibeInitialPlanningConfirmationReadiness {
  const raw_plan = extract_xvibe_planning_state(raw_value);
  const xvibe_input = is_plain_object(raw_plan)
    ? prepare_xvibe_planning_input(raw_plan)
    : raw_plan;
  return validate_xvibe_planning_readiness(
    evaluate_xvibe_initial_planning_confirmation_readiness(
      xvibe_input,
    ),
  );
}

export function extract_xvibe_planning_state(value: unknown): unknown {
  if (!is_plain_object(value)) return value;

  if (
    is_plain_object(value._intent) &&
    value._intent._artifact_type === "project-plan"
  ) {
    return value._intent._artifact_request;
  }

  if (
    is_plain_object(value._result) &&
    is_plain_object(value._result._intent) &&
    value._result._intent._artifact_type === "project-plan"
  ) {
    return value._result._intent._artifact_request;
  }

  if (
    is_plain_object(value._result) &&
    is_plain_object(value._result._conversation) &&
    is_plain_object(value._result._conversation._planning_draft)
  ) {
    return value._result._conversation._planning_draft;
  }

  if (
    is_plain_object(value._conversation) &&
    is_plain_object(value._conversation._planning_draft)
  ) {
    return value._conversation._planning_draft;
  }

  if (is_plain_object(value._planning_draft)) return value._planning_draft;
  if (is_plain_object(value._planning)) return value._planning;

  return value;
}

export function normalize_xvibe_planning_state(
  raw_value: unknown,
): XNodePlanningState {
  const raw_plan = extract_xvibe_planning_state(raw_value);
  if (!is_plain_object(raw_plan)) {
    throw planning_error(
      XNODE_PLANNING_ERR.INVALID_XVIBE_PLANNING_RESPONSE,
      "Invalid XVibe planning response: expected project-plan object.",
    );
  }

  const raw_version = raw_plan._contract_version;
  const is_legacy = raw_version === undefined || raw_version === null;
  if (!is_legacy && raw_version !== XNODE_XVIBE_PLANNING_CONTRACT_VERSION) {
    throw planning_error(
      XNODE_PLANNING_ERR.UNSUPPORTED_CONTRACT_VERSION,
      "Unsupported XVibe planning contract version.",
      {
        _contract_version: raw_version,
        _supported: XNODE_XVIBE_PLANNING_CONTRACT_VERSION,
      },
    );
  }

  if (
    raw_plan._type !== "project-plan" ||
    (raw_plan._stage !== undefined && raw_plan._stage !== "planning")
  ) {
    throw planning_error(
      is_legacy
        ? XNODE_PLANNING_ERR.MALFORMED_LEGACY_STATE
        : XNODE_PLANNING_ERR.INVALID_XVIBE_PLANNING_RESPONSE,
      "Invalid XVibe planning response: expected planning project-plan.",
      { _type: raw_plan._type, _stage: raw_plan._stage },
    );
  }

  if (!Array.isArray(raw_plan._questions)) {
    throw planning_error(
      is_legacy
        ? XNODE_PLANNING_ERR.MALFORMED_LEGACY_STATE
        : XNODE_PLANNING_ERR.INVALID_XVIBE_PLANNING_RESPONSE,
      "Invalid XVibe planning response: _questions must be an array.",
    );
  }

  const xvibe_input = prepare_xvibe_planning_input(raw_plan);
  const semantic_plan = create_xvibe_initial_planning_from_project_plan({
    _project_plan: xvibe_input,
  });

  const readiness = evaluate_xvibe_planning_readiness(xvibe_input);
  const questions = semantic_plan._questions.map(normalize_question);
  ensure_unique_ids(
    questions.map((question) => question._id),
    "_questions ids",
  );
  const questions_by_id = new Map(
    questions.map((question) => [question._id, question] as const),
  );
  const answers = normalize_answers(semantic_plan._answers, questions_by_id);
  const unanswered = normalize_unanswered(
    semantic_plan._unanswered_required_question_ids,
    questions,
    answers,
  );
  const current_question = normalize_current_question(
    semantic_plan._current_question,
    questions_by_id,
  );
  const status = normalize_status(semantic_plan._status);
  const proposed = normalize_proposed(semantic_plan._proposed);

  validate_lifecycle({
    status,
    current_question,
    unanswered,
    answers,
    questions,
  });

  const mapped_fields: string[] = [];
  for (const question of raw_plan._questions) {
    if (
      is_plain_object(question) &&
      !Array.isArray(question._options) &&
      Array.isArray(question._suggestions)
    ) {
      mapped_fields.push("_questions._suggestions->_options");
      break;
    }
  }
  if (is_legacy) mapped_fields.push("missing _contract_version->1");

  const runtime_lifecycle = resolve_xnode_planning_runtime_lifecycle({
    _planning_status: status,
    _ready: readiness._ready,
  });

  return {
    ...clone_json(semantic_plan),
    _contract_version: XNODE_XVIBE_PLANNING_CONTRACT_VERSION,
    _type: "project-plan",
    _stage: "planning",
    _status: status,
    ...(typeof raw_plan._domain !== "string" ? { _domain: undefined } : {}),
    _questions: questions,
    _answers: answers,
    _unanswered: unanswered,
    _current_question: current_question,
    _proposed: proposed,
    _metadata: is_plain_object(raw_plan._metadata)
      ? clone_json(raw_plan._metadata)
      : {},
    _runtime_lifecycle: runtime_lifecycle,
    ...readiness_transport_fields(readiness),
    ...(mapped_fields.length > 0
      ? {
        _compatibility: {
          _legacy_project_plan: is_legacy,
          _mapped_fields: mapped_fields,
        },
      }
      : {}),
  };
}

export function validate_xvibe_planning_answer(input: {
  _planning_state: unknown;
  _question_id: unknown;
  _answer: unknown;
}): XNodePlanningAnswer {
  const planning_state = normalize_xvibe_planning_state(input._planning_state);
  const question_id = read_normalized_string(input._question_id);
  if (!question_id) {
    throw planning_error(
      XNODE_PLANNING_ERR.UNKNOWN_QUESTION,
      "Missing planning question id.",
    );
  }

  const question = planning_state._questions.find(
    (candidate) => candidate._id === question_id,
  );
  if (!question) {
    throw planning_error(
      XNODE_PLANNING_ERR.UNKNOWN_QUESTION,
      "Unknown planning question.",
      { _question_id: question_id },
    );
  }

  const answer = validate_answer_value(question, input._answer, "input");
  if (answer === undefined) {
    throw planning_error(
      XNODE_PLANNING_ERR.INVALID_QUESTION_ANSWER,
      "Invalid planning answer: missing answer value.",
      { _question_id: question_id },
    );
  }

  return answer;
}

export function assert_planning_context(value: unknown): asserts value is Record<string, unknown> {
  if (!is_plain_object(value)) {
    throw planning_error(
      XNODE_PLANNING_ERR.MISSING_PLANNING_CONTEXT,
      "Missing planning context.",
    );
  }
}
