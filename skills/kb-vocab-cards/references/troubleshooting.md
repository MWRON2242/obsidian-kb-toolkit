# 排错参考：单词 → 卡片

> 由 skill `kb-vocab-cards` 按需加载。所有命令都在**知识库根目录**执行。
> 前提：不要给原生命令加管道或重定向（受限沙箱会拦；`> $null` 会让命令**根本不执行**）。

## 1. AnkiConnect 不通（`anki-api.mjs` 报「连不上」）

按顺序查：

```bash
node tools/anki-api.mjs ping          # 最直接的自检
node tools/install-anki-connect.mjs   # 没装就装（已装会提示"无需重复安装"）
```

| 检查 | 怎么做 |
| --- | --- |
| Anki 在运行吗 | 任务管理器里应有 `Anki.exe`；没开就先打开 |
| 插件装了吗 | Anki → 工具 → 插件，列表里应有 **AnkiConnect** |
| **装完重启了吗** | 插件只在启动时加载 —— 这是最常见的原因 |
| 端口 | `http://127.0.0.1:8765` 只对本机开放；被别的程序占用会失败 |
| 启动报插件错误 | 删掉 `%APPDATA%\Anki2\addons21\2055492159\`，重启 Anki，改走**手动导入**（见 §9） |

安装器做了两件容易被忽略的事：源码 zip 里**没有 manifest.json**（官方仓库靠 Anki 的兼容逻辑），所以它**补写了一个**；并且用 `taskkill`（不带 `/F`）优雅关闭 Anki 再启动，避免强杀导致数据库锁。

## 2. 卡片全落进了「系统默认」卡组

**实测 bug**：本机 AnkiConnect（API 6 + Anki 26.9.3）里 `addNotes` 的 `deckName` **不生效**。

- 现在 `anki-api.mjs import` 会**自动用 `changeDeck` 把刚加的卡片搬进目标卡组**，所以正常流程遇不到。
- 若是历史遗留的错位卡片，手动搬：
  ```bash
  node tools/anki-api.mjs move --deck="英语::照片笔记首背" --tag=首背
  ```
- 核对：`node tools/anki-api.mjs check`，看「按卡组」那一行。

## 3. 出现重复卡（同一个词两张卡）

`import` 用 `allowDuplicate:false` + `duplicateScope:'deck'`，重复导入的返回是「**成功 0 条，跳过 N 条**」——**这是正常的，不是报错**。

真的出现重复时：
1. `node tools/anki-api.mjs search --q="Word:某个词"` 看有几张卡
2. 在 Anki 里手动删掉多余的那张（或用 AnkiConnect 的 `deleteNotes`）
3. 以后每次都跑两遍验证：第二遍应全是 `(0)`

## 4. 复习进度疑似丢失（最严重）

**症状**：`update-cards.mjs` 对账表里 `复习进度` 条数变少；或 Obsidian 里卡片的排程重置了。

立刻做：

```bash
# 1) 全库找进度注释，看还剩多少条（用 agent 的 grep 工具搜 `<!--SR:`；命令行可用 findstr）
findstr /C:"<!--SR:" review\*.md

# 2) 找备份（拆分/改动前的快照都在这里）
ls digests/backup/
```

- 进度**只存在于卡片行上的 HTML 注释里**，没有第二份。唯一可靠的恢复来源是 `digests/backup/` 里的快照，或 Obsidian/文件系统的历史版本。
- **`--rebuild` 会删掉所有进度**，除用户明确要求重置，绝不使用。
- 每次跑完都要看对账表里的 `复习进度 N 条（未动）` —— 这个数字变了就是出事了。

## 5. 词条没被识别（新词没进 vocab）

1. 看 `vocab/_单词抽取报告.md` 里的「未识别但形似词条：N 行」—— 那里列了被跳过的候选行。
2. 手工录入（`inbox/`）的识别规则：**英文 + 中文**成对出现；英文**不超过 10 个单词**；行首序号（`1.`、`A.`）会自动去掉；用 `→`／`—`／`：` 等分隔符都行。
3. 对话来源只扫带 `--tag=英语` 的会话（默认），漏了就 `--all-chats`：
   ```bash
   node tools/extract-vocab.mjs --all-chats --check    # 先看数量有没有变化
   ```

## 6. 牌组张数不对 / 词条跑进「其他」

- **核对公式**：词条数 = 各牌组张数之和；Anki 卡片数 = 笔记数 × 模板数（本库 3 张模板）。
- 对账表末尾若提示「有 N 个词条落到了『其他』牌组」= 出现了新出处，去 `make-review-cards.mjs` 的 `DECKS` 加映射（见 SKILL.md §2.B）。
- 张数少了：多半是 `vocab/` 被改过又被 `extract-vocab` 覆盖 → 改源头，别改 `vocab/`。

## 7. 千万不要重命名 `review/` 下的牌组文件

进度写在卡片行上，**改名 = 新建一个空文件**，旧文件（连同进度）变成孤儿：Obsidian 里看不到那一批卡，Anki 里可能重复导入。

要改名/拆组：必须**连行一起迁移**（`make-review-cards.mjs --migrate` 就是这么做的：按卡片的 `:::` 前缀匹配，把「卡片行 + 紧随的进度注释行」整体搬走，再归档旧文件并**去掉它的 `#flashcards` 标签**，避免变成重复牌组）。

## 8. 看起来像 bug 但其实是正常的

| 现象 | 真相 |
| --- | --- |
| 拼写卡正面显示 `[[type:Word]]` | 这是 Anki 的占位标记，`reviewer.js` 在实际复习时把它替换成输入框（已在 Anki 安装目录的 `js/reviewer.js` 里确认 `typeans` 处理） |
| Anki 里只看得到 20 张卡 | 默认**每日新卡上限 20**：卡组 → 齿轮 → 选项 → 每日上限 |
| Anki 改了释义，Obsidian 没变 | 两边是**同源但独立**的两套进度/内容，不会互相同步（这是设计，不是 bug） |
| Obsidian 里牌组列表没更新 | `Ctrl+P` → `Reload app without saving` |
| `update-cards.mjs` 再跑一次全是 (0) | 这正是**幂等**，说明没有重复卡，是好现象 |

## 9. 不想用 AnkiConnect 了

- 卸载：Anki → 工具 → 插件 → AnkiConnect → 删除（或删 `%APPDATA%\Anki2\addons21\2055492159\`）。**已导入的卡片不受影响。**
- 之后改用手动导入：`node tools/export-anki.mjs` 生成 TSV → Anki → 文件 → 导入 → 选 `digests/anki/照片笔记-首背卡.tsv` → 笔记类型 `词汇首背`（建法见 `digests/anki/Anki-首背卡模板.md`）。
- 只想更新 Obsidian 时用 `update-cards.mjs --no-anki`。

## 10. 一线排查顺序（照这个走最快）

```
1. node tools/update-cards.mjs --dry        # 看会不会新增、有没有报错
2. node tools/update-cards.mjs              # 真跑
3. node tools/update-cards.mjs              # 再跑：应全 (0)
4. node tools/anki-api.mjs check            # Anki 侧：笔记 / 卡片 / 模板分布
5. findstr /C:"<!--SR:" review\*.md         # 进度条数（应与上次一致）
```
