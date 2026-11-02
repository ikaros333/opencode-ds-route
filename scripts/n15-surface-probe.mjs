// 2026-11-02：多角度差分探针（官方 vs opencode 车道）
// 覆盖四类信息源：① API 端点面 ② TLS/DNS 身份面 ③ HTTP 头面 ④ 参数校验面
// 用法：$env:DEEPSEEK_API_KEY / $env:OPENCODE_GO_API_KEY 已设置后直接运行
import https from 'node:https';
import tls from 'node:tls';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'gate', 'logs');
const T = {
  official: { name: 'official', host: 'api.deepseek.com', prefix: '', key: process.env.DEEPSEEK_API_KEY || '', model: 'deepseek-flash', sess: false },
  opencode: { name: 'opencode', host: 'opencode.ai', prefix: '/zen/go', key: process.env.OPENCODE_GO_API_KEY || '', model: 'deepseek-v4.1-flash', sess: true },
};

function req(t, { method = 'GET', path: p, body = null, headers = {} } = {}) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const h = { authorization: 'Bearer ' + t.key, accept: 'application/json', ...headers };
    if (data) { h['content-type'] = 'application/json'; h['content-length'] = data.length; }
    if (t.sess) { h['x-opencode-session'] = 'surface'; h['x-opencode-session-id'] = 'surface'; }
    const r = https.request({ host: t.host, port: 443, path: t.prefix + p, method, headers: h, timeout: 60000 }, (res) => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, httpVersion: res.httpVersion, body: b }));
    });
    r.on('error', (e) => resolve({ status: 0, err: e.message }));
    r.on('timeout', () => { try { r.destroy(); } catch {} resolve({ status: 0, err: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}

const brief = (r) => {
  if (!r || r.status === 0) return 'ERR';
  if (r.status === 200) {
    try { const j = JSON.parse(r.body); return '200 ' + Object.keys(j).slice(0, 5).join(','); } catch { return '200'; }
  }
  let msg = r.body;
  try { msg = JSON.parse(r.body)?.error?.message || msg; } catch {}
  return r.status + ' ' + String(msg).replace(/\s+/g, ' ').slice(0, 70);
};

async function tlsInfo(host) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port: 443, servername: host, ALPNProtocols: ['h2', 'http/1.1'], timeout: 15000 }, () => {
      const c = s.getPeerCertificate();
      resolve({
        protocol: s.getProtocol(), alpn: s.alpnProtocol, cipher: s.getCipher()?.name,
        subject: c.subject?.CN, issuer: c.issuer?.O || c.issuer?.CN,
        san: (c.subjectaltname || '').split(',').slice(0, 4).join(',').trim(),
        validTo: c.valid_to, fp256: (s.getPeerCertificate()?.fingerprint256 || '').slice(0, 23) + '...',
      });
      s.end();
    });
    s.on('error', (e) => resolve({ error: e.message })); s.on('timeout', () => { s.destroy(); resolve({ error: 'timeout' }); });
  });
}

const ENDPOINTS = [
  ['E1 GET /v1/models', () => ({ method: 'GET', path: '/v1/models' })],
  ['E2 GET /v1/user/balance', () => ({ method: 'GET', path: '/v1/user/balance' })],
  ['E3 POST /v1/completions (FIM)', (t) => ({ method: 'POST', path: '/v1/completions', body: { model: t.model.replace('v4.1-', ''), prompt: 'def f():', max_tokens: 4 } })],
  ['E4 POST /v1/chat/completions', (t) => ({ method: 'POST', path: '/v1/chat/completions', body: { model: t.model.replace('v4.1-', ''), messages: [{ role: 'user', content: '只回答：好' }], max_tokens: 4 } })],
  ['E5 GET /v1/models/不存在', () => ({ method: 'GET', path: '/v1/models/nope-xyz' })],
  ['E6 GET /v1 (根)', () => ({ method: 'GET', path: '/v1' })],
];

const VALIDATION = [
  ['V01 temperature:-1', (t) => ({ method: 'POST', path: '/v1/responses', body: { model: t.model, input: 'hi', max_output_tokens: 4, temperature: -1 } })],
  ['V02 temperature:3', (t) => ({ method: 'POST', path: '/v1/responses', body: { model: t.model, input: 'hi', max_output_tokens: 4, temperature: 3 } })],
  ['V03 top_p:2', (t) => ({ method: 'POST', path: '/v1/responses', body: { model: t.model, input: 'hi', max_output_tokens: 4, top_p: 2 } })],
  ['V04 max_output_tokens:393217', (t) => ({ method: 'POST', path: '/v1/responses', body: { model: t.model, input: 'hi', max_output_tokens: 393217 } })],
  ['V05 reasoning.effort:minimal', (t) => ({ method: 'POST', path: '/v1/responses', body: { model: t.model, input: 'hi', max_output_tokens: 4, reasoning: { effort: 'minimal' } } })],
  ['V06 reasoning.effort:xhigh', (t) => ({ method: 'POST', path: '/v1/responses', body: { model: t.model, input: 'hi', max_output_tokens: 4, reasoning: { effort: 'xhigh' } } })],
  ['V07 tools[type=web_search]', (t) => ({ method: 'POST', path: '/v1/responses', body: { model: t.model, input: 'hi', max_output_tokens: 4, tools: [{ type: 'web_search' }] } })],
  ['V08 background:true', (t) => ({ method: 'POST', path: '/v1/responses', body: { model: t.model, input: 'hi', max_output_tokens: 4, background: true } })],
  ['V09 parallel_tool_calls:false', (t) => ({ method: 'POST', path: '/v1/responses', body: { model: t.model, input: 'hi', max_output_tokens: 4, parallel_tool_calls: false } })],
  ['V10 store:false', (t) => ({ method: 'POST', path: '/v1/responses', body: { model: t.model, input: 'hi', max_output_tokens: 4, store: false } })],
  ['V11 include:非法值', (t) => ({ method: 'POST', path: '/v1/responses', body: { model: t.model, input: 'hi', max_output_tokens: 4, include: ['foo.bar'] } })],
  ['V12 truncation:disabled', (t) => ({ method: 'POST', path: '/v1/responses', body: { model: t.model, input: 'hi', max_output_tokens: 4, truncation: 'disabled' } })],
  ['V13 metadata 60 键', (t) => ({ method: 'POST', path: '/v1/responses', body: { model: t.model, input: 'hi', max_output_tokens: 4, metadata: Object.fromEntries(Array.from({ length: 60 }, (_, i) => ['k' + i, 'v'])) } })],
  ['V14 无 auth', () => ({ method: 'POST', path: '/v1/responses', body: { model: 'x', input: 'hi', max_output_tokens: 4 }, headers: { authorization: '' } })],
];

(async () => {
  const rows = [];
  console.log('=== ① TLS / DNS 身份面 ===');
  for (const k of Object.keys(T)) {
    const ti = await tlsInfo(T[k].host);
    let ips = [];
    try { ips = (await dns.resolve4(T[k].host)).slice(0, 3); } catch { ips = ['(解析失败)']; }
    console.log(`  ${k}: protocol=${ti.protocol} alpn=${ti.alpn} cipher=${ti.cipher}`);
    console.log(`        subject=${ti.subject}  issuer=${ti.issuer}`);
    console.log(`        SAN=${ti.san}`);
    console.log(`        有效期至=${ti.validTo}  IP=${ips.join(',')}`);
    rows.push({ group: 'TLS', item: k, value: JSON.stringify({ ...ti, ips }) });
  }

  console.log('\n=== ② API 端点面 ===');
  for (const [name, f] of ENDPOINTS) {
    const o = brief(await req(T.official, f(T.official)));
    const c = brief(await req(T.opencode, f(T.opencode)));
    const mark = o.split(' ')[0] === c.split(' ')[0] ? '' : ' ★';
    console.log(`  ${name.padEnd(30)} 官方=${o.padEnd(40)} opencode=${c.padEnd(40)}${mark}`);
    rows.push({ group: 'ENDPOINT', item: name, official: o, opencode: c });
  }

  console.log('\n=== ③ HTTP 头面（一次正常 requests 调用）===');
  for (const k of Object.keys(T)) {
    const r = await req(T[k], { method: 'POST', path: '/v1/responses', body: { model: T[k].model, input: '只回答：好', max_output_tokens: 4 } });
    const h = r.headers || {};
    const pick = (n) => h[n] || '-';
    console.log(`  ${k}: http=${r.httpVersion} server=${pick('server')} x-request-id=${String(pick('x-request-id')).slice(0, 20)}`);
    console.log(`        ratelimit=${JSON.stringify(Object.fromEntries(Object.entries(h).filter(([n]) => /ratelimit|retry-after/i.test(n))))}`);
    rows.push({ group: 'HEADERS', item: k, value: JSON.stringify(Object.fromEntries(Object.entries(h).filter(([n]) => /server|x-request-id|ratelimit|via|cf-|date/i.test(n)))) });
  }

  console.log('\n=== ④ 参数校验面 ===');
  for (const [name, f] of VALIDATION) {
    const o = brief(await req(T.official, f(T.official)));
    const c = brief(await req(T.opencode, f(T.opencode)));
    const mark = o === c ? '' : ' ★';
    console.log(`  ${name.padEnd(30)} 官方=${o.padEnd(44)} opencode=${c.padEnd(44)}${mark}`);
    rows.push({ group: 'VALIDATION', item: name, official: o, opencode: c });
  }

  const diff = rows.filter(r => r.group !== 'TLS' && r.official !== r.opencode).length;
  const comparable = rows.filter(r => r.group !== 'TLS').length;
  console.log(`\n可对比项中有差异：${diff}/${comparable}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `surface-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
  console.log('结果已写入 ' + out);
})();
