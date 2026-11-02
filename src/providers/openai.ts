import { randomUUID } from "node:crypto";
import type {
  ChatRequest,
  FinishReason,
  LLMEvent,
  Message,
  Provider,
  ToolCall,
  ToolSpec,
} from "../types.ts";

export interface OpenAICompatibleOptions {
  model: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
}

/**
 * Adapter for the OpenAI Chat Completions API (streaming).
 *
 * This one adapter covers a huge range of providers — OpenAI, Ollama, LM Studio,
 * vLLM, OpenRouter, Groq, Together, DeepSeek — because they all speak the same
 * `POST /chat/completions` protocol. Point `baseUrl` at any of them.
 */
export class OpenAICompatibleProvider implements Provider {
  readonly name = "openai-compatible";
  readonly model: string;
  private readonly opts: OpenAICompatibleOptions;

  constructor(opts: OpenAICompatibleOptions) {
    this.opts = opts;
    this.model = opts.model;
  }

  async *chat(req: ChatRequest): AsyncGenerator<LLMEvent> {
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;

    const body: Record<string, unknown> = {
      model: this.opts.model,
      messages: toOpenAIMessages(req.system, req.messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.tools.length > 0) {
      body.tools = req.tools.map(toOpenAITool);
      body.tool_choice = "auto";
    }

    const maxTokens = req.maxTokens ?? this.opts.maxTokens;
    if (maxTokens) body.max_tokens = maxTokens;
    const temperature = req.temperature ?? this.opts.temperature;
    if (temperature !== undefined) body.temperature = temperature;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.opts.apiKey
          ? { authorization: `Bearer ${this.opts.apiKey}` }
          : {}),
        ...(this.opts.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `OpenAI-compatible request failed: ${res.status} ${res.statusText}\n${detail.slice(0, 800)}`,
      );
    }
    if (!res.body) throw new Error("Provider returned an empty response body");

    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finish: FinishReason = "stop";
    let usage: { inputTokens: number; outputTokens: number } | undefined;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawDone = false;

    try {
      while (!sawDone) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let newline = buffer.indexOf("\n");
        while (newline !== -1) {
          const raw = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");

          if (!raw.startsWith("data:")) continue;
          const payload = raw.slice(5).trim();
          if (payload === "[DONE]") {
            sawDone = true;
            break;
          }

          let chunk: any;
          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }

          if (chunk.usage) {
            usage = {
              inputTokens: chunk.usage.prompt_tokens ?? 0,
              outputTokens: chunk.usage.completion_tokens ?? 0,
            };
          }

          const choice = chunk.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};

          if (typeof delta.content === "string" && delta.content.length > 0) {
            yield { type: "text", text: delta.content };
          }

          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const index = typeof tc.index === "number" ? tc.index : 0;
              let acc = pending.get(index);
              if (!acc) {
                acc = { id: "", name: "", args: "" };
                pending.set(index, acc);
              }
              if (tc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (typeof tc.function?.arguments === "string") {
                acc.args += tc.function.arguments;
              }
            }
          }

          if (choice.finish_reason) finish = mapFinish(choice.finish_reason);
        }
      }
    } finally {
      // Make sure the connection is released even if the consumer breaks early.
      reader.cancel().catch(() => {});
    }

    const ordered = [...pending.entries()].sort((a, b) => a[0] - b[0]);
    for (const [, tc] of ordered) {
      if (!tc.name) continue;
      const toolCall: ToolCall = {
        id: tc.id || `call_${randomUUID()}`,
        name: tc.name,
        arguments: parseArguments(tc.args),
      };
      yield { type: "tool_call", toolCall };
    }

    if (usage) yield { type: "usage", ...usage };
    yield { type: "finish", reason: finish };
  }
}

function toOpenAIMessages(system: string, messages: Message[]): unknown[] {
  const out: unknown[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const message of messages) {
    switch (message.role) {
      case "system":
        out.push({ role: "system", content: message.content });
        break;
      case "user":
        out.push({ role: "user", content: message.content });
        break;
      case "assistant":
        out.push({
          role: "assistant",
          content: message.content || null,
          ...(message.toolCalls.length > 0
            ? {
                tool_calls: message.toolCalls.map((tc) => ({
                  id: tc.id,
                  type: "function",
                  function: {
                    name: tc.name,
                    arguments: JSON.stringify(tc.arguments),
                  },
                })),
              }
            : {}),
        });
        break;
      case "tool":
        out.push({
          role: "tool",
          tool_call_id: message.toolCallId,
          content: message.content,
        });
        break;
    }
  }

  return out;
}

function toOpenAITool(tool: ToolSpec): unknown {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function mapFinish(reason: string): FinishReason {
  switch (reason) {
    case "tool_calls":
      return "tool_use";
    case "length":
      return "length";
    case "content_filter":
      return "error";
    default:
      return "stop";
  }
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    return { _raw: raw };
  }
}
