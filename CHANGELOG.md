# Changelog

## Unreleased

- Add a top-level Pi subagent watchdog with configurable startup, idle, and total-runtime limits, targeted cancellation through `subagents:rpc:stop`, and terminal `BLOCKED` evidence including the last meaningful progress timestamp.
- Fail closed when cancellation is not acknowledged or run identity changes, suppress only watchdog-owned native stopped notifications, and document the upstream limitation for nested and workflow-owned children.
- Add the installable Pi package entrypoint with profile-selected Codex pace, DeepSeek pricing, and GLM pricing status integrations extracted from `agent-orchestration`.
- Keep primary policy injection and subagent execution outside this package; Pi launchers use `--append-system-prompt`, and `@tintinweb/pi-subagents` remains the subagent provider.
- Query Codex weekly pace through Pi's documented resolved-auth API and the fixed official ChatGPT usage endpoint. Reject custom origins before network access, bound and redact failures, and avoid credential-file access, authentication mutation, and the former runtime import of `@narumitw/pi-usage` TypeScript.
