// 429 三分类回归套件（2026-11-06）
//
// 覆盖四个真实缺陷（均由 mock 确定性复现，不依赖上游）：
//   ① 文案二义：旧版把「等待超限」与「重试用尽」写成同一句，后者场景下是假话
//   ② 容量满被当可重试：prefill_cap_refused 重试无意义（真实台账连续 16 分钟未恢复）
//   ③ 误分类：曾返回 429 却报 gate_upstream_unreachable（"没有返回任何 HTTP 响应"）
//   ④ 死代码：空 if 块
//
// 运行：node gate/test-429.mjs       （不需要 key，不需要真实上游）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const LOGDIR = path.join(ROOT, 'gate', 'logs', 'tests');
fs.mkdirSync(LOGDIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`PASS  ${name.padEnd(52)} ${detail}`); }
  else { fail++; console.log(`FAIL  ${name.padEnd(52)} ${detail}`); }
};

const U4 = '0123456789ab4cde8f0123456789abcd';
const probeBody = () => ({ id: 'resp_' + U4, object: 'response', created_at: 1, status: 'completed',
  error: null, incomplete_details: null, instructions: null, metadata: {},
  model: 'deepseek-v4.1-flash',
  output: [{ type: 'message', id: 'msg_' + U4, role: 'assistant', status: 'completed',
             content: [{ type: 'output_text', text: '好' }] }],
  parallel_tool_calls: true, temperature: 1, tool_choice: 'auto', tools: [], top_p: 1,
  max_output_tokens: 8, reasoning: null,
  usage: { cost: 0, input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, opencode: {},
           output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 } });

let mode = 'cap', hits = 0;
const mock = http.createServer((req, res) => {
  if (String(req.url).startsWith('/mode/')) { mode = String(req.url).slice(6); hits = 0; res.writeHead(200); return res.end(mode); }
  let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
    let j = {}; try { j = JSON.parse(b); } catch {}
    // 预检探针必须给合规形态，否则请求进不到 429 分支
    if (j.max_output_tokens === 1 && j.input === 'ping') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(probeBody()));
    }
    hits++;
    const capacity429 = (ra) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': ra });
      res.end(JSON.stringify({ error: { code: 'server_error',
        message: 'Upstream request failed: [prefill_cap_refused] the cell is at capacity; retry shortly' } }));
    };
    const plain429 = (ra) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': ra });
      res.end(JSON.stringify({ error: { code: 'server_error',
        message: 'Upstream request failed: [overloaded] the server is overloaded; retry shortly' } }));
    };
    if (mode === 'cap') return capacity429('1');
    if (mode === 'cap30') return capacity429('30');
    if (mode === 'cap2') return capacity429('2');
    if (mode === 'long') return capacity429('30');
    if (mode === 'plain') return plain429('1');           // 真·限流（非容量），应仍按重试策略走
    if (mode === 'capThenHang') { if (hits === 1) return capacity429('1'); return; }
    // 非容量 429 后挂住：用来独立验证"误分类为不可达"的修复
    // （容量类在 FAILFAST=1 下会立即返回，走不到挂住这一步）
    if (mode === 'plainThenHang') { if (hits === 1) return plain429('1'); return; }
    return;
  });
});
const MP = 8951;
await new Promise(r => mock.listen(MP, '127.0.0.1', r));

async function boot(tag, env) {
  const port = 8952 + (Math.floor(Math.random() * 40));
  const log = path.join(LOGDIR, `t429-${tag}.jsonl`);
  try { fs.rmSync(log, { force: true }); } catch {}
  const child = spawn(process.execPath, [path.join(ROOT, 'gate', 'oc-gate.mjs')], {
    env: { ...process.env,
      OPENCODE_GO_API_KEY: 'test-key', GATE_PORT: String(port), GATE_TOKEN: '',
      GATE_CHAIN: 'deepseek-v4.1-flash',
      GATE_HOST: '127.0.0.1', GATE_HOST_PORT: String(MP), GATE_HOST_SCHEME: 'http', GATE_UPSTREAM_PREFIX: '',
      GATE_LOG_FILE: log, GATE_SNAPSHOT: path.join(LOGDIR, `t429-${tag}-m.json`),
      GATE_ASSURANCE: 'label', GATE_CANARY_POLICY: 'label', GATE_L0_POLICY: 'label',
      GATE_EVIDENCE_AUTO_REFRESH: '0', GATE_REFRESH_MS: '0', GATE_PROOF_REFRESH_MS: '0',
      ...env },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${port}/gate/health`); if (r.ok) up = true; } catch {} }
  return { child, port, log, up };
}

async function call(tag, env, m) {
  const g = await boot(tag, env);
  if (!g.up) { try { g.child.kill('SIGKILL'); } catch {} return { up: false }; }
  await fetch(`http://127.0.0.1:${MP}/mode/${m}`);
  await sleep(120);                       // 让 mode 生效且 hits 归零
  const t0 = Date.now();
  let status = null, text = '', hdr = {};
  try {
    const r = await fetch(`http://127.0.0.1:${g.port}/v1/responses`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 }) });
    status = r.status; text = await r.text(); hdr = Object.fromEntries(r.headers);
  } catch (e) { text = 'CLIENT_ERR ' + String(e.message); }
  const ms = Date.now() - t0;
  const hitCount = hits;
  const health = await fetch(`http://127.0.0.1:${g.port}/gate/health`).then(r => r.json()).catch(() => null);
  const led = fs.existsSync(g.log)
    ? fs.readFileSync(g.log, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  try { g.child.kill('SIGKILL'); } catch {}
  let body = {}; try { body = JSON.parse(text); } catch {}
  return { up: true, status, ms, hits: hitCount, hdr, body, health, led,
           type: body?.error?.type || null, message: body?.error?.message || text.slice(0, 120),
           reasonHdr: hdr['x-gate-reason'] || null };
}

console.log('=== 用例 ① 容量满（prefill_cap_refused）应快速失败 ===');
const A = await call('cap', {}, 'cap');
check('① 返回 429', A.status === 429, `status=${A.status}`);
check('① 重试 1 次后放弃（默认 CAPACITY_RETRY=1）', A.hits === 2, `hits=${A.hits}`);
check('① type=gate_upstream_capacity', A.type === 'gate_upstream_capacity', `type=${A.type}`);
check('① x-gate-reason=capacity_retries_exhausted', A.reasonHdr === 'capacity_retries_exhausted', `reason=${A.reasonHdr}`);
check('① 文案不再说"等待超过上限"', !/超过门控上限/.test(A.message), `msg=${A.message.slice(0, 46)}…`);
check('① 耗时远小于旧版 36s（<5s）', A.ms < 5000, `ms=${A.ms}`);
check('① health 计数 capacityRefused≥1', (A.health?.rateLimitBreakdown?.capacityRefused || 0) >= 1,
  JSON.stringify(A.health?.rateLimitBreakdown));
check('① 台账记 UPSTREAM_CAPACITY', A.led.some(x => x.result === 'UPSTREAM_CAPACITY'),
  A.led.filter(x => /429|CAPACITY/.test(x.result || '')).map(x => x.result).join(','));
check('① 台账含 CAPACITY_RETRY 记录', A.led.some(x => x.result === 'UPSTREAM_CAPACITY_RETRY'), 'ok');

console.log('\n=== 用例 ①b CAPACITY_RETRY=0 → 纯快速失败 ===');
const A0 = await call('cap0', { GATE_CAPACITY_RETRY: '0' }, 'cap');
check('①b 只打上游 1 次', A0.hits === 1, `hits=${A0.hits}`);
check('①b 立即 429', A0.status === 429, `status=${A0.status} ms=${A0.ms}`);

console.log('\n=== 用例 ①c 容量要求 30s、容量等待上限 1s → 不等待且原因准确 ===');
const Ac = await call('cap30', { GATE_CAPACITY_MAX_WAIT_MS: '1000', GATE_CAPACITY_RETRY: '1' }, 'cap30');
check('①c 只打上游 1 次（没等）', Ac.hits === 1, `hits=${Ac.hits}`);
check('①c reason=capacity_wait_exceeded', Ac.reasonHdr === 'capacity_wait_exceeded', `reason=${Ac.reasonHdr}`);
check('①c 文案说明"要求 30s / 上限 1s"，不再说"重试 0 次"', /要求等待 30s/.test(Ac.message) && /上限是 1s/.test(Ac.message) && !/重试过/.test(Ac.message), `msg=${Ac.message.slice(0, 58)}…`);
check('①c retry-after 透传上游值 30', Ac.hdr['retry-after'] === '30', `ra=${Ac.hdr['retry-after']}`);

console.log('\n=== 用例 ①d 容量要求 2s、上限 35s → 会等待并重试 ===');
const Ad = await call('cap2', { GATE_CAPACITY_MAX_WAIT_MS: '35000', GATE_CAPACITY_RETRY: '1' }, 'cap2');
check('①d 打了 2 次（等 2s 后重试 1 次）', Ad.hits === 2, `hits=${Ad.hits}`);
check('①d 耗时 ≥2s（确实等了）', Ad.ms >= 1900, `ms=${Ad.ms}`);
check('①d reason=capacity_retries_exhausted', Ad.reasonHdr === 'capacity_retries_exhausted', `reason=${Ad.reasonHdr}`);
check('①d 文案说"已重试 1 次"', /重试 1 次/.test(Ad.message), `msg=${Ad.message.slice(0, 56)}…`);

console.log('\n=== 用例 ② 等待确实超过上限 ===');
const B = await call('long', { GATE_RATE_LIMIT_MAX_WAIT_MS: '1000', GATE_CAPACITY_FAILFAST: '0' }, 'long');
check('② 只打上游 1 次（不等待）', B.hits === 1, `hits=${B.hits}`);
check('② type=gate_upstream_rate_limited（保留原 type）', B.type === 'gate_upstream_rate_limited', `type=${B.type}`);
check('② x-gate-reason=wait_exceeded', B.reasonHdr === 'wait_exceeded', `reason=${B.reasonHdr}`);
check('② 文案提到上限', /超过门控上限/.test(B.message), `msg=${B.message.slice(0, 46)}…`);

console.log('\n=== 用例 ③ 非容量 429，等待 OK 但重试用尽 ===');
const C = await call('plain', { GATE_RATE_LIMIT_MAX_WAIT_MS: '1000', GATE_LANE_RETRY: '2' }, 'plain');
check('③ 打了 3 次（初次 + 2 重试）', C.hits === 3, `hits=${C.hits}`);
check('③ type=…_rate_limited_retries', C.type === 'gate_upstream_rate_limited_retries', `type=${C.type}`);
check('③ x-gate-reason=retries_exhausted', C.reasonHdr === 'retries_exhausted', `reason=${C.reasonHdr}`);
check('③ 文案明说"重试用尽"且否认"等待超限"', /重试.*次/.test(C.message) && /不是"等待超限"/.test(C.message),
  `msg=${C.message.slice(0, 60)}…`);
check('③ 与用例 ② 文案不同（旧版相同）', C.message !== B.message, `same=${C.message === B.message}`);
check('③ health 计数归到 overloaded', (C.health?.rateLimitBreakdown?.byClass?.overloaded || 0) >= 1, JSON.stringify(C.health?.rateLimitBreakdown?.byClass));

console.log('\n=== 用例 ④ 关闭开关可回退旧行为 ===');
const D = await call('off', { GATE_CAPACITY_FAILFAST: '0', GATE_RATE_LIMIT_MAX_WAIT_MS: '1000', GATE_LANE_RETRY: '2' }, 'cap');
check('④ FAILFAST=0 → 恢复重试 3 次', D.hits === 3, `hits=${D.hits}`);
check('④ 仍返回 429', D.status === 429, `status=${D.status}`);

console.log('\n=== 用例 ⑤ 先 429、后挂住 → 不得报"不可达" ===');
const E = await call('hang', { GATE_ATTEMPT_HARD_CAP_MS: '3000', GATE_LANE_RETRY: '2', GATE_TOTAL_BUDGET_MS: '20000',
  GATE_RATE_LIMIT_MAX_WAIT_MS: '1000', GATE_CAPACITY_FAILFAST: '1' }, 'plainThenHang');
check('⑤ 不是 gate_upstream_unreachable', E.reasonHdr !== 'gate_upstream_unreachable', `reason=${E.reasonHdr}`);
check('⑤ 归类为 gate_upstream_slow', E.reasonHdr === 'gate_upstream_slow', `reason=${E.reasonHdr}`);
check('⑤ 文案不含"没有返回任何 HTTP 响应"', !/没有返回任何 HTTP 响应/.test(E.message), `msg=${E.message.slice(0, 50)}…`);
const blocked = E.led.find(x => x.result === 'BLOCKED');
check('⑤ 台账 sawHttp=true', !!blocked && blocked.sawHttp === true, `sawHttp=${blocked?.sawHttp}`);

console.log('\n=== 用例 ⑤b 容量满时不再走到"挂住"（fail-fast 更早生效）===');
const E2 = await call('hang2', { GATE_ATTEMPT_HARD_CAP_MS: '3000', GATE_TOTAL_BUDGET_MS: '20000',
  GATE_RATE_LIMIT_MAX_WAIT_MS: '1000', GATE_CAPACITY_FAILFAST: '1', GATE_CAPACITY_RETRY: '0' }, 'capThenHang');
check('⑤b 容量满立即返回 429（不进挂住）', E2.status === 429 && E2.hits === 1, `status=${E2.status} hits=${E2.hits} ms=${E2.ms}`);

console.log('\n=== 用例 ⑥ 死代码已删 ===');
const src = fs.readFileSync(path.join(ROOT, 'gate', 'oc-gate.mjs'), 'utf8');
check('⑥ 无空 if 块', !/if \(!candidates\.length\) \{\s*\}\s*\n\s*if \(!candidates\.length\)/.test(src), 'ok');

try { mock.close(); } catch {}
console.log(`\n===== 429 套件：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
