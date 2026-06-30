import { _xu } from "@xpell/core";
import type {
  XVibeIntentEngineRequest,
  XVibeIntentResult,
} from "../XVibeTypes.js";
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

const HIGH_CONFIDENCE = 0.95;

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

export class DeterministicIntentProcessor implements XVibeIntentProcessor {
  async analyze(
    request: XVibeIntentEngineRequest,
  ): Promise<XVibeIntentResult | null> {
    const command =
      SELECTED_OBJECT_COMMANDS[
        normalize_selected_object_command(request._message)
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
