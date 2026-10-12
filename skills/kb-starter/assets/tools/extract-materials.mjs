#!/usr/bin/env node
/**
 * extract-materials.mjs —— 从对话原文里「搬运」出可直接使用的成品素材段落
 *
 * 设计原则（针对"脚本会误判/漏判"的担忧）：
 *   1. **只搬运，不改写**：条目正文是原文逐字片段，脚本只加标题与字段，一个字都不改；
 *   2. **每条带出处锚点**：来源文件 + 第几轮回答 + 行号范围 + 该轮提问，可一键回原文核验；
 *   3. **置信度分级**：结构明确的标 conf=high，靠猜测的标 low，**都产出，不静默丢**；
 *   4. **整轮兜底**：没有小节标题的回答也整轮收成一条（含范文），不漏；
 *   5. **未收录清单**：被跳过的段落全部列出，保证"漏"是可见的；
 *   6. **原文零改动**：只读 chats/，产物全部写在 materials/（派生层，可重跑清除）。
 *
 * 识别的结构（实测）：
 *   A 类：`### 一、**标题**` + `**素材内容**` + `**适用主题**`   → 整个小节 = 一条素材
 *   B 类：`### 分类` + `**N. 标题**` + 正文段落                → 每个粗体编号项 = 一条素材
 *   C 类：小节存在但不是素材小节（如"考场运用小技巧"）        → 整节成一条，conf=low
 *   D 类：整轮回答没有 ### 小节标题                            → 整轮成一条，conf=low
 *
 * 用法：
 *   node tools/extract-materials.mjs --chats=kb-0412,kb-0409,kb-0442
 *   node tools/extract-materials.mjs                      # 所有带 作文/素材/范文 标签的对话卡
 *   node tools/extract-materials.mjs --check              # 只报告，不写文件
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(KB, 'materials');
const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const arg = (n, d = '') => (argv.find((a) => a.startsWith(`${n}=`)) || `${n}=${d}`).split('=')[1];

const records = readFileSync(path.join(KB, 'index', 'catalog.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l));
const byId = new Map(records.map((r) => [r.id, r]));

/** 读取卡片已审过的标签作为条目来源（不自己发明标签） */
function cardTags(id) {
  const rec = byId.get(id);
  if (!rec?.note) return [];
  const p = path.join(KB, rec.note);
  if (!existsSync(p)) return [];
  const m = /^tags:\s*\[(.*)\]\s*$/m.exec(readFileSync(p, 'utf8'));
  return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : [];
}

let targets;
if (arg('--chats')) {
  targets = arg('--chats').split(',').map((s) => s.trim()).filter(Boolean).map((id) => byId.get(id)).filter(Boolean);
} else {
  targets = records.filter((r) => r.root === 'chats' && r.note && (r.tags || []).some((t) => ['作文', '素材', '范文'].includes(t)));
}

// materials/ 是派生层：每次重跑先清空自己产出的条目，避免留下上一版切错的孤儿文件。
// ⚠ 不能删「素材库总表.md」—— 它由 build-material-index.mjs 生成，重跑顺序不一定在之后。
if (!CHECK && existsSync(OUT_DIR)) {
  for (const f of readdirSync(OUT_DIR)) {
    if (f.endsWith('.md') && f !== '素材库总表.md') rmSync(path.join(OUT_DIR, f));
  }
}

const clean = (s) =>
  s
    .replace(/\*\*/g, '')
    .replace(/^[一二三四五六七八九十]+、\s*/, '')
    .replace(/^[（(]?[一二三四五六七八九十\d]+[）)]?[.、]?\s*/, '')
    .trim();
const slug = (s) => s.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
const oneLine = (s, n = 120) => s.replace(/\s+/g, ' ').trim().slice(0, n);
/** 必须数字/序号开头才算条目，否则 `**素材内容：**` 这类字段名会被误判为标题 */
const BOLD_ITEM = /^\*\*\s*(?:\d+|[一二三四五六七八九十]+)\s*[.、)）]?\s*[^*]{2,60}\*\*\s*$/;

const stats = { chats: 0, items: 0, high: 0, low: 0, skipped: 0, rounds: { sectioned: 0, whole: 0 }, dropped: 0 };
const skipped = [];
const dropped = [];
const written = [];

/** 判定一个小节/一轮回答的性质：素材 > 范文 > 其他 */
function classify(text, sectionTitle = '', question = '') {
  const hay = `${sectionTitle}\n${text}`;
  if (/素材/.test(sectionTitle) || /素材内容|适用主题|适用论点|适用角度/.test(text)) {
    return { kind: '素材', conf: /素材内容|适用主题|适用论点|适用角度/.test(text) ? 'high' : 'medium' };
  }
  // 范文：小节标题点明，或（整轮回答 + 提问是写作任务 + 篇幅够长）
  const essaySection = /范文|例文|作文|示范|立意|题目/.test(sectionTitle);
  const essayWhole = /范文|作文|立意|自拟|不少于|写一篇|写一篇文章|议论文|记叙文|演讲稿|题目/.test(question) && text.length > 600;
  if (essaySection || essayWhole || /范文|例文/.test(text.slice(0, 200))) {
    return { kind: '范文', conf: essaySection ? 'medium' : 'low' };
  }
  return { kind: '其他', conf: 'low' };
}

for (const rec of targets) {
  const src = path.isAbsolute(rec.source) ? rec.source : path.join(KB, rec.source);
  if (!existsSync(src)) {
    console.warn(`  ! 找不到源文件，跳过：${rec.id} → ${src}`);
    continue;
  }
  stats.chats++;
  const chatFile = `chats/${path.basename(rec.source)}`;
  const chatTitle = rec.title;
  const tags = [...new Set([...cardTags(rec.id).filter((t) => t !== '对话'), '素材'])];

  /* ---------- 第一遍：按「轮次」切分 ---------- */
  // 折叠块（<details> 里的深度思考/联网过程）与时间戳是导出时加的渲染包装，
  // 不属于「成品素材」，一律剔除；完整原文仍在 chats/ 里。
  const rounds = [];
  let cur = null;
  let mode = null;
  let inDetails = false;
  readFileSync(src, 'utf8')
    .split(/\r?\n/)
    .forEach((text, i) => {
      const n = i + 1;
      if (/^\s*<details/.test(text)) {
        inDetails = true;
        return;
      }
      if (/^\s*<\/details>/.test(text)) {
        inDetails = false;
        return;
      }
      if (inDetails) return;
      if (/^## 👤 提问/.test(text)) {
        cur = { round: rounds.length + 1, question: [], answer: [] };
        rounds.push(cur);
        mode = 'q';
        return;
      }
      if (/^## 🤖 回答/.test(text)) {
        if (!cur) {
          cur = { round: rounds.length + 1, question: [], answer: [] };
          rounds.push(cur);
        }
        mode = 'a';
        return;
      }
      if (!cur || /^## /.test(text)) return;
      if (/^\s*<|^\s*<!--|^\s*```/.test(text)) return; // 丢掉时间戳、HTML 残留与代码围栏
      if (mode === 'q') cur.question.push({ n, t: text });
      else if (mode === 'a') cur.answer.push({ n, t: text });
    });

  let seq = 0;
  for (const r of rounds) {
    const answer = r.answer.filter((l) => l.t.trim() !== '');
    if (!answer.length) continue;
    const question = oneLine(r.question.map((l) => l.t).join(' '));

    /* ---------- 第二遍：按 ### 小节切分 ---------- */
    const secs = [];
    let h = null;
    for (const l of r.answer) {
      if (/^### /.test(l.t)) {
        if (h) secs.push(h);
        h = { title: l.t.replace(/^###\s*/, '').trim(), lines: [] };
      } else if (h) h.lines.push(l);
    }
    if (h) secs.push(h);

    // D 类：整轮没有小节标题 → 整轮收成一条，conf=low（含范文的轮次不会漏）
    if (!secs.length) {
      stats.rounds.whole++;
      const full = answer.map((l) => l.t).join('\n');
      // 取标题的优先级：粗体小标题 > 该轮提问摘要 > 回答首行
      // （直接拿首行常常拿到"好的，这段…"这类客套开场白，不便于检索）
      const boldTitle = answer
        .map((l) => l.t.trim())
        .find((t) => /^\*\*[^*]{4,40}\*\*\s*$/.test(t) && !/素材内容|适用主题|适用论点|适用角度|总结|注意|说明/.test(t));
      const firstLine = answer.find((l) => l.t.trim() && !/^[->#]/.test(l.t.trim()));
      // 标题优先级：粗体小标题 > 看起来像标题的首行 > 提问摘要
      const looksLikeTitle = (t) =>
        !!t && t.trim().length <= 30 && !/[。！？；]/.test(t) && !/^(好的|你|我|我们|这段|以下|当然|可以|这是)/.test(t.trim());
      const title = boldTitle
        ? clean(boldTitle)
        : looksLikeTitle(firstLine?.t)
          ? clean(firstLine.t)
          : question
            ? `${oneLine(question, 22)}…回答`
            : clean(firstLine?.t || '') || `第 ${r.round} 轮回答`;
      seq++;
      const c = classify(full, '', question);
      emit({
        rec, chatTitle, chatFile, tags, round: r.round, seq, question,
        title: title.slice(0, 60),
        section: '（整轮回答·无小节标题）',
        kind: c.kind,
        conf: c.conf,
        start: answer[0].n, end: answer[answer.length - 1].n,
        body: full.trim(),
      });
      continue;
    }

    /* ---------- 有小节：A / B / C 三类 ---------- */
    stats.rounds.sectioned++;
    let consumed = 0;
    for (const sec of secs) {
      const first = sec.lines.find((l) => l.t.trim() !== '');
      const last = [...sec.lines].reverse().find((l) => l.t.trim() !== '');
      if (!first || !last) continue;
      const secTitle = clean(sec.title);
      const body = sec.lines.map((l) => l.t).join('\n').trim();
      const boldIdx = [];
      sec.lines.forEach((l, idx) => {
        if (BOLD_ITEM.test(l.t.trim())) boldIdx.push(idx);
      });

      if (boldIdx.length >= 1) {
        // 小节导语（首个条目之前）不属于任何条目 → 显式登记，不静默丢
        if (boldIdx[0] > 0) {
          const pre = sec.lines.slice(0, boldIdx[0]).map((l) => l.t).join('\n').trim();
          if (pre) {
            stats.skipped++;
            skipped.push(`${rec.id} 第 ${r.round} 轮「${secTitle}」小节导语未收录（非条目内容，L${sec.lines[0].n} 起）`);
          }
        }
        boldIdx.forEach((si, k) => {
          const ei = k + 1 < boldIdx.length ? boldIdx[k + 1] : sec.lines.length;
          const chunk = sec.lines.slice(si, ei);
          const f = chunk.find((l) => l.t.trim() !== '');
          const l2 = [...chunk].reverse().find((l) => l.t.trim() !== '');
          if (!f || !l2) return;
          const chunkText = chunk.map((l) => l.t).join('\n').trim();
          const c = classify(chunkText, secTitle, question);
          seq++;
          consumed++;
          emit({
            rec, chatTitle, chatFile, tags, round: r.round, seq, question,
            title: clean(f.t),
            section: secTitle,
            kind: c.kind,
            conf: c.conf,
            start: f.n, end: l2.n,
            body: chunkText,
          });
        });
      } else {
        seq++;
        consumed++;
        const c = classify(body, secTitle, question);
        emit({
          rec, chatTitle, chatFile, tags, round: r.round, seq, question,
          title: secTitle || `第 ${r.round} 轮回答`,
          section: secTitle,
          kind: c.kind,
          conf: c.conf,
          start: first.n, end: last.n,
          body,
        });
      }
    }
  }
}

function emit(it) {
  stats.items++;
  // 「其他」= 普通问答，不是素材也不是范文：不重复写盘（原文就在 chats/ 里），
  // 但登记进报告清单，保证"没被收录"是可见的，而不是静默丢弃。
  if (it.kind === '其他') {
    stats.dropped++;
    dropped.push(`${it.rec.id}　第 ${it.round} 轮　L${it.start}-L${it.end}　${it.title}`);
    return;
  }
  if (it.conf === 'high') stats.high++;
  else stats.low++;
  const name = `${it.rec.id}-${String(it.seq).padStart(2, '0')}-${slug(it.title) || '素材'}.md`;
  const md = [
    '---',
    'kb_material: true',
    `title: ${it.title}`,
    `kind: ${it.kind}`,
    `conf: ${it.conf}`,
    `section: ${it.section}`,
    `from_chat: ${it.chatTitle}`,
    `chat_id: ${it.rec.id}`,
    `chat_file: ${it.chatFile}`,
    `round: ${it.round}`,
    `anchor: L${it.start}-L${it.end}`,
    `question: ${it.question}`,
    `tags: [${it.tags.join(', ')}]`,
    '---',
    '',
    `# ${it.title}`,
    '',
    `> 📄 出处：[[${it.chatFile.replace(/\.md$/, '')}|对话原文]]　·　第 ${it.round} 轮回答　·　${it.chatFile} 第 ${it.start}–${it.end} 行`,
    `> ❓ 该轮提问：${it.question}`,
    '> 🔒 **逐字搬运**（只剔除思考链/联网过程/时间戳等包装，未改动任何句子）；若与原文不符，以原文为准。',
    '',
    it.body,
    '',
  ].join('\n');
  written.push({ file: name, id: it.rec.id, kind: it.kind, conf: it.conf, title: it.title });
  if (!CHECK) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(path.join(OUT_DIR, name), md, 'utf8');
  }
}

console.log(`处理会话 ${stats.chats} 个（${targets.map((t) => t.id).join(', ')}）`);
console.log(`切出条目 ${stats.items} 条：conf=high ${stats.high}　low/medium ${stats.low}`);
console.log(`  其中「有小节的轮次」${stats.rounds.sectioned} 轮，「无小节整轮兜底」${stats.rounds.whole} 轮`);
const byKind = {};
for (const w of written) byKind[w.kind] = (byKind[w.kind] || 0) + 1;
const byChat = {};
for (const w of written) byChat[w.id] = (byChat[w.id] || 0) + 1;

console.log(`处理会话 ${stats.chats} 个`);
console.log(`候选条目 ${stats.items} 条 → 收录 ${written.length} 条（素材+范文），未收录「其他」${stats.dropped} 条`);
console.log(`  收录分布：${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join('　')}　｜　conf=high ${stats.high}、medium/low ${stats.low}`);
console.log(`  产出素材/范文的会话：${Object.entries(byChat).map(([k, v]) => `${k}(${v})`).join(' ')}`);
console.log(`  轮次统计：有小节的 ${stats.rounds.sectioned} 轮，无小节整轮兜底 ${stats.rounds.whole} 轮`);
if (skipped.length) {
  console.log(`\n⚠ 小节导语未收录（${skipped.length} 条，非条目内容）：`);
  for (const s of skipped) console.log(`  · ${s}`);
}

// 写一份抽取报告：把「没收录的东西」也留档，避免"漏"变成不可见
const report = [
  '# 素材抽取报告',
  '',
  `> 由 \`tools/extract-materials.mjs\` 生成。**素材条目是原文逐字搬运**，本报告记录抽取口径与未收录清单。`,
  '',
  `- 扫描会话：${stats.chats} 个（带 作文/素材/范文 标签的对话卡）`,
  `- 候选条目：${stats.items} 条`,
  `- **收录：${written.length} 条**（${Object.entries(byKind).map(([k, v]) => `${k} ${v}`).join('、')}）`,
  `- 未收录「其他」：${stats.dropped} 条（普通问答，非素材非范文；原文在 \`chats/\` 中，不重复写盘）`,
  `- 小节导语未收录：${skipped.length} 条（小节开头的说明性文字，不属于任何条目）`,
  '',
  '## 收录口径',
  '',
  '| 类别 | 判定依据 | conf |',
  '| --- | --- | --- |',
  '| 素材 | 小节标题含「素材」，或正文出现 `素材内容/适用主题/适用论点/适用角度` | high |',
  '| 范文 | 小节标题含「范文/例文/作文/示范/立意/题目」，或整轮回答命中写作任务特征 | medium / low |',
  '| 其他 | 以上都不符 → **不收录**（此处留档） | — |',
  '',
  '## 未收录的「其他」条目（按会话归并）',
  '',
  '> 这些不是素材也不是范文，大多是普通问答。它们没有被复制到 `materials/`，但原文完整保留在对应 `chats/` 文件里。',
  '',
];
const dropByChat = {};
for (const d of dropped) {
  const id = d.split('　')[0];
  (dropByChat[id] = dropByChat[id] || []).push(d);
}
for (const [id, list] of Object.entries(dropByChat).sort((a, b) => b[1].length - a[1].length)) {
  report.push(`### ${id}（${list.length} 条）`);
  report.push('');
  for (const l of list) report.push(`- ${l}`);
  report.push('');
}
if (skipped.length) {
  report.push('## 小节导语未收录');
  report.push('');
  for (const s of skipped) report.push(`- ${s}`);
  report.push('');
}

if (!CHECK) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(path.join(OUT_DIR, '_素材抽取报告.md'), report.join('\n'), 'utf8');
  console.log(`\n已写入 materials/（${written.length} 个条目 + _素材抽取报告.md）`);
}
