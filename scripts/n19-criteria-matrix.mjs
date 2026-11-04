// n19 — 判据矩阵：官方 api.deepseek.com vs 第三方 relay(opencode /zen/go)
// 目的：在 17 个维度上做差分，找出新的「判正 / 判负」判据。
// 每个探针输出一行：维度 | 官方结果 | 第三方结果 | 判别力
import https from 'node:https';

const OFF_K = process.env.DEEPSEEK_API_KEY || '';
const TG_K = process.env.OPENCODE_GO_API_KEY || '';
if (!OFF_K || !TG_K) { console.log('缺少 key'); process.exit(1); }

const T = {
  off: { host: 'api.deepseek.com', prefix: '', model: 'deepseek-chat', rmodel: 'deepseek-flash', label: '官方' },
  tg: { host: 'opencode.ai', prefix: '/zen/go', model: 'deepseek-v4.1-flash', rmodel: 'deepseek-v4.1-flash', label: '第三方' },
};

function req(t, { method = 'POST', path, body, auth = 'bearer', headers = {}, timeout = 60000 }) {
  const key = t === T.off ? OFF_K : TG_K;
  const hs = { ...headers };
  if (auth === 'bearer') hs.authorization = 'Bearer ' + key;
  if (auth === 'apikey') hs['x-api-key'] = key;
  if (auth === 'none') { delete hs.authorization; delete hs['x-api-key']; }
  if (t === T.tg) { hs['x-opencode-session'] = 'matrix'; hs['x-opencode-session-id'] = 'matrix'; }
  let payload = null;
  if (body !== undefined) { payload = Buffer.from(JSON.stringify(body)); hs['content-type'] = 'application/json'; hs['content-length'] = payload.length; }
  return new Promise((resolve) => {
    const q = https.request({ host: t.host, path: t.prefix + path, method, timeout, headers: hs }, (rs) => {
      let b = '';
      rs.on('data', (c) => b += c);
      rs.on('end', () => resolve({ st: rs.statusCode, b, h: rs.headers }));
    });
    q.on('error', (e) => resolve({ st: 0, b: e.message, h: {} }));
    if (payload) q.write(payload);
    q.end();
  });
}

const J = (r) => { try { return JSON.parse(r.b); } catch { return null; } };
const tok = (r) => { const j = J(r); return j ? j.usage : null; };
const keys = (o) => (o ? Object.keys(o).sort().join(',') : '-');
const txt = (r) => String(r.b).replace(/\s+/g, ' ');

const rows = [];
const add = (dim, off, tg, power) => rows.push({ dim, off, tg, power });

const chatBody = (t, extra = {}) => ({ model: t.model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }], ...extra });

(async () => {
  // ---------- 1. /v1/models ----------
  {
    const [o, g] = await Promise.all([req(T.off, { method: 'GET', path: '/v1/models' }), req(T.tg, { method: 'GET', path: '/v1/models' })]);
    const jo = J(o), jg = J(g);
    const ids = (j) => (j?.data || []).map((x) => x.id).join('/') || '-';
    const owned = (j) => [...new Set((j?.data || []).map((x) => x.owned_by))].join('/') || '-';
    add('models: 状态/条目', `${o.st} ${(jo?.data || []).length}`, `${g.st} ${(jg?.data || []).length}`, '中');
    add('models: owned_by', owned(jo), owned(jg), '强');
    add('models: id 列表', ids(jo).slice(0, 40), ids(jg).slice(0, 40), '中');
  }

  // ---------- 2. chat 正常请求 ----------
  {
    const [o, g] = await Promise.all([req(T.off, { path: '/v1/chat/completions', body: chatBody(T.off) }), req(T.tg, { path: '/v1/chat/completions', body: chatBody(T.tg) })]);
    const jo = J(o), jg = J(g);
    add('chat: 状态', o.st, g.st, '弱');
    add('chat: object 字段', jo?.object || '-', jg?.object || '-', '弱');
    add('chat: id 前缀', String(jo?.id || '-').slice(0, 10), String(jg?.id || '-').slice(0, 10), '强');
    add('chat: id 形态', /^[0-9a-f-]{36}$/.test(jo?.id || '') ? 'UUID4/hex36' : String(jo?.id || '-').slice(0, 4) + '…', /^[0-9a-f-]{36}$/.test(jg?.id || '') ? 'UUID4/hex36' : String(jg?.id || '-').slice(0, 4) + '…', '强');
    add('chat: system_fingerprint', String(jo?.system_fingerprint), String(jg?.system_fingerprint), '中');
    add('chat: usage 键', keys(jo?.usage), keys(jg?.usage), '强');
    add('chat: finish_reason', jo?.choices?.[0]?.finish_reason || '-', jg?.choices?.[0]?.finish_reason || '-', '弱');
  }

  // ---------- 3. 未知字段 ----------
  {
    const [o, g] = await Promise.all([req(T.off, { path: '/v1/chat/completions', body: chatBody(T.off, { __unknown_field: 1 }) }), req(T.tg, { path: '/v1/chat/completions', body: chatBody(T.tg, { __unknown_field: 1 }) })]);
    add('chat: 未知字段', o.st, g.st, '中');
  }

  // ---------- 4. 空 messages ----------
  {
    const [o, g] = await Promise.all([req(T.off, { path: '/v1/chat/completions', body: { model: T.off.model, max_tokens: 4, messages: [] } }), req(T.tg, { path: '/v1/chat/completions', body: { model: T.tg.model, max_tokens: 4, messages: [] } })]);
    add('chat: 空 messages', `${o.st} ${txt(o).slice(0, 40)}`, `${g.st} ${txt(g).slice(0, 40)}`, '中');
  }

  // ---------- 5. 参数校验矩阵（关键） ----------
  const val = [
    ['temperature:9', { temperature: 9 }],
    ['top_p:5', { top_p: 5 }],
    ['max_tokens:999999', { max_tokens: 999999 }],
    ['n:3', { n: 3 }],
    ['stop[5]', { stop: ['a', 'b', 'c', 'd', 'e'] }],
    ['logprobs+top_logprobs:9', { logprobs: true, top_logprobs: 9 }],
    ['frequency_penalty:9', { frequency_penalty: 9 }],
    ['presence_penalty:-9', { presence_penalty: -9 }],
    ['seed:abc', { seed: 'abc' }],
    ['stream_options', { stream_options: { include_usage: true } }],
  ];
  for (const [label, extra] of val) {
    const [o, g] = await Promise.all([
      req(T.off, { path: '/v1/chat/completions', body: chatBody(T.off, extra) }),
      req(T.tg, { path: '/v1/chat/completions', body: chatBody(T.tg, extra) }),
    ]);
    const m = (r) => (r.st === 200 ? '200' : `${r.st} ${/valid range|Invalid/i.test(r.b) ? '官方文案' : '其它'}`);
    add('参数 ' + label, m(o), m(g), o.st !== g.st || /valid range/.test(o.b) !== /valid range/.test(g.b) ? '强' : '低');
  }

  // ---------- 6. tools 形态 ----------
  {
    const tools = [{ type: 'function', function: { name: 'get_time', description: 'now', parameters: { type: 'object', properties: {} } } }];
    const [o, g] = await Promise.all([
      req(T.off, { path: '/v1/chat/completions', body: chatBody(T.off, { tools, tool_choice: 'auto' }) }),
      req(T.tg, { path: '/v1/chat/completions', body: chatBody(T.tg, { tools, tool_choice: 'auto' }) }),
    ]);
    const got = (r) => { const j = J(r); const c = j?.choices?.[0]?.message?.tool_calls?.[0]; return c ? `${c.id.slice(0, 8)}…` : 'none'; };
    add('tools: tool_call id', got(o), got(g), '中');
  }

  // ---------- 7. 流式 SSE ----------
  {
    const [o, g] = await Promise.all([
      req(T.off, { path: '/v1/chat/completions', body: chatBody(T.off, { stream: true }) }),
      req(T.tg, { path: '/v1/chat/completions', body: chatBody(T.tg, { stream: true }) }),
    ]);
    const fam = (r) => {
      const lines = String(r.b).split('\n').filter((x) => x.trim());
      const hasEvent = lines.some((x) => x.startsWith('event:'));
      const hasDone = lines.includes('data: [DONE]');
      return `${r.st} ev=${hasEvent ? 'Y' : 'N'} done=${hasDone ? 'Y' : 'N'} n=${lines.length}`;
    };
    add('stream: SSE 形态', fam(o), fam(g), '中');
  }

  // ---------- 8. 响应头指纹 ----------
  {
    const [o, g] = await Promise.all([req(T.off, { path: '/v1/chat/completions', body: chatBody(T.off) }), req(T.tg, { path: '/v1/chat/completions', body: chatBody(T.tg) })]);
    const hd = (r) => ['server', 'x-request-id', 'trace_id', 'x-opencode-log-id', 'via', 'cf-ray', 'x-envoy-upstream-service-time'].map((k) => (r.h[k] ? k + '=' + String(r.h[k]).slice(0, 14) : null)).filter(Boolean).join(' ') || '无';
    add('响应头指纹', hd(o), hd(g), '强');
  }

  // ---------- 9. 未知路径 ----------
  {
    const [o, g] = await Promise.all([req(T.off, { method: 'GET', path: '/v1/does-not-exist' }), req(T.tg, { method: 'GET', path: '/v1/does-not-exist' })]);
    add('未知路径 404 形态', `${o.st} ${txt(o).slice(0, 46)}`, `${g.st} ${txt(g).slice(0, 46)}`, '中');
  }

  // ---------- 10. 无认证 ----------
  {
    const [o, g] = await Promise.all([req(T.off, { path: '/v1/chat/completions', body: chatBody(T.off), auth: 'none' }), req(T.tg, { path: '/v1/chat/completions', body: chatBody(T.tg), auth: 'none' })]);
    add('无认证 401 文案', `${o.st} ${txt(o).slice(0, 40)}`, `${g.st} ${txt(g).slice(0, 40)}`, '强');
  }

  // ---------- 11. responses 协议 ----------
  {
    const [o, g] = await Promise.all([
      req(T.off, { path: '/v1/responses', body: { model: T.off.rmodel, input: 'hi', max_output_tokens: 8, reasoning: { effort: 'none' } } }),
      req(T.tg, { path: '/v1/responses', body: { model: T.tg.rmodel, input: 'hi', max_output_tokens: 8, reasoning: { effort: 'none' } } }),
    ]);
    const jo = J(o), jg = J(g);
    add('responses: 状态/id', `${o.st} ${String(jo?.id || '').slice(0, 12)}`, `${g.st} ${String(jg?.id || '').slice(0, 12)}`, '强');
    add('responses: usage 键', keys(jo?.usage), keys(jg?.usage), '强');
    add('responses: 顶层字段数', jo ? Object.keys(jo).length : '-', jg ? Object.keys(jg).length : '-', '强');
  }

  // ---------- 12. anthropic messages ----------
  {
    const mb = (t) => ({ model: t === T.off ? 'deepseek-chat' : t.model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] });
    const pathO = '/anthropic/v1/messages';
    const pathG = '/v1/messages';
    const [o, g] = await Promise.all([
      req(T.off, { path: pathO, body: mb(T.off), auth: 'apikey', headers: { 'anthropic-version': '2023-06-01' } }),
      req(T.tg, { path: pathG, body: mb(T.tg), auth: 'apikey', headers: { 'anthropic-version': '2023-06-01' } }),
    ]);
    const jo = J(o), jg = J(g);
    add('messages: 状态/id 形态', `${o.st} ${/^[0-9a-f-]{36}$/.test(jo?.id || '') ? 'UUID4' : String(jo?.id || '').slice(0, 8)}`, `${g.st} ${/^[0-9a-f-]{36}$/.test(jg?.id || '') ? 'UUID4' : String(jg?.id || '').slice(0, 8)}`, '强');
    add('messages: usage 键', keys(jo?.usage), keys(jg?.usage), '强');
  }

  // ---------- 13. 官方专有端点 ----------
  {
    const [b, f, m] = await Promise.all([
      req(T.tg, { method: 'GET', path: '/v1/user/balance', auth: 'bearer' }),
      req(T.tg, { path: '/v1/completions', body: { model: T.tg.model, prompt: 'hi', max_tokens: 4 }, auth: 'bearer' }),
      req(T.tg, { path: '/v1/embeddings', body: { model: T.tg.model, input: 'hi' }, auth: 'bearer' }),
    ]);
    add('专有端点(第三方侧)', 'balance/FIM/embeddings 官方可用', `balance=${b.st} FIM=${f.st} emb=${m.st}`, '强');
  }

  // ---------- 输出 ----------
  console.log('维度'.padEnd(30) + '官方'.padEnd(46) + '第三方'.padEnd(46) + '判别力');
  console.log('-'.repeat(130));
  for (const r of rows) {
    console.log(r.dim.padEnd(30) + String(r.off).padEnd(46) + String(r.tg).padEnd(46) + r.power);
  }
})();
