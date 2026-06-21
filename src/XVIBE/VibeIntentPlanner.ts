import { _xlog } from "@xpell/core";
import type {
  VibeArtifactType,
  VibeRequestedArtifactType,
  XVibeArtifactIntent,
  XVibeArtifactIntentAction,
  XVibeArtifactIntentTarget,
  XVibeArtifactExecutionPlan,
  XVibeInferredArtifactType,
  XVibeInferredArtifactPlan,
  XVibeIntentIR,
  XVibeIntentIRAction,
  XVibeIntentIRBinding,
  XVibeIntentIREntity,
  XVibeIntentIRStyle,
  XVibeResolvedTask,
  XVibeResolvedTaskArtifactType,
} from "./XVibeTypes.js";

type XVibeJsonObject = {
  [key: string]: unknown;
};

export type VibeRuntimeCapabilityRegistry = {
  _semantic_object_ids: string[];
  _module_ids: string[];
  _ops: string[];
  _module_ops: Record<string, string[]>;
  _capability_keywords: string[];
};

export type VibeModuleTarget = "server" | "client" | null;

export type VibeIntentPlan = XVibeIntentIR & {
  _intent_type: string;
  _artifact_types: string[];
  _ir_version: 1;
  _regions: string[];
  _objects: string[];
  _actions: XVibeIntentIRAction[];
  _bindings: XVibeIntentIRBinding[];
  _style: XVibeIntentIRStyle;
  _xui_objects: string[];
  _modules: string[];
  _requires_module: boolean;
  _module_target: VibeModuleTarget;
  _module_name?: string;
  _module_ops: string[];
  _module_reason?: string;
  _entities: XVibeIntentIREntity[];
  _capabilities: string[];
  _crud_ops: string[];
  _ui_patterns: string[];
  _ui_keywords: string[];
  _flow_keywords: string[];
  _entity_keywords: string[];
  _runtime_capabilities: VibeRuntimeCapabilityRegistry;
};

type XVibeIntentResolverResult = {
  _matched: true;
  _reason: string;
  _artifact_type: XVibeInferredArtifactType;
  _confidence: number;
  _action?: XVibeArtifactIntentAction;
  _artifact_id?: string;
  _forbidden_targets?: XVibeArtifactIntentTarget[];
};

type XVibeIntentResolver = (
  prompt: string
) => XVibeIntentResolverResult | null;

export type XVibeModuleOperationExtraction = {
  _positive_matches: string[];
  _negative_matches: string[];
  _module_ops: string[];
};

const INTENT_IR_VERSION = 1 as const;
const XVIBE_MODULE_INTENT_INVALID = "E_XVIBE_MODULE_INTENT_INVALID";
const INTENT_REGION_IDS = [
  "sidebar",
  "toolbar",
  "kpi_grid",
  "records_table",
  "create_modal",
  "details_drawer",
  "filters",
  "content",
];
const INTENT_OBJECT_IDS = [
  "view",
  "label",
  "sidebar",
  "navlist",
  "toolbar",
  "field",
  "button",
  "xsection",
  "stack",
  "grid",
  "card",
  "kpi-card",
  "table",
  "modal",
  "form",
  "xselect",
  "drawer",
  "style-sheet",
];
const INTENT_OBJECT_ALIASES: Record<string, string> = {
  labels: "label",
  "nav-list": "navlist",
  section: "xsection",
};
const SIMPLE_UI_CRUD_REGION_IDS = new Set([
  "records_table",
  "create_modal",
  "details_drawer",
  "filters",
]);
const SIMPLE_UI_REGION_TERMS: Record<string, string[]> = {
  sidebar: ["sidebar", "side bar"],
  toolbar: ["toolbar", "tool bar"],
  content: ["content"],
  kpi_grid: ["kpi", "kpis", "metrics"],
};
const UI_ENTITY_NAMES = new Set([
  "app",
  "apps",
  "view",
  "views",
  "page",
  "pages",
  "screen",
  "screens",
  "layout",
  "layouts",
  "label",
  "labels",
  "text",
  "title",
  "titles",
  "dashboard",
  "dashboards",
  "form",
  "forms",
  "field",
  "fields",
  "button",
  "buttons",
  "toolbar",
  "toolbars",
  "sidebar",
  "sidebars",
  "card",
  "cards",
  "grid",
  "grids",
  "stack",
  "stacks",
  "section",
  "sections",
  "xsection",
  "xsections",
  "row",
  "rows",
  "column",
  "columns",
  "table",
  "tables",
  "modal",
  "modals",
  "drawer",
  "drawers",
]);
const ENTITY_STOP_WORDS = new Set([
  "app",
  "apps",
  "xpell",
  "view",
  "views",
  "page",
  "pages",
  "screen",
  "screens",
  "layout",
  "layouts",
  "label",
  "labels",
  "text",
  "title",
  "titles",
  "statistic",
  "statistics",
  "status",
  "card",
  "cards",
  "grid",
  "grids",
  "stack",
  "stacks",
  "button",
  "buttons",
  "field",
  "fields",
  "form",
  "forms",
  "operation",
  "operations",
  "filter",
  "filters",
  "refresh",
  "search",
  "dashboard",
  "navigation",
  "toolbar",
  "sidebar",
  "sidebars",
  "modal",
  "modals",
  "drawer",
  "drawers",
  "page",
  "section",
  "sections",
  "xsection",
  "xsections",
  "data",
  "record",
  "records",
  "table",
  "tables",
  "entity",
  "entities",
]);
const BUSINESS_ENTITY_WORDS = [
  "account",
  "accounts",
  "client",
  "clients",
  "contact",
  "contacts",
  "customer",
  "customers",
  "invoice",
  "invoices",
  "order",
  "orders",
  "product",
  "products",
  "user",
  "users",
];
const EXPLICIT_MULTI_ENTITY_PATTERN =
  /\b(?:entities|models|tables|schemas)\b[\s\S]{0,80}\b(?:and|,)\b|\b[a-z][a-z0-9_-]*s?\s*(?:,|\band\b)\s*[a-z][a-z0-9_-]*s?\s+(?:entities|models|tables|schemas|records)\b/u;
const ARTIFACT_INTENT_TARGETS: XVibeArtifactIntentTarget[] = ["view", "flow", "entity", "module"];
const ARTIFACT_TARGET_PLURALS: Record<string, XVibeArtifactIntentTarget> = {
  view: "view",
  views: "view",
  flow: "flow",
  flows: "flow",
  workflow: "flow",
  workflows: "flow",
  entity: "entity",
  entities: "entity",
  module: "module",
  modules: "module",
};
const ARTIFACT_INTENT_TOKEN_PATTERN = String.raw`("[^"]+"|'[^']+'|[a-z][a-z0-9_-]*)`;
const VIEW_EDIT_OBJECT_NOUN_PATTERN =
  String.raw`(?:button|buttons|input|inputs|label|labels|field|fields|form|forms|card|cards|table|tables|row|rows|column|columns|toolbar|toolbars|sidebar|sidebars|modal|modals|drawer|drawers|section|sections|xsection|xsections|text|title|titles|heading|headings|image|images|icon|icons|link|links)`;
const VIEW_EDIT_STYLE_PROPERTY_ALIASES: Array<[string, string]> = [
  ["background color", "background-color"],
  ["border radius", "border-radius"],
  ["text color", "color"],
  ["font size", "font-size"],
  ["background", "background-color"],
  ["color", "color"],
  ["width", "width"],
  ["height", "height"],
  ["padding", "padding"],
  ["margin", "margin"],
];
const VIEW_EDIT_STYLE_PROPERTY_PATTERN =
  VIEW_EDIT_STYLE_PROPERTY_ALIASES
    .map(([phrase]) => phrase.replace(/\s+/gu, String.raw`\s+`))
    .join("|");
const VIEW_EDIT_PROPERTY_NAME_PATTERN = String.raw`_?[a-z][a-z0-9_]*`;
const RESERVED_EXPLICIT_MODULE_IDS = new Set([
  "called",
  "client",
  "id",
  "methods",
  "module",
  "named",
  "only",
  "op",
  "operation",
  "operations",
  "ops",
  "server",
  "with",
  "xmodule",
]);
const RESERVED_RESOLVED_TASK_TARGET_IDS = new Set([
  "a",
  "an",
  "and",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "the",
  "to",
  "with",
  "named",
  "called",
  "id",
  "new",
]);

type VibeInferredModuleRequirement = {
  _module_target: Exclude<VibeModuleTarget, null>;
  _module_name: string;
  _module_ops: string[];
  _module_reason: string;
};

function is_plain_object(value: unknown): value is XVibeJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function normalize_lookup_key(value: string): string {
  return value.trim().toLowerCase().replace(/-/g, "_");
}

function normalize_prompt_text(value: string): string {
  return value.trim().toLowerCase();
}

function normalize_artifact_intent_prompt(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function module_intent_prompt_reason(prompt: string): string | undefined {
  const text = normalize_artifact_intent_prompt(prompt);
  if (/\bmodule\s+only\b/u.test(text)) return "prompt_module_only";
  if (/\bserver\s+module\b/u.test(text)) return "prompt_server_module";
  if (/\bclient\s+module\b/u.test(text)) return "prompt_client_module";
  if (/\bxmodule\b/u.test(text)) return "prompt_xmodule";
  return undefined;
}

function normalize_artifact_identifier(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const normalized =
    value
      .trim()
      .replace(/^["'`]+|["'`.,;:]+$/g, "")
      .trim()
      .toLowerCase();

  return /^[a-z][a-z0-9_-]*$/u.test(normalized) ? normalized : undefined;
}

function normalize_module_operation_identifier(value: string | undefined): string | undefined {
  const normalized =
    normalize_artifact_identifier(value?.replace(/^_+/, ""));

  return normalized;
}

function normalize_explicit_module_id(value: string | undefined): string | undefined {
  const normalized =
    normalize_artifact_identifier(value);

  return normalized && !RESERVED_EXPLICIT_MODULE_IDS.has(normalized)
    ? normalized
    : undefined;
}

function line_has_negative_operation_instruction(line: string): boolean {
  return /\b(?:do\s+not|don't|dont|never|no)\b[\s\S]{0,80}\boperation\b/iu
    .test(line);
}

export function extract_module_operation_matches_from_prompt(
  prompt: string,
): XVibeModuleOperationExtraction {
  const positive_matches: string[] = [];
  const negative_matches: string[] = [];
  const lines = prompt.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    for (const negative_line_match of lines[index].matchAll(
      /\b(?:do\s+not|don't|dont|never|no)\b[\s\S]{0,80}?\boperation\s+(_?[a-z][a-z0-9_-]*)\b/giu,
    )) {
      const negative_op =
        normalize_module_operation_identifier(negative_line_match[1]);
      if (negative_op) {
        negative_matches.push(negative_op);
      }
    }

    const header_match =
      lines[index].match(/(?:^|[\s.;])(?:operations|ops|methods|module\s+ops|expose\s+operation)\s*:\s*(.*)$/iu);
    if (!header_match) {
      continue;
    }

    const inline_source =
      header_match[1].split(/\b(?:do\s+not|don't|dont|never|no)\b/iu)[0];

    const inline_ops =
      inline_source
        .split(/[,\s]+/u)
        .map((value) => normalize_module_operation_identifier(value))
        .filter((value): value is string => Boolean(value));
    positive_matches.push(...inline_ops);

    for (let next_index = index + 1; next_index < lines.length; next_index += 1) {
      const line = lines[next_index];
      if (line_has_negative_operation_instruction(line)) break;
      if (/^\s*$/u.test(line)) {
        continue;
      }

      const bullet_match =
        line.match(/^\s*[-*]\s*(_?[a-z][a-z0-9_-]*)\s*$/iu);
      if (!bullet_match) break;

      const op =
        normalize_module_operation_identifier(bullet_match[1]);
      if (op) positive_matches.push(op);
    }
  }

  if (positive_matches.length === 0) {
    for (const match of prompt.matchAll(/\bop(?:eration)?\s+(?:named|called)?\s*(_?[a-z][a-z0-9_-]*)\b/giu)) {
      const line_start = prompt.lastIndexOf("\n", match.index) + 1;
      const line_end = prompt.indexOf("\n", match.index);
      const line =
        prompt.slice(
          line_start,
          line_end === -1 ? prompt.length : line_end,
        );
      const op =
        normalize_module_operation_identifier(match[1]);
      if (!op) continue;

      if (line_has_negative_operation_instruction(line)) {
        negative_matches.push(op);
        continue;
      }

      positive_matches.push(op);
    }
  }

  if (positive_matches.length === 0 && /\b(?:xmodule|module|server\s+module|client\s+module)\b/iu.test(prompt)) {
    for (const match of prompt.matchAll(/\bwith\s+(_[a-z][a-z0-9_-]*)\b/giu)) {
      const op =
        normalize_module_operation_identifier(match[1]);
      if (op) positive_matches.push(op);
    }
  }

  const final_ops =
    positive_matches.length > 0
      ? unique(positive_matches)
        .filter((op) => !negative_matches.includes(op))
      : [];

  return {
    _positive_matches: unique(positive_matches),
    _negative_matches: unique(negative_matches),
    _module_ops: final_ops,
  };
}

export function extract_explicit_module_ops_from_prompt(prompt: string): string[] {
  return extract_module_operation_matches_from_prompt(prompt)._module_ops;
}

export function extract_explicit_module_id_from_prompt(prompt: string): string | undefined {
  const lines = prompt.split(/\r?\n/u);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const inline_match =
      line.match(/^\s*module\s+(?:id|name)\s*:\s*([a-z][a-z0-9_-]*)\s*$/iu);
    const inline_id =
      normalize_explicit_module_id(inline_match?.[1]);
    if (inline_id) return inline_id;

    if (!/^\s*module\s+(?:id|name)\s*:\s*$/iu.test(line)) {
      continue;
    }

    for (let next_index = index + 1; next_index < lines.length; next_index += 1) {
      const next_line = lines[next_index].trim();
      if (!next_line) continue;

      return normalize_explicit_module_id(next_line);
    }
  }

  const direct_module_match =
    prompt.match(
      /\b(?:create|build|generate|add|make)\s+(?:a\s+|an\s+|the\s+)?(?:(?:server|client)\s+)?(?:xmodule|module)\s+([a-z][a-z0-9_-]*)\b/iu,
    );
  return normalize_explicit_module_id(direct_module_match?.[1]);
}

function normalize_resolved_task_target_id(value: string | undefined): string | undefined {
  const normalized = normalize_artifact_identifier(value);
  if (!normalized || RESERVED_RESOLVED_TASK_TARGET_IDS.has(normalized)) {
    return undefined;
  }

  return normalized;
}

function artifact_type_from_requested_artifact_type(
  value: VibeRequestedArtifactType | undefined,
): XVibeResolvedTaskArtifactType | undefined {
  if (
    value === "view" ||
    value === "flow" ||
    value === "entity" ||
    value === "command"
  ) {
    return value;
  }

  return undefined;
}

function resolved_artifact_type_from_intent_target(
  target: XVibeArtifactIntentTarget,
): XVibeResolvedTaskArtifactType {
  if (
    target === "view" ||
    target === "flow" ||
    target === "entity" ||
    target === "module" ||
    target === "app"
  ) {
    return target;
  }

  return "unknown";
}

function explicit_app_artifact_type(prompt: string): boolean {
  const text = normalize_artifact_intent_prompt(prompt);
  return /\b(?:create|build|generate|make)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:app|application)\b/u.test(text);
}

function prompt_explicitly_targets_main_view(prompt: string): boolean {
  const text = normalize_artifact_intent_prompt(prompt);
  return /\bmain\s+(?:view|page|screen|form)\b/u.test(text) ||
    /\b(?:view|page|screen|form)\s+main\b/u.test(text);
}

function prompt_has_explicit_artifact_action_target(text: string): boolean {
  return /\b(?:delete|remove|disable|archive|rename)\s+(?:a\s+|an\s+|the\s+)?(?:view|flow|entity|module)\b/u
    .test(text);
}

function detect_view_edit_action(text: string): XVibeResolvedTask["_edit_action"] | undefined {
  const action_text = strip_negated_artifact_phrases(text);
  if (!action_text || prompt_has_explicit_artifact_action_target(action_text)) {
    return undefined;
  }

  if (/\bmove\s+.+?\s+(?:before|after)\s+.+/u.test(action_text)) return "move-object";
  if (/\bmove\s+.+?\s+to\s+(?:top|bottom)\b/u.test(action_text)) return "move-object";
  if (new RegExp(String.raw`\b(?:make|set)\s+[a-z][a-z0-9]*[-_][a-z0-9_-]*\s+(?:${VIEW_EDIT_STYLE_PROPERTY_PATTERN})\s+(?!to\b)\S+`, "u").test(action_text)) return "set-style-class-rule";
  if (new RegExp(String.raw`\bremove\s+(?:${VIEW_EDIT_STYLE_PROPERTY_PATTERN})\s+from\s+[a-z][a-z0-9]*[-_][a-z0-9_-]*\s+class\b`, "u").test(action_text)) return "remove-style-class-rule";
  if (new RegExp(String.raw`\bset\s+.+?\s+(?:${VIEW_EDIT_STYLE_PROPERTY_PATTERN})\s+to\s+\S+`, "u").test(action_text)) return "set-style";
  if (new RegExp(String.raw`\bremove\s+(?:${VIEW_EDIT_STYLE_PROPERTY_PATTERN})\s+from\s+`, "u").test(action_text)) return "remove-style";
  if (new RegExp(String.raw`\bset\s+.+?\s+(?!text\s+to\b|label\s+to\b)${VIEW_EDIT_PROPERTY_NAME_PATTERN}\s+to\s+\S+`, "u").test(action_text)) return "set-property";
  if (/\breplace\s+class\s+[a-z][a-z0-9_-]*\s+with\s+[a-z][a-z0-9_-]*\s+on\b/u.test(action_text)) return "replace-class";
  if (/\btoggle\s+class\s+[a-z][a-z0-9_-]*\s+on\b/u.test(action_text)) return "toggle-class";
  if (/\badd\s+class\s+[a-z][a-z0-9_-]*\s+to\b/u.test(action_text)) return "add-class";
  if (/\bremove\s+class\s+[a-z][a-z0-9_-]*\s+from\b/u.test(action_text)) return "remove-class";
  if (new RegExp(String.raw`\bremove\s+${VIEW_EDIT_PROPERTY_NAME_PATTERN}\s+from\s+.+`, "u").test(action_text)) return "remove-property";
  if (/\b(?:show|unhide)\b/u.test(action_text)) return "show";
  if (/\bmake\b/u.test(action_text) && /\bvisible\b/u.test(action_text)) return "show";
  if (/\bhide\b/u.test(action_text)) return "hide";
  if (/\bmake\b/u.test(action_text) && /\bhidden\b/u.test(action_text)) return "hide";
  if (/\b(?:delete|remove)\b/u.test(action_text)) return "remove";
  if (/\b(?:update|change|edit|modify|replace|set|rename)\b/u.test(action_text)) return "update";
  return undefined;
}

function prompt_has_view_child_edit(text: string): boolean {
  const edit_action = detect_view_edit_action(text);
  if (!edit_action) return false;

  if (/\b(?:from|in|on)\s+(?:the\s+)?(?:view|page|screen|form)\b/u.test(text)) {
    return true;
  }

  if (/\b(?:main|current)\s+(?:view|page|screen|form)\b/u.test(text)) {
    return true;
  }

  if (/\b(?:view|page|screen|form)\s+(?:main|current)\b/u.test(text)) {
    return true;
  }

  if (new RegExp(String.raw`\b${VIEW_EDIT_OBJECT_NOUN_PATTERN}\b`, "u").test(text)) {
    return true;
  }

  if (/\b(?:change|update)\s+[a-z][a-z0-9_-]*\s+(?:text|label)\s+from\s+["'][^"']+["']\s+to\s+["'][^"']+["']/u.test(text)) {
    return true;
  }

  if (/\bset\s+[a-z][a-z0-9_-]*\s+(?:text|label)\s+to\s+["'][^"']+["']/u.test(text)) {
    return true;
  }

  if (/\brename\s+[a-z][a-z0-9_-]*\s+to\s+["'][^"']+["']/u.test(text)) {
    return true;
  }

  if (/\b(?:change|update)\s+["'][^"']+["']\s+to\s+["'][^"']+["']/u.test(text)) {
    return true;
  }

  if (/\breplace\s+["'][^"']+["']\s+with\s+["'][^"']+["']/u.test(text)) {
    return true;
  }

  if (/\b(?:delete|remove|hide|show|unhide)\s+(?:the\s+)?["'][^"']+["']/u.test(text)) {
    return true;
  }

  if (/\badd\s+class\s+[a-z][a-z0-9_-]*\s+to\s+(?:the\s+)?(?:["'][^"']+["']|[a-z][a-z0-9_-]*)(?:\s+(?:button|label|text|title|heading))?\b/u.test(text)) {
    return true;
  }

  if (/\bremove\s+class\s+[a-z][a-z0-9_-]*\s+from\s+(?:the\s+)?(?:["'][^"']+["']|[a-z][a-z0-9_-]*)(?:\s+(?:button|label|text|title|heading))?\b/u.test(text)) {
    return true;
  }

  if (/\breplace\s+class\s+[a-z][a-z0-9_-]*\s+with\s+[a-z][a-z0-9_-]*\s+on\s+(?:the\s+)?(?:["'][^"']+["']|[a-z][a-z0-9_-]*)(?:\s+(?:button|label|text|title|heading))?\b/u.test(text)) {
    return true;
  }

  if (/\btoggle\s+class\s+[a-z][a-z0-9_-]*\s+on\s+(?:the\s+)?(?:["'][^"']+["']|[a-z][a-z0-9_-]*)(?:\s+(?:button|label|text|title|heading))?\b/u.test(text)) {
    return true;
  }

  if (new RegExp(String.raw`\bset\s+.+?\s+(?:${VIEW_EDIT_STYLE_PROPERTY_PATTERN})\s+to\s+\S+`, "u").test(text)) {
    return true;
  }

  if (new RegExp(String.raw`\bremove\s+(?:${VIEW_EDIT_STYLE_PROPERTY_PATTERN})\s+from\s+.+`, "u").test(text)) {
    return true;
  }

  if (new RegExp(String.raw`\b(?:make|set)\s+[a-z][a-z0-9]*[-_][a-z0-9_-]*\s+(?:${VIEW_EDIT_STYLE_PROPERTY_PATTERN})\s+(?!to\b)\S+`, "u").test(text)) {
    return true;
  }

  if (new RegExp(String.raw`\bremove\s+(?:${VIEW_EDIT_STYLE_PROPERTY_PATTERN})\s+from\s+[a-z][a-z0-9]*[-_][a-z0-9_-]*\s+class\b`, "u").test(text)) {
    return true;
  }

  if (new RegExp(String.raw`\bset\s+.+?\s+(?!text\s+to\b|label\s+to\b)${VIEW_EDIT_PROPERTY_NAME_PATTERN}\s+to\s+\S+`, "u").test(text)) {
    return true;
  }

  if (new RegExp(String.raw`\bremove\s+${VIEW_EDIT_PROPERTY_NAME_PATTERN}\s+from\s+.+`, "u").test(text)) {
    return true;
  }

  if (/\bmove\s+.+?\s+(?:before|after)\s+.+/u.test(text)) {
    return true;
  }

  if (/\bmove\s+.+?\s+to\s+(?:top|bottom)\b/u.test(text)) {
    return true;
  }

  return /\b(?:delete|remove|hide|show|unhide)\s+(?:the\s+)?[a-z][a-z0-9]*[-_][a-z0-9_-]*\b/u.test(text);
}

function extract_explicit_view_target_id(prompt: string): string | undefined {
  const patterns = [
    new RegExp(String.raw`\b(?:from|in|on)\s+(?:the\s+)?(?:view|page|screen|form)\s+${ARTIFACT_INTENT_TOKEN_PATTERN}(?:\s|$|[.,;:])`, "iu"),
    new RegExp(String.raw`\b${ARTIFACT_INTENT_TOKEN_PATTERN}\s+(?:view|page|screen|form)\b`, "iu"),
  ];

  for (const pattern of patterns) {
    const target_id =
      normalize_resolved_task_target_id(prompt.match(pattern)?.[1]);
    if (target_id) return target_id;
  }

  return undefined;
}

function extract_quoted_text_change(prompt: string): Pick<XVibeResolvedTask, "_edit_target_id" | "_edit_target_text" | "_edit_replacement_text" | "_edit_field"> | undefined {
  const patterns = [
    /\b(?:change|update)\s+([a-z][a-z0-9_-]*)\s+(?:text|label)\s+from\s+["']([^"']+)["']\s+to\s+["']([^"']+)["']/iu,
    /\b(?:set)\s+([a-z][a-z0-9_-]*)\s+(?:text|label)\s+to\s+["']([^"']+)["']/iu,
    /\b(?:rename)\s+([a-z][a-z0-9_-]*)\s+to\s+["']([^"']+)["']/iu,
    /\b(?:change|update)\s+["']([^"']+)["']\s+to\s+["']([^"']+)["']/iu,
    /\b(?:replace)\s+["']([^"']+)["']\s+with\s+["']([^"']+)["']/iu,
  ];

  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (!match) continue;

    if (match.length === 4) {
      const target_id = normalize_resolved_task_target_id(match[1]);
      return {
        ...(target_id ? { _edit_target_id: target_id } : {}),
        _edit_target_text: match[2].trim(),
        _edit_replacement_text: match[3].trim(),
        _edit_field: "_text",
      };
    }

    if (pattern.source.includes("(?:set)") || pattern.source.includes("(?:rename)")) {
      const target_id = normalize_resolved_task_target_id(match[1]);
      return {
        ...(target_id ? { _edit_target_id: target_id } : {}),
        _edit_replacement_text: match[2].trim(),
        _edit_field: "_text",
      };
    }

    return {
      _edit_target_text: match[1].trim(),
      _edit_replacement_text: match[2].trim(),
      _edit_field: "_text",
    };
  }

  return undefined;
}

function trim_unquoted_edit_phrase(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:the|a|an)\s+/iu, "")
    .replace(/^["'`]+|["'`]+$/gu, "")
    .replace(/[.,;:!?]+$/u, "")
    .trim();
}

function trim_unquoted_replacement_text(value: string): string {
  let text = value.split(/\r?\n/u)[0] ?? "";
  const constraint_match = text.search(
    /\b(?:do\s+not|don't|dont|only\s+update|update\s+\w+\s+view\s+only|preserve|keep|without)\b/iu,
  );
  if (constraint_match >= 0) {
    text = text.slice(0, constraint_match);
  }

  const sentence_boundary = text.search(/[.!?](?:\s|$)/u);
  if (sentence_boundary >= 0) {
    text = text.slice(0, sentence_boundary);
  }

  return trim_unquoted_edit_phrase(text);
}

function normalize_view_edit_target_type(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (normalized === "buttons") return "button";
  if (normalized === "labels") return "label";
  if (normalized === "texts") return "text";
  if (normalized === "titles") return "title";
  if (normalized === "headings") return "heading";
  if (
    normalized === "button" ||
    normalized === "label" ||
    normalized === "text" ||
    normalized === "title" ||
    normalized === "heading"
  ) {
    return normalized;
  }

  return undefined;
}

function extract_unquoted_text_change(prompt: string): Pick<XVibeResolvedTask, "_edit_target_text" | "_edit_target_type" | "_edit_replacement_text" | "_edit_field"> | undefined {
  const object_hint_pattern = String.raw`(?:buttons?|labels?|texts?|titles?|headings?)`;
  const change_patterns = [
    new RegExp(
      String.raw`\b(?:change|update|set)\s+([^.!?\r\n]+?)\s+(${object_hint_pattern})\s+(?:text|label)\s+to\s+([^\r\n]+)`,
      "iu",
    ),
    new RegExp(
      String.raw`\brename\s+([^.!?\r\n]+?)\s+(${object_hint_pattern})\s+to\s+([^\r\n]+)`,
      "iu",
    ),
  ];

  for (const pattern of change_patterns) {
    const match = prompt.match(pattern);
    if (!match) continue;

    const target_text = trim_unquoted_edit_phrase(match[1] ?? "");
    const target_type = normalize_view_edit_target_type(match[2]);
    const replacement_text = trim_unquoted_replacement_text(match[3] ?? "");
    if (!target_text || !replacement_text) continue;

    return {
      _edit_target_text: target_text,
      ...(target_type ? { _edit_target_type: target_type } : {}),
      _edit_replacement_text: replacement_text,
      _edit_field: "_text",
    };
  }

  return undefined;
}

function normalize_view_edit_style_property(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/\s+/gu, " ");
  for (const [phrase, property] of VIEW_EDIT_STYLE_PROPERTY_ALIASES) {
    if (normalized === phrase) return property;
  }

  return undefined;
}

function parse_view_edit_style_target(value: string | undefined): Pick<XVibeResolvedTask, "_edit_target_id" | "_edit_target_text" | "_edit_target_type"> | undefined {
  const target = trim_unquoted_edit_phrase(value ?? "");
  if (!target) return undefined;

  const target_id =
    normalize_resolved_task_target_id(target);
  if (target_id && /[-_]/u.test(target_id)) {
    return { _edit_target_id: target_id };
  }

  const typed_target_match =
    target.match(new RegExp(String.raw`^(.+?)\s+(${VIEW_EDIT_OBJECT_NOUN_PATTERN})$`, "iu"));
  const target_type =
    normalize_view_edit_target_type(typed_target_match?.[2]);
  const target_text =
    typed_target_match
      ? trim_unquoted_edit_phrase(typed_target_match[1] ?? "")
      : target;
  if (!target_text) return undefined;

  return {
    _edit_target_text: target_text,
    ...(target_type ? { _edit_target_type: target_type } : {}),
  };
}

function parse_view_edit_move_ref(
  value: string | undefined,
  prefix: "target" | "anchor",
): Pick<XVibeResolvedTask, "_edit_target_id" | "_edit_target_text" | "_edit_target_type" | "_edit_anchor_id" | "_edit_anchor_text" | "_edit_anchor_type"> | undefined {
  const target = trim_unquoted_edit_phrase(value ?? "");
  if (!target) return undefined;

  const typed_target_match =
    target.match(new RegExp(String.raw`^(.+?)\s+(${VIEW_EDIT_OBJECT_NOUN_PATTERN})$`, "iu"));
  const target_type =
    normalize_view_edit_target_type(typed_target_match?.[2]);
  if (typed_target_match && target_type) {
    const target_text =
      trim_unquoted_edit_phrase(typed_target_match[1] ?? "");
    if (!target_text) return undefined;
    return prefix === "target"
      ? {
        _edit_target_text: target_text,
        _edit_target_type: target_type,
      }
      : {
        _edit_anchor_text: target_text,
        _edit_anchor_type: target_type,
      };
  }

  const target_id =
    normalize_resolved_task_target_id(target);
  if (target_id && /[-_]/u.test(target_id)) {
    return prefix === "target"
      ? { _edit_target_id: target_id }
      : { _edit_anchor_id: target_id };
  }

  return prefix === "target"
    ? { _edit_target_text: target }
    : { _edit_anchor_text: target };
}

function extract_move_edit_metadata(
  prompt: string,
  edit_action: XVibeResolvedTask["_edit_action"],
): Pick<XVibeResolvedTask, "_edit_target_id" | "_edit_target_text" | "_edit_target_type" | "_edit_move_position" | "_edit_anchor_id" | "_edit_anchor_text" | "_edit_anchor_type"> | undefined {
  if (edit_action !== "move-object") {
    return undefined;
  }

  const anchored_match =
    prompt.match(/\bmove\s+(.+?)\s+(before|after)\s+(.+?)(?:[.!?\r\n]|$)/iu);
  if (anchored_match) {
    const target =
      parse_view_edit_move_ref(anchored_match[1], "target");
    const anchor =
      parse_view_edit_move_ref(anchored_match[3], "anchor");
    const position = anchored_match[2]?.toLowerCase();
    if (
      target &&
      anchor &&
      (position === "before" || position === "after")
    ) {
      return {
        ...target,
        _edit_move_position: position,
        ...anchor,
      };
    }
  }

  const edge_match =
    prompt.match(/\bmove\s+(.+?)\s+to\s+(top|bottom)\b/iu);
  if (!edge_match) return undefined;

  const target =
    parse_view_edit_move_ref(edge_match[1], "target");
  const position = edge_match[2]?.toLowerCase();
  if (
    target &&
    (position === "top" || position === "bottom")
  ) {
    return {
      ...target,
      _edit_move_position: position,
    };
  }

  return undefined;
}

function extract_style_edit_metadata(
  prompt: string,
  edit_action: XVibeResolvedTask["_edit_action"],
): Pick<XVibeResolvedTask, "_edit_style_property" | "_edit_style_value" | "_edit_target_id" | "_edit_target_text" | "_edit_target_type"> | undefined {
  if (edit_action !== "set-style" && edit_action !== "remove-style") {
    return undefined;
  }

  const property_pattern = String.raw`(${VIEW_EDIT_STYLE_PROPERTY_PATTERN})`;
  const match =
    edit_action === "set-style"
      ? prompt.match(new RegExp(String.raw`\bset\s+(.+?)\s+${property_pattern}\s+to\s+([^\r\n]+)`, "iu"))
      : prompt.match(new RegExp(String.raw`\bremove\s+${property_pattern}\s+from\s+(.+?)(?:[.!?\r\n]|$)`, "iu"));
  if (!match) return undefined;

  const property =
    normalize_view_edit_style_property(
      edit_action === "set-style" ? match[2] : match[1],
    );
  if (!property) return undefined;

  const target =
    parse_view_edit_style_target(
      edit_action === "set-style" ? match[1] : match[2],
    );
  if (!target) return undefined;

  const style_value =
    edit_action === "set-style"
      ? trim_unquoted_replacement_text(match[3] ?? "")
      : undefined;
  if (edit_action === "set-style" && !style_value) {
    return undefined;
  }

  return {
    _edit_style_property: property,
    ...(style_value ? { _edit_style_value: style_value } : {}),
    ...target,
  };
}

function extract_style_class_rule_edit_metadata(
  prompt: string,
  edit_action: XVibeResolvedTask["_edit_action"],
): Pick<XVibeResolvedTask, "_edit_class_name" | "_edit_style_property" | "_edit_style_value"> | undefined {
  if (
    edit_action !== "set-style-class-rule" &&
    edit_action !== "remove-style-class-rule"
  ) {
    return undefined;
  }

  const property_pattern = String.raw`(${VIEW_EDIT_STYLE_PROPERTY_PATTERN})`;
  const class_name_pattern = String.raw`([a-z][a-z0-9]*[-_][a-z0-9_-]*)`;
  const match =
    edit_action === "set-style-class-rule"
      ? prompt.match(new RegExp(String.raw`\b(?:make|set)\s+${class_name_pattern}\s+${property_pattern}\s+(?!to\b)([^\r\n]+)`, "iu"))
      : prompt.match(new RegExp(String.raw`\bremove\s+${property_pattern}\s+from\s+${class_name_pattern}\s+class\b`, "iu"));
  if (!match) return undefined;

  const class_name =
    edit_action === "set-style-class-rule"
      ? normalize_resolved_task_target_id(match[1])
      : normalize_resolved_task_target_id(match[2]);
  if (!class_name) return undefined;

  const property =
    normalize_view_edit_style_property(
      edit_action === "set-style-class-rule" ? match[2] : match[1],
    );
  if (!property) return undefined;

  const style_value =
    edit_action === "set-style-class-rule"
      ? trim_unquoted_replacement_text(match[3] ?? "")
      : undefined;
  if (edit_action === "set-style-class-rule" && !style_value) {
    return undefined;
  }

  return {
    _edit_class_name: class_name,
    _edit_style_property: property,
    ...(style_value ? { _edit_style_value: style_value } : {}),
  };
}

function normalize_view_edit_property_name(value: string | undefined): string | undefined {
  const property_name =
    typeof value === "string"
      ? value.trim().toLowerCase()
      : "";
  return property_name || undefined;
}

function coerce_view_edit_property_value(value: string): string | number | boolean | null {
  const trimmed = trim_unquoted_replacement_text(value);
  if (/^true$/iu.test(trimmed)) return true;
  if (/^false$/iu.test(trimmed)) return false;
  if (/^null$/iu.test(trimmed)) return null;
  if (/^-?\d+(?:\.\d+)?$/u.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function extract_property_edit_metadata(
  prompt: string,
  edit_action: XVibeResolvedTask["_edit_action"],
): Pick<XVibeResolvedTask, "_edit_property_name" | "_edit_property_value" | "_edit_target_id" | "_edit_target_text" | "_edit_target_type"> | undefined {
  if (edit_action !== "set-property" && edit_action !== "remove-property") {
    return undefined;
  }

  const property_pattern = String.raw`(${VIEW_EDIT_PROPERTY_NAME_PATTERN})`;
  const match =
    edit_action === "set-property"
      ? prompt.match(new RegExp(String.raw`\bset\s+(.+?)\s+${property_pattern}\s+to\s+([^\r\n]+)`, "iu"))
      : prompt.match(new RegExp(String.raw`\bremove\s+${property_pattern}\s+from\s+(.+?)(?:[.!?\r\n]|$)`, "iu"));
  if (!match) return undefined;

  const property_name =
    normalize_view_edit_property_name(
      edit_action === "set-property" ? match[2] : match[1],
    );
  if (!property_name) return undefined;

  const target =
    parse_view_edit_style_target(
      edit_action === "set-property" ? match[1] : match[2],
    );
  if (!target) return undefined;

  return {
    _edit_property_name: property_name,
    ...(edit_action === "set-property"
      ? { _edit_property_value: coerce_view_edit_property_value(match[3] ?? "") }
      : {}),
    ...target,
  };
}

function extract_class_edit_metadata(
  prompt: string,
  edit_action: XVibeResolvedTask["_edit_action"],
): Pick<XVibeResolvedTask, "_edit_class_name" | "_edit_old_class_name" | "_edit_new_class_name" | "_edit_target_id" | "_edit_target_text" | "_edit_target_type"> | undefined {
  if (
    edit_action !== "add-class" &&
    edit_action !== "remove-class" &&
    edit_action !== "replace-class" &&
    edit_action !== "toggle-class"
  ) {
    return undefined;
  }

  const verb =
    edit_action === "add-class"
      ? "add"
      : edit_action === "remove-class"
        ? "remove"
        : edit_action === "replace-class"
          ? "replace"
          : "toggle";
  const preposition =
    edit_action === "add-class"
      ? "to"
      : edit_action === "remove-class"
        ? "from"
        : "on";
  const class_pattern =
    edit_action === "replace-class"
      ? String.raw`([a-z][a-z0-9_-]*)\s+with\s+([a-z][a-z0-9_-]*)`
      : String.raw`([a-z][a-z0-9_-]*)`;
  const base_pattern = String.raw`\b${verb}\s+class\s+([a-z][a-z0-9_-]*)\s+${preposition}\s+(?:the\s+)?`;
  const replace_base_pattern = String.raw`\b${verb}\s+class\s+${class_pattern}\s+${preposition}\s+(?:the\s+)?`;
  const effective_base_pattern =
    edit_action === "replace-class"
      ? replace_base_pattern
      : base_pattern;
  const class_name_pattern = new RegExp(
    `${effective_base_pattern}([a-z][a-z0-9]*[-_][a-z0-9_-]*)(?:\\s|$|[.,;:!?])`,
    "iu",
  );
  const text_type_pattern = new RegExp(
    `${effective_base_pattern}(?:"([^"]+)"|'([^']+)'|([^.!?\\r\\n]+?))\\s+(button|label|text|title|heading)\\b`,
    "iu",
  );

  const text_type_match = prompt.match(text_type_pattern);
  if (text_type_match) {
    const class_name = text_type_match[1]?.trim();
    const new_class_name =
      edit_action === "replace-class"
        ? text_type_match[2]?.trim()
        : undefined;
    const target_offset = edit_action === "replace-class" ? 1 : 0;
    const target_text =
      text_type_match[2 + target_offset]?.trim() ??
      text_type_match[3 + target_offset]?.trim() ??
      trim_unquoted_edit_phrase(text_type_match[4 + target_offset] ?? "");
    const target_type = normalize_view_edit_target_type(text_type_match[5 + target_offset]);
    if (class_name && target_text && (edit_action !== "replace-class" || new_class_name)) {
      return {
        ...(edit_action === "replace-class"
          ? {
            _edit_old_class_name: class_name,
            _edit_new_class_name: new_class_name,
          }
          : { _edit_class_name: class_name }),
        _edit_target_text: target_text,
        ...(target_type ? { _edit_target_type: target_type } : {}),
      };
    }
  }

  const class_name_match = prompt.match(class_name_pattern);
  const class_name = class_name_match?.[1]?.trim();
  const new_class_name =
    edit_action === "replace-class"
      ? class_name_match?.[2]?.trim()
      : undefined;
  const target_id_index = edit_action === "replace-class" ? 3 : 2;
  const target_id =
    normalize_resolved_task_target_id(class_name_match?.[target_id_index]);
  if (class_name && target_id && (edit_action !== "replace-class" || new_class_name)) {
    return {
      ...(edit_action === "replace-class"
        ? {
          _edit_old_class_name: class_name,
          _edit_new_class_name: new_class_name,
        }
        : { _edit_class_name: class_name }),
      _edit_target_id: target_id,
    };
  }

  return undefined;
}

function extract_view_edit_metadata(prompt: string): Pick<XVibeResolvedTask, "_edit_action" | "_edit_target_id" | "_edit_target_text" | "_edit_target_type" | "_edit_replacement_text" | "_edit_class_name" | "_edit_old_class_name" | "_edit_new_class_name" | "_edit_style_property" | "_edit_style_value" | "_edit_property_name" | "_edit_property_value" | "_edit_move_position" | "_edit_anchor_id" | "_edit_anchor_text" | "_edit_anchor_type" | "_edit_field"> | undefined {
  const text = normalize_artifact_intent_prompt(prompt);
  const edit_action = detect_view_edit_action(text);
  if (!edit_action || !prompt_has_view_child_edit(text)) return undefined;

  const metadata: Pick<XVibeResolvedTask, "_edit_action" | "_edit_target_id" | "_edit_target_text" | "_edit_target_type" | "_edit_replacement_text" | "_edit_class_name" | "_edit_old_class_name" | "_edit_new_class_name" | "_edit_style_property" | "_edit_style_value" | "_edit_property_name" | "_edit_property_value" | "_edit_move_position" | "_edit_anchor_id" | "_edit_anchor_text" | "_edit_anchor_type" | "_edit_field"> = {
    _edit_action: edit_action,
  };

  const move_edit =
    extract_move_edit_metadata(prompt, edit_action);
  if (move_edit) {
    Object.assign(metadata, move_edit);
    return metadata;
  }

  const style_class_rule_edit =
    extract_style_class_rule_edit_metadata(prompt, edit_action);
  if (style_class_rule_edit) {
    Object.assign(metadata, style_class_rule_edit);
    return metadata;
  }

  const style_edit = extract_style_edit_metadata(prompt, edit_action);
  if (style_edit) {
    Object.assign(metadata, style_edit);
    return metadata;
  }

  const property_edit =
    extract_property_edit_metadata(prompt, edit_action);
  if (property_edit) {
    Object.assign(metadata, property_edit);
    return metadata;
  }

  const class_edit = extract_class_edit_metadata(prompt, edit_action);
  if (class_edit) {
    Object.assign(metadata, class_edit);
    return metadata;
  }

  const text_change = extract_quoted_text_change(prompt);
  if (text_change) {
    Object.assign(metadata, text_change);
  } else {
    const unquoted_text_change = extract_unquoted_text_change(prompt);
    if (unquoted_text_change) {
      Object.assign(metadata, unquoted_text_change);
    }
  }

  const quoted_target_match =
    prompt.match(/\b(?:delete|remove|hide|show|unhide)\s+(?:the\s+)?(?:(button|label|text|title|heading)\s+)?["']([^"']+)["'](?:\s+(button|label|text|title|heading))?/iu);
  const quoted_target = quoted_target_match?.[2];
  if (quoted_target?.trim() && !metadata._edit_target_text) {
    metadata._edit_target_text = quoted_target.trim();
  }
  const quoted_target_type =
    normalize_view_edit_target_type(quoted_target_match?.[1] ?? quoted_target_match?.[3]);
  if (quoted_target_type && !metadata._edit_target_type) {
    metadata._edit_target_type = quoted_target_type;
  }

  const unquoted_remove_match =
    edit_action === "remove"
      ? prompt.match(/\b(?:delete|remove)\s+(?:the\s+)?([^.!?\r\n]+?)\s+(button|label|text|title|heading)\b/iu)
      : undefined;
  const unquoted_remove_target = unquoted_remove_match?.[1];
  if (unquoted_remove_target?.trim() && !metadata._edit_target_text) {
    metadata._edit_target_text = trim_unquoted_edit_phrase(unquoted_remove_target);
  }
  const unquoted_remove_target_type =
    normalize_view_edit_target_type(unquoted_remove_match?.[2]);
  if (unquoted_remove_target_type && !metadata._edit_target_type) {
    metadata._edit_target_type = unquoted_remove_target_type;
  }

  const unquoted_hide_match =
    edit_action === "hide"
      ? (
        prompt.match(/\bhide\s+(?:the\s+)?([^.!?\r\n]+?)\s+(button|label|text|title|heading)\b/iu) ??
        prompt.match(/\bmake\s+(?:the\s+)?([^.!?\r\n]+?)\s+(button|label|text|title|heading)\s+hidden\b/iu)
      )
      : undefined;
  const unquoted_hide_target = unquoted_hide_match?.[1];
  if (unquoted_hide_target?.trim() && !metadata._edit_target_text) {
    metadata._edit_target_text = trim_unquoted_edit_phrase(unquoted_hide_target);
  }
  const unquoted_hide_target_type =
    normalize_view_edit_target_type(unquoted_hide_match?.[2]);
  if (unquoted_hide_target_type && !metadata._edit_target_type) {
    metadata._edit_target_type = unquoted_hide_target_type;
  }

  const unquoted_show_match =
    edit_action === "show"
      ? (
        prompt.match(/\b(?:show|unhide)\s+(?:the\s+)?([^.!?\r\n]+?)\s+(button|label|text|title|heading)\b/iu) ??
        prompt.match(/\bmake\s+(?:the\s+)?([^.!?\r\n]+?)\s+(button|label|text|title|heading)\s+visible\b/iu)
      )
      : undefined;
  const unquoted_show_target = unquoted_show_match?.[1];
  if (unquoted_show_target?.trim() && !metadata._edit_target_text) {
    metadata._edit_target_text = trim_unquoted_edit_phrase(unquoted_show_target);
  }
  const unquoted_show_target_type =
    normalize_view_edit_target_type(unquoted_show_match?.[2]);
  if (unquoted_show_target_type && !metadata._edit_target_type) {
    metadata._edit_target_type = unquoted_show_target_type;
  }

  const id_target =
    prompt.match(
      new RegExp(
        String.raw`\b(?:delete|remove|hide|show|unhide)\s+(?:the\s+)?(?:${VIEW_EDIT_OBJECT_NOUN_PATTERN}\s+)?([a-z][a-z0-9]*[-_][a-z0-9_-]*)\b`,
        "iu",
      ),
    )?.[1];
  const normalized_id = normalize_resolved_task_target_id(id_target);
  if (normalized_id) {
    metadata._edit_target_id = normalized_id;
  }

  return metadata;
}

function extract_explicit_resolved_target_id(
  prompt: string,
  artifact_type: XVibeResolvedTaskArtifactType,
): string | undefined {
  if (
    artifact_type !== "view" &&
    artifact_type !== "flow" &&
    artifact_type !== "entity"
  ) {
    return undefined;
  }

  return normalize_resolved_task_target_id(
    extract_artifact_target_id(prompt, artifact_type),
  );
}

function is_resolved_task_explicit_artifact_type(
  input: {
    _requested_artifact_type?: VibeRequestedArtifactType;
    _prompt: string;
    _intent: XVibeArtifactIntent;
    _artifact_type: XVibeResolvedTaskArtifactType;
  },
): boolean {
  if (artifact_type_from_requested_artifact_type(input._requested_artifact_type)) {
    return true;
  }

  if (input._artifact_type === "app" && explicit_app_artifact_type(input._prompt)) {
    return true;
  }

  return input._intent._target !== "unknown" && input._intent._reason !== "fallback_view";
}

export function resolve_xvibe_task(input: {
  _prompt: string;
  _requested_artifact_type?: VibeRequestedArtifactType;
  _view_id?: string;
}): XVibeResolvedTask {
  const planner = new VibeIntentPlanner();
  const prompt = input._prompt;
  const intent = planner.infer_artifact_intent(prompt);
  const warnings: string[] = [];
  const requested_artifact_type =
    artifact_type_from_requested_artifact_type(input._requested_artifact_type);
  let artifact_type: XVibeResolvedTaskArtifactType =
    requested_artifact_type ??
    (explicit_app_artifact_type(prompt)
      ? "app"
      : resolved_artifact_type_from_intent_target(intent._target));
  let target_id: string | undefined;
  let explicit_target_id = false;
  let module_name: string | undefined;
  const module_ops =
    extract_explicit_module_ops_from_prompt(prompt);

  if (artifact_type === "unknown" && intent._reason === "fallback_view") {
    artifact_type = "view";
  }

  if (artifact_type === "view") {
    const view_id =
      normalize_resolved_task_target_id(input._view_id);
    if (view_id) {
      target_id = view_id;
      explicit_target_id = true;
    } else {
      const explicit_id =
        extract_explicit_resolved_target_id(prompt, artifact_type);
      if (explicit_id) {
        target_id = explicit_id;
        explicit_target_id = true;
      } else {
        const explicit_view_target_id =
          extract_explicit_view_target_id(prompt);
        if (explicit_view_target_id) {
          target_id = explicit_view_target_id;
          explicit_target_id = true;
        } else if (prompt_explicitly_targets_main_view(prompt)) {
          target_id = "main";
          explicit_target_id = true;
        }
      }
    }
  } else if (artifact_type === "flow" || artifact_type === "entity") {
    const explicit_id =
      extract_explicit_resolved_target_id(prompt, artifact_type);
    if (explicit_id) {
      target_id = explicit_id;
      explicit_target_id = true;
    }
  }

  const edit_metadata =
    artifact_type === "view"
      ? extract_view_edit_metadata(prompt)
      : undefined;
  const resolved_action =
    edit_metadata ? "update" : intent._action;

  if (artifact_type === "view" && edit_metadata && !target_id) {
    const view_id =
      normalize_resolved_task_target_id(input._view_id);
    if (view_id) {
      target_id = view_id;
      explicit_target_id = true;
    }
  }

  if (artifact_type === "module") {
    module_name = extract_explicit_module_id_from_prompt(prompt);
    if (module_ops.length === 0) {
      warnings.push("missing_explicit_module_ops");
    }
  }

  const rejected_intent_id =
    intent._target_id &&
    !target_id &&
    RESERVED_RESOLVED_TASK_TARGET_IDS.has(intent._target_id);
  if (rejected_intent_id) {
    warnings.push("rejected_reserved_target_id");
  }

  return {
    _action: resolved_action,
    _artifact_type: artifact_type,
    ...(target_id ? { _target_id: target_id } : {}),
    ...(edit_metadata ?? {}),
    _explicit_artifact_type:
      is_resolved_task_explicit_artifact_type({
        _requested_artifact_type: input._requested_artifact_type,
        _prompt: prompt,
        _intent: intent,
        _artifact_type: artifact_type,
      }),
    _explicit_target_id: explicit_target_id,
    ...(module_name ? { _module_name: module_name } : {}),
    _module_ops: module_ops,
    _source: intent._reason,
    _confidence: intent._confidence,
    _warnings: unique(warnings),
  };
}

function collect_plan_artifact_types(plan: unknown): Set<string> {
  const types = new Set<string>();
  const visit = (value: unknown): void => {
    if (!is_plain_object(value)) return;

    if (typeof value._primary_artifact_type === "string") {
      types.add(value._primary_artifact_type);
    }

    if (typeof value._artifact_type === "string") {
      types.add(value._artifact_type);
    }

    if (Array.isArray(value._artifact_types)) {
      for (const item of value._artifact_types) {
        if (typeof item === "string") types.add(item);
      }
    }

    if (Array.isArray(value._artifacts)) {
      for (const item of value._artifacts) visit(item);
    }

    if (is_plain_object(value._execution_plan)) {
      visit(value._execution_plan);
    }
  };

  visit(plan);
  return types;
}

function collect_plan_ids_for_artifact_type(
  plan: unknown,
  artifact_type: string,
): string[] {
  const ids: string[] = [];
  const add_id = (value: unknown): void => {
    if (typeof value !== "string") return;
    const id = normalize_resolved_task_target_id(value);
    if (id) ids.push(id);
  };
  const visit = (value: unknown): void => {
    if (!is_plain_object(value)) return;

    if (
      value._artifact_type === artifact_type ||
      value._primary_artifact_type === artifact_type
    ) {
      add_id(value._artifact_id);
      add_id(value._target_id);
      add_id(value._view_id);
      add_id(value._flow_id);
      add_id(value._entity_id);
    }

    if (artifact_type === "flow" && Array.isArray(value._flow_ids)) {
      for (const item of value._flow_ids) add_id(item);
    }

    if (artifact_type === "entity" && Array.isArray(value._entity_ids)) {
      for (const item of value._entity_ids) add_id(item);
    }

    if (artifact_type === "module" && Array.isArray(value._module_names)) {
      for (const item of value._module_names) add_id(item);
    }

    if (Array.isArray(value._artifacts)) {
      for (const item of value._artifacts) visit(item);
    }

    if (is_plain_object(value._execution_plan)) {
      visit(value._execution_plan);
    }
  };

  visit(plan);
  return unique(ids);
}

export function warn_if_plan_violates_resolved_task(
  resolved_task: XVibeResolvedTask,
  plan: unknown,
): void {
  const artifact_types =
    collect_plan_artifact_types(plan);
  const primary_artifact_type =
    is_plain_object(plan) && typeof plan._primary_artifact_type === "string"
      ? plan._primary_artifact_type
      : undefined;

  if (
    resolved_task._artifact_type === "module" &&
    (
      artifact_types.has("view") ||
      artifact_types.has("entity") ||
      artifact_types.has("flow")
    )
  ) {
    _xlog.warn("[xvibe] resolved task soft lock violation", {
      _reason: "module_plan_includes_non_module_artifact",
      _resolved_task: resolved_task,
      _plan_artifact_types: [...artifact_types],
    });
  }

  if (
    resolved_task._artifact_type === "view" &&
    primary_artifact_type === "entity"
  ) {
    _xlog.warn("[xvibe] resolved task soft lock violation", {
      _reason: "view_plan_primary_artifact_is_entity",
      _resolved_task: resolved_task,
      _plan_primary_artifact_type: primary_artifact_type,
    });
  }

  if (resolved_task._target_id) {
    const plan_ids =
      collect_plan_ids_for_artifact_type(
        plan,
        resolved_task._artifact_type,
      );
    const mismatched_ids =
      plan_ids.filter((id) => id !== resolved_task._target_id);
    if (mismatched_ids.length > 0) {
      _xlog.warn("[xvibe] resolved task soft lock violation", {
        _reason: "target_id_mismatch",
        _resolved_task: resolved_task,
        _plan_target_ids: plan_ids,
      });
    }
  }
}

function module_target_from_resolved_task_prompt(prompt: string): Exclude<VibeModuleTarget, null> {
  const text = normalize_artifact_intent_prompt(prompt);
  return /\bclient\s+(?:xmodule|module)\b/u.test(text)
    ? "client"
    : "server";
}

export function create_module_intent_plan_from_resolved_task(
  resolved_task: XVibeResolvedTask,
  prompt: string,
  runtime_capabilities: VibeRuntimeCapabilityRegistry,
): VibeIntentPlan {
  return {
    _ir_version: INTENT_IR_VERSION,
    _intent_type: "module",
    _artifact_types: ["module"],
    _entities: [],
    _regions: [],
    _objects: [],
    _actions: [],
    _bindings: [],
    _modules: [],
    _style: {},
    _xui_objects: [],
    _capabilities: [],
    _crud_ops: [],
    _ui_patterns: [],
    _ui_keywords: [],
    _flow_keywords: [],
    _entity_keywords: [],
    _requires_module: true,
    _module_target: module_target_from_resolved_task_prompt(prompt),
    _module_name: resolved_task._module_name,
    _module_ops: resolved_task._module_ops,
    _module_reason: "Resolved XVibe task requested module generation.",
    _runtime_capabilities: runtime_capabilities,
  };
}

function unique_artifact_targets(values: XVibeArtifactIntentTarget[]): XVibeArtifactIntentTarget[] {
  return Array.from(new Set(values));
}

function artifact_target_from_word(value: string | undefined): XVibeArtifactIntentTarget | undefined {
  if (!value) return undefined;
  return ARTIFACT_TARGET_PLURALS[value.toLowerCase()];
}

function detect_artifact_action(text: string): XVibeArtifactIntentAction {
  const action_text = strip_negated_artifact_phrases(text);
  if (/\b(?:delete|remove)\b/u.test(action_text)) return "delete";
  if (/\bdisable\b/u.test(action_text)) return "disable";
  if (/\barchive\b/u.test(action_text)) return "archive";
  if (/\brename\b/u.test(action_text)) return "rename";
  if (/\b(?:update|change|edit|modify)\b/u.test(action_text)) return "update";
  if (
    /\b(?:nicer|style|styling|design|visual|polish|improve|prettier|better)\b/u.test(action_text) &&
    /\b(?:view|page|screen|form|layout|button|buttons|field|fields)\b/u.test(action_text)
  ) {
    return "update";
  }
  if (/\b(?:create|build|generate|add|make)\b/u.test(action_text)) return "create";
  if (/\b(?:list|show|inspect|check)\b/u.test(action_text)) return "inspect";
  return "unknown";
}

function normalize_artifact_action_word(value: string | undefined): XVibeArtifactIntentAction {
  if (!value) return "unknown";
  const normalized = value.toLowerCase();
  if (normalized === "remove") return "delete";
  if (normalized === "change" || normalized === "edit" || normalized === "modify") return "update";
  if (normalized === "build" || normalized === "generate" || normalized === "add" || normalized === "make") return "create";
  if (
    normalized === "create" ||
    normalized === "update" ||
    normalized === "delete" ||
    normalized === "disable" ||
    normalized === "archive" ||
    normalized === "rename"
  ) {
    return normalized;
  }

  return "unknown";
}

function detect_forbidden_artifact_targets(text: string): XVibeArtifactIntentTarget[] {
  const forbidden: XVibeArtifactIntentTarget[] = [];
  const negated_pattern =
    /\bdo\s+not\s+create\s+(?:a\s+|an\s+|the\s+)?(views?|flows?|entities|entity|modules?)\b/gu;
  const without_pattern =
    /\bwithout\s+(views?|flows?|entities|entity|modules?)\b/gu;
  const negated_action_pattern =
    /\b(?:do\s+not|don't|dont)\s+(?:delete|remove|update|change|edit|modify)\s+(?:the\s+)?(?:[a-z][a-z0-9_-]*\s+)?(views?|view|pages?|page|screens?|screen|forms?|form|flows?|flow|entities|entity|modules?|module)\b/gu;
  const negated_main_view_pattern =
    /\b(?:do\s+not|don't|dont|preserve|keep(?:\s+existing)?)\s+(?:delete|remove|update|change|edit|modify)?\s*(?:the\s+)?main(?:\s+(?:views?|pages?|screens?|forms?))?\b/gu;

  for (const match of text.matchAll(negated_pattern)) {
    const target = artifact_target_from_word(match[1]);
    if (target) forbidden.push(target);
  }

  for (const match of text.matchAll(without_pattern)) {
    const target = artifact_target_from_word(match[1]);
    if (target) forbidden.push(target);
  }

  for (const match of text.matchAll(negated_action_pattern)) {
    const target = artifact_target_from_noun(match[1]);
    if (target) forbidden.push(target);
  }

  if (negated_main_view_pattern.test(text)) {
    forbidden.push("view");
  }

  return unique_artifact_targets(forbidden);
}

function strip_negated_artifact_phrases(value: string): string {
  return value
    .replace(/\bdo\s+not\s+create\s+(?:a\s+|an\s+|the\s+)?(?:views?|flows?|entities|entity|modules?)\b/giu, " ")
    .replace(/\b(?:do\s+not|don't|dont)\s+(?:delete|remove|update|change|edit|modify)\s+(?:the\s+)?(?:[a-z][a-z0-9_-]*\s+)?(?:views?|view|pages?|page|screens?|screen|forms?|form|flows?|flow|entities|entity|modules?|module)\b/giu, " ")
    .replace(/\b(?:do\s+not|don't|dont)\s+(?:delete|remove|update|change|edit|modify)\s+(?:the\s+)?main(?:\s+(?:views?|pages?|screens?|forms?))?\b/giu, " ")
    .replace(/\b(?:preserve|keep(?:\s+existing)?)\s+(?:the\s+)?main(?:\s+(?:views?|pages?|screens?|forms?))?\b/giu, " ")
    .replace(/\bwithout\s+(?:views?|flows?|entities|entity|modules?)\b/giu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function detect_only_artifact_target(text: string): {
  action: XVibeArtifactIntentAction;
  target: XVibeArtifactIntentTarget;
} | undefined {
  const only_action_match =
    text.match(/\bonly\s+(create|update|delete|remove|disable|archive|rename)\s+(?:a\s+|an\s+|the\s+)?(view|flow|entity|module)\b/u);
  if (only_action_match) {
    return {
      action: only_action_match[1] === "remove" ? "delete" : only_action_match[1] as XVibeArtifactIntentAction,
      target: only_action_match[2] as XVibeArtifactIntentTarget,
    };
  }

  const only_target_match =
    text.match(/\b(view|flow|entity|module)\s+only\b/u) ??
    text.match(/\bonly\s+(?:a\s+|an\s+|the\s+)?(view|flow|entity|module)\b/u);
  if (!only_target_match) return undefined;

  return {
    action: detect_artifact_action(text),
    target: only_target_match[1] as XVibeArtifactIntentTarget,
  };
}

function forbidden_for_only_target(target: XVibeArtifactIntentTarget): XVibeArtifactIntentTarget[] {
  return ARTIFACT_INTENT_TARGETS.filter((candidate) => candidate !== target);
}

function regex_escape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function artifact_target_id_from_pattern(prompt: string, pattern: RegExp): string | undefined {
  const match = prompt.match(pattern);
  return normalize_artifact_identifier(match?.[1]);
}

function extract_artifact_target_id(
  prompt: string,
  target: XVibeArtifactIntentTarget,
): string | undefined {
  if (
    target !== "view" &&
    target !== "flow" &&
    target !== "entity" &&
    target !== "module"
  ) {
    return undefined;
  }

  const target_pattern = regex_escape(target);
  const named_id =
    artifact_target_id_from_pattern(
      prompt,
      new RegExp(String.raw`\b${target_pattern}\s+(?:named|called|id)\s+${ARTIFACT_INTENT_TOKEN_PATTERN}(?:\s|$|[.,;:])`, "iu"),
    );
  if (named_id) return named_id;

  if (target === "view") {
    const new_view_id = artifact_target_id_from_pattern(
      prompt,
      new RegExp(String.raw`\b(?:create|build|generate|add|make)\s+(?:a\s+|an\s+|the\s+)?new\s+${target_pattern}\s+("[^"]+"|'[^']+'|[a-z][a-z0-9_-]*)(?:\s|$|[.,;:])`, "iu"),
    );
    if (new_view_id) return new_view_id;

    const quoted_view_id = artifact_target_id_from_pattern(
      prompt,
      new RegExp(String.raw`\b${target_pattern}\s+("[^"]+"|'[^']+')(?:\s|$|[.,;:])`, "iu"),
    );
    if (quoted_view_id) return quoted_view_id;
  }

  if (target !== "view") {
    const quoted_id =
      artifact_target_id_from_pattern(
        prompt,
        new RegExp(String.raw`\b${target_pattern}\s+${ARTIFACT_INTENT_TOKEN_PATTERN}(?:\s|$|[.,;:])`, "iu"),
      );
    if (quoted_id) return quoted_id;
  }

  return artifact_target_id_from_pattern(
    prompt,
    new RegExp(
      String.raw`\b(?:create|build|generate|add|make|delete|remove|update|change|edit|modify|rename)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?${target_pattern}\s+${ARTIFACT_INTENT_TOKEN_PATTERN}\b`,
      "iu",
    ),
  );
}

function infer_explicit_artifact_target(text: string): {
  target: XVibeArtifactIntentTarget;
  confidence: number;
  reason: string;
} | undefined {
  if (/\b(?:update|change|edit|modify)\s+(?:a\s+|an\s+|the\s+)?(?:main\s+|current\s+)?(?:view|page|screen|form)\b/u.test(text)) {
    return { target: "view", confidence: 0.95, reason: "explicit_view_intent" };
  }

  if (/\b(?:create|build|generate|add|make)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?(?:login\s+)?(?:view|page|screen|form)\b/u.test(text)) {
    return { target: "view", confidence: 0.95, reason: "explicit_view_intent" };
  }

  if (/\bflow\s+named\s+[a-z][a-z0-9_-]*\b/u.test(text)) {
    return { target: "flow", confidence: 0.85, reason: "explicit_named_flow" };
  }

  if (/\b(?:create|build|generate|add|make)\s+(?:a\s+|an\s+|the\s+)?(?:flow|workflow)\b/u.test(text)) {
    return { target: "flow", confidence: 0.95, reason: "explicit_named_flow" };
  }

  if (/\bentity\s+named\s+[a-z][a-z0-9_-]*\b/u.test(text)) {
    return { target: "entity", confidence: 0.85, reason: "explicit_named_entity" };
  }

  if (/\b(?:create|build|generate|add|make)\s+(?:a\s+|an\s+|the\s+)?(?:entity|schema|database|collection|record\s+model)\b/u.test(text)) {
    return { target: "entity", confidence: 0.95, reason: "explicit_entity_intent" };
  }

  if (/\bmodule\s+named\s+[a-z][a-z0-9_-]*\b/u.test(text)) {
    return { target: "module", confidence: 0.85, reason: "explicit_named_module" };
  }

  if (/\b(?:create|build|generate|add|make)\s+(?:a\s+|an\s+|the\s+)?(?:server\s+module|client\s+module|xmodule|module)\b/u.test(text)) {
    return { target: "module", confidence: 0.95, reason: "explicit_module_intent" };
  }

  if (/\b(?:delete|remove|rename)\s+(?:a\s+|an\s+|the\s+)?(view|flow|entity|module)\b/u.test(text)) {
    const target = artifact_target_from_word(text.match(/\b(?:delete|remove|rename)\s+(?:a\s+|an\s+|the\s+)?(view|flow|entity|module)\b/u)?.[1]);
    if (target) {
      return {
        target,
        confidence: 0.95,
        reason:
          target === "flow"
            ? "explicit_named_flow"
            : target === "entity"
              ? "explicit_entity_intent"
              : target === "module"
                ? "explicit_module_intent"
                : "explicit_view_intent",
      };
    }
  }

  return undefined;
}

function infer_vocabulary_artifact_target(text: string): {
  target: XVibeArtifactIntentTarget;
  confidence: number;
  reason: string;
} | undefined {
  if (/\b(?:page|screen|form|button|field|layout|view|dashboard)\b/u.test(text)) {
    return { target: "view", confidence: 0.7, reason: "explicit_view_intent" };
  }

  if (/\b(?:entity|entities|schema|schemas|database|collection|record\s+model)\b/u.test(text)) {
    return { target: "entity", confidence: 0.7, reason: "explicit_entity_intent" };
  }

  if (/\b(?:server\s+module|client\s+module|xmodule|module)\b/u.test(text)) {
    return { target: "module", confidence: 0.7, reason: "explicit_module_intent" };
  }

  if (/\b(?:flow|workflow)\b/u.test(text)) {
    return { target: "flow", confidence: 0.7, reason: "explicit_named_flow" };
  }

  return undefined;
}

function is_explicit_artifact_type(value: VibeRequestedArtifactType | undefined): value is VibeArtifactType {
  return (
    value === "view" ||
    value === "flow" ||
    value === "entity" ||
    value === "command"
  );
}

function artifact_type_for_intent_target(target: XVibeArtifactIntentTarget): VibeArtifactType | undefined {
  if (
    target === "view" ||
    target === "flow" ||
    target === "entity"
  ) {
    return target;
  }

  return undefined;
}

function prompt_has_explicit_view_update(text: string): boolean {
  return /\b(?:update|change|edit|modify)\s+(?:a\s+|an\s+|the\s+)?(?:main\s+|current\s+)?(?:view|page|screen|form)\b/u.test(text);
}

function prompt_has_view_update_request(text: string): boolean {
  return (
    prompt_has_explicit_view_update(text) ||
    prompt_has_view_child_edit(text) ||
    /\b(?:update|change|edit|modify|replace)\b[\s\S]{0,120}\b(?:view|page|screen|form|button|field|layout)\b/u.test(text)
  );
}

export function has_explicit_flow_intent(text: string): boolean {
  return (
    /\bflow-[a-z0-9][a-z0-9_-]*\b/u.test(text) ||
    /\bflow\s+named\s+[a-z][a-z0-9_-]*\b/u.test(text) ||
    /\b(?:create|build|generate|add|make)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?flow(?:\s+named)?(?:\s+[a-z][a-z0-9_-]*)?\b/u.test(text) ||
    /\bwith\s+[a-z][a-z0-9_-]*\s+flow\b/u.test(text) ||
    /\bbutton\b[\s\S]{0,80}\b(?:trigger|triggers|triggering|run|runs|running|execute|executes|executing|call|calls|calling)\s+(?:a\s+|an\s+|the\s+)?(?:[a-z][a-z0-9_-]*\s+)?flow\b/u.test(text) ||
    /\b(?:trigger|triggers|triggering|run|runs|running|execute|executes|executing|call|calls|calling)\s+(?:a|an|the)?\s*flow\b/u.test(text) ||
    /\bflow\s+(?:trigger|action|button)\b/u.test(text)
  );
}

export function extract_prompt_flow_ids(text: string): string[] {
  const ids: string[] = [];
  ids.push(...(text.match(/\bflow-[a-z0-9][a-z0-9_-]*\b/gi) ?? []));

  const flow_id_patterns = [
    /\b(?:run|trigger|call|execute|create|build|generate|add|make)?\s*(?:a\s+|an\s+|the\s+)?flow\s+named\s+([a-z][a-z0-9_-]*)\b/giu,
    /\b(?:create|build|generate|add|make)\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?flow\s+([a-z][a-z0-9_-]*)\b/giu,
    /\bwith\s+([a-z][a-z0-9_-]*)\s+flow\b/giu,
    /\bbutton\b[\s\S]{0,80}\b(?:trigger|triggers|triggering|run|runs|running|execute|executes|executing|call|calls|calling)\s+(?:a\s+|an\s+|the\s+)?([a-z][a-z0-9_-]*)\s+flow\b/giu,
    /\b(?:trigger|triggers|triggering|run|runs|running|execute|executes|executing|call|calls|calling)\s+(?:a\s+|an\s+|the\s+)?([a-z][a-z0-9_-]*)\s+flow\b/giu,
  ];

  for (const pattern of flow_id_patterns) {
    for (const match of text.matchAll(pattern)) {
      ids.push(match[1]);
    }
  }

  return unique(
    ids
      .map((match) => match.trim().toLowerCase())
      .filter((match) => match.length > 0)
      .filter((match) => !RESERVED_RESOLVED_TASK_TARGET_IDS.has(match))
  );
}

function execution_action_for_intent(
  intent: XVibeArtifactIntent,
  artifact_type: XVibeInferredArtifactType,
  prompt: string,
): XVibeArtifactExecutionPlan["_artifacts"][number]["_action"] {
  if (
    intent._target === artifact_target_from_artifact_type(artifact_type) &&
    (
      intent._action === "create" ||
      intent._action === "update" ||
      intent._action === "delete" ||
      intent._action === "disable" ||
      intent._action === "archive"
    )
  ) {
    return intent._action;
  }

  if (artifact_type === "view" && prompt_has_view_update_request(prompt)) {
    return "update";
  }

  return "create";
}

function execution_view_id(prompt: string, intent: XVibeArtifactIntent): string {
  if (intent._target === "view" && intent._target_id === "main") {
    return "main";
  }

  const explicit_named_view =
    artifact_target_id_from_pattern(
      prompt,
      new RegExp(String.raw`\bview\s+(?:named|called|id)\s+${ARTIFACT_INTENT_TOKEN_PATTERN}(?:\s|$|[.,;:])`, "iu"),
    );
  if (explicit_named_view) return explicit_named_view;

  return "main";
}

function execution_artifact_ids_for_type(
  prompt: string,
  intent: XVibeArtifactIntent,
  plan: XVibeInferredArtifactPlan,
  artifact_type: XVibeInferredArtifactType,
): string[] {
  if (artifact_type === "flow") {
    return unique([
      ...(plan._flow_ids ?? []),
      ...(intent._target === "flow" && intent._target_id ? [intent._target_id] : []),
    ]);
  }

  if (artifact_type === "entity") {
    return unique([
      ...(plan._entity_ids ?? []),
      ...(intent._target === "entity" && intent._target_id ? [intent._target_id] : []),
    ]);
  }

  if (artifact_type === "module") {
    return unique([
      ...(plan._module_names ?? []),
      ...(intent._target === "module" && intent._target_id ? [intent._target_id] : []),
    ]);
  }

  if (artifact_type === "view") {
    return [execution_view_id(prompt, intent)];
  }

  return [];
}

function artifact_types_for_execution_plan(
  prompt: string,
  intent: XVibeArtifactIntent,
  plan: XVibeInferredArtifactPlan,
): XVibeInferredArtifactType[] {
  const artifact_types: XVibeInferredArtifactType[] =
    plan._primary_artifact_type === "module"
      ? ["module"]
      : plan._artifact_types
        .filter((artifact_type): artifact_type is Exclude<VibeArtifactType, "command"> =>
          artifact_type === "view" ||
          artifact_type === "flow" ||
          artifact_type === "entity"
        );

  if (artifact_types.length === 0 && plan._primary_artifact_type !== "command") {
    artifact_types.push(plan._primary_artifact_type);
  }

  const normalized_prompt = normalize_artifact_intent_prompt(prompt);
  if (
    artifact_types.includes("flow") &&
    !artifact_types.includes("view") &&
    prompt_has_view_update_request(normalized_prompt) &&
    !intent._forbidden_targets.includes("view")
  ) {
    artifact_types.push("view");
  }

  return artifact_types;
}

function artifact_type_from_target(target: XVibeArtifactIntentTarget): XVibeInferredArtifactType | undefined {
  if (
    target === "view" ||
    target === "flow" ||
    target === "entity" ||
    target === "module"
  ) {
    return target;
  }

  return undefined;
}

function artifact_target_from_artifact_type(
  artifact_type: XVibeInferredArtifactType,
): XVibeArtifactIntentTarget {
  if (
    artifact_type === "view" ||
    artifact_type === "flow" ||
    artifact_type === "entity" ||
    artifact_type === "module"
  ) {
    return artifact_type;
  }

  return "unknown";
}

function artifact_target_from_noun(value: string | undefined): XVibeArtifactIntentTarget | undefined {
  if (!value) return undefined;
  const normalized = value.toLowerCase().trim();
  if (normalized === "page" || normalized === "screen" || normalized === "form") return "view";
  if (normalized === "schema" || normalized === "model" || normalized === "table") return "entity";
  if (normalized === "workflow") return "flow";
  if (normalized === "xmodule" || normalized === "server module" || normalized === "client module") return "module";
  return artifact_target_from_word(normalized);
}

function normalize_detected_artifact_id(value: string | undefined): string | undefined {
  const normalized = normalize_artifact_identifier(value);
  if (
    !normalized ||
    [
      "a",
      "an",
      "and",
      "for",
      "from",
      "named",
      "that",
      "the",
      "then",
      "to",
      "with",
    ].includes(normalized)
  ) {
    return undefined;
  }

  return normalized;
}

function resolve_explicit_only_intent(prompt: string): XVibeIntentResolverResult | null {
  const text = normalize_artifact_intent_prompt(prompt);
  const explicit_only = detect_only_artifact_target(text);
  if (!explicit_only) return null;

  const artifact_type = artifact_type_from_target(explicit_only.target);
  if (!artifact_type) return null;

  return {
    _matched: true,
    _reason: "explicit_only_intent",
    _artifact_type: artifact_type,
    _confidence: 0.95,
    _action: explicit_only.action,
    _artifact_id: extract_artifact_target_id(prompt, explicit_only.target),
    _forbidden_targets: forbidden_for_only_target(explicit_only.target),
  };
}

function resolve_named_artifact_intent(prompt: string): XVibeIntentResolverResult | null {
  const text = strip_negated_artifact_phrases(normalize_artifact_intent_prompt(prompt));
  const artifact_noun_pattern = String.raw`((?:server\s+module|client\s+module|xmodule|module|workflow|flow|entity|schema|model|table|view|page|screen|form))`;
  const create_update_action_pattern = String.raw`(create|build|generate|add|make|update|change|edit|modify)`;
  const noun_then_id = new RegExp(
    String.raw`\b${create_update_action_pattern}\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?${artifact_noun_pattern}(?:\s+(?:named|called|id))?\s+${ARTIFACT_INTENT_TOKEN_PATTERN}\b`,
    "iu",
  );
  const id_then_view = new RegExp(
    String.raw`\b(update|change|edit|modify)\s+${ARTIFACT_INTENT_TOKEN_PATTERN}\s+(view|page|screen|form)\b`,
    "iu",
  );

  const noun_match = text.match(noun_then_id);
  if (noun_match) {
    const target = artifact_target_from_noun(noun_match[2]);
    const artifact_type = target ? artifact_type_from_target(target) : undefined;
    if (target && artifact_type) {
      return {
        _matched: true,
        _reason: "named_artifact_intent",
        _artifact_type: artifact_type,
        _confidence: 0.9,
        _action: normalize_artifact_action_word(noun_match[1]),
        _artifact_id: normalize_detected_artifact_id(noun_match[3]),
      };
    }
  }

  const view_match = text.match(id_then_view);
  if (view_match) {
    return {
      _matched: true,
      _reason: "named_artifact_intent",
      _artifact_type: "view",
      _confidence: 0.9,
      _action: normalize_artifact_action_word(view_match[1]),
      _artifact_id: normalize_detected_artifact_id(view_match[2]),
    };
  }

  return null;
}

function resolve_action_intent(prompt: string): XVibeIntentResolverResult | null {
  const text = strip_negated_artifact_phrases(normalize_artifact_intent_prompt(prompt));
  const action_pattern = String.raw`(create|build|generate|add|make|update|change|edit|modify|delete|remove|disable|archive|rename)`;
  const artifact_noun_pattern = String.raw`((?:server\s+module|client\s+module|xmodule|module|workflow|flow|entity|schema|model|table|view|page|screen|form))`;
  const action_match = text.match(
    new RegExp(
      String.raw`\b${action_pattern}\s+(?:a\s+|an\s+|the\s+)?(?:new\s+)?${artifact_noun_pattern}(?:\s+(?:named|called|id))?(?:\s+${ARTIFACT_INTENT_TOKEN_PATTERN})?\b`,
      "iu",
    ),
  );
  if (!action_match) return null;

  const target = artifact_target_from_noun(action_match[2]);
  const artifact_type = target ? artifact_type_from_target(target) : undefined;
  if (!target || !artifact_type) return null;

  return {
    _matched: true,
    _reason: "action_intent",
    _artifact_type: artifact_type,
    _confidence: 0.85,
    _action: action_match[1] === "remove" ? "delete" : detect_artifact_action(action_match[1]),
    _artifact_id: normalize_detected_artifact_id(action_match[3]),
  };
}

function resolve_negative_constraints(prompt: string): XVibeIntentResolverResult | null {
  const forbidden_targets = detect_forbidden_artifact_targets(
    normalize_artifact_intent_prompt(prompt),
  );
  if (forbidden_targets.length === 0) return null;

  return {
    _matched: true,
    _reason: "negative_constraints",
    _artifact_type: "view",
    _confidence: 0,
    _forbidden_targets: forbidden_targets,
  };
}

function resolve_fallback_classifier(prompt: string): XVibeIntentResolverResult | null {
  const text = strip_negated_artifact_phrases(normalize_artifact_intent_prompt(prompt));
  if (prompt_has_view_child_edit(text)) {
    return {
      _matched: true,
      _reason: "view_child_edit_intent",
      _artifact_type: "view",
      _confidence: 0.85,
      _action: "update",
      _artifact_id: extract_explicit_view_target_id(prompt),
    };
  }

  const explicit_target =
    infer_explicit_artifact_target(text) ??
    infer_vocabulary_artifact_target(text);

  if (explicit_target) {
    const artifact_type = artifact_type_from_target(explicit_target.target);
    if (!artifact_type) return null;

    return {
      _matched: true,
      _reason: explicit_target.reason,
      _artifact_type: artifact_type,
      _confidence: explicit_target.confidence,
      _action: detect_view_edit_action(text) ? "update" : detect_artifact_action(text),
      _artifact_id: extract_artifact_target_id(prompt, explicit_target.target),
    };
  }

  return {
    _matched: true,
    _reason: "fallback_view",
    _artifact_type: "view",
    _confidence: 0.4,
    _action: detect_artifact_action(text),
  };
}

const INTENT_RESOLVERS: XVibeIntentResolver[] = [
  resolve_explicit_only_intent,
  resolve_named_artifact_intent,
  resolve_action_intent,
  resolve_negative_constraints,
  resolve_fallback_classifier,
];

export function has_explicit_data_or_crud_intent(prompt: string): boolean {
  const text = strip_negated_artifact_phrases(normalize_prompt_text(prompt));
  if (!text) return false;

  if (/\b(?:crud|records?|database|entities|entity|collections?|schemas?|persist|persistence|data records?|entity management)\b/u.test(text)) {
    return true;
  }

  if (
    /\b(?:delete|update)\b/u.test(text) &&
    !/\b(?:views?|pages?|screens?|forms?|layouts?|design|style|buttons?|fields?)\b/u.test(text)
  ) {
    return true;
  }

  if (/\bedit\s+(?:a|an|the)?\s*record\b/u.test(text)) {
    return true;
  }

  if (/\b(?:customer|customers|user|users|product|products|order|orders|invoice|invoices)\s+records?\s+table\b/u.test(text)) {
    return true;
  }

  if (/\btable\s+of\s+(?:customer|customers|user|users|product|products|order|orders|invoice|invoices|[a-z][a-z0-9_-]*\s+records?)\b/u.test(text)) {
    return true;
  }

  if (/\b(?:orders?|invoices?)\b/u.test(text)) {
    return true;
  }

  const action_entity_pattern = /\b(?:save|add|create|edit|update|delete|manage|list|track|find)\s+(?:a|an|the)?\s*([a-z][a-z0-9_-]*)\b/gu;
  let match = action_entity_pattern.exec(text);
  while (match) {
    const noun = match[1];
    const after_match = text.slice(match.index + match[0].length);
    if (
      BUSINESS_ENTITY_WORDS.includes(noun) &&
      !UI_ENTITY_NAMES.has(noun) &&
      !/^\s+(?:button|buttons|label|labels)\b/u.test(after_match)
    ) {
      return true;
    }
    match = action_entity_pattern.exec(text);
  }

  return false;
}

export function is_simple_ui_prompt(prompt: string): boolean {
  const text = normalize_prompt_text(prompt);
  if (!text) return false;


  if (has_explicit_data_or_crud_intent(text)) return false;

  return /\b(?:view|page|screen|layout|dashboard|form|button|buttons|grid|grids|row|rows|column|columns|card|cards|toolbar|sidebar|table|cells?)\b/u.test(text);
}

function append_unique(target: string[], values: string[]): void {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
}

function debug_enabled(): boolean {
  return Boolean((_xlog as unknown as { _debug?: boolean })._debug);
}

function verbose_log(message: string, data: XVibeJsonObject): void {
  if (debug_enabled()) {
    _xlog.log(message, data);
  }
}

export function normalize_string_array(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : [];

  return items
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function add_string(target: string[], value: unknown): void {
  if (typeof value !== "string") return;
  const trimmed = value.trim();
  if (trimmed.length > 0) target.push(trimmed);
}

function add_strings(target: string[], value: unknown): void {
  target.push(...normalize_string_array(value));
}

function add_module_op(
  capabilities: VibeRuntimeCapabilityRegistry,
  module_name: unknown,
  op_name: unknown,
): void {
  if (typeof module_name !== "string" || typeof op_name !== "string") return;
  const module_id = module_name.trim();
  const op = op_name.trim();
  if (!module_id || !op) return;

  const key = normalize_lookup_key(module_id);
  const existing = capabilities._module_ops[key] ?? [];
  if (!existing.includes(op)) {
    capabilities._module_ops[key] = [...existing, op];
  }
}

export class VibeIntentPlanner {
  infer_artifact_intent(prompt: string): XVibeArtifactIntent {
    const normalized_prompt = normalize_artifact_intent_prompt(prompt);
    let forbidden_targets = detect_forbidden_artifact_targets(normalized_prompt);

    _xlog.log("[xvibe] intent resolver start", {
      _prompt: prompt,
    });

    for (const resolver of INTENT_RESOLVERS) {
      const result = resolver(prompt);
      const resolver_name = resolver.name;

      if (!result) {
        _xlog.log("[xvibe] intent resolver skipped", {
          _resolver: resolver_name,
          _reason: "no_match",
        });
        continue;
      }

      if (result._reason === "negative_constraints") {
        forbidden_targets =
          unique_artifact_targets([
            ...forbidden_targets,
            ...(result._forbidden_targets ?? []),
          ]);
        _xlog.log("[xvibe] intent resolver skipped", {
          _resolver: resolver_name,
          _reason: "negative_constraints_collected",
          _artifact_type: result._artifact_type,
          _confidence: result._confidence,
        });
        continue;
      }

      if (resolver_name === "resolve_fallback_classifier") {
        _xlog.log("[xvibe] fallback classifier used", {
          _resolver: resolver_name,
          _reason: result._reason,
          _artifact_type: result._artifact_type,
          _confidence: result._confidence,
        });
      }

      _xlog.log("[xvibe] intent layer resolved", {
        _resolver: resolver_name,
        _artifact_type: result._artifact_type,
        _reason: result._reason,
        _confidence: result._confidence,
      });

      const target =
        result._reason === "fallback_view"
          ? "unknown"
          : artifact_target_from_artifact_type(result._artifact_type);
      const target_id =
        result._artifact_id ??
        extract_artifact_target_id(prompt, target);
      const merged_forbidden_targets =
        unique_artifact_targets([
          ...forbidden_targets,
          ...(result._forbidden_targets ?? []),
        ]);

      return {
        _action: result._action ?? detect_artifact_action(normalized_prompt),
        _target: target,
        ...(target_id ? { _target_id: target_id } : {}),
        _forbidden_targets: merged_forbidden_targets,
        _confidence: result._confidence,
        _reason: result._reason,
      };
    }

    return {
      _action: detect_artifact_action(normalized_prompt),
      _target: "unknown",
      _forbidden_targets: forbidden_targets,
      _confidence: 0.4,
      _reason: "fallback_view",
    };
  }

  build_artifact_execution_plan(
    prompt: string,
    intent: XVibeArtifactIntent,
    plan: XVibeInferredArtifactPlan,
  ): XVibeArtifactExecutionPlan {
    const normalized_prompt = normalize_artifact_intent_prompt(prompt);
    const artifact_types =
      artifact_types_for_execution_plan(
        normalized_prompt,
        intent,
        plan,
      );
    const flow_ids = unique([
      ...(plan._flow_ids ?? []),
      ...(intent._target === "flow" && intent._target_id ? [intent._target_id] : []),
    ]);
    const artifacts: XVibeArtifactExecutionPlan["_artifacts"] = [];

    for (const artifact_type of artifact_types) {
      const artifact_ids =
        execution_artifact_ids_for_type(
          prompt,
          intent,
          plan,
          artifact_type,
        );
      const ids = artifact_ids.length > 0 ? artifact_ids : [undefined];

      for (const artifact_id of ids) {
        const item: XVibeArtifactExecutionPlan["_artifacts"][number] = {
          _artifact_type: artifact_type,
          _action: execution_action_for_intent(intent, artifact_type, normalized_prompt),
          ...(artifact_id ? { _artifact_id: artifact_id } : {}),
          ...(artifact_type === "view" && flow_ids.length > 0
            ? { _depends_on: flow_ids }
            : {}),
        };

        _xlog.log("[xvibe] execution item", item);
        artifacts.push(item);
      }
    }

    const primary_execution_artifact =
      artifacts.length > 0
        ? artifacts[artifacts.length - 1]._artifact_type
        : plan._primary_artifact_type;
    const execution_plan: XVibeArtifactExecutionPlan = {
      _primary_artifact_type: primary_execution_artifact,
      _artifacts: artifacts,
    };
    const dependency_graph =
      artifacts
        .filter((artifact) => Array.isArray(artifact._depends_on) && artifact._depends_on.length > 0)
        .map((artifact) => ({
          _artifact_type: artifact._artifact_type,
          _artifact_id: artifact._artifact_id,
          _depends_on: artifact._depends_on,
        }));

    _xlog.log("[xvibe] execution dependency graph", {
      _dependencies: dependency_graph,
    });
    _xlog.log("[xvibe] execution plan", execution_plan);

    return execution_plan;
  }

  private attach_artifact_execution_plan(
    prompt: string,
    intent: XVibeArtifactIntent,
    plan: XVibeInferredArtifactPlan,
  ): XVibeInferredArtifactPlan {
    return {
      ...plan,
      _execution_plan: this.build_artifact_execution_plan(prompt, intent, plan),
    };
  }

  build_artifact_plan_from_intent(
    prompt: string,
    intent: XVibeArtifactIntent,
    requested_artifact_type?: VibeRequestedArtifactType,
  ): XVibeInferredArtifactPlan {
    const normalized_prompt = normalize_artifact_intent_prompt(prompt);
    const forbidden_types = new Set(
      intent._forbidden_targets
        .map((target) => artifact_type_for_intent_target(target))
        .filter((target): target is VibeArtifactType => typeof target === "string"),
    );
    const flow_ids =
      unique([
        ...extract_prompt_flow_ids(prompt),
        ...(intent._target === "flow" && intent._target_id ? [intent._target_id] : []),
      ]);
    const entity_ids =
      intent._target === "entity" && intent._target_id
        ? [intent._target_id]
        : [];
    const has_flow_dependency = flow_ids.length > 0;
    const has_view_flow_dependency =
      has_flow_dependency &&
      intent._target !== "view" &&
      prompt_has_explicit_view_update(normalized_prompt) &&
      !intent._forbidden_targets.includes("view");

    if (
      is_explicit_artifact_type(requested_artifact_type) &&
      intent._action !== "delete" &&
      intent._action !== "rename" &&
      intent._action !== "inspect" &&
      !forbidden_types.has(requested_artifact_type)
    ) {
      if (requested_artifact_type === "view" && has_flow_dependency && !forbidden_types.has("flow")) {
        return this.attach_artifact_execution_plan(prompt, intent, {
          _primary_artifact_type: "view",
          _artifact_types: ["flow", "view"],
          _flow_ids: flow_ids,
          _intent: intent,
          _reason: "requested_view_with_explicit_flow_dependency",
        });
      }

      return this.attach_artifact_execution_plan(prompt, intent, {
        _primary_artifact_type: requested_artifact_type,
        _artifact_types: [requested_artifact_type],
        ...(requested_artifact_type === "flow" && flow_ids.length > 0 ? { _flow_ids: flow_ids } : {}),
        ...(requested_artifact_type === "entity" && entity_ids.length > 0 ? { _entity_ids: entity_ids } : {}),
        _intent: intent,
        _reason: "explicit_requested_artifact_type",
      });
    }

    if (has_view_flow_dependency && !forbidden_types.has("flow")) {
      return this.attach_artifact_execution_plan(prompt, intent, {
        _primary_artifact_type: "view",
        _artifact_types: ["flow", "view"],
        _flow_ids: flow_ids,
        _intent: intent,
        _reason: "explicit_view_intent_with_explicit_flow_dependency",
      });
    }

    if (intent._target === "flow" && !forbidden_types.has("flow")) {
      return this.attach_artifact_execution_plan(prompt, intent, {
        _primary_artifact_type: "flow",
        _artifact_types: ["flow"],
        ...(flow_ids.length > 0 ? { _flow_ids: flow_ids } : {}),
        _intent: intent,
        _reason: intent._reason,
      });
    }

    if (intent._target === "entity" && !forbidden_types.has("entity")) {
      return this.attach_artifact_execution_plan(prompt, intent, {
        _primary_artifact_type: "entity",
        _artifact_types: ["entity"],
        ...(entity_ids.length > 0 ? { _entity_ids: entity_ids } : {}),
        _intent: intent,
        _reason: intent._reason,
      });
    }

    if (intent._target === "module") {
      return this.attach_artifact_execution_plan(prompt, intent, {
        _primary_artifact_type: "module",
        _artifact_types: ["module"],
        ...(intent._target_id ? { _module_names: [intent._target_id] } : {}),
        _intent: intent,
        _reason: intent._reason,
      });
    }

    if (intent._target === "view" && !forbidden_types.has("view")) {
      if (has_flow_dependency && !forbidden_types.has("flow")) {
        return this.attach_artifact_execution_plan(prompt, intent, {
          _primary_artifact_type: "view",
          _artifact_types: ["flow", "view"],
          _flow_ids: flow_ids,
          _intent: intent,
          _reason: "explicit_view_intent_with_explicit_flow_dependency",
        });
      }

      return this.attach_artifact_execution_plan(prompt, intent, {
        _primary_artifact_type: "view",
        _artifact_types: ["view"],
        _intent: intent,
        _reason: intent._reason,
      });
    }

    const fallback_types: VibeArtifactType[] = forbidden_types.has("view") ? [] : ["view"];
    return this.attach_artifact_execution_plan(prompt, intent, {
      _primary_artifact_type: "view",
      _artifact_types: fallback_types,
      ...(has_flow_dependency && !forbidden_types.has("flow") ? { _flow_ids: flow_ids } : {}),
      _intent: intent,
      _reason: "fallback_view",
    });
  }

  empty_runtime_capabilities(): VibeRuntimeCapabilityRegistry {
    return {
      _semantic_object_ids: [],
      _module_ids: [],
      _ops: [],
      _module_ops: {},
      _capability_keywords: [],
    };
  }

  extract_runtime_capabilities(runtime_skills: unknown): VibeRuntimeCapabilityRegistry {
    const capabilities = this.empty_runtime_capabilities();
    const payload =
      is_plain_object(runtime_skills) && is_plain_object(runtime_skills._skills)
        ? runtime_skills._skills
        : runtime_skills;

    if (!is_plain_object(payload)) {
      return capabilities;
    }

    if (Array.isArray(payload._skills)) {
      for (const skill of payload._skills) {
        this.collect_skill_capabilities(skill, capabilities);
      }
    }

    if (Array.isArray(payload._objects)) {
      for (const object_skill of payload._objects) {
        this.collect_object_capabilities(object_skill, capabilities);
      }
    }

    if (Array.isArray(payload._modules)) {
      for (const module_item of payload._modules) {
        if (!is_plain_object(module_item)) continue;

        add_string(capabilities._module_ids, module_item._id);
        add_string(capabilities._module_ids, module_item._name);
        const module_name =
          typeof module_item._name === "string"
            ? module_item._name
            : module_item._id;
        this.collect_ops(module_item._ops, capabilities);
        this.collect_module_ops(module_name, module_item._ops, capabilities);
        add_strings(capabilities._capability_keywords, module_item._capabilities);

        if (Array.isArray(module_item._skills)) {
          for (const skill of module_item._skills) {
            this.collect_skill_capabilities(skill, capabilities);
          }
        }

        if (Array.isArray(module_item._objects)) {
          for (const object_skill of module_item._objects) {
            this.collect_object_capabilities(object_skill, capabilities);
          }
        }
      }
    }

    const normalized = {
      _semantic_object_ids: unique(capabilities._semantic_object_ids),
      _module_ids: unique(capabilities._module_ids),
      _ops: unique(capabilities._ops),
      _module_ops: Object.entries(capabilities._module_ops)
        .reduce<Record<string, string[]>>((acc, [module_name, ops]) => {
          acc[module_name] = unique(ops);
          return acc;
        }, {}),
      _capability_keywords: unique(capabilities._capability_keywords),
    };

    verbose_log("[xvibe] runtime capability summary counts", {
      _semantic_object_ids: normalized._semantic_object_ids.length,
      _module_ids: normalized._module_ids.length,
      _ops: normalized._ops.length,
      _capability_keywords: normalized._capability_keywords.length,
    });
    // verbose_log("[xvibe] normalized capability extraction", normalized);

    return normalized;
  }

  normalize_intent_plan(
    value: unknown,
    runtime_capabilities: VibeRuntimeCapabilityRegistry = this.empty_runtime_capabilities(),
    base_plan?: Partial<VibeIntentPlan>,
  ): VibeIntentPlan {
    const source = is_plain_object(value) ? value : {};
    const intent_type =
      typeof source._intent_type === "string" && source._intent_type.trim().length > 0
        ? source._intent_type.trim()
        : base_plan?._intent_type ?? "app";
    const source_objects = [
      ...normalize_string_array(base_plan?._objects),
      ...normalize_string_array(source._objects),
    ];
    const source_xui_objects = [
      ...normalize_string_array(base_plan?._xui_objects),
      ...normalize_string_array(source._xui_objects),
    ];
    const selected_objects = this.normalize_intent_objects(
      source_objects.length > 0
        ? source_objects
        : source_xui_objects,
      runtime_capabilities._semantic_object_ids,
    );
    const selected_xui_objects =
      this.normalize_selected_values(
        [
          ...source_xui_objects,
          ...selected_objects,
        ],
        [],
        runtime_capabilities._semantic_object_ids,
      );
    const entities =
      this.normalize_entities(
        source._entities,
        base_plan?._entities,
        intent_type,
      );
    const entity_ids = entities.map((entity) => entity._id);
    const actions = this.filter_actions_for_entities(
      this.normalize_actions(source._actions, base_plan?._actions),
      entity_ids,
      intent_type,
    );

    const plan: VibeIntentPlan = {
      _ir_version: INTENT_IR_VERSION,
      _intent_type: intent_type,
      _artifact_types: this.normalize_selected_values(source._artifact_types, base_plan?._artifact_types),
      _entities: entities,
      _regions: this.normalize_regions(source._regions, base_plan?._regions),
      _objects: selected_objects,
      _actions: actions,
      _bindings: this.normalize_bindings(source._bindings, base_plan?._bindings),
      _modules: this.normalize_selected_values(source._modules, base_plan?._modules, runtime_capabilities._module_ids),
      _style: this.normalize_style(source._style, base_plan?._style),
      _xui_objects: selected_xui_objects.length > 0 ? selected_xui_objects : selected_objects,
      _capabilities: this.normalize_selected_capability_values(source._capabilities, base_plan?._capabilities, runtime_capabilities._capability_keywords),
      _crud_ops: this.normalize_selected_values(source._crud_ops, base_plan?._crud_ops, runtime_capabilities._ops),
      _ui_patterns: this.normalize_selected_values(source._ui_patterns, base_plan?._ui_patterns),
      _ui_keywords: this.normalize_selected_values(source._ui_keywords, base_plan?._ui_keywords),
      _flow_keywords: this.normalize_selected_values(source._flow_keywords, base_plan?._flow_keywords),
      _entity_keywords: unique([
        ...entity_ids,
        ...this.normalize_selected_values(source._entity_keywords, base_plan?._entity_keywords),
      ]),
      _requires_module: false,
      _module_target: null,
      _module_ops: [],
      _runtime_capabilities: runtime_capabilities,
    };

    const module_requirement =
      this.normalize_module_requirement(
        source,
        base_plan,
        runtime_capabilities,
      );

    plan._requires_module = module_requirement._requires_module;
    plan._module_target = module_requirement._module_target;
    plan._module_ops = module_requirement._module_ops;

    if (module_requirement._module_name) {
      plan._module_name = module_requirement._module_name;
    }

    if (module_requirement._module_reason) {
      plan._module_reason = module_requirement._module_reason;
    }

    if (
      !plan._requires_module &&
      module_requirement._module_name &&
      runtime_capabilities._module_ids
        .map((item) => normalize_lookup_key(item))
        .includes(normalize_lookup_key(module_requirement._module_name))
    ) {
      append_unique(plan._modules, [module_requirement._module_name]);
      plan._modules =
        this.normalize_selected_values(
          plan._modules,
          [],
          runtime_capabilities._module_ids,
        );
    }

    // verbose_log("[xvibe] intent planning:result", plan);
    // verbose_log("[xvibe] intent IR result", {
    //   _ir_version: plan._ir_version,
    //   _intent_type: plan._intent_type,
    //   _artifact_types: plan._artifact_types,
    //   _entities: plan._entities,
    //   _regions: plan._regions,
    //   _objects: plan._objects,
    //   _actions: plan._actions,
    //   _bindings: plan._bindings,
    //   _modules: plan._modules,
    //   _style: plan._style,
    // });
    // verbose_log("[xvibe] intent regions", { _regions: plan._regions });
    // verbose_log("[xvibe] intent actions", { _actions: plan._actions });
    // verbose_log("[xvibe] intent bindings", { _bindings: plan._bindings });
    // verbose_log("[xvibe] intent selected semantic objects", { _xui_objects: plan._xui_objects });
    // verbose_log("[xvibe] intent selected modules", { _modules: plan._modules });
    // verbose_log("[xvibe] intent inferred capabilities", {
    //   _capabilities: plan._capabilities,
    //   _crud_ops: plan._crud_ops,
    //   _ui_patterns: plan._ui_patterns,
    // });

    return this.enforce_module_intent_plan(plan);
  }

  apply_ui_only_guard(prompt: string, plan: VibeIntentPlan): VibeIntentPlan {
    return this.apply_ui_only_guard_internal(prompt, plan, true);
  }

  assert_valid_module_intent_plan(plan: VibeIntentPlan): void {
    if (plan._intent_type !== "module") return;

    if (plan._entities.length > 0 || plan._actions.length > 0) {
      throw new Error(
        `${XVIBE_MODULE_INTENT_INVALID}: module plans must not contain CRUD artifacts`,
      );
    }
  }

  enforce_module_intent_plan(plan: VibeIntentPlan): VibeIntentPlan {
    if (plan._intent_type !== "module") return plan;

    const guarded: VibeIntentPlan = {
      ...plan,
      _artifact_types: ["module"],
      _entities: [],
      _regions: [],
      _objects: [],
      _actions: [],
      _bindings: [],
      _modules: [],
      _style: {},
      _xui_objects: [],
      _capabilities: [],
      _crud_ops: [],
      _ui_patterns: [],
      _ui_keywords: [],
      _flow_keywords: [],
      _entity_keywords: [],
    };

    this.assert_valid_module_intent_plan(guarded);
    return guarded;
  }

  build_module_intent_plan(input: {
    prompt: string;
    app_plan?: unknown;
    runtime_capabilities?: VibeRuntimeCapabilityRegistry;
    reason?: string;
  }): VibeIntentPlan {
    const runtime_capabilities =
      input.runtime_capabilities ?? this.empty_runtime_capabilities();
    const prompt_text = normalize_prompt_text(input.prompt);
    const module_op_extraction =
      extract_module_operation_matches_from_prompt(input.prompt);
    const inferred_module_requirement =
      this.infer_module_requirement(prompt_text, runtime_capabilities);
    const module_name =
      extract_explicit_module_id_from_prompt(input.prompt) ??
      this.module_name_from_app_plan(input.app_plan) ??
      inferred_module_requirement?._module_name ??
      "generated-module";
    const module_target =
      this.module_target_from_prompt(prompt_text) ??
      inferred_module_requirement?._module_target ??
      "server";
    const module_ops =
      module_op_extraction._module_ops.length > 0
        ? module_op_extraction._module_ops
        : inferred_module_requirement?._module_ops.length
          ? inferred_module_requirement._module_ops
          : [];
    const plan: VibeIntentPlan = {
      _ir_version: INTENT_IR_VERSION,
      _intent_type: "module",
      _artifact_types: ["module"],
      _entities: [],
      _regions: [],
      _objects: [],
      _actions: [],
      _bindings: [],
      _modules: [],
      _style: {},
      _xui_objects: [],
      _capabilities: [],
      _crud_ops: [],
      _ui_patterns: [],
      _ui_keywords: [],
      _flow_keywords: [],
      _entity_keywords: [],
      _requires_module: true,
      _module_target: module_target,
      _module_name: module_name,
      _module_ops: unique(module_ops),
      _module_reason:
        inferred_module_requirement?._module_reason ??
        "User explicitly requested creation of a module.",
      _runtime_capabilities: runtime_capabilities,
    };
    const guarded_plan = this.enforce_module_intent_plan(plan);

    _xlog.log("[xvibe] module intent branch", {
      _module_name: guarded_plan._module_name,
      _module_ops: guarded_plan._module_ops,
      _reason: input.reason ?? "module_intent",
      _bypassed_crud: true,
    });

    return guarded_plan;
  }

  private resolve_module_intent_branch_reason(
    prompt: string,
    app_plan: unknown,
  ): string | undefined {
    if (this.app_plan_requests_module(app_plan)) {
      return "artifact_type_module";
    }

    const prompt_reason = module_intent_prompt_reason(prompt);
    if (prompt_reason) return prompt_reason;

    if (!/\b(?:module|modules|xmodule)\b/iu.test(prompt)) {
      return undefined;
    }

    const artifact_intent = this.infer_artifact_intent(prompt);
    return artifact_intent._target === "module"
      ? "artifact_target_module"
      : undefined;
  }

  private app_plan_requests_module(app_plan: unknown): boolean {
    if (!is_plain_object(app_plan)) return false;

    const direct_values = [
      app_plan._artifact_type,
      app_plan._primary_artifact_type,
      app_plan._target,
      is_plain_object(app_plan._intent)
        ? app_plan._intent._target
        : undefined,
    ];
    if (direct_values.some((value) => value === "module")) {
      return true;
    }

    if (normalize_string_array(app_plan._artifact_types).includes("module")) {
      return true;
    }

    if (!Array.isArray(app_plan._artifacts)) {
      return false;
    }

    return app_plan._artifacts.some((artifact) => {
      if (artifact === "module") return true;
      if (!is_plain_object(artifact)) return false;
      return (
        artifact._artifact_type === "module" ||
        artifact._primary_artifact_type === "module"
      );
    });
  }

  private module_name_from_app_plan(app_plan: unknown): string | undefined {
    if (!is_plain_object(app_plan)) return undefined;

    const explicit_module_name =
      normalize_explicit_module_id(
        typeof app_plan._module_name === "string"
          ? app_plan._module_name
          : undefined,
      );
    if (explicit_module_name) return explicit_module_name;

    return normalize_explicit_module_id(
      normalize_string_array(app_plan._module_names)[0],
    );
  }

  private module_target_from_prompt(
    prompt_text: string,
  ): Exclude<VibeModuleTarget, null> | undefined {
    if (/\bclient\s+(?:xmodule|module)\b/u.test(prompt_text)) {
      return "client";
    }

    if (/\bserver\s+(?:xmodule|module)\b/u.test(prompt_text)) {
      return "server";
    }

    return undefined;
  }

  infer_intent_plan(
    prompt: string,
    app_plan: unknown,
    runtime_capabilities: VibeRuntimeCapabilityRegistry = this.empty_runtime_capabilities(),
  ): VibeIntentPlan {
    const prompt_text = normalize_prompt_text(prompt);
    const module_branch_reason =
      this.resolve_module_intent_branch_reason(prompt, app_plan);
    if (module_branch_reason) {
      return this.build_module_intent_plan({
        prompt,
        app_plan,
        runtime_capabilities,
        reason: module_branch_reason,
      });
    }

    const text = `${prompt} ${JSON.stringify(app_plan ?? {})}`.toLowerCase();
    const explicit_data_or_crud_intent = has_explicit_data_or_crud_intent(prompt);
    const inferred: Omit<VibeIntentPlan, "_runtime_capabilities"> = {
      _ir_version: INTENT_IR_VERSION,
      _intent_type: "app",
      _artifact_types: ["view"],
      _entities: [],
      _regions: [],
      _objects: [],
      _actions: [],
      _bindings: [],
      _style: {},
      _xui_objects: [],
      _modules: [],
      _capabilities: [],
      _crud_ops: [],
      _ui_patterns: [],
      _ui_keywords: [],
      _flow_keywords: [],
      _entity_keywords: [],
      _requires_module: false,
      _module_target: null,
      _module_ops: [],
    };

    if (this.contains_any(text, ["dashboard", "analytics", "metrics", "reports", "overview"])) {
      inferred._intent_type = "dashboard";
      append_unique(inferred._regions, ["sidebar", "toolbar", "kpi_grid", "records_table"]);
      append_unique(inferred._capabilities, ["dashboard", "analytics", "metrics"]);
      append_unique(inferred._ui_patterns, ["dashboard"]);
      inferred._style = {
        ...inferred._style,
        _layout: "dashboard",
      };
    }

    if (explicit_data_or_crud_intent || this.contains_any(prompt_text, ["admin"])) {
      inferred._intent_type = inferred._intent_type === "app" ? "crud-app" : inferred._intent_type;
      append_unique(inferred._artifact_types, ["entity", "flow"]);
      append_unique(inferred._regions, ["toolbar", "records_table", "create_modal", "details_drawer", "filters"]);
      this.add_available(inferred._objects, ["modal", "form", "table", "button", "toolbar", "field", "xselect", "drawer"], runtime_capabilities._semantic_object_ids);
      this.add_available(inferred._xui_objects, ["modal", "form", "table", "button", "toolbar", "field", "xselect", "drawer"], runtime_capabilities._semantic_object_ids);
      this.add_available(inferred._crud_ops, ["find", "list", "add", "get", "update", "delete"], runtime_capabilities._ops);
      append_unique(inferred._capabilities, ["entity", "crud", "storage"]);
    }

    this.add_available(
      inferred._objects,
      this.infer_prompt_ui_objects(prompt_text, runtime_capabilities),
      runtime_capabilities._semantic_object_ids,
    );
    this.add_available(
      inferred._xui_objects,
      this.infer_prompt_ui_objects(prompt_text, runtime_capabilities),
      runtime_capabilities._semantic_object_ids,
    );

    if (this.contains_any(text, ["navigation", "navigate", "route", "router", "menu", "sidebar", "nav"])) {
      append_unique(inferred._regions, ["sidebar", "content"]);
      this.add_available(inferred._objects, ["navlist", "sidebar", "toolbar"], runtime_capabilities._semantic_object_ids);
      this.add_available(inferred._xui_objects, ["navlist", "sidebar", "toolbar"], runtime_capabilities._semantic_object_ids);
      append_unique(inferred._capabilities, ["navigation", "routing"]);
      append_unique(inferred._ui_patterns, ["navigation"]);
    }

    if (this.contains_any(text, ["realtime", "real-time", "live", "streaming", "stream", "subscribe", "push"])) {
      append_unique(inferred._artifact_types, ["flow"]);
      append_unique(inferred._capabilities, ["realtime", "events", "streaming"]);
      append_unique(inferred._flow_keywords, ["realtime", "events"]);
    }

    if (has_explicit_flow_intent(prompt_text)) {
      append_unique(inferred._artifact_types, ["flow"]);
      append_unique(inferred._flow_keywords, extract_prompt_flow_ids(prompt_text));
    }

    const module_requirement =
      this.infer_module_requirement(prompt_text, runtime_capabilities);
    if (module_requirement) {
      append_unique(inferred._artifact_types, ["flow"]);
      inferred._module_name = module_requirement._module_name;
      inferred._module_target = module_requirement._module_target;
      inferred._module_ops = module_requirement._module_ops;
      inferred._module_reason = module_requirement._module_reason;
      const available =
        this.runtime_module_requirement_available(
          module_requirement._module_name,
          module_requirement._module_ops,
          runtime_capabilities,
        );
      inferred._requires_module = !available;
      if (available) {
        append_unique(inferred._modules, [module_requirement._module_name]);
      }

      verbose_log("[xvibe] intent module inference", {
        _module_name: module_requirement._module_name,
        _module_target: module_requirement._module_target,
        _module_ops: module_requirement._module_ops,
        _requires_module: !available,
        _reason: module_requirement._module_reason,
      });

      if (available) {
        verbose_log("[xvibe] module capability available", {
          _module_name: module_requirement._module_name,
          _module_ops: module_requirement._module_ops,
        });
      }
    }

    if (this.contains_any(text, ["storage", "state", "persist", "database", "save", "load"])) {
      append_unique(inferred._capabilities, ["storage", "state"]);
    }

    if (this.contains_any(text, ["landing page", "homepage", "home page", "marketing page"])) {
      inferred._intent_type = inferred._intent_type === "app" ? "landing-page" : inferred._intent_type;
      append_unique(inferred._regions, ["toolbar", "content"]);
      this.add_available(inferred._objects, ["xsection", "button", "toolbar"], runtime_capabilities._semantic_object_ids);
      this.add_available(inferred._xui_objects, ["xsection", "button", "toolbar"], runtime_capabilities._semantic_object_ids);
      append_unique(inferred._ui_patterns, ["landing-page"]);
    }

    if (this.contains_any(text, ["section", "sections", "page section", "page sections", "dashboard section", "dashboard sections"])) {
      this.add_available(inferred._objects, ["xsection"], runtime_capabilities._semantic_object_ids);
      this.add_available(inferred._xui_objects, ["xsection"], runtime_capabilities._semantic_object_ids);
    }

    if (this.contains_any(text, ["kpi", "kpis", "statistics", "stats", "dashboard cards", "cards", "metrics"])) {
      append_unique(inferred._regions, ["kpi_grid"]);
      this.add_available(inferred._objects, ["grid", "kpi-card"], runtime_capabilities._semantic_object_ids);
      this.add_available(inferred._xui_objects, ["grid", "kpi-card"], runtime_capabilities._semantic_object_ids);
    }

    if (this.prompt_requests_styling(text)) {
      this.add_runtime_available(inferred._objects, ["style-sheet"], runtime_capabilities._semantic_object_ids);
      this.add_runtime_available(inferred._xui_objects, ["style-sheet"], runtime_capabilities._semantic_object_ids);
    }

    inferred._style = {
      ...inferred._style,
      ...this.infer_style(text, inferred._intent_type),
    };

    inferred._entities =
      this.normalize_entities(
        this.infer_entities(text, app_plan).map((entity_id) => ({
          _id: entity_id,
          _fields: this.infer_entity_fields(text, entity_id),
        })),
        [],
        inferred._intent_type,
      );
    if (inferred._entities.length > 0) {
      append_unique(inferred._artifact_types, ["entity"]);
      append_unique(inferred._entity_keywords, inferred._entities.map((entity) => entity._id));
      const primary_entity = inferred._entities[0];
      if (primary_entity) {
        inferred._actions.push(...this.infer_crud_actions(prompt_text, primary_entity._id, inferred._crud_ops));
        if (inferred._objects.includes("table")) {
          inferred._bindings.push({
            _target: `${primary_entity._id}-table`,
            _source: `${primary_entity._id}:records`,
          });
        }
      }
    }

    return this.apply_ui_only_guard_internal(
      prompt,
      this.normalize_intent_plan(inferred, runtime_capabilities),
      false,
    );
  }

  private apply_ui_only_guard_internal(
    prompt: string,
    plan: VibeIntentPlan,
    should_log: boolean,
  ): VibeIntentPlan {
    if (plan._requires_module || plan._module_ops.length > 0) {
      return plan;
    }

    if (!is_simple_ui_prompt(prompt) || has_explicit_data_or_crud_intent(prompt)) {
      return plan;
    }

    const before_intent_type = plan._intent_type;
    const removed_entities_count = plan._entities.length;
    const removed_actions_count = plan._actions.length;
    const flow_ids = extract_prompt_flow_ids(prompt);
    const has_flow = flow_ids.length > 0;

    const guarded: VibeIntentPlan = {
      ...plan,

      _intent_type: "view",

      _artifact_types:
        has_flow
          ? ["view", "flow"]
          : ["view"],

      _entities: [],

      _regions:
        this.filter_simple_ui_regions(
          prompt,
          plan._regions
        ),

      _objects:
        this.merge_prompt_ui_objects(
          prompt,
          plan._objects,
          plan._runtime_capabilities
        ),

      _actions: [],
      _bindings: [],
      _modules: [],
      _requires_module: false,
      _module_target: null,
      _module_name: undefined,
      _module_ops: [],
      _module_reason: undefined,
      _crud_ops: [],

      _xui_objects:
        this.merge_prompt_ui_objects(
          prompt,
          plan._xui_objects,
          plan._runtime_capabilities
        ),

      _flow_keywords:
        has_flow
          ? flow_ids
          : [],

      _entity_keywords: [],
    };

    if (should_log) {
      _xlog.log("[xvibe] intent ui-only guard applied", {
        _prompt: prompt,
        _before_intent_type: before_intent_type,
        _after_intent_type: guarded._intent_type,
        _removed_entities_count: removed_entities_count,
        _removed_actions_count: removed_actions_count,
      });
    }

    return guarded;
  }

  private filter_simple_ui_regions(prompt: string, regions: string[]): string[] {
    const text = normalize_prompt_text(prompt);
    return regions.filter((region) => {
      if (SIMPLE_UI_CRUD_REGION_IDS.has(region)) return false;
      const terms = SIMPLE_UI_REGION_TERMS[region];
      return Array.isArray(terms) && terms.some((term) => text.includes(term));
    });
  }

  private merge_prompt_ui_objects(
    prompt: string,
    existing: string[],
    runtime_capabilities: VibeRuntimeCapabilityRegistry,
  ): string[] {
    return this.normalize_intent_objects(
      [
        ...existing,
        ...this.infer_prompt_ui_objects(prompt, runtime_capabilities),
      ],
      runtime_capabilities._semantic_object_ids,
    );
  }

  private infer_prompt_ui_objects(
    prompt: string,
    runtime_capabilities: VibeRuntimeCapabilityRegistry,
  ): string[] {
    const text = normalize_prompt_text(prompt);
    const objects: string[] = [];

    if (/\b(?:view|page|screen|layout|dashboard)\b/u.test(text)) {
      objects.push("view");
    }
    if (/\bbuttons?\b/u.test(text)) {
      objects.push("button");
    }
    if (/\b(?:labels?|text)\b/u.test(text)) {
      objects.push("label");
    }
    if (/\b(?:cards?)\b/u.test(text)) {
      objects.push("card");
    }
    if (/\b(?:stacks?)\b/u.test(text)) {
      objects.push("stack");
    }
    if (/\b(?:grid|grids|row|rows|column|columns|aligned)\b/u.test(text)) {
      objects.push("grid");
    }
    if (/\btoolbar\b/u.test(text)) {
      objects.push("toolbar");
    }
    if (/\bsidebar\b/u.test(text)) {
      objects.push("sidebar");
    }
    if (/\bforms?\b/u.test(text)) {
      objects.push("form");
    }
    if (/\btable\b/u.test(text)) {
      objects.push("table");
    }

    return unique(objects);
  }

  private normalize_selected_values(
    value: unknown,
    fallback: unknown = [],
    available_values: string[] = [],
  ): string[] {
    const selected = unique([
      ...normalize_string_array(fallback),
      ...normalize_string_array(value),
    ]);

    if (available_values.length === 0) return selected;

    const available_by_key = new Map(
      available_values.map((available) => [normalize_lookup_key(available), available]),
    );

    return selected
      .map((item) => available_by_key.get(normalize_lookup_key(item)))
      .filter((item): item is string => typeof item === "string");
  }

  private normalize_selected_capability_values(
    value: unknown,
    fallback: unknown = [],
    available_values: string[] = [],
  ): string[] {
    const source_values = normalize_string_array(value);
    const source_keys = new Set(source_values.map((item) => normalize_lookup_key(item)));
    const copied_runtime_inventory =
      available_values.length > 0 &&
      source_values.length >= available_values.length &&
      available_values.every((item) => source_keys.has(normalize_lookup_key(item)));

    return this.normalize_selected_values(
      copied_runtime_inventory ? [] : value,
      fallback,
      available_values,
    );
  }

  private normalize_regions(value: unknown, fallback: unknown = []): string[] {
    return this.normalize_selected_values(value, fallback, INTENT_REGION_IDS);
  }

  private normalize_intent_objects(
    values: unknown,
    runtime_object_ids: string[] = [],
  ): string[] {
    const runtime_by_key = new Map(
      runtime_object_ids.map((item) => [normalize_lookup_key(item), item]),
    );

    return unique(
      normalize_string_array(values)
        .map((item) => INTENT_OBJECT_ALIASES[normalize_lookup_key(item)] ?? item)
        .filter((item) => INTENT_OBJECT_IDS.includes(item))
        .map((item) => runtime_by_key.get(normalize_lookup_key(item)) ?? item)
        .filter((item) => runtime_object_ids.length === 0 || runtime_by_key.has(normalize_lookup_key(item))),
    );
  }

  private normalize_entities(
    value: unknown,
    fallback: unknown = [],
    intent_type = "app",
  ): XVibeIntentIREntity[] {
    const by_id = new Map<string, XVibeIntentIREntity>();

    for (const item of [
      ...(Array.isArray(fallback) ? fallback : []),
      ...(Array.isArray(value) ? value : []),
    ]) {
      const entity = this.normalize_entity(item);
      if (!entity) continue;

      const existing = by_id.get(entity._id);
      by_id.set(entity._id, {
        _id: entity._id,
        _fields: unique([
          ...(existing?._fields ?? []),
          ...entity._fields,
        ]),
      });
    }

    const entities = [...by_id.values()];
    if (
      (intent_type === "dashboard" || intent_type === "crud-app" || intent_type === "crud") &&
      entities.length > 1
    ) {
      return [entities[0]];
    }

    return entities;
  }

  private normalize_entity(value: unknown): XVibeIntentIREntity | undefined {
    if (typeof value === "string") {
      const id = this.normalize_entity_id(value);
      return id.length > 0 ? { _id: id, _fields: [] } : undefined;
    }

    if (!is_plain_object(value)) return undefined;

    const id =
      typeof value._id === "string" && value._id.trim().length > 0
        ? this.normalize_entity_id(value._id)
        : undefined;

    if (!id) return undefined;

    return {
      _id: id,
      _fields: normalize_string_array(value._fields),
    };
  }

  private normalize_actions(value: unknown, fallback: unknown = []): XVibeIntentIRAction[] {
    const actions: XVibeIntentIRAction[] = [];
    const seen = new Set<string>();

    for (const item of [
      ...(Array.isArray(fallback) ? fallback : []),
      ...(Array.isArray(value) ? value : []),
    ]) {
      if (!is_plain_object(item)) continue;
      const id = typeof item._id === "string" ? item._id.trim() : "";
      const type = typeof item._type === "string" ? item._type.trim() : "";
      const label = typeof item._label === "string" ? item._label.trim() : "";

      if (!id || !type || !label || seen.has(id)) continue;
      const entity_id =
        typeof item._entity === "string" && item._entity.trim()
          ? this.normalize_entity_id(item._entity)
          : "";

      actions.push({
        _id: id,
        _type: type,
        _label: label,
        ...(entity_id
          ? { _entity: entity_id }
          : {}),
        ...(typeof item._op === "string" && item._op.trim()
          ? { _op: item._op.trim() }
          : {}),
        ...(typeof item._target_region === "string" && item._target_region.trim()
          ? { _target_region: item._target_region.trim() }
          : {}),
      });
      seen.add(id);
    }

    return actions;
  }

  private filter_actions_for_entities(
    actions: XVibeIntentIRAction[],
    entity_ids: string[],
    intent_type: string,
  ): XVibeIntentIRAction[] {
    if (actions.length === 0) return [];
    const entity_id_set = new Set(entity_ids);
    const crud_intent =
      intent_type === "dashboard" ||
      intent_type === "crud-app" ||
      intent_type === "crud";
    const allowed_ops = new Set(["find", "list", "add", "update", "delete"]);
    const filtered = actions.filter((action) => {
      if (crud_intent && action._op && !allowed_ops.has(action._op)) {
        return false;
      }

      if (!action._entity) {
        return !crud_intent;
      }

      return entity_id_set.size === 0 || entity_id_set.has(action._entity);
    });

    if (!crud_intent) return filtered;

    const order = new Map([
      ["find", 0],
      ["list", 0],
      ["add", 1],
      ["update", 2],
      ["delete", 3],
    ]);

    return filtered
      .sort((left, right) => (order.get(left._op ?? "") ?? 99) - (order.get(right._op ?? "") ?? 99))
      .slice(0, 4);
  }

  private normalize_bindings(value: unknown, fallback: unknown = []): XVibeIntentIRBinding[] {
    const bindings: XVibeIntentIRBinding[] = [];
    const seen = new Set<string>();

    for (const item of [
      ...(Array.isArray(fallback) ? fallback : []),
      ...(Array.isArray(value) ? value : []),
    ]) {
      if (!is_plain_object(item)) continue;
      const target = typeof item._target === "string" ? item._target.trim() : "";
      const source = typeof item._source === "string" ? item._source.trim() : "";
      const key = `${target}\n${source}`;

      if (!target || !source || seen.has(key)) continue;

      bindings.push({ _target: target, _source: source });
      seen.add(key);
    }

    return bindings;
  }

  private normalize_style(value: unknown, fallback: unknown = []): XVibeIntentIRStyle {
    const style: XVibeIntentIRStyle = {};

    for (const source of [fallback, value]) {
      if (!is_plain_object(source)) continue;
      if (typeof source._theme === "string" && source._theme.trim()) {
        style._theme = source._theme.trim();
      }
      if (typeof source._density === "string" && source._density.trim()) {
        style._density = source._density.trim();
      }
      if (typeof source._layout === "string" && source._layout.trim()) {
        style._layout = source._layout.trim();
      }
    }

    return style;
  }

  private contains_any(text: string, terms: string[]): boolean {
    return terms.some((term) => text.includes(term));
  }

  private add_available(
    target: string[],
    candidates: string[],
    available_values: string[],
  ): void {
    if (available_values.length === 0) {
      append_unique(target, candidates);
      return;
    }

    const available_by_key = new Map(
      available_values.map((available) => [normalize_lookup_key(available), available]),
    );

    append_unique(
      target,
      candidates
        .map((candidate) => available_by_key.get(normalize_lookup_key(candidate)))
        .filter((candidate): candidate is string => typeof candidate === "string"),
    );
  }

  private add_runtime_available(
    target: string[],
    candidates: string[],
    available_values: string[],
  ): void {
    if (available_values.length === 0) return;

    const available_by_key = new Map(
      available_values.map((available) => [normalize_lookup_key(available), available]),
    );

    append_unique(
      target,
      candidates
        .map((candidate) => available_by_key.get(normalize_lookup_key(candidate)))
        .filter((candidate): candidate is string => typeof candidate === "string"),
    );
  }

  private prompt_requests_styling(text: string): boolean {
    return this.contains_any(text, [
      "style",
      "styled",
      "styling",
      "design",
      "theme",
      "themed",
      "modern ui",
      "modern",
    ]);
  }

  private infer_style(text: string, intent_type: string): XVibeIntentIRStyle {
    const style: XVibeIntentIRStyle = {};

    if (this.contains_any(text, ["dark mode", "dark"])) {
      style._theme = "dark";
    }

    if (this.contains_any(text, ["light mode", "light"])) {
      style._theme = "light";
    }

    if (intent_type === "dashboard") {
      style._layout = "dashboard";
    }

    if (this.contains_any(text, ["compact", "dense"])) {
      style._density = "compact";
    }

    if (this.contains_any(text, ["comfortable", "spacious"])) {
      style._density = "comfortable";
    }

    return style;
  }

  private infer_entities(text: string, app_plan: unknown): string[] {
    const scores = new Map<string, number>();
    const app_plan_object = is_plain_object(app_plan) ? app_plan : {};

    for (const entity of normalize_string_array(app_plan_object._entities)) {
      this.add_entity_candidate(scores, entity, 80);
    }

    const before_marker_pattern =
      /\b([a-z][a-z0-9_-]{2,})\s+(?:records?|entities|entity|tables?|schemas?|data)\b/gu;
    let match = before_marker_pattern.exec(text);
    while (match) {
      this.add_entity_candidate(scores, match[1], 120);
      match = before_marker_pattern.exec(text);
    }

    const after_marker_pattern =
      /\b(?:crud|manage|admin|track|tracking|create|add|edit|update|delete|list|find)\s+(?:a|an|the)?\s*([a-z][a-z0-9_-]{2,})\b/gu;
    match = after_marker_pattern.exec(text);
    while (match) {
      this.add_entity_candidate(scores, match[1], 90);
      match = after_marker_pattern.exec(text);
    }

    const dashboard_for_pattern =
      /\b(?:dashboard|table|view|screen|page)\s+(?:for|of)\s+(?:a|an|the)?\s*([a-z][a-z0-9_-]{2,})\b/gu;
    match = dashboard_for_pattern.exec(text);
    while (match) {
      this.add_entity_candidate(scores, match[1], 60);
      match = dashboard_for_pattern.exec(text);
    }

    const ranked =
      [...scores.entries()]
        .sort((left, right) => right[1] - left[1])
        .map(([entity]) => entity);

    if (!EXPLICIT_MULTI_ENTITY_PATTERN.test(text)) {
      return ranked.slice(0, 1);
    }

    return ranked;
  }

  private add_entity_candidate(
    scores: Map<string, number>,
    value: unknown,
    score: number,
  ): void {
    if (typeof value !== "string") return;

    const entity_id = this.normalize_entity_id(value);
    if (!entity_id) return;

    scores.set(entity_id, (scores.get(entity_id) ?? 0) + score);
  }

  private normalize_entity_id(value: string): string {
    const cleaned =
      value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]/gu, "")
        .replace(/-+/gu, "-")
        .replace(/_+/gu, "_");

    if (!cleaned || ENTITY_STOP_WORDS.has(cleaned)) return "";

    return this.pluralize_entity_id(cleaned);
  }

  private pluralize_entity_id(value: string): string {
    if (value.endsWith("ies")) return value;
    if (value.endsWith("s")) return value;
    if (value.endsWith("y") && value.length > 1 && !/[aeiou]y$/u.test(value)) {
      return `${value.slice(0, -1)}ies`;
    }
    return `${value}s`;
  }

  private singularize_entity_id(value: string): string {
    if (value.endsWith("ies") && value.length > 3) {
      return `${value.slice(0, -3)}y`;
    }
    if (value.endsWith("s") && value.length > 1) {
      return value.slice(0, -1);
    }
    return value;
  }

  private infer_crud_actions(
    text: string,
    entity_id: string,
    crud_ops: string[],
  ): XVibeIntentIRAction[] {
    const actions: XVibeIntentIRAction[] = [];
    const singular_entity = this.singularize_entity_id(entity_id);

    if (crud_ops.includes("find") || crud_ops.includes("list")) {
      actions.push({
        _id: `refresh-${entity_id}`,
        _type: "flow",
        _label: `Refresh ${this.label_from_id(entity_id)}`,
        _entity: entity_id,
        _op: crud_ops.includes("find") ? "find" : "list",
        _target_region: "records_table",
      });
    }

    if (crud_ops.includes("add")) {
      actions.push({
        _id: `add-${singular_entity}`,
        _type: "flow",
        _label: `Add ${this.label_from_id(singular_entity)}`,
        _entity: entity_id,
        _op: "add",
        _target_region: "create_modal",
      });
    }

    if (crud_ops.includes("update") && this.contains_any(text, ["update", "edit"])) {
      actions.push({
        _id: `update-${singular_entity}`,
        _type: "flow",
        _label: `Update ${this.label_from_id(singular_entity)}`,
        _entity: entity_id,
        _op: "update",
        _target_region: "details_drawer",
      });
    }

    if (crud_ops.includes("delete") && this.contains_any(text, ["delete", "remove"])) {
      actions.push({
        _id: `delete-${singular_entity}`,
        _type: "flow",
        _label: `Delete ${this.label_from_id(singular_entity)}`,
        _entity: entity_id,
        _op: "delete",
        _target_region: "details_drawer",
      });
    }

    return actions;
  }

  private infer_entity_field_candidates(text: string, entity_id: string): string[] {
    const fields: string[] = [];
    const field_candidates = [
      "name",
      "email",
      "status",
      "title",
      "description",
      "phone",
      "role",
      "type",
      "category",
      "created_at",
      "updated_at",
    ];

    for (const field of field_candidates) {
      if (text.includes(field.replace(/_/g, " "))) {
        fields.push(field);
      }
    }

    if (fields.length === 0 && /\bcustomer|client|user|account|contact\b/u.test(entity_id)) {
      fields.push("name", "email", "status");
    }

    return unique(fields);
  }

  private infer_entity_fields(text: string, entity_id: string): string[] {
    return this.infer_entity_field_candidates(text, entity_id);
  }

  private label_from_id(value: string): string {
    return value
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

  private normalize_runtime_capabilities(value: unknown): VibeRuntimeCapabilityRegistry {
    const source = is_plain_object(value) ? value : {};
    const module_ops: Record<string, string[]> = {};
    if (is_plain_object(source._module_ops)) {
      for (const [module_name, ops] of Object.entries(source._module_ops)) {
        module_ops[normalize_lookup_key(module_name)] = normalize_string_array(ops);
      }
    }

    return {
      _semantic_object_ids: normalize_string_array(source._semantic_object_ids),
      _module_ids: normalize_string_array(source._module_ids),
      _ops: normalize_string_array(source._ops),
      _module_ops: module_ops,
      _capability_keywords: normalize_string_array(source._capability_keywords),
    };
  }

  private normalize_module_requirement(
    source: XVibeJsonObject,
    base_plan: Partial<VibeIntentPlan> | undefined,
    runtime_capabilities: VibeRuntimeCapabilityRegistry,
  ): {
    _requires_module: boolean;
    _module_target: VibeModuleTarget;
    _module_name?: string;
    _module_ops: string[];
    _module_reason?: string;
  } {
    const raw_module_name =
      typeof source._module_name === "string" && source._module_name.trim()
        ? source._module_name.trim()
        : base_plan?._module_name;
    const module_name =
      typeof raw_module_name === "string" && raw_module_name.trim()
        ? raw_module_name.trim()
        : undefined;
    const module_ops = unique([
      ...normalize_string_array(base_plan?._module_ops),
      ...normalize_string_array(source._module_ops),
    ]);
    const raw_target =
      source._module_target ?? base_plan?._module_target;
    const module_target: VibeModuleTarget =
      raw_target === "server" || raw_target === "client"
        ? raw_target
        : module_name
          ? "server"
          : null;
    const module_reason =
      typeof source._module_reason === "string" && source._module_reason.trim()
        ? source._module_reason.trim()
        : base_plan?._module_reason;
    const requested_requires =
      source._requires_module === true ||
      (
        source._requires_module !== false &&
        base_plan?._requires_module === true
      );
    const available =
      module_name && module_ops.length > 0
        ? this.runtime_module_requirement_available(
          module_name,
          module_ops,
          runtime_capabilities,
        )
        : false;

    if (available) {
      verbose_log("[xvibe] module capability available", {
        _module_name: module_name,
        _module_ops: module_ops,
      });
    }

    return {
      _requires_module: Boolean(requested_requires && !available),
      _module_target: requested_requires && !available ? module_target : available ? null : module_target,
      ...(module_name ? { _module_name: module_name } : {}),
      _module_ops: module_ops,
      ...(module_reason ? { _module_reason: module_reason } : {}),
    };
  }

  private infer_module_requirement(
    prompt_text: string,
    runtime_capabilities: VibeRuntimeCapabilityRegistry,
  ): VibeInferredModuleRequirement | undefined {
    const candidates: VibeInferredModuleRequirement[] = [];
    const RESERVED_MODULE_NAME_WORDS = new Set([
      "server",
      "client",
      "xmodule",
      "module",
      "with",
      "op",
      "operation",
    ]);
    if (
      /\b(?:calculate|calculates|calculation|evaluate expression|evaluate an expression|math result|calculator equals|equals button|equals)\b/u
        .test(prompt_text) &&
      !/\b(?:button layout|buttons only|button wiring|wire buttons|display buttons)\b/u.test(prompt_text)
    ) {
      candidates.push({
        _module_target: "server",
        _module_name: "calc",
        _module_ops: ["evaluate"],
        _module_reason: "Expression evaluation requires custom behavior outside XUI/xd.",
      });
    }

    if (/\b(?:generate|export|create)\s+(?:a\s+)?pdf\b|\bpdf\s+(?:export|generation)\b/u.test(prompt_text)) {
      candidates.push({
        _module_target: "server",
        _module_name: "pdf",
        _module_ops: ["generate"],
        _module_reason: "PDF generation/export requires a server behavior module when no runtime PDF capability exists.",
      });
    }

    if (/\b(?:send|deliver)\s+(?:an?\s+)?email\b|\bemail\s+(?:send|delivery)\b/u.test(prompt_text)) {
      candidates.push({
        _module_target: "server",
        _module_name: "email",
        _module_ops: ["send"],
        _module_reason: "Email sending requires a server behavior module when no mail runtime capability exists.",
      });
    }

    if (/\b(?:call|fetch|request)\s+(?:an?\s+)?external\s+api\b|\bfetch weather\b|\bweather\b/u.test(prompt_text)) {
      candidates.push({
        _module_target: "server",
        _module_name: prompt_text.includes("weather") ? "weather" : "api",
        _module_ops: ["fetch"],
        _module_reason: "External API access requires a server behavior module when no runtime API capability exists.",
      });
    }

    if (/\b(?:payment|charge|checkout)\b/u.test(prompt_text)) {
      candidates.push({
        _module_target: "server",
        _module_name: "payment",
        _module_ops: ["charge"],
        _module_reason: "Payment behavior requires a server behavior module when no payment runtime capability exists.",
      });
    }

    if (/\bwebhook\b/u.test(prompt_text)) {
      candidates.push({
        _module_target: "server",
        _module_name: "webhook",
        _module_ops: ["handle"],
        _module_reason: "Webhook behavior requires a server behavior module when no webhook runtime capability exists.",
      });
    }

    if (
      /\b(?:create|build|generate|add|make)\s+(?:a|an\s+)?(?:(?:server|client)\s+)?(?:xmodule|module)\b/u
        .test(prompt_text)
    ) {
      const moduleTarget =
        this.module_target_from_prompt(prompt_text) ?? "server";
      const opMatches =
        extract_explicit_module_ops_from_prompt(prompt_text);

      const namedModuleMatch =
        /\b(?:xmodule|module)\s+(?:named|called)\s+([a-z][a-z0-9_-]*)\b/u
          .exec(prompt_text);

      const beforeModuleMatch =
        /\b([a-z][a-z0-9_-]*)\s+(?:xmodule|module)\b/u
          .exec(prompt_text);

      const candidateModuleName =
        extract_explicit_module_id_from_prompt(prompt_text) ??
        namedModuleMatch?.[1] ??
        beforeModuleMatch?.[1];

      const moduleName =
        candidateModuleName && !RESERVED_MODULE_NAME_WORDS.has(candidateModuleName)
          ? candidateModuleName
          : this.infer_module_name_from_ops(opMatches) ??
          "generated-module";

      candidates.push({
        _module_target: moduleTarget,
        _module_name: moduleName,
        _module_ops:
          opMatches.length > 0
            ? unique(opMatches)
            : [],
        _module_reason:
          "User explicitly requested creation of a server module.",
      });
    }


    for (const candidate of candidates) {
      if (
        this.runtime_module_requirement_available(
          candidate._module_name,
          candidate._module_ops,
          runtime_capabilities,
        )
      ) {
        return candidate;
      }
    }

    return candidates[0];
  }

  private infer_module_name_from_ops(ops: string[]): string | undefined {
    if (
      ops.some((op) =>
        op.includes("calc") ||
        op.includes("calculate") ||
        op.includes("evaluate")
      )
    ) {
      return "calc";
    }

    return undefined;
  }

  private runtime_module_requirement_available(
    module_name: string,
    module_ops: string[],
    runtime_capabilities: VibeRuntimeCapabilityRegistry,
  ): boolean {
    const requested_module_key = normalize_lookup_key(module_name);
    const module_ids = runtime_capabilities._module_ids.map((item) => normalize_lookup_key(item));
    const ops = runtime_capabilities._ops.map((item) => normalize_lookup_key(item));
    const module_present = module_ids.includes(requested_module_key);
    const requested_ops = module_ops.map((item) => normalize_lookup_key(item));
    const module_specific_ops = runtime_capabilities._module_ops[requested_module_key]
      ?.map((item) => normalize_lookup_key(item)) ?? [];

    if (
      module_present &&
      requested_ops.every((op) => module_specific_ops.includes(op) || ops.includes(op))
    ) {
      return true;
    }

    const capability_terms = runtime_capabilities._capability_keywords
      .map((item) => normalize_lookup_key(item));

    return requested_ops.every((op) =>
      capability_terms.includes(`${requested_module_key}_${op}`) ||
      capability_terms.includes(`${requested_module_key}:${op}`) ||
      (
        capability_terms.includes(requested_module_key) &&
        capability_terms.includes(op)
      )
    );
  }

  private collect_skill_capabilities(
    skill: unknown,
    capabilities: VibeRuntimeCapabilityRegistry,
  ): void {
    if (!is_plain_object(skill)) return;

    add_string(capabilities._module_ids, skill._name);
    add_strings(capabilities._capability_keywords, skill._capabilities);
    if (is_plain_object(skill._match)) {
      add_strings(capabilities._capability_keywords, skill._match._keywords);
    }
    if (is_plain_object(skill._exports)) {
      add_strings(capabilities._semantic_object_ids, skill._exports._xui_objects);
      this.collect_exported_modules(skill._exports._modules, capabilities);
      add_strings(capabilities._capability_keywords, skill._exports._capabilities);
    }
    this.collect_ops(skill._ops, capabilities);
  }

  private collect_exported_modules(
    value: unknown,
    capabilities: VibeRuntimeCapabilityRegistry,
  ): void {
    if (!Array.isArray(value)) {
      add_strings(capabilities._module_ids, value);
      return;
    }

    for (const module_item of value) {
      if (typeof module_item === "string") {
        add_string(capabilities._module_ids, module_item);
        continue;
      }

      if (!is_plain_object(module_item)) continue;
      add_string(capabilities._module_ids, module_item._name);
      add_string(capabilities._module_ids, module_item._id);
      const module_name =
        typeof module_item._name === "string"
          ? module_item._name
          : module_item._id;
      this.collect_ops(module_item._ops, capabilities);
      this.collect_module_ops(module_name, module_item._ops, capabilities);
      add_strings(capabilities._capability_keywords, module_item._capabilities);
    }
  }

  private collect_object_capabilities(
    object_skill: unknown,
    capabilities: VibeRuntimeCapabilityRegistry,
  ): void {
    if (!is_plain_object(object_skill)) return;

    add_string(capabilities._semantic_object_ids, object_skill._id);
    add_string(capabilities._semantic_object_ids, object_skill._xtype);
    add_string(capabilities._semantic_object_ids, object_skill._xui_type);
    add_string(capabilities._semantic_object_ids, object_skill._object_type);
    add_strings(capabilities._capability_keywords, object_skill._capabilities);
    if (is_plain_object(object_skill._match)) {
      add_strings(capabilities._capability_keywords, object_skill._match._keywords);
    }
  }

  private collect_ops(
    value: unknown,
    capabilities: VibeRuntimeCapabilityRegistry,
  ): void {
    const ops = Array.isArray(value)
      ? value
      : is_plain_object(value)
        ? Object.values(value)
        : [];

    for (const op of ops) {
      if (typeof op === "string") {
        add_string(capabilities._ops, op);
        continue;
      }
      if (is_plain_object(op)) {
        add_string(capabilities._ops, op._name);
        add_string(capabilities._ops, op._op);
      }
    }
  }

  private collect_module_ops(
    module_name: unknown,
    value: unknown,
    capabilities: VibeRuntimeCapabilityRegistry,
  ): void {
    const ops = Array.isArray(value)
      ? value
      : is_plain_object(value)
        ? Object.values(value)
        : [];

    for (const op of ops) {
      if (typeof op === "string") {
        add_module_op(capabilities, module_name, op);
        continue;
      }
      if (is_plain_object(op)) {
        add_module_op(capabilities, module_name, op._name);
        add_module_op(capabilities, module_name, op._op);
      }
    }
  }
}
