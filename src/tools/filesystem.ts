import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext } from "./registry.ts";

/** Directories we never walk into. Keep this small and obvious. */
const IGNORED = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  "target",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".idea",
  ".DS_Store",
]);

/**
 * Resolve a user-supplied path and make sure it stays inside the workspace.
 * This is a guardrail, not a security sandbox (symlinks can still escape).
 */
function resolveInside(ctx: ToolContext, input: unknown): string {
  const raw = typeof input === "string" && input.trim() ? input : ".";
  const abs = path.resolve(ctx.workspace, raw);
  const rel = path.relative(ctx.workspace, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path "${raw}" is outside the workspace (${ctx.workspace}).`);
  }
  return abs;
}

function relative(ctx: ToolContext, abs: string): string {
  return path.relative(ctx.workspace, abs) || ".";
}

async function walk(
  dir: string,
  base: string,
  maxDepth: number,
  depth = 0,
): Promise<string[]> {
  if (depth > maxDepth) return [];

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full) || ".";

    if (entry.isDirectory()) {
      out.push(`${rel}/`);
      if (depth < maxDepth) {
        out.push(...(await walk(full, base, maxDepth, depth + 1)));
      }
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

async function walkFiles(dir: string, base: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: string[] = [];
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walkFiles(full, base)));
    } else if (entry.isFile()) {
      out.push(path.relative(base, full));
    }
  }
  return out;
}

/** Convert a glob like `src/**\/*.ts` into a RegExp over forward-slash paths. */
function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          source += "(?:.*/)?";
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

/**
 * Turn a model-supplied pattern into a RegExp.
 *
 * Models often send `/foo/i` (slash-delimited with flags) instead of a bare
 * `foo`. That form is accepted here. The `g` and `y` flags are always
 * dropped: `RegExp.test` is stateful with them — `lastIndex` carries over
 * between calls — which would silently skip every other matching line.
 */
function parseSearchPattern(raw: string): RegExp {
  const trimmed = raw.trim();
  const delimited = /^\/(.*)\/([a-z]*)$/i.exec(trimmed);
  const source = delimited ? delimited[1] : trimmed;
  const flags = (delimited ? delimited[2] : "").replace(/[gy]/g, "");
  return new RegExp(source, flags);
}

/**
 * Coerce a model-supplied number into an integer inside `[min, max]`.
 *
 * The old `Math.trunc(Number(x)) || fallback` idiom had a bug: `0` is falsy,
 * so an explicit `limit: 0` silently became the fallback (2000 lines)
 * instead of the intended minimum.
 */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.trunc(Number(value ?? fallback));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/**
 * Count non-overlapping occurrences of `needle` in `haystack`.
 *
 * `split().length - 1` counts the same way, but it also drops the empty
 * string edge case, so this is explicit about the intent: the count has to
 * agree with the `indexOf`-based replacement that follows it.
 */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

export const readFileTool: Tool = {
  spec: {
    name: "read_file",
    description:
      "Read a text file from the workspace. Returns the contents with line numbers. Use offset/limit for large files.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace." },
        offset: { type: "number", description: "First line to read (1-based). Default 1." },
        limit: { type: "number", description: "Maximum number of lines. Default 2000." },
      },
      required: ["path"],
    },
  },
  async run(args, ctx) {
    const abs = resolveInside(ctx, args.path);
    const raw = await fs.readFile(abs, "utf8");
    // A trailing newline produces a final empty element; drop it so the line
    // count matches what an editor shows.
    const lines = raw.endsWith("\n") ? raw.slice(0, -1).split("\n") : raw.split("\n");

    const offset = clampInt(args.offset, 1, 1, lines.length || 1);
    const limit = clampInt(args.limit, 2000, 1, 2000);
    const slice = lines.slice(offset - 1, offset - 1 + limit);

    if (slice.length === 0) {
      return { content: `(no lines at offset ${offset}; file has ${lines.length} lines)` };
    }

    const width = String(offset + slice.length - 1).length;
    const numbered = slice
      .map((line, i) => `${String(offset + i).padStart(width)} | ${line}`)
      .join("\n");

    const consumed = offset - 1 + slice.length;
    const more =
      consumed < lines.length
        ? `\n\n[... ${lines.length - consumed} more lines; use offset=${consumed + 1} ...]`
        : "";

    return { content: `${numbered}${more}` };
  },
};

export const writeFileTool: Tool = {
  spec: {
    name: "write_file",
    description:
      "Create or overwrite a file with the given content. Parent directories are created automatically.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace." },
        content: { type: "string", description: "The full file content." },
      },
      required: ["path", "content"],
    },
  },
  async run(args, ctx) {
    const abs = resolveInside(ctx, args.path);
    const content = typeof args.content === "string" ? args.content : "";
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
    return {
      content: `Wrote ${content.length} characters to ${relative(ctx, abs)}`,
    };
  },
};

export const editFileTool: Tool = {
  spec: {
    name: "edit_file",
    description:
      "Replace an exact string in a file. old_string must appear exactly once unless replace_all is true. Read the file first.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path relative to the workspace." },
        old_string: { type: "string", description: "The exact text to replace." },
        new_string: { type: "string", description: "The replacement text." },
        replace_all: { type: "boolean", description: "Replace every occurrence. Default false." },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
  async run(args, ctx) {
    const abs = resolveInside(ctx, args.path);
    const oldString = typeof args.old_string === "string" ? args.old_string : "";
    const newString = typeof args.new_string === "string" ? args.new_string : "";

    if (!oldString) throw new Error("old_string must not be empty");

    const raw = await fs.readFile(abs, "utf8");
    const occurrences = countOccurrences(raw, oldString);

    if (occurrences === 0) {
      throw new Error("old_string was not found in the file. Read it again and match exactly.");
    }

    const replaceAll = args.replace_all === true;
    if (occurrences > 1 && !replaceAll) {
      throw new Error(
        `old_string occurs ${occurrences} times. Add more context to make it unique, or set replace_all=true.`,
      );
    }

    // split/join avoids `$&`-style replacement surprises. Only the first
    // occurrence is replaced when replace_all is false — the same one the
    // occurrence count was computed against.
    const updated = replaceAll
      ? raw.split(oldString).join(newString)
      : raw.slice(0, raw.indexOf(oldString)) +
        newString +
        raw.slice(raw.indexOf(oldString) + oldString.length);

    await fs.writeFile(abs, updated, "utf8");
    return {
      content: `Replaced ${replaceAll ? occurrences : 1} occurrence(s) in ${relative(ctx, abs)}`,
    };
  },
};

export const listFilesTool: Tool = {
  spec: {
    name: "list_files",
    description:
      "List files and directories under a path. Recursive up to `depth`, skipping node_modules and .git.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory relative to the workspace. Default '.'." },
        depth: { type: "number", description: "Maximum recursion depth. Default 2." },
      },
    },
  },
  async run(args, ctx) {
    const abs = resolveInside(ctx, args.path);
    const depth = clampInt(args.depth, 2, 0, 100);
    const entries = await walk(abs, ctx.workspace, depth);
    if (entries.length === 0) return { content: "(empty)" };
    return { content: entries.sort().join("\n") };
  },
};

export const globFilesTool: Tool = {
  spec: {
    name: "glob_files",
    description:
      "Find files by glob pattern, for example '**/*.ts' or 'src/**/*.md'. Returns paths relative to the workspace.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern." },
        path: { type: "string", description: "Directory to search from. Default '.'." },
      },
      required: ["pattern"],
    },
  },
  async run(args, ctx) {
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    if (!pattern) throw new Error("pattern is required");

    const root = resolveInside(ctx, args.path);
    const matcher = globToRegExp(toPosix(pattern));
    const files = await walkFiles(root, ctx.workspace);
    const matches = files
      .map(toPosix)
      .filter((file) => matcher.test(file))
      .sort();

    if (matches.length === 0) {
      return { content: `No files matched "${pattern}".` };
    }
    return { content: matches.join("\n") };
  },
};

export const grepFilesTool: Tool = {
  spec: {
    name: "grep_files",
    description:
      "Search file contents with a regular expression. Returns `path:line: text` matches. Useful for finding symbols.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression." },
        path: { type: "string", description: "Directory to search from. Default '.'." },
        glob: { type: "string", description: "Optional glob to limit files, e.g. '**/*.ts'." },
        max_results: { type: "number", description: "Maximum matches. Default 100." },
      },
      required: ["pattern"],
    },
  },
  async run(args, ctx) {
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    if (!pattern) throw new Error("pattern is required");

    // Throws on invalid regex; the registry turns that into a tool error.
    const matcher = parseSearchPattern(pattern);
    const root = resolveInside(ctx, args.path);
    const maxResults = clampInt(args.max_results, 100, 1, 10_000);
    const fileMatcher =
      typeof args.glob === "string" && args.glob ? globToRegExp(toPosix(args.glob)) : null;

    const files = await walkFiles(root, ctx.workspace);
    const results: string[] = [];

    for (const file of files) {
      if (results.length >= maxResults) break;
      const rel = toPosix(file);
      if (fileMatcher && !fileMatcher.test(rel)) continue;

      const abs = path.join(ctx.workspace, file);
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue;
      }
      if (stat.size > 1_000_000) continue;

      let text: string;
      try {
        text = await fs.readFile(abs, "utf8");
      } catch {
        continue;
      }
      if (text.includes("\u0000")) continue; // looks binary

      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (matcher.test(lines[i])) {
          results.push(`${rel}:${i + 1}: ${lines[i].trimEnd()}`);
          if (results.length >= maxResults) break;
        }
      }
    }

    if (results.length === 0) {
      return { content: `No matches for /${pattern}/.` };
    }
    return { content: results.join("\n") };
  },
};
