// n20 — 判据复验 + 深挖
// 目标：对 n19 宣称的 N1–N9 做稳定性复验（3 次），并再挖 10 个新维度。
import https from 'node:https';

const OFF_K = process.env.DEEPSEEK_API_KEY || '';
const TG_K = process.env.OPENCODE_GO_API_KEY || '';
const T = {
  off: { host: 'api.deepseek.com', prefix: '', model: 'deepseek-chat', label: '官方' },
  tg: { host: 'opencode.ai', prefix: '/zen/go', model: 'deepseek-v4.1-flash', label: '第三方' },
};

function req(t, { method = 'POST', path, body, auth = 'bearer', key, headers = {}, timeout = 60000 }) {
  const k = key !== undefined ? key : (t === T.off ? OFF_K : TG_K);
  const hs = { ...headers };
  if (auth === 'bearer' && k) hs.authorization = 'Bearer ' + k;
  if (auth === 'apikey' && k) hs['x-api-key'] = k;
  if (t === T.tg) { hs['x-opencode-session'] = 'v20'; hs['x-opencode-session-id'] = 'v20'; }
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
const clean = (s) => String(s).replace(/\s+/g, ' ');

(async () => {
  console.log('### A. N1–N9 稳定性复验（各 3 次）\n');
  const R = { N1: [], N2: [], N4: [], N5: [], N6: [], N7: [], N8: [], N9: [] };
  for (let i = 0; i < 3; i++) {
    for (const side of ['off', 'tg']) {
      const t = T[side];
      const m = await req(t, { method: 'GET', path: '/v1/models' });
      const jm = J(m);
      R.N1.push(`${side}:${[...new Set((jm?.data || []).map((x) => x.owned_by))].join('|') || '-'}`);
      R.N9.push(`${side}:${(jm?.data || []).length}`);

      const c = await req(t, { path: '/v1/chat/completions', body: { model: t.model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] } });
      const jc = J(c);
      R.N2.push(`${side}:${c.h['server'] || '-'}${c.h['cf-ray'] ? '+cf' : ''}`);
      R.N5.push(`${side}:${jc?.usage?.prompt_cache_hit_tokens !== undefined ? 'hit键有' : '无'}`);
      R.N7.push(`${side}:${/^[0-9a-f]{8}-[0-9a-f]{4}/.test(jc?.id || '') ? 'uuid' : 'nonuuid'}`);
      R.N8.push(`${side}:${jc?.system_fingerprint ? '有' : '无'}`);

      const u = await req(t, { path: '/v1/chat/completions', body: { model: t.model, max_tokens: 4, temperature: 9, messages: [{ role: 'user', content: 'hi' }] } });
      R.N6.push(`${side}:${u.st}${/valid range/.test(u.b) ? '(官方文案)' : ''}`);

      const n = await req(t, { path: '/v1/chat/completions', body: { model: t.model, max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }, auth: 'none' });
      R.N4.push(`${side}:${n.st}:${/governor/.test(n.b) ? 'governor' : 'no-governor'}`);
    }
  }
  for (const [k, v] of Object.entries(R)) {
    const off = v.filter((x) => x.startsWith('off:')).map((x) => x.slice(4));
    const tg = v.filter((x) => x.startsWith('tg:')).map((x) => x.slice(3));
    const stable = (a) => (new Set(a).size === 1 ? '稳定' : '抖动');
    console.log(`${k}  官方[${off.join(' , ')}] ${stable(off)}   第三方[${tg.join(' , ')}] ${stable(tg)}`);
  }

  console.log('\n### B. 深挖新维度\n');
  const line = (label, o, g) => console.log(`${label.padEnd(26)} 官方=${String(o).padEnd(44)} 第三方=${g}`);

  // B1 未知模型
  {
    const bo = await req(T.off, { path: '/v1/chat/completions', body: { model: 'no-such-model', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] } });
    const bg = await req(T.tg, { path: '/v1/chat/completions', body: { model: 'no-such-model', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] } });
    line('未知模型', `${bo.st} ${clean(bo.b).slice(0, 40)}`, `${bg.st} ${clean(bg.b).slice(0, 40)}`);
  }
  // B2 跨厂商模型（第三方池里有的）
  {
    const g1 = await req(T.tg, { path: '/v1/chat/completions', body: { model: 'glm-5.2', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] } });
    const g2 = await req(T.tg, { path: '/v1/chat/completions', body: { model: 'claude-haiku-5-5', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] } });
    const o1 = await req(T.off, { path: '/v1/chat/completions', body: { model: 'glm-5.2', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] } });
    line('跨厂商模型 glm-5.2', `${o1.st}`, `${g1.st}`);
    line('跨厂商模型 claude-haiku', '（官方无此模型）', `${g2.st}`);
  }
  // B3 seed 确定性（同 seed 两次输出是否一致）
  {
    const body = (t) => ({ model: t.model, max_tokens: 24, seed: 42, temperature: 0, messages: [{ role: 'user', content: '数到五，只输出数字' }] });
    const o1 = await req(T.off, { path: '/v1/chat/completions', body: body(T.off) });
    const o2 = await req(T.off, { path: '/v1/chat/completions', body: body(T.off) });
    const g1 = await req(T.tg, { path: '/v1/chat/completions', body: body(T.tg) });
    const g2 = await req(T.tg, { path: '/v1/chat/completions', body: body(T.tg) });
    const t1 = (r) => J(r)?.choices?.[0]?.message?.content || '';
    line('seed=42 两次一致?', o1.st === 200 ? (t1(o1) === t1(o2) ? '一致' : '不一致') : `st${o1.st}`, g1.st === 200 ? (t1(g1) === t1(g2) ? '一致' : '不一致') : `st${g1.st}`);
  }
  // B4 chat prompt_tokens 与官方分词一致性
  {
    const cases = ['这是一段纯中文文本。', 'The quick brown fox jumps.', '完成✅ 失败❌'];
    const got = { off: [], tg: [] };
    for (const c of cases) {
      for (const side of ['off', 'tg']) {
        const t = T[side];
        const r = await req(t, { path: '/v1/chat/completions', body: { model: t.model, max_tokens: 1, messages: [{ role: 'user', content: c }] } });
        got[side].push(J(r)?.usage?.prompt_tokens ?? '-');
      }
    }
    line('chat prompt_tokens', got.off.join('/'), got.tg.join('/'));
  }
  // B5 前缀缓存命中上报
  {
    const prefix = '背景资料：' + '这是一段用于测试前缀缓存的较长中文文本，'.repeat(60);
    const body = (t) => ({ model: t.model, max_tokens: 4, messages: [{ role: 'system', content: prefix }, { role: 'user', content: 'hi' }] });
    const o1 = await req(T.off, { path: '/v1/chat/completions', body: body(T.off) });
    await new Promise((r) => setTimeout(r, 1500));
    const o2 = await req(T.off, { path: '/v1/chat/completions', body: body(T.off) });
    const g1 = await req(T.tg, { path: '/v1/chat/completions', body: body(T.tg) });
    await new Promise((r) => setTimeout(r, 1500));
    const g2 = await req(T.tg, { path: '/v1/chat/completions', body: body(T.tg) });
    const hit = (r) => { const u = J(r)?.usage || {}; return u.prompt_cache_hit_tokens ?? '无字段'; };
    line('缓存 hit（首次/二次）', `${hit(o1)}/${hit(o2)}`, `${hit(g1)}/${hit(g2)}`);
  }
  // B6 response_format
  {
    const rf = { type: 'json_object' };
    const o = await req(T.off, { path: '/v1/chat/completions', body: { model: T.off.model, max_tokens: 16, response_format: rf, messages: [{ role: 'user', content: '输出 JSON: {"a":1}' }] } });
    const g = await req(T.tg, { path: '/v1/chat/completions', body: { model: T.tg.model, max_tokens: 16, response_format: rf, messages: [{ role: 'user', content: '输出 JSON: {"a":1}' }] } });
    line('response_format json', `${o.st}`, `${g.st}`);
  }
  // B7 max_tokens 边界
  {
    for (const n of [8192, 8193, 65536]) {
      const o = await req(T.off, { path: '/v1/chat/completions', body: { model: T.off.model, max_tokens: n, messages: [{ role: 'user', content: 'hi' }] } });
      const g = await req(T.tg, { path: '/v1/chat/completions', body: { model: T.tg.model, max_tokens: n, messages: [{ role: 'user', content: 'hi' }] } });
      line(`max_tokens=${n}`, `${o.st}${/valid range/.test(o.b) ? '(范围文案)' : ''}`, `${g.st}${/valid range/.test(g.b) ? '(范围文案)' : ''}`);
    }
  }
  // B8 全部响应头对比
  {
    const o = await req(T.off, { path: '/v1/chat/completions', body: { model: T.off.model, max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] } });
    const g = await req(T.tg, { path: '/v1/chat/completions', body: { model: T.tg.model, max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] } });
    console.log('官方头:   ' + Object.keys(o.h).sort().join(','));
    console.log('第三方头: ' + Object.keys(g.h).sort().join(','));
  }
  // B9 stream_options.include_usage
  {
    const b = (t) => ({ model: t.model, max_tokens: 8, stream: true, stream_options: { include_usage: true }, messages: [{ role: 'user', content: 'hi' }] });
    const o = await req(T.off, { path: '/v1/chat/completions', body: b(T.off) });
    const g = await req(T.tg, { path: '/v1/chat/completions', body: b(T.tg) });
    const hasUsage = (r) => /"usage"\s*:\s*\{/.test(r.b) ? 'has-usage' : 'no-usage';
    line('stream include_usage', `${o.st} ${hasUsage(o)}`, `${g.st} ${hasUsage(g)}`);
  }
  // B10 chat 空 key vs 错误 key
  {
    const oBad = await req(T.off, { path: '/v1/chat/completions', body: { model: T.off.model, max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }, key: 'sk-00000000000000000000000000000000' });
    const gBad = await req(T.tg, { path: '/v1/chat/completions', body: { model: T.tg.model, max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }, key: 'sk-00000000000000000000000000000000' });
    line('错误 key 401 文案', `${oBad.st} ${clean(oBad.b).slice(0, 40)}`, `${gBad.st} ${clean(gBad.b).slice(0, 40)}`);
  }
})();
