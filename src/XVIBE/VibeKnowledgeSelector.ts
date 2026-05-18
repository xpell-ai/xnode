import fs from "node:fs";
import path from "node:path";
import { _xlog } from "@xpell/core";
import { _xu} from "../XNUtils/XUtils.js";
import { VibeSelectionArtifactType } from "./XVibeTypes.js";


type XVibeJsonObject = {
  [key: string]: unknown;
};



export type VibeSkillDiagnostic = {
  _id: string;
  _score: number;
  _reasons: string[];
  _selected_as: "always" | "required" | "priority" | "optional";
  _dependency_source?: string;
};

export type VibeSkillDocument = XVibeJsonObject & {
  _id: string;
  _type: string;
  _active?: boolean;
  _match?: VibeSkillMatch;
};

export type VibeKnowledgeSelection = {
  skill_ids: string[];
  skills: VibeSkillDocument[];
  diagnostics: VibeSkillDiagnostic[];
};

type VibeSkillMatch = {
  _keywords?: string[];
  _requires_any?: string[];
  _requires_all?: string[];
  _exclude_keywords?: string[];
  _priority?: number;
};

type VibeSkillIndex = {
  _autoload?: boolean;
  _skills_dir?: string;
  _always_include?: string[];
  _priority_order?: string[];
  _exclude_files?: string[];
  _skills?: string[];
  skills?: Array<string | { id?: string; path?: string; active?: boolean }>;
};

type SkillCandidate = {
  skill: VibeSkillDocument;
  always_index: number;
  priority_index: number;
  match_priority: number;
};

type ScoredSkill = SkillCandidate & {
  score: number;
  reasons: string[];
  selected_as: "always" | "required" | "priority" | "optional";
  dependency_source?: string;
};

type SkillSchemaInfo = {
  allowed_types: Set<string>;
};

const DEFAULT_MAX_SELECTED_SKILLS = 12;
const MIN_MATCH_SCORE = 2;
const TOKEN_REGEX_CACHE = new Map<string, RegExp[]>();

const ARRAY_FIELDS = [
  "_applies_to",
  "_requires",
  "_capabilities",
  "_core_rules",
  "_priority_rules",
  "_rules",
  "_patterns",
  "_canonical_examples",
  "_anti_patterns",
  "_notes",
] as const;

const MATCH_ARRAY_FIELDS = [
  "_keywords",
  "_requires_any",
  "_requires_all",
  "_exclude_keywords",
] as const;

function is_plain_object(value: unknown): value is XVibeJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function read_json(file_path: string): unknown | null {
  try {
    if (!fs.existsSync(file_path)) return null;
    return JSON.parse(fs.readFileSync(file_path, "utf-8")) as unknown;
  } catch {
    return null;
  }
}

function read_string_array(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function normalize_terms(terms: string[]): string[] {
  return terms.map((term) => _xu.normalizePrompt(term).toLowerCase()).filter((term) => term.length > 0);
}

function escape_regexp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function token_regexes_for_term(normalized_term: string): RegExp[] {
  const cached = TOKEN_REGEX_CACHE.get(normalized_term);
  if (cached) return cached;

  const regexes = normalized_term
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length >= 3)
    .map((token) => new RegExp(`\\b${escape_regexp(token)}\\b`, "u"));

  TOKEN_REGEX_CACHE.set(normalized_term, regexes);
  return regexes;
}

function contains_term(prompt: string, normalized_term: string): boolean {
  if (prompt.includes(normalized_term)) return true;

  const regexes = token_regexes_for_term(normalized_term);

  return regexes.length > 1
    && regexes.some((regex) => regex.test(prompt));
}

function matched_terms(prompt: string, terms: string[]): string[] {
  return normalize_terms(terms).filter((term) => contains_term(prompt, term));
}

function get_match(skill: VibeSkillDocument): VibeSkillMatch {
  return is_plain_object(skill._match) ? skill._match : {};
}

function get_match_priority(skill: VibeSkillDocument): number {
  const priority = get_match(skill)._priority;
  return typeof priority === "number" && Number.isFinite(priority) ? priority : 0;
}

function resolve_default_skills_root(): string {
  const candidates = [
    path.resolve(process.cwd(), "skills/xpell"),
    path.resolve(process.cwd(), "../skills/xpell"),
  ];

  return candidates.find((candidate) => fs.existsSync(path.join(candidate, "index.json")))
    ?? candidates[0];
}

function resolve_schema_file(skills_root: string, explicit_schema_file?: string): string {
  if (explicit_schema_file) return explicit_schema_file;

  const candidates = [
    path.join(skills_root, "xpell-skill.schema.json"),
    path.join(path.dirname(skills_root), "xpell-skill.schema.json"),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function unique_file_names(file_names: string[]): string[] {
  return Array.from(new Set(file_names));
}

function debug_enabled(): boolean {
  return Boolean((_xlog as unknown as { _debug?: boolean })._debug);
}

function debug_log(message: string, data: XVibeJsonObject): void {
  if (debug_enabled()) {
    _xlog.log(message, data);
  }
}

function warn(message: string, data: XVibeJsonObject): void {
  _xlog.warn(message, data);
}

function artifact_skill_type(artifact_type?: VibeSelectionArtifactType): string | undefined {
  if (artifact_type === "view") return "view-skill";
  if (artifact_type === "flow") return "flow-skill";
  if (artifact_type === "entity") return "entity-skill";
  if (artifact_type === "command") return "runtime-api-skill";
  return undefined;
}

function is_generic_skill_type(skill_type: string): boolean {
  return skill_type === "general"
    || skill_type === "runtime-api-skill"
    || skill_type === "nano-command-pack"
    || skill_type === "server-module-api"
    || skill_type === "client-module-api"
    || skill_type === "wormholes-protocol"
    || skill_type === "xdata-skill";
}

export class VibeKnowledgeSelector {
  private readonly _skills_root: string;
  private readonly _index_file: string;
  private readonly _schema_file: string;
  private readonly _max_selected_skills: number;

  constructor(opts: {
    _skills_root?: string;
    _index_file?: string;
    _schema_file?: string;
    _max_selected_skills?: number;
  } = {}) {
    this._skills_root = opts._skills_root ?? resolve_default_skills_root();
    this._index_file = opts._index_file ?? path.join(this._skills_root, "index.json");
    this._schema_file = resolve_schema_file(this._skills_root, opts._schema_file);
    this._max_selected_skills = opts._max_selected_skills ?? DEFAULT_MAX_SELECTED_SKILLS;
  }

  select(
    prompt: string,
    artifact_type?: VibeSelectionArtifactType,
    capabilities: string[] = [],
  ): VibeKnowledgeSelection {
    const normalized_prompt = _xu.normalizePrompt(prompt).toLowerCase();
    const index = read_json(this._index_file);

    if (!is_plain_object(index)) {
      return this.empty_selection();
    }

    const schema = this.load_schema_info();
    const candidates = this.load_candidates(index, schema);
    const candidate_by_id = new Map(candidates.map((candidate) => [candidate.skill._id, candidate]));
    const scored = new Map<string, ScoredSkill>();

    for (const candidate of candidates) {
      const scored_skill = this.score_skill(normalized_prompt, candidate, artifact_type, capabilities);

      if (candidate.always_index >= 0 || scored_skill.score >= MIN_MATCH_SCORE) {
        scored.set(candidate.skill._id, scored_skill);
      }
    }

    for (const selected of Array.from(scored.values())) {
      this.include_dependencies(selected.skill._id, selected.skill._id, candidate_by_id, scored, new Set());
    }

    const ordered = Array.from(scored.values()).sort((a, b) => this.compare_scored(a, b));
    const selected = this.apply_optional_limit(ordered);

    for (const item of selected) {
      debug_log("[xvibe] skill selected", {
        _id: item.skill._id,
        _score: item.score,
        _reasons: item.reasons,
        _selected_as: item.selected_as,
        ...(item.dependency_source ? { _dependency_source: item.dependency_source } : {}),
      });
    }

    return {
      skill_ids: selected.map((candidate) => candidate.skill._id),
      skills: selected.map((candidate) => candidate.skill),
      diagnostics: selected.map((candidate) => ({
        _id: candidate.skill._id,
        _score: candidate.score,
        _reasons: candidate.reasons,
        _selected_as: candidate.selected_as,
        ...(candidate.dependency_source ? { _dependency_source: candidate.dependency_source } : {}),
      })),
    };
  }

  private empty_selection(): VibeKnowledgeSelection {
    return {
      skill_ids: [],
      skills: [],
      diagnostics: [],
    };
  }

  private load_schema_info(): SkillSchemaInfo {
    const raw_schema = read_json(this._schema_file);
    const enum_values = is_plain_object(raw_schema)
      && is_plain_object(raw_schema.properties)
      && is_plain_object(raw_schema.properties._type)
      ? read_string_array(raw_schema.properties._type.enum)
      : [];

    return {
      allowed_types: new Set(enum_values),
    };
  }

  private load_candidates(index: XVibeJsonObject, schema: SkillSchemaInfo): SkillCandidate[] {
    const skills_dir = typeof index._skills_dir === "string" && index._skills_dir.trim().length > 0
      ? index._skills_dir
      : ".";
    const skill_dir_path = path.resolve(this._skills_root, skills_dir);
    const excluded_files = new Set(read_string_array(index._exclude_files));
    const file_names = this.resolve_skill_file_names(index, skill_dir_path, excluded_files);
    const always_include = read_string_array(index._always_include);
    const priority_order = read_string_array(index._priority_order);
    const candidates: SkillCandidate[] = [];

    for (const file_name of file_names) {
      const skill_path = path.resolve(skill_dir_path, file_name);
      const raw_skill = read_json(skill_path);
      const skill = this.validate_skill(raw_skill, skill_path, schema);
      if (!skill) continue;

      if (skill._active === false) continue;

      candidates.push({
        skill,
        always_index: always_include.indexOf(skill._id),
        priority_index: priority_order.indexOf(skill._id),
        match_priority: get_match_priority(skill),
      });
    }

    return candidates;
  }

  private validate_skill(raw_skill: unknown, skill_path: string, schema: SkillSchemaInfo): VibeSkillDocument | null {
    if (!is_plain_object(raw_skill)) {
      warn("[xvibe] skipped invalid skill", { _path: skill_path, _reason: "expected object" });
      return null;
    }

    const id = typeof raw_skill._id === "string" ? raw_skill._id.trim() : "";
    if (!id) {
      warn("[xvibe] skipped invalid skill", { _path: skill_path, _reason: "missing _id" });
      return null;
    }

    const skill_type = typeof raw_skill._type === "string" && raw_skill._type.trim().length > 0
      ? raw_skill._type.trim()
      : "";

    if (!skill_type) {
      warn("[xvibe] skipped invalid skill", { _path: skill_path, _id: id, _reason: "missing _type" });
      return null;
    }

    if (schema.allowed_types.size > 0 && !schema.allowed_types.has(skill_type)) {
      warn("[xvibe] skipped invalid skill", { _path: skill_path, _id: id, _reason: "invalid _type" });
      return null;
    }

    if (!is_plain_object(raw_skill._match)) {
      warn("[xvibe] skipped invalid skill", { _path: skill_path, _id: id, _reason: "missing _match" });
      return null;
    }

    for (const field of ARRAY_FIELDS) {
      if (raw_skill[field] !== undefined && !Array.isArray(raw_skill[field])) {
        warn("[xvibe] skipped invalid skill", { _path: skill_path, _id: id, _reason: `${field} must be an array` });
        return null;
      }
    }

    for (const field of MATCH_ARRAY_FIELDS) {
      if (raw_skill._match[field] !== undefined && !Array.isArray(raw_skill._match[field])) {
        warn("[xvibe] skipped invalid skill", { _path: skill_path, _id: id, _reason: `_match.${field} must be an array` });
        return null;
      }
    }

    return {
      ...raw_skill,
      _id: id,
      _type: skill_type,
    } as VibeSkillDocument;
  }

  private resolve_skill_file_names(
    index: XVibeJsonObject,
    skill_dir_path: string,
    excluded_files: Set<string>,
  ): string[] {
    const explicit_skills = read_string_array(index._skills);
    const legacy_skills = Array.isArray(index.skills)
      ? index.skills.reduce<string[]>((items, item: unknown) => {
        if (typeof item === "string") {
          items.push(item);
          return items;
        }
        if (is_plain_object(item) && item.active !== false && typeof item.path === "string") {
          items.push(item.path);
        }
        return items;
      }, [])
      : [];

    const autoload_skills = index._autoload === true && fs.existsSync(skill_dir_path)
      ? fs.readdirSync(skill_dir_path)
        .filter((file_name) => file_name.endsWith(".json"))
        .filter((file_name) => !excluded_files.has(file_name))
      : [];

    return unique_file_names([...explicit_skills, ...legacy_skills, ...autoload_skills])
      .filter((file_name) => file_name.endsWith(".json"))
      .filter((file_name) => !excluded_files.has(path.basename(file_name)));
  }

  private score_skill(
    prompt: string,
    candidate: SkillCandidate,
    artifact_type?: VibeSelectionArtifactType,
    capabilities: string[] = [],
  ): ScoredSkill {
    const match = get_match(candidate.skill);
    const reasons: string[] = [];
    let score = 0;

    if (candidate.always_index >= 0) {
      score += 1000;
      reasons.push("always_include");
    }

    const excluded = matched_terms(prompt, read_string_array(match._exclude_keywords));
    if (excluded.length > 0) {
      score -= 100;
      reasons.push(`exclude:${excluded.join(",")}`);
    }

    const keyword_matches = matched_terms(prompt, read_string_array(match._keywords));
    if (keyword_matches.length > 0) {
      score += keyword_matches.length;
      reasons.push(`keywords:${keyword_matches.join(",")}`);
    }

    const any_matches = matched_terms(prompt, read_string_array(match._requires_any));
    if (any_matches.length > 0) {
      score += 2 + any_matches.length;
      reasons.push(`requires_any:${any_matches.join(",")}`);
    }

    const all_terms = read_string_array(match._requires_all);
    const all_matches = matched_terms(prompt, all_terms);
    if (all_terms.length > 0 && all_matches.length === all_terms.length) {
      score += 4 + all_matches.length;
      reasons.push(`requires_all:${all_matches.join(",")}`);
    }

    const expected_type = artifact_skill_type(artifact_type);
    if (expected_type && candidate.skill._type === expected_type) {
      score += 2;
      reasons.push(`artifact_type:${artifact_type}`);
    } else if (is_generic_skill_type(candidate.skill._type)) {
      score += 1;
      reasons.push("generic_type");
    }

    const requested_capabilities = new Set(
      capabilities.map((capability) => _xu.normalizePrompt(capability).toLowerCase()),
    );
    const skill_capabilities = read_string_array(candidate.skill._capabilities)
      .map((capability) => _xu.normalizePrompt(capability).toLowerCase());

    const capability_matches = skill_capabilities.filter((capability) => requested_capabilities.has(capability));
    if (capability_matches.length > 0) {
      score += 2 + capability_matches.length;
      reasons.push(`capabilities:${capability_matches.join(",")}`);
    }

    return {
      ...candidate,
      score,
      reasons,
      selected_as: candidate.always_index >= 0
        ? "always"
        : candidate.priority_index >= 0
          ? "priority"
          : "optional",
    };
  }

  private include_dependencies(
    selected_id: string,
    dependency_source: string,
    candidate_by_id: Map<string, SkillCandidate>,
    scored: Map<string, ScoredSkill>,
    seen: Set<string>,
  ): void {
    if (seen.has(selected_id)) return;
    seen.add(selected_id);

    const selected = candidate_by_id.get(selected_id);
    if (!selected) return;

    for (const required_id of read_string_array(selected.skill._requires)) {
      if (seen.has(required_id)) continue;

      const dependency = candidate_by_id.get(required_id);
      if (!dependency) continue;

      const existing = scored.get(required_id);
      if (existing) {
        if (existing.selected_as !== "always") {
          existing.selected_as = "required";
          existing.dependency_source = dependency_source;
          if (!existing.reasons.includes(`required_by:${dependency_source}`)) {
            existing.reasons.push(`required_by:${dependency_source}`);
          }
        }
        this.include_dependencies(required_id, dependency_source, candidate_by_id, scored, seen);
        continue;
      }

      const score = Math.max(1, dependency.match_priority / 100);
      const scored_dependency: ScoredSkill = {
        ...dependency,
        score,
        reasons: [`required_by:${dependency_source}`],
        selected_as: "required",
        dependency_source,
      };

      scored.set(required_id, scored_dependency);
      debug_log("[xvibe] dependency included", {
        _id: required_id,
        _score: score,
        _dependency_source: dependency_source,
      });

      this.include_dependencies(required_id, required_id, candidate_by_id, scored, seen);
    }
  }

  private compare_scored(a: ScoredSkill, b: ScoredSkill): number {
    const a_priority_group = this.selection_group(a);
    const b_priority_group = this.selection_group(b);

    if (a_priority_group !== b_priority_group) {
      return a_priority_group - b_priority_group;
    }

    if (a_priority_group === 0 || a_priority_group === 2) {
      const a_index = a.always_index >= 0 ? a.always_index : a.priority_index;
      const b_index = b.always_index >= 0 ? b.always_index : b.priority_index;
      if (a_index !== b_index) return a_index - b_index;
    }

    if (a.score !== b.score) return b.score - a.score;
    if (a.match_priority !== b.match_priority) return b.match_priority - a.match_priority;

    return a.skill._id.localeCompare(b.skill._id);
  }

  private selection_group(candidate: ScoredSkill): number {
    if (candidate.selected_as === "always") return 0;
    if (candidate.selected_as === "required") return 1;
    if (candidate.selected_as === "priority") return 2;
    return 3;
  }

  private apply_optional_limit(ordered: ScoredSkill[]): ScoredSkill[] {
    const selected: ScoredSkill[] = [];
    let optional_count = 0;

    for (const item of ordered) {
      if (item.selected_as !== "optional") {
        selected.push(item);
        continue;
      }

      if (optional_count < this._max_selected_skills) {
        selected.push(item);
        optional_count++;
      }
    }

    return selected;
  }
}
