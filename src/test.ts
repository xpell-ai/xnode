import assert from "assert";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _x, _xlog } from "@xpell/core";
import { XModuleCreatorModule } from "./XGenerative/XModuleCreator/index.js";
import { XDB, XDBStorageFS } from "./XDB/index.js";
import { XEntityManager } from "./XEntityManager/XEntityManager.js";
import { ServerXVMModule } from "./XVM/ServerXVMModule.js";
import {
  build_generated_module_implementation_prompt,
  infer_xvibe_artifact_action_plan,
  infer_xvibe_artifact_plan,
  infer_xvibe_artifact_type,
  XVibeModule,
  prompt_allows_view_flow_triggers,
  strip_unrequested_flow_triggers,
} from "./XVIBE/XVibeModule.js";
import {
  budgetSkills,
  isWeakSkill,
  rankSkillsForPrompt,
  VibePromptBuilder,
} from "./XVIBE/VibePromptBuilder.js";
import { ensure_view_ids } from "./XVIBE/VibeViewBuilder.js";
import type { XVibeViewArtifact } from "./XVIBE/VibeOutputParser.js";
import {
  extract_module_operation_matches_from_prompt,
  VibeIntentPlanner,
} from "./XVIBE/VibeIntentPlanner.js";
import { VibeBehaviorPlanner } from "./XVIBE/VibeBehaviorPlanner.js";
import { XMutator } from "./XMutator/XMutator.js";

type ValidateGeneratedArtifact = (input: {
  _artifact_type: "view";
  _artifact: XVibeViewArtifact;
  _prompt: string;
  _runtime_skills: unknown;
  _generated_artifacts?: unknown;
  _planned_flow_ids?: string[];
}) => { _ok: true; _errors: [] } | { _ok: false; _errors: string[] };

function strip_when_prompt_disallows_flow(prompt: string, view: XVibeViewArtifact): number {
  if (prompt_allows_view_flow_triggers(prompt)) {
    return 0;
  }

  return strip_unrequested_flow_triggers(view);
}

function collect_missing_xui_node_ids(value: unknown, path = "_view", missing: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collect_missing_xui_node_ids(item, `${path}[${index}]`, missing);
    });
    return missing;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return missing;
  }

  const node = value as Record<string, unknown>;
  if (typeof node._type === "string" && node._type.trim().length > 0) {
    if (typeof node._id !== "string" || node._id.trim().length === 0) {
      missing.push(path);
    }
  }

  for (const [key, child] of Object.entries(node)) {
    if (child && typeof child === "object") {
      collect_missing_xui_node_ids(child, `${path}.${key}`, missing);
    }
  }

  return missing;
}

const xmutator = new XMutator();
const behavior_planner = new VibeBehaviorPlanner();
const behavior_runtime_assets = {
  _views: [],
  _flows: [],
  _entities: [
    { _id: "aime-user" },
    { _id: "xai-routing-rule" },
    { _id: "xai-api-key" },
  ],
  _modules: [],
};

const create_user_behavior = behavior_planner.infer_behavior_intent({
  _prompt: "Create flow named create-aime-account-user",
  _artifact_intent: {
    _action: "create",
    _target: "flow",
    _target_id: "create-aime-account-user",
    _forbidden_targets: [],
    _confidence: 0.9,
    _reason: "test",
  },
  _runtime_assets: behavior_runtime_assets,
});
assert.equal(create_user_behavior._flow_goal, "create-user");
assert.equal(create_user_behavior._entity, "aime-user");
assert.equal(create_user_behavior._crud, "add");
assert.equal(create_user_behavior._confidence, 0.9);

const get_rules_behavior = behavior_planner.infer_behavior_intent({
  _prompt: "Create flow named get-routing-rules",
  _artifact_intent: {
    _action: "create",
    _target: "flow",
    _target_id: "get-routing-rules",
    _forbidden_targets: [],
    _confidence: 0.9,
    _reason: "test",
  },
  _runtime_assets: behavior_runtime_assets,
});
assert.equal(get_rules_behavior._flow_goal, "load-routing-rules");
assert.equal(get_rules_behavior._entity, "xai-routing-rule");
assert.equal(get_rules_behavior._crud, "find");

const update_key_behavior = behavior_planner.infer_behavior_intent({
  _prompt: "Create flow named update-api-key",
  _artifact_intent: {
    _action: "create",
    _target: "flow",
    _target_id: "update-api-key",
    _forbidden_targets: [],
    _confidence: 0.9,
    _reason: "test",
  },
  _runtime_assets: behavior_runtime_assets,
});
assert.equal(update_key_behavior._flow_goal, "update-api-key");
assert.equal(update_key_behavior._entity, "xai-api-key");
assert.equal(update_key_behavior._crud, "update");

const view_update_behavior = behavior_planner.infer_behavior_intent({
  _prompt: 'Update view "main"\nChange only design',
  _artifact_type: "view",
  _artifact_action_plan: {
    _artifact_type: "view",
    _action: "update",
    _target_id: "main",
  },
  _artifact_intent: {
    _action: "update",
    _target: "view",
    _target_id: "main",
    _forbidden_targets: [],
    _confidence: 0.9,
    _reason: "test",
  },
  _intent_plan: {
    _artifact_types: ["view"],
    _entities: [{ _id: "accounts", _fields: [] }],
    _actions: [
      {
        _id: "refresh-ccounts",
        _type: "flow",
        _label: "Refresh",
        _entity: "ccounts",
      },
    ],
    _crud_ops: ["update"],
    _flow_keywords: ["refresh-ccounts", "add-ccount", "update-ccount"],
    _entity_keywords: ["accounts", "ccounts"],
  } as any,
  _runtime_assets: {
    _views: [{ _id: "main" }],
    _flows: [{ _id: "refresh-accounts" }],
    _entities: [{ _id: "accounts" }, { _id: "ccounts" }],
    _modules: [],
  },
});
assert.equal(view_update_behavior._behavior_type, "ui");
assert.equal(view_update_behavior._crud, undefined);
assert.deepEqual(view_update_behavior._entity_targets, []);
assert.deepEqual(view_update_behavior._flow_targets, []);
assert.deepEqual(view_update_behavior._steps, []);

const create_account_button_behavior = behavior_planner.infer_behavior_intent({
  _prompt: "Create Account button",
  _artifact_type: "view",
  _artifact_intent: {
    _action: "update",
    _target: "view",
    _forbidden_targets: [],
    _confidence: 0.9,
    _reason: "test",
  },
  _runtime_assets: {
    _views: [{ _id: "main" }],
    _flows: [],
    _entities: [{ _id: "account" }, { _id: "accounts" }, { _id: "ccounts" }],
    _modules: [],
  },
});
assert.equal(create_account_button_behavior._crud, undefined);
assert.deepEqual(create_account_button_behavior._entity_targets, []);
assert.equal(create_account_button_behavior._entity, undefined);

const create_entity_behavior = behavior_planner.infer_behavior_intent({
  _prompt: "Create entity named customer",
  _artifact_type: "entity",
  _artifact_intent: {
    _action: "create",
    _target: "entity",
    _target_id: "customer",
    _forbidden_targets: [],
    _confidence: 0.9,
    _reason: "test",
  },
  _runtime_assets: {
    _views: [],
    _flows: [],
    _entities: [],
    _modules: [],
  },
});
assert.equal(create_entity_behavior._crud, "add");
assert.equal(create_entity_behavior._entity, "customer");
assert.deepEqual(create_entity_behavior._entity_targets, ["customer"]);

const new_view_behavior = behavior_planner.infer_behavior_intent({
  _prompt: 'Create new view "ai-key"',
  _artifact_type: "view",
  _artifact_action_plan: {
    _artifact_type: "view",
    _action: "create",
    _target_id: "ai-key",
  },
  _artifact_intent: {
    _action: "create",
    _target: "view",
    _target_id: "ai-key",
    _forbidden_targets: [],
    _confidence: 0.9,
    _reason: "test",
  },
  _runtime_assets: {
    _views: [{ _id: "main" }],
    _flows: [],
    _entities: [{ _id: "accounts" }],
    _modules: [],
  },
});
assert.equal(new_view_behavior._behavior_type, "ui");
assert.equal(new_view_behavior._crud, undefined);
assert.deepEqual(new_view_behavior._entity_targets, []);
assert.deepEqual(new_view_behavior._flow_targets, []);

const label_replace_view = {
  _id: "view",
  _type: "view",
  _children: [
    {
      _id: "before",
      _type: "label",
      _text: "Before",
    },
    {
      _id: "a",
      _type: "label",
      _text: "Old",
    },
    {
      _id: "after",
      _type: "label",
      _text: "After",
    },
  ],
};
const label_replace_original = JSON.parse(JSON.stringify(label_replace_view));
const label_replacement = {
  _id: "a",
  _type: "label",
  _text: "New",
};
const label_replace_result =
  xmutator.replace_by_id(label_replace_view, "a", label_replacement);

assert.deepEqual(label_replace_result, {
  _id: "view",
  _type: "view",
  _children: [
    {
      _id: "before",
      _type: "label",
      _text: "Before",
    },
    {
      _id: "a",
      _type: "label",
      _text: "New",
    },
    {
      _id: "after",
      _type: "label",
      _text: "After",
    },
  ],
});
assert.deepEqual(label_replace_view, label_replace_original);
assert.deepEqual(label_replace_result._children.map((child: any) => child._id), ["before", "a", "after"]);
assert.deepEqual(xmutator.find_by_id(label_replace_result, "a"), label_replacement);
assert.equal(xmutator.has_id(label_replace_result, "a"), true);

const nested_grid_view = {
  _id: "view",
  _type: "view",
  _children: [
    {
      _id: "header",
      _type: "label",
      _text: "Header",
    },
    {
      _id: "grid",
      _type: "grid",
      _children: [
        {
          _id: "cell-a",
          _type: "label",
          _text: "A",
        },
        {
          _id: "b",
          _type: "button",
          _text: "Old",
        },
        {
          _id: "cell-c",
          _type: "label",
          _text: "C",
        },
      ],
    },
    {
      _id: "footer",
      _type: "label",
      _text: "Footer",
    },
  ],
};
const nested_grid_original = JSON.parse(JSON.stringify(nested_grid_view));
const button_replacement = {
  _id: "b",
  _type: "button",
  _text: "New",
  _variant: "primary",
};
const nested_grid_result =
  xmutator.replace_by_id(nested_grid_view, "b", button_replacement);

assert.deepEqual(nested_grid_result, {
  _id: "view",
  _type: "view",
  _children: [
    {
      _id: "header",
      _type: "label",
      _text: "Header",
    },
    {
      _id: "grid",
      _type: "grid",
      _children: [
        {
          _id: "cell-a",
          _type: "label",
          _text: "A",
        },
        {
          _id: "b",
          _type: "button",
          _text: "New",
          _variant: "primary",
        },
        {
          _id: "cell-c",
          _type: "label",
          _text: "C",
        },
      ],
    },
    {
      _id: "footer",
      _type: "label",
      _text: "Footer",
    },
  ],
});
assert.deepEqual(nested_grid_view, nested_grid_original);
assert.deepEqual(nested_grid_result._children.map((child: any) => child._id), ["header", "grid", "footer"]);
assert.deepEqual(nested_grid_result._children[1]._children.map((child: any) => child._id), ["cell-a", "b", "cell-c"]);
assert.deepEqual(xmutator.find_by_id(nested_grid_result, "b"), button_replacement);

const missing_target_view = {
  _id: "view",
  _type: "view",
  _children: [
    {
      _id: "a",
      _type: "label",
      _text: "A",
    },
    {
      _id: "grid",
      _type: "grid",
      _children: [
        {
          _id: "b",
          _type: "button",
          _text: "B",
        },
      ],
    },
  ],
};
const missing_target_original = JSON.parse(JSON.stringify(missing_target_view));
const missing_target_result =
  xmutator.replace_by_id(missing_target_view, "missing", {
    _id: "missing",
    _type: "label",
  });

assert.deepEqual(missing_target_result, missing_target_original);
assert.deepEqual(missing_target_view, missing_target_original);
assert.deepEqual(missing_target_result._children.map((child: any) => child._id), ["a", "grid"]);
assert.equal(xmutator.has_id(missing_target_result, "missing"), false);

const root_replace_view = {
  _id: "root",
  _type: "view",
  _children: [
    {
      _id: "a",
      _type: "label",
      _text: "A",
    },
  ],
};
const root_replace_original = JSON.parse(JSON.stringify(root_replace_view));
const root_replacement = {
  _id: "root",
  _type: "view",
  _children: [
    {
      _id: "new-a",
      _type: "label",
      _text: "New A",
    },
    {
      _id: "new-b",
      _type: "button",
      _text: "New B",
    },
  ],
};
const root_replace_result =
  xmutator.replace_by_id(root_replace_view, "root", root_replacement);

assert.deepEqual(root_replace_result, root_replacement);
assert.deepEqual(root_replace_view, root_replace_original);
assert.deepEqual(root_replace_result._children.map((child: any) => child._id), ["new-a", "new-b"]);

const plain_buttons_prompt = "create new row of buttons in the view";
const hallucinated_button_view: XVibeViewArtifact = {
  _id: "main",
  _type: "view",
  _children: [
    {
      _id: "button-row",
      _type: "stack",
      _children: [
        {
          _id: "button-one",
          _type: "button",
          _text: "One",
          _flow: {
            _id: "flow-action-1",
          },
        },
      ],
    },
  ],
};

assert.equal(prompt_allows_view_flow_triggers(plain_buttons_prompt), false);
assert.equal(strip_when_prompt_disallows_flow(plain_buttons_prompt, hallucinated_button_view), 1);
assert.equal(
  ((hallucinated_button_view._children?.[0] as any)._children[0] as any)._flow,
  undefined,
);

const explicit_flow_prompt = "create a button that triggers flow-save-customer";
const explicit_flow_view: XVibeViewArtifact = {
  _id: "main",
  _type: "view",
  _children: [
    {
      _id: "save-button",
      _type: "button",
      _text: "Save",
      _flow: {
        _id: "flow-save-customer",
      },
    },
  ],
};

assert.equal(prompt_allows_view_flow_triggers(explicit_flow_prompt), true);
assert.equal(
  prompt_allows_view_flow_triggers("On click, run a flow named create-aime-account-user"),
  true,
);
assert.equal(strip_when_prompt_disallows_flow(explicit_flow_prompt, explicit_flow_view), 0);
assert.deepEqual((explicit_flow_view._children?.[0] as any)._flow, {
  _id: "flow-save-customer",
});

assert.equal(infer_xvibe_artifact_type("Update main view"), "view");
assert.equal(infer_xvibe_artifact_type("Replace login button with create account"), "view");
assert.equal(infer_xvibe_artifact_type("Add email field to login screen"), "view");
assert.equal(infer_xvibe_artifact_type("Modify current page"), "view");
assert.equal(infer_xvibe_artifact_type("Keep current layout and add password field"), "view");
assert.equal(infer_xvibe_artifact_type("Change the button text"), "view");
assert.equal(
  infer_xvibe_artifact_type(`Update main view.
Keep it as a simple onboarding/login screen.
Add fields:
- account_name
- name
- email
- password
Replace the Login button with a Create Account button.
On click, run a flow named create-aime-account-user.
Do not add API key creation yet.`),
  "view",
);
assert.equal(infer_xvibe_artifact_type("Create entity users"), "entity");
assert.equal(infer_xvibe_artifact_type("Create schema for accounts"), "entity");
assert.equal(infer_xvibe_artifact_type("Add fields to entity user"), "entity");
assert.equal(infer_xvibe_artifact_type("Generate database schema"), "entity");
assert.equal(infer_xvibe_artifact_type("Add fields: name, email, password"), "view");
assert.equal(infer_xvibe_artifact_type("add fields account_name email to entity users"), "entity");
assert.equal(infer_xvibe_artifact_type("update main view add fields account_name email"), "view");
const entity_fields_plan = infer_xvibe_artifact_plan("add fields account_name email to entity users");
assert.equal(entity_fields_plan._primary_artifact_type, "entity");
assert.deepEqual(entity_fields_plan._artifact_types, ["entity"]);
assert.deepEqual(entity_fields_plan._entity_ids, ["users"]);
assert.equal(entity_fields_plan._intent?._target, "entity");

const main_view_fields_plan = infer_xvibe_artifact_plan("update main view add fields account_name email");
assert.equal(main_view_fields_plan._primary_artifact_type, "view");
assert.deepEqual(main_view_fields_plan._artifact_types, ["view"]);
assert.equal(main_view_fields_plan._intent?._target, "view");

const view_with_flow_plan = infer_xvibe_artifact_plan(
  "update main view add fields account_name email on click run a flow named create-aime-account-user"
);
assert.equal(view_with_flow_plan._primary_artifact_type, "view");
assert.deepEqual(view_with_flow_plan._artifact_types, ["flow", "view"]);
assert.deepEqual(view_with_flow_plan._flow_ids, ["create-aime-account-user"]);

const artifact_intent_planner = new VibeIntentPlanner();
const flow_only_prompt = `Create a flow named create-aime-account-user.

Only create the flow.
Do not create entities.
Do not create views.`;
const flow_only_intent = artifact_intent_planner.infer_artifact_intent(flow_only_prompt);
assert.equal(flow_only_intent._action, "create");
assert.equal(flow_only_intent._target, "flow");
assert.equal(flow_only_intent._target_id, "create-aime-account-user");
assert.ok(flow_only_intent._forbidden_targets.includes("entity"));
assert.ok(flow_only_intent._forbidden_targets.includes("view"));
const flow_only_plan = artifact_intent_planner.build_artifact_plan_from_intent(
  flow_only_prompt,
  flow_only_intent,
);
assert.equal(flow_only_plan._primary_artifact_type, "flow");
assert.deepEqual(flow_only_plan._artifact_types, ["flow"]);
assert.deepEqual(flow_only_plan._flow_ids, ["create-aime-account-user"]);

const create_entity_user_intent = artifact_intent_planner.infer_artifact_intent("Create entity user");
assert.equal(create_entity_user_intent._action, "create");
assert.equal(create_entity_user_intent._target, "entity");
assert.equal(create_entity_user_intent._target_id, "user");

const update_main_view_intent = artifact_intent_planner.infer_artifact_intent("Update main view");
assert.equal(update_main_view_intent._action, "update");
assert.equal(update_main_view_intent._target, "view");
assert.equal(update_main_view_intent._target_id, "main");

const delete_entity_user_intent = artifact_intent_planner.infer_artifact_intent("Delete entity user");
assert.equal(delete_entity_user_intent._action, "delete");
assert.equal(delete_entity_user_intent._target, "entity");
assert.equal(delete_entity_user_intent._target_id, "user");

const create_module_calc_intent = artifact_intent_planner.infer_artifact_intent("Create module calc");
assert.equal(create_module_calc_intent._action, "create");
assert.equal(create_module_calc_intent._target, "module");
assert.equal(create_module_calc_intent._target_id, "calc");

const create_flow_execution_intent =
  artifact_intent_planner.infer_artifact_intent("Create flow named create-user");
const create_flow_execution_plan =
  artifact_intent_planner.build_artifact_plan_from_intent(
    "Create flow named create-user",
    create_flow_execution_intent,
  );
assert.deepEqual(create_flow_execution_plan._execution_plan, {
  _primary_artifact_type: "flow",
  _artifacts: [
    {
      _artifact_type: "flow",
      _action: "create",
      _artifact_id: "create-user",
    },
  ],
});

const view_flow_execution_prompt = "Update login page and create flow create-user";
const view_flow_execution_intent =
  artifact_intent_planner.infer_artifact_intent(view_flow_execution_prompt);
const view_flow_execution_plan =
  artifact_intent_planner.build_artifact_plan_from_intent(
    view_flow_execution_prompt,
    view_flow_execution_intent,
  );
assert.deepEqual(view_flow_execution_plan._execution_plan, {
  _primary_artifact_type: "view",
  _artifacts: [
    {
      _artifact_type: "flow",
      _action: "create",
      _artifact_id: "create-user",
    },
    {
      _artifact_type: "view",
      _action: "update",
      _artifact_id: "main",
      _depends_on: ["create-user"],
    },
  ],
});

const delete_customer_execution_intent =
  artifact_intent_planner.infer_artifact_intent("Delete entity customer");
const delete_customer_execution_plan =
  artifact_intent_planner.build_artifact_plan_from_intent(
    "Delete entity customer",
    delete_customer_execution_intent,
  );
assert.deepEqual(delete_customer_execution_plan._execution_plan, {
  _primary_artifact_type: "entity",
  _artifacts: [
    {
      _artifact_type: "entity",
      _action: "delete",
      _artifact_id: "customer",
    },
  ],
});

const flow_only_trace_logs: string[] = [];
const original_trace_log = _xlog.log;
(_xlog as any).log = (message: string) => {
  flow_only_trace_logs.push(message);
};
try {
  const flow_only_wrapper_plan = infer_xvibe_artifact_plan(flow_only_prompt);
  assert.equal(flow_only_wrapper_plan._primary_artifact_type, "flow");
  assert.equal(flow_only_wrapper_plan._reason, "explicit_only_intent");
  assert.deepEqual(flow_only_wrapper_plan._artifact_types, ["flow"]);
  assert.deepEqual(flow_only_wrapper_plan._flow_ids, ["create-aime-account-user"]);
  assert.ok(flow_only_trace_logs.includes("[xvibe] artifact inference branch"));
} finally {
  (_xlog as any).log = original_trace_log;
}

const named_entity_plan = infer_xvibe_artifact_plan("Create entity named users");
assert.equal(named_entity_plan._primary_artifact_type, "entity");
assert.deepEqual(named_entity_plan._artifact_types, ["entity"]);
assert.deepEqual(named_entity_plan._entity_ids, ["users"]);
assert.equal(named_entity_plan._reason, "named_artifact_intent");

const delete_entity_plan = infer_xvibe_artifact_plan("Delete entity users") as any;
assert.equal(delete_entity_plan._primary_artifact_type, "entity");
assert.deepEqual(delete_entity_plan._artifact_types, ["entity"]);
assert.deepEqual(delete_entity_plan._entity_ids, ["users"]);
assert.deepEqual(delete_entity_plan._action_intent, {
  _action: "delete",
  _artifact_type: "entity",
  _artifact_id: "users",
});

const named_module_plan = infer_xvibe_artifact_plan("Create server module named calc");
assert.equal(named_module_plan._primary_artifact_type, "module");
assert.deepEqual(named_module_plan._artifact_types, ["module"]);
assert.deepEqual(named_module_plan._module_names, ["calc"]);
assert.equal(named_module_plan._reason, "named_artifact_intent");

const positive_module_ops =
  extract_module_operation_matches_from_prompt([
    "Create server module aime-auth.",
    "Module only.",
    "Operations:",
    "- _login",
    "- _logout",
  ].join("\n"));
assert.deepEqual(positive_module_ops._positive_matches, ["login", "logout"]);
assert.deepEqual(positive_module_ops._negative_matches, []);
assert.deepEqual(positive_module_ops._module_ops, ["login", "logout"]);

const negative_module_ops =
  extract_module_operation_matches_from_prompt([
    "Create server module aime-auth.",
    "Module only.",
    "Do not create operation run.",
    "Do not use operation delete.",
  ].join("\n"));
assert.deepEqual(negative_module_ops._positive_matches, []);
assert.deepEqual(negative_module_ops._negative_matches, ["run", "delete"]);
assert.deepEqual(negative_module_ops._module_ops, []);

const mixed_module_ops =
  extract_module_operation_matches_from_prompt([
    "Create server module aime-auth.",
    "Module only.",
    "Operations:",
    "- _login",
    "",
    "Do not create operation run.",
    "Do not create operation execute.",
    "Do not create operation process.",
  ].join("\n"));
assert.deepEqual(mixed_module_ops._positive_matches, ["login"]);
assert.deepEqual(mixed_module_ops._negative_matches, ["run", "execute", "process"]);
assert.deepEqual(mixed_module_ops._module_ops, ["login"]);

const update_login_view_plan = infer_xvibe_artifact_plan(`Update main view.
Replace Login button.`);
assert.equal(update_login_view_plan._primary_artifact_type, "view");

const update_view_plan = infer_xvibe_artifact_plan(
  "Update main view. Add fields account_name, name, email, password."
);
assert.equal(update_view_plan._primary_artifact_type, "view");
assert.equal(update_view_plan._intent?._target, "view");

const create_entity_plan = infer_xvibe_artifact_plan(
  "Create entity aime-user with fields name email password."
);
assert.equal(create_entity_plan._primary_artifact_type, "entity");
assert.deepEqual(create_entity_plan._entity_ids, ["aime-user"]);

const delete_entity_intent =
  artifact_intent_planner.infer_artifact_intent('Delete entity "test-entity"');
assert.equal(delete_entity_intent._action, "delete");
assert.equal(delete_entity_intent._target, "entity");
assert.equal(delete_entity_intent._target_id, "test-entity");

const login_page_plan = infer_xvibe_artifact_plan(
  "Create login page with account_name, name, email, password."
);
assert.equal(login_page_plan._primary_artifact_type, "view");

const flow_and_view_plan = infer_xvibe_artifact_plan(
  "Create a flow named create-aime-account-user and then update main view to run it on click."
);
assert.notEqual(flow_and_view_plan._primary_artifact_type, "entity");
assert.equal(flow_and_view_plan._primary_artifact_type, "flow");
assert.ok(flow_and_view_plan._artifact_types.includes("flow"));
assert.deepEqual(flow_and_view_plan._flow_ids, ["create-aime-account-user"]);
assert.deepEqual(
  infer_xvibe_artifact_action_plan("delete entity onboarding_login"),
  {
    _artifact_type: "entity",
    _action: "delete",
    _target_id: "onboarding_login",
    _requires_confirmation: true,
  },
);
assert.deepEqual(infer_xvibe_artifact_action_plan('delete entity "test-entity"'), {
  _artifact_type: "entity",
  _action: "delete",
  _target_id: "test-entity",
  _requires_confirmation: true,
});
assert.deepEqual(infer_xvibe_artifact_action_plan("remove flow create-user"), {
  _artifact_type: "flow",
  _action: "delete",
  _target_id: "create-user",
});
assert.deepEqual(infer_xvibe_artifact_action_plan("disable module calc"), {
  _artifact_type: "module",
  _action: "disable",
  _target_id: "calc",
});
assert.deepEqual(infer_xvibe_artifact_action_plan("archive entity users"), {
  _artifact_type: "entity",
  _action: "archive",
  _target_id: "users",
  _requires_confirmation: true,
});
assert.deepEqual(infer_xvibe_artifact_action_plan("rename flow create-user to create-account-user"), {
  _artifact_type: "flow",
  _action: "rename",
  _target_id: "create-user",
  _new_id: "create-account-user",
});
assert.deepEqual(infer_xvibe_artifact_action_plan("rename entity users to accounts"), {
  _artifact_type: "entity",
  _action: "rename",
  _target_id: "users",
  _new_id: "accounts",
  _requires_confirmation: true,
});
assert.deepEqual(infer_xvibe_artifact_action_plan("Delete the entity named test-sync."), {
  _artifact_type: "entity",
  _action: "delete",
  _target_id: "test-sync",
  _requires_confirmation: true,
});
assert.equal(infer_xvibe_artifact_action_plan("Create entity users"), undefined);
assert.equal(infer_xvibe_artifact_action_plan("Update main view"), undefined);

const runtime_skills = {
  _modules: [
    {
      _objects: [
        { _id: "view" },
        { _id: "stack" },
        { _id: "button" },
      ],
    },
  ],
};

const xvibe = new XVibeModule();
const generated_id_view: any = {
  _type: "view",
  _children: [
    {
      _type: "label",
      _text: "Hello",
    },
    {
      _type: "button",
      _text: "Click",
    },
  ],
};
const generated_id_result = ensure_view_ids(generated_id_view);
assert.equal(generated_id_result._count, 3);
assert.equal(generated_id_view._id, "view-1");
assert.equal(generated_id_view._children[0]._id, "label-1");
assert.equal(generated_id_view._children[1]._id, "button-1");
const generated_id_targets = (xvibe as any).collect_view_target_ids(generated_id_view);
assert.ok(generated_id_targets.includes("label-1"));

const artifact_action_generate_result = await xvibe._generate({
  _params: {
    _prompt: "delete entity onboarding_login",
  },
} as any);
assert.deepEqual(artifact_action_generate_result, {
  _ok: true,
  _artifact_action: {
    _artifact_type: "entity",
    _action: "delete",
    _target_id: "onboarding_login",
    _requires_confirmation: true,
  },
});

const unsupported_action_execute_calls: any[] = [];
const original_execute_for_unsupported_action = (_x as any).execute;
try {
  (_x as any).execute = async (command: any) => {
    unsupported_action_execute_calls.push(command);
    throw new Error(`Unsupported action test should not execute commands: ${JSON.stringify(command)}`);
  };

  const unsupported_artifact_action_generate_result = await xvibe._generate({
    _params: {
      _prompt: "Delete the entity named test-sync.",
      _app_id: "test-app",
    },
  } as any);
  assert.deepEqual(unsupported_artifact_action_generate_result, {
    _ok: false,
    _error: {
      _code: "E_XVIBE_ARTIFACT_ACTION_NOT_SUPPORTED",
      _message: "Artifact action 'delete' is not supported from Vibe prompts yet.",
      _action: "delete",
      _artifact_type: "entity",
      _artifact_id: "test-sync",
    },
  });
} finally {
  (_x as any).execute = original_execute_for_unsupported_action;
}
assert.equal(
  unsupported_action_execute_calls.some(
    (command) => command?._module === "server-xvm" && command?._op === "delete_entity",
  ),
  false,
);
assert.equal(
  unsupported_action_execute_calls.some(
    (command) => command?._module === "entity-manager" && command?._op === "unregister",
  ),
  false,
);

const view_design_lock_prompt = 'Update view "main". Change only the design. Keep existing behavior.';
const view_design_intent = (xvibe as any).intent_planner.infer_artifact_intent(view_design_lock_prompt);
assert.equal(view_design_intent._action, "update");
assert.equal(view_design_intent._target, "view");
assert.equal(view_design_intent._target_id, "main");
const view_design_lock = (xvibe as any).create_artifact_scope_lock(view_design_intent);
let view_design_plan = (xvibe as any).create_artifact_intent_plan({
  prompt: view_design_lock_prompt,
  artifact_type: "view",
  supplied_intent_plan: {},
  runtime_skills,
});
view_design_plan = (xvibe as any).apply_artifact_scope_lock_to_intent_plan(
  view_design_lock,
  view_design_plan,
);
assert.equal(view_design_lock._artifact_type, "view");
assert.equal(view_design_lock._action, "update");
assert.equal(view_design_lock._target_id, "main");
assert.deepEqual(view_design_plan._artifact_types, ["view"]);
assert.equal(view_design_plan._intent_type, "view-design");
assert.deepEqual(view_design_plan._entities, []);
assert.deepEqual(view_design_plan._actions, []);
assert.deepEqual(view_design_plan._bindings, []);
assert.deepEqual(view_design_plan._crud_ops, []);
assert.deepEqual(view_design_plan._flow_keywords, []);
assert.deepEqual(view_design_plan._entity_keywords, []);
assert.equal(view_design_plan._requires_module, false);
assert.equal(view_design_plan._module_target, null);
assert.equal(view_design_plan._module_name, "");
assert.deepEqual(view_design_plan._module_ops, []);

const button_design_prompt = "Make the Create Account button nicer.";
const button_design_intent = (xvibe as any).intent_planner.infer_artifact_intent(button_design_prompt);
assert.equal(button_design_intent._target, "view");
assert.equal(button_design_intent._action, "update");
const button_design_lock = (xvibe as any).create_artifact_scope_lock(button_design_intent);
let button_design_plan = (xvibe as any).create_artifact_intent_plan({
  prompt: button_design_prompt,
  artifact_type: "view",
  supplied_intent_plan: {},
  runtime_skills,
});
button_design_plan = (xvibe as any).apply_artifact_scope_lock_to_intent_plan(
  button_design_lock,
  button_design_plan,
);
assert.equal(button_design_plan._intent_type, "view-design");
assert.deepEqual(button_design_plan._entities, []);
assert.equal(
  button_design_plan._entity_keywords.some((keyword: string) =>
    keyword === "account" ||
    keyword === "accounts" ||
    keyword === "ccounts"
  ),
  false,
);

async function run_locked_new_view_prompt(prompt: string) {
  const calls: any[] = [];
  const pushed_views: any[] = [];
  const original_execute_for_scope_lock = (_x as any).execute;
  const original_get_skills_for_scope_lock = (_x as any).getSkills;
  try {
    (xvibe as any).latest_runtime_skills = runtime_skills;
    (_x as any).getSkills = () => runtime_skills;
    (_x as any).execute = async (command: any) => {
      calls.push(command);

      if (command?._module === "server-xvm" && command?._op === "get_app") {
        return {
          _ok: true,
          _result: {
            _app: {
              _app_id: command._params?._app_id,
              _env: command._params?._env ?? "default",
              _meta: {
                _entry_view_id: "main",
              },
            },
            _view_ids: ["main"],
            _flow_ids: [],
            _entity_ids: [],
            _entities: {},
          },
        };
      }

      if (command?._module === "xai" && command?._op === "generate") {
        return {
          _ok: true,
          _result: {
            _text: JSON.stringify({
              _artifact_type: "view",
              _contract_version: 1,
              _view: {
                _id: "main",
                _type: "view",
                _children: [
                  {
                    _id: "back",
                    _type: "button",
                    _text: "Back",
                  },
                ],
              },
            }),
          },
        };
      }

      if (command?._module === "server-xvm" && command?._op === "push_update") {
        pushed_views.push(command._params?._view);
        return {
          _ok: true,
          _result: {
            _version: 2,
          },
        };
      }

      throw new Error(`Unexpected command ${JSON.stringify(command)}`);
    };

    const result = await xvibe._generate({
      _params: {
        _prompt: prompt,
        _app_id: "scope-lock-app",
        _env: "test",
      },
    } as any) as any;

    return { result, calls, pushed_views };
  } finally {
    (_x as any).execute = original_execute_for_scope_lock;
    (_x as any).getSkills = original_get_skills_for_scope_lock;
  }
}

const new_view_scope_result = await run_locked_new_view_prompt(
  'Create new view "ai-key" with title "Xpell AI Key" and back button.',
);
assert.equal(new_view_scope_result.result._ok, true);
assert.equal(new_view_scope_result.result._result._view_id, "ai-key");
assert.equal(new_view_scope_result.pushed_views.length, 1);
assert.equal(new_view_scope_result.pushed_views[0]._id, "ai-key");
assert.equal(
  new_view_scope_result.pushed_views.some((view) => view?._id === "main"),
  false,
);
assert.equal(
  new_view_scope_result.calls.some(
    (command) => command?._module === "server-xvm" && command?._op === "set_entity",
  ),
  false,
);

const new_view_negative_constraint_result = await run_locked_new_view_prompt(
  'Create new view "ai-key" with title "Xpell AI Key" and back button. Do not delete main view.',
);
assert.equal(new_view_negative_constraint_result.result._ok, true);
assert.notEqual(
  new_view_negative_constraint_result.result._error?._code,
  "E_XVIBE_ARTIFACT_ACTION_NOT_SUPPORTED",
);
assert.equal(new_view_negative_constraint_result.result._result._view_id, "ai-key");
assert.equal(new_view_negative_constraint_result.pushed_views.length, 1);
assert.equal(new_view_negative_constraint_result.pushed_views[0]._id, "ai-key");
assert.equal(
  new_view_negative_constraint_result.pushed_views.some((view) => view?._id === "main"),
  false,
);
assert.equal(
  new_view_negative_constraint_result.calls.some(
    (command) => command?._module === "server-xvm" && command?._op === "delete_entity",
  ),
  false,
);
assert.equal(
  new_view_negative_constraint_result.calls.some(
    (command) => command?._module === "entity-manager" && command?._op === "unregister",
  ),
  false,
);

const validate_generated_artifact =
  (xvibe as unknown as { validate_generated_artifact: ValidateGeneratedArtifact })
    .validate_generated_artifact
    .bind(xvibe);

const explicit_missing_flow_validation = validate_generated_artifact({
  _artifact_type: "view",
  _artifact: explicit_flow_view,
  _prompt: explicit_flow_prompt,
  _runtime_skills: runtime_skills,
});

assert.equal(explicit_missing_flow_validation._ok, false);
assert.ok(
  explicit_missing_flow_validation._errors.some((error) =>
    error.includes("_view references missing flow 'flow-save-customer'")
  ),
);

const event_handler_runtime_skills = {
  _modules: [
    {
      _objects: [
        { _id: "view" },
        { _id: "stack" },
        { _id: "button" },
        { _id: "label" },
      ],
    },
  ],
};

const valid_object_nano_command_view: XVibeViewArtifact = {
  _id: "main",
  _type: "view",
  _children: [
    {
      _id: "calc-result-label",
      _type: "label",
      _text: "0",
    },
    {
      _id: "equals",
      _type: "button",
      _text: "=",
      _on: {
        _click: [
          {
            _module: "xvm",
            _op: "call-server",
            _params: {
              _cmd: {
                _module: "calc",
                _op: "_evaluate_expression",
                _params: {
                  expression: "3+6=",
                },
              },
            },
          },
          {
            _object: "calc-result-label",
            _op: "set-text",
            _params: {
              text: "$prev._result.value",
            },
          },
        ],
      },
    },
  ],
};

const valid_object_nano_command_validation = validate_generated_artifact({
  _artifact_type: "view",
  _artifact: valid_object_nano_command_view,
  _prompt: "Create calculator equals button",
  _runtime_skills: event_handler_runtime_skills,
});
assert.equal(valid_object_nano_command_validation._ok, true);

const invalid_event_handler_views: XVibeViewArtifact[] = [
  {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "bad-op-only",
        _type: "button",
        _text: "Bad",
        _on: {
          _click: {
            _op: "set-text",
          },
        },
      },
    ],
  },
  {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "bad-object-only",
        _type: "button",
        _text: "Bad",
        _on: {
          _click: {
            _object: "calc-result-label",
          },
        },
      },
    ],
  },
  {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "bad-on-params",
        _type: "button",
        _text: "Bad",
        _on: {
          _params: {},
        },
      },
    ],
  },
];

for (const invalid_view of invalid_event_handler_views) {
  const invalid_validation = validate_generated_artifact({
    _artifact_type: "view",
    _artifact: invalid_view,
    _prompt: "Create calculator equals button",
    _runtime_skills: event_handler_runtime_skills,
  });
  assert.equal(invalid_validation._ok, false);
}

const prompt_builder_empty_selection = {
  skill_ids: [],
  skills: [],
  diagnostics: [],
};

const account_creation_flow_prompt = new VibePromptBuilder().build({
  prompt: "Create a flow named create-aime-account-user",
  _mode: "full",
  _artifact_type: "flow",
  selection: prompt_builder_empty_selection,
  runtime_context: {
    _behavior_intent: {
      _behavior: "account_creation",
      _crud_intent: "add",
      _entity_targets: ["aime-user"],
      _flow_targets: ["create-aime-account-user"],
    },
  },
});
assert.ok(account_creation_flow_prompt.includes("BEHAVIOR INTENT INSTRUCTIONS:"));
assert.ok(account_creation_flow_prompt.includes("Generate at least one concrete step"));
assert.ok(account_creation_flow_prompt.includes('Prefer module "entity-manager" for server-side flow CRUD'));
assert.ok(account_creation_flow_prompt.includes("For add/create operations, put submitted record values in _params._data."));
assert.ok(account_creation_flow_prompt.includes("For find/get operations, put query criteria in _params._filter."));
assert.ok(account_creation_flow_prompt.includes("For update operations, put match criteria in _params._filter and changed values in _params._updates."));
assert.ok(account_creation_flow_prompt.includes("Do not use nested _command inside flow steps."));
assert.equal(account_creation_flow_prompt.includes("_behavior_intent"), false);

const account_user_creation_flow_prompt = new VibePromptBuilder().build({
  prompt: "Create a flow named create-aime-account-user",
  _mode: "full",
  _artifact_type: "flow",
  selection: prompt_builder_empty_selection,
  runtime_context: {
    _behavior_intent: {
      _behavior: "account-user-creation",
    },
  },
});
assert.ok(account_user_creation_flow_prompt.includes("Generate at least one concrete step"));

const generated_flow_view_prompt = new VibePromptBuilder().build({
  prompt: "Update main view and wire the create account button",
  _mode: "full",
  _artifact_type: "view",
  selection: prompt_builder_empty_selection,
  runtime_context: {
    _behavior_intent: {
      _behavior: "account_creation",
    },
    _generated_artifacts: {
      _flows: [
        {
          _artifact_id: "create-aime-account-user",
        },
      ],
    },
  },
});
assert.ok(generated_flow_view_prompt.includes('Buttons may wire only these available flow ids with _flow: { "_id": "<flow-id>" }.'));
assert.ok(generated_flow_view_prompt.includes("Allowed flow ids for _flow wiring: create-aime-account-user."));
assert.ok(generated_flow_view_prompt.includes("Never invent flow ids."));

const no_flow_view_prompt = new VibePromptBuilder().build({
  prompt: "Update main view and keep the button visual",
  _mode: "full",
  _artifact_type: "view",
  selection: prompt_builder_empty_selection,
  runtime_context: {
    _behavior_intent: {
      _behavior: "account_creation",
    },
  },
});
assert.ok(no_flow_view_prompt.includes("Do not add _flow from behavior intent; no explicit or planned flow id is available."));

const unknown_behavior_flow_prompt = new VibePromptBuilder().build({
  prompt: "Create a flow named ping-status",
  _mode: "full",
  _artifact_type: "flow",
  selection: prompt_builder_empty_selection,
  runtime_context: {
    _behavior_intent: {
      _behavior: "unknown",
    },
  },
});
assert.equal(unknown_behavior_flow_prompt.includes("BEHAVIOR INTENT INSTRUCTIONS:"), false);
assert.equal(unknown_behavior_flow_prompt.includes("Generate at least one concrete step"), false);
assert.equal(unknown_behavior_flow_prompt.includes("Prefer module \"entity-manager\" for server-side flow CRUD"), false);
assert.equal(unknown_behavior_flow_prompt.includes("account/user creation schemas"), false);

const refine_prompt = new VibePromptBuilder().build({
  prompt: plain_buttons_prompt,
  _mode: "refine",
  _artifact_type: "view",
  selection: {
    skill_ids: ["button"],
    skills: [
      {
        _id: "button",
        _type: "xui-object",
        _exports: {
          _xui_objects: ["button"],
        },
        _canonical_examples: [
          {
            _type: "button",
            _text: "Example",
          },
        ],
        _anti_patterns: [
          {
            _bad: "fragment-only refine response",
          },
        ],
      },
    ],
    diagnostics: [],
  },
  runtime_context: {
    _app_id: "app",
    _env: "default",
    _view_id: "main",
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "existing-card",
          _type: "card",
          _children: [
            {
              _type: "label",
              _text: "Existing",
            },
          ],
        },
      ],
    },
  },
});

assert.ok(refine_prompt.includes("Current View JSON:"));
assert.ok(refine_prompt.includes("User Edit Request:"));
assert.ok(refine_prompt.includes("Return the FULL updated view."));
assert.ok(refine_prompt.includes('"existing-card"'));
assert.ok(refine_prompt.includes("- card"));
assert.ok(refine_prompt.includes("Button click actions must be placed under _on._click."));
assert.ok(refine_prompt.includes('Object-targeted local nano commands may use { "_object": "target-id", "_op": "set-text", "_params": {} }.'));
assert.equal(refine_prompt.includes("Selected Skills:"), false);
assert.equal(refine_prompt.includes("canonical_examples"), false);
assert.equal(refine_prompt.includes("anti_patterns"), false);

const style_sheet_refine_prompt = new VibePromptBuilder().build({
  prompt: 'update view style-sheet and add class "calc-button"',
  _mode: "refine",
  _artifact_type: "view",
  selection: {
    skill_ids: ["style-sheet"],
    skills: [
      {
        _id: "style-sheet",
        _type: "xui-object",
        _description: "CSS-like styling object.",
        _fields: {
          _rules: "Style declarations keyed by CSS selector.",
        },
        _priority_rules: [
          "style-sheet first child",
        ],
        _core_rules: [
          "do not place class on style-sheet",
          "add class to target objects",
          "define .class rules inside _rules",
        ],
        _exports: {
          _xui_objects: ["style-sheet", "button"],
        },
        _canonical_examples: [
          {
            _type: "style-sheet",
            _rules: {
              ".calc-button": {
                padding: "12px",
              },
            },
          },
        ],
      },
    ],
    diagnostics: [],
  },
  runtime_context: {
    _app_id: "app",
    _env: "default",
    _view_id: "main",
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _type: "style-sheet",
          _id: "main-style",
          _rules: {},
        },
        {
          _type: "button",
          _id: "equals-button",
          _text: "=",
        },
      ],
    },
  },
});

const style_sheet_skill_index = style_sheet_refine_prompt.indexOf("SKILL style-sheet");
const current_view_index = style_sheet_refine_prompt.indexOf("Current View JSON:");

assert.ok(style_sheet_skill_index >= 0);
assert.ok(current_view_index > style_sheet_skill_index);
assert.ok(style_sheet_refine_prompt.includes("Fields: _rules"));
assert.ok(style_sheet_refine_prompt.includes('Ex: {"_type":"style-sheet","_rules":{".calc-button":{"padding":"12px"}}}'));
assert.ok(style_sheet_refine_prompt.includes("Rules: style-sheet first child | do not place class on style-sheet | add class to target objects"));
assert.ok(style_sheet_refine_prompt.indexOf("Fields: _rules") < style_sheet_refine_prompt.indexOf("Ex: "));
assert.ok(style_sheet_refine_prompt.indexOf("Ex: ") < style_sheet_refine_prompt.indexOf("Rules: "));
assert.equal(style_sheet_refine_prompt.includes("canonical_examples"), false);
assert.equal(style_sheet_refine_prompt.includes("anti_patterns"), false);

const missing_id_refine_prompt = new VibePromptBuilder({
  _max_refine_skill_prompt_chars: 350,
}).build({
  prompt: "refine description text",
  _mode: "refine",
  _artifact_type: "view",
  selection: {
    skill_ids: ["missing"],
    skills: [
      {
        _id: 42,
        _type: "xui-object",
        _description: "Description-only object.",
        _fields: {
          _text: "Visible text.",
        },
      } as any,
      {
        _id: "weak-skill",
        _type: "xui-object",
      },
    ],
    diagnostics: [],
  },
  runtime_context: {
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [],
    },
  },
});

const refine_guidance_start = missing_id_refine_prompt.indexOf("Refine Skill Guidance:");
const refine_guidance_end = missing_id_refine_prompt.indexOf("Current View JSON:");
const refine_guidance = missing_id_refine_prompt.slice(refine_guidance_start, refine_guidance_end);

assert.ok(missing_id_refine_prompt.includes("SKILL unknown: Description-only object."));
assert.ok(missing_id_refine_prompt.includes("Fields: _text"));
assert.ok(isWeakSkill({ _id: "weak-skill", _type: "xui-object" }));
assert.equal(isWeakSkill({
  _id: "style-sheet",
  _type: "xui-object",
  _priority_rules: ["style-sheet first child"],
}), false);
assert.ok(refine_guidance.length <= "Refine Skill Guidance:\n".length + 350 + "\n".length);

const ranking_skills = [
  {
    _id: "xpell-contract",
    _type: "contract",
    _description: "Core Xpell structural contract.",
  },
  {
    _id: "xui-core",
    _type: "view-skill",
    _description: "Core XUI view object structure.",
  },
  {
    _id: "style-sheet",
    _type: "xui-object",
    _description: "CSS-like styling object for classes colors background and rules.",
    _fields: {
      _rules: "CSS selector style rules.",
      class: "class belongs on target objects.",
    },
    _core_rules: [
      "do not place class on style-sheet",
      "add class to target objects",
    ],
    _canonical_examples: [
      {
        _type: "style-sheet",
        _rules: {
          ".calc-button": {
            padding: "12px",
          },
        },
      },
    ],
  },
  {
    _id: "button",
    _type: "xui-object",
    _description: "Clickable button action object.",
    _fields: {
      class: "CSS class on target button.",
      _text: "Visible label.",
    },
    _core_rules: [
      "Use button for clickable actions.",
    ],
  },
  {
    _id: "xfm-flow",
    _type: "flow-skill",
    _description: "Create and edit Xpell flows and workflow steps.",
    _core_rules: [
      "Flow steps are runtime commands.",
    ],
    _requires: ["xpell-contract"],
  },
  {
    _id: "xui-flow-trigger",
    _type: "xui-object",
    _description: "Trigger a flow from a UI button.",
    _core_rules: [
      "Use button click to trigger flow.",
    ],
    _requires: ["button"],
  },
  {
    _id: "xdb-entity",
    _type: "entity-skill",
    _description: "Create XDB entity schemas for users records.",
    _core_rules: [
      "Entity schemas use _fields.",
    ],
    _requires: ["xpell-contract"],
  },
  {
    _id: "entity-runtime",
    _type: "entity-skill",
    _description: "Entity runtime CRUD operations.",
    _core_rules: [
      "Use entity runtime for entity operations.",
    ],
    _requires: ["xdb-entity"],
  },
];

const ranked_style_ids = rankSkillsForPrompt(
  "add class calc-button to style-sheet",
  ranking_skills,
).map((item) => item.skill._id);
assert.deepEqual(ranked_style_ids, ["style-sheet", "button", "xui-core", "xpell-contract"]);

const ranked_flow_ids = rankSkillsForPrompt(
  "create login flow",
  ranking_skills,
).map((item) => item.skill._id);
assert.deepEqual(ranked_flow_ids, ["xfm-flow", "xui-flow-trigger", "button", "xui-core", "xpell-contract"]);

const ranked_entity_ids = rankSkillsForPrompt(
  "create users entity",
  ranking_skills,
).map((item) => item.skill._id);
assert.deepEqual(ranked_entity_ids, ["xdb-entity", "entity-runtime", "xpell-contract"]);

const budgeted_style_ids = budgetSkills(
  rankSkillsForPrompt("add class calc-button to style-sheet", ranking_skills),
  3000,
).map((item) => item.skill._id);
assert.deepEqual(budgeted_style_ids, ["style-sheet", "button", "xui-core", "xpell-contract"]);

const alias_context_rank = rankSkillsForPrompt(
  "refine existing view",
  [
    {
      _id: "button-runtime-skill",
      _type: "view-skill",
      _description: "Button runtime semantics.",
      _core_rules: [
        "Use button for actions.",
      ],
      _exports: {
        _xui_objects: ["button"],
      },
    },
  ],
  {
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _type: "button",
          _id: "save-button",
        },
      ],
    },
  },
);
assert.equal(alias_context_rank[0].skill._id, "button-runtime-skill");
assert.ok(alias_context_rank[0].reasons.includes("current-view-type"));

const exact_context_rank = rankSkillsForPrompt(
  "refine existing view",
  [
    {
      _id: "button",
      _type: "xui-object",
      _core_rules: [
        "Use button for actions.",
      ],
    },
  ],
  {
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _type: "button",
          _id: "save-button",
        },
      ],
    },
  },
);
assert.equal(exact_context_rank[0].skill._id, "button");
assert.ok(exact_context_rank[0].reasons.includes("current-view-type"));

const intent_planner = new VibeIntentPlanner();
const empty_capabilities = intent_planner.empty_runtime_capabilities();

const server_module_intent = intent_planner.infer_intent_plan(
  "Create server module aime-auth",
  {},
  empty_capabilities,
);
assert.equal(server_module_intent._intent_type, "module");
assert.deepEqual(server_module_intent._artifact_types, ["module"]);
assert.deepEqual(server_module_intent._entities, []);
assert.deepEqual(server_module_intent._actions, []);
assert.deepEqual(server_module_intent._bindings, []);
assert.deepEqual(server_module_intent._crud_ops, []);
assert.deepEqual(server_module_intent._flow_keywords, []);
assert.deepEqual(server_module_intent._entity_keywords, []);
assert.equal(server_module_intent._requires_module, true);
assert.equal(server_module_intent._module_target, "server");
assert.equal(server_module_intent._module_name, "aime-auth");

const server_module_login_intent = intent_planner.infer_intent_plan(
  "Create server module aime-auth. Operations: - _login",
  {},
  empty_capabilities,
);
assert.equal(server_module_login_intent._intent_type, "module");
assert.deepEqual(server_module_login_intent._entities, []);
assert.deepEqual(server_module_login_intent._actions, []);
assert.deepEqual(server_module_login_intent._module_ops, ["login"]);

const server_module_evaluate_intent = intent_planner.infer_intent_plan(
  "Create server module calc. Operations: - evaluate",
  {},
  empty_capabilities,
);
assert.equal(server_module_evaluate_intent._intent_type, "module");
assert.equal(server_module_evaluate_intent._module_name, "calc");
assert.deepEqual(server_module_evaluate_intent._entities, []);
assert.deepEqual(server_module_evaluate_intent._actions, []);
assert.deepEqual(server_module_evaluate_intent._module_ops, ["evaluate"]);

const module_only_intent = intent_planner.infer_intent_plan(
  "Module only",
  {},
  empty_capabilities,
);
assert.equal(module_only_intent._intent_type, "module");
assert.notEqual(module_only_intent._intent_type, "crud-app");
assert.deepEqual(module_only_intent._entities, []);
assert.deepEqual(module_only_intent._actions, []);
assert.deepEqual(module_only_intent._crud_ops, []);
assert.deepEqual(module_only_intent._flow_keywords, []);
assert.deepEqual(module_only_intent._entity_keywords, []);

const calculator_intent_missing = intent_planner.infer_intent_plan(
  "Create a calculator where equals calculates the math result",
  {},
  empty_capabilities,
);
assert.equal(calculator_intent_missing._requires_module, true);
assert.equal(calculator_intent_missing._module_target, "server");
assert.equal(calculator_intent_missing._module_name, "calc");
assert.deepEqual(calculator_intent_missing._module_ops, ["evaluate"]);

const calc_runtime_capabilities = intent_planner.extract_runtime_capabilities({
  _modules: [
    {
      _name: "calc",
      _ops: [
        {
          _name: "evaluate",
        },
      ],
    },
  ],
});
const calculator_intent_existing = intent_planner.infer_intent_plan(
  "Create a calculator where equals calculates the math result",
  {},
  calc_runtime_capabilities,
);
assert.equal(calculator_intent_existing._requires_module, false);
assert.ok(calculator_intent_existing._modules.includes("calc"));
assert.deepEqual(calculator_intent_existing._module_ops, ["evaluate"]);

const calculator_buttons_intent = intent_planner.infer_intent_plan(
  "Create a calculator button layout with display buttons only",
  {},
  empty_capabilities,
);
assert.equal(calculator_buttons_intent._requires_module, false);
assert.deepEqual(calculator_buttons_intent._module_ops, []);

const crud_intent = intent_planner.infer_intent_plan(
  "Create a customer records table with add update delete buttons using entity CRUD",
  {},
  intent_planner.extract_runtime_capabilities({
    _modules: [
      { _name: "xd", _ops: [{ _name: "set" }, { _name: "get" }] },
      { _name: "xem", _ops: [{ _name: "fire" }] },
      { _name: "entity-client", _ops: [{ _name: "add" }, { _name: "update" }, { _name: "delete" }] },
      { _name: "entity-manager", _ops: [{ _name: "find" }] },
    ],
  }),
);
assert.equal(crud_intent._requires_module, false);

const module_creator_work_folder =
  path.join(
    process.cwd(),
    "work",
    "module-creator-template-test",
  );
const module_creator =
  new XModuleCreatorModule({
    _work_folder: module_creator_work_folder,
  });
const tic_tac_toe_spec = {
  _id: "tic-tac-toe",
  _name: "tic-tac-toe",
  _target: "server" as const,
  _description: "Generated server module 'tic-tac-toe'.",
  _version: "0.1.0",
  _imports: [
    {
      _from: "@xpell/node",
    },
  ],
  _permissions: [],
  _ops: [
    {
      _name: "move",
      _description: "Generated operation 'move' for module 'tic-tac-toe'.",
      _params: {
        _input: "Optional input payload.",
      },
    },
    {
      _name: "reset",
      _description: "Generated operation 'reset' for module 'tic-tac-toe'.",
      _params: {
        _input: "Optional input payload.",
      },
    },
  ],
};
const tic_tac_toe_implementation_view = {
  _id: "main",
  _type: "view",
  _children: [
    {
      _id: "cell-0",
      _type: "button",
      _on: {
        click: {
          _module: "xvm",
          _op: "call-server",
          _params: {
            _cmd: {
              _module: "tic-tac-toe",
              _op: "move",
              _params: {
                index: 0,
              },
            },
          },
        },
      },
    },
    {
      _id: "reset",
      _type: "button",
      _on: {
        click: {
          _module: "xvm",
          _op: "call-server",
          _params: {
            _cmd: {
              _module: "tic-tac-toe",
              _op: "reset",
            },
          },
        },
      },
    },
  ],
};
const tic_tac_toe_implementation_prompt =
  build_generated_module_implementation_prompt({
    spec: tic_tac_toe_spec,
    user_request: "Create Tic Tac Toe server module.",
    originating_view: tic_tac_toe_implementation_view,
  });
assert.ok(tic_tac_toe_implementation_prompt.includes("Return strict JSON only."));
assert.ok(tic_tac_toe_implementation_prompt.includes('"_method": "_move"'));
assert.ok(tic_tac_toe_implementation_prompt.includes('"_method": "_reset"'));
assert.ok(tic_tac_toe_implementation_prompt.includes("Do not return full module.js."));
assert.ok(tic_tac_toe_implementation_prompt.includes('"index": 0'));

const original_execute_for_implementation = (_x as any).execute;
const implementation_commands: any[] = [];
try {
  (_x as any).execute = async (cmd: any) => {
    implementation_commands.push(cmd);

    if (cmd._module === "xai" && cmd._op === "generate") {
      return {
        _ok: true,
        _text: JSON.stringify({
          _methods: {
            _move: "_move(xcmd) { return { _ok: true, _result: { op: \"move\" } }; }",
            _reset: "_reset() { return { _ok: true, _result: { op: \"reset\" } }; }",
          },
        }),
      };
    }

    if (cmd._module === "module-creator" && cmd._op === "implement-generated-module") {
      return {
        _ok: true,
        _implemented_methods: Object.keys(cmd._params._context._methods),
        _validation: {
          _ok: true,
          _valid: true,
        },
      };
    }

    throw new Error(`Unexpected command: ${cmd._module}.${cmd._op}`);
  };

  const implementation_result =
    await (xvibe as any).implement_generated_module_from_spec({
      spec: tic_tac_toe_spec,
      user_request: "Create Tic Tac Toe server module.",
      originating_view: tic_tac_toe_implementation_view,
    });

  assert.deepEqual(
    implementation_commands.map((cmd) => `${cmd._module}.${cmd._op}`),
    [
      "xai.generate",
      "module-creator.implement-generated-module",
    ],
  );
  assert.equal((implementation_result as any)._validation._valid, true);
  assert.equal(
    implementation_commands[1]._params._context._methods._move.includes("module.js"),
    false,
  );
} finally {
  (_x as any).execute = original_execute_for_implementation;
}

const original_execute_for_implementation_fallback = (_x as any).execute;
const implementation_fallback_commands: any[] = [];
try {
  (_x as any).execute = async (cmd: any) => {
    implementation_fallback_commands.push(cmd);

    if (cmd._module === "xai" && cmd._op === "generate") {
      throw new Error("implementation unavailable");
    }

    throw new Error(`Unexpected command: ${cmd._module}.${cmd._op}`);
  };

  await assert.rejects(
    (xvibe as any).implement_generated_module_from_spec({
      spec: tic_tac_toe_spec,
      user_request: "Create Tic Tac Toe server module.",
      originating_view: tic_tac_toe_implementation_view,
    }),
    /Generated module implementation failed validation after bounded attempts/,
  );
  assert.deepEqual(
    implementation_fallback_commands.map((cmd) => `${cmd._module}.${cmd._op}`),
    [
      "xai.generate",
      "xai.generate",
      "xai.generate",
    ],
  );
} finally {
  (_x as any).execute = original_execute_for_implementation_fallback;
}

const original_execute_for_implementation_skeleton_fallback = (_x as any).execute;
try {
  (_x as any).execute = async (cmd: any) => {
    if (cmd._module === "xai" && cmd._op === "generate") {
      throw new Error("implementation unavailable");
    }

    throw new Error(`Unexpected command: ${cmd._module}.${cmd._op}`);
  };

  const fallback_result =
    await (xvibe as any).implement_generated_module_from_spec({
      spec: tic_tac_toe_spec,
      user_request: "Create Tic Tac Toe server module.",
      originating_view: tic_tac_toe_implementation_view,
      _allow_skeleton_fallback: true,
    });

  assert.equal(fallback_result._implemented, false);
  assert.equal(fallback_result._fallback, "skeleton");
  assert.equal(fallback_result._failure._ok, false);
} finally {
  (_x as any).execute = original_execute_for_implementation_skeleton_fallback;
}

const original_execute_for_implementation_retry = (_x as any).execute;
const implementation_retry_prompts: string[] = [];
const implementation_retry_methods: any[] = [];
try {
  (_x as any).execute = async (cmd: any) => {
    if (cmd._module === "xai" && cmd._op === "generate") {
      implementation_retry_prompts.push(cmd._params._prompt);
      const attempt = implementation_retry_prompts.length;

      return {
        _ok: true,
        _text: JSON.stringify({
          _methods: attempt === 1
            ? {
              _move: "_move() { // TODO implement here\\n return { _ok: true }; }",
              _reset: "_reset() { return { _ok: true }; }",
            }
            : {
              _move: "_move(xcmd) { const params = xcmd && typeof xcmd._params === \"object\" && xcmd._params !== null ? xcmd._params : {}; if (typeof params.index !== \"number\") { return { _ok: false, _error: { _code: \"E_BAD_INDEX\", _message: \"index is required\" } }; } return { _ok: true, _result: { index: params.index, accepted: true } }; }",
              _reset: "_reset() { this._state = { moves: [] }; return { _ok: true, _result: { reset: true, state: this._state } }; }",
            },
        }),
      };
    }

    if (cmd._module === "module-creator" && cmd._op === "implement-generated-module") {
      implementation_retry_methods.push(cmd._params._context._methods);

      if (implementation_retry_methods.length === 1) {
        return {
          _ok: false,
          _error: {
            _code: "E_MODULE_CREATOR_IMPLEMENTATION_PLACEHOLDER",
            _message: "Method replacement contains placeholder implementation text",
            _category: "placeholder_content",
            _details: {
              _method_name: "_move",
              _placeholders: ["TODO", "implement here"],
            },
          },
        };
      }

      return {
        _ok: true,
        _implemented_methods: Object.keys(cmd._params._context._methods),
        _validation: {
          _ok: true,
          _valid: true,
        },
      };
    }

    throw new Error(`Unexpected command: ${cmd._module}.${cmd._op}`);
  };

  const retry_result =
    await (xvibe as any).implement_generated_module_from_spec({
      spec: tic_tac_toe_spec,
      user_request: "Create Tic Tac Toe server module.",
      originating_view: tic_tac_toe_implementation_view,
    });

  assert.equal((retry_result as any)._validation._valid, true);
  assert.equal(implementation_retry_prompts.length, 2);
  assert.ok(implementation_retry_prompts[1].includes("Previous implementation was rejected for placeholder code."));
  assert.ok(implementation_retry_prompts[1].includes("Previous rejected method sources/excerpts:"));
  assert.ok(implementation_retry_prompts[1].includes("_current_or_generated_view"));
} finally {
  (_x as any).execute = original_execute_for_implementation_retry;
}

const created_tic_tac_toe_module =
  await module_creator._create_module_spec({
    _params: {
      _spec: tic_tac_toe_spec,
    },
  } as any);
assert.equal(created_tic_tac_toe_module._ok, true);

const tic_tac_toe_pending_registry =
  JSON.parse(
    await readFile(
      path.join(
        module_creator_work_folder,
        "generated",
        "xmodules",
        "registry.json",
      ),
      "utf-8",
    ),
  );
assert.equal(
  tic_tac_toe_pending_registry._modules["tic-tac-toe"]._state,
  "pending_implementation",
);
assert.equal(
  tic_tac_toe_pending_registry._modules["tic-tac-toe"]._autoload,
  false,
);
assert.equal(
  tic_tac_toe_pending_registry._modules["tic-tac-toe"]._implementation_complete,
  false,
);

const tic_tac_toe_module_js =
  await readFile(
    path.join(
      module_creator_work_folder,
      "generated",
      "xmodules",
      "tic-tac-toe",
      "module.js",
    ),
    "utf-8",
  );
assert.ok(tic_tac_toe_module_js.includes("class XTicTacToeModule"));
assert.ok(tic_tac_toe_module_js.includes('static _name = "tic-tac-toe";'));
assert.ok(tic_tac_toe_module_js.includes("static _ops = {"));
assert.ok(tic_tac_toe_module_js.includes('"move": {'));
assert.ok(tic_tac_toe_module_js.includes('"reset": {'));
assert.ok(tic_tac_toe_module_js.includes("  _move() {"));
assert.ok(tic_tac_toe_module_js.includes("  _reset() {"));

const tic_tac_toe_skill_block =
  /static _skill = \{([\s\S]*?)\n  \};/.exec(tic_tac_toe_module_js)?.[1] ?? "";
assert.ok(tic_tac_toe_skill_block.includes('"_ops": ['));
assert.ok(tic_tac_toe_skill_block.includes('"_name": "move"'));
assert.ok(tic_tac_toe_skill_block.includes('"_name": "reset"'));
assert.equal(tic_tac_toe_skill_block.includes("Object.values("), false);
assert.equal(tic_tac_toe_skill_block.includes("Object.keys("), false);
assert.equal(tic_tac_toe_skill_block.includes("Object.entries("), false);

const tic_tac_toe_validation =
  await module_creator._validate_generated_module({
    _params: {
      _id: "tic-tac-toe",
    },
  } as any);
if (!tic_tac_toe_validation._ok) {
  assert.fail(tic_tac_toe_validation._error._message);
}
assert.equal(tic_tac_toe_validation._valid, true);
assert.equal(
  (tic_tac_toe_validation._errors ?? []).some(
    (error: any) => error._code === "E_MODULE_CREATOR_FORBIDDEN_CONTENT",
  ),
  false,
);

const pending_tic_tac_toe_load =
  await module_creator._load_generated_module({
    _params: {
      _id: "tic-tac-toe",
    },
  } as any);
assert.equal(pending_tic_tac_toe_load._ok, false);
assert.equal(
  (pending_tic_tac_toe_load as any)._error._code,
  "E_MODULE_CREATOR_PENDING_IMPLEMENTATION",
);

const weak_tic_tac_toe_implementation =
  await module_creator._implement_generated_module({
    _params: {
      _id: "tic-tac-toe",
      _implementation_request: "Replace placeholders with a stub.",
      _context: {
        _methods: {
          _move: `_move(xcmd) {
            return xcmd._params;
          }`,
        },
      },
    },
  } as any);
assert.equal(weak_tic_tac_toe_implementation._ok, false);
assert.equal(
  (weak_tic_tac_toe_implementation as any)._error._code,
  "E_MODULE_CREATOR_IMPLEMENTATION_WEAK_BEHAVIOR",
);
assert.equal(
  (weak_tic_tac_toe_implementation as any)._error._category,
  "weak_behavior",
);

const implemented_tic_tac_toe_module =
  await module_creator._implement_generated_module({
    _params: {
      _id: "tic-tac-toe",
      _implementation_request: "Replace placeholders with neutral operation responses.",
      _context: {
        _methods: {
          _move: `_move(xcmd) {
            const params =
              xcmd && typeof xcmd._params === "object" && xcmd._params !== null
                ? xcmd._params
                : {};
            const index =
              typeof params.index === "number"
                ? params.index
                : Number(params.index);

            if (!Number.isInteger(index) || index < 0 || index > 8) {
              return {
                _ok: false,
                _error: {
                  _code: "E_TIC_TAC_TOE_INVALID_MOVE",
                  _message: "Move index must be an integer from 0 to 8."
                }
              };
            }

            const state =
              this._state && typeof this._state === "object"
                ? this._state
                : { board: Array(9).fill(null), next: "X" };

            if (!Array.isArray(state.board) || state.board.length !== 9) {
              state.board = Array(9).fill(null);
              state.next = "X";
            }

            if (state.board[index] !== null) {
              return {
                _ok: false,
                _error: {
                  _code: "E_TIC_TAC_TOE_CELL_OCCUPIED",
                  _message: "Cell is already occupied."
                }
              };
            }

            state.board[index] = state.next === "O" ? "O" : "X";
            state.next = state.board[index] === "X" ? "O" : "X";
            this._state = state;

            return {
              _ok: true,
              _result: {
                board: state.board,
                next: state.next,
                move: index
              }
            };
          }`,
          _reset: `_reset() {
            this._state = {
              board: Array(9).fill(null),
              next: "X"
            };

            return {
              _ok: true,
              _result: {
                board: this._state.board,
                next: this._state.next
              }
            };
          }`,
        },
      },
    },
  } as any);
if (!implemented_tic_tac_toe_module._ok) {
  assert.fail(implemented_tic_tac_toe_module._error._message);
}
assert.deepEqual(
  implemented_tic_tac_toe_module._implemented_methods.sort(),
  ["_move", "_reset"],
);
if (!implemented_tic_tac_toe_module._validation._ok) {
  assert.fail(implemented_tic_tac_toe_module._validation._error._message);
}
assert.equal(implemented_tic_tac_toe_module._validation._valid, true);

const implemented_tic_tac_toe_module_js =
  await readFile(
    path.join(
      module_creator_work_folder,
      "generated",
      "xmodules",
      "tic-tac-toe",
      "module.js",
    ),
    "utf-8",
  );
const implemented_tic_tac_toe_skill_block =
  /static _skill = \{([\s\S]*?)\n  \};/.exec(implemented_tic_tac_toe_module_js)?.[1] ?? "";
assert.equal(implemented_tic_tac_toe_skill_block, tic_tac_toe_skill_block);
assert.equal(implemented_tic_tac_toe_module_js.includes("Not implemented"), false);
assert.ok(implemented_tic_tac_toe_module_js.includes("const xcmd = arguments[0];"));
assert.ok(implemented_tic_tac_toe_module_js.includes("E_TIC_TAC_TOE_INVALID_MOVE"));
assert.ok(implemented_tic_tac_toe_module_js.includes("state.board[index] ="));
assert.ok(implemented_tic_tac_toe_module_js.includes("Array(9).fill(null)"));

const tic_tac_toe_implemented_registry =
  JSON.parse(
    await readFile(
      path.join(
        module_creator_work_folder,
        "generated",
        "xmodules",
        "registry.json",
      ),
      "utf-8",
    ),
  );
assert.equal(
  tic_tac_toe_implemented_registry._modules["tic-tac-toe"]._state,
  "implemented",
);
assert.equal(
  tic_tac_toe_implemented_registry._modules["tic-tac-toe"]._autoload,
  true,
);
assert.equal(
  tic_tac_toe_implemented_registry._modules["tic-tac-toe"]._implementation_complete,
  true,
);

const loaded_tic_tac_toe_module =
  await module_creator._load_generated_module({
    _params: {
      _id: "tic-tac-toe",
    },
  } as any);
if (!loaded_tic_tac_toe_module._ok) {
  assert.fail(loaded_tic_tac_toe_module._error._message);
}
assert.equal(loaded_tic_tac_toe_module._loaded, true);

const execution_order = (xvibe as any).build_execution_plan_for_intent(
  {
    _prompt: "calculator",
    _app_type: "tool",
    _logic_level: "none",
    _artifacts: ["view"],
    _requires_module: false,
    _capabilities: [],
  },
  calculator_intent_existing,
);
assert.deepEqual(
  execution_order.map((item: any) => item._artifact_type),
  ["flow", "view"],
);

const calc_expression_spec = (xvibe as any).build_server_module_spec({
  _module_target: "server",
  _module_name: "calc",
  _module_ops: [
    "evaluate",
    "evaluate_expression",
    "evaluate-expression",
    "calculate",
    "calculate_expression",
    "calculate-expression",
  ],
});
assert.deepEqual(calc_expression_spec._meta._op_behaviors, {
  evaluate: "safe_arithmetic_add_sub",
  evaluate_expression: "safe_arithmetic_add_sub",
  "evaluate-expression": "safe_arithmetic_add_sub",
  calculate: "safe_arithmetic_add_sub",
  calculate_expression: "safe_arithmetic_add_sub",
  "calculate-expression": "safe_arithmetic_add_sub",
});
assert.deepEqual(
  calc_expression_spec._ops.map((op: any) => op._name),
  [
    "evaluate",
    "evaluate_expression",
    "evaluate-expression",
    "calculate",
    "calculate_expression",
    "calculate-expression",
  ],
);

const original_execute = (_x as any).execute;
const original_get_skills = (_x as any).getSkills;
const original_get_module = (_x as any).getModule;

const missing_id_persist_view = {
  _type: "view",
  _children: [
    {
      _type: "label",
      _text: "Hello",
    },
    {
      _type: "button",
      _text: "Click",
    },
  ],
} as XVibeViewArtifact;
let persisted_missing_id_view: any;
try {
  (_x as any).execute = async (command: any) => {
    if (command?._module === "server-xvm" && command?._op === "push_update") {
      persisted_missing_id_view = command._params._view;
      return {
        _ok: true,
        _result: {},
      };
    }

    throw new Error(`Unexpected command ${JSON.stringify(command)}`);
  };

  const missing_id_persist_result = await (xvibe as any).persist_view_artifact({
    app_id: "missing-id-app",
    env: "default",
    mode: "full",
    prompt: "Create a simple view",
    runtime_skills: {
      _modules: [
        {
          _objects: [
            { _id: "view" },
            { _id: "label" },
            { _id: "button" },
          ],
        },
      ],
    },
    parsed_view: missing_id_persist_view,
    include_artifact_type: false,
  });

  assert.equal(missing_id_persist_result._ok, true);
  assert.deepEqual(collect_missing_xui_node_ids(persisted_missing_id_view), []);
  assert.equal(persisted_missing_id_view._id, "view-main");
  assert.equal(persisted_missing_id_view._children[0]._id, "label-1");
  assert.equal(persisted_missing_id_view._children[1]._id, "button-1");
  assert.ok((xvibe as any).collect_view_target_ids(persisted_missing_id_view).includes("label-1"));
} finally {
  (_x as any).execute = original_execute;
}

const generated_module_view: XVibeViewArtifact = {
  _id: "main",
  _type: "view",
  _children: [
    {
      _id: "equals",
      _type: "button",
      _text: "=",
      _on: {
        from_xd_underscore: {
          _module: "xd",
          _op: "_evaluate_expression",
          _params: {
            expression: "1 + 2 =",
          },
        },
        from_xd_plain: {
          _module: "xd",
          _op: "evaluate_expression",
          _params: {
            expression: "1 + 2 =",
          },
        },
        from_calc_underscore: {
          _module: "calc",
          _op: "_evaluate_expression",
          _params: {
            expression: "1 + 2 =",
          },
        },
        from_calc_plain: {
          _module: "calc",
          _op: "evaluate_expression",
          _params: {
            expression: "1 + 2 =",
          },
        },
        normal_xd: {
          _module: "xd",
          _op: "set",
          _params: {
            key: "calc:last",
            value: "unchanged",
          },
        },
        underscored_non_generated: {
          _module: "xd",
          _op: "_set",
          _params: {
            key: "calc:last",
            value: "unchanged",
          },
        },
      },
    },
  ],
};
let persisted_generated_module_view: any;
try {
  (_x as any).execute = async (command: any) => {
    if (command?._module === "server-xvm" && command?._op === "push_update") {
      persisted_generated_module_view = command._params._view;
      return {
        _ok: true,
        _result: {},
      };
    }

    throw new Error(`Unexpected command ${JSON.stringify(command)}`);
  };

  const persist_result = await (xvibe as any).persist_view_artifact({
    app_id: "calc-app",
    env: "default",
    mode: "full",
    prompt: "Create calculator equals button",
    runtime_skills: {
      _modules: [
        {
          _objects: [
            { _id: "view" },
            { _id: "button" },
          ],
        },
        {
          _name: "calc",
          _ops: [
            {
              _name: "evaluate_expression",
            },
          ],
          _skills: [
            {
              _core_rules: [
                "Generated module artifact derived from manifest.json.",
              ],
            },
          ],
        },
      ],
    },
    parsed_view: generated_module_view,
    include_artifact_type: false,
  });

  assert.equal(persist_result._ok, true);
  assert.equal(persisted_generated_module_view._children[0]._on.from_xd_underscore._module, "calc");
  assert.equal(persisted_generated_module_view._children[0]._on.from_xd_underscore._op, "evaluate_expression");
  assert.equal(persisted_generated_module_view._children[0]._on.from_xd_plain._module, "calc");
  assert.equal(persisted_generated_module_view._children[0]._on.from_xd_plain._op, "evaluate_expression");
  assert.equal(persisted_generated_module_view._children[0]._on.from_calc_underscore._module, "calc");
  assert.equal(persisted_generated_module_view._children[0]._on.from_calc_underscore._op, "evaluate_expression");
  assert.equal(persisted_generated_module_view._children[0]._on.from_calc_plain._module, "calc");
  assert.equal(persisted_generated_module_view._children[0]._on.from_calc_plain._op, "evaluate_expression");
  assert.equal(persisted_generated_module_view._children[0]._on.normal_xd._module, "xd");
  assert.equal(persisted_generated_module_view._children[0]._on.normal_xd._op, "set");
  assert.equal(persisted_generated_module_view._children[0]._on.underscored_non_generated._module, "xd");
  assert.equal(persisted_generated_module_view._children[0]._on.underscored_non_generated._op, "_set");
} finally {
  (_x as any).execute = original_execute;
}

const tic_tac_toe_view: XVibeViewArtifact = {
  _id: "main",
  _type: "view",
  _children: [
    {
      _id: "cell-0",
      _type: "button",
      _text: "X",
      _on: {
        _click: {
          _module: "xvm",
          _op: "call-server",
          _params: {
            _cmd: {
              _module: "tic-tac-toe",
              _op: "move",
              _params: {
                index: 0,
              },
            },
          },
        },
      },
    },
    {
      _id: "reset",
      _type: "button",
      _text: "Reset",
      _on: {
        _click: {
          _module: "xvm",
          _op: "call-server",
          _params: {
            _cmd: {
              _module: "tic-tac-toe",
              _op: "reset",
            },
          },
        },
      },
    },
  ],
};
const tic_module_specs: any[] = [];
let persisted_tic_tac_toe_view: any;
try {
  (_x as any).execute = async (command: any) => {
    if (command?._module === "module-creator" && command?._op === "create-module-spec") {
      tic_module_specs.push(command._params._spec);
      return {
        _ok: true,
        _result: {
          _ok: true,
          _saved: true,
          _id: command._params._spec._id,
          _name: command._params._spec._name,
        },
      };
    }

    if (command?._module === "module-creator" && command?._op === "load-generated-module") {
      return {
        _ok: true,
        _result: {
          _ok: true,
          _loaded: true,
          _id: command._params._id,
        },
      };
    }

    if (command?._module === "server-xvm" && command?._op === "push_update") {
      persisted_tic_tac_toe_view = command._params._view;
      return {
        _ok: true,
        _result: {},
      };
    }

    throw new Error(`Unexpected command ${JSON.stringify(command)}`);
  };
  (_x as any).getSkills = () => ({
    _modules: [
      {
        _name: "tic-tac-toe",
        _ops: [
          {
            _name: "move",
          },
          {
            _name: "reset",
          },
        ],
        _skills: [
          {
            _core_rules: [
              "Generated module artifact derived from manifest.json.",
            ],
            _exports: {
              _modules: [
                {
                  _name: "tic-tac-toe",
                  _ops: [
                    {
                      _name: "move",
                    },
                    {
                      _name: "reset",
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  });

  const persist_tic_result = await (xvibe as any).persist_view_artifact({
    app_id: "tic-app",
    env: "default",
    mode: "full",
    prompt: "Create tic tac toe",
    runtime_skills: {
      _modules: [
        {
          _objects: [
            { _id: "view" },
            { _id: "button" },
          ],
        },
      ],
    },
    parsed_view: tic_tac_toe_view,
    include_artifact_type: false,
  });

  assert.equal(persist_tic_result._ok, true);
  assert.equal(tic_module_specs.length, 1);
  assert.equal(tic_module_specs[0]._id, "tic-tac-toe");
  assert.equal(tic_module_specs[0]._name, "tic-tac-toe");
  assert.deepEqual(tic_module_specs[0]._ops.map((op: any) => op._name), ["move", "reset"]);
  assert.equal(
    persisted_tic_tac_toe_view._children[0]._on._click._params._cmd._module,
    "tic-tac-toe",
  );
  assert.equal(
    persisted_tic_tac_toe_view._children[1]._on._click._params._cmd._module,
    "tic-tac-toe",
  );
  assert.notEqual(tic_module_specs[0]._name, "generated-module");
} finally {
  (_x as any).execute = original_execute;
  (_x as any).getSkills = original_get_skills;
}

async function latest_vibe_run_dir(work_folder: string, app_id: string, env = "test") {
  const runs_dir =
    path.join(work_folder, "xvm", "apps", env, app_id, "vibe-runs");
  const entries = await readdir(runs_dir);
  assert.ok(entries.length > 0);
  entries.sort();
  return path.join(runs_dir, entries[entries.length - 1]);
}

const module_archive_work_folder =
  await mkdtemp(path.join(tmpdir(), "xvibe-module-archive-"));
try {
  (_x as any).getModule = (name: string) =>
    name === "server-xvm"
      ? { _work_folder: module_archive_work_folder }
      : typeof original_get_module === "function"
        ? original_get_module.call(_x, name)
        : undefined;
  (_x as any).getSkills = () => ({ _modules: [] });
  (_x as any).execute = async (command: any) => {
    if (command?._module === "module-creator" && command?._op === "create-module-spec") {
      return {
        _ok: true,
        _result: {
          _ok: true,
          _saved: true,
          _id: command._params._spec._id,
          _name: command._params._spec._name,
        },
      };
    }

    if (command?._module === "xai" && command?._op === "generate") {
      return {
        _ok: true,
        _text: JSON.stringify({
          _methods: {
            _login: "_login(xcmd) { return { _ok: true, _result: { authenticated: true } }; }",
          },
        }),
      };
    }

    if (command?._module === "module-creator" && command?._op === "implement-generated-module") {
      return {
        _ok: true,
        _implemented_methods: Object.keys(command._params._context._methods),
        _validation: {
          _ok: true,
          _valid: true,
        },
      };
    }

    if (command?._module === "module-creator" && command?._op === "load-generated-module") {
      return {
        _ok: true,
        _result: {
          _ok: true,
          _loaded: true,
          _id: command._params._id,
        },
      };
    }

    throw new Error(`Unexpected command ${JSON.stringify(command)}`);
  };

  const module_archive_prompt = [
    "Create server module aime-auth.",
    "",
    "Module only.",
    "",
    "Operations:",
    "- _login",
    "",
    "Do not create operation run.",
    "Do not create operation execute.",
    "Do not create operation process.",
  ].join("\n");
  const module_archive_result = await (xvibe as any).generate_artifact({
    _prompt: module_archive_prompt,
    _app_id: "module-archive-app",
    _env: "test",
    _generation_id: "module-archive-success",
  });
  assert.equal(module_archive_result._ok, true);
  assert.equal(module_archive_result._result._module_name, "aime-auth");
  assert.deepEqual(module_archive_result._result._module_ops, ["login"]);

  const run_dir =
    await latest_vibe_run_dir(module_archive_work_folder, "module-archive-app");
  const result_json = JSON.parse(
    await readFile(path.join(run_dir, "result.json"), "utf-8"),
  );
  assert.equal(result_json._success, true);
  assert.equal(result_json._artifact_type, "module");
  assert.equal(result_json._module_name, "aime-auth");
  assert.deepEqual(result_json._module_ops, ["login"]);
  const validation_json = JSON.parse(
    await readFile(path.join(run_dir, "validation.json"), "utf-8"),
  );
  assert.equal(validation_json._implementation_attempts.length, 1);
  assert.equal(validation_json._implementation_attempts[0]._module_name, "aime-auth");
  assert.deepEqual(validation_json._implementation_attempts[0]._module_ops, ["login"]);
  assert.ok(validation_json._implementation_attempts[0]._implementation_prompt.includes("aime-auth"));
  assert.deepEqual(
    Object.keys(validation_json._implementation_attempts[0]._parsed_method_sources),
    ["_login"],
  );
  assert.ok((await readFile(path.join(run_dir, "final-prompt.txt"), "utf-8")).includes("aime-auth"));
  assert.ok((await readFile(path.join(run_dir, "ai-output.json"), "utf-8")).includes("_login"));
  assert.ok((await readFile(path.join(run_dir, "summary.json"), "utf-8")).includes("module-archive-success"));
} finally {
  (_x as any).execute = original_execute;
  (_x as any).getSkills = original_get_skills;
  (_x as any).getModule = original_get_module;
  await rm(module_archive_work_folder, { recursive: true, force: true });
}

const module_archive_failure_work_folder =
  await mkdtemp(path.join(tmpdir(), "xvibe-module-archive-fail-"));
try {
  (_x as any).getModule = (name: string) =>
    name === "server-xvm"
      ? { _work_folder: module_archive_failure_work_folder }
      : typeof original_get_module === "function"
        ? original_get_module.call(_x, name)
        : undefined;
  (_x as any).getSkills = () => ({ _modules: [] });
  (_x as any).execute = async (command: any) => {
    if (command?._module === "module-creator" && command?._op === "create-module-spec") {
      return {
        _ok: true,
        _result: {
          _ok: true,
          _saved: true,
          _id: command._params._spec._id,
          _name: command._params._spec._name,
        },
      };
    }

    if (command?._module === "xai" && command?._op === "generate") {
      throw new Error("implementation unavailable");
    }

    throw new Error(`Unexpected command ${JSON.stringify(command)}`);
  };

  const failure_result = await (xvibe as any).generate_artifact({
    _prompt: [
      "Create server module aime-auth.",
      "Module only.",
      "Operations:",
      "- _login",
    ].join("\n"),
    _app_id: "module-archive-failure-app",
    _env: "test",
    _generation_id: "module-archive-failure",
  });
  assert.equal(failure_result._ok, false);
  assert.equal(failure_result._error._module_name, "aime-auth");
  assert.deepEqual(failure_result._error._module_ops, ["login"]);

  const failure_run_dir =
    await latest_vibe_run_dir(module_archive_failure_work_folder, "module-archive-failure-app");
  const failure_result_json = JSON.parse(
    await readFile(path.join(failure_run_dir, "result.json"), "utf-8"),
  );
  assert.equal(failure_result_json._success, false);
  assert.equal(failure_result_json._artifact_type, "module");
  assert.equal(failure_result_json._module_name, "aime-auth");
  assert.deepEqual(failure_result_json._module_ops, ["login"]);
  assert.equal(failure_result_json._attempts.length, 3);
  assert.equal(failure_result_json._attempts[0]._rejection_category, "syntax_or_shape_error");
  assert.ok((await readFile(path.join(failure_run_dir, "timeline.json"), "utf-8")).includes("Module generation failed"));
} finally {
  (_x as any).execute = original_execute;
  (_x as any).getSkills = original_get_skills;
  (_x as any).getModule = original_get_module;
  await rm(module_archive_failure_work_folder, { recursive: true, force: true });
}

const module_creator_calls: string[] = [];
try {
  (_x as any).execute = async (command: any) => {
    if (command?._module === "module-creator") {
      module_creator_calls.push(command._op);
      return {
        _ok: true,
        _result: {
          _ok: true,
          _id: command._params?._id ?? command._params?._spec?._id,
          _name: command._params?._spec?._name ?? "calc",
        },
      };
    }

    throw new Error(`Unexpected command ${JSON.stringify(command)}`);
  };
  (_x as any).getSkills = () => ({
    _modules: [
      {
        _name: "calc",
        _ops: [
          {
            _name: "evaluate",
          },
        ],
      },
    ],
  });

  const prepared_intent = await (xvibe as any).ensure_server_module_for_intent({
    app_id: "calc-app",
    env: "default",
    runtime_mode: "runtime",
    intent_plan: calculator_intent_missing,
  });

  assert.deepEqual(module_creator_calls, ["create-module-spec", "load-generated-module"]);
  assert.equal(prepared_intent._requires_module, false);
  assert.ok(prepared_intent._modules.includes("calc"));
} finally {
  (_x as any).execute = original_execute;
  (_x as any).getSkills = original_get_skills;
}

const entity_sync_work_folder = await mkdtemp(path.join(tmpdir(), "xvm-entity-sync-"));
try {
  XDB.init({
    storage: new XDBStorageFS({ xdbFolder: path.join(entity_sync_work_folder, "xdb") }),
    enableCache: false,
    workFolder: entity_sync_work_folder,
  });

  await _x.loadModuleAsync(XDB);
  await _x.loadModuleAsync(new XEntityManager());

  const hash_entity = XDB.create({
    _type: "xdb-entity",
    _id: "hash-users",
    _name: "hash-users",
    _schema: {
      _password_hash: {
        _type: "Hash",
      },
      _display_name: {
        _type: "String",
      },
    },
  }) as any;
  await hash_entity.waitUntilLoaded();

  const original_password = "initial-secret";
  const hash_record = await hash_entity.add({
    _password_hash: original_password,
    _display_name: "Ada",
  });
  assert.notEqual(hash_record._password_hash, original_password);
  assert.equal(
    await hash_entity.compareHashField(hash_record._password_hash, original_password),
    true,
  );

  const pre_hashed_password = hash_record._password_hash;
  const pre_hashed_record = await hash_entity.add({
    _password_hash: pre_hashed_password,
    _display_name: "Imported",
  });
  assert.equal(pre_hashed_record._password_hash, pre_hashed_password);

  const original_hash = hash_record._password_hash;
  const updated_password = "updated-secret";
  const hash_update_res = await hash_entity.update(
    { _id: hash_record._id },
    { _password_hash: updated_password },
  );
  assert.equal(hash_update_res._updated, 1);

  const password_updated_record = hash_entity.findById(hash_record._id);
  assert.notEqual(password_updated_record._password_hash, original_hash);
  assert.notEqual(password_updated_record._password_hash, updated_password);
  assert.equal(
    await hash_entity.compareHashField(password_updated_record._password_hash, updated_password),
    true,
  );

  const existing_bcrypt_hash = password_updated_record._password_hash;
  await hash_entity.update(
    { _id: hash_record._id },
    { _password_hash: existing_bcrypt_hash },
  );

  const skipped_hash_record = hash_entity.findById(hash_record._id);
  assert.equal(skipped_hash_record._password_hash, existing_bcrypt_hash);

  await hash_entity.update(
    { _id: hash_record._id },
    { _display_name: "Grace" },
  );

  const non_hash_updated_record = hash_entity.findById(hash_record._id);
  assert.equal(non_hash_updated_record._display_name, "Grace");
  assert.equal(non_hash_updated_record._password_hash, existing_bcrypt_hash);

  const contact_entity_v1 = {
    _id: "contacts",
    _schema: {
      _name: {
        _type: "String",
        _required: true,
      },
    },
  };

  const contact_register_v1 = await _x.execute({
    _module: "entity-manager",
    _op: "register",
    _params: {
      _app_id: "entity-sync-app",
      _env: "test",
      _entity: contact_entity_v1,
    },
  });
  assert.equal(contact_register_v1._ok, true);

  const contact_record = await _x.execute({
    _module: "entity-manager",
    _op: "add",
    _params: {
      _app_id: "entity-sync-app",
      _env: "test",
      _entity: "contacts",
      _data: {
        _name: "Ada",
      },
    },
  });
  assert.equal(contact_record._ok, true);

  const contact_entity_v2 = {
    _id: "contacts",
    _schema: {
      _name: {
        _type: "String",
        _required: true,
      },
      _email: {
        _type: "String",
      },
    },
  };

  const contact_register_v2 = await _x.execute({
    _module: "entity-manager",
    _op: "register",
    _params: {
      _app_id: "entity-sync-app",
      _env: "test",
      _entity: contact_entity_v2,
    },
  });
  assert.equal(contact_register_v2._ok, true);
  assert.equal(contact_register_v2._result._action, "update");

  const contact_schema_after_update = await _x.execute({
    _module: "entity-manager",
    _op: "get_schema",
    _params: {
      _app_id: "entity-sync-app",
      _env: "test",
      _entity_id: "contacts",
    },
  });
  assert.equal(contact_schema_after_update._ok, true);
  assert.equal(contact_schema_after_update._result.entity._schema._name._type, "String");
  assert.equal(contact_schema_after_update._result.entity._schema._email._type, "String");

  const contact_records_after_update = await _x.execute({
    _module: "entity-manager",
    _op: "find",
    _params: {
      _app_id: "entity-sync-app",
      _env: "test",
      _entity: "contacts",
      _filter: {},
    },
  });
  assert.equal(contact_records_after_update._result._records._data.length, 1);
  assert.equal(contact_records_after_update._result._records._data[0]._name, "Ada");

  const contact_unregister = await _x.execute({
    _module: "entity-manager",
    _op: "unregister",
    _params: {
      _app_id: "entity-sync-app",
      _env: "test",
      _entity_id: "contacts",
    },
  });
  assert.equal(contact_unregister._ok, true);
  assert.equal(contact_unregister._result._runtime_unregistered, true);

  const contact_has_after_unregister = await _x.execute({
    _module: "entity-manager",
    _op: "has",
    _params: {
      _app_id: "entity-sync-app",
      _env: "test",
      _entity_id: "contacts",
    },
  });
  assert.equal(contact_has_after_unregister._result._exists, false);

  const persisted_contact_records = JSON.parse(
    await readFile(
      path.join(entity_sync_work_folder, "xdb", "entities", "contacts", "_data.json"),
      "utf-8",
    ),
  );
  assert.equal(persisted_contact_records.length, 1);
  assert.equal(persisted_contact_records[0]._name, "Ada");

  const server_xvm = new ServerXVMModule({ _work_folder: entity_sync_work_folder });
  await _x.loadModuleAsync(server_xvm);

  await _x.execute({
    _module: "server-xvm",
    _op: "create_app",
    _params: {
      _app_id: "entity-sync-app",
      _env: "test",
    },
  });

  const users_entity_v1 = {
    _id: "users",
    _schema: {
      name: {
        _type: "String",
        _required: true,
      },
    },
  };

  const create_entity_res = await _x.execute({
    _module: "server-xvm",
    _op: "set_entity",
    _params: {
      _app_id: "entity-sync-app",
      _env: "test",
      _entity: users_entity_v1,
    },
  });
  assert.equal(create_entity_res._ok, true);

  const has_created_entity = await _x.execute({
    _module: "entity-manager",
    _op: "has",
    _params: {
      _app_id: "entity-sync-app",
      _env: "test",
      _entity_id: "users",
    },
  });
  assert.equal(has_created_entity._result._exists, true);

  const add_record_res = await _x.execute({
    _module: "entity-manager",
    _op: "add",
    _params: {
      _app_id: "entity-sync-app",
      _env: "test",
      _entity: "users",
      _data: {
        name: "Ada",
      },
    },
  });
  assert.equal(add_record_res._ok, true);
  assert.equal(add_record_res._result._record.name, "Ada");

  const users_entity_v2 = {
    _id: "users",
    _schema: {
      name: {
        _type: "String",
        _required: true,
      },
      email: {
        _type: "String",
        _index: {
          _unique: true,
        },
      },
    },
  };

  const update_entity_res = await _x.execute({
    _module: "server-xvm",
    _op: "set_entity",
    _params: {
      _app_id: "entity-sync-app",
      _env: "test",
      _entity: users_entity_v2,
    },
  });
  assert.equal(update_entity_res._ok, true);

  const updated_schema_res = await _x.execute({
    _module: "entity-manager",
    _op: "get_schema",
    _params: {
      _app_id: "entity-sync-app",
      _env: "test",
      _entity_id: "users",
    },
  });
  assert.equal(updated_schema_res._result.entity._schema.email._type, "String");

  const records_after_schema_update = await _x.execute({
    _module: "entity-manager",
    _op: "find",
    _params: {
      _app_id: "entity-sync-app",
      _env: "test",
      _entity: "users",
      _filter: {},
    },
  });
  assert.equal(records_after_schema_update._result._records._data.length, 1);
  assert.equal(records_after_schema_update._result._records._data[0].name, "Ada");

  await server_xvm.init_on_boot();
  await server_xvm.init_on_boot();

  const boot_schema_res = await _x.execute({
    _module: "entity-manager",
    _op: "get_schema",
    _params: {
      _app_id: "entity-sync-app",
      _env: "test",
      _entity_id: "users",
    },
  });
  assert.equal(boot_schema_res._result.entity._schema.email._type, "String");
  assert.equal(
    XDB._engine._xdb_data._entities.filter((entity_name: string) => entity_name === "users").length,
    1,
  );

  const delete_entity_res = await _x.execute({
    _module: "server-xvm",
    _op: "delete_entity",
    _params: {
      _app_id: "entity-sync-app",
      _env: "test",
      _entity_id: "users",
    },
  });
  assert.deepEqual(delete_entity_res._result, {
    _artifact_type: "entity",
    _action: "delete",
    _entity_id: "users",
    _runtime_unregistered: true,
  });

  const app_after_delete = await _x.execute({
    _module: "server-xvm",
    _op: "get_app",
    _params: {
      _app_id: "entity-sync-app",
      _env: "test",
    },
  });
  assert.deepEqual(app_after_delete._result._entity_ids, []);

  const has_deleted_entity = await _x.execute({
    _module: "entity-manager",
    _op: "has",
    _params: {
      _app_id: "entity-sync-app",
      _env: "test",
      _entity_id: "users",
    },
  });
  assert.equal(has_deleted_entity._result._exists, false);
  assert.equal(XDB._engine._xdb_data._entities.includes("users"), false);

  const persisted_records = JSON.parse(
    await readFile(
      path.join(entity_sync_work_folder, "xdb", "entities", "users", "_data.json"),
      "utf-8",
    ),
  );
  assert.equal(persisted_records.length, 1);
  assert.equal(persisted_records[0].name, "Ada");
} finally {
  await rm(entity_sync_work_folder, { recursive: true, force: true });
}

console.log("XVibe tests passed");
