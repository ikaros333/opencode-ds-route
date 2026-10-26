// 综合测试套件：对影子门控实例做黑盒测试，找出真实行为与预期的差异
// 用法：node test-suite.mjs http://127.0.0.1:8799
const BASE = process.argv[2] || 'http://127.0.0.1:8799';
const SESS = 'ses_suite_' + Math.random().toString(16).slice(2, 10);

let pass = 0, fail = 0;
const failures = [];

function record(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS  ${name.padEnd(46)} ${detail ?? ''}`); }
  else { fail++; failures.push({ name, detail }); console.log(`FAIL  ${name.padEnd(46)} ${detail ?? ''}`); }
}

async function call(path, body, opts = {}) {
  const headers = { 'content-type': 'application/json', 'x-opencode-session': SESS, ...(opts.headers || {}) };
  const t0 = Date.now();
  const method = opts.method || 'POST';
  const hasBody = method !== 'GET' && method !== 'HEAD' && body != null || opts.raw !== undefined;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: hasBody ? (opts.raw !== undefined ? opts.raw : (typeof body === 'string' ? body : JSON.stringify(body))) : undefined,
    signal: opts.signal,
  });
  const text = await res.text().catch(() => '');
  return { status: res.status, headers: res.headers, text, ms: Date.now() - t0 };
}

const small = (model) => ({ model, input: 'hi', max_output_tokens: 8 });

// ---------- 1. 基础健康 ----------
{
  const r = await call('/gate/health', null, { method: 'GET' });
  let j = {}; try { j = JSON.parse(r.text); } catch {}
  record('GET /gate/health 返回 ok', r.status === 200 && j.ok === true, `status=${r.status} ok=${j.ok}`);
  record('health 里 chain 已剔除禁止模型',
    Array.isArray(j.chain) && !j.chain.includes('deepseek-v4-flash') && !j.chain.includes('deepseek-flash-1017'),
    `chain=${JSON.stringify(j.chain)}`);
  record('health 报 blind=block（开关已固定为 block）', j.blind === 'block', `blind=${j.blind}`);
}
{
  const r = await call('/gate/metrics', null, { method: 'GET' });
  let j = {}; try { j = JSON.parse(r.text); } catch {}
  record('GET /gate/metrics 含 laneRetries 字段', r.status === 200 && 'laneRetries' in j, `keys=${Object.keys(j).length}`);
}
{
  const r = await call('/gate/matrix', null, { method: 'GET' });
  let j = {}; try { j = JSON.parse(r.text); } catch {}
  record('GET /gate/matrix 返回 rows', r.status === 200 && Array.isArray(j.rows), `rows=${j.rows?.length}`);
  const bad = (j.rows || []).filter(x => x.verdict === 'error');
  record('矩阵里不含 error 条目', bad.length === 0, `errorRows=${bad.length}`);
}

// ---------- 2. 正常请求 ----------
{
  const r = await call('/v1/responses', small('deepseek-flash'));
  record('非流式 responses 成功', r.status === 200, `status=${r.status} verdict=${r.headers.get('x-gate-result')}`);
  record('非流式判官方（official 或 proof 放行）',
    ['official', 'pass-by-proof'].includes(r.headers.get('x-gate-result'))
      && ['UUID4', 'resp_uuid4', 'resp_'].includes(r.headers.get('x-gate-id-shape')),
    `${r.headers.get('x-gate-result')}/${r.headers.get('x-gate-id-shape')}`);
}
{
  const r = await call('/v1/responses', { ...small('deepseek-flash'), stream: true }, { headers: { accept: 'text/event-stream' } });
  record('流式 responses 成功', r.status === 200 && r.headers.get('content-type')?.includes('event-stream') !== false,
    `status=${r.status} ctype=${r.headers.get('content-type')}`);
  record('流式响应体非空', r.text.length > 0, `bytes=${r.text.length}`);
}

// ---------- 3. 模型归一 ----------
{
  const r = await call('/v1/responses', small('deepseek-v4-flash'));
  record('禁止模型 deepseek-v4-flash 被改道（仍成功）', r.status === 200, `status=${r.status}`);
}
{
  const r = await call('/v1/responses', small('deepseek-flash-1017'));
  record('禁止模型 deepseek-flash-1017 被改道（仍成功）', r.status === 200, `status=${r.status}`);
}
{
  const r = await call('/v1/responses', small('gpt-4o-not-exist'));
  record('不存在的模型被改道而非报错', r.status === 200, `status=${r.status}`);
}
{
  const r = await call('/v1/responses', { input: 'hi', max_output_tokens: 8 });   // 完全没有 model
  record('缺失 model 字段仍能工作', r.status === 200, `status=${r.status}`);
}

// ---------- 4. 输入边界 ----------
{
  const r = await call('/v1/responses', null, { raw: '' });
  record('空 body 返回 400', r.status === 400, `status=${r.status} ${r.text.slice(0, 80)}`);
}
{
  const r = await call('/v1/responses', null, { raw: 'not-json' });
  record('非法 JSON 返回 400', r.status === 400, `status=${r.status}`);
}
{
  const bom = '\uFEFF' + JSON.stringify(small('deepseek-flash'));
  const r = await call('/v1/responses', null, { raw: bom });
  record('BOM 前缀 body 被正确剥离', r.status === 200, `status=${r.status}`);
}
{
  const r = await call('/v1/responses', { model: 'deepseek-flash', input: 'hi', max_output_tokens: 8, unknown_field: 'x' });
  record('未知字段透传不影响', r.status === 200, `status=${r.status}`);
}

// ---------- 5. 协议与路径 ----------
{
  const r = await call('/v1/messages', { model: 'deepseek-flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] });
  // messages 协议按策略封禁（无可用官方性判据）；未封禁时应为 200
  {
    const blocked = r.status === 503 && (r.headers.get('x-gate-reason') || '') === 'proto_blocked';
    const usable = r.status === 200;
    record('messages 协议：可用或已被策略封禁', blocked || usable,
      `status=${r.status} reason=${r.headers.get('x-gate-reason') || ''} verdict=${r.headers.get('x-gate-result')}`);
  }
}
{
  let allowAll = false;
  try {
    const pr = await fetch(BASE + '/gate/proof');
    const pj = await pr.json();
    allowAll = pj?.gate?.allowAllLanes === true;
  } catch {}
  const r = await call('/v1/chat/completions', { model: 'deepseek-flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] });
  // ★ 第 17 轮行为变更：chat 协议已被策略封禁（GATE_BLOCK_PROTOS=chat）。
  // 原因：chat 下参数不校验（E2/E3 无效）、错误被网关吞（E1 无效）、无可靠 logprob 位置（P1 假）
  //      → 它在三条身份判据上全空，任何后端（含自部署）接上 chat 都畅通。
  // 断言语义随之从「proof 高信任时放行」改为「一律显式拒绝」。
  if (allowAll) {
    let cj = {}; try { cj = JSON.parse(r.text); } catch {}
    record('chat 协议：已被策略封禁（identity-only）',
      r.status === 503 && cj?.error?.type === 'gate_proto_blocked',
      `status=${r.status} type=${cj?.error?.type}`);
  }
  // 期望变更（2026-10-20）：预检（chat=logprob 精度）是独立于周期 proof 的证明源。
  // 预检通过时不必依赖 proof 即可交付（x-gate-result=pass-by-proof）。
  // 真正必须守住的不变量是：绝不在「没有任何官方性证据」时交付。
  else record('chat 协议：无有效 proof 时要么有预检证明、要么 fail-closed',
    r.status === 503 || ['pass-by-proof', 'official'].includes(r.headers.get('x-gate-result')),
    `status=${r.status} result=${r.headers.get('x-gate-result')}`);
}
{
  const r = await call('/v1/unknown/path', small('deepseek-flash'));
  record('未知子路径不崩溃', r.status < 500 || r.status === 503, `status=${r.status}`);
}

// ---------- 6. 并发 ----------
{
  const t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: 10 }, () => call('/v1/responses', small('deepseek-flash'))));
  const ok = rs.filter(x => x.status === 200).length;
  record('并发 10 个请求全部成功', ok === 10, `ok=${ok}/10 用时=${Date.now() - t0}ms`);
}

// ---------- 7. 客户端提前断开 ----------
{
  const ctrl = new AbortController();
  const p = call('/v1/responses', { model: 'deepseek-flash', input: '写一段 200 字的话', max_output_tokens: 200, stream: true }, { signal: ctrl.signal });
  setTimeout(() => ctrl.abort(), 600);
  try { await p; } catch {}
  await new Promise(r => setTimeout(r, 1500));
  const m = JSON.parse((await call('/gate/metrics', null, { method: 'GET' })).text);
  record('客户端断开被计数（abortedByClient）', m.abortedByClient >= 1, `abortedByClient=${m.abortedByClient}`);
  await new Promise(r => setTimeout(r, 2500));   // 等上游释放
  const m2 = JSON.parse((await call('/gate/metrics', null, { method: 'GET' })).text);
  record('断开后并发槽位已释放', m2.inflight === 0, `inflight=${m2.inflight}`);
}

// ---------- 8. 其它方法 ----------
{
  const r = await call('/gate/health', null, { method: 'POST', raw: '{}' });
  record('POST /gate/health 不崩溃', r.status < 500, `status=${r.status}`);
}
{
  const r = await call('/v1/responses', null, { method: 'PUT', raw: '{}' });
  record('PUT /v1/responses 不崩溃', r.status < 500 || r.status === 503, `status=${r.status}`);
}

console.log(`\n===== 合计 ${pass} 通过 / ${fail} 失败 =====`);
if (failures.length) {
  console.log('\n失败明细：');
  for (const f of failures) console.log(`  - ${f.name}: ${f.detail ?? ''}`);
}
process.exit(fail === 0 ? 0 : 1);
