import { _xlog, _xu } from "@xpell/core";
import type {
  XVibeIntentEngineRequest,
  XVibeIntentResult,
  XVibeProjectMemory,
} from "../XVibeTypes.js";
import { ConversationManager } from "../Conversation/ConversationManager.js";
import type { XVibeIntentProcessor } from "./XVibeIntentProcessor.js";

type PlanningQuestionType = "single" | "multi" | "text";
type PlanningAnswer = string | string[];

type PlanningQuestion = {
  _id: string;
  _type: PlanningQuestionType;
  _question: string;
  _options: string[];
  _required: boolean;
  _answer: PlanningAnswer | null;
};

type ProjectPlanArtifact = Record<string, any> & {
  _type: "project-plan";
  _stage: "planning";
  _questions: PlanningQuestion[];
  _answers?: Record<string, PlanningAnswer>;
  _unanswered?: string[];
};

const QUESTION_TYPES: Record<string, PlanningQuestionType> = {
  primary_user: "multi",
  core_entities: "multi",
  ai_capabilities: "multi",
  notification_capabilities: "multi",
  reporting_capabilities: "multi",
  integration_capabilities: "multi",
  first_workflow: "single",
  authentication: "multi",
  customer_ownership: "single",
  company_contact_relationship: "single",
  follow_up_tasks: "multi",
};

const SUPPORTED_QUESTION_IDS = new Set([
  "primary_user",
  "core_entities",
  "ai_capabilities",
  "notification_capabilities",
  "reporting_capabilities",
  "integration_capabilities",
  "first_workflow",
  "authentication",
  "customer_ownership",
  "company_contact_relationship",
  "follow_up_tasks",
]);

const CRM_ADAPTIVE_QUESTIONS: readonly PlanningQuestion[] = [
  {
    _id: "customer_ownership",
    _type: "single",
    _question: "Who owns customer records?",
    _options: ["Sales", "Account managers", "Support", "Shared team", "Other"],
    _required: true,
    _answer: null,
  },
  {
    _id: "company_contact_relationship",
    _type: "single",
    _question: "How should companies and contacts relate?",
    _options: [
      "Company has many contacts",
      "Contacts are standalone",
      "Both company and individual customers",
      "Other",
    ],
    _required: true,
    _answer: null,
  },
  {
    _id: "follow_up_tasks",
    _type: "multi",
    _question: "Which follow-up/task capabilities are required?",
    _options: ["Tasks", "Reminders", "Notes", "Email follow-up", "Other"],
    _required: true,
    _answer: null,
  },
];

function clone_json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function read_project_memory(
  request: XVibeIntentEngineRequest,
): Partial<XVibeProjectMemory> {
  const memory = request._runtime_context._project_memory;
  return _xu.is_plain_object(memory) ? memory : {};
}

function read_stage(request: XVibeIntentEngineRequest): string {
  const memory = read_project_memory(request);
  if (typeof memory._stage === "string") return memory._stage;
  if (typeof request._runtime_context._stage === "string") {
    return request._runtime_context._stage;
  }

  return "";
}

function read_conversation_id(request: XVibeIntentEngineRequest): string | undefined {
  if (
    typeof request._conversation_id === "string" &&
    request._conversation_id.trim().length > 0
  ) {
    return request._conversation_id.trim();
  }

  const context_conversation_id =
    request._runtime_context._conversation_id;
  return typeof context_conversation_id === "string" &&
    context_conversation_id.trim().length > 0
    ? context_conversation_id.trim()
    : undefined;
}

function may_start_planning(message: string): boolean {
  return /\b(?:i\s+want\s+to\s+build|want\s+to\s+build|build\s+(?:an?\s+)?(?:app|application|system)|plan|design|outline|scope|blueprint)\b/iu
    .test(message);
}

function may_be_direct_build_command(message: string): boolean {
  return /^\s*(?:create|add|make|rename|delete|deprecate|restore)\b/iu
    .test(message);
}

function normalize_option(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized.length > 0 ? normalized : undefined;
}

function read_options(raw_question: Record<string, any>): string[] {
  const raw_options = Array.isArray(raw_question._options)
    ? raw_question._options
    : Array.isArray(raw_question._suggestions)
      ? raw_question._suggestions
      : [];

  const options: string[] = [];
  for (const raw_option of raw_options) {
    const option = normalize_option(raw_option);
    if (option && !options.includes(option)) {
      options.push(option);
    }
  }

  return options;
}

function is_question_type(value: unknown): value is PlanningQuestionType {
  return value === "single" || value === "multi" || value === "text";
}

function normalize_stored_answer(
  question: Pick<PlanningQuestion, "_type" | "_options">,
  value: unknown,
): PlanningAnswer | undefined {
  if (Array.isArray(value)) {
    const answers = value
      .map((item) => canonical_option(question._options, item))
      .filter((item): item is string => typeof item === "string");
    if (answers.length === 0) return undefined;
    return question._type === "multi" ? answers : answers[0];
  }

  const answer = canonical_option(question._options, value);
  if (!answer) return undefined;
  return question._type === "multi" ? [answer] : answer;
}

function normalize_question(raw_question: unknown): PlanningQuestion | undefined {
  if (
    !_xu.is_plain_object(raw_question) ||
    typeof raw_question._id !== "string" ||
    typeof raw_question._question !== "string" ||
    !SUPPORTED_QUESTION_IDS.has(raw_question._id)
  ) {
    return undefined;
  }

  const type = is_question_type(raw_question._type)
    ? raw_question._type
    : QUESTION_TYPES[raw_question._id] ?? "text";
  const question: PlanningQuestion = {
    _id: raw_question._id,
    _type: type,
    _question: raw_question._question.trim().replace(/\s+/gu, " "),
    _options: read_options(raw_question),
    _required: typeof raw_question._required === "boolean"
      ? raw_question._required
      : true,
    _answer: null,
  };
  const answer = normalize_stored_answer(question, raw_question._answer);
  question._answer = answer ?? null;

  return question;
}

function read_project_plan(
  request: XVibeIntentEngineRequest,
): ProjectPlanArtifact | undefined {
  const context = request._runtime_context as Record<string, any>;
  const raw_plan =
    _xu.is_plain_object(context._current_project_plan)
      ? context._current_project_plan
      : _xu.is_plain_object(context._current_artifact)
        ? context._current_artifact
        : ConversationManager.readPlanningDraft({
          _app_id: request._runtime_context._app_id,
          _env: request._runtime_context._env,
          _conversation_id: read_conversation_id(request),
        });

  if (
    !_xu.is_plain_object(raw_plan) ||
    raw_plan._type !== "project-plan" ||
    raw_plan._stage !== "planning" ||
    !Array.isArray(raw_plan._questions)
  ) {
    return undefined;
  }

  const questions = raw_plan._questions
    .map((question: unknown) => normalize_question(question))
    .filter((question: PlanningQuestion | undefined): question is PlanningQuestion =>
      question !== undefined,
    );

  if (questions.length === 0) {
    return undefined;
  }

  return {
    ...clone_json(raw_plan),
    _questions: clone_json(questions),
  } as ProjectPlanArtifact;
}

function read_answers(plan: ProjectPlanArtifact): Record<string, PlanningAnswer> {
  const answers: Record<string, PlanningAnswer> = {};
  const questions_by_id = new Map(
    plan._questions.map((question) => [question._id, question]),
  );

  if (_xu.is_plain_object(plan._answers)) {
    for (const [key, value] of Object.entries(plan._answers)) {
      const question = questions_by_id.get(key);
      if (!question) continue;

      const answer = normalize_stored_answer(question, value);
      if (answer !== undefined) {
        answers[key] = answer;
      }
    }
  }

  for (const question of plan._questions) {
    if (answers[question._id] !== undefined) continue;

    const answer = normalize_stored_answer(question, question._answer);
    if (answer !== undefined) {
      answers[question._id] = answer;
    }
  }

  return answers;
}

function question_ids(plan: ProjectPlanArtifact): string[] {
  return plan._questions.map((question) => question._id);
}

function read_unanswered_ids(
  plan: ProjectPlanArtifact,
  answers: Record<string, PlanningAnswer>,
): string[] {
  const ids = new Set(question_ids(plan));
  const source =
    Array.isArray(plan._unanswered)
      ? plan._unanswered
      : question_ids(plan);

  const unanswered: string[] = [];
  for (const value of source) {
    if (
      typeof value === "string" &&
      ids.has(value) &&
      !has_answer(answers[value]) &&
      !unanswered.includes(value)
    ) {
      unanswered.push(value);
    }
  }

  for (const id of ids) {
    if (!has_answer(answers[id]) && !unanswered.includes(id)) {
      unanswered.push(id);
    }
  }

  return unanswered;
}

function find_question(
  plan: ProjectPlanArtifact,
  question_id: string,
): PlanningQuestion | undefined {
  return plan._questions.find((question) => question._id === question_id);
}

function has_answer(answer: PlanningAnswer | undefined): boolean {
  if (Array.isArray(answer)) return answer.length > 0;
  return typeof answer === "string" && answer.trim().length > 0;
}

function canonical_option(
  options: readonly string[],
  value: unknown,
): string | undefined {
  const answer = normalize_option(value);
  if (!answer) return undefined;

  const option = options.find(
    (candidate) => candidate.toLocaleLowerCase() === answer.toLocaleLowerCase(),
  );
  return option ?? answer;
}

function option_matches_text(option: string, text: string): boolean {
  const escaped = option.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "iu").test(text);
}

function parse_multi_answer(
  question: PlanningQuestion,
  value: string | string[],
): string[] | undefined {
  const raw_values = Array.isArray(value)
    ? value
    : value.includes(",")
      ? value.split(",")
      : question._options.filter((option) => option_matches_text(option, value));
  const source_values = raw_values.length > 0 ? raw_values : [value];
  const answers: string[] = [];

  for (const raw_value of source_values) {
    const answer = canonical_option(question._options, raw_value);
    if (answer && !answers.includes(answer)) {
      answers.push(answer);
    }
  }

  return answers.length > 0 ? answers : undefined;
}

function parse_planning_answer(
  question: PlanningQuestion,
  value: string | string[],
): PlanningAnswer | undefined {
  if (question._type === "multi") {
    return parse_multi_answer(question, value);
  }

  if (Array.isArray(value)) {
    return canonical_option(question._options, value[0]);
  }

  return canonical_option(question._options, value);
}

function read_selected_answer(
  request: XVibeIntentEngineRequest,
): string | string[] | undefined {
  const context = request._runtime_context as Record<string, any>;
  const raw_answer =
    context._planning_answer ??
    context._selected_options ??
    context._selected_option;

  if (Array.isArray(raw_answer)) {
    const answers = raw_answer
      .map((item) => normalize_option(item))
      .filter((item): item is string => typeof item === "string");
    return answers.length > 0 ? answers : undefined;
  }

  return normalize_option(raw_answer);
}

function normalize_message_answer(message: string): string | undefined {
  return normalize_option(message);
}

function read_answer_for_question(
  request: XVibeIntentEngineRequest,
  question: PlanningQuestion,
): PlanningAnswer | undefined {
  const selected_answer = read_selected_answer(request);
  if (selected_answer !== undefined) {
    return parse_planning_answer(question, selected_answer);
  }

  const message_answer = normalize_message_answer(request._message);
  return message_answer === undefined
    ? undefined
    : parse_planning_answer(question, message_answer);
}

function read_current_question_id(plan: ProjectPlanArtifact): string | undefined {
  return _xu.is_plain_object(plan._current_question) &&
    typeof plan._current_question._id === "string"
    ? plan._current_question._id
    : undefined;
}

function should_add_crm_adaptive_questions(
  plan: ProjectPlanArtifact,
  answers: Record<string, PlanningAnswer>,
): boolean {
  return plan._domain === "crm" && has_answer(answers.core_entities);
}

function ensure_crm_adaptive_questions(
  plan: ProjectPlanArtifact,
  answers: Record<string, PlanningAnswer>,
): ProjectPlanArtifact {
  if (!should_add_crm_adaptive_questions(plan, answers)) return plan;

  const existing_ids = new Set(plan._questions.map((question) => question._id));
  const missing_questions = CRM_ADAPTIVE_QUESTIONS
    .filter((question) => !existing_ids.has(question._id))
    .map((question) => clone_json(question));
  if (missing_questions.length === 0) return plan;

  return {
    ...clone_json(plan),
    _questions: [
      ...clone_json(plan._questions),
      ...missing_questions,
    ],
  };
}

function answer_values(answer: PlanningAnswer | undefined): string[] {
  if (Array.isArray(answer)) return answer;
  return typeof answer === "string" && answer.trim().length > 0
    ? [answer.trim()]
    : [];
}

function selected_capabilities(answer: PlanningAnswer | undefined): string[] {
  return answer_values(answer).filter((item) =>
    item.toLocaleLowerCase() !== "none"
  );
}

function includes_capability(
  answer: PlanningAnswer | undefined,
  capability: string,
): boolean {
  const normalized = capability.toLocaleLowerCase();
  return selected_capabilities(answer).some((item) =>
    item.toLocaleLowerCase() === normalized
  );
}

function append_unique_by_id<T extends Record<string, any>>(
  items: T[],
  item: T,
): T[] {
  return items.some((candidate) => candidate._id === item._id)
    ? items
    : [...items, item];
}

function apply_capability_plan_updates(
  plan: ProjectPlanArtifact,
  answers: Record<string, PlanningAnswer>,
): ProjectPlanArtifact {
  const next_plan = clone_json(plan);
  const proposed = _xu.is_plain_object(next_plan._proposed)
    ? clone_json(next_plan._proposed)
    : {};
  const server_modules = Array.isArray(proposed._server_modules)
    ? clone_json(proposed._server_modules)
    : [];
  const milestones = Array.isArray(next_plan._milestones)
    ? clone_json(next_plan._milestones)
    : [];

  const ai = answer_values(answers.ai_capabilities);
  const notifications = answer_values(answers.notification_capabilities);
  const reporting = answer_values(answers.reporting_capabilities);
  const integrations = answer_values(answers.integration_capabilities);

  let updated_server_modules = server_modules;
  let updated_milestones = milestones;

  if (includes_capability(answers.ai_capabilities, "Image understanding")) {
    updated_server_modules = append_unique_by_id(updated_server_modules, {
      _id: "vision",
      _title: "Vision",
      _required: true,
      _reason: "Required for image understanding capabilities.",
    });
    updated_milestones = append_unique_by_id(updated_milestones, {
      _id: next_plan._domain === "nutrition"
        ? "ai-food-recognition"
        : "ai-image-understanding",
      _title: next_plan._domain === "nutrition"
        ? "AI Food Recognition"
        : "AI Image Understanding",
      _items: next_plan._domain === "nutrition"
        ? ["Food Image Upload", "Food Recognition", "Nutrition Review"]
        : ["Image Upload", "Image Analysis", "Review Results"],
    });
  }

  if (selected_capabilities(answers.notification_capabilities).length > 0) {
    updated_server_modules = append_unique_by_id(updated_server_modules, {
      _id: "notifications",
      _title: "Notifications",
      _required: true,
      _reason: "Required for selected notification capabilities.",
    });
  }

  if (selected_capabilities(answers.reporting_capabilities).length > 0) {
    updated_server_modules = append_unique_by_id(updated_server_modules, {
      _id: "reporting",
      _title: "Reporting",
      _required: true,
      _reason: "Required for selected reporting capabilities.",
    });
  }

  if (selected_capabilities(answers.integration_capabilities).length > 0) {
    updated_server_modules = append_unique_by_id(updated_server_modules, {
      _id: "integrations",
      _title: "Integrations",
      _required: true,
      _reason: "Required for selected integration capabilities.",
    });
  }

  return {
    ...next_plan,
    _capabilities: {
      _ai: ai,
      _notifications: notifications,
      _reporting: reporting,
      _integrations: integrations,
    },
    _proposed: {
      ...proposed,
      _server_modules: updated_server_modules,
    },
    _milestones: updated_milestones,
  };
}

function with_question_answers(
  plan: ProjectPlanArtifact,
  answers: Record<string, PlanningAnswer>,
): ProjectPlanArtifact {
  return {
    ...clone_json(plan),
    _questions: plan._questions.map((question) => ({
      ...clone_json(question),
      _answer: answers[question._id] ?? null,
    })),
  };
}

export class PlanningSessionProcessor implements XVibeIntentProcessor {
  private diagnostic_reason = "planning_session_no_match";

  async analyze(
    request: XVibeIntentEngineRequest,
  ): Promise<XVibeIntentResult | null> {
    const stage = read_stage(request);
    if (stage !== "planning") {
      return this.skip("project_memory_stage_not_planning");
    }

    let plan = read_project_plan(request);
    if (!plan) {
      if (
        may_start_planning(request._message) ||
        may_be_direct_build_command(request._message)
      ) {
        return this.skip("current_project_plan_not_found");
      }

      return this.fail_fast("planning_session_draft_not_found");
    }

    let answers = read_answers(plan);
    plan = ensure_crm_adaptive_questions(plan, answers);
    plan = apply_capability_plan_updates(plan, answers);
    answers = read_answers(plan);
    let unanswered = read_unanswered_ids(plan, answers);
    const current_question_id = unanswered[0];
    if (!current_question_id) {
      return this.complete(request, plan, answers);
    }

    const current_question = find_question(plan, current_question_id);
    const answer =
      current_question &&
      read_current_question_id(plan) === current_question_id
        ? read_answer_for_question(request, current_question)
        : undefined;
    if (answer !== undefined) {
      answers[current_question_id] = answer;
      plan = with_question_answers(plan, answers);
      plan = ensure_crm_adaptive_questions(plan, answers);
      plan = apply_capability_plan_updates(plan, answers);
      answers = read_answers(plan);
      unanswered = read_unanswered_ids(plan, answers);
    }

    const next_question_id = unanswered[0];
    if (!next_question_id) {
      return this.complete(request, plan, answers);
    }

    const next_question = find_question(plan, next_question_id);
    if (!next_question) {
      return this.complete(request, plan, answers);
    }

    const updated_plan = this.updated_plan(plan, answers, unanswered, next_question);
    this.store_draft(request, updated_plan);
    this.diagnostic_reason = "planning_session_question";
    _xlog.log("[xvibe] planning session question", {
      _question_id: next_question._id,
      _unanswered_count: unanswered.length,
    });

    return {
      _message_type: "planning",
      _execution_level: "planning",
      _should_mutate: false,
      _confidence: 1,
      _reason: answer
        ? "planning_session_answer_recorded"
        : "planning_session_question",
      _artifact_type: "project-plan",
      _artifact_request: updated_plan,
      _actions: [],
    };
  }

  _diagnostic_reason(): string | undefined {
    return this.diagnostic_reason;
  }

  private complete(
    request: XVibeIntentEngineRequest,
    plan: ProjectPlanArtifact,
    answers: Record<string, PlanningAnswer>,
  ): XVibeIntentResult {
    const answered_plan = with_question_answers(plan, answers);
    const updated_plan = {
      ...clone_json(answered_plan),
      _answers: clone_json(answers),
      _unanswered: [],
      _current_question: null,
      _status: "ready-for-confirmation",
      _status_label: "Ready for confirmation",
      _next_step: {
        _title: "Ready for confirmation",
        _prompt: "Planning complete.",
      },
    };
    this.store_draft(request, updated_plan as ProjectPlanArtifact);

    this.diagnostic_reason = "planning_session_complete";
    _xlog.log("[xvibe] planning session complete", {
      _answered_count: Object.keys(answers).length,
    });

    return {
      _message_type: "planning",
      _execution_level: "planning",
      _should_mutate: false,
      _confidence: 1,
      _reason: "planning_session_complete",
      _artifact_type: "project-plan",
      _artifact_request: updated_plan,
      _actions: [],
    };
  }

  private updated_plan(
    plan: ProjectPlanArtifact,
    answers: Record<string, PlanningAnswer>,
    unanswered: string[],
    question: PlanningQuestion,
  ): ProjectPlanArtifact {
    const answered_plan = with_question_answers(plan, answers);
    return {
      ...clone_json(answered_plan),
      _answers: clone_json(answers),
      _unanswered: [...unanswered],
      _current_question: clone_json(question),
      _status: "collecting-information",
      _next_step: {
        _title: "Answer planning question",
        _prompt: question._question,
        _question_id: question._id,
      },
    };
  }

  private store_draft(
    request: XVibeIntentEngineRequest,
    draft: ProjectPlanArtifact,
  ): void {
    ConversationManager.writePlanningDraft({
      _app_id: request._runtime_context._app_id,
      _env: request._runtime_context._env,
      _conversation_id: read_conversation_id(request),
      _draft: draft,
    });
  }

  private fail_fast(reason: string): XVibeIntentResult {
    this.diagnostic_reason = reason;
    _xlog.log("[xvibe] planning session failed", {
      _reason: reason,
    });

    return {
      _message_type: "planning",
      _execution_level: "planning",
      _should_mutate: false,
      _confidence: 1,
      _reason: reason,
      _actions: [],
      _warnings: [reason],
    };
  }

  private skip(reason: string): null {
    this.diagnostic_reason = reason;
    _xlog.log("[xvibe] planning session skipped", {
      _reason: reason,
    });
    return null;
  }
}
