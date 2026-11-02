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

/**
 * 每响应指纹（2026-10-29 实测 flash 车道 10/10 完全一致）。
 * 用途：把"交付闸只查 id 形态"升级为"逐响应 8 项必要条件"，
 *      提高对第三方/自部署实现的拒答率；不改变 id 白名单本身。
 * 纪律：上游增删字段 → RESP_KEYS_COMPAT 必须重标定，并更新 docs/BASELINE.md 的 B13。
 */
export const RESP_KEYS_COMPAT = new Set([
  'created_at', 'error', 'id', 'incomplete_details', 'instructions', 'max_output_tokens',
  'metadata', 'model', 'object', 'output', 'parallel_tool_calls', 'reasoning', 'status',
  'temperature', 'tool_choice', 'tools', 'top_p', 'usage',
]);

/**
 * 必须存在的字段（15 项）。三项是**条件回显**，不能进必需集：
 *   · `instructions` / `metadata` —— 请求里没给时上游可能不回
 *   · `reasoning` —— 请求里没有 `reasoning` 字段时上游不回（实测：这正是 keyCount=17 的来源）
 * 因此判定改成「必需项全在 + 不许出现未知字段」，并对 `reasoning` 做请求相关的条件校验。
 */
export const RESP_KEYS_REQUIRED = [
  'created_at', 'error', 'id', 'incomplete_details', 'max_output_tokens', 'model',
  'object', 'output', 'parallel_tool_calls', 'status', 'temperature',
  'tool_choice', 'tools', 'top_p', 'usage',
];

/** output item id 形态：rs_/msg_/fc_ + 32 hex（实测 10/10） */
export const ITEM_ID_RE = /^(rs|msg|fc)_[0-9a-f]{32}$/;

/** message.content[*] 的键集（实测 3/3） */
export const CONTENT_PART_KEYS = new Set(['annotations', 'logprobs', 'text', 'type']);

/**
 * 流式必须具备的事件家族（实测 3/3 全有；缺任何一个说明实现被换）。
 * 注意：终止事件是二选一——正常结束是 `response.completed`，
 * 被 max_output_tokens 截断时是 `response.incomplete`（实测：max_output_tokens=400 + effort=high 很容易触发）。
 * 两者都算合法终止，不能只认 completed（否则会误报 38 次假警报）。
 */
export const EVENT_FAMILY_REQUIRED = [
  'response.created', 'response.in_progress',
  'response.output_item.added', 'response.output_item.done',
];
export const EVENT_TERMINAL = ['response.completed', 'response.incomplete'];

/** logprob 判据阈值（已退役，chat 协议无判据被默认封禁） */
export const P1_TOP1_MAX = -0.01;

// ---------- 2026-11-01：缺陷类判据（全部经真实上游实测）----------
// item id 必须 rs_/msg_/fc_ + 32hex 且带 UUID4 位（实测 12/12，22 次）
export const ITEM_ID_UUID4 = /^(rs|msg|fc)_[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/i;
// 各 item 类型的**必需键**（多出字段只告警，不算失败 —— 上游一周改过 3 次）
export const ITEM_KEYS_REQUIRED = {
  reasoning: ['id', 'summary', 'type'],
  message: ['content', 'id', 'role', 'status', 'type'],
  function_call: ['arguments', 'call_id', 'id', 'name', 'status', 'type'],
};
// usage 明细必需键（实测 12/12）
export const USAGE_DETAILS_REQUIRED = { input: ['cached_tokens'], output: ['reasoning_tokens'] };
// incomplete 合法原因（其它值只告警）
export const INCOMPLETE_REASONS_KNOWN = new Set(['max_output_tokens']);
// 计费恒等式（4 样本反解，Δ≤4e-19）：cost = in*1.5e-7 + out*6e-7 + cache_read*3e-9
export const BILLING = { input: 1.5e-7, output: 6.0e-7, cacheRead: 3.0e-9, allowanceRatio: 0.6 };

// ---------- 2026-11-02：按车道剖面区分（官方 / opencode 车道）----------
// 实测（官方 api.deepseek.com/v1/responses）：
//   35 个顶层字段、response.id 与 item.id 都是裸 UUID4、usage 只有 5 键（无 opencode 块）
// 实测（opencode 车道）：
//   18 个顶层字段、id 形如 rs_/msg_/fc_ + 32hex 且带 UUID4 位、usage 7 键（含 opencode 块）
//
// 结论：用一条车道的形状去卡另一条车道，是最典型的误杀来源。判据必须按剖面自适配。
export const LANE_PROFILES = ['official', 'opencode', 'unknown'];

export const ITEM_ID_VARIANTS = [
  // opencode 车道
  /^(rs|msg|fc)_[0-9a-f]{12}4[0-9a-f]{3}[89ab][0-9a-f]{15}$/i,
  // 官方：裸 UUID4
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
];

// usage 必需键：按剖面
export const USAGE_KEYS_BY_PROFILE = {
  official: ['input_tokens', 'input_tokens_details', 'output_tokens', 'output_tokens_details', 'total_tokens'],
  opencode: USAGE_KEYS_REQUIRED,
};

// 顶层字段已知集合：按剖面（多出字段只告警，不算失败）
export const RESP_KEYS_BY_PROFILE = {
  official: new Set(['background', 'completed_at', 'content_filters', 'created_at', 'error',
    'frequency_penalty', 'id', 'incomplete_details', 'instructions', 'max_output_tokens',
    'max_tool_calls', 'metadata', 'model', 'moderation', 'object', 'output',
    'parallel_tool_calls', 'presence_penalty', 'previous_response_id', 'prompt_cache_key',
    'prompt_cache_retention', 'reasoning', 'safety_identifier', 'service_tier', 'status',
    'store', 'temperature', 'text', 'tool_choice', 'tools', 'top_logprobs', 'top_p',
    'truncation', 'usage', 'user']),
  opencode: RESP_KEYS_COMPAT,
};

// ---------- 2026-11-02（P0-4）：预检按车道剖面识别 serde 文案 ----------
// 实测差异（同一个非法请求：max_output_tokens 传字符串 "abc"）：
//   opencode 车道（Go 层，做过 responses→chat 字段映射）：
//     "Failed to deserialize the JSON body into the target type: max_completion_tokens: invalid type: ..."
//   官方 api.deepseek.com（Rust 层，字段名原样）：
//     "Failed to deserialize the JSON body into the target type: max_output_tokens: invalid type: string "abc", expected u32 at line 1 column 66"
// 结论：字段名是否被改写（max_output_tokens → max_completion_tokens）本身就是一条强判别特征。
export const E_SERDE_TYPE_MSG_OFFICIAL =
  /Failed to deserialize the JSON body into the target type:\s*max_output_tokens:\s*invalid type/i;

/** 两条车道的预检期望集合：命中任意一条即 pass，并记录命中的家族 */
export const SERDE_FAMILIES = [
  { family: 'opencode-mapped', expect: E_SERDE_TYPE_MSG, extras: E_SERDE_TYPE_EXTRAS },
  { family: 'official-rust',   expect: E_SERDE_TYPE_MSG_OFFICIAL, extras: E_SERDE_TYPE_EXTRAS },
];

// ---------- 2026-11-02：模型族证据（EV10 分词一致性 / EV11 官方校验器模板）----------
// EV10：同一批 prompt 的 usage.input_tokens 若与官方逐条一致 → 同一分词器 → 同一模型族。
//   基线由官方 api.deepseek.com（deepseek-flash）实测采集，字符类覆盖中/英/码/数字/空白/emoji/长文/重复/JSON。
//   换模型（Qwen/Llama/自研）几乎必然改变分词 → 这条判据能排除"模型被换掉"。
export const TOKENIZER_CORPUS = [
  { id: 'cjk',    text: '这是一段用于分词器比对的纯中文文本，包含常见汉字与标点。', expect: 22 },
  { id: 'en',     text: 'The quick brown fox jumps over the lazy dog, repeatedly and deliberately.', expect: 18 },
  { id: 'mixed',  text: 'Hello 世界，this is 混排 test 123。', expect: 17 },
  { id: 'code',   text: 'function f(a,b){return a.map(x=>x*b).filter(Boolean)}\n', expect: 21 },
  { id: 'digit',  text: '1234567890 9876543210 31415926535897932384626', expect: 22 },
  { id: 'space',  text: 'a          b\n\n\n\tc', expect: 9 },
  { id: 'emoji',  text: '完成✅ 失败❌ 警告⚠️ 🚀🎯', expect: 19 },
  { id: 'longZh', text: '背景资料：这是一段较长的中文文本，用于验证分词一致性。'.repeat(40), expect: 604 },
  { id: 'repeat', text: 'x'.repeat(3000), expect: 379 },
  { id: 'json',   text: '{"a":1,"b":[1,2,3],"c":{"d":"中文"}}', expect: 24 },
];

// EV11：官方校验器模板（逐字）。命中且带 UUID4 request_id → 请求确实到达了官方实现。
export const OFFICIAL_ERR_TEMPLATES = [
  { id: 'temperature', body: { temperature: 9 }, re: /Invalid temperature value, the valid range of temperature is \[0, 2\]/ },
  { id: 'top_p',       body: { top_p: 2 },       re: /Invalid top_p value, the valid range of top_p is \(0, 1\.0\]/ },
  { id: 'max_tokens',  body: { max_output_tokens: 393217 }, re: /Invalid max_tokens value, the valid range of max_tokens is \[1, 393216\]/ },
];
export const UUID4_REQUEST_ID = /request_id:\s*[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;