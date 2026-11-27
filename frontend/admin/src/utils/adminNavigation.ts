import { adminWorkspaces, workspaceTabPath, type AuthoringAccess, type WorkspaceTab } from './adminWorkspaces.ts';

/** Menu presentation is applied after authorization and never rewrites a registered route. */
const sections = [
  { title: '内容运营与审核', icon: 'eye-open', groups: [
    { title: '案例广场', views: ['aid/audit/index', 'aid/canvasAudit/index', 'aid/publishmanage/index', 'commercial/discovery/index'] },
    { title: '站点内容', views: ['aid/homebanner/index', 'aid/notice/index', 'aid/notification/index', 'aid/faq/index'] },
  ] },
  { title: '任务与监控', icon: 'monitor', groups: [
    { title: '任务排查', views: ['system/mediaTaskAnomaly/index', 'aid/error-handling/index', 'aid/extracttask/index', 'aid/errorlog/index', 'aid/model-request-log/index'] },
    { title: '运行监控', views: ['aid/modelmonitor/index', 'aid/providerbalance/index', 'canvas/session/index', 'monitor/server/index'] },
  ] },
  { title: '用户与财务', icon: 'money', groups: [
    { title: '用户与邀请', views: ['aid/extenduserprofile/index', 'aid/inviterelation/index'] },
    { title: '交易与流水', views: ['aid/payorder/index', 'aid/balancelog/index', 'aid/inviterebate/index'] },
  ] },
  { title: '项目与素材', icon: 'list', groups: [
    { title: '项目', views: ['canvas/project/index', 'comic/workspace/index', 'aid/aidscript/index', 'aid/aidcomicepisode/index', 'aid/storyboard/index', 'aid/pisodeeditor/index', 'aid/genrecord/index', 'aid/scenecp/index', 'aid/rolepropsceneform/index', 'aid/assetuser/index', 'aid/audioasset/index'] },
    { title: '素材', views: ['aid/aidcomicasset/index', 'aid/voicelibrary/index', 'aid/voicetag/index', 'aid/canvasModels/index'] },
  ] },
  { title: '智能体与 Skill', icon: 'robot', groups: [
    { title: '能力管理', views: ['aid/skill/index', 'aid/runtimeAgent/index', 'aid/businessGroup/index'] },
    { title: '运行排查', views: ['aid/assistant/index'] },
    { title: '内容编制', views: ['aid/promptlib/index'] },
  ] },
  { title: '配置中心', icon: 'setting', groups: [
    { title: '模型与计费', views: ['aid/aimanage/index'] },
    { title: '业务接入', views: ['aid/orchestration/index', 'aid/funcconfig/index', 'agent/index', 'aid/genagentpool/index'] },
    { title: '画布与预演台', views: ['aid/compute/index', 'canvas/config/index', 'canvas/entitlement/index'] },
    { title: '站点与运营', views: ['aidconfig/aidconfig/index', 'aid/rechargepackage/index', 'aid/seo/index'] },
    { title: '错误规则', views: ['aid/errorrule/index'] },
    { title: '系统配置', views: ['system/menu/index', 'system/dict/index', 'system/config/index', 'monitor/job/index', 'aidconfig/upgrade/index'] },
  ] },
  { title: '后台权限与审计', icon: 'system', groups: [
    { title: '管理员与会话', views: ['system/organization/index', 'system/user/index', 'system/role/index', 'system/dept/index', 'system/post/index', 'monitor/online/index'] },
    { title: '审计日志', views: ['monitor/operlog/index', 'monitor/logininfor/index', 'canvas/audit/index'] },
  ] },
];

const excluded = new Set(['system/notice/index', 'commercial/skill/index']);

export interface NavigationItem<T> {
  key: string;
  title: string;
  icon?: string;
  view?: string;
  aliases?: string[];
  value?: T;
  children?: NavigationItem<T>[];
}

export function organizeNavigation<T>(
  roots: NavigationItem<T>[],
  authoring: AuthoringAccess = { skill: true, agent: true }
): NavigationItem<T>[] {
  const byView = new Map<string, NavigationItem<T>[]>();
  const mapped = new Set(sections.flatMap(section => section.groups.flatMap(group => group.views)));
  for (const workspace of adminWorkspaces) {
    for (const tab of workspace.tabs) mapped.add(tab.view);
  }
  function visit(item: NavigationItem<T>): NavigationItem<T>[] {
    if (item.view && excluded.has(item.view)) return [];
    if (item.view && mapped.has(item.view)) {
      const entries = byView.get(item.view) ?? [];
      entries.push(item);
      byView.set(item.view, entries);
      return [];
    }
    if (!item.children) return [item];
    const children = item.children.flatMap(visit);
    return children.length ? [{ ...item, children }] : [];
  }
  const custom = roots.flatMap(visit);
  const findTab = (tab: WorkspaceTab) => tab.authoring && !authoring[tab.authoring]
    ? undefined : byView.get(tab.view)?.[0];

  for (const { title, tabs } of adminWorkspaces) {
    const available = tabs.flatMap(tab => {
      const menu = findTab(tab);
      return menu ? [{ tab, menu, key: workspaceTabPath(menu.key, tab) }] : [];
    });
    if (available.length === 0) continue;
    const entry = available.find(({ tab }) => !tab.fallbackOnly) ?? available[0];
    const aliases = available.map(item => item.key);
    const editor = available.find(item => item.tab.authoring);
    if (editor && (editor.tab.authoring === 'skill' || !authoring.skill)) aliases.push(editor.menu.key);
    byView.set(tabs[0].view, [{ ...entry.menu, title, key: entry.key, aliases }]);
    for (const tab of tabs.slice(1)) {
      if (!tab.authoring) byView.delete(tab.view);
    }
  }
  const result: NavigationItem<T>[] = [];
  sections.forEach((section, index) => {
    const key = 'admin-area:' + index;
    const children: NavigationItem<T>[] = [];
    section.groups.forEach((group, position) => {
      const pages = group.views.flatMap(view => byView.get(view) ?? []);
      if (pages.length) children.push({ key: key + '/' + position, title: group.title, children: pages });
    });
    if (children.length) result.push({ key, title: section.title, icon: section.icon, children });
  });
  return result.concat(custom);
}
