import fs from "node:fs";
import path from "node:path";

export type ProviderKind = "openai" | "anthropic" | "mock";

/**
 * Which tools need the user's blessing before they run.
 *
 *   none  run everything (default — this is a learning harness)
 *   bash  ask before running shell commands
 *   all   ask before running any tool
 */
export type ApprovalMode = "none" | "bash" | "all";

export type ContextWindowSource = "config" | "api" | "known" | "default";

export interface HarnessConfig {
  provider: ProviderKind;
  model: string;
  baseUrl: string;
  apiKey?: string;
  headers: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
  contextWindow: number;
  contextWindowSource: ContextWindowSource;
  maxSteps: number;
  approval: ApprovalMode;
  workspace: string;
  systemPrompt?: string;
}

export interface ConfigOverrides {
  provider?: ProviderKind;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
  contextWindow?: number;
  maxSteps?: number;
  approval?: ApprovalMode;
  workspace?: string;
  systemPrompt?: string;
}

const CONFIG_FILE = "harness.config.json";

export const PROVIDER_DEFAULTS: Record<
  ProviderKind,
  { baseUrl: string; model: string; contextWindow: number }
> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    contextWindow: 128_000,
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com/v1",
    model: "claude-sonnet-4-20250514",
    contextWindow: 200_000,
  },
  mock: {
    baseUrl: "http://localhost",
    model: "mock-1",
    contextWindow: 32_000,
  },
};

function loadDotEnv(): void {
  // Node >= 20.12 can read a .env file without any dependency.
  const loader = (process as unknown as { loadEnvFile?: (p?: string) => void }).loadEnvFile;
  try {
    loader?.();
  } catch {
    // No .env file — that's fine.
  }
}

function readConfigFile(): Partial<HarnessConfig> {
  const file = path.resolve(process.cwd(), CONFIG_FILE);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Partial<HarnessConfig>;
  } catch (err) {
    throw new Error(
      `Could not parse ${CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

const APPROVAL_MODES = new Set<ApprovalMode>(["none", "bash", "all"]);

function parseApproval(value: unknown): ApprovalMode | undefined {
  if (typeof value !== "string") return undefined;
  const mode = value.trim().toLowerCase();
  return APPROVAL_MODES.has(mode as ApprovalMode) ? (mode as ApprovalMode) : undefined;
}

function parseHeaders(raw: string): Record<string, string> {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) out[k] = String(v);
    return out;
  } catch (err) {
    throw new Error(
      `HARNESS_HEADERS must be a JSON object: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Resolve configuration with this precedence (highest wins):
 *   CLI flags (overrides) > environment variables > harness.config.json > defaults
 */
export function loadConfig(overrides: ConfigOverrides = {}): HarnessConfig {
  loadDotEnv();
  const file = readConfigFile();
  const env = process.env;

  const explicitProvider =
    overrides.provider ??
    (env.HARNESS_PROVIDER as ProviderKind | undefined) ??
    file.provider;

  const hasAnyKey = Boolean(
    env.HARNESS_API_KEY ||
      env.OPENAI_API_KEY ||
      env.ANTHROPIC_API_KEY ||
      file.apiKey,
  );

  // Nice first-run experience: no provider configured and no key -> mock.
  const provider: ProviderKind = explicitProvider ?? (hasAnyKey ? "openai" : "mock");

  const baseUrl =
    overrides.baseUrl ??
    env.HARNESS_BASE_URL ??
    file.baseUrl ??
    PROVIDER_DEFAULTS[provider].baseUrl;

  const apiKey =
    overrides.apiKey ??
    env.HARNESS_API_KEY ??
    (provider === "anthropic" ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY) ??
    file.apiKey;

  const model =
    overrides.model ?? env.HARNESS_MODEL ?? file.model ?? PROVIDER_DEFAULTS[provider].model;

  let headers: Record<string, string> = {
    ...(file.headers ?? {}),
    ...(overrides.headers ?? {}),
  };
  if (env.HARNESS_HEADERS) {
    headers = { ...headers, ...parseHeaders(env.HARNESS_HEADERS) };
  }

  const workspace = path.resolve(
    overrides.workspace ?? env.HARNESS_WORKSPACE ?? file.workspace ?? process.cwd(),
  );

  const explicitContextWindow =
    overrides.contextWindow ??
    toNumber(env.HARNESS_CONTEXT_WINDOW) ??
    file.contextWindow;

  return {
    provider,
    model,
    baseUrl,
    apiKey,
    headers,
    maxTokens:
      overrides.maxTokens ?? toNumber(env.HARNESS_MAX_TOKENS) ?? file.maxTokens,
    temperature:
      overrides.temperature ??
      toNumber(env.HARNESS_TEMPERATURE) ??
      file.temperature,
    contextWindow:
      explicitContextWindow ?? PROVIDER_DEFAULTS[provider].contextWindow,
    contextWindowSource: explicitContextWindow !== undefined ? "config" : "default",
    maxSteps:
      overrides.maxSteps ?? toNumber(env.HARNESS_MAX_STEPS) ?? file.maxSteps ?? 25,
    approval:
      overrides.approval ??
      parseApproval(env.HARNESS_APPROVE) ??
      parseApproval(file.approval) ??
      "none",
    workspace,
    systemPrompt:
      overrides.systemPrompt ?? env.HARNESS_SYSTEM_PROMPT ?? file.systemPrompt,
  };
}
