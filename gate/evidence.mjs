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
import fs from 'node:fs';
import path from 'node:path';
import { TOKENIZER_CORPUS, OFFICIAL_ERR_TEMPLATES, UUID4_REQUEST_ID } from './baseline.mjs';

export const EVIDENCE_VERSION = 1;
export const L1_IDS = ['EV1', 'EV2', 'EV3', 'EV4', 'EV5', 'EV6'];
export const L2_IDS = ['EV7', 'EV8', 'EV9'];

function request(t, { method = 'POST', path: p, body = null, headers = {}, timeoutMs = 15000 }) {
  return new Promise((resolve) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const h = { authorization: 'Bearer ' + t.key, accept: 'application/json', ...headers };
    if (data) { h['content-type'] = 'application/json'; h['content-length'] = data.length; }
    if (t.session) { h['x-opencode-session'] = 'evidence'; h['x-opencode-session-id'] = 'evidence'; }
    const lib = t.scheme === 'http' ? http : https;
    const r = lib.request({
      host: t.host, port: t.port || (t.scheme === 'http' ? 80 : 443), path: (t.prefix || '') + p, method, headers: h, timeout: timeoutMs,
    }, (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
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
  {
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
  {
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
  {
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

  return {
    ...ev,
    version: EVIDENCE_VERSION,
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
