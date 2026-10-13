#!/usr/bin/env node
/**
 * make-share-zip.mjs —— 把知识库打成「只读浏览版」压缩包分享给别人
 *
 * 与主库的关系：**只读快照**。不改原件、不改主库，全部产出一份新目录 + 一个 zip。
 *
 * 包含：首页.md / notes / materials / vocab / review / digests / inbox / index(INDEX+tags)
 *       / 根目录 .base / 最小 .obsidian（含背单词插件）/ README.txt
 * 排除：chats（对话原文）/ cache / fulltext / external / tools / catalog.jsonl（含本机绝对路径）
 *       / 敏感整卡（班费表、告家长书、班规、春考分数）
 * 脱敏：手机号、身份证号、长数字串打码；剥离复习进度注释；把对话出处降级为纯文本
 *
 * 用法：
 *   node tools/make-share-zip.mjs            # 生成 staging + zip
 *   node tools/make-share-zip.mjs --dry      # 只报告会打包什么
 *   node tools/make-share-zip.mjs --no-plugin # 不带背单词插件（包更小）
 */
import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync, rmSync, statSync, copyFileSync } from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const OUT_ROOT = path.join(path.dirname(KB), '发布');
const STAGE = path.join(OUT_ROOT, '知识库-分享版');
const ZIP = path.join(OUT_ROOT, '知识库-分享版.zip');
const DRY = process.argv.includes('--dry');
const NO_PLUGIN = process.argv.includes('--no-plugin');

/* ---------- 配置：包含 / 排除 / 脱敏 ---------- */
const INCLUDE_DIRS = ['notes', 'materials', 'vocab', 'review', 'digests', 'inbox', 'index'];
const EXCLUDE_FILES = [
  'index/catalog.jsonl', // 含本机绝对路径
  'index/extract-queue.json',
  'index/extract-report.json',
  'index/found-docs.json',
  'index/知识库.base', // 若存在（.base 已在根目录提供）
];
const TEXT_EXT = new Set(['.md', '.txt', '.csv', '.base', '.json']);

/** 整卡剔除：这些内容不适合分享给同学 */
const BLOCKLIST = [
  { id: 'kb-0045', why: '高二5班费收支表（含 7 个手机号与账目）' },
  { id: 'kb-0043', why: '期末告家长书' },
  { id: 'kb-0134', why: '班规' },
  { id: 'kb-0428', why: '春考分数' },
];
const BLOCK_IDS = new Set(BLOCKLIST.map((b) => b.id));

const mask = (t) =>
  t
    .replace(/\b1[3-9]\d{9}\b/g, (m) => `${m.slice(0, 3)}****${m.slice(7)}`)
    .replace(/\b\d{17}[\dXx]\b/g, (m) => `${m.slice(0, 6)}********${m.slice(14)}`)
    .replace(/\b\d{16,19}\b/g, (m) => `${m.slice(0, 4)} **** **** ${m.slice(-4)}`);

/** 路径匿名化：同学看不到原件，绝对路径既无用又暴露磁盘结构 → 去掉盘符与用户名，保留相对出处 */
const anonymizePath = (t) =>
  t
    .replace(/[A-Za-z]:\\Users\\[^\\\r\n|`)]+\\Documents\\xwechat_files\\/gi, '微信文件\\')
    .replace(/[A-Za-z]:\\Users\\[^\\\r\n|`)]+\\Desktop\\/gi, '桌面\\')
    .replace(/[A-Za-z]:\\Users\\[^\\\r\n|`)]+\\Documents\\/gi, '文档\\')
    .replace(/[A-Za-z]:\\Users\\[^\\\r\n|`)]+\\Downloads\\/gi, '下载\\')
    .replace(/[A-Za-z]:\\/g, '')
    .replace(/[A-Za-z]:\//g, '');

const sanitize = (text) =>
  anonymizePath(mask(text))
    // 复习进度是"我"的学习记录，分享包里剥掉，让同学从零开始
    .replace(/^\s*<!--SR:.*-->\s*$\r?\n?/gm, '')
    .replace(/<!--SR:.*?-->/g, '')
    // 对话原文不在包里：把指向它的 wikilink 降级成纯文本，避免断链与标题泄露
    .replace(/\[\[chats\/[^\]|]*\|([^\]]*)\]\]/g, '$1')
    .replace(/\[\[chats\/[^\]]*\]\]/g, '对话记录')
    .replace(/\[\[fulltext\/[^\]|]*\|([^\]]*)\]\]/g, '$1')
    .replace(/\[\[fulltext\/[^\]]*\]\]/g, '全文副本')
    // 被剔除的卡片：wikilink 与 Markdown 链接都要降级为纯文本
    .replace(new RegExp(`\\[\\[(kb-(?:0045|0043|0134|0428))[^\\]|]*\\|([^\\]]*)\\]\\]`, 'g'), '$2')
    .replace(new RegExp(`\\[\\[(kb-(?:0045|0043|0134|0428))[^\\]]*\\]\\]`, 'g'), '（已略）')
    .replace(new RegExp(`\\[([^\\]]+)\\]\\(([^)]*)(kb-(?:0045|0043|0134|0428))[^)]*\\)`, 'g'), '$1（已略）');

/* ---------- 收集文件 ---------- */
const files = [];
const skipped = [];
const blocked = [];
const walk = (dir, rel) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) {
      walk(full, r);
      continue;
    }
    const m = /^notes\/(kb-\d{4})/.exec(r);
    if (m && BLOCK_IDS.has(m[1])) {
      const b = BLOCKLIST.find((x) => x.id === m[1]);
      blocked.push({ r, why: b ? b.why : '' });
      continue;
    }
    if (r.startsWith('digests/backup/')) {
      skipped.push({ r, why: '内部备份快照（拆分前的旧卡片，对读者是噪音）' });
      continue;
    }
    if (EXCLUDE_FILES.includes(r)) {
      skipped.push({ r, why: '含本机绝对路径' });
      continue;
    }
    files.push({ full, r });
  }
};
for (const d of INCLUDE_DIRS) {
  const p = path.join(KB, d);
  if (existsSync(p)) walk(p, d);
}
// 根目录的散装文件（首页、Bases 视图）；空文件与 Agent 手册不打包
for (const f of readdirSync(KB, { withFileTypes: true })) {
  if (!f.isFile()) continue;
  if (f.name === 'AGENTS.md' || f.name === 'README.md') continue;
  if (f.name.startsWith('未命名')) continue; // 空 Bases 垃圾文件
  if (f.name.endsWith('.base') && statSync(path.join(KB, f.name)).size < 50) continue;
  files.push({ full: path.join(KB, f.name), r: f.name });
}

if (DRY) {
  const byDir = {};
  for (const f of files) {
    const top = f.r.includes('/') ? f.r.split('/')[0] : '(根目录)';
    byDir[top] = (byDir[top] || 0) + 1;
  }
  console.log('[dry] 会打包：');
  for (const [d, n] of Object.entries(byDir).sort()) console.log(`   ${d.padEnd(12)} ${n} 个文件`);
  console.log(`\n[dry] 剔除整卡 ${blocked.length} 张：`);
  for (const b of blocked) console.log(`   ${b.r}　（${b.why}）`);
  console.log(`[dry] 排除文件 ${skipped.length} 个（含绝对路径）`);
  console.log(`[dry] .obsidian：最小配置${NO_PLUGIN ? '（不带插件）' : ' + 背单词插件'}`);
  console.log('\n[dry] 未写盘。');
  process.exit(0);
}

/* ---------- 写 staging ---------- */
if (existsSync(STAGE)) rmSync(STAGE, { recursive: true, force: true });
mkdirSync(STAGE, { recursive: true });
let nWrite = 0;
let nSanitized = 0;
for (const f of files) {
  const dst = path.join(STAGE, ...f.r.split('/'));
  mkdirSync(path.dirname(dst), { recursive: true });
  const ext = path.extname(f.r).toLowerCase();
  if (TEXT_EXT.has(ext)) {
    const src = readFileSync(f.full, 'utf8');
    const out = ext === '.json' ? src : sanitize(src); // JSON 不动结构，只用于索引类
    if (out !== src) nSanitized++;
    writeFileSync(dst, out, 'utf8');
  } else {
    copyFileSync(f.full, dst);
  }
  nWrite++;
}

/* ---------- .obsidian：最小配置 + 背单词插件 ---------- */
const OBS_SRC = path.join(KB, '.obsidian');
const OBS_DST = path.join(STAGE, '.obsidian');
mkdirSync(OBS_DST, { recursive: true });
const obsKeep = ['appearance.json', 'core-plugins.json'];
for (const f of obsKeep) {
  const src = path.join(OBS_SRC, f);
  if (existsSync(src)) copyFileSync(src, path.join(OBS_DST, f));
}
// app.json：清掉指向主库内部目录的忽略规则（那些目录不在分享包里）
writeFileSync(
  path.join(OBS_DST, 'app.json'),
  JSON.stringify({ userIgnoreFilters: [], useMarkdownLinks: false, newLinkFormat: 'shortest', alwaysUpdateLinks: true }, null, 2),
  'utf8',
);
let pluginKB = 0;
if (!NO_PLUGIN) {
  const ps = path.join(OBS_SRC, 'plugins', 'obsidian-spaced-repetition');
  const pd = path.join(OBS_DST, 'plugins', 'obsidian-spaced-repetition');
  if (existsSync(ps)) {
    mkdirSync(pd, { recursive: true });
    for (const f of readdirSync(ps)) {
      copyFileSync(path.join(ps, f), path.join(pd, f));
      pluginKB += statSync(path.join(ps, f)).size / 1024;
    }
  }
  mkdirSync(path.join(OBS_DST, 'plugins'), { recursive: true });
  writeFileSync(
    path.join(OBS_DST, 'community-plugins.json'),
    JSON.stringify(['obsidian-spaced-repetition'], null, 2),
    'utf8',
  );
}

/* ---------- 分享版首页 ---------- */
const cnt = (d) => (existsSync(path.join(STAGE, d)) ? readdirSync(path.join(STAGE, d)).filter((f) => f.endsWith('.md') && !f.startsWith('_')).length : 0);
const decks = existsSync(path.join(STAGE, 'review'))
  ? readdirSync(path.join(STAGE, 'review'))
      .filter((f) => f.endsWith('.md') && f !== '英语词汇-出处索引.md')
      .map((f) => {
        const t = readFileSync(path.join(STAGE, 'review', f), 'utf8');
        return { name: f.replace(/\.md$/, ''), n: (t.match(/:::/g) || []).length };
      })
  : [];
const digests = existsSync(path.join(STAGE, 'digests'))
  ? readdirSync(path.join(STAGE, 'digests')).filter((f) => f.endsWith('.md') && f !== '成品说明.md')
  : [];
writeFileSync(
  path.join(STAGE, '首页.md'),
  `# 知识库 · 只读浏览版

> 这是个人知识库的**分享快照**（${new Date().toISOString().slice(0, 10)} 生成）。
> 原始资料（Word/PDF/教材）与对话原文**不在本包内**；卡片里的 \`source:\` 是出处说明，供追溯用。
> 包内不含个人隐私信息（手机号等已打码），部分整卡（涉及班级账目、告家长书等）已剔除。

## 怎么开始看

1. 用 **Obsidian** 打开本文件夹（见包内 \`README.txt\`）；
2. 从下面的「学科总表」入手，比一张张翻卡片快得多；
3. 想看细节就点卡片里的双向链接，或直接打开对应目录。

## 📚 学科总表 / 专题成品

${digests.map((d) => `- [[${d.replace(/\.md$/, '')}]]`).join('\n') || '- （无）'}

## 🗂 各层内容

| 层 | 内容 | 数量 |
| --- | --- | --- |
| \`notes/\` | 摘要卡（每篇文档/每次对话一张，含要点与原文出处） | ${cnt('notes')} 张 |
| \`materials/\` | 素材库（范文与可用段落，逐字摘自原始材料） | ${cnt('materials')} 条 |
| \`vocab/\` | 英语词条（一词一笔记：释义 / 批注 / 例句 / 出处） | ${cnt('vocab')} 个 |
| \`review/\` | 背单词复习卡（Spaced Repetition） | ${decks.reduce((a, d) => a + d.n, 0)} 张 |
| \`digests/\` | 知识点总表与导出的 Word 文档 | ${digests.length} 篇 |
| \`inbox/\` | 手工录入的原始笔记（照片笔记转录、整理的表格） | ${cnt('inbox')} 份 |

## 🎴 背单词怎么用

包内已带 **Spaced Repetition** 插件。步骤：设置 → 第三方插件 → 关闭「受限模式」→ 启用 **Spaced Repetition**；
然后 \`Ctrl+P\` → \`Spaced Repetition: Review flashcards from all notes\` → 选牌组：

${decks.map((d) => `- [[${d.name}]]　**${d.n}** 张`).join('\n') || '- （无）'}

## 🔎 想快速找东西

- \`index/INDEX.md\` —— 全部摘要卡清单（按学科分组）
- \`index/tags.md\` —— 标签词表
- Obsidian 里直接 \`Ctrl+Shift+F\` 全文搜索

## 说明

- 对话原文（\`chats/\`）、抽取的正文缓存、脚本工具、目录索引（含原作者的机器路径）**均未包含**。
- 卡片中的出处路径指向原作者电脑上的真实文件，仅作来源标记。
- 内容版权归原作者；请勿再分发。
`,
  'utf8',
);

/* ---------- 分享版索引 ---------- */
const notesDir = path.join(STAGE, 'notes');
const cards = [];
for (const f of readdirSync(notesDir).filter((f) => f.endsWith('.md'))) {
  const t = readFileSync(path.join(notesDir, f), 'utf8');
  const title = (/^title:\s*(.+)$/m.exec(t) || [, f])[1].trim();
  const tags = (/^tags:\s*\[(.*)\]/m.exec(t) || [, ''])[1].split(',').map((s) => s.trim()).filter(Boolean);
  cards.push({ file: f, title, tags });
}
const byTag = {};
for (const c of cards) {
  const key = c.tags.find((t) => ['语文', '数学', '英语', '文言', '作文', '试卷', '对话', '班务', '数据'].includes(t)) || c.tags[0] || '其他';
  (byTag[key] = byTag[key] || []).push(c);
}
const idx = ['# 摘要卡总索引', '', `> 共 ${cards.length} 张。点击标题打开卡片；原始文档不在包内，卡片内有出处说明。`, ''];
for (const [tag, list] of Object.entries(byTag).sort((a, b) => b[1].length - a[1].length)) {
  idx.push(`## ${tag}（${list.length}）`, '');
  for (const c of list.sort((a, b) => a.title.localeCompare(b.title))) idx.push(`- [${c.title}](${encodeURI(`notes/${c.file}`)})`);
  idx.push('');
}
writeFileSync(path.join(STAGE, 'index', 'INDEX.md'), idx.join('\n'), 'utf8');

/* ---------- README.txt ---------- */
const totalMB = (() => {
  let s = 0;
  const w = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) w(p);
      else s += statSync(p).size;
    }
  };
  w(STAGE);
  return (s / 1024 / 1024).toFixed(1);
})();
writeFileSync(
  path.join(STAGE, 'README.txt'),
  `================================================================
 个人知识库 · 只读浏览版
================================================================

这是什么
--------
这是我平时积累的一个「个人知识库」的分享快照：把散在各处的资料（教材、作文、
试卷、学习笔记、单词表等）整理成一套可检索的笔记卡片。本包是**只读浏览版**，
方便你直接看内容，不需要装我用的那套工具。

包里没有的东西
--------------
· 原始文件（Word / PDF / 教材扫描件）——它们在我电脑上，卡片里只记录出处
· 我和 AI 的对话原文
· 我的脚本工具与目录索引（含我本机的路径）
· 涉及隐私的内容（手机号等已打码；班级账目、告家长书等整张卡片已剔除）

怎么打开（推荐：Obsidian）
--------------------------
1. 先解压整个文件夹（不要只解压一部分）。
2. 下载安装 Obsidian：https://obsidian.md  （免费，Windows / Mac / 手机都有）
3. 打开 Obsidian → 点「打开其他库 / Open folder as vault」
   → 选择解压出来的这个文件夹（名字类似 知识库-分享版）
4. 首次打开若提示「是否信任作者并启用插件」，选信任即可（包内只带了一个背单词插件）。
5. 从左侧文件树打开「首页.md」开始看。

不想装 Obsidian 也能看
----------------------
包里全是纯文本 Markdown 文件，用记事本 / VS Code / Typora 都能打开。
缺点是没有双链跳转和搜索，体验差很多。

建议的浏览顺序
--------------
1. 首页.md                —— 总览与各层入口
2. digests/               —— 学科知识点总表（语文作文素材、数学、英语）
3. notes/                 —— 摘要卡：一张卡=一篇文档或一次学习记录，含要点与原文出处
4. materials/             —— 素材库：作文范文与可直接引用的段落
5. vocab/ 和 review/      —— 英语词库与背单词卡片
6. inbox/                 —— 我手工录入的原始笔记（照片笔记转录、整理的表格）

背单词功能（Spaced Repetition）
------------------------------
包内已带插件，启用一次即可：
  设置 → 第三方插件（社区插件）→ 关闭「受限模式」
  → 在「已安装插件」里启用 Spaced Repetition
然后按 Ctrl+P，输入 Review flashcards，选择牌组（如「照片笔记第一张图」）就能开始背。
注意：卡片的复习进度是每个人自己的，包内已经清空。

关于内容
--------
· 卡片里的 source: / 出处 指向我电脑上的原始文件，只是来源标记，点不开很正常。
· 标签词表见 index/tags.md；全部卡片清单见 index/INDEX.md。
· 内容版权归我，仅供你学习参考，请不要二次分发。
· 生成时间：${new Date().toISOString().slice(0, 19).replace('T', ' ')}
================================================================
`,
  'utf8',
);

/* ---------- 打 zip（自己拼 ZIP，避免 PowerShell 的编码坑） ---------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const list = [];
(function w(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) w(p);
    else list.push(p);
  }
})(STAGE);
const locals = [];
const centrals = [];
let offset = 0;
for (const f of list) {
  const rel = path.relative(STAGE, f).split(path.sep).join('/');
  const data = readFileSync(f);
  const comp = zlib.deflateRawSync(data, { level: 9 });
  const use = comp.length < data.length;
  const body = use ? comp : data;
  const crc = crc32(data);
  const nb = Buffer.from(rel, 'utf8');
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0);
  lh.writeUInt16LE(20, 4);
  lh.writeUInt16LE(0x0800, 6); // UTF-8 文件名标记
  lh.writeUInt16LE(use ? 8 : 0, 8);
  lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(body.length, 18);
  lh.writeUInt32LE(data.length, 22);
  lh.writeUInt16LE(nb.length, 26);
  locals.push(lh, nb, body);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0);
  ch.writeUInt16LE(20, 4);
  ch.writeUInt16LE(20, 6);
  ch.writeUInt16LE(0x0800, 8);
  ch.writeUInt16LE(use ? 8 : 0, 10);
  ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(body.length, 20);
  ch.writeUInt32LE(data.length, 24);
  ch.writeUInt16LE(nb.length, 28);
  ch.writeUInt32LE(offset, 42);
  centrals.push(ch, nb);
  offset += 30 + nb.length + body.length;
}
const cd = Buffer.concat(centrals);
const eocd = Buffer.alloc(22);
eocd.writeUInt32LE(0x06054b50, 0);
eocd.writeUInt16LE(list.length, 8);
eocd.writeUInt16LE(list.length, 10);
eocd.writeUInt32LE(cd.length, 12);
eocd.writeUInt32LE(offset, 16);
mkdirSync(OUT_ROOT, { recursive: true });
writeFileSync(ZIP, Buffer.concat([...locals, cd, eocd]));

/* ---------- 自检 1：包内不该再有手机号 / 身份证 ---------- */
const residual = [];
const allFiles = [];
const walkStage = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      walkStage(p);
      continue;
    }
    allFiles.push(p);
    if (!TEXT_EXT.has(path.extname(e.name).toLowerCase())) continue;
    const t = readFileSync(p, 'utf8');
    const hits = (t.match(/\b1[3-9]\d{9}\b/g) || []).length + (t.match(/\b\d{17}[\dXx]\b/g) || []).length;
    if (hits) residual.push(`${path.relative(STAGE, p)}（${hits} 处）`);
  }
};
walkStage(STAGE);

/* ---------- 自检 2：链接是否都能在包内解析（先剥掉代码块与行内代码） ---------- */
/** 只剥「已知扩展名」—— 词条名里带点的很多（e._treats、words_contradict_sb.），
 *  不能按"最后一个点之后都是扩展名"来剥，否则会把词名截断成 e。 */
const KNOWN_EXT = /\.(md|markdown|docx|xlsx|tsv|csv|base|pdf|txt|png|jpg)$/i;
const names = new Set(allFiles.map((f) => path.basename(f)));
const namesNoExt = new Set(allFiles.map((f) => path.basename(f).replace(KNOWN_EXT, '')));
/** 链接可能带扩展名也可能不带，两种都要能匹配 */
const resolveName = (raw) => {
  const b = path.basename(String(raw).trim().replace(/\\+$/, ''));
  return names.has(b) || namesNoExt.has(b.replace(KNOWN_EXT, ''));
};
const brokenWiki = [];
const brokenMd = [];
let nWiki = 0;
for (const p of allFiles.filter((f) => f.endsWith('.md'))) {
  const raw = readFileSync(p, 'utf8');
  const t = raw.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '');
  for (const m of t.matchAll(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g)) {
    nWiki++;
    if (!resolveName(m[1])) brokenWiki.push(`${path.relative(STAGE, p)} → ${m[1]}`);
  }
  for (const m of t.matchAll(/\[[^\]]+\]\((?:\.\.\/)*([a-z]+)\/([^)]+)\)/g)) {
    const tgt = path.join(STAGE, m[1], path.basename(decodeURIComponent(m[2])));
    if (!existsSync(tgt)) brokenMd.push(`${path.relative(STAGE, p)} → ${m[1]}/${m[2]}`);
  }
}

console.log(`✓ 已生成分享包`);
console.log(`  目录：${STAGE}`);
console.log(`  压缩包：${ZIP}（${(statSync(ZIP).size / 1024 / 1024).toFixed(2)} MB，解压后 ${totalMB} MB）`);
console.log(`  文件：${list.length} 个（脱敏改写 ${nSanitized} 个）`);
console.log(`  剔除整卡：${blocked.length} 张 → ${blocked.map((b) => (/kb-\d{4}/.exec(b.r) || [''])[0]).join('、')}`);
console.log(`  排除：${skipped.length} 个索引文件（含绝对路径）`);
console.log(`  插件：${NO_PLUGIN ? '未包含' : `obsidian-spaced-repetition（${pluginKB.toFixed(0)} KB）`}`);
console.log(`\n自检：`);
console.log(residual.length ? `  ⚠ 仍有疑似个人信息：\n   ${residual.join('\n   ')}` : `  ✓ 隐私：无手机号 / 身份证号`);
console.log(
  brokenWiki.length + brokenMd.length
    ? `  ⚠ 断链：wikilink ${brokenWiki.length} 条 / Markdown ${brokenMd.length} 条\n   ${[...brokenWiki, ...brokenMd].slice(0, 8).join('\n   ')}`
    : `  ✓ 链接：${nWiki} 条 wikilink + Markdown 链接全部可解析`,
);
