// 针对本轮 3 个 bug 的精确回归：每个 bug 都有可观测的判据
import http from 'node:http';

const GATE = Number(process.argv[2] || 8799);
const MOCK = Number(process.argv[3] || 8899);
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(50)} ${d ?? ''}`); };

let mode = 'ok';
let served = 0;
const UUID4 = '01234567-89ab-4cde-8f01-23456789abcd';
const HEX32 = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

const mock = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/mode/')) {
    mode = req.url.slice(6); served = 0;
    res.writeHead(200); return res.end(mode);
  }
  if (req.method === 'GET' && req.url === '/calls') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ calls: served, mode }));
  }
  let b = '';
  req.on('data', c => b += c);
  req.on('end', () => {
    served++;
    // 第 18 轮：身份制下 responses 预检（e1）要求官方业务错误原文，否则 allowAllLanes=false，
    // 本套件「恢复后应 200」的断言会与策略冲突而永远红。
    // 让 mock 只对**预检请求**扮演官方 Rust 服务端；429/third/ok 等被测行为不受影响。
    let jb = {}; try { jb = JSON.parse(b); } catch {}
    if (jb && jb.max_output_tokens !== undefined && jb.input === undefined && jb.messages === undefined) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Either input or instructions must be provided (request_id: 4cd64d97-9e2f-4b7a-8f1a-1234567890ab)' } }));
    }
    if (mode === '429short') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      return res.end('{"error":{"message":"RATE_LIMIT_SENTINEL_short"}}');
    }
    if (mode === '429long') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '300' });
      return res.end('{"error":{"message":"RATE_LIMIT_SENTINEL_long"}}');
    }
    if (mode === 'third') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: HEX32, object: 'chat.completion' }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: UUID4, object: 'response', completed_at: null }));
  });
});
await new Promise(r => mock.listen(MOCK, '127.0.0.1', r));

const setMode = async m => { await fetch(`http://127.0.0.1:${MOCK}/mode/${m}`); };
const callCount = async () => (await (await fetch(`http://127.0.0.1:${MOCK}/calls`)).json()).calls;
async function gate() {
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${GATE}/v1/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-opencode-session': 'ses_bugfix' },
    body: JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 }),
  });
  return { status: r.status, h: r.headers, text: await r.text().catch(() => ''), ms: Date.now() - t0 };
}

console.log('--- Bug A：429 必须走同车道重试，而不是被 passthrough 抢走 ---');
await setMode('429short');
{
  const before = await callCount();
  const r = await gate();
  const n = (await callCount()) - before;
  check('A1 429 触发同车道重试（上游被调用 ≥2 次）', n >= 2, `上游调用=${n} 次`);
  check('A2 重试后仍限流则返回 429', r.status === 429, `status=${r.status}`);
  check('A3 确实等待了 Retry-After（≥900ms）', r.ms >= 900, `耗时=${r.ms}ms`);
}

console.log('\n--- Bug C：429 透传必须带上游原文 ---');
await setMode('429long');
{
  const r = await gate();
  check('C1 长 Retry-After 立即透传（<2s）', r.status === 429 && r.ms < 2000, `status=${r.status} 耗时=${r.ms}ms`);
  let j = {}; try { j = JSON.parse(r.text); } catch {}
  check('C2 响应含 retry_after_seconds', typeof j.error?.retry_after_seconds === 'number',
    `retry_after_seconds=${j.error?.retry_after_seconds}`);
  check('C3 upstream 字段携带上游原文（含 sentinel）',
    String(j.error?.upstream || '').includes('RATE_LIMIT_SENTINEL_long'),
    `upstream=${String(j.error?.upstream || '(空)').slice(0, 70)}`);
}

console.log('\n--- Bug B：全部 third 后上游恢复，必须立刻可用（不等 TTL）---');
await setMode('third');
{
  const r1 = await gate();
  const r2 = await gate();
  check('B1 全部 third 时 fail-closed', r1.status === 503 && r2.status === 503, `${r1.status}/${r2.status}`);
  const m = JSON.parse(await (await fetch(`http://127.0.0.1:${GATE}/gate/metrics`)).text());
  check('B2 staleRechecks 计数已增加', m.staleRechecks >= 1, `staleRechecks=${m.staleRechecks}`);
}
await setMode('ok');
{
  const t0 = Date.now();
  const r = await gate();
  check('B3 上游恢复后下一个请求立即成功（不等 120s TTL）',
    r.status === 200 && r.h.get('x-gate-result') === 'official',
    `status=${r.status} verdict=${r.h.get('x-gate-result')} 耗时=${Date.now() - t0}ms`);
}

console.log('\n--- 交叉验证：恢复后连续请求稳定 ---');
{
  let ok = 0;
  for (let i = 0; i < 5; i++) {
    const r = await gate();
    if (r.status === 200) ok++;
  }
  check('连续 5 次均成功', ok === 5, `ok=${ok}/5`);
}

console.log(`\n===== 3 个 bug 回归：${pass} 通过 / ${fail} 失败 =====`);
mock.close();
process.exit(fail === 0 ? 0 : 1);
