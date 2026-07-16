import { _xlog, _xu } from "@xpell/core";
import type {
  XVibeIntentEngineRequest,
  XVibeIntentResult,
} from "../XVibeTypes.js";
import type { XVibeIntentProcessor } from "./XVibeIntentProcessor.js";

const HIGH_CONFIDENCE = 0.95;

const FOCUS_PATTERNS: readonly RegExp[] = [
  /^(?:let'?s|let\s+us)\s+(?:work|focus)\s+on\s+(.+?)$/iu,
  /^(?:please\s+)?(?:work|focus)\s+on\s+(.+?)\s*(?:now|next)?[.!?]*$/iu,
  /^(?:set|update|change)\s+(?:the\s+)?(?:current\s+)?focus\s+(?:to|as)\s+(.+?)$/iu,
  /^(?:switch|move)\s+(?:the\s+)?(?:current\s+)?focus\s+to\s+(.+?)$/iu,
  /^(?:the\s+)?(?:current\s+)?focus\s+(?:is|=)\s+(.+?)$/iu,
];

function trimmed_string(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function clean_focus_text(value: string): string | undefined {
  const cleaned = value
    .trim()
    .replace(/[.!?]+$/u, "")
    .replace(/\s+(?:now|next)$/iu, "")
    .replace(/[.!?]+$/u, "")
    .replace(/\s+/gu, " ")
    .replace(/^(?:the|a|an)\s+/iu, "")
    .trim();

  return cleaned.length > 0 ? cleaned : undefined;
}

function title_case_focus(value: string): string {
  return value
    .split(" ")
    .map((word) => {
      if (/^[A-Z0-9]{2,}$/u.test(word)) return word;
      if (!/[A-Za-z]/u.test(word)) return word;

      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(" ");
}

function extract_focus(message: string): string | undefined {
  const normalized = _xu.normalize_prompt(message)
    .replace(/[‘’`´]/gu, "'")
    .replace(/\s+/gu, " ");
  if (!normalized) return undefined;

  for (const pattern of FOCUS_PATTERNS) {
    const match = normalized.match(pattern);
    const focus = clean_focus_text(match?.[1] ?? "");
    if (focus) return title_case_focus(focus);
  }

  return undefined;
}

function log_focus_skip(reason: string, prompt: string): void {
  _xlog.log("[xvibe] project memory focus skipped", {
    _reason: reason,
    _prompt: _xu.normalize_prompt(prompt),
  });
}

export class ProjectMemoryFocusProcessor implements XVibeIntentProcessor {
  async analyze(
    request: XVibeIntentEngineRequest,
  ): Promise<XVibeIntentResult | null> {
    const focus = extract_focus(request._message);
    if (!focus) {
      log_focus_skip("no_focus_change_intent", request._message);
      return null;
    }

    const app_id = trimmed_string(request._runtime_context._app_id);
    const env = trimmed_string(request._runtime_context._env);
    if (!app_id || !env) {
      log_focus_skip("missing_runtime_context", request._message);
      return null;
    }

    const focus_id =
      _xu.normalize_id(focus) || "project-focus";

    return {
      _message_type: "planning",
      _execution_level: "deterministic",
      _should_mutate: true,
      _confidence: HIGH_CONFIDENCE,
      _reason: "project_memory_focus_change_intent",
      _actions: [
        {
          _id: `set-current-focus-${focus_id}`,
          _title: `Set current focus to ${focus}`,
          _action_type: "module-op",
          _status: "suggested",
          _requires_approval: true,
          _executable: true,
          _params: {
            _app_id: app_id,
            _env: env,
            _memory_patch: {
              _current_focus: focus,
            },
          },
          _execution_payload: {
            _module: "server-xvm",
            _op: "patch-project-memory",
            _params: {
              _app_id: app_id,
              _env: env,
              _patch: {
                _current_focus: focus,
              },
            },
          },
          _confidence: HIGH_CONFIDENCE,
          _reason: "project_memory_focus_change_intent",
        },
      ],
      _warnings: [],
    };
  }
}
