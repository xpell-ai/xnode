import type { VibeKnowledgeSelection, VibeSkillDocument } from "./VibeKnowledgeSelector.js";
import { _xu } from "../XNUtils/XUtils.js";
import { VibeArtifactType, VibeRequestedArtifactType } from "./XVibeTypes.js";

type XVibeJsonObject = {
  [key: string]: unknown;
};

export type SkillRelevance = {
  skill: VibeSkillDocument;
  score: number;
  reasons: string[];
};

export type BudgetedSkillRelevance = SkillRelevance & {
  budget: number;
  include_example: boolean;
};

export type VibePromptBuildInput = {
  prompt: string;
  _mode: "full" | "refine";
  _artifact_type: VibeArtifactType;
  selection: VibeKnowledgeSelection;
  runtime_context?: XVibeJsonObject;
  deterministic_skeleton?: XVibeJsonObject;
};

const DEFAULT_MAX_SKILL_PROMPT_CHARS = 5_000;
const DEFAULT_MAX_TOTAL_SKILL_PROMPT_CHARS = 12_000;
const DEFAULT_MAX_REFINE_SKILL_PROMPT_CHARS = 3_000;
const DEFAULT_MAX_PROMPT_CHARS = 40_000;
const DEFAULT_MAX_USER_TASK_CHARS = 8_000;
const XVIBE_ARTIFACT_CONTRACT_VERSION = 1;
const MAX_ARRAY_ITEMS = 10;
const MAX_PATTERN_ITEMS = 5;
const MAX_EXAMPLE_ITEMS = 3;
const MAX_JSON_CHARS = 1_200;
const MAX_SKELETON_JSON_CHARS = 8_000;
const MAX_CURRENT_VIEW_JSON_CHARS = 16_000;
const MAX_REFINE_SKILL_CHARS = 1_000;
const MIN_REFINE_SKILL_CHARS = 220;
const MAX_REFINE_EXAMPLE_CHARS = 600;
const MIN_PROMPT_SKILL_SCORE = 5;
const HIGH_RELEVANCE_SCORE = 14;
const STOP_SEARCH_TOKENS = new Set([
  "a",
  "an",
  "and",
  "add",
  "create",
  "make",
  "new",
  "the",
  "to",
  "update",
  "with",
]);
const XUI_PROMPT_TOKENS = new Set(["button", "class", "style", "sheet", "ui", "view", "xui", "flow"]);
const FLOW_PROMPT_TOKENS = new Set(["flow", "workflow", "trigger", "run", "execute", "call"]);
const ENTITY_PROMPT_TOKENS = new Set(["entity", "entities", "schema", "users", "user", "records", "crud"]);



function has_value(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function truncate_text(value: string, max_chars: number): string {
  if (value.length <= max_chars) return value;
  return `${value.slice(0, Math.max(0, max_chars - 18))}\n...[truncated]`;
}

function compact_json(value: unknown, max_chars = MAX_JSON_CHARS): string {
  return truncate_text(JSON.stringify(value, null, 2), max_chars);
}

function compact_inline_json(value: unknown, max_chars = MAX_JSON_CHARS): string {
  return truncate_text(JSON.stringify(value), max_chars);
}

function safe_compact_inline_json(value: unknown, max_chars = MAX_JSON_CHARS): string {
  try {
    return compact_inline_json(value, max_chars);
  } catch {
    return "";
  }
}

function omit_current_view(value: XVibeJsonObject | undefined): XVibeJsonObject | undefined {
  if (!value) return undefined;

  const result: XVibeJsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    if (key !== "_current_view") {
      result[key] = item;
    }
  }

  return result;
}

function compact_array(value: unknown, max_items = MAX_ARRAY_ITEMS): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, max_items);
}

function format_identity(skill: VibeSkillDocument): string {
  const identity: XVibeJsonObject = {};

  for (const key of ["_id", "_title", "_version", "_type"] as const) {
    if (has_value(skill[key])) {
      identity[key] = skill[key];
    }
  }

  return compact_json(identity);
}

function format_string_array_section(title: string, value: unknown): string[] {
  const items = compact_array(value).filter((item): item is string => typeof item === "string");
  if (items.length === 0) return [];

  return [
    `${title}:`,
    ...items.map((item) => `- ${item}`),
  ];
}

function compact_pattern(pattern: unknown): unknown {
  if (!pattern || typeof pattern !== "object" || Array.isArray(pattern)) return pattern;

  const source = pattern as XVibeJsonObject;
  const compact: XVibeJsonObject = {};

  for (const key of ["_name", "_description", "_example"] as const) {
    if (has_value(source[key])) {
      compact[key] = source[key];
    }
  }

  return compact;
}

function compact_anti_pattern(pattern: unknown): unknown {
  if (typeof pattern === "string") return pattern;
  if (!pattern || typeof pattern !== "object" || Array.isArray(pattern)) return pattern;

  const source = pattern as XVibeJsonObject;
  const compact: XVibeJsonObject = {};

  for (const key of ["_bad", "_reason"] as const) {
    if (has_value(source[key])) {
      compact[key] = source[key];
    }
  }

  return compact;
}

function compact_example(example: unknown): unknown {
  if (!example || typeof example !== "object" || Array.isArray(example)) return example;
  return example;
}

function format_json_section(title: string, value: unknown): string[] {
  if (!has_value(value)) return [];

  return [
    `${title}:`,
    compact_json(value),
  ];
}

function format_skill(skill: VibeSkillDocument, max_chars: number): string {
  const lines: string[] = [
    "identity:",
    format_identity(skill),
    ...format_string_array_section("priority_rules", skill._priority_rules),
    ...format_string_array_section("core_rules", skill._core_rules),
    ...format_json_section("fields", skill._fields),
    ...format_json_section("exports", skill._exports),
  ];

  const patterns = compact_array(skill._patterns, MAX_PATTERN_ITEMS).map(compact_pattern);
  if (patterns.length > 0) {
    lines.push("patterns:", compact_json(patterns));
  }

  const canonical_examples = compact_array(skill._canonical_examples, MAX_EXAMPLE_ITEMS).map(compact_example);
  if (canonical_examples.length > 0) {
    lines.push("canonical_examples:", compact_json(canonical_examples));
  }

  const anti_patterns = compact_array(skill._anti_patterns, MAX_PATTERN_ITEMS).map(compact_anti_pattern);
  if (anti_patterns.length > 0) {
    lines.push("anti_patterns:", compact_json(anti_patterns));
  }

  return truncate_text(lines.join("\n"), max_chars);
}

function format_skills_block(
  selection: VibeKnowledgeSelection,
  max_skill_chars: number,
  max_total_chars: number,
): string {
  if (selection.skills.length === 0) return "No dynamic skills selected.";

  const blocks: string[] = [];
  let total_chars = 0;

  for (const skill of selection.skills) {
    const block = format_skill(skill, max_skill_chars);
    const separator_chars = blocks.length > 0 ? "\n\n---\n\n".length : 0;
    if (total_chars + separator_chars + block.length > max_total_chars) {
      break;
    }

    blocks.push(block);
    total_chars += separator_chars + block.length;
  }

  return blocks.length > 0 ? blocks.join("\n\n---\n\n") : "No dynamic skills selected within prompt budget.";
}

function field_names(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  }

  if (!value || typeof value !== "object") return [];

  return Object.keys(value).filter((key) => key.trim().length > 0);
}

function string_items(value: unknown, max_items: number): string[] {
  return compact_array(value, max_items)
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function unique_strings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function skill_id(skill: VibeSkillDocument): string {
  return typeof skill?._id === "string" && skill._id.trim().length > 0
    ? skill._id.trim()
    : "unknown";
}

function skill_type_names(skill: VibeSkillDocument): string[] {
  const source = skill as XVibeJsonObject;
  const out = [skill_id(skill)];
  const exports_obj = source._exports;
  const xui_objects = exports_obj && typeof exports_obj === "object"
    ? (exports_obj as XVibeJsonObject)._xui_objects
    : undefined;

  if (Array.isArray(xui_objects)) {
    out.push(
      ...xui_objects.filter(
        (item): item is string => typeof item === "string" && item.trim().length > 0,
      ),
    );
  }

  return unique_strings(out.map((item) => item.trim()).filter((item) => item.length > 0));
}

function normalize_search_text(value: unknown): string {
  if (typeof value === "string") return _xu.normalizePrompt(value).toLowerCase();
  if (typeof value === "number" || typeof value === "boolean") return String(value).toLowerCase();
  if (Array.isArray(value)) return value.map(normalize_search_text).filter(Boolean).join(" ");
  if (value && typeof value === "object") {
    try {
      return _xu.normalizePrompt(JSON.stringify(value)).toLowerCase();
    } catch {
      return "";
    }
  }

  return "";
}

function search_tokens(value: unknown): string[] {
  return unique_strings(
    normalize_search_text(value)
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length >= 2 && !STOP_SEARCH_TOKENS.has(token)),
  );
}

function score_text_match(
  prompt_text: string,
  prompt_tokens: Set<string>,
  value: unknown,
  weight: number,
  reason: string,
): { score: number; reasons: string[] } {
  const normalized = normalize_search_text(value);
  if (!normalized) return { score: 0, reasons: [] };

  const tokens = search_tokens(normalized);
  let matches = 0;

  for (const token of tokens) {
    if (prompt_tokens.has(token)) matches += 1;
  }

  let score = Math.min(matches, 3) * weight;
  const reasons: string[] = [];

  if (matches > 0) {
    reasons.push(`${reason}:${matches}`);
  }

  if (normalized.length >= 3 && prompt_text.includes(normalized)) {
    score += weight * 2;
    reasons.push(`${reason}:phrase`);
  }

  return { score, reasons };
}

function add_score(
  target: { score: number; reasons: string[] },
  input: { score: number; reasons: string[] },
): void {
  if (input.score <= 0) return;
  target.score += input.score;
  target.reasons.push(...input.reasons);
}

function skill_search_fields(skill: VibeSkillDocument): XVibeJsonObject {
  const source: XVibeJsonObject = skill && typeof skill === "object" ? skill : {};
  const fields = source._fields && typeof source._fields === "object" ? source._fields : {};

  return {
    id: source._id,
    title: source._title,
    description: source._description,
    field_keys: Object.keys(fields),
    field_values: Object.values(fields),
    priority_rules: source._priority_rules,
    core_rules: source._core_rules,
    examples: source._canonical_examples,
  };
}

function skill_requires(skill: VibeSkillDocument): string[] {
  return string_items((skill as XVibeJsonObject)._requires, MAX_ARRAY_ITEMS);
}

function has_any_token(tokens: Set<string>, expected: Set<string>): boolean {
  for (const token of expected) {
    if (tokens.has(token)) return true;
  }

  return false;
}

function is_xui_skill(skill: VibeSkillDocument): boolean {
  const source = skill as XVibeJsonObject;
  const id = skill_id(skill);
  const type = typeof source._type === "string" ? source._type : "";
  const exports_obj = source._exports;
  const xui_objects = exports_obj && typeof exports_obj === "object"
    ? (exports_obj as XVibeJsonObject)._xui_objects
    : undefined;

  return (
    id === "xui-core" ||
    id.startsWith("xui-") ||
    type === "xui-object" ||
    type === "view-skill" ||
    Array.isArray(xui_objects)
  );
}

function domain_noise_penalty(skill: VibeSkillDocument, prompt_tokens: Set<string>): number {
  const id = skill_id(skill);
  const source = skill as XVibeJsonObject;
  const type = typeof source._type === "string" ? source._type : "";

  if ((id.includes("flow") || type.includes("flow")) && !has_any_token(prompt_tokens, FLOW_PROMPT_TOKENS)) {
    return 1_000;
  }

  if (
    (id.includes("entity") || id.includes("xdb") || type.includes("entity")) &&
    !has_any_token(prompt_tokens, ENTITY_PROMPT_TOKENS)
  ) {
    return 1_000;
  }

  return 0;
}

function collect_context_types(value: unknown, target = new Set<string>()): Set<string> {
  if (!value || typeof value !== "object") return target;

  if (Array.isArray(value)) {
    for (const item of value) collect_context_types(item, target);
    return target;
  }

  const node = value as XVibeJsonObject;
  if (typeof node._type === "string" && node._type.trim().length > 0) {
    target.add(node._type.trim());
  }

  for (const item of Object.values(node)) {
    collect_context_types(item, target);
  }

  return target;
}

export function rankSkillsForPrompt(
  prompt: string,
  skills: VibeSkillDocument[],
  runtimeContext?: unknown,
): SkillRelevance[] {
  const selected_skills = Array.isArray(skills) ? skills : [];
  const prompt_text = normalize_search_text(prompt);
  const prompt_tokens = new Set(search_tokens(prompt));
  const context_types = collect_context_types(runtimeContext);
  const scored = new Map<string, SkillRelevance>();

  for (const skill of selected_skills) {
    const id = skill_id(skill);
    const fields = skill_search_fields(skill);
    const relevance: SkillRelevance = {
      skill,
      score: 0,
      reasons: [],
    };

    add_score(relevance, score_text_match(prompt_text, prompt_tokens, fields.id, 8, "id"));
    add_score(relevance, score_text_match(prompt_text, prompt_tokens, fields.title, 5, "title"));
    add_score(relevance, score_text_match(prompt_text, prompt_tokens, fields.description, 3, "description"));
    add_score(relevance, score_text_match(prompt_text, prompt_tokens, fields.field_keys, 4, "fields"));
    add_score(relevance, score_text_match(prompt_text, prompt_tokens, fields.field_values, 2, "field-values"));
    add_score(relevance, score_text_match(prompt_text, prompt_tokens, fields.priority_rules, 4, "priority-rules"));
    add_score(relevance, score_text_match(prompt_text, prompt_tokens, fields.core_rules, 3, "core-rules"));
    add_score(relevance, score_text_match(prompt_text, prompt_tokens, fields.examples, 6, "examples"));

    if (id === "xpell-contract") {
      relevance.score += 8;
      relevance.reasons.push("structural");
    }

    if (id === "xfm-flow" && has_any_token(prompt_tokens, FLOW_PROMPT_TOKENS)) {
      relevance.score += 8;
      relevance.reasons.push("flow-primary");
    }

    if (skill_type_names(skill).some((type_name) => context_types.has(type_name))) {
      relevance.score += 6;
      relevance.reasons.push("current-view-type");
    }

    if (isWeakSkill(skill)) {
      if (id !== "xpell-contract" && id !== "xui-core") {
        relevance.score -= 3;
        relevance.reasons.push("weak-skill-penalty");
      }
    }

    const noise_penalty = domain_noise_penalty(skill, prompt_tokens);
    if (noise_penalty > 0) {
      relevance.score -= noise_penalty;
      relevance.reasons.push("domain-noise-penalty");
    }

    relevance.score = Math.max(0, relevance.score);
    scored.set(id, relevance);
  }

  const high_skill_ids = new Set(
    Array.from(scored.values())
      .filter((item) => item.score >= HIGH_RELEVANCE_SCORE)
      .map((item) => skill_id(item.skill)),
  );
  const has_high_xui_skill = Array.from(scored.values())
    .some((item) => item.score >= HIGH_RELEVANCE_SCORE && skill_id(item.skill) !== "xui-core" && is_xui_skill(item.skill));
  const xui_core = scored.get("xui-core");

  if (xui_core && (has_high_xui_skill || has_any_token(prompt_tokens, XUI_PROMPT_TOKENS))) {
    xui_core.score += 8;
    xui_core.reasons.push("xui-structural");
  }

  for (const item of scored.values()) {
    if (item.reasons.includes("domain-noise-penalty")) {
      continue;
    }

    for (const required_id of skill_requires(item.skill)) {
      const required = scored.get(required_id);

      if (required && item.score >= HIGH_RELEVANCE_SCORE && required_id !== "xpell-contract") {
        required.score += required_id === "button" ? 10 : 6;
        required.reasons.push(`required-by:${skill_id(item.skill)}`);
      }

      if (high_skill_ids.has(required_id)) {
        item.score += 6;
        item.reasons.push(`requires-high-score:${required_id}`);
      }
    }
  }

  return Array.from(scored.values())
    .filter((item) => item.score > 0)
    .sort((a, b) => {
      const score_delta = b.score - a.score;
      if (score_delta !== 0) return score_delta;

      const structural_order = (id: string) => id === "xui-core" ? 0 : id === "xpell-contract" ? 1 : 2;
      const structural_delta = structural_order(skill_id(a.skill)) - structural_order(skill_id(b.skill));
      if (structural_delta !== 0) return structural_delta;

      return skill_id(a.skill).localeCompare(skill_id(b.skill));
    });
}

export function skillRelevanceDiagnostics(rankedSkills: SkillRelevance[]): Array<{
  id: string;
  score: number;
  reasons: string[];
}> {
  return rankedSkills.map((item) => ({
    id: skill_id(item.skill),
    score: item.score,
    reasons: item.reasons,
  }));
}

export function budgetSkills(
  rankedSkills: SkillRelevance[],
  maxPromptChars: number,
): BudgetedSkillRelevance[] {
  const candidates = rankedSkills.filter((item) => item.score >= MIN_PROMPT_SKILL_SCORE);
  const score_total = candidates.reduce((sum, item) => sum + Math.max(1, item.score), 0);
  const budgeted: BudgetedSkillRelevance[] = [];
  let used_chars = 0;

  for (const item of candidates) {
    const separator_chars = budgeted.length > 0 ? "\n---\n".length : 0;
    const remaining_chars = maxPromptChars - used_chars - separator_chars;
    if (remaining_chars <= 0) break;

    const weak = isWeakSkill(item.skill);
    const min_chars = weak ? 120 : MIN_REFINE_SKILL_CHARS;
    const proportional_chars = Math.floor(maxPromptChars * (item.score / Math.max(1, score_total)));
    const skill_budget = Math.min(
      MAX_REFINE_SKILL_CHARS,
      remaining_chars,
      Math.max(min_chars, proportional_chars),
    );

    if (skill_budget < min_chars) break;

    budgeted.push({
      ...item,
      budget: skill_budget,
      include_example: !weak && item.score >= 12 && skill_budget >= 260,
    });
    used_chars += separator_chars + skill_budget;
  }

  return budgeted;
}

export function isWeakSkill(skill: VibeSkillDocument): boolean {
  const source: XVibeJsonObject = skill && typeof skill === "object" ? skill : {};

  return (
    string_items(source._core_rules, MAX_ARRAY_ITEMS).length === 0 &&
    string_items(source._priority_rules, MAX_ARRAY_ITEMS).length === 0 &&
    compact_array(source._canonical_examples, 1).length === 0
  );
}

function format_skill_mini(
  skill: VibeSkillDocument,
  max_chars: number,
  opts: { include_example?: boolean } = {},
): string {
  try {
    const source: XVibeJsonObject = skill && typeof skill === "object" ? skill : {};
    const skill_id = typeof source._id === "string" && source._id.trim().length > 0
      ? source._id.trim()
      : "unknown";
    const description = typeof source._description === "string"
      ? source._description.trim()
      : "";
    const fields = field_names(source._fields);
    const rules = unique_strings([
      ...string_items(source._priority_rules, 3),
      ...string_items(source._core_rules, 5),
    ]);
    const canonical_example = compact_array(source._canonical_examples, 1)[0];

    const lines = [
      description ? `SKILL ${skill_id}: ${description}` : `SKILL ${skill_id}`,
    ];

    if (fields.length > 0) {
      lines.push(`Fields: ${fields.join(", ")}`);
    }

    if (opts.include_example !== false && has_value(canonical_example)) {
      const example = safe_compact_inline_json(canonical_example, MAX_REFINE_EXAMPLE_CHARS);
      if (example) {
        lines.push(`Ex: ${example}`);
      }
    }

    if (rules.length > 0) {
      lines.push(`Rules: ${rules.join(" | ")}`);
    }

    return truncate_text(lines.join("\n"), max_chars);
  } catch {
    return "SKILL unknown";
  }
}

function format_mini_skills_block(
  selection: VibeKnowledgeSelection,
  max_total_chars: number,
  prompt = "",
  runtimeContext?: unknown,
): string {
  const skills = Array.isArray(selection.skills) ? selection.skills : [];
  if (skills.length === 0) return "No refine skill guidance selected.";

  const blocks: string[] = [];
  let total_chars = 0;
  const budgeted_skills = budgetSkills(
    rankSkillsForPrompt(prompt, skills, runtimeContext),
    max_total_chars,
  );

  for (const item of budgeted_skills) {
    const separator_chars = blocks.length > 0 ? "\n---\n".length : 0;
    const remaining_total_chars = max_total_chars - total_chars - separator_chars;
    if (remaining_total_chars <= 0) break;

    const block = format_skill_mini(
      item.skill,
      Math.min(item.budget, remaining_total_chars),
      { include_example: item.include_example },
    );
    if (total_chars + separator_chars + block.length > max_total_chars) {
      break;
    }

    blocks.push(block);
    total_chars += separator_chars + block.length;
  }

  return blocks.length > 0 ? blocks.join("\n---\n") : "No relevant refine skill guidance selected within prompt budget.";
}

function collect_xui_types(
  selection: VibeKnowledgeSelection
): string[] {

  const types =
    new Set<string>();

  for (const skill of selection.skills) {

    const exports_obj =
      skill._exports;

    if (
      !exports_obj ||
      typeof exports_obj !== "object"
    ) {
      continue;
    }

    const xui_objects =
      (exports_obj as any)
        ?._xui_objects;

    if (!Array.isArray(xui_objects)) {
      continue;
    }

    for (const item of xui_objects) {

      if (
        typeof item === "string" &&
        item.trim()
      ) {
        types.add(item.trim());
      }
    }
  }

  return [...types];
}

function collect_skeleton_xui_types(value: unknown, target = new Set<string>()): string[] {
  if (!value || typeof value !== "object") return [...target];

  if (Array.isArray(value)) {
    for (const item of value) {
      collect_skeleton_xui_types(item, target);
    }
    return [...target];
  }

  const node = value as XVibeJsonObject;
  if (typeof node._type === "string" && node._type.trim().length > 0) {
    target.add(node._type.trim());
  }

  if (Array.isArray(node._children)) {
    collect_skeleton_xui_types(node._children, target);
  }

  return [...target];
}

function output_contract_for_artifact(artifact_type: VibeArtifactType): string {
  if (artifact_type === "flow") {
    return '{ "_artifact_type": "flow", "_contract_version": 1, "_flow": { "_id": "...", "_steps": [] } }';
  }

  if (artifact_type === "entity") {
    return '{ "_artifact_type": "entity", "_contract_version": 1, "_entity": { "_id": "...", "_schema": {} } }';
  }

  if (artifact_type === "command") {
    return '{ "_artifact_type": "command", "_contract_version": 1, "_command": { "_module": "...", "_op": "...", "_params": {} } }';
  }

  return '{ "_artifact_type": "view", "_contract_version": 1, "_view": { "_id": "...", "_type": "<valid-xui-object>", "_children": [] } }';
}

function artifact_rule(artifact_type: VibeArtifactType): string {
  if (artifact_type === "flow") {
    return 'Root MUST be exactly { "_artifact_type": "flow", "_contract_version": 1, "_flow": { "_id": "...", "_steps": [...] } }.';
  }

  if (artifact_type === "entity") {
    return 'Root MUST be exactly { "_artifact_type": "entity", "_contract_version": 1, "_entity": { "_id": "...", "_schema": {...} } }.';
  }

  if (artifact_type === "command") {
    return 'Root MUST be exactly { "_artifact_type": "command", "_contract_version": 1, "_command": { "_module": "...", "_op": "...", "_params": {...} } }.';
  }

  return 'Root MUST be exactly { "_artifact_type": "view", "_contract_version": 1, "_view": { "_id": "...", "_type": "<valid XUIObject type>", "_children": [...] } }.';
}

export function infer_artifact_type(
  prompt: string,
  requested_artifact_type?: VibeRequestedArtifactType,
): VibeArtifactType {
  if (
    requested_artifact_type === "view" ||
    requested_artifact_type === "flow" ||
    requested_artifact_type === "entity" ||
    requested_artifact_type === "command"
  ) {
    return requested_artifact_type;
  }

  const normalized_prompt = _xu.normalizePrompt(prompt).toLowerCase();

  if (/\b(view|screen|page|ui)\b/.test(normalized_prompt)) return "view";
  if (/\b(flow|workflow|steps)\b/.test(normalized_prompt)) return "flow";
  if (/\b(entity|schema|model)\b/.test(normalized_prompt)) return "entity";
  if (/\b(command|op)\b/.test(normalized_prompt)) return "command";

  return "view";
}

export class VibePromptBuilder {
  private readonly max_skill_prompt_chars: number;
  private readonly max_total_skill_prompt_chars: number;
  private readonly max_refine_skill_prompt_chars: number;
  private readonly max_prompt_chars: number;
  private readonly max_user_task_chars: number;

  constructor(opts: {
    _max_skill_prompt_chars?: number;
    _max_total_skill_prompt_chars?: number;
    _max_refine_skill_prompt_chars?: number;
    _max_prompt_chars?: number;
    _max_user_task_chars?: number;
  } = {}) {
    this.max_skill_prompt_chars = opts._max_skill_prompt_chars ?? DEFAULT_MAX_SKILL_PROMPT_CHARS;
    this.max_total_skill_prompt_chars = opts._max_total_skill_prompt_chars ?? DEFAULT_MAX_TOTAL_SKILL_PROMPT_CHARS;
    this.max_refine_skill_prompt_chars = opts._max_refine_skill_prompt_chars ?? DEFAULT_MAX_REFINE_SKILL_PROMPT_CHARS;
    this.max_prompt_chars = opts._max_prompt_chars ?? DEFAULT_MAX_PROMPT_CHARS;
    this.max_user_task_chars = opts._max_user_task_chars ?? DEFAULT_MAX_USER_TASK_CHARS;
  }

  private build_artifact_specific_rules(
    artifact_type: VibeArtifactType,
  ): string[] {

    if (artifact_type === "view") {
      return [
        "VIEW RULES:",
        "- Use semantic XUI objects.",
        "- Use stack/grid/toolbar/card/field when appropriate.",
        "- Use button for clickable actions.",
        "- Use label with _text.",
        "- Use class, not _class.",
        "- When styling is requested, style-sheet MUST be the first child in _children.",
        "- Never generate empty semantic objects.",
        "- Every semantic object must include minimal runtime-safe fields.",
        "- Buttons need visible _text or _label.",
        "- Do NOT add _flow to buttons unless the user explicitly mentions a flow id or explicitly asks for the button to trigger/run/execute/call a flow.",
        "- Plain buttons are visual/actionless buttons.",
        "- If no explicit flow is requested, buttons must contain _text or _label only and must not contain _flow.",
        "- Never invent flow ids such as flow-action-1, flow-submit, flow-save, etc.",
        "- Button click actions must be placed under _on._click.",
        "- Do not use button-level _command.",
        '- Use _on._click: { "_module": "...", "_op": "...", "_params": {} } for a single command.',
        "- Use _on._click: [ ... ] for sequential command chains.",
        '- Object-targeted local nano commands may use { "_object": "target-id", "_op": "set-text", "_params": {} }.',
        "- Module commands require _module.",
        "- Object nano commands require _object.",
        "- Do not put _params directly under _on.",
        "- field is a wrapper only.",
        "- field input config goes in _control.",
        "- never put _name or _placeholder directly on field.",
        '- Fields require _control with _type and name or _name for input-like controls.',
        "- Tables need _columns or a valid _data_source.",
        "- KPI cards need _label/_title and _value.",
        "- Navlists need _items or navigation children.",
        "- Modals and drawers need content or children.",
        "- Cards, grids, sidebars, toolbars, and xsections need meaningful children.",
        "- Prefer XDashboard objects when available.",
        "- Do not use generic view objects when a semantic object exists.",
      ];
    }

    if (artifact_type === "flow") {
      return [
        "FLOW RULES:",
        "- NEVER generate XUI objects.",
        "- NEVER generate _children trees.",
        "- NEVER generate views, pages, layouts, or UI components.",
        "- Flow steps MUST be runtime command steps only.",
        '- Valid flow step format: { "_id": "...", "_module": "...", "_op": "...", "_params": {} }.',
        "- Do not generate root-level _flow._output; use step-level _output only.",
        "- Generate deterministic flow steps.",
        "- Use valid _id values.",
        "- Prefer entity-manager/entity-client for data mutations.",
        "- Flows must be data-driven and JSON-only.",

        "RUNTIME MODULE CONTRACT:",

        '- Use module "xd" for XData operations.',
        '- NEVER use modules "xdata" or "xdata-binding".',
        "- Valid xd ops: get, set, patch, delete, touch, has.",

        "- Valid entity-client ops: get, find, add, update, delete, sync_entity.",
        "- Valid xem ops: fire, on, off."
      ];
    }

    if (artifact_type === "entity") {
      return [
        "ENTITY RULES:",
        "- Generate valid XDB entity schemas.",
        "- Use semantic field names.",
        "- Prefer searchable/vectorizable structures.",
      ];
    }

    if (artifact_type === "command") {
      return [
        "COMMAND RULES:",
        "- Generate valid XCommand structures.",
        "- Use _module, _op, _params.",
      ];
    }

    return [];
  }

  private build_refine(input: VibePromptBuildInput): string {
    const output_contract = output_contract_for_artifact(input._artifact_type);
    const normalized_user_task = truncate_text(_xu.normalizePrompt(input.prompt), this.max_user_task_chars);
    const current_view = input.runtime_context?._current_view;

    if (!has_value(current_view)) {
      throw new Error("XVibe refine prompt requires runtime_context._current_view");
    }

    const runtime_context_without_current_view = omit_current_view(input.runtime_context);
    const runtime_context = has_value(runtime_context_without_current_view)
      ? compact_json(runtime_context_without_current_view, MAX_JSON_CHARS)
      : "No runtime context injected.";
    const current_view_json = compact_json(current_view, MAX_CURRENT_VIEW_JSON_CHARS);
    const refine_skills_block = format_mini_skills_block(
      input.selection,
      this.max_refine_skill_prompt_chars,
      input.prompt,
      input.runtime_context,
    );

    const allowed_xui_objects =
      Array.from(new Set([
        ...collect_xui_types(input.selection),
        ...collect_skeleton_xui_types(current_view),
      ]));

    const prompt = [
      "You are an Xpell JSON artifact editor.",
      "Return ONLY JSON.",
      "",
      "ARTIFACT CONTRACT:",
      "1. Output MUST be valid JSON.",
      "2. DO NOT return markdown.",
      "3. DO NOT return explanations.",
      "4. DO NOT return HTML, CSS, JavaScript, or framework code.",
      "5. Use only data-only Xpell JSON.",
      `6. ${artifact_rule(input._artifact_type)}`,
      "7. Runtime-managed fields must use _snake_case.",
      "8. No functions, only JSON-compatible data.",
      "9. _children MUST be arrays when present.",
      "10. Do not include extra artifact roots or alternate raw root formats.",
      `11. _contract_version MUST be ${XVIBE_ARTIFACT_CONTRACT_VERSION}.`,
      "",
      "Allowed XUIObject _type values:",
      ...(allowed_xui_objects.length > 0
        ? allowed_xui_objects.map((v) => `- ${v}`)
        : ["- view"]),
      "",
      "ONLY use _type values from the allowed list above.",
      "NEVER invent new _type values.",
      "",
      "REFINE RULES:",
      "- You are editing an existing view.",
      "- Current View JSON is the source of truth.",
      "- Return the FULL updated view.",
      "- Preserve existing structure unless the user explicitly asks to remove or replace it.",
      "- Do not generate only fragments.",
      "- Do not return partial updates.",
      "- Do not invent unrelated layout.",
      "- Apply the user's request to the existing view.",
      "",

      // 👇 keep semantic view rules in refine mode too
      ...this.build_artifact_specific_rules(
        input._artifact_type
      ),

      "",
      "Refine Skill Guidance:",
      refine_skills_block,
      "",
      "Current View JSON:",
      current_view_json,
      "",
      "Runtime Context:",
      runtime_context,
      "",
      "User Edit Request:",
      normalized_user_task,
      "",
      "OUTPUT CONTRACT:",
      `Return ONLY this shape: ${output_contract}`,
    ].join("\n");

    if (prompt.length > this.max_prompt_chars) {
      throw new Error(
        `XVibe refine prompt exceeds maximum size of ${this.max_prompt_chars} characters after deterministic trimming`,
      );
    }

    return prompt;
  }

  build(input: VibePromptBuildInput): string {
    if (input._mode === "refine") {
      return this.build_refine(input);
    }

    const skills_block = format_skills_block(
      input.selection,
      this.max_skill_prompt_chars,
      this.max_total_skill_prompt_chars,
    );
    const output_contract = output_contract_for_artifact(input._artifact_type);
    const normalized_user_task = truncate_text(_xu.normalizePrompt(input.prompt), this.max_user_task_chars);
    const runtime_context = has_value(input.runtime_context)
      ? compact_json(input.runtime_context, MAX_JSON_CHARS)
      : "No runtime context injected.";
    const deterministic_skeleton =
      input._artifact_type === "view" && has_value(input.deterministic_skeleton)
        ? compact_json(input.deterministic_skeleton, MAX_SKELETON_JSON_CHARS)
        : "";

    const allowed_xui_objects =
      Array.from(new Set([
        ...collect_xui_types(
          input.selection
        ),
        ...collect_skeleton_xui_types(input.deterministic_skeleton),
      ]));
    const prompt = [
      "You are an Xpell JSON artifact generator.",
      "Return ONLY JSON.",
      "",
      "STRICT RULES:",
      "1. Output MUST be valid JSON.",
      "2. DO NOT return markdown.",
      "3. DO NOT return explanations.",
      "4. DO NOT return HTML, CSS, JavaScript, or framework code.",
      "5. Use only data-only Xpell JSON.",
      `6. ${artifact_rule(input._artifact_type)}`,
      "7. Runtime-managed fields must use _snake_case.",
      "8. No functions, only JSON-compatible data.",
      "9. Deterministic output only.",
      "10. Xpell is not React, Vue, DOM, or HTML.",
      "11. _children MUST be arrays when present.",
      "12. Do not emit JSX, React/Vue syntax, DOM APIs, selectors, event listeners, CSS, scripts, or comments.",
      "13. Do not emit raw HTML unless the XUIObject explicitly uses _type:\"xhtml\".",
      "14. Do not include extra artifact roots or alternate raw root formats.",
      `15. _contract_version MUST be ${XVIBE_ARTIFACT_CONTRACT_VERSION}.`,
      "",
      `Generation Mode: ${input._mode}`,
      `Artifact Type: ${input._artifact_type}`,
      "",
      "Selected Skill IDs:",
      input.selection.skill_ids.join(", "),
      "",
      "Allowed XUIObject _type values:",
      ...(allowed_xui_objects.length > 0
        ? allowed_xui_objects.map(
          (v) => `- ${v}`
        )
        : ["- view"]),
      "",
      "ONLY use _type values from the allowed list above.",
      "NEVER invent new _type values.",
      "Use semantic UI objects whenever possible.",
      "Prefer button over generic view for actions.",
      "Prefer field for form inputs.",
      "Prefer stack/grid/toolbar for layout.",
      "Prefer label for text output.",
      "",
      ...this.build_artifact_specific_rules(
        input._artifact_type
      ),

      "",
      "Selected Skills:",
      skills_block,
      "",
      "Runtime Context:",
      runtime_context,
      "",
      "Generated artifacts in runtime context may be referenced when building new artifacts.",
      ...(deterministic_skeleton
        ? [
          "",
          "Deterministic View Skeleton:",
          deterministic_skeleton,
          "",
          "SKELETON RULES:",
          "- Use the deterministic skeleton as the starting _view.",
          "- Preserve skeleton structure, ordering, _id, _type, and required _children arrays.",
          "- Preserve every _flow object exactly; do not replace interaction contracts.",
          "- Button click actions must be placed under _on.click. (Runtime also accepts _click for backward compatibility.)",
          "- Do not use _action, onClick, onclick, handler, callback, or button-level _command.",
          '- Use _on._click: { "_module": "...", "_op": "...", "_params": {} } for a single command.',
          "- Use _on._click: [ ... ] for sequential command chains.",
          '- Object-targeted local nano commands may use { "_object": "target-id", "_op": "set-text", "_params": {} }.',
          "- Module commands require _module.",
          "- Object nano commands require _object.",
          "- Do not put _params directly under _on.",
          "- Preserve field wrapper contracts: input config belongs inside _control.",
          "- Never put _name or _placeholder directly on field.",
          "- Only fill or edit labels, titles, placeholders, columns, bindings, values, variants, and classes.",
          "- Do not remove required fields needed by the semantic validator.",
        ]
        : []),
      "",
      "User Task:",
      normalized_user_task,
      "",
      "OUTPUT CONTRACT:",
      `Return ONLY this shape: ${output_contract}`,
    ].join("\n");

    if (prompt.length > this.max_prompt_chars) {
      throw new Error(
        `XVibe prompt exceeds maximum size of ${this.max_prompt_chars} characters after deterministic trimming`,
      );
    }

    return prompt;
  }
}
