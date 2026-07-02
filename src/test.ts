import assert from "assert";
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { _x, _xlog } from "@xpell/core";
import { XModuleCreatorModule } from "./XGenerative/XModuleCreator/index.js";
import { XAuthModule } from "./XAuth/index.js";
import { XDB, XDBStorageFS } from "./XDB/index.js";
import { XEntityManager } from "./XEntityManager/XEntityManager.js";
import { XStudioModule } from "./XStudio/XStudioModule.js";
import { ServerXVMModule } from "./XVM/ServerXVMModule.js";
import {
  build_generated_module_implementation_prompt,
  build_xvibe_runtime_plan,
  infer_xvibe_artifact_action_plan,
  infer_xvibe_artifact_plan,
  infer_xvibe_artifact_type,
  XVibeModule,
  apply_deterministic_view_edit,
  can_apply_deterministic_view_edit,
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
  create_module_intent_plan_from_resolved_task,
  extract_module_operation_matches_from_prompt,
  resolve_xvibe_task,
  VibeIntentPlanner,
} from "./XVIBE/VibeIntentPlanner.js";
import {
  XVibeIntentEngine,
  type XVibeIntentEngineOptions,
} from "./XVIBE/XVibeIntentEngine.js";
import {
  IntentMemoryStore,
  validate_learned_intent_result,
} from "./XVIBE/IntentMemory/IntentMemoryStore.js";
import {
  SemanticIntentProcessor,
  type XVibeSemanticIntentGenerateJsonInput,
} from "./XVIBE/Processors/SemanticIntentProcessor.js";
import { VibeBehaviorPlanner } from "./XVIBE/VibeBehaviorPlanner.js";
import { XMutator } from "./XMutator/XMutator.js";
import { _XSettings } from "./XSettings/XSettings.js";

type ValidateGeneratedArtifact = (input: {
  _artifact_type: "view" | "command";
  _artifact: XVibeViewArtifact | any;
  _prompt: string;
  _runtime_skills: unknown;
  _runtime_plan?: ReturnType<typeof build_xvibe_runtime_plan>;
  _generated_artifacts?: unknown;
  _planned_flow_ids?: string[];
}) => { _ok: true; _errors: [] } | { _ok: false; _errors: string[] };

function strip_when_prompt_disallows_flow(prompt: string, view: XVibeViewArtifact): number {
  if (prompt_allows_view_flow_triggers(prompt)) {
    return 0;
  }

  return strip_unrequested_flow_triggers(view);
}

function test_style_has_display_none(style: unknown): boolean {
  return (
    typeof style === "string" &&
    /(?:^|;)\s*display\s*:\s*none\s*(?:;|$)/iu.test(style)
  );
}

function xui_render_path_node_is_visible(node: Record<string, unknown>): boolean {
  const has_hidden_attribute =
    node.hidden !== undefined &&
    node.hidden !== false &&
    node.hidden !== "false";
  return !has_hidden_attribute && !test_style_has_display_none(node.style);
}

function find_xui_node_for_test(value: unknown, id: string): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = find_xui_node_for_test(item, id);
      if (found) return found;
    }
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const node = value as Record<string, unknown>;
  if (node._id === id) {
    return node;
  }

  if (Array.isArray(node._children)) {
    return find_xui_node_for_test(node._children, id);
  }

  return undefined;
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

function decode_jwt_payload_for_test(token: string): Record<string, unknown> {
  const payload_part = token.split(".")[1];
  assert.ok(payload_part, "JWT payload part is required");
  const base64 = payload_part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  return JSON.parse(Buffer.from(padded, "base64").toString("utf-8"));
}

const XVIBE_INTENT_STUB_CONVERSATION_RESULT = {
  _message_type: "conversation",
  _execution_level: "none",
  _should_mutate: false,
  _confidence: 0,
  _reason: "stub_intent_engine",
  _actions: [],
  _warnings: [],
};

const XVIBE_INTENT_PROCESSOR_CHAIN = [
  "DeterministicIntentProcessor",
  "LearnedIntentProcessor",
  "SemanticIntentProcessor",
];

const XVIBE_SEMANTIC_VALID_INTENT = {
  _message_type: "question",
  _execution_level: "model",
  _should_mutate: false,
  _confidence: 0.82,
  _reason: "mock_semantic_intent",
  _actions: [
    {
      _id: "semantic-reply",
      _title: "Reply",
      _action_type: "reply",
      _status: "suggested",
    },
  ],
  _warnings: [],
};

function set_xvibe_semantic_intent_env(
  enabled: string | undefined,
  provider?: string,
) {
  if (enabled === undefined) {
    delete process.env.XVIBE_SEMANTIC_INTENT_ENABLED;
  } else {
    process.env.XVIBE_SEMANTIC_INTENT_ENABLED = enabled;
  }

  if (provider === undefined) {
    delete process.env.XVIBE_SEMANTIC_INTENT_PROVIDER;
  } else {
    process.env.XVIBE_SEMANTIC_INTENT_PROVIDER = provider;
  }
}

const xvibe_empty_intent_memory_work_dir =
  await mkdtemp(path.join(tmpdir(), "xvibe-empty-intent-memory-"));
const xvibe_empty_intent_memory_store = new IntentMemoryStore({
  _work_folder: xvibe_empty_intent_memory_work_dir,
});

function xvibe_test_intent_engine(
  options: XVibeIntentEngineOptions = {},
): XVibeIntentEngine {
  return new XVibeIntentEngine({
    _intent_memory_store: xvibe_empty_intent_memory_store,
    ...options,
  });
}

async function write_xvibe_learned_intents(
  work_folder: string,
  entries: unknown[] | string,
): Promise<string> {
  const memory_dir = path.join(
    work_folder,
    "xvm",
    "apps",
    "test",
    "intent-test-app",
    "intent-memory",
  );
  await mkdir(memory_dir, { recursive: true });
  const memory_path = path.join(memory_dir, "learned-intents.json");
  await writeFile(
    memory_path,
    typeof entries === "string"
      ? entries
      : JSON.stringify(entries, null, 2),
  );
  return memory_path;
}

function xvibe_intent_selected_object_context(
  selected_object: Record<string, unknown> = {},
) {
  return {
    _app_id: "intent-test-app",
    _env: "test",
    _selected_object: {
      _source_view_id: "view-main",
      _json_id: "button-json-1",
      _id: "button-runtime-1",
      _type: "button",
      ...selected_object,
    },
  };
}

function assert_xvibe_selected_object_action(
  response: any,
  edit_action: string,
  extra_params: Record<string, unknown> = {},
) {
  assert.equal(response._ok, true);
  assert.equal(response._intent?._message_type, "edit");
  assert.equal(response._intent?._execution_level, "deterministic");
  assert.equal(response._intent?._should_mutate, true);
  assert.ok(response._intent?._confidence >= 0.9);
  assert.equal(response._intent?._actions.length, 1);

  const action = response._intent._actions[0];
  assert.equal(action._action_type, "apply-view-edit");
  assert.equal(action._status, "suggested");
  assert.equal(action._requires_approval, true);
  assert.deepEqual(action._params, {
    _view_id: "view-main",
    _target_id: "button-json-1",
    _target_type: "button",
    _edit_action: edit_action,
    ...extra_params,
  });
}

set_xvibe_semantic_intent_env(undefined);

const xvibe_intent_engine = xvibe_test_intent_engine();
const xvibe_intent_valid_res = await xvibe_intent_engine.analyze({
  _message: "hello",
  _runtime_context: {
    _app_id: "intent-test-app",
    _env: "test",
  },
});
assert.equal(xvibe_intent_valid_res._ok, true);
assert.deepEqual(xvibe_intent_valid_res._intent, XVIBE_INTENT_STUB_CONVERSATION_RESULT);
assert.equal(xvibe_intent_valid_res._intent?._should_mutate, false);
assert.deepEqual(xvibe_intent_valid_res._intent?._actions, []);
assert.deepEqual(
  xvibe_intent_valid_res._processor_chain,
  XVIBE_INTENT_PROCESSOR_CHAIN,
);
assert.equal(typeof xvibe_intent_valid_res._duration_ms, "number");

const xvibe_learn_file_create_work_dir =
  await mkdtemp(path.join(tmpdir(), "xvibe-learn-file-create-"));
const xvibe_learn_file_create_store = new IntentMemoryStore({
  _work_folder: xvibe_learn_file_create_work_dir,
});
const xvibe_learn_file_create_res =
  await xvibe_learn_file_create_store.learn({
    _app_id: "intent-test-app",
    _env: "test",
    _normalized_prompt: "first learned phrase",
    _intent: XVIBE_SEMANTIC_VALID_INTENT as any,
    _source: "semantic",
    _verified: true,
  });
assert.equal(xvibe_learn_file_create_res._ok, true);
const xvibe_learn_file_create_path = path.join(
  xvibe_learn_file_create_work_dir,
  "xvm",
  "apps",
  "test",
  "intent-test-app",
  "intent-memory",
  "learned-intents.json",
);
assert.equal(
  xvibe_learn_file_create_res._ok
    ? xvibe_learn_file_create_res._path
    : undefined,
  xvibe_learn_file_create_path,
);
await access(xvibe_learn_file_create_path);
const xvibe_learn_file_create_entries = JSON.parse(
  await readFile(xvibe_learn_file_create_path, "utf-8"),
);
assert.equal(Array.isArray(xvibe_learn_file_create_entries), true);
assert.equal(xvibe_learn_file_create_entries.length, 1);
assert.equal(
  xvibe_learn_file_create_entries[0]._normalized_prompt,
  "first learned phrase",
);

const xvibe_learn_placeholder_work_dir =
  await mkdtemp(path.join(tmpdir(), "xvibe-learn-placeholder-"));
const xvibe_learn_placeholder_store = new IntentMemoryStore({
  _work_folder: xvibe_learn_placeholder_work_dir,
});
const xvibe_learn_placeholder_intent = {
  _message_type: "edit",
  _execution_level: "deterministic",
  _should_mutate: true,
  _confidence: 0.93,
  _reason: "placeholder_fixture",
  _actions: [
    {
      _id: "placeholder-edit",
      _title: "Hide selected label",
      _action_type: "apply-view-edit",
      _status: "suggested",
      _requires_approval: true,
      _params: {
        _view_id: "main",
        _target_id: "label-1",
        _target_type: "label",
        _source_view_id: "page-toolbar",
        _path: ["_children", 0],
        _edit_action: "hide-object",
        _style_value: "red",
        _text: "literal text",
      },
    },
  ],
  _warnings: [],
};
const xvibe_learn_placeholder_res =
  await xvibe_learn_placeholder_store.learn({
    _app_id: "intent-test-app",
    _env: "test",
    _normalized_prompt: "hide currently selected label",
    _intent: xvibe_learn_placeholder_intent as any,
    _source: "semantic",
    _verified: true,
  });
assert.equal(xvibe_learn_placeholder_res._ok, true);
const xvibe_learn_placeholder_path =
  xvibe_learn_placeholder_res._ok
    ? xvibe_learn_placeholder_res._path
    : "";
const read_xvibe_learn_placeholder_entries = async (): Promise<any[]> =>
  JSON.parse(await readFile(xvibe_learn_placeholder_path, "utf-8"));
const xvibe_learn_placeholder_entries =
  await read_xvibe_learn_placeholder_entries();
assert.deepEqual(
  xvibe_learn_placeholder_entries[0]._intent._actions[0]._params,
  {
    _view_id: "main",
    _target_id: "$selected._json_id",
    _target_type: "$selected._type",
    _source_view_id: "$selected._source_view_id",
    _path: "$selected._path",
    _edit_action: "hide-object",
    _style_value: "red",
    _text: "literal text",
  },
);
set_xvibe_semantic_intent_env("true", "placeholder-fallback-provider");
let xvibe_placeholder_semantic_generate_count = 0;
const xvibe_learn_placeholder_engine = xvibe_test_intent_engine({
  _intent_memory_store: xvibe_learn_placeholder_store,
  _semantic_generate_json: async () => {
    xvibe_placeholder_semantic_generate_count += 1;
    return XVIBE_SEMANTIC_VALID_INTENT;
  },
});
const xvibe_learn_placeholder_replay_res =
  await xvibe_learn_placeholder_engine.analyze({
    _message: "Hide currently selected label.",
    _runtime_context: {
      _app_id: "intent-test-app",
      _env: "test",
      _selected_object: {
        _json_id: "label-current",
        _id: "runtime-label-current",
        _type: "label",
        _source_view_id: "page-content",
        _path: ["_children", 2],
      },
    },
  });
assert.equal(xvibe_learn_placeholder_replay_res._ok, true);
assert.equal(
  xvibe_learn_placeholder_replay_res._processor,
  "LearnedIntentProcessor",
);
assert.deepEqual(
  xvibe_learn_placeholder_replay_res._intent?._actions[0]._params,
  {
    _view_id: "main",
    _target_id: "label-current",
    _target_type: "label",
    _source_view_id: "page-content",
    _path: ["_children", 2],
    _edit_action: "hide-object",
    _style_value: "red",
    _text: "literal text",
  },
);
const xvibe_learn_placeholder_second_replay_res =
  await xvibe_learn_placeholder_engine.analyze({
    _message: "hide currently selected label",
    _runtime_context: {
      _app_id: "intent-test-app",
      _env: "test",
      _selected_object: {
        _json_id: "label-next",
        _id: "runtime-label-next",
        _type: "label",
        _source_view_id: "page-footer",
        _path: ["_children", 5],
      },
    },
  });
assert.equal(
  xvibe_learn_placeholder_second_replay_res._processor,
  "LearnedIntentProcessor",
);
assert.equal(
  xvibe_learn_placeholder_second_replay_res._intent?._actions[0]._params?._target_id,
  "label-next",
);
assert.equal(
  xvibe_learn_placeholder_second_replay_res._intent?._actions[0]._params?._source_view_id,
  "page-footer",
);
const xvibe_learn_placeholder_missing_selected_res =
  await xvibe_learn_placeholder_engine.analyze({
    _message: "hide currently selected label",
    _runtime_context: {
      _app_id: "intent-test-app",
      _env: "test",
    },
  });
assert.equal(xvibe_learn_placeholder_missing_selected_res._ok, true);
assert.equal(
  xvibe_learn_placeholder_missing_selected_res._processor,
  "SemanticIntentProcessor",
);
assert.equal(xvibe_placeholder_semantic_generate_count, 1);
assert.deepEqual(
  (await read_xvibe_learn_placeholder_entries())[0]._intent._actions[0]._params,
  {
    _view_id: "main",
    _target_id: "$selected._json_id",
    _target_type: "$selected._type",
    _source_view_id: "$selected._source_view_id",
    _path: "$selected._path",
    _edit_action: "hide-object",
    _style_value: "red",
    _text: "literal text",
  },
);
set_xvibe_semantic_intent_env(undefined);

const xvibe_learned_created_at = "2026-01-01T00:00:00.000Z";
const xvibe_learned_updated_at = "2026-01-01T00:00:00.000Z";
const xvibe_learned_exact_intent = {
  _message_type: "question",
  _execution_level: "model",
  _should_mutate: false,
  _confidence: 0.91,
  _reason: "learned_exact_fixture",
  _actions: [
    {
      _id: "learned-exact-reply",
      _title: "Reply from learned memory",
      _action_type: "reply",
      _status: "suggested",
    },
  ],
  _warnings: [],
};
const xvibe_learned_work_dir =
  await mkdtemp(path.join(tmpdir(), "xvibe-learned-intent-"));
const xvibe_learned_memory_path = await write_xvibe_learned_intents(
  xvibe_learned_work_dir,
  [
    {
      _normalized_prompt: "what is this",
      _intent: xvibe_learned_exact_intent,
      _source: "semantic",
      _hits: 4,
      _created_at: xvibe_learned_created_at,
      _updated_at: xvibe_learned_updated_at,
    },
  ],
);
set_xvibe_semantic_intent_env("true", "learned-should-not-call-semantic");
let xvibe_learned_semantic_generate_count = 0;
const xvibe_learned_engine = xvibe_test_intent_engine({
  _intent_memory_store: new IntentMemoryStore({
    _work_folder: xvibe_learned_work_dir,
  }),
  _semantic_generate_json: async () => {
    xvibe_learned_semantic_generate_count += 1;
    return XVIBE_SEMANTIC_VALID_INTENT;
  },
});
const xvibe_learned_exact_res = await xvibe_learned_engine.analyze({
  _message: "  WHAT   is this???  ",
  _runtime_context: {
    _app_id: "intent-test-app",
    _env: "test",
  },
});
assert.equal(xvibe_learned_exact_res._ok, true);
assert.equal(xvibe_learned_exact_res._processor, "LearnedIntentProcessor");
assert.deepEqual(xvibe_learned_exact_res._intent, xvibe_learned_exact_intent);
assert.equal(xvibe_learned_semantic_generate_count, 0);
assert.equal(
  JSON.parse(await readFile(xvibe_learned_memory_path, "utf-8"))[0]._hits,
  5,
);
xvibe_learned_exact_res._intent!._actions[0]._title = "Mutated response";
const xvibe_learned_exact_clone_res = await xvibe_learned_engine.analyze({
  _message: "what is this",
  _runtime_context: {
    _app_id: "intent-test-app",
    _env: "test",
  },
});
assert.equal(
  xvibe_learned_exact_clone_res._intent?._actions[0]._title,
  "Reply from learned memory",
);
assert.equal(
  JSON.parse(await readFile(xvibe_learned_memory_path, "utf-8"))[0]._hits,
  6,
);
set_xvibe_semantic_intent_env(undefined);

const xvibe_learned_selected_type_work_dir =
  await mkdtemp(path.join(tmpdir(), "xvibe-learned-selected-type-"));
const xvibe_learned_generic_intent = {
  _message_type: "conversation",
  _execution_level: "model",
  _should_mutate: false,
  _confidence: 0.7,
  _reason: "learned_generic_fixture",
  _actions: [
    {
      _id: "learned-generic-reply",
      _title: "Generic learned reply",
      _action_type: "reply",
      _status: "suggested",
    },
  ],
  _warnings: [],
};
const xvibe_learned_button_intent = {
  _message_type: "edit",
  _execution_level: "model",
  _should_mutate: true,
  _confidence: 0.88,
  _reason: "learned_button_fixture",
  _actions: [
    {
      _id: "learned-button-edit",
      _title: "Edit learned button",
      _action_type: "apply-view-edit",
      _status: "suggested",
      _requires_approval: true,
      _params: {
        _view_id: "view-main",
        _target_id: "button-json-1",
        _target_type: "button",
        _edit_action: "hide-object",
      },
    },
  ],
  _warnings: [],
};
await write_xvibe_learned_intents(
  xvibe_learned_selected_type_work_dir,
  [
    {
      _normalized_prompt: "do the thing",
      _intent: xvibe_learned_generic_intent,
      _source: "semantic",
      _hits: 1,
      _created_at: xvibe_learned_created_at,
      _updated_at: xvibe_learned_updated_at,
    },
    {
      _normalized_prompt: "do the thing",
      _selected_type: "button",
      _intent: xvibe_learned_button_intent,
      _source: "semantic",
      _hits: 2,
      _created_at: xvibe_learned_created_at,
      _updated_at: xvibe_learned_updated_at,
    },
  ],
);
const xvibe_learned_selected_type_engine = xvibe_test_intent_engine({
  _intent_memory_store: new IntentMemoryStore({
    _work_folder: xvibe_learned_selected_type_work_dir,
  }),
});
const xvibe_learned_selected_type_res =
  await xvibe_learned_selected_type_engine.analyze({
    _message: "do the thing.",
    _runtime_context: xvibe_intent_selected_object_context({
      _type: "button",
    }),
  });
assert.equal(xvibe_learned_selected_type_res._ok, true);
assert.equal(
  xvibe_learned_selected_type_res._processor,
  "LearnedIntentProcessor",
);
assert.deepEqual(
  xvibe_learned_selected_type_res._intent,
  xvibe_learned_button_intent,
);

const xvibe_learned_miss_work_dir =
  await mkdtemp(path.join(tmpdir(), "xvibe-learned-miss-"));
await write_xvibe_learned_intents(
  xvibe_learned_miss_work_dir,
  [
    {
      _normalized_prompt: "stored phrase",
      _intent: xvibe_learned_exact_intent,
      _source: "semantic",
      _hits: 1,
      _created_at: xvibe_learned_created_at,
      _updated_at: xvibe_learned_updated_at,
    },
  ],
);
const xvibe_learned_miss_engine = xvibe_test_intent_engine({
  _intent_memory_store: new IntentMemoryStore({
    _work_folder: xvibe_learned_miss_work_dir,
  }),
});
const xvibe_learned_miss_res = await xvibe_learned_miss_engine.analyze({
  _message: "not stored",
  _runtime_context: {
    _app_id: "intent-test-app",
    _env: "test",
  },
});
assert.equal(xvibe_learned_miss_res._ok, true);
assert.deepEqual(
  xvibe_learned_miss_res._intent,
  XVIBE_INTENT_STUB_CONVERSATION_RESULT,
);

const xvibe_learned_corrupt_work_dir =
  await mkdtemp(path.join(tmpdir(), "xvibe-learned-corrupt-"));
await write_xvibe_learned_intents(
  xvibe_learned_corrupt_work_dir,
  "{ invalid json",
);
const xvibe_learned_corrupt_engine = xvibe_test_intent_engine({
  _intent_memory_store: new IntentMemoryStore({
    _work_folder: xvibe_learned_corrupt_work_dir,
  }),
});
const xvibe_learned_corrupt_res = await xvibe_learned_corrupt_engine.analyze({
  _message: "what is this",
  _runtime_context: {
    _app_id: "intent-test-app",
    _env: "test",
  },
});
assert.equal(xvibe_learned_corrupt_res._ok, true);
assert.deepEqual(
  xvibe_learned_corrupt_res._intent,
  XVIBE_INTENT_STUB_CONVERSATION_RESULT,
);

const xvibe_learned_deterministic_work_dir =
  await mkdtemp(path.join(tmpdir(), "xvibe-learned-deterministic-"));
await write_xvibe_learned_intents(
  xvibe_learned_deterministic_work_dir,
  [
    {
      _normalized_prompt: "hide selected",
      _intent: xvibe_learned_exact_intent,
      _source: "semantic",
      _hits: 1,
      _created_at: xvibe_learned_created_at,
      _updated_at: xvibe_learned_updated_at,
    },
  ],
);
const xvibe_learned_deterministic_engine = xvibe_test_intent_engine({
  _intent_memory_store: new IntentMemoryStore({
    _work_folder: xvibe_learned_deterministic_work_dir,
  }),
});
const xvibe_learned_deterministic_res =
  await xvibe_learned_deterministic_engine.analyze({
    _message: "hide selected",
    _runtime_context: xvibe_intent_selected_object_context(),
  });
assert.equal(
  xvibe_learned_deterministic_res._processor,
  "DeterministicIntentProcessor",
);
assert_xvibe_selected_object_action(
  xvibe_learned_deterministic_res,
  "hide-object",
);

set_xvibe_semantic_intent_env("true", "learned-miss-semantic-provider");
let xvibe_learned_miss_semantic_generate_count = 0;
const xvibe_learned_semantic_miss_engine = xvibe_test_intent_engine({
  _intent_memory_store: new IntentMemoryStore({
    _work_folder: xvibe_learned_miss_work_dir,
  }),
  _semantic_generate_json: async () => {
    xvibe_learned_miss_semantic_generate_count += 1;
    return XVIBE_SEMANTIC_VALID_INTENT;
  },
});
const xvibe_learned_semantic_miss_res =
  await xvibe_learned_semantic_miss_engine.analyze({
    _message: "semantic after learned miss",
    _runtime_context: {
      _app_id: "intent-test-app",
      _env: "test",
    },
  });
assert.equal(xvibe_learned_semantic_miss_res._ok, true);
assert.equal(
  xvibe_learned_semantic_miss_res._processor,
  "SemanticIntentProcessor",
);
assert.deepEqual(
  xvibe_learned_semantic_miss_res._intent,
  XVIBE_SEMANTIC_VALID_INTENT,
);
assert.equal(xvibe_learned_miss_semantic_generate_count, 1);
set_xvibe_semantic_intent_env(undefined);

let xvibe_intent_engine_xai_generate_count = 0;
const original_intent_engine_execute = (_x as any).execute;
try {
  (_x as any).execute = async (command: any) => {
    if (command?._module === "xai" && command?._op === "generate") {
      xvibe_intent_engine_xai_generate_count += 1;
      throw new Error("xai.generate should not be called for XVibeIntentEngine");
    }

    return original_intent_engine_execute.call(_x, command);
  };

  const xvibe_intent_hide_selected_res = await xvibe_intent_engine.analyze({
    _message: "hide selected",
    _runtime_context: xvibe_intent_selected_object_context(),
  });
  assert_xvibe_selected_object_action(
    xvibe_intent_hide_selected_res,
    "hide-object",
  );

  const xvibe_intent_delete_selected_res = await xvibe_intent_engine.analyze({
    _message: "delete selected",
    _runtime_context: xvibe_intent_selected_object_context(),
  });
  assert_xvibe_selected_object_action(
    xvibe_intent_delete_selected_res,
    "remove-object",
  );

  const xvibe_intent_duplicate_selected_res = await xvibe_intent_engine.analyze({
    _message: "duplicate selected",
    _runtime_context: xvibe_intent_selected_object_context(),
  });
  assert_xvibe_selected_object_action(
    xvibe_intent_duplicate_selected_res,
    "duplicate-object",
  );

  const xvibe_intent_move_up_res = await xvibe_intent_engine.analyze({
    _message: "move up",
    _runtime_context: xvibe_intent_selected_object_context(),
  });
  assert_xvibe_selected_object_action(
    xvibe_intent_move_up_res,
    "move-object",
    {
      _move_direction: "up",
      _requires_resolution: true,
    },
  );

  const xvibe_intent_move_down_res = await xvibe_intent_engine.analyze({
    _message: "move down",
    _runtime_context: xvibe_intent_selected_object_context(),
  });
  assert_xvibe_selected_object_action(
    xvibe_intent_move_down_res,
    "move-object",
    {
      _move_direction: "down",
      _requires_resolution: true,
    },
  );

  const xvibe_intent_no_selected_res = await xvibe_intent_engine.analyze({
    _message: "hide selected",
    _runtime_context: {
      _app_id: "intent-test-app",
      _env: "test",
    },
  });
  assert.equal(xvibe_intent_no_selected_res._ok, true);
  assert.deepEqual(
    xvibe_intent_no_selected_res._intent,
    XVIBE_INTENT_STUB_CONVERSATION_RESULT,
  );
  assert.deepEqual(
    xvibe_intent_no_selected_res._processor_chain,
    XVIBE_INTENT_PROCESSOR_CHAIN,
  );
  assert.equal(typeof xvibe_intent_no_selected_res._duration_ms, "number");

  const xvibe_intent_unrelated_res = await xvibe_intent_engine.analyze({
    _message: "make the selected button blue",
    _runtime_context: xvibe_intent_selected_object_context(),
  });
  assert.equal(xvibe_intent_unrelated_res._ok, true);
  assert.deepEqual(
    xvibe_intent_unrelated_res._intent,
    XVIBE_INTENT_STUB_CONVERSATION_RESULT,
  );
  assert.deepEqual(
    xvibe_intent_unrelated_res._processor_chain,
    XVIBE_INTENT_PROCESSOR_CHAIN,
  );
} finally {
  (_x as any).execute = original_intent_engine_execute;
}
assert.equal(xvibe_intent_engine_xai_generate_count, 0);

let xvibe_semantic_disabled_processor_generate_count = 0;
const xvibe_semantic_disabled_processor = new SemanticIntentProcessor({
  _generate_json: async () => {
    xvibe_semantic_disabled_processor_generate_count += 1;
    return XVIBE_SEMANTIC_VALID_INTENT;
  },
});
const xvibe_semantic_disabled_processor_res =
  await xvibe_semantic_disabled_processor.analyze({
    _message: "what can you do?",
    _conversation_id: "conversation-semantic-disabled",
    _runtime_context: {
      _app_id: "intent-test-app",
      _env: "test",
    },
  });
assert.equal(xvibe_semantic_disabled_processor_res, null);
assert.equal(xvibe_semantic_disabled_processor_generate_count, 0);

let xvibe_semantic_disabled_engine_generate_count = 0;
const xvibe_semantic_disabled_engine = xvibe_test_intent_engine({
  _semantic_generate_json: async () => {
    xvibe_semantic_disabled_engine_generate_count += 1;
    return XVIBE_SEMANTIC_VALID_INTENT;
  },
});
const xvibe_semantic_disabled_engine_res =
  await xvibe_semantic_disabled_engine.analyze({
    _message: "what can you do?",
    _conversation_id: "conversation-semantic-disabled",
    _runtime_context: {
      _app_id: "intent-test-app",
      _env: "test",
    },
  });
assert.equal(xvibe_semantic_disabled_engine_res._ok, true);
assert.deepEqual(
  xvibe_semantic_disabled_engine_res._intent,
  XVIBE_INTENT_STUB_CONVERSATION_RESULT,
);
assert.equal(xvibe_semantic_disabled_engine_generate_count, 0);

set_xvibe_semantic_intent_env("true");
let xvibe_semantic_deterministic_generate_count = 0;
const xvibe_semantic_deterministic_engine = xvibe_test_intent_engine({
  _semantic_generate_json: async () => {
    xvibe_semantic_deterministic_generate_count += 1;
    return XVIBE_SEMANTIC_VALID_INTENT;
  },
});
const xvibe_semantic_deterministic_res =
  await xvibe_semantic_deterministic_engine.analyze({
    _message: "hide selected",
    _runtime_context: xvibe_intent_selected_object_context(),
  });
assert_xvibe_selected_object_action(
  xvibe_semantic_deterministic_res,
  "hide-object",
);
assert.equal(
  xvibe_semantic_deterministic_res._processor,
  "DeterministicIntentProcessor",
);
assert.deepEqual(
  xvibe_semantic_deterministic_res._processor_chain,
  XVIBE_INTENT_PROCESSOR_CHAIN,
);
assert.equal(typeof xvibe_semantic_deterministic_res._duration_ms, "number");
assert.equal(xvibe_semantic_deterministic_generate_count, 0);

set_xvibe_semantic_intent_env("true", "mock-semantic-provider");
const xvibe_semantic_enabled_generate_inputs:
  XVibeSemanticIntentGenerateJsonInput[] = [];
const xvibe_semantic_enabled_engine = xvibe_test_intent_engine({
  _semantic_generate_json: async (input) => {
    xvibe_semantic_enabled_generate_inputs.push(input);
    return XVIBE_SEMANTIC_VALID_INTENT;
  },
});
const xvibe_semantic_enabled_res =
  await xvibe_semantic_enabled_engine.analyze({
    _message: "what can you do?",
    _conversation_id: "conversation-semantic-enabled",
    _runtime_context: {
      _app_id: "intent-test-app",
      _env: "test",
      _conversation_id: "conversation-semantic-enabled",
    },
  });
assert.equal(xvibe_semantic_enabled_res._ok, true);
assert.deepEqual(
  xvibe_semantic_enabled_res._intent,
  XVIBE_SEMANTIC_VALID_INTENT,
);
assert.equal(
  xvibe_semantic_enabled_res._processor,
  "SemanticIntentProcessor",
);
assert.deepEqual(
  xvibe_semantic_enabled_res._processor_chain,
  XVIBE_INTENT_PROCESSOR_CHAIN,
);
assert.equal(typeof xvibe_semantic_enabled_res._duration_ms, "number");
const xvibe_semantic_enabled_generate_input =
  xvibe_semantic_enabled_generate_inputs[0];
if (!xvibe_semantic_enabled_generate_input) {
  throw new Error("semantic generate input was not captured");
}
assert.equal(
  xvibe_semantic_enabled_generate_input.response_format.type,
  "json_object",
);
assert.equal(
  xvibe_semantic_enabled_generate_input._provider,
  "mock-semantic-provider",
);
assert.equal(
  xvibe_semantic_enabled_generate_input._task,
  "semantic-routing",
);
assert.notEqual(
  xvibe_semantic_enabled_generate_input._task,
  "chat",
);
assert.equal(
  xvibe_semantic_enabled_generate_input._capability,
  "semantic-routing",
);
assert.ok(
  xvibe_semantic_enabled_generate_input.system.includes("XVibeIntentResult"),
);
assert.ok(
  xvibe_semantic_enabled_generate_input.system.includes("_message_type"),
);
assert.ok(
  xvibe_semantic_enabled_generate_input.system.includes("_message_type must be one of: conversation, question, inspect, edit, generate, planning, debug."),
);
assert.ok(
  xvibe_semantic_enabled_generate_input.system.includes("Never use XVibeIntentResult as _message_type."),
);
assert.ok(
  xvibe_semantic_enabled_generate_input.system.includes("_execution_level must be one of: none, deterministic, artifact, planning, model."),
);
assert.ok(
  xvibe_semantic_enabled_generate_input.system.includes("Never use TYPED_OBJECT or TYPED_RUNTIME as _execution_level."),
);
assert.ok(
  xvibe_semantic_enabled_generate_input.prompt.includes("request._message"),
);
assert.ok(
  xvibe_semantic_enabled_generate_input.prompt.includes("Return the XVibeIntentResult JSON object directly."),
);
assert.ok(
  xvibe_semantic_enabled_generate_input.prompt.includes("_message_type must be one of: conversation, question, inspect, edit, generate, planning, debug."),
);
assert.ok(
  xvibe_semantic_enabled_generate_input.prompt.includes("Never use XVibeIntentResult as _message_type."),
);
assert.ok(
  xvibe_semantic_enabled_generate_input.prompt.includes("_execution_level must be one of: none, deterministic, artifact, planning, model."),
);
assert.ok(
  xvibe_semantic_enabled_generate_input.prompt.includes("Never use TYPED_OBJECT or TYPED_RUNTIME as _execution_level."),
);
assert.ok(
  xvibe_semantic_enabled_generate_input.prompt.includes("Do not wrap the result in query, intent, object_type, or object_id."),
);
assert.ok(
  xvibe_semantic_enabled_generate_input.prompt.includes("apply-view-edit"),
);
assert.ok(
  xvibe_semantic_enabled_generate_input.prompt.includes("\"_edit_action\":\"hide-object\""),
);
assert.deepEqual(
  xvibe_semantic_enabled_generate_input.context._schema,
  "XVibeIntentResult",
);

const xvibe_semantic_normalized_engine = xvibe_test_intent_engine({
  _semantic_generate_json: async () => ({
    _message_type: "IntentResult",
    _execution_level: "artifact",
    _should_mutate: true,
    _confidence: 0.78,
    _reason: "mock_semantic_aliases",
    _actions: [
      {
        _id: "semantic-normalized-view-edit",
        _title: "Hide object",
        _action_type: "view-edit",
        _status: "suggest",
        _requires_approval: true,
        _params: {
          _view_id: "view-main",
          _target_id: "button-json-1",
          _target_type: "button",
          _edit_action: "hide",
        },
      },
    ],
    _warnings: [],
  }),
});
const xvibe_semantic_normalized_res =
  await xvibe_semantic_normalized_engine.analyze({
    _message: "hide the selected button semantically",
    _runtime_context: {
      _app_id: "intent-test-app",
      _env: "test",
    },
  });
assert.equal(xvibe_semantic_normalized_res._ok, true);
assert.equal(
  xvibe_semantic_normalized_res._processor,
  "SemanticIntentProcessor",
);
assert.equal(
  xvibe_semantic_normalized_res._intent?._message_type,
  "edit",
);
assert.equal(
  xvibe_semantic_normalized_res._intent?._execution_level,
  "deterministic",
);
assert.equal(
  xvibe_semantic_normalized_res._intent?._actions[0]._action_type,
  "apply-view-edit",
);
assert.equal(
  xvibe_semantic_normalized_res._intent?._actions[0]._status,
  "suggested",
);
assert.equal(
  xvibe_semantic_normalized_res._intent?._actions[0]._params?._edit_action,
  "hide-object",
);
assert.equal(
  xvibe_semantic_normalized_res._intent?._actions[0]._requires_approval,
  true,
);

const xvibe_semantic_missing_edit_defaults_engine = xvibe_test_intent_engine({
  _semantic_generate_json: async () => ({
    _message_type: "ViewEditIntent",
    _execution_level: "model",
    _should_mutate: true,
    _confidence: 0.79,
    _reason: "mock_semantic_missing_edit_defaults",
    _actions: [
      {
        _id: "semantic-missing-edit-defaults",
        _title: "Show object",
        _action_type: "apply-view-edit",
        _params: {
          _view_id: "view-main",
          _target_id: "button-json-1",
          _target_type: "button",
          _edit_action: "show",
        },
      },
    ],
    _warnings: [],
  }),
});
const xvibe_semantic_missing_edit_defaults_res =
  await xvibe_semantic_missing_edit_defaults_engine.analyze({
    _message: "show the selected button semantically",
    _runtime_context: {
      _app_id: "intent-test-app",
      _env: "test",
    },
  });
assert.equal(xvibe_semantic_missing_edit_defaults_res._ok, true);
assert.equal(
  xvibe_semantic_missing_edit_defaults_res._processor,
  "SemanticIntentProcessor",
);
assert.equal(
  xvibe_semantic_missing_edit_defaults_res._intent?._message_type,
  "edit",
);
assert.equal(
  xvibe_semantic_missing_edit_defaults_res._intent?._execution_level,
  "deterministic",
);
assert.equal(
  xvibe_semantic_missing_edit_defaults_res._intent?._actions[0]._status,
  "suggested",
);
assert.equal(
  xvibe_semantic_missing_edit_defaults_res._intent?._actions[0]._requires_approval,
  true,
);
assert.equal(
  xvibe_semantic_missing_edit_defaults_res._intent?._actions[0]._params?._edit_action,
  "show-object",
);

const xvibe_semantic_schema_name_edit_engine = xvibe_test_intent_engine({
  _semantic_generate_json: async () => ({
    _message_type: "XVibeIntentResult",
    _execution_level: "TYPED_OBJECT",
    _should_mutate: true,
    _confidence: 0.81,
    _reason: "The user wants to hide the selected label.",
    _actions: [
      {
        _id: "semantic-schema-name-edit",
        _title: "Hide label",
        _action_type: "apply-view-edit",
        _status: "suggested",
        _requires_approval: true,
        _params: {
          _view_id: "view-main",
          _target_id: "label-json-1",
          _target_type: "label",
          _edit_action: "hide-object",
        },
      },
    ],
    _warnings: [],
  }),
});
const xvibe_semantic_schema_name_edit_res =
  await xvibe_semantic_schema_name_edit_engine.analyze({
    _message: "hide the selected label semantically",
    _runtime_context: {
      _app_id: "intent-test-app",
      _env: "test",
    },
  });
assert.equal(xvibe_semantic_schema_name_edit_res._ok, true);
assert.equal(
  xvibe_semantic_schema_name_edit_res._processor,
  "SemanticIntentProcessor",
);
assert.equal(
  xvibe_semantic_schema_name_edit_res._intent?._message_type,
  "edit",
);
assert.equal(
  xvibe_semantic_schema_name_edit_res._intent?._execution_level,
  "deterministic",
);

const xvibe_semantic_schema_name_without_actions_engine =
  xvibe_test_intent_engine({
    _semantic_generate_json: async () => ({
      _message_type: "XVibeIntentResult",
      _execution_level: "TYPED_OBJECT",
      _should_mutate: true,
      _confidence: 0.62,
      _reason: "The model used the schema name without an edit action.",
      _actions: [],
      _warnings: [],
    }),
  });
const xvibe_semantic_schema_name_without_actions_res =
  await xvibe_semantic_schema_name_without_actions_engine.analyze({
    _message: "what should happen?",
    _runtime_context: {
      _app_id: "intent-test-app",
      _env: "test",
    },
  });
assert.equal(xvibe_semantic_schema_name_without_actions_res._ok, true);
assert.deepEqual(
  xvibe_semantic_schema_name_without_actions_res._intent,
  XVIBE_INTENT_STUB_CONVERSATION_RESULT,
);

const xvibe_semantic_non_edit_typed_runtime_engine = xvibe_test_intent_engine({
  _semantic_generate_json: async () => ({
    _message_type: "generate",
    _execution_level: "typed_runtime",
    _should_mutate: true,
    _confidence: 0.73,
    _reason: "The model used a typed runtime level for generation.",
    _actions: [
      {
        _id: "semantic-generate-typed-runtime",
        _title: "Generate artifact",
        _action_type: "generate-artifact",
        _status: "suggested",
        _requires_approval: true,
      },
    ],
    _warnings: [],
  }),
});
const xvibe_semantic_non_edit_typed_runtime_res =
  await xvibe_semantic_non_edit_typed_runtime_engine.analyze({
    _message: "generate a new view semantically",
    _runtime_context: {
      _app_id: "intent-test-app",
      _env: "test",
    },
  });
assert.equal(xvibe_semantic_non_edit_typed_runtime_res._ok, true);
assert.deepEqual(
  xvibe_semantic_non_edit_typed_runtime_res._intent,
  XVIBE_INTENT_STUB_CONVERSATION_RESULT,
);

const xvibe_semantic_non_edit_schema_label_engine = xvibe_test_intent_engine({
  _semantic_generate_json: async () => ({
    _message_type: "EditIntent",
    _execution_level: "artifact",
    _should_mutate: true,
    _confidence: 0.74,
    _reason: "The model used an edit schema label for generation.",
    _actions: [
      {
        _id: "semantic-generate-schema-label",
        _title: "Generate artifact",
        _action_type: "generate-artifact",
        _status: "suggested",
        _requires_approval: true,
      },
    ],
    _warnings: [],
  }),
});
const xvibe_semantic_non_edit_schema_label_res =
  await xvibe_semantic_non_edit_schema_label_engine.analyze({
    _message: "generate a new view semantically",
    _runtime_context: {
      _app_id: "intent-test-app",
      _env: "test",
    },
  });
assert.equal(xvibe_semantic_non_edit_schema_label_res._ok, true);
assert.deepEqual(
  xvibe_semantic_non_edit_schema_label_res._intent,
  XVIBE_INTENT_STUB_CONVERSATION_RESULT,
);

const xvibe_semantic_non_edit_planning_typed_object_engine =
  xvibe_test_intent_engine({
    _semantic_generate_json: async () => ({
      _message_type: "planning",
      _execution_level: "typed_object",
      _should_mutate: false,
      _confidence: 0.72,
      _reason: "The model used a typed object level for planning.",
      _actions: [
        {
          _id: "semantic-planning-typed-object",
          _title: "Ask for clarification",
          _action_type: "ask-user",
          _status: "suggested",
          _requires_approval: false,
        },
      ],
      _warnings: [],
    }),
  });
const xvibe_semantic_non_edit_planning_typed_object_res =
  await xvibe_semantic_non_edit_planning_typed_object_engine.analyze({
    _message: "plan the next change semantically",
    _runtime_context: {
      _app_id: "intent-test-app",
      _env: "test",
    },
  });
assert.equal(xvibe_semantic_non_edit_planning_typed_object_res._ok, true);
assert.deepEqual(
  xvibe_semantic_non_edit_planning_typed_object_res._intent,
  XVIBE_INTENT_STUB_CONVERSATION_RESULT,
);

const xvibe_semantic_default_generate_commands: any[] = [];
const original_semantic_default_execute = (_x as any).execute;
try {
  (_x as any).execute = async (command: any) => {
    if (command?._module === "xai" && command?._op === "generate") {
      xvibe_semantic_default_generate_commands.push(command);
      return {
        _ok: true,
        _text: JSON.stringify(XVIBE_SEMANTIC_VALID_INTENT),
      };
    }

    return original_semantic_default_execute.call(_x, command);
  };

  const xvibe_semantic_default_processor =
    new SemanticIntentProcessor();
  const xvibe_semantic_default_res =
    await xvibe_semantic_default_processor.analyze({
      _message: "what can you do through default xai generate?",
      _conversation_id: "conversation-semantic-default",
      _runtime_context: {
        _app_id: "intent-test-app",
        _env: "test",
        _conversation_id: "conversation-semantic-default",
      },
    });
  assert.deepEqual(
    xvibe_semantic_default_res,
    XVIBE_SEMANTIC_VALID_INTENT,
  );
} finally {
  (_x as any).execute = original_semantic_default_execute;
}
const xvibe_semantic_default_generate_command =
  xvibe_semantic_default_generate_commands[0];
if (!xvibe_semantic_default_generate_command) {
  throw new Error("semantic default xai.generate command was not captured");
}
assert.equal(
  xvibe_semantic_default_generate_command._module,
  "xai",
);
assert.equal(
  xvibe_semantic_default_generate_command._op,
  "generate",
);
assert.equal(
  xvibe_semantic_default_generate_command._params._task,
  "semantic-routing",
);
assert.notEqual(
  xvibe_semantic_default_generate_command._params._task,
  "chat",
);
assert.equal(
  xvibe_semantic_default_generate_command._params._capability,
  "semantic-routing",
);
assert.deepEqual(
  xvibe_semantic_default_generate_command._params.response_format,
  {
    type: "json_object",
  },
);
assert.equal(
  xvibe_semantic_default_generate_command._params._provider,
  "mock-semantic-provider",
);

set_xvibe_semantic_intent_env("true");
const xvibe_semantic_invalid_engine = xvibe_test_intent_engine({
  _semantic_generate_json: async () => ({
    _message_type: "conversation",
    _execution_level: "model",
    _should_mutate: false,
    _confidence: "high",
    _actions: [],
  }),
});
const xvibe_semantic_invalid_res =
  await xvibe_semantic_invalid_engine.analyze({
    _message: "what can you do?",
    _runtime_context: {
      _app_id: "intent-test-app",
      _env: "test",
    },
  });
assert.equal(xvibe_semantic_invalid_res._ok, true);
assert.deepEqual(
  xvibe_semantic_invalid_res._intent,
  XVIBE_INTENT_STUB_CONVERSATION_RESULT,
);

set_xvibe_semantic_intent_env("true");
const xvibe_semantic_unknown_alias_engine = xvibe_test_intent_engine({
  _semantic_generate_json: async () => ({
    _message_type: "unclear-intent-kind",
    _execution_level: "model",
    _should_mutate: false,
    _confidence: 0.62,
    _actions: [
      {
        _id: "semantic-unknown-alias",
        _title: "Unknown",
        _action_type: "reply",
        _status: "suggested",
      },
    ],
  }),
});
const xvibe_semantic_unknown_alias_res =
  await xvibe_semantic_unknown_alias_engine.analyze({
    _message: "what can you do?",
    _runtime_context: {
      _app_id: "intent-test-app",
      _env: "test",
    },
  });
assert.equal(xvibe_semantic_unknown_alias_res._ok, true);
assert.deepEqual(
  xvibe_semantic_unknown_alias_res._intent,
  XVIBE_INTENT_STUB_CONVERSATION_RESULT,
);

set_xvibe_semantic_intent_env("true");
let xvibe_semantic_action_execute_count = 0;
const original_semantic_action_execute = (_x as any).execute;
try {
  (_x as any).execute = async (command: any) => {
    if (
      command?._module === "xvibe" &&
      (
        command?._op === "apply-view-edit" ||
        command?._op === "generate"
      )
    ) {
      xvibe_semantic_action_execute_count += 1;
    }

    return original_semantic_action_execute.call(_x, command);
  };

  const xvibe_semantic_action_engine = xvibe_test_intent_engine({
    _semantic_generate_json: async () => ({
      _message_type: "edit",
      _execution_level: "model",
      _should_mutate: true,
      _confidence: 0.76,
      _reason: "mock_semantic_action_intent",
      _actions: [
        {
          _id: "semantic-apply-view-edit",
          _title: "Apply edit",
          _action_type: "apply-view-edit",
          _status: "suggested",
          _requires_approval: true,
          _params: {
            _view_id: "view-main",
            _target_id: "button-json-1",
            _edit_action: "hide-object",
          },
        },
      ],
      _warnings: [],
    }),
  });
  const xvibe_semantic_action_res =
    await xvibe_semantic_action_engine.analyze({
      _message: "hide the selected button semantically",
      _runtime_context: {
        _app_id: "intent-test-app",
        _env: "test",
      },
    });
  assert.equal(xvibe_semantic_action_res._ok, true);
  assert.equal(
    xvibe_semantic_action_res._intent?._actions[0]._action_type,
    "apply-view-edit",
  );
  assert.equal(xvibe_semantic_action_execute_count, 0);
} finally {
  (_x as any).execute = original_semantic_action_execute;
  set_xvibe_semantic_intent_env(undefined);
}

const xvibe_intent_invalid_message_res = await xvibe_intent_engine.analyze({
  _message: 42,
  _runtime_context: {
    _app_id: "intent-test-app",
    _env: "test",
  },
} as any);
assert.equal(xvibe_intent_invalid_message_res._ok, false);
assert.equal(xvibe_intent_invalid_message_res._error, "invalid_intent_request");
assert.equal(xvibe_intent_invalid_message_res._reason, "_message must be string");

const xvibe_intent_missing_app_res = await xvibe_intent_engine.analyze({
  _message: "hello",
  _runtime_context: {
    _env: "test",
  },
} as any);
assert.equal(xvibe_intent_missing_app_res._ok, false);
assert.equal(xvibe_intent_missing_app_res._error, "invalid_intent_request");
assert.equal(xvibe_intent_missing_app_res._reason, "_runtime_context._app_id required");

const xvibe_intent_missing_env_res = await xvibe_intent_engine.analyze({
  _message: "hello",
  _runtime_context: {
    _app_id: "intent-test-app",
  },
} as any);
assert.equal(xvibe_intent_missing_env_res._ok, false);
assert.equal(xvibe_intent_missing_env_res._error, "invalid_intent_request");
assert.equal(xvibe_intent_missing_env_res._reason, "_runtime_context._env required");

await _x.loadModuleAsync(new XAuthModule());

const xauth_safe_claims_create_res = await _x.execute({
  _module: "xauth",
  _op: "create-jwt",
  _params: {
    _user_id: "user-claims",
    _account_id: "account-claims",
    _email: "aime@example.com",
    _role: "admin",
    _roles: ["admin", "operator"],
    _password: "must-not-appear",
    _secret: "must-not-appear",
    _token: "must-not-appear",
    _unknown: "must-not-appear"
  }
});

assert.equal(xauth_safe_claims_create_res._ok, true);
assert.equal(typeof xauth_safe_claims_create_res._token, "string");

const xauth_safe_claims_payload = decode_jwt_payload_for_test(xauth_safe_claims_create_res._token);
assert.equal(xauth_safe_claims_payload._email, "aime@example.com");
assert.equal(xauth_safe_claims_payload._role, "admin");
assert.deepEqual(xauth_safe_claims_payload._roles, ["admin", "operator"]);
assert.equal("_password" in xauth_safe_claims_payload, false);
assert.equal("_secret" in xauth_safe_claims_payload, false);
assert.equal("_token" in xauth_safe_claims_payload, false);
assert.equal("_unknown" in xauth_safe_claims_payload, false);

const xauth_safe_claims_verify_res = await _x.execute({
  _module: "xauth",
  _op: "verify-jwt",
  _params: {
    _token: xauth_safe_claims_create_res._token
  }
});

assert.equal(xauth_safe_claims_verify_res._ok, true);
assert.equal(xauth_safe_claims_verify_res._valid, true);
assert.equal(xauth_safe_claims_verify_res._auth._email, "aime@example.com");
assert.equal(xauth_safe_claims_verify_res._auth._role, "admin");
assert.deepEqual(xauth_safe_claims_verify_res._auth._roles, ["admin", "operator"]);
assert.equal("_password" in xauth_safe_claims_verify_res._auth, false);
assert.equal("_secret" in xauth_safe_claims_verify_res._auth, false);
assert.equal("_token" in xauth_safe_claims_verify_res._auth, false);
assert.equal("_unknown" in xauth_safe_claims_verify_res._auth, false);

const settings_path_work_folder = await mkdtemp(path.join(tmpdir(), "xsettings-path-"));
const settings_path_settings = new _XSettings();
try {
  settings_path_settings.onSetup(settings_path_work_folder);
  settings_path_settings.setPath("xai.providers.aime.api_key", "abc");
  settings_path_settings.setPath("xai.providers.aime.endpoint", "https://aime.test");
  settings_path_settings.setPath("xai.providers.aime.enabled", false);
  settings_path_settings.setPath("xai.providers.aime.retries", 0);
  settings_path_settings.setPath("xai.providers.aime.label", "");
  settings_path_settings.setPath("xai.providers.aime.meta", null);

  assert.equal(settings_path_settings.getPath("xai.providers.aime.api_key"), "abc");
  assert.equal(settings_path_settings.getPath("xai.providers.aime.missing", "fallback"), "fallback");
  assert.equal(settings_path_settings.hasPath("xai.providers.aime.api_key"), true);
  assert.equal(settings_path_settings.hasPath("xai.providers.aime.enabled"), true);
  assert.equal(settings_path_settings.hasPath("xai.providers.aime.retries"), true);
  assert.equal(settings_path_settings.hasPath("xai.providers.aime.label"), true);
  assert.equal(settings_path_settings.hasPath("xai.providers.aime.meta"), true);
  assert.equal(settings_path_settings.hasPath("xai.providers.aime.missing"), false);

  settings_path_settings.ensurePath("xai.default_provider", "aime");
  settings_path_settings.ensurePath("xai.default_provider", "other");

  const settings_path_file = JSON.parse(
    await readFile(
      path.join(settings_path_work_folder, "settings", "server-settings.json"),
      "utf-8",
    ),
  );

  assert.deepEqual(settings_path_file.xai, {
    providers: {
      aime: {
        api_key: "abc",
        endpoint: "https://aime.test",
        enabled: false,
        retries: 0,
        label: "",
        meta: null,
      },
    },
    default_provider: "aime",
  });
} finally {
  settings_path_settings.close();
  await rm(settings_path_work_folder, { recursive: true, force: true });
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

const remove_logout_button_prompt = 'remove button "logout" from view main';
const remove_logout_button_intent =
  artifact_intent_planner.infer_artifact_intent(remove_logout_button_prompt);
assert.equal(remove_logout_button_intent._action, "update");
assert.equal(remove_logout_button_intent._target, "view");
assert.equal(remove_logout_button_intent._target_id, "main");
const remove_logout_button_plan =
  artifact_intent_planner.build_artifact_plan_from_intent(
    remove_logout_button_prompt,
    remove_logout_button_intent,
  );
assert.deepEqual(remove_logout_button_plan._execution_plan, {
  _primary_artifact_type: "view",
  _artifacts: [
    {
      _artifact_type: "view",
      _action: "update",
      _artifact_id: "main",
    },
  ],
});

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

const resolved_new_view_task = resolve_xvibe_task({
  _prompt: "Create new view ai-key with title Xpell AI Key",
});
assert.equal(resolved_new_view_task._artifact_type, "view");
assert.equal(resolved_new_view_task._action, "create");
assert.equal(resolved_new_view_task._target_id, "ai-key");
assert.equal(resolved_new_view_task._explicit_target_id, true);
assert.deepEqual(resolved_new_view_task._module_ops, []);

const resolved_app_with_view_task = resolve_xvibe_task({
  _prompt: "Build app with view and one label hello world",
});
assert.notEqual(resolved_app_with_view_task._target_id, "and");

const resolved_update_main_view_task = resolve_xvibe_task({
  _prompt: "Update main view change label text A to B",
});
assert.equal(resolved_update_main_view_task._artifact_type, "view");
assert.equal(resolved_update_main_view_task._action, "update");
assert.equal(resolved_update_main_view_task._target_id, "main");

const resolved_server_module_task = resolve_xvibe_task({
  _prompt: "Create server module aime-auth",
});
assert.equal(resolved_server_module_task._artifact_type, "module");
assert.equal(resolved_server_module_task._action, "create");
assert.equal(resolved_server_module_task._module_name, "aime-auth");
assert.deepEqual(resolved_server_module_task._module_ops, []);
assert.ok(resolved_server_module_task._warnings.includes("missing_explicit_module_ops"));

const resolved_server_module_with_op_task = resolve_xvibe_task({
  _prompt: "Create module aime-auth with _login",
});
assert.equal(resolved_server_module_with_op_task._artifact_type, "module");
assert.equal(resolved_server_module_with_op_task._action, "create");
assert.equal(resolved_server_module_with_op_task._module_name, "aime-auth");
assert.deepEqual(resolved_server_module_with_op_task._module_ops, ["login"]);

const resolved_calc_module_task = resolve_xvibe_task({
  _prompt: "Create server module calc with operation evaluate",
});
assert.equal(resolved_calc_module_task._artifact_type, "module");
assert.equal(resolved_calc_module_task._module_name, "calc");
assert.deepEqual(resolved_calc_module_task._module_ops, ["evaluate"]);

const phase3_intent_planner = new VibeIntentPlanner();
const phase3_capabilities = phase3_intent_planner.empty_runtime_capabilities();
const phase3_view_app_plan = { _artifact_types: ["view"] };

const phase3_new_view_plan = phase3_intent_planner.infer_intent_plan(
  "Create new view ai-key with title Xpell AI Key",
  phase3_view_app_plan,
  phase3_capabilities,
);
assert.deepEqual(phase3_new_view_plan._artifact_types, ["view"]);
assert.deepEqual(phase3_new_view_plan._entities, []);
assert.deepEqual(phase3_new_view_plan._modules, []);
assert.deepEqual(phase3_new_view_plan._flow_keywords, []);
assert.equal(phase3_new_view_plan._requires_module, false);

const phase3_update_view_prompt =
  "Update main view change label text Powered by Aime Technologies to By Aime Technologies";
const phase3_update_view_plan = phase3_intent_planner.infer_intent_plan(
  phase3_update_view_prompt,
  phase3_view_app_plan,
  phase3_capabilities,
);
const phase3_update_behavior = new VibeBehaviorPlanner().infer_behavior_intent({
  _prompt: phase3_update_view_prompt,
  _artifact_type: "view",
  _intent_plan: phase3_update_view_plan,
});
assert.deepEqual(phase3_update_view_plan._entities, []);
assert.deepEqual(phase3_update_view_plan._crud_ops, []);
assert.equal(phase3_update_behavior._crud_intent, undefined);
assert.equal(phase3_update_behavior._crud, undefined);
assert.deepEqual(phase3_update_behavior._entity_targets, []);

const phase3_dashboard_plan = phase3_intent_planner.infer_intent_plan(
  "Create dashboard with table and button",
  phase3_view_app_plan,
  phase3_capabilities,
);
assert.deepEqual(phase3_dashboard_plan._artifact_types, ["view"]);
assert.deepEqual(phase3_dashboard_plan._entities, []);
assert.ok(phase3_dashboard_plan._xui_objects.includes("table"));
assert.ok(phase3_dashboard_plan._xui_objects.includes("button"));

const phase3_users_table_plan = phase3_intent_planner.infer_intent_plan(
  "Create dashboard with users table",
  phase3_view_app_plan,
  phase3_capabilities,
);
assert.deepEqual(phase3_users_table_plan._artifact_types, ["view"]);
assert.deepEqual(phase3_users_table_plan._entities, []);

const phase3_user_entity_plan = phase3_intent_planner.infer_intent_plan(
  "Create dashboard with user entity",
  phase3_view_app_plan,
  phase3_capabilities,
);
assert.ok(phase3_user_entity_plan._artifact_types.includes("entity"));
assert.deepEqual(phase3_user_entity_plan._entities.map((entity) => entity._id), ["users"]);

const phase3_view_with_flow_plan = infer_xvibe_artifact_plan(
  "Create view with login flow",
);
assert.equal(phase3_view_with_flow_plan._primary_artifact_type, "view");
assert.ok(phase3_view_with_flow_plan._artifact_types.includes("flow"));
assert.deepEqual(phase3_view_with_flow_plan._flow_ids, ["login"]);

const phase3_view_with_button_plan = infer_xvibe_artifact_plan(
  "Create view with login button",
);
assert.equal(phase3_view_with_button_plan._primary_artifact_type, "view");
assert.equal(phase3_view_with_button_plan._artifact_types.includes("flow"), false);

const phase4_runtime_skills = {
  _modules: [
    {
      _id: "xui",
      _name: "xui",
      _objects: [
        { _id: "view" },
        { _id: "label" },
        { _id: "stack" },
        { _id: "card" },
        { _id: "grid" },
        { _id: "table" },
      ],
    },
    {
      _id: "entity-client",
      _name: "entity-client",
      _ops: ["find", "add", "update", "delete"],
    },
    {
      _id: "flow-client",
      _name: "flow-client",
      _ops: ["trigger"],
    },
  ],
};
const phase4_runtime_capabilities =
  phase3_intent_planner.extract_runtime_capabilities(phase4_runtime_skills);
const phase4_simple_label_plan = phase3_intent_planner.infer_intent_plan(
  "create simple view with label hello",
  phase3_view_app_plan,
  phase4_runtime_capabilities,
);
assert.deepEqual(phase4_simple_label_plan._artifact_types, ["view"]);
assert.deepEqual(phase4_simple_label_plan._entities, []);
assert.deepEqual(phase4_simple_label_plan._modules, []);
assert.deepEqual(phase4_simple_label_plan._flow_keywords, []);
assert.ok(phase4_simple_label_plan._xui_objects.includes("label"));
assert.equal(phase4_simple_label_plan._xui_objects.includes("stack"), false);
assert.equal(phase4_simple_label_plan._xui_objects.includes("card"), false);
assert.equal(phase4_simple_label_plan._xui_objects.includes("grid"), false);

const phase4_new_view_plan = phase3_intent_planner.infer_intent_plan(
  "create new view ai-key with title Xpell AI Key",
  phase3_view_app_plan,
  phase4_runtime_capabilities,
);
assert.deepEqual(phase4_new_view_plan._modules, []);
assert.deepEqual(phase4_new_view_plan._actions, []);

const phase4_card_table_plan = phase3_intent_planner.infer_intent_plan(
  "create dashboard with card and table",
  phase3_view_app_plan,
  phase4_runtime_capabilities,
);
assert.deepEqual(phase4_card_table_plan._artifact_types, ["view"]);
assert.deepEqual(phase4_card_table_plan._entities, []);
assert.ok(phase4_card_table_plan._xui_objects.includes("card"));
assert.ok(phase4_card_table_plan._xui_objects.includes("table"));

const phase4_users_table_plan = phase3_intent_planner.infer_intent_plan(
  "create dashboard with users table",
  phase3_view_app_plan,
  phase4_runtime_capabilities,
);
assert.deepEqual(phase4_users_table_plan._artifact_types, ["view"]);
assert.deepEqual(phase4_users_table_plan._entities, []);
assert.equal(phase4_users_table_plan._modules.includes("entity-client"), false);

const phase4_runtime_plan =
  build_xvibe_runtime_plan({
    _runtime_assets: {
      _views: [],
      _flows: [],
      _entities: [],
      _modules: [],
    },
    _runtime_skills: phase4_runtime_skills,
    _resolved_task: resolve_xvibe_task({
      _prompt: "create simple view with label hello",
    }),
    _intent_plan: phase4_simple_label_plan,
  });
assert.ok(phase4_runtime_plan._allowed_xui_types.includes("label"));
assert.ok(phase4_runtime_plan._allowed_modules.includes("entity-client"));
assert.deepEqual(phase4_runtime_plan._allowed_ops["entity-client"], ["add", "delete", "find", "update"]);

const phase4_prompt_builder = new VibePromptBuilder();
const phase4_label_prompt = phase4_prompt_builder.build({
  prompt: "create simple view with label hello",
  _mode: "full",
  _artifact_type: "view",
  selection: {
    skill_ids: [],
    skills: [],
    diagnostics: [],
  },
  runtime_context: {
    _runtime_plan: phase4_runtime_plan,
    _selected_xui_objects: phase4_simple_label_plan._xui_objects,
  },
});
assert.ok(phase4_label_prompt.includes("- label"));
assert.equal(phase4_label_prompt.includes("- stack"), false);
assert.equal(phase4_label_prompt.includes("- card"), false);
assert.equal(phase4_label_prompt.includes("- grid"), false);
assert.equal(phase4_label_prompt.includes("Prefer stack"), false);

const phase4_unsupported_stack_runtime_plan =
  build_xvibe_runtime_plan({
    _runtime_assets: {
      _views: [],
      _flows: [],
      _entities: [],
      _modules: [],
    },
    _runtime_skills: {
      _modules: [
        {
          _id: "xui",
          _name: "xui",
          _objects: [
            { _id: "view" },
            { _id: "label" },
          ],
        },
      ],
    },
    _resolved_task: resolve_xvibe_task({
      _prompt: "create view with unsupported stack",
    }),
  });
const phase4_unsupported_stack_prompt = phase4_prompt_builder.build({
  prompt: "create view with unsupported stack",
  _mode: "full",
  _artifact_type: "view",
  selection: {
    skill_ids: [],
    skills: [],
    diagnostics: [],
  },
  runtime_context: {
    _runtime_plan: phase4_unsupported_stack_runtime_plan,
    _selected_xui_objects: ["view", "stack"],
  },
});
assert.equal(phase4_unsupported_stack_prompt.includes("- stack"), false);
assert.equal(phase4_unsupported_stack_prompt.includes("Prefer stack"), false);
const phase4_unsupported_stack_skill_prompt = phase4_prompt_builder.build({
  prompt: "create view with unsupported stack",
  _mode: "full",
  _artifact_type: "view",
  selection: {
    skill_ids: ["mixed-xui-rules"],
    skills: [
      {
        _id: "mixed-xui-rules",
        _title: "Mixed XUI rules",
        _version: "1.0.0",
        _type: "xui-object",
        _priority_rules: [
          "Prefer stack for layout.",
          "Use label with _text.",
        ],
      } as any,
    ],
    diagnostics: [],
  },
  runtime_context: {
    _runtime_plan: phase4_unsupported_stack_runtime_plan,
    _selected_xui_objects: ["view", "label"],
  },
});
assert.equal(phase4_unsupported_stack_skill_prompt.includes("Prefer stack for layout"), false);
assert.ok(phase4_unsupported_stack_skill_prompt.includes("Use label with _text"));

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
assert.equal(infer_xvibe_artifact_action_plan('remove button "logout" from view main'), undefined);
assert.equal(infer_xvibe_artifact_action_plan("delete play-button"), undefined);
const remove_button_resolved_task = resolve_xvibe_task({
  _prompt: 'remove button "logout" from view main',
});
assert.equal(remove_button_resolved_task._artifact_type, "view");
assert.equal(remove_button_resolved_task._action, "update");
assert.equal(remove_button_resolved_task._target_id, "main");
assert.equal(remove_button_resolved_task._edit_action, "remove");
assert.equal(remove_button_resolved_task._edit_target_text, "logout");
const remove_pause_button_by_id_resolved_task = resolve_xvibe_task({
  _prompt: "remove pause-button from view main",
});
assert.equal(remove_pause_button_by_id_resolved_task._artifact_type, "view");
assert.equal(remove_pause_button_by_id_resolved_task._action, "update");
assert.equal(remove_pause_button_by_id_resolved_task._target_id, "main");
assert.equal(remove_pause_button_by_id_resolved_task._edit_action, "remove");
assert.equal(remove_pause_button_by_id_resolved_task._edit_target_id, "pause-button");
const delete_pause_button_by_text_resolved_task = resolve_xvibe_task({
  _prompt: "delete Pause button from view main",
});
assert.equal(delete_pause_button_by_text_resolved_task._artifact_type, "view");
assert.equal(delete_pause_button_by_text_resolved_task._action, "update");
assert.equal(delete_pause_button_by_text_resolved_task._target_id, "main");
assert.equal(delete_pause_button_by_text_resolved_task._edit_action, "remove");
assert.equal(delete_pause_button_by_text_resolved_task._edit_target_text, "Pause");
assert.equal(delete_pause_button_by_text_resolved_task._edit_target_type, "button");
const view_child_id_target_cases = [
  {
    _prompt: "Update main view only. Remove button id button-1. Do not modify anything else.",
    _edit_action: "remove",
    _edit_target_id: "button-1",
    _edit_target_type: "button",
  },
  {
    _prompt: "Update main view only. Delete button id button-1. Do not modify anything else.",
    _edit_action: "remove",
    _edit_target_id: "button-1",
    _edit_target_type: "button",
  },
  {
    _prompt: "Update main view only. Hide button id button-1. Do not modify anything else.",
    _edit_action: "hide",
    _edit_target_id: "button-1",
    _edit_target_type: "button",
  },
  {
    _prompt: "Update main view only. Show button id button-1. Do not modify anything else.",
    _edit_action: "show",
    _edit_target_id: "button-1",
    _edit_target_type: "button",
  },
  {
    _prompt: "Update main view only. Remove label id label-1. Do not modify anything else.",
    _edit_action: "remove",
    _edit_target_id: "label-1",
    _edit_target_type: "label",
  },
  {
    _prompt: "Update main view only. Remove object id object-1. Do not modify anything else.",
    _edit_action: "remove",
    _edit_target_id: "object-1",
    _edit_target_type: "object",
  },
] as const;
for (const view_child_id_target_case of view_child_id_target_cases) {
  const resolved_task = resolve_xvibe_task({
    _prompt: view_child_id_target_case._prompt,
  });
  assert.equal(resolved_task._artifact_type, "view");
  assert.equal(resolved_task._action, "update");
  assert.equal(resolved_task._target_id, "main");
  assert.equal(resolved_task._edit_action, view_child_id_target_case._edit_action);
  assert.equal(resolved_task._edit_target_id, view_child_id_target_case._edit_target_id);
  assert.equal(resolved_task._edit_target_type, view_child_id_target_case._edit_target_type);
  assert.equal(resolved_task._edit_target_text, undefined);
}
const remove_pause_button_view = {
  _id: "main",
  _type: "view",
  _children: [
    {
      _id: "play-button",
      _type: "button",
      _text: "Play",
    },
    {
      _id: "pause-button",
      _type: "button",
      _text: "Pause",
    },
    {
      _id: "next-button",
      _type: "button",
      _text: "Next",
    },
  ],
};
assert.deepEqual(
  can_apply_deterministic_view_edit({
    _resolved_task: remove_pause_button_by_id_resolved_task,
    _current_view: remove_pause_button_view,
  }),
  {
    _eligible: true,
    _action: "remove-object",
    _target_id: "pause-button",
    _reason: "eligible",
    _details: {
      _resolved_by: "id",
    },
  },
);
assert.deepEqual(
  can_apply_deterministic_view_edit({
    _resolved_task: {
      ...remove_pause_button_by_id_resolved_task,
      _edit_target_id: undefined,
      _edit_target_text: "button id",
    },
    _current_view: remove_pause_button_view,
    _edit_intent: {
      _action: "remove",
      _target_id: "pause-button",
    },
  }),
  {
    _eligible: true,
    _action: "remove-object",
    _target_id: "pause-button",
    _reason: "eligible",
    _details: {
      _resolved_by: "id",
    },
  },
);
const remove_pause_button_by_id_result =
  apply_deterministic_view_edit({
    _resolved_task: remove_pause_button_by_id_resolved_task,
    _current_view: remove_pause_button_view,
  });
assert.equal(remove_pause_button_by_id_result._ok, true);
assert.deepEqual(
  (remove_pause_button_by_id_result._view as any)._children.map((child: any) => child._id),
  ["play-button", "next-button"],
);
assert.deepEqual(
  remove_pause_button_view._children.map((child) => child._id),
  ["play-button", "pause-button", "next-button"],
);
assert.deepEqual(
  remove_pause_button_by_id_result._mutation,
  {
    _type: "deterministic-view-edit",
    _action: "remove-object",
    _target_id: "pause-button",
    _resolved_by: "id",
    _parent_id: "main",
    _removed_type: "button",
    _removed_text: "Pause",
  },
);
assert.deepEqual(
  can_apply_deterministic_view_edit({
    _resolved_task: delete_pause_button_by_text_resolved_task,
    _current_view: remove_pause_button_view,
  }),
  {
    _eligible: true,
    _action: "remove-object",
    _target_id: "pause-button",
    _reason: "eligible_text_match",
    _details: {
      _resolved_by: "text",
    },
  },
);
const remove_pause_button_by_text_result =
  apply_deterministic_view_edit({
    _resolved_task: delete_pause_button_by_text_resolved_task,
    _current_view: remove_pause_button_view,
  });
assert.equal(remove_pause_button_by_text_result._ok, true);
assert.deepEqual(
  (remove_pause_button_by_text_result._view as any)._children.map((child: any) => child._id),
  ["play-button", "next-button"],
);
assert.equal(remove_pause_button_by_text_result._mutation?._resolved_by, "text");
assert.equal(
  can_apply_deterministic_view_edit({
    _resolved_task: {
      ...remove_pause_button_by_id_resolved_task,
      _edit_target_id: "main",
    },
    _current_view: remove_pause_button_view,
  })._reason,
  "target_is_root",
);
assert.equal(
  apply_deterministic_view_edit({
    _resolved_task: {
      ...remove_pause_button_by_id_resolved_task,
      _edit_target_id: "main",
    },
    _current_view: remove_pause_button_view,
  })._reason,
  "target_is_root",
);
assert.equal(
  can_apply_deterministic_view_edit({
    _resolved_task: delete_pause_button_by_text_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "pause-button-1",
          _type: "button",
          _text: "Pause",
        },
        {
          _id: "pause-button-2",
          _type: "button",
          _text: "Pause",
        },
      ],
    },
  })._reason,
  "ambiguous_text_target",
);
assert.equal(
  apply_deterministic_view_edit({
    _resolved_task: delete_pause_button_by_text_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "pause-button-1",
          _type: "button",
          _text: "Pause",
        },
        {
          _id: "pause-button-2",
          _type: "button",
          _text: "Pause",
        },
      ],
    },
  })._reason,
  "ambiguous_text_target",
);
const hide_pause_button_by_id_resolved_task = resolve_xvibe_task({
  _prompt: "hide pause-button from view main",
});
assert.equal(hide_pause_button_by_id_resolved_task._artifact_type, "view");
assert.equal(hide_pause_button_by_id_resolved_task._action, "update");
assert.equal(hide_pause_button_by_id_resolved_task._target_id, "main");
assert.equal(hide_pause_button_by_id_resolved_task._edit_action, "hide");
assert.equal(hide_pause_button_by_id_resolved_task._edit_target_id, "pause-button");
const hide_pause_button_by_text_resolved_task = resolve_xvibe_task({
  _prompt: "hide Pause button from view main",
});
assert.equal(hide_pause_button_by_text_resolved_task._artifact_type, "view");
assert.equal(hide_pause_button_by_text_resolved_task._action, "update");
assert.equal(hide_pause_button_by_text_resolved_task._target_id, "main");
assert.equal(hide_pause_button_by_text_resolved_task._edit_action, "hide");
assert.equal(hide_pause_button_by_text_resolved_task._edit_target_text, "Pause");
assert.equal(hide_pause_button_by_text_resolved_task._edit_target_type, "button");
const hide_quoted_pause_button_resolved_task = resolve_xvibe_task({
  _prompt: 'Update main view only. Hide "Pause" button from view main. Do not modify anything else.',
});
assert.equal(hide_quoted_pause_button_resolved_task._artifact_type, "view");
assert.equal(hide_quoted_pause_button_resolved_task._action, "update");
assert.equal(hide_quoted_pause_button_resolved_task._target_id, "main");
assert.equal(hide_quoted_pause_button_resolved_task._edit_action, "hide");
assert.equal(hide_quoted_pause_button_resolved_task._edit_target_text, "Pause");
assert.equal(hide_quoted_pause_button_resolved_task._edit_target_type, "button");
const make_pause_button_hidden_resolved_task = resolve_xvibe_task({
  _prompt: "make Pause button hidden",
});
assert.equal(make_pause_button_hidden_resolved_task._artifact_type, "view");
assert.equal(make_pause_button_hidden_resolved_task._action, "update");
assert.equal(make_pause_button_hidden_resolved_task._edit_action, "hide");
assert.equal(make_pause_button_hidden_resolved_task._edit_target_text, "Pause");
assert.equal(make_pause_button_hidden_resolved_task._edit_target_type, "button");
const hide_powered_label_resolved_task = resolve_xvibe_task({
  _prompt: 'hide label "Powered by Xpell"',
});
assert.equal(hide_powered_label_resolved_task._artifact_type, "view");
assert.equal(hide_powered_label_resolved_task._action, "update");
assert.equal(hide_powered_label_resolved_task._edit_action, "hide");
assert.equal(hide_powered_label_resolved_task._edit_target_text, "Powered by Xpell");
assert.equal(hide_powered_label_resolved_task._edit_target_type, "label");
assert.deepEqual(
  can_apply_deterministic_view_edit({
    _resolved_task: hide_pause_button_by_id_resolved_task,
    _current_view: remove_pause_button_view,
  }),
  {
    _eligible: true,
    _action: "hide-object",
    _target_id: "pause-button",
    _reason: "eligible",
    _details: {
      _resolved_by: "id",
    },
  },
);
const hide_pause_button_by_id_result =
  apply_deterministic_view_edit({
    _resolved_task: hide_pause_button_by_id_resolved_task,
    _current_view: remove_pause_button_view,
  });
assert.equal(hide_pause_button_by_id_result._ok, true);
assert.deepEqual(
  (hide_pause_button_by_id_result._view as any)._children.map((child: any) => child._id),
  ["play-button", "pause-button", "next-button"],
);
assert.equal(test_style_has_display_none((hide_pause_button_by_id_result._view as any)._children[1].style), true);
assert.equal((hide_pause_button_by_id_result._view as any)._children[1]._visible, false);
assert.equal((hide_pause_button_by_id_result._view as any)._children[1]._hidden, undefined);
assert.equal((remove_pause_button_view._children[1] as any)._hidden, undefined);
assert.equal((remove_pause_button_view._children[1] as any).style, undefined);
assert.equal((remove_pause_button_view._children[1] as any)._visible, undefined);
const hide_pause_button_saved_loaded_view =
  JSON.parse(JSON.stringify(hide_pause_button_by_id_result._view));
assert.equal(test_style_has_display_none(hide_pause_button_saved_loaded_view._children[1].style), true);
assert.equal(hide_pause_button_saved_loaded_view._children[1]._visible, false);
assert.equal(xui_render_path_node_is_visible(hide_pause_button_saved_loaded_view._children[1]), false);
assert.deepEqual(
  hide_pause_button_by_id_result._mutation,
  {
    _type: "deterministic-view-edit",
    _action: "hide-object",
    _target_id: "pause-button",
    _resolved_by: "id",
    _parent_id: "main",
    _hide_mechanism: "style.display:none",
  },
);
assert.deepEqual(
  can_apply_deterministic_view_edit({
    _resolved_task: hide_pause_button_by_text_resolved_task,
    _current_view: remove_pause_button_view,
  }),
  {
    _eligible: true,
    _action: "hide-object",
    _target_id: "pause-button",
    _reason: "eligible_text_match",
    _details: {
      _resolved_by: "text",
    },
  },
);
const hide_pause_button_by_text_result =
  apply_deterministic_view_edit({
    _resolved_task: hide_pause_button_by_text_resolved_task,
    _current_view: remove_pause_button_view,
  });
assert.equal(hide_pause_button_by_text_result._ok, true);
assert.equal(test_style_has_display_none((hide_pause_button_by_text_result._view as any)._children[1].style), true);
assert.equal((hide_pause_button_by_text_result._view as any)._children[1]._visible, false);
assert.equal(hide_pause_button_by_text_result._mutation?._resolved_by, "text");
assert.equal(
  can_apply_deterministic_view_edit({
    _resolved_task: {
      ...hide_pause_button_by_id_resolved_task,
      _edit_target_id: "main",
    },
    _current_view: remove_pause_button_view,
  })._reason,
  "target_is_root",
);
assert.equal(
  can_apply_deterministic_view_edit({
    _resolved_task: hide_pause_button_by_text_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "pause-button-1",
          _type: "button",
          _text: "Pause",
        },
        {
          _id: "pause-button-2",
          _type: "button",
          _text: "Pause",
        },
      ],
    },
  })._reason,
  "ambiguous_text_target",
);
const icon_prefixed_pause_button_view = {
  _id: "main",
  _type: "view",
  _children: [
    {
      _id: "pause-button",
      _type: "button",
      _text: "⏸ Pause",
    },
  ],
};
assert.deepEqual(
  can_apply_deterministic_view_edit({
    _resolved_task: hide_quoted_pause_button_resolved_task,
    _current_view: icon_prefixed_pause_button_view,
  }),
  {
    _eligible: true,
    _action: "hide-object",
    _target_id: "pause-button",
    _reason: "eligible_normalized_text_match",
    _details: {
      _resolved_by: "normalized_text",
    },
  },
);
const hide_icon_prefixed_pause_result =
  apply_deterministic_view_edit({
    _resolved_task: hide_quoted_pause_button_resolved_task,
    _current_view: icon_prefixed_pause_button_view,
  });
assert.equal(hide_icon_prefixed_pause_result._ok, true);
assert.equal(test_style_has_display_none((hide_icon_prefixed_pause_result._view as any)._children[0].style), true);
assert.equal((hide_icon_prefixed_pause_result._view as any)._children[0]._visible, false);
assert.equal(hide_icon_prefixed_pause_result._mutation?._resolved_by, "normalized_text");
const remove_icon_prefixed_pause_result =
  apply_deterministic_view_edit({
    _resolved_task: delete_pause_button_by_text_resolved_task,
    _current_view: icon_prefixed_pause_button_view,
  });
assert.equal(remove_icon_prefixed_pause_result._ok, true);
assert.deepEqual((remove_icon_prefixed_pause_result._view as any)._children, []);
assert.equal(remove_icon_prefixed_pause_result._mutation?._resolved_by, "normalized_text");
assert.equal(
  can_apply_deterministic_view_edit({
    _resolved_task: hide_quoted_pause_button_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "pause-button-icon",
          _type: "button",
          _text: "⏸ Pause",
        },
        {
          _id: "pause-button",
          _type: "button",
          _text: "Pause",
        },
      ],
    },
  })._reason,
  "ambiguous_normalized_text_target",
);
const hide_admin_button_by_text_type_resolved_task = resolve_xvibe_task({
  _prompt: "hide Admin button from view main",
});
assert.equal(hide_admin_button_by_text_type_resolved_task._edit_action, "hide");
assert.equal(hide_admin_button_by_text_type_resolved_task._edit_target_text, "Admin");
assert.equal(hide_admin_button_by_text_type_resolved_task._edit_target_type, "button");
assert.deepEqual(
  can_apply_deterministic_view_edit({
    _resolved_task: hide_admin_button_by_text_type_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "admin-button",
          _type: "button",
          _text: "⚙︎ Settings",
        },
      ],
    },
  }),
  {
    _eligible: true,
    _action: "hide-object",
    _target_id: "admin-button",
    _reason: "eligible_id_from_text_type",
    _details: {
      _resolved_by: "text_type_id",
    },
  },
);
const add_primary_to_play_by_text_resolved_task = resolve_xvibe_task({
  _prompt: "Add class primary to Play button",
});
assert.equal(add_primary_to_play_by_text_resolved_task._artifact_type, "view");
assert.equal(add_primary_to_play_by_text_resolved_task._action, "update");
assert.equal(add_primary_to_play_by_text_resolved_task._edit_action, "add-class");
assert.equal(add_primary_to_play_by_text_resolved_task._edit_class_name, "primary");
assert.equal(add_primary_to_play_by_text_resolved_task._edit_target_text, "Play");
assert.equal(add_primary_to_play_by_text_resolved_task._edit_target_type, "button");
const add_active_to_play_by_id_resolved_task = resolve_xvibe_task({
  _prompt: "Add class is-active to play-button",
});
assert.equal(add_active_to_play_by_id_resolved_task._edit_action, "add-class");
assert.equal(add_active_to_play_by_id_resolved_task._edit_class_name, "is-active");
assert.equal(add_active_to_play_by_id_resolved_task._edit_target_id, "play-button");
const remove_disabled_from_pause_by_text_resolved_task = resolve_xvibe_task({
  _prompt: "Remove class disabled from Pause button",
});
assert.equal(remove_disabled_from_pause_by_text_resolved_task._edit_action, "remove-class");
assert.equal(remove_disabled_from_pause_by_text_resolved_task._edit_class_name, "disabled");
assert.equal(remove_disabled_from_pause_by_text_resolved_task._edit_target_text, "Pause");
assert.equal(remove_disabled_from_pause_by_text_resolved_task._edit_target_type, "button");
const remove_hidden_from_pause_by_id_resolved_task = resolve_xvibe_task({
  _prompt: "Remove class hidden from pause-button",
});
assert.equal(remove_hidden_from_pause_by_id_resolved_task._edit_action, "remove-class");
assert.equal(remove_hidden_from_pause_by_id_resolved_task._edit_class_name, "hidden");
assert.equal(remove_hidden_from_pause_by_id_resolved_task._edit_target_id, "pause-button");
const replace_primary_with_danger_by_text_resolved_task = resolve_xvibe_task({
  _prompt: "Replace class primary with danger on Play button",
});
assert.equal(replace_primary_with_danger_by_text_resolved_task._edit_action, "replace-class");
assert.equal(replace_primary_with_danger_by_text_resolved_task._edit_old_class_name, "primary");
assert.equal(replace_primary_with_danger_by_text_resolved_task._edit_new_class_name, "danger");
assert.equal(replace_primary_with_danger_by_text_resolved_task._edit_target_text, "Play");
assert.equal(replace_primary_with_danger_by_text_resolved_task._edit_target_type, "button");
const replace_active_with_disabled_by_id_resolved_task = resolve_xvibe_task({
  _prompt: "Replace class active with disabled on pause-button",
});
assert.equal(replace_active_with_disabled_by_id_resolved_task._edit_action, "replace-class");
assert.equal(replace_active_with_disabled_by_id_resolved_task._edit_old_class_name, "active");
assert.equal(replace_active_with_disabled_by_id_resolved_task._edit_new_class_name, "disabled");
assert.equal(replace_active_with_disabled_by_id_resolved_task._edit_target_id, "pause-button");
const toggle_active_on_play_by_text_resolved_task = resolve_xvibe_task({
  _prompt: "Toggle class active on Play button",
});
assert.equal(toggle_active_on_play_by_text_resolved_task._edit_action, "toggle-class");
assert.equal(toggle_active_on_play_by_text_resolved_task._edit_class_name, "active");
assert.equal(toggle_active_on_play_by_text_resolved_task._edit_target_text, "Play");
assert.equal(toggle_active_on_play_by_text_resolved_task._edit_target_type, "button");
const toggle_selected_on_track_card_by_id_resolved_task = resolve_xvibe_task({
  _prompt: "Toggle class selected on track-card",
});
assert.equal(toggle_selected_on_track_card_by_id_resolved_task._edit_action, "toggle-class");
assert.equal(toggle_selected_on_track_card_by_id_resolved_task._edit_class_name, "selected");
assert.equal(toggle_selected_on_track_card_by_id_resolved_task._edit_target_id, "track-card");
const set_play_background_green_resolved_task = resolve_xvibe_task({
  _prompt: "Set Play button background color to green",
});
assert.equal(set_play_background_green_resolved_task._edit_action, "set-style");
assert.equal(set_play_background_green_resolved_task._edit_style_property, "background-color");
assert.equal(set_play_background_green_resolved_task._edit_style_value, "green");
assert.equal(set_play_background_green_resolved_task._edit_target_text, "Play");
assert.equal(set_play_background_green_resolved_task._edit_target_type, "button");
const set_pause_color_red_resolved_task = resolve_xvibe_task({
  _prompt: "Set Pause button color to red",
});
assert.equal(set_pause_color_red_resolved_task._edit_action, "set-style");
assert.equal(set_pause_color_red_resolved_task._edit_style_property, "color");
assert.equal(set_pause_color_red_resolved_task._edit_style_value, "red");
assert.equal(set_pause_color_red_resolved_task._edit_target_text, "Pause");
assert.equal(set_pause_color_red_resolved_task._edit_target_type, "button");
const set_play_font_size_by_id_resolved_task = resolve_xvibe_task({
  _prompt: "Set play-button font size to 20px",
});
assert.equal(set_play_font_size_by_id_resolved_task._edit_action, "set-style");
assert.equal(set_play_font_size_by_id_resolved_task._edit_style_property, "font-size");
assert.equal(set_play_font_size_by_id_resolved_task._edit_style_value, "20px");
assert.equal(set_play_font_size_by_id_resolved_task._edit_target_id, "play-button");
const remove_play_background_resolved_task = resolve_xvibe_task({
  _prompt: "Remove background color from Play button",
});
assert.equal(remove_play_background_resolved_task._edit_action, "remove-style");
assert.equal(remove_play_background_resolved_task._edit_style_property, "background-color");
assert.equal(remove_play_background_resolved_task._edit_target_text, "Play");
assert.equal(remove_play_background_resolved_task._edit_target_type, "button");
const make_play_button_background_green_class_rule_task = resolve_xvibe_task({
  _prompt: "Make play-button background green",
});
assert.equal(make_play_button_background_green_class_rule_task._edit_action, "set-style-class-rule");
assert.equal(make_play_button_background_green_class_rule_task._edit_class_name, "play-button");
assert.equal(make_play_button_background_green_class_rule_task._edit_style_property, "background-color");
assert.equal(make_play_button_background_green_class_rule_task._edit_style_value, "green");
const set_music_card_padding_class_rule_task = resolve_xvibe_task({
  _prompt: "Set music-card padding 16px",
});
assert.equal(set_music_card_padding_class_rule_task._edit_action, "set-style-class-rule");
assert.equal(set_music_card_padding_class_rule_task._edit_class_name, "music-card");
assert.equal(set_music_card_padding_class_rule_task._edit_style_property, "padding");
assert.equal(set_music_card_padding_class_rule_task._edit_style_value, "16px");
const remove_play_button_background_class_rule_task = resolve_xvibe_task({
  _prompt: "Remove background color from play-button class",
});
assert.equal(remove_play_button_background_class_rule_task._edit_action, "remove-style-class-rule");
assert.equal(remove_play_button_background_class_rule_task._edit_class_name, "play-button");
assert.equal(remove_play_button_background_class_rule_task._edit_style_property, "background-color");
const set_play_button_text_property_task = resolve_xvibe_task({
  _prompt: "Set play-button _text to Play Now",
});
assert.equal(set_play_button_text_property_task._edit_action, "set-property");
assert.equal(set_play_button_text_property_task._edit_target_id, "play-button");
assert.equal(set_play_button_text_property_task._edit_property_name, "_text");
assert.equal(set_play_button_text_property_task._edit_property_value, "Play Now");
const set_volume_slider_min_property_task = resolve_xvibe_task({
  _prompt: "Set volume-slider min to 0",
});
assert.equal(set_volume_slider_min_property_task._edit_action, "set-property");
assert.equal(set_volume_slider_min_property_task._edit_target_id, "volume-slider");
assert.equal(set_volume_slider_min_property_task._edit_property_name, "min");
assert.equal(set_volume_slider_min_property_task._edit_property_value, 0);
const set_header_card_gap_property_task = resolve_xvibe_task({
  _prompt: "Set header-card _gap to 16",
});
assert.equal(set_header_card_gap_property_task._edit_action, "set-property");
assert.equal(set_header_card_gap_property_task._edit_target_id, "header-card");
assert.equal(set_header_card_gap_property_task._edit_property_name, "_gap");
assert.equal(set_header_card_gap_property_task._edit_property_value, 16);
const set_play_button_disabled_property_task = resolve_xvibe_task({
  _prompt: "Set play-button disabled to true",
});
assert.equal(set_play_button_disabled_property_task._edit_action, "set-property");
assert.equal(set_play_button_disabled_property_task._edit_target_id, "play-button");
assert.equal(set_play_button_disabled_property_task._edit_property_name, "disabled");
assert.equal(set_play_button_disabled_property_task._edit_property_value, true);
const remove_play_button_disabled_property_task = resolve_xvibe_task({
  _prompt: "Remove disabled from play-button",
});
assert.equal(remove_play_button_disabled_property_task._edit_action, "remove-property");
assert.equal(remove_play_button_disabled_property_task._edit_target_id, "play-button");
assert.equal(remove_play_button_disabled_property_task._edit_property_name, "disabled");
const set_play_button_children_property_task = resolve_xvibe_task({
  _prompt: "Set play-button _children to []",
});
assert.equal(set_play_button_children_property_task._edit_action, "set-property");
assert.equal(set_play_button_children_property_task._edit_target_id, "play-button");
assert.equal(set_play_button_children_property_task._edit_property_name, "_children");
assert.equal(set_play_button_children_property_task._edit_property_value, "[]");
const move_pause_before_play_task = resolve_xvibe_task({
  _prompt: "Move pause-button before play-button",
});
assert.equal(move_pause_before_play_task._edit_action, "move-object");
assert.equal(move_pause_before_play_task._edit_target_id, "pause-button");
assert.equal(move_pause_before_play_task._edit_move_position, "before");
assert.equal(move_pause_before_play_task._edit_anchor_id, "play-button");
const move_controls_after_header_task = resolve_xvibe_task({
  _prompt: "Move controls-stack after header-card",
});
assert.equal(move_controls_after_header_task._edit_action, "move-object");
assert.equal(move_controls_after_header_task._edit_target_id, "controls-stack");
assert.equal(move_controls_after_header_task._edit_move_position, "after");
assert.equal(move_controls_after_header_task._edit_anchor_id, "header-card");
const move_powered_by_label_bottom_task = resolve_xvibe_task({
  _prompt: "Move powered-by label to bottom",
});
assert.equal(move_powered_by_label_bottom_task._edit_action, "move-object");
assert.equal(move_powered_by_label_bottom_task._edit_target_text, "powered-by");
assert.equal(move_powered_by_label_bottom_task._edit_target_type, "label");
assert.equal(move_powered_by_label_bottom_task._edit_move_position, "bottom");
const move_title_label_top_task = resolve_xvibe_task({
  _prompt: "Move title label to top",
});
assert.equal(move_title_label_top_task._edit_action, "move-object");
assert.equal(move_title_label_top_task._edit_target_text, "title");
assert.equal(move_title_label_top_task._edit_target_type, "label");
assert.equal(move_title_label_top_task._edit_move_position, "top");
const deterministic_class_edit_view = {
  _id: "main",
  _type: "view",
  _children: [
    {
      _id: "play-button",
      _type: "button",
      _text: "▶ Play",
      class: "music-button",
      style: "color:red",
      _style: { color: "red" },
      _on: {
        _click: {
          _op: "play",
        },
      },
      _children: [
        {
          _id: "play-icon",
          _type: "icon",
        },
      ],
    },
    {
      _id: "pause-button",
      _type: "button",
      _text: "Pause",
      class: "music-button disabled primary",
    },
  ],
};
assert.deepEqual(
  can_apply_deterministic_view_edit({
    _resolved_task: add_primary_to_play_by_text_resolved_task,
    _current_view: deterministic_class_edit_view,
  }),
  {
    _eligible: true,
    _action: "add-class",
    _target_id: "play-button",
    _reason: "eligible_normalized_text_match",
    _details: {
      _resolved_by: "normalized_text",
    },
  },
);
const add_primary_to_play_by_text_result =
  apply_deterministic_view_edit({
    _resolved_task: add_primary_to_play_by_text_resolved_task,
    _current_view: deterministic_class_edit_view,
  });
assert.equal(add_primary_to_play_by_text_result._ok, true);
const add_primary_to_play_by_text_view =
  add_primary_to_play_by_text_result._view as any;
assert.equal(add_primary_to_play_by_text_view._children[0].class, "music-button primary");
assert.equal(deterministic_class_edit_view._children[0].class, "music-button");
assert.equal(add_primary_to_play_by_text_view._children[0]._class, undefined);
assert.equal(add_primary_to_play_by_text_view._children[0].style, "color:red");
assert.deepEqual(add_primary_to_play_by_text_view._children[0]._style, { color: "red" });
assert.deepEqual(
  add_primary_to_play_by_text_view._children[0]._on,
  deterministic_class_edit_view._children[0]._on,
);
assert.deepEqual(
  add_primary_to_play_by_text_view._children[0]._children,
  deterministic_class_edit_view._children[0]._children,
);
assert.deepEqual(
  add_primary_to_play_by_text_result._mutation,
  {
    _type: "deterministic-view-edit",
    _action: "add-class",
    _target_id: "play-button",
    _resolved_by: "normalized_text",
    _class_name: "primary",
    _class_field: "class",
    _previous_class: "music-button",
    _next_class: "music-button primary",
  },
);
const add_duplicate_class_result =
  apply_deterministic_view_edit({
    _resolved_task: add_primary_to_play_by_text_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "play-button",
          _type: "button",
          _text: "Play",
          class: "music-button primary",
        },
      ],
    },
  });
assert.equal(add_duplicate_class_result._ok, true);
assert.equal((add_duplicate_class_result._view as any)._children[0].class, "music-button primary");
assert.equal(add_duplicate_class_result._mutation?._previous_class, "music-button primary");
assert.equal(add_duplicate_class_result._mutation?._next_class, "music-button primary");
const remove_disabled_from_pause_by_text_result =
  apply_deterministic_view_edit({
    _resolved_task: remove_disabled_from_pause_by_text_resolved_task,
    _current_view: deterministic_class_edit_view,
  });
assert.equal(remove_disabled_from_pause_by_text_result._ok, true);
assert.equal((remove_disabled_from_pause_by_text_result._view as any)._children[1].class, "music-button primary");
assert.deepEqual(
  remove_disabled_from_pause_by_text_result._mutation,
  {
    _type: "deterministic-view-edit",
    _action: "remove-class",
    _target_id: "pause-button",
    _resolved_by: "text",
    _class_name: "disabled",
    _class_field: "class",
    _previous_class: "music-button disabled primary",
    _next_class: "music-button primary",
  },
);
const remove_last_class_result =
  apply_deterministic_view_edit({
    _resolved_task: remove_disabled_from_pause_by_text_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "pause-button",
          _type: "button",
          _text: "Pause",
          class: "disabled",
        },
      ],
    },
  });
assert.equal(remove_last_class_result._ok, true);
assert.equal(Object.prototype.hasOwnProperty.call((remove_last_class_result._view as any)._children[0], "class"), false);
assert.equal(remove_last_class_result._mutation?._previous_class, "disabled");
assert.equal(remove_last_class_result._mutation?._next_class, undefined);
const class_alias_add_result =
  apply_deterministic_view_edit({
    _resolved_task: add_primary_to_play_by_text_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "play-button",
          _type: "button",
          _text: "Play",
          _class: "music-button",
        },
      ],
    },
  });
assert.equal(class_alias_add_result._ok, true);
assert.equal((class_alias_add_result._view as any)._children[0]._class, "music-button primary");
assert.equal((class_alias_add_result._view as any)._children[0].class, undefined);
assert.equal(class_alias_add_result._mutation?._class_field, "_class");
const class_alias_remove_result =
  apply_deterministic_view_edit({
    _resolved_task: remove_disabled_from_pause_by_text_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "pause-button",
          _type: "button",
          _text: "Pause",
          _class: "music-button disabled",
        },
      ],
    },
  });
assert.equal(class_alias_remove_result._ok, true);
assert.equal((class_alias_remove_result._view as any)._children[0]._class, "music-button");
assert.equal((class_alias_remove_result._view as any)._children[0].class, undefined);
assert.equal(class_alias_remove_result._mutation?._class_field, "_class");
const replace_primary_with_danger_by_text_result =
  apply_deterministic_view_edit({
    _resolved_task: replace_primary_with_danger_by_text_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "play-button",
          _type: "button",
          _text: "▶ Play",
          class: "music-button primary",
        },
      ],
    },
  });
assert.equal(replace_primary_with_danger_by_text_result._ok, true);
assert.equal((replace_primary_with_danger_by_text_result._view as any)._children[0].class, "music-button danger");
assert.deepEqual(
  replace_primary_with_danger_by_text_result._mutation,
  {
    _type: "deterministic-view-edit",
    _action: "replace-class",
    _target_id: "play-button",
    _resolved_by: "normalized_text",
    _old_class_name: "primary",
    _new_class_name: "danger",
    _class_field: "class",
    _previous_class: "music-button primary",
    _next_class: "music-button danger",
  },
);
const replace_missing_class_result =
  apply_deterministic_view_edit({
    _resolved_task: replace_primary_with_danger_by_text_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "play-button",
          _type: "button",
          _text: "Play",
          class: "music-button",
        },
      ],
    },
  });
assert.equal(replace_missing_class_result._ok, true);
assert.equal((replace_missing_class_result._view as any)._children[0].class, "music-button danger");
const replace_duplicate_protection_result =
  apply_deterministic_view_edit({
    _resolved_task: replace_primary_with_danger_by_text_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "play-button",
          _type: "button",
          _text: "Play",
          class: "music-button primary danger",
        },
      ],
    },
  });
assert.equal(replace_duplicate_protection_result._ok, true);
assert.equal((replace_duplicate_protection_result._view as any)._children[0].class, "music-button danger");
const toggle_remove_class_result =
  apply_deterministic_view_edit({
    _resolved_task: toggle_active_on_play_by_text_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "play-button",
          _type: "button",
          _text: "Play",
          class: "music-button active",
        },
      ],
    },
  });
assert.equal(toggle_remove_class_result._ok, true);
assert.equal((toggle_remove_class_result._view as any)._children[0].class, "music-button");
assert.deepEqual(
  toggle_remove_class_result._mutation,
  {
    _type: "deterministic-view-edit",
    _action: "toggle-class",
    _target_id: "play-button",
    _resolved_by: "text",
    _class_name: "active",
    _class_field: "class",
    _previous_class: "music-button active",
    _next_class: "music-button",
  },
);
const toggle_add_class_result =
  apply_deterministic_view_edit({
    _resolved_task: toggle_active_on_play_by_text_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "play-button",
          _type: "button",
          _text: "Play",
          class: "music-button",
        },
      ],
    },
  });
assert.equal(toggle_add_class_result._ok, true);
assert.equal((toggle_add_class_result._view as any)._children[0].class, "music-button active");
const toggle_alias_result =
  apply_deterministic_view_edit({
    _resolved_task: toggle_active_on_play_by_text_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "play-button",
          _type: "button",
          _text: "Play",
          _class: "music-button active",
        },
      ],
    },
  });
assert.equal(toggle_alias_result._ok, true);
assert.equal((toggle_alias_result._view as any)._children[0]._class, "music-button");
assert.equal((toggle_alias_result._view as any)._children[0].class, undefined);
assert.equal(toggle_alias_result._mutation?._class_field, "_class");
const set_style_by_text_view = {
  _id: "main",
  _type: "view",
  _children: [
    {
      _id: "play-button",
      _type: "button",
      _text: "Play",
      _style: {
        color: "white",
      },
      class: "music-button",
      style: "display:flex",
      _on: {
        _click: {
          _op: "play",
        },
      },
      _children: [
        {
          _id: "play-icon",
          _type: "icon",
        },
      ],
    },
  ],
};
const set_style_by_text_result =
  apply_deterministic_view_edit({
    _resolved_task: set_play_background_green_resolved_task,
    _current_view: set_style_by_text_view,
  });
assert.equal(set_style_by_text_result._ok, true);
assert.deepEqual(
  (set_style_by_text_result._view as any)._children[0]._style,
  {
    color: "white",
    "background-color": "green",
  },
);
assert.deepEqual(set_style_by_text_view._children[0]._style, { color: "white" });
assert.equal((set_style_by_text_result._view as any)._children[0].class, "music-button");
assert.equal((set_style_by_text_result._view as any)._children[0].style, "display:flex");
assert.deepEqual(
  (set_style_by_text_result._view as any)._children[0]._on,
  set_style_by_text_view._children[0]._on,
);
assert.deepEqual(
  (set_style_by_text_result._view as any)._children[0]._children,
  set_style_by_text_view._children[0]._children,
);
assert.deepEqual(
  set_style_by_text_result._mutation,
  {
    _type: "deterministic-view-edit",
    _action: "set-style",
    _target_id: "play-button",
    _resolved_by: "text",
    _style_property: "background-color",
    _next_value: "green",
  },
);
const replace_existing_style_result =
  apply_deterministic_view_edit({
    _resolved_task: set_play_background_green_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "play-button",
          _type: "button",
          _text: "Play",
          _style: {
            "background-color": "red",
          },
        },
      ],
    },
  });
assert.equal(replace_existing_style_result._ok, true);
assert.deepEqual(
  (replace_existing_style_result._view as any)._children[0]._style,
  {
    "background-color": "green",
  },
);
assert.equal(replace_existing_style_result._mutation?._previous_value, "red");
assert.equal(replace_existing_style_result._mutation?._next_value, "green");
const remove_style_property_result =
  apply_deterministic_view_edit({
    _resolved_task: remove_play_background_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "play-button",
          _type: "button",
          _text: "Play",
          _style: {
            "background-color": "green",
            color: "white",
          },
        },
      ],
    },
  });
assert.equal(remove_style_property_result._ok, true);
assert.deepEqual(
  (remove_style_property_result._view as any)._children[0]._style,
  {
    color: "white",
  },
);
assert.deepEqual(
  remove_style_property_result._mutation,
  {
    _type: "deterministic-view-edit",
    _action: "remove-style",
    _target_id: "play-button",
    _resolved_by: "text",
    _style_property: "background-color",
    _previous_value: "green",
  },
);
const remove_last_style_property_result =
  apply_deterministic_view_edit({
    _resolved_task: remove_play_background_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "play-button",
          _type: "button",
          _text: "Play",
          _style: {
            "background-color": "green",
          },
        },
      ],
    },
  });
assert.equal(remove_last_style_property_result._ok, true);
assert.equal(Object.prototype.hasOwnProperty.call((remove_last_style_property_result._view as any)._children[0], "_style"), false);
const create_style_result =
  apply_deterministic_view_edit({
    _resolved_task: set_pause_color_red_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "pause-button",
          _type: "button",
          _text: "Pause",
        },
      ],
    },
  });
assert.equal(create_style_result._ok, true);
assert.deepEqual(
  (create_style_result._view as any)._children[0]._style,
  {
    color: "red",
  },
);
const style_class_rule_base_view = {
  _id: "main",
  _type: "view",
  _children: [
    {
      _id: "main-styles",
      _type: "style-sheet",
      _classes: {},
    },
    {
      _id: "play-button",
      _type: "button",
      _text: "Play",
      class: "play-button",
      _style: {
        color: "white",
      },
    },
  ],
};
assert.deepEqual(
  can_apply_deterministic_view_edit({
    _resolved_task: make_play_button_background_green_class_rule_task,
    _current_view: style_class_rule_base_view,
  }),
  {
    _eligible: true,
    _action: "set-style-class-rule",
    _reason: "eligible_style_class_rule",
  },
);
const create_style_class_rule_result =
  apply_deterministic_view_edit({
    _resolved_task: make_play_button_background_green_class_rule_task,
    _current_view: style_class_rule_base_view,
  });
assert.equal(create_style_class_rule_result._ok, true);
assert.deepEqual(
  (create_style_class_rule_result._view as any)._children[0]._classes,
  {
    "play-button": {
      "background-color": "green",
    },
  },
);
assert.deepEqual(style_class_rule_base_view._children[0]._classes, {});
assert.deepEqual(
  (create_style_class_rule_result._view as any)._children[1]._style,
  {
    color: "white",
  },
);
assert.equal((create_style_class_rule_result._view as any)._children[1].class, "play-button");
assert.deepEqual(
  create_style_class_rule_result._mutation,
  {
    _type: "deterministic-view-edit",
    _action: "set-style-class-rule",
    _class_name: "play-button",
    _style_property: "background-color",
    _next_value: "green",
  },
);
const update_style_class_rule_result =
  apply_deterministic_view_edit({
    _resolved_task: make_play_button_background_green_class_rule_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "main-styles",
          _type: "style-sheet",
          _classes: {
            "play-button": {
              "background-color": "red",
              color: "white",
            },
          },
        },
      ],
    },
  });
assert.equal(update_style_class_rule_result._ok, true);
assert.deepEqual(
  (update_style_class_rule_result._view as any)._children[0]._classes,
  {
    "play-button": {
      "background-color": "green",
      color: "white",
    },
  },
);
assert.equal(update_style_class_rule_result._mutation?._previous_value, "red");
assert.equal(update_style_class_rule_result._mutation?._next_value, "green");
const remove_style_class_rule_property_result =
  apply_deterministic_view_edit({
    _resolved_task: remove_play_button_background_class_rule_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "main-styles",
          _type: "style-sheet",
          _classes: {
            "play-button": {
              "background-color": "green",
              color: "white",
            },
          },
        },
      ],
    },
  });
assert.equal(remove_style_class_rule_property_result._ok, true);
assert.deepEqual(
  (remove_style_class_rule_property_result._view as any)._children[0]._classes,
  {
    "play-button": {
      color: "white",
    },
  },
);
assert.deepEqual(
  remove_style_class_rule_property_result._mutation,
  {
    _type: "deterministic-view-edit",
    _action: "remove-style-class-rule",
    _class_name: "play-button",
    _style_property: "background-color",
    _previous_value: "green",
  },
);
const remove_last_style_class_rule_property_result =
  apply_deterministic_view_edit({
    _resolved_task: remove_play_button_background_class_rule_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "main-styles",
          _type: "style-sheet",
          _classes: {
            "play-button": {
              "background-color": "green",
            },
          },
        },
      ],
    },
  });
assert.equal(remove_last_style_class_rule_property_result._ok, true);
assert.deepEqual((remove_last_style_class_rule_property_result._view as any)._children[0]._classes, {});
assert.deepEqual(
  can_apply_deterministic_view_edit({
    _resolved_task: make_play_button_background_green_class_rule_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "play-button",
          _type: "button",
          _text: "Play",
        },
      ],
    },
  }),
  {
    _eligible: false,
    _reason: "missing_style_sheet",
  },
);
const set_text_property_result =
  apply_deterministic_view_edit({
    _resolved_task: set_play_button_text_property_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "play-button",
          _type: "button",
          _text: "Play",
          class: "music-button",
          _on: {
            _click: {
              _op: "play",
            },
          },
        },
      ],
    },
  });
assert.equal(set_text_property_result._ok, true);
assert.equal((set_text_property_result._view as any)._children[0]._text, "Play Now");
assert.equal((set_text_property_result._view as any)._children[0].class, "music-button");
assert.deepEqual(
  (set_text_property_result._view as any)._children[0]._on,
  {
    _click: {
      _op: "play",
    },
  },
);
assert.deepEqual(
  set_text_property_result._mutation,
  {
    _type: "deterministic-view-edit",
    _action: "set-property",
    _target_id: "play-button",
    _resolved_by: "id",
    _property_name: "_text",
    _previous_value: "Play",
    _next_value: "Play Now",
  },
);
const set_gap_property_result =
  apply_deterministic_view_edit({
    _resolved_task: set_header_card_gap_property_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "header-card",
          _type: "card",
          _gap: 8,
        },
      ],
    },
  });
assert.equal(set_gap_property_result._ok, true);
assert.equal((set_gap_property_result._view as any)._children[0]._gap, 16);
assert.equal(set_gap_property_result._mutation?._previous_value, 8);
assert.equal(set_gap_property_result._mutation?._next_value, 16);
const set_disabled_property_result =
  apply_deterministic_view_edit({
    _resolved_task: set_play_button_disabled_property_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "play-button",
          _type: "button",
          _text: "Play",
        },
      ],
    },
  });
assert.equal(set_disabled_property_result._ok, true);
assert.equal((set_disabled_property_result._view as any)._children[0].disabled, true);
assert.equal(set_disabled_property_result._mutation?._next_value, true);
const remove_disabled_property_result =
  apply_deterministic_view_edit({
    _resolved_task: remove_play_button_disabled_property_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "play-button",
          _type: "button",
          _text: "Play",
          disabled: true,
        },
      ],
    },
  });
assert.equal(remove_disabled_property_result._ok, true);
assert.equal(Object.prototype.hasOwnProperty.call((remove_disabled_property_result._view as any)._children[0], "disabled"), false);
assert.deepEqual(
  remove_disabled_property_result._mutation,
  {
    _type: "deterministic-view-edit",
    _action: "remove-property",
    _target_id: "play-button",
    _resolved_by: "id",
    _property_name: "disabled",
    _previous_value: true,
  },
);
assert.deepEqual(
  can_apply_deterministic_view_edit({
    _resolved_task: set_play_button_children_property_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "play-button",
          _type: "button",
          _text: "Play",
        },
      ],
    },
  }),
  {
    _eligible: false,
    _reason: "unsupported_property",
    _details: {
      _target_type: "button",
      _property_name: "_children",
      _skill_design_found: false,
      _allowed_field_keys: [
        "_class",
        "_style",
        "_text",
        "class",
        "disabled",
        "placeholder",
        "style",
      ],
    },
  },
);
const move_before_result =
  apply_deterministic_view_edit({
    _resolved_task: move_pause_before_play_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "play-button",
          _type: "button",
          _text: "Play",
        },
        {
          _id: "pause-button",
          _type: "button",
          _text: "Pause",
          _children: [
            {
              _id: "pause-icon",
              _type: "icon",
            },
          ],
        },
        {
          _id: "stop-button",
          _type: "button",
          _text: "Stop",
        },
      ],
    },
  });
assert.equal(move_before_result._ok, true);
assert.deepEqual(
  (move_before_result._view as any)._children.map((child: any) => child._id),
  ["pause-button", "play-button", "stop-button"],
);
assert.deepEqual(
  (move_before_result._view as any)._children[0]._children,
  [
    {
      _id: "pause-icon",
      _type: "icon",
    },
  ],
);
assert.deepEqual(
  move_before_result._mutation,
  {
    _type: "deterministic-view-edit",
    _action: "move-object",
    _target_id: "pause-button",
    _resolved_by: "id",
    _move_position: "before",
    _anchor_id: "play-button",
    _before_id: "play-button",
    _anchor_resolved_by: "id",
    _parent_id: "main",
    _previous_index: 1,
    _next_index: 0,
  },
);
const move_after_result =
  apply_deterministic_view_edit({
    _resolved_task: move_controls_after_header_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "controls-stack",
          _type: "xsection",
        },
        {
          _id: "header-card",
          _type: "card",
        },
        {
          _id: "footer",
          _type: "label",
          _text: "Footer",
        },
      ],
    },
  });
assert.equal(move_after_result._ok, true);
assert.deepEqual(
  (move_after_result._view as any)._children.map((child: any) => child._id),
  ["header-card", "controls-stack", "footer"],
);
const move_bottom_result =
  apply_deterministic_view_edit({
    _resolved_task: move_powered_by_label_bottom_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "title-label",
          _type: "label",
          _text: "title",
        },
        {
          _id: "powered-by-label",
          _type: "label",
          _text: "powered-by",
        },
        {
          _id: "controls-stack",
          _type: "xsection",
        },
      ],
    },
  });
assert.equal(move_bottom_result._ok, true);
assert.deepEqual(
  (move_bottom_result._view as any)._children.map((child: any) => child._id),
  ["title-label", "controls-stack", "powered-by-label"],
);
assert.equal(move_bottom_result._mutation?._resolved_by, "text");
assert.equal(move_bottom_result._mutation?._move_position, "bottom");
assert.equal(move_bottom_result._mutation?._previous_index, 1);
assert.equal(move_bottom_result._mutation?._next_index, 2);
const move_top_result =
  apply_deterministic_view_edit({
    _resolved_task: move_title_label_top_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "controls-stack",
          _type: "xsection",
        },
        {
          _id: "title-label",
          _type: "label",
          _text: "title",
        },
      ],
    },
  });
assert.equal(move_top_result._ok, true);
assert.deepEqual(
  (move_top_result._view as any)._children.map((child: any) => child._id),
  ["title-label", "controls-stack"],
);
assert.deepEqual(
  can_apply_deterministic_view_edit({
    _resolved_task: move_pause_before_play_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "left",
          _type: "xsection",
          _children: [
            {
              _id: "pause-button",
              _type: "button",
              _text: "Pause",
            },
          ],
        },
        {
          _id: "right",
          _type: "xsection",
          _children: [
            {
              _id: "play-button",
              _type: "button",
              _text: "Play",
            },
          ],
        },
      ],
    },
  })._reason,
  "different_parent",
);
assert.deepEqual(
  can_apply_deterministic_view_edit({
    _resolved_task: move_pause_before_play_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "pause-button",
          _type: "button",
          _text: "Pause",
        },
      ],
    },
  })._reason,
  "anchor_not_found",
);
assert.deepEqual(
  can_apply_deterministic_view_edit({
    _resolved_task: {
      ...move_pause_before_play_task,
      _edit_target_id: "main",
    },
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "play-button",
          _type: "button",
          _text: "Play",
        },
      ],
    },
  })._reason,
  "target_is_root",
);
assert.equal(
  can_apply_deterministic_view_edit({
    _resolved_task: set_play_background_green_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "play-button-1",
          _type: "button",
          _text: "Play",
        },
        {
          _id: "play-button-2",
          _type: "button",
          _text: "Play",
        },
      ],
    },
  })._reason,
  "ambiguous_text_target",
);
assert.equal(
  can_apply_deterministic_view_edit({
    _resolved_task: remove_disabled_from_pause_by_text_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "pause-button-1",
          _type: "button",
          _text: "Pause",
        },
        {
          _id: "pause-button-2",
          _type: "button",
          _text: "Pause",
        },
      ],
    },
  })._reason,
  "ambiguous_text_target",
);
const show_pause_button_by_id_resolved_task = resolve_xvibe_task({
  _prompt: "Show pause-button",
});
assert.equal(show_pause_button_by_id_resolved_task._artifact_type, "view");
assert.equal(show_pause_button_by_id_resolved_task._action, "update");
assert.equal(show_pause_button_by_id_resolved_task._edit_action, "show");
assert.equal(show_pause_button_by_id_resolved_task._edit_target_id, "pause-button");
const show_pause_button_by_text_resolved_task = resolve_xvibe_task({
  _prompt: "Show Pause button",
});
assert.equal(show_pause_button_by_text_resolved_task._artifact_type, "view");
assert.equal(show_pause_button_by_text_resolved_task._action, "update");
assert.equal(show_pause_button_by_text_resolved_task._edit_action, "show");
assert.equal(show_pause_button_by_text_resolved_task._edit_target_text, "Pause");
assert.equal(show_pause_button_by_text_resolved_task._edit_target_type, "button");
const unhide_pause_button_resolved_task = resolve_xvibe_task({
  _prompt: "Unhide Pause button",
});
assert.equal(unhide_pause_button_resolved_task._edit_action, "show");
assert.equal(unhide_pause_button_resolved_task._edit_target_text, "Pause");
assert.equal(unhide_pause_button_resolved_task._edit_target_type, "button");
const make_pause_button_visible_resolved_task = resolve_xvibe_task({
  _prompt: "Make Pause button visible",
});
assert.equal(make_pause_button_visible_resolved_task._edit_action, "show");
assert.equal(make_pause_button_visible_resolved_task._edit_target_text, "Pause");
assert.equal(make_pause_button_visible_resolved_task._edit_target_type, "button");
const hidden_pause_button_view = {
  _id: "main",
  _type: "view",
  _children: [
    {
      _id: "pause-button",
      _type: "button",
      _text: "Pause",
      style: "display:none",
      _visible: false,
    },
  ],
};
assert.deepEqual(
  can_apply_deterministic_view_edit({
    _resolved_task: show_pause_button_by_id_resolved_task,
    _current_view: hidden_pause_button_view,
  }),
  {
    _eligible: true,
    _action: "show-object",
    _target_id: "pause-button",
    _reason: "eligible",
    _details: {
      _resolved_by: "id",
    },
  },
);
const show_pause_button_by_id_result =
  apply_deterministic_view_edit({
    _resolved_task: show_pause_button_by_id_resolved_task,
    _current_view: hidden_pause_button_view,
  });
assert.equal(show_pause_button_by_id_result._ok, true);
assert.equal((show_pause_button_by_id_result._view as any)._children[0].style, undefined);
assert.equal((show_pause_button_by_id_result._view as any)._children[0]._visible, true);
assert.equal((hidden_pause_button_view._children[0] as any).style, "display:none");
assert.equal((hidden_pause_button_view._children[0] as any)._visible, false);
assert.deepEqual(
  show_pause_button_by_id_result._mutation,
  {
    _type: "deterministic-view-edit",
    _action: "show-object",
    _target_id: "pause-button",
    _resolved_by: "id",
    _parent_id: "main",
    _show_mechanism: "remove-style.display:none",
  },
);
const hidden_icon_prefixed_pause_button_view = {
  _id: "main",
  _type: "view",
  _children: [
    {
      _id: "pause-button",
      _type: "button",
      _text: "⏸ Pause",
      style: "color:red; display:none; padding:8px",
      _visible: false,
    },
  ],
};
assert.deepEqual(
  can_apply_deterministic_view_edit({
    _resolved_task: show_pause_button_by_text_resolved_task,
    _current_view: hidden_icon_prefixed_pause_button_view,
  }),
  {
    _eligible: true,
    _action: "show-object",
    _target_id: "pause-button",
    _reason: "eligible_normalized_text_match",
    _details: {
      _resolved_by: "normalized_text",
    },
  },
);
const show_pause_button_by_normalized_text_result =
  apply_deterministic_view_edit({
    _resolved_task: show_pause_button_by_text_resolved_task,
    _current_view: hidden_icon_prefixed_pause_button_view,
  });
assert.equal(show_pause_button_by_normalized_text_result._ok, true);
assert.equal((show_pause_button_by_normalized_text_result._view as any)._children[0].style, "color:red; padding:8px");
assert.equal(test_style_has_display_none((show_pause_button_by_normalized_text_result._view as any)._children[0].style), false);
assert.equal((show_pause_button_by_normalized_text_result._view as any)._children[0]._visible, true);
assert.equal(show_pause_button_by_normalized_text_result._mutation?._resolved_by, "normalized_text");
assert.equal(
  can_apply_deterministic_view_edit({
    _resolved_task: {
      ...show_pause_button_by_id_resolved_task,
      _edit_target_id: "main",
    },
    _current_view: hidden_pause_button_view,
  })._reason,
  "target_is_root",
);
assert.equal(
  can_apply_deterministic_view_edit({
    _resolved_task: show_pause_button_by_text_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "pause-button-1",
          _type: "button",
          _text: "Pause",
          style: "display:none",
          _visible: false,
        },
        {
          _id: "pause-button-2",
          _type: "button",
          _text: "Pause",
          style: "display:none",
          _visible: false,
        },
      ],
    },
  })._reason,
  "ambiguous_text_target",
);
const play_button_text_change_resolved_task = resolve_xvibe_task({
  _prompt: 'Update main view only. Change play-button text from "▶ Play" to "▶ Start Music". Do not modify anything else.',
});
assert.equal(play_button_text_change_resolved_task._artifact_type, "view");
assert.equal(play_button_text_change_resolved_task._action, "update");
assert.equal(play_button_text_change_resolved_task._target_id, "main");
assert.equal(play_button_text_change_resolved_task._edit_action, "update");
assert.equal(play_button_text_change_resolved_task._edit_target_id, "play-button");
assert.equal(play_button_text_change_resolved_task._edit_target_text, "▶ Play");
assert.equal(play_button_text_change_resolved_task._edit_replacement_text, "▶ Start Music");
assert.equal(play_button_text_change_resolved_task._edit_field, "_text");
const unquoted_pause_text_change_resolved_task = resolve_xvibe_task({
  _prompt: "Update main view only.\nChange Pause button text to Resume.\nDo not modify anything else.",
});
assert.equal(unquoted_pause_text_change_resolved_task._artifact_type, "view");
assert.equal(unquoted_pause_text_change_resolved_task._action, "update");
assert.equal(unquoted_pause_text_change_resolved_task._edit_action, "update");
assert.equal(unquoted_pause_text_change_resolved_task._edit_field, "_text");
assert.equal(unquoted_pause_text_change_resolved_task._edit_target_text, "Pause");
assert.equal(unquoted_pause_text_change_resolved_task._edit_target_type, "button");
assert.equal(unquoted_pause_text_change_resolved_task._edit_replacement_text, "Resume");
const unquoted_pause_label_change_resolved_task = resolve_xvibe_task({
  _prompt: "Update main view only. Change pause button label to Resume. Do not modify anything else.",
});
assert.equal(unquoted_pause_label_change_resolved_task._edit_action, "update");
assert.equal(unquoted_pause_label_change_resolved_task._edit_field, "_text");
assert.equal(unquoted_pause_label_change_resolved_task._edit_target_text, "pause");
assert.equal(unquoted_pause_label_change_resolved_task._edit_target_type, "button");
assert.equal(unquoted_pause_label_change_resolved_task._edit_replacement_text, "Resume");
const unquoted_pause_set_text_resolved_task = resolve_xvibe_task({
  _prompt: "Update main view only. Set Pause button text to Resume. Do not modify anything else.",
});
assert.equal(unquoted_pause_set_text_resolved_task._artifact_type, "view");
assert.equal(unquoted_pause_set_text_resolved_task._action, "update");
assert.equal(unquoted_pause_set_text_resolved_task._edit_action, "update");
assert.equal(unquoted_pause_set_text_resolved_task._edit_field, "_text");
assert.equal(unquoted_pause_set_text_resolved_task._edit_target_text, "Pause");
assert.equal(unquoted_pause_set_text_resolved_task._edit_target_type, "button");
assert.equal(unquoted_pause_set_text_resolved_task._edit_replacement_text, "Resume");
const unquoted_pause_rename_resolved_task = resolve_xvibe_task({
  _prompt: "Update main view only. Rename Pause button to Resume. Do not modify anything else.",
});
assert.equal(unquoted_pause_rename_resolved_task._artifact_type, "view");
assert.equal(unquoted_pause_rename_resolved_task._action, "update");
assert.equal(unquoted_pause_rename_resolved_task._edit_action, "update");
assert.equal(unquoted_pause_rename_resolved_task._edit_field, "_text");
assert.equal(unquoted_pause_rename_resolved_task._edit_target_text, "Pause");
assert.equal(unquoted_pause_rename_resolved_task._edit_target_type, "button");
assert.equal(unquoted_pause_rename_resolved_task._edit_replacement_text, "Resume");
const update_icon_prefixed_pause_result =
  apply_deterministic_view_edit({
    _resolved_task: unquoted_pause_text_change_resolved_task,
    _current_view: icon_prefixed_pause_button_view,
  });
assert.equal(update_icon_prefixed_pause_result._ok, true);
assert.equal((update_icon_prefixed_pause_result._view as any)._children[0]._text, "Resume");
assert.equal(icon_prefixed_pause_button_view._children[0]._text, "⏸ Pause");
assert.equal(update_icon_prefixed_pause_result._mutation?._resolved_by, "normalized_text");
const deterministic_text_update_resolved_task = resolve_xvibe_task({
  _prompt: 'Update main view only. Change play-button text from "▶ Start Music" to "▶ Play". Do not modify anything else.',
});
const deterministic_text_update_view = {
  _id: "main",
  _type: "view",
  _children: [
    {
      _id: "play-button",
      _type: "button",
      _text: "▶ Start Music",
      _class: "primary-action",
      _on: {
        _click: {
          _op: "play",
        },
      },
    },
    {
      _id: "powered-label",
      _type: "label",
      _text: "Powered by Xpell",
    },
  ],
};
assert.deepEqual(
  can_apply_deterministic_view_edit({
    _resolved_task: deterministic_text_update_resolved_task,
    _current_view: deterministic_text_update_view,
  }),
  {
    _eligible: true,
    _action: "update-text",
    _target_id: "play-button",
    _field: "_text",
    _reason: "eligible",
  },
);
assert.equal(
  can_apply_deterministic_view_edit({
    _resolved_task: deterministic_text_update_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "play-button",
          _type: "button",
          _text: "▶ Play",
        },
      ],
    },
  })._reason,
  "text_mismatch",
);
assert.equal(
  can_apply_deterministic_view_edit({
    _resolved_task: deterministic_text_update_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [],
    },
  })._reason,
  "target_not_found",
);
const deterministic_text_update_result =
  apply_deterministic_view_edit({
    _resolved_task: deterministic_text_update_resolved_task,
    _current_view: deterministic_text_update_view,
  });
assert.equal(deterministic_text_update_result._ok, true);
const deterministic_text_update_result_view =
  deterministic_text_update_result._view as any;
assert.equal(
  deterministic_text_update_result_view._children[0]._text,
  "▶ Play",
);
assert.equal(
  deterministic_text_update_view._children[0]._text,
  "▶ Start Music",
);
assert.equal(
  deterministic_text_update_result_view._children[0]._id,
  "play-button",
);
assert.equal(
  deterministic_text_update_result_view._children[0]._class,
  "primary-action",
);
assert.deepEqual(
  deterministic_text_update_result_view._children[0]._on,
  deterministic_text_update_view._children[0]._on,
);
assert.deepEqual(
  deterministic_text_update_result_view._children[1],
  deterministic_text_update_view._children[1],
);
assert.notEqual(
  deterministic_text_update_result_view._children[0],
  deterministic_text_update_view._children[0],
);
assert.deepEqual(
  deterministic_text_update_result._mutation,
  {
    _type: "deterministic-view-edit",
    _action: "update-text",
    _target_id: "play-button",
    _field: "_text",
    _previous_text: "▶ Start Music",
    _replacement_text: "▶ Play",
    _resolved_by: "id",
  },
);
assert.equal(
  apply_deterministic_view_edit({
    _resolved_task: deterministic_text_update_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "play-button",
          _type: "button",
          _text: "▶ Play",
        },
      ],
    },
  })._reason,
  "text_mismatch",
);
assert.equal(
  apply_deterministic_view_edit({
    _resolved_task: deterministic_text_update_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [],
    },
  })._reason,
  "target_not_found",
);
assert.equal(
  apply_deterministic_view_edit({
    _resolved_task: {
      ...deterministic_text_update_resolved_task,
      _edit_target_id: "main",
    },
    _current_view: deterministic_text_update_view,
  })._reason,
  "target_is_root",
);
const deterministic_text_only_resolved_task = resolve_xvibe_task({
  _prompt: 'Update main view only. Change "Powered by Xpell AI" to "Powered by Xpell". Do not modify anything else.',
});
assert.equal(deterministic_text_only_resolved_task._artifact_type, "view");
assert.equal(deterministic_text_only_resolved_task._action, "update");
assert.equal(deterministic_text_only_resolved_task._edit_action, "update");
assert.equal(deterministic_text_only_resolved_task._edit_target_id, undefined);
assert.equal(deterministic_text_only_resolved_task._edit_target_text, "Powered by Xpell AI");
assert.equal(deterministic_text_only_resolved_task._edit_replacement_text, "Powered by Xpell");
assert.equal(deterministic_text_only_resolved_task._edit_field, "_text");
const deterministic_text_only_view = {
  _id: "main",
  _type: "view",
  _children: [
    {
      _id: "powered-by-label",
      _type: "label",
      _text: "Powered by Xpell AI",
    },
  ],
};
assert.deepEqual(
  can_apply_deterministic_view_edit({
    _resolved_task: deterministic_text_only_resolved_task,
    _current_view: deterministic_text_only_view,
  }),
  {
    _eligible: true,
    _action: "update-text",
    _target_id: "powered-by-label",
    _field: "_text",
    _reason: "eligible_text_match",
  },
);
const deterministic_text_only_result =
  apply_deterministic_view_edit({
    _resolved_task: deterministic_text_only_resolved_task,
    _current_view: deterministic_text_only_view,
  });
assert.equal(deterministic_text_only_result._ok, true);
assert.equal(
  (deterministic_text_only_result._view as any)._children[0]._text,
  "Powered by Xpell",
);
assert.equal(
  deterministic_text_only_view._children[0]._text,
  "Powered by Xpell AI",
);
assert.equal(deterministic_text_only_result._mutation?._target_id, "powered-by-label");
assert.equal(deterministic_text_only_result._mutation?._previous_text, "Powered by Xpell AI");
assert.equal(deterministic_text_only_result._mutation?._replacement_text, "Powered by Xpell");
assert.equal(deterministic_text_only_result._mutation?._resolved_by, "text");
assert.equal(
  can_apply_deterministic_view_edit({
    _resolved_task: deterministic_text_only_resolved_task,
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "powered-by-label",
          _type: "label",
          _text: "Powered by Xpell",
        },
      ],
    },
  })._reason,
  "text_target_not_found",
);
const deterministic_text_only_ambiguous_view = {
  _id: "main",
  _type: "view",
  _children: [
    {
      _id: "powered-by-label-1",
      _type: "label",
      _text: "Powered by Xpell AI",
    },
    {
      _id: "powered-by-label-2",
      _type: "label",
      _text: "Powered by Xpell AI",
    },
  ],
};
assert.equal(
  can_apply_deterministic_view_edit({
    _resolved_task: deterministic_text_only_resolved_task,
    _current_view: deterministic_text_only_ambiguous_view,
  })._reason,
  "ambiguous_text_target",
);
assert.equal(
  apply_deterministic_view_edit({
    _resolved_task: deterministic_text_only_resolved_task,
    _current_view: deterministic_text_only_ambiguous_view,
  })._reason,
  "ambiguous_text_target",
);
const delete_view_resolved_task = resolve_xvibe_task({
  _prompt: "delete view main",
});
assert.equal(delete_view_resolved_task._artifact_type, "view");
assert.equal(delete_view_resolved_task._action, "delete");
assert.equal(delete_view_resolved_task._target_id, "main");

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
const missing_ops_module_route_result =
  await (new XVibeModule() as any).generate_artifact({
    _prompt: "Create server module aime-auth",
    _app_id: "phase2-module-test",
  });
assert.equal(missing_ops_module_route_result._ok, false);
assert.equal(
  missing_ops_module_route_result._error._code,
  "E_XVIBE_MODULE_OPS_REQUIRED",
);

const isolated_module_route = new XVibeModule();
(isolated_module_route as any).planner.plan_app = () => {
  throw new Error("module route must not call XVibePlanner");
};
(isolated_module_route as any).behavior_planner.infer_behavior_intent = () => {
  throw new Error("module route must not call VibeBehaviorPlanner");
};
(isolated_module_route as any).intent_planner.build_artifact_plan_from_intent = () => {
  throw new Error("module route must not call artifact planner");
};
let isolated_module_intent_plan: any;
(isolated_module_route as any).ensure_server_module_for_intent = async (input: any) => {
  isolated_module_intent_plan = input.intent_plan;
  return {
    _intent_plan: input.intent_plan,
    _module_name: input.intent_plan._module_name,
    _module_ops: input.intent_plan._module_ops,
    _created: false,
    _available: true,
  };
};
const isolated_module_route_result =
  await (isolated_module_route as any).generate_artifact({
    _prompt: "Create module aime-auth with _login",
    _app_id: "phase2-module-test",
  });
assert.equal(isolated_module_route_result._ok, true);
assert.equal(isolated_module_route_result._result._module_name, "aime-auth");
assert.deepEqual(isolated_module_route_result._result._module_ops, ["login"]);
assert.deepEqual(isolated_module_intent_plan._artifact_types, ["module"]);
assert.deepEqual(isolated_module_intent_plan._entities, []);
assert.deepEqual(isolated_module_intent_plan._actions, []);
assert.deepEqual(isolated_module_intent_plan._crud_ops, []);
assert.deepEqual(isolated_module_intent_plan._xui_objects, []);

const empty_module_spec_result = await (xvibe as any)._generate_module_spec({
  _params: {
    _prompt: "Create server module aime-auth",
  },
});
assert.equal(empty_module_spec_result._ok, true);
assert.equal(empty_module_spec_result._spec._name, "aime-auth");
assert.deepEqual(empty_module_spec_result._spec._ops, []);

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

const simple_label_runtime_skills = {
  _modules: [
    {
      _objects: [
        { _id: "view" },
        { _id: "style-sheet" },
        { _id: "label" },
      ],
    },
  ],
};
const simple_label_views: any[] = [];
let simple_label_final_prompt = "";
const original_execute_for_simple_label = (_x as any).execute;
const original_get_skills_for_simple_label = (_x as any).getSkills;
try {
  (xvibe as any).latest_runtime_skills = simple_label_runtime_skills;
  (_x as any).getSkills = () => simple_label_runtime_skills;
  (_x as any).execute = async (command: any) => {
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
      simple_label_final_prompt = String(command._params?._prompt ?? "");
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
                  _id: "hello-label",
                  _type: "label",
                  _text: "hello world",
                },
              ],
            },
          }),
        },
      };
    }

    if (command?._module === "server-xvm" && command?._op === "push_update") {
      simple_label_views.push(command._params?._view);
      return {
        _ok: true,
        _result: {
          _version: 2,
        },
      };
    }

    throw new Error(`Unexpected command ${JSON.stringify(command)}`);
  };

  const simple_label_result = await xvibe._generate({
    _params: {
      _prompt: 'create simple app with 1 view and label with "hello world" text',
      _app_id: "simple-label-app",
      _env: "test",
    },
  } as any) as any;

  assert.equal(simple_label_result._ok, true);
  assert.equal(simple_label_result._result._view_id, "main");
  assert.equal(simple_label_views.length, 1);
  assert.equal(simple_label_views[0]._id, "main");
  assert.notEqual(simple_label_views[0]._id, "and");
  assert.ok(simple_label_final_prompt.includes("- label"));
  assert.equal(simple_label_final_prompt.includes("- stack"), false);
  assert.equal(simple_label_final_prompt.includes("Prefer stack"), false);
  assert.equal(simple_label_final_prompt.includes("stack/card/grid"), false);
  assert.equal(simple_label_views[0]._children[0]._type, "label");
} finally {
  (_x as any).execute = original_execute_for_simple_label;
  (_x as any).getSkills = original_get_skills_for_simple_label;
}

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

const invalid_runtime_plan_command_validation = validate_generated_artifact({
  _artifact_type: "command",
  _artifact: {
    _module: "entity-client",
    _op: "unknown",
    _params: {},
  },
  _prompt: "Create command",
  _runtime_skills: phase4_runtime_skills,
  _runtime_plan: phase4_runtime_plan,
});
assert.equal(invalid_runtime_plan_command_validation._ok, false);
assert.ok(
  invalid_runtime_plan_command_validation._errors.some((error) =>
    error.includes("unknown op 'unknown' for runtime module 'entity-client'")
  ),
);

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

const refine_remove_intent_prompt = new VibePromptBuilder().build({
  prompt: 'remove button "logout" from view main',
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
      },
    ],
    diagnostics: [],
  },
  runtime_context: {
    _app_id: "app",
    _env: "default",
    _view_id: "main",
    _edit_intent: {
      _action: "remove",
      _target_id: "logout-button",
      _target_text: "logout",
    },
    _current_view: {
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "logout-button",
          _type: "button",
          _text: "Logout",
        },
      ],
    },
  },
});
assert.ok(refine_remove_intent_prompt.includes("VIEW EDIT INTENT:"));
assert.ok(refine_remove_intent_prompt.includes("- Action: remove"));
assert.ok(refine_remove_intent_prompt.includes("- Target id: logout-button"));
assert.ok(refine_remove_intent_prompt.includes("- Target text: logout"));
assert.ok(refine_remove_intent_prompt.includes("Remove this existing object from the view. Do not replace it."));
assert.ok(refine_remove_intent_prompt.includes("Do not delete the whole view."));
assert.ok(refine_remove_intent_prompt.includes("Do not create replacement nodes."));
assert.ok(refine_remove_intent_prompt.includes("Preserve all unrelated ids and children."));

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
const resolved_module_intent_plan =
  create_module_intent_plan_from_resolved_task(
    resolved_server_module_with_op_task,
    "Create module aime-auth with _login",
    empty_capabilities,
  );
assert.equal(resolved_module_intent_plan._intent_type, "module");
assert.deepEqual(resolved_module_intent_plan._artifact_types, ["module"]);
assert.equal(resolved_module_intent_plan._requires_module, true);
assert.equal(resolved_module_intent_plan._module_target, "server");
assert.equal(resolved_module_intent_plan._module_name, "aime-auth");
assert.deepEqual(resolved_module_intent_plan._module_ops, ["login"]);
assert.deepEqual(resolved_module_intent_plan._entities, []);
assert.deepEqual(resolved_module_intent_plan._actions, []);
assert.deepEqual(resolved_module_intent_plan._xui_objects, []);
assert.deepEqual(resolved_module_intent_plan._crud_ops, []);

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
assert.deepEqual(server_module_intent._module_ops, []);

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

async function read_selected_skill_ids(run_dir: string): Promise<string[]> {
  const selected_skills = JSON.parse(
    await readFile(path.join(run_dir, "selected-skills.json"), "utf-8"),
  );
  return Array.isArray(selected_skills._selected_skill_ids)
    ? selected_skills._selected_skill_ids
    : [];
}

const vibe_run_inspector_work_folder =
  await mkdtemp(path.join(tmpdir(), "xvibe-run-inspector-"));
try {
  const inspector_xvibe = new XVibeModule();
  const inspector_runs_dir =
    path.join(
      vibe_run_inspector_work_folder,
      "xvm",
      "apps",
      "test",
      "inspector-app",
      "vibe-runs",
    );
  const deterministic_run_dir =
    path.join(inspector_runs_dir, "2026-01-01T00-00-00-000Z_gen-1");
  const fallback_run_dir =
    path.join(inspector_runs_dir, "2026-01-02T00-00-00-000Z_gen-2");
  const write_json = async (file_path: string, value: unknown) =>
    writeFile(file_path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");

  await mkdir(deterministic_run_dir, { recursive: true });
  await mkdir(fallback_run_dir, { recursive: true });
  await write_json(path.join(deterministic_run_dir, "request.json"), {
    _generation_id: "gen-1",
    _app_id: "inspector-app",
    _env: "test",
    _mode: "refine",
    _artifact_type: "view",
  });
  await write_json(path.join(deterministic_run_dir, "resolved-task.json"), {
    _artifact_type: "view",
    _action: "update",
  });
  await write_json(path.join(deterministic_run_dir, "deterministic-mutation.json"), {
    _eligible: true,
    _reason: "eligible",
    _action: "remove-object",
    _target_id: "button-1",
  });
  await write_json(path.join(deterministic_run_dir, "result.json"), {
    _artifact_type: "view",
    _view_id: "main",
    _success: true,
    _deterministic: true,
    _mutation_action: "remove-object",
  });
  await writeFile(path.join(deterministic_run_dir, "prompt.txt"), "remove button", "utf-8");

  await write_json(path.join(fallback_run_dir, "request.json"), {
    _generation_id: "gen-2",
    _app_id: "inspector-app",
    _env: "test",
    _mode: "refine",
    _artifact_type: "view",
  });
  await write_json(path.join(fallback_run_dir, "deterministic-mutation.json"), {
    _eligible: false,
    _reason: "text_mismatch",
  });
  await write_json(path.join(fallback_run_dir, "result.json"), {
    _artifact_type: "view",
    _view_id: "main",
    _success: true,
  });
  await write_json(path.join(fallback_run_dir, "runtime-context.json"), {
    _view_id: "main",
  });
  await writeFile(path.join(fallback_run_dir, "final-prompt.txt"), "final prompt", "utf-8");

  (_x as any).getModule = (name: string) =>
    name === "server-xvm"
      ? { _work_folder: vibe_run_inspector_work_folder }
      : typeof original_get_module === "function"
        ? original_get_module.call(_x, name)
        : undefined;

  const latest_run = await (inspector_xvibe as any)._get_latest_run({
    _params: {
      _app_id: "inspector-app",
      _env: "test",
    },
  });
  assert.equal(latest_run._ok, true);
  assert.equal(latest_run._run_id, "2026-01-02T00-00-00-000Z_gen-2");
  assert.equal(
    latest_run._run_dir,
    "xvm/apps/test/inspector-app/vibe-runs/2026-01-02T00-00-00-000Z_gen-2",
  );
  assert.equal(path.isAbsolute(latest_run._run_dir), false);
  assert.equal(latest_run._run_dir.includes(vibe_run_inspector_work_folder), false);
  assert.equal(latest_run._generation_id, "gen-2");
  assert.equal(latest_run._files["final-prompt.txt"], "final prompt");
  assert.equal(latest_run._files["resolved-task.json"], undefined);
  assert.equal(latest_run._summary._status, "fallback");
  assert.equal(latest_run._summary._deterministic_eligible, false);
  assert.equal(latest_run._summary._deterministic_reason, "text_mismatch");
  assert.equal(latest_run._summary._has_final_prompt, true);

  const deterministic_run = await (inspector_xvibe as any)._get_latest_run({
    _params: {
      _app_id: "inspector-app",
      _env: "test",
      _generation_id: "gen-1",
    },
  });
  assert.equal(deterministic_run._ok, true);
  assert.equal(deterministic_run._generation_id, "gen-1");
  assert.equal(deterministic_run._summary._status, "deterministic");
  assert.equal(deterministic_run._summary._deterministic_eligible, true);
  assert.equal(deterministic_run._files["prompt.txt"], "remove button");

  const invalid_generation_run = await (inspector_xvibe as any)._get_latest_run({
    _params: {
      _app_id: "inspector-app",
      _env: "test",
      _generation_id: "../gen-1",
    },
  });
  assert.equal(invalid_generation_run._ok, false);
  assert.equal(invalid_generation_run._error._code, "E_XVIBE_INVALID_GENERATION_ID");

  const invalid_app_run = await (inspector_xvibe as any)._get_latest_run({
    _params: {
      _app_id: "../inspector-app",
      _env: "test",
    },
  });
  assert.equal(invalid_app_run._ok, false);
  assert.equal(invalid_app_run._error._code, "E_XVIBE_INVALID_APP_ID");

  const studio = new XStudioModule();
  let inspector_command: any;
  (_x as any).execute = async (command: any) => {
    inspector_command = command;
    return latest_run;
  };

  const studio_inspector = await (studio as any)._inspect_latest_run({
    _params: {
      _app_id: "inspector-app",
      _env: "test",
      _generation_id: "gen-2",
    },
  });
  assert.equal(inspector_command._module, "xvibe");
  assert.equal(inspector_command._op, "get-latest-run");
  assert.equal(inspector_command._params._generation_id, "gen-2");
  assert.equal(studio_inspector._ok, true);
  assert.equal(studio_inspector._inspector._button_label, "Inspect Last Run");
  assert.equal(studio_inspector._inspector._status, "fallback");
  assert.ok(studio_inspector._inspector._summary_text.includes("generation_id: gen-2"));
  assert.ok(studio_inspector._inspector._summary_text.includes("deterministic eligible: false"));
  assert.ok(
    studio_inspector._inspector._sections
      .some((section: any) => section._label === "Runtime Context"),
  );
} finally {
  (_x as any).execute = original_execute;
  (_x as any).getModule = original_get_module;
  await rm(vibe_run_inspector_work_folder, { recursive: true, force: true });
}

const app_artifacts_work_folder =
  await mkdtemp(path.join(tmpdir(), "xstudio-app-artifacts-"));
try {
  const app_artifacts_app_id = "explorer-app";
  const app_artifacts_env = "test";
  const app_artifacts_app_dir = path.join(
    app_artifacts_work_folder,
    "xvm",
    "apps",
    app_artifacts_env,
    app_artifacts_app_id,
  );
  const app_artifacts_views_dir = path.join(app_artifacts_app_dir, "views");
  const app_artifacts_flows_dir = path.join(app_artifacts_app_dir, "flows");
  const app_artifacts_entities_dir = path.join(app_artifacts_app_dir, "entities");
  const app_artifacts_registry_dir = path.join(
    app_artifacts_work_folder,
    "generated",
    "xmodules",
  );
  const app_artifacts_module_path = path.join(app_artifacts_registry_dir, "calc");
  const app_artifacts_files = [
    path.join(app_artifacts_app_dir, "app.json"),
    path.join(app_artifacts_views_dir, "main.json"),
    path.join(app_artifacts_flows_dir, "signup.json"),
    path.join(app_artifacts_entities_dir, "users.json"),
    path.join(app_artifacts_registry_dir, "registry.json"),
  ];

  await mkdir(app_artifacts_views_dir, { recursive: true });
  await mkdir(app_artifacts_flows_dir, { recursive: true });
  await mkdir(app_artifacts_entities_dir, { recursive: true });
  await mkdir(app_artifacts_registry_dir, { recursive: true });
  await writeFile(
    app_artifacts_files[0],
    JSON.stringify({
      _app_id: app_artifacts_app_id,
      _env: app_artifacts_env,
      _meta: {
        _version: 1,
        _entry_view_id: "main",
      },
      _config: {},
    }, null, 2),
  );
  await writeFile(
    app_artifacts_files[1],
    JSON.stringify({
      _id: "main",
      _type: "view",
      _title: "Main View",
      _children: [],
    }, null, 2),
  );
  await writeFile(
    app_artifacts_files[2],
    JSON.stringify({
      _id: "signup",
      _title: "Signup Flow",
      _steps: [],
    }, null, 2),
  );
  await writeFile(
    app_artifacts_files[3],
    JSON.stringify({
      _id: "users",
      _title: "Users",
      _schema: {},
    }, null, 2),
  );
  await writeFile(
    app_artifacts_files[4],
    JSON.stringify({
      _version: 1,
      _modules: {
        calc: {
          _id: "calc",
          _name: "calc",
          _target: "server",
          _artifact_path: app_artifacts_module_path,
          _manifest_file: path.join(app_artifacts_module_path, "manifest.json"),
          _module_file: path.join(app_artifacts_module_path, "module.js"),
          _manifest_sha256: "manifest-hash",
          _module_sha256: "module-hash",
          _ops: ["add"],
          _autoload: true,
          _state: "implemented",
          _implementation_complete: true,
          _created_by: "module-creator",
          _created_at: 1,
          _updated_at: 1,
        },
      },
    }, null, 2),
  );

  const app_artifacts_server_xvm =
    new ServerXVMModule({ _work_folder: app_artifacts_work_folder });
  const app_artifacts_studio = new XStudioModule();
  const original_app_artifacts_execute = (_x as any).execute;
  (_x as any).execute = async (command: any) => {
    if (command?._module === "entity-manager" && command?._op === "register") {
      return { _ok: true, _result: { _registered: true } };
    }

    if (command?._module === "server-xvm") {
      const method_name = `_${String(command?._op ?? "").replace(/-/gu, "_")}`;
      const method = (app_artifacts_server_xvm as any)[method_name];
      if (typeof method === "function") {
        return method.call(app_artifacts_server_xvm, command);
      }
    }

    return original_app_artifacts_execute.call(_x, command);
  };

  try {
    await app_artifacts_server_xvm.init_on_boot();
    const app_artifacts_before = new Map(
      await Promise.all(
        app_artifacts_files.map(async (file) => [
          file,
          {
            content: await readFile(file, "utf-8"),
            mtimeMs: (await stat(file)).mtimeMs,
          },
        ] as const),
      ),
    );

    const app_artifacts_result = await (app_artifacts_studio as any)._list_app_artifacts({
      _params: {
        _app_id: app_artifacts_app_id,
        _env: app_artifacts_env,
      },
    });

    assert.equal(app_artifacts_result._ok, true);
    assert.equal(app_artifacts_result._app_id, app_artifacts_app_id);
    assert.equal(app_artifacts_result._env, app_artifacts_env);
    assert.deepEqual(app_artifacts_result._artifacts._views, [
      {
        _id: "main",
        _title: "Main View",
        _path: "views/main.json",
      },
    ]);
    assert.deepEqual(app_artifacts_result._artifacts._flows, [
      {
        _id: "signup",
        _title: "Signup Flow",
        _path: "flows/signup.json",
      },
    ]);
    assert.deepEqual(app_artifacts_result._artifacts._entities, [
      {
        _id: "users",
        _path: "entities/users.json",
      },
    ]);
    assert.deepEqual(app_artifacts_result._artifacts._modules, [
      {
        _id: "calc",
        _title: "calc",
        _path: app_artifacts_module_path,
        _enabled: true,
      },
    ]);

    for (const file of app_artifacts_files) {
      const before = app_artifacts_before.get(file);
      assert.ok(before);
      assert.equal(await readFile(file, "utf-8"), before.content);
      assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
    }

    const invalid_app_artifacts_result =
      await (app_artifacts_studio as any)._list_app_artifacts({
        _params: {
          _app_id: "../explorer-app",
          _env: app_artifacts_env,
        },
      });
    assert.equal(invalid_app_artifacts_result._ok, false);
    assert.equal(invalid_app_artifacts_result._error._code, "E_STUDIO_INVALID_APP_ID");

    const invalid_env_artifacts_result =
      await (app_artifacts_studio as any)._list_app_artifacts({
        _params: {
          _app_id: app_artifacts_app_id,
          _env: "../test",
        },
      });
    assert.equal(invalid_env_artifacts_result._ok, false);
    assert.equal(invalid_env_artifacts_result._error._code, "E_STUDIO_INVALID_ENV");
  } finally {
    (_x as any).execute = original_app_artifacts_execute;
  }
} finally {
  await rm(app_artifacts_work_folder, { recursive: true, force: true });
}

const missing_app_artifacts_work_folder =
  await mkdtemp(path.join(tmpdir(), "xstudio-missing-app-artifacts-"));
try {
  const missing_app_artifacts_app_id = "empty-app";
  const missing_app_artifacts_env = "test";
  const missing_app_artifacts_app_dir = path.join(
    missing_app_artifacts_work_folder,
    "xvm",
    "apps",
    missing_app_artifacts_env,
    missing_app_artifacts_app_id,
  );
  await mkdir(missing_app_artifacts_app_dir, { recursive: true });
  await writeFile(
    path.join(missing_app_artifacts_app_dir, "app.json"),
    JSON.stringify({
      _app_id: missing_app_artifacts_app_id,
      _env: missing_app_artifacts_env,
      _meta: {
        _version: 1,
        _entry_view_id: "main",
      },
      _config: {},
    }, null, 2),
  );

  const missing_app_artifacts_server_xvm =
    new ServerXVMModule({ _work_folder: missing_app_artifacts_work_folder });
  const missing_app_artifacts_studio = new XStudioModule();
  const original_missing_app_artifacts_execute = (_x as any).execute;
  (_x as any).execute = async (command: any) => {
    if (command?._module === "server-xvm") {
      const method_name = `_${String(command?._op ?? "").replace(/-/gu, "_")}`;
      const method = (missing_app_artifacts_server_xvm as any)[method_name];
      if (typeof method === "function") {
        return method.call(missing_app_artifacts_server_xvm, command);
      }
    }

    return original_missing_app_artifacts_execute.call(_x, command);
  };

  try {
    await missing_app_artifacts_server_xvm.init_on_boot();
    const missing_app_artifacts_result =
      await (missing_app_artifacts_studio as any)._list_app_artifacts({
        _params: {
          _app_id: missing_app_artifacts_app_id,
          _env: missing_app_artifacts_env,
        },
      });

    assert.equal(missing_app_artifacts_result._ok, true);
    assert.deepEqual(missing_app_artifacts_result._artifacts, {
      _views: [],
      _flows: [],
      _entities: [],
      _modules: [],
    });
  } finally {
    (_x as any).execute = original_missing_app_artifacts_execute;
  }
} finally {
  await rm(missing_app_artifacts_work_folder, { recursive: true, force: true });
}

const create_view_work_folder =
  await mkdtemp(path.join(tmpdir(), "server-xvm-create-view-"));
try {
  const create_view_server_xvm =
    new ServerXVMModule({ _work_folder: create_view_work_folder });
  const create_view_app_id = "create-view-app";
  const create_view_env = "test";
  const create_view_dir = path.join(
    create_view_work_folder,
    "xvm",
    "apps",
    create_view_env,
    create_view_app_id,
    "views",
  );

  await (create_view_server_xvm as any)._create_app({
    _params: {
      _app_id: create_view_app_id,
      _env: create_view_env,
    },
  });

  const blank_view_path = path.join(create_view_dir, "blank_view.json");
  const blank_view_res = await (create_view_server_xvm as any)._create_view({
    _params: {
      _app_id: create_view_app_id,
      _env: create_view_env,
      _view_id: "blank_view",
      _template: "blank",
    },
  });
  assert.equal(blank_view_res._ok, true);
  assert.equal(blank_view_res._view_id, "blank_view");
  assert.equal(blank_view_res._path, blank_view_path);
  assert.deepEqual(blank_view_res._view, {
    _id: "blank_view",
    _type: "view",
    _children: [],
  });
  assert.deepEqual(
    JSON.parse(await readFile(blank_view_path, "utf-8")),
    blank_view_res._view,
  );
  await assert.rejects(
    access(path.join(
      create_view_work_folder,
      "system-xapps",
      "view-starters",
      "blank",
      "view.json",
    )),
  );

  const page_view_path = path.join(create_view_dir, "account-page.json");
  const page_view_res = await (create_view_server_xvm as any)._create_view({
    _params: {
      _app_id: create_view_app_id,
      _env: create_view_env,
      _view_id: "account-page",
      _title: "Account Page",
      _template: "page",
    },
  });
  assert.equal(page_view_res._ok, true);
  assert.equal(page_view_res._path, page_view_path);
  assert.deepEqual(page_view_res._view, {
    _id: "account-page",
    _type: "view",
    _children: [
      {
        _id: "account-page-root",
        _type: "stack",
        class: "page-shell",
        _children: [
          {
            _id: "account-page-title",
            _type: "label",
            _text: "Account Page",
          },
        ],
      },
    ],
  });
  assert.deepEqual(
    JSON.parse(await readFile(page_view_path, "utf-8")),
    page_view_res._view,
  );

  const component_view_path = path.join(create_view_dir, "profile_card.json");
  const component_view_res = await (create_view_server_xvm as any)._create_view({
    _params: {
      _app_id: create_view_app_id,
      _env: create_view_env,
      _view_id: "profile_card",
      _template: "component",
    },
  });
  assert.equal(component_view_res._ok, true);
  assert.equal(component_view_res._path, component_view_path);
  assert.deepEqual(component_view_res._view, {
    _id: "profile_card",
    _type: "view",
    class: "xvm-component-view",
    _children: [],
  });
  assert.deepEqual(
    JSON.parse(await readFile(component_view_path, "utf-8")),
    component_view_res._view,
  );

  await assert.rejects(
    (create_view_server_xvm as any)._create_view({
      _params: {
        _app_id: create_view_app_id,
        _env: create_view_env,
        _view_id: "blank_view",
        _template: "blank",
      },
    }),
    (error: any) => error?._code === "E_XVM_VIEW_ALREADY_EXISTS",
  );

  await assert.rejects(
    (create_view_server_xvm as any)._create_view({
      _params: {
        _app_id: create_view_app_id,
        _env: create_view_env,
        _view_id: "../unsafe",
        _template: "blank",
      },
    }),
    (error: any) => error?._code === "E_XVM_INVALID_VIEW_ID",
  );

  await assert.rejects(
    (create_view_server_xvm as any)._create_view({
      _params: {
        _app_id: create_view_app_id,
        _env: create_view_env,
        _view_id: "UnsafeUpper",
        _template: "blank",
      },
    }),
    (error: any) => error?._code === "E_XVM_INVALID_VIEW_ID",
  );

  await assert.rejects(
    (create_view_server_xvm as any)._create_view({
      _params: {
        _app_id: create_view_app_id,
        _env: create_view_env,
        _view_id: "unsafe-template-view",
        _template: "../page",
      },
    }),
    (error: any) => error?._code === "E_XVM_INVALID_VIEW_TEMPLATE",
  );
  await assert.rejects(
    access(path.join(create_view_dir, "unsafe-template-view.json")),
  );

  const create_view_list_res =
    await (create_view_server_xvm as any)._list_views({
      _params: {
        _app_id: create_view_app_id,
        _env: create_view_env,
      },
    });
  const create_view_list_ids =
    create_view_list_res._result._views.map((view: any) => view._id);
  assert.ok(create_view_list_ids.includes("blank_view"));
  assert.ok(create_view_list_ids.includes("account-page"));
  assert.ok(create_view_list_ids.includes("profile_card"));
} finally {
  await rm(create_view_work_folder, { recursive: true, force: true });
}

const view_starter_override_work_folder =
  await mkdtemp(path.join(tmpdir(), "server-xvm-view-starter-override-"));
try {
  const view_starter_override_server_xvm =
    new ServerXVMModule({ _work_folder: view_starter_override_work_folder });
  const view_starter_override_app_id = "starter-override-app";
  const view_starter_override_env = "test";
  const view_starter_override_file = path.join(
    view_starter_override_work_folder,
    "system-xapps",
    "view-starters",
    "page",
    "view.json",
  );

  await mkdir(path.dirname(view_starter_override_file), { recursive: true });
  await writeFile(
    view_starter_override_file,
    JSON.stringify({
      _id: "{{view_id}}",
      _type: "view",
      _children: [
        {
          _id: "{{view_id}}-override",
          _type: "label",
          _text: "{{title}} override",
        },
      ],
    }, null, 2),
    "utf-8",
  );

  await (view_starter_override_server_xvm as any)._create_app({
    _params: {
      _app_id: view_starter_override_app_id,
      _env: view_starter_override_env,
    },
  });

  const override_view_res =
    await (view_starter_override_server_xvm as any)._create_view({
      _params: {
        _app_id: view_starter_override_app_id,
        _env: view_starter_override_env,
        _view_id: "override-page",
        _title: "Work Starter",
        _template: "page",
      },
    });

  assert.equal(override_view_res._ok, true);
  assert.deepEqual(override_view_res._view, {
    _id: "override-page",
    _type: "view",
    _children: [
      {
        _id: "override-page-override",
        _type: "label",
        _text: "Work Starter override",
      },
    ],
  });
} finally {
  await rm(view_starter_override_work_folder, { recursive: true, force: true });
}

const cwd_fallback_work_folder =
  await mkdtemp(path.join(tmpdir(), "server-xvm-cwd-fallback-"));
const cwd_fallback_outside_dir =
  await mkdtemp(path.join(tmpdir(), "server-xvm-outside-cwd-"));
const original_cwd_for_view_starter = process.cwd();
try {
  process.chdir(cwd_fallback_outside_dir);

  const cwd_fallback_server_xvm =
    new ServerXVMModule({ _work_folder: cwd_fallback_work_folder });
  const cwd_fallback_app_id = "cwd-fallback-app";
  const cwd_fallback_env = "test";

  await (cwd_fallback_server_xvm as any)._create_app({
    _params: {
      _app_id: cwd_fallback_app_id,
      _env: cwd_fallback_env,
    },
  });

  const cwd_fallback_view_res =
    await (cwd_fallback_server_xvm as any)._create_view({
      _params: {
        _app_id: cwd_fallback_app_id,
        _env: cwd_fallback_env,
        _view_id: "cwd-fallback",
        _template: "blank",
      },
    });

  assert.equal(cwd_fallback_view_res._ok, true);
  assert.deepEqual(cwd_fallback_view_res._view, {
    _id: "cwd-fallback",
    _type: "view",
    _children: [],
  });
} finally {
  process.chdir(original_cwd_for_view_starter);
  await rm(cwd_fallback_work_folder, { recursive: true, force: true });
  await rm(cwd_fallback_outside_dir, { recursive: true, force: true });
}

const missing_view_starter_work_folder =
  await mkdtemp(path.join(tmpdir(), "server-xvm-missing-view-starter-"));
try {
  const missing_view_starter_package_root = path.join(
    missing_view_starter_work_folder,
    "missing-package-system-xapps",
  );
  const missing_view_starter_server_xvm =
    new ServerXVMModule({
      _work_folder: missing_view_starter_work_folder,
      _package_system_xapps_path: missing_view_starter_package_root,
    });
  const missing_view_starter_app_id = "missing-starter-app";
  const missing_view_starter_env = "test";
  const missing_view_starter_work_path = path.join(
    missing_view_starter_work_folder,
    "system-xapps",
    "view-starters",
    "blank",
    "view.json",
  );
  const missing_view_starter_package_path = path.join(
    missing_view_starter_package_root,
    "view-starters",
    "blank",
    "view.json",
  );

  await (missing_view_starter_server_xvm as any)._create_app({
    _params: {
      _app_id: missing_view_starter_app_id,
      _env: missing_view_starter_env,
    },
  });

  await assert.rejects(
    (missing_view_starter_server_xvm as any)._create_view({
      _params: {
        _app_id: missing_view_starter_app_id,
        _env: missing_view_starter_env,
        _view_id: "missing-starter-view",
        _template: "blank",
      },
    }),
    (error: any) =>
      error?._code === "E_XVM_VIEW_STARTER_NOT_FOUND" &&
      error?._meta?._template === "blank" &&
      error?._meta?._work_path === missing_view_starter_work_path &&
      error?._meta?._package_path === missing_view_starter_package_path,
  );
  await assert.rejects(
    access(path.join(
      missing_view_starter_work_folder,
      "xvm",
      "apps",
      missing_view_starter_env,
      missing_view_starter_app_id,
      "views",
      "missing-starter-view.json",
    )),
  );
} finally {
  await rm(missing_view_starter_work_folder, { recursive: true, force: true });
}

const view_edit_refine_work_folder =
  await mkdtemp(path.join(tmpdir(), "xvibe-view-edit-refine-"));
const original_view_edit_log = _xlog.log;
try {
  const runtime_skills_for_view_edit = {
    _modules: [
      {
        _objects: [
          { _id: "view" },
          { _id: "button" },
          { _id: "label" },
          { _id: "card" },
          { _id: "xsection" },
          { _id: "style-sheet" },
        ],
      },
    ],
  };
  let current_view_for_remove: any = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "logout-button",
        _type: "button",
        _text: "Logout",
      },
      {
        _id: "play-button",
        _type: "button",
        _text: "▶ Start Music",
      },
      {
        _id: "powered-label",
        _type: "label",
        _text: "Powered by Xpell",
      },
    ],
  };
  let referenced_views_for_remove: Record<string, any> = {};
  let push_update_count = 0;
  let xai_generate_count = 0;
  let throw_on_xai_generate = false;
  const pushed_views_by_generation_id = new Map<string, any>();
  const planning_cycle_logs: any[] = [];

  (_xlog as any).log = (message: string, data?: any) => {
    if (message === "[xvibe] planning cycle") {
      planning_cycle_logs.push(data);
    }
    return original_view_edit_log.call(_xlog, message, data);
  };
  const planning_cycle_counts_for_generation = (generation_id: string) =>
    planning_cycle_logs
      .filter((entry) => entry?._generation_id === generation_id)
      .map((entry) => entry._count);

  (xvibe as any).latest_runtime_skills = runtime_skills_for_view_edit;
  (_x as any).getModule = (name: string) =>
    name === "server-xvm"
      ? { _work_folder: view_edit_refine_work_folder }
      : typeof original_get_module === "function"
        ? original_get_module.call(_x, name)
        : undefined;
  (_x as any).getSkills = () => runtime_skills_for_view_edit;
  (_x as any).execute = async (command: any) => {
    if (command?._module === "server-xvm" && command?._op === "get_app") {
      return {
        _ok: true,
        _result: {
          _view_ids: ["main", ...Object.keys(referenced_views_for_remove)],
          _flow_ids: [],
          _entity_ids: [],
        },
      };
    }

    if (command?._module === "server-xvm" && command?._op === "get_view") {
      const view_id = command?._params?._view_id ?? "main";
      const view =
        view_id === "main"
          ? current_view_for_remove
          : referenced_views_for_remove[view_id];
      if (!view) {
        throw new Error(`View not found: ${view_id}`);
      }

      return {
        _ok: true,
        _result: {
          _view: view,
        },
      };
    }

    if (command?._module === "xai" && command?._op === "generate") {
      xai_generate_count += 1;
      if (throw_on_xai_generate) {
        throw new Error("xai.generate should not be called for deterministic view edit");
      }
      const generated_prompt =
        typeof command?._params?._prompt === "string" ? command._params._prompt : "";
      if (/\b(?:background color|font size|text color|color|width|height|padding|margin|border radius)\b/iu.test(generated_prompt)) {
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
                    _id: "fallback-style",
                    _type: "style-sheet",
                    _rules: {},
                  },
                  {
                    _id: "powered-label",
                    _type: "label",
                    _text: "Powered by Xpell",
                  },
                ],
              },
            }),
          },
        };
      }
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
                  _id: "powered-label",
                  _type: "label",
                  _text: "Powered by Xpell",
                },
              ],
            },
          }),
        },
      };
    }

    if (command?._module === "server-xvm" && command?._op === "push_update") {
      push_update_count += 1;
      if (typeof command._params?._generation_id === "string") {
        pushed_views_by_generation_id.set(
          command._params._generation_id,
          command._params?._view,
        );
      }
      return {
        _ok: true,
        _result: {
          _view_id: command._params?._view?._id,
          _version: push_update_count,
        },
      };
    }

    throw new Error(`Unexpected command ${JSON.stringify(command)}`);
  };

  const remove_button_push_count_before = push_update_count;
  const remove_button_xai_count_before = xai_generate_count;
  const remove_button_result = await (xvibe as any).generate_artifact({
    _prompt: 'remove button "logout" from view main',
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-remove",
  });
  assert.equal(remove_button_result._ok, true);
  assert.equal(remove_button_result._result._deterministic, true);
  assert.equal(remove_button_result._result._mutation_action, "remove-object");
  assert.equal(remove_button_result._result._mutation_target_id, "logout-button");
  assert.deepEqual(planning_cycle_counts_for_generation("view-edit-remove"), [1]);
  assert.equal(xai_generate_count, remove_button_xai_count_before);
  assert.equal(push_update_count, remove_button_push_count_before + 1);
  const remove_button_pushed_view =
    pushed_views_by_generation_id.get("view-edit-remove");
  assert.deepEqual(
    remove_button_pushed_view._children.map((child: any) => child._id),
    ["play-button", "powered-label"],
  );
  const remove_button_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const remove_button_mutation_json = JSON.parse(
    await readFile(path.join(remove_button_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(remove_button_mutation_json._action, "remove-object");
  assert.equal(remove_button_mutation_json._target_id, "logout-button");
  assert.equal(remove_button_mutation_json._resolved_by, "normalized_text");
  await assert.rejects(
    readFile(path.join(remove_button_run_dir, "final-prompt.txt"), "utf-8"),
  );
  const remove_button_runtime_context = JSON.parse(
    await readFile(path.join(remove_button_run_dir, "runtime-context.json"), "utf-8"),
  );
  assert.equal(remove_button_runtime_context._edit_intent._action, "remove");
  assert.equal(remove_button_runtime_context._edit_intent._target_id, "logout-button");
  assert.equal(remove_button_runtime_context._edit_intent._target_text, "logout");
  const remove_button_selected_ids =
    await read_selected_skill_ids(remove_button_run_dir);
  assert.ok(remove_button_selected_ids.includes("button"));
  assert.equal(remove_button_selected_ids.includes("xui-flow-trigger"), false);
  assert.equal(remove_button_selected_ids.includes("xfm-flow"), false);

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
      },
      {
        _id: "pause-button",
        _type: "button",
        _text: "Pause",
      },
      {
        _id: "next-button",
        _type: "button",
        _text: "Next",
      },
    ],
  };
  const deterministic_remove_by_id_push_count_before = push_update_count;
  const deterministic_remove_by_id_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_remove_by_id_result = await (xvibe as any).generate_artifact({
    _prompt: "remove pause-button from view main",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-remove-by-id",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_remove_by_id_result._ok, true);
  assert.equal(deterministic_remove_by_id_result._result._deterministic, true);
  assert.equal(deterministic_remove_by_id_result._result._mutation_action, "remove-object");
  assert.equal(deterministic_remove_by_id_result._result._mutation_target_id, "pause-button");
  assert.equal(xai_generate_count, deterministic_remove_by_id_xai_count_before);
  assert.equal(push_update_count, deterministic_remove_by_id_push_count_before + 1);
  const deterministic_remove_by_id_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-remove-by-id");
  assert.deepEqual(
    deterministic_remove_by_id_pushed_view._children.map((child: any) => child._id),
    ["play-button", "next-button"],
  );
  const deterministic_remove_by_id_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_remove_by_id_result_json = JSON.parse(
    await readFile(path.join(deterministic_remove_by_id_run_dir, "result.json"), "utf-8"),
  );
  assert.equal(deterministic_remove_by_id_result_json._deterministic, true);
  assert.equal(deterministic_remove_by_id_result_json._mutation_action, "remove-object");
  assert.equal(deterministic_remove_by_id_result_json._mutation_target_id, "pause-button");
  await assert.rejects(
    readFile(path.join(deterministic_remove_by_id_run_dir, "final-prompt.txt"), "utf-8"),
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
      },
      {
        _id: "button-1",
        _type: "button",
        _text: "Pause",
      },
      {
        _id: "next-button",
        _type: "button",
        _text: "Next",
      },
    ],
  };
  const deterministic_remove_button_id_phrase_push_count_before = push_update_count;
  const deterministic_remove_button_id_phrase_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_remove_button_id_phrase_result = await (xvibe as any).generate_artifact({
    _prompt: "Update main view only. Remove button id button-1. Do not modify anything else.",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-remove-button-id-phrase",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_remove_button_id_phrase_result._ok, true);
  assert.equal(deterministic_remove_button_id_phrase_result._result._deterministic, true);
  assert.equal(deterministic_remove_button_id_phrase_result._result._mutation_action, "remove-object");
  assert.equal(deterministic_remove_button_id_phrase_result._result._mutation_target_id, "button-1");
  assert.equal(xai_generate_count, deterministic_remove_button_id_phrase_xai_count_before);
  assert.equal(push_update_count, deterministic_remove_button_id_phrase_push_count_before + 1);
  const deterministic_remove_button_id_phrase_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-remove-button-id-phrase");
  assert.deepEqual(
    deterministic_remove_button_id_phrase_pushed_view._children.map((child: any) => child._id),
    ["play-button", "next-button"],
  );
  const deterministic_remove_button_id_phrase_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_remove_button_id_phrase_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_remove_button_id_phrase_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_remove_button_id_phrase_mutation_json._action, "remove-object");
  assert.equal(deterministic_remove_button_id_phrase_mutation_json._target_id, "button-1");
  assert.equal(deterministic_remove_button_id_phrase_mutation_json._resolved_by, "id");
  const deterministic_remove_button_id_phrase_runtime_context = JSON.parse(
    await readFile(path.join(deterministic_remove_button_id_phrase_run_dir, "runtime-context.json"), "utf-8"),
  );
  assert.equal(deterministic_remove_button_id_phrase_runtime_context._edit_intent._action, "remove");
  assert.equal(deterministic_remove_button_id_phrase_runtime_context._edit_intent._target_id, "button-1");
  assert.equal(deterministic_remove_button_id_phrase_runtime_context._edit_intent._target_type, "button");
  await assert.rejects(
    readFile(path.join(deterministic_remove_button_id_phrase_run_dir, "final-prompt.txt"), "utf-8"),
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "pause-button",
        _type: "button",
        _text: "Pause",
      },
      {
        _id: "next-button",
        _type: "button",
        _text: "Next",
      },
    ],
  };
  const deterministic_remove_by_text_push_count_before = push_update_count;
  const deterministic_remove_by_text_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_remove_by_text_result = await (xvibe as any).generate_artifact({
    _prompt: 'remove button "Pause" from view main',
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-remove-by-text",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_remove_by_text_result._ok, true);
  assert.equal(deterministic_remove_by_text_result._result._deterministic, true);
  assert.equal(deterministic_remove_by_text_result._result._mutation_action, "remove-object");
  assert.equal(deterministic_remove_by_text_result._result._mutation_target_id, "pause-button");
  assert.equal(xai_generate_count, deterministic_remove_by_text_xai_count_before);
  assert.equal(push_update_count, deterministic_remove_by_text_push_count_before + 1);
  const deterministic_remove_by_text_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-remove-by-text");
  assert.deepEqual(
    deterministic_remove_by_text_pushed_view._children.map((child: any) => child._id),
    ["next-button"],
  );
  const deterministic_remove_by_text_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_remove_by_text_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_remove_by_text_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_remove_by_text_mutation_json._action, "remove-object");
  assert.equal(deterministic_remove_by_text_mutation_json._target_id, "pause-button");
  assert.equal(deterministic_remove_by_text_mutation_json._resolved_by, "text");
  await assert.rejects(
    readFile(path.join(deterministic_remove_by_text_run_dir, "final-prompt.txt"), "utf-8"),
  );

  referenced_views_for_remove = {
    "page-toolbar": {
      _id: "page-toolbar",
      _type: "view",
      _children: [
        {
          _id: "open-studio-button",
          _type: "button",
          _text: "Open Studio",
        },
        {
          _id: "settings-button",
          _type: "button",
          _text: "Settings",
        },
      ],
    },
  };
  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "toolbar-ref",
        _type: "xvm-view",
        _view_id: "page-toolbar",
      },
    ],
  };
  const deterministic_ref_remove_push_count_before = push_update_count;
  const deterministic_ref_remove_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_ref_remove_result = await (xvibe as any).generate_artifact({
    _prompt: 'Update main view only. Remove button "Open Studio". Do not modify anything else.',
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-ref-remove",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_ref_remove_result._ok, true);
  assert.equal(deterministic_ref_remove_result._result._deterministic, true);
  assert.equal(deterministic_ref_remove_result._result._artifact_id, "page-toolbar");
  assert.equal(deterministic_ref_remove_result._result._source_view_id, "page-toolbar");
  assert.equal(deterministic_ref_remove_result._result._requested_view_id, "main");
  assert.equal(deterministic_ref_remove_result._result._mutation_action, "remove-object");
  assert.equal(deterministic_ref_remove_result._result._mutation_target_id, "open-studio-button");
  assert.equal(xai_generate_count, deterministic_ref_remove_xai_count_before);
  assert.equal(push_update_count, deterministic_ref_remove_push_count_before + 1);
  const deterministic_ref_remove_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-ref-remove");
  assert.equal(deterministic_ref_remove_pushed_view._id, "page-toolbar");
  assert.deepEqual(
    deterministic_ref_remove_pushed_view._children.map((child: any) => child._id),
    ["settings-button"],
  );
  assert.deepEqual(
    current_view_for_remove._children.map((child: any) => child._id),
    ["toolbar-ref"],
  );
  const deterministic_ref_remove_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_ref_remove_result_json = JSON.parse(
    await readFile(path.join(deterministic_ref_remove_run_dir, "result.json"), "utf-8"),
  );
  assert.equal(deterministic_ref_remove_result_json._artifact_id, "page-toolbar");
  assert.equal(deterministic_ref_remove_result_json._source_view_id, "page-toolbar");
  assert.equal(deterministic_ref_remove_result_json._requested_view_id, "main");
  const deterministic_ref_remove_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_ref_remove_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_ref_remove_mutation_json._target_view_id, "page-toolbar");
  assert.equal(deterministic_ref_remove_mutation_json._source_view_id, "page-toolbar");
  assert.equal(deterministic_ref_remove_mutation_json._requested_view_id, "main");
  assert.equal(deterministic_ref_remove_mutation_json._resolved_via, "xvm-view");
  await assert.rejects(
    readFile(path.join(deterministic_ref_remove_run_dir, "final-prompt.txt"), "utf-8"),
  );

  referenced_views_for_remove = {
    toolbar: {
      _id: "toolbar",
      _type: "view",
      _children: [
        {
          _id: "new-record-button",
          _type: "button",
          _text: "+ New Record",
        },
        {
          _id: "refresh-button",
          _type: "button",
          _text: "Refresh",
        },
      ],
    },
  };
  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "toolbar-ref",
        _type: "xvm-view",
        _view_id: "toolbar",
      },
    ],
  };
  const deterministic_ref_new_record_push_count_before = push_update_count;
  const deterministic_ref_new_record_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_ref_new_record_result = await (xvibe as any).generate_artifact({
    _prompt: 'Update main view only.\nRemove button "+ New Record".\nDo not modify anything else.',
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-ref-new-record",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_ref_new_record_result._ok, true);
  assert.equal(deterministic_ref_new_record_result._result._deterministic, true);
  assert.equal(deterministic_ref_new_record_result._result._artifact_id, "toolbar");
  assert.equal(deterministic_ref_new_record_result._result._source_view_id, "toolbar");
  assert.equal(deterministic_ref_new_record_result._result._requested_view_id, "main");
  assert.equal(deterministic_ref_new_record_result._result._mutation_action, "remove-object");
  assert.equal(deterministic_ref_new_record_result._result._mutation_target_id, "new-record-button");
  assert.equal(xai_generate_count, deterministic_ref_new_record_xai_count_before);
  assert.equal(push_update_count, deterministic_ref_new_record_push_count_before + 1);
  const deterministic_ref_new_record_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-ref-new-record");
  assert.equal(deterministic_ref_new_record_pushed_view._id, "toolbar");
  assert.deepEqual(
    deterministic_ref_new_record_pushed_view._children.map((child: any) => child._id),
    ["refresh-button"],
  );
  assert.deepEqual(
    current_view_for_remove._children.map((child: any) => child._id),
    ["toolbar-ref"],
  );
  const deterministic_ref_new_record_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  await assert.rejects(
    readFile(path.join(deterministic_ref_new_record_run_dir, "validation-plan.json"), "utf-8"),
  );
  const deterministic_ref_new_record_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_ref_new_record_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_ref_new_record_mutation_json._target_view_id, "toolbar");
  assert.equal(deterministic_ref_new_record_mutation_json._resolved_via, "xvm-view");
  await assert.rejects(
    readFile(path.join(deterministic_ref_new_record_run_dir, "final-prompt.txt"), "utf-8"),
  );

  referenced_views_for_remove = {
    toolbar: {
      _id: "toolbar",
      _type: "view",
      _children: [
        {
          _id: "refresh-button",
          _type: "button",
          _text: "Refresh",
        },
      ],
    },
  };
  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "toolbar-ref",
        _type: "xvm-view",
        _view_id: "toolbar",
      },
    ],
  };
  const deterministic_ref_new_record_missing_xai_count_before = xai_generate_count;
  const deterministic_ref_new_record_missing_result = await (xvibe as any).generate_artifact({
    _prompt: 'Update main view only.\nRemove button "+ New Record".\nDo not modify anything else.',
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-ref-new-record-missing",
  });
  assert.equal(deterministic_ref_new_record_missing_result._ok, true);
  assert.equal(deterministic_ref_new_record_missing_result._result._deterministic, undefined);
  assert.equal(xai_generate_count, deterministic_ref_new_record_missing_xai_count_before + 1);
  const deterministic_ref_new_record_missing_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_ref_new_record_missing_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_ref_new_record_missing_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_ref_new_record_missing_mutation_json._eligible, false);
  assert.ok(
    ["text_target_not_found", "target_not_found"].includes(deterministic_ref_new_record_missing_mutation_json._reason),
  );
  const deterministic_ref_new_record_missing_final_prompt =
    await readFile(path.join(deterministic_ref_new_record_missing_run_dir, "final-prompt.txt"), "utf-8");
  assert.ok(deterministic_ref_new_record_missing_final_prompt.includes("+ New Record"));

  referenced_views_for_remove = {
    "page-toolbar": {
      _id: "page-toolbar",
      _type: "view",
      _children: [
        {
          _id: "open-studio-button",
          _type: "button",
          _text: "Open Studio",
        },
      ],
    },
  };
  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "toolbar-ref",
        _type: "xvm-view",
        _view_id: "page-toolbar",
      },
    ],
  };
  const deterministic_ref_text_push_count_before = push_update_count;
  const deterministic_ref_text_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_ref_text_result = await (xvibe as any).generate_artifact({
    _prompt: 'Update main view only. Change "Open Studio" button text to "Launch Studio". Do not modify anything else.',
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-ref-text",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_ref_text_result._ok, true);
  assert.equal(deterministic_ref_text_result._result._deterministic, true);
  assert.equal(deterministic_ref_text_result._result._artifact_id, "page-toolbar");
  assert.equal(deterministic_ref_text_result._result._mutation_action, "update-text");
  assert.equal(deterministic_ref_text_result._result._mutation_target_id, "open-studio-button");
  assert.equal(xai_generate_count, deterministic_ref_text_xai_count_before);
  assert.equal(push_update_count, deterministic_ref_text_push_count_before + 1);
  const deterministic_ref_text_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-ref-text");
  assert.equal(deterministic_ref_text_pushed_view._id, "page-toolbar");
  assert.equal(deterministic_ref_text_pushed_view._children[0]._text, "Launch Studio");
  const deterministic_ref_text_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_ref_text_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_ref_text_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_ref_text_mutation_json._target_view_id, "page-toolbar");
  assert.equal(deterministic_ref_text_mutation_json._resolved_via, "xvm-view");
  await assert.rejects(
    readFile(path.join(deterministic_ref_text_run_dir, "final-prompt.txt"), "utf-8"),
  );

  referenced_views_for_remove = {
    "page-toolbar": {
      _id: "page-toolbar",
      _type: "view",
      _children: [
        {
          _id: "open-studio-ref-button",
          _type: "button",
          _text: "Open Studio",
        },
      ],
    },
  };
  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "open-studio-main-button",
        _type: "button",
        _text: "Open Studio",
      },
      {
        _id: "toolbar-ref",
        _type: "xvm-view",
        _view_id: "page-toolbar",
      },
    ],
  };
  const deterministic_ref_main_wins_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_ref_main_wins_result = await (xvibe as any).generate_artifact({
    _prompt: 'Update main view only. Remove button "Open Studio". Do not modify anything else.',
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-ref-main-wins",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_ref_main_wins_result._ok, true);
  assert.equal(deterministic_ref_main_wins_result._result._deterministic, true);
  assert.equal(deterministic_ref_main_wins_result._result._artifact_id, "main");
  assert.equal(deterministic_ref_main_wins_result._result._source_view_id, undefined);
  assert.equal(deterministic_ref_main_wins_result._result._mutation_target_id, "open-studio-main-button");
  assert.equal(xai_generate_count, deterministic_ref_main_wins_xai_count_before);
  const deterministic_ref_main_wins_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-ref-main-wins");
  assert.equal(deterministic_ref_main_wins_pushed_view._id, "main");
  assert.deepEqual(
    deterministic_ref_main_wins_pushed_view._children.map((child: any) => child._id),
    ["toolbar-ref"],
  );
  assert.equal(referenced_views_for_remove["page-toolbar"]._children[0]._id, "open-studio-ref-button");

  referenced_views_for_remove = {
    "page-toolbar": {
      _id: "page-toolbar",
      _type: "view",
      _children: [
        {
          _id: "open-studio-toolbar-button",
          _type: "button",
          _text: "Open Studio",
        },
      ],
    },
    "page-footer": {
      _id: "page-footer",
      _type: "view",
      _children: [
        {
          _id: "open-studio-footer-button",
          _type: "button",
          _text: "Open Studio",
        },
      ],
    },
  };
  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "toolbar-ref",
        _type: "xvm-view",
        _view_id: "page-toolbar",
      },
      {
        _id: "footer-ref",
        _type: "xvm-view",
        _view_id: "page-footer",
      },
    ],
  };
  const deterministic_ref_ambiguous_xai_count_before = xai_generate_count;
  const deterministic_ref_ambiguous_result = await (xvibe as any).generate_artifact({
    _prompt: 'Update main view only. Remove button "Open Studio". Do not modify anything else.',
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-ref-ambiguous",
  });
  assert.equal(deterministic_ref_ambiguous_result._ok, true);
  assert.equal(deterministic_ref_ambiguous_result._result._deterministic, undefined);
  assert.equal(xai_generate_count, deterministic_ref_ambiguous_xai_count_before + 1);
  const deterministic_ref_ambiguous_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_ref_ambiguous_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_ref_ambiguous_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_ref_ambiguous_mutation_json._eligible, false);
  assert.equal(deterministic_ref_ambiguous_mutation_json._reason, "ambiguous_xvm_view_target");
  assert.deepEqual(
    deterministic_ref_ambiguous_mutation_json._details._target_view_ids,
    ["page-toolbar", "page-footer"],
  );

  referenced_views_for_remove = {};
  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "logout-button",
        _type: "button",
        _text: "Logout",
      },
      {
        _id: "missing-toolbar-ref",
        _type: "xvm-view",
        _view_id: "missing-toolbar",
      },
    ],
  };
  const deterministic_ref_missing_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_ref_missing_result = await (xvibe as any).generate_artifact({
    _prompt: 'Update main view only. Remove button "Logout". Do not modify anything else.',
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-ref-missing",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_ref_missing_result._ok, true);
  assert.equal(deterministic_ref_missing_result._result._deterministic, true);
  assert.equal(deterministic_ref_missing_result._result._artifact_id, "main");
  assert.equal(xai_generate_count, deterministic_ref_missing_xai_count_before);
  const deterministic_ref_missing_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_ref_missing_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_ref_missing_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.deepEqual(
    deterministic_ref_missing_mutation_json._warnings,
    ["missing_xvm_view_reference:missing-toolbar"],
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "pause-button-1",
        _type: "button",
        _text: "Pause",
      },
      {
        _id: "pause-button-2",
        _type: "button",
        _text: "Pause",
      },
    ],
  };
  const deterministic_remove_ambiguous_xai_count_before = xai_generate_count;
  const deterministic_remove_ambiguous_result = await (xvibe as any).generate_artifact({
    _prompt: 'remove button "Pause" from view main',
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-remove-ambiguous",
  });
  assert.equal(deterministic_remove_ambiguous_result._ok, true);
  assert.equal(deterministic_remove_ambiguous_result._result._deterministic, undefined);
  assert.deepEqual(
    planning_cycle_counts_for_generation("view-edit-deterministic-remove-ambiguous"),
    [1],
  );
  assert.equal(xai_generate_count, deterministic_remove_ambiguous_xai_count_before + 1);
  const deterministic_remove_ambiguous_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_remove_ambiguous_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_remove_ambiguous_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_remove_ambiguous_mutation_json._eligible, false);
  assert.equal(deterministic_remove_ambiguous_mutation_json._reason, "ambiguous_text_target");

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
      },
      {
        _id: "pause-button",
        _type: "button",
        _text: "Pause",
      },
      {
        _id: "next-button",
        _type: "button",
        _text: "Next",
      },
    ],
  };
  const deterministic_hide_by_id_push_count_before = push_update_count;
  const deterministic_hide_by_id_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_hide_by_id_result = await (xvibe as any).generate_artifact({
    _prompt: "hide pause-button from view main",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-hide-by-id",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_hide_by_id_result._ok, true);
  assert.equal(deterministic_hide_by_id_result._result._deterministic, true);
  assert.equal(deterministic_hide_by_id_result._result._mutation_action, "hide-object");
  assert.equal(deterministic_hide_by_id_result._result._mutation_target_id, "pause-button");
  assert.equal(xai_generate_count, deterministic_hide_by_id_xai_count_before);
  assert.equal(push_update_count, deterministic_hide_by_id_push_count_before + 1);
  const deterministic_hide_by_id_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-hide-by-id");
  assert.deepEqual(
    deterministic_hide_by_id_pushed_view._children.map((child: any) => child._id),
    ["play-button", "pause-button", "next-button"],
  );
  assert.equal(test_style_has_display_none(deterministic_hide_by_id_pushed_view._children[1].style), true);
  assert.equal(deterministic_hide_by_id_pushed_view._children[1]._visible, false);
  assert.equal(xui_render_path_node_is_visible(deterministic_hide_by_id_pushed_view._children[1]), false);
  const deterministic_hide_by_id_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  await assert.rejects(
    readFile(path.join(deterministic_hide_by_id_run_dir, "final-prompt.txt"), "utf-8"),
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "pause-button",
        _type: "button",
        _text: "Pause",
      },
      {
        _id: "next-button",
        _type: "button",
        _text: "Next",
      },
    ],
  };
  const deterministic_hide_by_text_push_count_before = push_update_count;
  const deterministic_hide_by_text_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_hide_by_text_result = await (xvibe as any).generate_artifact({
    _prompt: "hide Pause button from view main",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-hide-by-text",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_hide_by_text_result._ok, true);
  assert.equal(deterministic_hide_by_text_result._result._deterministic, true);
  assert.equal(deterministic_hide_by_text_result._result._mutation_action, "hide-object");
  assert.equal(deterministic_hide_by_text_result._result._mutation_target_id, "pause-button");
  assert.equal(xai_generate_count, deterministic_hide_by_text_xai_count_before);
  assert.equal(push_update_count, deterministic_hide_by_text_push_count_before + 1);
  const deterministic_hide_by_text_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-hide-by-text");
  assert.equal(deterministic_hide_by_text_pushed_view._children[0]._id, "pause-button");
  assert.equal(test_style_has_display_none(deterministic_hide_by_text_pushed_view._children[0].style), true);
  assert.equal(deterministic_hide_by_text_pushed_view._children[0]._visible, false);
  assert.equal(xui_render_path_node_is_visible(deterministic_hide_by_text_pushed_view._children[0]), false);
  const deterministic_hide_by_text_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_hide_by_text_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_hide_by_text_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_hide_by_text_mutation_json._action, "hide-object");
  assert.equal(deterministic_hide_by_text_mutation_json._target_id, "pause-button");
  assert.equal(deterministic_hide_by_text_mutation_json._resolved_by, "text");
  assert.equal(deterministic_hide_by_text_mutation_json._hide_mechanism, "style.display:none");
  await assert.rejects(
    readFile(path.join(deterministic_hide_by_text_run_dir, "final-prompt.txt"), "utf-8"),
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "pause-button",
        _type: "button",
        _text: "⏸ Pause",
      },
      {
        _id: "next-button",
        _type: "button",
        _text: "Next",
      },
    ],
  };
  const deterministic_hide_icon_prefix_push_count_before = push_update_count;
  const deterministic_hide_icon_prefix_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_hide_icon_prefix_result = await (xvibe as any).generate_artifact({
    _prompt: 'Update main view only. Hide "Pause" button from view main. Do not modify anything else.',
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-hide-icon-prefix",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_hide_icon_prefix_result._ok, true);
  assert.equal(deterministic_hide_icon_prefix_result._result._deterministic, true);
  assert.equal(deterministic_hide_icon_prefix_result._result._mutation_action, "hide-object");
  assert.equal(deterministic_hide_icon_prefix_result._result._mutation_target_id, "pause-button");
  assert.equal(xai_generate_count, deterministic_hide_icon_prefix_xai_count_before);
  assert.equal(push_update_count, deterministic_hide_icon_prefix_push_count_before + 1);
  const deterministic_hide_icon_prefix_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-hide-icon-prefix");
  assert.equal(deterministic_hide_icon_prefix_pushed_view._children[0]._id, "pause-button");
  assert.equal(deterministic_hide_icon_prefix_pushed_view._children[0]._text, "⏸ Pause");
  assert.equal(test_style_has_display_none(deterministic_hide_icon_prefix_pushed_view._children[0].style), true);
  assert.equal(deterministic_hide_icon_prefix_pushed_view._children[0]._visible, false);
  assert.equal(xui_render_path_node_is_visible(deterministic_hide_icon_prefix_pushed_view._children[0]), false);
  const deterministic_hide_icon_prefix_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_hide_icon_prefix_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_hide_icon_prefix_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_hide_icon_prefix_mutation_json._action, "hide-object");
  assert.equal(deterministic_hide_icon_prefix_mutation_json._target_id, "pause-button");
  assert.equal(deterministic_hide_icon_prefix_mutation_json._reason, "eligible_normalized_text_match");
  assert.equal(deterministic_hide_icon_prefix_mutation_json._resolved_by, "normalized_text");
  assert.equal(deterministic_hide_icon_prefix_mutation_json._hide_mechanism, "style.display:none");
  await assert.rejects(
    readFile(path.join(deterministic_hide_icon_prefix_run_dir, "final-prompt.txt"), "utf-8"),
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
      },
      {
        _id: "pause-button",
        _type: "button",
        _text: "Pause",
        style: "display:none",
        _visible: false,
      },
      {
        _id: "next-button",
        _type: "button",
        _text: "Next",
      },
    ],
  };
  const deterministic_show_by_id_push_count_before = push_update_count;
  const deterministic_show_by_id_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_show_by_id_result = await (xvibe as any).generate_artifact({
    _prompt: "Show pause-button",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-show-by-id",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_show_by_id_result._ok, true);
  assert.equal(deterministic_show_by_id_result._result._deterministic, true);
  assert.equal(deterministic_show_by_id_result._result._mutation_action, "show-object");
  assert.equal(deterministic_show_by_id_result._result._mutation_target_id, "pause-button");
  assert.equal(xai_generate_count, deterministic_show_by_id_xai_count_before);
  assert.equal(push_update_count, deterministic_show_by_id_push_count_before + 1);
  const deterministic_show_by_id_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-show-by-id");
  assert.equal(deterministic_show_by_id_pushed_view._children[1]._id, "pause-button");
  assert.equal(deterministic_show_by_id_pushed_view._children[1].style, undefined);
  assert.equal(deterministic_show_by_id_pushed_view._children[1]._visible, true);
  const deterministic_show_by_id_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_show_by_id_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_show_by_id_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_show_by_id_mutation_json._action, "show-object");
  assert.equal(deterministic_show_by_id_mutation_json._target_id, "pause-button");
  assert.equal(deterministic_show_by_id_mutation_json._resolved_by, "id");
  assert.equal(deterministic_show_by_id_mutation_json._show_mechanism, "remove-style.display:none");
  await assert.rejects(
    readFile(path.join(deterministic_show_by_id_run_dir, "final-prompt.txt"), "utf-8"),
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "pause-button",
        _type: "button",
        _text: "⏸ Pause",
        style: "color:red; display:none; padding:8px",
        _visible: false,
      },
      {
        _id: "next-button",
        _type: "button",
        _text: "Next",
      },
    ],
  };
  const deterministic_show_by_normalized_text_push_count_before = push_update_count;
  const deterministic_show_by_normalized_text_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_show_by_normalized_text_result = await (xvibe as any).generate_artifact({
    _prompt: "Show Pause button",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-show-normalized-text",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_show_by_normalized_text_result._ok, true);
  assert.equal(deterministic_show_by_normalized_text_result._result._deterministic, true);
  assert.equal(deterministic_show_by_normalized_text_result._result._mutation_action, "show-object");
  assert.equal(deterministic_show_by_normalized_text_result._result._mutation_target_id, "pause-button");
  assert.equal(xai_generate_count, deterministic_show_by_normalized_text_xai_count_before);
  assert.equal(push_update_count, deterministic_show_by_normalized_text_push_count_before + 1);
  const deterministic_show_by_normalized_text_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-show-normalized-text");
  assert.equal(deterministic_show_by_normalized_text_pushed_view._children[0]._id, "pause-button");
  assert.equal(deterministic_show_by_normalized_text_pushed_view._children[0]._text, "⏸ Pause");
  assert.equal(deterministic_show_by_normalized_text_pushed_view._children[0].style, "color:red; padding:8px");
  assert.equal(test_style_has_display_none(deterministic_show_by_normalized_text_pushed_view._children[0].style), false);
  assert.equal(deterministic_show_by_normalized_text_pushed_view._children[0]._visible, true);
  const deterministic_show_by_normalized_text_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_show_by_normalized_text_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_show_by_normalized_text_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_show_by_normalized_text_mutation_json._action, "show-object");
  assert.equal(deterministic_show_by_normalized_text_mutation_json._target_id, "pause-button");
  assert.equal(deterministic_show_by_normalized_text_mutation_json._reason, "eligible_normalized_text_match");
  assert.equal(deterministic_show_by_normalized_text_mutation_json._resolved_by, "normalized_text");
  assert.equal(deterministic_show_by_normalized_text_mutation_json._show_mechanism, "remove-style.display:none");
  await assert.rejects(
    readFile(path.join(deterministic_show_by_normalized_text_run_dir, "final-prompt.txt"), "utf-8"),
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "pause-button-1",
        _type: "button",
        _text: "Pause",
        style: "display:none",
        _visible: false,
      },
      {
        _id: "pause-button-2",
        _type: "button",
        _text: "Pause",
        style: "display:none",
        _visible: false,
      },
    ],
  };
  const deterministic_show_ambiguous_xai_count_before = xai_generate_count;
  const deterministic_show_ambiguous_result = await (xvibe as any).generate_artifact({
    _prompt: "Show Pause button",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-show-ambiguous",
  });
  assert.equal(deterministic_show_ambiguous_result._ok, true);
  assert.equal(deterministic_show_ambiguous_result._result._deterministic, undefined);
  assert.equal(xai_generate_count, deterministic_show_ambiguous_xai_count_before + 1);
  const deterministic_show_ambiguous_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_show_ambiguous_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_show_ambiguous_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_show_ambiguous_mutation_json._eligible, false);
  assert.equal(deterministic_show_ambiguous_mutation_json._reason, "ambiguous_text_target");

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "pause-button-1",
        _type: "button",
        _text: "Pause",
      },
      {
        _id: "pause-button-2",
        _type: "button",
        _text: "Pause",
      },
    ],
  };
  const deterministic_hide_ambiguous_xai_count_before = xai_generate_count;
  const deterministic_hide_ambiguous_result = await (xvibe as any).generate_artifact({
    _prompt: "hide Pause button from view main",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-hide-ambiguous",
  });
  assert.equal(deterministic_hide_ambiguous_result._ok, true);
  assert.equal(deterministic_hide_ambiguous_result._result._deterministic, undefined);
  assert.equal(xai_generate_count, deterministic_hide_ambiguous_xai_count_before + 1);
  const deterministic_hide_ambiguous_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_hide_ambiguous_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_hide_ambiguous_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_hide_ambiguous_mutation_json._eligible, false);
  assert.equal(deterministic_hide_ambiguous_mutation_json._reason, "ambiguous_text_target");

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "▶ Play",
        class: "music-button",
      },
      {
        _id: "pause-button",
        _type: "button",
        _text: "Pause",
        class: "music-button disabled primary",
      },
    ],
  };
  const deterministic_add_class_by_text_push_count_before = push_update_count;
  const deterministic_add_class_by_text_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_add_class_by_text_result = await (xvibe as any).generate_artifact({
    _prompt: "Add class primary to Play button",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-add-class-by-text",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_add_class_by_text_result._ok, true);
  assert.equal(deterministic_add_class_by_text_result._result._deterministic, true);
  assert.equal(deterministic_add_class_by_text_result._result._mutation_action, "add-class");
  assert.equal(deterministic_add_class_by_text_result._result._mutation_target_id, "play-button");
  assert.equal(xai_generate_count, deterministic_add_class_by_text_xai_count_before);
  assert.equal(push_update_count, deterministic_add_class_by_text_push_count_before + 1);
  const deterministic_add_class_by_text_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-add-class-by-text");
  assert.equal(deterministic_add_class_by_text_pushed_view._children[0].class, "music-button primary");
  const deterministic_add_class_by_text_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_add_class_by_text_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_add_class_by_text_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_add_class_by_text_mutation_json._eligible, true);
  assert.equal(deterministic_add_class_by_text_mutation_json._action, "add-class");
  assert.equal(deterministic_add_class_by_text_mutation_json._class_name, "primary");
  assert.equal(deterministic_add_class_by_text_mutation_json._class_field, "class");
  assert.equal(deterministic_add_class_by_text_mutation_json._previous_class, "music-button");
  assert.equal(deterministic_add_class_by_text_mutation_json._next_class, "music-button primary");
  await assert.rejects(
    readFile(path.join(deterministic_add_class_by_text_run_dir, "final-prompt.txt"), "utf-8"),
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
        class: "music-button primary",
      },
    ],
  };
  const deterministic_add_duplicate_class_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_add_duplicate_class_result = await (xvibe as any).generate_artifact({
    _prompt: "Add class primary to Play button",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-add-duplicate-class",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_add_duplicate_class_result._ok, true);
  assert.equal(deterministic_add_duplicate_class_result._result._deterministic, true);
  assert.equal(xai_generate_count, deterministic_add_duplicate_class_xai_count_before);
  const deterministic_add_duplicate_class_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-add-duplicate-class");
  assert.equal(deterministic_add_duplicate_class_pushed_view._children[0].class, "music-button primary");

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "pause-button",
        _type: "button",
        _text: "Pause",
        class: "music-button disabled primary",
      },
    ],
  };
  const deterministic_remove_class_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_remove_class_result = await (xvibe as any).generate_artifact({
    _prompt: "Remove class disabled from Pause button",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-remove-class",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_remove_class_result._ok, true);
  assert.equal(deterministic_remove_class_result._result._deterministic, true);
  assert.equal(deterministic_remove_class_result._result._mutation_action, "remove-class");
  assert.equal(deterministic_remove_class_result._result._mutation_target_id, "pause-button");
  assert.equal(xai_generate_count, deterministic_remove_class_xai_count_before);
  const deterministic_remove_class_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-remove-class");
  assert.equal(deterministic_remove_class_pushed_view._children[0].class, "music-button primary");

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "pause-button",
        _type: "button",
        _text: "Pause",
        class: "disabled",
      },
    ],
  };
  const deterministic_remove_last_class_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_remove_last_class_result = await (xvibe as any).generate_artifact({
    _prompt: "Remove class disabled from Pause button",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-remove-last-class",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_remove_last_class_result._ok, true);
  assert.equal(deterministic_remove_last_class_result._result._deterministic, true);
  assert.equal(xai_generate_count, deterministic_remove_last_class_xai_count_before);
  const deterministic_remove_last_class_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-remove-last-class");
  assert.equal(Object.prototype.hasOwnProperty.call(deterministic_remove_last_class_pushed_view._children[0], "class"), false);

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
        _class: "music-button",
      },
    ],
  };
  const deterministic_add_class_alias_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_add_class_alias_result = await (xvibe as any).generate_artifact({
    _prompt: "Add class primary to Play button",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-add-class-alias",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_add_class_alias_result._ok, true);
  assert.equal(deterministic_add_class_alias_result._result._deterministic, true);
  assert.equal(xai_generate_count, deterministic_add_class_alias_xai_count_before);
  const deterministic_add_class_alias_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-add-class-alias");
  assert.equal(deterministic_add_class_alias_pushed_view._children[0]._class, "music-button primary");
  assert.equal(deterministic_add_class_alias_pushed_view._children[0].class, undefined);
  const deterministic_add_class_alias_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_add_class_alias_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_add_class_alias_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_add_class_alias_mutation_json._class_field, "_class");

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "pause-button-1",
        _type: "button",
        _text: "Pause",
      },
      {
        _id: "pause-button-2",
        _type: "button",
        _text: "Pause",
      },
    ],
  };
  const deterministic_class_ambiguous_xai_count_before = xai_generate_count;
  const deterministic_class_ambiguous_result = await (xvibe as any).generate_artifact({
    _prompt: "Remove class disabled from Pause button",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-class-ambiguous",
  });
  assert.equal(deterministic_class_ambiguous_result._ok, true);
  assert.equal(deterministic_class_ambiguous_result._result._deterministic, undefined);
  assert.equal(xai_generate_count, deterministic_class_ambiguous_xai_count_before + 1);
  const deterministic_class_ambiguous_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_class_ambiguous_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_class_ambiguous_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_class_ambiguous_mutation_json._eligible, false);
  assert.equal(deterministic_class_ambiguous_mutation_json._reason, "ambiguous_text_target");

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "▶ Play",
        class: "music-button primary",
      },
    ],
  };
  const deterministic_replace_class_by_text_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_replace_class_by_text_result = await (xvibe as any).generate_artifact({
    _prompt: "Replace class primary with danger on Play button",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-replace-class-by-text",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_replace_class_by_text_result._ok, true);
  assert.equal(deterministic_replace_class_by_text_result._result._deterministic, true);
  assert.equal(deterministic_replace_class_by_text_result._result._mutation_action, "replace-class");
  assert.equal(deterministic_replace_class_by_text_result._result._mutation_target_id, "play-button");
  assert.equal(xai_generate_count, deterministic_replace_class_by_text_xai_count_before);
  const deterministic_replace_class_by_text_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-replace-class-by-text");
  assert.equal(deterministic_replace_class_by_text_pushed_view._children[0].class, "music-button danger");
  const deterministic_replace_class_by_text_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_replace_class_by_text_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_replace_class_by_text_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_replace_class_by_text_mutation_json._eligible, true);
  assert.equal(deterministic_replace_class_by_text_mutation_json._action, "replace-class");
  assert.equal(deterministic_replace_class_by_text_mutation_json._old_class_name, "primary");
  assert.equal(deterministic_replace_class_by_text_mutation_json._new_class_name, "danger");
  assert.equal(deterministic_replace_class_by_text_mutation_json._class_field, "class");
  assert.equal(deterministic_replace_class_by_text_mutation_json._previous_class, "music-button primary");
  assert.equal(deterministic_replace_class_by_text_mutation_json._next_class, "music-button danger");
  await assert.rejects(
    readFile(path.join(deterministic_replace_class_by_text_run_dir, "final-prompt.txt"), "utf-8"),
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
        class: "music-button",
      },
    ],
  };
  const deterministic_replace_missing_class_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_replace_missing_class_result = await (xvibe as any).generate_artifact({
    _prompt: "Replace class primary with danger on Play button",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-replace-missing-class",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_replace_missing_class_result._ok, true);
  assert.equal(deterministic_replace_missing_class_result._result._deterministic, true);
  assert.equal(xai_generate_count, deterministic_replace_missing_class_xai_count_before);
  const deterministic_replace_missing_class_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-replace-missing-class");
  assert.equal(deterministic_replace_missing_class_pushed_view._children[0].class, "music-button danger");

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
        class: "music-button primary danger",
      },
    ],
  };
  const deterministic_replace_duplicate_class_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_replace_duplicate_class_result = await (xvibe as any).generate_artifact({
    _prompt: "Replace class primary with danger on Play button",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-replace-duplicate-class",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_replace_duplicate_class_result._ok, true);
  assert.equal(deterministic_replace_duplicate_class_result._result._deterministic, true);
  assert.equal(xai_generate_count, deterministic_replace_duplicate_class_xai_count_before);
  const deterministic_replace_duplicate_class_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-replace-duplicate-class");
  assert.equal(deterministic_replace_duplicate_class_pushed_view._children[0].class, "music-button danger");

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
        class: "music-button active",
      },
    ],
  };
  const deterministic_toggle_remove_class_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_toggle_remove_class_result = await (xvibe as any).generate_artifact({
    _prompt: "Toggle class active on Play button",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-toggle-remove-class",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_toggle_remove_class_result._ok, true);
  assert.equal(deterministic_toggle_remove_class_result._result._deterministic, true);
  assert.equal(deterministic_toggle_remove_class_result._result._mutation_action, "toggle-class");
  assert.equal(deterministic_toggle_remove_class_result._result._mutation_target_id, "play-button");
  assert.equal(xai_generate_count, deterministic_toggle_remove_class_xai_count_before);
  const deterministic_toggle_remove_class_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-toggle-remove-class");
  assert.equal(deterministic_toggle_remove_class_pushed_view._children[0].class, "music-button");

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
        class: "music-button",
      },
    ],
  };
  const deterministic_toggle_add_class_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_toggle_add_class_result = await (xvibe as any).generate_artifact({
    _prompt: "Toggle class active on Play button",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-toggle-add-class",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_toggle_add_class_result._ok, true);
  assert.equal(deterministic_toggle_add_class_result._result._deterministic, true);
  assert.equal(xai_generate_count, deterministic_toggle_add_class_xai_count_before);
  const deterministic_toggle_add_class_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-toggle-add-class");
  assert.equal(deterministic_toggle_add_class_pushed_view._children[0].class, "music-button active");

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
        _class: "music-button active",
      },
    ],
  };
  const deterministic_toggle_alias_class_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_toggle_alias_class_result = await (xvibe as any).generate_artifact({
    _prompt: "Toggle class active on Play button",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-toggle-alias-class",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_toggle_alias_class_result._ok, true);
  assert.equal(deterministic_toggle_alias_class_result._result._deterministic, true);
  assert.equal(xai_generate_count, deterministic_toggle_alias_class_xai_count_before);
  const deterministic_toggle_alias_class_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-toggle-alias-class");
  assert.equal(deterministic_toggle_alias_class_pushed_view._children[0]._class, "music-button");
  assert.equal(deterministic_toggle_alias_class_pushed_view._children[0].class, undefined);

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button-1",
        _type: "button",
        _text: "Play",
      },
      {
        _id: "play-button-2",
        _type: "button",
        _text: "Play",
      },
    ],
  };
  const deterministic_toggle_ambiguous_xai_count_before = xai_generate_count;
  const deterministic_toggle_ambiguous_result = await (xvibe as any).generate_artifact({
    _prompt: "Toggle class active on Play button",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-toggle-ambiguous",
  });
  assert.equal(deterministic_toggle_ambiguous_result._ok, true);
  assert.equal(deterministic_toggle_ambiguous_result._result._deterministic, undefined);
  assert.equal(xai_generate_count, deterministic_toggle_ambiguous_xai_count_before + 1);
  const deterministic_toggle_ambiguous_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_toggle_ambiguous_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_toggle_ambiguous_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_toggle_ambiguous_mutation_json._eligible, false);
  assert.equal(deterministic_toggle_ambiguous_mutation_json._reason, "ambiguous_text_target");

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "main-styles",
        _type: "style-sheet",
        _classes: {},
      },
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
        class: "play-button",
      },
    ],
  };
  const deterministic_create_style_class_rule_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_create_style_class_rule_result = await (xvibe as any).generate_artifact({
    _prompt: "Make play-button background green",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-create-style-class-rule",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_create_style_class_rule_result._ok, true);
  assert.equal(deterministic_create_style_class_rule_result._result._deterministic, true);
  assert.equal(deterministic_create_style_class_rule_result._result._mutation_action, "set-style-class-rule");
  assert.equal(xai_generate_count, deterministic_create_style_class_rule_xai_count_before);
  const deterministic_create_style_class_rule_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-create-style-class-rule");
  assert.deepEqual(
    deterministic_create_style_class_rule_pushed_view._children[0]._classes,
    {
      "play-button": {
        "background-color": "green",
      },
    },
  );
  assert.equal(Object.prototype.hasOwnProperty.call(deterministic_create_style_class_rule_pushed_view._children[1], "_style"), false);
  assert.equal(deterministic_create_style_class_rule_pushed_view._children[1].class, "play-button");
  const deterministic_create_style_class_rule_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_create_style_class_rule_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_create_style_class_rule_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_create_style_class_rule_mutation_json._eligible, true);
  assert.equal(deterministic_create_style_class_rule_mutation_json._action, "set-style-class-rule");
  assert.equal(deterministic_create_style_class_rule_mutation_json._class_name, "play-button");
  assert.equal(deterministic_create_style_class_rule_mutation_json._style_property, "background-color");
  assert.equal(deterministic_create_style_class_rule_mutation_json._next_value, "green");
  await assert.rejects(
    readFile(path.join(deterministic_create_style_class_rule_run_dir, "final-prompt.txt"), "utf-8"),
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "main-styles",
        _type: "style-sheet",
        _classes: {
          "play-button": {
            "border-radius": "4px",
            padding: "8px",
          },
        },
      },
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
        class: "play-button",
      },
    ],
  };
  const deterministic_update_style_class_rule_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_update_style_class_rule_result = await (xvibe as any).generate_artifact({
    _prompt: "Set play-button border radius 12px",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-update-style-class-rule",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_update_style_class_rule_result._ok, true);
  assert.equal(deterministic_update_style_class_rule_result._result._deterministic, true);
  assert.equal(xai_generate_count, deterministic_update_style_class_rule_xai_count_before);
  const deterministic_update_style_class_rule_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-update-style-class-rule");
  assert.deepEqual(
    deterministic_update_style_class_rule_pushed_view._children[0]._classes,
    {
      "play-button": {
        "border-radius": "12px",
        padding: "8px",
      },
    },
  );
  const deterministic_update_style_class_rule_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_update_style_class_rule_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_update_style_class_rule_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_update_style_class_rule_mutation_json._previous_value, "4px");
  assert.equal(deterministic_update_style_class_rule_mutation_json._next_value, "12px");

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "main-styles",
        _type: "style-sheet",
        _classes: {
          "play-button": {
            "background-color": "green",
            color: "white",
          },
        },
      },
    ],
  };
  const deterministic_remove_style_class_rule_property_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_remove_style_class_rule_property_result = await (xvibe as any).generate_artifact({
    _prompt: "Remove background color from play-button class",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-remove-style-class-rule-property",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_remove_style_class_rule_property_result._ok, true);
  assert.equal(deterministic_remove_style_class_rule_property_result._result._deterministic, true);
  assert.equal(deterministic_remove_style_class_rule_property_result._result._mutation_action, "remove-style-class-rule");
  assert.equal(xai_generate_count, deterministic_remove_style_class_rule_property_xai_count_before);
  const deterministic_remove_style_class_rule_property_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-remove-style-class-rule-property");
  assert.deepEqual(
    deterministic_remove_style_class_rule_property_pushed_view._children[0]._classes,
    {
      "play-button": {
        color: "white",
      },
    },
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "main-styles",
        _type: "style-sheet",
        _classes: {
          "play-button": {
            "background-color": "green",
          },
        },
      },
    ],
  };
  const deterministic_remove_last_style_class_rule_property_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_remove_last_style_class_rule_property_result = await (xvibe as any).generate_artifact({
    _prompt: "Remove background color from play-button class",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-remove-last-style-class-rule-property",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_remove_last_style_class_rule_property_result._ok, true);
  assert.equal(deterministic_remove_last_style_class_rule_property_result._result._deterministic, true);
  assert.equal(xai_generate_count, deterministic_remove_last_style_class_rule_property_xai_count_before);
  const deterministic_remove_last_style_class_rule_property_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-remove-last-style-class-rule-property");
  assert.deepEqual(deterministic_remove_last_style_class_rule_property_pushed_view._children[0]._classes, {});

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
        class: "play-button",
      },
    ],
  };
  const deterministic_style_class_rule_missing_sheet_xai_count_before = xai_generate_count;
  const deterministic_style_class_rule_missing_sheet_result = await (xvibe as any).generate_artifact({
    _prompt: "Make play-button background green",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-style-class-rule-missing-sheet",
  });
  assert.equal(deterministic_style_class_rule_missing_sheet_result._ok, true);
  assert.equal(deterministic_style_class_rule_missing_sheet_result._result._deterministic, undefined);
  assert.equal(xai_generate_count, deterministic_style_class_rule_missing_sheet_xai_count_before + 1);
  const deterministic_style_class_rule_missing_sheet_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_style_class_rule_missing_sheet_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_style_class_rule_missing_sheet_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_style_class_rule_missing_sheet_mutation_json._eligible, false);
  assert.equal(deterministic_style_class_rule_missing_sheet_mutation_json._reason, "missing_style_sheet");

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
      },
    ],
  };
  const deterministic_set_text_property_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_set_text_property_result = await (xvibe as any).generate_artifact({
    _prompt: "Set play-button _text to Play Now",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-set-text-property",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_set_text_property_result._ok, true);
  assert.equal(deterministic_set_text_property_result._result._deterministic, true);
  assert.equal(deterministic_set_text_property_result._result._mutation_action, "set-property");
  assert.equal(deterministic_set_text_property_result._result._mutation_target_id, "play-button");
  assert.equal(xai_generate_count, deterministic_set_text_property_xai_count_before);
  const deterministic_set_text_property_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-set-text-property");
  assert.equal(deterministic_set_text_property_pushed_view._children[0]._text, "Play Now");
  const deterministic_set_text_property_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_set_text_property_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_set_text_property_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_set_text_property_mutation_json._eligible, true);
  assert.equal(deterministic_set_text_property_mutation_json._action, "set-property");
  assert.equal(deterministic_set_text_property_mutation_json._property_name, "_text");
  assert.equal(deterministic_set_text_property_mutation_json._previous_value, "Play");
  assert.equal(deterministic_set_text_property_mutation_json._next_value, "Play Now");
  await assert.rejects(
    readFile(path.join(deterministic_set_text_property_run_dir, "final-prompt.txt"), "utf-8"),
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "header-card",
        _type: "card",
        _gap: 8,
        _children: [
          {
            _id: "header-title",
            _type: "label",
            _text: "Header",
          },
        ],
      },
    ],
  };
  const deterministic_set_gap_property_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_set_gap_property_result = await (xvibe as any).generate_artifact({
    _prompt: "Set header-card _gap to 16",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-set-gap-property",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_set_gap_property_result._ok, true);
  assert.equal(deterministic_set_gap_property_result._result._deterministic, true);
  assert.equal(xai_generate_count, deterministic_set_gap_property_xai_count_before);
  const deterministic_set_gap_property_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-set-gap-property");
  assert.equal(deterministic_set_gap_property_pushed_view._children[0]._gap, 16);

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
      },
    ],
  };
  const deterministic_set_disabled_property_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_set_disabled_property_result = await (xvibe as any).generate_artifact({
    _prompt: "Set play-button disabled to true",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-set-disabled-property",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_set_disabled_property_result._ok, true);
  assert.equal(deterministic_set_disabled_property_result._result._deterministic, true);
  assert.equal(xai_generate_count, deterministic_set_disabled_property_xai_count_before);
  const deterministic_set_disabled_property_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-set-disabled-property");
  assert.equal(deterministic_set_disabled_property_pushed_view._children[0].disabled, true);

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
        disabled: true,
      },
    ],
  };
  const deterministic_remove_disabled_property_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_remove_disabled_property_result = await (xvibe as any).generate_artifact({
    _prompt: "Remove disabled from play-button",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-remove-disabled-property",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_remove_disabled_property_result._ok, true);
  assert.equal(deterministic_remove_disabled_property_result._result._deterministic, true);
  assert.equal(deterministic_remove_disabled_property_result._result._mutation_action, "remove-property");
  assert.equal(xai_generate_count, deterministic_remove_disabled_property_xai_count_before);
  const deterministic_remove_disabled_property_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-remove-disabled-property");
  assert.equal(Object.prototype.hasOwnProperty.call(deterministic_remove_disabled_property_pushed_view._children[0], "disabled"), false);

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
      },
    ],
  };
  const deterministic_unsupported_property_xai_count_before = xai_generate_count;
  const deterministic_unsupported_property_result = await (xvibe as any).generate_artifact({
    _prompt: "Set play-button _children to []",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-unsupported-property",
  });
  assert.equal(deterministic_unsupported_property_result._ok, true);
  assert.equal(deterministic_unsupported_property_result._result._deterministic, undefined);
  assert.equal(xai_generate_count, deterministic_unsupported_property_xai_count_before + 1);
  const deterministic_unsupported_property_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_unsupported_property_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_unsupported_property_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_unsupported_property_mutation_json._eligible, false);
  assert.equal(deterministic_unsupported_property_mutation_json._reason, "unsupported_property");
  assert.equal(deterministic_unsupported_property_mutation_json._details._property_name, "_children");

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button-1",
        _type: "button",
        _text: "Play",
      },
      {
        _id: "play-button-2",
        _type: "button",
        _text: "Play",
      },
    ],
  };
  const deterministic_property_ambiguous_xai_count_before = xai_generate_count;
  const deterministic_property_ambiguous_result = await (xvibe as any).generate_artifact({
    _prompt: "Set Play button disabled to true",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-property-ambiguous",
  });
  assert.equal(deterministic_property_ambiguous_result._ok, true);
  assert.equal(deterministic_property_ambiguous_result._result._deterministic, undefined);
  assert.equal(xai_generate_count, deterministic_property_ambiguous_xai_count_before + 1);
  const deterministic_property_ambiguous_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_property_ambiguous_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_property_ambiguous_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_property_ambiguous_mutation_json._eligible, false);
  assert.equal(deterministic_property_ambiguous_mutation_json._reason, "ambiguous_text_target");

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
      },
      {
        _id: "pause-button",
        _type: "button",
        _text: "Pause",
      },
      {
        _id: "stop-button",
        _type: "button",
        _text: "Stop",
      },
    ],
  };
  const deterministic_move_before_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_move_before_result = await (xvibe as any).generate_artifact({
    _prompt: "Move pause-button before play-button",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-move-before",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_move_before_result._ok, true);
  assert.equal(deterministic_move_before_result._result._deterministic, true);
  assert.equal(deterministic_move_before_result._result._mutation_action, "move-object");
  assert.equal(deterministic_move_before_result._result._mutation_target_id, "pause-button");
  assert.equal(xai_generate_count, deterministic_move_before_xai_count_before);
  const deterministic_move_before_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-move-before");
  assert.deepEqual(
    deterministic_move_before_pushed_view._children.map((child: any) => child._id),
    ["pause-button", "play-button", "stop-button"],
  );
  const deterministic_move_before_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_move_before_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_move_before_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_move_before_mutation_json._eligible, true);
  assert.equal(deterministic_move_before_mutation_json._action, "move-object");
  assert.equal(deterministic_move_before_mutation_json._move_position, "before");
  assert.equal(deterministic_move_before_mutation_json._anchor_id, "play-button");
  assert.equal(deterministic_move_before_mutation_json._before_id, "play-button");
  assert.equal(deterministic_move_before_mutation_json._previous_index, 1);
  assert.equal(deterministic_move_before_mutation_json._next_index, 0);
  await assert.rejects(
    readFile(path.join(deterministic_move_before_run_dir, "final-prompt.txt"), "utf-8"),
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "controls-stack",
        _type: "xsection",
        _children: [
          {
            _id: "controls-label",
            _type: "label",
            _text: "Controls",
          },
        ],
      },
      {
        _id: "header-card",
        _type: "card",
        _children: [
          {
            _id: "header-title",
            _type: "label",
            _text: "Header",
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
  const deterministic_move_after_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_move_after_result = await (xvibe as any).generate_artifact({
    _prompt: "Move controls-stack after header-card",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-move-after",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_move_after_result._ok, true);
  assert.equal(deterministic_move_after_result._result._deterministic, true);
  assert.equal(xai_generate_count, deterministic_move_after_xai_count_before);
  const deterministic_move_after_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-move-after");
  assert.deepEqual(
    deterministic_move_after_pushed_view._children.map((child: any) => child._id),
    ["header-card", "controls-stack", "footer"],
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "title-label",
        _type: "label",
        _text: "title",
      },
      {
        _id: "powered-by-label",
        _type: "label",
        _text: "powered-by",
      },
      {
        _id: "controls-stack",
        _type: "xsection",
        _children: [
          {
            _id: "controls-label",
            _type: "label",
            _text: "Controls",
          },
        ],
      },
    ],
  };
  const deterministic_move_bottom_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_move_bottom_result = await (xvibe as any).generate_artifact({
    _prompt: "Move powered-by label to bottom",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-move-bottom",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_move_bottom_result._ok, true);
  assert.equal(deterministic_move_bottom_result._result._deterministic, true);
  assert.equal(xai_generate_count, deterministic_move_bottom_xai_count_before);
  const deterministic_move_bottom_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-move-bottom");
  assert.deepEqual(
    deterministic_move_bottom_pushed_view._children.map((child: any) => child._id),
    ["title-label", "controls-stack", "powered-by-label"],
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "controls-stack",
        _type: "xsection",
        _children: [
          {
            _id: "controls-label",
            _type: "label",
            _text: "Controls",
          },
        ],
      },
      {
        _id: "title-label",
        _type: "label",
        _text: "title",
      },
    ],
  };
  const deterministic_move_top_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_move_top_result = await (xvibe as any).generate_artifact({
    _prompt: "Move title label to top",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-move-top",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_move_top_result._ok, true);
  assert.equal(deterministic_move_top_result._result._deterministic, true);
  assert.equal(xai_generate_count, deterministic_move_top_xai_count_before);
  const deterministic_move_top_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-move-top");
  assert.deepEqual(
    deterministic_move_top_pushed_view._children.map((child: any) => child._id),
    ["title-label", "controls-stack"],
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "left",
        _type: "xsection",
        _children: [
          {
            _id: "pause-button",
            _type: "button",
            _text: "Pause",
          },
        ],
      },
      {
        _id: "right",
        _type: "xsection",
        _children: [
          {
            _id: "play-button",
            _type: "button",
            _text: "Play",
          },
        ],
      },
    ],
  };
  const deterministic_move_different_parent_xai_count_before = xai_generate_count;
  const deterministic_move_different_parent_result = await (xvibe as any).generate_artifact({
    _prompt: "Move pause-button before play-button",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-move-different-parent",
  });
  assert.equal(deterministic_move_different_parent_result._ok, true);
  assert.equal(deterministic_move_different_parent_result._result._deterministic, undefined);
  assert.equal(xai_generate_count, deterministic_move_different_parent_xai_count_before + 1);
  const deterministic_move_different_parent_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_move_different_parent_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_move_different_parent_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_move_different_parent_mutation_json._eligible, false);
  assert.equal(deterministic_move_different_parent_mutation_json._reason, "different_parent");

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "pause-button",
        _type: "button",
        _text: "Pause",
      },
    ],
  };
  const deterministic_move_anchor_missing_xai_count_before = xai_generate_count;
  const deterministic_move_anchor_missing_result = await (xvibe as any).generate_artifact({
    _prompt: "Move pause-button before play-button",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-move-anchor-missing",
  });
  assert.equal(deterministic_move_anchor_missing_result._ok, true);
  assert.equal(deterministic_move_anchor_missing_result._result._deterministic, undefined);
  assert.equal(xai_generate_count, deterministic_move_anchor_missing_xai_count_before + 1);
  const deterministic_move_anchor_missing_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_move_anchor_missing_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_move_anchor_missing_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_move_anchor_missing_mutation_json._eligible, false);
  assert.equal(deterministic_move_anchor_missing_mutation_json._reason, "anchor_not_found");

  referenced_views_for_remove = {
    "page-toolbar": {
      _id: "page-toolbar",
      _type: "view",
      _children: [
        {
          _id: "settings-button",
          _type: "button",
          _text: "Settings",
        },
        {
          _id: "open-studio-button",
          _type: "button",
          _text: "Open Studio",
        },
      ],
    },
  };
  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "toolbar-ref",
        _type: "xvm-view",
        _view_id: "page-toolbar",
      },
    ],
  };
  const deterministic_ref_move_inside_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_ref_move_inside_result = await (xvibe as any).generate_artifact({
    _prompt: "Update main view only. Move open-studio-button before settings-button. Do not modify anything else.",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-ref-move-inside",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_ref_move_inside_result._ok, true);
  assert.equal(deterministic_ref_move_inside_result._result._deterministic, true);
  assert.equal(deterministic_ref_move_inside_result._result._artifact_id, "page-toolbar");
  assert.equal(deterministic_ref_move_inside_result._result._mutation_action, "move-object");
  assert.equal(deterministic_ref_move_inside_result._result._mutation_target_id, "open-studio-button");
  assert.equal(xai_generate_count, deterministic_ref_move_inside_xai_count_before);
  const deterministic_ref_move_inside_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-ref-move-inside");
  assert.equal(deterministic_ref_move_inside_pushed_view._id, "page-toolbar");
  assert.deepEqual(
    deterministic_ref_move_inside_pushed_view._children.map((child: any) => child._id),
    ["open-studio-button", "settings-button"],
  );
  const deterministic_ref_move_inside_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_ref_move_inside_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_ref_move_inside_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_ref_move_inside_mutation_json._target_view_id, "page-toolbar");
  assert.equal(deterministic_ref_move_inside_mutation_json._resolved_via, "xvm-view");
  assert.equal(deterministic_ref_move_inside_mutation_json._anchor_id, "settings-button");
  await assert.rejects(
    readFile(path.join(deterministic_ref_move_inside_run_dir, "final-prompt.txt"), "utf-8"),
  );

  referenced_views_for_remove = {
    "page-toolbar": {
      _id: "page-toolbar",
      _type: "view",
      _children: [
        {
          _id: "open-studio-button",
          _type: "button",
          _text: "Open Studio",
        },
      ],
    },
    "page-footer": {
      _id: "page-footer",
      _type: "view",
      _children: [
        {
          _id: "footer-button",
          _type: "button",
          _text: "Footer",
        },
      ],
    },
  };
  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "toolbar-ref",
        _type: "xvm-view",
        _view_id: "page-toolbar",
      },
      {
        _id: "footer-ref",
        _type: "xvm-view",
        _view_id: "page-footer",
      },
    ],
  };
  const deterministic_ref_move_cross_xai_count_before = xai_generate_count;
  const deterministic_ref_move_cross_result = await (xvibe as any).generate_artifact({
    _prompt: "Update main view only. Move open-studio-button before footer-button. Do not modify anything else.",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-ref-move-cross",
  });
  assert.equal(deterministic_ref_move_cross_result._ok, true);
  assert.equal(deterministic_ref_move_cross_result._result._deterministic, undefined);
  assert.equal(xai_generate_count, deterministic_ref_move_cross_xai_count_before + 1);
  const deterministic_ref_move_cross_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_ref_move_cross_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_ref_move_cross_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_ref_move_cross_mutation_json._eligible, false);
  assert.equal(deterministic_ref_move_cross_mutation_json._reason, "different_source_view");
  assert.equal(deterministic_ref_move_cross_mutation_json._details._target_view_id, "page-toolbar");
  assert.equal(deterministic_ref_move_cross_mutation_json._details._anchor_view_id, "page-footer");

  referenced_views_for_remove = {};
  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
        _style: {
          color: "white",
        },
        class: "music-button",
        style: "display:flex",
      },
    ],
  };
  const deterministic_set_style_by_text_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_set_style_by_text_result = await (xvibe as any).generate_artifact({
    _prompt: "Set Play button background color to green",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-set-style-by-text",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_set_style_by_text_result._ok, true);
  assert.equal(deterministic_set_style_by_text_result._result._deterministic, true);
  assert.equal(deterministic_set_style_by_text_result._result._mutation_action, "set-style");
  assert.equal(deterministic_set_style_by_text_result._result._mutation_target_id, "play-button");
  assert.equal(xai_generate_count, deterministic_set_style_by_text_xai_count_before);
  const deterministic_set_style_by_text_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-set-style-by-text");
  assert.deepEqual(
    deterministic_set_style_by_text_pushed_view._children[0]._style,
    {
      color: "white",
      "background-color": "green",
    },
  );
  assert.equal(deterministic_set_style_by_text_pushed_view._children[0].class, "music-button");
  assert.equal(deterministic_set_style_by_text_pushed_view._children[0].style, "display:flex");
  const deterministic_set_style_by_text_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_set_style_by_text_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_set_style_by_text_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_set_style_by_text_mutation_json._eligible, true);
  assert.equal(deterministic_set_style_by_text_mutation_json._action, "set-style");
  assert.equal(deterministic_set_style_by_text_mutation_json._style_property, "background-color");
  assert.equal(deterministic_set_style_by_text_mutation_json._next_value, "green");
  await assert.rejects(
    readFile(path.join(deterministic_set_style_by_text_run_dir, "final-prompt.txt"), "utf-8"),
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
        _style: {
          "background-color": "red",
        },
      },
    ],
  };
  const deterministic_replace_style_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_replace_style_result = await (xvibe as any).generate_artifact({
    _prompt: "Set Play button background color to green",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-replace-style",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_replace_style_result._ok, true);
  assert.equal(deterministic_replace_style_result._result._deterministic, true);
  assert.equal(xai_generate_count, deterministic_replace_style_xai_count_before);
  const deterministic_replace_style_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-replace-style");
  assert.equal(deterministic_replace_style_pushed_view._children[0]._style["background-color"], "green");
  const deterministic_replace_style_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_replace_style_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_replace_style_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_replace_style_mutation_json._previous_value, "red");
  assert.equal(deterministic_replace_style_mutation_json._next_value, "green");

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
        _style: {
          "background-color": "green",
          color: "white",
        },
      },
    ],
  };
  const deterministic_remove_style_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_remove_style_result = await (xvibe as any).generate_artifact({
    _prompt: "Remove background color from Play button",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-remove-style",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_remove_style_result._ok, true);
  assert.equal(deterministic_remove_style_result._result._deterministic, true);
  assert.equal(deterministic_remove_style_result._result._mutation_action, "remove-style");
  assert.equal(deterministic_remove_style_result._result._mutation_target_id, "play-button");
  assert.equal(xai_generate_count, deterministic_remove_style_xai_count_before);
  const deterministic_remove_style_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-remove-style");
  assert.deepEqual(
    deterministic_remove_style_pushed_view._children[0]._style,
    {
      color: "white",
    },
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
        _style: {
          "background-color": "green",
        },
      },
    ],
  };
  const deterministic_remove_last_style_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_remove_last_style_result = await (xvibe as any).generate_artifact({
    _prompt: "Remove background color from Play button",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-remove-last-style",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_remove_last_style_result._ok, true);
  assert.equal(deterministic_remove_last_style_result._result._deterministic, true);
  assert.equal(xai_generate_count, deterministic_remove_last_style_xai_count_before);
  const deterministic_remove_last_style_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-remove-last-style");
  assert.equal(Object.prototype.hasOwnProperty.call(deterministic_remove_last_style_pushed_view._children[0], "_style"), false);

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "pause-button",
        _type: "button",
        _text: "Pause",
      },
    ],
  };
  const deterministic_create_style_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_create_style_result = await (xvibe as any).generate_artifact({
    _prompt: "Set Pause button color to red",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-create-style",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_create_style_result._ok, true);
  assert.equal(deterministic_create_style_result._result._deterministic, true);
  assert.equal(xai_generate_count, deterministic_create_style_xai_count_before);
  const deterministic_create_style_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-create-style");
  assert.deepEqual(
    deterministic_create_style_pushed_view._children[0]._style,
    {
      color: "red",
    },
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button",
        _type: "button",
        _text: "Play",
      },
    ],
  };
  const deterministic_set_style_by_id_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_set_style_by_id_result = await (xvibe as any).generate_artifact({
    _prompt: "Set play-button font size to 20px",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-set-style-by-id",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_set_style_by_id_result._ok, true);
  assert.equal(deterministic_set_style_by_id_result._result._deterministic, true);
  assert.equal(deterministic_set_style_by_id_result._result._mutation_action, "set-style");
  assert.equal(deterministic_set_style_by_id_result._result._mutation_target_id, "play-button");
  assert.equal(xai_generate_count, deterministic_set_style_by_id_xai_count_before);
  const deterministic_set_style_by_id_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-set-style-by-id");
  assert.deepEqual(
    deterministic_set_style_by_id_pushed_view._children[0]._style,
    {
      "font-size": "20px",
    },
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "play-button-1",
        _type: "button",
        _text: "Play",
      },
      {
        _id: "play-button-2",
        _type: "button",
        _text: "Play",
      },
    ],
  };
  const deterministic_style_ambiguous_xai_count_before = xai_generate_count;
  const deterministic_style_ambiguous_result = await (xvibe as any).generate_artifact({
    _prompt: "Set Play button background color to green",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-style-ambiguous",
  });
  assert.equal(deterministic_style_ambiguous_result._ok, true);
  assert.equal(deterministic_style_ambiguous_result._result._deterministic, undefined);
  assert.equal(xai_generate_count, deterministic_style_ambiguous_xai_count_before + 1);
  const deterministic_style_ambiguous_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_style_ambiguous_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_style_ambiguous_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_style_ambiguous_mutation_json._eligible, false);
  assert.equal(deterministic_style_ambiguous_mutation_json._reason, "ambiguous_text_target");

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "logout-button",
        _type: "button",
        _text: "Logout",
      },
      {
        _id: "play-button",
        _type: "button",
        _text: "▶ Start Music",
      },
      {
        _id: "powered-label",
        _type: "label",
        _text: "Powered by Xpell",
      },
    ],
  };

  const deterministic_update_push_count_before = push_update_count;
  const deterministic_update_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_update_result = await (xvibe as any).generate_artifact({
    _prompt: 'Update main view only. Change play-button text from "▶ Start Music" to "▶ Play". Do not modify anything else.',
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-update-text",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_update_result._ok, true);
  assert.equal(deterministic_update_result._result._deterministic, true);
  assert.equal(deterministic_update_result._result._mutation_action, "update-text");
  assert.equal(deterministic_update_result._result._mutation_target_id, "play-button");
  assert.equal(xai_generate_count, deterministic_update_xai_count_before);
  assert.equal(push_update_count, deterministic_update_push_count_before + 1);
  const deterministic_update_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-update-text");
  assert.equal(deterministic_update_pushed_view._children[1]._id, "play-button");
  assert.equal(deterministic_update_pushed_view._children[1]._text, "▶ Play");
  const deterministic_update_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_update_result_json = JSON.parse(
    await readFile(path.join(deterministic_update_run_dir, "result.json"), "utf-8"),
  );
  assert.equal(deterministic_update_result_json._deterministic, true);
  assert.equal(deterministic_update_result_json._mutation_action, "update-text");
  assert.equal(deterministic_update_result_json._mutation_target_id, "play-button");
  await assert.rejects(
    readFile(path.join(deterministic_update_run_dir, "final-prompt.txt"), "utf-8"),
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "logout-button",
        _type: "button",
        _text: "Logout",
      },
      {
        _id: "play-button",
        _type: "button",
        _text: "Other",
      },
      {
        _id: "powered-label",
        _type: "label",
        _text: "Powered by Xpell",
      },
    ],
  };
  const deterministic_fallback_xai_count_before = xai_generate_count;
  const deterministic_fallback_result = await (xvibe as any).generate_artifact({
    _prompt: 'Update main view only. Change play-button text from "▶ Start Music" to "▶ Play". Do not modify anything else.',
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-fallback-text-mismatch",
  });
  assert.equal(deterministic_fallback_result._ok, true);
  assert.equal(deterministic_fallback_result._result._deterministic, undefined);
  assert.equal(xai_generate_count, deterministic_fallback_xai_count_before + 1);
  const deterministic_fallback_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_fallback_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_fallback_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_fallback_mutation_json._eligible, false);
  assert.equal(deterministic_fallback_mutation_json._reason, "text_mismatch");

  const play_button_text_change_result = await (xvibe as any).generate_artifact({
    _prompt: 'Update main view only. Change play-button text from "▶ Play" to "▶ Start Music". Do not modify anything else.',
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-play-button-text-change",
  });
  assert.equal(play_button_text_change_result._ok, true);
  const play_button_text_change_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const play_button_text_change_resolved_task_json = JSON.parse(
    await readFile(path.join(play_button_text_change_run_dir, "resolved-task.json"), "utf-8"),
  );
  assert.equal(play_button_text_change_resolved_task_json._action, "update");
  const play_button_text_change_runtime_context = JSON.parse(
    await readFile(path.join(play_button_text_change_run_dir, "runtime-context.json"), "utf-8"),
  );
  assert.equal(play_button_text_change_runtime_context._edit_intent._action, "update");
  assert.equal(play_button_text_change_runtime_context._edit_intent._target_id, "play-button");
  assert.equal(play_button_text_change_runtime_context._edit_intent._field, "_text");
  assert.equal(play_button_text_change_runtime_context._edit_intent._target_text, "▶ Play");
  assert.equal(play_button_text_change_runtime_context._edit_intent._replacement_text, "▶ Start Music");
  const play_button_text_change_final_prompt =
    await readFile(path.join(play_button_text_change_run_dir, "final-prompt.txt"), "utf-8");
  assert.ok(play_button_text_change_final_prompt.includes("VIEW EDIT INTENT"));
  assert.ok(play_button_text_change_final_prompt.includes("play-button"));
  assert.ok(play_button_text_change_final_prompt.includes("▶ Play"));
  assert.ok(play_button_text_change_final_prompt.includes("▶ Start Music"));

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "pause-button",
        _type: "button",
        _text: "Pause",
      },
    ],
  };
  const unquoted_pause_push_count_before = push_update_count;
  const unquoted_pause_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const unquoted_pause_text_change_result = await (xvibe as any).generate_artifact({
    _prompt: "Update main view only.\nChange Pause button text to Resume.\nDo not modify anything else.",
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-unquoted-pause-text-change",
  });
  throw_on_xai_generate = false;
  assert.equal(unquoted_pause_text_change_result._ok, true);
  assert.equal(unquoted_pause_text_change_result._result._deterministic, true);
  assert.equal(unquoted_pause_text_change_result._result._mutation_action, "update-text");
  assert.equal(unquoted_pause_text_change_result._result._mutation_target_id, "pause-button");
  assert.equal(xai_generate_count, unquoted_pause_xai_count_before);
  assert.equal(push_update_count, unquoted_pause_push_count_before + 1);
  const unquoted_pause_pushed_view =
    pushed_views_by_generation_id.get("view-edit-unquoted-pause-text-change");
  assert.equal(unquoted_pause_pushed_view._children[0]._id, "pause-button");
  assert.equal(unquoted_pause_pushed_view._children[0]._text, "Resume");
  const unquoted_pause_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const unquoted_pause_mutation_json = JSON.parse(
    await readFile(path.join(unquoted_pause_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(unquoted_pause_mutation_json._eligible, true);
  assert.equal(unquoted_pause_mutation_json._reason, "eligible_text_match");
  assert.equal(unquoted_pause_mutation_json._resolved_by, "text");
  await assert.rejects(
    readFile(path.join(unquoted_pause_run_dir, "final-prompt.txt"), "utf-8"),
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "logout-button",
        _type: "button",
        _text: "Logout",
      },
      {
        _id: "play-button",
        _type: "button",
        _text: "Other",
      },
      {
        _id: "powered-label",
        _type: "label",
        _text: "Powered by Xpell AI",
      },
    ],
  };
  const deterministic_text_match_push_count_before = push_update_count;
  const deterministic_text_match_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const deterministic_text_match_result = await (xvibe as any).generate_artifact({
    _prompt: 'Update main view only. Change "Powered by Xpell AI" to "Powered by Xpell". Do not modify anything else.',
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-deterministic-text-match",
  });
  throw_on_xai_generate = false;
  assert.equal(deterministic_text_match_result._ok, true);
  assert.equal(deterministic_text_match_result._result._deterministic, true);
  assert.equal(deterministic_text_match_result._result._mutation_action, "update-text");
  assert.equal(deterministic_text_match_result._result._mutation_target_id, "powered-label");
  assert.equal(xai_generate_count, deterministic_text_match_xai_count_before);
  assert.equal(push_update_count, deterministic_text_match_push_count_before + 1);
  const deterministic_text_match_pushed_view =
    pushed_views_by_generation_id.get("view-edit-deterministic-text-match");
  assert.equal(deterministic_text_match_pushed_view._children[2]._id, "powered-label");
  assert.equal(deterministic_text_match_pushed_view._children[2]._text, "Powered by Xpell");
  const deterministic_text_match_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const deterministic_text_match_mutation_json = JSON.parse(
    await readFile(path.join(deterministic_text_match_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(deterministic_text_match_mutation_json._resolved_by, "text");
  await assert.rejects(
    readFile(path.join(deterministic_text_match_run_dir, "final-prompt.txt"), "utf-8"),
  );

  current_view_for_remove = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "logout-button",
        _type: "button",
        _text: "Logout",
      },
      {
        _id: "play-button",
        _type: "button",
        _text: "Other",
      },
      {
        _id: "powered-label",
        _type: "label",
        _text: "Powered by Xpell",
      },
    ],
  };
  const text_change_push_count_before = push_update_count;
  const text_change_xai_count_before = xai_generate_count;
  throw_on_xai_generate = true;
  const text_change_result = await (xvibe as any).generate_artifact({
    _prompt: 'Update main view only. Change "Powered by Xpell" to "Powered by Xpell AI". Do not modify anything else.',
    _app_id: "view-edit-refine-app",
    _env: "test",
    _generation_id: "view-edit-text-change",
  });
  throw_on_xai_generate = false;
  assert.equal(text_change_result._ok, true);
  assert.equal(text_change_result._result._deterministic, true);
  assert.equal(text_change_result._result._mutation_action, "update-text");
  assert.equal(text_change_result._result._mutation_target_id, "powered-label");
  assert.equal(xai_generate_count, text_change_xai_count_before);
  assert.equal(push_update_count, text_change_push_count_before + 1);
  const text_change_pushed_view =
    pushed_views_by_generation_id.get("view-edit-text-change");
  assert.equal(text_change_pushed_view._children[2]._id, "powered-label");
  assert.equal(text_change_pushed_view._children[2]._text, "Powered by Xpell AI");
  const text_change_run_dir =
    await latest_vibe_run_dir(view_edit_refine_work_folder, "view-edit-refine-app");
  const text_change_runtime_context = JSON.parse(
    await readFile(path.join(text_change_run_dir, "runtime-context.json"), "utf-8"),
  );
  assert.equal(text_change_runtime_context._edit_intent._action, "update");
  assert.equal(text_change_runtime_context._edit_intent._target_id, "powered-label");
  assert.equal(text_change_runtime_context._edit_intent._field, "_text");
  assert.equal(text_change_runtime_context._edit_intent._target_text, "Powered by Xpell");
  assert.equal(text_change_runtime_context._edit_intent._replacement_text, "Powered by Xpell AI");
  const text_change_mutation_json = JSON.parse(
    await readFile(path.join(text_change_run_dir, "deterministic-mutation.json"), "utf-8"),
  );
  assert.equal(text_change_mutation_json._eligible, true);
  assert.equal(text_change_mutation_json._reason, "eligible_text_match");
  assert.equal(text_change_mutation_json._resolved_by, "text");
  await assert.rejects(
    readFile(path.join(text_change_run_dir, "final-prompt.txt"), "utf-8"),
  );
  const text_change_selected_ids =
    await read_selected_skill_ids(text_change_run_dir);
  assert.ok(text_change_selected_ids.includes("view"));
  assert.ok(text_change_selected_ids.includes("label"));
  assert.equal(text_change_selected_ids.includes("entity-runtime"), false);
  assert.equal(text_change_selected_ids.includes("xui-events"), false);
  assert.equal(text_change_selected_ids.includes("xui-flow-trigger"), false);
  assert.equal(text_change_selected_ids.includes("xfm-flow"), false);
} finally {
  (_xlog as any).log = original_view_edit_log;
  (_x as any).execute = original_execute;
  (_x as any).getSkills = original_get_skills;
  (_x as any).getModule = original_get_module;
  await rm(view_edit_refine_work_folder, { recursive: true, force: true });
}

const referenced_view_persist_work_folder =
  await mkdtemp(path.join(tmpdir(), "xvibe-ref-view-persist-"));
try {
  const referenced_view_persist_server_xvm =
    new ServerXVMModule({ _work_folder: referenced_view_persist_work_folder });
  const referenced_view_persist_runtime_skills = {
    _modules: [
      {
        _objects: [
          { _id: "view" },
          { _id: "button" },
          { _id: "xvm-view" },
        ],
      },
    ],
  };
  const referenced_view_persist_app_id = "referenced-view-persist-app";
  const referenced_view_persist_env = "test";
  const referenced_view_persist_main = {
    _id: "main",
    _type: "view",
    _children: [
      {
        _id: "toolbar-ref",
        _type: "xvm-view",
        _view_id: "page-toolbar",
      },
    ],
  };
  const referenced_view_persist_toolbar = {
    _id: "page-toolbar",
    _type: "view",
    _children: [
      {
        _id: "new-record-button",
        _type: "button",
        _text: "+ New Record",
      },
      {
        _id: "refresh-button",
        _type: "button",
        _text: "Refresh",
      },
    ],
  };
  await (referenced_view_persist_server_xvm as any)._create_app({
    _params: {
      _app_id: referenced_view_persist_app_id,
      _env: referenced_view_persist_env,
      _entry_view_id: "main",
    },
  });
  await (referenced_view_persist_server_xvm as any)._push_update({
    _params: {
      _app_id: referenced_view_persist_app_id,
      _env: referenced_view_persist_env,
      _view: referenced_view_persist_main,
    },
  });
  await (referenced_view_persist_server_xvm as any)._push_update({
    _params: {
      _app_id: referenced_view_persist_app_id,
      _env: referenced_view_persist_env,
      _view: referenced_view_persist_toolbar,
    },
  });

  const referenced_view_persist_views_dir =
    path.join(
      referenced_view_persist_work_folder,
      "xvm",
      "apps",
      referenced_view_persist_env,
      referenced_view_persist_app_id,
      "views",
    );
  const referenced_view_persist_main_file =
    path.join(referenced_view_persist_views_dir, "main.json");
  const referenced_view_persist_toolbar_file =
    path.join(referenced_view_persist_views_dir, "page-toolbar.json");
  const referenced_view_persist_main_before =
    await readFile(referenced_view_persist_main_file, "utf-8");
  const referenced_view_persist_toolbar_before =
    await readFile(referenced_view_persist_toolbar_file, "utf-8");
  const referenced_view_persist_logs: any[] = [];
  const referenced_view_persist_original_log = _xlog.log;
  let referenced_view_persist_xai_generate_count = 0;

  (_xlog as any).log = (message: string, data?: any) => {
    if (message === "[xvibe] deterministic referenced view persist") {
      referenced_view_persist_logs.push(data);
    }
    return referenced_view_persist_original_log.call(_xlog, message, data);
  };
  (xvibe as any).latest_runtime_skills = referenced_view_persist_runtime_skills;
  (_x as any).getModule = (name: string) =>
    name === "server-xvm"
      ? referenced_view_persist_server_xvm
      : typeof original_get_module === "function"
        ? original_get_module.call(_x, name)
        : undefined;
  (_x as any).getSkills = () => referenced_view_persist_runtime_skills;
  (_x as any).execute = async (command: any) => {
    if (command?._module === "server-xvm") {
      const method_name = `_${String(command?._op ?? "").replace(/-/gu, "_")}`;
      const method = (referenced_view_persist_server_xvm as any)[method_name];
      if (typeof method === "function") {
        return method.call(referenced_view_persist_server_xvm, command);
      }
    }

    if (command?._module === "xai" && command?._op === "generate") {
      referenced_view_persist_xai_generate_count += 1;
      throw new Error("xai.generate should not be called for deterministic referenced view persistence");
    }

    throw new Error(`Unexpected command ${JSON.stringify(command)}`);
  };

  const referenced_view_persist_result = await (xvibe as any).generate_artifact({
    _prompt: 'Update main view only.\nRemove button "+ New Record".\nDo not modify anything else.',
    _app_id: referenced_view_persist_app_id,
    _env: referenced_view_persist_env,
    _generation_id: "view-edit-deterministic-ref-persist",
  });
  assert.equal(referenced_view_persist_result._ok, true);
  assert.equal(referenced_view_persist_result._result._deterministic, true);
  assert.equal(referenced_view_persist_result._result._artifact_id, "page-toolbar");
  assert.equal(referenced_view_persist_result._result._source_view_id, "page-toolbar");
  assert.equal(referenced_view_persist_result._result._requested_view_id, "main");
  assert.equal(referenced_view_persist_result._result._mutation_action, "remove-object");
  assert.equal(referenced_view_persist_result._result._mutation_target_id, "new-record-button");
  assert.equal(referenced_view_persist_xai_generate_count, 0);
  assert.deepEqual(referenced_view_persist_logs, [
    {
      _requested_view_id: "main",
      _source_view_id: "page-toolbar",
      _view_id: "page-toolbar",
      _target_id: "new-record-button",
      _action: "remove-object",
    },
  ]);

  const referenced_view_persist_main_after =
    await readFile(referenced_view_persist_main_file, "utf-8");
  const referenced_view_persist_toolbar_after =
    await readFile(referenced_view_persist_toolbar_file, "utf-8");
  assert.equal(referenced_view_persist_main_after, referenced_view_persist_main_before);
  assert.notEqual(referenced_view_persist_toolbar_after, referenced_view_persist_toolbar_before);
  const referenced_view_persist_toolbar_json =
    JSON.parse(referenced_view_persist_toolbar_after);
  const referenced_view_persist_main_json =
    JSON.parse(referenced_view_persist_main_after);
  assert.equal(xmutator.has_id(referenced_view_persist_toolbar_json, "new-record-button"), false);
  assert.equal(xmutator.has_id(referenced_view_persist_toolbar_json, "refresh-button"), true);
  assert.deepEqual(referenced_view_persist_main_json, referenced_view_persist_main);

  const referenced_view_persist_reloaded_server_xvm =
    new ServerXVMModule({ _work_folder: referenced_view_persist_work_folder });
  await (referenced_view_persist_reloaded_server_xvm as any)._load_app_from_disk({
    _params: {
      _app_id: referenced_view_persist_app_id,
      _env: referenced_view_persist_env,
    },
  });
  const referenced_view_persist_reloaded_toolbar =
    await (referenced_view_persist_reloaded_server_xvm as any)._get_view({
      _params: {
        _app_id: referenced_view_persist_app_id,
        _env: referenced_view_persist_env,
        _view_id: "page-toolbar",
      },
    });
  const referenced_view_persist_reloaded_main =
    await (referenced_view_persist_reloaded_server_xvm as any)._get_view({
      _params: {
        _app_id: referenced_view_persist_app_id,
        _env: referenced_view_persist_env,
        _view_id: "main",
      },
    });
  assert.equal(
    xmutator.has_id(referenced_view_persist_reloaded_toolbar._result._view, "new-record-button"),
    false,
  );
  assert.equal(
    xmutator.has_id(referenced_view_persist_reloaded_toolbar._result._view, "refresh-button"),
    true,
  );
  assert.deepEqual(
    referenced_view_persist_reloaded_main._result._view,
    referenced_view_persist_main,
  );
} finally {
  (_xlog as any).log = original_view_edit_log;
  (_x as any).execute = original_execute;
  (_x as any).getSkills = original_get_skills;
  (_x as any).getModule = original_get_module;
  await rm(referenced_view_persist_work_folder, { recursive: true, force: true });
}

const apply_view_edit_work_folder =
  await mkdtemp(path.join(tmpdir(), "xvibe-apply-view-edit-"));
try {
  const apply_view_edit_server_xvm =
    new ServerXVMModule({ _work_folder: apply_view_edit_work_folder });
  const apply_view_edit_xvibe = new XVibeModule();
  const apply_view_edit_app_id = "apply-view-edit-app";
  const apply_view_edit_env = "test";
  let apply_view_edit_xai_generate_count = 0;
  let apply_view_edit_push_update_count = 0;
  const apply_view_edit_push_update_view_ids: string[] = [];
  const apply_view_edit_runtime_skills = {
    _modules: [
      {
        _objects: [
          { _id: "view" },
          { _id: "button" },
          { _id: "label" },
          { _id: "toolbar" },
          { _id: "stack" },
          { _id: "grid" },
          { _id: "xvm-view" },
          {
            _id: "kpi-card",
            _design: {
              _inspector: {
                _fields: [
                  { _key: "_value", _label: "Value", _input: "text" },
                  { _key: "_label", _label: "Label", _input: "text" },
                  { _key: "_delta", _label: "Delta", _input: "text" },
                  { _key: "_trend", _label: "Trend", _input: "text" },
                  { _key: "_icon", _label: "Icon", _input: "text" },
                  { _key: "_variant", _label: "Variant", _input: "text" },
                  { _key: "_config", _label: "Config", _input: "json" },
                ],
              },
            },
          },
        ],
      },
    ],
  };

  await (apply_view_edit_server_xvm as any)._create_app({
    _params: {
      _app_id: apply_view_edit_app_id,
      _env: apply_view_edit_env,
      _entry_view_id: "main",
    },
  });
  await (apply_view_edit_server_xvm as any)._push_update({
    _params: {
      _app_id: apply_view_edit_app_id,
      _env: apply_view_edit_env,
      _view: {
        _id: "main",
        _type: "view",
        _children: [
          {
            _id: "main-title",
            _type: "label",
            _text: "Original Title",
            class: "title old",
          },
          {
            _id: "toolbar-ref",
            _type: "xvm-view",
            _view_id: "page-toolbar",
          },
        ],
      },
    },
  });
  await (apply_view_edit_server_xvm as any)._push_update({
    _params: {
      _app_id: apply_view_edit_app_id,
      _env: apply_view_edit_env,
      _view: {
        _id: "layout-view",
        _type: "view",
        _children: [
          {
            _id: "stack-panel",
            _type: "stack",
            _children: [
              {
                _id: "stack-existing",
                _type: "label",
                _text: "Existing Stack",
              },
            ],
          },
          {
            _id: "grid-panel",
            _type: "grid",
            _children: [
              {
                _id: "grid-existing",
                _type: "label",
                _text: "Existing Grid",
              },
            ],
          },
          {
            _id: "childless-label",
            _type: "label",
            _text: "No Children",
          },
        ],
      },
    },
  });
  await (apply_view_edit_server_xvm as any)._push_update({
    _params: {
      _app_id: apply_view_edit_app_id,
      _env: apply_view_edit_env,
      _view: {
        _id: "add-ref-host",
        _type: "view",
        _children: [
          {
            _id: "add-ref",
            _type: "xvm-view",
            _view_id: "add-ref-source",
          },
        ],
      },
    },
  });
  await (apply_view_edit_server_xvm as any)._push_update({
    _params: {
      _app_id: apply_view_edit_app_id,
      _env: apply_view_edit_env,
      _view: {
        _id: "add-ref-source",
        _type: "view",
        _children: [
          {
            _id: "ref-stack",
            _type: "stack",
            _children: [],
          },
        ],
      },
    },
  });
  await (apply_view_edit_server_xvm as any)._push_update({
    _params: {
      _app_id: apply_view_edit_app_id,
      _env: apply_view_edit_env,
      _view: {
        _id: "page-toolbar",
        _type: "view",
        _children: [
          {
            _id: "toolbar-button",
            _type: "button",
            _text: "Create",
            style: "color:red",
          },
          {
            _id: "settings-button",
            _type: "button",
            _text: "Settings",
          },
          {
            _id: "export-button",
            _type: "button",
            _text: "Export",
          },
          {
            _id: "toolbar-group",
            _type: "toolbar",
            _children: [
              {
                _id: "nested-action",
                _type: "button",
                _text: "Nested",
              },
            ],
          },
        ],
      },
    },
  });
  await (apply_view_edit_server_xvm as any)._push_update({
    _params: {
      _app_id: apply_view_edit_app_id,
      _env: apply_view_edit_env,
      _view: {
        _id: "design-host",
        _type: "view",
        _children: [
          {
            _id: "design-source-ref",
            _type: "xvm-view",
            _view_id: "design-source",
          },
        ],
      },
    },
  });
  await (apply_view_edit_server_xvm as any)._push_update({
    _params: {
      _app_id: apply_view_edit_app_id,
      _env: apply_view_edit_env,
      _view: {
        _id: "design-source",
        _type: "view",
        _children: [
          {
            _id: "kpi-card-1",
            _type: "kpi-card",
            _value: "10",
            _label: "Revenue",
            _delta: "+1%",
            _trend: "up",
            _icon: "line-chart",
            _variant: "positive",
          },
        ],
      },
    },
  });

  (xvibe as any).latest_runtime_skills = apply_view_edit_runtime_skills;
  (_x as any).getModule = (name: string) =>
    name === "server-xvm"
      ? apply_view_edit_server_xvm
      : typeof original_get_module === "function"
        ? original_get_module.call(_x, name)
        : undefined;
  (_x as any).getSkills = () => apply_view_edit_runtime_skills;
  (_x as any).execute = async (command: any) => {
    if (command?._module === "server-xvm") {
      const method_name = `_${String(command?._op ?? "").replace(/-/gu, "_")}`;
      const method = (apply_view_edit_server_xvm as any)[method_name];
      if (typeof method === "function") {
        if (method_name === "_push_update") {
          apply_view_edit_push_update_count += 1;
          const view_id =
            typeof command?._params?._view?._id === "string"
              ? command._params._view._id
              : "";
          if (view_id) apply_view_edit_push_update_view_ids.push(view_id);
        }
        return method.call(apply_view_edit_server_xvm, command);
      }
    }

    if (command?._module === "xai" && command?._op === "generate") {
      apply_view_edit_xai_generate_count += 1;
      throw new Error("xai.generate should not be called for xvibe.apply-view-edit");
    }

    throw new Error(`Unexpected command ${JSON.stringify(command)}`);
  };

  const apply_view_edit_text_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
        _edit_action: "set-property",
        _target_id: "main-title",
        _target_type: "label",
        _property_name: "_text",
        _property_value: "Updated Title",
      },
    });
  assert.equal(apply_view_edit_text_result._ok, true);
  assert.equal(apply_view_edit_text_result._artifact_type, "view");
  assert.equal(apply_view_edit_text_result._artifact_id, "main");
  assert.equal(apply_view_edit_text_result._deterministic, true);
  assert.equal(apply_view_edit_text_result._mutation_action, "set-property");
  assert.equal(apply_view_edit_text_result._target_id, "main-title");
  assert.equal(apply_view_edit_text_result._result._mutation._property_name, "_text");

  const apply_view_edit_main_after_text =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
      },
    });
  assert.equal(
    apply_view_edit_main_after_text._result._view._children[0]._text,
    "Updated Title",
  );

  const apply_view_edit_class_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
        _edit_action: "set-property",
        _target_id: "main-title",
        _target_type: "label",
        _property_name: "class",
        _property_value: "title new",
      },
    });
  assert.equal(apply_view_edit_class_result._ok, true);
  assert.equal(apply_view_edit_class_result._mutation_action, "set-property");
  assert.equal(apply_view_edit_class_result._result._mutation._property_name, "class");
  const apply_view_edit_main_after_class =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
      },
    });
  assert.equal(
    apply_view_edit_main_after_class._result._view._children[0].class,
    "title new",
  );

  const apply_view_edit_design_value_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "design-source",
        _edit_action: "set-property",
        _target_id: "kpi-card-1",
        _target_type: "kpi-card",
        _property_name: "_value",
        _property_value: "42",
      },
    });
  assert.equal(apply_view_edit_design_value_result._ok, true);
  assert.equal(apply_view_edit_design_value_result._mutation_action, "set-property");
  assert.equal(apply_view_edit_design_value_result._result._mutation._property_name, "_value");

  for (const [field, value] of [
    ["_label", "Active Users"],
    ["_delta", "+12%"],
    ["_trend", "down"],
    ["_icon", "users"],
    ["_variant", "warning"],
  ] as const) {
    const apply_view_edit_design_field_result =
      await (apply_view_edit_xvibe as any)._apply_view_edit({
        _params: {
          _app_id: apply_view_edit_app_id,
          _env: apply_view_edit_env,
          _view_id: "design-source",
          _edit_action: "set-property",
          _target_id: "kpi-card-1",
          _target_type: "kpi-card",
          _property_name: field,
          _property_value: value,
        },
      });
    assert.equal(apply_view_edit_design_field_result._ok, true);
    assert.equal(apply_view_edit_design_field_result._result._mutation._property_name, field);
  }

  const apply_view_edit_design_after_fields =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "design-source",
      },
    });
  const apply_view_edit_design_kpi_after_fields =
    find_xui_node_for_test(apply_view_edit_design_after_fields._result._view, "kpi-card-1")!;
  assert.equal(apply_view_edit_design_kpi_after_fields._value, "42");
  assert.equal(apply_view_edit_design_kpi_after_fields._label, "Active Users");
  assert.equal(apply_view_edit_design_kpi_after_fields._delta, "+12%");
  assert.equal(apply_view_edit_design_kpi_after_fields._trend, "down");
  assert.equal(apply_view_edit_design_kpi_after_fields._icon, "users");
  assert.equal(apply_view_edit_design_kpi_after_fields._variant, "warning");

  const apply_view_edit_push_count_before_unknown_design_field =
    apply_view_edit_push_update_count;
  const apply_view_edit_design_unknown_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "design-source",
        _edit_action: "set-property",
        _target_id: "kpi-card-1",
        _target_type: "kpi-card",
        _property_name: "_unknown",
        _property_value: "Nope",
      },
    });
  assert.equal(apply_view_edit_design_unknown_result._ok, false);
  assert.equal(apply_view_edit_design_unknown_result._reason, "unsupported_property");
  assert.equal(
    apply_view_edit_push_update_count,
    apply_view_edit_push_count_before_unknown_design_field,
  );

  const apply_view_edit_push_count_before_object_value =
    apply_view_edit_push_update_count;
  const apply_view_edit_design_object_rejected_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "design-source",
        _edit_action: "set-property",
        _target_id: "kpi-card-1",
        _target_type: "kpi-card",
        _property_name: "_value",
        _property_value: { _raw: 42 },
      },
    });
  assert.equal(apply_view_edit_design_object_rejected_result._ok, false);
  assert.equal(apply_view_edit_design_object_rejected_result._reason, "unsupported_property_value");
  assert.equal(
    apply_view_edit_push_update_count,
    apply_view_edit_push_count_before_object_value,
  );

  const apply_view_edit_push_count_before_array_value =
    apply_view_edit_push_update_count;
  const apply_view_edit_design_array_rejected_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "design-source",
        _edit_action: "set-property",
        _target_id: "kpi-card-1",
        _target_type: "kpi-card",
        _property_name: "_value",
        _property_value: [42],
      },
    });
  assert.equal(apply_view_edit_design_array_rejected_result._ok, false);
  assert.equal(apply_view_edit_design_array_rejected_result._reason, "unsupported_property_value");
  assert.equal(
    apply_view_edit_push_update_count,
    apply_view_edit_push_count_before_array_value,
  );

  const apply_view_edit_design_json_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "design-source",
        _edit_action: "set-property",
        _target_id: "kpi-card-1",
        _target_type: "kpi-card",
        _property_name: "_config",
        _property_value: {
          _format: "compact",
          _thresholds: [10, 20],
        },
      },
    });
  assert.equal(apply_view_edit_design_json_result._ok, true);
  const apply_view_edit_design_json_array_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "design-source",
        _edit_action: "set-property",
        _target_id: "kpi-card-1",
        _target_type: "kpi-card",
        _property_name: "_config",
        _property_value: [
          { _format: "wide" },
          { _format: "compact" },
        ],
      },
    });
  assert.equal(apply_view_edit_design_json_array_result._ok, true);
  const apply_view_edit_design_after_json =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "design-source",
      },
    });
  assert.deepEqual(
    find_xui_node_for_test(apply_view_edit_design_after_json._result._view, "kpi-card-1")?._config,
    [
      { _format: "wide" },
      { _format: "compact" },
    ],
  );

  const apply_view_edit_design_host_before =
    JSON.stringify((await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "design-host",
      },
    }))._result._view);
  const apply_view_edit_design_ref_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "design-host",
        _source_view_id: "design-source",
        _edit_action: "set-property",
        _target_id: "kpi-card-1",
        _target_type: "kpi-card",
        _property_name: "_value",
        _property_value: "84",
      },
    });
  assert.equal(apply_view_edit_design_ref_result._ok, true);
  assert.equal(apply_view_edit_design_ref_result._view_id, "design-host");
  assert.equal(apply_view_edit_design_ref_result._source_view_id, "design-source");
  assert.equal(apply_view_edit_design_ref_result._persisted_view_id, "design-source");
  const apply_view_edit_design_after_ref =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "design-source",
      },
    });
  assert.equal(
    find_xui_node_for_test(apply_view_edit_design_after_ref._result._view, "kpi-card-1")?._value,
    "84",
  );
  const apply_view_edit_design_host_after =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "design-host",
      },
    });
  assert.equal(JSON.stringify(apply_view_edit_design_host_after._result._view), apply_view_edit_design_host_before);

  const apply_view_edit_add_view_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "layout-view",
        _edit_action: "add-child",
        _target_id: "layout-view",
        _child: {
          _type: "button",
          _text: "Root Added",
        },
      },
    });
  assert.equal(apply_view_edit_add_view_result._ok, true);
  assert.equal(apply_view_edit_add_view_result._mutation_action, "add-child");
  assert.equal(apply_view_edit_add_view_result._target_id, "layout-view");
  assert.equal(apply_view_edit_add_view_result._parent_id, "layout-view");
  assert.equal(apply_view_edit_add_view_result._insert_index, 3);
  assert.equal(apply_view_edit_add_view_result._result._mutation._child_id, "button");
  assert.equal(apply_view_edit_add_view_result._result._mutation._child_type, "button");
  const apply_view_edit_layout_after_add_view =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "layout-view",
      },
    });
  assert.deepEqual(
    apply_view_edit_layout_after_add_view._result._view._children.map((child: any) => child._id),
    ["stack-panel", "grid-panel", "childless-label", "button"],
  );
  assert.deepEqual(
    apply_view_edit_layout_after_add_view._result._view._children[3],
    {
      _type: "button",
      _text: "Root Added",
      _id: "button",
    },
  );

  const apply_view_edit_add_stack_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "layout-view",
        _edit_action: "add-child",
        _target_id: "stack-panel",
        _target_type: "stack",
        _child: {
          _id: "stack-added",
          _type: "label",
          _text: "Stack Added",
        },
      },
    });
  assert.equal(apply_view_edit_add_stack_result._ok, true);
  assert.equal(apply_view_edit_add_stack_result._mutation_action, "add-child");
  assert.equal(apply_view_edit_add_stack_result._result._mutation._child_id, "stack-added");
  assert.equal(apply_view_edit_add_stack_result._insert_index, 1);
  const apply_view_edit_layout_after_add_stack =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "layout-view",
      },
    });
  const apply_view_edit_stack_after_add =
    find_xui_node_for_test(apply_view_edit_layout_after_add_stack._result._view, "stack-panel");
  assert.ok(apply_view_edit_stack_after_add);
  assert.deepEqual(
    (apply_view_edit_stack_after_add._children as any[]).map((child) => child._id),
    ["stack-existing", "stack-added"],
  );

  const apply_view_edit_add_grid_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "layout-view",
        _edit_action: "add-child",
        _target_id: "grid-panel",
        _target_type: "grid",
        _child: {
          _id: "grid-added",
          _type: "button",
          _text: "Grid Added",
        },
      },
    });
  assert.equal(apply_view_edit_add_grid_result._ok, true);
  assert.equal(apply_view_edit_add_grid_result._mutation_action, "add-child");
  assert.equal(apply_view_edit_add_grid_result._result._mutation._child_id, "grid-added");
  assert.equal(apply_view_edit_add_grid_result._insert_index, 1);
  const apply_view_edit_layout_after_add_grid =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "layout-view",
      },
    });
  const apply_view_edit_grid_after_add =
    find_xui_node_for_test(apply_view_edit_layout_after_add_grid._result._view, "grid-panel");
  assert.ok(apply_view_edit_grid_after_add);
  assert.deepEqual(
    (apply_view_edit_grid_after_add._children as any[]).map((child) => child._id),
    ["grid-existing", "grid-added"],
  );

  const apply_view_edit_add_duplicate_id_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "layout-view",
        _edit_action: "add-child",
        _target_id: "layout-view",
        _child: {
          _id: "stack-added",
          _type: "label",
          _text: "Duplicate Replaced",
        },
      },
    });
  assert.equal(apply_view_edit_add_duplicate_id_result._ok, true);
  assert.equal(apply_view_edit_add_duplicate_id_result._mutation_action, "add-child");
  assert.equal(apply_view_edit_add_duplicate_id_result._result._mutation._child_id, "stack-added-2");
  const apply_view_edit_layout_after_duplicate_id =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "layout-view",
      },
    });
  assert.deepEqual(
    apply_view_edit_layout_after_duplicate_id._result._view._children.map((child: any) => child._id),
    ["stack-panel", "grid-panel", "childless-label", "button", "stack-added-2"],
  );
  assert.equal(
    find_xui_node_for_test(apply_view_edit_layout_after_duplicate_id._result._view, "stack-added-2")?._text,
    "Duplicate Replaced",
  );

  const apply_view_edit_add_ref_host_before =
    await readFile(
      path.join(
        apply_view_edit_work_folder,
        "xvm",
        "apps",
        apply_view_edit_env,
        apply_view_edit_app_id,
        "views",
        "add-ref-host.json",
      ),
      "utf-8",
    );
  const apply_view_edit_add_ref_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "add-ref-host",
        _source_view_id: "add-ref-source",
        _edit_action: "add-child",
        _target_id: "ref-stack",
        _target_type: "stack",
        _child: {
          _type: "button",
          _text: "Referenced Add",
        },
      },
    });
  assert.equal(apply_view_edit_add_ref_result._ok, true);
  assert.equal(apply_view_edit_add_ref_result._view_id, "add-ref-host");
  assert.equal(apply_view_edit_add_ref_result._source_view_id, "add-ref-source");
  assert.equal(apply_view_edit_add_ref_result._persisted_view_id, "add-ref-source");
  assert.equal(apply_view_edit_add_ref_result._mutation_action, "add-child");
  assert.equal(apply_view_edit_add_ref_result._result._mutation._child_id, "button");
  const apply_view_edit_add_ref_host_after =
    await readFile(
      path.join(
        apply_view_edit_work_folder,
        "xvm",
        "apps",
        apply_view_edit_env,
        apply_view_edit_app_id,
        "views",
        "add-ref-host.json",
      ),
      "utf-8",
    );
  assert.equal(apply_view_edit_add_ref_host_after, apply_view_edit_add_ref_host_before);
  const apply_view_edit_add_ref_source_after =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "add-ref-source",
      },
    });
  const apply_view_edit_ref_stack_after_add =
    find_xui_node_for_test(apply_view_edit_add_ref_source_after._result._view, "ref-stack");
  assert.ok(apply_view_edit_ref_stack_after_add);
  assert.deepEqual(
    apply_view_edit_ref_stack_after_add._children,
    [
      {
        _type: "button",
        _text: "Referenced Add",
        _id: "button",
      },
    ],
  );

  const apply_view_edit_push_count_before_add_missing =
    apply_view_edit_push_update_count;
  const apply_view_edit_add_missing_target_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "layout-view",
        _edit_action: "add-child",
        _target_id: "missing-container",
        _child: {
          _type: "button",
        },
      },
    });
  assert.equal(apply_view_edit_add_missing_target_result._ok, false);
  assert.equal(apply_view_edit_add_missing_target_result._reason, "target_not_found");
  assert.equal(
    apply_view_edit_push_update_count,
    apply_view_edit_push_count_before_add_missing,
  );

  const apply_view_edit_push_count_before_add_childless =
    apply_view_edit_push_update_count;
  const apply_view_edit_add_childless_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "layout-view",
        _edit_action: "add-child",
        _target_id: "childless-label",
        _target_type: "label",
        _child: {
          _type: "button",
        },
      },
    });
  assert.equal(apply_view_edit_add_childless_result._ok, false);
  assert.equal(apply_view_edit_add_childless_result._reason, "target_without_children");
  assert.equal(
    apply_view_edit_push_update_count,
    apply_view_edit_push_count_before_add_childless,
  );

  const apply_view_edit_hide_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
        _edit_action: "hide-object",
        _target_id: "main-title",
        _target_type: "label",
      },
    });
  assert.equal(apply_view_edit_hide_result._ok, true);
  assert.equal(apply_view_edit_hide_result._mutation_action, "hide-object");
  assert.equal(apply_view_edit_hide_result._target_id, "main-title");
  assert.equal(apply_view_edit_hide_result._parent_id, "main");
  assert.equal(apply_view_edit_hide_result._hide_mechanism, "style.display:none");
  assert.equal(apply_view_edit_hide_result._result._mutation._hide_mechanism, "style.display:none");
  const apply_view_edit_main_after_hide =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
      },
    });
  assert.deepEqual(
    apply_view_edit_main_after_hide._result._view._children.map((child: any) => child._id),
    ["main-title", "toolbar-ref"],
  );
  assert.equal(
    test_style_has_display_none(apply_view_edit_main_after_hide._result._view._children[0].style),
    true,
  );
  assert.equal(apply_view_edit_main_after_hide._result._view._children[0]._visible, false);
  assert.equal(apply_view_edit_main_after_hide._result._view._children[0]._id, "main-title");

  const apply_view_edit_show_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
        _edit_action: "show-object",
        _target_id: "main-title",
        _target_type: "label",
      },
    });
  assert.equal(apply_view_edit_show_result._ok, true);
  assert.equal(apply_view_edit_show_result._mutation_action, "show-object");
  assert.equal(apply_view_edit_show_result._target_id, "main-title");
  assert.equal(apply_view_edit_show_result._parent_id, "main");
  assert.equal(apply_view_edit_show_result._show_mechanism, "remove-style.display:none");
  assert.equal(apply_view_edit_show_result._result._mutation._show_mechanism, "remove-style.display:none");
  const apply_view_edit_main_after_show =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
      },
    });
  assert.equal(apply_view_edit_main_after_show._result._view._children[0].style, undefined);
  assert.equal(apply_view_edit_main_after_show._result._view._children[0]._visible, true);
  assert.equal(apply_view_edit_main_after_show._result._view._children[0].class, "title new");

  const apply_view_edit_main_before_source =
    JSON.stringify(apply_view_edit_main_after_show._result._view);
  const apply_view_edit_source_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
        _edit_action: "set-property",
        _target_id: "toolbar-button",
        _target_type: "button",
        _property_name: "_text",
        _property_value: "New Record",
      },
    });
  assert.equal(apply_view_edit_source_result._ok, true);
  assert.equal(apply_view_edit_source_result._artifact_id, "page-toolbar");
  assert.equal(apply_view_edit_source_result._target_id, "toolbar-button");
  const apply_view_edit_toolbar_after_source =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
      },
    });
  assert.equal(
    apply_view_edit_toolbar_after_source._result._view._children[0]._text,
    "New Record",
  );
  const apply_view_edit_main_after_source =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
      },
    });
  assert.equal(
    JSON.stringify(apply_view_edit_main_after_source._result._view),
    apply_view_edit_main_before_source,
  );

  const apply_view_edit_source_hide_main_before =
    JSON.stringify(apply_view_edit_main_after_source._result._view);
  const apply_view_edit_source_hide_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
        _edit_action: "hide-object",
        _target_id: "toolbar-button",
        _target_type: "button",
      },
    });
  assert.equal(apply_view_edit_source_hide_result._ok, true);
  assert.equal(apply_view_edit_source_hide_result._artifact_id, "page-toolbar");
  assert.equal(apply_view_edit_source_hide_result._mutation_action, "hide-object");
  assert.equal(apply_view_edit_source_hide_result._target_id, "toolbar-button");
  assert.equal(apply_view_edit_source_hide_result._parent_id, "page-toolbar");
  assert.equal(apply_view_edit_source_hide_result._hide_mechanism, "style.display:none");
  const apply_view_edit_toolbar_after_source_hide =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
      },
    });
  assert.deepEqual(
    apply_view_edit_toolbar_after_source_hide._result._view._children.map((child: any) => child._id),
    ["toolbar-button", "settings-button", "export-button", "toolbar-group"],
  );
  assert.equal(
    apply_view_edit_toolbar_after_source_hide._result._view._children[0].style,
    "color:red; display:none",
  );
  assert.equal(apply_view_edit_toolbar_after_source_hide._result._view._children[0]._visible, false);
  const apply_view_edit_main_after_source_hide =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
      },
    });
  assert.equal(
    JSON.stringify(apply_view_edit_main_after_source_hide._result._view),
    apply_view_edit_source_hide_main_before,
  );

  const apply_view_edit_source_show_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
        _edit_action: "show-object",
        _target_id: "toolbar-button",
        _target_type: "button",
      },
    });
  assert.equal(apply_view_edit_source_show_result._ok, true);
  assert.equal(apply_view_edit_source_show_result._artifact_id, "page-toolbar");
  assert.equal(apply_view_edit_source_show_result._mutation_action, "show-object");
  assert.equal(apply_view_edit_source_show_result._target_id, "toolbar-button");
  assert.equal(apply_view_edit_source_show_result._parent_id, "page-toolbar");
  assert.equal(apply_view_edit_source_show_result._show_mechanism, "remove-style.display:none");
  const apply_view_edit_toolbar_after_source_show =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
      },
    });
  assert.equal(
    apply_view_edit_toolbar_after_source_show._result._view._children[0].style,
    "color:red",
  );
  assert.equal(apply_view_edit_toolbar_after_source_show._result._view._children[0]._visible, true);

  const apply_view_edit_move_source_main_before =
    JSON.stringify(apply_view_edit_main_after_source_hide._result._view);
  const apply_view_edit_move_after_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
        _edit_action: "move-object",
        _target_id: "toolbar-group",
        _target_type: "toolbar",
        _after_id: "settings-button",
      },
    });
  assert.equal(apply_view_edit_move_after_result._ok, true);
  assert.equal(apply_view_edit_move_after_result._deterministic, true);
  assert.equal(apply_view_edit_move_after_result._mutation_action, "move-object");
  assert.equal(apply_view_edit_move_after_result._target_id, "toolbar-group");
  assert.equal(apply_view_edit_move_after_result._after_id, "settings-button");
  assert.equal(apply_view_edit_move_after_result._previous_index, 3);
  assert.equal(apply_view_edit_move_after_result._next_index, 2);
  assert.equal(apply_view_edit_move_after_result._parent_id, "page-toolbar");
  const apply_view_edit_toolbar_after_move_after =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
      },
    });
  assert.deepEqual(
    apply_view_edit_toolbar_after_move_after._result._view._children.map((child: any) => child._id),
    ["toolbar-button", "settings-button", "toolbar-group", "export-button"],
  );
  assert.deepEqual(
    apply_view_edit_toolbar_after_move_after._result._view._children[2]._children,
    [
      {
        _id: "nested-action",
        _type: "button",
        _text: "Nested",
      },
    ],
  );
  const apply_view_edit_main_after_move_after =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
      },
    });
  assert.equal(
    JSON.stringify(apply_view_edit_main_after_move_after._result._view),
    apply_view_edit_move_source_main_before,
  );

  const apply_view_edit_move_before_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
        _edit_action: "move-object",
        _target_id: "toolbar-button",
        _target_type: "button",
        _before_id: "export-button",
      },
    });
  assert.equal(apply_view_edit_move_before_result._ok, true);
  assert.equal(apply_view_edit_move_before_result._mutation_action, "move-object");
  assert.equal(apply_view_edit_move_before_result._target_id, "toolbar-button");
  assert.equal(apply_view_edit_move_before_result._before_id, "export-button");
  assert.equal(apply_view_edit_move_before_result._previous_index, 0);
  assert.equal(apply_view_edit_move_before_result._next_index, 2);
  assert.equal(apply_view_edit_move_before_result._parent_id, "page-toolbar");
  const apply_view_edit_toolbar_after_move_before =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
      },
    });
  assert.deepEqual(
    apply_view_edit_toolbar_after_move_before._result._view._children.map((child: any) => child._id),
    ["settings-button", "toolbar-group", "toolbar-button", "export-button"],
  );

  const apply_view_edit_remove_source_main_before =
    JSON.stringify(apply_view_edit_main_after_move_after._result._view);
  const apply_view_edit_remove_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
        _edit_action: "remove-object",
        _target_id: "export-button",
        _target_type: "button",
      },
    });
  assert.equal(apply_view_edit_remove_result._ok, true);
  assert.equal(apply_view_edit_remove_result._deterministic, true);
  assert.equal(apply_view_edit_remove_result._mutation_action, "remove-object");
  assert.equal(apply_view_edit_remove_result._target_id, "export-button");
  assert.equal(apply_view_edit_remove_result._removed_type, "button");
  assert.equal(apply_view_edit_remove_result._removed_text, "Export");
  assert.equal(apply_view_edit_remove_result._parent_id, "page-toolbar");
  assert.equal(apply_view_edit_remove_result._result._mutation._removed_type, "button");
  assert.equal(apply_view_edit_remove_result._result._mutation._removed_text, "Export");
  const apply_view_edit_toolbar_after_remove =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
      },
    });
  assert.deepEqual(
    apply_view_edit_toolbar_after_remove._result._view._children.map((child: any) => child._id),
    ["settings-button", "toolbar-group", "toolbar-button"],
  );
  const apply_view_edit_main_after_remove_source =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
      },
    });
  assert.equal(
    JSON.stringify(apply_view_edit_main_after_remove_source._result._view),
    apply_view_edit_remove_source_main_before,
  );

  const apply_view_edit_push_count_before_root_remove =
    apply_view_edit_push_update_count;
  const apply_view_edit_root_remove_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
        _edit_action: "remove-object",
        _target_id: "main",
        _target_type: "view",
      },
    });
  assert.equal(apply_view_edit_root_remove_result._ok, false);
  assert.equal(apply_view_edit_root_remove_result._reason, "target_is_root");
  assert.equal(
    apply_view_edit_push_update_count,
    apply_view_edit_push_count_before_root_remove,
  );

  const apply_view_edit_push_count_before_missing_remove =
    apply_view_edit_push_update_count;
  const apply_view_edit_missing_remove_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
        _edit_action: "remove-object",
        _target_id: "missing-button",
        _target_type: "button",
      },
    });
  assert.equal(apply_view_edit_missing_remove_result._ok, false);
  assert.equal(apply_view_edit_missing_remove_result._reason, "target_not_found");
  assert.equal(
    apply_view_edit_push_update_count,
    apply_view_edit_push_count_before_missing_remove,
  );

  const apply_view_edit_push_count_before_root_hide =
    apply_view_edit_push_update_count;
  const apply_view_edit_root_hide_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
        _edit_action: "hide-object",
        _target_id: "main",
        _target_type: "view",
      },
    });
  assert.equal(apply_view_edit_root_hide_result._ok, false);
  assert.equal(apply_view_edit_root_hide_result._reason, "target_is_root");
  assert.equal(
    apply_view_edit_push_update_count,
    apply_view_edit_push_count_before_root_hide,
  );

  const apply_view_edit_push_count_before_root_show =
    apply_view_edit_push_update_count;
  const apply_view_edit_root_show_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
        _edit_action: "show-object",
        _target_id: "page-toolbar",
        _target_type: "view",
      },
    });
  assert.equal(apply_view_edit_root_show_result._ok, false);
  assert.equal(apply_view_edit_root_show_result._reason, "target_is_root");
  assert.equal(
    apply_view_edit_push_update_count,
    apply_view_edit_push_count_before_root_show,
  );

  const apply_view_edit_push_count_before_missing_hide =
    apply_view_edit_push_update_count;
  const apply_view_edit_missing_hide_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
        _edit_action: "hide-object",
        _target_id: "missing-hide-target",
        _target_type: "button",
      },
    });
  assert.equal(apply_view_edit_missing_hide_result._ok, false);
  assert.equal(apply_view_edit_missing_hide_result._reason, "target_not_found");
  assert.equal(
    apply_view_edit_push_update_count,
    apply_view_edit_push_count_before_missing_hide,
  );

  const apply_view_edit_push_count_before_missing_show =
    apply_view_edit_push_update_count;
  const apply_view_edit_missing_show_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
        _edit_action: "show-object",
        _target_id: "missing-show-target",
        _target_type: "button",
      },
    });
  assert.equal(apply_view_edit_missing_show_result._ok, false);
  assert.equal(apply_view_edit_missing_show_result._reason, "target_not_found");
  assert.equal(
    apply_view_edit_push_update_count,
    apply_view_edit_push_count_before_missing_show,
  );

  const apply_view_edit_push_count_before_different_parent =
    apply_view_edit_push_update_count;
  const apply_view_edit_move_different_parent_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
        _edit_action: "move-object",
        _target_id: "nested-action",
        _target_type: "button",
        _before_id: "settings-button",
      },
    });
  assert.equal(apply_view_edit_move_different_parent_result._ok, false);
  assert.equal(apply_view_edit_move_different_parent_result._reason, "different_parent");
  assert.equal(
    apply_view_edit_push_update_count,
    apply_view_edit_push_count_before_different_parent,
  );

  const apply_view_edit_push_count_before_missing_anchor =
    apply_view_edit_push_update_count;
  const apply_view_edit_move_missing_anchor_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
        _edit_action: "move-object",
        _target_id: "toolbar-button",
        _target_type: "button",
        _after_id: "missing-anchor",
      },
    });
  assert.equal(apply_view_edit_move_missing_anchor_result._ok, false);
  assert.equal(apply_view_edit_move_missing_anchor_result._reason, "anchor_not_found");
  assert.equal(
    apply_view_edit_push_update_count,
    apply_view_edit_push_count_before_missing_anchor,
  );

  const apply_view_edit_push_count_before_root_move =
    apply_view_edit_push_update_count;
  const apply_view_edit_move_root_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
        _edit_action: "move-object",
        _target_id: "page-toolbar",
        _target_type: "view",
        _after_id: "settings-button",
      },
    });
  assert.equal(apply_view_edit_move_root_result._ok, false);
  assert.equal(apply_view_edit_move_root_result._reason, "target_is_root");
  assert.equal(
    apply_view_edit_push_update_count,
    apply_view_edit_push_count_before_root_move,
  );

  const apply_view_edit_style_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
        _edit_action: "set-style",
        _target_id: "main-title",
        _target_type: "label",
        _style_property: "color",
        _style_value: "blue",
      },
    });
  assert.equal(apply_view_edit_style_result._ok, true);
  assert.equal(apply_view_edit_style_result._mutation_action, "set-style");
  const apply_view_edit_main_after_style =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
      },
    });
  assert.deepEqual(
    apply_view_edit_main_after_style._result._view._children[0]._style,
    { color: "blue" },
  );

  const apply_view_edit_replace_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
        _edit_action: "replace-object",
        _target_id: "main-title",
        _target_type: "label",
        _object_value: {
          _id: "main-title",
          _type: "label",
          _text: "JSON Title",
          class: "json-title",
          _style: {
            color: "purple",
          },
        },
      },
    });
  assert.equal(apply_view_edit_replace_result._ok, true);
  assert.equal(apply_view_edit_replace_result._mutation_action, "replace-object");
  assert.equal(apply_view_edit_replace_result._target_id, "main-title");
  const apply_view_edit_main_after_replace =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
      },
    });
  assert.deepEqual(
    apply_view_edit_main_after_replace._result._view._children[0],
    {
      _id: "main-title",
      _type: "label",
      _text: "JSON Title",
      class: "json-title",
      _style: {
        color: "purple",
      },
    },
  );
  assert.equal(
    apply_view_edit_main_after_replace._result._view._children[1]._id,
    "toolbar-ref",
  );

  const apply_view_edit_duplicate_simple_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
        _edit_action: "duplicate-object",
        _target_id: "main-title",
        _target_type: "label",
      },
    });
  assert.equal(apply_view_edit_duplicate_simple_result._ok, true);
  assert.equal(apply_view_edit_duplicate_simple_result._mutation_action, "duplicate-object");
  assert.equal(apply_view_edit_duplicate_simple_result._original_target_id, "main-title");
  assert.equal(apply_view_edit_duplicate_simple_result._new_target_id, "main-title-copy");
  assert.equal(apply_view_edit_duplicate_simple_result._parent_id, "main");
  assert.equal(apply_view_edit_duplicate_simple_result._insert_index, 1);
  assert.equal(apply_view_edit_duplicate_simple_result._result._mutation._new_target_id, "main-title-copy");
  const apply_view_edit_main_after_duplicate_simple =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
      },
    });
  assert.deepEqual(
    apply_view_edit_main_after_duplicate_simple._result._view._children.map((child: any) => child._id),
    ["main-title", "main-title-copy", "toolbar-ref"],
  );
  assert.deepEqual(
    apply_view_edit_main_after_duplicate_simple._result._view._children[1],
    {
      _id: "main-title-copy",
      _type: "label",
      _text: "JSON Title",
      class: "json-title",
      _style: {
        color: "purple",
      },
    },
  );

  const apply_view_edit_toolbar_before_xvm_duplicate =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
      },
    });
  const apply_view_edit_toolbar_before_xvm_duplicate_json =
    JSON.stringify(apply_view_edit_toolbar_before_xvm_duplicate._result._view);
  const apply_view_edit_duplicate_xvm_view_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
        _edit_action: "duplicate-object",
        _target_id: "toolbar-ref",
        _target_type: "xvm-view",
        _before_id: "main-title-copy",
      },
    });
  assert.equal(apply_view_edit_duplicate_xvm_view_result._ok, true);
  assert.equal(apply_view_edit_duplicate_xvm_view_result._mutation_action, "duplicate-object");
  assert.equal(apply_view_edit_duplicate_xvm_view_result._original_target_id, "toolbar-ref");
  assert.equal(apply_view_edit_duplicate_xvm_view_result._new_target_id, "toolbar-ref-copy");
  assert.equal(apply_view_edit_duplicate_xvm_view_result._before_id, "main-title-copy");
  assert.equal(apply_view_edit_duplicate_xvm_view_result._insert_index, 1);
  const apply_view_edit_main_after_duplicate_xvm_view =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
      },
    });
  assert.deepEqual(
    apply_view_edit_main_after_duplicate_xvm_view._result._view._children.map((child: any) => child._id),
    ["main-title", "toolbar-ref-copy", "main-title-copy", "toolbar-ref"],
  );
  assert.deepEqual(
    apply_view_edit_main_after_duplicate_xvm_view._result._view._children[1],
    {
      _id: "toolbar-ref-copy",
      _type: "xvm-view",
      _view_id: "page-toolbar",
    },
  );
  const apply_view_edit_toolbar_after_xvm_duplicate =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
      },
    });
  assert.equal(
    JSON.stringify(apply_view_edit_toolbar_after_xvm_duplicate._result._view),
    apply_view_edit_toolbar_before_xvm_duplicate_json,
  );

  const apply_view_edit_duplicate_subtree_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
        _edit_action: "duplicate-object",
        _target_id: "toolbar-group",
        _target_type: "toolbar",
      },
    });
  assert.equal(apply_view_edit_duplicate_subtree_result._ok, true);
  assert.equal(apply_view_edit_duplicate_subtree_result._mutation_action, "duplicate-object");
  assert.equal(apply_view_edit_duplicate_subtree_result._original_target_id, "toolbar-group");
  assert.equal(apply_view_edit_duplicate_subtree_result._new_target_id, "toolbar-group-copy");
  assert.equal(apply_view_edit_duplicate_subtree_result._insert_index, 2);
  assert.equal(apply_view_edit_duplicate_subtree_result._parent_id, "page-toolbar");
  const apply_view_edit_toolbar_after_duplicate_subtree =
    await (apply_view_edit_server_xvm as any)._get_view({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
      },
    });
  assert.deepEqual(
    apply_view_edit_toolbar_after_duplicate_subtree._result._view._children.map((child: any) => child._id),
    ["settings-button", "toolbar-group", "toolbar-group-copy", "toolbar-button"],
  );
  assert.deepEqual(
    apply_view_edit_toolbar_after_duplicate_subtree._result._view._children[2],
    {
      _id: "toolbar-group-copy",
      _type: "toolbar",
      _children: [
        {
          _id: "nested-action-copy",
          _type: "button",
          _text: "Nested",
        },
      ],
    },
  );

  const apply_view_edit_push_count_before_duplicate_different_parent =
    apply_view_edit_push_update_count;
  const apply_view_edit_duplicate_different_parent_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
        _edit_action: "duplicate-object",
        _target_id: "nested-action",
        _target_type: "button",
        _before_id: "settings-button",
      },
    });
  assert.equal(apply_view_edit_duplicate_different_parent_result._ok, false);
  assert.equal(apply_view_edit_duplicate_different_parent_result._reason, "different_parent");
  assert.equal(
    apply_view_edit_push_update_count,
    apply_view_edit_push_count_before_duplicate_different_parent,
  );

  const apply_view_edit_push_count_before_root_duplicate =
    apply_view_edit_push_update_count;
  const apply_view_edit_root_duplicate_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
        _edit_action: "duplicate-object",
        _target_id: "page-toolbar",
        _target_type: "view",
      },
    });
  assert.equal(apply_view_edit_root_duplicate_result._ok, false);
  assert.equal(apply_view_edit_root_duplicate_result._reason, "target_is_root");
  assert.equal(
    apply_view_edit_push_update_count,
    apply_view_edit_push_count_before_root_duplicate,
  );

  const apply_view_edit_push_count_before_missing_duplicate =
    apply_view_edit_push_update_count;
  const apply_view_edit_missing_duplicate_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
        _edit_action: "duplicate-object",
        _target_id: "missing-duplicate",
        _target_type: "button",
      },
    });
  assert.equal(apply_view_edit_missing_duplicate_result._ok, false);
  assert.equal(apply_view_edit_missing_duplicate_result._reason, "target_not_found");
  assert.equal(
    apply_view_edit_push_update_count,
    apply_view_edit_push_count_before_missing_duplicate,
  );

  const apply_view_edit_push_count_before_root_replace =
    apply_view_edit_push_update_count;
  const apply_view_edit_root_replace_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
        _edit_action: "replace-object",
        _target_id: "main",
        _target_type: "view",
        _object_value: {
          _id: "main",
          _type: "view",
          _children: [],
        },
      },
    });
  assert.equal(apply_view_edit_root_replace_result._ok, false);
  assert.equal(apply_view_edit_root_replace_result._reason, "target_is_root");
  assert.equal(
    apply_view_edit_push_update_count,
    apply_view_edit_push_count_before_root_replace,
  );

  const apply_view_edit_push_count_before_type_mismatch =
    apply_view_edit_push_update_count;
  const apply_view_edit_type_mismatch_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
        _edit_action: "replace-object",
        _target_id: "main-title",
        _target_type: "label",
        _object_value: {
          _id: "main-title",
          _type: "button",
          _text: "Wrong Type",
        },
      },
    });
  assert.equal(apply_view_edit_type_mismatch_result._ok, false);
  assert.equal(apply_view_edit_type_mismatch_result._reason, "object_type_mismatch");
  assert.equal(
    apply_view_edit_push_update_count,
    apply_view_edit_push_count_before_type_mismatch,
  );

  const apply_view_edit_push_count_before_unsupported =
    apply_view_edit_push_update_count;
  const apply_view_edit_unsupported_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
        _edit_action: "set-property",
        _target_id: "missing-title",
        _target_type: "label",
        _property_name: "_text",
        _property_value: "Should Not Persist",
      },
    });
  assert.equal(apply_view_edit_unsupported_result._ok, false);
  assert.equal(apply_view_edit_unsupported_result._reason, "target_not_found");
  assert.equal(
    apply_view_edit_push_update_count,
    apply_view_edit_push_count_before_unsupported,
  );

  const apply_view_edit_ref_views_dir =
    path.join(
      apply_view_edit_work_folder,
      "xvm",
      "apps",
      apply_view_edit_env,
      apply_view_edit_app_id,
      "views",
    );
  const apply_view_edit_ref_main_file =
    path.join(apply_view_edit_ref_views_dir, "main.json");
  const apply_view_edit_ref_toolbar_file =
    path.join(apply_view_edit_ref_views_dir, "page-toolbar.json");
  const apply_view_edit_ref_main_before =
    await readFile(apply_view_edit_ref_main_file, "utf-8");

  const apply_view_edit_set_interaction_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
        _edit_action: "set-interaction",
        _target_id: "toolbar-button",
        _target_type: "button",
        _trigger: "click",
        _handler: {
          _module: "xvm",
          _op: "navigate",
          _params: {
            _view_id: "v2",
          },
        },
      },
    });
  assert.equal(apply_view_edit_set_interaction_result._ok, true);
  assert.equal(apply_view_edit_set_interaction_result._edit_action, "set-interaction");
  assert.equal(apply_view_edit_set_interaction_result._target_id, "toolbar-button");
  assert.equal(apply_view_edit_set_interaction_result._interaction_scope, "_on");
  assert.equal(apply_view_edit_set_interaction_result._trigger, "click");
  assert.equal(apply_view_edit_set_interaction_result._handler_removed, false);
  assert.equal(apply_view_edit_set_interaction_result._persisted_view_id, "page-toolbar");
  const apply_view_edit_toolbar_after_set_interaction =
    JSON.parse(await readFile(apply_view_edit_ref_toolbar_file, "utf-8"));
  assert.deepEqual(
    find_xui_node_for_test(apply_view_edit_toolbar_after_set_interaction, "toolbar-button")?._on,
    {
      click: {
        _module: "xvm",
        _op: "navigate",
        _params: {
          _view_id: "v2",
        },
      },
    },
  );

  const apply_view_edit_update_interaction_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
        _edit_action: "set-interaction",
        _target_id: "toolbar-button",
        _target_type: "button",
        _interaction_scope: "_on",
        _trigger: "click",
        _handler: {
          _module: "xvm",
          _op: "navigate",
          _params: {
            _view_id: "v3",
          },
        },
      },
    });
  assert.equal(apply_view_edit_update_interaction_result._ok, true);
  assert.equal(apply_view_edit_update_interaction_result._handler_removed, false);
  const apply_view_edit_toolbar_after_update_interaction =
    JSON.parse(await readFile(apply_view_edit_ref_toolbar_file, "utf-8"));
  assert.equal(
    (find_xui_node_for_test(apply_view_edit_toolbar_after_update_interaction, "toolbar-button") as any)?._on?.click?._params?._view_id,
    "v3",
  );

  const apply_view_edit_remove_interaction_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
        _edit_action: "set-interaction",
        _target_id: "toolbar-button",
        _target_type: "button",
        _trigger: "click",
        _handler: null,
      },
    });
  assert.equal(apply_view_edit_remove_interaction_result._ok, true);
  assert.equal(apply_view_edit_remove_interaction_result._handler_removed, true);
  const apply_view_edit_toolbar_after_remove_interaction =
    JSON.parse(await readFile(apply_view_edit_ref_toolbar_file, "utf-8"));
  const apply_view_edit_toolbar_button_after_remove_interaction =
    find_xui_node_for_test(apply_view_edit_toolbar_after_remove_interaction, "toolbar-button");
  assert.ok(apply_view_edit_toolbar_button_after_remove_interaction);
  assert.equal(
    Object.prototype.hasOwnProperty.call(
      apply_view_edit_toolbar_button_after_remove_interaction,
      "_on",
    ),
    false,
  );

  const apply_view_edit_push_count_before_bad_interaction =
    apply_view_edit_push_update_count;
  const apply_view_edit_bad_trigger_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
        _edit_action: "set-interaction",
        _target_id: "toolbar-button",
        _target_type: "button",
        _trigger: "hover",
        _handler: {
          _module: "xvm",
          _op: "navigate",
        },
      },
    });
  assert.equal(apply_view_edit_bad_trigger_result._ok, false);
  assert.equal(
    apply_view_edit_push_update_count,
    apply_view_edit_push_count_before_bad_interaction,
  );

  const apply_view_edit_bad_scope_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
        _edit_action: "set-interaction",
        _target_id: "toolbar-button",
        _target_type: "button",
        _interaction_scope: "_bad",
        _trigger: "click",
        _handler: {
          _module: "xvm",
          _op: "navigate",
        },
      },
    });
  assert.equal(apply_view_edit_bad_scope_result._ok, false);
  assert.equal(
    apply_view_edit_push_update_count,
    apply_view_edit_push_count_before_bad_interaction,
  );

  const apply_view_edit_bad_handler_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "page-toolbar",
        _edit_action: "set-interaction",
        _target_id: "toolbar-button",
        _target_type: "button",
        _trigger: "click",
        _handler: {
          _module: "xvm",
          _op: "navigate",
          _params: "v4",
        },
      },
    });
  assert.equal(apply_view_edit_bad_handler_result._ok, false);
  assert.equal(
    apply_view_edit_push_update_count,
    apply_view_edit_push_count_before_bad_interaction,
  );

  const apply_view_edit_ref_interaction_result =
    await (apply_view_edit_xvibe as any)._apply_view_edit({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
        _view_id: "main",
        _source_view_id: "page-toolbar",
        _edit_action: "set-interaction",
        _target_id: "settings-button",
        _target_type: "button",
        _trigger: "click",
        _handler: {
          _module: "xvm",
          _op: "navigate",
          _params: {
            _view_id: "settings",
          },
        },
      },
    });
  assert.equal(apply_view_edit_ref_interaction_result._ok, true);
  assert.equal(apply_view_edit_ref_interaction_result._view_id, "main");
  assert.equal(apply_view_edit_ref_interaction_result._source_view_id, "page-toolbar");
  assert.equal(apply_view_edit_ref_interaction_result._persisted_view_id, "page-toolbar");
  assert.equal(apply_view_edit_ref_interaction_result._edit_action, "set-interaction");
  const apply_view_edit_ref_main_after_interaction =
    await readFile(apply_view_edit_ref_main_file, "utf-8");
  assert.equal(apply_view_edit_ref_main_after_interaction, apply_view_edit_ref_main_before);
  const apply_view_edit_ref_toolbar_after_interaction =
    JSON.parse(await readFile(apply_view_edit_ref_toolbar_file, "utf-8"));
  assert.equal(
    (find_xui_node_for_test(apply_view_edit_ref_toolbar_after_interaction, "settings-button") as any)?._on?.click?._params?._view_id,
    "settings",
  );

  const apply_view_edit_ref_source_resolved_logs: any[] = [];
  const apply_view_edit_ref_persisted_logs: any[] = [];
  const apply_view_edit_ref_original_log = _xlog.log;
  const apply_view_edit_ref_push_start =
    apply_view_edit_push_update_view_ids.length;

  try {
    (_xlog as any).log = (message: string, data?: any) => {
      if (message === "[xvibe] structured view edit source resolved") {
        apply_view_edit_ref_source_resolved_logs.push(data);
      }
      if (message === "[xvibe] structured view edit persisted source view") {
        apply_view_edit_ref_persisted_logs.push(data);
      }
      return apply_view_edit_ref_original_log.call(_xlog, message, data);
    };

    const apply_view_edit_ref_hide_result =
      await (apply_view_edit_xvibe as any)._apply_view_edit({
        _params: {
          _app_id: apply_view_edit_app_id,
          _env: apply_view_edit_env,
          _view_id: "main",
          _source_view_id: "page-toolbar",
          _edit_action: "hide-object",
          _target_id: "toolbar-button",
          _target_type: "button",
        },
      });
    assert.equal(apply_view_edit_ref_hide_result._ok, true);
    assert.equal(apply_view_edit_ref_hide_result._view_id, "main");
    assert.equal(apply_view_edit_ref_hide_result._source_view_id, "page-toolbar");
    assert.equal(apply_view_edit_ref_hide_result._persisted_view_id, "page-toolbar");
    assert.equal(apply_view_edit_ref_hide_result._target_id, "toolbar-button");
    assert.equal(apply_view_edit_ref_hide_result._edit_action, "hide-object");
    const apply_view_edit_ref_toolbar_after_hide =
      JSON.parse(await readFile(apply_view_edit_ref_toolbar_file, "utf-8"));
    const apply_view_edit_ref_toolbar_button_hidden =
      find_xui_node_for_test(apply_view_edit_ref_toolbar_after_hide, "toolbar-button");
    assert.ok(apply_view_edit_ref_toolbar_button_hidden);
    assert.equal(
      test_style_has_display_none(apply_view_edit_ref_toolbar_button_hidden.style),
      true,
    );

    const apply_view_edit_ref_show_result =
      await (apply_view_edit_xvibe as any)._apply_view_edit({
        _params: {
          _app_id: apply_view_edit_app_id,
          _env: apply_view_edit_env,
          _view_id: "main",
          _source_view_id: "page-toolbar",
          _edit_action: "show-object",
          _target_id: "toolbar-button",
          _target_type: "button",
        },
      });
    assert.equal(apply_view_edit_ref_show_result._ok, true);
    assert.equal(apply_view_edit_ref_show_result._view_id, "main");
    assert.equal(apply_view_edit_ref_show_result._source_view_id, "page-toolbar");
    assert.equal(apply_view_edit_ref_show_result._persisted_view_id, "page-toolbar");
    assert.equal(apply_view_edit_ref_show_result._target_id, "toolbar-button");
    assert.equal(apply_view_edit_ref_show_result._edit_action, "show-object");
    const apply_view_edit_ref_toolbar_after_show =
      JSON.parse(await readFile(apply_view_edit_ref_toolbar_file, "utf-8"));
    const apply_view_edit_ref_toolbar_button_visible =
      find_xui_node_for_test(apply_view_edit_ref_toolbar_after_show, "toolbar-button");
    assert.ok(apply_view_edit_ref_toolbar_button_visible);
    assert.equal(
      test_style_has_display_none(apply_view_edit_ref_toolbar_button_visible.style),
      false,
    );

    const apply_view_edit_ref_duplicate_result =
      await (apply_view_edit_xvibe as any)._apply_view_edit({
        _params: {
          _app_id: apply_view_edit_app_id,
          _env: apply_view_edit_env,
          _view_id: "main",
          _source_view_id: "page-toolbar",
          _edit_action: "duplicate-object",
          _target_id: "toolbar-button",
          _target_type: "button",
        },
      });
    assert.equal(apply_view_edit_ref_duplicate_result._ok, true);
    assert.equal(apply_view_edit_ref_duplicate_result._view_id, "main");
    assert.equal(apply_view_edit_ref_duplicate_result._source_view_id, "page-toolbar");
    assert.equal(apply_view_edit_ref_duplicate_result._persisted_view_id, "page-toolbar");
    assert.equal(apply_view_edit_ref_duplicate_result._target_id, "toolbar-button");
    assert.equal(apply_view_edit_ref_duplicate_result._edit_action, "duplicate-object");
    assert.equal(apply_view_edit_ref_duplicate_result._new_target_id, "toolbar-button-copy");
    const apply_view_edit_ref_toolbar_after_duplicate =
      JSON.parse(await readFile(apply_view_edit_ref_toolbar_file, "utf-8"));
    assert.ok(find_xui_node_for_test(apply_view_edit_ref_toolbar_after_duplicate, "toolbar-button-copy"));

    const apply_view_edit_ref_move_result =
      await (apply_view_edit_xvibe as any)._apply_view_edit({
        _params: {
          _app_id: apply_view_edit_app_id,
          _env: apply_view_edit_env,
          _view_id: "main",
          _source_view_id: "page-toolbar",
          _edit_action: "move-object",
          _target_id: "toolbar-button",
          _target_type: "button",
          _before_id: "settings-button",
        },
      });
    assert.equal(apply_view_edit_ref_move_result._ok, true);
    assert.equal(apply_view_edit_ref_move_result._view_id, "main");
    assert.equal(apply_view_edit_ref_move_result._source_view_id, "page-toolbar");
    assert.equal(apply_view_edit_ref_move_result._persisted_view_id, "page-toolbar");
    assert.equal(apply_view_edit_ref_move_result._target_id, "toolbar-button");
    assert.equal(apply_view_edit_ref_move_result._edit_action, "move-object");
    assert.equal(apply_view_edit_ref_move_result._before_id, "settings-button");
    const apply_view_edit_ref_toolbar_after_move =
      JSON.parse(await readFile(apply_view_edit_ref_toolbar_file, "utf-8"));
    assert.deepEqual(
      apply_view_edit_ref_toolbar_after_move._children.map((child: any) => child._id),
      ["toolbar-button", "settings-button", "toolbar-group", "toolbar-group-copy", "toolbar-button-copy"],
    );

    const apply_view_edit_ref_remove_result =
      await (apply_view_edit_xvibe as any)._apply_view_edit({
        _params: {
          _app_id: apply_view_edit_app_id,
          _env: apply_view_edit_env,
          _view_id: "main",
          _source_view_id: "page-toolbar",
          _edit_action: "remove-object",
          _target_id: "toolbar-button-copy",
          _target_type: "button",
        },
      });
    assert.equal(apply_view_edit_ref_remove_result._ok, true);
    assert.equal(apply_view_edit_ref_remove_result._view_id, "main");
    assert.equal(apply_view_edit_ref_remove_result._source_view_id, "page-toolbar");
    assert.equal(apply_view_edit_ref_remove_result._persisted_view_id, "page-toolbar");
    assert.equal(apply_view_edit_ref_remove_result._target_id, "toolbar-button-copy");
    assert.equal(apply_view_edit_ref_remove_result._edit_action, "remove-object");
    const apply_view_edit_ref_toolbar_after_remove =
      JSON.parse(await readFile(apply_view_edit_ref_toolbar_file, "utf-8"));
    assert.equal(
      find_xui_node_for_test(apply_view_edit_ref_toolbar_after_remove, "toolbar-button-copy"),
      undefined,
    );
    assert.deepEqual(
      apply_view_edit_ref_toolbar_after_remove._children.map((child: any) => child._id),
      ["toolbar-button", "settings-button", "toolbar-group", "toolbar-group-copy"],
    );

    const apply_view_edit_ref_main_after =
      await readFile(apply_view_edit_ref_main_file, "utf-8");
    assert.equal(apply_view_edit_ref_main_after, apply_view_edit_ref_main_before);
    assert.equal(apply_view_edit_ref_main_after.includes("toolbar-button"), false);
    assert.deepEqual(
      apply_view_edit_push_update_view_ids.slice(apply_view_edit_ref_push_start),
      ["page-toolbar", "page-toolbar", "page-toolbar", "page-toolbar", "page-toolbar"],
    );
    assert.equal(apply_view_edit_ref_source_resolved_logs.length, 5);
    assert.equal(apply_view_edit_ref_persisted_logs.length, 5);
    assert.deepEqual(
      apply_view_edit_ref_source_resolved_logs.map((log) => log._source_view_id),
      ["page-toolbar", "page-toolbar", "page-toolbar", "page-toolbar", "page-toolbar"],
    );
    assert.deepEqual(
      apply_view_edit_ref_persisted_logs.map((log) => log._persisted_view_id),
      ["page-toolbar", "page-toolbar", "page-toolbar", "page-toolbar", "page-toolbar"],
    );

    const apply_view_edit_ref_reloaded_server_xvm =
      new ServerXVMModule({ _work_folder: apply_view_edit_work_folder });
    await (apply_view_edit_ref_reloaded_server_xvm as any)._load_app_from_disk({
      _params: {
        _app_id: apply_view_edit_app_id,
        _env: apply_view_edit_env,
      },
    });
    const apply_view_edit_ref_reloaded_toolbar =
      await (apply_view_edit_ref_reloaded_server_xvm as any)._get_view({
        _params: {
          _app_id: apply_view_edit_app_id,
          _env: apply_view_edit_env,
          _view_id: "page-toolbar",
        },
      });
    const apply_view_edit_ref_reloaded_main =
      await (apply_view_edit_ref_reloaded_server_xvm as any)._get_view({
        _params: {
          _app_id: apply_view_edit_app_id,
          _env: apply_view_edit_env,
          _view_id: "main",
        },
      });
    assert.deepEqual(
      apply_view_edit_ref_reloaded_toolbar._result._view._children.map((child: any) => child._id),
      ["toolbar-button", "settings-button", "toolbar-group", "toolbar-group-copy"],
    );
    assert.equal(
      find_xui_node_for_test(apply_view_edit_ref_reloaded_toolbar._result._view, "toolbar-button-copy"),
      undefined,
    );
    const apply_view_edit_ref_reloaded_button =
      find_xui_node_for_test(apply_view_edit_ref_reloaded_toolbar._result._view, "toolbar-button");
    assert.ok(apply_view_edit_ref_reloaded_button);
    assert.equal(
      test_style_has_display_none(apply_view_edit_ref_reloaded_button.style),
      false,
    );
    assert.equal(
      JSON.stringify(apply_view_edit_ref_reloaded_main._result._view),
      JSON.stringify(JSON.parse(apply_view_edit_ref_main_before)),
    );
  } finally {
    (_xlog as any).log = apply_view_edit_ref_original_log;
  }

  assert.equal(apply_view_edit_xai_generate_count, 0);
} finally {
  (_x as any).execute = original_execute;
  (_x as any).getModule = original_get_module;
  (_x as any).getSkills = original_get_skills;
  await rm(apply_view_edit_work_folder, { recursive: true, force: true });
}

const artifact_delete_archive_work_folder =
  await mkdtemp(path.join(tmpdir(), "xvibe-artifact-delete-archive-"));
try {
  (_x as any).getModule = (name: string) =>
    name === "server-xvm"
      ? { _work_folder: artifact_delete_archive_work_folder }
      : typeof original_get_module === "function"
        ? original_get_module.call(_x, name)
        : undefined;

  const delete_view_result = await (xvibe as any).generate_artifact({
    _prompt: "delete view main",
    _app_id: "artifact-delete-failure-app",
    _env: "test",
    _generation_id: "artifact-delete-failure",
  });
  assert.equal(delete_view_result._ok, false);
  assert.equal(
    delete_view_result._error._code,
    "E_XVIBE_ARTIFACT_ACTION_NOT_SUPPORTED",
  );

  const delete_view_run_dir =
    await latest_vibe_run_dir(artifact_delete_archive_work_folder, "artifact-delete-failure-app");
  const delete_view_resolved_task_json = JSON.parse(
    await readFile(path.join(delete_view_run_dir, "resolved-task.json"), "utf-8"),
  );
  assert.equal(delete_view_resolved_task_json._artifact_type, "view");
  assert.equal(delete_view_resolved_task_json._action, "delete");
  assert.equal(delete_view_resolved_task_json._target_id, "main");
  const delete_view_result_json = JSON.parse(
    await readFile(path.join(delete_view_run_dir, "result.json"), "utf-8"),
  );
  assert.equal(delete_view_result_json._success, false);
  assert.equal(
    delete_view_result_json._error._code,
    "E_XVIBE_ARTIFACT_ACTION_NOT_SUPPORTED",
  );
  assert.ok((await readFile(path.join(delete_view_run_dir, "timeline.json"), "utf-8")).includes("Generation failed"));
} finally {
  (_x as any).getModule = original_get_module;
  await rm(artifact_delete_archive_work_folder, { recursive: true, force: true });
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
    if (command?._module === "module-creator" && command?._op === "create-module-spec") {
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

    if (command?._module === "xai" && command?._op === "generate") {
      return {
        _ok: true,
        _text: JSON.stringify({
          _methods: {
            _evaluate: "_evaluate(xcmd) { return { _ok: true, _result: { value: 4 } }; }",
          },
        }),
      };
    }

    if (command?._module === "module-creator" && command?._op === "implement-generated-module") {
      module_creator_calls.push(command._op);
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
      module_creator_calls.push(command._op);
      return {
        _ok: true,
        _result: {
          _ok: true,
          _id: command._params?._id,
          _name: "calc",
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

  const module_ensure_result = await (xvibe as any).ensure_server_module_for_intent({
    app_id: "calc-app",
    env: "default",
    runtime_mode: "runtime",
    intent_plan: calculator_intent_missing,
  });
  const prepared_intent =
    module_ensure_result._intent_plan ?? module_ensure_result;

  assert.deepEqual(module_creator_calls, [
    "create-module-spec",
    "implement-generated-module",
    "load-generated-module",
  ]);
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

  const configured_system_xapps_path =
    path.join(entity_sync_work_folder, "configured-system-xapps");
  const configured_dashboard_path =
    path.join(configured_system_xapps_path, "app-starters", "dashboard");
  await mkdir(path.join(configured_dashboard_path, "views"), { recursive: true });
  await writeFile(
    path.join(configured_dashboard_path, "app.json"),
    JSON.stringify({
      _app_id: "configured-dashboard-starter",
      _env: "starter",
      _system: true,
      _meta: {
        _name: "Configured Dashboard Starter",
        _version: 1,
        _entry_view_id: "main",
      },
      _config: {
        _start: {
          _view_id: "main",
        },
      },
    }, null, 2),
    "utf-8",
  );
  await writeFile(
    path.join(configured_dashboard_path, "views", "main.json"),
    JSON.stringify({
      _id: "main",
      _type: "view",
      _children: [
        {
          _id: "configured-dashboard-title",
          _type: "label",
          _text: "Configured Dashboard",
        },
      ],
    }, null, 2),
    "utf-8",
  );
  (server_xvm as any)._system_xapps_path = configured_system_xapps_path;

  const starter_xvibe = new XVibeModule();
  const starter_create_res = await starter_xvibe._create_app_from_starter({
    _params: {
      _starter_id: "dashboard",
      _app_id: "Starter Dashboard",
      _env: "starter-test",
      _vision: "Track revenue and product activity",
    },
  } as any);
  assert.equal(starter_create_res._ok, true);
  assert.deepEqual(starter_create_res._result, {
    _app_id: "starter-dashboard",
    _env: "starter-test",
    _starter_id: "dashboard",
    _entry_view_id: "main",
    _created: true,
  });

  const starter_app_file = JSON.parse(
    await readFile(
      path.join(
        entity_sync_work_folder,
        "xvm",
        "apps",
        "starter-test",
        "starter-dashboard",
        "app.json",
      ),
      "utf-8",
    ),
  );
  assert.equal(starter_app_file._app_id, "starter-dashboard");
  assert.equal(starter_app_file._env, "starter-test");
  assert.equal(starter_app_file._system, false);
  assert.equal(starter_app_file._meta._starter_id, "dashboard");
  assert.equal(starter_app_file._meta._vision, "Track revenue and product activity");
  assert.equal(starter_app_file._meta._entry_view_id, "main");
  assert.equal(typeof starter_app_file._meta._created_at, "string");
  assert.equal(typeof starter_app_file._meta._updated_at, "string");

  const starter_view_file = JSON.parse(
    await readFile(
      path.join(
        entity_sync_work_folder,
        "xvm",
        "apps",
        "starter-test",
        "starter-dashboard",
        "views",
        "main.json",
      ),
      "utf-8",
    ),
  );
  assert.equal(starter_view_file._id, "main");
  assert.equal(starter_view_file._type, "view");
  assert.equal(starter_view_file._children[0]._id, "configured-dashboard-title");
  assert.equal(starter_view_file._children[0]._text, "Configured Dashboard");

  const list_starter_apps = await _x.execute({
    _module: "server-xvm",
    _op: "list_apps",
    _params: {
      _env: "starter-test",
    },
  });
  assert.equal(list_starter_apps._ok, true);
  assert.ok(list_starter_apps._result._app_ids.includes("starter-dashboard"));

  const get_starter_app = await _x.execute({
    _module: "server-xvm",
    _op: "get_app",
    _params: {
      _app_id: "starter-dashboard",
      _env: "starter-test",
    },
  });
  assert.equal(get_starter_app._ok, true);
  assert.equal(get_starter_app._result._app._system, false);
  assert.ok(get_starter_app._result._view_ids.includes("main"));

  const duplicate_starter_create_res = await starter_xvibe._create_app_from_starter({
    _params: {
      _starter_id: "dashboard",
      _app_id: "starter-dashboard",
      _env: "starter-test",
    },
  } as any);
  assert.equal(duplicate_starter_create_res._ok, false);
  assert.equal((duplicate_starter_create_res as any)._error._code, "E_XVIBE_APP_ALREADY_EXISTS");

  const invalid_starter_res = await starter_xvibe._create_app_from_starter({
    _params: {
      _starter_id: "../dashboard",
      _app_id: "bad-starter",
      _env: "starter-test",
    },
  } as any);
  assert.equal(invalid_starter_res._ok, false);
  assert.equal((invalid_starter_res as any)._error._code, "E_XVIBE_INVALID_STARTER_ID");

  const invalid_app_res = await starter_xvibe._create_app_from_starter({
    _params: {
      _starter_id: "dashboard",
      _app_id: "../bad-app",
      _env: "starter-test",
    },
  } as any);
  assert.equal(invalid_app_res._ok, false);
  assert.equal((invalid_app_res as any)._error._code, "E_XVIBE_INVALID_APP_ID");

  const invalid_env_res = await starter_xvibe._create_app_from_starter({
    _params: {
      _starter_id: "dashboard",
      _app_id: "bad-env-app",
      _env: "../starter-test",
    },
  } as any);
  assert.equal(invalid_env_res._ok, false);
  assert.equal((invalid_env_res as any)._error._code, "E_XVIBE_INVALID_ENV");

  (server_xvm as any)._system_xapps_path =
    path.join(entity_sync_work_folder, "missing-system-xapps");
  const missing_configured_starters_res = await starter_xvibe._create_app_from_starter({
    _params: {
      _starter_id: "dashboard",
      _app_id: "missing-configured-starters",
      _env: "starter-test",
    },
  } as any);
  assert.equal(missing_configured_starters_res._ok, false);
  assert.equal((missing_configured_starters_res as any)._error._code, "E_XVIBE_STARTER_NOT_FOUND");

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

const conversation_work_folder =
  await mkdtemp(path.join(tmpdir(), "xvibe-conversations-"));
try {
  const conversation_xvibe = new XVibeModule();
  (_x as any).getModule = (name: string) =>
    name === "server-xvm"
      ? { _work_folder: conversation_work_folder }
      : typeof original_get_module === "function"
        ? original_get_module.call(_x, name)
        : undefined;

  assert.ok(XVibeModule._ops["create-conversation"]);
  assert.ok(XVibeModule._ops["list-conversations"]);
  assert.ok(XVibeModule._ops["get-conversation"]);
  assert.ok(XVibeModule._ops["append-message"]);
  assert.ok(XVibeModule._ops["analyze-message"]);
  assert.ok(XVibeModule._ops["get-last-messages"]);
  assert.ok(XVibeModule._ops["update-conversation-action"]);

  const create_conversation_res = await (conversation_xvibe as any)._create_conversation({
    _params: {
      _app_id: "conversation-app",
      _env: "test",
      _conversation_id: "primary-chat",
      _title: "Primary Chat",
      _metadata: {
        _source: "test",
      },
    },
  });
  assert.equal(create_conversation_res._ok, true);
  assert.equal(create_conversation_res._result._conversation._id, "primary-chat");
  assert.equal(create_conversation_res._result._conversation._message_count, 0);

  const conversations_dir =
    path.join(
      conversation_work_folder,
      "xvm",
      "apps",
      "test",
      "conversation-app",
      "conversations",
    );
  const conversation_dir = path.join(conversations_dir, "primary-chat");
  assert.equal(
    path.relative(conversations_dir, conversation_dir).startsWith(".."),
    false,
  );
  const created_conversation_file = JSON.parse(
    await readFile(path.join(conversation_dir, "conversation.json"), "utf-8"),
  );
  assert.equal(created_conversation_file._title, "Primary Chat");
  assert.deepEqual(
    await readdir(path.join(conversation_dir, "attachments")),
    [],
  );
  assert.equal(
    await readFile(path.join(conversation_dir, "messages.jsonl"), "utf-8"),
    "",
  );

  const append_user_res = await (conversation_xvibe as any)._append_message({
    _params: {
      _app_id: "conversation-app",
      _env: "test",
      _conversation_id: "primary-chat",
      _role: "user",
      _text: "Hello",
      _metadata: {
        _client: "unit-test",
      },
    },
  });
  assert.equal(append_user_res._ok, true);
  assert.equal(append_user_res._result._message._role, "user");
  assert.equal(append_user_res._result._conversation._message_count, 1);

  const append_assistant_res = await (conversation_xvibe as any)._append_message({
    _params: {
      _app_id: "conversation-app",
      _env: "test",
      _conversation_id: "primary-chat",
      _message: {
        _id: "assistant-1",
        _role: "assistant",
        _text: "Hi",
        _attachments: [
          {
            _id: "attachment-1",
            _name: "note.txt",
          },
        ],
        _actions: [
          {
            _op: "noop",
          },
        ],
        _intent: {
          _message_type: "edit",
          _execution_level: "deterministic",
          _should_mutate: true,
          _confidence: 1,
          _reason: "unit-test",
          _actions: [
            {
              _id: "action-done",
              _title: "Apply edit",
              _action_type: "apply-view-edit",
              _status: "suggested",
            },
            {
              _id: "action-dismiss",
              _title: "Dismiss edit",
              _action_type: "apply-view-edit",
              _status: "suggested",
            },
          ],
          _warnings: [],
        },
        _result: {
          _ok: true,
        },
      },
    },
  });
  assert.equal(append_assistant_res._ok, true);
  assert.equal(append_assistant_res._result._message._id, "assistant-1");
  assert.equal(append_assistant_res._result._conversation._message_count, 2);

  const message_lines =
    (await readFile(path.join(conversation_dir, "messages.jsonl"), "utf-8"))
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line));
  assert.equal(message_lines.length, 2);
  assert.equal(message_lines[0]._text, "Hello");
  assert.equal(message_lines[1]._attachments[0]._name, "note.txt");
  assert.equal(message_lines[1]._intent._actions[0]._status, "suggested");

  const update_action_done_res = await (conversation_xvibe as any)._update_conversation_action({
    _params: {
      _app_id: "conversation-app",
      _env: "test",
      _conversation_id: "primary-chat",
      _message_id: "assistant-1",
      _action_id: "action-done",
      _status: "done",
      _result: {
        _ok: true,
      },
      _metadata: {
        _source: "unit-test",
      },
    },
  });
  assert.equal(update_action_done_res._ok, true);
  assert.equal(update_action_done_res._result._action._status, "done");
  assert.deepEqual(update_action_done_res._result._action._result, {
    _ok: true,
  });
  assert.deepEqual(update_action_done_res._result._action._metadata, {
    _source: "unit-test",
  });

  const update_action_dismissed_res = await (conversation_xvibe as any)._update_conversation_action({
    _params: {
      _app_id: "conversation-app",
      _env: "test",
      _conversation_id: "primary-chat",
      _message_id: "assistant-1",
      _action_id: "action-dismiss",
      _status: "dismissed",
    },
  });
  assert.equal(update_action_dismissed_res._ok, true);
  assert.equal(update_action_dismissed_res._result._action._status, "dismissed");

  const missing_action_message_res = await (conversation_xvibe as any)._update_conversation_action({
    _params: {
      _app_id: "conversation-app",
      _env: "test",
      _conversation_id: "primary-chat",
      _message_id: "missing-message",
      _action_id: "action-done",
      _status: "done",
    },
  });
  assert.equal(missing_action_message_res._ok, false);
  assert.equal(
    missing_action_message_res._error._code,
    "E_XVIBE_CONVERSATION_MESSAGE_NOT_FOUND",
  );

  const missing_action_res = await (conversation_xvibe as any)._update_conversation_action({
    _params: {
      _app_id: "conversation-app",
      _env: "test",
      _conversation_id: "primary-chat",
      _message_id: "assistant-1",
      _action_id: "missing-action",
      _status: "done",
    },
  });
  assert.equal(missing_action_res._ok, false);
  assert.equal(
    missing_action_res._error._code,
    "E_XVIBE_CONVERSATION_ACTION_NOT_FOUND",
  );

  const invalid_action_status_res = await (conversation_xvibe as any)._update_conversation_action({
    _params: {
      _app_id: "conversation-app",
      _env: "test",
      _conversation_id: "primary-chat",
      _message_id: "assistant-1",
      _action_id: "action-done",
      _status: "approved",
    },
  });
  assert.equal(invalid_action_status_res._ok, false);
  assert.equal(
    invalid_action_status_res._error._code,
    "E_XVIBE_INVALID_CONVERSATION_ACTION_STATUS",
  );

  const index_file = JSON.parse(
    await readFile(path.join(conversations_dir, "index.json"), "utf-8"),
  );
  assert.equal(index_file._app_id, "conversation-app");
  assert.equal(index_file._env, "test");
  assert.equal(index_file._conversations.length, 1);
  assert.equal(index_file._conversations[0]._id, "primary-chat");
  assert.equal(index_file._conversations[0]._message_count, 2);

  const list_conversations_res = await (conversation_xvibe as any)._list_conversations({
    _params: {
      _app_id: "conversation-app",
      _env: "test",
    },
  });
  assert.equal(list_conversations_res._ok, true);
  assert.equal(list_conversations_res._result._count, 1);
  assert.equal(list_conversations_res._result._conversations[0]._id, "primary-chat");

  await rm(path.join(conversations_dir, "index.json"), { force: true });
  const missing_index_list_res = await (conversation_xvibe as any)._list_conversations({
    _params: {
      _app_id: "conversation-app",
      _env: "test",
    },
  });
  assert.equal(missing_index_list_res._ok, true);
  assert.equal(missing_index_list_res._result._count, 0);

  await writeFile(path.join(conversations_dir, "index.json"), "{ invalid json", "utf-8");
  const corrupt_index_list_res = await (conversation_xvibe as any)._list_conversations({
    _params: {
      _app_id: "conversation-app",
      _env: "test",
    },
  });
  assert.equal(corrupt_index_list_res._ok, true);
  assert.equal(corrupt_index_list_res._result._count, 0);
  assert.equal(corrupt_index_list_res._result._index_recovered, true);

  const get_conversation_res = await (conversation_xvibe as any)._get_conversation({
    _params: {
      _app_id: "conversation-app",
      _env: "test",
      _conversation_id: "primary-chat",
    },
  });
  assert.equal(get_conversation_res._ok, true);
  assert.equal(get_conversation_res._result._conversation._message_count, 2);
  assert.equal(get_conversation_res._result._messages.length, 2);
  assert.ok(get_conversation_res._result._attachments_path.endsWith("primary-chat/attachments"));
  const reloaded_assistant_message =
    get_conversation_res._result._messages.find((message: any) => message._id === "assistant-1");
  assert.ok(reloaded_assistant_message);
  assert.equal(
    reloaded_assistant_message._intent._actions[0]._status,
    "done",
  );
  assert.equal(
    reloaded_assistant_message._intent._actions[1]._status,
    "dismissed",
  );
  assert.deepEqual(
    reloaded_assistant_message._intent._actions[0]._result,
    {
      _ok: true,
    },
  );

  const last_message_res = await (conversation_xvibe as any)._get_last_messages({
    _params: {
      _app_id: "conversation-app",
      _env: "test",
      _conversation_id: "primary-chat",
      _limit: 1,
    },
  });
  assert.equal(last_message_res._ok, true);
  assert.equal(last_message_res._result._messages.length, 1);
  assert.equal(last_message_res._result._messages[0]._id, "assistant-1");
  assert.equal(last_message_res._result._total, 2);

  let analyze_message_xai_generate_count = 0;
  try {
    (_x as any).execute = async (command: any) => {
      if (command?._module === "xai" && command?._op === "generate") {
        analyze_message_xai_generate_count += 1;
        throw new Error("xai.generate should not be called for xvibe.analyze-message");
      }

      return original_execute.call(_x, command);
    };

    const analyze_message_res = await (conversation_xvibe as any)._analyze_message({
      _params: {
        _app_id: "conversation-app",
        _env: "test",
        _conversation_id: "primary-chat",
        _message_id: "assistant-1",
        _message: "Hi",
        _runtime_context: {
          _active_view_id: "main",
          _selected_object: {
            _id: "button-1",
          },
          _available_artifacts: {
            _views: ["main"],
            _entities: [],
            _flows: [],
            _modules: ["xvibe"],
          },
        },
      },
    });
    assert.equal(analyze_message_res._ok, true);
    assert.deepEqual(analyze_message_res._intent, {
      _message_type: "conversation",
      _execution_level: "none",
      _should_mutate: false,
      _confidence: 0,
      _reason: "stub_intent_engine",
      _actions: [],
      _warnings: [],
    });
    assert.equal(analyze_message_res._result._message._role, "tool");
    assert.equal(analyze_message_res._result._message._text, "Intent analyzed.");
    assert.deepEqual(analyze_message_res._result._message._intent, analyze_message_res._intent);
    assert.equal(
      analyze_message_res._result._message._metadata._source,
      "xvibe.analyze-message",
    );
    assert.equal(analyze_message_res._result._conversation._message_count, 3);

    const analyzed_conversation_res = await (conversation_xvibe as any)._get_conversation({
      _params: {
        _app_id: "conversation-app",
        _env: "test",
        _conversation_id: "primary-chat",
      },
    });
    assert.equal(analyzed_conversation_res._ok, true);
    assert.equal(analyzed_conversation_res._result._messages.length, 3);
    assert.equal(analyzed_conversation_res._result._messages[2]._role, "tool");
    assert.deepEqual(
      analyzed_conversation_res._result._messages[2]._intent,
      analyze_message_res._intent,
    );

    await rm(path.join(conversations_dir, "index.json"), { force: true });
    const create_action_id_conversation_res = await (conversation_xvibe as any)._create_conversation({
      _params: {
        _app_id: "conversation-app",
        _env: "test",
        _conversation_id: "action-id-chat",
      },
    });
    assert.equal(create_action_id_conversation_res._ok, true);

    const conversation_learned_memory_path = path.join(
      conversation_work_folder,
      "xvm",
      "apps",
      "test",
      "conversation-app",
      "intent-memory",
      "learned-intents.json",
    );
    const read_conversation_learned_entries = async (): Promise<any[]> =>
      JSON.parse(
        await readFile(conversation_learned_memory_path, "utf-8"),
      );
    const learned_entry_for_prompt = (
      entries: any[],
      normalized_prompt: string,
    ): any | undefined =>
      entries.find(
        (entry) => entry._normalized_prompt === normalized_prompt,
      );

    const original_conversation_intent_engine =
      (conversation_xvibe as any).intent_engine;
    set_xvibe_semantic_intent_env("true");
    try {
      let semantic_action_title = "Apply edit";
      let semantic_action_target_id = "button-1";
      let semantic_reason = "semantic_action_id_normalization";
      (conversation_xvibe as any).intent_engine = xvibe_test_intent_engine({
        _semantic_generate_json: async () => ({
          _message_type: "edit",
          _execution_level: "model",
          _should_mutate: true,
          _confidence: 0.81,
          _reason: semantic_reason,
          _actions: [
            {
              _title: semantic_action_title,
              _action_type: "apply-view-edit",
              _status: "suggested",
              _requires_approval: true,
              _params: {
                _view_id: "main",
                _target_id: semantic_action_target_id,
                _target_type: "button",
                _source_view_id: "page-toolbar",
                _edit_action: "hide-object",
              },
            },
            {
              _id: "semantic-existing-action",
              _title: "Open details",
              _action_type: "open-panel",
              _status: "suggested",
              _params: {
                _panel_id: "details",
              },
            },
          ],
          _warnings: [],
        }),
      });

      const analyze_action_id_res = await (conversation_xvibe as any)._analyze_message({
        _params: {
          _app_id: "conversation-app",
          _env: "test",
          _conversation_id: "action-id-chat",
          _message: "hide the selected button semantically",
          _runtime_context: {
            _active_view_id: "main",
            _selected_object: {
              _json_id: "button-1",
              _id: "button-runtime-1",
              _type: "button",
              _source_view_id: "page-toolbar",
            },
          },
        },
      });
      assert.equal(analyze_action_id_res._ok, true);
      assert.equal(analyze_action_id_res._intent._actions[0]._id, "action-1");
      assert.equal(
        analyze_action_id_res._intent._actions[1]._id,
        "semantic-existing-action",
      );
      assert.equal(
        analyze_action_id_res._result._message._intent._actions[0]._id,
        "action-1",
      );

      const persisted_action_id_conversation_res =
        await (conversation_xvibe as any)._get_conversation({
          _params: {
            _app_id: "conversation-app",
            _env: "test",
            _conversation_id: "action-id-chat",
          },
        });
      assert.equal(persisted_action_id_conversation_res._ok, true);
      const persisted_action_id_message =
        persisted_action_id_conversation_res._result._messages.find(
          (message: any) =>
            message._id === analyze_action_id_res._result._message._id,
        );
      assert.ok(persisted_action_id_message);
      assert.equal(
        persisted_action_id_message._intent._actions[0]._id,
        "action-1",
      );
      assert.equal(
        persisted_action_id_message._intent._actions[1]._id,
        "semantic-existing-action",
      );

      const update_analyzed_action_res =
        await (conversation_xvibe as any)._update_conversation_action({
          _params: {
            _app_id: "conversation-app",
            _env: "test",
            _conversation_id: "action-id-chat",
            _message_id: analyze_action_id_res._result._message._id,
            _action_id: "action-1",
            _status: "done",
            _result: {
              _ok: true,
            },
          },
        });
      assert.equal(update_analyzed_action_res._ok, true);
      assert.equal(update_analyzed_action_res._result._action._status, "done");

      const updated_action_id_conversation_res =
        await (conversation_xvibe as any)._get_conversation({
          _params: {
            _app_id: "conversation-app",
            _env: "test",
            _conversation_id: "action-id-chat",
          },
        });
      const updated_action_id_message =
        updated_action_id_conversation_res._result._messages.find(
          (message: any) =>
            message._id === analyze_action_id_res._result._message._id,
        );
      assert.equal(
        updated_action_id_message._intent._actions[0]._status,
        "done",
      );
      await access(conversation_learned_memory_path);

      const learned_entries_after_success =
        await read_conversation_learned_entries();
      const learned_success_entry =
        learned_entry_for_prompt(
          learned_entries_after_success,
          "hide the selected button semantically",
        );
      assert.ok(learned_success_entry);
      assert.equal(learned_success_entry._version, 1);
      assert.equal(learned_success_entry._source, "semantic");
      assert.equal(learned_success_entry._hits, 0);
      assert.equal(learned_success_entry._intent._message_type, "edit");
      assert.equal(
        learned_success_entry._intent._execution_level,
        "deterministic",
      );
      assert.equal(learned_success_entry._intent._should_mutate, true);
      assert.equal(typeof learned_success_entry._intent._confidence, "number");
      assert.equal(
        learned_success_entry._intent._reason,
        "semantic_action_id_normalization",
      );
      assert.equal(learned_success_entry._intent._actions.length, 1);
      assert.equal(
        learned_success_entry._intent._actions[0]._title,
        "Apply edit",
      );
      assert.equal(
        learned_success_entry._intent._actions[0]._action_type,
        "apply-view-edit",
      );
      assert.equal(
        learned_success_entry._intent._actions[0]._status,
        "suggested",
      );
      assert.equal(
        learned_success_entry._intent._actions[0]._requires_approval,
        true,
      );
      assert.deepEqual(
        learned_success_entry._intent._actions[0]._params,
        {
          _view_id: "main",
          _target_id: "$selected._json_id",
          _target_type: "$selected._type",
          _source_view_id: "$selected._source_view_id",
          _edit_action: "hide-object",
        },
      );
      assert.equal(
        learned_success_entry._intent._actions[0]._result,
        undefined,
      );
      assert.equal(
        learned_success_entry._intent._actions[0]._metadata,
        undefined,
      );
      assert.equal(learned_success_entry._verified, undefined);
      assert.equal(learned_success_entry._processor, undefined);
      assert.equal(learned_success_entry._conversation_id, undefined);
      assert.equal(learned_success_entry._duration_ms, undefined);

      const create_linked_prompt_conversation_res =
        await (conversation_xvibe as any)._create_conversation({
          _params: {
            _app_id: "conversation-app",
            _env: "test",
            _conversation_id: "linked-prompt-chat",
          },
        });
      assert.equal(create_linked_prompt_conversation_res._ok, true);
      const append_linked_user_res =
        await (conversation_xvibe as any)._append_message({
          _params: {
            _app_id: "conversation-app",
            _env: "test",
            _conversation_id: "linked-prompt-chat",
            _message: {
              _id: "linked-user-prompt",
              _role: "user",
              _text: "Make the linked card blue.",
            },
          },
        });
      assert.equal(append_linked_user_res._ok, true);
      const append_linked_tool_res =
        await (conversation_xvibe as any)._append_message({
          _params: {
            _app_id: "conversation-app",
            _env: "test",
            _conversation_id: "linked-prompt-chat",
            _message: {
              _id: "linked-tool-intent",
              _role: "tool",
              _text: "Intent analyzed.",
              _intent: {
                _message_type: "edit",
                _execution_level: "model",
                _should_mutate: true,
                _confidence: 0.82,
                _reason: "linked_prompt_learning",
                _actions: [
                  {
                    _id: "linked-action",
                    _title: "Apply linked edit",
                    _action_type: "apply-view-edit",
                    _status: "suggested",
                    _requires_approval: true,
                    _params: {
                      _view_id: "main",
                      _target_id: "card-1",
                      _target_type: "card",
                      _source_view_id: "main",
                      _edit_action: "set-style",
                    },
                  },
                ],
                _warnings: [],
              },
              _metadata: {
                _source: "xvibe.analyze-message",
                _intent_processor: "SemanticIntentProcessor",
                _message_id: "linked-user-prompt",
                _selected_type: "card",
              },
            },
          },
        });
      assert.equal(append_linked_tool_res._ok, true);
      const update_linked_prompt_res =
        await (conversation_xvibe as any)._update_conversation_action({
          _params: {
            _app_id: "conversation-app",
            _env: "test",
            _conversation_id: "linked-prompt-chat",
            _message_id: "linked-tool-intent",
            _action_id: "linked-action",
            _status: "done",
            _result: {
              _ok: true,
            },
          },
        });
      assert.equal(update_linked_prompt_res._ok, true);
      const linked_prompt_entry =
        learned_entry_for_prompt(
          await read_conversation_learned_entries(),
          "make the linked card blue",
        );
      assert.ok(linked_prompt_entry);
      assert.equal(linked_prompt_entry._selected_type, "card");
      assert.equal(
        linked_prompt_entry._intent._actions[0]._title,
        "Apply linked edit",
      );
      assert.equal(
        linked_prompt_entry._intent._execution_level,
        "deterministic",
      );
      assert.equal(
        linked_prompt_entry._intent._actions[0]._status,
        "suggested",
      );
      assert.equal(
        linked_prompt_entry._intent._actions[0]._requires_approval,
        true,
      );

      const create_missing_title_conversation_res =
        await (conversation_xvibe as any)._create_conversation({
          _params: {
            _app_id: "conversation-app",
            _env: "test",
            _conversation_id: "missing-title-learn-chat",
          },
        });
      assert.equal(create_missing_title_conversation_res._ok, true);
      const append_missing_title_user_res =
        await (conversation_xvibe as any)._append_message({
          _params: {
            _app_id: "conversation-app",
            _env: "test",
            _conversation_id: "missing-title-learn-chat",
            _message: {
              _id: "missing-title-user",
              _role: "user",
              _text: "Delete the title card without title.",
            },
          },
        });
      assert.equal(append_missing_title_user_res._ok, true);
      const append_missing_title_tool_res =
        await (conversation_xvibe as any)._append_message({
          _params: {
            _app_id: "conversation-app",
            _env: "test",
            _conversation_id: "missing-title-learn-chat",
            _message: {
              _id: "missing-title-tool",
              _role: "tool",
              _text: "Intent analyzed.",
              _intent: {
                _message_type: "edit",
                _execution_level: "model",
                _should_mutate: true,
                _confidence: 0.84,
                _reason: "missing_title_learning",
                _actions: [
                  {
                    _id: "missing-title-action",
                    _action_type: "apply-view-edit",
                    _status: "suggested",
                    _requires_approval: true,
                    _params: {
                      _view_id: "main",
                      _target_id: "title-card",
                      _target_type: "card",
                      _edit_action: "remove-object",
                    },
                  },
                ],
                _warnings: [],
              },
              _metadata: {
                _source: "xvibe.analyze-message",
                _intent_processor: "SemanticIntentProcessor",
                _message_id: "missing-title-user",
                _selected_type: "card",
              },
            },
          },
        });
      assert.equal(append_missing_title_tool_res._ok, true);
      const update_missing_title_res =
        await (conversation_xvibe as any)._update_conversation_action({
          _params: {
            _app_id: "conversation-app",
            _env: "test",
            _conversation_id: "missing-title-learn-chat",
            _message_id: "missing-title-tool",
            _action_id: "missing-title-action",
            _status: "done",
            _result: {
              _ok: true,
            },
          },
        });
      assert.equal(update_missing_title_res._ok, true);
      await access(conversation_learned_memory_path);
      const missing_title_entry =
        learned_entry_for_prompt(
          await read_conversation_learned_entries(),
          "delete the title card without title",
        );
      assert.ok(missing_title_entry);
      assert.equal(
        validate_learned_intent_result(missing_title_entry._intent)._ok,
        true,
      );
      assert.equal(
        missing_title_entry._intent._actions[0]._title,
        "Delete selected object",
      );
      assert.equal(
        missing_title_entry._intent._actions[0]._status,
        "suggested",
      );

      const create_invalid_learn_conversation_res =
        await (conversation_xvibe as any)._create_conversation({
          _params: {
            _app_id: "conversation-app",
            _env: "test",
            _conversation_id: "invalid-learn-chat",
          },
        });
      assert.equal(create_invalid_learn_conversation_res._ok, true);
      const append_invalid_learn_user_res =
        await (conversation_xvibe as any)._append_message({
          _params: {
            _app_id: "conversation-app",
            _env: "test",
            _conversation_id: "invalid-learn-chat",
            _message: {
              _id: "invalid-learn-user",
              _role: "user",
              _text: "Invalid learned action.",
            },
          },
        });
      assert.equal(append_invalid_learn_user_res._ok, true);
      const append_invalid_learn_tool_res =
        await (conversation_xvibe as any)._append_message({
          _params: {
            _app_id: "conversation-app",
            _env: "test",
            _conversation_id: "invalid-learn-chat",
            _message: {
              _id: "invalid-learn-tool",
              _role: "tool",
              _text: "Intent analyzed.",
              _intent: {
                _message_type: "edit",
                _execution_level: "model",
                _should_mutate: true,
                _confidence: 0.73,
                _reason: "invalid_learn_fixture",
                _actions: [
                  {
                    _id: "invalid-learn-action",
                    _title: "Invalid learn action",
                    _action_type: "apply-view-edit",
                    _status: "suggested",
                    _requires_approval: true,
                  },
                ],
                _warnings: [],
              },
              _metadata: {
                _source: "xvibe.analyze-message",
                _intent_processor: "SemanticIntentProcessor",
                _message_id: "invalid-learn-user",
                _selected_type: "card",
              },
            },
          },
        });
      assert.equal(append_invalid_learn_tool_res._ok, true);
      const learned_invalid_logs: any[] = [];
      const original_learned_invalid_warn = _xlog.warn;
      (_xlog as any).warn = (message: string, data?: any) => {
        if (message === "[xvibe] learned intent invalid") {
          learned_invalid_logs.push(data);
        }

        return original_learned_invalid_warn.call(_xlog, message, data);
      };
      try {
        const update_invalid_learn_res =
          await (conversation_xvibe as any)._update_conversation_action({
            _params: {
              _app_id: "conversation-app",
              _env: "test",
              _conversation_id: "invalid-learn-chat",
              _message_id: "invalid-learn-tool",
              _action_id: "invalid-learn-action",
              _status: "done",
              _result: {
                _ok: true,
              },
            },
          });
        assert.equal(update_invalid_learn_res._ok, true);
      } finally {
        (_xlog as any).warn = original_learned_invalid_warn;
      }
      assert.equal(learned_invalid_logs.length, 1);
      assert.equal(
        learned_invalid_logs[0]._validation_error,
        "intent._actions[0]._params_required_for_apply_view_edit",
      );
      assert.equal(
        learned_invalid_logs[0]._sanitized_intent._execution_level,
        "deterministic",
      );
      assert.equal(
        learned_invalid_logs[0]._sanitized_intent._actions[0]._status,
        "suggested",
      );
      assert.equal(
        learned_entry_for_prompt(
          await read_conversation_learned_entries(),
          "invalid learned action",
        ),
        undefined,
      );

      const learned_reload_engine = new XVibeIntentEngine({
        _intent_memory_store: new IntentMemoryStore({
          _work_folder: conversation_work_folder,
        }),
      });
      const learned_reload_res = await learned_reload_engine.analyze({
        _message: "hide the selected button semantically",
        _runtime_context: {
          _app_id: "conversation-app",
          _env: "test",
          _selected_object: {
            _json_id: "button-current",
            _id: "button-runtime-current",
            _type: "button",
            _source_view_id: "page-main",
          },
        },
      });
      assert.equal(learned_reload_res._ok, true);
      assert.equal(
        learned_reload_res._processor,
        "LearnedIntentProcessor",
      );
      assert.equal(
        learned_reload_res._intent?._actions[0]._title,
        "Apply edit",
      );
      assert.equal(
        learned_reload_res._intent?._actions[0]._status,
        "suggested",
      );
      assert.equal(
        learned_reload_res._intent?._actions[0]._requires_approval,
        true,
      );
      assert.deepEqual(
        learned_reload_res._intent?._actions[0]._params,
        {
          _view_id: "main",
          _target_id: "button-current",
          _target_type: "button",
          _source_view_id: "page-main",
          _edit_action: "hide-object",
        },
      );
      assert.equal(
        learned_entry_for_prompt(
          await read_conversation_learned_entries(),
          "hide the selected button semantically",
        )?._hits,
        1,
      );
      const linked_replay_res = await learned_reload_engine.analyze({
        _message: "Make the linked card blue.",
        _runtime_context: {
          _app_id: "conversation-app",
          _env: "test",
          _selected_object: {
            _json_id: "card-current",
            _id: "card-runtime-current",
            _type: "card",
            _source_view_id: "main-current",
          },
        },
      });
      assert.equal(linked_replay_res._ok, true);
      assert.equal(linked_replay_res._processor, "LearnedIntentProcessor");
      assert.equal(
        linked_replay_res._intent?._actions[0]._title,
        "Apply linked edit",
      );
      assert.equal(
        linked_replay_res._intent?._actions[0]._status,
        "suggested",
      );
      assert.deepEqual(
        linked_replay_res._intent?._actions[0]._params,
        {
          _view_id: "main",
          _target_id: "card-current",
          _target_type: "card",
          _source_view_id: "main-current",
          _edit_action: "set-style",
        },
      );

      const analyze_failure_res = await (conversation_xvibe as any)._analyze_message({
        _params: {
          _app_id: "conversation-app",
          _env: "test",
          _conversation_id: "action-id-chat",
          _message: "semantic failure prompt",
          _runtime_context: {
            _active_view_id: "main",
          },
        },
      });
      assert.equal(analyze_failure_res._ok, true);
      const update_failure_res =
        await (conversation_xvibe as any)._update_conversation_action({
          _params: {
            _app_id: "conversation-app",
            _env: "test",
            _conversation_id: "action-id-chat",
            _message_id: analyze_failure_res._result._message._id,
            _action_id: "action-1",
            _status: "failed",
            _result: {
              _ok: false,
            },
          },
        });
      assert.equal(update_failure_res._ok, true);
      assert.equal(
        learned_entry_for_prompt(
          await read_conversation_learned_entries(),
          "semantic failure prompt",
        ),
        undefined,
      );

      const analyze_dismiss_res = await (conversation_xvibe as any)._analyze_message({
        _params: {
          _app_id: "conversation-app",
          _env: "test",
          _conversation_id: "action-id-chat",
          _message: "semantic dismiss prompt",
          _runtime_context: {
            _active_view_id: "main",
          },
        },
      });
      assert.equal(analyze_dismiss_res._ok, true);
      const update_dismiss_res =
        await (conversation_xvibe as any)._update_conversation_action({
          _params: {
            _app_id: "conversation-app",
            _env: "test",
            _conversation_id: "action-id-chat",
            _message_id: analyze_dismiss_res._result._message._id,
            _action_id: "action-1",
            _status: "dismissed",
          },
        });
      assert.equal(update_dismiss_res._ok, true);
      assert.equal(
        learned_entry_for_prompt(
          await read_conversation_learned_entries(),
          "semantic dismiss prompt",
        ),
        undefined,
      );

      const analyze_deterministic_res = await (conversation_xvibe as any)._analyze_message({
        _params: {
          _app_id: "conversation-app",
          _env: "test",
          _conversation_id: "action-id-chat",
          _message: "hide selected",
          _runtime_context: xvibe_intent_selected_object_context(),
        },
      });
      assert.equal(analyze_deterministic_res._ok, true);
      assert.equal(
        analyze_deterministic_res._result._message._metadata._intent_processor,
        "DeterministicIntentProcessor",
      );
      const deterministic_action_id =
        analyze_deterministic_res._intent._actions[0]._id;
      const update_deterministic_res =
        await (conversation_xvibe as any)._update_conversation_action({
          _params: {
            _app_id: "conversation-app",
            _env: "test",
            _conversation_id: "action-id-chat",
            _message_id: analyze_deterministic_res._result._message._id,
            _action_id: deterministic_action_id,
            _status: "done",
            _result: {
              _ok: true,
            },
          },
        });
      assert.equal(update_deterministic_res._ok, true);
      assert.equal(
        learned_entry_for_prompt(
          await read_conversation_learned_entries(),
          "hide selected",
        ),
        undefined,
      );

      const learned_entry_before_duplicate =
        learned_entry_for_prompt(
          await read_conversation_learned_entries(),
          "hide the selected button semantically",
        );
      assert.ok(learned_entry_before_duplicate);
      await new Promise((resolve) => setTimeout(resolve, 5));
      semantic_action_title = "Apply updated edit";
      semantic_action_target_id = "button-2";
      semantic_reason = "semantic_action_duplicate_update";
      const analyze_duplicate_res = await (conversation_xvibe as any)._analyze_message({
        _params: {
          _app_id: "conversation-app",
          _env: "test",
          _conversation_id: "action-id-chat",
          _message: "hide the selected button semantically",
          _runtime_context: {
            _active_view_id: "main",
            _selected_object: {
              _json_id: "button-2",
              _id: "button-runtime-2",
              _type: "button",
              _source_view_id: "page-toolbar",
            },
          },
        },
      });
      assert.equal(analyze_duplicate_res._ok, true);
      const update_duplicate_res =
        await (conversation_xvibe as any)._update_conversation_action({
          _params: {
            _app_id: "conversation-app",
            _env: "test",
            _conversation_id: "action-id-chat",
            _message_id: analyze_duplicate_res._result._message._id,
            _action_id: "action-1",
            _status: "done",
            _result: {
              _ok: true,
            },
          },
        });
      assert.equal(update_duplicate_res._ok, true);
      const learned_entries_after_duplicate =
        await read_conversation_learned_entries();
      const duplicate_prompt_entries =
        learned_entries_after_duplicate.filter(
          (entry) =>
            entry._normalized_prompt ===
              "hide the selected button semantically",
        );
      assert.equal(duplicate_prompt_entries.length, 1);
      assert.equal(
        duplicate_prompt_entries[0]._created_at,
        learned_entry_before_duplicate._created_at,
      );
      assert.notEqual(
        duplicate_prompt_entries[0]._updated_at,
        learned_entry_before_duplicate._updated_at,
      );
      assert.equal(duplicate_prompt_entries[0]._hits, 1);
      assert.equal(
        duplicate_prompt_entries[0]._intent._actions[0]._title,
        "Apply updated edit",
      );
      assert.equal(
        duplicate_prompt_entries[0]._intent._actions[0]._params._target_id,
        "$selected._json_id",
      );
    } finally {
      (conversation_xvibe as any).intent_engine =
        original_conversation_intent_engine;
      set_xvibe_semantic_intent_env(undefined);
    }

    const invalid_analyze_conversation_res = await (conversation_xvibe as any)._analyze_message({
      _params: {
        _app_id: "conversation-app",
        _env: "test",
        _conversation_id: "missing-chat",
        _message: "Hi",
      },
    });
    assert.equal(invalid_analyze_conversation_res._ok, false);
    assert.equal(
      invalid_analyze_conversation_res._error._code,
      "E_XVIBE_CONVERSATION_NOT_FOUND",
    );

    const invalid_analyze_message_res = await (conversation_xvibe as any)._analyze_message({
      _params: {
        _app_id: "conversation-app",
        _env: "test",
        _conversation_id: "primary-chat",
        _message: 42,
      },
    });
    assert.equal(invalid_analyze_message_res._ok, false);
    assert.equal(
      invalid_analyze_message_res._error._code,
      "E_XVIBE_INVALID_CONVERSATION_MESSAGE",
    );
    assert.equal(analyze_message_xai_generate_count, 0);
  } finally {
    (_x as any).execute = original_execute;
  }

  for (let message_index = 0; message_index < 110; message_index += 1) {
    const append_extra_res = await (conversation_xvibe as any)._append_message({
      _params: {
        _app_id: "conversation-app",
        _env: "test",
        _conversation_id: "primary-chat",
        _message: {
          _id: `extra-${message_index}`,
          _role: "tool",
          _text: `extra ${message_index}`,
        },
      },
    });
    assert.equal(append_extra_res._ok, true);
  }

  const capped_last_messages_res = await (conversation_xvibe as any)._get_last_messages({
    _params: {
      _app_id: "conversation-app",
      _env: "test",
      _conversation_id: "primary-chat",
      _limit: 1000,
    },
  });
  assert.equal(capped_last_messages_res._ok, true);
  assert.equal(capped_last_messages_res._result._messages.length, 100);
  assert.equal(capped_last_messages_res._result._count, 100);
  assert.equal(capped_last_messages_res._result._total, 113);
  assert.equal(capped_last_messages_res._result._messages[0]._id, "extra-10");

  const invalid_role_res = await (conversation_xvibe as any)._append_message({
    _params: {
      _app_id: "conversation-app",
      _env: "test",
      _conversation_id: "primary-chat",
      _role: "developer",
      _text: "No",
    },
  });
  assert.equal(invalid_role_res._ok, false);
  assert.equal(invalid_role_res._error._code, "E_XVIBE_INVALID_CONVERSATION_MESSAGE");

  const traversal_app_res = await (conversation_xvibe as any)._create_conversation({
    _params: {
      _app_id: "../bad-app",
      _env: "test",
      _conversation_id: "bad-chat",
    },
  });
  assert.equal(traversal_app_res._ok, false);
  assert.equal(traversal_app_res._error._code, "E_XVIBE_INVALID_APP_ID");

  const traversal_env_res = await (conversation_xvibe as any)._create_conversation({
    _params: {
      _app_id: "conversation-app",
      _env: "../test",
      _conversation_id: "bad-chat",
    },
  });
  assert.equal(traversal_env_res._ok, false);
  assert.equal(traversal_env_res._error._code, "E_XVIBE_INVALID_ENV");

  const traversal_conversation_res = await (conversation_xvibe as any)._get_conversation({
    _params: {
      _app_id: "conversation-app",
      _env: "test",
      _conversation_id: "../primary-chat",
    },
  });
  assert.equal(traversal_conversation_res._ok, false);
  assert.equal(traversal_conversation_res._error._code, "E_XVIBE_INVALID_CONVERSATION_ID");

  const missing_conversation_res = await (conversation_xvibe as any)._get_conversation({
    _params: {
      _app_id: "conversation-app",
      _env: "test",
      _conversation_id: "missing-chat",
    },
  });
  assert.equal(missing_conversation_res._ok, false);
  assert.equal(missing_conversation_res._error._code, "E_XVIBE_CONVERSATION_NOT_FOUND");
} finally {
  (_x as any).getModule = original_get_module;
  await rm(conversation_work_folder, { recursive: true, force: true });
}

console.log("XVibe tests passed");
