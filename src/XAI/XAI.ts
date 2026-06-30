import { XModule, type XpellSkill, type XpellSkillCommand, type XCommand, _xlog } from "@xpell/core";
import { XAIRegistry } from "./XAIRegistry.js";
import { XAIProvider, type XAIInput } from "./XAIProvider.js";
import { _xs } from "../XSettings/XSettings.js";
import { _xu } from "../XNUtils/XUtils.js";

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
      _task: "Optional generation task hint.",
      _capability: "Optional provider capability hint.",
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
  },
  get_default_provider: {
    _name: "get_default_provider",
    _scope: "module",
    _description:
      "Get the default AI provider."
  },
  set_api_key: {
    _name: "set_api_key",
    _scope: "module",
    _description:
      "Set the API key for a registered AI provider.",
    _params: {
      _provider:
        "Provider id.",
      _api_key:
        "Provider API key."
    }
  },
  get_provider_status: {
    _name: "get_provider_status",
    _scope: "module",
    _description:
      "Get connection status and metadata for a registered AI provider.",
    _params: {
      _provider:
        "Provider id (optional, defaults to current default provider)."
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
  static _skill = XAI_SKILL;
  static _ops = XAI_OPS;

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

  getProvider(
    id?: string
  ): XAIProvider {

    if (id) {
      return this._registry.get(id);
    }

    return this._registry.getDefault();
  }

  hasProvider(
    id: string
  ): boolean {

    return this._registry.get(id) !== undefined;
  }

  getDefaultProvider() {
    return this._registry.getDefault();
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
        _task:
          as_optional_string(
            params._task
          ),
        _capability:
          as_optional_string(
            params._capability
          ),
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

  async _get_default_provider() {
    const defaultProvider = this._registry.getDefault();
    return {
      _ok: true,
      _default_provider: defaultProvider ? defaultProvider.constructor.name : null
    };
  }

  async _set_api_key(
    xcmd: XCommand
  ) {
    const params =
      _xu.ensure_params(
        xcmd._params
      );

    const providerId =
      _xu.ensure_string(
        params._provider,
        "_provider"
      );

    const apiKey =
      _xu.ensure_string(
        params._api_key,
        "_api_key"
      );

    const debug =
      params._debug === true;

    const provider =
      this._registry.get(
        providerId
      ) as XAIProvider;

    if (!provider) {
      throw new Error(
        `[xai] provider not found: ${providerId}`
      );
    }

    if (
      typeof provider.setApiKey !==
      "function"
    ) {
      throw new Error(
        `[xai] provider '${providerId}' does not support runtime API key updates`
      );
    }

    provider.setApiKey(
      apiKey
    );

    const metadata =
      typeof provider.getMetadata ===
        "function"
        ? await provider.getMetadata()
        : {
          provider: providerId,
          connected: true
        };

    if (
      metadata &&
      (metadata as any).connected === false
    ) {
      throw new Error(
        `[xai] provider '${providerId}' rejected API key`
      );
    }

    _xs.setPath(
      `xai.providers.${providerId}.api_key`,
      apiKey
    );

    _xs.setPath(
      "xai.default_provider",
      providerId
    );

    if (debug) {
      _xlog.log(
        "[xai] set_api_key succeeded",
        {
          _provider: providerId,
          _metadata: metadata
        }
      );
    }

    return {
      _ok: true,
      _provider: providerId,
      _metadata: metadata
    };
  }


  async _get_provider_status(xcmd: XCommand) {
    const params = _xu.ensure_params(xcmd._params);
    const _debug = params._debug === true;

    if (_debug) {
      _xlog.log("[xai] get_provider_status called with params", params);
    }


    const providerId =
      _xu.read_optional_string(params._provider, "_provider") ||
      _xs.getPath("xai.default_provider", "aime");

    const provider = this._registry.get(providerId) as XAIProvider;

    const savedKey =
      _xs.getPath(`xai.providers.${providerId}.api_key`, "");

    if (savedKey && typeof provider.setApiKey === "function") {
      provider.setApiKey(savedKey);
    }

    const configured =
      Boolean(savedKey);

    let connected = false;

    const metadata =
      typeof provider.getMetadata === "function"
        ? await provider.getMetadata()
        : {
          provider: providerId
        };

    if (
      configured &&
      typeof (provider as any).testKey === "function"
    ) {
      try {
        const testResult =
          await (provider as any).testKey();

        connected =
          testResult?.valid === true;

        Object.assign(
          metadata,
          {
            _test: testResult
          }
        );

      } catch {
        connected = false;
      }
    }

    if(_debug) {
      _xlog.log("[xai] get_provider_status result", {
        _provider: providerId,
        _configured: configured,
        _connected: connected,
        _metadata: metadata
      });
    }

    return {
      _ok: true,
      _provider: providerId,
      _configured: configured,
      _connected: connected,
      _metadata: metadata
    };
  }



}

export const XAI =
  new XAIModule();

export const _xai = XAI;

export default XAIModule;
