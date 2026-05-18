import { _x, _xlog, type XCommand, XModule } from "@xpell/core";
import { _xem } from "../XEM/XEventManager.js";
import { VibeKnowledgeSelector } from "./VibeKnowledgeSelector.js";


import {
  VibeOutputParser,
  VibeOutputParserError,
  type XVibeCommandArtifact,
  type XVibeEntityArtifact,
  type XVibeFlowArtifact,
  type XVibeJsonObject,
  type XVibeParserDiagnostic,
  type XVibeViewArtifact,
} from "./VibeOutputParser.js";
import { _xu } from "../XNUtils/XUtils.js";
import {
  infer_artifact_type,
  VibePromptBuilder,
} from "./VibePromptBuilder.js";

import type { VibeArtifactType, VibeRequestedArtifactType } from "./XVibeTypes.js";

type VibeAIMode = "full" | "refine";
const DEFAULT_ENV = "default";
const DEFAULT_VIEW_ID = "view-main";
const DEFAULT_SCAFFOLD_ROOT_TYPE = "view";

function is_plain_object(value: unknown): value is XVibeJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function read_prompt(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0
  ) {
    throw new Error(
      "Invalid '_prompt': expected non-empty string"
    );
  }

  return _xu.normalizePrompt(value);
}

function resolve_prompt(
  params: Record<string, unknown>
): string {

  /*
    Canonical runtime param:
    _prompt
  */

  if (
    typeof params._prompt === "string" &&
    params._prompt.trim().length > 0
  ) {
    return read_prompt(params._prompt);
  }

  /*
    Legacy/internal compatibility:
    prompt
  */

  if (
    typeof params.prompt === "string" &&
    params.prompt.trim().length > 0
  ) {
    _xlog.warn('Using legacy "prompt" parameter. Please switch to "_prompt" for better compatibility.');
    return read_prompt(params.prompt);
  }

  throw new Error(
    "Missing '_prompt'"
  );
}

function read_required_string(value: unknown, field_name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid '${field_name}': expected non-empty string`);
  }

  return value.trim();
}

function read_optional_string(value: unknown, field_name: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid '${field_name}': expected non-empty string`);
  }

  return value.trim();
}

function read_optional_string_array(value: unknown, field_name: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error(`Invalid '${field_name}': expected string array`);
  }

  return value.map((item) => read_required_string(item, field_name));
}

function read_mode(value: unknown): VibeAIMode {
  if (value === undefined) {
    return "full";
  }

  if (value === "full" || value === "refine") {
    return value;
  }

  throw new Error("Invalid '_mode': expected 'full' or 'refine'");
}

function read_artifact_type(value: unknown): VibeRequestedArtifactType | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (
    value === "view" ||
    value === "flow" ||
    value === "entity" ||
    value === "command" ||
    value === "auto"
  ) {
    return value;
  }

  throw new Error("Invalid '_artifact_type': expected view, flow, entity, command, or auto");
}

function read_generated_text(value: unknown): string {
  if (is_plain_object(value) && typeof value._text === "string" && value._text.trim().length > 0) {
    return value._text;
  }

  throw new Error("Invalid xai response: missing '_text'");
}

function unwrap_command_result(value: unknown): unknown {
  if (!is_plain_object(value) || typeof value._ok !== "boolean") {
    return value;
  }

  if (value._ok === false) {
    throw new Error(`Command failed: ${JSON.stringify(value._error ?? value._result ?? value)}`);
  }

  return Object.prototype.hasOwnProperty.call(value, "_result")
    ? value._result
    : value;
}

function normalize_full_view_id(
  view: XVibeJsonObject,
  requested_view_id?: string,
): string {
  const parsed_view_id = read_optional_string(view._id, "_view._id");
  const view_id = requested_view_id ?? parsed_view_id ?? DEFAULT_VIEW_ID;

  view._id = view_id;
  return view_id;
}

function ensure_valid_xui_root(view: XVibeJsonObject): asserts view is XVibeViewArtifact {
  if (typeof view._type !== "string" || view._type.trim().length === 0) {
    throw new Error("Invalid AI output: '_view._type' must be a non-empty string");
  }
}

function ensure_artifact_id(artifact: XVibeJsonObject, field_name: string): string {
  return read_required_string(artifact._id, field_name);
}

function read_child_id(value: unknown): string | undefined {
  return is_plain_object(value) && typeof value._id === "string" && value._id.trim().length > 0
    ? value._id.trim()
    : undefined;
}

function merge_child_object(existing_child: unknown, next_child: unknown): unknown {
  if (!is_plain_object(existing_child) || !is_plain_object(next_child)) {
    return next_child;
  }

  const merged = {
    ...existing_child,
    ...next_child,
  };

  if (Array.isArray(next_child._children)) {
    merged._children = merge_children_by_id(existing_child._children, next_child._children);
  }

  return merged;
}

function merge_children_by_id(existing_children: unknown, next_children: unknown): unknown {
  assert_no_duplicate_child_ids(existing_children, "existing_children");
  assert_no_duplicate_child_ids(next_children, "next_children");
  if (!Array.isArray(next_children) || next_children.length === 0) {
    return existing_children;
  }

  if (!Array.isArray(existing_children) || existing_children.length === 0) {
    return next_children;
  }

  const merged = [...existing_children];
  const existing_index_by_id = new Map<string, number>();

  existing_children.forEach((child, index) => {
    const child_id = read_child_id(child);
    if (child_id) existing_index_by_id.set(child_id, index);
  });

  for (const next_child of next_children) {
    const next_child_id = read_child_id(next_child);

    if (next_child_id && existing_index_by_id.has(next_child_id)) {
      const index = existing_index_by_id.get(next_child_id);
      if (index !== undefined) {
        merged[index] = merge_child_object(merged[index], next_child);
      }
      continue;
    }

    merged.push(next_child);
  }

  return merged;
}

export function merge_refined_view(
  current_view: XVibeJsonObject,
  next_view: XVibeJsonObject,
): XVibeJsonObject {
  const merged: XVibeJsonObject = {
    ...current_view,
  };

  for (const [key, value] of Object.entries(next_view)) {
    if (value !== undefined && key !== "_children") {
      merged[key] = value;
    }
  }

  merged._id = next_view._id ?? current_view._id;
  merged._type = next_view._type ?? current_view._type;

  merged._children = merge_children_by_id(current_view._children, next_view._children);

  return merged;
}

function server_xvm_has_op(op: "set_flow" | "set_entity"): boolean {
  const get_module = (_x as unknown as { getModule?: (name: string) => unknown }).getModule;
  if (typeof get_module !== "function") {
    return true;
  }

  const module = get_module.call(_x, "server-xvm");
  if (!module || typeof module !== "object") {
    return false;
  }

  const method_name = `_${op}`;
  return typeof (module as XVibeJsonObject)[method_name] === "function";
}

function explicit_error(code: string, message: string) {
  return {
    _ok: false,
    _error: {
      _code: code,
      _message: message,
    },
  };
}

function parser_diagnostic(error: unknown): XVibeParserDiagnostic | undefined {
  return error instanceof VibeOutputParserError ? error._diagnostic : undefined;
}

function parser_diagnostics(error: unknown): XVibeParserDiagnostic[] | undefined {
  return error instanceof VibeOutputParserError ? error._diagnostics : undefined;
}

function assert_no_duplicate_child_ids(children: unknown, context: string): void {
  if (!Array.isArray(children)) return;

  const seen = new Set<string>();

  for (const child of children) {
    const child_id = read_child_id(child);

    if (child_id) {
      if (seen.has(child_id)) {
        throw new Error(`E_VIBE_DUPLICATE_CHILD_ID: duplicate child _id '${child_id}' in ${context}`);
      }
      seen.add(child_id);
    }

    if (is_plain_object(child)) {
      assert_no_duplicate_child_ids(child._children, `${context}.${child_id ?? "anonymous"}`);
    }
  }
}

type XVibeRuntimeContextInput = {
  _app_id: string;
  _env: string;
  _view_id?: string;
};

export class XVibeModule extends XModule {
  static _name = "xvibe";

  private readonly selector: VibeKnowledgeSelector;
  private readonly prompt_builder: VibePromptBuilder;
  private readonly output_parser: VibeOutputParser;

  constructor() {
    super({ _name: XVibeModule._name });
    this.selector = new VibeKnowledgeSelector();
    this.prompt_builder = new VibePromptBuilder();
    this.output_parser = new VibeOutputParser();
  }

  override async onLoad() {

    _xlog.log("XVibe initialized ✅");
  }

  private async collect_runtime_awareness_context(
    _input: XVibeRuntimeContextInput,
  ): Promise<XVibeJsonObject> {
    // TODO(xvibe-runtime): retrieve existing app structure through server-xvm commands.
    // TODO(xvibe-runtime): expose runtime object graph awareness without DOM assumptions.
    // TODO(xvibe-runtime): expose entity schema awareness through XVM/entity-manager contracts.
    // TODO(xvibe-runtime): retrieve existing view context for refine/full generation.
    // TODO(xvibe-runtime): inject runtime capabilities explicitly into prompts.
    return {};
  }

  private async generate_artifact(params: XVibeJsonObject, forced_artifact_type?: VibeArtifactType) {
    const prompt = resolve_prompt(params);
    const mode = read_mode(params._mode);
    const app_id = read_required_string(params._app_id, "_app_id");
    const env = read_optional_string(params._env, "_env") ?? DEFAULT_ENV;
    const requested_view_id = read_optional_string(params._view_id, "_view_id");
    const requested_artifact_type = read_artifact_type(params._artifact_type);
    const capabilities = read_optional_string_array(params._capabilities, "_capabilities");
    const artifact_type = forced_artifact_type ?? infer_artifact_type(prompt, requested_artifact_type);

    if (mode === "refine" && artifact_type !== "view") {
      throw new Error("Invalid '_mode': refine is only supported for view artifacts");
    }

    if (mode === "refine" && !requested_view_id) {
      throw new Error("Invalid '_view_id': expected non-empty string for refine mode");
    }

    _xlog.log("[xvibe] generate", {
      _mode: mode,
      _artifact_type: artifact_type,
      ...(capabilities.length > 0 ? { _capabilities: capabilities } : {}),
      _app_id: app_id,
      _env: env,
    });

    const selection = this.selector.select(prompt, artifact_type, capabilities);
    _xlog.log("[xvibe] selected skills", {
      _artifact_type: artifact_type,
      _skill_ids: selection.skill_ids,
    });

    const runtime_context = await this.collect_runtime_awareness_context({
      _app_id: app_id,
      _env: env,
      ...(requested_view_id ? { _view_id: requested_view_id } : {}),
    });

    const final_prompt = this.prompt_builder.build({
      prompt,
      _mode: mode,
      _artifact_type: artifact_type,
      selection,
      runtime_context,
    });

    const xai_result: any =
      unwrap_command_result(
        await _x.execute({
          _module: "xai",
          _op: "generate",
          _params: {
            _prompt: final_prompt,
            response_format: {
              type: "json_object"
            }
          }
        } as any)
      );

    _xlog.log("[xvibe] raw ai output", xai_result);
    const parsed =
      this.output_parser.parse(
        read_generated_text(xai_result),
        artifact_type,
      );

    if (parsed._artifact_type !== artifact_type) {
      throw new Error(
        `Invalid AI output: expected '${artifact_type}' artifact but received '${parsed._artifact_type}'`,
      );
    }

    if (artifact_type === "view") {
      if (!parsed._view) throw new Error("Invalid AI output: expected parsed view artifact");
      return this.persist_view_artifact({
        app_id,
        env,
        mode,
        requested_view_id,
        parsed_view: parsed._view,
        include_artifact_type: forced_artifact_type !== "view",
      });
    }

    if (artifact_type === "flow") {
      if (!parsed._flow) throw new Error("Invalid AI output: expected parsed flow artifact");
      return this.persist_flow_artifact(app_id, env, parsed._flow);
    }

    if (artifact_type === "entity") {
      if (!parsed._entity) throw new Error("Invalid AI output: expected parsed entity artifact");
      return this.persist_entity_artifact(app_id, env, parsed._entity);
    }

    if (!parsed._command) throw new Error("Invalid AI output: expected parsed command artifact");
    return this.return_command_artifact(app_id, env, parsed._command);
  }

  private async persist_view_artifact(input: {
    app_id: string;
    env: string;
    mode: VibeAIMode;
    requested_view_id?: string;
    parsed_view: XVibeViewArtifact;
    include_artifact_type: boolean;
  }) {
    let view_to_persist: XVibeJsonObject = input.parsed_view;

    if (input.mode === "refine") {
      const current_result = unwrap_command_result(await _x.execute({
        _module: "server-xvm",
        _op: "get_view",
        _params: {
          _app_id: input.app_id,
          _env: input.env,
          _view_id: input.requested_view_id,
        },
      } as any));

      if (!is_plain_object(current_result) || !is_plain_object(current_result._view)) {
        throw new Error("Invalid server-xvm get_view response");
      }

      view_to_persist = merge_refined_view(current_result._view, {
        ...input.parsed_view,
        _id: input.requested_view_id,
      });
    } else {
      normalize_full_view_id(view_to_persist, input.requested_view_id);
    }

    ensure_valid_xui_root(view_to_persist);

    const view_id = read_required_string(view_to_persist._id, "_view._id");
    _xlog.log("[xvibe] persist artifact", {
      _artifact_type: "view",
      _artifact_id: view_id,
    });

    await _x.execute({
      _module: "server-xvm",
      _op: "push_update",
      _params: {
        _app_id: input.app_id,
        ...(input.env ? { _env: input.env } : {}),
        _view: view_to_persist,
      },
    } as any);

    _xem.fire("vibe:view-updated", {
      _app_id: input.app_id,
      _env: input.env,
      _view_id: view_id,
    });

    _xlog.log("[xvibe] result", {
      _artifact_type: "view",
      _artifact_id: view_id,
    });

    return {
      _ok: true,
      _result: input.include_artifact_type
        ? {
          _artifact_type: "view",
          _artifact_id: view_id,
          _view_id: view_id,
        }
        : {
          _view_id: view_id,
        },
    };
  }

  private async persist_flow_artifact(
    app_id: string,
    env: string,
    flow: XVibeFlowArtifact,
  ) {
    if (!server_xvm_has_op("set_flow")) {
      return explicit_error(
        "E_VIBE_AI_SERVER_XVM_OP_MISSING",
        "server-xvm op 'set_flow' is not available",
      );
    }

    const flow_id = ensure_artifact_id(flow, "_flow._id");

    _xlog.log("[xvibe] persist artifact", {
      _artifact_type: "flow",
      _artifact_id: flow_id,
    });

    await _x.execute({
      _module: "server-xvm",
      _op: "set_flow",
      _params: {
        _app_id: app_id,
        ...(env ? { _env: env } : {}),
        _flow: flow,
      },
    } as any);

    _xem.fire("vibe:flow-updated", {
      _app_id: app_id,
      _env: env,
      _flow_id: flow_id,
    });

    return {
      _ok: true,
      _result: {
        _artifact_type: "flow",
        _artifact_id: flow_id,
        _flow_id: flow_id,
      },
    };
  }

  private async persist_entity_artifact(
    app_id: string,
    env: string,
    entity: XVibeEntityArtifact,
  ) {
    if (!server_xvm_has_op("set_entity")) {
      return explicit_error(
        "E_VIBE_AI_SERVER_XVM_OP_MISSING",
        "server-xvm op 'set_entity' is not available",
      );
    }

    const entity_id = ensure_artifact_id(entity, "_entity._id");

    _xlog.log("[xvibe] persist artifact", {
      _artifact_type: "entity",
      _artifact_id: entity_id,
    });

    await _x.execute({
      _module: "server-xvm",
      _op: "set_entity",
      _params: {
        _app_id: app_id,
        ...(env ? { _env: env } : {}),
        _entity: entity,
      },
    } as any);

    _xem.fire("vibe:entity-updated", {
      _app_id: app_id,
      _env: env,
      _entity_id: entity_id,
    });

    return {
      _ok: true,
      _result: {
        _artifact_type: "entity",
        _artifact_id: entity_id,
        _entity_id: entity_id,
      },
    };
  }

  private return_command_artifact(
    app_id: string,
    env: string,
    command: XVibeCommandArtifact,
  ) {
    const module_name = read_required_string(command._module, "_command._module");
    const op_name = read_required_string(command._op, "_command._op");
    const command_id = `${module_name}.${op_name}`;

    _xlog.log("[xvibe] generated artifact", {
      _artifact_type: "command",
      _artifact_id: command_id,
    });

    _xem.fire("vibe:command-generated", {
      _app_id: app_id,
      _env: env,
      _module: module_name,
      _op: op_name,
    });

    return {
      _ok: true,
      _result: {
        _artifact_type: "command",
        _artifact_id: command_id,
        _command: command,
      },
    };
  }

  async _generate(xcmd: XCommand) {
    try {
      const params = is_plain_object(xcmd?._params) ? xcmd._params : {};
      return await this.generate_artifact(params);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const diagnostic = parser_diagnostic(error);
      const diagnostics = parser_diagnostics(error);
      _xlog.error("[xvibe] generate failed", error);
      return {
        _ok: false,
        _error: {
          _code: "E_VIBE_AI_GENERATE",
          _message: message,
          ...(diagnostic ? { _diagnostic: diagnostic } : {}),
          ...(diagnostics ? { _diagnostics: diagnostics } : {}),
        },
      };
    }
  }

  async _generate_view(xcmd: XCommand) {
    try {
      const params = is_plain_object(xcmd?._params) ? xcmd._params : {};
      return await this.generate_artifact(params, "view");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const diagnostic = parser_diagnostic(error);
      const diagnostics = parser_diagnostics(error);
      _xlog.error("[xvibe] generate_view failed", error);
      return {
        _ok: false,
        _error: {
          _code: "E_VIBE_AI_GENERATE_VIEW",
          _message: message,
          ...(diagnostic ? { _diagnostic: diagnostic } : {}),
          ...(diagnostics ? { _diagnostics: diagnostics } : {}),
        },
      };
    }
  }



  private async bootstrap_scaffold_app(params: XVibeJsonObject) {
    const app_id = read_optional_string(params._app_id, "_app_id") ?? "generated-app";
    const env = read_optional_string(params._env, "_env") ?? DEFAULT_ENV;
    const entry_view_id = read_optional_string(params._entry_view_id, "_entry_view_id") ?? "main";
    const app_name = read_optional_string(params._name, "_name") ?? "Generated App";
    const root_type = read_optional_string(params._root_type, "_root_type")
      ?? read_optional_string(params._scaffold_root_type, "_scaffold_root_type")
      ?? DEFAULT_SCAFFOLD_ROOT_TYPE;

    await _x.execute({
      _module: "server-xvm",
      _op: "create_app",
      _params: {
        _app_id: app_id,
        _env: env,
        _entry_view_id: entry_view_id,
        _name: app_name
      }
    });

    await _x.execute({
      _module: "server-xvm",
      _op: "push_update",
      _params: {
        _app_id: app_id,
        _env: env,
        _view_id: entry_view_id,
        _view: {
          _id: entry_view_id,
          _type: root_type,
          _children: [
            {
              _type: "label",
              _text: "Hello from generated app"
            }
          ]
        }
      }
    });

    return {
      _app_id: app_id,
      _env: env,
      _entry_view_id: entry_view_id,
      _root_type: root_type,
    };
  }

  async _generate_app(cmd: XCommand) {

    const params =
      is_plain_object(cmd?._params)
        ? cmd._params
        : {};

    const prompt =
      typeof params._prompt === "string"
        ? params._prompt.trim()
        : "";

    const app_id =
      typeof params._app_id === "string" &&
        params._app_id.trim().length > 0
        ? params._app_id.trim()
        : "xvibe-app";

    const env =
      typeof params._env === "string" &&
        params._env.trim().length > 0
        ? params._env.trim()
        : "default";

    if (!prompt) {
      throw new Error(
        "Invalid '_prompt': expected non-empty string"
      );
    }

    _xlog.log("[xvibe] generate_app:start", {
      _prompt: prompt,
      _app_id: app_id,
      _env: env,
    });

    /*
      STEP 1:
      Ensure app exists before persistence.
    */

    await _x.execute({
      _module: "server-xvm",
      _op: "create_app",
      _params: {
        _app_id: app_id,
        _env: env,
        _name: app_id,
        _entry_view_id: "main",
      }
    });

    /*
      STEP 2:
      Generate + persist main view
    */

    const generation: any =
      await this._generate_view({
        _module: "xvibe",
        _op: "_generate_view",
        _params: {
          _prompt: prompt,
          _app_id: app_id,
          _env: env,
          _view_id: "main",
        }
      } as any);

    if (
      !is_plain_object(generation) ||
      generation._ok !== true
    ) {
      throw new Error(
        generation?._error?._message ??
        "XVibe generate_view failed"
      );
    }

    const result =
      is_plain_object(generation._result)
        ? generation._result
        : {};

    /*
      STEP 3:
      Read persisted artifact info
      (do NOT expect raw _view anymore)
    */

    const view_id =
      typeof result._view_id === "string" &&
        result._view_id.trim().length > 0
        ? result._view_id.trim()
        : (
          typeof result._artifact_id === "string" &&
            result._artifact_id.trim().length > 0
            ? result._artifact_id.trim()
            : "main"
        );

    const root_type =
      typeof result._root_type === "string" &&
        result._root_type.trim().length > 0
        ? result._root_type.trim()
        : "view";

    _xlog.log("[xvibe] generate_app:done", {
      _app_id: app_id,
      _env: env,
      _view_id: view_id,
      _root_type: root_type,
    });

    await _x.execute({
      _module: "server-xvm",
      _op: "set_active_app",
      _params: {
        _app_id: app_id,
        _env: env
      }
    });

    await _x.execute({
      _module: "server-xvm",
      _op: "set_active_app",
      _params: {
        _app_id: app_id,
        _env: env
      }
    });

    return {
      _ok: true,
      _result: {
        _app_id: app_id,
        _env: env,
        _entry_view_id: view_id,
        _root_type: root_type,
        _generated: true,
      }
    };
  }
}
