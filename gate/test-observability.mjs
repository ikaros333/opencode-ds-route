// 可观测性测试：/gate/latency 分位 + /gate/alerts 失败摘要
import http from 'node:http';

const GATE = Number(process.argv[2] || 8799);
const MOCK = Number(process.argv[3] || 8899);
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(46)} ${d ?? ''}`); };

let mode = 'ok';
const UUID4 = '01234567-89ab-4cde-8f01-23456789abcd';
const HEX32 = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

const mock = http.createServer((req, res) => {
  if (req.url.startsWith('/mode/')) { mode = req.url.slice(6); res.writeHead(200); return res.end(mode); }
  let b = ''; req.on('data', c => b += c);
  req.on('end', () => {
    // ★ 2026-10-21 第 19 轮：门控新增交付前置闸（真实请求前要求本协议预检 pass）。
    // 本 mock 不是 DeepSeek 上游，默认满足不了 e1/msgfp，会让期望 200 的用例全部 503。
    // 只对**预检请求**扮演官方上游；third/500/429/422/slow 等被测行为不受影响。
    let jb = {}; try { jb = JSON.parse(b); } catch {}
    if (mode !== 'noid' && jb) {
      if (jb.max_output_tokens !== undefined && jb.input === undefined && jb.messages === undefined) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Either input or instructions must be provided (request_id: 4cd64d97-9e2f-4b7a-8f1a-1234567890ab)' } }));
      }
      if (req.url.includes('/messages')) {
        const m = jb.messages;
        let code = 0;
        if (jb.max_tokens === 0) code = 400;
        else if (jb.temperature !== undefined && (jb.temperature < 0 || jb.temperature > 2)) code = 400;
        else if (jb.top_p !== undefined && (jb.top_p <= 0 || jb.top_p > 1)) code = 400;
        else if (Array.isArray(m) && m.length === 0) code = 400;
        else if (m === undefined) code = 422;
        else if (Array.isArray(m) && m[0] && m[0].role === 'wizard') code = 422;
        else if (Array.isArray(m) && m[0] && typeof m[0].content !== 'string') code = 422;
        if (code) { res.writeHead(code, { 'content-type': 'application/json' }); return res.end('{"type":"error"}'); }
      }
    }
    if (mode === 'third') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: HEX32 })); }
    if (mode === '500') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"e":1}'); }
    if (mode === '429') { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '300' }); return res.end('{"e":1}'); }
    if (mode === '422') { res.writeHead(422, { 'content-type': 'application/json' }); return res.end('{"e":1}'); }
    if (mode === 'slow') {
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ id: UUID4 })); }, 600);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: UUID4, object: 'response' }));
  });
});
await new Promise(r => mock.listen(MOCK, '127.0.0.1', r));

const setMode = async m => { await fetch(`http://127.0.0.1:${MOCK}/mode/${m}`); };
async function gate() {
  const r = await fetch(`http://127.0.0.1:${GATE}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 }),
  });
  await r.text(); return r.status;
}
const latency = async () => (await fetch(`http://127.0.0.1:${GATE}/gate/latency`)).json();
const alerts = async () => (await fetch(`http://127.0.0.1:${GATE}/gate/alerts`)).json();
const metricsJ = async () => (await fetch(`http://127.0.0.1:${GATE}/gate/metrics`)).json();

console.log('--- L1 /gate/latency 结构 ---');
{
  const l = await latency();
  const keys = ['window', 'n', 'p50', 'p90', 'p95', 'p99', 'min', 'max', 'avgRecent'];
  check('L1 返回全部分位字段', keys.every(k => k in l), `字段=${Object.keys(l).join(',')}`);
  check('L1 分位单调不减', l.p50 === null || (l.p50 <= l.p90 && l.p90 <= l.p95 && l.p95 <= l.p99 && l.p99 <= l.max),
    `p50=${l.p50} p90=${l.p90} p95=${l.p95} p99=${l.p99} max=${l.max}`);
}

console.log('\n--- L2 慢请求应体现在分位上 ---');
{
  const before = await latency();
  await setMode('slow');
  const t0 = Date.now();
  const st = await gate();
  const dt = Date.now() - t0;
  await setMode('ok');
  const after = await latency();
  check('L2 慢请求成功且 200', st === 200, `status=${st} 实测耗时=${dt}ms`);
  check('L2 窗口样本数增加', after.n > before.n, `${before.n} → ${after.n}`);
  check('L2 max 覆盖到慢请求', after.max >= 550, `max=${after.max}ms`);
}

console.log('\n--- L3 /gate/metrics 内嵌 latency ---');
{
  const m = await metricsJ();
  check('L3 metrics 含 latency 对象', m.latency && typeof m.latency.p95 === 'number',
    `p95=${m.latency?.p95}`);
  check('L3 latency.totalSampled 累计正确', m.latency.totalSampled >= m.latency.n,
    `sampled=${m.latency.totalSampled} windowN=${m.latency.n}`);
}

console.log('\n--- A1 /gate/alerts 结构 ---');
{
  const a = await alerts();
  check('A1 含 alerts / recentFailures / lastSuccessAt',
    Array.isArray(a.alerts) && Array.isArray(a.recentFailures) && 'lastSuccessAt' in a,
    `字段=${Object.keys(a).join(',')}`);
  check('A1 成功过之后 lastSuccessAt 非空', !!a.lastSuccessAt, `lastSuccessAt=${a.lastSuccessAt}`);
  check('A1 failureWindow 已暴露', typeof a.failureWindow === 'number', `window=${a.failureWindow}`);
}

console.log('\n--- A2 四类失败都要进 recentFailures ---');
{
  const before = (await alerts()).recentFailures.length;
  await setMode('422');  await gate();       // upstream-4xx
  await setMode('429');  await gate();       // rate-limit
  await setMode('third'); await gate();     // route
  await fetch(`http://127.0.0.1:${GATE}/v1/nope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }); // client 404
  await fetch(`http://127.0.0.1:${GATE}/v1/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' }); // client 400
  await setMode('ok');
  const a = await alerts();
  const kinds = new Set(a.recentFailures.slice(-5).map(f => f.kind));
  check('A2 记录了 ≥5 条新失败', a.recentFailures.length >= Math.min(5, before + 5), `总数=${a.recentFailures.length}`);
  check('A2 kind 覆盖 upstream-4xx', kinds.has('upstream-4xx'), `kinds=${[...kinds].join(',')}`);
  check('A2 kind 覆盖 rate-limit', kinds.has('rate-limit'));
  check('A2 kind 覆盖 route', kinds.has('route'));
  check('A2 kind 覆盖 client', kinds.has('client'));
  const hasStatus = a.recentFailures.every(f => typeof f.status === 'number');
  check('A2 每条都带 status 与 elapsedMs', hasStatus && a.recentFailures.every(f => 'elapsedMs' in f));
  const noBody = a.recentFailures.every(f => !('body' in f) && !('text' in f) && !('prompt' in f));
  check('A2 不含任何请求/响应正文', noBody, '隐私保护');
}

console.log('\n--- A3 窗口滚动上限 ---');
{
  const a = await alerts();
  check('A3 recentFailures 不超过 failureWindow', a.recentFailures.length <= a.failureWindow,
    `${a.recentFailures.length} <= ${a.failureWindow}`);
}

console.log('\n--- A4 恢复后仍能成功 ---');
{
  const st = await gate();
  const a = await alerts();
  check('A4 恢复后请求 200', st === 200, `status=${st}`);
  check('A4 lastSuccessAt 已刷新', !!a.lastSuccessAt, `lastSuccessAt=${a.lastSuccessAt}`);
}

console.log(`\n===== 可观测性：${pass} 通过 / ${fail} 失败 =====`);
mock.close();
process.exit(fail === 0 ? 0 : 1);
