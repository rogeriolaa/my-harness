import type { Message, Provider, ToolCall, ToolSpec } from "./types.ts";
import type { ToolContext, ToolRegistry, ToolResult } from "./tools/registry.ts";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type AgentEvent =
  | { type: "step"; index: number }
  | { type: "text"; text: string }
  | { type: "tool_call"; toolCall: ToolCall }
  | { type: "tool_result"; toolCall: ToolCall; result: ToolResult; durationMs: number }
  | { type: "tool_rejected"; toolCall: ToolCall; reason: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done"; text: string; steps: number }
  | { type: "error"; error: Error };

/** The verdict returned by the approval hook. */
export interface ToolApproval {
  approved: boolean;
  reason?: string;
}

export interface AgentOptions {
  provider: Provider;
  tools: ToolRegistry;
  systemPrompt: string;
  toolContext: ToolContext;
  maxSteps?: number;
  onEvent?: (event: AgentEvent) => void;
  /**
   * Called before every tool runs. Return `{ approved: false, reason }` to
   * block it; the reason is handed back to the model as a tool error.
   */
  onToolCall?: (toolCall: ToolCall) => ToolApproval | Promise<ToolApproval>;
  signal?: AbortSignal;
}

/**
 * THE LOOP.
 *
 *   user text -> model -> (tool calls? execute, append results, repeat)
 *                       -> (no tool calls? done)
 *
 * That is the entire idea behind every coding agent. Everything else in this
 * project is plumbing around these ~40 lines.
 */
export class Agent {
  private readonly opts: AgentOptions;
  private currentProvider: Provider;
  private lastRequestUsage: TokenUsage | null = null;
  private readonly totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  readonly messages: Message[] = [];

  constructor(opts: AgentOptions) {
    this.opts = {
      ...opts,
      maxSteps: opts.maxSteps ?? 25,
    };
    this.currentProvider = opts.provider;
  }

  get provider(): Provider {
    return this.currentProvider;
  }

  /** Swap the model backend without losing conversation history. */
  setProvider(provider: Provider): void {
    this.currentProvider = provider;
  }

  get history(): readonly Message[] {
    return this.messages;
  }

  get tools(): readonly ToolSpec[] {
    return this.opts.tools.specs();
  }

  /** Token usage from the last model call, plus session totals. */
  get usage(): { last: TokenUsage | null; total: TokenUsage } {
    return { last: this.lastRequestUsage, total: { ...this.totalUsage } };
  }

  /**
   * Best current estimate of the context size.
   *
   * Prefers the provider's reported prompt+completion tokens for the last
   * request. Falls back to a chars/4 heuristic when the provider doesn't
   * return usage (or before the first call).
   */
  contextTokens(): { tokens: number; source: "api" | "estimate" } {
    if (this.lastRequestUsage) {
      return {
        tokens: this.lastRequestUsage.inputTokens + this.lastRequestUsage.outputTokens,
        source: "api",
      };
    }
    return { tokens: this.estimateContextTokens(), source: "estimate" };
  }

  /** Rough chars/4 estimate of system + messages + tool specs. */
  estimateContextTokens(): number {
    const chunks: string[] = [this.opts.systemPrompt];

    for (const message of this.messages) {
      chunks.push(message.content);
      if (message.role === "assistant") {
        for (const call of message.toolCalls) {
          chunks.push(call.name, JSON.stringify(call.arguments));
        }
      }
    }

    for (const spec of this.opts.tools.specs()) {
      chunks.push(spec.name, spec.description, JSON.stringify(spec.parameters));
    }

    const chars = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    return Math.ceil(chars / 4);
  }

  reset(): void {
    this.messages.length = 0;
    this.lastRequestUsage = null;
    this.totalUsage.inputTokens = 0;
    this.totalUsage.outputTokens = 0;
  }

  /** Replace the conversation history (used when resuming a session). */
  restore(messages: Message[]): void {
    this.messages.length = 0;
    this.messages.push(...messages);
    this.lastRequestUsage = null;
    this.totalUsage.inputTokens = 0;
    this.totalUsage.outputTokens = 0;
  }

  async send(userText: string, signal?: AbortSignal): Promise<string> {
    this.messages.push({ role: "user", content: userText });
    return this.loop(signal ?? this.opts.signal);
  }

  private emit(event: AgentEvent): void {
    this.opts.onEvent?.(event);
  }

  /** Ask the approval hook about a tool call. No hook means "run it". */
  private async approve(toolCall: ToolCall): Promise<ToolApproval | undefined> {
    if (!this.opts.onToolCall) return undefined;
    try {
      return await this.opts.onToolCall(toolCall);
    } catch (err) {
      // A crashing approval hook must not silently allow the tool.
      return {
        approved: false,
        reason: `Approval check failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private async loop(signal?: AbortSignal): Promise<string> {
    const maxSteps = this.opts.maxSteps ?? 25;

    for (let step = 1; step <= maxSteps; step++) {
      this.emit({ type: "step", index: step });

      let text = "";
      const toolCalls: ToolCall[] = [];

      try {
        for await (const event of this.currentProvider.chat({
          system: this.opts.systemPrompt,
          messages: this.messages,
          tools: this.opts.tools.specs(),
          signal,
        })) {
          switch (event.type) {
            case "text":
              text += event.text;
              this.emit(event);
              break;
            case "tool_call":
              toolCalls.push(event.toolCall);
              this.emit(event);
              break;
            case "usage":
              this.lastRequestUsage = {
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
              };
              this.totalUsage.inputTokens += event.inputTokens;
              this.totalUsage.outputTokens += event.outputTokens;
              this.emit(event);
              break;
            case "finish":
              break;
          }
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.emit({ type: "error", error });
        throw error;
      }

      // Always record the assistant turn — even an empty one — so the next
      // request has a consistent history.
      this.messages.push({ role: "assistant", content: text, toolCalls });

      // No tools requested => the model is done.
      if (toolCalls.length === 0) {
        this.emit({ type: "done", text, steps: step });
        return text;
      }

      // Execute every requested tool and feed the results back into history.
      //
      // Two details worth noting:
      //  - approvals are resolved first, one at a time, because the CLI asks
      //    the user a question and a prompt can't be interleaved.
      //  - the approved calls then run concurrently, but the results are
      //    appended in the order the model requested them. Providers expect
      //    tool results to line up with their tool calls.
      const decisions: Array<ToolApproval | undefined> = [];
      for (const toolCall of toolCalls) {
        decisions.push(await this.approve(toolCall));
      }

      const started = Date.now();
      const outcomes = await Promise.all(
        toolCalls.map(async (toolCall, index) => {
          const decision = decisions[index];
          if (decision && !decision.approved) {
            const reason = decision.reason ?? "The user denied this tool call.";
            return {
              toolCall,
              result: { content: reason, isError: true } satisfies ToolResult,
              rejected: true,
              reason,
            };
          }

          const result = await this.opts.tools.execute(
            toolCall.name,
            toolCall.arguments,
            { ...this.opts.toolContext, signal },
          );
          return { toolCall, result, rejected: false, reason: undefined };
        }),
      );
      const durationMs = Date.now() - started;

      for (const outcome of outcomes) {
        this.messages.push({
          role: "tool",
          toolCallId: outcome.toolCall.id,
          toolName: outcome.toolCall.name,
          content: outcome.result.content,
          isError: outcome.result.isError,
        });

        if (outcome.rejected) {
          this.emit({
            type: "tool_rejected",
            toolCall: outcome.toolCall,
            reason: outcome.reason ?? "denied",
          });
          continue;
        }

        this.emit({
          type: "tool_result",
          toolCall: outcome.toolCall,
          result: outcome.result,
          durationMs,
        });
      }
    }

    const error = new Error(
      `Stopped after ${maxSteps} steps without a final answer. ` +
        `Increase HARNESS_MAX_STEPS or give the model a narrower task.`,
    );
    this.emit({ type: "error", error });
    throw error;
  }
}
