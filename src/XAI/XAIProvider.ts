export interface XAIInput {
  prompt: string;
  system?: string;
  context?: any;
}

export interface XAIResult {
  text: string;
  raw?: any;
}

export interface XAIProvider {
  generate(input: XAIInput): Promise<XAIResult>;
}