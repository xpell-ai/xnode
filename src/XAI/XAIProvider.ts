export interface XAIInput {

  prompt: string;
  system?: string;
  context?: any;
  response_format?: {
    type: "text" | "json_object";
  };
  temperature?: number;
  max_tokens?: number;
}

export interface XAIResult {
  text: string;
  raw?: any;
}

export interface XAIProvider {

  generate(
    input: XAIInput
  ): Promise<XAIResult>;
}