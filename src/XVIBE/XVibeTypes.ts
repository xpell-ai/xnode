export type VibeSelectionArtifactType = "view" | "flow" | "entity" | "command";

export type VibeArtifactType = "view" | "flow" | "entity" | "command";
export type VibeRequestedArtifactType = VibeArtifactType | "auto";
export type XVibeInferredArtifactType = VibeArtifactType | "module";

export type XVibeArtifactIntentAction =
  | "create"
  | "update"
  | "delete"
  | "disable"
  | "archive"
  | "rename"
  | "inspect"
  | "unknown";

export type XVibeArtifactIntentTarget =
  | "view"
  | "flow"
  | "entity"
  | "module"
  | "app"
  | "unknown";

export type XVibeArtifactIntent = {
  _action: XVibeArtifactIntentAction;
  _target: XVibeArtifactIntentTarget;
  _target_id?: string;
  _forbidden_targets: XVibeArtifactIntentTarget[];
  _confidence: number;
  _reason: string;
};

export type XVibeArtifactAction =
  | "create"
  | "update"
  | "delete"
  | "disable"
  | "archive"
  | "rename";

export type XVibeArtifactActionPlan = {
  _artifact_type:
    | "view"
    | "flow"
    | "entity"
    | "module";
  _action: XVibeArtifactAction;
  _target_id?: string;
  _new_id?: string;
  _requires_confirmation?: boolean;
  _reason?: string;
};

export type XVibeArtifactExecutionPlan = {
  _primary_artifact_type: string;
  _artifacts: Array<{
    _artifact_type: string;
    _action: "create" | "update" | "delete" | "disable" | "archive";
    _artifact_id?: string;
    _depends_on?: string[];
  }>;
};

export type XVibeInferredArtifactPlan = {
  _primary_artifact_type: XVibeInferredArtifactType;
  _artifact_types: XVibeInferredArtifactType[];
  _flow_ids?: string[];
  _entity_ids?: string[];
  _module_names?: string[];
  _intent?: XVibeArtifactIntent;
  _execution_plan?: XVibeArtifactExecutionPlan;
  _reason?: string;
};

export type XVibeIntentIREntity = {
  _id: string;
  _fields: string[];
};

export type XVibeIntentIRAction = {
  _id: string;
  _type: string;
  _label: string;
  _entity?: string;
  _op?: string;
  _target_region?: string;
};

export type XVibeIntentIRBinding = {
  _target: string;
  _source: string;
};

export type XVibeIntentIRStyle = {
  _theme?: string;
  _density?: string;
  _layout?: string;
};

export type XVibeIntentIR = {
  _ir_version: 1;
  _intent_type: string;
  _artifact_types: string[];
  _entities: XVibeIntentIREntity[];
  _regions: string[];
  _objects: string[];
  _actions: XVibeIntentIRAction[];
  _bindings: XVibeIntentIRBinding[];
  _modules: string[];
  _style: XVibeIntentIRStyle;
};

export type VibeCapabilityNodeKind =
  | "xui-object"
  | "module"
  | "entity"
  | "flow"
  | "rule"
  | "example";

export type VibeCapabilityNode = {
  _id: string;
  _key: string;
  _kind: VibeCapabilityNodeKind;
  _sources: string[];
  _keywords: string[];
  _requires: string[];
  _capabilities: string[];
  _exports?: object;
  _rules?: string[];
  _examples?: unknown[];
  _anti_patterns?: unknown[];
};

export  { type VibeKnowledgeSelection, type VibeSkillDocument } from "./VibeKnowledgeSelector";
