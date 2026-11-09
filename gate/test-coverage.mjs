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
// 2026-11-01：item id 需带 UUID4 位（第12位=4，第16位∈89ab），供 P4 判据使用
const UUID4HEX = '0123456789ab4cde8f0123456789abcd';

/**
 * 2026-10-29：完整的 18 字段成功体（与 flash 车道实测形态一致）。
 * slim=true 时只给 8 个字段 → 用于验证「每响应指纹」的 FP_MISMATCH 分支。
 */
function fullBody(id, variant = 'ok') {
  const usage = { cost: 0, input_tokens: 1, input_tokens_details: { cached_tokens: 0 },
                  opencode: {}, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 },
                  total_tokens: 2 };
  const output = [{ id: 'msg_' + UUID4HEX, type: 'message', role: 'assistant', status: 'completed',
                    content: [{ type: 'output_text', text: 'ok', annotations: [], logprobs: null }] }];
  if (variant === 'fpbad') return { id, object: 'response', status: 'completed', incomplete_details: null, output, usage };
  const body = {
    created_at: 1793000000, error: null, id, incomplete_details: null, instructions: null,
    max_output_tokens: 8, metadata: {}, model: 'deepseek-v4.1-flash', object: 'response',
    output, parallel_tool_calls: true, reasoning: { effort: null, summary: null },
    status: 'completed', temperature: 1, tool_choice: 'auto', tools: [], top_p: 1, usage,
  };
  if (variant === 'official') {
    // 2026-11-02：官方 /v1/responses 实测形态（35 字段、裸 UUID4 id、usage 5 键）
    const oid = '6736ec44-8321-4a99-869c-684707ad4b79';
    return {
      background: false, completed_at: 1793581734, content_filters: null, created_at: 1793581734,
      error: null, frequency_penalty: 0, id: oid, incomplete_details: null, instructions: null,
      max_output_tokens: 8, max_tool_calls: null, metadata: {}, model: 'deepseek-flash',
      moderation: null, object: 'response',
      output: [{ content: [], encrypted_content: null, id: '3025ef5f-d246-480a-8729-df670cbe4e86', status: 'completed', summary: [], type: 'reasoning' },
               { content: [{ type: 'output_text', text: 'ok', annotations: [], logprobs: null }], id: '93c057bc-d5f8-4c0c-843c-757e5835231f', phase: null, role: 'assistant', status: 'completed', type: 'message' }],
      parallel_tool_calls: true, presence_penalty: 0, previous_response_id: null, prompt_cache_key: null,
      prompt_cache_retention: null, reasoning: { effort: 'none', summary: null }, safety_identifier: null,
      service_tier: 'default', status: 'completed', store: false, temperature: 1, text: {},
      tool_choice: 'auto', tools: [], top_logprobs: 0, top_p: 1, truncation: 'disabled',
      usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1,
               output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 },
      user: null,
    };
  }
  // 2026-11-01：v4 判据的针对性变种
  if (variant === 'unknown') { delete body.temperature; delete body.usage.opencode; }  // 既不像官方也不像 opencode → unknown 剖面
  if (variant === 'extra') body.service_tier = 'default';            // 未知字段 → 只 soft
  if (variant === 'missing') delete body.temperature;                 // 缺必需字段 → hard
  if (variant === 'badid') body.output[0].id = 'msg_' + 'ff'.repeat(16);   // 无 UUID4 位 → hard
  if (variant === 'badbill') {                                        // 计费偏差 1% → hard
    body.usage.opencode = { billing_source: 'go', list_cost: 0.0001, allowance: 0.00006,
      tokens: { input: 1, output: 1, reasoning: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 } };
  }
  if (variant === 'okbill') {                                         // 正确计费 → 通过
    // 响应体里的 model 是 deepseek-v4.1-flash → 单价为 flash 的 2 倍
    const c = 2 * (1 * 1.5e-7 + 1 * 6.0e-7);
    body.usage.opencode = { billing_source: 'go', list_cost: c, allowance: 0.6 * c,
      tokens: { input: 1, output: 1, reasoning: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0 } };
  }
  if (variant === 'badusage') body.usage.input_tokens_details = { cached_tokens: 0, extra_field: 1 }; // 未知明细键 → soft
  return body;
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
    // 2026-11-08：缓存语义探针的专用响应（G37 用）。探针 input 以 'alpha bravo' 开头。
    if (String(jb.input || '').startsWith('alpha bravo')) {
      const f = fullBody('resp_' + UUID4HEX);
      f.usage.input_tokens = 351;
      f.usage.input_tokens_details = { cached_tokens: mode === 'probe_bad' ? 100 : 256 };
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(f));
    }
    // 2026-11-08：messages 备选通道（G38）。按 msg 探针语义返回指纹码。
    if (String(req.url || '').includes('/v1/messages')) {
      const m = Array.isArray(jb.messages) ? jb.messages : null;
      const role = m && m[0] ? m[0].role : null;
      const badRole = typeof role === 'string' && role.startsWith('wizard');
      const badContent = m && m[0] && typeof m[0].content !== 'string';
      if (mode === 'msgok' || mode === 'msgbad') {
        const RID = UUID4; // '01234567-89ab-4cde-8f01-23456789abcd'
        const err = (code, msg) => {
          res.writeHead(code, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: msg } }));
        };
        const official = mode === 'msgok';
        if (jb.max_tokens === 0) {
          return official
            ? err(400, `Invalid max_tokens value, the valid range of max_tokens is [1, 393216] (request_id: ${RID})`)
            : err(400, 'Upstream request failed: [invalid_request_error] max_tokens must be between 1 and 393216 (request_id: gw-abc123)');
        }
        if (typeof jb.temperature === 'number' && (jb.temperature < 0 || jb.temperature > 2)) {
          return official
            ? err(400, `Invalid temperature value, the valid range of temperature is [0, 2] (request_id: ${RID})`)
            : err(400, 'Upstream request failed: [invalid_request_error] temperature out of range');
        }
        if (typeof jb.top_p === 'number' && (jb.top_p <= 0 || jb.top_p > 1)) {
          return official
            ? err(400, `Invalid top_p value, the valid range of top_p is (0, 1.0] (request_id: ${RID})`)
            : err(400, 'Upstream request failed: [invalid_request_error] top_p out of range');
        }
        if (m && m.length === 0) {
          return official
            ? err(400, `messages: at least one message is required (request_id: ${RID})`)
            : err(400, 'messages: at least one message is required');
        }
        if (!m) {
          return official
            ? err(422, `Failed to deserialize the JSON body into the target type: missing field \`messages\` (request_id: ${RID})`)
            : err(422, 'messages: expected an array');
        }
        if (badRole) {
          return official
            ? err(422, `Failed to deserialize the JSON body into the target type: messages[0].role: unknown variant \`${role}\`, expected one of \`user\`, \`assistant\`, \`system\` (request_id: ${RID})`)
            : err(400, 'messages[0].role: expected user, assistant or system');
        }
        if (badContent) {
          return official
            ? err(422, `Failed to deserialize the JSON body into the target type: messages[0].content: expected a string or a list (request_id: ${RID})`)
            : err(422, 'messages[0].content: expected an array');
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({
          id: 'msg_' + UUID4HEX, type: 'message', role: 'assistant',
          content: [{ type: 'text', text: 'OK' }], model: 'deepseek-v4.1-flash', stop_reason: 'end_turn',
          usage: { input_tokens: 32, output_tokens: 8, cache_read_input_tokens: 0,
                   cache_creation_input_tokens: 0, cost: 0,
                   opencode: { billing_source: 'go', list_cost: 0.0000096, allowance: 0.00000576 } },
        }));
      }
    }
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
    if (mode === 'stall') { return; }   // 连响应头都不发（用于「等头」watchdog）
    // 2026-10-30：慢响应，用于验证 drain 不会切断在途请求
    if (mode === 'slow') { return setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fullBody(UUID4))); }, 1200); }
    if (mode === 'third') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: HEX32 })); }
    // 2026-11-01：流式 mock（验证「流式检查不喂断路器」与「流式不发 x-gate-fp」）
    if (String(b).includes('"stream":true')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const sid = 'resp_0123456789ab4cde8f0123456789abcd';
      const frame = (t, obj) => 'event: ' + t + '\ndata: ' + JSON.stringify(Object.assign({ type: t }, obj)) + '\n\n';
      let seq = 0;
      res.write(frame('response.created', { response: { id: sid, object: 'response', status: 'in_progress', created_at: 1, model: 'deepseek-v4.1-flash', output: [], usage: null }, sequence_number: seq++ }));
      res.write(frame('response.output_item.added', { output_index: 0, item: { id: 'msg_' + UUID4HEX, type: 'message', role: 'assistant', status: 'completed', content: [] }, sequence_number: seq++ }));
      if (mode !== 'streambad') {
        res.write(frame('response.output_text.delta', { output_index: 0, content_index: 0, delta: 'ok', sequence_number: seq++ }));
        res.write(frame('response.completed', { response: { id: sid, object: 'response', status: 'completed', created_at: 1, model: 'deepseek-v4.1-flash', output: [{ id: 'msg_' + UUID4HEX, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [], logprobs: null }] }], usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2, cost: 0, opencode: {} } }, sequence_number: seq++ }));
      }
      return res.end();
    }
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
    res.end(JSON.stringify(fullBody(UUID4, mode)));
  });
});
await new Promise(r => mock.listen(MP, '127.0.0.1', r));

// ---------- 启停门控 ----------
// 2026-11-05：测试产物统一写 gate/logs/tests/。此前 900+ 个 cov-*.jsonl 直接堆在
// gate/logs 里，与生产台账同目录，轮转/prune 与人工排查都被拖慢。
const TEST_LOGS = path.join(import.meta.dirname, 'logs', 'tests');
fs.mkdirSync(TEST_LOGS, { recursive: true });
const children = [];
async function startGate(port, env = {}) {
  const child = spawn(process.execPath, [GATE], {
    env: { ...process.env, GATE_ASSURANCE: '', GATE_CANARY_POLICY: '', GATE_L0_POLICY: '', GATE_TOKEN: '', GATE_TOKEN_DISABLED_FOR_TEST: '1', OPENCODE_GO_API_KEY: 'test-key', GATE_PORT: String(port),
           GATE_HOST: '127.0.0.1', GATE_HOST_PORT: String(MP), GATE_HOST_SCHEME: 'http',
           GATE_REFRESH_MS: '0', GATE_PRECHECK_TTL_MS: '0',   // 测试要每请求实测，不吃生产 TTL
           // 2026-11-05：证据过期自愈默认关闭。开着会让后台刷新改写测试自己的快照，
           // 把 G21/G22/G26/G27 那些「用过期快照验拦截」的用例变成 flaky。G30 单独开启验证。
           GATE_EVIDENCE_AUTO_REFRESH: '0',
           GATE_SNAPSHOT: path.join(TEST_LOGS, `cov-${port}.json`),
           // 2026-11-08：既有用例不参与探测状态机（默认开启），G37 显式打开。
           GATE_PROBE_ADAPTIVE: '0',
           // 2026-11-08：生产 User 级可能已设 GATE_ALLOW_MESSAGES=1 / GATE_MSG_PROVIDER=1；
           // 测试必须显式归零，否则 G8 的「默认封禁 messages」会被宿主环境污染。
           GATE_ALLOW_MESSAGES: '0', GATE_MSG_PROVIDER: '0', GATE_MSG_OFFICIAL_TEXT: '1',
           // 2026-10-30：测试门控必须写自己的台账，否则会把 STARTUP_SELFTEST/FP_MISMATCH
           // 之类记录混进生产 gate/logs/gate.jsonl，污染日常统计与告警复盘。
           GATE_LOG_FILE: path.join(TEST_LOGS, `cov-${port}.jsonl`), ...env },
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
      env: { ...process.env, GATE_ASSURANCE: '', GATE_CANARY_POLICY: '', GATE_L0_POLICY: '', GATE_TOKEN: '', GATE_TOKEN_DISABLED_FOR_TEST: '1', OPENCODE_GO_API_KEY: '', GATE_PORT: String(P0 + 4),
             GATE_LOG_FILE: path.join(TEST_LOGS, 'cov-missing-key.jsonl') },
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
    // 2026-11-05 修正两处缺陷：
    // 1) 旧版把**生产**的 gate/logs/matrix.json 写成垃圾再还原 —— 测试改生产状态，
    //    窗口期内若生产门控刷新快照就会读到坏文件；
    // 2) 旧版损坏的是生产快照，而该实例其实读 GATE_SNAPSHOT（cov-<port>.json），
    //    所以这条用例原本没测到「坏快照」这条路径，是空跑。
    const snap = path.join(TEST_LOGS, 'cov-corrupt.json');
    fs.writeFileSync(snap, '=== not json ===');
    const g = await startGate(P0 + 5, { GATE_SNAPSHOT: snap });
    check('G6 坏快照下仍启动', !g.failed, g.failed ? g.stderr().slice(0, 120) : 'ok');
    const r = await gate(P0 + 5);
    check('G6 坏快照下仍能服务', r.status === 200, `status=${r.status}`);
    g.child.kill('SIGKILL');
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
    check('G14 报错体带缺失项', Array.isArray(r3.j?.error?.missing) && r3.j.error.missing.some(x => x.startsWith('keys')),
      `missing=${JSON.stringify(r3.j?.error?.missing)}`);
    g2.child.kill('SIGKILL');
  }
  // ★ 2026-10-30：/gate/* 观测端点可选鉴权（GATE_OBS_TOKEN）
  console.log('\n=== G16 观测端点鉴权（GATE_OBS_TOKEN）===');
  {
    const g3 = await startGate(P0 + 13, { GATE_OBS_TOKEN: 'obs-secret-123' });
    // startGate 的就绪探测不带 token → 开观测鉴权后必然 401，所以这里自己带 token 轮询
    let up = false;
    for (let i = 0; i < 40 && !up; i++) {
      await sleep(150);
      try {
        const r = await fetch(`http://127.0.0.1:${P0 + 13}/gate/health`, { headers: { 'x-gate-token': 'obs-secret-123' } });
        if (r.ok) up = true;
      } catch {}
    }
    check('G16 实例启动（带观测 token 探活）', up, up ? 'ok' : g3.stderr().slice(0, 120));
    const noTok = await fetch(`http://127.0.0.1:${P0 + 13}/gate/health`);
    check('G16 无 token → 401', noTok.status === 401, `status=${noTok.status}`);
    const badTok = await fetch(`http://127.0.0.1:${P0 + 13}/gate/health`, { headers: { 'x-gate-token': 'wrong' } });
    check('G16 错误 token → 401', badTok.status === 401, `status=${badTok.status}`);
    const okTok = await fetch(`http://127.0.0.1:${P0 + 13}/gate/health`, { headers: { 'x-gate-token': 'obs-secret-123' } });
    check('G16 正确 token → 200', okTok.status === 200, `status=${okTok.status}`);
    const hj = okTok.status === 200 ? await okTok.json() : {};
    check('G16 health 暴露 obsTokenRequired', hj.obsTokenRequired === true, `obsTokenRequired=${hj.obsTokenRequired}`);
    // 代理端点不受观测 token 影响（两者解耦）
    const px = await fetch(`http://127.0.0.1:${P0 + 13}/v1/responses`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 }) });
    check('G16 代理端点不受观测 token 影响', px.status !== 401, `status=${px.status}`);
    g3.child.kill('SIGKILL');
  }
  // ★ 2026-10-30：优雅停止（drain）——验证「重启不丢在途请求」
  // 背景：Stop-Process -Force 会 RST 在途连接，客户端只看到 Connection error；
  //       dsh 的重试（800ms/1 次）落不到新实例窗口里。drain 用 server.close + 等在途收尾解决。
  console.log('\n=== G17 优雅停止（drain）===');
  {
    const TOK = 'drain-test-token';
    // 先确认：没有配 token 时 drain 必须禁用（防本机任意进程停门控）
    const gNo = await startGate(P0 + 14, {});
    let upNo = false;
    for (let i = 0; i < 40 && !upNo; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${P0 + 14}/gate/health`); if (r.ok) upNo = true; } catch {} }
    const dis = await fetch(`http://127.0.0.1:${P0 + 14}/gate/admin/drain`, { method: 'POST' });
    check('G17 未配 token → drain 禁用（403）', dis.status === 403, `status=${dis.status}`);
    gNo.child.kill('SIGKILL');
    await sleep(300);

    await fetch(`http://127.0.0.1:${MP}/mode/slow`);
    const g = await startGate(P0 + 14, { GATE_TOKEN: TOK });
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${P0 + 14}/gate/health`, { headers: { 'x-gate-token': TOK } }); if (r.ok) up = true; } catch {} }
    check('G17 实例启动', up, up ? 'ok' : g.stderr().slice(0, 120));

    const bad = await fetch(`http://127.0.0.1:${P0 + 14}/gate/admin/drain`, { method: 'POST', headers: { 'x-gate-token': 'wrong' } });
    check('G17 错误 token → 403', bad.status === 403, `status=${bad.status}`);

    // 2026-10-31：只配 GATE_OBS_TOKEN（只读观测凭据）时 drain 必须仍禁用
    // —— 防止「读权限」被提权成「停门控」的拒绝服务能力。
    {
      const gObs = await startGate(P0 + 15, { GATE_TOKEN: '', GATE_OBS_TOKEN: 'obs-only-token' });
      let upObs = false;
      for (let i = 0; i < 40 && !upObs; i++) {
        await sleep(150);
        try {
          const r = await fetch(`http://127.0.0.1:${P0 + 15}/gate/health`, { headers: { 'x-gate-token': 'obs-only-token' } });
          if (r.ok) upObs = true;
        } catch {}
      }
      check('G17 仅 OBS token 的实例启动', upObs, upObs ? 'ok' : gObs.stderr().slice(0, 120));
      const obsDrain = await fetch(`http://127.0.0.1:${P0 + 15}/gate/admin/drain`,
        { method: 'POST', headers: { 'x-gate-token': 'obs-only-token' } });
      check('G17 只配 OBS token → drain 仍禁用（403）', obsDrain.status === 403, `status=${obsDrain.status}`);
      try { gObs.child.kill('SIGKILL'); } catch {}
      await sleep(300);
    }

    // 在途请求（mock 延迟 1200ms）+ 300ms 后触发 drain
    const flight = fetch(`http://127.0.0.1:${P0 + 14}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-gate-token': TOK },
      body: JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 }),
    });
    await sleep(300);
    const dr = await fetch(`http://127.0.0.1:${P0 + 14}/gate/admin/drain`, { method: 'POST', headers: { 'x-gate-token': TOK } });
    check('G17 drain 受理 200', dr.status === 200, `status=${dr.status}`);
    const fr = await flight;
    const fj = await fr.json().catch(() => ({}));
    check('G17 在途请求未被切断（200 + 有 id）', fr.status === 200 && !!fj.id, `status=${fr.status} id=${(fj.id || '').slice(0, 8)}`);

    // drain 之后进程应自行退出
    const exited = await Promise.race([
      new Promise(r => g.child.on('exit', c => r(c))),
      sleep(6000).then(() => 'timeout'),
    ]);
    check('G17 drain 后进程退出', exited !== 'timeout', `exit=${exited}`);
    try { g.child.kill('SIGKILL'); } catch {}
  }
  // ★ 2026-11-01：v4 判据（hard/soft 分离 + 断路器）
  console.log('\n=== G18 v4 判据：未知字段只告警 / 缺项必重发 / 计费 / 熔断 ===');
  {
    await fetch(`http://127.0.0.1:${MP}/mode/ok`);
    const g = await startGate(P0 + 16, {});
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${P0 + 16}/gate/health`); if (r.ok) up = true; } catch {} }
    check('G18 实例启动', up, up ? 'ok' : g.stderr().slice(0, 120));

    // 1) 未知字段 → 只 soft，不重发，仍 200/ok
    await fetch(`http://127.0.0.1:${MP}/mode/extra`);
    const r1 = await gate(P0 + 16);
    check('G18 未知字段 → 200 且 fp=ok（不重发）', r1.status === 200 && r1.h.get('x-gate-fp') === 'ok',
      `status=${r1.status} fp=${r1.h.get('x-gate-fp')}`);
    let m = await met(P0 + 16);
    check('G18 未知字段只记 soft，不计 mismatch', (m.fpSoft || 0) >= 1 && (m.fpMismatch || 0) === 0,
      `soft=${m.fpSoft} mismatch=${m.fpMismatch}`);

    // 2) 缺必需字段 → hard → 重发 → 仍缺 → degraded
    await fetch(`http://127.0.0.1:${MP}/mode/missing`);
    const r2 = await gate(P0 + 16);
    check('G18 缺必需字段 → 重发后 200 + degraded', r2.status === 200 && r2.h.get('x-gate-fp') === 'degraded',
      `status=${r2.status} fp=${r2.h.get('x-gate-fp')}`);
    m = await met(P0 + 16);
    check('G18 缺必需字段计入 mismatch 与重发', (m.fpMismatch || 0) >= 1 && (m.fpRetries || 0) >= 1,
      `mismatch=${m.fpMismatch} retries=${m.fpRetries}`);

    // 3) item id 无 UUID4 位 → hard
    await fetch(`http://127.0.0.1:${MP}/mode/badid`);
    const before = (await met(P0 + 16)).fpMismatch || 0;
    await gate(P0 + 16);
    const after = (await met(P0 + 16)).fpMismatch || 0;
    check('G18 非 UUID4 的 item id 被计入 mismatch', after > before, `${before} → ${after}`);

    // 4) 计费偏差 1% → hard；正确计费 → 通过
    await fetch(`http://127.0.0.1:${MP}/mode/badbill`);
    // 2026-11-02 实测：单价随实例轮换而变动（同形态 01:0x 是 2×，04:1x 变 1×）
    // → 计费类判据默认只告警（soft），不再当硬判据；需要严格执行时设 GATE_BILLING_POLICY=retry。
    const mb1 = await met(P0 + 16);
    await gate(P0 + 16);
    const mb2 = await met(P0 + 16);
    check('G18 计费偏差默认只告警（soft 增 / mismatch 不增）',
      (mb2.fpSoft || 0) > (mb1.fpSoft || 0) && (mb2.fpMismatch || 0) === (mb1.fpMismatch || 0),
      `soft ${mb1.fpSoft}->${mb2.fpSoft} mismatch ${mb1.fpMismatch}->${mb2.fpMismatch}`);
    await fetch(`http://127.0.0.1:${MP}/mode/okbill`);
    const okb = await gate(P0 + 16);
    check('G18 正确计费 → fp=ok', okb.status === 200 && okb.h.get('x-gate-fp') === 'ok',
      `status=${okb.status} fp=${okb.h.get('x-gate-fp')}`);

    // 5) 断路器：alert 模式下连续失败只告警，不开 503
    const g2 = await startGate(P0 + 17, { GATE_BREAKER_POLICY: 'alert', GATE_BREAKER_N: '3', GATE_BREAKER_MIN_SAMPLES: '3' });
    let up2 = false;
    for (let i = 0; i < 40 && !up2; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${P0 + 17}/gate/health`); if (r.ok) up2 = true; } catch {} }
    await fetch(`http://127.0.0.1:${MP}/mode/missing`);
    for (let i = 0; i < 4; i++) await gate(P0 + 17);
    const h2 = await (await fetch(`http://127.0.0.1:${P0 + 17}/gate/health`)).json();
    check('G18 断路器在 alert 模式下打开但请求仍 200',
      h2?.fingerprint?.breaker?.json?.state === 'open' && (await gate(P0 + 17)).status === 200,
      `state=${h2?.fingerprint?.breaker?.json?.state}`);

    // 6) fp-reset 复位（需要 token）
    const g3 = await startGate(P0 + 18, { GATE_TOKEN: 'tok-x', GATE_BREAKER_POLICY: 'block', GATE_BREAKER_N: '2', GATE_BREAKER_MIN_SAMPLES: '2' });
    let up3 = false;
    for (let i = 0; i < 40 && !up3; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${P0 + 18}/gate/health`, { headers: { 'x-gate-token': 'tok-x' } }); if (r.ok) up3 = true; } catch {} }
    for (let i = 0; i < 3; i++) await fetch(`http://127.0.0.1:${P0 + 18}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-gate-token': 'tok-x' },
      body: JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 }) });
    const h3 = await (await fetch(`http://127.0.0.1:${P0 + 18}/gate/health`, { headers: { 'x-gate-token': 'tok-x' } })).json();
    check('G18 block 模式断路器打开', h3?.fingerprint?.breaker?.json?.state === 'open', `state=${h3?.fingerprint?.breaker?.json?.state}`);
    const blocked = await fetch(`http://127.0.0.1:${P0 + 18}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-gate-token': 'tok-x' },
      body: JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 }) });
    check('G18 block 模式下熔断返回 503', blocked.status === 503, `status=${blocked.status}`);
    const reset = await fetch(`http://127.0.0.1:${P0 + 18}/gate/admin/fp-reset`, { method: 'POST', headers: { 'x-gate-token': 'tok-x' } });
    check('G18 fp-reset 复位成功', reset.status === 200, `status=${reset.status}`);
    const h4 = await (await fetch(`http://127.0.0.1:${P0 + 18}/gate/health`, { headers: { 'x-gate-token': 'tok-x' } })).json();
    check('G18 复位后状态 closed', h4?.fingerprint?.breaker?.json?.state === 'closed', `state=${h4?.fingerprint?.breaker?.json?.state}`);
    try { g3.child.kill('SIGKILL'); } catch {}
    g.child.kill('SIGKILL'); try { g2.child.kill('SIGKILL'); } catch {}
  }
  // ★ 2026-11-01（第二轮实测）：五条只会在运行时暴露的缺陷的回归用例
  console.log('\n=== G19 流式/熔断/大包 回归 ===');
  {
    // 1) 流式响应不应发送 x-gate-fp（否则是伪 ok 信号）
    await fetch(`http://127.0.0.1:${MP}/mode/ok`);
    const g1 = await startGate(P0 + 19, { GATE_BREAKER_N: '3', GATE_BREAKER_MIN_SAMPLES: '3' });
    let up1 = false;
    for (let i = 0; i < 40 && !up1; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${P0 + 19}/gate/health`); if (r.ok) up1 = true; } catch {} }
    const sres = await fetch(`http://127.0.0.1:${P0 + 19}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8, stream: true }) });
    await sres.text();
    check('G19 流式响应不带 x-gate-fp', sres.headers.get('x-gate-fp') === null, `fp=${sres.headers.get('x-gate-fp')}`);

    // 2) 流式缺终止事件 → 只告警，不喂断路器
    await fetch(`http://127.0.0.1:${MP}/mode/streambad`);
    for (let i = 0; i < 6; i++) {
      const r = await fetch(`http://127.0.0.1:${P0 + 19}/v1/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8, stream: true }) });
      await r.text();
    }
    const h1 = await (await fetch(`http://127.0.0.1:${P0 + 19}/gate/health`)).json();
    // 2026-11-02：改为按模式隔离验证——流式坏流必须能被**流式**断路器看到，
    // 但不得污染 json 断路器（否则单份状态会让熔断对真实流量失效或误伤非流式）。
    check('G19 流式坏流只打流式断路器（json 仍 closed）',
      h1?.fingerprint?.breaker?.stream?.state === 'open' && h1?.fingerprint?.breaker?.json?.state === 'closed',
      `stream=${h1?.fingerprint?.breaker?.stream?.state}(${h1?.fingerprint?.breaker?.stream?.samples}) json=${h1?.fingerprint?.breaker?.json?.state}`);
    check('G19 流式断路器计量流式样本', (h1?.fingerprint?.breaker?.stream?.samples || 0) >= 6,
      `samples=${h1?.fingerprint?.breaker?.stream?.samples}`);

    // 3) warn 模式：即使连续 hard 失败也不熔断、不 503
    const g2 = await startGate(P0 + 20, { GATE_FP_POLICY: 'warn', GATE_BREAKER_POLICY: 'block', GATE_BREAKER_N: '2', GATE_BREAKER_MIN_SAMPLES: '2' });
    let up2 = false;
    for (let i = 0; i < 40 && !up2; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${P0 + 20}/gate/health`); if (r.ok) up2 = true; } catch {} }
    await fetch(`http://127.0.0.1:${MP}/mode/missing`);
    let last = null;
    for (let i = 0; i < 5; i++) last = await gate(P0 + 20);
    const h2 = await (await fetch(`http://127.0.0.1:${P0 + 20}/gate/health`)).json();
    check('G19 warn 模式不熔断且请求仍 200', h2?.fingerprint?.breaker?.json?.state === 'closed' && last.status === 200,
      `state=${h2?.fingerprint?.breaker?.json?.state} status=${last.status}`);

    // 4) 大包（>1MB）指纹不符 → 不重发（served 只 +1）
    await fetch(`http://127.0.0.1:${MP}/mode/missing`);
    const g3 = await startGate(P0 + 21, { GATE_FP_RETRY_MAX_BYTES: '1048576' });
    let up3 = false;
    for (let i = 0; i < 40 && !up3; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${P0 + 21}/gate/health`); if (r.ok) up3 = true; } catch {} }
    await fetch(`http://127.0.0.1:${MP}/mode/missing`);
    const bigInput = 'x'.repeat(1200000);
    const br = await gate(P0 + 21, { model: 'deepseek-flash', input: bigInput, max_output_tokens: 8 });
    // served 会把预检探针也算进去，所以用 fpRetries 断言"没有重发"才准确
    const mm21 = await met(P0 + 21);
    check('G19 大包指纹失败不重发（fpRetries=0）', br.status === 200 && (mm21.fpRetries || 0) === 0,
      `status=${br.status} retries=${mm21.fpRetries} mismatch=${mm21.fpMismatch}`);

    // 5) 半开恢复：block + 短窗口 → 打开后经过窗口，下一次请求被放行并复位
    await fetch(`http://127.0.0.1:${MP}/mode/missing`);
    const g4 = await startGate(P0 + 22, { GATE_BREAKER_POLICY: 'block', GATE_BREAKER_N: '2', GATE_BREAKER_MIN_SAMPLES: '2', GATE_BREAKER_WINDOW_MS: '1500' });
    let up4 = false;
    for (let i = 0; i < 40 && !up4; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${P0 + 22}/gate/health`); if (r.ok) up4 = true; } catch {} }
    for (let i = 0; i < 3; i++) await gate(P0 + 22);
    const blockedNow = await gate(P0 + 22);
    await sleep(1800);
    await fetch(`http://127.0.0.1:${MP}/mode/ok`);
    const after = await gate(P0 + 22);
    check('G19 熔断后窗口到期放行并复位', blockedNow.status === 503 && after.status === 200, `blocked=${blockedNow.status} after=${after.status}`);

    // 6) block 模式：流式熔断只拦流式，非流式不受影响（本轮缺陷的核心回归）
    const g5 = await startGate(P0 + 23, { GATE_BREAKER_POLICY: 'block', GATE_BREAKER_N: '2', GATE_BREAKER_MIN_SAMPLES: '2' });
    let up5 = false;
    for (let i = 0; i < 40 && !up5; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${P0 + 23}/gate/health`); if (r.ok) up5 = true; } catch {} }
    await fetch(`http://127.0.0.1:${MP}/mode/streambad`);
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`http://127.0.0.1:${P0 + 23}/v1/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8, stream: true }) });
      await r.text();
    }
    const streamBlocked = await fetch(`http://127.0.0.1:${P0 + 23}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8, stream: true }) });
    const blockedBody = await streamBlocked.text();
    check('G19 流式熔断后流式请求 503', streamBlocked.status === 503 && blockedBody.includes('gate_stream_breaker_open'),
      `status=${streamBlocked.status} type=${(blockedBody.match(/"type":"([^"]+)"/) || [])[1]}`);
    await fetch(`http://127.0.0.1:${MP}/mode/ok`);
    const jsonStill = await gate(P0 + 23);
    check('G19 流式熔断不误伤非流式', jsonStill.status === 200, `status=${jsonStill.status}`);
    try { g5.child.kill('SIGKILL'); } catch {}
    for (const gg of [g1, g2, g3, g4]) { try { gg.child.kill('SIGKILL'); } catch {} }
  }
  // ★ 2026-11-02：双车道剖面（官方 / opencode）—— 用一条车道去卡另一条是最典型的误杀来源
  console.log('\n=== G20 车道剖面自适配 ===');
  {
    const g = await startGate(P0 + 24, {});
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${P0 + 24}/gate/health`); if (r.ok) up = true; } catch {} }
    check('G20 实例启动', up, up ? 'ok' : '');

    await fetch(`http://127.0.0.1:${MP}/mode/official`);
    const ro = await gate(P0 + 24);
    check('G20 官方形态 → fp=ok（不再因裸 UUID4 id 误判）', ro.status === 200 && ro.h.get('x-gate-fp') === 'ok',
      `status=${ro.status} fp=${ro.h.get('x-gate-fp')}`);

    await fetch(`http://127.0.0.1:${MP}/mode/ok`);
    const rc = await gate(P0 + 24);
    check('G20 opencode 形态 → fp=ok', rc.status === 200 && rc.h.get('x-gate-fp') === 'ok',
      `status=${rc.status} fp=${rc.h.get('x-gate-fp')}`);

    await fetch(`http://127.0.0.1:${MP}/mode/unknown`);
    const ru = await gate(P0 + 24);
    const mu = await met(P0 + 24);
    check('G20 未知形态 → 不拒（hard 降级）', ru.status === 200 && (mu.fpRetries || 0) === 0,
      `status=${ru.status} retries=${mu.fpRetries}`);

    const h = await (await fetch(`http://127.0.0.1:${P0 + 24}/gate/health`)).json();
    check('G20 health 暴露剖面计数与缓存观测',
      h?.fingerprint?.profiles?.official >= 1 && h?.fingerprint?.cache && typeof h.fingerprint.cache.samples === 'number',
      `profiles=${JSON.stringify(h?.fingerprint?.profiles)} cache=${JSON.stringify(h?.fingerprint?.cache)}`);
    try { g.child.kill('SIGKILL'); } catch {}
  }
  // ★ 2026-11-02：正向证据链（EV1–EV9）策略
  console.log('\n=== G21 证据链策略（label / require）===');
  {
    const fs2 = await import('node:fs');
    const path2 = await import('node:path');
    const dir = path2.join(process.env.TEMP || '.', 'ocg-ev-' + Date.now());
    fs2.mkdirSync(dir, { recursive: true });
    const mk = (name, verdict, ageMs) => {
      const f = path2.join(dir, name);
      const at = new Date(Date.now() - ageMs).toISOString();
      fs2.writeFileSync(f, JSON.stringify({ at, version: 1,
        upstream: { host: 'mock', prefix: '' },
        endpoint: { verdict, score: verdict === 'official' ? 6 : 1, max: 6, items: [] },
        impl: { score: 0, max: 3, profile: 'compat', items: [] },
        model: { claim: 'unproven' } }));
      return f;
    };
    const officialFresh = mk('official.json', 'official', 1000);
    const nonOfficial = mk('non-official.json', 'non-official', 1000);
    const staleOfficial = mk('stale.json', 'official', 10 * 86400000);

    // 2026-11-05 审查修复：原来端口取 P0+30..229 的随机值，而 mock 端口 MP 可能落在这个区间
    // （P0=8810 时 MP=8910 恰好在内）。撞上时门控根本绑不上，请求直接打到 mock ——
    // 而 mock 对任意路径都回 200，于是"应该 503"的用例偶发变成 200（概率约 1/200 × 5 次调用）。
    // 现在：端口改固定递增区间（远离 MP 与其他用例），并且"起不来"直接判 UP_FAILED，不继续发请求。
    let seq21 = 0;
    const run = async (snapFile, env) => {
      const port = P0 + 1000 + (seq21++) * 3;
      const g = await startGate(port, env);
      let up = false;
      for (let i = 0; i < 40 && !up; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${port}/gate/health`); if (r.ok) up = true; } catch {} }
      if (!up) { try { g.child.kill('SIGKILL'); } catch {} return { status: 'UP_FAILED', body: g.stderr().slice(0, 140), health: null }; }
      await fetch(`http://127.0.0.1:${MP}/mode/ok`);
      const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 }) });
      const body = await res.text();
      const h = await fetch(`http://127.0.0.1:${port}/gate/health`).then(r => r.json()).catch(() => null);
      try { g.child.kill('SIGKILL'); } catch {}
      return { status: res.status, body, health: h };
    };

    const need = { GATE_EVIDENCE_POLICY: 'require', GATE_EVIDENCE_EXPECT: 'official' };

    const a = await run(officialFresh, { ...need, GATE_EVIDENCE_FILE: officialFresh });
    check('G21 require + 官方证据 → 200', a.status === 200, `status=${a.status}`);

    const b = await run(nonOfficial, { ...need, GATE_EVIDENCE_FILE: nonOfficial });
    check('G21 require + 非官方证据 → 503 gate_evidence_unmet',
      b.status === 503 && b.body.includes('gate_evidence_unmet'), `status=${b.status}`);

    const c2 = await run(staleOfficial, { ...need, GATE_EVIDENCE_FILE: staleOfficial });
    check('G21 require + 过期证据 → 503', c2.status === 503, `status=${c2.status}`);

    const d = await run(path2.join(dir, 'missing.json'), { ...need, GATE_EVIDENCE_FILE: path2.join(dir, 'missing.json') });
    check('G21 require + 缺快照 → 503（fail-closed）', d.status === 503, `status=${d.status}`);

    const e = await run(nonOfficial, { GATE_EVIDENCE_POLICY: 'label', GATE_EVIDENCE_FILE: nonOfficial });
    check('G21 label + 非官方证据 → 仍 200', e.status === 200, `status=${e.status}`);
    check('G21 health 暴露证据链', e.health?.evidence?.verdict === 'non-official',
      `verdict=${e.health?.evidence?.verdict}`);
  }
  // ★ 2026-11-02：模型族闸（EV10/EV11）—— 判正放行 / 判否拒答
  console.log('\n=== G22 模型族闸（deepseek-official vs thirdparty）===');
  {
    const fs3 = await import('node:fs');
    const path3 = await import('node:path');
    const dir3 = path3.join(process.env.TEMP || '.', 'ocg-fam-' + Date.now());
    fs3.mkdirSync(dir3, { recursive: true });
    const mk = (name, family, ageMs) => {
      const f = path3.join(dir3, name);
      const at = new Date(Date.now() - ageMs).toISOString();
      fs3.writeFileSync(f, JSON.stringify({ at, version: 1,
        upstream: { host: 'mock', prefix: '' },
        endpoint: { verdict: 'non-official', score: 1, max: 6, items: [] },
        impl: { score: 0, max: 2, profile: 'compat', items: [] },
        model: { family, familyScore: family === 'deepseek-official' ? 2 : 1, familyMax: 2, claim: 'unproven', weights: 'unproven', items: [] } }));
      return f;
    };
    const runFam = async (snapFile, env) => {
      const port = P0 + 300 + Math.floor(Math.random() * 200);
      const g = await startGate(port, { ...env, GATE_EVIDENCE_FILE: snapFile });
      let up = false;
      for (let i = 0; i < 40 && !up; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${port}/gate/health`); if (r.ok) up = true; } catch {} }
      await fetch(`http://127.0.0.1:${MP}/mode/ok`);
      const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 }) });
      const body = await res.text();
      const h = await fetch(`http://127.0.0.1:${port}/gate/health`).then(r => r.json()).catch(() => null);
      try { g.child.kill('SIGKILL'); } catch {}
      return { status: res.status, body, health: h };
    };

    const req = { GATE_MODEL_EVIDENCE_POLICY: 'require' };

    const a = await runFam(mk('official.json', 'deepseek-official', 1000), { ...req });
    check('G22 official 族 + require → 200', a.status === 200, `status=${a.status}`);

    const b = await runFam(mk('thirdparty.json', 'deepseek-thirdparty', 1000), { ...req });
    check('G22 thirdparty 族 + require → 503 gate_modelfamily_unmet',
      b.status === 503 && b.body.includes('gate_modelfamily_unmet'), `status=${b.status}`);

    const c3 = await runFam(mk('mismatch.json', 'mismatch', 1000), { ...req });
    check('G22 mismatch 族 + require → 503', c3.status === 503, `status=${c3.status}`);

    const d3 = await runFam(mk('stale.json', 'deepseek-official', 13 * 3600000), { ...req });
    check('G22 过期快照 + require → 503', d3.status === 503, `status=${d3.status}`);

    const e3 = await runFam(mk('tp-label.json', 'deepseek-thirdparty', 1000), { GATE_MODEL_EVIDENCE_POLICY: 'label' });
    check('G22 thirdparty + label → 200（只标注）', e3.status === 200, `status=${e3.status}`);
    check('G22 health 暴露 modelFamily 与 modelPolicy',
      e3.health?.evidence?.modelFamily === 'deepseek-thirdparty' && e3.health?.evidence?.modelPolicy === 'label',
      `family=${e3.health?.evidence?.modelFamily} modelPolicy=${e3.health?.evidence?.modelPolicy}`);
  }
  // ★ 2026-11-02：请求体上限（24 MiB 改造配套）
  console.log('\n=== G23 请求体上限与 big-body 观测 ===');
  {
    const big = await startGate(P0 + 40, { GATE_MAX_BODY: '2621440', GATE_BIG_BODY_BYTES: '1048576' }); // 2.5MiB / 1MiB，便于测试
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${P0 + 40}/gate/health`); if (r.ok) up = true; } catch {} }
    await fetch(`http://127.0.0.1:${MP}/mode/ok`);

    const send = (bytes) => fetch(`http://127.0.0.1:${P0 + 40}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8, _pad: 'x'.repeat(bytes) }) }).then(async r => ({ status: r.status, h: r.headers, body: await r.text() }));

    const under = await send(1024 * 1024);   // 1MiB + 开销 < 2.5MiB
    check('G23 未超上限 → 200', under.status === 200, `status=${under.status}`);

    const bigBody = await send(1536 * 1024); // >1MiB 阈值 → 应打 x-gate-big-body
    check('G23 超过 big-body 阈值 → 打 x-gate-big-body 头', bigBody.h.get('x-gate-big-body') === '1',
      `hdr=${bigBody.h.get('x-gate-big-body')}`);

    const over = await send(3 * 1024 * 1024);
    check('G23 超上限 → 413 且带 actual_bytes',
      over.status === 413 && /actual_bytes/.test(over.body), `status=${over.status} body=${over.body.slice(0, 80)}`);
    check('G23 413 带 x-gate-fatal（重试无意义）', over.h.get('x-gate-fatal') === '1', `hdr=${over.h.get('x-gate-fatal')}`);

    const m = await met(P0 + 40);
    check('G23 计数：bigBody ≥1 且 bodyTooLarge ≥1', (m.bigBody || 0) >= 1 && (m.bodyTooLarge || 0) >= 1,
      `bigBody=${m.bigBody} bodyTooLarge=${m.bodyTooLarge}`);

    const h = await fetch(`http://127.0.0.1:${P0 + 40}/gate/health`).then(r => r.json()).catch(() => null);
    check('G23 health 暴露 bodyLimit', h?.bodyLimit?.maxBodyBytes === 2621440,
      `maxBody=${h?.bodyLimit?.maxBodyBytes} peak=${h?.bodyLimit?.estPeakMemMB}MB`);
    try { big.child.kill('SIGKILL'); } catch {}
  }
  // ★ 2026-11-04：assurance 四档 + L0 指纹策略 + 逐响应官方痕迹
  console.log('\n=== G24 assurance/L0 闸 + 逐响应 proof ===');
  {
    const fs4 = await import('node:fs');
    const path4 = await import('node:path');
    const dir4 = path4.join(process.env.TEMP || '.', 'ocg-asr-' + Date.now());
    fs4.mkdirSync(dir4, { recursive: true });
    const mk = (name, { reachable, level, l0score }) => {
      const f = path4.join(dir4, name);
      fs4.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), version: 1,
        upstream: { host: 'mock', prefix: '' },
        l0: { score: l0score, max: 5, items: [] },
        messages: { score: 0, max: 6, items: [] },
        validator: { responses: reachable, messages: reachable, reachable },
        assurance: level,
        endpoint: { verdict: 'non-official', score: 1, max: 6, items: [] },
        impl: { score: 0, max: 2, profile: 'compat', items: [] },
        model: { family: 'deepseek-thirdparty', claim: 'unproven', weights: 'unproven', items: [] } }));
      return f;
    };
    const runA = async (env) => {
      const port = P0 + 500 + Math.floor(Math.random() * 200);
      const snap = env.__snap; delete env.__snap;
      const g = await startGate(port, { ...env, GATE_EVIDENCE_FILE: snap });
      let up = false;
      for (let i = 0; i < 40 && !up; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${port}/gate/health`); if (r.ok) up = true; } catch {} }
      await fetch(`http://127.0.0.1:${MP}/mode/ok`);
      const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 }) });
      const body = await res.text();
      const proof = res.headers.get('x-gate-proof');
      const h = await fetch(`http://127.0.0.1:${port}/gate/health`).then(r => r.json()).catch(() => null);
      try { g.child.kill('SIGKILL'); } catch {}
      return { status: res.status, body, proof, health: h };
    };

    const reach = mk('reach.json', { reachable: true, level: 'probe', l0score: 0 });
    const noReach = mk('noreach.json', { reachable: false, level: 'none', l0score: 0 });
    const strict = mk('strict.json', { reachable: true, level: 'strict', l0score: 5 });

    const a = await runA({ __snap: reach, GATE_ASSURANCE: 'probe' });
    check('G24 probe + 校验器可达 → 200', a.status === 200, `status=${a.status}`);

    const b = await runA({ __snap: noReach, GATE_ASSURANCE: 'probe' });
    check('G24 probe + 校验器不可达 → 503 gate_assurance_unmet',
      b.status === 503 && b.body.includes('gate_assurance_unmet'), `status=${b.status}`);

    const c4 = await runA({ __snap: reach, GATE_ASSURANCE: 'strict' });
    check('G24 strict + 证据只到 probe → 503', c4.status === 503, `status=${c4.status}`);

    const d4 = await runA({ __snap: strict, GATE_ASSURANCE: 'strict' });
    check('G24 strict + 证据达 strict → 200', d4.status === 200, `status=${d4.status}`);

    const e4 = await runA({ __snap: reach, GATE_L0_POLICY: 'reject' });
    check('G24 L0_POLICY=reject + 指纹不全 → 503', e4.status === 503, `status=${e4.status}`);

    const f4 = await runA({ __snap: strict, GATE_L0_POLICY: 'reject' });
    check('G24 L0_POLICY=reject + 指纹全过 → 200', f4.status === 200, `status=${f4.status}`);

    check('G24 逐响应 x-gate-proof 存在', ['verified', 'unverified', 'unknown'].includes(f4.proof), `proof=${f4.proof}`);
    check('G24 health 暴露 assurance 与 proof 计数',
      f4.health?.evidence?.assurancePolicy === 'label' && f4.health?.evidence?.proof !== undefined,
      `policy=${f4.health?.evidence?.assurancePolicy}`);
  }
  // ★ 2026-11-04：canary 闸 + assurance 按协议解耦
  console.log('\n=== G26 canary 闸 / G27 按协议解耦 ===');
  {
    const fs5 = await import('node:fs');
    const path5 = await import('node:path');
    const dir5 = path5.join(process.env.TEMP || '.', 'ocg-cy-' + Date.now());
    fs5.mkdirSync(dir5, { recursive: true });
    const mk = (name, { validator, canaryOk }) => {
      const f = path5.join(dir5, name);
      fs5.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), version: 1,
        upstream: { host: 'mock', prefix: '' },
        l0: { score: 0, max: 5, items: [] },
        messages: { score: 1, max: 6, items: [] },
        canary: { score: canaryOk === null ? 0 : (canaryOk ? 10 : 2), max: canaryOk === null ? 0 : 10, ok: canaryOk === true, skipped: canaryOk === null,
                  // 2026-11-05：skipped 必须带原因。'official_target' 才允许放行；缺基线不允许。
                  skippedReason: canaryOk === null ? 'official_target' : null, items: [] },
        validator,
        assurance: 'probe',
        endpoint: { verdict: 'non-official', score: 1, max: 6, items: [] },
        impl: { score: 0, max: 2, profile: 'compat', items: [] },
        model: { family: 'deepseek-thirdparty', claim: 'unproven', weights: 'unproven', items: [] } }));
      return f;
    };
    const runC = async (env) => {
      const port = P0 + 700 + Math.floor(Math.random() * 150);
      const snap = env.__snap; delete env.__snap;
      const g = await startGate(port, { ...env, GATE_EVIDENCE_FILE: snap });
      let up = false;
      for (let i = 0; i < 40 && !up; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${port}/gate/health`); if (r.ok) up = true; } catch {} }
      await fetch(`http://127.0.0.1:${MP}/mode/ok`);
      const res = await fetch(`http://127.0.0.1:${port}/v1/responses`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 }) });
      const body = await res.text();
      try { g.child.kill('SIGKILL'); } catch {}
      return { status: res.status, body };
    };

    const cyOk = mk('cy-ok.json', { validator: { responses: true, messages: true, reachable: true }, canaryOk: true });
    const cyBad = mk('cy-bad.json', { validator: { responses: true, messages: true, reachable: true }, canaryOk: false });
    const onlyMsg = mk('only-msg.json', { validator: { responses: false, messages: true, reachable: true }, canaryOk: true });
    const noResp = mk('no-resp.json', { validator: { messages: false }, canaryOk: true });
    const respFalse = mk('resp-false.json', { validator: { responses: false }, canaryOk: true });

    const a = await runC({ __snap: cyOk, GATE_CANARY_POLICY: 'require' });
    check('G26 canary 通过 + require → 200', a.status === 200, `status=${a.status}`);

    const b = await runC({ __snap: cyBad, GATE_CANARY_POLICY: 'require' });
    check('G26 canary 失败 + require → 503 canary_mismatch',
      b.status === 503 && b.body.includes('canary_mismatch'), `status=${b.status} body=${b.body.slice(0, 60)}`);

    const c5 = await runC({ __snap: cyBad, GATE_CANARY_POLICY: 'label' });
    check('G26 canary 失败 + label → 200（只标注）', c5.status === 200, `status=${c5.status}`);

    const d5 = await runC({ __snap: onlyMsg, GATE_ASSURANCE: 'probe' });
    check('G27 messages 证据 true / responses false → responses 仍 503（本协议判定）',
      d5.status === 503, `status=${d5.status}`);

    const e5 = await runC({ __snap: noResp, GATE_ASSURANCE: 'probe' });
    check('G27 快照缺 responses 字段 → unknown 不拦（200）', e5.status === 200, `status=${e5.status}`);

    const f5 = await runC({ __snap: respFalse, GATE_ASSURANCE: 'probe' });
    check('G27 responses 显式 false + probe → 503', f5.status === 503, `status=${f5.status}`);

    // 2026-11-04：直连场景 canary 会 skipped（目标即官方）——不能因此拒绝，否则自锁
    const skipCy = mk('cy-skip.json', { validator: { responses: true, messages: true, reachable: true }, canaryOk: null });
    const g5 = await runC({ __snap: skipCy, GATE_CANARY_POLICY: 'require' });
    check('G26 canary skipped（直连）+ require → 200（不自锁）', g5.status === 200, `status=${g5.status}`);
  }

  // ★ 2026-11-05：EV14/EV15 文本级判据（离线打分，不起门控）
  console.log('\n=== G28 文本级校验判据打分 ===');
  {
    const { scoreEvidence } = await import('./evidence.mjs');
    const mkEv = (items) => ({ at: new Date().toISOString(), items });
    // 官方形态：EV14 三协议全命中，EV15 两协议命中，均无包装前缀
    const official = scoreEvidence(mkEv([
      { id: 'EV14', ok: true, detail: '官方名单文案 3/3', rows: [
        { proto: 'responses', hit: true, wrapped: false, status: 400 },
        { proto: 'messages', hit: true, wrapped: false, status: 400 },
        { proto: 'chat', hit: true, wrapped: false, status: 400 }] },
      { id: 'EV15', ok: true, detail: '边界文案 2/2', rows: [
        { proto: 'messages', hit: true, wrapped: false, status: 400 },
        { proto: 'chat', hit: true, wrapped: false, status: 400 }] },
    ]));
    check('G28 官方形态 → validate 三协议全 pass',
      official.validate.responses.status === 'pass' && official.validate.messages.status === 'pass' && official.validate.chat.status === 'pass',
      `r=${official.validate.responses.status} m=${official.validate.messages.status} c=${official.validate.chat.status}`);

    // 中转形态：全部带 Upstream request failed 包装
    const relay = scoreEvidence(mkEv([
      { id: 'EV14', ok: false, detail: '官方名单文案 0/3', rows: [
        { proto: 'responses', hit: false, wrapped: true, status: 400 },
        { proto: 'messages', hit: false, wrapped: true, status: 400 },
        { proto: 'chat', hit: false, wrapped: true, status: 400 }] },
      { id: 'EV15', ok: false, detail: '边界文案 0/2', rows: [
        { proto: 'messages', hit: false, wrapped: true, status: 400 },
        { proto: 'chat', hit: false, wrapped: true, status: 400 }] },
    ]));
    check('G28 中转形态 → validate 三协议全 fail', 
      relay.validate.responses.status === 'fail' && relay.validate.messages.status === 'fail' && relay.validate.chat.status === 'fail',
      `r=${relay.validate.responses.status} m=${relay.validate.messages.status} c=${relay.validate.chat.status}`);
    check('G28 中转形态 → relayWrap 计数被记录',
      relay.validate.messages.relayWrap === 2 && relay.validate.chat.relayWrap === 2,
      `m=${relay.validate.messages.relayWrap} c=${relay.validate.chat.relayWrap}`);
    check('G28 空证据 → validate 三协议 unknown',
      scoreEvidence(mkEv([])).validate.responses.status === 'unknown', 'absent→unknown');
  }} finally {
  stopAll();
  // 2026-11-05：mock 的关闭搬到文件末尾 —— G29/G30 也是用例，需要 mock 还活着。
  // 原先在这里 close()，等于让后面追加的用例连不上 mock（实测 ECONNREFUSED 8910）。
}

  // ★ 2026-11-05：声明长度闸 + health 语义修复（审计轮）
  console.log('\n=== G29 声明长度闸与 health 语义 ===');
  {
    const portA = P0 + 41;
    const gA = await startGate(portA, { GATE_MAX_BODY: '262144', GATE_BIG_BODY_BYTES: '0' }); // 256KB
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${portA}/gate/health`); if (r.ok) up = true; } catch {} }
    check('G29 实例启动', !gA.failed && up, gA.failed ? gA.stderr().slice(0, 120) : 'ok');

    // 只发 Content-Length、一个字节 body 都不发：旧实现会一直等到 body 空闲超时（默认 120s）
    const declared = await new Promise((resolve) => {
      const t0 = Date.now();
      const rq = http.request({
        host: '127.0.0.1', port: portA, method: 'POST', path: '/v1/responses',
        headers: { 'content-type': 'application/json', 'content-length': String(1048576) },
      }, (r) => {
        let d = ''; r.on('data', (c) => d += c);
        r.on('end', () => resolve({ status: r.statusCode, hdr: r.headers, body: d, ms: Date.now() - t0 }));
      });
      rq.on('error', (e) => resolve({ status: 'ERR', hdr: {}, body: String(e.code || e.message), ms: Date.now() - t0 }));
      rq.setTimeout(4000, () => { try { rq.destroy(); } catch {} resolve({ status: 'TIMEOUT', hdr: {}, body: '', ms: Date.now() - t0 }); });
      rq.end(); // 故意不写 body
    });
    check('G29 声明超限 → 立刻 413', declared.status === 413, `status=${declared.status} ms=${declared.ms}`);
    check('G29 不等 body（< 2s）', declared.ms < 2000, `ms=${declared.ms}`);
    check('G29 报错体标记 declared', /"declared":true/.test(declared.body), declared.body.slice(0, 90));
    check('G29 413 带 x-gate-fatal', declared.hdr['x-gate-fatal'] === '1', `hdr=${declared.hdr['x-gate-fatal']}`);

    const h = await fetch(`http://127.0.0.1:${portA}/gate/health`).then(r => r.json()).catch(() => null);
    check('G29 health 暴露 respShapeStrict', h?.respShapeStrict === true, `strict=${h?.respShapeStrict}`);
    check('G29 全集含 resp_、生效集合不含',
      (h?.deliverableShapes || []).includes('resp_') && !(h?.deliverableShapesEffective || []).includes('resp_'),
      `eff=${JSON.stringify(h?.deliverableShapesEffective)}`);
    check('G29 health 暴露 matrixTtlMs（不再叫 ttl）', typeof h?.matrixTtlMs === 'number' && !('ttl' in (h || {})), `ttl=${h?.matrixTtlMs}`);
    check('G29 usage 键按剖面给出',
      (h?.usageKeysRequired === null || Array.isArray(h?.usageKeysRequired)) && !!h?.usageKeysByProfile?.official,
      `req=${JSON.stringify(h?.usageKeysRequired)} prof=${Object.keys(h?.usageKeysByProfile || {}).join(',')}`);
    try { gA.child.kill('SIGKILL'); } catch {}

    // 应急回退：只有显式 GATE_RESP_SHAPE_STRICT=0 时 resp_ 才回到生效集合
    const portB = P0 + 42;
    const gB = await startGate(portB, { GATE_RESP_SHAPE_STRICT: '0' });
    let up2 = false;
    for (let i = 0; i < 40 && !up2; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${portB}/gate/health`); if (r.ok) up2 = true; } catch {} }
    const h2 = await fetch(`http://127.0.0.1:${portB}/gate/health`).then(r => r.json()).catch(() => null);
    check('G29 回退模式 → resp_ 回到生效集合',
      h2?.respShapeStrict === false && (h2?.deliverableShapesEffective || []).includes('resp_'),
      `strict=${h2?.respShapeStrict} eff=${JSON.stringify(h2?.deliverableShapesEffective)}`);
    try { gB.child.kill('SIGKILL'); } catch {}
  }

  // ★ 2026-11-05：证据过期自愈 + canary skipped 语义（16:26 全站 503 事故的回归）
  console.log('\n=== G30 证据过期自愈 / canary skipped 语义 ===');
  {
    // 事故链：canary=require 的放行条件含 fresh；快照由每小时任务刷新；任务错过一次 → 2h 后全站 503，
    // 而快照里 canary 本来就是 10/10。以下用例把「过期 → 后台补刷 → 恢复」整条链跑一遍。
    const dir6 = path.join(TEST_LOGS, 'ev-' + Date.now());
    fs.mkdirSync(dir6, { recursive: true });
    const mk6 = (name, patch) => {
      const f = path.join(dir6, name);
      const base = { at: new Date().toISOString(), version: 1,
        upstream: { host: 'mock', prefix: '' },
        l0: { score: 0, max: 5, items: [] },
        messages: { score: 1, max: 6, items: [] },
        canary: { score: 10, max: 10, ok: true, skipped: false, skippedReason: null, items: [] },
        validator: { responses: true, messages: true, reachable: true },
        assurance: 'probe',
        endpoint: { verdict: 'non-official', score: 1, max: 6, items: [] },
        impl: { score: 0, max: 2, profile: 'compat', items: [] },
        model: { family: 'deepseek-thirdparty', claim: 'unproven', weights: 'unproven', items: [] } };
      fs.writeFileSync(f, JSON.stringify({ ...base, ...patch }));
      return f;
    };
    const post6 = (port) => fetch(`http://127.0.0.1:${port}/v1/responses`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 }) });
    const waitUp6 = async (port) => {
      for (let i = 0; i < 40; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${port}/gate/health`); if (r.ok) return await r.json(); } catch {} }
      return null;
    };

    // A. 过期快照 + 自愈开启
    const stale = mk6('stale.json', { at: new Date(Date.now() - 10 * 60 * 1000).toISOString() }); // 10 分钟前
    const portA6 = P0 + 43;
    const gA6 = await startGate(portA6, { GATE_EVIDENCE_FILE: stale, GATE_CANARY_POLICY: 'require',
      GATE_EVIDENCE_MAX_AGE_MS: '60000', GATE_EVIDENCE_AUTO_REFRESH: '1', GATE_EVIDENCE_REFRESH_MIN_MS: '0',
      DEEPSEEK_API_KEY: '' });   // 无官方基线：验证 canary skipped 不再被当成通过
    const hA6 = await waitUp6(portA6);
    await fetch(`http://127.0.0.1:${MP}/mode/ok`);   // mock 模式是全局的：先复位，否则 200/503 会互相污染
    check('G30 实例启动', !gA6.failed && !!hA6, gA6.failed ? gA6.stderr().slice(0, 120) : 'ok');

    const r1 = await post6(portA6);
    const b1 = await r1.text();
    check('G30 过期快照 → 503 且原因是 snapshot_missing_or_stale',
      r1.status === 503 && /snapshot_missing_or_stale/.test(b1), `status=${r1.status}`);
    check('G30 报文点明拦截者（blocked_by=canary_evidence）',
      /"blocked_by":"canary_evidence"/.test(b1), b1.slice(0, 100));
    check('G30 报文声明已触发后台补刷',
      /"refresh_started":true/.test(b1) && r1.headers.get('x-gate-refresh') === 'started',
      `hdr=${r1.headers.get('x-gate-refresh')}`);

    let hh6 = null, refreshed = false;
    for (let i = 0; i < 60; i++) { await sleep(200); hh6 = await fetch(`http://127.0.0.1:${portA6}/gate/health`).then(r => r.json()).catch(() => null); if (hh6?.evidence?.refresh?.ok === true) { refreshed = true; break; } }
    check('G30 后台刷新跑完并写回快照', refreshed, `refresh=${JSON.stringify(hh6?.evidence?.refresh || {}).slice(0, 110)}`);
    check('G30 刷新后快照不再过期', hh6?.evidence?.stale === false, `ageMs=${hh6?.evidence?.ageMs}`);
    check('G30 health 暴露 maxAgeMs 与 refresh 状态',
      typeof hh6?.evidence?.maxAgeMs === 'number' && hh6?.evidence?.refresh?.auto === true,
      `maxAge=${hh6?.evidence?.maxAgeMs}`);

    const r2 = await post6(portA6);
    const b2 = await r2.text();
    check('G30 刷新后理由从"过期"变"缺基线"（截断的是同一条闸，不是同一种原因）',
      !/snapshot_missing_or_stale/.test(b2) && /canary_unproven_no_baseline_key/.test(b2),
      `status=${r2.status} body=${b2.slice(0, 110)}`);
    try { gA6.child.kill('SIGKILL'); } catch {}

    // B. 缺基线（skipped 无原因的老快照）→ 必须拦，不能再 fail-open
    const legacy = mk6('legacy.json', { canary: { score: 0, max: 0, ok: false, skipped: true, items: [] } });
    const gB6 = await startGate(P0 + 44, { GATE_EVIDENCE_FILE: legacy, GATE_CANARY_POLICY: 'require' });
    await waitUp6(P0 + 44);
    const b3 = await (await post6(P0 + 44)).text();
    check('G30 旧快照 skipped 无原因 → 按"无法证明"拒绝', /canary_unproven_legacy_unknown/.test(b3), b3.slice(0, 110));
    try { gB6.child.kill('SIGKILL'); } catch {}

    // C. 目标即官方（official_target）→ 放行，不能自锁
    const offc = mk6('official.json', { canary: { score: 0, max: 0, ok: false, skipped: true, skippedReason: 'official_target', items: [] } });
    const gC6 = await startGate(P0 + 45, { GATE_EVIDENCE_FILE: offc, GATE_CANARY_POLICY: 'require' });
    await waitUp6(P0 + 45);
    await fetch(`http://127.0.0.1:${MP}/mode/ok`);   // 同上：拿 200 之前必须确认 mock 处于 ok 模式
    const r4 = await post6(P0 + 45);
    check('G30 official_target 跳过 → 200（直连不自锁）', r4.status === 200, `status=${r4.status}`);
    try { gC6.child.kill('SIGKILL'); } catch {}
  }

  // ★ 2026-11-05 阶段一：client abort 归类 + 分段计时
  console.log('\n=== G31 客户端中止归类与分段计时 ===');
  {
    const portG = P0 + 46;
    const logG = path.join(TEST_LOGS, 'cov-g31.jsonl');
    try { fs.rmSync(logG, { force: true }); } catch {}
    const gG = await startGate(portG, { GATE_LOG_FILE: logG });
    let up = false;
    for (let i = 0; i < 40 && !up; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${portG}/gate/health`); if (r.ok) up = true; } catch {} }
    check('G31 实例启动', !gG.failed && up, gG.failed ? gG.stderr().slice(0, 120) : 'ok');
    await fetch(`http://127.0.0.1:${MP}/mode/ok`);

    const ok1 = await fetch(`http://127.0.0.1:${portG}/v1/responses`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 }) });
    check('G31 正常请求 200', ok1.status === 200, `status=${ok1.status}`);

    const h1 = await (await fetch(`http://127.0.0.1:${portG}/gate/health`)).json().catch(() => null);
    const ph = h1?.phase || {};
    check('G31 health 暴露 phase 四段', !!(ph.precheckMs && ph.upstreamMs && ph.gateMs && ph.streamMs),
      `phase=${JSON.stringify(ph).slice(0, 150)}`);
    check('G31 health 暴露 ttfbMs（与含回传的 totalMs 分列）', !!ph.ttfbMs, `ttfb=${JSON.stringify(ph.ttfbMs)}`);
    check('G31 分段样本已累计', (ph.n || 0) >= 1, `n=${ph.n}`);

    // 客户端中途取消：服务端应记 CLIENT_ABORTED，且不再记 HANDLER_ERROR
    // 必须让上游先慢下来（slow 模式），否则 mock 2ms 就答完，abort 根本落不到 await 上。
    await fetch(`http://127.0.0.1:${MP}/mode/slow`);
    const ac = new AbortController();
    const p = fetch(`http://127.0.0.1:${portG}/v1/responses`, { method: 'POST', signal: ac.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 }) }).catch(() => null);
    await sleep(150);
    ac.abort();
    await p;
    await sleep(1500);
    await fetch(`http://127.0.0.1:${MP}/mode/ok`);

    const led = fs.readFileSync(logG, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const aborted = led.filter(x => x.result === 'CLIENT_ABORTED').length;
    const handlerErr = led.filter(x => x.result === 'HANDLER_ERROR').length;
    check('G31 客户端取消记为 CLIENT_ABORTED', aborted >= 1, `CLIENT_ABORTED=${aborted}`);
    check('G31 客户端取消不再记 HANDLER_ERROR', handlerErr === 0, `HANDLER_ERROR=${handlerErr}`);

    const passRec = led.find(x => x.result === 'PASS_BY_PROOF' || x.result === 'PASS');
    check('G31 PASS 台账带 phase 分段', !!(passRec && passRec.phase && typeof passRec.phase.totalMs === 'number'),
      passRec ? JSON.stringify(passRec.phase) : 'no PASS rec');
    check('G31 台账 phase 带 ttfbMs', !!(passRec && passRec.phase && typeof passRec.phase.ttfbMs === 'number'),
      passRec ? `ttfbMs=${passRec.phase.ttfbMs}` : '-');
    check('G31 分段之和 ≈ 总耗时（不重不漏）',
      !!passRec && Math.abs((passRec.phase.precheckMs + passRec.phase.upstreamMs + passRec.phase.gateMs + passRec.phase.streamMs) - passRec.phase.totalMs) <= 5,
      passRec ? `sum=${passRec.phase.precheckMs + passRec.phase.upstreamMs + passRec.phase.gateMs + passRec.phase.streamMs} total=${passRec.phase.totalMs}` : '-');
    try { gG.child.kill('SIGKILL'); } catch {}
  }

  // ★ 2026-11-05 阶段二：车道级预检 + 判负即切换（端到端）
  console.log('\n=== G32 判负即切换（首车道判 third → 次车道交付） ===');
  {
    const u4 = '0123456789ab4cde8f0123456789abcd';
    const mkBody = (model, id) => ({ id, object: 'response', created_at: 1, status: 'completed', model,
      output: [{ type: 'message', id: 'msg_' + u4, role: 'assistant', status: 'completed',
                 content: [{ type: 'output_text', text: '好' }] }],
      usage: { cost: 0, input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, opencode: {},
               output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 },
      incomplete_details: null, error: null, instructions: null, max_output_tokens: 8, metadata: {},
      parallel_tool_calls: true, previous_response_id: null, reasoning: null, store: false, temperature: 1,
      tool_choice: 'auto', tools: [], top_p: 1, truncation: 'disabled', user: null });
    const mock2 = http.createServer((req, res) => {
      let b = ''; req.on('data', c => b += c); req.on('end', () => {
        let j = {}; try { j = JSON.parse(b); } catch {}
        const m = String(j.model || '');
        // 探针（input=ping & max_output_tokens=1）一律给"好形态"，否则预检 fail 就走不到换道；
        // 业务请求里首车道（v4-pro）给 HEX32 → 判 third；次车道给 resp_uuid4 → 应赢下交付。
        const isProbe = j.max_output_tokens === 1 && j.input === 'ping';
        const bad = !isProbe && m.includes('lane-a');   // 首车道给 HEX32 → 应判 third 并换道
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(mkBody(m, bad ? 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' : 'resp_' + u4)));
      });
    });
    const MP2 = P0 + 47;
    await new Promise(r => mock2.listen(MP2, '127.0.0.1', r));

    const portS = P0 + 48;
    const logS = path.join(TEST_LOGS, 'cov-g32.jsonl');
    try { fs.rmSync(logS, { force: true }); } catch {}
    const gS = await startGate(portS, {
      GATE_CHAIN: 'deepseek-lane-a,deepseek-lane-b', HEDGE: undefined,
      GATE_HOST: '127.0.0.1', GATE_HOST_PORT: String(MP2), GATE_HOST_SCHEME: 'http', GATE_UPSTREAM_PREFIX: '',
      GATE_LOG_FILE: logS, GATE_SNAPSHOT: path.join(TEST_LOGS, 'cov-g32-m.json'),
      GATE_ASSURANCE: 'label', GATE_CANARY_POLICY: 'label',
    });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${portS}/gate/health`); if (r.ok) up = true; } catch {} }
    check('G32 双车道实例启动', !gS.failed && up, gS.failed ? gS.stderr().slice(0, 140) : 'ok');

    const res = await fetch(`http://127.0.0.1:${portS}/v1/responses`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 }) });
    check('G32 首车道判负但整体仍交付（不再整条打死）', res.status === 200, `status=${res.status}`);
    const led = fs.readFileSync(logS, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const pass = led.find(x => x.result === 'PASS_BY_PROOF' || x.result === 'PASS');
    check('G32 赢下车道 = 次车道', !!pass && pass.model === 'deepseek-lane-b', pass ? `winner=${pass.model}` : 'no PASS');
    check('G32 台账记录了两条车道尝试', !!pass && (pass.attempts || []).length === 2, pass ? `attempts=${(pass.attempts || []).length}` : '-');
    check('G32 首车道被记为 third',
      !!pass && (pass.attempts || [])[0]?.verdict === 'third',
      pass ? JSON.stringify((pass.attempts || []).map(a => a.verdict)) : '-');
    const laneRecs = led.filter(x => x.result === 'PRECHECK' && x.lane);
    check('G32 预检按车道分别记录', laneRecs.length >= 2, `laneRecs=${laneRecs.length}`);
    const blocked = led.filter(x => x.result === 'BLOCKED_PRECHECK_NOT_PASS').length;
    check('G32 不再因首车道预检失败而整条拦', blocked === 0, `BLOCKED_PRECHECK_NOT_PASS=${blocked}`);

    try { gS.child.kill('SIGKILL'); } catch {}
    try { mock2.close(); } catch {}
  }

  // ★ 2026-11-05 判正增强：逐响应骨架证据（键顺序 + server 头）与伪装升级告警
  console.log('\n=== G33 逐响应骨架证据（键顺序 / server 头）===');
  {
    const u4 = '0123456789ab4cde8f0123456789abcd';
    const OFFICIAL_KEYS = ['id','object','created_at','status','background','completed_at','content_filters','error',
      'frequency_penalty','incomplete_details','instructions','max_output_tokens','max_tool_calls','model','moderation',
      'output','parallel_tool_calls','presence_penalty','previous_response_id','prompt_cache_key','prompt_cache_retention',
      'reasoning','safety_identifier','service_tier','store','temperature','text','tool_choice','tools','top_logprobs',
      'top_p','truncation','usage','user','metadata'];
    const val = (k) => {
      if (k === 'id') return 'e1e4412f-7b5c-4b46-ac44-0123456789ab';
      if (k === 'object') return 'response';
      if (k === 'created_at') return 1;
      if (k === 'status') return 'completed';
      if (k === 'model') return 'deepseek-flash';
      if (k === 'output') return [{ type: 'message', id: 'msg_' + u4, role: 'assistant', status: 'completed',
                                   content: [{ type: 'output_text', text: '好' }] }];
      if (k === 'usage') return { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1,
                                  output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 };
      if (k === 'background' || k === 'store') return false;
      if (k === 'parallel_tool_calls') return true;
      if (k === 'tools') return [];
      if (k === 'text' || k === 'metadata') return {};
      if (k === 'error' || k === 'incomplete_details' || k === 'instructions' || k === 'completed_at'
          || k === 'previous_response_id' || k === 'reasoning' || k === 'temperature' || k === 'top_p'
          || k === 'max_output_tokens' || k === 'max_tool_calls' || k === 'top_logprobs'
          || k === 'service_tier' || k === 'prompt_cache_key' || k === 'prompt_cache_retention'
          || k === 'safety_identifier' || k === 'user' || k === 'truncation' || k === 'moderation'
          || k === 'content_filters' || k === 'frequency_penalty' || k === 'presence_penalty') return null;
      return null;
    };
    const officialBody = () => { const o = {}; for (const k of OFFICIAL_KEYS) o[k] = val(k); return o; };
    let mode3 = 'official';
    const mock3 = http.createServer((req, res) => {
      if (String(req.url).startsWith('/mode/')) { mode3 = String(req.url).slice(6); res.writeHead(200); return res.end(mode3); }
      let b = ''; req.on('data', c => b += c); req.on('end', () => {
        const proto = mode3;
        res.setHeader('content-type', 'application/json');
        if (proto === 'official') {
          res.setHeader('server', 'openresty');
          res.setHeader('x-ds-trace-id', 'abcdef0123456789');
          return res.end(JSON.stringify(officialBody()));
        }
        if (proto === 'mimic') {   // 中转头 + 官方骨架 = 伪装升级
          res.setHeader('server', 'cloudflare');
          res.setHeader('cf-ray', 'abc123-LAX');
          return res.end(JSON.stringify(officialBody()));
        }
        res.setHeader('server', 'cloudflare');
        res.setHeader('cf-ray', 'abc123-LAX');
        const RELAY_KEYS = ['id','object','created_at','status','error','incomplete_details','instructions','metadata',
          'model','output','parallel_tool_calls','temperature','tool_choice','tools','top_p','max_output_tokens','reasoning','usage'];
        const rb = {};
        for (const k of RELAY_KEYS) {
          rb[k] = k === 'id' ? ('resp_' + u4)
            : k === 'object' ? 'response'
            : k === 'created_at' ? 1
            : k === 'status' ? 'completed'
            : k === 'model' ? 'deepseek-v4.1-flash'
            : k === 'output' ? [{ type: 'message', id: 'msg_' + u4, role: 'assistant', status: 'completed',
                                  content: [{ type: 'output_text', text: '好' }] }]
            : k === 'usage' ? { cost: 0, input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, opencode: {},
                                output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 }
            : k === 'tools' ? [] : k === 'parallel_tool_calls' ? true : null;
        }
        res.end(JSON.stringify(rb));   // 严格按中转 18 键顺序（判据要求"匹配中转"才记 relay）
      });
    });
    const MP3 = P0 + 49;
    await new Promise(r => mock3.listen(MP3, '127.0.0.1', r));
    const run3 = async (tag) => {
      const port = P0 + 52 + (tag === 'official' ? 0 : tag === 'relay' ? 1 : 2);
      const log = path.join(TEST_LOGS, `cov-g33-${tag}.jsonl`);
      try { fs.rmSync(log, { force: true }); } catch {}
      const g = await startGate(port, { GATE_HOST: '127.0.0.1', GATE_HOST_PORT: String(MP3),
        GATE_HOST_SCHEME: 'http', GATE_UPSTREAM_PREFIX: '', GATE_LOG_FILE: log,
        GATE_SNAPSHOT: path.join(TEST_LOGS, `cov-g33-${tag}-m.json`) });
      for (let i = 0; i < 40; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${port}/gate/health`); if (r.ok) break; } catch {} }
      await fetch(`http://127.0.0.1:${MP3}/mode/${tag}`);   // mock 的模式开关（客户端头不会被 gate 转发）
      const r = await fetch(`http://127.0.0.1:${port}/v1/responses`, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 }) });
      const proof = r.headers.get('x-gate-proof');
      await r.text();
      const h = await (await fetch(`http://127.0.0.1:${port}/gate/health`)).json().catch(() => null);
      const led = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      try { g.child.kill('SIGKILL'); } catch {}
      return { status: r.status, proof, h, led };
    };

    const off = await run3('official');
    check('G33 官方骨架 → x-gate-proof=verified', off.proof === 'verified', `proof=${off.proof} status=${off.status}`);
    check('G33 health 记录 keyOrder.official', (off.h?.evidence?.proof?.keyOrder?.official || 0) >= 1,
      JSON.stringify(off.h?.evidence?.proof?.keyOrder));
    check('G33 health 记录 server=official', (off.h?.evidence?.proof?.server?.official || 0) >= 1,
      JSON.stringify(off.h?.evidence?.proof?.server));

    const rel = await run3('relay');
    check('G33 中转骨架 → x-gate-proof=unverified', rel.proof === 'unverified', `proof=${rel.proof}`);
    check('G33 health 记录 keyOrder.relay', (rel.h?.evidence?.proof?.keyOrder?.relay || 0) >= 1,
      JSON.stringify(rel.h?.evidence?.proof?.keyOrder));

    const mim = await run3('mimic');
    const alert = mim.led.some(x => x.result === 'ALERT_RELAY_MIMICS_OFFICIAL');
    check('G33 中转头 + 官方骨架 → 伪装升级告警', alert, `alerts=${mim.led.filter(x => /ALERT/.test(x.result || '')).map(x => x.result).join(',')}`);
    check('G33 伪装场景仍按 unverified 标注（不因模仿而被信任）', mim.proof === 'unverified', `proof=${mim.proof}`);

    try { mock3.close(); } catch {}
  }

  // ★ 2026-11-05 审查修复：车道级预检的 fail 缓存必须能被保活刷新（否则该车道永久不可用）
  console.log('\n=== G34 车道级预检恢复（fail 缓存可被覆盖） ===');
  {
    const u4 = '0123456789ab4cde8f0123456789abcd';
    const mk = (model, id) => ({ id, object: 'response', created_at: 1, status: 'completed', model,
      output: [{ type: 'message', id: 'msg_' + u4, role: 'assistant', status: 'completed',
                 content: [{ type: 'output_text', text: '好' }] }],
      usage: { cost: 0, input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, opencode: {},
               output_tokens: 1, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 2 },
      incomplete_details: null, error: null, instructions: null, max_output_tokens: 8, metadata: {},
      parallel_tool_calls: true, previous_response_id: null, reasoning: null, store: false, temperature: 1,
      tool_choice: 'auto', tools: [], top_p: 1, truncation: 'disabled', user: null });
    let phase34 = 'bad';
    const mock4 = http.createServer((req, res) => {
      let b = ''; req.on('data', c => b += c); req.on('end', () => {
        let j = {}; try { j = JSON.parse(b); } catch {}
        const m = String(j.model || '');
        const isProbe = j.max_output_tokens === 1 && j.input === 'ping';
        const laneA = m.includes('lane-a');
        // 探针：lane-a 在 bad 阶段给 HEX32（判 fail）；业务：lane-a 正常、lane-b 给 HEX32（third）
        const bad = isProbe ? (laneA && phase34 === 'bad') : m.includes('lane-b');
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(mk(m, bad ? 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6' : 'resp_' + u4)));
      });
    });
    const MP4 = P0 + 55;
    await new Promise(r => mock4.listen(MP4, '127.0.0.1', r));
    const port4 = P0 + 56;
    const log4 = path.join(TEST_LOGS, 'cov-g34.jsonl');
    try { fs.rmSync(log4, { force: true }); } catch {}
    const g4 = await startGate(port4, {
      GATE_CHAIN: 'deepseek-lane-a,deepseek-lane-b',
      GATE_HOST: '127.0.0.1', GATE_HOST_PORT: String(MP4), GATE_HOST_SCHEME: 'http', GATE_UPSTREAM_PREFIX: '',
      GATE_LOG_FILE: log4, GATE_SNAPSHOT: path.join(TEST_LOGS, 'cov-g34-m.json'),
      GATE_ASSURANCE: 'label', GATE_CANARY_POLICY: 'label', GATE_L0_POLICY: 'label',
      GATE_PROOF_REFRESH_MS: '5000', GATE_PRECHECK_TTL_MS: '1000',
    });
    let up4 = false;
    for (let i = 0; i < 60 && !up4; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${port4}/gate/health`); if (r.ok) up4 = true; } catch {} }
    check('G34 双车道实例启动', !g4.failed && up4, g4.failed ? g4.stderr().slice(0, 120) : 'ok');
    const ask = async () => {
      const r = await fetch(`http://127.0.0.1:${port4}/v1/responses`, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 }) });
      await r.text(); return r.status;
    };
    const st1 = await ask();
    check('G34 lane-a 预检失败 → 该车道不被交付（503）', st1 === 503, `status=${st1}`);

    phase34 = 'good';   // 上游恢复：只有保活能解开车道级的 fail 缓存
    await sleep(9000);
    const st2 = await ask();
    check('G34 保活刷新车道缓存后恢复（不再永久 503）', st2 === 200, `status=${st2}`);
    const led = fs.readFileSync(log4, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const lanePass = led.filter(x => x.result === 'PRECHECK' && x.lane === 'deepseek-lane-a' && x.verdict === 'pass').length;
    check('G34 台账可见车道级 pass 刷新', lanePass >= 1, `lane-a pass 记录=${lanePass}`);
    try { g4.child.kill('SIGKILL'); } catch {}
    try { mock4.close(); } catch {}
  }

console.log('\n=== G35 客户端取消：只记 CLIENT_ABORTED，不记不可达/判负 ===');
{
  const port5 = P0 + 57;
  const log5 = path.join(TEST_LOGS, 'cov-g35.jsonl');
  try { fs.rmSync(log5, { force: true }); } catch {}
  await fetch(`http://127.0.0.1:${MP}/mode/ok`);
  const g5 = await startGate(port5, {
    GATE_PRECHECK_TTL_MS: '60000', GATE_LANE_RETRY: '0',
    GATE_UPSTREAM_TIMEOUT_MS: '20000', GATE_TOTAL_BUDGET_MS: '30000',
    GATE_LOG_FILE: log5, GATE_SNAPSHOT: path.join(TEST_LOGS, 'cov-g35-m.json'),
    GATE_ASSURANCE: 'label', GATE_CANARY_POLICY: 'label', GATE_L0_POLICY: 'label',
  });
  let up5 = false;
  for (let i = 0; i < 60 && !up5; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${port5}/gate/health`); if (r.ok) up5 = true; } catch {} }
  check('G35 实例启动', !g5.failed && up5, g5.failed ? g5.stderr().slice(0, 120) : 'ok');
  const first = await gate(port5, { model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 });
  check('G35 预检缓存建立（首请求 200）', first.status === 200, `status=${first.status} ${first.j?.error?.type || ''}`);

  // 切成 hang：上游永不响应，客户端 800ms 后主动断开
  await fetch(`http://127.0.0.1:${MP}/mode/hang`);
  await new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port: port5, path: '/v1/responses', method: 'POST',
      headers: { 'content-type': 'application/json' } }, () => {});
    r.on('error', () => resolve());
    r.end(JSON.stringify({ model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 }));
    setTimeout(() => { try { r.destroy(); } catch {} resolve(); }, 800);
  });
  await sleep(1500);

  const led5 = fs.readFileSync(log5, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  check('G35 记录 CLIENT_ABORTED', led5.some(x => x.result === 'CLIENT_ABORTED'),
    `aborted=${led5.filter(x => x.result === 'CLIENT_ABORTED').length}`);
  check('G35 不记 BLOCKED', !led5.some(x => x.result === 'BLOCKED'),
    `blocked=${led5.filter(x => x.result === 'BLOCKED').length}`);
  check('G35 不记 UPSTREAM_UNREACHABLE', !led5.some(x => x.result === 'UPSTREAM_UNREACHABLE'),
    `unreachable=${led5.filter(x => x.result === 'UPSTREAM_UNREACHABLE').length}`);
  const m5 = await met(port5);
  check('G35 metrics.blocked 仍为 0', m5.blocked === 0, `blocked=${m5.blocked}`);
  check('G35 metrics.abortedByClient ≥ 1', (m5.abortedByClient || 0) >= 1, `abortedByClient=${m5.abortedByClient}`);
  await fetch(`http://127.0.0.1:${MP}/mode/ok`);
  try { g5.child.kill('SIGKILL'); } catch {}
}

console.log('\n=== G36 流式「等头」watchdog：卡住的连接提前释放槽位 ===');
{
  const port6 = P0 + 58;
  const log6 = path.join(TEST_LOGS, 'cov-g36.jsonl');
  try { fs.rmSync(log6, { force: true }); } catch {}
  await fetch(`http://127.0.0.1:${MP}/mode/ok`);
  const g6 = await startGate(port6, {
    GATE_PRECHECK_TTL_MS: '60000', GATE_LANE_RETRY: '0',
    GATE_UPSTREAM_TIMEOUT_MS: '20000', GATE_TOTAL_BUDGET_MS: '30000',
    GATE_UPSTREAM_HEADERS_TIMEOUT_MS: '1200',
    GATE_LOG_FILE: log6, GATE_SNAPSHOT: path.join(TEST_LOGS, 'cov-g36-m.json'),
    GATE_ASSURANCE: 'label', GATE_CANARY_POLICY: 'label', GATE_L0_POLICY: 'label',
  });
  let up6 = false;
  for (let i = 0; i < 60 && !up6; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${port6}/gate/health`); if (r.ok) up6 = true; } catch {} }
  check('G36 实例启动', !g6.failed && up6, g6.failed ? g6.stderr().slice(0, 120) : 'ok');
  const first = await gate(port6, { model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 });
  check('G36 预检缓存建立（首请求 200）', first.status === 200, `status=${first.status}`);

  await fetch(`http://127.0.0.1:${MP}/mode/stall`);
  const t0 = Date.now();
  const r6 = await gate(port6, { model: 'deepseek-flash', input: 'hi', stream: true, max_output_tokens: 8 });
  const ms6 = Date.now() - t0;
  check('G36 流式卡头 → 503', r6.status === 503, `status=${r6.status} ${ms6}ms`);
  check('G36 提前收敛（≤8s，而不是等 20s 上游超时）', ms6 <= 8000, `${ms6}ms`);
  await sleep(300);
  const led6 = fs.readFileSync(log6, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  check('G36 台账记录 ATTEMPT_HEADERS_TIMEOUT', led6.some(x => x.result === 'ATTEMPT_HEADERS_TIMEOUT'),
    `n=${led6.filter(x => x.result === 'ATTEMPT_HEADERS_TIMEOUT').length}`);
  await fetch(`http://127.0.0.1:${MP}/mode/ok`);
  try { g6.child.kill('SIGKILL'); } catch {}
}

console.log('\n=== G37 探测状态机：两次判负 → CONFIRM → 503；两次 good → 恢复 ===');
{
  const port7 = P0 + 59;
  const log7 = path.join(TEST_LOGS, 'cov-g37.jsonl');
  try { fs.rmSync(log7, { force: true }); } catch {}
  await fetch(`http://127.0.0.1:${MP}/mode/probe_ok`);
  const g7 = await startGate(port7, {
    GATE_PROBE_ADAPTIVE: '1', GATE_CACHE_PROBE_MS: '500',
    GATE_PROBE_MS_SUSPECT: '300', GATE_PROBE_MS_CONFIRM: '250',
    GATE_CONFIRM_ON: '2', GATE_CONFIRM_MIN_MS: '1200', GATE_SENTINEL_N: '3',
    GATE_STRICT_REJECT: '1', GATE_PROBE_ACTIVE_WINDOW_MS: '0',
    GATE_PRECHECK_TTL_MS: '60000',
    GATE_LOG_FILE: log7, GATE_SNAPSHOT: path.join(TEST_LOGS, 'cov-g37-m.json'),
    GATE_ASSURANCE: 'label', GATE_CANARY_POLICY: 'label', GATE_L0_POLICY: 'label',
  });
  let up7 = false;
  for (let i = 0; i < 60 && !up7; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${port7}/gate/health`); if (r.ok) up7 = true; } catch {} }
  check('G37 实例启动', !g7.failed && up7, g7.failed ? g7.stderr().slice(0, 120) : 'ok');
  const okA = await gate(port7, { model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 });
  check('G37 初始业务 200', okA.status === 200, `status=${okA.status}`);

  await fetch(`http://127.0.0.1:${MP}/mode/probe_bad`);
  await sleep(3500);
  const h7a = await (await fetch(`http://127.0.0.1:${port7}/gate/health`)).json();
  check('G37 两次判负 → state=confirm', h7a.probeControl?.state === 'confirm',
    JSON.stringify(h7a.probeControl || null));
  const blocked = await gate(port7, { model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 });
  check('G37 CONFIRM → responses 503 gate_cache_semantics',
    blocked.status === 503 && blocked.j?.error?.type === 'gate_cache_semantics',
    `status=${blocked.status} type=${blocked.j?.error?.type}`);

  await fetch(`http://127.0.0.1:${MP}/mode/probe_ok`);
  await sleep(3500);
  const h7b = await (await fetch(`http://127.0.0.1:${port7}/gate/health`)).json();
  check('G37 两次 good → state=normal', h7b.probeControl?.state === 'normal',
    JSON.stringify(h7b.probeControl || null));
  const okB = await gate(port7, { model: 'deepseek-flash', input: 'hi', max_output_tokens: 8 });
  check('G37 恢复后业务 200', okB.status === 200, `status=${okB.status}`);
  const led7 = fs.readFileSync(log7, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  check('G37 台账有 PROBE_STATE 迁移', led7.some(x => x.result === 'PROBE_STATE'),
    led7.filter(x => x.result === 'PROBE_STATE').map(x => x.from + '->' + x.to).join(','));
  await fetch(`http://127.0.0.1:${MP}/mode/ok`);
  try { g7.child.kill('SIGKILL'); } catch {}
}

console.log('\n=== G38 messages 备选通道：预检 pass → 交付；窗口不符 → 503 ===');
{
  const askMsg = async (port) => {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
    });
    const text = await r.text(); let j = null; try { j = JSON.parse(text); } catch {}
    return { status: r.status, j, text: text.slice(0, 120) };
  };
  const mk = async (tag, port, modeName) => {
    await fetch(`http://127.0.0.1:${MP}/mode/${modeName}`);
    const log = path.join(TEST_LOGS, `cov-g38-${tag}.jsonl`);
    try { fs.rmSync(log, { force: true }); } catch {}
    const g = await startGate(port, {
      GATE_ALLOW_MESSAGES: '1', GATE_MSG_PROVIDER: '1',
      GATE_PRECHECK_TTL_MS: '60000',
      GATE_LOG_FILE: log, GATE_SNAPSHOT: path.join(TEST_LOGS, `cov-g38-${tag}-m.json`),
      GATE_ASSURANCE: 'label', GATE_CANARY_POLICY: 'label', GATE_L0_POLICY: 'label',
    });
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${port}/gate/health`); if (r.ok) up = true; } catch {} }
    return { g, up, log };
  };
  const a = await mk('ok', P0 + 60, 'msgok');
  check('G38 实例启动（msgok）', !a.g.failed && a.up, a.g.failed ? a.g.stderr().slice(0, 120) : 'ok');
  const r1 = await askMsg(P0 + 60);
  check('G38 预检 pass + msg_hex → 200 交付', r1.status === 200, `status=${r1.status} ${r1.text}`);
  const led1 = fs.readFileSync(a.log, 'utf8').split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  check('G38 台账有 MSG_PROVIDER_DELIVER', led1.some(x => x.result === 'MSG_PROVIDER_DELIVER'),
    led1.filter(x => /MSG_/.test(x.result || '')).map(x => x.result).join(',') || '(none)');
  const h1 = await (await fetch(`http://127.0.0.1:${P0 + 60}/gate/health`)).json();
  check('G38 health 暴露 msgProvider.enabled', h1.msgProvider?.enabled === true,
    JSON.stringify(h1.msgProvider || null));
  check('G38 信封评分记录 relay（mock 无 service_tier）', (h1.msgProvider?.envelopeRelay || 0) >= 1,
    `official=${h1.msgProvider?.envelopeOfficial} relay=${h1.msgProvider?.envelopeRelay}`);
  const ms1 = await (await fetch(`http://127.0.0.1:${P0 + 60}/gate/msg-status`)).json();
  check('G38 /gate/msg-status 显示可用', ms1.usable === true,
    `usable=${ms1.usable} state=${ms1.state} tier=${ms1.tier} detail=${(ms1.detail || '').slice(0, 80)}`);
  try { a.g.child.kill('SIGKILL'); } catch {}

  const b = await mk('bad', P0 + 61, 'msgbad');
  check('G38 实例启动（msgbad）', !b.g.failed && b.up, b.g.failed ? b.g.stderr().slice(0, 120) : 'ok');
  const r2 = await askMsg(P0 + 61);
  check('G38 窗口不符（m7 400）→ fail-closed 503', r2.status === 503,
    `status=${r2.status} type=${r2.j?.error?.type} ${r2.text}`);
  check('G38 失败明细包含 m10 回声', String(r2.j?.error?.precheck?.[0]?.detail || '').includes('m10'),
    String(r2.j?.error?.precheck?.[0]?.detail || '').slice(0, 160));
  const ms2 = await (await fetch(`http://127.0.0.1:${P0 + 61}/gate/msg-status`)).json();
  check('G38 /gate/msg-status 显示不可用', ms2.usable === false,
    `usable=${ms2.usable} state=${ms2.state} detail=${(ms2.detail || '').slice(0, 80)}`);
  try { b.g.child.kill('SIGKILL'); } catch {}
  await fetch(`http://127.0.0.1:${MP}/mode/ok`);
}

try { mock.close(); } catch {}
console.log(`\n===== 覆盖缺口：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
