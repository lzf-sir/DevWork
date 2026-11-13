/**
 * DbDataGrid —— Navicat 式数据网格。
 *
 * 三个容易被忽略但决定专业度的细节：
 * 1. 行号列 —— 报错时用户能精确说「第 37 行有问题」，没有行号就只能干瞪眼。
 * 2. NULL 与空串必须视觉可分 —— NULL 是灰斜体的「NULL」，空串是空白。
 *    这两者混了，排查数据问题会被误导半天（设计文档 §9.12 明确要求）。
 * 3. 列头排序必须有方向箭头 —— 否则用户不知道当前是升序还是降序。
 */
import React from 'react';
import { copyToClipboard } from './ui';
import { SortAscIcon, SortDescIcon, SortIcon } from './icons';

export interface GridSort {
  column: string;
  direction: 'asc' | 'desc';
}

/** 排序态：null 表示当前无排序（列头不显示方向箭头）。 */
export type GridSortState = GridSort | null;

export default function DbDataGrid({
  columns,
  rows,
  sort,
  onSort,
  onCellAction,
  rowOffset = 0,
  highlightColumns = [],
}: {
  columns: string[];
  rows: unknown[][];
  sort?: GridSortState;
  onSort?: (column: string) => void;
  onCellAction?: (column: string, value: unknown, rowIndex: number) => void;
  /** 行号起点：翻页时第 2 页的第一行应该是 51 而不是 1。 */
  rowOffset?: number;
  /** 需要高亮为枚举的列（status/state/channel 之类）。 */
  highlightColumns?: string[];
}): React.ReactElement {
  if (columns.length === 0) {
    return (
      <div className="dbgrid-empty">
        <span>没有可显示的数据</span>
      </div>
    );
  }

  return (
    <table className="g dbgrid">
      <thead>
        <tr>
          <th className="dbgrid-rn">#</th>
          {columns.map((column, columnIndex) => {
            const active = sort?.column === column;
            return (
              <th
                key={column}
                className={active ? 'dbgrid-sorted' : ''}
                title={onSort ? `按 ${column} 排序` : undefined}
                onClick={onSort ? () => onSort(column) : undefined}
              >
                <span className="dbgrid-th">
                  {column}
                  {onSort ? (
                    <span className={`dbgrid-sort${active ? ' on' : ''}`}>
                      {active ? (
                        sort?.direction === 'desc' ? (
                          <SortDescIcon size={11} strokeWidth={1.5} />
                        ) : (
                          <SortAscIcon size={11} strokeWidth={1.5} />
                        )
                      ) : (
                        <SortIcon size={11} strokeWidth={1.4} />
                      )}
                    </span>
                  ) : null}
                </span>
                {highlightColumns.includes(column) ? (
                  <span className="dbgrid-enum" title="枚举列">
                    enum
                  </span>
                ) : null}
                {columnIndex === 0 ? null : null}
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, rowIndex) => (
          <tr key={rowIndex}>
            <td className="dbgrid-rn">{rowOffset + rowIndex + 1}</td>
            {columns.map((column, cellIndex) => {
              const value = row[cellIndex];
              const isNull = value === null || value === undefined;
              const isEmptyString = typeof value === 'string' && value === '';
              return (
                <td
                  key={column}
                  className={`cellcp${cellIndex === 0 ? ' n' : ''}`}
                  title={isNull ? 'NULL' : isEmptyString ? '（空字符串）' : String(value)}
                  onDoubleClick={() => {
                    if (isNull) return;
                    copyToClipboard(String(value));
                  }}
                  onContextMenu={(event) => {
                    if (!onCellAction) return;
                    event.preventDefault();
                    onCellAction(column, value, rowIndex);
                  }}
                >
                  {isNull ? <span className="nul">NULL</span> : isEmptyString ? '' : String(value)}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
