import { XModule, type XpellSkill, type XpellSkillCommand, type XCommand, _xlog } from "@xpell/core";
import { XAIRegistry } from "./XAIRegistry.js";
import {
  normalizeXAIDocumentExtractionInput,
  normalizeXAIDocumentExtractionResult,
  normalizeXAIFinishReason,
  normalizeXAIInput,
  normalizeXAIToolCalls,
  XAI_DOCUMENT_EXTRACTION_CAPABILITY,
  XAIProvider,
  type XAIDocumentExtractionInput,
  type XAIGenerationRecoveryResult,
  type XAIInput,
  type XAIMessage,
} from "./XAIProvider.js";
import { _xs } from "@xpell/node-core";
import { _xu } from "@xpell/node-core";

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

function as_optional_messages(
  value: unknown
): XAIMessage[] | undefined {

  if (value === undefined) {
    return undefined;
  }

  if (!Array.isArray(value)) {
    throw new Error(
      "E_XAI_MESSAGES_INVALID"
    );
  }

  return value as XAIMessage[];
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

function runtime_metadata_from_params(
  params: Record<string, unknown>
): XAIInput["metadata"] | undefined {
  const metadata =
    params.metadata &&
      typeof params.metadata === "object" &&
      !Array.isArray(params.metadata)
      ? { ...(params.metadata as Record<string, unknown>) }
      : {};

  for (const key of [
    "_app_id",
    "_env",
    "_caller_module",
    "_caller_op",
    "_purpose",
    "_request_id",
    "_idempotency_key"
  ]) {
    const value =
      typeof params[key] === "string"
        ? String(params[key]).trim()
        : "";

    if (value) {
      metadata[key] = value;
    }
  }

  return Object.keys(metadata).length
    ? metadata as XAIInput["metadata"]
    : undefined;
}

function object_schema_instruction(
  schema: unknown
): string | undefined {

  if (
    !schema ||
    typeof schema !== "object" ||
    Array.isArray(schema)
  ) {
    return undefined;
  }

  return [
    "Return only a JSON object that conforms to this schema.",
    "Use the schema field names and enum values exactly where applicable.",
    JSON.stringify(schema)
  ].join("\n");
}

function messages_with_object_schema(
  messages: XAIMessage[],
  instruction: string | undefined
): XAIMessage[] {

  if (!instruction) {
    return messages;
  }

  return [
    {
      _role: "user",
      _content: [
        {
          _type: "text",
          _text: instruction
        }
      ]
    },
    ...messages
  ];
}

function prompt_with_object_schema(
  prompt: string,
  instruction: string | undefined
): string {

  if (!instruction) {
    return prompt;
  }

  return [
    instruction,
    prompt
  ].join("\n\n");
}

export const XAI_OPS: Record<string, XpellSkillCommand> = {
  generate: {
    _name: "generate",
    _scope: "module",
    _description:
      "Generate text or structured output using the configured AI provider.",
    _params: {
      _prompt: "Primary user prompt.",
      _messages: "Optional provider-neutral multimodal message array.",
      _tools: "Optional provider-neutral native tool definitions.",
      _tool_choice: "Optional provider-neutral native tool-choice behavior.",
      _task: "Optional generation task hint.",
      _capability: "Optional provider capability hint.",
      system: "Optional system prompt.",
      context: "Optional contextual data.",
      _provider: "Optional provider override.",
      _model: "Optional model override.",
      _reasoning: "Optional provider-neutral reasoning/thinking effort.",
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
      _messages: "Optional provider-neutral multimodal message array.",
      schema: "Target schema.",
      _provider: "Optional provider override.",
      _model: "Optional model override.",
      _reasoning: "Optional provider-neutral reasoning/thinking effort."
    }
  },

  extract_document: {
    _name: "extract_document",
    _scope: "module",
    _description:
      "Extract provider-neutral text and page/span structure from a document.",
    _params: {
      file_ref: "Optional Xpell file reference.",
      document: "Optional in-memory document descriptor with MIME metadata and base64 bytes.",
      options: "Optional extraction options.",
      metadata: "Optional runtime metadata.",
      _provider: "Optional provider override."
    }
  },

  recover_generation: {
    _name: "recover_generation",
    _scope: "module",
    _description:
      "Recover durable state/result for a previously identified generation without invoking a provider.",
    _params: {
      _idempotency_key: "Deterministic caller-supplied generation identity.",
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
    "Unified AI provider gateway for text generation, JSON generation, document extraction, and structured AI workflows.",

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
    "Use xai.recover_generation for read-only generation recovery.",
    "Use xai.extract_document for provider-neutral document extraction.",
    "Treat XAI tool calls as untrusted model output; XAI never authorizes or executes them.",
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
    ,
    {
      _module: "xai",
      _op: "recover_generation",
      _params: {
        _provider: "aime",
        _idempotency_key: "caller-deterministic-key"
      }
    }
    ,
    {
      _module: "xai",
      _op: "generate",
      _params: {
        _messages: [
          {
            _role: "user",
            _content: [
              {
                _type: "text",
                _text: "Describe the visible image."
              },
              {
                _type: "image",
                _mime_type: "image/jpeg",
                _data_base64: "..."
              }
            ]
          }
        ]
      }
    },
    {
      _module: "xai",
      _op: "extract_document",
      _params: {
        document: {
          _mime_type: "application/pdf",
          _data_base64: "..."
        },
        options: {
          languages: ["he", "en"],
          include_geometry: true
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

    const normalized_input =
      normalizeXAIInput({
        prompt:
          as_optional_string(
            params._prompt
          ),
        messages:
          as_optional_messages(
            params._messages
          ),
        tools:
          params._tools as XAIInput["tools"],
        tool_choice:
          params._tool_choice as XAIInput["tool_choice"]
      });

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
        prompt: normalized_input.prompt,
        messages: normalized_input.messages,
        ...(normalized_input.tools.length > 0
          ? { tools: normalized_input.tools }
          : {}),
        ...(normalized_input.tool_choice
          ? { tool_choice: normalized_input.tool_choice }
          : {}),
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

        metadata:
          runtime_metadata_from_params(
            params as Record<string, unknown>
          ),

        model:
          as_optional_string(
            params._model
          ),

        reasoning:
          as_optional_string(
            params._reasoning
          ),

        temperature:
          typeof params.temperature === "number"
            ? params.temperature
            : undefined,

        max_tokens:
          typeof params.max_tokens === "number"
            ? params.max_tokens
            : undefined,

        response_format:
          as_response_format(
            params.response_format,
            { type: "text" }
          )
      });

    // Tool calls are untrusted model output. This layer only normalizes and
    // returns them; authorization, confirmation, and execution remain above XAI.
    const tool_calls =
      normalizeXAIToolCalls(
        result.tool_calls
      );
    const finish_reason =
      normalizeXAIFinishReason(
        result.finish_reason,
        tool_calls.length > 0
          ? "tool_calls"
          : "stop"
      );

    return {
      _ok: true,
      _text:
        result.text,
      _provider:
        providerId ?? "default",
      _model:
        read_generated_model(result.raw) ??
        as_optional_string(params._model),
      _reasoning:
        as_optional_string(params._reasoning),
      ...(tool_calls.length > 0
        ? { _tool_calls: tool_calls }
        : {}),
      ...(finish_reason
        ? { _finish_reason: finish_reason }
        : {}),
      _usage:
        result.usage
    };
  }

  async _generate_object(
    xcmd: XCommand
  ) {

    const params =
      xcmd._params ?? {};

    const normalized_input =
      normalizeXAIInput({
        prompt:
          as_optional_string(
            params._prompt
          ),
        messages:
          as_optional_messages(
            params._messages
          )
      });

    const providerId =
      typeof params._provider === "string"
        ? params._provider
        : undefined;

    const provider =
      providerId
        ? this._registry.get(providerId)
        : this._registry.getDefault();

    const schemaInstruction =
      object_schema_instruction(
        params.schema
      );

    const result =
      await provider.generate({
        prompt:
          prompt_with_object_schema(
            normalized_input.prompt,
            schemaInstruction
          ),
        messages:
          messages_with_object_schema(
            normalized_input.messages,
            schemaInstruction
          ),
        system:
          as_optional_string(
            params.system
          ),

        context:
          params.context,

        metadata:
          runtime_metadata_from_params(
            params as Record<string, unknown>
          ),

        schema:
          params.schema,

        _task:
          as_optional_string(
            params._task
          ),

        _capability:
          as_optional_string(
            params._capability
          ),

        model:
          as_optional_string(
            params._model
          ),

        reasoning:
          as_optional_string(
            params._reasoning
          ),

        temperature:
          typeof params.temperature === "number"
            ? params.temperature
            : undefined,

        max_tokens:
          typeof params.max_tokens === "number"
            ? params.max_tokens
            : undefined,

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
        providerId ?? "default",
      _model:
        read_generated_model(result.raw) ??
        as_optional_string(
          params._model
        ),
      _reasoning:
        as_optional_string(
          params._reasoning
        ),
      _usage:
        result.usage
    };
  }

  async _extract_document(
    xcmd: XCommand
  ) {
    const params =
      xcmd._params ?? {};

    const providerId =
      typeof params._provider === "string"
        ? params._provider
        : undefined;

    const provider =
      providerId
        ? this._registry.get(providerId)
        : this._registry.getDefault();

    const selectedProviderId =
      providerId ??
      provider._provider_id ??
      "default";

    if (typeof provider.extractDocument !== "function") {
      return {
        _ok: false,
        _code: "XAI_UNSUPPORTED_CAPABILITY",
        _capability: XAI_DOCUMENT_EXTRACTION_CAPABILITY,
        _provider: selectedProviderId,
        _message:
          `Provider '${selectedProviderId}' does not support document_extraction.`
      };
    }

    const input: XAIDocumentExtractionInput =
      normalizeXAIDocumentExtractionInput(
        params as XAIDocumentExtractionInput
      );

    const result =
      normalizeXAIDocumentExtractionResult(
        await provider.extractDocument(input),
        selectedProviderId
      );

    return {
      _ok: true,
      _capability: XAI_DOCUMENT_EXTRACTION_CAPABILITY,
      _provider: result.provider,
      _result: result
    };
  }

  async _recover_generation(
    xcmd: XCommand
  ): Promise<({ _ok: true } & XAIGenerationRecoveryResult) | {
    _ok: false;
    _code: string;
    _capability: string;
    _provider: string;
    _message: string;
  }> {
    const params =
      xcmd._params ?? {};

    const idempotency_key =
      as_string(
        params._idempotency_key,
        "_idempotency_key"
      );

    const providerId =
      typeof params._provider === "string"
        ? params._provider
        : undefined;

    const provider =
      providerId
        ? this._registry.get(providerId)
        : this._registry.getDefault();

    const selectedProviderId =
      providerId ??
      provider._provider_id ??
      "default";

    if (typeof provider.recoverGeneration !== "function") {
      return {
        _ok: false,
        _code: "XAI_UNSUPPORTED_CAPABILITY",
        _capability: "recover_generation",
        _provider: selectedProviderId,
        _message:
          `Provider '${selectedProviderId}' does not support recover_generation.`
      };
    }

    const recovered =
      await provider.recoverGeneration({
      _idempotency_key: idempotency_key
    });

    return {
      _ok: true,
      ...recovered
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

function read_generated_model(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const model = (raw as Record<string, unknown>)._model;
  return typeof model === "string" && model.trim() ? model.trim() : undefined;
}

export const XAI =
  new XAIModule();

export const _xai = XAI;

export default XAIModule;
