#!/usr/bin/env node
/**
 * verify-fresh.mjs —— 新搭好的知识库验收（骨架 / 工具 / 模板 / 编码 / 流水线自检）
 *
 * 只读检查，不修改任何文件。用法：
 *   node verify-fresh.mjs --kb="<知识库路径>"
 *   （不传 --kb 时默认当前目录）
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const argv = process.argv.slice(2);
const hit = argv.find((a) => a.startsWith('--kb='));
const KB = hit ? hit.slice(5).replace(/^"|"$/g, '') : process.cwd();

const checks = [];
const add = (ok, label, detail = '') => checks.push({ ok, label, detail });

// ① 目录骨架
const DIRS = ['notes', 'digests', 'index', 'cache/text', 'inbox', 'materials', 'vocab', 'review', 'external', 'fulltext', 'chats', 'tools'];
const missingDirs = DIRS.filter((d) => !existsSync(path.join(KB, d)));
add(missingDirs.length === 0, '目录骨架', missingDirs.length ? `缺 ${missingDirs.join('、')}` : `${DIRS.length} 个目录齐全`);

// ② 核心工具
const toolsDir = path.join(KB, 'tools');
const tools = existsSync(toolsDir) ? readdirSync(toolsDir).filter((f) => f.endsWith('.mjs')) : [];
const CORE = [
  'scan.mjs',
  'extract-text.mjs',
  'link-notes.mjs',
  'build-index.mjs',
  'obsidian-sync.mjs',
  'obsidian-check.mjs',
  'status.mjs',
  'search.mjs',
  'fix-id-links.mjs',
  'check-yaml.mjs',
  'check-math.mjs',
];
const missCore = CORE.filter((f) => !existsSync(path.join(toolsDir, f)));
add(missCore.length === 0, `核心工具（${CORE.length} 个）`, missCore.length ? `缺 ${missCore.join('、')}` : `共 ${tools.length} 个脚本`);

// ③ 脚本语法（node --check，stdio ignore 以避开管道限制）
const bad = [];
for (const f of tools) {
  const r = spawnSync(process.execPath, ['--check', path.join(toolsDir, f)], { stdio: 'ignore' });
  if (r.status !== 0) bad.push(f);
}
add(bad.length === 0, '脚本语法', bad.length ? `失败：${bad.join('、')}` : `${tools.length} 个全部通过`);

// ④ 模板占位已替换
const leftover = [];
for (const rel of ['AGENTS.md', 'index/tags.md', 'tools/sources.json']) {
  const f = path.join(KB, rel);
  if (existsSync(f) && /__KB__|__NAME__|__DATE__/.test(readFileSync(f, 'utf8'))) leftover.push(rel);
}
add(leftover.length === 0, '模板占位已替换', leftover.length ? `仍含占位符：${leftover.join('、')}` : 'AGENTS / tags / sources 已本地化');

// ⑤ 无 BOM（BOM 会让 front matter 解析失败）
const bom = [];
const scan = (d) => {
  if (!existsSync(d)) return;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'tools') continue;
    const p = path.join(d, e.name);
    if (e.isDirectory()) scan(p);
    else if (e.name.endsWith('.md')) {
      const b = readFileSync(p);
      if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) bom.push(path.relative(KB, p));
    }
  }
};
scan(KB);
add(bom.length === 0, '无 BOM', bom.length ? `${bom.length} 个文件带 BOM：${bom.slice(0, 3).join('、')}` : '全部 md 均为 UTF-8 无 BOM');

// ⑥ sources.json
let srcOk = false;
let srcDetail = '';
const sp = path.join(toolsDir, 'sources.json');
if (!existsSync(sp)) srcDetail = '缺 tools/sources.json';
else {
  try {
    const j = JSON.parse(readFileSync(sp, 'utf8'));
    const roots = j.roots || [];
    const notThere = roots.filter((r) => r.path && !/^__/.test(r.path) && !existsSync(r.path));
    srcOk = roots.length > 0;
    srcDetail = `${roots.length} 个源${notThere.length ? `（${notThere.length} 个路径暂不存在，正常）` : ''}`;
  } catch (e) {
    srcDetail = `JSON 解析失败：${e.message}`;
  }
}
add(srcOk, 'sources.json', srcDetail);

// ⑦ 流水线自检：status.mjs 能否跑通
let smoke = '未运行';
let smokeOk = false;
if (existsSync(path.join(toolsDir, 'status.mjs'))) {
  const r = spawnSync(process.execPath, [path.join(toolsDir, 'status.mjs')], { stdio: 'ignore', cwd: KB });
  smokeOk = r.status === 0;
  smoke = smokeOk ? '运行成功' : `退出码 ${r.status}`;
} else smoke = '缺 status.mjs';
add(smokeOk, '流水线自检', smoke);

// ⑧ 可选：Obsidian 插件
const plugDir = path.join(KB, '.obsidian', 'plugins');
const plugs = existsSync(plugDir) ? readdirSync(plugDir) : [];
add(true, 'Obsidian 插件（可选）', plugs.length ? plugs.join('、') : '未安装（要背单词时再装）');

console.log(`新库验收：${KB}\n`);
for (const c of checks) console.log(`  ${c.ok ? '✓' : '✗'} ${c.label.padEnd(22, ' ')} ${c.detail}`);
const fail = checks.filter((c) => !c.ok).length;
console.log(fail ? `\n结论：${fail} 项未通过 —— 先修好再开始建卡。` : '\n结论：骨架可用 ✓ 接着 scan → extract-text → 写卡片。');
process.exit(fail ? 1 : 0);
