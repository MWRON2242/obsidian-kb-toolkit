# __NAME__

> 由 `kb-starter` 于 __DATE__ 搭起骨架。本文件是用法说明；**硬规则见 `AGENTS.md`**（agent 会自动加载它）。

## 三层架构

```
原件（磁盘上的文件，只读）  >  notes/ 摘要卡（人+agent 写）  >  index/ 派生索引（脚本生成）
```

**只登记路径，不复制原件。** 派生层可以随时重建；`notes/` 与 `review/` 是你的资产。

## 目录

| 目录 | 是什么 | 手改 |
| --- | --- | --- |
| `notes/` | 摘要卡（一张卡=一份文档/一个会话） | ✅ |
| `index/` | `catalog.jsonl` 目录、`INDEX.md` 总索引、`tags.md` 标签词表 | ❌ 脚本生成（tags.md 例外） |
| `cache/text/` | 从原件抽出的正文（供检索与核对） | ❌ |
| `chats/` | 对话导出转换来的原文 | ❌ |
| `inbox/` | 手工录入的原始材料 | ⚠️ 录入后不改 |
| `materials/` `vocab/` | 逐字搬运的素材 / 英语词条 | ❌ 脚本重跑覆盖 |
| `review/` | 背单词复习卡（**进度写在卡片行尾**） | ⚠️ 只增不改 |
| `digests/` | 成品：综述、润色稿、导出的 Word/Excel | ✅ |
| `fulltext/` `external/` | 搜索用副本 / 外部库镜像 | ❌ |

## 日常命令

```bash
node tools/scan.mjs                 # 登记新文件（改 sources.json 后跑）
node tools/extract-text.mjs --all   # 抽正文
node tools/link-notes.mjs           # 校验卡片 + 回填 catalog
node tools/build-index.mjs          # 重建总索引
node tools/obsidian-sync.mjs        # 同步到 Obsidian（别名/全文层/首页）
node tools/status.mjs               # 一屏看板（例行）
node tools/search.mjs 关键词         # 检索
```

深度体检：`obsidian-check.mjs`、`check-yaml.mjs --all`、`check-math.mjs --quiet`。

## 在 Obsidian 里打开

1. Obsidian → 打开其他库 → **打开文件夹作为库** → 选择本目录
2. 或浏览器：`obsidian://open?path=<URL 编码后的库路径>`

**想背单词**：`node tools/install-obsidian-plugin.mjs st3v3nmw/obsidian-spaced-repetition`，然后在 Obsidian 里关闭"受限模式"并启用该插件；`make-review-cards.mjs` 会把 `vocab/` 的词补成复习卡。

## 常见坑

**不要给原生命令加管道或重定向**（`| Out-String`、`> $null`）：在受限沙箱里会失败，而 `> $null` 会让命令**根本不执行**。
其余坑见 skill `kb-starter` 的 `references/pitfalls.md`，运维见 `kb-longterm-ops`。
