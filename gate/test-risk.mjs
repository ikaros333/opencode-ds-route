// 风险/健壮性测试：冷启动、soak、超限、声明长度攻击
// 用法：node test-risk.mjs <port>
//   2026-11-05 修复（本条套件在 regress -IncludeSoak 下必红）：
//   1) 旧版 post() 不带 x-gate-token，而生产/影子门控都已启用 GATE_TOKEN → 每个请求 401；
//   2) 401 是毫秒级返回，soak 的 while 循环 60 秒攒出十几万样本，
//      Math.max(...samples) 用展开传参直接 RangeError: Maximum call stack size exceeded；
//   3) 首个请求失败时不中止，导致真正的失败原因被爆栈掩盖。
import path from 'node:path';
import http from 'node:http';

const PORT = Number(process.argv[2] || '8799');
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = process.env.GATE_TOKEN || '';
const HDR = { 'content-type': 'application/json', ...(TOKEN ? { 'x-gate-token': TOKEN } : {}) };
const dir = path.join(import.meta.dirname, 'logs');
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(50)} ${d ?? ''}`); };

const small = () => ({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 });
async function post(body) {
  const t0 = Date.now();
  const r = await fetch(BASE + '/v1/responses', {
    method: 'POST', headers: HDR, body: JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, verdict: r.headers.get('x-gate-result'), fatal: r.headers.get('x-gate-fatal'), body: text, ms: Date.now() - t0 };
}
const health = async () => { try { return JSON.parse(await (await fetch(BASE + '/gate/health')).text()); } catch { return null; } };
const metrics = async () => { try { return JSON.parse(await (await fetch(BASE + '/gate/metrics')).text()); } catch { return null; } };

// 声明长度攻击：只发 Content-Length，一个 body 字节都不发。
// 期望门控立刻 413（而不是挂到 BODY_IDLE_TIMEOUT_MS 才断）。
function declaredOnly(bytes, timeoutMs = 5000) {
  return new Promise((res) => {
    const t0 = Date.now();
    const req = http.request({
      host: '127.0.0.1', port: PORT, method: 'POST', path: '/v1/responses',
      headers: { 'content-type': 'application/json', 'content-length': String(bytes), ...(TOKEN ? { 'x-gate-token': TOKEN } : {}) },
    }, (r) => {
      let d = ''; r.on('data', (c) => d += c);
      r.on('end', () => res({ status: r.statusCode, ms: Date.now() - t0, body: d }));
    });
    req.on('error', (e) => res({ status: 'ERR', ms: Date.now() - t0, body: e.code || e.message }));
    req.setTimeout(timeoutMs, () => { try { req.destroy(); } catch {} res({ status: 'TIMEOUT', ms: Date.now() - t0, body: '' }); });
    req.end(); // 故意不写 body
  });
}

console.log('--- R1 冷启动与热启动 ---');
const t1 = Date.now();
const r1 = await post(small());
const coldMs = Date.now() - t1;
check('R1 首请求成功', r1.status === 200,
  `status=${r1.status} ${coldMs}ms${r1.status === 401 ? '（401：检查 GATE_TOKEN / x-gate-token）' : ''}`);
if (r1.status !== 200) {
  console.log('\n[中止] 首个请求未通过，后续 soak 与延迟结论都无意义。');
  console.log(`\n===== 风险测试：${pass} 通过 / ${fail} 失败 =====`);
  process.exit(1);
}
{
  // 预检并行后延迟抖动变大，用 3 次中位而非单点比较，避免偶发抖动误判
  const hots = [];
  for (let i = 0; i < 3; i++) { const s = Date.now(); await post(small()); hots.push(Date.now() - s); }
  hots.sort((a, b) => a - b);
  const hotMed = hots[1];
  // 2026-11-05：相对判据在「冷启动恰好命中预检缓存」时会误判（实测 cold=1259ms 比热启动还快）。
  // 给它一个 4s 的绝对兜底：既有相对意义（热启动不该显著更慢），又不因冷启动偶发极快而红。
  check('R1 热启动中位不慢于冷启动 1.6 倍（或 ≤4s）', hotMed <= Math.max(coldMs * 1.6, 4000),
    `hotMed=${hotMed}ms hots=${hots.join('/')} cold=${coldMs}ms 阈值=${Math.round(Math.max(coldMs * 1.6, 4000))}ms`);
}

console.log('\n--- R2 soak：60 秒持续请求，观察稳定性 ---');
{
  const samples = [];
  const startInflight = [];
  const t0 = Date.now();
  let n = 0, ok = 0, streak = 0, aborted = false;
  // 上限保护：即使被鉴权/上游问题打成毫秒级失败，也不会把数组撑到爆栈
  while (Date.now() - t0 < 60000 && samples.length < 20000) {
    const r = await post(small());
    n++;
    if (r.status === 200) { ok++; streak = 0; } else {
      streak++;
      if (streak >= 5) { aborted = true; break; }
    }
    samples.push(r.ms);
    if (n % 5 === 0) {
      const m = await metrics();
      if (m) startInflight.push(m.inflight);
    }
  }
  if (aborted) console.log('  [中止] 连续 5 次失败（疑似鉴权或上游故障），不再空转');
  const sum = samples.reduce((a, b) => a + b, 0);
  const avg = samples.length ? Math.round(sum / samples.length) : 0;
  // 不用 Math.max(...samples)：样本过万时展开传参会爆栈（本套件 11-05 就死在这里）
  const max = samples.reduce((a, b) => (b > a ? b : a), 0);
  // 真实上游存在瞬时抖动：40 连发实测 0 失败，但 60 秒长跑偶有 1 次 503。
  // 容忍 ≤1 次；超过才说明是门控自己在下发误杀。
  check('R2 soak 全部成功（容忍 1 次上游抖动）', ok >= n - 1, `ok=${ok}/${n}`);
  check('R2 soak 期间 inflight 未累积', startInflight.every(x => x === 0), `inflight样本=${startInflight.join(',')}`);
  // 真实上游会偶发抖动（实测有一次 9.4s，门控靠同车道重试救回）；用绝对上限而非倍数判断
  const sorted = [...samples].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] || 0;
  check('R2 延迟 p95 正常（< 平均×4）', p95 < avg * 4, `avg=${avg}ms p95=${p95}ms max=${max}ms`);
  check('R2 无请求超过门控超时上限', max < 60000, `max=${max}ms`);
}

console.log('\n--- R3 超过请求体上限（应 413 且不崩溃） ---');
{
  // 上限从 health 读，不写死 16MB：生产已调 24MiB，写死会让这条用例在两种部署下结论相反
  const h0 = await health();
  const limit = Number(h0?.bodyLimit?.maxBodyBytes) || 16 * 1024 * 1024;
  const overBytes = limit + 1024 * 1024;
  const pad = 'x'.repeat(overBytes);
  const big = { model: 'deepseek-flash', input: pad, max_output_tokens: 8 };
  const t0 = Date.now();
  const r = await post(big);
  check(`R3 超上限 ${(overBytes / 1048576).toFixed(1)}MB 返回 413`, r.status === 413, `status=${r.status} 用时=${Date.now() - t0}ms`);
  check('R3 413 带 x-gate-fatal（重试无意义）', r.fatal === '1', `fatal=${r.fatal}`);
  const h = await health();
  check('R3 超大体积后门控仍健康', !!h?.ok, `ok=${h?.ok}`);
  const after = await post(small());
  check('R3 超大体积后正常请求仍成功', after.status === 200, `status=${after.status}`);
}

console.log('\n--- R3b 声明长度攻击：只发 Content-Length，不发 body ---');
{
  const h0 = await health();
  const limit = Number(h0?.bodyLimit?.maxBodyBytes) || 16 * 1024 * 1024;
  const r = await declaredOnly(limit * 4);
  check('R3b 声明超限立即 413（不等 body）', r.status === 413, `status=${r.status} 用时=${r.ms}ms`);
  check('R3b 413 在 3 秒内返回（不挂在 body 空闲超时上）', r.ms < 3000, `ms=${r.ms}`);
  const h = await health();
  check('R3b 攻击后门控仍健康', !!h?.ok, `ok=${h?.ok}`);
  const m = await metrics();
  check('R3b 槽位未泄漏（inflight=0）', m?.inflight === 0, `inflight=${m?.inflight}`);
}

console.log('\n--- R4 指标合理性 ---');
{
  const m = await metrics();
  check('R4 inflight 归零', m?.inflight === 0, `inflight=${m?.inflight}`);
  check('R4 无异常 blocked 暴涨（< 总请求 30%）', m.blocked < m.requests * 0.3,
    `blocked=${m.blocked} requests=${m.requests}`);
  check('R4 abortedByClient 非负整数', Number.isInteger(m.abortedByClient) && m.abortedByClient >= 0, `=${m.abortedByClient}`);
}

console.log(`\n===== 风险测试：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
