import { normalize_string_array } from "./VibeIntentPlanner.js";

export type XVibeArtifactPlanType =
  | "view"
  | "flow"
  | "entity"
  | "module-spec";

export type XVibeLogicLevel =
  | "none"
  | "flow"
  | "xscript"
  | "module";

export type XVibeAppPlan = {
  _prompt: string;

  _app_type:
  | "app"
  | "dashboard"
  | "webapp"
  | "website"
  | "landing-page"
  | "console-service"
  | "game"
  | "crud"
  | "chat"
  | "tool"
  | "unknown";

  _logic_level: XVibeLogicLevel;

  _artifacts: XVibeArtifactPlanType[];

  _requires_module: boolean;

  _module_kind?:
  | "game-logic"
  | "crud"
  | "workflow"
  | "chat"
  | "custom";

  _capabilities: string[];

  _flow_ids?: string[];

  _reasoning?: string[];
};

export type XVibeArtifactExecutionItem = {
  _artifact_type: XVibeArtifactPlanType;
  _priority: number;
};

type XVibeAppPlanType = XVibeAppPlan["_app_type"];
type XVibeModuleKind = NonNullable<XVibeAppPlan["_module_kind"]>;
export type XVibeAIAppPlan = Partial<
  Pick<
    XVibeAppPlan,
    | "_app_type"
    | "_logic_level"
    | "_artifacts"
    | "_requires_module"
    | "_capabilities"
  >
>;

const GAME_KEYWORDS: string[] = [
  "game",
  "board game",
  "arcade",
  "platformer",
  "puzzle",
];

const MODULE_COMPLEXITY_KEYWORDS: string[] = [
  "rules",
  "engine",
  "physics",
  "simulation",
  "turn",
  "turn-based",
  "multiplayer",
  "realtime",
  "board",
  "collision",
  "enemy",
  "ai opponent",
  "game state",
  "logic",
];

const FLOW_COMPLEXITY_KEYWORDS: string[] = [
  "dashboard",
  "form",
  "table",
  "crud",
  "admin",
  "analytics",
  "workflow",
  "chat",
  "wizard",
];

const STATIC_APP_KEYWORDS: string[] = [
  "landing page",
  "portfolio",
  "homepage",
  "marketing page",
  "hero section",
];

const DASHBOARD_KEYWORDS: string[] = [
  "dashboard",
  "analytics",
  "admin",
];

const CHAT_KEYWORDS: string[] = [
  "chat",
  "messaging",
];

const CRUD_KEYWORDS: string[] = [
  "crud",
  "table",
  "records",
  "form",
];

const TOOL_KEYWORDS: string[] = [
  "tool",
  "calculator",
  "converter",
];

const ARTIFACT_EXECUTION_PRIORITIES: Record<XVibeArtifactPlanType, number> = {
  entity: 20,
  flow: 30,
  view: 40,
  "module-spec": 50,
};

const FLOW_ARTIFACT_PROMPT_PATTERNS: RegExp[] = [
  /_flow\b/i,
  /\btrigger flow\b/i,
  /\btriggers flow\b/i,
  /\bbutton triggers\b/i,
  /\bflow-[a-z0-9][a-z0-9_-]*\b/i,
];

type XVibeLogicInference = {
  _logic_level: XVibeLogicLevel;
  _reasoning: string[];
};

function normalize_prompt(prompt: string): string {
  return prompt
    .trim()
    .toLowerCase()
    .replace(/[_/]+/g, " ")
    .replace(/\s+/g, " ");
}

function escape_regexp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matches_keyword(prompt: string, keyword: string): boolean {
  const suffix: string = /^[a-z0-9]+$/.test(keyword) ? "s?" : "";
  const pattern: RegExp = new RegExp(
    `(^|[^a-z0-9])${escape_regexp(keyword)}${suffix}($|[^a-z0-9])`
  );

  return pattern.test(prompt);
}

function match_keywords(prompt: string, keywords: string[]): string[] {
  return keywords.filter((keyword: string): boolean => matches_keyword(prompt, keyword));
}

function contains_keyword(prompt: string, keywords: string[]): boolean {
  return match_keywords(prompt, keywords).length > 0;
}

function unique_artifacts(artifacts: XVibeArtifactPlanType[]): XVibeArtifactPlanType[] {
  return Array.from(new Set<XVibeArtifactPlanType>(artifacts));
}

function extract_flow_ids(prompt: string): string[] {
  const ids: string[] = [];
  ids.push(...(prompt.match(/\bflow-[a-z0-9][a-z0-9_-]*\b/gi) ?? []));

  const named_flow_pattern =
    /\b(?:run|trigger|call|execute)?\s*(?:a\s+|the\s+)?flow\s+named\s+([a-z][a-z0-9_-]*)\b/giu;

  for (const match of prompt.matchAll(named_flow_pattern)) {
    ids.push(match[1]);
  }

  return Array.from(
    new Set(ids.map((match) => match.trim().toLowerCase()).filter(Boolean))
  );
}

function prompt_requests_flow_artifact(prompt: string): boolean {
  return FLOW_ARTIFACT_PROMPT_PATTERNS.some((pattern) => pattern.test(prompt));
}

export class XVibePlanner {
  plan_app(prompt: string, ai_plan?: XVibeAIAppPlan,): XVibeAppPlan {
    const raw_prompt = prompt.trim();
    const normalized_prompt: string = normalize_prompt(prompt);
    const requested_flow_ids = extract_flow_ids(raw_prompt);
    const inferred_app_type: XVibeAppPlanType =
      this.infer_app_type(normalized_prompt);

    const app_type: XVibeAppPlanType =
      ai_plan?._app_type ??
      inferred_app_type;
    const inferred_logic_inference:
      XVibeLogicInference =
      this.infer_logic_level(
        normalized_prompt,
        app_type
      );

    const logic_level: XVibeLogicLevel =
      ai_plan?._logic_level ??
      inferred_logic_inference._logic_level;

    const logic_inference: XVibeLogicInference =
      ai_plan?._logic_level
        ? {
          _logic_level: logic_level,
          _reasoning: [
            "AI-assisted planner override applied."
          ]
        }
        : inferred_logic_inference;
    const requires_module: boolean = logic_level === "module";
    const module_kind: XVibeModuleKind | undefined =
      requires_module
        ? this.infer_module_kind(app_type)
        : undefined;
    const ai_artifacts = this.normalize_artifacts(ai_plan?._artifacts);
    const ai_capabilities = normalize_string_array(ai_plan?._capabilities);
    const inferred_artifacts: XVibeArtifactPlanType[] =
      ai_artifacts.length
        ? unique_artifacts(
          ai_artifacts
        )
        : this.infer_artifacts(logic_level);
    const artifacts: XVibeArtifactPlanType[] =
      prompt_requests_flow_artifact(raw_prompt)
        ? unique_artifacts([...inferred_artifacts, "flow"])
        : inferred_artifacts;
    const capabilities: string[] =
      ai_capabilities.length
        ? Array.from(
          new Set(ai_capabilities)
        )
        : this.infer_capabilities(app_type);

    return {
      _prompt: prompt.trim(),
      _app_type: app_type,
      _logic_level: logic_level,
      _artifacts: artifacts,
      _requires_module: requires_module,
      ...(module_kind ? { _module_kind: module_kind } : {}),
      _capabilities: capabilities,
      ...(requested_flow_ids.length > 0 ? { _flow_ids: requested_flow_ids } : {}),
      _reasoning: logic_inference._reasoning,
    };
  }

  build_execution_plan(plan: XVibeAppPlan): XVibeArtifactExecutionItem[] {
    return unique_artifacts(plan._artifacts)
      .map((artifact_type: XVibeArtifactPlanType): XVibeArtifactExecutionItem => ({
        _artifact_type: artifact_type,
        _priority: ARTIFACT_EXECUTION_PRIORITIES[artifact_type],
      }))
      .sort((
        left: XVibeArtifactExecutionItem,
        right: XVibeArtifactExecutionItem,
      ): number => left._priority - right._priority);
  }

  private normalize_artifacts(value: unknown): XVibeArtifactPlanType[] {
    return normalize_string_array(value)
      .filter((item): item is XVibeArtifactPlanType =>
        item === "view" ||
        item === "flow" ||
        item === "entity" ||
        item === "module-spec"
      );
  }

  private infer_app_type(prompt: string): XVibeAppPlanType {
    if (contains_keyword(prompt, GAME_KEYWORDS)) {
      return "game";
    }

    if (contains_keyword(prompt, DASHBOARD_KEYWORDS)) {
      return "dashboard";
    }

    if (contains_keyword(prompt, CHAT_KEYWORDS)) {
      return "chat";
    }

    if (contains_keyword(prompt, CRUD_KEYWORDS)) {
      return "crud";
    }

    if (contains_keyword(prompt, TOOL_KEYWORDS)) {
      return "tool";
    }

    return "app";
  }

  private infer_logic_level(
    prompt: string,
    app_type: XVibeAppPlanType,
  ): XVibeLogicInference {
    const module_matches: string[] =
      match_keywords(prompt, MODULE_COMPLEXITY_KEYWORDS);
    const flow_matches: string[] =
      match_keywords(prompt, FLOW_COMPLEXITY_KEYWORDS);
    const static_matches: string[] =
      match_keywords(prompt, STATIC_APP_KEYWORDS);
    const reasoning: string[] = [];

    if (app_type === "game") {
      reasoning.push("Detected game-related interaction complexity.");
    }

    if (module_matches.length > 0) {
      reasoning.push(
        `Detected runtime logic complexity signals: ${module_matches.join(", ")}.`
      );
    }

    if (module_matches.length > 0 || app_type === "game") {
      reasoning.push("Selected module logic level.");
      return {
        _logic_level: "module",
        _reasoning: reasoning,
      };
    }

    if (flow_matches.length > 0) {
      reasoning.push(
        `Detected flow interaction complexity signals: ${flow_matches.join(", ")}.`
      );
      reasoning.push("Selected flow logic level.");
      return {
        _logic_level: "flow",
        _reasoning: reasoning,
      };
    }

    if (static_matches.length > 0) {
      reasoning.push(
        `Detected static app signals: ${static_matches.join(", ")}.`
      );
    } else {
      reasoning.push("No interaction complexity detected.");
    }

    reasoning.push("Selected none logic level.");
    return {
      _logic_level: "none",
      _reasoning: reasoning,
    };
  }

  private infer_module_kind(app_type: XVibeAppPlanType): XVibeModuleKind {
    if (app_type === "game") {
      return "game-logic";
    }

    if (app_type === "crud") {
      return "crud";
    }

    if (app_type === "chat") {
      return "chat";
    }

    if (app_type === "dashboard") {
      return "workflow";
    }

    return "custom";
  }

  private infer_artifacts(logic_level: XVibeLogicLevel): XVibeArtifactPlanType[] {
    const artifacts: XVibeArtifactPlanType[] = [
      "view"
    ];

    if (logic_level === "flow") {
      artifacts.push("flow");
    }

    if (logic_level === "module") {
      artifacts.push("entity", "flow", "module-spec");
    }

    return unique_artifacts(artifacts);
  }

  private infer_capabilities(app_type: XVibeAppPlanType): string[] {
    if (app_type === "dashboard") {
      return ["card", "grid", "stack", "toolbar"];
    }

    if (app_type === "game") {
      return ["grid", "button", "label", "style-sheet"];
    }

    if (app_type === "crud") {
      return ["field", "table", "button", "toolbar"];
    }

    if (app_type === "chat") {
      return ["stack", "field", "button", "label"];
    }

    if (app_type === "tool") {
      return ["field", "button", "toolbar"];
    }

    return ["stack", "label", "style-sheet"];
  }
}
