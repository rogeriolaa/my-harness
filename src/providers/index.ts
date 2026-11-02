import type { HarnessConfig } from "../config.ts";
import type { Provider } from "../types.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { MockProvider } from "./mock.ts";
import { OpenAICompatibleProvider } from "./openai.ts";

/** The factory the CLI uses. Add a case here to support a new protocol. */
export function createProvider(config: HarnessConfig): Provider {
  switch (config.provider) {
    case "mock":
      return new MockProvider(config.model);

    case "openai":
      return new OpenAICompatibleProvider({
        model: config.model,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        headers: config.headers,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
      });

    case "anthropic":
      return new AnthropicProvider({
        model: config.model,
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        headers: config.headers,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
      });

    default: {
      const unreachable: never = config.provider;
      throw new Error(`Unknown provider: ${String(unreachable)}`);
    }
  }
}
