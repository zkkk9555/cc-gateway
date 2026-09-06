# paid-model-smoke — spec

## Problem

压测只能用免费模型;用户需要确认**付费/普通套餐模型**经网关也正常,但明确要求省 token。

## Solution

新增 `test_paid_smoke.py`(手动按需运行,不进任何常规套件):对指定模型各发 **1 个流式** chat 请求(`max_tokens=64`,一句中文 prompt),断言 HTTP 200、SSE 事件流完整(`finish_reason` + `[DONE]`)、usage 上报非零。默认三个用户点名模型。

## Implementation Decisions

- 缝 = 客户端 HTTP(`/v1/chat/completions`),最高缝,零 mock。
- `max_tokens=64`:muse-spark 是推理模型,输出可能全为 reasoning——**断言事件流与 finish,不断言正文非空**(与 test_stress P1 同口径)。
- 覆盖面:三模型分别命中 直连路由(deepseek)/ 代理路由(gpt-5.6-luna、muse-spark)/ 推理与标准两种事件形态。
- 模型清单可经 argv 覆盖;脚本头部显著标注「消耗真实额度」。

## Testing Decisions

- 唯一验证 = 实跑一次贴原文(这正是任务本身);无红绿(被测物是外部模型可用性,非产品代码)。
- 失败处置:某模型失败 → 先重试一次排除上游抖动,再分类(403 套餐 / 429 / 超时)报告,不盲目修网关。

## Out of Scope

- 非流式/工具调用/多轮(付费成本约束下从简);任何网关代码改动。

## Checks

- i18n: N/A。save: N/A。red-line: Pass —— token 消耗为用户明示的最小验证成本(3×~64 输出 tokens,prompt 走上游缓存)。

## Notes

- 同轮记录:用户否决「完整断连中止」提案(不再实施,记忆+JOURNAL 已记)。
