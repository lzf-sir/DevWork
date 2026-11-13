/**
 * Markdown 解析单元校验（不依赖 DOM，只验块结构）。
 *
 * 为什么要单独测解析器：围栏代码块会跨 "段落" 到达前端（服务端按 '\n\n' 切段），
 * 这里的分组逻辑一错就是"代码块首尾多空行 / 列表被拆成一堆段落"，
 * 而这类问题在浏览器里只能靠肉眼发现。
 *
 * 用法：npm run test:md
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = mkdtempSync(path.join(tmpdir(), 'devwork-md-'));
const BUNDLE = path.join(OUT_DIR, 'markdown.mjs');

execFileSync(
  process.execPath,
  [
    path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    path.join(ROOT, 'src', 'components', 'Markdown.tsx'),
    /* --bundle：把 react / jsx-runtime 一起打进来，产物放在系统临时目录也能解析。 */
    '--bundle',
    '--loader:.tsx=tsx',
    '--format=esm',
    '--jsx=automatic',
    `--outfile=${BUNDLE}`,
    '--log-level=warning',
  ],
  { cwd: ROOT, stdio: 'inherit' },
);

const { parseBlocks } = await import(pathToFileURL(BUNDLE).href);

const text = (segs) => segs.map((s) => (s.t === 'cite' ? `[${s.id}]` : s.v)).join('');

const cases = [
  {
    name: '普通段落 + 引用角标',
    paras: [[{ t: 'text', v: 'GMV 环比下降 [1]，主要来自退款。' }]],
    expect: (blocks) =>
      blocks.length === 1 &&
      blocks[0].kind === 'paragraph' &&
      text(blocks[0].lines[0]) === 'GMV 环比下降 [1]，主要来自退款。',
  },
  {
    name: '围栏代码块跨段落合并',
    paras: [
      [{ t: 'text', v: '```sql' }],
      [{ t: 'text', v: 'SELECT 1;' }],
      [{ t: 'text', v: '```' }],
      [{ t: 'text', v: '结论见上。' }],
    ],
    expect: (blocks) =>
      blocks.length === 2 &&
      blocks[0].kind === 'code' &&
      blocks[0].lang === 'sql' &&
      blocks[0].code === 'SELECT 1;' &&
      blocks[1].kind === 'paragraph',
  },
  {
    name: '围栏内空行保留为一个空行',
    paras: [
      [{ t: 'text', v: '```' }],
      [{ t: 'text', v: 'a' }],
      [{ t: 'text', v: '' }],
      [{ t: 'text', v: 'b' }],
      [{ t: 'text', v: '```' }],
    ],
    expect: (blocks) => blocks.length === 1 && blocks[0].kind === 'code' && blocks[0].code === 'a\n\nb',
  },
  {
    name: '标题 + 列表分组',
    paras: [[{ t: 'text', v: '## 归因\n- 退款冲减\n- 口径变更\n1. 复核\n2. 归档' }]],
    expect: (blocks) =>
      blocks.length === 3 &&
      blocks[0].kind === 'heading' &&
      blocks[0].level === 2 &&
      text(blocks[0].line) === '归因' &&
      blocks[1].kind === 'list' &&
      !blocks[1].ordered &&
      blocks[1].items.length === 2 &&
      text(blocks[1].items[0]) === '退款冲减' &&
      blocks[2].kind === 'list' &&
      blocks[2].ordered &&
      blocks[2].items.length === 2,
  },
  {
    name: '引用块',
    paras: [[{ t: 'text', v: '> 只读执行\n> 已追加 LIMIT' }]],
    expect: (blocks) => blocks.length === 1 && blocks[0].kind === 'quote' && blocks[0].lines.length === 2,
  },
  {
    name: '段落内换行保留为多行',
    paras: [[{ t: 'text', v: '第一行\n第二行' }]],
    expect: (blocks) => blocks.length === 1 && blocks[0].kind === 'paragraph' && blocks[0].lines.length === 2,
  },
  {
    name: '引用角标在列表项里不丢',
    paras: [[{ t: 'text', v: '- 退款冲减 ' }, { t: 'cite', id: 2 }]],
    expect: (blocks) =>
      blocks.length === 1 && blocks[0].kind === 'list' && text(blocks[0].items[0]) === '退款冲减 [2]',
  },
  {
    name: '空白输入不产生块',
    paras: [],
    expect: (blocks) => blocks.length === 0,
  },
];

let failed = 0;
for (const item of cases) {
  let ok = false;
  let blocks = [];
  try {
    blocks = parseBlocks(item.paras);
    ok = item.expect(blocks);
  } catch {
    ok = false;
  }
  if (!ok) failed += 1;
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${item.name}`);
  if (!ok) console.log('   blocks =', JSON.stringify(blocks.map((b) => ({ kind: b.kind, lang: b.lang, code: b.code }))));
}

console.log(`\nTotal: ${cases.length} | Passed: ${cases.length - failed} | Failed: ${failed}`);
rmSync(OUT_DIR, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
