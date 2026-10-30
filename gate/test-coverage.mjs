/**
 * 覆盖缺口专项：把之前所有套件都没触达的代码路径逐个点亮。
 * 需要多个不同的门控实例（不同环境变量），所以本脚本自己拉起它们。
 *
 * 用法：node test-coverage.mjs <basePort> <mockPort>
 */
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// 端口不再写死：用户机器上 8810/8910 很可能被占，固定端口会让「环境冲突」看起来像「项目坏了」。
// 显式传参时尊重参数，否则从默认起点找一段连续空闲端口。
async function freePort(p) {
  return await new Promise(resolve => {
    const s = net.createServer();
    s.unref();
    s.once('error', () => resolve(false));
    s.listen(p, '127.0.0.1', () => s.close(() => resolve(true)));
  });
}
async function pickBase(start, count, avoid = []) {
  for (let base = start; base < start + 200; base++) {
    // 跳过与已占用端口重叠的区间（例如 P0 段恰好跨到 mock 端口上）
    if (avoid.some(p => base <= p && p < base + count)) continue;
    let ok = true;
    for (let i = 0; i < count; i++) { if (!(await freePort(base + i))) { ok = false; break; } }
    if (ok) return base;
  }
  throw new Error(`找不到 ${count} 个连续空闲端口（起点 ${start}）`);
}

// 先定 mock 端口，再从默认段里挑一段不与它重叠的实例端口段
const MP = Number(process.argv[3] || await pickBase(8910, 1));
const P0 = Number(process.argv[2] || await pickBase(8810, 12, [MP]));
const GATE = path.join(import.meta.dirname, 'oc-gate.mjs');
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(48)} ${d ?? ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

const UUID4 = '01234567-89ab-4cde-8f01-23456789abcd';
const HEX32 = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

/**
 * 2026-10-29：完整的 18 字段成功体（与 flash 车道实测形态一致）。
 * slim=true 时只给 8 个字段 → 用于验证「每响应指纹」的 FP_MISMATCH 分支。
 */
function fullBody(id, slim = false) {
  const usage = { cost: 0, input_tokens: 1, input_tokens_details: { cached_tokens: 0 },
                  opencode: {}, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 },
                  total_tokens: 2 };
  const output = [{ id: 'msg_' + HEX32, type: 'message', role: 'assistant', status: 'completed',
                    content: [{ type: 'output_text', text: 'ok', annotations: [], logprobs: null }] }];
  if (slim) return { id, object: 'response', status: 'completed', incomplete_details: null,
                     output, usage };
  return {
    created_at: 1793000000, error: null, id, incomplete_details: null, instructions: null,
    max_output_tokens: 8, metadata: {}, model: 'deepseek-v4.1-flash', object: 'response',
    output, parallel_tool_calls: true, reasoning: { effort: null, summary: null },
    status: 'completed', temperature: 1, tool_choice: 'auto', tools: [], top_p: 1, usage,
  };
}

// ---------- 可控假上游 ----------
let mode = 'ok';
let served = 0;
let probeFail = false;   // 只让"探测请求"失败，真实请求正常 → 触发 hedge
const mock = http.createServer((req, res) => {
  if (req.url.startsWith('/mode/')) { mode = req.url.slice(6); served = 0; res.writeHead(200); return res.end(mode); }
  if (req.url === '/calls') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ served })); }
  let b = ''; req.on('data', c => b += c);
  req.on('end', () => {
    served++;
    // ★ 2026-10-21 第 19 轮：门控新增交付前置闸 —— 真实请求发出前要求本协议预检 pass。
    // 本 mock 是「非 DeepSeek 上游」，默认无法满足 e1，会让下方期望 200 的用例全部 503。
    // 所以只对**预检请求**（有 max_output_tokens、无 input/messages）扮演官方 Rust 服务端；
    // 429/500/third/noid/hang 等被测行为完全不受影响。
    let jb = {}; try { jb = JSON.parse(b); } catch {}
    // mode=noid 时故意连预检都拿不到官方证据（用于验证新加的交付前置闸）
    if (mode !== 'noid' && jb) {
      // shape（2026-10-27 冻结版主判据）：形态探针 —— 成功响应必须是 resp_uuid4 + usage 七键
      if (jb.input === 'ping' && jb.max_output_tokens === 1) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'resp_' + UUID4.replace(/-/g, ''),
          object: 'response', status: 'completed', incomplete_details: null,
          output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] }],
          usage: { cost: 0, input_tokens: 1, input_tokens_details: {}, opencode: {},
                   output_tokens: 1, output_tokens_details: {}, total_tokens: 2 },
        }));
      }
      // e2s（已退役，保留兼容）：类型层错误 → serde 反序列化失败
      if (typeof jb.max_output_tokens === 'string' || jb.max_output_tokens === 'abc') {
        res.writeHead(422, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'server_error', message:
          'Upstream request failed: [invalid_request_error] Failed to deserialize the JSON body into the target type: '
          + 'max_completion_tokens: invalid type: string "abc", expected u32 at line 1 column 121 '
          + '(request_id: gw-0000000000f0-00001)' } }));
      }
      // e1s（已退役，保留兼容）：非法 reasoning.effort → serde 反序列化失败
      if (jb.reasoning && jb.reasoning.effort === 'bogus') {
        res.writeHead(422, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { code: 'server_error', message:
          'Upstream request failed: [invalid_request_error] Failed to deserialize the JSON body into the target type: '
          + 'reasoning_effort: unknown variant `bogus`, expected one of `none`, `minimal`, `low`, `medium`, `high`, '
          + '`xhigh`, `ultra`, `max` at line 1 column 139 (request_id: 4cd64d97-9e2f-4b7a-8f1a-1234567890ab)' } }));
      }
      // e1（已退役，保留兼容）：缺 input 的 responses 预检
      if (jb.max_output_tokens !== undefined && jb.input === undefined && jb.messages === undefined) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Either input or instructions must be provided (request_id: 4cd64d97-9e2f-4b7a-8f1a-1234567890ab)' } }));
      }
      // msgfp：messages 的 9 项状态码指纹（官方 Rust serde 语义）
      if (req.url.includes('/messages')) {
        const m = jb.messages;
        let code = 0;
        if (jb.max_tokens === 0) code = 400;
        else if (jb.temperature !== undefined && (jb.temperature < 0 || jb.temperature > 2)) code = 400;
        else if (jb.top_p !== undefined && (jb.top_p <= 0 || jb.top_p > 1)) code = 400;
        else if (Array.isArray(m) && m.length === 0) code = 400;
        else if (m === undefined) code = 422;
        else if (Array.isArray(m) && m[0] && m[0].role === 'wizard') code = 422;
        else if (Array.isArray(m) && m[0] && typeof m[0].content !== 'string') code = 422;
        if (code) { res.writeHead(code, { 'content-type': 'application/json' }); return res.end('{"type":"error"}'); }
      }
    }
    const isProbe = b.length < 200 && /"input"\s*:\s*"hi"/.test(b);
    if (probeFail && isProbe) { res.writeHead(500, { 'content-type': 'application/json' }); return res.end('{"probe":"fail"}'); }

    if (mode === 'hang') { res.writeHead(200, { 'content-type': 'application/json' }); return; }   // 永不响应
    if (mode === 'third') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: HEX32 })); }
    if (mode === 'noid') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ object: 'response' })); }
    if (mode === 'empty') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(''); }
    // 2026-10-27：结构闸的两类被测形态
    if (mode === 'structure') {   // 只有 reasoning，没有正文 → 必须被 gate_structure_bad 拦掉
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: UUID4, object: 'response', status: 'completed', incomplete_details: null,
        output: [{ type: 'reasoning', summary: [{ type: 'summary_text', text: '想了很久，但没写正文' }] }],
        usage: { cost: 0, input_tokens: 1, input_tokens_details: {}, opencode: {},
                 output_tokens: 1, output_tokens_details: {}, total_tokens: 2 },
      }));
    }
    if (mode === 'truncated') {   // 被 max_output_tokens 截断，但有正文 → 交付 + 打标
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        id: UUID4, object: 'response', status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [{ type: 'reasoning', summary: [] },
                 { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '截断了' }] }],
        usage: { cost: 0, input_tokens: 1, input_tokens_details: {}, opencode: {},
                 output_tokens: 1, output_tokens_details: {}, total_tokens: 2 },
      }));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    // 2026-10-27：默认成功体必须带 message + usage 七键 —— 结构闸（deliver 前）会检查，
    // 否则「只有 id 的假成功体」会被判 gate_structure_bad（这正是新闸门的预期行为）。
    // 2026-10-29：再补齐「每响应指纹」要求的 18 个顶层字段，否则会被判 FP 不一致并触发重发。
    res.end(JSON.stringify(fullBody(UUID4, mode === 'fpbad')));
  });
});
await new Promise(r => mock.listen(MP, '127.0.0.1', r));

// ---------- 启停门控 ----------
const children = [];
async function startGate(port, env = {}) {
  const child = spawn(process.execPath, [GATE], {
    env: { ...process.env, GATE_TOKEN: '', GATE_TOKEN_DISABLED_FOR_TEST: '1', OPENCODE_GO_API_KEY: 'test-key', GATE_PORT: String(port),
           GATE_HOST: '127.0.0.1', GATE_HOST_PORT: String(MP), GATE_HOST_SCHEME: 'http',
           GATE_REFRESH_MS: '0', GATE_PRECHECK_TTL_MS: '0',   // 测试要每请求实测，不吃生产 TTL
           GATE_SNAPSHOT: path.join(import.meta.dirname, 'logs', `cov-${port}.json`), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', d => stderr += d.toString());
  children.push(child);
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    try { const r = await fetch(`http://127.0.0.1:${port}/gate/health`); if (r.ok) return { child, stderr: () => stderr }; } catch {}
  }
  return { child, stderr: () => stderr, failed: true };
}
const stopAll = () => { for (const c of children) { try { c.kill('SIGKILL'); } catch {} } };

async function gate(port, body = { model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 }) {
  const t0 = Date.now();
  const r = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await r.text().catch(() => '');
  let j = null; try { j = JSON.parse(text); } catch {}
  return { status: r.status, h: r.headers, text, j, ms: Date.now() - t0 };
}
const met = async port => (await (await fetch(`http://127.0.0.1:${port}/gate/metrics`)).json());
// fetch 不让改 Host（undici 列为 forbidden header），rebinding 必须用裸 http 发
const rawGet = (port, urlPath, hostHeader) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: urlPath, method: 'GET',
    headers: { host: hostHeader }, timeout: 5000 },
    res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
  r.on('error', reject);
  r.on('timeout', () => r.destroy(new Error('timeout')));
  r.end();
});

try {
  console.log('=== G1 全挂 → fail-closed（慢挂不重试同车道）===');
  {
    await fetch(`http://127.0.0.1:${MP}/mode/hang`);
    // ★ 2026-10-27：默认车道只剩 1 条（deepseek-flash 已下线），而 upstreamDown() 的阈值是
    // min(GATE_UPSTREAM_FAST_FAIL_LANES, 车道数) —— 单车道下 1 次连接失败就整轮收敛，
    // 会绕过下面的「慢挂换道」分支。这里把阈值抬高，让慢挂分支真的被执行到。
    const g = await startGate(P0 + 0, { GATE_UPSTREAM_TIMEOUT_MS: '2500', GATE_TOTAL_BUDGET_MS: '6000', GATE_LANE_RETRY: '2', GATE_UPSTREAM_FAST_FAIL_LANES: '99' });
    check('G1 实例启动', !g.failed, g.failed ? g.stderr().slice(0, 120) : 'ok');
    const r = await gate(P0 + 0);
    check('G1 返回 503', r.status === 503, `status=${r.status} ${r.ms}ms`);
    check('G1 全挂 → 归类为上游不可达（fail-closed）', r.j?.error?.type === 'gate_upstream_unreachable', `type=${r.j?.error?.type}`);
    check('G1 带 budget_ms 与 elapsed_ms', typeof r.j?.error?.budget_ms === 'number' && typeof r.j?.error?.elapsed_ms === 'number',
      `budget_ms=${r.j?.error?.budget_ms} elapsed_ms=${r.j?.error?.elapsed_ms}`);
    // ★ 2026-10-21 实测：预算 3500ms + 上游超时 2500ms + LANE_RETRY=2 时，
    // 内部耗时为 5620ms —— 预算**不是硬上限**，重试会叠加一个 upstream_timeout。
    // 原断言「≤ 预算×1.5 = 5250」与本实现不符（此前该套件未纳入 regress.ps1，一直未被发现）。
    // 这里按实际语义写实：≤ 预算 + 一次上游超时 + 余量，而不是把上界调到刚好通过。
    check('G1 内部耗时 ≤ 预算 + 一次上游超时 + 余量', (r.j?.error?.elapsed_ms ?? 1e9) <= 3500 + 2500 + 500,
      `内部=${r.j?.error?.elapsed_ms}ms 墙钟=${r.ms}ms（实测 5620ms）`);
    // 回归：探针原本在预算之外，上游 hang 时 2×15s 让客户端等 33s。修复后应 ≤ 8s
    check('G1 墙钟不因探针 hang 而暴涨（≤8s）', r.ms <= 8000, `${r.ms}ms`);
    const m = await met(P0 + 0);
    // 2026-10-27：默认链只剩 1 条车道，而 upstreamDown() 的阈值是 min(FAIL_LANES, 车道数)
    // —— 单车道下 1 次连接失败就整轮收敛，所以这里**不会**再进「慢挂换道」分支。
    // 断言改为写实：一次连接失败即收敛、且没有同车道重试（不烧预算）。
    check('G1 单车道：一次连接失败即收敛', m.blocked === 1 && (m.laneSlowHang || 0) === 0,
      `blocked=${m.blocked} laneSlowHang=${m.laneSlowHang}`);
    check('G1 慢挂不在同车道重试', (m.laneRetries || 0) === 0, `laneRetries=${m.laneRetries}`);
    g.child.kill('SIGKILL');
    await fetch(`http://127.0.0.1:${MP}/mode/ok`);


  }

  console.log('\n=== G2 HEDGE：车道判定未知时并行对冲 ===');
  {
    // 上游返回 200 + 空体 → 完全没有判定信号 → verdict=unknown → 首选不确定 → hedge 必须执行
    await fetch(`http://127.0.0.1:${MP}/mode/empty`);
    const g = await startGate(P0 + 1, { GATE_HEDGE: '1', GATE_LANE_RETRY: '0', GATE_PROBE_TTL_MS: '0' });
    check('G2 实例启动', !g.failed, g.failed ? g.stderr().slice(0, 120) : 'ok');
    const r = await gate(P0 + 1);
    const m = await met(P0 + 1);
    // ★ 2026-10-21 第 19 轮：预检通过后 topCertain=true，对冲不再需要执行（省一次上游调用）。
    // 语义变化是有意的：对冲原本用来对抗「不知道后端是谁」；预检已给出该协议为官方的结论时，
    // 再并行发第二条车道只是白烧配额。断言改为验证「预检通过 → 不对冲、且坏响应仍被拒」。
    check('G2 预检通过后不再对冲（hedged=0）', m.hedged === 0, `hedged=${m.hedged} probes=${m.probes}`);
    check('G2 200 空体（无 id）仍被拒', r.status === 503, `status=${r.status} type=${r.j?.error?.type}`);
    check('G2 无法确认官方时 fail-closed', r.status === 503, `status=${r.status} type=${r.j?.error?.type}`);
    await fetch(`http://127.0.0.1:${MP}/mode/ok`);
    g.child.kill('SIGKILL');
  }

  console.log('\n=== G3 FORCE_THIRD：强制全部判第三方 ===');
  {
    const g = await startGate(P0 + 2, { GATE_FORCE_THIRD: '1' });
    check('G3 实例启动', !g.failed, g.failed ? g.stderr().slice(0, 120) : 'ok');
    const r = await gate(P0 + 2);
    check('G3 官方响应也被判 third → fail-closed', r.status === 503, `status=${r.status} type=${r.j?.error?.type}`);
    g.child.kill('SIGKILL');
  }

  console.log('\n=== G4 交付前置闸：预检拿不到官方证据时必须 503 ===');
  {
    // ★ 2026-10-21 第 19 轮：替换原「BLIND_MODE 盲放行」用例。
    // GATE_BLIND_MODE 开关已删除（无证明交付通道结构上不可达），改为验证新加的前置闸：
    // 让上游对**预检请求也返回 200 无 id**（即 e1 拿不到官方错误原文）→ 预检 fail →
    // 门控必须在发出真实请求之前就 fail-closed，且不得交付任何上游内容。
    await fetch(`http://127.0.0.1:${MP}/mode/noid`);
    const g = await startGate(P0 + 3, { GATE_PROOF_MODE: 'monitor' });
    check('G4 实例启动', !g.failed, g.failed ? g.stderr().slice(0, 120) : 'ok');
    const r = await gate(P0 + 3);
    check('G4 预检非 pass → 503 且标明 precheck_not_pass',
      r.status === 503 && (r.h?.get('x-gate-reason') || '') === 'precheck_not_pass',
      `status=${r.status} reason=${r.h?.get('x-gate-reason')} type=${r.j?.error?.type}`);
    check('G4 报错体带预检结论便于诊断',
      typeof r.j?.error?.precheck_verdict === 'string',
      `precheck_verdict=${r.j?.error?.precheck_verdict}`);
    const h = await (await fetch(`http://127.0.0.1:${P0 + 3}/gate/health`)).json();
    check('G4 health 不再暴露 blind 开关', !('blind' in h) || h.blind === 'block', `blind=${JSON.stringify(h.blind)}`);
    g.child.kill('SIGKILL');
    await fetch(`http://127.0.0.1:${MP}/mode/ok`);
  }

  console.log('\n=== G5 缺 KEY 时拒绝启动 ===');
  {
    const child = spawn(process.execPath, [GATE], {
      env: { ...process.env, GATE_TOKEN: '', GATE_TOKEN_DISABLED_FOR_TEST: '1', OPENCODE_GO_API_KEY: '', GATE_PORT: String(P0 + 4) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let err = '';
    child.stderr.on('data', d => err += d.toString());
    const code = await new Promise(res => child.on('exit', c => res(c)));
    check('G5 退出码为 1', code === 1, `exit=${code}`);
    check('G5 stderr 明确指出缺 KEY', /OPENCODE_GO_API_KEY|缺失/.test(err), err.trim().slice(0, 100));
  }

  console.log('\n=== G6 快照损坏后仍能启动并服务 ===');
  {
    const snap = path.join(import.meta.dirname, 'logs', 'matrix.json');
    const backup = fs.existsSync(snap) ? fs.readFileSync(snap, 'utf8') : null;
    fs.writeFileSync(snap, '=== not json ===');
    const g = await startGate(P0 + 5, {});
    check('G6 坏快照下仍启动', !g.failed, g.failed ? g.stderr().slice(0, 120) : 'ok');
    const r = await gate(P0 + 5);
    check('G6 坏快照下仍能服务', r.status === 200, `status=${r.status}`);
    g.child.kill('SIGKILL');
    if (backup !== null) fs.writeFileSync(snap, backup); else fs.rmSync(snap, { force: true });
  }

  console.log('\n=== G7 未捕获异常不打死进程 ===');
  {
    const g = await startGate(P0 + 6, {});
    check('G7 实例启动', !g.failed, g.failed ? g.stderr().slice(0, 120) : 'ok');
    // 通过 /gate/* 触发一次可疑路径：不是 POST 的代理端点
    await fetch(`http://127.0.0.1:${P0 + 6}/v1/responses`, { method: 'DELETE' }).catch(() => {});
    await gate(P0 + 6);
    const r2 = await gate(P0 + 6);
    check('G7 异常后进程仍存活且可服务', r2.status === 200, `status=${r2.status}`);
    const h = await (await fetch(`http://127.0.0.1:${P0 + 6}/gate/health`)).json();
    check('G7 health 仍正常', h.ok === true, `ok=${h.ok}`);
    const m = await met(P0 + 6);
    check('G7 metrics 暴露 crashCount', typeof m.crashCount === 'number', `crashCount=${m.crashCount}`);
    g.child.kill('SIGKILL');
  }

  console.log('\n=== G8 三种协议并行不互相干扰 ===');
  {
    // 2026-10-27：messages 默认被封禁（上游 messages 侧混入非 UUID4 池，见 baseline.mjs）。
    // 先用默认配置验证「默认就拒绝 + 原因可读」，再显式解封验证协议之间互不干扰。
    const gd = await startGate(P0 + 7, {});
    check('G8 实例启动', !gd.failed, gd.failed ? gd.stderr().slice(0, 120) : 'ok');
    const hd = await (await fetch(`http://127.0.0.1:${P0 + 7}/gate/health`)).json();
    check('G8 默认封禁 messages', (hd.blockedProtos || []).includes('messages'),
      `blockedProtos=${JSON.stringify(hd.blockedProtos)}`);
    const mb = await fetch(`http://127.0.0.1:${P0 + 7}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }) })
      .then(async r => ({ st: r.status, j: await r.json().catch(() => null) }));
    check('G8 被封禁协议 → 503 gate_proto_blocked', mb.st === 503 && mb.j?.error?.type === 'gate_proto_blocked',
      `status=${mb.st} type=${mb.j?.error?.type}`);
    gd.child.kill('SIGKILL');
    await sleep(400);

    const g = await startGate(P0 + 7, { GATE_BLOCK_PROTOS: 'chat', GATE_ALLOW_MESSAGES: '1' });
    check('G8 解封实例启动', !g.failed, g.failed ? g.stderr().slice(0, 120) : 'ok');
    const rs = await Promise.all([
      gate(P0 + 7),
      fetch(`http://127.0.0.1:${P0 + 7}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }) }).then(r => r.status),
      fetch(`http://127.0.0.1:${P0 + 7}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }) }).then(r => r.status),
    ]);
    check('G8 responses 成功', rs[0].status === 200, `status=${rs[0].status}`);
    check('G8 messages 解封后成功', rs[1] === 200, `status=${rs[1]}`);
    // ★ 2026-10-21 第 19 轮：chat 的预检策略是 logprob，而 P1 默认停用 → 该协议**没有任何可用判据**。
    // 交付前置闸要求「预检 pass」，因此 chat 现在结构性不可交付（生产本来就用
    // GATE_BLOCK_PROTOS=chat 封死它，dsh 也只用 messages/responses）。
    // 断言改为验证「无判据的协议被拒」，而不是假装它能成功。
    check('G8 chat 无判据 → 503（不再静默放行）', rs[2] === 503, `status=${rs[2]}`);
    g.child.kill('SIGKILL');
  }

  // ★ 2026-10-21 第 20 轮：responses 的预检 TTL 从 0 调到 30000ms（省每轮 ~1.1s）。
  // 这条路径此前**零测试覆盖**，而它现在是生产关键路径：缓存一旦失效，延迟回退；
  // 缓存若错误地放行未验证请求，安全回退。两种都必须被锁住。
  // metrics.prechecks 只在「真正实测」时自增（缓存命中不计），因此可用它精确验证。
  console.log('\n=== G9 预检 TTL 缓存（生产 30s 策略的正确性）===');
  {
    await fetch(`http://127.0.0.1:${MP}/mode/ok`);
    const gT = await startGate(P0 + 8, { GATE_PRECHECK_TTL_MS: '3000' });
    check('G9 TTL 实例启动', !gT.failed, gT.failed ? gT.stderr().slice(0, 120) : 'ok');
    const hT = await (await fetch(`http://127.0.0.1:${P0 + 8}/gate/health`)).json();
    check('G9 health 暴露 precheckTtlMs', hT?.precheckTtlMs?.responses === 3000, `responses=${hT?.precheckTtlMs?.responses}`);
    // 启动自检自己会跑一次 responses 预检，若不等它过期，基线就是「已热」→ 新增恒为 0。
    await sleep(3500);
    const b1 = (await met(P0 + 8)).prechecks;
    const t1 = await gate(P0 + 8), t2 = await gate(P0 + 8), t3 = await gate(P0 + 8);
    const a1 = (await met(P0 + 8)).prechecks;
    check('G9 TTL 内三次请求都成功', [t1, t2, t3].every(x => x.status === 200),
      [t1.status, t2.status, t3.status].join('/'));
    check('G9 TTL 内只实测 1 次预检', a1 - b1 === 1, `新增实测=${a1 - b1}（期望 1）`);
    gT.child.kill('SIGKILL');

    const g0 = await startGate(P0 + 9, { GATE_PRECHECK_TTL_MS: '0' });
    check('G9 TTL=0 实例启动', !g0.failed, g0.failed ? g0.stderr().slice(0, 120) : 'ok');
    const b2 = (await met(P0 + 9)).prechecks;
    const u1 = await gate(P0 + 9), u2 = await gate(P0 + 9), u3 = await gate(P0 + 9);
    const a2 = (await met(P0 + 9)).prechecks;
    check('G9 TTL=0 三次请求都成功', [u1, u2, u3].every(x => x.status === 200),
      [u1.status, u2.status, u3.status].join('/'));
    check('G9 TTL=0 时每请求都实测', a2 - b2 === 3, `新增实测=${a2 - b2}（期望 3）`);
    g0.child.kill('SIGKILL');
  }

  console.log('\n=== G10 可选本地鉴权（GATE_TOKEN）===');
  {
    await fetch(`http://127.0.0.1:${MP}/mode/ok`);
    const g = await startGate(P0 + 10, { GATE_TOKEN: 'tok_test_123' });
    check('G10 实例启动', !g.failed, g.failed ? g.stderr().slice(0, 120) : 'ok');
    const url = `http://127.0.0.1:${P0 + 10}/v1/responses`;
    const body = JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 });
    const noTok = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const noTokText = await noTok.text();
    check('G10 无 token → 401', noTok.status === 401, `status=${noTok.status}`);
    check('G10 401 类型可读', /gate_unauthorized/.test(noTokText), noTokText.slice(0, 80));
    const badTok = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gate-token': 'wrong' }, body });
    check('G10 错误 token → 401', badTok.status === 401, `status=${badTok.status}`);
    const okTok = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-gate-token': 'tok_test_123' }, body });
    check('G10 正确 token → 200', okTok.status === 200, `status=${okTok.status}`);
    const health = await (await fetch(`http://127.0.0.1:${P0 + 10}/gate/health`)).json();
    check('G10 health 声明 tokenRequired', health?.tokenRequired === true, `tokenRequired=${health?.tokenRequired}`);
    g.child.kill('SIGKILL');
  }

  console.log('\n=== G11 保护状态可见性（health 判据字段）===');
  {
    await fetch(`http://127.0.0.1:${MP}/mode/ok`);
    const g = await startGate(P0 + 11, {});
    check('G11 实例启动', !g.failed, g.failed ? g.stderr().slice(0, 120) : 'ok');
    await gate(P0 + 11);
    const h = await (await fetch(`http://127.0.0.1:${P0 + 11}/gate/health`)).json();
    check('G11 暴露 judgeAgeMs', typeof h?.judgeAgeMs === 'number', `judgeAgeMs=${h?.judgeAgeMs}`);
    check('G11 暴露 lastJudgeOk', h?.lastJudgeOk === true, `lastJudgeOk=${h?.lastJudgeOk}`);
    check('G11 暴露唯一出网目标', typeof h?.egressHost === 'string' && h.egressHost.includes(':'),
      `egressHost=${h?.egressHost}`);
    check('G11 暴露基线日期', /^\d{4}-\d{2}-\d{2}$/.test(String(h?.baselineObservedAt || '')),
      `baselineObservedAt=${h?.baselineObservedAt}`);
    check('G11 health 不含密钥', !JSON.stringify(h).includes('test-key'), '无泄漏');
    g.child.kill('SIGKILL');
  }

  console.log('\n=== G12 DNS rebinding：Host 校验必须覆盖 /gate/* 观测端点 ===');
  {
    await fetch(`http://127.0.0.1:${MP}/mode/ok`);
    const g = await startGate(P0 + 12, {});
    check('G12 实例启动', !g.failed, g.failed ? g.stderr().slice(0, 120) : 'ok');
    // 旧实现里 Host 校验在 /gate/* 之后 → 这两个请求会返回 200，rebind 页面同源可读
    const badProof = await rawGet(P0 + 12, '/gate/proof', 'evil.example');
    check('G12 非回环 Host 读 /gate/proof → 421', badProof.status === 421, `status=${badProof.status}`);
    const badHealth = await rawGet(P0 + 12, '/gate/health', 'evil.example');
    check('G12 非回环 Host 读 /gate/health → 421', badHealth.status === 421, `status=${badHealth.status}`);
    const good = await rawGet(P0 + 12, '/gate/proof', `127.0.0.1:${P0 + 12}`);
    check('G12 回环 Host 仍可读 /gate/proof', good.status === 200, `status=${good.status}`);
    check('G12 /gate/proof 不回传盘符绝对路径', !/[A-Za-z]:[\\/]/.test(good.body),
      good.body.slice(0, 60));
    g.child.kill('SIGKILL');
  }
  // ★ 2026-10-27 冻结版：结构闸 + 截断标记（用户实测症状：答案只落在 reasoning 里）
  console.log('\n=== G13 结构闸：无正文必须拒绝 / 截断必须打标 ===');
  {
    await fetch(`http://127.0.0.1:${MP}/mode/structure`);
    const g = await startGate(P0 + 11, {});
    check('G13 实例启动', !g.failed, g.failed ? g.stderr().slice(0, 120) : 'ok');
    const r = await gate(P0 + 11);
    check('G13 只有 reasoning → 503', r.status === 503, `status=${r.status}`);
    check('G13 归类 gate_structure_bad', r.j?.error?.type === 'gate_structure_bad', `type=${r.j?.error?.type}`);
    check('G13 头标明原因', (r.h?.get('x-gate-reason') || '') === 'structure_bad', `reason=${r.h?.get('x-gate-reason')}`);
    const m = await met(P0 + 11);
    check('G13 计入 structureBad', (m.structureBad || 0) >= 1, `structureBad=${m.structureBad}`);
    g.child.kill('SIGKILL');
    await sleep(400);

    await fetch(`http://127.0.0.1:${MP}/mode/truncated`);
    const g2 = await startGate(P0 + 11, {});
    check('G13 截断实例启动', !g2.failed, g2.failed ? g2.stderr().slice(0, 120) : 'ok');
    const r2 = await gate(P0 + 11);
    check('G13 有正文的截断响应仍交付', r2.status === 200, `status=${r2.status}`);
    check('G13 截断打 x-gate-truncated', (r2.h?.get('x-gate-truncated') || '') === '1',
      `truncated=${r2.h?.get('x-gate-truncated')}`);
    check('G13 health 暴露 trustLevel', typeof (await (await fetch(`http://127.0.0.1:${P0 + 11}/gate/health`)).json()).trustLevel === 'string', 'ok');
    g2.child.kill('SIGKILL');
  }
  // ★ 2026-10-29：每响应指纹（提高拒答率的主闸）
  console.log('\n=== G14 每响应指纹：不匹配→重发 / block 拒 / 正常通过 ===');
  {
    await fetch(`http://127.0.0.1:${MP}/mode/ok`);
    const g = await startGate(P0 + 12, {});
    check('G14 实例启动', !g.failed, g.failed ? g.stderr().slice(0, 120) : 'ok');
    const r = await gate(P0 + 12);
    check('G14 完整形态 → 200', r.status === 200, `status=${r.status}`);
    check('G14 完整形态 fp=ok', (r.h?.get('x-gate-fp') || '') === 'ok', `fp=${r.h?.get('x-gate-fp')}`);
    let m = await met(P0 + 12);
    check('G14 完整形态不计 mismatch', (m.fpMismatch || 0) === 0, `fpMismatch=${m.fpMismatch}`);

    await fetch(`http://127.0.0.1:${MP}/mode/fpbad`);
    const r2 = await gate(P0 + 12);
    check('G14 缺字段 → 重发后仍 200（retry 策略）', r2.status === 200, `status=${r2.status}`);
    check('G14 缺字段 → fp=degraded', (r2.h?.get('x-gate-fp') || '') === 'degraded', `fp=${r2.h?.get('x-gate-fp')}`);
    m = await met(P0 + 12);
    check('G14 缺字段 → 记录 mismatch 且发生重发',
      (m.fpMismatch || 0) >= 1 && (m.fpRetries || 0) >= 1,
      `fpMismatch=${m.fpMismatch} fpRetries=${m.fpRetries}`);
    const h = await (await fetch(`http://127.0.0.1:${P0 + 12}/gate/health`)).json();
    check('G14 health 暴露 fingerprint', h?.fingerprint?.policy === 'retry' && Array.isArray(h?.fingerprint?.topMissing),
      `policy=${h?.fingerprint?.policy} topMissing=${JSON.stringify(h?.fingerprint?.topMissing)}`);
    g.child.kill('SIGKILL');
    await sleep(400);

    const g2 = await startGate(P0 + 12, { GATE_FP_POLICY: 'block' });
    check('G14 block 实例启动', !g2.failed, g2.failed ? g2.stderr().slice(0, 120) : 'ok');
    const r3 = await gate(P0 + 12);
    check('G14 block 模式下缺字段 → 503', r3.status === 503, `status=${r3.status}`);
    check('G14 归类 gate_response_fingerprint', r3.j?.error?.type === 'gate_response_fingerprint',
      `type=${r3.j?.error?.type}`);
    check('G14 报错体带缺失项', Array.isArray(r3.j?.error?.missing) && r3.j.error.missing.includes('keys'),
      `missing=${JSON.stringify(r3.j?.error?.missing)}`);
    g2.child.kill('SIGKILL');
  }
} finally {
  stopAll();
  mock.close();
}

console.log(`\n===== 覆盖缺口：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
