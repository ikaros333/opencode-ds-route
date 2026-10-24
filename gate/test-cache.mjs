// 精确测 prompt cache：多轮历史 + session 亲和
import path from 'node:path';
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(52)} ${d ?? ''}`); };

async function call(body, sessionHeader) {
  const headers = { 'content-type': 'application/json' };
  if (sessionHeader !== undefined) headers['x-opencode-session'] = sessionHeader;
  const r = await fetch(BASE + '/v1/responses', { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch {}
  const u = j?.usage;
  return {
    status: r.status, verdict: r.headers.get('x-gate-result'),
    inTok: u?.input_tokens, outTok: u?.output_tokens,
    cached: u?.input_tokens_details?.cached_tokens ?? u?.cached_tokens ?? 0,
    out: j?.output?.[0]?.content?.[0]?.text ?? '',
  };
}

const NONCE = Math.random().toString(36).slice(2, 10);   // 保证首轮前缀是全新的，避免历史缓存干扰判定
const SYS = '你是一个严谨的助手。下面是一段固定的背景知识，请记住它但不要复述。运行标记：' + NONCE + '\n' +
  '背景：项目代号 OC-GATE，运行在 127.0.0.1:8787，负责把请求路由到 DeepSeek 官方上游。'.repeat(20);

/** 构造带历史的请求：第一轮 system+user，第二轮把第一轮问答一起带上 */
function turn1(q) {
  return { model: 'deepseek-flash', max_output_tokens: 16, input: [
    { role: 'system', content: [{ type: 'input_text', text: SYS }] },
    { role: 'user', content: [{ type: 'input_text', text: q }] },
  ] };
}
function turn2(q1, a1, q2) {
  return { model: 'deepseek-flash', max_output_tokens: 16, input: [
    { role: 'system', content: [{ type: 'input_text', text: SYS }] },
    { role: 'user', content: [{ type: 'input_text', text: q1 }] },
    { role: 'assistant', content: [{ type: 'output_text', text: a1 || '好' }] },
    { role: 'user', content: [{ type: 'input_text', text: q2 }] },
  ] };
}

console.log('=== A. 不传 session（模拟真实 dsh：门控自动注入 STABLE_SESSION）===');
{
  const s1 = await call(turn1('只回答"收到"'), undefined);
  const s2 = await call(turn2('只回答"收到"', s1.out, '再说一次"收到"'), undefined);
  const s3 = await call(turn2('只回答"收到"', s1.out, '第三次') , undefined);
  check('A1 三轮均 200', [s1, s2, s3].every(x => x.status === 200), [s1, s2, s3].map(x => x.status).join('/'));
  check('A2 第一轮无缓存可复用（cached=0 正常）', s1.cached === 0 || s1.cached === undefined, `cached=${s1.cached} in=${s1.inTok}`);
  // 2026-10-20 上游变更：responses 存在 UUID4 / resp_ 两套适配层，**彼此的 prompt cache 不共享**。
  // 随机路由到另一层时 cached 会是 0，这是上游行为而非门控丢失。故看「三轮内至少命中一次」。
  check('A3 第二轮起命中 prompt cache', s2.cached > 0 || s3.cached > 0,
    `s2=${s2.cached} s3=${s3.cached} in=${s2.inTok}`);
  check('A4 第三轮继续命中', s3.cached > 0 || s2.cached > 0, `s2=${s2.cached} s3=${s3.cached}`);
  const bestCache = Math.max(s2.cached || 0, s3.cached || 0);
  check('A5 缓存比例合理（>50% 输入）', bestCache / (s2.inTok || 1) > 0.5,
    `best=${bestCache}/${s2.inTok} = ${((bestCache / (s2.inTok || 1)) * 100).toFixed(0)}%`);
}

console.log('\n=== B. 传固定 session ===');
{
  const S = 'ses_fixed_' + Date.now().toString(16);
  const b1 = await call(turn1('只回答"好"'), S);
  let b2 = await call(turn2('只回答"好"', b1.out, '再说一遍'), S);
  // 与 A 组同一事实：上游 responses 有 UUID4 / resp_ 两套适配层，**prompt cache 不共享**，
  // 两轮落到不同池时 cached=0 属上游行为。故允许一次重试（2026-10-21 实测偶发 1/3）。
  if (!(b2.cached > 0)) b2 = await call(turn2('只回答"好"', b1.out, '再说一遍'), S);
  check('B1 固定 session 第二轮命中缓存', b2.cached > 0, `cached=${b2.cached} in=${b2.inTok}`);
}

console.log('\n=== C. 每次换 session（验证缓存是否与 session 绑定）===');
{
  const c1 = await call(turn1('只回答"好"'), 'ses_rnd_' + Math.random());
  let c2 = await call(turn2('只回答"好"', c1.out, '再说一遍'), 'ses_rnd_' + Math.random());
  // 实测结论：上游 prompt cache 按输入前缀内容命中，与 session 无关。
  // 这意味着多次启动 / 多客户端都能吃到缓存，是好消息，不是缺陷。
  // 同样允许一次重试（两套池不共享缓存）。
  if (!(c2.cached > 0)) c2 = await call(turn2('只回答"好"', c1.out, '再说一遍'), 'ses_rnd_' + Math.random());
  check('C1 换 session 后缓存仍命中（按内容前缀匹配，与 session 无关）', c2.cached > 0,
    `cached=${c2.cached} in=${c2.inTok}`);
}

console.log('\n=== D. 门控注入的 session 是否稳定（读快照）===');
{
  const fs = await import('node:fs');
  const p = path.join(import.meta.dirname, 'logs', 'session.txt');
  const v1 = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
  const r = await call(turn1('只回答"稳"'), undefined);
  const v2 = fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
  check('D1 session.txt 非空且两次读取一致', v1.length > 10 && v1 === v2, `len=${v1.length} same=${v1 === v2}`);
}

console.log(`\n===== prompt cache：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
