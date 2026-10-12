#!/usr/bin/env node
/**
 * install-obsidian-plugin.mjs —— 把 Obsidian 社区插件装进本库（不用打开 Obsidian 手动装）
 *
 * 做法：从 GitHub 的 `releases/latest/download/` 直链拉三个文件
 * （manifest.json / main.js / styles.css），放进 <vault>/.obsidian/plugins/<插件 id>/。
 * 之后你只需在 Obsidian 里「关闭受限模式 → 启用该插件」。
 *
 * 说明：api.github.com 在本机返回 403（限流/代理），所以这里**不用 API**，
 * 直接用 releases/latest/download 直链（实测可用）。
 *
 * 用法：
 *   node tools/install-obsidian-plugin.mjs st3v3nmw/obsidian-spaced-repetition
 *   node tools/install-obsidian-plugin.mjs <owner/repo> --vault=<vault 路径>
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const repo = argv.find((a) => !a.startsWith('--'));
const vaultArg = (argv.find((a) => a.startsWith('--vault=')) || '').split('=')[1];
const VAULT = vaultArg ? path.resolve(vaultArg) : path.resolve(import.meta.dirname, '..');
if (!repo || !repo.includes('/')) {
  console.error('用法: node tools/install-obsidian-plugin.mjs <owner/repo> [--vault=路径]');
  process.exit(1);
}

const BASE = `https://github.com/${repo}/releases/latest/download/`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';

const get = async (name) => {
  const r = await fetch(BASE + name, { redirect: 'follow', headers: { 'User-Agent': UA } });
  if (!r.ok) return null;
  return Buffer.from(await r.arrayBuffer());
};

console.log(`插件仓库：${repo}`);
console.log(`目标 vault：${VAULT}`);

const manifestBuf = await get('manifest.json');
if (!manifestBuf) {
  console.error('✗ 拉不到 manifest.json —— 检查仓库名，或该 release 没有标准三件套。');
  process.exit(1);
}
const manifest = JSON.parse(manifestBuf.toString('utf8'));
const dir = path.join(VAULT, '.obsidian', 'plugins', manifest.id);
mkdirSync(dir, { recursive: true });

const status = [];
for (const [name, buf] of [
  ['manifest.json', manifestBuf],
  ['main.js', await get('main.js')],
  ['styles.css', await get('styles.css')],
]) {
  if (!buf) {
    status.push(`  ${name.padEnd(14)} 跳过（该 release 没有这个文件，通常 styles.css 可以缺）`);
    continue;
  }
  writeFileSync(path.join(dir, name), buf);
  status.push(`  ✓ ${name.padEnd(14)} ${(buf.length / 1024).toFixed(1)} KB`);
}

console.log(`\n插件：${manifest.name}（id: ${manifest.id}，版本 ${manifest.version}）`);
console.log(`装到：${path.relative(VAULT, dir).split(path.sep).join('/')}`);
console.log(status.join('\n'));

console.log(`
接下来在 Obsidian 里做两步（我无法代劳 UI 操作）：
  1. 设置 → 第三方插件（社区插件）→ 关闭「受限模式」
  2. 「已安装插件」列表点刷新 → 找到「${manifest.name}」→ 启用`);

// 顺带体检：插件目录不该出现在图谱里
const appJson = path.join(VAULT, '.obsidian', 'app.json');
if (existsSync(appJson)) {
  try {
    JSON.parse(readFileSync(appJson, 'utf8'));
  } catch {
    console.log('\n⚠ .obsidian/app.json 不是合法 JSON，Obsidian 可能会忽略你的界面设置。');
  }
}
