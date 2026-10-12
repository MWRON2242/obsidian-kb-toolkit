#!/usr/bin/env node
/**
 * digest-math.mjs —— 汇总所有「数学」卡片，生成按知识点分组的总表
 *
 * 分类依据是**标题关键词**（机械、透明、可核对），不做语义推断：
 * 宁可落到「其他」桶里让你看见，也不猜。
 *
 * 输出：digests/数学-知识点总表.md（派生文件，可重跑覆盖）
 *
 * 用法：node tools/digest-math.mjs
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const NOTES = path.join(KB, 'notes');
const OUT = path.join(KB, 'digests', '数学-知识点总表.md');

/** 桶的定义：按顺序匹配标题，先命中先归属 */
const BUCKETS = [
  { name: '函数与导数', keys: ['函数', '导数', '求导', '单调', '极值', '最值', '最小值', '最大值', '零点', '变化率', '对勾', '解析式'] },
  { name: '三角函数', keys: ['三角', '正弦', '余弦', '正切', '诱导公式', '倾斜角', '弧度', '周期'] },
  { name: '数列', keys: ['数列', '等差', '等比', '通项', '求和', '竹九节'] },
  { name: '解析几何', keys: ['椭圆', '双曲线', '抛物线', '圆锥曲线', '轨迹', '渐近线', '直线', '距离', '圆', '方程'] },
  { name: '立体几何与向量', keys: ['向量', '异面', '空间', '立体', '夹角', '等角', '三高', '点距', '表面积', '体积'] },
  { name: '不等式', keys: ['不等式', '均值', '根号', '绝对值', '恒成立'] },
  { name: '微积分', keys: ['积分', '微积分', '微分', '极限', '弧长', '高斯', '洛必达'] },
  { name: '概率统计与计数', keys: ['概率', '统计', '期望', '方差', '排列', '组合', '二项式', '多项式'] },
  { name: '逻辑与证明', keys: ['充要', '证明', '定理', '命题', '条件'] },
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
  if (!tags.includes('数学')) continue;
  cards.push({
    id: r.id,
    file: path.basename(r.note, '.md'),
    title: meta.title || r.title,
    summary: meta.summary || '',
    conf: meta.conf || '',
    tags,
  });
}

const buckets = new Map(BUCKETS.map((b) => [b.name, []]));
const others = [];
for (const c of cards) {
  const hit = BUCKETS.find((b) => b.keys.some((k) => c.title.includes(k)));
  if (hit) buckets.get(hit.name).push(c);
  else others.push(c);
}

const L = [];
L.push('# 数学 · 知识点总表');
L.push('');
L.push('> 由 `tools/digest-math.mjs` 汇总 `notes/` 里带 `数学` 标签的卡片生成。**分类依据是标题关键词**（机械规则，可核对）。');
L.push(`> 生成时间：${new Date().toISOString().slice(0, 16).replace('T', ' ')}　｜　共 **${cards.length}** 张数学卡片`);
L.push('> 条目内容来自对话原文的逐字摘要；要读完整对话请点卡片里的「完整原文」链接。');
L.push('');
L.push('| 知识点 | 卡片数 |');
L.push('| --- | --- |');
for (const [name, list] of buckets) if (list.length) L.push(`| ${name} | ${list.length} |`);
if (others.length) L.push(`| 未归类 | ${others.length} |`);
L.push('');

for (const [name, list] of buckets) {
  if (!list.length) continue;
  L.push(`## ${name}（${list.length}）`);
  L.push('');
  L.push('| 卡片 | 一句话 | 标签 |');
  L.push('| --- | --- | --- |');
  for (const c of list.sort((a, b) => a.id.localeCompare(b.id))) {
    L.push(`| [${c.title}](${path.relative(path.join(KB, 'digests'), path.join(NOTES, c.file + '.md')).split(path.sep).join('/')}) | ${c.summary || '—'} | ${c.tags.filter((t) => t !== '对话').map((t) => '#' + t).join(' ')} |`);
  }
  L.push('');
}

if (others.length) {
  L.push(`## 未归类（${others.length}）`);
  L.push('');
  L.push('标题里没有命中任何知识点关键词 —— 不是内容有问题，只是这几种标题看不出归类（列在这里保证不漏）：');
  L.push('');
  for (const c of others) L.push(`- [${c.title}](${path.relative(path.join(KB, 'digests'), path.join(NOTES, c.file + '.md')).split(path.sep).join('/')})　<sub>${c.summary}</sub>`);
  L.push('');
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, L.join('\n'), 'utf8');

console.log(`已生成 digests/数学-知识点总表.md`);
console.log(`数学卡片 ${cards.length} 张：${[...buckets].filter(([, l]) => l.length).map(([n, l]) => `${n} ${l.length}`).join('　')}${others.length ? `　未归类 ${others.length}` : ''}`);
