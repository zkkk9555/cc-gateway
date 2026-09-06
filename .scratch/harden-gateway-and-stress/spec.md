# harden-gateway-and-stress — spec

## Problem

1. 网关对 max_tokens 自设 200000 截断(gateway.mjs:823)——用户明确表态:翻译器不应自作主张,直接透传,由上游执行自己的 per-model 上限。
2. 停止/重启脚本的守护匹配只看 `'--bg'` —— 用户还有**另一个网关项目**,若其守护恰好也带 `--bg` 参数会被误杀。必须锚定到本网关。
3. 用户要求项目体检(找 bug)+ 修复后更大强度压测,确认稳定性。

## Slices

- [ ] Slice 1: max_tokens 纯透传 —— `Math.min(x, 200000)` → `x`(保留 `|| 64000` 缺省);test_upstream.py mock 在错误消息里回显**实际收到的** max_tokens,断言 999999 原样到达上游。
- [ ] Slice 2: 守护匹配收窄 —— 停止/重启 bat 的 powershell 匹配从 `--bg` 单条件改为 `cc-gateway AND --bg` 双条件(ASCII,无编码风险);test_scripts.py 加诱饵进程(带 `--bg` 但非本网关的 cmd),断言启动/重启/停止全程诱饵存活。
- [ ] Slice 3: 体检(审计 agent 扫 gateway.mjs 找真 bug)+ 大压测(stress + heavy + aggressive × longcat)。

## Testing Decisions

- Slice 1 缝 = mock 上游回显;Slice 2 缝 = 诱饵进程存活断言。均先红后绿。
- 体检发现按「真 bug(有证据)→ 本轮修;建议 → 记录」分诊。

## Out of Scope

- 上游 per-model 限值的本地表(上游错误消息已足够清晰);其他项目的一切改动。

## Checks

- i18n: N/A(bat 中文方案不变)。save: N/A。red-line: Pass —— 移除的是网关自设数值,上游限值为准,无新数值决策。

## Notes

- 重启网关.bat **会**自动打开管理面板(交互路径 start http://127.0.0.1:3050/;--no-browser 供测试)——回答用户提问。
- 端口 3050 是本网关的专属端口:若其他项目恰好占用 3050,停止脚本会杀掉它(绑定所需)——这是预期行为,报告中说明。
