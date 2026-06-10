import { _xlog } from "@xpell/core";
import type {
  VibeArtifactType,
  XVibeArtifactActionPlan,
  XVibeArtifactIntent,
  XVibeIntentIRAction,
  XVibeIntentIREntity,
} from "./XVibeTypes.js";
import type { VibeIntentPlan } from "./VibeIntentPlanner.js";

type VibeCrudIntent =
  | "add"
  | "find"
  | "get"
  | "update"
  | "delete";

export type VibeBehaviorIntent = {
  _behavior?: string;

  _behavior_type?: string;

  _crud_intent?: VibeCrudIntent;

  _entity_targets?: string[];

  _flow_targets?: string[];

  _steps?: string[];

  _entity?: string;

  _crud?: VibeCrudIntent;

  _flow_goal?: string;

  _ui_action?: string;

  _server_action?: string;

  _source_fields?: string[];

  _target_fields?: string[];

  _confidence?: number;

  _reason?: string;
};

export type RuntimeAssetRef = {
  _id: string;
};

export type RuntimeAssets = {
  _views?: RuntimeAssetRef[];
  _flows?: RuntimeAssetRef[];
  _entities?: RuntimeAssetRef[];
  _modules?: RuntimeAssetRef[];
};

export type VibeBehaviorPlannerInput = {
  _prompt: string;
  _artifact_type?: VibeArtifactType;
  _artifact_action_plan?: XVibeArtifactActionPlan;
  _intent_plan?: VibeIntentPlan;
  _artifact_intent?: XVibeArtifactIntent;
  _runtime_assets?: RuntimeAssets;
};

type EntityMatch = {
  _id: string;
  _score: number;
  _runtime: boolean;
};

const CRUD_VERBS: Record<VibeCrudIntent, string[]> = {
  add: ["add", "create", "insert", "make", "new", "register", "save", "submit"],
  find: ["find", "fetch", "list", "load", "query", "read", "search"],
  get: ["get"],
  update: ["change", "edit", "modify", "patch", "set", "update"],
  delete: ["delete", "remove", "destroy"],
};

const CRUD_WORDS =
  Object.values(CRUD_VERBS)
    .reduce<string[]>((all, words) => [...all, ...words], []);

const DATA_CRUD_WORDS = new Set([
  "collection",
  "collections",
  "crud",
  "database",
  "databases",
  "entities",
  "entity",
  "persist",
  "persistence",
  "record",
  "records",
  "schema",
  "schemas",
]);

const ENTITY_NAMESPACE_HINTS = new Set([
  "aime",
  "xai",
  "xdb",
  "xui",
  "xvm",
  "xvibe",
]);

export class VibeBehaviorPlanner {
  infer_behavior_intent(input: VibeBehaviorPlannerInput): VibeBehaviorIntent {
    const prompt = input._prompt ?? "";
    const scope = resolve_behavior_scope(input);
    const artifact_id = resolve_artifact_id(prompt, input);
    const view_scope_without_data =
      scope._artifact_type === "view" && !scope._crud_allowed;
    const intent_plan_entities = view_scope_without_data
      ? []
      : normalize_intent_plan_entities(input._intent_plan);
    const intent_plan_actions = view_scope_without_data
      ? []
      : normalize_intent_plan_actions(input._intent_plan);
    const intent_plan_flow_keywords = view_scope_without_data
      ? []
      : normalize_string_array(input._intent_plan?._flow_keywords);
    const runtime_assets =
      input._runtime_assets ??
      runtime_assets_from_intent_plan(intent_plan_entities);
    const crud = detect_crud_intent({
      prompt,
      artifact_id,
      artifact_action_plan: input._artifact_action_plan,
      artifact_intent: input._artifact_intent,
      intent_plan: input._intent_plan,
    });
    const entity_match = view_scope_without_data
      ? undefined
      : match_runtime_entity({
        prompt,
        artifact_id,
        runtime_assets,
      }) ?? infer_entity_from_flow_id(artifact_id);
    const flow_goal = view_scope_without_data
      ? undefined
      : derive_flow_goal({
        prompt,
        artifact_id,
        artifact_type: input._artifact_type,
        artifact_intent: input._artifact_intent,
        crud,
        entity_id: entity_match?._id,
      });
    const source_fields = extract_named_fields(prompt, "source");
    const target_fields =
      extract_named_fields(prompt, "target") ??
      extract_named_fields(prompt, "fields");
    const entity_targets = unique_ids([
      ...(entity_match?._id ? [entity_match._id] : []),
      ...intent_plan_entities.map((entity) => entity._id),
      ...intent_plan_actions
        .map((action) => action._entity)
        .filter((entity): entity is string => typeof entity === "string" && entity.length > 0),
    ]);
    const flow_targets = unique_ids([
      ...(flow_goal ? [flow_goal] : []),
      ...intent_plan_flow_keywords,
      ...intent_plan_actions
        .filter((action) => action._type === "flow")
        .map((action) => action._id),
      ...(input._artifact_action_plan?._artifact_type === "flow" && input._artifact_action_plan._target_id
        ? [input._artifact_action_plan._target_id]
        : []),
    ]);
    const steps = derive_steps({
      crud,
      flow_goal,
      entity_targets,
      flow_targets,
      actions: intent_plan_actions,
    });
    const inferred_behavior = derive_behavior({
      prompt,
      artifact_id,
      crud,
      flow_goal,
      entity_targets,
      flow_targets,
    });
    const behavior: VibeBehaviorIntent = {
      _behavior: inferred_behavior,
      _behavior_type: derive_behavior_type({
        artifact_type: input._artifact_type,
        crud,
        flow_targets,
        entity_targets,
      }),
      ...(crud ? { _crud_intent: crud } : {}),
      _entity_targets: entity_targets,
      _flow_targets: flow_targets,
      _steps: steps,
      ...(entity_match ? { _entity: entity_match._id } : {}),
      ...(crud ? { _crud: crud } : {}),
      ...(flow_goal ? { _flow_goal: flow_goal } : {}),
      ...(source_fields ? { _source_fields: source_fields } : {}),
      ...(target_fields ? { _target_fields: target_fields } : {}),
    };

    behavior._confidence = behavior_confidence({
      behavior,
      entity_match,
      has_runtime_entities:
        normalize_runtime_entity_ids(runtime_assets).length > 0,
    });
    behavior._reason = behavior_reason({
      behavior,
      entity_match,
      artifact_id,
    });

    return behavior;
  }
}

function resolve_artifact_id(
  prompt: string,
  input: VibeBehaviorPlannerInput,
): string | undefined {
  const action_plan_id = normalize_id(input._artifact_action_plan?._target_id);
  if (action_plan_id) return action_plan_id;

  const intent_id = normalize_id(input._artifact_intent?._target_id);
  if (intent_id) return intent_id;

  const patterns = [
    /\b(?:view|page|screen)\s+(?:named|called|id)?\s*["']?([a-z0-9][a-z0-9_-]*)["']?\b/iu,
    /\b(?:flow|workflow)\s+(?:named|called|id)?\s*["']?([a-z0-9][a-z0-9_-]*)["']?\b/iu,
    /\b(?:entity|schema|collection|table)\s+(?:named|called|id)?\s*["']?([a-z0-9][a-z0-9_-]*)["']?\b/iu,
    /\bmodule\s+(?:named|called|id)?\s*["']?([a-z0-9][a-z0-9_-]*)["']?\b/iu,
  ];

  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    const id = normalize_id(match?.[1]);
    if (id) return id;
  }

  return undefined;
}

function detect_crud_intent(input: {
  prompt: string;
  artifact_id?: string;
  artifact_action_plan?: XVibeArtifactActionPlan;
  artifact_intent?: XVibeArtifactIntent;
  intent_plan?: VibeIntentPlan;
}): VibeCrudIntent | undefined {
  const scope = resolve_behavior_scope({
    _prompt: input.prompt,
    _artifact_action_plan: input.artifact_action_plan,
    _artifact_intent: input.artifact_intent,
    _intent_plan: input.intent_plan,
  });
  _xlog.log("[xvibe] behavior planner scope", {
    _artifact_type: scope._artifact_type,
    _crud_allowed: scope._crud_allowed,
    _reason: scope._reason,
  });

  const inferred_crud = detect_raw_crud_intent(input);
  if (!scope._crud_allowed) {
    if (inferred_crud) {
      _xlog.log("[xvibe] crud inference blocked", {
        _artifact_type: scope._artifact_type,
        _prompt: input.prompt,
      });
    }
    return undefined;
  }

  return inferred_crud;
}

function detect_raw_crud_intent(input: {
  prompt: string;
  artifact_id?: string;
  artifact_action_plan?: XVibeArtifactActionPlan;
  artifact_intent?: XVibeArtifactIntent;
  intent_plan?: VibeIntentPlan;
}): VibeCrudIntent | undefined {
  const prompt_without_ui_labels = strip_ui_label_phrases(input.prompt);
  const text = normalize_text(`${prompt_without_ui_labels} ${input.artifact_id ?? ""}`);
  const tokens = new Set(tokenize(text));

  for (const crud of ["delete", "update", "get", "find", "add"] as VibeCrudIntent[]) {
    for (const word of CRUD_VERBS[crud]) {
      if (tokens.has(word)) return crud === "get" ? "find" : crud;
    }
  }

  const plan_crud = normalize_crud(input.intent_plan?._crud_ops?.[0]);
  if (plan_crud) return plan_crud;

  const action_plan_crud = normalize_crud(input.artifact_action_plan?._action);
  if (action_plan_crud) return action_plan_crud;

  if (input.artifact_intent?._action === "delete") return "delete";
  if (input.artifact_intent?._action === "update") return "update";
  if (input.artifact_intent?._action === "create") return "add";

  return undefined;
}

function resolve_behavior_scope(input: Pick<
  VibeBehaviorPlannerInput,
  "_artifact_type" | "_artifact_action_plan" | "_artifact_intent" | "_intent_plan" | "_prompt"
>): {
  _artifact_type: string;
  _crud_allowed: boolean;
  _reason: string;
} {
  const artifact_type =
    input._artifact_type ??
    input._artifact_action_plan?._artifact_type ??
    (input._artifact_intent?._target !== "unknown"
      ? input._artifact_intent?._target
      : undefined) ??
    normalize_intent_plan_artifact_type(input._intent_plan) ??
    "unknown";
  const view_scoped =
    input._artifact_type === "view" ||
    input._artifact_action_plan?._artifact_type === "view" ||
    input._artifact_intent?._target === "view" ||
    input._intent_plan?._artifact_types?.includes("view");
  const has_data_crud_language = has_explicit_data_crud_language(input._prompt);

  if (view_scoped && !has_data_crud_language) {
    return {
      _artifact_type: "view",
      _crud_allowed: false,
      _reason: "view_scope_no_data_intent",
    };
  }

  if (view_scoped) {
    return {
      _artifact_type: "view",
      _crud_allowed: true,
      _reason: "view_scope_explicit_data_intent",
    };
  }

  return {
    _artifact_type: artifact_type,
    _crud_allowed: true,
    _reason: "non_view_scope",
  };
}

function normalize_intent_plan_artifact_type(intent_plan: VibeIntentPlan | undefined): string | undefined {
  const artifact_type = intent_plan?._artifact_types?.[0];
  return typeof artifact_type === "string" && artifact_type.trim().length > 0
    ? artifact_type.trim()
    : undefined;
}

function has_explicit_data_crud_language(prompt: string | undefined): boolean {
  const text = normalize_text(prompt);
  const tokens = tokenize(text);
  if (tokens.some((token) => DATA_CRUD_WORDS.has(token))) return true;

  return /\btable-data\b/u.test(text);
}

function strip_ui_label_phrases(prompt: string): string {
  return prompt
    .replace(
      /\b(?:add|back|change|create|delete|edit|login|modify|register|remove|save|submit|update)\s+(?:[a-z0-9_-]+\s+){0,2}(?:button|icon|label|link)\b/giu,
      " ",
    )
    .replace(
      /\b(?:button|icon|label)\s+(?:named|called|text|title)\s+["']?(?:add|back|create|delete|login|register|save|submit|update)(?:\s+[a-z0-9_-]+){0,2}["']?\b/giu,
      " ",
    );
}

function derive_flow_goal(input: {
  prompt: string;
  artifact_id?: string;
  artifact_type?: VibeArtifactType;
  artifact_intent?: XVibeArtifactIntent;
  crud?: VibeCrudIntent;
  entity_id?: string;
}): string | undefined {
  if (
    input.artifact_type !== "flow" &&
    input.artifact_intent?._target !== "flow" &&
    !/\b(?:flow|workflow)\b/iu.test(input.prompt) &&
    !input.artifact_id
  ) {
    return undefined;
  }

  const id = normalize_id(input.artifact_id);
  if (!id) return undefined;

  const tokens = tokenize(id);
  if (tokens.length === 0) return undefined;

  const first = tokens[0];
  const rest = tokens.slice(1);
  if (["get", "find", "fetch", "read", "query"].includes(first) && rest.length > 0) {
    return join_id(["load", ...rest]);
  }

  if (["list", "load", "search"].includes(first) && rest.length > 0) {
    return join_id(["load", ...rest]);
  }

  if (["create", "add", "register", "new", "make"].includes(first)) {
    const noun = entity_goal_noun(input.entity_id, tokens);
    return noun ? join_id(["create", noun]) : id;
  }

  if (["update", "edit", "modify", "change", "delete", "remove"].includes(first)) {
    return id;
  }

  if (input.crud === "add") return join_id(["create", ...tokens]);
  if (input.crud === "find" || input.crud === "get") return join_id(["load", ...tokens]);
  if (input.crud === "update") return join_id(["update", ...tokens]);
  if (input.crud === "delete") return join_id(["delete", ...tokens]);

  return id;
}

function normalize_intent_plan_entities(intent_plan: VibeIntentPlan | undefined): XVibeIntentIREntity[] {
  const entities = intent_plan?._entities;
  if (!Array.isArray(entities)) return [];

  return entities
    .filter((entity): entity is XVibeIntentIREntity =>
      typeof entity?._id === "string" && entity._id.trim().length > 0,
    )
    .map((entity) => ({
      _id: normalize_id(entity._id) ?? entity._id.trim(),
      _fields: normalize_string_array(entity._fields),
    }));
}

function normalize_intent_plan_actions(intent_plan: VibeIntentPlan | undefined): XVibeIntentIRAction[] {
  const actions = intent_plan?._actions;
  if (!Array.isArray(actions)) return [];

  return actions
    .filter((action): action is XVibeIntentIRAction =>
      typeof action?._id === "string" &&
      typeof action._type === "string" &&
      typeof action._label === "string",
    )
    .map((action) => ({
      _id: normalize_id(action._id) ?? action._id.trim(),
      _type: action._type.trim(),
      _label: action._label.trim(),
      ...(typeof action._entity === "string" && action._entity.trim().length > 0
        ? { _entity: normalize_id(action._entity) ?? action._entity.trim() }
        : {}),
      ...(typeof action._op === "string" && action._op.trim().length > 0
        ? { _op: action._op.trim() }
        : {}),
      ...(typeof action._target_region === "string" && action._target_region.trim().length > 0
        ? { _target_region: action._target_region.trim() }
        : {}),
    }));
}

function runtime_assets_from_intent_plan(entities: XVibeIntentIREntity[]): RuntimeAssets {
  return {
    _entities: entities.map((entity) => ({ _id: entity._id })),
  };
}

function normalize_crud(value: unknown): VibeCrudIntent | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "create") return "add";
  if (normalized === "list") return "find";
  if (normalized === "remove") return "delete";
  if (["add", "find", "get", "update", "delete"].includes(normalized)) {
    return normalized === "get" ? "find" : normalized as VibeCrudIntent;
  }

  return undefined;
}

function derive_behavior_type(input: {
  artifact_type?: VibeArtifactType;
  crud?: VibeCrudIntent;
  flow_targets: string[];
  entity_targets: string[];
}): string {
  if (input.crud && input.entity_targets.length > 0) return "crud";
  if (input.flow_targets.length > 0 || input.artifact_type === "flow") return "flow";
  if (input.entity_targets.length > 0 || input.artifact_type === "entity") return "entity";
  if (input.artifact_type === "view") return "ui";

  return "unknown";
}

function derive_behavior(input: {
  prompt: string;
  artifact_id?: string;
  crud?: VibeCrudIntent;
  flow_goal?: string;
  entity_targets: string[];
  flow_targets: string[];
}): string {
  const tokens = new Set([
    ...tokenize(input.prompt),
    ...tokenize(input.artifact_id),
    ...tokenize(input.flow_goal),
    ...input.entity_targets.flatMap((target) => tokenize(target)),
    ...input.flow_targets.flatMap((target) => tokenize(target)),
  ].map(singular_token));

  if (
    input.crud === "add" &&
    tokens.has("account") &&
    tokens.has("user")
  ) {
    return "account_creation";
  }

  if (input.crud === "add") return "creation";
  if (input.crud === "find" || input.crud === "get") return "lookup";
  if (input.crud === "update") return "update";
  if (input.crud === "delete") return "deletion";

  return "unknown";
}

function derive_steps(input: {
  crud?: VibeCrudIntent;
  flow_goal?: string;
  entity_targets: string[];
  flow_targets: string[];
  actions: XVibeIntentIRAction[];
}): string[] {
  const steps: string[] = [];
  if (input.crud) steps.push(`crud:${input.crud}`);
  for (const entity of input.entity_targets) steps.push(`entity:${entity}`);
  for (const flow of input.flow_targets) steps.push(`flow:${flow}`);
  for (const action of input.actions) {
    const op = action._op ? `:${action._op}` : "";
    steps.push(`action:${action._id}${op}`);
  }

  if (steps.length === 0 && input.flow_goal) steps.push(`flow:${input.flow_goal}`);
  return unique_ids(steps);
}

function match_runtime_entity(input: {
  prompt: string;
  artifact_id?: string;
  runtime_assets?: RuntimeAssets;
}): EntityMatch | undefined {
  const entity_ids = normalize_runtime_entity_ids(input.runtime_assets);
  if (entity_ids.length === 0) return undefined;

  const haystack = normalize_text(`${input.prompt} ${input.artifact_id ?? ""}`);
  const haystack_tokens = tokenize(haystack).map(singular_token);
  const matches = entity_ids
    .map((id): EntityMatch => ({
      _id: id,
      _score: score_entity_match(id, haystack, haystack_tokens),
      _runtime: true,
    }))
    .filter((match) => match._score >= 35)
    .sort((left, right) => {
      if (right._score !== left._score) return right._score - left._score;
      return left._id.localeCompare(right._id);
    });

  return matches[0];
}

function score_entity_match(
  entity_id: string,
  haystack: string,
  haystack_tokens: string[],
): number {
  const entity = normalize_id(entity_id);
  if (!entity) return 0;

  if (contains_id(haystack, entity)) return 100;

  const entity_tokens = tokenize(entity).map(singular_token);
  if (entity_tokens.length === 0) return 0;

  let score = 0;
  for (let length = entity_tokens.length; length > 0; length -= 1) {
    const suffix = entity_tokens.slice(entity_tokens.length - length);
    if (contains_sequence(haystack_tokens, suffix)) {
      score = Math.max(score, 55 + length * 12);
      break;
    }
  }

  const overlap = entity_tokens.filter((token) => haystack_tokens.includes(token));
  if (overlap.length > 0) {
    score = Math.max(score, overlap.length * 10);
  }

  const last_token = entity_tokens[entity_tokens.length - 1];
  if (last_token && haystack_tokens.includes(last_token)) score += 20;

  const first_token = entity_tokens[0];
  if (
    first_token &&
    ENTITY_NAMESPACE_HINTS.has(first_token) &&
    haystack_tokens.includes(first_token)
  ) {
    score += 12;
  }

  return score;
}

function infer_entity_from_flow_id(artifact_id: string | undefined): EntityMatch | undefined {
  const id = normalize_id(artifact_id);
  if (!id) return undefined;

  const tokens = tokenize(id).filter((token) => !CRUD_WORDS.includes(token));
  if (tokens.length === 0) return undefined;

  if (tokens.length >= 3 && ENTITY_NAMESPACE_HINTS.has(tokens[0])) {
    return {
      _id: join_id([tokens[0], singular_token(tokens[tokens.length - 1])]),
      _score: 20,
      _runtime: false,
    };
  }

  if (tokens.length >= 2) {
    return {
      _id: join_id(tokens.slice(tokens.length - 2).map(singular_token)),
      _score: 18,
      _runtime: false,
    };
  }

  return {
    _id: singular_token(tokens[0]),
    _score: 12,
    _runtime: false,
  };
}

function normalize_runtime_entity_ids(runtime_assets: RuntimeAssets | undefined): string[] {
  const entities = Array.isArray(runtime_assets?._entities)
    ? runtime_assets?._entities ?? []
    : [];

  return entities
    .map((entity) => normalize_id((entity as RuntimeAssetRef | undefined)?._id))
    .filter((id): id is string => Boolean(id))
    .filter((id, index, all) => all.indexOf(id) === index)
    .sort((left, right) => left.localeCompare(right));
}

function normalize_string_array(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => normalize_id(item))
    .filter((item): item is string => Boolean(item));
}

function unique_ids(values: string[]): string[] {
  return values
    .map((value) => normalize_id(value))
    .filter((value): value is string => Boolean(value))
    .filter((value, index, all) => all.indexOf(value) === index);
}

function entity_goal_noun(
  entity_id: string | undefined,
  flow_tokens: string[],
): string | undefined {
  const entity_tokens = tokenize(entity_id).map(singular_token);
  for (let index = entity_tokens.length - 1; index >= 0; index -= 1) {
    const token = entity_tokens[index];
    if (token && flow_tokens.map(singular_token).includes(token)) return token;
  }

  return entity_tokens[entity_tokens.length - 1];
}

function behavior_confidence(input: {
  behavior: VibeBehaviorIntent;
  entity_match?: EntityMatch;
  has_runtime_entities: boolean;
}): number {
  if (input.behavior._flow_goal && input.behavior._crud && input.entity_match?._runtime) {
    return 0.9;
  }

  if (input.behavior._flow_goal && input.behavior._crud && input.behavior._entity) {
    return 0.75;
  }

  if (input.behavior._crud && input.entity_match?._runtime) return 0.8;
  if (input.behavior._flow_goal || input.behavior._crud || input.behavior._entity) {
    return input.has_runtime_entities ? 0.6 : 0.5;
  }

  return 0.2;
}

function behavior_reason(input: {
  behavior: VibeBehaviorIntent;
  entity_match?: EntityMatch;
  artifact_id?: string;
}): string {
  if (input.entity_match?._runtime && input.behavior._flow_goal && input.behavior._crud) {
    return "flow_name_runtime_entity_crud_match";
  }

  if (input.entity_match?._runtime) return "runtime_entity_match";
  if (input.artifact_id && input.behavior._crud) return "flow_name_crud_match";
  if (input.artifact_id) return "flow_name_match";

  return "no_behavior_match";
}

function extract_named_fields(
  prompt: string,
  label: "source" | "target" | "fields",
): string[] | undefined {
  const pattern =
    label === "fields"
      ? /\bfields?\s*[:=]\s*([a-z0-9_,\s-]+)/iu
      : new RegExp(String.raw`\b${label}\s+fields?\s*[:=]\s*([a-z0-9_,\s-]+)`, "iu");
  const match = prompt.match(pattern);
  if (!match?.[1]) return undefined;

  const fields = match[1]
    .split(/[,\s]+/u)
    .map(normalize_id)
    .filter((field): field is string => Boolean(field))
    .filter((field) => !["and", "or", "to", "from"].includes(field))
    .filter((field, index, all) => all.indexOf(field) === index);

  return fields.length > 0 ? fields : undefined;
}

function contains_id(haystack: string, id: string): boolean {
  return new RegExp(String.raw`(?:^|[^a-z0-9])${escape_regexp(id)}(?:$|[^a-z0-9])`, "u")
    .test(haystack);
}

function contains_sequence(tokens: string[], sequence: string[]): boolean {
  if (sequence.length === 0 || sequence.length > tokens.length) return false;

  for (let index = 0; index <= tokens.length - sequence.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (tokens[index + offset] !== sequence[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }

  return false;
}

function tokenize(value: string | undefined): string[] {
  const normalized = normalize_text(value);
  if (!normalized) return [];

  return normalized
    .split(/[^a-z0-9]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function normalize_text(value: string | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[_\s]+/gu, "-")
    .replace(/[^a-z0-9-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalize_id(value: string | undefined): string | undefined {
  const id = String(value ?? "")
    .toLowerCase()
    .trim()
    .replace(/^["']|["']$/gu, "")
    .replace(/[_\s]+/gu, "-")
    .replace(/[^a-z0-9-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "");

  return id.length > 0 ? id : undefined;
}

function singular_token(token: string): string {
  if (token.endsWith("ies") && token.length > 4) {
    return `${token.slice(0, -3)}y`;
  }

  if (token.endsWith("s") && !token.endsWith("ss") && token.length > 3) {
    return token.slice(0, -1);
  }

  return token;
}

function join_id(tokens: string[]): string {
  return tokens
    .map(normalize_id)
    .filter((token): token is string => Boolean(token))
    .join("-");
}

function escape_regexp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
