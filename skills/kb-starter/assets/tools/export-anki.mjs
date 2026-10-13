#!/usr/bin/env node
/**
 * export-anki.mjs —— 把 vocab/ 的词条导出成 Anki 可直接导入的 TSV + 首背卡模板
 *
 * 为什么不用 .apkg：生成 .apkg 需要手写 SQLite（+ zstd）文件格式，投入大且易碎。
 * Anki 的「文件 → 导入」对 TSV 支持极好，配合一次性的卡片模板就能得到
 * 百词斩式的首背流程：①认词 ②四选一 ③拼写。
 *
 * 产物（默认 digests/anki/）：
 *   照片笔记-首背卡.tsv     6 列：Word / Meaning / Choices / Note / Source / Tags
 *   照片笔记-基本卡.tsv     2 列：英文 / 中文（用 Anki 内置 Basic 一分钟起步）
 *   Anki-首背卡模板.md      字段定义 + 三段可复制的卡片模板（含四选一 JS、拼写输入）
 *
 * 用法：
 *   node tools/export-anki.mjs                          # 照片笔记（47 条）
 *   node tools/export-anki.mjs --scope=all              # 全部词条
 *   node tools/export-anki.mjs --scope=英语短语笔记-第一张图
 *   node tools/export-anki.mjs --out=digests/anki --check
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
// 卡片模板的单一来源（同时供 anki-api.mjs 建笔记类型用），避免文档与 API 两处漂移
import { FIELDS, CSS, CARDS } from './lib-anki-templates.mjs';

const KB = path.resolve(import.meta.dirname, '..');
const VOCAB = path.join(KB, 'vocab');
const argv = process.argv.slice(2);
const opt = (n, d = '') => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const SCOPE = opt('scope', '照片笔记');
const OUT = path.join(KB, opt('out', 'digests/anki'));
const CHECK = argv.includes('--check');

/* ---------- 读词条 ---------- */
const fm = (t) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(t);
  const o = {};
  if (!m) return o;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) o[kv[1]] = kv[2].trim();
  }
  return o;
};
const rows = (t) =>
  t
    .split(/\r?\n/)
    .map((l) => /^\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|\s*(.+?)\s*\|\s*$/.exec(l))
    .filter((m) => m && m[1] !== '释义' && !/^-+$/.test(m[1]))
    .map((m) => ({ meaning: m[1], note: m[3], source: m[4] }));

const all = [];
for (const f of readdirSync(VOCAB).filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== '词汇总表.md')) {
  const t = readFileSync(path.join(VOCAB, f), 'utf8');
  const meta = fm(t);
  if (!meta.word) continue;
  const rs = rows(t);
  const sources = [...new Set(rs.map((r) => r.source.replace(/\[\[|\]\]/g, '').split('|')[0].replace(/\\+$/, '').trim()).filter(Boolean))];
  all.push({
    word: meta.word,
    meaning: meta.meanings || rs.map((r) => r.meaning).join(' / '),
    notes: [...new Set(rs.map((r) => r.note).filter((n) => n && n !== '—'))],
    source: sources[0] || '',
    isPhoto: sources.some((s) => s.includes('英语短语笔记')),
  });
}

const pick =
  SCOPE === 'all' ? all : SCOPE === '照片笔记' ? all.filter((w) => w.isPhoto) : all.filter((w) => w.source.includes(SCOPE));
pick.sort((a, b) => a.word.toLowerCase().localeCompare(b.word.toLowerCase()));
if (!pick.length) {
  console.error(`没有匹配的词条（--scope=${SCOPE}）`);
  process.exit(1);
}

/* ---------- 字段清洗：TSV 里不能有制表符/换行 ---------- */
const cell = (s) => String(s || '').replace(/\t/g, ' ').replace(/\r?\n/g, '<br>').replace(/\|/g, '/').trim();
const plain = (s) => String(s || '').replace(/\t/g, ' ').replace(/\r?\n/g, ' ').trim();

/* ---------- 干扰项：从同一批词里取，用词做种子保证每次导出结果一致 ---------- */
const seedOf = (s) => {
  let h = 2166136261;
  for (const ch of s) h = (h ^ ch.codePointAt(0)) >>> 0, (h = Math.imul(h, 16777619) >>> 0);
  return h;
};
const lcg = (seed) => () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
function choicesFor(w, pool) {
  const others = [...new Set(pool.filter((x) => x.word !== w.word && x.meaning !== w.meaning).map((x) => x.meaning))];
  const rnd = lcg(seedOf(w.word));
  const picked = [];
  while (picked.length < 3 && others.length) {
    const i = Math.floor(rnd() * others.length);
    picked.push(others.splice(i, 1)[0]);
  }
  const opts = [w.meaning, ...picked];
  // 用同一个种子打乱顺序，把正确项标记出来
  for (let i = opts.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [opts[i], opts[j]] = [opts[j], opts[i]];
  }
  return opts.map((o) => (o === w.meaning ? `${cell(o)}*` : cell(o))).join('|');
}

/* ---------- 产出 ---------- */
const base = SCOPE === 'all' ? '英语词汇-全部' : SCOPE === '照片笔记' ? '照片笔记' : SCOPE;
const tsv6 = [];
tsv6.push(['Word', 'Meaning', 'Choices', 'Note', 'Source', 'Tags'].join('\t'));
for (const w of pick) {
  tsv6.push(
    [
      plain(w.word),
      plain(w.meaning),
      choicesFor(w, pick),
      plain(w.notes.join('；') || ''),
      plain(w.source.replace('inbox/', '').replace('chats/', '')),
      `英语::首背::${w.isPhoto ? '照片笔记' : '对话导出'}`,
    ].join('\t'),
  );
}
const tsv2 = [['英文', '中文'].join('\t'), ...pick.map((w) => [plain(w.word), plain(w.meaning)].join('\t'))];

const template = `# Anki 首背卡 · 模板与导入步骤

> 由 \`tools/export-anki.mjs\` 生成。数据源头是 \`vocab/\`（从你的对话原文与照片笔记**逐字搬运**来的词条）。

## 一、字段（Note Type 的 6 个字段，顺序一致）

\`\`\`
Word     英文（如 under no circumstances）
Meaning  中文释义
Choices  四选一的选项，用 | 分隔，正确项末尾带 *（如 任何情况下不*|在意|理解|适应）
Note     原文批注（红笔更正等），可能为空
Source   出处
Tags     标签（英语::首背::照片笔记）
\`\`\`

## 二、建 Note Type（一次性，约 3 分钟）

1. Anki → 工具 → **管理笔记类型** → 添加 → 选「**克隆: 基础**」或「添加: 基础」
2. 名称改为 **词汇首背**
3. 点「**字段**」，删掉多余的，留下并新增成上面 6 个（**拼写要区分大小写**：Word / Meaning / Choices / Note / Source / Tags）
4. 点「**卡片**」，会看到「卡片 1」；点右侧「**选项 → 添加卡片类型**」两次，共得到 3 张卡
5. 依次把下面三段分别粘进 卡片 1 / 2 / 3 的正面与背面，样式（CSS）贴一次即可

## 三、卡片 1：认词（英 → 中）

**正面**
\`\`\`html
${CARDS[0].front}
\`\`\`

**背面**
\`\`\`html
${CARDS[0].back}
\`\`\`

## 四、卡片 2：四选一（选出正确释义）

**正面**
\`\`\`html
${CARDS[1].front}
\`\`\`

**背面**
\`\`\`html
${CARDS[1].back}
\`\`\`

## 五、卡片 3：拼写（看中文，拼出英文）

**正面**
\`\`\`html
${CARDS[2].front}
\`\`\`

**背面**
\`\`\`html
${CARDS[2].back}
\`\`\`

> 想要卡片 1/2 自动发音：正面加一行 \`{{tts en_US:Word}}\`（需要 Anki 2.1.50+，且系统装了英语语音）。
> 想改发音口音：把 \`en_US\` 换成 \`en_GB\`。

## 六、样式（CSS，三张卡共用，贴一次）

\`\`\`css
${CSS}
\`\`\`

## 七、导入你的词表

1. Anki → 文件 → **导入**
2. 选 \`${base}-首背卡.tsv\`
3. 字段分隔符选 **Tab**；勾选「**允许在字段中使用 HTML**」
4. 「笔记类型」选刚建的 **词汇首背**
5. 字段映射确认：Word→Word、Meaning→Meaning、Choices→Choices、Note→Note、Source→Source、Tags→Tags
6. 导入 → 卡组里会出现 3 张卡/词（认词 / 四选一 / 拼写）

> **一分钟起步法**：不想建卡片类型就先导入 \`${base}-基本卡.tsv\`（2 列，用内置 Basic），先背起来，之后再换成上面这套。

## 八、手机端

安装 **AnkiDroid**（Android，免费）或 **AnkiMobile**（iOS，付费）→ 登录同一个 AnkiWeb 账号同步，或导出 .apkg 传过去。
新卡的学习间隔在 Anki 里可调（**工具 → 首选项 → 复习 → 学习步骤**，例如 \`1m 10m\`），这就是"第一次专注背诵"的节奏。
`;

if (!CHECK) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, `${base}-首背卡.tsv`), tsv6.join('\n') + '\n', 'utf8');
  writeFileSync(path.join(OUT, `${base}-基本卡.tsv`), tsv2.join('\n') + '\n', 'utf8');
  writeFileSync(path.join(OUT, 'Anki-首背卡模板.md'), template, 'utf8');
}

console.log(`${CHECK ? '[check] ' : ''}范围：${SCOPE}　词条：${pick.length} 条`);
console.log(`  首背卡 TSV：${pick.length} 行 × 6 列（含四选一选项）`);
console.log(`  基本卡 TSV：${pick.length} 行 × 2 列`);
if (!CHECK) {
  console.log(`  产物目录：${path.relative(KB, OUT)}/`);
  for (const f of readdirSync(OUT)) console.log(`    ${f}`);
}
