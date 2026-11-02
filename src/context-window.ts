import type { ContextWindowSource, HarnessConfig } from "./config.ts";
import { PROVIDER_DEFAULTS } from "./config.ts";

/**
 * Resolve the context window for the current model.
 *
 * Precedence:
 *   1. explicit config  (flag / env / harness.config.json)  -> "config"
 *   2. provider metadata from GET /models                   -> "api"
 *   3. known-model pattern table                            -> "known"
 *   4. provider default                                     -> "default"
 *
 * This runs at startup, on `/model`, and after `/connect`. It only mutates the
 * display configuration — nothing here enforces the limit.
 */

const API_TIMEOUT_MS = 1_500;
const cache = new Map<string, number | null>();

export interface ContextWindowResult {
  window: number;
  source: ContextWindowSource;
}

interface KnownModel {
  pattern: RegExp;
  window: number;
  label: string;
}

/**
 * A pragmatic table, not gospel. Hosted providers change limits and gateways
 * can serve the same model name with a different window. Anything explicit
 * (HARNESS_CONTEXT_WINDOW / --context-window) overrides all of this.
 */
const KNOWN_MODELS: KnownModel[] = [
  { pattern: /claude-2/i, window: 100_000, label: "claude-2" },
  { pattern: /claude/i, window: 200_000, label: "claude-3/4" },
  { pattern: /gpt-4\.1/i, window: 1_047_576, label: "gpt-4.1" },
  { pattern: /gpt-4o|gpt-4-turbo|gpt-4-1106|gpt-4-0125/i, window: 128_000, label: "gpt-4o" },
  { pattern: /gpt-4-32k/i, window: 32_768, label: "gpt-4-32k" },
  { pattern: /(^|\/)gpt-4(-0613)?$/i, window: 8_192, label: "gpt-4" },
  { pattern: /gpt-3\.5/i, window: 16_385, label: "gpt-3.5" },
  { pattern: /(^|\/)o[1-4](-|$)/i, window: 200_000, label: "o-series" },
  { pattern: /llama-3\.[1-3]/i, window: 128_000, label: "llama-3.1+" },
  { pattern: /llama-3/i, window: 8_192, label: "llama-3" },
  { pattern: /nemotron/i, window: 128_000, label: "nemotron" },
  { pattern: /qwen/i, window: 32_768, label: "qwen" },
  { pattern: /deepseek/i, window: 128_000, label: "deepseek" },
  { pattern: /mistral|mixtral/i, window: 32_768, label: "mistral" },
  { pattern: /gemma/i, window: 8_192, label: "gemma" },
  { pattern: /command-r/i, window: 128_000, label: "command-r" },
  { pattern: /phi-[34]/i, window: 128_000, label: "phi" },
];

function lookupKnownModel(model: string): number | null {
  for (const entry of KNOWN_MODELS) {
    if (entry.pattern.test(model)) return entry.window;
  }
  return null;
}

function pickWindow(value: any): number | null {
  const candidates = [
    value?.context_length,
    value?.context_window,
    value?.max_model_len,
    value?.max_input_tokens,
    value?.top_provider?.context_length,
    value?.meta?.n_ctx_train,
    value?.n_ctx,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return Math.trunc(candidate);
    }
  }
  return null;
}

/** Ask the provider's /models endpoint, if it reports a context window. */
async function fetchFromApi(config: HarnessConfig): Promise<number | null> {
  if (config.provider !== "openai") return null;

  const key = `${config.baseUrl}|${config.model}`;
  if (cache.has(key)) return cache.get(key) ?? null;

  const url = `${config.baseUrl.replace(/\/+$/, "")}/models`;
  try {
    const res = await fetch(url, {
      headers: {
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        ...config.headers,
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });

    if (!res.ok) {
      cache.set(key, null);
      return null;
    }

    const json: any = await res.json();
    const models: any[] = Array.isArray(json?.data) ? json.data : [];
    const exact = models.find((model) => model?.id === config.model);
    const value = exact ? pickWindow(exact) : null;
    cache.set(key, value);
    return value;
  } catch {
    cache.set(key, null);
    return null;
  }
}

/**
 * Detect and apply the context window to `config` in place.
 * Returns the source that won, which the UI shows in `/context`.
 */
export async function detectContextWindow(
  config: HarnessConfig,
): Promise<ContextWindowResult> {
  if (config.contextWindowSource === "config") {
    return { window: config.contextWindow, source: "config" };
  }

  if (config.provider === "mock") {
    config.contextWindow = PROVIDER_DEFAULTS.mock.contextWindow;
    config.contextWindowSource = "default";
    return { window: config.contextWindow, source: "default" };
  }

  const fromApi = await fetchFromApi(config);
  if (fromApi) {
    config.contextWindow = fromApi;
    config.contextWindowSource = "api";
    return { window: fromApi, source: "api" };
  }

  const fromTable = lookupKnownModel(config.model);
  if (fromTable) {
    config.contextWindow = fromTable;
    config.contextWindowSource = "known";
    return { window: fromTable, source: "known" };
  }

  config.contextWindow = PROVIDER_DEFAULTS[config.provider].contextWindow;
  config.contextWindowSource = "default";
  return { window: config.contextWindow, source: "default" };
}

/** Exposed for tests / debugging. */
export function knownModelLabel(model: string): string | null {
  for (const entry of KNOWN_MODELS) {
    if (entry.pattern.test(model)) return entry.label;
  }
  return null;
}
