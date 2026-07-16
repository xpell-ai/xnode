export type XVibeCapabilityMode = "deterministic" | "AI-assisted";

export type XVibeCapabilityStatus =
  | "supported"
  | "internal"
  | "unsupported";

export type XVibeCapabilityCategory =
  | "view-editing"
  | "project-planning"
  | "maintenance";

export type XVibeCapabilityDefinition = {
  _id: string;
  _category: XVibeCapabilityCategory;
  _mode: XVibeCapabilityMode;
  _title: string;
  _description: string;
  _prompt_examples: string[];
  _manual_steps?: string[];
  _status: XVibeCapabilityStatus;
  _tested: boolean;
  _user_visible: boolean;
  _references?: {
    _xui_types?: string[];
  };
};

export type XVibeCapabilityGuidanceItem = {
  _id: string;
  _category: XVibeCapabilityCategory;
  _tested: boolean;
  _user_visible: boolean;
  title: string;
  description: string;
  prompt_examples: string[];
  manual_steps: string[];
  mode: XVibeCapabilityMode;
  status: XVibeCapabilityStatus;
};

export type XVibeCapabilityGuidanceSection = {
  _id: XVibeCapabilityCategory;
  _category: XVibeCapabilityCategory;
  _title: string;
  _description: string;
  _capability_count: number;
  _capabilities: XVibeCapabilityGuidanceItem[];
};

export type XVibeCapabilityGuidanceArtifact = {
  _type: "capability-guidance";
  _query_type: "overview" | "capability" | "manual" | "prompt-examples";
  _matched_capability_ids: string[];
  _matched_categories: XVibeCapabilityCategory[];
  _category?: XVibeCapabilityCategory | "mixed";
  _description: string;
  _current_view_id?: string;
  _capability_count: number;
  _capabilities: XVibeCapabilityGuidanceItem[];
  _sections: XVibeCapabilityGuidanceSection[];
};

const VIEW_EDIT_MANUAL_BASE = [
  "Select the object",
  "Open Inspector",
  "Save",
];

const CAPABILITIES: readonly XVibeCapabilityDefinition[] = [
  {
    _id: "update-text",
    _category: "view-editing",
    _mode: "deterministic",
    _title: "Change visible text",
    _description: "Update the visible text of an object.",
    _prompt_examples: [
      'Change "My App" to "Dashboard"',
      'Update the title "Overview" to "Reports"',
    ],
    _manual_steps: [
      "Select the object",
      "Open Inspector",
      "Edit _text",
      "Save",
    ],
    _status: "supported",
    _tested: true,
    _user_visible: true,
  },
  {
    _id: "set-styles",
    _category: "view-editing",
    _mode: "deterministic",
    _title: "Set styles",
    _description: "Set one or more style properties on an object.",
    _prompt_examples: [
      "Set the Play button background to green",
      "Make the Dashboard title font size 32px",
    ],
    _manual_steps: [
      ...VIEW_EDIT_MANUAL_BASE.slice(0, 2),
      "Edit _style",
      "Save",
    ],
    _status: "supported",
    _tested: true,
    _user_visible: true,
  },
  {
    _id: "add-remove-class",
    _category: "view-editing",
    _mode: "deterministic",
    _title: "Add or remove a class",
    _description: "Add, remove, replace, or toggle a CSS class on an object.",
    _prompt_examples: [
      "Add primary class to the Play button",
      "Remove disabled class from the Submit button",
    ],
    _manual_steps: [
      ...VIEW_EDIT_MANUAL_BASE.slice(0, 2),
      "Edit class or _class",
      "Save",
    ],
    _status: "supported",
    _tested: true,
    _user_visible: true,
  },
  {
    _id: "add-header-footer-label",
    _category: "view-editing",
    _mode: "deterministic",
    _title: "Add a header or footer label",
    _description: "Add a simple label to a header or footer area in the current view.",
    _prompt_examples: [
      "Add a header label that says Reports",
      "Add a footer label that says Last updated today",
    ],
    _manual_steps: [
      "Open the current view",
      "Add a label object to the header or footer container",
      "Set _text",
      "Save",
    ],
    _status: "supported",
    _tested: true,
    _user_visible: true,
  },
  {
    _id: "hide-object",
    _category: "view-editing",
    _mode: "deterministic",
    _title: "Hide an object",
    _description: "Hide an object without deleting it.",
    _prompt_examples: [
      "Hide selected",
      "Hide the Pause button",
    ],
    _manual_steps: [
      ...VIEW_EDIT_MANUAL_BASE.slice(0, 2),
      "Set style display:none",
      "Save",
    ],
    _status: "supported",
    _tested: true,
    _user_visible: true,
  },
  {
    _id: "remove-object",
    _category: "view-editing",
    _mode: "deterministic",
    _title: "Remove an object",
    _description: "Remove an object from the view JSON.",
    _prompt_examples: [
      "Remove selected",
      "Delete the Pause button",
    ],
    _manual_steps: [
      "Select the object",
      "Remove it from its parent _children array",
      "Save",
    ],
    _status: "supported",
    _tested: true,
    _user_visible: true,
  },
  {
    _id: "create-toolbar",
    _category: "view-editing",
    _mode: "deterministic",
    _title: "Create a toolbar",
    _description: "Create a toolbar in the current view.",
    _prompt_examples: [
      "Create a toolbar at the top",
      "Add a top toolbar with Save and Cancel buttons",
    ],
    _manual_steps: [
      "Open the current view",
      "Add a toolbar object",
      "Add button children when needed",
      "Save",
    ],
    _status: "supported",
    _tested: true,
    _user_visible: true,
  },
  {
    _id: "create-button",
    _category: "view-editing",
    _mode: "deterministic",
    _title: "Create a button",
    _description: "Add a button object to a resolved project view.",
    _prompt_examples: [
      'Add an "Add Meal" button to the homepage',
      "Add a Save button to the main view",
      "Create a Refresh button in the current view",
    ],
    _manual_steps: [
      "Open the target view",
      "Add a button object to the view _children array",
      "Set _id and _text",
      "Save",
    ],
    _status: "supported",
    _tested: true,
    _user_visible: true,
  },
  {
    _id: "open-existing-view-modal",
    _category: "view-editing",
    _mode: "deterministic",
    _title: "Open an existing view in a modal",
    _description: "Create a modal containing an existing persisted view reference and bind a button to open it.",
    _prompt_examples: [
      "Make the Add Meal button open the create-meal view in a modal.",
    ],
    _manual_steps: [
      "Open the target view",
      "Add a modal object with an xvm-view child",
      "Set the button _on._click handler to open-object",
      "Save",
    ],
    _status: "supported",
    _tested: true,
    _user_visible: true,
    _references: {
      _xui_types: ["modal", "xvm-view", "button"],
    },
  },
  {
    _id: "close-modal-on-form-success",
    _category: "view-editing",
    _mode: "deterministic",
    _title: "Close a modal after form success",
    _description: "Append a local close-object command to an existing CRUD create flow _on_success handler.",
    _prompt_examples: [
      "After the Meal form saves successfully, close create-meal-modal.",
    ],
    _manual_steps: [
      "Open the generated form flow",
      "Append close-object to _on_success",
      "Save the flow",
    ],
    _status: "supported",
    _tested: true,
    _user_visible: true,
    _references: {
      _xui_types: ["modal", "form", "button"],
    },
  },
  {
    _id: "entity-list",
    _category: "view-editing",
    _mode: "deterministic",
    _title: "Display entity records",
    _description: "Add a data-bound table for an existing entity to a resolved project view.",
    _prompt_examples: [
      "Show recent Meal records on the homepage.",
    ],
    _manual_steps: [
      "Verify the entity exists",
      "Add an entity-manager find command and XData write to _on_mount",
      "Add a table bound to the entity records data source",
      "Save the view",
    ],
    _status: "supported",
    _tested: true,
    _user_visible: true,
    _references: {
      _xui_types: ["table"],
    },
  },
  {
    _id: "entity-aggregation",
    _category: "view-editing",
    _mode: "deterministic",
    _title: "Display entity aggregations",
    _description: "Add reusable summary UI for numeric aggregations over existing entity records.",
    _prompt_examples: [
      "Display the sum of calories and the sum of protein from Meal records on the homepage.",
    ],
    _manual_steps: [
      "Verify the entity exists",
      "Verify requested fields exist and are numeric",
      "Add entity-manager find and aggregate commands to _on_mount",
      "Add summary UI bound to aggregation XData keys",
      "Save the view",
    ],
    _status: "supported",
    _tested: true,
    _user_visible: true,
    _references: {
      _xui_types: ["view", "label"],
    },
  },
  {
    _id: "start-project-planning",
    _category: "project-planning",
    _mode: "deterministic",
    _title: "Plan or start a project",
    _description: "Start a project plan and collect the required planning answers.",
    _prompt_examples: [
      "I want to build a CRM",
      "I want to build a nutrition app",
    ],
    _manual_steps: [
      "Describe the project goal",
      "Answer each planning question",
      "Review the proposed entities, views, flows, and modules",
    ],
    _status: "supported",
    _tested: true,
    _user_visible: true,
  },
  {
    _id: "confirm-plan",
    _category: "project-planning",
    _mode: "deterministic",
    _title: "Confirm a project plan",
    _description: "Confirm the current project plan so Visual Xpell can move from planning to building.",
    _prompt_examples: [
      "Confirm plan",
      "Looks good, continue",
    ],
    _manual_steps: [
      "Review the current project plan",
      "Confirm that the required answers are complete",
      "Save the confirmed plan",
    ],
    _status: "supported",
    _tested: true,
    _user_visible: true,
  },
  {
    _id: "fix-project-views",
    _category: "maintenance",
    _mode: "deterministic",
    _title: "Fix project view IDs",
    _description: "Internal project view ID integrity operation.",
    _prompt_examples: [],
    _status: "internal",
    _tested: true,
    _user_visible: false,
  },
  {
    _id: "integrity-repair-operations",
    _category: "maintenance",
    _mode: "deterministic",
    _title: "Integrity repair operations",
    _description: "Internal integrity repair operations for project data.",
    _prompt_examples: [],
    _status: "internal",
    _tested: false,
    _user_visible: false,
  },
];

function clone_capability(
  capability: XVibeCapabilityDefinition,
): XVibeCapabilityDefinition {
  return JSON.parse(JSON.stringify(capability)) as XVibeCapabilityDefinition;
}

export class XVibeCapabilityRegistry {
  all(): XVibeCapabilityDefinition[] {
    return CAPABILITIES.map(clone_capability);
  }

  userVisibleTested(): XVibeCapabilityDefinition[] {
    return CAPABILITIES
      .filter((capability) =>
        capability._user_visible === true &&
        capability._tested === true,
      )
      .map(clone_capability);
  }

  byIds(ids: readonly string[]): XVibeCapabilityDefinition[] {
    const wanted = new Set(ids);
    return this.userVisibleTested()
      .filter((capability) => wanted.has(capability._id));
  }

  byCategory(
    category: XVibeCapabilityCategory,
  ): XVibeCapabilityDefinition[] {
    return this.userVisibleTested()
      .filter((capability) => capability._category === category);
  }
}
