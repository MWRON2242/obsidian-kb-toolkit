#!/usr/bin/env node
/**
 * obsidian-sync.mjs —— 让知识库在 Obsidian 里「开箱可用」
 *
 * 做四件事（全部幂等，可反复运行）：
 *   1. 给每张摘要卡补 `aliases: [kb-XXXX]`，这样卡片里的 [[kb-0015]] 能被 Obsidian 解析；
 *   2. 把 cache/text/*.txt 导出成 fulltext/*.md —— Obsidian 的搜索只索引 Markdown，
 *      没有这一步就搜不到正文（正文缓存在这里变成「可搜索的派生层」）；
 *   3. 生成 首页.md 仪表盘（统计、标签入口、按组清单、needs-ocr 与待补卡）；
 *   4. 首次运行时写入 .obsidian/app.json（排除 cache/ 与 tools/）与 知识库.base（Bases 视图）。
 *
 * 绝不改动原件；不改 catalog（那是 scan/link-notes 的职责）。
 *
 * 用法：
 *   node tools/obsidian-sync.mjs
 *   node tools/obsidian-sync.mjs --no-fulltext   # 不导出全文层（省空间/保持 vault 干净）
 */
import { readFile, writeFile, readdir, mkdir, stat, rm } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const CATALOG = path.join(KB, 'index', 'catalog.jsonl');
const NOTES = path.join(KB, 'notes');
const TEXT = path.join(KB, 'cache', 'text');
const FULLTEXT = path.join(KB, 'fulltext');
const NO_FULLTEXT = process.argv.includes('--no-fulltext');

const records = (await readFile(CATALOG, 'utf8'))
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const noteFiles = existsSync(NOTES) ? (await readdir(NOTES)).filter((f) => f.endsWith('.md')) : [];
const noteById = new Map(noteFiles.map((f) => [f.split('-').slice(0, 2).join('-'), f]));

/* ---------- 1. 补 aliases ---------- */
let aliasAdded = 0;
for (const f of noteFiles) {
  const full = path.join(NOTES, f);
  const text = await readFile(full, 'utf8');
  const id = f.split('-').slice(0, 2).join('-');
  if (/^aliases:/m.test(text.split('---')[1] || '')) continue;
  const m = /^---\r?\n/.exec(text);
  if (!m) continue;
  // 插在 status 行之前，保持 front matter 结构稳定
  const withAlias = text.replace(/^(status:.*)$/m, `aliases:\n  - ${id}\n$1`);
  if (withAlias !== text) {
    await writeFile(full, withAlias, 'utf8');
    aliasAdded++;
  }
}

/* ---------- 2. 导出全文层 ---------- */
let exported = 0;
if (!NO_FULLTEXT) {
  await mkdir(FULLTEXT, { recursive: true });
  // 全文层是可再生的派生数据：先清空，避免改名后留下孤儿文件
  for (const old of await readdir(FULLTEXT)) {
    if (old.endsWith('.md')) await rm(path.join(FULLTEXT, old), { force: true });
  }
  for (const r of records) {
    if (!r.text || r.status === 'needs-ocr') continue;
    const src = path.join(KB, r.text);
    if (!existsSync(src)) continue;
    const card = noteById.get(r.id);
    // 注意：必须与 notes/ 下的卡片文件名区分开，否则 Obsidian 里会出现同名文件、
    // wikilink 无法唯一解析。统一加「-全文」后缀。
    const base = card ? card.replace(/\.md$/, '') : r.id;
    const body = await readFile(src, 'utf8');
    const head = [
      '---',
      `kb_fulltext: ${r.id}`,
      '---',
      '',
      `> ⚠️ **派生副本**，由 \`tools/obsidian-sync.mjs\` 从原件抽取生成，**只用于 Obsidian 全文检索**。`,
      `> 摘要卡：${card ? `[[${card.replace(/\.md$/, '')}]]` : '（尚未建立）'}`,
      `> 权威版本（原件，勿改）：\`${r.source}\``,
      `> 不要在本文件里编辑；改动请回原件，然后重跑 \`node tools/obsidian-sync.mjs\`。`,
      '',
      '---',
      '',
    ].join('\n');
    await writeFile(path.join(FULLTEXT, `${base}-全文.md`), head + body, 'utf8');
    exported++;
  }
}

/* ---------- 3. 仪表盘 ---------- */
const byTag = {};
for (const r of records) for (const t of r.tags || []) (byTag[t] = byTag[t] || []).push(r);

const noted = records.filter((r) => r.note);
const noNote = records.filter((r) => !r.note && r.status !== 'needs-ocr');
const needsOcr = records.filter((r) => r.status === 'needs-ocr');

const groups = new Map();
for (const r of noted) {
  const key = r.label || r.root || '未分组';
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(r);
}

const dash = [];
dash.push('# 📚 知识库首页');
dash.push('');
dash.push(`共 **${records.length}** 条登记 ｜ **${noted.length}** 张摘要卡 ｜ **${noNote.length}** 条待补 ｜ **${needsOcr.length}** 条待 OCR`);
dash.push('');
dash.push('> 用法见 [[README]]。**原件永不被修改**，检索与引用见 [[AGENTS]]。');
dash.push('');
dash.push('## 快速入口');
dash.push('');
dash.push('- 🗂 全库总表：[[INDEX|知识库总索引]]');
dash.push(`- 🔍 正文全文检索：按 \`Ctrl+Shift+F\` 搜 \`fulltext/\` 目录${NO_FULLTEXT ? '（本次未导出全文层）' : ''}`);
dash.push('- 🏷 标签浏览：左侧「标签」面板，或点下面的标签');
dash.push('- 📤 成品与改写：`digests/`');
const DIGEST_DIR = path.join(KB, 'digests');
const ATTACH_EXT = new Set(['.docx', '.xlsx', '.pptx', '.pdf', '.csv']);
if (existsSync(DIGEST_DIR)) {
  const entries = (await readdir(DIGEST_DIR)).sort();
  for (const d of entries.filter((f) => f.endsWith('.md') && f !== '成品说明.md')) {
    dash.push(`- 📘 汇总表：[[${d.replace(/\.md$/, '')}]]`);
  }
  // 非 md 的成品（Word / Excel / PDF）也挂上，否则它们在库里是"孤岛"
  const docs = entries.filter((f) => ATTACH_EXT.has(path.extname(f).toLowerCase()));
  if (docs.length) {
    dash.push('');
    dash.push('**成品文档（Word / 表格）**');
    dash.push('');
    for (const d of docs) {
      const label = d.replace(/\.[^.]+$/, '');
      dash.push(`- 📄 [[${d}|${label}]]`);
    }
  }
}
dash.push('');
dash.push('## 标签入口');
dash.push('');
for (const [t, rs] of Object.entries(byTag).sort((a, b) => b[1].length - a[1].length)) {
  dash.push(`- #${t} （${rs.length}）`);
}
dash.push('');
dash.push('## 已建卡的文件');
dash.push('');
for (const [g, rs] of groups) {
  dash.push(`### ${g}（${rs.length}）`);
  dash.push('');
  for (const r of rs.sort((a, b) => a.id.localeCompare(b.id))) {
    const card = r.note.replace(/^notes\//, '').replace(/\.md$/, '');
    dash.push(`- [[${card}|${r.title}]]　\`${r.id}\`　${(r.tags || []).map((t) => '#' + t).join(' ')}`);
  }
  dash.push('');
}
if (needsOcr.length) {
  dash.push('## ⚠️ 待 OCR（抽取文本不可用）');
  dash.push('');
  for (const r of needsOcr) {
    // 没有摘要卡时不要生成 wikilink，避免留下悬空链接
    const label = r.note ? `[[${r.note.replace(/^notes\//, '').replace(/\.md$/, '')}|${r.title}]]` : r.title;
    dash.push(`- ${label}　\`${r.id}\`　\`${r.source}\``);
  }
  dash.push('');
}

/* 复习层（review/，Spaced Repetition 卡片；进度写回卡片行，只增不改） */
const REV = path.join(KB, 'review');
if (existsSync(REV)) {
  const list = (await readdir(REV)).filter((f) => f.endsWith('.md'));
  const cardFile = list.find((f) => f === '英语词汇.md');
  if (cardFile) {
    const t = await readFile(path.join(REV, cardFile), 'utf8');
    const nCards = (t.match(/:::/g) || []).length;
    const nDone = (t.match(/<!--SR:/g) || []).length;
    dash.push('## 🎴 背单词（Spaced Repetition）');
    dash.push('');
    dash.push(
      `插件已装在 vault 内（\`.obsidian/plugins/obsidian-spaced-repetition\`）。**${nCards}** 张英语词汇卡（双向：英↔中），已产生复习记录 **${nDone}** 条。`,
    );
    dash.push('');
    dash.push('- 🚀 开始复习：`Ctrl+P` → `Spaced Repetition: Review flashcards from all notes`');
    dash.push(`- 📇 卡片文件：[[${cardFile.replace(/\.md$/, '')}]]（按首字母分 22 节）`);
    dash.push('- 📑 出处索引：[[英语词汇-出处索引]]（单词 → 释义 → 原文批注 → 出处 → 词条笔记）');
    dash.push('- ➕ 新增词汇：录入 → `extract-vocab.mjs` → `make-review-cards.mjs`（**只增不改**，不碰复习进度）');
    if (nDone === 0) {
      dash.push('');
      dash.push('> 还没启用插件？设置 → 第三方插件 → 关闭「受限模式」→ 启用 **Spaced Repetition**。');
    }
    dash.push('');
  }
}

/* 素材库（materials/，逐字搬运自对话原文） */
const MAT = path.join(KB, 'materials');
if (existsSync(MAT)) {
  const files = (await readdir(MAT)).filter((f) => f.endsWith('.md') && !f.startsWith('_') && f !== '素材库总表.md');
  let n素材 = 0;
  let n范文 = 0;
  for (const f of files) {
    const t = await readFile(path.join(MAT, f), 'utf8');
    if (/^kind: 素材$/m.test(t)) n素材++;
    else if (/^kind: 范文$/m.test(t)) n范文++;
  }
  dash.push('## 📝 素材库');
  dash.push('');
  dash.push(`从对话原文**逐字搬运**的成品素材：**${n素材} 条素材 + ${n范文} 篇范文**（共 ${files.length} 个条目）。`);
  dash.push('');
  dash.push('- 🗂 浏览总表：[[素材库总表|素材库总表]]（按会话与类别分组）');
  dash.push('- 🔎 筛选视图：`素材库.base`（高置信素材 / 范文 / 卡片墙 / 待人工确认）');
  dash.push('- 📁 逐条阅读：左侧打开 `materials/` 文件夹');
  dash.push('');
}

/* 外部镜像笔记（来自主 Obsidian 库，单向同步，只读） */
const EXT = path.join(KB, 'external');
if (existsSync(EXT)) {
  const extGroups = [];
  for (const d of await readdir(EXT, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name.startsWith('.')) continue;
    const files = (await readdir(path.join(EXT, d.name))).filter((f) => f.endsWith('.md'));
    const entry = files.find((f) => /索引|入口|总览/.test(f));
    extGroups.push({ name: d.name, count: files.length, entry: entry ? entry.replace(/\.md$/, '') : null });
  }
  if (extGroups.length) {
    dash.push('## 🔗 外部镜像笔记');
    dash.push('');
    dash.push('从主 Obsidian 库**单向同步**过来的专题笔记（源为准，这里是只读副本；改内容请改主库后重跑 `sync-external.mjs`）。');
    dash.push('');
    for (const g of extGroups) {
      dash.push(`- ${g.entry ? `[[${g.entry}|${g.name}]]` : g.name}　（${g.count} 篇）`);
    }
    dash.push('');
  }
}
dash.push('## 尚未建卡');
dash.push('');
dash.push(`${noNote.length} 条已登记但没有摘要卡；补齐后重跑 \`node tools/link-notes.mjs\` 与 \`node tools/obsidian-sync.mjs\`。`);
dash.push('');
const LIST_CAP = 40;
dash.push(noNote.slice(0, LIST_CAP).map((r) => `\`${r.id}\` ${r.title}`).join('　·　'));
if (noNote.length > LIST_CAP) {
  dash.push('');
  dash.push(`…另有 **${noNote.length - LIST_CAP}** 条未列出（完整清单见 \`index/catalog.jsonl\` 或 [[INDEX|知识库总索引]]）。`);
}
dash.push('');
dash.push('---');
dash.push('');
dash.push('## 在 Obsidian 里怎么用这套库');
dash.push('');
dash.push('| 想做的事 | 怎么做 |');
dash.push('| --- | --- |');
dash.push('| 找某个知识点 | `Ctrl+O` 按标题跳转，或 `Ctrl+Shift+F` 全文搜（含 fulltext 正文层） |');
dash.push('| 按主题浏览 | 左侧标签面板点 #作文 / #试卷 / #文言文 |');
dash.push('| 看文档关系 | 打开图谱视图；每张卡片与它的 fulltext 副本、关联卡片相连 |');
dash.push('| 核对原文 | 卡片 front matter 的 `source` 是原件绝对路径，点开即定位 |');
dash.push('| 新增/改动文件后 | 让 DSH 跑 `scan.mjs` → `extract-text.mjs` → `link-notes.mjs` → `build-index.mjs` → `obsidian-sync.mjs` |');
dash.push('| 想要数据库式视图 | 打开 `知识库.base`（Obsidian 1.9+ 自带 Bases） |');
dash.push('');
await writeFile(path.join(KB, '首页.md'), dash.join('\n'), 'utf8');

/* ---------- 4. 首次配置 Obsidian + Bases ---------- */
const obsDir = path.join(KB, '.obsidian');
let wroteConfig = false;
if (!existsSync(obsDir)) {
  await mkdir(obsDir, { recursive: true });
  await writeFile(
    path.join(obsDir, 'app.json'),
    JSON.stringify(
      {
        userIgnoreFilters: ['cache/', 'tools/'],
        useMarkdownLinks: false,
        newLinkFormat: 'shortest',
        alwaysUpdateLinks: true,
        showLineNumber: true,
      },
      null,
      2,
    ),
    'utf8',
  );
  wroteConfig = true;
}

const basePath = path.join(KB, '知识库.base');
if (!existsSync(basePath)) {
  await writeFile(
    basePath,
    [
      '# Obsidian Bases 视图（1.9+ 自带插件）。若某列报错，用 Bases 界面点选调整即可。',
      'filters:',
      '  and:',
      '    - file.inFolder("notes")',
      'views:',
      '  - type: table',
      '    name: 全部卡片',
      '    order:',
      '      - file.name',
      '      - id',
      '      - tags',
      '      - status',
      '      - source',
      '  - type: table',
      '    name: 待补 / 待 OCR',
      '    filters:',
      '      or:',
      '        - status == "needs-ocr"',
      '        - status == "registered"',
      '    order:',
      '      - file.name',
      '      - status',
      '      - source',
      '  - type: cards',
      '    name: 卡片墙',
      '    order:',
      '      - file.name',
      '      - summary',
      '      - tags',
      '',
    ].join('\n'),
    'utf8',
  );
}

/* ---------- 报告 ---------- */
console.log('===== Obsidian 同步完成 =====');
console.log(`摘要卡补 aliases : ${aliasAdded} 张（累计 ${noteFiles.length} 张）`);
console.log(`全文层导出       : ${NO_FULLTEXT ? '已跳过' : `${exported} 个 → fulltext/`}`);
console.log(`仪表盘           : 首页.md`);
console.log(`Obsidian 配置    : ${wroteConfig ? '已写入 .obsidian/app.json（排除 cache/、tools/）' : '已存在，未改动'}`);
console.log(`Bases 视图       : ${existsSync(basePath) ? '知识库.base' : '（未生成）'}`);
console.log('');
console.log('在 Obsidian 里打开本 vault：');
console.log(`  文件 → 打开其他库 → 打开文件夹作为库 → ${KB}`);
console.log(`  或浏览器访问：obsidian://open?path=${encodeURIComponent(KB)}`);
