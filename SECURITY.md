# Security Policy

## Supported versions

Security fixes apply to the latest release on the default branch. The project is pre-1.0 and currently validated against DeepSeek Harness `0.1.0-rc.6`.

## Reporting a vulnerability

Do not open a public issue for an unpatched vulnerability. Use this repository's **Security → Report a vulnerability** flow. Include the affected version, deployment shape, reproduction steps, impact, and suggested mitigation. Remove credentials, access tokens, user messages, private IDs, and attachment contents.

## Trust boundaries

The Bridge intentionally gives an allowed Lark user a remote entry point into a local Harness Agent. Treat every allowed `open_id` as an operator with the practical reach of that Harness profile.

The Bridge defaults to empty user and group allowlists, requires group mentions, intersects global and Project-specific user policies, rechecks interactive operators, preserves Harness approval decisions, isolates group work by topic/thread, and constrains file delivery to the selected Project workspace. It does not replace Harness sandboxing, approval policy, operating-system access control, or secure secret storage.

Project, Session, and chat boundaries are different:

- a Project selects code, model, file, and access boundaries;
- a topic/thread selects conversational Session context;
- a group controls who can see the messages;
- `groupSessionScope: chat` intentionally shares one Agent context among every allowed operator in that group.

## Deployment checklist

- Rotate any credential that has appeared in chat, logs, shell history, screenshots, or commits.
- Supply `DSH_LARK_APP_SECRET` through a secret manager or protected process environment.
- Keep `allowAllUsers` and `allowAllGroups` disabled.
- Use both a global `allowedOpenIds` list and narrower Project lists where projects have different operators.
- Bind each group to exactly one Project and prefer private topic groups.
- Keep `requireMention: true` and request only the minimal Lark permissions documented in the README.
- Keep `groupSessionScope: thread`; use `sender` only for compatibility and `chat` only for deliberate shared context.
- Run one Bridge per Lark app and separate production from development apps.
- Set every `workspaceRoot` to the smallest useful directory and keep each `inboundDir` inside it.
- Keep Harness sandboxing and approval policy enabled.
- Pin Git installations to a reviewed commit.
- Inspect logs for rejected IDs, reconnect loops, unexpected downloads, and repeated approval attempts.

## Data handling

- The app ID and secret remain in process memory while the official Lark SDK is authenticated.
- Inbound attachments are written as `0600` files under directories created as `0700`.
- Filenames are sanitized and randomized. Outbound paths are resolved through the filesystem and checked against the active Project's `workspaceRoot` after symlink resolution.
- Message events are deduplicated in memory, stale events are rejected, and work is queued per chat. Durable Session data belongs to the selected Harness persistence plugin.
- Common API keys, Bearer tokens, and named secret assignments are redacted before content is sent to Lark. Redaction is defense in depth, not a substitute for keeping secrets out of prompts and tool output.
- The project includes no analytics, telemetry, public webhook server, or credential store.

## Known limits

- An unusual secret format may evade pattern-based redaction.
- An allowed operator can request any operation permitted by the underlying Harness profile.
- Every member of a group can see messages visible to that group, even if only some members may operate the bot.
- Lark and the configured model provider process content under their own data policies.
- WebSocket event delivery is not a distributed lock; multiple Bridge processes attached to one app can split events and in-memory interaction state.
