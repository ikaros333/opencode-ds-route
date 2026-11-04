// n21 — messages 通道放松前的可行性验证
// 目标：确认「把 messages 的 hex id 视同中性」是否安全、可用。
import https from 'node:https';

const OK = process.env.DEEPSEEK_API_KEY || '';
const TK = process.env.OPENCODE_GO_API_KEY || '';
const O = { host: 'api.deepseek.com', path: '/anthropic/v1/messages', auth: { authorization: 'Bearer ' + OK, 'x-api-key': OK } };
const R = { host: 'opencode.ai', path: '/zen/go/v1/messages', auth: { 'x-api-key': TK, 'x-opencode-session': 'n21', 'x-opencode-session-id': 'n21' } };

function call(t, body, stream = false) {
  return new Promise((resolve) => {
    const d = Buffer.from(JSON.stringify(body));
    const q = https.request({
      host: t.host, path: t.path, method: 'POST', timeout: 90000,
      headers: { ...t.auth, 'content-type': 'application/json', 'content-length': d.length, 'anthropic-version': '2023-06-01' },
    }, (rs) => {
      let b = '';
      rs.on('data', (c) => b += c);
      rs.on('end', () => resolve({ st: rs.statusCode, b, h: rs.headers, ms: Date.now() - t0 }));
    });
    const t0 = Date.now();
    q.on('error', (e) => resolve({ st: 0, b: e.message, h: {}, ms: Date.now() - t0 }));
    q.write(d); q.end();
  });
}
const J = (r) => { try { return JSON.parse(r.b); } catch { return null; } };

(async () => {
  console.log('### A. M6（官方校验器）稳定性 ×10');
  let m6 = 0;
  const shapes = {};
  for (let i = 0; i < 10; i++) {
    const r = await call(R, { model: 'deepseek-v4.1-flash', max_tokens: 4, temperature: 9, messages: [{ role: 'user', content: 'hi' }] });
    const msg = J(r)?.error?.message || '';
    const off = /valid range of temperature is \[0, 2\]/.test(msg);
    const u4 = /request_id:\s*[0-9a-f]{8}-[0-9a-f]{4}-4/.test(msg);
    if (r.st === 400 && off && u4) m6++;
  }
  console.log(`   M6 命中 ${m6}/10`);

  console.log('\n### B. messages 成功响应 id 形态 ×10');
  for (let i = 0; i < 10; i++) {
    const r = await call(R, { model: 'deepseek-v4.1-flash', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] });
    const id = J(r)?.id || '';
    const kind = /^[0-9a-f]{8}-[0-9a-f]{4}-4/.test(id) ? 'UUID4' : (id.length + 'hex');
    shapes[kind] = (shapes[kind] || 0) + 1;
  }
  console.log('   ' + JSON.stringify(shapes));

  console.log('\n### C. 带 system prompt 的 token 一致性（thinking 关闭）');
  const sys = '你是一个严谨的助手，只用中文回答，不添加多余内容。';
  const cases = ['hi', '把 3+4 的结果输出', '列出三种水果'];
  for (const c of cases) {
    const body = (m) => ({ model: m, max_tokens: 16, thinking: { type: 'disabled' }, system: sys, messages: [{ role: 'user', content: c }] });
    const o = await call(O, body('deepseek-flash'));
    const g = await call(R, body('deepseek-v4.1-flash'));
    const oi = J(o)?.usage?.input_tokens, gi = J(g)?.usage?.input_tokens;
    console.log(`   "${c.slice(0, 8)}" 官方=${oi} 中转=${gi} ${oi === gi ? '✅' : '❌ 差' + (gi - oi)}`);
  }

  console.log('\n### D. 流式 + 工具调用（agent 场景必需）');
  const tools = [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }];
  const s = await call(R, {
    model: 'deepseek-v4.1-flash', max_tokens: 200, stream: true, tools, tool_choice: { type: 'auto' },
    thinking: { type: 'disabled' }, messages: [{ role: 'user', content: '北京天气如何？调用工具' }],
  }, true);
  const evs = String(s.b).split('\n').filter((x) => x.startsWith('event:')).map((x) => x.slice(6).trim());
  const hasTool = /"type":"tool_use"/.test(s.b);
  console.log(`   状态=${s.st} 事件=${[...new Set(evs)].join(',')}`);
  console.log(`   含 tool_use=${hasTool ? '✅' : '❌'}`);

  console.log('\n### E. 确定性输出对比（temp=0，thinking 关）');
  const qs = ['3+4 等于几？只输出数字', '把 abc 反转，只输出结果', '输出 JSON: {"x":1}', '一加一等于几'];
  for (const q of qs) {
    const body = (m) => ({ model: m, max_tokens: 40, temperature: 0, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: q }] });
    const o = await call(O, body('deepseek-flash'));
    const g = await call(R, body('deepseek-v4.1-flash'));
    const txt = (r) => (J(r)?.content || []).filter((x) => x.type === 'text').map((x) => x.text).join('').replace(/\s+/g, ' ').trim();
    const a = txt(o), b = txt(g);
    console.log(`   "${q.slice(0, 10)}" 一致=${a === b ? '✅' : '❌'} | 官方="${a.slice(0, 24)}" 中转="${b.slice(0, 24)}"`);
  }

  console.log('\n### F. 延迟对比（各 3 次，thinking 关）');
  const lat = { o: [], r: [] };
  for (let i = 0; i < 3; i++) {
    const body = (m) => ({ model: m, max_tokens: 16, thinking: { type: 'disabled' }, messages: [{ role: 'user', content: 'hi' }] });
    lat.o.push((await call(O, body('deepseek-flash'))).ms);
    lat.r.push((await call(R, body('deepseek-v4.1-flash'))).ms);
  }
  const med = (a) => [...a].sort((x, y) => x - y)[1];
  console.log(`   官方=${lat.o.join(',')}ms 中位=${med(lat.o)}  中转=${lat.r.join(',')}ms 中位=${med(lat.r)}`);
})();
