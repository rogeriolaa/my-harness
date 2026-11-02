import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool } from "./registry.ts";

const execAsync = promisify(exec);

/**
 * Coerce a model-supplied number into an integer inside `[min, max]`.
 *
 * The old `Math.trunc(Number(x)) || fallback` idiom had a bug: `0` is falsy,
 * so an explicit `timeout_ms: 0` silently became the fallback instead of the
 * intended minimum.
 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(value ?? fallback));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Run a shell command in the workspace.
 *
 * There is no permission prompt here — this is a learning harness and the tool
 * runs with your user's rights. That is exactly why real harnesses add approval
 * gates and sandboxes. See the README for the "add a permission hook" exercise.
 */
export const bashTool: Tool = {
  spec: {
    name: "bash",
    description:
      "Run a shell command in the workspace and return stdout/stderr. Use it for builds, tests, git, and quick inspection.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run." },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds. Default 120000.",
        },
      },
      required: ["command"],
    },
  },

  async run(args, ctx) {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) throw new Error("command is required");

    const timeout = clampInt(args.timeout_ms, 120_000, 1_000, 600_000);

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: ctx.workspace,
        timeout,
        maxBuffer: 10 * 1024 * 1024,
        signal: ctx.signal,
        shell: "/bin/bash",
      });

      const parts = [stdout.trimEnd()];
      if (stderr.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`);
      const output = parts.filter(Boolean).join("\n");
      return { content: output || "(no output)" };
    } catch (err: any) {
      const parts = [
        `Command failed (exit ${err?.code ?? "?"}): ${command}`,
      ];
      if (err?.stdout) parts.push(String(err.stdout).trimEnd());
      if (err?.stderr) parts.push(`[stderr]\n${String(err.stderr).trimEnd()}`);
      if (err?.killed) parts.push(`[killed after ${timeout}ms]`);
      return { content: parts.filter(Boolean).join("\n"), isError: true };
    }
  },
};
