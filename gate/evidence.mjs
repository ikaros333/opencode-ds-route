// 2026-11-02：正向证据链（EV1–EV9）
// 目标：回答"我连的是不是官方 API 端点"（L1 可证）、"实现是否官方栈"（L2 高置信），
//       并对"模型权重是否官方"永远输出 unproven（L3 不可证）。
// 设计约束：
//   1) 不进请求路径（除 require 策略读快照这一 O(1) 判断）
//   2) 生成型探针默认关闭（allowGen=false），只在手动 audit-lane 时开启
//   3) 三态判定：official / non-official / unknown；探针自身失败一律记 unknown，不记 non-official
import https from 'node:https';
import http from 'node:http';
import tls from 'node:tls';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TOKENIZER_CORPUS, OFFICIAL_ERR_TEMPLATES, UUID4_REQUEST_ID } from './baseline.mjs';

export const EVIDENCE_VERSION = 1;
export const L1_IDS = ['EV1', 'EV2', 'EV3', 'EV4', 'EV5', 'EV6'];
export const L2_IDS = ['EV7', 'EV8', 'EV9'];
// 2026-11-04：L0 端点指纹（零成本判负）+ MX messages 协议判据（唯一可判正判负的协议）
export const L0_IDS = ['L0-1', 'L0-2', 'L0-3', 'L0-4', 'L0-5'];
export const MSG_IDS = ['M1', 'M2', 'M3', 'M4', 'M5', 'M6'];
export const VALIDATE_IDS = ['EV3', 'EV4', 'EV14', 'EV15', 'M6'];   // 2026-11-05：校验可达性
export const OFFICIAL_OWNERS = ['deepseek'];

function request(t, { method = 'POST', path: p, body = null, headers = {}, timeoutMs = 15000, auth = 'bearer' }) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const h = { accept: 'application/json', ...headers };
    // 2026-11-04：auth 支持 bearer / apikey / none（L0-4 需要"无认证"探针）
    if (auth === 'bearer' && t.key) h.authorization = 'Bearer ' + t.key;
    if (auth === 'apikey' && t.key) h['x-api-key'] = t.key;
    if (data) { h['content-type'] = 'application/json'; h['content-length'] = data.length; }
    if (t.session) { h['x-opencode-session'] = 'evidence'; h['x-opencode-session-id'] = 'evidence'; }
    const lib = t.scheme === 'http' ? http : https;
    const r = lib.request({
      host: t.host, port: t.port || (t.scheme === 'http' ? 80 : 443), path: (t.prefix || '') + p, method, headers: h, timeout: timeoutMs,
    }, (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers || {} }));
    });
    r.on('error', (e) => resolve({ status: 0, err: e.message }));
    r.on('timeout', () => { try { r.destroy(); } catch {} resolve({ status: 0, err: 'timeout' }); });
    if (data) r.write(data);
    r.end();
  });
}

const msgOf = (r) => {
  try { return JSON.parse(r.body)?.error?.message || ''; } catch { return ''; }
};

async function tlsProbe(host, timeoutMs) {
  return new Promise((resolve) => {
    const s = tls.connect({ host, port: 443, servername: host, ALPNProtocols: ['h2', 'http/1.1'], timeout: timeoutMs }, () => {
      const c = s.getPeerCertificate() || {};
      resolve({
        ok: true,
        protocol: s.getProtocol(), alpn: s.alpnProtocol,
        subject: c.subject?.CN || '', issuer: c.issuer?.O || c.issuer?.CN || '',
        san: String(c.subjectaltname || ''),
      });
      s.end();
    });
    s.on('error', (e) => resolve({ ok: false, err: e.message }));
    s.on('timeout', () => { try { s.destroy(); } catch {} resolve({ ok: false, err: 'timeout' }); });
  });
}

/**
 * 跑一次证据采集。
 * @param {object} o {host, port, scheme, prefix, key, model, session, timeoutMs, allowGen}
 */
export async function runEvidence(o) {
  const t = {
    host: o.host, port: o.port, scheme: o.scheme || 'https', prefix: o.prefix || '',
    key: o.key || '', model: o.model || 'deepseek-flash', session: !!o.session,
  };
  const timeout = o.timeoutMs || 15000;
  const allowGen = !!o.allowGen;
  // 2026-11-05：门控侧「证据过期自愈」必须有快路径 —— 完整一轮要 ~48s，而 503 之后
  // 客户端（dsh maxRetries=2，800ms 起退避）根本等不到。fast 只保留**判正必需**的探针：
  // L0 指纹 / EV3+EV4 校验文案 / EV14+EV15 文本级 / M6 / EV13 canary / EV5+EV6 TLS。
  // 跳过的（EV7 响应形态、EV8 serde、EV10 分词一致性）会打 skipped=fast_refresh，
  // 打分自动把它们排除在分母外，不会把"没测"算成"不达标"。
  const fast = !!o.fast;
  const canaryN = Number.isFinite(Number(o.canaryN)) && Number(o.canaryN) > 0
    ? Math.min(20, Math.floor(Number(o.canaryN))) : 10;
  const base = (extra) => ({ model: t.model, input: '只回答：好', max_output_tokens: 4, reasoning: { effort: 'none' }, ...extra });
  const items = [];
  const add = (id, ok, detail, extra = {}) => items.push({ id, ok, detail, ...extra });

  // EV1 官方专有端点：余额
  {
    const r = await request(t, { method: 'GET', path: '/v1/user/balance', timeoutMs: timeout });
    let ok = false, detail = '';
    if (r.status === 0) detail = 'net:' + r.err;
    else if (r.status === 200) {
      try { const j = JSON.parse(r.body); ok = 'balance_infos' in j || 'is_available' in j; detail = 'balance_infos'; }
      catch { detail = '200 非 JSON'; }
    } else detail = 'HTTP ' + r.status;
    add('EV1', ok, detail);
  }

  // EV2 FIM 端点：官方给 beta api 引导
  {
    const r = await request(t, { path: '/v1/completions', body: { model: t.model, prompt: 'def f():', max_tokens: 4 }, timeoutMs: timeout });
    const m = msgOf(r);
    const ok = r.status === 400 && /beta api/i.test(m);
    add('EV2', ok, r.status === 0 ? 'net:' + r.err : (ok ? 'beta api 引导' : 'HTTP ' + r.status + ' ' + m.slice(0, 40)));
  }

  // EV3 / EV4 参数范围校验（生成前被拒，0 token）
  for (const [id, body, re] of [
    // 实测：opencode 对 temperature:9 返回 200（不做范围校验），官方返回 400 → 判别力强
    ['EV3', { temperature: 9 }, /valid range of temperature/i],
    ['EV4', { top_p: 2 }, /valid range of top_p/i],
  ]) {
    const r = await request(t, { path: '/v1/responses', body: base(body), timeoutMs: timeout });
    const m = msgOf(r);
    const ok = r.status === 400 && re.test(m);
    add(id, ok, r.status === 0 ? 'net:' + r.err : (ok ? '范围校验命中' : 'HTTP ' + r.status + ' ' + m.slice(0, 40)));
  }

  // ---------------- 2026-11-05：EV14 / EV15 文本级校验判据 ----------------
  // 实测（2026-11-05，官方/中转各 3 次 × 5 探针，15/15 稳定）：
  //   官方  假模型 → 400「The supported API model names are deepseek-…」（无包装）
  //   中转  假模型 → 400「Upstream request failed: Model is unavailable.」（有包装）
  //   官方  max_tokens:0 → 400「Invalid max_tokens value, the valid range…」（无包装）
  //   中转  max_tokens:0 → 400「Upstream request failed: [invalid_request_error] …」
  // 关键：不能只看状态码或文案，必须**同时**要求「无 Upstream request failed 前缀」——
  //      当天实测有探针在中转侧也返回 400 与官方文案（中转会转发部分参数校验）。
  {
    const OFFICIAL_MODELS_TXT = /The supported API model names are/i;
    const OFFICIAL_MT_TXT = /Invalid max_tokens value/i;
    const RELAY_WRAP = /^\s*Upstream request failed\s*[:：]/i;
    const msgPath = /(^|\.)deepseek\.com$/i.test(t.host) ? '/anthropic/v1/messages' : '/v1/messages';
    const mHeaders = { 'x-api-key': t.key, 'anthropic-version': '2023-06-01' };
    const FAKE = 'no-such-model-xyz-9f3a';
    const judge = (r, re) => {
      const m = msgOf(r);
      return { hit: r.status === 400 && re.test(m) && !RELAY_WRAP.test(m),
               wrapped: RELAY_WRAP.test(m), status: r.status, msg: m.slice(0, 60) };
    };

    const probes14 = [
      ['responses', '/v1/responses', {}, { model: FAKE, input: 'hi', max_output_tokens: 4, reasoning: { effort: 'none' } }],
      ['messages', msgPath, mHeaders, { model: FAKE, max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }],
      ['chat', '/v1/chat/completions', {}, { model: FAKE, max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] }],
    ];
    const rows14 = [];
    for (const [proto, p, headers, body] of probes14) {
      const r = await request(t, { method: 'POST', path: p, headers, body, timeoutMs: timeout });
      rows14.push({ proto, ...judge(r, OFFICIAL_MODELS_TXT) });
    }
    const ok14 = rows14.filter((x) => x.hit).length;
    add('EV14', ok14 === 3, `官方名单文案 ${ok14}/3` +
      (ok14 < 3 ? '  ' + rows14.filter((x) => !x.hit).map((x) => `${x.proto}:${x.wrapped ? '包装前缀' : 'st' + x.status}`).join(',') : ''),
      { rows: rows14 });

    const probes15 = [
      ['messages', msgPath, mHeaders, { model: t.model, max_tokens: 0, messages: [{ role: 'user', content: 'hi' }] }],
      ['chat', '/v1/chat/completions', {}, { model: t.model, max_tokens: 0, messages: [{ role: 'user', content: 'hi' }] }],
    ];
    const rows15 = [];
    for (const [proto, p, headers, body] of probes15) {
      const r = await request(t, { method: 'POST', path: p, headers, body, timeoutMs: timeout });
      rows15.push({ proto, ...judge(r, OFFICIAL_MT_TXT) });
    }
    const ok15 = rows15.filter((x) => x.hit).length;
    add('EV15', ok15 === 2, `边界文案 ${ok15}/2` +
      (ok15 < 2 ? '  ' + rows15.filter((x) => !x.hit).map((x) => `${x.proto}:${x.wrapped ? '包装前缀' : 'st' + x.status}`).join(',') : ''),
      { rows: rows15 });
  }

  // EV5 TLS 证书 / EV6 ALPN
  if ((t.scheme || 'https') === 'https') {
    const ti = await tlsProbe(t.host, timeout);
    if (!ti.ok) { add('EV5', false, 'tls:' + (ti.err || 'fail'), { skipped: true }); add('EV6', false, 'tls:' + (ti.err || 'fail'), { skipped: true }); }
    else {
      const sanHasHost = ti.san.includes('DNS:' + t.host);
      add('EV5', ti.subject === t.host && sanHasHost, `subject=${ti.subject} issuer=${ti.issuer}`);
      add('EV6', ti.alpn === 'h2', `alpn=${ti.alpn}`);
    }
  } else {
    add('EV5', false, 'http 上游无 TLS', { skipped: true });
    add('EV6', false, 'http 上游无 TLS', { skipped: true });
  }

  // EV7 响应形态（35 字段 / 裸 UUID4 / usage 5 键 / 无 opencode 块）
  if (fast) {
    add('EV7', false, 'skipped（fast refresh：只跑判正必需的探针）', { skipped: true, skippedReason: 'fast_refresh' });
  } else {
    const r = await request(t, { path: '/v1/responses', body: base(), timeoutMs: timeout });
    let ok = false, detail = 'HTTP ' + r.status;
    if (r.status === 200) {
      try {
        const j = JSON.parse(r.body);
        const keys = Object.keys(j).length;
        const u = j.usage || {};
        const bareUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(j.id || ''));
        const shapeOk = keys >= 30 && bareUuid && !('opencode' in u) && 'total_tokens' in u;
        ok = shapeOk; detail = `${keys}字段 bareUuid=${bareUuid} opencode块=${'opencode' in u}`;
      } catch { detail = '200 非 JSON'; }
    }
    add('EV7', ok, detail);
  }

  // EV8 serde 文案（Rust = 官方；Go = 兼容层）
  if (fast) {
    add('EV8', false, 'skipped（fast refresh）', { skipped: true, skippedReason: 'fast_refresh' });
  } else {
    const r = await request(t, { path: '/v1/responses', body: { model: t.model, input: 'ping', max_output_tokens: 'abc' }, timeoutMs: timeout });
    const m = msgOf(r);
    const rust = /Failed to deserialize the JSON body into the target type:\s*max_output_tokens:/i.test(m);
    add('EV8', rust, r.status === 0 ? 'net:' + r.err : (rust ? 'official-rust' : 'HTTP ' + r.status + ' ' + m.slice(0, 40)));
  }

  // EV9 能力探针（仅手动审计时执行；会真实生成，成本极低）
  if (allowGen) {
    const caps = {};
    for (const [k, body] of [
      ['background', base({ background: true })],
      ['top_logprobs', base({ top_logprobs: 2 })],
      ['store', base({ store: true })],
      ['max_tool_calls', base({ max_tool_calls: 1, tools: [{ type: 'function', name: 'a', parameters: { type: 'object', properties: {} } }, { type: 'function', name: 'b', parameters: { type: 'object', properties: {} } }] })],
    ]) {
      const r = await request(t, { path: '/v1/responses', body, timeoutMs: timeout });
      caps[k] = r.status === 200 ? 'ok' : 'HTTP ' + r.status;
    }
    const okCount = Object.values(caps).filter((v) => v === 'ok').length;
    add('EV9', okCount >= 3, JSON.stringify(caps));
  } else {
    add('EV9', false, 'skipped（allowGen=false）', { skipped: true });
  }

  // EV10 分词一致性（模型族）：与官方基线逐条比对 usage.input_tokens
  if (fast) {
    // 这一项要按语料逐条生成（十几条），是整轮里最贵的一段 → 自愈快路径跳过。
    // 代价：model.family 会变 unknown（GATE_MODEL_EVIDENCE_POLICY=require 时不能靠它放行），
    // 下一次整点任务会补回完整快照。
    add('EV10', false, 'skipped（fast refresh：分词比对太慢）', { skipped: true, skippedReason: 'fast_refresh' });
  } else {
    const rows = [];
    let ok = 0;
    for (const c of TOKENIZER_CORPUS) {
      const r = await request(t, { path: '/v1/responses', body: { model: t.model, input: c.text, max_output_tokens: 1, reasoning: { effort: 'none' } }, timeoutMs: timeout });
      let got = null;
      if (r.status === 200) { try { got = JSON.parse(r.body)?.usage?.input_tokens ?? null; } catch {} }
      const hit = got === c.expect;
      if (hit) ok++;
      rows.push({ id: c.id, expect: c.expect, got, hit });
    }
    add('EV10', ok >= 9, `一致 ${ok}/${rows.length}` + (ok < rows.length ? ' 差异: ' + rows.filter(x => !x.hit).map(x => `${x.id}=${x.got}`).join(',') : ''), { rows });
  }

  // EV11 官方校验器模板（逐字 + UUID4 request_id）
  {
    let ok = 0;
    const detail = [];
    for (const c of OFFICIAL_ERR_TEMPLATES) {
      const r = await request(t, { path: '/v1/responses', body: { model: t.model, input: 'hi', max_output_tokens: 4, ...c.body }, timeoutMs: timeout });
      const m = msgOf(r);
      const textOk = c.re.test(m);
      const idOk = UUID4_REQUEST_ID.test(m);
      if (r.status === 400 && textOk && idOk) ok++;
      detail.push(`${c.id}:${r.status}${textOk ? '/txt' : ''}${idOk ? '/uuid4' : ''}`);
    }
    add('EV11', ok >= 3, `命中 ${ok}/${OFFICIAL_ERR_TEMPLATES.length} (${detail.join(' ')})`);
  }

  // ---------------- 2026-11-04：L0 端点指纹（零成本判负）----------------
  const hdrUnion = [];
  {
    const r = await request(t, { method: 'GET', path: '/v1/models', timeoutMs: timeout });
    const hdrOf = (x) => Object.keys(x.headers || {}).map((k) => k.toLowerCase());
    hdrUnion.push(...hdrOf(r));
    let owners = [], count = 0;
    if (r.status === 200) {
      try {
        const j = JSON.parse(r.body);
        const data = Array.isArray(j.data) ? j.data : [];
        count = data.length;
        owners = [...new Set(data.map((m) => String(m.owned_by || '')))];
      } catch {}
    }
    const ownOk = owners.length > 0 && owners.every((o) => OFFICIAL_OWNERS.includes(o));
    // 2026-11-05：把完整模型集合写进 extra，供 audit --write 做 MODEL_SET_DRIFT 对比
    let modelIds = [];
    try { const j2 = JSON.parse(r.body); modelIds = (Array.isArray(j2.data) ? j2.data : []).map((m) => String(m.id || '')).filter(Boolean); } catch {}
    add('L0-1', ownOk && count > 0 && count <= 5,
      `HTTP ${r.status} 条目=${count} owned_by=${owners.join('|') || '-'}`, { models: modelIds });
  }

  // 一次真实小请求，读取响应头（L0-2 / L0-3 共用）
  {
    const r = await request(t, {
      path: '/v1/responses',
      body: { model: t.model, input: 'hi', max_output_tokens: 4, reasoning: { effort: 'none' } },
      timeoutMs: timeout,
    });
    const hs = Object.keys(r.headers || {}).map((k) => k.toLowerCase());
    hdrUnion.push(...hs);
    const hasTrace = hs.includes('x-ds-trace-id');
    const relayHs = ['cf-ray', 'x-zen-model', 'x-opencode-log-id'].filter((k) => hs.includes(k));
    add('L0-2', hasTrace, hasTrace ? 'x-ds-trace-id 存在' : '缺 x-ds-trace-id');
    add('L0-3', relayHs.length === 0, relayHs.length ? '第三方头: ' + relayHs.join(',') : '无第三方头');
  }

  // L0-4：无认证 401 文案（官方含 "Authentication Fails (governor)"）
  {
    const r = await request(t, {
      path: '/v1/responses', body: { model: t.model, input: 'hi', max_output_tokens: 4 }, auth: 'none', timeoutMs: timeout,
    });
    const governor = /Authentication Fails \(governor\)/i.test(r.body || '');
    add('L0-4', r.status === 401 && governor, `HTTP ${r.status}${governor ? ' governor' : ''}`);
  }

  // L0-5：跨厂商模型（官方必然拒绝；能跑通 = 转售池）
  {
    const r = await request(t, {
      path: '/v1/chat/completions',
      body: { model: OFFICIAL_OWNERS[0] === 'deepseek' ? 'glm-5.2' : 'glm-5.2', max_tokens: 4, messages: [{ role: 'user', content: 'hi' }] },
      timeoutMs: timeout,
    });
    add('L0-5', r.status === 400, `glm-5.2 → HTTP ${r.status}`);
  }

  // ---------------- 2026-11-04：MX messages 协议判据 ----------------
  {
    const M_HEADERS = { 'x-api-key': t.key, 'anthropic-version': '2023-06-01' };
    // 2026-11-04：messages 路径因上游而异 —— 官方在 /anthropic/v1/messages，中转在 /v1/messages
    const MSG_PATH = /(^|\.)deepseek\.com$/i.test(t.host) ? '/anthropic/v1/messages' : '/v1/messages';
    // M1–M3：成功响应形态
    const ok = await request(t, {
      method: 'POST', path: MSG_PATH, headers: M_HEADERS,
      body: { model: t.model, max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] },
      timeoutMs: timeout,
    });
    let id = '', usage = null;
    if (ok.status === 200) {
      try { const j = JSON.parse(ok.body); id = String(j.id || ''); usage = j.usage || {}; } catch {}
    }
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
    add('M1', uuid, ok.status === 200 ? `id=${id.slice(0, 12)}(${id.length})` : 'HTTP ' + ok.status);
    const wrapped = usage && ('cost' in usage || 'opencode' in usage);
    add('M2', !!usage && !wrapped, usage ? (wrapped ? 'usage 含 cost/opencode' : 'usage 干净') : '无 usage');
    add('M3', !!usage && 'service_tier' in usage, usage ? ('usage 键=' + Object.keys(usage).join(',')) : '无 usage');

    // M4–M6：错误响应形态（非法 temperature）
    const bad = await request(t, {
      method: 'POST', path: MSG_PATH, headers: M_HEADERS,
      body: { model: t.model, max_tokens: 4, temperature: 9, messages: [{ role: 'user', content: 'hi' }] },
      timeoutMs: timeout,
    });
    const bmsg = msgOf(bad) || String(bad.body || '');
    const extraReq = /\(request id:\s*\d{15,}/i.test(bmsg);
    const wrappedPrefix = /Upstream request failed/i.test(bmsg);
    const officialText = /valid range of temperature is \[0, 2\]/i.test(bmsg);
    const uuidReq = UUID4_REQUEST_ID.test(bmsg);
    add('M4', bad.status === 400 && !extraReq, extraReq ? '有 (request id: 2026…) 包装' : '无额外 request id');
    add('M5', bad.status === 400 && !wrappedPrefix, wrappedPrefix ? '有 Upstream request failed 前缀' : '无包装前缀');
    add('M6', bad.status === 400 && officialText && uuidReq,
      `HTTP ${bad.status}${officialText ? '/官方文案' : ''}${uuidReq ? '/UUID4' : ''}`);
  }

  // ---------------- 2026-11-04：EV13 随机 canary（动态分词比对）----------------
  // 目的：抓"模型被换成别的"——同一个随机串在官方与目标端的分词数必须一致。
  // 实测判别力：官方 flash 39 / 官方 chat 13 / 中转 glm-5.2 21（同一串）。
  // 只在目标端不是官方时才有意义（官方自身与自己比是恒真的）。
  {
    const baseKey = process.env.DEEPSEEK_API_KEY || '';
    const isOfficial = /(^|\.)deepseek\.com$/i.test(t.host);
    if (isOfficial || !baseKey) {
      // 2026-11-05：两种 skipped 语义完全不同，必须分开记录（门控据此决定"放行"还是"无法证明"）。
      add('EV13', false, isOfficial ? 'skipped（目标即官方，无需比对）' : 'skipped（缺 DEEPSEEK_API_KEY 基线）',
        { skipped: true, skippedReason: isOfficial ? 'official_target' : 'no_baseline_key' });
    } else {
      const rows = [];
      let ok = 0;
      const baseT = { host: 'api.deepseek.com', port: 443, scheme: 'https', prefix: '', key: baseKey, model: 'deepseek-flash' };
      for (let i = 0; i < canaryN; i++) {
        const s = crypto.randomBytes(7).toString('base64').slice(0, 10) + ' ' + crypto.randomBytes(4).toString('hex') + ' 测';
        const body = (m) => ({ model: m, input: s, max_output_tokens: 1, reasoning: { effort: 'none' } });
        const a = await request(baseT, { path: '/v1/responses', body: body('deepseek-flash'), timeoutMs: timeout });
        const b = await request(t, { path: '/v1/responses', body: body(t.model), timeoutMs: timeout });
        let ai = null, bi = null;
        try { ai = JSON.parse(a.body)?.usage?.input_tokens ?? null; } catch {}
        try { bi = JSON.parse(b.body)?.usage?.input_tokens ?? null; } catch {}
        const hit = ai !== null && bi !== null && ai === bi;
        if (hit) ok++;
        rows.push({ i, official: ai, target: bi, hit });
      }
      // 阈值随采样数缩放（默认 10 条时仍是 ≥9/10 的旧口径）：自愈快路径只取 GATE_EVIDENCE_REFRESH_CANARY_N 条
      const needN = Math.max(1, Math.ceil(canaryN * 0.9));
      add('EV13', ok >= needN, `一致 ${ok}/${canaryN}` + (ok < canaryN ? ' 差异: ' + rows.filter((x) => !x.hit).map((x) => `${x.official}≠${x.target}`).join(',') : ''), { rows });
    }
  }

  return { at: new Date().toISOString(), upstream: { host: t.host, prefix: t.prefix, model: t.model }, items };
}

/** 打分：L1（EV1–EV6）满分 → official；≤2 → non-official；其余 unknown。L2 同理但永不影响 L1 结论。 */
export function scoreEvidence(ev) {
  const byId = Object.fromEntries((ev.items || []).map((x) => [x.id, x]));
  const count = (ids) => {
    let score = 0, max = 0, skipped = 0;
    for (const id of ids) {
      const it = byId[id];
      if (!it || it.skipped) { skipped++; continue; }
      max++; if (it.ok) score++;
    }
    return { score, max, skipped };
  };
  const l1 = count(L1_IDS);          // 端点身份（EV1–EV6）
  const l2 = count(L2_IDS);          // 实现身份（EV7–EV9）
  const l3 = count(['EV10', 'EV11']); // 模型族（EV10 分词 / EV11 官方校验器）
  const l0 = count(L0_IDS);          // 端点指纹（2026-11-04）
  const mx = count(MSG_IDS);         // messages 协议（2026-11-04）
  const cy = count(['EV13']);        // 随机 canary（2026-11-04）

  const verdict = l1.max === 0 ? 'unknown'
    : l1.score >= Math.max(4, l1.max - 1) ? 'official'
    : l1.score <= 2 ? 'non-official' : 'unknown';

  // 2026-11-02：三档实现分类 —— v4-pro 这类"原生语义 + 第三方端点"单独一档
  const implProfile = byId.EV7?.ok ? 'official'
    : (byId.EV9?.ok && !byId.EV7?.ok) ? 'native-relay'
    : (l1.score <= 2 ? 'compat' : 'unknown');

  const fam = (() => {
    if (l3.max === 0) return 'unknown';
    const ev10 = byId.EV10, ev11 = byId.EV11;
    // 2026-11-02：三档 —— 官方提供 / 第三方提供（含自部署）/ 被换成异模型
    if (ev10?.ok && ev11?.ok) return 'deepseek-official';
    if (ev10?.ok && !ev11?.ok) return 'deepseek-thirdparty';
    const hitRows = (ev10?.rows || []).filter((x) => x.hit).length;
    if (ev10 && !ev10.ok && hitRows <= 4) return 'mismatch';
    return 'unknown';
  })();

  // 2026-11-05：validate 结构化（每协议：这条通道此刻是否走官方校验）
  //   signals 记录该协议下哪些探针命中；relayWrap 记录"中转包装前缀"这一负向特征。
  const validate = (() => {
    const r14 = byId.EV14?.rows || [];
    const r15 = byId.EV15?.rows || [];
    const pick = (r, proto) => r.find((x) => x.proto === proto);
    const mk = (signals0, wraps) => {
      // 只统计"真的跑过"的探针（ok 为 boolean）；一个都没跑 → unknown，跑了但全不中 → fail
      const ran = signals0.filter((s) => typeof s.ok === 'boolean');
      const pass = ran.filter((s) => s.ok === true).length;
      return { status: ran.length === 0 ? 'unknown' : (pass > 0 ? 'pass' : 'fail'),
               score: pass, max: ran.length,
               relayWrap: wraps.filter((x) => x && x.wrapped).length,
               signals: ran.map((s) => ({ id: s.id, ok: s.ok })),
               officialText: ran.filter((s) => s.ok).map((s) => s.id) };
    };
    const R = pick(r14, 'responses'), M14 = pick(r14, 'messages'), C14 = pick(r14, 'chat');
    const M15 = pick(r15, 'messages'), C15 = pick(r15, 'chat');
    return {
      responses: mk([{ id: 'EV3', ok: byId.EV3?.ok }, { id: 'EV4', ok: byId.EV4?.ok }, { id: 'EV14', ok: R?.hit }], [R]),
      messages: mk([{ id: 'M6', ok: byId.M6?.ok }, { id: 'EV14', ok: M14?.hit }, { id: 'EV15', ok: M15?.hit }], [M14, M15]),
      chat: mk([{ id: 'EV14', ok: C14?.hit }, { id: 'EV15', ok: C15?.hit }], [C14, C15]),
      at: ev.at || null,
    };
  })();

  // 2026-11-04：校验器可达性（判正）。V1 = responses 官方范围文案；V2 = messages 官方范围文案。
  // 2026-11-05：扩展为包含 EV14/EV15 文本级判据（任一条命中即算可达）。
  const v1 = !!(byId.EV3?.ok && byId.EV4?.ok) || validate.responses.status === 'pass';
  const v2 = !!byId.M6?.ok || validate.messages.status === 'pass';
  const validator = { responses: v1, messages: v2, reachable: v1 || v2 };

  // 2026-11-04：assurance 四档（供门控 GATE_ASSURANCE 使用）
  //   strict  = L0 全通过（官方指纹齐全，只有直连能做到）
  //   probe   = 任一校验器可达（V1 或 V2）
  //   label   = 不判，只记录
  //   off     = 关闭
  const trackerOk = byId['L0-2']?.ok;   // 逐响应官方痕迹（x-ds-trace-id）
  const canaryOk = byId.EV13?.ok === true;
  // 2026-11-04：canary 是"模型没被换"的硬证据；即使没有校验器正向证据，
  // 只要 canary 通过也可以算 probe 档（它证明的是模型族未变，这正是核心目标）。
  const level = (l0.max > 0 && l0.score === l0.max && trackerOk) ? 'strict'
    : (validator.reachable || canaryOk) ? 'probe'
    : 'none';

  return {
    ...ev,
    version: EVIDENCE_VERSION,
    l0: { ...l0, items: (ev.items || []).filter((x) => L0_IDS.includes(x.id)) },
    messages: { ...mx, items: (ev.items || []).filter((x) => MSG_IDS.includes(x.id)), officialTrace: trackerOk },
    canary: (() => {
      const e13 = byId.EV13;
      const rows13 = (e13?.rows || []);
      const s = rows13.filter((r) => r.hit).length;
      return { score: rows13.length ? s : cy.score, max: rows13.length || cy.max,
               ok: e13?.ok === true, skipped: !!e13?.skipped,
               // 2026-11-05：把"为什么跳过"也写进快照。缺基线（no_baseline_key）不能当成通过——
               // 否则刷新任务在缺 DEEPSEEK_API_KEY 的环境里跑一次，canary 硬闸就静默失效了。
               skippedReason: e13?.skipped ? (e13.skippedReason || 'legacy_unknown') : null,
               reason: e13?.skipped ? 'skipped' : (e13?.ok ? 'consistent' : 'mismatch'),
               items: (ev.items || []).filter((x) => x.id === 'EV13') };
    })(),
    validator,
    validate,
    assurance: level,
    endpoint: { ...l1, verdict, items: (ev.items || []).filter((x) => L1_IDS.includes(x.id)) },
    impl: { ...l2, profile: implProfile, items: (ev.items || []).filter((x) => L2_IDS.includes(x.id)) },
    model: {
      family: fam, familyScore: l3.score, familyMax: l3.max,
      items: (ev.items || []).filter((x) => ['EV10', 'EV11'].includes(x.id)),
      claim: 'unproven', weights: 'unproven',
      reason: '模型族可判（分词一致性 + 官方校验器模板），权重托管方不可证（同权重自部署不可区分）',
    },
  };
}

export function writeSnapshot(file, scored) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(scored, null, 2));
  return file;
}

export function readSnapshot(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && j.endpoint ? j : null;
  } catch { return null; }
}
