# Changelog

All notable changes to Make0 Brain. Versions follow [semver](https://semver.org): patch releases are fixes, minor releases can add features and database migrations. Each version is on [npm](https://www.npmjs.com/package/@make0-ai/brain) and in [GitHub Releases](https://github.com/make0-official/brain-oss/releases).

## [Unreleased]

- **Requires Node.js 22 or newer.** `better-sqlite3` 13 needs Node 22, so Make0 Brain crashed on Node 20 even though `engines` allowed it. `engines`, the README, and CI now say Node 22. Node 20 reached end of life in April 2026.
- README: npm, license, Node, CI, mcprush, and Glama badges; one-click install buttons for Cursor and VS Code.
- CI runs the typecheck, tests, and build on Linux and macOS with Node 22 and 24.
- Releases publish from GitHub Actions with npm provenance, and update the MCP Registry and GitHub Releases from a tag push.
- `SECURITY.md`, `CONTRIBUTING.md`, this changelog, and issue templates.

## [0.2.3] - 2026-10-30

- `init` detects Hermes Agent (`~/.hermes/config.yaml`, `mcp_servers`) and OpenClaw (`openclaw mcp set`, or `mcp.servers` in `openclaw.json`).
- The viewer shows Hermes Agent and OpenClaw logos.
- README: mcprush badge.

## [0.2.2] - 2026-10-29

- **Security:** the viewer answers only its own Host (`127.0.0.1:<port>` or `localhost:<port>`) and refuses writes from other origins or without a JSON content type. Before this, any page open in the browser could send simple cross-origin writes, and DNS rebinding could read memories.
- README: a "Verify it works" walkthrough, a Privacy and security section, and Backups, upgrades, and support.

## [0.2.1] - 2026-10-29

- The viewer's search box runs the same hybrid retrieval as the MCP server (semantic + BM25, rerank, graph expansion) instead of filtering the list in the browser.
- BM25 matches word prefixes, so a partly typed word still finds the memory.
- README: local search takes about 80ms per query on an Apple M2 Pro.

## [0.2.0] - 2026-10-29

- **Brains:** create, edit, and delete custom brains alongside personal. `brains` and `agents` control which app sees which brain, and `import`, `export`, `view`, and `stats` take `--brain`.
- **Usage:** per-app, per-brain daily reads, writes, and token estimates, on the viewer home page and in a Brain activity chart.
- The viewer is rebuilt in React, with a board and a 3D memory graph.
- Listed in the official MCP Registry and on Glama.

## [0.1.2] - 2026-10-28

- README: how-it-works illustration.
- `init` asks which agents to configure when more than one is installed.

## [0.1.1] - 2026-10-27

- `init` downloads the embedding model and the reranker up front, with a progress line, so the first search never waits on a download. It retries transient failures and never fails on a download error. `--no-models` skips the step.

## [0.1.0] - 2026-10-27

- First release: one versioned memory for Claude Code, Claude Desktop, Cursor, Codex, Windsurf, VS Code, and Gemini CLI, served over MCP from a local SQLite file.
- Hybrid search (MiniLM + BM25 + cross-encoder, two-hop graph expansion), per-write versions with writer attribution, archive and restore.
- `init` for MCP clients; import from Markdown, Obsidian, and agent rule files; Markdown and JSON export; a local viewer; optional bring-your-own-key LLM features.

[Unreleased]: https://github.com/make0-official/brain-oss/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/make0-official/brain-oss/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/make0-official/brain-oss/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/make0-official/brain-oss/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/make0-official/brain-oss/compare/v0.1.0...v0.2.0
[0.1.2]: https://www.npmjs.com/package/@make0-ai/brain/v/0.1.2
[0.1.1]: https://www.npmjs.com/package/@make0-ai/brain/v/0.1.1
[0.1.0]: https://github.com/make0-official/brain-oss/releases/tag/v0.1.0
