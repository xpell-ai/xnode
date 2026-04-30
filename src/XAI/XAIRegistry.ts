import { XAIProvider } from "./XAIProvider.js";

export class XAIRegistry {
  private _providers = new Map<string, XAIProvider>();
  private _default?: string;

  register(id: string, provider: XAIProvider) {
    this._providers.set(id, provider);

    // auto-set first provider as default
    if (!this._default) {
      this._default = id;
    }
  }

  get(id: string): XAIProvider {
    const provider = this._providers.get(id);
    if (!provider) {
      throw new Error(`XAI provider not found: ${id}`);
    }
    return provider;
  }

  getDefault(): XAIProvider {
    if (!this._default) {
      throw new Error("No default XAI provider set");
    }
    return this.get(this._default);
  }

  setDefault(id: string) {
    if (!this._providers.has(id)) {
      throw new Error(`Provider not registered: ${id}`);
    }
    this._default = id;
  }

  list(): string[] {
    return Array.from(this._providers.keys());
  }
}