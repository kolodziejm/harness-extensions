# Changelog

## Unreleased

- Add the installable Pi package entrypoint with profile-selected Codex pace, DeepSeek pricing, and GLM pricing status integrations extracted from `agent-orchestration`.
- Keep primary policy injection and subagent execution outside this package; Pi launchers use `--append-system-prompt`, and `@tintinweb/pi-subagents` remains the subagent provider.
- Load the optional Codex usage API lazily so package discovery cannot produce an unhandled rejection when `@narumitw/pi-usage` is unavailable.
