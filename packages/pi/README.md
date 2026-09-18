# Pi extensions

`index.js` always registers the top-level subagent watchdog, then selects at most one status implementation from `AGENT_ORCHESTRATION_PROFILE`.

The individual modules keep pure formatting/schedule functions exported for deterministic tests. The Codex pace module resolves authentication read-only through Pi's documented `ctx.modelRegistry` API, rejects non-official origins before network access, and queries only the fixed ChatGPT usage endpoint. Runtime failures degrade to an unavailable or cleared status and must not expose or persist credentials or provider response bodies.

The watchdog listens for `pi-subagents` top-level lifecycle events, attaches to each child session after startup, and treats streamed content, tool activity, retries, compaction, and completed turns as meaningful progress. Its startup, idle, and total deadlines are independently configurable through `PI_SUBAGENT_WATCHDOG_{STARTUP,IDLE,TOTAL}_MS`. Expiry requests real child cancellation through `subagents:rpc:stop`; a successful acknowledgement emits structured terminal `BLOCKED` evidence. Nested and workflow-owned children remain outside this supported surface.
