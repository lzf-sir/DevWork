/**
 * 上下文用量（输入框那个小按钮的数据源）。
 *
 * 为什么不把这套逻辑塞进 Composer：
 *   · 压缩要落到会话时间线上（插入摘要卡）、要回写全局用量 —— 这两件事属于页面，不属于输入框；
 *   · 输入框在三个地方被复用（会话页 / 资产会话坞 / 协作流），数据源必须只有一份。
 *
 * 刷新时机：每轮结束后（refreshKey 变）与用户点「刷新」。不做轮询 ——
 * 上下文只在"发完一轮"和"压缩完"这两个时刻变，轮询纯属白烧 CPU。
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type CompactionResult, type ContextUsage } from '../api/client';

export interface ContextMeter {
  usage: ContextUsage | null;
  loading: boolean;
  compacting: boolean;
  refresh: () => void;
  compact: () => void;
}

export interface ContextMeterOptions {
  /** 会话级模型覆盖：预算与摘要模型都按它算。 */
  model?: string;
  /** 变化时重新拉一次（传会话消息条数即可）。 */
  refreshKey?: number;
  /** 压缩成功后的回调（插摘要卡 / 回写用量 / 提示），由页面决定。 */
  onCompacted?: (result: CompactionResult) => void;
  /** 压缩失败或无事可做时的提示出口。 */
  onNotice?: (message: string) => void;
}

export function useContextUsage(conversationId: string, options: ContextMeterOptions = {}): ContextMeter {
  const { model = '', refreshKey = 0, onCompacted, onNotice } = options;
  const [usage, setUsage] = useState<ContextUsage | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [compacting, setCompacting] = useState<boolean>(false);

  const refresh = useCallback(() => {
    if (!conversationId) {
      setUsage(null);
      return;
    }
    setLoading(true);
    void api
      .getContextUsage(conversationId, model || undefined)
      .then((envelope) => {
        /* 失败时保留上一份，不清空 —— 把面板清空等于告诉用户"没有上下文"，那是假消息。 */
        if (envelope.ok && envelope.data) setUsage(envelope.data);
      })
      .catch(() => undefined)
      .finally(() => setLoading(false));
  }, [conversationId, model]);

  useEffect(() => {
    refresh();
  }, [refresh, refreshKey]);

  const compact = useCallback(() => {
    if (!conversationId || compacting) return;
    setCompacting(true);
    void api
      .compactContext(conversationId, model ? { model } : undefined)
      .then((envelope) => {
        if (!envelope.ok || !envelope.data) {
          onNotice?.(`压缩失败：${envelope.error?.message ?? '网络异常'}`);
          return;
        }
        onCompacted?.(envelope.data);
      })
      .catch(() => onNotice?.('压缩失败：网络异常'))
      .finally(() => {
        setCompacting(false);
        refresh();
      });
  }, [conversationId, model, compacting, onCompacted, onNotice, refresh]);

  return { usage, loading, compacting, refresh, compact };
}
