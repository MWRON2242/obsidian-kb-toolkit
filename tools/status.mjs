#!/usr/bin/env node
/**
 * status.mjs —— 一条命令出一屏看板（例行巡检用，替代跑一堆脚本再读一堆输出）
 *
 * 设计目标：**省 token**。它自己做轻量统计与快查（不 spawn 子进程、不读大文件），
 * 只在最后提示"需要深度体检时再跑哪三个脚本"。
 * 深度检查（断链全解析 / YAML 逐字段 / 公式定界符）交给 obsidian-check / check-yaml / check-math。
 *
 * 用法：node tools/status.mjs [--json]
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const AS_JSON = process.argv.includes('--json');
const cntMd = (rel, filter) => {
  const d = path.join(KB, rel);
  if (!existsSync(d)) return 0;
  return readdirSync(d).filter((f) => f.endsWith('.md') && !f.startsWith('_') && (!filter || filter(f))).length;
};

/* ---------- catalog ---------- */
const catalogPath = path.join(KB, 'index', 'catalog.jsonl');
const records = existsSync(catalogPath)
  ? readFileSync(catalogPath, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];

const cardFiles = new Set(
  existsSync(path.join(KB, 'notes')) ? readdirSync(path.join(KB, 'notes')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, 7)) : [],
);
const noted = records.filter((r) => r.note).length;
const noCard = records.length - noted;
const st = {};
for (const r of records) st[r.status] = (st[r.status] || 0) + 1;
const byRoot = {};
for (const r of records) byRoot[r.root] = (byRoot[r.root] || 0) + 1;

/* ---------- 卡片轻量质检（不重跑 link-notes） ---------- */
const vocabTags = new Set(
  existsSync(path.join(KB, 'index', 'tags.md'))
    ? [...readFileSync(path.join(KB, 'index', 'tags.md'), 'utf8').matchAll(/`([^`]+)`/g)].map((m) => m[1])
    : [],
);
const problems = [];
let nkp = 0;
let nlong = 0;
if (existsSync(path.join(KB, 'notes'))) {
  for (const f of readdirSync(path.join(KB, 'notes')).filter((f) => f.endsWith('.md'))) {
    const t = readFileSync(path.join(KB, 'notes', f), 'utf8');
    const kpCount = (t.match(/^\s+-\s/gm) || []).length;
    const kp = /^key_points:\r?\n((?:[ \t]+-[^\n]*\r?\n?)+)/m.exec(t);
    nkp += kp ? [...kp[1].matchAll(/^\s+-\s/gm)].length : 0;
    const kpN = kp ? [...kp[1].matchAll(/^\s+-\s/gm)].length : 0;
    if (kpN > 7) problems.push(`key_points 超过 7 条: notes/${f}（${kpN} 条）`);
    const body = t.replace(/^---\r?\n[\s\S]*?\r?\n---/, '').replace(/## 公式速览（渲染用）[\s\S]*?(?=\n## |$)/, '');
    const len = body.replace(/^#.*$/gm, '').trim().length;
    if (len > 1600) problems.push(`正文偏长: notes/${f}（${len} 字）`);
    const tagsM = /^tags:\s*\[(.*)\]\s*$/m.exec(t);
    if (tagsM && vocabTags.size) {
      for (const tag of tagsM[1].split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!vocabTags.has(tag)) problems.push(`词表外标签「${tag}」: notes/${f}`);
      }
    }
    void kpCount;
  }
}

/* ---------- 复习层 ---------- */
let cards = 0;
let reviewed = 0;
const reviewDir = path.join(KB, 'review');
if (existsSync(reviewDir)) {
  for (const f of readdirSync(reviewDir).filter((f) => f.endsWith('.md'))) {
    const t = readFileSync(path.join(reviewDir, f), 'utf8');
    cards += (t.match(/:::/g) || []).length;
    reviewed += (t.match(/<!--SR:/g) || []).length;
  }
}

/* ---------- 插件与配置 ---------- */
const pluginDir = path.join(KB, '.obsidian', 'plugins');
const plugins = existsSync(pluginDir) ? readdirSync(pluginDir).filter((d) => statSync(path.join(pluginDir, d)).isDirectory()) : [];

/* ---------- 组装 ---------- */
const lines = [];
lines.push(`# 知识库状态  ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`);
lines.push('');
lines.push(`登记 ${records.length} 条　｜　摘要卡 ${cardFiles.size} 张　｜　待建卡 ${noCard} 条`);
lines.push('');
lines.push('## 各层数量');
lines.push(`  摘要卡 notes      ${cardFiles.size}`);
lines.push(`  对话原文 chats    ${cntMd('chats')}`);
lines.push(`  手工录入 inbox    ${cntMd('inbox')}`);
lines.push(`  素材库 materials  ${cntMd('materials', (f) => f !== '素材库总表.md')}`);
lines.push(`  单词库 vocab      ${cntMd('vocab', (f) => f !== '词汇总表.md')}`);
lines.push(`  复习卡 review     ${cards} 张（已有复习记录 ${reviewed} 条）`);
lines.push(`  成品 digests      ${cntMd('digests')} md + ${existsSync(path.join(KB, 'digests')) ? readdirSync(path.join(KB, 'digests')).filter((f) => /\.(docx|xlsx|pdf|csv)$/i.test(f)).length : 0} 文档`);
lines.push(`  外部镜像 external ${cntMd('external')}`);
lines.push('');
lines.push('## 登记来源分布');
lines.push(
  '  ' +
    Object.entries(byRoot)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, v]) => `${k} ${v}`)
      .join('　'),
);
lines.push('');
lines.push('## 状态分布');
lines.push('  ' + Object.entries(st).map(([k, v]) => `${k} ${v}`).join('　'));
lines.push('');
lines.push('## Obsidian');
lines.push(`  已装插件 ${plugins.length} 个${plugins.length ? '：' + plugins.join('、') : ''}`);
lines.push('');
lines.push('## 轻量质检');
if (problems.length) {
  lines.push(`  ⚠ 发现 ${problems.length} 项：`);
  for (const p of problems.slice(0, 12)) lines.push(`    · ${p}`);
  if (problems.length > 12) lines.push(`    …另有 ${problems.length - 12} 项`);
} else {
  lines.push('  ✓ 无（卡片 key_points / 正文长度 / 标签词表 三项快查通过）');
}
lines.push('');
lines.push('深度体检（例行改完必跑）：node tools/obsidian-check.mjs　node tools/check-yaml.mjs --all　node tools/check-math.mjs --quiet');

const report = { at: new Date().toISOString(), records: records.length, cards: cardFiles.size, noCard, byRoot, status: st, review: { cards, reviewed }, plugins, problems };
if (AS_JSON) console.log(JSON.stringify(report, null, 2));
else console.log(lines.join('\n'));
