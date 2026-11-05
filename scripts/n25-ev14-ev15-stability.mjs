// n25 — EV14/EV15 判据的稳定性复验（正确路径 + 各 3 次）
// 官方 messages 走 /anthropic/v1/messages；中转走 /v1/messages
import https from 'node:https';

const OK = process.env.DEEPSEEK_API_KEY || '';
const TK = process.env.OPENCODE_GO_API_KEY || '';
const H = {
  off: { authorization: 'Bearer ' + OK, 'x-api-key': OK },
  rel: { authorization: 'Bearer ' + TK, 'x-api-key': TK, 'x-opencode-session': 'n25', 'x-opencode-session-id': 'n25' },
};
const FAKE = 'no-such-model-xyz-9f3a';
const OFFICIAL_LIST = /The supported API model names are/i;
const RELAY_WRAP = /^\s*Upstream request failed[:：]/i;

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
const M = (r) => (r.j?.error?.message || r.j?.message || '') + '';

const LANES = [
  { name: '官方', host: 'api.deepseek.com', prefix: '', msgPath: '/anthropic/v1/messages', model: 'deepseek-flash', hdr: H.off },
  { name: '中转', host: 'opencode.ai', prefix: '/zen/go', msgPath: '/v1/messages', model: 'deepseek-v4.1-flash', hdr: H.rel },
];

for (const L of LANES) {
  console.log('\n===== ' + L.name + ' ' + L.host + L.prefix + ' =====');
  const probes = [
    ['responses 假模型', '/v1/responses', { model: FAKE, input: 'hi', max_output_tokens: 4, reasoning: { effort: 'none' } }],
    ['messages  假模型', L.msgPath, { model: FAKE, max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }],
    ['chat      假模型', '/v1/chat/completions', { model: FAKE, max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }],
    ['messages  mt:0', L.msgPath, { model: L.model, max_tokens: 0, messages: [{ role: 'user', content: 'hi' }] }],
    ['chat      mt:0', '/v1/chat/completions', { model: L.model, max_tokens: 0, messages: [{ role: 'user', content: 'hi' }] }],
  ];
  for (const [pname, path, body] of probes) {
    const seen = [];
    for (let i = 0; i < 3; i++) {
      const r = await post(L.host, L.prefix + path, L.hdr, body);
      const m = M(r);
      const offList = OFFICIAL_LIST.test(m);
      const wrap = RELAY_WRAP.test(m);
      seen.push({ st: r.st, offList, wrap, head: m.slice(0, 40) });
    }
    const st = seen.map((x) => x.st).join('/');
    const off = seen.filter((x) => x.offList).length;
    const wr = seen.filter((x) => x.wrap).length;
    console.log('  ' + pname.padEnd(18) + ' st=' + st.padEnd(12) +
      ' 官方名单文案=' + off + '/3' + '  包装前缀=' + wr + '/3' +
      '  | ' + (seen[0].head || '(空)'));
  }
}
