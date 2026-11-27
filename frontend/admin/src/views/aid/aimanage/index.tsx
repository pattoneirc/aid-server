import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Modal, message } from 'antd';
import { confirmModelPoolRemoval } from '../funcconfig/confirmModelPoolRemoval';
import {
  listProvider, getProvider, addProvider, updateProvider, updateProviderStatus, delProvider,
  listModel, getModel, addModel, updateModel, getModelPoolBindings, bindModelsToPools, unbindModelsFromPools,
  listModelReferences,
  type ModelPoolBindingSnapshot, type ModelPoolCapabilitySelection
} from '@/api/aid/aimanage';
import {
  getModelRetirementImpact,
  retireModel,
  type OrchestrationImpact
} from '@/api/aid/orchestration';
import ProviderPanel from './ProviderPanel';
import ModelTable from './ModelTable';
import { compareProviders } from './providerCategory';
import { isTokenDanceProvider } from './recommendedProvider';
import TokenDanceAccountModal from './TokenDanceAccountModal';
import TokenDanceCatalogModal from './TokenDanceCatalogModal';
import ProviderDialog from './ProviderDialog';
import ModelDialog from './ModelDialog';
import RealModelOverviewDrawer from './RealModelOverviewDrawer';
import ModelPoolBindingModal, { type ModelPoolBindingMode } from './ModelPoolBindingModal';
import RetirementModal from '@/views/aid/orchestration/RetirementModal';
import { ReferenceDetailsModal, showReferenceConflict, type ApiErrorDetails } from '@/utils/apiErrorDetails';
import type { Model, Provider } from './types';
import './style.less';

const EMPTY_POOL_SNAPSHOT: ModelPoolBindingSnapshot = { pools: [], models: [] };

/**
 * AI 管理主页：服务商与模型列表
 *
 * v2.39.x 要点：
 *   （旧版本把穿梭面板定义在函数体内，每次勾选音色都导致面板里搜索框/滚动位置被重置）
 */
export default function AimanagePage() {
  const [providerList, setProviderList] = useState<Provider[]>([]);
  const [providerLoading, setProviderLoading] = useState(true);
  const [activeProvider, setActiveProvider] = useState<Provider | null>(null);
  const [allModels, setAllModels] = useState<Model[]>([]);
  const [poolSnapshot, setPoolSnapshot] = useState<ModelPoolBindingSnapshot>(EMPTY_POOL_SNAPSHOT);
  const [poolSnapshotReady, setPoolSnapshotReady] = useState(false);
  const [selectedModelIds, setSelectedModelIds] = useState<number[]>([]);
  const [poolBindingMode, setPoolBindingMode] = useState<ModelPoolBindingMode | null>(null);
  const [poolBindingSubmitting, setPoolBindingSubmitting] = useState(false);
  const poolBindingSubmitRef = useRef<Promise<void> | null>(null);
  const [tokenDanceAction, setTokenDanceAction] = useState<'account' | 'catalog' | null>(null);
  const tokenDanceProvider = providerList.find(isTokenDanceProvider) || null;
  const providerLoadRef = useRef<Promise<void> | null>(null);
  const [modelQuery, setModelQuery] = useState<any>({ modelType: null, generateMode: null, inputRequirement: null, poolId: null, keyword: '' });
  const [providerDlg, setProviderDlg] = useState<{ open: boolean; title: string; data?: any }>({ open: false, title: '' });
  const [modelDlg, setModelDlg] = useState<{ open: boolean; title: string; data?: any }>({ open: false, title: '' });
  const [retireState, setRetireState] = useState<{
    open: boolean;
    loading: boolean;
    submitting: boolean;
    row?: Model;
    impact?: OrchestrationImpact;
  }>({ open: false, loading: false, submitting: false });
  const [referenceState, setReferenceState] = useState<{
    open: boolean; modelId?: number; modelName?: string; page: number; pageSize: number;
    loading: boolean; details?: ApiErrorDetails;
  }>({ open: false, page: 1, pageSize: 20, loading: false });

  const modelCounts = useMemo(() => {
    const map: Record<number, number> = {};
    allModels.forEach((m) => { map[m.providerId!] = (map[m.providerId!] || 0) + 1; });
    return map;
  }, [allModels]);

  const loadProviderSnapshot = useCallback(async () => {
    setProviderLoading(true);
    try {
      const [res, res2, poolRes]: any[] = await Promise.all([
        listProvider({ pageNum: 1, pageSize: 999 }),
        listModel({ pageNum: 1, pageSize: 9999 }),
        getModelPoolBindings().catch(() => null)
      ]);
      const list: Provider[] = [...(res.rows || [])].sort(compareProviders);
      setProviderList(list);
      setAllModels(res2.rows || []);
      if (poolRes?.data) {
        setPoolSnapshot(poolRes.data);
        setPoolSnapshotReady(true);
      } else {
        setPoolSnapshotReady(false);
      }
      setActiveProvider((current) => list.find((provider) => provider.id === current?.id)
        || list.find((provider) => provider.status === '0') || list[0] || null);
    } finally { setProviderLoading(false); }
  }, []);

  const loadProviders = useCallback((): Promise<void> => {
    if (providerLoadRef.current) return providerLoadRef.current;
    const pending = loadProviderSnapshot();
    providerLoadRef.current = pending;
    void pending.finally(() => {
      if (providerLoadRef.current === pending) providerLoadRef.current = null;
    }).catch(() => undefined);
    return pending;
  }, [loadProviderSnapshot]);

  // 写操作完成后的刷新必须晚于旧快照请求；并发刷新仍合并到同一个新请求。
  const refreshProviders = async () => {
    const pending = providerLoadRef.current;
    if (pending) await pending.catch(() => undefined);
    await loadProviders();
  };

  const modelList = useMemo(() => {
      let rows = allModels.filter((model) => model.providerId === activeProvider?.id);
      if (modelQuery.modelType) rows = rows.filter((m) => m.modelType === modelQuery.modelType);
      if (modelQuery.generateMode) rows = rows.filter((m) => m.generateMode === modelQuery.generateMode);
      // 输入要求（后端推导标签）：区分纯文本/图片可选/图片必传/视频必传
      if (modelQuery.inputRequirement) rows = rows.filter((m) => m.inputRequirement === modelQuery.inputRequirement);
      if (modelQuery.poolId != null) {
        const membership = new Map(poolSnapshot.models.map((model) => [model.id, model.poolIds]));
        rows = rows.filter((model) => {
          const poolIds = membership.get(model.id!) || [];
          return modelQuery.poolId === 'unbound' ? poolIds.length === 0 : poolIds.includes(Number(modelQuery.poolId));
        });
      }
      if (modelQuery.keyword) {
        const kw = modelQuery.keyword.toLowerCase();
        rows = rows.filter((m) => (m.modelCode || '').toLowerCase().includes(kw) || (m.realModelCode || '').toLowerCase().includes(kw) || (m.modelName || '').toLowerCase().includes(kw));
      }
      return rows;
  }, [allModels, activeProvider?.id, modelQuery, poolSnapshot.models]);

  const selectedModels = useMemo(
    () => allModels.filter((model) => model.id != null && selectedModelIds.includes(model.id)),
    [allModels, selectedModelIds]
  );

  useEffect(() => { void loadProviders().catch(() => undefined); }, [loadProviders]);

  useEffect(() => {
    const existingIds = new Set(allModels.map((model) => model.id).filter((id): id is number => id != null));
    setSelectedModelIds((ids) => ids.filter((id) => existingIds.has(id)));
  }, [allModels]);

  useEffect(() => {
    setSelectedModelIds([]);
  }, [activeProvider?.id]);

  useEffect(() => {
    const visibleIds = new Set(modelList.map((model) => model.id).filter((id): id is number => id != null));
    setSelectedModelIds((ids) => {
      const next = ids.filter((id) => visibleIds.has(id));
      return next.length === ids.length ? ids : next;
    });
  }, [modelList]);

  const handleAddProvider = () => setProviderDlg({ open: true, title: '新增服务商', data: { status: '0' } });
  const handleEditProvider = async () => {
    if (!activeProvider) return;
    const res: any = await getProvider(activeProvider.id);
    setProviderDlg({ open: true, title: '编辑服务商', data: res.data });
  };
  const handleDeleteProvider = () => {
    if (!activeProvider) return;
    Modal.confirm({
      title: '确认删除',
      content: `是否确认删除服务商【${activeProvider.providerName}】？`,
      okType: 'danger',
      onOk: async () => {
        await delProvider(activeProvider.id);
        message.success('删除成功');
        setActiveProvider(null);
        await refreshProviders();
      }
    });
  };
  const handleProviderSubmit = async (values: any) => {
    if (values.id) { await updateProvider(values); message.success('修改成功'); }
    else { await addProvider(values); message.success('新增成功'); }
    setProviderDlg({ open: false, title: '' });
    await refreshProviders();
  };

  /** 行内开关直接启停服务商：只提交 id + status，其余字段不动 */
  const handleToggleProviderStatus = async (p: Provider, enabled: boolean) => {
    const status = enabled ? '0' : '1';
    await updateProviderStatus({ id: p.id, status });
    message.success(enabled ? `已启用【${p.providerName}】` : `已停用【${p.providerName}】`);
    // 本地同步列表与选中项状态，避免整页刷新造成闪烁
    setProviderList((prev) => prev.map((it) => (it.id === p.id ? { ...it, status } : it)));
    if (activeProvider?.id === p.id) setActiveProvider({ ...activeProvider, status });
  };

  const handleEditModel = async (row: Model) => {
    const res: any = await getModel(row.id);
    setModelDlg({ open: true, title: '编辑模型', data: res.data });
  };
  const handleAddModel = () => {
    setModelDlg({ open: true, title: '新增模型', data: { providerId: activeProvider?.id, status: '0', billingMode: 'FIXED', priority: 1, billingMultiplier: 1, isFree: false } });
  };
  /** 行内开关直接启停模型：modelCode 用于通过后端更新校验 */
  const handleToggleModelStatus = async (row: Model, enabled: boolean) => {
    if (row.id == null) return;
    try {
      const status = enabled ? '0' : '1';
      let current = row;
      if (current.configVersion == null) {
        const currentResponse: any = await getModel(row.id);
        current = currentResponse.data;
      }
      await updateModel({ id: row.id, modelCode: current.modelCode,
        status, configVersion: current.configVersion }, true);
      const refreshedResponse: any = await getModel(row.id);
      const refreshed: Model = refreshedResponse.data;
      message.success(enabled ? `已启用【${row.modelName}】` : `已停用【${row.modelName}】`);
      // 权威回读包含服务端递增后的 configVersion，后续更新不得复用旧版本。
      setAllModels((prev) => prev.map((item) => (item.id === row.id ? { ...item, ...refreshed } : item)));
    } catch (cause: any) {
      if (!showReferenceConflict(cause, '模型仍有有效引用')) message.error(cause?.message || '模型状态更新失败');
    }
  };
  const handleDeleteModel = async (row: Model) => {
    if (row.id == null) return;
    try {
      const references = await listModelReferences({ modelIds: [row.id], page: 1, pageSize: 20 });
      if ((references.data?.totalReferences || 0) > 0) {
        setReferenceState({ open: true, modelId: row.id, modelName: row.modelName,
          page: 1, pageSize: 20, loading: false, details: references.data });
        return;
      }
    } catch (cause: any) {
      message.error(cause?.message || '模型引用查询失败');
      return;
    }
    setRetireState({ open: true, loading: true, submitting: false, row });
    try {
      const res: any = await getModelRetirementImpact(row.id);
      setRetireState({ open: true, loading: false, submitting: false, row, impact: res.data });
    } catch {
      setRetireState({ open: false, loading: false, submitting: false });
    }
  };

  const loadReferencePage = async (page: number, pageSize: number) => {
    if (!referenceState.modelId) return;
    setReferenceState((state) => ({ ...state, page, pageSize, loading: true }));
    try {
      const response = await listModelReferences({ modelIds: [referenceState.modelId], page, pageSize });
      setReferenceState((state) => ({ ...state, details: response.data, loading: false }));
    } catch (cause: any) {
      message.error(cause?.message || '引用明细加载失败');
      setReferenceState((state) => ({ ...state, loading: false }));
    }
  };

  const handleOpenPoolBinding = (mode: ModelPoolBindingMode) => {
    if (selectedModels.length === 0) {
      message.warning('请先选择模型');
      return;
    }
    if (mode === 'bind' && new Set(selectedModels.map((model) => model.modelType)).size > 1) {
      message.warning('请先选择同类模型');
      return;
    }
    setPoolBindingMode(mode);
  };

  const handlePoolBindingSubmit = (poolIds: number[], capabilitySelections: ModelPoolCapabilitySelection[]) => {
    if (!poolBindingMode || poolBindingSubmitRef.current) return poolBindingSubmitRef.current || Promise.resolve();
    const operation = poolBindingMode;
    const task = (async () => {
      setPoolBindingSubmitting(true);
      try {
        const pendingLoad = providerLoadRef.current;
        if (pendingLoad) await pendingLoad;
        const replacements = operation === 'unbind' ? await confirmModelPoolRemoval(selectedModelIds, poolIds) : {};
        if (!replacements) return;
        const response: any = operation === 'bind'
          ? await bindModelsToPools(selectedModelIds, poolIds, capabilitySelections)
          : await unbindModelsFromPools(selectedModelIds, poolIds, replacements);
        const result = response.data;
        if (result?.snapshot) setPoolSnapshot(result.snapshot);
        message.success(result?.changedRelationCount > 0
          ? `已${operation === 'bind' ? '绑定' : '移出'} ${result.changedRelationCount} 个关系`
          : '当前关系无需变更');
        setPoolBindingMode(null);
        setSelectedModelIds([]);
      } finally {
        setPoolBindingSubmitting(false);
      }
    })();
    poolBindingSubmitRef.current = task;
    void task.finally(() => {
      if (poolBindingSubmitRef.current === task) poolBindingSubmitRef.current = null;
    }).catch(() => undefined);
    return task;
  };

  const confirmRetireModel = async () => {
    if (retireState.row?.id == null) return;
    setRetireState((state) => ({ ...state, submitting: true }));
    try {
      await retireModel(retireState.row.id);
      message.success('模型已下线');
      setRetireState({ open: false, loading: false, submitting: false });
      await refreshProviders();
    } catch (cause: any) {
      if (!showReferenceConflict(cause, '模型仍有有效引用')) message.error(cause?.message || '模型下线失败');
    } finally {
      setRetireState((state) => state.open ? { ...state, submitting: false } : state);
    }
  };

  // ==================== 真实模型总览 ====================
  const [overviewOpen, setOverviewOpen] = useState(false);

  return (
    <>
      <TokenDanceAccountModal open={tokenDanceAction === 'account'} provider={tokenDanceProvider} onClose={() => setTokenDanceAction(null)} />
      <TokenDanceCatalogModal open={tokenDanceAction === 'catalog'} provider={tokenDanceProvider} onClose={() => setTokenDanceAction(null)} onImported={refreshProviders} />
      <div className="aimanage">
      <ProviderPanel
        list={providerList}
        loading={providerLoading}
        active={activeProvider}
        modelCounts={modelCounts}
        onSelect={(p) => { setActiveProvider(p); setModelQuery({ modelType: null, generateMode: null, inputRequirement: null, poolId: null, keyword: '' }); setSelectedModelIds([]); }}
        onAdd={handleAddProvider}
        onEdit={handleEditProvider}
        onDelete={handleDeleteProvider}
        onToggleStatus={handleToggleProviderStatus}
        onTokenDanceAction={setTokenDanceAction}
        onProviderChanged={() => { void loadProviders().catch(() => undefined); }}
      />
      <ModelTable
        provider={activeProvider}
        list={modelList}
        loading={providerLoading}
        query={modelQuery}
        onQueryChange={setModelQuery}
        onAdd={handleAddModel}
        onEdit={handleEditModel}
        onDelete={handleDeleteModel}
        onToggleStatus={handleToggleModelStatus}
        onOpenOverview={() => setOverviewOpen(true)}
        poolSnapshot={poolSnapshot}
        poolSnapshotReady={poolSnapshotReady}
        selectedModelIds={selectedModelIds}
        onSelectionChange={setSelectedModelIds}
        onOpenPoolBinding={handleOpenPoolBinding}
      />
      <ModelPoolBindingModal
        open={poolBindingMode != null}
        mode={poolBindingMode || 'bind'}
        models={selectedModels}
        snapshot={poolSnapshot}
        submitting={poolBindingSubmitting}
        onCancel={() => setPoolBindingMode(null)}
        onSubmit={(poolIds, capabilitySelections) => { void handlePoolBindingSubmit(poolIds, capabilitySelections); }}
      />
      <ProviderDialog
        open={providerDlg.open}
        title={providerDlg.title}
        data={providerDlg.data}
        onCancel={() => setProviderDlg({ open: false, title: '' })}
        onOk={handleProviderSubmit}
      />
      <ModelDialog
        open={modelDlg.open}
        title={modelDlg.title}
        provider={activeProvider}
        data={modelDlg.data}
        onCancel={() => setModelDlg({ open: false, title: '' })}
        onOk={async (values) => {
          try {
            if (values.id) { await updateModel(values, true); message.success('修改成功'); }
            else { await addModel(values); message.success('新增成功'); }
            setModelDlg({ open: false, title: '' });
            await refreshProviders();
          } catch (cause: any) {
            if (!showReferenceConflict(cause, '模型能力仍有有效引用'))
              message.error(cause?.message || '模型保存失败');
          }
        }}
      />
      <RetirementModal
        open={retireState.open}
        loading={retireState.loading}
        submitting={retireState.submitting}
        impact={retireState.impact}
        onCancel={() => setRetireState({ open: false, loading: false, submitting: false })}
        onConfirm={confirmRetireModel}
      />
      <ReferenceDetailsModal open={referenceState.open}
        title={`${referenceState.modelName || '模型'} · 有效引用`}
        details={referenceState.details} loading={referenceState.loading}
        page={referenceState.page} pageSize={referenceState.pageSize}
        onPage={loadReferencePage}
        onClose={() => setReferenceState({ open: false, page: 1, pageSize: 20, loading: false })} />
      <RealModelOverviewDrawer
        open={overviewOpen}
        onClose={() => setOverviewOpen(false)}
        onStatusChanged={() => { void refreshProviders().catch(() => undefined); }}
      />
      </div>
    </>
  );
}
