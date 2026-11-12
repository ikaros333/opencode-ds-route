import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { classifySessionProbe, probeSession, pickOfficialSession, writeSessionFile } from './session-pick.mjs';

const cases = [
  [400, '{"error":{"message":"Invalid temperature value, the valid range of temperature is [0, 2]"}}', 'OFFICIAL_TEXT'],
  [400, '{"error":{"message":"Upstream request failed: [invalid_request_error] Invalid temperature value, the valid range of temperature is [0, 2] (request_id: x)"}}', 'OFFICIAL_TEXT'],
  [400, '{"error":{"message":"Upstream request failed: [invalid_request_error] Invalid max_tokens value, the valid range of max_tokens is [1, 393216] (request_id: x)"}}', 'OFFICIAL_TEXT'],
  [400, '{"error":{"message":"Upstream request failed: [invalid_request_error] worker: temperature must be in [0, 2], got 9 (request_id: gw-x)"}}', 'WORKER_WRAP'],
  [400, '{"error":{"message":"Upstream request failed: [InvalidParameter] Invalid parameter: max_completion_tokens must be <= 2, got 9"}}', 'MIS_MAP'],
  [200, '{"id":"resp_x"}', 'NO_VALIDATION'],
  [0, 'ENOTFOUND', 'NET'],
];
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('PASS ', name, detail); }
  else { fail++; console.log('FAIL ', name, detail); }
};
for (const [s, t, want] of cases) check('classify ' + want, classifySessionProbe(s, t) === want, classifySessionProbe(s, t));

const server = http.createServer((req, res) => {
  let b = ''; req.on('data', c => b += c); req.on('end', () => {
    const sess = req.headers['x-opencode-session'] || '';
    if (sess === 'good' || sess === 'sess-2') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid temperature value, the valid range of temperature is [0, 2]' } }));
    } else if (sess === 'mismatch') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid parameter: max_completion_tokens must be <= 2, got 9' } }));
    } else {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Upstream request failed: [invalid_request_error] worker: temperature must be in [0, 2], got 9 (request_id: gw-x)' } }));
    }
  });
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const p1 = await probeSession('good', { baseUrl, key: 'k' });
check('probe official', p1.kind === 'OFFICIAL_TEXT', p1.kind);
const p2 = await probeSession('wrap', { baseUrl, key: 'k' });
check('probe worker', p2.kind === 'WORKER_WRAP', p2.kind);
const picked = await pickOfficialSession({ current: 'wrap', sessions: ['wrap', 'good'], baseUrl, key: 'k' });
check('pick official after wrap', picked.picked === 'good' && picked.official === true, picked.picked);
const none = await pickOfficialSession({ current: 'wrap', sessions: ['wrap', 'mismatch'], baseUrl, key: 'k' });
check('no official keeps current', none.picked === 'wrap' && none.official === false, none.picked);
const defaultPick = await pickOfficialSession({ current: 'sess-0', count: 4, baseUrl, key: 'k' });
check('default candidates include short sess-N', defaultPick.picked === 'sess-2' && defaultPick.official === true, defaultPick.picked);
const tmp = path.join(os.tmpdir(), 'ocg-session-test-' + process.pid + '.txt');
fs.writeFileSync(tmp, 'old\n');
const w = writeSessionFile(tmp, 'new');
check('session file written', fs.readFileSync(tmp, 'utf8').trim() === 'new');
check('backup created', !!w.backup && fs.readFileSync(w.backup, 'utf8').trim() === 'old');
server.closeAllConnections?.();
await new Promise(r => server.close(r));
console.log(`\n===== session-pick：${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
