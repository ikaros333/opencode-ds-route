/**
 * baseline.mjs — 判据基线：所有「上游长什么样」的常量，唯一来源。
 *
 * 为什么单独成文件：
 *   这些常量原来分散在 gate/oc-gate.mjs（id 形态、messages 状态码指纹）和
 *   probe/official-detect.mjs（e1 文案、网关错误文案）两处。上游一旦变化，
 *   必须同时改两边；漏一边的结果是「预检说 pass、交付却 503」这种最难查的状态。
 *   现在两边都 import 这里，改一次全局生效，且 verify-patch 会断言别处不得复制字面量。
 *
 * 改动纪律：
 *   - 每次改动都要更新 OBSERVED_AT，并在 docs/BASELINE.md 记一行「观测事实 + 日期」；
 *   - 这些数字全部来自对 opencode.ai 网关的黑盒观察，不是任何文档承诺；
 *   - 上游变化时优先怀疑这里，而不是先怀疑门控逻辑。
 *
 * 观测记录（详细对照表见 docs/BASELINE.md）：
 *   2026-10-19  responses 官方 id 37/37 = UUIDv4；第三方 38/38 非 UUIDv4
 *   2026-10-19  messages 9 项非法参数的状态码指纹 400×6,422×3，官方与 OC 各 3 轮一致
 *   2026-10-23  resp_ 与 UUIDv4 由上游双池随机决定，不存在「强制 UUIDv4」的旋钮
 *   2026-10-27  opencode.ai 下线 deepseek-flash（410 ModelDeprecated → deepseek-v4.1-flash）；
 *               e1 不再穿透（503 Endpoint is unavailable）→ 主判据换成 serde 422 文案；
 *               messages 端出现非 UUID4 的 53 位 hex id 池 → messages 默认封禁
 */

/** 基线观测日期：改动本文件任何常量时同步更新 */
export const OBSERVED_AT = '2026-10-27';

/** 官方 responses 直出 id：UUID v4 */
export const ID_UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 任意版本 UUID：**不算**官方证据，仅用于把 uuid1/3/5 与「完全不像 UUID」区分开 */
export const ID_UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 允许交付的 id 形态：
 *   UUID4      : 官方 endpoint 直出
 *   resp_uuid4 : OpenCode 网关改写产物，后缀是「UUID4 去横线」的位模式（第13位=4，第17位∈89ab）
 *   resp_      : 仅 GATE_RESP_SHAPE_STRICT=0 的应急回退模式（恢复旧行为）
 * resp_bad（resp_ 前缀但后缀不是 UUID4 位模式）不在白名单内 → 一律拒绝。
 */
export const DELIVERABLE_SHAPES = new Set(['UUID4', 'resp_uuid4', 'resp_']);

/** messages 协议：9 项非法参数请求的期望状态码序列（分两层校验：400 业务层 / 422 反序列化层） */
export const MSG_FINGERPRINT = '400,400,400,400,400,400,422,422,422';

/**
 * 2026-10-27 在 deepseek-v4.1-flash 上实测到的 messages 指纹（漂移留档，**未启用**）。
 * 现行默认已封禁 messages（见 oc-gate 的 BLOCKED_PROTOS），因此该值只作重新标定时的对照。
 * 漂移点：max_tokens=0 由 400 变 200、缺 messages 由 422 变 500、非法 role 由 400 变 200，
 * 且正常响应的 id 有约 5/8 落到 53 位 hex 池（非 UUID4）——两条都指向「messages 侧混入了非官方实现」。
 */
export const MSG_FINGERPRINT_2026_10_27 = '200,400,400,400,400,500,200,500,422';

/**
 * responses 协议主判据（2026-10-27 16:5x 第二次标定）：非法**类型**触发 serde 反序列化失败。
 * 原文（实测 2/2 稳定，2026-10-27）：
 *   Upstream request failed: [invalid_request_error] Failed to deserialize the JSON body into the
 *   target type: max_completion_tokens: invalid type: string "abc", expected u32
 *   at line 1 column 121 (request_id: <网关 id，形如 gw-xxxxxxxxxxxx-n>)
 * 为什么换成它：
 *   · 上一版判据（E_SERDE_MSG，非法 reasoning.effort 枚举）已失效——上游现在对该字段
 *     **完全不校验**（200 接受任意值），该探针恒 drift → 预检永久 fail → 全量 503。
 *   · 类型校验比枚举校验稳定得多：枚举会随版本增删，类型不会。
 *   · 附带强特征：我们发的是 `max_output_tokens`，报错里回显成 **`max_completion_tokens`**
 *     （OpenAI 字段名），说明中间层做过 responses→chat 的字段映射，第三方很难恰好复现这个组合。
 * 已失效的旧证据：`request_id` 不再是官方 UUID4，改成了网关自己的 `gw-<hex>-<n>`。
 */
export const E_SERDE_TYPE_MSG =
  /Failed to deserialize the JSON body into the target type:\s*max_completion_tokens:\s*invalid type/i;

/** 与 E_SERDE_TYPE_MSG 同时成立才认：serde 的目标类型 + 行列位置（半句话转发层不产出） */
export const E_SERDE_TYPE_EXTRAS = [/expected u32/i, /at line 1 column \d+/i];

/**
 * 已退役（2026-10-27 晚间）：非法 reasoning.effort **不再被拒**（上游 200 接受），恒 drift。
 * 保留常量供对照，勿再作判据——留着当判据会让预检永久 fail。
 */
export const E_SERDE_MSG = /Failed to deserialize the JSON body into the target type:\s*reasoning_effort/i;

/** 已退役（2026-10-27：网关不再为该用例穿透，恒返回 503 Endpoint is unavailable） */
export const E1_MSG = /Either input or instructions must be provided/i;

/** 已退役（网关层自行拦截，不再穿透）：保留常量便于重新标定时对照 */
export const E2_MAX = /valid range of max_tokens is \[1, 393216\]/i;
export const E3_RANGE = /valid range of temperature is \[0, 2\]/i;

/** 网关自身拦截时的话术：既不是官方也不是第三方，单列一类 */
export const GATEWAY_BLOCK = /Upstream request failed|Endpoint is unavailable|Model is unavailable/i;

/**
 * responses 应答**必须**包含的 usage 键（2026-10-27 实测：20/20 完全一致）。
 * 为什么用它当判据：这是"网关正常形态"的稳定特征；缺键说明链路被换/被改写。
 * 注意：`cost`/`opencode` 是 OpenCode 网关注入的，官方直连没有 —— 所以这条只能
 * 证明"这是本网关的正常形态"，不能证明"官方后端"。如实记录在 docs/BASELINE.md。
 */
export const USAGE_KEYS_REQUIRED = [
  'cost', 'input_tokens', 'input_tokens_details',
  'opencode', 'output_tokens', 'output_tokens_details', 'total_tokens',
];

/**
 * 实现指纹向量（**仅观测，不参与放行**）：5 个参数探针的返回码序列。
 * 2026-10-27 实测：同一条探针在不同时刻给出 422 / 200 两种结果（上游至少两个实现轮询），
 * 因此它不可作为放行条件（会让门控随机 503），只用于"实现换了"的告警。
 * 探针顺序：max_output_tokens:"abc" / temperature:"hot" / top_p:"x" / instructions:123 / tool_choice:123
 */
export const IMPL_VECTOR_2026_10_27 = '422,422,200,503,503';

/** logprob 判据阈值（已退役，chat 协议无判据被默认封禁） */
export const P1_TOP1_MAX = -0.01;
