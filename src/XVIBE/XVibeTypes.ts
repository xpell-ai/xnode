export type VibeSelectionArtifactType = "view" | "flow" | "entity" | "command";

export type VibeArtifactType = "view" | "flow" | "entity" | "command";
export type VibeRequestedArtifactType = VibeArtifactType | "auto";

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
