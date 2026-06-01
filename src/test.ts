import assert from "assert";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { _x } from "@xpell/core";
import { XModuleCreatorModule } from "./XGenerative/XModuleCreator/index.js";
import {
  build_generated_module_implementation_prompt,
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
import type { XVibeViewArtifact } from "./XVIBE/VibeOutputParser.js";
import { VibeIntentPlanner } from "./XVIBE/VibeIntentPlanner.js";

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
assert.equal(strip_when_prompt_disallows_flow(explicit_flow_prompt, explicit_flow_view), 0);
assert.deepEqual((explicit_flow_view._children?.[0] as any)._flow, {
  _id: "flow-save-customer",
});

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

console.log("XVibe tests passed");
