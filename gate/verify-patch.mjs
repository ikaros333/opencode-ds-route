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
has('E5 rate-limit', "type: 'gate_upstream_rate_limited'");
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
has('G2 res.close 触发 abort', "if (!res.writableEnded) { metrics.abortedByClient++; try { clientGone.abort(); }");
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
has('L3b 单例引用清理', 'precheckInflight.get(proto) === run');
has('L4 预检结果缓存（按协议）', 'precheckLastByProto = new Map()');
has('L4b 按协议读取预检结论', 'precheckLastFor = (p) =>');
has('L5 综合信任判定（带协议）', 'async function trustDecision(precheckPromise, proto');
has('L6 预检失败由 proof 兜底', 'proof_over_precheck_fail');
has('L7 预检通过跳过车道探测', 'probeSkippedByPrecheck');
has('L8 预检与真实请求并行启动', 'const precheckP = PRECHECK_ENABLE ? precheck(proto)');
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
has('L21g retry-after 区分', "'retry-after': unreachable ? '10' : '20'");
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
// P1-2：所有上游请求必须走 transport（probe / realRequest / 形态探针 / 实现向量探针 / 3 个预检 = 7）
has('P1-2 上游请求统一走 transport', 'const req = transport.request(', { count: 7 });
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
has('Q77 resp_bad 不在可交付白名单', "'resp_bad'", { count: 1 });
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
has('X5 serde 伴生特征参与判定', 'c.expectExtra.every(re => re.test(msg))');
has('X5b request_id 证据永久失效后不再强制 UUID4', 'requestIdUuid: false');
hasIn(baseLines, 'X6 baseline 定义类型层 serde 判据', 'export const E_SERDE_TYPE_MSG =');
hasIn(baseLines, 'X7 baseline 留档 messages 漂移指纹', 'export const MSG_FINGERPRINT_2026_10_27');
hasIn(baseLines, 'X8 旧枚举判据标记退役', '已退役（2026-10-27 晚间）');

// ===== 2026-10-27 判据冻结版：只依赖"实测 100% 稳定"的特征 =====
// 背景：参数校验类探针会随上游实现池轮询而抖（同一条探针 422↔200），拿它放行 = 随机 503。
// 冻结后 responses 只用形态探针（id 位模式 38/38 + usage 键集 20/20），
// 参数探针降级为"实现指纹向量"，只告警不放行。
console.log('\n=== Y. 判据冻结版（形态探针 + 结构闸 + 信任分级）===');
has('Y1 形态探针存在', 'function runShapeProbe()');
has('Y2 responses 走形态策略', "responses: 'shape',");
has('Y3 形态判据校验 usage 键集', 'USAGE_KEYS_REQUIRED.filter(k => !(k in usage))');
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
has('Z4 指纹函数存在（含请求侧条件校验）', 'function fingerprint(body, reqBody)');
has('Z4b reasoning 条件回显校验', "bad.push('reasoningEcho')");
has('Z5 六项结构检查齐全', "bad.push('arithmetic')");
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

console.log(`\n===== 合计：${pass} 通过 / ${fail} 失败 =====`);
if (failures.length) { console.log('\n未通过项：'); failures.forEach(f => console.log('  - ' + f)); }
process.exit(fail === 0 ? 0 : 1);
