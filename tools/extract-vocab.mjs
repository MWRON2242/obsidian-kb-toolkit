#!/usr/bin/env node
/**
 * extract-vocab.mjs —— 从对话原文里「搬运」英语单词、释义与例句，做成可检索的单词库
 *
 * 与 materials/ 同样的原则：**只搬运、不改写**。释义与例句原样照抄，脚本只做切分与标注。
 *
 * 范围：默认只扫「卡片带指定标签（默认 英语）」的对话文件 —— 否则像 `intro → 主歌1`
 * 这类箭头行会被误当成词条（这正是加 `→` 分隔符后踩到的坑）。
 *
 * 识别的写法（实测）：
 *   - **automated** — 自动化的          粗体词 + 破折号
 *   - *soil doctors* — 土壤医生          斜体词
 *   **patient** (形容词) → 耐心的        箭头分隔 + 词性标注
 *   common - 普遍的                     纯文本行
 *   | automated | 自动化的 |             表格行
 *   **curious** 的中文翻译为：            词在上一行、释义在下一行
 *   - *She was sympathetic to my situation.* — 她对我处境表示理解。    → 归为该词的例句
 *
 * 产物（派生层，可重跑覆盖）：
 *   vocab/<word>.md     一个单词一个笔记（多释义 + 例句 + 全部出处）
 *   vocab/词汇总表.md    按首字母分组的人读索引
 *   vocab/_抽取报告.md   收录口径 + 未识别候选行（保证漏得可见）
 *   词汇库.base          Obsidian Bases 视图
 *
 * 用法：
 *   node tools/extract-vocab.mjs                 # 只扫带 #英语 标签的对话
 *   node tools/extract-vocab.mjs --tag=英语
 *   node tools/extract-vocab.mjs --all-chats     # 扫全部对话（噪声大，仅调试用）
 *   node tools/extract-vocab.mjs --check
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const CHATS = path.join(KB, 'chats');
const OUT = path.join(KB, 'vocab');
const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const ALL_CHATS = argv.includes('--all-chats');
const TAG = (argv.find((a) => a.startsWith('--tag=')) || '--tag=英语').split('=')[1];

const CJK = /[\u3400-\u9fff]/;
const EN_WORD = /^[A-Za-z][A-Za-z0-9'’.\- "?!]{0,59}$/;
const SEP = '[-—–:：→=]';

const clean = (w) =>
  w
    .replace(/^[A-Da-d]\s*[.、)）]\s*/, '') // 选择题选项字母 B. diagnose → diagnose
    .replace(/^[-*·•]\s*/, '')
    .replace(/[.,;:]+$/, '')
    .trim();
const isWord = (w) => EN_WORD.test(w) && w.length >= 2 && w.split(/\s+/).length <= 5;
/** 判定为"例句"而不是词条：含多个单词且以句末标点结尾 */
const isSentence = (s) => /\s/.test(s.trim()) && /[.?!]$/.test(s.trim()) && s.trim().split(/\s+/).length >= 3;

/* ---------- 决定扫哪些对话 ---------- */
const records = readFileSync(path.join(KB, 'index', 'catalog.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const eligible = new Set();
if (!ALL_CHATS) {
  for (const r of records) {
    if (r.root !== 'chats' || !r.note) continue;
    const p = path.join(KB, r.note);
    if (!existsSync(p)) continue;
    const m = /^tags:\s*\[(.*)\]\s*$/m.exec(readFileSync(p, 'utf8'));
    const tags = m ? m[1].split(',').map((s) => s.trim()) : [];
    if (tags.includes(TAG)) eligible.add(path.basename(r.source));
  }
}
const allFiles = existsSync(CHATS) ? readdirSync(CHATS).filter((f) => f.endsWith('.md')) : [];
const chatFiles = ALL_CHATS ? allFiles : allFiles.filter((f) => eligible.has(f));
if (!ALL_CHATS && !chatFiles.length) {
  console.error(`没有找到带 #${TAG} 标签的对话卡片。先建卡，或用 --all-chats。`);
  process.exit(1);
}
// inbox/（手工录入的照片笔记等）总是扫描：那是用户自己的原始材料
const INBOX = path.join(KB, 'inbox');
const inboxFiles = existsSync(INBOX) ? readdirSync(INBOX).filter((f) => f.endsWith('.md') && !f.startsWith('_')) : [];
const scanList = [
  ...chatFiles.map((f) => ({ abs: path.join(CHATS, f), rel: `chats/${f}`, isInbox: false })),
  ...inboxFiles.map((f) => ({ abs: path.join(INBOX, f), rel: `inbox/${f}`, isInbox: true })),
];

/* ---------- 逐文件解析 ---------- */
const entries = [];
const examples = [];
const rejected = [];
const stats = { lines: 0, files: scanList.length };

for (const src of scanList) {
  const f = path.basename(src.abs);
  const chatFile = src.rel;
  const chat = path.basename(f, '.md');
  const lines = readFileSync(src.abs, 'utf8').split(/\r?\n/);
  let inAnswer = src.isInbox; // inbox 文件没有「提问/回答」结构，整篇都当正文
  let inDetails = false;
  let inFrontMatter = src.isInbox; // inbox 文件要先跳过 front matter
  let round = 0;
  let pending = null; // 上一行是「**word** 的中文翻译为：」→ 释义在下面几行
  let lastWord = null; // 用于把例句挂到最近的词上

  lines.forEach((text, i) => {
    const n = i + 1;
    if (inFrontMatter) {
      if (i > 0 && /^---\s*$/.test(text)) inFrontMatter = false;
      return;
    }
    if (/^\s*<details/.test(text)) inDetails = true;
    if (/^\s*<\/details>/.test(text)) inDetails = false;
    if (inDetails) return;
    if (/^## 🤖 回答/.test(text)) {
      inAnswer = true;
      round++;
      return;
    }
    if (/^## 👤 提问/.test(text)) {
      inAnswer = false;
      return;
    }
    if (!inAnswer) return;
    const t = text.trim();
    if (!t) return;
    stats.lines++;

    // 0) 照片笔记写法（只对 inbox/ 生效，且**必须先试**）：`English phrase 中文`
    //     必须放在前面，否则 `short-term goal 短期目标` 会被下一条"分隔符"规则切成 `short`。
    if (src.isInbox) {
      const notes = [...t.matchAll(/[\[【]([^\]】]*)[\]】]/g)].map((x) => x[1].trim()).filter(Boolean);
      const bare = t.replace(/[\[【][^\]】]*[\]】]/g, ' ').replace(/\s+/g, ' ').trim();
      const cut = bare.search(/[\u3400-\u9fff]/);
      if (cut > 1) {
        const w = clean(bare.slice(0, cut));
        const meaning = bare.slice(cut).trim();
        // 英文部分不能以分隔符/连接符结尾（那说明本行其实是 `word - 释义` 格式）
        const endsWithSep = /[-—–:：→=*`]$/.test(w);
        // 照片笔记里常有整句（如 all flowers were in full bloom），这里放宽到 10 个单词
        if (!endsWithSep && EN_WORD.test(w) && w.length >= 2 && w.split(/\s+/).length <= 10 && CJK.test(meaning) && meaning.length <= 60) {
          entries.push({ word: w, pos: '', meaning, note: notes.join('；'), chat, chatFile, round: round || 1, line: n });
          lastWord = w;
          return;
        }
      }
    }

    // 1) 「**word** 的中文翻译为：」→ 接下来几行是释义
    const head = new RegExp(`^\\*\\*([^*]{1,40})\\*\\*\\s*(?:的)?(?:中文)?(?:翻译|意思|释义|含义)为?\\s*[:：]?\\s*$`).exec(t);
    if (head) {
      const w = clean(head[1]);
      if (isWord(w)) {
        pending = { word: w, chat, chatFile, round, line: n };
        lastWord = w;
        return;
      }
    }
    if (pending) {
      const m = t.replace(/^[-*]\s*/, '').replace(/\*\*/g, '').trim();
      if (m && CJK.test(m) && m.length <= 60) {
        entries.push({ word: pending.word, meaning: m, chat, chatFile, round, line: n });
        pending = null;
        return;
      }
      pending = null; // 下一行不像释义 → 放弃这条
    }

    // 2) 粗体 / 斜体 / 纯文本 词 + 分隔符 + 释义
    let m;
    if ((m = new RegExp(`^(?:[-*]\\s*)?(?:\\*\\*([^*]{1,40})\\*\\*|\\*([^*]{1,40})\\*)\\s*(?:\\(([^)]{1,20})\\))?\\s*${SEP}\\s*(.+)$`).exec(t))) {
      const raw = (m[1] || m[2] || '').trim();
      const pos = (m[3] || '').trim();
      const meaning = m[4].trim();
      if (isSentence(raw)) {
        if (lastWord) examples.push({ word: lastWord, text: raw, chat, chatFile, round, line: n });
        return; // 例句已归位，不要再往下走（否则会重复计进"未识别"清单）
      } else {
        const w = clean(raw);
        if (isWord(w) && CJK.test(meaning)) {
          entries.push({ word: w, pos, meaning, chat, chatFile, round, line: n });
          lastWord = w;
          return;
        }
      }
    }
    // 2b) 句子里嵌着粗体词：`- There is a **possibility** of rain. — 有下雨的可能性。`
    if ((m = new RegExp(`^(?:[-*]\\s*)?(.*\\*\\*([^*]{1,40})\\*\\*.*?)\\s*${SEP}\\s*(.+)$`).exec(t))) {
      const w = clean(m[2]);
      if (isWord(w)) {
        examples.push({ word: w, text: m[1].trim(), chat, chatFile, round, line: n });
        lastWord = w;
        return;
      }
    }
    // 3) 表格行
    if ((m = new RegExp(`^\\|\\s*([A-Za-z][A-Za-z'’.\\- ]{0,39})\\s*\\|\\s*([^|]*[\\u3400-\\u9fff][^|]*)\\|`).exec(t))) {
      const w = clean(m[1]);
      if (isWord(w)) {
        entries.push({ word: w, pos: '', meaning: m[2].trim(), chat, chatFile, round, line: n });
        lastWord = w;
        return;
      }
    }
    // 4) 纯文本行（允许列表前缀，如 `- A. potentially → 可能地`）
    if ((m = new RegExp(`^(?:[-*]\\s*)?([A-Za-z][A-Za-z'’.\\- ]{0,39})\\s*${SEP}\\s*([^:：]{1,80})$`).exec(t))) {
      const w = clean(m[1]);
      if (isWord(w) && CJK.test(m[2])) {
        entries.push({ word: w, pos: '', meaning: m[2].trim(), chat, chatFile, round, line: n });
        lastWord = w;
        return;
      }
    }
    // 5) 没识别：形似词条才进报告（收紧判据，避免公式刷屏）
    if (
      new RegExp(SEP).test(t) &&
      CJK.test(t) &&
      !/\\|\^|_\{|\\frac|\\sum|≈|≥|≤/.test(t) &&
      /^[-*|]?\s*\*{0,2}[A-Za-z]{2,}/.test(t) &&
      t.length < 120
    ) {
      rejected.push(`${chatFile} L${n}　${t.slice(0, 100)}`);
    }
  });
}

/* ---------- 归并 ---------- */
const byWord = new Map();
for (const e of entries) {
  const key = e.word.toLowerCase();
  if (!byWord.has(key)) byWord.set(key, { word: e.word, items: [], examples: [] });
  const g = byWord.get(key);
  if (!g.items.some((x) => x.meaning === e.meaning)) g.items.push(e);
}
for (const x of examples) {
  const g = byWord.get(x.word.toLowerCase());
  if (g && !g.examples.some((y) => y.text === x.text)) g.examples.push(x);
}

if (!CHECK && existsSync(OUT)) for (const f of readdirSync(OUT)) if (f.endsWith('.md')) rmSync(path.join(OUT, f));
if (!CHECK) mkdirSync(OUT, { recursive: true });

const written = [];
for (const [key, g] of byWord) {
  const slug = key.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '_').slice(0, 60);
  const meanings = g.items.map((x) => x.meaning);
  const md = [
    '---',
    'kb_vocab: true',
    `word: ${g.word}`,
    `meaning_count: ${meanings.length}`,
    `meanings: ${meanings.join(' / ')}`,
    `sources: ${g.items.length}`,
    `tags: [英语, 单词]`,
    '---',
    '',
    `# ${g.word}`,
    '',
    `> 📚 由 \`tools/extract-vocab.mjs\` 从对话原文 / 手工录入笔记**逐字搬运**（释义与批注未改写）；${g.items.length} 处出处、${meanings.length} 个释义${g.examples.length ? `、${g.examples.length} 条例句` : ''}。`,
    '',
    '## 释义',
    '',
    '| 释义 | 词性 | 原文批注 | 出处 |',
    '| --- | --- | --- | --- |',
    ...g.items.map(
      (x) =>
        `| ${x.meaning} | ${x.pos || '—'} | ${x.note || '—'} | [[${x.chatFile.replace(/\.md$/, '')}\\|${x.chat}]] 第 ${x.round} 轮 · L${x.line} |`,
    ),
    '',
  ];
  if (g.examples.length) {
    md.push('## 例句（原文）', '');
    for (const x of g.examples) md.push(`- *${x.text}*　——　[[${x.chatFile.replace(/\.md$/, '')}\\|${x.chat}]] 第 ${x.round} 轮 · L${x.line}`);
    md.push('');
  }
  written.push({ key, word: g.word, count: g.items.length, examples: g.examples.length, file: `vocab/${slug}.md` });
  if (!CHECK) writeFileSync(path.join(OUT, `${slug}.md`), md.join('\n'), 'utf8');
}

/* ---------- 总表 ---------- */
const byLetter = new Map();
for (const w of written) {
  const L = /^[a-z]/i.test(w.word) ? w.word[0].toUpperCase() : '#';
  if (!byLetter.has(L)) byLetter.set(L, []);
  byLetter.get(L).push(w);
}
const T = [
  '# 英语单词总表',
  '',
  '> 由 `tools/extract-vocab.mjs` 从对话原文搬运生成。**释义原样照抄，未经改写**；每个单词一个笔记，点开可看全部释义、词性与例句。',
  `> 生成时间：${new Date().toISOString().slice(0, 16).replace('T', ' ')}　｜　收录 **${written.length}** 个单词 / ${entries.length} 条释义记录 / ${examples.length} 条例句`,
  `> 来源：带 \`#${TAG}\` 标签的 ${chatFiles.length} 个对话 + ${inboxFiles.length} 个手工录入笔记`,
  '',
  '**怎么用**：左侧打开 `vocab/` 逐词看；或打开 `词汇库.base` 按释义/来源筛选。',
  '',
];
for (const [L, list] of [...byLetter].sort()) {
  T.push(`## ${L}（${list.length}）`, '');
  for (const w of list.sort((a, b) => a.key.localeCompare(b.key))) {
    T.push(`- [[${w.file.replace(/^vocab\//, '').replace(/\.md$/, '')}|${w.word}]]${w.count > 1 ? `　<sub>×${w.count}</sub>` : ''}`);
  }
  T.push('');
}
if (!CHECK) writeFileSync(path.join(OUT, '词汇总表.md'), T.join('\n'), 'utf8');

/* ---------- 报告 ---------- */
const R = [
  '# 单词抽取报告',
  '',
  `- 扫描范围：${ALL_CHATS ? '全部对话' : `带 #${TAG} 标签的对话`} ${chatFiles.length} 个 + 手工录入(inbox/) ${inboxFiles.length} 个 = ${scanList.length} 个文件`,
  `- AI 回答内候选行：${stats.lines} 行`,
  `- 识别词条：${entries.length} 条 → 归并 **${written.length} 个单词**；另收例句 ${examples.length} 条`,
  `- 未识别但形似词条：${rejected.length} 行（下面逐条列出，供人工确认是否漏收）`,
  '',
  '## 识别规则',
  '',
  '| 写法 | 例子 |',
  '| --- | --- |',
  '| 粗体词 + 分隔符 | `- **automated** — 自动化的` |',
  '| 斜体词 + 分隔符 | `- *soil doctors* — 土壤医生` |',
  '| 词 + 词性 + 箭头 | `**patient** (形容词) → 耐心的` |',
  '| 词在上一行 | `**curious** 的中文翻译为：` ↓ 释义 |',
  '| 纯文本行 | `common - 普遍的` |',
  '| 表格行 | `\\| automated \\| 自动化的 \\|` |',
  '| 分隔符集合 | `-` `—` `–` `:` `：` `→` `=` |',
  '',
  '例句行（多词且以 `.?!` 结尾）**不会**被当成词条，而是挂到最近一个词下面。',
  '只从 AI 回答取，跳过提问与折叠的思考块。',
  '',
];
if (rejected.length) {
  R.push('## 未识别但形似词条的行', '');
  for (const r of rejected.slice(0, 300)) R.push(`- ${r}`);
  if (rejected.length > 300) R.push(`- …另有 ${rejected.length - 300} 行`);
  R.push('');
}
if (!CHECK) writeFileSync(path.join(OUT, '_单词抽取报告.md'), R.join('\n'), 'utf8');

/* ---------- Bases ---------- */
if (!CHECK) {
  writeFileSync(
    path.join(KB, '词汇库.base'),
    [
      '# Obsidian Bases 视图（1.9+ 自带）。列名报错时用 Bases 界面点选调整即可。',
      'filters:',
      '  and:',
      '    - file.inFolder("vocab")',
      'views:',
      '  - type: table',
      '    name: 全部单词',
      '    order:',
      '      - word',
      '      - meanings',
      '      - meaning_count',
      '      - sources',
      '  - type: table',
      '    name: 多义词（≥2 个释义）',
      '    filters:',
      '      and:',
      '        - meaning_count > 1',
      '    order:',
      '      - word',
      '      - meanings',
      '      - sources',
      '  - type: cards',
      '    name: 单词卡片墙',
      '    order:',
      '      - word',
      '      - meanings',
      '',
    ].join('\n'),
    'utf8',
  );
}

console.log(`扫描 ${scanList.length} 个文件（对话 ${chatFiles.length} 个 + 手工录入 ${inboxFiles.length} 个），${stats.lines} 行正文`);
console.log(`识别词条 ${entries.length} 条 → 归并 ${written.length} 个单词；例句 ${examples.length} 条`);
console.log(`未识别但形似词条：${rejected.length} 行（见 _抽取报告.md）`);
if (!CHECK) console.log(`已写入 vocab/（${written.length} 个单词笔记 + 词汇总表.md + _抽取报告.md）与 词汇库.base`);
