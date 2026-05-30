import { _x, _xlog } from "@xpell/core";
import type { XVibeJsonObject } from "./VibeOutputParser.js";

export type VibeArtifactFactorySource =
  | "class.generateArtifact"
  | "class.canonical_example"
  | "selected_skill.canonical_example"
  | "fallback";

export type VibeArtifactFactoryDiagnostic = {
  _type: string;
  _id?: string;
  _source: VibeArtifactFactorySource;
  _module?: "xui";
  _sanitized: boolean;
  _removed_keys_count?: number;
};

export type VibeArtifactFactoryContext = {
  _runtime_context?: unknown;
  _runtime_skills?: unknown;
  _selected_skills?: unknown[];
  _diagnostics?: VibeArtifactFactoryDiagnostic[];
};

type XUIArtifactClass = {
  generateArtifact?: (intent: XVibeJsonObject, context: VibeArtifactFactoryContext) => unknown;
  getOwnSkill?: () => unknown;
  _skill?: unknown;
};

const clone_json = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const UNSAFE_CANONICAL_BEHAVIOR_KEYS = new Set([
  "_flow",
  "_on",
  "_once",
  "_command",
  "_module",
  "_op",
  "_params",
  "_action",
  "onClick",
  "onclick",
  "handler",
  "callback",
]);

function debug_enabled(): boolean {
  return Boolean((_xlog as unknown as { _debug?: boolean })._debug);
}

function is_plain_object(value: unknown): value is XVibeJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize_type_id(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .trim()
    .toLowerCase()
    .replace(/^x(?=[a-z])/, "")
    .replace(/[_\s]+/g, "-");
}

function read_string_array(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function read_object_type_ids(value: unknown): string[] {
  if (!is_plain_object(value)) return [];

  const exports_obj = is_plain_object(value._exports) ? value._exports : {};
  return [
    value._id,
    value._name,
    value._type,
    value._xtype,
    value._xui_type,
    value._object_type,
    ...read_string_array(value._xui_objects),
    ...read_string_array(exports_obj._xui_objects),
  ]
    .map(normalize_type_id)
    .filter((item) => item.length > 0);
}

function has_generate_artifact(value: unknown): value is XUIArtifactClass {
  return (
    (typeof value === "function" || is_plain_object(value)) &&
    typeof (value as XUIArtifactClass).generateArtifact === "function"
  );
}

function pascal_case(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("");
}

function camel_case(value: string): string {
  const pascal = pascal_case(value);
  if (!pascal) return "";
  return `${pascal.charAt(0).toLowerCase()}${pascal.slice(1)}`;
}

function xui_object_class_aliases(type: string): string[] {
  const trimmed = type.trim();
  const normalized = normalize_type_id(trimmed);
  const pascal = pascal_case(trimmed);

  return Array.from(new Set([
    trimmed,
    normalized,
    camel_case(trimmed),
    pascal,
    pascal ? `X${pascal}` : "",
    trimmed.replace(/[^a-zA-Z0-9]+/g, ""),
  ].filter((alias) => alias.length > 0)));
}

function resolve_xui_object_class(type: string): XUIArtifactClass | undefined {
  const get_module = (_x as unknown as { getModule?: (name: string) => unknown }).getModule;
  if (typeof get_module !== "function") return undefined;

  const xui = get_module.call(_x, "xui");
  if (!is_plain_object(xui)) return undefined;

  const object_manager = xui._object_manager;
  if (!is_plain_object(object_manager)) return undefined;

  const aliases = xui_object_class_aliases(type);
  const get_object_class = object_manager.getObjectClass;
  if (typeof get_object_class === "function") {
    for (const alias of aliases) {
      const object_class = get_object_class.call(object_manager, alias);
      if (object_class) return object_class as XUIArtifactClass;
    }
  }

  const get_object_classes = object_manager.getObjectClasses;
  if (typeof get_object_classes === "function") {
    const classes = get_object_classes.call(object_manager);
    if (classes instanceof Map) {
      for (const alias of aliases) {
        const object_class = classes.get(alias);
        if (object_class) return object_class as XUIArtifactClass;
      }
    } else if (is_plain_object(classes)) {
      for (const alias of aliases) {
        const object_class = classes[alias];
        if (object_class) return object_class as XUIArtifactClass;
      }
    }
  }

  return undefined;
}

function class_matches_type(candidate: unknown, type: string): boolean {
  const expected = normalize_type_id(type);
  const values = new Set<string>();

  if (typeof candidate === "function") {
    values.add(normalize_type_id(candidate.name));
    values.add(normalize_type_id((candidate as unknown as XVibeJsonObject)._id));
    values.add(normalize_type_id((candidate as unknown as XVibeJsonObject)._type));
    values.add(normalize_type_id((candidate as unknown as XVibeJsonObject)._xtype));
    values.add(normalize_type_id((candidate as unknown as XVibeJsonObject)._xui_type));
    values.add(normalize_type_id((candidate as unknown as XVibeJsonObject)._object_type));
  } else if (is_plain_object(candidate)) {
    for (const value of read_object_type_ids(candidate)) values.add(value);
    const ctor_name = typeof candidate.constructor?.name === "string"
      ? candidate.constructor.name
      : "";
    values.add(normalize_type_id(ctor_name));
  }

  return values.has(expected);
}

function find_runtime_xui_object_class(
  type: string,
  context: VibeArtifactFactoryContext,
): XUIArtifactClass | undefined {
  const queue: { value: unknown; depth: number; key?: string }[] = [
    { value: context._runtime_context, depth: 0 },
    { value: context._runtime_skills, depth: 0 },
    { value: context._selected_skills, depth: 0 },
  ];
  const seen = new WeakSet<object>();
  const expected = normalize_type_id(type);

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;

    const value = item.value;
    const key_matches = normalize_type_id(item.key) === expected;

    if (has_generate_artifact(value) && (key_matches || class_matches_type(value, type))) {
      return value;
    }

    if ((typeof value !== "object" && typeof value !== "function") || value === null || item.depth >= 5) {
      continue;
    }

    if (seen.has(value)) continue;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const child of value) {
        queue.push({ value: child, depth: item.depth + 1 });
      }
      continue;
    }

    for (const [child_key, child_value] of Object.entries(value as XVibeJsonObject)) {
      queue.push({ value: child_value, depth: item.depth + 1, key: child_key });
    }
  }

  return undefined;
}

function skill_matches_type(skill: unknown, type: string): boolean {
  const expected = normalize_type_id(type);
  return read_object_type_ids(skill).includes(expected);
}

function find_example_node(value: unknown, type: string): XVibeJsonObject | undefined {
  if (!is_plain_object(value)) return undefined;

  if (normalize_type_id(value._type) === normalize_type_id(type)) {
    return value;
  }

  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) {
        const found = find_example_node(item, type);
        if (found) return found;
      }
    } else if (is_plain_object(child)) {
      const found = find_example_node(child, type);
      if (found) return found;
    }
  }

  return undefined;
}

function read_canonical_examples(skill: unknown): unknown[] {
  if (!is_plain_object(skill)) return [];
  return [
    ...(Array.isArray(skill._canonical_examples) ? skill._canonical_examples : []),
    ...(Array.isArray(skill._examples) ? skill._examples : []),
  ];
}

function read_class_skill(object_class: XUIArtifactClass): unknown {
  if (typeof object_class.getOwnSkill === "function") {
    try {
      const skill = object_class.getOwnSkill();
      if (skill) return skill;
    } catch {
      // Ignore skill lookup failures and continue to _skill.
    }
  }

  return object_class._skill;
}

function find_class_canonical_example(
  type: string,
  object_class: XUIArtifactClass,
): XVibeJsonObject | undefined {
  const skill = read_class_skill(object_class);

  for (const example of read_canonical_examples(skill)) {
    const example_object = find_example_node(example, type);
    if (example_object) return clone_json(example_object);
  }

  return undefined;
}

function find_selected_skill_canonical_example(
  type: string,
  context: VibeArtifactFactoryContext,
): XVibeJsonObject | undefined {
  for (const skill of context._selected_skills ?? []) {
    if (!skill_matches_type(skill, type)) continue;

    for (const example of read_canonical_examples(skill)) {
      const example_object = find_example_node(example, type);
      if (example_object) return clone_json(example_object);
    }
  }

  return undefined;
}

function sanitize_canonical_artifact(value: unknown): {
  _artifact: unknown;
  _removed_keys_count: number;
} {
  if (Array.isArray(value)) {
    let removed_count = 0;
    const items = value.map((item) => {
      const sanitized = sanitize_canonical_artifact(item);
      removed_count += sanitized._removed_keys_count;
      return sanitized._artifact;
    });

    return {
      _artifact: items,
      _removed_keys_count: removed_count,
    };
  }

  if (!is_plain_object(value)) {
    return {
      _artifact: value,
      _removed_keys_count: 0,
    };
  }

  let removed_count = 0;
  const sanitized: XVibeJsonObject = {};

  for (const [key, child] of Object.entries(value)) {
    if (UNSAFE_CANONICAL_BEHAVIOR_KEYS.has(key)) {
      removed_count += 1;
      continue;
    }

    const sanitized_child = sanitize_canonical_artifact(child);
    removed_count += sanitized_child._removed_keys_count;
    sanitized[key] = sanitized_child._artifact;
  }

  return {
    _artifact: sanitized,
    _removed_keys_count: removed_count,
  };
}

function apply_basic_intent(
  type: string,
  artifact: XVibeJsonObject,
  intent: XVibeJsonObject,
): XVibeJsonObject {
  artifact._type = type;

  const passthrough_keys = [
    "_id",
    "_label",
    "_text",
    "_title",
    "_value",
    "_children",
    "_items",
    "_columns",
    "_data_source",
    "_control",
    "_flow",
    "_theme",
    "_density",
    "_layout",
    "class",
  ];

  for (const key of passthrough_keys) {
    if (intent[key] !== undefined) {
      artifact[key] = clone_json(intent[key]);
    }
  }

  if (type === "field") {
    delete artifact._name;
    delete artifact._placeholder;
  }

  if (type === "button" && intent._flow === undefined) {
    delete artifact._flow;
  }

  return artifact;
}

function record_diagnostic(
  context: VibeArtifactFactoryContext,
  source: VibeArtifactFactorySource,
  artifact: XVibeJsonObject,
  type: string,
  module?: "xui",
  sanitized = false,
  removed_keys_count = 0,
): void {
  context._diagnostics?.push({
    _type: type,
    ...(typeof artifact._id === "string" ? { _id: artifact._id } : {}),
    _source: source,
    ...(module ? { _module: module } : {}),
    _sanitized: sanitized,
    ...(removed_keys_count > 0 ? { _removed_keys_count: removed_keys_count } : {}),
  });

  if (debug_enabled()) {
    _xlog.log("[xvibe] factory generated artifact", {
      _type: type,
      ...(typeof artifact._id === "string" ? { _id: artifact._id } : {}),
      _source: source,
      ...(module ? { _module: module } : {}),
      _artifact: artifact,
    });
  }
}

export function generateXUIArtifact(
  type: string,
  intent: XVibeJsonObject,
  context: VibeArtifactFactoryContext,
): XVibeJsonObject {
  /*
    XVibe V1 server-side artifact generation:
    server code cannot reliably access client XUI object classes, so synced
    client skill examples are treated as shape templates only. Canonical
    examples are sanitized before intent overlay. A future V1.5 can compile
    the whole intent on the client over Wormhole, but V1 does not do that.
  */
  const xui_object_class = resolve_xui_object_class(type);
  if (xui_object_class && typeof xui_object_class.generateArtifact === "function") {
    const generated = xui_object_class.generateArtifact(intent, context);
    const generated_object = find_example_node(generated, type);
    const artifact = apply_basic_intent(
      type,
      generated_object
        ? clone_json(generated_object)
        : is_plain_object(generated) ? clone_json(generated) : {},
      intent,
    );
    record_diagnostic(context, "class.generateArtifact", artifact, type, "xui");
    return artifact;
  }

  if (xui_object_class) {
    const canonical = find_class_canonical_example(type, xui_object_class);
    if (canonical) {
      const sanitized = sanitize_canonical_artifact(canonical);
      const artifact = apply_basic_intent(
        type,
        is_plain_object(sanitized._artifact) ? sanitized._artifact : {},
        intent,
      );
      record_diagnostic(
        context,
        "class.canonical_example",
        artifact,
        type,
        "xui",
        true,
        sanitized._removed_keys_count,
      );
      return artifact;
    }
  }

  const canonical = find_selected_skill_canonical_example(type, context);
  if (canonical) {
    const sanitized = sanitize_canonical_artifact(canonical);
    const artifact = apply_basic_intent(
      type,
      is_plain_object(sanitized._artifact) ? sanitized._artifact : {},
      intent,
    );
    record_diagnostic(
      context,
      "selected_skill.canonical_example",
      artifact,
      type,
      undefined,
      true,
      sanitized._removed_keys_count,
    );
    return artifact;
  }

  const runtime_class = find_runtime_xui_object_class(type, context);
  if (runtime_class && typeof runtime_class.generateArtifact === "function") {
    const generated = runtime_class.generateArtifact(intent, context);
    const generated_object = find_example_node(generated, type);
    const artifact = apply_basic_intent(
      type,
      generated_object
        ? clone_json(generated_object)
        : is_plain_object(generated) ? clone_json(generated) : {},
      intent,
    );
    record_diagnostic(context, "class.generateArtifact", artifact, type);
    return artifact;
  }

  if (runtime_class) {
    const runtime_canonical = find_class_canonical_example(type, runtime_class);
    if (runtime_canonical) {
      const sanitized = sanitize_canonical_artifact(runtime_canonical);
      const artifact = apply_basic_intent(
        type,
        is_plain_object(sanitized._artifact) ? sanitized._artifact : {},
        intent,
      );
      record_diagnostic(
        context,
        "class.canonical_example",
        artifact,
        type,
        undefined,
        true,
        sanitized._removed_keys_count,
      );
      return artifact;
    }
  }

  const artifact = apply_basic_intent(
    type,
    {
      _type: type,
      ...(typeof intent._id === "string" ? { _id: intent._id } : {}),
    },
    intent,
  );
  record_diagnostic(context, "fallback", artifact, type);
  return artifact;
}
