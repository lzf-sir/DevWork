/**
 * 技能登记表一致性校验。
 *
 * 为什么必须测：技能清单在服务端（backend/src/config/skills.ts）与前端离线兜底
 * （src/data/mock.ts）各存一份。两份一旦漂移，就会出现「前端菜单里的技能，
 * 服务端没有」或反之 —— 那比没有技能更让人困惑，所以直接让测试拦住。
 *
 * 同时校验服务端登记表自检：技能依赖的工具必须真实存在于工具登记表，
 * 且不能是写工具（写工具要走审批，技能不能偷偷带上它）。
 *
 * 用法：npm run test:skills
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = mkdtempSync(path.join(tmpdir(), 'devwork-skills-'));

function bundle(entry, outfile) {
  execFileSync(
    process.execPath,
    [
      path.join(ROOT, 'node_modules', 'esbuild', 'bin', 'esbuild'),
      path.join(ROOT, entry),
      '--bundle',
      '--format=esm',
      `--outfile=${outfile}`,
      '--log-level=warning',
    ],
    { cwd: ROOT, stdio: 'inherit' },
  );
  return import(pathToFileURL(outfile).href);
}

const server = await bundle('backend/src/config/skills.ts', path.join(OUT_DIR, 'server-skills.mjs'));
const client = await bundle('frontend/src/data/mock.ts', path.join(OUT_DIR, 'client-mock.mjs'));

let failed = 0;
const check = (name, ok, detail) => {
  if (!ok) failed += 1;
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}`);
  if (!ok && detail !== undefined) console.log('   detail =', detail);
};

/* ① 服务端登记表自检：工具必须真实存在，且不能是写工具。 */
const problems = server.validateSkillRegistry();
check('服务端技能登记表自检通过', problems.length === 0, problems.join('；'));

/* ② 两份清单逐字段一致。 */
const registry = server.SKILL_REGISTRY;
const mirror = client.MOCK_SKILLS;
check('技能数量一致', registry.length === mirror.length, `server=${registry.length} client=${mirror.length}`);

registry.forEach((skill, index) => {
  const other = mirror[index];
  if (!other) {
    check(`技能 ${skill.id} 在前端镜像中存在`, false, '前端镜像缺少该项');
    return;
  }
  const sameTools =
    skill.tools.length === other.tools.length && skill.tools.every((tool, i) => tool === other.tools[i].name);
  check(
    `技能 ${skill.id} 字段一致（id/label/desc/category/template/tools）`,
    skill.id === other.id
      && skill.label === other.label
      && skill.desc === other.desc
      && skill.category === other.category
      && skill.template === other.template
      && sameTools,
    { server: { ...skill, tools: skill.tools }, client: other },
  );
});

/* ③ 技能模板必须真的写得出方法论 —— 空模板没有意义。 */
check(
  '每个技能都有非空模板',
  registry.every((skill) => skill.template.trim().length > 10),
);

console.log(`\nTotal: ${registry.length + 2} | Failed: ${failed}`);
rmSync(OUT_DIR, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
