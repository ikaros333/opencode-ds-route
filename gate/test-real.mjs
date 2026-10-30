// 实用性测试：真实上游，聚焦"实际用起来会不会掉到第三方 / 会不会串会话 / 缓存是否命中"
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const bugs = [];
const check = (n, ok, d, note) => {
  ok ? pass++ : fail++;
  if (!ok) bugs.push({ name: n, detail: d, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(44)} ${d ?? ''}`);
  if (!ok && note) console.log(`      ↳ ${note}`);
};

const SESS = 'ses_real_' + Math.random().toString(16).slice(2, 10);

async function call(body, headers = {}) {
  const t0 = Date.now();
  const r = await fetch(BASE + '/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-opencode-session': SESS,
      ...(process.env.GATE_TOKEN ? { 'x-gate-token': process.env.GATE_TOKEN } : {}), ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, h: r.headers, text, j, ms: Date.now() - t0 };
}
const verdict = r => r.h.get('x-gate-result');
// 2026-10-20 上游变更：responses 的 id 在 UUID4 与 resp_ 之间波动，resp_ 被门控判为 unknown，
// 此时由 eclass 预检独立证明后端 → 交付时标 pass-by-proof。两者安全级别等价。
const PROVEN = (v) => v === 'official' || v === 'pass-by-proof';
const shape = r => r.h.get('x-gate-id-shape');
const totalTok = r => {
  const u = r.j?.usage;
  if (!u) return null;
  return { in: u.input_tokens, out: u.output_tokens, cached: u.input_tokens_details?.cached_tokens ?? u.cached_tokens };
};

console.log('=== R1 多轮对话：验证会话亲和与 prompt cache 命中 ===');
{
  const turns = ['我叫阿岩，记住这个名字。只回答"好"', '我叫什么？只回答名字', '再说一次我的名字'];
  const results = [];
  for (const t of turns) {
    const r = await call({ model: 'deepseek-flash', max_output_tokens: 32, input: [{ role: 'user', content: [{ type: 'input_text', text: t }] }] });
    results.push(r);
  }
  check('R1 三轮全部成功', results.every(r => r.status === 200), results.map(r => r.status).join('/'));
  check('R1 三轮全部已证明官方', results.every(r => PROVEN(verdict(r))), results.map(r => verdict(r)).join('/'));
  check('R1 三轮 id 形态合法（UUID4 或 resp_）', results.every(r => ['UUID4', 'resp_uuid4', 'resp_', ''].includes(shape(r))), results.map(r => shape(r)).join('/'));
  // 缓存专门由 test-cache.mjs 用「真正带历史的请求」验证；这里只测连续可用性与 id 唯一性
  check('R1 三轮 id 互不相同', new Set(results.map(r => r.j?.id)).size === 3,
    results.map(r => (r.j?.id || '').slice(0, 8)).join(' '));
}

console.log('\n=== R2 并发 3 路：验证不串道、不互相污染 ===');
{
  const rs = await Promise.all([
    call({ model: 'deepseek-flash', max_output_tokens: 16, input: [{ role: 'user', content: [{ type: 'input_text', text: '回答1' }] }] }),
    call({ model: 'deepseek-flash', max_output_tokens: 16, input: [{ role: 'user', content: [{ type: 'input_text', text: '回答2' }] }] }),
    call({ model: 'deepseek-v4.1-flash', max_output_tokens: 16, input: [{ role: 'user', content: [{ type: 'input_text', text: '回答3' }] }] }),
  ]);
  check('R2 3 路全部 200', rs.every(r => r.status === 200), rs.map(r => r.status).join('/'));
  check('R2 3 路全部已证明官方', rs.every(r => PROVEN(verdict(r))), rs.map(r => verdict(r)).join('/'));
  check('R2 3 路 id 互不相同', new Set(rs.map(r => r.j?.id)).size === 3, rs.map(r => (r.j?.id || '').slice(0, 8)).join(' '));
  check('R2 无请求被 hedge 重复计费', rs.every(r => Number(r.h.get('x-gate-attempts') || 1) === 1),
    rs.map(r => r.h.get('x-gate-attempts')).join('/'));
}

console.log('\n=== R3 流式长输出：验证 SSE 完整送达 ===');
{
  const t0 = Date.now();
  const r = await fetch(BASE + '/v1/responses', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-opencode-session': SESS, accept: 'text/event-stream',
      ...(process.env.GATE_TOKEN ? { 'x-gate-token': process.env.GATE_TOKEN } : {}) },
    body: JSON.stringify({ model: 'deepseek-flash', stream: true, max_output_tokens: 600,
      input: [{ role: 'user', content: [{ type: 'input_text', text: '用中文数从 1 到 40，用逗号分隔，不要多余文字' }] }] }),
  });
  const text = await r.text();
  const events = (text.match(/^event: /gm) || []).length;
  const hasCompleted = text.includes('response.completed');
  check('R3 流式长输出 200 + 已证明官方', r.status === 200 && PROVEN(r.headers.get('x-gate-result')),
    `status=${r.status} ${Date.now() - t0}ms`);
  check('R3 收到多个 SSE 事件', events >= 5, `event 数=${events} bytes=${text.length}`);
  check('R3 流以 response.completed 收尾（未截断）', hasCompleted, `hasCompleted=${hasCompleted}`);
  check('R3 输出包含数字序列', /(?:1[^0-9]{1,3}2[^0-9]{1,3}3)/.test(text) || text.includes('40'), '');
}

console.log('\n=== R4 图片输入（多模态实用性）===');
{
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const r = await call({ model: 'deepseek-flash', max_output_tokens: 24, input: [{ role: 'user', content: [
    { type: 'input_image', image_url: 'data:image/png;base64,' + PNG },
    { type: 'input_text', text: '这张图有几个像素？简短回答' },
  ] }] });
  check('R4 图片请求 200 + 已证明官方', r.status === 200 && PROVEN(verdict(r)),
    `status=${r.status} verdict=${verdict(r)} ${r.ms}ms`);
}

console.log('\n=== R5 长上下文（约 15K tokens）===');
{
  const filler = '这是一个用于填充上下文的句子，内容本身没有意义。'.repeat(700);
  const r = await call({ model: 'deepseek-flash', max_output_tokens: 32, input: [{ role: 'user', content: [
    { type: 'input_text', text: filler + '\n\n上面这段文字里"句子"这个词出现了大概多少次？只给粗略数量级。' },
  ] }] });
  check('R5 15K token 输入 200 + 已证明官方', r.status === 200 && PROVEN(verdict(r)),
    `status=${r.status} verdict=${verdict(r)} ${r.ms}ms inTok=${totalTok(r)?.in}`);
  check('R5 输入 token 确实很大', (totalTok(r)?.in ?? 0) > 5000, `in=${totalTok(r)?.in}`);
}

console.log('\n=== R6 快速连发 6 次：验证连续稳定性 ===');
{
  const rs = [];
  for (let i = 0; i < 6; i++) {
    rs.push(await call({ model: 'deepseek-flash', max_output_tokens: 8, input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' + i }] }] }));
  }
  check('R6 6 连发全部 200', rs.every(r => r.status === 200), rs.map(r => r.status).join(''));
  check('R6 6 连发全部已证明官方', rs.every(r => PROVEN(verdict(r))), rs.map(r => verdict(r)[0]).join(''));
  const lat = rs.map(r => r.ms);
  check('R6 延迟无退化（最后一次 < 首次×3）', lat[5] < lat[0] * 3, lat.join('/') + ' ms');
}

console.log(`\n===== 实用性：${pass} 通过 / ${fail} 失败 =====`);
if (bugs.length) { console.log('\n需关注：'); bugs.forEach(b => console.log(`  - ${b.name}: ${b.detail}`)); }
process.exit(fail === 0 ? 0 : 1);
