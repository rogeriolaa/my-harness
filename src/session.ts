import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Message } from "./types.ts";

const VERSION = 1;

export interface SessionMeta {
  workspace: string;
  provider?: string;
  model?: string;
}

export interface Session {
  version: number;
  id: string;
  createdAt: string;
  updatedAt: string;
  workspace: string;
  provider?: string;
  model?: string;
  messages: Message[];
}

export interface SessionSummary {
  id: string;
  updatedAt: string;
  messageCount: number;
  provider?: string;
  model?: string;
  workspace: string;
  preview: string;
  path: string;
}

export function defaultDataDir(): string {
  const override = process.env.HARNESS_DATA_DIR;
  if (override) return path.resolve(override);
  const base =
    process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "my-harness");
}

function newSessionId(): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .replace("T", "-");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

function isMessage(value: unknown): value is Message {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  switch (message.role) {
    case "system":
    case "user":
      return typeof message.content === "string";
    case "assistant":
      return (
        typeof message.content === "string" && Array.isArray(message.toolCalls)
      );
    case "tool":
      return (
        typeof message.content === "string" &&
        typeof message.toolCallId === "string" &&
        typeof message.toolName === "string"
      );
    default:
      return false;
  }
}

function parseSession(raw: string): Session | null {
  let data: any;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  if (typeof data.id !== "string" || !Array.isArray(data.messages)) return null;

  return {
    version: VERSION,
    id: data.id,
    createdAt:
      typeof data.createdAt === "string" ? data.createdAt : new Date().toISOString(),
    updatedAt:
      typeof data.updatedAt === "string" ? data.updatedAt : new Date().toISOString(),
    workspace: typeof data.workspace === "string" ? data.workspace : "",
    provider: typeof data.provider === "string" ? data.provider : undefined,
    model: typeof data.model === "string" ? data.model : undefined,
    messages: data.messages.filter(isMessage),
  };
}

function summarize(session: Session, file: string): SessionSummary {
  const firstUser = session.messages.find((m) => m.role === "user");
  const preview =
    firstUser && "content" in firstUser
      ? firstUser.content.replace(/\s+/g, " ").slice(0, 70)
      : "(empty)";

  return {
    id: session.id,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    provider: session.provider,
    model: session.model,
    workspace: session.workspace,
    preview,
    path: file,
  };
}

/**
 * Sessions are plain JSON files:
 *   ~/.local/share/my-harness/<id>.json   (or $HARNESS_DATA_DIR)
 *
 * One file per session, written atomically (tmp + rename) with mode 0600.
 */
export class SessionStore {
  readonly dir: string;

  constructor(dir: string = defaultDataDir()) {
    this.dir = dir;
  }

  private file(id: string): string {
    return path.join(this.dir, `${id}.json`);
  }

  create(meta: SessionMeta, id?: string): Session {
    const now = new Date().toISOString();
    return {
      version: VERSION,
      id: id ?? newSessionId(),
      createdAt: now,
      updatedAt: now,
      workspace: meta.workspace,
      provider: meta.provider,
      model: meta.model,
      messages: [],
    };
  }

  save(session: Session): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    session.updatedAt = new Date().toISOString();

    const target = this.file(session.id);
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(session, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // Best effort on filesystems without POSIX permissions.
    }
  }

  load(id: string): Session | null {
    const target = this.file(id);
    if (!fs.existsSync(target)) return null;
    try {
      return parseSession(fs.readFileSync(target, "utf8"));
    } catch {
      return null;
    }
  }

  list(): SessionSummary[] {
    if (!fs.existsSync(this.dir)) return [];
    const summaries: SessionSummary[] = [];

    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.dir, name);
      try {
        const session = parseSession(fs.readFileSync(file, "utf8"));
        if (session) summaries.push(summarize(session, file));
      } catch {
        // Skip unreadable/corrupt files rather than failing the listing.
      }
    }

    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  latest(options: { excludeId?: string; workspace?: string } = {}): Session | null {
    for (const summary of this.list()) {
      if (options.excludeId && summary.id === options.excludeId) continue;
      if (options.workspace && summary.workspace && summary.workspace !== options.workspace) {
        continue;
      }
      const session = this.load(summary.id);
      if (session) return session;
    }
    return null;
  }

  delete(id: string): boolean {
    const target = this.file(id);
    if (!fs.existsSync(target)) return false;
    fs.unlinkSync(target);
    return true;
  }
}
