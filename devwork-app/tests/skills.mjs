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
      /* 服务端登记表会加载 skills/<id>/SKILL.md，用到 node:fs / node:path。
       * 不打 node 平台的话 esbuild 会把内置模块当外部包解析失败。 */
      '--platform=node',
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

/* ② 内置技能与前端镜像逐字段一致。
 *
 * 为什么现在只比对内置项：技能从 v1.1 起分成两层——
 *   · builtin（config/skills.ts）= 随代码发布，前端离线菜单靠镜像渲染，必须逐字一致；
 *   · file（backend/src/skills/<id>/SKILL.md）= 团队扩展，天然不在镜像里。
 * 把扩展项也算进"数量一致"会让每次加一个 SKILL.md 都要改前端，
 * 那就等于把文件驱动又做回了 TS 数组。 */
const registry = server.SKILL_REGISTRY;
const mirror = client.MOCK_SKILLS;
const builtin = registry.filter((skill) => (skill.source ?? 'builtin') === 'builtin');
const fileSkills = registry.filter((skill) => skill.source === 'file');

check('内置技能数量与前端镜像一致', builtin.length === mirror.length, `server=${builtin.length} client=${mirror.length}`);

builtin.forEach((skill, index) => {
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

/* ③ 文件技能：必须有正文、必须有触发场景，且不能与内置撞名（撞名会让 skill_load 不确定）。 */
check('文件技能已加载', fileSkills.length > 0, `file=${fileSkills.length}，技能目录=${server.SKILL_REGISTRY.length - builtin.length > 0 ? 'ok' : '空'}`);
fileSkills.forEach((skill) => {
  check(
    `文件技能 ${skill.id} 结构完整（正文/触发场景/来源标注）`,
    (skill.methodology ?? '').trim().length >= 40
      && (skill.whenToUse ?? '').trim().length > 0
      && !mirror.some((item) => item.id === skill.id),
    { chars: (skill.methodology ?? '').length, when: skill.whenToUse },
  );
});

/* ④ 技能模板必须真的写得出方法论 —— 空模板没有意义。 */
check(
  '每个技能都有非空模板',
  registry.every((skill) => skill.template.trim().length > 10),
);

/* ⑤ 「改前定位 → 改后验证」这条链路必须真的接上。
 * 单篇正文各自写得好，不代表能串起来：上游多写一段、下游不认，链路就是断的。
 * 这四条断言盯的是交接点（定位单 → 重放调用点），任何一端被删掉都会红。 */
const nav = fileSkills.find((item) => item.id === 'code-navigator');
const safety = fileSkills.find((item) => item.id === 'write-safety');
check(
  'code-navigator 产出可交接的定位单（含待改处与调用点）',
  Boolean(nav) && nav.methodology.includes('定位单')
    && nav.methodology.includes('待改处') && nav.methodology.includes('调用点'),
  nav?.methodology.includes('定位单'),
);
check(
  'write-safety 的改后验证要重放调用点，而不是只重读一遍',
  Boolean(safety) && safety.methodology.includes('重放') && safety.methodology.includes('mode=refs'),
  safety?.methodology.includes('重放'),
);
check(
  'write-safety 明确区分「verify 通过」与「改对了」',
  Boolean(safety) && safety.methodology.includes('verify') && safety.methodology.includes('不判断改动是否正确'),
  safety?.methodology.includes('不判断改动是否正确'),
);
check(
  'write-safety 列出写结果的四种形态（片段/空操作/超限/新建）',
  Boolean(safety) && ['改动片段', '空操作', '超过片段上限', '新建文件']
    .every((word) => safety.methodology.includes(word)),
  safety?.methodology.includes('空操作'),
);

console.log(`\nTotal: ${builtin.length + fileSkills.length + 8} | Failed: ${failed}`);
rmSync(OUT_DIR, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
