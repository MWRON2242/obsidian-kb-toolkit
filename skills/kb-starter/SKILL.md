---
name: kb-starter
description: 从零搭建「个人知识库 + Obsidian vault + agent 流水线」的开箱工具包 —— bootstrap 建骨架、34 个工具脚本、AGENTS/tags/sources/README 模板、新库验收脚本，外加建库踩坑全清单与平台注意事项。当用户要在新机器或新目录从零建知识库、或要把一批散落文档（PDF/Word/对话导出/照片笔记）整理成可检索卡片体系时使用。
whenToUse: 新建知识库、把散落文件整理成卡片库、Obsidian vault 自动化、批量抽取与摘要、对话导出导入。
---

# kb-starter：从零建一个知识库

## 0. 流程一览

```
bootstrap 建骨架 → verify-fresh 验收 → scan 登记 → extract-text 抽正文
→ 写 notes/ 卡片 → link-notes / build-index / obsidian-sync → status 看板 → check-* 深度体检
```

## 1. 第 0 步：建骨架（**先问用户库放哪**，别自己猜路径）

```bash
node <skill目录>/scripts/bootstrap.mjs --kb="<知识库路径>" --name="<名字>" --roots="<原件目录1>,<原件目录2>" [--dry]
```

DSH 里 skill 目录通常是 `C:\Users\<用户>\.dsh\skills\kb-starter`；其他 agent 应用请用实际安装路径。

它会建 12 个目录、拷 34 个工具、写 `AGENTS.md`/`index/tags.md`/`README.md`/`.gitignore`/`tools/sources.json`（把 `__KB__` 等占位换成实际值）。
**只补缺失，不删不改**；已存在的文件跳过（`--force` 才覆盖）；`--dry` 只打印计划。

## 2. 第 1 步：验收骨架（不要跳过）

```bash
node "<知识库>/tools/verify-fresh.mjs" --kb="<知识库>"
```

查 8 项：目录齐全 / 核心工具在位 / **全部脚本 `node --check` 通过** / 模板占位已替换 / 无 BOM / `sources.json` 可解析 / 流水线自检（`status.mjs` 能跑）/ 插件（可选）。**有 ✗ 就先修，别急着建卡。**

## 3. 三层架构（必须照做，否则后面全乱）

- `原件 > notes/ 摘要卡 > index/ 派生索引`；**只登记路径，不复制原件**。
- 派生层（`cache/`、`fulltext/`、`materials/`、`vocab/`）随便重建；
  **用户资产不可覆盖**：`notes/` 的手写卡片、`review/` 的复习进度（进度以 HTML 注释写在卡片行尾，只能只增不改）。
- 抽取类产物一律「**搬运而非重写**」：正文是原文逐字片段，脚本只切分与贴标签。

## 4. 工具分组（`assets/tools/`，34 个）

| 组 | 脚本 |
| --- | --- |
| 登记与抽取 | `scan` `extract-text` `install-dep`（npm 坏掉时用 Node 直连装依赖） |
| 卡片与索引 | `link-notes` `build-index` `search` `status` |
| Obsidian | `obsidian-sync` `obsidian-check` `fix-id-links` `install-obsidian-plugin` `link-obsidian-vault` |
| 体检 | `check-yaml` `check-math` `check-docx` `render-math-body` |
| 派生物 | `extract-materials` `build-material-index` `extract-vocab` `make-review-cards` |
| 成品导出 | `lib-docx`（零依赖 docx 生成）+ `export-csv-docx` |
| 对话导出（可选） | `ds-chat-find` `ds-chat-export` `ds-chat-batches` `ds-chat-analyze` `fetch-share` + `topic-profiles.json` |
| 主题汇总（示例，按学科改关键词） | `digest-math` `digest-english` `digest-essay` |

## 5. 铁律（**踩过的坑，详见 `references/pitfalls.md`**）

1. **原生命令裸跑**：不加管道/重定向 —— 受限沙箱会拦；`> $null` 会让命令**根本不执行**（最难发现的坑）。
2. **抽取 0 字或乱码 → `needs-ocr`**：绝不凭文件名编内容；乱码用 CJK 占比判定（别被"抽出 4872 字"骗过）。
3. **新解析器先跑 3 个样本**，确认切得干净再全量（实测小样一次抓到 2 个误判）。
4. **先写验收器再写生成器**：没有 `--check` 模式的生成器不要信。
5. **Obsidian**：文件名全库唯一；链接写 `[[完整文件名|显示]]`，**绝不只写 `[[id]]`**（解析失败会新建空笔记并抢走别名）；front matter 与反引号里的公式永不渲染。
6. **透明度 > 自动化**：产物带 `conf` 分级与 `anchor` 行号，并输出「未收录清单」——漏必须可见。

## 6. 平台注意

见 `references/platform-notes.md`：哪些坑是 Windows/DSH 专属、哪些平台无关（换 macOS/Linux 时要删哪些条目）。

## 7. 深入（按需加载，别一次全读）

- `references/pitfalls.md` —— 建库踩坑全清单（症状 → 根因 → 修法），6 大类约 30 条
- `references/platform-notes.md` —— 平台相关性标注
- 长线运维（四类新内容接入、故障排查、备份回滚）→ 用 skill **`kb-longterm-ops`**
