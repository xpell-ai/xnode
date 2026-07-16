import { _x, _xlog, _xu } from "@xpell/core";
import type {
  XVibeIntentEngineRequest,
  XVibeIntentRuntimeContext,
  XVibeIntentResult,
} from "../XVibeTypes.js";
import {
  normalizeProjectViewId,
  resolveProjectViewId,
} from "../StructuredEditing/ProjectViewResolution.js";
import type { XVibeIntentProcessor } from "./XVibeIntentProcessor.js";

type XVibeSelectedObjectEditAction =
  | "hide-object"
  | "show-object"
  | "remove-object"
  | "duplicate-object"
  | "move-object";

type XVibeSelectedObjectCommand = {
  _edit_action: XVibeSelectedObjectEditAction;
  _title: string;
  _move_direction?: "up" | "down";
};

type XVibeDeterministicTextReplacement = {
  _target_text: string;
  _replacement_text: string;
  _target_type?: "label" | "text";
};

type XVibeDeterministicFlowBinding = {
  _target_text: string;
  _target_type: "button";
  _flow_id: string;
};

type XVibeDeterministicButtonCreation = {
  _button_text: string;
  _button_id: string;
  _requested_view_id?: string;
};

const HIGH_CONFIDENCE = 0.95;
const MEAL_FORM_SUCCESS_CLOSE_PROMPT =
  "after the meal form saves successfully, close create-meal-modal";
const CREATE_MEAL_MODAL_CLOSE_COMMAND = {
  _op: "close-object",
  _params: {
    _id: "create-meal-modal",
  },
};

const PROJECT_VIEW_FIX_COMMANDS = new Set([
  "fix project views",
  "fix views",
  "fix view ids",
  "fix project view ids",
  "analyze project views",
]);

const SELECTED_OBJECT_COMMANDS: Record<string, XVibeSelectedObjectCommand> = {
  "hide selected": {
    _edit_action: "hide-object",
    _title: "Hide selected object",
  },
  "hide this": {
    _edit_action: "hide-object",
    _title: "Hide selected object",
  },
  "show selected": {
    _edit_action: "show-object",
    _title: "Show selected object",
  },
  "delete selected": {
    _edit_action: "remove-object",
    _title: "Delete selected object",
  },
  "remove this": {
    _edit_action: "remove-object",
    _title: "Delete selected object",
  },
  "duplicate selected": {
    _edit_action: "duplicate-object",
    _title: "Duplicate selected object",
  },
  "copy this": {
    _edit_action: "duplicate-object",
    _title: "Duplicate selected object",
  },
  "move selected up": {
    _edit_action: "move-object",
    _title: "Move selected object up",
    _move_direction: "up",
  },
  "move up": {
    _edit_action: "move-object",
    _title: "Move selected object up",
    _move_direction: "up",
  },
  "move selected down": {
    _edit_action: "move-object",
    _title: "Move selected object down",
    _move_direction: "down",
  },
  "move down": {
    _edit_action: "move-object",
    _title: "Move selected object down",
    _move_direction: "down",
  },
};

function normalize_selected_object_command(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/u, "")
    .replace(/\s+/gu, " ");
}

function read_non_empty_string(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function read_current_view_id(runtime_context: XVibeIntentRuntimeContext): string {
  const current_artifact =
    _xu.is_plain_object(runtime_context._current_artifact)
      ? runtime_context._current_artifact
      : undefined;
  return (
    read_non_empty_string(runtime_context._active_view_id) ??
    read_non_empty_string(current_artifact?._id) ??
    "main"
  );
}

function title_case_words(value: string): string {
  return value
    .trim()
    .split(/\s+/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function stable_button_id_from_text(value: string): string {
  const base =
    normalizeProjectViewId(value);
  return `${base || "button"}-button`;
}

function parse_deterministic_button_creation(
  message: string,
): XVibeDeterministicButtonCreation | null {
  const normalized =
    message.trim().replace(/[.!?]+$/u, "").replace(/\s+/gu, " ");
  const button_match =
    /^\s*(?:add|create)\s+(?:a\s+|an\s+|the\s+)?(?:"([^"]+)"|'([^']+)'|([a-z0-9][a-z0-9 -]*?))\s+button(?:\s+\b(?:to|in|inside|on)\b\s+(?:the\s+)?(.+?))?\s*$/iu
      .exec(normalized);
  if (!button_match) return null;

  const quoted_text =
    read_non_empty_string(button_match[1]) ??
    read_non_empty_string(button_match[2]);
  const unquoted_text =
    read_non_empty_string(button_match[3]);
  const button_text =
    quoted_text ?? (unquoted_text ? title_case_words(unquoted_text) : null);
  if (!button_text) return null;

  const requested_view_raw =
    read_non_empty_string(button_match[4]);
  const requested_view_id =
    requested_view_raw
      ? requested_view_raw
        .replace(/\bview$/iu, "view")
        .trim()
      : undefined;

  return {
    _button_text: button_text,
    _button_id: stable_button_id_from_text(button_text),
    ...(requested_view_id ? { _requested_view_id: requested_view_id } : {}),
  };
}

function runtime_available_views(runtime_context: XVibeIntentRuntimeContext): string[] {
  const views =
    runtime_context._available_artifacts?._views;
  return Array.isArray(views)
    ? views.filter((view): view is string =>
      typeof view === "string" && view.trim().length > 0
    )
    : [];
}

async function load_available_view_ids(input: {
  _app_id: string;
  _env: string;
  _runtime_context: XVibeIntentRuntimeContext;
}): Promise<string[]> {
  const runtime_views =
    runtime_available_views(input._runtime_context);
  if (runtime_views.length > 0) {
    return runtime_views;
  }

  try {
    const response =
      await _x.execute({
        _module: "server-xvm",
        _op: "list_views",
        _params: {
          _app_id: input._app_id,
          _env: input._env,
        },
      } as any);
    const views =
      _xu.is_plain_object(response?._result) &&
      Array.isArray(response._result._views)
        ? response._result._views
        : [];
    return views
      .map((view: unknown) =>
        typeof view === "string"
          ? view.trim()
          : _xu.is_plain_object(view) && typeof view._id === "string"
            ? view._id.trim()
            : ""
      )
      .filter((view_id: string) => view_id.length > 0);
  } catch {
    return [];
  }
}

function parse_deterministic_text_replacement(
  message: string,
): XVibeDeterministicTextReplacement | null {
  const quoted_values =
    [...message.matchAll(/["'“”‘’]([^"'“”‘’]+)["'“”‘’]/gu)]
      .map((match) => ({
        _value: read_non_empty_string(match[1]),
        _index: match.index ?? 0,
        _end: (match.index ?? 0) + match[0].length,
      }))
      .filter((match): match is { _value: string; _index: number; _end: number } =>
        Boolean(match._value)
      );
  if (quoted_values.length < 2) return null;

  const first = quoted_values[0];
  const second = quoted_values[1];
  const before_first =
    message.slice(0, first._index);
  const between_quotes =
    message.slice(first._end, second._index);
  const verb_context =
    `${before_first} ${between_quotes}`;
  if (!/\b(?:change|update|replace|rename)\b/iu.test(verb_context)) {
    return null;
  }
  if (!/\b(?:to|with)\b/iu.test(between_quotes)) {
    return null;
  }

  const target_context =
    `${before_first} ${between_quotes}`.toLowerCase();
  const target_type =
    /\btext\b/iu.test(target_context) &&
      !/\b(?:label|title|heading)\b/iu.test(target_context)
      ? "text"
      : "label";

  return {
    _target_text: first._value,
    _replacement_text: second._value,
    _target_type: target_type,
  };
}

function clean_flow_binding_target(value: string): string {
  return value
    .trim()
    .replace(/^the\s+/iu, "")
    .replace(/\s+button$/iu, "")
    .trim();
}

function parse_deterministic_flow_binding(
  message: string,
): XVibeDeterministicFlowBinding | null {
  const normalized =
    message.trim().replace(/[.!?]+$/u, "").replace(/\s+/gu, " ");
  const patterns = [
    /^\s*bind\s+(.+?)\s+to\s+([a-z0-9][a-z0-9_-]*)(?:\s+flow)?\s*$/iu,
    /^\s*connect\s+(.+?)\s+to\s+([a-z0-9][a-z0-9_-]*)(?:\s+flow)?\s*$/iu,
    /^\s*make\s+(.+?)\s+run\s+(?:the\s+)?([a-z0-9][a-z0-9_-]*)(?:\s+flow)?\s*$/iu,
  ];

  for (const pattern of patterns) {
    const match = pattern.exec(normalized);
    if (!match) continue;

    const target_text = clean_flow_binding_target(match[1] ?? "");
    const flow_id = read_non_empty_string(match[2]);
    if (!target_text || !flow_id) continue;

    return {
      _target_text: target_text,
      _target_type: "button",
      _flow_id: flow_id,
    };
  }

  return null;
}

async function deterministic_flow_exists(input: {
  _app_id: string;
  _env: string;
  _flow_id: string;
}): Promise<boolean> {
  try {
    const response = await _x.execute({
      _module: "server-xvm",
      _op: "get_flow",
      _params: {
        _app_id: input._app_id,
        _env: input._env,
        _flow_id: input._flow_id,
      },
    } as any);
    return _xu.is_plain_object(response) && response._ok === true;
  } catch {
    return false;
  }
}

async function load_runtime_view(input: {
  _app_id: string;
  _env: string;
  _view_id: string;
}): Promise<Record<string, any> | null> {
  try {
    const response = await _x.execute({
      _module: "server-xvm",
      _op: "get_view",
      _params: {
        _app_id: input._app_id,
        _env: input._env,
        _view_id: input._view_id,
      },
    } as any);
    const view =
      _xu.is_plain_object(response?._result) &&
      _xu.is_plain_object(response._result._view)
        ? response._result._view
        : undefined;
    return view ? view as Record<string, any> : null;
  } catch {
    return null;
  }
}

async function load_runtime_flow(input: {
  _app_id: string;
  _env: string;
  _flow_id: string;
}): Promise<Record<string, any> | null> {
  try {
    const response = await _x.execute({
      _module: "server-xvm",
      _op: "get_flow",
      _params: {
        _app_id: input._app_id,
        _env: input._env,
        _flow_id: input._flow_id,
      },
    } as any);
    const flow =
      _xu.is_plain_object(response?._result) &&
      _xu.is_plain_object(response._result._flow)
        ? response._result._flow
        : undefined;
    return flow ? flow as Record<string, any> : null;
  } catch {
    return null;
  }
}

function find_node_by_id(value: unknown, id: string): Record<string, any> | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = find_node_by_id(item, id);
      if (found) return found;
    }
    return null;
  }

  if (!_xu.is_plain_object(value)) {
    return null;
  }

  if (value._id === id) {
    return value as Record<string, any>;
  }

  return find_node_by_id(value._children, id);
}

function normalize_exact_prompt(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/u, "")
    .replace(/\s+/gu, " ");
}

export class DeterministicIntentProcessor implements XVibeIntentProcessor {
  async analyze(
    request: XVibeIntentEngineRequest,
  ): Promise<XVibeIntentResult | null> {
    const normalized_command =
      normalize_selected_object_command(request._message);
    if (normalize_exact_prompt(request._message) === MEAL_FORM_SUCCESS_CLOSE_PROMPT) {
      const app_id = read_non_empty_string(request._runtime_context._app_id);
      const env = read_non_empty_string(request._runtime_context._env);
      if (!app_id || !env) {
        return null;
      }

      const available_views =
        await load_available_view_ids({
          _app_id: app_id,
          _env: env,
          _runtime_context: request._runtime_context,
        });
      const shell_view_id =
        available_views.includes("home")
          ? "home"
          : available_views.includes("main")
            ? "main"
            : null;
      const create_meal_view =
        available_views.includes("create-meal")
          ? await load_runtime_view({
            _app_id: app_id,
            _env: env,
            _view_id: "create-meal",
          })
          : null;
      const shell_view =
        shell_view_id
          ? await load_runtime_view({
            _app_id: app_id,
            _env: env,
            _view_id: shell_view_id,
          })
          : null;
      const submit =
        create_meal_view
          ? find_node_by_id(create_meal_view, "create-meal-submit")
          : null;
      const flow_id =
        _xu.is_plain_object(submit?._flow) &&
        typeof submit?._flow?._id === "string" &&
        submit._flow._id.trim().length > 0
          ? submit._flow._id.trim()
          : null;
      const flow =
        flow_id
          ? await load_runtime_flow({
            _app_id: app_id,
            _env: env,
            _flow_id: flow_id,
          })
          : null;
      const missing: string[] = [];
      if (!shell_view_id || !shell_view) missing.push("main_home_view_not_found");
      if (!create_meal_view) missing.push("create_meal_view_not_found");
      if (!submit) missing.push("create_meal_submit_not_found");
      if (!flow_id || !flow) missing.push("create_meal_flow_not_found");
      if (shell_view && !find_node_by_id(shell_view, "create-meal-modal")) {
        missing.push("create_meal_modal_not_found");
      }

      const params = {
        _app_id: app_id,
        _env: env,
        _flow_id: flow_id ?? "create-meal",
        _command: CREATE_MEAL_MODAL_CLOSE_COMMAND,
      };
      const executable = missing.length === 0;

      return {
        _message_type: "edit",
        _execution_level: "deterministic",
        _should_mutate: true,
        _confidence: HIGH_CONFIDENCE,
        _reason: executable
          ? "deterministic_meal_form_success_modal_close"
          : "meal_form_success_modal_close_not_ready",
        _artifact_type: "flow",
        _artifact_request: {
          _operation: "append-on-success-command",
          _flow_id: params._flow_id,
          _command: CREATE_MEAL_MODAL_CLOSE_COMMAND,
        },
        _actions: [
          {
            _id: "close-create-meal-modal-on-success",
            _title: "Close Add Meal modal after successful save",
            _action_type: "module-op",
            _status: "suggested",
            _requires_approval: true,
            _executable: executable,
            _params: params,
            ...(executable
              ? {
                _execution_payload: {
                  _module: "xvibe",
                  _op: "append-flow-success-command",
                  _params: params,
                },
              }
              : {
                _non_executable_reason: missing.join(","),
              }),
            _confidence: HIGH_CONFIDENCE,
            _reason: executable
              ? "deterministic_meal_form_success_modal_close"
              : "meal_form_success_modal_close_not_ready",
          },
        ],
        _warnings: missing,
      };
    }

    if (PROJECT_VIEW_FIX_COMMANDS.has(normalized_command)) {
      const app_id = read_non_empty_string(request._runtime_context._app_id);
      const env = read_non_empty_string(request._runtime_context._env);
      if (!app_id || !env) {
        return null;
      }

      return {
        _message_type: "edit",
        _execution_level: "deterministic",
        _should_mutate: true,
        _confidence: HIGH_CONFIDENCE,
        _reason: "deterministic_project_view_integrity_command",
        _actions: [
          {
            _id: "fix-project-views",
            _title: "Fix project view IDs",
            _action_type: "module-op",
            _status: "suggested",
            _requires_approval: true,
            _executable: true,
            _params: {
              _app_id: app_id,
              _env: env,
            },
            _execution_payload: {
              _module: "xvibe",
              _op: "fix-project-views",
              _params: {
                _app_id: app_id,
                _env: env,
              },
            },
            _confidence: HIGH_CONFIDENCE,
            _reason: "deterministic_project_view_integrity_command",
          },
        ],
        _warnings: [],
      };
    }

    const text_replacement =
      parse_deterministic_text_replacement(request._message);
    if (text_replacement) {
      const app_id =
        read_non_empty_string(request._runtime_context._app_id);
      const env =
        read_non_empty_string(request._runtime_context._env);
      if (!app_id || !env) {
        return null;
      }

      const view_id =
        read_current_view_id(request._runtime_context);
      _xlog.log("[xvibe] deterministic text replacement matched", {
        _source_text: text_replacement._target_text,
        _replacement_text: text_replacement._replacement_text,
        _view_id: view_id,
      });
      const params: Record<string, unknown> = {
        _app_id: app_id,
        _env: env,
        _view_id: view_id,
        _target_id: text_replacement._target_text,
        _edit_action: "update-property",
        _property_name: "_text",
        _property_value: text_replacement._replacement_text,
      };
      if (text_replacement._target_type) {
        params._target_type = text_replacement._target_type;
      }

      return {
        _message_type: "edit",
        _execution_level: "deterministic",
        _should_mutate: true,
        _confidence: HIGH_CONFIDENCE,
        _reason: "deterministic_text_replacement",
        _actions: [
          {
            _id: "deterministic-text-replacement",
            _title: "Update text",
            _action_type: "apply-view-edit",
            _status: "suggested",
            _requires_approval: true,
            _executable: true,
            _params: params,
            _execution_payload: {
              _module: "xvibe",
              _op: "apply-view-edit",
              _params: params,
            },
            _confidence: HIGH_CONFIDENCE,
            _reason: "deterministic_text_replacement",
          },
        ],
        _warnings: [],
      };
    }

    const flow_binding =
      parse_deterministic_flow_binding(request._message);
    if (flow_binding) {
      const app_id =
        read_non_empty_string(request._runtime_context._app_id);
      const env =
        read_non_empty_string(request._runtime_context._env);
      if (!app_id || !env) {
        return null;
      }

      const view_id =
        read_current_view_id(request._runtime_context);
      const params: Record<string, unknown> = {
        _app_id: app_id,
        _env: env,
        _view_id: view_id,
        _target_id: flow_binding._target_text,
        _target_text: flow_binding._target_text,
        _target_type: flow_binding._target_type,
        _edit_action: "bind-flow",
        _flow: {
          _id: flow_binding._flow_id,
          _payload: {},
        },
        _flow_event: "click",
        _flow_auto: true,
      };
      const flow_exists =
        await deterministic_flow_exists({
          _app_id: app_id,
          _env: env,
          _flow_id: flow_binding._flow_id,
        });

      _xlog.log("[xvibe] deterministic flow binding matched", {
        _target_text: flow_binding._target_text,
        _flow_id: flow_binding._flow_id,
        _view_id: view_id,
        _flow_exists: flow_exists,
      });

      return {
        _message_type: "edit",
        _execution_level: "deterministic",
        _should_mutate: true,
        _confidence: HIGH_CONFIDENCE,
        _reason: flow_exists
          ? "deterministic_flow_binding"
          : "flow_not_found",
        _actions: [
          {
            _id: "deterministic-flow-binding",
            _title: "Bind flow",
            _action_type: "apply-view-edit",
            _status: "suggested",
            _requires_approval: true,
            _executable: flow_exists,
            _params: params,
            ...(flow_exists
              ? {
                _execution_payload: {
                  _module: "xvibe",
                  _op: "apply-view-edit",
                  _params: params,
                },
              }
              : {}),
            _confidence: HIGH_CONFIDENCE,
            _reason: flow_exists
              ? "deterministic_flow_binding"
              : "flow_not_found",
          },
        ],
        _warnings: flow_exists ? [] : ["flow_not_found"],
      };
    }

    const button_creation =
      parse_deterministic_button_creation(request._message);
    if (button_creation) {
      const app_id =
        read_non_empty_string(request._runtime_context._app_id);
      const env =
        read_non_empty_string(request._runtime_context._env);
      if (!app_id || !env) {
        return null;
      }

      const current_view_id =
        read_current_view_id(request._runtime_context);
      const available_views =
        await load_available_view_ids({
          _app_id: app_id,
          _env: env,
          _runtime_context: request._runtime_context,
        });
      const view_resolution =
        resolveProjectViewId({
          app_id,
          env,
          requested_view_id: button_creation._requested_view_id,
          current_view_id,
          available_views,
        });
      if (!view_resolution._ok) {
        _xlog.log("[xvibe] deterministic button creation rejected", {
          _button_id: button_creation._button_id,
          _requested_view_id: button_creation._requested_view_id,
          _reason: view_resolution._reason,
        });
        return null;
      }

      const params: Record<string, unknown> = {
        _app_id: app_id,
        _env: env,
        _view_id: view_resolution._view_id,
        _target_id: view_resolution._view_id,
        _target_type: "view",
        _edit_action: "add-child",
        _location: "bottom",
        _child: {
          _type: "button",
          _id: button_creation._button_id,
          _text: button_creation._button_text,
        },
      };

      _xlog.log("[xvibe] deterministic button creation matched", {
        _button_id: button_creation._button_id,
        _button_text: button_creation._button_text,
        _requested_view_id: button_creation._requested_view_id,
        _view_id: view_resolution._view_id,
        _view_resolution: view_resolution._strategy,
      });

      return {
        _message_type: "edit",
        _execution_level: "deterministic",
        _should_mutate: true,
        _confidence: HIGH_CONFIDENCE,
        _reason: "deterministic_button_creation",
        _actions: [
          {
            _id: "deterministic-button-creation",
            _title: "Add button",
            _action_type: "apply-view-edit",
            _status: "suggested",
            _requires_approval: true,
            _executable: true,
            _params: params,
            _execution_payload: {
              _module: "xvibe",
              _op: "apply-view-edit",
              _params: params,
            },
            _confidence: HIGH_CONFIDENCE,
            _reason: "deterministic_button_creation",
          },
        ],
        _warnings: [],
      };
    }

    const command =
      SELECTED_OBJECT_COMMANDS[
        normalized_command
      ];
    if (!command) {
      return null;
    }

    const selected_object = request._runtime_context._selected_object;
    if (!_xu.is_plain_object(selected_object)) {
      return null;
    }

    const view_id = read_non_empty_string(selected_object._source_view_id);
    const target_id =
      read_non_empty_string(selected_object._json_id) ??
      read_non_empty_string(selected_object._id);
    const target_type = read_non_empty_string(selected_object._type);
    if (!view_id || !target_id || !target_type) {
      return null;
    }

    const params: Record<string, unknown> = {
      _view_id: view_id,
      _target_id: target_id,
      _target_type: target_type,
      _edit_action: command._edit_action,
    };

    if (command._move_direction) {
      params._move_direction = command._move_direction;
      params._requires_resolution = true;
    }

    return {
      _message_type: "edit",
      _execution_level: "deterministic",
      _should_mutate: true,
      _confidence: HIGH_CONFIDENCE,
      _reason: "deterministic_selected_object_command",
      _actions: [
        {
          _id: `selected-object-${command._edit_action}`,
          _title: command._title,
          _action_type: "apply-view-edit",
          _status: "suggested",
          _requires_approval: true,
          _params: params,
          _confidence: HIGH_CONFIDENCE,
          _reason: "deterministic_selected_object_command",
        },
      ],
      _warnings: [],
    };
  }
}
