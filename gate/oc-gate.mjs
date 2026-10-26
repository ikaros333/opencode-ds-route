// oc-gate.mjs — OpenCode Go「官方路由」门控代理 v3（fail-closed + 探针优先 + 矩阵缓存 + 多信号投票）
//
// 设计要点（每条都有实测支撑，见 PLAN.md / REPORT.md）：
//   1. 判定证据：① 响应头 x-opencode-endpoint-id（若回归优先）② 响应体顶层 id 是否为 UUIDv4
//      实测：官方 37/37 = UUIDv4；第三方 38/38 ≠ UUIDv4（HEX32 / resp_ / chatcmpl / gw- / 纯数字）
//   2. 辅助证据：responses 协议下官方带 completed_at；第三方缺（作为投票加权，抗伪装）
//   3. 探针优先：路由由 (model, protocol) 决定，与 prompt/会话无关（实测：同 (model,proto) 不同 session 一致）
//      → 先用 max_output_tokens=1 的微型探针判定，命中官方才发主请求，避免大 prompt 被第三方吃掉 input token
//   4. 矩阵缓存：verdict 按 model|protocol 缓存 120s，命中即免探针（仍对主请求做 peek 复核，双保险）
//   5. 主请求自身复核：任何交付前的最后一票来自真实响应，探针只用于排序与省钱
//
// 环境变量：
//   OPENCODE_GO_API_KEY（必填）
//   GATE_PORT=8787
//   GATE_CHAIN="deepseek-flash,deepseek-v4.1-flash"   （default：优先 deepseek-flash，实测官方车道更稳）
//   GATE_MAX_ATTEMPTS=4  GATE_BACKOFF_MS=200  GATE_PROBE_TTL_MS=120000
//   GATE_PROBE=1|0                    是否启用探针（默认 1）
//   GATE_FORCE_THIRD=1                自检：强制判第三方
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
// 判据基线唯一来源：id 形态 / messages 状态码指纹 / e1 文案都从这里拿。
// 不要在别处复制字面量——verify-patch 会断言这一点。
import {
  ID_UUID4 as UUID4,
  ID_UUID_ANY as UUID_ANY,
  DELIVERABLE_SHAPES,
  MSG_FINGERPRINT,
  E1_MSG,
  OBSERVED_AT,
} from './baseline.mjs';

// ---------- 配置安全解析 ----------
// 直接 Number(process.env.X) 在值是 "abc"/空串时会得到 NaN，而 NaN 参与比较永远为 false，
// 会让「预算/超时/重试次数」这类控制变量静默失效（例如 req.setTimeout(NaN) 等于不设超时 → 永久挂起）。
// 统一走 num()：非法值回落默认并记一条告警，绝不让 NaN 进入运行时。
const CONFIG_WARNINGS = [];
function num(name, def, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const v = Number(raw);
  if (!Number.isFinite(v)) { CONFIG_WARNINGS.push(`${name}="${raw}" 不是有效数字，回落到 ${def}`); return def; }
  if (v < min) { CONFIG_WARNINGS.push(`${name}=${v} 小于下限 ${min}，已夹到 ${min}`); return min; }
  if (v > max) { CONFIG_WARNINGS.push(`${name}=${v} 大于上限 ${max}，已夹到 ${max}`); return max; }
  return v;
}
const PORT = num('GATE_PORT', 8787, { min: 1, max: 65535 });
const KEY = process.env.OPENCODE_GO_API_KEY || '';
// 可选本地鉴权。绑回环 ≠ 安全：本机任何进程都能直接 POST 8787，白嫖你的 key 配额。
// GATE_TOKEN 非空时，/v1/* 代理请求必须带 x-gate-token；/gate/* 只读观测端点不受影响。
// 留空 = 关闭（手工路径的默认），install.ps1 会生成并默认开启。
const GATE_TOKEN = process.env.GATE_TOKEN || '';
/**
 * 常量时间比较：本地回环上时序攻击不现实，但比较逻辑本身不该随内容提前返回。
 * 长度不同直接 false（timingSafeEqual 要求等长）。
 */
const tokenMatches = (got) => {
  if (!GATE_TOKEN) return true;
  const a = Buffer.from(String(got ?? ''));
  const b = Buffer.from(GATE_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const CHAIN = (process.env.GATE_CHAIN || 'deepseek-flash,deepseek-v4.1-flash')
  .split(',').map(s => s.trim()).filter(Boolean);
const MAX_ATTEMPTS = num('GATE_MAX_ATTEMPTS', 4, { min: 1, max: 64 });
const BACKOFF_MS = num('GATE_BACKOFF_MS', 200, { min: 0, max: 60000 });
// 同车道重试：仅针对连接层错误（ECONNRESET/超时/socket hang up），不换模型、不降验证标准
const LANE_RETRY = num('GATE_LANE_RETRY', 2, { min: 0, max: 16 });
const LANE_RETRY_MS = num('GATE_LANE_RETRY_MS', 300, { min: 0, max: 60000 });
// ★ 2026-10-23：车道健康记忆。
// 实测事故（09:36–09:50）：deepseek-flash 在 responses 上连续返回
// 400 {"code":"server_error","message":"Upstream response was invalid"}，
// 而 v4.1-flash 正常。每次请求都要先在坏车道白等 3 次（~7.5s）才换道，
// 首字节被拖到 25–29s。这里记住「刚失败过的车道」，后续请求把它排到末尾。
const LANE_COOLDOWN_MS = num('GATE_LANE_COOLDOWN_MS', 60000, { min: 0, max: 600000 });
// 4xx 伪装 server_error 时只重试 1 次（5xx 仍用满 LANE_RETRY）：
// 该错误在过载窗口内对该车道是**确定性**的，多试只是白烧配额与时间。
const SERVER_ERR_4XX_RETRY = num('GATE_SERVER_ERR_4XX_RETRY', 1, { min: 0, max: 16 });
// ★ 2026-10-23（审查修复）：冷却键必须带「体积档」。
//
// 原键是 `${model}|${proto}`，不含体积。而车道失败是**与体积相关**的：
// 实测同一车道对大包(>512KB)返回 400 server_error，对小包完全正常。
// 键里没有体积维度 → 一次大包失败会把该车道在**所有**请求上降级 10 分钟，
// 小包本可继续用它的请求被强行改道到另一模型，而**模型不同 ⇒ prompt cache 不同**
// （实测：切模型后 cached_tokens 归零），于是每次降级边界都要付一次冷 prefill。
//
// 审查实测（mock：大包在 flash 上 400，小包两车道都 200）：
//   ① 500KB 请求 → deepseek-flash(400) ×2 → v4.1-flash(200)，正确
//   ② 紧接着 1KB 请求 → **直接 v4.1-flash**，跳过了本可成功的 deepseek-flash  ← 缺陷
// 现在把体积档并入键后，②重新回到 deepseek-flash。
const laneCooldown = new Map();   // `${model}|${proto}|${sizeClass}` -> 到期时间戳
const BIG_PAYLOAD_BYTES = num('GATE_BIG_PAYLOAD_BYTES', 512 * 1024, { min: 0, max: 64 * 1024 * 1024 });
const BIG_PAYLOAD_COOLDOWN_MS = num('GATE_BIG_PAYLOAD_COOLDOWN_MS', 600000, { min: 0, max: 3600000 });
// 体积档：只有两档。大包的失败模式（schema 解析/校验）与小包不同，必须分开记忆。
const sizeClassOf = (bytes) => (BIG_PAYLOAD_BYTES > 0 && bytes >= BIG_PAYLOAD_BYTES) ? 'B' : 'S';
const laneKey = (m, p, cls) => m + '|' + p + '|' + cls;
function laneCooling(m, p, cls) {
  const k = laneKey(m, p, cls);
  const until = laneCooldown.get(k);
  if (!until) return false;
  if (Date.now() >= until) { laneCooldown.delete(k); return false; }
  return true;
}
function markLaneBad(m, p, bytes = 0) {
  const cls = sizeClassOf(bytes);
  const ms = cls === 'B' ? BIG_PAYLOAD_COOLDOWN_MS : LANE_COOLDOWN_MS;
  if (ms > 0) laneCooldown.set(laneKey(m, p, cls), Date.now() + ms);
}
function preferHealthyLanes(list, p, bytes = 0) {
  const cls = sizeClassOf(bytes);
  const good = list.filter(m => !laneCooling(m, p, cls));
  const bad = list.filter(m => laneCooling(m, p, cls));
  return good.concat(bad);   // 稳定：冷却中的车道保留在后备位置，不剔除
}
const PROBE_TTL = num('GATE_PROBE_TTL_MS', 120000, { min: 0, max: 86400000 });
const USE_PROBE = (process.env.GATE_PROBE ?? '1') === '1';
const FORCE_THIRD = process.env.GATE_FORCE_THIRD === '1';
// 自检：只把「主请求」的结论强制成 third，不影响预检/探测。
// 用于验证「缓存 pass + 主请求 third → 强制实时重验」这条路径（FORCE_THIRD 会连
// trustDecision 一起锁死，走不到该分支，所以需要这个更窄的注入点）。
const FAULT_MAIN_THIRD = process.env.GATE_FAULT_MAIN_THIRD === '1';
// ★ 2026-10-21：GATE_BLIND_MODE / GATE_BLIND_ALLOWLIST 已移除。
// 「无证明也交付」的观察期通道在交付前置闸之下已不可达，留着开关只会误导。
const HEDGE = (process.env.GATE_HEDGE ?? '1') === '1';                 // 对冲：并行发次选
const REFRESH_MS = num('GATE_REFRESH_MS', 300000, { min: 0, max: 86400000 });      // 后台预热刷新（0=关）；5 分钟足以避免冷启动，又不浪费配额
const MAX_CONC = num('GATE_MAX_CONC', 6, { min: 1, max: 256 });               // 上游并发上限
const SNAPSHOT_FILE = process.env.GATE_SNAPSHOT
  || path.join(import.meta.dirname, 'logs', 'matrix.json');

// ---------- 官方性证明（proof）接入 ----------
// 由 probe/official-detect.mjs 周期写入，门控只读不生产。
//   enforce : proof 过期/失败 → fail-closed
//   monitor : 只记录，不影响放行（观察期默认）
//   off     : 完全忽略 proof，回到纯 id 判定（应急回滚）
const PROOF_MODE = (process.env.GATE_PROOF_MODE || 'monitor').toLowerCase();
const PROOF_FILE = process.env.GATE_PROOF_FILE
  || path.join(import.meta.dirname, 'logs', 'official-proof.json');
// proof 的最大采信龄期；O3 自适应：trust 不足时自动收紧
const PROOF_MAX_AGE_MS = num('GATE_PROOF_MAX_AGE_MS', 600000, { min: 1000, max: 86400000 });
const PROOF_STRICT_AGE_MS = num('GATE_PROOF_STRICT_AGE_MS', 120000, { min: 1000, max: 86400000 });
// 重读磁盘的最小间隔（避免每请求都 stat）
const PROOF_RELOAD_MS = num('GATE_PROOF_RELOAD_MS', 5000, { min: 0, max: 600000 });

// 运行计数（/gate/metrics）
// 所有计数键必须在这里有初值：否则 /gate/metrics 的 schema 会随「某个分支是否被触发」
// 而变化（首次触发前键不存在，监控脚本按固定键解析会拿到 undefined）。
// 运行时仍沿用 (metrics.x || 0) + 1 的写法，与初值并存不影响行为。
const metrics = { requests: 0, pass: 0, passUnverified: 0, blocked: 0, hedged: 0, skippedThird: 0, probes: 0, abortedByClient: 0, laneRetries: 0, passthrough: 0, rateLimited: 0, serverErrors: 0, staleRechecks: 0, budgetExhausted: 0, queuedAborted: 0, forcedThird: 0, proofPass: 0, proofPartial: 0, proofStale: 0, passByProof: 0, prechecks: 0, precheckFail: 0, precheckUnsupported: 0, precheckFailOverridden: 0, probeSkippedByPrecheck: 0, blockedByPolicy: 0, schemaRefsFixed: 0, precheckConfirm: 0, precheckJitterRecovered: 0, upstreamUnreachable: 0,
  // 以下键原先只在首次触发时动态出现（P2-2）
  passUnverifiedPolicy: 0, precheckFailProofStale: 0, thirdRevalidated: 0, thirdRevalidateRejected: 0, thirdBlockedByLiveFail: 0, httpParseErrors: 0, clientResets: 0, refreshSkippedByPrecheck: 0, precheckNotPass: 0,
  // 第 17 轮：身份白名单的拒绝计数
  rejectedThirdShape: 0, rejectedUnknownShape: 0 };

// 启动自检结论（第 17 轮，/gate/health 暴露给 watchdog 判活）
let startupSelfTest = null;

// ---------- 延迟窗口（最近 N 条请求的总耗时，用于 p50/p90/p95/p99） ----------
const LAT_WINDOW = num('GATE_LAT_WINDOW', 200, { min: 1, max: 100000 });
const latencies = [];            // 环形，只存数字
let latTotal = 0, latCount = 0;  // 进程生命周期内的累计值
function recordLatency(ms) {
  if (!Number.isFinite(ms) || ms < 0) return;
  latencies.push(ms);
  if (latencies.length > LAT_WINDOW) latencies.shift();
  latTotal += ms; latCount++;
}
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[i];
}
function latencySnapshot() {
  const s = [...latencies].sort((a, b) => a - b);
  return {
    window: LAT_WINDOW,
    n: s.length,
    p50: percentile(s, 0.50), p90: percentile(s, 0.90),
    p95: percentile(s, 0.95), p99: percentile(s, 0.99),
    min: s.length ? s[0] : null,
    max: s.length ? s[s.length - 1] : null,
    avgRecent: s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null,
    avgAllTime: latCount ? Math.round(latTotal / latCount) : null,
    totalSampled: latCount,
  };
}

// ---------- 最近失败摘要（/gate/alerts） ----------
const FAIL_WINDOW = num('GATE_FAIL_WINDOW', 20, { min: 1, max: 10000 });
const recentFailures = [];
let lastSuccessAt = null;
/**
 * kind: client（400/404/405/413）| route（503 无官方路由）| rate-limit | upstream-4xx
 * 只保留结构化字段，绝不记录请求/响应正文。
 */
function recordFailure(rec) {
  recentFailures.push({ ts: new Date().toISOString(), ...rec });
  if (recentFailures.length > FAIL_WINDOW) recentFailures.shift();
}

// 简单并发闸门
let inflight = 0;
let peakInflight = 0;
const waiters = [];
/**
 * 抢占一个上游并发槽位。
 * signal 被 abort（客户端断开）时立即放弃排队，避免为一个已经没有接收方的请求白烧上游配额。
 */
async function withSlot(fn, signal) {
  if (inflight >= MAX_CONC) {
    await new Promise((resolve, reject) => {
      const entry = { resolve, reject };
      waiters.push(entry);
      if (signal) {
        if (signal.aborted) {
          const i = waiters.indexOf(entry); if (i >= 0) waiters.splice(i, 1);
          return reject(new Error('aborted while queued'));
        }
        signal.addEventListener('abort', () => {
          const i = waiters.indexOf(entry);
          if (i >= 0) { waiters.splice(i, 1); metrics.queuedAborted++; reject(new Error('aborted while queued')); }
        }, { once: true });
      }
    });
  }
  inflight++;
  if (inflight > peakInflight) peakInflight = inflight;
  try { return await fn(); }
  finally { inflight--; const w = waiters.shift(); if (w) w.resolve(); }
}

const FORBIDDEN = new Set(['deepseek-v4-flash', 'deepseek-flash-1017']); // 用户硬约束
const ALLOWED = CHAIN.filter(m => !FORBIDDEN.has(m));

// ★ 第 17 轮：身份白名单 —— 允许交付的响应 id 形态（唯一定义点，勿在别处硬编码）。
// 目标：只接受官方后端；第三方（自部署 / 异模型 / 第三方池）一律拒绝；官方自身降智不管。
//   UUID4      : 官方 endpoint 直出（实测官方 responses 全 UUID4）
//   resp_uuid4 : OpenCode 网关改写产物，但后缀是「UUID4 去横线」的位模式（第13位=4，第17位∈89ab）。
//                实测 35/35 样本符合；随机 32hex 命中该模式概率 1/64 → 8 连中≈1e-14
//                ⇒ 它是 UUID4 的变形，不是网关自造。
//   resp_bad   : resp_ 前缀但后缀不符合 UUID4 位模式（或不是 32 hex）→ 判第三方伪造，拒绝。
//   resp_      : 仅 GATE_RESP_SHAPE_STRICT=0（应急回退）时出现，恢复旧行为。
// 其余形态（HEX32 / chatcmpl / gw- / other / numeric / 空 id）一律拒绝，不再允许「重验翻案」。
// 白名单本身定义在 baseline.mjs（判据常量唯一来源）。

// ★ resp_ 后缀位模式校验开关。0 = 回退；其它任何值（未设置 / "1" / 空串 / 拼错 / "true"）= 严格。
//   原写法 `?? '1'` 有 fail-open：空串与 "true" 都不等于 '1'，会静默回退到旧行为（伪造 resp_ 被放行）。
//   配置错误必须 fail-closed：只有显式 '0' 才回退，非 0/1 的值记一条告警。
const RESP_SHAPE_RAW = process.env.GATE_RESP_SHAPE_STRICT;
const RESP_SHAPE_STRICT = RESP_SHAPE_RAW !== '0';
if (RESP_SHAPE_RAW !== undefined && RESP_SHAPE_RAW !== '' && RESP_SHAPE_RAW !== '0' && RESP_SHAPE_RAW !== '1') {
  CONFIG_WARNINGS.push(`GATE_RESP_SHAPE_STRICT="${RESP_SHAPE_RAW}" 不是 0/1，按严格模式处理（只有 "0" 才回退）`);
}

/** UUID4 去横线后的位模式：第 13 位版本号必须是 4，第 17 位变体必须是 8/9/a/b */
const UUID4_BITS = (h) => typeof h === 'string'
  && /^[0-9a-f]{32}$/i.test(h)
  && h[12].toLowerCase() === '4'
  && '89ab'.includes(h[16].toLowerCase());


const HOST = process.env.GATE_HOST || 'opencode.ai';
const HOST_PORT = num('GATE_HOST_PORT', 443, { min: 1, max: 65535 });
const HOST_SCHEME = process.env.GATE_HOST_SCHEME || 'https';
const transport = HOST_SCHEME === 'http' ? http : https;
// GATE_TRACE=1：把每次出网目标打到 stderr（只有 host:port + path，不含请求头/正文/key）。
// 用途：用户自己核对「这个门控只连 opencode.ai」——见 docs/AUDIT.md 的验毒流程。
if (process.env.GATE_TRACE === '1') {
  const origRequest = transport.request.bind(transport);
  transport.request = (opts, cb) => {
    try { console.error(`[trace] ${opts.host}:${opts.port}${opts.path}`); } catch {}
    return origRequest(opts, cb);
  };
}
// 与 dsh 的重试窗口（约 27s）对齐：等太久只会让 dsh 重发、上游白烧配额
const UPSTREAM_TIMEOUT_MS = num('GATE_UPSTREAM_TIMEOUT_MS', 60000, { min: 1000, max: 600000 });
// 响应头到达后，body 阶段允许的**无数据**间隔。只要还有字节流入就不断。
//
// 为什么需要它：Node 的 req.setTimeout 是 socket 空闲超时，不是总时长。而非流式请求
// 在上游把整段输出生成完之前**一个字节都不发**，整个推理期间 socket 处于空闲状态，
// 会被「等待响应头」那个超时直接 destroy —— 这是长输出 503 的真正原因（实测 16K
// token 输出需 44s，在 TOTAL_BUDGET_MS=45s 下几乎没有余量，一超就被砍）。
//
// 输出时长由「用户要多少字」决定，与路由判定无关，不该受路由预算约束。
// 现在 realRequest 在收到响应头的瞬间 req.setTimeout(0)，body 阶段只由本值兜底。
const BODY_IDLE_TIMEOUT_MS = num('GATE_BODY_IDLE_TIMEOUT_MS', 120000, { min: 1000, max: 1800000 });
// ★ 2026-10-23 审查修复：单次尝试原本**没有墙钟硬上限**。
// req.setTimeout 是 socket 空闲超时，且收到响应头后被置 0；body 阶段只剩
// BODY_IDLE_TIMEOUT_MS（也是空闲超时）。上游只要持续发 SSE 心跳（每秒 1 条 ping），
// socket 就永不空闲 → 空闲超时永不触发 → 该次尝试无限期挂住。
// 实测复现：BODY_IDLE_TIMEOUT_MS=3000 时，带心跳的上游挂满 45s 仍未断开。
// 另有一次真实事故：机器连接待机 31 分钟，唤醒后那条僵尸尝试结算成 ms=1,857,520。
// 因此补一道墙钟硬上限：正常长输出（16K token≈44s）不受影响，僵尸尝试必然被切断。
const ATTEMPT_HARD_CAP_MS = num('GATE_ATTEMPT_HARD_CAP_MS', 180000, { min: 5000, max: 900000 });
// 上游整体不可达的快速失败：达到该数量的不同车道都拿不到任何 HTTP 响应时立即收敛。
// 实测（2026-10-20）：opencode.ai 瞬时不响应时，门控按 LANE_RETRY 逐个超时烧满 45s 预算，
// 而 dsh 自身还会重试 5 次 → 用户侧要等数分钟。这里改为提前放弃。
const UPSTREAM_FAST_FAIL_LANES = num('GATE_UPSTREAM_FAST_FAIL_LANES', 2, { min: 1, max: 16 });
// 单次请求的总预算：所有尝试（含重试与换道）耗时之和的上限。
// 超过它就立刻 fail-closed 返回，避免门控还在等而 dsh 早已超时重发，造成请求叠加。
//
// 注意它约束的是「路由判定过程的耗时」（探针 + 多次尝试 + 换道），**不是单次推理的
// 输出时长** —— 后者由 BODY_IDLE_TIMEOUT_MS 兜底。原值 45000 会把长输出误杀：
// 实测 16K token 输出需 44s，加上探针 2s 就超预算 → gate_budget_exhausted 503。
const TOTAL_BUDGET_MS = num('GATE_TOTAL_BUDGET_MS', 60000, { min: 5000, max: 600000 });
// 单个探针的超时；必须远小于总预算，否则上游 hang 时探针会把预算吃光
const PROBE_TIMEOUT_MS = num('GATE_PROBE_TIMEOUT_MS', 5000, { min: 500, max: 60000 });
// ★ 探针「总时长」上限（覆盖 DNS/连接/TLS/滴流）。实测 2026-10-22 上游慢时 m1=3919ms、m8=3452ms，
// 取 6000 留 50% 余量；仍远小于外层 GATE_PRECHECK_WAIT_MS=9000。
// ★ 2026-10-22 根治：探针上限不再写死。
// 关键理由：延迟是「可用性参数」，不是「身份参数」。判据是状态码指纹 / request_id UUID4，
// 超时只会把「未知」放大成拒绝，绝不会把第三方判成官方 —— 所以可以随上游变慢而安全放宽。
// deadline = clamp(K × EWMA(预检实测耗时), MIN, MAX)；显式设 GATE_PROBE_DEADLINE_MS 则固定。
const PROBE_DEADLINE_OVERRIDE = (() => {
  const raw = process.env.GATE_PROBE_DEADLINE_MS;
  if (raw === undefined || raw === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : null;
})();
const PROBE_DEADLINE_K   = num('GATE_PROBE_DEADLINE_K', 3, { min: 1, max: 20 });
const PROBE_DEADLINE_MIN = num('GATE_PROBE_DEADLINE_MIN', 8000, { min: 500, max: 60000 });
const PROBE_DEADLINE_MAX = num('GATE_PROBE_DEADLINE_MAX', 45000, { min: 2000, max: 180000 });
let precheckEwmaMs = 2000;   // 冷启动初值 = 常态单探针量级
// ★ 2026-10-22 审查修复：探针上限原本只随 EWMA 增长，**与总预算毫无联动**。
// 反例（最坏情况）：EWMA 涨到 15s → deadline=45s(MAX) → 外层 wait=50s →
// 总预算 60s 只剩 10s 给真实回答，而实测 16K token 输出需 ≈44s，
// 必然 gate_budget_exhausted（台账已有 9 次 elapsedMs=60317 的实例）。
// 这与「wait 与 deadline 各自手配、互相矛盾」是同一类错误，只换了一对参数。
// 不变式：precheckWaitMs() + 预留上游预算 ≤ TOTAL_BUDGET_MS（由 probeDeadlineCap 保证）。
const probeDeadlineMs = () => PROBE_DEADLINE_OVERRIDE
  ?? Math.min(PROBE_DEADLINE_MAX, probeDeadlineCap(),
       Math.max(PROBE_DEADLINE_MIN, Math.round(PROBE_DEADLINE_K * precheckEwmaMs)));
// ★ 2026-10-22 审查修复：超时探针的 tookMs 恒等于 deadline（被 abort 截断），
// 于是 EWMA 每轮只涨 1.6 倍（0.7e+0.3×3e），追上真实延迟非常慢：
// 实测「上游慢到 18s」要 3 轮（≈75s）才恢复，期间全部 503 —— 正是今天的症状。
// 修复：探针被上限截断时按「真实延迟 ≥ deadline」这一确定事实倍增跳档，2 轮内追上。
const probeEwmaUpdate = (ms, timedOut = false) => {
  if (!Number.isFinite(ms) || ms <= 0) return;
  if (timedOut) {
    const jumped = Math.max(precheckEwmaMs, ms);
    if (jumped > precheckEwmaMs) {
      precheckEwmaMs = jumped;
      try { log({ ts: new Date().toISOString(), result: 'EWMA_JUMP', from: Math.round(ms / 2), to: Math.round(jumped), deadlineNext: Math.round(PROBE_DEADLINE_K * jumped) }); } catch {}
    }
    return;
  }
  precheckEwmaMs = 0.7 * precheckEwmaMs + 0.3 * ms;
};
const RATE_LIMIT_MAX_WAIT_MS = num('GATE_RATE_LIMIT_MAX_WAIT_MS', 5000, { min: 0, max: 120000 });
// UUID4 / UUID_ANY 来自 baseline.mjs（判据常量唯一来源），此处不再本地定义
const PEEK_CAP = 96 * 1024;      // 流式：读到这么多还没 id 就放弃判定（SSE 的 id 在头部）
const PEEK_HARD_CAP = 2 * 1024 * 1024; // 非流式：硬上限，防止异常大的响应吃内存
const MAX_BODY = num('GATE_MAX_BODY', 16 * 1024 * 1024, { min: 1024, max: 512 * 1024 * 1024 }); // 单请求体上限 16MB（dsh 实测 <2MB，留足余量）

const LOG_DIR = path.join(import.meta.dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
// 日志文件可被 GATE_LOG_FILE 覆盖：影子/测试实例必须写自己的文件，
// 否则测试流量（尤其 FORCE_THIRD 注入）会混进生产台账，把故障排查带偏。
const LOG_FILE = process.env.GATE_LOG_FILE
  ? path.resolve(process.env.GATE_LOG_FILE)
  : path.join(LOG_DIR, 'gate.jsonl');
// 单文件上限与历史份数：总量上限 ≈ LOG_CAP × (LOG_KEEP + 1)
const LOG_CAP = num('GATE_LOG_CAP', 5 * 1024 * 1024, { min: 64 * 1024, max: 512 * 1024 * 1024 });
const LOG_KEEP = num('GATE_LOG_KEEP', 5, { min: 0, max: 100 });

// 稳定的上游 session id：用于路由亲和与 prompt cache。
// 客户端没有提供时必须复用同一个值，否则每次请求都是新 session，缓存全部失效。
const SESSION_FILE = path.join(LOG_DIR, 'session.txt');
let STABLE_SESSION = process.env.GATE_SESSION || '';
if (!STABLE_SESSION) {
  try { STABLE_SESSION = fs.readFileSync(SESSION_FILE, 'utf8').trim(); } catch {}
  if (!STABLE_SESSION) {
    STABLE_SESSION = 'ses_' + crypto.randomUUID().replace(/-/g, '');
    try { fs.writeFileSync(SESSION_FILE, STABLE_SESSION); } catch {}
  }
}
/** 轮转后只保留最近 LOG_KEEP 个历史文件，避免无限累积 */
function pruneRotated() {
  try {
    const names = fs.readdirSync(LOG_DIR)
      .filter(n => /^gate-\d+\.jsonl$/.test(n))
      .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
    while (names.length > LOG_KEEP) {
      const victim = path.join(LOG_DIR, names.shift());
      try { fs.unlinkSync(victim); } catch {}
    }
  } catch {}
}

function log(rec) {
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > LOG_CAP) {
      fs.renameSync(LOG_FILE, path.join(LOG_DIR, `gate-${Date.now()}.jsonl`));
      pruneRotated();
    }
    // 每条记录带实例标识：多实例共用目录时也能区分来源（生产 / 影子 / 测试）
    const tagged = (rec && rec.instance) ? rec : { ...rec, port: PORT, pid: process.pid };
    fs.appendFileSync(LOG_FILE, JSON.stringify(tagged) + '\n');
  } catch {}
}

const protoOf = (pathName) => pathName.endsWith('/messages') ? 'messages'
  : pathName.endsWith('/chat/completions') ? 'chat' : 'responses';

const shapeOf = (id) => {
  if (!id) return '';
  if (UUID4.test(id)) return 'UUID4';
  if (UUID_ANY.test(id)) return 'UUID';
  // ★ resp_ 不能只看前缀：后缀必须是「UUID4 去横线」的位模式，
  //   否则就是第三方自造的 hex（实测漏洞：resp_ + 任意 32hex 曾被当作中性形态放行）。
  if (/^resp_/.test(id)) {
    if (!RESP_SHAPE_STRICT) return 'resp_';   // 应急回退：仅当显式 GATE_RESP_SHAPE_STRICT=0
    const m = /^resp_([0-9a-f]{32})$/i.exec(id);
    return (m && UUID4_BITS(m[1])) ? 'resp_uuid4' : 'resp_bad';
  }
  if (/^chatcmpl/.test(id)) return 'chatcmpl';
  if (/^gw-/.test(id)) return 'gw-';
  if (/^\d+$/.test(id)) return 'numeric';
  if (/^[0-9a-f]{32}$/i.test(id)) return 'HEX32';
  return 'other';
};

/** 解析 Retry-After：支持秒数与 HTTP-date；无法解析返回 null */
function parseRetryAfter(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^[0-9]+$/.test(s)) return Number(s) * 1000;
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return Math.max(0, t - Date.now());
  return null;
}

const stripBom = (b) => b.length >= 3 && b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF ? b.subarray(3) : b;

/** 投票：id 形态为主(权重 2)，completed_at/object 为辅(权重 1) */
function vote({ idShape, hasCompletedAt }) {
  let official = 0, third = 0, signals = [];
  // id 形态是唯一的强证据：官方 = UUIDv4，第三方 = HEX32/chatcmpl/gw-/纯数字。
  // 没有 id 时**不允许**凭 completed_at 单独判 official：
  // 实测第三方后端也可能带 completed_at，单票成 official 就是 fail-open。
  if (!idShape) {
    if (hasCompletedAt !== undefined) signals.push(`completed_at:${hasCompletedAt}`);
    signals.push('id:none');
    return { verdict: 'unknown', votes: { official: 0, third: 0 }, signals };
  }
  // ★ 2026-10-20 第 18 轮：只有 UUIDv4 能算「官方」。
  //
  // 原先 `idShape === 'UUID4' || 'UUID'` 把**任意** UUID 都算官方（uuid1/uuid3/uuid5 都命中
  // UUID_ANY），而 `deliver()` 的 official 出口（L1934）不查 DELIVERABLE_SHAPES ——
  // 于是「官方」存在两套互相矛盾的定义，白名单形同虚设。
  // mock 实测：第三方返回 uuid1 时 → status=200、x-gate-result=official、内容原样交付。
  //
  // 收紧依据：台账 24h 内 4,277 条交付记录里 `UUID`（非 v4）出现 **0 次**，全是 UUID4，
  // 没有任何官方产出非 v4 UUID 的证据 → 收紧零损失。
  // 非 v4 UUID 现在落到下面的 else 分支 → third → 被主循环的身份闸门拒绝。
  const isOff = idShape === 'UUID4';
  // 2026-10-20 上游变更：responses 适配层把 id 从 UUID4 改成了 `resp_` 前缀（OpenAI 格式）。
  // 实测（logprob 2.4e-7 ≪ 1e-5 + E1 文本一致）后端仍是官方未量化模型，
  // 因此 `resp_` 必须视为**中性形态**：既不是第三方特征，也不能单独充当官方证明。
  // 真正的官方证明由协议级预检（eclass 文本 / logprob / msgfp）提供。
  // 中性形态有两个来源——旧 `resp_`（仅 GATE_RESP_SHAPE_STRICT=0 回退模式）
  // 与 `resp_uuid4`（后缀符合 UUID4 位模式，实测 35/35）。两者一律 unknown，行为等同旧逻辑。
  // `resp_bad`（resp_ 前缀但后缀不是 UUID4 变形）不在此列 → 落到下面的 else → third → 拒绝。
  if (idShape === 'resp_' || idShape === 'resp_uuid4') {
    if (hasCompletedAt !== undefined) signals.push(`completed_at:${hasCompletedAt}`);
    signals.push(`id:${idShape}`);
    return { verdict: 'unknown', votes: { official: 0, third: 0 }, signals };
  }
  official += isOff ? 2 : 0; third += isOff ? 0 : 2;
  signals.push(`id:${idShape}`);
  // completed_at 只做加权佐证，不能推翻 id：非 UUID id 即使带 completed_at 也仍是 third
  if (hasCompletedAt !== undefined) {
    official += hasCompletedAt ? 1 : 0; third += hasCompletedAt ? 0 : 1;
    signals.push(`completed_at:${hasCompletedAt}`);
  }
  const verdict = official > third ? 'official' : third > official ? 'third' : 'unknown';
  return { verdict, votes: { official, third }, signals };
}

/** 从文本中截取第一个完整 JSON 对象（字符串/转义感知，避免 prompt 里的花括号破坏配平） */
function firstJsonObject(s) {
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null; // 尚未完整
}

function idFromSse(text) {
  const m = text.match(/data:\s*/);
  if (!m) return { id: '', object: '', completed_at: undefined };
  const payload = text.slice(m.index + m[0].length);
  // 快速路径：id 出现在事件对象最前面（response.created 里 tools 数组可能极大，不能等整个 JSON 完整）
  const quick = payload.slice(0, 8192).match(/"id"\s*:\s*"([^"]{6,80})"/);
  // 修复：这里原本写成 `? undefined : undefined`（两边同值，等于永远不给信号）。
  // 官方 SSE 的 response.created 一定带 completed_at 字段，出现即作为辅证；未出现则视为无信号。
  if (quick) return { id: quick[1], object: '', completed_at: payload.includes('"completed_at"') ? true : undefined };
  const json = firstJsonObject(payload);
  if (!json) return { id: '', object: '', completed_at: undefined };
  try {
    const j = JSON.parse(json);
    const r = j?.response || j?.message || j;
    const isCreated = j?.type === 'response.created' || j?.type === 'message_start';
    return {
      id: String(r?.id || ''),
      object: String(r?.object || j?.type || ''),
      completed_at: isCreated ? ('completed_at' in (j?.response || {})) : undefined,
    };
  } catch {
    const mm = json.match(/"id"\s*:\s*"([^"]{6,80})"/);
    return { id: mm ? mm[1] : '', object: '', completed_at: undefined };
  }
}

/** 流式/非流式统一探身：节流解析 + 结束兜底，避免 O(n²) 又不漏掉大响应里的 id */
const PEEK_TRY_STEP_SSE = 1024;   // 流式：SSE 的 id 出现很早，用小步长尽快判定
const PEEK_TRY_STEP_JSON = 4 * 1024; // 非流式：JSON 只有收完才合法，大步长省 CPU

function peekBody(res, isSse) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0, done = false, lastTry = -1;

    const finish = (info) => {
      if (done) return; done = true;
      res.removeListener('data', onData);
      res.removeListener('end', onEnd);
      res.removeListener('error', onErr);
      res.removeListener('close', onErr);
      res.pause();
      resolve({ ...info, chunks });
    };
    // 上游中断/被销毁时 'end' 不会触发。缺了这个兜底，peekBody 会永远 pending，
    // 连带 realRequest 的 async 响应处理悬空、socket 无法释放。
    const onErr = () => finish({ id: '', object: '', completed_at: undefined });
    const parse = (text) => {
      if (isSse) {
        const r = idFromSse(text);
        return r.id ? r : null;
      }
      try {
        const j = JSON.parse(text);
        const r = j?.response || j;
        return { id: String(r?.id || ''), object: String(r?.object || ''),
                 completed_at: ('completed_at' in (r || {})) ? true : false };
      } catch { return null; }
    };

    const onData = (c) => {
      chunks.push(c); size += c.length;
      // 首包必试（SSE 的 id 就在头几十字节），之后按 4KB 节流
      const step = isSse ? PEEK_TRY_STEP_SSE : PEEK_TRY_STEP_JSON;
      if (lastTry < 0 || size - lastTry >= step) {
        lastTry = size;
        const r = parse(Buffer.concat(chunks).toString('utf8'));
        if (r) return finish(r);
      }
      // 非流式 JSON 只有收完才合法：到 PEEK_CAP 就放弃会让「官方的大响应」被判 unknown → 503。
      // 改为继续读到 end（解析只需一次 O(n)），只用一个更大的硬上限防内存失控。
      if (size >= (isSse ? PEEK_CAP : PEEK_HARD_CAP)) finish({ id: '', object: '', completed_at: undefined });
    };

    // 结束兜底：非流式大 JSON 只有收完才合法，这里做且只做一次完整解析（O(n)）
    const onEnd = () => {
      const r = parse(Buffer.concat(chunks).toString('utf8'));
      finish(r || { id: '', object: '', completed_at: undefined });
    };

    res.on('data', onData); res.on('end', onEnd); res.on('error', onErr); res.on('close', onErr);
  });
}

// ---------- 响应头安全 ----------
// 客户端可控的 model 名会进响应头；含 CR/LF 或其它控制字符时 Node 会直接抛
// ERR_INVALID_CHAR（表现为 500），同时也是响应头注入面。这里统一清洗。
function headerSafe(v, max = 120) {
  return String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')   // 控制字符（含 CR/LF）→ 空格
    .replace(/[^\x20-\x7e\u00a0-\uffff]/g, '')
    .slice(0, max);
}
// ---------- 工具 schema 兼容层：摘掉悬空 $ref ----------
// 只在 $ref 目标确实缺失时动手；能解析的 $ref 原样保留（不改变语义）。
function normalizeToolSchemas(tools) {
  let fixed = 0;
  for (const tool of tools) {
    const schema = tool && (tool.input_schema || tool.parameters);
    if (!schema || typeof schema !== 'object') continue;

    // 收集可解析的本地目标：$defs / definitions
    const defs = schema.$defs || schema.definitions || null;
    const localTargets = new Set();
    if (defs && typeof defs === 'object') for (const k of Object.keys(defs)) localTargets.add(k);

    const walk = (node, depth) => {
      if (!node || typeof node !== 'object' || depth > 24) return;
      if (Array.isArray(node)) { for (const v of node) walk(v, depth + 1); return; }

      if (typeof node.$ref === 'string') {
        const m = node.$ref.match(/^#\/(?:\$defs|definitions)\/(.+)$/);
        // 非本地引用（外部 URL、$id 等）不动；本地但目标缺失 → 摘掉
        if (m && !localTargets.has(m[1])) {
          delete node.$ref;
          fixed++;
        }
      }
      for (const k of Object.keys(node)) {
        if (k === '$ref') continue;
        walk(node[k], depth + 1);
      }
    };

    walk(schema, 0);

    // $defs 内部也可能互相引用，同样检查
    if (defs && typeof defs === 'object') {
      for (const v of Object.values(defs)) walk(v, 0);
    }
  }
  return fixed;
}
function headersFor(pathName, incoming, sess) {
  const h = {
    'content-type': 'application/json',
    'accept': 'text/event-stream, application/json',
    'user-agent': incoming['user-agent'] || 'dsh-oc-gate/3.0',
    authorization: `Bearer ${KEY}`,
    'x-opencode-session': sess,
    'x-opencode-session-id': incoming['x-opencode-session-id'] || sess,
  };
  if (pathName.endsWith('/messages')) { h['x-api-key'] = KEY; h['anthropic-version'] = incoming['anthropic-version'] || '2023-06-01'; }
  for (const k of ['x-opencode-project', 'x-opencode-client', 'x-opencode-request']) if (incoming[k]) h[k] = incoming[k];
  return h;
}

/** 探针：极小 prompt，只为拿到路由形态 */
function probe(pathName, body, incoming, signal) {
  return new Promise((resolve) => {
    const proto = protoOf(pathName);
    const tiny = proto === 'responses'
      ? { model: body.model, input: 'ping', max_output_tokens: 1 }
      : { model: body.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] };
    const payload = Buffer.from(JSON.stringify(tiny), 'utf8');
    const headers = { ...headersFor(pathName, incoming, incoming['x-opencode-session'] || STABLE_SESSION), 'content-length': String(payload.length) };
    metrics.probes++;
    const req = transport.request({ host: HOST, port: HOST_PORT, path: pathName, method: 'POST', headers, signal }, async (res) => {
      res.on('error', () => {});   // peek/destroy 时避免未捕获 error 终止进程
      // 2026-10-20 穷举验证：x-opencode-endpoint-id 在 9 种情况下（正常/缺参/流式/坏模型/
      // 401/400，三协议各覆盖）**全部 undefined**，上游只返回 x-opencode-log-id（网关自己的
      // 请求日志，UUIDv7，对所有后端都一样生成，无法区分身份）。原「读 header 直接分类」
      // 分支永不进入，已移除。若上游将来恢复该 header，在此处重新接入。
      const twoxx = res.statusCode >= 200 && res.statusCode < 300;
      if (!twoxx) {
        // ★ P0-1：非 2xx 不能当作「这条车道是第三方」的证据。
        // 实证（台账 2026-10-18）：38 条 BLOCKED_ALL_THIRD 的探针 classifier=status，
        // 实际是 429/5xx/401，却一律被判 third → 用户看到「所有候选车道都是第三方」，
        // 真实原因只是限流/上游瞬时故障。既造成误杀，也把排障方向带偏。
        //
        // 语义修正：非 2xx = 「该车道此刻无法判定归属」（unknown），不是「坏后端」。
        //   · 429 / 5xx / 401 / 403 —— 与后端身份无关
        //   · 其它 4xx —— 说明该 model 在此协议下不被接受，属「车道不可用」，仍非「第三方」
        // cacheSet 本来就只收 2xx，所以这里只影响本次排序与 503 的归因文案。
        res.resume();
        return resolve({ verdict: 'unknown', classifier: 'status', idShape: '', status: res.statusCode });
      }
      const p = await peekBody(res, String(res.headers['content-type'] || '').includes('event-stream'));
      res.resume();
      const v = vote({ idShape: shapeOf(p.id), hasCompletedAt: p.completed_at });
      resolve({ verdict: v.verdict, classifier: 'body-id', idShape: shapeOf(p.id), votes: v.votes, signals: v.signals, status: res.statusCode });
    });
    req.on('error', (e) => resolve({ verdict: 'error', classifier: 'error', error: String(e.message) }));
    req.setTimeout(PROBE_TIMEOUT_MS, () => req.destroy(new Error('probe timeout')));
    req.end(payload);
  });
}

/** 把 body 序列化一次，之后每个候选模型只需拼接 model 字段（大 body 时省 5~6 倍 CPU） */
function makePayloadFactory(body) {
  try {
    const copy = { ...(body || {}) };
    delete copy.model;
    const restJson = JSON.stringify(copy);   // 只做一次
    const bodyPart = restJson.slice(0, -1);  // 去掉结尾 '}'
    return (model) => Buffer.from('{"model":' + JSON.stringify(String(model)) + (bodyPart === '{' ? '}' : ',' + bodyPart.slice(1) + '}'), 'utf8');
  } catch { return null; }
}

function realRequest({ pathName, body, incoming, model, signal, payloadFactory, timeoutMs }) {
  return new Promise((resolve) => {
    // 大 body 场景下 JSON.stringify 很贵：优先用调用方预构造的工厂，换 model 时只做轻量拼接
    const payload = payloadFactory ? payloadFactory(model) : Buffer.from(JSON.stringify({ ...body, model }), 'utf8');
    const sess = incoming['x-opencode-session'] || STABLE_SESSION;
    const headers = { ...headersFor(pathName, incoming, sess), 'content-length': String(payload.length) };
    const started = Date.now();
    let settledFlag = false;
    let hardTimer = null;
    const settle = (v) => {
      if (settledFlag) return;
      settledFlag = true;
      if (hardTimer) { try { clearTimeout(hardTimer); } catch {} hardTimer = null; }
      resolve(v);
    };
    // ★ 2026-10-23：硬上限必须**同时**受单请求预算约束。
    // 固定值 180s 会让「上游发头后不发体」的请求拖到 180s，而 dsh 的重试窗口只有 ~27s、
    // 既有回归契约（test-resilience E5）要求 <70s。timeoutMs 就是本次尝试可用的预算，
    // 取 min(绝对上限, 预算) 才能既切断僵尸、又不突破「单请求应在预算内收敛」的承诺。
    const capMs = Math.max(5000, Math.min(ATTEMPT_HARD_CAP_MS, timeoutMs || UPSTREAM_TIMEOUT_MS));
    hardTimer = setTimeout(() => {
      if (settledFlag) return;
      log({ ts: new Date().toISOString(), result: 'ATTEMPT_HARD_TIMEOUT', model,
            elapsedMs: Date.now() - started, capMs });
      try { reqRef && reqRef.destroy(new Error('attempt hard cap')); } catch {}
      settle({ verdict: 'error', status: 0, error: 'attempt_hard_cap', model, ms: Date.now() - started });
    }, capMs);
    if (hardTimer && typeof hardTimer.unref === 'function') hardTimer.unref();
    let reqRef = null;
    const req = transport.request({ host: HOST, port: HOST_PORT, path: pathName, method: 'POST', headers, signal }, async (res) => {
      // ★ 响应头已到 = 后端已开始响应。此刻必须**清除「等待响应头」的空闲超时**。
      //
      // Node 的 req.setTimeout 是 socket 空闲超时，不是总时长。而非流式请求在上游把
      // 整段输出生成完之前**一个字节都不发**，于是整个推理期间 socket 处于空闲状态，
      // 被超时直接 destroy —— 这是长输出 503 的真正原因（实测 16K token 输出需要
      // 44 秒，在 TOTAL_BUDGET_MS=45s 内只剩 ~44s 余量，一超就被砍）。
      //
      // 输出时长本质上由「用户要多少字」决定，与路由判定无关，不该受路由预算约束。
      // 改为：等响应头仍受 timeoutMs（路由预算）约束；收到头之后的 body 阶段只受
      // BODY_IDLE_TIMEOUT_MS 约束（真正无数据流入才断，防挂死）。
      try { req.setTimeout(0); } catch {}
      res.setTimeout(BODY_IDLE_TIMEOUT_MS, () => { try { res.destroy(); } catch {} });
      // 关键：abort/destroy 时底层会 emit 'error'，没有监听器会变成未捕获异常并终止进程
      res.on('error', () => {});
      try {
      // x-opencode-endpoint-id 穷举验证恒为 undefined（见 probe 处说明），此处不再读取。
      // （P2-3：原 endpoint 恒空的死变量 + 恒假分支结构已删除，endpoint 统一传空串）
      const up = String(res.headers['x-opencode-upstream-model-id'] || '');
      const twoxx = res.statusCode >= 200 && res.statusCode < 300;
      const ctype = String(res.headers['content-type'] || '');
      let verdict = 'unknown', classifier = 'none', idShape = '', votes = null, signals = [], buffered = [];
      if (twoxx) {
        const p = await peekBody(res, ctype.includes('event-stream'));
        buffered = p.chunks; idShape = shapeOf(p.id);
        const v = vote({ idShape, hasCompletedAt: p.completed_at });
        verdict = v.verdict; votes = v.votes; signals = v.signals; classifier = 'body-id';
        if (!p.id) {
          // 诊断：只记录结构与长度，绝不落任何响应正文内容（避免 prompt/回复进日志）
          const head = Buffer.concat(p.chunks).toString('utf8', 0, 2048);
          const hitType = head.match(/"type"\s*:\s*"([a-z_.-]{1,40})"/i);
          const total = p.chunks.reduce((n, c) => n + c.length, 0);
          signals.push(`noid:bytes=${total}:type=${hitType ? hitType[1] : 'n/a'}`);
        }
      }
      // 上游非 2xx 按语义分流，不能一律当成"车道被分流"
      let passthrough = null, retryAfterMs = null;
      if (!twoxx) {
        const st = res.statusCode;
          if (st === 429) {
            verdict = 'rate-limit';                       // 限流：同车道等待后重试
            retryAfterMs = parseRetryAfter(res.headers['retry-after']);
            // 收集一小段上游原文，便于把限流的原始原因回报给客户端
            const parts = []; let sz = 0;
            await new Promise((done) => {
              res.on('data', (c) => { if (sz < 8192) { parts.push(c); sz += c.length; } });
              res.on('end', done);
              res.on('error', done);
              setTimeout(done, 8000);
            });
            passthrough = { status: st, body: Buffer.concat(parts).toString('utf8'), ctype };
          } else if (st >= 500) {
          verdict = 'server-error';                     // 网关瞬时故障：同车道重试
          retryAfterMs = parseRetryAfter(res.headers['retry-after']);
        } else {
          verdict = 'third';                            // 其它 4xx：请求本身有问题
          // 4xx 全部收集响应体用于透传（含 401/403：认证/权限问题换车道也没用）
          const parts = []; let sz = 0;
          await new Promise((done) => {
            res.on('data', (c) => { if (sz < 65536) { parts.push(c); sz += c.length; } });
            res.on('end', done);
            res.on('error', done);
            setTimeout(done, 15000);
          });
          passthrough = { status: st, body: Buffer.concat(parts).toString('utf8'), ctype };
          // 诊断：上游 4xx 通常是请求体/头不被接受，把错误摘要记进台账（只取 error.message，不落正文）
          try {
            const raw = passthrough.body || '';
            let emsg = '';
            try { const j = JSON.parse(raw); emsg = j?.error?.message || j?.message || ''; } catch { emsg = raw.slice(0, 160); }
            signals.push(`upstream4xx:${st}:${String(emsg).replace(/\s+/g, ' ').slice(0, 200)}`);
            // ★ 2026-10-23 审查修复：上游会把「自身内部故障」报成 **400**，例如
            // {"code":"server_error","type":"server_error","message":"Upstream response was invalid"}。
            // 这类错误是瞬时的，与「请求本身有问题」完全不是一回事：
            // 旧代码一律 verdict=third，且只在 5xx 才重试 → 一次瞬时故障就直接失败
            // （2026-10-22 实测：pid=14020 有 2 条 status=400 + "Upstream response was invalid"）。
            // 现在按语义识别为 server-error，走同车道重试；passthrough 仍保留作为最终兜底。
            try {
              const jj = JSON.parse(passthrough.body || "{}");
              const ecode = String((jj && jj.error && jj.error.code) || (jj && jj.code) || "");
              const etype = String((jj && jj.error && jj.error.type) || (jj && jj.type) || "");
              // 只认**结构化**标记。不要用 message 正则：
              // 实测（2026-10-23）损坏图片的客户端 4xx 也含 "invalid" 字样，
              // 宽正则会把「请求本身有问题」误判成瞬时故障 → 重试到预算耗尽（test-multimodal 抓到）。
              const looksServerError = ecode === "server_error" || etype === "server_error";
              if (looksServerError) {
                verdict = "server-error";   // 瞬时故障：同车道重试（4xx 来源最多 1 次）
                metrics.upstream4xxServerError = (metrics.upstream4xxServerError || 0) + 1;
                signals.push("classified:server-error");
              }
            } catch {}
          } catch {}
        }
      }
      if (FORCE_THIRD) verdict = 'third';
      if (FAULT_MAIN_THIRD && twoxx) verdict = 'third';   // 自检专用：只污染主请求结论
      // ★ 2026-10-21：`official-unverified` 升格通道已删除。
      // 第 19 轮的交付前置闸要求「本协议预检 pass」才允许发出真实请求，
      // 因此 `unknown` 根本走不到交付阶段；再把 unknown 升格成"可交付"就是反向开洞。
      // GATE_BLIND_MODE 开关一并移除（保留它只会让人以为还能开观察期）。
      settle({ verdict, classifier, idShape, votes, signals, status: res.statusCode, endpoint: '',
               upstreamModel: up, stream: res, buffered, ctype, model, passthrough, retryAfterMs, ms: Date.now() - started });
      } catch (e) {
        // 响应处理内部抛错（peek 解析、Buffer 拼接等）必须收敛成 error 结论，
        // 否则外层 Promise 永不 settle、withSlot 槽位不归还，累计 MAX_CONC 次即全服务死锁。
        try { res.destroy(); } catch {}
        settle({ verdict: 'error', status: 0, error: 'handler: ' + String(e?.message || e), model, ms: Date.now() - started });
      }
    });
    reqRef = req;
    // ★ 2026-10-23：等响应头的空闲超时之外，再补一道墙钟硬上限（防心跳挂死/待机僵尸）。
    req.on('error', (e) => settle({ verdict: 'error', status: 0, error: String(e.message), model, ms: Date.now() - started }));
    // 与 dsh 的重试窗口（约 27 秒）对齐：等太久只会让 dsh 重发、上游白烧配额
    req.setTimeout(timeoutMs || UPSTREAM_TIMEOUT_MS, () => req.destroy(new Error('upstream timeout')));
    req.end(payload);
  });
}

// ---------- 每请求官方性预检（与真实请求并行，零额外延迟）----------
// 实测：E 类探针 664–1058ms，真实请求 1526–2384ms → 探针结论总是先到。
// 因此可以做到「验完才交付」而完全不增加用户感知延迟。
const PRECHECK_ENABLE = (process.env.GATE_PRECHECK ?? '1') === '1';
// msgfp 并行实测 p90=1925ms / max=2140ms，1800 会让 15% 的 messages 预检超时失效。
// 单轮 3000 可覆盖 p99；但失败路径要跑两轮（首测+确认重测），故默认 6000。
  // 失败路径要跑两轮（首测 + 确认重测），等待预算必须覆盖两轮，否则确认来不及就退化成超时
  // ★ 2026-10-22 根治：外层等待不再独立配置。
// 它必须 > 探针上限，而手配两次都配错过（4000/6000、15000/20000）。现由探针上限自动派生。
const PRECHECK_WAIT_OVERRIDE = (() => {
  const raw = process.env.GATE_PRECHECK_WAIT_MS;
  if (raw === undefined || raw === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 ? v : null;
})();
const PRECHECK_WAIT_SLACK_MS = num('GATE_PRECHECK_WAIT_SLACK_MS', 5000, { min: 0, max: 60000 });
// 必须给「真实回答」预留的预算。低于它，长输出会被 gate_budget_exhausted 砍掉，
// 表现为「门控把好回答砍了」而不是「路由不对」——更隐蔽。
const MIN_UPSTREAM_BUDGET_MS = num('GATE_MIN_UPSTREAM_BUDGET_MS', 30000, { min: 5000, max: 600000 });
// 探针上限的绝对天花板：保证 wait(=deadline+slack) 之后仍剩 MIN_UPSTREAM_BUDGET_MS。
// 总预算太小时按一半预留，避免 cap 变成负数把探针压死。
function probeDeadlineCap() {
  const reserved = Math.min(MIN_UPSTREAM_BUDGET_MS, Math.floor(TOTAL_BUDGET_MS * 0.5));
  return Math.max(1000, TOTAL_BUDGET_MS - reserved - PRECHECK_WAIT_SLACK_MS);
}
// ★ 不变式：外层等待**永远不小于**探针上限 + slack。
// 违反它的后果是「探针还在跑，外层已经判 timeout」→ 慢而成功的探针被当成拒绝。
// 因此即使 GATE_PRECHECK_WAIT_MS 被配小（历史上配错过两次），这里也强制抬到下限并留痕。
let precheckWaitClampedWarned = false;
const precheckWaitMs = () => {
  const derived = probeDeadlineMs() + PRECHECK_WAIT_SLACK_MS;
  if (PRECHECK_WAIT_OVERRIDE === null) return derived;
  if (PRECHECK_WAIT_OVERRIDE < derived) {
    if (!precheckWaitClampedWarned) {
      precheckWaitClampedWarned = true;
      const msg = `GATE_PRECHECK_WAIT_MS=${PRECHECK_WAIT_OVERRIDE} < 探针上限+slack(${derived})，已强制抬到 ${derived}`;
      CONFIG_WARNINGS.push(msg);
      console.warn('[oc-gate config] ' + msg);
      try { log({ ts: new Date().toISOString(), result: 'CONFIG_CLAMPED', detail: msg }); } catch {}
    }
    return derived;
  }
  return PRECHECK_WAIT_OVERRIDE;
};
  // 抗抖动：预检判 fail 后必须先重测确认，避免网络抖动/瞬时限流被当成「后端变成非官方」
  const PRECHECK_CONFIRM = num('GATE_PRECHECK_CONFIRM', 1, { min: 0, max: 5 });
  // 预检「确认失败」时允许被 proof 覆盖的最大 proof 龄期。
  // 探针 10 分钟一轮，所以 90 秒意味着「proof 必须在最近 90 秒内刷新过」；
  // 更旧的 proof 无权否决实时证据（否则实时判据形同虚设）。
  // 预检「确认失败」时允许被 proof 覆盖的最大 proof 龄期。
  //
  // 必须与官方探针任务的实际频率协调，否则这层会静默失效：
  // 探针原为 10 分钟一轮 → proof 常态 300~600s → 90s 阈值下永远无法覆盖，
  // 等于「proof 覆盖」这个安全网被彻底架空（实测 age=355s 恒超阈值）。
  //
  // 现协调为：探针 3 分钟一轮（任务触发器 PT3M）+ 阈值 4 分钟。
  // 正常情况 proof age < 180s < 240s → 能覆盖；探针连续失败超过 4 分钟 → 不覆盖（严格）。
  // 这是有意的：proof 太旧说明外部验证已停止工作，此时应以实时预检为准。
  const OVERRIDE_FRESH_MS = num('GATE_OVERRIDE_FRESH_MS', 240000, { min: 0, max: 600000 });
  // 「近期预检通过 → 跳过车道探测」的有效期。原本硬编码 30000 且不可配置。
  // 当 GATE_PRECHECK_TTL_MS=0（要求实时）时自动归零，避免实时性被二次缓存。
  const SKIP_PROBE_TTL_MS = num('GATE_SKIP_PROBE_TTL_MS', 30000, { min: 0, max: 300000 });
  const PRECHECK_CONFIRM_MS = num('GATE_PRECHECK_CONFIRM_MS', 250, { min: 0, max: 30000 });
  // 故障注入（仅测试用）：jitter = 每个协议首次预检强制 fail
  const FAULT_PRECHECK = (process.env.GATE_FAULT_PRECHECK || '').toLowerCase();
  const faultPrecheckFired = new Set();
// 预检结论复用窗口。0 = 每个请求都重新验。
//
// 2026-10-20：改为**按协议**配置。三条判据的上游请求成本差 9 倍：
//   responses → e1，1 个请求
//   messages  → msgfp，9 个请求   ← 高频场景下 11x 放大，最容易打满 RPM
//   chat      → logprob，3 个请求
// 全局 TTL 只能一刀切：要么 responses 也失去实时性，要么 messages 把 RPM 烧光。
// 分开配置后：responses 保持每请求实时（只多 2 个请求，代价小），
// messages 复用 30 秒（放大 11x → 1x），chat 折中 15 秒。
// ★ 2026-10-22 根治：TTL 由「上游池切换率」定标，而不是按成本拍脑袋。
// 实测池切换 λ ≈ 5.4e-6/s（51h 内 1 次）。窗口 W 的暴露面 = λ×W：
//   W=90s → 0.049%    W=180s → 0.097%    W=300s → 0.16%
// 取 90s：后台保活（25s 一轮）保证每个窗口内 ≥3 次刷新，暴露面压在 0.05% 以下。
const PRECHECK_TTL_MS = num('GATE_PRECHECK_TTL_MS', 90000, { min: 0, max: 3600000 });
const PRECHECK_TTL_BY_PROTO = {
  responses: PRECHECK_TTL_MS,
  messages: num('GATE_PRECHECK_TTL_MS_MESSAGES', 90000, { min: 0, max: 3600000 }),
  chat: num('GATE_PRECHECK_TTL_MS_CHAT', 15000, { min: 0, max: 3600000 }),
};
const precheckTtlFor = (p) => (PRECHECK_TTL_BY_PROTO[p] ?? PRECHECK_TTL_MS);

// 各协议可信判据矩阵（实测结论，2026-10-19）：
//   responses : E1/E2/E3 可用 —— 能拿到 DeepSeek 服务端原始错误（Rust serde 风格）
//   chat      : 参数不校验（max_tokens 超限仍返回 200），E 类不可用；
//               但支持 logprobs，可用精度指纹验证
//   messages  : 错误体被网关简化成 {"model":...}，E 类文本不可用；不支持 logprobs；
// 因此「放开全部车道」只在有判据的协议上生效，其余保持只认 id=UUID4 的保守策略。

// 协议级封禁（宁杀错不放过）：没有任何前置判据的协议直接拒绝，不做「靠 id 猜」的尝试。
// 默认**不封禁任何协议**：messages 已有 msgfp 状态码指纹判据（见 PROTO_TRUST）。
// 如需临时封禁某个协议（例如判据被上游改动失效），用 GATE_BLOCK_PROTOS=messages。
const BLOCKED_PROTOS = new Set(
  (process.env.GATE_BLOCK_PROTOS ?? '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

const PROTO_TRUST = {
  responses: 'eclass',
  chat: 'logprob',
  messages: 'msgfp',
};

const PRECHECK_CASES_BY_PROTO = {
  // 2026-10-20 复测（10 个候选用例逐条对照官方直连）：只有 e1 的文本与官方**完全一致**。
  // e2/e3 等已被 OpenCode 网关层自行拦截（返回 "Upstream response was invalid" /
  // "Endpoint is unavailable"），不再穿透到 DeepSeek 后端，因此不能作为官方判据。
  // e1 之所以有效：网关没有替它做参数校验，官方 serde 层原话（见 baseline.mjs 的 E1_MSG）
  // 是 DeepSeek Rust 服务端 serde 层原话，第三方 OpenAI 兼容层不会产出这个文本。
  // 单用例 + 确认重测（PRECHECK_CONFIRM）足以抗抖动。
  responses: [
    { id: 'e1', name: '缺 input（穿透到后端）',
      path: '/zen/go/v1/responses',
      body: { model: ALLOWED[0], max_output_tokens: 8 },
      // 第 17 轮：除文本外还要求内嵌 request_id 是 UUID4。
      // 官方错误体形如 `... must be provided (request_id: 4cd64d97-…)`；
      // 自部署/异实现不产出这个结构（实测 ollama：`[] is too short - 'messages'`）。
      requestIdUuid: true,
      expect: E1_MSG },
  ],
  // chat 没有可用的错误指纹，改用 logprobs 精度探针（成本约 40 token）
  chat: [],
  // messages 用状态码指纹（9 项失败请求的 400/422 序列），见 MSG_FINGERPRINT
  messages: [],
};

// (已移除无调用的 PRECHECK_CASES 别名，2026-10-20)

// D5 singleflight：按协议分别去重。单变量会让不同协议互相覆盖引用，
// 导致同协议的并发请求各跑一轮（预检量放大 N 倍）。
const precheckInflight = new Map();   // proto -> Promise
// 按协议保存最近一次预检结论。原为单个全局变量 —— 那会让「按协议分档 TTL」名不副实：
// 后跑的协议会覆盖前一个，于是 refreshMatrix / rankCandidates 检查另一个协议时
// 永远读到不匹配的 proto，跳过逻辑落空（实测两协议均 pass 后仍探测 5 次）。
const precheckLastByProto = new Map();   // proto -> { at, proto, verdict, passCount, results }（最近一次实测）
const precheckLastFor = (p) => precheckLastByProto.get(p) || null;
// ★ 2026-10-22：**只缓存 pass**。原先 net/timeout 也写进同一张表，于是「一次超时」
// 会在整个 TTL 窗口内被反复命中 → 四秒的抖动被放大成十几条瞬时 503
// （2026-10-22 17:18 台账可见：4684ms 一次 + 之后连续 11 条 1–48ms）。
const precheckPassByProto = new Map();  // proto -> 最近一次 pass 的记录
const precheckPassFor = (p) => precheckPassByProto.get(p) || null;

// ---------- chat 协议的精度探针（logprobs 置信度）----------
// 探针必须选「官方侧 top1 极稳定」的 prompt。
// 实测（2026-10-19，官方 8 轮）：以下 5 个探针 top1 恒为 1.19e-7，零波动；
// 而 'The capital of France is' 偶发到 -5.47e-5，会误判为 fail。
// 判据取 3 个探针的 min|top1|（与周期探针口径一致），阈值 1e-5。
const CHAT_PRECISION_PROBES = [
  'The past tense of "go" is',
  'Monday comes before',
  'The first letter of the alphabet is',
];
const CHAT_TOP1_MAX = 1e-5;   // 官方实测 max 1.19e-7，100 倍余量

function oneChatLogprob(prompt) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify({
      model: ALLOWED[0], max_tokens: 8, temperature: 0,
      messages: [{ role: 'user', content: prompt }],
      logprobs: true, top_logprobs: 3,
    }), 'utf8');
    // ★ P1-2：必须走 transport（与真实请求一致，受 GATE_HOST_SCHEME 控制）。
    // 原来硬编码 https.request，导致故障注入/mock 上游（http）时本预检永远 net，
    // test-fault / test-bugfix 里「预检失败 → 确认重测 → 被 proof 覆盖」这些断言等于没被验证。
    const req = transport.request({
      host: HOST, port: HOST_PORT, path: '/zen/go/v1/chat/completions', method: 'POST', timeout: probeDeadlineMs(), signal: AbortSignal.timeout(probeDeadlineMs()),
      headers: { 'content-type': 'application/json', 'content-length': payload.length,
                 authorization: `Bearer ${KEY}`,
                 'x-opencode-session': STABLE_SESSION, 'x-opencode-session-id': STABLE_SESSION },
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (buf.length < 65536) buf += d; });
      res.on('end', () => {
        if (res.statusCode === 429) return resolve({ status: 'rate' });
        if (res.statusCode >= 500) return resolve({ status: 'net' });
        let j = null; try { j = JSON.parse(buf); } catch {}
        const lp = j?.choices?.[0]?.logprobs;
        const seq = lp?.reasoning_content?.length ? lp.reasoning_content : lp?.content;
        if (!seq?.length) return resolve({ status: 'format' });
        resolve({ status: 'ok', top1: seq[0].logprob });
      });
    });
    req.on('error', () => resolve({ status: 'net' }));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ status: 'net' }); });
    req.end(payload);
  });
}

async function runChatPrecisionProbe() {
  const results = await Promise.all(CHAT_PRECISION_PROBES.map(oneChatLogprob));
  const ok = results.filter(r => r.status === 'ok');
  const abnormal = results.filter(r => r.status !== 'ok').map(r => r.status);

  if (ok.length < 2) {
    // 有效样本不足：无法判定，交给周期 proof 兜底
    return { id: 'p1', verdict: 'net',
             detail: `样本不足 ${ok.length}/${results.length} [${abnormal.join(',')}]` };
  }
  const absVals = ok.map(r => Math.abs(r.top1));
  const minAbs = Math.min(...absVals);
  const pass = minAbs <= CHAT_TOP1_MAX;
  return {
    id: 'p1',
    verdict: pass ? 'pass' : 'fail',
    detail: `min|top1|=${minAbs.toExponential(2)} max=${Math.max(...absVals).toExponential(2)} ` +
            `(阈值 ${CHAT_TOP1_MAX.toExponential(1)}) n=${ok.length}/${results.length}`,
  };
}


// ---------- messages 协议：零成本状态码指纹 ----------
// 官方 messages 端点的错误文本会被 OpenCode 网关吞成 {"model":...}，
// 但 HTTP 状态码完整透传。而 DeepSeek 分两层校验：
//   400 = 业务层（参数值超范围）
//   422 = 反序列化层（字段类型/枚举不认识）→ Rust serde 风格
// vLLM/SGLang 等自部署通常一律 400，不做这个区分。
// 实测（2026-10-19，官方 Anthropic 端点 vs OpenCode，各 3 轮）：9 项状态码完全一致且稳定。
// MSG_FINGERPRINT 来自 baseline.mjs（判据常量唯一来源）
const MSG_PROBES = [
  { id: 'm1', body: { max_tokens: 0, messages: [{ role: 'user', content: 'hi' }] } },
  { id: 'm2', body: { max_tokens: 8, temperature: -0.1, messages: [{ role: 'user', content: 'hi' }] } },
  { id: 'm3', body: { max_tokens: 8, temperature: 2.1, messages: [{ role: 'user', content: 'hi' }] } },
  { id: 'm4', body: { max_tokens: 8, top_p: 0, messages: [{ role: 'user', content: 'hi' }] } },
  { id: 'm5', body: { max_tokens: 8, top_p: 1.1, messages: [{ role: 'user', content: 'hi' }] } },
  { id: 'm6', body: { max_tokens: 8, messages: [] } },
  { id: 'm7', body: { max_tokens: 8, messages: [{ role: 'wizard', content: 'hi' }] } },
  { id: 'm8', body: { max_tokens: 8 } },
  { id: 'm9', body: { max_tokens: 8, messages: [{ role: 'user', content: 12345 }] } },
];

// ★ 2026-10-22 修复：探针必须带「总时长」上限（signal），不能只靠 timeout。
//   Node 的 req.setTimeout 是 socket **空闲**超时；上游慢速滴流（或握手期持续有字节）时永不触发，
//   整次预检会挂到外层 PRECHECK_WAIT_MS 才被切断 → 判定 timeout → 误拦官方流量。
//   实测：滴流探针下旧代码 9020ms→503，加 signal 后 4029ms→200 PASS（8/9 有效即可通过）。
//   2026-10-22 13:44–13:47 的 8 次拦截（7.62%）即此因。勿删。
const probeErrs = new Map();   // 探针错误码收集（可观测性：区分 RST / DNS / abort）
function msgStatusProbe(p) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify({ model: ALLOWED[0], ...p.body }), 'utf8');
    // ★ P1-2：走 transport（见 oneChatLogprob 处的说明）
    const req = transport.request({
      host: HOST, port: HOST_PORT, path: '/zen/go/v1/messages', method: 'POST', timeout: probeDeadlineMs(), signal: AbortSignal.timeout(probeDeadlineMs()),
      headers: { 'content-type': 'application/json', 'content-length': payload.length,
                 // messages 端点只认 x-api-key，用 Bearer 会 401
                 'x-api-key': KEY, 'anthropic-version': '2023-06-01',
                 'x-opencode-session': STABLE_SESSION },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ id: p.id, code: res.statusCode }));
    });
    req.on('error', (e) => { probeErrs.set(p.id, e?.code || e?.name || String(e?.message || e)); resolve({ id: p.id, code: -1 }); });
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ id: p.id, code: -1 }); });
    req.end(payload);
  });
}

async function runMsgFingerprint() {
  const results = await Promise.all(MSG_PROBES.map(msgStatusProbe));
  const codes = results.map(r => r.code);

  // 只有 400/422/200 是「判据内」的状态码。
  // 429（限流）/ 5xx / -1（网络）属于「本次无法判定」，不能算作「不符」，
  // 否则并发压力下偶发一条 429 就会让整条 messages 路径在 enforce 模式被误杀。
  const EXPECTED_SET = new Set([400, 422, 200]);
  const validIdx = [];
  const abnormal = [];
  codes.forEach((c, i) => {
    if (EXPECTED_SET.has(c)) validIdx.push(i);
    else abnormal.push(`${MSG_PROBES[i].id}:${c}`);
  });

  const expected = MSG_FINGERPRINT.split(',');
  const validCodes = validIdx.map(i => codes[i]);
  const validExpected = validIdx.map(i => expected[i]);
  // 注意：res.statusCode 是 number，MSG_FINGERPRINT 拆出来是 string，
  // 直接用 === 会永远是 false（400 === '400'），必须先统一成字符串。
  const matched = validCodes.length === validExpected.length
    && validCodes.every((c, k) => String(c) === validExpected[k]);

  let verdict;
  if (validIdx.length < 6) {
    // 有效样本太少（网络/限流/上游故障）→ 无法判定，交给周期 proof 兜底
    verdict = 'net';
  } else if (matched) {
    verdict = 'pass';
  } else {
    verdict = 'fail';
  }

  return {
    id: 'msgfp',
    verdict,
    ms: 0,
    detail: `fingerprint=${codes.join(',')}${matched ? ' ✓' : ' ✗'}` +
            `${validIdx.length < codes.length ? ` 有效${validIdx.length}/${codes.length}` : ''}` +
            `${abnormal.length ? ` 异常[${abnormal.join(' ')}]` : ''}` +
            `${probeErrs.size ? ` 错误[${[...probeErrs].map(([k, v]) => k + ':' + v).join(' ')}]` : ''}`,
    fingerprint: codes.join(','),
  };
}

function runOnePrecheckCase(c) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(c.body), 'utf8');
    // ★ P1-2：走 transport（见 oneChatLogprob 处的说明）
    const req = transport.request({
      host: HOST, port: HOST_PORT, path: c.path, method: 'POST', timeout: probeDeadlineMs(), signal: AbortSignal.timeout(probeDeadlineMs()),
      headers: { 'content-type': 'application/json', 'content-length': payload.length,
                 authorization: `Bearer ${KEY}`,
                 'x-opencode-session': STABLE_SESSION,
                 'x-opencode-session-id': STABLE_SESSION },
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { if (buf.length < 8192) buf += d; });
      res.on('end', () => {
        let msg = '';
        try { msg = JSON.parse(buf)?.error?.message || ''; } catch {}
        if (c.expect.test(msg)) {
          // 第 17 轮：e1 除文本匹配外，还校验内嵌 request_id 的形态。
          // 官方 Rust 服务端在 400 里带回 `(request_id: <uuid4>)`；自部署/异模型的
          // OpenAI 兼容层不会产出这个结构。只匹配文本容易被同文本的转发层骗过。
          if (c.requestIdUuid) {
            const m = msg.match(/request_id:\s*([0-9a-f-]{36})/i);
            if (!m || !UUID4.test(m[1])) {
              return resolve({ id: c.id, verdict: 'format',
                detail: 'request_id 缺失或非 UUID4: ' + msg.slice(0, 100) });
            }
          }
          return resolve({ id: c.id, verdict: 'pass' });
        }
        if (/Upstream request failed|Endpoint is unavailable|Model is unavailable/i.test(msg)) {
          return resolve({ id: c.id, verdict: 'gateway' });
        }
        if (res.statusCode === 429) return resolve({ id: c.id, verdict: 'rate' });
        if (res.statusCode >= 500) return resolve({ id: c.id, verdict: 'net' });
        // ★ 2026-10-23：把「判据失效」与「检测到第三方」分开。
        // 走到这里说明：状态码非 429/5xx，且报文里**没有**官方那句原话。
        // 这只证明「我们的判据对不上」（上游改文案 / 网关错误页 / 结构变化），
        // **不构成第三方证据**。原先归为 format → 聚合为 fail → 命中 fail 短路，
        // 会在仍有新鲜 pass 的情况下**立刻**全区 503；若文案永久变更则永久 503。
        // 现改为 drift：聚合为 unknown（不会短路），交付闸仍要求 pass → fail-closed 不变。
        return resolve({ id: c.id, verdict: 'drift', detail: msg.slice(0, 80) });
      });
    });
    // 2026-10-22 可观测性：把错误码写进 detail，否则台账只有 "e1:net"，
    // 无法区分 ECONNRESET / ENOTFOUND / AbortError（deadline）/ 其他。
    req.on('error', (e) => resolve({ id: c.id, verdict: 'net',
      detail: 'err=' + (e?.code || e?.name || String(e?.message || e)) }));
    req.on('timeout', () => { try { req.destroy(); } catch {} resolve({ id: c.id, verdict: 'net', detail: 'socket-timeout' }); });
    req.end(payload);
  });
}

/**
 * 每请求预检。返回 { verdict, passCount, trust, source }
 *   verdict: 'pass' | 'fail' | 'unknown'
 *   source : 'live'（本次实测）| 'cache'（TTL 内复用）| 'proof'（预检失败，退回周期探针）
 */
function precheck(proto = 'responses', opts = {}) {
  if (!PRECHECK_ENABLE) return Promise.resolve({ verdict: 'skip', passCount: 0, trust: 'bypass', source: 'disabled', proto });
  const strategy = PROTO_TRUST[proto] || 'idonly';
  if (strategy === 'idonly') {
    // 该协议策略为 idonly（当前无协议使用；msgfp 已覆盖 messages）
    return Promise.resolve({ verdict: 'unsupported', passCount: 0, trust: 'none', source: 'no_criteria', proto });
  }
  const force = opts.force === true;   // 后台保活用：绕过缓存做一次真探针

  // ★ 2026-10-22 缓存语义（两条，顺序不能换）：
  // ① 正向证据优先：最近一次实测若明确 fail（指纹不符 / request_id 非 UUID4），
  //    立刻按 fail 处理 —— 这是「第三方」的正向证据，不能被窗口内的旧 pass 掩盖。
  // ② 否则只要窗口内有过 pass 就复用。**只有 pass 进缓存**，net/timeout 不再毒化整个窗口。
  const lastAttempt = precheckLastFor(proto);
  if (!force && lastAttempt && lastAttempt.verdict === 'fail') {
    return Promise.resolve({ ...lastAttempt, source: 'live' });
  }
  const pcPass = precheckPassFor(proto);
  if (!force && pcPass && precheckTtlFor(proto) > 0
      && Date.now() - pcPass.at < precheckTtlFor(proto)) {
    return Promise.resolve({ ...pcPass, source: 'cache' });
  }
  const inflight = precheckInflight.get(proto);
  if (inflight) return inflight;

  function runStrategy() {
    if (strategy === 'eclass') {
      const cases = PRECHECK_CASES_BY_PROTO[proto] || [];
      return Promise.all(cases.map(runOnePrecheckCase));
    }
    if (strategy === 'logprob') return runChatPrecisionProbe().then(r => [r]);
    if (strategy === 'msgfp') return runMsgFingerprint().then(r => [r]);
    return Promise.resolve([]);
  }

  function aggregate(results) {
    const total = results.length;
    const passCount = results.filter(r => r.verdict === 'pass').length;
    // 授权口径：drift（文本不匹配）**必须计入 fail**。
    // 理由（2026-10-23 权衡后修正）：第三方不产生官方 e1 文案，所以「文本不匹配」
    // 既可能是判据漂移，也可能是后端真的换了。若把它降级为 unknown 而放行缓存 pass，
    // 就把「立即拒绝（零窗口）」换成「最长 90s 窗口」，与「第三方一律拒绝」的绑定目标冲突。
    // 因此：drift 仍参与 fail 判定（授权不变），但单独计数/留痕，便于区分「判据漂移」
    // 与「第三方证据」（format = 文本对上了但 request_id 不是 UUID4）。
    const failCount = results.filter(r => ['fail', 'format', 'drift'].includes(r.verdict)).length;
    const driftCount = results.filter(r => r.verdict === 'drift').length;

    let verdict;
    if (!total) verdict = 'unsupported';
    else if (passCount === total) verdict = 'pass';
    // O4「3 选 2 也算过」：**当前不可达** —— 三个策略各自都聚合为单条结果
    // （eclass 只剩 e1；logprob / msgfp 各返回 1 条），所以 total 恒为 1。
    // 保留该分支而不是删除：将来某个策略恢复多用例时不必重写判定，且不影响现有行为。
    else if (total >= 3 && passCount >= 2) verdict = 'pass';
    else if (failCount >= Math.max(1, Math.ceil(total / 2))) verdict = 'fail';
    else verdict = 'unknown';
    return { verdict, passCount, failCount, driftCount, total };
  }

  const run = (async () => {
    metrics.prechecks++;
    const runT0 = Date.now();   // ★ 实测耗时 → EWMA → 自适应探针上限
    const deadlineAtStart = probeDeadlineMs();   // 超时判定基准（探针被它截断时 tookMs ≈ 它）

    // 故障注入（仅供验证抗抖动逻辑）：GATE_FAULT_PRECHECK=jitter 时，
    // 每个协议第一次预检强制返回 fail，第二次起正常。用来证明「确认重测」确实能吸收抖动。
    const injectJitter = FAULT_PRECHECK === 'jitter' && !faultPrecheckFired.has(proto);
    if (injectJitter) faultPrecheckFired.add(proto);

    // 故障注入统一入口：always 模拟「后端真的变成非官方」的确定性失败，
    // 必须同时作用于首轮与重测，否则证不了「重测不会放过真非官方」。
    const evalAgg = (rs) => (FAULT_PRECHECK === 'always')
      ? { verdict: 'fail', passCount: 0, failCount: 1, total: 1 }
      : aggregate(rs);

    let results = injectJitter ? [] : await runStrategy();
    let agg = injectJitter
      ? { verdict: 'fail', passCount: 0, failCount: 1, total: 1 }
      : evalAgg(results);

    // 抗抖动：单次 fail 不足以定论。
    // 真实的「非官方后端」是确定性的，重测仍然 fail；网络抖动/瞬时限流重测通常恢复。
    // 只有连续失败才判 fail，否则降级为 unknown（交给周期 proof 做第三方意见）。
    let confirmed = 0, recovered = false;
    while (agg.verdict === 'fail' && confirmed < PRECHECK_CONFIRM) {
      confirmed++;
      metrics.precheckConfirm++;
      await new Promise(r => setTimeout(r, PRECHECK_CONFIRM_MS));
      const retryResults = await runStrategy();
      const retryAgg = evalAgg(retryResults);
      log({ ts: new Date().toISOString(), result: 'PRECHECK_CONFIRM', proto, strategy,
            attempt: confirmed, first: agg.verdict, retry: retryAgg.verdict,
            detail: retryResults.map(r => `${r.id}:${r.verdict}${r.detail ? '(' + r.detail + ')' : ''}`).join(',') });
      if (retryAgg.verdict === 'pass') {
        // 重测通过 → 判为抖动，按 pass 放行（并留痕）
        recovered = true;
        results = retryResults;
        agg = retryAgg;
        metrics.precheckJitterRecovered++;
        break;
      }
      if (retryAgg.verdict !== 'fail') {
        // 重测给出了非 fail 的其它结论 → 证据矛盾，降级为 unknown，由 proof 决定
        results = retryResults;
        agg = { ...retryAgg, verdict: 'unknown' };
        break;
      }
      results = retryResults;
      agg = retryAgg;
    }

    const { verdict, passCount, total, driftCount = 0 } = agg;
    if (verdict === 'fail') metrics.precheckFail++;
    const tookMs = Date.now() - runT0;
    // ★ 探针被上限截断时 tookMs≈deadline（abort），必须显式告知 EWMA 以触发跳档
    const probeTimedOut = tookMs >= deadlineAtStart - 100;
    probeEwmaUpdate(tookMs, probeTimedOut);
    const rec = { at: Date.now(), proto, strategy, verdict, passCount, total, results, ms: tookMs };
    precheckLastByProto.set(proto, rec);
    // ★ 只缓存 pass（见 precheckPassByProto 注释）
    if (verdict === 'pass') precheckPassByProto.set(proto, rec);
    log({ ts: new Date().toISOString(), result: 'PRECHECK', proto, strategy, verdict, passCount, ms: tookMs,
          deadlineMs: probeDeadlineMs(), ewmaMs: Math.round(precheckEwmaMs),
          confirmed: confirmed > 0 ? confirmed : undefined, recovered: recovered || undefined,
          detail: results.map(r => `${r.id}:${r.verdict}${r.detail ? '(' + r.detail + ')' : ''}`).join(',') });
    // ★ 2026-10-23：判据漂移单独计量 + 进 /gate/alerts，避免「静默失效」。
    if (driftCount > 0) {
      metrics.precheckDrift = (metrics.precheckDrift || 0) + 1;
      recordFailure({ kind: 'precheck-drift', type: 'precheck_criterion_drift', status: 0, proto,
                      detail: String(results.find(r => r.verdict === 'drift')?.detail || '').slice(0, 120),
                      elapsedMs: Date.now() - runT0 });
      log({ ts: new Date().toISOString(), result: 'PRECHECK_DRIFT', proto, strategy,
            detail: results.map(r => r.id + ':' + r.verdict).join(',') });
    }
    return { ...rec, source: 'live' };
  })();

  precheckInflight.set(proto, run);
  run.finally(() => { if (precheckInflight.get(proto) === run) precheckInflight.delete(proto); });
  return run;
}

/** 综合判定：预检优先，预检拿不到结论时退回周期 proof */
async function trustDecision(precheckPromise, proto = 'responses') {
  const pgate = proofGate();

  // 自检开关：FORCE_THIRD=1 时强制「所有车道都不可信」，
  // 用于验证 fail-closed 真的生效（零字节交付）。
  // 必须在这里返回，否则会被预检的 allowAllLanes 绕过，自检就名存实亡。
  if (FORCE_THIRD) {
    metrics.forcedThird++;
    return { allowAllLanes: false, trust: 'forced', source: 'force_third',
             precheck: { verdict: 'skip', source: 'force_third' }, proof: pgate };
  }

  let pc;
  // race 不会取消败者：不 clearTimeout 的话，每个请求都会残留一个 PRECHECK_WAIT_MS 的定时器
  let waitTimer = null;
  try {
    pc = await Promise.race([
      precheckPromise || precheck(proto),
      new Promise(r => { waitTimer = setTimeout(() => r({ verdict: 'timeout', source: 'timeout' }), precheckWaitMs()); }),
    ]);
  } catch {
    pc = { verdict: 'unknown', source: 'error' };
  } finally {
    if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
  }

  // 策略为 idonly 时无法验证（保留分支以兼容 GATE_BLOCK_PROTOS 等场景），不允许放开全部车道
  if (pc.verdict === 'unsupported') {
    metrics.precheckUnsupported = (metrics.precheckUnsupported || 0) + 1;
    return { allowAllLanes: false, trust: 'idonly', source: 'no_criteria', precheck: pc, proof: pgate };
  }
  // 预检明确通过 → 高信任（仅对该协议生效）
  if (pc.verdict === 'pass') {
    return { allowAllLanes: true, trust: 'full', source: pc.source, precheck: pc, proof: pgate };
  }
  // 预检明确失败 → 拒绝（enforce 时）
  if (pc.verdict === 'fail') {
    // 预检已通过「确认重测」（连续两次独立采样一致）—— 这是实时证据。
    // 旧的周期 proof（最长 PROOF_MAX_AGE_MS=10 分钟）无权否决实时证据：
    // 只有 proof 在最近 OVERRIDE_FRESH_MS 内刷新过，才说明「外部探针此刻也在说官方」，
    // 才允许覆盖。否则一律按预检结论拒绝。
    //
    // 实测（2026-10-20）：不加新鲜度要求时，预检连续 3 次 fail 仍被 10 分钟前的
    // proof 覆盖放行（overridden=3, blocked=0），等于实时判据形同虚设。
    const proofFreshForOverride = pgate.allowAllLanes
      && typeof pgate.ageMs === 'number' && pgate.ageMs <= OVERRIDE_FRESH_MS;
    if (proofFreshForOverride) {
      metrics.precheckFailOverridden = (metrics.precheckFailOverridden || 0) + 1;
      log({ ts: new Date().toISOString(), result: 'PRECHECK_OVERRIDDEN_BY_PROOF', proto,
            proofTrust: pgate.trust, proofAgeMs: pgate.ageMs, overrideFreshMs: OVERRIDE_FRESH_MS,
            precheck: (pc.results || []).map(r => r.id + ':' + r.verdict).join(',') });
      return { allowAllLanes: true, trust: pgate.trust, source: 'proof_over_precheck_fail', precheck: pc, proof: pgate };
    }
    if (pgate.allowAllLanes) {
      // proof 有效但太旧：记录下来，便于事后判断是否是探针长期未刷新
      metrics.precheckFailProofStale = (metrics.precheckFailProofStale || 0) + 1;
      log({ ts: new Date().toISOString(), result: 'PRECHECK_FAIL_PROOF_TOO_OLD', proto,
            proofTrust: pgate.trust, proofAgeMs: pgate.ageMs, overrideFreshMs: OVERRIDE_FRESH_MS,
            precheck: (pc.results || []).map(r => r.id + ':' + r.verdict).join(',') });
    }
    return { allowAllLanes: false, trust: 'none', source: pc.source, precheck: pc, proof: pgate,
             blocked: PROOF_MODE === 'enforce' };
  }
  // 预检拿不到结论（超时/网络/网关拦截）→ 退回周期 proof，不误杀
  const fallbackAllow = pgate.allowAllLanes;
  return { allowAllLanes: fallbackAllow, trust: pgate.trust, source: 'proof_fallback', precheck: pc, proof: pgate };
}

// ---------- 官方性证明（proof）：读外部探针结论，决定信任级别 ----------
// 设计要点：
//   D2  proof 有明确有效期，不在窗口内不采信
//   D3  不阻塞请求等待探针；用当前 proof 的最新结论，过期则由 mode 决定行为
//   D4  六态错误分类已在探针侧完成，这里只消费 verdict/trust
//   D7  proof 内容为 unknown（探针本身判不了）时按中等信任处理，不误杀
//   O3  trust != full 时自动收紧采信龄期
//   D6  PROOF_MODE=off 时完全绕过，作为 kill switch
let proofCache = null;      // { data, readAt, fileMtimeMs }
let proofState = null;      // 归一后的状态

function readProofFile() {
  try {
    const st = fs.statSync(PROOF_FILE);
    if (proofCache && proofCache.fileMtimeMs === st.mtimeMs
        && Date.now() - proofCache.readAt < PROOF_RELOAD_MS) {
      return proofCache.data;
    }
    const data = JSON.parse(fs.readFileSync(PROOF_FILE, 'utf8'));
    proofCache = { data, readAt: Date.now(), fileMtimeMs: st.mtimeMs };
    return data;
  } catch {
    return null;
  }
}

/**
 * 计算当前信任状态。
 * 返回 { mode, trust, reason, ageMs, verdict, strict, allowAllLanes }
 *   allowAllLanes=true  → 不再按 id 形态过滤车道
 *   allowAllLanes=false → 退回保守策略（只放行 id=UUID4 的车道）
 */
function proofGate() {
  if (PROOF_MODE === 'off') {
    return { mode: 'off', trust: 'bypass', reason: 'proof_off', ageMs: 0, allowAllLanes: false };
  }
  const data = readProofFile();
  if (!data) {
    if (PROOF_MODE === 'enforce') {
      metrics.proofStale++;
      return { mode: PROOF_MODE, trust: 'none', reason: 'proof_missing', ageMs: Infinity, allowAllLanes: false };
    }
    metrics.proofStale++;
    return { mode: PROOF_MODE, trust: 'unknown', reason: 'proof_missing_monitor', ageMs: Infinity, allowAllLanes: false };
  }
  const ageMs = Date.now() - new Date(data.ts).getTime();
  // O3：信任不足时收紧龄期，逼迫探针更快刷新
  // full 与 high 都用宽松龄期；只有 low/unknown 才收紧
  // （探针 10 分钟一轮，2 分钟龄期会让 high 必然 stale）
  const gateAgeLimit = (data.trust === 'full' || data.trust === 'high') ? PROOF_MAX_AGE_MS : PROOF_STRICT_AGE_MS;
  // ★ P1-5：proof 文件自带 expiresAt（探针侧写的是 ts+1800s），门控侧另有
  // PROOF_MAX_AGE_MS（600s），两个有效期并存 → 看两个数的人会得出不同结论，
  // 而门控此前压根不读 expiresAt（等于探针的声明是装饰）。
  // 统一口径：两边都认，取更严的那个。当前 600 < 1800，所以行为不变，
  // 但若哪天探针把有效期调短，门控会立刻跟随，不再出现「声明了却不生效」。
  let declaredAgeMs = null;
  try {
    if (data.expiresAt && data.ts) {
      const d = Date.parse(data.expiresAt) - Date.parse(data.ts);
      if (Number.isFinite(d) && d > 0) declaredAgeMs = d;
    }
  } catch {}
  const ageLimit = declaredAgeMs ? Math.min(gateAgeLimit, declaredAgeMs) : gateAgeLimit;
  const fresh = ageMs <= ageLimit;

  if (!fresh) {
    metrics.proofStale++;
    if (PROOF_MODE === 'enforce') {
      return { mode: PROOF_MODE, trust: 'none', reason: 'proof_stale', ageMs, verdict: data.verdict, allowAllLanes: false };
    }
    return { mode: PROOF_MODE, trust: 'unknown', reason: 'proof_stale_monitor', ageMs, verdict: data.verdict, allowAllLanes: false };
  }

  const trust = data.trust || 'unknown';
  if (trust === 'full' || trust === 'high') {
    metrics.proofPass++;
    return { mode: PROOF_MODE, trust, reason: 'proof_pass', ageMs, verdict: data.verdict, allowAllLanes: true };
  }
  // degraded / medium：探针部分通过或判不了。enforce 下收紧到只信任官方车道，monitor 下放行但记录
  metrics.proofPartial++;
  if (PROOF_MODE === 'enforce' && data.verdict === 'fail') {
    return { mode: PROOF_MODE, trust, reason: 'proof_fail', ageMs, verdict: data.verdict, allowAllLanes: false };
  }
  return { mode: PROOF_MODE, trust, reason: `proof_${trust}`, ageMs, verdict: data.verdict, allowAllLanes: false };
}

// ---------- 路由矩阵缓存 ----------
const matrix = new Map(); // `${model}|${proto}` -> {verdict, idShape, ts, classifier}
const mkey = (model, proto) => `${model}|${proto}`;
function cacheGet(model, proto) {
  const e = matrix.get(mkey(model, proto));
  if (!e) return null;
  if (Date.now() - e.ts > PROBE_TTL) { matrix.delete(mkey(model, proto)); return null; }
  return e;
}
function cacheSet(model, proto, r) {
  // 只有上游 2xx 响应才能代表这条车道当前落在谁那里。
  // 4xx/5xx（路径错误、body 不合法、限流、上游故障）与连接错误都不能用于车道判定，
  // 否则一次坏请求会让整条车道在 TTL 内被判 third，导致后续正常请求全部 fail-closed。
  if (r.verdict === 'error') return;
  if (!(typeof r.status === 'number' && r.status >= 200 && r.status < 300)) return;
  matrix.set(mkey(model, proto), { verdict: r.verdict, idShape: r.idShape || '', classifier: r.classifier, ts: Date.now() });
}
/** 启动时加载上次快照：TTL 内直接复用，免冷启动探针 */
function loadSnapshot() {
  try {
    const j = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf8'));
    const age = Date.now() - Date.parse(j.updatedAt);
    if (!(age >= 0 && age < PROBE_TTL)) return 0;
    let n = 0;
    for (const row of j.rows || []) {
      const [model, proto] = String(row.key).split('|');
      if (!model || !proto) continue;
      if (!ALLOWED.includes(model)) continue;
      matrix.set(row.key, { verdict: row.verdict, idShape: row.idShape || '', classifier: row.classifier, ts: Date.now() - (row.ageMs || age) });
      n++;
    }
    return n;
  } catch { return 0; }
}

async function rankCandidates(requestedModel, proto, pathName, body, incoming, signal, deadline) {
  // 硬约束：请求里若带上被禁止或不在链上的模型，一律归一到链路首项，绝不给它发请求
  const model = ALLOWED.includes(requestedModel) ? requestedModel : ALLOWED[0];
  const verdicts = new Map();
  if (!USE_PROBE) { for (const m of ALLOWED) verdicts.set(m, 'unknown'); return { order: ALLOWED, notes: [], verdicts }; }
  // 近期预检已确认后端为官方未量化模型时，id 形态探测已无必要：直接按链路顺序发。
  // 必须同协议：responses 的预检结论不能拿来跳过 messages/chat 的车道探测。
  //
  // 2026-10-20 修正：这里原来是硬编码 30000，**不受任何配置控制**。后果是
  // 即使 PRECHECK_TTL_MS=0（让预检每请求重跑求实时），这一层仍会用 30 秒前的
  // 预检结论跳过探测、并把所有车道标成 unknown —— 预检的实时性被悄悄二次缓存。
  //
  // 现在拆成独立开关，两者互不强制绑定：
  //   GATE_PRECHECK_TTL_MS=0      → 预检每请求重跑（实时证据）
  //   GATE_SKIP_PROBE_TTL_MS=30000 → 探测仍可复用近期结论（省一次上游请求）
  // 这是有意的组合：预检提供实时判据，跳过探测只负责省事。实测每请求都探测
  // 会显著增加上游超时暴露面（probes 翻倍 → 偶发 503），而探测结论本身给出的
  // 是 unknown，对最终判定没有增益。
  const skipProbeTtl = SKIP_PROBE_TTL_MS;
  // ★ 2026-10-22：读「新鲜 pass」而非「最近一次尝试」。只缓存 pass 之后，
  // 最近一次尝试可能是 net；沿用旧写法会让本判断失效 → 上游最慢时反而放大探测。
  const pcTok = precheckPassFor(proto);
  if (PRECHECK_ENABLE && pcTok && pcTok.verdict === 'pass' && skipProbeTtl > 0
      && Date.now() - pcTok.at < skipProbeTtl) {
    for (const m of ALLOWED) verdicts.set(m, 'unknown');
    return { order: ALLOWED.slice(), notes: [{ skippedProbe: 'precheck_fresh', proto, precheckAt: pcTok.at }], verdicts };
  }
  const notes = [];
  const hit = cacheGet(model, proto);
  if (hit && hit.verdict === 'official') {
    for (const m of ALLOWED) verdicts.set(m, cacheGet(m, proto)?.verdict || 'unknown');
    verdicts.set(model, 'official');
    return { order: [model, ...ALLOWED.filter(m => m !== model)], notes: [{ model, cached: true, verdict: 'official', idShape: hit.idShape }], verdicts };
  }
  const official = [], unknownOrThird = [];
  // 连接层失败后不再探测同主机的其它车道：上游整体不响应时，
  // 逐个车道各等一个 PROBE_TIMEOUT_MS 只会把延迟叠加，结论却一样。
  let probeConnFailed = false;
  for (const m of ALLOWED) {
    if (official.length) { const e = cacheGet(m, proto); verdicts.set(m, e?.verdict || 'unknown'); unknownOrThird.push(m); continue; }
    if (probeConnFailed) {
      notes.push({ model: m, skipped: 'upstream_unreachable', verdict: 'error' });
      verdicts.set(m, 'error');
      unknownOrThird.push(m);
      continue;
    }
    let e = cacheGet(m, proto);
    if (!e) {
      // 预算不够给探针留出至少一个探测周期时，直接按 unknown 处理（交给真实请求自证），
      // 否则上游 hang 住时探针会把整条预算吃光，客户端得傻等。
      const budgetLeft = typeof deadline === 'number' ? deadline - Date.now() : Infinity;
      if (budgetLeft < PROBE_TIMEOUT_MS + 1000) {
        notes.push({ model: m, skipped: 'budget', verdict: 'unknown' });
        verdicts.set(m, 'unknown');
        unknownOrThird.push(m);
        continue;
      }
      const r = await probe(pathName, { ...body, model: m }, incoming, signal);
      if (r.verdict === 'error' && !r.status) probeConnFailed = true;
      cacheSet(m, proto, r);
      notes.push({ model: m, probed: true, verdict: r.verdict, idShape: r.idShape, classifier: r.classifier });
      e = { verdict: r.verdict, idShape: r.idShape };
    } else {
      notes.push({ model: m, cached: true, verdict: e.verdict, idShape: e.idShape });
    }
    verdicts.set(m, e.verdict);
    (e.verdict === 'official' ? official : unknownOrThird).push(m);
  }
  return { order: [...official, ...unknownOrThird], notes, verdicts };
}

// ---------- 快照与后台预热 ----------
function writeSnapshot() {
  try {
    const now = Date.now();
    const rows = [...matrix.entries()].map(([k, v]) => ({
      key: k, verdict: v.verdict, idShape: v.idShape || '', classifier: v.classifier, ageMs: now - v.ts,
    })).sort((a, b) => a.key.localeCompare(b.key));
    const tmp = SNAPSHOT_FILE + '.tmp';
    fs.mkdirSync(path.dirname(SNAPSHOT_FILE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify({ updatedAt: new Date(now).toISOString(), ttlMs: PROBE_TTL, chain: ALLOWED, rows }, null, 2));
    fs.renameSync(tmp, SNAPSHOT_FILE);
  } catch {}
}

const SYNTH_BODY = {
  responses: { input: 'ping', max_output_tokens: 1 },
  messages: { max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
  chat: { max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
};
const PROTO_PATH = {
  responses: '/zen/go/v1/responses',
  messages: '/zen/go/v1/messages',
  chat: '/zen/go/v1/chat/completions',
};

let refreshing = false;
const alerts = [];   // 最近告警（内存环形，最多 50 条）
function pushAlert(kind, detail) {
  const rec = { ts: new Date().toISOString(), kind, ...detail };
  alerts.push(rec);
  if (alerts.length > 50) alerts.shift();
  log({ ...rec, result: 'ALERT_' + kind });
  try { console.error('[ALERT] ' + kind + ' ' + JSON.stringify(detail)); } catch {}
}

async function refreshMatrix() {
  if (refreshing || !USE_PROBE) return;
  refreshing = true;
  try {
    // ★ P1-3：必须覆盖三条协议。原来漏了 chat → chat 车道永不进矩阵，
    // /gate/matrix 看不到它，ALL_LANES_DEGRADED 告警也永远不覆盖 chat。
    // 代价：每轮多 2 个 1-token 探针（约 20 token），可忽略。
    for (const proto of ['responses', 'messages', 'chat']) {
      // 消除与「官方探针任务」的重叠（2026-10-20）：
      // 官方探针每 3 分钟跑一轮 eclass/logprob/msgfp 并写 official-proof.json，已经在验证
      // 「后端是否官方」这件事。若该协议的预检刚刚通过，说明官方性已由独立判据证明，
      // 这里再打一遍车道探测纯属重复消耗 opencode.ai 的 RPM。
      //
      // 正常情况（预检通过）→ 完全跳过，refreshMatrix 不产生任何上游请求。
      // 异常情况（预检未通过）→ 才真正探测，从而保留 ALL_LANES_DEGRADED 告警的能力。
      // 也就是说：这个后台任务从「周期性重复验证」变成「预检异常时的补充诊断」。
      // ★ 同上：读新鲜 pass，避免 net 让后台刷新退化成高频探测
      const pcR = precheckPassFor(proto);
      const pcFresh = PRECHECK_ENABLE && pcR
        && pcR.verdict === 'pass'
        && Date.now() - pcR.at < Math.max(SKIP_PROBE_TTL_MS, 1000);
      if (pcFresh) {
        metrics.refreshSkippedByPrecheck = (metrics.refreshSkippedByPrecheck || 0) + 1;
        continue;
      }
      for (const model of ALLOWED) {
        let r;
        try { r = await withSlot(() => probe(PROTO_PATH[proto], { ...SYNTH_BODY[proto], model }, {})); }
        catch { continue; }
        cacheSet(model, proto, r);
      }
    }
  } catch {}
  refreshing = false;
  writeSnapshot();
  // 上游规则变化检测：某协议下所有车道都不再是官方 → 上游路由变了，必须告警
  //
  // ★ P1-3 的边界：矩阵刷新覆盖三条协议（可见性），但**告警判定只做 responses / messages**。
  // 原因（实测）：chat 车道的 id 形态恒为 chatcmpl / other（网关产物）→ 永远 third，
  // 若把 chat 纳入「全部非 official 就告警」，就会每轮刷一条 ALL_LANES_DEGRADED，
  // 50 条环形缓冲会被噪音占满，反而把 responses/messages 的真告警挤掉。
  // chat 的官方性由 proof（logprob 精度）负责，那属于另一条独立告警线。
  for (const p of ['responses', 'messages']) {
    const rows = ALLOWED.map(m => ({ model: m, verdict: cacheGet(m, p)?.verdict || 'unknown' }));
    // ★ 告警判据修正（与 P0-1/P1-3 同源）：只有「明确的反面信号」才算降级。
    //
    // 旧判据是 `every(v => v !== 'official')`，但上游 2026-10-20 起 responses 常态返回
    // `resp_`（中性 unknown）→ 旧判据会让 responses **每轮预热都报一次**
    // ALL_LANES_DEGRADED，50 条环形缓冲几小时被占满，真告警（全 third / 全不可达）
    // 反而被挤出去。实测：新实例起来后第一轮预热就刷了一条 responses 告警。
    //
    // 现在：全部 third（确证第三方）或全部 error（不可达）才告警；unknown 属「无法判定」，
    // 不构成降级证据 —— 与交付侧「unknown 需 trust 背书才放行」的口径保持一致。
    const degraded = rows.every(x => x.verdict === 'third' || x.verdict === 'error');
    if (degraded) {
      const sig = rows.map(x => x.model + ':' + x.verdict).join(',');
      if (lastAlertSig.get(p) !== sig) {
        lastAlertSig.set(p, sig);
        pushAlert('ALL_LANES_DEGRADED', { proto: p, lanes: rows });
      }
    } else if (lastAlertSig.has(p)) {
      lastAlertSig.delete(p);
      pushAlert('LANES_RECOVERED', { proto: p, lanes: rows });
    }
  }
}
const lastAlertSig = new Map();

// ---------- 对冲 ----------
async function hedgeRace(models, args, proto, allowThird = false) {
  const ctrls = models.map(() => new AbortController());
  const seen = [];
  return new Promise((resolve) => {
    let settled = false, pending = models.length;
    models.forEach((m, i) => {
      realRequest({ ...args, model: m, signal: ctrls[i].signal }).then((r) => {
        // 已定胜负后迟到的车道：它的 upstream stream 必须销毁，
        // 否则 hedge 提前返回时这条连接会一直挂着（每轮泄漏一个 socket）。
        if (settled) { try { r.stream && r.stream.destroy(); } catch {} return; }
        seen.push({ model: m, r });
        try { cacheSet(m, proto, r); } catch {}
        if (r.verdict === 'official') {
          settled = true;
          ctrls.forEach((c, j) => { if (j !== i) { try { c.abort(); } catch {} } });
          resolve({ winner: { model: m, r }, all: seen });
          return;
        }
        // proof 高信任时，id 形态非 UUID4 但上游 2xx 也可直接胜出：
        // 后端已由探针证明为官方未量化模型，没必要为了 id 形态多等一个车道。
        //
        // ★ 2026-10-20 收窄：只允许 **unknown**（resp_ 等中性形态）在 hedge 直接胜出。
        // `third`（HEX32/chatcmpl）是强反面信号，必须交给主循环处理 ——
        // 那里会区分「缓存 pass（需现场重验）」与「预检确认失败被 proof 覆盖（必须拒绝）」。
        // 实测：放开 third 时，预检 fail 被 proof 覆盖后 HEX32 响应会经 hedge 直接交付
        // （2/3 请求 200），完全绕过了主循环的拦截逻辑。
        // ★ 2026-10-20 第 17 轮：hedge 同样受身份白名单约束。
        // 原逻辑允许任意 unknown 在 hedge 直接胜出，会绕过主循环对「无 id」的拒绝。
        // 现在只允许 resp_（网关改写产物，仍需 allowAllLanes 背书）。
        if (allowThird && r.verdict === 'unknown' && DELIVERABLE_SHAPES.has(r.idShape) && r.status >= 200 && r.status < 300) {
          settled = true;
          ctrls.forEach((c, j) => { if (j !== i) { try { c.abort(); } catch {} } });
          resolve({ winner: { model: m, r }, all: seen });
          return;
        }
        pending -= 1;
        if (pending === 0) {
          settled = true;
          // 无胜者：必须释放所有已建立的 upstream stream，
          // 否则主循环会重新发起请求，而这里的连接一直挂着（泄漏）。
          for (const { r } of seen) { try { r.stream && r.stream.destroy(); } catch {} }
          resolve({ winner: null, all: seen });
        }
      }).catch((e) => {
        // 必须兜底：handler 里任何抛错都会让 pending 永不归零，
        // 而 hedgeRace 的 Promise 只在 pending===0 时 resolve → 整个请求挂死。
        log({ ts: new Date().toISOString(), result: 'HEDGE_LANE_ERROR', model: m, error: String(e?.message || e) });
        if (settled) return;
        pending -= 1;
        if (pending === 0) { settled = true; resolve({ winner: null, all: seen }); }
      });
    });
  });
}

/**
 * 提前响应（404/405/413）时必须先把未读的请求体排空。
 * 否则客户端（尤其 Node undici / 浏览器 fetch）还在 upload 时连接被关，只会看到 ECONNRESET 而不是我们的状态码。
 */
function replyEarly(req, res, status, payload, extraHeaders) {
  try { req.resume(); } catch {}
  const headers = { 'content-type': 'application/json', connection: 'close', ...(extraHeaders || {}) };
  try { res.writeHead(status, headers).end(JSON.stringify(payload)); } catch {}
}

function redactHeaders(raw) {
  // rawPacket 里含 authorization 等敏感头：只保留请求行 + header 名，值一律打码
  try {
    const text = String(raw || '').split('\r\n\r\n')[0];
    const lines = text.split(/\r?\n/).filter(Boolean);
    const out = [lines[0] || '(no request line)'];
    for (const ln of lines.slice(1)) {
      const i = ln.indexOf(':');
      if (i > 0) out.push(ln.slice(0, i) + ': <redacted>');
      else out.push('<malformed> ' + JSON.stringify(ln.slice(0, 60)));
    }
    return out.join(' | ').slice(0, 600);
  } catch { return '(unparseable)'; }
}

const server = http.createServer(async (req, res) => {
  try { await handle(req, res); }
  catch (e) {
    log({ ts: new Date().toISOString(), result: 'HANDLER_ERROR', error: String(e?.message || e) });
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'gate_handler_error', message: String(e?.message || e) } }));
      } else if (!res.writableEnded) {
        // 已经进入流式交付：此时再 end(json) 会把错误 JSON 追加到响应体里，
        // 客户端会收到损坏的 SSE/JSON。直接掐断连接，让客户端看到「流被中断」。
        res.destroy();
      }
    } catch {}
  }
});

// Node 的 HTTP 解析器在请求畸形时（CL/TE 冲突、header 含控制字符、非法方法…）
// 会**绕过 handler 直接回 400 且完全无 body**。客户端只看到 "400 status code (no body)"，
// 台账里也查不到任何记录 —— 极难排查。这里接管 clientError：
//   ① 记录可诊断的失败原因（header 值全部打码）② 返回带 JSON body 的 400。
server.on('clientError', (err, socket) => {
  try {
    // ★ P0-2：健康检查型心跳（建 TCP 后立即断开，一个字节都不发）、以及客户端在上传
    // body 中途掉线，都会以「连接层错误 + 没有请求行」的形式进来。它们不是 HTTP 解析失败，
    // 也不该写 ERROR 级台账。
    //
    // 实测：watchdog 每 2 分钟一次 → 累计 114 条假 HTTP_PARSE_ERROR，
    // 把 README 里「看解析失败次数 / 看 rawPacket 定位 400 no body」这条诊断法污染了。
    // 另一类 HPE_INVALID_EOF_STATE 同样无请求行（对端提前关闭），一并归入连接层。
    //
    // 判据：错误码属连接层 **且** 服务器连请求行都没读到（rawPacket 为空）。
    // 只要读到了请求行（例如 HPE_HEADER_OVERFLOW），仍按真实畸形请求记录。
    const CONN_LEVEL_CODES = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'HPE_INVALID_EOF_STATE']);
    if (!err?.rawPacket && CONN_LEVEL_CODES.has(err?.code)) {
      metrics.clientResets = (metrics.clientResets || 0) + 1;
      try { socket.destroy(); } catch {}
      return;
    }
    const info = {
      ts: new Date().toISOString(),
      result: 'HTTP_PARSE_ERROR',
      code: err?.code || '',
      error: String(err?.message || err),
      raw: redactHeaders(err?.rawPacket),
      port: PORT, pid: process.pid,
    };
    metrics.httpParseErrors = (metrics.httpParseErrors || 0) + 1;
    log(info);
    if (socket.writable) {
      const body = JSON.stringify({
        error: {
          type: 'gate_http_parse_error',
          message: '门控未能解析该 HTTP 请求（不是路由判定问题）。' + (err?.code ? ' 原因码：' + err.code : ''),
          detail: String(err?.message || err).slice(0, 200),
        },
      });
      socket.end(
        'HTTP/1.1 400 Bad Request\r\n' +
        'content-type: application/json\r\n' +
        'content-length: ' + Buffer.byteLength(body) + '\r\n' +
        'x-gate-result: http-parse-error\r\n' +
        'connection: close\r\n\r\n' + body
      );
    } else {
      socket.destroy();
    }
  } catch {}
});


async function handle(req, res) {
  // 客户端断开就立刻中止这条请求链上的所有上游调用（probe / 真实请求 / 重试），
  // 否则用户取消后门控仍会继续烧 token。
  const clientGone = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) { metrics.abortedByClient++; try { clientGone.abort(); } catch {} }
  });

  // 代理请求统一记录总耗时（/gate/* 自身的管理端点不计入）
  const isProxy = req.method === 'POST' && !req.url.startsWith('/gate/');
  const startedAt = Date.now();
  // 总预算从收到请求那一刻开始算：探针也计入，否则上游 hang 时探针会把预算吃穿
  const deadline = startedAt + TOTAL_BUDGET_MS;
  const remainMs = () => deadline - Date.now();
  // ★ DNS rebinding 防护：必须在**所有**响应出口之前，包括 /gate/* 观测端点。
  //   旧实现把这段放在 isProxy 分支里（在 /gate/health、/gate/proof 之后才执行），
  //   实测 `curl -H 'Host: evil.example' /gate/proof` 返回 200：rebind 页面仍是同源，
  //   能直接读走响应体（含本机绝对路径）。Host 头缺失（HTTP/1.0）时放行——浏览器一定带 Host。
  {
    const hostHdr = String(req.headers.host || '');
    if (hostHdr && !/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(hostHdr)) {
      const hid = Math.random().toString(16).slice(2, 10);
      const safeHostPath = String(req.url).split('?')[0];
      recordFailure({ kind: 'client', type: 'gate_bad_host', status: 421, path: safeHostPath, elapsedMs: Date.now() - startedAt });
      log({ ts: new Date().toISOString(), reqId: hid, result: 'BAD_HOST', path: safeHostPath });
      res.writeHead(421, { 'content-type': 'application/json', 'x-gate-result': 'blocked', 'x-gate-reason': 'bad_host' });
      return res.end(JSON.stringify({ error: { type: 'gate_bad_host', message: '只接受指向 127.0.0.1 / localhost 的请求（Host 头不符）。', request_id: hid } }));
    }
  }
  // 可选本地鉴权（见 GATE_TOKEN 注释）。401 计入 client 类失败台账，与 404/400 同级。
  if (isProxy && GATE_TOKEN) {
    const got = String(req.headers['x-gate-token'] || '');
    if (!tokenMatches(got)) {
      // 台账只记路径，不记 query：token 被误放进 URL 时不能顺手写进日志
      const safePath = String(req.url).split('?')[0];
      metrics.unauthorized = (metrics.unauthorized || 0) + 1;
      recordFailure({ kind: 'client', type: 'gate_unauthorized', status: 401, path: safePath, elapsedMs: Date.now() - startedAt });
      log({ ts: new Date().toISOString(), result: 'UNAUTHORIZED', path: safePath });
      res.writeHead(401, { 'content-type': 'application/json', 'x-gate-result': 'blocked', 'x-gate-reason': 'unauthorized' });
      return res.end(JSON.stringify({
        error: {
          type: 'gate_unauthorized',
          message: '本门控已启用 GATE_TOKEN：代理请求必须带请求头 x-gate-token。' +
                   '（客户端里配置该请求头即可；/gate/* 观测端点不需要）',
        },
      }));
    }
  }
  // ★ P2-6：只挂 finish 会让 503 与被客户端中断的请求完全不进延迟样本，
  // 于是 /gate/latency 的 p50/p95 只代表「成功请求」，系统性低估用户真实感知的延迟。
  // 改为一律记录一次（finish / close 谁先到算谁，同一请求只记一次）。
  if (isProxy) {
    let latDone = false;
    const recordOnce = () => { if (!latDone) { latDone = true; recordLatency(Date.now() - startedAt); } };
    res.on('finish', recordOnce);
    res.on('close', recordOnce);
  }

  if (req.method === 'GET' && req.url === '/gate/health') {
    // 第 17 轮：health 不再只是「进程活着」，要把「能不能真服务」也暴露出来，
    // 否则 watchdog 只能看到 ok=true，发现不了「端口通但上游全 503」的假活状态。
    const pg = proofGate();
    const lastPc = precheckLastFor('responses') || precheckLastFor('messages') || null;
    return res.end(JSON.stringify({
      ok: true, chain: ALLOWED, forbidden: [...FORBIDDEN], probe: USE_PROBE, ttl: PROBE_TTL,
      blind: 'block', port: PORT,
      // 身份白名单（第 17 轮）
      deliverableShapes: [...DELIVERABLE_SHAPES],
      blockedProtos: [...BLOCKED_PROTOS],
      // 判活辅助
      proofTrust: pg.trust, proofReason: pg.reason,
      // 预检时序参数（可验证运行值：外层等待必须 > e1 探针超时 8000ms）
      precheckWaitMs: precheckWaitMs(), precheckConfirm: PRECHECK_CONFIRM,
      precheckTtlMs: { ...PRECHECK_TTL_BY_PROTO },
      // 探针上限自适应（2026-10-22）：deadline = clamp(K×EWMA, MIN, MAX)
      probeDeadlineMs: probeDeadlineMs(),
    probeDeadlineCap: probeDeadlineCap(),
    minUpstreamBudgetMs: MIN_UPSTREAM_BUDGET_MS,
    totalBudgetMs: TOTAL_BUDGET_MS,
    budgetInvariantOk: (precheckWaitMs() + Math.min(MIN_UPSTREAM_BUDGET_MS, Math.floor(TOTAL_BUDGET_MS * 0.5)) <= TOTAL_BUDGET_MS), probeDeadlineMin: PROBE_DEADLINE_MIN, probeDeadlineMax: PROBE_DEADLINE_MAX,
      probeDeadlineAdaptive: PROBE_DEADLINE_OVERRIDE === null, precheckEwmaMs: Math.round(precheckEwmaMs),
      proofRefreshMs: num('GATE_PROOF_REFRESH_MS', 25000, { min: 5000, max: 300000 }),
      lastPass: Object.fromEntries(['responses','messages'].map(p => { const x = precheckPassFor(p); return [p, x ? Date.now() - x.at : null]; })),
      lastPrecheck: lastPc ? { proto: lastPc.proto, verdict: lastPc.verdict, ageMs: Date.now() - lastPc.at } : null,
      // 保护状态可见性（对外信任设计的核心）：判据最近一次成功距今多久、当前连的是哪
      judgeAgeMs: lastPc ? Date.now() - lastPc.at : null,
      lastJudgeOk: !!lastPc && lastPc.verdict === 'pass',
      egressHost: `${HOST}:${HOST_PORT}`,
      tokenRequired: !!GATE_TOKEN,
      baselineObservedAt: OBSERVED_AT,
      startupSelfTest,
      rejectedThirdShape: metrics.rejectedThirdShape, rejectedUnknownShape: metrics.rejectedUnknownShape,
    }));
  }
  if (req.method === 'GET' && req.url === '/gate/proof') {
    const g = proofGate();
    const data = readProofFile();
    return res.end(JSON.stringify({
      mode: PROOF_MODE, file: path.basename(PROOF_FILE),
      gate: g,
      maxAgeMs: PROOF_MAX_AGE_MS, strictAgeMs: PROOF_STRICT_AGE_MS,
      proof: data ? {
        ts: data.ts, expiresAt: data.expiresAt, target: data.target, proofMode: data.mode,
        verdict: data.verdict, trust: data.trust,
        pass: data.pass, fail: data.fail, unknown: data.unknown, total: data.total,
        items: data.items, metrics: data.metrics, changes: data.changes, cost: data.cost,
      } : null,
    }, null, 1));
  }
  if (req.method === 'GET' && req.url === '/gate/matrix') {
    const now = Date.now();
    const rows = [...matrix.entries()].map(([k, v]) => ({ key: k, verdict: v.verdict, idShape: v.idShape, classifier: v.classifier, ageMs: now - v.ts }));
    return res.end(JSON.stringify({ ttlMs: PROBE_TTL, rows }, null, 0));
  }
  if (req.method === 'GET' && req.url === '/gate/alerts')
    return res.end(JSON.stringify({
      count: alerts.length,
      alerts,
      lastSuccessAt,
      failureWindow: FAIL_WINDOW,
      recentFailures,
    }, null, 0));
  if (req.method === 'GET' && req.url === '/gate/metrics')
    return res.end(JSON.stringify({ ...metrics, inflight, peakInflight, maxConc: MAX_CONC, chain: ALLOWED, latency: latencySnapshot(), crashCount }));
  if (req.method === 'GET' && req.url === '/gate/latency')
    return res.end(JSON.stringify(latencySnapshot()));

  // /gate/* 是门控自身的管理端点，非 GET 一律拒绝，绝不转发到上游
  if (req.url.startsWith('/gate/')) {
    return replyEarly(req, res, 405, { error: { type: 'gate_method_not_allowed', message: '仅支持 GET' } });
  }
  // 代理端点只接受 POST：其它方法没有语义，转发到上游只会白白消耗一次请求
  if (req.method !== 'POST') {
    return replyEarly(req, res, 405, { error: { type: 'gate_method_not_allowed', message: '代理端点仅支持 POST' } }, { allow: 'POST' });
  }

  // 路径白名单先于 body 读取：未知端点连 body 都不收，既省内存也不给大包 DoS 留缝
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const ALLOWED_PATHS = new Set(['/v1/responses', '/v1/messages', '/v1/chat/completions']);
  if (!ALLOWED_PATHS.has(url.pathname)) {
    // 端点写错也会让调用方看到失败，记进 recentFailures 便于排查
    recordFailure({ kind: 'client', type: 'gate_unknown_path', status: 404, path: url.pathname,
          elapsedMs: Date.now() - startedAt });
    return replyEarly(req, res, 404, { error: { type: 'gate_unknown_path', message: '未知端点：' + url.pathname } });
  }

  // 浏览器侧的两种「借道」要挡掉：
  //  1) CSRF：页面可以用 no-cors 往 127.0.0.1 发 text/plain 请求，本服务不回 CORS 预检，
  //     但只要坚持只收 application/json，任何跨域 JSON 请求都会被预检拦住；
  //  2) DNS rebinding：evil.com 解析到 127.0.0.1 时，Host 头仍是 evil.com —— 只认回环 Host。
  if (isProxy) {
    // Host 校验已上移到 handle() 最前面（覆盖 /gate/*），这里只留 content-type。
    const ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (!ctype.includes('json')) {
      const cid = Math.random().toString(16).slice(2, 10);
      recordFailure({ kind: 'client', type: 'gate_bad_content_type', status: 415,
                      path: String(req.url).split('?')[0], elapsedMs: Date.now() - startedAt });
      log({ ts: new Date().toISOString(), reqId: cid, result: 'BAD_CONTENT_TYPE', path: String(req.url).split('?')[0] });
      res.writeHead(415, { 'content-type': 'application/json', 'x-gate-result': 'blocked', 'x-gate-reason': 'bad_content_type' });
      return res.end(JSON.stringify({ error: { type: 'gate_bad_content_type', message: '代理请求必须带 content-type: application/json。', request_id: cid } }));
    }
  }

  // 协议级封禁：宁杀错不放过。
  // messages 协议在 OpenCode 网关下的错误体被简化成 {"model":...}，拿不到 DeepSeek 原始错误，
  // 也没有 logprobs，因此没有任何可用的前置判据 —— 只能靠 id 形态，可靠性不足。
  // 默认封禁；如需恢复，把 GATE_BLOCK_PROTOS 设为空字符串。
  // （P2-4：此处原有一个未被使用的 `const pid`，与 if 内的同名变量重复，已删除）
  if (BLOCKED_PROTOS.has(protoOf(url.pathname))) {
    const pid = Math.random().toString(16).slice(2, 10);
    metrics.blockedByPolicy = (metrics.blockedByPolicy || 0) + 1;
    recordFailure({ kind: 'policy', type: 'gate_proto_blocked', status: 503,
                    path: url.pathname, elapsedMs: Date.now() - startedAt });
    log({ ts: new Date().toISOString(), reqId: pid, proto: protoOf(url.pathname),
          result: 'BLOCKED_BY_POLICY', path: url.pathname });
    res.writeHead(503, { 'content-type': 'application/json', 'x-gate-result': 'blocked',
                         'x-gate-reason': 'proto_blocked' });
    return res.end(JSON.stringify({
      error: {
        type: 'gate_proto_blocked',
        // 第 17 轮修正：可用协议必须动态生成。原来硬编码「请改用 /v1/responses 或
        // /v1/chat/completions」，把被封禁的 chat 自己推荐了回去（自相矛盾）。
        message: `该协议（${protoOf(url.pathname)}）在门控侧没有可用的官方性判据，已按策略封禁（宁杀错不放过）。` +
                 `可改用：${[...ALLOWED_PATHS].filter(p => !BLOCKED_PROTOS.has(protoOf(p))).join('  或  ') || '（无可用端点）'}。`,
        request_id: pid,
        blocked_protocols: [...BLOCKED_PROTOS],
        available: [...ALLOWED_PATHS].filter(p => !BLOCKED_PROTOS.has(protoOf(p))),
      },
    }));
  }

  const chunks = [];
  let bodySize = 0;
  for await (const c of req) {
    bodySize += c.length;
    if (bodySize > MAX_BODY) {
      return replyEarly(req, res, 413, { error: { type: 'gate_body_too_large', message: '请求体超过上限 ' + MAX_BODY + ' 字节' } });
    }
    chunks.push(c);
  }
  const bodyBuf = Buffer.concat(chunks);
  let body;
  try { body = JSON.parse(stripBom(bodyBuf).toString('utf8')); } catch (e) {
    recordFailure({ kind: 'client', type: 'gate_bad_body', status: 400, elapsedMs: Date.now() - startedAt });
    return replyEarly(req, res, 400, { error: { type: 'gate_bad_body', message: e.message } });
  }

  const pathName = '/zen/go/v1' + url.pathname.replace(/^\/v1/, '');
  const proto = protoOf(pathName);
  const reqId = Math.random().toString(16).slice(2, 10);
  // 记下调用方请求的 model：门控只用 CHAIN 内的模型，不一致时要能被观察到
  // body 可能是 null（请求体就是 'null'），直接取 .model 会抛 TypeError → 500，应为 400
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    recordFailure({ kind: 'client', type: 'gate_bad_body', status: 400, elapsedMs: Date.now() - startedAt });
    return replyEarly(req, res, 400, { error: { type: 'gate_bad_body', message: '请求体必须是 JSON 对象' } });
  }
  const requestedModel = String(body.model || '');
  metrics.requests++;

  // 兼容层：修掉悬空 $ref。
  // 实测（2026-10-20）：dsh 在 anthropic-messages 协议下转换 MCP 工具 schema 时
  // 会丢掉 $defs，但保留 `$ref: "#/$defs/__schemaN"`，形成悬空引用。
  // 上游对悬空 $ref 一律返回 400（空 body），导致 235 个工具里 168 个不可用。
  // 这里把无法解析的 $ref 就地摘掉（保留 description），使其退化为「任意类型」。
  if (Array.isArray(body.tools) && body.tools.length) {
    try {
      metrics.schemaRefsFixed = (metrics.schemaRefsFixed || 0) + normalizeToolSchemas(body.tools);
    } catch {}
  }

  // ★ 2026-10-23 诊断：只记「请求形状」，绝不记任何正文/提示词内容。
  // 动机：实测 dsh 的真实请求首 token 20–36s，而同一分钟内的合成请求只要 1.3–4.4s，
  // 且已排除 reasoning.effort、题目难度、图片、600KB 上下文、16 个 tools 这些因素。
  // 靠猜没有意义，直接把体积与结构打进台账，用 reqId 与交付记录关联。
  try {
    const cnt = (arr, keys) => {
      let chars = 0;
      if (!Array.isArray(arr)) return 0;
      for (const it of arr) {
        if (!it || typeof it !== 'object') continue;
        for (const k of keys) {
          const v = it[k];
          if (typeof v === 'string') chars += v.length;
          else if (Array.isArray(v)) for (const part of v) {
            if (part && typeof part.text === 'string') chars += part.text.length;
          }
        }
      }
      return chars;
    };
    log({
      ts: new Date().toISOString(), reqId, proto, result: 'REQUEST_SHAPE',
      reqBytes: bodyBuf.length,
      inputItems: Array.isArray(body.input) ? body.input.length : 0,
      inputChars: cnt(body.input, ['text', 'content']),
      instrChars: typeof body.instructions === 'string' ? body.instructions.length : 0,
      msgChars: cnt(body.messages, ['content']),
      tools: Array.isArray(body.tools) ? body.tools.length : 0,
      effort: (body.reasoning && body.reasoning.effort) || '',
      stream: !!body.stream,
      prevRespId: typeof body.previous_response_id === 'string' && body.previous_response_id ? 1 : 0,
      maxTok: body.max_output_tokens || body.max_tokens || 0,
      // 每个工具的 name 与 schema 字节数（不含任何正文），用于定位体积来源。
      toolSizes: (Array.isArray(body.tools) ? body.tools : [])
        .map(t => ({ n: String((t && (t.name || (t.function && t.function.name))) || ""),
                     b: Buffer.byteLength(JSON.stringify(t)) }))
        .sort((a, b) => b.b - a.b),
    });
  } catch {}

  // 预检与车道探测并行启动：两者都约 1-2 秒，重叠后总耗时不变
  const precheckP = PRECHECK_ENABLE ? precheck(proto) : Promise.resolve({ verdict: 'skip', source: 'disabled' });

  const ranked = await rankCandidates(String(body.model || ''), proto, pathName, body, req.headers, clientGone.signal, deadline);
  let { order } = ranked;
  const { notes, verdicts } = ranked;

  const attempts = [];
  // ★ 2026-10-23：记录最后一次上游 4xx 的原文，用于「所有车道都失败」时透传真实状态（而非 503）。
  let last4xx = null;
  const payloadFactory = makePayloadFactory(body);
  const maxTries = Math.min(MAX_ATTEMPTS, Math.max(order.length, 1));

  const brief = (model, r) => ({ model, status: r.status, verdict: r.verdict, classifier: r.classifier,
    idShape: r.idShape, votes: r.votes, signals: r.signals, endpoint: r.endpoint, upstreamModel: r.upstreamModel, ms: r.ms, error: r.error });

  let currentTrust = null;
  const deliver = (model, r, attemptNo) => {
    // 判定分级：id 形态为 official 直接算 pass；
    // 否则若「本请求的」信任决策放开了车道，记 passByProof。
    // 必须用 currentTrust（handle 里已算好的决策），不能再读一次 proofGate()：
    // 那会绕过预检结果，导致预检明明通过却标记成 unverified。
    const dgate = currentTrust || proofGate();
    let resultKind;
    if (r.verdict === 'official') {
      metrics.pass++; resultKind = 'PASS'; lastSuccessAt = new Date().toISOString();
    } else if (dgate.allowAllLanes) {
      metrics.passByProof++; resultKind = 'PASS_BY_PROOF'; lastSuccessAt = new Date().toISOString();
    } else {
      // ★ 2026-10-21：这是不可达保险丝。
      //
      // 第 19 轮加了交付前置闸：任一真实请求发出前，该协议预检必须是 pass
      // （见 handle 里的 BLOCKED_PRECHECK_NOT_PASS 分支）。因此走到 deliver() 时
      // currentTrust.allowAllLanes 必然为真，本分支在结构上不可达。
      // 保留它是为了防止将来有人改动预检链路时静默出现「无证明交付」，
      // 真被走到就 fail-closed，绝不交付任何内容。
      metrics.passUnverified = (metrics.passUnverified || 0) + 1;
      log({ ts: new Date().toISOString(), reqId, proto, result: 'UNVERIFIED_DELIVERY_BLOCKED',
            verdict: r.verdict, idShape: r.idShape, trust: dgate.trust, reason: dgate.reason });
      try { r.stream && r.stream.destroy(); } catch {}
      try { res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5',
            'x-gate-result': 'blocked', 'x-gate-reason': 'unverified_delivery_blocked' }); } catch {}
      try { res.end(JSON.stringify({ error: { type: 'gate_no_official_route',
            message: '该响应没有任何官方性证明；已 fail-closed，未向客户端交付任何内容。' } })); } catch {}
      return;
    }
    // ★ 2026-10-22 审查修复：PASS/失败主记录曾缺 elapsedMs（唯一缺的 kind），
    // 导致端到端时延只能从 PRECHECK 记录反推。现在补齐。
    log({ ts: new Date().toISOString(), reqId, proto, attempt: attemptNo, model, status: r.status,
          verdict: r.verdict, classifier: r.classifier, idShape: r.idShape, votes: r.votes,
          hedge: HEDGE, result: resultKind, proofTrust: dgate.trust, probeNotes: notes, attempts,
          elapsedMs: Date.now() - startedAt });
    // 客户端断开即释放上游流，避免连接一直挂在这里。
    // ★ P1-1：计数统一由 handle 顶部的 close 监听负责（那里还要 abort 整条链）。
    // 这里若再 ++，一次断开会被两个监听各记一次 → abortedByClient 虚高一倍。
    res.on('close', () => {
      if (!res.writableEnded) { try { r.stream.destroy(); } catch {} }
    });
    res.writeHead(r.status, {
      'content-type': r.ctype || 'text/event-stream',
      'cache-control': 'no-cache',
      'x-gate-result': resultKind === 'PASS' ? 'official'
        : resultKind === 'PASS_BY_PROOF' ? 'pass-by-proof'
        : resultKind.toLowerCase().replace(/_/g, '-'),
      'x-gate-classifier': r.classifier,
      'x-gate-id-shape': r.idShape || '',
      'x-gate-endpoint-id': r.endpoint || '',
      'x-gate-attempts': String(attemptNo),
      'x-gate-req-id': reqId,
      // 可观测性：请求的 model 与实际服务它的 model 不同时明确标注。
      // 门控只走 CHAIN，任何其它 model 都会被替换（不是拒绝），但必须让调用方看得见。
      'x-gate-model-requested': headerSafe(requestedModel),
      'x-gate-model-served': headerSafe(model),
      'x-gate-model-substituted': (requestedModel && requestedModel !== model) ? '1' : '0',
    });
    for (const c of r.buffered) { try { res.write(c); } catch { break; } }
    // 若 peek 时流已结束，pipe 不会再触发 'end'，这里兜底收尾，避免客户端挂起
    if (r.stream.readableEnded || r.stream.destroyed) { try { res.end(); } catch {} return; }
    r.stream.pipe(res);
    r.stream.on('end', () => { try { res.end(); } catch {} });
    r.stream.on('error', () => { try { res.end(); } catch {} });
  };

  let idx = 0;
  // 全部被判 third 时不要立刻认输：缓存可能已过时（上游刚恢复）。
  // 清掉这些车道的判定后重新探测一次，仍无官方车道才 fail-closed。
  // 注意：这里不做"按 id 形态过滤"，过滤统一交给下面的信任判定，
  // 否则预检（比周期 proof 更新）的结论会被这里提前挡掉。
  //
  // ★ 2026-10-20 第 18 轮修正：原条件是 `if (!order.length)` —— **永远不成立**。
  // `rankCandidates` 总是返回全部车道（官方优先，其余在后），order 仅在 ALLOWED 为空时
  // 才是空的；而 ALLOWED 为空在启动时已被拒绝。于是这段「立即重探」是死代码：
  // 实测上游从 third 恢复正常后，请求在 PROBE_TTL(120s) 内一直 503（test-bugfix B2/B3 抓到）。
  //
  // 触发条件必须严格是「全部车道都被**明确**判 third」（即注释所说的故障态）。
  // 不能用「没有 official 车道」——responses 的缓存结论常态就是 unknown（id=resp_），
  // 那样每个请求都会重探（实测 staleRechecks 在 124 个请求里涨到 121，纯属白烧上游配额）。
  //
  // 判据必须查**矩阵缓存**而不是 `verdicts`：预检新鲜时 rankCandidates 会跳过探针
  // （台账 probeNotes 出现 skippedProbe:"precheck_fresh"），此时 verdicts 里没有 lane 结论，
  // 只看 verdicts 会让「缓存已确证全 third」的故障态漏掉重探（实测 staleRechecks 恒为 0）。
  let lastStaleRecheckAt = 0;
  const STALE_RECHECK_COOLDOWN_MS = 5000;
  const laneVerdictOf = (m) => (cacheGet(m, proto)?.verdict) || verdicts.get(m);
  const allLanesThird = order.length > 0 && order.every(m => laneVerdictOf(m) === 'third');
  if (allLanesThird && Date.now() - lastStaleRecheckAt >= STALE_RECHECK_COOLDOWN_MS) {
    lastStaleRecheckAt = Date.now();
    metrics.staleRechecks++;
    for (const m of ALLOWED) matrix.delete(mkey(m, proto));
    const re = await rankCandidates(String(body.model || ''), proto, pathName, body, req.headers, clientGone.signal, deadline);
    order = re.order;
    notes.push(...re.notes.map(n => ({ ...n, recheck: true })));
    for (const [k, v] of re.verdicts) verdicts.set(k, v);
  }

  // 信任级别：预检优先（本请求发出前实测），拿不到结论时退回周期 proof
  const decision = await trustDecision(precheckP, proto);
  // 必须把 decision.precheck 一起带下来：交付阶段要靠它的 source 区分
  // 「实时预检 pass（live）」与「TTL 缓存 pass（cache）」，从而决定 id 形态为 third 时
  // 是否需要强制实时重验。曾在重构时只保留 allowAllLanes/trust/reason，导致
  // pgate.precheck 恒为 undefined，重验分支永不命中（实测 thirdRevalidated=0）。
  const pgate = { allowAllLanes: decision.allowAllLanes, trust: decision.trust, reason: decision.source,
                  precheck: decision.precheck, proof: decision.proof };
  currentTrust = pgate;

  let candidates = pgate.allowAllLanes
    ? order.slice()
    : order.filter(m => (verdicts.get(m) || 'unknown') === 'official');
  // ★ 2026-10-23：把「刚返回过 server-error」的车道排到末尾。
  // 实测事故：坏车道在前时，每个请求都要先白等 3 次（~7.5s）才换道，首字节被拖到 25–29s。
  // 不剔除，只降序：好车道全挂时仍会用到它，fail-closed 语义不变。
  candidates = preferHealthyLanes(candidates, proto, bodyBuf ? bodyBuf.length : 0);

  if (decision.blocked) {
    metrics.blocked++;
    recordFailure({ kind: 'route', type: 'gate_precheck_failed', status: 503, reqId, proto,
                    elapsedMs: Date.now() - startedAt,
                    precheck: (decision.precheck?.results || []).map(r => r.id + ':' + r.verdict).join(',') });
    log({ ts: new Date().toISOString(), reqId, proto, result: 'BLOCKED_PRECHECK',
          precheck: decision.precheck, elapsedMs: Date.now() - startedAt });
    res.writeHead(503, { 'content-type': 'application/json', 'x-gate-result': 'blocked',
                         'x-gate-reason': 'precheck_failed' });
    return res.end(JSON.stringify({
      error: {
        type: 'gate_precheck_failed',
        message: '本请求发出前的官方性预检未通过；已 fail-closed，未向客户端交付任何内容。',
        request_id: reqId,
        precheck: decision.precheck?.results,
      },
    }));
  }

  // ★ 2026-10-21 第 19 轮：交付前置闸 —— 本方案的唯一安全改动。
  //
  // 起因（实测复现）：mock 返回 UUID4 伪装、9 个 msgfp 探针全部不符（`precheckFail=2`，
  // 已经过确认重测），门控仍然 200 `official` 并原样交付了第三方内容。
  // 根因是 `official` 走的是「形态自我证明」——只要 id 长得像官方就交付，
  // 协议级判据（预检/proof）从来不参与**授权**，只参与车道过滤。
  //
  // 现在把授权提前到「发出真实请求之前」：本协议预检不是 pass 就不调用上游。
  // 这样：
  //   · `official` 不再有特权（走不到形态判定那一步）
  //   · `unknown`/`resp_` 也不可能被交付（它们本来就要 allowAllLanes）
  //   · `PASS_UNVERIFIED` 分支在结构上不可达（它要求 allowAllLanes=false）
  //   · 被拒绝时**不消耗任何上游配额**
  //
  // 代价（已知并接受）：预检拿不到结论（net/超时/fail）时直接 503；
  // 若上游改动 e1 的错误文案，responses 会持续 503 直到更新判据（台账 detail=e1:format 可诊断）。
  if (decision.precheck?.verdict !== 'pass') {
    const pv = decision.precheck?.verdict || 'missing';
    metrics.blocked++;
    metrics.precheckNotPass = (metrics.precheckNotPass || 0) + 1;
    recordFailure({ kind: 'route', type: 'gate_precheck_not_pass', status: 503, reqId, proto,
                    elapsedMs: Date.now() - startedAt,
                    // 带上判据原文摘要（截断），否则 /gate/alerts 只有 "msgfp:fail"，
                    // 处置手册要求的「看 detail 判断漂移还是伪装」就得去翻 5MB 台账。
                    precheck: (decision.precheck?.results || [])
                      .map(r => r.id + ':' + r.verdict + (r.detail ? '(' + String(r.detail).slice(0, 120) + ')' : ''))
                      .join(',') });
    log({ ts: new Date().toISOString(), reqId, proto, result: 'BLOCKED_PRECHECK_NOT_PASS',
          precheckVerdict: pv, trust: decision.trust, source: decision.source,
          precheck: decision.precheck?.results, elapsedMs: Date.now() - startedAt });
    // retry-after：net/超时属瞬时类，让客户端 5 秒后重试即可恢复，不必等长退避
    res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5',
                         'x-gate-result': 'blocked', 'x-gate-reason': 'precheck_not_pass' });
    return res.end(JSON.stringify({
      error: {
        type: 'gate_no_official_route',
        message: '本协议尚未取得官方性证据（预检未通过），已 fail-closed，未向客户端交付任何内容。',
        request_id: reqId,
        precheck_verdict: pv,
        precheck: decision.precheck?.results,
      },
    }));
  }

  if (!candidates.length) {
    metrics.blocked++;
    // 三种拒绝原因必须分开归因，否则客户端无法判断「等一会儿再试」还是「路由被拒」。
    // 探针在所有车道都拿不到任何 HTTP 响应 → 可达性问题；
    // 每条车道都被**确证**为 third → 路由被拒（第三方）；
    // 其余（含 P0-1 之后归为 unknown 的非 2xx）→ 未能确认官方归属，属可重试类。
    const probeNotesReal = notes.filter(n => !n.skippedProbe);
    const allConnErr = probeNotesReal.length > 0 && probeNotesReal.every(n => n.verdict === 'error');
    // ★ P0-1：只有「每条车道都是确证的 third」才允许报「全部第三方」。
    // 非 2xx（429/5xx/401…）现在归为 unknown，不再冒充 third，避免把限流说成路由被拒。
    const allThird = probeNotesReal.length > 0 && probeNotesReal.every(n => n.verdict === 'third');
    const earlyType = allConnErr ? 'gate_upstream_unreachable'
      : allThird ? 'gate_all_lanes_third'
      : 'gate_no_official_route';
    const earlyLog = allConnErr ? 'UPSTREAM_UNREACHABLE' : allThird ? 'BLOCKED_ALL_THIRD' : 'BLOCKED_NO_CONFIRMED_ROUTE';
    if (allConnErr) metrics.upstreamUnreachable++;
    recordFailure({ kind: 'route', type: earlyType, status: 503, reqId, proto, elapsedMs: Date.now() - startedAt,
                    lanes: notes.map(n => n.model + ':' + n.verdict) });
    log({ ts: new Date().toISOString(), reqId, proto, result: earlyLog,
          phase: 'probe', probeNotes: notes, elapsedMs: Date.now() - startedAt });
    res.writeHead(503, { 'content-type': 'application/json', 'x-gate-result': 'blocked',
                         'x-gate-reason': earlyType,
                         'retry-after': allConnErr ? '10' : allThird ? '20' : '15' });
    return res.end(JSON.stringify({ error: {
      type: earlyType,
      message: allConnErr
        ? '上游整体无响应（探针在所有候选车道都拿不到任何 HTTP 响应）；已 fail-closed。这是可达性问题，不是路由判定问题，稍后重试即可。'
        : allThird
          ? '探针确证全部候选车道均为第三方；已 fail-closed，未发任何真实请求。'
          : '探针未能确认任何候选车道的官方归属（限流 / 上游瞬时故障 / 该协议下该模型不可用等）。已 fail-closed，未发任何真实请求；稍后重试即可。',
      request_id: reqId, probeNotes: notes } }));
  }

  // 对冲只在"首选不确定"时启用；首选已确认官方则单发，避免重复烧大请求。
  //
  // 2026-10-20 修正：原来只认 id 形态的 official。但实测 messages 协议 id 有 45%
  // 是 HEX32、chat 100% 是 chatcmpl，`verdicts.get(candidates[0])` 几乎恒不等于
  // official → topCertain 恒 false → **hedge 触发率 100%，每个请求双发，上游请求
  // 翻倍**（实测 requests +10 / hedged +10）。配额就是这样被吃掉一倍的。
  //
  // 现在把「预检刚通过」也算作确定：预检（eclass/msgfp/logprob）已经独立证明该协议
  // 落在官方未量化模型上，此时并行发第二条只是朝同一个后端多打一发。
  const pcT = precheckLastFor(proto);
  const precheckSaysOfficial = pgate.allowAllLanes
    && pcT && pcT.verdict === 'pass'
    && Date.now() - pcT.at < Math.max(SKIP_PROBE_TTL_MS, 1000);
  const topCertain = (verdicts.get(candidates[0]) === 'official') || precheckSaysOfficial;
  // 连接层失败（无 HTTP 响应）按车道记录；不同车道都失败即判上游不可达，快速收敛
  const connFailedLanes = new Set();
  const noteConnFail = (m, r) => { if (r && r.verdict === 'error' && !r.status) connFailedLanes.add(m); };
  const upstreamDown = () => connFailedLanes.size >= Math.min(UPSTREAM_FAST_FAIL_LANES, candidates.length);
  if (HEDGE && !topCertain && candidates.length >= 2) {
    metrics.hedged++;
    const { winner, all } = await hedgeRace(candidates.slice(0, 2), { pathName, body, incoming: req.headers, signal: clientGone.signal, payloadFactory, timeoutMs: Math.max(3000, Math.min(UPSTREAM_TIMEOUT_MS, remainMs())) }, proto, pgate.allowAllLanes);
    for (const { model, r } of all) { attempts.push(brief(model, r)); noteConnFail(model, r); }
    if (winner) return deliver(winner.model, winner.r, attempts.length);
    // 两条车道都没拿到任何 HTTP 响应 → 上游不可达，不必再进主循环烧预算
    if (upstreamDown()) {
      log({ ts: new Date().toISOString(), reqId, proto, result: 'UPSTREAM_UNREACHABLE',
            phase: 'hedge', lanes: [...connFailedLanes], elapsedMs: Date.now() - startedAt });
    }
    // 无胜出者：不跳过后续车道。
    // 4xx 场景下 hedge 里的 third 因 status<200 被排除，而主循环的 passthrough 分支能正确透传上游状态，
    // 因此重置 idx 让主循环从头处理（结果幂等，代价是多一次请求）。
    idx = 0;
  }

  for (; idx < Math.min(maxTries, candidates.length); idx++) {
    const model = candidates[idx];
    let r = null;
    // 同车道重试：只有连接层错误才重试同一模型；判定为 third 立即换道（重试无意义）
    for (let t = 0; t <= LANE_RETRY; t++) {
      // 预算耗尽就不再发起新尝试，直接收敛到 fail-closed，避免门控还在等而 dsh 已重发
      const left = remainMs();
      if (left <= 1500) { r = null; break; }
      const perTry = Math.max(1500, Math.min(UPSTREAM_TIMEOUT_MS, left));
      try {
        r = await withSlot(() => realRequest({ pathName, body, incoming: req.headers, model, signal: clientGone.signal, payloadFactory, timeoutMs: perTry }), clientGone.signal);
      } catch (e) {
        if (clientGone.signal.aborted) { metrics.abortedByClient++; return; }
        throw e;
      }
      attempts.push({ ...brief(model, r), laneRetry: t });
      noteConnFail(model, r);
      cacheSet(model, proto, r);
      if (r.verdict === 'official') return deliver(model, r, attempts.length);
      // proof/预检已证明该协议落在官方后端时，id 形态非 UUID4 也照常交付：
      // - chat/messages 车道：id 是 chatcmpl 等网关产物
      // - responses 车道：2026-10-20 起上游会在 UUID4 与 resp_ 之间波动，resp_ 被判为 unknown
      // 二者都不代表降级（logprob + eclass 文本已独立证明后端）。缺了 unknown 分支，
      // 上游一旦返回 resp_ 形态，所有请求都会走到最后的 fail-closed 被误杀。
      //
      // ★ 2026-10-20 补强：区分「实时预检 pass」与「TTL 缓存 pass」。
      //
      // 按协议分档 TTL（messages 30s / chat 15s）省了配额，但引入一个真实暴露面：
      // 缓存窗口内后端若被换成第三方，缓存里的 pass 会掩盖它，third 响应照常交付。
      // 用户对此的质疑是成立的 —— 省配额不该以「增加路由到第三方的窗口」为代价。
      //
      // third（HEX32/chatcmpl）是**强反面信号**，缓存结论不足以否决它；unknown（resp_）
      // 是中性形态，缓存 pass 放行没有额外风险。所以只对 third 加一道实时复核：
      // 作废该协议的预检缓存 → 现场重跑一次预检 →
      //   pass（后端确实仍官方，id 形态只是网关适配层产物）→ 交付
      //   非 pass（后端真的变了）→ 不交付，换道或 fail-closed
      // 代价只在「真的遇到 third」时多一次预检，正常路径零开销。
      // ★ 2026-10-20 第 17 轮：判定口径由「质量」改为「身份」。
      // 目标：只接受官方后端；第三方（自部署 / 异模型 / 第三方池）一律拒绝；官方自身降智不管。
      //
      // 因此这里是**硬闸门**，不再保留「重验后翻案」：
      //   1) 强反面形态（HEX32 / chatcmpl / gw- / other / numeric）→ 直接拒绝。
      //      重验是**协议级**探针，它只能证明「这条协议路径通到官方实现」，
      //      改不了「这条响应本身不是官方形态」这个事实。按身份判定，形态不符即拒绝。
      //      （历史观测：2026-10-20 之前曾有 61 次 messages 的 HEX32 经重验被放行）
      //   2) 中性形态只允许 resp_，且必须叠加协议级背书（allowAllLanes）。
      //      resp_ 是 OpenCode 网关的 id 改写产物：实测官方侧 16/16 全 UUID4、
      //      OC 侧 16/16 全 resp_，它不携带后端身份信息 → 不能单独放行。
      //   3) 无 id → 无法证明 → 拒绝。
      if (r.verdict === 'third' && !r.passthrough) {
        // ★ 注意 `!r.passthrough`：上游 4xx（例如损坏图片、非法参数）在 realRequest 里
        // 也被归为 third，但它**不是路由判定**，而是「这次请求本身有问题」。
        // 这类响应必须原样透传（下面的 passthrough 分支），否则客户端只会拿到
        // 一个语义错误的 503 gate_no_official_route —— 实测把「损坏图片应回 400」
        // 变成了 503（test-multimodal 抓到）。身份白名单只约束 **2xx 的成功响应**。
        metrics.rejectedThirdShape = (metrics.rejectedThirdShape || 0) + 1;
        log({ ts: new Date().toISOString(), reqId, proto, result: 'REJECT_SHAPE_THIRD',
              model, idShape: r.idShape, policy: 'identity_whitelist', allowAllLanes: pgate.allowAllLanes });
        try { r.stream && r.stream.destroy(); } catch {}
        // ★ 必须是 break（换道），不是 continue。
        // 这一行在「同车道重试」的内层循环里：continue 会拿同一个 model 再发一次，
        // 而形态判定是确定性的 —— 重试只会得到同样的 third，白烧 3 倍配额与延迟。
        // 实测（第 17 轮）：用 continue 时 2 个请求产生 rejectedThirdShape=12、耗时 9.5s。
        break;
      }
      if (r.verdict === 'unknown') {
        if (DELIVERABLE_SHAPES.has(r.idShape) && pgate.allowAllLanes) {
          return deliver(model, r, attempts.length);
        }
        metrics.rejectedUnknownShape = (metrics.rejectedUnknownShape || 0) + 1;
        log({ ts: new Date().toISOString(), reqId, proto, result: 'REJECT_SHAPE_UNKNOWN',
              model, idShape: r.idShape || '(none)', allowAllLanes: pgate.allowAllLanes });
        try { r.stream && r.stream.destroy(); } catch {}
        break;                                          // 同上：换道，不重试
      }
      // 上游不可达的快速收敛必须排在「已确认官方/可交付」判定之后：
      // 否则 hedge 阶段两条车道都连接失败过之后，再来一条成功的 official 会被这里误判丢弃。
      if (upstreamDown()) {
        try { r.stream && r.stream.destroy(); } catch {}
        log({ ts: new Date().toISOString(), reqId, proto, result: 'UPSTREAM_UNREACHABLE',
              phase: 'main', lanes: [...connFailedLanes], attempts: attempts.length,
              elapsedMs: Date.now() - startedAt });
        break;
      }
      // 上游 4xx（非认证/限流）说明这次请求本身有问题：原样透传，换道重试只会得到同样结果
      if (r.passthrough && r.verdict !== 'rate-limit' && r.verdict !== 'server-error') {
        metrics.passthrough++;
        recordFailure({ kind: 'upstream-4xx', type: 'upstream_error', status: r.passthrough.status,
                        reqId, proto, model, elapsedMs: Date.now() - startedAt });
        log({ ts: new Date().toISOString(), reqId, proto, attempt: attempts.length, result: 'UPSTREAM_4XX',
              status: r.passthrough.status, model, attempts });
        try { r.stream && r.stream.destroy(); } catch {}
        res.writeHead(r.passthrough.status, {
          'content-type': r.passthrough.ctype || 'application/json',
          'x-gate-result': 'upstream-error',
          'x-gate-attempts': String(attempts.length),
          'x-gate-req-id': reqId,
        });
        return res.end(r.passthrough.body);
      }
      try { r.stream && r.stream.destroy(); } catch {}

      // 429 限流：等一小会儿在同车道重试；上游要求的等待超过上限就直接透传，别拖死 dsh
      if (r.verdict === 'rate-limit') {
        const wait = r.retryAfterMs ?? 1000;
        if (wait <= RATE_LIMIT_MAX_WAIT_MS && t < LANE_RETRY) {
          metrics.rateLimited++;
          await new Promise(s => setTimeout(s, wait));
          continue;
        }
        metrics.rateLimited++;
        recordFailure({ kind: 'rate-limit', type: 'gate_upstream_rate_limited', status: 429,
                        reqId, proto, model, retryAfterMs: wait, elapsedMs: Date.now() - startedAt });
        log({ ts: new Date().toISOString(), reqId, proto, attempt: attempts.length, result: 'UPSTREAM_429',
              retryAfterMs: wait, model });
        const ra = String(Math.max(1, Math.ceil(wait / 1000)));
        res.writeHead(429, {
          'content-type': 'application/json',
          'x-gate-result': 'rate-limited',
          'x-gate-attempts': String(attempts.length),
          'x-gate-req-id': reqId,
          'retry-after': ra,
        });
        return res.end(JSON.stringify({
          error: {
            type: 'gate_upstream_rate_limited',
            message: '上游限流，且要求的等待超过门控上限；请稍后重试。',
            request_id: reqId,
            retry_after_seconds: Number(ra),
            upstream: r.passthrough?.body ? String(r.passthrough.body).slice(0, 800) : '',
          },
        }));
      }

      // 上游瞬时故障（5xx，或 4xx 里带结构化 server_error）：同车道退避重试。
      // ★ 2026-10-23 修正：4xx 伪装成 server_error 时**不再只重试 1 次**。
      // 实测证据：17:12:55 / 17:21:42 两次 'server-error → server-error' 都只试了 2 次
      // 就放弃并透传 400 'Upstream response was invalid'，而该错误在上游负载下是瞬时的。
      // 分类已经保证「真·客户端错误」走的是 third 分支（不在此处），所以这里可以放心用满 LANE_RETRY。
      // 同时：重试用尽**不再立刻透传**，而是换下一条车道再试；全部车道都失败才透传最后一次 4xx。
      // （直接透传会丢掉「换车道可能就好了」的机会，这正是用户看到的 400。）
      if (r.verdict === 'server-error') {
        metrics.serverErrors++;
        if (r.passthrough) last4xx = last4xx || r.passthrough;
        // ★ 2026-10-23：4xx 伪装 server_error 对该车道是确定性的（实测 3 连 400），
        // 只重试 SERVER_ERR_4XX_RETRY（默认 1）次就换道；5xx 仍用满 LANE_RETRY。
        const is4xx = typeof r.status === 'number' && r.status < 500;
        const retryCap = is4xx ? Math.min(SERVER_ERR_4XX_RETRY, LANE_RETRY) : LANE_RETRY;
        if (is4xx) markLaneBad(model, proto, bodyBuf ? bodyBuf.length : 0);   // 记住坏车道，后续请求把它排到末尾
        if (t < retryCap && remainMs() > 3000) {
          await new Promise(s => setTimeout(s, LANE_RETRY_MS * (t + 1)));
          continue;
        }
        break;   // 本车道结束 → 换下一条车道
      }
      if (t < LANE_RETRY) {
        metrics.laneRetries++;
        await new Promise(s => setTimeout(s, LANE_RETRY_MS * (t + 1)));
      }
    }
    if (remainMs() <= 1500) break;
    if (upstreamDown()) break;   // 上游不可达：外层也不必再切车道
    if (idx < Math.min(maxTries, candidates.length) - 1) await new Promise(s => setTimeout(s, BACKOFF_MS));
  }

  // ★ 2026-10-23：所有车道都失败，但其中出现过「上游 4xx 原文」→ 透传它，而不是 503。
  // 理由：那是上游对本次请求的真实答复（含 "Upstream response was invalid" 这类瞬时故障），
  // 客户端据此能区分「请求本身有问题」与「门控判定无官方路由」；直接 503 会误导排障。
  if (last4xx) {
    metrics.passthrough++;
    recordFailure({ kind: 'upstream-4xx', type: 'upstream_error', status: last4xx.status,
                    reqId, proto, elapsedMs: Date.now() - startedAt, afterAllLanes: true });
    log({ ts: new Date().toISOString(), reqId, proto, result: 'UPSTREAM_4XX',
          status: last4xx.status, afterAllLanes: true, attempts });
    res.writeHead(last4xx.status, {
      'content-type': last4xx.ctype || 'application/json',
      'x-gate-result': 'upstream-error',
      'x-gate-attempts': String(attempts.length),
      'x-gate-req-id': reqId,
    });
    return res.end(last4xx.body);
  }

  metrics.blocked++;
  // 三种拒绝原因必须区分开，否则客户端无法判断「等一会儿再试」还是「路由被拒」
  const unreachable = upstreamDown();
  const exhausted = remainMs() <= 1500;
  if (unreachable) metrics.upstreamUnreachable++;
  else if (exhausted) metrics.budgetExhausted++;
  const reasonType = unreachable ? 'gate_upstream_unreachable'
    : exhausted ? 'gate_budget_exhausted' : 'gate_no_official_route';
  recordFailure({
    kind: 'route',
    type: reasonType,
    status: 503, reqId, proto,
    elapsedMs: Date.now() - startedAt,
    exhausted,
    attempts: attempts.map(a => a.model + ':' + a.status + ':' + a.verdict),
  });
  log({ ts: new Date().toISOString(), reqId, proto, attempt: attempts.length, result: 'BLOCKED',
        reason: reasonType, unreachable, exhausted,
        elapsedMs: TOTAL_BUDGET_MS - remainMs(), probeNotes: notes, attempts });
  res.writeHead(503, { 'content-type': 'application/json', 'x-gate-result': 'blocked',
                       'x-gate-reason': reasonType,
                       'retry-after': unreachable ? '10' : '20' });
  res.end(JSON.stringify({
    error: {
      type: reasonType,
      message: unreachable
        ? '上游整体无响应（所有候选车道都没有返回任何 HTTP 响应）；已 fail-closed，未向客户端交付任何内容。这是可达性问题，不是路由判定问题，稍后重试即可。'
        : exhausted
          ? `在 ${TOTAL_BUDGET_MS}ms 总预算内未能确认官方路由；已 fail-closed，未向客户端交付任何内容。`
          : '所有候选模型此刻都未落在官方上游；已 fail-closed，未向客户端交付任何内容。',
      request_id: reqId,
      budget_ms: TOTAL_BUDGET_MS,
      elapsed_ms: TOTAL_BUDGET_MS - remainMs(),
      probeNotes: notes,
      attempts,
    },
  }));
}

if (!KEY) { console.error('[oc-gate] OPENCODE_GO_API_KEY 缺失，拒绝启动'); process.exit(1); }
// ★ P1-4：CHAIN 全部撞上 FORBIDDEN 时 ALLOWED 为空，后续 ALLOWED[0] 会变成 undefined，
// 探针 body.model=undefined → 所有请求静默退化成 503，而日志里看不出是配置写错了。
// 这种配置错误必须在启动时就拒绝，不能让它带着空候选链跑起来。
if (!ALLOWED.length) {
  console.error('[oc-gate] GATE_CHAIN 全部命中禁止模型，候选车道为空，拒绝启动。CHAIN=' +
    JSON.stringify(CHAIN) + ' FORBIDDEN=' + JSON.stringify([...FORBIDDEN]));
  process.exit(1);
}
// ★ 2026-10-20 第 18 轮：候选链必须是 DeepSeek 模型。
//
// 门控只判「响应像不像官方」，从不判「请求发给了谁」。若 GATE_CHAIN 被改成 glm-5.1 之类的
// 异模型，OpenCode 网关同样会给它一个 `resp_`/UUID 形态的 id，e1 预检打的又是与 model 无关的
// responses 路径 —— 结果就是异模型内容被判成 official 放行。
// 「只接受官方 DeepSeek」这条目标必须在**发起请求之前**就守住，不能只靠响应侧判据。
const NON_DS = ALLOWED.filter(m => !/^deepseek-/i.test(m));
if (NON_DS.length) {
  console.error('[oc-gate] GATE_CHAIN 含非 DeepSeek 模型，违反「只接受官方后端」约束，拒绝启动。' +
    ' 非 DeepSeek=' + JSON.stringify(NON_DS) + ' 完整链=' + JSON.stringify(ALLOWED));
  process.exit(1);
}
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[oc-gate v4] 127.0.0.1:${PORT} chain=${ALLOWED.join(' -> ')} forbidden=${[...FORBIDDEN].join(',')} probe=${USE_PROBE} ttl=${PROBE_TTL}ms hedge=${HEDGE} refresh=${REFRESH_MS}ms`);
  if (CONFIG_WARNINGS.length) {
    for (const w of CONFIG_WARNINGS) console.warn('[oc-gate config] ' + w);
    try { log({ ts: new Date().toISOString(), result: 'CONFIG_WARNING', warnings: CONFIG_WARNINGS }); } catch {}
  }
  const n = loadSnapshot();
  if (n) console.log(`[oc-gate] snapshot reused: ${n} lane(s)`);
  if (!n) refreshMatrix();                           // 无可用快照才预热
  else writeSnapshot();
  // （P2-5：这里原本还有一次无条件 writeSnapshot()，与上面的 else 分支重复，已删除）
  if (REFRESH_MS > 0) setInterval(refreshMatrix, REFRESH_MS).unref();

  // ★ 第 17 轮：启动自检（D5-2）
  // 目的：区分「端口通了但上游废」的假活状态。
  // 注意：**失败不退出**。daemon 的重启间隔已压到 1.5s，若上游瞬时抖动就 exit，
  // 会变成每 1.5s 一次的重启风暴（每次重启都会重新打探针，反而放大故障）。
  // 所以这里只记录结论，把「是否可用」交给 /gate/health 暴露给 watchdog 判断。
  if ((process.env.GATE_STARTUP_SELFTEST ?? '1') === '1') {
    (async () => {
      const startedSelftest = Date.now();
      try {
        let r = await precheck('responses');
        // ★ 2026-10-21：自检只跑一次，而 precheck 的确认重测只对 fail 生效。
        // 启动瞬间若碰上一次连接抖动（实测出现过 ms=8 的 net → verdict=unknown），
        // 这个「判活信号」会在整个进程生命周期里一直是 unknown（误导人工与部署验收）。
        // 因此对非 pass 结论重试一次，并先清掉刚写入的缓存，否则 TTL 内会拿到同一个 unknown。
        if (r?.verdict !== 'pass') {
          await new Promise(res => setTimeout(res, 600));
          precheckLastByProto.delete('responses');
          r = await precheck('responses');
        }
        startupSelfTest = { at: new Date().toISOString(), verdict: r?.verdict || 'none',
                            source: r?.source || '', ms: Date.now() - startedSelftest };
        if (r?.verdict === 'pass') console.log('[oc-gate] startup selftest: OK (e1 pass, ' + startupSelfTest.ms + 'ms)');
        else console.warn('[oc-gate] startup selftest: 预检未通过 verdict=' + startupSelfTest.verdict +
                          '（不退出；由 /gate/health 暴露给 watchdog）');
        try { log({ ts: new Date().toISOString(), result: 'STARTUP_SELFTEST', ...startupSelfTest }); } catch {}
      } catch (e) {
        startupSelfTest = { at: new Date().toISOString(), verdict: 'error', source: String(e?.message || e), ms: Date.now() - startedSelftest };
        console.warn('[oc-gate] startup selftest error: ' + String(e?.message || e));
      }
    })();
  }

  // ★ 2026-10-22 根治：后台保活预检 —— 把探针延迟**移出请求关键路径**。
  // 问题：交付前置闸要求 precheck.verdict === 'pass'，而预检原本只在请求到来时才跑。
  //   上游变慢 10 倍时，用户要等 10–26s 才拿到第一个字节；抖动时直接 503。
  // 做法：后台每 GATE_PROOF_REFRESH_MS（默认 25s）对每个有判据的协议强制跑一轮真探针，
  //   把 pass 写进 precheckPassByProto；请求到来时命中缓存（TTL 90s），只付生成延迟。
  // 为什么不削弱判据：缓存里只有 pass，且「最近一次实测 fail」会立即短路拒绝。
  //   窗口 90s 的暴露面 = λ×W = 5.4e-6/s × 90s ≈ 0.049%（λ 实测 51h 内 1 次池切换）。
  // 成本：探针全是 400/422 参数校验失败，**不消耗 token**；msgfp 9 个 + e1 1 个 / 25s ≈ 24 请求/分钟。
  const PROOF_REFRESH_MS = num('GATE_PROOF_REFRESH_MS', 25000, { min: 5000, max: 300000 });
  if (PRECHECK_ENABLE && PROOF_REFRESH_MS > 0) {
    const protos = ['responses', 'messages']
      .filter(p => !BLOCKED_PROTOS.has(p) && (PROTO_TRUST[p] || 'idonly') !== 'idonly');
    const tick = async () => {
      await Promise.all(protos.map(async (p) => {
        try {
          const r = await precheck(p, { force: true });
          if (r?.verdict === 'pass') {
            metrics.proofRefreshPass = (metrics.proofRefreshPass || 0) + 1;
            // 冷启动时 EWMA=2000 → deadline=6000，e1（上游慢时 15s+）会被判 unknown，
            // 于是 startupSelfTest 在进程整个生命周期里都是 unknown（误导人工与部署验收）。
            // 保活一跑通就回填，让 health 反映「当前真的可用」。
            if (startupSelfTest?.verdict !== 'pass') {
              startupSelfTest = { at: new Date().toISOString(), verdict: 'pass',
                                  source: 'proof_refresh', ms: r.ms ?? null };
              try { log({ ts: new Date().toISOString(), result: 'STARTUP_SELFTEST_FILLED', ...startupSelfTest }); } catch {}
            }
            return;
          }
          metrics.proofRefreshMiss = (metrics.proofRefreshMiss || 0) + 1;
          log({ ts: new Date().toISOString(), result: 'PROOF_REFRESH_MISS', proto: p, verdict: r?.verdict,
                source: r?.source,
                detail: (r?.results || []).map(x => x.id + ':' + x.verdict + (x.detail ? '(' + x.detail + ')' : '')).join(',') });
        } catch (e) {
          metrics.proofRefreshMiss = (metrics.proofRefreshMiss || 0) + 1;
          try { log({ ts: new Date().toISOString(), result: 'PROOF_REFRESH_ERROR', proto: p, error: String(e?.message || e) }); } catch {}
        }
      }));
    };
    setInterval(() => { tick().catch(() => {}); }, PROOF_REFRESH_MS).unref();
    console.log('[oc-gate] 后台保活预检已启用：每 ' + PROOF_REFRESH_MS + 'ms 刷新 ' + protos.join('/') +
                '（TTL ' + precheckTtlFor('responses') + 'ms，暴露面≈0.049%）');
  }
});
process.on('SIGINT', () => { writeSnapshot(); process.exit(0); });
process.on('SIGTERM', () => { writeSnapshot(); process.exit(0); });

// 常驻服务的最后一道防线：任何漏网的异步异常都不应该让进程直接死掉。
// 这里只记录、不退出——保持服务可用比立刻暴露崩溃更重要（watchdog 巡检间隔是 2 分钟）。
let crashCount = 0;
process.on('uncaughtException', (e) => {
  crashCount++;
  const rec = { ts: new Date().toISOString(), result: 'UNCAUGHT_EXCEPTION', count: crashCount,
                error: String(e?.message || e).slice(0, 200), stack: String(e?.stack || '').split('\n').slice(0, 3).join(' | ').slice(0, 400) };
  try { log(rec); } catch {}
  try { console.error('[oc-gate] 未捕获异常（已忽略并继续服务）：' + rec.error); } catch {}
});
process.on('unhandledRejection', (reason) => {
  crashCount++;
  const rec = { ts: new Date().toISOString(), result: 'UNHANDLED_REJECTION', count: crashCount,
                error: String(reason?.message || reason).slice(0, 200) };
  try { log(rec); } catch {}
  try { console.error('[oc-gate] 未处理的 Promise 拒绝（已忽略并继续服务）：' + rec.error); } catch {}
});

