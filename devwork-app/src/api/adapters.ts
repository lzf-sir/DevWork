/**
 * REST 结构化卡片 → 前端渲染联合类型的唯一转换层。
 * ChatView（单次提问）与 store（启动 hydrate / 会话回放）共用，避免重复实现。
 */
import type {
  AssetFolder,
  AssetGo,
  AssetItem,
  AssetStatus,
  ConvFolder,
  ConvItem,
  Dict,
  InlineSeg,
  Message,
  MessageCard,
  Sidebar as SidebarPayload,
  SidebarData,
} from './client';

/**
 * 把 /sql/query 的列名收窄成 string[]。
 * 服务端返回 columns（对象数组）与 columnNames / columnsSimple（字符串数组）三种视图；
 * 离线 mock 只返回 string[] 的 columns。此处按优先级统一，避免把对象 stringify 成
 * "[object Object]" 显示到结果集表头。
 */
export function sqlColumnNames(result: unknown): string[] {
  if (!result || typeof result !== 'object') return [];
  const value = result as Record<string, unknown>;
  const simple = value.columnsSimple ?? value.columnNames;
  if (Array.isArray(simple) && simple.length > 0) {
    return simple.map((item) => (typeof item === 'string' ? item : String((item as { name?: unknown })?.name ?? '')));
  }
  if (Array.isArray(value.columns)) {
    return value.columns.map((item) =>
      typeof item === 'string' ? item : String((item as { name?: unknown })?.name ?? ''),
    );
  }
  return [];
}

/** 把 /sql/query 的行数据收窄成 string[][]，SQL NULL 统一显示 'NULL'。 */
export function sqlRows(result: unknown): string[][] {
  if (!result || typeof result !== 'object') return [];
  const raw = (result as { rows?: unknown }).rows;
  if (!Array.isArray(raw)) return [];
  return raw.map((row: unknown) =>
    (Array.isArray(row) ? row : [row]).map((cell) => (cell === null || cell === undefined ? 'NULL' : String(cell))),
  );
}


/** 把 REST MessageCard 转成前端卡片；未知 kind 返回 null。 */
export function toFrontendMessage(card: MessageCard): Message | null {
  const payload = card.payload;
  /* 轮末卡的 payload.usage（单轮 token 用量）随卡透传；历史消息没有则为 undefined。 */
  const usage = (payload.usage as Message['usage']) ?? undefined;
  switch (card.kind) {
    case 'bubble':
    case 'user':
      return {
        id: card.id,
        kind: 'user',
        text: String(payload.content ?? payload.text ?? ''),
        chips: (payload.chips as string[]) ?? [],
        usage,
      };
    case 'text':
      return { id: card.id, kind: 'text', text: String(payload.content ?? ''), usage };
    case 'plan': {
      const rawSteps = Array.isArray(payload.steps) ? (payload.steps as Record<string, unknown>[]) : [];
      return {
        id: card.id,
        kind: 'plan',
        intent: String(payload.intent ?? 'general'),
        degraded: payload.degraded === true,
        steps: rawSteps.map((step) => ({
          goal: String(step.goal ?? ''),
          durationMs: Number(step.durationMs ?? 0),
        })),
        usage,
      };
    }
    case 'notice':
      return {
        id: card.id,
        kind: 'notice',
        level: payload.level === 'info' ? 'info' : 'warn',
        title: String(payload.title ?? '提示'),
        content: String(payload.content ?? ''),
        usage,
      };
    case 'tool_row':
    case 'tool':
      return {
        id: card.id,
        kind: 'tool',
        name: String(payload.name ?? payload.toolName ?? 'tool'),
        status: String(payload.status ?? (payload.ok === false ? '失败' : '已自动放行')),
        statusCls: (payload.statusCls as 'ok' | 'warn' | 'deny' | 'suggest' | undefined)
          ?? (payload.ok === false ? 'warn' : 'ok'),
        ms: `${(Number(payload.durationMs ?? 600) / 1000).toFixed(1)}s`,
        args: String(payload.args ?? '{}'),
        result: String(payload.result ?? ''),
        usage,
      };
    case 'approval_card':
      /* 审批卡才能真正裁决；resolved / decision 来自服务端，已裁决就禁用按钮。
       * V2：卡片带 plan（可执行写计划）→ 批准走三层防线真执行；
       * 裁决后 rollbackRef / executionOk 随 payload 回填，「回滚」按钮据此显示。 */
      return {
        id: card.id,
        kind: 'approval',
        cmd: String(payload.command ?? payload.toolName ?? '待审批操作'),
        reason: String(payload.reason ?? ''),
        executable: payload.executable === true,
        resolved: payload.resolved === true,
        decision: typeof payload.decision === 'string' ? payload.decision : undefined,
        hasPlan: payload.plan != null && typeof (payload.plan as Record<string, unknown>).toolName === 'string',
        executionOk: payload.executionOk === true,
        rollbackRef: typeof payload.rollbackRef === 'string' ? payload.rollbackRef : null,
        scope: typeof payload.scope === 'string' ? payload.scope : undefined,
        usage,
      };
    case 'suggestion':
      /* deny / suggest 的产物不是审批卡：没有批准按钮，只给命令与理由。 */
      return {
        id: card.id,
        kind: 'suggestion',
        cmd: String(payload.command ?? payload.name ?? '建议命令'),
        reason: String(payload.reason ?? ''),
        suggestion: String(payload.suggestion ?? '已生成建议，未执行任何写操作'),
        usage,
      };
    case 'conclusion':
      return {
        id: card.id,
        kind: 'conclusion',
        confidence: String(payload.confidence ?? '0.82'),
        paras: (payload.paras as InlineSeg[][]) ?? [[{ t: 'text', v: String(payload.content ?? '') }]],
        usage,
      };
    case 'artifact':
      return {
        id: card.id,
        kind: 'artifact',
        name: String(payload.name ?? '产物'),
        meta: String(payload.meta ?? ''),
        desc: String(payload.desc ?? ''),
        usage,
      };
    case 'patch':
      return { id: card.id, kind: 'text', text: `[patch 建议 · 未落盘] ${String(payload.patch ?? '')}`, usage };
    default:
      return null;
  }
}

/** 批量转换并过滤 null。 */
export function cardsToThread(cards: MessageCard[]): Message[] {
  return cards
    .map(toFrontendMessage)
    .filter((card): card is Message => card !== null);
}

/** REST sidebar → 前端 SidebarData（字段逐项收窄，缺值回落到原型默认）。
 *  放在这里而不是 App.tsx：启动装配与"写操作后刷新侧栏"都要用同一份映射。 */
export function toSidebarData(raw: SidebarPayload): SidebarData {
  const assetLeaf = (item: Dict): AssetItem => ({
    id: String(item.id ?? ''),
    name: String(item.name ?? ''),
    icon: String(item.icon ?? '▣'),
    go: item.go ? (item.go as AssetGo) : undefined,
    env: item.env ? String(item.env) : undefined,
    status: (item.status ?? 'ok') as AssetStatus,
    title: item.title ? String(item.title) : undefined,
  });
  /* 两层目录：子文件夹也走同一套映射，深度由服务端限制在 2 层。 */
  const assetFolder = (folder: Dict): AssetFolder => ({
    id: String(folder.id ?? ''),
    name: String(folder.name ?? ''),
    count: Number(folder.count ?? 0),
    open: folder.open === true || folder.collapsed === false,
    items: ((folder.items as unknown as Dict[]) ?? []).map(assetLeaf),
    subFolders: ((folder.subFolders as unknown as Dict[]) ?? []).map(assetFolder),
  });
  const convFolder = (folder: Dict): ConvFolder => ({
    id: String(folder.id ?? ''),
    name: String(folder.name ?? ''),
    count: Number(folder.count ?? 0),
    open: folder.open === true || folder.collapsed === false,
    items: ((folder.items as unknown as Dict[]) ?? []).map(convLeaf),
    subFolders: ((folder.subFolders as unknown as Dict[]) ?? []).map(convFolder),
  });
  /* 会话叶子：资产绑定信息（assetId / assetType）必须原样带过来 ——
   * 侧栏据此给「资产会话」打标，用户一眼能看出这条会话挂在哪个资产上。 */
  const convLeaf = (item: Dict): ConvItem => ({
    id: String(item.id ?? ''),
    title: String(item.title ?? ''),
    assetId: item.assetId ? String(item.assetId) : undefined,
    assetType: item.assetType ? String(item.assetType) : undefined,
  });
  const assetFolders: AssetFolder[] = ((raw.assetFolders ?? []) as unknown as Dict[]).map(assetFolder);
  const convFolders: ConvFolder[] = ((raw.convFolders ?? []) as unknown as Dict[]).map(convFolder);
  return {
    assetFolders,
    looseAssets: ((raw.looseAssets ?? []) as unknown as Dict[]).map(assetLeaf),
    convFolders,
    looseConvs: ((raw.looseConvs ?? []) as unknown as Dict[]).map(convLeaf),
  };
}
