import assert from "assert";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _x, XModule } from "@xpell/core";
import { apply_deterministic_view_edit } from "@xpell/vibe/XVIBE/XVibeModule.js";
import * as NodePackage from "./index.js";
import * as NodeCorePackage from "@xpell/node-core";
import FlowManagerModule from "./XFM/FlowManagerModule.js";
import { XEntityManager } from "./XEntityManager/XEntityManager.js";

type PlanningQuestionFixture = {
  _id: string;
  _type: "single" | "multi" | "text";
  _question: string;
  _options?: string[];
  _required?: boolean;
  _answer?: string | string[] | null;
  _suggestions?: string[];
};

async function run_node_core_compatibility_tests() {
  assert.equal(NodePackage.XEventManager, NodeCorePackage.XEventManager);
  assert.equal(NodePackage._xem, NodeCorePackage._xem);
  assert.equal(NodePackage.XSettings, NodeCorePackage.XSettings);
  assert.equal(NodePackage.Settings, NodeCorePackage.XSettings);
  assert.equal(NodePackage._xs, NodeCorePackage._xs);
  assert.equal(NodePackage.XUtils, NodeCorePackage.XUtils);
  assert.equal(NodePackage._xu, NodeCorePackage._xu);

  const event_name = `node-core:compat:${Date.now()}`;
  const event_payload = { _ok: true };
  let observed_payload: unknown;
  const listener_id = NodePackage._xem.on(event_name, (payload: unknown) => {
    observed_payload = payload;
  });

  try {
    await NodeCorePackage._xem.fire(event_name, event_payload);
    assert.equal(observed_payload, event_payload);
  } finally {
    NodePackage._xem.remove(listener_id);
  }

  const work_folder = await mkdtemp(path.join(tmpdir(), "xnode-core-settings-"));
  const settings_file = path.join(work_folder, "settings", "server-settings.json");
  const settings = new NodeCorePackage._XSettings();
  const loaded_settings = new NodeCorePackage._XSettings();

  try {
    settings.onSetup(work_folder);
    settings.set("compat", { _ok: true });
    assert.deepEqual(
      JSON.parse(await readFile(settings_file, "utf-8")).compat,
      { _ok: true },
    );
    assert.equal(loaded_settings.load(settings_file), true);
    assert.deepEqual(loaded_settings.get("compat"), { _ok: true });
  } finally {
    settings.close();
    loaded_settings.close();
    await rm(work_folder, { recursive: true, force: true });
  }

  const encoded = NodePackage._xu.encode("hello node core");
  assert.equal(NodeCorePackage._xu.decode(encoded), "hello node core");

  const utils_folder = await mkdtemp(path.join(tmpdir(), "xnode-core-utils-"));
  try {
    const nested_folder = path.join(utils_folder, "a", "b");
    NodePackage._xu.checkFolders([nested_folder]);
    assert.equal((await stat(nested_folder)).isDirectory(), true);
  } finally {
    await rm(utils_folder, { recursive: true, force: true });
  }

  assert.equal((NodePackage._xu as any).is_plain_object({ _ok: true }), true);
}

function find_json_object_by_id(value: unknown, id: string): any {
  if (!value || typeof value !== "object") return null;
  if ((value as any)._id === id) return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = find_json_object_by_id(item, id);
      if (found) return found;
    }
    return null;
  }
  for (const item of Object.values(value as Record<string, unknown>)) {
    const found = find_json_object_by_id(item, id);
    if (found) return found;
  }
  return null;
}

async function run_operations_starter_image_contract_tests() {
  const starter_view_path = path.resolve(
    process.cwd(),
    "system-xapps",
    "app-starters",
    "dashboard",
    "views",
    "main.json",
  );
  const view = JSON.parse(await readFile(starter_view_path, "utf-8"));
  const sidebar = find_json_object_by_id(view, "dashboard-sidebar");
  const settings_card = find_json_object_by_id(view, "dashboard-settings-card");

  assert.ok(sidebar, "dashboard-sidebar missing from Operations starter");
  assert.ok(settings_card, "dashboard-settings-card missing from Operations starter");
  assert.equal(sidebar._logo?._type, "image");
  assert.equal(sidebar._logo?._id, "dashboard-sidebar-logo");
  assert.equal(sidebar._logo?.src, "assets/logo.svg");
  assert.equal(sidebar._logo?.alt, "Xpell Dashboard Starter logo");
  assert.equal(settings_card._image?._type, "image");
  assert.equal(settings_card._image?._id, "dashboard-settings-card-image");
  assert.equal(settings_card._image?.src, "assets/placeholder-record.svg");
  assert.equal(settings_card._image?.alt, "Dashboard placeholder");
}

class XNodeCompositionTestModule extends XModule {
  constructor(name: string) {
    super({ _name: name });
  }
}

function create_fake_xnode_web_server_for_test() {
  return {
    onSetup() {},
    init() {},
    load() {},
    async start() {
      return "test web server started";
    },
  };
}

async function run_xnode_generic_composition_tests() {
  const original_load_module_async = (_x as any).loadModuleAsync;
  const original_start = (_x as any).start;
  const loaded_modules: string[] = [];

  (_x as any).loadModuleAsync = async (mod: XModule) => {
    loaded_modules.push(mod._name);
  };
  (_x as any).start = () => {};

  async function start_xnode_for_composition_test(options: { _modules?: XModule[] } = {}) {
    loaded_modules.length = 0;
    const work_folder = await mkdtemp(path.join(tmpdir(), "xnode-composition-"));
    const node = new NodePackage.XNode();
    (node as any)._web_server = create_fake_xnode_web_server_for_test();

    try {
      await node.start({
        _work_folder: work_folder,
        _modules: options._modules,
      });
      return {
        _work_folder: work_folder,
        _loaded_modules: [...loaded_modules],
      };
    } catch (err) {
      NodeCorePackage._xs.close();
      await rm(work_folder, { recursive: true, force: true });
      throw err;
    }
  }

  try {
    const default_startup = await start_xnode_for_composition_test();
    try {
      assert.deepEqual(
        default_startup._loaded_modules,
        [
          "xdb",
          "ping",
          "wormholes",
          "xauth",
          "xai",
          "module-creator",
          "xmutator",
          "flow",
          "entity-manager",
          "planning",
          "studio",
          "server-xvm",
        ],
      );
      assert.equal(default_startup._loaded_modules.includes("xvibe"), false);
    } finally {
      NodeCorePackage._xs.close();
      await rm(default_startup._work_folder, { recursive: true, force: true });
    }

    const custom_module = new XNodeCompositionTestModule("custom-app-module");
    const custom_startup = await start_xnode_for_composition_test({
      _modules: [custom_module],
    });
    try {
      assert.ok(custom_startup._loaded_modules.includes("custom-app-module"));
      assert.equal(custom_startup._loaded_modules.indexOf("custom-app-module"), 7);
      assert.equal(custom_startup._loaded_modules.includes("xvibe"), false);
      assert.equal(custom_startup._loaded_modules[8], "flow");
      assert.equal(custom_startup._loaded_modules[10], "planning");
    } finally {
      NodeCorePackage._xs.close();
      await rm(custom_startup._work_folder, { recursive: true, force: true });
    }

    await assert.rejects(
      async () => {
        await start_xnode_for_composition_test({
          _modules: [
            new XNodeCompositionTestModule("duplicate-app-module"),
            new XNodeCompositionTestModule("duplicate-app-module"),
          ],
        });
      },
      (err: any) => {
        assert.equal(err?._ok, false);
        assert.equal(err?._code, "E_XNODE_DUPLICATE_MODULES");
        assert.deepEqual(err?._details?._duplicates, ["duplicate-app-module"]);
        assert.deepEqual(err?.toXData?.(), {
          _ok: false,
          _error: {
            _code: "E_XNODE_DUPLICATE_MODULES",
            _message: "XNode.start option '_modules' contains duplicate module names.",
            _details: {
              _duplicates: ["duplicate-app-module"],
            },
          },
        });
        return true;
      },
    );

    assert.equal(loaded_modules.length, 0);
  } finally {
    (_x as any).loadModuleAsync = original_load_module_async;
    (_x as any).start = original_start;
  }
}

function planning_question(
  overrides: PlanningQuestionFixture = {
    _id: "primary_user",
    _type: "single",
    _question: "Who will use it?",
    _options: ["Personal user", "Team"],
  },
) {
  return {
    _id: overrides._id,
    _type: overrides._type,
    _question: overrides._question,
    ...(overrides._options ? { _options: overrides._options } : {}),
    ...(overrides._suggestions ? { _suggestions: overrides._suggestions } : {}),
    _required: overrides._required ?? true,
    _answer: overrides._answer ?? null,
  };
}

function planning_state(overrides: Record<string, unknown> = {}) {
  const first_question = planning_question();
  return {
    _contract_version: NodePackage.XNODE_XVIBE_PLANNING_CONTRACT_VERSION,
    _type: "project-plan",
    _stage: "planning",
    _status: "awaiting-answer",
    _app_archetype: "personal-list",
    _scope: "personal",
    _goal: "Build a personal shopping list",
    _questions: [first_question],
    _answers: {},
    _unanswered: ["primary_user"],
    _current_question: first_question,
    _proposed: {
      _entities: [{ _id: "shopping_item", _title: "Shopping Item" }],
      _views: [{ _id: "list", _title: "List" }],
      _flows: [{ _id: "add-item", _title: "Add Item" }],
      _server_modules: [],
    },
    ...overrides,
  };
}

function shopping_list_plan(overrides: Record<string, unknown> = {}) {
  const list_structure_question = {
    _id: "list_structure",
    _type: "single_choice",
    _question: "How should shopping lists be organized?",
    _required: true,
    _options: [
      { _id: "single", _label: "Single list" },
      { _id: "multiple_named", _label: "Multiple named lists" },
    ],
    _answer: "single",
    _answer_state: "confirmed",
    _affected_plan_sections: ["entities", "views", "flows", "milestones"],
  };
  const sync_question = {
    _id: "sync_behavior",
    _type: "single_choice",
    _question: "Should the list sync across devices?",
    _required: false,
    _options: [
      { _id: "local_only", _label: "Local only" },
      { _id: "cloud_sync", _label: "Cloud sync" },
    ],
  };
  const list_item_fields_question = {
    _id: "list_item_fields",
    _type: "multiple_choice",
    _question: "Which item fields should be included?",
    _required: true,
    _options: [
      { _id: "name", _label: "Name" },
      { _id: "quantity", _label: "Quantity" },
      { _id: "status", _label: "Status" },
    ],
    _answer: ["name", "quantity", "status"],
    _answer_state: "confirmed",
  };
  const completed_item_behavior_question = {
    _id: "completed_item_behavior",
    _type: "single_choice",
    _question: "What should happen when an item is completed?",
    _required: true,
    _options: [
      { _id: "mark_purchased", _label: "Mark purchased" },
      { _id: "archive", _label: "Archive" },
    ],
    _answer: "mark_purchased",
    _answer_state: "confirmed",
  };

  return {
    _type: "project-plan",
    _contract_version: NodePackage.XNODE_XVIBE_PLANNING_CONTRACT_VERSION,
    _selected_app_type: "custom",
    _inferred_archetype: "personal_list",
    _scope: "personal",
    _goal: "Build a personal shopping list app",
    _summary: "Track shopping items and mark them as purchased.",
    _initial_vision: "I want to build a shopping list for myself",
    _planning_status: "complete",
    _stage: "planning",
    _status: "ready-for-confirmation",
    _facts: [
      {
        _id: "primary_user",
        _label: "Primary user",
        _value: "Self",
        _state: "inferred",
        _source: "initial_vision",
        _question_id: "primary_user",
      },
    ],
    _assumptions: [
      {
        _id: "sharing",
        _label: "Sharing",
        _value: "Single-user first version",
        _state: "default",
      },
    ],
    _answers: {
      list_structure: {
        _question_id: "list_structure",
        _value: "single",
        _state: "confirmed",
        _source: "planning_answer_application",
      },
      list_item_fields: {
        _question_id: "list_item_fields",
        _value: ["name", "quantity", "status"],
        _state: "confirmed",
        _source: "planning_answer_application",
      },
      completed_item_behavior: {
        _question_id: "completed_item_behavior",
        _value: "mark_purchased",
        _state: "confirmed",
        _source: "planning_answer_application",
      },
    },
    _questions: [
      list_structure_question,
      list_item_fields_question,
      completed_item_behavior_question,
      sync_question,
    ],
    _current_question: null,
    _proposed_entities: [
      { _id: "shopping_item", _title: "Shopping Item", _fields: ["name", "status"] },
    ],
    _proposed_views: [
      { _id: "shopping_list", _title: "Shopping List" },
    ],
    _proposed_flows: [
      { _id: "add_shopping_item", _title: "Add Shopping Item" },
      { _id: "mark_purchased", _title: "Mark Purchased" },
    ],
    _proposed_modules: [],
    _capabilities: [],
    _milestones: [
      {
        _id: "working_shopping_list",
        _title: "Working Shopping List",
        _items: ["Shopping item model", "List view", "Add and complete flows"],
      },
    ],
    _warnings: [],
    _proposed: {
      _entities: [
        { _id: "shopping_item", _title: "Shopping Item", _fields: ["name", "status"] },
      ],
      _views: [
        { _id: "shopping_list", _title: "Shopping List" },
      ],
      _flows: [
        { _id: "add_shopping_item", _title: "Add Shopping Item" },
        { _id: "mark_purchased", _title: "Mark Purchased" },
      ],
      _server_modules: [],
    },
    ...overrides,
  };
}

function incomplete_shopping_list_plan() {
  const plan = shopping_list_plan();
  const list_structure_question = (plan._questions as any[])[0];
  return {
    ...plan,
    _planning_status: "awaiting_answer",
    _status: "collecting-information",
    _answers: {},
    _questions: [
      {
        ...list_structure_question,
        _answer: null,
        _answer_state: undefined,
      },
      (plan._questions as any[])[1],
    ],
    _current_question: list_structure_question,
    _unanswered_required_question_ids: ["list_structure"],
  };
}

function assert_planning_error(
  fn: () => unknown,
  code: string,
) {
  assert.throws(
    fn,
    (err: unknown) => {
      assert.equal((err as any)?._code, code);
      return true;
    },
  );
}

async function run_xnode_planning_contract_tests() {
  const personal = NodePackage.normalize_xvibe_planning_state(planning_state());
  assert.equal(personal._contract_version, 1);
  assert.equal(personal._app_archetype, "personal-list");
  assert.equal(personal._scope, "personal");
  assert.equal(personal._proposed._entities[0] && (personal._proposed._entities[0] as any)._id, "shopping_item");

  const business_question = planning_question({
    _id: "primary_user",
    _type: "single",
    _question: "Who owns customer records?",
    _options: ["Sales", "Support"],
  });
  const business = NodePackage.normalize_xvibe_planning_state(planning_state({
    _app_archetype: "business-app",
    _scope: "business",
    _domain: "crm",
    _goal: "Build a CRM",
    _questions: [business_question],
    _unanswered: ["primary_user"],
    _current_question: business_question,
    _proposed: {
      _entities: [{ _id: "customer" }],
      _views: [{ _id: "dashboard" }],
      _flows: [{ _id: "create-customer" }],
      _server_modules: [],
    },
  }));
  assert.equal(business._app_archetype, "business-app");
  assert.equal(business._domain, "crm");

  const custom_personal = NodePackage.normalize_xvibe_planning_state(planning_state({
    _metadata: { _selected_type: "Custom" },
    _app_archetype: "personal-list",
    _scope: "personal",
  }));
  assert.equal(custom_personal._metadata._selected_type, "Custom");
  assert.equal(custom_personal._app_archetype, "personal-list");
  assert.equal(custom_personal._scope, "personal");

  assert_planning_error(
    () => NodePackage.normalize_xvibe_planning_state({
      _contract_version: 1,
      _type: "project-plan",
      _stage: "planning",
      _status: "awaiting-answer",
    }),
    NodePackage.XNODE_PLANNING_ERR.INVALID_XVIBE_PLANNING_RESPONSE,
  );

  assert_planning_error(
    () => NodePackage.normalize_xvibe_planning_state(planning_state({
      _contract_version: 999,
    })),
    NodePackage.XNODE_PLANNING_ERR.UNSUPPORTED_CONTRACT_VERSION,
  );

  assert_planning_error(
    () => NodePackage.normalize_xvibe_planning_state(planning_state({
      _current_question: null,
    })),
    NodePackage.XNODE_PLANNING_ERR.INVALID_XVIBE_PLANNING_RESPONSE,
  );

  const single_choice = planning_state();
  assert_planning_error(
    () => NodePackage.validate_xvibe_planning_answer({
      _planning_state: single_choice,
      _question_id: "primary_user",
      _answer: "Sales",
    }),
    NodePackage.XNODE_PLANNING_ERR.INVALID_QUESTION_ANSWER,
  );

  const legacy_question = planning_question({
    _id: "primary_user",
    _type: "single",
    _question: "Who will use it?",
    _suggestions: ["Personal user", "Team"],
  });
  const legacy = NodePackage.normalize_xvibe_planning_state({
    _type: "project-plan",
    _stage: "planning",
    _status: "collecting-information",
    _questions: [legacy_question],
    _answers: {},
    _unanswered: ["primary_user"],
    _current_question: { _id: "primary_user" },
  });
  assert.equal(legacy._contract_version, 1);
  assert.deepEqual(legacy._questions[0]._options, ["Personal user", "Team"]);
  assert.equal(legacy._compatibility?._legacy_project_plan, true);
  assert.deepEqual(legacy._proposed, {
    _entities: [],
    _views: [],
    _flows: [],
    _server_modules: [],
  });

  const neutral_custom = NodePackage.normalize_xvibe_planning_state({
    _contract_version: 1,
    _type: "project-plan",
    _stage: "planning",
    _status: "awaiting-answer",
    _app_archetype: "personal-list",
    _scope: "unknown",
    _questions: [planning_question()],
    _answers: {},
    _unanswered: ["primary_user"],
    _current_question: { _id: "primary_user" },
  });
  assert.equal(neutral_custom._scope, "unknown");
  assert.equal(neutral_custom._domain, undefined);
  assert.deepEqual(neutral_custom._proposed._entities, []);
  assert.deepEqual(neutral_custom._proposed._views, []);

  const complete_shopping = NodePackage.normalize_xvibe_planning_state(
    shopping_list_plan(),
  );
  assert.equal(complete_shopping._ready, true);
  assert.deepEqual(complete_shopping._runtime_lifecycle, {
    _status: "planning",
    _phase: "ready-for-confirmation",
    _planning_status: "ready-for-confirmation",
    _plan_ready: true,
    _confirmed: false,
    _guide_available: false,
    _executable_guide_actions_available: false,
  });
  assert.equal(complete_shopping._selected_app_type, "custom");
  assert.equal(complete_shopping._inferred_archetype, "personal_list");
  assert.equal(complete_shopping._scope, "personal");
  assert.equal(complete_shopping._summary._goal, "Build a personal shopping list app");
  assert.deepEqual(complete_shopping._summary._proposed_entities, ["shopping_item"]);
  assert.deepEqual(complete_shopping._summary._proposed_views, ["shopping_list"]);
  assert.deepEqual(complete_shopping._summary._proposed_flows, ["add_shopping_item", "mark_purchased"]);
  assert.ok(
    complete_shopping._warnings.some(
      (warning: any) => warning._id === "optional_decision_unresolved:sync_behavior",
    ),
  );

  const incomplete_shopping = NodePackage.normalize_xvibe_planning_state(
    incomplete_shopping_list_plan(),
  );
  assert.equal(incomplete_shopping._ready, false);
  assert.deepEqual(incomplete_shopping._runtime_lifecycle, {
    _status: "planning",
    _phase: "collecting-decisions",
    _planning_status: "collecting-information",
    _plan_ready: false,
    _confirmed: false,
    _guide_available: false,
    _executable_guide_actions_available: false,
  });
  assert.ok(
    incomplete_shopping._blockers.some(
      (blocker: any) => blocker._id === "current_question_active",
    ),
  );
  assert.ok(
    incomplete_shopping._blockers.some(
      (blocker: any) => blocker._id === "required_decision_unresolved:list_structure",
    ),
  );

  assert_planning_error(
    () => NodePackage.validate_xvibe_planning_readiness({
      _type: "xvibe-initial-planning-confirmation-readiness",
      _ready: "yes",
    }),
    NodePackage.XNODE_PLANNING_ERR.MALFORMED_XVIBE_READINESS,
  );
  assert_planning_error(
    () => NodePackage.validate_xvibe_planning_readiness({
      ...NodePackage.evaluate_xvibe_planning_readiness(shopping_list_plan()),
      _normalized_plan: undefined,
    }),
    NodePackage.XNODE_PLANNING_ERR.MALFORMED_XVIBE_READINESS,
  );

  const legacy_ready = NodePackage.normalize_xvibe_planning_state({
    ...shopping_list_plan({
      _contract_version: undefined,
      _domain: "personal-list",
      _selected_app_type: undefined,
      _inferred_archetype: undefined,
      _planning_status: undefined,
      _questions: [
        planning_question({
          _id: "list_structure",
          _type: "single",
          _question: "How should shopping lists be organized?",
          _options: ["Single list", "Multiple named lists"],
          _answer: "Single list",
        }),
        planning_question({
          _id: "list_item_fields",
          _type: "multi",
          _question: "Which item fields should be included?",
          _options: ["Name", "Quantity", "Status"],
          _answer: ["Name", "Quantity", "Status"],
        }),
        planning_question({
          _id: "completed_item_behavior",
          _type: "single",
          _question: "What should happen when an item is completed?",
          _options: ["Mark purchased", "Archive"],
          _answer: "Mark purchased",
        }),
      ],
      _answers: {
        list_structure: "Single list",
        list_item_fields: ["Name", "Quantity", "Status"],
        completed_item_behavior: "Mark purchased",
      },
      _current_question: null,
    }),
  });
  assert.equal(legacy_ready._compatibility?._legacy_project_plan, true);
  assert.equal(legacy_ready._ready, true);

  const no_fallback = NodePackage.normalize_xvibe_planning_state(planning_state({
    _domain: "generic-business",
    _proposed: {
      _entities: [],
      _views: [],
      _flows: [],
      _server_modules: [],
    },
  }));
  assert.equal(no_fallback._ready, false);
  assert.deepEqual(no_fallback._proposed._entities, []);
  assert.ok(
    no_fallback._blockers.some(
      (blocker: any) => blocker._id === "proposed_entities_missing",
    ),
  );

  const original_execute = (_x as any).execute;
  const planning_module = new NodePackage.XPlanningModule();
  try {
    const execute_calls: any[] = [];
    const semantic_plan_ref = {
      _type: "xvibe-semantic-generation-plan",
      _version: "0.1.0",
      _source: "confirmed_initial_plan",
    };
    let mock_project_memory: any = {
      _stage: "building",
      _confirmed_initial_plan: shopping_list_plan(),
      _semantic_generation_plan: {
        ...semantic_plan_ref,
        _entities: [
          {
            _entity_id: "shopping_item",
            _title: "Shopping Item",
            _fields: [
              { _name: "name" },
              { _name: "quantity" },
              { _name: "status" },
            ],
          },
        ],
      },
      _current_focus: "Working Shopping List",
      _milestones: [
        {
          _id: "working-shopping-list",
          _title: "Working Shopping List",
          _items: [
            {
              _id: "shopping-item-crud",
              _title: "Shopping Item CRUD",
              _completed: false,
              _semantic_type: "crud",
              _artifact_type: "crud",
              _entity_id: "shopping_item",
              _entity_name: "shopping_item",
            },
            {
              _id: "mark-purchased",
              _title: "Add Mark Purchased behavior",
              _completed: false,
              _semantic_type: "flow",
              _artifact_type: "flow",
              _entity_id: "shopping_item",
              _flow_id: "mark-shopping-item-purchased",
            },
          ],
        },
      ],
      _completed: [],
      _achievements: [],
    };
    let mock_guide_recommendation: any = {
      _title: "Add Shopping Item CRUD",
      _reason: "Current focus is Working Shopping List.",
      _type: "crud",
      _priority: 100,
      _semantic_plan_ref: semantic_plan_ref,
      _expected_artifacts: [
        { _artifact_type: "entity", _id: "shopping_item" },
        { _artifact_type: "flow", _id: "create-shopping_item" },
        { _artifact_type: "view", _id: "shopping_item-form" },
        { _artifact_type: "view", _id: "shopping_item-list" },
      ],
      _action: {
        _prompt: "Add Shopping Item CRUD.",
        _semantic_plan_ref: semantic_plan_ref,
        _artifact_type: "entity",
        _artifact_request: {
          _graph_type: "crud",
          _entity_name: "shopping_item",
          _fields: [
            { _name: "name" },
            { _name: "quantity" },
            { _name: "status" },
          ],
        },
        _execution_payload: {
          _module: "xvibe",
          _op: "execute-execution-graph",
          _params: {
            _app_id: "shopping-app",
            _env: "test",
            _graph_type: "crud",
            _entity_name: "shopping_item",
            _fields: [
              { _name: "name" },
              { _name: "quantity" },
              { _name: "status" },
            ],
          },
        },
        _resolution: {
          _type: "execution-capability",
          _source: "execution-capability-registry",
          _confidence: 0.9,
          _capability_id: "entity-crud",
          _module: "xvibe",
          _op: "execute-execution-graph",
          _supported: true,
        },
      },
    };
    const next_guide_recommendation: any = {
      _title: "Add Mark Purchased behavior",
      _reason: "Shopping Item CRUD foundation exists.",
      _type: "flow",
      _priority: 90,
      _semantic_plan_ref: semantic_plan_ref,
      _action: {
        _prompt: "Add Mark Purchased behavior.",
        _semantic_plan_ref: semantic_plan_ref,
        _resolution: {
          _type: "runtime-module-op",
          _source: "runtime-skill-registry",
          _confidence: 0.8,
          _module: "xvibe",
          _op: "apply-artifact-request",
          _supported: true,
        },
      },
    };
    let mock_guide_state: any = { _available: true, _reason: "ready" };
    let guide_crud_execution_count = 0;
    (_x as any).execute = async (cmd: any) => {
      execute_calls.push(cmd);
      if (cmd._module === "xvibe" && cmd._op === "analyze-message") {
        return {
          _ok: true,
          _result: {
            _intent: {
              _artifact_type: "project-plan",
              _artifact_request: shopping_list_plan(),
            },
          },
        };
      }
      if (cmd._module === "xvibe" && cmd._op === "get-conversation") {
        return {
          _ok: true,
          _result: {
            _conversation: {
              _id: "planning-chat",
              _planning_draft: shopping_list_plan(),
            },
          },
        };
      }
      if (cmd._module === "xvibe" && cmd._op === "confirm-project-plan") {
        return {
          _ok: true,
          _result: {
            _confirmed: true,
            _memory: { _project: { _stage: "planning-complete" } },
          },
        };
      }
      if (cmd._module === "server-xvm" && cmd._op === "get-project-memory") {
        if (cmd._params._app_id === "draft-app") {
          return {
            _ok: true,
            _result: {
              _memory: {
                _stage: "planning",
                _current_focus: "",
                _milestones: [],
              },
            },
          };
        }
        return {
          _ok: true,
          _result: {
            _memory: {
              _stage: "building",
              ...mock_project_memory,
            },
          },
        };
      }
      if (cmd._module === "xvibe" && cmd._op === "get-guide-recommendation") {
        return {
          _ok: true,
          _result: {
            _recommendation:
              guide_crud_execution_count > 0 && mock_guide_recommendation
                ? next_guide_recommendation
                : mock_guide_recommendation,
            _guide_state: mock_guide_state,
          },
        };
      }
      if (cmd._module === "xvibe" && cmd._op === "execute-execution-graph") {
        assert.equal(cmd._params._graph_type, "crud");
        assert.equal(cmd._params._entity_name, "shopping_item");
        assert.equal(cmd._params._app_id, "shopping-app");
        assert.equal(cmd._params._env, "test");
        assert.notEqual(cmd._params._title, "Add Shopping Item CRUD");
        guide_crud_execution_count += 1;
        mock_project_memory = {
          ...mock_project_memory,
          _milestones: mock_project_memory._milestones.map((milestone: any) =>
            milestone._id === "working-shopping-list"
              ? {
                ...milestone,
                _items: milestone._items.map((item: any) =>
                  item._id === "shopping-item-crud"
                    ? { ...item, _completed: true }
                    : item
                ),
              }
              : milestone
          ),
        };
        if (guide_crud_execution_count > 1) {
          return {
            _ok: true,
            _graph_type: "crud",
            _entity_name: "shopping_item",
            _nodes: [],
            _summary: {
              _existing: 4,
              _created: 0,
              _skipped: 0,
              _failed: 0,
            },
          };
        }
        return {
          _ok: true,
          _graph_type: "crud",
          _entity_name: "shopping_item",
          _nodes: [
            {
              _id: "shopping_item",
              _artifact_type: "entity",
              _artifact_id: "shopping_item",
              _status: "created",
            },
          ],
          _summary: {
            _existing: 0,
            _created: 4,
            _skipped: 0,
            _failed: 0,
          },
        };
      }
      if (cmd._module === "xvibe" && cmd._op === "update-conversation-artifact") {
        assert.equal(cmd._params._app_id, "shopping-app");
        assert.equal(cmd._params._env, "test");
        assert.equal(cmd._params._conversation_id, "planning-chat");
        assert.equal(cmd._params._message_id, "guide-message");
        assert.equal(cmd._params._artifact_status, "done");
        assert.equal(
          cmd._params._artifact_result._type,
          "guide-recommendation-execution",
        );
        assert.equal(
          cmd._params._artifact_result._recommendation._title,
          "Add Shopping Item CRUD",
        );
        return {
          _ok: true,
          _result: {
            _updated: true,
          },
        };
      }
      throw new Error(`Unexpected command ${cmd._module}.${cmd._op}`);
    };

    const start_res = await (planning_module as any)._start_planning({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _conversation_id: "planning-chat",
        _message: "I want to build shopping list for myself",
        _runtime_context: {
          _guide_active_recommendation: {
            _title: "Unsafe early guide",
            _reason: "Should not be forwarded while planning.",
            _type: "crud",
            _priority: 100,
            _action: {
              _prompt: "Create CRUD before confirmation.",
            },
          },
        },
      },
    });
    assert.equal(start_res._ok, true);
    assert.equal(start_res._result._planning._selected_app_type, "custom");
    assert.equal(start_res._result._planning._inferred_archetype, "personal_list");
    assert.equal(start_res._result._planning._scope, "personal");
    assert.equal(start_res._result._planning._ready, true);
    assert.deepEqual(start_res._result._planning._blockers, []);
    assert.equal(
      execute_calls.some(
        (cmd) =>
          cmd._module === "xvibe" &&
          cmd._op === "analyze-message" &&
          cmd._params._runtime_context._stage === "planning" &&
          cmd._params._runtime_context._guide_active_recommendation === undefined &&
          cmd._params._runtime_context._runtime_lifecycle._guide_available === false,
      ),
      true,
    );

    execute_calls.length = 0;
    const get_res = await (planning_module as any)._get_planning_state({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _conversation_id: "planning-chat",
      },
    });
    const resume_res = await (planning_module as any)._resume_planning({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _conversation_id: "planning-chat",
      },
    });
    assert.equal(get_res._ok, true);
    assert.equal(resume_res._ok, true);
    assert.deepEqual(
      resume_res._result._planning._summary,
      get_res._result._planning._summary,
    );
    assert.equal(get_res._result._planning._inferred_archetype, "personal_list");
    assert.notEqual(get_res._result._planning._domain, "generic-business");
    assert.equal(
      execute_calls.filter(
        (cmd) => cmd._module === "xvibe" && cmd._op === "get-conversation",
      ).length,
      2,
    );

    execute_calls.length = 0;
    const invalid_state = incomplete_shopping_list_plan();
    const invalid_state_before = JSON.stringify(invalid_state);
    const invalid_answer_res = await (planning_module as any)._answer_planning_question({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _conversation_id: "planning-chat",
        _question_id: "list_structure",
        _answer: "Enterprise dashboard",
        _planning_state: invalid_state,
      },
    });
    assert.equal(invalid_answer_res._ok, false);
    assert.equal(
      invalid_answer_res._result._code,
      NodePackage.XNODE_PLANNING_ERR.INVALID_QUESTION_ANSWER,
    );
    assert.equal(JSON.stringify(invalid_state), invalid_state_before);
    assert.equal(execute_calls.length, 0);

    execute_calls.length = 0;
    const answer_res = await (planning_module as any)._answer_planning_question({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _conversation_id: "planning-chat",
        _question_id: "list_structure",
        _answer: "Single list",
        _planning_state: incomplete_shopping_list_plan(),
      },
    });
    assert.equal(answer_res._ok, true);
    assert.equal(answer_res._result._planning._ready, true);
    assert.equal(answer_res._result._planning._inferred_archetype, "personal_list");
    assert.equal(answer_res._result._planning._summary._goal, "Build a personal shopping list app");
    assert.equal(
      execute_calls.some(
        (cmd) => cmd._module === "xvibe" && cmd._op === "analyze-message",
      ),
      true,
    );

    execute_calls.length = 0;
    const blocked_confirm_res = await (planning_module as any)._confirm_project_plan({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _conversation_id: "planning-chat",
        _planning_state: incomplete_shopping_list_plan(),
      },
    });
    assert.equal(blocked_confirm_res._ok, false);
    assert.equal(
      blocked_confirm_res._result._code,
      NodePackage.XNODE_PLANNING_ERR.PLANNING_INCOMPLETE,
    );
    assert.ok(blocked_confirm_res._result._meta._blockers.length > 0);
    assert.ok(blocked_confirm_res._result._meta._summary._goal.includes("shopping list"));
    assert.equal(execute_calls.length, 0);

    const confirm_res = await (planning_module as any)._confirm_project_plan({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _conversation_id: "planning-chat",
        _planning_state: shopping_list_plan(),
      },
    });
    assert.equal(confirm_res._ok, true);
    assert.equal(confirm_res._result._confirmed, true);
    assert.equal(confirm_res._result._runtime_lifecycle._status, "confirmed");
    assert.equal(confirm_res._result._runtime_lifecycle._guide_available, true);
    assert.deepEqual(confirm_res._result._memory, {
      _project: { _stage: "planning-complete" },
    });
    assert.equal(
      execute_calls.filter(
        (cmd) => cmd._module === "xvibe" && cmd._op === "confirm-project-plan",
      ).length,
      1,
    );
    assert.equal(
      execute_calls.some(
        (cmd) => cmd._module === "server-xvm" && cmd._op === "patch-project-memory",
      ),
      false,
    );

    execute_calls.length = 0;
    const blocked_guide_res = await (planning_module as any)._get_guide_recommendation({
      _params: {
        _app_id: "draft-app",
        _env: "test",
        _conversation_id: "planning-chat",
        _planning_state: incomplete_shopping_list_plan(),
      },
    });
    assert.equal(blocked_guide_res._ok, true);
    assert.equal(blocked_guide_res._result._recommendation, null);
    assert.equal(blocked_guide_res._result._guide._available, false);
    assert.equal(
      blocked_guide_res._result._runtime_lifecycle._status,
      "planning",
    );
    assert.equal(
      execute_calls.some(
        (cmd) => cmd._module === "xvibe" && cmd._op === "get-guide-recommendation",
      ),
      false,
    );

    execute_calls.length = 0;
    const guide_res = await (planning_module as any)._get_guide_recommendation({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _conversation_id: "planning-chat",
      },
    });
    assert.equal(guide_res._ok, true);
    assert.equal(guide_res._result._recommendation._title, "Add Shopping Item CRUD");
    assert.equal(
      guide_res._result._recommendation._action._resolution._capability_id,
      "entity-crud",
    );
    assert.deepEqual(
      guide_res._result._recommendation._action._artifact_request,
      mock_guide_recommendation._action._artifact_request,
    );
    assert.deepEqual(
      guide_res._result._recommendation._action._execution_payload,
      mock_guide_recommendation._action._execution_payload,
    );
    assert.equal(guide_res._result._guide._available, true);
    assert.equal(
      guide_res._result._runtime_lifecycle._status,
      "executing",
    );
    assert.equal(
      guide_res._result._runtime_lifecycle._executable_guide_actions_available,
      true,
    );
    assert.equal(
      execute_calls.some(
        (cmd) =>
          cmd._module === "xvibe" &&
          cmd._op === "get-guide-recommendation" &&
          cmd._params._project_memory._confirmed_initial_plan !== undefined,
      ),
          true,
    );

    execute_calls.length = 0;
    const reloaded_recommendation = JSON.parse(
      JSON.stringify(guide_res._result._recommendation),
    );
    const guide_execute_res = await (planning_module as any)._execute_guide_recommendation({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _conversation_id: "planning-chat",
        _message_id: "guide-message",
        _recommendation: reloaded_recommendation,
      },
    });
    assert.equal(guide_execute_res._ok, true);
    assert.equal(guide_execute_res._result._status, "done");
    assert.equal(
      guide_execute_res._result._executor_route,
      "xvibe.execute-execution-graph",
    );
    assert.equal(
      guide_execute_res._result._execution_result._summary._created,
      4,
    );
    assert.equal(
      guide_execute_res._result._project_memory._milestones[0]._items[0]._completed,
      true,
    );
    assert.equal(
      guide_execute_res._result._next_recommendation._title,
      "Add Mark Purchased behavior",
    );
    assert.equal(
      execute_calls.some(
        (cmd) =>
          cmd._module === "xvibe" &&
          cmd._op === "execute-execution-graph" &&
          cmd._params._conversation_id === "planning-chat" &&
          cmd._params._message_id === "guide-message",
      ),
      true,
    );
    assert.equal(
      execute_calls.some(
        (cmd) =>
          cmd._module === "xvibe" &&
          cmd._op === "update-conversation-artifact" &&
          cmd._params._artifact_result._recommendation._expected_artifacts.length === 4,
      ),
      true,
    );

    execute_calls.length = 0;
    const retry_res = await (planning_module as any)._execute_guide_recommendation({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _recommendation: reloaded_recommendation,
      },
    });
    assert.equal(retry_res._ok, true);
    assert.equal(retry_res._result._status, "already-exists");
    assert.equal(retry_res._result._execution_result._summary._existing, 4);

    execute_calls.length = 0;
    const unconfirmed_execute_res = await (planning_module as any)._execute_guide_recommendation({
      _params: {
        _app_id: "draft-app",
        _env: "test",
        _recommendation: {
          ...reloaded_recommendation,
          _action: {
            ...reloaded_recommendation._action,
            _execution_payload: {
              ...reloaded_recommendation._action._execution_payload,
              _params: {
                ...reloaded_recommendation._action._execution_payload._params,
                _app_id: "draft-app",
              },
            },
          },
        },
      },
    });
    assert.equal(unconfirmed_execute_res._ok, false);
    assert.equal(
      unconfirmed_execute_res._result._code,
      NodePackage.XNODE_PLANNING_ERR.GUIDE_PLAN_NOT_CONFIRMED,
    );
    assert.equal(
      execute_calls.some(
        (cmd) => cmd._module === "xvibe" && cmd._op === "execute-execution-graph",
      ),
      false,
    );

    execute_calls.length = 0;
    const stale_execute_res = await (planning_module as any)._execute_guide_recommendation({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _recommendation: {
          ...reloaded_recommendation,
          _semantic_plan_ref: {
            ...semantic_plan_ref,
            _version: "stale-version",
          },
        },
      },
    });
    assert.equal(stale_execute_res._ok, false);
    assert.equal(
      stale_execute_res._result._code,
      NodePackage.XNODE_PLANNING_ERR.GUIDE_PLAN_STALE,
    );

    execute_calls.length = 0;
    const malformed_execute_res = await (planning_module as any)._execute_guide_recommendation({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _recommendation: {
          _title: "Add Shopping Item CRUD",
          _reason: "Malformed on purpose.",
          _type: "crud",
          _priority: 100,
          _action: {
            _prompt: "Add Shopping Item CRUD.",
          },
        },
      },
    });
    assert.equal(malformed_execute_res._ok, false);
    assert.equal(
      malformed_execute_res._result._code,
      NodePackage.XNODE_PLANNING_ERR.GUIDE_RECOMMENDATION_INVALID,
    );
    assert.deepEqual(
      malformed_execute_res._result._meta._missing_fields,
      ["_action._execution_payload"],
    );

    const server_xvm = new NodePackage.ServerXVMModule();
    const normalized_memory = (server_xvm as any).normalize_project_memory({
      _version: 1,
      _stage: "building",
      _vision: "",
      _goal: "Build a personal shopping list app",
      _confirmed_initial_plan: shopping_list_plan(),
      _semantic_generation_plan: {
        _type: "xvibe-semantic-generation-plan",
        _source: "confirmed_initial_plan",
        _entities: [{ _entity_id: "shopping_item", _title: "Shopping Item" }],
      },
      _current_focus: "Working Shopping List",
      _completed: [],
      _achievements: [],
      _milestones: [
        {
          _id: "working-shopping-list",
          _title: "Working Shopping List",
          _items: [
            {
              _id: "shopping-item-model",
              _title: "Shopping Item model",
              _completed: false,
              _semantic_type: "entity",
              _artifact_type: "entity",
              _entity_id: "shopping_item",
              _entity_name: "shopping_item",
            },
          ],
        },
      ],
      _parking_lot: [],
      _decisions: [],
      _notes: [],
      _updated_at: "2026-01-01T00:00:00.000Z",
    }, { _touch_updated_at: false });
    assert.deepEqual(normalized_memory._confirmed_initial_plan, shopping_list_plan());
    assert.equal(
      normalized_memory._semantic_generation_plan._type,
      "xvibe-semantic-generation-plan",
    );
    assert.equal(
      normalized_memory._milestones[0]._items[0]._entity_id,
      "shopping_item",
    );

    execute_calls.length = 0;
    mock_guide_recommendation = null;
    mock_guide_state = {
      _available: true,
      _reason: "no_executable_recommendation",
      _message: "No executable build action is available for the current guide focus.",
      _blockers: ["no_executable_recommendation"],
    };
    const empty_guide_res = await (planning_module as any)._get_guide_recommendation({
      _params: {
        _app_id: "shopping-app",
        _env: "test",
        _conversation_id: "planning-chat",
      },
    });
    assert.equal(empty_guide_res._ok, true);
    assert.equal(empty_guide_res._result._recommendation, null);
    assert.equal(empty_guide_res._result._guide._available, true);
    assert.equal(
      empty_guide_res._result._guide._blocked_reason,
      "no_executable_recommendation",
    );
    assert.equal(
      empty_guide_res._result._guide_state._message,
      "No executable build action is available for the current guide focus.",
    );
  } finally {
    (_x as any).execute = original_execute;
  }
}

function change_plan_test_view(view_id: string, title: string): any {
  return {
    _id: view_id,
    _type: "view",
    _children: [
      {
        _id: `${view_id}-title`,
        _type: "label",
        _text: title,
      },
      {
        _id: `${view_id}-summary`,
        _type: "label",
        _text: "Summary",
      },
      {
        _id: `${view_id}-footer`,
        _type: "label",
        _text: "Footer",
      },
    ],
  };
}

function change_plan_view_hash(view: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(view))
    .digest("hex");
}

function change_plan_structured_edit_action(action: string): string {
  if (action === "hide-object") return "hide";
  if (action === "show-object") return "show";
  return action;
}

async function apply_change_plan_view_edit_with_vibe_executor(input: {
  _server_xvm: any;
  _app_id: string;
  _env: string;
  _cmd: any;
}) {
  const params = input._cmd._params ?? {};
  const view_id = params._view_id;
  const target_id = params._target_id;
  const edit_action = params._edit_action;
  const view = await input._server_xvm._get_view({
    _params: {
      _app_id: input._app_id,
      _env: input._env,
      _view_id: view_id,
    },
  });
  const structured_action = change_plan_structured_edit_action(edit_action);
  const deterministic_result = (apply_deterministic_view_edit as any)({
    _resolved_task: {
      _action: "update",
      _artifact_type: "view",
      _target_id: view_id,
      _edit_action: structured_action,
      _edit_target_id: target_id,
      ...(typeof params._property_name === "string"
        ? { _edit_property_name: params._property_name }
        : {}),
      ...(params._property_value !== undefined
        ? { _edit_property_value: params._property_value }
        : {}),
      _explicit_artifact_type: true,
      _explicit_target_id: true,
      _module_ops: [],
      _source: "test.xvibe.apply-view-edit",
      _confidence: 1,
      _warnings: [],
    },
    _current_view: view._result._view,
    _edit_intent: {
      _action: structured_action,
      _target_id: target_id,
      ...(typeof params._property_name === "string"
        ? { _property_name: params._property_name }
        : {}),
      ...(params._property_value !== undefined
        ? { _property_value: params._property_value }
        : {}),
      _structured_apply_view_edit: true,
    },
  });

  if (!deterministic_result._ok || !deterministic_result._view) {
    return {
      _ok: false,
      _error: {
        _code: "E_TEST_APPLY_VIEW_EDIT_FAILED",
        _message: "Deterministic view edit failed",
        _details: deterministic_result,
      },
    };
  }

  const persist_result = await input._server_xvm._push_update({
    _params: {
      _app_id: input._app_id,
      _env: input._env,
      _view: deterministic_result._view,
    },
  });

  return {
    _ok: true,
    _artifact_type: "view",
    _artifact_id: view_id,
    _view_id: view_id,
    _deterministic: true,
    _edit_action: deterministic_result._mutation._action,
    _mutation_action: deterministic_result._mutation._action,
    _target_id: target_id,
    _property_name: deterministic_result._mutation._property_name,
    _mutation: deterministic_result._mutation,
    _persist_result: persist_result,
  };
}

function generated_view_operation(input: {
  _id: string;
  _app_id: string;
  _env: string;
  _view_id: string;
  _kind?: "view.create" | "view.replace";
  _title: string;
  _precondition?: Record<string, any>;
  _set_default_view?: boolean;
}): any {
  return {
    _type: "xvibe-generated-operation",
    _contract_version: 1,
    _id: input._id,
    _source_step_id: `${input._id}-step`,
    _kind: input._kind ?? "view.replace",
    _target: {
      _app_id: input._app_id,
      _env: input._env,
      _view_id: input._view_id,
    },
    _artifact: {
      _artifact_type: "view",
      _contract_version: 1,
      _view: change_plan_test_view(input._view_id, input._title),
    },
    _validation: {
      _state: "generated",
      _validated_at: "2026-01-01T00:00:00.000Z",
      _validator: "xvibe.view-artifact",
    },
    ...(input._precondition ? { _precondition: input._precondition } : {}),
      ...(input._set_default_view ? { _set_default_view: true } : {}),
  };
}

function generated_primary_experience_operation(input: {
  _id: string;
  _app_id: string;
  _env: string;
  _view_id: string;
  _view: any;
}): any {
  return {
    _type: "xvibe-generated-operation",
    _contract_version: 1,
    _id: input._id,
    _source_step_id: `${input._id}-step`,
    _kind: "view.create",
    _target: {
      _app_id: input._app_id,
      _env: input._env,
      _view_id: input._view_id,
    },
    _artifact: {
      _artifact_type: "view",
      _contract_version: 1,
      _view: input._view,
    },
    _validation: {
      _state: "generated",
      _validated_at: "2026-01-01T00:00:00.000Z",
      _validator: "xvibe.primary-experience",
    },
    _set_default_view: true,
  };
}

async function with_entity_manager_register_stub<T>(fn: () => Promise<T>): Promise<T> {
  const original_execute = (_x as any).execute;
  try {
    (_x as any).execute = async (cmd: any) => {
      if (
        cmd?._module === "entity-manager" &&
        (cmd?._op === "register" || cmd?._op === "unregister")
      ) {
        return { _ok: true, _result: { _registered: cmd._op === "register" } };
      }
      return typeof original_execute === "function"
        ? original_execute.call(_x, cmd)
        : { _ok: true };
    };

    return await fn();
  } finally {
    (_x as any).execute = original_execute;
  }
}

async function load_dashboard_starter_view(view_id: string, title: string) {
  const starter_view_path = path.resolve(
    process.cwd(),
    "system-xapps",
    "app-starters",
    "dashboard",
    "views",
    "main.json",
  );
  const view = JSON.parse(await readFile(starter_view_path, "utf-8"));
  view._id = view_id;
  view._semantic_id = `${view_id}:dashboard-starter`;

  const toolbar_title = find_json_object_by_id(view, "dashboard-toolbar-title");
  if (toolbar_title) {
    toolbar_title._text = title;
  }

  return view;
}

function semantic_entity(input: {
  _entity_id: string;
  _title: string;
  _fields: string[];
}) {
  return {
    _id: input._entity_id,
    _semantic_id: `${input._entity_id}:entity`,
    _title: input._title,
    _schema: input._fields.reduce<Record<string, any>>((schema, field) => {
      schema[field] = { _type: "String" };
      return schema;
    }, {}),
  };
}

function semantic_create_flow(input: {
  _flow_id: string;
  _entity_id: string;
  _title: string;
}) {
  return {
    _id: input._flow_id,
    _semantic_id: `${input._flow_id}:flow`,
    _title: input._title,
    _steps: [
      {
        _id: "create-record",
        _semantic_id: `${input._flow_id}:create-record`,
        _command: {
          _module: "entity-manager",
          _op: "add",
          _params: {
            _entity: input._entity_id,
            data: {
              title: "$event.title",
              status: "$event.status",
            },
          },
        },
        _output: {
          _to: {
            _type: "xdata",
            _key: `${input._entity_id}.last_created`,
          },
          _value: "$step.create-record._result",
        },
      },
    ],
  };
}

function semantic_primary_view(input: {
  _case_id: string;
  _view_id: string;
  _title: string;
  _entity_id: string;
  _flow_id: string;
}) {
  return {
    _id: input._view_id,
    _type: "view",
    _semantic_id: `${input._case_id}:primary-view`,
    _children: [
      {
        _id: `${input._case_id}-summary`,
        _type: "section",
        _semantic_id: `${input._case_id}:summary`,
        _entity: input._entity_id,
        _data_source: {
          _type: "entity-summary",
          _entity_id: input._entity_id,
        },
        _children: [
          {
            _id: `${input._case_id}-title`,
            _type: "label",
            _semantic_id: `${input._case_id}:title`,
            _text: input._title,
          },
        ],
      },
      {
        _id: `${input._case_id}-create-button`,
        _type: "button",
        _semantic_id: `${input._case_id}:create-action`,
        _text: "Create",
        _flow_event: "click",
        _flow: {
          _id: input._flow_id,
          _payload: {
            title: "$xdata.form.title",
            status: "$xdata.form.status",
          },
        },
      },
      {
        _id: `${input._case_id}-records`,
        _type: "table",
        _semantic_id: `${input._case_id}:records-table`,
        _entity_id: input._entity_id,
        _data_source: {
          _type: "entity-list",
          _entity_id: input._entity_id,
        },
        _columns: [
          { _key: "title", _title: "Title" },
          { _key: "status", _title: "Status" },
        ],
      },
    ],
  };
}

function shopping_item_entity_schema() {
  return {
    _id: "shopping_item",
    _semantic_id: "shopping_item:entity",
    _title: "Shopping Item",
    _storage: {
      _provider: "xdb",
      _scope: "app",
    },
    _schema: {
      name: { _type: "String", _required: true },
      quantity: { _type: "Number", _required: true },
      status: { _type: "String", _default: "open" },
      purchased: { _type: "Boolean", _default: false },
      lifecycle: { _type: "String", _default: "active" },
    },
  };
}

function shopping_item_flow(input: {
  _id: string;
  _op: "create" | "find" | "edit" | "purchase" | "delete";
}) {
  const output_key = `shopping_item.${input._op}`;
  const command =
    input._op === "create"
      ? {
        _module: "entity-manager",
        _op: "add",
        _params: {
          _entity: "shopping_item",
          _data: {
            name: "$event.name",
            quantity: "$event.quantity",
            status: "open",
            purchased: false,
            lifecycle: "active",
          },
        },
      }
      : input._op === "find"
        ? {
          _module: "entity-manager",
          _op: "find",
          _params: {
            _entity: "shopping_item",
            _filter: "$event.filter",
          },
        }
        : input._op === "edit"
          ? {
            _module: "entity-manager",
            _op: "update",
            _params: {
              _entity: "shopping_item",
              _filter: { _id: "$event._id" },
              _updates: {
                name: "$event.name",
                quantity: "$event.quantity",
              },
            },
          }
          : input._op === "purchase"
            ? {
              _module: "entity-manager",
              _op: "update",
              _params: {
                _entity: "shopping_item",
                _filter: { _id: "$event._id" },
                _updates: {
                  status: "purchased",
                  purchased: true,
                  lifecycle: "completed",
                },
              },
            }
            : {
              _module: "entity-manager",
              _op: "delete",
              _params: {
                _entity: "shopping_item",
                _filter: { _id: "$event._id" },
              },
            };

  return {
    _id: input._id,
    _semantic_id: `shopping_item:${input._op}:flow`,
    _steps: [
      {
        _id: `${input._op}-shopping-item`,
        _semantic_id: `shopping_item:${input._op}:step`,
        _command: command,
        _output: {
          _to: {
            _type: "xdata",
            _key: output_key,
          },
          _value: input._op === "find"
            ? `$step.${input._op}-shopping-item._result._records._data`
            : `$step.${input._op}-shopping-item._result`,
        },
      },
    ],
  };
}

function shopping_item_list_view() {
  return {
    _id: "shopping-list",
    _type: "view",
    _semantic_id: "shopping_item:list:view",
    _children: [
      {
        _id: "shopping-list-table",
        _type: "table",
        _semantic_id: "shopping_item:list:table",
        _entity_id: "shopping_item",
        _data_source: {
          _type: "entity-list",
          _entity_id: "shopping_item",
        },
        _columns: [
          { _key: "name", _title: "Item" },
          { _key: "quantity", _title: "Quantity" },
          { _key: "status", _title: "Status" },
        ],
      },
    ],
  };
}

function shopping_item_form_view() {
  return {
    _id: "shopping-form",
    _type: "view",
    _semantic_id: "shopping_item:form:view",
    _children: [
      {
        _id: "shopping-form-submit",
        _type: "button",
        _semantic_id: "shopping_item:form:create",
        _text: "Add item",
        _flow_event: "click",
        _flow: {
          _id: "create-shopping-item",
          _payload: {
            name: "$xdata.shopping_item.form.name",
            quantity: "$xdata.shopping_item.form.quantity",
          },
        },
      },
    ],
  };
}

function composed_shopping_main_view() {
  return {
    _id: "main",
    _type: "view",
    _semantic_id: "shopping_item:main:view",
    _children: [
      {
        _id: "shopping-main-title",
        _type: "label",
        _semantic_id: "shopping_item:main:title",
        _text: "Shopping List",
      },
      {
        _id: "shopping-main-form-ref",
        _type: "xvm-view",
        _semantic_id: "shopping_item:main:form-ref",
        _view_id: "shopping-form",
      },
      {
        _id: "shopping-main-list-ref",
        _type: "xvm-view",
        _semantic_id: "shopping_item:main:list-ref",
        _view_id: "shopping-list",
      },
    ],
  };
}

function flow_output(result: any, key: string) {
  return result?._result?._flow?._outputs?.[key];
}

async function run_server_xvm_composed_semantic_runtime_acceptance_tests() {
  const work_folder = await mkdtemp(path.join(tmpdir(), "xnode-composed-runtime-"));
  const env = "test";
  const app_id = "shopping-runtime";
  const isolated_app_id = "shopping-runtime-isolated";
  let server_xvm: any;
  let entity_manager: XEntityManager = new XEntityManager();
  let flow_manager: FlowManagerModule = new FlowManagerModule();
  const original_execute = (_x as any).execute;

  const install_runtime = (next_server_xvm: any, next_entity_manager: XEntityManager) => {
    server_xvm = next_server_xvm;
    entity_manager = next_entity_manager;
    flow_manager = new FlowManagerModule();
  };

  const reload_runtime = async () => {
    const next_server_xvm = new NodePackage.ServerXVMModule({ _work_folder: work_folder });
    const next_entity_manager = new XEntityManager();
    install_runtime(next_server_xvm, next_entity_manager);
    await server_xvm.init_on_boot();
  };

  const run_flow = async (_app_id: string, _env: string, _flow_id: string, _event_payload: Record<string, any>) => {
    const result = await (flow_manager as any)._run({
      _params: {
        _app_id,
        _env,
        _flow_id,
        _event_payload,
      },
    });
    assert.equal(
      result._ok,
      true,
      `flow ${_flow_id} failed: ${JSON.stringify(result)}`,
    );
    return result;
  };

  try {
    NodePackage.XDB.init({
      storage: new NodePackage.XDBStorageFS({
        xdbFolder: path.join(work_folder, "xdb"),
      }),
      workFolder: work_folder,
      enableCache: false,
    });
    await (NodePackage.XDB as any).onLoad();

    install_runtime(
      new NodePackage.ServerXVMModule({ _work_folder: work_folder }),
      new XEntityManager(),
    );

    (_x as any).execute = async (cmd: any) => {
      if (cmd?._module === "server-xvm") {
        const method = `_${String(cmd._op ?? "").replaceAll("-", "_")}`;
        if (typeof server_xvm?.[method] !== "function") {
          throw new Error(`Unexpected server-xvm op ${cmd._op}`);
        }
        return server_xvm[method](cmd);
      }
      if (cmd?._module === "entity-manager") {
        const method = `_${String(cmd._op ?? "").replaceAll("-", "_")}`;
        if (typeof (entity_manager as any)?.[method] !== "function") {
          throw new Error(`Unexpected entity-manager op ${cmd._op}`);
        }
        return (entity_manager as any)[method](cmd);
      }
      return typeof original_execute === "function"
        ? original_execute.call(_x, cmd)
        : { _ok: true };
    };

    await server_xvm._create_app({
      _params: {
        _app_id: app_id,
        _env: env,
        _entry_view_id: "main",
        _config: {
          _start: { _view_id: "main" },
        },
      },
    });
    await server_xvm._set_entity({
      _params: {
        _app_id: app_id,
        _env: env,
        _entity: shopping_item_entity_schema(),
      },
    });
    for (const flow of [
      shopping_item_flow({ _id: "create-shopping-item", _op: "create" }),
      shopping_item_flow({ _id: "find-shopping-items", _op: "find" }),
      shopping_item_flow({ _id: "edit-shopping-item", _op: "edit" }),
      shopping_item_flow({ _id: "mark-shopping-item-purchased", _op: "purchase" }),
      shopping_item_flow({ _id: "delete-shopping-item", _op: "delete" }),
    ]) {
      await server_xvm._set_flow({
        _params: {
          _app_id: app_id,
          _env: env,
          _flow: flow,
        },
      });
    }
    await server_xvm._push_update({
      _params: {
        _app_id: app_id,
        _env: env,
        _view: shopping_item_list_view(),
      },
    });
    await server_xvm._push_update({
      _params: {
        _app_id: app_id,
        _env: env,
        _view: shopping_item_form_view(),
      },
    });

    const version_before_main = (await server_xvm._get_app({
      _params: { _app_id: app_id, _env: env },
    }))._result._app._meta._version;
    await server_xvm._push_update({
      _params: {
        _app_id: app_id,
        _env: env,
        _view: composed_shopping_main_view(),
      },
    });
    const version_after_main = (await server_xvm._get_app({
      _params: { _app_id: app_id, _env: env, _include_views: true, _include_flows: true },
    }))._result._app._meta._version;
    assert.equal(version_after_main > version_before_main, true);

    await reload_runtime();
    const composed_app = await server_xvm._get_app({
      _params: {
        _app_id: app_id,
        _env: env,
        _include_views: true,
        _include_flows: true,
      },
    });
    assert.equal(composed_app._result._app._meta._entry_view_id, "main");
    assert.equal(composed_app._result._app._config._start._view_id, "main");
    assert.deepEqual(
      composed_app._result._view_ids.sort(),
      ["main", "shopping-form", "shopping-list"],
    );
    assert.equal(
      find_json_object_by_id(composed_app._result._views.main, "shopping-main-list-ref")._view_id,
      "shopping-list",
    );
    assert.deepEqual(
      (await (entity_manager as any)._list({
        _params: { _app_id: app_id, _env: env },
      }))._result.entities,
      ["shopping_item"],
    );

    const create_result = await run_flow(app_id, env, "create-shopping-item", {
      name: "Milk",
      quantity: 2,
    });
    const created_record = flow_output(create_result, "shopping_item.create")._record;
    assert.equal(created_record.name, "Milk");
    assert.equal(created_record.quantity, 2);
    assert.equal(typeof created_record.quantity, "number");

    await reload_runtime();
    const find_after_create = await run_flow(app_id, env, "find-shopping-items", {
      filter: { _id: created_record._id },
    });
    let records = flow_output(find_after_create, "shopping_item.find");
    assert.equal(records.length, 1);
    assert.equal(records[0].quantity, 2);
    assert.equal(typeof records[0].quantity, "number");

    await run_flow(app_id, env, "edit-shopping-item", {
      _id: created_record._id,
      name: "Oat milk",
      quantity: 3,
    });
    await reload_runtime();
    const find_after_edit = await run_flow(app_id, env, "find-shopping-items", {
      filter: { _id: created_record._id },
    });
    records = flow_output(find_after_edit, "shopping_item.find");
    assert.equal(records[0].name, "Oat milk");
    assert.equal(records[0].quantity, 3);
    assert.equal(typeof records[0].quantity, "number");

    await run_flow(app_id, env, "mark-shopping-item-purchased", {
      _id: created_record._id,
    });
    await reload_runtime();
    const find_after_purchase = await run_flow(app_id, env, "find-shopping-items", {
      filter: { _id: created_record._id },
    });
    records = flow_output(find_after_purchase, "shopping_item.find");
    assert.equal(records[0].status, "purchased");
    assert.equal(records[0].purchased, true);
    assert.equal(records[0].lifecycle, "completed");

    await server_xvm._create_app({
      _params: {
        _app_id: isolated_app_id,
        _env: "isolated",
        _entry_view_id: "main",
      },
    });
    await server_xvm._set_entity({
      _params: {
        _app_id: isolated_app_id,
        _env: "isolated",
        _entity: shopping_item_entity_schema(),
      },
    });
    await server_xvm._set_flow({
      _params: {
        _app_id: isolated_app_id,
        _env: "isolated",
        _flow: shopping_item_flow({ _id: "create-shopping-item", _op: "create" }),
      },
    });
    await server_xvm._set_flow({
      _params: {
        _app_id: isolated_app_id,
        _env: "isolated",
        _flow: shopping_item_flow({ _id: "find-shopping-items", _op: "find" }),
      },
    });
    const isolated_create = await run_flow(isolated_app_id, "isolated", "create-shopping-item", {
      name: "Bread",
      quantity: 1,
    });
    assert.notEqual(
      flow_output(isolated_create, "shopping_item.create")._record._id,
      created_record._id,
    );
    const isolated_find = await run_flow(isolated_app_id, "isolated", "find-shopping-items", {
      filter: {},
    });
    assert.equal(flow_output(isolated_find, "shopping_item.find").length, 1);
    const original_find_for_isolation = await run_flow(app_id, env, "find-shopping-items", {
      filter: {},
    });
    assert.equal(flow_output(original_find_for_isolation, "shopping_item.find").length, 1);

    await run_flow(app_id, env, "delete-shopping-item", {
      _id: created_record._id,
    });
    await reload_runtime();
    const find_after_delete = await run_flow(app_id, env, "find-shopping-items", {
      filter: {},
    });
    assert.deepEqual(flow_output(find_after_delete, "shopping_item.find"), []);

    const isolated_after_original_delete = await run_flow(isolated_app_id, "isolated", "find-shopping-items", {
      filter: {},
    });
    assert.equal(flow_output(isolated_after_original_delete, "shopping_item.find").length, 1);
    assert.deepEqual(
      (await (entity_manager as any)._list({
        _params: { _app_id: app_id, _env: env },
      }))._result.entities,
      ["shopping_item"],
    );
  } finally {
    (_x as any).execute = original_execute;
    await rm(work_folder, { recursive: true, force: true });
  }
}

async function run_entity_manager_scoped_runtime_entity_tests() {
  const work_folder = await mkdtemp(path.join(tmpdir(), "xnode-entity-scope-"));
  const env_default = "default";
  const original_execute = (_x as any).execute;
  let server_xvm: any = new NodePackage.ServerXVMModule({ _work_folder: work_folder });
  let entity_manager: XEntityManager = new XEntityManager();

  const install_execute_stub = () => {
    (_x as any).execute = async (cmd: any) => {
      if (cmd?._module === "entity-manager") {
        const method = `_${String(cmd._op ?? "").replaceAll("-", "_")}`;
        if (typeof (entity_manager as any)?.[method] !== "function") {
          throw new Error(`Unexpected entity-manager op ${cmd._op}`);
        }
        return (entity_manager as any)[method](cmd);
      }
      if (cmd?._module === "server-xvm") {
        const method = `_${String(cmd._op ?? "").replaceAll("-", "_")}`;
        if (typeof server_xvm?.[method] !== "function") {
          throw new Error(`Unexpected server-xvm op ${cmd._op}`);
        }
        return server_xvm[method](cmd);
      }
      return typeof original_execute === "function"
        ? original_execute.call(_x, cmd)
        : { _ok: true };
    };
  };

  const entity_artifact = (fields: Record<string, any>) => ({
    _id: "shopping_item",
    _title: "Shopping Item",
    _schema: fields,
  });

  const set_entity = async (_app_id: string, _env: string, fields: Record<string, any>) => {
    const result = await server_xvm._set_entity({
      _params: {
        _app_id,
        _env,
        _entity: entity_artifact(fields),
      },
    });
    assert.equal(result._ok, true);
  };

  const add_record = async (_app_id: string, _env: string, data: Record<string, any>) => {
    const result = await (entity_manager as any)._add({
      _params: {
        _app_id,
        _env,
        _entity: "shopping_item",
        _data: data,
      },
    });
    assert.equal(result._ok, true, JSON.stringify(result));
    return result._result._record;
  };

  const find_records = async (_app_id: string, _env: string) => {
    const result = await (entity_manager as any)._find({
      _params: {
        _app_id,
        _env,
        _entity: "shopping_item",
        _filter: {},
      },
    });
    assert.equal(result._ok, true, JSON.stringify(result));
    return result._result._records._data;
  };

  try {
    NodePackage.XDB.init({
      storage: new NodePackage.XDBStorageFS({
        xdbFolder: path.join(work_folder, "xdb"),
      }),
      workFolder: work_folder,
      enableCache: false,
    });
    await (NodePackage.XDB as any).onLoad();
    install_execute_stub();

    for (const [_app_id, _env] of [
      ["ap5", env_default],
      ["ap6", env_default],
      ["ap5", "staging"],
    ]) {
      await server_xvm._create_app({
        _params: {
          _app_id,
          _env,
          _entry_view_id: "main",
        },
      });
    }

    await set_entity("ap5", env_default, {
      name: { _type: "String", _required: true },
      quantity: { _type: "Number", _required: true },
    });
    await set_entity("ap6", env_default, {
      title: { _type: "String", _required: true },
      aisle: { _type: "String", _required: true },
    });
    await set_entity("ap5", "staging", {
      sku: { _type: "String", _required: true },
      done: { _type: "Boolean", _default: false },
    });

    const ap5_default_diag = await (entity_manager as any)._storage_diagnostics({
      _params: {
        _app_id: "ap5",
        _env: env_default,
        _entity: "shopping_item",
      },
    });
    const ap6_default_diag = await (entity_manager as any)._storage_diagnostics({
      _params: {
        _app_id: "ap6",
        _env: env_default,
        _entity: "shopping_item",
      },
    });
    const ap5_staging_diag = await (entity_manager as any)._storage_diagnostics({
      _params: {
        _app_id: "ap5",
        _env: "staging",
        _entity: "shopping_item",
      },
    });

    assert.equal(ap5_default_diag._ok, true);
    assert.equal(ap5_default_diag._result._diagnostic._entity, "shopping_item");
    assert.equal(ap5_default_diag._result._diagnostic._storage_scope, "app");
    assert.notEqual(
      ap5_default_diag._result._diagnostic._physical_entity_name,
      ap6_default_diag._result._diagnostic._physical_entity_name,
    );
    assert.notEqual(
      ap5_default_diag._result._diagnostic._physical_entity_name,
      ap5_staging_diag._result._diagnostic._physical_entity_name,
    );
    assert.notEqual(
      ap5_default_diag._result._diagnostic._physical_entity_name,
      "shopping_item",
    );

    const ap5_record = await add_record("ap5", env_default, {
      name: "Milk",
      quantity: 2,
    });
    const ap6_record = await add_record("ap6", env_default, {
      title: "Coffee",
      aisle: "3",
    });
    const staging_record = await add_record("ap5", "staging", {
      sku: "S-1",
    });

    assert.deepEqual((await find_records("ap5", env_default)).map((record: any) => record._id), [ap5_record._id]);
    assert.deepEqual((await find_records("ap6", env_default)).map((record: any) => record._id), [ap6_record._id]);
    assert.deepEqual((await find_records("ap5", "staging")).map((record: any) => record._id), [staging_record._id]);

    const ap5_schema = await (entity_manager as any)._get_schema({
      _params: {
        _app_id: "ap5",
        _env: env_default,
        _entity: "shopping_item",
      },
    });
    const ap6_schema = await (entity_manager as any)._get_schema({
      _params: {
        _app_id: "ap6",
        _env: env_default,
        _entity: "shopping_item",
      },
    });
    assert.equal(ap5_schema._result.entity._schema.quantity._type, "Number");
    assert.equal(ap6_schema._result.entity._schema.aisle._type, "String");
    assert.equal(ap6_schema._result.entity._schema.quantity, undefined);

    const repeat = await (entity_manager as any)._register({
      _params: {
        _app_id: "ap5",
        _env: env_default,
        _entity: entity_artifact({
          name: { _type: "String", _required: true },
          quantity: { _type: "Number", _required: true },
        }),
      },
    });
    assert.equal(repeat._ok, true);
    assert.equal(repeat._result._already_exists, true);

    const unscoped_find = await (entity_manager as any)._find({
      _params: {
        _entity: "shopping_item",
        _filter: {},
      },
    });
    assert.equal(unscoped_find._ok, false);
    assert.match(JSON.stringify(unscoped_find), /_app_id/);

    const cross_update = await (entity_manager as any)._update({
      _params: {
        _app_id: "ap5",
        _env: env_default,
        _entity: "shopping_item",
        _filter: { _id: ap6_record._id },
        _updates: { name: "Wrong" },
      },
    });
    assert.equal(cross_update._ok, true);
    assert.equal(cross_update._result._updated, 0);
    assert.equal((await find_records("ap6", env_default))[0].title, "Coffee");

    const server_ap5_entities = await server_xvm._list_entities({
      _params: {
        _app_id: "ap5",
        _env: env_default,
      },
    });
    const server_ap6_entities = await server_xvm._list_entities({
      _params: {
        _app_id: "ap6",
        _env: env_default,
      },
    });
    assert.deepEqual(server_ap5_entities._result._entities, ["shopping_item"]);
    assert.deepEqual(server_ap6_entities._result._entities, ["shopping_item"]);

    const runtime_list = await (entity_manager as any)._list({
      _params: {
        _app_id: "ap5",
        _env: env_default,
      },
    });
    assert.deepEqual(runtime_list._result.entities, ["shopping_item"]);

    const persisted_entity = JSON.parse(await readFile(
      path.join(work_folder, "xvm", "apps", env_default, "ap5", "entities", "shopping_item.json"),
      "utf-8",
    ));
    assert.equal(persisted_entity._id, "shopping_item");
    assert.equal(JSON.stringify(persisted_entity).includes("ap5::shopping_item"), false);

    const storage_entities = await readdir(path.join(work_folder, "xdb", "entities"));
    assert.equal(storage_entities.includes("shopping_item"), false);
    assert.equal(storage_entities.includes(ap5_default_diag._result._diagnostic._physical_entity_name), true);
    assert.equal(storage_entities.includes(ap6_default_diag._result._diagnostic._physical_entity_name), true);
    assert.equal(storage_entities.includes(ap5_staging_diag._result._diagnostic._physical_entity_name), true);

    NodePackage.XDB.init({
      storage: new NodePackage.XDBStorageFS({
        xdbFolder: path.join(work_folder, "xdb"),
      }),
      workFolder: work_folder,
      enableCache: false,
    });
    await (NodePackage.XDB as any).onLoad();
    server_xvm = new NodePackage.ServerXVMModule({ _work_folder: work_folder });
    entity_manager = new XEntityManager();
    install_execute_stub();
    await server_xvm.init_on_boot();
    assert.deepEqual((await find_records("ap5", env_default)).map((record: any) => record._id), [ap5_record._id]);
    assert.deepEqual((await find_records("ap6", env_default)).map((record: any) => record._id), [ap6_record._id]);
    assert.deepEqual((await find_records("ap5", "staging")).map((record: any) => record._id), [staging_record._id]);

    const global_register = await (entity_manager as any)._register({
      _params: {
        _entity_scope: "global",
        _entity: {
          _id: "system_setting",
          _storage: {
            _provider: "memory",
            _scope: "global",
          },
          _schema: {
            key: { _type: "String", _required: true },
          },
        },
      },
    });
    assert.equal(global_register._ok, true);
    const global_add = await (entity_manager as any)._add({
      _params: {
        _entity_scope: "global",
        _entity: "system_setting",
        _data: { key: "theme" },
      },
    });
    assert.equal(global_add._ok, true);
    const global_find = await (entity_manager as any)._find({
      _params: {
        _entity_scope: "global",
        _entity: "system_setting",
        _filter: {},
      },
    });
    assert.equal(global_find._result._records._data.length, 1);
  } finally {
    (_x as any).execute = original_execute;
    await rm(work_folder, { recursive: true, force: true });
  }

  const legacy_work_folder = await mkdtemp(path.join(tmpdir(), "xnode-entity-legacy-"));
  server_xvm = new NodePackage.ServerXVMModule({ _work_folder: legacy_work_folder });
  entity_manager = new XEntityManager();
  try {
    NodePackage.XDB.init({
      storage: new NodePackage.XDBStorageFS({
        xdbFolder: path.join(legacy_work_folder, "xdb"),
      }),
      workFolder: legacy_work_folder,
      enableCache: false,
    });
    await (NodePackage.XDB as any).onLoad();
    install_execute_stub();

    const legacy_entity = NodePackage.XDB.create({
      _type: (NodePackage.XDBEntity as any)._xtype,
      _id: "legacy_item",
      _name: "legacy_item",
      _schema: {
        name: { _type: "String", _required: true },
      },
    }) as any;
    await legacy_entity.add({ name: "Legacy Milk" });

    await server_xvm._create_app({
      _params: {
        _app_id: "legacy-app",
        _env: env_default,
        _entry_view_id: "main",
      },
    });
    const legacy_set = await server_xvm._set_entity({
      _params: {
        _app_id: "legacy-app",
        _env: env_default,
        _entity: {
          _id: "legacy_item",
          _title: "Legacy Item",
          _schema: {
            name: { _type: "String", _required: true },
          },
        },
      },
    });
    assert.equal(legacy_set._ok, true);

    const blocked = await (entity_manager as any)._find({
      _params: {
        _app_id: "legacy-app",
        _env: env_default,
        _entity: "legacy_item",
        _filter: {},
      },
    });
    assert.equal(blocked._ok, false);
    assert.match(JSON.stringify(blocked), /legacy global entity/);

    const dry_run = await (entity_manager as any)._storage_migration_dry_run({
      _params: {
        _entity: "legacy_item",
        _target_app_id: "legacy-app",
        _target_env: env_default,
        _target_entity_id: "legacy_item",
      },
    });
    assert.equal(dry_run._ok, true);
    assert.equal(dry_run._result._migration._status, "ready");

    const migrated = await (entity_manager as any)._storage_migrate({
      _params: {
        _mode: "copy",
        _entity: "legacy_item",
        _target_app_id: "legacy-app",
        _target_env: env_default,
        _target_entity_id: "legacy_item",
      },
    });
    assert.equal(migrated._ok, true);
    assert.equal(migrated._result._migration._status, "copied");

    const after_migration = await (entity_manager as any)._find({
      _params: {
        _app_id: "legacy-app",
        _env: env_default,
        _entity: "legacy_item",
        _filter: {},
      },
    });
    assert.equal(after_migration._ok, true);
    assert.equal(after_migration._result._records._data[0].name, "Legacy Milk");
  } finally {
    (_x as any).execute = original_execute;
    await rm(legacy_work_folder, { recursive: true, force: true });
  }
}

async function run_server_xvm_semantic_runtime_composition_tests() {
  const cases = [
    {
      _case_id: "shopping-list",
      _app_id: "semantic-shopping-list",
      _title: "Shopping List",
      _entity_id: "shopping_item",
      _entity_title: "Shopping Item",
      _flow_id: "create-shopping-item",
      _fields: ["title", "status", "quantity"],
    },
    {
      _case_id: "crm",
      _app_id: "semantic-crm",
      _title: "CRM",
      _entity_id: "customer",
      _entity_title: "Customer",
      _flow_id: "create-customer",
      _fields: ["title", "status", "owner"],
    },
    {
      _case_id: "scheduler",
      _app_id: "semantic-scheduler",
      _title: "Scheduler",
      _entity_id: "schedule_event",
      _entity_title: "Schedule Event",
      _flow_id: "create-schedule-event",
      _fields: ["title", "status", "starts_at"],
    },
  ];

  for (const scenario of cases) {
    const work_folder = await mkdtemp(path.join(tmpdir(), `xnode-semantic-${scenario._case_id}-`));
    try {
      await with_entity_manager_register_stub(async () => {
        const server_xvm = new NodePackage.ServerXVMModule({ _work_folder: work_folder });
        const env = "test";
        const starter_view = await load_dashboard_starter_view(
          "main",
          `${scenario._title} Starter`,
        );

        await (server_xvm as any)._create_app({
          _params: {
            _app_id: scenario._app_id,
            _env: env,
            _name: scenario._title,
            _entry_view_id: "main",
            _config: {
              _start: { _view_id: "main" },
            },
          },
        });
        await (server_xvm as any)._push_update({
          _params: {
            _app_id: scenario._app_id,
            _env: env,
            _view: starter_view,
          },
        });
        await (server_xvm as any)._set_entity({
          _params: {
            _app_id: scenario._app_id,
            _env: env,
            _entity: semantic_entity({
              _entity_id: scenario._entity_id,
              _title: scenario._entity_title,
              _fields: scenario._fields,
            }),
          },
        });
        await (server_xvm as any)._set_flow({
          _params: {
            _app_id: scenario._app_id,
            _env: env,
            _flow: semantic_create_flow({
              _flow_id: scenario._flow_id,
              _entity_id: scenario._entity_id,
              _title: `Create ${scenario._entity_title}`,
            }),
          },
        });

        const primary_view = semantic_primary_view({
          _case_id: scenario._case_id,
          _view_id: "primary",
          _title: scenario._title,
          _entity_id: scenario._entity_id,
          _flow_id: scenario._flow_id,
        });
        const generate_result = await (server_xvm as any)._apply_generated_operation({
          _params: {
            _app_id: scenario._app_id,
            _env: env,
            _operation: generated_primary_experience_operation({
              _id: `${scenario._case_id}-primary`,
              _app_id: scenario._app_id,
              _env: env,
              _view_id: "primary",
              _view: primary_view,
            }),
          },
        });

        assert.equal(generate_result._ok, true);
        assert.equal(generate_result._result._view_id, "primary");

        const reloaded = new NodePackage.ServerXVMModule({ _work_folder: work_folder });
        await (reloaded as any).init_on_boot();
        const app = await (reloaded as any)._get_app({
          _params: {
            _app_id: scenario._app_id,
            _env: env,
            _include_views: true,
            _include_flows: true,
          },
        });
        const view = await (reloaded as any)._get_view({
          _params: {
            _app_id: scenario._app_id,
            _env: env,
            _view_id: "primary",
          },
        });
        const flow = await (reloaded as any)._get_flow({
          _params: {
            _app_id: scenario._app_id,
            _env: env,
            _flow_id: scenario._flow_id,
          },
        });
        const entity = await (reloaded as any)._get_entity({
          _params: {
            _app_id: scenario._app_id,
            _env: env,
            _entity_id: scenario._entity_id,
          },
        });

        assert.equal(app._result._app._meta._entry_view_id, "primary");
        assert.equal(app._result._app._config._start._view_id, "primary");
        assert.deepEqual(app._result._view_ids.sort(), ["main", "primary"]);
        assert.deepEqual(app._result._flow_ids, [scenario._flow_id]);
        assert.deepEqual(app._result._entity_ids, [scenario._entity_id]);
        assert.equal(entity._result._entity._semantic_id, `${scenario._entity_id}:entity`);
        assert.equal(flow._result._flow._steps[0]._command._params._entity, scenario._entity_id);

        const create_button = find_json_object_by_id(
          view._result._view,
          `${scenario._case_id}-create-button`,
        );
        const records_table = find_json_object_by_id(
          view._result._view,
          `${scenario._case_id}-records`,
        );

        assert.equal(create_button._flow._id, scenario._flow_id);
        assert.equal(records_table._entity_id, scenario._entity_id);
        assert.equal(records_table._data_source._entity_id, scenario._entity_id);

        const persisted_view = JSON.parse(await readFile(
          path.join(work_folder, "xvm", "apps", env, scenario._app_id, "views", "primary.json"),
          "utf-8",
        ));
        assert.deepEqual(persisted_view, view._result._view);
      });
    } finally {
      await rm(work_folder, { recursive: true, force: true });
    }
  }
}

async function run_server_xvm_semantic_validation_tests() {
  async function create_server_fixture() {
    const work_folder = await mkdtemp(path.join(tmpdir(), "xnode-semantic-validation-"));
    const server_xvm = new NodePackage.ServerXVMModule({ _work_folder: work_folder });
    await (server_xvm as any)._create_app({
      _params: {
        _app_id: "validation-app",
        _env: "test",
        _entry_view_id: "main",
      },
    });
    return { work_folder, server_xvm };
  }

  {
    const fixture = await create_server_fixture();
    try {
      await assert.rejects(
        async () => (fixture.server_xvm as any)._push_update({
          _params: {
            _app_id: "validation-app",
            _env: "test",
            _view: semantic_primary_view({
              _case_id: "missing-entity",
              _view_id: "main",
              _title: "Missing Entity",
              _entity_id: "missing_entity",
              _flow_id: "create-record",
            }),
          },
        }),
        (err: any) => err?._code === "E_XVM_MISSING_ENTITY_REFERENCE",
      );
    } finally {
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_server_fixture();
    try {
      await with_entity_manager_register_stub(async () => {
        await (fixture.server_xvm as any)._set_entity({
          _params: {
            _app_id: "validation-app",
            _env: "test",
            _entity: semantic_entity({
              _entity_id: "record",
              _title: "Record",
              _fields: ["title"],
            }),
          },
        });
      });
      await assert.rejects(
        async () => (fixture.server_xvm as any)._push_update({
          _params: {
            _app_id: "validation-app",
            _env: "test",
            _view: semantic_primary_view({
              _case_id: "missing-flow",
              _view_id: "main",
              _title: "Missing Flow",
              _entity_id: "record",
              _flow_id: "missing-flow",
            }),
          },
        }),
        (err: any) => err?._code === "E_XVM_MISSING_FLOW_REFERENCE",
      );
    } finally {
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_server_fixture();
    try {
      await assert.rejects(
        async () => (fixture.server_xvm as any)._push_update({
          _params: {
            _app_id: "validation-app",
            _env: "test",
            _view: {
              _id: "main",
              _type: "view",
              _children: [
                {
                  _id: "missing-subview-ref",
                  _type: "xvm-view",
                  _view_id: "missing-subview",
                },
              ],
            },
          },
        }),
        (err: any) => err?._code === "E_XVM_MISSING_VIEW_REFERENCE",
      );
    } finally {
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_server_fixture();
    try {
      await (fixture.server_xvm as any)._push_update({
        _params: {
          _app_id: "validation-app",
          _env: "test",
          _view: {
            _id: "subview",
            _type: "view",
            _children: [],
          },
        },
      });
      await assert.rejects(
        async () => (fixture.server_xvm as any)._push_update({
          _params: {
            _app_id: "validation-app",
            _env: "test",
            _view: {
              _id: "main",
              _type: "view",
              _children: [
                {
                  _id: "wrong-env-subview-ref",
                  _type: "xvm-view",
                  _view_id: "subview",
                  _env: "other",
                },
              ],
            },
          },
        }),
        (err: any) => err?._code === "E_XVM_INVALID_VIEW_REFERENCE_TARGET",
      );
    } finally {
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_server_fixture();
    try {
      await assert.rejects(
        async () => (fixture.server_xvm as any)._push_update({
          _params: {
            _app_id: "validation-app",
            _env: "test",
            _view: {
              _id: "main",
              _type: "view",
              _children: [
                { _id: "a", _type: "label", _semantic_id: "duplicate" },
                { _id: "b", _type: "label", _semantic_id: "duplicate" },
              ],
            },
          },
        }),
        (err: any) => err?._code === "E_XVM_DUPLICATE_SEMANTIC_ID",
      );
    } finally {
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_server_fixture();
    try {
      await assert.rejects(
        async () => (fixture.server_xvm as any)._push_update({
          _params: {
            _app_id: "validation-app",
            _env: "test",
            _view: {
              _id: "main",
              _type: "view",
              _children: ["invalid-child"],
            },
          },
        }),
        (err: any) => err?._code === "E_XVM_GENERATED_OPERATION_XUI_INVALID",
      );
    } finally {
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }
}

function dynamic_target_flow(input: {
  _flow_id?: string;
  _app_id: string;
  _env?: string;
  _op?: string;
}) {
  return {
    _id: input._flow_id ?? "dynamic-target-flow",
    _steps: [
      {
        _id: "load-target-app",
        _command: {
          _module: "server-xvm",
          _op: input._op ?? "get_app",
          _params: {
            _app_id: input._app_id,
            _env: input._env ?? "$event._env",
          },
        },
        _output: {
          _to: {
            _type: "xdata",
            _key: "dynamic.target.app_id",
          },
          _value: "$step.load-target-app._result._app._app_id",
        },
      },
    ],
  };
}

function response_has_error_code(value: unknown, code: string): boolean {
  return JSON.stringify(value).includes(code);
}

async function write_system_app_fixture(input: {
  _system_apps_root: string;
  _app_id: string;
  _env?: string;
  _flow: Record<string, any>;
}) {
  const app_dir = path.join(input._system_apps_root, input._app_id);
  await mkdir(path.join(app_dir, "flows"), { recursive: true });
  await writeFile(
    path.join(app_dir, "app.json"),
    JSON.stringify({
      _app_id: input._app_id,
      _env: input._env ?? "default",
      _meta: {
        _name: input._app_id,
        _version: 1,
        _entry_view_id: "main",
      },
      _config: {},
    }, null, 2),
  );
  await writeFile(
    path.join(app_dir, "flows", `${input._flow._id}.json`),
    JSON.stringify(input._flow, null, 2),
  );
}

async function run_server_xvm_dynamic_reference_validation_tests() {
  {
    const work_folder = await mkdtemp(path.join(tmpdir(), "xnode-dynamic-system-flow-"));
    const system_apps_root = path.join(work_folder, "system-xapps");
    try {
      await write_system_app_fixture({
        _system_apps_root: system_apps_root,
        _app_id: "vibe-system",
        _flow: dynamic_target_flow({
          _flow_id: "flow-create-app-from-starter",
          _app_id: "$event._app_id",
          _env: "$event._env",
          _op: "create_app",
        }),
      });

      const server_xvm = new NodePackage.ServerXVMModule({
        _work_folder: path.join(work_folder, "work"),
        _system_xapps_path: system_apps_root,
      });
      const boot = await (server_xvm as any).init_on_boot();
      assert.equal(boot._apps_loaded, 1);
      assert.equal(boot._flows_loaded, 1);
      const flow = await (server_xvm as any)._get_flow({
        _params: {
          _app_id: "vibe-system",
          _env: "default",
          _flow_id: "flow-create-app-from-starter",
        },
      });
      assert.equal(flow._ok, true);
    } finally {
      await rm(work_folder, { recursive: true, force: true });
    }
  }

  {
    const work_folder = await mkdtemp(path.join(tmpdir(), "xnode-dynamic-static-"));
    const server_xvm = new NodePackage.ServerXVMModule({ _work_folder: work_folder });
    try {
      await (server_xvm as any)._create_app({
        _params: {
          _app_id: "validation-app",
          _env: "test",
          _entry_view_id: "main",
        },
      });

      await assert.rejects(
        async () => (server_xvm as any)._set_flow({
          _params: {
            _app_id: "validation-app",
            _env: "test",
            _flow: dynamic_target_flow({
              _app_id: "other-app",
              _env: "test",
            }),
          },
        }),
        (err: any) => err?._code === "E_XVM_INVALID_ACTION_REFERENCE_TARGET",
      );

      await assert.rejects(
        async () => (server_xvm as any)._set_flow({
          _params: {
            _app_id: "validation-app",
            _env: "test",
            _flow: dynamic_target_flow({
              _app_id: "$event",
              _env: "test",
            }),
          },
        }),
        (err: any) => err?._code === "E_XVM_MALFORMED_DYNAMIC_REFERENCE",
      );

      await assert.rejects(
        async () => (server_xvm as any)._set_flow({
          _params: {
            _app_id: "validation-app",
            _env: "test",
            _flow: dynamic_target_flow({
              _app_id: "$input._app_id",
              _env: "test",
            }),
          },
        }),
        (err: any) => err?._code === "E_XVM_UNSUPPORTED_DYNAMIC_REFERENCE",
      );

      const dynamic_ok = await (server_xvm as any)._set_flow({
        _params: {
          _app_id: "validation-app",
          _env: "test",
          _flow: dynamic_target_flow({
            _app_id: "$event._app_id",
            _env: "$event._env",
          }),
        },
      });
      assert.equal(dynamic_ok._ok, true);
    } finally {
      await rm(work_folder, { recursive: true, force: true });
    }
  }

  {
    const work_folder = await mkdtemp(path.join(tmpdir(), "xnode-dynamic-runtime-"));
    const server_xvm = new NodePackage.ServerXVMModule({ _work_folder: work_folder });
    const flow_manager = new FlowManagerModule();
    const original_execute = (_x as any).execute;
    let target_step_dispatches = 0;
    try {
      await (server_xvm as any)._create_app({
        _params: {
          _app_id: "runtime-source",
          _env: "test",
          _entry_view_id: "main",
        },
      });
      await (server_xvm as any)._create_app({
        _params: {
          _app_id: "runtime-target",
          _env: "test",
          _entry_view_id: "main",
        },
      });
      await (server_xvm as any)._set_flow({
        _params: {
          _app_id: "runtime-source",
          _env: "test",
          _flow: dynamic_target_flow({
            _app_id: "$event._app_id",
            _env: "$event._env",
          }),
        },
      });

      (_x as any).execute = async (cmd: any) => {
        if (cmd?._module === "server-xvm") {
          const method = `_${String(cmd._op ?? "").replaceAll("-", "_")}`;
          if (cmd?._op === "get_app" && cmd?._params?._app_id !== "runtime-source") {
            target_step_dispatches += 1;
          }
          if (typeof (server_xvm as any)[method] !== "function") {
            throw new Error(`Unexpected server-xvm op ${cmd._op}`);
          }
          return (server_xvm as any)[method](cmd);
        }
        return typeof original_execute === "function"
          ? original_execute.call(_x, cmd)
          : { _ok: true };
      };

      const valid_runtime = await (flow_manager as any)._run({
        _params: {
          _app_id: "runtime-source",
          _env: "test",
          _flow_id: "dynamic-target-flow",
          _event_payload: {
            _app_id: "runtime-target",
            _env: "test",
          },
        },
      });
      assert.equal(valid_runtime._ok, true);
      assert.equal(
        valid_runtime._result._flow._outputs["dynamic.target.app_id"],
        "runtime-target",
      );
      assert.equal(target_step_dispatches, 1);

      const empty_runtime = await (flow_manager as any)._run({
        _params: {
          _app_id: "runtime-source",
          _env: "test",
          _flow_id: "dynamic-target-flow",
          _event_payload: {
            _app_id: "",
            _env: "test",
          },
        },
      });
      assert.equal(empty_runtime._ok, false);
      assert.equal(response_has_error_code(empty_runtime, "E_FLOW_INVALID_TARGET_APP_ID"), true);

      const invalid_runtime = await (flow_manager as any)._run({
        _params: {
          _app_id: "runtime-source",
          _env: "test",
          _flow_id: "dynamic-target-flow",
          _event_payload: {
            _app_id: "../bad",
            _env: "test",
          },
        },
      });
      assert.equal(invalid_runtime._ok, false);
      assert.equal(response_has_error_code(invalid_runtime, "E_FLOW_INVALID_TARGET_APP_ID"), true);

      const invalid_env_runtime = await (flow_manager as any)._run({
        _params: {
          _app_id: "runtime-source",
          _env: "test",
          _flow_id: "dynamic-target-flow",
          _event_payload: {
            _app_id: "runtime-target",
            _env: "../bad",
          },
        },
      });
      assert.equal(invalid_env_runtime._ok, false);
      assert.equal(response_has_error_code(invalid_env_runtime, "E_FLOW_INVALID_TARGET_ENV"), true);

      const dispatches_before_unresolved = target_step_dispatches;
      const unresolved_runtime = await (flow_manager as any)._run({
        _params: {
          _app_id: "runtime-source",
          _env: "test",
          _flow_id: "dynamic-target-flow",
          _event_payload: {
            _app_id: "$event.other",
            _env: "test",
          },
        },
      });
      assert.equal(unresolved_runtime._ok, false);
      assert.equal(response_has_error_code(unresolved_runtime, "E_FLOW_INVALID_TARGET_APP_ID"), true);
      assert.equal(target_step_dispatches, dispatches_before_unresolved);
    } finally {
      (_x as any).execute = original_execute;
      await rm(work_folder, { recursive: true, force: true });
    }
  }
}

function deterministic_visibility_operation(input: {
  _id?: string;
  _app_id: string;
  _env: string;
  _view_id: string;
  _target_id: string;
  _edit_action?: string;
  _property_name?: string;
  _property_value?: boolean;
  _precondition?: Record<string, any>;
}): any {
  return {
    _type: "deterministic",
    ...(input._id ? { _id: input._id } : {}),
    _primitive: {
      _module: "xvibe",
      _op: "apply-view-edit",
      _params: {
        _app_id: input._app_id,
        _env: input._env,
        _view_id: input._view_id,
        _edit_action: input._edit_action ?? "hide-object",
        _target_id: input._target_id,
        ...(input._property_name !== undefined
          ? { _property_name: input._property_name }
          : {}),
        ...(input._property_value !== undefined
          ? { _property_value: input._property_value }
          : {}),
        ...(input._precondition ? { _precondition: input._precondition } : {}),
      },
    },
  };
}

async function create_change_plan_server_fixture(input: {
  _app_id: string;
  _initial_title?: string;
}) {
  const work_folder = await mkdtemp(path.join(tmpdir(), "xnode-change-plan-"));
  const server_xvm = new NodePackage.ServerXVMModule({ _work_folder: work_folder });
  const app_id = input._app_id;
  const env = "test";

  await (server_xvm as any)._create_app({
    _params: {
      _app_id: app_id,
      _env: env,
      _entry_view_id: "main",
    },
  });
  await (server_xvm as any)._push_update({
    _params: {
      _app_id: app_id,
      _env: env,
      _view: change_plan_test_view("main", input._initial_title ?? "Starter"),
    },
  });
  await (server_xvm as any)._set_flow({
    _params: {
      _app_id: app_id,
      _env: env,
      _flow: {
        _id: "save_item",
        _steps: [],
      },
    },
  });
  const original_execute = (_x as any).execute;
  try {
    (_x as any).execute = async (cmd: any) => {
      if (cmd?._module === "entity-manager" && cmd?._op === "register") {
        return { _ok: true, _result: { _registered: true } };
      }
      return typeof original_execute === "function"
        ? original_execute.call(_x, cmd)
        : { _ok: true };
    };
    await (server_xvm as any)._set_entity({
      _params: {
        _app_id: app_id,
        _env: env,
        _entity: {
          _id: "item",
          _schema: {
            name: { _type: "string" },
          },
        },
      },
    });
  } finally {
    (_x as any).execute = original_execute;
  }
  await (server_xvm as any)._save_project_memory({
    _params: {
      _app_id: app_id,
      _env: env,
      _memory: {
        _version: 1,
        _stage: "building",
        _vision: "Build a generated operation app",
        _goal: "Apply safe Change Plan operations",
        _current_focus: "Main",
        _completed: [],
        _achievements: [],
        _milestones: [
          {
            _id: "main",
            _title: "Main",
            _items: [
              {
                _id: "main",
                _title: "Main",
                _completed: false,
                _artifact_type: "view",
                _view_id: "main",
              },
            ],
          },
        ],
        _parking_lot: [],
        _decisions: [],
        _notes: [],
        _updated_at: "2026-01-01T00:00:00.000Z",
      },
    },
  });

  return {
    server_xvm,
    work_folder,
    app_id,
    env,
  };
}

async function run_server_xvm_change_plan_operation_tests() {
  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "generated-view-op",
    });
    try {
      const operation = generated_view_operation({
        _id: "replace-main",
        _app_id: fixture.app_id,
        _env: fixture.env,
        _view_id: "main",
        _title: "Generated Main",
      });
      const result = await (fixture.server_xvm as any)._apply_generated_operation({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operation: operation,
        },
      });

      assert.equal(result._ok, true);
      assert.equal(result._result._operation._id, "replace-main");
      assert.equal(result._result._refresh._views.main._children[0]._text, "Generated Main");
      assert.deepEqual(
        result._result._project_memory._last_change_plan_execution._operations[0],
        operation,
      );
      assert.ok(
        result._result._project_memory._achievements.some(
          (achievement: any) => achievement._id === "first-suggested-action-applied",
        ),
      );
      assert.deepEqual(
        result._result._refresh._runtime_assets._entities,
        [{ _id: "item" }],
      );
      assert.deepEqual(
        result._result._refresh._runtime_assets._flows,
        [{ _id: "save_item" }],
      );
    } finally {
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "mixed-plan-order",
    });
    const original_execute = (_x as any).execute;
    const execution_order: string[] = [];
    try {
      (_x as any).execute = async (cmd: any) => {
        execution_order.push(`${cmd._module}.${cmd._op}`);
        if (cmd._module === "xvibe" && cmd._op === "apply-view-edit") {
          return apply_change_plan_view_edit_with_vibe_executor({
            _server_xvm: fixture.server_xvm,
            _app_id: fixture.app_id,
            _env: fixture.env,
            _cmd: cmd,
          });
        }
        throw new Error(`Unexpected command ${cmd._module}.${cmd._op}`);
      };

      const result = await (fixture.server_xvm as any)._apply_change_plan_operations({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operations: [
            {
              _type: "generated",
              _operation: generated_view_operation({
                _id: "generated-after-deterministic",
                _app_id: fixture.app_id,
                _env: fixture.env,
                _view_id: "main",
                _title: "Generated After Deterministic",
              }),
            },
            {
              _type: "deterministic",
              _id: "deterministic-first",
              _primitive: {
                _module: "xvibe",
                _op: "apply-view-edit",
                _params: {
                  _app_id: fixture.app_id,
                  _env: fixture.env,
                  _view_id: "main",
                  _edit_action: "hide-object",
                  _target_id: "main-summary",
                },
              },
            },
          ],
        },
      });

      assert.equal(result._ok, true);
      assert.deepEqual(execution_order, ["xvibe.apply-view-edit"]);
      assert.equal(result._result._operations[0]._type, "deterministic");
      assert.equal(result._result._operations[1]._type, "generated");
      const view = await (fixture.server_xvm as any)._get_view({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view_id: "main",
        },
      });
      assert.equal(view._result._view._children[0]._text, "Generated After Deterministic");
    } finally {
      (_x as any).execute = original_execute;
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "stale-target",
    });
    try {
      const initial = await (fixture.server_xvm as any)._get_view({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view_id: "main",
        },
      });
      const operation = generated_view_operation({
        _id: "stale-main",
        _app_id: fixture.app_id,
        _env: fixture.env,
        _view_id: "main",
        _title: "Should Not Apply",
        _precondition: {
          _target_hash: change_plan_view_hash(initial._result._view),
        },
      });
      await (fixture.server_xvm as any)._push_update({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view: change_plan_test_view("main", "Changed Elsewhere"),
        },
      });
      const result = await (fixture.server_xvm as any)._apply_generated_operation({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operation: operation,
        },
      });

      assert.equal(result._ok, false);
      assert.equal(result._result._code, "E_XVM_CHANGE_PLAN_STALE_CONTEXT");
      const view = await (fixture.server_xvm as any)._get_view({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view_id: "main",
        },
      });
      assert.equal(view._result._view._children[0]._text, "Changed Elsewhere");
    } finally {
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "duplicate-safe",
    });
    try {
      const operation = generated_view_operation({
        _id: "replace-main-once",
        _app_id: fixture.app_id,
        _env: fixture.env,
        _view_id: "main",
        _title: "Idempotent Main",
      });
      const first = await (fixture.server_xvm as any)._apply_generated_operation({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operation: operation,
        },
      });
      const second = await (fixture.server_xvm as any)._apply_generated_operation({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operation: operation,
        },
      });
      assert.equal(first._ok, true);
      assert.equal(second._ok, true);
      assert.equal(second._result._already_completed, true);

      const duplicate_create = await (fixture.server_xvm as any)._apply_generated_operation({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operation: generated_view_operation({
            _id: "create-main-duplicate",
            _app_id: fixture.app_id,
            _env: fixture.env,
            _view_id: "main",
            _kind: "view.create",
            _title: "Different Main",
          }),
        },
      });
      assert.equal(duplicate_create._ok, false);
      assert.equal(duplicate_create._result._code, "E_XVM_GENERATED_OPERATION_DUPLICATE_ARTIFACT");
    } finally {
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "rollback-plan",
    });
    const original_execute = (_x as any).execute;
    try {
      const initial = await (fixture.server_xvm as any)._get_view({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view_id: "main",
        },
      });
      (_x as any).execute = async (cmd: any) => {
        if (cmd._module === "xvibe" && cmd._op === "apply-view-edit") {
          return apply_change_plan_view_edit_with_vibe_executor({
            _server_xvm: fixture.server_xvm,
            _app_id: fixture.app_id,
            _env: fixture.env,
            _cmd: cmd,
          });
        }
        throw new Error(`Unexpected command ${cmd._module}.${cmd._op}`);
      };

      const result = await (fixture.server_xvm as any)._apply_change_plan_operations({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operations: [
            {
              _type: "deterministic",
              _primitive: {
                _module: "xvibe",
                _op: "apply-view-edit",
                _params: {
                  _app_id: fixture.app_id,
                  _env: fixture.env,
                  _view_id: "main",
                  _edit_action: "hide-object",
                  _target_id: "main-summary",
                },
              },
            },
            {
              _type: "generated",
              _operation: generated_view_operation({
                _id: "stale-after-deterministic",
                _app_id: fixture.app_id,
                _env: fixture.env,
                _view_id: "main",
                _title: "Should Roll Back",
                _precondition: {
                  _target_hash: change_plan_view_hash(initial._result._view),
                },
              }),
            },
          ],
        },
      });

      assert.equal(result._ok, false);
      assert.equal(result._result._rollback._ok, true);
      const view = await (fixture.server_xvm as any)._get_view({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view_id: "main",
        },
      });
      assert.deepEqual(view._result._view, initial._result._view);
    } finally {
      (_x as any).execute = original_execute;
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "hide-one-object",
    });
    const original_execute = (_x as any).execute;
    const executed: any[] = [];
    let update_events = 0;
    const listener_id = NodePackage._xem.on("server-xvm:update", (payload: any) => {
      if (payload?._app_id === fixture.app_id && payload?._view_id === "main") {
        update_events += 1;
      }
    });
    try {
      (_x as any).execute = async (cmd: any) => {
        executed.push(cmd);
        if (cmd?._module === "entity-manager" && cmd?._op === "register") {
          return { _ok: true, _result: { _registered: true } };
        }
        if (cmd._module === "xvibe" && cmd._op === "apply-view-edit") {
          return apply_change_plan_view_edit_with_vibe_executor({
            _server_xvm: fixture.server_xvm,
            _app_id: fixture.app_id,
            _env: fixture.env,
            _cmd: cmd,
          });
        }
        throw new Error(`Unexpected command ${cmd._module}.${cmd._op}`);
      };

      const result = await (fixture.server_xvm as any)._apply_change_plan_operations({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operations: [
            deterministic_visibility_operation({
              _id: "hide-summary",
              _app_id: fixture.app_id,
              _env: fixture.env,
              _view_id: "main",
              _target_id: "main-summary",
            }),
          ],
        },
      });

      assert.equal(result._ok, true);
      assert.equal(result._result._results[0]._status, "updated");
      assert.equal(executed.length, 1);
      const view = await (fixture.server_xvm as any)._get_view({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view_id: "main",
        },
      });
      assert.equal(find_json_object_by_id(view._result._view, "main-summary")._visible, false);
      assert.equal(find_json_object_by_id(view._result._view, "main-summary")._hidden, undefined);
      assert.equal(find_json_object_by_id(view._result._view, "main-title")._text, "Starter");
      assert.ok(result._result._project_memory._last_change_plan_execution);
      assert.deepEqual(
        result._result._refresh._runtime_assets._flows,
        [{ _id: "save_item" }],
      );
      assert.equal(update_events >= 1, true);

      const backup_dir = path.join(
        fixture.work_folder,
        "xvm",
        "apps",
        fixture.env,
        fixture.app_id,
        "old_views",
      );
      assert.equal((await readdir(backup_dir)).length >= 1, true);

      const reloaded = new NodePackage.ServerXVMModule({ _work_folder: fixture.work_folder });
      await (reloaded as any).init_on_boot();
      const reloaded_view = await (reloaded as any)._get_view({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view_id: "main",
        },
      });
      assert.equal(find_json_object_by_id(reloaded_view._result._view, "main-summary")._visible, false);
    } finally {
      NodePackage._xem.remove(listener_id);
      (_x as any).execute = original_execute;
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "hide-several-objects",
    });
    const original_execute = (_x as any).execute;
    try {
      (_x as any).execute = async (cmd: any) => {
        if (cmd._module === "xvibe" && cmd._op === "apply-view-edit") {
          return apply_change_plan_view_edit_with_vibe_executor({
            _server_xvm: fixture.server_xvm,
            _app_id: fixture.app_id,
            _env: fixture.env,
            _cmd: cmd,
          });
        }
        throw new Error(`Unexpected command ${cmd._module}.${cmd._op}`);
      };

      const result = await (fixture.server_xvm as any)._apply_change_plan_operations({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operations: [
            deterministic_visibility_operation({
              _id: "hide-summary",
              _app_id: fixture.app_id,
              _env: fixture.env,
              _view_id: "main",
              _target_id: "main-summary",
            }),
            deterministic_visibility_operation({
              _id: "hide-footer",
              _app_id: fixture.app_id,
              _env: fixture.env,
              _view_id: "main",
              _target_id: "main-footer",
            }),
          ],
        },
      });

      assert.equal(result._ok, true);
      assert.deepEqual(
        result._result._results.map((item: any) => item._status),
        ["updated", "updated"],
      );
      const view = await (fixture.server_xvm as any)._get_view({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view_id: "main",
        },
      });
      assert.equal(find_json_object_by_id(view._result._view, "main-summary")._visible, false);
      assert.equal(find_json_object_by_id(view._result._view, "main-footer")._visible, false);
      assert.equal(find_json_object_by_id(view._result._view, "main-title")._text, "Starter");
    } finally {
      (_x as any).execute = original_execute;
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "already-hidden-object",
    });
    const original_execute = (_x as any).execute;
    let executed = 0;
    try {
      (_x as any).execute = async (cmd: any) => {
        executed += 1;
        if (cmd._module === "xvibe" && cmd._op === "apply-view-edit") {
          return apply_change_plan_view_edit_with_vibe_executor({
            _server_xvm: fixture.server_xvm,
            _app_id: fixture.app_id,
            _env: fixture.env,
            _cmd: cmd,
          });
        }
        throw new Error(`Unexpected command ${cmd._module}.${cmd._op}`);
      };

      const operation = deterministic_visibility_operation({
        _id: "hide-summary",
        _app_id: fixture.app_id,
        _env: fixture.env,
        _view_id: "main",
        _target_id: "main-summary",
      });
      const first = await (fixture.server_xvm as any)._apply_change_plan_operations({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operations: [operation],
        },
      });
      const second = await (fixture.server_xvm as any)._apply_change_plan_operations({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operations: [operation],
        },
      });

      assert.equal(first._ok, true);
      assert.equal(second._ok, true);
      assert.equal(second._result._results[0]._status, "already_hidden");
      assert.equal(second._result._results[0]._result._already_hidden, true);
      assert.equal(executed, 1);
    } finally {
      (_x as any).execute = original_execute;
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "visibility-target-missing",
    });
    const original_execute = (_x as any).execute;
    let executed = false;
    try {
      (_x as any).execute = async () => {
        executed = true;
        return { _ok: true };
      };
      const result = await (fixture.server_xvm as any)._apply_change_plan_operations({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operations: [
            deterministic_visibility_operation({
              _app_id: fixture.app_id,
              _env: fixture.env,
              _view_id: "main",
              _target_id: "missing-object",
            }),
          ],
        },
      });

      assert.equal(result._ok, false);
      assert.equal(result._result._code, "E_XVM_CHANGE_PLAN_TARGET_OBJECT_NOT_FOUND");
      assert.equal(executed, false);
      const view = await (fixture.server_xvm as any)._get_view({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view_id: "main",
        },
      });
      assert.equal(find_json_object_by_id(view._result._view, "main-summary")._visible, undefined);
    } finally {
      (_x as any).execute = original_execute;
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "visibility-stale-view",
    });
    const original_execute = (_x as any).execute;
    let executed = false;
    try {
      const initial = await (fixture.server_xvm as any)._get_view({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view_id: "main",
        },
      });
      await (fixture.server_xvm as any)._push_update({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _view: change_plan_test_view("main", "Changed Elsewhere"),
        },
      });
      (_x as any).execute = async () => {
        executed = true;
        return { _ok: true };
      };
      const result = await (fixture.server_xvm as any)._apply_change_plan_operations({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operations: [
            deterministic_visibility_operation({
              _app_id: fixture.app_id,
              _env: fixture.env,
              _view_id: "main",
              _target_id: "main-summary",
              _precondition: {
                _view_hash: change_plan_view_hash(initial._result._view),
              },
            }),
          ],
        },
      });

      assert.equal(result._ok, false);
      assert.equal(result._result._code, "E_XVM_CHANGE_PLAN_STALE_CONTEXT");
      assert.equal(executed, false);
    } finally {
      (_x as any).execute = original_execute;
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "visibility-invalid-property",
    });
    const original_execute = (_x as any).execute;
    let executed = false;
    try {
      (_x as any).execute = async () => {
        executed = true;
        return { _ok: true };
      };
      const result = await (fixture.server_xvm as any)._apply_change_plan_operations({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operations: [
            deterministic_visibility_operation({
              _app_id: fixture.app_id,
              _env: fixture.env,
              _view_id: "main",
              _target_id: "main-summary",
              _edit_action: "set-property",
              _property_name: "style",
              _property_value: false,
            }),
          ],
        },
      });

      assert.equal(result._ok, false);
      assert.equal(result._result._code, "E_XVM_CHANGE_PLAN_INVALID_PROPERTY");
      assert.equal(executed, false);
    } finally {
      (_x as any).execute = original_execute;
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }

  {
    const fixture = await create_change_plan_server_fixture({
      _app_id: "runtime-refresh",
    });
    try {
      const result = await (fixture.server_xvm as any)._apply_generated_operation({
        _params: {
          _app_id: fixture.app_id,
          _env: fixture.env,
          _operation: generated_view_operation({
            _id: "create-details",
            _app_id: fixture.app_id,
            _env: fixture.env,
            _view_id: "details",
            _kind: "view.create",
            _title: "Details",
            _set_default_view: true,
          }),
        },
      });

      assert.equal(result._ok, true);
      assert.equal(result._result._refresh._default_view_id, "details");
      assert.deepEqual(
        result._result._refresh._view_ids.sort(),
        ["details", "main"],
      );
      assert.deepEqual(
        result._result._refresh._runtime_assets._flows,
        [{ _id: "save_item" }],
      );
      assert.ok(result._result._project_memory._last_change_plan_execution);
    } finally {
      await rm(fixture.work_folder, { recursive: true, force: true });
    }
  }
}

await run_node_core_compatibility_tests();
await run_operations_starter_image_contract_tests();
await run_xnode_generic_composition_tests();
await run_xnode_planning_contract_tests();
await run_server_xvm_composed_semantic_runtime_acceptance_tests();
await run_entity_manager_scoped_runtime_entity_tests();
await run_server_xvm_semantic_runtime_composition_tests();
await run_server_xvm_semantic_validation_tests();
await run_server_xvm_dynamic_reference_validation_tests();
await run_server_xvm_change_plan_operation_tests();

console.log("@xpell/node generic tests passed");
