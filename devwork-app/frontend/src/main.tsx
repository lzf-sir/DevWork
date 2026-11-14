import ReactDOM from 'react-dom/client';
import App from './App';
import { StoreProvider } from './store';
import { LiveDataProvider } from './api/live';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 挂载节点');
}

/**
 * 纯本地工具：没有登录门禁，启动即渲染工作台。
 * Store 与 LiveData 直接挂载，数据全部来自本机服务与本地库。
 */
ReactDOM.createRoot(container).render(
  <StoreProvider>
    <LiveDataProvider>
      <App />
    </LiveDataProvider>
  </StoreProvider>,
);
