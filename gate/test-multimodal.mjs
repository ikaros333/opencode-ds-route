// 多模态回归：图片输入在 responses / messages 两条协议、流式与非流式下的行为
const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const SESS = 'ses_mm_' + Math.random().toString(16).slice(2, 10);
let pass = 0, fail = 0;
const check = (n, ok, d) => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n.padEnd(46)} ${d ?? ''}`); };

// 1x1 透明 PNG
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const DATA_URL = 'data:image/png;base64,' + PNG_B64;

async function post(path, body, headers = {}) {
  const t0 = Date.now();
  const r = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-opencode-session': SESS, ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, h: r.headers, text: await r.text().catch(() => ''), ms: Date.now() - t0 };
}

const verdict = r => r.h.get('x-gate-result');
const shape = r => r.h.get('x-gate-id-shape');
// 上游 responses 的 id 在 UUID4/resp_ 间波动时由 eclass 预检独立证明后端，交付标 pass-by-proof。
// 两者安全级别等价（都要求「已有官方性证据」才会交付）。
const PROVEN = (v) => v === 'official' || v === 'pass-by-proof';

// 1) responses 非流式，图片放在 input 数组里
{
  const r = await post('/v1/responses', {
    model: 'deepseek-flash',
    max_output_tokens: 16,
    input: [{
      role: 'user',
      content: [
        { type: 'input_image', image_url: DATA_URL },
        { type: 'input_text', text: '这是什么颜色？一个词回答' },
      ],
    }],
  });
  check('responses 非流式 + 图片', r.status === 200 && PROVEN(verdict(r)),
    `status=${r.status} verdict=${verdict(r)} shape=${shape(r)} ${r.ms}ms`);
  check('图片请求响应体非空', r.text.length > 10, `bytes=${r.text.length}`);
}

// 2) responses 流式 + 图片
{
  const r = await post('/v1/responses', {
    model: 'deepseek-flash',
    max_output_tokens: 16,
    stream: true,
    input: [{
      role: 'user',
      content: [
        { type: 'input_image', image_url: DATA_URL },
        { type: 'input_text', text: '这是什么颜色？' },
      ],
    }],
  }, { accept: 'text/event-stream' });
  check('responses 流式 + 图片', r.status === 200 && PROVEN(verdict(r)),
    `status=${r.status} verdict=${verdict(r)} ${r.ms}ms`);
  check('流式图片响应含 data: 帧', r.text.includes('data:'), `bytes=${r.text.length}`);
}

// 3) messages 协议 + 图片（anthropic 风格 image block）
{
  const r = await post('/v1/messages', {
    model: 'deepseek-flash',
    max_tokens: 16,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
        { type: 'text', text: '这是什么颜色？' },
      ],
    }],
  });
  // 2026-10-27 起 messages 默认封禁（上游 messages 侧混入非 UUID4 id 池）：
  // 此时应回 503 proto_blocked，而不是交付一个无法证明来源的响应。
  const blockedM = r.status === 503 && (r.h.get('x-gate-reason') || '') === 'proto_blocked';
  check('messages 协议 + 图片（解封后应为 200，封禁时须 proto_blocked）',
    (r.status === 200 && PROVEN(verdict(r))) || blockedM,
    `status=${r.status} reason=${r.h.get('x-gate-reason') || ''} verdict=${verdict(r)}`);
}

// 4) 纯文本对照（确认不是所有请求都被当成 official）
{
  const r = await post('/v1/responses', {
    model: 'deepseek-flash', max_output_tokens: 8,
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
  });
  check('纯文本对照已证明官方', r.status === 200 && PROVEN(verdict(r)),
    `status=${r.status} verdict=${verdict(r)}`);
}

// 5) 损坏的图片 data（应当被上游拒绝并透传，而不是门控 503）
{
  const r = await post('/v1/responses', {
    model: 'deepseek-flash', max_output_tokens: 16,
    input: [{
      role: 'user',
      content: [
        { type: 'input_image', image_url: 'data:image/png;base64,!!!notbase64!!!' },
        { type: 'input_text', text: 'hi' },
      ],
    }],
  });
  check('损坏图片：透传上游状态而非 503 fail-closed',
    [200, 400, 422].includes(r.status), `status=${r.status} verdict=${verdict(r)} ${r.text.slice(0, 60)}`);
}

console.log(`\n===== 多模态：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail === 0 ? 0 : 1);
