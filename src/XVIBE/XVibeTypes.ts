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

export type XVibeResolvedTaskAction =
  | "create"
  | "update"
  | "delete"
  | "disable"
  | "archive"
  | "rename"
  | "inspect"
  | "unknown";

export type XVibeResolvedTaskArtifactType =
  | "view"
  | "flow"
  | "entity"
  | "module"
  | "command"
  | "app"
  | "unknown";

export type XVibeResolvedTask = {
  _action: XVibeResolvedTaskAction;
  _artifact_type: XVibeResolvedTaskArtifactType;
  _target_id?: string;
  _edit_action?: "remove" | "hide" | "show" | "update" | "add-class" | "remove-class" | "replace-class" | "toggle-class" | "set-style" | "remove-style" | "set-style-class-rule" | "remove-style-class-rule" | "set-property" | "remove-property" | "move-object";
  _edit_target_id?: string;
  _edit_target_text?: string;
  _edit_target_type?: string;
  _edit_move_position?: "before" | "after" | "top" | "bottom";
  _edit_anchor_id?: string;
  _edit_anchor_text?: string;
  _edit_anchor_type?: string;
  _edit_replacement_text?: string;
  _edit_class_name?: string;
  _edit_old_class_name?: string;
  _edit_new_class_name?: string;
  _edit_style_property?: string;
  _edit_style_value?: string;
  _edit_property_name?: string;
  _edit_property_value?: string | number | boolean | null;
  _edit_field?: string;
  _explicit_artifact_type: boolean;
  _explicit_target_id: boolean;
  _module_name?: string;
  _module_ops: string[];
  _source: string;
  _confidence: number;
  _warnings: string[];
};

export type XVibeRuntimeAssetRef = {
  _id: string;
};

export type XVibeRuntimeAssets = {
  _views: XVibeRuntimeAssetRef[];
  _flows: XVibeRuntimeAssetRef[];
  _entities: XVibeRuntimeAssetRef[];
  _modules: XVibeRuntimeAssetRef[];
};

export type XVibeRuntimePlan = {
  _existing_views: string[];
  _existing_flows: string[];
  _existing_entities: string[];
  _existing_modules: string[];
  _allowed_xui_types: string[];
  _allowed_modules: string[];
  _allowed_ops: Record<string, string[]>;
  _constraints: string[];
  _warnings: string[];
};

export type XVibeValidationPlan = {
  _ok: boolean;
  _errors: string[];
  _warnings: string[];
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
