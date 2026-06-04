import {
  type XCommand,
  XModule,
  _x,
  _xlog
} from "../index.js";

import {
  XMUTATOR_OPS,
  XMUTATOR_SKILL
} from "./XMutator.skill.js";

import type {
  XMutatorArtifactType,
  XMutatorCommandResult,
  XMutatorMutationSkeletonPayload,
  XMutatorValidateMutationPayload,
  XMutatorViewMutationPayload,
  XMutatorOperation,
  XMutatorOpType,
  XMutatorError
} from "./XMutator.types.js";

type XMutatorParams =
  Record<string, unknown>;

export type XMutatorReplaceByIdResult = {
  _changed: boolean;
  _target_found: boolean;
  _view: any;
};

export type XMutatorUpdatePropsResult =
  XMutatorReplaceByIdResult;

const XMUTATOR_SKELETON_MESSAGE =
  "XMutator skeleton validated the request but did not apply mutations yet.";

const XMutatorArtifactTypes =
  new Set<XMutatorArtifactType>([
    "view",
    "flow",
    "entity"
  ]);

const SAFE_OP_TYPES =
  new Set<XMutatorOpType>([
    "replace_by_id",
    "append_child",
    "remove_by_id",
    "update_props",
    "move_by_id"
  ]);

const STRING_OPERATION_FIELDS = [
  "_target_id",
  "_parent_id",
  "_before_id",
  "_after_id"
];

const RECORD_OPERATION_FIELDS = [
  "_child",
  "_replacement",
  "_props",
  "_meta"
];

export function clone_json(
  value: any
): any {
  if (
    value === null ||
    typeof value !== "object"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => clone_json(item));
  }

  const clone: Record<string, any> =
    {};

  for (const [key, child] of Object.entries(value)) {
    clone[key] =
      clone_json(child);
  }

  return clone;
}

export function find_by_id(
  root: any,
  target_id: string
): any | undefined {
  if (
    root === null ||
    typeof root !== "object"
  ) {
    return undefined;
  }

  if (Array.isArray(root)) {
    for (const item of root) {
      const found =
        find_by_id(item, target_id);

      if (found !== undefined) {
        return found;
      }
    }

    return undefined;
  }

  if (root._id === target_id) {
    return root;
  }

  if (!Array.isArray(root._children)) {
    return undefined;
  }

  return find_by_id(root._children, target_id);
}

export function has_id(
  root: any,
  target_id: string
): boolean {
  return find_by_id(root, target_id) !== undefined;
}

export function replace_by_id(
  root: any,
  target_id: string,
  replacement: any
): XMutatorReplaceByIdResult {
  let target_found =
    false;

  const visit = (value: any): any => {
    if (
      value === null ||
      typeof value !== "object"
    ) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => visit(item));
    }

    if (value._id === target_id) {
      target_found =
        true;

      return clone_json(replacement);
    }

    const clone: Record<string, any> =
      {};

    for (const [key, child] of Object.entries(value)) {
      clone[key] =
        key === "_children" && Array.isArray(child)
          ? child.map((item) => visit(item))
          : clone_json(child);
    }

    return clone;
  };

  const next_view =
    visit(root);

  return {
    _changed: target_found,
    _target_found: target_found,
    _view: next_view
  };
}

function json_equal(
  left: any,
  right: any
): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return Object.is(left, right);
  }
}

export function update_props(
  root: any,
  target_id: string,
  props: Record<string, any>
): XMutatorUpdatePropsResult {
  let target_found =
    false;
  let changed =
    false;

  const visit = (value: any): any => {
    if (
      value === null ||
      typeof value !== "object"
    ) {
      return value;
    }

    if (Array.isArray(value)) {
      return value.map((item) => visit(item));
    }

    if (value._id === target_id) {
      target_found =
        true;

      const clone =
        clone_json(value);

      for (const [key, prop_value] of Object.entries(props)) {
        const next_value =
          clone_json(prop_value);

        if (!json_equal(clone[key], next_value)) {
          changed =
            true;
        }

        clone[key] =
          next_value;
      }

      return clone;
    }

    const clone: Record<string, any> =
      {};

    for (const [key, child] of Object.entries(value)) {
      clone[key] =
        key === "_children" && Array.isArray(child)
          ? child.map((item) => visit(item))
          : clone_json(child);
    }

    return clone;
  };

  const next_view =
    visit(root);

  return {
    _changed: changed,
    _target_found: target_found,
    _view: next_view
  };
}

type XMutatorOpsParamResult =
  | {
      _ok: true;
      _ops: XMutatorOperation[];
    }
  | {
      _ok: false;
      _error: XMutatorError;
    };

type XMutatorOperationValidationResult =
  | {
      _ok: true;
      _operation: XMutatorOperation;
    }
  | {
      _ok: false;
      _error: XMutatorError;
    };

function is_record(
  value: unknown
): value is XMutatorParams {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function ok<T>(
  _result: T
): XMutatorCommandResult<T> {
  return {
    _ok: true,
    _result
  };
}

function fail(
  _code: string,
  _message: string,
  _details?: Record<string, unknown>
): XMutatorCommandResult<never> {
  return {
    _ok: false,
    _error: {
      _code,
      _message,
      ...(_details ? { _details } : {})
    }
  };
}

function fail_error(
  _error: XMutatorError
): XMutatorCommandResult<never> {
  return {
    _ok: false,
    _error
  };
}

function unwrap_execute_result(
  value: unknown
): XMutatorCommandResult<unknown> {
  if (!is_record(value) || typeof value._ok !== "boolean") {
    return ok(value);
  }

  if (value._ok === false) {
    return fail(
      "E_XMUTATOR_COMMAND_FAILED",
      "XMutator command execution failed.",
      {
        _command_result: value
      }
    );
  }

  return ok(
    Object.prototype.hasOwnProperty.call(value, "_result")
      ? value._result
      : value
  );
}

function read_params(
  xcmd: XCommand
) {
  return is_record(xcmd?._params)
    ? xcmd._params
    : undefined;
}

function read_string_param(
  params: XMutatorParams,
  key: string
) {
  const value =
    params[key];

  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function read_bool_param(
  params: XMutatorParams,
  key: string,
  default_value: boolean
) {
  const value =
    params[key];

  return typeof value === "boolean"
    ? value
    : default_value;
}

function validate_operation(
  op: unknown,
  index: number
): XMutatorOperationValidationResult {
  if (!is_record(op)) {
    return {
      _ok: false,
      _error: {
        _code: "E_XMUTATOR_INVALID_OPERATION",
        _message: "XMutator operation must be an object.",
        _op_index: index,
        _operation: op
      }
    };
  }

  if (op._op_type === undefined) {
    return {
      _ok: false,
      _error: {
        _code: "E_XMUTATOR_INVALID_OPERATION",
        _message: "XMutator operation requires _op_type.",
        _op_index: index,
        _operation: op
      }
    };
  }

  if (typeof op._op_type !== "string") {
    return {
      _ok: false,
      _error: {
        _code: "E_XMUTATOR_INVALID_OPERATION",
        _message: "XMutator operation requires _op_type to be a string.",
        _op_index: index,
        _operation: op
      }
    };
  }

  if (!SAFE_OP_TYPES.has(op._op_type as XMutatorOpType)) {
    return {
      _ok: false,
      _error: {
        _code: "E_XMUTATOR_UNSUPPORTED_OP",
        _message: "XMutator operation is not supported.",
        _op_index: index,
        _operation: op
      }
    };
  }

  if (
    op._op_type !== "replace_by_id" &&
    op._op_type !== "update_props"
  ) {
    return {
      _ok: false,
      _error: {
        _code: "E_XMUTATOR_UNSUPPORTED_OP",
        _message: "XMutator Phase 2 supports only replace_by_id and update_props.",
        _op_index: index,
        _operation: op
      }
    };
  }

  for (const field of STRING_OPERATION_FIELDS) {
    if (
      Object.prototype.hasOwnProperty.call(op, field) &&
      typeof op[field] !== "string"
    ) {
      return {
        _ok: false,
        _error: {
          _code: "E_XMUTATOR_INVALID_OPERATION",
          _message: `XMutator operation field ${field} must be a string when present.`,
          _op_index: index,
          _operation: op
        }
      };
    }
  }

  for (const field of RECORD_OPERATION_FIELDS) {
    if (
      Object.prototype.hasOwnProperty.call(op, field) &&
      !is_record(op[field])
    ) {
      return {
        _ok: false,
        _error: {
          _code: "E_XMUTATOR_INVALID_OPERATION",
          _message: `XMutator operation field ${field} must be an object when present.`,
          _op_index: index,
          _operation: op
        }
      };
    }
  }

  if (
    Object.prototype.hasOwnProperty.call(op, "_index") &&
    (
      typeof op._index !== "number" ||
      !Number.isInteger(op._index)
    )
  ) {
    return {
      _ok: false,
      _error: {
        _code: "E_XMUTATOR_INVALID_OPERATION",
        _message: "XMutator operation field _index must be an integer when present.",
        _op_index: index,
        _operation: op
      }
    };
  }

  if (
    typeof op._target_id !== "string" ||
    op._target_id.trim().length === 0
  ) {
    return {
      _ok: false,
      _error: {
        _code: "E_XMUTATOR_INVALID_OPERATION",
        _message: "XMutator replace_by_id requires _target_id.",
        _op_index: index,
        _operation: op
      }
    };
  }

  if (op._op_type === "replace_by_id") {
    if (!is_record(op._replacement)) {
      return {
        _ok: false,
        _error: {
          _code: "E_XMUTATOR_INVALID_OPERATION",
          _message: "XMutator replace_by_id requires _replacement.",
          _op_index: index,
          _operation: op
        }
      };
    }

    if (op._replacement._id !== op._target_id) {
      return {
        _ok: false,
        _error: {
          _code: "E_XMUTATOR_INVALID_OPERATION",
          _message: "XMutator replace_by_id requires _replacement._id to equal _target_id.",
          _op_index: index,
          _operation: op
        }
      };
    }
  }

  if (op._op_type === "update_props") {
    if (!is_record(op._props)) {
      return {
        _ok: false,
        _error: {
          _code: "E_XMUTATOR_INVALID_OPERATION",
          _message: "XMutator update_props requires _props.",
          _op_index: index,
          _operation: op
        }
      };
    }

    if (Object.keys(op._props).length === 0) {
      return {
        _ok: false,
        _error: {
          _code: "E_XMUTATOR_INVALID_OPERATION",
          _message: "XMutator update_props requires non-empty _props.",
          _op_index: index,
          _operation: op
        }
      };
    }

    if (
      Object.prototype.hasOwnProperty.call(op._props, "_id") &&
      op._props._id !== op._target_id
    ) {
      return {
        _ok: false,
        _error: {
          _code: "E_XMUTATOR_INVALID_OPERATION",
          _message: "XMutator update_props must not change _id to a different value.",
          _op_index: index,
          _operation: op
        }
      };
    }
  }

  return {
    _ok: true,
    _operation: op as XMutatorOperation
  };
}

function read_ops_param(
  params: XMutatorParams
): XMutatorOpsParamResult | undefined {
  const ops =
    params._ops;

  if (!Array.isArray(ops)) {
    return undefined;
  }

  if (ops.length === 0) {
    return {
      _ok: false,
      _error: {
        _code: "E_XMUTATOR_INVALID_OPERATION",
        _message: "XMutator requires _ops to contain at least one operation."
      }
    };
  }

  const out: XMutatorOperation[] =
    [];

  for (let index = 0; index < ops.length; index++) {
    const op =
      ops[index];

    const validation =
      validate_operation(op, index);

    if (validation._ok === false) {
      return validation;
    }

    out.push(validation._operation);
  }

  return {
    _ok: true,
    _ops: out
  };
}

export class XMutatorModule extends XModule {
  static _name =
    "xmutator";

  static _skill =
    XMUTATOR_SKILL;

  static _ops =
    XMUTATOR_OPS;

  constructor() {
    super({
      _name: XMutatorModule._name
    });
  }

  override async onLoad() {
    _xlog.log("[xmutator] loaded");
  }

  _validate_mutation(
    xcmd: XCommand
  ): XMutatorCommandResult<XMutatorValidateMutationPayload> {
    _xlog.log("[xmutator] validate mutation");

    const params =
      read_params(xcmd);

    if (!params) {
      return fail(
        "E_XMUTATOR_INVALID_PARAMS",
        "XMutator validate-mutation requires object params."
      );
    }

    const artifact_type =
      read_string_param(params, "_artifact_type");

    if (
      !artifact_type ||
      !XMutatorArtifactTypes.has(artifact_type as XMutatorArtifactType)
    ) {
      return fail(
        "E_XMUTATOR_INVALID_ARTIFACT_TYPE",
        "XMutator validate-mutation requires _artifact_type to be view, flow, or entity.",
        {
          _field: "_artifact_type"
        }
      );
    }

    const valid_artifact_type =
      artifact_type as XMutatorArtifactType;

    const artifact_id =
      read_string_param(params, "_artifact_id");

    if (!artifact_id) {
      return fail(
        "E_XMUTATOR_MISSING_ARTIFACT_ID",
        "XMutator validate-mutation requires _artifact_id.",
        {
          _field: "_artifact_id"
        }
      );
    }

    const ops =
      read_ops_param(params);

    if (!ops) {
      return fail(
        "E_XMUTATOR_INVALID_OPS",
        "XMutator validate-mutation requires _ops to be an array.",
        {
          _field: "_ops"
        }
      );
    }

    if (ops._ok === false) {
      return fail_error(ops._error);
    }

    return ok({
      _implemented: false,
      _artifact_type: valid_artifact_type,
      _artifact_id: artifact_id,
      _ops_count: ops._ops.length,
      _dry_run: read_bool_param(params, "_dry_run", true),
      _message: XMUTATOR_SKELETON_MESSAGE
    });
  }

  async _mutate_view(
    xcmd: XCommand
  ): Promise<XMutatorCommandResult<XMutatorViewMutationPayload>> {
    _xlog.log("[xmutator] mutate view requested");

    const params =
      read_params(xcmd);

    if (!params) {
      return fail(
        "E_XMUTATOR_INVALID_PARAMS",
        "XMutator mutate-view requires object params."
      );
    }

    const app_id =
      read_string_param(params, "_app_id");
    const view_id =
      read_string_param(params, "_view_id");
    const env =
      read_string_param(params, "_env") ?? "default";

    if (!app_id) {
      return fail(
        "E_XMUTATOR_MISSING_APP_ID",
        "XMutator mutate-view requires _app_id.",
        {
          _field: "_app_id"
        }
      );
    }

    if (!view_id) {
      return fail(
        "E_XMUTATOR_MISSING_VIEW_ID",
        "XMutator mutate-view requires _view_id.",
        {
          _field: "_view_id"
        }
      );
    }

    const ops =
      read_ops_param(params);

    if (!ops) {
      return fail(
        "E_XMUTATOR_INVALID_OPS",
        "XMutator mutate-view requires _ops to be an array.",
        {
          _field: "_ops"
        }
      );
    }

    if (ops._ok === false) {
      return fail_error(ops._error);
    }

    const dry_run =
      read_bool_param(params, "_dry_run", true);

    let loaded_view: any;

    try {
      const load_response =
        unwrap_execute_result(
          await _x.execute({
            _module: "server-xvm",
            _op: "get_view",
            _params: {
              _app_id: app_id,
              _env: env,
              _view_id: view_id
            }
          } as any)
        );

      if (load_response._ok === false) {
        return load_response;
      }

      const load_result =
        load_response._result;

      if (!is_record(load_result) || !is_record(load_result._view)) {
        return fail(
          "E_XMUTATOR_INVALID_VIEW_RESPONSE",
          "XMutator expected server-xvm.get_view to return _result._view."
        );
      }

      loaded_view =
        load_result._view;
    } catch (error) {
      return fail(
        "E_XMUTATOR_LOAD_VIEW_FAILED",
        "XMutator failed to load current view.",
        {
          _error: error instanceof Error
            ? error.message
            : String(error)
        }
      );
    }

    let next_view =
      clone_json(loaded_view);
    let changed =
      false;

    for (const op of ops._ops) {
      const result =
        op._op_type === "update_props"
          ? update_props(
              next_view,
              op._target_id as string,
              op._props as Record<string, any>
            )
          : replace_by_id(
              next_view,
              op._target_id as string,
              op._replacement
            );

      _xlog.log(
        op._op_type === "update_props"
          ? "[xmutator] update_props"
          : "[xmutator] replace_by_id"
      );

      if (result._target_found) {
        _xlog.log("[xmutator] target_found");
      } else {
        _xlog.log("[xmutator] target_missing");
      }

      changed =
        changed || result._changed;
      next_view =
        result._view;
    }

    if (dry_run) {
      _xlog.log("[xmutator] dry_run complete");

      return ok({
        _implemented: true,
        _artifact_type: "view",
        _app_id: app_id,
        _env: env,
        _view_id: view_id,
        _ops_count: ops._ops.length,
        _changed: changed,
        _dry_run: dry_run,
        _view: next_view
      });
    }

    try {
      const persist_response =
        unwrap_execute_result(
          await _x.execute({
            _module: "server-xvm",
            _op: "push_update",
            _params: {
              _app_id: app_id,
              _env: env,
              _view: next_view
            }
          } as any)
        );

      if (persist_response._ok === false) {
        return persist_response;
      }
    } catch (error) {
      return fail(
        "E_XMUTATOR_PERSIST_VIEW_FAILED",
        "XMutator failed to persist mutated view.",
        {
          _error: error instanceof Error
            ? error.message
            : String(error)
        }
      );
    }

    _xlog.log("[xmutator] view persisted");

    return ok({
      _implemented: true,
      _artifact_type: "view",
      _app_id: app_id,
      _env: env,
      _view_id: view_id,
      _ops_count: ops._ops.length,
      _changed: changed,
      _dry_run: dry_run,
      _view: next_view
    });
  }

  _mutate_flow(
    xcmd: XCommand
  ): XMutatorCommandResult<XMutatorMutationSkeletonPayload> {
    _xlog.log("[xmutator] mutate flow requested");

    const params =
      read_params(xcmd);

    if (!params) {
      return fail(
        "E_XMUTATOR_INVALID_PARAMS",
        "XMutator mutate-flow requires object params."
      );
    }

    const app_id =
      read_string_param(params, "_app_id");
    const flow_id =
      read_string_param(params, "_flow_id");
    const env =
      read_string_param(params, "_env") ?? "default";

    if (!app_id) {
      return fail(
        "E_XMUTATOR_MISSING_APP_ID",
        "XMutator mutate-flow requires _app_id.",
        {
          _field: "_app_id"
        }
      );
    }

    if (!flow_id) {
      return fail(
        "E_XMUTATOR_MISSING_FLOW_ID",
        "XMutator mutate-flow requires _flow_id.",
        {
          _field: "_flow_id"
        }
      );
    }

    const ops =
      read_ops_param(params);

    if (!ops) {
      return fail(
        "E_XMUTATOR_INVALID_OPS",
        "XMutator mutate-flow requires _ops to be an array.",
        {
          _field: "_ops"
        }
      );
    }

    if (ops._ok === false) {
      return fail_error(ops._error);
    }

    return ok({
      _implemented: false,
      _artifact_type: "flow",
      _app_id: app_id,
      _env: env,
      _flow_id: flow_id,
      _ops_count: ops._ops.length,
      _dry_run: read_bool_param(params, "_dry_run", true),
      _message: XMUTATOR_SKELETON_MESSAGE
    });
  }

  _mutate_entity(
    xcmd: XCommand
  ): XMutatorCommandResult<XMutatorMutationSkeletonPayload> {
    _xlog.log("[xmutator] mutate entity requested");

    const params =
      read_params(xcmd);

    if (!params) {
      return fail(
        "E_XMUTATOR_INVALID_PARAMS",
        "XMutator mutate-entity requires object params."
      );
    }

    const app_id =
      read_string_param(params, "_app_id");
    const entity_id =
      read_string_param(params, "_entity_id");
    const env =
      read_string_param(params, "_env") ?? "default";

    if (!app_id) {
      return fail(
        "E_XMUTATOR_MISSING_APP_ID",
        "XMutator mutate-entity requires _app_id.",
        {
          _field: "_app_id"
        }
      );
    }

    if (!entity_id) {
      return fail(
        "E_XMUTATOR_MISSING_ENTITY_ID",
        "XMutator mutate-entity requires _entity_id.",
        {
          _field: "_entity_id"
        }
      );
    }

    const ops =
      read_ops_param(params);

    if (!ops) {
      return fail(
        "E_XMUTATOR_INVALID_OPS",
        "XMutator mutate-entity requires _ops to be an array.",
        {
          _field: "_ops"
        }
      );
    }

    if (ops._ok === false) {
      return fail_error(ops._error);
    }

    return ok({
      _implemented: false,
      _artifact_type: "entity",
      _app_id: app_id,
      _env: env,
      _entity_id: entity_id,
      _ops_count: ops._ops.length,
      _dry_run: read_bool_param(params, "_dry_run", true),
      _message: XMUTATOR_SKELETON_MESSAGE
    });
  }
}
