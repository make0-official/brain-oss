# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue.

Use **[Report a vulnerability](https://github.com/make0-official/brain-oss/security/advisories/new)** on this repository's Security tab. Only the maintainers can see the report. Include what you found, how to reproduce it, and which version you tested (`npx @make0-ai/brain --version`). Do not include real private memories or API keys; a made-up example is enough.

We aim to reply within 3 working days, and to ship a fix for a confirmed issue in a patch release as soon as we can. We will credit you in the release notes unless you would rather stay anonymous.

## Supported versions

Make0 Brain is pre-1.0. Fixes go into the latest release only. Agents run the server through `npx`, so they pick up a fixed release the next time they start.

## What counts

Make0 Brain is a local server that keeps memories in a SQLite file and serves them to the agents you connect. Examples of problems we want to hear about:

- Another website or another machine reading or changing memories, for example through the `view` server.
- Memory content, queries, or the API key leaving the machine in a way the [README's privacy table](README.md#what-leaves-your-machine) does not describe.
- An agent permanently deleting memories, or reading a brain it was not granted.
- `init` or `import` writing outside the files the README says they touch.

Out of scope: an agent being talked into saving a misleading memory (see [Bad or malicious memories](README.md#bad-or-malicious-memories)), other programs running as your own user account, and what an agent's own model provider does with the memories it receives.
