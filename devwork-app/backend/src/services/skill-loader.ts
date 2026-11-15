/**
 * SkillLoader —— 文件驱动的技能加载器（`backend/src/skills/<id>/SKILL.md`）。
 *
 * 为什么要给技能一个"文件形态"，而不是继续往 TS 数组里加条目：
 *   TS 数组只能随代码发布，改一句方法论就要重新打包；而技能本质上是**提示词资产**，
 *   它应该能被复盘、被 diff、被团队共享。文件形态还带来一个关键能力：
 *   正文可以很长（方法论、检查清单、反例），但不进系统提示词 ——
 *   模型先用 skill(mode=list) 看清单，判断相关了才用 skill(mode=load) 把正文拉进上下文。
 *   这是「技能太多会撑爆上下文」的唯一可行解。
 *
 * 与 config/skills.ts 的分工（两个事实来源，但边界写死）：
 *   · config/skills.ts  = **内置技能**：随代码发布，与前端离线镜像 mock.ts 同源；
 *   · 本目录的 SKILL.md = **扩展技能**：用户/团队可增删，重启生效，不进前端镜像。
 * 两者合并后才是对外可见的技能清单，`source` 字段标明来处（builtin / file）。
 *
 * 目录在哪：不写死绝对路径，按候选链探测。原因是后端源码会被 esbuild 打进临时
 * bundle（测试）或拷进 resources/server/src（打包），import.meta.url 锚点会漂移。
 */
import fs from 'node:fs';
import path from 'node:path';
import { SERVER_ROOT } from '../config';
import { TOOL_REGISTRY } from '../config/tools';

/** 允许的技能分类：与前端菜单分组一致，超出即报错而不是静默归到"其他"。 */
export const SKILL_CATEGORIES = ['排障', '数据', '代码', '文档'] as const;
export type FileSkillCategory = typeof SKILL_CATEGORIES[number];
/** 资产类型词表：与 tool-catalog 的 AssetType 同源。 */
const ASSET_TYPES = ['code', 'db', 'server', 'kb', 'log', 'api'];

export interface FileSkill {
  id: string;
  label: string;
  desc: string;
  category: FileSkillCategory;
  /** 触发场景：模型据此判断"这活该不该加载这个技能"。 */
  whenToUse: string;
  /** 方法论正文（markdown），只在 skill_load 时进上下文。 */
  methodology: string;
  tools: string[];
  writeTools: string[];
  requiresAssets: string[];
  budget: number;
  /** SKILL.md 所在目录（诊断用）。 */
  dir: string;
}

export interface SkillLoadReport {
  dir: string | null;
  skills: FileSkill[];
  /** 结构性问题：宁可让 /api/skills 自检报红，也不要静默丢掉一个技能。 */
  problems: string[];
}

/** frontmatter 只支持 `key: value` 与逗号数组——刻意不引 YAML 依赖（会进打包产物）。 */
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } | null {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---')) return null;
  const end = normalized.indexOf('\n---', 3);
  if (end === -1) return null;
  const header = normalized.slice(3, end).trim();
  const body = normalized.slice(end + 4).replace(/^\n+/, '');
  const meta: Record<string, string> = {};
  for (const line of header.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf(':');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
    if (key) meta[key] = value;
  }
  return { meta, body };
}

/** 候选目录：按优先级探测，第一个存在的胜出。 */
function candidateDirs(): string[] {
  const list: string[] = [];
  const override = String(process.env.DEVWORK_SKILLS_DIR ?? '').trim();
  if (override) list.push(path.resolve(override));
  /* 开发态：backend/src/config.ts → SERVER_ROOT=backend/ → backend/src/skills。
   * 打包态：server/src/config.ts → SERVER_ROOT=server/ → server/src/skills（拷包时整目录带入）。 */
  list.push(path.join(SERVER_ROOT, 'src', 'skills'));
  /* bundle 态（esbuild 打临时文件）：锚点失效，退回 cwd 相对路径。 */
  list.push(path.join(process.cwd(), 'backend', 'src', 'skills'));
  list.push(path.join(process.cwd(), 'src', 'skills'));
  return [...new Set(list)];
}

function resolveSkillsDir(): string | null {
  for (const dir of candidateDirs()) {
    try {
      if (fs.statSync(dir).isDirectory()) return dir;
    } catch { /* 候选不存在是正常情况，继续下一个 */ }
  }
  return null;
}

/** 正文压成一行摘要，给输入框模板用（模型/用户看到的菜单项不能是空的）。 */
export function summarizeMethodology(methodology: string, maxChars = 260): string {
  const plain = methodology
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\*\*|`|>/g, '')
    .replace(/\n{2,}/g, '。')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > maxChars ? `${plain.slice(0, maxChars)}…` : plain;
}

const KNOWN_KEYS = new Set(['id', 'label', 'desc', 'category', 'when', 'tools', 'writeTools', 'requiresAssets', 'budget']);

function parseSkillFile(dir: string, problems: string[]): FileSkill | null {
  const file = path.join(dir, 'SKILL.md');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    problems.push(`${path.basename(dir)}: 缺少 SKILL.md`);
    return null;
  }
  const parsed = parseFrontmatter(text);
  if (!parsed) {
    problems.push(`${path.basename(dir)}: SKILL.md 缺少 --- frontmatter ---`);
    return null;
  }
  const { meta, body } = parsed;
  const folder = path.basename(dir);
  const fail = (reason: string): null => { problems.push(`${folder}: ${reason}`); return null; };

  Object.keys(meta).forEach((key) => {
    if (!KNOWN_KEYS.has(key)) fail(`未知字段 ${key}（可用：${[...KNOWN_KEYS].join(' / ')}）`);
  });

  const id = (meta.id || folder).trim();
  if (!id) return fail('id 为空');
  /* id 与目录名不一致时，skill_load 按 id 查会落空——这是静默失效，必须拦住。 */
  if (id !== folder) return fail(`id(${id}) 必须与目录名(${folder})一致`);
  const label = (meta.label ?? '').trim();
  if (!label) return fail('label 为空');
  const desc = (meta.desc ?? '').trim();
  if (!desc) return fail('desc 为空');
  const category = (meta.category ?? '').trim() as FileSkillCategory;
  if (!SKILL_CATEGORIES.includes(category)) return fail(`category 必须是 ${SKILL_CATEGORIES.join('/')}`);
  if (body.trim().length < 40) return fail('正文过短（方法论至少要 40 字符，否则技能没有信息量）');

  const splitList = (value: string | undefined): string[] => String(value ?? '')
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);

  const tools = splitList(meta.tools);
  tools.forEach((tool) => {
    if (!TOOL_REGISTRY[tool]) problems.push(`${folder}: tools 里的 ${tool} 不在工具登记表`);
    else if (TOOL_REGISTRY[tool].writeAction) problems.push(`${folder}: tools 里混入写工具 ${tool}（必须放 writeTools）`);
  });
  const writeTools = splitList(meta.writeTools);
  writeTools.forEach((tool) => {
    if (!TOOL_REGISTRY[tool]) problems.push(`${folder}: writeTools 里的 ${tool} 不在工具登记表`);
    else if (!TOOL_REGISTRY[tool].writeAction) problems.push(`${folder}: writeTools 里的 ${tool} 不是写工具`);
  });

  const requiresAssets = splitList(meta.requiresAssets);
  requiresAssets.forEach((type) => {
    if (!ASSET_TYPES.includes(type)) problems.push(`${folder}: requiresAssets 里的 ${type} 不是合法资产类型`);
  });

  const budget = Number(meta.budget ?? 0);
  if (!Number.isFinite(budget) || budget <= 0) problems.push(`${folder}: budget 必须是正数`);

  return {
    id, label, desc, category,
    whenToUse: (meta.when ?? '').trim(),
    methodology: body.trim(),
    tools, writeTools, requiresAssets,
    budget: Number.isFinite(budget) && budget > 0 ? budget : 20,
    dir,
  };
}

let cache: SkillLoadReport | null = null;

/** 扫描并解析全部技能文件（结果缓存；文件变更需要 reload 或重启）。 */
export function loadFileSkills(): SkillLoadReport {
  if (cache) return cache;
  const dir = resolveSkillsDir();
  if (!dir) {
    /* 目录不存在不是错误：有人就是只想用内置技能。如实上报"没有"即可。 */
    cache = { dir: null, skills: [], problems: [] };
    return cache;
  }
  const problems: string[] = [];
  const skills: FileSkill[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    cache = { dir, skills: [], problems: [`技能目录不可读：${error instanceof Error ? error.message : String(error)}`] };
    return cache;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const skill = parseSkillFile(path.join(dir, entry.name), problems);
    if (skill) skills.push(skill);
  }
  skills.sort((a, b) => a.id.localeCompare(b.id));
  cache = { dir, skills, problems };
  return cache;
}

export function reloadFileSkills(): SkillLoadReport {
  cache = null;
  return loadFileSkills();
}

/** 按 id 取一个文件技能（skill_load 用）。 */
export function findFileSkill(id: string): FileSkill | undefined {
  return loadFileSkills().skills.find((skill) => skill.id === id);
}
