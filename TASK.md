# Claude Code 任务：实现 cc-gateway

## 【目标】

在 `C:\Project\cc-gateway\` 目录下实现 `gateway.mjs` 和 `package.json`，完成一个 Node.js 单文件网关，把 Command Code CLI 的 `/alpha/generate` 私有协议翻译成三种标准 API 格式（Chat Completions / Anthropic Messages / OpenAI Responses）。

**必须阅读 `SPEC.md` 获取完整规格。**

## 【涉及文件】

- `C:\Project\cc-gateway\gateway.mjs` — 核心网关代码（新建）
- `C:\Project\cc-gateway\package.json` — npm metadata（新建）
- `C:\Project\cc-gateway\SPEC.md` — 完整规格文档（只读参考）
- `C:\Users\Administrator\commandcode-proxy\proxy.mjs` — 参考实现（只读，Node.js 版本，1940行）
- `C:\Users\Administrator\68proxy\src-tauri\src\proxy\convert.rs` — 参考实现（只读，Rust 版本的消息翻译）
- `C:\Users\Administrator\68proxy\src-tauri\src\proxy\cc_client.rs` — 参考实现（只读，请求头构造）
- `C:\Users\Administrator\68proxy\src-tauri\src\proxy\sse.rs` — 参考实现（只读，NDJSON→SSE 翻译）

## 【流程】

1. 先读 `SPEC.md` 完整规格
2. 再读 `proxy.mjs`（重点看 `buildCcRequest()`、`forwardToCC()`、`ensureInitialized()`、SSE 翻译器、fingerprint 生成）
3. 再读 `convert.rs`（消息映射逻辑）和 `cc_client.rs`（请求头构造）
4. 实现 `package.json`（极简，只声明 name、version、type:module、engines）
5. 实现 `gateway.mjs`，按 SPEC.md 的端点和翻译规则实现全部功能
6. 用 curl 测试 `health`、`models`、`chat/completions` 三个端点

## 【约束】

- **零 npm 依赖**：只用 Node.js 内置模块（http、crypto、process）
- **单文件**：所有逻辑写在 `gateway.mjs` 一个文件里
- **ESM**：使用 import 语法
- **必须修复的 bug**：同时过滤 `role: "system"` 和 `role: "developer"` 消息（68Proxy 没做过滤 developer，导致 Hermes 报 400）
- **config.json**：首次启动自动创建，支持环境变量覆写
- **不使用任何外部包**（不要 npm install）
- **代码风格**：清晰的模块分区注释（// ── 路由 ──、// ── 翻译 ── 等），函数不超过 80 行

## 【验证标准】

1. `node gateway.mjs` 启动无报错，监听 3050 端口
2. `curl http://127.0.0.1:3050/health` 返回 `{"status":"ok"}`
3. `curl http://127.0.0.1:3050/v1/models` 返回包含模型列表的 JSON
4. `curl -X POST http://127.0.0.1:3050/v1/chat/completions -H "Authorization: Bearer test_key" -H "Content-Type: application/json" -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"say hi"}]}'` 能发出请求（即使返回 401 也说明路由正确）
5. 贴出每个测试的实际命令输出

## 【提交方式】

- 完成后 `git add -A && git commit -m "v1.003: implement gateway"`
- **不要推送**，只本地提交

收尾：完成后立即退出，禁止多余探索、额外轮次与无关优化。
