import type { VibeKnowledgeSelection, VibeSkillDocument } from "./VibeKnowledgeSelector.js";
import type { XVibeJsonObject, XVibeViewArtifact } from "./VibeOutputParser.js";
import {
  generateXUIArtifact,
  type VibeArtifactFactoryContext,
  type VibeArtifactFactoryDiagnostic,
} from "./VibeArtifactFactory.js";
import type {
  XVibeIntentIR,
  XVibeIntentIRAction,
  XVibeIntentIREntity,
} from "./XVibeTypes.js";

export type VibeViewBuilderInput = {
  _intent_ir: XVibeIntentIR;
  _prompt: string;
  _runtime_context: XVibeJsonObject;
  _runtime_skills?: unknown;
  _planned_flow_ids?: string[];
  _selected_skills: VibeKnowledgeSelection["skills"] | VibeSkillDocument[] | unknown[];
  _artifact_factory_diagnostics?: VibeArtifactFactoryDiagnostic[];
};

type XVibeViewNode = XVibeJsonObject & {
  _type: string;
  _children?: XVibeViewNode[];
};

export type VibeEnsureViewIdsResult = {
  _count: number;
};

const SELECT_FIELD_NAMES = new Set([
  "status",
  "type",
  "category",
]);
const DEFAULT_XSELECT_OPTIONS = [
  {
    _value: "active",
    _label: "Active",
  },
  {
    _value: "pending",
    _label: "Pending",
  },
];

function unique_strings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function is_plain_object(value: unknown): value is XVibeJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function read_skill_xui_objects(skill: unknown): string[] {
  if (!is_plain_object(skill)) {
    return [];
  }

  const exports_obj = is_plain_object(skill._exports) ? skill._exports : {};
  const values = [
    skill._id,
    skill._xtype,
    skill._xui_type,
    skill._object_type,
    ...(Array.isArray(skill._xui_objects) ? skill._xui_objects : []),
    ...(Array.isArray(exports_obj._xui_objects) ? exports_obj._xui_objects : []),
  ];

  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function label_from_id(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function field_id(entity_id: string, field_name: string): string {
  return `${entity_id}-${field_name}`.replace(/[^a-zA-Z0-9_-]/g, "-");
}

function read_generated_flow_ids(runtime_context: XVibeJsonObject): string[] {
  const generated_artifacts = runtime_context._generated_artifacts;
  if (!is_plain_object(generated_artifacts) || !Array.isArray(generated_artifacts._flows)) {
    return [];
  }

  return unique_strings(
    generated_artifacts._flows
      .map((flow) => {
        if (!is_plain_object(flow)) return undefined;
        const flow_id = flow._flow_id ?? flow._artifact_id;
        return typeof flow_id === "string" && flow_id.trim().length > 0
          ? flow_id.trim()
          : undefined;
      })
      .filter((flow_id): flow_id is string => typeof flow_id === "string"),
  );
}

function extract_prompt_flow_ids(prompt: string): string[] {
  const ids: string[] = [];
  ids.push(...(prompt.match(/\bflow-[a-z0-9][a-z0-9_-]*\b/gi) ?? []));

  const named_flow_pattern =
    /\b(?:run|trigger|call|execute)?\s*(?:a\s+|the\s+)?flow\s+named\s+([a-z][a-z0-9_-]*)\b/giu;

  for (const match of prompt.matchAll(named_flow_pattern)) {
    ids.push(match[1]);
  }

  return unique_strings(
    ids.map((match) => match.trim().toLowerCase()).filter((match) => match.length > 0)
  );
}

function view_node_type(value: XVibeJsonObject): string | undefined {
  return typeof value._type === "string" && value._type.trim().length > 0
    ? value._type.trim()
    : undefined;
}

function view_node_id(value: XVibeJsonObject): string | undefined {
  return typeof value._id === "string" && value._id.trim().length > 0
    ? value._id.trim()
    : undefined;
}

function stable_id_prefix(type: string): string {
  const prefix =
    type
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");

  return prefix.length > 0 ? prefix : "node";
}

function escape_regexp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function visit_view_objects(
  value: unknown,
  visitor: (node: XVibeJsonObject, type: string | undefined) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visit_view_objects(item, visitor);
    }
    return;
  }

  if (!is_plain_object(value)) return;

  const type = view_node_type(value);
  visitor(value, type);

  for (const child of Object.values(value)) {
    if (is_plain_object(child) || Array.isArray(child)) {
      visit_view_objects(child, visitor);
    }
  }
}

export function ensure_view_ids(view: unknown): VibeEnsureViewIdsResult {
  const used_ids = new Set<string>();
  const counters = new Map<string, number>();

  visit_view_objects(view, (node, type) => {
    const id = view_node_id(node);
    if (!id) return;

    used_ids.add(id);
    if (!type) return;

    const prefix = stable_id_prefix(type);
    const match = new RegExp(`^${escape_regexp(prefix)}-(\\d+)$`).exec(id);
    if (match) {
      counters.set(prefix, Math.max(counters.get(prefix) ?? 0, Number(match[1])));
    }
  });

  let count = 0;

  visit_view_objects(view, (node, type) => {
    if (!type) return;
    if (view_node_id(node)) return;

    const prefix = stable_id_prefix(type);
    let next_counter = (counters.get(prefix) ?? 0) + 1;
    let next_id = `${prefix}-${next_counter}`;

    while (used_ids.has(next_id)) {
      next_counter += 1;
      next_id = `${prefix}-${next_counter}`;
    }

    counters.set(prefix, next_counter);
    used_ids.add(next_id);
    node._id = next_id;
    count += 1;
  });

  return { _count: count };
}

export class VibeViewBuilder {
  build(input: VibeViewBuilderInput): XVibeViewArtifact {
    const view: XVibeViewArtifact = {
      _id: "main",
      _type: "view",
      _children: [],
    };

    const children: XVibeViewNode[] = [];

    if (this.should_include_style_sheet(input)) {
      children.push(this.build_style_sheet(input));
    }

    if (this.is_dashboard_intent(input._intent_ir)) {
      children.push(...this.build_dashboard_children(input));
    } else {
      children.push(...this.build_region_children(input));
    }

    view._children = children;
    ensure_view_ids(view);

    return view;
  }

  private build_dashboard_children(input: VibeViewBuilderInput): XVibeViewNode[] {
    const nodes: XVibeViewNode[] = [];

    const sidebar = this.build_sidebar(input);
    if (sidebar) nodes.push(sidebar);

    const toolbar = this.build_toolbar(input);
    if (toolbar) nodes.push(toolbar);

    const kpi_section = this.build_kpi_section(input);
    if (kpi_section) nodes.push(kpi_section);

    const records_section = this.build_records_section(input);
    if (records_section) nodes.push(records_section);

    const create_modal = this.build_create_modal(input);
    if (create_modal) nodes.push(create_modal);

    const details_drawer = this.build_details_drawer(input);
    if (details_drawer) nodes.push(details_drawer);

    return nodes;
  }

  private build_region_children(input: VibeViewBuilderInput): XVibeViewNode[] {
    const nodes: XVibeViewNode[] = [];

    const toolbar = this.build_toolbar(input);
    if (toolbar) nodes.push(toolbar);

    const records_section = this.build_records_section(input);
    if (records_section) nodes.push(records_section);

    const create_modal = this.build_create_modal(input);
    if (create_modal) nodes.push(create_modal);

    return nodes;
  }

  private build_style_sheet(input: VibeViewBuilderInput): XVibeViewNode {
    const intent_ir = input._intent_ir;
    return this.generate_object(input, "style-sheet", {
      _id: "view-style",
      ...(intent_ir._style?._theme ? { _theme: intent_ir._style._theme } : {}),
      ...(intent_ir._style?._density ? { _density: intent_ir._style._density } : {}),
      ...(intent_ir._style?._layout ? { _layout: intent_ir._style._layout } : {}),
    });
  }

  private build_sidebar(input: VibeViewBuilderInput): XVibeViewNode | undefined {
    if (!this.region_requested(input._intent_ir, "sidebar")) return undefined;
    if (!this.object_available(input, "sidebar")) return undefined;

    const children: XVibeViewNode[] = [];

    if (this.object_available(input, "navlist")) {
      children.push({
        _id: "main-nav",
        _type: "navlist",
        _items: [
          {
            _id: "overview",
            _label: "Overview",
            _target_region: "content",
          },
          {
            _id: "records",
            _label: "Records",
            _target_region: "records_table",
          },
        ],
      });
    }

    if (children.length === 0) return undefined;

    return {
      _id: "app-sidebar",
      _type: "sidebar",
      _children: children,
    };
  }

  private build_toolbar(input: VibeViewBuilderInput): XVibeViewNode | undefined {
    if (!this.region_requested(input._intent_ir, "toolbar")) return undefined;
    if (!this.object_available(input, "toolbar")) return undefined;

    const children: XVibeViewNode[] = [];

    if (this.object_available(input, "field")) {
      children.push(
        this.build_field(
          input,
          "records-search",
          "search",
          "Search",
          "Search records",
          "filters.search"
        )
      );
    }

    if (this.object_available(input, "button")) {
      for (const action of input._intent_ir._actions) {
        children.push(this.build_action_button(input, action, "toolbar"));
      }
    }

    if (children.length === 0) return undefined;

    return this.generate_object(input, "toolbar", {
      _id: "app-toolbar",
      _children: children,
    });
  }

  private build_kpi_section(input: VibeViewBuilderInput): XVibeViewNode | undefined {
    if (!this.region_requested(input._intent_ir, "kpi_grid")) return undefined;
    if (!this.object_available(input, "xsection")) return undefined;
    if (!this.object_available(input, "grid")) return undefined;
    if (!this.object_available(input, "kpi-card")) return undefined;

    const entity = this.primary_entity(input);
    const entity_label = entity ? label_from_id(entity._id) : "Records";

    return this.generate_object(input, "xsection", {
      _id: "kpi-section",
      _title: "Overview",
      _children: [
        {
          _id: "kpi-grid",
          _type: "grid",
          _children: [
            {
              _id: "total-records-kpi",
              _type: "kpi-card",
              _label: `Total ${entity_label}`,
              _value: "0",
            },
            {
              _id: "active-records-kpi",
              _type: "kpi-card",
              _label: "Active",
              _value: "0",
            },
            {
              _id: "new-records-kpi",
              _type: "kpi-card",
              _label: "New",
              _value: "0",
            },
          ],
        },
      ],
    });
  }

  private build_records_section(input: VibeViewBuilderInput): XVibeViewNode | undefined {
    if (!this.region_requested(input._intent_ir, "records_table")) return undefined;
    if (!this.object_available(input, "table")) return undefined;

    const entity = this.primary_entity(input);
    const table = this.build_records_table(input, entity);

    if (this.object_available(input, "xsection")) {
      return this.generate_object(input, "xsection", {
        _id: "records-section",
        _title: entity ? label_from_id(entity._id) : "Records",
        _children: [table],
      });
    }

    return table;
  }

  private build_records_table(
    input: VibeViewBuilderInput,
    entity: XVibeIntentIREntity | undefined,
  ): XVibeViewNode {
    const intent_ir = input._intent_ir;
    const entity_id = entity?._id ?? "records";
    const fields = this.entity_fields(entity);
    const binding = intent_ir._bindings.find((item) => item._target === `${entity_id}-table`);

    return this.generate_object(input, "table", {
      _id: `${entity_id}-table`,
      _columns: fields.map((field) => ({
        _key: field,
        _label: label_from_id(field),
      })),
      _data_source: binding?._source ?? `${entity_id}:records`,
    });
  }

  private build_create_modal(input: VibeViewBuilderInput): XVibeViewNode | undefined {
    if (!this.region_requested(input._intent_ir, "create_modal")) return undefined;
    if (!this.object_available(input, "modal")) return undefined;

    const entity = this.primary_entity(input);
    const fields = this.entity_fields(entity);
    const form_children = this.build_form_fields(input, entity, fields, "create");
    const add_action = this.primary_add_action(input._intent_ir);

    if (add_action && this.object_available(input, "button")) {
      form_children.push(this.build_action_button(input, add_action, "create"));
    }

    const modal_children: XVibeViewNode[] = [];
    if (this.object_available(input, "form")) {
      modal_children.push(this.generate_object(input, "form", {
        _id: `${entity?._id ?? "record"}-form`,
        _children: form_children,
      }));
    } else {
      modal_children.push(...form_children);
    }

    if (modal_children.length === 0) return undefined;

    return this.generate_object(input, "modal", {
      _id: "create-modal",
      _title: add_action?._label ?? "Create Record",
      _children: modal_children,
    });
  }

  private build_details_drawer(input: VibeViewBuilderInput): XVibeViewNode | undefined {
    if (!this.region_requested(input._intent_ir, "details_drawer")) return undefined;
    if (!this.object_available(input, "drawer")) return undefined;

    const entity = this.primary_entity(input);
    const fields = this.entity_fields(entity);
    const drawer_children = this.build_form_fields(input, entity, fields, "details");

    if (drawer_children.length === 0) return undefined;

    return {
      _id: "details-drawer",
      _type: "drawer",
      _title: entity ? `${label_from_id(entity._id)} Details` : "Details",
      _children: drawer_children,
    };
  }

  private build_form_fields(
    input: VibeViewBuilderInput,
    entity: XVibeIntentIREntity | undefined,
    fields: string[],
    scope: string,
  ): XVibeViewNode[] {
    const nodes: XVibeViewNode[] = [];
    const entity_id = entity?._id ?? "record";

    for (const field_name of fields) {
      const id = field_id(`${scope}-${entity_id}`, field_name);
      const label = label_from_id(field_name);

      if (this.object_available(input, "field")) {
        nodes.push(
          this.build_field(
            input,
            id,
            field_name,
            label,
            `Enter ${this.singularize_entity_id(entity_id)} ${field_name}`,
            `form.${field_name}`,
          )
        );
      }
    }

    return nodes;
  }

  private build_field(
    input: VibeViewBuilderInput,
    id: string,
    field_name: string,
    label: string,
    placeholder: string,
    data_output: string,
  ): XVibeViewNode {
    const control_type = SELECT_FIELD_NAMES.has(field_name) ? "select" : "text";

    return this.generate_object(input, "field", {
      _id: id,
      _label: label,
      _control: {
        _type: control_type,
        name: field_name,
        placeholder,
        _data_output: data_output,
        ...(control_type === "select" ? { _options: DEFAULT_XSELECT_OPTIONS } : {}),
      },
    });
  }

  private build_action_button(
    input: VibeViewBuilderInput,
    action: XVibeIntentIRAction,
    scope: string,
  ): XVibeViewNode {
    return this.generate_object(input, "button", {
      _id: `${scope}-${action._id}-button`,
      _text: action._label,
      _flow: {
        _id: this.resolve_flow_id(
          action,
          this.generated_flow_ids(input._runtime_context),
          input._planned_flow_ids ?? [],
          extract_prompt_flow_ids(input._prompt),
        ),
        _payload: {
          _action: action._id,
          ...(action._entity ? { _entity: action._entity } : {}),
        },
      },
    });
  }

  private primary_entity(input: Pick<VibeViewBuilderInput, "_intent_ir" | "_prompt">): XVibeIntentIREntity | undefined {
    const entities = input._intent_ir._entities;
    if (entities.length <= 1) return entities[0];

    const scores = new Map<string, number>();
    const add_score = (entity_id: string | undefined, score: number) => {
      if (!entity_id) return;
      scores.set(entity_id, (scores.get(entity_id) ?? 0) + score);
    };

    for (const entity of entities) {
      add_score(entity._id, entity._fields.length);
    }

    for (const action of input._intent_ir._actions) {
      add_score(action._entity, 30);
    }

    for (const binding of input._intent_ir._bindings) {
      const [entity_id] = binding._source.split(":");
      add_score(entity_id, 20);
    }

    const normalized_prompt = input._prompt.toLowerCase();
    for (const entity of entities) {
      if (normalized_prompt.includes(entity._id)) {
        add_score(entity._id, 40);
      }
      const singular = this.singularize_entity_id(entity._id);
      if (normalized_prompt.includes(singular)) {
        add_score(entity._id, 35);
      }
      if (normalized_prompt.includes(`${singular} records`) || normalized_prompt.includes(`${entity._id} records`)) {
        add_score(entity._id, 60);
      }
    }

    return [...entities]
      .sort((left, right) => (scores.get(right._id) ?? 0) - (scores.get(left._id) ?? 0))[0];
  }

  private entity_fields(entity: XVibeIntentIREntity | undefined): string[] {
    const fields = entity?._fields ?? [];
    const normalized = unique_strings(fields.filter((field) => field.trim().length > 0));
    return normalized.length > 0 ? normalized : ["name"];
  }

  private primary_add_action(intent_ir: XVibeIntentIR): XVibeIntentIRAction | undefined {
    return (
      intent_ir._actions.find((action) => action._op === "add") ??
      intent_ir._actions[0]
    );
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

  private is_dashboard_intent(intent_ir: XVibeIntentIR): boolean {
    return intent_ir._intent_type === "dashboard" || intent_ir._style?._layout === "dashboard";
  }

  private should_include_style_sheet(
    input: Pick<VibeViewBuilderInput, "_intent_ir" | "_prompt" | "_selected_skills">,
  ): boolean {
    return (
      this.prompt_requests_styling(input._prompt) &&
      this.object_available(input, "style-sheet")
    );
  }

  private prompt_requests_styling(prompt: string): boolean {
    return /\b(style|styled|styling|theme|themed|color|colors|css|stylesheet|style-sheet|visual|design|modern|polish|beautiful|pretty)\b/i.test(prompt);
  }

  private generated_flow_ids(runtime_context: XVibeJsonObject): string[] {
    return read_generated_flow_ids(runtime_context);
  }

  private resolve_flow_id(
    action: XVibeIntentIRAction,
    generated_flow_ids: string[],
    planned_flow_ids: string[],
    prompt_flow_ids: string[],
  ): string {
    if (generated_flow_ids.length === 1) {
      return generated_flow_ids[0];
    }

    if (generated_flow_ids.includes(action._id)) {
      return action._id;
    }

    if (generated_flow_ids.length > 0) {
      return generated_flow_ids[0];
    }

    if (planned_flow_ids.length === 1) {
      return planned_flow_ids[0];
    }

    if (planned_flow_ids.includes(action._id)) {
      return action._id;
    }

    if (planned_flow_ids.length > 0) {
      return planned_flow_ids[0];
    }

    if (prompt_flow_ids.length === 1) {
      return prompt_flow_ids[0];
    }

    if (prompt_flow_ids.includes(action._id)) {
      return action._id;
    }

    if (prompt_flow_ids.length > 0) {
      return prompt_flow_ids[0];
    }

    return action._id;
  }

  private generate_object(
    input: VibeViewBuilderInput,
    type: string,
    intent: XVibeJsonObject,
  ): XVibeViewNode {
    const context: VibeArtifactFactoryContext = {
      _runtime_context: input._runtime_context,
      _runtime_skills: input._runtime_skills,
      _selected_skills: input._selected_skills,
      _diagnostics: input._artifact_factory_diagnostics,
    };

    return generateXUIArtifact(type, intent, context) as XVibeViewNode;
  }

  private region_requested(intent_ir: XVibeIntentIR, region: string): boolean {
    return intent_ir._regions.length === 0 || intent_ir._regions.includes(region);
  }

  private object_available(
    input: Pick<VibeViewBuilderInput, "_intent_ir" | "_selected_skills">,
    object_id: string,
  ): boolean {
    if (input._intent_ir._objects.includes(object_id)) return true;

    for (const skill of input._selected_skills) {
      if (read_skill_xui_objects(skill).includes(object_id)) {
        return true;
      }
    }

    return false;
  }
}
