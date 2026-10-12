#!/usr/bin/env node
/**
 * sync-external.mjs —— 把主 Obsidian 库里的专题笔记单向镜像到知识库的 external/ 层
 *
 * 目的：让「主库的知识网」和「知识库的知识网」出现在同一张 Obsidian 图谱里。
 * 因为 Obsidian 的图谱按库隔离，唯一的办法是让文件进入同一个库；本脚本用**复制**实现，
 * 而不是 symlink/junction（Obsidian 官方明确不建议后者）。
 *
 * 安全设计：
 *   1. 单向：源（主库）为权威，镜像只读；
 *   2. 分叉检测：若镜像侧文件被本地改过（当前哈希 ≠ 上次同步时源的哈希），报冲突并**跳过**，
 *      绝不静默覆盖，除非显式 --force；
 *   3. 孤儿文件（源里已删）默认只报告，--prune 才删除；
 *   4. 状态文件 external/_sync-state.json 记录每个文件的源哈希，用于判断分叉。
 *
 * 用法：
 *   node tools/sync-external.mjs            # 同步（默认不覆盖冲突、不删孤儿）
 *   node tools/sync-external.mjs --check    # 只报告差异，不写任何文件
 *   node tools/sync-external.mjs --force    # 冲突时用源覆盖镜像
 *   node tools/sync-external.mjs --prune    # 删除源里已不存在的镜像文件
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, copyFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const CFG = path.join(import.meta.dirname, 'external-sources.json');
const STATE = path.join(KB, 'external', '_sync-state.json');

const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const FORCE = argv.includes('--force');
const PRUNE = argv.includes('--prune');

const cfg = JSON.parse(readFileSync(CFG, 'utf8'));
const state = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { files: {} };
state.files = state.files || {};

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile()) out.push(full);
  }
  return out;
}

const stats = { added: 0, updated: 0, same: 0, conflict: 0, orphan: 0, removed: 0, skipped: 0 };
const details = [];

for (const src of cfg.sources) {
  const root = path.resolve(KB, src.dest);
  const exts = (src.include || ['.md']).map((e) => e.toLowerCase());
  console.log(`\n===== ${src.name} =====`);
  console.log(`  源  : ${src.src}`);
  console.log(`  镜像: ${src.dest}`);

  if (!existsSync(src.src)) {
    console.log('  ✗ 源目录不存在，跳过');
    stats.skipped++;
    continue;
  }

  const srcFiles = walk(src.src).filter((f) => exts.includes(path.extname(f).toLowerCase()));
  const seen = new Set();

  for (const f of srcFiles) {
    const rel = path.join(src.dest, path.relative(src.src, f)).split(path.sep).join('/');
    seen.add(rel);
    const dest = path.resolve(KB, rel);
    const srcHash = sha256(f);
    const prev = state.files[rel];

    if (!existsSync(dest)) {
      details.push(`  + 新增 ${path.relative(path.resolve(KB, src.dest), dest)}`);
      stats.added++;
      if (!CHECK) {
        mkdirSync(path.dirname(dest), { recursive: true });
        copyFileSync(f, dest);
        state.files[rel] = { srcHash, syncedAt: new Date().toISOString() };
      }
      continue;
    }

    const destHash = sha256(dest);
    if (destHash === srcHash) {
      stats.same++;
      if (!CHECK) state.files[rel] = { ...(prev || {}), srcHash, syncedAt: prev?.syncedAt || new Date().toISOString() };
      continue;
    }

    // 内容不同：先判断镜像侧是否被本地改过（分叉）
    const diverged = prev && prev.srcHash && destHash !== prev.srcHash;
    if (diverged && !FORCE) {
      details.push(`  ⚠ 冲突 ${path.relative(path.resolve(KB, src.dest), dest)}（镜像侧被本地改过，已跳过；--force 可覆盖）`);
      stats.conflict++;
      continue;
    }

    details.push(`  ~ 更新 ${path.relative(path.resolve(KB, src.dest), dest)}`);
    stats.updated++;
    if (!CHECK) {
      copyFileSync(f, dest);
      state.files[rel] = { srcHash, syncedAt: new Date().toISOString() };
    }
  }

  // 孤儿：镜像里有、源里没有
  for (const f of walk(root)) {
    const rel = path.join(src.dest, path.relative(root, f)).split(path.sep).join('/');
    if (seen.has(rel)) continue;
    const name = path.relative(root, f);
    if (PRUNE) {
      details.push(`  - 删除孤儿 ${name}`);
      stats.removed++;
      if (!CHECK) {
        rmSync(f);
        delete state.files[rel];
      }
    } else {
      details.push(`  ? 孤儿 ${name}（源里已无此文件；--prune 可删除）`);
      stats.orphan++;
    }
  }
}

if (details.length) console.log(`\n----- 明细 -----\n${details.join('\n')}`);
if (!CHECK) {
  mkdirSync(path.dirname(STATE), { recursive: true });
  state.updatedAt = new Date().toISOString();
  writeFileSync(STATE, JSON.stringify(state, null, 2), 'utf8');
}

console.log(`\n===== 同步结果${CHECK ? '（--check 只报告，未写入）' : ''} =====`);
console.log(`新增 ${stats.added}　更新 ${stats.updated}　未变 ${stats.same}　冲突 ${stats.conflict}　孤儿 ${stats.orphan}　已删 ${stats.removed}`);
if (stats.conflict) console.log('冲突项需要人工决定：改回主库，或用 --force 接受源版本覆盖。');
