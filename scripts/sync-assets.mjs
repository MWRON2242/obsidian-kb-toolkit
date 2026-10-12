#!/usr/bin/env node
/**
 * sync-assets.mjs —— 把仓库根的 tools/ 与 templates/ 同步进 skills/kb-starter/assets/
 *
 * 为什么需要它：`tools/` 是**唯一权威来源**，但 skill 必须**自包含**
 * （要能被单独拷到别的机器的 skills 目录里，bootstrap 才能独立跑）。
 * 两处副本会漂移，所以改完 tools/ 就跑一次这个脚本。
 *
 * 会跳过个人配置（tools/sources.json、tools/external-sources.json 不发布）。
 *
 * 用法：
 *   node scripts/sync-assets.mjs          # 同步
 *   node scripts/sync-assets.mjs --check  # 只报告哪些不一致
 */
import { readdirSync, copyFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CHECK = process.argv.includes('--check');
const TOOL_SRC = path.join(ROOT, 'tools');
const TOOL_DST = path.join(ROOT, 'skills', 'kb-starter', 'assets', 'tools');
const TPL_SRC = path.join(ROOT, 'templates');
const TPL_DST = path.join(ROOT, 'skills', 'kb-starter', 'assets', 'templates');

/** 模板在 skill 资产里的目标文件名（bootstrap 会按这些名字去找） */
const TPL_MAP = {
  'kb-README.md': 'README.md',
  'external-sources.example.json': 'external-sources.json',
};

const hash = (p) => createHash('sha1').update(readFileSync(p)).digest('hex');
let same = 0;
let changed = 0;

for (const f of readdirSync(TOOL_SRC).sort()) {
  if (!f.endsWith('.mjs') && f !== 'package.json') continue; // sources.json 等个人配置不发布
  const src = path.join(TOOL_SRC, f);
  const dst = path.join(TOOL_DST, f);
  if (existsSync(dst) && hash(src) === hash(dst)) {
    same++;
    continue;
  }
  changed++;
  console.log(`  ${CHECK ? '[不一致]' : '已同步'} tools/${f}`);
  if (!CHECK) {
    mkdirSync(TOOL_DST, { recursive: true });
    copyFileSync(src, dst);
  }
}

for (const f of readdirSync(TPL_SRC).sort()) {
  const dstName = TPL_MAP[f] || f;
  const src = path.join(TPL_SRC, f);
  const dst = path.join(TPL_DST, dstName);
  if (existsSync(dst) && hash(src) === hash(dst)) {
    same++;
    continue;
  }
  changed++;
  console.log(`  ${CHECK ? '[不一致]' : '已同步'} templates/${f} → assets/templates/${dstName}`);
  if (!CHECK) {
    mkdirSync(TPL_DST, { recursive: true });
    copyFileSync(src, dst);
  }
}

console.log(`\n一致 ${same} 个，${CHECK ? '需同步' : '已同步'} ${changed} 个${CHECK && changed ? '（跑 node scripts/sync-assets.mjs 修）' : ''}`);
