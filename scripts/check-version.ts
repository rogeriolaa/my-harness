/**
 * Check that package.json's version is valid semver.
 *
 * Run with:  npm run version:check
 *
 * The release workflow runs this before publishing: a tag that disagrees with
 * package.json means the version was bumped without committing it (or the
 * other way around), and the release would advertise the wrong version.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

// The official semver.org recommended regular expression.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const pkgPath = path.resolve(import.meta.dirname, "..", "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const version = String(pkg.version ?? "");

if (!SEMVER.test(version)) {
  console.error(`not a valid semver version: "${version}"`);
  process.exit(1);
}

console.log(`semver ok: ${version}`);
