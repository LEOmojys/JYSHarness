# Demo Notes

This tiny workspace exists so the harness can be exercised without an API key.

- The mock provider replays a scripted conversation.
- The agent loop still runs for real: tools execute, permissions are enforced,
  hooks fire, sessions are persisted under .harness/sessions.
