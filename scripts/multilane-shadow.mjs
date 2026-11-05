// 多车道影子观测：不动生产，起一条"官方信封优先"的副车道，按固定间隔发极小请求采样形态。
//
// 用途（2026-11-05 阶段二）：验证「判负即切换」在真实上游下的行为——
//   · 首车道（deepseek-v4-pro）是不是裸 UUID4 / 26 字段（与 flash 的 resp_uuid4 / 18 字段可区分）
//   · 同 host 双车道时 rankCandidates 会不会真的换道、换道后 winner 是谁
//   · per-lane 预检是否各出一条结论（而不是只探首车道）
//
// 用法：
//   node scripts/multilane-shadow.mjs                 # 默认 8899 / 每 10 分钟一条 / 6 轮
//   node scripts/multilane-shadow.mjs --port 8899 --every 5 --rounds 3
//   node scripts/multilane-shadow.mjs --chain deepseek-v4-pro,deepseek-v4.1-flash
//
// 产物：gate/logs/tests/shadow-multilane.jsonl + 同目录 .summary.json（每轮一行）
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const arg = (k, d) => {
  const i = process.argv.indexOf('--' + k);
  return i >= 0 ? process.argv[i + 1] : d;
};
const PORT = Number(arg('port', 8899));
const EVERY = Math.max(1, Number(arg('every', 10))) * 60_000;
const ROUNDS = Math.max(1, Number(arg('rounds', 6)));
// 2026-11-05：默认链必须**不含被禁模型**（deepseek-v4-pro 已在 FORBIDDEN 里，配了会被静默剔除，
// 于是脚本会悄悄退化成单车道、观测不到任何切换）。默认只留当前在售车道，多车道请显式 --chain。
const CHAIN = arg('chain', process.env.GATE_CHAIN || 'deepseek-v4.1-flash');

const ROOT = path.resolve(import.meta.dirname, '..');
const DIR = path.join(ROOT, 'gate', 'logs', 'tests');
fs.mkdirSync(DIR, { recursive: true });
const LOG = path.join(DIR, 'shadow-multilane.jsonl');
const SUM = path.join(DIR, 'shadow-multilane.summary.json');
const SNAP = path.join(DIR, 'shadow-multilane-matrix.json');
const EVID = path.join(DIR, 'shadow-multilane-evidence.json');
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startGate() {
  const env = {
    ...process.env,
    GATE_PORT: String(PORT),
    GATE_TOKEN: '',                        // 影子不鉴权，避免和生产 GATE_TOKEN 混淆
    GATE_CHAIN: CHAIN,
    GATE_HEDGE: '1',
    GATE_LOG_FILE: LOG,
    GATE_SNAPSHOT: SNAP,
    GATE_EVIDENCE_FILE: EVID,
    GATE_EVIDENCE_AUTO_REFRESH: '0',       // 观测期不自动刷证据，避免额外上游调用干扰结论
    GATE_PERLANE_PRECHECK: '1',
    GATE_REFRESH_MS: '0',
    GATE_ASSURANCE: 'label',               // 只观测，不因证据过期拒绝
    GATE_CANARY_POLICY: 'label',
    GATE_L0_POLICY: 'label',
  };
  const child = spawn(process.execPath, [path.join(ROOT, 'gate', 'oc-gate.mjs')], {
    env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let err = '';
  child.stderr.on('data', (d) => { err += d.toString(); });
  child.on('exit', (code) => { if (code !== 0) console.error('[shadow] gate 退出 code=' + code + ' ' + err.slice(0, 200)); });
  return child;
}

async function waitUp(ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(BASE + '/gate/health');
      if (r.ok) return await r.json();
    } catch {}
    await sleep(300);
  }
  return null;
}

async function oneRound(i) {
  const t0 = Date.now();
  let out = { round: i + 1, at: new Date().toISOString(), ms: null, status: null, result: null, winner: null, attempts: [], lanes: null };
  try {
    const r = await fetch(BASE + '/v1/responses', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', input: '只回答：好', max_output_tokens: 8 }),
    });
    out.status = r.status;
    out.result = r.headers.get('x-gate-result');
    out.ms = Date.now() - t0;
    await r.text();
  } catch (e) {
    out.error = String(e.message || e);
    return out;
  }
  try {
    const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
    for (let k = lines.length - 1; k >= 0; k--) {
      const rec = JSON.parse(lines[k]);
      if (rec.result === 'PASS_BY_PROOF' || rec.result === 'PASS' || /^BLOCKED/.test(rec.result || '')) {
        out.winner = rec.model || null;
        out.attempts = (rec.attempts || []).map((a) => ({ model: a.model, verdict: a.verdict, idShape: a.idShape, ms: a.ms }));
        out.laneRecs = lines.slice(Math.max(0, k - 12), k).filter((l) => l.includes('"result":"PRECHECK"')).length;
        break;
      }
    }
    const h = await (await fetch(BASE + '/gate/health')).json();
    out.lanes = h.chain;
    out.phase = h.phase || null;
    out.precheckProfile = h.precheckProfile || null;
  } catch (e) { out.probeError = String(e.message || e); }
  fs.appendFileSync(SUM, JSON.stringify(out) + '\n');
  return out;
}

if (!process.env.OPENCODE_GO_API_KEY) {
  console.error('[shadow] 缺少 OPENCODE_GO_API_KEY：请在已继承该变量的终端里运行（setx 后要新开终端）。');
  process.exit(1);
}
const gate = startGate();
const h = await waitUp();
if (!h) {
  console.error('[shadow] 门控没起来（端口 ' + PORT + ' 被占？看 gate/logs/tests/shadow-multilane.jsonl）');
  try { gate.kill(); } catch {}
  process.exit(1);
}
console.log(`[shadow] ${BASE} chain=${JSON.stringify(h.chain)} perLane=${h.evidence ? 'on' : '?'} rounds=${ROUNDS} every=${EVERY / 60000}min`);
// 2026-11-05：ALLOWED 会被 FORBIDDEN 过滤（如 deepseek-v4-pro），因此"要了多车道"不等于"真的有多车道"。
// 只剩一条时判负切换永远不会发生，必须显式说破，否则跑一晚也观测不到任何切换。
if (h.chain.length < 2) {
  console.warn('[shadow] ⚠ 当前 ALLOWED 只有一条车道 —— 判负即切换不会被触发，本次观测只能验证形态/预检。');
}

const done = [];
try {
  for (let i = 0; i < ROUNDS; i++) {
    const r = await oneRound(i);
    done.push(r);
    console.log(`[shadow] #${i + 1} status=${r.status} winner=${r.winner} attempts=${JSON.stringify(r.attempts.map((a) => a.verdict + ':' + a.idShape))}`);
    if (i < ROUNDS - 1) await sleep(EVERY);
  }
} finally {
  try { gate.kill('SIGKILL'); } catch {}
  const agg = {
    at: new Date().toISOString(), chain: h.chain, rounds: done.length,
    winners: done.reduce((m, x) => { const k = String(x.winner); m[k] = (m[k] || 0) + 1; return m; }, {}),
    statuses: done.reduce((m, x) => { const k = String(x.status); m[k] = (m[k] || 0) + 1; return m; }, {}),
    laneVerdicts: done.flatMap((x) => x.attempts).reduce((m, a) => { const k = a.model + ':' + a.verdict; m[k] = (m[k] || 0) + 1; return m; }, {}),
  };
  fs.appendFileSync(SUM, JSON.stringify(agg) + '\n');
  console.log('[shadow] 汇总 ' + JSON.stringify(agg));
}
