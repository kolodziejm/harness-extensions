# Harness Extensions

Optional runtime integrations for AI coding harnesses.

This repository contains executable, harness-specific extensions. Behavioral policy, role contracts, skills, and model profiles belong in the separate `agent-orchestration` repository. Keeping these concerns separate lets each harness use its native package mechanism and release runtime integrations independently from orchestration definitions.

## Pi package

The root is an installable Pi package. It provides a Pi subagent watchdog plus one profile-selected status extension:

| `AGENT_ORCHESTRATION_PROFILE` | Status |
| --- | --- |
| `hybrid` | DeepSeek weekday UTC price period |
| `deepseek` | DeepSeek weekday UTC price period |
| `openai` | Codex weekly usage pace via Pi's resolved provider authentication |
| `glm` | GLM-5.3 weekday UTC price period |

Unknown or missing profiles register no status handlers. The package does not modify authentication, settings, model routing, prompts, agents, or permissions.

### Subagent watchdog

The watchdog covers top-level agents created by `@tintinweb/pi-subagents` and enforces three independent limits:

- startup: 120 seconds from `subagents:started` to the first meaningful content or tool event;
- idle: 5 minutes since the last meaningful content, tool, retry, compaction, or completed-turn state change;
- total: 30 minutes from agent start regardless of continued progress.

On expiry it uses the supported `subagents:rpc:stop` path, which reaches the child's `AbortController` and Pi session abort. Only a successful, correlated stop acknowledgement produces a terminal `subagent-watchdog-blocked` notification. Its structured details include `status: "BLOCKED"`, the timeout reason, start/block timestamps, and the last meaningful progress timestamp and kind. A failed or missing acknowledgement instead produces one visible `subagent-watchdog-error` and retries cancellation every 30 seconds without falsely claiming that the child stopped. The underlying `pi-subagents` record remains `stopped`, because version 0.19.0 has no native `BLOCKED` state.

Each limit can be overridden in milliseconds. `0` disables that limit; invalid or empty values fall back to the default:

```bash
export PI_SUBAGENT_WATCHDOG_STARTUP_MS=120000
export PI_SUBAGENT_WATCHDOG_IDLE_MS=300000
export PI_SUBAGENT_WATCHDOG_TOTAL_MS=1800000
```

Nested agents and workflow-owned agents are not covered. `pi-subagents` intentionally hides their lifecycle records and rejects external stop requests, so covering them requires an upstream ownership-aware watchdog API rather than bypassing that boundary.

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
- Pi subagent execution remains provided by `@tintinweb/pi-subagents`; this package only observes its supported lifecycle/session surfaces and requests targeted cancellation through its supported RPC.
- Primary policy injection uses Pi's public `--append-system-prompt` CLI and is intentionally not an extension in this repository.
- General shell/Git access is provided by each harness's native tools; this package does not implement a custom Git reader.
