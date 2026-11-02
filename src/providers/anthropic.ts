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

export interface AnthropicOptions {
  model: string;
  baseUrl: string;
  apiKey?: string;
  headers?: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
  version?: string;
}

type Block =
  | { kind: "text" }
  | { kind: "tool"; id: string; name: string; json: string };

/**
 * Adapter for the Anthropic Messages API (streaming).
 *
 * Notice how different the wire format is from OpenAI's: `system` is a
 * top-level field, tool calls and results are *content blocks*, and tool
 * results are sent as a `user` message. All of that is hidden from the agent
 * loop by converting to/from the normalized `Message` type.
 */
export class AnthropicProvider implements Provider {
  readonly name = "anthropic";
  readonly model: string;
  private readonly opts: AnthropicOptions;

  constructor(opts: AnthropicOptions) {
    this.opts = opts;
    this.model = opts.model;
  }

  async *chat(req: ChatRequest): AsyncGenerator<LLMEvent> {
    const url = `${this.opts.baseUrl.replace(/\/+$/, "")}/messages`;

    const body: Record<string, unknown> = {
      model: this.opts.model,
      max_tokens: req.maxTokens ?? this.opts.maxTokens ?? 4096,
      messages: toAnthropicMessages(req.messages),
      stream: true,
    };
    if (req.system) body.system = req.system;
    if (req.tools.length > 0) {
      body.tools = req.tools.map(toAnthropicTool);
    }
    const temperature = req.temperature ?? this.opts.temperature;
    if (temperature !== undefined) body.temperature = temperature;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": this.opts.version ?? "2023-06-01",
        ...(this.opts.apiKey ? { "x-api-key": this.opts.apiKey } : {}),
        ...(this.opts.headers ?? {}),
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `Anthropic request failed: ${res.status} ${res.statusText}\n${detail.slice(0, 800)}`,
      );
    }
    if (!res.body) throw new Error("Provider returned an empty response body");

    const blocks = new Map<number, Block>();
    let finish: FinishReason = "stop";
    let inputTokens = 0;
    let outputTokens = 0;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let sawStop = false;

    try {
      while (!sawStop) {
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
          if (!payload) continue;

          let event: any;
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }

          switch (event.type) {
            case "message_start":
              inputTokens = event.message?.usage?.input_tokens ?? inputTokens;
              break;

            case "content_block_start": {
              const index = event.index ?? 0;
              const block = event.content_block ?? {};
              if (block.type === "tool_use") {
                blocks.set(index, {
                  kind: "tool",
                  id: block.id ?? `toolu_${randomUUID()}`,
                  name: block.name ?? "",
                  json: "",
                });
              } else {
                blocks.set(index, { kind: "text" });
              }
              break;
            }

            case "content_block_delta": {
              const block = blocks.get(event.index ?? 0);
              const delta = event.delta ?? {};
              if (delta.type === "text_delta" && typeof delta.text === "string") {
                yield { type: "text", text: delta.text };
              } else if (
                delta.type === "input_json_delta" &&
                block?.kind === "tool"
              ) {
                block.json += delta.partial_json ?? "";
              }
              break;
            }

            case "content_block_stop": {
              const block = blocks.get(event.index ?? 0);
              if (block?.kind === "tool") {
                const toolCall: ToolCall = {
                  id: block.id,
                  name: block.name,
                  arguments: parseArguments(block.json),
                };
                yield { type: "tool_call", toolCall };
              }
              break;
            }

            case "message_delta":
              if (event.delta?.stop_reason) {
                finish = mapStopReason(event.delta.stop_reason);
              }
              if (typeof event.usage?.output_tokens === "number") {
                outputTokens = event.usage.output_tokens;
              }
              break;

            case "message_stop":
              sawStop = true;
              break;

            case "error":
              throw new Error(
                `Anthropic stream error: ${event.error?.message ?? "unknown"}`,
              );
          }
        }
      }
    } finally {
      reader.cancel().catch(() => {});
    }

    if (inputTokens || outputTokens) {
      yield { type: "usage", inputTokens, outputTokens };
    }
    yield { type: "finish", reason: finish };
  }
}

function toAnthropicMessages(messages: Message[]): unknown[] {
  const out: any[] = [];

  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const content: any[] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const tc of message.toolCalls) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.arguments });
      }
      out.push({ role: "assistant", content });
      continue;
    }

    // Tool results must be sent as a user message containing tool_result blocks.
    // Consecutive results are merged into a single user turn.
    const block = {
      type: "tool_result",
      tool_use_id: message.toolCallId,
      content: message.content,
      is_error: message.isError ?? false,
    };
    const previous = out[out.length - 1];
    const previousIsToolResults =
      previous &&
      previous.role === "user" &&
      Array.isArray(previous.content) &&
      previous.content[0]?.type === "tool_result";

    if (previousIsToolResults) {
      previous.content.push(block);
    } else {
      out.push({ role: "user", content: [block] });
    }
  }

  return out;
}

function toAnthropicTool(tool: ToolSpec): unknown {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  };
}

function mapStopReason(reason: string): FinishReason {
  switch (reason) {
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "length";
    case "end_turn":
    case "stop_sequence":
      return "stop";
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
