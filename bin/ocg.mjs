#!/usr/bin/env node
/**
 * ocg — opencode-ds-route CLI（Windows 单平台）
 *
 *   ocg start            启动门控（默认命令）
 *   ocg doctor           一屏体检：node / key / 端口 / 服务 / 判据 / 客户端
 *   ocg audit            离线审计：依赖、出网、key 使用点、写盘点
 *   ocg diag             生成脱敏诊断摘要，直接贴 issue
 *   ocg setup dsh        打印 dsh provider 配置片段（--apply 追加并备份）
 *   ocg probe [--lite]   跑一次官方性探针
 *   ocg check            源码自检（264 条断言，不需要 key、不联网）
 *   ocg health           读取 /gate/health
 *
 * 零依赖：只用 Node 内置模块。配置优先级：已存在的环境变量 > 仓库根 .env（不读 cwd 的 .env）。
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE_DIR = path.join(ROOT, 'gate');
/** Windows 下动态 import 必须给 file:// URL，直接传盘符路径会报 ERR_UNSUPPORTED_ESM_URL_SCHEME */
const importFile = p => import(pathToFileURL(p).href);

// ---------------- .env ----------------
function loadEnvFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
  return true;
}
// 只认仓库根的 .env。过去还会先读「当前工作目录」的 .env：在别人放好 .env 的目录里
// 运行本 CLI，GATE_HOST 会被改写到攻击者主机，用户 prompt 就会被送过去。
loadEnvFile(path.join(ROOT, '.env'));

const argv = process.argv.slice(2);
const cmd = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'start';
const rest = argv[0] && !argv[0].startsWith('-') ? argv.slice(1) : argv;
const PORT = Number(process.env.GATE_PORT || 8787);
const BASE = `http://127.0.0.1:${PORT}`;
const TASK_NAME = 'OpenCodeDS Route Gate';

const C = { ok: '\x1b[32m', bad: '\x1b[31m', warn: '\x1b[33m', dim: '\x1b[2m', off: '\x1b[0m' };
const line = (mark, label, detail = '') => {
  const m = mark === 'ok' ? `${C.ok}✅${C.off}` : mark === 'warn' ? `${C.warn}⚠${C.off}` : `${C.bad}❌${C.off}`;
  console.log(`${m} ${label.padEnd(16)} ${detail}`);
};
const die = msg => { console.error(`[ocg] ${msg}`); process.exit(1); };

// ---------------- 通用探测 ----------------
// ★ 2026-10-30：/gate/* 可选鉴权（GATE_OBS_TOKEN）。设了就必须带 token，否则 401。
const OBS_HEADERS = () => {
  const t = process.env.GATE_OBS_TOKEN;
  return t ? { 'x-gate-token': t } : undefined;
};
async function health(timeoutMs = 5000) {
  try {
    const r = await fetch(`${BASE}/gate/health`, { headers: OBS_HEADERS(), signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
async function getJson(p, timeoutMs = 5000) {
  try {
    const r = await fetch(BASE + p, { headers: OBS_HEADERS(), signal: AbortSignal.timeout(timeoutMs) });
    return await r.json();
  } catch { return null; }
}
function portFree(port) {
  return new Promise(resolve => {
    const s = net.createServer();
    s.unref();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}
function portOwner(port) {
  const r = spawnSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true });
  const row = (r.stdout || '').split(/\r?\n/).find(l => new RegExp(`:${port}\\s`).test(l) && /LISTENING/i.test(l));
  if (!row) return null;
  const pid = row.trim().split(/\s+/).pop();
  if (!/^\d+$/.test(pid)) return null;
  const t = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
  const name = (t.stdout || '').split(',')[0]?.replace(/"/g, '').trim() || '?';
  return { pid: Number(pid), name };
}
function taskState() {
  // 不能用 schtasks 的文本输出：中文 Windows 上它会把表头/字段本地化（实测输出"登录状态/模式"），
  // 英文 "Status:" 根本不存在，正则永远匹配不到。改用 PowerShell 的 Get-ScheduledTask，
  // 它返回的是枚举值（Ready / Running / Disabled），与系统语言无关。
  const ps = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `$t = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue; ` +
    `if ($t) { $t.State.ToString() } else { '__MISSING__' }`],
    { encoding: 'utf8', windowsHide: true });
  const out = (ps.stdout || '').trim();
  if (ps.status !== 0 || out === '__MISSING__' || !out) return null;
  return out;
}
/** 只判断 User 级环境变量"有没有值"，不把它读进日志或输出 */
function userEnvSet(name) {
  if (process.platform !== 'win32') return false;
  const r = spawnSync('reg', ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return false;
  const m = /REG_(?:SZ|EXPAND_SZ)\s+(.+)/.exec(r.stdout || '');
  return !!(m && m[1].trim());
}
function nodeMajor() {
  return Number(process.versions.node.split('.')[0]);
}

// ---------------- 交互式取 key ----------------
async function promptKey() {
  if (!process.stdin.isTTY) {
    die('缺少 OPENCODE_GO_API_KEY。\n' +
        '     设置：setx OPENCODE_GO_API_KEY "你的key"（之后新开终端）\n' +
        '     或在仓库根放 .env（模板见 .env.example）。');
  }
  console.log(`${C.warn}未检测到 OPENCODE_GO_API_KEY。${C.off}`);
  console.log(`${C.dim}key 只用于向上游发请求；本程序不缓存、不写日志、不外传。输入会显示在屏幕上。${C.off}`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(res => rl.question('粘贴你的 OpenCode Go key：', res));
  rl.close();
  const key = String(answer || '').trim();
  if (key.length < 10) die('key 看起来太短，未保存。');
  process.env.OPENCODE_GO_API_KEY = key;
  if (process.platform === 'win32') {
    const ps = spawnSync('powershell', ['-NoProfile', '-Command',
      `[Environment]::SetEnvironmentVariable('OPENCODE_GO_API_KEY', $env:OCG_TMP_KEY, 'User')`],
      { encoding: 'utf8', windowsHide: true, env: { ...process.env, OCG_TMP_KEY: key } });
    if (ps.status === 0) {
      console.log(`${C.ok}已写入 User 级环境变量。${C.off}${C.dim}（新开的终端才会继承；当前进程已直接使用）${C.off}`);
    } else {
      console.log(`${C.warn}写入 User 环境变量失败，本次运行仍可用；下次启动需重新提供。${C.off}`);
    }
  }
  return key;
}

// ---------------- 命令实现 ----------------
async function cmdStart() {
  if (!process.env.OPENCODE_GO_API_KEY) await promptKey();
  const h = await health(800);
  if (h?.ok) die(`端口 ${PORT} 上已经有一个门控在跑（/gate/health ok=true）。先结束它再启动（ocg doctor 可查 PID），换端口请设 GATE_PORT。`);
  if (!(await portFree(PORT))) {
    const o = portOwner(PORT);
    die(`端口 ${PORT} 被占用${o ? `：PID ${o.pid} (${o.name})` : ''}。` +
        `\n     本程序不会替你杀进程。请换端口：set GATE_PORT=8788，或自行结束该进程。`);
  }
  process.env.GATE_PORT ||= String(PORT);
  console.log(`${C.dim}启动门控：127.0.0.1:${PORT} → ${process.env.GATE_HOST || 'opencode.ai'}${C.off}`);
  await importFile(path.join(GATE_DIR, 'oc-gate.mjs'));
}

async function cmdDoctor() {
  let bad = 0;
  // 1 Node
  if (nodeMajor() >= 22) line('ok', 'Node', `v${process.versions.node}`);
  else { bad++; line('bad', 'Node', `v${process.versions.node}（需要 ≥ 22）→ 装 Node 22 LTS：https://nodejs.org/`); }

  // 2 key
  const key = process.env.OPENCODE_GO_API_KEY || '';
  // 2026-10-27 安全审查：不再打印 key 长度。
  // 原因：doctor 输出经常被贴进 issue/聊天，长度是账号维度的稳定特征，属不必要的弱泄露。
  if (key) line('ok', 'API key', '已设置（值不回显）');
  else if (userEnvSet('OPENCODE_GO_API_KEY')) {
    // 计划任务在登录时读 User 级变量，所以门控能用；只有当前终端没继承
    line('warn', 'API key', 'User 级已设置，但当前终端未继承 → 新开一个终端（门控不受影响）');
  } else { bad++; line('bad', 'API key', '未设置 → 运行 ocg start 会引导输入，或 setx OPENCODE_GO_API_KEY "..."'); }

  // 3 端口 / 服务
  const h = await health(1500);
  if (h?.ok) {
    line('ok', `端口 ${PORT}`, `门控在跑（selftest=${h.startupSelfTest?.verdict || 'pending'}）`);
    // 归属：同机可能装了多份（或旧版残留），端口通了不等于「跑的是仓库里这份代码」
    if (h.root) {
      // Windows 路径大小写不敏感，且可能经 8.3 短名 / junction 启动 → 归一后比较，避免误报"另一份安装"
      const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
      if (norm(h.root) === norm(ROOT)) line('ok', '门控归属', `当前仓库 ${ROOT}`);
      else line('warn', '门控归属', `跑的是另一份安装：${h.root}（当前仓库 ${ROOT}）→ 改这份代码不会生效`);
    } else {
      line('warn', '门控归属', '门控版本过旧（health 无 root 字段）→ 重启一次以启用归属识别');
    }
  } else {
    bad++;
    const owner = portOwner(PORT);
    if (owner) line('bad', `端口 ${PORT}`, `被 PID ${owner.pid} (${owner.name}) 占用，不是门控 → 换端口或结束该进程`);
    else line('bad', `端口 ${PORT}`, '没有门控在监听 → 运行 npm start（或双击 start.cmd）');
  }

  // 4 计划任务
  if (process.platform === 'win32') {
    const st = taskState();
    if (st) line('ok', '计划任务', `${TASK_NAME}：${st}（登录自启）`);
    else line('warn', '计划任务', '未注册 → 想开机自启就跑 install.ps1（不影响当前使用）');
  }
  // 5 判据新鲜度
  if (h) {
    if (typeof h.judgeAgeMs === 'number') {
      const age = `${(h.judgeAgeMs / 1000).toFixed(1)}s 前`;
      if (h.lastJudgeOk) line('ok', '判据', `最近一次通过：${age}（基线 ${h.baselineObservedAt}）`);
      else { bad++; line('bad', '判据', `最近一次未通过（${age}）→ 看 /gate/alerts 或 docs/CONFIG.md「503 怎么查」`); }
    } else {
      // 连上的是旧版本门控（没有 judgeAgeMs 字段）：不能当成"未通过"，否则会误导排查方向
      line('warn', '判据', '该门控未暴露判据字段（旧版本）→ 把它升级到本版本后重启，或直接看 /gate/proof');
    }
    line('ok', '出网目标', h.egressHost || '未知（旧版本门控未暴露）');
    line('ok', '本地鉴权', h.tokenRequired ? '已启用（需 x-gate-token）' : '未启用（仅本机可用）');
    if (h.blockedProtos?.length) line('ok', '封禁协议', h.blockedProtos.join(', '));
  }

  // 6 客户端配置：只看**当前端口**，否则 8788 的实例会被 8787 的配置误判为"已指向"
  const dshCfg = path.join(os.homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml');
  if (fs.existsSync(dshCfg)) {
    const t = fs.readFileSync(dshCfg, 'utf8');
    if (new RegExp(`127\\.0\\.0\\.1:${PORT}(?![0-9])`).test(t)) line('ok', 'dsh 配置', `已指向 127.0.0.1:${PORT}`);
    else if (/ocg-gated/.test(t)) line('warn', 'dsh 配置', `有 ocg-gated 但端口不是 ${PORT} → 检查 baseURL（${dshCfg}）`);
    else line('warn', 'dsh 配置', `存在但没指向门控 → 跑 ocg setup dsh 看片段（${dshCfg}）`);
  } else {
    line('warn', 'dsh 配置', '没找到 ~/.dsh/profiles/web/cordis.patch.yml（不用 dsh 可忽略）');
  }

  // 6b 客户端把真 key 送过 socket 了吗（R1）：门控只用自己的 key，客户端没理由带真 key。
  if (fs.existsSync(dshCfg)) {
    const t = fs.readFileSync(dshCfg, 'utf8');
    const leaks = [];
    let cur = '';
    for (const ln of t.split(/\r?\n/)) {
      const pk = /^\s*(ocg-gated(?:-msg)?):\s*$/.exec(ln);
      if (pk) { cur = pk[1]; continue; }
      if (/^\s*\S/.test(ln) && !/^\s*(apiKeyEnv|api|baseURL|displayName|models|headers|-)/
        .test(ln) && /^\s{0,6}\S/.test(ln)) cur = '';   // 离开 provider 块
      if (cur && /^\s*apiKeyEnv:\s*["']?(OPENCODE_GO_API_KEY)/.test(ln)) leaks.push(cur);
    }
    if (leaks.length) {
      line('warn', '客户端 key', `${leaks.join('/')} 用 OPENCODE_GO_API_KEY → 真 key 每次都会经 127.0.0.1 明文送出；` +
        `改成占位变量：ocg setup dsh（${PLACEHOLDER_ENV}=dummy 即可，门控不用它）`);
    } else if (new RegExp(`${PLACEHOLDER_ENV}`).test(t)) {
      if (!process.env[PLACEHOLDER_ENV]) {
        line('bad', '客户端 key', `配置用了占位 ${PLACEHOLDER_ENV}，但当前环境里没有它 → 先设置，然后**重启 dsh**`);
      } else {
        // 2026-10-26 现场教训：dsh 用**自己进程环境**解析 apiKeyEnv；变量晚于 dsh 启动写入时，
        // 会报 no credential 且该 provider 的模型从选择器里消失。前提写进同一行，不额外加噪。
        line('ok', '客户端 key', `占位 ${PLACEHOLDER_ENV}（真 key 不经过 socket；前提：dsh 在该变量写入之后启动）`);
      }
    }
  }

  console.log('');
  console.log(bad === 0
    ? `${C.ok}结论：门控正常。${C.off}`
    : `${C.bad}结论：有 ${bad} 项待处理，按上面 ❌ 后面的提示做。${C.off}`);
  process.exit(bad === 0 ? 0 : 1);
}

async function cmdAudit() {
  const files = {
    gate: [path.join(GATE_DIR, 'oc-gate.mjs'), path.join(GATE_DIR, 'baseline.mjs')],
    probe: [path.join(ROOT, 'probe', 'official-detect.mjs')],
    bin: [path.join(ROOT, 'bin', 'ocg.mjs')],
  };
  const read = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  const load = fs2 => fs2.map(f => ({ f: path.basename(f), text: read(f), lines: read(f).split('\n') }));
  const g = load(files.gate), p = load(files.probe), b = load(files.bin);
  const all = [...g, ...p, ...b];
  const everyLine = all.flatMap(x => x.lines);

  const deps = [...new Set([...everyLine.join('\n').matchAll(/from\s+'([^']+)'/g)].map(m => m[1]))]
    .filter(d => !d.startsWith('node:') && !d.startsWith('.'));

  const count = (arr, re) => arr.filter(l => re.test(l) && !l.trim().startsWith('//')).length;
  const gateEgress = count(g[0].lines, /const req = transport\.request\(/);
  const gateHosts = [...new Set([...g[0].lines.join('\n').matchAll(/host:\s*([A-Z_]+)/g)].map(m => m[1]))];
  const probeEgress = count(p[0].lines, /await fetch\(BASE/);
  const gateKey = count(g[0].lines, /\bKEY\b/);
  const probeKey = count(p[0].lines, /\bKEY\b/);
  const binKey = count(b[0].lines, /\bKEY\b/);
  const gateWrites = count(g[0].lines, /(writeFileSync|appendFileSync|renameSync|mkdirSync)\(/);
  const gateChild = count(g[0].lines, /child_process|spawnSync|execSync/);
  const probeChild = count(p[0].lines, /child_process|spawnSync|execSync/);
  const binChild = count(b[0].lines, /spawnSync\(/);
  const envNames = [...new Set([...everyLine.join('\n').matchAll(/process\.env\.([A-Z0-9_]+)/g)].map(m => m[1]))].sort();
  const live = await health(800);

  console.log('ocg audit —— 离线静态审计（不联网、不读 key）\n');
  console.log(`第三方依赖        ${deps.length} 个${deps.length ? '：' + deps.join(', ') : '（只用 Node 内置模块）'}`);
  console.log(`门控出网          gate/oc-gate.mjs：${gateEgress} 个调用点，host 恒为 ${gateHosts.join('/') || '?'}`);
  console.log(`探针出网          probe：${probeEgress} 个 fetch，目标 opencode.ai/zen/go`);
  console.log(`key 使用点        gate ${gateKey} / probe ${probeKey} / bin ${binKey} 处`);
  console.log(`写盘调用          gate ${gateWrites} 处（全部在 gate/logs/ 下）`);
  console.log(`外部进程          gate ${gateChild} / probe ${probeChild} 处；bin ${binChild} 处（只查本机 netstat/tasklist/schtasks/reg）`);
  console.log(`读取环境变量      ${envNames.length} 个`);
  console.log(`出网目标（运行值） ${live?.egressHost || `未运行，默认 ${process.env.GATE_HOST || 'opencode.ai'}:${process.env.GATE_HOST_PORT || 443}`}`);
  console.log(`本地鉴权          ${live ? (live.tokenRequired ? '已启用' : '未启用') : (process.env.GATE_TOKEN ? '已配置' : '未启用')}`);

  console.log('\n复现命令（自己跑一遍，不用信这段话）：');
  console.log('  grep -c "const req = transport.request(" gate/oc-gate.mjs');
  console.log('  grep -n "host: HOST" gate/oc-gate.mjs');
  console.log('  grep -n "\\bKEY\\b" gate/oc-gate.mjs');
  console.log('  grep -rn "child_process" gate/ probe/');
  console.log('  grep -rno "from \'[^\']*\'" gate/ probe/ bin/ | grep -v "node:"');
  console.log('  运行态核对：set GATE_TRACE=1 后启动，屏幕上只会出现 opencode.ai:443');

  console.log('\nkey 使用点明细（gate）：');
  for (const { l, i } of g[0].lines.map((l, i) => ({ l, i })).filter(x => /\bKEY\b/.test(x.l) && !x.l.trim().startsWith('//'))) {
    console.log(`  ${String(i + 1).padStart(5)}  ${l.trim().slice(0, 96)}`);
  }
}

function redact(s) {
  const key = process.env.OPENCODE_GO_API_KEY || '';
  let out = String(s);
  if (key.length > 6) out = out.split(key).join('<REDACTED_KEY>');
  // 真实 key 形如 oc_sk_...（下划线分隔），旧的 sk-[...] 规则匹配不到它
  out = out.replace(/\boc_sk_[A-Za-z0-9_-]{6,}/g, '<REDACTED_KEY>');
  out = out.replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '<REDACTED_KEY>');
  out = out.replace(/\btok_[A-Za-z0-9_-]{8,}/g, '<REDACTED_TOKEN>');
  out = out.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g, 'Bearer <REDACTED>');
  out = out.replace(/ses_[a-z0-9]{8,}/gi, '<REDACTED_SESSION>');
  out = out.replace(/[A-Za-z]:[\\/][^\s"']{2,}/g, '<PATH>');
  return out;
}

async function cmdDiag(outFile) {
  const h = await health();
  const alerts = await getJson('/gate/alerts');
  const logFile = path.join(GATE_DIR, 'logs', 'gate.jsonl');
  let tail = [];
  try {
    const raw = fs.readFileSync(logFile, 'utf8').trim().split(/\r?\n/).slice(-20);
    tail = raw;
  } catch {}
  const parts = [];
  parts.push('## ocg diag');
  parts.push(`生成时间: ${new Date().toISOString()}`);
  parts.push(`平台: ${process.platform} ${process.arch} / Node ${process.versions.node}`);
  parts.push(`端口: ${PORT}  出网目标: ${h?.egressHost || '(未运行)'}`);
  parts.push('');
  parts.push('### /gate/health');
  parts.push(h ? JSON.stringify({
    ok: h.ok, chain: h.chain, blockedProtos: h.blockedProtos,
    judgeAgeMs: h.judgeAgeMs, lastJudgeOk: h.lastJudgeOk,
    tokenRequired: h.tokenRequired, baselineObservedAt: h.baselineObservedAt,
    precheckTtlMs: h.precheckTtlMs, proofTrust: h.proofTrust, startupSelfTest: h.startupSelfTest,
  }, null, 2) : '(门控未运行)');
  parts.push('');
  parts.push('### /gate/alerts（已过滤 upstream 原文）');
  if (alerts) {
    const slim = JSON.parse(JSON.stringify(alerts));
    if (Array.isArray(slim.recentFailures)) {
      slim.recentFailures = slim.recentFailures.map(f => {
        const { upstream, ...keep } = f;
        return keep;
      });
    }
    parts.push(JSON.stringify(slim, null, 2));
  } else parts.push('(读不到)');
  parts.push('');
  parts.push('### 台账最近 20 条');
  parts.push(tail.length ? tail.join('\n') : '(无)');
  const text = redact(parts.join('\n'));

  if (outFile) {
    // 不要直接把 ENOENT/EACCES 的栈抛给用户：Node 的栈里带本机绝对路径，
    // 贴进 issue 就把目录结构一起泄了。
    try { fs.writeFileSync(outFile, text, 'utf8'); }
    catch (e) { die(`写入 ${outFile} 失败：${e?.message || e}`); }
    console.log(`已写入 ${outFile}（已脱敏：key / session / 本地路径）`);
  } else {
    console.log(text);
    console.log('\n' + C.dim + '以上内容已脱敏，可整段贴到 issue。' + C.off);
  }
}

/**
 * 生成要插到 `llm-pi-ai.config.providers` 下的 provider 片段。
 *
 * 为什么是"插入到 providers 下"而不是"新加一个 - id: llm-pi-ai 条目"：
 * 2026-10-23 实测（dsh --dump-config，改前备份、改后哈希还原）——
 * 同一个 id 再写一个条目，后者的 `config.providers` 会**整体替换**前一层的
 * providers 字典：原有的 `opencode-go` 与 `ocg-gated` 全部消失，只剩新条目里的键。
 * 也就是说"追加一个条目"会把用户自己的直连路由清空。所以只能往既有 providers 块里插。
 */
/**
 * 客户端侧用的占位 key 变量名。
 *
 * ★ 2026-10-26（R1）：门控**只用自己的环境变量**里的 key 打上游，客户端带来的 key 一律被覆盖
 *   （headersFor 无条件写 authorization / x-api-key）。所以客户端根本不需要真 key ——
 *   而 dsh 每发一次请求都会把 apiKeyEnv 指向的值塞进 HTTP 头送到 127.0.0.1。
 *   若那是真 key：同机其它 Windows 账户可以先抢占 8787 把明文 key 收走（GATE_TOKEN 挡不住这个）。
 *   改成占位值后，密钥不再经过任何 socket。
 */
const PLACEHOLDER_ENV = 'OCG_PLACEHOLDER_KEY';

function providerYaml(indent) {
  const token = process.env.GATE_TOKEN || '';
  const pad = n => ' '.repeat(indent + n);
  const hdr = token ? `${pad(2)}headers:\n${pad(4)}x-gate-token: "${token}"\n` : '';
  return [
    `${pad(0)}ocg-gated:`,
    `${pad(2)}displayName: "OpenCode Go · Responses（经门控）"`,
    `${pad(2)}apiKeyEnv: ${PLACEHOLDER_ENV}`,
    `${pad(2)}api: openai-responses`,
    `${pad(2)}baseURL: http://127.0.0.1:${PORT}/v1`,
    // 逐行拼接，避免模板里多一层缩进
  ].join('\n') + '\n' + (hdr ? hdr : '') + [
    `${pad(2)}models:`,
    `${pad(4)}- id: deepseek-flash      # 客户端别名：门控转发时归一为在售车道（当前 deepseek-v4.1-flash）`,
  ].join('\n');
}

function dshSnippet() {
  // 6 空格：与 dsh 自带配置里 `config:`(2) → `providers:`(4) → provider 键(6) 的层级对齐
  const body = providerYaml(6);
  return [
    '# 插入到 %USERPROFILE%\\.dsh\\profiles\\web\\cordis.patch.yml',
    '# 位置：找到已有的 `- id: llm-pi-ai` 条目，把它 `config.providers:` 下面',
    '#       与现有 provider（如 opencode-go）并列插入下面这段（同样缩进）。',
    '#',
    '# ⚠ 不要新加第二个 `- id: llm-pi-ai` 条目：实测后一个条目的 providers 会',
    '#   整体替换前一个，你会丢掉原有的 provider（包括直连 opencode-go）。',
    '# 改完必须重启 dsh 进程（cordis.patch.yml 只在启动时加载，刷新页面不够）。',
    body,
    '# 说明：',
    '#   · 只生成 responses 协议：2026-10-27 起 messages 默认封禁（上游 messages 侧混入',
    '#     非 UUID4 id 池），要恢复见 docs/CONFIG.md 的 GATE_ALLOW_MESSAGES。',
    `#   · apiKeyEnv 写的是占位变量 ${PLACEHOLDER_ENV}（值随便填，如 dummy）：**门控不用客户端带来的 key**，`,
    '#     它用自己的 OPENCODE_GO_API_KEY 打上游。这样真 key 不会经过任何 socket ——',
    '#     同机其它账户即便抢占了 8787 也拿不到它。直连 provider（不走门控）才需要真 key。',
    '#   · ⚠ dsh 从**自己的进程环境**解析 apiKeyEnv，不读实时系统变量：设完变量必须重启 dsh，',
    '#     否则会报 `no credential for provider route` 且该 provider 的模型会从选择器里消失。',
    '#   · 不想用环境变量时，也可以在 dsh 的 Models 页面为该 provider 存一份凭证（同样填 dummy）。',
    '#   · 门控启用 GATE_TOKEN 时，headers.x-gate-token 必须与门控一致',
  ].join('\n');
}

/** 在补丁层文本里找到 llm-pi-ai 块的 providers:，返回插入位置与子缩进 */
function locateProvidersSlot(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex(l => /^\s*-\s*id:\s*["']?llm-pi-ai["']?\s*$/.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^-\s/.test(lines[i])) { end = i; break; }   // 下一个顶层条目
  }
  for (let i = start; i < end; i++) {
    const m = /^(\s*)providers:\s*$/.exec(lines[i]);
    if (m) {
      const base = m[1].length;
      // 子键缩进：沿用在位 child 的缩进，取不到就用 +2
      let child = base + 2;
      for (let j = i + 1; j < end; j++) {
        const c = /^(\s*)\S/.exec(lines[j]);
        if (c && c[1].length > base) { child = c[1].length; break; }
      }
      return { index: i, indent: child, end };
    }
  }
  return null;
}

/**
 * 确保客户端占位 key 的环境变量存在（User 级，值为 dummy）。
 * 为什么需要它存在：dsh 启动时会解析 provider 的 apiKeyEnv，变量不存在则该 provider 不可用。
 * 这个值本身没有任何权限意义 —— 门控用自己环境里的真 key。
 */
function ensurePlaceholderEnv() {
  if (process.env[PLACEHOLDER_ENV]) return { ok: true, created: false };
  if (process.platform !== 'win32') return { ok: false, created: false };
  const ps = spawnSync('powershell', ['-NoProfile', '-Command',
    `[Environment]::SetEnvironmentVariable('${PLACEHOLDER_ENV}','dummy','User')`],
    { encoding: 'utf8', windowsHide: true });
  if (ps.status === 0) process.env[PLACEHOLDER_ENV] = 'dummy';
  return { ok: ps.status === 0, created: ps.status === 0 };
}

async function cmdSetup(args) {
  const target = args[0] || 'dsh';
  if (target !== 'dsh') die(`只支持 dsh：ocg setup dsh [--apply]`);
  const apply = args.includes('--apply');
  const cfg = path.join(os.homedir(), '.dsh', 'profiles', 'web', 'cordis.patch.yml');
  const ph = ensurePlaceholderEnv();
  console.log(dshSnippet());
  if (ph.created) {
    console.log(`\n${C.ok}已写入 User 环境变量 ${PLACEHOLDER_ENV}=dummy${C.off}${C.dim}（dsh 读它；门控不用它）${C.off}`);
    // 现场教训（2026-10-26）：dsh 只在**启动时**读自己的进程环境。设了变量不重启 dsh，
    // 它会报 `no credential for provider route`，该 provider 的模型会直接从选择器里消失。
    console.log(`${C.warn}⚠ 现在必须重启 dsh（完全关闭再打开）才生效；不重启会报 no credential、模型消失。${C.off}`);
    console.log(`${C.dim}  不想重启：把这两处 apiKeyEnv 改回 OPENCODE_GO_API_KEY 即可（功能不变，只是真 key 会经回环）。${C.off}`);
  }
  else if (ph.ok) console.log(`\n${C.dim}${PLACEHOLDER_ENV} 已存在（值不用改）${C.off}`);
  else console.log(`\n${C.warn}未能自动写入 ${PLACEHOLDER_ENV}，请手动：setx ${PLACEHOLDER_ENV} dummy${C.off}`);
  if (!apply) {
    console.log(`\n${C.dim}（只打印，不改文件。存在 llm-pi-ai 块时可加 --apply 自动插入，会先备份）${C.off}`);
    return;
  }
  if (!fs.existsSync(cfg)) die(`找不到 ${cfg}，请先装好 dsh 或手工创建该文件。`);
  const old = fs.readFileSync(cfg, 'utf8');
  if (/ocg-gated\s*:/.test(old)) die(`配置里已经出现 ocg-gated，未做改动：${cfg}`);
  const slot = locateProvidersSlot(old);
  if (!slot) {
    die(`没能在 ${cfg} 里定位 \`- id: llm-pi-ai\` 的 \`providers:\` 块，未做改动。\n` +
        `按上面的说明手工插入（新增一个 - id: llm-pi-ai 条目会覆盖已有 providers）。`);
  }
  const lines = old.split(/\r?\n/);
  const block = providerYaml(slot.indent).split('\n');
  const next = [...lines.slice(0, slot.index + 1), ...block, ...lines.slice(slot.index + 1)].join('\n');
  // 写前自检：条目数不变、两个新键各出现一次
  const count = (t, re) => (t.match(re) || []).length;
  const idCountBefore = count(old, /^\s*-\s*id:\s*["']?llm-pi-ai/gm);
  const idCountAfter = count(next, /^\s*-\s*id:\s*["']?llm-pi-ai/gm);
  if (idCountBefore !== idCountAfter) die('内部自检失败：条目数变化，未写入。');
  if (count(next, /^\s*ocg-gated:\s*$/gm) !== 1 || count(next, /^\s*ocg-gated-msg:\s*$/gm) !== 1) {
    die('内部自检失败：新 provider 键数量异常，未写入。');
  }
  const backup = `${cfg}.bak-${Date.now()}`;
  fs.copyFileSync(cfg, backup);
  fs.writeFileSync(cfg, next, 'utf8');
  console.log(`\n${C.ok}已插入到 ${cfg} 的 providers 下${C.off}`);
  console.log(`备份：${backup}`);
  console.log(`${C.warn}下一步：重启 dsh 进程，然后跑 ocg doctor 核对${C.off}`);
}

async function cmdHelp() {
  console.log([
    'ocg — opencode-ds-route（Windows 单平台）',
    '',
    '  ocg start            启动门控（默认）',
    '  ocg doctor           一屏体检，每个 ❌ 都带下一步',
    '  ocg audit            离线审计：依赖 / 出网 / key 使用点 / 写盘',
    '  ocg diag [--out F]   脱敏诊断摘要，贴 issue 用',
    '  ocg setup dsh [--apply]  打印 dsh 配置片段',
    '  ocg probe [--lite]   跑一次官方性探针',
    '  ocg check            源码自检（273 条断言，不需要 key）',
    '  ocg health [--json]  读取 /gate/health',
    '',
    '环境变量：OPENCODE_GO_API_KEY（必填）、GATE_PORT（默认 8787）、GATE_TOKEN（可选本地鉴权）',
    '完整清单：docs/CONFIG.md',
  ].join('\n'));
}

// ---------------- 分发 ----------------
async function main() {
  switch (cmd) {
    case 'start': return cmdStart();
    case 'probe': {
      if (!process.env.OPENCODE_GO_API_KEY) await promptKey();
      process.env.OCG_ROOT ||= ROOT;
      return importFile(path.join(ROOT, 'probe', 'official-detect.mjs'));
    }
    case 'check': {
      const r = spawnSync(process.execPath, [path.join(GATE_DIR, 'verify-patch.mjs')], { stdio: 'inherit' });
      process.exit(r.status ?? 1);
    }
    case 'health': {
      const h = await health();
      if (!h) die(`连不上 ${BASE}/gate/health —— 门控没在跑？先 npm start 或 ocg doctor`);
      if (rest.includes('--json')) console.log(JSON.stringify(h, null, 2));
      else {
        console.log(`ok=${h.ok}  port=${h.port}  selftest=${h.startupSelfTest?.verdict || 'pending'}`);
        console.log(`upstream=${h.egressHost}  chain=${(h.chain || []).join(' → ')}`);
        console.log(`judge: ${typeof h.judgeAgeMs === 'number' ? (h.lastJudgeOk ? 'pass' : 'NOT pass') : 'n/a（旧版本门控）'}  age=${h.judgeAgeMs ?? '?'}ms  baseline=${h.baselineObservedAt || '?'}`);
        console.log(`blocked=${(h.blockedProtos || []).join(',') || '-'}  tokenRequired=${h.tokenRequired}`);
      }
      process.exit(0);
    }
    case 'doctor': return cmdDoctor();
    case 'audit': return cmdAudit();
    case 'diag': return cmdDiag(rest.find(a => a.startsWith('--out='))?.slice(6) || (rest[0] === '--out' ? rest[1] : null));
    case 'setup': return cmdSetup(rest);
    case 'help': case '--help': case '-h': return cmdHelp();
    default: die(`未知命令 ${cmd}。用 ocg help 看用法。`);
  }
}

main().catch(e => {
  // 默认只打 message：栈里有本机绝对路径，用户一贴就泄漏目录结构。
  console.error(`[ocg] 失败：${e?.message || e}`);
  if (process.env.OCG_DEBUG === '1' && e?.stack) console.error(e.stack);
  process.exit(1);
});
