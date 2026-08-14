# DeepSeek Harness Lark Bridge

[English](README.md) | 中文

[![CI](https://github.com/imetn/dsh-lark-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/imetn/dsh-lark-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933.svg)](package.json)

一个面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的安全、双向飞书/Lark 控制器。

你可以从私聊、群聊或话题发任务。Bridge 会把任务交给正确的 Harness Project 和 Session，用一张飞书原生卡片持续更新进度，并把审批、提问、文件、图片和控制操作送回同一段会话。

当前版本已针对 DeepSeek Harness `0.1.0-rc.6` 验证。Harness 仍处于开发者预览阶段。

## 已支持

- 从飞书创建、继续、纠偏、停止、恢复和检查 Harness Session。
- 每个群可绑定独立的 Project、工作目录、模型路线、权限和卡片视图。
- 默认一个话题或线程对应一个隔离的 Session。
- 同一张卡片从运行中原位更新为完成、阻塞、取消或失败。
- 通过卡片允许一次工具调用，或回答 Agent 的结构化问题。
- 接收文字、图片和文件；Agent 可通过 `lark_deliver` 安全发送工作区文件。
- 每个 Project 或 Session 可选择精简、标准、开发者视图。
- 使用 WebSocket 长连接，无需部署公网 Webhook。

卡片只展示受长度限制、已脱敏的工具摘要，不会展示模型隐藏思维链。

## 快速开始

需要 Node.js 22+、`pnpm`、可用的 DeepSeek Harness 模型配置，以及已安装的 `dsh` CLI，或附近一份官方 Harness 源码。

进入希望机器人控制的 Project，运行：

```bash
pnpm dlx github:imetn/dsh-lark-bridge setup --project "$PWD"
```

向导会自动完成：

1. 打开飞书/Lark 官方页面，创建一个新的机器人应用。
2. 只申请 Bridge 用到的消息、附件、表情、事件和卡片回调能力。
3. 把 App Secret 写入 Harness 的本机私密凭据文件，不写进 Profile。
4. 安装插件，幂等写入 `lark` Profile，绑定授权用户并启动 Bridge。
5. 打开机器人；平台返回用户 Open ID 时，机器人会主动发送欢迎卡片。

字节租户请添加 `--brand larkoffice`，国际版 Lark 请添加 `--brand lark`：

```bash
pnpm dlx github:imetn/dsh-lark-bridge setup --project "$PWD" --brand larkoffice
```

自动流程固定使用 `createOnly: true`，不会选择或修改已有应用。

### 使用已有应用

已有应用不会被修改。命令只验证凭据并写入本机 Harness 配置：

```bash
printf '%s' "$LARK_APP_SECRET" | pnpm dlx github:imetn/dsh-lark-bridge setup \
  --project "$PWD" \
  --app-id cli_xxxxxxxxxxxxxxxx \
  --app-secret-stdin
```

如果企业策略不允许一键创建，添加 `--manual`。向导会打开开发者后台，并提示输入 App ID 和隐藏的 App Secret。

手动创建应用时，请启用机器人能力，选择长连接，发布一个版本，并添加：

| 类型 | 必需配置 |
| --- | --- |
| 权限 | `im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、`im:message:send_as_bot`、`im:resource` |
| 接收入站附件 | `im:message:readonly` |
| 消息事件 | `im.message.receive_v1` |
| 卡片回调 | `card.action.trigger` |
| 用表情停止任务，可选 | `im:message.reactions:read`、`im.message.reaction.created_v1` |

群聊只申请 `@机器人` 消息，不需要读取群内全部消息。

### 验收

在机器人私聊中发送：

```text
/status
```

再发送一个小任务。回复卡片应展示 Project、结果、耗时，以及当前视图对应的信息。原始任务已经出现在飞书引用回复中，卡片内部不会重复展示。

随时可以检查本机接入状态：

```bash
pnpm dlx github:imetn/dsh-lark-bridge doctor
```

欢迎卡片中的按钮测试是可选项，不点击也能直接发送文字任务。

`dsh --profile lark` 只启动 Bridge，不会提供 HTTP 页面。`http://127.0.0.1:3080` 属于单独的 `dsh web` 命令。

## Project、群聊与 Session

大多数团队可以直接采用这套映射：

| 飞书实体 | Harness 实体 | 用法 |
| --- | --- | --- |
| 机器人私聊 | 个人控制面 | 切换 Project，处理私密任务 |
| 一个群 | 一个 Project | 承载一个代码库或长期工作流 |
| 一个话题或线程 | 一个 Session | 把一个任务和它的后续交流放在一起 |

默认 `groupSessionScope: thread` 时，同一话题内的回复共享上下文，新话题会创建独立 Session。普通群的每条顶层消息也会获得自己的线程 Session。

Profile 只有一个可用 Project 时，Owner 第一次在群里 @机器人就会自动完成绑定。存在多个 Project 时，只需发送一次 `@机器人 /bind <project-id>`。

`sender` 会为每位群成员保留独立 Session；`chat` 让全群共享一个 Session，只有明确需要共享上下文时才使用。

## 卡片信息密度

卡片本身已经回复了原始任务，因此不会再重复任务正文。

| 视图 | 展示内容 |
| --- | --- |
| `compact` | 结果、耗时、关键操作 |
| `standard` | 精简视图 + Project、模型、近期工具名、工具次数和总 token |
| `developer` | 标准视图 + cwd、Session ID、已脱敏工具摘要与耗时、输入/输出/缓存 token |

通过 `cardPreset` 设置全局或 Project 默认值。当前 Session 可发送 `/view compact|standard|developer`，或点击完成卡片按钮切换。

## 控制命令

| 输入 | 行为 |
| --- | --- |
| 文字或附件 | 继续当前 Agent |
| `/steer <内容>` | 在运行中补充或纠正最近一步 |
| `/status` | 查看连接、Project、模型、目录、Session 和待处理交互 |
| `/stop` | 取消当前任务 |
| `/approve`、`/reject` | 处理当前一次工具审批的文字兜底 |
| `/new` | 创建新 Session |
| `/sessions`、`/resume <id>` | 列出或恢复属于当前飞书来源的 Session |
| `/projects`、`/project <id>` | 在私聊中列出或选择 Project |
| `/bind [project-id]`、`/unbind` | 管理群聊的 Project 绑定 |
| `/commands`、`/help` | 查看 Harness 原生命令或 Bridge 帮助 |

卡片按钮也支持停止、新会话、状态、审批、视图切换和结构化提问。

## 多 Project 配置

向导会写入 `~/.dsh/profiles/lark/cordis.patch.yml`。需要更多 Project 时，在这个文件中追加：

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

每个 Project 还可以设置 `chatIds`、`allowedOpenIds`、`provider`、`model` 和 `inboundDir`。从飞书完成的群绑定保存在仅 Owner 可读的 Bridge 状态文件中；静态 `chatIds` 优先。

## 安全与文件

- Owner 通过官方授权身份绑定，或使用经过哈希保存、十分钟有效、只能使用一次的 `/claim` 配对码。
- 用户、群聊、Project 权限和卡片操作者都会在执行 Agent 操作前重新检查。
- 卡片、错误、工具摘要和溢出文件会统一脱敏。
- 入站附件使用 `0700` 目录和 `0600` 文件，文件名会被净化并添加随机后缀。
- 出站文件必须是 Project `workspaceRoot` 内的普通文件，符号链接逃逸会被拒绝。
- 入站事件会去重、拒绝过期消息，并按聊天串行处理。
- 审批按钮只授权当前一次操作。

完整信任模型见 [SECURITY.md](SECURITY.md)。

## 开发与发现

```bash
git clone https://github.com/imetn/dsh-lark-bridge.git
cd dsh-lark-bridge
pnpm install --frozen-lockfile
pnpm run check
```

仓库提交了已构建的 `lib/`，并打包飞书官方 SDK，所以从 Git 安装不需要现场构建。`package.json` 通过 `dsh.bundle.patch` 支持 Harness 自动激活，也包含官方发现关键词 `dsh-plugin`。

常见问题：

- 收不到消息：发布应用版本，选择长连接，检查消息事件和权限。
- 群聊无响应：把机器人加入群并 @它。只有一个 Project 时会自动绑定；多个 Project 需要 `/bind <id>`。
- 卡片按钮无响应：添加 `card.action.trigger`。文字任务、`/approve`、`/reject` 和直接文字回答仍可使用。
- 附件失败：添加 `im:message:readonly`，并检查文件大小限制。
- `127.0.0.1:3080` 空白：运行 `dsh web`；Lark Profile 是 Bridge 进程，不是 Web UI。

## 许可证

[MIT](LICENSE)
