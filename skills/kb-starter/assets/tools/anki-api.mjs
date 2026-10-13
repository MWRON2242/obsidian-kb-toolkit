#!/usr/bin/env node
/**
 * anki-api.mjs —— 通过 AnkiConnect（http://127.0.0.1:8765）把首背卡直接推进 Anki
 *
 * 前提：Anki 正在运行，且已装 AnkiConnect 插件（tools/install-anki-connect.mjs）。
 *
 * 用法：
 *   node tools/anki-api.mjs ping
 *   node tools/anki-api.mjs import --tsv=digests/anki/照片笔记-首背卡.tsv
 *        [--deck="英语::照片笔记首背"] [--model="词汇首背"] [--dry]
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { FIELDS, CSS, CARDS } from './lib-anki-templates.mjs';

const KB = path.resolve(import.meta.dirname, '..');
const URL = 'http://127.0.0.1:8765';
const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('--')) || 'ping';
const opt = (n, d = '') => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3).replace(/^"|"$/g, '') : d;
};
const DRY = argv.includes('--dry');

async function invoke(action, params = {}) {
  let r;
  try {
    r = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, version: 6, params }),
    });
  } catch (e) {
    throw new Error(`连不上 AnkiConnect（${URL}）：${e.message}`);
  }
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(`${action} → ${j.error}`);
  return j.result;
}

const fail = (msg) => {
  console.error(`✗ ${msg}`);
  console.error(`
排查：
  1) Anki 是否在运行？（任务管理器里应有 Anki.exe）
  2) 插件是否装了？  node tools/install-anki-connect.mjs
  3) 装完必须**重启 Anki**（工具 → 插件 里应能看到 AnkiConnect）
  4) 若 Anki 启动时报插件错误：删掉下面这个目录再重启，然后改用手动导入
     ${path.join(process.env.APPDATA || '', 'Anki2', 'addons21', '2055492159')}`);
  process.exit(1);
};

/* ---------- ping ---------- */
if (cmd === 'ping') {
  let v;
  try {
    v = await invoke('version');
  } catch (e) {
    fail(e.message);
  }
  const decks = await invoke('deckNames');
  const models = await invoke('modelNames');
  console.log(`✓ AnkiConnect 在线　API 版本 ${v}`);
  console.log(`  现有卡组 ${decks.length} 个：${decks.slice(0, 8).join('、')}${decks.length > 8 ? ' …' : ''}`);
  console.log(`  现有笔记类型 ${models.length} 个：${models.slice(0, 8).join('、')}${models.length > 8 ? ' …' : ''}`);
  process.exit(0);
}

/* ---------- import ---------- */
if (cmd === 'import') {
  const TSV = path.resolve(KB, opt('tsv', 'digests/anki/照片笔记-首背卡.tsv'));
  const DECK = opt('deck', '英语::照片笔记首背');
  const MODEL = opt('model', '词汇首背');
  if (!existsSync(TSV)) fail(`找不到 TSV：${TSV}`);

  const lines = readFileSync(TSV, 'utf8').replace(/\r/g, '').split('\n').filter(Boolean);
  const header = lines.shift().split('\t');
  const rows = lines.map((l) => {
    const c = l.split('\t');
    const o = {};
    header.forEach((h, i) => (o[h] = c[i] ?? ''));
    return o;
  });
  console.log(`待导入：${rows.length} 条（表头 ${header.join(' / ')}）`);

  let v;
  try {
    v = await invoke('version');
  } catch (e) {
    fail(e.message);
  }
  console.log(`✓ AnkiConnect 在线（API ${v}）`);

  // 卡组
  const decks = await invoke('deckNames');
  if (!decks.includes(DECK)) {
    if (DRY) console.log(`[dry] 会创建卡组 ${DECK}`);
    else {
      await invoke('createDeck', { deck: DECK });
      console.log(`✓ 已创建卡组 ${DECK}`);
    }
  } else console.log(`· 卡组已存在 ${DECK}`);

  // 笔记类型
  const models = await invoke('modelNames');
  if (!models.includes(MODEL)) {
    if (DRY) console.log(`[dry] 会创建笔记类型 ${MODEL}（${FIELDS.length} 字段 / ${CARDS.length} 张卡）`);
    else {
      await invoke('createModel', {
        modelName: MODEL,
        inOrderFields: FIELDS,
        css: CSS,
        isCloze: false,
        cardTemplates: CARDS.map((c) => ({ Name: c.name, Front: c.front, Back: c.back })),
      });
      console.log(`✓ 已创建笔记类型 ${MODEL}：字段 ${FIELDS.join('/')}，卡片「${CARDS.map((c) => c.name).join('、')}」`);
    }
  } else {
    const tpl = await invoke('modelTemplates', { modelName: MODEL });
    const names = Object.keys(tpl);
    console.log(`· 笔记类型已存在 ${MODEL}（${names.length} 张卡：${names.join('、')}）`);
    if (names.length < CARDS.length) console.log(`  ⚠ 卡片数少于模板定义的 ${CARDS.length} 张，可考虑在 Anki 里手动补`);
  }

  // 笔记
  const notes = rows.map((r) => ({
    deckName: DECK,
    modelName: MODEL,
    fields: {
      Word: r.Word || '',
      Meaning: r.Meaning || '',
      Choices: r.Choices || '',
      Note: r.Note || '',
      Source: r.Source || '',
      Tags: r.Tags || '',
    },
    tags: ['英语', '首背', ...(r.Tags ? r.Tags.split('::').filter((t) => t && t !== '英语' && t !== '首背') : [])],
    options: { allowDuplicate: false, duplicateScope: 'deck' },
  }));

  if (DRY) {
    console.log(`[dry] 会添加 ${notes.length} 条笔记（每条生成 ${CARDS.length} 张卡）`);
    process.exit(0);
  }

  const res = await invoke('addNotes', { notes });
  const ids = res.filter((x) => x !== null);
  const ok = ids.length;
  const dup = res.length - ok;
  console.log(`✓ addNotes 返回：成功 ${ok} 条${dup ? `，跳过 ${dup} 条（重复或字段为空）` : ''}`);

  // 实测坑：本机 AnkiConnect（API 6）里 addNotes 的 deckName 不生效，卡片会落进「系统默认」。
  // 所以这里显式用 changeDeck 把刚加的笔记产生的卡片搬进目标卡组。
  if (ids.length) {
    const cards = await invoke('findCards', { query: ids.map((id) => `nid:${id}`).join(' or ') });
    if (cards.length) {
      await invoke('changeDeck', { cards, deck: DECK });
      console.log(`✓ 已把 ${cards.length} 张卡片归入卡组「${DECK}」（绕开 addNotes 的 deckName 失效问题）`);
    }
  }

  const TAG = opt('tag', '首背');
  const found = await invoke('findCards', { query: `tag:${TAG}` });
  console.log(`· 标签 tag:${TAG} 下现有卡片 ${found.length} 张`);
  console.log(`
在 Anki 里：左侧卡组列表选「${DECK.replace(/::/g, ' › ')}」→ 点「学习」开始。`);
  process.exit(0);
}

/* ---------- check：核对导入结果 ---------- */
if (cmd === 'check') {
  const DECK = opt('deck', '英语::照片笔记首背');
  let v;
  try {
    v = await invoke('version');
  } catch (e) {
    fail(e.message);
  }
  console.log(`✓ AnkiConnect 在线（API ${v}）\n`);

  const decks = await invoke('deckNames');
  console.log(`卡组总数 ${decks.length}，其中包含目标卡组：${decks.includes(DECK) ? '是 ✓' : '否 ✗'}`);
  console.log('  全部卡组：' + decks.join(' | ') + '\n');

  // 用标签查（比 deck: 查询更稳，中文与 :: 都不会干扰）
  const byTag = await invoke('findNotes', { query: 'tag:首背' });
  console.log(`标签 tag:首背 命中笔记：${byTag.length} 条`);
  const byField = await invoke('findNotes', { query: 'Word:under*' });
  console.log(`字段 Word:under* 命中笔记：${byField.length} 条\n`);

  if (byTag.length) {
    const info = await invoke('notesInfo', { notes: byTag.slice(0, 2) });
    for (const n of info) {
      console.log(`笔记 #${n.noteId}`);
      for (const [k, val] of Object.entries(n.fields)) {
        const text = String(val.value || '').replace(/\s+/g, ' ').slice(0, 60);
        console.log(`   ${k.padEnd(8)} ${text}`);
      }
      console.log(`   标签     ${n.tags.join(', ')}`);
    }
    const cards = await invoke('findCards', { query: 'tag:首背' });
    const tplNames = Object.keys(await invoke('modelTemplates', { modelName: opt('model', '词汇首背') }));
    const info2 = await invoke('cardsInfo', { cards });
    const byTpl = {};
    const byDeck = {};
    for (const c of info2) {
      const t = tplNames[c.ord] || `ord ${c.ord}`;
      byTpl[t] = (byTpl[t] || 0) + 1;
      byDeck[c.deckName] = (byDeck[c.deckName] || 0) + 1;
    }
    console.log(`\n卡片总数 ${cards.length}`);
    console.log('  按卡组：' + Object.entries(byDeck).map(([d, n]) => `${d} ${n} 张`).join('　'));
    console.log('  按模板：' + Object.entries(byTpl).map(([t, n]) => `${t} ${n} 张`).join('　'));

    // 渲染同一个词的 3 张卡，验证模板（含四选一 JS）真的生效
    const oneNote = (await invoke('notesInfo', { notes: byTag.slice(0, 1) }))[0];
    const itsCards = await invoke('findCards', { query: `nid:${oneNote.noteId}` });
    const ci = await invoke('cardsInfo', { cards: itsCards });
    console.log(`\n样例词「${oneNote.fields.Word.value}」的 ${ci.length} 张卡实际渲染（已剥掉 CSS）：`);
    for (const c of ci.sort((a, b) => a.ord - b.ord)) {
      const q = c.question.replace(/<style>[\s\S]*?<\/style>/gi, '').replace(/\s+/g, ' ').trim();
      console.log(`\n  ── [${tplNames[c.ord] || c.ord}] ──`);
      console.log(`     正面: ${q.slice(0, 200)}`);
      // 用 JS 里的唯一标识判断，避免被 CSS 的 .opt/.opts 类名误导
      const hasJs = /getElementById\("opts"\)/.test(c.question);
      const isType = /type="text"|type:Word|id="typeans"/.test(c.question);
      if (hasJs) console.log('     ✓ 含四选一交互脚本');
      if (isType) console.log('     ✓ 含拼写输入框');
    }
  }
  process.exit(0);
}

/* ---------- move：把卡片挪到目标卡组 ----------
   实测：本机 AnkiConnect（API 6 + Anki 26.9.3）里 addNotes 的 deckName 不生效，
   卡片会落进「系统默认」，所以导入后用 changeDeck 显式搬一次。 */
if (cmd === 'move') {
  const DECK = opt('deck', '英语::照片笔记首背');
  const TAG = opt('tag', '首背');
  let v;
  try {
    v = await invoke('version');
  } catch (e) {
    fail(e.message);
  }
  const decks = await invoke('deckNames');
  if (!decks.includes(DECK)) {
    await invoke('createDeck', { deck: DECK });
    console.log(`✓ 已创建卡组 ${DECK}`);
  }
  const cards = await invoke('findCards', { query: `tag:${TAG}` });
  if (!cards.length) fail(`标签 tag:${TAG} 没有卡片`);
  const info = await invoke('cardsInfo', { cards: [cards[0]] });
  console.log(`卡片字段名（供排查）：${Object.keys(info[0]).join(', ')}`);
  await invoke('changeDeck', { cards, deck: DECK });
  const after = await invoke('cardsInfo', { cards: cards.slice(0, 3) });
  console.log(`✓ 已把 ${cards.length} 张卡片挪到「${DECK}」（API ${v}）`);
  for (const c of after) console.log(`   卡 #${c.cardId}　卡组「${c.deckName}」　队列 ${c.queue}`);
  const all = await invoke('cardsInfo', { cards });
  const byDeck = {};
  for (const c of all) byDeck[c.deckName] = (byDeck[c.deckName] || 0) + 1;
  console.log(`   现分布：${Object.entries(byDeck).map(([d, n]) => `${d} ${n} 张`).join('　')}`);
  process.exit(0);
}

/* ---------- search：直接跑一个 Anki 查询（排查用） ---------- */
if (cmd === 'search') {
  const q = opt('q') || argv.find((a) => !a.startsWith('--') && a !== 'search') || '';
  if (!q) fail('用法：node tools/anki-api.mjs search --q="tag:首背"');
  try {
    await invoke('version');
  } catch (e) {
    fail(e.message);
  }
  const cards = await invoke('findCards', { query: q });
  console.log(`查询：${q}\n命中卡片 ${cards.length} 张`);
  if (cards.length) {
    const info = await invoke('cardsInfo', { cards: cards.slice(0, 3) });
    for (const c of info) console.log(`   #${c.cardId}　卡组「${c.deckName}」　note ${c.note}　ord ${c.ord}`);
  }
  process.exit(0);
}

console.error(`未知命令：${cmd}（可用：ping / import / check / move / search）`);
process.exit(1);
