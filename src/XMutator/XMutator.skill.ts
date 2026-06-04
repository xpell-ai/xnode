import type {
  XpellSkill,
  XpellSkillCommand
} from "@xpell/core";

export const XMUTATOR_OPS: Record<string, XpellSkillCommand> = {
  "validate-mutation": {
    _name: "validate-mutation",
    _scope: "module",
    _description:
      "Validate a mutation plan shape without traversing, mutating, or persisting an artifact.",
    _params: {
      _artifact_type: "XMutatorArtifactType",
      _artifact_id: "string",
      _artifact: "Record<string, unknown>",
      _ops: "XMutatorOperation[]",
      _dry_run: "boolean"
    }
  },
  "mutate-view": {
    _name: "mutate-view",
    _scope: "module",
    _description:
      "Apply a controlled mutation plan to a server-xvm view artifact. Prefer update_props for simple UI edits; use replace_by_id only for intentional full object replacement.",
    _params: {
      _app_id: "string",
      _env: "string",
      _view_id: "string",
      _view: "Record<string, unknown>",
      _ops: "XMutatorOperation[]",
      _dry_run: "boolean"
    },
    _example: {
      _app_id: "my-app",
      _env: "default",
      _view_id: "main",
      _dry_run: true,
      _ops: [
        {
          _op_type: "update_props",
          _target_id: "new-game",
          _props: {
            _text: "Restart Game"
          }
        }
      ]
    }
  },
  "mutate-flow": {
    _name: "mutate-flow",
    _scope: "module",
    _description:
      "Apply a controlled mutation plan to an in-memory flow artifact.",
    _params: {
      _app_id: "string",
      _env: "string",
      _flow_id: "string",
      _flow: "Record<string, unknown>",
      _ops: "XMutatorOperation[]",
      _dry_run: "boolean"
    }
  },
  "mutate-entity": {
    _name: "mutate-entity",
    _scope: "module",
    _description:
      "Apply a controlled mutation plan to an in-memory entity artifact.",
    _params: {
      _app_id: "string",
      _env: "string",
      _entity_id: "string",
      _entity: "Record<string, unknown>",
      _ops: "XMutatorOperation[]",
      _dry_run: "boolean"
    }
  }
};

export const XMUTATOR_SKILL: XpellSkill = {
  _id: "xmutator",
  _title: "XMutator",
  _version: "0.1.0",
  _active: true,
  _type: "server-module-api",
  _requires: [
    "xmodule",
    "server-xvm"
  ],
  _description:
    "Server-side artifact mutation module for applying controlled mutation plans to Xpell runtime artifacts. For simple UI edits such as text, class, style, href, target, and similar property changes, use update_props so existing runtime wiring is preserved.",
  _core_rules: [
    "Use update_props for simple property edits such as _text, class, style, href, target, disabled, value, and similar fields.",
    "update_props shallow-merges _props into the existing object and preserves omitted fields such as _on, _data_source, _on_data, class, style, and _children.",
    "replace_by_id is only for full intentional object replacement and may remove omitted runtime wiring.",
    "Do not use append_child, remove_by_id, or move_by_id yet; they are reserved future operations."
  ],
  _canonical_examples: [
    {
      _op_type: "update_props",
      _target_id: "new-game",
      _props: {
        _text: "Restart Game"
      }
    }
  ],
  _anti_patterns: [
    {
      _bad: {
        _op_type: "replace_by_id",
        _target_id: "new-game",
        _replacement: {
          _id: "new-game",
          _type: "button",
          _text: "Restart Game"
        }
      },
      _reason: "Do not use replace_by_id for simple text changes because omitted fields such as _on, _data_source, _on_data, class, and style may be deleted."
    }
  ],
  _exports: {
    _modules: [
      {
        _name: "xmutator",
        _scope: "server",
        _description:
          "Server-side artifact mutation module for applying controlled mutation plans to Xpell runtime artifacts. Prefer update_props for simple UI edits and reserve replace_by_id for full replacement.",
        _ops: Object.values(XMUTATOR_OPS)
      }
    ]
  }
};
