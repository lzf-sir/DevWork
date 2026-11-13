/**
 * 输入框触发符单元校验（不依赖 DOM）。
 *
 * 为什么必须单独测：@ 引用与 / 技能的触发识别一旦错，用户敲 @ 没反应、
 * 或者在邮箱/路径里误弹候选，整条输入链路就废了 —— 而这在浏览器里
 * 只能靠手点着试，很难覆盖「光标在中间」「前面有别的词」这类边界。
 *
 * 用法：npm run test:composer
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = mkdtempSync(path.join(tmpdir(), 'devwork-composer-'));
const BUNDLE = path.join(OUT_DIR, 'composer.mjs');

execFileSync(
  process.execPath,
  [
    path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    path.join(ROOT, 'src', 'utils', 'composer.ts'),
    '--bundle',
    '--format=esm',
    `--outfile=${BUNDLE}`,
    '--log-level=warning',
  ],
  { cwd: ROOT, stdio: 'inherit' },
);

const {
  detectTrigger,
  replaceRange,
  filterCandidates,
  removeMention,
  collectMentions,
  syncMentions,
  resolveAssetIds,
} = await import(pathToFileURL(BUNDLE).href);

const ASSETS = [
  { id: 'a-order-db-prod', label: '生产库', hint: '数据库' },
  { id: 'a-kb', label: '运营知识库', hint: '知识库' },
  { id: 'a-order-service', label: 'order-service', hint: '代码库' },
];

const cases = [
  {
    name: '行首 @ 触发，空查询',
    run: () => {
      const t = detectTrigger('@', 1);
      return t && t.kind === 'asset' && t.query === '' && t.start === 0 && t.end === 1;
    },
  },
  {
    name: '空白后的 @ 触发并带查询词',
    run: () => {
      const text = '查一下 @生产';
      const t = detectTrigger(text, text.length);
      return t && t.kind === 'asset' && t.query === '生产' && t.start === 4;
    },
  },
  {
    name: '光标在中间也能识别触发词',
    run: () => {
      const text = '@生产库 的慢查询';
      const t = detectTrigger(text, 3);
      return t && t.kind === 'asset' && t.query === '生产' && t.start === 0 && t.end === 3;
    },
  },
  {
    name: '邮箱里的 @ 不触发',
    run: () => {
      const text = 'someone@example.com';
      return detectTrigger(text, text.length) === null;
    },
  },
  {
    name: 'URL 里的 / 不触发',
    run: () => {
      const text = 'see http://a.b/c';
      return detectTrigger(text, text.length) === null;
    },
  },
  {
    name: '查询词里出现空格就收起候选',
    run: () => {
      const text = '@生产库 订单';
      return detectTrigger(text, text.length) === null;
    },
  },
  {
    name: '斜杠触发识别为命令',
    run: () => {
      const text = '/慢';
      const t = detectTrigger(text, text.length);
      return t && t.kind === 'command' && t.query === '慢';
    },
  },
  {
    name: '@ 与 / 同时存在时取离光标更近的',
    run: () => {
      const text = '@a /b';
      const t = detectTrigger(text, text.length);
      return t && t.kind === 'command' && t.query === 'b';
    },
  },
  {
    name: 'replaceRange 替换并给出新光标',
    run: () => {
      const r = replaceRange('查 @生产库', 2, 6, '@生产库 ');
      return r.text === '查 @生产库 ' && r.caret === 7;
    },
  },
  {
    name: '候选过滤按名称 / id / 副标题匹配',
    run: () => {
      return (
        filterCandidates(ASSETS, '知识').length === 1 &&
        filterCandidates(ASSETS, 'service').length === 1 &&
        filterCandidates(ASSETS, '数据库').length === 1 &&
        filterCandidates(ASSETS, '').length === 3 &&
        filterCandidates(ASSETS, '不存在').length === 0
      );
    },
  },
  {
    name: 'removeMention 同时删掉正文里的 @名称 与随后的空格',
    run: () => removeMention('查 @生产库 的订单', '生产库') === '查 的订单',
  },
  {
    name: '手写的 @名称 也算引用',
    run: () => {
      const hits = collectMentions('帮我看 @生产库 和 @运营知识库', ASSETS);
      return hits.length === 2 && hits[0].id === 'a-order-db-prod';
    },
  },
  {
    name: '正文删掉后 chip 同步消失',
    run: () => {
      const picked = [ASSETS[0], ASSETS[1]];
      return syncMentions('只看 @生产库', picked).length === 1;
    },
  },
  {
    name: '互为前缀的资产名不会互相误命中',
    run: () => {
      const items = [
        { id: 'a', label: 'order' },
        { id: 'b', label: 'order-service' },
      ];
      const hits = collectMentions('@order-service', items);
      return hits.length === 1 && hits[0].id === 'b';
    },
  },
  {
    name: 'removeMention 只删整名引用（不误伤前缀资产）',
    run: () => {
      const items = [
        { id: 'a', label: 'order' },
        { id: 'b', label: 'order-service' },
      ];
      const kept = syncMentions('看 @order-service', items);
      return kept.length === 1 && kept[0].id === 'b';
    },
  },
  {
    name: '同名资产：只有点选的 chip 算数，手写的不猜',
    run: () => {
      const assets = [
        { id: 'a-db-prod', label: 'order_db' },
        { id: 'a-db-dev', label: 'order_db' },
        { id: 'a-kb', label: '运营知识库' },
      ];
      /* 点选 prod 那一个 → 只带 prod 的 id */
      const picked = resolveAssetIds('看 @order_db', assets, [assets[0]]);
      /* 正文里手写同名但没点选 → 两个同名资产都不猜 */
      const manual = resolveAssetIds('看 @order_db', assets, []);
      /* 名称唯一的资产手写也算数 */
      const unique = resolveAssetIds('看 @运营知识库', assets, []);
      return picked.length === 1
        && picked[0] === 'a-db-prod'
        && manual.length === 0
        && unique.length === 1
        && unique[0] === 'a-kb';
    },
  },
];

let failed = 0;
for (const item of cases) {
  let ok = false;
  try {
    ok = item.run();
  } catch (error) {
    ok = false;
    console.log('   error =', error instanceof Error ? error.message : String(error));
  }
  if (!ok) failed += 1;
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${item.name}`);
}

console.log(`\nTotal: ${cases.length} | Passed: ${cases.length - failed} | Failed: ${failed}`);
rmSync(OUT_DIR, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
