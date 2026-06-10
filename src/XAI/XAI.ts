import { XModule, type XpellSkill, type XpellSkillCommand,type XCommand } from "@xpell/core";
import { XAIRegistry } from "./XAIRegistry.js";
import { XAIProvider, type XAIInput } from "./XAIProvider.js";

function as_string(
  value: unknown,
  field: string
): string {

  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    throw new Error(
      `Invalid '${field}': expected non-empty string`
    );
  }

  return value.trim();
}

function as_optional_string(
  value: unknown
): string | undefined {

  if (
    value === undefined ||
    value === null
  ) {
    return undefined;
  }

  if (typeof value !== "string") {

    throw new Error(
      `Invalid value: expected string`
    );
  }

  return value;
}

function as_response_format(
  value: unknown,
  fallback: XAIInput["response_format"]
): XAIInput["response_format"] {

  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (
      (value as { type?: unknown }).type === "text" ||
      (value as { type?: unknown }).type === "json_object"
    )
  ) {
    return {
      type: (value as { type: "text" | "json_object" }).type
    };
  }

  return fallback;
}

export const XAI_OPS: Record<string, XpellSkillCommand> = {
  generate: {
    _name: "generate",
    _scope: "module",
    _description:
      "Generate text or structured output using the configured AI provider.",
    _params: {
      _prompt: "Primary user prompt.",
      system: "Optional system prompt.",
      context: "Optional contextual data.",
      _provider: "Optional provider override.",
      response_format: "Optional response format definition."
    }
  },

  generate_object: {
    _name: "generate_object",
    _scope: "module",
    _description:
      "Generate a structured JSON object.",
    _params: {
      _prompt: "Generation prompt.",
      schema: "Target schema.",
      _provider: "Optional provider override."
    }
  },

  list_providers: {
    _name: "list_providers",
    _scope: "module",
    _description:
      "Return available AI providers."
  },

  set_default_provider: {
    _name: "set_default_provider",
    _scope: "module",
    _description:
      "Set the default AI provider.",
    _params: {
      _provider: "Provider id."
    }
  }
};

export const XAI_SKILL: XpellSkill = {
  _id: "xai",
  _title: "XAI Runtime Module",
  _version: "1.0.0",
  _active: true,
  _type: "server-module-api",
  _requires: ["xmodule"],

  _description:
    "Unified AI provider gateway for text generation, JSON generation, and structured AI workflows.",

  _exports: {
    _modules: [
      {
        _name: "xai",
        _scope: "server",
        _description:
          "AI generation runtime module.",
        _ops: Object.values(XAI_OPS)
      }
    ]
  },

  _core_rules: [
    "Use xai.generate for text generation.",
    "Use response_format for structured outputs.",
    "Providers may be selected explicitly using _provider.",
    "Do not expose provider secrets.",
    "Generated results should be JSON-safe when structured output is requested."
  ],

  _canonical_examples: [
    {
      _module: "xai",
      _op: "generate",
      _params: {
        _prompt: "Create a todo app"
      }
    },
    {
      _module: "xai",
      _op: "generate",
      _params: {
        _prompt: "Return a JSON object with name and age",
        response_format: {
          type: "json_object"
        }
      }
    }
  ]
};

export class XAIModule extends XModule {

  static _name = "xai";

  private _registry =
    new XAIRegistry();

  constructor() {

    super({
      _name: XAIModule._name
    });
  }

  /* ---------------------------------------------------------------------- */
  /* Provider Registration                                                   */
  /* ---------------------------------------------------------------------- */

  registerProvider(
    id: string,
    provider: XAIProvider
  ) {

    this._registry.register(
      id,
      provider
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Commands                                                               */
  /* ---------------------------------------------------------------------- */

  async _generate(
    xcmd: XCommand
  ) {

    const params =
      xcmd._params ?? {};

    const prompt =
      as_string(
        params._prompt,
        "_prompt"
      );

    const providerId =
      typeof params._provider === "string"
        ? params._provider
        : undefined;

    const provider =
      providerId
        ? this._registry.get(providerId)
        : this._registry.getDefault();

    const result =
      await provider.generate({

        prompt,

        system:
          as_optional_string(
            params.system
          ),

        context:
          params.context,

        response_format:
          as_response_format(
            params.response_format,
            { type: "text" }
          )
      });

    return {

      _ok: true,

      _text:
        result.text,

      _provider:
        providerId ?? "default"
    };
  }

  async _generate_object(
    xcmd: XCommand
  ) {

    const params =
      xcmd._params ?? {};

    const prompt =
      as_string(
        params._prompt,
        "_prompt"
      );

    const providerId =
      typeof params._provider === "string"
        ? params._provider
        : undefined;

    const provider =
      providerId
        ? this._registry.get(providerId)
        : this._registry.getDefault();

    const result =
      await provider.generate({

        prompt,

        system:
          as_optional_string(
            params.system
          ),

        context:
          params.context,

        response_format: {
          type: "json_object"
        }
      });

    let parsed: any;

    try {

      parsed =
        JSON.parse(
          result.text
        );

    } catch (err) {

      throw new Error(
        "[xai] failed parsing AI JSON response"
      );
    }

    return {

      _ok: true,

      _object: parsed,

      _provider:
        providerId ?? "default"
    };
  }


  async _list_providers() {

    return {

      _providers:
        this._registry.list()
    };
  }

  async _set_default(
    xcmd: XCommand
  ) {

    const id =
      as_string(
        xcmd._params?._provider,
        "_provider"
      );

    this._registry.setDefault(
      id
    );

    return {

      _ok: true,

      _default: id
    };
  }
}

export const XAI =
  new XAIModule();

export const _xai = XAI;

export default XAIModule;
