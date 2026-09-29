# Contributing

Use pnpm and keep the lockfile committed. Run `pnpm check`, `pnpm test`, `pnpm build`, and `pnpm audit:export` before proposing a change.

The main boundaries are:

- `config.ts` validates deployment configuration. Add deployment-specific choices here instead of embedding them in adapters.
- `discord.ts` and `whatsapp.ts` translate platform messages into tasks and deliver output.
- `engine.ts` owns task turns; `rpc.ts` owns the App Server connection.
- `store.ts` owns durable state. Changes must preserve recovery behavior and delivery deduplication.
- `runtime.ts` and `revisions.ts` bind tasks to source snapshots.
- `context-tools.ts` and `schedule-tools.ts` expose local MCP tools.

Use fake IDs, example domains, and temporary paths in tests. Never commit runtime state, real account IDs, credentials, local configuration, imported transcripts, or operator-specific prompts. Run a secret scanner over new commits as well as the working tree.

Keep platform-specific behavior in adapters and deployment choices in configuration. Tests should cover failure recovery and boundaries, especially cross-workspace lookups, duplicate delivery, queued steering, and stale runtime drafts.
