#!/usr/bin/env node
/**
 * fetch-share.mjs —— 抓取 DeepSeek 分享链接（chat.deepseek.com/share/<id>）的内容
 *
 * 背景：分享页是 JS 渲染的单页应用，直接 GET HTML 只能拿到壳。本脚本分三步尝试：
 *   1. 抓 HTML，找 SSR 内嵌的初始数据（__NEXT_DATA__ / self.__next_f / window.__*）
 *   2. 找页面里的 JS bundle，grep 出分享相关的 API 路径
 *   3. 用找到的 API 直接取会话 JSON（可能需要登录态，会如实报告）
 *
 * 用法：
 *   node tools/fetch-share.mjs https://chat.deepseek.com/share/xxxx
 *   node tools/fetch-share.mjs https://chat.deepseek.com/share/xxxx --save
 */
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const KB = path.resolve(import.meta.dirname, '..');
const TMP = path.join(KB, '.share-probe');
const url = process.argv[2];
const SAVE = process.argv.includes('--save');
if (!url) {
  console.error('用法: node tools/fetch-share.mjs <分享链接> [--save]');
  process.exit(1);
}
const id = (url.match(/share\/([A-Za-z0-9_-]+)/) || [])[1] || 'unknown';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const get = async (u, extra = {}) => {
  const res = await fetch(u, {
    headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'zh-CN,zh;q=0.9', ...extra },
    redirect: 'follow',
  });
  const text = await res.text();
  return { status: res.status, type: res.headers.get('content-type') || '', text };
};

console.log(`分享 id: ${id}`);
const page = await get(url);
console.log(`1) 页面：HTTP ${page.status}　content-type: ${page.type}　长度 ${page.text.length}`);

// —— 找内嵌初始数据 ——
const markers = ['__NEXT_DATA__', 'self.__next_f', 'window.__INITIAL', 'window.__NUXT__', 'window.__DATA', 'share_id', 'fragments', 'mapping'];
const found = markers.filter((m) => page.text.includes(m));
console.log(`   内嵌数据标记命中：${found.length ? found.join(', ') : '（无）'}`);

// —— 找 JS bundle ——
const srcs = [...page.text.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1]);
console.log(`2) 页面 script 数量：${srcs.length}`);
for (const s of srcs.slice(0, 8)) console.log(`   ${s.startsWith('http') ? s : new URL(s, url).href}`);
console.log(`   页面首 300 字符：${page.text.slice(0, 300).replace(/\s+/g, ' ')}`);

// —— 试探常见的分享 API ——
const candidates = [
  `/api/v0/chat/share_conversation?share_id=${id}`,
  `/api/v0/share/conversation?share_id=${id}`,
  `/api/v0/chat/get_share_conversation?share_id=${id}`,
  `/api/v0/chat/share_detail?share_id=${id}`,
  `/api/v0/chat/history_messages?share_id=${id}`,
  `/api/v0/chat/conversation_share_info?share_id=${id}`,
];
console.log('3) 试探 API：');
for (const c of candidates) {
  const u = new URL(c, 'https://chat.deepseek.com').href;
  try {
    const r = await get(u, { Accept: 'application/json, text/plain, */*', Referer: url });
    const head = r.text.slice(0, 120).replace(/\s+/g, ' ');
    const isJson = r.text.trim().startsWith('{') || r.text.trim().startsWith('[');
    console.log(`   ${r.status} ${isJson ? 'JSON' : 'HTML'}  ${c}`);
    console.log(`        ${head}`);
    if (isJson && SAVE) {
      if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
      writeFileSync(path.join(TMP, `${id}${c.replace(/[^a-z_]/gi, '_').slice(0, 40)}.json`), r.text, 'utf8');
    }
  } catch (e) {
    console.log(`   ERR ${c}　${e.message}`);
  }
}
if (!existsSync(TMP)) mkdirSync(TMP, { recursive: true });
writeFileSync(path.join(TMP, `${id}-page.html`), page.text, 'utf8');
console.log(`\n页面 HTML 已存到 ${path.relative(KB, path.join(TMP, `${id}-page.html`))}`);
