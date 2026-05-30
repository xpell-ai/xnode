import type { VibeArtifactType } from "./XVibeTypes.js";

export type XVibeJsonObject = {
  [key: string]: unknown;
};

export const XVIBE_ARTIFACT_CONTRACT_VERSION = 1;

export type XVibeViewArtifact = XVibeJsonObject & {
  _id?: string;
  _type: string;
  _children?: unknown[];
  _page_content?: unknown;
};

export type XVibeFlowArtifact = XVibeJsonObject & {
  _id: string;
  _steps: unknown[];
};

export type XVibeEntityArtifact = XVibeJsonObject & {
  _id: string;
  _schema: XVibeJsonObject;
};

export type XVibeCommandArtifact = XVibeJsonObject & {
  _module: string;
  _op: string;
  _params?: XVibeJsonObject;
};

export type XVibeArtifactEnvelope =
  | { _artifact_type: "view"; _contract_version: 1; _view: XVibeViewArtifact }
  | { _artifact_type: "flow"; _contract_version: 1; _flow: XVibeFlowArtifact }
  | { _artifact_type: "entity"; _contract_version: 1; _entity: XVibeEntityArtifact }
  | { _artifact_type: "command"; _contract_version: 1; _command: XVibeCommandArtifact };

export type XVibeParserPhase =
  | "extraction"
  | "repair"
  | "parser"
  | "validation";

export type XVibeParserDiagnostic = {
  _code: string;
  _phase: XVibeParserPhase;
  _message: string;
  _offset?: number;
  _snippet?: string;
};

export type VibeParsedOutput = {
  _artifact_type: VibeArtifactType;
  _artifact: XVibeViewArtifact | XVibeFlowArtifact | XVibeEntityArtifact | XVibeCommandArtifact;
  _view?: XVibeViewArtifact;
  _flow?: XVibeFlowArtifact;
  _entity?: XVibeEntityArtifact;
  _command?: XVibeCommandArtifact;
  _envelope: XVibeArtifactEnvelope;
  _diagnostics: XVibeParserDiagnostic[];
  _parse_metrics?: {
    _raw_chars: number;
    _extracted_chars: number;
    _repaired_chars: number;
    _diagnostic_count: number;
  };
};

const ARTIFACT_ROOT_KEYS = ["_view", "_flow", "_entity", "_command"] as const;
const ENVELOPE_BASE_KEYS = ["_artifact_type", "_contract_version"] as const;
const PROTOTYPE_POLLUTION_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_RAW_OUTPUT_CHARS = 512_000;
const MAX_EXTRACTED_JSON_CHARS = 256_000;
const MAX_JSON_DEPTH = 128;
const MAX_SANITIZE_DEPTH = 128;
const MAX_SANITIZE_NODES = 20_000;

type JsonFrame = "object" | "array";


function is_plain_object(value: unknown): value is XVibeJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snippet_around(value: string, offset?: number): string {
  if (offset === undefined || offset < 0) {
    return value.slice(0, 160);
  }

  const start = Math.max(0, offset - 80);
  const end = Math.min(value.length, offset + 80);
  return value.slice(start, end);
}

function parse_json_error_offset(error: unknown): number | undefined {
  if (!(error instanceof Error)) return undefined;
  const match = error.message.match(/position\s+(\d+)/i);
  if (!match) return undefined;
  const offset = Number.parseInt(match[1], 10);
  return Number.isFinite(offset) ? offset : undefined;
}

function create_diagnostic(
  _code: string,
  _phase: XVibeParserPhase,
  _message: string,
  source: string,
  _offset?: number,
): XVibeParserDiagnostic {
  return {
    _code,
    _phase,
    _message,
    ...(_offset !== undefined ? { _offset } : {}),
    _snippet: snippet_around(source, _offset),
  };
}

export class VibeOutputParserError extends Error {
  readonly _diagnostic: XVibeParserDiagnostic;
  readonly _diagnostics: XVibeParserDiagnostic[];

  constructor(diagnostics: XVibeParserDiagnostic[] | XVibeParserDiagnostic) {
    const list = Array.isArray(diagnostics) ? diagnostics : [diagnostics];
    const diagnostic = list[list.length - 1];
    super(diagnostic._message);
    this.name = "VibeOutputParserError";
    this._diagnostic = diagnostic;
    this._diagnostics = list;
  }
}

function strip_markdown_fence_wrappers(value: string): string {
  let text = value.trim();
  text = text.replace(/^\uFEFF/, "");

  const fenced = text.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
  if (fenced) {
    text = fenced[1].trim();
  }

  return text;
}


export function extract_balanced_json(raw: string): string {
  const source = strip_markdown_fence_wrappers(raw);

  if (source.length > MAX_RAW_OUTPUT_CHARS) {
    throw new VibeOutputParserError(
      create_diagnostic(
        "E_VIBE_JSON_TOO_LARGE",
        "extraction",
        `AI output exceeds maximum size of ${MAX_RAW_OUTPUT_CHARS} characters`,
        source,
        MAX_RAW_OUTPUT_CHARS,
      ),
    );
  }

  const first_non_ws = source.search(/\S/);
  if (first_non_ws >= 0 && source[first_non_ws] === "[") {
    throw new VibeOutputParserError(
      create_diagnostic(
        "E_VIBE_INVALID_ROOT",
        "extraction",
        "Top-level JSON arrays are not valid XVibe artifact roots",
        source,
        first_non_ws,
      ),
    );
  }

  let start = -1;
  let in_string = false;
  let escape_next = false;
  const stack: JsonFrame[] = [];

  for (let index = 0; index < source.length; index++) {
    const char = source[index];

    if (start === -1) {
      if (char === "{") {
        start = index;
        stack.push("object");
      }
      continue;
    }

    if (escape_next) {
      escape_next = false;
      continue;
    }

    if (char === "\\") {
      escape_next = true;
      continue;
    }

    if (char === "\"") {
      in_string = !in_string;
      continue;
    }

    if (in_string) continue;

    if (char === "{") {
      stack.push("object");
      if (stack.length > MAX_JSON_DEPTH) {
        throw new VibeOutputParserError(
          create_diagnostic(
            "E_VIBE_JSON_TOO_DEEP",
            "extraction",
            `JSON exceeds maximum nesting depth of ${MAX_JSON_DEPTH}`,
            source,
            index,
          ),
        );
      }
      continue;
    }

    if (char === "[") {
      stack.push("array");
      if (stack.length > MAX_JSON_DEPTH) {
        throw new VibeOutputParserError(
          create_diagnostic(
            "E_VIBE_JSON_TOO_DEEP",
            "extraction",
            `JSON exceeds maximum nesting depth of ${MAX_JSON_DEPTH}`,
            source,
            index,
          ),
        );
      }
      continue;
    }

    if (char === "}") {
      if (stack.pop() !== "object") {
        throw new VibeOutputParserError(
          create_diagnostic(
            "E_VIBE_JSON_EXTRACTION",
            "extraction",
            "Mismatched JSON closing token '}'",
            source,
            index,
          ),
        );
      }

      if (stack.length === 0) {
        const extracted = source.slice(start, index + 1);
        if (extracted.length > MAX_EXTRACTED_JSON_CHARS) {
          throw new VibeOutputParserError(
            create_diagnostic(
              "E_VIBE_JSON_TOO_LARGE",
              "extraction",
              `Extracted JSON exceeds maximum size of ${MAX_EXTRACTED_JSON_CHARS} characters`,
              source,
              index,
            ),
          );
        }
        return extracted;
      }
      continue;
    }

    if (char === "]") {
      if (stack.pop() !== "array") {
        throw new VibeOutputParserError(
          create_diagnostic(
            "E_VIBE_JSON_EXTRACTION",
            "extraction",
            "Mismatched JSON closing token ']'",
            source,
            index,
          ),
        );
      }
    }
  }

  throw new VibeOutputParserError(
    create_diagnostic(
      "E_VIBE_JSON_EXTRACTION",
      "extraction",
      start === -1
        ? "No JSON object found in AI output"
        : "No balanced JSON object found in AI output",
      source,
      start === -1 ? undefined : start,
    ),
  );
}

function remove_invalid_control_chars(value: string): string {
  let repaired = "";
  let in_string = false;
  let escape_next = false;

  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    const code = char.charCodeAt(0);

    if (escape_next) {
      repaired += char;
      escape_next = false;
      continue;
    }

    if (char === "\\") {
      repaired += char;
      escape_next = true;
      continue;
    }

    if (char === "\"") {
      repaired += char;
      in_string = !in_string;
      continue;
    }

    if (in_string && code >= 0 && code <= 0x1f) {
      repaired += " ";
      continue;
    }

    repaired += char;
  }

  return repaired;
}

function remove_trailing_commas(value: string): string {
  let repaired = "";
  let in_string = false;
  let escape_next = false;

  for (let index = 0; index < value.length; index++) {
    const char = value[index];

    if (escape_next) {
      repaired += char;
      escape_next = false;
      continue;
    }

    if (char === "\\") {
      repaired += char;
      escape_next = true;
      continue;
    }

    if (char === "\"") {
      repaired += char;
      in_string = !in_string;
      continue;
    }

    if (!in_string && char === ",") {
      let next_index = index + 1;
      while (/\s/.test(value[next_index] ?? "")) next_index++;

      if (value[next_index] === "}" || value[next_index] === "]") {
        continue;
      }

      repaired += ",";
      continue;
    }

    repaired += char;
  }

  return repaired;
}

function assert_no_duplicate_keys(json: string): void {
  const object_stack: Array<Set<string>> = [];
  let in_string = false;
  let escape_next = false;
  let current_string = "";
  let last_string: string | undefined;
  let expecting_key = false;

  for (let i = 0; i < json.length; i++) {
    const char = json[i];

    if (escape_next) {
      current_string += char;
      escape_next = false;
      continue;
    }

    if (char === "\\") {
      if (in_string) current_string += char;
      escape_next = true;
      continue;
    }

    if (char === "\"") {
      if (in_string) {
        in_string = false;
        last_string = current_string;
        current_string = "";
      } else {
        in_string = true;
        current_string = "";
      }
      continue;
    }

    if (in_string) {
      current_string += char;
      continue;
    }

    if (char === "{") {
      object_stack.push(new Set());
      expecting_key = true;
      continue;
    }

    if (char === "}") {
      object_stack.pop();
      expecting_key = false;
      continue;
    }

    if (char === ",") {
      expecting_key = object_stack.length > 0;
      continue;
    }

    if (char === ":" && expecting_key && last_string !== undefined) {
      const current_object = object_stack[object_stack.length - 1];
      if (current_object?.has(last_string)) {
        throw new VibeOutputParserError(
          create_diagnostic(
            "E_VIBE_DUPLICATE_KEY",
            "parser",
            `Duplicate JSON key '${last_string}' is not allowed`,
            json,
            i,
          ),
        );
      }
      current_object?.add(last_string);
      last_string = undefined;
      expecting_key = false;
    }
  }
}

export function repair_json(raw: string): string {
  try {
    let repaired = strip_markdown_fence_wrappers(raw);
    repaired = repaired.replace(/^\uFEFF/, "");
    repaired = repaired
      .replace(/[\u201C\u201D]/g, "\"")
      .replace(/[\u2018\u2019]/g, "'");
    repaired = remove_invalid_control_chars(repaired);
    repaired = remove_trailing_commas(repaired);
    return repaired.trim();
  } catch (error) {
    throw new VibeOutputParserError(
      create_diagnostic(
        "E_VIBE_JSON_REPAIR",
        "repair",
        error instanceof Error ? error.message : String(error),
        raw,
      ),
    );
  }
}

function sanitize_parsed_object(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
  counter: { count: number } = { count: 0 },
): void {
  counter.count++;

  if (counter.count > MAX_SANITIZE_NODES) {

    throw new Error("E_VIBE_OBJECT_TOO_LARGE: parsed object exceeds node limit");

  }

  if (depth > MAX_SANITIZE_DEPTH) {

    throw new Error("E_VIBE_OBJECT_TOO_DEEP: parsed object exceeds depth limit");

  }
  const value_type = typeof value;
  if (
    value_type === "function" ||
    value_type === "symbol" ||
    value_type === "bigint" ||
    value === undefined
  ) {
    throw new Error(`Invalid AI output: unsupported value type '${value_type}'`);
  }

  if (value === null || value_type !== "object") return;

  if (seen.has(value as object)) {
    throw new Error("Invalid AI output: cyclic object is not allowed");
  }
  seen.add(value as object);

  if (Array.isArray(value)) {
    for (const item of value) {
      sanitize_parsed_object(item, seen, depth + 1, counter);
    }
    seen.delete(value as object);
    return;
  }

  if (!is_plain_object(value)) {
    throw new Error("Invalid AI output: non-plain object is not allowed");
  }

  for (const key of Object.keys(value)) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
      throw new Error(`Invalid AI output: forbidden key '${key}'`);
    }
    sanitize_parsed_object(value[key], seen, depth + 1, counter);
  }
  seen.delete(value as object);
}

function validate_xui_root(value: unknown): XVibeViewArtifact {
  if (!is_plain_object(value)) {
    throw new Error("Invalid AI output: '_view' must be an object");
  }

  if (typeof value._type !== "string" || value._type.trim().length === 0) {
    throw new Error("Invalid AI output: '_view._type' must be a non-empty string");
  }
  if (value._children !== undefined && !Array.isArray(value._children)) {
    throw new Error(
      "Invalid AI output: '_view._children' must be an array when present"
    );
  }
  return value as XVibeViewArtifact;
}

function validate_flow(value: unknown): XVibeFlowArtifact {
  if (!is_plain_object(value)) {
    throw new Error("Invalid AI output: '_flow' must be an object");
  }

  if (typeof value._id !== "string" || value._id.trim().length === 0) {
    throw new Error("Invalid AI output: flow requires '_id'");
  }

  if (!Array.isArray(value._steps)) {
    throw new Error("Invalid AI output: flow requires '_steps' array");
  }
  for (const step of value._steps) {
    if (!is_plain_object(step)) {
      throw new Error("Invalid AI output: every flow step must be an object");
    }
  }

  return value as XVibeFlowArtifact;
}

function validate_entity(value: unknown): XVibeEntityArtifact {
  if (!is_plain_object(value)) {
    throw new Error("Invalid AI output: '_entity' must be an object");
  }

  if (typeof value._id !== "string" || value._id.trim().length === 0) {
    throw new Error("Invalid AI output: entity requires '_id'");
  }

  if (!is_plain_object(value._schema)) {
    throw new Error("Invalid AI output: entity requires '_schema' object");
  }

  return value as XVibeEntityArtifact;
}

function validate_command(value: unknown): XVibeCommandArtifact {
  if (!is_plain_object(value)) {
    throw new Error("Invalid AI output: '_command' must be an object");
  }

  if (typeof value._module !== "string" || value._module.trim().length === 0) {
    throw new Error("Invalid AI output: command requires '_module'");
  }

  if (typeof value._op !== "string" || value._op.trim().length === 0) {
    throw new Error("Invalid AI output: command requires '_op'");
  }
  if (value._params !== undefined && !is_plain_object(value._params)) {
    throw new Error(
      "Invalid AI output: command '_params' must be a plain object when present"
    );
  }
  return value as XVibeCommandArtifact;
}

function artifact_key_for_type(artifact_type: VibeArtifactType): typeof ARTIFACT_ROOT_KEYS[number] {
  if (artifact_type === "flow") return "_flow";
  if (artifact_type === "entity") return "_entity";
  if (artifact_type === "command") return "_command";
  return "_view";
}

function validate_contract(
  parsed: unknown,
  expected_artifact_type?: VibeArtifactType,
  diagnostics: XVibeParserDiagnostic[] = [],
): VibeParsedOutput {
  if (!is_plain_object(parsed)) {
    throw new Error("Invalid AI output: expected object envelope");
  }

  const artifact_type = parsed._artifact_type;
  if (
    artifact_type !== "view" &&
    artifact_type !== "flow" &&
    artifact_type !== "entity" &&
    artifact_type !== "command"
  ) {
    throw new Error("Invalid AI output: missing or invalid '_artifact_type'");
  }

  if (parsed._contract_version !== XVIBE_ARTIFACT_CONTRACT_VERSION) {
    throw new Error(`Invalid AI output: unsupported '_contract_version' '${String(parsed._contract_version)}'`);
  }

  if (expected_artifact_type && artifact_type !== expected_artifact_type) {
    throw new Error(
      `Invalid AI output: expected '${expected_artifact_type}' artifact but received '${artifact_type}'`,
    );
  }

  const expected_key = artifact_key_for_type(artifact_type);
  const allowed_keys = new Set<string>([...ENVELOPE_BASE_KEYS, expected_key]);
  const unknown_keys = Object.keys(parsed).filter((key) => !allowed_keys.has(key));
  if (unknown_keys.length > 0) {
    throw new Error(`Invalid AI output: unknown envelope keys '${unknown_keys.join(",")}'`);
  }

  const present_artifact_keys = ARTIFACT_ROOT_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(parsed, key),
  );

  if (present_artifact_keys.length !== 1 || present_artifact_keys[0] !== expected_key) {
    throw new Error(
      `Invalid AI output: artifact envelope must contain only '${expected_key}' for '${artifact_type}'`,
    );
  }

  if (artifact_type === "view") {
    const view = validate_xui_root(parsed._view);
    const envelope: XVibeArtifactEnvelope = {
      _artifact_type: "view",
      _contract_version: XVIBE_ARTIFACT_CONTRACT_VERSION,
      _view: view,
    };
    return {
      _artifact_type: "view",
      _artifact: view,
      _view: view,
      _envelope: envelope,
      _diagnostics: diagnostics,
    };
  }

  if (artifact_type === "flow") {
    const flow = validate_flow(parsed._flow);
    const envelope: XVibeArtifactEnvelope = {
      _artifact_type: "flow",
      _contract_version: XVIBE_ARTIFACT_CONTRACT_VERSION,
      _flow: flow,
    };
    return {
      _artifact_type: "flow",
      _artifact: flow,
      _flow: flow,
      _envelope: envelope,
      _diagnostics: diagnostics,
    };
  }

  if (artifact_type === "entity") {
    const entity = validate_entity(parsed._entity);
    const envelope: XVibeArtifactEnvelope = {
      _artifact_type: "entity",
      _contract_version: XVIBE_ARTIFACT_CONTRACT_VERSION,
      _entity: entity,
    };
    return {
      _artifact_type: "entity",
      _artifact: entity,
      _entity: entity,
      _envelope: envelope,
      _diagnostics: diagnostics,
    };
  }

  const command = validate_command(parsed._command);
  const envelope: XVibeArtifactEnvelope = {
    _artifact_type: "command",
    _contract_version: XVIBE_ARTIFACT_CONTRACT_VERSION,
    _command: command,
  };
  return {
    _artifact_type: "command",
    _artifact: command,
    _command: command,
    _envelope: envelope,
    _diagnostics: diagnostics,
  };
}

export class VibeOutputParser {
  parse(
    raw_output: string,
    expected_artifact_type?: VibeArtifactType,
  ): VibeParsedOutput {
    let extracted: string;
    let repaired: string;
    let parsed: unknown;
    const diagnostics: XVibeParserDiagnostic[] = [];

    try {
      if (raw_output.length > MAX_RAW_OUTPUT_CHARS) {
        throw new VibeOutputParserError(
          create_diagnostic(
            "E_VIBE_JSON_TOO_LARGE",
            "extraction",
            `AI output exceeds maximum size of ${MAX_RAW_OUTPUT_CHARS} characters`,
            raw_output,
            MAX_RAW_OUTPUT_CHARS,
          ),
        );
      }
      extracted = extract_balanced_json(raw_output);
      diagnostics.push(
        create_diagnostic(
          "VIBE_JSON_EXTRACTED",
          "extraction",
          "Balanced JSON object extracted",
          extracted,
        ),
      );
    } catch (error) {
      if (error instanceof VibeOutputParserError) {
        throw new VibeOutputParserError([...diagnostics, ...error._diagnostics]);
      }
      throw new VibeOutputParserError(
        [
          ...diagnostics,
          create_diagnostic(
            "E_VIBE_JSON_EXTRACTION",
            "extraction",
            error instanceof Error ? error.message : String(error),
            raw_output,
          ),
        ],
      );
    }

    try {
      repaired = repair_json(extracted);
      diagnostics.push(
        create_diagnostic(
          repaired === extracted
            ? "VIBE_JSON_REPAIR_SKIPPED"
            : "VIBE_JSON_REPAIR_APPLIED",
          "repair",
          repaired === extracted
            ? "JSON syntax repair was not needed"
            : "Minimal JSON syntax repair applied",
          repaired,
        ),
      );
    } catch (error) {
      if (error instanceof VibeOutputParserError) {
        throw new VibeOutputParserError([...diagnostics, ...error._diagnostics]);
      }
      throw new VibeOutputParserError(
        [
          ...diagnostics,
          create_diagnostic(
            "E_VIBE_JSON_REPAIR",
            "repair",
            error instanceof Error ? error.message : String(error),
            extracted,
          ),
        ],
      );
    }

    try {
      assert_no_duplicate_keys(repaired);
      parsed = JSON.parse(repaired) as unknown;
      diagnostics.push(
        create_diagnostic(
          "VIBE_JSON_PARSED",
          "parser",
          "JSON parsed",
          repaired,
        ),
      );
    } catch (error) {
      const offset = parse_json_error_offset(error);
      throw new VibeOutputParserError(
        [
          ...diagnostics,
          create_diagnostic(
            "E_VIBE_JSON_PARSE",
            "parser",
            error instanceof Error ? error.message : String(error),
            repaired,
            offset,
          ),
        ],
      );
    }

    try {
      sanitize_parsed_object(parsed);
      const output = validate_contract(parsed, expected_artifact_type, diagnostics);
      const validation_diagnostic = create_diagnostic(
        "VIBE_ARTIFACT_VALIDATED",
        "validation",
        "Artifact envelope validated",
        repaired,
      );

      const parse_metrics = {
        _raw_chars: raw_output.length,
        _extracted_chars: extracted.length,
        _repaired_chars: repaired.length,
        _diagnostic_count: diagnostics.length + 1,
      };

      return {
        ...output,
        _diagnostics: [...output._diagnostics, validation_diagnostic],
        _parse_metrics: parse_metrics,
      };
    } catch (error) {
      throw new VibeOutputParserError(
        [
          ...diagnostics,
          create_diagnostic(
            "E_VIBE_ARTIFACT_CONTRACT",
            "validation",
            error instanceof Error ? error.message : String(error),
            repaired,
          ),
        ],
      );
    }
  }
}
