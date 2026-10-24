# 免责声明

本仓库是一个本地工具，**不隶属于 OpenCode 或 DeepSeek，也未获得任何一方的授权、许可或背书**；
项目名里的 "opencode" 仅用于说明它对接的服务。

## 风险

1. **可能触及 OpenCode Go 的服务条款。** 套餐内的模型路由由 OpenCode 网关决定；本工具**不改变路由**，
   只在本地判断"这次响应是否来自官方 DeepSeek 后端"，并对不符合预期的响应返回 503。
   这种"按上游身份筛选响应"的用法是否被服务方允许，需你自行核实服务条款；
   由此产生的后果（包括账号受限、套餐被调整等）由使用者承担。
2. **可能影响第三方利益。** 若你的使用方式实际绕开或规避了 OpenCode 与其合作方、第三方池之间的安排，
   相关商业、合同或合作关系上的风险同样由使用者承担，与作者无关。
3. **不提供任何担保。** 软件按"现状"提供，不保证可用性、判据长期有效、或能跟上上游变更；
   因使用造成的配额消耗、服务中断、数据或业务损失，作者不承担责任。

## 使用边界

- 仅限**单机、自用、单 key**；不要用它做多用户转售、共享 key，或对外提供代理/中转服务；
- 不要用它规避计费、批量注册、对抗风控，或对第三方进行探测与攻击；
- 上游条款或路由规则变化时，以服务方公告为准；本项目不提供任何形式的"合规背书"。

**如果你不接受以上任何一条，请不要使用本项目。**

本声明不构成法律意见；具体权利义务以服务方条款和适用法律为准。

<details>
<summary>English summary</summary>

This is an unaffiliated personal project. It is not endorsed by, authorized by, or connected to
OpenCode or DeepSeek. It does **not** change how OpenCode routes requests: it only inspects the
response locally and returns 503 when the response cannot be shown to come from the official
DeepSeek backend. Using it may conflict with OpenCode Go's terms of service or with arrangements
between OpenCode and third-party providers; you are responsible for checking the terms and for any
consequences. The software is provided "as is", without warranty of any kind. Intended for
single-machine, single-key, personal use only — not for resale, key sharing, proxy services,
billing evasion, or attacking third parties.

</details>
