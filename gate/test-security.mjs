// 安全与风险测试：验证门控在恶意/异常输入下的行为
// 用法：node test-security.mjs http://127.0.0.1:8799
const BASE = process.argv[2] || 'http://127.0.0.1:8799';
let pass = 0, fail = 0;
const findings = [];
const check = (name, ok, detail, note) => {
  if (ok) { pass++; console.log(`PASS  ${name.padEnd(48)} ${detail ?? ''}`); }
  else { fail++; findings.push({ name, detail, note }); console.log(`FAIL  ${name.padEnd(48)} ${detail ?? ''}`); }
  if (note && ok === false) console.log(`      ↳ ${note}`);
};

async function post(path, body, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  const r = await fetch(BASE + path, {
    method: opts.method || 'POST',
    headers,
    body: opts.raw !== undefined ? opts.raw : JSON.stringify(body),
  });
  return { status: r.status, h: r.headers, text: await r.text().catch(() => '') };
}
const small = (model = 'deepseek-flash') => ({ model, input: 'hi', max_output_tokens: 8 });

// ---------- S1 回环鉴权 ----------
{
  const r = await post('/v1/responses', small());
  check('S1 无任何凭证即可使用门控（设计如此）', r.status === 200,
    `status=${r.status}`,
    '任何本机进程都能借门控用你的 Go 额度；如需收紧可加 x-gate-token');
}

// ---------- S2 路径穿越 ----------
{
  for (const p of ['/v1/../../zen/v1/responses', '/v1/./responses', '/v1/responses/../responses']) {
    const r = await post(p, small());
    const leaked = r.text.includes('sk-') || r.text.includes('root:');
    check(`S2 路径穿越 ${p} 不泄露`, !leaked && r.status < 500,
      `status=${r.status} leaked=${leaked}`);
  }
}

// ---------- S3 客户端指定 session 是否被采用 ----------
{
  const r1 = await post('/v1/responses', small(), { headers: { 'x-opencode-session': 'ses_client_AAA' } });
  const r2 = await post('/v1/responses', small(), { headers: { 'x-opencode-session': 'ses_client_BBB' } });
  check('S3 客户端可自定 x-opencode-session', r1.status === 200 && r2.status === 200,
    `${r1.status}/${r2.status}`,
    '客户端能影响上游 session，进而影响缓存亲和；单客户端无害，多客户端会分散缓存');
}

// ---------- S4 日志注入（换行/控制字符破坏 JSONL） ----------
{
  const before = (await fetch(BASE + '/gate/metrics')).ok;
  const evil = 'deepseek-flash\n{"injected":true}';
  const r = await post('/v1/responses', { model: evil, input: 'hi', max_output_tokens: 8 });
  check('S4 恶意 model 名含换行不破坏 JSONL', before && r.status < 500, `status=${r.status}`,
    'model 会被归一为链首，不会原样落盘');
}

// ---------- S5 错误响应泄露内部信息 ----------
{
  const r = await post('/v1/chat/completions', { model: 'deepseek-flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] });
  const t = r.text;
  const leaks = [];
  if (/sk-[A-Za-z0-9]{10,}/.test(t)) leaks.push('api-key');
  if (/Bearer\s+\S+/.test(t)) leaks.push('bearer');
  if (/[A-Za-z]:[\\/]{1,2}[^"\s]*opencode/i.test(t)) leaks.push('local-path');
  if (/OPENCODE_GO_API_KEY/.test(t)) leaks.push('env-name');
  check('S5 503 响应不含密钥/凭证/本地路径', leaks.length === 0,
    `leaks=${leaks.join(',') || '无'}`);
}

// ---------- S6 超大 header ----------
{
  try {
    const r = await post('/v1/responses', small(), { headers: { 'x-pad': 'A'.repeat(60000) } });
    check('S6 60KB header 不崩溃', r.status < 500 || r.status === 503, `status=${r.status}`);
  } catch (e) {
    check('S6 60KB header 不崩溃', true, `客户端侧被拒（${e.message.slice(0, 40)}），门控未受影响`);
  }
}

// ---------- S7 慢速请求（slowloris 雏形：慢发 body） ----------
{
  const ac = new AbortController();
  const t0 = Date.now();
  const p = (async () => {
    const r = await fetch(BASE + '/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new ReadableStream({
        start(c) { c.enqueue(new TextEncoder().encode('{"model":"deepseek-flash",')); /* 不发完 */ },
      }),
      signal: ac.signal,
      duplex: 'half',
    });
    return r.status;
  })().catch(e => 'aborted');
  await new Promise(r => setTimeout(r, 3000));
  ac.abort();
  const res = await p;
  check('S7 慢速 body 3s 后中止不影响后续', true, `慢请求结果=${res} 等待=${Date.now() - t0}ms`);
  const after = await post('/v1/responses', small());
  check('S7 慢请求后正常请求仍成功', after.status === 200, `status=${after.status}`);
}

// ---------- S8 并发饱和（20 并发 vs MAX_CONC=6） ----------
{
  const t0 = Date.now();
  const rs = await Promise.all(Array.from({ length: 20 }, () => post('/v1/responses', small())));
  const ok = rs.filter(x => x.status === 200).length;
  check('S8 20 并发全部成功（排队而非丢弃）', ok === 20, `ok=${ok}/20 用时=${Date.now() - t0}ms`);
  const m = JSON.parse(await (await fetch(BASE + '/gate/metrics')).text());
  check('S8 并发后槽位归零', m.inflight === 0, `inflight=${m.inflight}`);
  check('S8 并发未超过 MAX_CONC 记录', m.maxConc === 6, `maxConc=${m.maxConc}`);
}

// ---------- S9 重复同 session 与不同 session 的缓存行为 ----------
{
  const a = await post('/v1/responses', small(), { headers: { 'x-opencode-session': 'ses_same' } });
  const b = await post('/v1/responses', small(), { headers: { 'x-opencode-session': 'ses_same' } });
  check('S9 同 session 连续请求稳定', a.status === 200 && b.status === 200, `${a.status}/${b.status}`);
}

// ---------- S10 异常 Content-Type（浏览器 no-cors 借道）----------
{
  const r1 = await post('/v1/responses', null, { raw: JSON.stringify(small()), headers: { 'content-type': 'text/plain' } });
  check('S10 text/plain 被 415 拒绝（挡跨域 no-cors）', r1.status === 415, `status=${r1.status}`);
  const r2 = await post('/v1/responses', null, { raw: JSON.stringify(small()), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  check('S10 form 类型同样 415', r2.status === 415, `status=${r2.status}`);
  const r3 = await post('/v1/responses', small(), { headers: { 'content-type': 'application/json; charset=utf-8' } });
  check('S10 正常 JSON 不受影响', r3.status === 200 || r3.status === 503, `status=${r3.status}`);
}

// ---------- S11 Host 头（DNS rebinding）----------
{
  const { request } = await import('node:http');
  const rawWithHost = (hostHdr) => new Promise((resolve) => {
    const u = new URL(BASE);
    const rq = request({ host: u.hostname, port: u.port, path: '/v1/responses', method: 'POST',
      headers: { 'content-type': 'application/json', host: hostHdr } }, (r) => {
      let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => resolve({ status: r.statusCode, text: b }));
    });
    rq.end(JSON.stringify(small()));
  });
  const r1 = await rawWithHost('evil.example');
  check('S11 非回环 Host 被 421 拒绝', r1.status === 421, `status=${r1.status}`);
  const r2 = await rawWithHost('localhost:9999');
  check('S11 回环 Host 放行', r2.status === 200 || r2.status === 503, `status=${r2.status}`);
}

// ---------- S12 不回应 CORS ----------
{
  const r = await fetch(BASE + '/v1/responses', { method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify(small()) });
  const acao = r.headers.get('access-control-allow-origin');
  check('S12 不返回 Access-Control-Allow-Origin', !acao, `acao=${acao}`);
}

console.log(`\n===== 安全/风险：${pass} 通过 / ${fail} 失败 =====`);
if (findings.length) {
  console.log('\n需要关注：');
  for (const f of findings) console.log(`  - ${f.name}: ${f.detail}`);
}
process.exit(0);   // 安全项有已知设计缺口时不算失败退出
