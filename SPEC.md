# cc-gateway 规格文档

## 项目定位

一个 Node.js 单文件网关，把 Command Code CLI 的 `/alpha/generate` 私有协议翻译成三种标准 API 格式，让任何支持标准 API 的客户端都能通过这个网关使用 Command Code 的模型。

## 文件结构

```
C:\Project\cc-gateway\
├── gateway.mjs          ← 唯一核心文件（~1500-2000行）
├── config.json          ← 运行时配置（首次启动自动创建）
├── package.json         ← npm metadata
├── .gitignore
└── SPEC.md              ← 本文件
```

## 技术约束

- **运行环境**：Node.js 22+（使用内置 `http`、`crypto` 模块，零 npm 依赖）
- **单文件**：所有逻辑写在 `gateway.mjs` 一个文件里
- **ESM**：使用 `import` 语法（`"type": "module"` in package.json）

## config.json 格式

```json
{
  "port": 3050,
  "host": "0.0.0.0",
  "api_key": "user_xxx",
  "api_base": "https://api.commandcode.ai",
  "log_level": "info"
}
```

- 首次启动时自动创建默认 config.json
- 支持环境变量覆写：`PORT`、`HOST`、`CC_API_KEY`、`CC_API_BASE`、`LOG_LEVEL`
- 环境变量优先级高于 config.json

## CLI 命令

```bash
node gateway.mjs              # 启动网关
node gateway.mjs --set-key    # 交互式设置 API Key
node gateway.mjs --show-key   # 显示当前 Key（掩码）
node gateway.mjs --delete-key # 删除 API Key
node gateway.mjs --version    # 显示版本
node gateway.mjs --help       # 显示帮助
```

## API 端点

### 1. `POST /v1/chat/completions` — OpenAI Chat Completions

**请求格式**（标准 OpenAI）：
```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [
    {"role": "system", "content": "You are helpful."},
    {"role": "user", "content": "hi"}
  ],
  "max_tokens": 64000,
  "stream": true,
  "temperature": 0.7,
  "reasoning_effort": "high",
  "tools": [...],
  "tool_choice": "auto"
}
```

**翻译规则**：
1. `role: "system"` 和 `role: "developer"` 的消息 → 提取 content 字符串 → 放入 CC 信封的 `params.system` 字段
2. `role: "user"` 消息：
   - content 为字符串 → `[{type:"text", text:原始文本}]`
   - content 为数组 → 遍历，将 `image_url` 类型转为 `{type:"image", image:url}`，其他保持原样
3. `role: "assistant"` 消息：
   - 文本 content → `{type:"text", text:...}`
   - `tool_calls` → `{type:"tool-call", toolCallId:id, toolName:name, input:解析后的JSON}`
4. `role: "tool"` 消息：
   - → `{role:"tool", content:[{type:"tool-result", toolCallId:id, toolName:从assistant反查, output:{type:"text", value:content}}]}`
5. `tools` 定义 → `{type, name, description, input_schema}`（`function.parameters` → `input_schema`）
6. `tool_choice` 映射：`"required"` → `"any"`，`{type:"function", function:{name:...}}` → `{type:"tool", name:...}`
7. `max_tokens` 上限 200000
8. `stream` 强制为 `true`（CC API 总是流式）
9. 可选字段：`temperature`、`reasoning_effort`、`parallel_tool_calls`

**响应格式**：标准 OpenAI SSE（`data: {...}\n\n` + `data: [DONE]\n\n`）

### 2. `POST /v1/messages` — Anthropic Messages

**请求格式**（标准 Anthropic）：
```json
{
  "model": "claude-sonnet-4-6",
  "max_tokens": 1000,
  "system": "You are helpful.",
  "messages": [
    {"role": "user", "content": "hi"}
  ],
  "stream": true,
  "thinking": {"type": "enabled", "budget_tokens": 10000}
}
```

**翻译规则**：
1. 顶层 `system` 字段 → 直接作为 `params.system`
2. `messages` 按 Anthropic 格式转换为 OpenAI 格式（中间步骤）：
   - `assistant` 消息的 `content` 数组：`text` 块 → 文本，`tool_use` 块 → `tool_calls`
   - `user` 消息的 `content` 数组：`text` 块 → 文本，`tool_result` 块 → `tool` 角色消息
3. 然后按 Chat Completions 的翻译规则处理
4. `thinking.budget_tokens` → `reasoning_effort` 映射：≥10000→high，≥5000→medium，≥2000→low
5. `tools` 格式差异：`input_schema` → `parameters`

**响应格式**：标准 Anthropic SSE（`event: message_start` / `content_block_delta` / `message_stop`）

### 3. `POST /v1/responses` — OpenAI Responses API

**请求格式**（标准 Responses）：
```json
{
  "model": "gpt-5.6-luna",
  "input": "你好",
  "instructions": "你是助手",
  "tools": [...],
  "stream": true
}
```

**翻译规则**：
1. `input` 为字符串 → `[{role:"user", content:[{type:"text", text:input}]}]`
2. `input` 为数组 → 遍历每个元素：
   - `{type:"message", role:"user", content:[{type:"input_text", text:"..."}]}` → user 消息
   - `{type:"message", role:"assistant", content:[{type:"output_text", text:"..."}]}` → assistant 消息
   - `{type:"function_call", ...}` → assistant 消息的 tool_calls
   - `{type:"function_call_output", ...}` → tool 消息
3. `instructions` → `params.system`
4. `tools` 格式同 Chat Completions
5. `tool_choice` 映射同 Chat Completions

**响应格式**：标准 Responses SSE（`response.created` / `response.output_item.added` / `response.completed`）

### 4. `GET /v1/models` — 模型列表

返回标准 OpenAI 格式的模型列表。

### 5. `GET /health` — 健康检查

返回 `{"status":"ok"}`

## CC CLI 信封格式（转发目标）

所有三种 API 格式最终都翻译成这个信封格式，发送到 `{api_base}/alpha/generate`：

```json
{
  "config": {
    "workingDir": "",
    "date": "2026-08-27",
    "environment": "win32-x64, Node.js v22.x.x",
    "structure": [],
    "isGitRepo": false,
    "currentBranch": "",
    "mainBranch": "",
    "gitStatus": "",
    "recentCommits": []
  },
  "memory": null,
  "taste": null,
  "skills": "",
  "permissionMode": "standard",
  "params": {
    "model": "deepseek/deepseek-v4-flash",
    "messages": [...],
    "max_tokens": 64000,
    "stream": true,
    "system": "可选的 system prompt",
    "temperature": 0.7,
    "reasoning_effort": "high",
    "tools": [...],
    "tool_choice": {...}
  }
}
```

## 请求头伪装

发送到 CC API 的请求必须包含以下 header：

```
Authorization: Bearer user_xxx
Content-Type: application/json
x-cli-environment: production
x-command-code-version: <从 npm 拉取的最新版本号>
x-session-id: <UUID v4，12h 过期 + 1h 随机抖动>
x-co-flag: false
x-taste-learning: false
x-project-slug: <根据 session ID 伪随机生成的项目路径 slug>
traceparent: <W3C Trace Context 格式，随机生成>
```

## 指纹预请求

每次会话开始前（首次 + 每 8h+2h 抖动），并行发送两个预请求：

1. `POST {api_base}/alpha/fingerprint/record` — 上报设备指纹
2. `POST {api_base}/alpha/lifecycle-events` — 上报 `cli_session_exists` 事件

**指纹结构**（随机伪造，不读取真实硬件）：
```json
{
  "thumbmark": "<SHA256>",
  "components": {
    "machine_id_hash": "<SHA256(random)>",
    "mac_hashes": ["<SHA256(random)>", ...],
    "os_user_hash": "<SHA256(random)>",
    "hostname_hash": "<SHA256(random)>",
    "git_email_hash": "<SHA256(random)>",
    "platform": "win32",
    "arch": "x64",
    "os_release": "10.0.22631",
    "cpu_model": "<从预设池随机>",
    "cpu_count": <随机>,
    "mem_gib": <随机>,
    "is_container": false,
    "timezone": "<从预设池随机>",
    "runtime": "cli",
    "collector_version": 1
  }
}
```

## 响应翻译（NDJSON → SSE）

CC API 返回的是 NDJSON 流（每行一个 JSON 对象），需要翻译成对应格式的 SSE 流：

### OpenAI Chat Completions 响应
```json
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant"}}]}
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}
data: {"id":"chatcmpl-xxx","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{...}}
data: [DONE]
```

### Anthropic Messages 响应
```
event: message_start
data: {"type":"message_start","message":{...}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{...}}

event: message_stop
data: {"type":"message_stop"}
```

### OpenAI Responses 响应
```
event: response.created
data: {"type":"response.created","response":{...}}

event: response.output_item.added
data: {"type":"response.output_item.added","item":{...}}

event: response.content_part.delta
data: {"type":"response.content_part.delta","delta":{...}}

event: response.completed
data: {"type":"response.completed","response":{...}}
```

## 错误处理

- CC 上游 429 → 映射为 OpenAI `rate_limit_error` / Anthropic `rate_limit_error`，带 `Retry-After` header
- CC 上游 401/403 → 映射为认证错误
- CC 上游 500+ → 映射为 `proxy_error`
- 零输出 token → 返回 429（防止虚假计费）
- 流式超时 30s / 非流式超时 90s

## 日志格式

```
[2026-08-27T00:00:00.000Z] [info] CC Gateway started {"port":3050,"api":"https://api.commandcode.ai"}
[2026-08-27T00:00:01.000Z] [info] Fingerprint recorded
[2026-08-27T00:00:02.000Z] [info] Request {"model":"deepseek/deepseek-v4-flash","path":"/v1/chat/completions"}
```

支持 `LOG_LEVEL` 环境变量：debug / info / warn / error

## 参考实现

翻译逻辑参考以下两个项目的源码（已完整分析）：

1. **commandcode-proxy** (`C:\Users\Administrator\commandcode-proxy\proxy.mjs`)
   - Node.js 实现，1940 行
   - 重点参考：`buildCcRequest()`、`forwardToCC()`、`ensureInitialized()`、SSE 翻译器

2. **68Proxy** (`C:\Users\Administrator\68proxy\src-tauri\src\proxy\`)
   - Rust 实现
   - 重点参考：`convert.rs`（消息映射）、`cc_client.rs`（请求头）、`sse.rs`（响应翻译）

**已知 bug（必须修复）**：
- 68Proxy 的 `convert.rs` 没有过滤 `role: "developer"` 消息，导致 Hermes 报 400 错误
- 我们的实现必须同时过滤 `system` 和 `developer` 两种 role

## 验证标准

1. `node gateway.mjs` 启动无报错
2. `curl http://127.0.0.1:3050/health` 返回 `{"status":"ok"}`
3. `curl http://127.0.0.1:3050/v1/models` 返回模型列表
4. `curl -X POST http://127.0.0.1:3050/v1/chat/completions -H "Authorization: Bearer user_xxx" -H "Content-Type: application/json" -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"say hi"}]}'` 返回正常响应
5. Hermes 配置为使用此网关后能正常对话
