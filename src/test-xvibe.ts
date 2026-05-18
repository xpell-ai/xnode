import assert from "assert";
import { merge_refined_view } from "./XVIBE/XVibeModule.js";
import {
  VibeOutputParser,
  VibeOutputParserError,
  extract_balanced_json,
  repair_json,
} from "./XVIBE/VibeOutputParser.js";

function assert_parser_error(
  fn: () => unknown,
  phase: string,
  code: string,
  min_diagnostics = 1,
): void {
  try {
    fn();
    assert.fail("Expected parser error");
  } catch (error) {
    if (!(error instanceof VibeOutputParserError)) {
      throw error;
    }
    assert.equal(error._diagnostic._phase, phase);
    assert.equal(error._diagnostic._code, code);
    assert.ok(error._diagnostics.length >= min_diagnostics);
    assert.equal(typeof error._diagnostic._message, "string");
    assert.ok(error._diagnostic._snippet);
  }
}

const parser = new VibeOutputParser();

assert.equal(
  extract_balanced_json('prefix {"_artifact_type":"view","_contract_version":1,"_view":{"_type":"x-panel"}} suffix'),
  '{"_artifact_type":"view","_contract_version":1,"_view":{"_type":"x-panel"}}',
);

assert.equal(
  repair_json('{"_artifact_type":"view","_contract_version":1,"_view":{"_type":"x-panel",},}'),
  '{"_artifact_type":"view","_contract_version":1,"_view":{"_type":"x-panel"}}',
);

const fenced = parser.parse(
  '```json\n{"_artifact_type":"view","_contract_version":1,"_view":{"_id":"main","_type":"x-window","_children":[]}}\n```',
  "view",
);
assert.equal(fenced._view!._type, "x-window");
assert.ok(fenced._diagnostics.length >= 4);

const nested = parser.parse(
  'before {"_artifact_type":"view","_contract_version":1,"_view":{"_type":"aime-dashboard-window","_children":[{"_type":"label","_text":"literal { brace }"}]}} after',
  "view",
);
assert.equal(nested._view!._type, "aime-dashboard-window");
assert.deepEqual(nested._view!._children, [
  {
    _type: "label",
    _text: "literal { brace }",
  },
]);

const trailing_commas = parser.parse(
  '{"_artifact_type":"flow","_contract_version":1,"_flow":{"_id":"flow-main","_steps":[{"_id":"step-1",},],},}',
  "flow",
);
assert.equal(trailing_commas._flow!._id, "flow-main");

assert_parser_error(
  () => parser.parse('{"_artifact_type":"entity",,"_contract_version":1,"_entity":{"_id":"user","_schema":{}}}', "entity"),
  "parser",
  "E_VIBE_JSON_PARSE",
  2,
);

const smart_quotes = parser.parse(
  '{“_artifact_type”:“view”,“_contract_version”:1,“_view”:{“_type”:“x-panel”,“_children”:[{“_type”:“label”,“_text”:“{stable}”}]}}',
  "view",
);
assert.equal(smart_quotes._view!._type, "x-panel");

assert_parser_error(
  () => parser.parse('{“_artifact_type”:“view”,“_contract_version”:1,“_view”:{“_type”:“x-panel”,“_children”:[{“_type”:“label”,“_text”:“{broken”}]}}', "view"),
  "extraction",
  "E_VIBE_JSON_EXTRACTION",
);

const invalid_control = parser.parse(
  '{"_artifact_type":"view","_contract_version":1,"_view":{"_type":"x-panel","_children":[{"_type":"label","_text":"hello\nworld"}]}}',
  "view",
);
assert.equal(
  (invalid_control._view!._children?.[0] as { _text?: string })._text,
  "hello world",
);

const wrapped_command = parser.parse(
  '{"_artifact_type":"command","_contract_version":1,"_command":{"_module":"server-xvm","_op":"get-view","_params":{"_view_id":"main"}}}',
  "command",
);
assert.equal(wrapped_command._command!._module, "server-xvm");

const first_object = parser.parse(
  'Explanation before JSON {"_artifact_type":"view","_contract_version":1,"_view":{"_type":"x-panel"}} {"_artifact_type":"flow","_contract_version":1,"_flow":{"_id":"ignored","_steps":[]}}',
  "view",
);
assert.equal(first_object._view!._type, "x-panel");

assert_parser_error(
  () => parser.parse('{"_type":"view","_children":[]}', "view"),
  "validation",
  "E_VIBE_ARTIFACT_CONTRACT",
  4,
);

assert_parser_error(
  () => parser.parse('{"_artifact_type":"view","_contract_version":1,"_flow":{"_id":"f","_steps":[]}}', "view"),
  "validation",
  "E_VIBE_ARTIFACT_CONTRACT",
  4,
);

assert_parser_error(
  () => parser.parse('{"_artifact_type":"view","_contract_version":1,"_view":{"_type":"x-panel"},"_flow":{"_id":"f","_steps":[]}}', "view"),
  "validation",
  "E_VIBE_ARTIFACT_CONTRACT",
  4,
);

assert_parser_error(
  () => parser.parse('{"_artifact_type":"view","_contract_version":1,"_view":{"_type":"x-panel"', "view"),
  "extraction",
  "E_VIBE_JSON_EXTRACTION",
);

assert_parser_error(
  () => parser.parse('{"_artifact_type":"view","_contract_version":1,"_view":{"_type":123}}', "view"),
  "validation",
  "E_VIBE_ARTIFACT_CONTRACT",
  4,
);

assert_parser_error(
  () => parser.parse('{"_artifact_type":"VIEW","_contract_version":1,"_view":{"_type":"x-panel"}}', "view"),
  "validation",
  "E_VIBE_ARTIFACT_CONTRACT",
  4,
);

assert_parser_error(
  () => parser.parse('{"_artifact_type":"view","_contract_version":2,"_view":{"_type":"x-panel"}}', "view"),
  "validation",
  "E_VIBE_ARTIFACT_CONTRACT",
  4,
);

assert_parser_error(
  () => parser.parse('{"_artifact_type":"view","_contract_version":1,"_meta":{},"_view":{"_type":"x-panel"}}', "view"),
  "validation",
  "E_VIBE_ARTIFACT_CONTRACT",
  4,
);

assert_parser_error(
  () => parser.parse('{"_artifact_type":"view","_contract_version":1,"__proto__":{},"_view":{"_type":"x-panel"}}', "view"),
  "validation",
  "E_VIBE_ARTIFACT_CONTRACT",
  4,
);

const too_deep_json = `${"{".repeat(140)}"_artifact_type":"view","_contract_version":1,"_view":{"_type":"x-panel"}${"}".repeat(140)}`;
assert_parser_error(
  () => parser.parse(too_deep_json, "view"),
  "extraction",
  "E_VIBE_JSON_TOO_DEEP",
);

assert_parser_error(
  () => parser.parse("x".repeat(520_000), "view"),
  "extraction",
  "E_VIBE_JSON_TOO_LARGE",
);

const refined = merge_refined_view(
  {
    _id: "main",
    _type: "aime-dashboard-window",
    _children: [
      { _id: "title", _type: "label", _text: "Old" },
      { _id: "stable", _type: "x-panel", _children: [{ _id: "nested", _type: "label" }] },
    ],
  },
  {
    _children: [
      { _id: "stable", _children: [{ _id: "nested", _text: "Updated" }] },
      { _id: "new", _type: "button" },
    ],
  },
);

assert.equal(refined._type, "aime-dashboard-window");
assert.deepEqual(refined._children, [
  { _id: "title", _type: "label", _text: "Old" },
  { _id: "stable", _type: "x-panel", _children: [{ _id: "nested", _type: "label", _text: "Updated" }] },
  { _id: "new", _type: "button" },
]);

console.log("XVibe parser tests passed");
