# 安全策略

## 支持范围

只有 `main` 的最新版本在维护范围内。上游（`opencode.ai` 网关）随时可能变化，
判据失效属于已知风险，见 [docs/BASELINE.md](docs/BASELINE.md)，不作为安全漏洞处理。

## 报告方式

**不要**在公开 issue 里贴 key、token 或完整日志。优先用 GitHub 的
"Report a vulnerability"（Security → Advisories）私下提交；如果只是配置问题，
普通 issue 即可，但请先跑 `node bin\ocg.mjs diag`（输出已脱敏）再贴。

请在报告里给出：影响版本、复现步骤、实际影响、以及你认为的根因。
不需要附带你的真实 key。

## 什么算安全问题

- key / token 被写入日志、快照、响应体或任何落盘文件；
- 门控可以被本机之外访问（默认应只绑 `127.0.0.1`）；
- 绕过 `GATE_TOKEN` 校验（除"未启用 token"这一配置选择外）；
- 请求内容（prompt）进入台账或诊断输出；
- 依赖或脚本引入的供应链问题（本项目零第三方依赖，若发现引入即为问题）。

## 什么不算（已知边界，别再报）

| 现象 | 原因 |
|---|---|
| 官方模型自身"降智" | 口径明确不管 |
| 蓄意 TLS 中间人可复刻判据通过 | 黑盒可观测性的信息论边界，见 README「不解决什么」 |
| 第三方转售真官方 API 无法分辨 | 同一原因 |
| 不启用 `GATE_TOKEN` 时本机进程可白嫖 key 配额 | 文档已写明；`install.ps1` 默认生成 token |
| `/gate/*` 观测端点无需鉴权 | 仅绑回环，与 `gate/logs` 同一信任域 |
| 上游判据变化导致全部 503 | 预期行为（fail-closed），按 BASELINE 处理 |

## 处理预期

个人项目，不承诺 SLA。收到报告后会尽快确认；修复会在
[docs/CHANGELOG.md](docs/CHANGELOG.md) 中标注是否触碰网络 / 文件 / 环境变量。
