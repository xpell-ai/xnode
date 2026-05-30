import type {
  XpellSkill,
  XpellSkillCommand
} from "@xpell/core";

export const XMODULE_CREATOR_OPS: Record<string, XpellSkillCommand> = {
  "create-module-spec": {
    _name: "create-module-spec",
    _scope: "module",
    _description:
      "Validate and return a manifest-first generated module spec with its planned artifact path.",
    _params: {
      _spec: "XGeneratedModuleSpec"
    }
  },
  "validate-module-spec": {
    _name: "validate-module-spec",
    _scope: "module",
    _description:
      "Validate a generated module manifest against the module-creator v1 restrictions.",
    _params: {
      _spec: "XGeneratedModuleSpec"
    }
  },
  "list-module-specs": {
    _name: "list-module-specs",
    _scope: "module",
    _description:
      "Return known generated module specs when persistence is added in a future version."
  },
  "get-module-spec": {
    _name: "get-module-spec",
    _scope: "module",
    _description:
      "Return a generated module spec by id when persistence is added in a future version.",
    _params: {
      _id: "string"
    }
  }
};

export const XMODULE_CREATOR_SKILL: XpellSkill = {
  _id: "module-creator",
  _title: "XModule Creator",
  _version: "0.1.0",
  _active: true,
  _type: "server-module-api",
  _requires: [
    "xmodule"
  ],
  _description:
    "Server-side manifest-first foundation for future generated XModules. This version validates specs only and does not compile, import, install, or load generated code.",
  _exports: {
    _modules: [
      {
        _name: "module-creator",
        _scope: "server",
        _description:
          "Defines the minimal manifest contract for future generated server XModules.",
        _ops: Object.values(XMODULE_CREATOR_OPS)
      }
    ]
  },
  _core_rules: [
    "Only _target:'server' is allowed in v1.",
    "Only '@xpell/node' imports are allowed in v1.",
    "No filesystem, network, or package permissions are allowed in v1.",
    "Generated artifacts are planned under work/generated/xmodules/<module_id>/ but are not written by this foundation.",
    "Generated code is not compiled, imported, evaluated, installed, or dynamically loaded."
  ],
  _anti_patterns: [
    "Compiling generated code in module-creator v1.",
    "Dynamically importing generated code in module-creator v1.",
    "Installing packages from generated module specs in module-creator v1.",
    "Granting filesystem, network, or package permissions in module-creator v1."
  ]
};
