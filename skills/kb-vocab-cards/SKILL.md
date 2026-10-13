---
name: kb-vocab-cards
description: 单词数据一更新就自动生成卡片 —— 一条命令跑完「重建词条 → 生成 Obsidian 复习卡（按来源分牌组、只增不改以保护复习进度）→ 导出 Anki 首背卡（认词/四选一/拼写）→ 经 AnkiConnect 推进 Anki」。含幂等验证、复习进度保护、新来源加牌组、修释义的安全做法与排错。当用户说"更新单词/新增词条/生成卡片/同步到 Anki"时使用。
whenToUse: 新增或修改英语单词、短语数据（照片笔记、对话导出、手工录入）后，需要生成或更新 Obsidian 复习卡与 Anki 首背卡时。
---

# 单词数据 → 卡片（自动化）

## 0. 一条命令

在**知识库根目录**执行：

```bash
node tools/update-cards.mjs
```

| 参数 | 作用 |
| --- | --- |
| `--dry` | 只报告会新增什么，不写盘（**建议先跑这个**） |
| `--no-anki` | 只更新 Obsidian 复习卡，不碰 Anki |
| `--scope=all` | Anki 导出全部词条（默认只导「照片笔记」那 47 条） |

它按顺序做四件事：

| 步骤 | 脚本 | 关键性质 |
| --- | --- | --- |
| 1 搬运词条 | `extract-vocab.mjs` | **整层重建** `vocab/`（可再生层，别手改） |
| 2 生成复习卡 | `make-review-cards.mjs` | **只增不改**：按出处插入新卡，绝不碰已有行（复习进度就写在行上） |
| 3 导出 Anki 首背卡 | `export-anki.mjs` | TSV 六列：`Word/Meaning/Choices/Note/Source/Tags`（四选一选项在 `Choices`） |
| 4 推进 Anki | `anki-api.mjs import` | 需 Anki 在运行 + AnkiConnect 插件；重复导入会自动跳过 |

跑完打一张**对账表**（数字必须能解释）：

```
词条      150 → 150　(0)
复习卡    150 张 → 150 张　(0)　复习进度 1 条（未动）
牌组      英语短语-照片笔记第一张图(25)　英语单词-单词翻译服务(87)　…
Anki      141 张 → 141 张　(0)
```

## 1. 铁律（违反会丢掉用户的学习记录）

1. **绝不用 `--rebuild`**：复习进度以 HTML 注释写在卡片行上（`<!--SR:!日期,间隔,难度-->`），重写整个文件 = 抹掉进度。默认流程永远是"只增"。
2. **`vocab/` 是派生层**：直接改 `vocab/*.md` 没用，下次 `extract-vocab` 会覆盖。要改内容就改**源头**（`inbox/` 的录入原件、或对话原文）。
3. **跑完必须看对账表**：`复习进度` 条数一旦变化 = 出事了，立刻停下检查 `review/`。
4. **不要把 `review/` 下的牌组文件改名**：进度留在旧文件里，改名等于让它与牌组脱钩（要改名得连行一起迁移，参照 `--migrate` 的做法）。
5. `inbox/` 是**录入原件**：新增材料用新文件，不改旧文件。

## 2. 常见情形

### A. 新增了一批词（照片笔记 / 对话 / 手工录入）
```bash
# 1) 原始材料放好：照片笔记转录 → inbox/新笔记.md；对话 → chats/（用 ds-chat-export.mjs）
node tools/scan.mjs --root=inbox      # 登记（可选，让 catalog 也记得）
node tools/update-cards.mjs --dry     # 先看会新增几张
node tools/update-cards.mjs           # 出卡片：Obsidian 牌组 + Anki TSV + Anki 导入
```
卡片按**出处**自动进对应牌组。

### B. 出现了新来源（新一批笔记）→ 要新建牌组
第一次跑完看对账表末尾的警告：**有词条落进「其他」牌组** = 出处没匹配上。
在 `tools/make-review-cards.mjs` 的 `DECKS` 数组加一条，再重跑：
```js
{ key: '新批次', file: '英语短语-新批次.md', title: '英语短语 · 新批次',
  match: (s) => s.includes('你的新出处关键字') },
```
Anki 侧同理：`--scope=<出处关键字>`（或 `--scope=all`）。
⚠️ **不要**改已有牌组的 `file` 名（会丢进度，见铁律 4）。

### C. 修正某个词的释义／批注
卡片行"只增不改"，所以**改源头不会自动更新已有卡片行**。安全做法：
- 用 `edit` 工具只改 **`:::` 后半段**（释义），**保留行尾或下一行的 `<!--SR:…-->` 注释**；
- 若该卡在 Anki 里也有，改完 `export-anki.mjs` 重导会**跳过**（Anki 认为重复）—— 要更新 Anki 里的旧卡，得在 Anki 里直接改，或删掉重导。

### D. 只要更新 Obsidian，不动 Anki
`node tools/update-cards.mjs --no-anki`

## 3. 验证手法（每次更新后都做）

```bash
node tools/update-cards.mjs --dry      # 预期：明确的"新增 N 张"
node tools/update-cards.mjs            # 真跑
node tools/update-cards.mjs            # 再跑一次：应全是 (0) —— 证明幂等、没重复卡
node tools/anki-api.mjs check          # Anki 侧核对：笔记数 / 卡片数 / 每模板张数
```

**卡片数核对公式**：Anki 卡片数 = 笔记数 × 模板数（本库模板 3 张：认词 / 四选一 / 拼写）。
例：47 条笔记 → 141 张卡。数字对不上就查 `references/troubleshooting.md`。

## 4. 出问题怎么办

见 `references/troubleshooting.md`，覆盖：AnkiConnect 不通 / 卡片全落进「系统默认」卡组 / 出现重复卡 / 复习进度疑似丢失 / 词条没被识别 / 牌组张数不对。

## 5. 已实测的事实（可当基线）

- 新增词条的插入路径：新词进对应牌组的字母分节，旧卡张数不变，**进度注释完好**；再跑 = 新增 0。
- 全流程幂等：词条 / 复习卡 / Anki 卡片全为 `(0)`，`复习进度 1 条（未动）`。
- 重复导入的返回是"**成功 0 条，跳过 N 条**"（靠 `allowDuplicate:false` + `duplicateScope:deck`），不是报错。
- `update-cards.mjs` 子进程用 `stdio:'inherit'`：受限沙箱下**不能给原生程序接管道**（`pipe` 会 EPERM），所以统计不靠子进程输出，而是自己数前后差值。
