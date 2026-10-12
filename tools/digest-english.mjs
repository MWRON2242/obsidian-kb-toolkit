#!/usr/bin/env node
/**
 * digest-english.mjs —— 汇总所有「英语」卡片，生成按板块分组的总表
 *
 * 分类依据是**标题关键词**（机械、透明、可核对），不做语义推断。
 * 输出：digests/英语-知识点总表.md（派生文件，可重跑覆盖）
 *
 * 用法：node tools/digest-english.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const NOTES = path.join(KB, 'notes');
const OUT = path.join(KB, 'digests', '英语-知识点总表.md');

/** 按顺序匹配标题，先命中先归属 */
const BUCKETS = [
  { name: '词汇与短语', keys: ['单词', '词汇', '词组', '短语', '搭配', '词根', '词缀', '近义', '反义', '翻译对照', 'shout', 'patient', '选项词'] },
  { name: '语法与句式', keys: ['语法', '倒装', '强调句', '从句', '时态', '语态', '非谓语', '虚拟', '主谓一致', '省略', '独立主格', '句式'] },
  { name: '翻译', keys: ['翻译', '中译英', '英译', '译文', '译名'] },
  { name: '写作', keys: ['作文', 'essay', '应用文', '续写', '书面表达', '写作', '信'] },
  { name: '练习与答案', keys: ['填空', '练习', '答案', '题解析', '解答', '试卷', '阅读'] },
];

const records = readFileSync(path.join(KB, 'index', 'catalog.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l));

const fm = (text) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1];
      out[key] = kv[2].trim();
    } else if (/^\s+-\s+/.test(line) && key) {
      out[key] = `${out[key] || ''} ${line.replace(/^\s+-\s+/, '')}`.trim();
    }
  }
  return out;
};

const cards = [];
for (const r of records) {
  if (!r.note) continue;
  const p = path.join(KB, r.note);
  if (!existsSync(p)) continue;
  const meta = fm(readFileSync(p, 'utf8'));
  const tags = (meta.tags || '').replace(/[[\]]/g, '').split(',').map((s) => s.trim());
  if (!tags.includes('英语')) continue;
  cards.push({ id: r.id, file: path.basename(r.note, '.md'), title: meta.title || r.title, summary: meta.summary || '', tags });
}

const buckets = new Map(BUCKETS.map((b) => [b.name, []]));
const others = [];
for (const c of cards) {
  const hit = BUCKETS.find((b) => b.keys.some((k) => c.title.includes(k)));
  if (hit) buckets.get(hit.name).push(c);
  else others.push(c);
}

const rel = (file) => path.relative(path.join(KB, 'digests'), path.join(NOTES, file + '.md')).split(path.sep).join('/');

const L = [
  '# 英语 · 知识点总表',
  '',
  '> 由 `tools/digest-english.mjs` 汇总 `notes/` 里带 `英语` 标签的卡片生成。**分类依据是标题关键词**（机械规则，可核对）。',
  `> 生成时间：${new Date().toISOString().slice(0, 16).replace('T', ' ')}　｜　共 **${cards.length}** 张英语卡片`,
  '> 单词与释义另见 [[词汇总表]]（每个单词一个笔记）；要读完整对话请点卡片里的「完整原文」链接。',
  '',
  '| 板块 | 卡片数 |',
  '| --- | --- |',
];
for (const [name, list] of buckets) if (list.length) L.push(`| ${name} | ${list.length} |`);
if (others.length) L.push(`| 未归类 | ${others.length} |`);
L.push('');

for (const [name, list] of buckets) {
  if (!list.length) continue;
  L.push(`## ${name}（${list.length}）`, '');
  L.push('| 卡片 | 一句话 | 标签 |', '| --- | --- | --- |');
  for (const c of list.sort((a, b) => a.id.localeCompare(b.id))) {
    L.push(`| [${c.title}](${rel(c.file)}) | ${c.summary || '—'} | ${c.tags.filter((t) => t !== '对话').map((t) => '#' + t).join(' ')} |`);
  }
  L.push('');
}

if (others.length) {
  L.push(`## 未归类（${others.length}）`, '');
  L.push('标题里没有命中任何板块关键词 —— 列在这里保证不漏：', '');
  for (const c of others) L.push(`- [${c.title}](${rel(c.file)})　<sub>${c.summary}</sub>`);
  L.push('');
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, L.join('\n'), 'utf8');

const vocabCount = existsSync(path.join(KB, 'vocab')) ? readdirSync(path.join(KB, 'vocab')).filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== '词汇总表.md').length : 0;
console.log(`已生成 digests/英语-知识点总表.md`);
console.log(`英语卡片 ${cards.length} 张：${[...buckets].filter(([, l]) => l.length).map(([n, l]) => `${n} ${l.length}`).join('　')}${others.length ? `　未归类 ${others.length}` : ''}`);
console.log(`单词库：vocab/ 下 ${vocabCount} 个单词`);
