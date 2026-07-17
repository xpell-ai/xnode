import path from "node:path";
import { _x, _xlog, type XCommand } from "@xpell/core";
import { _xu } from "@xpell/node-core";
import { ArtifactRelationshipRegistry } from "./ArtifactRelationshipRegistry.js";
import { ArtifactResolver } from "./ArtifactResolver.js";

type ArtifactExecutorErrorCode =
  | "E_XVIBE_ARTIFACT_REQUEST_INVALID"
  | "E_XVIBE_ARTIFACT_TYPE_UNSUPPORTED"
  | "E_XVIBE_ARTIFACT_OPERATION_UNSUPPORTED"
  | "E_XVIBE_ENTITY_ARTIFACT_EXISTS"
  | "E_XVIBE_ENTITY_SCHEMA_UNAVAILABLE"
  | "E_XVIBE_FLOW_ARTIFACT_EXISTS"
  | "E_XVIBE_FORM_ARTIFACT_EXISTS"
  | "E_XVIBE_TABLE_ARTIFACT_EXISTS"
  | "E_XVIBE_SERVER_XVM_ERROR"
  | "E_XVIBE_SERVER_XVM_ROOT_UNAVAILABLE";

type ArtifactExecutorError = {
  _ok: false;
  _error: {
    _code: ArtifactExecutorErrorCode;
    _message: string;
    _details?: Record<string, any>;
  };
};

type ArtifactExecutorCreateEntityResult = {
  _ok: true;
  _artifact_type: "entity";
  _operation: "create";
  _entity_name: string;
  _path: string;
};

type ArtifactExecutorCreateFlowResult = {
  _ok: true;
  _artifact_type: "flow";
  _operation: "create";
  _flow_id: string;
  _entity_name?: string;
  _xdata_key?: string;
  _already_exists?: boolean;
  _path: string;
};

type ArtifactExecutorCreateFormResult = {
  _ok: true;
  _artifact_type: "form";
  _operation: "create";
  _view_id: string;
  _entity_name: string;
  _path: string;
};

type ArtifactExecutorCreateTableResult = {
  _ok: true;
  _artifact_type: "table";
  _operation: "create";
  _view_id: string;
  _entity_name: string;
  _path: string;
};

type ArtifactExecutorCrudEvolutionAddFieldResult = {
  _ok: true;
  _operation: "add-field";
  _entity_name: string;
  _field_name: string;
  _updated: {
    _entity: boolean;
    _flow: boolean;
    _form: boolean;
    _table: boolean;
  };
};

type ArtifactExecutorCrudEvolutionRenameFieldResult = {
  _ok: true;
  _operation: "rename-field";
  _entity_name: string;
  _old_field: string;
  _new_field: string;
  _updated: {
    _entity: boolean;
    _records: boolean;
    _flow: boolean;
    _form: boolean;
    _table: boolean;
  };
};

type ArtifactExecutorCrudEvolutionDeprecateFieldResult = {
  _ok: true;
  _operation: "deprecate-field";
  _entity_name: string;
  _field_name: string;
  _updated: {
    _entity: boolean;
    _flow: boolean;
    _form: boolean;
    _table: boolean;
  };
};

type ArtifactExecutorCrudEvolutionRestoreFieldResult = {
  _ok: true;
  _operation: "restore-field";
  _entity_name: string;
  _field_name: string;
  _updated: {
    _entity: boolean;
    _flow: boolean;
    _form: boolean;
    _table: boolean;
  };
};

type ArtifactExecutorResult =
  | ArtifactExecutorCreateEntityResult
  | ArtifactExecutorCreateFlowResult
  | ArtifactExecutorCreateFormResult
  | ArtifactExecutorCreateTableResult
  | ArtifactExecutorCrudEvolutionAddFieldResult
  | ArtifactExecutorCrudEvolutionRenameFieldResult
  | ArtifactExecutorCrudEvolutionDeprecateFieldResult
  | ArtifactExecutorCrudEvolutionRestoreFieldResult
  | ArtifactExecutorError;

const TOP_LEVEL_KEYS = new Set([
  "_app_id",
  "_env",
  "_artifact_type",
  "_artifact_request",
  "_conversation_id",
  "_message_id",
]);

const XCOMMAND_METADATA_KEYS = new Set([
  "_wid",
  "_sid",
  "_req_id",
  "_metadata",
  "_from",
  "_to",
  "_auth",
]);

const ARTIFACT_REQUEST_KEYS = new Set([
  "_operation",
  "_action",
  "_flow_id",
  "_view_id",
  "_entity_name",
  "_field_name",
  "_old_field",
  "_new_field",
  "_requested_operation",
  "_fields",
  "_xdata_key",
  "_xdata_value",
]);
const FIELD_DESCRIPTOR_KEYS = new Set(["_name"]);

const RESERVED_ENTITY_FIELDS = new Set([
  "_id",
  "_created_at",
  "_updated_at",
]);

function error_result(
  code: ArtifactExecutorErrorCode,
  message: string,
  details?: Record<string, any>,
): ArtifactExecutorError {
  return {
    _ok: false,
    _error: {
      _code: code,
      _message: message,
      ...(details ? { _details: details } : {}),
    },
  };
}

function is_error_result(value: unknown): value is ArtifactExecutorError {
  return _xu.is_plain_object(value) && value._ok === false;
}

function read_required_string(
  value: unknown,
  field_name: string,
): string | ArtifactExecutorError {
  if (typeof value !== "string" || value.trim().length === 0) {
    return error_result(
      "E_XVIBE_ARTIFACT_REQUEST_INVALID",
      `${field_name} must be a non-empty string`,
    );
  }

  return value.trim();
}

function read_required_string_preserving_value(
  value: unknown,
  field_name: string,
): string | ArtifactExecutorError {
  if (typeof value !== "string" || value.length === 0) {
    return error_result(
      "E_XVIBE_ARTIFACT_REQUEST_INVALID",
      `${field_name} must be a non-empty string`,
    );
  }

  return value;
}

function validate_path_segment(
  value: string,
  field_name: string,
): ArtifactExecutorError | null {
  if (!/^[a-zA-Z0-9_-]+$/u.test(value)) {
    return error_result(
      "E_XVIBE_ARTIFACT_REQUEST_INVALID",
      `${field_name} contains unsupported path characters`,
      { [field_name]: value },
    );
  }

  return null;
}

function is_json_compatible(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }

  if (typeof value === "number") {
    return Number.isFinite(value);
  }

  if (Array.isArray(value)) {
    return value.every((item) => is_json_compatible(item));
  }

  if (_xu.is_plain_object(value)) {
    return Object.values(value).every((item) => is_json_compatible(item));
  }

  return false;
}

function validate_field_descriptor_fields(
  value: unknown,
): Record<string, any> | ArtifactExecutorError {
  if (!Array.isArray(value)) {
    return error_result(
      "E_XVIBE_ARTIFACT_REQUEST_INVALID",
      "_artifact_request._fields must be an array of field descriptors",
    );
  }

  const fields: Record<string, any> = {};
  for (const [index, field] of value.entries()) {
    if (!_xu.is_plain_object(field)) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        `_artifact_request._fields[${index}] must be an object`,
      );
    }

    for (const key of Object.keys(field)) {
      if (!FIELD_DESCRIPTOR_KEYS.has(key)) {
        return error_result(
          "E_XVIBE_ARTIFACT_REQUEST_INVALID",
          `Unsupported _artifact_request._fields[${index}] field: ${key}`,
        );
      }
    }

    const raw_field_name = read_required_string(
      field._name,
      `_artifact_request._fields[${index}]._name`,
    );
    if (typeof raw_field_name !== "string") return raw_field_name;

    if (RESERVED_ENTITY_FIELDS.has(raw_field_name.toLowerCase())) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        `Entity field '${raw_field_name}' is runtime-managed and must not be supplied`,
      );
    }

    const field_name = _xu.normalize_id(raw_field_name);
    if (!field_name) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        `_artifact_request._fields[${index}]._name must normalize to a non-empty id`,
      );
    }

    if (RESERVED_ENTITY_FIELDS.has(field_name)) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        `Entity field '${field_name}' is runtime-managed and must not be supplied`,
      );
    }

    fields[field_name] = {
      _type: "String",
    };
  }

  return fields;
}

function validate_schema_fields(
  value: unknown,
): Record<string, any> | ArtifactExecutorError {
  if (Array.isArray(value)) {
    return validate_field_descriptor_fields(value);
  }

  if (value === undefined) {
    return {};
  }

  if (!_xu.is_plain_object(value)) {
    return error_result(
      "E_XVIBE_ARTIFACT_REQUEST_INVALID",
      "_artifact_request._fields must be an object when provided",
    );
  }

  if (!is_json_compatible(value)) {
    return error_result(
      "E_XVIBE_ARTIFACT_REQUEST_INVALID",
      "_artifact_request._fields must be JSON-compatible",
    );
  }

  for (const [field_name, field] of Object.entries(value)) {
    if (RESERVED_ENTITY_FIELDS.has(field_name)) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        `Entity field '${field_name}' is runtime-managed and must not be supplied`,
      );
    }

    if (!_xu.is_plain_object(field)) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        `_artifact_request._fields.${field_name} must be an object`,
      );
    }

    if (typeof field._type !== "string" || field._type.trim().length === 0) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        `_artifact_request._fields.${field_name} requires non-empty _type`,
      );
    }
  }

  return value;
}

function server_xvm_apps_root(): string | ArtifactExecutorError {
  const get_module =
    (_x as unknown as { getModule?: (name: string) => unknown }).getModule;
  if (typeof get_module !== "function") {
    return error_result(
      "E_XVIBE_SERVER_XVM_ROOT_UNAVAILABLE",
      "server-xvm module lookup is unavailable",
    );
  }

  const server_xvm = get_module.call(_x, "server-xvm") as
    | { _apps_root?: unknown }
    | undefined;
  if (!server_xvm || typeof server_xvm._apps_root !== "string") {
    return error_result(
      "E_XVIBE_SERVER_XVM_ROOT_UNAVAILABLE",
      "server-xvm apps root is unavailable",
    );
  }

  return server_xvm._apps_root;
}

function entity_file_path(input: {
  _app_id: string;
  _env: string;
  _entity_name: string;
}): string | ArtifactExecutorError {
  const apps_root = server_xvm_apps_root();
  if (typeof apps_root !== "string") {
    return apps_root;
  }

  return path.resolve(
    apps_root,
    input._env,
    input._app_id,
    "entities",
    `${input._entity_name}.json`,
  );
}

function flow_file_path(input: {
  _app_id: string;
  _env: string;
  _flow_id: string;
}): string | ArtifactExecutorError {
  const apps_root = server_xvm_apps_root();
  if (typeof apps_root !== "string") {
    return apps_root;
  }

  return path.resolve(
    apps_root,
    input._env,
    input._app_id,
    "flows",
    `${input._flow_id}.json`,
  );
}

function view_file_path(input: {
  _app_id: string;
  _env: string;
  _view_id: string;
}): string | ArtifactExecutorError {
  const apps_root = server_xvm_apps_root();
  if (typeof apps_root !== "string") {
    return apps_root;
  }

  return path.resolve(
    apps_root,
    input._env,
    input._app_id,
    "views",
    `${input._view_id}.json`,
  );
}

async function load_entity_schema(input: {
  _app_id: string;
  _env: string;
  _entity_name: string;
  _artifact_resolver: ArtifactResolver;
}): Promise<Record<string, any> | ArtifactExecutorError> {
  const entity = await input._artifact_resolver.getEntity(
    input._app_id,
    input._env,
    input._entity_name,
  );
  if (!_xu.is_plain_object(entity) || !_xu.is_plain_object(entity._schema)) {
    return error_result(
      "E_XVIBE_ENTITY_SCHEMA_UNAVAILABLE",
      `Entity schema is unavailable: ${input._entity_name}`,
      { _entity: input._entity_name },
    );
  }

  const schema = entity._schema as Record<string, any>;
  const field_count = Object.keys(schema).filter(
    (field_name) => !RESERVED_ENTITY_FIELDS.has(field_name),
  ).length;
  _xlog.log("[xvibe] entity schema loaded", {
    _entity: input._entity_name,
    _field_count: field_count,
  });

  return schema;
}

async function load_form_entity_schema(input: {
  _app_id: string;
  _env: string;
  _entity_name: string;
  _artifact_resolver: ArtifactResolver;
}): Promise<Record<string, any> | ArtifactExecutorError> {
  const entity = await input._artifact_resolver.getEntity(
    input._app_id,
    input._env,
    input._entity_name,
  );
  if (!_xu.is_plain_object(entity) || !_xu.is_plain_object(entity._schema)) {
    return error_result(
      "E_XVIBE_ENTITY_SCHEMA_UNAVAILABLE",
      `Entity schema is unavailable: ${input._entity_name}`,
      { _entity: input._entity_name },
    );
  }

  const schema = entity._schema as Record<string, any>;
  const field_count = Object.keys(schema).filter(
    (field_name) => !RESERVED_ENTITY_FIELDS.has(field_name),
  ).length;
  _xlog.log("[xvibe] form entity schema loaded", {
    _entity: input._entity_name,
    _field_count: field_count,
  });

  return schema;
}

async function load_table_entity_schema(input: {
  _app_id: string;
  _env: string;
  _entity_name: string;
  _artifact_resolver: ArtifactResolver;
}): Promise<Record<string, any> | ArtifactExecutorError> {
  const entity = await input._artifact_resolver.getEntity(
    input._app_id,
    input._env,
    input._entity_name,
  );
  if (!_xu.is_plain_object(entity) || !_xu.is_plain_object(entity._schema)) {
    return error_result(
      "E_XVIBE_ENTITY_SCHEMA_UNAVAILABLE",
      `Entity schema is unavailable: ${input._entity_name}`,
      { _entity: input._entity_name },
    );
  }

  const schema = entity._schema as Record<string, any>;
  const field_count = Object.keys(schema).filter(
    (field_name) => !RESERVED_ENTITY_FIELDS.has(field_name),
  ).length;
  _xlog.log("[xvibe] table entity schema loaded", {
    _entity: input._entity_name,
    _field_count: field_count,
  });

  return schema;
}

function generate_entity_add_payload(
  schema: Record<string, any>,
): { _data: Record<string, string>; _mapped_fields: string[] } {
  const data: Record<string, string> = {};
  const mapped_fields: string[] = [];

  for (const field_name of Object.keys(schema)) {
    if (RESERVED_ENTITY_FIELDS.has(field_name)) {
      continue;
    }

    data[field_name] = `$event.${field_name}`;
    mapped_fields.push(field_name);
  }

  _xlog.log("[xvibe] flow payload generated", {
    _mapped_fields: mapped_fields,
  });

  return {
    _data: data,
    _mapped_fields: mapped_fields,
  };
}

function entity_schema_field_names(schema: Record<string, any>): string[] {
  return Object.keys(schema).filter(
    (field_name) => !RESERVED_ENTITY_FIELDS.has(field_name),
  );
}

function matching_create_flow_id(entity_name: string): string {
  return `create-${entity_name}`;
}

function form_field_data_output(view_id: string, field_name: string): string {
  return `form.${view_id}.${field_name}`;
}

function generate_form_flow_payload(
  view_id: string,
  field_names: string[],
): Record<string, string> {
  return Object.fromEntries(
    field_names.map((field_name) => [
      field_name,
      `$xdata.${form_field_data_output(view_id, field_name)}`,
    ]),
  );
}

function generate_form_reset_commands(
  view_id: string,
  field_names: string[],
): Record<string, any>[] {
  const source = `xvibe:form-reset:${view_id}`;

  return field_names.map((field_name) => ({
    _module: "xd",
    _op: "delete",
    _params: {
      key: form_field_data_output(view_id, field_name),
      source,
    },
  }));
}

function title_from_id(value: string): string {
  return value
    .split(/[-_\s]+/u)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function generate_form_view(input: {
  _view_id: string;
  _entity_name: string;
  _schema: Record<string, any>;
  _flow_id?: string | null;
  _success_view_id?: string | null;
}): Record<string, any> {
  const field_names = entity_schema_field_names(input._schema);
  const submit_button: Record<string, any> = {
    _id: `${input._view_id}-submit`,
    _type: "button",
    _text: "Submit",
    type: "button",
  };

  if (input._flow_id) {
    submit_button._flow = {
      _id: input._flow_id,
      _payload: generate_form_flow_payload(input._view_id, field_names),
    };
    submit_button._flow_event = "click";
  }

  const submit_metadata = input._flow_id
    ? {
        _flow: input._flow_id,
        _running: true,
        ...(input._success_view_id
          ? { _success_view: input._success_view_id }
          : {}),
      }
    : undefined;

  return {
    _id: input._view_id,
    _type: "view",
    _on_mount: generate_form_reset_commands(input._view_id, field_names),
    _children: [
      {
        _id: `${input._view_id}-style`,
        _type: "style-sheet",
        _rules: {
          ".xvibe-generated-form": {
            display: "grid",
            gap: "12px",
          },
          ".xvibe-generated-form-field": {
            display: "grid",
            gap: "4px",
          },
        },
      },
      {
        _id: `${input._view_id}-title`,
        _type: "label",
        _text: `Create ${title_from_id(input._entity_name)}`,
      },
      {
        _id: `${input._view_id}-form`,
        _type: "form",
        _class: "xvibe-generated-form",
        ...(submit_metadata ? { _submit: submit_metadata } : {}),
        _children: [
          ...field_names.map((field_name) => ({
            _id: `${input._view_id}-field-${field_name}`,
            _type: "field",
            _class: "xvibe-generated-form-field",
            _label: title_from_id(field_name),
            _field: field_name,
            _control: {
              _type: "input",
              _input_type: "text",
              _name: field_name,
              _placeholder: title_from_id(field_name),
              _data_output: form_field_data_output(input._view_id, field_name),
              _update_data_source_event: "input",
            },
          })),
          submit_button,
        ],
      },
    ],
  };
}

function generate_table_view(input: {
  _view_id: string;
  _entity_name: string;
  _schema: Record<string, any>;
}): Record<string, any> {
  const field_names = entity_schema_field_names(input._schema);
  const data_source = `${input._entity_name}.records`;
  const create_view_id = `create-${input._entity_name}`;

  return {
    _id: input._view_id,
    _type: "view",
    _on_mount: {
      _module: "entity-client",
      _op: "find",
      _params: {
        _entity: input._entity_name,
        _filter: {},
        _output: data_source,
      },
    },
    _children: [
      {
        _id: `${input._view_id}-title`,
        _type: "label",
        _text: `${title_from_id(input._entity_name)} List`,
      },
      {
        _id: `${input._view_id}-toolbar`,
        _type: "toolbar",
        _children: [
          {
            _id: `${input._view_id}-new`,
            _type: "button",
            _text: "New",
            type: "button",
            _on: {
              click: {
                _module: "xvm",
                _op: "navigate",
                _params: {
                  _to: create_view_id,
                },
              },
            },
          },
        ],
      },
      {
        _id: `${input._view_id}-table`,
        _type: "table",
        _data_source: data_source,
        _empty_text: `No ${input._entity_name} records yet.`,
        _columns: field_names.map((field_name) => ({
          _key: field_name,
          _label: title_from_id(field_name),
        })),
      },
    ],
  };
}

function clone_json<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function generated_form_field(
  view_id: string,
  field_name: string,
): Record<string, any> {
  return {
    _id: `${view_id}-field-${field_name}`,
    _type: "field",
    _class: "xvibe-generated-form-field",
    _label: title_from_id(field_name),
    _field: field_name,
    _control: {
      _type: "input",
      _input_type: "text",
      _name: field_name,
      _placeholder: title_from_id(field_name),
      _data_output: form_field_data_output(view_id, field_name),
      _update_data_source_event: "input",
    },
  };
}

function find_xui_node(
  value: unknown,
  predicate: (node: Record<string, any>) => boolean,
): Record<string, any> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = find_xui_node(item, predicate);
      if (found) return found;
    }
    return null;
  }

  if (!_xu.is_plain_object(value)) {
    return null;
  }

  const node = value as Record<string, any>;
  if (predicate(node)) {
    return node;
  }

  return find_xui_node(node._children, predicate);
}

function find_xui_node_by_id(
  value: unknown,
  id: string,
): Record<string, any> | null {
  return find_xui_node(value, (node) => node._id === id);
}

function find_xui_node_by_type(
  value: unknown,
  type: string,
): Record<string, any> | null {
  return find_xui_node(value, (node) => node._type === type);
}

function ensure_form_reset_command(
  view: Record<string, any>,
  view_id: string,
  field_name: string,
): boolean {
  const reset_command = generate_form_reset_commands(view_id, [field_name])[0];
  const reset_key = reset_command._params.key;
  const existing_on_mount = view._on_mount;

  if (!Array.isArray(existing_on_mount)) {
    view._on_mount =
      existing_on_mount === undefined
        ? [reset_command]
        : [existing_on_mount, reset_command];
    return true;
  }

  const already_resets_field = existing_on_mount.some(
    (command: unknown) =>
      _xu.is_plain_object(command) &&
      command._module === "xd" &&
      command._op === "delete" &&
      _xu.is_plain_object(command._params) &&
      command._params.key === reset_key,
  );
  if (already_resets_field) {
    return false;
  }

  existing_on_mount.push(reset_command);
  return true;
}

function ensure_form_field(
  form: Record<string, any>,
  view_id: string,
  field_name: string,
): boolean {
  const children = Array.isArray(form._children) ? form._children : [];
  form._children = children;

  const has_field = children.some(
    (child: unknown) =>
      _xu.is_plain_object(child) &&
      (child._field === field_name ||
        child._id === `${view_id}-field-${field_name}`),
  );
  if (has_field) {
    return false;
  }

  const submit_index = children.findIndex(
    (child: unknown) =>
      _xu.is_plain_object(child) &&
      (child._id === `${view_id}-submit` || child._type === "button"),
  );
  const field = generated_form_field(view_id, field_name);
  if (submit_index >= 0) {
    children.splice(submit_index, 0, field);
  } else {
    children.push(field);
  }
  return true;
}

function ensure_form_submit_payload(
  form: Record<string, any>,
  view_id: string,
  field_name: string,
): boolean {
  const children = Array.isArray(form._children) ? form._children : [];
  const submit = children.find(
    (child: unknown) =>
      _xu.is_plain_object(child) &&
      (child._id === `${view_id}-submit` || child._type === "button"),
  );
  if (!_xu.is_plain_object(submit) || !_xu.is_plain_object(submit._flow)) {
    return false;
  }

  if (!_xu.is_plain_object(submit._flow._payload)) {
    submit._flow._payload = {};
  }

  if (submit._flow._payload[field_name] !== undefined) {
    return false;
  }

  submit._flow._payload[field_name] =
    `$xdata.${form_field_data_output(view_id, field_name)}`;
  return true;
}

function ensure_table_column(
  table: Record<string, any>,
  field_name: string,
): boolean {
  const columns = Array.isArray(table._columns) ? table._columns : [];
  table._columns = columns;

  const has_column = columns.some(
    (column: unknown) =>
      _xu.is_plain_object(column) &&
      (column._key === field_name || column.key === field_name),
  );
  if (has_column) {
    return false;
  }

  columns.push({
    _key: field_name,
    _label: title_from_id(field_name),
  });
  return true;
}

function ensure_create_flow_payload(
  flow: Record<string, any>,
  entity_name: string,
  field_name: string,
): boolean {
  const steps = Array.isArray(flow._steps) ? flow._steps : [];
  for (const step of steps) {
    if (!_xu.is_plain_object(step) || !_xu.is_plain_object(step._command)) {
      continue;
    }

    const command = step._command;
    if (command._module !== "entity-manager" || command._op !== "add") {
      continue;
    }

    if (!_xu.is_plain_object(command._params)) {
      continue;
    }

    if (command._params._entity !== entity_name) {
      continue;
    }

    if (command._params._data === undefined) {
      command._params._data = {};
    }

    if (!_xu.is_plain_object(command._params._data)) {
      return false;
    }

    if (command._params._data[field_name] !== undefined) {
      return false;
    }

    command._params._data[field_name] = `$event.${field_name}`;
    return true;
  }

  return false;
}

function has_own_field(value: Record<string, any>, field_name: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, field_name);
}

function rename_reference_string(
  value: unknown,
  old_field: string,
  new_field: string,
): unknown {
  if (value === `$event.${old_field}`) {
    return `$event.${new_field}`;
  }

  if (typeof value !== "string") {
    return value;
  }

  const old_form_suffix = `.${old_field}`;
  if (value.endsWith(old_form_suffix)) {
    return `${value.slice(0, -old_field.length)}${new_field}`;
  }

  return value;
}

function rename_schema_field(
  entity: Record<string, any>,
  old_field: string,
  new_field: string,
): "updated" | "unchanged" | "missing" | "conflict" {
  const schema = entity._schema as Record<string, any>;
  for (const reserved_field of RESERVED_ENTITY_FIELDS) {
    delete schema[reserved_field];
  }

  const has_old_field = has_own_field(schema, old_field);
  const has_new_field = has_own_field(schema, new_field);
  if (!has_old_field && has_new_field) {
    return "unchanged";
  }

  if (!has_old_field) {
    return "missing";
  }

  if (has_new_field && old_field !== new_field) {
    return "conflict";
  }

  if (old_field === new_field) {
    return "unchanged";
  }

  const next_schema: Record<string, any> = {};
  for (const [field_name, field_schema] of Object.entries(schema)) {
    next_schema[field_name === old_field ? new_field : field_name] =
      field_schema;
  }

  entity._schema = next_schema;
  return "updated";
}

async function rename_entity_records(input: {
  _app_id: string;
  _env: string;
  _entity_name: string;
  _old_field: string;
  _new_field: string;
}): Promise<boolean | ArtifactExecutorError> {
  const entity_response = await _x.execute({
    _module: "entity-manager",
    _op: "get_entity",
    _params: {
      _app_id: input._app_id,
      _env: input._env,
      _entity: input._entity_name,
    },
  } as any);

  if (!entity_response?._ok) {
    return error_result(
      "E_XVIBE_SERVER_XVM_ERROR",
      "Failed to load runtime entity for record rename",
      { _error: entity_response?._result ?? entity_response?._error },
    );
  }

  const xdb_entity =
    entity_response._result?.entity ?? entity_response._result?._entity;
  if (
    typeof xdb_entity !== "object" ||
    xdb_entity === null ||
    !Array.isArray((xdb_entity as any)._data)
  ) {
    return false;
  }

  let records_updated = false;
  for (const record of (xdb_entity as any)._data) {
    if (!_xu.is_plain_object(record)) {
      continue;
    }

    if (!has_own_field(record, input._old_field)) {
      continue;
    }

    if (
      has_own_field(record, input._new_field) &&
      record[input._new_field] !== record[input._old_field]
    ) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        "Cannot rename record field because the target field already exists with a different value",
        {
          _entity_name: input._entity_name,
          _old_field: input._old_field,
          _new_field: input._new_field,
          _record_id: record._id,
        },
      );
    }

    record[input._new_field] = record[input._old_field];
    delete record[input._old_field];
    record._updated_at = new Date();
    records_updated = true;
  }

  if (!records_updated) {
    return false;
  }

  if (typeof (xdb_entity as any).indexAll === "function") {
    (xdb_entity as any).indexAll();
  }
  (xdb_entity as any)._need_save = true;
  if (typeof (xdb_entity as any).commit === "function") {
    await (xdb_entity as any).commit();
  }

  return true;
}

function rename_create_flow_payload(
  flow: Record<string, any>,
  entity_name: string,
  old_field: string,
  new_field: string,
): boolean {
  const steps = Array.isArray(flow._steps) ? flow._steps : [];
  for (const step of steps) {
    if (!_xu.is_plain_object(step) || !_xu.is_plain_object(step._command)) {
      continue;
    }

    const command = step._command;
    if (command._module !== "entity-manager" || command._op !== "add") {
      continue;
    }

    if (
      !_xu.is_plain_object(command._params) ||
      command._params._entity !== entity_name ||
      !_xu.is_plain_object(command._params._data)
    ) {
      continue;
    }

    const data = command._params._data;
    if (!has_own_field(data, old_field)) {
      return false;
    }

    const next_data: Record<string, any> = {};
    for (const [field_name, mapping] of Object.entries(data)) {
      next_data[field_name === old_field ? new_field : field_name] =
        field_name === old_field
          ? rename_reference_string(mapping, old_field, new_field)
          : mapping;
    }
    command._params._data = next_data;
    return true;
  }

  return false;
}

function rename_reset_commands(
  view: Record<string, any>,
  view_id: string,
  old_field: string,
  new_field: string,
): boolean {
  if (!Array.isArray(view._on_mount)) {
    return false;
  }

  const old_key = form_field_data_output(view_id, old_field);
  const new_key = form_field_data_output(view_id, new_field);
  let updated = false;

  for (const command of view._on_mount) {
    if (
      _xu.is_plain_object(command) &&
      command._module === "xd" &&
      command._op === "delete" &&
      _xu.is_plain_object(command._params) &&
      command._params.key === old_key
    ) {
      command._params.key = new_key;
      updated = true;
    }
  }

  return updated;
}

function rename_form_field(
  form: Record<string, any>,
  view_id: string,
  old_field: string,
  new_field: string,
): boolean {
  const children = Array.isArray(form._children) ? form._children : [];
  const field = children.find(
    (child: unknown) =>
      _xu.is_plain_object(child) &&
      (child._field === old_field ||
        child._id === `${view_id}-field-${old_field}`),
  );
  if (!_xu.is_plain_object(field)) {
    return false;
  }

  field._id = `${view_id}-field-${new_field}`;
  field._label = title_from_id(new_field);
  field._field = new_field;

  if (_xu.is_plain_object(field._control)) {
    field._control._name = new_field;
    field._control._placeholder = title_from_id(new_field);
    field._control._data_output = form_field_data_output(view_id, new_field);
  }

  return true;
}

function rename_form_submit_payload(
  form: Record<string, any>,
  view_id: string,
  old_field: string,
  new_field: string,
): boolean {
  const children = Array.isArray(form._children) ? form._children : [];
  const submit = children.find(
    (child: unknown) =>
      _xu.is_plain_object(child) &&
      (child._id === `${view_id}-submit` || child._type === "button"),
  );
  if (!_xu.is_plain_object(submit) || !_xu.is_plain_object(submit._flow)) {
    return false;
  }

  if (!_xu.is_plain_object(submit._flow._payload)) {
    return false;
  }

  const payload = submit._flow._payload;
  if (!has_own_field(payload, old_field)) {
    return false;
  }

  const next_payload: Record<string, any> = {};
  for (const [field_name, mapping] of Object.entries(payload)) {
    next_payload[field_name === old_field ? new_field : field_name] =
      field_name === old_field
        ? `$xdata.${form_field_data_output(view_id, new_field)}`
        : mapping;
  }
  submit._flow._payload = next_payload;
  return true;
}

function rename_table_column(
  table: Record<string, any>,
  old_field: string,
  new_field: string,
): boolean {
  const columns = Array.isArray(table._columns) ? table._columns : [];
  const column = columns.find(
    (item: unknown) =>
      _xu.is_plain_object(item) &&
      (item._key === old_field || item.key === old_field),
  );
  if (!_xu.is_plain_object(column)) {
    return false;
  }

  if (column._key === old_field) {
    column._key = new_field;
  }
  if (column.key === old_field) {
    column.key = new_field;
  }
  column._label = title_from_id(new_field);
  if (typeof column.title === "string") {
    column.title = title_from_id(new_field);
  }
  return true;
}

function deprecate_schema_field(
  entity: Record<string, any>,
  field_name: string,
): "updated" | "unchanged" | "missing" {
  const schema = entity._schema as Record<string, any>;
  if (!has_own_field(schema, field_name)) {
    return "missing";
  }

  const field_schema = schema[field_name];
  if (_xu.is_plain_object(field_schema)) {
    if (field_schema._deprecated === true) {
      return "unchanged";
    }

    field_schema._deprecated = true;
    return "updated";
  }

  schema[field_name] = {
    _type: "String",
    _deprecated: true,
  };
  return "updated";
}

function restore_schema_field(
  entity: Record<string, any>,
  field_name: string,
): "updated" | "unchanged" | "missing" {
  const schema = entity._schema as Record<string, any>;
  if (!has_own_field(schema, field_name)) {
    return "missing";
  }

  const field_schema = schema[field_name];
  if (!_xu.is_plain_object(field_schema)) {
    return "unchanged";
  }

  if (
    field_schema._deprecated === undefined ||
    field_schema._deprecated === false
  ) {
    return "unchanged";
  }

  delete field_schema._deprecated;
  return "updated";
}

function remove_create_flow_payload_field(
  flow: Record<string, any>,
  entity_name: string,
  field_name: string,
): boolean {
  const steps = Array.isArray(flow._steps) ? flow._steps : [];
  for (const step of steps) {
    if (!_xu.is_plain_object(step) || !_xu.is_plain_object(step._command)) {
      continue;
    }

    const command = step._command;
    if (command._module !== "entity-manager" || command._op !== "add") {
      continue;
    }

    if (
      !_xu.is_plain_object(command._params) ||
      command._params._entity !== entity_name ||
      !_xu.is_plain_object(command._params._data)
    ) {
      continue;
    }

    if (!has_own_field(command._params._data, field_name)) {
      return false;
    }

    delete command._params._data[field_name];
    return true;
  }

  return false;
}

function remove_form_field(
  form: Record<string, any>,
  view_id: string,
  field_name: string,
): boolean {
  if (!Array.isArray(form._children)) {
    return false;
  }

  const before_length = form._children.length;
  form._children = form._children.filter(
    (child: unknown) =>
      !(
        _xu.is_plain_object(child) &&
        (child._field === field_name ||
          child._id === `${view_id}-field-${field_name}`)
      ),
  );

  return form._children.length !== before_length;
}

function remove_reset_commands(
  view: Record<string, any>,
  view_id: string,
  field_name: string,
): boolean {
  if (!Array.isArray(view._on_mount)) {
    return false;
  }

  const reset_key = form_field_data_output(view_id, field_name);
  const before_length = view._on_mount.length;
  view._on_mount = view._on_mount.filter(
    (command: unknown) =>
      !(
        _xu.is_plain_object(command) &&
        command._module === "xd" &&
        command._op === "delete" &&
        _xu.is_plain_object(command._params) &&
        command._params.key === reset_key
      ),
  );

  return view._on_mount.length !== before_length;
}

function remove_form_submit_payload(
  form: Record<string, any>,
  view_id: string,
  field_name: string,
): boolean {
  const children = Array.isArray(form._children) ? form._children : [];
  const submit = children.find(
    (child: unknown) =>
      _xu.is_plain_object(child) &&
      (child._id === `${view_id}-submit` || child._type === "button"),
  );
  if (!_xu.is_plain_object(submit) || !_xu.is_plain_object(submit._flow)) {
    return false;
  }

  if (!_xu.is_plain_object(submit._flow._payload)) {
    return false;
  }

  if (!has_own_field(submit._flow._payload, field_name)) {
    return false;
  }

  delete submit._flow._payload[field_name];
  return true;
}

function remove_table_column(
  table: Record<string, any>,
  field_name: string,
): boolean {
  if (!Array.isArray(table._columns)) {
    return false;
  }

  const before_length = table._columns.length;
  table._columns = table._columns.filter(
    (column: unknown) =>
      !(
        _xu.is_plain_object(column) &&
        (column._key === field_name || column.key === field_name)
      ),
  );

  return table._columns.length !== before_length;
}

export class ArtifactExecutor {
  private readonly artifact_resolver: ArtifactResolver;
  private readonly artifact_relationship_registry: ArtifactRelationshipRegistry;

  constructor(
    artifact_resolver = new ArtifactResolver(),
    artifact_relationship_registry = new ArtifactRelationshipRegistry(),
  ) {
    this.artifact_resolver = artifact_resolver;
    this.artifact_relationship_registry = artifact_relationship_registry;
  }

  private async apply_crud_evolution_add_field(input: {
    _app_id: string;
    _env: string;
    _artifact_request: Record<string, any>;
  }): Promise<ArtifactExecutorResult> {
    const raw_entity_name = read_required_string(
      input._artifact_request._entity_name,
      "_artifact_request._entity_name",
    );
    if (typeof raw_entity_name !== "string") return raw_entity_name;
    const entity_name = _xu.normalize_id(raw_entity_name);
    if (!entity_name) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        "_artifact_request._entity_name must normalize to a non-empty id",
      );
    }

    const raw_field_name = read_required_string(
      input._artifact_request._field_name,
      "_artifact_request._field_name",
    );
    if (typeof raw_field_name !== "string") return raw_field_name;
    if (RESERVED_ENTITY_FIELDS.has(raw_field_name.toLowerCase())) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        `Entity field '${raw_field_name}' is runtime-managed and must not be supplied`,
      );
    }

    const field_name = _xu.normalize_id(raw_field_name);
    if (!field_name) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        "_artifact_request._field_name must normalize to a non-empty id",
      );
    }
    if (RESERVED_ENTITY_FIELDS.has(field_name)) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        `Entity field '${field_name}' is runtime-managed and must not be supplied`,
      );
    }

    _xlog.log("[xvibe] crud evolution add field received", {
      _app_id: input._app_id,
      _env: input._env,
      _entity_name: entity_name,
      _field_name: field_name,
    });

    const entity = await this.artifact_resolver.getEntity(
      input._app_id,
      input._env,
      entity_name,
    );
    if (!_xu.is_plain_object(entity) || !_xu.is_plain_object(entity._schema)) {
      return error_result(
        "E_XVIBE_ENTITY_SCHEMA_UNAVAILABLE",
        `Entity schema is unavailable: ${entity_name}`,
        { _entity: entity_name },
      );
    }

    const updated = {
      _entity: false,
      _flow: false,
      _form: false,
      _table: false,
    };

    for (const relationship of this.artifact_relationship_registry.lookup({
      _source: "entity-field",
      _operation: "add-field",
    })) {
      if (relationship._target === "entity") {
        const next_entity = clone_json(entity);
        for (const reserved_field of RESERVED_ENTITY_FIELDS) {
          delete next_entity._schema[reserved_field];
        }
        if (next_entity._schema[field_name] !== undefined) {
          continue;
        }

        next_entity._schema[field_name] = {
          _type: "String",
        };
        const persist_response = await _x.execute({
          _module: "server-xvm",
          _op: "set_entity",
          _params: {
            _app_id: input._app_id,
            _env: input._env,
            _entity: next_entity,
          },
        } as any);

        if (!persist_response?._ok) {
          return error_result(
            "E_XVIBE_SERVER_XVM_ERROR",
            "Failed to persist crud evolution entity update",
            { _error: persist_response?._result ?? persist_response?._error },
          );
        }

        updated._entity = true;
        _xlog.log("[xvibe] crud evolution entity updated", {
          _app_id: input._app_id,
          _env: input._env,
          _entity_name: entity_name,
          _field_name: field_name,
        });
        continue;
      }

      if (relationship._target === "flow") {
        const flow_id = matching_create_flow_id(entity_name);
        const flow = await this.artifact_resolver.getFlow(
          input._app_id,
          input._env,
          flow_id,
        );
        if (!_xu.is_plain_object(flow)) {
          continue;
        }

        const next_flow = clone_json(flow);
        if (!ensure_create_flow_payload(next_flow, entity_name, field_name)) {
          continue;
        }

        const persist_response = await _x.execute({
          _module: "server-xvm",
          _op: "set_flow",
          _params: {
            _app_id: input._app_id,
            _env: input._env,
            _flow: next_flow,
          },
        } as any);

        if (!persist_response?._ok) {
          return error_result(
            "E_XVIBE_SERVER_XVM_ERROR",
            "Failed to persist crud evolution flow update",
            { _error: persist_response?._result ?? persist_response?._error },
          );
        }

        updated._flow = true;
        _xlog.log("[xvibe] crud evolution flow updated", {
          _app_id: input._app_id,
          _env: input._env,
          _flow_id: flow_id,
          _field_name: field_name,
        });
        continue;
      }

      if (relationship._target === "form") {
        const form_view_id = `create-${entity_name}`;
        const form_view = await this.artifact_resolver.getView(
          input._app_id,
          input._env,
          form_view_id,
        );
        if (!_xu.is_plain_object(form_view)) {
          continue;
        }

        const next_form_view = clone_json(form_view);
        const form =
          find_xui_node_by_id(next_form_view, `${form_view_id}-form`) ??
          find_xui_node_by_type(next_form_view, "form");
        if (!_xu.is_plain_object(form)) {
          continue;
        }

        const form_field_updated = ensure_form_field(
          form,
          form_view_id,
          field_name,
        );
        const form_reset_updated = ensure_form_reset_command(
          next_form_view,
          form_view_id,
          field_name,
        );
        const form_submit_updated = ensure_form_submit_payload(
          form,
          form_view_id,
          field_name,
        );
        const form_updated =
          form_field_updated || form_reset_updated || form_submit_updated;
        if (!form_updated) {
          continue;
        }

        const persist_response = await _x.execute({
          _module: "server-xvm",
          _op: "push_update",
          _params: {
            _app_id: input._app_id,
            _env: input._env,
            _view: next_form_view,
          },
        } as any);

        if (!persist_response?._ok) {
          return error_result(
            "E_XVIBE_SERVER_XVM_ERROR",
            "Failed to persist crud evolution form update",
            { _error: persist_response?._result ?? persist_response?._error },
          );
        }

        updated._form = true;
        _xlog.log("[xvibe] crud evolution form updated", {
          _app_id: input._app_id,
          _env: input._env,
          _view_id: form_view_id,
          _field_name: field_name,
        });
        continue;
      }

      if (relationship._target === "table") {
        const table_view_id = `${entity_name}-list`;
        const table_view = await this.artifact_resolver.getView(
          input._app_id,
          input._env,
          table_view_id,
        );
        if (!_xu.is_plain_object(table_view)) {
          continue;
        }

        const next_table_view = clone_json(table_view);
        const table =
          find_xui_node_by_id(next_table_view, `${table_view_id}-table`) ??
          find_xui_node_by_type(next_table_view, "table");
        if (!_xu.is_plain_object(table)) {
          continue;
        }
        if (!ensure_table_column(table, field_name)) {
          continue;
        }

        const persist_response = await _x.execute({
          _module: "server-xvm",
          _op: "push_update",
          _params: {
            _app_id: input._app_id,
            _env: input._env,
            _view: next_table_view,
          },
        } as any);

        if (!persist_response?._ok) {
          return error_result(
            "E_XVIBE_SERVER_XVM_ERROR",
            "Failed to persist crud evolution table update",
            { _error: persist_response?._result ?? persist_response?._error },
          );
        }

        updated._table = true;
        _xlog.log("[xvibe] crud evolution table updated", {
          _app_id: input._app_id,
          _env: input._env,
          _view_id: table_view_id,
          _field_name: field_name,
        });
      }
    }

    return {
      _ok: true,
      _operation: "add-field",
      _entity_name: entity_name,
      _field_name: field_name,
      _updated: updated,
    };
  }

  private async apply_crud_evolution_rename_field(input: {
    _app_id: string;
    _env: string;
    _artifact_request: Record<string, any>;
  }): Promise<ArtifactExecutorResult> {
    const raw_entity_name = read_required_string(
      input._artifact_request._entity_name,
      "_artifact_request._entity_name",
    );
    if (typeof raw_entity_name !== "string") return raw_entity_name;
    const entity_name = _xu.normalize_id(raw_entity_name);
    if (!entity_name) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        "_artifact_request._entity_name must normalize to a non-empty id",
      );
    }

    const raw_old_field = read_required_string(
      input._artifact_request._old_field,
      "_artifact_request._old_field",
    );
    if (typeof raw_old_field !== "string") return raw_old_field;
    const raw_new_field = read_required_string(
      input._artifact_request._new_field,
      "_artifact_request._new_field",
    );
    if (typeof raw_new_field !== "string") return raw_new_field;

    if (
      RESERVED_ENTITY_FIELDS.has(raw_old_field.toLowerCase()) ||
      RESERVED_ENTITY_FIELDS.has(raw_new_field.toLowerCase())
    ) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        "Runtime-managed entity fields cannot be renamed",
        {
          _old_field: raw_old_field,
          _new_field: raw_new_field,
        },
      );
    }

    const old_field = _xu.normalize_id(raw_old_field);
    if (!old_field) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        "_artifact_request._old_field must normalize to a non-empty id",
      );
    }
    const new_field = _xu.normalize_id(raw_new_field);
    if (!new_field) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        "_artifact_request._new_field must normalize to a non-empty id",
      );
    }

    if (
      RESERVED_ENTITY_FIELDS.has(old_field) ||
      RESERVED_ENTITY_FIELDS.has(new_field)
    ) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        "Runtime-managed entity fields cannot be renamed",
        {
          _old_field: old_field,
          _new_field: new_field,
        },
      );
    }

    _xlog.log("[xvibe] crud evolution rename field received", {
      _app_id: input._app_id,
      _env: input._env,
      _entity_name: entity_name,
      _old_field: old_field,
      _new_field: new_field,
    });

    const entity = await this.artifact_resolver.getEntity(
      input._app_id,
      input._env,
      entity_name,
    );
    if (!_xu.is_plain_object(entity) || !_xu.is_plain_object(entity._schema)) {
      return error_result(
        "E_XVIBE_ENTITY_SCHEMA_UNAVAILABLE",
        `Entity schema is unavailable: ${entity_name}`,
        { _entity: entity_name },
      );
    }

    const updated = {
      _entity: false,
      _records: false,
      _flow: false,
      _form: false,
      _table: false,
    };

    for (const relationship of this.artifact_relationship_registry.lookup({
      _source: "entity-field",
      _operation: "rename-field",
    })) {
      if (relationship._target === "entity") {
        const next_entity = clone_json(entity);
        const schema_rename = rename_schema_field(
          next_entity,
          old_field,
          new_field,
        );
        if (schema_rename === "missing") {
          return error_result(
            "E_XVIBE_ARTIFACT_REQUEST_INVALID",
            `Entity field is unavailable: ${old_field}`,
            {
              _entity_name: entity_name,
              _old_field: old_field,
              _new_field: new_field,
            },
          );
        }
        if (schema_rename === "conflict") {
          return error_result(
            "E_XVIBE_ARTIFACT_REQUEST_INVALID",
            `Entity field already exists: ${new_field}`,
            {
              _entity_name: entity_name,
              _old_field: old_field,
              _new_field: new_field,
            },
          );
        }
        if (schema_rename !== "updated") {
          continue;
        }

        const persist_response = await _x.execute({
          _module: "server-xvm",
          _op: "set_entity",
          _params: {
            _app_id: input._app_id,
            _env: input._env,
            _entity: next_entity,
          },
        } as any);

        if (!persist_response?._ok) {
          return error_result(
            "E_XVIBE_SERVER_XVM_ERROR",
            "Failed to persist crud evolution entity rename",
            { _error: persist_response?._result ?? persist_response?._error },
          );
        }

        updated._entity = true;
        _xlog.log("[xvibe] entity field renamed", {
          _app_id: input._app_id,
          _env: input._env,
          _entity_name: entity_name,
          _old_field: old_field,
          _new_field: new_field,
        });
        continue;
      }

      if (relationship._target === "records") {
        const records_rename = await rename_entity_records({
          _app_id: input._app_id,
          _env: input._env,
          _entity_name: entity_name,
          _old_field: old_field,
          _new_field: new_field,
        });
        if (is_error_result(records_rename)) {
          return records_rename;
        }
        if (!records_rename) {
          continue;
        }

        updated._records = true;
        _xlog.log("[xvibe] entity records renamed", {
          _app_id: input._app_id,
          _env: input._env,
          _entity_name: entity_name,
          _old_field: old_field,
          _new_field: new_field,
        });
        continue;
      }

      if (relationship._target === "flow") {
        const flow_id = matching_create_flow_id(entity_name);
        const flow = await this.artifact_resolver.getFlow(
          input._app_id,
          input._env,
          flow_id,
        );
        if (!_xu.is_plain_object(flow)) {
          continue;
        }

        const next_flow = clone_json(flow);
        if (
          !rename_create_flow_payload(
            next_flow,
            entity_name,
            old_field,
            new_field,
          )
        ) {
          continue;
        }

        const persist_response = await _x.execute({
          _module: "server-xvm",
          _op: "set_flow",
          _params: {
            _app_id: input._app_id,
            _env: input._env,
            _flow: next_flow,
          },
        } as any);

        if (!persist_response?._ok) {
          return error_result(
            "E_XVIBE_SERVER_XVM_ERROR",
            "Failed to persist crud evolution flow rename",
            { _error: persist_response?._result ?? persist_response?._error },
          );
        }

        updated._flow = true;
        _xlog.log("[xvibe] flow updated", {
          _app_id: input._app_id,
          _env: input._env,
          _flow_id: flow_id,
          _old_field: old_field,
          _new_field: new_field,
        });
        continue;
      }

      if (relationship._target === "form") {
        const form_view_id = `create-${entity_name}`;
        const form_view = await this.artifact_resolver.getView(
          input._app_id,
          input._env,
          form_view_id,
        );
        if (!_xu.is_plain_object(form_view)) {
          continue;
        }

        const next_form_view = clone_json(form_view);
        const form =
          find_xui_node_by_id(next_form_view, `${form_view_id}-form`) ??
          find_xui_node_by_type(next_form_view, "form");
        if (!_xu.is_plain_object(form)) {
          continue;
        }

        const form_field_updated = rename_form_field(
          form,
          form_view_id,
          old_field,
          new_field,
        );
        const form_reset_updated = rename_reset_commands(
          next_form_view,
          form_view_id,
          old_field,
          new_field,
        );
        const form_submit_updated = rename_form_submit_payload(
          form,
          form_view_id,
          old_field,
          new_field,
        );
        const form_updated =
          form_field_updated || form_reset_updated || form_submit_updated;
        if (!form_updated) {
          continue;
        }

        const persist_response = await _x.execute({
          _module: "server-xvm",
          _op: "push_update",
          _params: {
            _app_id: input._app_id,
            _env: input._env,
            _view: next_form_view,
          },
        } as any);

        if (!persist_response?._ok) {
          return error_result(
            "E_XVIBE_SERVER_XVM_ERROR",
            "Failed to persist crud evolution form rename",
            { _error: persist_response?._result ?? persist_response?._error },
          );
        }

        updated._form = true;
        _xlog.log("[xvibe] form updated", {
          _app_id: input._app_id,
          _env: input._env,
          _view_id: form_view_id,
          _old_field: old_field,
          _new_field: new_field,
        });
        continue;
      }

      if (relationship._target === "table") {
        const table_view_id = `${entity_name}-list`;
        const table_view = await this.artifact_resolver.getView(
          input._app_id,
          input._env,
          table_view_id,
        );
        if (!_xu.is_plain_object(table_view)) {
          continue;
        }

        const next_table_view = clone_json(table_view);
        const table =
          find_xui_node_by_id(next_table_view, `${table_view_id}-table`) ??
          find_xui_node_by_type(next_table_view, "table");
        if (!_xu.is_plain_object(table)) {
          continue;
        }
        if (!rename_table_column(table, old_field, new_field)) {
          continue;
        }

        const persist_response = await _x.execute({
          _module: "server-xvm",
          _op: "push_update",
          _params: {
            _app_id: input._app_id,
            _env: input._env,
            _view: next_table_view,
          },
        } as any);

        if (!persist_response?._ok) {
          return error_result(
            "E_XVIBE_SERVER_XVM_ERROR",
            "Failed to persist crud evolution table rename",
            { _error: persist_response?._result ?? persist_response?._error },
          );
        }

        updated._table = true;
        _xlog.log("[xvibe] table updated", {
          _app_id: input._app_id,
          _env: input._env,
          _view_id: table_view_id,
          _old_field: old_field,
          _new_field: new_field,
        });
      }
    }

    return {
      _ok: true,
      _operation: "rename-field",
      _entity_name: entity_name,
      _old_field: old_field,
      _new_field: new_field,
      _updated: updated,
    };
  }

  private async apply_crud_evolution_deprecate_field(input: {
    _app_id: string;
    _env: string;
    _artifact_request: Record<string, any>;
  }): Promise<ArtifactExecutorResult> {
    const raw_entity_name = read_required_string(
      input._artifact_request._entity_name,
      "_artifact_request._entity_name",
    );
    if (typeof raw_entity_name !== "string") return raw_entity_name;
    const entity_name = _xu.normalize_id(raw_entity_name);
    if (!entity_name) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        "_artifact_request._entity_name must normalize to a non-empty id",
      );
    }

    const raw_field_name = read_required_string(
      input._artifact_request._field_name,
      "_artifact_request._field_name",
    );
    if (typeof raw_field_name !== "string") return raw_field_name;
    if (RESERVED_ENTITY_FIELDS.has(raw_field_name.toLowerCase())) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        `Entity field '${raw_field_name}' is runtime-managed and must not be supplied`,
      );
    }

    const field_name = _xu.normalize_id(raw_field_name);
    if (!field_name) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        "_artifact_request._field_name must normalize to a non-empty id",
      );
    }
    if (RESERVED_ENTITY_FIELDS.has(field_name)) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        `Entity field '${field_name}' is runtime-managed and must not be supplied`,
      );
    }

    _xlog.log("[xvibe] crud evolution deprecate field received", {
      _app_id: input._app_id,
      _env: input._env,
      _entity_name: entity_name,
      _field_name: field_name,
    });

    const entity = await this.artifact_resolver.getEntity(
      input._app_id,
      input._env,
      entity_name,
    );
    if (!_xu.is_plain_object(entity) || !_xu.is_plain_object(entity._schema)) {
      return error_result(
        "E_XVIBE_ENTITY_SCHEMA_UNAVAILABLE",
        `Entity schema is unavailable: ${entity_name}`,
        { _entity: entity_name },
      );
    }

    const updated = {
      _entity: false,
      _flow: false,
      _form: false,
      _table: false,
    };

    for (const relationship of this.artifact_relationship_registry.lookup({
      _source: "entity-field",
      _operation: "deprecate-field",
    })) {
      if (relationship._target === "entity") {
        const next_entity = clone_json(entity);
        const schema_deprecation = deprecate_schema_field(
          next_entity,
          field_name,
        );
        if (schema_deprecation === "missing") {
          return error_result(
            "E_XVIBE_ARTIFACT_REQUEST_INVALID",
            `Entity field is unavailable: ${field_name}`,
            {
              _entity_name: entity_name,
              _field_name: field_name,
            },
          );
        }
        if (schema_deprecation !== "updated") {
          continue;
        }

        const persist_response = await _x.execute({
          _module: "server-xvm",
          _op: "set_entity",
          _params: {
            _app_id: input._app_id,
            _env: input._env,
            _entity: next_entity,
          },
        } as any);

        if (!persist_response?._ok) {
          return error_result(
            "E_XVIBE_SERVER_XVM_ERROR",
            "Failed to persist crud evolution entity deprecation",
            { _error: persist_response?._result ?? persist_response?._error },
          );
        }

        updated._entity = true;
        _xlog.log("[xvibe] entity field deprecated", {
          _app_id: input._app_id,
          _env: input._env,
          _entity_name: entity_name,
          _field_name: field_name,
        });
        continue;
      }

      if (relationship._target === "flow") {
        const flow_id = matching_create_flow_id(entity_name);
        const flow = await this.artifact_resolver.getFlow(
          input._app_id,
          input._env,
          flow_id,
        );
        if (!_xu.is_plain_object(flow)) {
          continue;
        }

        const next_flow = clone_json(flow);
        if (!remove_create_flow_payload_field(next_flow, entity_name, field_name)) {
          continue;
        }

        const persist_response = await _x.execute({
          _module: "server-xvm",
          _op: "set_flow",
          _params: {
            _app_id: input._app_id,
            _env: input._env,
            _flow: next_flow,
          },
        } as any);

        if (!persist_response?._ok) {
          return error_result(
            "E_XVIBE_SERVER_XVM_ERROR",
            "Failed to persist crud evolution flow deprecation",
            { _error: persist_response?._result ?? persist_response?._error },
          );
        }

        updated._flow = true;
        _xlog.log("[xvibe] flow deprecated field removed", {
          _app_id: input._app_id,
          _env: input._env,
          _flow_id: flow_id,
          _field_name: field_name,
        });
        continue;
      }

      if (relationship._target === "form") {
        const form_view_id = `create-${entity_name}`;
        const form_view = await this.artifact_resolver.getView(
          input._app_id,
          input._env,
          form_view_id,
        );
        if (!_xu.is_plain_object(form_view)) {
          continue;
        }

        const next_form_view = clone_json(form_view);
        const form =
          find_xui_node_by_id(next_form_view, `${form_view_id}-form`) ??
          find_xui_node_by_type(next_form_view, "form");
        if (!_xu.is_plain_object(form)) {
          continue;
        }

        const form_field_updated = remove_form_field(
          form,
          form_view_id,
          field_name,
        );
        const form_reset_updated = remove_reset_commands(
          next_form_view,
          form_view_id,
          field_name,
        );
        const form_submit_updated = remove_form_submit_payload(
          form,
          form_view_id,
          field_name,
        );
        const form_updated =
          form_field_updated || form_reset_updated || form_submit_updated;
        if (!form_updated) {
          continue;
        }

        const persist_response = await _x.execute({
          _module: "server-xvm",
          _op: "push_update",
          _params: {
            _app_id: input._app_id,
            _env: input._env,
            _view: next_form_view,
          },
        } as any);

        if (!persist_response?._ok) {
          return error_result(
            "E_XVIBE_SERVER_XVM_ERROR",
            "Failed to persist crud evolution form deprecation",
            { _error: persist_response?._result ?? persist_response?._error },
          );
        }

        updated._form = true;
        _xlog.log("[xvibe] form deprecated field removed", {
          _app_id: input._app_id,
          _env: input._env,
          _view_id: form_view_id,
          _field_name: field_name,
        });
        continue;
      }

      if (relationship._target === "table") {
        const table_view_id = `${entity_name}-list`;
        const table_view = await this.artifact_resolver.getView(
          input._app_id,
          input._env,
          table_view_id,
        );
        if (!_xu.is_plain_object(table_view)) {
          continue;
        }

        const next_table_view = clone_json(table_view);
        const table =
          find_xui_node_by_id(next_table_view, `${table_view_id}-table`) ??
          find_xui_node_by_type(next_table_view, "table");
        if (!_xu.is_plain_object(table)) {
          continue;
        }
        if (!remove_table_column(table, field_name)) {
          continue;
        }

        const persist_response = await _x.execute({
          _module: "server-xvm",
          _op: "push_update",
          _params: {
            _app_id: input._app_id,
            _env: input._env,
            _view: next_table_view,
          },
        } as any);

        if (!persist_response?._ok) {
          return error_result(
            "E_XVIBE_SERVER_XVM_ERROR",
            "Failed to persist crud evolution table deprecation",
            { _error: persist_response?._result ?? persist_response?._error },
          );
        }

        updated._table = true;
        _xlog.log("[xvibe] table deprecated field removed", {
          _app_id: input._app_id,
          _env: input._env,
          _view_id: table_view_id,
          _field_name: field_name,
        });
      }
    }

    return {
      _ok: true,
      _operation: "deprecate-field",
      _entity_name: entity_name,
      _field_name: field_name,
      _updated: updated,
    };
  }

  private async apply_crud_evolution_restore_field(input: {
    _app_id: string;
    _env: string;
    _artifact_request: Record<string, any>;
  }): Promise<ArtifactExecutorResult> {
    const raw_entity_name = read_required_string(
      input._artifact_request._entity_name,
      "_artifact_request._entity_name",
    );
    if (typeof raw_entity_name !== "string") return raw_entity_name;
    const entity_name = _xu.normalize_id(raw_entity_name);
    if (!entity_name) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        "_artifact_request._entity_name must normalize to a non-empty id",
      );
    }

    const raw_field_name = read_required_string(
      input._artifact_request._field_name,
      "_artifact_request._field_name",
    );
    if (typeof raw_field_name !== "string") return raw_field_name;
    if (RESERVED_ENTITY_FIELDS.has(raw_field_name.toLowerCase())) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        `Entity field '${raw_field_name}' is runtime-managed and must not be supplied`,
      );
    }

    const field_name = _xu.normalize_id(raw_field_name);
    if (!field_name) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        "_artifact_request._field_name must normalize to a non-empty id",
      );
    }
    if (RESERVED_ENTITY_FIELDS.has(field_name)) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        `Entity field '${field_name}' is runtime-managed and must not be supplied`,
      );
    }

    _xlog.log("[xvibe] crud evolution restore field received", {
      _app_id: input._app_id,
      _env: input._env,
      _entity_name: entity_name,
      _field_name: field_name,
    });

    const entity = await this.artifact_resolver.getEntity(
      input._app_id,
      input._env,
      entity_name,
    );
    if (!_xu.is_plain_object(entity) || !_xu.is_plain_object(entity._schema)) {
      return error_result(
        "E_XVIBE_ENTITY_SCHEMA_UNAVAILABLE",
        `Entity schema is unavailable: ${entity_name}`,
        { _entity: entity_name },
      );
    }

    const updated = {
      _entity: false,
      _flow: false,
      _form: false,
      _table: false,
    };

    for (const relationship of this.artifact_relationship_registry.lookup({
      _source: "entity-field",
      _operation: "restore-field",
    })) {
      if (relationship._target === "entity") {
        const next_entity = clone_json(entity);
        const schema_restore = restore_schema_field(next_entity, field_name);
        if (schema_restore === "missing") {
          return error_result(
            "E_XVIBE_ARTIFACT_REQUEST_INVALID",
            `Entity field is unavailable: ${field_name}`,
            {
              _entity_name: entity_name,
              _field_name: field_name,
            },
          );
        }
        if (schema_restore !== "updated") {
          continue;
        }

        const persist_response = await _x.execute({
          _module: "server-xvm",
          _op: "set_entity",
          _params: {
            _app_id: input._app_id,
            _env: input._env,
            _entity: next_entity,
          },
        } as any);

        if (!persist_response?._ok) {
          return error_result(
            "E_XVIBE_SERVER_XVM_ERROR",
            "Failed to persist crud evolution entity restore",
            { _error: persist_response?._result ?? persist_response?._error },
          );
        }

        updated._entity = true;
        _xlog.log("[xvibe] entity field restored", {
          _app_id: input._app_id,
          _env: input._env,
          _entity_name: entity_name,
          _field_name: field_name,
        });
        continue;
      }

      if (relationship._target === "flow") {
        const flow_id = matching_create_flow_id(entity_name);
        const flow = await this.artifact_resolver.getFlow(
          input._app_id,
          input._env,
          flow_id,
        );
        if (!_xu.is_plain_object(flow)) {
          continue;
        }

        const next_flow = clone_json(flow);
        if (!ensure_create_flow_payload(next_flow, entity_name, field_name)) {
          continue;
        }

        const persist_response = await _x.execute({
          _module: "server-xvm",
          _op: "set_flow",
          _params: {
            _app_id: input._app_id,
            _env: input._env,
            _flow: next_flow,
          },
        } as any);

        if (!persist_response?._ok) {
          return error_result(
            "E_XVIBE_SERVER_XVM_ERROR",
            "Failed to persist crud evolution flow restore",
            { _error: persist_response?._result ?? persist_response?._error },
          );
        }

        updated._flow = true;
        _xlog.log("[xvibe] flow restored field added", {
          _app_id: input._app_id,
          _env: input._env,
          _flow_id: flow_id,
          _field_name: field_name,
        });
        continue;
      }

      if (relationship._target === "form") {
        const form_view_id = `create-${entity_name}`;
        const form_view = await this.artifact_resolver.getView(
          input._app_id,
          input._env,
          form_view_id,
        );
        if (!_xu.is_plain_object(form_view)) {
          continue;
        }

        const next_form_view = clone_json(form_view);
        const form =
          find_xui_node_by_id(next_form_view, `${form_view_id}-form`) ??
          find_xui_node_by_type(next_form_view, "form");
        if (!_xu.is_plain_object(form)) {
          continue;
        }

        const form_field_updated = ensure_form_field(
          form,
          form_view_id,
          field_name,
        );
        const form_reset_updated = ensure_form_reset_command(
          next_form_view,
          form_view_id,
          field_name,
        );
        const form_submit_updated = ensure_form_submit_payload(
          form,
          form_view_id,
          field_name,
        );
        const form_updated =
          form_field_updated || form_reset_updated || form_submit_updated;
        if (!form_updated) {
          continue;
        }

        const persist_response = await _x.execute({
          _module: "server-xvm",
          _op: "push_update",
          _params: {
            _app_id: input._app_id,
            _env: input._env,
            _view: next_form_view,
          },
        } as any);

        if (!persist_response?._ok) {
          return error_result(
            "E_XVIBE_SERVER_XVM_ERROR",
            "Failed to persist crud evolution form restore",
            { _error: persist_response?._result ?? persist_response?._error },
          );
        }

        updated._form = true;
        _xlog.log("[xvibe] form restored field added", {
          _app_id: input._app_id,
          _env: input._env,
          _view_id: form_view_id,
          _field_name: field_name,
        });
        continue;
      }

      if (relationship._target === "table") {
        const table_view_id = `${entity_name}-list`;
        const table_view = await this.artifact_resolver.getView(
          input._app_id,
          input._env,
          table_view_id,
        );
        if (!_xu.is_plain_object(table_view)) {
          continue;
        }

        const next_table_view = clone_json(table_view);
        const table =
          find_xui_node_by_id(next_table_view, `${table_view_id}-table`) ??
          find_xui_node_by_type(next_table_view, "table");
        if (!_xu.is_plain_object(table)) {
          continue;
        }
        if (!ensure_table_column(table, field_name)) {
          continue;
        }

        const persist_response = await _x.execute({
          _module: "server-xvm",
          _op: "push_update",
          _params: {
            _app_id: input._app_id,
            _env: input._env,
            _view: next_table_view,
          },
        } as any);

        if (!persist_response?._ok) {
          return error_result(
            "E_XVIBE_SERVER_XVM_ERROR",
            "Failed to persist crud evolution table restore",
            { _error: persist_response?._result ?? persist_response?._error },
          );
        }

        updated._table = true;
        _xlog.log("[xvibe] table restored field added", {
          _app_id: input._app_id,
          _env: input._env,
          _view_id: table_view_id,
          _field_name: field_name,
        });
      }
    }

    return {
      _ok: true,
      _operation: "restore-field",
      _entity_name: entity_name,
      _field_name: field_name,
      _updated: updated,
    };
  }

  async apply(xcmd: XCommand): Promise<ArtifactExecutorResult> {
    const params = _xu.is_plain_object(xcmd?._params) ? xcmd._params : {};

    _xlog.log("[xvibe] artifact request apply received", {
      _artifact_type: params._artifact_type,
    });

    for (const key of Object.keys(params)) {
      if (!TOP_LEVEL_KEYS.has(key) && !XCOMMAND_METADATA_KEYS.has(key)) {
        return error_result(
          "E_XVIBE_ARTIFACT_REQUEST_INVALID",
          `Unsupported artifact request field: ${key}`,
        );
      }
    }

    const app_id = read_required_string(params._app_id, "_app_id");
    if (typeof app_id !== "string") return app_id;
    const invalid_app_id = validate_path_segment(app_id, "_app_id");
    if (invalid_app_id) return invalid_app_id;

    const env = read_required_string(params._env, "_env");
    if (typeof env !== "string") return env;
    const invalid_env = validate_path_segment(env, "_env");
    if (invalid_env) return invalid_env;

    const artifact_type = read_required_string(
      params._artifact_type,
      "_artifact_type",
    );
    if (typeof artifact_type !== "string") return artifact_type;
    if (
      artifact_type !== "entity" &&
      artifact_type !== "flow" &&
      artifact_type !== "form" &&
      artifact_type !== "table" &&
      artifact_type !== "crud-evolution"
    ) {
      return error_result(
        "E_XVIBE_ARTIFACT_TYPE_UNSUPPORTED",
        "Only entity, flow, form, table, and crud-evolution artifact requests are supported",
        { _artifact_type: artifact_type },
      );
    }

    const artifact_request_raw = params._artifact_request;
    if (!_xu.is_plain_object(artifact_request_raw)) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        "_artifact_request must be an object",
      );
    }
    const artifact_request = artifact_request_raw as Record<string, any>;

    for (const key of Object.keys(artifact_request)) {
      if (!ARTIFACT_REQUEST_KEYS.has(key)) {
        return error_result(
          "E_XVIBE_ARTIFACT_REQUEST_INVALID",
          `Unsupported _artifact_request field: ${key}`,
        );
      }
    }

    const operation = read_required_string(
      artifact_request._operation,
      "_artifact_request._operation",
    );
    if (typeof operation !== "string") return operation;

    if (artifact_type === "crud-evolution") {
      if (
        operation !== "add-field" &&
        operation !== "rename-field" &&
        operation !== "deprecate-field" &&
        operation !== "restore-field"
      ) {
        return error_result(
          "E_XVIBE_ARTIFACT_OPERATION_UNSUPPORTED",
          "Only add-field, rename-field, deprecate-field, and restore-field crud-evolution artifact requests are supported",
          { _operation: operation },
        );
      }

      if (operation === "rename-field") {
        return this.apply_crud_evolution_rename_field({
          _app_id: app_id,
          _env: env,
          _artifact_request: artifact_request,
        });
      }

      if (operation === "deprecate-field") {
        return this.apply_crud_evolution_deprecate_field({
          _app_id: app_id,
          _env: env,
          _artifact_request: artifact_request,
        });
      }

      if (operation === "restore-field") {
        return this.apply_crud_evolution_restore_field({
          _app_id: app_id,
          _env: env,
          _artifact_request: artifact_request,
        });
      }

      return this.apply_crud_evolution_add_field({
        _app_id: app_id,
        _env: env,
        _artifact_request: artifact_request,
      });
    }

    if (operation !== "create") {
      return error_result(
        "E_XVIBE_ARTIFACT_OPERATION_UNSUPPORTED",
        `Only create ${artifact_type} artifact requests are supported`,
        { _operation: operation },
      );
    }

    if (artifact_type === "flow") {
      const action = read_required_string(
        artifact_request._action,
        "_artifact_request._action",
      );
      if (typeof action !== "string") return action;
      if (action !== "entity-add" && action !== "xdata-set") {
        return error_result(
          "E_XVIBE_ARTIFACT_OPERATION_UNSUPPORTED",
          "Only entity-add and xdata-set flow artifact requests are supported",
          { _action: action },
        );
      }

      const raw_flow_id = read_required_string(
        artifact_request._flow_id,
        "_artifact_request._flow_id",
      );
      if (typeof raw_flow_id !== "string") return raw_flow_id;
      const flow_id = _xu.normalize_id(raw_flow_id);
      if (!flow_id) {
        return error_result(
          "E_XVIBE_ARTIFACT_REQUEST_INVALID",
          "_artifact_request._flow_id must normalize to a non-empty id",
        );
      }

      let flow_exists = false;
      try {
        flow_exists = await this.artifact_resolver.flowExists(
          app_id,
          env,
          flow_id,
        );
      } catch (error) {
        return error_result(
          "E_XVIBE_SERVER_XVM_ERROR",
          "Failed to inspect existing flow artifacts",
          { _error: error instanceof Error ? error.message : String(error) },
        );
      }

      if (action === "xdata-set") {
        const raw_xdata_key = read_required_string(
          artifact_request._xdata_key,
          "_artifact_request._xdata_key",
        );
        if (typeof raw_xdata_key !== "string") return raw_xdata_key;
        const xdata_key = raw_xdata_key.trim();
        if (!xdata_key) {
          return error_result(
            "E_XVIBE_ARTIFACT_REQUEST_INVALID",
            "_artifact_request._xdata_key must be non-empty",
          );
        }

        const xdata_value = read_required_string_preserving_value(
          artifact_request._xdata_value,
          "_artifact_request._xdata_value",
        );
        if (typeof xdata_value !== "string") return xdata_value;

        const flow = {
          _id: flow_id,
          _steps: [
            {
              _id: `set-${_xu.normalize_id(xdata_key) ?? "xdata"}`,
              _command: {
                _module: "xd",
                _op: "set",
                _params: {
                  key: xdata_key,
                  value: xdata_value,
                  source: `flow:${flow_id}`,
                },
              },
            },
          ],
        };

        const file_path = flow_file_path({
          _app_id: app_id,
          _env: env,
          _flow_id: flow_id,
        });
        if (typeof file_path !== "string") {
          return file_path;
        }

        if (flow_exists) {
          const existing_flow =
            await this.artifact_resolver.getFlow(app_id, env, flow_id);
          const existing_matches =
            JSON.stringify(existing_flow) === JSON.stringify(flow);
          _xlog.log("[xvibe] flow artifact already exists", {
            _app_id: app_id,
            _env: env,
            _flow_id: flow_id,
            _path: file_path,
            _idempotent: existing_matches,
          });
          if (existing_matches) {
            return {
              _ok: true,
              _artifact_type: "flow",
              _operation: "create",
              _flow_id: flow_id,
              _xdata_key: xdata_key,
              _already_exists: true,
              _path: file_path,
            };
          }

          return error_result(
            "E_XVIBE_FLOW_ARTIFACT_EXISTS",
            `Flow artifact already exists: ${flow_id}`,
            {
              _artifact_type: "flow",
              _operation: "create",
              _flow_id: flow_id,
              _path: file_path,
            },
          );
        }

        const persist_response = await _x.execute({
          _module: "server-xvm",
          _op: "set_flow",
          _params: {
            _app_id: app_id,
            _env: env,
            _flow: flow,
          },
        } as any);

        if (!persist_response?._ok) {
          return error_result(
            "E_XVIBE_SERVER_XVM_ERROR",
            "Failed to persist flow artifact",
            { _error: persist_response?._result ?? persist_response?._error },
          );
        }

        _xlog.log("[xvibe] flow artifact created", {
          _app_id: app_id,
          _env: env,
          _flow_id: flow_id,
          _xdata_key: xdata_key,
          _path: file_path,
        });

        return {
          _ok: true,
          _artifact_type: "flow",
          _operation: "create",
          _flow_id: flow_id,
          _xdata_key: xdata_key,
          _path: file_path,
        };
      }

      const raw_entity_name = read_required_string(
        artifact_request._entity_name,
        "_artifact_request._entity_name",
      );
      if (typeof raw_entity_name !== "string") return raw_entity_name;
      const entity_name = _xu.normalize_id(raw_entity_name);
      if (!entity_name) {
        return error_result(
          "E_XVIBE_ARTIFACT_REQUEST_INVALID",
          "_artifact_request._entity_name must normalize to a non-empty id",
        );
      }

      if (flow_exists) {
        const existing_path = flow_file_path({
          _app_id: app_id,
          _env: env,
          _flow_id: flow_id,
        });
        _xlog.log("[xvibe] flow artifact already exists", {
          _app_id: app_id,
          _env: env,
          _flow_id: flow_id,
          ...(typeof existing_path === "string" ? { _path: existing_path } : {}),
        });
        return error_result(
          "E_XVIBE_FLOW_ARTIFACT_EXISTS",
          `Flow artifact already exists: ${flow_id}`,
          {
            _artifact_type: "flow",
            _operation: "create",
            _flow_id: flow_id,
            ...(typeof existing_path === "string" ? { _path: existing_path } : {}),
          },
        );
      }

      const entity_schema = await load_entity_schema({
        _app_id: app_id,
        _env: env,
        _entity_name: entity_name,
        _artifact_resolver: this.artifact_resolver,
      });
      if (is_error_result(entity_schema)) {
        return entity_schema;
      }
      const payload = generate_entity_add_payload(entity_schema);

      const flow = {
        _id: flow_id,
        _steps: [
          {
            _id: `add-${entity_name}`,
            _command: {
              _module: "entity-manager",
              _op: "add",
              _params: {
                _app_id: app_id,
                _env: env,
                _entity: entity_name,
                _data: payload._data,
              },
            },
          },
        ],
      };

      const persist_response = await _x.execute({
        _module: "server-xvm",
        _op: "set_flow",
        _params: {
          _app_id: app_id,
          _env: env,
          _flow: flow,
        },
      } as any);

      if (!persist_response?._ok) {
        return error_result(
          "E_XVIBE_SERVER_XVM_ERROR",
          "Failed to persist flow artifact",
          { _error: persist_response?._result ?? persist_response?._error },
        );
      }

      const file_path = flow_file_path({
        _app_id: app_id,
        _env: env,
        _flow_id: flow_id,
      });
      if (typeof file_path !== "string") {
        return file_path;
      }

      _xlog.log("[xvibe] flow artifact created", {
        _app_id: app_id,
        _env: env,
        _flow_id: flow_id,
        _entity_name: entity_name,
        _path: file_path,
      });

      return {
        _ok: true,
        _artifact_type: "flow",
        _operation: "create",
        _flow_id: flow_id,
        _entity_name: entity_name,
        _path: file_path,
      };
    }

    if (artifact_type === "form" || artifact_type === "table") {
      const raw_entity_name = read_required_string(
        artifact_request._entity_name,
        "_artifact_request._entity_name",
      );
      if (typeof raw_entity_name !== "string") return raw_entity_name;
      const entity_name = _xu.normalize_id(raw_entity_name);
      if (!entity_name) {
        return error_result(
          "E_XVIBE_ARTIFACT_REQUEST_INVALID",
          "_artifact_request._entity_name must normalize to a non-empty id",
        );
      }

      const raw_view_id = read_required_string(
        artifact_request._view_id,
        "_artifact_request._view_id",
      );
      if (typeof raw_view_id !== "string") return raw_view_id;
      const view_id = _xu.normalize_id(raw_view_id);
      if (!view_id) {
        return error_result(
          "E_XVIBE_ARTIFACT_REQUEST_INVALID",
          "_artifact_request._view_id must normalize to a non-empty id",
        );
      }

      let view_exists = false;
      try {
        view_exists = await this.artifact_resolver.viewExists(
          app_id,
          env,
          view_id,
        );
      } catch (error) {
        return error_result(
          "E_XVIBE_SERVER_XVM_ERROR",
          "Failed to inspect existing view artifacts",
          { _error: error instanceof Error ? error.message : String(error) },
        );
      }

      if (view_exists) {
        const existing_path = view_file_path({
          _app_id: app_id,
          _env: env,
          _view_id: view_id,
        });
        _xlog.log(`[xvibe] ${artifact_type} artifact already exists`, {
          _app_id: app_id,
          _env: env,
          _view_id: view_id,
          ...(typeof existing_path === "string" ? { _path: existing_path } : {}),
        });
        return error_result(
          artifact_type === "form"
            ? "E_XVIBE_FORM_ARTIFACT_EXISTS"
            : "E_XVIBE_TABLE_ARTIFACT_EXISTS",
          `${artifact_type === "form" ? "Form" : "Table"} artifact already exists: ${view_id}`,
          {
            _artifact_type: artifact_type,
            _operation: "create",
            _view_id: view_id,
            ...(typeof existing_path === "string" ? { _path: existing_path } : {}),
          },
        );
      }

      const entity_schema =
        artifact_type === "form"
          ? await load_form_entity_schema({
              _app_id: app_id,
              _env: env,
              _entity_name: entity_name,
              _artifact_resolver: this.artifact_resolver,
            })
          : await load_table_entity_schema({
              _app_id: app_id,
              _env: env,
              _entity_name: entity_name,
              _artifact_resolver: this.artifact_resolver,
            });
      if (is_error_result(entity_schema)) {
        return entity_schema;
      }

      let matching_flow_id: string | null = null;
      let success_view_id: string | null = null;
      if (artifact_type === "form") {
        const candidate_flow_id = matching_create_flow_id(entity_name);
        _xlog.log("[xvibe] form flow wiring detected", {
          _app_id: app_id,
          _env: env,
          _entity_name: entity_name,
          _view_id: view_id,
          _flow_id: candidate_flow_id,
        });

        try {
          const matching_flow_exists = await this.artifact_resolver.flowExists(
            app_id,
            env,
            candidate_flow_id,
          );
          if (matching_flow_exists) {
            matching_flow_id = candidate_flow_id;
            _xlog.log("[xvibe] form submit wired", {
              _app_id: app_id,
              _env: env,
              _entity_name: entity_name,
              _view_id: view_id,
              _flow_id: candidate_flow_id,
            });
          } else {
            _xlog.log("[xvibe] form submit not wired", {
              _app_id: app_id,
              _env: env,
              _entity_name: entity_name,
              _view_id: view_id,
              _flow_id: candidate_flow_id,
              _reason: "matching_flow_not_found",
            });
          }
        } catch (error) {
          _xlog.log("[xvibe] form submit not wired", {
            _app_id: app_id,
            _env: env,
            _entity_name: entity_name,
            _view_id: view_id,
            _flow_id: candidate_flow_id,
            _reason: "flow_inspection_failed",
            _error: error instanceof Error ? error.message : String(error),
          });
        }

        const candidate_success_view_id = `${entity_name}-list`;
        try {
          const success_view_exists = await this.artifact_resolver.viewExists(
            app_id,
            env,
            candidate_success_view_id,
          );
          if (success_view_exists) {
            success_view_id = candidate_success_view_id;
          }
        } catch {
          success_view_id = null;
        }
      }

      const view =
        artifact_type === "form"
          ? generate_form_view({
              _view_id: view_id,
              _entity_name: entity_name,
              _schema: entity_schema,
              _flow_id: matching_flow_id,
              _success_view_id: success_view_id,
            })
          : generate_table_view({
              _view_id: view_id,
              _entity_name: entity_name,
              _schema: entity_schema,
            });

      const persist_response = await _x.execute({
        _module: "server-xvm",
        _op: "push_update",
        _params: {
          _app_id: app_id,
          _env: env,
          _view: view,
        },
      } as any);

      if (!persist_response?._ok) {
        return error_result(
          "E_XVIBE_SERVER_XVM_ERROR",
          `Failed to persist ${artifact_type} artifact`,
          { _error: persist_response?._result ?? persist_response?._error },
        );
      }

      const file_path = view_file_path({
        _app_id: app_id,
        _env: env,
        _view_id: view_id,
      });
      if (typeof file_path !== "string") {
        return file_path;
      }

      _xlog.log(`[xvibe] ${artifact_type} artifact created`, {
        _app_id: app_id,
        _env: env,
        _view_id: view_id,
        _entity_name: entity_name,
        _path: file_path,
      });
      if (artifact_type === "table") {
        _xlog.log("[xvibe] generated table bound to entity", {
          _app_id: app_id,
          _env: env,
          _view_id: view_id,
          _entity_name: entity_name,
          _data_source: `${entity_name}.records`,
        });
      }

      return {
        _ok: true,
        _artifact_type: artifact_type,
        _operation: "create",
        _view_id: view_id,
        _entity_name: entity_name,
        _path: file_path,
      };
    }

    const raw_entity_name = read_required_string(
      artifact_request._entity_name,
      "_artifact_request._entity_name",
    );
    if (typeof raw_entity_name !== "string") return raw_entity_name;
    const entity_name = _xu.normalize_id(raw_entity_name);
    if (!entity_name) {
      return error_result(
        "E_XVIBE_ARTIFACT_REQUEST_INVALID",
        "_artifact_request._entity_name must normalize to a non-empty id",
      );
    }
    _xlog.log("[xvibe] artifact request fields", {
      _artifact_type: "entity",
      _entity_name: entity_name,
      _fields: artifact_request._fields ?? [],
    });

    const fields = validate_schema_fields(artifact_request._fields);
    if (is_error_result(fields)) {
      return fields;
    }

    let entity_exists = false;
    try {
      entity_exists = await this.artifact_resolver.entityExists(
        app_id,
        env,
        entity_name,
      );
    } catch (error) {
      return error_result(
        "E_XVIBE_SERVER_XVM_ERROR",
        "Failed to inspect existing entity artifacts",
        { _error: error instanceof Error ? error.message : String(error) },
      );
    }

    if (entity_exists) {
      const existing_path = entity_file_path({
        _app_id: app_id,
        _env: env,
        _entity_name: entity_name,
      });
      _xlog.log("[xvibe] entity artifact already exists", {
        _app_id: app_id,
        _env: env,
        _entity_name: entity_name,
        ...(typeof existing_path === "string" ? { _path: existing_path } : {}),
      });
      return error_result(
        "E_XVIBE_ENTITY_ARTIFACT_EXISTS",
        `Entity artifact already exists: ${entity_name}`,
        {
          _artifact_type: "entity",
          _operation: "create",
          _entity_name: entity_name,
          ...(typeof existing_path === "string" ? { _path: existing_path } : {}),
        },
      );
    }

    _xlog.log("[xvibe] entity artifact generated", {
      _app_id: app_id,
      _env: env,
      _entity_name: entity_name,
      _field_count: Object.keys(fields).length,
    });

    const persist_response = await _x.execute({
      _module: "server-xvm",
      _op: "set_entity",
      _params: {
        _app_id: app_id,
        _env: env,
        _entity: {
          _id: entity_name,
          _schema: fields,
        },
      },
    } as any);

    if (!persist_response?._ok) {
      return error_result(
        "E_XVIBE_SERVER_XVM_ERROR",
        "Failed to persist entity artifact",
        { _error: persist_response?._result ?? persist_response?._error },
      );
    }

    const file_path = entity_file_path({
      _app_id: app_id,
      _env: env,
      _entity_name: entity_name,
    });
    if (typeof file_path !== "string") {
      return file_path;
    }

    _xlog.log("[xvibe] entity artifact created", {
      _app_id: app_id,
      _env: env,
      _entity_name: entity_name,
      _path: file_path,
    });
    _xlog.log("[xvibe] entity persisted fields", {
      _app_id: app_id,
      _env: env,
      _entity_name: entity_name,
      _fields: Object.keys(fields),
    });

    return {
      _ok: true,
      _artifact_type: "entity",
      _operation: "create",
      _entity_name: entity_name,
      _path: file_path,
    };
  }
}
