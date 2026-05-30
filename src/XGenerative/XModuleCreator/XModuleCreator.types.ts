export type XGeneratedModuleTarget =
  | "server"
  | "client"
  | "shared";

export type XGeneratedModulePermission = {
  _type:
    | "filesystem"
    | "network"
    | "package";
  _scope?: string;
  _mode?: string;
};

export type XGeneratedModuleImport = {
  _from: string;
  _symbols?: string[];
  _default?: string;
  _type_only?: boolean;
};

export type XGeneratedModuleOpSpec = {
  _name: string;
  _description: string;
  _params?: Record<string, unknown>;
  _result?: Record<string, unknown>;
};

export type XGeneratedModuleSpec = {
  _id: string;
  _name: string;
  _target: XGeneratedModuleTarget;
  _description?: string;
  _version?: string;
  _imports?: XGeneratedModuleImport[];
  _permissions?: XGeneratedModulePermission[];
  _ops: XGeneratedModuleOpSpec[];
  _meta?: Record<string, unknown>;
};

export type XModuleCreatorCreateSpecParams = {
  _spec: XGeneratedModuleSpec;
};

export type XModuleCreatorValidateSpecParams = {
  _spec: XGeneratedModuleSpec;
};

export type XModuleCreatorModuleOptions = {
  _work_folder?: string;
};

export type XModuleCreatorError = {
  _code: string;
  _message: string;
  _details?: Record<string, unknown>;
};

export type XModuleCreatorFailure = {
  _ok: false;
  _error: XModuleCreatorError;
};

export type XModuleCreatorOk<T extends Record<string, unknown> = Record<string, unknown>> =
  {
    _ok: true;
  } & T;

export type XModuleCreatorResult<T extends Record<string, unknown> = Record<string, unknown>> =
  | XModuleCreatorOk<T>
  | XModuleCreatorFailure;

export type XModuleCreatorValidationResult =
  XModuleCreatorResult<{
    _valid: boolean;
    _errors: XModuleCreatorError[];
  }>;

export type XModuleCreatorCreateSpecResult =
  XModuleCreatorResult<{
    _spec: XGeneratedModuleSpec;
    _artifact_path: string;
    _saved: boolean;
    _module_file: string;
    _generated: boolean;
  }>;

export type XModuleCreatorGenerateJsResult =
  XModuleCreatorResult<{
    _spec: XGeneratedModuleSpec;
    _artifact_path: string;
    _module_file: string;
    _generated: boolean;
  }>;

export type XModuleCreatorGeneratedModuleChecks = {
  _manifest_exists: boolean;
  _module_exists: boolean;
  _generated_metadata_valid: boolean;
  _manifest_hash_valid: boolean;
  _imports_valid: boolean;
  _class_name_valid: boolean;
  _extends_xmodule: boolean;
  _module_name_valid: boolean;
  _ops_match: boolean;
  _skill_exists: boolean;
  _skill_valid: boolean;
  _public_methods_valid: boolean;
  _forbidden_content: boolean;
};

export type XModuleCreatorValidateGeneratedModuleResult =
  XModuleCreatorResult<{
    _valid: boolean;
    _artifact_path: string;
    _module_file: string;
    _checks: XModuleCreatorGeneratedModuleChecks;
    _errors: XModuleCreatorError[];
  }>;

export type XModuleCreatorLoadGeneratedModuleResult =
  XModuleCreatorResult<{
    _id: string;
    _name: string;
    _artifact_path: string;
    _module_file: string;
    _loaded: true;
    _reloaded: boolean;
    _skills_available: boolean;
  }>;

export type XModuleCreatorListSpecsResult =
  XModuleCreatorResult<{
    _specs: XGeneratedModuleSpec[];
    _artifact_root: string;
    _storage_enabled: boolean;
  }>;

export type XModuleCreatorGetSpecResult =
  XModuleCreatorResult<{
    _spec: XGeneratedModuleSpec;
    _artifact_path: string;
  }>;
