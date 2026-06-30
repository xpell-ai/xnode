import type {
  XVibeIntentEngineRequest,
  XVibeIntentResult,
} from "../XVibeTypes.js";

export interface XVibeIntentProcessor {
  analyze(
    request: XVibeIntentEngineRequest,
  ): Promise<XVibeIntentResult | null>;

  _diagnostic_reason?(): string | undefined;
}
