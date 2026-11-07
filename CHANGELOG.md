# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Nothing yet.

## [0.2.0] - 2026-11-07

### Added

- GitHub Actions CI: typecheck and tests on every push and pull request to
  `main` or `master`, on Node 23.
- CI badge in the README.
- MIT license (`LICENSE`), a license badge in the README, and a `license` field
  in `package.json`.
- Release workflow: pushing a `v*` tag runs the checks and publishes a GitHub
  release. The tag must match the version in `package.json`.
- This changelog.

### Fixed

- `npm test` now runs `node --test "test/**/*.test.ts"` instead of
  `node --test test/`. The directory form only works on Node 26+; on Node 23,
  24, and 25 it fails with `Cannot find module .../test` before a single test
  runs, so CI would have failed on the very first push.

## [0.1.0] - 2026-11-02

### Added

- The agent loop: model → tool calls → results → repeat, capped by `maxSteps`.
- Provider adapters for OpenAI-compatible servers, Anthropic, and an offline
  mock.
- Built-in tools: `read_file`, `write_file`, `edit_file`, `list_files`,
  `glob_files`, `grep_files`, and `bash`.
- Session persistence, an interactive REPL, and the `/connect` wizard.

[Unreleased]: https://github.com/rogeriolaa/my-harness/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/rogeriolaa/my-harness/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/rogeriolaa/my-harness/releases/tag/v0.1.0
