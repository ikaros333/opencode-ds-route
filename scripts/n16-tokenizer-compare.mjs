// 2026-11-02：分词器一致性实验
// 目的：同一批 prompt 分别打 官方 deepseek-flash 与 opencode deepseek-v4-pro，
//       比对 usage.input_tokens 是否逐条完全一致 —— 一致说明同一分词器/同族模型在服务。
import https from 'node:https';

function call(host, prefix, key, model, txt, sess) {
  return new Promise((resolve) => {
    const d = Buffer.from(JSON.stringify({ model, input: txt, max_output_tokens: 1, reasoning: { effort: 'none' } }));
    const h = { authorization: 'Bearer ' + key, 'content-type': 'application/json', 'content-length': d.length };
    if (sess) { h['x-opencode-session'] = 'tok'; h['x-opencode-session-id'] = 'tok'; }
    const q = https.request({ host, path: prefix + '/v1/responses', method: 'POST', headers: h, timeout: 90000 }, (rs) => {
      let b = '';
      rs.on('data', (c) => b += c);
      rs.on('end', () => {
        try {
          const j = JSON.parse(b);
          resolve({ s: rs.statusCode, inTok: j?.usage?.input_tokens, cached: j?.usage?.input_tokens_details?.cached_tokens, id: j?.id });
        } catch { resolve({ s: rs.statusCode, raw: b.slice(0, 80) }); }
      });
    });
    q.on('error', (e) => resolve({ s: 0, err: e.message }));
    q.write(d); q.end();
  });
}

const PROMPTS = [
  ['纯中文', '这是一段用于分词器比对的纯中文文本，包含常见汉字与标点。'],
  ['纯英文', 'The quick brown fox jumps over the lazy dog, repeatedly and deliberately.'],
  ['中英混排', 'Hello 世界，this is 混排 test 123。'],
  ['代码', 'function f(a,b){return a.map(x=>x*b).filter(Boolean)}\n'],
  ['数字', '1234567890 9876543210 31415926535897932384626'],
  ['空白', 'a          b\n\n\n\tc'],
  ['emoji', '完成✅ 失败❌ 警告⚠️ 🚀🎯'],
  ['长中文', '背景资料：这是一段较长的中文文本，用于验证分词一致性。'.repeat(40)],
  ['重复字符', 'x'.repeat(3000)],
  ['JSON', '{"a":1,"b":[1,2,3],"c":{"d":"中文"}}'],
];

const OFFICIAL = { host: 'api.deepseek.com', prefix: '', model: 'deepseek-flash', sess: false };
const RELAY = { host: 'opencode.ai', prefix: '/zen/go', model: 'deepseek-v4-pro', sess: true };

(async () => {
  const keyO = process.env.DEEPSEEK_API_KEY || '';
  const keyP = process.env.OPENCODE_GO_API_KEY || '';
  if (!keyO || !keyP) { console.log('缺少 key'); process.exit(1); }
  let same = 0, n = 0;
  console.log('类别'.padEnd(12) + '官方in'.padStart(9) + 'v4pro in'.padStart(11) + '   一致');
  for (const [name, txt] of PROMPTS) {
    const o = await call(OFFICIAL.host, OFFICIAL.prefix, keyO, OFFICIAL.model, txt, false);
    const p = await call(RELAY.host, RELAY.prefix, keyP, RELAY.model, txt, true);
    const ok = o.inTok !== undefined && p.inTok !== undefined && o.inTok === p.inTok;
    n++; if (ok) same++;
    console.log(name.padEnd(12) + String(o.inTok ?? ('st=' + o.s)).padStart(9) + String(p.inTok ?? ('st=' + p.s)).padStart(11) + '   ' + (ok ? '✅' : '❌'));
  }
  console.log('\n分词一致性: ' + same + '/' + n);
})();
