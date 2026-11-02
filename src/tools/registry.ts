import type { ToolSpec } from "../types.ts";

export interface ToolContext {
  workspace: string;
  signal?: AbortSignal;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

/** A tool = a spec the model can see + a function the harness can run. */
export interface Tool {
  spec: ToolSpec;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

const MAX_OUTPUT_CHARS = 24_000;

/**
 * Holds the tools and dispatches model requests to them.
 * This is deliberately dumb: it looks up by name, runs, and caps the output so
 * one huge command can't blow up the context window.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): this {
    this.tools.set(tool.spec.name, tool);
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((tool) => tool.spec);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        content: `Unknown tool "${name}". Available tools: ${this.names().join(", ")}`,
        isError: true,
      };
    }

    try {
      return capOutput(await tool.run(args, ctx));
    } catch (err) {
      return {
        content: `Tool "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true,
      };
    }
  }
}

function capOutput(result: ToolResult): ToolResult {
  if (result.content.length <= MAX_OUTPUT_CHARS) return result;
  const omitted = result.content.length - MAX_OUTPUT_CHARS;
  return {
    ...result,
    content: `${result.content.slice(0, MAX_OUTPUT_CHARS)}\n\n[... output truncated, ${omitted} more characters ...]`,
  };
}
