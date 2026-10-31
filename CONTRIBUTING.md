# Contributing

Thanks for helping with Make0 Brain. Bug reports, fixes, and new agent integrations for `init` are all welcome.

## Set up

You need Node.js 20 or newer.

```bash
git clone https://github.com/make0-official/brain-oss.git
cd brain-oss
npm install
npm test
```

`npm test` is the fast suite: it uses a hashing embedder, so it downloads no models and needs no API key. Two slower suites run on demand:

```bash
npm run test:models # real local models (downloads about 50 MB once)
npm run test:e2e    # build, then drive the stdio server
```

To try the viewer against a throwaway database:

```bash
npm run build:web
MAKE0_BRAIN_DB=/tmp/try.db npm run dev -- view --no-open
npm run dev:web     # hot reload at http://localhost:5173, API proxied to :4173
```

To point an agent at your checkout, set its MCP server to `npx tsx /path/to/brain-oss/src/cli.ts` in place of `npx -y @make0-ai/brain`, with `MAKE0_BRAIN_DB` in its `env` block so it does not touch your real brain. (`npm run dev` prints npm's banner to stdout, which breaks the stdio transport.)

## Pull requests

- Open an issue first for anything larger than a fix, so we can agree on the approach.
- Keep each pull request to one change, with tests for new behavior.
- Run `npm run typecheck && npm test` before pushing. CI runs the same checks on Linux and macOS.
- Match the code around you. Comments explain why, not what.
- Update the README when behavior a user can see changes, and add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md).
- The 7 MCP tools match the hosted Make0 Brain, so changes to their names, inputs, or outputs need a discussion first.
- Never commit real memories, `.env` files, or API keys, including in test fixtures.

Security problems go through [SECURITY.md](SECURITY.md), not a public issue or pull request.

## Releasing (maintainers)

1. Set the new version in `package.json`, and twice in `server.json` (`version` and `packages[0].version`).
2. Rename **Unreleased** in `CHANGELOG.md` to `[X.Y.Z] - YYYY-MM-DD`, start a new empty **Unreleased**, and update the compare links at the bottom.
3. Commit as `Release X.Y.Z: <summary>`, push to `main`, then tag and push the tag:

   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The [Release workflow](.github/workflows/release.yml) checks that the three versions and the changelog agree, runs the tests, publishes to npm with provenance, updates the MCP Registry, and creates the GitHub Release from the changelog section.

npm publishing uses [trusted publishing](https://docs.npmjs.com/trusted-publishers), so no npm token is stored in the repository. It has to be set up once on npmjs.com: package settings → Trusted publisher → GitHub Actions, organization `make0-official`, repository `brain-oss`, workflow `release.yml`.
