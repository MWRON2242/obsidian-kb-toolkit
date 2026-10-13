/**
 * lib-anki-templates.mjs —— Anki「首背卡」笔记类型的单一来源
 *
 * 同时被两处使用，避免两处漂移：
 *   · tools/export-anki.mjs —— 渲染成给人看的模板文档
 *   · tools/anki-api.mjs    —— 通过 AnkiConnect 直接创建笔记类型
 *
 * 三张卡：①认词（英→中）②四选一（选项由 Choices 字段提供）③拼写（中→英，type:Word）
 */

export const FIELDS = ['Word', 'Meaning', 'Choices', 'Note', 'Source', 'Tags'];

export const CSS = `.card {
  font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  font-size: 20px; text-align: center; color: #222; background: #fafafa;
  padding: 24px 16px; line-height: 1.7;
}
.word { font-size: 40px; font-weight: 700; letter-spacing: .5px; margin-bottom: 8px; word-break: break-word; }
.prompt { font-size: 26px; font-weight: 600; margin-bottom: 14px; }
.mean { font-size: 26px; color: #1565c0; margin: 10px 0; }
.note { font-size: 16px; color: #b26a00; background: #fff7e0; border-radius: 8px; padding: 8px 10px; margin: 12px auto; max-width: 640px; }
.src  { font-size: 13px; color: #999; }
.opts { display: grid; gap: 10px; max-width: 560px; margin: 18px auto 0; }
.opt  { border: 1px solid #cfd8dc; background: #fff; border-radius: 10px; padding: 12px 14px; cursor: pointer; font-size: 18px; }
.opt:hover { border-color: #90a4ae; background: #f5f7f8; }
.opt.ok { border-color: #2e7d32; background: #e8f5e9; color: #1b5e20; font-weight: 700; }
.opt.no { border-color: #c62828; background: #ffebee; color: #b71c1c; }
.fb { margin-top: 14px; font-size: 18px; min-height: 24px; }
.fb.ok { color: #2e7d32; } .fb.no { color: #c62828; }`;

export const CARDS = [
  {
    name: '1. 认词（英→中）',
    front: `<div class="word">{{Word}}</div>
<div class="src">{{Source}}</div>`,
    back: `<div class="word">{{Word}}</div>
<div class="mean">{{Meaning}}</div>
{{#Note}}<div class="note">✏️ {{Note}}</div>{{/Note}}
<div class="src">{{Source}}</div>`,
  },
  {
    name: '2. 四选一（选释义）',
    front: `<div class="word">{{Word}}</div>
<div id="opts" class="opts"></div>
<div id="fb" class="fb"></div>
<script>
(function () {
  var raw = "{{Choices}}".split("|").map(function (s) { return s.trim(); }).filter(Boolean);
  var box = document.getElementById("opts"), fb = document.getElementById("fb");
  raw.forEach(function (text) {
    var correct = text.slice(-1) === "*";
    var label = correct ? text.slice(0, -1) : text;
    var b = document.createElement("div");
    b.className = "opt";
    b.textContent = label;
    b.onclick = function () {
      if (box.dataset.done) return;
      box.dataset.done = "1";
      b.className = "opt " + (correct ? "ok" : "no");
      fb.textContent = correct ? "✓ 正确" : "✗ 正确答案：{{Meaning}}";
      fb.className = "fb " + (correct ? "ok" : "no");
    };
    box.appendChild(b);
  });
})();
</script>`,
    back: `<div class="word">{{Word}}</div>
<div class="mean">{{Meaning}}</div>
{{#Note}}<div class="note">✏️ {{Note}}</div>{{/Note}}`,
  },
  {
    name: '3. 拼写（中→英）',
    front: `<div class="prompt">{{Meaning}}</div>
<div class="type">{{type:Word}}</div>`,
    back: `<div class="prompt">{{Meaning}}</div>
<div class="type">{{type:Word}}</div>
<hr>
<div class="mean">{{Word}}</div>
{{#Note}}<div class="note">✏️ {{Note}}</div>{{/Note}}`,
  },
];
