#!/usr/bin/env node
/**
 * link-obsidian-vault.mjs —— 把知识库目录注册进 Obsidian 的「库列表」
 *
 * 目标文件：%APPDATA%\obsidian\obsidian.json（在工作区之外，需要一次提权）
 * 安全措施：
 *   1. 写入前先备份为 obsidian.json.bak-<时间戳>；
 *   2. 已存在同名库时不做任何修改（幂等）；
 *   3. 只新增一个 vault 条目，不动其它库的配置；
 *   4. 刻意**不设** `open: true`，避免抢掉你原有的启动库。
 *
 * 用法：node tools/link-obsidian-vault.mjs [--dry]
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const KB = path.resolve(import.meta.dirname, '..');
const DRY = process.argv.includes('--dry');
const CFG = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'obsidian', 'obsidian.json');

if (!existsSync(CFG)) {
  console.error(`找不到 Obsidian 配置：${CFG}`);
  process.exit(1);
}

const raw = readFileSync(CFG, 'utf8');
const cfg = JSON.parse(raw);
cfg.vaults = cfg.vaults || {};

const already = Object.entries(cfg.vaults).find(([, v]) => (v.path || '').toLowerCase().replace(/\//g, '\\') === KB.toLowerCase());
if (already) {
  console.log(`已经注册过了，无需改动：${already[0]} → ${already[1].path}`);
  process.exit(0);
}

const id = crypto.randomBytes(8).toString('hex');
const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);

console.log('===== 将要写入 =====');
console.log(`配置文件 : ${CFG}`);
console.log(`现有库   : ${Object.keys(cfg.vaults).length} 个`);
for (const [k, v] of Object.entries(cfg.vaults)) console.log(`   ${k}  open=${v.open ?? false}  ${v.path}`);
console.log(`新增库   : ${id}  ${KB}`);

if (DRY) {
  console.log('\n（--dry 演练，未写入）');
  process.exit(0);
}

// 1) 备份
const bak = `${CFG}.bak-${stamp}`;
copyFileSync(CFG, bak);
console.log(`\n已备份原文件 → ${path.basename(bak)}`);

// 2) 写入（保持 Obsidian 的紧凑 JSON 风格；不设置 open，避免改变你的默认启动库）
cfg.vaults[id] = { path: KB, ts: Date.now() };
writeFileSync(CFG, JSON.stringify(cfg), 'utf8');

// 3) 复核
const back = JSON.parse(readFileSync(CFG, 'utf8'));
const ok = Object.values(back.vaults).some((v) => (v.path || '').toLowerCase() === KB.toLowerCase());
console.log(`写入后复核：${ok ? '✓ 已出现在库列表中' : '✗ 未找到，写入可能失败'}（共 ${Object.keys(back.vaults).length} 个库）`);

// 4) 提醒 Obsidian 是否在运行
try {
  const out = execSync('tasklist /FI "IMAGENAME eq Obsidian.exe" /NH', { encoding: 'utf8' });
  if (/Obsidian\.exe/i.test(out)) {
    console.log('\n⚠️ 检测到 Obsidian 正在运行：它退出时会把内存里的库列表写回这个文件，');
    console.log('   从而覆盖本次新增。请「完全退出 Obsidian」后再运行一次本脚本，或退出后用库切换器确认。');
  } else {
    console.log('\nObsidian 当前未运行 —— 直接启动即可在「库切换器」里看到它。');
  }
} catch {
  /* tasklist 不可用就跳过检查 */
}
