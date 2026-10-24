// 稳定性/自愈测试：故障注入 + 恢复，验证"坏一段时间后能不能自己站起来"
import http from 'node:http';

const GATE = Number(process.argv[2] || 8799);
const MOCK = Number(process.argv[3] || 8899);
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(48)} ${d ?? ''}`); };

let mode = 'ok';
let served = 0;
const UUID4 = '01234567-89ab-4cde-8f01-23456789abcd';
const HEX32 = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

const mock = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/mode/')) {
    mode = req.url.slice(6); res.writeHead(200); return res.end(mode);
  }
  if (req.method === 'GET' && req.url === '/calls') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ calls: served, mode }));
  }
  let b = ''; req.on('data', c => b += c);
  req.on('end', () => {
    served++;
    // ★ 2026-10-21 第 19 轮：门控新增交付前置闸，真实请求前要求本协议预检 pass。
    // 本 mock 不是 DeepSeek 上游，默认满足不了 e1，会让期望 200 的用例全部 503。
    // 只对**预检请求**扮演官方 Rust 服务端，500/502/third/slow 等被测行为不受影响。
    let jb = {}; try { jb = JSON.parse(b); } catch {}
    if (mode !== 'noid' && jb) {
      // e1：缺 input 的 responses 预检 → 回官方原文 + request_id UUID4
      if (jb.max_output_tokens !== undefined && jb.input === undefined && jb.messages === undefined) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Either input or instructions must be provided (request_id: 4cd64d97-9e2f-4b7a-8f1a-1234567890ab)' } }));
      }
      // msgfp：messages 的 9 项状态码指纹
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
    if (mode === '500') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"boom"}}'); }
    if (mode === '502') { res.writeHead(502, { 'content-type': 'application/json' }); return res.end('{"error":{"message":"bad gateway"}}'); }
    if (mode === 'third') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: HEX32 })); }
    if (mode === 'slow') { res.writeHead(200, { 'content-type': 'application/json' }); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: UUID4, object: 'response', completed_at: null }));
  });
});
await new Promise(r => mock.listen(MOCK, '127.0.0.1', r));

const setMode = async m => { await fetch(`http://127.0.0.1:${MOCK}/mode/${m}`); };
async function gate(body = { model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 }) {
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${GATE}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: r.status, h: r.headers, text: await r.text().catch(() => ''), ms: Date.now() - t0 };
}
const metrics = async () => JSON.parse(await (await fetch(`http://127.0.0.1:${GATE}/gate/metrics`)).text());

console.log('=== E1 连续 5xx → 恢复后是否立刻可用 ===');
await setMode('500');
{
  const rs = [];
  for (let i = 0; i < 3; i++) rs.push(await gate());
  check('E1 5xx 期间返回 503 而非 200', rs.every(r => r.status === 503), rs.map(r => r.status).join('/'));
}
await setMode('ok');
{
  const r = await gate();
  check('E1 恢复后下一个请求立刻成功', r.status === 200 && r.h.get('x-gate-result') === 'official',
    `status=${r.status} verdict=${r.h.get('x-gate-result')} ${r.ms}ms`);
}

console.log('\n=== E2 502（另一个 5xx 变体）===');
await setMode('502');
{
  const r = await gate();
  check('E2 502 被判为可重试的 5xx', r.status === 503, `status=${r.status} ${r.ms}ms`);
}
await setMode('ok');
{
  const r = await gate();
  check('E2 恢复后立刻成功', r.status === 200, `status=${r.status}`);
}

console.log('\n=== E3 高错误率后自愈（模拟上游抖动 10 次）===');
{
  await setMode('500');
  for (let i = 0; i < 10; i++) await gate();
  await setMode('ok');
  const r = await gate();
  check('E3 高频错误后单次请求即恢复（无冷却期）', r.status === 200 && r.h.get('x-gate-result') === 'official',
    `status=${r.status} ${r.ms}ms`);
}

console.log('\n=== E4 探针与真实请求并发（互不干扰）===');
{
  await setMode('ok');
  await fetch(`http://127.0.0.1:${GATE}/gate/matrix`).catch(() => {});
  const rs = await Promise.all([gate(), gate(), gate(), gate()]);
  check('E4 4 并发全部 official', rs.every(r => r.status === 200 && r.h.get('x-gate-result') === 'official'),
    rs.map(r => r.status).join('/'));
  const m = await metrics();
  check('E4 并发后 inflight 归零', m.inflight === 0, `inflight=${m.inflight}`);
}

console.log('\n=== E5 上游长时间不响应 → 超时收敛不卡死 ===');
{
  await setMode('slow');
  const t0 = Date.now();
  const r = await gate();
  const dt = Date.now() - t0;
  check('E5 按超时上限返回（<70s，不无限挂起）', dt < 70000, `耗时=${dt}ms status=${r.status}`);
  await setMode('ok');
  const r2 = await gate();
  check('E5 超时后立刻可服务', r2.status === 200, `status=${r2.status} ${r2.ms}ms`);
}

console.log('\n=== E6 混合故障序列（模拟真实抖动）===');
{
  const seq = ['500', 'ok', 'third', 'ok', '502', 'ok', '429short', 'ok'];
  const results = [];
  for (const m of seq) {
    await setMode(m === '429short' ? '429' : m);
    results.push((await gate()).status);
  }
  await setMode('ok');
  const finalOk = (await gate()).status === 200;
  check('E6 混合故障序列后恢复正常', finalOk, `序列响应=${results.join(',')}`);
  const m = await metrics();
  check('E6 未出现 inflight 泄漏', m.inflight === 0, `inflight=${m.inflight}`);
}

console.log('\n=== E7 稳定性指标：连续 30 次交替故障/正常 ===');
{
  let ok = 0, total = 0;
  for (let i = 0; i < 30; i++) {
    await setMode(i % 3 === 0 ? '500' : 'ok');
    const r = await gate(); total++;
    if (i % 3 !== 0 && r.status === 200) ok++;
    if (i % 3 === 0 && r.status === 503) ok++;
  }
  check('E7 30 次交替全部符合预期', ok === total, `${ok}/${total}`);
  await setMode('ok');
  const m = await metrics();
  check('E7 结束时健康', m.inflight === 0, `inflight=${m.inflight} blocked=${m.blocked}`);
}

console.log(`\n===== 自愈：${pass} 通过 / ${fail} 失败 =====`);
mock.close();
process.exit(fail === 0 ? 0 : 1);
