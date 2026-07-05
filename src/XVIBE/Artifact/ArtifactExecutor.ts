import path from "node:path";
import { _x, _xlog, type XCommand } from "@xpell/core";
import { _xu } from "../../XNUtils/XUtils.js";
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
  _entity_name: string;
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

type ArtifactExecutorResult =
  | ArtifactExecutorCreateEntityResult
  | ArtifactExecutorCreateFlowResult
  | ArtifactExecutorCreateFormResult
  | ArtifactExecutorCreateTableResult
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
  "_fields",
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
        _id: `${input._view_id}-table`,
        _type: "table",
        _data_source: data_source,
        _columns: field_names.map((field_name) => ({
          _key: field_name,
          _label: title_from_id(field_name),
        })),
      },
    ],
  };
}

export class ArtifactExecutor {
  private readonly artifact_resolver: ArtifactResolver;

  constructor(artifact_resolver = new ArtifactResolver()) {
    this.artifact_resolver = artifact_resolver;
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
      artifact_type !== "table"
    ) {
      return error_result(
        "E_XVIBE_ARTIFACT_TYPE_UNSUPPORTED",
        "Only entity, flow, form, and table artifact requests are supported",
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
      if (action !== "entity-add") {
        return error_result(
          "E_XVIBE_ARTIFACT_OPERATION_UNSUPPORTED",
          "Only entity-add flow artifact requests are supported",
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
