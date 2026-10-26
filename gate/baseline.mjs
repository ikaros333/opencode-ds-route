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
 */

/** 基线观测日期：改动本文件任何常量时同步更新 */
export const OBSERVED_AT = '2026-10-23';

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

/** responses 协议 e1：缺 input 时 DeepSeek Rust 服务端 serde 层原话（第三方兼容层不产出该文本） */
export const E1_MSG = /Either input or instructions must be provided/i;

/** 已退役（网关层自行拦截，不再穿透）：保留常量便于重新标定时对照 */
export const E2_MAX = /valid range of max_tokens is \[1, 393216\]/i;
export const E3_RANGE = /valid range of temperature is \[0, 2\]/i;

/** 网关自身拦截时的话术：既不是官方也不是第三方，单列一类 */
export const GATEWAY_BLOCK = /Upstream request failed|Endpoint is unavailable|Model is unavailable/i;

/** logprob 判据阈值（已退役，chat 协议无判据被默认封禁） */
export const P1_TOP1_MAX = -0.01;
