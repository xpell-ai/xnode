import { _xu } from "../XNUtils/XUtils.js";

export type XVMProjectMemoryMilestoneItem = {
  _id: string;
  _title: string;
  _completed: boolean;
};

export type XVMProjectMemoryMilestone = {
  _id: string;
  _title: string;
  _items: XVMProjectMemoryMilestoneItem[];
};

export type XVMProjectMemoryFocusAliasResolution = {
  _focus: string;
  _normalized_focus: string;
  _canonical_focus: string;
  _is_alias: boolean;
};

export type XVMProjectMemoryFocusTemplateResolution = {
  _focus: string;
  _template: "authentication" | "entity-management";
  _entity: string;
  _milestone_id: string;
  _milestone_title: string;
};

export type XVMProjectMemoryMilestoneItemCompletionResult = {
  _completed: boolean;
  _reason?:
    | "missing_focus_milestone"
    | "missing_milestone_item"
    | "already_completed";
  _memory: Record<string, any>;
  _milestone?: XVMProjectMemoryMilestone;
  _item?: XVMProjectMemoryMilestoneItem;
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

function milestone_item(id: string, title: string): XVMProjectMemoryMilestoneItem {
  return {
    _id: id,
    _title: title,
    _completed: false,
  };
}

function clone_milestone(
  milestone: XVMProjectMemoryMilestone,
): XVMProjectMemoryMilestone {
  return {
    _id: milestone._id,
    _title: milestone._title,
    _items: milestone._items.map((item) => ({ ...item })),
  };
}

const DEFAULT_PROJECT_MEMORY_MILESTONES: XVMProjectMemoryMilestone[] = [
  {
    _id: "authentication",
    _title: "Authentication",
    _items: [
      milestone_item("user-crud", "User CRUD"),
      milestone_item("login", "Login"),
      milestone_item("roles", "Roles"),
      milestone_item("permissions", "Permissions"),
    ],
  },
];

const PROJECT_MEMORY_AUTHENTICATION_FOCUS_ALIASES = new Set([
  "auth",
  "authentication",
  "login",
  "users",
]);

function entity_management_milestone(
  entity_id: string,
): XVMProjectMemoryMilestone {
  const entity_title = title_case(entity_id.replace(/-/gu, " "));

  return {
    _id: `${entity_id}-management`,
    _title: `${entity_title} Management`,
    _items: [
      milestone_item(`${entity_id}-crud`, `${entity_title} CRUD`),
      milestone_item(`${entity_id}-search`, `${entity_title} Search`),
      milestone_item(`${entity_id}-filters`, `${entity_title} Filters`),
      milestone_item(`${entity_id}-edit`, `${entity_title} Edit`),
      milestone_item(`${entity_id}-delete`, `${entity_title} Delete`),
    ],
  };
}

export function project_memory_focus_template_resolution(
  focus: unknown,
): XVMProjectMemoryFocusTemplateResolution | undefined {
  const raw_focus = read_string(focus);
  const normalized_focus = normalize_text(raw_focus);
  if (!raw_focus || !normalized_focus) return undefined;

  if (PROJECT_MEMORY_AUTHENTICATION_FOCUS_ALIASES.has(normalized_focus)) {
    return {
      _focus: raw_focus,
      _template: "authentication",
      _entity: "user",
      _milestone_id: "authentication",
      _milestone_title: "Authentication",
    };
  }

  const entity_match =
    normalized_focus.match(/^([a-z][a-z0-9 ]*?)\s+management$/u) ??
    normalized_focus.match(/^([a-z][a-z0-9 ]*?)\s+manager$/u) ??
    normalized_focus.match(/^([a-z][a-z0-9 ]*?)\s+crud$/u) ??
    normalized_focus.match(/^([a-z][a-z0-9]*?)$/u);
  const raw_entity = entity_match?.[1]?.trim();
  if (!raw_entity) return undefined;

  const entity_id = normalize_id(raw_entity);
  if (!entity_id) return undefined;

  const singular_entity = singular_entity_id(entity_id);
  const milestone = entity_management_milestone(singular_entity);

  return {
    _focus: raw_focus,
    _template: "entity-management",
    _entity: singular_entity,
    _milestone_id: milestone._id,
    _milestone_title: milestone._title,
  };
}

export function project_memory_focus_alias_resolution(
  focus: unknown,
): XVMProjectMemoryFocusAliasResolution | undefined {
  const raw_focus = read_string(focus);
  const normalized_focus = normalize_text(raw_focus);
  if (!raw_focus || !normalized_focus) return undefined;

  const template_resolution = project_memory_focus_template_resolution(raw_focus);
  if (!template_resolution) return undefined;

  return {
    _focus: raw_focus,
    _normalized_focus: normalized_focus,
    _canonical_focus: template_resolution._milestone_id,
    _is_alias: normalize_id(raw_focus) !== template_resolution._milestone_id,
  };
}

function focus_match_terms(focus: unknown): Set<string> {
  const normalized_focus = normalize_text(focus);
  const terms = new Set<string>();
  if (normalized_focus) terms.add(normalized_focus);

  const template_resolution = project_memory_focus_template_resolution(focus);
  if (template_resolution) {
    terms.add(normalize_text(template_resolution._milestone_id));
    terms.add(normalize_text(template_resolution._milestone_title));

    if (template_resolution._template === "entity-management") {
      terms.add(normalize_text(template_resolution._entity));
      terms.add(normalize_text(`${template_resolution._entity}s`));
      terms.add(normalize_text(`${template_resolution._entity} crud`));
      terms.add(normalize_text(`${template_resolution._entity}-crud`));
      terms.add(normalize_text(`${template_resolution._entity} management`));
      terms.add(normalize_text(`${template_resolution._entity}-management`));
    }
  }

  return terms;
}

export function default_project_memory_milestone_for_focus(
  focus: unknown,
): XVMProjectMemoryMilestone | undefined {
  const template_resolution = project_memory_focus_template_resolution(focus);
  if (template_resolution?._template === "entity-management") {
    return entity_management_milestone(template_resolution._entity);
  }

  const match_terms = focus_match_terms(focus);
  if (match_terms.size === 0) return undefined;

  const default_milestone = DEFAULT_PROJECT_MEMORY_MILESTONES.find((milestone) =>
    match_terms.has(normalize_text(milestone._title)) ||
    match_terms.has(normalize_text(milestone._id))
  );

  return default_milestone ? clone_milestone(default_milestone) : undefined;
}

export function normalize_project_memory_milestones(
  value: unknown,
): XVMProjectMemoryMilestone[] {
  if (!Array.isArray(value)) return [];

  const milestones: XVMProjectMemoryMilestone[] = [];
  const seen_milestones = new Set<string>();

  for (const raw_milestone of value) {
    if (!_xu.is_plain_object(raw_milestone)) continue;

    const title = read_string(raw_milestone._title) ??
      read_string(raw_milestone._id);
    const id = normalize_id(read_string(raw_milestone._id) ?? title);
    if (!id || !title || seen_milestones.has(id)) continue;

    const items: XVMProjectMemoryMilestoneItem[] = [];
    const seen_items = new Set<string>();
    const raw_items =
      Array.isArray(raw_milestone._items) ? raw_milestone._items : [];
    for (const raw_item of raw_items) {
      if (!_xu.is_plain_object(raw_item)) continue;

      const item_title = read_string(raw_item._title) ??
        read_string(raw_item._id);
      const item_id = normalize_id(read_string(raw_item._id) ?? item_title);
      if (!item_id || !item_title || seen_items.has(item_id)) continue;

      seen_items.add(item_id);
      items.push({
        _id: item_id,
        _title: item_title,
        _completed: raw_item._completed === true,
      });
    }

    seen_milestones.add(id);
    milestones.push({
      _id: id,
      _title: title,
      _items: items,
    });
  }

  return milestones;
}

export function project_memory_focus_milestone(input: {
  _focus: unknown;
  _milestones: unknown;
}): XVMProjectMemoryMilestone | undefined {
  const match_terms = focus_match_terms(input._focus);
  if (match_terms.size === 0) return undefined;

  const milestones = normalize_project_memory_milestones(input._milestones);
  const matching_milestone = milestones.find((milestone) =>
    match_terms.has(normalize_text(milestone._id)) ||
    match_terms.has(normalize_text(milestone._title))
  );
  if (matching_milestone) return matching_milestone;

  return default_project_memory_milestone_for_focus(input._focus);
}

function completed_texts(items: unknown): string[] {
  if (!Array.isArray(items)) return [];

  return items
    .map((item) => {
      if (typeof item === "string") return normalize_text(item);
      if (!_xu.is_plain_object(item)) return "";

      const parts = [
        read_string(item._id),
        read_string(item._title),
        read_string(item._name),
        read_string(item._type),
      ].filter((part): part is string => typeof part === "string");

      return normalize_text(parts.join(" "));
    })
    .filter((text) => text.length > 0);
}

function completed_matches_milestone_item(
  completed: string,
  item: XVMProjectMemoryMilestoneItem,
): boolean {
  const item_id = normalize_text(item._id);
  const item_title = normalize_text(item._title);

  return completed === item_id ||
    completed === item_title ||
    completed.includes(item_title) ||
    completed.includes(item_id);
}

function milestone_matches_focus(
  milestone: XVMProjectMemoryMilestone,
  focus_milestone: XVMProjectMemoryMilestone,
): boolean {
  return milestone._id === focus_milestone._id ||
    normalize_text(milestone._title) === normalize_text(focus_milestone._title);
}

export function complete_project_memory_focus_milestone_item(input: {
  _memory: Record<string, any>;
  _item_id?: string;
  _item_title?: string;
}): XVMProjectMemoryMilestoneItemCompletionResult {
  const memory = _xu.is_plain_object(input._memory) ? input._memory : {};
  const focus_milestone = project_memory_focus_milestone({
    _focus: memory._current_focus,
    _milestones: memory._milestones,
  });
  if (!focus_milestone) {
    return {
      _completed: false,
      _reason: "missing_focus_milestone",
      _memory: memory,
    };
  }

  const target_terms = [
    input._item_id,
    input._item_title,
  ]
    .map(normalize_text)
    .filter((term) => term.length > 0);
  if (target_terms.length === 0) {
    return {
      _completed: false,
      _reason: "missing_milestone_item",
      _memory: memory,
      _milestone: focus_milestone,
    };
  }

  const target_item = focus_milestone._items.find((item) => {
    const item_terms = [
      normalize_text(item._id),
      normalize_text(item._title),
    ];

    return target_terms.some((target_term) =>
      item_terms.some((item_term) =>
        target_term === item_term ||
        target_term.includes(item_term) ||
        item_term.includes(target_term)
      )
    );
  });

  if (!target_item) {
    return {
      _completed: false,
      _reason: "missing_milestone_item",
      _memory: memory,
      _milestone: focus_milestone,
    };
  }

  const milestones = normalize_project_memory_milestones(memory._milestones);
  const focus_milestone_index =
    milestones.findIndex((milestone) =>
      milestone_matches_focus(milestone, focus_milestone)
    );
  const next_milestones =
    focus_milestone_index >= 0
      ? milestones
      : [...milestones, focus_milestone];
  const target_milestone_index =
    focus_milestone_index >= 0
      ? focus_milestone_index
      : next_milestones.length - 1;
  const target_milestone = next_milestones[target_milestone_index];
  const target_item_index =
    target_milestone._items.findIndex((item) =>
      normalize_text(item._id) === normalize_text(target_item._id) ||
      normalize_text(item._title) === normalize_text(target_item._title)
    );

  if (target_item_index < 0) {
    return {
      _completed: false,
      _reason: "missing_milestone_item",
      _memory: {
        ...memory,
        _milestones: next_milestones,
      },
      _milestone: target_milestone,
      _item: target_item,
    };
  }

  if (target_milestone._items[target_item_index]._completed === true) {
    return {
      _completed: false,
      _reason: "already_completed",
      _memory: {
        ...memory,
        _milestones: next_milestones,
      },
      _milestone: target_milestone,
      _item: target_milestone._items[target_item_index],
    };
  }

  const completed_item = {
    ...target_milestone._items[target_item_index],
    _completed: true,
  };
  const completed_milestone = {
    ...target_milestone,
    _items: target_milestone._items.map((item, index) =>
      index === target_item_index ? completed_item : item
    ),
  };
  const completed_milestones =
    next_milestones.map((milestone, index) =>
      index === target_milestone_index ? completed_milestone : milestone
    );

  return {
    _completed: true,
    _memory: {
      ...memory,
      _milestones: completed_milestones,
    },
    _milestone: completed_milestone,
    _item: completed_item,
  };
}

export function apply_project_memory_milestones(
  memory: Record<string, any>,
): Record<string, any> {
  const focus_milestone = project_memory_focus_milestone({
    _focus: memory._current_focus,
    _milestones: memory._milestones,
  });
  const milestones = normalize_project_memory_milestones(memory._milestones);

  const has_focus_milestone =
    focus_milestone &&
    milestones.some((milestone) => milestone._id === focus_milestone._id);
  const next_milestones =
    focus_milestone && !has_focus_milestone
      ? [...milestones, focus_milestone]
      : milestones;
  const completed = completed_texts(memory._completed);

  if (completed.length === 0) {
    return {
      ...memory,
      _milestones: next_milestones,
    };
  }

  return {
    ...memory,
    _milestones: next_milestones.map((milestone) => ({
      ...milestone,
      _items: milestone._items.map((item) => ({
        ...item,
        _completed: item._completed ||
          completed.some((completed_text) =>
            completed_matches_milestone_item(completed_text, item)
          ),
      })),
    })),
  };
}
