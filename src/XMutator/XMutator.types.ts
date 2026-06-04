export type XMutatorModuleOptions = Record<string, never>;

export type XMutatorArtifactType =
  | "view"
  | "flow"
  | "entity";

export type XMutatorOpType =
  | "replace_by_id"
  | "append_child"
  | "remove_by_id"
  | "update_props"
  | "move_by_id";

export type XMutatorSupportedViewOpType =
  | "replace_by_id"
  | "update_props";

export type XMutatorOperation = {
  _op_type: XMutatorOpType;
  _target_id?: string;
  _parent_id?: string;
  _child?: Record<string, unknown>;
  _replacement?: Record<string, unknown>;
  _props?: Record<string, unknown>;
  _index?: number;
  _before_id?: string;
  _after_id?: string;
  _meta?: Record<string, unknown>;
};

export type XMutatorPlan = {
  _artifact_type: XMutatorArtifactType;
  _artifact_id?: string;
  _ops: XMutatorOperation[];
  _meta?: Record<string, unknown>;
};

export type XMutatorError = {
  _code: string;
  _message: string;
  _op_index?: number;
  _operation?: unknown;
  _details?: Record<string, unknown>;
};

export type XMutatorValidateMutationPayload = {
  _implemented: false;
  _artifact_type: XMutatorArtifactType;
  _artifact_id: string;
  _ops_count: number;
  _dry_run: boolean;
  _message: string;
};

export type XMutatorMutationSkeletonPayload = {
  _implemented: false;
  _artifact_type: XMutatorArtifactType;
  _app_id: string;
  _env: string;
  _view_id?: string;
  _flow_id?: string;
  _entity_id?: string;
  _ops_count: number;
  _dry_run: boolean;
  _message: string;
};

export type XMutatorViewMutationPayload = {
  _implemented: true;
  _artifact_type: "view";
  _app_id: string;
  _env: string;
  _view_id: string;
  _ops_count: number;
  _changed: boolean;
  _dry_run: boolean;
  _view: unknown;
};

export type XMutatorCommandResult<T> =
  | {
      _ok: true;
      _result: T;
    }
  | {
      _ok: false;
      _error: XMutatorError;
    };

export type XMutatorResult =
  XMutatorCommandResult<
    | XMutatorValidateMutationPayload
    | XMutatorViewMutationPayload
    | XMutatorMutationSkeletonPayload
  >;
