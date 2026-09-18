# Harness Extensions

Optional runtime integrations for AI coding harnesses.

This repository contains executable, harness-specific extensions. Behavioral policy, role contracts, skills, and model profiles belong in the separate `agent-orchestration` repository. Keeping these concerns separate lets each harness use its native package mechanism and release runtime integrations independently from orchestration definitions.

## Pi package

The root is an installable Pi package. It currently provides one profile-selected status extension:

| `AGENT_ORCHESTRATION_PROFILE` | Status |
| --- | --- |
| `hybrid` | DeepSeek weekday UTC price period |
| `deepseek` | DeepSeek weekday UTC price period |
| `openai` | Codex weekly usage pace via Pi's resolved provider authentication |
| `glm` | GLM-5.3 weekday UTC price period |

Unknown or missing profiles register no status handlers. The package does not modify authentication, settings, model routing, prompts, agents, or permissions.

### Installation

```bash
pi install git:github.com/kolodziejm/harness-extensions
```

For local development:

```bash
pi install /absolute/path/to/harness-extensions
```

Profile launchers supplied by `agent-orchestration` set `AGENT_ORCHESTRATION_PROFILE`. Install the package separately in each isolated Pi profile that should display status UI, then restart Pi.

The OpenAI pace integration reads resolved OpenAI Codex authentication through Pi's documented `ctx.modelRegistry` API and queries only the official `https://chatgpt.com` usage endpoint. It does not require `@narumitw/pi-usage`, read credential files, or modify authentication. Custom provider origins fail closed before any credential is sent. Missing, stale, invalid, or failed usage data is shown as `pace unavailable`; credentials and provider response bodies are never displayed or persisted.

## Development

```bash
npm test
```

The test suite uses Node's built-in test runner and has no third-party runtime dependencies.

## Boundaries

- This repository owns optional runtime/UI integrations.
- `agent-orchestration` owns declarative behavior, roles, skills, profiles, and per-harness rendering.
- Pi subagent execution remains provided by `@tintinweb/pi-subagents` and is not implemented here.
- Primary policy injection uses Pi's public `--append-system-prompt` CLI and is intentionally not an extension in this repository.
- General shell/Git access is provided by each harness's native tools; this package does not implement a custom Git reader.
