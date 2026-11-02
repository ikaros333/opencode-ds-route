// 2026-11-02：候选强判据探针（官方 vs opencode 车道，同一组特性请求）
// 用法：
//   $env:DEEPSEEK_API_KEY='sk-...'   （官方）
//   $env:OPENCODE_GO_API_KEY='...'   （opencode）
//   node scripts/n14-feature-probe.mjs
// 输出：控制台对照表 + gate/logs/feature-probe-<ts>.json
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'gate', 'logs');
const TARGETS = [
  { name: 'official', host: 'api.deepseek.com', prefix: '',                  key: process.env.DEEPSEEK_API_KEY || '', model: 'deepseek-flash', session: false },
  { name: 'opencode', host: 'opencode.ai',      prefix: '/zen/go',           key: process.env.OPENCODE_GO_API_KEY || '', model: 'deepseek-v4.1-flash', session: true },
];

function call(t, body) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(body));
    const headers = { 'content-type': 'application/json', 'content-length': data.length, authorization: 'Bearer ' + t.key };
    if (t.session) { headers['x-opencode-session'] = 'n14-probe'; headers['x-opencode-session-id'] = 'n14-probe'; }
    const req = https.request({
      host: t.host, port: 443, path: t.prefix + '/v1/responses', method: 'POST', headers, timeout: 120000,
    }, (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => {
        let j = null; try { j = JSON.parse(b); } catch {}
        resolve({ status: res.statusCode, j, raw: b.slice(0, 400) });
      });
    });
    req.on('error', (e) => resolve({ status: 0, j: null, raw: 'ERR ' + e.message }));
    req.write(data); req.end();
  });
}

const base = (m) => ({ model: m, input: '只回答：好', max_output_tokens: 8, reasoning: { effort: 'none' } });

const FEATURES = [
  ['F01 控制组', (m) => base(m)],
  ['F02 store+previous_response_id', (m) => ({ ...base(m), store: true })],
  ['F03 truncation:auto', (m) => ({ ...base(m), truncation: 'auto' })],
  ['F04 max_tool_calls:1', (m) => ({ ...base(m), max_tool_calls: 1, tools: [{ type: 'function', name: 'a', parameters: { type: 'object', properties: {} } }, { type: 'function', name: 'b', parameters: { type: 'object', properties: {} } }] })],
  ['F05 top_logprobs:2', (m) => ({ ...base(m), top_logprobs: 2 })],
  ['F06 include 加密推理', (m) => ({ ...base(m), include: ['reasoning.encrypted_content'] })],
  ['F07 prompt_cache_key', (m) => ({ ...base(m), prompt_cache_key: 'pc-k1' })],
  ['F08 safety_identifier', (m) => ({ ...base(m), safety_identifier: 'sid-1' })],
  ['F09 service_tier:priority', (m) => ({ ...base(m), service_tier: 'priority' })],
  ['F10 frequency_penalty:1.5', (m) => ({ ...base(m), frequency_penalty: 1.5 })],
  ['F11 metadata 回显', (m) => ({ ...base(m), metadata: { probe: 'n14' } })],
  ['F12 user', (m) => ({ ...base(m), user: 'u-1' })],
  ['F13 幽灵 previous_response_id', (m) => ({ ...base(m), previous_response_id: 'resp_doesnotexist' })],
  ['F14 max_output_tokens:0', (m) => ({ ...base(m), max_output_tokens: 0 })],
  ['F15 temperature:9', (m) => ({ ...base(m), temperature: 9 })],
  ['F16 text.format json', (m) => ({ ...base(m), text: { format: { type: 'json_object' } } })],
];

const sig = (r) => {
  if (r.status === 0) return 'ERR';
  if (r.status === 200) return '200';
  const m = (r.j && r.j.error && r.j.error.message) || r.raw;
  return r.status + ' ' + String(m).replace(/\s+/g, ' ').slice(0, 90);
};

(async () => {
  const rows = [];
  for (const [name, build] of FEATURES) {
    const row = { feature: name, official: null, opencode: null };
    for (const t of TARGETS) {
      if (!t.key) { row[t.name] = { status: -1, sig: '无 key' }; continue; }
      const r = await call(t, build(t.model));
      row[t.name] = { status: r.status, sig: sig(r) };
    }
    rows.push(row);
    const o = row.official, c = row.opencode;
    const same = o.sig === c.sig;
    console.log(`${name.padEnd(32)} 官方=${String(o.sig).padEnd(46)} opencode=${String(c.sig).padEnd(46)} ${same ? '（相同）' : '★不同'}`);
  }
  const diff = rows.filter(r => r.official.sig !== r.opencode.sig).length;
  console.log(`\n有差异的特性：${diff}/${rows.length}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const out = path.join(OUT_DIR, `feature-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
  console.log('结果已写入 ' + out);
})();
