'use client'

import { ASSISTANT_HISTORY_MORE_KEY, studioAssistantHistoryItems } from '@/components/studio/canvas/studioAssistantHistoryMenu'

import { StudioIconGlyph } from '@/components/studio/theme/StudioIconGlyph'

import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import { Button, message } from 'antd'
import { ArrowLeftOutlined, CloseOutlined, SettingOutlined } from '@ant-design/icons'
import { StudioCanvasAssistantSettingsDialog } from './StudioCanvasAssistantSettings'
import { StudioCanvasConversationPanel } from './StudioCanvasConversationPanel'
import { canvasConversationList } from '@/utils/business/canvasConversation'
import AgentConversationPanel from '@/components/common/agent-conversation/AgentConversationPanel'
import { AssistantConfirmationSection } from '@/components/assistant/AssistantConfirmationSection'
import { StudioCanvasDropdownPopover } from '@/components/studio/canvas/StudioCanvasDropdownMenu'
import { getStudioComposerPopupContainer } from '@/utils/studio/studioComposerPopupContainer'
import { useAssistantSkillDirectory } from '@/hooks/studio/useAssistantSkillDirectory'
import { StudioCanvasAssistantComposerTools } from './StudioCanvasAssistantComposerTools'
import { StudioCanvasAssistantChoices, StudioCanvasAssistantModels } from './StudioCanvasAssistantModels'
import { StudioCanvasAssistantStart } from './StudioCanvasAssistantStart'
import { useCanvasAssistantComposerDraft } from '@/hooks/studio/useCanvasAssistantComposerDraft'
import {
  advanceCanvasHomeAssistantLaunch, clearCanvasHomeAssistantFiles, clearCanvasHomeAssistantLaunch, readCanvasHomeAssistantDraft,
  readCanvasHomeAssistantFiles, readCanvasHomeAssistantLaunch
} from '@/utils/canvas/canvasHomeAssistantDraft'
import './studio-canvas-conversation.css'
import './studio-canvas-assistant.css'
import './studio-canvas-assistant-interaction.css'
import './studio-canvas-assistant-controls.css'
import type { AssistantAdoptionAdapter, AssistantAdoptionReceipt } from '@/types/assistant-artifact'
import { createCanvasAssistantAdoption } from '@/utils/studio/canvasAssistantAdoption'
import { createCanvasAssistantEffectLocator } from '@/utils/studio/canvasAssistantEffects'
import type { AssistantTargetRef } from '@/types/assistant-effects'
import type { AssistantCapabilities, AssistantContextRef, AssistantMode, AssistantModelSelection, AssistantModule, AssistantSessionSnapshot } from '@/types/assistant-api'
import type { CanvasBudget } from '@/types/assistant-budget'
import { readAssistantDurable, removeAssistantDurable, writeAssistantDurable } from '@/utils/assistant/assistantDurableStorage'
import { AssistantSessionPanel } from '@/components/assistant/AssistantSessionPanel'
import { StudioCanvasTooltip } from '@/components/studio/canvas/StudioCanvasTooltip'
import { useCanvasProjectRuntime } from '@/components/studio/free/CanvasProjectRuntimeContext'
import { useCanvasAssistantIdentity } from '@/hooks/studio/useCanvasAssistantIdentity'
import { canvasAssistantTransport } from '@/utils/canvas/canvasAssistantTransport'
import { createAssistantApi } from '@/utils/business/assistant'
import { assistantErrorCode, assistantErrorMessage, assistantErrorState, type AssistantErrorPresentation } from '@/utils/assistant/assistantRequestCoordinator'
import { assistantCapabilitiesForModule } from '@/utils/assistant/assistantModuleCapabilities'
import { restoredAssistantSessionSkill } from '@/utils/assistant/assistantSessionSkillSelection'
import { captureCanvasAssistantContext, canvasAssistantSnapshotSignature, locateCanvasAssistantTarget, prepareCanvasAssistantContextRefresh, resolveCanvasAssistantContext } from '@/utils/studio/canvasAssistantContext'
import { useStudioUiStore } from '@/stores/studioUi'
import type { StudioFreeAgentPanelRenderProps } from './StudioFreeAgentPanel'
import { StudioCanvasAssistantReferences } from './StudioCanvasAssistantReferences'
import { CANVAS_ASSISTANT_REFERENCE_EVENT, appendCanvasAssistantReferenceIds, pruneCanvasAssistantReferenceDrafts, syncCanvasAssistantReferenceDraft, type CanvasAssistantReferenceSelectionDetail } from '@/utils/studio/canvasAssistantReferenceSelection'
import { StudioCanvasAssistantAttachments, type StudioCanvasAssistantAttachmentHandle } from './StudioCanvasAssistantAttachments'
import { StudioCanvasAssistantMessageEditor } from './StudioCanvasAssistantMessageEditor'
import { StudioCanvasAssistantComposerSurface, useCanvasAssistantComposerMotion } from './StudioCanvasAssistantComposerSurface'
import { canvasAssistantSessionFeedback, StudioCanvasAssistantSessionStatus } from './StudioCanvasAssistantSessionStatus'
import { StudioCanvasAssistantConnectionStatus, canvasAssistantConnectionReason } from './StudioCanvasAssistantConnectionStatus'
import { useCanvasAgentCollaborationDemand } from '@/hooks/studio/useCanvasAgentCollaborationDemand'
import { useStudioSkillWorkspace } from '@/components/studio/skills/StudioSkillWorkspaceProvider'
import { StudioSkillAuthoringBridge } from '@/components/studio/skills/StudioSkillAuthoringBridge'
import { SKILL_CREATOR_CODE } from '@/utils/studio/canvasSkillAuthoring'

type ReferenceDraft = { binding: string; sessionId: string; ids: string[]; selectionIds: string[] }

export function StudioCanvasAssistantPanel(props: StudioFreeAgentPanelRenderProps & { onClose: () => void; canvasProjectId?: string | null }) {
  const runtime = useCanvasProjectRuntime()
  useCanvasAgentCollaborationDemand()
  const runtimeRef = useRef(runtime)
  useEffect(() => { runtimeRef.current = runtime }, [runtime])
  const scopeKey = useStudioUiStore((state) => state.scopeKey)
  const nodes = useStudioUiStore((state) => state.nodes)
  const contextIds = useStudioUiStore((state) => state.chatContextNodeIds)
  const dirtyRevision = useStudioUiStore((state) => state.dirtyRevision)
  const identity = useCanvasAssistantIdentity()
  const catalogIdentity = useRef(identity.identity)
  useLayoutEffect(() => { catalogIdentity.current = identity.identity }, [identity.identity])
  const composerMotion = useCanvasAssistantComposerMotion()
  const [historyOpen, setHistoryOpen] = useState(false)
  const [settingsScope, setSettingsScope] = useState<string>()
  const [legacyCatalog, setLegacyCatalog] = useState<{ scopeKey: string; identity: string; items: Array<{ sessionId: string; title: string }> } | null>(null)
  const [legacySelection, setLegacySelection] = useState<{ scopeKey: string; identity: string; sessionId: string } | null>(null)
  const legacySessions = legacyCatalog?.scopeKey === scopeKey && legacyCatalog.identity === identity.identity ? legacyCatalog.items : []
  const legacySessionId = legacySelection?.scopeKey === scopeKey && legacySelection.identity === identity.identity ? legacySelection.sessionId : ''
  const setLegacySessionId = (sessionId: string) => setLegacySelection({ scopeKey, identity: identity.identity, sessionId })
  const [executionPreference, setExecutionPreference] = useState<'MANUAL' | 'AUTO'>('MANUAL')
  const [executionModePending, setExecutionModePending] = useState(false)
  const [executionModeError, setExecutionModeError] = useState('')
  const executionModeRevision = useRef(0)
  const selectExecutionPreference = useCallback((value: 'MANUAL' | 'AUTO') => {
    executionModeRevision.current += 1
    setExecutionPreference(value); setExecutionModePending(false); setExecutionModeError('')
  }, [])
  const executionModeNotice = executionModePending ? '正在核实生成模式，请稍候' : executionModeError
  const [selectedSkillCode, setSelectedSkillCode] = useState('')
  const selectedSkillCodeRef = useRef('')
  const [selectedModels, setSelectedModels] = useState<AssistantModelSelection[]>([])
  const selectedModelsRef = useRef<AssistantModelSelection[]>([])
  const selectModels = useCallback((models: AssistantModelSelection[]) => {
    selectedModelsRef.current = models
    setSelectedModels(models)
  }, [])
  const selectSkillCode = useCallback((code: string) => {
    selectedSkillCodeRef.current = code
    setSelectedSkillCode(code)
  }, [])
  const [skillPickerOpen, setSkillPickerOpen] = useState(false)
  const attachments = useRef<StudioCanvasAssistantAttachmentHandle>(null)
  const [startNewToken, setStartNewToken] = useState(0)
  const latestSnapshot = useRef<AssistantSessionSnapshot | null>(null)
  const [snapshotRunStatus, setSnapshotRunStatus] = useState('')
  const modelSelectionLocked = Boolean(snapshotRunStatus && !['SUCCEEDED', 'COMPLETED', 'FAILED', 'STOPPED', 'CANCELLED'].includes(snapshotRunStatus))
  const canvasSkillCatalog = useAssistantSkillDirectory()
  const skillWorkspace = useStudioSkillWorkspace()
  const skillRevision = skillWorkspace?.revision || 0
  const [homeLaunch] = useState(() => props.canvasProjectId ? readCanvasHomeAssistantLaunch(props.canvasProjectId) : null)
  const [homeSessionId, setHomeSessionId] = useState('')
  const [homeReferenceIds, setHomeReferenceIds] = useState<string[] | null>(null)
  const [homeNotice, setHomeNotice] = useState('')
  const homeBound = useRef(false)
  const [moduleCode, setModule] = useState<AssistantModule>(homeLaunch?.moduleCode || 'UNIVERSAL')
  const [mode, setMode] = useState<AssistantMode>(homeLaunch?.mode || 'CRAFT')
  const referenceBinding = JSON.stringify([scopeKey, identity.identity, moduleCode, mode])
  const { store: composerDraftStore, bindSession: bindComposerDraft } = useCanvasAssistantComposerDraft(referenceBinding)
  const homeDraftStoreRef = useRef(composerDraftStore)
  homeDraftStoreRef.current = composerDraftStore
  const homeDraftProjectId = runtime?.project?.projectId
  useEffect(() => {
    if (!homeDraftProjectId || !identity.actorId || moduleCode !== 'UNIVERSAL' || mode !== 'CRAFT') return
    const prompt = readCanvasHomeAssistantDraft(String(homeDraftProjectId), true)
    if (prompt) homeDraftStoreRef.current.update('', (current) => current || prompt)
  }, [homeDraftProjectId, identity.actorId, referenceBinding, moduleCode, mode])
  const [referenceDrafts, setReferenceDrafts] = useState<Record<string, ReferenceDraft>>(() => ({
    [referenceBinding]: { binding: referenceBinding, sessionId: '', ids: [...contextIds], selectionIds: [...contextIds] }
  }))
  const emptyReferenceDraft = useMemo<ReferenceDraft>(() => ({ binding: referenceBinding, sessionId: '', ids: [], selectionIds: [] }), [referenceBinding])
  const referenceDraft = referenceDrafts[referenceBinding] || emptyReferenceDraft
  const setReferenceDraft = useCallback((value: SetStateAction<ReferenceDraft>) => {
    setReferenceDrafts(current => {
      const previous = current[referenceBinding] || emptyReferenceDraft
      const next = typeof value === 'function' ? value(previous) : value
      return next === previous ? current : { ...current, [referenceBinding]: next }
    })
  }, [referenceBinding, emptyReferenceDraft])
  const resolvedReferenceDrafts = useRef(new WeakMap<AssistantContextRef, ReferenceDraft>())
  const existingNodeIds = useMemo(() => new Set(nodes.map(node => node.id)), [nodes])
  const referenceIds = referenceDraft.binding === referenceBinding ? referenceDraft.ids.filter(id => existingNodeIds.has(id)) : []
  useEffect(() => useStudioUiStore.subscribe((state, previous) => {
    if (state.scopeKey !== scopeKey || previous.scopeKey !== scopeKey || state.nodes === previous.nodes) return
    const present = new Set(state.nodes.map(node => node.id))
    const removed = new Set(previous.nodes.filter(node => !present.has(node.id)).map(node => node.id))
    if (removed.size) setReferenceDrafts(current => pruneCanvasAssistantReferenceDrafts(current, scopeKey, removed))
  }), [scopeKey])
  const addReferences = useCallback((ids: string[]) => {
    const currentSnapshot = latestSnapshot.current
    // Pausing preserves the question; allow local reference drafts for a later explicit context change.
    if (!currentSnapshot || !currentSnapshot.activeRun?.stopRequested && currentSnapshot.inputRequest && ['OPEN', 'DRAFTING'].includes(currentSnapshot.inputRequest.status)) return false
    const sessionId = latestSnapshot.current?.sessionId || ''
    setReferenceDraft(current => {
      const sameSession = current.binding === referenceBinding && current.sessionId === sessionId
      return { binding: referenceBinding, sessionId,
        ids: appendCanvasAssistantReferenceIds(sameSession ? current.ids : [], ids),
        selectionIds: sameSession ? current.selectionIds : [] }
    })
    return true
  }, [referenceBinding, setReferenceDraft])
  useEffect(() => {
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<CanvasAssistantReferenceSelectionDetail>).detail
      if (detail?.scopeKey !== scopeKey || !Array.isArray(detail.nodeIds) || !latestSnapshot.current) return
      const present = new Set(useStudioUiStore.getState().nodes.map(node => node.id))
      const sessionId = latestSnapshot.current.sessionId || ''
      setReferenceDraft(current => {
        const aligned = current.binding === referenceBinding && (current.sessionId === sessionId || !current.sessionId)
          ? { ...current, sessionId: sessionId || current.sessionId }
          : { binding: referenceBinding, sessionId, ids: [], selectionIds: [] }
        return syncCanvasAssistantReferenceDraft(aligned, detail.nodeIds.filter(id => present.has(id)))
      })
    }
    window.addEventListener(CANVAS_ASSISTANT_REFERENCE_EVENT, listener)
    return () => window.removeEventListener(CANVAS_ASSISTANT_REFERENCE_EVENT, listener)
  }, [scopeKey, referenceBinding, setReferenceDraft])
  const [catalog, setCatalog] = useState<{ identity: string; value?: AssistantCapabilities; error?: string; errorPresentation?: AssistantErrorPresentation } | null>(null)
  const [catalogRevision, setCatalogRevision] = useState(0)
  const [projectionSignature, setProjectionSignature] = useState('')
  const appliedSignature = useRef('')
  const refreshInFlight = useRef(false)
  const mounted = useRef(true)
  const [refreshTick, setRefreshTick] = useState(0)
  const [canvasRefreshError, setCanvasRefreshError] = useState<string | null>(null)
  const adoptedTarget = useRef<AssistantAdoptionReceipt | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const refreshWorkspace = runtime?.refreshWorkspace
  const workspaceId = runtime?.project?.workspace.workspaceId
  const budgetKey = workspaceId && identity.actorId ? `canvas-budget:${identity.actorId}:${workspaceId}` : ''
  const [savedBudget, setSavedBudget] = useState<{ key: string; value?: CanvasBudget }>()
  const canvasBudget = savedBudget?.key === budgetKey ? savedBudget?.value : undefined
  useEffect(() => {
    if (!budgetKey) return
    try { setSavedBudget({ key: budgetKey, value: readAssistantDurable<CanvasBudget>(budgetKey) ?? undefined }) }
    catch (error) { void message.error(assistantErrorMessage(error)) }
  }, [budgetKey])
  const saveCanvasBudget = (value?: CanvasBudget) => {
    if (value) writeAssistantDurable(budgetKey, value)
    else removeAssistantDurable(budgetKey)
    setSavedBudget({ key: budgetKey, value })
  }
  const capabilities = catalog?.identity === identity.identity ? catalog.value : undefined
  const reloadCanvasSkills = canvasSkillCatalog.reload
  const reloadSkillCatalog = useCallback(async () => {
    setCatalogRevision((value) => value + 1)
    await reloadCanvasSkills()
  }, [reloadCanvasSkills])
  const reloadSkillsRef = useRef(reloadSkillCatalog)
  useEffect(() => { reloadSkillsRef.current = reloadSkillCatalog }, [reloadSkillCatalog])
  const skillCatalog = { ...canvasSkillCatalog, reload: reloadSkillCatalog }
  useEffect(() => { if (skillRevision) void reloadSkillCatalog() }, [skillRevision, reloadSkillCatalog])
  // A paged directory is not a complete authorization list. The selected code is
  // checked directly by admission; never clear a choice because it is off-page.
  const error = identity.error || (catalog?.identity === identity.identity ? catalog.error : undefined)
  const refreshAuthoringAvailability = useCallback(async () => {
    const expectedIdentity = identity.identity
    const value = await createAssistantApi(canvasAssistantTransport).capabilities(true)
    if (!mounted.current || catalogIdentity.current !== expectedIdentity) throw new Error('画布或登录身份已变化，请重新进入后编制')
    setCatalog({ identity: expectedIdentity, value })
    if (!assistantCapabilitiesForModule(value, 'UNIVERSAL').planningAvailable) return false
    return Boolean(await canvasSkillCatalog.resolveCode(SKILL_CREATOR_CODE))
  }, [identity.identity, canvasSkillCatalog.resolveCode])

  useEffect(() => {
    if (!workspaceId || !identity.actorId) return
    let active = true
    void canvasConversationList(String(workspaceId)).then((list) => { if (active) setLegacyCatalog({ scopeKey, identity: identity.identity, items: list.items }) })
      .catch((cause) => { if (active) void message.error(assistantErrorMessage(cause)) })
    return () => { active = false }
  }, [workspaceId, scopeKey, identity.identity, identity.actorId])

  useEffect(() => {
    if (!identity.actorId || !catalogRevision) return
    let active = true
    void createAssistantApi(canvasAssistantTransport).capabilities(catalogRevision > 0).then((value) => {
      if (active) setCatalog({ identity: identity.identity, value })
    }).catch((cause) => { if (active) setCatalog({ identity: identity.identity, ...assistantErrorState(cause) }) })
    return () => { active = false }
  }, [identity.actorId, identity.identity, catalogRevision])

  const observedSignature = useRef('')
  const observedAuthoring = useRef(new Set<string>())
  const restoreExecutionMode = useCallback((snapshot: AssistantSessionSnapshot) => {
    const version = ++executionModeRevision.current
    const runId = snapshot.activeRun?.runId
    if (!runId) { setExecutionModePending(false); setExecutionModeError(''); setExecutionPreference('MANUAL'); return }
    setExecutionModePending(true); setExecutionModeError('')
    const current = () => mounted.current && version === executionModeRevision.current
      && latestSnapshot.current?.sessionId === snapshot.sessionId && latestSnapshot.current?.activeRun?.runId === runId
    void createAssistantApi(canvasAssistantTransport).budgetDetail(runId).then(budget => {
      if (!current()) return
      if (!['MANUAL', 'AUTO'].includes(budget.mode)) throw new Error('生成模式返回无效')
      setExecutionPreference(budget.mode); setExecutionModePending(false)
    }).catch(cause => {
      if (!current()) return
      // A new run may not have a policy before its first approval; the initial preference is authoritative then.
      if (assistantErrorCode(cause) === 'RUN_BUDGET_NOT_FOUND') {
        setExecutionPreference(snapshot.activeRun?.executionPreference || 'MANUAL'); setExecutionModePending(false); return
      }
      setExecutionModePending(false); setExecutionModeError('生成模式暂时无法核实，请点击模式按钮重新读取')
    })
  }, [])
  const onSnapshot = useCallback((snapshot: AssistantSessionSnapshot) => {
    const previous = latestSnapshot.current
    latestSnapshot.current = snapshot
    if (previous?.sessionId !== snapshot.sessionId) restoreExecutionMode(snapshot)
    setSnapshotRunStatus(snapshot.activeRun?.status || '')
    const restoredSkill = restoredAssistantSessionSkill(previous?.sessionId, snapshot)
    if (restoredSkill !== undefined) selectSkillCode(restoredSkill)
    if (previous?.sessionId !== snapshot.sessionId || previous?.activeRun?.runId !== snapshot.activeRun?.runId) selectModels(snapshot.activeRun?.selectedModels || [])
    const creatorSteps = snapshot.steps?.filter(step => step.toolCode === 'aid.skill.propose-draft' && ['COMPLETED', 'SUCCEEDED'].includes(step.status)
      && !observedAuthoring.current.has(identity.identity + ':' + snapshot.sessionId + ':' + step.stepId)) || []
    if (creatorSteps.length) {
      for (const step of creatorSteps) observedAuthoring.current.add(identity.identity + ':' + snapshot.sessionId + ':' + step.stepId)
      while (observedAuthoring.current.size > 200) observedAuthoring.current.delete(observedAuthoring.current.values().next().value!)
      void reloadSkillsRef.current()
      if (previous?.sessionId === snapshot.sessionId) void message.success('技能编制草稿已保存，可从头像菜单“我的 Skill”继续维护。')
    }
    bindComposerDraft(snapshot.sessionId)
    setReferenceDraft(current => current.binding === referenceBinding && current.sessionId === snapshot.sessionId ? current
      : { binding: referenceBinding, sessionId: snapshot.sessionId,
        ids: current.binding === referenceBinding && !current.sessionId ? current.ids : [],
        selectionIds: current.binding === referenceBinding && !current.sessionId ? current.selectionIds : [] })
    const changes = canvasAssistantSnapshotSignature(snapshot, String(workspaceId))
    if (!changes) return
    const signature = scopeKey + ':' + changes
    if (observedSignature.current === signature) return
    observedSignature.current = signature
    setProjectionSignature(signature)
  }, [workspaceId, scopeKey, referenceBinding, identity.identity, bindComposerDraft, setReferenceDraft, selectSkillCode, selectModels, restoreExecutionMode])

  const restoreHomeComposer = useCallback((snapshot: AssistantSessionSnapshot) => {
    if (!homeLaunch || homeBound.current || moduleCode !== homeLaunch.moduleCode || mode !== homeLaunch.mode
      || readCanvasHomeAssistantLaunch(homeLaunch.projectId)?.id !== homeLaunch.id) return
    homeBound.current = true
    if (snapshot.activeRun || snapshot.messages.length) {
      clearCanvasHomeAssistantLaunch(homeLaunch)
      void clearCanvasHomeAssistantFiles(homeLaunch).catch(() => {})
      return
    }
    homeDraftStoreRef.current.update(snapshot.sessionId, current => current || homeLaunch.prompt)
    selectExecutionPreference(homeLaunch.executionPreference)
    selectSkillCode(homeLaunch.selectedSkillCode)
    selectModels(homeLaunch.selectedModels)
    setHomeSessionId(snapshot.sessionId)
    if (homeLaunch.phase !== 'pending') setHomeNotice('已恢复首页需求，请核对已导入素材及会话状态后发送。')
  }, [homeLaunch, moduleCode, mode, selectExecutionPreference, selectSkillCode, selectModels])

  const prepareHomeLaunch = useEffectEvent(async () => {
    if (!homeLaunch || homeLaunch.phase !== 'pending' || !homeSessionId || !capabilities || !runtime?.canMutate
      || !attachments.current || latestSnapshot.current?.sessionId !== homeSessionId) return
    const isCurrent = () => mounted.current && useStudioUiStore.getState().scopeKey === scopeKey
      && canvasAssistantTransport.identityKey() === identity.identity && latestSnapshot.current?.sessionId === homeSessionId
      && readCanvasHomeAssistantLaunch(homeLaunch.projectId)?.id === homeLaunch.id
    try {
      if (!advanceCanvasHomeAssistantLaunch(homeLaunch, 'preparing')) return
      if ((homeLaunch.selectedModels.length && !capabilities.modelSelectionOnDemand)
        || (homeLaunch.attachmentCount && !capabilities.contextKinds.includes('FREE_CANVAS'))) {
        throw new Error('当前助手暂不支持首页选择的模型或素材，请核对后发送')
      }
      if (homeLaunch.attachmentCount) setHomeNotice('正在导入首页素材…')
      const files = await readCanvasHomeAssistantFiles(homeLaunch)
      if (!isCurrent()) return
      const imported = files.length ? await attachments.current?.add(files) : []
      if (!isCurrent()) return
      if (!imported || imported.length !== homeLaunch.attachmentCount) throw new Error('首页素材未全部保存，请核对画布上的素材后发送')
      setHomeReferenceIds(imported)
      setHomeNotice('')
    } catch (cause) {
      if (isCurrent()) setHomeNotice(assistantErrorMessage(cause))
    }
  })
  const homeRuntimeReady = Boolean(runtime?.canMutate && capabilities && homeSessionId === referenceDraft.sessionId)
  useEffect(() => {
    if (homeRuntimeReady) void prepareHomeLaunch()
  }, [homeRuntimeReady, homeSessionId])

  useEffect(() => {
    if (!refreshWorkspace || !projectionSignature || projectionSignature === appliedSignature.current || dirtyRevision > 0 || refreshInFlight.current) return
    if (!projectionSignature.startsWith(scopeKey + ':')) return
    refreshInFlight.current = true
    appliedSignature.current = projectionSignature
    // Existing runtime rechecks dirtyRevision after I/O and defers hydration of edited nodes.
    void refreshWorkspace().catch((cause) => {
      if (mounted.current && useStudioUiStore.getState().scopeKey === scopeKey) setCanvasRefreshError(assistantErrorMessage(cause))
    }).finally(() => {
      refreshInFlight.current = false
      if (mounted.current) setRefreshTick((value) => value + 1)
    })
  }, [refreshWorkspace, projectionSignature, scopeKey, dirtyRevision, refreshTick])

  const onAdoptionReceipt = useCallback((receipt: AssistantAdoptionReceipt) => {
    if (!mounted.current || useStudioUiStore.getState().scopeKey !== scopeKey) return
    adoptedTarget.current = receipt
    setCanvasRefreshError(null)
    setProjectionSignature(scopeKey + ':adoption:' + receipt.adoptionId)
  }, [scopeKey])
  const getRuntime = useCallback(() => runtimeRef.current, [])
  const effectLocator = useRef<ReturnType<typeof createCanvasAssistantEffectLocator> | null>(null)
  useEffect(() => {
    const authIdentity = canvasAssistantTransport.identityKey()
    effectLocator.current = createCanvasAssistantEffectLocator(getRuntime, scopeKey, () => mounted.current && canvasAssistantTransport.identityKey() === authIdentity)
    return () => { effectLocator.current = null }
  }, [getRuntime, scopeKey, identity.identity])
  const locateEffectTarget = useCallback((ref: AssistantTargetRef, isCurrent: () => boolean) => {
    if (!effectLocator.current) return Promise.reject(new Error('画布定位尚未就绪'))
    return effectLocator.current(ref, isCurrent)
  }, [])
  const adoptionAdapter = useMemo<AssistantAdoptionAdapter>(() => ({
    supports: (target) => createCanvasAssistantAdoption(getRuntime, scopeKey, onAdoptionReceipt).supports(target),
    capabilityContext: () => createCanvasAssistantAdoption(getRuntime, scopeKey, onAdoptionReceipt).capabilityContext!(),
    prepare: (target) => createCanvasAssistantAdoption(getRuntime, scopeKey, onAdoptionReceipt).prepare(target),
    applied: (receipt, command) => createCanvasAssistantAdoption(getRuntime, scopeKey, onAdoptionReceipt).applied(receipt, command)
  }), [getRuntime, scopeKey, onAdoptionReceipt])
  useEffect(() => {
    const receipt = adoptedTarget.current
    if (!receipt || dirtyRevision > 0 || refreshInFlight.current || canvasRefreshError || projectionSignature !== appliedSignature.current) return
    const current = runtimeRef.current
    if (!current || useStudioUiStore.getState().scopeKey !== scopeKey) return
    try {
      locateCanvasAssistantTarget(current, scopeKey, { kind: 'FREE_CANVAS', workspaceId: String(receipt.receipt.workspaceId), objectId: receipt.targetObjectId, objectVersion: Number(receipt.targetRevision) })
      adoptedTarget.current = null
    } catch (cause) { void message.error(assistantErrorMessage(cause)) }
  }, [dirtyRevision, scopeKey, refreshTick, canvasRefreshError, projectionSignature])

  const onCapabilities = useCallback((value: AssistantCapabilities) => setCatalog({ identity: identity.identity, value }), [identity.identity])
  const disabledReason = runtime && !runtime.canEdit ? '当前账号没有画布编辑权限' : capabilities && (!capabilities.freeCanvasAvailable || !capabilities.modules.includes(moduleCode)) ? '当前画布服务尚未开放此助手' : undefined
  const sessionEnabled = Boolean(identity.actorId && workspaceId && (!homeLaunch || String(homeDraftProjectId) === homeLaunch.projectId))
  const initializationError = error || (!workspaceId ? '请先打开已保存的项目画布' : undefined)
  const homeImportNotice = homeSessionId === referenceDraft.sessionId && homeNotice === '正在导入首页素材…' ? homeNotice : ''
  if (legacySessionId) return <StudioCanvasConversationPanel {...props} initialSessionId={legacySessionId}
    onStartNew={() => { setLegacySessionId(''); setStartNewToken((value) => value + 1) }}
    headerActions={<><StudioCanvasTooltip title="返回当前对话"><button type="button" aria-label="返回当前对话" onClick={() => { setStartNewToken(0); setLegacySessionId('') }}><ArrowLeftOutlined /></button></StudioCanvasTooltip>{props.headerActions}</>} />
  return <div className="flex h-full min-h-0 min-w-0 flex-col text-[var(--studio-text)]">
    <div className="min-h-0 flex-1 overflow-hidden">
      <AssistantSessionPanel presentation="canvas"
        key={scopeKey + ':' + identity.identity + ':' + moduleCode + ':' + mode}
        scope={{ moduleCode, mode: moduleCode === 'SCREENWRITER' ? mode : undefined, workspaceId: workspaceId ? String(workspaceId) : '' }}
        initialization={{ enabled: sessionEnabled, onCapabilities }}
        actorId={identity.actorId} transport={canvasAssistantTransport} adoptionAdapter={adoptionAdapter} disabledReason={disabledReason} messageDisabledReason={!runtime?.canMutate ? canvasAssistantConnectionReason(runtime?.collaborationStatus || 'idle', runtime?.collaborationError) : executionModeNotice || homeImportNotice || undefined}
        renderMessageDisabledReason={reason => reason === executionModeNotice ? <p role="status" className="assistant-inline-loading">{reason}</p> : reason === homeImportNotice || runtime?.canEdit === false ? null : <StudioCanvasAssistantConnectionStatus status={runtime?.collaborationStatus || 'idle'} error={runtime?.collaborationError} recovering={runtime?.collaborationRecoverable} />} onSnapshot={onSnapshot}
        startNewToken={startNewToken} executionPreference={executionPreference} onExecutionPreferenceChange={selectExecutionPreference} selectedSkillCode={selectedSkillCode} canvasBudget={canvasBudget}
        captureSelectedSkillCode={() => selectedSkillCodeRef.current}
        captureSelectedModels={() => selectedModelsRef.current}
        composerDraftStore={composerDraftStore}
        onComposerSessionReady={homeLaunch ? restoreHomeComposer : undefined}
        initialSubmission={homeLaunch && homeReferenceIds && homeSessionId === referenceDraft.sessionId
          && moduleCode === homeLaunch.moduleCode && mode === homeLaunch.mode
          && selectedSkillCode === homeLaunch.selectedSkillCode && selectedModels === homeLaunch.selectedModels
          && executionPreference === homeLaunch.executionPreference
          && referenceIds.length === homeReferenceIds.length && homeReferenceIds.every(id => referenceIds.includes(id))
          ? { id: homeLaunch.id, sessionId: homeSessionId, content: homeLaunch.prompt,
            claim: () => advanceCanvasHomeAssistantLaunch({ ...homeLaunch, phase: 'preparing' }, 'submitted'),
            onAccepted: () => clearCanvasHomeAssistantLaunch(homeLaunch) } : undefined}
        attachmentTools={({ disabled, openDocuments }) => <StudioCanvasAssistantAttachments ref={attachments} key={referenceDraft.sessionId} disabled={disabled} onReferencesAdded={addReferences} onOpenDocuments={capabilities?.contextKinds.includes('DOCUMENT') ? openDocuments : undefined} />}
        composerTools={({ disabled, skillLocked, selectedSkillCode: activeSkillCode, prepareSwitch, changeExecutionPreference }) => <StudioCanvasAssistantComposerTools disabled={disabled} skillLocked={skillLocked} moduleCode={moduleCode} mode={mode} executionPreference={executionPreference} onExecutionChange={(value) => { void changeExecutionPreference(value) }}
          selectedSkillCode={activeSkillCode} onSkillChange={selectSkillCode} skillCatalog={skillCatalog} defaultModelCode={capabilities?.planningModelCode || ''}
          modePending={executionModePending} modeError={executionModeError} onModeRetry={() => { if (latestSnapshot.current) restoreExecutionMode(latestSnapshot.current) }}
          modelControl={moduleCode === 'UNIVERSAL' && capabilities?.modelSelectionOnDemand ? <StudioCanvasAssistantModels selected={selectedModels} disabled={disabled || modelSelectionLocked} onChange={selectModels} /> : null}
          skillPickerOpen={skillPickerOpen} onSkillPickerOpenChange={setSkillPickerOpen}
          onModuleChange={async (nextModule, nextMode) => {
            if (nextModule === moduleCode && (nextModule === 'UNIVERSAL' || nextMode === mode)) return
            if (!await prepareSwitch()) { void message.error('问题草稿尚未保存，请先处理再切换助手'); return }
            // Each mode owns its history and draft; only the new-conversation action starts fresh.
            setStartNewToken(0)
            latestSnapshot.current = null
            setSkillPickerOpen(false)
            selectSkillCode(''); selectModels([]); setModule(nextModule); setMode(nextMode)
          }} />}
        renderShell={(view) => {
          const settingsKey = JSON.stringify([scopeKey, identity.identity, view.snapshot?.sessionId])
          const settingsOpen = settingsScope === settingsKey
          const openSettings = () => setSettingsScope(settingsKey)
          const sessionFeedback = canvasAssistantSessionFeedback({
            initializationError, requestError: view.error, requestPresentation: view.errorPresentation,
            disabledReason, catalogPresentation: catalog?.errorPresentation, identityFailed: Boolean(identity.error), workspaceReady: Boolean(workspaceId)
          })
          return <><AgentConversationPanel className="canvas-agent-panel canvas-assistant-panel" title={view.displaySnapshot?.title || view.snapshot?.title || '新对话'}
          showBrandOrb={false} followContentResize headerProps={props.headerProps} updateToken={(view.displaySnapshot?.sessionId || view.snapshot?.sessionId || 'new') + ':' + view.updateToken}
          scopeKey={view.displaySnapshot?.sessionId || view.snapshot?.sessionId || 'new'} initialLoading={view.loading && !view.hasConversation}
          contextSlot={<><StudioCanvasAssistantSessionStatus pending={!sessionFeedback.toast && !initializationError && !disabledReason && !view.hasConversation && (!sessionEnabled || view.loading || !view.snapshot)}
            error={sessionFeedback.error} errorPresentation={sessionFeedback.presentation} toast={sessionFeedback.toast} onRetry={!workspaceId || disabledReason ? undefined : identity.error ? identity.retry : view.retry} />
            <StudioSkillAuthoringBridge moduleCode={moduleCode} ready={Boolean(view.snapshot && capabilities && !view.loading && !view.composerDisabled && !disabledReason)} locked={Boolean(view.snapshot?.activeRun && !['COMPLETED', 'SUCCEEDED', 'FAILED', 'STOPPED', 'CANCELLED'].includes(view.snapshot.activeRun.status))}
              currentText={composerDraftStore.read(view.snapshot?.sessionId || '')}
              sessionId={view.snapshot?.sessionId || ''} checkAvailability={refreshAuthoringAvailability} prepareSwitch={view.prepareSwitch}
              onUniversal={() => { setModule('UNIVERSAL'); setStartNewToken(0); latestSnapshot.current = null; selectSkillCode('') }} onSelect={selectSkillCode} insertPrompt={view.insertComposerPrompt} />
          </>}
          headerActions={<div className="canvas-agent-header">
            <StudioCanvasTooltip title="新对话"><button type="button" aria-label="新对话" disabled={view.picker.disabled} onClick={view.newSession}><StudioIconGlyph name="newChat" /></button></StudioCanvasTooltip>
            <StudioCanvasDropdownPopover items={studioAssistantHistoryItems(view.picker, <StudioIconGlyph name="history" />, legacySessions.map((item) => ({ key: 'legacy:' + item.sessionId, label: item.title, icon: <StudioIconGlyph name="history" /> })))} activeKey={view.picker.value}
              onSelect={async (key) => { if (key === ASSISTANT_HISTORY_MORE_KEY) { view.picker.onLoadMore?.(); return } if (key.startsWith('legacy:')) { if (await view.prepareSwitch()) setLegacySessionId(key.slice(7)); else void message.error('问题草稿尚未保存，请先处理再切换会话') } else view.picker.onChange(key) }} open={historyOpen} onOpenChange={setHistoryOpen} placement="bottomRight" ariaLabel="历史对话" getPopupContainer={getStudioComposerPopupContainer}
              trigger={<StudioCanvasTooltip open={historyOpen ? false : undefined} title="历史对话"><button type="button" aria-label="历史对话" disabled={view.picker.disabled || (!view.picker.options.length && !view.picker.hasMore && !legacySessions.length)} aria-haspopup="menu" aria-expanded={historyOpen}><StudioIconGlyph name="history" /></button></StudioCanvasTooltip>} />
            <StudioCanvasTooltip title="助手设置"><button type="button" aria-label="助手设置" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={openSettings}><SettingOutlined /></button></StudioCanvasTooltip>
            {props.headerActions}<StudioCanvasTooltip title="关闭对话"><button type="button" aria-label="关闭对话" onClick={props.onClose}><CloseOutlined /></button></StudioCanvasTooltip>
          </div>}
          emptySlot={!view.hasConversation && !view.loading ? <StudioCanvasAssistantStart moduleCode={moduleCode} mode={mode}
            onPrompt={view.insertComposerPrompt} onSkill={() => setSkillPickerOpen(true)}
            onUpload={() => moduleCode === 'SCREENWRITER' && mode === 'ADAPT' ? attachments.current?.openDocuments() : attachments.current?.openLocal()} onLibrary={() => attachments.current?.openLibrary()}
            disabledReason={view.composerDisabled ? disabledReason || '正在同步会话，请稍候' : undefined}
            attachmentDisabledReason={!runtime?.canMutate || !view.snapshot ? '画布尚未就绪，请连接后添加素材' : undefined}
            skillDisabledReason={!capabilities ? '助手能力尚未加载' : undefined} /> : null}
          composer={<StudioCanvasAssistantComposerSurface awakening={composerMotion.awakening}>{view.composer}</StudioCanvasAssistantComposerSurface>}>
            {view.thread}
            {view.snapshot?.activeRun?.pauseReason === 'BUDGET_EXCEEDED' ? <div className="canvas-assistant-feedback" role="status">
              <p>生成额度、期限或授权范围需要调整。</p>
              <Button type="link" onClick={openSettings}>调整生成预算</Button>
            </div> : null}
          </AgentConversationPanel>
          <StudioCanvasAssistantSettingsDialog open={settingsOpen} onClose={() => setSettingsScope(undefined)}
            snapshot={view.snapshot} store={view.store} busy={view.mutationBlocked}
            budgetKey={budgetKey} budget={canvasBudget} onSave={saveCanvasBudget} /></>
        }}
        renderDisabledHint={(control, reason) => reason ? <StudioCanvasTooltip title={reason}>{control}</StudioCanvasTooltip> : control}
        prepareExistingContextRefresh={() => runtime ? prepareCanvasAssistantContextRefresh(runtime, scopeKey) : Promise.reject(new Error('画布尚未就绪'))}
        conversational hasDraftReferences={referenceIds.length > 0}
        renderMessageEditor={view => <StudioCanvasAssistantMessageEditor {...view} introDone={composerMotion.introDone} reducedMotion={composerMotion.reducedMotion} moduleCode={moduleCode} mode={mode} nodes={nodes}
          skillCommands={{ items: skillCatalog.items, favorites: skillCatalog.favorites,
            loading: skillCatalog.loading, error: skillCatalog.error, reload: skillCatalog.reload,
            search: skillCatalog.search, hasMore: skillCatalog.hasMore, loadMore: skillCatalog.loadMore, locked: modelSelectionLocked,
            onSelect: code => { setSkillPickerOpen(false); selectSkillCode(code) } }}
          modelCommands={{ enabled: moduleCode === 'UNIVERSAL' && capabilities?.modelSelectionOnDemand === true, locked: modelSelectionLocked,
            onSelect: model => selectModels([...selectedModelsRef.current.filter(item => item.modelType !== model.modelType), model]) }}
          unavailable={node => node.data.flowBinding ? '流程节点不能在此引用' : node.data.canvasTransient || runtime?.isNodeBusy(node.id) ? '节点正在处理，请完成后引用' : undefined}
          onReference={id => {
            const current = useStudioUiStore.getState(), node = current.nodes.find(node => node.id === id)
            if (current.scopeKey !== scopeKey || !node || node.data.flowBinding || node.data.canvasTransient || runtime?.isNodeBusy(id)) return false
            return addReferences([id])
          }} />}
        onReferencesConsumed={(refs) => {
          setReferenceDraft(current => {
            const consumed = new Set(refs.flatMap(ref => ref.kind === 'FREE_CANVAS' && resolvedReferenceDrafts.current.get(ref) === current ? [ref.objectId] : []))
            return !consumed.size || current.binding !== referenceBinding ? current : { ...current, ids: current.ids.filter(id => !consumed.has(id)), selectionIds: current.selectionIds.filter(id => !consumed.has(id)) }
          })
        }}
        onRestoreReferences={(refs, sessionId) => {
          const state = useStudioUiStore.getState()
          if (state.scopeKey !== scopeKey) return
          const ids = refs.filter(ref => ref.status === 'AVAILABLE' && ref.kind === 'FREE_CANVAS' && ref.workspaceId === String(workspaceId)
            && ref.objectId && state.nodes.some(node => node.id === ref.objectId && !node.data.flowBinding && !node.data.canvasTransient)).map(ref => ref.objectId!)
          setReferenceDraft(current => {
            const sameSession = current.binding === referenceBinding && current.sessionId === sessionId
            return { binding: referenceBinding, sessionId,
              ids: appendCanvasAssistantReferenceIds(sameSession ? current.ids : [], ids),
              selectionIds: sameSession ? current.selectionIds : [] }
          })
        }}
        resolveContext={referenceIds.length ? async () => {
          if (!runtime) throw new Error('画布尚未就绪')
          const refs = await resolveCanvasAssistantContext(runtime, scopeKey, [...referenceIds], 'FIXED')
          refs.forEach(ref => resolvedReferenceDrafts.current.set(ref, referenceDraft))
          return refs
        } : undefined}
        captureQueuedContext={referenceIds.length ? () => {
          if (!runtime) throw new Error('画布尚未就绪')
          const refs = captureCanvasAssistantContext(runtime, scopeKey, referenceIds)
          refs.forEach(ref => resolvedReferenceDrafts.current.set(ref, referenceDraft))
          return refs
        } : undefined}
        threadFeedback={<>{homeNotice && homeSessionId === referenceDraft.sessionId ? <p role="status" className="assistant-inline-loading">{homeNotice}</p> : null}
          {canvasRefreshError ? <AssistantConfirmationSection presentation="canvas" label="画布同步未完成" role="alert"
          actions={<Button type="primary" onClick={() => { appliedSignature.current = ''; setCanvasRefreshError(null); setRefreshTick(value => value + 1) }}>重新读取画布</Button>}>
          <p>{canvasRefreshError}</p>
        </AssistantConfirmationSection> : null}</>}
        contextSlot={({ disabled }) => <>
          {moduleCode === 'UNIVERSAL' ? <StudioCanvasAssistantChoices models={selectedModels} disabled={disabled || modelSelectionLocked}
            skill={selectedSkillCode ? { code: selectedSkillCode, name: skillCatalog.items.find(item => item.code === selectedSkillCode)?.name
              || (latestSnapshot.current?.activeRun?.selectedSkillCode === selectedSkillCode ? latestSnapshot.current.messages
                .filter(item => item.role === 'user' && item.runId === latestSnapshot.current?.activeRun?.runId)
                .flatMap(item => item.references || []).find(item => item.kind === 'SKILL')?.label : undefined) || selectedSkillCode } : undefined}
            onRemoveModel={type => selectModels(selectedModels.filter(model => model.modelType !== type))} onRemoveSkill={() => selectSkillCode('')} /> : null}
          <StudioCanvasAssistantReferences ids={referenceIds} nodes={nodes} disabled={disabled} onRemove={id => {
            setReferenceDraft(current => ({ ...current, ids: current.ids.filter(value => value !== id), selectionIds: current.selectionIds.filter(value => value !== id) }))
            const state = useStudioUiStore.getState()
            if (state.scopeKey === scopeKey && state.selectedNodeIds.includes(id)) state.selectNodes(state.selectedNodeIds.filter(value => value !== id))
          }} /></>}
        onLocateTarget={locateEffectTarget}
      />
    </div>
  </div>
}
