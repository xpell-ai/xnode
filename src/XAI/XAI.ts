import { XModule, type XCommand } from "@xpell/core";
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
