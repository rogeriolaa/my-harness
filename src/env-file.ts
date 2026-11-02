import fs from "node:fs";

export interface EnvWriteResult {
  path: string;
  updated: string[];
  added: string[];
}

/**
 * Update or append `KEY=value` lines in a .env file without disturbing the
 * rest of the file. Values are written verbatim; this is only used for
 * provider settings (URLs, model ids, keys), not arbitrary text.
 *
 * A key with an empty-string value is written as `KEY=` to clear it, which
 * avoids leaving a stale API key behind when you switch providers.
 */
export function upsertEnvFile(
  file: string,
  values: Record<string, string>,
): EnvWriteResult {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = existing.length > 0 ? existing.split(/\r?\n/) : [];
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const wanted = new Set(Object.keys(values));
  const seen = new Set<string>();
  const updated: string[] = [];
  const added: string[] = [];

  const next = lines.map((line) => {
    const match = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    if (!match) return line;

    const key = match[2];
    if (!wanted.has(key)) return line;

    seen.add(key);
    updated.push(key);
    return `${match[1]}${key}=${values[key] ?? ""}`;
  });

  for (const key of wanted) {
    if (!seen.has(key)) {
      next.push(`${key}=${values[key] ?? ""}`);
      added.push(key);
    }
  }

  fs.writeFileSync(file, `${next.join("\n")}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort.
  }

  return { path: file, updated, added };
}
