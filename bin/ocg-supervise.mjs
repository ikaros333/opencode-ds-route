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
 *   · 目录下存在 stop.flag → 不再重启；收到 SIGINT/SIGTERM 时先把子进程带走
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GATE = path.join(ROOT, 'gate', 'oc-gate.mjs');
const STOP_FLAG = path.join(ROOT, 'stop.flag');

// 计划任务把端口作为参数传进来（任务没有独立环境变量，只能走命令行）。
// 不传则沿用环境里的 GATE_PORT，再没有就是门控默认的 8787。
const argv = process.argv.slice(2);
const portEq = argv.find(a => a.startsWith('--port='));
const portIdx = argv.indexOf('--port');
const portArg = portEq ? portEq.slice('--port='.length) : (portIdx >= 0 ? argv[portIdx + 1] : null);
if (portArg && /^\d+$/.test(String(portArg).trim())) process.env.GATE_PORT = String(portArg).trim();

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
