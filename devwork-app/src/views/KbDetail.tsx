import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { api } from '../api/client';
import type { AssetDetail, KbDocument, KbDocumentList, SearchHit } from '../api/client';
import { DetailHeader, DetailTabs, GearSvg, MetricGrid, Pill } from '../components/ui';
import { BookIcon, DotsIcon } from '../components/icons';
import AssetConfigDrawer from '../components/AssetConfigDrawer';

const TABS = [
  { id: 'main', label: '文档' },
  { id: 'search', label: '检索' },
];

/**
 * 知识库详情：文档清单 + 原文阅读 + 检索定位。
 *
 * 三件事都是真的：文档清单来自 index_chunk 的真实统计，原文来自磁盘上的
 * docs/ 文件，检索走的是 FTS5 / 词元 LIKE。点命中能滚到真实行号，
 * 不像旧版只能弹一句"检索型资产暂无详情页"。
 */
export default function KbDetail(): React.ReactElement {
  const { state, setDetailTab, navigate, addToast, setConfigOpen } = useStore();
  const [asset, setAsset] = useState<AssetDetail | null>(null);
  const [docs, setDocs] = useState<KbDocumentList | null>(null);
  const [activePath, setActivePath] = useState<string>('');
  const [plain, setPlain] = useState<string>('');
  const [missing, setMissing] = useState<boolean>(false);
  const [highlight, setHighlight] = useState<{ start: number; end: number } | null>(null);
  const [query, setQuery] = useState<string>('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState<boolean>(false);
  const [reindexing, setReindexing] = useState<boolean>(false);
  const readerRef = useRef<HTMLDivElement>(null);

  const loadDocuments = useCallback((preferPath?: string) => {
    void api.listDocuments('a-kb').then((envelope) => {
      if (!envelope.ok || !Array.isArray(envelope.data.files)) return;
      setDocs(envelope.data);
      const first = envelope.data.files.find((file) => file.path === preferPath) ?? envelope.data.files[0];
      setActivePath((prev) => preferPath ?? (prev || first?.path || ''));
    });
  }, []);

  useEffect(() => {
    let alive = true;
    void api.getAsset('a-kb').then((envelope) => {
      if (alive && envelope.ok) setAsset(envelope.data);
    });
    loadDocuments();
    return () => {
      alive = false;
    };
  }, [loadDocuments]);

  /* 切文档就重新读盘；文件被删时明确说「磁盘上没有」，不拿旧内容冒充。 */
  useEffect(() => {
    if (!activePath) return;
    let alive = true;
    void api.getFileContent('a-kb', activePath).then((envelope) => {
      if (!alive) return;
      if (!envelope.ok) {
        setPlain('');
        setMissing(true);
        return;
      }
      setMissing(envelope.data.plain.length === 0);
      setPlain(envelope.data.plain);
    });
    return () => {
      alive = false;
    };
  }, [activePath]);

  /* 高亮命中后把该行滚到视野中间（渲染完成下一帧再滚）。 */
  useEffect(() => {
    if (!highlight) return;
    const timer = window.setTimeout(() => {
      const container = readerRef.current;
      const line = container?.querySelector(`[data-ln="${highlight.start}"]`);
      if (line && typeof line.scrollIntoView === 'function') {
        line.scrollIntoView({ block: 'center' });
      }
    }, 60);
    return () => window.clearTimeout(timer);
  }, [highlight, plain]);

  const openDocument = (file: KbDocument, startLine?: number, endLine?: number): void => {
    setActivePath(file.path);
    setHighlight(startLine ? { start: startLine, end: endLine ?? startLine } : null);
    setDetailTab('main');
  };

  const runSearch = (): void => {
    const value = query.trim();
    if (!value) {
      setHits(null);
      addToast('请输入检索词');
      return;
    }
    setSearching(true);
    void api
      .searchAsset('a-kb', value)
      .then((envelope) => {
        if (!envelope.ok) {
          addToast(`检索失败：${envelope.error?.message ?? '未知错误'}`);
          setHits([]);
          return;
        }
        setHits(envelope.data);
        if (envelope.data.length === 0) addToast('没有命中片段 · 试试「GMV」「退款」「复盘」');
      })
      .catch(() => {
        setHits([]);
        addToast('检索失败：网络异常');
      })
      .finally(() => setSearching(false));
  };

  const rebuildIndex = (): void => {
    setReindexing(true);
    void api
      .advanceIndex('a-kb')
      .then((envelope) => {
        if (!envelope.ok) {
          addToast(`重建失败：${envelope.error?.message ?? '未知错误'}`);
          return;
        }
        const chunks = Number(envelope.data.chunks ?? 0);
        const files = Number(envelope.data.files ?? 0);
        addToast(`索引已重建：${files} 个文档 / ${chunks} 个片段`);
        loadDocuments(activePath);
      })
      .catch(() => addToast('重建失败：网络异常'))
      .finally(() => setReindexing(false));
  };

  const lines = plain ? plain.split(/\r?\n/) : [];
  const activeDoc = docs?.files.find((file) => file.path === activePath);

  const metrics = [
    { k: '文档', v: String(docs?.documents ?? 0), s: '篇' },
    { k: '索引片段', v: String(docs?.chunks ?? 0), s: '块' },
    { k: '当前文档', v: activeDoc ? String(activeDoc.lines) : '—', s: '行' },
    { k: '索引方式', v: 'FTS5', s: 'BM25' },
  ];

  return (
    <div className={`view${state.view === 'detail-kb' ? ' on' : ''}`} data-view="detail-kb">
      <DetailHeader
        icon={<BookIcon size={15} strokeWidth={1.4} />}
        name={asset?.name ?? '运营知识库'}
        sub={asset?.subtitle || `${docs?.documents ?? 0} 个文档 · ${docs?.chunks ?? 0} 个片段`}
        pills={
          <>
            <Pill tone="ok">
              <span className="sdot" />
              索引就绪
            </Pill>
            <Pill tone="ro">只读</Pill>
          </>
        }
        actions={
          <>
            <button className="btn" onClick={() => navigate('chat')}>
              在会话中提问
            </button>
            <button className="btn p" onClick={rebuildIndex} disabled={reindexing}>
              {reindexing ? '重建中…' : '重建索引'}
            </button>
            <button
              className="dcfg"
              type="button"
              title="资产配置（文档清单 / 索引信息）"
              aria-label="资产配置"
              onClick={() => setConfigOpen(true)}
            >
              <GearSvg />
            </button>
          </>
        }
      />
      <DetailTabs tabs={TABS} active={state.detailTab} onChange={setDetailTab} />

      {state.detailTab === 'main' ? (
        <div className={`dbody${state.detailTab === 'main' ? ' on' : ''}`} data-dt="main">
          <div className="kb-wrap">
            <div className="kb-docs">
              <div className="kb-docs-t">文档</div>
              {(docs?.files ?? []).map((file) => (
                <div
                  className={`kb-doc${file.path === activePath ? ' on' : ''}`}
                  key={file.path}
                  onClick={() => {
                    setActivePath(file.path);
                    setHighlight(null);
                  }}
                >
                  <span className="n">{file.name}</span>
                  <span className="m">{file.chunks} 片段</span>
                </div>
              ))}
            </div>
            <div className="kb-reader" ref={readerRef}>
              <div className="kb-reader-h">
                <span className="p">{activePath || '—'}</span>
                {highlight ? (
                  <span className="hl">
                    高亮 L{highlight.start}
                    {highlight.end > highlight.start ? `-L${highlight.end}` : ''}
                    <button className="btn" type="button" onClick={() => setHighlight(null)}>
                      清除
                    </button>
                  </span>
                ) : null}
              </div>
              {missing ? (
                <div className="kb-empty">
                  磁盘上没有 {activePath} 这个文件（索引里还留着它的片段，说明该重建索引）。
                </div>
              ) : (
                <div className="kb-lines">
                  {lines.map((text, index) => {
                    const ln = index + 1;
                    const on = !!highlight && ln >= highlight.start && ln <= highlight.end;
                    return (
                      <div className={`kb-line${on ? ' on' : ''}`} data-ln={ln} key={ln}>
                        <span className="g">{ln}</span>
                        <span className="x">{text || ' '}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      ) : null}

      {state.detailTab === 'search' ? (
        <div className={`dbody${state.detailTab === 'search' ? ' on' : ''}`} data-dt="search">
          <div className="ov">
            <div className="kb-search">
              <input
                value={query}
                placeholder="例如：GMV 口径 / 退款 / 复盘"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') runSearch();
                }}
              />
              <button className="btn p" type="button" onClick={runSearch} disabled={searching}>
                {searching ? '检索中…' : '检索'}
              </button>
            </div>
            {hits === null ? (
              <div className="kb-empty">输入关键词后回车。检索走 FTS5（降级词元 LIKE），命中的行号可以直接点开。</div>
            ) : hits.length === 0 ? (
              <div className="kb-empty">没有命中片段。</div>
            ) : (
              <div className="kb-hits">
                {hits.map((hit) => {
                  const file = docs?.files.find((item) => item.path === hit.path);
                  return (
                    <div className="kb-hit" key={hit.id}>
                      <div className="kb-hit-h">
                        <span className="p">{hit.locator}</span>
                        <span className="s">score {hit.score}</span>
                      </div>
                      <div className="kb-hit-b">{hit.title}</div>
                      <button
                        className="btn"
                        type="button"
                        onClick={() => {
                          if (!file) {
                            addToast('该片段所属文档已不在索引清单里，请重建索引');
                            return;
                          }
                          openDocument(file, hit.startLine, hit.endLine);
                        }}
                      >
                        打开到 L{hit.startLine}
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : null}

      <AssetConfigDrawer
        open={state.configOpen && state.view === 'detail-kb'}
        title={asset?.name ?? '运营知识库'}
        sub={asset?.subtitle || `${docs?.documents ?? 0} 个文档 · ${docs?.chunks ?? 0} 个片段`}
        metrics={metrics}
        onClose={() => setConfigOpen(false)}
      >
        <div className="sect-t">文档清单</div>
        <div className="kb-table">
          {docs && docs.files.length > 0 ? (
            docs.files.map((file) => (
              <div className="kb-row" key={file.path} onClick={() => openDocument(file)}>
                <span className="p">{file.path}</span>
                <span className="c">{file.chunks} 片段</span>
                <span className="c">{file.lines} 行</span>
              </div>
            ))
          ) : (
            <div className="kb-empty">
              还没有可检索的文档。把 Markdown 放进仓库的 docs/ 目录后点「重建索引」。
            </div>
          )}
        </div>
        <div className="kb-note">
          清单来自 index_chunk 的真实统计，行数由磁盘文件现场数出；
          没有任何一条是预置的假数据。
        </div>
      </AssetConfigDrawer>
    </div>
  );
}
