// n23 — 验证「沉默即非官方」假设：官方对非法参数是否必拒
import https from 'node:https';

const OK = process.env.DEEPSEEK_API_KEY || '';

function post(host, path, body) {
  return new Promise((resolve) => {
    const d = Buffer.from(JSON.stringify(body));
    const q = https.request({
      host, path, method: 'POST', timeout: 40000,
      headers: { authorization: 'Bearer ' + OK, 'x-api-key': OK, 'content-type': 'application/json', 'content-length': d.length, 'anthropic-version': '2023-06-01' },
    }, (rs) => {
      let b = '';
      rs.on('data', (c) => b += c);
      rs.on('end', () => { try { resolve({ st: rs.statusCode, j: JSON.parse(b) }); } catch { resolve({ st: rs.statusCode, j: null, b: b.slice(0, 60) }); } });
    });
    q.on('error', () => resolve({ st: 0, j: null }));
    q.write(d); q.end();
  });
}

const cases = [
  ['responses temperature:9', '/v1/responses', { model: 'deepseek-flash', input: 'hi', max_output_tokens: 4, reasoning: { effort: 'none' }, temperature: 9 }],
  ['responses max_output_tokens:0', '/v1/responses', { model: 'deepseek-flash', input: 'hi', max_output_tokens: 0, reasoning: { effort: 'none' } }],
  ['responses 假模型', '/v1/responses', { model: 'no-such-model-xyz', input: 'hi', max_output_tokens: 4, reasoning: { effort: 'none' } }],
  ['messages temperature:9', '/anthropic/v1/messages', { model: 'deepseek-flash', max_tokens: 4, temperature: 9, messages: [{ role: 'user', content: 'hi' }] }],
  ['messages max_tokens:0', '/anthropic/v1/messages', { model: 'deepseek-flash', max_tokens: 0, messages: [{ role: 'user', content: 'hi' }] }],
  ['messages 假模型', '/anthropic/v1/messages', { model: 'no-such-model-xyz', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }],
];

console.log('=== 官方对各协议的非法参数反应 ===');
for (const [name, path, body] of cases) {
  const r = await post('api.deepseek.com', path, body);
  const m = r.j?.error?.message || '';
  const rejected = r.st >= 400;
  console.log('  ' + name.padEnd(28) + ' st=' + r.st + (rejected ? '  拒: ' + m.slice(0, 56) : '  ⚠ 未拒（200）'));
}
