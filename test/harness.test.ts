/**
 * Tests for the harness.
 *
 * Run with:  npm test
 *
 * These cover the parts that are easy to get subtly wrong: the loop's
 * message bookkeeping, parallel tool execution, the approval hook, and the
 * file tools' edge cases.
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { Agent } from "../src/agent.ts";
import type { AgentEvent, ToolApproval } from "../src/agent.ts";
import { SessionStore } from "../src/session.ts";
import type { LLMEvent, Provider, ToolCall } from "../src/types.ts";
import { ToolRegistry } from "../src/tools/registry.ts";
import type { Tool } from "../src/tools/registry.ts";
import {
  editFileTool,
  grepFilesTool,
  listFilesTool,
  readFileTool,
  writeFileTool,
} from "../src/tools/filesystem.ts";

// ---------------------------------------------------------------------------
// A scripted provider, so the loop can be driven deterministically.
// ---------------------------------------------------------------------------

class ScriptedProvider implements Provider {
  readonly name = "scripted";
  readonly model = "scripted-1";
  readonly turns: LLMEvent[][];

  constructor(turns: LLMEvent[][]) {
    this.turns = turns;
  }

  async *chat(): AsyncGenerator<LLMEvent> {
    const turn = this.turns.shift();
    if (!turn) throw new Error("scripted provider ran out of turns");
    for (const event of turn) yield event;
  }
}

function toolCall(name: string, args: Record<string, unknown>, id = "call_1"): ToolCall {
  return { id, name, arguments: args };
}

function textTurn(text: string): LLMEvent[] {
  return [{ type: "text", text }, { type: "finish", reason: "stop" }];
}

function toolTurn(calls: ToolCall[]): LLMEvent[] {
  return [
    ...calls.map((c) => ({ type: "tool_call", toolCall: c }) as LLMEvent),
    { type: "finish", reason: "tool_use" },
  ];
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

describe("Agent loop", () => {
  it("returns the model's text when no tools are called", async () => {
    const agent = new Agent({
      provider: new ScriptedProvider([textTurn("hello there")]),
      tools: new ToolRegistry(),
      systemPrompt: "sys",
      toolContext: { workspace: process.cwd() },
    });

    const answer = await agent.send("hi");
    assert.equal(answer, "hello there");
    assert.deepEqual(
      agent.history.map((m) => m.role),
      ["user", "assistant"],
    );
  });

  it("executes a tool and feeds the result back into the history", async () => {
    const tool: Tool = {
      spec: {
        name: "echo",
        description: "Echo back.",
        parameters: { type: "object", properties: { text: { type: "string" } } },
      },
      async run(args) {
        return { content: `echo: ${String(args.text)}` };
      },
    };

    const agent = new Agent({
      provider: new ScriptedProvider([
        toolTurn([toolCall("echo", { text: "ping" })]),
        textTurn("done"),
      ]),
      tools: new ToolRegistry().register(tool),
      systemPrompt: "sys",
      toolContext: { workspace: process.cwd() },
    });

    await agent.send("go");

    const toolMessage = agent.history.find((m) => m.role === "tool");
    assert.ok(toolMessage, "expected a tool message");
    assert.equal(toolMessage.content, "echo: ping");
    assert.equal(toolMessage.toolCallId, "call_1");
  });

  it("keeps tool results in the order the model requested them", async () => {
    const delays: Record<string, number> = { slow: 40, fast: 0 };
    const tool: Tool = {
      spec: {
        name: "work",
        description: "Work.",
        parameters: { type: "object", properties: { label: { type: "string" } } },
      },
      async run(args) {
        const label = String(args.label);
        await new Promise((resolve) => setTimeout(resolve, delays[label] ?? 0));
        return { content: label };
      },
    };

    const agent = new Agent({
      provider: new ScriptedProvider([
        toolTurn([
          toolCall("work", { label: "slow" }, "call_slow"),
          toolCall("work", { label: "fast" }, "call_fast"),
        ]),
        textTurn("done"),
      ]),
      tools: new ToolRegistry().register(tool),
      systemPrompt: "sys",
      toolContext: { workspace: process.cwd() },
    });

    await agent.send("go");

    const toolMessages = agent.history.filter((m) => m.role === "tool");
    assert.equal(toolMessages.length, 2);
    // The slow tool finishes last, but its result must still come first.
    assert.equal(toolMessages[0].content, "slow");
    assert.equal(toolMessages[1].content, "fast");
  });

  it("runs independent tool calls concurrently", async () => {
    let active = 0;
    let peak = 0;

    const tool: Tool = {
      spec: {
        name: "work",
        description: "Work.",
        parameters: { type: "object", properties: {} },
      },
      async run() {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active--;
        return { content: "ok" };
      },
    };

    const agent = new Agent({
      provider: new ScriptedProvider([
        toolTurn([
          toolCall("work", {}, "call_1"),
          toolCall("work", {}, "call_2"),
          toolCall("work", {}, "call_3"),
        ]),
        textTurn("done"),
      ]),
      tools: new ToolRegistry().register(tool),
      systemPrompt: "sys",
      toolContext: { workspace: process.cwd() },
    });

    await agent.send("go");
    assert.equal(peak, 3, "expected all three calls to be in flight at once");
  });

  it("stops after maxSteps instead of looping forever", async () => {
    const tool: Tool = {
      spec: { name: "again", description: "Again.", parameters: { type: "object", properties: {} } },
      async run() {
        return { content: "again" };
      },
    };

    const agent = new Agent({
      provider: new ScriptedProvider([
        toolTurn([toolCall("again", {}, "call_1")]),
        toolTurn([toolCall("again", {}, "call_2")]),
        toolTurn([toolCall("again", {}, "call_3")]),
      ]),
      tools: new ToolRegistry().register(tool),
      systemPrompt: "sys",
      toolContext: { workspace: process.cwd() },
      maxSteps: 2,
    });

    await assert.rejects(() => agent.send("go"), /Stopped after 2 steps/);
  });

  it("reports an unknown tool as an error instead of throwing", async () => {
    const agent = new Agent({
      provider: new ScriptedProvider([
        toolTurn([toolCall("nope", {}, "call_1")]),
        textTurn("done"),
      ]),
      tools: new ToolRegistry(),
      systemPrompt: "sys",
      toolContext: { workspace: process.cwd() },
    });

    await agent.send("go");

    const toolMessage = agent.history.find((m) => m.role === "tool");
    assert.ok(toolMessage);
    assert.equal(toolMessage.isError, true);
    assert.match(toolMessage.content, /Unknown tool "nope"/);
  });
});

// ---------------------------------------------------------------------------
// The approval hook
// ---------------------------------------------------------------------------

describe("approval hook", () => {
  const tool: Tool = {
    spec: { name: "bash", description: "Shell.", parameters: { type: "object", properties: {} } },
    async run() {
      return { content: "ran" };
    },
  };

  function makeAgent(approve: (call: ToolCall) => ToolApproval, events: AgentEvent[]) {
    return new Agent({
      provider: new ScriptedProvider([
        toolTurn([toolCall("bash", { command: "ls" }, "call_1")]),
        textTurn("done"),
      ]),
      tools: new ToolRegistry().register(tool),
      systemPrompt: "sys",
      toolContext: { workspace: process.cwd() },
      onToolCall: approve,
      onEvent: (event) => events.push(event),
    });
  }

  it("runs the tool when approved", async () => {
    const events: AgentEvent[] = [];
    const agent = makeAgent(() => ({ approved: true }), events);
    await agent.send("go");

    const toolMessage = agent.history.find((m) => m.role === "tool");
    assert.equal(toolMessage?.content, "ran");
    assert.ok(!events.some((e) => e.type === "tool_rejected"));
  });

  it("blocks the tool and tells the model why", async () => {
    const events: AgentEvent[] = [];
    const agent = makeAgent(
      () => ({ approved: false, reason: "The user denied the call to `bash`." }),
      events,
    );
    await agent.send("go");

    const toolMessage = agent.history.find((m) => m.role === "tool");
    assert.equal(toolMessage?.isError, true);
    assert.match(String(toolMessage?.content), /denied/);
    assert.ok(events.some((e) => e.type === "tool_rejected"));
  });

  it("denies the tool when the hook itself throws", async () => {
    const agent = makeAgent(() => {
      throw new Error("hook exploded");
    }, []);
    await agent.send("go");

    const toolMessage = agent.history.find((m) => m.role === "tool");
    assert.equal(toolMessage?.isError, true);
    assert.match(String(toolMessage?.content), /Approval check failed/);
  });
});

// ---------------------------------------------------------------------------
// File tools
// ---------------------------------------------------------------------------

describe("file tools", () => {
  let workspace: string;

  before(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), "harness-test-"));
    await fs.writeFile(path.join(workspace, "sample.txt"), "alpha\nbeta\ngamma\n");
  });

  after(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const ctx = () => ({ workspace });

  it("reads a file with line numbers", async () => {
    const result = await readFileTool.run({ path: "sample.txt" }, ctx());
    assert.match(result.content, /1 \| alpha/);
    assert.match(result.content, /3 \| gamma/);
  });

  it("does not count the trailing newline as an extra line", async () => {
    const result = await readFileTool.run({ path: "sample.txt" }, ctx());
    assert.match(result.content, /3 \| gamma/);
    assert.doesNotMatch(result.content, /4 \|/);
  });

  it("pages with offset and limit", async () => {
    const result = await readFileTool.run(
      { path: "sample.txt", offset: 2, limit: 1 },
      ctx(),
    );
    assert.match(result.content, /2 \| beta/);
    assert.doesNotMatch(result.content, /gamma/);
    assert.match(result.content, /more lines/);
  });

  it("treats an explicit limit of 0 as the minimum, not the default", async () => {
    // The bug: `Math.trunc(Number(0)) || 2000` made 0 falsy, so an explicit
    // `limit: 0` read the whole file. It must now clamp to the minimum.
    const result = await readFileTool.run({ path: "sample.txt", limit: 0 }, ctx());
    assert.match(result.content, /1 \| alpha/);
    assert.doesNotMatch(result.content, /gamma/);
  });

  it("refuses to read outside the workspace", async () => {
    await assert.rejects(
      () => readFileTool.run({ path: "../../etc/passwd" }, ctx()),
      /outside the workspace/,
    );
  });

  it("writes and then reads back a file", async () => {
    await writeFileTool.run({ path: "nested/out.txt", content: "written" }, ctx());
    const result = await readFileTool.run({ path: "nested/out.txt" }, ctx());
    assert.match(result.content, /written/);
  });

  it("rejects an edit whose old_string is missing", async () => {
    await assert.rejects(
      () =>
        editFileTool.run(
          { path: "sample.txt", old_string: "delta", new_string: "x" },
          ctx(),
        ),
      /was not found/,
    );
  });

  it("rejects an ambiguous edit", async () => {
    await fs.writeFile(path.join(workspace, "dup.txt"), "a\na\na\n");
    await assert.rejects(
      () => editFileTool.run({ path: "dup.txt", old_string: "a", new_string: "b" }, ctx()),
      /occurs 3 times/,
    );
  });

  it("replaces every occurrence when replace_all is set", async () => {
    await fs.writeFile(path.join(workspace, "dup.txt"), "a\na\na\n");
    const result = await editFileTool.run(
      { path: "dup.txt", old_string: "a", new_string: "b", replace_all: true },
      ctx(),
    );
    assert.match(result.content, /Replaced 3 occurrence/);
    const after = await fs.readFile(path.join(workspace, "dup.txt"), "utf8");
    assert.equal(after, "b\nb\nb\n");
  });

  it("lists files without walking into node_modules", async () => {
    await fs.mkdir(path.join(workspace, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(workspace, "node_modules", "pkg", "index.js"), "x");

    const result = await listFilesTool.run({ path: "." }, ctx());
    assert.match(result.content, /sample\.txt/);
    assert.doesNotMatch(result.content, /node_modules/);
  });

  it("greps file contents and reports path and line", async () => {
    const result = await grepFilesTool.run({ pattern: "beta" }, ctx());
    assert.match(result.content, /sample\.txt:2: beta/);
  });

  it("accepts a slash-delimited pattern with flags", async () => {
    const result = await grepFilesTool.run({ pattern: "/BETA/i" }, ctx());
    assert.match(result.content, /sample\.txt:2: beta/);
  });

  it("finds every match even when the pattern asks for the global flag", async () => {
    await fs.writeFile(path.join(workspace, "many.txt"), "hit\nhit\nhit\n");
    const result = await grepFilesTool.run({ pattern: "/hit/g" }, ctx());
    const lines = result.content.split("\n").filter((line) => line.includes("many.txt"));
    assert.equal(lines.length, 3, `expected 3 matches, got ${lines.length}`);
  });
});

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

describe("SessionStore", () => {
  let dir: string;

  before(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-sessions-"));
  });

  after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("round-trips a session", async () => {
    const store = new SessionStore(dir);
    const session = store.create({ workspace: "/tmp", provider: "mock", model: "mock-1" });
    session.messages = [{ role: "user", content: "hello" }];

    store.save(session);
    const loaded = store.load(session.id);

    assert.ok(loaded);
    assert.equal(loaded.id, session.id);
    assert.equal(loaded.messages.length, 1);
    assert.equal(loaded.messages[0].content, "hello");
  });

  it("writes session files with owner-only permissions", async () => {
    const store = new SessionStore(dir);
    const session = store.create({ workspace: "/tmp" });
    store.save(session);

    const stat = await fs.stat(path.join(dir, `${session.id}.json`));
    assert.equal(stat.mode & 0o777, 0o600);
  });

  it("skips corrupt files when listing", async () => {
    const store = new SessionStore(dir);
    await fs.writeFile(path.join(dir, "broken.json"), "{not json");

    const listed = store.list();
    assert.ok(listed.every((s) => s.id !== "broken"));
  });
});
