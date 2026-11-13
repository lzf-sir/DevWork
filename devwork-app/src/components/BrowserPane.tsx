/**
 * 内置浏览器（右栏工作台 · 浏览器 Tab）。
 *
 * 这一块要成立，Agent 必须**真的能开网页**，而不是文案上写着"支持浏览器"。所以链路是双向的：
 *   写：Agent 调 browser_navigate → 服务端写会话浏览器状态 → 本面板轮询到 → 跳转；
 *   读：面板把当前页标题与正文回传服务端 → Agent 的 browser_read_page 读到。
 *
 * 桌面端用 <webview>（独立 Chromium 实例，跨域页面也能正常渲染，还能执行脚本取正文）；
 * Web 开发态退化为 <iframe>——跨域正文读不到（浏览器同源策略），此时如实说读不到，
 * 不拿假内容糊弄 Agent。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import { api } from '../api/client';
import { ArrowIcon, ExternalIcon, RefreshIcon } from './icons';

/** <webview> 的命令式接口（Electron 提供，非标准 DOM）。 */
interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>;
  executeJavaScript(code: string): Promise<unknown>;
  reload(): void;
  goBack(): void;
  goForward(): void;
  canGoBack(): boolean;
  canGoForward(): boolean;
  getURL(): string;
}

/**
 * 桌面端判定。
 *
 * 首选 window.desktop（Electron preload 注入）；没有 preload 的场景
 * （例如自动化测试窗口）退到 userAgent 判定 —— 两种情况都是真正的 Electron
 * 渲染进程，内置浏览器都该走 <webview> 而不是 iframe。
 */
const IS_ELECTRON = typeof window !== 'undefined'
  && (!!window.desktop || /Electron/i.test(navigator.userAgent));

/** 轮询间隔：Agent 导航到页面跳转之间，肉眼可察的等待上限。 */
const POLL_MS = 2000;

/** 地址规范化（前端侧兜底；服务端也会再校验一次）。 */
function normalizeUrl(raw: string): string {
  const text = raw.trim();
  if (!text) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
  /* 缺 scheme：回环地址补 http（本机服务多是 http），其余补 https。 */
  const loopback = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?)(:\d+)?([/?#].*)?$/i.test(text);
  return `${loopback ? 'http' : 'https'}://${text}`;
}

export default function BrowserPane(): React.ReactElement {
  const { state, setBrowserUrl, addToast } = useStore();
  const conversationId = state.activeConversationId;
  const url = state.browserUrl;

  const [draft, setDraft] = useState<string>(url);
  const [history, setHistory] = useState<string[]>([]);
  const [cursor, setCursor] = useState<number>(-1);
  const [canBack, setCanBack] = useState<boolean>(false);
  const [canForward, setCanForward] = useState<boolean>(false);
  const [source, setSource] = useState<'user' | 'agent' | 'none'>('none');
  const [note, setNote] = useState<string>('');
  /** Web 模式下强制重建 iframe 的 key（iframe 没有 reload API）。 */
  const [reloadKey, setReloadKey] = useState<number>(0);

  const hostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const webviewRef = useRef<WebviewElement | null>(null);
  /** 当前真实地址：与 store 不同步是为了避免「用户点链接 → setState → 回灌 src」的循环。 */
  const currentRef = useRef<string>(url);
  const historyRef = useRef<string[]>([]);
  const cursorRef = useRef<number>(-1);

  /**
   * 安全调用 webview 命令式 API：未挂上 DOM / 未 dom-ready 时这些方法**同步抛错**，
   * `.catch` 挂不上（loadURL 就没返回 Promise），会顺着轮询链冒成未处理 rejection。
   * 统一在这里兜住 —— 未就绪就跳过这一次，下一轮再试。
   */
  const safeWebview = useCallback((fn: (wv: WebviewElement) => void): void => {
    const wv = webviewRef.current;
    if (!wv) return;
    try {
      fn(wv);
    } catch {
      /* webview 未就绪：跳过这一次。 */
    }
  }, []);

  /* 地址栏跟随外部变化（Agent 导航 / 命令面板跳转）。 */
  useEffect(() => {
    setDraft(url);
  }, [url]);

  /** 把当前页的标题与正文回传服务端，供 Agent 的 browser_read_page 读。 */
  const capturePage = useCallback(async (): Promise<void> => {
    if (!conversationId) return;
    try {
      if (webviewRef.current) {
        const raw = await webviewRef.current.executeJavaScript(
          'JSON.stringify({ title: document.title || "", text: (document.body ? document.body.innerText : "").slice(0, 8000) })',
        );
        const parsed = JSON.parse(String(raw)) as { title: string; text: string };
        void api.setBrowserPage(conversationId, { title: parsed.title, text: parsed.text });
        return;
      }
      /* Web 模式：同源页面能读，跨域读不到 —— 读不到就不读，不编。 */
      const doc = frameRef.current?.contentDocument;
      if (!doc) return;
      void api.setBrowserPage(conversationId, {
        title: doc.title ?? '',
        text: (doc.body?.innerText ?? '').slice(0, 8000),
      });
    } catch {
      /* 页面尚未加载完或跨域受限：跳过这一次抓取。 */
    }
  }, [conversationId]);

  /** 跳到指定地址。 */
  const go = useCallback((target: string, by: 'user' | 'agent'): void => {
    const next = normalizeUrl(target);
    if (!next) return;
    currentRef.current = next;
    setBrowserUrl(next);
    setSource(by);
    setNote(by === 'agent' ? 'Agent 已接管本页' : '');
    /* 历史：Agent 导航也进历史（用户想回退时能回去）。 */
    const nextHistory = historyRef.current.slice(0, cursorRef.current + 1);
    nextHistory.push(next);
    historyRef.current = nextHistory;
    cursorRef.current = nextHistory.length - 1;
    setHistory(nextHistory);
    setCursor(cursorRef.current);
    safeWebview((wv) => void wv.loadURL(next).catch(() => undefined));
    /* Web 模式下 iframe 的 src 由 render 直接跟随 store.browserUrl。 */
    if (by === 'user' && conversationId) void api.setBrowserState(conversationId, next);
  }, [conversationId, setBrowserUrl]);

  /* ---- 桌面端：挂载 <webview> ---- */
  useEffect(() => {
    if (!IS_ELECTRON) return;
    const host = hostRef.current;
    if (!host) return;
    const wv = document.createElement('webview') as WebviewElement;
    /* 独立 partition：浏览器的 cookie / 存储与主应用会话隔离。 */
    wv.setAttribute('partition', 'devwork-browser');
    wv.setAttribute('allowpopups', 'false');
    /* 显式给初始 src：无 src 的 webview 客体可能永不初始化（dom-ready 不来），
     * 之后 loadURL 会被静默吞掉 —— Agent 导航就会丢。about:blank 先把客体拉起来。 */
    wv.setAttribute('src', 'about:blank');
    const onNavigate = (event: Event): void => {
      const target = event as Event & { url?: string };
      let next = target.url ?? '';
      let back = false;
      let forward = false;
      safeWebview((wv) => {
        next = next || wv.getURL();
        back = wv.canGoBack();
        forward = wv.canGoForward();
      });
      if (!next) return;
      currentRef.current = next;
      setBrowserUrl(next);
      setDraft(next);
      setCanBack(back);
      setCanForward(forward);
      void capturePage();
    };
    wv.addEventListener('did-navigate', onNavigate);
    wv.addEventListener('did-navigate-in-page', onNavigate);
    /* 冷启动窗口期 Agent 导航会撞上「未就绪」：go() 里 loadURL 被安全跳过且不会重试，
     * dom-ready 时对照目标地址补一发，别把这次导航丢了。 */
    wv.addEventListener('dom-ready', () => {
      safeWebview((wvEl) => {
        const want = currentRef.current;
        if (!want) return;
        let now = '';
        try {
          now = wvEl.getURL();
        } catch {
          now = '';
        }
        if (now !== want) void wvEl.loadURL(want).catch(() => undefined);
      });
    });
    wv.addEventListener('new-window', (event) => {
      const target = event as Event & { url?: string };
      if (target.url) void window.desktop?.openExternal(target.url);
    });
    host.appendChild(wv);
    webviewRef.current = wv;
    if (currentRef.current) safeWebview((wvEl) => void wvEl.loadURL(currentRef.current).catch(() => undefined));
    return () => {
      webviewRef.current = null;
      if (wv.parentNode === host) host.removeChild(wv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- Agent 导航通道：轮询服务端会话浏览器状态 ---- */
  useEffect(() => {
    if (!conversationId) return;
    const timer = window.setInterval(() => {
      void api.getBrowserState(conversationId).then((envelope) => {
        if (!envelope.ok) return;
        const next = envelope.data.url;
        if (!next || next === currentRef.current) return;
        /* 只响应 Agent 的驱动：用户自己的导航由本地 go() 处理。 */
        if (envelope.data.by !== 'agent') return;
        go(next, 'agent');
      });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [conversationId, go]);

  const back = (): void => {
    if (cursorRef.current <= 0) return;
    const target = cursorRef.current - 1;
    cursorRef.current = target;
    setCursor(target);
    const next = historyRef.current[target] ?? '';
    currentRef.current = next;
    setBrowserUrl(next);
    setDraft(next);
    safeWebview((wv) => void wv.loadURL(next).catch(() => undefined));
  };

  const forward = (): void => {
    if (cursorRef.current >= historyRef.current.length - 1) return;
    const target = cursorRef.current + 1;
    cursorRef.current = target;
    setCursor(target);
    const next = historyRef.current[target] ?? '';
    currentRef.current = next;
    setBrowserUrl(next);
    setDraft(next);
    safeWebview((wv) => void wv.loadURL(next).catch(() => undefined));
  };

  const reload = (): void => {
    if (webviewRef.current) {
      webviewRef.current.reload();
      void capturePage();
      return;
    }
    /* iframe 没有 reload API：换 key 强制重建。 */
    setReloadKey((value) => value + 1);
  };

  const submit = (): void => {
    const next = normalizeUrl(draft);
    if (!next) {
      addToast('请输入要访问的地址');
      return;
    }
    go(next, 'user');
  };

  return (
    <div className="brp">
      <div className="brp-bar">
        <button className="brp-nav" type="button" title="后退" aria-label="后退" disabled={cursor <= 0} onClick={back}>
          <ArrowIcon dir="left" size={13} strokeWidth={1.6} />
        </button>
        <button className="brp-nav" type="button" title="前进" aria-label="前进" disabled={cursor >= history.length - 1} onClick={forward}>
          <ArrowIcon dir="right" size={13} strokeWidth={1.6} />
        </button>
        <button className="brp-nav" type="button" title="刷新" aria-label="刷新" onClick={reload}>
          <RefreshIcon size={13} strokeWidth={1.5} />
        </button>
        <input
          className="brp-url"
          value={draft}
          placeholder="输入网址，回车访问"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') submit();
          }}
        />
        <button
          className="brp-nav"
          type="button"
          title="在系统浏览器打开"
          aria-label="在系统浏览器打开"
          onClick={() => {
            if (!currentRef.current) return;
            void window.desktop?.openExternal(currentRef.current);
          }}
        >
          <ExternalIcon size={13} strokeWidth={1.5} />
        </button>
      </div>

      <div className="brp-view">
        {IS_ELECTRON ? (
          <div className="brp-host" ref={hostRef} />
        ) : (
          <iframe
            className="brp-frame"
            key={reloadKey}
            ref={frameRef}
            title="内置浏览器"
            src={url || 'about:blank'}
            /* 纯 Web 回落（没有 Electron 时才用 iframe）：同源页面读得到正文，
               跨域读不到 —— 读不到就说读不到，不编。 */
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            onLoad={() => void capturePage()}
          />
        )}
        {!url ? (
          <div className="brp-empty">
            <span>输入一个网址开始</span>
            <span className="brp-empty-sub">Agent 也能导航这个浏览器（browser_navigate）</span>
          </div>
        ) : null}
      </div>

      <div className="brp-foot">
        <span className={`brp-tag${source === 'agent' ? ' agent' : ''}`}>
          {source === 'agent' ? 'Agent 驱动' : '用户导航'}
        </span>
        <span className="brp-note" title={note || '桌面端可读取页面正文供 Agent 摘要'}>
          {note || (IS_ELECTRON ? '页面正文可回传给 Agent' : 'Web 模式读不到跨域正文')}
        </span>
      </div>
    </div>
  );
}
