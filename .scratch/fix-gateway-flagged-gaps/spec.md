# fix-gateway-flagged-gaps — spec

## Problem Statement(用户视角)

理解轮(2026-09-06)报告了四个已标记缺口,用户以「修正项目」要求修复:

1. **管理面全开放**:`/api/*` 无任何鉴权,`GET /api/keys` 返回全部明文 key,而网关默认绑 `0.0.0.0` —— 同局域网任何人可拿走全部上游凭证。
2. **示例配置漂移**:`config.json.example` 缺 v1.029+ 新增的 `api_keys` / `stream_timeout_ms` / `reasoning_timeout_ms` 字段,照模板新建配置拿不到文档化默认值。
3. **日志无限增长**:`logs/gateway-YYYY-MM-DD.log` 按天累积、永不清理(`data/usage.json` 有 30 天清理,日志没有)。
4. **卫生问题**:`gateway.mjs :: handleRoot` 是死代码(定义于 :2209,无任何路由引用,已 grep 证实);版本号在 5 处重复硬编码(--help :27、--version :40、handleHealth :2206、start banner :2483、package.json)。

## Solution

1. 版本号收敛为单一 `VERSION` 常量(bump 1.0.31),删除 handleRoot,example 补齐字段。
2. 日志保留:新配置 `log_retention_days`(默认 30,`0`=关闭),启动与日切时按文件名日期删除过期 `gateway-*.log`。
3. 可选管理令牌:新配置 `admin_token`(默认空 = 行为完全不变,尊重 SPEC 记录的「运营者自用」明示设计);设置后所有 `/api/*` 要求 `x-admin-token` 头,仪表盘加令牌输入条(localStorage 记忆),`/`、`/health`、`/v1/*` 一律不受影响。

## User Stories

1. As an operator, I want `/api/*` protected by an optional token, so that LAN peers cannot read my plaintext upstream keys.
2. As an operator, I want the dashboard to prompt for the token once and remember it, so that I never re-enter it manually.
3. As an operator, I want stale log files auto-deleted, so that `logs/` stops growing forever.
4. As an operator, I want log retention configurable and disablable, so that I can keep full history when needed.
5. As an operator, I want `config.json.example` to list every real field, so that a fresh install starts from documented defaults.
6. As a maintainer, I want the version declared once, so that a bump is a one-line change.
7. As a maintainer, I want dead code removed, so that the file reflects the real routing table.
8. As a downstream agent, I want `/v1/*` and `/health` to ignore the admin token entirely, so that my existing integration is untouched.

## Implementation Decisions

- 版本单一来源:`gateway.mjs :: VERSION`(文件顶部常量 `1.0.31`),引用点 --help / --version / handleHealth / start banner;package.json `version` 同 commit 同步 bump(两处构成版本对)。
- 删除 `gateway.mjs :: handleRoot`(唯一出现即定义,Gate 0 已证)。
- `config.json.example` 补 `api_keys: []` / `stream_timeout_ms: 120000` / `reasoning_timeout_ms: 300000`,值取 `gateway.mjs :: DEFAULT_CONFIG`。
- 日志清理 `gateway.mjs :: cleanOldLogs`:正则 `^gateway-(\d{4}-\d{2}-\d{2})\.log$` 提取日期做字符串比较(ISO 字典序即时间序),`log_retention_days <= 0` 直接返回;调用点 = `gateway.mjs :: getLogFile` 日切分支 + `start()`;单个文件删除失败仅 warn 不中断。
- 鉴权 `gateway.mjs :: requireAdmin`:`CFG.admin_token` 非空时,`gateway.mjs :: handleRequest` 的 `/api/*` 各分派行之前统一校验请求头 `x-admin-token`,比较用 `crypto.timingSafeEqual`(长度不等直接 false);失败返回 401 JSON;`/`(仪表盘静态页)、`/health`、`/v1/*` 不校验。
- `handleApiStatus` 增加 `auth_required: !!CFG.admin_token`(布尔,不回显令牌),仪表盘据此主动弹令牌条。
- 仪表盘 `public/dashboard.html :: authHeaders/api`:全部 `/api` 调用统一注入 localStorage `cc_admin_token`;401 → 显示顶部令牌条 + toast;令牌条保存后立即 refresh;`keyAction`/`testKey` 的裸 fetch 改走同一注入。
- 兼容性:`loadConfig` 浅合并 `DEFAULT_CONFIG`(gateway.mjs:48-49),旧 config.json 无新字段自动取默认 —— **不改动用户现有 config.json,两个新字段均 opt-in**。

## Testing Decisions(seams FIRST)

- **Seam 1(日志保留)**:`test_logs.py` — 隔离实例(临时目录 + 端口 3052,镜像 `test_pool.py` 的隔离法):预置 `gateway-<60天前>.log`、`gateway-<10天前>.log`、`gateway-<今天>.log`,启动后断言 60 天文件已删、另两个保留。红 = 当前代码不删任何文件;绿 = 实现后通过。
- **Seam 2(鉴权)**:`test_admin.py` — 隔离实例(端口 3053,`admin_token=test-token-123`):`/health`、`/v1/models` 无令牌 200;`/api/status` 无头/错头 401、对头 200;`/api/keys` 对头 200;`/` 返回的 HTML 含令牌条。**Seam 3(向后兼容)**:端口 3054 实例无 `admin_token`:`/api/status` 无头 200(行为不变)。红 = 当前代码无 401;绿 = 实现后通过。
- Slice 1 无行为缝(display-wiring 类):门 = 版本串跨文件一致性 grep(全部 1.0.31)+ `node --check gateway.mjs` + `/health` 冒烟。
- 好测试只测外部行为(HTTP 状态码 / 文件系统),不打内部函数;先例 = `test_pool.py` 隔离实例模式。
- **不跑全量 test_*.py**:本轮不触碰协议翻译与池逻辑,全量会打真实上游消耗配额;改动面 = 日志/鉴权/文档,由两个新 seam 测试 + 冒烟覆盖(test_pool.py 的隔离 config 不含 admin_token,天然回归兼容性)。

## Out of Scope

- 按大小轮转、压缩归档、远端日志
- HTTPS/TLS、IP 白名单、限流
- key 加密存储、多管理员令牌、令牌轮换 CLI
- 创建 `CONTEXT.md`(词汇暂栖 SPEC.md 与 spec Glossary,按 ground-truth 不主动建)
- 上游协议任何改动

## Glossary

- **管理令牌 (admin_token)**:config.json 可选字段;非空即启用 `/api/*` 鉴权,值经 `x-admin-token` 头携带。
- **日志保留 (log_retention_days)**:config.json 可选字段;`gateway-YYYY-MM-DD.log` 按文件名日期保留的天数,`0` = 关闭清理。

## Notes(自答记录)

- **30 天**:取自 `data/usage.json` 30 天清理先例(gateway.mjs:194-198),非自造数值。
- **admin_token 默认空**:SPEC.md 明示「管理 API 与 key 明文无鉴权(按运营者自用设计)」是已记录决策 —— 本轮不改默认行为,只加 opt-in 能力;是否设置令牌留给用户。若默认强制启用会破坏用户现有脚本与使用习惯。
- to-spec 模板「不写文件路径」与本仓 feature-flow/verification-gates 的锚点规则冲突 → 按 lane 文件(feature-flow)保留一行锚点。
- setup 的「向用户确认」步骤按 AFK 自答政策执行(选定 local-markdown / 默认标签 / 单上下文),偏离已记 JOURNAL。

## Checks

- **i18n**: N/A — 单语种 zh 仪表盘,仓库无 locale 文件;新增 UI 文案保持 zh。
- **save**: Pass — `DEFAULT_CONFIG` 浅合并向后兼容 + test_admin.py Seam 3(无 token 实例行为不变)。
- **red-line**: Pass — 唯一数值决策(30 天)引自仓库先例;仓库无 numbers 红线文档。

## Slices

- [ ] Slice 1: 版本单一来源 + config.json.example 同步 + handleRoot 删除(无缝,门 = 一致性 + 冒烟)
- [ ] Slice 2: 日志保留清理(seam: test_logs.py 红→绿)
- [ ] Slice 3: 可选管理令牌(seam: test_admin.py 红→绿,网关 + 仪表盘)
