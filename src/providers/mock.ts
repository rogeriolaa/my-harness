import type { ChatRequest, LLMEvent, Provider } from "../types.ts";

/**
 * A scripted provider with no network access.
 *
 * It exists to make the agent loop observable: the first call asks to run a
 * tool, the second call summarizes the tool result. Run `npm run mock` and you
 * can watch the whole cycle without an API key.
 */
export class MockProvider implements Provider {
  readonly name = "mock";
  readonly model: string;

  constructor(model = "mock-1") {
    this.model = model;
  }

  async *chat(req: ChatRequest): AsyncGenerator<LLMEvent> {
    const last = req.messages.at(-1);

    if (last && last.role === "tool") {
      const preview = truncate(last.content, 700);
      yield {
        type: "text",
        text: `Tool \`${last.toolName}\` ${last.isError ? "failed" : "returned"}:\n\n${preview}\n\nThat is the entire loop: model → tool call → harness executes it → result is appended to the history → model sees it again. Point the harness at a real provider to keep going.`,
      };
      yield { type: "finish", reason: "stop" };
      return;
    }

    yield { type: "text", text: "Let me look at the workspace first." };
    yield {
      type: "tool_call",
      toolCall: {
        id: `call_${Date.now()}`,
        name: "list_files",
        arguments: { path: ".", depth: 1 },
      },
    };
    yield { type: "finish", reason: "tool_use" };
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (truncated)`;
}
