import React from 'react';
import { useStore } from '../store';
import { api } from '../api/client';
import { useLiveRefresh } from '../api/live';
import { PlusIcon } from '../components/icons';

/** 项目概览：卡片切项目并回到会话；虚线卡新建项目。 */
export default function ProjectsView(): React.ReactElement {
  const { state, setWorkspace, setModal, addProject, addToast } = useStore();
  const refresh = useLiveRefresh();

  /** B2：新建项目写 REST /api/workspaces，成功后刷新装配层；离线时回落本地新增。 */
  const createWorkspace = (name: string): void => {
    void api.createWorkspace({ name, description: '新项目 · 尚未接入资产，索引准备中。' }).then((envelope) => {
      if (!envelope.ok) {
        addToast(`新建项目失败：${envelope.error?.message ?? '未知错误'}`);
        return;
      }
      addProject(name);
      refresh();
      addToast(`已创建项目「${envelope.data.name}」· 服务端已落库`);
    });
  };

  const openNewProject = (): void => {
    setModal({
      kind: 'prompt',
      title: '新建项目',
      label: '输入项目名称：',
      placeholder: '例如：支付链路',
      confirmLabel: '创建',
      onSubmit: createWorkspace,
    });
  };

  return (
    <div className={`view${state.view === 'projects' ? ' on' : ''}`} data-view="projects">
      <div className="chead">
        <div className="ctitle">项目概览</div>
        <div className="acts">
          <button className="btn p" onClick={openNewProject}>
            <PlusIcon size={13} strokeWidth={1.6} />
            新建项目
          </button>
        </div>
      </div>
      <div className="pjg">
        <div className="pj-grid">
          {state.projects.map((project) => {
            const current = project.id === state.workspaceId;
            return (
              <div
                className={`pjcard${current ? ' cur' : ''}`}
                data-pj={project.name}
                key={project.id}
                onClick={() => {
                  setWorkspace(project.id);
                  void api.switchWorkspace(project.id).then((envelope) => {
                    if (envelope.ok) addToast(`已同步 ${envelope.data.workspaceName} 的侧栏 / 上下文 / 产物`);
                  });
                }}
              >
                <div className="pjname">
                  <span className="sdot" />
                  {project.name}
                  {current ? <span className="atag">当前</span> : null}
                </div>
                <div className="pjdesc">{project.desc}</div>
                <div className="pjbar">
                  <i style={{ width: `${project.index}%` }} />
                </div>
                <div className="pjmeta">
                  <span>{project.assetsLabel}</span>
                  <span>{project.convLabel}</span>
                  <span>{project.owner}</span>
                  <span>{project.recent}</span>
                </div>
              </div>
            );
          })}
          <div className="pjnew" onClick={openNewProject}>
            <PlusIcon size={16} strokeWidth={1.5} className="pjnew-ic" />
            新建项目
          </div>
        </div>
      </div>
    </div>
  );
}
