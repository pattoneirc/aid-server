'use client'

import { studioNodeVisualElement } from '@/utils/studio/studioNodeVisualBounds'

import { StudioEditorSourceGuard } from './StudioEditorSourceGuard'
import { studioEditorSessionKey } from '@/utils/studio/studioEditorSource'

import { canvasAssistantPointerSelection, publishCanvasAssistantReferenceSelection } from '@/utils/studio/canvasAssistantReferenceSelection'

import { studioDeleteReason } from '@/utils/studio/studioDeletePolicy'

import { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Modal, message } from 'antd'
import {
  CloseOutlined,
  LinkOutlined
} from '@ant-design/icons'
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  PanOnScrollMode,
  applyNodeChanges as applyLocalNodeChanges,
  type Connection,
  type EdgeMouseHandler,
  type FinalConnectionState,
  type NodeMouseHandler,
  type NodeChange,
  type NodeTypes,
  type EdgeTypes,
  type OnConnectEnd,
  type OnConnectStart,
  type OnMoveEnd,
  type OnMove,
  type OnNodeDrag,
  type ProOptions,
  type SelectionDragHandler,
  type Viewport,
  type XYPosition,
  useReactFlow
} from '@xyflow/react'
import { STUDIO_NODE_META, STUDIO_TEMPLATES } from '@/config/studioMeta'
import { resolveStudioCanvasTemplate, type StudioCanvasEmptyShortcutAction } from '@/config/studioCanvasEmptyGuide'
import { useStudioUiStore } from '@/stores/studioUi'
import { filterSmartEditPersistentChanges } from '@/stores/studioSmartEdit'
import { useStudioGridStoryboardDragStore } from '@/stores/studioGridStoryboardDrag'
import type { StudioCanvasNode, StudioFlowEdge, StudioFlowNode, StudioGroup, StudioNodeKind } from '@/types/studio'
import { filterStudioFlowCanvasVisibleNodes } from '@/utils/studio/studioFlowCanvasProjection'
import { edgeColor } from '@/utils/studio/studioGraph'
import { StudioCanvasControls } from './StudioCanvasControls'
import { StudioCanvasLabels } from './StudioNodeLabels'
import { StudioCanvasEmptyGuide } from './StudioCanvasEmptyGuide'
import { StudioCanvasToolbar } from './StudioCanvasToolbar'
import { StudioGroupCard } from './StudioGroupCard'
import { StudioEnergyConnectionLine, StudioEnergyEdge } from './StudioEnergyEdge'
import { StudioPendingConnectionLine } from './StudioPendingConnectionLine'
import { StudioSelectionConnection, type StudioSelectionConnectionHandle } from './StudioSelectionConnection'
import { STUDIO_CONNECTION_RADIUS_PX } from '@/utils/studio/studioConnectionHandle'
import { StudioNodeAgentDock, type StudioNodeAgentDockHandle } from './StudioNodeAgentDock'
import { useStudioAudioEditor } from '@/stores/studioAudioEditor'
import { StudioNodeCard } from './StudioNodeCard'
import { StudioNodeContextMenu } from './StudioNodeContextMenu'
import { StudioPaneContextMenu } from './StudioPaneContextMenu'
import { StudioSelectionToolbar, type StudioSelectionToolbarHandle } from './StudioSelectionToolbar'
import { StudioGroupToolbar, type StudioGroupToolbarHandle } from './StudioGroupToolbar'
import { StudioNodeMediaToolbar, type StudioNodeMediaToolbarHandle } from './StudioNodeMediaToolbar'
import { StudioNodeEmptyNextSteps, type StudioNodeEmptyNextStepsHandle } from './StudioNodeEmptyNextSteps'
import { StudioTextEditingToolbar, type StudioTextEditingToolbarHandle } from './StudioTextEditingToolbar'
import { StudioGridStoryboardToolbar, type StudioGridStoryboardToolbarHandle } from './StudioGridStoryboardToolbar'
import { StudioImageEditDock, type StudioImageEditDockHandle } from './StudioImageEditDock'
import { StudioVideoEditDock, type StudioVideoEditDockHandle } from './StudioVideoEditDock'
import { StudioVideoClipDock, type StudioVideoClipDockHandle } from './StudioVideoClipDock'
import { StudioTouchEditDock, type StudioTouchEditDockHandle } from './touch-edit/StudioTouchEditDock'
import { StudioLayerSplitChrome, type StudioLayerSplitChromeHandle } from './layer-split/StudioLayerSplitChrome'
import { StudioCanvasLayerSplitRecovery } from './layer-split/StudioCanvasLayerSplitRecovery'
import { StudioLayerComposeChrome, type StudioLayerComposeChromeHandle } from './layer-split/StudioLayerComposeChrome'
import { isStudioGridStoryboardNode } from '@/utils/studio/studioImageNode'
import { findStudioGroupBySelection, resolveStudioSelectionChrome } from '@/utils/studio/studioSelectionChrome'
import { measureStudioNodesInCanvas, STUDIO_NODE_AGENT_DOCK_GAP_PX, STUDIO_NODE_AGENT_DOCK_RESTING_HEIGHT_PX, type StudioAgentDockRect } from '@/utils/studio/studioNodeAgentDockLayout'
import { centerStudioNodeAtPoint } from '@/utils/studio/studioNodePlacement'
import { measureStudioImageEditBoundsInCanvas, measureStudioNodePreviewInCanvas } from '@/utils/studio/studioImageMaskOverlayLayout'
import { shouldUseCanvasLod, STUDIO_NODE_DEFAULT_DIMENSIONS, studioNodeDimensions, studioNodeLod, type StudioNodeLod } from '@/utils/studio/studioNodeLod'
import { selectionRectFromWorldNode } from '@/utils/studio/studioNodeMediaToolbar'
import { requestStudioTextEditorFocus } from '@/utils/studio/studioTextEditorEvents'
import { createStudioFlowNodeProjector } from '@/utils/studio/studioPrepareFlowNodes'
import { revokeObjectUrl } from '@/utils/objectUrl'
import { beginStudioOperationRun, isStudioOperationRunCurrent } from '@/utils/studio/studioOperationRun'
import { apiErrorMessage } from '@/utils/apiError'
import { StudioCanvasLodLayer, type StudioCanvasLodLayerHandle } from './StudioCanvasLodLayer'
import { StudioFreeDotGrid } from './StudioFreeDotGrid'
import { cancelOverlayFrame, scheduleOverlayFrame } from '@/utils/studio/scheduleOverlayFrame'
import { realignStudioComposerPopups } from '@/utils/studio/studioComposerPopupAlign'
import { defaultZoneByKind } from '@/utils/studio/studioNodeKind'
import { isStudioPaneAddableKind } from '@/utils/studio/studioPaneMenu'
import {
  resolveStudioCanvasShortcut,
  STUDIO_CANVAS_PAN_KEY,
  STUDIO_CANVAS_SELECTION_KEY,
  STUDIO_CANVAS_ZOOM_KEY
} from '@/utils/studio/studioCanvasShortcuts'
import { allowedStudioConnectionKinds, studioConnectedVideoDisabledReason, studioManualNodeConnectionDisabledReason } from '@/utils/studio/studioLibraryLink'
import { createStudioConnectionTargetMotion } from '@/utils/studio/studioConnectionTargetMotion'
import { boundsOfStudioRects, findStudioAlignment, type StudioAlignmentRect } from '@/utils/studio/studioAlignment'
import { studioReferencePickDisabledReason } from '@/utils/studio/studioReferencePicker'
import { createStudioRecommendationEdges } from '@/utils/studio/studioFlowRecommendations'
import { isStudioNodeConnected, isStudioNodeEmptyActionTarget } from '@/utils/studio/studioNodeEmptyActions'
import { useStudioStoryScriptAgent } from '@/components/studio/StudioStoryScriptAgentProvider'
import {
  findStudioNodeAtCanvasPosition,
  focusStudioNodeInViewport
} from '@/utils/studio/studioCanvasFocus'
import {
  importStudioCanvasDropFile,
  isStudioCanvasExternalFileDrag,
  resolveStudioCanvasDropFileKind,
  studioCanvasDropKindToNodeKind,
  studioCanvasFileImportBlockedReason
} from '@/utils/studio/studioCanvasFileDrop'
import { getStudioMaskOverlay } from '@/utils/studio/studioMaskOverlayRegistry'
import { undoTouchEditSession } from '@/utils/studio/touchEditSessionModel'
import { redoLayerSplitSession, undoLayerSplitSession } from '@/utils/studio/studioLayerSplit'
import {
  redoStudioVideoSubtitleSelection,
  resetStudioVideoSubtitleSelection,
  undoStudioVideoSubtitleSelection
} from '@/utils/studio/studioVideoSubtitleSelection'
import { setStudioMediaViewportMoving } from '@/hooks/studio/useStudioMediaInView'
import { useStudioFreeTheme } from '../theme/StudioFreeThemeProvider'
import { useCanvasProjectRuntime } from '@/components/studio/free/CanvasProjectRuntimeContext'
import { resolveStudioCanvasColorMode } from '@/utils/studio/studioFreeTheme'
import {
  gridStoryboardContainsCanvasPoint,
  resolveGridStoryboardReturnTarget
} from '@/utils/studio/studioGridStoryboardTransfer'

const nodeTypes: NodeTypes = {
  studioNode: StudioNodeCard,
  studioGroup: StudioGroupCard
}
const edgeTypes: EdgeTypes = {
  studioEnergy: StudioEnergyEdge
}
const proOptions: ProOptions = { hideAttribution: true }
interface FloatingMenuState {
  client: XYPosition
  flow: XYPosition
  sourceId?: string
  connectionRole?: 'source' | 'target'
  anchorClient?: XYPosition
  mode: 'full' | 'add-only'
}

interface ContextMenuState {
  client: XYPosition
  nodeId: string
}

// Small graphs keep their media elements mounted while crossing the viewport.
const STUDIO_FREE_CANVAS_CULLING_THRESHOLD = 64
const EMPTY_FLOW_NODES: StudioFlowNode[] = []
const EMPTY_FLOW_EDGES: StudioFlowEdge[] = []

function StudioCanvasInner({
  onSave,
  readOnly = false
}: {
  onSave?: () => void | Promise<void> | undefined
  readOnly?: boolean
}) {
  const { theme } = useStudioFreeTheme()
  const canvasRuntime = useCanvasProjectRuntime()
  const nodes = useStudioUiStore((state) => state.nodes)
  const edges = useStudioUiStore((state) => state.edges)
  const groups = useStudioUiStore((state) => state.groups)
  const viewport = useStudioUiStore((state) => state.viewport)
  const nodeFilter = useStudioUiStore((state) => state.nodeFilter)
  const edgeKind = useStudioUiStore((state) => state.edgeKind)
  const canvasTool = useStudioUiStore((state) => state.canvasTool)
  const miniMapOpen = useStudioUiStore((state) => state.miniMapOpen)
  const hideEdges = useStudioUiStore((state) => state.hideEdges)
  const gridSnapEnabled = useStudioUiStore((state) => state.gridSnapEnabled)
  const studioMode = useStudioUiStore((state) => state.studioMode)
  const referencePicker = useStudioUiStore((state) => state.referencePicker)
  const selectedNodeIds = useStudioUiStore((state) => state.selectedNodeIds)
  const imageEditSession = useStudioUiStore((state) => state.imageEditSession)
  const emotionChromeKey = useStudioUiStore((state) => {
    const session = state.emotionSession
    return session ? `${session.id}:${session.phase}:${session.manualMode}:${session.detectionStatus}` : ''
  })
  const videoEditSession = useStudioUiStore((state) => state.videoEditSession)
  const videoClipSession = useStudioUiStore((state) => state.videoClipSession)
  const touchEditSession = useStudioUiStore((state) => state.touchEditSession)
  const layerSplitSession = useStudioUiStore((state) => state.layerSplitSession)
  const activeNodeId = useStudioUiStore((state) => state.activeNodeId)
  const layerComposeActive = Boolean(
    !layerSplitSession
    && activeNodeId
    && (() => {
      const active = nodes.find((item) => item.id === activeNodeId)
      return active?.data.imagePurpose === 'layer_separation' && Boolean(active.data.layerSeparation)
    })()
  )
  const expandZoomLocked = imageEditSession?.mode === 'expand'
    || imageEditSession?.mode === 'erase'
    || imageEditSession?.mode === 'repaint'
    || imageEditSession?.mode === 'grid'
    || Boolean(videoEditSession)
    || Boolean(videoClipSession)
    || Boolean(touchEditSession)
    || Boolean(layerSplitSession)
    || layerComposeActive
  const historyPast = useStudioUiStore((state) => state.historyPast)
  const saveStatus = useStudioUiStore((state) => state.saveStatus)
  const addNode = useStudioUiStore((state) => state.addNode)
  const addConnection = useStudioUiStore((state) => state.addUserConnection)
  const addUserNode = useStudioUiStore((state) => state.addUserNode)
  const onNodesChange = useStudioUiStore((state) => state.applyNodeChanges)
  const commitNodePositions = useStudioUiStore((state) => state.commitNodePositions)
  const onEdgesChange = useStudioUiStore((state) => state.applyEdgeChanges)
  const beginGraphTransaction = useStudioUiStore((state) => state.beginGraphTransaction)
  const commitGraphTransaction = useStudioUiStore((state) => state.commitGraphTransaction)
  const insertNodeIntoGridStoryboard = useStudioUiStore((state) => state.insertNodeIntoGridStoryboard)
  const selectNodes = useStudioUiStore((state) => state.selectNodes)
  const cancelReferencePick = useStudioUiStore((state) => state.cancelReferencePick)
  const completeReferencePick = useStudioUiStore((state) => state.completeReferencePick)
  const clearSelection = useStudioUiStore((state) => state.clearSelection)
  const duplicateNodes = useStudioUiStore((state) => state.duplicateNodes)
  const deleteNodes = useStudioUiStore((state) => state.deleteNodes)
  const deleteEdges = useStudioUiStore((state) => state.deleteEdges)
  const undo = useStudioUiStore((state) => state.undo)
  const redo = useStudioUiStore((state) => state.redo)
  const setEdgeKind = useStudioUiStore((state) => state.setEdgeKind)
  const setViewport = useStudioUiStore((state) => state.setViewport)
  const applyTemplate = useStudioUiStore((state) => state.applyTemplate)
  const setRightCollapsed = useStudioUiStore((state) => state.setRightCollapsed)
  const flowAgent = useStudioStoryScriptAgent()?.agent
  const moveGroup = useStudioUiStore((state) => state.moveGroup)
  const { screenToFlowPosition, getViewport, getInternalNode, fitBounds, zoomIn, zoomOut } = useReactFlow()
  const canvasRef = useRef<HTMLDivElement>(null)
  const connectionMotionRef = useRef<ReturnType<typeof createStudioConnectionTargetMotion> | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadFlowRef = useRef<XYPosition>({ x: 80, y: 80 })
  const fileImportsRef = useRef(new Set<string>())
  const canvasRectRef = useRef<ReturnType<typeof rectFromDom> | null>(null)
  const agentDockRef = useRef<StudioNodeAgentDockHandle>(null)
  const audioEditorKey = useStudioAudioEditor((state) => state.session ? `${state.session.scopeKey}:${state.session.sourceNodeId}:${state.session.operation}` : '')
  const selectionConnectionRef = useRef<StudioSelectionConnectionHandle>(null)
  const selectionToolbarRef = useRef<StudioSelectionToolbarHandle>(null)
  const groupToolbarRef = useRef<StudioGroupToolbarHandle>(null)
  const mediaToolbarRef = useRef<StudioNodeMediaToolbarHandle>(null)
  const reserveMediaToolbarBounds = useCallback((nodeId: string, rect: StudioAgentDockRect | null) => {
    agentDockRef.current?.reserveAbove(nodeId, rect)
  }, [])
  const emptyNextStepsRef = useRef<StudioNodeEmptyNextStepsHandle>(null)
  const textEditingToolbarRef = useRef<StudioTextEditingToolbarHandle>(null)
  const gridStoryboardToolbarRef = useRef<StudioGridStoryboardToolbarHandle>(null)
  const imageEditDockRef = useRef<StudioImageEditDockHandle>(null)
  const videoEditDockRef = useRef<StudioVideoEditDockHandle>(null)
  const videoClipDockRef = useRef<StudioVideoClipDockHandle>(null)
  const touchEditDockRef = useRef<StudioTouchEditDockHandle>(null)
  const layerSplitChromeRef = useRef<StudioLayerSplitChromeHandle>(null)
  const layerComposeChromeRef = useRef<StudioLayerComposeChromeHandle>(null)
  const draggingRef = useRef(false)
  /** True while user is dragging a marquee; keep selection local until mouseup. */
  const boxSelectingRef = useRef(false)
  const marqueeSelectedNodeIdsRef = useRef<Set<string>>(new Set())
  /** True while resizing a group frame; keep local RF dimensions until store commits. */
  const resizingRef = useRef(false)
  const dragOverlayNodesRef = useRef<StudioFlowNode[] | null>(null)
  const overlayFrameRef = useRef<number | null>(null)
  const emptyActionsLeaveTimerRef = useRef<number | null>(null)
  const emptyActionsPointerRef = useRef({ x: 0, y: 0 })
  const lodLayerRef = useRef<StudioCanvasLodLayerHandle>(null)
  const initialLodActive = shouldUseCanvasLod(nodes.length, viewport.zoom)
  const initialReactLod = studioMode === 'free' ? 'full' : studioNodeLod(viewport.zoom)
  const lodActiveRef = useRef(initialLodActive)
  const reactLodRef = useRef<StudioNodeLod>(initialReactLod)
  const liveViewportRef = useRef(viewport)
  const copiedNodeIdsRef = useRef<string[]>([])
  const snappedWorldPositionsRef = useRef<Array<{ id: string; position: XYPosition }> | null>(null)
  const alignmentCandidatesRef = useRef<StudioAlignmentRect[]>([])
  const [floatingMenu, setFloatingMenu] = useState<FloatingMenuState | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [lodActive, setLodActive] = useState(initialLodActive)
  const [reactLod, setReactLod] = useState<StudioNodeLod>(initialReactLod)
  const [spacePanning, setSpacePanning] = useState(false)
  const [boxSelecting, setBoxSelecting] = useState(false)
  const [canPaste, setCanPaste] = useState(false)
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const [hoveredEmptyActionNodeId, setHoveredEmptyActionNodeId] = useState<string | null>(null)
  const [revealedEmptyActionNodeId, setRevealedEmptyActionNodeId] = useState<string | null>(null)
  const [alignmentGuides, setAlignmentGuides] = useState<{
    vertical: number[]
    horizontal: number[]
  } | null>(null)
  const [activeTextEditorId, setActiveTextEditorId] = useState<string | null>(null)
  const highlightRefNodeId = nodes.find((node) => node.id === activeNodeId)?.data.highlightRefNodeId

  useEffect(() => () => {
    if (emptyActionsLeaveTimerRef.current !== null) {
      window.clearTimeout(emptyActionsLeaveTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!canvasRef.current) return
    const motion = createStudioConnectionTargetMotion(canvasRef.current)
    connectionMotionRef.current = motion
    return () => {
      motion.stop()
      connectionMotionRef.current = null
    }
  }, [])

  const flowVisibleNodes = useMemo(
    () => studioMode === 'flow' ? filterStudioFlowCanvasVisibleNodes(nodes) : nodes,
    [nodes, studioMode]
  )

  const cullFreeCanvas = studioMode === 'free' && nodes.length > STUDIO_FREE_CANVAS_CULLING_THRESHOLD
  const projectFlowNodes = useMemo(() => createStudioFlowNodeProjector(cullFreeCanvas), [cullFreeCanvas])
  const preparedNodes = useMemo(
    () => projectFlowNodes(
      flowVisibleNodes,
      groups,
      nodeFilter,
      reactLod,
      highlightRefNodeId,
      selectedNodeIds
    ),
    [flowVisibleNodes, groups, highlightRefNodeId, nodeFilter, projectFlowNodes, reactLod, selectedNodeIds]
  )
  const [visibleNodes, setVisibleNodes] = useState<StudioFlowNode[]>(preparedNodes)
  // Per-node flags override React Flow's global defaults, including group dragging.
  const accessSafeNodes = useMemo(() => readOnly ? visibleNodes.map((node) => ({
    ...node, draggable: false, connectable: false, deletable: false,
  })) : visibleNodes, [readOnly, visibleNodes])

  useEffect(() => {
    if (!draggingRef.current && !boxSelectingRef.current && !resizingRef.current) {
      setVisibleNodes(current => {
        if (!cullFreeCanvas) return preparedNodes
        const previous = new Map(current.map(node => [node.id, node]))
        return preparedNodes.map(node => {
          const measured = previous.get(node.id)
          return measured?.measured && measured.data === node.data
            ? { ...node, measured: measured.measured, handles: measured.handles }
            : node
        })
      })
    }
  }, [cullFreeCanvas, preparedNodes])

  useEffect(() => {
    const onGroupResize = (event: Event) => {
      const detail = (event as CustomEvent<{
        active?: boolean
        groupId?: string
        frame?: { position: { x: number; y: number }; width: number; height: number }
      }>).detail
      const active = Boolean(detail?.active)
      resizingRef.current = active
      if (!active || !detail?.groupId || !detail.frame) return
      const { groupId, frame } = detail
      setVisibleNodes((current) => current.map((node) => {
        if (node.id !== groupId || node.type !== 'studioGroup') return node
        return {
          ...node,
          position: frame.position,
          width: frame.width,
          height: frame.height,
          style: { ...node.style, width: frame.width, height: frame.height }
        }
      }))
    }
    window.addEventListener('studio:group-resize', onGroupResize)
    return () => window.removeEventListener('studio:group-resize', onGroupResize)
  }, [])

  const updateCanvasOverview = useCallback((zoom: number, settled: boolean) => {
    const wasOverview = lodActiveRef.current
    // Keep the overview while zooming back in. Mount detailed cards once the gesture
    // settles, and use separate enter/exit thresholds to avoid remounting at the boundary.
    if (studioMode === 'free' && wasOverview && !settled) return
    const next = shouldUseCanvasLod(nodes.length, studioMode === 'free' && wasOverview ? zoom / 1.12 : zoom)
    if (next === wasOverview) return
    lodActiveRef.current = next
    if (!next && studioMode === 'free') {
      startTransition(() => setLodActive(false))
    } else {
      setLodActive(next)
    }
  }, [nodes.length, studioMode])

  useEffect(() => {
    updateCanvasOverview(liveViewportRef.current.zoom, true)
  }, [updateCanvasOverview])

  // Node positions change on every pointer frame while dragging. Edge visibility only
  // depends on the semantic/filter result, so keep this set stable across those frames.
  const visibleNodeIds = useMemo(
    () => new Set(preparedNodes.filter((node) => node.type === 'studioNode').map((node) => node.id)),
    [preparedNodes]
  )
  const visibleEdges = useMemo(() => {
    const focusedIds = highlightRefNodeId
      ? [...new Set([...selectedNodeIds, highlightRefNodeId])]
      : selectedNodeIds
    return prepareStudioVisibleEdges(edges, visibleNodeIds, focusedIds, studioMode === 'free')
  }, [edges, highlightRefNodeId, selectedNodeIds, studioMode, visibleNodeIds])
  const recommendationEdges = useMemo(() => createStudioRecommendationEdges({
    sourceId: studioMode === 'flow' ? hoveredNodeId : null,
    nodes: preparedNodes.filter((node): node is StudioCanvasNode => node.type === 'studioNode' && visibleNodeIds.has(node.id)),
    edges
  }), [edges, hoveredNodeId, preparedNodes, studioMode, visibleNodeIds])
  const renderedEdges = useMemo(() => {
    if (hideEdges) return []
    return recommendationEdges.length ? [...visibleEdges, ...recommendationEdges] : visibleEdges
  }, [hideEdges, recommendationEdges, visibleEdges])
  const readonlySafeEdges = useMemo(
    () => readOnly
      ? renderedEdges.map((edge) => ({ ...edge, deletable: false, reconnectable: false }))
      : renderedEdges,
    [readOnly, renderedEdges]
  )

  const selectedBusinessNodes = useMemo(() => {
    const selected = new Set(selectedNodeIds)
    return nodes.filter((node) => selected.has(node.id))
  }, [nodes, selectedNodeIds])
  const selectedGroup = useMemo(
    () => findStudioGroupBySelection(groups, selectedNodeIds),
    [groups, selectedNodeIds]
  )
  const agentDockAnchorNodeId = selectedBusinessNodes.length === 1
    && selectedBusinessNodes[0].id === activeNodeId
    ? activeNodeId
    : null
  const selfWritingTextSelected = selectedBusinessNodes.length === 1
    && selectedBusinessNodes[0].data.kind === 'text'
    && Boolean(selectedBusinessNodes[0].data.textEditingEnabled)
  const emptyActionNode = useMemo(() => {
    if (studioMode !== 'free' || readOnly || lodActive) return undefined
    const hovered = nodes.find((node) => node.id === hoveredEmptyActionNodeId)
    if (hovered && isStudioNodeEmptyActionTarget(hovered.data, isStudioNodeConnected(edges, hovered.id))) return hovered
    if (selectedBusinessNodes.length !== 1 || selectedBusinessNodes[0].id !== revealedEmptyActionNodeId) {
      return undefined
    }
    const selected = selectedBusinessNodes[0]
    return isStudioNodeEmptyActionTarget(selected.data, isStudioNodeConnected(edges, selected.id)) ? selected : undefined
  }, [edges, hoveredEmptyActionNodeId, lodActive, nodes, readOnly, revealedEmptyActionNodeId, selectedBusinessNodes, studioMode])
  const selectionChrome = useMemo(() => resolveStudioSelectionChrome({
    selectedNodeIds,
    nodes,
    groups,
    chromeLocked: Boolean(
      boxSelecting
      || imageEditSession
      || videoEditSession
      || videoClipSession
      || touchEditSession
      || layerSplitSession
      || layerComposeActive
    )
  }), [
    boxSelecting,
    groups,
    imageEditSession,
    layerComposeActive,
    layerSplitSession,
    nodes,
    selectedNodeIds,
    touchEditSession,
    videoClipSession,
    videoEditSession
  ])

  const focusNodeInViewport = useCallback((node: StudioCanvasNode) => {
    void focusStudioNodeInViewport(fitBounds, node, groups)
  }, [fitBounds, groups])

  useEffect(() => {
    const focusNode = (event: Event) => {
      const nodeId = String((event as CustomEvent<{ nodeId?: string }>).detail?.nodeId ?? '')
      const node = nodes.find((item) => item.id === nodeId)
      if (!node) return
      focusNodeInViewport(node)
    }
    window.addEventListener('studio:focus-node', focusNode)
    return () => window.removeEventListener('studio:focus-node', focusNode)
  }, [focusNodeInViewport, nodes])

  const updateScreenOverlays = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const viewportRect = canvasRectRef.current ?? rectFromDom(canvas.getBoundingClientRect())
    const currentViewport = getViewport()
    const toCanvas = (position: XYPosition): XYPosition => ({
      x: currentViewport.x + position.x * currentViewport.zoom,
      y: currentViewport.y + position.y * currentViewport.zoom
    })
    const toScreen = (position: XYPosition): XYPosition => ({
      x: viewportRect.left + currentViewport.x + position.x * currentViewport.zoom,
      y: viewportRect.top + currentViewport.y + position.y * currentViewport.zoom
    })
    const draggedPositionById = new Map(
      toWorldPositions(dragOverlayNodesRef.current ?? [], groups)
        .map((item) => [item.id, item.position])
    )
    const editNode = imageEditSession
      ? nodes.find((item) => item.id === imageEditSession.nodeId)
      : videoEditSession
        ? nodes.find((item) => item.id === videoEditSession.nodeId)
        : videoClipSession
          ? nodes.find((item) => item.id === videoClipSession.nodeId)
          : touchEditSession
            ? nodes.find((item) => item.id === touchEditSession.nodeId)
            : layerSplitSession
              ? nodes.find((item) => item.id === layerSplitSession.nodeId)
              : layerComposeActive && activeNodeId
                ? nodes.find((item) => item.id === activeNodeId)
                : undefined
    const baseOverlayNodes = draggedPositionById.size
      ? selectedBusinessNodes.map((node) => {
        const position = draggedPositionById.get(node.id)
        return position ? { ...node, position } : node
      })
      : selectedBusinessNodes
    const overlayNodes = editNode && !baseOverlayNodes.some((item) => item.id === editNode.id)
      ? [...baseOverlayNodes, editNode]
      : baseOverlayNodes.length
        ? baseOverlayNodes
        : (editNode ? [editNode] : [])
    const measuredSelection = measureStudioNodesInCanvas(
      canvas,
      overlayNodes.map((node) => node.id)
    )
    const expandedGalleryNodeIds = new Set(
      Array.from(canvas.querySelectorAll('.studio-node-card--image-gallery:not(.is-gallery-collapsed)'))
        .map((card) => card.closest('.react-flow__node')?.getAttribute('data-id'))
        .filter((id): id is string => Boolean(id))
    )
    const measuredGroup = selectedGroup
      ? measureStudioNodesInCanvas(canvas, [selectedGroup.id])
      : null
    const editSelection = editNode
      ? (measureStudioNodesInCanvas(canvas, [editNode.id]) ?? (() => {
        const size = studioNodeDimensions(editNode)
        const canvasTopLeft = toCanvas(editNode.position)
        const canvasBottomRight = toCanvas({
          x: editNode.position.x + size.width,
          y: editNode.position.y + size.height
        })
        return {
          left: canvasTopLeft.x,
          top: canvasTopLeft.y,
          right: canvasBottomRight.x,
          bottom: canvasBottomRight.y,
          width: canvasBottomRight.x - canvasTopLeft.x,
          height: canvasBottomRight.y - canvasTopLeft.y
        }
      })())
      : null
    const fallbackSelection = (() => {
      if (!overlayNodes.length) return null
      const left = Math.min(...overlayNodes.map((node) => node.position.x))
      const top = Math.min(...overlayNodes.map((node) => node.position.y))
      const right = Math.max(...overlayNodes.map((node) => node.position.x + studioNodeDimensions(node).width))
      const bottom = Math.max(...overlayNodes.map((node) => node.position.y + studioNodeDimensions(node).height))
      const canvasTopLeft = toCanvas({ x: left, y: top })
      const canvasBottomRight = toCanvas({ x: right, y: bottom })
      return {
        left: canvasTopLeft.x,
        top: canvasTopLeft.y,
        right: canvasBottomRight.x,
        bottom: canvasBottomRight.y,
        width: canvasBottomRight.x - canvasTopLeft.x,
        height: canvasBottomRight.y - canvasTopLeft.y
      }
    })()
    const selectionInCanvas = measuredSelection ?? fallbackSelection
    if (selectionInCanvas) selectionConnectionRef.current?.reposition(selectionInCanvas)
    const activeOverlayNode = agentDockAnchorNodeId
      ? overlayNodes.find((node) => node.id === agentDockAnchorNodeId)
        ?? nodes.find((node) => node.id === agentDockAnchorNodeId)
      : undefined
    const agentSelectionInCanvas = activeOverlayNode
      ? (expandedGalleryNodeIds.has(activeOverlayNode.id)
        ? measureStudioNodesInCanvas(canvas, [activeOverlayNode.id])
        : null) ?? (() => {
          const size = studioNodeDimensions(activeOverlayNode)
          const topLeft = toCanvas(activeOverlayNode.position)
          const bottomRight = toCanvas({
            x: activeOverlayNode.position.x + size.width,
            y: activeOverlayNode.position.y + size.height
          })
          return {
            left: topLeft.x,
            top: topLeft.y,
            right: bottomRight.x,
            bottom: bottomRight.y,
            width: bottomRight.x - topLeft.x,
            height: bottomRight.y - topLeft.y
          }
        })()
      : null
    const emptyActionSelection = emptyActionNode
      ? (() => {
        // 与卡片 style、底部输入栏同一套尺寸。DOM 外框在卡片变宽后会停在旧宽度，标签就会偏左。
        // 拖动中 store 坐标未提交，必须取拖拽预览坐标，否则标签停在原位直到松手。
        const size = studioNodeDimensions(emptyActionNode)
        const position = draggedPositionById.get(emptyActionNode.id) ?? emptyActionNode.position
        const topLeft = toCanvas(position)
        const bottomRight = toCanvas({
          x: position.x + size.width,
          y: position.y + size.height
        })
        return {
          left: topLeft.x,
          top: topLeft.y,
          right: bottomRight.x,
          bottom: bottomRight.y,
          width: bottomRight.x - topLeft.x,
          height: bottomRight.y - topLeft.y
        }
      })()
      : null
    if (emptyActionSelection && emptyNextStepsRef.current) {
      emptyNextStepsRef.current.reposition(emptyActionSelection, {
        left: 0,
        top: 0,
        right: viewportRect.width,
        bottom: viewportRect.height,
        width: viewportRect.width,
        height: viewportRect.height
      })
    }
    if (agentDockAnchorNodeId && agentSelectionInCanvas && agentDockRef.current) {
      agentDockRef.current.reposition(agentDockAnchorNodeId, agentSelectionInCanvas, {
        left: 0,
        top: 0,
        right: viewportRect.width,
        bottom: viewportRect.height,
        width: viewportRect.width,
        height: viewportRect.height
      })
    }
    // Media toolbar must use the same world→canvas path as the agent dock.
    // DOM measure of grouped children races RF parent transforms / deferred visibleNodes
    // and briefly places the bar at a wrong canvas point (visible flash).
    if (mediaToolbarRef.current && selectedNodeIds.length === 1) {
      const mediaToolbarNodeId = selectedNodeIds[0]
      const mediaToolbarNode = overlayNodes.find((item) => item.id === mediaToolbarNodeId)
        ?? nodes.find((item) => item.id === mediaToolbarNodeId)
      if (mediaToolbarNode) {
        mediaToolbarRef.current.reposition(
          mediaToolbarNodeId,
          (expandedGalleryNodeIds.has(mediaToolbarNodeId)
            ? measureStudioNodesInCanvas(canvas, [mediaToolbarNodeId])
            : null) ?? selectionRectFromWorldNode(mediaToolbarNode, toCanvas),
          {
            left: 0,
            top: 0,
            right: viewportRect.width,
            bottom: viewportRect.height,
            width: viewportRect.width,
            height: viewportRect.height
          }
        )
      }
    }
    if (selectionInCanvas && textEditingToolbarRef.current) {
      textEditingToolbarRef.current.reposition(selectionInCanvas, {
        left: 0,
        top: 0,
        right: viewportRect.width,
        bottom: viewportRect.height,
        width: viewportRect.width,
        height: viewportRect.height
      })
    }
    if (selectionInCanvas && gridStoryboardToolbarRef.current) {
      gridStoryboardToolbarRef.current.reposition(selectionInCanvas, {
        left: 0,
        top: 0,
        right: viewportRect.width,
        bottom: viewportRect.height,
        width: viewportRect.width,
        height: viewportRect.height
      })
    }
    if (editSelection && imageEditDockRef.current) {
      const previewRect = imageEditSession && editNode
        ? (measureStudioNodePreviewInCanvas(canvas, editNode.id) ?? editSelection)
        : null
      const editBounds = editNode
        ? (measureStudioImageEditBoundsInCanvas(canvas, editNode.id) ?? editSelection)
        : editSelection
      imageEditDockRef.current.reposition(editBounds, {
        left: 0,
        top: 0,
        right: viewportRect.width,
        bottom: viewportRect.height,
        width: viewportRect.width,
        height: viewportRect.height
      }, previewRect)
    }
    if (editSelection && videoEditDockRef.current && videoEditSession) {
      const previewRect = editNode
        ? measureStudioNodePreviewInCanvas(canvas, editNode.id)
        : null
      videoEditDockRef.current.reposition(editSelection, {
        left: 0,
        top: 0,
        right: viewportRect.width,
        bottom: viewportRect.height,
        width: viewportRect.width,
        height: viewportRect.height
      }, previewRect)
    }
    if (editSelection && videoClipDockRef.current && videoClipSession) {
      videoClipDockRef.current.reposition(editSelection, {
        left: 0,
        top: 0,
        right: viewportRect.width,
        bottom: viewportRect.height,
        width: viewportRect.width,
        height: viewportRect.height
      }, editNode ? measureStudioNodePreviewInCanvas(canvas, editNode.id) : null)
    }
    if (editSelection && touchEditDockRef.current && touchEditSession) {
      const previewRect = editNode
        ? measureStudioNodePreviewInCanvas(canvas, editNode.id)
        : null
      touchEditDockRef.current.reposition(editSelection, {
        left: 0,
        top: 0,
        right: viewportRect.width,
        bottom: viewportRect.height,
        width: viewportRect.width,
        height: viewportRect.height
      }, previewRect)
    }
    if (editSelection && layerSplitChromeRef.current && layerSplitSession) {
      const previewRect = editNode
        ? measureStudioNodePreviewInCanvas(canvas, editNode.id)
        : null
      layerSplitChromeRef.current.reposition(editSelection, {
        left: 0,
        top: 0,
        right: viewportRect.width,
        bottom: viewportRect.height,
        width: viewportRect.width,
        height: viewportRect.height
      }, previewRect)
    }
    if (editSelection && layerComposeChromeRef.current && layerComposeActive) {
      const previewRect = editNode
        ? measureStudioNodePreviewInCanvas(canvas, editNode.id)
        : null
      layerComposeChromeRef.current.reposition(editSelection, {
        left: 0,
        top: 0,
        right: viewportRect.width,
        bottom: viewportRect.height,
        width: viewportRect.width,
        height: viewportRect.height
      }, previewRect)
    }
    if (overlayNodes.length >= 2 && (selectionToolbarRef.current || groupToolbarRef.current)) {
      const repositionToolbar = (toolbar: { reposition: (a: typeof viewportRect, b: typeof viewportRect) => void }) => {
        if (measuredSelection) {
          toolbar.reposition({
            left: viewportRect.left + measuredSelection.left,
            top: viewportRect.top + measuredSelection.top,
            right: viewportRect.left + measuredSelection.right,
            bottom: viewportRect.top + measuredSelection.bottom,
            width: measuredSelection.width,
            height: measuredSelection.height
          }, viewportRect)
        } else if (fallbackSelection) {
          const left = Math.min(...overlayNodes.map((node) => node.position.x))
          const top = Math.min(...overlayNodes.map((node) => node.position.y))
          const right = Math.max(...overlayNodes.map((node) => node.position.x + studioNodeDimensions(node).width))
          const bottom = Math.max(...overlayNodes.map((node) => node.position.y + studioNodeDimensions(node).height))
          const screenTopLeft = toScreen({ x: left, y: top })
          const screenBottomRight = toScreen({ x: right, y: bottom })
          toolbar.reposition({
            left: screenTopLeft.x,
            top: screenTopLeft.y,
            right: screenBottomRight.x,
            bottom: screenBottomRight.y,
            width: screenBottomRight.x - screenTopLeft.x,
            height: screenBottomRight.y - screenTopLeft.y
          }, viewportRect)
        }
      }
      if (selectionToolbarRef.current) repositionToolbar(selectionToolbarRef.current)
      if (groupToolbarRef.current) {
        if (measuredGroup) {
          groupToolbarRef.current.reposition({
            left: viewportRect.left + measuredGroup.left,
            top: viewportRect.top + measuredGroup.top,
            right: viewportRect.left + measuredGroup.right,
            bottom: viewportRect.top + measuredGroup.bottom,
            width: measuredGroup.width,
            height: measuredGroup.height
          }, viewportRect)
        } else {
          repositionToolbar(groupToolbarRef.current)
        }
      }
    }
    if (!draggingRef.current) dragOverlayNodesRef.current = null
    // 平移改的是浮层坐标，弹出层不会收到 scroll。全部浮层落位后再贴回触发按钮。
    realignStudioComposerPopups()
  }, [activeNodeId, agentDockAnchorNodeId, emptyActionNode, getViewport, groups, imageEditSession, layerComposeActive, layerSplitSession, nodes, selectedBusinessNodes, selectedGroup, selectedNodeIds, touchEditSession, videoClipSession, videoEditSession])

  const updateScreenOverlaysRef = useRef(updateScreenOverlays)
  useLayoutEffect(() => {
    updateScreenOverlaysRef.current = updateScreenOverlays
  }, [updateScreenOverlays])
  const scheduleOverlayUpdate = useCallback(() => {
    scheduleOverlayFrame(overlayFrameRef, () => updateScreenOverlaysRef.current())
  }, [])

  useEffect(() => {
    scheduleOverlayUpdate()
  }, [
    audioEditorKey,
    emotionChromeKey,
    imageEditSession?.mode,
    imageEditSession?.nodeId,
    imageEditSession?.sourceIdentity,
    imageEditSession?.rect.x,
    imageEditSession?.rect.y,
    imageEditSession?.rect.w,
    imageEditSession?.rect.h,
    videoEditSession?.mode,
    videoEditSession?.nodeId,
    videoEditSession?.sourceIdentity,
    videoEditSession?.regions.length,
    videoClipSession?.nodeId,
    videoClipSession?.sourceIdentity,
    videoClipSession?.range.startSeconds,
    videoClipSession?.range.endSeconds,
    touchEditSession?.nodeId,
    touchEditSession?.sourceIdentity,
    layerSplitSession?.sourceIdentity,
    touchEditSession?.draft?.id,
    touchEditSession?.menuPhase,
    selectionChrome,
    emptyActionNode?.id,
    selectedNodeIds,
    activeTextEditorId,
    scheduleOverlayUpdate
  ])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const refreshCanvasRect = () => {
      if (canvas) canvasRectRef.current = rectFromDom(canvas.getBoundingClientRect())
      scheduleOverlayUpdate()
    }
    const observer = canvas && typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(refreshCanvasRect)
      : null
    if (canvas) observer?.observe(canvas)
    refreshCanvasRect()
    window.addEventListener('resize', refreshCanvasRect)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', refreshCanvasRect)
      cancelOverlayFrame(overlayFrameRef)
    }
  }, [scheduleOverlayUpdate])

  useEffect(() => {
    const updateActiveTextEditor = (event: Event) => {
      const nodeId = (event as CustomEvent<{ nodeId?: string | null }>).detail?.nodeId
      setActiveTextEditorId(nodeId || null)
    }
    window.addEventListener('studio:text-editing-change', updateActiveTextEditor)
    return () => window.removeEventListener('studio:text-editing-change', updateActiveTextEditor)
  }, [])

  const selectedNodeSizeKey = useMemo(
    () => selectedBusinessNodes.map((node) => {
      const media = node.data.mediaUrl ?? ''
      const summary = (node.data.resultSummary ?? '').slice(0, 48)
      return `${node.id}:${node.data.kind}:${node.data.status}:${media}:${summary}`
    }).join('|'),
    [selectedBusinessNodes]
  )

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const resizeTargetIds = selectedGroup
      ? [selectedGroup.id]
      : selectedBusinessNodes.map((node) => node.id)
    if (!canvas || !resizeTargetIds.length || typeof ResizeObserver === 'undefined') {
      scheduleOverlayUpdate()
      return
    }
    const observer = new ResizeObserver(() => scheduleOverlayUpdate())
    for (const nodeId of resizeTargetIds) {
      const safeId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
        ? CSS.escape(nodeId)
        : nodeId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      const element = canvas.querySelector(`.react-flow__node[data-id="${safeId}"]`)
      if (element instanceof HTMLElement) {
        observer.observe(element)
        const visual = studioNodeVisualElement(element)
        if (visual !== element) observer.observe(visual)
      }
    }
    scheduleOverlayUpdate()
    return () => observer.disconnect()
  }, [scheduleOverlayUpdate, selectedBusinessNodes, selectedGroup, selectedNodeSizeKey])

  useEffect(() => {
    if (!floatingMenu) return
    const closeOnScroll = () => setFloatingMenu(null)
    window.addEventListener('wheel', closeOnScroll, { capture: true, passive: true })
    return () => window.removeEventListener('wheel', closeOnScroll, { capture: true })
  }, [floatingMenu])

  const closeMenus = useCallback(() => {
    setFloatingMenu(null)
    setContextMenu(null)
  }, [])

  const handleConnect = useCallback((connection: Connection) => {
    if (readOnly) return
    const reason = addConnection(connection, edgeKind)
    if (reason) {
      message.warning(reason)
      return
    }
    setFloatingMenu(null)
  }, [addConnection, edgeKind, readOnly])

  const connectSelection = useCallback((sources: readonly string[], target: string) => {
    const state = useStudioUiStore.getState()
    const reason = state.addUserConnections(sources, target)
    if (reason) message.warning(reason)
  }, [])

  const startSelectionConnectionMotion = useCallback((sources: readonly string[]) => {
    connectionMotionRef.current?.start(sources)
  }, [])

  const resolveOverviewConnectionTarget = useCallback((point: XYPosition) =>
    lodLayerRef.current?.connectionTargetAt(point) ?? null, [])

  const stopSelectionConnectionMotion = useCallback(() => {
    connectionMotionRef.current?.stop()
  }, [])

  const isValidConnection = useCallback((connection: Pick<Connection, 'source' | 'target'>) => {
    if (readOnly || !connection.source || connection.source === connection.target) return false
    const state = useStudioUiStore.getState()
    const source = state.nodes.find(node => node.id === connection.source)
    const target = state.nodes.find(node => node.id === connection.target)
    return Boolean(source && target && !studioManualNodeConnectionDisabledReason(source, target, state))
  }, [readOnly])

  const handleConnectStart: OnConnectStart = useCallback((_event, params) => {
    if (studioMode === 'free' && !readOnly) connectionMotionRef.current?.start(params.nodeId)
  }, [readOnly, studioMode])

  const handleConnectEnd: OnConnectEnd = useCallback((event, state) => {
    connectionMotionRef.current?.stop()
    if (readOnly) return
    if (state.isValid || !state.fromNode) return
    const from = nodes.find(node => node.id === state.fromNode!.id)
    if (!from) return
    const fromTarget = state.fromHandle?.type === 'target'
    const client = pointerFromEvent(event, state)
    const flow = screenToFlowPosition(client)
    const hit = nodes.find(node => node.id === state.toNode?.id) ?? findStudioNodeAtCanvasPosition(nodes, groups, flow)
    if (hit && hit.id !== state.fromNode.id) {
      const source = fromTarget ? hit : from
      const target = fromTarget ? from : hit
      handleConnect({
        source: source.id,
        target: target.id,
        sourceHandle: null,
        targetHandle: null
      })
      setContextMenu(null)
      return
    }
    if (!allowedStudioConnectionKinds(from.data.kind, fromTarget ? 'target' : 'source', studioMode).length) {
      message.info('音频节点不接收连线')
      return
    }
    const canvasRect = canvasRef.current?.getBoundingClientRect()
    setFloatingMenu({
      client,
      flow,
      sourceId: state.fromNode.id,
      connectionRole: fromTarget ? 'target' : 'source',
      anchorClient: canvasRect
        ? { x: client.x - canvasRect.left, y: client.y - canvasRect.top }
        : client,
      mode: 'add-only'
    })
    setContextMenu(null)
  }, [groups, handleConnect, nodes, readOnly, screenToFlowPosition, studioMode])

  const importCanvasFile = useCallback((file: File, position: XYPosition) => {
    const scopeKey = useStudioUiStore.getState().scopeKey
    const dropKind = resolveStudioCanvasDropFileKind(file)
    if (readOnly || studioMode === 'flow' || !dropKind || studioCanvasFileImportBlockedReason(canvasRuntime)) return
    const key = JSON.stringify([scopeKey, file.name, file.size, file.lastModified, file.type])
    if (fileImportsRef.current.has(key)) return
    try {
      const payload = importStudioCanvasDropFile(file, canvasRuntime
        ? (target, mediaType) => canvasRuntime.uploadResource(target, mediaType)
        : undefined)
      if (!payload) return
      const { localPreviewUrl, finalizeUpload, ...nodeData } = payload
      const kind = studioCanvasDropKindToNodeKind(dropKind)
      // Reserve/select every result before file decoding, reading or network requests.
      const nodeId = addNode(kind, position, { ...nodeData, zoneId: defaultZoneByKind(kind) })
      const runId = beginStudioOperationRun(scopeKey, [nodeId])
      if (!runId) { if (localPreviewUrl) revokeObjectUrl(localPreviewUrl); return }
      fileImportsRef.current.add(key)
      const current = () => isStudioOperationRunCurrent(scopeKey, runId, [nodeId])
        && useStudioUiStore.getState().nodes.some(node => node.id === nodeId
          && node.data.mediaUrl === nodeData.mediaUrl && node.data.documentContent === nodeData.documentContent)
      void (async () => {
        let resultReady = false
        try {
          const uploaded = await finalizeUpload()
          if (!current()) return
          useStudioUiStore.getState().updateNodeData(nodeId, {
            ...uploaded, status: 'success', canvasTransient: false,
            operationRunId: undefined, errorMessage: undefined, resultSummary: file.name
          })
          resultReady = true
          if (canvasRuntime) await canvasRuntime.saveNow()
        } catch (error: unknown) {
          if (!isStudioOperationRunCurrent(scopeKey, runId, [nodeId]) && !resultReady) return
          if (useStudioUiStore.getState().scopeKey !== scopeKey) return
          const detail = apiErrorMessage(error, '素材导入失败，请重新选择文件')
          if (!resultReady && current()) useStudioUiStore.getState().updateNodeData(nodeId, {
            status: 'failed', mediaUrl: undefined, operationRunId: undefined,
            errorMessage: detail, resultSummary: detail
          })
          message.error(resultReady ? `素材已导入，但画布保存失败：${detail}` : detail)
        } finally {
          const store = useStudioUiStore.getState()
          const target = store.scopeKey === scopeKey ? store.nodes.find(node => node.id === nodeId) : undefined
          // Editing/removing a target invalidates only this import, never its new content.
          if (!resultReady && target?.data.operationRunId === runId && target.data.status === 'generating') {
            const hasReplacement = !!target.data.documentContent?.trim()
              || !!target.data.mediaUrl && target.data.mediaUrl !== localPreviewUrl
            store.updateNodeData(nodeId, {
              operationRunId: undefined, status: hasReplacement ? 'success' : 'failed',
              ...(hasReplacement ? { canvasTransient: false, errorMessage: undefined }
                : { mediaUrl: undefined, errorMessage: '导入期间节点内容已变化，请重新选择文件' })
            })
          }
          fileImportsRef.current.delete(key)
          if (localPreviewUrl) revokeObjectUrl(localPreviewUrl)
        }
      })()
    } catch (error: unknown) {
      message.error(apiErrorMessage(error, `${file.name} 导入失败`))
    }
  }, [addNode, canvasRuntime, readOnly, studioMode])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const canImport = !readOnly && studioMode === 'free'
    const acceptFileDrag = (event: DragEvent) => {
      if (!isStudioCanvasExternalFileDrag(event.dataTransfer?.types)) return
      event.preventDefault()
      if (!event.dataTransfer) return
      try { event.dataTransfer.dropEffect = canImport ? 'copy' : 'none' } catch { /* dropEffect 在部分 dragenter 上是只读的 */ }
    }
    const importDroppedFiles = (event: DragEvent) => {
      if (!isStudioCanvasExternalFileDrag(event.dataTransfer?.types)) return
      event.preventDefault()
      event.stopPropagation()
      if (!canImport) return
      const files = [...(event.dataTransfer?.files ?? [])].filter((file) => resolveStudioCanvasDropFileKind(file))
      if (!files.length) {
        message.info('请拖入图片、视频、音频或文本文件')
        return
      }
      const blocked = studioCanvasFileImportBlockedReason(canvasRuntime)
      if (blocked) {
        message.warning(blocked)
        return
      }
      const origin = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      files.forEach((file, index) => importCanvasFile(file, { x: origin.x + index * 36, y: origin.y + index * 28 }))
    }
    canvas.addEventListener('dragenter', acceptFileDrag, true)
    canvas.addEventListener('dragover', acceptFileDrag, true)
    canvas.addEventListener('drop', importDroppedFiles, true)
    return () => {
      canvas.removeEventListener('dragenter', acceptFileDrag, true)
      canvas.removeEventListener('dragover', acceptFileDrag, true)
      canvas.removeEventListener('drop', importDroppedFiles, true)
    }
  }, [canvasRuntime, importCanvasFile, readOnly, screenToFlowPosition, studioMode])

  const createMenuNode = (kind: StudioNodeKind) => {
    if (readOnly) return
    if (!floatingMenu) return
    if (!isStudioPaneAddableKind(kind)) return
    if (studioMode === 'flow') {
      message.info('流程画布不支持手动添加节点')
      return
    }
    const state = useStudioUiStore.getState()
    const anchor = state.nodes.find(node => node.id === floatingMenu.sourceId)
    const endpoint = { data: { kind } }
    const reason = anchor && (floatingMenu.connectionRole === 'target'
      ? studioManualNodeConnectionDisabledReason(endpoint, anchor, state)
      : studioManualNodeConnectionDisabledReason(anchor, endpoint, state))
    if (floatingMenu.sourceId && (!anchor || reason)) {
      if (reason) message.warning(reason)
      setFloatingMenu(null)
      return
    }
    addUserNode(kind, floatingMenu.flow, {
      title: STUDIO_NODE_META[kind].label,
      zoneId: defaultZoneByKind(kind)
    }, floatingMenu.sourceId ? {
      nodeId: floatingMenu.sourceId,
      role: floatingMenu.connectionRole ?? 'source',
      kind: edgeKind
    } : undefined)
    setFloatingMenu(null)
  }

  const openPaneMenu = useCallback((
    client: XYPosition,
    mode: 'full' | 'add-only',
    sourceId?: string,
    connectionRole: 'source' | 'target' = 'source'
  ) => {
    if (readOnly) return
    const anchor = useStudioUiStore.getState().nodes.find(node => node.id === sourceId)
    if (sourceId && (!anchor || !allowedStudioConnectionKinds(anchor.data.kind, connectionRole, studioMode).length)) {
      if (anchor?.data.kind === 'voice') message.info('音频节点不接收连线')
      return
    }
    const rect = canvasRef.current?.getBoundingClientRect()
    setFloatingMenu({
      client,
      flow: screenToFlowPosition(client),
      sourceId,
      connectionRole: sourceId ? connectionRole : undefined,
      anchorClient: sourceId && rect
        ? { x: client.x - rect.left, y: client.y - rect.top }
        : undefined,
      mode
    })
    setContextMenu(null)
  }, [readOnly, screenToFlowPosition, studioMode])

  useEffect(() => {
    const openConnectedMenu = (event: Event) => {
      const detail = (event as CustomEvent<{
        nodeId?: string
        side?: 'source' | 'target'
        clientX?: number
        clientY?: number
      }>).detail
      if (!detail?.nodeId || !detail.side) return
      openPaneMenu({ x: Number(detail.clientX) || 0, y: Number(detail.clientY) || 0 }, 'add-only', detail.nodeId, detail.side)
    }
    window.addEventListener('studio:open-connected-node-menu', openConnectedMenu)
    return () => window.removeEventListener('studio:open-connected-node-menu', openConnectedMenu)
  }, [openPaneMenu])

  const handleCanvasDoubleClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    if (!(event.target instanceof HTMLElement) || !event.target.closest('.react-flow__pane')) return
    event.preventDefault()
    if (readOnly) return
    if (lodActive) {
      const hit = findStudioNodeAtCanvasPosition(
        nodes,
        groups,
        screenToFlowPosition({ x: event.clientX, y: event.clientY })
      )
      if (hit) {
        selectNodes([hit.id])
        if (studioMode === 'free') publishCanvasAssistantReferenceSelection(useStudioUiStore.getState().scopeKey, [hit.id])
        focusNodeInViewport(hit)
        return
      }
    }
    // 流程画布禁止双击添加节点；自由画布保持原行为。
    if (studioMode === 'flow') return
    openPaneMenu({ x: event.clientX, y: event.clientY }, 'add-only')
  }, [focusNodeInViewport, groups, lodActive, nodes, openPaneMenu, readOnly, screenToFlowPosition, selectNodes, studioMode])

  const handlePaneContextMenu = useCallback((event: MouseEvent | React.MouseEvent<Element>) => {
    event.preventDefault()
    if (readOnly) return
    openPaneMenu({ x: event.clientX, y: event.clientY }, 'full')
  }, [openPaneMenu, readOnly])

  const handleUploadRequest = useCallback(() => {
    if (readOnly) return
    if (studioMode === 'flow') {
      message.info('流程素材请在素材准备编辑器中导入')
      return
    }
    if (floatingMenu) uploadFlowRef.current = floatingMenu.flow
    fileInputRef.current?.click()
  }, [floatingMenu, readOnly, studioMode])

  const handleUpload = useCallback((file: File | undefined) => {
    if (!file) return
    const blocked = studioCanvasFileImportBlockedReason(canvasRuntime)
    if (blocked) {
      message.warning(blocked)
      return
    }
    importCanvasFile(file, { ...uploadFlowRef.current })
  }, [canvasRuntime, importCanvasFile])

  const handleSave = useCallback(async () => {
    if (readOnly) return
    try {
      await onSave?.()
    } catch (error: unknown) {
      const failed = useStudioUiStore.getState()
      message.error(failed.saveError || apiErrorMessage(error, '画布保存失败，请稍后重试'))
      return
    }
    const saved = useStudioUiStore.getState()
    message.open({ type: saved.saveStatus === 'error' ? 'error' : 'success', content: saved.saveStatus === 'error' ? saved.saveError || '保存失败' : '已保存' })
  }, [onSave, readOnly])

  const handleOpenChatPanel = useCallback(() => {
    if (readOnly) return
    setRightCollapsed(false)
  }, [readOnly, setRightCollapsed])
  const handleEmptyGuideCanvasMenu = useCallback((client: XYPosition, mode: 'full' | 'add-only') => {
    if (readOnly) return
    if (mode === 'add-only' && studioMode === 'flow') return
    openPaneMenu(client, mode)
  }, [openPaneMenu, readOnly, studioMode])

  const handleEmptyShortcut = useCallback((action: StudioCanvasEmptyShortcutAction) => {
    if (readOnly) return
    if (action.type === 'open-chat' || action.type === 'open-flow-step') {
      setRightCollapsed(false)
      if (action.type === 'open-chat' && action.hint) {
        void flowAgent?.selectMatchingSkill(action.hint)
      }
      return
    }
    if (action.type === 'apply-template') {
      const template = resolveStudioCanvasTemplate(STUDIO_TEMPLATES, action.templateId)
      if (template) applyTemplate(template)
      return
    }
    const rect = canvasRef.current?.getBoundingClientRect()
    const size = STUDIO_NODE_DEFAULT_DIMENSIONS[action.kind]
    const zoom = getViewport().zoom || 1
    const origin = rect
      ? centerStudioNodeAtPoint(
        screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }),
        size,
        (STUDIO_NODE_AGENT_DOCK_GAP_PX + STUDIO_NODE_AGENT_DOCK_RESTING_HEIGHT_PX) / zoom
      )
      : { x: 120, y: 120 }
    addNode(action.kind, origin, {
      title: action.title,
      zoneId: defaultZoneByKind(action.kind),
      ...(action.imagePurpose ? { imagePurpose: action.imagePurpose } : {})
    })
  }, [addNode, applyTemplate, flowAgent, getViewport, readOnly, screenToFlowPosition, setRightCollapsed])

  const showFlowEmptyGuide = studioMode === 'flow' && !flowVisibleNodes.length
  const showFreeEmptyGuide = studioMode === 'free' && !nodes.length

  const handleNodeContextMenu: NodeMouseHandler<StudioFlowNode> = useCallback((event, node) => {
    if (readOnly) return
    if (node.type !== 'studioNode') return
    event.preventDefault()
    selectNodes([node.id])
    setContextMenu({
      client: { x: event.clientX, y: event.clientY },
      nodeId: node.id
    })
    setFloatingMenu(null)
  }, [readOnly, selectNodes])

  const deleteUserNodes = useCallback(async (ids: string[]) => {
    try {
      if (canvasRuntime) await canvasRuntime.deleteNodes(ids)
      else deleteNodes(ids)
    } catch (error: unknown) {
      message.error(apiErrorMessage(error, '删除节点失败'))
      throw error
    }
  }, [canvasRuntime, deleteNodes])

  const confirmDelete = useCallback((ids: string[]) => {
    if (readOnly) return
    const removableIds = ids.filter((id) => !useStudioUiStore.getState().nodes.find((node) => node.id === id)?.data.flowBinding)
    if (!removableIds.length) {
      message.info('流程业务节点请在原流程编辑器中操作')
      return
    }
    const snapshot = useStudioUiStore.getState()
    const reason = studioDeleteReason(snapshot.nodes.filter((node) => removableIds.includes(node.id)), snapshot.tasks)
    if (!reason && snapshot.studioMode === 'free') {
      void deleteUserNodes(removableIds).catch(() => undefined)
      return
    }
    Modal.confirm({
      title: `删除 ${removableIds.length} 个节点？`,
      content: `${reason ?? ''}关联连线会一并移除，可通过撤销恢复节点结构。`,
      okText: '删除',
      cancelText: '取消',
      okButtonProps: { danger: true },
      className: 'create-flow-modal',
      onOk: () => deleteUserNodes(removableIds)
    })
  }, [deleteUserNodes, readOnly])

  const duplicateCanvasNodes = useCallback((ids: string[]) => {
    if (canvasRuntime) {
      void canvasRuntime.copyNodes(ids).catch((error: unknown) => message.error(apiErrorMessage(error, '复制节点失败')))
    } else {
      duplicateNodes(ids)
    }
  }, [canvasRuntime, duplicateNodes])

  const undoCanvas = useCallback(() => {
    if (canvasRuntime) {
      void canvasRuntime.undoLast().catch((error: unknown) => message.error(apiErrorMessage(error, '撤销失败')))
    } else {
      undo()
    }
  }, [canvasRuntime, undo])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (isEditableTarget(event.target)) return
    const action = resolveStudioCanvasShortcut(event)
    if (action === 'temporary-pan') {
      event.preventDefault()
      setSpacePanning(true)
      return
    }
    if (action === 'dismiss') {
      closeMenus()
      if (referencePicker) {
        cancelReferencePick()
        return
      }
      clearSelection()
      return
    }
    if (readOnly) return
    const command = event.ctrlKey || event.metaKey
    if (action === 'undo' || action === 'redo') {
      event.preventDefault()
      const wantRedo = action === 'redo'
      const ui = useStudioUiStore.getState()
      const maskSession = ui.imageEditSession
      if (maskSession && (maskSession.mode === 'erase' || maskSession.mode === 'repaint')) {
        const mask = getStudioMaskOverlay(maskSession.nodeId)
        if (mask) {
          if (wantRedo) mask.redo()
          else mask.undo()
        }
        return
      }
      if (ui.videoEditSession?.mode === 'region') {
        ui.patchVideoEditSession(wantRedo
          ? redoStudioVideoSubtitleSelection(ui.videoEditSession)
          : undoStudioVideoSubtitleSelection(ui.videoEditSession))
        return
      }
      if (ui.touchEditSession) {
        if (!wantRedo) {
          const next = undoTouchEditSession(ui.touchEditSession)
          ui.patchTouchEditSession(next)
        }
        return
      }
      if (ui.layerSplitSession) {
        const next = wantRedo
          ? redoLayerSplitSession(ui.layerSplitSession)
          : undoLayerSplitSession(ui.layerSplitSession)
        ui.patchLayerSplitSession(next)
        return
      }
      if (canvasRuntime) {
        if (wantRedo) message.info('共享画布暂不支持重做已提交操作')
        else undoCanvas()
      } else if (wantRedo) redo()
      else undo()
      return
    }
    if (command && event.key === 'Backspace') {
      const ui = useStudioUiStore.getState()
      if (ui.videoEditSession?.mode === 'region') {
        event.preventDefault()
        ui.patchVideoEditSession(resetStudioVideoSubtitleSelection(ui.videoEditSession))
        return
      }
    }
    if (action === 'copy') {
      const copyableIds = selectedNodeIds.filter((id) => !nodes.find((node) => node.id === id)?.data.flowBinding)
      copiedNodeIdsRef.current = copyableIds
      setCanPaste(copyableIds.length > 0)
      return
    }
    if (action === 'paste' || action === 'duplicate') {
      event.preventDefault()
      duplicateCanvasNodes(action === 'duplicate' ? selectedNodeIds : copiedNodeIdsRef.current)
      return
    }
    if (action === 'delete' && selectedNodeIds.length) {
      event.preventDefault()
      confirmDelete(selectedNodeIds)
      return
    }
    if (!expandZoomLocked && (action === 'zoom-in' || action === 'zoom-out')) {
      event.preventDefault()
      if (action === 'zoom-in') void zoomIn({ duration: 120 })
      else void zoomOut({ duration: 120 })
      return
    }
    if (action === 'edge-flow' || action === 'edge-reference' || action === 'edge-sequence') {
      setEdgeKind(action === 'edge-flow' ? 'flow' : action === 'edge-reference' ? 'reference' : 'sequence')
    }
  }, [cancelReferencePick, canvasRuntime, clearSelection, closeMenus, confirmDelete, duplicateCanvasNodes, expandZoomLocked, nodes, readOnly, redo, referencePicker, selectedNodeIds, setEdgeKind, undo, undoCanvas, zoomIn, zoomOut])

  const contextNode = contextMenu ? nodes.find((node) => node.id === contextMenu.nodeId) : undefined
  const handleNodesChange = useCallback((changes: NodeChange<StudioFlowNode>[]) => {
    if (!changes.length) return
    const effectiveChanges = readOnly
      ? changes.filter((change) => change.type === 'select')
      : changes
    if (!effectiveChanges.length) return

    const groupIds = new Set(groups.map((group) => group.id))
    for (const change of effectiveChanges) {
      if (change.type !== 'dimensions' || !('id' in change) || !groupIds.has(change.id)) continue
      // RF 在拖拽中持续推 dimensions；resizing=false 表示结束，交给 GroupCard onResizeEnd 写回 store。
      if (change.resizing) resizingRef.current = true
    }

    const measuredHandles = new Map<string, StudioFlowNode['handles']>()
    if (cullFreeCanvas) {
      for (const change of effectiveChanges) {
        if (change.type !== 'dimensions') continue
        const handles = getInternalNode(change.id)?.internals.handleBounds
        if (handles) measuredHandles.set(change.id, [...(handles.source ?? []), ...(handles.target ?? [])])
      }
    }
    setVisibleNodes(current => {
      const next = applyLocalNodeChanges(effectiveChanges, current)
      if (!measuredHandles.size) return next
      return next.map(node => measuredHandles.has(node.id) ? { ...node, handles: measuredHandles.get(node.id) } : node)
    })
    // React Flow dimensions describe the current DOM projection. Semantic node
    // resizes are committed explicitly by resizeNodeFrame/resizeGroup, so a
    // measurement must never enter the shared workspace or advance its version.
    const persistentChanges = filterSmartEditPersistentChanges(
      effectiveChanges,
      useStudioUiStore.getState().scopeKey
    ).filter((change) => change.type !== 'dimensions')

    // During marquee, only update React Flow local selection — defer zustand / overlays / docks.
    if (boxSelectingRef.current) {
      const canvasNodeIds = new Set(nodes.map((node) => node.id))
      for (const change of effectiveChanges) {
        if (change.type !== 'select' || !canvasNodeIds.has(change.id)) continue
        if (change.selected) marqueeSelectedNodeIdsRef.current.add(change.id)
        else marqueeSelectedNodeIdsRef.current.delete(change.id)
      }
      const nonSelectSemantic = persistentChanges.filter((change) =>
        change.type !== 'position' &&
        change.type !== 'select' &&
        'id' in change &&
        canvasNodeIds.has(change.id)
      ) as NodeChange<StudioCanvasNode>[]
      if (nonSelectSemantic.length) onNodesChange(nonSelectSemantic)
      return
    }

    const semanticChanges = persistentChanges.filter((change) =>
      change.type !== 'position' && 'id' in change && nodes.some((node) => node.id === change.id)
    ) as NodeChange<StudioCanvasNode>[]
    if (semanticChanges.length) {
      onNodesChange(semanticChanges)
      scheduleOverlayUpdate()
    }
  }, [cullFreeCanvas, getInternalNode, groups, nodes, onNodesChange, readOnly, scheduleOverlayUpdate])

  const handleSelectionStart = useCallback(() => {
    boxSelectingRef.current = true
    marqueeSelectedNodeIdsRef.current.clear()
    setBoxSelecting(true)
  }, [])

  const handleSelectionEnd = useCallback(() => {
    const ids = [...marqueeSelectedNodeIdsRef.current]
    boxSelectingRef.current = false
    setBoxSelecting(false)
    selectNodes(ids)
    scheduleOverlayUpdate()
  }, [scheduleOverlayUpdate, selectNodes])

  const prepareAlignmentCandidates = useCallback((draggedFlowNodes: StudioFlowNode[]) => {
    snappedWorldPositionsRef.current = null
    setAlignmentGuides((current) => (current == null ? current : null))
    if (!gridSnapEnabled || draggedFlowNodes.some((node) => node.type !== 'studioNode')) {
      alignmentCandidatesRef.current = []
      return
    }
    const draggedIds = new Set(draggedFlowNodes.map((node) => node.id))
    const draggedBusinessNodes = nodes.filter((node) => draggedIds.has(node.id))
    if (!draggedBusinessNodes.length) {
      alignmentCandidatesRef.current = []
      return
    }
    alignmentCandidatesRef.current = nodes
      .filter((node) => !draggedIds.has(node.id))
      .map((node) => {
        const size = studioNodeDimensions(node)
        return {
          id: node.id,
          x: node.position.x,
          y: node.position.y,
          width: size.width,
          height: size.height
        }
      })
  }, [gridSnapEnabled, nodes])

  const applyAlignment = useCallback((draggedFlowNodes: StudioFlowNode[]) => {
    if (!gridSnapEnabled || !draggedFlowNodes.length || !alignmentCandidatesRef.current.length) {
      snappedWorldPositionsRef.current = null
      setAlignmentGuides((current) => (current == null ? current : null))
      return draggedFlowNodes
    }
    const draggedIds = new Set(draggedFlowNodes.map((node) => node.id))
    const draggedBusinessNodes = nodes.filter((node) => draggedIds.has(node.id))
    const worldPositions = toWorldPositions(draggedFlowNodes, groups)
    const worldById = new Map(worldPositions.map((item) => [item.id, item.position]))
    const movingBounds = boundsOfStudioRects(draggedBusinessNodes.flatMap((node): StudioAlignmentRect[] => {
      const position = worldById.get(node.id)
      if (!position) return []
      const size = studioNodeDimensions(node)
      return [{ id: node.id, x: position.x, y: position.y, width: size.width, height: size.height }]
    }))
    if (!movingBounds) return draggedFlowNodes

    const currentViewport = getViewport()
    const match = findStudioAlignment(
      movingBounds,
      alignmentCandidatesRef.current,
      8 / Math.max(currentViewport.zoom, 0.05)
    )
    const guides = !match.verticalGuides.length && !match.horizontalGuides.length
      ? null
      : { vertical: match.verticalGuides, horizontal: match.horizontalGuides }
    setAlignmentGuides((current) => sameAlignmentGuides(current, guides) ? current : guides)

    const snappedWorldPositions = worldPositions.map((item) => ({
      id: item.id,
      position: { x: item.position.x + match.dx, y: item.position.y + match.dy }
    }))
    snappedWorldPositionsRef.current = snappedWorldPositions
    if (!match.dx && !match.dy) return draggedFlowNodes

    const snappedFlowNodes = draggedFlowNodes.map((node) => ({
      ...node,
      position: { x: node.position.x + match.dx, y: node.position.y + match.dy }
    }))
    const snappedById = new Map(snappedFlowNodes.map((node) => [node.id, node.position]))
    setVisibleNodes((current) => {
      let changed = false
      const next = current.map((node) => {
        const position = snappedById.get(node.id)
        if (!position) return node
        if (node.position.x === position.x && node.position.y === position.y) return node
        changed = true
        return { ...node, position }
      })
      return changed ? next : current
    })
    return snappedFlowNodes
  }, [getViewport, gridSnapEnabled, groups, nodes])

  const clearAlignmentGuides = useCallback(() => {
    setAlignmentGuides((current) => (current == null ? current : null))
  }, [])

  const handleNodeDragStart: OnNodeDrag<StudioFlowNode> = useCallback((_, node, draggedNodes) => {
    draggingRef.current = true
    prepareAlignmentCandidates(draggedNodes.length ? draggedNodes : [node])
    canvasRef.current?.classList.add('studio-canvas--dragging-nodes')
    beginGraphTransaction()
    const finalDraggedNodes = draggedNodes.length ? draggedNodes : [node]
    const businessNode = finalDraggedNodes.length === 1
      ? nodes.find((item) => item.id === finalDraggedNodes[0].id)
      : undefined
    if (businessNode?.data.gridStoryboardOrigin) {
      useStudioGridStoryboardDragStore.getState().beginReturn(businessNode.id)
    } else {
      useStudioGridStoryboardDragStore.getState().clear()
    }
  }, [beginGraphTransaction, nodes, prepareAlignmentCandidates])
  const handleNodeDrag: OnNodeDrag<StudioFlowNode> = useCallback((event, node, draggedNodes) => {
    const returningNodeId = useStudioGridStoryboardDragStore.getState().returningNodeId
    const returningNode = returningNodeId ? nodes.find((item) => item.id === returningNodeId) : undefined
    if (returningNode?.data.gridStoryboardOrigin && 'clientX' in event && 'clientY' in event) {
      const point = screenToFlowPosition({ x: event.clientX, y: event.clientY })
      const target = resolveGridStoryboardReturnTarget(
        nodes,
        returningNode.data.gridStoryboardOrigin.gridNodeId,
        point
      )
      useStudioGridStoryboardDragStore.getState().setDropTarget(target)
      dragOverlayNodesRef.current = draggedNodes.length ? draggedNodes : [node]
      scheduleOverlayUpdate()
      return
    }
    dragOverlayNodesRef.current = applyAlignment(draggedNodes.length ? draggedNodes : [node])
    scheduleOverlayUpdate()
  }, [applyAlignment, nodes, scheduleOverlayUpdate, screenToFlowPosition])
  const handleNodeDragStop: OnNodeDrag<StudioFlowNode> = useCallback((event, node, draggedNodes) => {
    draggingRef.current = false
    const finalDraggedNodes = draggedNodes.length ? draggedNodes : [node]
    dragOverlayNodesRef.current = finalDraggedNodes
    canvasRef.current?.classList.remove('studio-canvas--dragging-nodes')
    clearAlignmentGuides()
    alignmentCandidatesRef.current = []
    const returnState = useStudioGridStoryboardDragStore.getState()
    const returningNode = returnState.returningNodeId
      ? nodes.find((item) => item.id === returnState.returningNodeId)
      : undefined
    const returnPoint = returningNode?.data.gridStoryboardOrigin && 'clientX' in event && 'clientY' in event
      ? screenToFlowPosition({ x: event.clientX, y: event.clientY })
      : null
    const originGridNode = returningNode?.data.gridStoryboardOrigin
      ? nodes.find((item) => item.id === returningNode.data.gridStoryboardOrigin?.gridNodeId)
      : undefined
    const returnTarget = returningNode?.data.gridStoryboardOrigin && returnPoint
      ? resolveGridStoryboardReturnTarget(nodes, returningNode.data.gridStoryboardOrigin.gridNodeId, returnPoint)
      : null
    const returnInsideGrid = Boolean(originGridNode && returnPoint && gridStoryboardContainsCanvasPoint(originGridNode, returnPoint))
    returnState.clear()
    if (returningNode && returnTarget) {
      snappedWorldPositionsRef.current = null
      if (returnTarget.occupied) {
        commitGraphTransaction()
        setVisibleNodes(preparedNodes)
        scheduleOverlayUpdate()
        message.warning('该格槽已有图片或视频，请拖到空格槽')
        return
      }
      if (insertNodeIntoGridStoryboard(returningNode.id, returnTarget)) {
        scheduleOverlayUpdate()
        message.success('已放回分镜组')
        return
      }
    }
    if (returningNode && returnInsideGrid) {
      snappedWorldPositionsRef.current = null
      commitGraphTransaction()
      setVisibleNodes(preparedNodes)
      scheduleOverlayUpdate()
      message.warning('请将节点放入明确的格槽位置')
      return
    }
    if (node.type === 'studioGroup') {
      snappedWorldPositionsRef.current = null
      moveGroup(node.id, node.position)
      scheduleOverlayUpdate()
      return
    }
    commitNodePositions(snappedWorldPositionsRef.current ?? toWorldPositions(finalDraggedNodes, groups))
    snappedWorldPositionsRef.current = null
    scheduleOverlayUpdate()
  }, [clearAlignmentGuides, commitGraphTransaction, commitNodePositions, groups, insertNodeIntoGridStoryboard, moveGroup, nodes, preparedNodes, scheduleOverlayUpdate, screenToFlowPosition])
  const handleSelectionDragStart: SelectionDragHandler<StudioFlowNode> = useCallback((_, draggedNodes) => {
    draggingRef.current = true
    prepareAlignmentCandidates(draggedNodes)
    canvasRef.current?.classList.add('studio-canvas--dragging-nodes')
    beginGraphTransaction()
  }, [beginGraphTransaction, prepareAlignmentCandidates])
  const handleSelectionDrag: SelectionDragHandler<StudioFlowNode> = useCallback((_, draggedNodes) => {
    dragOverlayNodesRef.current = applyAlignment(draggedNodes)
    scheduleOverlayUpdate()
  }, [applyAlignment, scheduleOverlayUpdate])
  const handleSelectionDragStop: SelectionDragHandler<StudioFlowNode> = useCallback((_, draggedNodes) => {
    draggingRef.current = false
    dragOverlayNodesRef.current = draggedNodes
    canvasRef.current?.classList.remove('studio-canvas--dragging-nodes')
    clearAlignmentGuides()
    alignmentCandidatesRef.current = []
    commitNodePositions(snappedWorldPositionsRef.current ?? toWorldPositions(draggedNodes, groups))
    snappedWorldPositionsRef.current = null
    scheduleOverlayUpdate()
  }, [clearAlignmentGuides, commitNodePositions, groups, scheduleOverlayUpdate])
  const handleEdgeContextMenu: EdgeMouseHandler<StudioFlowEdge> = useCallback((event, edge) => {
    event.preventDefault()
    if (readOnly) return
    Modal.confirm({
      title: '删除这条连线？',
      content: '只解除节点关系，不删除节点内容。',
      okText: '删除',
      cancelText: '取消',
      className: 'create-flow-modal',
      onOk: () => deleteEdges([edge.id])
    })
  }, [deleteEdges, readOnly])
  const handlePaneClick = useCallback(() => {
    closeMenus()
    setRevealedEmptyActionNodeId(null)
    clearSelection()
    if (studioMode === 'free') publishCanvasAssistantReferenceSelection(useStudioUiStore.getState().scopeKey, [])
  }, [clearSelection, closeMenus, studioMode])
  const setViewportMoving = useCallback((moving: boolean) => {
    const canvas = canvasRef.current
    if (studioMode !== 'free' || !canvas) return
    canvas.classList.toggle('is-viewport-moving', moving)
    setStudioMediaViewportMoving(canvas, moving)
  }, [studioMode])
  const handleMoveStart = useCallback(() => {
    closeMenus()
    setViewportMoving(true)
  }, [closeMenus, setViewportMoving])
  const handleMoveEnd: OnMoveEnd = useCallback((_, nextViewport) => {
    liveViewportRef.current = nextViewport
    updateCanvasOverview(nextViewport.zoom, true)
    setViewportMoving(false)
    setViewport(nextViewport)
    lodLayerRef.current?.draw(nextViewport)
    scheduleOverlayUpdate()
  }, [scheduleOverlayUpdate, setViewport, setViewportMoving, updateCanvasOverview])
  const handleMove: OnMove = useCallback((_, nextViewport) => {
    liveViewportRef.current = nextViewport
    lodLayerRef.current?.draw(nextViewport)
    updateCanvasOverview(nextViewport.zoom, false)
    if (studioMode === 'flow') {
      const nextReactLod = studioNodeLod(nextViewport.zoom)
      if (nextReactLod !== reactLodRef.current) {
        reactLodRef.current = nextReactLod
        setReactLod(nextReactLod)
      }
    }
    scheduleOverlayUpdate()
  }, [scheduleOverlayUpdate, studioMode, updateCanvasOverview])
  const handleNodeClick: NodeMouseHandler<StudioFlowNode> = useCallback((event, node) => {
    if (readOnly) { selectNodes([node.id]); return }
    closeMenus()
    setRevealedEmptyActionNodeId(
      node.type === 'studioNode' && isStudioNodeEmptyActionTarget(node.data, isStudioNodeConnected(edges, node.id)) ? node.id : null
    )
    if (referencePicker && node.type === 'studioNode') {
      event.preventDefault()
      const target = nodes.find((item) => item.id === referencePicker.targetNodeId)
      const candidate = nodes.find((item) => item.id === node.id)
      if (!target || !candidate) return
      const disabledReason = studioReferencePickDisabledReason(target, candidate)
        || studioConnectedVideoDisabledReason(candidate, target, useStudioUiStore.getState())
      if (disabledReason) {
        message.info(disabledReason)
        return
      }
      completeReferencePick(node.id)
      return
    }
    if (node.type === 'studioGroup') {
      event.preventDefault()
      const group = groups.find((item) => item.id === node.id)
      if (group) selectNodes(group.childIds)
      return
    }
    const nextSelectedIds = canvasAssistantPointerSelection(selectedNodeIds, node.id, event.shiftKey)
    if (studioMode === 'free' && node.type === 'studioNode') publishCanvasAssistantReferenceSelection(useStudioUiStore.getState().scopeKey, nextSelectedIds)
    selectNodes(nextSelectedIds)
  }, [closeMenus, completeReferencePick, edges, groups, nodes, readOnly, referencePicker, selectNodes, selectedNodeIds, studioMode])
  const handleNodeDoubleClick: NodeMouseHandler<StudioFlowNode> = useCallback((event, node) => {
    if (node.type !== 'studioNode') return
    event.preventDefault()
    event.stopPropagation()
    closeMenus()
    selectNodes([node.id])
    focusNodeInViewport(node)
    if (!readOnly && node.data.kind === 'text' && node.data.textEditingEnabled) {
      window.requestAnimationFrame(() => requestStudioTextEditorFocus(node.id))
    }
  }, [closeMenus, focusNodeInViewport, readOnly, selectNodes])
  const handleNodeMouseEnter: NodeMouseHandler<StudioFlowNode> = useCallback((_, node) => {
    setHoveredNodeId(node.type === 'studioNode' ? node.id : null)
    if (emptyActionsLeaveTimerRef.current !== null) {
      window.clearTimeout(emptyActionsLeaveTimerRef.current)
      emptyActionsLeaveTimerRef.current = null
    }
    setHoveredEmptyActionNodeId(
      node.type === 'studioNode' && isStudioNodeEmptyActionTarget(node.data, isStudioNodeConnected(edges, node.id)) ? node.id : null
    )
  }, [edges])
  const isPointerOverEmptyActionsTarget = useCallback((nodeId: string) => {
    const { x, y } = emptyActionsPointerRef.current
    if (emptyNextStepsRef.current?.containsPoint(x, y)) return true
    const hit = document.elementFromPoint(x, y)
    if (!(hit instanceof Element)) return false
    if (hit.closest('.studio-node-empty-next-steps')) return true
    const safeId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(nodeId)
      : nodeId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    return Boolean(hit.closest(`.react-flow__node[data-id="${safeId}"]`))
  }, [])
  const scheduleReleaseEmptyActions = useCallback((nodeId: string | null) => {
    if (emptyActionsLeaveTimerRef.current !== null) window.clearTimeout(emptyActionsLeaveTimerRef.current)
    emptyActionsLeaveTimerRef.current = window.setTimeout(() => {
      emptyActionsLeaveTimerRef.current = null
      if (nodeId && isPointerOverEmptyActionsTarget(nodeId)) return
      setHoveredEmptyActionNodeId((current) => {
        if (nodeId && current !== nodeId) return current
        return null
      })
    }, 160)
  }, [isPointerOverEmptyActionsTarget])
  const handleNodeMouseLeave: NodeMouseHandler<StudioFlowNode> = useCallback((event, node) => {
    emptyActionsPointerRef.current = { x: event.clientX, y: event.clientY }
    setHoveredNodeId((current) => current === node.id ? null : current)
    scheduleReleaseEmptyActions(node.id)
  }, [scheduleReleaseEmptyActions])
  const keepEmptyActionsOpen = useCallback(() => {
    if (emptyActionsLeaveTimerRef.current === null) return
    window.clearTimeout(emptyActionsLeaveTimerRef.current)
    emptyActionsLeaveTimerRef.current = null
  }, [])
  const releaseEmptyActions = useCallback(() => {
    scheduleReleaseEmptyActions(hoveredEmptyActionNodeId)
  }, [hoveredEmptyActionNodeId, scheduleReleaseEmptyActions])

  useEffect(() => {
    if (!hoveredEmptyActionNodeId) return
    const trackPointer = (event: PointerEvent) => {
      emptyActionsPointerRef.current = { x: event.clientX, y: event.clientY }
      if (isPointerOverEmptyActionsTarget(hoveredEmptyActionNodeId)) keepEmptyActionsOpen()
      else if (emptyActionsLeaveTimerRef.current === null) scheduleReleaseEmptyActions(hoveredEmptyActionNodeId)
    }
    window.addEventListener('pointermove', trackPointer, { passive: true })
    return () => window.removeEventListener('pointermove', trackPointer)
  }, [hoveredEmptyActionNodeId, isPointerOverEmptyActionsTarget, keepEmptyActionsOpen, scheduleReleaseEmptyActions])
  const copyNodeForPaste = useCallback((nodeId: string) => {
    const node = useStudioUiStore.getState().nodes.find((item) => item.id === nodeId)
    if (node?.data.flowBinding) {
      message.info('流程实体不支持画布伪复制')
      closeMenus()
      return
    }
    copiedNodeIdsRef.current = [nodeId]
    setCanPaste(true)
    closeMenus()
    message.success('节点已复制，可在画布中粘贴')
  }, [closeMenus])
  const copyNodeToSystemClipboard = useCallback(async (node: StudioCanvasNode) => {
    if (node.data.flowBinding) {
      message.info('流程业务数据不复制到系统剪切板')
      closeMenus()
      return
    }
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable')
      await navigator.clipboard.writeText(JSON.stringify({
        type: 'aid-studio-node',
        kind: node.data.kind,
        title: node.data.title,
        prompt: node.data.prompt,
        documentContent: node.data.documentContent,
        mediaUrl: node.data.mediaUrl
      }, null, 2))
      message.success('节点内容已复制到系统剪切板')
    } catch {
      message.error('浏览器未允许访问系统剪切板')
    } finally {
      closeMenus()
    }
  }, [closeMenus])
  const currentViewport = getViewport()
  const showOverview = lodActive && !referencePicker && !imageEditSession && !videoEditSession && !videoClipSession && !touchEditSession
  const canvas = (
    <div
      ref={canvasRef}
      data-studio-guide="canvas"
      className={`studio-canvas${expandZoomLocked ? ' is-zoom-locked' : ''}`}
      role="region"
      aria-label={studioMode === 'flow' ? 'AID Studio 流程画布' : 'AID Studio 无限画布'}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onKeyUp={(event) => { if (event.code === 'Space') setSpacePanning(false) }}
      onBlur={() => setSpacePanning(false)}
      onDoubleClick={readOnly ? undefined : handleCanvasDoubleClick}
    >
      {!readOnly ? <StudioCanvasToolbar /> : null}
      {studioMode === 'flow' && <StudioCanvasControls readOnly={readOnly} />}
      {!readOnly && <StudioCanvasLabels />}
      {referencePicker ? (
        <div className="studio-reference-picker-banner" role="status">
          <span>
            <LinkOutlined />
            {referencePicker.targetKind === 'frame_breakdown' ? '从画布选择拉片视频' : '从画布选择参考'}
          </span>
          <button type="button" onClick={cancelReferencePick}>返回节点</button>
          <button type="button" aria-label={referencePicker.targetKind === 'frame_breakdown' ? '关闭拉片视频选择' : '关闭参考选择'} onClick={cancelReferencePick}><CloseOutlined /></button>
        </div>
      ) : null}
      <ReactFlow<StudioFlowNode, StudioFlowEdge>
        nodes={showOverview ? EMPTY_FLOW_NODES : accessSafeNodes}
        edges={lodActive || referencePicker ? EMPTY_FLOW_EDGES : readonlySafeEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        connectionLineComponent={StudioEnergyConnectionLine}
        defaultViewport={viewport}
        fitView={readOnly}
        minZoom={0.05}
        maxZoom={2.2}
        zoomOnScroll={false}
        zoomOnPinch={!expandZoomLocked}
        panOnScroll
        panOnScrollMode={PanOnScrollMode.Vertical}
        zoomActivationKeyCode={expandZoomLocked ? null : STUDIO_CANVAS_ZOOM_KEY}
        zoomOnDoubleClick={false}
        nodeDragThreshold={4}
        connectionMode={ConnectionMode.Strict}
        connectionRadius={STUDIO_CONNECTION_RADIUS_PX}
        nodesDraggable={!readOnly && !expandZoomLocked}
        nodesConnectable={!readOnly && !expandZoomLocked}
        edgesReconnectable={!readOnly && !expandZoomLocked}
        onNodesChange={handleNodesChange}
        onEdgesChange={readOnly ? undefined : onEdgesChange}
        onConnect={readOnly ? undefined : handleConnect}
        isValidConnection={isValidConnection}
        onConnectStart={readOnly ? undefined : handleConnectStart}
        onConnectEnd={readOnly ? undefined : handleConnectEnd}
        onNodeClick={handleNodeClick}
        onNodeDoubleClick={handleNodeDoubleClick}
        onNodeMouseEnter={readOnly ? undefined : handleNodeMouseEnter}
        onNodeMouseLeave={readOnly ? undefined : handleNodeMouseLeave}
        onNodeDragStart={readOnly ? undefined : handleNodeDragStart}
        onNodeDrag={readOnly ? undefined : handleNodeDrag}
        onNodeDragStop={readOnly ? undefined : handleNodeDragStop}
        onSelectionDragStart={readOnly ? undefined : handleSelectionDragStart}
        onSelectionDrag={readOnly ? undefined : handleSelectionDrag}
        onSelectionDragStop={readOnly ? undefined : handleSelectionDragStop}
        onSelectionStart={handleSelectionStart}
        onSelectionEnd={handleSelectionEnd}
        onNodeContextMenu={readOnly ? undefined : handleNodeContextMenu}
        onEdgeContextMenu={readOnly ? undefined : handleEdgeContextMenu}
        onPaneContextMenu={readOnly ? undefined : handlePaneContextMenu}
        onPaneClick={handlePaneClick}
        onMoveStart={handleMoveStart}
        onMove={handleMove}
        onMoveEnd={handleMoveEnd}
        deleteKeyCode={null}
        selectionKeyCode={STUDIO_CANVAS_SELECTION_KEY}
        selectionOnDrag={canvasTool === 'select' && !spacePanning}
        panOnDrag={readOnly || canvasTool === 'pan' || spacePanning ? true : [1]}
        panActivationKeyCode={STUDIO_CANVAS_PAN_KEY}
        noDragClassName="nodrag"
        noPanClassName="nopan"
        noWheelClassName="nowheel"
        selectionMode={SelectionMode.Partial}
        onlyRenderVisibleElements={!videoClipSession && (studioMode === 'flow' || cullFreeCanvas)}
        colorMode={resolveStudioCanvasColorMode(studioMode, theme)}
        proOptions={proOptions}
      >
        {studioMode === 'free' ? <StudioFreeDotGrid animate={!readOnly} /> : (
          <Background
            color="var(--studio-theme-grid, rgba(118, 126, 142, .26))"
            gap={24}
            size={1.6}
            variant={BackgroundVariant.Dots}
            patternClassName="studio-canvas-grid-dot"
          />
        )}
        {miniMapOpen && nodes.length <= 500 ? (
          <MiniMap
            className="studio-canvas-minimap"
            pannable={!expandZoomLocked}
            zoomable={!expandZoomLocked}
            nodeColor="var(--studio-theme-minimap-node, rgba(184,192,204,.55))"
            maskColor="var(--studio-theme-minimap-mask, rgba(7,11,18,.72))"
          />
        ) : null}
      </ReactFlow>
      {alignmentGuides ? (
        <div className="studio-alignment-guides" aria-hidden="true">
          {alignmentGuides.vertical.map((guide) => (
            <i
              key={`vertical:${guide}`}
              className="studio-alignment-guides__vertical"
              style={{ left: currentViewport.x + guide * currentViewport.zoom }}
            />
          ))}
          {alignmentGuides.horizontal.map((guide) => (
            <i
              key={`horizontal:${guide}`}
              className="studio-alignment-guides__horizontal"
              style={{ top: currentViewport.y + guide * currentViewport.zoom }}
            />
          ))}
        </div>
      ) : null}
      {showOverview ? (
        <StudioCanvasLodLayer
          ref={lodLayerRef}
          nodes={nodes}
          edges={hideEdges ? [] : edges}
          viewport={liveViewportRef.current}
          selectedNodeIds={selectedNodeIds}
          tool={spacePanning ? 'pan' : canvasTool}
          onSelect={selectNodes}
          onFocusNode={focusNodeInViewport}
        />
      ) : null}

      {!readOnly && (showFlowEmptyGuide || showFreeEmptyGuide) ? (
        <StudioCanvasEmptyGuide
          mode={studioMode}
          onOpenChat={handleOpenChatPanel}
          onShortcut={handleEmptyShortcut}
          onCanvasMenu={readOnly ? undefined : handleEmptyGuideCanvasMenu}
        />
      ) : null}
      {!readOnly ? <input
        ref={fileInputRef}
        hidden
        type="file"
        accept="image/jpeg,image/png,image/webp,video/mp4,video/webm,audio/*,.txt,.md,.markdown"
        onChange={(event) => {
          handleUpload(event.target.files?.[0])
          event.target.value = ''
        }}
      /> : null}

      {!readOnly && floatingMenu ? (
        <StudioPaneContextMenu
          boundsRef={canvasRef}
          key={`${floatingMenu.mode}:${floatingMenu.client.x}:${floatingMenu.client.y}`}
          client={floatingMenu.client}
          canPaste={canPaste}
          canUndo={canvasRuntime ? canvasRuntime.undoAvailable : historyPast.length > 0}
          saving={saveStatus === 'saving'}
          sourceKind={nodes.find((node) => node.id === floatingMenu.sourceId)?.data.kind}
          connectionRole={floatingMenu.connectionRole}
          platform={typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform) ? 'mac' : 'win'}
          mode={floatingMenu.mode}
          studioMode={studioMode}
          onAdd={createMenuNode}
          onPaste={() => duplicateCanvasNodes(copiedNodeIdsRef.current)}
          onUndo={undoCanvas}
          onUpload={handleUploadRequest}
          onSave={() => void handleSave()}
          onClose={() => setFloatingMenu(null)}
        />
      ) : null}

      {!readOnly && floatingMenu?.sourceId && floatingMenu.anchorClient ? (
        <StudioPendingConnectionLine
          nodeId={floatingMenu.sourceId}
          side={floatingMenu.connectionRole ?? 'source'}
          end={floatingMenu.anchorClient}
        />
      ) : null}

      {!readOnly && contextMenu && contextNode ? (
        <StudioNodeContextMenu
          boundsRef={canvasRef}
          nodeId={contextNode.id}
          client={contextMenu.client}
          canPaste={canPaste && !contextNode.data.flowBinding}
          locked={Boolean(contextNode.data.flowBinding)}
          variant={isStudioGridStoryboardNode(contextNode.data) ? 'grid_storyboard' : 'default'}
          onCopy={() => copyNodeForPaste(contextNode.id)}
          onDuplicate={() => { closeMenus(); duplicateCanvasNodes([contextNode.id]) }}
          onPaste={() => { closeMenus(); duplicateCanvasNodes(copiedNodeIdsRef.current) }}
          onDelete={() => { closeMenus(); confirmDelete([contextNode.id]) }}
          onCopyToClipboard={() => void copyNodeToSystemClipboard(contextNode)}
        />
      ) : null}

      {emptyActionNode ? (
        <StudioNodeEmptyNextSteps
          key={`empty-next-steps:${emptyActionNode.id}`}
          ref={emptyNextStepsRef}
          nodeId={emptyActionNode.id}
          kind={emptyActionNode.data.kind}
          onPointerEnter={(event) => {
            emptyActionsPointerRef.current = { x: event.clientX, y: event.clientY }
            keepEmptyActionsOpen()
          }}
          onPointerLeave={(event) => {
            emptyActionsPointerRef.current = { x: event.clientX, y: event.clientY }
            releaseEmptyActions()
          }}
        />
      ) : null}

      {!readOnly && selectionChrome === 'singleNode' && !selfWritingTextSelected ? (
        <StudioNodeAgentDock ref={agentDockRef} />
      ) : null}
      {!readOnly && selectionChrome === 'singleNode' ? (
        <StudioNodeMediaToolbar ref={mediaToolbarRef} onBoundsChange={reserveMediaToolbarBounds} />
      ) : null}
      {!readOnly && selectionChrome === 'singleNode' && activeTextEditorId === selectedNodeIds[0] ? (
        <StudioTextEditingToolbar ref={textEditingToolbarRef} />
      ) : null}
      {!readOnly && selectionChrome === 'gridStoryboard' ? (
        <StudioGridStoryboardToolbar ref={gridStoryboardToolbarRef} />
      ) : null}
      {!readOnly && imageEditSession ? (
        <StudioImageEditDock key={studioEditorSessionKey(imageEditSession)} ref={imageEditDockRef} />
      ) : null}
      {!readOnly && videoEditSession ? (
        <StudioVideoEditDock key={studioEditorSessionKey(videoEditSession)} ref={videoEditDockRef} />
      ) : null}
      {!readOnly && videoClipSession ? (
        <StudioVideoClipDock key={studioEditorSessionKey(videoClipSession)} ref={videoClipDockRef} />
      ) : null}
      {!readOnly && touchEditSession ? (
        <StudioTouchEditDock key={studioEditorSessionKey(touchEditSession)} ref={touchEditDockRef} />
      ) : null}
      {!readOnly && layerSplitSession ? (
        <StudioLayerSplitChrome key={studioEditorSessionKey(layerSplitSession)} ref={layerSplitChromeRef} />
      ) : null}
      {!readOnly && layerComposeActive ? (
        <StudioLayerComposeChrome ref={layerComposeChromeRef} />
      ) : null}
      {!readOnly ? <StudioEditorSourceGuard /> : null}
      {studioMode === 'free' && !readOnly && !expandZoomLocked
        && (selectionChrome === 'multiSelect' || selectionChrome === 'group') ? (
          <StudioSelectionConnection
            key={JSON.stringify(selectedNodeIds)}
            ref={selectionConnectionRef}
            sources={selectedNodeIds}
            onConnect={connectSelection}
            resolveOverviewTarget={showOverview ? resolveOverviewConnectionTarget : undefined}
            onDragStart={startSelectionConnectionMotion}
            onDragEnd={stopSelectionConnectionMotion}
          />
        ) : null}
      {!readOnly && selectionChrome === 'multiSelect' ? (
        <StudioSelectionToolbar ref={selectionToolbarRef} />
      ) : null}
      {!readOnly ? (
        <StudioGroupToolbar ref={groupToolbarRef} visible={selectionChrome === 'group'} />
      ) : null}

    </div>
  )

  if (studioMode === 'flow') return canvas

  return (
    <div className="studio-free-canvas-layout">
      {canvas}
      <div className="studio-free-canvas-layout__dock">
        <StudioCanvasControls readOnly={readOnly} />
      </div>
    </div>
  )
}

export function StudioCanvas({
  onSave,
  readOnly = false
}: {
  onSave?: () => void | Promise<void> | undefined
  readOnly?: boolean
}) {
  return (
    <ReactFlowProvider>
      <StudioCanvasInner onSave={onSave} readOnly={readOnly} />
      {!readOnly ? <StudioCanvasLayerSplitRecovery /> : null}
    </ReactFlowProvider>
  )
}

function pointerFromEvent(
  event: MouseEvent | TouchEvent,
  state: FinalConnectionState
): XYPosition {
  if ('changedTouches' in event && event.changedTouches[0]) {
    return { x: event.changedTouches[0].clientX, y: event.changedTouches[0].clientY }
  }
  if ('clientX' in event) return { x: event.clientX, y: event.clientY }
  return state.pointer ?? { x: 0, y: 0 }
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
}

function toWorldPositions(
  flowNodes: StudioFlowNode[],
  groups: StudioGroup[]
): Array<{ id: string; position: XYPosition }> {
  const groupById = new Map(groups.map((group) => [group.id, group]))
  return flowNodes.flatMap((node) => {
    if (node.type !== 'studioNode') return []
    const group = node.parentId ? groupById.get(node.parentId) : undefined
    return [{
      id: node.id,
      position: group
        ? { x: group.position.x + node.position.x, y: group.position.y + node.position.y }
        : node.position
    }]
  })
}

function rectFromDom(rect: DOMRect): {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
} {
  return {
    left: rect.left,
    top: rect.top,
    right: rect.right,
    bottom: rect.bottom,
    width: rect.width,
    height: rect.height
  }
}

function sameAlignmentGuides(
  current: { vertical: number[]; horizontal: number[] } | null,
  next: { vertical: number[]; horizontal: number[] } | null
): boolean {
  if (current === next) return true
  if (!current || !next) return false
  return current.vertical.length === next.vertical.length &&
    current.horizontal.length === next.horizontal.length &&
    current.vertical.every((guide, index) => guide === next.vertical[index]) &&
    current.horizontal.every((guide, index) => guide === next.horizontal[index])
}

export function prepareStudioVisibleEdges(
  edges: StudioFlowEdge[],
  visibleNodeIds: ReadonlySet<string>,
  selectedNodeIds: string[],
  useFreeCanvasEdgeTheme = false
): StudioFlowEdge[] {
  const focusedIds = new Set(selectedNodeIds)

  return edges
    .filter((edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target))
    .map((edge) => {
      const kind = edge.data?.kind ?? 'flow'
      const color = useFreeCanvasEdgeTheme
        ? 'var(--studio-edge-base)'
        : edgeColor(kind)
      const related = focusedIds.has(edge.source) || focusedIds.has(edge.target)
      const muted = focusedIds.size > 0 && !related
      const energized = Boolean(edge.animated) || related
      const markerEnd = typeof edge.markerEnd === 'object' && edge.markerEnd
        ? { ...edge.markerEnd, color }
        : edge.markerEnd
      return {
        ...edge,
        // 始终走自定义边，便于自由画布连线剪断（剪刀）在未选中时也能悬停触发
        type: 'studioEnergy',
        animated: false,
        label: related ? edge.data?.label : undefined,
        className: [
          edge.className,
          related ? 'studio-edge--related' : '',
          energized ? 'studio-edge--energy' : '',
          muted ? 'studio-edge--muted' : ''
        ].filter(Boolean).join(' '),
        // RF 不会把 edge.className 传给自定义 Edge 组件，流光开关必须走 data
        data: {
          ...edge.data,
          kind: edge.data?.kind ?? 'flow',
          label: edge.data?.label ?? '',
          energy: energized
        },
        markerEnd,
        style: {
          ...edge.style,
          stroke: color,
          strokeDasharray: 'none',
          strokeWidth: related ? 2 : 1.35,
          opacity: muted ? 0.24 : 0.78
        }
      }
    })
}
