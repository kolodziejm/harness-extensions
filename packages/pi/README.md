# Pi extensions

`index.js` selects exactly one status implementation from `AGENT_ORCHESTRATION_PROFILE` and registers it with Pi.

The individual modules keep pure formatting/schedule functions exported for deterministic tests. The Codex pace module resolves authentication read-only through Pi's documented `ctx.modelRegistry` API, rejects non-official origins before network access, and queries only the fixed ChatGPT usage endpoint. Runtime failures degrade to an unavailable or cleared status and must not expose or persist credentials or provider response bodies.
