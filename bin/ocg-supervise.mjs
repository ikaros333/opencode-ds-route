#!/usr/bin/env node
/**
 * ocg-supervise — 进程监护：拉起门控，退出后自动重启。
 *
 * 为什么要它：2026-10-23 实测 **Task Scheduler 的 RestartCount/RestartInterval 不会在
 * 进程退出后重启任务**（场景 A：进程 exit(1)，3 分 20 秒内启动次数始终为 2；
 * 场景 B：外部 kill，85 秒后仍未重启，LastResult=0xFFFFFFFF）。
 * 它只在"任务启动失败"这类场景生效，对"程序跑起来后又挂了"无效。
 * 所以监护必须自己做，计划任务只负责登录时把监护拉起来。
 *
 * 行为：
 *   · 子进程退出 → 1.5 秒后重启
 *   · 1 分钟内连续退出超过 5 次 → 退避到 15 秒（防启动风暴打满上游）
 *   · 门控以「端口被占用」退出码退出 → 不再重启，直接带走自己（防隐形重启循环）
 *   · 同一端口只允许一个监护实例（按端口的锁文件，抢不到就退出并打印占用者）
 *   · 目录下存在 stop.flag → 不再重启；收到 SIGINT/SIGTERM 时先把子进程带走
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'gate', 'oc-gate.mjs');
const STOP_FLAG = path.join(ROOT, 'stop.flag');

/** 门控「端口被占用」的退出码（与 gate/oc-gate.mjs 的 EXIT_PORT_IN_USE 必须一致） */
const PORT_IN_USE_CODE = 4;
/** 本监护「已有同端口实例在跑」的退出码 */
const ALREADY_RUNNING_CODE = 3;

// 计划任务把端口作为参数传进来（任务没有独立环境变量，只能走命令行）。
// 不传则沿用环境里的 GATE_PORT，再没有就是门控默认的 8787。
const argv = process.argv.slice(2);
const portEq = argv.find(a => a.startsWith('--port='));
const portIdx = argv.indexOf('--port');
const portArg = portEq ? portEq.slice('--port='.length) : (portIdx >= 0 ? argv[portIdx + 1] : null);
if (portArg && /^\d+$/.test(String(portArg).trim())) process.env.GATE_PORT = String(portArg).trim();

// ---------- 单实例锁（按端口） ----------
// 起因（2026-10-26 实测）：同端口被拉起两次监护时，第二个门控必然 EADDRINUSE 立刻退出，
// 监护按 15s 退避无限重启 —— 外部只看到「有个门控在跑」，日志里什么都没有。
// 锁文件按端口区分：8787 生产与 8788 影子并存是合法用法，不该被互斥掉。
const LOCK = path.join(ROOT, `supervise-${process.env.GATE_PORT || 'default'}.lock`);
const LOCK_PORT = Number(process.env.GATE_PORT || 8787);
let heldLock = false;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; } // EPERM = 活着但无权限
}

/**
 * 端口上是否已经有「我们的门控」在应答 —— 这是锁的**真值来源**。
 * 为什么不能只看 pidAlive：Windows 会快速复用 PID，监护被强杀后锁里的 pid 很可能被
 * 任意新进程占用，于是「有实例在跑」永远成立、这个端口再也起不来（只能手工删锁）。
 * 所以：锁只是提示，端口应答才是事实；两者矛盾时以端口为准回收锁。
 */
function liveGate() {
  return new Promise((resolve) => {
    let done = false;
    const fin = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get({ host: '127.0.0.1', port: LOCK_PORT, path: '/gate/health', timeout: 900 }, (r) => {
      let buf = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { if (buf.length < 65536) buf += c; });
      r.on('end', () => {
        try {
          const h = JSON.parse(buf);
          fin(h && h.ok ? { pid: h.pid ?? null, root: h.root ?? null } : null);
        } catch { fin(null); }
      });
    });
    req.on('timeout', () => { req.destroy(); fin(null); });
    req.on('error', () => fin(null));
  });
}

async function acquireLock() {
  const payload = JSON.stringify({
    pid: process.pid, port: process.env.GATE_PORT || null, root: ROOT, at: new Date().toISOString(),
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK, 'wx');           // 原子独占创建
      fs.writeSync(fd, payload + '\n');
      fs.closeSync(fd);
      heldLock = true;
      return true;
    } catch (e) {
      if (e?.code !== 'EEXIST') {
        // 目录只读 / 无权限：锁不可用不能变成「起不来」。端口层还有 EADDRINUSE + 门控 exit 4 兜底。
        console.error('[supervise] 单实例锁不可用（' + (e?.code || e?.message) + '），本次不加锁继续运行。');
        return true;
      }
      let held = null;
      try { held = JSON.parse(fs.readFileSync(LOCK, 'utf8')); } catch {}
      const gate = await liveGate();
      if (gate) {
        console.error(`[supervise] 同一端口(${held?.port ?? process.env.GATE_PORT ?? '?'})已有门控在跑：` +
                      `锁 pid=${held?.pid ?? '?'}、端口应答 pid=${gate.pid ?? '?'} root=${gate.root ?? held?.root ?? '?'}，本次启动放弃。`);
        console.error('[supervise] 先结束它，或用 --port 8888 起第二个实例（锁按端口区分）。');
        return false;
      }
      if (pidAlive(Number(held?.pid))) {
        console.error(`[supervise] 锁里的 pid=${held?.pid} 仍存在但端口 ${LOCK_PORT} 无门控应答` +
                      '（Windows PID 复用），按陈旧锁回收。');
      } else {
        console.error('[supervise] 回收陈旧锁：' + LOCK);
      }
      try { fs.unlinkSync(LOCK); } catch {}
    }
  }
  return false;
}

if (!(await acquireLock())) process.exit(ALREADY_RUNNING_CODE);
process.on('exit', () => { if (heldLock) { try { fs.unlinkSync(LOCK); } catch {} } });

let child = null;
let stopping = false;
const exits = [];

const shouldStop = () => stopping || fs.existsSync(STOP_FLAG);

function shutdown(sig) {
  stopping = true;
  if (child) { try { child.kill(sig); } catch {} }
  // 给子进程 500ms 收尾，然后自己退出
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGTERM'));

function start() {
  if (shouldStop()) return;
  const startedAt = Date.now();
  child = spawn(process.execPath, [GATE], { stdio: 'inherit', env: process.env });
  child.on('error', e => console.error('[supervise] 子进程启动失败：', e?.message || e));
  child.on('exit', (code, signal) => {
    child = null;
    if (shouldStop()) { console.error('[supervise] 收到停止指令，退出'); process.exit(0); }
    // 端口被占用不是可恢复故障：重启只会制造隐形循环，直接带走自己
    if (code === PORT_IN_USE_CODE) {
      console.error('[supervise] 门控报告端口被占用（exit=' + PORT_IN_USE_CODE + '），不再重启。');
      process.exit(PORT_IN_USE_CODE);
    }
    // 1 分钟窗口内的退出次数决定退避
    const now = Date.now();
    while (exits.length && now - exits[0] > 60000) exits.shift();
    exits.push(now);
    const delay = exits.length > 5 ? 15000 : 1500;
    console.error(`[supervise] 门控退出 code=${code} signal=${signal || '-'} ` +
      `存活=${((now - startedAt) / 1000).toFixed(1)}s，${delay}ms 后重启`);
    setTimeout(start, delay);
  });
}

console.error(`[supervise] 监护启动：${GATE}`);
start();
