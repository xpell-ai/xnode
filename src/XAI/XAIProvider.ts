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

export type XAIUsage = {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
};

export type XAIResult = {
  text: string;
  raw?: unknown;
  usage?: XAIUsage;
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

  setApiKey?(apiKey: string): void;

  configure?(config: Record<string, any>): void;

  getMetadata?(): Promise<XAIProviderMetadata>;

  testKey?(): Promise<XAIProviderTestResult>;
}