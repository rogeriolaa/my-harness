#!/usr/bin/env node
import readline from "node:readline";
import { stdin as input, stdout as output } from "node:process";
import { Agent } from "./agent.ts";
import type { AgentEvent, ToolApproval } from "./agent.ts";
import { loadConfig } from "./config.ts";
import type { ApprovalMode, ConfigOverrides, HarnessConfig, ProviderKind } from "./config.ts";
import { runConnectWizard } from "./connect.ts";
import { detectContextWindow } from "./context-window.ts";
import { createProvider } from "./providers/index.ts";
import { SessionStore } from "./session.ts";
import type { Session } from "./session.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { buildToolRegistry } from "./tools/index.ts";
import type { ToolCall } from "./types.ts";

// ---------------------------------------------------------------------------
// Terminal colors (disabled when not a TTY or NO_COLOR is set)
// ---------------------------------------------------------------------------
const colorEnabled = Boolean(output.isTTY) && !process.env.NO_COLOR;
const paint = (code: string) => (text: string) =>
  colorEnabled ? `\x1b[${code}m${text}\x1b[0m` : text;

const dim = paint("2");
const bold = paint("1");
const cyan = paint("36");
const green = paint("32");
const red = paint("31");
const yellow = paint("33");

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

/** Locale-independent grouping so 1111 never renders as "1.111". */
function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function contextBar(percent: number, width = 18): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function contextLine(agent: Agent, config: HarnessConfig): string {
  const { tokens, source } = agent.contextTokens();
  const mark = source === "estimate" ? "~" : "";
  const limit = config.contextWindow;
  if (!limit || limit <= 0) return `context ${mark}${formatTokens(tokens)}`;
  const percent = (tokens / limit) * 100;
  return `context ${mark}${formatTokens(tokens)} / ${formatTokens(limit)} (${percent.toFixed(1)}%)`;
}

// ---------------------------------------------------------------------------
// Tool approval
// ---------------------------------------------------------------------------

/** Does this tool need the user's OK under the current approval mode? */
export function needsApproval(mode: ApprovalMode, toolName: string): boolean {
  if (mode === "all") return true;
  if (mode === "bash") return toolName === "bash";
  return false;
}

/** A one-line preview of a tool call, for the approval prompt. */
function previewCall(toolCall: ToolCall): string {
  const args = JSON.stringify(toolCall.arguments);
  return args.length > 160 ? `${args.slice(0, 160)}…` : args;
}

/**
 * Build the `onToolCall` hook the agent uses to gate tools.
 *
 * `ask` is injected so the same hook works in the REPL (which reuses its line
 * queue) and in one-shot mode (which opens a throwaway readline prompt).
 */
export function createApprovalHook(
  mode: ApprovalMode,
  ask: (question: string) => Promise<string>,
): (toolCall: ToolCall) => Promise<ToolApproval> {
  return async (toolCall: ToolCall): Promise<ToolApproval> => {
    if (!needsApproval(mode, toolCall.name)) return { approved: true };

    const answer = (
      await ask(`  allow ${toolCall.name}(${previewCall(toolCall)})? [y/N] `)
    )
      .trim()
      .toLowerCase();

    if (answer === "y" || answer === "yes") return { approved: true };
    return {
      approved: false,
      reason: `The user denied the call to \`${toolCall.name}\`. Do not retry it; ask what to do instead.`,
    };
  };
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------
interface Args {
  flags: Record<string, string | boolean>;
  positional: string[];
}

/** Flags that never consume the following token as their value. */
const BOOLEAN_FLAGS = new Set(["mock", "help", "verbose", "no-save", "sessions"]);

function parseArgs(argv: string[]): Args {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (arg === "-h") {
      flags.help = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    if (eq !== -1) {
      flags[arg.slice(2, eq)] = arg.slice(eq + 1);
      continue;
    }

    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }

    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[key] = next;
      i++;
    } else {
      flags[key] = true;
    }
  }

  return { flags, positional };
}

function numberFlag(value: string | boolean | undefined): number | undefined {
  if (typeof value !== "string") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function stringFlag(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Rendering agent events
// ---------------------------------------------------------------------------
function createRenderer() {
  let streamed = false;

  const breakLine = () => {
    if (streamed) {
      output.write("\n");
      streamed = false;
    }
  };

  return {
    reset() {
      streamed = false;
    },
    onEvent(event: AgentEvent) {
      switch (event.type) {
        case "step":
          if (event.index > 1) output.write("\n");
          break;

        case "text":
          if (!streamed) {
            output.write(cyan("assistant › "));
            streamed = true;
          }
          output.write(event.text);
          break;

        case "tool_call": {
          breakLine();
          const args = JSON.stringify(event.toolCall.arguments);
          const preview = args.length > 240 ? `${args.slice(0, 240)}…` : args;
          output.write(dim(`  ⚙ ${event.toolCall.name}(${preview})\n`));
          break;
        }

        case "tool_result": {
          const ok = !event.result.isError;
          const badge = ok ? green("✓") : red("✗");
          const size = formatCount(event.result.content.length);
          const label = event.result.isError ? red(event.toolCall.name) : event.toolCall.name;
          output.write(dim(`  ${badge} ${label} · ${event.durationMs}ms · ${size} chars\n`));
          break;
        }

        case "tool_rejected":
          output.write(yellow(`  ⊘ ${event.toolCall.name} · denied by the user\n`));
          break;

        case "usage":
          // Token accounting is available for callers that want it.
          break;

        case "done":
          breakLine();
          output.write("\n");
          break;

        case "error":
          breakLine();
          output.write(red(`  error: ${event.error.message}\n`));
          break;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Help / banner
// ---------------------------------------------------------------------------
function printHelp(): void {
  output.write(`my-harness — a tiny LLM agent loop

Usage:
  my-harness [options] [prompt...]

With a prompt, runs once and exits. Without one, starts an interactive REPL.

Options:
  --provider <kind>     openai | anthropic | mock
  --model <name>        model id for the chosen provider
  --base-url <url>      base URL (any OpenAI-compatible server)
  --api-key <key>       API key (prefer the env var instead)
  --max-steps <n>       model<->tool round trips before giving up (default 25)
  --max-tokens <n>      max tokens per model response
  --temperature <n>     sampling temperature
  --context-window <n>  context window used for usage display
  --approve <mode>      ask before running tools: none | bash | all (default none)
  --workspace <dir>     root directory tools may touch (default cwd)
  --system <text>       override the system prompt
  --resume [id]         resume the latest session (or a specific one)
  --session <id>        use or create a session with this id
  --no-save             disable session persistence
  --sessions            list saved sessions and exit
  --mock                shortcut for --provider mock
  -h, --help            show this help

Examples:
  npm start                                   # interactive (mock if unconfigured)
  npm start -- "list the files and summarize them"
  npm run mock                                # watch the loop with no API key
  node src/cli.ts --resume                    # continue the latest session
  node src/cli.ts --sessions                  # list saved sessions
  node src/cli.ts --approve bash "run the tests"   # confirm each shell command
  HARNESS_PROVIDER=openai npm start -- "fix the tests"

REPL commands:
  /help /connect /model /context /reset /history /tools /config
  /session /sessions /resume /save /exit
`);
}

function printBanner(
  config: HarnessConfig,
  session: Session | null,
  resumed: boolean,
): void {
  output.write("\n");
  output.write(`${bold("my-harness")} ${dim("— a tiny LLM agent loop")}\n`);
  output.write(dim(`  provider   ${config.provider}\n`));
  output.write(dim(`  model      ${config.model}\n`));
  output.write(dim(`  workspace  ${config.workspace}\n`));
  output.write(dim(`  context    ${formatTokens(config.contextWindow)} tokens\n`));
  if (session) {
    output.write(dim(`  session    ${session.id}${resumed ? " (resumed)" : ""}\n`));
  }
  if (config.provider === "mock") {
    output.write(yellow(`  running the offline mock provider — no API key needed\n`));
  }
  output.write(dim(`  /help for commands, /exit to quit\n\n`));
}

// ---------------------------------------------------------------------------
// Interactive REPL
// ---------------------------------------------------------------------------
async function runRepl(
  config: HarnessConfig,
  store: SessionStore | null,
  initial: Session | null,
): Promise<void> {
  const renderer = createRenderer();

  // The approval hook needs the REPL's line queue, which is set up below, so
  // it is wired through a mutable holder and attached to the agent afterwards.
  let approvalHook: ((toolCall: ToolCall) => Promise<ToolApproval>) | undefined;

  const agent = new Agent({
    provider: createProvider(config),
    tools: buildToolRegistry(),
    systemPrompt: config.systemPrompt ?? buildSystemPrompt(config.workspace),
    toolContext: { workspace: config.workspace },
    maxSteps: config.maxSteps,
    onEvent: renderer.onEvent,
    onToolCall: (toolCall) => {
      if (!approvalHook) return { approved: true };
      return approvalHook(toolCall);
    },
  });

  let session: Session | null = initial;
  if (store && !session) {
    session = store.create({
      workspace: config.workspace,
      provider: config.provider,
      model: config.model,
    });
  }
  if (session) agent.restore(session.messages);

  const persist = (): void => {
    if (!store || !session) return;
    if (agent.history.length === 0) return; // don't litter the store with empty sessions

    session.provider = config.provider;
    session.model = config.model;
    session.workspace = config.workspace;
    session.messages = [...agent.history];

    try {
      store.save(session);
    } catch (err) {
      output.write(
        red(`  session save failed: ${err instanceof Error ? err.message : String(err)}\n`),
      );
    }
  };

  const sessionCtl: SessionController = {
    get store() {
      return store;
    },
    get current() {
      return session;
    },
    persist,
    startNew() {
      agent.reset();
      session = store
        ? store.create({
            workspace: config.workspace,
            provider: config.provider,
            model: config.model,
          })
        : null;
    },
    load(target) {
      session = target;
      agent.restore(target.messages);
    },
  };

  printBanner(config, session, initial !== null);

  const rl = readline.createInterface({ input, output, terminal: input.isTTY === true });
  let abortController: AbortController | null = null;
  let closed = false;

  // A tiny line queue so `/connect` can ask follow-up questions without
  // fighting the main loop for stdin (and without losing buffered lines at EOF).
  const queue: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];

  rl.on("line", (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter(line);
    else queue.push(line);
  });

  rl.on("close", () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()?.(null);
  });

  const nextLine = (): Promise<string | null> => {
    if (queue.length > 0) return Promise.resolve(queue.shift() ?? null);
    if (closed) return Promise.resolve(null);
    return new Promise((resolve) => waiters.push(resolve));
  };

  const askRaw = (question: string): Promise<string | null> => {
    output.write(question);
    return nextLine();
  };

  const ui = {
    ask: async (question: string) => (await askRaw(question)) ?? "",
    print: (text: string) => output.write(text),
  };

  // Now that the line queue exists, the approval hook can use it.
  approvalHook = createApprovalHook(config.approval, ui.ask);

  rl.on("SIGINT", () => {
    if (abortController) {
      abortController.abort();
      abortController = null;
      output.write(dim("\n  (aborted)\n"));
    } else {
      rl.close();
    }
  });

  while (true) {
    const answer = await askRaw(bold("you › "));
    if (answer === null) break;

    const text = answer.trim();
    if (!text) continue;

    if (text.startsWith("/")) {
      const exit = await handleCommand(text, { agent, config, ui, session: sessionCtl });
      if (exit) break;
      continue;
    }

    renderer.reset();
    abortController = new AbortController();
    try {
      await agent.send(text, abortController.signal);
    } catch {
      // The renderer already printed the error.
    } finally {
      abortController = null;
    }
    persist();
    output.write(dim(`  ${contextLine(agent, config)}\n\n`));
  }

  persist();
  rl.close();
  output.write(dim("\nbye.\n"));
}

interface SessionController {
  readonly store: SessionStore | null;
  readonly current: Session | null;
  persist(): void;
  startNew(): void;
  load(session: Session): void;
}

interface CommandContext {
  agent: Agent;
  config: HarnessConfig;
  ui: {
    ask(question: string): Promise<string>;
    print(text: string): void;
  };
  session: SessionController;
}

async function handleCommand(text: string, ctx: CommandContext): Promise<boolean> {
  const { agent, config, ui, session } = ctx;
  const [command, ...rest] = text.split(/\s+/);

  switch (command) {
    case "/exit":
    case "/quit":
      return true;

    case "/connect": {
      try {
        const save = rest.includes("--save");
        const preset = rest.find((arg) => !arg.startsWith("--"));
        const outcome = await runConnectWizard(ui, config, preset, { save });
        agent.setProvider(outcome.provider);
        Object.assign(config, outcome.config);
        await detectContextWindow(config);
        session.persist();
        output.write(green(`  ready — the next message goes to ${config.provider} · ${config.model}\n\n`));
      } catch (err) {
        output.write(red(`  connect: ${err instanceof Error ? err.message : String(err)}\n`));
      }
      return false;
    }

    case "/model": {
      const name = rest.join(" ").trim();
      if (!name) {
        output.write(dim(`  current model: ${config.model}\n  usage: /model <name>\n`));
        return false;
      }
      const previous = config.model;
      config.model = name;
      try {
        agent.setProvider(createProvider(config));
        await detectContextWindow(config);
        session.persist();
        output.write(
          green(
            `  model → ${name} · ${config.provider} · context ${formatTokens(config.contextWindow)}\n`,
          ),
        );
      } catch (err) {
        config.model = previous;
        output.write(red(`  model: ${err instanceof Error ? err.message : String(err)}\n`));
      }
      return false;
    }

    case "/help":
      output.write(`
${bold("commands")}
  /help      show this help
  /connect   configure the model provider (guided setup)
  /model     switch the model, keeping provider and key
  /context   show context window and token usage
  /reset     clear history and start a new session
  /history   show how many messages are in the history
  /tools     list the tools the model can call
  /config    show the resolved configuration
  /session   show the current session id and file
  /sessions  list saved sessions
  /resume    resume the latest session (or /resume <id>)
  /save      write the current session to disk now
  /exit      quit

Arguments:
  /connect <provider>   skip the first question (openai | anthropic | mock)
  /connect --save       write the settings to .env without asking
  /model <name>         e.g. /model qwen2.5-coder
  /resume <id>          resume a specific session

Anything else is sent to the model.
`);
      return false;

    case "/session": {
      const current = session.current;
      if (!session.store || !current) {
        output.write(dim("  session persistence is off (--no-save)\n"));
        return false;
      }
      output.write(
        dim(
          [
            `  id        ${current.id}`,
            `  file      ${session.store.dir}/${current.id}.json`,
            `  messages  ${agent.history.length}`,
            `  updated   ${current.updatedAt}`,
          ].join("\n") + "\n",
        ),
      );
      return false;
    }

    case "/sessions": {
      if (!session.store) {
        output.write(dim("  session persistence is off (--no-save)\n"));
        return false;
      }
      const saved = session.store.list();
      if (saved.length === 0) {
        output.write(dim(`  no saved sessions in ${session.store.dir}\n`));
        return false;
      }
      output.write(dim(`  ${saved.length} session(s) in ${session.store.dir}\n\n`));
      for (const item of saved.slice(0, 10)) {
        const marker = item.id === session.current?.id ? green(" ← current") : "";
        output.write(`  ${bold(item.id)}${marker}\n`);
        output.write(
          dim(
            `    ${item.updatedAt} · ${item.messageCount} msgs · ${item.provider ?? "?"}/${item.model ?? "?"}\n`,
          ),
        );
        output.write(dim(`    ${item.preview}\n`));
      }
      return false;
    }

    case "/resume": {
      if (!session.store) {
        output.write(dim("  session persistence is off (--no-save)\n"));
        return false;
      }
      const id = rest[0];
      const target = id
        ? session.store.load(id)
        : session.store.latest({
            excludeId: session.current?.id,
            workspace: config.workspace,
          });
      if (!target) {
        output.write(red(`  no session ${id ? `"${id}"` : "to resume"}\n`));
        return false;
      }
      session.load(target);
      output.write(green(`  resumed ${target.id} · ${target.messages.length} messages\n`));
      return false;
    }

    case "/save": {
      if (!session.store) {
        output.write(dim("  session persistence is off (--no-save)\n"));
        return false;
      }
      if (agent.history.length === 0) {
        output.write(dim("  nothing to save yet\n"));
        return false;
      }
      session.persist();
      output.write(dim(`  saved ${session.current?.id ?? ""}\n`));
      return false;
    }

    case "/reset": {
      session.startNew();
      const id = session.current?.id;
      output.write(dim(`  history cleared${id ? ` · new session ${id}` : ""}\n`));
      return false;
    }

    case "/history":
      output.write(dim(`  ${agent.history.length} messages\n`));
      for (const message of agent.history) {
        const summary =
          message.role === "tool"
            ? `tool ${message.toolName} (${message.content.length} chars)`
            : message.role === "assistant"
              ? `${message.content.length} chars${message.toolCalls.length ? `, ${message.toolCalls.length} tool call(s)` : ""}`
              : `${message.content.length} chars`;
        output.write(dim(`    ${message.role.padEnd(9)} ${summary}\n`));
      }
      return false;

    case "/tools":
      for (const spec of agent.tools) {
        output.write(`  ${bold(spec.name)} — ${dim(spec.description)}\n`);
      }
      return false;

    case "/context": {
      const { tokens, source } = agent.contextTokens();
      const limit = config.contextWindow;
      const percent = limit > 0 ? (tokens / limit) * 100 : 0;
      const usage = agent.usage;
      output.write(
        dim(
          [
            `  window      ${limit > 0 ? formatTokens(limit) : "unknown"}`,
            `  window src  ${config.contextWindowSource}`,
            `  current     ${source === "estimate" ? "~" : ""}${formatCount(tokens)}${limit > 0 ? ` (${percent.toFixed(1)}%)` : ""}`,
            `  ${contextBar(percent)}`,
            `  source      ${source === "api" ? "provider usage" : "approx (chars/4)"}`,
            `  last call   ${usage.last ? `in ${formatCount(usage.last.inputTokens)} · out ${formatCount(usage.last.outputTokens)}` : "n/a"}`,
            `  session     in ${formatCount(usage.total.inputTokens)} · out ${formatCount(usage.total.outputTokens)}`,
          ].join("\n") + "\n",
        ),
      );
      return false;
    }

    case "/config":
      output.write(
        dim(
          [
            `  provider   ${config.provider}`,
            `  model      ${config.model}`,
            `  baseUrl    ${config.baseUrl}`,
            `  apiKey     ${config.apiKey ? "set" : "not set"}`,
            `  maxSteps   ${config.maxSteps}`,
            `  maxTokens  ${config.maxTokens ?? "(provider default)"}`,
            `  approve    ${config.approval}`,
            `  context    ${formatTokens(config.contextWindow)} tokens (${config.contextWindowSource})`,
            `  workspace  ${config.workspace}`,
          ].join("\n") + "\n",
        ),
      );
      return false;

    default:
      output.write(red(`  unknown command ${command} — try /help\n`));
      return false;
  }
}

// ---------------------------------------------------------------------------
// One-shot mode
// ---------------------------------------------------------------------------
async function runOnce(
  config: HarnessConfig,
  prompt: string,
  store: SessionStore | null,
  initial: Session | null,
): Promise<void> {
  const renderer = createRenderer();

  // One-shot mode has no REPL, so the approval prompt gets its own readline.
  const askOneShot = (question: string): Promise<string> =>
    new Promise((resolve) => {
      const rl = readline.createInterface({ input, output, terminal: input.isTTY === true });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    });

  const agent = new Agent({
    provider: createProvider(config),
    tools: buildToolRegistry(),
    systemPrompt: config.systemPrompt ?? buildSystemPrompt(config.workspace),
    toolContext: { workspace: config.workspace },
    maxSteps: config.maxSteps,
    onEvent: renderer.onEvent,
    onToolCall: createApprovalHook(config.approval, askOneShot),
  });

  if (initial) agent.restore(initial.messages);

  const abortController = new AbortController();
  process.once("SIGINT", () => abortController.abort());

  output.write(dim(`provider ${config.provider} · model ${config.model}\n\n`));

  try {
    await agent.send(prompt, abortController.signal);
  } catch {
    // The renderer already printed the error.
    process.exitCode = 1;
  }

  output.write(dim(`  ${contextLine(agent, config)}\n`));

  // One-shot runs only persist when the user explicitly resumed a session.
  if (store && initial) {
    initial.provider = config.provider;
    initial.model = config.model;
    initial.workspace = config.workspace;
    initial.messages = [...agent.history];

    try {
      store.save(initial);
      output.write(dim(`\nsession ${initial.id}\n`));
    } catch (err) {
      output.write(
        red(`\nsession save failed: ${err instanceof Error ? err.message : String(err)}\n`),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Saved sessions listing
// ---------------------------------------------------------------------------
function printSessions(store: SessionStore | null): void {
  if (!store) {
    output.write(red("session persistence is disabled (--no-save)\n"));
    return;
  }

  const sessions = store.list();
  if (sessions.length === 0) {
    output.write(dim(`no saved sessions in ${store.dir}\n`));
    return;
  }

  output.write(dim(`${sessions.length} session(s) in ${store.dir}\n\n`));
  for (const session of sessions.slice(0, 20)) {
    output.write(`${bold(session.id)}\n`);
    output.write(
      dim(
        `  ${session.updatedAt} · ${session.messageCount} msgs · ${session.provider ?? "?"}/${session.model ?? "?"}\n`,
      ),
    );
    output.write(dim(`  ${session.preview}\n\n`));
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  const { flags, positional } = parseArgs(process.argv.slice(2));

  if (flags.help) {
    printHelp();
    return;
  }

  const overrides: ConfigOverrides = {};
  const provider = stringFlag(flags.provider);
  if (provider) overrides.provider = provider as ProviderKind;
  if (flags.mock === true) overrides.provider = "mock";

  overrides.model = stringFlag(flags.model);
  overrides.baseUrl = stringFlag(flags["base-url"]);
  overrides.apiKey = stringFlag(flags["api-key"]);
  overrides.workspace = stringFlag(flags.workspace);
  overrides.systemPrompt = stringFlag(flags.system);
  overrides.maxSteps = numberFlag(flags["max-steps"]);
  overrides.maxTokens = numberFlag(flags["max-tokens"]);
  overrides.temperature = numberFlag(flags.temperature);
  overrides.contextWindow = numberFlag(flags["context-window"]);

  const approval = stringFlag(flags.approve)?.trim().toLowerCase();
  if (approval === "none" || approval === "bash" || approval === "all") {
    overrides.approval = approval;
  } else if (approval !== undefined) {
    throw new Error(`--approve must be one of: none, bash, all (got "${approval}")`);
  }

  // Drop undefined keys so they don't shadow env/file values.
  for (const key of Object.keys(overrides) as (keyof ConfigOverrides)[]) {
    if (overrides[key] === undefined) delete overrides[key];
  }

  const config = loadConfig(overrides);
  const store = flags["no-save"] === true ? null : new SessionStore();

  if (flags.sessions === true) {
    printSessions(store);
    return;
  }

  // Resolve the model's context window before showing the banner.
  await detectContextWindow(config);

  let initial: Session | null = null;

  if (flags.resume !== undefined) {
    if (!store) {
      output.write(red("  --resume needs session persistence; drop --no-save\n"));
      process.exitCode = 1;
      return;
    }
    const id = typeof flags.resume === "string" ? flags.resume : undefined;
    initial = id ? store.load(id) : store.latest({ workspace: config.workspace });
    if (!initial) {
      output.write(red(`  no session found${id ? ` with id "${id}"` : ""}\n`));
      process.exitCode = 1;
      return;
    }
  }

  const sessionFlag = stringFlag(flags.session);
  if (sessionFlag) {
    if (!store) {
      output.write(red("  --session needs session persistence; drop --no-save\n"));
      process.exitCode = 1;
      return;
    }
    const existing = store.load(sessionFlag);
    initial =
      existing ??
      store.create(
        { workspace: config.workspace, provider: config.provider, model: config.model },
        sessionFlag,
      );
  }

  if (positional.length > 0) {
    await runOnce(config, positional.join(" "), store, initial);
  } else {
    await runRepl(config, store, initial);
  }
}

main().catch((err) => {
  console.error(red(`fatal: ${err instanceof Error ? err.message : String(err)}`));
  process.exitCode = 1;
});
