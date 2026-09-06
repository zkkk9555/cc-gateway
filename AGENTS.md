# AGENTS.md — cc-gateway

单文件 Node.js 网关(零 npm 依赖,Node 22+)。完整规格见 `SPEC.md`,工程流程走 mattpocock-skills。

## Agent skills

### Issue tracker

Local markdown under `.scratch/<slug>/` — solo repo; publishes to `github.com/zkkk9555/cc-gateway`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical labels (`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context; `CONTEXT.md` intentionally deferred, domain vocabulary lives in `SPEC.md` + each spec's Glossary. See `docs/agents/domain.md`.
