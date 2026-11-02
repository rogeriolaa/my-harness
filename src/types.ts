/**
 * Core types shared by the agent loop and every provider adapter.
 *
 * The whole point of this file is the *normalized* `Message` shape: the agent
 * loop only ever sees this format. Each provider translates it to/from its own
 * wire format. That is the single seam that makes providers swappable.
 */

export type Role = "system" | "user" | "assistant" | "tool";

/** A tool invocation requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** Provider-agnostic conversation message. */
export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | {
      role: "tool";
      toolCallId: string;
      toolName: string;
      content: string;
      isError?: boolean;
    };

/** Minimal JSON-Schema subset used to describe tool parameters. */
export interface JSONSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/** Description of a tool handed to the model. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JSONSchema;
}

export type FinishReason = "stop" | "tool_use" | "length" | "error";

/** Streaming events yielded by every provider. */
export type LLMEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "finish"; reason: FinishReason };

export interface ChatRequest {
  system: string;
  messages: Message[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  maxTokens?: number;
  temperature?: number;
}

/**
 * The contract a new provider has to satisfy. Implement `chat` as an async
 * generator that yields text deltas and complete tool calls.
 */
export interface Provider {
  readonly name: string;
  readonly model: string;
  chat(req: ChatRequest): AsyncGenerator<LLMEvent>;
}
