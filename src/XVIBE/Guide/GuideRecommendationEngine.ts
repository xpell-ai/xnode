import { _xlog, _xu } from "@xpell/core";
import type {
  XVibeGuideRecommendation,
  XVibeProjectMemory,
  XVibeRuntimeAssets,
} from "../XVibeTypes.js";
import {
  project_memory_focus_alias_resolution,
  project_memory_focus_milestone,
  project_memory_focus_template_resolution,
  type XVMProjectMemoryMilestone,
  type XVMProjectMemoryMilestoneItem,
} from "../../XVM/ProjectMemoryMilestones.js";

type GuideRecommendationCandidate = XVibeGuideRecommendation & {
  _suppression_terms: string[];
};

export type GuideRecommendationInput = {
  _project_memory?: Partial<XVibeProjectMemory> | null;
  _runtime_assets?: Partial<XVibeRuntimeAssets> | null;
};

function read_string(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function normalize_text(value: unknown): string {
  return _xu.normalize_prompt(value)
    .toLowerCase()
    .replace(/[_/.-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalize_id(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  return _xu.normalize_id(value) || undefined;
}

function title_case(value: string): string {
  return value
    .split(" ")
    .map((word) => {
      if (/^[A-Z0-9]{2,}$/u.test(word)) return word;
      if (!/[A-Za-z]/u.test(word)) return word;

      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function singular_entity_id(entity_id: string): string {
  if (entity_id.endsWith("ies") && entity_id.length > 3) {
    return `${entity_id.slice(0, -3)}y`;
  }

  if (entity_id.endsWith("s") && entity_id.length > 1) {
    return entity_id.slice(0, -1);
  }

  return entity_id;
}

function has_entity(entity_ids: Set<string>, entity_id: string): boolean {
  const normalized = normalize_id(entity_id);
  if (!normalized) return false;

  const singular = singular_entity_id(normalized);
  return entity_ids.has(normalized) ||
    entity_ids.has(singular) ||
    entity_ids.has(`${singular}s`);
}

function has_related_flow(flow_ids: Set<string>, entity_id: string): boolean {
  const normalized = normalize_id(entity_id);
  if (!normalized) return false;

  const singular = singular_entity_id(normalized);
  const terms = new Set([
    normalized,
    singular,
    `${singular}s`,
  ]);

  for (const flow_id of flow_ids) {
    for (const term of terms) {
      if (flow_id === term || flow_id.includes(term)) {
        return true;
      }
    }
  }

  return false;
}

function runtime_ids(
  assets: Partial<XVibeRuntimeAssets> | null | undefined,
  key: "_entities" | "_flows" | "_views",
): Set<string> {
  const raw_items = Array.isArray(assets?.[key]) ? assets?.[key] ?? [] : [];
  const ids = raw_items
    .map((item) => {
      if (typeof item === "string") return normalize_id(item);
      if (_xu.is_plain_object(item)) return normalize_id(item._id);
      return undefined;
    })
    .filter((id): id is string => typeof id === "string");

  return new Set(ids);
}

function memory_item_text(item: unknown): string {
  if (typeof item === "string") return normalize_text(item);
  if (!_xu.is_plain_object(item)) return "";

  const parts: string[] = [];
  for (const key of [
    "_id",
    "_title",
    "_prompt",
    "_type",
    "_name",
    "_text",
    "_description",
    "_reason",
  ]) {
    const value = read_string(item[key]);
    if (value) parts.push(value);
  }

  const id = read_string(item._id);
  const type = read_string(item._type);
  if (id && type) parts.push(`${id} ${type}`);

  return normalize_text(parts.join(" "));
}

function memory_texts(items: unknown): string[] {
  if (!Array.isArray(items)) return [];

  return items
    .map(memory_item_text)
    .filter((text) => text.length > 0);
}

function is_suppressed(
  candidate: GuideRecommendationCandidate,
  memory: Partial<XVibeProjectMemory> | null | undefined,
): boolean {
  const blocked_items = [
    ...memory_texts(memory?._parking_lot),
    ...memory_texts(memory?._completed),
  ];
  if (blocked_items.length === 0) return false;

  const candidate_terms = [
    candidate._title,
    candidate._action._prompt,
    candidate._type,
    ...candidate._suppression_terms,
  ]
    .map(normalize_text)
    .filter((text) => text.length > 0);

  return blocked_items.some((blocked) =>
    candidate_terms.some((term) =>
      blocked === term ||
      blocked.includes(term) ||
      term.includes(blocked)
    )
  );
}

function customer_crud_entity_from_focus(focus: string): {
  _entity_id: string;
  _entity_title: string;
} | undefined {
  const normalized = normalize_text(focus);
  const match =
    normalized.match(/\b([a-z][a-z0-9 ]*?)\s+crud\b/u) ??
    normalized.match(/\bcrud\s+(?:for\s+)?([a-z][a-z0-9 ]*?)$/u);
  const raw_entity = match?.[1]?.trim();
  if (!raw_entity) return undefined;

  const entity_id = normalize_id(raw_entity);
  if (!entity_id) return undefined;

  return {
    _entity_id: singular_entity_id(entity_id),
    _entity_title: title_case(raw_entity),
  };
}

function milestone_item_is_completed(
  item: XVMProjectMemoryMilestoneItem,
  memory: Partial<XVibeProjectMemory> | null | undefined,
): boolean {
  if (item._completed === true) return true;

  const completed = memory_texts(memory?._completed);
  const item_id = normalize_text(item._id);
  const item_title = normalize_text(item._title);

  return completed.some((completed_text) =>
    completed_text === item_id ||
    completed_text === item_title ||
    completed_text.includes(item_id) ||
    completed_text.includes(item_title)
  );
}

function milestone_item_type(
  item: XVMProjectMemoryMilestoneItem,
): XVibeGuideRecommendation["_type"] {
  return /\bcrud\b/iu.test(item._title) || /\bcrud\b/iu.test(item._id)
    ? "crud"
    : "flow";
}

function milestone_item_prompt(item: XVMProjectMemoryMilestoneItem): string {
  if (milestone_item_type(item) === "crud") {
    return `Create ${item._title}.`;
  }

  return `Create flow ${item._id}.`;
}

function milestone_candidate_from_milestone(
  milestone: XVMProjectMemoryMilestone,
  memory: Partial<XVibeProjectMemory> | null | undefined,
): GuideRecommendationCandidate | undefined {
  const item = milestone._items.find((candidate) =>
    !milestone_item_is_completed(candidate, memory)
  );
  if (!item) return undefined;

  return {
    _title: item._title,
    _reason: `Current focus is ${milestone._title}.`,
    _type: milestone_item_type(item),
    _priority: 100,
    _action: {
      _prompt: milestone_item_prompt(item),
    },
    _suppression_terms: [
      milestone._id,
      milestone._title,
      item._id,
      item._title,
      milestone_item_prompt(item),
    ],
  };
}

function auth_candidate(entity_ids: Set<string>): GuideRecommendationCandidate | undefined {
  if (has_entity(entity_ids, "user")) return undefined;

  return {
    _title: "Create User entity",
    _reason: "Current focus is Authentication.",
    _type: "entity",
    _priority: 100,
    _action: {
      _prompt: "Create an entity named user with email, name, role, status.",
    },
    _suppression_terms: [
      "authentication",
      "user",
      "user entity",
      "create user entity",
    ],
  };
}

function crud_candidates(input: {
  focus: string;
  entity_ids: Set<string>;
  flow_ids: Set<string>;
}): GuideRecommendationCandidate[] {
  const entity = customer_crud_entity_from_focus(input.focus);
  if (!entity) return [];

  if (!has_entity(input.entity_ids, entity._entity_id)) {
    return [
      {
        _title: `Create ${entity._entity_title} entity`,
        _reason: `Current focus is ${entity._entity_title} CRUD.`,
        _type: "entity",
        _priority: 95,
        _action: {
          _prompt: `Create ${entity._entity_title} entity.`,
        },
        _suppression_terms: [
          entity._entity_id,
          `${entity._entity_id} entity`,
          `create ${entity._entity_id} entity`,
          `${entity._entity_id} crud`,
        ],
      },
    ];
  }

  if (has_related_flow(input.flow_ids, entity._entity_id)) {
    return [];
  }

  return [
    {
      _title: `Create ${entity._entity_title} CRUD`,
      _reason: `${entity._entity_title} entity exists, but CRUD flow is missing.`,
      _type: "crud",
      _priority: 90,
      _action: {
        _prompt: `Create ${entity._entity_title} CRUD.`,
      },
      _suppression_terms: [
        entity._entity_id,
        `${entity._entity_id} crud`,
        `create ${entity._entity_id} crud`,
        `${entity._entity_id} flow`,
      ],
    },
  ];
}

export class GuideRecommendationEngine {
  recommend(input: GuideRecommendationInput): XVibeGuideRecommendation | null {
    const memory = input._project_memory ?? {};
    const focus = read_string(memory._current_focus);
    if (!focus) return null;

    const entity_ids = runtime_ids(input._runtime_assets, "_entities");
    const flow_ids = runtime_ids(input._runtime_assets, "_flows");
    const normalized_focus = normalize_text(focus);

    const candidates: GuideRecommendationCandidate[] = [];
    const focus_template_resolution = project_memory_focus_template_resolution(focus);
    if (focus_template_resolution) {
      _xlog.log("[xvibe] guide focus template resolved", {
        _focus: focus,
        _template: focus_template_resolution._template,
        _entity: focus_template_resolution._entity,
        _milestone_title: focus_template_resolution._milestone_title,
      });
    }

    const focus_alias_resolution = project_memory_focus_alias_resolution(focus);
    if (focus_alias_resolution?._is_alias === true) {
      _xlog.log("[xvibe] guide focus alias resolved", {
        _focus: focus,
        _canonical_focus: focus_alias_resolution._canonical_focus,
      });
    }

    const focus_milestone = project_memory_focus_milestone({
      _focus: focus,
      _milestones: memory._milestones,
    });
    if (focus_milestone) {
      const milestone_recommendation =
        milestone_candidate_from_milestone(focus_milestone, memory);
      if (!milestone_recommendation || is_suppressed(milestone_recommendation, memory)) {
        return null;
      }

      const { _suppression_terms: _ignored, ...public_recommendation } =
        milestone_recommendation;
      return public_recommendation;
    }

    if (normalized_focus.includes("authentication")) {
      const candidate = auth_candidate(entity_ids);
      if (candidate) candidates.push(candidate);
    }

    candidates.push(...crud_candidates({
      focus,
      entity_ids,
      flow_ids,
    }));

    const recommendation = candidates
      .filter((candidate) => !is_suppressed(candidate, memory))
      .sort((left, right) => right._priority - left._priority)[0];

    if (!recommendation) return null;

    const { _suppression_terms: _ignored, ...public_recommendation } =
      recommendation;
    return public_recommendation;
  }
}
