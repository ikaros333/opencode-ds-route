/**
 * session-pick：探测 x-opencode-session 命中的 responses 校验器实现。
 *
 * 2026-11-11 实测：同一请求只换 session，会稳定落到不同 worker：
 *   OFFICIAL_TEXT / WORKER_WRAP / MIS_MAP / NO_VALIDATION
 * 本模块只做选择与落盘，不改变交付判定；选中的 session 仍只是"官方校验器
 * worker"证据，不等于证明官方托管。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';

export const SESSION_PROBE_BODY = Object.freeze({
  model: 'deepseek-v4.1-flash',
  input: '只回答：好',
  // 2026-11-11：业务实际用 reasoning.effort=high；temperature 在 high 下被忽略，
  // 所以用 high + max_output_tokens=0 做业务形状的官方校验探针。
  max_output_tokens: 0,
  reasoning: { effort: 'high' },
});

export function classifySessionProbe(status, text) {
  let msg = String(text || '');
  try { msg = JSON.parse(msg)?.error?.message || msg; } catch {}
  const m = String(msg);
  if (status === 0) return 'NET';
  if (status === 200) return 'NO_VALIDATION';
  if (status === 400 && /max_completion_tokens/i.test(m)) return 'MIS_MAP';
  if (status === 400 && (/max_tokens must be between/i.test(m) || /worker:\s*temperature/i.test(m))) return 'WORKER_WRAP';
  if (status === 400 && /invalid max_tokens value/i.test(m) && /valid range of max_tokens/i.test(m)) return 'OFFICIAL_TEXT';
  if (status === 400 && /invalid temperature value/i.test(m) && /valid range of temperature/i.test(m)) return 'OFFICIAL_TEXT';
  if (status === 400 && (/20015|failed to deserialize/i.test(m))) return 'WORKER_SERDE';
  if (status === 400) return 'OTHER_400';
  return 'HTTP_' + status;
}

export async function probeSession(session, opts = {}) {
  const baseUrl = (opts.baseUrl || 'https://opencode.ai/zen/go').replace(/\/+$/, '');
  const key = opts.key || process.env.OPENCODE_GO_API_KEY || '';
  const timeoutMs = opts.timeoutMs || 12000;
  const body = { ...SESSION_PROBE_BODY, model: opts.model || SESSION_PROBE_BODY.model };
  const data = Buffer.from(JSON.stringify(body), 'utf8');
  const u = new URL(baseUrl + '/v1/responses');
  const lib = u.protocol === 'http:' ? http : https;
  const t0 = Date.now();
  return new Promise((resolve) => {
    const req = lib.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search,
      method: 'POST', timeout: timeoutMs,
      headers: { 'content-type': 'application/json', 'content-length': data.length,
                 authorization: 'Bearer ' + key, 'x-opencode-session': session },
    }, (res) => {
      let text = ''; res.setEncoding('utf8');
      res.on('data', (c) => text += c);
      res.on('end', () => {
        let msg = text; try { msg = JSON.parse(text)?.error?.message || text; } catch {}
        resolve({ session, status: res.statusCode, kind: classifySessionProbe(res.statusCode, text),
                  ms: Date.now() - t0, msg: String(msg).replace(/\s+/g, ' ').slice(0, 180) });
      });
    });
    req.on('error', (e) => resolve({ session, status: 0, kind: 'NET', ms: Date.now() - t0,
      msg: String(e?.name || e?.message || e).slice(0, 180) }));
    req.on('timeout', () => { try { req.destroy(new Error('timeout')); } catch {} });
    req.end(data);
  });
}

export function randomSession() {
  return 'ses_' + crypto.randomBytes(16).toString('hex');
}

export async function pickOfficialSession(opts = {}) {
  const current = opts.current || '';
  const count = Math.max(1, Math.min(24, Number(opts.count) || 6));
  const timeoutMs = opts.timeoutMs || 12000;
  const baseUrl = opts.baseUrl;
  const key = opts.key;
  const model = opts.model;
  // 2026-11-11 实测：短名 sess-0..N 的 official 命中率明显高于随机 ses_<32hex>。
  // 默认候选同时放短名和长随机，避免只采到 WORKER_WRAP 池。
  const short = Array.from({ length: Math.max(4, count) }, (_, i) => 'sess-' + i);
  const long = Array.from({ length: Math.max(1, Math.ceil(count / 3)) }, randomSession);
  const list = opts.sessions && opts.sessions.length
    ? [...new Set(opts.sessions)]
    : [...new Set([current, ...short, ...long].filter(Boolean))];
  const results = [];
  for (const s of list) {
    const r = await probeSession(s, { baseUrl, key, model, timeoutMs });
    results.push(r);
    if (r.kind === 'OFFICIAL_TEXT') {
      return { picked: s, current, official: true, results };
    }
  }
  return { picked: current, current, official: false, results };
}

export function writeSessionFile(file, session) {
  if (!file || !session) throw new Error('session file/session required');
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  let backup = null;
  try {
    const old = fs.readFileSync(file, 'utf8').trim();
    if (old && old !== session) {
      backup = file + '.bak-' + new Date().toISOString().replace(/[:.]/g, '-');
      fs.writeFileSync(backup, old + '\n', 'utf8');
    }
  } catch {}
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, session + '\n', 'utf8');
  fs.renameSync(tmp, file);
  return { file, session, backup };
}
