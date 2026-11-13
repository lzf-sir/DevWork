/**
 * DbFilterPanel —— Navicat 式筛选条。
 *
 * 心智模型：筛选不是「写 SQL」，而是「给表加条件」。
 * 用户选列 → 选运算符 → 填值 → 立刻看到结果集缩小，
 * 同时顶栏实时显示翻译出来的 WHERE，让他知道系统替他做了什么。
 */
import React from 'react';
import type { BrowseFilter } from '../api/types';
import { CloseIcon, WarningIcon } from './icons';

export const OPERATORS: { value: string; label: string }[] = [
  { value: '=', label: '等于' },
  { value: '!=', label: '不等于' },
  { value: '>', label: '大于' },
  { value: '>=', label: '大于等于' },
  { value: '<', label: '小于' },
  { value: '<=', label: '小于等于' },
  { value: 'LIKE', label: '包含' },
  { value: 'NOT LIKE', label: '不包含' },
  { value: 'IS NULL', label: '为空' },
  { value: 'IS NOT NULL', label: '不为空' },
];

/** 无值运算符：填了值也会被服务端忽略，所以 UI 上直接把输入框禁用掉。 */
const VALUELESS = new Set(['IS NULL', 'IS NOT NULL']);

export default function DbFilterPanel({
  columns,
  filters,
  onChange,
  onClear,
}: {
  columns: string[];
  filters: BrowseFilter[];
  onChange: (next: BrowseFilter[]) => void;
  onClear: () => void;
}): React.ReactElement {
  const patch = (index: number, part: Partial<BrowseFilter>): void => {
    onChange(filters.map((filter, i) => (i === index ? { ...filter, ...part } : filter)));
  };

  const add = (): void => {
    const column = columns[0] ?? '';
    if (!column) return;
    onChange([...filters, { column, operator: '=', value: '' }]);
  };

  const remove = (index: number): void => {
    onChange(filters.filter((_, i) => i !== index));
  };

  /* 值还没填的条件不能参与查询。
   * 服务端按空值匹配会返回 0 行，用户会误以为表被清空了 ——
   * 所以这里在提交层就把未填值的条件剔掉，并在 UI 上明示有几条未生效。 */
  const incomplete = filters.filter(
    (filter) => !VALUELESS.has(filter.operator) && String(filter.value ?? '').trim() === '',
  ).length;

  return (
    <div className="dbfilter">
      <div className="dbfilter-h">
        <span className="dbfilter-t">筛选</span>
        {filters.length === 0 ? (
          <span className="dbfilter-empty">未筛选 · 显示全部 {columns.length > 0 ? '' : ''}行</span>
        ) : null}
        {incomplete > 0 ? (
          <span className="dbfilter-warn" title="未填值的条件暂不生效（不参与查询）—— 请填值或删除该条件">
            <WarningIcon size={12} strokeWidth={1.4} />
            {incomplete} 个条件未填值 · 暂未生效
          </span>
        ) : null}
        <span className="dbfilter-actions">
          <button className="btn" onClick={add} disabled={columns.length === 0}>
            + 条件
          </button>
          {filters.length > 0 ? (
            <button className="btn" onClick={onClear}>
              清除
            </button>
          ) : null}
        </span>
      </div>
      {filters.map((filter, index) => (
        <div className="dbfilter-row" key={index}>
          {index > 0 ? <span className="dbfilter-and">AND</span> : null}
          <select
            className="dbsel"
            value={filter.column}
            onChange={(event) => patch(index, { column: event.target.value })}
          >
            {columns.map((column) => (
              <option key={column} value={column}>
                {column}
              </option>
            ))}
          </select>
          <select
            className="dbsel"
            value={filter.operator}
            onChange={(event) => patch(index, { operator: event.target.value })}
          >
            {OPERATORS.map((operator) => (
              <option key={operator.value} value={operator.value}>
                {operator.label}
              </option>
            ))}
          </select>
          <input
            className="dbinput"
            value={filter.value === null || filter.value === undefined ? '' : String(filter.value)}
            placeholder={VALUELESS.has(filter.operator) ? '（无需填值）' : '值'}
            disabled={VALUELESS.has(filter.operator)}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => patch(index, { value: event.target.value })}
            onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'Enter') patch(index, { value: (event.target as HTMLInputElement).value });
            }}
          />
          <button className="btn dbfilter-x" title="删除该条件" aria-label="删除该条件" onClick={() => remove(index)}>
            <CloseIcon size={12} strokeWidth={1.5} />
          </button>
        </div>
      ))}
    </div>
  );
}
