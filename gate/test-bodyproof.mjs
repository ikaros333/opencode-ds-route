// 体级判据回归套件（2026-11-06）
//
// 覆盖三层新增能力，全部由 mock 确定性驱动，不依赖真实上游、不需要 key：
//   L2  缓存块对齐（cached_tokens % 128）—— 默认 soft，可 config 升 hard
//   L3  流式缓冲（GATE_STREAM_BUFFER）—— 让 L2 对流式生效，默认关
//   L4  缓存语义探针（GATE_CACHE_PROBE_MS）—— 补「无缓存实现」盲区
//
// 背景实测（真实上游，见 docs/BASELINE.md B25）：
//   · 官方 cached_tokens 恒为 128 的倍数；283→256、455→384、710→640 都按 128 向下取整
//   · vLLM 默认 block_size=16、SGLang 默认 1 ⇒ 默认配置的同权重自部署必然对不上
//   · cached=0 天然符合 %128 ⇒ 需要 L4 用「同前缀连发两次」才能暴露「根本没有缓存」
//
// 运行：node gate/test-bodyproof.mjs    （不需要 key）
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
  if (ok) { pass++; console.log(`PASS  ${name.padEnd(56)} ${detail}`); }
  else { fail++; console.log(`FAIL  ${name.padEnd(56)} ${detail}`); }
};

// UUID4 位模式：第13位=4，第17位∈89ab
const U4_OK = '0123456789ab4cde8f0123456789abcd';   // idx12='4' idx16='8'
const U4_BAD = '0123456789abcde8f0123456789abcd0';  // idx12='c' → 非法版本位
check('前置：U4_OK 满足 UUID4 位模式', U4_OK[12] === '4' && '89ab'.includes(U4_OK[16]), `idx12=${U4_OK[12]} idx16=${U4_OK[16]}`);
check('前置：U4_BAD 不满足 UUID4 位模式', U4_BAD[12] !== '4', `idx12=${U4_BAD[12]}`);

const mkBody = ({ id = 'resp_' + U4_OK, cached = 128, input = 300 } = {}) => ({
  id, object: 'response', created_at: 1, status: 'completed', error: null,
  incomplete_details: null, instructions: null, metadata: {}, model: 'deepseek-v4.1-flash',
  output: [{ type: 'message', id: 'msg_' + U4_OK, role: 'assistant', status: 'completed',
             content: [{ type: 'output_text', text: '好' }] }],
  parallel_tool_calls: true, temperature: 1, tool_choice: 'auto', tools: [], top_p: 1,
  max_output_tokens: 8, reasoning: null,
  usage: { cost: 0, input_tokens: input, input_tokens_details: { cached_tokens: cached },
           opencode: {}, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 },
           total_tokens: input + 1 },
});

const sseBody = ({ id = 'resp_' + U4_OK, cached = 128, input = 300 } = {}) => {
  const frames = [
    { type: 'response.created', sequence_number: 0,
      response: { id, object: 'response', created_at: 1, status: 'in_progress', error: null,
                  incomplete_details: null, instructions: null, metadata: {},
                  model: 'deepseek-v4.1-flash', output: [], parallel_tool_calls: true,
                  temperature: null, tool_choice: 'auto', tools: [], top_p: null,
                  max_output_tokens: 8, usage: null } },
    { type: 'response.in_progress', sequence_number: 1,
      response: { id, object: 'response', status: 'in_progress', usage: null } },
    { type: 'response.output_item.added', sequence_number: 2, output_index: 0,
      item: { type: 'message', id: 'msg_' + U4_OK, role: 'assistant', status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', sequence_number: 3, output_index: 0,
      content_index: 0, delta: '好' },
    { type: 'response.output_item.done', sequence_number: 4, output_index: 0,
      item: { type: 'message', id: 'msg_' + U4_OK, role: 'assistant', status: 'completed',
              content: [{ type: 'output_text', text: '好' }] } },
    { type: 'response.completed', sequence_number: 5,
      response: { id, object: 'response', created_at: 1, status: 'completed', error: null,
                  incomplete_details: null, instructions: null, metadata: {},
                  model: 'deepseek-v4.1-flash', output: [], parallel_tool_calls: true,
                  temperature: null, tool_choice: 'auto', tools: [], top_p: null,
                  max_output_tokens: 8,
                  usage: { cost: 0, input_tokens: input,
                           input_tokens_details: { cached_tokens: cached },
                           opencode: {}, output_tokens: 1,
                           output_tokens_details: { reasoning_tokens: 0 },
                           total_tokens: input + 1 } } },
  ];
  return frames.map(f => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join('');
};

let mode = 'ok';
let bizHits = 0, probeHits = 0;
const mock = http.createServer((req, res) => {
  if (String(req.url).startsWith('/mode/')) {
    mode = String(req.url).slice(6); bizHits = 0; probeHits = 0;
    res.writeHead(200); return res.end(mode);
  }
  let b = ''; req.on('data', c => (b += c)); req.on('end', () => {
    let j = {}; try { j = JSON.parse(b); } catch {}
    const isShapeProbe = j.input === 'ping' && j.max_output_tokens === 1;
    const isCacheProbe = typeof j.input === 'string' && j.input.length > 500 && j.max_output_tokens === 2;
    if (isShapeProbe) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(mkBody({ cached: 0, input: 20 })));
    }
    if (isCacheProbe) {
      probeHits++;
      const cached = mode === 'nocache' ? 0 : mode === 'badblock' ? 48 : 128;
      // input 必须 > CACHE_PROBE_MIN_INPUT(256)：低于门槛时 cached 恒 0，
      // 会走 probe_too_short 而不是被测的分类（gate 侧已单独归类，这里给足长度）
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(mkBody({ cached, input: 360 })));
    }
    bizHits++;
    const wantsSse = j.stream === true;
    if (wantsSse) {
      const id = mode === 'sse_badid' ? 'resp_' + U4_BAD : 'resp_' + U4_OK;
      const cached = mode === 'sse_cache48' ? 48 : 128;
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      return res.end(sseBody({ id, cached, input: 300 }));
    }
    const cached = mode === 'cache48' ? 48 : mode === 'cache0' ? 0 : 128;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(mkBody({ cached, input: 300 })));
  });
});
const MP = 8961;
await new Promise(r => mock.listen(MP, '127.0.0.1', r));

async function boot(tag, env) {
  const port = 8962 + Math.floor(Math.random() * 30);
  const log = path.join(LOGDIR, `tbp-${tag}.jsonl`);
  try { fs.rmSync(log, { force: true }); } catch {}
  const child = spawn(process.execPath, [path.join(ROOT, 'gate', 'oc-gate.mjs')], {
    env: { ...process.env,
      OPENCODE_GO_API_KEY: 'test-key', GATE_PORT: String(port), GATE_TOKEN: '',
      GATE_CHAIN: 'deepseek-v4.1-flash',
      GATE_HOST: '127.0.0.1', GATE_HOST_PORT: String(MP), GATE_HOST_SCHEME: 'http',
      GATE_UPSTREAM_PREFIX: '',
      GATE_LOG_FILE: log, GATE_SNAPSHOT: path.join(LOGDIR, `tbp-${tag}-m.json`),
      GATE_ASSURANCE: 'label', GATE_CANARY_POLICY: 'label', GATE_L0_POLICY: 'label',
      GATE_EVIDENCE_AUTO_REFRESH: '0', GATE_REFRESH_MS: '0', GATE_PROOF_REFRESH_MS: '0',
      GATE_IMPL_VECTOR_MS: '0', GATE_STARTUP_SELFTEST: '1',
      ...env },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    await sleep(150);
    try { const r = await fetch(`http://127.0.0.1:${port}/gate/health`); if (r.ok) up = true; } catch {}
  }
  return { child, port, log, up };
}

async function ask(tag, env, m, body, waitMs = 0) {
  const g = await boot(tag, env);
  if (!g.up) { try { g.child.kill('SIGKILL'); } catch {} return { up: false }; }
  await fetch(`http://127.0.0.1:${MP}/mode/${m}`);
  await sleep(120);
  if (waitMs) await sleep(waitMs);
  let status = null, text = '', hdr = {};
  try {
    const r = await fetch(`http://127.0.0.1:${g.port}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body) });
    status = r.status; text = await r.text();
    hdr = Object.fromEntries(r.headers);
  } catch (e) { text = 'CLIENT_ERR ' + String(e.message); }
  const health = await fetch(`http://127.0.0.1:${g.port}/gate/health`).then(r => r.json()).catch(() => null);
  const led = fs.existsSync(g.log)
    ? fs.readFileSync(g.log, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  try { g.child.kill('SIGKILL'); } catch {}
  let body2 = {}; try { body2 = JSON.parse(text); } catch {}
  return { up: true, status, text, hdr, body: body2, health, led,
           type: body2?.error?.type || null, reasonHdr: hdr['x-gate-reason'] || null,
           probed: probeHits, biz: bizHits };
}

const BIZ = { model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 };
const BIZ_SSE = { ...BIZ, stream: true };

// ───────────── L2 ─────────────
console.log('\n=== L2 缓存块对齐（非流式）===');
{
  const A = await ask('l2ok', {}, 'ok', BIZ);
  check('L2 对齐(128) → 200 交付', A.status === 200, `status=${A.status}`);
  check('L2 对齐 → 台账无 CACHE_BLOCK_MISALIGNED', !A.led.some(x => x.result === 'CACHE_BLOCK_MISALIGNED'),
    A.led.filter(x => /CACHE/.test(x.result || '')).map(x => x.result).join(',') || '(none)');
  check('L2 health 暴露 cacheSemantics.block=128', A.health?.cacheSemantics?.block === 128,
    JSON.stringify(A.health?.cacheSemantics || null));

  const B = await ask('l2bad', {}, 'cache48', BIZ);
  check('L2 非对齐(48) 默认 label → 仍 200 交付', B.status === 200, `status=${B.status}`);
  check('L2 非对齐 → 台账 CACHE_BLOCK_MISALIGNED', B.led.some(x => x.result === 'CACHE_BLOCK_MISALIGNED'),
    B.led.filter(x => /CACHE/.test(x.result || '')).map(x => x.result).join(',') || '(none)');
  const rec = B.led.find(x => x.result === 'CACHE_BLOCK_MISALIGNED');
  check('L2 台账记录 cached=48 / remainder=48', rec?.cached === 48 && rec?.remainder === 48,
    JSON.stringify({ cached: rec?.cached, remainder: rec?.remainder }));
  check('L2 health misaligned≥1', (B.health?.cacheSemantics?.misaligned || 0) >= 1,
    JSON.stringify(B.health?.cacheSemantics || null));

  const C = await ask('l2c0', {}, 'cache0', BIZ);
  check('L2 cached=0 视为对齐（短路，不误报）', !C.led.some(x => x.result === 'CACHE_BLOCK_MISALIGNED'),
    `status=${C.status}`);

  const D = await ask('l2req', { GATE_CACHE_BLOCK_ALIGN: 'require' }, 'cache48', BIZ);
  check('L2 require 模式 → FP_MISMATCH 或未对齐仍被记录', D.led.some(x => x.result === 'FP_MISMATCH' || x.result === 'CACHE_BLOCK_MISALIGNED'),
    D.led.filter(x => /FP_|CACHE/.test(x.result || '')).map(x => x.result).join(',') || '(none)');
}

// ───────────── L3 ─────────────
console.log('\n=== L3 流式缓冲（GATE_STREAM_BUFFER）===');
{
  const OFF = await ask('l3off', {}, 'sse_cache48', BIZ_SSE);
  check('L3 关闭时非对齐流式仍透传 200', OFF.status === 200, `status=${OFF.status}`);
  check('L3 关闭时无 STREAM_BUFFER_* 台账',
    !OFF.led.some(x => /^STREAM_BUFFER/.test(x.result || '')),
    OFF.led.filter(x => /STREAM/.test(x.result || '')).map(x => x.result).join(',') || '(none)');
  check('L3 关闭时 health.streamBuffer.enabled=false', OFF.health?.streamBuffer?.enabled === false,
    JSON.stringify(OFF.health?.streamBuffer || null));

  const OK = await ask('l3ok', { GATE_STREAM_BUFFER: '1' }, 'ok', BIZ_SSE);
  check('L3 开启 + 合规流式 → 200', OK.status === 200, `status=${OK.status}`);
  check('L3 合规流式 → STREAM_BUFFER_PASS', OK.led.some(x => x.result === 'STREAM_BUFFER_PASS'),
    OK.led.filter(x => /STREAM_BUFFER/.test(x.result || '')).map(x => x.result).join(',') || '(none)');
  check('L3 合规流式 → 响应体仍是 SSE（未被改写）', /event:\s*response\.completed/.test(OK.text),
    `len=${OK.text.length}`);

  const BADID = await ask('l3badid', { GATE_STREAM_BUFFER: '1' }, 'sse_badid', BIZ_SSE);
  check('L3 开启 + 非法 id 位模式 → 503', BADID.status === 503, `status=${BADID.status}`);
  // 注：非法 id 通常会被**更早**的 third 分支（peekBody 已读到首事件里的 id）拦下，
  // 因此 reason 可能是 gate_no_official_route 而不是 L3 的 stream_id_shape。
  // L3 的 id 检查是"peek 范围外的大流"的兜底，两者都是正确拒绝。
  check('L3 非法 id → reason ∈ {stream_id_shape, gate_no_official_route}',
    ['stream_id_shape', 'gate_no_official_route'].includes(BADID.reasonHdr), `reason=${BADID.reasonHdr}`);
  check('L3 非法 id → 未交付任何 SSE 内容', !/event:\s*response\./.test(BADID.text),
    `len=${BADID.text.length}`);
  check('L3 非法 id → type=gate_no_official_route', BADID.type === 'gate_no_official_route', `type=${BADID.type}`);

  const BADCACHE = await ask('l3badc', { GATE_STREAM_BUFFER: '1' }, 'sse_cache48', BIZ_SSE);
  check('L3 开启 + 非对齐缓存 → 503', BADCACHE.status === 503, `status=${BADCACHE.status}`);
  check('L3 非对齐缓存 → x-gate-reason=stream_cache_block', BADCACHE.reasonHdr === 'stream_cache_block', `reason=${BADCACHE.reasonHdr}`);
  check('L3 health rejected≥1', (BADCACHE.health?.streamBuffer?.rejected || 0) >= 1,
    JSON.stringify(BADCACHE.health?.streamBuffer || null));
}

// ───────────── L4 ─────────────
console.log('\n=== L4 缓存语义探针（GATE_CACHE_PROBE_MS）===');
{
  // 首次探针延迟 = min(12000, CACHE_PROBE_MS)，这里设 1200ms 后跑，等 2600ms 足够
  const OKP = await ask('l4ok', { GATE_CACHE_PROBE_MS: '1200' }, 'ok', BIZ, 2600);
  check('L4 探针发过（health.cacheSemantics.at 非空）', !!OKP.health?.cacheSemantics?.at,
    String(OKP.health?.cacheSemantics?.at));
  check('L4 命中 128 → ok=true', OKP.health?.cacheSemantics?.ok === true,
    JSON.stringify(OKP.health?.cacheSemantics || null));
  check('L4 台账有 CACHE_PROBE', OKP.led.some(x => x.result === 'CACHE_PROBE'),
    OKP.led.filter(x => /CACHE_PROBE/.test(x.result || '')).map(x => x.result).join(',') || '(none)');
  check('L4 探针确实成对发（每轮 2 次同前缀）', OKP.probed >= 2 && OKP.probed % 2 === 0, `probeHits=${OKP.probed}`);

  const NOC = await ask('l4noc', { GATE_CACHE_PROBE_MS: '1200' }, 'nocache', BIZ, 2600);
  check('L4 cached 恒 0 → reason=no_cache_impl', NOC.health?.cacheSemantics?.reason === 'no_cache_impl',
    JSON.stringify(NOC.health?.cacheSemantics || null));
  check('L4 报警 ALERT_CACHE_SEMANTICS_DRIFT', NOC.led.some(x => x.result === 'ALERT_CACHE_SEMANTICS_DRIFT'),
    NOC.led.filter(x => /CACHE_SEMANTICS/.test(x.result || '')).map(x => x.result).join(',') || '(none)');

  const BADB = await ask('l4bad', { GATE_CACHE_PROBE_MS: '1200' }, 'badblock', BIZ, 2600);
  check('L4 非 128 倍数 → reason=block_misaligned', BADB.health?.cacheSemantics?.reason === 'block_misaligned',
    JSON.stringify(BADB.health?.cacheSemantics || null));

  // 2026-11-06：探针自身有效性守卫。input 低于最小前缀门槛时 cached 必然 0，
  // 必须归为 probe_too_short 而不是 no_cache_impl —— 否则会把"prompt 太短"误报成"没有缓存"。
  check('L4 探针 prompt 长度越过门槛（>256 token）',
    (OKP.health?.cacheSemantics?.input || 0) > 256, `input=${OKP.health?.cacheSemantics?.input}`);
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
try { mock.close(); } catch {}
process.exit(fail ? 1 : 0);
