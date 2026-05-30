import fs from "node:fs";
import path from "node:path";
import { _xlog } from "@xpell/core";
import { _xu } from "../XNUtils/XUtils.js";
import { VibeSelectionArtifactType, type VibeCapabilityNode, type VibeCapabilityNodeKind } from "./XVibeTypes.js";


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
  source: "static" | "runtime";
  runtime_kind?: "skill" | "object" | "module";
};

type ScoredSkill = SkillCandidate & {
  score: number;
  reasons: string[];
  selected_as: "always" | "required" | "priority" | "optional";
  dependency_source?: string;
  dependency_source_key?: string;
};

type SkillSchemaInfo = {
  allowed_types: Set<string>;
};

type CapabilityNodeCandidate = SkillCandidate & {
  node: VibeCapabilityNode;
};

type VibeNormalizedIntentPlan = {
  _active: boolean;
  _xui_objects: Set<string>;
  _modules: Set<string>;
  _entities: Set<string>;
  _capability_keywords: Set<string>;
  _crud_ops: Set<string>;
  _ui_patterns: Set<string>;
};

const DEFAULT_MAX_SELECTED_SKILLS = 12;
const MIN_MATCH_SCORE = 2;
const TOKEN_REGEX_CACHE = new Map<string, RegExp[]>();
const FLOW_ALLOWED_RUNTIME_OBJECT_SKILL_IDS = new Set([
  "xfm-flow",
  "entity-runtime",
  "xdb-entity",
  "xui-flow-trigger",
  "xpell-core",
  "xpell-contract",
]);

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

function is_runtime_object_candidate(candidate: SkillCandidate): boolean {
  if (candidate.source !== "runtime") return false;
  if (candidate.runtime_kind === "object") return true;

  return candidate.skill._type.includes("object")
    || (
      is_plain_object(candidate.skill._exports)
      && Array.isArray((candidate.skill._exports as XVibeJsonObject)._xui_objects)
    );
}

function skill_has_explicit_artifact_type_match(
  skill: VibeSkillDocument,
  artifact_type?: VibeSelectionArtifactType,
): boolean {
  if (!artifact_type) return false;

  const explicit_values = [
    ...read_string_array(skill._artifact_types),
    ...read_string_array(skill._applies_to),
    ...(typeof skill._artifact_type === "string" ? [skill._artifact_type] : []),
  ].map((value) => _xu.normalizePrompt(value).toLowerCase());

  return explicit_values.includes(artifact_type);
}

function normalize_intent_terms(value: unknown): Set<string> {
  return new Set(normalize_terms(read_string_array(value)));
}

function normalize_intent_plan(value: unknown): VibeNormalizedIntentPlan {
  const plan = is_plain_object(value) ? value : {};
  const xui_objects = new Set([
    ...normalize_intent_terms(plan._xui_objects),
    ...normalize_intent_terms(plan._ui_keywords),
  ]);
  const modules = new Set([
    ...normalize_intent_terms(plan._modules),
  ]);
  const entities = new Set([
    ...normalize_intent_terms(plan._entities),
    ...normalize_intent_terms(plan._entity_keywords),
  ]);
  const capability_keywords = new Set([
    ...normalize_intent_terms(plan._capabilities),
    ...normalize_intent_terms(plan._flow_keywords),
  ]);
  const crud_ops = normalize_intent_terms(plan._crud_ops);
  const ui_patterns = normalize_intent_terms(plan._ui_patterns);

  return {
    _active:
      xui_objects.size > 0
      || modules.size > 0
      || entities.size > 0
      || capability_keywords.size > 0
      || crud_ops.size > 0
      || ui_patterns.size > 0,
    _xui_objects: xui_objects,
    _modules: modules,
    _entities: entities,
    _capability_keywords: capability_keywords,
    _crud_ops: crud_ops,
    _ui_patterns: ui_patterns,
  };
}

function normalized_skill_values(values: unknown[]): string[] {
  const terms: string[] = [];

  for (const value of values) {
    if (typeof value === "string") {
      terms.push(value);
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string") {
          terms.push(item);
          continue;
        }
        if (is_plain_object(item)) {
          if (typeof item._name === "string") terms.push(item._name);
          if (typeof item._op === "string") terms.push(item._op);
        }
      }
      continue;
    }

    terms.push(...read_string_array(value));
  }

  return normalize_terms(terms);
}

function intent_matches(intent_values: Set<string>, skill_values: string[]): string[] {
  if (intent_values.size === 0) return [];
  return skill_values.filter((value) => intent_values.has(value));
}

function normalize_node_id(value: string): string {
  return _xu.normalizePrompt(value).toLowerCase();
}

function unique_strings(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)));
}

function read_unknown_array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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

  private load_runtime_candidates(
    runtime_skills: any,
    schema: SkillSchemaInfo,
  ): SkillCandidate[] {

    const skills_payload =
      is_plain_object(runtime_skills?._skills)
        ? runtime_skills._skills
        : runtime_skills;

    const runtime_skill_items: unknown[] = [];

    if (Array.isArray(skills_payload?._skills)) {
      runtime_skill_items.push(
        ...skills_payload._skills.map((item: unknown) => ({
          item,
          kind: "skill" as const,
        }))
      );
    }

    if (Array.isArray(skills_payload?._objects)) {
      runtime_skill_items.push(
        ...skills_payload._objects.map((item: unknown) => ({
          item,
          kind: "object" as const,
        }))
      );
    }

    if (Array.isArray(skills_payload?._modules)) {
      for (const module_item of skills_payload._modules) {
        runtime_skill_items.push({
          item: module_item,
          kind: "module" as const,
        });

        if (Array.isArray(module_item?._skills)) {
          runtime_skill_items.push(
            ...module_item._skills.map((item: unknown) => ({
              item,
              kind: "skill" as const,
            }))
          );
        }

        if (Array.isArray(module_item?._objects)) {
          runtime_skill_items.push(
            ...module_item._objects.map((item: unknown) => ({
              item,
              kind: "object" as const,
            }))
          );
        }
      }
    }

    debug_log("[xvibe] runtime skills shape", {
      _has_skills_array: Array.isArray(skills_payload?._skills),
      _has_modules_array: Array.isArray(skills_payload?._modules),
      _skills_count: skills_payload?._skills?.length ?? 0,
      _modules_count: skills_payload?._modules?.length ?? 0,
      _runtime_items_count: runtime_skill_items.length
    });

    const candidates: SkillCandidate[] = [];

    for (const raw_runtime_item of runtime_skill_items) {
      const runtime_item = is_plain_object(raw_runtime_item)
        && is_plain_object(raw_runtime_item.item)
        && (
          raw_runtime_item.kind === "skill"
          || raw_runtime_item.kind === "object"
          || raw_runtime_item.kind === "module"
        )
        ? raw_runtime_item as { item: unknown; kind: "skill" | "object" | "module" }
        : { item: raw_runtime_item, kind: "skill" as const };

      const skill = this.validate_runtime_skill(runtime_item.item, schema);
      if (!skill) continue;

      candidates.push({
        skill,
        always_index: -1,
        priority_index: -1,
        match_priority: get_match_priority(skill),
        source: "runtime",
        runtime_kind: runtime_item.kind,
      });
    }

    return candidates;
  }

  private merge_candidates(
    static_candidates: SkillCandidate[],
    runtime_candidates: SkillCandidate[],
  ): SkillCandidate[] {

    const merged =
      new Map<string, SkillCandidate>();

    // static first
    for (const candidate of static_candidates) {
      merged.set(
        candidate.skill._id,
        candidate
      );
    }

    // runtime overrides static
    for (const candidate of runtime_candidates) {
      merged.set(
        candidate.skill._id,
        candidate
      );
    }

    return Array.from(
      merged.values()
    );
  }

  private build_capability_candidates(
    candidates: SkillCandidate[],
  ): { candidates: CapabilityNodeCandidate[]; duplicate_count: number; source_breakdown: Record<string, number> } {
    const by_id = new Map<string, CapabilityNodeCandidate>();
    const source_breakdown: Record<string, number> = {};
    let duplicate_count = 0;

    for (const candidate of candidates) {
      const node = this.capability_node_from_candidate(candidate);
      const source_key = `${candidate.source}:${node._kind}`;
      source_breakdown[source_key] = (source_breakdown[source_key] ?? 0) + 1;

      const existing = by_id.get(node._key);
      if (!existing) {
        by_id.set(node._key, this.capability_candidate_from_node(candidate, node));
        continue;
      }

      duplicate_count++;
      by_id.set(node._key, this.merge_capability_candidate(existing, candidate, node));
    }

    return {
      candidates: Array.from(by_id.values()),
      duplicate_count,
      source_breakdown,
    };
  }

  private capability_node_from_candidate(candidate: SkillCandidate): VibeCapabilityNode {
    const skill = candidate.skill;
    const match = get_match(skill);
    const id = skill._id;
    const key = normalize_node_id(skill._id);
    const existing_exports = is_plain_object(skill._exports) ? skill._exports : undefined;
    const node_kind = this.capability_kind_for_candidate(candidate);
    const exports_obj = node_kind === "xui-object"
      ? {
        ...(existing_exports ?? {}),
        _xui_objects: unique_strings([
          ...read_string_array(existing_exports?._xui_objects),
          ...read_string_array(skill._xtype),
          ...read_string_array(skill._xui_type),
          ...read_string_array(skill._object_type),
          id,
        ]),
      }
      : existing_exports;

    return {
      _id: id,
      _key: key,
      _kind: node_kind,
      _sources: [`${candidate.source}:${candidate.runtime_kind ?? "skill"}:${skill._id}`],
      _keywords: unique_strings([
        ...read_string_array(skill._keywords),
        ...read_string_array(match._keywords),
        ...read_string_array(match._requires_any),
        ...read_string_array(match._requires_all),
      ]),
      _requires: unique_strings(read_string_array(skill._requires)),
      _capabilities: unique_strings([
        ...read_string_array(skill._capabilities),
        ...normalized_skill_values([skill._ops]),
      ]),
      ...(exports_obj ? { _exports: exports_obj } : {}),
      _rules: unique_strings([
        ...read_string_array(skill._priority_rules),
        ...read_string_array(skill._core_rules),
        ...read_string_array(skill._rules),
      ]),
      _examples: [
        ...read_unknown_array(skill._canonical_examples),
        ...read_unknown_array(skill._examples),
      ],
      _anti_patterns: read_unknown_array(skill._anti_patterns),
    };
  }

  private capability_kind_for_candidate(candidate: SkillCandidate): VibeCapabilityNodeKind {
    if (is_runtime_object_candidate(candidate)) return "xui-object";
    if (candidate.runtime_kind === "module") return "module";
    if (candidate.skill._type === "entity-skill") return "entity";
    if (candidate.skill._type === "flow-skill") return "flow";
    if (read_unknown_array(candidate.skill._canonical_examples).length > 0) return "example";
    return "rule";
  }

  private capability_candidate_from_node(
    candidate: SkillCandidate,
    node: VibeCapabilityNode,
  ): CapabilityNodeCandidate {
    return {
      ...candidate,
      skill: this.skill_from_capability_node(candidate, node),
      node,
      match_priority: candidate.match_priority,
    };
  }

  private merge_capability_candidate(
    existing: CapabilityNodeCandidate,
    candidate: SkillCandidate,
    node: VibeCapabilityNode,
  ): CapabilityNodeCandidate {
    const runtime_preferred = existing.source === "runtime" || candidate.source !== "runtime"
      ? existing
      : this.capability_candidate_from_node(candidate, node);

    const merged_node: VibeCapabilityNode = {
      ...runtime_preferred.node,
      _id: runtime_preferred.node._id,
      _key: runtime_preferred.node._key,
      _kind: runtime_preferred.source === "runtime" ? runtime_preferred.node._kind : node._kind,
      _sources: unique_strings([...existing.node._sources, ...node._sources]),
      _keywords: unique_strings([...existing.node._keywords, ...node._keywords]),
      _requires: unique_strings([...existing.node._requires, ...node._requires]),
      _capabilities: unique_strings([...existing.node._capabilities, ...node._capabilities]),
      _exports: runtime_preferred.source === "runtime"
        ? runtime_preferred.node._exports ?? node._exports
        : node._exports ?? runtime_preferred.node._exports,
      _rules: unique_strings([
        ...read_string_array(existing.node._rules),
        ...read_string_array(node._rules),
      ]),
      _examples: [
        ...read_unknown_array(existing.node._examples),
        ...read_unknown_array(node._examples),
      ],
      _anti_patterns: [
        ...read_unknown_array(existing.node._anti_patterns),
        ...read_unknown_array(node._anti_patterns),
      ],
    };

    return {
      ...runtime_preferred,
      always_index: this.merge_index(existing.always_index, candidate.always_index),
      priority_index: this.merge_index(existing.priority_index, candidate.priority_index),
      match_priority: Math.max(existing.match_priority, candidate.match_priority),
      skill: this.skill_from_capability_node(runtime_preferred, merged_node),
      node: merged_node,
    };
  }

  private merge_index(a: number, b: number): number {
    if (a < 0) return b;
    if (b < 0) return a;
    return Math.min(a, b);
  }

  private skill_from_capability_node(
    candidate: SkillCandidate,
    node: VibeCapabilityNode,
  ): VibeSkillDocument {
    return {
      _id: node._id,
      _capability_key: node._key,
      _type: this.skill_type_for_capability_kind(node._kind),
      _match: {
        _keywords: node._keywords,
        _priority: candidate.match_priority,
      },
      _requires: node._requires,
      _capabilities: node._capabilities,
      ...(node._exports ? { _exports: node._exports } : {}),
      ...(node._rules && node._rules.length > 0 ? { _core_rules: node._rules } : {}),
      ...(node._examples && node._examples.length > 0 ? { _canonical_examples: node._examples } : {}),
      ...(node._anti_patterns && node._anti_patterns.length > 0 ? { _anti_patterns: node._anti_patterns } : {}),
    };
  }

  private skill_type_for_capability_kind(kind: VibeCapabilityNodeKind): string {
    if (kind === "xui-object") return "view-skill";
    if (kind === "module") return "runtime-api-skill";
    if (kind === "entity") return "entity-skill";
    if (kind === "flow") return "flow-skill";
    return "general";
  }

  private validate_runtime_skill(
    raw_skill: unknown,
    schema: SkillSchemaInfo,
  ): VibeSkillDocument | null {

    if (!is_plain_object(raw_skill)) {
      return null;
    }

    const id =
      typeof raw_skill._id === "string" && raw_skill._id.trim().length > 0
        ? raw_skill._id.trim()
        : typeof raw_skill._name === "string"
          ? raw_skill._name.trim()
          : "";

    if (!id) {
      return null;
    }

    const skill_type =
      typeof raw_skill._type === "string"
        ? raw_skill._type.trim()
        : "runtime-api-skill";

    if (!skill_type) {
      return null;
    }

    if (
      schema.allowed_types.size > 0 &&
      !schema.allowed_types.has(skill_type)
    ) {
      return null;
    }

    return {
      ...raw_skill,
      _id: id,
      _type: skill_type,
      _match: is_plain_object(raw_skill._match)
        ? raw_skill._match
        : {}
    } as VibeSkillDocument;
  }

  select(
    prompt: string,
    artifact_type?: VibeSelectionArtifactType,
    capabilities: string[] = [],
    runtime_skills: any = {},
    _intent_plan: unknown = {},
  ): VibeKnowledgeSelection {
    const normalized_prompt = _xu.normalizePrompt(prompt).toLowerCase();
    const intent_plan = normalize_intent_plan(_intent_plan);
    const index = read_json(this._index_file);

    if (!is_plain_object(index)) {
      return this.empty_selection();
    }

    const schema = this.load_schema_info();

    const static_candidates =
      this.load_candidates(index, schema);

    const runtime_candidates =
      this.load_runtime_candidates(
        runtime_skills,
        schema
      );

    const capability_graph =
      this.build_capability_candidates([
        ...static_candidates,
        ...runtime_candidates,
      ]);
    const capability_candidates = capability_graph.candidates;

    const candidate_by_id =
      new Map(
        capability_candidates.map(
          (candidate) => [
            candidate.node._key,
            candidate
          ]
        )
      );
    const scored = new Map<string, ScoredSkill>();

    for (const candidate of capability_candidates) {
      const scored_skill = this.score_skill(normalized_prompt, candidate, artifact_type, capabilities, intent_plan);

      if (candidate.always_index >= 0 || this.should_select_scored_skill(scored_skill, artifact_type, intent_plan)) {
        scored.set(candidate.node._key, scored_skill);
      }
    }

    for (const selected of Array.from(scored.values())) {
      if (this.should_include_dependencies_from(selected)) {
        this.include_direct_dependencies(
          this.capability_key_for_scored(selected),
          selected.skill._id,
          candidate_by_id,
          scored,
        );
      } else {
        // this.log_skipped_direct_dependencies(selected.skill, selected.skill._id, "weak_parent_selection");
      }
    }

    const ordered = Array.from(scored.values()).sort((a, b) => this.compare_scored(a, b));
    const selected = this.apply_optional_limit(ordered);

    // for (const item of selected) {
    //   debug_log("[xvibe] skill selected", {
    //     _id: item.skill._id,
    //     _score: item.score,
    //     _reasons: item.reasons,
    //     _selected_as: item.selected_as,
    //     ...(item.dependency_source ? { _dependency_source: item.dependency_source } : {}),
    //   });
    // }
    debug_log("[xvibe] selector skill sources", {
      _static_skills:
        static_candidates.length,

      _runtime_skills:
        runtime_candidates.length,

      _capability_nodes:
        capability_candidates.length,

      _merged_duplicates:
        capability_graph.duplicate_count,

      _source_breakdown:
        capability_graph.source_breakdown
    });
    debug_log("[xvibe] capability graph", {
      _node_count: capability_candidates.length,
      _merged_duplicate_count: capability_graph.duplicate_count,
      _selected_capability_ids: selected.map((candidate) => candidate.skill._id),
      _source_breakdown: capability_graph.source_breakdown,
    });

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
        source: "static",
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
    intent_plan: VibeNormalizedIntentPlan = normalize_intent_plan({}),
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

    const explicit_artifact_match = skill_has_explicit_artifact_type_match(candidate.skill, artifact_type);
    const expected_type = artifact_skill_type(artifact_type);
    if (
      explicit_artifact_match ||
      (
        !is_runtime_object_candidate(candidate) &&
        expected_type &&
        candidate.skill._type === expected_type
      )
    ) {
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

    const exports_obj = is_plain_object(candidate.skill._exports)
      ? candidate.skill._exports
      : {};
    const xui_values = normalized_skill_values([
      candidate.runtime_kind === "object" ? candidate.skill._id : undefined,
      candidate.skill._xui_objects,
      candidate.skill._xtype,
      candidate.skill._xui_type,
      candidate.skill._object_type,
      exports_obj._xui_objects,
    ]);
    const module_values = normalized_skill_values([
      candidate.skill._id,
      candidate.skill._name,
      candidate.skill._module,
      candidate.skill._modules,
      exports_obj._modules,
    ]);
    const entity_values = normalized_skill_values([
      candidate.skill._id,
      candidate.skill._entity,
      candidate.skill._entity_id,
      candidate.skill._entities,
      exports_obj._entities,
    ]);
    const capability_values = normalized_skill_values([
      candidate.skill._id,
      candidate.skill._capabilities,
      candidate.skill._ops,
      candidate.skill._patterns,
      exports_obj._capabilities,
      get_match(candidate.skill)._keywords,
    ]);

    const xui_matches = intent_matches(intent_plan._xui_objects, xui_values);
    if (xui_matches.length > 0) {
      score += 6 + xui_matches.length;
      reasons.push(`intent_xui:${xui_matches.join(",")}`);
    }

    const module_matches = intent_matches(intent_plan._modules, module_values);
    if (module_matches.length > 0) {
      score += 6 + module_matches.length;
      reasons.push(`intent_module:${module_matches.join(",")}`);
    }

    const entity_matches = intent_matches(intent_plan._entities, entity_values);
    if (entity_matches.length > 0) {
      score += 6 + entity_matches.length;
      reasons.push(`intent_entity:${entity_matches.join(",")}`);
    }

    const intent_capability_matches = intent_matches(intent_plan._capability_keywords, capability_values);
    if (intent_capability_matches.length > 0) {
      score += 4 + intent_capability_matches.length;
      reasons.push(`intent_capability:${intent_capability_matches.join(",")}`);
    }

    const crud_op_matches = intent_matches(intent_plan._crud_ops, capability_values);
    if (crud_op_matches.length > 0) {
      score += 4 + crud_op_matches.length;
      reasons.push(`intent_capability:${crud_op_matches.join(",")}`);
    }

    const ui_pattern_matches = intent_matches(intent_plan._ui_patterns, capability_values);
    if (ui_pattern_matches.length > 0) {
      score += 4 + ui_pattern_matches.length;
      reasons.push(`intent_capability:${ui_pattern_matches.join(",")}`);
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

  private should_select_scored_skill(
    scored_skill: ScoredSkill,
    artifact_type?: VibeSelectionArtifactType,
    intent_plan: VibeNormalizedIntentPlan = normalize_intent_plan({}),
  ): boolean {
    if (
      artifact_type === "flow" &&
      is_runtime_object_candidate(scored_skill) &&
      !FLOW_ALLOWED_RUNTIME_OBJECT_SKILL_IDS.has(scored_skill.skill._id)
    ) {
      return false;
    }

    if (
      is_runtime_object_candidate(scored_skill) &&
      intent_plan._xui_objects.size > 0 &&
      !this.has_intent_selection(scored_skill) &&
      !this.has_strong_semantic_selection(scored_skill) &&
      !FLOW_ALLOWED_RUNTIME_OBJECT_SKILL_IDS.has(scored_skill.skill._id)
    ) {
      return false;
    }

    if (
      intent_plan._active &&
      scored_skill.selected_as === "optional" &&
      !this.has_intent_selection(scored_skill) &&
      !this.has_strong_semantic_selection(scored_skill) &&
      scored_skill.reasons.some((reason) => reason.startsWith("artifact_type:"))
    ) {
      return false;
    }

    if (!is_runtime_object_candidate(scored_skill)) {
      return scored_skill.score >= MIN_MATCH_SCORE;
    }

    if (scored_skill.score < MIN_MATCH_SCORE) {
      return false;
    }

    if (this.has_intent_selection(scored_skill)) {
      return true;
    }

    return scored_skill.reasons.some((reason) =>
      reason.startsWith("keywords:")
      || reason.startsWith("requires_any:")
      || reason.startsWith("requires_all:")
      || reason.startsWith("capabilities:")
      || reason.startsWith("artifact_type:")
    );
  }

  private has_intent_selection(
    scored_skill: ScoredSkill,
  ): boolean {
    return scored_skill.reasons.some((reason) =>
      reason.startsWith("intent_xui:")
      || reason.startsWith("intent_module:")
      || reason.startsWith("intent_entity:")
      || reason.startsWith("intent_capability:")
    );
  }

  private has_strong_semantic_selection(
    scored_skill: ScoredSkill,
  ): boolean {
    const semantic_reason_prefixes = [
      "keywords:",
      "requires_any:",
      "requires_all:",
      "capabilities:",
    ];

    return scored_skill.reasons.some((reason) =>
      semantic_reason_prefixes.some((prefix) => reason.startsWith(prefix))
    );
  }

  private should_include_dependencies_from(
    scored_skill: ScoredSkill,
  ): boolean {
    return scored_skill.selected_as === "always"
      || scored_skill.selected_as === "priority"
      || this.has_strong_semantic_selection(scored_skill);
  }

  private capability_key_for_scored(scored_skill: ScoredSkill): string {
    return "node" in scored_skill && is_plain_object(scored_skill.node)
      ? String((scored_skill.node as VibeCapabilityNode)._key)
      : normalize_node_id(scored_skill.skill._id);
  }

  private include_direct_dependencies(
    selected_key: string,
    dependency_source: string,
    candidate_by_id: Map<string, SkillCandidate>,
    scored: Map<string, ScoredSkill>,
  ): void {
    const selected = candidate_by_id.get(selected_key);
    if (!selected) return;

    for (const required_id of read_string_array(selected.skill._requires)) {
      const required_key = normalize_node_id(required_id);
      const dependency = candidate_by_id.get(required_key);
      if (!dependency) {
        debug_log("[xvibe] dependency skipped", {
          _id: required_id,
          _dependency_source: dependency_source,
          _reason: "missing_dependency",
        });
        continue;
      }

      const existing = scored.get(required_key);
      if (existing) {
        if (existing.selected_as !== "always") {
          existing.selected_as = "required";
          existing.dependency_source = dependency_source;
          existing.dependency_source_key = selected_key;
          if (!existing.reasons.includes(`required_by:${dependency_source}`)) {
            existing.reasons.push(`required_by:${dependency_source}`);
          }
        }
        // debug_log("[xvibe] dependency skipped", {
        //   _id: required_id,
        //   _dependency_source: dependency_source,
        //   _reason: "already_selected",
        // });
        // this.log_skipped_nested_dependencies(dependency, required_id);
        continue;
      }

      const score = Math.max(1, dependency.match_priority / 100);
      const scored_dependency: ScoredSkill = {
        ...dependency,
        score,
        reasons: [`required_by:${dependency_source}`],
        selected_as: "required",
        dependency_source,
        dependency_source_key: selected_key,
      };

      scored.set(required_key, scored_dependency);
      debug_log("[xvibe] dependency included", {
        _id: required_id,
        _dependency_source: dependency_source,
        _reason: "direct_required",
      });

      // this.log_skipped_nested_dependencies(dependency, required_id);
    }
  }

  private log_skipped_nested_dependencies(
    dependency: SkillCandidate,
    dependency_source: string,
  ): void {
    for (const nested_id of read_string_array(dependency.skill._requires)) {
      debug_log("[xvibe] dependency skipped", {
        _id: nested_id,
        _dependency_source: dependency_source,
        _reason: "max_dependency_depth",
      });
    }
  }

  private log_skipped_direct_dependencies(
    skill: VibeSkillDocument,
    dependency_source: string,
    reason: string,
  ): void {
    for (const required_id of read_string_array(skill._requires)) {
      debug_log("[xvibe] dependency skipped", {
        _id: required_id,
        _dependency_source: dependency_source,
        _reason: reason,
      });
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
