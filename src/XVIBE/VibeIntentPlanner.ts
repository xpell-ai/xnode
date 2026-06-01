import { _xlog } from "@xpell/core";
import type {
  XVibeIntentIR,
  XVibeIntentIRAction,
  XVibeIntentIRBinding,
  XVibeIntentIREntity,
  XVibeIntentIRStyle,
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

const INTENT_IR_VERSION = 1 as const;
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
  "view",
  "views",
  "page",
  "pages",
  "screen",
  "screens",
  "layout",
  "layouts",
  "dashboard",
  "dashboards",
  "form",
  "forms",
  "button",
  "buttons",
  "grid",
  "grids",
  "row",
  "rows",
  "column",
  "columns",
]);
const ENTITY_STOP_WORDS = new Set([
  "xpell",
  "view",
  "views",
  "page",
  "pages",
  "screen",
  "screens",
  "layout",
  "layouts",
  "statistic",
  "statistics",
  "status",
  "button",
  "buttons",
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
  "modal",
  "drawer",
  "app",
  "page",
  "section",
  "sections",
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

function has_explicit_flow_intent(text: string): boolean {
  return (
    /\bflow-[a-z0-9][a-z0-9_-]*\b/u.test(text) ||
    /\b(?:trigger|triggers|triggering|run|runs|running|execute|executes|executing|call|calls|calling)\s+(?:a|an|the)?\s*flow\b/u.test(text) ||
    /\bflow\s+(?:trigger|action|button)\b/u.test(text)
  );
}

function extract_prompt_flow_ids(text: string): string[] {
  const matches = text.match(/\bflow-[a-z0-9][a-z0-9_-]*\b/gi) ?? [];
  return unique(matches.map((match) => match.toLowerCase()));
}

export function has_explicit_data_or_crud_intent(prompt: string): boolean {
  const text = normalize_prompt_text(prompt);
  if (!text) return false;

  if (/\b(?:crud|records?|database|entities|entity|collections?|schemas?|persist|persistence|data records?|entity management)\b/u.test(text)) {
    return true;
  }

  if (/\b(?:delete|update)\b/u.test(text)) {
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
    if (BUSINESS_ENTITY_WORDS.includes(noun) && !UI_ENTITY_NAMES.has(noun)) {
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
    verbose_log("[xvibe] normalized capability extraction", normalized);

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

    return plan;
  }

  apply_ui_only_guard(prompt: string, plan: VibeIntentPlan): VibeIntentPlan {
    return this.apply_ui_only_guard_internal(prompt, plan, true);
  }

  infer_intent_plan(
    prompt: string,
    app_plan: unknown,
    runtime_capabilities: VibeRuntimeCapabilityRegistry = this.empty_runtime_capabilities(),
  ): VibeIntentPlan {
    const prompt_text = normalize_prompt_text(prompt);
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
      this.add_available(inferred._objects, ["xsection", "grid", "table", "kpi-card", "sidebar", "toolbar"], runtime_capabilities._semantic_object_ids);
      this.add_available(inferred._xui_objects, ["xsection", "grid", "table", "kpi-card", "sidebar", "toolbar"], runtime_capabilities._semantic_object_ids);
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
      this.add_available(inferred._modules, ["entity-client", "entity-manager", "xdb-entity", "xd"], runtime_capabilities._module_ids);
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
      this.add_available(inferred._modules, ["server-xvm", "xvm", "router"], runtime_capabilities._module_ids);
      append_unique(inferred._capabilities, ["navigation", "routing"]);
      append_unique(inferred._ui_patterns, ["navigation"]);
    }

    if (this.contains_any(text, ["realtime", "real-time", "live", "streaming", "stream", "subscribe", "push"])) {
      append_unique(inferred._artifact_types, ["flow"]);
      this.add_available(inferred._modules, ["xem", "wormholes"], runtime_capabilities._module_ids);
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
      this.add_available(inferred._modules, ["xd", "xdb", "xdb-entity"], runtime_capabilities._module_ids);
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
    if (/\b(?:cards?)\b/u.test(text)) {
      objects.push("card");
      this.add_layout_object(objects, runtime_capabilities);
    }
    if (/\b(?:grid|grids|row|rows|column|columns|aligned|layout)\b/u.test(text)) {
      this.add_layout_object(objects, runtime_capabilities);
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

  private add_layout_object(
    objects: string[],
    runtime_capabilities: VibeRuntimeCapabilityRegistry,
  ): void {
    const runtime_ids = new Set(
      runtime_capabilities._semantic_object_ids.map((item) => normalize_lookup_key(item)),
    );

    if (runtime_ids.size === 0 || runtime_ids.has("grid")) {
      objects.push("grid");
      return;
    }

    if (runtime_ids.has("stack")) {
      objects.push("stack");
    }
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
      /\b(?:create|build|generate|add|make)\s+(?:a|an\s+)?(?:server\s+)?(?:xmodule|module)\b/u
        .test(prompt_text)
    ) {
      const opMatches =
        [
          ...prompt_text.matchAll(
            /\bop(?:eration)?\s+(?:named|called)?\s*(_?[a-z][a-z0-9_-]*)\b/gu
          )
        ]
          .map((match) => match[1]?.replace(/^_/, ""))
          .filter((value): value is string => Boolean(value));

      const namedModuleMatch =
        /\b(?:xmodule|module)\s+(?:named|called)\s+([a-z][a-z0-9_-]*)\b/u
          .exec(prompt_text);

      const beforeModuleMatch =
        /\b([a-z][a-z0-9_-]*)\s+(?:xmodule|module)\b/u
          .exec(prompt_text);

      const candidateModuleName =
        namedModuleMatch?.[1] ??
        beforeModuleMatch?.[1];

      const moduleName =
        candidateModuleName && !RESERVED_MODULE_NAME_WORDS.has(candidateModuleName)
          ? candidateModuleName
          : this.infer_module_name_from_ops(opMatches) ??
          "generated-module";

      candidates.push({
        _module_target: "server",
        _module_name: moduleName,
        _module_ops:
          opMatches.length > 0
            ? unique(opMatches)
            : ["run"],
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
