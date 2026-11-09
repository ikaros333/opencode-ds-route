/**
 * 代码自检：确认所有关键不变量真的在源码里，且各响应出口都接了应有的钩子。
 * 这是为了防住"用字符串替换改代码、锚点不匹配却静默通过"这一类失效。
 *
 * 用法：node verify-patch.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const SRC = path.join(import.meta.dirname, 'oc-gate.mjs');
const src = fs.readFileSync(SRC, 'utf8');
const lines = src.split('\n');
// 判据基线单源文件 + 探针（都要断言只从这里取常量）
const BASE_SRC = path.join(import.meta.dirname, 'baseline.mjs');
const baseSrc = fs.readFileSync(BASE_SRC, 'utf8');
const baseLines = baseSrc.split('\n');
const PROBE_SRC = path.join(import.meta.dirname, '..', 'probe', 'official-detect.mjs');
const probeSrc = fs.readFileSync(PROBE_SRC, 'utf8');
const probeLines = probeSrc.split('\n');
// CLI 也要断言：它是最可能把本机路径/调用栈打给用户的地方
const CLI_SRC = path.join(import.meta.dirname, '..', 'bin', 'ocg.mjs');
const cliLines = fs.readFileSync(CLI_SRC, 'utf8').split('\n');
// 监护也要断言：它是「重复部署 → 隐形重启循环」那条故障链的入口
const SUP_SRC = path.join(import.meta.dirname, '..', 'bin', 'ocg-supervise.mjs');
const supLines = fs.readFileSync(SUP_SRC, 'utf8').split('\n');
// 2026-11-02：证据链模块源码（EV1–EV9）
const EV_SRC = path.join(import.meta.dirname, 'evidence.mjs');
const evSrc = fs.readFileSync(EV_SRC, 'utf8');
const evLines = evSrc.split('\n');
let pass = 0, fail = 0;
const failures = [];

function has(name, needle, opts = {}) {
  const { count = null, where = null } = opts;
  const hits = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(needle)) hits.push(i + 1);
  const ok = count === null ? hits.length > 0 : hits.length === count;
  if (ok) { pass++; console.log(`PASS  ${name.padEnd(50)} ${hits.length} 处${count !== null ? ` (期望 ${count})` : ''}`); }
  else { fail++; failures.push(name); console.log(`FAIL  ${name.padEnd(50)} ${hits.length} 处${count !== null ? ` (期望 ${count})` : ''}`); }
  return hits;
}

function hasIn(arr, name, needle, opts = {}) {
  const { count = null } = opts;
  const hits = [];
  for (let i = 0; i < arr.length; i++) if (arr[i].includes(needle)) hits.push(i + 1);
  const ok = count === null ? hits.length > 0 : hits.length === count;
  if (ok) { pass++; console.log(`PASS  ${name.padEnd(50)} ${hits.length} 处${count !== null ? ` (期望 ${count})` : ''}`); }
  else { fail++; failures.push(name); console.log(`FAIL  ${name.padEnd(50)} ${hits.length} 处${count !== null ? ` (期望 ${count})` : ''}`); }
  return hits;
}

/** 断言某段文本「不存在」（防止把泄漏路径写回去） */
function hasNot(name, needle) {
  const hits = [];
  for (let i = 0; i < lines.length; i++) if (lines[i].includes(needle)) hits.push(i + 1);
  if (hits.length === 0) { pass++; console.log(`PASS  ${name.padEnd(50)} 0 处`); }
  else { fail++; failures.push(name); console.log(`FAIL  ${name.padEnd(50)} ${hits.length} 处（line ${hits.join(',')}）`); }
}

/** 同 hasNot，但作用于另一个文件的源码行（测试脚本 / CLI 等） */
function hasNotIn(arr, name, needle) {
  const hits = [];
  for (let i = 0; i < arr.length; i++) if (arr[i].includes(needle)) hits.push(i + 1);
  if (hits.length === 0) { pass++; console.log(`PASS  ${name.padEnd(50)} 0 处`); }
  else { fail++; failures.push(name); console.log(`FAIL  ${name.padEnd(50)} ${hits.length} 处（line ${hits.join(',')}）`); }
}

/** 断言 a 出现在 b 之前（用于"防护必须早于响应出口"这类顺序不变量） */
function hasOrder(name, a, b) {
  const ia = lines.findIndex(l => l.includes(a));
  const ib = lines.findIndex(l => l.includes(b));
  const ok = ia >= 0 && ib >= 0 && ia < ib;
  if (ok) { pass++; console.log(`PASS  ${name.padEnd(50)} ${ia + 1} < ${ib + 1}`); }
  else {
    fail++; failures.push(name);
    console.log(`FAIL  ${name.padEnd(50)} ${ia < 0 ? 'A 缺失' : ia + 1} vs ${ib < 0 ? 'B 缺失' : ib + 1}`);
  }
}

console.log('=== A. 硬约束 ===');
has('A1 禁止模型含 deepseek-v4-flash', "'deepseek-v4-flash'");
has('A2 禁止模型含 deepseek-flash-1017', "'deepseek-flash-1017'");
has('A2b 禁止模型含 deepseek-v4-pro（用户硬约束）', "'deepseek-v4-pro'");
has('A2c 官方直连作业务上游需显式放开', "flag('GATE_ALLOW_OFFICIAL_HOST', false)");
has('A2d 官方 host 启动即拒绝', 'if (HOST_IS_OFFICIAL && !ALLOW_OFFICIAL_HOST) {');
has('A3 ALLOWED 从 CHAIN 过滤禁模型', 'CHAIN.filter(m => !FORBIDDEN.has(m))');
has('A4 rankCandidates 归一 model 到链上', 'ALLOWED.includes(requestedModel) ? requestedModel : ALLOWED[0]');

console.log('\n=== B. 缓存正确性 ===');
has('B1 cacheSet 跳过 error', "if (r.verdict === 'error') return;");
has('B2 cacheSet 只接受 2xx', "r.status >= 200 && r.status < 300");
has('B3 全部 third 时强制重探', 'metrics.staleRechecks++');

console.log('\n=== C. 上游错误语义分流（每类只能出现一次）===');
has('C1 429 判 rate-limit', "verdict = 'rate-limit'", { count: 1 });
has('C2 5xx 判 server-error', "verdict = 'server-error'", { count: 1 });
has('C3 4xx/故障注入判 third', "verdict = 'third'", { count: 3 });
has('C4 429 解析 Retry-After', 'retryAfterMs = parseRetryAfter');
has('C5 passthrough 分支排除 rate-limit', "r.verdict !== 'rate-limit' && r.verdict !== 'server-error'");

console.log('\n=== D. 预算与并发 ===');
has('D1 总预算常量', 'const TOTAL_BUDGET_MS =');
has('D2 deadline 在入口计算（含探针阶段）', 'const deadline = startedAt + TOTAL_BUDGET_MS;');
has('D3 主循环预算检查', 'const left = remainMs();');
has('D4 单次超时取剩余预算', 'const perTry = Math.max(1500, Math.min(UPSTREAM_TIMEOUT_MS, left));');
has('D5 budgetExhausted 只计一次', 'metrics.budgetExhausted++', { count: 1 });
has('D6 withSlot 支持 abort', 'async function withSlot(fn, signal)');
has('D7 排队 abort 计数', 'metrics.queuedAborted++');
has('D8 probe 走 withSlot', 'withSlot(() => probe(');

console.log('\n=== E. 可观测性（6 个失败出口都要有 recordFailure）===');
const rfSites = has('E0 recordFailure 调用点', 'recordFailure({');
// 用下限而非精确值：新增失败出口是正常的，少一个才说明出口丢了可观测性。
if (rfSites.length < 8) {
  fail++; failures.push('E0 recordFailure 至少应有 8 个调用点');
  console.log(`      实际 ${rfSites.length} 处: 行 ${rfSites.join(',')}`);
} else { pass++; console.log(`      ${rfSites.length} 处: 行 ${rfSites.join(',')}  ✅`); }
has('E1 client: bad_body', "type: 'gate_bad_body'");
has('E2 client: unknown_path', "type: 'gate_unknown_path'");
has('E3 route: 三分支归因(unreachable/all_third/no_route)', "const earlyType = allConnErr ? 'gate_upstream_unreachable'");
has('E4 route: budget/no_route', ": exhausted ? 'gate_budget_exhausted' : 'gate_no_official_route'");
has('E5 rate-limit（等待超限仍用原 type）', "'gate_upstream_rate_limited'");
has('E6 upstream-4xx', "kind: 'upstream-4xx'");
has('E7 lastSuccessAt 在成功时更新', 'lastSuccessAt = new Date().toISOString();');
has('E8 latency 挂 finish+close（含 503/中断）', "res.on('finish', recordOnce);");
has('E9 /gate/latency 端点', "req.url === '/gate/latency'");
has('E10 alerts 含 recentFailures', 'recentFailures,');

console.log('\n=== F. 输入边界 ===');
has('F1 路径白名单', 'const ALLOWED_PATHS = new Set(');
has('F2 路径检查在 body 读取前', 'if (!ALLOWED_PATHS.has(url.pathname))');
has('F3 replyEarly 先 drain', 'try { req.resume(); } catch {}');
has('F4 413 走 replyEarly', 'return replyEarly(req, res, 413');
has('F5 405 走 replyEarly', 'return replyEarly(req, res, 405');
has('F6 body 上限可配', "const MAX_BODY = num('GATE_MAX_BODY'");

console.log('\n=== G. 客户端断开传播 ===');
has('G1 clientGone AbortController', 'const clientGone = new AbortController();');
has('G2 res.close 触发 abort', "if (!res.writableEnded) {");
has('G2b 中止即 abort 整条链', "try { clientGone.abort(); } catch {}");
has('G2c 中止在台账留痕', "result: 'CLIENT_ABORTED'");
has('G3 signal 传入 rankCandidates', 'clientGone.signal)');
has('G4 signal 传入 realRequest', 'signal: clientGone.signal');

console.log('\n=== H. 安全 ===');
has('H1 只监听回环', "server.listen(PORT, '127.0.0.1'");
has('H2 无正文入日志（noid 只记结构）', 'noid:bytes=');
{
  const bad = lines.filter(l => /log\(\{/.test(l) && /\bprompt\b/.test(l));
  if (bad.length) { fail++; failures.push('H3 日志含 prompt'); console.log(`FAIL  H3 日志不含 prompt 字段                        ${bad.length} 处`); }
  else { pass++; console.log('PASS  H3 日志不含 prompt 字段                        0 处'); }
}
has('H4 上游 4xx 响应体截断到 64KB', 'if (sz < 65536)');
has('H5 429 响应体截断到 8KB', 'if (sz < 8192)');

console.log('\n=== I. 响应头契约（每个成功出口都要带 x-gate-result）===');
const resultHeaders = has('I1 成功/失败均写 x-gate-result', "'x-gate-result':");
if (resultHeaders.length < 4) { fail++; failures.push('I1 x-gate-result 出口过少'); }

console.log('\n=== J. 进程安全 ===');
has('J1 KEY 缺失拒绝启动', 'if (!KEY) { console.error');
has('J2 res.on error 吞掉避免崩溃', 'res.on(\'error\', () => {});');
has('J3 未捕获异常兜底', "process.on('uncaughtException'");
has('J4 Promise 拒绝兜底', "process.on('unhandledRejection'");
has('J5 crashCount 暴露到 metrics', 'crashCount }));');

const uncaught = lines.filter(l => /process\.on\('uncaughtException'|process\.on\('unhandledRejection'/.test(l));
if (uncaught.length === 0) {
  fail++; failures.push('J3 缺未捕获异常兜底');
  console.log('FAIL  J3 未捕获异常兜底                            0 处（进程可能被单个异常打死）');
} else { pass++; }

console.log('\n=== K. 官方性证明（proof）接入 ===');
has('K1 PROOF_MODE 配置', 'const PROOF_MODE = (process.env.GATE_PROOF_MODE');
has('K2 PROOF_FILE 配置', 'const PROOF_FILE = process.env.GATE_PROOF_FILE');
has('K3 proofGate 函数', 'function proofGate()');
has('K4 kill switch（off 分支）', 'if (PROOF_MODE === ');
has('K5 高信任时放开所有车道', 'gate.allowAllLanes');
has('K6 third 在 proof 高信任时可交付', 'r.verdict === ');
has('K7 hedge 支持 third 胜出', 'async function hedgeRace(models, args, proto, allowThird = false)');
has('K8 passByProof 计数', 'metrics.passByProof++');
has('K9 /gate/proof 端点', 'req.url === ');

console.log('\n=== L. 每请求预检（precheck）===');
has('L1 PRECHECK 开关', 'const PRECHECK_ENABLE = ');
has('L2 按协议定义预检用例', 'const PRECHECK_CASES_BY_PROTO = {');
has('L2b 协议判据矩阵', 'const PROTO_TRUST = {');
has('L3 预检单例（按协议 Map）', 'const precheckInflight = new Map()');
has('L3b 单例引用清理', 'precheckInflight.get(ckey) === run');
has('L4 预检结果缓存（按协议）', 'precheckLastByProto = new Map()');
has('L4b 按协议读取预检结论', 'precheckLastFor = (p) =>');
has('L5 综合信任判定（带协议）', 'async function trustDecision(precheckPromise, proto');
has('L6 预检失败由 proof 兜底', 'proof_over_precheck_fail');
has('L7 预检通过跳过车道探测', 'probeSkippedByPrecheck');
has('L8 预检与真实请求并行启动', 'const precheckRun = PRECHECK_ENABLE');
has('L11 chat 协议用 logprob 探针', 'async function runChatPrecisionProbe()');
has('L11b chat 用 3 探针取 min', 'const CHAT_PRECISION_PROBES = [');
has('L11c chat 阈值 1e-5', 'const CHAT_TOP1_MAX = 1e-5');
has('L11d chat 样本不足判 net', 'ok.length < 2');
has('L12 无判据协议保守处理', "no_criteria");
hasIn(baseLines, 'L13 messages 状态码指纹（baseline 单源）', "const MSG_FINGERPRINT = '400,400,400,400,400,400,422,422,422'");
has('L13b 指纹类型统一', 'String(c) === validExpected[k]');
has('L13c 指纹异常码容错', 'EXPECTED_SET = new Set([400, 422, 200])');
has('L13d messages 用 x-api-key', "'x-api-key': KEY, 'anthropic-version'");
has('L14 deliver 用 currentTrust', 'const dgate = currentTrust || proofGate()');
has('L15 FORCE_THIRD 自检', "source: 'force_third'");
has('L16 hedge 无胜者释放 stream', 'r.stream && r.stream.destroy()');
has('L17 工具 schema 悬空 $ref 修正', 'function normalizeToolSchemas(tools)');
has('L17b 只摘无法解析的 $ref', 'localTargets.has(m[1])');
has('L18 schema 修正已接入 handle', 'normalizeToolSchemas(body.tools)');
has('L19 模型替换可观测（请求/实际/标记）', 'x-gate-model-substituted');
has('L19b 非 CHAIN 模型回落到 ALLOWED[0]', 'ALLOWED.includes(requestedModel) ? requestedModel : ALLOWED[0]');
has('L20 预检失败必须确认重测', 'PRECHECK_CONFIRM');
has('L20b 抖动恢复计数', 'precheckJitterRecovered');
has('L20c 重测通过即判 pass', "recovered = true");
has('L20d 重测非 fail 降级 unknown', "agg = { ...retryAgg, verdict: 'unknown' }");
has('L20e 外层等待由探针上限派生', 'const precheckWaitMs = () => {');
has('L20f 预检失败可由 proof 兜底', 'proof_over_precheck_fail');
has('L21 上游不可达快速收敛', 'UPSTREAM_FAST_FAIL_LANES');
has('L21b 按车道记录连接失败', 'const noteConnFail');
has('L21c 不可达判定', 'const upstreamDown = () =>');
has('L21d 探针短路', "skipped: 'upstream_unreachable'");
has('L21e 早期分支区分不可达', "allConnErr ? 'gate_upstream_unreachable'");
has('L21f 拒绝原因三分', 'const reasonType = unreachable');
has('L21g retry-after 三档区分', "'retry-after': unreachable ? '10' : slowTail ? '15' : '20'");
has('L22 日志文件可配（测试不污染生产）', 'process.env.GATE_LOG_FILE');
has('L22b 日志带实例标识', 'port: PORT, pid: process.pid');
has('L23 配置数值安全解析', 'function num(name, def');
has('L23b peekBody 中断兜底', "res.on('error', onErr); res.on('close', onErr)");
has('L23c vote 无 id 不凭 completed_at 判官方', "signals.push('id:none')");
has('L23d resp_ 分为 resp_uuid4/resp_bad', "if (idShape === 'resp_' || idShape === 'resp_uuid4') {");
// ★ 第 17 轮：判定口径由「质量」改为「身份」，以下三条随之改写。
// unknown 不再无条件放行，必须命中身份白名单；third 不再允许重验翻案。
has('L23e unknown 须命中身份白名单', "DELIVERABLE_SHAPES.has(r.idShape) && pgate.allowAllLanes");
has('L23e2 third 一律拒绝（无重验翻案）', "REJECT_SHAPE_THIRD");
has('L23e3 无 id 形态被拒', "REJECT_SHAPE_UNKNOWN");
has('L23e3b 重验翻案代码已移除', "THIRD_REVALIDATED_OK", { count: 0 });
has('L23e4 hedge 只许 unknown 胜出', "allowThird && r.verdict === 'unknown'");
// L23f 原断言「enforce 禁用 allow-unverified」随 GATE_BLIND_MODE 一起作废（见 S8）。
// 该能力已被更强的约束取代：交付前必须拿到本协议的预检 pass（S1），与 PROOF_MODE 无关。
has('L23g hedge 晚到流销毁', 'settled) { try { r.stream && r.stream.destroy(); } catch {} return; }');
has('L23h hedge 有 catch 兜底', 'HEDGE_LANE_ERROR');
has('L23i realRequest 响应处理有 try', 'settledFlag');
has('L23j 预检定时器清理', 'clearTimeout(waitTimer)');
has('L23k body 非对象拒绝', '请求体必须是 JSON 对象');
has('L23l 非流式大响应不被 PEEK_CAP 丢弃', 'isSse ? PEEK_CAP : PEEK_HARD_CAP');
has('L23m proof 覆盖记录 proof 龄期', 'proofAgeMs: pgate.ageMs');
has('L23n override 要求 proof 新鲜度', "pgate.ageMs <= OVERRIDE_FRESH_MS");
has('L23n2 覆盖阈值已与探针频率协调', "GATE_OVERRIDE_FRESH_MS', 240000");
has('L23o proof 太旧时不覆盖', "PRECHECK_FAIL_PROOF_TOO_OLD");
has('L23p 跳过探测 TTL 可配置', "SKIP_PROBE_TTL_MS = num('GATE_SKIP_PROBE_TTL_MS'");
has('L23r 预检 TTL 按协议分档', 'PRECHECK_TTL_BY_PROTO = {');
has('L23s messages 预检复用窗口按切换率定标', "GATE_PRECHECK_TTL_MS_MESSAGES', 90000");
has('L23t responses 保持实时', 'responses: PRECHECK_TTL_MS');
has('L23u TTL 取值走协议分档', 'precheckTtlFor(proto)');
has('L24 响应头到达后清除等待超时', 'req.setTimeout(0)');
has('L24b body 阶段独立空闲超时', 'res.setTimeout(BODY_IDLE_TIMEOUT_MS');
has('L24c body 空闲超时可配', "GATE_BODY_IDLE_TIMEOUT_MS', 120000");
has('L24d 路由预算 = 60s 首选 + 30s 后备（90s）', "GATE_TOTAL_BUDGET_MS', 90000");
has('L23q 跳过探测不再硬编码 30000', "const skipProbeTtl = SKIP_PROBE_TTL_MS");
has('L9 hedge 无胜者时回落主循环', 'idx = 0;');
has('L10 预检注入 session 头', "'x-opencode-session': STABLE_SESSION");

console.log('\n=== P. P0–P2 修复守护（2026-10-20 第 16 轮）===');
// P0-1：探针非 2xx 必须是 unknown，不能冒充 third（否则限流会被报成「全部第三方」）
has('P0-1 probe 非 2xx 归 unknown', "return resolve({ verdict: 'unknown', classifier: 'status'", { count: 1 });
has('P0-1 probe 不再判非 2xx 为 third', "verdict: 'third', classifier: 'status'", { count: 0 });
has('P0-1 503 三分支归因', "const earlyType = allConnErr ? 'gate_upstream_unreachable'");
has('P0-1 仅确证 third 才报全第三方', "const allThird = probeNotesReal.length > 0 && probeNotesReal.every(n => n.verdict === 'third')");
// P0-2：心跳/掉线型连接错误不得写 ERROR 台账（真实畸形请求仍要记录）
has('P0-2 连接层错误独立分支', "if (!err?.rawPacket && CONN_LEVEL_CODES.has(err?.code))");
has('P0-2 覆盖 ECONNRESET/EOF 等', "new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'HPE_INVALID_EOF_STATE'])");
has('P0-2 心跳只计 clientResets', 'metrics.clientResets = (metrics.clientResets || 0) + 1;');
// P1-1：交付阶段不再重复计 abortedByClient（handle close + 主循环 catch 共 2 处）
has('P1-1 abortedByClient 只计 2 处', 'metrics.abortedByClient++;', { count: 2 });
// P1-2：所有上游请求必须走 transport
// （probe / realRequest / 形态探针 / 实现向量探针 / 3 个预检 / 缓存语义探针 = 8）
// 2026-11-06：+1 来自 runCacheProbe 的 cacheProbeOnce（L4），它同样走 transport。
// 2026-11-08：+1 来自 messages 官方文案探针 msgTextProbe。
has('P1-2 上游请求统一走 transport', 'const req = transport.request(', { count: 9 });
has('P1-2 预检不再硬编码 https.request', 'const req = https.request(', { count: 0 });
// P1-3：矩阵刷新与告警覆盖三条协议
has('P1-3 刷新覆盖 chat', "for (const proto of ['responses', 'messages', 'chat'])");
// 告警只判 responses/messages：chat 的 id 形态恒为 chatcmpl(third)，纳入会产生每轮噪音，
// 把 50 条环形缓冲占满、挤掉真告警（P1-3 落地时实测确认过）。
has('P1-3 告警不纳入 chat（避免噪音）', "for (const p of ['responses', 'messages'])");
has('P1-3 chat 常态 third 的说明', 'chat 车道的 id 形态恒为 chatcmpl');
// 告警判据：只有全 third / 全不可达才算降级（unknown 属无法判定，不是降级证据）
has('P1-3 告警判据收窄为 third|error', "rows.every(x => x.verdict === 'third' || x.verdict === 'error')");
// P1-4：空候选链必须在启动时拒绝
has('P1-4 ALLOWED 空启动拒绝', 'if (!ALLOWED.length) {');
// P1-5：proof 有效期取「门控 / 探针声明」更严者
has('P1-5 proof 龄期取更严者', 'Math.min(gateAgeLimit, declaredAgeMs)');
has('P1-5 仍读 expiresAt 声明', 'const d = Date.parse(data.expiresAt) - Date.parse(data.ts);');
// P2-2：metrics 初值补全（schema 稳定）
has('P2-2 clientResets 有初值', 'clientResets: 0');
has('P2-2 thirdRevalidated 有初值', 'thirdRevalidated: 0');
has('P2-2 httpParseErrors 有初值', 'httpParseErrors: 0');
// P2-3：ep 死结构已删除
has('P2-3 无 ep 死变量', "const ep = ''", { count: 0 });
has('P2-3 无 if(false) 死分支', 'if (false) {', { count: 0 });
// P2-6：延迟样本含 503/中断
has('P2-6 latency 挂 finish+close', "res.on('finish', recordOnce);");
has('P2-6 latency close 兜底', "res.on('close', recordOnce);");

console.log('\n=== Q. 第 17 轮：身份白名单（只收官方后端）===');
hasIn(baseLines, 'Q1 白名单含 UUID4/resp_uuid4/resp_（baseline 单源）', "const DELIVERABLE_SHAPES = new Set(['UUID4', 'resp_uuid4', 'resp_']);");
has('Q2 third 直接拒绝（4xx 透传除外）', "if (r.verdict === 'third' && !r.passthrough) {");
has('Q3 拒绝计数 third', 'metrics.rejectedThirdShape = (metrics.rejectedThirdShape || 0) + 1;');
has('Q4 拒绝计数 unknown', 'metrics.rejectedUnknownShape = (metrics.rejectedUnknownShape || 0) + 1;');
has('Q5 hedge 受白名单约束', "allowThird && r.verdict === 'unknown' && DELIVERABLE_SHAPES.has(r.idShape)");
// 2026-10-27 晚间：上游不再返回官方 UUID4 request_id（改 gw-…），该开关已关闭，
// 但**校验机制本身必须保留**（将来若恢复可一行打开）。
has('Q6 request_id 形态校验机制保留', 'if (c.requestIdUuid) {');
has('Q7 request_id 必须是 UUID4', 'if (!m || !UUID4.test(m[1]))');
has('Q8 health 暴露白名单', 'deliverableShapes: [...DELIVERABLE_SHAPES]');
has('Q9 health 暴露 proof 信任', 'proofTrust: pg.trust');
has('Q10 health 暴露启动自检', 'startupSelfTest,');
has('Q11 启动自检存在', 'STARTUP_SELFTEST');
has('Q20 启动自检对非 pass 重试一次', "precheckLastByProto.delete('responses')");
has('Q21 health 暴露预检等待与确认次数', 'precheckWaitMs: precheckWaitMs(), precheckConfirm: PRECHECK_CONFIRM');
has('Q22 health 暴露按协议预检 TTL', 'precheckTtlMs: { ...PRECHECK_TTL_BY_PROTO }');
has('Q23 health 暴露自适应探针上限', 'probeDeadlineMs: probeDeadlineMs(),');
has('Q24 探针走总时长而非仅空闲超时', 'signal: AbortSignal.timeout(probeDeadlineMs())');
// ---- 2026-10-22 耐久化改造的四条不变量 ----
has('Q25 只缓存 pass（net/timeout 不再毒化窗口）', 'const precheckPassByProto = new Map();');
has('Q26 正向 fail 立即短路旧 pass', "lastAttempt.verdict === 'fail'");
has('Q27 后台保活预检（把探针移出关键路径）', "num('GATE_PROOF_REFRESH_MS', 25000");
has('Q28 外层等待不得小于探针上限（强制抬升+留痕）', "result: 'CONFIG_CLAMPED'");
// ---- 2026-10-22 审查发现的自引入回归：跳过判断必须读「新鲜 pass」 ----
has('Q29a rankCandidates 不再读最近一次尝试', 'const pcTok = precheckLastFor(proto);', { count: 0 });
has('Q29b rankCandidates 读新鲜 pass', 'const pcTok = precheckPassFor(proto);');
has('Q29c refreshMatrix 不再读最近一次尝试', 'const pcR = precheckLastFor(proto);', { count: 0 });
has('Q29d refreshMatrix 读新鲜 pass', 'const pcR = precheckPassFor(proto);');
has('Q29e health 的 lastPass 分协议暴露', 'lastPass: Object.fromEntries(');
has('Q12 自检失败不退出（防重启风暴）', "不退出；由 /gate/health 暴露给 watchdog");
has('Q13 白名单拒绝计数有初值', 'rejectedThirdShape: 0, rejectedUnknownShape: 0');

console.log('\n=== R. 第 18 轮：身份判定收紧（审计遗留 3 项）===');
// 1) 只有 UUIDv4 算官方 —— 否则 uuid1/uuid3/uuid5 都能冒充，且 official 出口不查白名单
has('R1 官方只认 UUID4', "const isOff = idShape === 'UUID4';");
has('R1b 不再双认 UUID', "idShape === 'UUID4' || idShape === 'UUID'", { count: 0 });
// 2) 候选链必须是 DeepSeek —— 门控从不判「请求发给了谁」，异模型经 CHAIN 注入会绕过全部响应侧判据
has('R2 启动校验 DeepSeek 前缀', "const NON_DS = ALLOWED.filter(m => !/^deepseek-/i.test(m));");
has('R3 非 DeepSeek 拒绝启动', '违反「只接受官方后端」约束，拒绝启动');
// 3) block 模式下不存在「无证明也交付」的通道
has('R4 block 模式拦截未验证交付', 'UNVERIFIED_DELIVERY_BLOCKED');
has('R5 拒交付不写响应头 continuation', "x-gate-reason': 'unverified_delivery_blocked'");
// 4) 死代码修复：全部 third 后的「立即重探」原先用 `!order.length`，永不成立（rankCandidates 总返回全车道）
has('R6 重探判据查矩阵缓存', "const laneVerdictOf = (m) => (cacheGet(m, proto)?.verdict) || verdicts.get(m);");
has('R7 重探严格限定全 third', "const allLanesThird = order.length > 0 && order.every(m => laneVerdictOf(m) === 'third');");
has('R8 重探有冷却（防故障态放大）', 'STALE_RECHECK_COOLDOWN_MS = 5000');
has('R9 旧死条件已移除', 'if (!order.length) {', { count: 0 });

console.log('\n=== S. 第 19 轮：交付前置闸（方案收敛后的唯一安全改动）===');
// 1) 授权提前到「发出真实请求之前」：预检不是 pass 就不调上游
has('S1 前置闸按预检结论拦截', "if (decision.precheck?.verdict !== 'pass') {");
has('S2 拒绝原因可辨识', "'x-gate-reason': 'precheck_not_pass'");
has('S3 瞬时类失败带 retry-after', "'retry-after': '5',");
has('S4 台账可诊断预检结论', 'precheckVerdict: pv');
has('S5 计数独立', 'metrics.precheckNotPass');
// 2) official 不再有「形态自我证明」的特权
has('S6 official 出口只认 official', "if (r.verdict === 'official') return deliver(model, r, attempts.length);");
has('S7 无 official-unverified 升格', "verdict = 'official-unverified'", { count: 0 });
// 3) 无证明交付通道整体移除（开关 + 分支）
has('S8 GATE_BLIND_MODE 已移除', 'process.env.GATE_BLIND_MODE', { count: 0 });
has('S9 PASS_UNVERIFIED 不再交付', "resultKind = 'PASS_UNVERIFIED'", { count: 0 });
has('S10 保险丝仍在（不可达即 503）', 'UNVERIFIED_DELIVERY_BLOCKED');

// ★ 2026-10-22：PASS 主记录必须带 elapsedMs —— 否则端到端时延无法从台账直接读出。
has('Q30 PASS 主记录必须带 elapsedMs', 'probeNotes: notes, attempts,');
has('Q31 PASS 主记录必须带 elapsedMs 计算式', 'elapsedMs: Date.now() - startedAt');
// ★ 2026-10-22 审查修复：探针上限必须与总预算联动，否则最坏情况只剩 10s 给真实回答。
has('Q32 探针上限受总预算约束', 'Math.min(PROBE_DEADLINE_MAX, probeDeadlineCap(),');
has('Q33 定义上游预算预留', 'const MIN_UPSTREAM_BUDGET_MS = num(');
has('Q34 health 暴露预算不变量', 'budgetInvariantOk:');
has('Q35 cap 采用一半预算兜底', 'Math.floor(TOTAL_BUDGET_MS * 0.5)');

// ★ 2026-10-22 审查修复：超时探针必须触发 EWMA 跳档，否则 1.6x/轮 爬坡太慢（实测 18s 需 3 轮）。
has('Q36 超时探针触发 EWMA 跳档', 'const probeTimedOut = tookMs >= deadlineAtStart - 100;');
has('Q37 EWMA 跳档分支存在', 'if (timedOut) {');
has('Q38 跳档留痕', "result: 'EWMA_JUMP'");
has('Q39 冷启动下限 8000', "GATE_PROBE_DEADLINE_MIN', 8000");

// ★ 2026-10-23 审查修复：上游把内部故障报成 400（code/type=server_error）时必须按瞬时错误重试，
has('Q40 识别 4xx 中的 server_error', 'const looksServerError = ecode === "server_error"');
has('Q41 分类为 server-error 可重试', 'verdict = "server-error";');
has('Q42 计数留痕', 'metrics.upstream4xxServerError');

// ★ 2026-10-23：判据漂移（drift）与第三方证据（format）必须分开
has('Q43 drift 判定存在', "verdict: 'drift'");
has('Q44 drift 必须计入 failCount（授权口径不放松）', "['fail', 'format', 'drift'].includes(r.verdict)");
has('Q45 drift 单独计量', 'metrics.precheckDrift');
has('Q46 drift 进 alerts 留痕', "result: 'PRECHECK_DRIFT'");

// ★ 2026-10-23 事故防护：多行替换若被压成单行，'return resolve(' 会被 // 注释吞掉，
// 探针永不 resolve（实测：保活停摆、请求等满 13s 后 503 timeout）。
// 这里断言不存在「超长行 + return resolve(」这种压缩痕迹。
const longResolve = src.split(/\r?\n/).filter(l => l.length > 300 && l.includes('return resolve('));
if (longResolve.length === 0) { pass++; console.log('PASS  ' + 'Q47 无被注释吞掉的 return resolve'.padEnd(50) + ' 0 处'); }
else { fail++; failures.push('Q47 压缩行吞掉了 return resolve'); console.log('FAIL  ' + 'Q47 无被注释吞掉的 return resolve'.padEnd(50) + ' ' + longResolve.length + ' 处'); }

// ★ 2026-10-23：4xx 伪装 server_error 必须用满重试并换车道，全失败才透传
has('Q48 5xx 仍用满 LANE_RETRY', ': LANE_RETRY;');
has('Q49 旧的一击透传已移除', 'Math.min(1, LANE_RETRY)', { count: 0 });
has('Q50 全车道失败仍透传上游 4xx', 'if (last4xx) {');
has('Q51 last4xx 留痕', 'afterAllLanes: true');

// ★ 2026-10-23：车道健康记忆 + 4xx 少重试
has('Q52 车道健康记忆存在', 'const laneCooldown = new Map();');
has('Q53 坏车道排到末尾', 'candidates = preferHealthyLanes(candidates, proto, bodyBuf ? bodyBuf.length : 0);');
has('Q54 4xx server_error 只重试 1 次', 'const retryCap = is4xx ? Math.min(SERVER_ERR_4XX_RETRY, LANE_RETRY) : LANE_RETRY;');
has('Q55 失败即标记坏车道', 'markLaneBad(model, proto, bodyBuf ? bodyBuf.length : 0);');
has('Q56 冷却不剔除只降序', 'return good.concat(bad);');

// ★ 2026-10-23：单次尝试必须有墙钟硬上限（心跳可让空闲超时永不触发，实测挂满 45s）
has('Q57 硬上限常量存在', "const ATTEMPT_HARD_CAP_MS = num('GATE_ATTEMPT_HARD_CAP_MS'");
has('Q58 硬上限计时器', 'hardTimer = setTimeout(() => {');
has('Q59 切断并结算 error', "error: 'attempt_hard_cap'");
has('Q60 结算时清除计时器', 'if (hardTimer) { try { clearTimeout(hardTimer); } catch {} hardTimer = null; }');
has('Q61 硬超时留痕', "result: 'ATTEMPT_HARD_TIMEOUT'");
has('Q62 硬上限受单请求预算约束', 'const capMs = Math.max(5000, Math.min(ATTEMPT_HARD_CAP_MS, timeoutMs || UPSTREAM_TIMEOUT_MS));');
has('Q63 大包请求更长冷却', 'const BIG_PAYLOAD_COOLDOWN_MS = num(');
has('Q64 按体积档选冷却时长', "const ms = cls === 'B' ? BIG_PAYLOAD_COOLDOWN_MS : LANE_COOLDOWN_MS;");
has('Q65 请求形状诊断记录', "result: 'REQUEST_SHAPE'");
has('Q66 冷却键含体积档', "const laneKey = (m, p, cls) => m + '|' + p + '|' + cls;");
has('Q67 体积分两档', "const sizeClassOf = (bytes) => (BIG_PAYLOAD_BYTES > 0 && bytes >= BIG_PAYLOAD_BYTES) ? 'B' : 'S';");
has('Q68 排序时传入体积', 'candidates = preferHealthyLanes(candidates, proto, bodyBuf ? bodyBuf.length : 0);');

// ★ 2026-10-26：resp_ 后缀必须校验 UUID4 位模式（关闭「resp_ + 任意 hex 被放行」的洞）
has('Q74 UUID4 位模式校验存在', "const UUID4_BITS = (h) => typeof h === 'string'");
has('Q75 只有显式 0 才回退（fail-closed）', "const RESP_SHAPE_STRICT = RESP_SHAPE_RAW !== '0';");
has('Q76 shapeOf 产出 resp_bad', "return (m && UUID4_BITS(m[1])) ? 'resp_uuid4' : 'resp_bad';");
// 2026-11-06：count 由 1 改 2 —— 第二处是 L3 流式缓冲的台账标签
// （`idShape: idOk ? 'resp_uuid4' : 'resp_bad'`），只用于记录被拒原因，不参与放行判定。
has('Q77 resp_bad 不在可交付白名单', "'resp_bad'", { count: 2 });
has('Q78 回退开关生效点', "if (!RESP_SHAPE_STRICT) return 'resp_';");
has('Q79 非法取值记配置告警', 'GATE_RESP_SHAPE_STRICT="');

console.log('\n=== V. 判据单源 / 本地鉴权 / 状态可见性 ===');
// 判据常量只允许有一个来源：baseline.mjs。gate 与 probe 都 import 它，任何一处复制字面量 = 漂移隐患。
hasIn(baseLines, 'V1 baseline 声明观测日期', 'export const OBSERVED_AT =');
hasIn(baseLines, 'V2 baseline 含 e1 文案', 'export const E1_MSG =');
has('V3 gate 从 baseline 导入', "from './baseline.mjs';");
has('V4 gate 不再本地定义状态码指纹', 'const MSG_FINGERPRINT', { count: 0 });
has('V5 gate 不再本地定义 UUID4 正则', 'const UUID4 = /^', { count: 0 });
has('V6 gate 不再本地复制 e1 文案', 'Either input or instructions must be provided', { count: 0 });
hasIn(probeLines, 'V7 probe 从 baseline 导入', "'../gate/baseline.mjs'");
hasIn(probeLines, 'V8 probe 不再本地复制 e1 文案', 'Either input or instructions must be provided', { count: 0 });
hasIn(probeLines, 'V9 probe 不再本地复制网关错误文案', 'Upstream request failed|Endpoint is unavailable', { count: 0 });

// 回环绑定不等于安全：本机任意进程都能打 8787。GATE_TOKEN 是可选但必须存在的闸门。
has('V10 本地鉴权开关存在', "const GATE_TOKEN = process.env.GATE_TOKEN || '';");
has('V11 未授权出口', "type: 'gate_unauthorized'");
has('V12 未授权计入台账', "result: 'UNAUTHORIZED'");

// 保护状态必须对用户可见：否则上游变了会「安静地失效」，用户还以为在被保护。
has('V13 health 暴露判据新鲜度', 'judgeAgeMs:');
has('V14 health 暴露最近判据结论', 'lastJudgeOk:');
has('V15 health 暴露唯一出网目标', 'egressHost:');
has('V16 health 暴露基线日期', 'baselineObservedAt:');
has('V17 出网可追溯开关', "process.env.GATE_TRACE === '1'");
// 安全：token 可能被客户端误放进 URL query，台账不能把整条 URL 写进去
has('V18 台账路径剥离 query', "String(req.url).split('?')[0]");
has('V19 无整条 URL 入台账', 'path: req.url', { count: 0 });
has('V20 token 常量时间比较', 'crypto.timingSafeEqual(a, b)');
has('V21 只收 JSON content-type（挡跨域 no-cors）', "gate_bad_content_type");
has('V22 只认回环 Host（挡 DNS rebinding）', "gate_bad_host");
hasIn(cliLines, 'V23 默认不打印调用栈（避免泄漏本机路径）', "process.env.OCG_DEBUG === '1'");
hasIn(cliLines, 'V24 diag 写盘失败只给人话', '写入 ${outFile} 失败');
// 2026-10-23 实测漏洞：Host 校验原在 isProxy 分支（/gate/health、/gate/proof 之后），
// `curl -H 'Host: evil.example' /gate/proof` 返回 200 —— rebind 页面同源可读走响应体。
hasOrder('V25 Host 校验早于 /gate/* 出口', 'const hostHdr = String(req.headers.host', "req.url === '/gate/health'");
has('V26 /gate/proof 不回传绝对路径', 'file: path.basename(PROOF_FILE)');

// 2026-10-26：重复部署（同机多份安装 / 同端口被拉两次）必须「可识别 + 不隐形重启」。
// 现场证据：两个监护同时拉门控，第二个 EADDRINUSE 后 15s 退避无限重启，stderr 进 conhost 看不见。
has('W1 health 暴露安装根（doctor 判归属）', 'root: INSTALL_ROOT,');
has('W2 端口占用使用专用退出码', 'EXIT_PORT_IN_USE = 4');
has('W3 端口占用时探测占用者归属', "path: '/gate/health'");
hasIn(supLines, 'W4 监护按端口加单实例锁', 'supervise-${process.env.GATE_PORT');
hasIn(supLines, 'W5 端口占用退出码不再重启', 'code === PORT_IN_USE_CODE');
hasIn(supLines, 'W6 陈旧锁可回收（崩溃后仍能起）', "fs.openSync(LOCK, 'wx')");
// 只看 pidAlive 会被 Windows 的 PID 复用骗死：锁里的 pid 被任意新进程占用后，这个端口再也起不来。
// 锁的真值来源必须是「端口上有没有我们的门控应答」。
hasIn(supLines, 'W7 锁的真值来源是端口应答', 'await liveGate()');
hasIn(supLines, 'W8 锁不可用时不阻断启动', '本次不加锁继续运行');
// 2026-10-26：慢挂（吃满单次上限）若还按 LANE_RETRY 重试同车道，会把总预算烧在同一条坏车道上，
// 第二条车道永远轮不到。必须直接换道。
has('W9 慢挂不重试同车道（直接换道）', "result: 'LANE_SLOW_HANG',");has('W9 端口占用写入台账（stderr 在计划任务下看不见）', "result: 'PORT_IN_USE'");
// 2026-10-26（R1）：客户端不该把真 key 送过回环。门控只用自己的 key，
// 客户端侧用占位变量；门控对「仍送真 key」做一次性告警，便于迁移是否生效可验证。
hasIn(cliLines, 'W11 客户端侧使用占位 key', 'OCG_PLACEHOLDER_KEY');
has('W12 客户端送真 key 时记一次台账', "result: 'CLIENT_SENT_REAL_KEY'");
has('W13 health 暴露客户端是否送过真 key', 'clientKeyFromEnv:');
hasIn(cliLines, 'W10 doctor 归属比较做路径归一', 'norm(h.root) === norm(ROOT)');

// ===== 2026-10-27：上游单方面变更后的重新标定（模型下线 + 判据漂移）=====
// 现场：16:01 UTC+8 起所有探针返回 410 ModelDeprecated，9 项指纹变 410×9 → 全量 503。
// 结论：不是门控 bug（fail-closed 正确），但默认车道与 responses 判据都必须跟着改，否则永久 503。
console.log('\n=== X. 2026-10-27 重新标定 ===');
has('X1 默认车道改为官方在售别名', "process.env.GATE_CHAIN || 'deepseek-v4.1-flash'");
has('X2 已下线的旧默认链不再存在', "'deepseek-flash,deepseek-v4.1-flash'", { count: 0 });
has('X3 messages 无条件封禁（除显式白名单开关）', "process.env.GATE_ALLOW_MESSAGES === '1' ? [] : ['messages']");
has('X4 responses 主判据改用类型层 serde 文案', 'expect: E_SERDE_TYPE_MSG');
has('X5 serde 伴生特征参与判定（按家族）', 'hitFam.extras.every(re => re.test(msg))');
has('X5b request_id 证据永久失效后不再强制 UUID4', 'requestIdUuid: false');
hasIn(baseLines, 'X6 baseline 定义类型层 serde 判据', 'export const E_SERDE_TYPE_MSG =');
hasIn(baseLines, 'X7 baseline 留档 messages 漂移指纹', 'export const MSG_FINGERPRINT_2026_10_27');
hasIn(baseLines, 'X8 旧枚举判据标记退役', '已退役（2026-10-27 晚间）');

// ===== 2026-10-27 判据冻结版：只依赖"实测 100% 稳定"的特征 =====
// 背景：参数校验类探针会随上游实现池轮询而抖（同一条探针 422↔200），拿它放行 = 随机 503。
// 冻结后 responses 只用形态探针（id 位模式 38/38 + usage 键集 20/20），
// 参数探针降级为"实现指纹向量"，只告警不放行。
console.log('\n=== Y. 判据冻结版（形态探针 + 结构闸 + 信任分级）===');
has('Y1 形态探针存在（支持车道级 + 上限可被无证据重试放宽）', "function runShapeProbe(lane = '', deadlineOverrideMs = 0)");
has('Y2 responses 走形态策略', "responses: 'shape',");
has('Y3 形态判据校验 usage 键集（按剖面）', 'const need = hasOpc ? USAGE_KEYS_REQUIRED : OFFICIAL_USAGE_KEYS;');
has('Y4 结构闸拒绝无正文', "result: 'STRUCTURE_BAD'");
has('Y5 结构闸错误类型可读', "type: 'gate_structure_bad'");
has('Y6 截断响应打标', "'x-gate-truncated'");
has('Y7 信任分级存在', 'function trustLevel()');
has('Y8 实现向量仅告警不放行', "result: 'IMPL_VECTOR_DRIFT'");
hasIn(baseLines, 'Y9 baseline 定义必需 usage 键', 'export const USAGE_KEYS_REQUIRED =');
hasIn(baseLines, 'Y10 baseline 留档实现向量', 'export const IMPL_VECTOR_2026_10_27 =');

// ===== 2026-10-29：每响应指纹（提高对第三方/自部署实现的拒答率）=====
// 交付闸从"只查 id 形态"升级为 8 项必要条件；实测 flash 车道 10/10 全绿，加严不误伤。
console.log('\n=== Z. 每响应指纹 ===');
hasIn(baseLines, 'Z1 baseline 定义 18 字段集', 'export const RESP_KEYS_COMPAT =');
hasIn(baseLines, 'Z2 baseline 定义 item id 正则', 'export const ITEM_ID_RE =');
hasIn(baseLines, 'Z3 baseline 定义流式事件家族', 'export const EVENT_FAMILY_REQUIRED =');
has('Z4 指纹函数存在（含请求侧条件校验与模型定价）', 'function fingerprint(body, reqBody, model)');
has('Z4b reasoning 条件回显校验', "pushHard('reasoningEcho')");
has('Z5 算术校验存在（total=in+out）', "pushHard('arithmeticTotal')");
has('Z6 流式旁路采样器存在', 'function makeEventTap(');
has('Z7 旁路不缓冲（原样透传同一 chunk）', 'this.push(chunk); cb();');
has('Z8 默认策略 retry', "process.env.GATE_FP_POLICY || 'retry'");
has('Z9 block 模式错误类型', "type: 'gate_response_fingerprint'");
has('Z10 响应头暴露指纹结论', "'x-gate-fp': fpDegraded ? 'degraded' : 'ok'");
has('Z11 health 暴露 fingerprint', 'fingerprint: {');
has('Z12 预检窗口默认 15s', "num('GATE_PRECHECK_TTL_MS', 15000");

// ===== 2026-10-30：/gate/* 观测端点可选鉴权（GATE_OBS_TOKEN）=====
// 动机：health/metrics/proof/matrix 会暴露用量、车道、判据状态与本机安装根；
// Host 校验只挡浏览器 rebinding，挡不住同用户的本机进程。默认关闭以保持脚本兼容。
console.log('\n=== AA. 观测端点鉴权 ===');
has('AA1 观测 token 配置存在', "const OBS_TOKEN = process.env.GATE_OBS_TOKEN || '';");
has('AA2 通用常量时间比较存在', 'const tokenOk = (got, expected) =>');
has('AA3 /gate/* 前置拦截存在', "String(req.url || '').startsWith('/gate/')");
has('AA4 401 类型可读', "type: 'gate_obs_unauthorized'");
has('AA5 health 暴露 obsTokenRequired', 'obsTokenRequired: !!OBS_TOKEN,');
hasIn(cliLines, 'AA6 ocg 客户端携带观测 token', 'const OBS_HEADERS = () =>');
has('AA7 观测鉴权与代理鉴权解耦', 'OBS_TOKEN && String(req.url');

// ===== 2026-10-30：优雅停止（drain）+ ocg stop/restart =====
// 动机：Stop-Process -Force 会 RST 在途连接，客户端只看到 Connection error；
// dsh 只重试 1 次(800ms)，落不到新实例窗口。drain 用 server.close + 等在途收尾解决。
console.log('\n=== AB. 优雅停止与重启 ===');
has('AB1 drain 端点存在', "'/gate/admin/drain'");
has('AB2 未配 token 时禁用（禁本机任意进程停门控）', "type: 'gate_drain_disabled'");
has('AB2b drain 只认 GATE_TOKEN（OBS token 不得提权）', 'drain 只认 GATE_TOKEN');
has('AB3 未授权分类可读', "type: 'gate_drain_unauthorized'");
has('AB4 在途计数与并发闸门分离', 'let gateInflight = 0;');
has('AB5 排空期快速 503 + retry-after', "type: 'gate_draining'");
has('AB6 drain 上限可配', "num('GATE_DRAIN_MAX_MS', 15000");
has('AB7 drain 后写快照并退出', 'try { writeSnapshot(); } catch {}');
hasIn(cliLines, 'AB8 ocg 有 stop 子命令', "case 'stop': return cmdStop();");
hasIn(cliLines, 'AB9 ocg 有 restart 子命令', "case 'restart': return cmdRestart();");
hasIn(cliLines, 'AB10 ocg 调 drain 端点', 'gate/admin/drain');
hasIn(cliLines, 'AB11 stop.flag 与监护一致', "const STOP_FLAG = path.join(ROOT, 'stop.flag');");
hasIn(cliLines, 'AB12 start 会清除 stop.flag', 'fs.unlinkSync(STOP_FLAG)');

// ===== 2026-11-01：v4 判据（hard/soft 分离 + 断路器）=====
console.log('\n=== AC. v4 判据与断路器 ===');
hasIn(baseLines, 'AC1 item id UUID4 正则单源', 'export const ITEM_ID_UUID4 =');
hasIn(baseLines, 'AC2 item 必需键白名单', 'export const ITEM_KEYS_REQUIRED =');
hasIn(baseLines, 'AC3 usage 明细必需键', 'export const USAGE_DETAILS_REQUIRED =');
hasIn(baseLines, 'AC4 计费单价单源', 'export const BILLING =');
has('AC5 指纹返回 hard/soft 两档', 'const hard = [], soft = [];');
has('AC6 未知字段只进 soft', "soft.push('keysUnknown')");
has('AC7 缺必需项进 hard（unknown 剖面降级）', "pushHard('keysRequired')");
has('AC8 计费相对容差（0.1%）', 'const tol = Math.max(1e-9, 1e-3 * Math.abs(o.list_cost));');
has('AC9 cache_write 时跳过计费校验', "soft.push('billingSkippedCacheWrite')");
has('AC10 大包不重发', 'const FP_RETRY_MAX_BYTES = num(');
has('AC11 断路器实现（带模式）', "function noteFingerprint(ok, detail, mode = 'json')");
has('AC12 断路器 blocking 判定（带模式）', "function breakerBlocking(mode = 'json')");
has('AC13 断路器 503 分类', "type: 'gate_fp_breaker_open'");
has('AC14 手动复位端点', "'/gate/admin/fp-reset'");
has('AC15 health 暴露断路器（json+stream）', "json: breakerView('json'), stream: breakerView('stream')");
has('AC16 重发失败透传上游错误', "type: 'gate_fp_retry_upstream_error'");

// ===== 2026-11-01（第二轮实测修复）=====
console.log('\n=== AD. 运行时缺陷修复回归 ===');
has('AD1 断路器按模式分别计数（noteFingerprint 5 处）', 'noteFingerprint', { count: 5 });
has('AD2 warn 模式不参与熔断', "if (FP_POLICY === 'warn') return;                  // warn 模式完全不参与熔断");
has('AD3 流式与 json 模式隔离', "noteFingerprint(false, miss.join(','), 'stream')");
has('AD4 半开探针 30s 自动释放', 'setTimeout(() => { b.probeInFlight = false; }, 30000)');
has('AD5 流式不发 x-gate-fp', "String(r.ctype || '').includes('event-stream') ? {} : { 'x-gate-fp'");
has('AD6 分账仅在 tokens 有值时校验', "const hasTok = ['input', 'cache_read'].some");
has('AD7 alert 模式不阻断', "if (BREAKER_POLICY !== 'block') return false;");

// ===== 2026-11-02：正向证据链（EV1–EV9）=====
console.log('\n=== AE. 证据链实现 ===');
hasIn(evLines, 'AE1 证据模块存在', 'export async function runEvidence');
hasIn(evLines, 'AE2 打分函数存在', 'export function scoreEvidence');

hasIn(evLines, 'AE4 FIM beta 引导 EV2', 'beta api');
hasIn(evLines, 'AE5 温度范围校验 EV3', 'valid range of temperature');
hasIn(evLines, 'AE6 top_p 范围校验 EV4', 'valid range of top_p');
hasIn(evLines, 'AE7 TLS 证书探针 EV5', 'tlsProbe');
hasIn(evLines, 'AE8 ALPN 探针 EV6', 'ALPNProtocols');
hasIn(evLines, 'AE9 模型层永不可证', 'unproven');
has('AE10 门控 require 前置闸', "type: 'gate_evidence_unmet'");
has('AE11 证据漂移告警', "pushAlert('EVIDENCE_DRIFT'");
has('AE12 health 暴露证据链', 'evidence: (() => {');
hasIn(cliLines, 'AE13 CLI 命令 audit-lane', 'cmdAuditLane');
hasIn(cliLines, 'AE14 按 host 选 key', 'pickEvidenceKey');

// ===== 2026-11-02：模型族证据（EV10/EV11 + 策略）=====
console.log('\n=== AF. 模型族证据与闸门 ===');
hasIn(baseLines, 'AF15 分词基线语料存在', 'export const TOKENIZER_CORPUS =');
hasIn(baseLines, 'AF16 官方错误模板存在', 'export const OFFICIAL_ERR_TEMPLATES =');
hasIn(baseLines, 'AF17 UUID4 请求号正则单源', 'export const UUID4_REQUEST_ID =');
hasIn(evLines, 'AF18 EV10 分词一致性探针', "add('EV10'");
hasIn(evLines, 'AF19 EV11 官方校验器探针', "add('EV11'");
hasIn(evLines, 'AF20 三档 family：official', "return 'deepseek-official'");
hasIn(evLines, 'AF21 三档 family：thirdparty', "return 'deepseek-thirdparty'");
hasIn(evLines, 'AF22 三档 family：mismatch', "return 'mismatch'");
has('AF23 模型族策略常量', "const MODEL_EVIDENCE_POLICY =");
has('AF24 模型族闸 503', "type: 'gate_modelfamily_unmet'");
has('AF25 模型族闸只认 official', "fam === 'deepseek-official'");
has('AF26 health 分开暴露两闸策略', 'modelPolicy: MODEL_EVIDENCE_POLICY');
hasIn(evLines, 'AF27 权重永远 unproven', "weights: 'unproven'");

// ===== 2026-11-02：请求体上限与 big-body 观测 =====
console.log('\n=== AG. 请求体上限 ===');
has('AG28 big-body 阈值常量', "const BIG_BODY_BYTES = num('GATE_BIG_BODY_BYTES'");
has('AG29 413 报错体带 actual_bytes', 'actual_bytes: bodySize');
// 2026-11-07：两处 x-gate-fatal 原用 res.setHeader 设置，而 replyEarly 内部
// `res.writeHead(status, headers)` 会覆盖它 —— 头顶从未真正发出过。
// 现在都走 replyEarly 的 extraHeaders 参数（413 一处 + assurance 一处 = 2）。
has('AG30 413 标记不可重试', "x-gate-fatal': '1'", { count: 2 });
has('AG31 big-body 响应头', "res.setHeader('x-gate-big-body', '1')");
has('AG32 大 body 台账', "result: 'BIG_BODY'");
has('AG33 health 暴露 bodyLimit', 'bodyLimit: { maxBodyBytes: MAX_BODY');
has('AG34 413 计数', 'metrics.bodyTooLarge = (metrics.bodyTooLarge || 0) + 1');

// ===== 2026-11-04：L0 端点指纹 + messages 判据 + assurance 闸 =====
console.log('\n=== AH. L0/MSG/assurance ===');
hasIn(evLines, 'AH35 L0 判据常量', "export const L0_IDS = ['L0-1'");
hasIn(evLines, 'AH36 messages 判据常量', "export const MSG_IDS = ['M1'");
hasIn(evLines, 'AH37 探针支持可切换认证方式', "auth = 'bearer'");
hasIn(evLines, 'AH38 L0-1 models 指纹', "add('L0-1'");
hasIn(evLines, 'AH39 L0-2 官方 trace 头', "add('L0-2'");
hasIn(evLines, 'AH40 L0-3 第三方头', "add('L0-3'");
hasIn(evLines, 'AH41 L0-4 governor 文案', "add('L0-4'");
hasIn(evLines, 'AH42 L0-5 跨厂商模型', "add('L0-5'");
hasIn(evLines, 'AH43 M6 官方校验器', "add('M6'");
hasIn(evLines, 'AH44 messages 路径按 host 选择', 'MSG_PATH');
hasIn(evLines, 'AH45 validator 可达判定', 'const validator = { responses: v1, messages: v2');
has('AH46 GATE_ASSURANCE 常量', 'const ASSURANCE = (process.env.GATE_ASSURANCE');
has('AH47 GATE_L0_POLICY 常量', 'const L0_POLICY = (process.env.GATE_L0_POLICY');
has('AH48 assurance fail-closed 503', "type: 'gate_assurance_unmet'");
has('AH49 逐响应 proof 响应头', "'x-gate-proof'");
has('AH50 health 暴露 assurancePolicy', 'assurancePolicy: ASSURANCE');

// ===== 2026-11-04：随机 canary + 按协议解耦 =====
console.log('\n=== AJ. canary / 协议解耦 ===');
hasIn(evLines, 'AJ1 EV13 canary 探针', "add('EV13'");
hasIn(evLines, 'AJ2 canary 使用随机串', 'crypto.randomBytes(7)');
hasIn(evLines, 'AJ3 canary 只在非官方目标跑', 'isOfficial || !baseKey');
hasIn(evLines, 'AJ4 canary 计入打分', 'const cy = count([');
hasIn(evLines, 'AJ5 canary 输出到 scored', 'canary: (() => {');
has('AJ6 GATE_CANARY_POLICY 常量', 'const CANARY_POLICY = (process.env.GATE_CANARY_POLICY');
has('AJ7 canary 失败 503 原因', "'canary_mismatch'");
has('AJ8 assurance 按协议取证据', 'const protoEvidence = proto === ');
has('AJ9 unknown 不拦（三态）', "protoEvidence === undefined ? 'unknown'");
has('AJ10 health 暴露 canaryPolicy', 'canaryPolicy: CANARY_POLICY');

// ===== 2026-11-05：EV14/EV15 文本级判据 + 漂移告警 =====
console.log('\n=== AK. 文本级判据 / 漂移告警 ===');
hasIn(evLines, 'AK1 EV14 假模型探针', "add('EV14'");
hasIn(evLines, 'AK2 EV14 三协议', "['responses', '/v1/responses'");
hasIn(evLines, 'AK3 EV15 边界探针', "add('EV15'");
hasIn(evLines, 'AK4 官方名单文案正则', 'The supported API model names are');
hasIn(evLines, 'AK5 中转包装前缀正则', 'Upstream request failed');
hasIn(evLines, 'AK6 validate 结构化输出', 'const validate = (() => {');
hasIn(evLines, 'AK7 unknown 语义（没跑过）', "ran.length === 0 ? 'unknown'");
hasIn(evLines, 'AK8 L0-1 记录模型集合', '{ models: modelIds }');
hasIn(cliLines, 'AK9 漂移检测函数', 'function detectDrift');
hasIn(cliLines, 'AK10 翻转告警类型', "'VALIDATOR_FLIP'");
hasIn(cliLines, 'AK11 模型漂移告警类型', "'MODEL_SET_DRIFT'");
hasIn(lines, 'AK12 msg_hex 形态识别', "return 'msg_hex'");
hasIn(lines, 'AK13 health 暴露 validate', 'validate: ev.validate || null');

// ===== 2026-11-05：审计修复（health 语义 / 声明长度闸 / 测试套件鉴权）=====
console.log('\n=== AL. 审计修复回归 ===');
hasIn(lines, 'AL1 health 暴露 respShapeStrict', 'respShapeStrict: RESP_SHAPE_STRICT');
hasIn(lines, 'AL2 health 暴露有效白名单', 'deliverableShapesEffective');
has('AL3 有效白名单按 strict 过滤 resp_', "filter(s => !(RESP_SHAPE_STRICT && s === 'resp_'))");
hasIn(lines, 'AL4 health 矩阵 TTL 改名（同名不同义）', 'matrixTtlMs: PROBE_TTL');
hasNot('AL5 health 不再用含糊的 ttl 字段', 'probe: USE_PROBE, ttl: PROBE_TTL');
hasIn(lines, 'AL6 usage 必需键按剖面给出', 'usageKeysRequired: USAGE_KEYS_BY_PROFILE[lastUpstreamProfile]');
hasIn(lines, 'AL7 usage 键集按剖面全量暴露', 'usageKeysByProfile: { official: OFFICIAL_USAGE_KEYS');
hasIn(lines, 'AL8 台账改名 precheckTrust（不再冒用 proofTrust）', 'precheckTrust: dgate.trust');
hasNot('AL9 台账不再把预检结论写成 proofTrust', 'proofTrust: dgate.trust');
hasIn(lines, 'AL10 声明长度先拒（不等 body）', 'declaredLen > MAX_BODY');
hasIn(lines, 'AL11 413 带 declared 标记', 'declared: !!declared');
has('AL12 413 收口到单一出口', 'const tooLarge = (bodySize, declared) => {');
hasOrder('AL13 声明长度检查早于读 body', 'declaredLen > MAX_BODY', 'for await (const c of req)');
const riskLines = fs.readFileSync(path.join(import.meta.dirname, 'test-risk.mjs'), 'utf8').split('\n');
hasIn(riskLines, 'AL14 风险套件携带 x-gate-token', "x-gate-token");
hasNot('AL15 风险套件不再用展开求最大值（会爆栈）', 'Math.max(...samples)');
hasIn(riskLines, 'AL16 风险套件首请求失败即中止', "if (r1.status !== 200)");
hasIn(riskLines, 'AL17 风险套件按 health 读上限', 'h0?.bodyLimit?.maxBodyBytes');
hasIn(riskLines, 'AL18 风险套件覆盖声明长度攻击', 'declaredOnly(');
const covLines = fs.readFileSync(path.join(import.meta.dirname, 'test-coverage.mjs'), 'utf8').split('\n');
hasIn(covLines, 'AL19 测试台账写入 logs/tests/', "path.join(import.meta.dirname, 'logs', 'tests')");
hasNotIn(covLines, 'AL20 测试不再改写生产 matrix.json', "path.join(import.meta.dirname, 'logs', 'matrix.json')");
hasIn(lines, 'AL21 轮转落在台账自己目录', 'const rotDir = path.dirname(LOG_FILE);');
hasIn(lines, 'AL22 轮转用台账自己的前缀', 'pruneRotated(rotDir, prefix)');
hasNot('AL23 轮转不再写死共享 LOG_DIR', 'path.join(LOG_DIR, `gate-${Date.now()}.jsonl`)');

// ===== 2026-11-05：证据过期自愈 / canary skipped 语义 / 拦截者可见（16:26 全站 503 事故） =====
console.log('\n=== AM. 证据自愈与 canary 语义 ===');
has('AM1 布尔开关统一解析（不再 ===\'1\'）', 'function flag(name, def)');
has('AM2 自愈开关可关（测试/排障）', "flag('GATE_EVIDENCE_AUTO_REFRESH', true)");
hasIn(lines, 'AM3 自愈冷却可配', "num('GATE_EVIDENCE_REFRESH_MIN_MS'");
hasIn(lines, 'AM4 后台刷新函数存在', 'function refreshEvidenceInBackground(why)');
hasIn(lines, 'AM5 自愈不 spawn 子进程（同进程复用探针）', 'runEvidence({ host: HOST, port: HOST_PORT');
hasIn(lines, 'AM6 刷新每个周期只跑一个', 'if (evRefresh.inflight) return false;');
hasIn(lines, 'AM7 刷新成功写回快照', 'writeEvidenceSnapshot(EVIDENCE_FILE, scored)');
hasIn(lines, 'AM8 刷新失败留台账', "result: 'EVIDENCE_REFRESH_FAIL'");
// 2026-11-07：AM9 的字面量随「负结论也重采」一起改了。原式只认 stale，
// 导致 fresh+canary=false 会死锁满 EVIDENCE_MAX_AGE_MS（实测 04:40 ENOTFOUND 采到 0/10，
// 37 分钟内全站 503 且不重采）。现在同时认 stale 与 negative。
hasIn(lines, 'AM9 判定 stale 时触发自愈', "refreshEvidenceInBackground(!fresh ? (evA ? 'stale' : 'missing') : 'negative')");
hasIn(lines, 'AM9b 负结论（canary 未通过）也触发后台重采', 'canaryNegForRefresh');
hasIn(lines, 'AM9c 目标即官方时不重采（避免官方直连自打死）', "evA.canary.skippedReason !== 'official_target'");
// 2026-11-07：canary 采集失败必须与"不一致"分开（本次事故根因：两侧 null≠null 被判 mismatch）
hasIn(evLines, 'AM9d canary 采集不足记为 collect_error 而非 mismatch', "skippedReason: 'collect_error'");
hasIn(evLines, 'AM10 skipped 必须带原因', "skippedReason: e13?.skipped ? (e13.skippedReason || 'legacy_unknown') : null");
hasIn(lines, 'AM11 缺基线不等于通过', "const canarySkippedOfficial = canarySkipReason === 'official_target';");
hasIn(lines, 'AM12 报文点明拦截者', "proto, blocked_by: blockedBy, reason: why,");
hasIn(lines, 'AM13 报文声明可重试与补刷', "refresh_started: refreshStarted,");
// 2026-11-07：同上，x-gate-refresh 也改走 extraHeaders（原来被 writeHead 覆盖，客户端看不到"正在补刷"）
hasIn(lines, 'AM14 补刷中回 x-gate-refresh', "x-gate-refresh': 'started'");
hasIn(lines, 'AM15 health 暴露刷新状态', 'lastAt: evRefresh.at || null, lastWhy: evRefresh.lastWhy');
hasIn(lines, 'AM16 health 暴露 maxAgeMs', 'maxAgeMs: EVIDENCE_MAX_AGE_MS');
hasIn(lines, 'AM17 health 暴露 canary 跳过原因', "skippedReason: ev.canary.skippedReason || (ev.canary.skipped ? 'legacy_unknown' : null)");
hasIn(evLines, 'AM18 EV13 记录官方目标跳过', "skippedReason: isOfficial ? 'official_target' : 'no_baseline_key'");
hasIn(evLines, 'AM19 runEvidence 支持快路径', 'const fast = !!o.fast;');
hasIn(evLines, 'AM20 快路径跳过 EV7/EV8（生成型）', "add('EV7', false, 'skipped（fast refresh");
hasIn(evLines, 'AM21 快路径跳过 EV10（最贵的一段）', "add('EV10', false, 'skipped（fast refresh：分词比对太慢）'");
hasIn(evLines, 'AM22 canary 采样数可配', 'const canaryN = Number.isFinite(Number(o.canaryN))');
hasIn(evLines, 'AM23 canary 阈值随采样数缩放', 'const needN = Math.max(1, Math.ceil(canaryN * 0.9));');
hasIn(lines, 'AM24 门控自愈走快路径', 'fast: true, canaryN: EVIDENCE_REFRESH_CANARY_N');
hasIn(lines, 'AM25 自愈 canary 采样可配', "num('GATE_EVIDENCE_REFRESH_CANARY_N', 4");

// ===== 2026-11-05 阶段一：异常归类 + 分段计时 =====
console.log('\n=== AN. 异常归类与分段计时 ===');
hasIn(lines, 'AN1 客户端中止单独归类', "result: 'CLIENT_ABORTED'");
hasIn(lines, 'AN2 AbortError 判定', "e?.name === 'AbortError'");
hasIn(lines, 'AN3 中止判定先于 HANDLER_ERROR', 'if (aborted) {');
hasOrder('AN4 中止分支早于 500 兜底', "result: 'CLIENT_ABORTED'", "type: 'gate_handler_error'");
hasIn(lines, 'AN5 分段统计结构存在', 'const phaseStats = { precheck: [], upstream: [], gate: [], stream: [], ttfb: [], total: [] };');
hasIn(lines, 'AN6 分段采样有界', 'if (a.length > PHASE_KEEP) a.shift();');
hasIn(lines, 'AN7 四段时间戳', 'const tPhase = { precheckDone: 0, upstreamDone: 0, headersAt: 0 };');
hasIn(lines, 'AN8 预检落定打点', 'tPhase.precheckDone = Date.now();');
hasIn(lines, 'AN9 上游响应打点', 'tPhase.upstreamDone = Date.now();');
hasIn(lines, 'AN10 写完响应头打点', 'tPhase.headersAt = Date.now();');
hasIn(lines, 'AN11 PASS 台账带 phase', 'phase: phaseSnap(), elapsedMs: Date.now() - startedAt');
hasIn(lines, 'AN12 finish/close 采样回传段', "res.once('finish', () => { if (tPhase.headersAt) notePhase(phaseSnap()); });");
hasIn(lines, 'AN12b 重发不重复采样', 'if (!res.__phaseNoted) {');
hasIn(lines, 'AN13 health 暴露分段分位', 'phase: phaseView(),');
hasIn(lines, 'AN14 分位计算只取近 PHASE_KEEP 条', 'const PHASE_KEEP = 300;');

// ===== 2026-11-06：429 三分类 + 不可达要确证 =====
console.log('\n=== AQ. 429 归因与不可达判定 ===');
hasIn(lines, 'AQ1 容量快速失败开关', "flag('GATE_CAPACITY_FAILFAST', true)");
hasIn(lines, 'AQ1b 容量重试次数可配（默认 1，实测救回过）', "num('GATE_CAPACITY_RETRY', 1, { min: 0, max: 8 })");
hasIn(lines, 'AQ1c 容量重试留痕', "result: 'UPSTREAM_CAPACITY_RETRY'");
hasIn(lines, 'AQ2 容量特征识别', 'const CAPACITY_RE = /prefill_cap_refused|cell is at capacity/i;');
hasIn(lines, 'AQ3 容量识别只读 upstream 体前 2000 字', "capacityRefused = (r) => CAPACITY_RE.test(String(r?.passthrough?.body || '').slice(0, 2000));");
hasIn(lines, 'AQ4 容量分支独立 type', "type: 'gate_upstream_capacity'");
hasIn(lines, 'AQ5 容量分支有独立出口', "'x-gate-reason': whyCap,");
hasIn(lines, 'AQ6 等待超限与重试用尽分流', "const why = wait > RATE_LIMIT_MAX_WAIT_MS ? 'wait_exceeded' : 'retries_exhausted';");
hasIn(lines, 'AQ7 重试用尽有独立 type', "'gate_upstream_rate_limited_retries'");
hasIn(lines, 'AQ8 响应头区分原因', "'x-gate-reason': why,");
hasIn(lines, 'AQ9 曾收到响应即记录车道', 'if (r && r.status) sawHttpLanes.add(m);');
hasIn(lines, 'AQ10 不可达排除曾响应的车道', 'const realFails = [...connFailedLanes].filter(m => !sawHttpLanes.has(m));');
hasIn(lines, 'AQ11 有响应但太慢单独归类', ': slowTail ? \'gate_upstream_slow\'');
hasIn(lines, 'AQ12 台账记录 sawHttp', 'exhausted, sawHttp,');
hasIn(lines, 'AQ13 health 暴露 429 归因', 'rateLimitBreakdown: {');
hasIn(lines, 'AQ14 空 if 死代码已删（只剩一个真分支）', 'if (!candidates.length) {', { count: 1 });
hasIn(lines, 'AQ15 计数初始化', 'capacityRefused: 0, capacityRetried: 0, upstreamSlow: 0,');
hasIn(lines, 'AQ16 429 语义分类器（capacity/overloaded/other）', "const rateLimitClass = (r) => {");
hasIn(lines, 'AQ17 overloaded 特征', 'const OVERLOAD_RE = /\\[overloaded\\]|server is overloaded/i;');
hasIn(lines, 'AQ18 台账记录 429 分类', 'cls: rlCls, upstream:');
hasIn(lines, 'AQ19 health 暴露 429 分类分布', 'byClass: metrics.rlClass || {} },');
hasIn(lines, 'AQ20 分类计数初始化', 'rlClass: { capacity: 0, overloaded: 0, other: 0 },');
hasIn(lines, 'AQ21 容量等待上限独立可配', "num('GATE_CAPACITY_MAX_WAIT_MS', 35000, { min: 0, max: 120000 })");
hasIn(lines, 'AQ22 容量等待受剩余预算约束', 'const roomForWait = remainMs() - MIN_UPSTREAM_BUDGET_MS - 2000;');
hasIn(lines, 'AQ23 容量分支两种放弃原因分流', "const whyCap = !canWait ? 'capacity_wait_exceeded' : 'capacity_retries_exhausted';");
hasIn(lines, 'AQ24 容量等待超限文案不再说重试次数', '它要求等待 ${Math.ceil(wait / 1000)}s');

// ===== 2026-11-05 阶段二：车道级预检 + 判负即切换 =====
console.log('\n=== AO. 车道级预检与判负即切换 ===');
hasIn(lines, 'AO1 precheck 支持 lane 参数', "const lane = String(opts.lane || '');");
hasIn(lines, 'AO2 预检缓存 key 带车道', "const ckey = lane ? proto + '@' + lane : proto;");
hasIn(lines, 'AO3 形态探针按车道取 model', 'const probeModel = lane || ALLOWED[0];');
hasIn(lines, 'AO4 车道级预检编排函数', 'async function precheckLanes(proto, lanes) {');
hasIn(lines, 'AO5 单车道退化（零回归）', 'if (!PERLANE_PRECHECK || list.length <= 1) {');
hasIn(lines, 'AO6 聚合：任一 pass 即整体 pass', "const verdict = passCount > 0 ? 'pass'");
hasIn(lines, 'AO7 交付闸按赢下车道判定', 'const lanePc = dgate.byLane && typeof dgate.byLane.get ===');
hasIn(lines, 'AO8 pgate 携带逐车道结论', 'pgate.byLane = laneBox.byLane;');
hasIn(lines, 'AO8b 逐车道结论不额外 await（零新增延迟）', 'const laneBox = { byLane: null };');
hasIn(lines, 'AO9 开关可关（回退旧行为）', "flag('GATE_PERLANE_PRECHECK', true)");
hasIn(lines, 'AO10 探针结论带 lane', "resolve(lane ? { ...o, lane } : o);");
hasIn(lines, 'AO11 保活刷车道级缓存（防 fail 永久锁死）', 'const rl = await precheck(p, { force: true, lane: m });');
hasIn(lines, 'AO12 单车道不额外发探针（探针数不变）', 'if (PERLANE_PRECHECK && ALLOWED.length > 1) {');
hasIn(lines, 'AO13 车道恢复/未恢复均计数', 'metrics.lanePrecheckRecovered = (metrics.lanePrecheckRecovered || 0) + 1;');

// ===== 2026-11-05 判正增强：逐响应骨架证据（键顺序 + server 头）=====
console.log('\n=== AP. 逐响应骨架证据 ===');
hasIn(baseLines, 'AP1 官方顶层键顺序基线（35 键）', 'export const OFFICIAL_TOP_KEY_ORDER = [');
hasIn(baseLines, 'AP2 中转顶层键顺序基线（18 键）', 'export const RELAY_TOP_KEY_ORDER = [');
hasIn(baseLines, 'AP3 server 头基线：官方 openresty', "export const OFFICIAL_SERVER_HEAD = 'openresty';");
hasIn(baseLines, 'AP4 server 头基线：中转 cloudflare', "export const RELAY_SERVER_HEAD = 'cloudflare';");
hasIn(baseLines, 'AP5 顶层键解析器（跳过字符串/嵌套）', 'export function topLevelKeyOrder(text, maxKeys = 0) {');
hasIn(baseLines, 'AP5b 字符串整段跳过（大 body 不逐字符）', "const q = t.indexOf('\"', i)");
hasIn(baseLines, 'AP5c 收集够数即停（限 12 键）', 'if (maxKeys > 0 && out.length >= maxKeys) return out;');
hasIn(baseLines, 'AP6 键序判定按位置集合求 LIS', 'const tails = [];');
hasIn(baseLines, 'AP7 少键不判（防零星匹配）', 'if (ks.length < 10) return \'unknown\';');
hasIn(baseLines, 'AP7b 用 LIS 判顺序（抗条件缺字段）', 'return tails.length / ks.length;');
hasIn(baseLines, 'AP7c 键集覆盖率下限', 'known.length < ks.length * 0.85');
hasIn(baseLines, 'AP7d 官方独有键硬门槛（防 12 键截断假阳）', "hitOfficialOnly >= 3) return 'official';");
hasIn(baseLines, 'AP7e 官方独有键集合', 'export const OFFICIAL_ONLY_KEYS =');
hasNot('AP7g srvKey 不得在 if 块内声明（跨块引用会 ReferenceError）', 'if (proof.server) {');
hasIn(lines, 'AP7f 单车道路径预检失败不炸链', "await precheck(proto).catch(() => ({ verdict: 'unknown', source: 'error'");
hasIn(lines, 'AP8 探针结论合并键序', 'keyOrderVerdict(topLevelKeyOrder(bodyText, KEY_ORDER_SCAN_KEYS))');
hasIn(lines, 'AP8b 流式不判键序（防假告警）', "if (ctype.includes('event-stream')) proof.keyOrder = 'unknown';");
hasIn(lines, 'AP8c server 头归一化（防注入/无界）', "const srvKey = proof.server === OFFICIAL_SERVER_HEAD ? 'official'");
hasIn(lines, 'AP9 官方骨架才升 verified', "if (proof.keyOrder === 'official' && officialLike) proof.level = 'verified';");
hasIn(lines, 'AP10 中转骨架/头判 unverified', "else if (proof.keyOrder === 'relay' || relayLike) proof.level = 'unverified';");
hasIn(lines, 'AP11 两边都不像保持 unknown（不误杀）', "else if (proof.keyOrder === 'unknown' && !officialLike) proof.level = 'unknown';");
hasIn(lines, 'AP12 伪装升级告警', "pushAlert('RELAY_MIMICS_OFFICIAL'");
hasIn(lines, 'AP13 伪装计数', 'metrics.relayMimicsOfficial = (metrics.relayMimicsOfficial || 0) + 1;');
hasIn(lines, 'AP14 health 暴露键序分布', 'keyOrder: metrics.keyOrder, server: metrics.proofServer,');
hasIn(lines, 'AP15 台账带逐响应证明明细', 'proofEvidence: r.proof || null');

// ===== 2026-11-07：上游调价 + 实现向量漂移 + 无证据重试 + 告警去重 =====
// 全部由实测事故驱动，断言只钉「行为不变量」，不钉具体数值。
console.log('\n=== AQ. 2026-11-07 修复回归 ===');
// 计费倍率：单价会在 1×/2× 之间整段切换，必须用集合而不是常数
hasIn(baseLines, 'AQ1 计费单价常量仍单源在 baseline', 'export const BILLING =');
has('AQ2 计费倍率用允许集合', 'const BILLING_MUL_KNOWN = [1, 2];');
has('AQ3 billingMuls 未知模型返回 null', "if (s.includes('flash') || s.includes('v4.1')) return BILLING_MUL_KNOWN;");
hasNot('AQ4 旧的单一倍率（v4.1 先命中 return 2）已移除', "if (s.includes('v4.1')) return 2;");
hasNot('AQ4b 不再有 billingMul 单数调用', 'billingMul(');
has('AQ5 计费命中允许集合才算通过', 'const hit = muls.find(m => Math.abs(o.list_cost - m * base) <= Math.max(tol, 1e-3 * m * base));');
has('AQ6 观测倍率进 metrics（误报变遥测）', 'else metrics.billingMul = hit;');
has('AQ7 集合外仍判失败', "if (hit === undefined) billFail('billingCost');");
// 实现向量：只比稳定前缀
hasIn(baseLines, 'AQ8 实现向量稳定前缀基线', 'export const IMPL_VECTOR_STABLE =');
has('AQ9 只比稳定位（不再整串比较）', "const stableHead = vec.split(',').slice(0, IMPL_VECTOR_STABLE.length).join(',');");
hasNot('AQ10 整串比较已移除', 'vec !== IMPL_VECTOR_2026_10_27');
// 无证据重试：只重试 net/rate，不重试 fail/format/drift
has('AQ11 无证据重试开关', "num('GATE_PRECHECK_NOEVID_RETRY', 1,");
has('AQ12 只对 net/rate/timeout 重试', "const NO_EVIDENCE = new Set(['net', 'rate', 'timeout']);");
has('AQ13 重试用放宽后的上限', 'const wider = Math.min(PROBE_DEADLINE_MAX, Math.max(probeDeadlineMs(), deadlineAtStart * 2));');
has('AQ14 重试仍走同一聚合（判据不变）', 'const retryAgg = evalAgg(retryResults);');
has('AQ15 形态探针上限可被放宽', 'const deadline = deadlineOverrideMs > 0 ? deadlineOverrideMs : probeDeadlineMs();');
// 告警去重
has('AQ16 告警连续同条去重', 'if (sig === lastPushedAlertSig) {');
has('AQ17 去重计数', 'metrics.alertsDeduped = (metrics.alertsDeduped || 0) + 1;');
// 官方性探针的 fail-open 修复（探针自身也要 fail-closed）
hasIn(probeLines, 'AQ18 探针无 pass 时不给 full/high', 'else if (pass >= 1 && pass >= total - 1)');
hasIn(probeLines, 'AQ19 探针无判据时 trust=none', "if (!total) { verdict = 'unknown'; trust = 'none'; }");
hasNotIn(probeLines, 'AQ20 探针不再 import 已改名的 E_SERDE_EXTRAS', 'E_SERDE_EXTRAS,');

// ===== 2026-11-08：客户端取消归类 + 探针错误分类 + 封禁协议告警 + 缓存块不重发 =====
// 全部由 11-08 当日台账驱动（14:28:45 / 15:00:53 的 CLIENT_ABORTED 被记成不可达；
// 04:24:26 全 ERR 向量被记成漂移；04:29:24 messages 降级告警；cacheBlockMisaligned 白重发）。
console.log('\n=== AR. 2026-11-08 修复回归 ===');
// 客户端取消：终局必须先判「客户端已断开」，不能落进 unreachable/blocked 分支
has('AR1 终局先判客户端断开', 'if (clientGone.signal.aborted || res.destroyed) {', { count: 4 });
has('AR2 取消留痕带 stage=terminal', "result: 'CLIENT_ABORTED', stage: 'terminal',", { count: 1 });
hasOrder('AR3 取消判定早于终局归类',
  "stage: 'terminal'", '// 拒绝原因必须区分开，否则客户端无法判断');
has('AR3b 取消留痕覆盖四个收敛点', "stage: 'probe'");
has('AR3c 取消留痕覆盖 hedge', "stage: 'hedge'");
has('AR3d 取消留痕覆盖主循环', "stage: 'main-loop'");
has('AR4 真实的不可达日志仍在（没被顺手删掉）', "result: 'UPSTREAM_UNREACHABLE'");
// 实现向量：稳定位 ERR = 探针没问到，不是漂移
has('AR5 稳定位 ERR 归为探针错误', "const probeErr = stableHead.split(',').includes('ERR');", { count: 1 });
has('AR6 探针错误单独计数', 'metrics.implVectorProbeErr = (metrics.implVectorProbeErr || 0) + 1;', { count: 1 });
has('AR7 探针错误不推 DRIFT 告警', "result: 'IMPL_VECTOR_PROBE_ERR'", { count: 1 });
has('AR8 DRIFT 告警仍保留给真实变化', "pushAlert('IMPL_VECTOR_DRIFT'");
// 封禁协议不推 ALL_LANES_DEGRADED
has('AR9 封禁协议跳过降级告警', 'if (BLOCKED_PROTOS.has(p)) { lastAlertSig.delete(p); continue; }', { count: 1 });
has('AR10 降级告警仍覆盖 responses', "pushAlert('ALL_LANES_DEGRADED'");
// 缓存块不符不重发
has('AR11 cacheBlockMisaligned 不参与重发', "const retryable = !miss.includes('cacheBlockMisaligned');", { count: 1 });
has('AR12 跳过重发有台账记录', "result: 'FP_RETRY_SKIP'", { count: 1 });
has('AR13 跳过重发有计数', 'metrics.fpRetrySkippedCache = (metrics.fpRetrySkippedCache || 0) + 1;', { count: 1 });
has('AR14 重发条件包含 retryable', 'if (fpRetriesLeft > 0 && remainMs() > 3000 && !tooBig && retryable) {', { count: 1 });

// ===== 2026-11-08（二）：流式等头 watchdog + phase 双口径 =====
// 14:28 实测：流式请求 108s 没有返回任何响应头，一直占着 MAX_CONC 槽位到 120s。
console.log('\n=== AS. 2026-11-08 P2 回归 ===');
has('AS1 等头 watchdog 可配（默认 30s）', "num('GATE_UPSTREAM_HEADERS_TIMEOUT_MS', 30000, { min: 0, max: 600000 })");
has('AS2 watchdog 只对流式生效', 'if (body && body.stream === true && UPSTREAM_HEADERS_TIMEOUT_MS > 0) {', { count: 1 });
has('AS3 等头超时有台账', "result: 'ATTEMPT_HEADERS_TIMEOUT'", { count: 1 });
has('AS4 响应头到达即清除 watchdog', 'if (headersTimer) { try { clearTimeout(headersTimer); } catch {} headersTimer = null; }', { count: 2 });
has('AS5 settle 同时清硬上限与等头计时', 'if (headersTimer) { try { clearTimeout(headersTimer); } catch {} headersTimer = null; }');
has('AS6 phase 统计包含 ttfb', 'const phaseStats = { precheck: [], upstream: [], gate: [], stream: [], ttfb: [], total: [] };');
has('AS7 health 暴露 ttfbMs 分位', 'ttfbMs:     { p50: pctOf(phaseStats.ttfb, 0.5),     p90: pctOf(phaseStats.ttfb, 0.9) },');
has('AS8 台账 phase 带 ttfbMs', 'ttfbMs: tPhase.headersAt ? tPhase.headersAt - startedAt : Date.now() - startedAt,');
has('AS9 非流式不套用等头阈值（注释固定语义）', '**只对流式生效**');

// ===== 2026-11-08（三）：探测驱动三段状态机 + 活动门控 + sentinel =====
console.log('\n=== AT. 2026-11-08 结构性升级回归 ===');
has('AT1 状态机开关', "flag('GATE_PROBE_ADAPTIVE', true)");
has('AT2 严格拒绝开关', "flag('GATE_STRICT_REJECT', true)");
has('AT3 活动门控窗口', "num('GATE_PROBE_ACTIVE_WINDOW_MS', 600000,");
has('AT4 可疑/确认探测间隔', "num('GATE_PROBE_MS_SUSPECT', 90000,");
has('AT5 sentinel 条数', "num('GATE_SENTINEL_N', 3,");
has('AT6 连续判负阈值', "num('GATE_CONFIRM_ON', 2,");
has('AT7 状态对象存在', "const PROBE_STATE = { state: 'normal', driftStreak: 0, goodStreak: 0, sentinelLeft: 0,");
has('AT8 判负升级 confirm', "if (PROBE_STATE.driftStreak >= CONFIRM_ON) {");
has('AT9 连续 good 恢复', "PROBE_STATE.goodStreak >= 2 && confirmElapsed");
has('AT10 sentinel 只在 suspect 生效', "const sentinelBuffer = PROBE_ADAPTIVE && PROBE_STATE.state === 'suspect' && PROBE_STATE.sentinelLeft > 0;");
has('AT11 sentinel 递减', "PROBE_STATE.sentinelLeft = Math.max(0, PROBE_STATE.sentinelLeft - 1);");
has('AT12 业务格判负立即确认', "noteSentinelNegative('sentinel_cache_block')");
has('AT13 CONFIRM 直接 503', "type: 'gate_cache_semantics',");
has('AT14 活动门控跳过探测', "const idle = PROBE_ACTIVE_WINDOW_MS > 0");
has('AT15 空闲跳过有台账', "reason: 'idle',");
has('AT16 业务活跃度打点', 'if (isProxy) noteBusinessActivity();');
has('AT17 health 暴露状态机', 'probeControl: {');
has('AT18 定时器改为状态机调度', 'scheduleCacheProbe(Math.min(12000, probeIntervalMs()));');
hasNot('AT19 不再用固定 setInterval 跑缓存探针', "setInterval(() => { runCacheProbe().catch(() => {}); }, CACHE_PROBE_MS)");

// ===== 2026-11-08（四）：messages 备选通道（dsh 第二个模型）=====
console.log('\n=== AU. messages 备选通道回归 ===');
has('AU1 备选通道默认关闭', "flag('GATE_MSG_PROVIDER', false)");
has('AU2 messages 可交付形态集合', "const MSG_DELIVERABLE_SHAPES = new Set(['msg_hex', 'other', 'HEX32', 'UUID4', 'UUID']);");
has('AU3 third 分支按预检 pass 放行', 'MSG_PROVIDER && proto === \'messages\'');
has('AU4 交付留痕 MSG_PROVIDER_DELIVER', "result: 'MSG_PROVIDER_DELIVER'", { count: 2 });
has('AU5 health 暴露 msgProvider', 'msgProvider: {');
has('AU6 messages 路径仍受 GATE_ALLOW_MESSAGES 控制', "process.env.GATE_ALLOW_MESSAGES === '1' ? [] : ['messages']");
has('AU7 备选通道不刷 ALL_LANES_DEGRADED', "if (p === 'messages' && MSG_PROVIDER) { lastAlertSig.delete(p); continue; }");

// ===== 2026-11-08（五）：messages 官方文案判据 + 缓存块 =====
console.log('\n=== AV. messages 官方文案判据回归 ===');
has('AV1 官方文案判据开关', "flag('GATE_MSG_OFFICIAL_TEXT', true)");
has('AV2 m1 官方 max_tokens 文案', "m1: { code: 400, re: /Invalid max_tokens value, the valid range of max_tokens is \\[1, 393216\\]/ }");
has('AV3 m7 官方反序列化文案', "m7: { code: 422, re: /Failed to deserialize the JSON body into the target type: messages\\[0\\]\\.role: unknown variant `wizard`");
has('AV4 request_id 必须是 UUID4', 'const MSG_REQ_ID_RE = /\\(request_id:\\s*[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\)/i;');
has('AV5 网关包装一律拒绝', 'const MSG_GATEWAY_WRAP_RE = /Upstream request failed|\\bgw-[0-9a-z]/i;');
has('AV6 预检改用官方文案探针', "if (MSG_PROVIDER && MSG_OFFICIAL_TEXT) return runMsgOfficialText().then(r => [r]);");
has('AV7 文案探针带 body', 'function msgTextProbe(p) {');
has('AV8 messages 缓存块判据', 'function msgCacheMisaligned(r) {');
has('AV9 缓存块不符 503', "type: 'gate_msg_cache_block'");
has('AV10 health 暴露 officialText', 'officialText: MSG_OFFICIAL_TEXT,');

// ===== 2026-11-08（六）：m10 随机回声 + 信封评分 + 流式缓存跳过 =====
console.log('\n=== AW. messages 动态回声与信封评分回归 ===');
has('AW1 随机 role 前缀', "const MSG_ECHO_PREFIX = 'wizard_';");
has('AW2 探针限并发 3', 'runPool(probes, 3, msgTextProbeRetry)');
has('AW3 5xx/429 重试一次', 'await sleepMs(350);');
has('AW4 m10 必须回显本次随机串', 'body.includes(echo)');
has('AW5 m10 期望 422', "r.code === 422 && body.includes(echo)");
has('AW6 信封评分 official/relay', "function msgEnvelopeOf(r) {");
has('AW7 health 暴露信封计数', 'envelopeOfficial: metrics.msgEnvelopeOfficial || 0,');
has('AW8 流式跳过缓存块检查', 'if (r.stream) return null;');
has('AW9 pass 明细带 echo ok', "'official-text ✓ (10/10, echo ok)'");

// ===== 2026-11-08（七）：messages 可用性指示器 =====
console.log('\n=== AX. messages 可用性指示器回归 ===');
has('AX1 状态对象', 'const MSG_STATUS = {');
has('AX2 Tier0 单条回声探针', 'async function runMsgEchoProbe() {');
has('AX3 Tier0 失败即不可用', "state: net ? 'unknown' : 'unusable'");
has('AX4 Tier0 通过后跑全量', 'const full = await runMsgOfficialText();');
has('AX5 /gate/msg-status 端点', "req.url.startsWith('/gate/msg-status')");
has('AX6 刷新需要 token', '刷新 messages 状态需要 x-gate-token。');
has('AX7 后台 5 分钟调度', "num('GATE_MSG_STATUS_MS', 300000,");
has('AX8 空闲跳过', "result: 'MSG_STATUS_SKIP', reason: 'idle'");
has('AX9 health 暴露 msgStatus', 'msgStatus: msgStatusView(),');

console.log(`\n===== 合计：${pass} 通过 / ${fail} 失败 =====`);
if (failures.length) { console.log('\n未通过项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
