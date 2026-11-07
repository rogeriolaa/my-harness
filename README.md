# my-harness

[![CI](https://github.com/rogeriolaa/my-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/rogeriolaa/my-harness/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A tiny, readable LLM agent harness in ~3,300 lines of TypeScript.

The goal is *understanding*, not features. You can read the whole thing in one
sitting, watch the agent loop execute, and swap the model provider for any
OpenAI-compatible server or Anthropic.

No runtime dependencies. Node runs the TypeScript directly.

```
node src/cli.ts "list the files and explain what this project does"
```

---

## Quick start

Requires **Node 23.6+** (for native TypeScript type-stripping).

```bash
# 1. With no configuration at all, the harness uses an offline mock provider.
#    Great for watching the loop without an API key.
npm start

# 2. Same thing, one-shot:
node src/cli.ts --mock "take a look around"
```

You'll see the whole cycle:

```
assistant › Let me look at the workspace first.
  ⚙ list_files({"path":".","depth":1})
  ✓ list_files · 1ms · 170 chars

assistant › Tool `list_files` returned: …
```

Run the test suite and the type checker:

```bash
npm test        # 25 tests, no dependencies
npm run typecheck
```

## Connect a real model

Everything is configurable. Copy `.env.example` to `.env` and fill in three
things, or use `harness.config.json`, environment variables, or CLI flags.

```bash
cp .env.example .env
# edit HARNESS_PROVIDER / HARNESS_MODEL / HARNESS_BASE_URL / HARNESS_API_KEY
```

### OpenAI

```bash
HARNESS_PROVIDER=openai \
HARNESS_MODEL=gpt-4o-mini \
HARNESS_API_KEY=sk-... \
node src/cli.ts "summarize this repo"
```

### Anthropic

```bash
HARNESS_PROVIDER=anthropic \
HARNESS_MODEL=claude-sonnet-4-20250514 \
HARNESS_API_KEY=sk-ant-... \
node src/cli.ts "summarize this repo"
```

### Any OpenAI-compatible server (Ollama, LM Studio, vLLM, OpenRouter, Groq…)

```bash
# Ollama, fully local, no key:
HARNESS_PROVIDER=openai \
HARNESS_BASE_URL=http://localhost:11434/v1 \
HARNESS_MODEL=qwen2.5-coder \
node src/cli.ts "explain src/agent.ts"
```

Because the OpenAI-compatible adapter only needs `POST /chat/completions`,
almost every inference server or gateway works by changing `HARNESS_BASE_URL`.

Or configure it from inside the REPL, without editing a file first:

```bash
node src/cli.ts
you › /connect --save
```

`--save` writes the provider, base URL, model, key, and context window to
`.env` automatically. Without it, the wizard asks before touching the file.

### Precedence

```
CLI flags  >  environment / .env  >  harness.config.json  >  defaults
```

You can also configure everything live from the REPL with `/connect` — it
swaps the provider without losing the conversation history.

## Interactive mode

Run with no prompt to get a REPL:

```bash
npm start
```

| Command     | What it does                                    |
| ----------- | ----------------------------------------------- |
| `/help`     | Command list                                    |
| `/connect`  | Configure the model provider                    |
| `/model`    | Switch model, keeping provider and key          |
| `/context`  | Show context window and token usage             |
| `/session`  | Show the current session id and file            |
| `/sessions` | List saved sessions                             |
| `/resume`   | Resume the latest session (or `/resume <id>`)   |
| `/save`     | Write the current session to disk now           |
| `/reset`    | Clear history and start a new session           |
| `/history`  | Show the message count                          |
| `/tools`    | List tools the model can call                   |
| `/config`   | Show resolved configuration                     |
| `/exit`     | Quit                                            |

`/connect` runs a short wizard. It auto-detects the context window for the
model you enter. With `--save` it writes the result to `.env` without asking:

```
you › /connect --save
  current: mock · mock-1
  provider (openai/anthropic/mock) [mock]: openai
  base url [https://api.openai.com/v1]: http://localhost:11434/v1
  model [gpt-4o-mini]: qwen2.5-coder
  api key (not set):
  context window [32768]:
  connected
    provider  openai
    base url  http://localhost:11434/v1
    ...
  saved to /path/to/.env
```

Pass the provider as an argument to skip the first question:
`/connect anthropic`. Without `--save` the wizard prints a `save these settings
to .env? (y/N)` prompt (default **No**) and otherwise just shows the lines to
add yourself. The `.env` file is written with mode `600` because it contains
your API key.

Ctrl+C aborts the current turn; Ctrl+C again at the prompt quits.

## Tool approval

The harness can ask before it runs a tool. Nothing is approved by default —
the mode is opt-in:

```bash
node src/cli.ts --approve bash "run the tests"   # confirm each shell command
node src/cli.ts --approve all "clean this up"     # confirm every tool
```

Or set it in `.env`:

```
HARNESS_APPROVE=bash
```

| Mode   | Behavior                                                |
| ------ | ------------------------------------------------------- |
| `none` | Run everything (default)                                |
| `bash` | Ask before running `bash`                               |
| `all`  | Ask before running any tool                             |

When a tool needs approval, the harness shows the call and waits:

```
  ⚙ bash({"command":"npm test"})
  allow bash({"command":"npm test"})? [y/N]
```

Anything other than `y`/`yes` denies it. The denial is reported back to the
model as a tool error, so it can adjust instead of retrying blindly:

```
  ⊘ bash · denied by the user

assistant › Tool `bash` failed:
The user denied the call to `bash`. Do not retry it; ask what to do instead.
```

In the REPL the prompt reuses the same input queue as the main loop, so it
doesn't fight you for stdin. In one-shot mode it opens its own prompt.

## Sessions

Conversation history is saved automatically after every turn. Sessions are
plain JSON files, one per session:

```
~/.local/share/my-harness/<id>.json     # or $HARNESS_DATA_DIR
```

They are written atomically and with mode `600`. On startup the harness creates
a new session unless you pass `--resume` or `--session`; `--resume` picks up the
most recent one, and `/sessions` shows what's on disk.

```bash
node src/cli.ts --resume             # continue the latest session
node src/cli.ts --resume 20261101-180401-5ce344
node src/cli.ts --session my-branch  # use/create a named session
node src/cli.ts --sessions           # list and exit
node src/cli.ts --no-save            # keep everything in memory
```

Inside the REPL, `/session` shows the current file, `/save` forces a write, and
`/resume` loads the latest session without restarting. `/reset` starts a fresh
session, and `/sessions` gives you something like:

```
  1 session(s) in /home/you/.local/share/my-harness

  20261101-181001-7b430e ← current
    2026-11-01T18:10:01.443Z · 4 msgs · openai/gpt-4o
    refactor the config loader
```

## Context window and token usage

After each turn the harness prints a one-line usage summary:

```
  context 1.9k / 128.0k (1.5%)
```

`/context` shows the details, including which model metadata the limit came
from:

```
  window      128.0k
  window src  known
  current     1,905 (1.5%)
  ░░░░░░░░░░░░░░░░░░
  source      provider usage
  last call   in 1,879 · out 26
  session     in 4,944 · out 147
```

The window is resolved in this order:

1. **Explicit config** — `--context-window`, `HARNESS_CONTEXT_WINDOW`, or
   `contextWindow` in `harness.config.json`. Always wins.
2. **Provider metadata** — the `context_length` / `context_window` /
   `max_model_len` field from `GET /models`, when the server reports it.
3. **Known-model table** — a small pattern table in `src/context-window.ts`
   covering common Claude, GPT, Llama, Qwen, DeepSeek, and similar names.
4. **Provider default** — the fallback in `src/config.ts`.

Detection runs at startup, after `/model`, and after `/connect`, so switching
models updates the limit. For example, `/model gpt-4o` prints the new window
immediately and the next `/context` uses it. Current usage comes from the
provider's reported token counts when available, and falls back to a
`chars / 4` estimate (shown with a leading `~`) before the first response.

This number is **display-only**. The harness does not truncate or reject a
request when you exceed the window — it just makes the problem visible.

---

## How it works

### The loop

This is the entire idea. Everything else is plumbing.

```
             ┌─────────────────────────────────────────┐
 user text → │ append to messages                      │
             │        ↓                                │
             │ provider.chat(messages, tools)          │
             │        ↓                                │
             │ text? print it                          │
             │ tool calls? approve → execute → append ─┼─┐
             │ no tool calls? done                     │ │
             └─────────────────────────────────────────┘ │
                        ↑                                │
                        └────────────────────────────────┘
```

In code (`src/agent.ts`):

```ts
for (let step = 1; step <= maxSteps; step++) {
  let text = "";
  const toolCalls = [];

  for await (const event of provider.chat({ system, messages, tools })) {
    if (event.type === "text") text += event.text;
    if (event.type === "tool_call") toolCalls.push(event.toolCall);
  }

  messages.push({ role: "assistant", content: text, toolCalls });

  if (toolCalls.length === 0) return text;          // model is done

  for (const call of toolCalls) {
    const result = await tools.execute(call.name, call.arguments, ctx);
    messages.push({ role: "tool", ...result, toolCallId: call.id });
  }
}
```

Key properties that make it work:

- **The history is the state.** Every tool result is appended as a `tool`
  message, so the next request contains everything the model needs.
- **Tool calls pause the model.** The model returns a request to run a tool;
  the harness runs it and sends the result back. The model never executes code.
- **`maxSteps` is the safety valve.** Without it, a confused model can loop
  forever.

Two details the real implementation adds:

- **Approvals come first.** When the approval hook is configured, every call
  is checked before anything runs — one at a time, since a prompt can't be
  interleaved.
- **Approved calls run concurrently.** The results are still appended in the
  order the model requested them, because providers expect tool results to
  line up with their tool calls.

### The provider seam

`src/types.ts` defines one normalized `Message` shape and one `Provider`
interface:

```ts
interface Provider {
  readonly name: string;
  readonly model: string;
  chat(req: ChatRequest): AsyncGenerator<LLMEvent>;
}
```

The agent loop never sees provider-specific JSON. Each adapter converts:

- **OpenAI-compatible** (`src/providers/openai.ts`): `tool_calls` on assistant
  messages, `role: "tool"` results.
- **Anthropic** (`src/providers/anthropic.ts`): top-level `system`, `tool_use`
  content blocks, tool results sent as a `user` message.
- **Mock** (`src/providers/mock.ts`): scripted, no network — for observing the loop.

Both real adapters stream SSE and accumulate partial tool-call JSON.

### The tools

`src/tools/` — each tool is a JSON-schema `spec` the model sees, plus a `run`
function the harness calls:

| Tool         | Purpose                                              |
| ------------ | ---------------------------------------------------- |
| `read_file`  | Read a file with line numbers (offset/limit)         |
| `write_file` | Create or overwrite a file                           |
| `edit_file`  | Exact-string replacement (unique unless `replace_all`) |
| `list_files` | Recursive listing, skipping `node_modules`/`.git`    |
| `glob_files` | Find files by glob (`**/*.ts`)                       |
| `grep_files` | Regex search across file contents                    |
| `bash`       | Run a shell command with a timeout                   |

File tools are confined to `HARNESS_WORKSPACE`. Tool output is capped at 24k
characters so one huge command can't blow up the context window.

### File map

```
src/
├── cli.ts                 entry point: args, REPL, rendering, context display
├── agent.ts               THE LOOP  ← start reading here
├── config.ts              env / .env / config file resolution
├── connect.ts             the /connect wizard
├── context-window.ts      model-aware context limit detection
├── env-file.ts            safe .env updates
├── session.ts             session persistence (JSON files)
├── system-prompt.ts       the default system prompt
├── types.ts               normalized messages + Provider interface
├── providers/
│   ├── index.ts           provider factory
│   ├── openai.ts          OpenAI-compatible streaming adapter
│   ├── anthropic.ts       Anthropic streaming adapter
│   └── mock.ts            scripted offline adapter
└── tools/
    ├── index.ts           default toolset
    ├── registry.ts        tool registry + dispatch + output cap
    ├── filesystem.ts      file / glob / grep tools
    └── shell.ts           bash tool

test/
└── harness.test.ts        loop, approval hook, file tools, sessions
```

---

## Releases

Versions follow [semver](https://semver.org/). The changelog lives in
[CHANGELOG.md](CHANGELOG.md), in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

To cut a release:

```bash
# 1. Bump the version in package.json and add a CHANGELOG entry.
npm version 0.2.0 --no-git-tag-version

# 2. Commit, tag, push. The tag is what triggers the release.
git commit -am "chore: release v0.2.0"
git tag v0.2.0
git push origin main --follow-tags
```

Pushing a `v*` tag runs the checks and publishes a GitHub release. The workflow
fails if the tag doesn't match the version in `package.json`, so the two can't
drift apart.

`npm run version:check` validates the version on its own.

## Extend it

### Add a tool

Tools are just an object. Register it in `src/tools/index.ts`:

```ts
export const wordCountTool: Tool = {
  spec: {
    name: "word_count",
    description: "Count words in a file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  async run(args, ctx) {
    const text = await readFile(String(args.path), "utf8");
    return { content: `${text.split(/\s+/).length} words` };
  },
};
```

### Add a provider

Implement `Provider` and add a case in `src/providers/index.ts`. Your `chat`
must yield `text`, `tool_call`, `usage`, and a final `finish` event. Use
`openai.ts` as the template — it's about 100 lines of streaming parsing.

### Make streaming-to-the-tool (`bash`) safer

`bash` runs with your user's rights. The approval gate (`--approve bash`) is
a speed bump, not a security boundary — the real fix is an OS-level sandbox.
A good exercise: write your own `onToolCall` hook that inspects the command
and rejects anything matching a pattern you don't trust.

---

## Known limitations (on purpose)

- No context compaction. Sessions are saved, but history only grows; a real
  harness summarizes old turns or drops stale tool output.
- The context window is display-only. Requests are not truncated or rejected
  when they exceed it.
- Context detection is best-effort. Some gateways don't expose `/models`
  metadata, and the known-model table is heuristic — set the value explicitly
  when it matters.
- Path containment is a string check, not a sandbox. Symlinks can escape.
- Approval is opt-in and off by default. `--approve bash` gates the shell
  tool; there is still no OS-level isolation.
- No retries/backoff on rate limits.

## Exercises

1. **Trace a turn.** Run `node src/cli.ts --mock "hi"` and print `agent.history`
   after it finishes. Which message caused the second model call?
2. **Break the loop.** Set `maxSteps` to 1 and watch it fail gracefully.
3. **Add `read_file` paging.** Make the agent read a 5,000-line file in chunks.
4. **Add cost tracking.** Extend `/context` to price `agent.usage` using
   per-model input/output rates.
5. **Add session search.** Make `--sessions <query>` filter saved sessions by
   preview or workspace.
6. **Add compaction.** When `messages` exceeds N, ask the model to summarize
   the oldest turns into one `user` message.
7. **Write a provider** for a local server that isn't OpenAI-shaped.
8. **Sandbox the file tools.** Resolve symlinks with `fs.realpath` before the
   containment check, so a link can't point outside the workspace.
