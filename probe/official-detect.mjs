/**
 * 官方性探针 v2 —— 修补 D1/D2/D4/D7，完成 O1/O3/O4
 *
 * 相对 v1 的改动：
 *   D4  六态错误分类（pass / fail / unknown + 原因细分），不再把 unknown 当 fail
 *   D7  E 类判据失效时可识别（网关拦截 → unknown，不是 fail）
 *   O1  P 类从 20 探针降到 3 探针取中位（800 token → 120 token）
 *   O3  支持 --lite 快速模式（只跑 E 类，0 token）
 *   O4  加权判定（4/4、3/4、2/4、≤1 分档）
 *   额外：原子写入、与上次 proof 对比检测突变、成本统计
 *
 * 用法：
 *   node official-detect.mjs                       # 默认测 opencode，写 proof
 *   node official-detect.mjs --target=official     # 校准官方基线
 *   node official-detect.mjs --lite                # 只跑 E 类（0 token）
 *   node official-detect.mjs --no-write            # 只打印不写文件
 */
import fs from 'node:fs';
import path from 'node:path';
// 判据基线唯一来源（与 gate/oc-gate.mjs 共用）。不要在本地复制这些正文字面量，
// 否则上游一变化就会出现「预检 pass、交付却 503」的漂移。
import {
  E1_MSG,
  E2_MAX,
  E3_RANGE,
  P1_TOP1_MAX,
  GATEWAY_BLOCK,
  MSG_FINGERPRINT,
  OBSERVED_AT,
} from '../gate/baseline.mjs';

const ARGS = process.argv.slice(2);
const getArg = (k, d) => {
  const hit = ARGS.find(a => a.startsWith(`--${k}=`));
  return hit ? hit.split('=').slice(1).join('=') : d;
};
const hasFlag = k => ARGS.includes(`--${k}`);

const TARGET = getArg('target', 'opencode');
const LITE = hasFlag('lite');
const WRITE = !hasFlag('no-write');

const ROOT = process.env.OCG_ROOT || path.resolve(import.meta.dirname, '..');
const PROOF_FILE = path.join(ROOT, 'gate/logs/official-proof.json');
const LOG_FILE = path.join(ROOT, 'probe/probe.log');

const IS_OFFICIAL_TARGET = TARGET === 'official';
const KEY = IS_OFFICIAL_TARGET ? process.env.DEEPSEEK_API_KEY : process.env.OPENCODE_GO_API_KEY;
const BASE = IS_OFFICIAL_TARGET ? 'https://api.deepseek.com' : 'https://opencode.ai/zen/go';
const HDR = IS_OFFICIAL_TARGET
  ? { 'content-type': 'application/json', authorization: `Bearer ${KEY}` }
  : { 'content-type': 'application/json', authorization: `Bearer ${KEY}`, 'x-opencode-session': 'ses_probe_v2' };

// ---------- 基线常量：全部来自 ../gate/baseline.mjs（唯一来源）----------
// 这里只是给下游旧代码沿用旧字段名，不重新定义任何判据。
const BASELINE = {
  e1_msg: E1_MSG,
  e2_max: E2_MAX,
  e3_range: E3_RANGE,
  p1_top1_max: P1_TOP1_MAX,       // top1 logprob 应小于此值（越负越不确定）
  p1_gateway_block: GATEWAY_BLOCK,
};

const cost = { tokens: 0, calls: 0 };
const results = [];

function logLine(s) {
  const line = `[${new Date().toISOString()}] ${s}`;
  console.log('  ' + s);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch {}
}

/**
 * 六态分类（D4）
 *   pass    : 明确符合官方
 *   fail    : 明确不符合官方
 *   gateway : 被网关拦下，没到上游（不是官方也不是非官方）
 *   rate    : 限流
 *   net     : 网络/超时/5xx
 *   format  : 返回了 400 但消息不认识（判据可能失效）
 */
async function post(pathname, bodyObj, timeoutMs = 20000) {
  cost.calls++;
  const t0 = Date.now();
  try {
    const r = await fetch(BASE + pathname, {
      method: 'POST', headers: HDR, body: JSON.stringify(bodyObj),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await r.text();
    const ms = Date.now() - t0;
    let j = null; try { j = JSON.parse(text); } catch {}
    if (j?.usage) {
      const u = j.usage;
      cost.tokens += (u.input_tokens ?? u.prompt_tokens ?? 0) + (u.output_tokens ?? u.completion_tokens ?? 0);
    }
    return { status: r.status, text, j, ms };
  } catch (e) {
    return { status: -1, text: String(e.message), j: null, ms: Date.now() - t0, netError: true };
  }
}

function classify(res, passRe) {
  if (res.netError) return { verdict: 'net', ms: res.ms, detail: res.text.slice(0, 120) };
  if (res.status === 429) return { verdict: 'rate', ms: res.ms, detail: 'HTTP 429' };
  if (res.status >= 500) return { verdict: 'net', ms: res.ms, detail: `HTTP ${res.status}` };
  const msg = res.j?.error?.message || '';
  if (res.status === 400 || res.status === 422) {
    if (passRe.test(msg)) return { verdict: 'pass', ms: res.ms, detail: msg.slice(0, 140) };
    if (BASELINE.p1_gateway_block.test(msg)) return { verdict: 'gateway', ms: res.ms, detail: msg.slice(0, 120) };
    return { verdict: 'format', ms: res.ms, detail: msg.slice(0, 140) };
  }
  return { verdict: 'format', ms: res.ms, detail: `HTTP ${res.status} ${msg.slice(0, 100)}` };
}

// ---------- E 类判据 ----------
async function runE1() {
  const r = await post('/v1/responses', { model: 'deepseek-flash', max_output_tokens: 8 });
  return { id: 'e1', name: '缺 input 返回官方业务错误', ...classify(r, BASELINE.e1_msg) };
}
// 2026-10-20 停用 e2/e3：OpenCode 网关层改为自行拦截参数校验（返回 "Upstream response was invalid"
// 或直接 200），不再穿透到 DeepSeek 后端，因此无法作为官方判据。实测 10 个候选用例中只有 e1 仍一致。

// ---------- P 类判据（O1：8 个极稳定探针，实测极差=0）----------
// 筛选依据：官方 API 上 30 个候选 × 3 次测量，只保留 top1 极差为 0 且 |top1| < 1e-3 的。
// 中文探针全部被淘汰（top1 达 1e-2~1e-1 量级，极差大，不可用）。
const P_PROBES = [
  'The past tense of "go" is',
  'Monday comes before',
  'The first letter of the alphabet is',
  'The freezing point of water in Celsius is',
  'The opposite of up is',
  'The capital of France is',
  'The boiling point of water in Celsius is',
  'The largest ocean on Earth is',
];
// 官方实测：min|top1| = 0 ~ 1.19e-7，max|top1| = 4.77e-7
// 判据用 min：正常应 ≤ 1e-5；量化会让所有探针一起变差，最小值也会 > 1e-4
const P1_MIN_ABS = 1e-5;

async function runP1() {
  const obs = [];
  for (const p of P_PROBES) {
    const r = await post('/v1/chat/completions', {
      model: 'deepseek-flash', max_tokens: 8, temperature: 0,
      messages: [{ role: 'user', content: p }],
      logprobs: true, top_logprobs: 3,
    }, 30000);
    if (r.netError || r.status !== 200 || !r.j?.choices?.[0]) {
      obs.push({ ok: false, verdict: r.netError ? 'net' : 'format', ms: r.ms, detail: `HTTP ${r.status}` });
      continue;
    }
    const lp = r.j.choices[0].logprobs;
    const seq = lp?.reasoning_content?.length ? lp.reasoning_content : lp?.content;
    if (!seq?.length) {
      obs.push({ ok: false, verdict: 'format', ms: r.ms, detail: 'no logprobs' });
      continue;
    }
    const top1 = seq[0].logprob;
    const top2 = seq[0].top_logprobs?.[1]?.logprob;
    obs.push({ ok: true, top1, gap: top2 != null ? top1 - top2 : null, ms: r.ms, n: seq.length });
  }
  const good = obs.filter(o => o.ok);
  if (!good.length) {
    const v = obs.map(o => o.verdict).filter(Boolean);
    const verdict = v.includes('net') ? 'net' : 'format';
    return { id: 'p1', name: '精度指纹（logprob 置信度）', verdict, ms: obs.reduce((s, o) => s + o.ms, 0) / obs.length, detail: `全部探针失败: ${v.join(',')}` };
  }
  const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const top1s = good.map(o => o.top1).filter(v => v != null && Number.isFinite(v));
  const gaps = good.map(o => o.gap).filter(v => v != null && Number.isFinite(v));
  // 用「最小 |top1|」（最自信的那个探针）：量化会让所有探针同时变差，
  // 而偶发负载抖动只影响个别探针，因此最小值比最大值稳健得多。
  const absMin = top1s.length ? Math.min(...top1s.map(Math.abs)) : null;
  const absMax = top1s.length ? Math.max(...top1s.map(Math.abs)) : null;
  const mGap = gaps.length ? med(gaps) : null;
  // 判据：所有探针的 |top1| 都必须落在浮点精度极限内。
  // 量化会系统性抬高该值（INT8 约 1e-3，INT4 约 1e-2）。
  const pass = absMin != null && absMin <= P1_MIN_ABS;
  const partial = good.length < obs.length;
  return {
    id: 'p1', name: '精度指纹（8 探针 |top1| 上限）',
    verdict: pass ? (partial ? 'format' : 'pass') : 'fail',
    ms: Math.round(obs.reduce((s, o) => s + o.ms, 0) / obs.length),
    detail: `min|top1|=${absMin?.toExponential(2)} max=${absMax?.toExponential(2)} (阈值 ${P1_MIN_ABS.toExponential(1)})${mGap != null ? ` gap=${mGap.toFixed(1)}` : ''} n=${good.length}/${obs.length}`,
    metrics: { top1: top1s, gap: gaps, absMin, absMax, medGap: mGap },
  };
}

// ---------- 主流程 ----------
logLine(`=== 探针启动 target=${TARGET} lite=${LITE} ===`);

const items = [];
items.push(await runE1());
// ★ 第 17 轮：p1（min|logprob| 精度指纹）**默认停用**。
//
// 停用理由（实测 2026-10-20，双端对照）：
//   该判据取「全序列最小的 |logprob|」，而任何模型在某个 token 上都会给出 0
//   （官方 chat 的 " need"=0；自部署 ollama 的 "<think>"=0）→ `0 <= 1e-5` 恒成立
//   → 判据永远 pass，实际上从未测到任何东西。
//
// 而且它测的是「模型质量（是否量化）」，而门控的目标已明确为「后端身份」：
//   · 官方自身降智 → 按用户口径不管
//   · 自部署/异模型 → 由 e1（错误文本 + request_id 形态）+ msgfp（400/422 分层）负责
//   · 转售官方 API 的第三方 → 响应逐字一致，任何黑盒判据都测不出
//
// 保留实现以便将来重新设计（例如改用首 token 的身份而非幅度），默认不参与 trust 计算。
// 需要临时启用：GATE_PROBE_P1=1
const ENABLE_P1 = (process.env.GATE_PROBE_P1 ?? '0') === '1';
if (!LITE && ENABLE_P1) items.push(await runP1());

for (const it of items) {
  const tag = it.verdict === 'pass' ? 'PASS' : it.verdict === 'fail' ? 'FAIL' : `UNKN(${it.verdict})`;
  logLine(`${tag.padEnd(14)} ${it.id} ${it.name.padEnd(26)} ${it.detail}  ${it.ms}ms`);
}

// O4：加权判定
const pass = items.filter(i => i.verdict === 'pass').length;
const fail = items.filter(i => i.verdict === 'fail').length;
const unknown = items.filter(i => !['pass', 'fail'].includes(i.verdict)).length;
const total = items.length;

let verdict, trust;
if (fail >= 2) { verdict = 'fail'; trust = 'none'; }
else if (pass === total) { verdict = 'pass'; trust = 'full'; }
else if (pass >= total - 1) { verdict = 'pass'; trust = 'high'; }
else if (pass >= Math.ceil(total / 2)) { verdict = 'degraded'; trust = 'low'; }
else { verdict = 'unknown'; trust = 'medium'; }

logLine(`汇总：pass=${pass} fail=${fail} unknown=${unknown} / ${total}  →  verdict=${verdict} trust=${trust}`);
logLine(`成本：${cost.tokens} token，${cost.calls} 次调用`);

// ---------- 与上次对比，检测突变 ----------
let prev = null;
try { prev = JSON.parse(fs.readFileSync(PROOF_FILE, 'utf8')); } catch {}
const changes = [];
if (prev && prev.target === TARGET) {
  if (prev.verdict === 'pass' && verdict !== 'pass') changes.push(`verdict: ${prev.verdict} → ${verdict}`);
  for (const it of items) {
    const p = prev.items?.find(x => x.id === it.id);
    if (p && p.verdict === 'pass' && it.verdict !== 'pass') {
      changes.push(`${it.id}: pass → ${it.verdict} (${it.detail.slice(0, 60)})`);
    }
  }
  if (prev.metrics?.medTop1 != null && items.find(i => i.id === 'p1')?.metrics?.medTop1 != null) {
    const a = Math.abs(prev.metrics.medTop1), b = Math.abs(items.find(i => i.id === 'p1').metrics.medTop1);
    if (a > 0 && b / a > 10) changes.push(`精度漂移：medTop1 ${a.toExponential(2)} → ${b.toExponential(2)} (${(b / a).toFixed(1)}x)`);
  }
}
if (changes.length) logLine(`⚠ 变化检测：${changes.join(' | ')}`);

// ---------- 原子写入 proof ----------
const TTL_MS = LITE ? 120000 : 1800000;   // lite 只给 2 分钟有效期（因为不校验精度）
const out = {
  ts: new Date().toISOString(),
  expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
  ttlMs: TTL_MS,
  target: TARGET,
  mode: LITE ? 'lite' : 'full',
  verdict,
  trust,
  pass, fail, unknown, total,
  changes,
  cost,
  items: items.map(i => ({ id: i.id, name: i.name, verdict: i.verdict, detail: i.detail, ms: Math.round(i.ms) })),
  metrics: items.find(i => i.id === 'p1')?.metrics ?? null,
};

if (WRITE) {
  try {
    fs.mkdirSync(path.dirname(PROOF_FILE), { recursive: true });
    const tmp = PROOF_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 1), 'utf8');
    fs.renameSync(tmp, PROOF_FILE);   // 原子替换
    logLine(`已写入 ${PROOF_FILE}  (trust=${trust}, 有效期 ${TTL_MS / 1000}s)`);
  } catch (e) {
    logLine(`写入失败: ${e.message}`);
  }
} else {
  logLine('--no-write，跳过写文件');
}

// 退出码：仅 fail 时非零（unknown 不视为失败）
process.exit(verdict === 'fail' ? 1 : 0);
