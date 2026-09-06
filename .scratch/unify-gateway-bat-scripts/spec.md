# unify-gateway-bat-scripts — spec

## Problem

根目录有 5 个启动脚本(start/stop/restart.bat + 启动/停止网关.bat),职责重叠、行为不一(start.bat 前台占窗口、restart.bat 弹新窗、timeout 命令在重定向下会失败、启动网关.bat 的 `\"--bg\"` 比较写法可疑)。用户只要三个:**启动网关 / 停止网关 / 重启网关**,且要求实测可用、中文不乱码。

## Solution

保留并完善 启动网关.bat(隐藏窗口守护 + 崩溃自启 + 防多开 + 打开面板)、停止网关.bat(杀 3050 进程,内容不动)、新增 重启网关.bat(停 → 等端口释放 → 委托启动网关后台流);删除 start/stop/restart.bat。全部 `chcp 65001 + UTF-8(无 BOM) + CRLF + ping 等待`(timeout 在输入重定向下必挂,是中文环境之外的第二大 bat 坑)。浏览器打开仅在交互路径,支持 `--no-browser` 供测试。

## Slices

- [ ] Slice 1: test_scripts.py(缝 = cmd 真实运行三脚本,断言端口状态迁移 启动→listening、重启→PID 变化、停止→释放 + UTF-8 严格解码无 U+FFFD)→ 先红
- [ ] Slice 2: 写三脚本(UTF-8/CRLF)、git rm 旧三脚本、SPEC.md 文件树同步 → 后绿

## Testing Decisions

- 缝选在 OS 边界:python `subprocess` 调 `cmd /c <脚本>`,轮询 `/health` 与 netstat PID —— 这是用户双击时的真实路径。
- 红线:三脚本必须能被 UTF-8 严格解码且含 `chcp 65001`(防 GBK/UTF-8 混写乱码);输出不得含 U+FFFD。
- 每次测试后停回网关(测试自清理,终态 = 端口空闲)。

## Out of Scope

- 网关本体代码改动;端口/路径可配置化;计划任务/服务化安装。

## Checks

- i18n: Pass — 脚本内中文走 chcp 65001 + UTF-8,测试断言无乱码。
- save: N/A — 不涉及持久化格式。
- red-line: Pass — 无数值决策新增。

## Notes

- `timeout /t N` 在 stdin 重定向(python subprocess / 管道)下直接报错 —— 全部改用 `ping -n N 127.0.0.1`。现有 停止网关.bat 已是 ping,原样保留。
- 原 启动网关.bat 的 `if not "%~1"==\"--bg\"` 反斜杠转义在 cmd 中无此语义,阅读上无法推断其比较结果(实测下 `--bg` 能匹配、链会收敛,但语义不可读);重写为 `if "%~1" neq "--bg"`,行为等价、可读。
- 防多开前置:端口已监听时直接提示 + 打开面板退出,不再进入守护循环;浏览器打开收敛到交互路径,`--no-browser` 供自动化测试。
- `timeout /t N` 在 stdin 重定向(双击以外的一切场景:python subprocess、管道)下直接报错 —— 全部改用 `ping -n N 127.0.0.1`。现有 停止网关.bat 已是 ping,原样保留。
- 实测发现的真缺陷(已修):杀守护 cmd 不会杀 node 子进程(Windows 无进程树击杀),守护会在 3 秒后把网关拉回 → 停止/重启改用 `taskkill /PID <daemon> /T /F` 整树击杀 + 5 轮「击杀→验证端口」循环。
- 观测教训:python subprocess 管道会被 bat 的隐藏孙进程握住写端导致 communicate() 永久挂死 → 测试输出一律重定向到文件。
