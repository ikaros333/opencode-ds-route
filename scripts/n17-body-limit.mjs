// 测上游（opencode）能接受多大的请求体
// 技巧：把填充放在不会进 token 的字段（_pad），input 只用 "ping"，max_output_tokens=1
// 这样即使上游接受，成本也接近 0；若上游拒绝，则记录其上限与报错形态。
import https from 'node:https';

const KEY = process.env.OPENCODE_GO_API_KEY || '';
const HOST = 'opencode.ai';
const PATH = '/zen/go/v1/responses';
const SIZES = [8, 16, 20, 24, 32, 48, 64]; // MiB

function send(sizeMiB) {
  return new Promise((resolve) => {
    const pad = 'x'.repeat(sizeMiB * 1024 * 1024);
    const body = JSON.stringify({
      model: 'deepseek-v4.1-flash',
      input: 'ping',
      max_output_tokens: 1,
      reasoning: { effort: 'none' },
      _pad: pad,
    });
    const data = Buffer.from(body);
    const t0 = Date.now();
    const req = https.request({
      host: HOST, port: 443, path: PATH, method: 'POST', timeout: 180000,
      headers: {
        authorization: 'Bearer ' + KEY,
        'content-type': 'application/json',
        'content-length': data.length,
        'x-opencode-session': 'bodysize-probe',
        'x-opencode-session-id': 'bodysize-probe',
      },
    }, (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - t0, bytes: data.length, body: b.slice(0, 300) }));
    });
    req.on('error', (e) => resolve({ status: 0, ms: Date.now() - t0, bytes: data.length, body: 'ERR ' + e.message }));
    req.write(data); req.end();
  });
}

(async () => {
  if (!KEY) { console.log('缺少 OPENCODE_GO_API_KEY'); process.exit(1); }
  console.log('size(MiB)  实际字节     状态  耗时     返回摘录');
  for (const s of SIZES) {
    const r = await send(s);
    const brief = String(r.body).replace(/\s+/g, ' ').slice(0, 110);
    console.log(`${String(s).padStart(6)}  ${String(r.bytes).padStart(10)}  ${String(r.status).padStart(4)}  ${String(r.ms + 'ms').padStart(6)}  ${brief}`);
    const tooLarge = /too large|payload|413|Request Entity/i.test(r.body) || r.status === 413;
    if (tooLarge) { console.log('  ↑ 上游在此尺寸拒绝（达到其上限）'); break; }
  }
})();
