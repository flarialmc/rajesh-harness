# Security

This program runs an agent under the service user's OS identity. Restrict enabled Discord channels and the WhatsApp group to trusted users. Mentions are an invocation mechanism, not authorization. There is no per-user access-control list or hostile-tenant isolation.

The Codex sandbox setting controls Codex command execution. MCP tools, transport adapters, and the supervisor run outside that sandbox with the service user's permissions. Use a dedicated OS user or container with access only to the files and credentials you intend to expose. Do not run it as root.

Credentials belong in the configured secrets directory, not source code. Local `config.json` and `.local/` are ignored by Git. Source publication rejects tracked private data paths and known credential values, but automated scanning is not proof that arbitrary text is safe to publish.

Message history, tool events, attachments, schedules, skills, and explicit memories can contain private data. They are stored locally without application-level encryption. Redaction catches known credentials and common token formats; it cannot identify every secret or remove sensitive meaning from prose. Encrypt backups and restrict filesystem access.

Runtime source snapshots include private configuration. They must never be pushed to a public repository. The source Git repository excludes `config.json`; it is kept separately in local runtime snapshots so existing conversations can resume.

For a vulnerability, use GitHub's private vulnerability reporting if enabled. Do not include credentials, private chats, or customer data in public issues. Provide a synthetic reproduction.
