# Pi extensions

`index.js` selects exactly one status implementation from `AGENT_ORCHESTRATION_PROFILE` and registers it with Pi.

The individual modules keep pure formatting/schedule functions exported for deterministic tests. Runtime failures degrade to an unavailable or cleared status and must not expose credentials or provider response bodies.
