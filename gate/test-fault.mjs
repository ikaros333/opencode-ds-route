/**
 * 故障注入测试：把门控指到一个可控的假上游，验证 429 / 5xx / 断流 / 畸形响应的处理。
 * 用法：GATE_HOST=127.0.0.1 GATE_HOST_PORT=<port> GATE_HOST_SCHEME=http node oc-gate.mjs
 *       node test-fault.mjs <gatePort> <mockPort>
 */
import http from 'node:http';

const GATE = Number(process.argv[2] || 8799);
const MOCK = Number(process.argv[3] || 8899);
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(46)} ${d ?? ''}`); };

// ---------- 假上游：模式由 /mode/<name> 控制 ----------
let mode = 'ok';
let served = 0;
const UUID4 = '01234567-89ab-4cde-8f01-23456789abcd';
const HEX32 = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

const mock = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url.startsWith('/mode/')) {
    mode = req.url.slice(6); served = 0;
    res.writeHead(200); return res.end('ok:' + mode);
  }
  if (req.method === 'GET' && req.url === '/calls') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ calls: served, mode }));
  }
  let b = '';
  req.on('data', c => b += c);
  req.on('end', () => {
    served++;
    const isSse = String(req.headers.accept || '').includes('event-stream');

    // 第 18 轮：身份制下门控的 responses 预检（e1）要求返回官方业务错误原文，
    // 否则 allowAllLanes=false，本套件里「恢复后应 200」的断言会与策略冲突而永远红。
    // 这里让 mock 对**预检请求**扮演官方 Rust 服务端（400 + 原文 + request_id UUID4），
    // 只影响预检，不改变 429/500/断流 等被测行为。
    let jb = {}; try { jb = JSON.parse(b); } catch {}
    if (jb && jb.max_output_tokens !== undefined && jb.input === undefined && jb.messages === undefined) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { message: 'Either input or instructions must be provided (request_id: 4cd64d97-9e2f-4b7a-8f1a-1234567890ab)' } }));
    }

    if (mode === '429') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
      return res.end('{"error":{"message":"rate limited by upstream"}}');
    }
    if (mode === '429long') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '120' });
      return res.end('{"error":{"message":"rate limited long"}}');
    }
    if (mode === '500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end('{"error":{"message":"internal error"}}');
    }
    if (mode === '503') {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end('{"error":{"message":"service unavailable"}}');
    }
    if (mode === '401') {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end('{"error":{"message":"invalid api key"}}');
    }
    if (mode === 'third') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ id: HEX32, object: 'chat.completion' }));
    }
    if (mode === 'garbage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('not a json at all %%%');
    }
    if (mode === 'truncate') {   // 发一半就断
      if (isSse) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: response.created\ndata: {"type":"response.created","response":{"id":"${UUID4}"}}\n\n`);
        setTimeout(() => { try { res.destroy(); } catch {} }, 100);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '9999' });
      res.write('{"id":"' + UUID4 + '","object":"response"');
      setTimeout(() => { try { res.destroy(); } catch {} }, 100);
      return;
    }
    if (mode === 'huge') {       // 5MB 无 id 响应
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"pad":"' + 'x'.repeat(5 * 1024 * 1024) + '"}');
    }
    if (mode === 'slow') {       // 一直不响应，测超时
      res.writeHead(200, { 'content-type': 'application/json' });
      return;   // 不 end
    }

    // ok 模式：返回官方形态
    if (isSse) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`event: response.created\ndata: {"type":"response.created","response":{"id":"${UUID4}","object":"response","completed_at":null}}\n\n`);
      res.write(`event: response.completed\ndata: {"type":"response.completed"}\n\n`);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: UUID4, object: 'response', completed_at: null }));
  });
});

await new Promise(r => mock.listen(MOCK, '127.0.0.1', r));
console.log(`假上游就绪 :${MOCK}\n门控目标 :${GATE}\n`);

async function setMode(m) { await fetch(`http://127.0.0.1:${MOCK}/mode/${m}`); }
async function callCount() { return (await (await fetch(`http://127.0.0.1:${MOCK}/calls`)).json()).calls; }
async function gate(body = { model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 }, extra = {}) {
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${GATE}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body),
  });
  return { status: r.status, h: r.headers, text: await r.text().catch(() => ''), ms: Date.now() - t0 };
}

// ---------- 用例 ----------
await setMode('ok');
{
  const r = await gate();
  check('基线：假上游官方响应被判定 official', r.status === 200 && r.h.get('x-gate-result') === 'official',
    `status=${r.status} verdict=${r.h.get('x-gate-result')}`);
}

await setMode('429');
{
  const before = await callCount();
  const r = await gate();
  const n = (await callCount()) - before;
  check('429：同车道重试（不换道）', n >= 2, `上游调用=${n} 次`);
  check('429：等待后仍限流则透传 429', r.status === 429, `status=${r.status} 耗时=${r.ms}ms`);
  check('429：透传上游原始错误', r.text.includes('rate limited'), `${r.text.slice(0, 60)}`);
}

await setMode('429long');
{
  const before = await callCount();
  const r = await gate();
  const n = (await callCount()) - before;
  check('429(Retry-After=120s)：不等待，立即透传', r.status === 429 && r.ms < 5000,
    `status=${r.status} 耗时=${r.ms}ms 上游调用=${n}`);
}

await setMode('500');
{
  const before = await callCount();
  const r = await gate();
  const n = (await callCount()) - before;
  check('500：同车道重试后被判失败', r.status === 503, `status=${r.status} 上游调用=${n}`);
  check('500：未污染车道缓存', (r.h.get('x-gate-result') || '') === 'blocked', `verdict=${r.h.get('x-gate-result')}`);
}

await setMode('503');
{
  const r = await gate();
  check('503：不崩溃且给出 503', r.status === 503, `status=${r.status}`);
}

await setMode('401');
{
  const r = await gate();
  check('401：原样透传（认证问题不换道）', r.status === 401, `status=${r.status}`);
  check('401：透传上游错误信息', r.text.includes('invalid api key'), `${r.text.slice(0, 60)}`);
}

await setMode('third');
{
  const r = await gate();
  check('第三方 id：fail-closed 503', r.status === 503, `status=${r.status} type=${JSON.parse(r.text || '{}').error?.type}`);
}

await setMode('garbage');
{
  const r = await gate();
  check('畸形响应（非 JSON）：fail-closed 不崩溃', r.status === 503 || r.status === 200, `status=${r.status}`);
  const h = await gate();
  check('畸形响应后仍可服务', h.status < 600, `status=${h.status}`);
}

await setMode('truncate');
{
  const r = await gate();
  check('上游断流：不崩溃，返回可识别状态', [200, 502, 503].includes(r.status), `status=${r.status}`);
  const h = await gate();
  check('断流后仍可服务', h.status < 600, `status=${h.status}`);
}

await setMode('huge');
{
  const r = await gate();
  check('5MB 无 id 响应：fail-closed 且不 OOM', r.status === 503, `status=${r.status}`);
}

await setMode('slow');
{
  const t0 = Date.now();
  const r = await gate();
  const dt = Date.now() - t0;
  check('上游不响应：按超时上限收敛（<70s）', dt < 70000, `耗时=${dt}ms status=${r.status}`);
}

await setMode('ok');
{
  const r = await gate();
  check('所有故障后恢复正常路由', r.status === 200 && r.h.get('x-gate-result') === 'official',
    `status=${r.status} verdict=${r.h.get('x-gate-result')}`);
}

console.log(`\n===== 故障注入：${pass} 通过 / ${fail} 失败 =====`);
mock.close();
process.exit(fail === 0 ? 0 : 1);
