import { _xlog } from "@xpell/core";
import {
  XVibeCapabilityRegistry,
  type XVibeCapabilityCategory,
  type XVibeCapabilityDefinition,
  type XVibeCapabilityGuidanceArtifact,
  type XVibeCapabilityGuidanceItem,
  type XVibeCapabilityGuidanceSection,
} from "../Capability/index.js";
import type {
  XVibeIntentEngineRequest,
  XVibeIntentResult,
} from "../XVibeTypes.js";
import type { XVibeIntentProcessor } from "./XVibeIntentProcessor.js";

type CapabilityGuidanceMatch = {
  _query_type: XVibeCapabilityGuidanceArtifact["_query_type"];
  _capability_ids?: string[];
  _category?: XVibeCapabilityCategory;
  _description: string;
};

const TEXT_CAPABILITY_IDS = ["update-text"];
const STYLE_CAPABILITY_IDS = ["set-styles", "add-remove-class"];

function normalize_guidance_query(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[“”]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .replace(/[^a-z0-9\s?'-]+/gu, " ")
    .replace(/\s+/gu, " ");
}

function is_question_like(query: string): boolean {
  return (
    /\?$/u.test(query) ||
    /\b(?:what|how|which|show|list|tell|explain)\b/u.test(query)
  );
}

function read_current_view_id(request: XVibeIntentEngineRequest): string | undefined {
  const runtime_context = request._runtime_context;
  const direct =
    typeof runtime_context._active_view_id === "string" &&
    runtime_context._active_view_id.trim().length > 0
      ? runtime_context._active_view_id.trim()
      : undefined;
  if (direct) return direct;

  const current_view = runtime_context._current_view;
  if (
    current_view &&
    typeof current_view === "object" &&
    !Array.isArray(current_view) &&
    typeof current_view._id === "string" &&
    current_view._id.trim().length > 0
  ) {
    return current_view._id.trim();
  }

  return undefined;
}

function match_guidance_query(
  query: string,
): CapabilityGuidanceMatch | null {
  if (
    /\bwhat prompts work\b/u.test(query) ||
    /\b(?:prompt|prompts|examples)\b/u.test(query) &&
      /\b(?:current view|this view|work|use|try|supported)\b/u.test(query)
  ) {
    return {
      _query_type: "prompt-examples",
      _category: "view-editing",
      _description: "Tested prompt examples for supported current-view edits.",
    };
  }

  if (
    /\bmanual(?:ly)?\b/u.test(query) ||
    /\bhow do i do this manually\b/u.test(query) ||
    /\binspector\b/u.test(query)
  ) {
    return {
      _query_type: "manual",
      _description: "Manual steps for supported Visual Xpell capabilities.",
    };
  }

  if (
    is_question_like(query) &&
    (
      /\b(?:change|edit|update|replace|rename)\b/u.test(query) &&
      /\b(?:text|label|title|heading|copy)\b/u.test(query) ||
      /\bobject text\b/u.test(query)
    )
  ) {
    return {
      _query_type: "capability",
      _capability_ids: TEXT_CAPABILITY_IDS,
      _category: "view-editing",
      _description: "Guidance for changing visible object text.",
    };
  }

  if (
    is_question_like(query) &&
    (
      /\bstyle\b/u.test(query) ||
      /\b(?:color|background|font|class|classes)\b/u.test(query)
    )
  ) {
    return {
      _query_type: "capability",
      _capability_ids: STYLE_CAPABILITY_IDS,
      _category: "view-editing",
      _description: "Guidance for styling objects with supported style and class edits.",
    };
  }

  if (
    /\bwhat can (?:i|we|you) do\b/u.test(query) ||
    /\bwhat does visual xpell (?:support|do)\b/u.test(query) ||
    /\b(?:supported|available) capabilities\b/u.test(query) ||
    /\bvisual xpell capabilities\b/u.test(query)
  ) {
    return {
      _query_type: "overview",
      _description: "Supported, tested Visual Xpell capabilities.",
    };
  }

  return null;
}

function unique_categories(
  capabilities: XVibeCapabilityDefinition[],
): XVibeCapabilityCategory[] {
  return [...new Set(capabilities.map((capability) => capability._category))];
}

function category_for_log(
  categories: XVibeCapabilityCategory[],
): XVibeCapabilityCategory | "mixed" | undefined {
  if (categories.length === 0) return undefined;
  return categories.length === 1 ? categories[0] : "mixed";
}

function category_title(category: XVibeCapabilityCategory): string {
  switch (category) {
    case "view-editing":
      return "View Editing";
    case "project-planning":
      return "Project Planning";
    case "maintenance":
      return "Maintenance";
    default:
      return category;
  }
}

function category_description(category: XVibeCapabilityCategory): string {
  switch (category) {
    case "view-editing":
      return "Supported deterministic edits for the current Visual Xpell view.";
    case "project-planning":
      return "Supported deterministic planning actions for Visual Xpell projects.";
    case "maintenance":
      return "Internal maintenance operations.";
    default:
      return "Supported Visual Xpell capabilities.";
  }
}

function serialize_capability(
  capability: XVibeCapabilityDefinition,
): XVibeCapabilityGuidanceItem {
  return {
    _id: capability._id,
    _category: capability._category,
    _tested: capability._tested,
    _user_visible: capability._user_visible,
    title: capability._title,
    description: capability._description,
    prompt_examples: [...capability._prompt_examples],
    manual_steps: [...(capability._manual_steps ?? [])],
    mode: capability._mode,
    status: capability._status,
  };
}

function build_sections(
  capabilities: XVibeCapabilityGuidanceItem[],
): XVibeCapabilityGuidanceSection[] {
  const sections: XVibeCapabilityGuidanceSection[] = [];
  for (const capability of capabilities) {
    let section =
      sections.find((candidate) =>
        candidate._category === capability._category,
      );
    if (!section) {
      section = {
        _id: capability._category,
        _category: capability._category,
        _title: category_title(capability._category),
        _description: category_description(capability._category),
        _capability_count: 0,
        _capabilities: [],
      };
      sections.push(section);
    }

    section._capabilities.push(capability);
    section._capability_count = section._capabilities.length;
  }

  return sections;
}

export class CapabilityGuidanceProcessor implements XVibeIntentProcessor {
  private readonly registry: XVibeCapabilityRegistry;

  constructor(registry = new XVibeCapabilityRegistry()) {
    this.registry = registry;
  }

  async analyze(
    request: XVibeIntentEngineRequest,
  ): Promise<XVibeIntentResult | null> {
    const query = normalize_guidance_query(request._message);
    const match = match_guidance_query(query);
    if (!match) {
      return null;
    }

    const capabilities =
      match._capability_ids
        ? this.registry.byIds(match._capability_ids)
        : match._category
          ? this.registry.byCategory(match._category)
          : this.registry.userVisibleTested();
    if (capabilities.length === 0) {
      return null;
    }

    const capability_ids =
      capabilities.map((capability) => capability._id);
    const categories = unique_categories(capabilities);
    const category = category_for_log(categories);
    const serialized_capabilities =
      capabilities.map(serialize_capability);
    const sections = build_sections(serialized_capabilities);
    _xlog.log("[xvibe] capability guidance matched", {
      _query_type: match._query_type,
      _capability_ids: capability_ids,
      _category: category,
    });
    _xlog.log("[xvibe] capability guidance artifact", {
      _sections: sections.map((section) => ({
        _id: section._id,
        _category: section._category,
        _capability_count: section._capability_count,
      })),
      _capability_count: serialized_capabilities.length,
    });

    const artifact: XVibeCapabilityGuidanceArtifact = {
      _type: "capability-guidance",
      _query_type: match._query_type,
      _matched_capability_ids: capability_ids,
      _matched_categories: categories,
      ...(category ? { _category: category } : {}),
      _description: match._description,
      ...(read_current_view_id(request)
        ? { _current_view_id: read_current_view_id(request) }
        : {}),
      _capability_count: serialized_capabilities.length,
      _capabilities: serialized_capabilities,
      _sections: sections,
    };

    return {
      _message_type: "question",
      _execution_level: "deterministic",
      _should_mutate: false,
      _confidence: 1,
      _reason: "deterministic_capability_guidance",
      _artifact_type: "capability-guidance",
      _artifact_request: artifact,
      _actions: [],
      _warnings: [],
    };
  }
}
