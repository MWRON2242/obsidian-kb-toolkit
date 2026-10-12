/**
 * lib-docx.mjs —— 最小可用的 .docx（OOXML）生成器，零依赖
 *
 * 自己拼 OOXML + 自己打 ZIP，不依赖任何 npm 包（本机 npm 不可用）。
 * 支持：标题/段落/小字说明、带边框与表头重复的表格、斑马纹、中文/西文分别指定字体、
 *      页脚页码、A4 页面与页边距。产物 Word / WPS 均可直接打开。
 *
 * 用法：
 *   import { buildDocx } from './lib-docx.mjs';
 *   const buf = buildDocx({ title, footer: true, blocks: [...] });
 *   writeFileSync('out.docx', buf);
 *
 * blocks 支持：
 *   { type:'title'|'h1'|'h2'|'p'|'small', text|runs }
 *   { type:'table', widths:[cm...], header:[cells], rows:[[cells...]], zebra:true }
 *   cell 写法：'文本' 或 { t:'文本', b:true, kai:true, hei:true, sz:10.5, al:'center' }
 */
import zlib from 'node:zlib';

/* ---------------- ZIP ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};

function zip(files) {
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 文件名标志
    lh.writeUInt16LE(8, 8); // deflate
    lh.writeUInt16LE(dosTime, 10);
    lh.writeUInt16LE(dosDate, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12);
    ch.writeUInt16LE(dosDate, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/* ---------------- XML 小工具 ---------------- */
const esc = (s) =>
  String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 字体名：song=宋体 kai=楷体 hei=黑体 */
const FONT = { song: '宋体', kai: '楷体', hei: '黑体', fang: '仿宋' };
const FONT_ASCII = { song: 'Times New Roman', kai: 'Times New Roman', hei: 'Arial', fang: 'Times New Roman' };
/** 厘米 → twips（1cm = 566.93 twips） */
const cm = (v) => Math.round(v * 566.93);

function rPr(o = {}) {
  const f = o.font || 'song';
  const parts = [
    `<w:rFonts w:ascii="${FONT_ASCII[f]}" w:hAnsi="${FONT_ASCII[f]}" w:eastAsia="${FONT[f]}" w:cs="${FONT_ASCII[f]}"/>`,
  ];
  if (o.b) parts.push('<w:b/><w:bCs/>');
  if (o.i) parts.push('<w:i/>');
  parts.push(`<w:sz w:val="${Math.round((o.sz || 10.5) * 2)}"/><w:szCs w:val="${Math.round((o.sz || 10.5) * 2)}"/>`);
  if (o.color) parts.push(`<w:color w:val="${o.color}"/>`);
  return `<w:rPr>${parts.join('')}</w:rPr>`;
}

/** runs: 字符串或 {t,b,i,font,sz,color} */
function run(text) {
  const o = typeof text === 'string' ? { t: text } : text;
  return `<w:r>${rPr(o)}<w:t xml:space="preserve">${esc(o.t)}</w:t></w:r>`;
}

function para(content, o = {}) {
  const pr = [];
  if (o.style) pr.push(`<w:pStyle w:val="${o.style}"/>`);
  if (o.al) pr.push(`<w:jc w:val="${o.al}"/>`);
  if (o.before || o.after || o.line)
    pr.push(
      `<w:spacing${o.before ? ` w:before="${o.before}"` : ''}${o.after != null ? ` w:after="${o.after}"` : ''}${
        o.line ? ` w:line="${o.line}" w:lineRule="auto"` : ''
      }/>`,
    );
  if (o.indent) pr.push(`<w:ind w:left="${o.indent}" w:hanging="${o.hanging || 0}"/>`);
  const body = Array.isArray(content) ? content.map(run).join('') : run(content);
  return `<w:p>${pr.length ? `<w:pPr>${pr.join('')}</w:pPr>` : ''}${body}</w:p>`;
}

const BORDERS = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
  .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
  .join('');

function cell(c, w) {
  // 支持三种写法：'纯文本' / {t:..., b:true} / [run, run, ...]（单元格内多段不同格式）
  const isRuns = Array.isArray(c);
  const o = isRuns ? {} : typeof c === 'string' ? { t: c } : c;
  const tcPr = [
    `<w:tcW w:w="${w}" w:type="dxa"/>`,
    o.shd ? `<w:shd w:val="clear" w:color="auto" w:fill="${o.shd}"/>` : '',
    '<w:vAlign w:val="center"/>',
    `<w:tcMar><w:top w:w="57" w:type="dxa"/><w:left w:w="85" w:type="dxa"/><w:bottom w:w="57" w:type="dxa"/><w:right w:w="85" w:type="dxa"/></w:tcMar>`,
  ]
    .filter(Boolean)
    .join('');
  const p = isRuns
    ? c.map((r, i) => para(r, { al: 'left', after: 0, line: 260, before: i === 0 ? 0 : 20 })).join('')
    : para(o.t, { al: o.al || 'left', after: 0, line: 260 });
  return `<w:tc><w:tcPr>${tcPr}</w:tcPr>${p}</w:tc>`;
}

function table(b) {
  const widths = b.widths.map(cm);
  const grid = `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
  const rowXml = (cells, opts = {}) => {
    const trPr = [opts.header ? '<w:tblHeader/>' : '', opts.height ? `<w:trHeight w:val="${opts.height}"/>` : '']
      .filter(Boolean)
      .join('');
    const cs = cells
      .map((c, i) => {
        const w = widths[i] || widths[widths.length - 1];
        // 注意：数组单元格（一格多段）不能做对象展开 —— {...array} 会把它变成普通对象
        if (Array.isArray(c)) return cell(c, w);
        const o = typeof c === 'string' ? { t: c } : { ...c };
        if (opts.shd && !o.shd) o.shd = opts.shd;
        if (opts.header) o.b = true;
        return cell(o, w);
      })
      .join('');
    return `<w:tr>${trPr ? `<w:trPr>${trPr}</w:trPr>` : ''}${cs}</w:tr>`;
  };
  const rows = [];
  if (b.header) rows.push(rowXml(b.header, { header: true, shd: 'EFEFEF', height: 397 }));
  (b.rows || []).forEach((r, i) => {
    rows.push(rowXml(r, { shd: b.zebra && i % 2 === 1 ? 'F8F8F8' : undefined }));
  });
  return `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${BORDERS}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="57" w:type="dxa"/><w:left w:w="85" w:type="dxa"/><w:bottom w:w="57" w:type="dxa"/><w:right w:w="85" w:type="dxa"/></w:tblCellMar></w:tblPr>${grid}${rows.join('')}</w:tbl>${para('', { after: 0, sz: 6 })}`;
}

function blocksToXml(blocks) {
  return blocks
    .map((b) => {
      switch (b.type) {
        case 'title':
          return para(b.runs || b.text, { style: 'Title', al: b.al || 'center', after: 120 });
        case 'h1':
          return para(b.runs || b.text, { style: 'Heading1', before: 280, after: 120 });
        case 'h2':
          return para(b.runs || b.text, { style: 'Heading2', before: 200, after: 100 });
        case 'small':
          return para(b.runs || b.text, { style: 'Small', after: 60, line: 240 });
        case 'table':
          return table(b);
        default:
          return para(b.runs || b.text, { after: b.after != null ? b.after : 100, line: 300, indent: b.indent, hanging: b.hanging });
      }
    })
    .join('');
}

/* ---------------- 固定部件 ---------------- */
const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>`;

const stylesXml = () => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="宋体" w:cs="Times New Roman"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="100" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="160"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="黑体"/><w:b/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="黑体"/><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="黑体"/><w:b/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Small"><w:name w:val="Small"/><w:basedOn w:val="Normal"/><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/><w:color w:val="595959"/></w:rPr></w:style>
</w:styles>`;

const footerXml = (text) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="18"/><w:color w:val="808080"/></w:rPr><w:t xml:space="preserve">${esc(text)}　</w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Times New Roman" w:eastAsia="宋体"/><w:sz w:val="18"/><w:color w:val="808080"/></w:rPr><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:rPr><w:sz w:val="18"/><w:color w:val="808080"/></w:rPr><w:instrText xml:space="preserve">PAGE</w:instrText></w:r><w:r><w:rPr><w:sz w:val="18"/><w:color w:val="808080"/></w:rPr><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:sz w:val="18"/><w:color w:val="808080"/></w:rPr><w:t>1</w:t></w:r><w:r><w:rPr><w:sz w:val="18"/><w:color w:val="808080"/></w:rPr><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;

const coreXml = (title, author) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>${esc(author || '知识库')}</dc:creator><cp:lastModifiedBy>${esc(author || '知识库')}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString().slice(0, 19)}Z</dcterms:created></cp:coreProperties>`;

const appXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>lib-docx.mjs</Application></Properties>`;

/** 生成 docx（返回 Buffer） */
export function buildDocx({ title = '文档', author = '知识库', footer = '', landscape = false, blocks = [] }) {
  const pgSz = landscape ? '<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>' : '<w:pgSz w:w="11906" w:h="16838"/>';
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${blocksToXml(
    blocks,
  )}<w:sectPr><w:footerReference w:type="default" r:id="rId2"/>${pgSz}<w:pgMar w:top="1134" w:right="1247" w:bottom="1134" w:left="1247" w:header="851" w:footer="992" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  return zip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: RELS },
    { name: 'word/document.xml', data: document },
    { name: 'word/_rels/document.xml.rels', data: DOC_RELS },
    { name: 'word/styles.xml', data: stylesXml() },
    { name: 'word/footer1.xml', data: footerXml(footer || title) },
    { name: 'docProps/core.xml', data: coreXml(title, author) },
    { name: 'docProps/app.xml', data: appXml },
  ]);
}

export { cm, esc };
