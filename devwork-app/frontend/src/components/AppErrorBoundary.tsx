import React from 'react';

/**
 * 全局错误边界 —— 唯一目的：别让渲染期异常变成一片白屏。
 *
 * 为什么需要：React 18 里没有 error boundary 时，任何组件抛错都会卸载整棵树，
 * 用户看到的是纯白窗口，连「哪里坏了」都不知道（打包态尤其致命：没有 devtools）。
 * 这里把错误、组件栈和原始堆栈原样摊在窗口里，截图就能定位。
 *
 * 只兜渲染 / 生命周期 / 构造期异常；事件处理器与异步错误不归边界管，
 * 那些在控制台里本来就有完整栈。
 */
interface Props {
  children: React.ReactNode;
}

interface State {
  error: Error | null;
  info: string;
}

export default class AppErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null, info: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    /* 控制台留一份：开发者打开 devtools 能看到与界面同一份内容。 */
    console.error('[DevWork] 渲染崩溃：', error, info.componentStack);
    this.setState({ info: info.componentStack ?? '' });
  }

  render(): React.ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          overflow: 'auto',
          padding: '32px 40px',
          background: 'var(--bg, #0f1115)',
          color: 'var(--text, #e6e8ee)',
          font: '13px/1.6 ui-monospace, "Cascadia Code", Consolas, monospace',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 12, color: 'var(--danger, #ff6b6b)' }}>
          界面渲染出错，已停止绘制
        </div>
        <div style={{ opacity: 0.75, marginBottom: 20 }}>
          把这段截图发给开发者即可定位。点下面的按钮可以重新加载界面。
        </div>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{error.name}: {error.message}</div>
        <pre style={{ whiteSpace: 'pre-wrap', margin: '0 0 20px', opacity: 0.85 }}>{error.stack ?? '(无堆栈)'}</pre>
        {info ? (
          <>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>组件栈</div>
            <pre style={{ whiteSpace: 'pre-wrap', margin: '0 0 20px', opacity: 0.85 }}>{info}</pre>
          </>
        ) : null}
        <button
          type="button"
          onClick={() => { window.location.reload(); }}
          style={{
            padding: '6px 16px',
            borderRadius: 6,
            border: '1px solid var(--border, #2a2f3a)',
            background: 'var(--panel, #171a21)',
            color: 'inherit',
            cursor: 'pointer',
          }}
        >
          重新加载
        </button>
      </div>
    );
  }
}
