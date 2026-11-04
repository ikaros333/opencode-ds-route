// n22 — messages 作为主通道前的最后验证
// A M6 稳定率×20 B 成功稳定性×20 C 多轮+工具往返 D 长 system token 一致
// E 缓存上报 F 长输出 token 一致
import https from 'node:https';

const OK = process.env.DEEPSEEK_API_KEY || '';
const TK = process.env.OPENCODE_GO_API_KEY || '';
const O = { host: 'api.deepseek.com', path: '/anthropic/v1/messages', auth: { authorization: 'Bearer ' + OK, 'x-api-key': OK } };
const R = { host: 'opencode.ai', path: '/zen/go/v1/messages', auth: { 'x-api-key': TK, 'x-opencode-session': 'n22', 'x-opencode-session-id': 'n22' } };

function call(t, body) {
  return new Promise((resolve) => {
    const d = Buffer.from(JSON.stringify(body));
    const t0 = Date.now();
    const q = https.request({
      host: t.host, path: t.path, method: 'POST', timeout: 120000,
      headers: { ...t.auth, 'content-type': 'application/json', 'content-length': d.length, 'anthropic-version': '2023-06-01' },
    }, (rs) => {
      let b = '';
      rs.on('data', (c) => b += c);
      rs.on('end', () => resolve({ st: rs.statusCode, b, ms: Date.now() - t0 }));
    });
    q.on('error', (e) => resolve({ st: 0, b: e.message, ms: Date.now() - t0 }));
    q.write(d); q.end();
  });
}
const J = (r) => { try { return JSON.parse(r.b); } catch { return null; } };
const txt = (r) => (J(r)?.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('');

(async () => {
  console.log('### A. M6 ×20（官方校验器文案 + UUID4）');
  let m6 = 0, other = 0;
  for (let i = 0; i < 20; i++) {
    const r = await call(R, { model: 'deepseek-v4.1-flash', max_tokens: 2, temperature: 9, messages: [{ role: 'user', content: 'x' }] });
    const m = J(r)?.error?.message || '';
    if (r.st === 400 && /valid range of temperature is \[0, 2\]/.test(m) && /request_id:\s*[0-9a-f]{8}-[0-9a-f]{4}-4/.test(m)) m6++;
    else other++;
  }
  console.log(`   命中 ${m6}/20（其它 ${other}）`);

  console.log('\n### B. 成功请求 ×20（稳定性 + id 形态）');
  const ids = {};
  let ok = 0;
  for (let i = 0; i < 20; i++) {
    const r = await call(R, { model: 'deepseek-v4.1-flash', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] });
    if (r.st === 200) {
      ok++;
      const id = J(r)?.id || '';
      const k = id.length + 'hex';
      ids[k] = (ids[k] || 0) + 1;
    } else ids['status' + r.st] = (ids['status' + r.st] || 0) + 1;
  }
  console.log(`   200 ${ok}/20，id 分布 ${JSON.stringify(ids)}`);

  console.log('\n### C. 多轮 + 工具往返（agent 必需）');
  const tools = [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];
  const turn1 = [
    { role: 'user', content: '北京天气如何？' },
  ];
  const r1 = await call(R, { model: 'deepseek-v4.1-flash', max_tokens: 200, tools, thinking: { type: 'disabled' }, messages: turn1 });
  const toolUse = (J(r1)?.content || []).find((c) => c.type === 'tool_use');
  console.log(`   turn1: ${r1.st} tool_use=${toolUse ? '✅ ' + toolUse.name : '❌ 无'}`);
  if (toolUse) {
    const turn2 = [
      ...turn1,
      { role: 'assistant', content: [toolUse] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: '晴，26℃' }] },
    ];
    const r2 = await call(R, { model: 'deepseek-v4.1-flash', max_tokens: 200, tools, thinking: { type: 'disabled' }, messages: turn2 });
    const t2 = txt(r2);
    console.log(`   turn2(tool_result 回灌): ${r2.st} 输出="${t2.replace(/\s+/g, ' ').slice(0, 50)}"`);
    // 与官方对比同一多轮
    const o2 = await call(O, { model: 'deepseek-flash', max_tokens: 200, tools, thinking: { type: 'disabled' }, messages: turn2 });
    const oi = J(o2)?.usage?.input_tokens, gi = J(r2)?.usage?.input_tokens;
    console.log(`   多轮 input_tokens 官方=${oi} 中转=${gi} ${oi === gi ? '✅' : '❌ 差' + (gi - oi)}`);
  }

  console.log('\n### D. 长 system prompt（50KB）token 一致');
  const longSys = '背景资料：' + '这是一段用于验证长上下文分词一致性的中文文本。'.repeat(1200);
  const bodyD = (m) => ({ model: m, max_tokens: 4, thinking: { type: 'disabled' }, system: longSys, messages: [{ role: 'user', content: 'hi' }] });
  const od = await call(O, bodyD('deepseek-flash'));
  const rd = await call(R, bodyD('deepseek-v4.1-flash'));
  console.log(`   system 长度=${longSys.length} 官方=${J(od)?.usage?.input_tokens} 中转=${J(rd)?.usage?.input_tokens}`);

  console.log('\n### E. 缓存上报（同前缀两次）');
  const prefix = '缓存测试前缀：' + '这是一段固定的中文前缀内容。'.repeat(80);
  const bodyE = (m) => ({ model: m, max_tokens: 4, thinking: { type: 'disabled' }, system: prefix, messages: [{ role: 'user', content: 'hi' }] });
  const g1 = await call(R, bodyE('deepseek-v4.1-flash'));
  await new Promise((r) => setTimeout(r, 1500));
  const g2 = await call(R, bodyE('deepseek-v4.1-flash'));
  const cw = (r) => J(r)?.usage?.cache_creation_input_tokens ?? '-';
  const cr = (r) => J(r)?.usage?.cache_read_input_tokens ?? '-';
  console.log(`   中转 首次 cache_create=${cw(g1)} cache_read=${cr(g1)} / 二次 cache_create=${cw(g2)} cache_read=${cr(g2)}`);

  console.log('\n### F. 长输出 token 一致（max_tokens=800）');
  const bodyF = (m) => ({ model: m, max_tokens: 800, temperature: 0, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: '用中文写一段 300 字左右的说明文，主题是水的循环。' }] });
  const of = await call(O, bodyF('deepseek-flash'));
  const rf = await call(R, bodyF('deepseek-v4.1-flash'));
  console.log(`   官方 out=${J(of)?.usage?.output_tokens} len=${txt(of).length} / 中转 out=${J(rf)?.usage?.output_tokens} len=${txt(rf).length}`);
  console.log(`   首 40 字：官方="${txt(of).slice(0, 40)}" 中转="${txt(rf).slice(0, 40)}"`);
})();
