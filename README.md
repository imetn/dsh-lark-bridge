# DeepSeek Harness Lark Bridge

English | [中文](README.zh.md)

[![CI](https://github.com/imetn/dsh-lark-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/imetn/dsh-lark-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933.svg)](package.json)

A secure, bidirectional Feishu/Lark controller for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Send a task from a DM, group, or topic. The Bridge runs it in the right Harness Project and Session, updates one native card as work progresses, and routes approvals, questions, files, images, and controls back to the same conversation.

Tested with DeepSeek Harness `0.1.0-rc.6`. Harness is still in developer preview.

## What works

- Start, continue, steer, stop, resume, and inspect Harness Sessions from Lark.
- Map each group to a Project, working directory, model route, access policy, and card preset.
- Map each topic or thread to an isolated Session by default.
- Update one card from running to completed, blocked, cancelled, or failed.
- Approve one tool call or answer structured Agent questions from card buttons.
- Receive text, images, and files. The Agent can send safe workspace files back with `lark_deliver`.
- Choose compact, standard, or developer card detail per Project or Session.
- Use WebSocket long connections, with no public webhook server.

Cards show bounded tool summaries, never hidden model reasoning.

## Quick start

Requirements: Node.js 22+, `pnpm`, a working DeepSeek Harness model configuration, and either an installed `dsh` CLI or an official Harness source checkout nearby.

Run this from the Project you want the bot to control:

```bash
pnpm dlx github:imetn/dsh-lark-bridge setup --project "$PWD"
```

The setup command:

1. Opens the official Feishu/Lark authorization page for a new bot app.
2. Requests only the messaging, attachment, reaction, event, and card callback capabilities used by the Bridge.
3. Stores the returned App Secret in Harness's owner-only credential file, never in the Profile.
4. Installs the plugin, writes an idempotent `lark` Profile, binds the authorizing user, and starts the Bridge.
5. Opens the bot. A welcome card arrives automatically when the platform returns the user's Open ID.

For a ByteDance `larkoffice.com` tenant, add `--brand larkoffice`. For international Lark, add `--brand lark`.

```bash
pnpm dlx github:imetn/dsh-lark-bridge setup --project "$PWD" --brand larkoffice
```

The automatic flow always passes `createOnly: true`. It cannot select or change an existing app.

### Use an existing app

Existing apps stay untouched. The command only validates the credentials and writes local Harness files:

```bash
printf '%s' "$LARK_APP_SECRET" | pnpm dlx github:imetn/dsh-lark-bridge setup \
  --project "$PWD" \
  --app-id cli_xxxxxxxxxxxxxxxx \
  --app-secret-stdin
```

If your enterprise blocks one-click creation, add `--manual`. The wizard opens the developer console and asks for the App ID and hidden App Secret.

For manual apps, enable the bot capability, select long connections, publish a version, and add:

| Type | Required values |
| --- | --- |
| Permissions | `im:message.p2p_msg:readonly`, `im:message.group_at_msg:readonly`, `im:message:send_as_bot`, `im:resource` |
| Inbound attachments | `im:message:readonly` |
| Message event | `im.message.receive_v1` |
| Card callback | `card.action.trigger` |
| Stop reactions, optional | `im:message.reactions:read`, `im.message.reaction.created_v1` |

Keep the group mention permission instead of requesting every group message.

### Verify

In the bot DM, send:

```text
/status
```

Then send a small task. The reply card should show the Project, result, elapsed time, and the detail selected by its view preset. The original task stays in Lark's quoted reply and is not duplicated inside the card.

Check the local setup at any time:

```bash
pnpm dlx github:imetn/dsh-lark-bridge doctor
```

The welcome card's callback test is optional. Text tasks work before you click it.

`dsh --profile lark` starts the Bridge only. It does not expose an HTTP page. `http://127.0.0.1:3080` belongs to the separate `dsh web` command.

## Projects, groups, and Sessions

Use this mapping for most teams:

| Lark | Harness | Use |
| --- | --- | --- |
| Bot DM | Personal control surface | Switch Projects and handle private tasks |
| One group | One Project | Keep a codebase or durable workstream in one place |
| One topic or thread | One Session | Keep one task and its follow-ups together |

With the default `groupSessionScope: thread`, replies in one topic share context and a new topic starts a separate Session. A normal group's top-level message gets its own thread-scoped Session.

If the Profile contains one accessible Project, the first owner message that mentions the bot automatically binds that group. With multiple Projects, send `@bot /bind <project-id>` once.

`sender` scope keeps one Session per group member. `chat` shares one Session across the group and should only be used when shared context is intentional.

## Card detail

The card is already a reply to the original task, so it does not repeat the prompt.

| Preset | Shows |
| --- | --- |
| `compact` | Result, elapsed time, essential actions |
| `standard` | Compact view plus Project, model, recent tool names, total tool calls and tokens |
| `developer` | Standard view plus cwd, Session ID, redacted tool summaries and durations, input/output/cache tokens |

Set `cardPreset` globally or per Project. Use `/view compact|standard|developer` or the terminal card button for the current Session.

## Controls

| Input | Action |
| --- | --- |
| Plain text or attachments | Continue the current Agent |
| `/steer <text>` | Correct or add context to the running step |
| `/status` | Show connection, Project, model, directory, Session, and pending interactions |
| `/stop` | Cancel the running task |
| `/approve`, `/reject` | Text fallback for a pending one-shot approval |
| `/new` | Start a new Session |
| `/sessions`, `/resume <id>` | List or resume Sessions owned by this Lark origin |
| `/projects`, `/project <id>` | List or select Projects in a DM |
| `/bind [project-id]`, `/unbind` | Manage a group's Project binding |
| `/commands`, `/help` | Show native Harness commands or Bridge help |

Card buttons also handle stop, new Session, status, approval, view changes, and structured questions.

## Multiple Projects

Setup writes `~/.dsh/profiles/lark/cordis.patch.yml`. Add Projects there when needed:

```yaml
- id: dsh-lark-bridge
  config:
    appId: cli_xxxxxxxxxxxxxxxx
    appSecretRef: DSH_LARK_APP_SECRET
    brand: feishu
    defaultProjectId: web
    groupSessionScope: thread
    projects:
      - id: web
        name: Web App
        cwd: /absolute/path/to/web-app
        workspaceRoot: /absolute/path/to/web-app
        cardPreset: developer
      - id: ios
        name: iOS App
        cwd: /absolute/path/to/ios-app
        workspaceRoot: /absolute/path/to/ios-app
        cardPreset: compact
```

Each Project may also set `chatIds`, `allowedOpenIds`, `provider`, `model`, and `inboundDir`. Group bindings created from Lark are stored in the owner-only Bridge state file. Static `chatIds` take precedence.

## Security and files

- Owners pair through the official authorization identity or a hashed, ten-minute, one-use `/claim` code.
- Users, chats, Project access, and card operators are checked before an Agent action.
- Secrets are redacted from cards, errors, tool summaries, and spill files.
- Inbound files use `0700` directories and `0600` files with sanitized random names.
- Outbound files must resolve to regular files inside the Project's `workspaceRoot`; symlink escapes are rejected.
- Incoming events are deduplicated, stale events are rejected, and each chat is serialized.
- One approval button grants one operation only.

See [SECURITY.md](SECURITY.md) for the full trust model.

## Development and discovery

```bash
git clone https://github.com/imetn/dsh-lark-bridge.git
cd dsh-lark-bridge
pnpm install --frozen-lockfile
pnpm run check
```

The repository commits built `lib/` artifacts and bundles the official Lark SDK, so Git installation needs no install-time build. `package.json` declares `dsh.bundle.patch` for automatic Harness activation and the `dsh-plugin` keyword for plugin discovery.

Common fixes:

- No inbound messages: publish the app, select long connections, and check the message event and permissions.
- No group response: add the bot and mention it. One accessible Project binds automatically; multiple Projects require `/bind <id>`.
- Card buttons do nothing: add `card.action.trigger`. Text tasks, `/approve`, `/reject`, and plain-text answers still work.
- Attachments fail: add `im:message:readonly` and check file size limits.
- `127.0.0.1:3080` is empty: run `dsh web`; the Lark Profile is a Bridge process, not the Web UI.

## License

[MIT](LICENSE)
