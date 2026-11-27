'use client'

import {
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type Viewport,
  type XYPosition
} from '@xyflow/react'
import { create } from 'zustand'
import { guardStudioReadOnlyActions } from '@/utils/studio/studioReadOnly'
import type { StudioEmotionSession } from '@/types/studio'
import { createEmotionSession, patchEmotionSession } from '@/utils/studio/studioEmotionSession'
import { studioEditorSource } from '@/utils/studio/studioEditorSource'
import { studioLabel, studioNodeHasLabelContent } from '@/utils/studio/studioNodeLabels'
import { DEFAULT_STUDIO_ZONES, STUDIO_NODE_META, STUDIO_TEMPLATES } from '@/config/studioMeta'
import type {
  DirectorSceneData,
  StudioCanvasNode,
  StudioCanvasTool,
  StudioChatMessage,
  StudioComposerRef,
  StudioConversationState,
  StudioDiagnostic,
  StudioEdgeKind,
  StudioFlowEdge,
  StudioFrameBreakdownSourceInput,
  StudioGroup,
  StudioImageEditSession,
  StudioLayerSplitSession,
  StudioMode,
  StudioNodeData,
  StudioNodeKind,
  StudioSkill,
  StudioSavedAsset,
  StudioTask,
  StudioTemplate,
  StudioTouchEditSession,
  StudioVideoEditSession,
  StudioVideoClipSession,
  StudioVideoSubtitleMode,
  StudioVideoAudioTool,
  StudioWorkspaceData,
  StudioWorkspaceSnapshot,
  StudioZone
} from '@/types/studio'
import {
  applyTemplateToSnapshot,
  createStudioEdge,
  assignStudioMediaSequenceTitles,
  createStudioNode,
  diagnoseStudioGraph,
  nextStudioMediaTitle,
  duplicateStudioNodes,
  repairStudioDiagnostics,
  studioId
} from '@/utils/studio/studioGraph'
import {
  groupStudioNodes,
  moveStudioGroup,
  recalculateStudioGroups,
  reconcileStudioGroupsForNodes,
  resizeStudioGroup,
  setStudioGroupColor,
  ungroupStudioNodes
} from '@/utils/studio/studioGroup'
import {
  buildMergedGridStoryboardFromNodes
} from '@/utils/studio/studioGroupStoryboardBridge'
import { arrangeStudioNodes, type StudioArrangement } from '@/utils/studio/studioSelectionLayout'
import { placeStudioNodeBeside, placeStudioNodeWithoutOverlap, toStudioNodeRect } from '@/utils/studio/studioNodePlacement'
import {
  STUDIO_GRID_STORYBOARD_MAX_HEIGHT,
  STUDIO_GRID_STORYBOARD_MIN_HEIGHT,
  STUDIO_NODE_DEFAULT_DIMENSIONS,
  studioNodeDimensions
} from '@/utils/studio/studioNodeLod'
import { studioVideoAudioToolDefinition } from '@/utils/studio/studioVideoAudioTool'
import { tidyStudioCanvasNodes } from '@/utils/studio/studioCanvasTidy'
import { canConnectStudioNodes, studioConnectedVideoDisabledReason, studioManualNodeConnectionDisabledReason } from '@/utils/studio/studioLibraryLink'
import { removeStudioVideoReference, upsertComposerRef } from '@/utils/studio/studioComposerRefs'
import { applyStudioConnectionReference, clearStudioConnectionReference } from '@/utils/studio/studioConnectionReference'
import { createEmptyTouchEditSession } from '@/utils/studio/touchEditSessionModel'
import { createEmptyLayerSplitSession } from '@/utils/studio/studioLayerSplit'
import { createStudioVideoEditSession } from '@/utils/studio/studioVideoSubtitleSelection'
import { patchStudioGeneratingEdges } from '@/utils/studio/studioGeneratingEdges'
import { collectStudioNodeBlobUrls } from '@/utils/studio/studioNodeBlobUrls'
import { revokeObjectUrls } from '@/utils/objectUrl'
import {
  studioNodeToComposerRef,
  studioReferencePickDisabledReason,
  withStudioVideoReference,
  type StudioReferencePickerState
} from '@/utils/studio/studioReferencePicker'
import { normalizeStudioFrameBreakdownDimensions } from '@/utils/studio/studioFrameBreakdown'
import { DEFAULT_STUDIO_CONVERSATION } from '@/utils/studio/studioConversation'
import { mergeStudioFlowBusinessForHistory } from '@/utils/studio/studioFlowWorkspace'
import { createDefaultDirectorScene } from '@/utils/studio/directorScene'
import { DIRECTOR_BATCH_SHOT_LIMIT } from '@/components/studio/director/directorBatchShots'
import type { StudioEmptyPresetId } from '@/config/studioNodeEmptyNextSteps'
import {
  applyStudioEmptyPreset,
  type StudioEmptyPresetRoleOverrides
} from '@/utils/studio/applyStudioEmptyPreset'
import { patchStudioNodeAndReferences } from '@/utils/studio/studioNodeReferenceSync'
import {
  patchGridStoryboardCell,
  resolveGridStoryboardCellAspectRatio,
  resolveGridStoryboardCellCanvasSize,
  resolveGridStoryboardCellMediaKind,
  resolveGridStoryboardReferenceSource
} from '@/utils/studio/studioImageGridStoryboard'
import type { StudioGridStoryboardDropTarget } from '@/utils/studio/studioGridStoryboardTransfer'
import { applySmartEditCommand } from '@/utils/studio/smartEditCommands'
import { invalidateMissingSmartEditSources, pruneSmartEditDismissals } from '@/utils/studio/smartEditValidation'
import { isSmartEditSourceCandidate, smartEditMediaClips } from '@/utils/studio/studioSmartEdit'

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'
type NodeFilter = 'all' | 'rerun'

interface StudioUiState {
  scopeKey: string
  studioMode: StudioMode
  title: string
  nodes: StudioCanvasNode[]
  edges: StudioFlowEdge[]
  zones: StudioZone[]
  groups: StudioGroup[]
  viewport: Viewport
  tasks: StudioTask[]
  messages: StudioChatMessage[]
  conversation: StudioConversationState
  savedAssets: StudioSavedAsset[]
  directorScenes: Record<string, DirectorSceneData>
  personalTemplates: StudioTemplate[]
  personalSkills: StudioSkill[]
  reducedMotion: boolean
  hydrated: boolean
  loading: boolean
  loadError: string
  selectedNodeIds: string[]
  activeNodeId: string | null
  diagnostics: StudioDiagnostic[]
  selectedDiagnosticIds: string[]
  nodeFilter: NodeFilter
  referencePicker: StudioReferencePickerState | null
  edgeKind: StudioEdgeKind
  canvasTool: StudioCanvasTool
  miniMapOpen: boolean
  hideEdges: boolean
  gridSnapEnabled: boolean
  leftCollapsed: boolean
  rightCollapsed: boolean
  directorOpenNodeId: string | null
  emotionSession: StudioEmotionSession | null
  openEmotionSession: (nodeId: string) => void
  patchEmotionSession: (sessionId: string, patch: Partial<Pick<StudioEmotionSession, 'faces' | 'selectedFaceId' | 'phase' | 'manualMode' | 'detectionStatus' | 'quality' | 'count'>>) => void
  closeEmotionSession: (sessionId?: string) => void
  imageLightingNodeId: string | null
  imageMultiAngleNodeId: string | null
  imageEditSession: StudioImageEditSession | null
  videoEditSession: StudioVideoEditSession | null
  videoClipSession: StudioVideoClipSession | null
  touchEditSession: StudioTouchEditSession | null
  layerSplitSession: StudioLayerSplitSession | null
  chatContextNodeIds: string[]
  dirtyRevision: number
  saveStatus: SaveStatus
  savedAt: string
  saveError: string
  historyPast: StudioWorkspaceSnapshot[]
  historyFuture: StudioWorkspaceSnapshot[]
  transactionBaseline: StudioWorkspaceSnapshot | null
  readOnly: boolean
  beginLoad: (scopeKey: string, options?: { readOnly?: boolean }) => void
  hydrate: (workspace: StudioWorkspaceData, options?: { reconcileInteraction?: boolean; readOnly?: boolean }) => void
  setStudioMode: (mode: StudioMode) => void
  setTitle: (title: string, markDirty?: boolean) => void
  setLoadError: (message: string) => void
  addNode: (kind: StudioNodeKind, position?: XYPosition, options?: Partial<StudioNodeData>, connection?: {
    nodeId: string
    role: 'source' | 'target'
    kind?: StudioEdgeKind
  }) => string
  /** Manual menu creation validates before creating either a node or an edge. */
  addUserNode: (...args: Parameters<StudioUiState['addNode']>) => string | null
  applyEmptyPreset: (
    anchorNodeId: string,
    presetId: StudioEmptyPresetId,
    roleOverrides?: StudioEmptyPresetRoleOverrides
  ) => string | null
  deriveAudioNodes: (sourceNodeId: string, options: Partial<StudioNodeData>[], select?: boolean) => string[]
  deriveImageNode: (
    sourceNodeId: string,
    generationOptions: NonNullable<StudioNodeData['generationOptions']>,
    imagePurpose: StudioNodeData['imagePurpose'],
    label: string,
    prompt?: string
  ) => string | null
  deriveVideoAudioPair: (
    sourceNodeId: string,
    operation: StudioVideoAudioTool
  ) => { videoNodeId: string; audioNodeId: string } | null
  addConnection: (connection: Connection, kind?: StudioEdgeKind) => void
  addUserConnection: (connection: Connection, kind?: StudioEdgeKind) => string | undefined
  addUserConnections: (sourceIds: readonly string[], targetId: string, kind?: StudioEdgeKind) => string | undefined
  applyNodeChanges: (changes: NodeChange<StudioCanvasNode>[]) => void
  commitNodePositions: (positions: Array<{ id: string; position: XYPosition }>) => void
  applyEdgeChanges: (changes: EdgeChange<StudioFlowEdge>[]) => void
  beginGraphTransaction: () => void
  commitGraphTransaction: () => void
  selectNodes: (ids: string[]) => void
  clearSelection: () => void
  deleteNodes: (ids: string[]) => void
  deleteEdges: (ids: string[]) => void
  duplicateNodes: (ids?: string[]) => void
  arrangeNodes: (ids: string[], arrangement: StudioArrangement) => void
  tidyCanvas: () => void
  groupNodes: (ids: string[]) => void
  ungroupNodes: (ids: string[]) => void
  moveGroup: (groupId: string, position: XYPosition) => void
  resizeGroup: (groupId: string, frame: { position: XYPosition; width: number; height: number }) => void
  resizeNodeFrame: (nodeId: string, frame: { position: XYPosition; width: number; height: number }) => void
  mergeNodesToGridStoryboard: (ids: string[]) => string | null
  extractGridStoryboardCell: (gridNodeId: string, cellId: string, dropPoint: XYPosition) => string | null
  insertNodeIntoGridStoryboard: (nodeId: string, target: StudioGridStoryboardDropTarget) => boolean
  convertGroupToGridStoryboard: (groupId: string) => string | null
  setGroupColor: (groupId: string, colorTag: string | null) => void
  saveNodesToAssets: (ids: string[]) => number
  attachNodesToChat: (ids: string[]) => void
  clearChatContext: () => void
  updateNodeData: (id: string, patch: Partial<StudioNodeData>, recordHistory?: boolean) => void
  setFrameBreakdownSource: (
    targetNodeId: string,
    source: StudioFrameBreakdownSourceInput,
    recordHistory?: boolean
  ) => boolean
  setNodeLabels: (ids: string[], color?: StudioNodeData['labelColor']) => void
  applyTemplate: (template: StudioTemplate, offset?: XYPosition) => void
  undo: () => void
  redo: () => void
  setViewport: (viewport: Viewport) => void
  setNodeFilter: (filter: NodeFilter) => void
  beginReferencePick: (targetNodeId: string) => void
  cancelReferencePick: () => void
  completeReferencePick: (sourceNodeId: string) => boolean
  removeComposerReference: (targetNodeId: string, refId: string, prompt?: string) => StudioComposerRef | null
  setEdgeKind: (kind: StudioEdgeKind) => void
  setCanvasTool: (tool: StudioCanvasTool) => void
  setMiniMapOpen: (open: boolean) => void
  setHideEdges: (hide: boolean) => void
  setGridSnapEnabled: (enabled: boolean) => void
  setReducedMotion: (value: boolean) => void
  setLeftCollapsed: (value: boolean) => void
  setRightCollapsed: (value: boolean) => void
  openDirector: (nodeId: string) => void
  closeDirector: () => void
  openImageLighting: (nodeId: string) => void
  closeImageLighting: () => void
  openImageMultiAngle: (nodeId: string) => void
  closeImageMultiAngle: () => void
  openImageEditSession: (session: StudioImageEditSession) => void
  patchImageEditSession: (patch: Partial<StudioImageEditSession>) => void
  closeImageEditSession: (expected?: StudioImageEditSession | null) => void
  openVideoEditSession: (input: { nodeId: string; mode: StudioVideoSubtitleMode }) => void
  patchVideoEditSession: (patch: Partial<StudioVideoEditSession>) => void
  closeVideoEditSession: (expected?: StudioVideoEditSession | null) => void
  openVideoClipSession: (input: StudioVideoClipSession) => void
  patchVideoClipSession: (patch: Partial<StudioVideoClipSession>) => void
  closeVideoClipSession: (expected?: StudioVideoClipSession | null) => void
  openTouchEditSession: (input: { nodeId: string }) => void
  patchTouchEditSession: (patch: Partial<StudioTouchEditSession>) => void
  closeTouchEditSession: (expected?: StudioTouchEditSession | null) => void
  openLayerSplitSession: (input: { nodeId: string }) => void
  patchLayerSplitSession: (patch: Partial<StudioLayerSplitSession>) => void
  closeLayerSplitSession: (expected?: StudioLayerSplitSession | null) => void
  upsertTask: (task: StudioTask) => void
  patchTask: (id: string, patch: Partial<StudioTask>) => void
  removeTask: (id: string) => void
  addMessage: (message: Omit<StudioChatMessage, 'id' | 'createdAt'>) => string
  updateMessage: (
    id: string,
    patch: Partial<Omit<StudioChatMessage, 'id' | 'createdAt'>>
  ) => void
  clearMessages: () => void
  setConversation: (conversation: StudioConversationState) => void
  runDiagnostics: () => StudioDiagnostic[]
  setSelectedDiagnostics: (ids: string[]) => void
  repairSelectedDiagnostics: () => void
  setDirectorScene: (scene: DirectorSceneData) => void
  saveCurrentTemplate: (name: string) => void
  deletePersonalTemplate: (id: string) => void
  savePersonalSkill: (name: string, description: string) => void
  deletePersonalSkill: (id: string) => void
  addDirectorCapture: (sourceNodeId: string, mediaUrl: string, title?: string) => string
  addDirectorCaptures: (sourceNodeId: string, items: Array<{ mediaUrl: string; title?: string }>) => string[]
  addDirectorTimelineOutput: (sourceNodeId: string, summary: string) => string
  addDirectorVideoOutput: (sourceNodeId: string, mediaUrl: string, resourceId?: string) => string
  markSaving: () => void
  markSaved: (savedAt: string, revision?: number) => void
  markSaveError: (message: string) => void
}

export function selectStudioTasks(state: StudioUiState): StudioTask[] {
  return state.tasks
}

const emptyViewport: Viewport = { x: 38, y: 72, zoom: 1 }

function cleanSnapshot(state: Pick<StudioUiState, 'nodes' | 'edges' | 'zones' | 'groups'>): StudioWorkspaceSnapshot {
  return {
    nodes: structuredClone(state.nodes).map((node) => ({
      ...node,
      selected: false,
      data: { ...node.data, highlightRefNodeId: undefined }
    })),
    edges: structuredClone(state.edges).map((edge) => ({ ...edge, selected: false })),
    zones: structuredClone(state.zones),
    groups: structuredClone(state.groups)
  }
}

function snapshotEqual(a: StudioWorkspaceSnapshot, b: StudioWorkspaceSnapshot): boolean {
  if (
    a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length ||
    a.zones.length !== b.zones.length || a.groups.length !== b.groups.length
  ) return false
  for (let index = 0; index < a.nodes.length; index += 1) {
    const left = a.nodes[index]
    const right = b.nodes[index]
    if (
      left.id !== right.id || left.type !== right.type ||
      left.position.x !== right.position.x || left.position.y !== right.position.y ||
      left.width !== right.width || left.height !== right.height ||
      left.parentId !== right.parentId || left.hidden !== right.hidden ||
      left.data.updatedAt !== right.data.updatedAt
    ) return false
  }
  for (let index = 0; index < a.edges.length; index += 1) {
    const left = a.edges[index]
    const right = b.edges[index]
    if (
      left.id !== right.id || left.source !== right.source || left.target !== right.target ||
      left.sourceHandle !== right.sourceHandle || left.targetHandle !== right.targetHandle ||
      left.data?.kind !== right.data?.kind || left.data?.label !== right.data?.label
    ) return false
  }
  return JSON.stringify(a.zones) === JSON.stringify(b.zones) && JSON.stringify(a.groups) === JSON.stringify(b.groups)
}

function historyLimit(snapshot: StudioWorkspaceSnapshot): number {
  const count = snapshot.nodes.length
  if (count > 800) return 8
  if (count > 500) return 12
  if (count > 250) return 24
  return 50
}

function appendHistory(
  history: StudioWorkspaceSnapshot[],
  snapshot: StudioWorkspaceSnapshot,
  current: StudioWorkspaceSnapshot
): StudioWorkspaceSnapshot[] {
  return [...history, snapshot].slice(-historyLimit(current))
}

function withRecordedSnapshot(
  state: StudioUiState,
  next: StudioWorkspaceSnapshot,
  baseline = cleanSnapshot(state)
): Partial<StudioUiState> {
  // 连线或底部引用被移除时，排除名单在同一快照里一起清理。
  const recorded = { ...next, nodes: pruneSmartEditDismissals(next.nodes, next.edges) }
  return {
    ...recorded,
    emotionSession: null,
    selectedNodeIds: [],
    activeNodeId: null,
    historyPast: appendHistory(state.historyPast, baseline, recorded),
    historyFuture: [],
    diagnostics: [],
    selectedDiagnosticIds: [],
    dirtyRevision: state.dirtyRevision + 1
  }
}

/** Plan all links against the same draft before publishing one undoable change. */
function planStudioConnections(
  state: StudioUiState,
  connections: readonly Connection[],
  kind: StudioEdgeKind,
  manual: boolean
): { snapshot?: StudioWorkspaceSnapshot; reason?: string } {
  const nodesById = new Map(state.nodes.map(node => [node.id, node]))
  const changedNodes = new Map<string, StudioCanvasNode>()
  let edges = state.edges
  const incomingByTarget = new Map<string, Set<string>>()
  for (const connection of connections) {
    const source = nodesById.get(connection.source)
    const target = nodesById.get(connection.target)
    if (!source || !target) return { reason: manual && connections.length > 1 ? '节点已不存在，请重新选择' : undefined }
    if (source.id === target.id) return { reason: manual && connections.length > 1 ? '请选择框选范围外的目标节点' : undefined }
    if (manual) {
      const reason = studioManualNodeConnectionDisabledReason(source, target, {
        studioMode: state.studioMode,
        nodes: state.nodes,
        edges
      })
      if (reason) return { reason }
    }
    if (!canConnectStudioNodes(source.data.kind, target.data.kind)) return {}
    if (target.data.kind === 'smart_edit' && !isSmartEditSourceCandidate(target.id, source)) {
      return { reason: manual && connections.length > 1 ? '剪辑成片无法引用所选节点' : undefined }
    }

    let incoming = incomingByTarget.get(target.id)
    if (!incoming) {
      incoming = new Set(state.edges.filter(edge => edge.target === target.id).map(edge => edge.source))
      incomingByTarget.set(target.id, incoming)
    }
    const nextTargetData = applyStudioConnectionReference(source, target)
    if (nextTargetData) {
      const updated = { ...target, data: nextTargetData }
      nodesById.set(target.id, updated)
      changedNodes.set(target.id, updated)
    }
    if (!incoming.has(source.id)) {
      incoming.add(source.id)
      if (edges === state.edges) edges = [...edges]
      edges.push(createStudioEdge(source.id, target.id, target.data.kind === 'smart_edit' ? 'reference' : kind, connection))
    }
  }
  if (!changedNodes.size && edges === state.edges) return {}
  return {
    snapshot: {
      nodes: changedNodes.size ? state.nodes.map(node => changedNodes.get(node.id) ?? node) : state.nodes,
      edges,
      zones: state.zones,
      groups: state.groups
    }
  }
}

export const useStudioUiStore = create<StudioUiState>((set, get) => guardStudioReadOnlyActions<StudioUiState>({
  readOnly: false,
  scopeKey: '',
  studioMode: 'free',
  title: 'AID Studio',
  nodes: [],
  edges: [],
  zones: [],
  groups: [],
  viewport: emptyViewport,
  tasks: [],
  messages: [],
  conversation: structuredClone(DEFAULT_STUDIO_CONVERSATION),
  savedAssets: [],
  directorScenes: {},
  personalTemplates: [],
  personalSkills: [],
  reducedMotion: false,
  hydrated: false,
  loading: true,
  loadError: '',
  selectedNodeIds: [],
  activeNodeId: null,
  diagnostics: [],
  selectedDiagnosticIds: [],
  nodeFilter: 'all',
  referencePicker: null,
  edgeKind: 'flow',
  canvasTool: 'select',
  miniMapOpen: false,
  hideEdges: false,
  gridSnapEnabled: true,
  leftCollapsed: true,
  rightCollapsed: true,
  directorOpenNodeId: null,
  imageLightingNodeId: null,
  emotionSession: null,
  imageMultiAngleNodeId: null,
  imageEditSession: null,
  videoEditSession: null,
  videoClipSession: null,
  touchEditSession: null,
  layerSplitSession: null,
  chatContextNodeIds: [],
  dirtyRevision: 0,
  saveStatus: 'idle',
  savedAt: '',
  saveError: '',
  historyPast: [],
  historyFuture: [],
  transactionBaseline: null,

  beginLoad: (scopeKey, options) => set({
    readOnly: options?.readOnly === true,
    scopeKey,
    studioMode: 'free',
    title: 'AID Studio',
    nodes: [],
    edges: [],
    zones: [],
    groups: [],
    tasks: [],
    messages: [],
    conversation: structuredClone(DEFAULT_STUDIO_CONVERSATION),
    savedAssets: [],
    directorScenes: {},
    personalTemplates: [],
    personalSkills: [],
    hydrated: false,
    loading: true,
    loadError: '',
    selectedNodeIds: [],
    activeNodeId: null,
    diagnostics: [],
    selectedDiagnosticIds: [],
    nodeFilter: 'all',
    referencePicker: null,
    historyPast: [],
    historyFuture: [],
    transactionBaseline: null,
    directorOpenNodeId: null,
    imageLightingNodeId: null,
    emotionSession: null,
    imageMultiAngleNodeId: null,
    imageEditSession: null,
    videoEditSession: null,
    videoClipSession: null,
    touchEditSession: null,
    layerSplitSession: null,
    chatContextNodeIds: [],
    canvasTool: 'select',
    miniMapOpen: false,
    hideEdges: false,
    gridSnapEnabled: true,
    leftCollapsed: true,
    rightCollapsed: true
  }),

  hydrate: (workspace, options) => {
    const previous = get()
    const readOnly = options?.readOnly ?? previous.readOnly
    const preserveConversationUi = !readOnly && previous.hydrated && previous.scopeKey === workspace.scopeKey
      && previous.studioMode === 'free' && (workspace.studioMode ?? 'free') === 'free'
    // Authoritative refresh replaces business data, not the user's current editing session.
    // Initial load, explicit replacement and project/mode changes still reset interaction state.
    const reconcileInteraction = options?.reconcileInteraction === true && preserveConversationUi
    const previousNodes = new Map(previous.nodes.map(node => [node.id, node]))
    const availableNodes = new Map(workspace.nodes.map(node => [node.id, node]))
    const retainsNode = (id: string | null | undefined) => Boolean(reconcileInteraction && id
      && availableNodes.has(id) && availableNodes.get(id)?.data.kind === previousNodes.get(id)?.data.kind)
    const retainSession = <T extends { nodeId: string }>(session: T | null): T | null =>
      session && retainsNode(session.nodeId) ? session : null
    const availableSelectionIds = new Set([...availableNodes.keys(), ...(workspace.groups ?? []).map(group => group.id)])
    const selectedNodeIds = reconcileInteraction ? previous.selectedNodeIds.filter(id => availableSelectionIds.has(id)) : []
    const selectedIds = new Set(selectedNodeIds)
    const localEditJobs = new Map(previous.scopeKey === workspace.scopeKey
      ? previous.nodes.flatMap((node) => node.data.kind === 'smart_edit' && node.data.smartEdit?.jobId ? [[node.id, node.data.smartEdit.jobId] as const] : [])
      : [])
    // 普通素材生成的终态会刷新整个服务端快照。只保留本页仍在运行的剪辑身份，
    // 时间轴内容仍来自权威快照；刷新页面/切换项目不能复活旧作业。
    const nodes = assignStudioMediaSequenceTitles(workspace.nodes.map((node) => {
      const jobId = localEditJobs.get(node.id)
      const localOptions = retainsNode(node.id) ? previousNodes.get(node.id)?.data.imageToolOptions : undefined
      const data = { ...node.data,
        ...(localOptions?.sourceNodeId === node.id ? { imageToolOptions: localOptions } : {}),
        ...(node.data.kind === 'director' && node.data.title === '预演台' ? { title: '3D预演' } : {}),
        ...(jobId && node.data.smartEdit ? { status: 'generating' as const, smartEdit: { ...node.data.smartEdit, jobId } } : {}) }
      return { ...node, ...(readOnly ? { hidden: false } : {}), selected: selectedIds.has(node.id), data }
    }))
    const openDirector = preserveConversationUi
      ? previous.nodes.find(node => node.id === previous.directorOpenNodeId && node.data.kind === 'director')
      : undefined
    const directorSceneId = openDirector?.data.directorSceneId
    const retainedDirector = openDirector && directorSceneId && workspace.directorScenes[directorSceneId]
      && nodes.some(node => node.id === openDirector.id && node.data.directorSceneId === directorSceneId)
    set({
      scopeKey: workspace.scopeKey,
      readOnly,
      studioMode: workspace.studioMode ?? 'free',
      title: workspace.title,
      nodes,
      edges: patchStudioGeneratingEdges(workspace.edges, nodes),
      zones: workspace.zones,
      groups: workspace.groups ?? [],
      viewport: reconcileInteraction ? previous.viewport : workspace.viewport ?? (workspace.studioMode === 'flow' ? { ...emptyViewport, zoom: 0.78 } : emptyViewport),
      tasks: workspace.tasks.filter(task => task.resultKind !== 'director_space' && task.remoteTaskType !== 'director_space_gen'),
      messages: localEditJobs.size ? previous.messages : workspace.messages,
      conversation: workspace.conversation ?? structuredClone(DEFAULT_STUDIO_CONVERSATION),
      savedAssets: workspace.savedAssets ?? [],
      directorScenes: workspace.directorScenes,
      personalTemplates: workspace.personalTemplates ?? [],
      personalSkills: workspace.personalSkills ?? [],
      reducedMotion: reconcileInteraction ? previous.reducedMotion : false,
      hydrated: true,
      loading: false,
      loadError: '',
      selectedNodeIds,
      activeNodeId: reconcileInteraction && previous.activeNodeId && availableSelectionIds.has(previous.activeNodeId) ? previous.activeNodeId : null,
      diagnostics: [],
      selectedDiagnosticIds: [],
      nodeFilter: reconcileInteraction ? previous.nodeFilter : 'all',
      referencePicker: retainsNode(previous.referencePicker?.targetNodeId) ? previous.referencePicker : null,
      dirtyRevision: 0,
      saveStatus: 'saved',
      savedAt: workspace.savedAt,
      saveError: '',
      historyPast: [],
      historyFuture: [],
      transactionBaseline: null,
      directorOpenNodeId: retainedDirector ? openDirector.id : null,
      imageLightingNodeId: retainsNode(previous.imageLightingNodeId) ? previous.imageLightingNodeId : null,
      emotionSession: retainSession(previous.emotionSession),
      imageMultiAngleNodeId: retainsNode(previous.imageMultiAngleNodeId) ? previous.imageMultiAngleNodeId : null,
      imageEditSession: retainSession(previous.imageEditSession),
      videoEditSession: retainSession(previous.videoEditSession),
      videoClipSession: retainSession(previous.videoClipSession),
      touchEditSession: retainSession(previous.touchEditSession),
      layerSplitSession: retainSession(previous.layerSplitSession),
      chatContextNodeIds: preserveConversationUi ? previous.chatContextNodeIds.filter((id) => nodes.some((node) => node.id === id)) : [],
      canvasTool: reconcileInteraction ? previous.canvasTool : 'select',
      miniMapOpen: reconcileInteraction ? previous.miniMapOpen : false,
      hideEdges: reconcileInteraction ? previous.hideEdges : false,
      gridSnapEnabled: reconcileInteraction ? previous.gridSnapEnabled : true,
      leftCollapsed: reconcileInteraction ? previous.leftCollapsed : true,
      rightCollapsed: preserveConversationUi ? previous.rightCollapsed : true
    })
  },

  setStudioMode: (studioMode) => set((state) => ({
    studioMode,
    emotionSession: null,
    referencePicker: null,
    nodeFilter: state.referencePicker?.previousNodeFilter ?? state.nodeFilter,
    zones: studioMode === 'flow' ? (state.zones.length ? state.zones : structuredClone(DEFAULT_STUDIO_ZONES)) : [],
    dirtyRevision: state.dirtyRevision + 1
  })),
  setLoadError: (message) => set({ loading: false, loadError: message }),
  setTitle: (title, markDirty = true) => set((state) => ({
    title,
    dirtyRevision: markDirty ? state.dirtyRevision + 1 : state.dirtyRevision
  })),

  addNode: (kind, position = { x: 80, y: 80 }, options = {}, connection) => {
    let nodeOptions = options
    let pendingScene: DirectorSceneData | null = null
    if (kind === 'director' && !options.directorSceneId) {
      const scene = createDefaultDirectorScene()
      scene.name = '主场景'
      pendingScene = scene
      nodeOptions = { title: '3D预演', ...options, directorSceneId: scene.id }
    }
    const currentNodes = get().nodes
    const sequencedNodes = kind === 'image' || kind === 'video'
      ? assignStudioMediaSequenceTitles(currentNodes)
      : currentNodes
    if ((kind === 'image' || kind === 'video') && (!nodeOptions.title || nodeOptions.title === STUDIO_NODE_META[kind].label)) {
      nodeOptions = { ...nodeOptions, title: nextStudioMediaTitle(kind, sequencedNodes) }
    }
    const draft = createStudioNode(kind, position, nodeOptions)
    const size = studioNodeDimensions(draft)
    const occupied = sequencedNodes.map((item) => toStudioNodeRect(item))
    const safePosition = placeStudioNodeWithoutOverlap(position, size, occupied)
    let node = safePosition.x === position.x && safePosition.y === position.y
      ? draft
      : { ...draft, position: safePosition }
    const state = get()
    const neighbor = connection && state.nodes.find((item) => item.id === connection.nodeId)
    const source = neighbor && connection?.role === 'target' ? node : neighbor
    const target = neighbor && connection?.role === 'target' ? neighbor : node
    const connected = Boolean(source && target && canConnectStudioNodes(source.data.kind, target.data.kind) && (target.data.kind !== 'smart_edit' || isSmartEditSourceCandidate(target.id, source)))
    const targetData = connected && source && target ? applyStudioConnectionReference(source, target) : null
    if (targetData && target?.id === node.id) node = { ...node, data: targetData }
    const nextNodes = [
      ...sequencedNodes.map((item) => {
        if (targetData && item.id === target?.id) return { ...item, data: targetData, selected: false }
        return item.selected ? { ...item, selected: false } : item
      }),
      { ...node, selected: true }
    ]
    const nextEdges = connected && source && target
      ? [...state.edges, createStudioEdge(source.id, target.id, connection?.kind ?? state.edgeKind)]
      : state.edges
    set({
      ...withRecordedSnapshot(state, {
        nodes: nextNodes,
        edges: nextEdges,
        zones: state.zones,
        groups: state.groups
      }),
      selectedNodeIds: [node.id],
      activeNodeId: node.id,
      chatContextNodeIds: [node.id]
    })
    if (pendingScene) get().setDirectorScene(pendingScene)
    return node.id
  },

  addUserNode: (kind, position, options, connection) => {
    const state = get()
    if (state.studioMode !== 'free') return null
    const neighbor = connection && state.nodes.find(node => node.id === connection.nodeId)
    if (connection) {
      const endpoint = { data: { kind } }
      if (!neighbor || (connection.role === 'source'
        ? studioManualNodeConnectionDisabledReason(neighbor, endpoint, state)
        : studioManualNodeConnectionDisabledReason(endpoint, neighbor, state))) return null
    }
    const anchor = neighbor ?? (position == null
      ? state.nodes.find(node => node.id === state.activeNodeId) ?? state.nodes.at(-1)
      : undefined)
    const alignedPosition = anchor
      ? placeStudioNodeBeside(
        toStudioNodeRect(anchor),
        STUDIO_NODE_DEFAULT_DIMENSIONS[kind],
        state.nodes.map(toStudioNodeRect),
        connection?.role === 'target' ? 'left' : 'right'
      )
      : position
    return get().addNode(kind, alignedPosition, options, connection)
  },

  applyEmptyPreset: (anchorNodeId, presetId, roleOverrides) => {
    const state = get()
    if (state.studioMode !== 'free') return null
    const result = applyStudioEmptyPreset({
      snapshot: state,
      anchorNodeId,
      presetId,
      roleOverrides
    })
    if (!result) return null
    set({
      ...withRecordedSnapshot(state, result.snapshot),
      selectedNodeIds: [result.selectedNodeId],
      activeNodeId: result.selectedNodeId,
      chatContextNodeIds: [result.selectedNodeId]
    })
    return result.selectedNodeId
  },

  deriveAudioNodes: (sourceNodeId, options, select = true) => {
    const state = get()
    const source = state.nodes.find((node) => node.id === sourceNodeId)
    if (!source || source.data.flowBinding || !source.data.mediaUrl || !options.length || options.length > 16) return []
    const occupied = state.nodes.map(toStudioNodeRect)
    const nodes = options.map((data, index) => {
      const desired = { x: source.position.x + studioNodeDimensions(source).width + 70, y: source.position.y + index * 150 }
      const draft = createStudioNode('voice', desired, { ...data, mediaKind: 'audio', zoneId: source.data.zoneId })
      const size = studioNodeDimensions(draft)
      const position = placeStudioNodeWithoutOverlap(desired, size, occupied)
      occupied.push({ ...position, ...size })
      return { ...draft, position, selected: select && index === 0 }
    })
    set({
      ...withRecordedSnapshot(state, {
        nodes: [...state.nodes.map((node) => select ? { ...node, selected: false } : node), ...nodes],
        edges: [...state.edges, ...nodes.map((node) => createStudioEdge(source.id, node.id, 'reference'))],
        zones: state.zones, groups: state.groups
      }),
      ...(select ? { selectedNodeIds: [nodes[0].id], activeNodeId: nodes[0].id, chatContextNodeIds: [nodes[0].id] } : {})
    })
    return nodes.map((node) => node.id)
  },

  deriveImageNode: (sourceNodeId, generationOptions, imagePurpose, label, prompt) => {
    const state = get()
    const source = state.nodes.find((node) => node.id === sourceNodeId)
    if (!source || source.data.kind !== 'image' || source.data.flowBinding) return null
    const siblingCount = state.edges.filter((edge) => edge.source === source.id).length
    const desired = {
      x: source.position.x + 310,
      y: source.position.y + siblingCount * 42
    }
    const draft = createStudioNode('image', desired, {
      title: `${source.data.title} · ${label}`,
      subtitle: `由 ${source.data.title} 派生`,
      zoneId: source.data.zoneId,
      status: 'queued',
      prompt: prompt?.trim() || source.data.prompt,
      imagePurpose,
      model: source.data.model,
      modelName: source.data.modelName,
      modelCostCredits: source.data.modelCostCredits,
      modelIsFree: source.data.modelIsFree,
      // Image tools create terminal result nodes. The source node remains the
      // editable entry point while the derived node keeps its media toolbar.
      composerHidden: true,
      composerRefs: [studioNodeToComposerRef(source)],
      generationOptions: structuredClone(generationOptions),
      // 继承源节点任务绑定，避免自由画布派生节点再次要求「分镜」
      storyboardId: source.data.storyboardId,
      mediaUrl: undefined,
      resultSummary: undefined,
      errorMessage: undefined
    })
    const size = studioNodeDimensions(draft)
    const occupied = state.nodes.map((item) => toStudioNodeRect(item))
    const safePosition = placeStudioNodeWithoutOverlap(desired, size, occupied)
    const derived = { ...draft, position: safePosition }
    // 派生只影响目标节点；不污染源节点的 purpose / generationOptions
    const nodes = [
      ...state.nodes.map((node) => (
        node.id === source.id
          ? { ...source, selected: false }
          : { ...node, selected: false }
      )),
      { ...derived, selected: true }
    ]
    set({
      ...withRecordedSnapshot(state, {
        nodes,
        edges: [...state.edges, createStudioEdge(source.id, derived.id, 'reference')],
        zones: state.zones,
        groups: state.groups
      }),
      selectedNodeIds: [derived.id],
      activeNodeId: derived.id,
      chatContextNodeIds: [derived.id]
    })
    return derived.id
  },

  deriveVideoAudioPair: (sourceNodeId, operation) => {
    const state = get()
    const source = state.nodes.find((node) => node.id === sourceNodeId)
    const sourceVideoUrl = String(source?.data.mediaUrl || '').trim()
    if (!source || source.data.kind !== 'video' || source.data.flowBinding || !sourceVideoUrl) return null

    const definition = studioVideoAudioToolDefinition(operation)
    const summary = `${definition.label}中`
    const groupId = studioId('media-pair')
    const sourceRecordIdValue = Number(source.data.recordId ?? source.data.genRecordId)
    const sourceRecordId = Number.isFinite(sourceRecordIdValue) && sourceRecordIdValue > 0
      ? sourceRecordIdValue
      : undefined
    const occupied = state.nodes.map((node) => toStudioNodeRect(node))
    const desiredVideoPosition = { x: source.position.x + studioNodeDimensions(source).width + 70, y: source.position.y }
    const videoDraft = createStudioNode('video', desiredVideoPosition, {
      title: `${source.data.title}-${definition.videoTitleSuffix}`,
      subtitle: `由 ${source.data.title} 派生`,
      zoneId: source.data.zoneId,
      status: 'generating',
      mediaKind: 'video',
      videoPurpose: definition.videoPurpose,
      composerHidden: true,
      storyboardId: source.data.storyboardId,
      resultSummary: summary
    })
    const videoSize = studioNodeDimensions(videoDraft)
    const videoPosition = placeStudioNodeWithoutOverlap(desiredVideoPosition, videoSize, occupied)
    const videoNode = { ...videoDraft, position: videoPosition }
    occupied.push({ ...videoPosition, ...videoSize })

    const desiredAudioPosition = { x: videoPosition.x, y: videoPosition.y + videoSize.height + 42 }
    const audioDraft = createStudioNode('voice', desiredAudioPosition, {
      title: `${source.data.title}-${definition.audioTitleSuffix}`,
      subtitle: `由 ${source.data.title} 派生`,
      zoneId: source.data.zoneId,
      status: 'generating',
      mediaKind: 'audio',
      composerHidden: true,
      storyboardId: source.data.storyboardId,
      resultSummary: summary
    })
    const audioSize = studioNodeDimensions({
      ...audioDraft,
      data: {
        ...audioDraft.data,
        mediaDerivation: {
          groupId,
          sourceNodeId: source.id,
          sourceVideoUrl,
          sourceRecordId,
          operation,
          outputRole: 'audio',
          pairedNodeId: videoNode.id
        }
      }
    })
    const audioPosition = placeStudioNodeWithoutOverlap(desiredAudioPosition, audioSize, occupied)
    const sharedDerivation = { groupId, sourceNodeId: source.id, sourceVideoUrl, sourceRecordId, operation }
    const derivedVideo = {
      ...videoNode,
      selected: true,
      data: {
        ...videoNode.data,
        mediaDerivation: { ...sharedDerivation, outputRole: 'video' as const, pairedNodeId: audioDraft.id }
      }
    }
    const derivedAudio = {
      ...audioDraft,
      position: audioPosition,
      selected: true,
      data: {
        ...audioDraft.data,
        mediaDerivation: { ...sharedDerivation, outputRole: 'audio' as const, pairedNodeId: videoNode.id }
      }
    }
    set({
      ...withRecordedSnapshot(state, {
        nodes: [
          ...state.nodes.map((node) => ({ ...node, selected: false })),
          derivedVideo,
          derivedAudio
        ],
        edges: [
          ...state.edges,
          createStudioEdge(source.id, derivedVideo.id, 'reference'),
          createStudioEdge(source.id, derivedAudio.id, 'reference')
        ],
        zones: state.zones,
        groups: state.groups
      }),
      selectedNodeIds: [derivedVideo.id, derivedAudio.id],
      activeNodeId: derivedAudio.id,
      chatContextNodeIds: [derivedVideo.id, derivedAudio.id]
    })
    return { videoNodeId: derivedVideo.id, audioNodeId: derivedAudio.id }
  },

  addUserConnection: (connection, kind) => {
    const state = get()
    const { snapshot, reason } = planStudioConnections(state, [connection], kind ?? state.edgeKind, true)
    if (snapshot) set(withRecordedSnapshot(state, snapshot))
    return reason
  },

  addUserConnections: (sourceIds, targetId, kind) => {
    const state = get()
    const connections = [...new Set(sourceIds)].map(source => ({
      source, target: targetId, sourceHandle: null, targetHandle: null
    }))
    const { snapshot, reason } = planStudioConnections(state, connections, kind ?? state.edgeKind, true)
    if (snapshot) set(withRecordedSnapshot(state, snapshot))
    return reason
  },

  addConnection: (connection, kind) => {
    const state = get()
    const { snapshot } = planStudioConnections(state, [connection], kind ?? state.edgeKind, false)
    if (snapshot) set(withRecordedSnapshot(state, snapshot))
  },

  applyNodeChanges: (changes) => {
    if (get().readOnly) {
      const selected = new Set(get().selectedNodeIds)
      for (const change of changes) {
        if (change.type !== 'select') continue
        if (change.selected) selected.add(change.id)
        else selected.delete(change.id)
      }
      get().selectNodes([...selected])
      return
    }
    if (!changes.length) return
    set((state) => {
      const boundIds = new Set(state.nodes.flatMap((node) => node.data.flowBinding ? [node.id] : []))
      const semanticChanges = changes.filter((change) =>
        change.type !== 'position' && !(change.type === 'remove' && boundIds.has(change.id))
      )
      if (!semanticChanges.length) return state
      const nodes = pruneSmartEditDismissals(invalidateMissingSmartEditSources(applyNodeChanges(semanticChanges, state.nodes)), state.edges)
      const selectedNodeIds = nodes.filter((node) => node.selected).map((node) => node.id)
      return {
        nodes,
        selectedNodeIds,
        activeNodeId: selectedNodeIds.at(-1) ?? null,
        chatContextNodeIds: selectedNodeIds,
        emotionSession: selectedNodeIds.length === 1 && selectedNodeIds[0] === state.emotionSession?.nodeId ? state.emotionSession : null
      }
    })
  },

  commitNodePositions: (positions) => {
    if (!positions.length) return
    const state = get()
    const byId = new Map(positions.map((item) => [item.id, item.position]))
    const nodes = state.nodes.map((node) => {
      const position = byId.get(node.id)
      return position ? { ...node, position } : node
    })
    const groups = recalculateStudioGroups(nodes, state.groups)
    const baseline = state.transactionBaseline ?? cleanSnapshot(state)
    const next = { nodes, edges: state.edges, zones: state.zones, groups }
    if (snapshotEqual(baseline, next)) {
      set({ transactionBaseline: null })
      return
    }
    set({
      ...next,
      transactionBaseline: null,
      historyPast: appendHistory(state.historyPast, baseline, next),
      historyFuture: [],
      dirtyRevision: state.dirtyRevision + 1
    })
  },

  applyEdgeChanges: (changes) => {
    set((state) => {
      const managedIds = new Set(state.edges.flatMap((edge) => edge.data?.flowManaged ? [edge.id] : []))
      const allowed = changes.filter((change) => !(change.type === 'remove' && managedIds.has(change.id)))
      if (!allowed.length) return state
      const edges = applyEdgeChanges(allowed, state.edges)
      return { edges, nodes: pruneSmartEditDismissals(state.nodes, edges) }
    })
  },

  beginGraphTransaction: () => {
    if (get().transactionBaseline) return
    set({ transactionBaseline: cleanSnapshot(get()) })
  },

  commitGraphTransaction: () => {
    const state = get()
    const baseline = state.transactionBaseline
    if (!baseline) return
    const current = cleanSnapshot(state)
    if (snapshotEqual(baseline, current)) {
      set({ transactionBaseline: null })
      return
    }
    set({
      transactionBaseline: null,
      historyPast: appendHistory(state.historyPast, baseline, current),
      historyFuture: []
    })
  },

  selectNodes: (ids) => {
    const selected = new Set(ids)
    set((state) => {
      const activeNodeId = ids.at(-1) ?? null
      const selectedIds = [...ids]
      const idsUnchanged = selectedIds.length === state.selectedNodeIds.length &&
        selectedIds.every((id, index) => id === state.selectedNodeIds[index])
      const contextUnchanged = selectedIds.length === state.chatContextNodeIds.length &&
        selectedIds.every((id, index) => id === state.chatContextNodeIds[index])
      const nodesUnchanged = state.nodes.every((node) => Boolean(node.selected) === selected.has(node.id))
      const sessionMismatch = Boolean(
        (state.emotionSession && (state.emotionSession.nodeId !== activeNodeId || ids.length !== 1))
        || (state.imageEditSession && state.imageEditSession.nodeId !== activeNodeId)
        || (state.videoEditSession && state.videoEditSession.nodeId !== activeNodeId)
        || (state.videoClipSession && state.videoClipSession.nodeId !== activeNodeId)
        || (state.touchEditSession && state.touchEditSession.nodeId !== activeNodeId)
        || (state.layerSplitSession && state.layerSplitSession.nodeId !== activeNodeId)
      )
      if (idsUnchanged && nodesUnchanged && contextUnchanged && state.activeNodeId === activeNodeId && !sessionMismatch) {
        return state
      }
      return {
        nodes: state.nodes.map((node) => {
          const isSelected = selected.has(node.id)
          return Boolean(node.selected) === isSelected ? node : { ...node, selected: isSelected }
        }),
        selectedNodeIds: selectedIds,
        activeNodeId,
        chatContextNodeIds: selectedIds,
        emotionSession: ids.length === 1 && state.emotionSession?.nodeId === activeNodeId ? state.emotionSession : null,
        imageLightingNodeId: activeNodeId && state.imageLightingNodeId === activeNodeId
          ? state.imageLightingNodeId
          : null,
        imageMultiAngleNodeId: activeNodeId && state.imageMultiAngleNodeId === activeNodeId
          ? state.imageMultiAngleNodeId
          : null,
        imageEditSession: activeNodeId && state.imageEditSession?.nodeId === activeNodeId
          ? state.imageEditSession
          : null,
        videoEditSession: activeNodeId && state.videoEditSession?.nodeId === activeNodeId
          ? state.videoEditSession
          : null,
        videoClipSession: activeNodeId && state.videoClipSession?.nodeId === activeNodeId
          ? state.videoClipSession
          : null,
        touchEditSession: activeNodeId && state.touchEditSession?.nodeId === activeNodeId
          ? state.touchEditSession
          : null,
        layerSplitSession: activeNodeId && state.layerSplitSession?.nodeId === activeNodeId
          ? state.layerSplitSession
          : null
      }
    })
  },

  clearSelection: () => {
    set((state) => {
      const hasSelection = state.selectedNodeIds.length > 0 || state.activeNodeId !== null ||
        state.chatContextNodeIds.length > 0 ||
        state.nodes.some((node) => node.selected) || state.edges.some((edge) => edge.selected)
      if (!hasSelection) return state
      return {
        nodes: state.nodes.map((node) => {
          const clearHighlight = node.id === state.activeNodeId && node.data.highlightRefNodeId
          if (!node.selected && !clearHighlight) return node
          return {
            ...node,
            selected: false,
            data: clearHighlight ? { ...node.data, highlightRefNodeId: undefined } : node.data
          }
        }),
        edges: state.edges.map((edge) => (edge.selected ? { ...edge, selected: false } : edge)),
        selectedNodeIds: [],
        activeNodeId: null,
        chatContextNodeIds: [],
        imageLightingNodeId: null,
        emotionSession: null,
        imageMultiAngleNodeId: null,
        imageEditSession: null,
        videoEditSession: null,
        videoClipSession: null,
        touchEditSession: null,
        layerSplitSession: null
      }
    })
  },

  deleteNodes: (ids) => {
    if (ids.includes(get().emotionSession?.nodeId ?? '')) set({ emotionSession: null })
    const state = get()
    const removing = new Set(ids.filter((id) =>
      !state.nodes.find((node) => node.id === id)?.data.flowBinding
    ))
    if (!removing.size) return
    const removedNodes = state.nodes.filter((node) => removing.has(node.id))
    const remainingNodes = state.nodes.filter((node) => !removing.has(node.id)).map((node) => {
      if (node.data.smartEdit) {
        let smartEdit = node.data.smartEdit
        for (const clip of smartEditMediaClips(smartEdit.timeline)) {
          if (removing.has(clip.sourceNodeId)) smartEdit = applySmartEditCommand(smartEdit, { type: 'markInvalid', clipId: clip.id, invalid: true })
        }
        if (smartEdit !== node.data.smartEdit) node = { ...node, data: { ...node.data, smartEdit } }
      }
      if (!node.data.storyboardAssets?.some((asset) => removing.has(asset.nodeId))) return node
      return {
        ...node,
        data: {
          ...node.data,
          storyboardAssets: node.data.storyboardAssets.filter((asset) => !removing.has(asset.nodeId)),
          updatedAt: new Date().toISOString()
        }
      }
    })
    set({
      ...withRecordedSnapshot(state, {
        nodes: remainingNodes,
        edges: state.edges.filter((edge) => !removing.has(edge.source) && !removing.has(edge.target)),
        zones: state.zones,
        groups: recalculateStudioGroups(
          remainingNodes,
          state.groups
        )
      }),
      videoEditSession: state.videoEditSession && removing.has(state.videoEditSession.nodeId)
        ? null
        : state.videoEditSession,
      videoClipSession: state.videoClipSession && removing.has(state.videoClipSession.nodeId)
        ? null
        : state.videoClipSession
    })
    revokeObjectUrls(collectStudioNodeBlobUrls(removedNodes))
  },

  deleteEdges: (ids) => {
    const state = get()
    const removing = new Set(ids.filter((id) =>
      !state.edges.find((edge) => edge.id === id)?.data?.flowManaged
    ))
    if (!removing.size) return
    const removedEdges = state.edges.filter((edge) => removing.has(edge.id))
    let nodes = state.nodes
    for (const edge of removedEdges) {
      const source = nodes.find((node) => node.id === edge.source)
      const target = nodes.find((node) => node.id === edge.target)
      if (!source || !target) continue
      const nextTargetData = clearStudioConnectionReference(source, target)
      if (!nextTargetData) continue
      nodes = nodes.map((node) => node.id !== target.id ? node : { ...node, data: nextTargetData })
    }
    set(withRecordedSnapshot(state, {
      nodes,
      edges: state.edges.filter((edge) => !removing.has(edge.id)),
      zones: state.zones,
      groups: state.groups
    }))
  },

  duplicateNodes: (ids) => {
    const state = get()
    const requestedIds = ids?.length ? ids : state.selectedNodeIds
    const selectedIds = requestedIds.filter((id) =>
      !state.nodes.find((node) => node.id === id)?.data.flowBinding
    )
    const copies = duplicateStudioNodes(state.nodes, state.edges, selectedIds)
    if (!copies.nodes.length) return
    set(withRecordedSnapshot(state, {
      nodes: [
        ...state.nodes.map((node) => ({ ...node, selected: false })),
        ...copies.nodes
      ],
      edges: [...state.edges, ...copies.edges],
      zones: state.zones,
      groups: state.groups
    }))
    set({ selectedNodeIds: copies.newIds, activeNodeId: copies.newIds.at(-1) ?? null, chatContextNodeIds: copies.newIds })
  },

  arrangeNodes: (ids, arrangement) => {
    const state = get()
    const nodes = arrangeStudioNodes(state.nodes, ids, arrangement)
    if (nodes === state.nodes) return
    const selected = new Set(ids)
    set(withRecordedSnapshot(state, {
      nodes: nodes.map((node) => ({ ...node, selected: selected.has(node.id) })),
      edges: state.edges,
      zones: state.zones,
      groups: recalculateStudioGroups(nodes, state.groups)
    }))
    set({ selectedNodeIds: ids, activeNodeId: ids.at(-1) ?? null, chatContextNodeIds: ids })
  },

  tidyCanvas: () => {
    const state = get()
    const nodes = tidyStudioCanvasNodes(state.nodes, state.edges, state.studioMode)
    if (nodes === state.nodes) return
    set(withRecordedSnapshot(state, {
      nodes,
      edges: state.edges,
      zones: state.zones,
      groups: recalculateStudioGroups(nodes, state.groups)
    }))
  },

  groupNodes: (ids) => {
    const state = get()
    const result = groupStudioNodes(state.nodes, state.groups, ids)
    if (!result.groupId) return
    set(withRecordedSnapshot(state, {
      nodes: result.nodes,
      edges: state.edges,
      zones: state.zones,
      groups: result.groups
    }))
    get().selectNodes(ids)
  },

  ungroupNodes: (ids) => {
    const state = get()
    const result = ungroupStudioNodes(state.nodes, state.groups, ids)
    if (!result.removedGroupIds.length) return
    set(withRecordedSnapshot(state, {
      nodes: result.nodes,
      edges: state.edges,
      zones: state.zones,
      groups: result.groups
    }))
    const remaining = ids.filter((id) => result.nodes.some((node) => node.id === id))
    get().selectNodes(remaining)
  },

  moveGroup: (groupId, position) => {
    const state = get()
    const result = moveStudioGroup(state.nodes, state.groups, groupId, position)
    const baseline = state.transactionBaseline ?? cleanSnapshot(state)
    const next = {
      nodes: result.nodes,
      edges: state.edges,
      zones: state.zones,
      groups: result.groups
    }
    if (snapshotEqual(baseline, next)) {
      set({ transactionBaseline: null })
      return
    }
    set({
      ...next,
      transactionBaseline: null,
      historyPast: appendHistory(state.historyPast, baseline, next),
      historyFuture: [],
      dirtyRevision: state.dirtyRevision + 1
    })
  },

  resizeGroup: (groupId, frame) => {
    const state = get()
    const groups = resizeStudioGroup(state.nodes, state.groups, groupId, frame)
    const baseline = state.transactionBaseline ?? cleanSnapshot(state)
    const next = { nodes: state.nodes, edges: state.edges, zones: state.zones, groups }
    if (snapshotEqual(baseline, next)) {
      set({ transactionBaseline: null })
      return
    }
    set({
      ...next,
      transactionBaseline: null,
      historyPast: appendHistory(state.historyPast, baseline, next),
      historyFuture: [],
      dirtyRevision: state.dirtyRevision + 1
    })
  },

  resizeNodeFrame: (nodeId, frame) => {
    const state = get()
    const target = state.nodes.find((node) => node.id === nodeId)
    const resizable = target && (
      (target.data.kind === 'text' && target.data.textEditingEnabled)
      || (target.data.kind === 'image' && target.data.imagePurpose === 'grid_storyboard' && target.data.gridStoryboard)
    )
    if (!target || !resizable) return
    const requestedWidth = Number.isFinite(frame.width) ? frame.width : studioNodeDimensions(target).width
    const requestedHeight = Number.isFinite(frame.height) ? frame.height : studioNodeDimensions(target).height
    const gridStoryboard = target.data.kind === 'image' && target.data.imagePurpose === 'grid_storyboard'
    const width = Math.max(gridStoryboard ? 280 : 240, Math.min(960, requestedWidth))
    const height = Math.max(
      gridStoryboard ? STUDIO_GRID_STORYBOARD_MIN_HEIGHT : 220,
      Math.min(gridStoryboard ? STUDIO_GRID_STORYBOARD_MAX_HEIGHT : 900, requestedHeight)
    )
    const position = {
      x: Number.isFinite(frame.position.x) ? frame.position.x : target.position.x,
      y: Number.isFinite(frame.position.y) ? frame.position.y : target.position.y
    }
    const currentSize = studioNodeDimensions(target)
    if (
      position.x === target.position.x
      && position.y === target.position.y
      && width === currentSize.width
      && height === currentSize.height
    ) {
      set({ transactionBaseline: null })
      return
    }
    const now = new Date().toISOString()
    const nodes = state.nodes.map((node) => node.id === nodeId
      ? {
          ...node,
          position,
          data: { ...node.data, displayWidth: width, displayHeight: height, updatedAt: now }
        }
      : node)
    const edges = patchStudioGeneratingEdges(state.edges, nodes)
    const groups = recalculateStudioGroups(nodes, state.groups)
    const baseline = state.transactionBaseline ?? cleanSnapshot(state)
    const next = { nodes, edges, zones: state.zones, groups }
    if (snapshotEqual(baseline, next)) {
      set({ transactionBaseline: null })
      return
    }
    set({
      ...next,
      transactionBaseline: null,
      historyPast: appendHistory(state.historyPast, baseline, next),
      historyFuture: [],
      dirtyRevision: state.dirtyRevision + 1
    })
  },

  mergeNodesToGridStoryboard: (ids) => {
    const state = get()
    const idSet = new Set(ids)
    const selected = state.nodes.filter((node) => idSet.has(node.id) && !node.data.flowBinding)
    const built = buildMergedGridStoryboardFromNodes(selected)
    if (!built) return null

    const removing = new Set(built.removeNodeIds)
    const removedNodes = state.nodes.filter((node) => removing.has(node.id))
    const remainingNodes = state.nodes.filter((node) => !removing.has(node.id)).map((node) => {
      if (!node.data.storyboardAssets?.some((asset) => removing.has(asset.nodeId))) return node
      return {
        ...node,
        data: {
          ...node.data,
          storyboardAssets: node.data.storyboardAssets.filter((asset) => !removing.has(asset.nodeId)),
          updatedAt: new Date().toISOString()
        }
      }
    })
    const remainingEdges = state.edges.filter(
      (edge) => !removing.has(edge.source) && !removing.has(edge.target)
    )
    const remainingGroups = state.groups
      .map((group) => ({
        ...group,
        childIds: group.childIds.filter((id) => !removing.has(id))
      }))
      .filter((group) => group.childIds.length >= 2)

    const draft = createStudioNode('image', built.position, {
      title: built.title,
      subtitle: `${built.rows}×${built.columns} 宫格`,
      status: 'success',
      mediaKind: 'image',
      imagePurpose: 'grid_storyboard',
      gridStoryboard: built.gridStoryboard,
      prompt: '',
      resultSummary: built.title
    })
    const size = studioNodeDimensions(draft)
    const occupied = remainingNodes.map((item) => toStudioNodeRect(item))
    const safePosition = placeStudioNodeWithoutOverlap(built.position, size, occupied)
    const newNode = safePosition.x === built.position.x && safePosition.y === built.position.y
      ? draft
      : { ...draft, position: safePosition }

    const nextNodes = [
      ...remainingNodes.map((node) => ({
        ...node,
        selected: false,
        data: node.data.groupId && !remainingGroups.some((group) => group.id === node.data.groupId)
          ? { ...node.data, groupId: undefined }
          : node.data
      })),
      { ...newNode, selected: true }
    ]
    const clearedNodes = nextNodes.map((node) => (
      node.data.groupId && !remainingGroups.some((group) => group.id === node.data.groupId)
        ? { ...node, data: { ...node.data, groupId: undefined } }
        : node
    ))
    const reconciled = reconcileStudioGroupsForNodes(clearedNodes, remainingGroups)

    set(withRecordedSnapshot(state, {
      nodes: reconciled.nodes,
      edges: remainingEdges,
      zones: state.zones,
      groups: reconciled.groups
    }))
    // 格槽若仍引用原节点 blob，不可 revoke，否则分镜组会变空白。
    const retainedBlobUrls = new Set(
      built.gridStoryboard.cells
        .map((cell) => cell.mediaUrl)
        .filter((url): url is string => Boolean(url?.startsWith('blob:')))
    )
    revokeObjectUrls(
      collectStudioNodeBlobUrls(removedNodes).filter((url) => !retainedBlobUrls.has(url))
    )
    get().selectNodes([newNode.id])
    return newNode.id
  },

  extractGridStoryboardCell: (gridNodeId, cellId, dropPoint) => {
    const state = get()
    const gridNode = state.nodes.find((node) => node.id === gridNodeId)
    const storyboard = gridNode?.data.gridStoryboard
    const cell = storyboard?.cells.find((item) => item.id === cellId)
    if (!gridNode || !storyboard || !cell?.mediaUrl) return null

    const kind = resolveGridStoryboardCellMediaKind(cell)
    const mediaAspectRatio = resolveGridStoryboardCellAspectRatio(gridNode, cell, state.nodes)
    const canvasSize = resolveGridStoryboardCellCanvasSize(gridNode, cell, state.nodes)
    const referenceSource = resolveGridStoryboardReferenceSource(gridNode, state.nodes)
    const draft = createStudioNode(kind, dropPoint, {
      title: `宫格分镜 ${cell.row + 1}-${cell.col + 1}`,
      subtitle: `由 ${gridNode.data.title} 拖出`,
      zoneId: gridNode.data.zoneId,
      status: 'success',
      mediaKind: kind,
      mediaUrl: cell.mediaUrl,
      ...(cell.resourceId ? { canvasResourceIds: [cell.resourceId], canvasPrimaryResourceId: cell.resourceId } : {}),
      mediaAspectRatio,
      gridStoryboardOrigin: {
        gridNodeId,
        cellId: cell.id,
        sourceNodeId: referenceSource.id,
        canvasWidth: canvasSize.width,
        canvasHeight: canvasSize.height
      },
      ...(kind === 'image' ? { imagePurpose: 'storyboard' as const, composerHidden: true } : {}),
      prompt: gridNode.data.prompt,
      storyboardId: gridNode.data.storyboardId,
      resultSummary: `${storyboard.rows}×${storyboard.columns} 第 ${cell.row + 1}-${cell.col + 1} 格`
    })
    const size = studioNodeDimensions(draft)
    const desired = { x: dropPoint.x - size.width / 2, y: dropPoint.y - size.height / 2 }
    const position = placeStudioNodeWithoutOverlap(
      desired,
      size,
      state.nodes.map((node) => toStudioNodeRect(node))
    )
    const child = { ...draft, position }
    const referencedData = applyStudioConnectionReference(referenceSource, child)
    const nextChild = referencedData ? { ...child, data: referencedData } : child
    const nextStoryboard = patchGridStoryboardCell(storyboard, cell.row, cell.col, {
      mediaUrl: undefined,
      resourceId: undefined,
      mediaKind: undefined,
      mediaAspectRatio: undefined,
      canvasWidth: undefined,
      canvasHeight: undefined,
      status: 'empty'
    })
    const nextNodes = [
      ...state.nodes.map((node) => node.id === gridNodeId
        ? { ...node, data: { ...node.data, gridStoryboard: nextStoryboard, canvasResourceIds: nextStoryboard.cells.flatMap((item) => item.resourceId ? [item.resourceId] : []), updatedAt: new Date().toISOString() } }
        : node),
      nextChild
    ]
    set(withRecordedSnapshot(state, {
      nodes: nextNodes,
      edges: [...state.edges, createStudioEdge(referenceSource.id, nextChild.id, 'reference')],
      zones: state.zones,
      groups: state.groups
    }))
    get().selectNodes([nextChild.id])
    return nextChild.id
  },

  insertNodeIntoGridStoryboard: (nodeId, target) => {
    const state = get()
    const node = state.nodes.find((item) => item.id === nodeId)
    const gridNode = state.nodes.find((item) => item.id === target.gridNodeId)
    const storyboard = gridNode?.data.gridStoryboard
    const cell = storyboard?.cells.find((item) => item.row === target.row && item.col === target.col)
    if (
      !node?.data.mediaUrl
      || !gridNode
      || !storyboard
      || !cell
      || cell.mediaUrl
      || target.occupied
      || node.data.gridStoryboardOrigin?.gridNodeId !== gridNode.id
      || (node.data.kind !== 'image' && node.data.kind !== 'video')
    ) return false

    const nextStoryboard = patchGridStoryboardCell(storyboard, target.row, target.col, {
      mediaUrl: node.data.mediaUrl,
      resourceId: node.data.canvasPrimaryResourceId || node.data.canvasResourceIds?.[0],
      mediaKind: node.data.kind,
      mediaAspectRatio: node.data.mediaAspectRatio,
      canvasWidth: node.data.gridStoryboardOrigin.canvasWidth,
      canvasHeight: node.data.gridStoryboardOrigin.canvasHeight,
      title: node.data.title,
      status: 'success'
    })
    const outgoingTargets = new Set(
      state.edges.filter((edge) => edge.source === nodeId).map((edge) => edge.target)
    )
    const nextNodes = state.nodes
      .filter((item) => item.id !== nodeId)
      .map((item) => {
        let data = item.id === gridNode.id
          ? { ...item.data, gridStoryboard: nextStoryboard, canvasResourceIds: nextStoryboard.cells.flatMap((cell) => cell.resourceId ? [cell.resourceId] : []), updatedAt: new Date().toISOString() }
          : item.data
        if (data.storyboardAssets?.some((asset) => asset.nodeId === nodeId)) {
          data = { ...data, storyboardAssets: data.storyboardAssets.filter((asset) => asset.nodeId !== nodeId) }
        }
        if (outgoingTargets.has(item.id)) data = clearStudioConnectionReference(node, { ...item, data }) ?? data
        return data === item.data ? item : { ...item, data }
      })
    const remainingGroups = state.groups
      .map((group) => ({ ...group, childIds: group.childIds.filter((id) => id !== nodeId) }))
      .filter((group) => group.childIds.length >= 2)
    const reconciled = reconcileStudioGroupsForNodes(nextNodes, remainingGroups)
    const baseline = state.transactionBaseline ?? cleanSnapshot(state)
    set({
      ...withRecordedSnapshot(state, {
        nodes: reconciled.nodes,
        edges: state.edges.filter((edge) => edge.source !== nodeId && edge.target !== nodeId),
        zones: state.zones,
        groups: reconciled.groups
      }, baseline),
      transactionBaseline: null
    })
    get().selectNodes([gridNode.id])
    return true
  },

  convertGroupToGridStoryboard: (groupId) => {
    const state = get()
    const group = state.groups.find((item) => item.id === groupId)
    if (!group) return null
    return get().mergeNodesToGridStoryboard(group.childIds)
  },

  setGroupColor: (groupId, colorTag) => {
    const state = get()
    if (!state.groups.some((group) => group.id === groupId)) return
    set(withRecordedSnapshot(state, {
      nodes: state.nodes,
      edges: state.edges,
      zones: state.zones,
      groups: setStudioGroupColor(state.groups, groupId, colorTag)
    }))
  },

  saveNodesToAssets: (ids) => {
    const state = get()
    const selected = new Set(ids)
    const existing = new Set(state.savedAssets.map((asset) => asset.sourceNodeId))
    const now = new Date().toISOString()
    const additions: StudioSavedAsset[] = state.nodes.flatMap((node) => {
      if (!selected.has(node.id) || existing.has(node.id) || !node.data.mediaUrl || node.data.flowBinding) return []
      if (node.data.kind !== 'image' && node.data.kind !== 'video') return []
      return [{
        id: studioId('asset'),
        sourceNodeId: node.id,
        kind: node.data.kind,
        title: node.data.title,
        mediaUrl: node.data.mediaUrl,
        mediaKind: node.data.mediaKind,
        createdAt: now
      }]
    })
    if (additions.length) {
      set({
        savedAssets: [...state.savedAssets, ...additions],
        dirtyRevision: state.dirtyRevision + 1
      })
    }
    return additions.length
  },

  attachNodesToChat: (ids) => get().selectNodes(ids),
  clearChatContext: () => set({ chatContextNodeIds: [] }),

  updateNodeData: (id, patch, recordHistory = false) => {
    const state = get()
    const patched = patchStudioNodeAndReferences(state.nodes, id, patch)
    if (recordHistory) {
      // Node-data edits must keep the current selection: clearing activeNodeId
      // unmounts the agent dock and any open storyboard workflow modal with it.
      set({
        ...withRecordedSnapshot(state, { nodes: patched, edges: patchStudioGeneratingEdges(state.edges, patched), zones: state.zones, groups: state.groups }),
        selectedNodeIds: state.selectedNodeIds,
        activeNodeId: state.activeNodeId
      })
      return
    }
    const nodes = pruneSmartEditDismissals(patched, state.edges)
    const next = { nodes, edges: patchStudioGeneratingEdges(state.edges, nodes), zones: state.zones, groups: state.groups }
    const editedNode = nodes.find((node) => node.id === id)
    const emotionSourceChanged = state.emotionSession?.nodeId === id && (
      editedNode?.data.mediaUrl !== state.emotionSession.sourceUrl || editedNode?.data.kind !== 'image'
    )
    set({
      ...next,
      emotionSession: emotionSourceChanged ? null : state.emotionSession,
      dirtyRevision: state.dirtyRevision + 1
    })
  },

  setFrameBreakdownSource: (targetNodeId, source, recordHistory = true) => {
    const state = get()
    const target = state.nodes.find((node) => node.id === targetNodeId)
    const mediaUrl = source.mediaUrl.trim()
    if (!target || target.data.kind !== 'frame_breakdown' || !mediaUrl) return false

    const previousSourceNodeId = target.data.frameBreakdown?.sourceNodeId
    const resourceIds = [...new Set((source.resourceIds ?? []).map(String).filter(Boolean))]
    const primaryResourceId = source.primaryResourceId
      ? String(source.primaryResourceId)
      : resourceIds[0]
    const updatedAt = new Date().toISOString()
    const nodes = state.nodes.map((node) => node.id !== targetNodeId ? node : ({
      ...node,
      data: {
        ...node.data,
        mediaUrl,
        mediaKind: 'video' as const,
        status: 'success' as const,
        errorMessage: undefined,
        resultSummary: `视频来源：${source.title}`,
        canvasResourceIds: resourceIds,
        canvasPrimaryResourceId: primaryResourceId,
        composerHidden: true,
        frameBreakdown: {
          dimensions: normalizeStudioFrameBreakdownDimensions(node.data.frameBreakdown?.dimensions),
          sourceNodeId: source.nodeId,
          sourceTitle: source.title
        },
        updatedAt
      }
    }))
    let edges = previousSourceNodeId && previousSourceNodeId !== source.nodeId
      ? state.edges.filter((edge) => !(
          edge.source === previousSourceNodeId
          && edge.target === targetNodeId
          && edge.data?.kind === 'reference'
        ))
      : state.edges
    if (source.nodeId && !edges.some((edge) => (
      edge.source === source.nodeId
      && edge.target === targetNodeId
      && edge.data?.kind === 'reference'
    ))) {
      edges = [...edges, createStudioEdge(source.nodeId, targetNodeId, 'reference')]
    }
    const next = { nodes, edges, zones: state.zones, groups: state.groups }
    if (recordHistory) {
      set({
        ...withRecordedSnapshot(state, next),
        selectedNodeIds: state.selectedNodeIds,
        activeNodeId: state.activeNodeId
      })
    } else {
      set({ ...next, dirtyRevision: state.dirtyRevision + 1 })
    }
    return true
  },

  setNodeLabels: (ids, color) => {
    const state = get()
    if (state.studioMode !== 'free') return
    if (color !== undefined && !studioLabel(color)) return
    const targets = new Set(ids)
    let changed = false
    const nodes = state.nodes.map((node) => {
      if (!targets.has(node.id) || node.data.flowBinding || node.data.labelColor === color || (color !== undefined && !studioNodeHasLabelContent(node.data))) return node
      changed = true
      return { ...node, data: { ...node.data, labelColor: color, updatedAt: new Date().toISOString() } }
    })
    if (changed) set({ ...withRecordedSnapshot(state, { nodes, edges: state.edges, groups: state.groups, zones: state.zones }), selectedNodeIds: state.selectedNodeIds, activeNodeId: state.activeNodeId })
  },

  applyTemplate: (template, offset = { x: 0, y: 0 }) => {
    const state = get()
    if (state.studioMode === 'flow') return
    set(withRecordedSnapshot(state, applyTemplateToSnapshot(state, template, offset)))
  },

  undo: () => {
    set({ emotionSession: null })
    const state = get()
    const previous = state.historyPast.at(-1)
    if (!previous) return
    const current = cleanSnapshot(state)
    const target = state.studioMode === 'flow'
      ? mergeStudioFlowBusinessForHistory(current, previous)
      : structuredClone(previous)
    set({
      ...target,
      selectedNodeIds: [],
      activeNodeId: null,
      chatContextNodeIds: [],
      historyPast: state.historyPast.slice(0, -1),
      historyFuture: [current, ...state.historyFuture].slice(0, historyLimit(current)),
      diagnostics: [],
      selectedDiagnosticIds: [],
      dirtyRevision: state.dirtyRevision + 1
    })
  },

  redo: () => {
    set({ emotionSession: null })
    const state = get()
    const next = state.historyFuture[0]
    if (!next) return
    const current = cleanSnapshot(state)
    const target = state.studioMode === 'flow'
      ? mergeStudioFlowBusinessForHistory(current, next)
      : structuredClone(next)
    set({
      ...target,
      selectedNodeIds: [],
      activeNodeId: null,
      chatContextNodeIds: [],
      historyPast: appendHistory(state.historyPast, current, target),
      historyFuture: state.historyFuture.slice(1),
      diagnostics: [],
      selectedDiagnosticIds: [],
      dirtyRevision: state.dirtyRevision + 1
    })
  },

  setViewport: (viewport) => set((state) => ({ viewport, dirtyRevision: state.dirtyRevision + (state.readOnly ? 0 : 1) })),
  setNodeFilter: (nodeFilter) => set({ nodeFilter }),
  beginReferencePick: (targetNodeId) => set((state) => {
    const target = state.nodes.find((node) => node.id === targetNodeId)
    if (
      !target
      || target.data.flowBinding
      || (target.data.kind !== 'image' && target.data.kind !== 'video' && target.data.kind !== 'frame_breakdown' && target.data.kind !== 'smart_edit')
    ) return state
    const previousNodeFilter = state.referencePicker?.previousNodeFilter ?? state.nodeFilter
    return {
      emotionSession: null,
      referencePicker: {
        targetNodeId,
        targetKind: target.data.kind,
        previousNodeFilter
      },
      nodeFilter: 'all',
      nodes: state.nodes.map((node) => ({ ...node, selected: node.id === targetNodeId })),
      selectedNodeIds: [targetNodeId],
      activeNodeId: targetNodeId,
      chatContextNodeIds: [targetNodeId]
    }
  }),
  cancelReferencePick: () => set((state) => {
    const picker = state.referencePicker
    if (!picker) return state
    const targetExists = state.nodes.some((node) => node.id === picker.targetNodeId)
    return {
      referencePicker: null,
      nodeFilter: picker.previousNodeFilter,
      nodes: state.nodes.map((node) => ({ ...node, selected: targetExists && node.id === picker.targetNodeId })),
      selectedNodeIds: targetExists ? [picker.targetNodeId] : [],
      activeNodeId: targetExists ? picker.targetNodeId : null,
      chatContextNodeIds: targetExists ? [picker.targetNodeId] : []
    }
  }),
  completeReferencePick: (sourceNodeId) => {
    const state = get()
    const picker = state.referencePicker
    if (!picker) return false
    const target = state.nodes.find((node) => node.id === picker.targetNodeId)
    const source = state.nodes.find((node) => node.id === sourceNodeId)
    if (!target || !source || studioReferencePickDisabledReason(target, source)
      || studioConnectedVideoDisabledReason(source, target, state)) return false

    if (target.data.kind === 'frame_breakdown') {
      const applied = get().setFrameBreakdownSource(target.id, {
        nodeId: source.id,
        title: source.data.title,
        mediaUrl: source.data.mediaUrl || '',
        resourceIds: source.data.canvasResourceIds,
        primaryResourceId: source.data.canvasPrimaryResourceId
      })
      if (!applied) return false
      set({
        referencePicker: null,
        nodeFilter: picker.previousNodeFilter,
        nodes: get().nodes.map((node) => ({ ...node, selected: node.id === target.id })),
        selectedNodeIds: [target.id],
        activeNodeId: target.id,
        chatContextNodeIds: [target.id]
      })
      return true
    }

    const ref = studioNodeToComposerRef(source)
    const attachmentRef = { ...ref, channel: 'attachment' as const }
    const nodes = state.nodes.map((node) => node.id !== target.id ? { ...node, selected: false } : {
      ...node,
      selected: true,
      data: {
        ...node.data,
        composerRefs: upsertComposerRef(node.data.composerRefs, attachmentRef),
        generationOptions: node.data.kind === 'video'
          ? withStudioVideoReference(node.data.generationOptions ?? {}, attachmentRef)
          : node.data.generationOptions,
        updatedAt: new Date().toISOString()
      }
    })
    const canAddEdge = canConnectStudioNodes(source.data.kind, target.data.kind)
    const duplicateEdge = state.edges.some((edge) => edge.source === source.id && edge.target === target.id)
    const edges = canAddEdge && !duplicateEdge
      ? [...state.edges, createStudioEdge(source.id, target.id, 'reference')]
      : state.edges
    set({
      ...withRecordedSnapshot(state, { nodes, edges, zones: state.zones, groups: state.groups }),
      referencePicker: null,
      nodeFilter: picker.previousNodeFilter,
      selectedNodeIds: [target.id],
      activeNodeId: target.id,
      chatContextNodeIds: [target.id]
    })
    return true
  },
  removeComposerReference: (targetNodeId, refId, prompt) => {
    const state = get()
    const target = state.nodes.find((node) => node.id === targetNodeId)
    if (!target) return null

    const removal = removeStudioVideoReference(
      target.data.composerRefs,
      target.data.generationOptions ?? {},
      refId
    )
    const removedRef = removal.previousRef
    if (!removedRef) return null

    const nodes = state.nodes.map((node) => node.id !== targetNodeId ? node : ({
      ...node,
      data: {
        ...node.data,
        ...(prompt === undefined ? {} : { prompt }),
        composerRefs: removal.composerRefs,
        ...(target.data.kind === 'video' ? { generationOptions: removal.generationOptions } : {}),
        updatedAt: new Date().toISOString()
      }
    }))
    const keepsSourceDependency = removedRef.nodeId
      ? removal.composerRefs.some((ref) => ref.nodeId === removedRef.nodeId)
      : false
    const edges = removedRef.nodeId && !keepsSourceDependency
      ? state.edges.filter((edge) => !(
          edge.source === removedRef.nodeId
          && edge.target === targetNodeId
          && edge.data?.kind === 'reference'
        ))
      : state.edges

    set({
      ...withRecordedSnapshot(state, { nodes, edges, zones: state.zones, groups: state.groups }),
      selectedNodeIds: state.selectedNodeIds,
      activeNodeId: state.activeNodeId,
      chatContextNodeIds: state.chatContextNodeIds
    })
    return removedRef
  },
  setEdgeKind: (edgeKind) => set({ edgeKind }),
  setCanvasTool: (canvasTool) => set({ canvasTool }),
  setMiniMapOpen: (miniMapOpen) => set({ miniMapOpen }),
  setHideEdges: (hideEdges) => set({ hideEdges }),
  setGridSnapEnabled: (gridSnapEnabled) => set({ gridSnapEnabled }),
  setReducedMotion: () => set({ reducedMotion: false }),
  setLeftCollapsed: (leftCollapsed) => set({ leftCollapsed }),
  setRightCollapsed: (rightCollapsed) => set({ rightCollapsed }),
  openDirector: (directorOpenNodeId) => set({ directorOpenNodeId, emotionSession: null }),
  closeDirector: () => set({ directorOpenNodeId: null }),
  openEmotionSession: (nodeId) => {
    const state = get()
    const node = state.nodes.find((item) => item.id === nodeId)
    if (state.studioMode !== 'free' || node?.data.kind !== 'image' || !node.data.mediaUrl) return
    if (state.emotionSession?.nodeId === nodeId) { set({ emotionSession: null }); return }
    state.cancelReferencePick()
    state.selectNodes([nodeId])
    set({ emotionSession: createEmotionSession(nodeId, node.data.mediaUrl), referencePicker: null,
      imageLightingNodeId: null, imageMultiAngleNodeId: null, imageEditSession: null,
      videoEditSession: null, videoClipSession: null, touchEditSession: null, layerSplitSession: null })
  },
  patchEmotionSession: (sessionId, patch) => set((state) => state.emotionSession?.id === sessionId
    ? { emotionSession: patchEmotionSession(state.emotionSession, patch) } : state),
  closeEmotionSession: (sessionId) => set((state) => !sessionId || state.emotionSession?.id === sessionId ? { emotionSession: null } : state),
  openImageLighting: (imageLightingNodeId) => set({
    imageLightingNodeId,
    emotionSession: null,
    imageMultiAngleNodeId: null,
    imageEditSession: null,
    videoEditSession: null,
    videoClipSession: null,
    touchEditSession: null,
    layerSplitSession: null
  }),
  closeImageLighting: () => set({ imageLightingNodeId: null }),
  openImageMultiAngle: (imageMultiAngleNodeId) => set({
    imageMultiAngleNodeId,
    imageLightingNodeId: null,
    emotionSession: null,
    imageEditSession: null,
    videoEditSession: null,
    videoClipSession: null,
    touchEditSession: null,
    layerSplitSession: null
  }),
  closeImageMultiAngle: () => set({ imageMultiAngleNodeId: null }),
  openImageEditSession: (imageEditSession) => set({
    imageEditSession: { ...imageEditSession, sourceIdentity: studioEditorSource(get().nodes.find(node => node.id === imageEditSession.nodeId)) },
    videoEditSession: null,
    videoClipSession: null,
    imageLightingNodeId: null,
    emotionSession: null,
    imageMultiAngleNodeId: null,
    touchEditSession: null,
    layerSplitSession: null
  }),
  patchImageEditSession: (patch) => set((state) => {
    if (!state.imageEditSession) return state
    return { imageEditSession: { ...state.imageEditSession, ...patch } }
  }),
  closeImageEditSession: (expected) => set(state => expected === undefined || state.imageEditSession === expected ? { imageEditSession: null } : state),
  openVideoEditSession: ({ nodeId, mode }) => set({
    videoEditSession: { ...createStudioVideoEditSession(nodeId, mode), sourceIdentity: studioEditorSource(get().nodes.find(node => node.id === nodeId)) },
    videoClipSession: null,
    imageEditSession: null,
    imageLightingNodeId: null,
    emotionSession: null,
    imageMultiAngleNodeId: null,
    touchEditSession: null,
    layerSplitSession: null
  }),
  patchVideoEditSession: (patch) => set((state) => {
    if (!state.videoEditSession) return state
    return { videoEditSession: { ...state.videoEditSession, ...patch } }
  }),
  closeVideoEditSession: (expected) => set(state => expected === undefined || state.videoEditSession === expected ? { videoEditSession: null } : state),
  openVideoClipSession: (session) => set({
    videoClipSession: { ...session, sourceIdentity: studioEditorSource(get().nodes.find(node => node.id === session.nodeId)) },
    imageEditSession: null,
    videoEditSession: null,
    imageLightingNodeId: null,
    emotionSession: null,
    imageMultiAngleNodeId: null,
    touchEditSession: null,
    layerSplitSession: null
  }),
  patchVideoClipSession: (patch) => set((state) => {
    if (!state.videoClipSession) return state
    return { videoClipSession: { ...state.videoClipSession, ...patch } }
  }),
  closeVideoClipSession: (expected) => set(state => expected === undefined || state.videoClipSession === expected ? { videoClipSession: null } : state),
  openTouchEditSession: ({ nodeId }) => set({
    touchEditSession: { ...createEmptyTouchEditSession(nodeId), sourceIdentity: studioEditorSource(get().nodes.find(node => node.id === nodeId)) },
    imageEditSession: null,
    videoEditSession: null,
    videoClipSession: null,
    imageLightingNodeId: null,
    emotionSession: null,
    imageMultiAngleNodeId: null,
    layerSplitSession: null
  }),
  patchTouchEditSession: (patch) => set((state) => {
    if (!state.touchEditSession) return state
    return { touchEditSession: { ...state.touchEditSession, ...patch } }
  }),
  closeTouchEditSession: (expected) => set(state => expected === undefined || state.touchEditSession === expected ? { touchEditSession: null } : state),
  openLayerSplitSession: ({ nodeId }) => set({
    layerSplitSession: { ...createEmptyLayerSplitSession(nodeId), sourceIdentity: studioEditorSource(get().nodes.find(node => node.id === nodeId)) },
    imageEditSession: null,
    videoEditSession: null,
    videoClipSession: null,
    touchEditSession: null,
    imageLightingNodeId: null,
    emotionSession: null,
    imageMultiAngleNodeId: null
  }),
  patchLayerSplitSession: (patch) => set((state) => {
    if (!state.layerSplitSession) return state
    return { layerSplitSession: { ...state.layerSplitSession, ...patch } }
  }),
  closeLayerSplitSession: (expected) => set(state => expected === undefined || state.layerSplitSession === expected ? { layerSplitSession: null } : state),

  upsertTask: (task) => {
    // tasks 为会话进度态，不触发布局 autosave（dirtyRevision）
    set((state) => ({
      tasks: [task, ...state.tasks.filter((item) => item.id !== task.id)].slice(0, 30)
    }))
  },

  patchTask: (id, patch) => {
    // 进度 SSE / 取消态刷新：只更新 tasks，不 dirty
    set((state) => ({
      tasks: state.tasks.map((task) =>
        task.id === id ? { ...task, ...patch, updatedAt: new Date().toISOString() } : task
      )
    }))
  },

  removeTask: (id) => set((state) => ({ tasks: state.tasks.filter((task) => task.id !== id) })),

  addMessage: (message) => {
    const id = studioId('message')
    set((state) => ({
      messages: [
        ...state.messages,
        { ...message, id, createdAt: new Date().toISOString() }
      ].slice(-80),
      dirtyRevision: state.dirtyRevision + 1
    }))
    return id
  },

  updateMessage: (id, patch) => {
    set((state) => ({
      messages: state.messages.map((item) => item.id === id ? { ...item, ...patch } : item),
      dirtyRevision: state.dirtyRevision + 1
    }))
  },

  clearMessages: () => set((state) => ({ messages: [], dirtyRevision: state.dirtyRevision + 1 })),
  setConversation: (conversation) => set((state) => ({
    conversation,
    dirtyRevision: state.dirtyRevision + 1
  })),

  runDiagnostics: () => {
    const diagnostics = diagnoseStudioGraph(get().nodes, get().edges)
    set({ diagnostics, selectedDiagnosticIds: diagnostics.map((item) => item.id) })
    return diagnostics
  },

  setSelectedDiagnostics: (selectedDiagnosticIds) => set({ selectedDiagnosticIds }),

  repairSelectedDiagnostics: () => {
    const state = get()
    if (!state.selectedDiagnosticIds.length) return
    const next = repairStudioDiagnostics(state, state.diagnostics, state.selectedDiagnosticIds)
    set({
      ...withRecordedSnapshot(state, next),
      diagnostics: [],
      selectedDiagnosticIds: []
    })
  },

  setDirectorScene: (scene) => {
    set((state) => ({
      directorScenes: { ...state.directorScenes, [scene.id]: scene },
      dirtyRevision: state.dirtyRevision + 1
    }))
  },

  saveCurrentTemplate: (name) => {
    const state = get()
    const indexById = new Map(state.nodes.map((node, index) => [node.id, index]))
    const template: StudioTemplate = {
      id: studioId('template'),
      name: name.trim() || '未命名模板',
      description: `来自当前画布，共 ${state.nodes.length} 个节点`,
      source: 'personal',
      nodes: state.nodes.map((node) => ({
        kind: node.data.kind,
        title: node.data.title,
        zoneId: node.data.zoneId ?? 'planning',
        position: node.position,
        mediaKind: node.data.mediaKind,
        imagePurpose: node.data.imagePurpose
      })),
      edges: state.edges.flatMap((edge) => {
        const sourceIndex = indexById.get(edge.source)
        const targetIndex = indexById.get(edge.target)
        if (sourceIndex == null || targetIndex == null) return []
        return [{ sourceIndex, targetIndex, kind: edge.data?.kind ?? 'flow' }]
      })
    }
    set({
      personalTemplates: [template, ...state.personalTemplates],
      dirtyRevision: state.dirtyRevision + 1
    })
  },

  deletePersonalTemplate: (id) => set((state) => ({
    personalTemplates: state.personalTemplates.filter((item) => item.id !== id),
    dirtyRevision: state.dirtyRevision + 1
  })),

  savePersonalSkill: (name, description) => {
    const state = get()
    const skill: StudioSkill = {
      id: studioId('skill'),
      name: name.trim() || '我的镜头 Skill',
      description: description.trim() || '基于当前画布保存的个人执行配方',
      action: 'gen_unit_chain',
      source: 'personal'
    }
    set({
      personalSkills: [skill, ...state.personalSkills],
      dirtyRevision: state.dirtyRevision + 1
    })
  },

  deletePersonalSkill: (id) => set((state) => ({
    personalSkills: state.personalSkills.filter((item) => item.id !== id),
    dirtyRevision: state.dirtyRevision + 1
  })),

  addDirectorCapture: (sourceNodeId, mediaUrl, title) => {
    return get().addDirectorCaptures(sourceNodeId, [{ mediaUrl, title }])[0] ?? ''
  },

  addDirectorCaptures: (sourceNodeId, items) => {
    const shots = items.filter((item) => item.mediaUrl).slice(0, DIRECTOR_BATCH_SHOT_LIMIT)
    if (!shots.length) return []
    const state = get()
    const source = state.nodes.find((node) => node.id === sourceNodeId)
    const origin = source
      ? { x: source.position.x + 330, y: source.position.y + 20 }
      : { x: 1068, y: 160 }
    const occupied = state.nodes.map((item) => toStudioNodeRect(item))
    const created: StudioCanvasNode[] = []
    const edges = [...state.edges]
    for (const [index, shot] of shots.entries()) {
      const desired = { x: origin.x + index * 330, y: origin.y }
      const draft = createStudioNode('image', desired, {
        title: shot.title?.trim() || '导演台构图参考',
        status: 'success',
        mediaKind: 'image',
        imagePurpose: 'reference',
        mediaUrl: shot.mediaUrl,
        resultSummary: '由导演台多机位截图回灌，可作为分镜生成引用',
        zoneId: 'scene-character'
      })
      const size = studioNodeDimensions(draft)
      const node = { ...draft, position: placeStudioNodeWithoutOverlap(desired, size, occupied) }
      occupied.push(toStudioNodeRect(node))
      created.push(node)
      edges.push(createStudioEdge(sourceNodeId, node.id, 'reference'))
    }
    set(withRecordedSnapshot(state, {
      nodes: [...state.nodes, ...created],
      edges,
      zones: state.zones,
      groups: state.groups
    }))
    const lastId = created.at(-1)?.id
    set({
      selectedNodeIds: created.map((node) => node.id),
      activeNodeId: lastId,
      chatContextNodeIds: created.map((node) => node.id)
    })
    return created.map((node) => node.id)
  },

  addDirectorTimelineOutput: (sourceNodeId, summary) => {
    const state = get()
    const source = state.nodes.find((node) => node.id === sourceNodeId)
    const desired = source
      ? { x: source.position.x + 330, y: source.position.y + 220 }
      : { x: 1068, y: 380 }
    const draft = createStudioNode('text', desired, {
      title: '导演台动画制作说明',
      status: 'success',
      mediaKind: 'text',
      prompt: summary,
      resultSummary: summary,
      zoneId: 'shot-production'
    })
    const size = studioNodeDimensions(draft)
    const occupied = state.nodes.map((item) => toStudioNodeRect(item))
    const node = { ...draft, position: placeStudioNodeWithoutOverlap(desired, size, occupied) }
    const edge = createStudioEdge(sourceNodeId, node.id, 'flow')
    set(withRecordedSnapshot(state, {
      nodes: [...state.nodes, node],
      edges: [...state.edges, edge],
      zones: state.zones,
      groups: state.groups
    }))
    set({ selectedNodeIds: [node.id], activeNodeId: node.id, chatContextNodeIds: [node.id] })
    return node.id
  },

  addDirectorVideoOutput: (sourceNodeId, mediaUrl, resourceId) => {
    const state = get()
    const source = state.nodes.find((node) => node.id === sourceNodeId)
    const desired = source
      ? { x: source.position.x + 360, y: source.position.y + 220 }
      : { x: 1068, y: 380 }
    const draft = createStudioNode('video', desired, {
      title: `${source?.data.title || '3D预演'} · 录制视频`,
      status: 'success',
      mediaKind: 'video',
      operationOrigin: 'director_recording',
      mediaUrl,
      resultSummary: '由3D预演时间轴真实录制，可在画布中预览和继续编辑',
      zoneId: 'shot-production',
      ...(resourceId ? { canvasResourceIds: [resourceId], canvasPrimaryResourceId: resourceId } : {}),
    })
    const node = { ...draft, position: placeStudioNodeWithoutOverlap(desired, studioNodeDimensions(draft), state.nodes.map((item) => toStudioNodeRect(item))) }
    set(withRecordedSnapshot(state, {
      nodes: [...state.nodes, node],
      edges: [...state.edges, createStudioEdge(sourceNodeId, node.id, 'reference')],
      zones: state.zones,
      groups: state.groups,
    }))
    set({ selectedNodeIds: [node.id], activeNodeId: node.id, chatContextNodeIds: [node.id] })
    return node.id
  },

  markSaving: () => set({ saveStatus: 'saving', saveError: '' }),
  markSaved: (savedAt, revision) => set((state) => ({
    saveStatus: 'saved',
    savedAt,
    saveError: '',
    dirtyRevision: revision != null && state.dirtyRevision === revision ? 0 : state.dirtyRevision
  })),
  markSaveError: (saveError) => set({ saveStatus: 'error', saveError })
}, get))

export function getStudioWorkspaceData(): StudioWorkspaceData {
  const state = useStudioUiStore.getState()
  const snapshot = cleanSnapshot(state)
  return {
    version: 3,
    scopeKey: state.scopeKey,
    studioMode: state.studioMode,
    title: state.title,
    nodes: snapshot.nodes,
    edges: snapshot.edges,
    zones: snapshot.zones,
    groups: snapshot.groups,
    viewport: state.viewport,
    tasks: state.tasks,
    messages: state.messages,
    conversation: state.conversation,
    savedAssets: state.savedAssets,
    directorScenes: state.directorScenes,
    personalTemplates: state.personalTemplates,
    personalSkills: state.personalSkills,
    reducedMotion: false,
    savedAt: state.savedAt
  }
}

export function addStudioUnitChain(title = '新镜头'): void {
  const store = useStudioUiStore.getState()
  const template = STUDIO_TEMPLATES[0]
  const chainNodes = template.nodes.filter((node) => node.imagePurpose === 'storyboard' || node.kind === 'video')
  const unitTemplate: StudioTemplate = {
    id: 'unit-chain-runtime',
    name: '镜头成链',
    description: '',
    nodes: chainNodes.map((node, index) => ({
      ...node,
      title: index === 0 ? title : `${title} · 视频`,
      position: { x: node.position.x, y: node.position.y + store.nodes.length * 10 }
    })),
    edges: [
      { sourceIndex: 0, targetIndex: 1, kind: 'sequence' }
    ]
  }
  store.applyTemplate(unitTemplate)
}

export function createStudioTask(
  title: string,
  options: Partial<StudioTask> = {}
): StudioTask {
  const now = new Date().toISOString()
  return {
    id: options.id ?? studioId('task'),
    title,
    nodeId: options.nodeId,
    targetNodeIds: options.targetNodeIds,
    runId: options.runId,
    stage: options.stage ?? '准备中',
    progress: options.progress ?? 0,
    status: options.status ?? 'queued',
    errorMessage: options.errorMessage,
    remoteTaskId: options.remoteTaskId,
    remoteTaskType: options.remoteTaskType,
    resultKind: options.resultKind,
    inputSnapshotHash: options.inputSnapshotHash,
    inputNodeIds: options.inputNodeIds,
    autonomyMode: options.autonomyMode,
    completedNodeIds: options.completedNodeIds,
    createdAt: options.createdAt ?? now,
    updatedAt: now
  }
}

export function canGenerateStudioNode(node: StudioCanvasNode | undefined): boolean {
  return Boolean(node && STUDIO_NODE_META[node.data.kind].generatable)
}
