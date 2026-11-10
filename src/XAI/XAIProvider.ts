export type XAIInputModality =
  | "text"
  | "image";

export type XAIMessageRole =
  | "system"
  | "user"
  | "assistant"
  | "tool";

export type XAIToolDefinition = {
  _name: string;
  _description?: string;
  _input_schema: Record<string, unknown>;
};

export type XAIToolChoice =
  | "auto"
  | "none"
  | "required"
  | {
    _name: string;
  };

/**
 * Untrusted model output. XAI preserves tool calls but does not authorize,
 * validate against application policy, confirm, audit, or execute them.
 */
export type XAIToolCall = {
  _id: string;
  _name: string;
  _arguments: Record<string, unknown>;
  _continuation_ref?: string;
};

export type XAIFinishReason =
  | "stop"
  | "tool_calls"
  | "length"
  | "content_filter"
  | "other";

export type XAITextContentPart = {
  _type: "text";
  _text: string;
};

export type XAIImageMimeType =
  | "image/jpeg"
  | "image/png"
  | "image/webp";

export type XAIDocumentMimeType =
  | "application/pdf"
  | XAIImageMimeType;

export type XAIImageContentPart = {
  _type: "image";
  _mime_type: XAIImageMimeType;
  _data_base64: string;
};

export type XAIContentPart =
  | XAITextContentPart
  | XAIImageContentPart;

export type XAIStandardMessage = {
  _role: "system" | "user";
  _content: XAIContentPart[];
};

export type XAIAssistantMessage = {
  _role: "assistant";
  _content: XAIContentPart[];
  _tool_calls?: XAIToolCall[];
};

export type XAIToolResultMessage = {
  _role: "tool";
  _tool_call_id: string;
  _content: XAITextContentPart[];
};

export type XAIMessage =
  | XAIStandardMessage
  | XAIAssistantMessage
  | XAIToolResultMessage;

export type XAIRuntimeMetadata = {
  _app_id?: string;
  _env?: string;
  _caller_module?: string;
  _caller_op?: string;
  _purpose?: string;
  _request_id?: string;
  _idempotency_key?: string;
};

export type XAINormalizedInput = {
  prompt: string;
  messages: XAIMessage[];
  tools: XAIToolDefinition[];
  tool_choice?: XAIToolChoice;
  input_modalities: XAIInputModality[];
  image_count: number;
  image_bytes: number;
};

export const XAI_ACCEPTED_IMAGE_MIME_TYPES: XAIImageMimeType[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
];

export const XAI_DOCUMENT_EXTRACTION_CAPABILITY = "document_extraction";

export const XAI_ACCEPTED_DOCUMENT_MIME_TYPES: XAIDocumentMimeType[] = [
  "application/pdf",
  ...XAI_ACCEPTED_IMAGE_MIME_TYPES,
];

export const XAI_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const XAI_MAX_IMAGE_COUNT = 4;

export interface XAIInput {
  prompt?: string;
  messages?: XAIMessage[];
  system?: string;
  context?: any;
  schema?: any;
  model?: string;
  reasoning?: string;
  _task?: string;
  _capability?: string;
  metadata?: XAIRuntimeMetadata;
  response_format?: {
    type: "text" | "json_object";
  };
  temperature?: number;
  max_tokens?: number;
  tools?: XAIToolDefinition[];
  tool_choice?: XAIToolChoice;
}

export type XAIUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  reasoning_tokens?: number;
  cached_input_tokens?: number;
  usage_source?: string;
};

export type XAIResult = {
  text: string;
  tool_calls?: XAIToolCall[];
  finish_reason?: XAIFinishReason;
  raw?: unknown;
  usage?: XAIUsage;
};

export type XAIGenerationRecoveryInput = {
  _idempotency_key: string;
};

export type XAIGenerationRecoveryResult =
  | {
    _state: "success";
    _idempotency_key: string;
    _request_id?: string | null;
    _provider?: string;
    _model?: string;
    _reasoning?: string | null;
    _effective_reasoning?: string | null;
    _task?: string;
    _result: {
      _text: string;
      _object?: Record<string, unknown>;
      _tool_calls?: XAIToolCall[];
      _finish_reason?: XAIFinishReason;
    };
    _usage?: unknown;
    _billing?: unknown;
    _completed_at?: unknown;
  }
  | {
    _state: "failed";
    _idempotency_key: string;
    _request_id?: string | null;
    _provider?: string | null;
    _model?: string | null;
    _failure: {
      _code: string;
      _classification?: string;
      _message?: string | null;
    };
    _billing?: unknown;
    _retryable: boolean;
    _retry_after?: string | null;
    _failed_at?: unknown;
  }
  | {
    _state: "missing";
    _idempotency_key: string;
  }
  | {
    _state: "ambiguous";
    _idempotency_key: string;
    _diagnostic?: {
      _classification?: string;
      _lifecycle_state?: string;
    };
  };

export type XAIDocumentFileRef = {
  _type: "xpell-file-ref";
  _version: 1;
  _id: string;
  _scope: "temp" | "app";
  _app_id: string;
  _env: string;
  _filename: string;
  _mime_type: XAIDocumentMimeType;
  _size_bytes: number;
  _sha256?: string;
  _created_at?: string;
  _expires_at?: string;
};

export type XAIDocumentInputDocument = {
  _mime_type: XAIDocumentMimeType;
  _filename?: string;
  _size_bytes?: number;
  _sha256?: string;
  _data_base64?: string;
};

export type XAIDocumentExtractionOptions = {
  languages?: string[];
  pages?: number[];
  include_geometry?: boolean;
  include_raw_provider_artifact?: boolean;
};

export type XAIDocumentExtractionInput = {
  file_ref?: XAIDocumentFileRef;
  document?: XAIDocumentInputDocument;
  options?: XAIDocumentExtractionOptions;
  metadata?: XAIRuntimeMetadata;
  _provider?: string;
};

export type XAIBoundingPoint = {
  x: number;
  y: number;
};

export type XAIBoundingPolygon = {
  points: XAIBoundingPoint[];
  unit?: "pixel" | "normalized";
};

export type XAIDocumentExtractionPage = {
  page_number: number;
  text: string;
  width?: number;
  height?: number;
  confidence?: number;
  language?: string;
};

export type XAIDocumentExtractionSpan = {
  page_number: number;
  text: string;
  start_index?: number;
  end_index?: number;
  confidence?: number;
  bounding_polygon?: XAIBoundingPolygon;
};

export type XAIDocumentExtractionUsage = {
  unit: "page";
  input_pages: number;
  billable_pages?: number;
};

export type XAIDocumentExtractionResult = {
  provider: string;
  model_or_processor?: string;
  text: string;
  page_count: number;
  pages: XAIDocumentExtractionPage[];
  spans: XAIDocumentExtractionSpan[];
  usage?: XAIDocumentExtractionUsage;
  raw_provider_reference?: unknown;
};


export type XAIProviderMetadata = {
  provider?: string;
  account?: string;
  plan?: string;
  credits?: number;
  [key: string]: any;
};

export type XAIProviderTestResult = {
  valid: boolean;
  account?: string;
  account_id?: string;
  message?: string;
  raw?: unknown;
};

export interface XAIProvider {
  _provider_id: string;

  generate(input: XAIInput): Promise<XAIResult>;

  recoverGeneration?(input: XAIGenerationRecoveryInput): Promise<XAIGenerationRecoveryResult>;

  extractDocument?(input: XAIDocumentExtractionInput): Promise<XAIDocumentExtractionResult>;

  setApiKey?(apiKey: string): void;

  configure?(config: Record<string, any>): void;

  getMetadata?(): Promise<XAIProviderMetadata>;

  testKey?(): Promise<XAIProviderTestResult>;
}

export function normalizeXAIInput(
  input: XAIInput
): XAINormalizedInput {
  const messages =
    Array.isArray(input.messages)
      ? normalize_messages(input.messages)
      : normalize_prompt_message(input.prompt);

  const prompt = prompt_from_messages(messages);
  const input_modalities = input_modalities_from_messages(messages);
  const image_parts = image_parts_from_messages(messages);
  const image_bytes = image_parts.reduce((total, part) =>
    total + decoded_base64_size(part._data_base64), 0);
  const tools = normalizeXAITools(input.tools);
  const tool_choice = normalizeXAIToolChoice(input.tool_choice, tools);

  if (!prompt.trim() && image_parts.length === 0) {
    throw new Error("E_XAI_INPUT_REQUIRED");
  }

  if (image_parts.length > XAI_MAX_IMAGE_COUNT) {
    throw new Error("E_XAI_IMAGE_COUNT_EXCEEDED");
  }

  return {
    prompt,
    messages,
    tools,
    tool_choice,
    input_modalities,
    image_count: image_parts.length,
    image_bytes,
  };
}

export function normalizeXAITools(
  value: unknown
): XAIToolDefinition[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error("E_XAI_TOOLS_INVALID");
  }

  const names = new Set<string>();

  return value.map((tool) => {
    if (!is_plain_object(tool)) {
      throw new Error("E_XAI_TOOL_INVALID");
    }

    const name = required_xai_string(tool._name, "E_XAI_TOOL_NAME_REQUIRED");
    if (names.has(name)) {
      throw new Error("E_XAI_TOOL_NAME_DUPLICATE");
    }
    names.add(name);

    if (!is_plain_object(tool._input_schema)) {
      throw new Error("E_XAI_TOOL_SCHEMA_INVALID");
    }

    const description = optional_xai_string(
      tool._description,
      "E_XAI_TOOL_DESCRIPTION_INVALID"
    );

    return {
      _name: name,
      ...(description ? { _description: description } : {}),
      _input_schema: tool._input_schema,
    };
  });
}

export function normalizeXAIToolChoice(
  value: unknown,
  tools: XAIToolDefinition[]
): XAIToolChoice | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (tools.length === 0) {
    throw new Error("E_XAI_TOOL_CHOICE_REQUIRES_TOOLS");
  }

  if (value === "auto" || value === "none" || value === "required") {
    return value;
  }

  if (!is_plain_object(value)) {
    throw new Error("E_XAI_TOOL_CHOICE_INVALID");
  }

  const name = required_xai_string(
    value._name,
    "E_XAI_TOOL_CHOICE_NAME_REQUIRED"
  );

  if (!tools.some((tool) => tool._name === name)) {
    throw new Error("E_XAI_TOOL_CHOICE_NAME_UNKNOWN");
  }

  return { _name: name };
}

export function normalizeXAIToolCalls(
  value: unknown
): XAIToolCall[] {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error("E_XAI_TOOL_CALLS_INVALID");
  }

  return value.map((call) => {
    if (!is_plain_object(call)) {
      throw new Error("E_XAI_TOOL_CALL_INVALID");
    }

    if (!is_plain_object(call._arguments)) {
      throw new Error("E_XAI_TOOL_ARGUMENTS_INVALID");
    }

    return {
      _id: required_xai_string(call._id, "E_XAI_TOOL_CALL_ID_REQUIRED"),
      _name: required_xai_string(call._name, "E_XAI_TOOL_CALL_NAME_REQUIRED"),
      _arguments: call._arguments,
      ...(call._continuation_ref === undefined ? {} : {
        _continuation_ref: required_xai_string(call._continuation_ref, "E_XAI_TOOL_CONTINUATION_INVALID"),
      }),
    };
  });
}

export function normalizeXAIFinishReason(
  value: unknown,
  fallback?: XAIFinishReason
): XAIFinishReason | undefined {
  if (
    value === "stop" ||
    value === "tool_calls" ||
    value === "length" ||
    value === "content_filter" ||
    value === "other"
  ) {
    return value;
  }

  return fallback;
}

export function normalizeXAIDocumentExtractionInput(
  input: XAIDocumentExtractionInput
): XAIDocumentExtractionInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("E_XAI_DOCUMENT_INPUT_INVALID");
  }

  assert_no_filesystem_path_fields(input);

  const file_ref =
    input.file_ref === undefined
      ? undefined
      : normalize_document_file_ref(input.file_ref);

  const document =
    input.document === undefined
      ? undefined
      : normalize_document_input_document(input.document);

  if (!file_ref && !document) {
    throw new Error("E_XAI_DOCUMENT_INPUT_REQUIRED");
  }

  return {
    file_ref,
    document,
    options: normalize_document_options(input.options),
    metadata: normalize_runtime_metadata(input.metadata),
    _provider: optional_trimmed_string(input._provider, "_provider"),
  };
}

export function normalizeXAIDocumentExtractionResult(
  result: XAIDocumentExtractionResult,
  provider_fallback?: string
): XAIDocumentExtractionResult {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("E_XAI_DOCUMENT_RESULT_INVALID");
  }

  const provider =
    optional_trimmed_string(result.provider, "provider") ??
    optional_trimmed_string(provider_fallback, "provider_fallback");

  if (!provider) {
    throw new Error("E_XAI_DOCUMENT_RESULT_PROVIDER_REQUIRED");
  }

  if (typeof result.text !== "string") {
    throw new Error("E_XAI_DOCUMENT_RESULT_TEXT_INVALID");
  }

  if (!is_non_negative_integer(result.page_count)) {
    throw new Error("E_XAI_DOCUMENT_RESULT_PAGE_COUNT_INVALID");
  }

  return {
    provider,
    model_or_processor: optional_trimmed_string(result.model_or_processor, "model_or_processor"),
    text: result.text,
    page_count: result.page_count,
    pages: normalize_document_pages(result.pages),
    spans: normalize_document_spans(result.spans),
    usage: normalize_document_usage(result.usage),
    raw_provider_reference: result.raw_provider_reference,
  };
}

function normalize_prompt_message(
  prompt: unknown
): XAIMessage[] {
  const text =
    typeof prompt === "string"
      ? prompt
      : "";

  return [
    {
      _role: "user",
      _content: [
        {
          _type: "text",
          _text: text,
        },
      ],
    },
  ];
}

function normalize_messages(
  messages: XAIMessage[]
): XAIMessage[] {
  if (messages.length === 0) {
    throw new Error("E_XAI_MESSAGES_REQUIRED");
  }

  let image_count = 0;

  return messages.map((message, message_index) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw new Error(`E_XAI_MESSAGE_INVALID:${message_index}`);
    }

    const role = message._role;
    if (
      role !== "system" &&
      role !== "user" &&
      role !== "assistant" &&
      role !== "tool"
    ) {
      throw new Error("E_XAI_MESSAGE_ROLE_INVALID");
    }

    const tool_calls = role === "assistant"
      ? normalizeXAIToolCalls((message as XAIAssistantMessage)._tool_calls)
      : [];

    if (
      !Array.isArray(message._content) ||
      (message._content.length === 0 && tool_calls.length === 0)
    ) {
      throw new Error("E_XAI_MESSAGE_CONTENT_REQUIRED");
    }

    const content = message._content.map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        throw new Error("E_XAI_CONTENT_PART_INVALID");
      }

      if (part._type === "text") {
        if (typeof part._text !== "string") {
          throw new Error("E_XAI_TEXT_PART_INVALID");
        }

        return {
          _type: "text" as const,
          _text: part._text,
        };
      }

      if (part._type === "image") {
        if (role === "tool") {
          throw new Error("E_XAI_TOOL_RESULT_CONTENT_UNSUPPORTED");
        }

        image_count += 1;

        if (!is_accepted_image_mime_type(part._mime_type)) {
          throw new Error("E_XAI_IMAGE_MIME_UNSUPPORTED");
        }

        if (typeof part._data_base64 !== "string") {
          throw new Error("E_XAI_IMAGE_BASE64_INVALID");
        }

        const base64 = part._data_base64.trim();
        assert_valid_base64_image(base64);

        return {
          _type: "image" as const,
          _mime_type: part._mime_type,
          _data_base64: base64,
        };
      }

      throw new Error("E_XAI_CONTENT_TYPE_UNSUPPORTED");
    });

    if (image_count > XAI_MAX_IMAGE_COUNT) {
      throw new Error("E_XAI_IMAGE_COUNT_EXCEEDED");
    }

    if (role === "tool") {
      return {
        _role: "tool",
        _tool_call_id: required_xai_string(
          (message as XAIToolResultMessage)._tool_call_id,
          "E_XAI_TOOL_RESULT_CALL_ID_REQUIRED"
        ),
        _content: content as XAITextContentPart[],
      };
    }

    if (role === "assistant") {
      return {
        _role: "assistant",
        _content: content,
        ...(tool_calls.length > 0 ? { _tool_calls: tool_calls } : {}),
      };
    }

    return {
      _role: role,
      _content: content,
    };
  });
}

function optional_xai_string(
  value: unknown,
  error_code: string
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(error_code);
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}

function required_xai_string(
  value: unknown,
  error_code: string
): string {
  const normalized = optional_xai_string(value, error_code);
  if (!normalized) {
    throw new Error(error_code);
  }

  return normalized;
}

function is_accepted_image_mime_type(
  value: unknown
): value is XAIImageMimeType {
  return XAI_ACCEPTED_IMAGE_MIME_TYPES.includes(value as XAIImageMimeType);
}

function is_accepted_document_mime_type(
  value: unknown
): value is XAIDocumentMimeType {
  return XAI_ACCEPTED_DOCUMENT_MIME_TYPES.includes(value as XAIDocumentMimeType);
}

function is_plain_object(
  value: unknown
): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optional_trimmed_string(
  value: unknown,
  field: string
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`E_XAI_DOCUMENT_${field.toUpperCase()}_INVALID`);
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function required_trimmed_string(
  value: unknown,
  field: string
): string {
  const trimmed = optional_trimmed_string(value, field);
  if (!trimmed) {
    throw new Error(`E_XAI_DOCUMENT_${field.toUpperCase()}_REQUIRED`);
  }

  return trimmed;
}

function normalize_document_file_ref(
  value: unknown
): XAIDocumentFileRef {
  if (!is_plain_object(value)) {
    throw new Error("E_XAI_DOCUMENT_FILE_REF_INVALID");
  }

  if (value._type !== "xpell-file-ref") {
    throw new Error("E_XAI_DOCUMENT_FILE_REF_TYPE_UNSUPPORTED");
  }

  if (value._version !== 1) {
    throw new Error("E_XAI_DOCUMENT_FILE_REF_VERSION_UNSUPPORTED");
  }

  const mime_type = value._mime_type;
  if (!is_accepted_document_mime_type(mime_type)) {
    throw new Error("E_XAI_DOCUMENT_MIME_UNSUPPORTED");
  }

  const size_bytes = value._size_bytes;
  if (!is_non_negative_integer(size_bytes)) {
    throw new Error("E_XAI_DOCUMENT_SIZE_INVALID");
  }

  const scope = value._scope;
  if (scope !== "temp" && scope !== "app") {
    throw new Error("E_XAI_DOCUMENT_FILE_REF_SCOPE_INVALID");
  }

  return {
    _type: "xpell-file-ref",
    _version: 1,
    _id: required_trimmed_string(value._id, "_id"),
    _scope: scope,
    _app_id: required_trimmed_string(value._app_id, "_app_id"),
    _env: required_trimmed_string(value._env, "_env"),
    _filename: required_trimmed_string(value._filename, "_filename"),
    _mime_type: mime_type,
    _size_bytes: size_bytes,
    _sha256: optional_trimmed_string(value._sha256, "_sha256"),
    _created_at: optional_trimmed_string(value._created_at, "_created_at"),
    _expires_at: optional_trimmed_string(value._expires_at, "_expires_at"),
  };
}

function normalize_document_input_document(
  value: unknown
): XAIDocumentInputDocument {
  if (!is_plain_object(value)) {
    throw new Error("E_XAI_DOCUMENT_DESCRIPTOR_INVALID");
  }

  const mime_type = value._mime_type;
  if (!is_accepted_document_mime_type(mime_type)) {
    throw new Error("E_XAI_DOCUMENT_MIME_UNSUPPORTED");
  }

  const size_bytes = value._size_bytes;
  if (size_bytes !== undefined && !is_non_negative_integer(size_bytes)) {
    throw new Error("E_XAI_DOCUMENT_SIZE_INVALID");
  }

  const data_base64 = optional_trimmed_string(value._data_base64, "_data_base64");
  if (data_base64) {
    assert_valid_document_base64(data_base64);
  }

  return {
    _mime_type: mime_type,
    _filename: optional_trimmed_string(value._filename, "_filename"),
    _size_bytes: size_bytes as number | undefined,
    _sha256: optional_trimmed_string(value._sha256, "_sha256"),
    _data_base64: data_base64,
  };
}

function normalize_document_options(
  value: unknown
): XAIDocumentExtractionOptions | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!is_plain_object(value)) {
    throw new Error("E_XAI_DOCUMENT_OPTIONS_INVALID");
  }

  const languages =
    value.languages === undefined
      ? undefined
      : normalize_string_array(value.languages, "LANGUAGES");

  const pages =
    value.pages === undefined
      ? undefined
      : normalize_page_array(value.pages);

  return {
    languages,
    pages,
    include_geometry:
      value.include_geometry === undefined
        ? undefined
        : value.include_geometry === true,
    include_raw_provider_artifact:
      value.include_raw_provider_artifact === undefined
        ? undefined
        : value.include_raw_provider_artifact === true,
  };
}

function normalize_runtime_metadata(
  value: unknown
): XAIRuntimeMetadata | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!is_plain_object(value)) {
    throw new Error("E_XAI_DOCUMENT_METADATA_INVALID");
  }

  return {
    _app_id: optional_trimmed_string(value._app_id, "_app_id"),
    _env: optional_trimmed_string(value._env, "_env"),
    _caller_module: optional_trimmed_string(value._caller_module, "_caller_module"),
    _caller_op: optional_trimmed_string(value._caller_op, "_caller_op"),
    _purpose: optional_trimmed_string(value._purpose, "_purpose"),
    _request_id: optional_trimmed_string(value._request_id, "_request_id"),
  };
}

function normalize_string_array(
  value: unknown,
  field: string
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`E_XAI_DOCUMENT_${field}_INVALID`);
  }

  return value.map((item) => {
    if (typeof item !== "string" || !item.trim()) {
      throw new Error(`E_XAI_DOCUMENT_${field}_INVALID`);
    }

    return item.trim();
  });
}

function normalize_page_array(
  value: unknown
): number[] {
  if (!Array.isArray(value)) {
    throw new Error("E_XAI_DOCUMENT_PAGES_INVALID");
  }

  return value.map((page) => {
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new Error("E_XAI_DOCUMENT_PAGES_INVALID");
    }

    return page;
  });
}

function normalize_document_pages(
  value: unknown
): XAIDocumentExtractionPage[] {
  if (!Array.isArray(value)) {
    throw new Error("E_XAI_DOCUMENT_RESULT_PAGES_INVALID");
  }

  return value.map((page) => {
    if (!is_plain_object(page)) {
      throw new Error("E_XAI_DOCUMENT_RESULT_PAGE_INVALID");
    }

    const page_number = page.page_number;
    if (typeof page_number !== "number" || !Number.isSafeInteger(page_number) || page_number < 1) {
      throw new Error("E_XAI_DOCUMENT_RESULT_PAGE_NUMBER_INVALID");
    }

    if (typeof page.text !== "string") {
      throw new Error("E_XAI_DOCUMENT_RESULT_PAGE_TEXT_INVALID");
    }

    return {
      page_number,
      text: page.text,
      width: optional_number(page.width, "PAGE_WIDTH"),
      height: optional_number(page.height, "PAGE_HEIGHT"),
      confidence: optional_confidence(page.confidence),
      language: optional_trimmed_string(page.language, "language"),
    };
  });
}

function normalize_document_spans(
  value: unknown
): XAIDocumentExtractionSpan[] {
  if (!Array.isArray(value)) {
    throw new Error("E_XAI_DOCUMENT_RESULT_SPANS_INVALID");
  }

  return value.map((span) => {
    if (!is_plain_object(span)) {
      throw new Error("E_XAI_DOCUMENT_RESULT_SPAN_INVALID");
    }

    const page_number = span.page_number;
    if (typeof page_number !== "number" || !Number.isSafeInteger(page_number) || page_number < 1) {
      throw new Error("E_XAI_DOCUMENT_RESULT_SPAN_PAGE_NUMBER_INVALID");
    }

    if (typeof span.text !== "string") {
      throw new Error("E_XAI_DOCUMENT_RESULT_SPAN_TEXT_INVALID");
    }

    return {
      page_number,
      text: span.text,
      start_index: optional_integer(span.start_index, "SPAN_START_INDEX"),
      end_index: optional_integer(span.end_index, "SPAN_END_INDEX"),
      confidence: optional_confidence(span.confidence),
      bounding_polygon: normalize_bounding_polygon(span.bounding_polygon),
    };
  });
}

function normalize_document_usage(
  value: unknown
): XAIDocumentExtractionUsage | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!is_plain_object(value)) {
    throw new Error("E_XAI_DOCUMENT_RESULT_USAGE_INVALID");
  }

  if (value.unit !== "page") {
    throw new Error("E_XAI_DOCUMENT_RESULT_USAGE_UNIT_INVALID");
  }

  if (!is_non_negative_integer(value.input_pages)) {
    throw new Error("E_XAI_DOCUMENT_RESULT_USAGE_INPUT_PAGES_INVALID");
  }

  if (value.billable_pages !== undefined && !is_non_negative_integer(value.billable_pages)) {
    throw new Error("E_XAI_DOCUMENT_RESULT_USAGE_BILLABLE_PAGES_INVALID");
  }

  return {
    unit: "page",
    input_pages: value.input_pages,
    billable_pages: value.billable_pages as number | undefined,
  };
}

function normalize_bounding_polygon(
  value: unknown
): XAIBoundingPolygon | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!is_plain_object(value) || !Array.isArray(value.points)) {
    throw new Error("E_XAI_DOCUMENT_RESULT_BOUNDING_POLYGON_INVALID");
  }

  if (value.unit !== undefined && value.unit !== "pixel" && value.unit !== "normalized") {
    throw new Error("E_XAI_DOCUMENT_RESULT_BOUNDING_POLYGON_UNIT_INVALID");
  }

  return {
    points: value.points.map((point) => {
      if (!is_plain_object(point) || typeof point.x !== "number" || typeof point.y !== "number") {
        throw new Error("E_XAI_DOCUMENT_RESULT_BOUNDING_POINT_INVALID");
      }

      return {
        x: point.x,
        y: point.y,
      };
    }),
    unit: value.unit as "pixel" | "normalized" | undefined,
  };
}

function optional_number(
  value: unknown,
  field: string
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`E_XAI_DOCUMENT_RESULT_${field}_INVALID`);
  }

  return value;
}

function optional_integer(
  value: unknown,
  field: string
): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`E_XAI_DOCUMENT_RESULT_${field}_INVALID`);
  }

  return value;
}

function optional_confidence(
  value: unknown
): number | undefined {
  const confidence = optional_number(value, "CONFIDENCE");
  if (confidence !== undefined && (confidence < 0 || confidence > 1)) {
    throw new Error("E_XAI_DOCUMENT_RESULT_CONFIDENCE_INVALID");
  }

  return confidence;
}

function is_non_negative_integer(
  value: unknown
): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function assert_no_filesystem_path_fields(
  value: unknown
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      assert_no_filesystem_path_fields(item);
    }
    return;
  }

  if (!is_plain_object(value)) {
    return;
  }

  const forbidden = new Set([
    "path",
    "_path",
    "file_path",
    "_file_path",
    "filesystem_path",
    "_filesystem_path",
  ]);

  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) {
      throw new Error("E_XAI_DOCUMENT_FILESYSTEM_PATH_UNSUPPORTED");
    }

    assert_no_filesystem_path_fields(child);
  }
}

function assert_valid_document_base64(
  value: string
): void {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("E_XAI_DOCUMENT_BASE64_INVALID");
  }

  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0) {
    throw new Error("E_XAI_DOCUMENT_BASE64_INVALID");
  }

  const normalized = bytes.toString("base64");
  if (normalized.replace(/=+$/, "") !== value.replace(/=+$/, "")) {
    throw new Error("E_XAI_DOCUMENT_BASE64_INVALID");
  }
}

function assert_valid_base64_image(
  value: string
): void {
  if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error("E_XAI_IMAGE_BASE64_INVALID");
  }

  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0) {
    throw new Error("E_XAI_IMAGE_BASE64_INVALID");
  }

  if (bytes.length > XAI_MAX_IMAGE_BYTES) {
    throw new Error("E_XAI_IMAGE_TOO_LARGE");
  }

  const normalized = bytes.toString("base64");
  if (normalized.replace(/=+$/, "") !== value.replace(/=+$/, "")) {
    throw new Error("E_XAI_IMAGE_BASE64_INVALID");
  }
}

function prompt_from_messages(
  messages: XAIMessage[]
): string {
  const text_parts: string[] = [];

  for (const message of messages) {
    for (const part of message._content) {
      if (part._type === "text") {
        text_parts.push(part._text);
      }
    }
  }

  return text_parts.join("\n");
}

function input_modalities_from_messages(
  messages: XAIMessage[]
): XAIInputModality[] {
  const modalities = new Set<XAIInputModality>();

  for (const message of messages) {
    for (const part of message._content) {
      modalities.add(part._type);
    }
  }

  if (!modalities.has("text")) {
    modalities.add("text");
  }

  return [...modalities];
}

function image_parts_from_messages(
  messages: XAIMessage[]
): XAIImageContentPart[] {
  const images: XAIImageContentPart[] = [];

  for (const message of messages) {
    for (const part of message._content) {
      if (part._type === "image") {
        images.push(part);
      }
    }
  }

  return images;
}

function decoded_base64_size(
  value: string
): number {
  return Buffer.from(value, "base64").length;
}
