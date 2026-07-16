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
  _edit_action?: "remove" | "hide" | "show" | "update" | "add-class" | "remove-class" | "replace-class" | "toggle-class" | "set-style" | "set-styles" | "remove-style" | "set-style-class-rule" | "remove-style-class-rule" | "set-property" | "update-property" | "remove-property" | "move-object" | "replace-object" | "duplicate-object" | "add-child" | "create-toolbar" | "set-interaction" | "bind-flow";
  _edit_target_id?: string;
  _edit_target_text?: string;
  _edit_target_type?: string;
  _edit_move_position?: "before" | "after" | "top" | "bottom";
  _edit_position?: "append" | "prepend" | "before" | "after";
  _edit_destination_id?: string;
  _edit_destination_text?: string;
  _edit_destination_type?: string;
  _edit_anchor_id?: string;
  _edit_anchor_text?: string;
  _edit_anchor_type?: string;
  _edit_replacement_text?: string;
  _edit_class_name?: string;
  _edit_old_class_name?: string;
  _edit_new_class_name?: string;
  _edit_style_property?: string;
  _edit_style_value?: string;
  _edit_styles?: Record<string, unknown>;
  _edit_property_name?: string;
  _edit_property_value?: unknown;
  _edit_interaction_scope?: "_on" | "_once";
  _edit_trigger?: string;
  _edit_handler?: Record<string, any> | null;
  _edit_flow?: { _id: string; _payload?: Record<string, unknown> };
  _edit_flow_event?: string;
  _edit_flow_auto?: boolean;
  _edit_object_value?: Record<string, any>;
  _edit_child_value?: Record<string, any>;
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

// XVibe Intent Engine types are contract-only for a future intent layer.
// They are not connected to the current XVibe prompt generation path yet.
// Existing XVibe prompt solving remains the active resolver/planner/generator behavior.
export type XVibeIntentMessageType =
  | "conversation"
  | "question"
  | "inspect"
  | "edit"
  | "generate"
  | "plan"
  | "planning"
  | "debug";

export type XVibeIntentExecutionLevel =
  | "none"
  | "deterministic"
  | "artifact"
  | "planning"
  | "model";

export type XVibeIntentActionType =
  | "apply-view-edit"
  | "generate-artifact"
  | "inspect-runtime"
  | "module-op"
  | "module-generate"
  | "module-edit"
  | "open-panel"
  | "ask-user"
  | "reply";

export type XVibeIntentActionStatus =
  | "suggested"
  | "approved"
  | "running"
  | "done"
  | "failed"
  | "rejected";

export type XVibeIntentArtifactRequestType =
  | "entity"
  | "flow"
  | "view"
  | "form"
  | "table"
  | "crud-evolution"
  | "crud-field-suggestion"
  | "execution-graph"
  | "project-plan"
  | "capability-guidance"
  | "mutation-plan";

export interface XVibeIntentAction {
  _id: string;
  _title: string;
  _description?: string;
  _action_type: XVibeIntentActionType;
  _status: XVibeIntentActionStatus;
  _params?: Record<string, any>;
  _execution_payload?: {
    _module: string;
    _op: string;
    _params: Record<string, any>;
  };
  _executable?: boolean;
  _non_executable_reason?: string;
  _requires_approval?: boolean;
  _confidence?: number;
  _reason?: string;
}

export interface XVibeIntentResult {
  _message_type: XVibeIntentMessageType;
  _execution_level: XVibeIntentExecutionLevel;
  _should_mutate: boolean;
  _confidence: number;
  _reason?: string;
  _actions: XVibeIntentAction[];
  _warnings?: string[];
  _artifact_type?: XVibeIntentArtifactRequestType;
  _artifact_request?: Record<string, any>;
}

export interface XVibeIntentRuntimeContext {
  _app_id: string;
  _env: string;
  _stage?: XVibeProjectMemory["_stage"];
  _active_view_id?: string;
  _current_view?: Record<string, any>;
  _selected_object?: Record<string, any>;
  _conversation_id?: string;
  _project_memory?: XVibeProjectMemory;
  _current_artifact?: Record<string, any>;
  _current_project_plan?: Record<string, any>;
  _planning_answer?: string | string[];
  _available_artifacts?: {
    _views?: string[];
    _entities?: string[];
    _flows?: string[];
    _modules?: string[];
  };
}

export type XVibeProjectMemory = {
  _version: number;
  _stage: "planning" | "building" | "review" | "completed";
  _vision: string;
  _goal: string;
  _summary?: string;
  _proposed?: {
    _entities?: unknown[];
    _views?: unknown[];
    _flows?: unknown[];
    _server_modules?: unknown[];
  };
  _current_focus: string;
  _completed: unknown[];
  _achievements?: unknown[];
  _milestones?: unknown[];
  _parking_lot: unknown[];
  _decisions: unknown[];
  _notes: unknown[];
  _updated_at: string;
};

export type XVibeGuideRecommendation = {
  _title: string;
  _reason: string;
  _type: "entity" | "crud" | "flow" | "view";
  _priority: number;
  _action: {
    _prompt: string;
  };
};

export interface XVibeIntentEngineRequest {
  _message: string;
  _conversation_id?: string;
  _runtime_context: XVibeIntentRuntimeContext;
  _semantic_result?: XVibeIntentResult | null;
  _metadata?: Record<string, any>;
}

export interface XVibeIntentEngineResponse {
  _ok: boolean;
  _intent?: XVibeIntentResult;
  _error?: string;
  _reason?: string;
  _processor?: string;
  _processor_chain?: string[];
  _duration_ms?: number;
}

export  { type VibeKnowledgeSelection, type VibeSkillDocument } from "./VibeKnowledgeSelector";
