'use client'

import { canvasResourceMatchesNodeMedia } from '@/utils/canvas/canvasCurrentResultResource'
import {
  canvasDirectorSceneIds, clearCanvasDirectorCheckpoints, recoverCanvasDirectorScenes
} from '@/utils/canvas/canvasDirectorSceneRecovery'
import { prepareCanvasDirectorSceneWrite } from '@/utils/canvas/canvasDirectorSceneSave'
import { createCanvasResourceAccess } from '@/utils/canvas/canvasPublicationFiles'

import { canvasGenerateAudio, type CanvasAudioRequest } from '@/utils/business/canvas'
import { audioParametersWithPrompt, audioParameterErrors, audioParametersWithFiles } from '@/utils/audioModelContract'

import { message as antdMessage } from 'antd'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getStudioWorkspaceData, useStudioUiStore } from '@/stores/studioUi'
import { useUserStore } from '@/stores/user'
import type {
  CanvasCollaborationState,
  CanvasDraft,
  CanvasEntitlements,
  CanvasImageLayerMergeResult,
  CanvasImageSplitResult,
  CanvasMutation,
  CanvasMediaType,
  CanvasObjectRecord,
  CanvasProjectDetail,
  CanvasProjectRole,
  CanvasResource,
  CanvasSceneAdoption,
  CanvasSceneDocument,
  CanvasTaskProjection,
  CanvasWorkspaceLoad,
  CanvasWorkspaceView
} from '@/types/canvas-api'
import type { StudioComposerRef, StudioLayerSeparationState } from '@/types/studio'
import type { UserModelListItem } from '@/types/business-api'
import {
  canvasCollaborationState,
  canvasCollaborationTicket,
  canvasEntitlementEffective,
  canvasGenerateHistory,
  canvasGenerateVideo,
  canvasGenerateResultSelect,
  canvasGenerateTask,
  canvasImageLayerMerge,
  canvasImageSplit,
  canvasMemberList,
  canvasProjectDetail,
  canvasTextImport,
  canvasTextResultAdopt,
  canvasResourceRegister,
  canvasResourceTransfer,
  canvasResourceUpload,
  canvasWorkspaceActiveTasks,
  canvasWorkspaceCopy,
  canvasWorkspaceDraftDelete,
  canvasWorkspaceDraftList,
  canvasWorkspaceDraftSave,
  canvasWorkspaceMutate,
  canvasWorkspaceUndo,
  canvasWorkspaceViewLoad,
  canvasWorkspaceViewSave
} from '@/utils/business/canvas'
import {
  userGenerationImage,
  userGenerationVideo
} from '@/utils/business/generation'
import { userTaskCancel } from '@/utils/business/task'
import { startCanvasTextGenerationStream } from '@/utils/canvas/canvasTextGenerationStream'
import { canvasOperationId } from '@/utils/canvas/canvasId'
import { canvasRuntimeInvoke } from '@/utils/business/canvasRuntime'
import type { CanvasRuntimeInvokeRequest, CanvasRuntimeRun } from '@/types/canvas-runtime-api'
import type { CanvasTaskHistory } from '@/types/canvas-api'
import type {
  UserGenerationKind,
  UserGenerationTask,
  UserImageGenerationRequest,
  UserTextGenerationRequest,
  UserVideoGenerationRequest
} from '@/types/generation-api'
import {
  applyCanvasDeferredNodePositions,
  hydrateCanvasWorkspace,
  mergeCanvasTaskProjections,
  preserveCanvasDeferredNodePositions,
  preserveCanvasTransientNodes,
  preserveCanvasTaskOwnedObjects,
  serializeCanvasPersonalView,
  serializeCanvasWorkspace,
  stableCanvasJson,
  updateCanvasDeferredNodePositions,
  type CanvasDeferredNodePosition,
  type CanvasSerializedObject
} from '@/utils/canvas/canvasWorkspaceAdapter'
import { canvasProjectCanEdit, canvasProjectCanMutate } from '@/utils/canvas/canvasProjectPermission'
import { createCanvasUploadRegistry } from '@/utils/canvas/canvasUploadRegistry'
import { canvasRetryLedger } from '@/utils/canvas/canvasRetryLedger'
import {
  CanvasPersonalViewSaveConflictError,
  canvasPersonalViewCoordinates,
  saveCanvasPersonalView,
  type CanvasPersonalView
} from '@/utils/canvas/canvasPersonalViewSave'
import { createCanvasSnapshotScheduler } from '@/utils/canvas/canvasSnapshotScheduler'
import { createCanvasSessionGate } from '@/utils/canvas/canvasSessionGate'
import { canvasTaskAwaitingVerification, canvasTaskProgress, canvasVideoFinishEta, canvasTaskState, isCanvasTaskTerminal } from '@/utils/canvas/canvasTaskState'
import {
  isNotifiableStudioGenerationSuccess,
  notifyStudioGenerationComplete,
  requestStudioDesktopNotificationPermission,
  studioGenerationCompleteNotice
} from '@/utils/studio/studioDesktopNotification'
import { updateCanvasNodeRuntime } from '@/utils/canvas/canvasNodeRuntime'
import { createCanvasWorkspaceSaveQueue } from '@/utils/canvas/canvasWorkspaceSaveQueue'
import { createCanvasGenerationTaskTracker } from '@/utils/canvas/canvasGenerationTaskTracker'
import { parseCanvasApiJson } from '@/utils/canvas/parseCanvasApiJson'
import { canvasCollaborationNeedsState } from '@/utils/canvas/canvasCollaborationReconciliation'
import { loadCanvasWorkspaceSnapshot } from '@/utils/canvas/canvasWorkspaceSnapshotLoader'
import { isCurrentCanvasTaskResult, needsCanvasTerminalResult } from '@/utils/canvas/canvasTerminalResult'
import {
  canvasAgentCollaborationResumeDelay,
  canvasCollaborationReconnectDelay,
  canvasCollaborationShouldAutoReconnect,
  canvasCollaborationWebsocketUrl
} from '@/utils/canvas/canvasCollaborationSocket'
import { apiErrorMessage } from '@/utils/apiError'
import { canvasUserModelList, canvasUserModelListByFuncCodes } from '@/utils/business/model'
import { canvasGenerationCapability, canvasOrdinaryVideoModels, canvasVideoCapabilityLabel, resolveCanvasVideoCapability } from '@/utils/studio/canvasGenerationModels'
import { canvasVideoLinkedRefs, canvasVideoNodeLinks } from '@/utils/studio/canvasVideoLinkedNodes'
import { isCanvasGenerationResponseUnknown } from '@/utils/studio/canvasGenerationSubmitError'
import { buildStudioCanvasGenerationQuote } from '@/utils/studio/studioCanvasGenerationQuote'
import { canvasQuoteConnected, canvasQuoteIdentity } from '@/utils/canvas/canvasQuote'
import { studioNodeToComposerRef } from '@/utils/studio/studioReferencePicker'
import { handleSseErrorRecharge } from '@/utils/api'
import {
  assertCanvasReferenceTransport, buildCanvasGenerationReferences,
  buildCanvasGenerationRequest,
  buildCanvasTextNodeReferences,
  canvasGenerationReferenceRole,
  prepareCanvasVideoGenerationReferences,
  validateCanvasGenerationReferenceLimits,
  canvasGenerationTaskMessage,
  type CanvasGenerationMediaType,
  type CanvasGenerationReferenceCandidate
} from '@/utils/studio/canvasGeneration'
import {
  createStudioOperationInputHash,
  isStudioOperationInputCurrent,
  isStudioOperationRunCurrent
} from '@/utils/studio/studioOperationRun'
import { loadStudioCanvasImage } from '@/utils/studio/studioCanvasImageLoad'
import { createCanvasEditLeaseManager, type CanvasNodeEditLease } from '@/utils/canvas/canvasEditLeaseManager'
import { shouldLockSmartEdit } from '@/utils/studio/smartEditLock'
import { modelForCapability, modelSupportsCapability } from '@/utils/modelCapability'
import { canvasImageUpscaleSettings } from '@/utils/studio/canvasImageUpscale'

type Baseline = Map<string, CanvasSerializedObject & { version: number }>
export type CanvasCollaborationConnectionStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'paused'
export interface CanvasImageEditInput {
  sourceNodeId: string
  sourceResourceId?: string
  modelCode: string
  funcCode: 'canvas.image.redraw' | 'canvas.image.erase' | 'canvas.image.expand' | 'canvas.image.relight' | 'canvas.image.layer_split' | 'canvas.image.touch_edit' | 'canvas.image.emotion' | 'canvas.image.portrait_texture' | 'canvas.image.multi_view' | 'canvas.image.style_apply'
  capabilityCode: 'image_edit' | 'image_inpainting' | 'image_outpainting' | 'image_layer_decomposition'
  imageEdit: Omit<NonNullable<UserImageGenerationRequest['imageEdit']>, 'sourceResourceId'>
  expectedImageCount?: number
  size?: string
  parameters?: Record<string, unknown>
}
export interface CanvasVideoToolInput {
  sourceNodeId: string
  sourceExpectedVersion?: number
  sourceResourceId?: string
  modelCode: string
  funcCode: string
  capabilityCode: string
  operation: string
  requestPrompt?: string
  parameters?: Record<string, unknown>
  durationSeconds?: number
  aspectRatio?: string
  referenceImageResourceIds?: string[]
}
type CanvasSnapshotRequest = {
  detail: CanvasProjectDetail
  allowHydrate: boolean
  allowDuringLocalGeneration: boolean
}

export type CanvasNodeGenerationResult =
  | { status: 'completed' }
  | { status: 'accepted'; reason?: string; recoveryError?: unknown }
  | { status: 'blocked'; reason: string }

type CanvasNodeGenerationOptions = {
  sessionId?: string
  imageUpscale?: { sourceNodeId: string; modelCode: string; sourceWidth: number; sourceHeight: number; scale: 2 | 4 | 6 }
  imageEdit?: CanvasImageEditInput
  videoTool?: CanvasVideoToolInput
}

export interface CanvasProjectWorkspaceRuntime {
  getNodeVersion: (nodeId: string) => number | null
  refreshWorkspace: () => Promise<void>
  acquireNodeEditLease: (nodeId: string) => Promise<CanvasNodeEditLease | null>
  acquireNodeMutationLease: (nodeId: string) => Promise<{ editSessionId: string; objectVersion: number; lease: CanvasNodeEditLease }>
  nodeEditLockOwner: (nodeId: string) => string | null
  project: CanvasProjectDetail | null
  role: CanvasProjectRole | null
  canEdit: boolean
  canMutate: boolean
  connected: boolean
  collaborationStatus: CanvasCollaborationConnectionStatus
  collaborationError: string | null
  collaboration: CanvasCollaborationState | null
  /** 401/403 后连接入口不再重试。智能体只在仍可恢复时自动重连。 */
  collaborationRecoverable: boolean
  retryCollaboration: () => void
  /** 智能体对话打开期间占用协作连接；暂停时由工作区自己恢复，面板不提供重连按钮。 */
  retainCanvasCollaboration: () => () => void
  entitlements: CanvasEntitlements | null
  undoAvailable: boolean
  isNodeBusy: (nodeId: string) => boolean
  reserveGenerationNode: (nodeId: string) => void
  releaseGenerationNode: (nodeId: string) => void
  canUseFeature: (code: string) => boolean
  saveNow: (adoption?: CanvasSceneAdoption) => Promise<void>
  deleteNodes: (nodeIds: string[]) => Promise<void>
  refreshCollaboration: () => Promise<void>
  refreshProject: () => Promise<CanvasProjectDetail | null>
  copyNodes: (nodeIds: string[]) => Promise<void>
  undoLast: () => Promise<void>
  loadDrafts: () => Promise<CanvasDraft[]>
  saveNodeDraft: (nodeId: string, existingDraftVersion: number) => Promise<CanvasDraft>
  deleteNodeDraft: (nodeId: string, draftVersion: number) => Promise<void>
  applyNodeDraft: (draft: CanvasDraft, acceptStale?: boolean) => void
  nodeResources: (nodeId: string) => CanvasResource[]
  resourceById: (resourceId: string) => CanvasResource | undefined
  prepareGenerationQuote: (kind: UserGenerationKind, node: Parameters<typeof buildStudioCanvasGenerationQuote>[0]['node'], model: UserModelListItem, prompt: string, sessionId?: string | null) => ReturnType<typeof buildStudioCanvasGenerationQuote>
  resolveResourceReference: (ref: StudioComposerRef, options?: { isCurrent?: () => boolean }) => Promise<CanvasResource>
  prepareLayerSplitSource: (nodeId: string) => Promise<{ resourceId: string; expectedVersion: number }>
  transferResource: (resourceId: string, assetName: string) => Promise<void>
  generateNode: (kind: UserGenerationKind, nodeId: string, prompt: string, options?: CanvasNodeGenerationOptions) => Promise<boolean>
  generateNodeResult: (kind: UserGenerationKind, nodeId: string, prompt: string, options?: CanvasNodeGenerationOptions) => Promise<CanvasNodeGenerationResult>
  loadNodeHistory: (nodeId: string, pageNum?: number) => Promise<CanvasTaskHistory>
  selectNodeResult: (nodeId: string, resultId: string) => Promise<void>
  applyNodeTextResult: (nodeId: string, taskId: string, inputObjectVersion: number, textContent: string) => Promise<void>
  uploadResource: (file: File, mediaType: CanvasMediaType) => Promise<CanvasResource>
  splitImage: (sourceNodeId: string, rows: number, columns: number, selectedCells?: Array<{ row: number; col: number }>) => Promise<CanvasImageSplitResult>
  splitImageRegion: (sourceNodeId: string, region: { x: number; y: number; width: number; height: number }) => Promise<CanvasImageSplitResult>
  mergeImageLayers: (sourceNodeId: string) => Promise<CanvasImageLayerMergeResult>
  importNodeText: (nodeId: string, file: File) => Promise<void>
  invokeMember: (nodeId: string, request: Omit<CanvasRuntimeInvokeRequest, 'clientRequestId' | 'projectId' | 'workspaceId' | 'canvasNode'>) => Promise<CanvasRuntimeRun>
  observeRun: (runId: string, nodeId: string, onHint: () => void) => () => void
  adoptRun: (nodeId: string, runId: string, mode: 'REPLACE' | 'APPEND' | 'CREATE_NODE') => Promise<void>
}

function serverBaseline(objects: CanvasObjectRecord[] = [], projection?: Pick<CanvasWorkspaceLoad, 'resources' | 'currentResults'> | null): Baseline {
  const result: Baseline = new Map()
  // Compare the same client representation on both sides. Hydration defaults and
  // transient server projections must not manufacture a node mutation.
  const normalized = new Map(serializeCanvasWorkspace(hydrateCanvasWorkspace({
    scopeKey: 'canvas:baseline', projectName: '', objects,
    resources: projection?.resources, currentResults: projection?.currentResults
  })).map((item) => [item.objectId, item.payload]))
  for (const object of objects) {
    if (object.deleted || !object.content) continue
    result.set(String(object.objectId), {
      objectId: String(object.objectId),
      objectType: object.objectType,
      payload: normalized.get(String(object.objectId)) || object.content,
      version: Number(object.objectVersion) || 0
    })
  }
  return result
}

function changedObjects(current: CanvasSerializedObject[], baseline: Baseline) {
  const currentMap = new Map(current.map((item) => [item.objectId, item]))
  const upserts = current.filter((item) => {
    const before = baseline.get(item.objectId)
    return !before || before.objectType !== item.objectType || stableCanvasJson(before.payload) !== stableCanvasJson(item.payload)
  })
  const deletes = Array.from(baseline.values()).filter((item) => !currentMap.has(item.objectId))
  const weight = (item: CanvasSerializedObject) => item.objectType === 'NODE' ? 0 : item.objectType === 'EDGE' ? 1 : 2
  upserts.sort((a, b) => weight(a) - weight(b))
  deletes.sort((a, b) => weight(b) - weight(a))
  return { upserts, deletes }
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size))
  return result
}

function sameAdoptionScene(local: CanvasSceneDocument, saved: CanvasSceneDocument, sceneId: string) {
  const comparable = (document: CanvasSceneDocument) => ({ ...document, scenes: document.scenes.map(scene => {
    if (scene.id !== sceneId) return scene
    const { updatedAt: _updatedAt, modeling, ...director } = scene
    const model = modeling as { versions?: Record<string, unknown>[] } | undefined
    return { ...director, modeling: model && { ...model, versions: model.versions?.map(version => {
      const { id: _id, createdAt: _createdAt, ...content } = version
      return content
    }) } }
  }) })
  return stableCanvasJson(comparable(local)) === stableCanvasJson(comparable(saved))
}

export function useCanvasProjectWorkspace(
  scopeKey: string,
  projectId: string | null,
  enabled: boolean
): CanvasProjectWorkspaceRuntime {
  const beginLoad = useStudioUiStore((state) => state.beginLoad)
  const hydrate = useStudioUiStore((state) => state.hydrate)
  const setLoadError = useStudioUiStore((state) => state.setLoadError)
  const markSaving = useStudioUiStore((state) => state.markSaving)
  const markSaved = useStudioUiStore((state) => state.markSaved)
  const markSaveError = useStudioUiStore((state) => state.markSaveError)
  const dirtyRevision = useStudioUiStore((state) => state.dirtyRevision)
  const [project, setProject] = useState<CanvasProjectDetail | null>(null)
  const [connected, setConnected] = useState(false)
  const [collaborationStatus, setCollaborationStatus] = useState<CanvasCollaborationConnectionStatus>('idle')
  const [collaborationError, setCollaborationError] = useState<string | null>(null)
  const [collaborationRecoverable, setCollaborationRecoverable] = useState(true)
  const [agentNeedsCollaboration, setAgentNeedsCollaboration] = useState(false)
  const agentCollaborationDemandRef = useRef(0)
  const agentResumeAttemptRef = useRef(0)
  const [collaboration, setCollaboration] = useState<CanvasCollaborationState | null>(null)
  const [entitlements, setEntitlements] = useState<CanvasEntitlements | null>(null)
  const entitlementsRef = useRef<CanvasEntitlements | null>(null)
  const [undoAvailable, setUndoAvailable] = useState(false)
  const [unboundTaskCount, setUnboundTaskCount] = useState(0)
  const projectRef = useRef<CanvasProjectDetail | null>(null)
  const baselineRef = useRef<Baseline>(new Map())
  const snapshotRef = useRef<CanvasWorkspaceLoad | null>(null)
  const workspaceIdRef = useRef('')
  const sessionIdRef = useRef('')
  const editLeasesRef = useRef(createCanvasEditLeaseManager())
  const ownUserIdRef = useRef<string | null>(null)
  const sessionGateRef = useRef(createCanvasSessionGate())
  const requestConnectionRef = useRef<() => void>(() => undefined)
  const collaborationPageIdRef = useRef('')
  const viewVersionRef = useRef(0)
  const savedPersonalViewRef = useRef<CanvasPersonalView | null>(null)
  const personalViewLoadedRef = useRef(false)
  const eventSeqRef = useRef(0)
  const websocketRef = useRef<WebSocket | null>(null)
  const heartbeatRef = useRef<number | null>(null)
  const reconnectRef = useRef<number | null>(null)
  const stoppedRef = useRef(true)
  const saveQueueRef = useRef(createCanvasWorkspaceSaveQueue())
  const resourceAccessRef = useRef(createCanvasResourceAccess())
  const ownOperationIdsRef = useRef(new Set<string>())
  const pendingSceneAdoptionRef = useRef<{ scope: string; adoption: CanvasSceneAdoption } | null>(null)
  const resourceMediaTypeRef = useRef(new Map<string, CanvasMediaType>())
  const resourcesRef = useRef(new Map<string, CanvasResource>())
  const referenceRegistrationsRef = useRef(new Map<string, Promise<CanvasResource>>())
  const uploadRegistryRef = useRef(createCanvasUploadRegistry<CanvasResource>())
  const textImportFlightsRef = useRef(new Map<string, Promise<void>>())
  const undoStackRef = useRef<Array<{ operationId: string; objectIds: string[] }>>([])
  const saveRequestKeysRef = useRef(new Map<string, string>())
  const copyRequestKeysRef = useRef(new Map<string, string>())
  const undoRequestKeysRef = useRef(new Map<string, string>())
  const structuralPromiseRef = useRef<Promise<void> | null>(null)
  const structuralUndoBaselineRef = useRef<string | undefined>(undefined)
  const pendingUndoRef = useRef<Promise<void> | null>(null)
  const transferRequestKeysRef = useRef(new Map<string, string>())
  const transferPromisesRef = useRef(new Map<string, Promise<void>>())
  const pendingAuthoritativeReloadRef = useRef(false)
  const generationPromisesRef = useRef(new Map<string, Promise<CanvasNodeGenerationResult>>())
  // Ref cleanup follows the terminal node render; notify composer consumers after it.
  const [generationBusyRevision, setGenerationBusyRevision] = useState(0)
  const imageSplitPromisesRef = useRef(new Map<string, Promise<CanvasImageSplitResult>>())
  const imageLayerMergePromisesRef = useRef(new Map<string, Promise<CanvasImageLayerMergeResult>>())
  // A generation target is reserved from the instant it appears on the canvas.
  // This bridges derived-node preflight (mask upload/quote), server submission,
  // active execution and terminal result settlement without sharing state across nodes.
  const reservedGenerationNodeIdsRef = useRef(new Map<string, 'preparing' | 'saved'>())
  const pendingTerminalResultsRef = useRef(new Map<string, { nodeId: string; inputVersion: number }>())
  const stalledTerminalTaskIdsRef = useRef(new Set<string>())
  const stoppedTaskQueriesRef = useRef(new Map<string, string>())
  const unreconciledTerminalTaskIdsRef = useRef(new Set<string>())
  const resultSelectionPromisesRef = useRef(new Map<string, Promise<void>>())
  const activeTaskNodeIdsRef = useRef(new Set<string>())
  const deletingNodeIdsRef = useRef(new Set<string>())
  const deferredTaskNodePositionsRef = useRef(new Map<string, CanvasDeferredNodePosition>())
  const taskTrackerRef = useRef<ReturnType<typeof createCanvasGenerationTaskTracker> | null>(null)
  const textStreamsRef = useRef(new Set<ReturnType<typeof startCanvasTextGenerationStream>>())
  const terminalSnapshotRef = useRef<{ promise: Promise<void>; timer: number; resolve: () => void } | null>(null)
  const collaborationSchedulerRef = useRef<ReturnType<typeof createCanvasSnapshotScheduler<void>> | null>(null)
  const snapshotSchedulerRef = useRef<{
    loader: (workspaceId: string, request: CanvasSnapshotRequest) => Promise<void>
    scheduler: ReturnType<typeof createCanvasSnapshotScheduler<CanvasSnapshotRequest>>
  } | null>(null)

  const taskOwnedNodeIds = useCallback(() => {
    const deleting = deletingNodeIdsRef.current
    return new Set([
      ...[...reservedGenerationNodeIdsRef.current].flatMap(([nodeId, phase]) => phase === 'saved' ? [nodeId] : []),
      ...activeTaskNodeIdsRef.current,
      // 生成单飞 Promise 在首次保存之前就存在，不能据此冻结旧服务端输入。
      // 首次保存完成后由 reserved 集合保护，再由真实任务和待回填结果继续接管。
      ...[...pendingTerminalResultsRef.current.values()].map((pending) => pending.nodeId)
    ].filter((nodeId) => !deleting.has(nodeId)))
  }, [])

  const releaseDeferredNodePosition = useCallback((nodeId: string) => {
    if (!deferredTaskNodePositionsRef.current.delete(nodeId)) return
    useStudioUiStore.setState((state) => state.scopeKey === scopeKey
      ? { dirtyRevision: state.dirtyRevision + 1 }
      : state)
  }, [scopeKey])

  useEffect(() => useStudioUiStore.subscribe((state, previous) => {
    if (!enabled || state.scopeKey !== scopeKey || state.nodes === previous.nodes) return
    const tracked = taskOwnedNodeIds()
    if (!tracked.size) return
    deferredTaskNodePositionsRef.current = updateCanvasDeferredNodePositions(
      serializeCanvasWorkspace(getStudioWorkspaceData()),
      baselineRef.current,
      tracked,
      deferredTaskNodePositionsRef.current
    )
  }), [enabled, scopeKey, taskOwnedNodeIds])

  const canUseFeature = useCallback((code: string) => {
    const entitlement = entitlementsRef.current?.items?.find((item) => item.entitlementCode === code)
    return entitlement?.enabled !== false
  }, [])

  const isNodeBusy = useCallback((nodeId: string) => reservedGenerationNodeIdsRef.current.has(nodeId)
    || activeTaskNodeIdsRef.current.has(nodeId)
    || generationPromisesRef.current.has(nodeId)
    || [...pendingTerminalResultsRef.current.values()].some((pending) => pending.nodeId === nodeId), [generationBusyRevision])

  const reserveGenerationNode = useCallback((nodeId: string) => {
    const state = useStudioUiStore.getState()
    if (state.scopeKey !== scopeKey || !state.nodes.some((node) => node.id === nodeId)) {
      throw new Error('生成目标节点不存在')
    }
    if (!reservedGenerationNodeIdsRef.current.has(nodeId)) reservedGenerationNodeIdsRef.current.set(nodeId, 'preparing')
    updateCanvasNodeRuntime(scopeKey, nodeId, { status: 'queued', errorMessage: undefined })
  }, [scopeKey])

  const releaseGenerationNode = useCallback((nodeId: string) => {
    if (generationPromisesRef.current.has(nodeId) || activeTaskNodeIdsRef.current.has(nodeId)
      || [...pendingTerminalResultsRef.current.values()].some((pending) => pending.nodeId === nodeId)) return
    if (reservedGenerationNodeIdsRef.current.delete(nodeId) && !stoppedRef.current) {
      setGenerationBusyRevision((revision) => revision + 1)
    }
  }, [])

  const loadCollaborationState = useCallback(async (workspaceId: string) => {
    try {
      const state = await canvasCollaborationState(workspaceId)
      if (workspaceIdRef.current === workspaceId && !stoppedRef.current) {
        const ownSession = state.sessions.find((item) => String(item.sessionId || '') === sessionIdRef.current)
        if (ownSession?.userId != null) ownUserIdRef.current = String(ownSession.userId)
        setCollaboration(state)
      }
    } catch {
      // 在线状态是辅助信息，失败不能覆盖已加载的工作区。
    }
  }, [])

  const refreshCollaboration = useCallback((invalidateInFlight = false) => {
    const workspaceId = workspaceIdRef.current
    if (!workspaceId) return Promise.resolve()
    collaborationSchedulerRef.current ||= createCanvasSnapshotScheduler(loadCollaborationState)
    return collaborationSchedulerRef.current.request(workspaceId, undefined, invalidateInFlight)
  }, [loadCollaborationState])

  const waitForSession = useCallback(() => sessionGateRef.current.wait(() => requestConnectionRef.current()), [])
  const retryCollaboration = useCallback(() => requestConnectionRef.current(), [])
  const retainCanvasCollaboration = useCallback(() => {
    agentCollaborationDemandRef.current += 1
    setAgentNeedsCollaboration(true)
    return () => {
      agentCollaborationDemandRef.current = Math.max(0, agentCollaborationDemandRef.current - 1)
      if (agentCollaborationDemandRef.current === 0) setAgentNeedsCollaboration(false)
    }
  }, [])
  useEffect(() => {
    if (!agentNeedsCollaboration || !collaborationRecoverable) {
      agentResumeAttemptRef.current = 0
      return
    }
    if (collaborationStatus === 'connected') {
      agentResumeAttemptRef.current = 0
      return
    }
    if (collaborationStatus !== 'paused') return
    const attempt = agentResumeAttemptRef.current
    const timer = window.setTimeout(() => {
      agentResumeAttemptRef.current = attempt + 1
      retryCollaboration()
    }, canvasAgentCollaborationResumeDelay(attempt))
    return () => window.clearTimeout(timer)
  }, [agentNeedsCollaboration, collaborationRecoverable, collaborationStatus, retryCollaboration])
  const acquireNodeEditLease = useCallback(async (nodeId: string) => {
    const detail = projectRef.current
    const workspaceId = workspaceIdRef.current
    if (!detail || !workspaceId || detail.roleCode === 'VIEWER') throw new Error('当前画布不可编辑')
    const members = await canvasMemberList(detail.projectId)
    if (workspaceIdRef.current !== workspaceId || stoppedRef.current) throw new Error('画布已切换')
    // 成员列表是团队判断依据，不用在线人数推断个人项目。
    if (!shouldLockSmartEdit({ hasCanvasRuntime: true, isTeamProject: members.items.length > 1 || detail.roleCode !== 'OWNER' })) return null
    const sessionId = await waitForSession()
    if (workspaceIdRef.current !== workspaceId || stoppedRef.current) throw new Error('画布已切换')
    return editLeasesRef.current.acquire(workspaceId, sessionId, [nodeId])
  }, [waitForSession])
  const nodeEditLockOwner = useCallback((nodeId: string) => {
    const lock = collaboration?.locks.find((item) => String(item.objectId) === nodeId && item.sessionId !== sessionIdRef.current)
    return lock ? lock.nickName || '其他成员' : null
  }, [collaboration])

  const refreshProject = useCallback(async () => {
    if (!projectId) return null
    try {
      const detail = await canvasProjectDetail(projectId)
      projectRef.current = detail
      setProject(detail)
      return detail
    } catch {
      return null
    }
  }, [projectId])

  const loadAuthoritativeSnapshot = useCallback(async (requestedWorkspaceId: string, request: CanvasSnapshotRequest) => {
    const resourceAccess = resourceAccessRef.current
    const snapshotIdentity = canvasQuoteIdentity()
    if (String(request.detail.workspace.workspaceId) !== requestedWorkspaceId) return
    const { detail, allowHydrate, allowDuringLocalGeneration } = request
    const workspaceId = String(detail.workspace.workspaceId)
    // 先让服务端收口已终态绑定，再读取快照，避免任务状态与 currentResults 来自两个时刻。
    const activeTasks = await canvasWorkspaceActiveTasks(workspaceId)
    if (stoppedRef.current || projectRef.current?.projectId !== detail.projectId) return
    activeTaskNodeIdsRef.current = new Set(activeTasks.items
      .filter((item) => item.objectId != null)
      .map((item) => String(item.objectId)))
    setUnboundTaskCount(activeTasks.items.filter((item) => item.sourceType !== 'RUNTIME_RUN' && !item.taskId).length)
    const personalView: Promise<CanvasWorkspaceView> = personalViewLoadedRef.current
      ? Promise.resolve({ viewVersion: viewVersionRef.current, view: savedPersonalViewRef.current })
      : canvasWorkspaceViewLoad(workspaceId)
    const [workspace, view] = await Promise.all([
      loadCanvasWorkspaceSnapshot(String(detail.projectId), workspaceId, snapshotRef.current),
      personalView
    ])
    if (stoppedRef.current || projectRef.current?.projectId !== detail.projectId || resourceAccessRef.current !== resourceAccess) return
    workspace.resources = await resourceAccess.prepare(workspace.resources, workspace.sceneDocument)
    if (stoppedRef.current || projectRef.current?.projectId !== detail.projectId || resourceAccessRef.current !== resourceAccess) return
    viewVersionRef.current = Number(view?.viewVersion) || 0
    savedPersonalViewRef.current = canvasPersonalViewCoordinates(view?.view || null)
    personalViewLoadedRef.current = true
    const tasks = mergeCanvasTaskProjections(workspace.tasks, activeTasks.items)
    const activeTaskIdentities = new Set(activeTasks.items.flatMap((task) => task.taskId != null
      ? [String(task.taskId)]
      : task.operationId ? [`operation:${String(task.operationId)}`] : []))
    const localState = useStudioUiStore.getState()
    if (allowHydrate && localState.scopeKey === scopeKey && localState.hydrated && localState.dirtyRevision > 0) {
      pendingAuthoritativeReloadRef.current = true
      return
    }
    if (allowHydrate && !allowDuringLocalGeneration && reservedGenerationNodeIdsRef.current.size > 0) {
      pendingAuthoritativeReloadRef.current = true
      return
    }
    const objects = workspace.objects || []
    let waitingForTerminalResults = false
    for (const [taskId, pending] of pendingTerminalResultsRef.current) {
      const object = objects.find((item) => String(item.objectId) === pending.nodeId && !item.deleted)
      const selected = workspace.currentResults?.find((item) => String(item.objectId) === pending.nodeId)
      if (object && Number(object.objectVersion) === pending.inputVersion
        && !isCurrentCanvasTaskResult(selected, taskId, pending.inputVersion)) {
        // Hydrate the rest of the workspace while this task's own result is pending.
        // The adapter keeps this node in its result-sync state.
        waitingForTerminalResults = true
        continue
      }
      pendingTerminalResultsRef.current.delete(taskId)
      reservedGenerationNodeIdsRef.current.delete(pending.nodeId)
    }
    const sameScope = localState.scopeKey === scopeKey
    const hydratedWorkspace = allowHydrate ? preserveCanvasTransientNodes(hydrateCanvasWorkspace({
      scopeKey,
      projectName: detail.projectName,
      objects,
      tasks,
      runtimeTaskIds: new Set([...activeTaskIdentities, ...pendingTerminalResultsRef.current.keys()]),
      pendingResultTaskIds: new Set(pendingTerminalResultsRef.current.keys()),
      reservedNodeIds: new Set(reservedGenerationNodeIdsRef.current.keys()),
      resources: workspace.resources,
      currentResults: workspace.currentResults,
      sceneDocument: workspace.sceneDocument,
      view
    }), sameScope ? localState : { scopeKey: '', nodes: [], edges: [] }) : undefined
    let recoveredScenes = false
    if (hydratedWorkspace && canvasProjectCanEdit(detail.roleCode)) {
      const ids = canvasDirectorSceneIds(hydratedWorkspace.nodes)
      if ([...ids].some(id => !Object.hasOwn(hydratedWorkspace.directorScenes, id))) {
        const actorId = useUserStore.getState().user?.id ?? ownUserIdRef.current
        const recovered = await recoverCanvasDirectorScenes(ids, hydratedWorkspace.directorScenes,
          sameScope ? localState.directorScenes : {}, actorId != null ? 'user:' + actorId : undefined, scopeKey)
        if (stoppedRef.current || projectRef.current?.projectId !== detail.projectId
          || resourceAccessRef.current !== resourceAccess || canvasQuoteIdentity() !== snapshotIdentity) return
        const latest = useStudioUiStore.getState()
        if (latest.scopeKey !== scopeKey) return
        if ((latest.hydrated && latest.dirtyRevision > 0)
          || (!allowDuringLocalGeneration && reservedGenerationNodeIdsRef.current.size > 0)) {
          pendingAuthoritativeReloadRef.current = true
          return
        }
        recoveredScenes = Object.keys(recovered).length > 0
        Object.assign(hydratedWorkspace.directorScenes, recovered)
      }
    }
    snapshotRef.current = workspace
    baselineRef.current = serverBaseline(objects, workspace)
    resourceMediaTypeRef.current = new Map(workspace.resources.map((item) => [String(item.resourceId), item.mediaType]))
    resourcesRef.current = new Map(workspace.resources.map((item) => [String(item.resourceId), item]))
    workspaceIdRef.current = String(detail.workspace.workspaceId)
    eventSeqRef.current = Number(workspace.workspace.eventSeq) || 0
    if (hydratedWorkspace) {
      pendingAuthoritativeReloadRef.current = waitingForTerminalResults
      const existingNodeIds = new Set(hydratedWorkspace.nodes.map((node) => node.id))
      if (sameScope) {
        for (const [id, scene] of Object.entries(hydratedWorkspace.directorScenes)) {
          const modeling = localState.directorScenes[id]?.modeling
          if (!scene.modeling && modeling && workspace.sceneDocument?.schemaVersion !== 2) {
            hydratedWorkspace.directorScenes[id] = { ...scene, modeling }
          }
        }
      }
      for (const nodeId of deferredTaskNodePositionsRef.current.keys()) {
        if (!existingNodeIds.has(nodeId)) deferredTaskNodePositionsRef.current.delete(nodeId)
      }
      hydrate(applyCanvasDeferredNodePositions(hydratedWorkspace, deferredTaskNodePositionsRef.current), { reconcileInteraction: true, readOnly: !canvasProjectCanEdit(detail.roleCode) })
      if (recoveredScenes) useStudioUiStore.setState(state => state.scopeKey === scopeKey
        ? { dirtyRevision: state.dirtyRevision + 1 } : state)
    }
    for (const task of tasks) {
      if (task.sourceType === 'RUNTIME_RUN') continue
      if (!task.taskId || !task.objectId) continue
      const taskId = String(task.taskId)
      const nodeId = String(task.objectId)
      const object = objects.find((item) => String(item.objectId) === nodeId && !item.deleted)
      const current = workspace.currentResults?.find((item) => String(item.objectId) === nodeId)
      const taskIsActive = activeTaskIdentities.has(taskId)
        || (task.operationId != null && activeTaskIdentities.has(`operation:${String(task.operationId)}`))
      const taskIsPendingResult = pendingTerminalResultsRef.current.has(taskId)
      const awaitingResult = object && (taskIsPendingResult || stalledTerminalTaskIdsRef.current.has(taskId))
        && needsCanvasTerminalResult(task, current, Number(object.objectVersion))
      if (isCanvasTaskTerminal(task.status)) stoppedTaskQueriesRef.current.delete(taskId)
      if (!awaitingResult) stalledTerminalTaskIdsRef.current.delete(taskId)
      const stoppedMessage = stoppedTaskQueriesRef.current.get(taskId)
      if (stoppedMessage) {
        updateCanvasNodeRuntime(scopeKey, nodeId, { status: 'failed', errorMessage: stoppedMessage })
      } else if (awaitingResult && stalledTerminalTaskIdsRef.current.has(taskId)) {
        updateCanvasNodeRuntime(scopeKey, nodeId, {
          status: 'failed', errorMessage: '任务已完成，但结果未同步到画布。请在生成历史确认结果'
        })
      } else if ((taskIsActive && !isCanvasTaskTerminal(task.status)) || taskIsPendingResult) {
        void taskTrackerRef.current?.follow(taskId, nodeId, task)
      }
    }
  }, [hydrate, scopeKey])

  const applyAuthoritativeSnapshot = useCallback((
    detail: CanvasProjectDetail,
    allowHydrate: boolean,
    allowDuringLocalGeneration = false,
    invalidateInFlight = true
  ) => {
    if (snapshotSchedulerRef.current?.loader !== loadAuthoritativeSnapshot) {
      snapshotSchedulerRef.current = {
        loader: loadAuthoritativeSnapshot,
        scheduler: createCanvasSnapshotScheduler(loadAuthoritativeSnapshot)
      }
    }
    return snapshotSchedulerRef.current.scheduler.request(String(detail.workspace.workspaceId),
      { detail, allowHydrate, allowDuringLocalGeneration }, invalidateInFlight)
  }, [loadAuthoritativeSnapshot])

  const reconcileTerminalTasks = useCallback((): Promise<void> => {
    const current = terminalSnapshotRef.current
    if (current) return current.promise
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    const timer = window.setTimeout(() => {
      terminalSnapshotRef.current = null
      const detail = projectRef.current
      if (!detail || stoppedRef.current) { resolve(); return }
      // A terminal event can arrive during an older TASK_ACCEPTED read. Keep one
      // trailing read so the settled result cannot be replaced by that stale snapshot.
      void applyAuthoritativeSnapshot(detail, true, true, true).then(resolve, reject)
    }, 200)
    terminalSnapshotRef.current = { promise, timer, resolve }
    return promise
  }, [applyAuthoritativeSnapshot])

  useEffect(() => {
    if (!enabled) return
    const streams = textStreamsRef.current
    const tracker = createCanvasGenerationTaskTracker({
      workspaceId: () => workspaceIdRef.current,
      inputVersion: (nodeId) => baselineRef.current.get(nodeId)?.version,
      query: (workspaceId, taskId) => canvasGenerateTask(workspaceId, taskId),
      queryActive: canvasWorkspaceActiveTasks,
      onUpdate: (taskId, nodeId, task) => {
        const state = canvasTaskState(task)
        useStudioUiStore.getState().patchTask(taskId, {
          status: state.status, stage: state.stage,
          progress: canvasTaskProgress(task) ?? 0,
          canvasProgress: canvasTaskProgress(task),
          canvasVideoFinishEta: canvasVideoFinishEta(task),
          canvasAwaitingVerification: canvasTaskAwaitingVerification(task),
          errorMessage: state.status === 'failed' ? canvasGenerationTaskMessage(task) : undefined
        })
        if (!isCanvasTaskTerminal(task.status)) {
          activeTaskNodeIdsRef.current.add(nodeId)
          updateCanvasNodeRuntime(scopeKey, nodeId, { status: state.nodeStatus, errorMessage: undefined })
        }
      },
      onTerminal: async (taskId, nodeId, task) => {
        if (task.status.toUpperCase() !== 'SUCCEEDED') {
          await reconcileTerminalTasks().catch(() => { pendingAuthoritativeReloadRef.current = true })
          activeTaskNodeIdsRef.current.delete(nodeId)
          releaseDeferredNodePosition(nodeId)
          return
        }
        if (['IMAGE', 'VIDEO', 'AUDIO'].includes(String(task.mediaType).toUpperCase())
          && !(String(task.mediaType).toUpperCase() === 'AUDIO' && task.textContent && !task.ossUrl && !task.originUrl)) {
          const inputVersion = task.inputObjectVersion ?? baselineRef.current.get(nodeId)?.version
          if (inputVersion != null && !pendingTerminalResultsRef.current.has(taskId)) {
            pendingTerminalResultsRef.current.set(taskId, { nodeId, inputVersion })
          }
        }
        await reconcileTerminalTasks()
        if (pendingTerminalResultsRef.current.has(taskId)) {
          throw new Error('等待生成结果同步')
        }
        activeTaskNodeIdsRef.current.delete(nodeId)
        releaseDeferredNodePosition(nodeId)
      },
      onTerminalStalled: (taskId, nodeId, task) => {
        stalledTerminalTaskIdsRef.current.add(taskId)
        pendingTerminalResultsRef.current.delete(taskId)
        reservedGenerationNodeIdsRef.current.delete(nodeId)
        activeTaskNodeIdsRef.current.delete(nodeId)
        releaseDeferredNodePosition(nodeId)
        if (generationPromisesRef.current.has(nodeId)) unreconciledTerminalTaskIdsRef.current.add(taskId)
        const message = '任务已结束，但结果未同步到画布。请刷新确认生成历史，避免重复付费'
        updateCanvasNodeRuntime(scopeKey, nodeId, { status: 'failed', errorMessage: message })
        antdMessage.error(message)
        useStudioUiStore.getState().patchTask(taskId, {
          status: isCanvasTaskTerminal(task.status) && task.status.toUpperCase() === 'SUCCEEDED' ? 'succeeded' : 'failed',
          stage: '结果同步未完成',
          errorMessage: message
        })
      },
      onUnavailable: (taskId) => {
        useStudioUiStore.getState().patchTask(taskId, { status: 'waiting', stage: '任务状态重连中' })
      },
      onQueryStopped: (taskId, nodeId, error) => {
        const message = `无法继续查询任务：${apiErrorMessage(error)}。任务可能仍在服务端进行，请刷新或重新登录后查看，勿重复提交`
        stoppedTaskQueriesRef.current.set(taskId, message)
        updateCanvasNodeRuntime(scopeKey, nodeId, { status: 'failed', errorMessage: message })
        antdMessage.error(message)
        useStudioUiStore.getState().patchTask(taskId, {
          status: 'waiting', stage: '查询已停止', errorMessage: message
        })
      }
    })
    taskTrackerRef.current = tracker
    return () => {
      for (const stream of streams) stream.close()
      streams.clear()
      tracker.dispose()
      if (taskTrackerRef.current === tracker) taskTrackerRef.current = null
      const pending = terminalSnapshotRef.current
      if (pending) {
        window.clearTimeout(pending.timer)
        pending.resolve()
      }
      terminalSnapshotRef.current = null
    }
  }, [enabled, reconcileTerminalTasks, releaseDeferredNodePosition, scopeKey])

  useEffect(() => {
    if (!enabled || unboundTaskCount < 1) return
    let cancelled = false
    let timer: number | null = null
    const poll = async () => {
      const detail = projectRef.current
      if (!detail || cancelled || stoppedRef.current) return
      try {
        const active = await canvasWorkspaceActiveTasks(String(detail.workspace.workspaceId))
        if (cancelled || stoppedRef.current) return
        activeTaskNodeIdsRef.current = new Set(active.items
          .filter((item) => item.objectId != null)
          .map((item) => String(item.objectId)))
        const unbound = active.items.filter((item) => item.sourceType !== 'RUNTIME_RUN' && !item.taskId).length
        setUnboundTaskCount(unbound)
        for (const task of active.items) {
          if (task.sourceType !== 'RUNTIME_RUN' && task.taskId && task.objectId) {
            void taskTrackerRef.current?.follow(String(task.taskId), String(task.objectId), task)
          }
        }
        // A formerly unbound intent may have bound or settled between polls.
        // Reconcile once; while it remains unbound, only active-task repeats.
        if (unbound === 0) {
          await applyAuthoritativeSnapshot(detail, true, false, false)
        }
      } catch {
        // 未绑定 taskId 的提交意图仍由服务端对账，下一轮继续只读活跃任务表。
      }
      if (!cancelled && !stoppedRef.current) {
        timer = window.setTimeout(() => void poll(), 8000)
      }
    }
    timer = window.setTimeout(() => void poll(), 8000)
    return () => {
      cancelled = true
      if (timer != null) window.clearTimeout(timer)
    }
  }, [unboundTaskCount, applyAuthoritativeSnapshot, enabled])

  useEffect(() => {
    if (!enabled || !projectId) return
    let cancelled = false
    sessionGateRef.current.fail(new Error('画布已切换'))
    sessionGateRef.current = createCanvasSessionGate()
    ownUserIdRef.current = useUserStore.getState().user?.id == null
      ? null : String(useUserStore.getState().user?.id)
    stoppedRef.current = false
    resourceAccessRef.current.dispose()
    const resourceAccess = createCanvasResourceAccess()
    resourceAccessRef.current = resourceAccess
    setCollaborationRecoverable(true)
    pendingAuthoritativeReloadRef.current = false
    snapshotRef.current = null
    projectRef.current = null
    workspaceIdRef.current = ''
    personalViewLoadedRef.current = false
    viewVersionRef.current = 0
    savedPersonalViewRef.current = null
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUnboundTaskCount(0)
    beginLoad(scopeKey)
    // 项目参数变化时先清空上一工作区运行态，再发起权威快照加载。
    setProject(null)
    setConnected(false)
    setCollaborationStatus('idle')
    setCollaborationError(null)
    setCollaboration(null)
    setEntitlements(null)
    entitlementsRef.current = null
    activeTaskNodeIdsRef.current.clear()
    deletingNodeIdsRef.current.clear()
    reservedGenerationNodeIdsRef.current.clear()
    deferredTaskNodePositionsRef.current.clear()
    pendingTerminalResultsRef.current.clear()
    stalledTerminalTaskIdsRef.current.clear()
    stoppedTaskQueriesRef.current.clear()
    unreconciledTerminalTaskIdsRef.current.clear()
    undoStackRef.current = []
    saveRequestKeysRef.current.clear()
    copyRequestKeysRef.current.clear()
    undoRequestKeysRef.current.clear()
    setUndoAvailable(false)
    let reconnectAttempt = 0
    let connecting = false
    let hadConnected = false
    let deferredForEnvironment = false
    let automaticReconnectBlocked = false
    let lastHeartbeatAck = 0
    let heartbeatNonce = 0
    let acknowledgedHeartbeatNonce = 0

    if (!collaborationPageIdRef.current) {
      collaborationPageIdRef.current = `canvas_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`.slice(0, 64)
    }

    const environmentReady = () => !document.hidden && navigator.onLine !== false
    const pauseConnection = (reason: string) => {
      setConnected(false)
      setCollaborationStatus('paused')
      setCollaborationError(reason)
    }

    const scheduleReconnect = () => {
      if (cancelled || stoppedRef.current || automaticReconnectBlocked) return
      if (!environmentReady()) {
        deferredForEnvironment = true
        pauseConnection(navigator.onLine === false ? '网络不可用，恢复后将重新连接' : '页面重新激活后将恢复协作连接')
        return
      }
      if (!canvasCollaborationShouldAutoReconnect(hadConnected, reconnectAttempt)) {
        automaticReconnectBlocked = true
        pauseConnection(hadConnected ? '实时协作多次重连失败，请手动重试' : '实时协作握手失败，请手动重试')
        return
      }
      if (reconnectRef.current != null) window.clearTimeout(reconnectRef.current)
      const delay = canvasCollaborationReconnectDelay(reconnectAttempt)
      reconnectAttempt += 1
      setCollaborationStatus('reconnecting')
      reconnectRef.current = window.setTimeout(() => void connect('reconnect'), delay)
    }

    const stopSocket = () => {
      if (heartbeatRef.current != null) window.clearInterval(heartbeatRef.current)
      if (reconnectRef.current != null) window.clearTimeout(reconnectRef.current)
      heartbeatRef.current = null
      reconnectRef.current = null
      const socket = websocketRef.current
      websocketRef.current = null
      if (socket && socket.readyState < WebSocket.CLOSING) socket.close(1000, 'page closed')
      sessionIdRef.current = ''
      sessionGateRef.current.disconnect()
      taskTrackerRef.current?.setRealtimeConnected(false)
      setConnected(false)
    }

    const connect = async (intent: 'initial' | 'reconnect' | 'manual' = 'initial') => {
      if (cancelled || stoppedRef.current || !workspaceIdRef.current) return
      if (!canUseFeature('canvas.collaborate')) return
      if (connecting || (websocketRef.current && websocketRef.current.readyState < WebSocket.CLOSING)) return
      if (!environmentReady()) {
        deferredForEnvironment = true
        pauseConnection(navigator.onLine === false ? '网络不可用，恢复后将连接协作通道' : '页面重新激活后将连接协作通道')
        return
      }
      deferredForEnvironment = false
      connecting = true
      setConnected(false)
      setCollaborationStatus(intent === 'reconnect' ? 'reconnecting' : 'connecting')
      setCollaborationError(null)
      if (reconnectRef.current != null) window.clearTimeout(reconnectRef.current)
      reconnectRef.current = null
      try {
        const ticket = await canvasCollaborationTicket(workspaceIdRef.current, collaborationPageIdRef.current)
        if (cancelled || stoppedRef.current) return
        const socket = new WebSocket(canvasCollaborationWebsocketUrl(ticket.websocketPath))
        websocketRef.current = socket
        socket.onmessage = (event) => {
          if (websocketRef.current !== socket || cancelled || stoppedRef.current) return
          let payload: Record<string, unknown>
          try { payload = parseCanvasApiJson<Record<string, unknown>>(String(event.data)) } catch { return }
          const type = String(payload.type || '')
          if (type === 'CONNECTED') {
            if (String(payload.workspaceId || '') !== workspaceIdRef.current) {
              socket.close(4001, 'workspace mismatch')
              return
            }
            const recovering = reconnectAttempt > 0
            hadConnected = true
            reconnectAttempt = 0
            automaticReconnectBlocked = false
            sessionIdRef.current = String(payload.sessionId || ticket.sessionId)
            sessionGateRef.current.ready(sessionIdRef.current)
            setConnected(true)
            setCollaborationStatus('connected')
            setCollaborationError(null)
            taskTrackerRef.current?.setRealtimeConnected(Number(payload.taskEventsVersion) >= 1)
            void refreshCollaboration(true)
            if (recovering && projectRef.current) {
              if (useStudioUiStore.getState().dirtyRevision === 0) {
                void applyAuthoritativeSnapshot(projectRef.current, true).catch(() => undefined)
              } else pendingAuthoritativeReloadRef.current = true
            }
            if (heartbeatRef.current != null) window.clearInterval(heartbeatRef.current)
            lastHeartbeatAck = Date.now()
            acknowledgedHeartbeatNonce = heartbeatNonce
            const heartbeatMs = Math.max(5, Number(ticket.heartbeatSeconds) || 15) * 1000
            heartbeatRef.current = window.setInterval(() => {
              if (socket.readyState === WebSocket.OPEN) {
                if (Date.now() - lastHeartbeatAck > heartbeatMs * 3) {
                  socket.close(4002, 'heartbeat timeout')
                  return
                }
                socket.send(JSON.stringify({ type: 'HEARTBEAT', acknowledgedSeq: eventSeqRef.current,
                  nonce: String(++heartbeatNonce) }))
              }
            }, heartbeatMs)
            return
          }
          if (type === 'HEARTBEAT_ACK') {
            const nonce = Number(payload.nonce)
            if (Number.isSafeInteger(nonce) && nonce > acknowledgedHeartbeatNonce && nonce <= heartbeatNonce) {
              acknowledgedHeartbeatNonce = nonce
              lastHeartbeatAck = Date.now()
            }
            return
          }
          if (!sessionIdRef.current) return
          if (type === 'RUNTIME_RUN_STATE') {
            taskTrackerRef.current?.acceptRunEvent(payload)
            return
          }
          if (canvasCollaborationNeedsState(payload, sessionIdRef.current, ownUserIdRef.current)) {
            void refreshCollaboration(true)
            return
          }
          if (type === 'SESSION_CLOSED') {
            automaticReconnectBlocked = true
            stopSocket()
            pauseConnection('当前协作会话已结束，请手动重新连接')
            void refreshProject()
            return
          }
          if (type === 'WORKSPACE_COMMITTED' || type === 'WORKSPACE_IMPORTED' || type === 'TASK_ACCEPTED'
            || type === 'TASK_TERMINAL' || type === 'TEXT_AUTO_APPLIED'
            || type === 'RESULT_SELECTED' || type === 'RESULT_AUTO_SELECTED') {
            const operationId = String(payload.operationId || '')
            const terminalProjection = type === 'TASK_TERMINAL' || type === 'TEXT_AUTO_APPLIED'
              || type === 'RESULT_AUTO_SELECTED'
            if (type === 'TASK_TERMINAL') {
              const taskId = String(payload.taskId || '')
              if (taskId && taskTrackerRef.current?.acceptEvent(payload)) {
                return
              }
            } else if (type === 'TASK_ACCEPTED') {
              taskTrackerRef.current?.acceptEvent(payload)
            }
            if (operationId && ownOperationIdsRef.current.delete(operationId)) return
            if (useStudioUiStore.getState().dirtyRevision === 0 && projectRef.current) {
              if (terminalProjection) void reconcileTerminalTasks().catch(() => undefined)
              else void applyAuthoritativeSnapshot(projectRef.current, true).catch(() => undefined)
            } else {
              pendingAuthoritativeReloadRef.current = true
            }
          }
        }
        socket.onclose = () => {
          if (websocketRef.current !== socket) return
          websocketRef.current = null
          sessionIdRef.current = ''
          sessionGateRef.current.disconnect()
          taskTrackerRef.current?.setRealtimeConnected(false)
          setConnected(false)
          if (heartbeatRef.current != null) window.clearInterval(heartbeatRef.current)
          heartbeatRef.current = null
          if (cancelled || stoppedRef.current || automaticReconnectBlocked) return
          if (!hadConnected) {
            automaticReconnectBlocked = true
            pauseConnection('实时协作握手失败，请手动重试')
            return
          }
          scheduleReconnect()
        }
      } catch (error: unknown) {
        if (cancelled || stoppedRef.current) return
        const role = projectRef.current?.roleCode
        if (role === 'OWNER' || role === 'EDITOR') {
          markSaveError(apiErrorMessage(error, '实时协作连接失败，当前画布暂时只读'))
        }
        const status = (error as { response?: { status?: number }; status?: number; code?: number })?.response?.status
          ?? (error as { status?: number; code?: number })?.status
          ?? (error as { code?: number })?.code
        if (Number(status) === 401 || Number(status) === 403) {
          stoppedRef.current = true
          setCollaborationRecoverable(false)
          const text = apiErrorMessage(error, '画布协作连接无权限')
          setCollaborationStatus('paused')
          setCollaborationError(text)
          sessionGateRef.current.fail(new Error(text))
          return
        }
        scheduleReconnect()
      } finally {
        connecting = false
      }
    }

    const requestConnection = () => {
      if (cancelled || stoppedRef.current || connecting) return
      automaticReconnectBlocked = false
      reconnectAttempt = 0
      if (reconnectRef.current != null) window.clearTimeout(reconnectRef.current)
      reconnectRef.current = null
      void connect('manual')
    }
    requestConnectionRef.current = requestConnection

    const resumeDeferredConnection = () => {
      if (!deferredForEnvironment || !environmentReady()) return
      deferredForEnvironment = false
      automaticReconnectBlocked = false
      void connect(hadConnected ? 'reconnect' : 'initial')
    }
    window.addEventListener('online', resumeDeferredConnection)
    document.addEventListener('visibilitychange', resumeDeferredConnection)

    void (async () => {
      try {
        const detail = await canvasProjectDetail(projectId)
        if (cancelled) return
        projectRef.current = detail
        if (!ownUserIdRef.current && detail.roleCode === 'OWNER') ownUserIdRef.current = String(detail.ownerUserId)
        setProject(detail)
        const entitlementLoad = canvasEntitlementEffective(String(detail.projectId)).then((value) => {
          if (cancelled) return
          entitlementsRef.current = value
          setEntitlements(value)
        }).catch(() => {
          if (!cancelled) setEntitlements(null)
        })
        await applyAuthoritativeSnapshot(detail, true)
        if (cancelled) return
        await entitlementLoad
        void connect()
      } catch (error: unknown) {
        if (!cancelled) setLoadError(apiErrorMessage(error, '自由画布加载失败'))
      }
    })()

    return () => {
      cancelled = true
      stoppedRef.current = true
      resourceAccess.dispose()
      window.removeEventListener('online', resumeDeferredConnection)
      document.removeEventListener('visibilitychange', resumeDeferredConnection)
      sessionGateRef.current.fail(new Error('画布已关闭'))
      requestConnectionRef.current = () => undefined
      stopSocket()
    }
  }, [applyAuthoritativeSnapshot, beginLoad, canUseFeature, enabled, markSaveError, projectId, reconcileTerminalTasks, refreshCollaboration, refreshProject, scopeKey, setLoadError])

  const performSave = useCallback(async function performSave(): Promise<void> {
    const pending = pendingSceneAdoptionRef.current
    const requestedAdoption = pending?.scope === scopeKey ? pending.adoption : undefined
    const saveIdentity = canvasQuoteIdentity()
    const detail = projectRef.current
    const workspaceId = workspaceIdRef.current
    if (!enabled || !detail || !workspaceId) return
    const localRevision = useStudioUiStore.getState().dirtyRevision
    const workspace = getStudioWorkspaceData()
    const baseSnapshot = snapshotRef.current
    const baseObjects = baselineRef.current
    const currentSceneScope = () => !stoppedRef.current && workspaceIdRef.current === workspaceId
      && canvasQuoteIdentity() === saveIdentity && useStudioUiStore.getState().scopeKey === scopeKey
    if (!currentSceneScope() || workspace.scopeKey !== scopeKey) return
    const ownedNodeIds = taskOwnedNodeIds()
    const current = serializeCanvasWorkspace(workspace)
    const currentObjectIds = new Set(current.map((item) => item.objectId))
    const bypassedTaskDeletion = [...ownedNodeIds].find((nodeId) =>
      baselineRef.current.get(nodeId)?.objectType === 'NODE' && !currentObjectIds.has(nodeId))
    if (bypassedTaskDeletion) {
      const text = '生成任务关联节点必须先停止排队任务，再通过节点删除入口移除'
      markSaveError(text)
      throw new Error(text)
    }
    deferredTaskNodePositionsRef.current = updateCanvasDeferredNodePositions(
      current,
      baselineRef.current,
      ownedNodeIds,
      deferredTaskNodePositionsRef.current
    )
    const serialized = preserveCanvasTaskOwnedObjects(
      preserveCanvasDeferredNodePositions(current, baselineRef.current, deferredTaskNodePositionsRef.current),
      baselineRef.current,
      ownedNodeIds
    )
    const { upserts, deletes } = changedObjects(serialized, baselineRef.current)
    const ordered = [...deletes, ...upserts]
    const flushCanvasBeforeAdoption = Boolean(requestedAdoption && ordered.length)
    const adoption = flushCanvasBeforeAdoption ? undefined : requestedAdoption
    const settleAdoption = () => {
      if (adoption && pendingSceneAdoptionRef.current === pending) pendingSceneAdoptionRef.current = null
    }
    if (detail.roleCode === 'VIEWER' && ordered.length > 0) {
      const text = '只读成员不能提交画布内容修改，请刷新后重试'
      markSaveError(text)
      throw new Error(text)
    }
    const deleteIds = new Set(deletes.map((item) => item.objectId))
    markSaving()
    try {
      if (!currentSceneScope()) throw new Error('画布或身份已切换，未提交本次修改')

      // Use one graph and scene snapshot throughout this save. Edits arriving during
      // asset registration or requests stay dirty for the next queued save.
      const actorId = useUserStore.getState().user?.id ?? ownUserIdRef.current
      const scenePlan = !flushCanvasBeforeAdoption && canvasProjectCanEdit(detail.roleCode) ? await prepareCanvasDirectorSceneWrite({
        workspaceId, workspace, objects: serialized,
        baseline: baseObjects.values(), snapshot: baseSnapshot,
        owner: actorId != null ? 'user:' + actorId : undefined, resources: Array.from(resourcesRef.current.values()),
        current: currentSceneScope
      }) : undefined
      const recovered = scenePlan?.recovered
      if (!currentSceneScope()) throw new Error('画布或身份已切换，未提交本次修改')
      if (recovered && Object.keys(recovered).length) useStudioUiStore.setState(state => ({
        directorScenes: { ...recovered, ...state.directorScenes }
      }))
      const write = scenePlan?.write
      const sceneWrite = write ? { expectedVersion: write.expectedVersion, document: write.document, adoption } : undefined
      if (adoption && !write) throw new Error('未找到待采纳的场景修改，请重新读取场景')
      if (sceneWrite && baseSnapshot?.atomicSceneCommit !== true) {
        throw new Error('当前服务端尚未支持3D预演原子保存，场景修改仍保留在本机')
      }
      const sessionId = ordered.length > 0 || sceneWrite ? await waitForSession() : sessionIdRef.current
      for (const batch of sceneWrite ? [ordered] : chunks(ordered, 50)) {
        if (baselineRef.current !== baseObjects) throw new Error('画布节点版本已刷新，请重新保存')
        const saveLease = batch.length ? await editLeasesRef.current.acquire(workspaceId, sessionId, batch.map((item) => item.objectId)) : undefined
        const locks = saveLease?.locks ?? []
        const tokenById = new Map(locks.map((lock) => [lock.objectId, lock.lockToken]))
        const mutations: CanvasMutation[] = batch.map((item) => {
          const before = baselineRef.current.get(item.objectId)
          const deleting = deleteIds.has(item.objectId)
          return {
            objectId: item.objectId,
            objectType: item.objectType,
            action: deleting ? 'DELETE' : 'UPSERT',
            expectedVersion: before?.version || 0,
            lockToken: tokenById.get(item.objectId) || '',
            ...(deleting ? {} : { payload: item.payload })
          }
        })
        const fingerprint = stableCanvasJson({
          mutations: mutations.map(({ objectId, objectType, action, expectedVersion, payload }) => ({
            objectId, objectType, action, expectedVersion, payload
          })),
          sceneWrite
        })
        const operationId = adoption
          ? 'adopt_' + Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
            new TextEncoder().encode(JSON.stringify([adoption.sceneId, adoption.projectId, adoption.stepId])))),
          byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 58)
          : saveRequestKeysRef.current.get(fingerprint) || canvasOperationId('mutate')
        saveRequestKeysRef.current.set(fingerprint, operationId)
        ownOperationIdsRef.current.add(operationId)
        try {
          if (!currentSceneScope()) throw new Error('画布或身份已切换，未提交本次修改')
          if (baselineRef.current !== baseObjects) throw new Error('画布节点版本已刷新，请重新保存')
          const result = await canvasWorkspaceMutate({ workspaceId, operationId, sessionId, mutations, sceneWrite })
          if (adoption && result.adoptionReplay === true) {
            const current = result.adoptionDocument as CanvasSceneDocument | undefined
            if (!write || !current || !sameAdoptionScene(write.document, current, adoption.sceneId)
                || !currentSceneScope() || useStudioUiStore.getState().dirtyRevision !== localRevision) {
              throw new Error('结果已在另一窗口采纳。当前草稿已保留，请核对后重新打开场景')
            }
            saveRequestKeysRef.current.delete(fingerprint)
            await clearCanvasDirectorCheckpoints(write.checkpoints)
            if (!currentSceneScope() || useStudioUiStore.getState().dirtyRevision !== localRevision) {
              throw new Error('采纳已保存。核对回执期间又有修改，当前草稿已保留')
            }
            markSaved(new Date().toISOString(), localRevision)
            await applyAuthoritativeSnapshot(detail, true)
            settleAdoption()
            return
          }
          if (!currentSceneScope() || baselineRef.current !== baseObjects) throw new Error('画布或节点版本已变化，请重新读取后保存')
          if (sceneWrite && result.sceneVersion == null) throw new Error('提交回执缺少场景版本，请重新读取核对')
          saveRequestKeysRef.current.delete(fingerprint)
          eventSeqRef.current = Math.max(eventSeqRef.current, Number(result.eventSeq) || 0)
          for (const object of result.objects || []) {
            const id = String(object.objectId)
            if (object.deleted || !object.content) baselineRef.current.delete(id)
            else baselineRef.current.set(id, {
              objectId: id,
              objectType: object.objectType,
              payload: serverBaseline([object], snapshotRef.current).get(id)!.payload,
              version: Number(object.objectVersion) || 1
            })
          }
          if (write && baseSnapshot && result.sceneVersion != null) {
            baseSnapshot.sceneDocument = write.document
            baseSnapshot.sceneVersion = result.sceneVersion
            await clearCanvasDirectorCheckpoints(write.checkpoints)
          }
          if (batch.length || sceneWrite) {
            undoStackRef.current.push({ operationId: String(result.adoptionOperationId ?? operationId), objectIds: batch.map((item) => item.objectId) })
            setUndoAvailable(true)
          }
          settleAdoption()
        } finally {
          await saveLease?.release().catch(() => undefined)
        }
      }
      if (flushCanvasBeforeAdoption) {
        // Save graph edits without publishing the generated scene or clearing its receipt.
        // Then adopt against the acknowledged graph baseline using the existing scene CAS.
        await performSave()
        return
      }
      try {
        if (!currentSceneScope()) throw new Error('画布或身份已切换，未提交场景修改')
        const viewResult = await saveCanvasPersonalView({
          view: serializeCanvasPersonalView(workspace.viewport),
          version: viewVersionRef.current,
          savedView: savedPersonalViewRef.current,
          save: (expectedVersion, view) => canvasWorkspaceViewSave({ workspaceId, expectedVersion, view }),
          load: () => canvasWorkspaceViewLoad(workspaceId)
        })
        viewVersionRef.current = viewResult.viewVersion
        savedPersonalViewRef.current = viewResult.view
      } catch (error) {
        if (error instanceof CanvasPersonalViewSaveConflictError) {
          viewVersionRef.current = error.currentVersion
          savedPersonalViewRef.current = error.currentView
        }
        throw error
      }
      if (!currentSceneScope()) throw new Error('画布或身份已切换')
      markSaved(new Date().toISOString(), localRevision)
      if (pendingAuthoritativeReloadRef.current && projectRef.current) {
        pendingAuthoritativeReloadRef.current = false
        try {
          await applyAuthoritativeSnapshot(projectRef.current, true)
        } catch {
          pendingAuthoritativeReloadRef.current = true
        }
      }
    } catch (error: unknown) {
      const text = apiErrorMessage(error, '画布保存失败，请刷新后重试')
      if (currentSceneScope()) markSaveError(text)
      throw error
    }
  }, [applyAuthoritativeSnapshot, enabled, markSaveError, markSaved, markSaving, scopeKey, taskOwnedNodeIds, waitForSession])

  const saveNow = useCallback((adoption?: CanvasSceneAdoption) => {
    const pending = pendingSceneAdoptionRef.current
    if (adoption && pending?.scope === scopeKey && stableCanvasJson(adoption) !== stableCanvasJson(pending.adoption)) {
      return Promise.reject(new Error('请先完成上一次场景采纳，当前结果已保留'))
    }
    if (adoption && pending?.scope !== scopeKey) pendingSceneAdoptionRef.current = { scope: scopeKey, adoption }
    return saveQueueRef.current.run(performSave)
  }, [performSave, scopeKey])

  const deleteNodes = useCallback((nodeIds: string[]): Promise<void> => {
    if (structuralPromiseRef.current) {
      return Promise.reject(new Error('另一项画布结构操作正在进行，请稍后重试'))
    }
    structuralUndoBaselineRef.current = undoStackRef.current.at(-1)?.operationId
    const promise = (async () => {
      const detail = projectRef.current
      const workspaceId = workspaceIdRef.current
      if (!detail || !workspaceId || detail.roleCode === 'VIEWER') {
        throw new Error('当前画布暂时不能删除节点')
      }
      const state = useStudioUiStore.getState()
      if (state.scopeKey !== scopeKey) throw new Error('画布已切换，请重新删除')
      const existingIds = new Set(state.nodes.map((node) => node.id))
      const targets = [...new Set(nodeIds)].filter((nodeId) => existingIds.has(nodeId))
      if (!targets.length) return
      const targetIds = new Set(targets)

      // 删除活跃生成节点前先读取服务端权威任务。服务端会拒绝为活跃任务节点
      // 发编辑租约，因此可取消的排队任务必须先终止并完成绑定收口。
      const active = await canvasWorkspaceActiveTasks(workspaceId)
      if (workspaceIdRef.current !== workspaceId || stoppedRef.current) throw new Error('画布已切换，请重新删除')
      activeTaskNodeIdsRef.current = new Set(active.items
        .filter((item) => item.objectId != null)
        .map((item) => String(item.objectId)))
      const targetTasks = active.items.filter((task) => task.objectId != null
        && targetIds.has(String(task.objectId)))
      const blocked = targetTasks.find((task) => task.sourceType === 'RUNTIME_RUN'
        || String(task.status || '').toUpperCase() !== 'QUEUED'
        || task.taskId == null
        || task.canCancel !== true)
      if (blocked) {
        const node = state.nodes.find((item) => item.id === String(blocked.objectId))
        const title = node?.data.title ? `“${node.data.title}”` : '所选节点'
        if (blocked.sourceType === 'RUNTIME_RUN') {
          throw new Error(`${title}的 Agent 或 Skill 仍在运行，请先停止运行或等待结束后再删除`)
        }
        if (String(blocked.status || '').toUpperCase() !== 'QUEUED') {
          throw new Error(`${title}的生成任务已开始执行，请等待任务结束后再删除`)
        }
        throw new Error(`${title}的排队任务当前不可取消，请稍后重试或由任务发起人停止任务`)
      }

      for (const task of targetTasks) {
        await userTaskCancel({ taskId: String(task.taskId), taskSource: 'MEDIA' })
      }
      if (targetTasks.length > 0) {
        const refreshed = await canvasWorkspaceActiveTasks(workspaceId)
        if (workspaceIdRef.current !== workspaceId || stoppedRef.current) throw new Error('画布已切换，请重新删除')
        activeTaskNodeIdsRef.current = new Set(refreshed.items
          .filter((item) => item.objectId != null)
          .map((item) => String(item.objectId)))
        if (refreshed.items.some((task) => task.objectId != null && targetIds.has(String(task.objectId)))) {
          throw new Error('排队任务的取消状态尚未同步，请稍后重试删除')
        }
      }

      const serverActiveIds = new Set(targetTasks.map((task) => String(task.objectId)))
      const localBusy = targets.some((nodeId) => !serverActiveIds.has(nodeId)
        && (reservedGenerationNodeIdsRef.current.has(nodeId)
          || generationPromisesRef.current.has(nodeId)
          || [...pendingTerminalResultsRef.current.values()].some((pending) => pending.nodeId === nodeId)))
      if (localBusy) throw new Error('生成任务正在提交或同步结果，请等待状态确认后再删除')

      targets.forEach((nodeId) => deletingNodeIdsRef.current.add(nodeId))
      try {
        const current = useStudioUiStore.getState()
        if (current.scopeKey !== scopeKey) throw new Error('画布已切换，请重新删除')
        current.deleteNodes(targets)
        await saveNow()
      } finally {
        targets.forEach((nodeId) => deletingNodeIdsRef.current.delete(nodeId))
      }
    })()
    structuralPromiseRef.current = promise
    void promise.finally(() => {
      if (structuralPromiseRef.current === promise) structuralPromiseRef.current = null
    }).catch(() => undefined)
    return promise
  }, [saveNow, scopeKey])

  const copyNodes = useCallback((nodeIds: string[]): Promise<void> => {
    if (structuralPromiseRef.current) return structuralPromiseRef.current
    structuralUndoBaselineRef.current = undoStackRef.current.at(-1)?.operationId
    const promise = (async () => {
      const detail = projectRef.current
      const workspaceId = workspaceIdRef.current
      if (!detail || !workspaceId || detail.roleCode === 'VIEWER' || !sessionIdRef.current) {
        throw new Error('当前画布暂时不能复制节点')
      }
      await saveNow()
      const selected = new Set(nodeIds.filter((id) => baselineRef.current.get(id)?.objectType === 'NODE'))
      const { nodes, directorScenes } = useStudioUiStore.getState()
      if (nodes.some(({ id, data }) => selected.has(id) && data.kind === 'director'
        && (!data.directorSceneId || !Object.hasOwn(directorScenes, data.directorSceneId)))) {
        throw new Error('所选3D预演节点的场景尚未恢复，暂不能复制')
      }
      const relatedEdges = Array.from(baselineRef.current.values())
        .filter((item) => item.objectType === 'EDGE'
          && selected.has(String(item.payload.sourceObjectId || ''))
          && selected.has(String(item.payload.targetObjectId || '')))
        .map((item) => item.objectId)
      const sourceIds = [...selected, ...relatedEdges]
      if (!sourceIds.length) throw new Error('请先选择要复制的节点')
      if (sourceIds.length > 100) throw new Error('一次最多复制 100 个节点和连线')
      const sources = sourceIds.map((id) => ({ sourceObjectId: id, expectedVersion: baselineRef.current.get(id)!.version }))
      const fingerprint = stableCanvasJson(sources)
      const operationId = copyRequestKeysRef.current.get(fingerprint) || canvasOperationId('copy')
      copyRequestKeysRef.current.set(fingerprint, operationId)
      const result = await canvasWorkspaceCopy({
        workspaceId,
        operationId,
        sources
      })
      copyRequestKeysRef.current.delete(fingerprint)
      ownOperationIdsRef.current.add(operationId)
      const copiedIds = Object.values(result.idMap || {}).map(String)
      if (copiedIds.length) {
        undoStackRef.current.push({ operationId, objectIds: copiedIds })
        setUndoAvailable(true)
      }
      try {
        await applyAuthoritativeSnapshot(detail, true)
        const copiedNodeIds = nodeIds.map((id) => result.idMap?.[id]).filter((id): id is string => Boolean(id))
        if (copiedNodeIds.length) useStudioUiStore.getState().selectNodes(copiedNodeIds)
      } catch {
        pendingAuthoritativeReloadRef.current = true
        antdMessage.warning('复制已提交，画布刷新暂时失败，请稍后刷新')
      }
    })()
    structuralPromiseRef.current = promise
    void promise.finally(() => { if (structuralPromiseRef.current === promise) structuralPromiseRef.current = null }).catch(() => undefined)
    return promise
  }, [applyAuthoritativeSnapshot, saveNow])

  const undoLast = useCallback((id?: string): Promise<void> => {
    if (pendingUndoRef.current) return pendingUndoRef.current
    const preceding = structuralPromiseRef.current
    const previousTop = structuralUndoBaselineRef.current
    const requestedWorkspace = workspaceIdRef.current
    const promise = Promise.resolve(preceding).then(async () => {
      if (stoppedRef.current || workspaceIdRef.current !== requestedWorkspace || useStudioUiStore.getState().scopeKey !== scopeKey) {
        throw new Error('画布已切换，请重新撤销')
      }
      const detail = projectRef.current
      const workspaceId = workspaceIdRef.current
      const sessionId = sessionIdRef.current
      const target = undoStackRef.current.at(-1)
      if (!detail || !workspaceId || !sessionId || detail.roleCode === 'VIEWER') throw new Error('当前画布暂时不能撤销')
      if (!target || (id && target.operationId !== id) || (preceding && target.operationId === previousTop)) {
        throw new Error('没有可撤销的已保存操作')
      }
      if (useStudioUiStore.getState().dirtyRevision > 0) throw new Error('请先处理未保存的本地修改')
      const lease = target.objectIds.length ? await editLeasesRef.current.acquire(workspaceId, sessionId, target.objectIds) : undefined
      const locks = lease?.locks ?? []
      const operationId = undoRequestKeysRef.current.get(target.operationId) || canvasOperationId('undo')
      undoRequestKeysRef.current.set(target.operationId, operationId)
      try {
        await canvasWorkspaceUndo({
          workspaceId,
          operationId,
          targetOperationId: target.operationId,
          sessionId,
          locks
        })
        undoRequestKeysRef.current.delete(target.operationId)
        undoStackRef.current.pop()
        setUndoAvailable(undoStackRef.current.length > 0)
        try {
          await applyAuthoritativeSnapshot(detail, true)
        } catch {
          pendingAuthoritativeReloadRef.current = true
          antdMessage.warning('撤销已提交，画布刷新暂时失败，请稍后刷新')
        }
      } finally {
        await lease?.release().catch(() => undefined)
      }
    })
    pendingUndoRef.current = promise
    structuralPromiseRef.current = promise
    void promise.finally(() => {
      if (pendingUndoRef.current === promise) pendingUndoRef.current = null
      if (structuralPromiseRef.current === promise) structuralPromiseRef.current = null
    }).catch(() => undefined)
    return promise
  }, [applyAuthoritativeSnapshot, scopeKey])

  const loadDrafts = useCallback(async (): Promise<CanvasDraft[]> => {
    if (!workspaceIdRef.current) return []
    return (await canvasWorkspaceDraftList(workspaceIdRef.current)).items || []
  }, [])

  const saveNodeDraft = useCallback(async (nodeId: string, existingDraftVersion: number): Promise<CanvasDraft> => {
    const object = baselineRef.current.get(nodeId)
    const node = useStudioUiStore.getState().nodes.find((item) => item.id === nodeId)
    if (!workspaceIdRef.current || projectRef.current?.roleCode === 'VIEWER' || !object || !node) {
      throw new Error('当前节点不能保存个人草稿')
    }
    return canvasWorkspaceDraftSave({
      workspaceId: workspaceIdRef.current,
      objectId: nodeId,
      expectedDraftVersion: existingDraftVersion,
      baseObjectVersion: object.version,
      payload: { prompt: node.data.prompt || '', documentContent: node.data.documentContent || '' }
    })
  }, [])

  const deleteNodeDraft = useCallback(async (nodeId: string, draftVersion: number): Promise<void> => {
    if (!workspaceIdRef.current) throw new Error('工作区尚未载入')
    await canvasWorkspaceDraftDelete({ workspaceId: workspaceIdRef.current, objectId: nodeId, expectedDraftVersion: draftVersion })
  }, [])

  const applyNodeDraft = useCallback((draft: CanvasDraft, acceptStale = false) => {
    const nodeId = String(draft.objectId)
    const object = baselineRef.current.get(nodeId)
    const payload = draft.payload && typeof draft.payload === 'object' && !Array.isArray(draft.payload)
      ? draft.payload as Record<string, unknown> : null
    if (!object || !payload || ((draft.stale || object.version !== draft.baseObjectVersion) && !acceptStale)) {
      throw new Error('共享节点已变化，请先比较草稿与当前内容')
    }
    useStudioUiStore.getState().updateNodeData(nodeId, {
      prompt: typeof payload.prompt === 'string' ? payload.prompt : '',
      documentContent: typeof payload.documentContent === 'string' ? payload.documentContent : ''
    })
    useStudioUiStore.getState().selectNodes([nodeId])
  }, [])

  const nodeResources = useCallback((nodeId: string): CanvasResource[] => {
    const node = useStudioUiStore.getState().nodes.find((item) => item.id === nodeId)
    return [...new Set([...(node?.data.canvasPrimaryResourceId ? [node.data.canvasPrimaryResourceId] : []), ...(node?.data.canvasResourceIds || [])].map(String))]
      .map((id) => resourcesRef.current.get(String(id)))
      .filter((resource): resource is CanvasResource => Boolean(resource))
  }, [])
  const resourceById = useCallback((resourceId: string): CanvasResource | undefined => resourcesRef.current.get(String(resourceId)), [])

  const prepareGenerationQuote = useCallback<CanvasProjectWorkspaceRuntime['prepareGenerationQuote']>((kind, node, model, prompt, sessionId) => {
    const detail = projectRef.current
    const workspaceId = workspaceIdRef.current
    if (!detail || !workspaceId || stoppedRef.current) throw new Error('画布工作区尚未就绪，暂不可报价')
    const workspace = useStudioUiStore.getState()
    return buildStudioCanvasGenerationQuote({ kind, node, model, prompt, sessionId, snapshot: {
      projectId: String(detail.projectId), workspaceId, nodes: workspace.nodes, edges: workspace.edges,
      resource: id => resourcesRef.current.get(id), version: id => baselineRef.current.get(id)?.version
    } })
  }, [])

  const transferResource = useCallback((resourceId: string, assetName: string): Promise<void> => {
    const inFlight = transferPromisesRef.current.get(resourceId)
    if (inFlight) return inFlight
    const workspaceId = workspaceIdRef.current
    const resource = resourcesRef.current.get(resourceId)
    if (!workspaceId || !resource || projectRef.current?.roleCode === 'VIEWER') {
      return Promise.reject(new Error('当前素材不可转存'))
    }
    if (resource.mediaType !== 'IMAGE' && resource.mediaType !== 'VIDEO') {
      return Promise.reject(new Error('当前仅支持转存图片和视频素材'))
    }
    const name = assetName.slice(0, 100)
    const fingerprint = stableCanvasJson({ resourceId, assetName: name, targetCategory: resource.mediaType === 'IMAGE' ? 'file' : null })
    const operationId = transferRequestKeysRef.current.get(fingerprint) || canvasOperationId('transfer')
    transferRequestKeysRef.current.set(fingerprint, operationId)
    const promise = canvasResourceTransfer({
      workspaceId,
      resourceId,
      operationId,
      assetName: name,
      ...(resource.mediaType === 'IMAGE' ? { targetCategory: 'file' } : {})
    }).then(() => undefined)
    transferPromisesRef.current.set(resourceId, promise)
    void promise.finally(() => transferPromisesRef.current.delete(resourceId)).catch(() => undefined)
    return promise
  }, [])

  const generateNodeResult = useCallback((kind: UserGenerationKind, nodeId: string, prompt: string, generationOptions?: CanvasNodeGenerationOptions): Promise<CanvasNodeGenerationResult> => {
    void requestStudioDesktopNotificationPermission()
    const running = generationPromisesRef.current.get(nodeId)
    if (running) return running

    const holder: { promise?: Promise<CanvasNodeGenerationResult> } = {}
    const scopeKey = useStudioUiStore.getState().scopeKey
    let generationLease: CanvasNodeEditLease | null = null
    let leaseHandedOff = false
    let accepted = false
    const promise = (async (): Promise<CanvasNodeGenerationResult> => {
      const detail = projectRef.current
      const workspaceId = workspaceIdRef.current
      if (!detail || !workspaceId || detail.roleCode === 'VIEWER') {
        return { status: 'blocked', reason: '当前画布不可生成' }
      }
      if (!canUseFeature('canvas.generate')) {
        return { status: 'blocked', reason: '当前账号没有画布生成权限' }
      }
      if (!canUseFeature('canvas.collaborate')) {
        return { status: 'blocked', reason: '当前账号没有画布协作权限，无法建立生成会话' }
      }
      if (activeTaskNodeIdsRef.current.has(nodeId)) {
        return { status: 'blocked', reason: '该节点已有进行中的生成任务' }
      }
      const initialNode = useStudioUiStore.getState().nodes.find((item) => item.id === nodeId)
      if (!initialNode) throw new Error('目标节点不存在')
      const videoTool = generationOptions?.videoTool
      // Older portrait retries stored the empty provider prompt as the node draft.
      const legacyPortrait = videoTool?.operation === 'PORTRAIT_FOREGROUND' && videoTool.requestPrompt === undefined
      const nodePrompt = legacyPortrait ? initialNode.data.prompt : prompt
      const subjectEdit = videoTool ? stableCanvasJson(initialNode.data.videoSubjectEdit) : undefined
      useStudioUiStore.getState().updateNodeData(nodeId, {
        canvasGenerationRetry: {
          kind,
          prompt: nodePrompt,
          ...(initialNode.data.model ? { model: initialNode.data.model } : {}),
          ...(initialNode.data.negativePrompt ? { negativePrompt: initialNode.data.negativePrompt } : {}),
          ...(generationOptions ? { generationOptions: structuredClone(generationOptions) } : {})
        }
      })
      if (initialNode.data.prompt !== nodePrompt) {
        useStudioUiStore.getState().updateNodeData(nodeId, { prompt: nodePrompt })
      }
      updateCanvasNodeRuntime(scopeKey, nodeId, { status: 'queued', errorMessage: undefined })
      const sessionId = await waitForSession()
      if (workspaceIdRef.current !== workspaceId || stoppedRef.current) throw new Error('画布已切换，请重新发送')
      // Acquire the target before autosave. performSave reuses this lease, and the
      // generation endpoint later promotes the same token to a server task lock.
      generationLease = await editLeasesRef.current.acquire(workspaceId, sessionId, [nodeId])
      // Reserve the saved target before the next queued autosave can capture it.
      // The generation endpoint owns this exact input version until settlement.
      await saveQueueRef.current.run(performSave, () => reservedGenerationNodeIdsRef.current.set(nodeId, 'saved'))

      const node = useStudioUiStore.getState().nodes.find((item) => item.id === nodeId)
      const object = baselineRef.current.get(nodeId)
      if (!node || !object) throw new Error('请先保存目标节点后再生成')
      if (node.data.prompt !== nodePrompt || (videoTool && stableCanvasJson(node.data.videoSubjectEdit) !== subjectEdit)) {
        throw new Error('节点输入已变化，请重新发送')
      }
      const upscale = generationOptions?.imageUpscale
      const imageEdit = generationOptions?.imageEdit
      const imageDescribe = kind === 'text' ? node.data.imageDescribe : undefined
      if (imageDescribe && generationOptions?.sessionId) throw new Error('图片描述不使用文本续聊会话，请重新发送')
      const taskTitle = videoTool && node.data.kind === 'voice'
        ? '音频提取' : kind === 'audio' ? '音频生成' : kind === 'text' ? '文本生成' : kind === 'image' ? '图片生成' : '视频生成'
      if (videoTool && (kind !== 'video' || upscale || imageEdit || node.data.model !== videoTool.modelCode
        || node.data.videoToolOptions?.sourceNodeId !== videoTool.sourceNodeId)) {
        throw new Error('视频工具结果节点与源视频或所选模型不匹配')
      }
      if (imageEdit && (kind !== 'image' || upscale || node.data.model !== imageEdit.modelCode)) {
        throw new Error('图片编辑结果节点与所选模型不匹配')
      }
      if (upscale && (kind !== 'image' || node.data.imagePurpose !== 'hd'
        || node.data.imageToolOptions?.sourceNodeId !== upscale.sourceNodeId)) {
        throw new Error('高清结果节点与原图不匹配，请重新发起高清')
      }
      const noticeTask = {
        kind,
        nodeId,
        nodeTitle: node.data.title,
        prompt,
        projectName: detail.projectName,
        operation: upscale ? 'upscale' as const : 'generate' as const
      }
      const workspaceGraph = useStudioUiStore.getState()
      const videoGenerationRefs = kind === 'video' || kind === 'image'
        ? canvasVideoLinkedRefs({ node, nodes: workspaceGraph.nodes, edges: workspaceGraph.edges })
        : undefined
      const referenceNodeIds = videoGenerationRefs
        ? videoGenerationRefs.flatMap((item) => item.nodeId ? [item.nodeId] : [])
        : (node.data.composerRefs || []).flatMap((item) => item.nodeId ? [item.nodeId] : [])
      const inputNodeIds = [nodeId, ...(videoTool ? [videoTool.sourceNodeId] : imageDescribe ? [imageDescribe.sourceNodeId] : imageEdit ? [imageEdit.sourceNodeId] : upscale ? [upscale.sourceNodeId] : referenceNodeIds)]
      const runId = canvasOperationId('node_run')
      updateCanvasNodeRuntime(scopeKey, nodeId, { operationRunId: runId })
      const clearRun = () => {
        if (isStudioOperationRunCurrent(scopeKey, runId, [nodeId])) {
          updateCanvasNodeRuntime(scopeKey, nodeId, { operationRunId: undefined })
        }
      }
      const inputSnapshotHash = createStudioOperationInputHash(scopeKey, inputNodeIds)
      const live = () => workspaceIdRef.current === workspaceId
        && isStudioOperationRunCurrent(scopeKey, runId, [nodeId])
        && isStudioOperationInputCurrent(scopeKey, inputSnapshotHash, inputNodeIds)

      const mediaTypeForKind = (value: unknown): CanvasGenerationMediaType | undefined => {
        const normalized = String(value || '').toUpperCase()
        return ['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT'].includes(normalized)
          ? normalized as CanvasGenerationMediaType
          : undefined
      }
      const expectedMediaType = (value: unknown): CanvasGenerationMediaType | undefined => {
        if (value === 'image') return 'IMAGE'
        if (value === 'video') return 'VIDEO'
        if (value === 'audio') return 'AUDIO'
        if (value === 'text') return 'DOCUMENT'
        return undefined
      }
      const resourceFromNode = (source: typeof node, wanted?: CanvasGenerationMediaType) => {
        const ids = [
          String(source.data.canvasPrimaryResourceId || ''),
          ...(Array.isArray(source.data.canvasResourceIds) ? source.data.canvasResourceIds.map(String) : [])
        ]
        return [...new Set(ids)].find((id) => /^\d+$/.test(id) && id !== '0'
          && (!wanted || resourceMediaTypeRef.current.get(id) === wanted)
          && (!source.data.mediaUrl || canvasResourceMatchesNodeMedia(resourcesRef.current.get(id), source.data)))
      }
      const registerTaskResult = async (source: typeof node, wanted?: CanvasGenerationMediaType) => {
        const selectedResultId = String(source.data.canvasCurrentResultId || '')
        if (/^\d+$/.test(selectedResultId) && selectedResultId !== '0') {
          const selected = await canvasResourceRegister({ workspaceId, sourceType: 'MEDIA_RESULT', sourceId: selectedResultId })
          if ((!wanted || selected.mediaType === wanted) && canvasResourceMatchesNodeMedia(selected, source.data)) {
            resourcesRef.current.set(String(selected.resourceId), selected)
            resourceMediaTypeRef.current.set(String(selected.resourceId), selected.mediaType)
            return String(selected.resourceId)
          }
        }
        const sourceTaskId = String(source.data.canvasCurrentTaskId || '')
        if (!/^\d+$/.test(sourceTaskId) || sourceTaskId === '0') return undefined
        const resource = await canvasResourceRegister({ workspaceId, sourceType: 'MEDIA_TASK', sourceId: sourceTaskId })
        resourcesRef.current.set(String(resource.resourceId), resource)
        const resourceId = String(resource.resourceId)
        resourceMediaTypeRef.current.set(resourceId, resource.mediaType)
        if ((!wanted || resource.mediaType === wanted) && canvasResourceMatchesNodeMedia(resource, source.data)) {
          return resourceId
        }
        return undefined
      }

      const candidates: CanvasGenerationReferenceCandidate[] = []
      if (kind === 'image' && node.data.mediaUrl && !upscale) {
        const currentResourceId = resourceFromNode(node, 'IMAGE') ?? await registerTaskResult(node, 'IMAGE').catch(() => undefined)
        if (currentResourceId) candidates.push({
          resourceId: currentResourceId,
          title: '当前图片',
          mediaType: 'IMAGE',
          role: 'REFERENCE'
        })
      }

      const allNodes = useStudioUiStore.getState().nodes
      if (imageDescribe) {
        const source = allNodes.find(item => item.id === imageDescribe.sourceNodeId)
        if (source?.data.kind !== 'image' || !source.data.mediaUrl) throw new Error('原图已失效，请重新选择图片')
        const resourceId = resourceFromNode(source, 'IMAGE') ?? await registerTaskResult(source, 'IMAGE')
        if (!resourceId) throw new Error('原图未登记为当前工作区图片素材，请重新上传或生成')
        candidates.push({ resourceId, title: '原图', mediaType: 'IMAGE', role: 'REFERENCE' })
      }
      if (upscale) {
        const source = allNodes.find((item) => item.id === upscale.sourceNodeId)
        if (!source?.data.mediaUrl || source.data.kind !== 'image') throw new Error('原图节点已失效，请重新发起高清')
        const resourceId = resourceFromNode(source, 'IMAGE') ?? await registerTaskResult(source, 'IMAGE')
        if (!resourceId) throw new Error('原图未登记为当前工作区图片素材，请重新上传或生成原图')
        candidates.push({ resourceId, title: '原图', mediaType: 'IMAGE', role: 'REFERENCE' })
      }
      const textNodeCandidates: Array<{ objectId: string; expectedVersion: number; title: string }> = []
      let imageEditSourceResourceId: string | undefined
      let videoToolSourceResourceId: string | undefined
      let videoToolSourceVersion: number | undefined
      if (imageEdit) {
        const source = allNodes.find((item) => item.id === imageEdit.sourceNodeId)
        if (source?.data.kind !== 'image' || !source.data.mediaUrl) throw new Error('图片编辑原图已失效')
        imageEditSourceResourceId = resourceFromNode(source, 'IMAGE') ?? await registerTaskResult(source, 'IMAGE')
        if (!imageEditSourceResourceId) throw new Error('原图未登记为当前工作区图片素材')
        if (imageEdit.funcCode === 'canvas.image.layer_split') {
          const sourceObject = baselineRef.current.get(source.id)
          if (imageEdit.imageEdit.sourceObjectId !== source.id
            || imageEdit.imageEdit.sourceExpectedVersion !== sourceObject?.version
            || imageEdit.sourceResourceId !== imageEditSourceResourceId) {
            throw new Error('原图资源或节点版本已变化，请重新报价')
          }
        }
      }
      if (videoTool) {
        const source = allNodes.find((item) => item.id === videoTool.sourceNodeId)
        if (source?.data.kind !== 'video' || !source.data.mediaUrl) throw new Error('源视频节点已失效')
        videoToolSourceVersion = baselineRef.current.get(source.id)?.version
        if (!videoToolSourceVersion) throw new Error('源视频节点尚未保存')
        videoToolSourceResourceId = resourceFromNode(source, 'VIDEO') ?? await registerTaskResult(source, 'VIDEO')
        if (!videoToolSourceResourceId) throw new Error('源视频未登记为当前工作区资源')
        if ((videoTool.sourceExpectedVersion != null && videoTool.sourceExpectedVersion !== videoToolSourceVersion)
          || (videoTool.sourceResourceId != null && videoTool.sourceResourceId !== videoToolSourceResourceId)) {
          throw new Error('源视频已变化，请重新报价')
        }
        candidates.push({ resourceId: videoToolSourceResourceId, title: '源视频', mediaType: 'VIDEO', role: 'REFERENCE' })
        for (const imageId of videoTool.referenceImageResourceIds ?? []) {
          if (resourceMediaTypeRef.current.get(imageId) !== 'IMAGE'
            || !resourcesRef.current.has(imageId)) throw new Error('主体替换参考图未登记在当前画布')
          candidates.push({ resourceId: imageId, title: '主体替换参考图', mediaType: 'IMAGE', role: 'REFERENCE' })
        }
      }
      const generationRefs = videoTool || imageDescribe ? [] : (videoGenerationRefs ?? node.data.composerRefs ?? [])
      for (const ref of upscale || imageEdit ? [] : generationRefs) {
        if (ref.kind === 'library' && ref.mediaKind === 'text') continue
        if (ref.inputError) throw new Error(ref.inputError)
        if (!(ref.mediaKind === 'text' && ref.nodeId)) assertCanvasReferenceTransport(kind, ref.mediaKind.toUpperCase(), ref.title)
        if (ref.nodeId && ref.mediaKind === 'text') {
          const source = allNodes.find((item) => item.id === ref.nodeId)
          const sourceObject = baselineRef.current.get(ref.nodeId)
          if (!source || source.data.kind !== 'text' || !sourceObject) {
            throw new Error(`文本引用「${ref.title}」已失效，请重新选择`)
          }
          textNodeCandidates.push({ objectId: ref.nodeId, expectedVersion: sourceObject.version, title: ref.title })
          continue
        }
        const wanted = expectedMediaType(ref.mediaKind)
        const directId = ref.kind === 'asset' || ref.kind === 'library' ? '' : String(ref.assetId || '')
        let resourceId = /^\d+$/.test(directId) && directId !== '0'
          && resourceMediaTypeRef.current.has(directId)
          ? directId
          : undefined
        const source = ref.nodeId ? allNodes.find((item) => item.id === ref.nodeId) : undefined
        if (!resourceId && source) {
          resourceId = resourceFromNode(source, wanted)
            ?? await registerTaskResult(source, wanted).catch(() => undefined)
        }
        const mediaType = resourceId
          ? mediaTypeForKind(resourceMediaTypeRef.current.get(resourceId))
          : undefined
        if (!resourceId || !mediaType || wanted && mediaType !== wanted) {
          throw new Error(`引用「${ref.title}」已失效，请重新选择后报价`)
        }
        const role = canvasGenerationReferenceRole(kind, node, ref, mediaType)
        candidates.push({ resourceId, title: ref.title, mediaType, role })
      }

      const prepared = buildCanvasGenerationReferences({
        kind, prompt: videoTool?.requestPrompt ?? (legacyPortrait ? '' : prompt), candidates
      })
      if (new Set(textNodeCandidates.map(item => item.objectId)).size > 20) throw new Error('文本节点引用不能超过20个')
      const textNodes = textNodeCandidates.length
        ? buildCanvasTextNodeReferences({
            prompt: prepared.prompt,
            candidates: textNodeCandidates,
            usedMentions: prepared.references.map((reference) => reference.mention)
          })
        : undefined
      const resolvedPrompt = textNodes?.prompt ?? prepared.prompt
      let capabilityCode: string | undefined
      let generationModel: UserModelListItem | undefined
      if (kind === 'image' || kind === 'video') {
        const submittedResourceIds = new Set(prepared.references.map((reference) => reference.resourceId))
        const hasImageReference = candidates.some((candidate) => candidate.mediaType === 'IMAGE' && submittedResourceIds.has(candidate.resourceId))
        const ordinaryVideo = kind === 'video' && !videoTool && !upscale && !imageEdit
        const businessFuncCode = ordinaryVideo ? 'canvas.video.generate' : imageEdit?.funcCode ?? videoTool?.funcCode
        const listed = businessFuncCode
          ? (await canvasUserModelListByFuncCodes([businessFuncCode], ordinaryVideo ? undefined : String(detail.projectId)))
              .find((group) => group.funcCode === businessFuncCode)?.models ?? []
          : await canvasUserModelList({
              modelType: kind,
              generateMode: upscale ? 'image_upscale' : canvasGenerationCapability(kind, hasImageReference)
            })
        const models = ordinaryVideo ? canvasOrdinaryVideoModels(listed) : listed
        const selected = models.find((model) => model.modelCode === node.data.model)
        const requiredCapability = imageEdit?.capabilityCode ?? videoTool?.capabilityCode ?? (upscale ? 'image_upscale'
          : kind === 'video' ? resolveCanvasVideoCapability({
            node,
            model: selected,
            links: canvasVideoNodeLinks(videoGenerationRefs ?? node.data.composerRefs ?? [])
          })
          : canvasGenerationCapability(kind, hasImageReference))
        if (ordinaryVideo) prepareCanvasVideoGenerationReferences(requiredCapability, selected, prepared.references, candidates)
        if (kind === 'image' && !imageEdit && !upscale) {
          validateCanvasGenerationReferenceLimits(selected, requiredCapability, prepared.references, candidates)
        }
        generationModel = selected && ordinaryVideo ? modelForCapability(selected, requiredCapability) ?? selected : selected
        if (imageEdit && !modelSupportsCapability(selected, requiredCapability)) {
          throw new Error('所选模型不在当前图片工具的可用能力中，请重新选择')
        }
        if (videoTool && !modelSupportsCapability(selected, requiredCapability)) {
          throw new Error('所选模型不在当前视频工具的可用能力中，请重新选择')
        }
        if (upscale && (upscale.modelCode !== node.data.model || prepared.references.length !== 1 || !selected)) {
          throw new Error('高清型号或原图资源已变化，请重新确认')
        }
        if (!modelSupportsCapability(selected, requiredCapability)) {
          const modeName = kind === 'image'
            ? (requiredCapability === 'text_to_image' ? '纯文本' : '图片参考')
            : canvasVideoCapabilityLabel(requiredCapability)
          throw new Error(`当前${kind === 'image' ? '图片' : '视频'}模型不支持${modeName}生成，请选择匹配的模型`)
        }
        capabilityCode = requiredCapability
        if (upscale) {
          if (capabilityCode !== 'image_upscale') throw new Error('所选型号未声明图片高清能力')
          const width = upscale.sourceWidth * upscale.scale
          const height = upscale.sourceHeight * upscale.scale
          const maxPixels = selected.capability?.maxOutputPixels
          if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1
            || width > 32000 || height > 32000
            || (typeof maxPixels === 'number' && maxPixels > 0 && width * height > maxPixels)) {
            throw new Error('目标尺寸超过所选高清型号的能力范围')
          }
        }
      } else {
        const models = imageDescribe
          ? (await canvasUserModelListByFuncCodes(['canvas.text.image_describe'], String(detail.projectId)))
              .find(group => group.funcCode === 'canvas.text.image_describe')?.models ?? []
          : kind === 'audio'
          ? (await canvasUserModelListByFuncCodes(['canvas.audio.generate'], String(detail.projectId))).find(group => group.funcCode === 'canvas.audio.generate')?.models ?? []
          : await canvasUserModelList({ modelType: 'text' })
        const selected = models.find((model) => model.modelCode === node.data.model)
        generationModel = selected
        if (!selected) throw new Error(kind === 'audio' ? '当前音频模型不可用，请重新选择' : '当前文本模型不可用，请重新选择')
        if (kind === 'audio') {
          const code = node.data.generationOptions?.audioCapability || selected.capabilityCode
          const cap = selected.availableCapabilities?.find(item => item.code === code)
          if (!cap?.audio) throw new Error('请选择业务开放的音频能力')
          generationModel = { ...selected, capabilityCode: cap.code, audio: cap.audio, billing: cap.billing }
          const values = audioParametersWithPrompt(cap.audio, audioParametersWithFiles(node.data.generationOptions?.audioParameters ?? {}, node.data.generationOptions?.audioFiles, id => resourcesRef.current.get(id)?.resourceUrl), prompt)
          if (Object.keys(audioParameterErrors(cap.audio, values)).length) throw new Error('请完善音频参数')
          capabilityCode = cap.code
        } else {
          capabilityCode = selected.capabilityCode || undefined
          validateCanvasGenerationReferenceLimits(selected, capabilityCode ?? '', prepared.references, candidates)
        }
      }
      if (kind === 'audio') {
        for (const id of node.data.generationOptions?.audioResourceIds ?? []) {
          if (!prepared.references.some(item => item.resourceId === id)) prepared.references.push({ resourceId: id, mention: `audio_${prepared.references.length + 1}`, role: 'REFERENCE' })
        }
      }
      const fingerprint = stableCanvasJson({
        kind,
        projectId: detail.projectId,
        workspaceId,
        expectedVersion: object.version,
        prompt: resolvedPrompt,
        model: node.data.model,
        capabilityCode,
        imageDescribe,
        negativePrompt: node.data.negativePrompt,
        generationOptions: node.data.generationOptions,
        imageUpscale: upscale,
        imageEdit: imageEdit ? { ...imageEdit, sourceResourceId: imageEditSourceResourceId } : undefined,
        videoTool: videoTool ? { ...videoTool, sourceResourceId: videoToolSourceResourceId,
          sourceVersion: videoToolSourceVersion } : undefined,
        references: prepared.references,
        nodeReferences: textNodes?.nodeReferences,
        sessionId: kind === 'text' ? generationOptions?.sessionId : undefined
      })
      const generationScope = `generate:${workspaceId}:${nodeId}`
      const ledgerRequestId = canvasRetryLedger.getOrCreate(generationScope, fingerprint, () => canvasOperationId(`generate_${kind}`))
      const clientRequestId = imageEdit || upscale || videoTool ? ledgerRequestId.replaceAll('_', '-') : ledgerRequestId
      let taskId = ''
      let terminalSucceeded = false
      let terminalFailed = false
      let lockToken = ''
      const handoffGenerationLease = async () => {
        await generationLease?.handoff()
        leaseHandedOff = true
      }
      try {
        const lock = generationLease?.locks[0]
        if (!lock?.lockToken) throw new Error('未取得节点编辑租约')
        lockToken = lock.lockToken
        ownOperationIdsRef.current.add(clientRequestId)
        const ordinaryRequest = buildCanvasGenerationRequest({
          kind,
          projectId: String(detail.projectId),
          workspaceId,
          clientRequestId,
          canvasNode: {
            objectId: nodeId,
            expectedVersion: object.version,
            editSessionId: sessionId,
            lockToken
          },
          prompt: resolvedPrompt,
          node,
          model: generationModel,
          references: prepared.references,
          nodeReferences: textNodes?.nodeReferences,
          session: kind === 'text'
            ? generationOptions?.sessionId
              ? { sessionId: generationOptions.sessionId }
              : { title: node.data.title || '文本讨论' }
            : undefined,
          capabilityCode
        })
        const requestBody = kind === 'audio' ? {
          workspaceId, objectId: nodeId, expectedVersion: object.version, sessionId, lockToken,
          operationId: clientRequestId,
          resourceIds: prepared.references.map(reference => reference.resourceId),
          request: {
            modelCode: node.data.model!, capabilityCode: capabilityCode!,
            parameters: audioParametersWithPrompt(generationModel!.audio!, audioParametersWithFiles(node.data.generationOptions?.audioParameters ?? {}, node.data.generationOptions?.audioFiles, id => resourcesRef.current.get(id)?.resourceUrl), prompt)
          }
        } : videoTool ? {
          workspaceId,
          objectId: nodeId,
          expectedVersion: object.version,
          sessionId,
          lockToken,
          operationId: clientRequestId,
            resourceIds: prepared.references.map((reference) => reference.resourceId),
          videoTool: {
            operation: videoTool.operation,
            sourceObjectId: videoTool.sourceNodeId,
            sourceExpectedVersion: videoToolSourceVersion!,
            sourceResourceId: videoToolSourceResourceId!
          },
          request: {
            modelName: videoTool.modelCode,
            capabilityCode: videoTool.capabilityCode,
            prompt: resolvedPrompt,
            ...(videoTool.durationSeconds != null ? { durationSeconds: videoTool.durationSeconds } : {}),
            ...(videoTool.aspectRatio ? { aspectRatio: videoTool.aspectRatio } : {}),
            options: videoTool.parameters ?? {}
          }
        } : imageEdit ? {
          modelName: imageEdit.modelCode,
          funcCode: imageEdit.funcCode,
          capabilityCode: imageEdit.capabilityCode,
          projectId: String(detail.projectId), workspaceId, clientRequestId,
          canvasNode: { objectId: nodeId, expectedVersion: object.version, editSessionId: sessionId, lockToken },
          prompt,
          ...(imageEdit.size ? { size: imageEdit.size } : {}),
          expectedImageCount: imageEdit.expectedImageCount ?? 1,
          ...(imageEdit.parameters ? { parameters: imageEdit.parameters } : {}),
          imageEdit: { ...imageEdit.imageEdit, sourceResourceId: imageEditSourceResourceId! }
        } satisfies UserImageGenerationRequest : upscale ? {
          modelName: upscale.modelCode,
          capabilityCode: 'image_upscale',
          projectId: String(detail.projectId),
          workspaceId,
          clientRequestId,
          canvasNode: { objectId: nodeId, expectedVersion: object.version, editSessionId: sessionId, lockToken },
          ...canvasImageUpscaleSettings(generationModel!, upscale.sourceWidth, upscale.sourceHeight, upscale.scale),
          expectedImageCount: 1,
          references: prepared.references
        } satisfies UserImageGenerationRequest : ordinaryRequest
        let textStream: ReturnType<typeof startCanvasTextGenerationStream> | null = null
        let streamFinished = false
        const submitGeneration = (): Promise<{ task: UserGenerationTask | CanvasTaskProjection }> => kind === 'text'
          ? (() => {
              let sawDelta = false
              textStream = startCanvasTextGenerationStream(requestBody as UserTextGenerationRequest, () => {
                if (sawDelta) return
                sawDelta = true
                if (taskId) useStudioUiStore.getState().patchTask(taskId, { stage: '正在接收文本' })
              })
              textStreamsRef.current.add(textStream)
              void textStream.finished.then(() => {
                streamFinished = true
                textStreamsRef.current.delete(textStream!)
                if (taskId) taskTrackerRef.current?.wake(taskId)
              })
              return textStream.accepted
            })()
          : kind === 'audio'
            ? canvasGenerateAudio(requestBody as Parameters<typeof canvasGenerateAudio>[0]).then(task => ({ task }))
          : videoTool
            ? canvasGenerateVideo(requestBody as Extract<typeof requestBody, { videoTool: object }>).then((task) => ({ task }))
          : kind === 'image'
            ? userGenerationImage(requestBody as UserImageGenerationRequest)
            : userGenerationVideo(requestBody as UserVideoGenerationRequest)
        let response: { task: UserGenerationTask | CanvasTaskProjection } | null = null
        try {
          if (videoTool && (!live() || baselineRef.current.get(videoTool.sourceNodeId)?.version !== videoToolSourceVersion)) {
            throw new Error('视频工具输入已变化，请重新报价')
          }
          response = await submitGeneration()
        } catch (submitError: unknown) {
          if (!isCanvasGenerationResponseUnknown(submitError)) throw submitError
          // 只有请求没有响应时才查询画布绑定；明确业务失败直接交给提交入口展示。
          // SUBMITTING 尚无 taskId 时交由工作区恢复，不在这里再次发送生成请求。
          const [activeResult, historyResult] = await Promise.allSettled([
            canvasWorkspaceActiveTasks(workspaceId),
            canvasGenerateHistory({ workspaceId, objectId: nodeId, pageNum: 1, pageSize: 20 })
          ])
          const active = activeResult.status === 'fulfilled'
            ? activeResult.value.items.find((item) => item.operationId === clientRequestId)
            : undefined
          const historical = historyResult.status === 'fulfilled'
            ? historyResult.value.items.find((item) => item.operationId === clientRequestId)
            : undefined
          const recoveredTaskId = active?.taskId || historical?.taskId
          if (recoveredTaskId) {
            accepted = true
            activeTaskNodeIdsRef.current.add(nodeId)
            await handoffGenerationLease()
            response = { task: await canvasGenerateTask(workspaceId, String(recoveredTaskId)) }
          } else if (active) {
            accepted = true
            activeTaskNodeIdsRef.current.add(nodeId)
            await handoffGenerationLease()
            updateCanvasNodeRuntime(scopeKey, nodeId, {
              status: 'generating',
              errorMessage: undefined
            })
            useStudioUiStore.getState().upsertTask({
              id: `canvas-pending:${clientRequestId}`,
              nodeId,
              targetNodeIds: [nodeId],
              canvasOperationId: clientRequestId,
              canCancel: false,
              title: taskTitle,
              stage: '正在恢复任务',
              progress: 0,
              status: 'waiting',
              createdAt: active.createTime || new Date().toISOString(),
              updatedAt: active.updateTime || new Date().toISOString()
            })
            clearRun()
            await applyAuthoritativeSnapshot(detail, true).catch(() => undefined)
            antdMessage.info('生成请求已受理，正在恢复任务')
            return { status: 'accepted' }
          } else {
            throw submitError
          }
        }
        if (!response?.task?.taskId) throw new Error('生成接口未返回任务编号')
        accepted = true
        await handoffGenerationLease()
        taskId = String(response.task.taskId)
        activeTaskNodeIdsRef.current.add(nodeId)
        const now = new Date().toISOString()
        updateCanvasNodeRuntime(scopeKey, nodeId, {
          status: 'generating',
          canvasCurrentTaskId: taskId,
          errorMessage: undefined
        })
        useStudioUiStore.getState().upsertTask({
          id: taskId,
          nodeId,
          targetNodeIds: [nodeId],
          runId,
          inputSnapshotHash,
          inputNodeIds,
          canvasTaskId: taskId,
          canvasOperationId: clientRequestId,
          canCancel: kind !== 'text' && String(response.task.status || '').toUpperCase() === 'QUEUED',
          resultKind: kind === 'text' ? undefined : kind,
          title: taskTitle,
          stage: String(response.task.status || '').toUpperCase() === 'QUEUED' ? '排队中' : '生成中',
          progress: 0,
          status: String(response.task.status || '').toUpperCase() === 'QUEUED' ? 'queued' : 'running',
          createdAt: now,
          updatedAt: now
        })

        const tracker = taskTrackerRef.current
        if (!tracker) return { status: 'accepted' }
        const latest = await tracker.follow(taskId, nodeId, response.task, Boolean(textStream && !streamFinished))
        if (!latest) return { status: 'accepted' }

        if (unreconciledTerminalTaskIdsRef.current.delete(taskId)) {
          return { status: 'accepted', reason: '任务已结束，结果尚未同步，请查看节点历史' }
        }

        const finalStatus = String(latest.status || '').toUpperCase()
        const canNotify = finalStatus === 'SUCCEEDED' && isNotifiableStudioGenerationSuccess(kind, latest)
        if (stoppedRef.current || workspaceIdRef.current !== workspaceId) {
          if (canNotify) notifyStudioGenerationComplete(noticeTask)
          return { status: 'accepted' }
        }

        if (finalStatus !== 'SUCCEEDED') {
          canvasRetryLedger.clear(generationScope, fingerprint)
          terminalFailed = true
          const failure = canvasGenerationTaskMessage(latest, finalStatus.startsWith('CANCEL') ? '生成任务已取消' : '生成失败')
          handleSseErrorRecharge({
            needRecharge: latest.needRecharge,
            rechargeOwner: latest.rechargeOwner || undefined,
            userMessage: latest.userMessage || undefined,
            errorMessage: latest.errorMessage || undefined
          }, failure)
          if (live()) {
            updateCanvasNodeRuntime(scopeKey, nodeId, { status: 'failed', errorMessage: failure })
          }
          throw new Error(failure)
        }
        if (!live()) {
          terminalSucceeded = true
          canvasRetryLedger.clear(generationScope, fingerprint)
          if (canNotify) notifyStudioGenerationComplete(noticeTask)
          useStudioUiStore.getState().patchTask(taskId, {
            status: 'succeeded',
            stage: '已完成，输入已变更',
            progress: 100,
            updatedAt: new Date().toISOString()
          })
          clearRun()
          return { status: 'completed' }
        }

        if (kind === 'text' && !String(latest.textContent ?? '').trim()) {
          throw new Error('文本任务已完成，但没有返回正文')
        }
        terminalSucceeded = true
        // Tracker 已对同一终态批量读取权威快照；这里不重复请求工作区。
        canvasRetryLedger.clear(generationScope, fingerprint)
        clearRun()
        antdMessage.success(studioGenerationCompleteNotice(noticeTask).toastTitle)
        notifyStudioGenerationComplete(noticeTask)
        return { status: 'completed' }
      } catch (error: unknown) {
        if (!terminalSucceeded && live()) {
          const failure = apiErrorMessage(error, '生成失败')
          updateCanvasNodeRuntime(scopeKey, nodeId, accepted && !terminalFailed
            ? { status: 'generating', errorMessage: '任务已受理，状态暂时无法查询' }
            : { status: 'failed', errorMessage: failure })
          if (taskId) {
            useStudioUiStore.getState().patchTask(taskId, {
              status: accepted && !terminalFailed ? 'waiting' : 'failed',
              stage: accepted && !terminalFailed ? '状态恢复中' : '生成失败',
              errorMessage: failure,
              updatedAt: new Date().toISOString()
            })
          }
        }
        if (!accepted && !isCanvasGenerationResponseUnknown(error)) canvasRetryLedger.clear(generationScope, fingerprint)
        clearRun()
        if (accepted && !terminalFailed && !terminalSucceeded) {
          return { status: 'accepted', reason: '任务已受理，状态暂时无法查询', recoveryError: error }
        }
        throw error
      } finally {
        if (!accepted) ownOperationIdsRef.current.delete(clientRequestId)
      }
    })().catch((error: unknown) => {
      const state = useStudioUiStore.getState()
      const current = state.nodes.find((item) => item.id === nodeId)
      if (state.scopeKey === scopeKey && current?.data.status === 'queued') {
        updateCanvasNodeRuntime(scopeKey, nodeId, {
          status: 'failed',
          errorMessage: apiErrorMessage(error, '生成失败')
        })
      }
      throw error
    }).finally(async () => {
      if (!leaseHandedOff) await generationLease?.release().catch(() => undefined)
      if (![...pendingTerminalResultsRef.current.values()].some((pending) => pending.nodeId === nodeId)) {
        reservedGenerationNodeIdsRef.current.delete(nodeId)
      }
      if (generationPromisesRef.current.get(nodeId) === holder.promise) {
        generationPromisesRef.current.delete(nodeId)
        if (!stoppedRef.current) setGenerationBusyRevision((revision) => revision + 1)
      }
      if (!accepted) releaseDeferredNodePosition(nodeId)
      if (reservedGenerationNodeIdsRef.current.size === 0
        && pendingAuthoritativeReloadRef.current
        && useStudioUiStore.getState().dirtyRevision === 0
        && projectRef.current) {
        pendingAuthoritativeReloadRef.current = false
        void applyAuthoritativeSnapshot(projectRef.current, true).catch(() => {
          pendingAuthoritativeReloadRef.current = true
        })
      }
    })
    holder.promise = promise
    generationPromisesRef.current.set(nodeId, promise)
    return promise
  }, [applyAuthoritativeSnapshot, canUseFeature, performSave, releaseDeferredNodePosition, waitForSession])

  const generateNode = useCallback<CanvasProjectWorkspaceRuntime['generateNode']>(async (...args) => {
    const result = await generateNodeResult(...args)
    if (result.status === 'blocked') {
      antdMessage.warning(result.reason)
      return false
    }
    if (result.status === 'accepted' && 'recoveryError' in result) throw result.recoveryError
    return true
  }, [generateNodeResult])

  const loadNodeHistory = useCallback(async (nodeId: string, pageNum = 1) => {
    if (!workspaceIdRef.current) throw new Error('工作区尚未载入')
    return canvasGenerateHistory({ workspaceId: workspaceIdRef.current, objectId: nodeId, pageNum, pageSize: 20 })
  }, [])

  const selectNodeResult = useCallback((nodeId: string, resultId: string): Promise<void> => {
    const inFlight = resultSelectionPromisesRef.current.get(nodeId)
    if (inFlight) return inFlight
    const promise = (async () => {
    const workspaceId = workspaceIdRef.current
    const sessionId = sessionIdRef.current
    const detail = projectRef.current
    const object = baselineRef.current.get(nodeId)
    if (!workspaceId || !sessionId || !detail || !object || detail.roleCode === 'VIEWER') throw new Error('当前画布暂时不能切换节点结果')
    const lease = await editLeasesRef.current.acquire(workspaceId, sessionId, [nodeId])
    const lock = lease.locks[0]
    if (!lock?.lockToken) throw new Error('未取得节点编辑租约')
    const fingerprint = stableCanvasJson({ nodeId, resultId, expectedVersion: object.version })
    const selectionScope = `select:${workspaceId}:${nodeId}`
    const operationId = canvasRetryLedger.getOrCreate(selectionScope, fingerprint, () => canvasOperationId('select_result'))
    try {
      await canvasGenerateResultSelect({
        workspaceId,
        objectId: nodeId,
        expectedVersion: object.version,
        resultId,
        sessionId,
        lockToken: lock.lockToken,
        operationId
      })
      canvasRetryLedger.clear(selectionScope, fingerprint)
      await applyAuthoritativeSnapshot(detail, true)
    } finally {
      await lease.release().catch(() => undefined)
    }
    })()
    resultSelectionPromisesRef.current.set(nodeId, promise)
    void promise.finally(() => {
      if (resultSelectionPromisesRef.current.get(nodeId) === promise) resultSelectionPromisesRef.current.delete(nodeId)
    }).catch(() => undefined)
    return promise
  }, [applyAuthoritativeSnapshot])

  const applyNodeTextResult = useCallback(async (
    nodeId: string,
    taskId: string,
    inputObjectVersion: number,
    textContent: string
  ) => {
    const detail = projectRef.current
    const object = baselineRef.current.get(nodeId)
    const node = useStudioUiStore.getState().nodes.find((item) => item.id === nodeId)
    if (!detail || detail.roleCode === 'VIEWER' || !sessionIdRef.current || !object || !node) {
      throw new Error('当前画布暂时不能应用文本结果')
    }
    if (object.version !== inputObjectVersion) {
      throw new Error('节点内容已变化，不能覆盖为旧版本的文本结果')
    }
    if (!textContent.trim()) throw new Error('文本结果为空，无法应用')
    useStudioUiStore.getState().updateNodeData(nodeId, {
      documentContent: textContent,
      ...(node.data.kind === 'voice' ? { audioTextTaskId: taskId, audioTextSelectionVersion: node.data.canvasAudioSelectionVersion ?? 0, mediaUrl: undefined } : {}),
      resultSummary: textContent.slice(0, 180),
      mediaKind: node.data.kind === 'voice' ? 'audio' : 'text',
      status: 'success',
      canvasCurrentTaskId: taskId,
      errorMessage: undefined
    })
    await saveNow()
  }, [saveNow])

  const uploadResource = useCallback(async (file: File, mediaType: CanvasMediaType) => {
    const workspaceId = workspaceIdRef.current
    const detail = projectRef.current
    if (!workspaceId || !detail || stoppedRef.current) throw new Error('工作区尚未载入，请稍后重试')
    if (detail.roleCode !== 'OWNER' && detail.roleCode !== 'EDITOR') {
      throw new Error('当前工作区没有上传素材的权限')
    }
    const resource = await uploadRegistryRef.current.run(workspaceId, mediaType, file, async () => {
      const resources = await canvasResourceUpload(workspaceId, [{ file, mediaType }])
      const uploaded = resources[0]
      if (!uploaded) throw new Error('素材上传未返回有效结果')
      return uploaded
    })
    if (stoppedRef.current || workspaceIdRef.current !== workspaceId || projectRef.current?.projectId !== detail.projectId) {
      throw new Error('画布已切换，请在当前工作区重新上传素材')
    }
    resourceMediaTypeRef.current.set(String(resource.resourceId), resource.mediaType)
    resourcesRef.current.set(String(resource.resourceId), resource)
    return resource
  }, [])

  const resolveResourceReference = useCallback(async (ref: StudioComposerRef, options?: { isCurrent?: () => boolean }): Promise<CanvasResource> => {
    const expectedIdentity = canvasQuoteIdentity()
    const current = () => canvasQuoteConnected() && canvasQuoteIdentity() === expectedIdentity && options?.isCurrent?.() !== false
    if (!current()) throw new Error('画布或引用已变化，请重新准备')
    const workspaceId = workspaceIdRef.current
    if (!workspaceId) throw new Error('工作区尚未加载')
    const expectedProjectId = projectRef.current?.projectId
    const expectedScope = useStudioUiStore.getState().scopeKey
    const assertCurrent = () => {
      if (!current() || stoppedRef.current || workspaceIdRef.current !== workspaceId
        || projectRef.current?.projectId !== expectedProjectId || useStudioUiStore.getState().scopeKey !== expectedScope) {
        throw new Error('画布或引用已变化，请重新准备')
      }
    }
    const register = (request: Parameters<typeof canvasResourceRegister>[0]) => {
      assertCurrent()
      const key = JSON.stringify([expectedIdentity, workspaceId, request.sourceType, request.sourceId, request.sourceCategoryCode])
      const existing = referenceRegistrationsRef.current.get(key)
      if (existing) return existing
      const promise = canvasResourceRegister(request)
      referenceRegistrationsRef.current.set(key, promise)
      void promise.finally(() => {
        if (referenceRegistrationsRef.current.get(key) === promise) referenceRegistrationsRef.current.delete(key)
      }).catch(() => undefined)
      return promise
    }
    const expected = ref.mediaKind === 'text' ? 'DOCUMENT' : ref.mediaKind.toUpperCase()
    const knownId = String(ref.assetId || '')
    const external = ref.kind === 'asset' || ref.kind === 'library'
    let resource = external ? undefined : resourcesRef.current.get(knownId)
    const source = ref.nodeId ? useStudioUiStore.getState().nodes.find((item) => item.id === ref.nodeId) : undefined
    const sourceUrl = source?.data.mediaUrl
    const sourceVersion = source ? baselineRef.current.get(source.id)?.version : undefined
    if (!resource && source) {
      const ids = [String(source.data.canvasPrimaryResourceId || ''), ...(source.data.canvasResourceIds || []).map(String)]
      resource = ids.map((id) => resourcesRef.current.get(id)).find((item) => item?.mediaType === expected
        && canvasResourceMatchesNodeMedia(item, source.data))
      if (!resource) {
        const resultId = String(source.data.canvasCurrentResultId || '')
        if (/^\d+$/.test(resultId) && resultId !== '0') {
          resource = await register({ workspaceId, sourceType: 'MEDIA_RESULT', sourceId: resultId })
        }
      }
      if (!resource) {
        const taskId = String(source.data.canvasCurrentTaskId || '')
        if (/^\d+$/.test(taskId) && taskId !== '0') {
          resource = await register({ workspaceId, sourceType: 'MEDIA_TASK', sourceId: taskId })
        }
      }
    }
    if (!resource && ref.kind === 'asset' && ref.personalAudioAssetId) {
      resource = await register({ workspaceId, sourceType: 'AUDIO_ASSET', sourceId: ref.personalAudioAssetId })
    }
    if (!resource && /^\d+$/.test(knownId) && knownId !== '0' && (ref.kind === 'asset' || ref.kind === 'library')) {
      resource = await register({ workspaceId, sourceType: ref.kind === 'library' ? 'OFFICIAL_ASSET' : ref.sourceCategoryCode ? 'ASSET_CENTER' : 'USER_ASSET', sourceId: knownId,
        ...(ref.kind === 'asset' && ref.sourceCategoryCode ? { sourceCategoryCode: ref.sourceCategoryCode } : {}) })
    }
    assertCurrent()
    const currentSource = source ? useStudioUiStore.getState().nodes.find(node => node.id === source.id) : undefined
    if (source && (!currentSource || currentSource.data.mediaUrl !== sourceUrl || baselineRef.current.get(source.id)?.version !== sourceVersion)) throw new Error('源素材已变化，请重新选择')
    if (!resource || resource.mediaType !== expected || (source?.data.mediaUrl && !canvasResourceMatchesNodeMedia(resource, source.data))) {
      throw new Error('所选引用暂时不可用，请重新选择素材')
    }
    const id = String(resource.resourceId)
    resourcesRef.current.set(id, resource)
    resourceMediaTypeRef.current.set(id, resource.mediaType)
    if (source && canvasResourceMatchesNodeMedia(resource, source.data)) {
      const resourceIds = [...new Set([...(source.data.canvasResourceIds || []).map(String), id])]
      if (!(source.data.canvasResourceIds || []).map(String).includes(id)
        || source.data.canvasPrimaryResourceId !== id) {
        useStudioUiStore.getState().updateNodeData(source.id, {
          canvasResourceIds: resourceIds,
          canvasPrimaryResourceId: id
        })
        await saveNow()
      }
    }
    assertCurrent()
    return resource
  }, [saveNow])

  const prepareLayerSplitSource = useCallback(async (nodeId: string) => {
    await saveNow()
    const node = useStudioUiStore.getState().nodes.find((item) => item.id === nodeId)
    const object = baselineRef.current.get(nodeId)
    if (!node || node.data.kind !== 'image' || !node.data.mediaUrl || !object) {
      throw new Error('原图节点尚未保存或已失效')
    }
    const resource = await resolveResourceReference(studioNodeToComposerRef(node))
    const resourceId = String(resource.resourceId)
    const latestNode = useStudioUiStore.getState().nodes.find((item) => item.id === nodeId)
    if (!(latestNode?.data.canvasResourceIds || []).map(String).includes(resourceId)) {
      throw new Error('原图资源已登记，但尚未保存到源节点，请重试')
    }
    return { resourceId, expectedVersion: baselineRef.current.get(nodeId)?.version ?? object.version }
  }, [resolveResourceReference, saveNow])

  const splitImageInternal = useCallback((sourceNodeId: string, rows: number, columns: number, selectedCells?: Array<{ row: number; col: number }>, region?: { x: number; y: number; width: number; height: number }) => {
    const requestKey = `${sourceNodeId}:${region ? `region:${stableCanvasJson(region)}` : `${rows}x${columns}:${JSON.stringify(selectedCells || [])}`}`
    const running = imageSplitPromisesRef.current.get(requestKey)
    if (running) return running
    const promise = (async (): Promise<CanvasImageSplitResult> => {
      const detail = projectRef.current
      const workspaceId = workspaceIdRef.current
      if (!workspaceId || !detail || detail.roleCode === 'VIEWER') throw new Error('当前画布没有图片切分权限')
      if (!region && (!Number.isInteger(rows) || !Number.isInteger(columns) || rows < 1 || columns < 1 || rows > 5 || columns > 5 || rows * columns < 2)) {
        throw new Error('宫格行列必须为 1 至 5，且至少分成两格')
      }
      if (region && (!Number.isInteger(region.x) || !Number.isInteger(region.y) || !Number.isInteger(region.width) || !Number.isInteger(region.height) || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1)) {
        throw new Error('自定义切分区域必须是有效原图像素矩形')
      }
      const initial = useStudioUiStore.getState().nodes.find((item) => item.id === sourceNodeId)
      if (initial?.data.kind !== 'image' || !initial.data.mediaUrl) throw new Error('请先上传或生成源图片')
      const sourceUrl = initial.data.mediaUrl
      await saveNow()
      await waitForSession()
      if (workspaceIdRef.current !== workspaceId || stoppedRef.current) throw new Error('画布已切换，请重新切分')
      let source = useStudioUiStore.getState().nodes.find((item) => item.id === sourceNodeId)
      if (!source || source.data.mediaUrl !== sourceUrl) throw new Error('源图片已变化，请重新切分')
      let resourceId = [String(source.data.canvasPrimaryResourceId || ''), ...(source.data.canvasResourceIds || []).map(String)]
        .find((id) => /^\d+$/.test(id) && id !== '0' && resourceMediaTypeRef.current.get(id) === 'IMAGE'
          && resourcesRef.current.get(id)?.resourceUrl === sourceUrl)
      if (resourceId && String(source.data.canvasPrimaryResourceId || '') !== resourceId) {
        useStudioUiStore.getState().updateNodeData(sourceNodeId, { canvasPrimaryResourceId: resourceId })
        await saveNow()
        source = useStudioUiStore.getState().nodes.find((item) => item.id === sourceNodeId)
      }
      if (!source || source.data.mediaUrl !== sourceUrl) throw new Error('源图片已变化，请重新切分')
      if (!resourceId) {
        const selectedResultId = String(source.data.canvasCurrentResultId || '')
        if (/^\d+$/.test(selectedResultId) && selectedResultId !== '0') {
          const registered = await canvasResourceRegister({ workspaceId, sourceType: 'MEDIA_RESULT', sourceId: selectedResultId })
          if (registered.mediaType === 'IMAGE' && registered.resourceUrl === sourceUrl) {
            resourceId = String(registered.resourceId)
            resourcesRef.current.set(resourceId, registered)
            resourceMediaTypeRef.current.set(resourceId, registered.mediaType)
          }
        }
      }
      if (!resourceId) {
        const taskId = String(source.data.canvasCurrentTaskId || '')
        if (!/^\d+$/.test(taskId) || taskId === '0') throw new Error('源图片尚未登记为画布素材，请重新上传图片')
        const registered = await canvasResourceRegister({ workspaceId, sourceType: 'MEDIA_TASK', sourceId: taskId })
        if (registered.mediaType !== 'IMAGE' || registered.resourceUrl !== sourceUrl) {
          throw new Error('当前显示图片与已登记的任务素材不一致，请重新选择图片')
        }
        resourceId = String(registered.resourceId)
        resourcesRef.current.set(resourceId, registered)
        resourceMediaTypeRef.current.set(resourceId, registered.mediaType)
      }
      if (resourceId && (source.data.canvasPrimaryResourceId !== resourceId || !(source.data.canvasResourceIds || []).includes(resourceId))) {
        useStudioUiStore.getState().updateNodeData(sourceNodeId, {
          canvasResourceIds: [...new Set([...(source.data.canvasResourceIds || []).map(String), resourceId])],
          canvasPrimaryResourceId: resourceId
        })
        await saveNow()
        source = useStudioUiStore.getState().nodes.find((item) => item.id === sourceNodeId)
      }
      const expectedVersion = baselineRef.current.get(sourceNodeId)?.version
      if (!source || source.data.mediaUrl !== sourceUrl || !resourceId || !expectedVersion) {
        throw new Error('源图片版本已变化，请刷新后重新切分')
      }
      const result = await canvasImageSplit({
        workspaceId,
        sourceObjectId: sourceNodeId,
        sourceResourceId: resourceId,
        expectedVersion,
        clientRequestId: canvasOperationId('image_split'),
        mode: region ? 'REGIONS' : 'GRID',
        ...(region ? { regions: [region] } : { rows, columns, ...(selectedCells?.length ? { selectedCells } : {}) })
      })
      if (workspaceIdRef.current !== workspaceId || stoppedRef.current) throw new Error('画布已切换，切分结果未加入当前画布')
      const current = useStudioUiStore.getState().nodes.find((item) => item.id === sourceNodeId)
      if (!current || current.data.mediaUrl !== sourceUrl) throw new Error('源图片已变化，切分结果未加入画布')
      for (const output of result.outputs) {
        const id = String(output.resourceId)
        const registered: CanvasResource = { resourceId: id, workspaceId, mediaType: 'IMAGE', resourceUrl: output.resourceUrl }
        resourcesRef.current.set(id, registered)
        resourceMediaTypeRef.current.set(id, 'IMAGE')
      }
      return result
    })()
    imageSplitPromisesRef.current.set(requestKey, promise)
    void promise.finally(() => {
      if (imageSplitPromisesRef.current.get(requestKey) === promise) imageSplitPromisesRef.current.delete(requestKey)
    }).catch(() => undefined)
    return promise
  }, [saveNow, waitForSession])

  const splitImage = useCallback((sourceNodeId: string, rows: number, columns: number, selectedCells?: Array<{ row: number; col: number }>) =>
    splitImageInternal(sourceNodeId, rows, columns, selectedCells), [splitImageInternal])
  const splitImageRegion = useCallback((sourceNodeId: string, region: { x: number; y: number; width: number; height: number }) =>
    splitImageInternal(sourceNodeId, 0, 0, undefined, region), [splitImageInternal])

  const mergeImageLayers = useCallback((sourceNodeId: string): Promise<CanvasImageLayerMergeResult> => {
    const initialState = useStudioUiStore.getState().nodes.find((item) => item.id === sourceNodeId)?.data.layerSeparation
    const requestKey = `${sourceNodeId}:${stableCanvasJson(initialState || null)}`
    const running = imageLayerMergePromisesRef.current.get(requestKey)
    if (running) return running
    const promise = (async (): Promise<CanvasImageLayerMergeResult> => {
      const detail = projectRef.current
      const workspaceId = workspaceIdRef.current
      if (!workspaceId || !detail || detail.roleCode === 'VIEWER') {
        throw new Error('\u5f53\u524d\u753b\u5e03\u6ca1\u6709\u56fe\u5c42\u5408\u5e76\u6743\u9650')
      }
      if (!initialState?.layers.length) throw new Error('\u6ca1\u6709\u53ef\u5408\u5e76\u7684\u56fe\u5c42')
      const validateState = (state: StudioLayerSeparationState) => {
        const ids = [state.backgroundResourceId, ...state.layers.map((layer) => layer.resourceId)]
          .filter((id): id is string => Boolean(id))
        if (ids.length !== state.layers.length + (state.backgroundResourceId ? 1 : 0)
          || ids.some((id) => !/^\d+$/.test(id) || id === '0')) {
          throw new Error('\u56fe\u5c42\u5c1a\u672a\u7ed1\u5b9a\u753b\u5e03\u8d44\u6e90\uff0c\u8bf7\u91cd\u65b0\u5206\u5c42\u540e\u518d\u5408\u5e76')
        }
        for (const id of ids) {
          if (resourcesRef.current.get(id)?.mediaType !== 'IMAGE') {
            throw new Error('\u56fe\u5c42\u8d44\u6e90\u5df2\u5931\u6548\uff0c\u8bf7\u5237\u65b0\u753b\u5e03')
          }
        }
      }
      validateState(initialState)
      const inputFingerprint = stableCanvasJson(initialState)
      await saveNow()
      await waitForSession()
      if (workspaceIdRef.current !== workspaceId || stoppedRef.current) {
        throw new Error('\u753b\u5e03\u5df2\u5207\u6362\uff0c\u8bf7\u91cd\u65b0\u5408\u5e76')
      }
      const currentNode = useStudioUiStore.getState().nodes.find((item) => item.id === sourceNodeId)
      const state = currentNode?.data.layerSeparation
      if (!state || stableCanvasJson(state) !== inputFingerprint) {
        throw new Error('\u56fe\u5c42\u5185\u5bb9\u5df2\u53d8\u5316\uff0c\u8bf7\u91cd\u65b0\u5408\u5e76')
      }
      validateState(state)
      let width = Number(state.canvasWidth) || 0
      let height = Number(state.canvasHeight) || 0
      if (width < 1 || height < 1) {
        const sourceUrl = state.backgroundUrl || state.layers.find((layer) => layer.mediaUrl)?.mediaUrl
        if (!sourceUrl) throw new Error('\u65e0\u6cd5\u786e\u5b9a\u5408\u5e76\u753b\u5e03\u5c3a\u5bf8')
        const image = await loadStudioCanvasImage(sourceUrl)
        try {
          width = image.width
          height = image.height
        } finally {
          image.dispose()
        }
      }
      const expectedVersion = baselineRef.current.get(sourceNodeId)?.version
      if (!expectedVersion) throw new Error('\u6e90\u8282\u70b9\u7248\u672c\u5df2\u53d8\u5316\uff0c\u8bf7\u5237\u65b0\u540e\u91cd\u8bd5')
      const fingerprint = stableCanvasJson({ sourceNodeId, expectedVersion, width, height, state })
      const scope = `image-layer-merge:${workspaceId}:${sourceNodeId}`
      const clientRequestId = canvasRetryLedger.getOrCreate(scope, fingerprint, () => canvasOperationId('layer_merge'))
      const result = await canvasImageLayerMerge({
        workspaceId,
        sourceObjectId: sourceNodeId,
        expectedVersion,
        clientRequestId,
        canvas: { width, height },
        ...(state.backgroundResourceId ? { backgroundResourceId: state.backgroundResourceId } : {}),
        layers: state.layers.map((layer) => ({
          layerId: layer.id,
          resourceId: String(layer.resourceId),
          rect: {
            x: layer.transform.rect.x,
            y: layer.transform.rect.y,
            width: layer.transform.rect.w,
            height: layer.transform.rect.h
          },
          rotationDeg: layer.transform.rotationDeg,
          flipX: layer.transform.flipX,
          flipY: layer.transform.flipY,
          opacity: layer.transform.opacity ?? 1,
          visible: layer.transform.visible !== false
        }))
      })
      canvasRetryLedger.clear(scope, fingerprint)
      const latestState = useStudioUiStore.getState().nodes.find((item) => item.id === sourceNodeId)?.data.layerSeparation
      if (!latestState || stableCanvasJson(latestState) !== inputFingerprint) {
        throw new Error('\u56fe\u5c42\u5185\u5bb9\u5df2\u53d8\u5316\uff0c\u672c\u6b21\u5408\u5e76\u7ed3\u679c\u672a\u5199\u5165\u8282\u70b9')
      }
      const id = String(result.resourceId)
      const resource: CanvasResource = {
        resourceId: id,
        workspaceId,
        mediaType: 'IMAGE',
        resourceUrl: result.resourceUrl,
        sourceType: 'LAYER_MERGE'
      }
      resourcesRef.current.set(id, resource)
      resourceMediaTypeRef.current.set(id, 'IMAGE')
      return result
    })()
    imageLayerMergePromisesRef.current.set(requestKey, promise)
    void promise.finally(() => {
      if (imageLayerMergePromisesRef.current.get(requestKey) === promise) imageLayerMergePromisesRef.current.delete(requestKey)
    }).catch(() => undefined)
    return promise
  }, [saveNow, waitForSession])

  const importNodeText = useCallback((nodeId: string, file: File): Promise<void> => {
    const workspaceId = workspaceIdRef.current
    const detail = projectRef.current
    const initial = useStudioUiStore.getState()
    const node = initial.nodes.find((item) => item.id === nodeId)
    if (!workspaceId || stoppedRef.current || !detail || !canvasProjectCanEdit(detail.roleCode) || node?.data.kind !== 'text') {
      return Promise.reject(new Error('当前文本节点不可导入'))
    }
    const key = `${workspaceId}:${nodeId}`
    if (textImportFlightsRef.current.has(key)) return Promise.reject(new Error('此节点正在导入文本，请等待完成'))
    const promise = (async () => {
      const result = await canvasTextImport(workspaceId, file)
      const store = useStudioUiStore.getState()
      if (workspaceIdRef.current !== workspaceId || store.scopeKey !== initial.scopeKey
        || projectRef.current?.projectId !== detail.projectId) throw new Error('画布已切换，请重新导入')
      const target = store.nodes.find(item => item.id === nodeId)
      if (!target || target.data.kind !== 'text') throw new Error('文本节点已删除，请重新选择节点')
      if (target.data.documentContent !== node.data.documentContent || target.data.resultSummary !== node.data.resultSummary
        || node.data.documentContent === undefined && target.data.prompt !== node.data.prompt) {
        throw new Error('文本正文已修改，导入结果未覆盖当前内容，请重新导入')
      }
      store.updateNodeData(nodeId, { documentContent: result.textContent, mediaKind: 'text', status: 'success' })
      try { await saveNow() }
      catch (error) { throw new Error(`文本已导入，但画布保存失败：${apiErrorMessage(error, '请重试保存')}`) }
    })()
    textImportFlightsRef.current.set(key, promise)
    void promise.finally(() => {
      if (textImportFlightsRef.current.get(key) === promise) textImportFlightsRef.current.delete(key)
    }).catch(() => undefined)
    return promise
  }, [saveNow])

  const invokeMember = useCallback(async (
    nodeId: string,
    request: Omit<CanvasRuntimeInvokeRequest, 'clientRequestId' | 'projectId' | 'workspaceId' | 'canvasNode'>
  ) => {
    const detail = projectRef.current
    const workspaceId = workspaceIdRef.current
    if (!detail || !workspaceId || detail.roleCode === 'VIEWER') throw new Error('当前画布不可运行能力')
    if (!canUseFeature('canvas.generate')) throw new Error('当前账号没有画布生成权限')
    await saveNow()
    const sessionId = await waitForSession()
    const object = baselineRef.current.get(nodeId)
    if (!object || workspaceIdRef.current !== workspaceId) throw new Error('节点已变化，请重新提交')
    const fingerprint = stableCanvasJson({ nodeId, version: object.version, request })
    const scope = `runtime:${workspaceId}:${nodeId}`
    const clientRequestId = canvasRetryLedger.getOrCreate(scope, fingerprint, () => canvasOperationId('runtime'))
    const lease = await editLeasesRef.current.acquire(workspaceId, sessionId, [nodeId])
    const lock = lease.locks[0]
    if (!lock?.lockToken) throw new Error('未取得节点编辑租约')
    let accepted = false
    try {
      const run = await canvasRuntimeInvoke({
        ...request,
        clientRequestId,
        projectId: detail.projectId,
        workspaceId,
        canvasNode: {
          objectId: nodeId,
          expectedVersion: object.version,
          editSessionId: sessionId,
          lockToken: lock.lockToken
        }
      })
      accepted = run.status !== 'FAILED' && run.status !== 'CANCELED'
      if (accepted) await lease.handoff()
      canvasRetryLedger.clear(scope, fingerprint)
      await applyAuthoritativeSnapshot(detail, true, true).catch(() => undefined)
      return run
    } finally {
      if (!accepted) {
        await lease.release().catch(() => undefined)
      }
    }
  }, [applyAuthoritativeSnapshot, canUseFeature, saveNow, waitForSession])

  const adoptRun = useCallback(async (nodeId: string, runId: string, mode: 'REPLACE' | 'APPEND' | 'CREATE_NODE') => {
    const detail = projectRef.current
    const workspaceId = workspaceIdRef.current
    if (!detail || !workspaceId || detail.roleCode === 'VIEWER') throw new Error('当前画布不可采纳结果')
    await saveNow()
    const sessionId = await waitForSession()
    const object = baselineRef.current.get(nodeId)
    if (!object) throw new Error('文本节点尚未保存')
    const expectedVersion = mode === 'CREATE_NODE' ? 0 : object.version
    const fingerprint = stableCanvasJson({ nodeId, runId, mode, expectedVersion })
    const scope = `adopt:${workspaceId}:${nodeId}`
    const operationId = canvasRetryLedger.getOrCreate(scope, fingerprint, () => canvasOperationId('adopt'))
    const targetId = mode === 'CREATE_NODE' ? `text_${operationId}`.slice(0, 64) : nodeId
    const lease = await editLeasesRef.current.acquire(workspaceId, sessionId, [targetId])
    const lock = lease.locks[0]
    if (!lock?.lockToken) throw new Error('未取得节点编辑租约')
    try {
      await canvasTextResultAdopt({
        workspaceId, runId, mode, objectId: targetId,
        expectedVersion, sessionId,
        lockToken: lock.lockToken, operationId,
        ...(mode === 'CREATE_NODE' ? { title: '文本结果' } : {})
      })
      canvasRetryLedger.clear(scope, fingerprint)
      await applyAuthoritativeSnapshot(detail, true)
    } finally {
      await lease.release().catch(() => undefined)
    }
  }, [applyAuthoritativeSnapshot, saveNow, waitForSession])

  useEffect(() => {
    if (!enabled || !projectId || dirtyRevision === 0) return
    if (project?.roleCode !== 'VIEWER' && !connected) return
    const identity = canvasQuoteIdentity()
    const timer = window.setTimeout(() => {
      void saveNow().catch((error: unknown) => {
        if (useStudioUiStore.getState().scopeKey === scopeKey && canvasQuoteIdentity() === identity) {
          antdMessage.error(apiErrorMessage(error, '画布自动保存失败'))
        }
      })
    }, 650)
    return () => window.clearTimeout(timer)
  }, [connected, dirtyRevision, enabled, project?.roleCode, projectId, saveNow, scopeKey])

  useEffect(() => {
    if (!enabled) return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (useStudioUiStore.getState().dirtyRevision === 0) return
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [enabled])

  /** Assistant采用为服务端事务写入，即使个人项目也必须取得真实编辑栅栏。 */
  const acquireNodeMutationLease = useCallback(async (nodeId: string) => {
    const detail = projectRef.current
    const workspaceId = workspaceIdRef.current
    if (!detail || !workspaceId || detail.roleCode === 'VIEWER') throw new Error('当前画布不可编辑')
    await saveNow()
    const editSessionId = await waitForSession()
    if (workspaceIdRef.current !== workspaceId || stoppedRef.current) throw new Error('画布已切换')
    const objectVersion = baselineRef.current.get(nodeId)?.version
    if (!objectVersion || !Number.isSafeInteger(objectVersion)) throw new Error('目标节点尚未保存')
    const lease = await editLeasesRef.current.acquire(workspaceId, editSessionId, [nodeId])
    if (workspaceIdRef.current !== workspaceId || stoppedRef.current) { await lease.release(); throw new Error('画布已切换') }
    return { editSessionId, objectVersion, lease }
  }, [saveNow, waitForSession])
  const getNodeVersion = useCallback((nodeId: string) => baselineRef.current.get(nodeId)?.version ?? null, [])
  const observeRun = useCallback((runId: string, nodeId: string, onHint: () => void) =>
    taskTrackerRef.current?.observeRun(runId, nodeId, onHint) ?? (() => undefined), [])
  const refreshWorkspace = useCallback(async () => {
    if (projectRef.current) await applyAuthoritativeSnapshot(projectRef.current, true)
  }, [applyAuthoritativeSnapshot])

  return useMemo(() => ({
    getNodeVersion,
    refreshWorkspace,
    acquireNodeEditLease,
    acquireNodeMutationLease,
    nodeEditLockOwner,
    project,
    role: project?.roleCode || null,
    canEdit: canvasProjectCanEdit(project?.roleCode),
    canMutate: canvasProjectCanMutate(project?.roleCode, connected),
    connected,
    collaborationStatus,
    collaborationError,
    collaboration,
    collaborationRecoverable,
    retryCollaboration,
    retainCanvasCollaboration,
    entitlements,
    undoAvailable,
    isNodeBusy,
    reserveGenerationNode,
    releaseGenerationNode,
    canUseFeature,
    saveNow,
    deleteNodes,
    refreshCollaboration,
    refreshProject,
    copyNodes,
    undoLast,
    loadDrafts,
    saveNodeDraft,
    deleteNodeDraft,
    applyNodeDraft,
    nodeResources,
    resourceById,
    resolveResourceReference,
    prepareGenerationQuote,
    prepareLayerSplitSource,
    transferResource,
    generateNode,
    generateNodeResult,
    loadNodeHistory,
    selectNodeResult,
    applyNodeTextResult,
    uploadResource,
    splitImage,
    splitImageRegion,
    mergeImageLayers,
    importNodeText,
    invokeMember,
    observeRun,
    adoptRun
  }), [nodeEditLockOwner, acquireNodeEditLease, acquireNodeMutationLease, adoptRun, applyNodeDraft, applyNodeTextResult, canUseFeature, collaboration, collaborationError, collaborationRecoverable, collaborationStatus, connected, copyNodes, deleteNodeDraft, deleteNodes, entitlements, generateNode, generateNodeResult, getNodeVersion, importNodeText, invokeMember, isNodeBusy, loadDrafts, loadNodeHistory, mergeImageLayers, nodeResources, observeRun, resourceById, prepareGenerationQuote, prepareLayerSplitSource, project, refreshCollaboration, refreshProject, refreshWorkspace, releaseGenerationNode, reserveGenerationNode, resolveResourceReference, retainCanvasCollaboration, retryCollaboration, saveNodeDraft, saveNow, selectNodeResult, splitImage, splitImageRegion, transferResource, undoAvailable, undoLast, uploadResource])
}
