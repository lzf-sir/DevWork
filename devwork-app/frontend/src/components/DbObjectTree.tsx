/**
 * DbObjectTree —— Navicat 式对象树。
 *
 * 结构：连接 → schema 分组 → 分类（表 / 视图 / 索引）→ 对象。
 * 用户打开一个数据库工具，第一眼要能回答三个问题：
 * 「连的是哪个库」「里面有哪些表」「这张表多大」。
 * 所以节点带行数、分组可折叠、顶部带搜索过滤。
 */
import React, { useMemo, useState } from 'react';
import {
  CaretIcon,
  DatabaseIcon,
  EditIcon,
  IndexIcon,
  TableIcon,
  ViewIcon,
} from './icons';

export interface TreeObject {
  name: string;
  kind: 'table' | 'view' | 'index';
  schema: string;
  rowsLabel: string;
  totalRows: number;
}

const KIND_LABEL: Record<TreeObject['kind'], string> = {
  table: '表',
  view: '视图',
  index: '索引',
};

/** 对象类型 → 图标组件（表 / 视图 / 索引各有专属形状，不再共用 Unicode 几何字符）。 */
const KIND_ICON: Record<TreeObject['kind'], (props: { size?: number; strokeWidth?: number }) => React.ReactElement> = {
  table: TableIcon,
  view: ViewIcon,
  index: IndexIcon,
};

export default function DbObjectTree({
  objects,
  activeTable,
  onOpenTable,
  onOpenQuery,
}: {
  objects: TreeObject[];
  activeTable: string;
  onOpenTable: (table: string) => void;
  onOpenQuery: () => void;
}): React.ReactElement {
  const [keyword, setKeyword] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const filtered = useMemo(() => {
    const needle = keyword.trim().toLowerCase();
    if (!needle) return objects;
    return objects.filter((object) => object.name.toLowerCase().includes(needle));
  }, [objects, keyword]);

  /** 按 schema → 分类 两级分组。 */
  const grouped = useMemo(() => {
    const map = new Map<string, Map<TreeObject['kind'], TreeObject[]>>();
    for (const object of filtered) {
      if (!map.has(object.schema)) map.set(object.schema, new Map());
      const kinds = map.get(object.schema)!;
      if (!kinds.has(object.kind)) kinds.set(object.kind, []);
      kinds.get(object.kind)!.push(object);
    }
    return Array.from(map.entries());
  }, [filtered]);

  const toggle = (key: string): void => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const totalTables = filtered.filter((o) => o.kind === 'table').length;

  return (
    <div className="dbobj">
      <div className="dbobj-head">
        <div className="dbobj-conn">
          <span className="dbobj-ic">
            <DatabaseIcon size={13} strokeWidth={1.4} />
          </span>
          <div className="dbobj-conn-t">
            <div className="dbobj-conn-n">order_db</div>
            <div className="dbobj-conn-s">PostgreSQL 15.4 · prod</div>
          </div>
        </div>
        <input
          className="dbobj-search"
          placeholder="搜索表 / 视图…"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
        />
        <div className="dbobj-quick">
          <button className="btn dbobj-q" onClick={onOpenQuery}>
            <EditIcon size={13} strokeWidth={1.4} />
            新建查询
          </button>
        </div>
      </div>

      <div className="dbobj-body">
        {grouped.length === 0 ? (
          <div className="dbobj-empty">
            {keyword ? `没有匹配「${keyword}」的对象` : '该连接下没有可浏览的对象'}
          </div>
        ) : null}

        {grouped.map(([schema, kinds]) => {
          const schemaKey = `schema:${schema}`;
          const isCollapsed = collapsed[schemaKey] === true;
          const schemaCount = Array.from(kinds.values()).reduce((sum, list) => sum + list.length, 0);
          return (
              <div key={schema} className="dbobj-schema">
              <div className="dbobj-schema-h" onClick={() => toggle(schemaKey)}>
                <CaretIcon dir="down" size={11} strokeWidth={1.5} className={`dbobj-caret${isCollapsed ? ' collapsed' : ''}`} />
                <span className="dbobj-schema-n">{schema}</span>
                <span className="cn2">{schemaCount}</span>
              </div>
              {isCollapsed ? null : (
                <div>
                  {(['table', 'view', 'index'] as const).map((kind) => {
                    const list = kinds.get(kind);
                    if (!list || list.length === 0) return null;
                    const kindKey = `${schemaKey}:${kind}`;
                    const kindCollapsed = collapsed[kindKey] === true;
                    return (
                      <div key={kind} className="dbobj-kg">
                        <div className="tgrp dbobj-kind" onClick={() => toggle(kindKey)}>
                          <CaretIcon dir="down" size={11} strokeWidth={1.5} className={`dbobj-caret${kindCollapsed ? ' collapsed' : ''}`} />
                          {KIND_LABEL[kind]}
                        </div>
                        {kindCollapsed
                          ? null
                          : list.map((object) => (
                              <div
                                className={`tnode${activeTable === object.name ? ' on' : ''}`}
                                key={`${object.kind}:${object.name}`}
                                title={`${object.schema}.${object.name}`}
                                onClick={() => onOpenTable(object.name)}
                              >
                                <span className="ic">
                                  {(() => {
                                    const Icon = KIND_ICON[object.kind];
                                    return <Icon size={12} strokeWidth={1.4} />;
                                  })()}
                                </span>
                                {object.name}
                                {object.kind === 'index' ? null : (
                                  <span className="cn2">{object.rowsLabel}</span>
                                )}
                              </div>
                            ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="dbobj-foot">
        {totalTables} 张表 · {filtered.length} 个对象 · 只读连接
      </div>
    </div>
  );
}
