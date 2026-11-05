// n24 — 假模型 / max_tokens 越界 在两个车道上的表现（EV14 / EV15 判据预演）
import https from 'node:https';

const OK = process.env.DEEPSEEK_API_KEY || '';
const TK = process.env.OPENCODE_GO_API_KEY || '';
const H = {
  off: { authorization: 'Bearer ' + OK, 'x-api-key': OK },
  rel: { authorization: 'Bearer ' + TK, 'x-api-key': TK, 'x-opencode-session': 'n24', 'x-opencode-session-id': 'n24' },
};
const LANES = [
  ['官方', 'api.deepseek.com', '', 'deepseek-flash', H.off],
  ['中转', 'opencode.ai', '/zen/go', 'deepseek-v4.1-flash', H.rel],
];
const FAKE = 'no-such-model-xyz-9f3a';

function post(host, path, hdr, body) {
  return new Promise((resolve) => {
    const d = Buffer.from(JSON.stringify(body));
    const q = https.request({ host, path, method: 'POST', timeout: 40000,
      headers: { ...hdr, 'content-type': 'application/json', 'content-length': d.length, 'anthropic-version': '2023-06-01' } },
    (rs) => { let b = ''; rs.on('data', (c) => b += c); rs.on('end', () => { try { resolve({ st: rs.statusCode, j: JSON.parse(b) }); } catch { resolve({ st: rs.statusCode, j: null }); } }); });
    q.on('error', () => resolve({ st: 0, j: null }));
    q.write(d); q.end();
  });
}
const M = (r) => r.j?.error?.message || '';

// 官方专有文案：假模型会回「支持的模型清单」
const OFFICIAL_LIST = /The supported API model names are|supported model names? are/i;

const probes = [
  ['V3 responses 假模型', (p, m) => ['/v1/responses', { model: FAKE, input: 'hi', max_output_tokens: 4, reasoning: { effort: 'none' } }]],
  ['V3 messages  假模型', (p, m) => ['/v1/messages', { model: FAKE, max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }]],
  ['V3 chat      假模型', (p, m) => ['/v1/chat/completions', { model: FAKE, max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }]],
  ['V2 messages  max_tokens:0', (p, m) => ['/v1/messages', { model: m, max_tokens: 0, messages: [{ role: 'user', content: 'hi' }] }]],
  ['V2 chat      max_tokens:0', (p, m) => ['/v1/chat/completions', { model: m, max_tokens: 0, messages: [{ role: 'user', content: 'hi' }] }]],
];

for (const [lname, host, prefix, model, hdr] of LANES) {
  console.log('\n=== ' + lname + ' (' + host + prefix + ') ===');
  for (const [pname, mk] of probes) {
    const [path, body] = mk(prefix, model);
    const r = await post(host, prefix + path, hdr, body);
    const m = M(r);
    const isList = OFFICIAL_LIST.test(m);
    console.log('  ' + pname.padEnd(26) + ' st=' + String(r.st).padEnd(4) +
      (isList ? '✅ 官方模型清单文案' : (r.st === 200 ? '⚠ 200 未拒（有自己的注册表）' : 'm=' + m.slice(0, 46))));
  }
}
