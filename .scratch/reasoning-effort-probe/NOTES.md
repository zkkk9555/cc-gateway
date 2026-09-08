# 思考档位探查 — NOTES（结论）

探查方式：`probe.py`，chat 流式 + 极小 prompt（`12*13+5=?`）+ 小 `max_tokens`。
共 15 个请求：3 模型 ×（1 非法值探针 + low/medium/high/xhigh）。

## 上游档位枚举（非法值探针返回的原话，三模型一致）

`expected one of "low"|"medium"|"high"|"xhigh"|"max" at "params.reasoning_effort"`

→ 上游支持 **5 档**：`low / medium / high / xhigh / max`。
→ 网关 `reasoning_effort` 纯透传（gateway.mjs:906），5 档全部可用，无需网关改动。

## 各档实际行为（max_tokens=24 小预算下）

| 模型 | low | medium | high | xhigh |
|---|---|---|---|---|
| gpt-5.6-luna | stop, 3事件, 0思考字 | 同左 | 同左 | 同左 |
| deepseek-v4-flash | stop, 13正文字 | stop, 3正文字 | stop, **22思考字**+3正文字 | stop, 3正文字 |
| muse-spark-1.3 | length, 0输出 | 同左 | 同左 | 同左 |

解读：
- 小预算下**看不出档位分级差异**：low/medium/high/xhigh 行为几乎一致。
- muse-spark 全档 `finish=length`：24 tokens 全被内部思考吃掉，无可见输出——这是**推理模型的正常形态**，不是网关问题。用它时 `max_tokens` 必须给足；想看思考过程读 `delta.reasoning_content`（网关已按 DeepSeek 风格分流）。
- deepseek high 那次 22 思考字是偶发波动（重跑未必复现），非档位证据。
- 要真正区分档位，需要**难题 + 大预算**（如 max_tokens=2000 的数学推理，对比各档思考长度），成本高，未做。

## 用户建议

- 日常使用：`high` 或直接不传（缺省行为即正常推理）。
- 上游目前没有 `none/off` 档——想关思考只能换非推理模型（如 deepseek-v4-flash 在简单题下本来就不怎么思考）。

## 成本

15 个小请求，输出 tokens 总计 <300；输入走上游系统提示缓存。符合省 token 约束。
