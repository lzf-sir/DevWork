/**
 * 代码库全库检索面板。
 *
 * 和文件内 ⌘F 是**两件事**，不能混在一个入口里：
 *   - ⌘F 在**当前文件的已渲染文本**里找位置，命中即滚动，不需要索引；
 *   - 这里查的是**落盘内容的全文索引**（FTS5，敏感文件按规则排除），
 *     所以要重建索引才看得到新写入的文件。
 * 两者的「搜不到」含义完全不同，所以标题、空态、提示都分开写。
 *
 * 结果行给「文件 + 命中行号 + 该行原文」：只给文件与行号的话，用户还得逐个点进去确认；
 * 片段里命中词高亮，扫一眼就能否掉不对的那几条。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client';
import type { SearchHit } from '../api/types';
import { CloseIcon } from './icons';

/** 与服务端 searchAsset 的切词保持一致：不一致只会让高亮少标几个词，不影响命中。 */
function termsOf(query: string): string[] {
  const tokens = query
    .split(/[\s,;.:()"'`，。？！、/]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2)
    .slice(0, 4);
  return tokens.length > 0 ? tokens : [query.trim()].filter(Boolean);
}

const escapeRe = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 命中的词上标记：snippet 是服务端截断的原文，这里只做视觉强调，不改内容。 */
function marked(text: string, terms: string[]): React.ReactNode {
  if (terms.length === 0 || text === '') return text;
  const lowered = terms.map((term) => term.toLowerCase());
  const parts = text.split(new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi'));
  return parts.map((part, index) => (
    lowered.includes(part.toLowerCase())
      ? <mark key={index}>{part}</mark>
      : <React.Fragment key={index}>{part}</React.Fragment>
  ));
}

export default function RepoSearchPanel({
  assetId,
  onClose,
  onJump,
}: {
  assetId: string;
  onClose: () => void;
  onJump: (path: string, line: number) => void;
}): React.ReactElement {
  const [query, setQuery] = useState<string>('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [reindexing, setReindexing] = useState<boolean>(false);
  /** 只认最后一次请求：连续输入时先发的可能后到，不校验会把 A 的结果挂在 B 的问题下。 */
  const seq = useRef<number>(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(timer);
  }, []);

  const trimmed = query.trim();

  useEffect(() => {
    if (!assetId || trimmed === '') {
      setHits(null);
      setError('');
      setLoading(false);
      return;
    }
    seq.current += 1;
    const mine = seq.current;
    setLoading(true);
    setError('');
    /* 打字节流：每敲一个字符就查一次，会把 FTS 排队成一串过期请求。 */
    const timer = window.setTimeout(() => {
      void api
        .searchAsset(assetId, trimmed)
        .then((envelope) => {
          if (mine !== seq.current) return;
          if (!envelope.ok) {
            setError(`${envelope.error?.code ?? 'E_INTERNAL'} ${envelope.error?.message ?? ''}`.trim());
            setHits([]);
            return;
          }
          setHits(envelope.data);
        })
        .catch(() => {
          if (mine !== seq.current) return;
          setError('网络异常');
          setHits([]);
        })
        .finally(() => {
          if (mine === seq.current) setLoading(false);
        });
    }, 260);
    return () => window.clearTimeout(timer);
  }, [assetId, trimmed]);

  const terms = useMemo(() => termsOf(trimmed), [trimmed]);

  const rebuild = (): void => {
    setReindexing(true);
    void api
      .advanceIndex(assetId, { to: 100 })
      .then((envelope) => {
        if (!envelope.ok) {
          setError(`重建索引失败：${envelope.error?.message ?? '未知错误'}`);
          return;
        }
        /* 索引变了就重查一次：让用户当场看到结果，而不是自己再敲一遍。 */
        seq.current += 1;
        const mine = seq.current;
        return api.searchAsset(assetId, trimmed).then((result) => {
          if (mine !== seq.current) return;
          setHits(result.ok ? result.data : []);
          setError(result.ok ? '' : '重建后仍检索失败');
        });
      })
      .catch(() => setError('重建索引失败：网络异常'))
      .finally(() => setReindexing(false));
  };

  const jump = (hit: SearchHit): void => {
    /* 跳命中行而不是块首行：块是 40 行窗口，落块首等于让用户自己再找一遍。 */
    onJump(hit.path, hit.snippetLine || hit.startLine);
  };

  const empty = hits !== null && hits.length === 0 && trimmed !== '' && !loading && error === '';

  return (
    <div className="rp rs">
      <div className="rp-head">
        <span>全库检索</span>
        <span style={{ color: 'var(--gray-400)', fontSize: 11 }}>整仓索引 · 与文件内 ⌘F 不同</span>
        {hits !== null && hits.length > 0 ? (
          <span style={{ color: 'var(--gray-400)', fontSize: 11 }}>命中 {hits.length} 处</span>
        ) : null}
        <span className="sp">
          <button className="x" type="button" onClick={onClose} title="关闭全库检索" aria-label="关闭全库检索">
            <CloseIcon size={12} strokeWidth={1.5} />
          </button>
        </span>
      </div>
      <div className="rp-body">
        <input
          ref={inputRef}
          className="rs-input"
          value={query}
          placeholder="搜全库 · 类名 / 方法名 / 报错文本 · Enter 跳第一处"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              onClose();
              return;
            }
            if (event.key === 'Enter' && hits && hits.length > 0) {
              event.preventDefault();
              jump(hits[0]);
            }
          }}
        />
        {loading ? <div className="rp-note">正在检索索引…</div> : null}
        {error !== '' ? <div className="rp-err">检索失败：{error}</div> : null}
        {trimmed === '' ? (
          <div className="rp-note">
            索引是磁盘内容的快照：刚改过的文件要保存并重建索引才搜得到；可疑敏感文件不进索引。
          </div>
        ) : null}
        {empty ? (
          <>
            <div className="rp-lead">「{trimmed}」没有命中。</div>
            <div className="rp-note">
              可能原因：文件还没进索引（新仓库或刚从别的分支拉下来）、命中词在敏感文件里被排除、
              或者这个词确实不在这份代码里。
            </div>
            <button className="rp-re-inline" type="button" onClick={rebuild} disabled={reindexing}>
              {reindexing ? '重建中…' : '重建索引后重试'}
            </button>
          </>
        ) : null}
        {hits !== null && hits.length > 0 ? (
          <>
            {hits.map((hit) => (
              <div
                className="rp-row rs-row"
                key={hit.id}
                /* 不让点击把焦点从输入框带走：连看几处命中时，Esc 关面板、
                 * 接着改词重搜，都还得回到同一个输入框。 */
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => jump(hit)}
                title={`${hit.path}:${hit.snippetLine || hit.startLine}`}
              >
                <span className="rs-loc">
                  <span className="p">{hit.path.split('/').pop()}</span>
                  <span className="n">:{hit.snippetLine || hit.startLine}</span>
                </span>
                <span className="rs-snip">{marked(hit.snippet, terms)}</span>
                <span className="rp-tag">{hit.kind === 'doc' ? 'doc' : 'code'}</span>
              </div>
            ))}
            <div className="rp-note">
              只列前 {hits.length} 处 · 结果按索引相关度排序，敏感文件（按隐私规则排除）不在其中
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
