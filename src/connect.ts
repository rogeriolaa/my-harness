import path from "node:path";
import type { ContextWindowSource, HarnessConfig, ProviderKind } from "./config.ts";
import { PROVIDER_DEFAULTS } from "./config.ts";
import { detectContextWindow } from "./context-window.ts";
import { upsertEnvFile } from "./env-file.ts";
import { createProvider } from "./providers/index.ts";
import type { Provider } from "./types.ts";

/** Everything the wizard needs from the terminal, injected so it stays testable. */
export interface ConnectUI {
  ask(question: string): Promise<string>;
  print(text: string): void;
}

export interface ConnectOutcome {
  config: HarnessConfig;
  provider: Provider;
  savedTo?: string;
}

const ALIASES: Record<string, ProviderKind> = {
  "1": "openai",
  "2": "anthropic",
  "3": "mock",
  openai: "openai",
  "openai-compatible": "openai",
  anthropic: "anthropic",
  claude: "anthropic",
  mock: "mock",
};

export function parseProvider(input: string): ProviderKind | null {
  return ALIASES[input.trim().toLowerCase()] ?? null;
}

/**
 * Interactive provider setup, used by the `/connect` REPL command.
 *
 * Returns the new config and a freshly built provider, or throws with a
 * readable message. The caller swaps both into the live agent, so the
 * conversation history survives the change.
 */
export async function runConnectWizard(
  ui: ConnectUI,
  current: HarnessConfig,
  preset?: string,
  options: { save?: boolean } = {},
): Promise<ConnectOutcome> {
  ui.print(`\n  current: ${current.provider} · ${current.model}\n`);

  let provider: ProviderKind;
  if (preset) {
    const parsed = parseProvider(preset);
    if (!parsed) {
      throw new Error(`unknown provider "${preset}" (use openai, anthropic, or mock)`);
    }
    provider = parsed;
  } else {
    const answer = (await ui.ask(`  provider (openai/anthropic/mock) [${current.provider}]: `)).trim();
    if (!answer) {
      provider = current.provider;
    } else {
      const parsed = parseProvider(answer);
      if (!parsed) {
        throw new Error(`unknown provider "${answer}" (use openai, anthropic, or mock)`);
      }
      provider = parsed;
    }
  }

  const defaults = PROVIDER_DEFAULTS[provider];
  const sameProvider = provider === current.provider;

  const defaultBaseUrl = sameProvider ? current.baseUrl : defaults.baseUrl;
  const defaultModel = sameProvider ? current.model : defaults.model;

  let baseUrl = defaults.baseUrl;
  let model = defaults.model;
  let contextWindow = sameProvider ? current.contextWindow : defaults.contextWindow;
  let contextWindowSource: ContextWindowSource = sameProvider
    ? current.contextWindowSource
    : "default";
  let apiKey = provider === "mock" ? undefined : sameProvider ? current.apiKey : undefined;

  if (provider !== "mock") {
    const baseAnswer = (await ui.ask(`  base url [${defaultBaseUrl}]: `)).trim();
    baseUrl = baseAnswer || defaultBaseUrl;
    if (!/^https?:\/\//i.test(baseUrl)) {
      throw new Error(`base url must start with http:// or https:// (got "${baseUrl}")`);
    }

    const modelAnswer = (await ui.ask(`  model [${defaultModel}]: `)).trim();
    model = modelAnswer || defaultModel;

    const keyState = apiKey ? "set — Enter to keep, '-' to clear" : "not set";
    const keyAnswer = (await ui.ask(`  api key (${keyState}): `)).trim();
    if (keyAnswer === "-") apiKey = undefined;
    else if (keyAnswer) apiKey = keyAnswer;

    // Best-effort auto-detection so the default shown is the right one.
    if (contextWindowSource !== "config") {
      const probe: HarnessConfig = {
        ...current,
        provider,
        baseUrl,
        model,
        apiKey,
        contextWindow: defaults.contextWindow,
        contextWindowSource: "default",
      };
      await detectContextWindow(probe);
      contextWindow = probe.contextWindow;
      contextWindowSource = probe.contextWindowSource;
    }

    const windowAnswer = (
      await ui.ask(`  context window [${contextWindow}]: `)
    ).trim();
    if (windowAnswer) {
      const parsed = Number(windowAnswer);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`context window must be a positive number (got "${windowAnswer}")`);
      }
      contextWindow = Math.trunc(parsed);
      contextWindowSource = "config";
    }
  }

  const next: HarnessConfig = {
    ...current,
    provider,
    baseUrl,
    model,
    apiKey,
    contextWindow,
    contextWindowSource,
  };
  const providerInstance = createProvider(next);

  ui.print(
    [
      "",
      "  connected",
      `    provider  ${next.provider}`,
      `    base url  ${next.baseUrl}`,
      `    model     ${next.model}`,
      `    api key   ${next.apiKey ? maskKey(next.apiKey) : "not set"}`,
      "",
    ].join("\n") + "\n",
  );

  const looksRemote = !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(next.baseUrl);
  if (next.provider !== "mock" && !next.apiKey && looksRemote) {
    ui.print("  note: no API key set — requests will likely fail unless the server allows anonymous access.\n");
  }

  let savedTo: string | undefined;
  let shouldSave = options.save === true;

  if (!shouldSave && next.provider !== "mock") {
    const saveAnswer = (
      await ui.ask("  save these settings to .env? (y/N): ")
    )
      .trim()
      .toLowerCase();
    shouldSave = saveAnswer === "y" || saveAnswer === "yes";
  }

  if (shouldSave) {
    const result = upsertEnvFile(path.resolve(process.cwd(), ".env"), {
      HARNESS_PROVIDER: next.provider,
      HARNESS_BASE_URL: next.baseUrl,
      HARNESS_MODEL: next.model,
      HARNESS_API_KEY: next.apiKey ?? "",
      HARNESS_CONTEXT_WINDOW: String(next.contextWindow),
    });
    savedTo = result.path;
    ui.print(`  saved to ${result.path}\n`);
  } else if (next.provider !== "mock") {
    ui.print(
      [
        "  to persist across runs, add these to .env:",
        `    HARNESS_PROVIDER=${next.provider}`,
        `    HARNESS_BASE_URL=${next.baseUrl}`,
        `    HARNESS_MODEL=${next.model}`,
        `    HARNESS_CONTEXT_WINDOW=${next.contextWindow}`,
        "    HARNESS_API_KEY=<your key>",
        "",
      ].join("\n") + "\n",
    );
  }

  return { config: next, provider: providerInstance, savedTo };
}

function maskKey(key: string): string {
  if (key.length <= 8) return "set";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
