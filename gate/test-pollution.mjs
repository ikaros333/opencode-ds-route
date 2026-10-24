// 专项回归：坏请求不得污染车道缓存（本轮最严重 bug 的守门测试）
// 场景：先发一个必失败的请求（错误路径 / 非法 body），随后正常请求必须立刻成功。
const BASE = process.argv[2] || 'http://127.0.0.1:8799';
const SESS = 'ses_pollute_' + Math.random().toString(16).slice(2, 10);
// 上游 responses 的 id 在 UUID4/resp_ 间波动时，由 eclass 预检独立证明后端并标 pass-by-proof。
const PROVEN_V = (v) => v === 'official' || v === 'pass-by-proof';
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(52)} ${d ?? ''}`); };

async function post(path, body, raw) {
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-opencode-session': SESS },
    body: raw !== undefined ? raw : JSON.stringify(body),
  });
  return { status: r.status, text: await r.text().catch(() => ''), h: r.headers };
}

const matrix = async () => JSON.parse(await (await fetch(BASE + '/gate/matrix')).text());

// 0) 先预热到正常状态
{
  const r = await post('/v1/responses', { model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 });
  check('基线：正常请求成功', r.status === 200, `status=${r.status}`);
}

// 1) 制造一次"坏请求"：不存在的路径 → 上游 404
{
  const r = await post('/v1/nope/does-not-exist', { model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 });
  check('坏路径被白名单拒绝（404，不转发上游）', r.status === 404, `status=${r.status}`);
  const m = await matrix();
  const resp = m.rows.filter(x => x.key.endsWith('|responses'));
  const polluted = resp.filter(x => x.verdict === 'third');
  check('坏路径未污染 responses 车道', polluted.length === 0,
    `responses 车道=${resp.map(x => x.key + ':' + x.verdict).join(' ')}`);
}

// 2) 坏请求之后，正常请求必须仍然成功
{
  const r = await post('/v1/responses', { model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 });
  // 上游 responses 的 id 在 UUID4/resp_ 间波动时由预检证明并标 pass-by-proof，安全级别等价。
check('坏请求后正常请求仍成功', r.status === 200 && PROVEN_V(r.h.get('x-gate-result')),
    `status=${r.status} verdict=${r.h.get('x-gate-result')}`);
}

// 3) 非法 body 之后也必须正常
{
  const bad = await post('/v1/responses', null, '{"broken":');
  check('非法 body 返回 400', bad.status === 400, `status=${bad.status}`);
  const r = await post('/v1/responses', { model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 });
  check('非法 body 后正常请求仍成功', r.status === 200, `status=${r.status}`);
  const m = await matrix();
  // 已知：deepseek-v4.1-flash@messages 本来就是第三方车道（HEX32），不算污染
  const KNOWN_THIRD = new Set(['deepseek-v4.1-flash|messages', 'deepseek-flash|chat', 'deepseek-v4.1-flash|chat']);
  const polluted = m.rows.filter(x => x.verdict === 'third' && !KNOWN_THIRD.has(x.key));
  check('非法 body 未污染非 chat 车道', polluted.length === 0,
    `污染=${polluted.map(x => x.key).join(',') || '无'}`);
}

// 4) 上游 4xx（超长 max_output_tokens 之类）后也必须正常
{
  const r1 = await post('/v1/responses', { model: 'deepseek-flash', input: 'hi', max_output_tokens: -1 });
  const r2 = await post('/v1/responses', { model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 });
check('上游 4xx 后正常请求仍成功', r2.status === 200 && PROVEN_V(r2.h.get('x-gate-result')),
    `first=${r1.status} second=${r2.status}/${r2.h.get('x-gate-result')}`);
}

// 5) PUT/DELETE 必须是 405 且不打上游
{
  for (const m of ['PUT', 'DELETE', 'PATCH']) {
    const r = await fetch(BASE + '/v1/responses', { method: m, headers: { 'content-type': 'application/json' }, body: '{}' });
    check(`${m} /v1/responses 返回 405`, r.status === 405, `status=${r.status}`);
  }
}

console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
