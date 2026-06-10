export type XStudioViewData = Record<string, unknown>;

export type XStudioErrorData = {
  _code: string;
  _message: string;
  _details?: Record<string, unknown>;
};

export type XStudioErrorResult = {
  _ok: false;
  _error: XStudioErrorData;
};

export type XStudioGenerateViewParams = {
  _app_id: string;
  _env?: string;
  _view_id: string;
  _prompt: string;
};

export type XStudioArtifactType =
  | "view"
  | "entity"
  | "flow"
  | "module"
  | "auto";

export type XStudioGenerateArtifactParams = {
  _prompt: string;
  _app_id: string;
  _env?: string;
  _artifact_type: XStudioArtifactType;
};

export type XStudioGenerateViewMeta = {
  _mode: "deterministic_stub";
  _changed: false;
  _reason: string;
  _prompt: string;
};

export type XStudioGenerateViewSuccess = {
  _ok: true;
  _app_id: string;
  _env: string;
  _view_id: string;
  _version: number;
  _current_view: XStudioViewData;
  _preview_view: XStudioViewData;
  _meta: XStudioGenerateViewMeta;
};

export type XStudioGenerateViewResult =
  | XStudioGenerateViewSuccess
  | XStudioErrorResult;

export type XStudioApplyViewParams = {
  _app_id: string;
  _env?: string;
  _view_id: string;
  _view: XStudioViewData;
};

export type XStudioApplyViewSuccess = {
  _ok: true;
  _app_id: string;
  _env: string;
  _view_id: string;
  _version: number;
  _notified_subscribers: string[];
};

export type XStudioApplyViewResult = XStudioApplyViewSuccess | XStudioErrorResult;
