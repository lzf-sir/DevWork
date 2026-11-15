import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api/client';
import type { SensitiveRule } from '../api/types';
import { useStore } from '../store';

/**
 * 敏感文件规则编辑器。
 *
 * 这一屏的重点不是「终于能改了」，而是**改完之后哪几处跟着变、哪几处不会跟着变**。
 * 规则被打散的年代，改完只有文件树生效，索引和终端还按内置常量放行 `.env` ——
 * 用户在界面上看到「已排除」，库里却躺着敏感内容。所以界面必须交代清楚：
 *
 * | 位置 | 何时读到新规则 |
 * |---|---|
 * | 文件树 / 代码详情 | 下一次请求（读库） |
 * | 终端输出过滤 | 下一条命令（读库） |
 * | 索引 | 保存时**按新规则清一次存量块**；新增文件在下一次建索引时跳过 |
 *
 * 最后一行有个方向差异：收紧会清、放宽不会补建。放宽之后「搜不到新文件」
 * 是「还没索引」，不是「规则没生效」，这两件事必须分开说。
 */

const MAX_RULES = 500;

/** 去重键：大小写不敏感（`.ENV` 与 `.env` 在 Windows 上是同一个文件）。 */
const keyOf = (pattern: string): string => pattern.trim().toLowerCase();

export interface SensitiveRulesEditorProps {
  /** 关闭面板（取消 / 保存成功后）。 */
  onClose: () => void;
  /** 保存成功回调：父级用返回值刷新「N 条规则」这类摘要。 */
  onSaved?: (rules: SensitiveRule[], purged: { chunks: number; files: number }) => void;
}

export default function SensitiveRulesEditor({ onClose, onSaved }: SensitiveRulesEditorProps): React.ReactElement {
  const { addToast } = useStore();
  const [baseline, setBaseline] = useState<SensitiveRule[]>([]);
  const [draft, setDraft] = useState<SensitiveRule[]>([]);
  const [input, setInput] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    void api.getSensitiveRules().then((envelope) => {
      if (cancelled) return;
      if (!envelope.ok) {
        setError(envelope.error?.message ?? '读取规则失败');
        setLoading(false);
        return;
      }
      setBaseline(envelope.data);
      setDraft(envelope.data);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /* 重复判定用「出现次数」而不是 Set.size：重复项要指认**是哪一行**跟别人撞了，
   * 只判断"有重复"的话用户得自己一行行找。 */
  const duplicateKeys = useMemo(() => {
    const seen = new Map<string, number>();
    draft.forEach((rule) => {
      const key = keyOf(rule.pattern);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    });
    return new Set(Array.from(seen.entries()).filter(([, count]) => count > 1).map(([key]) => key));
  }, [draft]);

  const emptyRows = draft.filter((rule) => keyOf(rule.pattern) === '').length;
  const dirty = useMemo(() => {
    const before = baseline.map((rule) => keyOf(rule.pattern)).join('\n');
    const after = draft.map((rule) => keyOf(rule.pattern)).join('\n');
    return before !== after;
  }, [baseline, draft]);

  /* 不能保存的原因按优先级取第一条：一次只给一句，避免三句话互相盖过。 */
  const blocked = ((): string => {
    if (draft.length === 0) return '至少保留 1 条规则：全部删除等于让 .env / 私钥重新进入文件树与会话上下文。';
    if (emptyRows > 0) return `有 ${emptyRows} 行是空的：空规则会匹配所有文件，请填内容或删掉这一行。`;
    if (duplicateKeys.size > 0) return `有 ${duplicateKeys.size} 组重复（忽略大小写）：重复规则不会让过滤更严格，只会让条数虚高。`;
    if (draft.length > MAX_RULES) return `最多 ${MAX_RULES} 条（当前 ${draft.length} 条）。`;
    return '';
  })();

  const patchRow = (id: string, pattern: string): void => {
    setDraft((rows) => rows.map((rule) => (rule.id === id ? { ...rule, pattern } : rule)));
  };

  const removeRow = (id: string): void => {
    setDraft((rows) => rows.filter((rule) => rule.id !== id));
  };

  const addRow = (): void => {
    const pattern = input.trim();
    if (pattern === '') return;
    if (draft.length >= MAX_RULES) {
      addToast(`最多 ${MAX_RULES} 条规则`);
      return;
    }
    /* id 只是渲染 key（后端整表替换，不认身份）；用递增序号保证同一会话内不撞。 */
    const id = `new-${Date.now()}-${draft.length}`;
    setDraft((rows) => [...rows, { id, pattern, description: '' }]);
    setInput('');
  };

  const save = (): void => {
    if (blocked) return;
    setSaving(true);
    setError('');
    void api.updateSensitiveRules(draft.map((rule) => ({
      id: rule.id || `r-${keyOf(rule.pattern)}`,
      pattern: rule.pattern.trim(),
      description: rule.description,
    }))).then((envelope) => {
      setSaving(false);
      if (!envelope.ok) {
        setError(envelope.error?.message ?? '保存失败');
        return;
      }
      const { rules, purged } = envelope.data;
      setBaseline(rules);
      setDraft(rules);
      onSaved?.(rules, purged);
      /* 清理结果分三种说，不能合并：
       *   有清理 → 说明收紧了并清掉多少（这是用户最需要知道的）；
       *   没清理 → 明确「存量里本来就没有命中」，
       *   否则用户会怀疑是不是没生效。 */
      addToast(purged.chunks > 0
        ? `规则已保存（${rules.length} 条）· 按新规则清掉 ${purged.chunks} 个索引块（${purged.files} 个文件）`
        : `规则已保存（${rules.length} 条）· 存量索引里没有命中新规则的块（放宽规则不会补建索引）`);
      onClose();
    });
  };

  return (
    <div className="sre">
      <div className="sre-note">
        文件树与终端在下一次请求 / 下一条命令就按新规则过滤；索引会按新规则清掉存量块，
        新增文件在下一次建索引时跳过。<b>放宽规则不会补建索引</b>——那时搜不到是「还没索引」，不是「规则没生效」。
      </div>

      {loading ? <div className="sre-empty">正在读取规则…</div> : null}

      {!loading ? (
        <div className="sre-list">
          {draft.map((rule, index) => {
            const key = keyOf(rule.pattern);
            const duplicated = duplicateKeys.has(key);
            const blank = key === '';
            /* 描述只在 pattern 没被改过时显示：改过之后那句说明就不再描述这条规则了。 */
            const original = baseline.find((item) => item.id === rule.id);
            const description = original && keyOf(original.pattern) === key ? rule.description : '';
            return (
              <div className={`sre-row${duplicated || blank ? ' bad' : ''}`} key={rule.id}>
                <span className="sre-idx">{index + 1}</span>
                <div className="sre-main">
                  <input
                    className="minput sre-input"
                    value={rule.pattern}
                    spellCheck={false}
                    placeholder="例如 *.pem / secrets/ / .env"
                    onChange={(event) => patchRow(rule.id, event.target.value)}
                  />
                  {duplicated ? <span className="sre-hint bad">与另一行重复（忽略大小写）</span> : null}
                  {blank ? <span className="sre-hint bad">空规则会匹配所有文件</span> : null}
                  {!duplicated && !blank && description ? <span className="sre-hint">{description}</span> : null}
                </div>
                <button
                  className="sre-del"
                  type="button"
                  title={draft.length <= 1 ? '至少保留 1 条规则' : '删除这条规则'}
                  aria-label="删除这条规则"
                  onClick={() => removeRow(rule.id)}
                >
                  删除
                </button>
              </div>
            );
          })}
          {draft.length === 0 ? <div className="sre-empty">一条规则都没有了，请至少添加一条。</div> : null}
        </div>
      ) : null}

      <div className="sre-add">
        <input
          className="minput sre-input"
          value={input}
          spellCheck={false}
          placeholder="新增规则（支持 * 前缀、目录以 / 结尾、以 . 开头的按文件名前缀匹配）"
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') addRow();
          }}
        />
        <button className="btn" type="button" onClick={addRow} disabled={input.trim() === ''}>
          添加
        </button>
      </div>

      {error ? <div className="sre-err">{error}</div> : null}
      {blocked ? <div className="sre-warn">{blocked}</div> : null}

      <div className="mfoot sre-foot">
        <span className="sre-count">
          {baseline.length} 条 → {draft.length} 条{dirty ? '' : '（无改动）'}
        </span>
        <button className="btn" type="button" onClick={onClose} disabled={saving}>
          取消
        </button>
        <button className="btn p" type="button" onClick={save} disabled={saving || !!blocked || !dirty}>
          {saving ? '保存中…' : '保存'}
        </button>
      </div>
    </div>
  );
}
