// N11 前缀缓存探针
// 用法：
//   官方：$env:DS_API_KEY='sk-...'; node scripts/n11-cache-probe.mjs --base https://api.deepseek.com/v1 --model deepseek-chat
//   门控：$env:GATE_TOKEN='...'; node scripts/n11-cache-probe.mjs --base http://127.0.0.1:8787/v1 --model deepseek-flash --token-env GATE_TOKEN
// 输出：控制台表格 + gate/logs/n11-<ts>.json
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };
const BASE = arg('base', 'https://api.deepseek.com/v1');
const MODEL = arg('model', 'deepseek-chat');
const TOKEN_ENV = arg('token-env', 'DS_API_KEY');
const PROTO = arg('proto', 'responses');          // responses | chat
const TOKEN = process.env[TOKEN_ENV] || '';
const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'gate', 'logs');

const WO = (n) => '这是用于测量前缀缓存的最小语料。'.repeat(1) + '编号' + n + '。';
// 构造约 n 个 token 的稳定前缀（中文约 1 token/字，取字数≈n）
// 2026-11-02：必须带随机盐，否则 prefixOf(n) 是 prefixOf(m>n) 的前缀，
// 会让「首次」行被上一组的缓存污染（实测踩过：B256 首次直接命中 256）。
const NEW_SALT = () => 1 + Math.floor(Math.random() * 1500);
const prefixOf = (n, salt = NEW_SALT()) =>
  Array.from({ length: n }, (_, i) => String.fromCharCode(0x4e00 + ((i * 37 + salt) % 1700))).join('') + '：';

function call(body, url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const data = Buffer.from(JSON.stringify(body));
    const headers = { 'content-type': 'application/json', 'content-length': data.length };
    if (TOKEN) headers.authorization = 'Bearer ' + TOKEN;
    if (TOKEN && TOKEN_ENV.startsWith('GATE')) headers['x-gate-token'] = TOKEN;
    const req = lib.request({ host: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname, method: 'POST', headers, timeout: 180000 }, (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.write(data); req.end();
  });
}

const usageOf = (r) => {
  try {
    const j = JSON.parse(r.body);
    if (j.usage) return j.usage;
    if (j.error) return { error: j.error.message || j.error.type };
  } catch {}
  // 流式：抓最后一条 data 帧
  const m = [...String(r.body).matchAll(/data:\s*(\{[\s\S]*?\})\s*$/gm)];
  if (m.length) { try { const j = JSON.parse(m[m.length - 1][1]); return j.response?.usage || j.usage || {}; } catch {} }
  return {};
};
const hitOf = (u) => {
  if (!u) return null;
  const a = u.input_tokens_details?.cached_tokens;
  if (typeof a === 'number') return a;
  const b = u.prompt_cache_hit_tokens;
  if (typeof b === 'number') return b;
  const c = u.cache_read_input_tokens;
  if (typeof c === 'number') return c;
  return null;
};

const rows = [];
async function probe(name, prompt, extra = {}) {
  const body = PROTO === 'chat'
    ? { model: MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 4, stream: false, ...extra }
    : { model: MODEL, input: prompt, max_output_tokens: 4, reasoning: { effort: 'none' }, ...extra };
  const p = PROTO === 'chat' ? '/chat/completions' : '/responses';
  const r = await call(body, BASE + p);
  const u = usageOf(r);
  const inTok = u?.input_tokens ?? u?.prompt_tokens ?? null;
  const hit = hitOf(u);
  const row = { name, status: r.status, input_tokens: inTok, cached: hit, miss: hit == null || inTok == null ? null : inTok - hit, error: typeof u?.error === 'string' ? u.error : null };
  rows.push(row);
  console.log(`  ${name.padEnd(34)} st=${row.status} in=${String(row.input_tokens).padStart(6)} cached=${String(row.cached).padStart(6)} miss=${String(row.miss).padStart(6)}${row.error ? ' err=' + row.error : ''}`);
  return row;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  console.log(`N11 前缀缓存探针   base=${BASE}  model=${MODEL}  proto=${PROTO}  token=${TOKEN ? '已提供' : '无'}`);
  if (!TOKEN) { console.log('  ⚠ 未提供 token：官方 API 需要 DS_API_KEY，否则会 401'); }

  const SALT_A = NEW_SALT();
  console.log('=== A. 基线：同一前缀连续两次 ===');
  const P = prefixOf(200, SALT_A);
  const a1 = await probe('A1 首次（应为 miss）', P + '问：1');
  const a2 = await probe('A2 同前缀+不同后缀', P + '问：2');

  console.log('=== B. 前缀长度阈值 ===');
  for (const n of [16, 32, 64, 128, 256, 512]) {
    const p = prefixOf(n, NEW_SALT());
    await probe(`B 前缀${n} 首次`, p + '问：x');
    await probe(`B 前缀${n} 复现`, p + '问：y');
  }

  console.log('=== C. 前缀改动位置敏感性（用 200 字前缀）===');
  await probe('C0 参照（原样）', P + '问：z');
  await probe('C1 改首字', 'X' + P.slice(1) + '问：z');
  await probe('C2 改中间', P.slice(0, 100) + 'Y' + P.slice(101) + '问：z');
  await probe('C3 只改后缀', P + '问：w');

  console.log('=== D. 并发同前缀（两条同时发）===');
  const PD = prefixOf(300, NEW_SALT());
  await Promise.all([probe('D1 并发-1', PD + '问：a'), probe('D2 并发-2', PD + '问：a')]);

  console.log('=== E. 存活时间（等 60s / 再等 120s）===');
  const PT = prefixOf(300, NEW_SALT());
  await probe('E0 打底', PT + '问：t0');
  await sleep(60000);
  await probe('E1 +60s', PT + '问：t1');
  await sleep(120000);
  await probe('E2 +180s', PT + '问：t2');
  await probe('E3 +180s 中段改动', PT.slice(0, 50) + 'Z' + PT.slice(51) + '问：t3');

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(OUT_DIR, `n11-${ts}.json`);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ base: BASE, model: MODEL, proto: PROTO, at: new Date().toISOString(), rows }, null, 2));
  console.log('结果已写入 ' + out);

  const hits = rows.filter(r => (r.cached || 0) > 0).length;
  console.log('汇总：' + rows.length + ' 次请求，' + hits + ' 次报告缓存命中');
})();
