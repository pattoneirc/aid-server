'use client'

import { StudioEmotionFaceOverlay } from './emotion/StudioEmotionFaceOverlay'

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { Handle, NodeResizeControl, Position, useReactFlow, useStore, useUpdateNodeInternals, type NodeProps, type ResizeParams } from '@xyflow/react'
import { ExpandAltOutlined, PlayCircleOutlined, PlusOutlined, WarningOutlined } from '@ant-design/icons'
import { Tooltip, message } from 'antd'
import { STUDIO_NODE_META } from '@/config/studioMeta'
import { useStudioUiStore } from '@/stores/studioUi'
import { StudioAudioNodePreview } from './StudioAudioNodePreview'
import { StudioNodeLabelDecoration } from './StudioNodeLabels'
import { useCreationStore } from '@/stores/creation'
import type { StudioCanvasNode, StudioMediaKind, StudioNodeKind } from '@/types/studio'
import { useStudioQuoteReferenceMarkers } from '@/stores/studioQuoteReferenceIssues'
import { studioConnectionCandidateDisabledReason } from '@/utils/studio/studioLibraryLink'
import { openStudioFlowBoundEntity } from '@/utils/studio/studioFlowEntityEditor'
import {
  dispatchStudioFlowGenerateStoryboardImage,
  dispatchStudioFlowGenerateVideo,
  isStudioFlowStoryboardStillNode
} from '@/utils/studio/studioFlowStoryboardMedia'
import { resolveStudioConnectionHandle, STUDIO_CONNECTION_HANDLE_ZONE_PX } from '@/utils/studio/studioConnectionHandle'
import { isStudioConnectionMotionTarget } from '@/utils/studio/studioConnectionTargetMotion'
import { placeStudioNodeWithoutOverlap, toStudioNodeRect } from '@/utils/studio/studioNodePlacement'
import {
  rememberStudioMediaAspectRatio,
  STUDIO_GRID_STORYBOARD_MAX_HEIGHT,
  STUDIO_GRID_STORYBOARD_MIN_HEIGHT,
  studioNodeDimensions
} from '@/utils/studio/studioNodeLod'
import { uploadAudioToOssWithToast, uploadImageToOssWithToast, uploadVideoToOssWithToast } from '@/utils/ossUpload'
import { studioReferencePickDisabledReason } from '@/utils/studio/studioReferencePicker'
import { captureStudioCanvasVideoFrame } from '@/utils/studio/studioCanvasVideoFrameCapture'
import { beginStudioOperationRun, createStudioOperationInputHash, isStudioOperationInputCurrent, isStudioOperationRunCurrent } from '@/utils/studio/studioOperationRun'
import {
  resolveStudioNodeMediaKind,
  studioNodeMediaDownloadType
} from '@/utils/studio/studioNodeMedia'
import { downloadMediaFileWithToast } from '@/utils/mediaFileDownload'
import { openImagePreviewModal } from '@/utils/openImagePreviewModal'
import { openVideoPreviewModal } from '@/utils/openVideoPreviewModal'
import { isImagePreviewUrl } from './StudioMediaPreview'
import { StudioNodeContentHeader } from './StudioNodeContentHeader'
import { StudioNodeIcon } from './StudioNodeIcon'
import { StudioScriptNodePreview } from './StudioScriptNodePreview'
import { StudioScriptNodeWorkspaceModal } from './StudioScriptNodeWorkspaceModal'
import {
  isStudioImageHdConfigNode,
  isStudioImageMattingPendingNode,
  isStudioImagePendingNode,
  isStudioMediaFillNode,
  isStudioVideoContentNode,
  isStudioVideoHdConfigNode,
  isStudioVideoOperationResultNode,
  isStudioMediaDerivationNode,
  isStudioVideoClipDraftNode,
  isStudioVideoPendingNode,
  isStudioGridStoryboardNode,
  isStudioEmptyPlaceholderNode,
  needsStudioStoryboardImage
} from '@/utils/studio/studioImageNode'
import { StudioNodeEmptyPreview } from './StudioNodeEmptyPreview'
import { StudioTextNodeEditor } from './StudioTextNodeEditor'
import { isStudioScriptContentNode, resolveStudioScriptNodeText } from '@/utils/studio/studioScriptNode'
import { StudioImageNodePreview } from './StudioImageNodePreview'
import { StudioImageResultGallery } from './StudioImageResultGallery'
import { StudioStyleLibraryNodePreview } from './StudioStyleLibraryNodePreview'
import { StudioImageCropOverlay } from './StudioImageCropOverlay'
import { StudioImageExpandOverlay } from './StudioImageExpandOverlay'
import { StudioGridStoryboardNodePreview } from './StudioGridStoryboardNodePreview'
import { StudioImageMattingSparkle } from './StudioImageMattingSparkle'
import { StudioVideoNodePreview } from './StudioVideoNodePreview'
import { StudioNodeExternalTitle, StudioImagePendingPreview } from './StudioNodeExternalTitle'
import { StudioNodeGenerationSurface } from './StudioNodeGenerationSurface'
import { useStudioFreeTheme } from '../theme/StudioFreeThemeProvider'
import { DirectorNodeEntry } from '../director/DirectorNodeEntry'
import { resolveDirectorNodePreviewUrl } from '@/utils/studio/directorScene'
import {
  parseStudioCaptureVideoFrameEvent,
  STUDIO_CAPTURE_VIDEO_FRAME_EVENT
} from '@/utils/studio/studioNodeMediaEvents'
import { isStudioMaterialNodeKind } from '@/utils/studio/studioNodeKind'
import { StudioVerticalResizeHandles } from './StudioVerticalResizeHandles'
import { useCanvasProjectRuntime } from '@/components/studio/free/CanvasProjectRuntimeContext'
import { useCanvasImageGallery } from '@/hooks/studio/useCanvasImageGallery'
import type { CanvasImageGalleryResult } from '@/utils/canvas/canvasImageGallery'
import { apiErrorMessage } from '@/utils/apiError'
import { StudioFrameBreakdownNode } from './StudioFrameBreakdownNode'
import { StudioSmartEditNode } from './StudioSmartEditNode'
import { useStudioSmartEdit } from '@/stores/studioSmartEdit'
import { AUDIO_OPERATION_LABELS } from '@/utils/studio/studioAudioEdit'
import { StudioReadOnlyNodeCard } from './StudioReadOnlyNodeCard'
function StudioNodeCardComponent({ id, data, selected, isConnectable, positionAbsoluteX, positionAbsoluteY }: NodeProps<StudioCanvasNode>) {
  const invalidReferences = useStudioQuoteReferenceMarkers(state => state[id]?.count ?? 0)
  const canvasRuntime = useCanvasProjectRuntime()
  const { theme } = useStudioFreeTheme()
  const serverReadOnly = Boolean(canvasRuntime && !canvasRuntime.canEdit)
  const updateNodeInternals = useUpdateNodeInternals()
  const { getViewport, setViewport } = useReactFlow()
  const cardRef = useRef<HTMLElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const fileUploadInFlight = useRef(false)
  const videoRef = useRef<HTMLVideoElement>(null)
  const task = useStudioUiStore((state) => state.tasks.find(
    (item) => (item.nodeId === id || item.targetNodeIds?.includes(id)) && (
      item.status === 'running' || item.status === 'queued' || item.status === 'waiting'
    )
  ))
  const referencePicker = useStudioUiStore((state) => state.referencePicker)
  const referenceTarget = useStudioUiStore((state) => referencePicker
    ? state.nodes.find((node) => node.id === referencePicker.targetNodeId)
    : undefined)
  const selectNodes = useStudioUiStore((state) => state.selectNodes)
  const updateNodeData = useStudioUiStore((state) => state.updateNodeData)
  const addNode = useStudioUiStore((state) => state.addNode)
  const studioMode = useStudioUiStore((state) => state.studioMode)
  const scopeKey = useStudioUiStore((state) => state.scopeKey)
  const smartEditPreview = useStudioSmartEdit((state) => state.scopeKey === scopeKey && state.nodeId === id && state.chrome === 'docked')
  const smartEditDockHeight = useStudioSmartEdit((state) => state.scopeKey === scopeKey && state.nodeId === id && state.chrome === 'docked' ? state.dockHeight : 0)
  const reducedMotion = useStudioUiStore((state) => state.reducedMotion)
  const emotionSession = useStudioUiStore((state) => state.emotionSession?.nodeId === id && state.emotionSession.sourceUrl === data.mediaUrl ? state.emotionSession : null)
  const imageEditSession = useStudioUiStore((state) => (
    state.imageEditSession?.nodeId === id ? state.imageEditSession : null
  ))
  const videoEditSession = useStudioUiStore((state) => (
    state.videoEditSession?.nodeId === id ? state.videoEditSession : null
  ))
  const [uploadProgress, setUploadProgress] = useState<number | null>(null)
  const [captureBusy, setCaptureBusy] = useState(false)
  const captureInFlight = useRef(false)
  const [fullTextOpen, setFullTextOpen] = useState(false)
  const [intrinsicMedia, setIntrinsicMedia] = useState<{ url: string; aspectRatio: number } | null>(null)
  const [resizePreview, setResizePreview] = useState<{ width: number; height: number } | null>(null)
  const [collapsedGalleryTaskId, setCollapsedGalleryTaskId] = useState<string | null>(null)
  const [selectingGalleryResultId, setSelectingGalleryResultId] = useState<string | null>(null)
  const meta = STUDIO_NODE_META[data.kind]
  const liveNode = useStudioUiStore((state) => {
    if (data.kind !== 'storyboard_script' && data.kind !== 'director') return null
    return state.nodes.find((item) => item.id === id) ?? null
  })
  const liveDirectorPreview = useStudioUiStore((state) => {
    if (data.kind !== 'director') return undefined
    const node = state.nodes.find((item) => item.id === id)
    return node ? resolveDirectorNodePreviewUrl(node.data, state.directorScenes) : undefined
  })
  const cardData = useMemo(() => {
    const base = liveNode?.data ?? data
    if (base.kind !== 'director' || !liveDirectorPreview) return base
    if (base.mediaUrl === liveDirectorPreview && base.mediaKind === 'image') return base
    return {
      ...base,
      mediaUrl: liveDirectorPreview,
      mediaKind: 'image' as const,
      status: base.status === 'empty' ? 'success' as const : base.status
    }
  }, [data, liveDirectorPreview, liveNode])
  const requestedImageCount = Number(cardData.generationOptions?.count) || 1
  const imageGallery = useCanvasImageGallery({
    runtime: canvasRuntime,
    nodeId: id,
    taskId: cardData.canvasCurrentTaskId,
    enabled: cardData.kind === 'image' && cardData.imagePurpose !== 'layer_separation' && cardData.status === 'success'
      && Boolean(cardData.mediaUrl) && requestedImageCount > 1
  })
  const imageEditing = Boolean(imageEditSession)
  const emotionEditing = Boolean(emotionSession)
  const showImageGallery = imageGallery.results.length > 1 && cardData.kind === 'image'
    && imageGallery.results.some((result) => result.resultId === cardData.canvasCurrentResultId)
    && !imageEditing && !emotionEditing
  const galleryCollapsed = Boolean(cardData.canvasCurrentTaskId && collapsedGalleryTaskId === cardData.canvasCurrentTaskId)
  const intrinsicMediaAspectRatio = intrinsicMedia && intrinsicMedia.url === cardData.mediaUrl ? intrinsicMedia.aspectRatio : null
  const storedDimensions = studioNodeDimensions({ data: cardData }, intrinsicMediaAspectRatio)
  const [previewW, previewH] = (cardData.generationOptions?.aspectRatio || '16:9').split(/[:/]/).map(Number)
  const previewRatio = previewW > 0 && previewH > 0 ? previewW / previewH : 16 / 9
  const galleryColumns = Math.ceil(Math.sqrt(imageGallery.results.length))
  const galleryRows = Math.ceil(imageGallery.results.length / galleryColumns)
  const dimensions = smartEditPreview ? { width: Math.min(480, 480 * previewRatio), height: Math.min(480, 480 / previewRatio) }
    : resizePreview ?? (showImageGallery && !galleryCollapsed
      ? { width: storedDimensions.width * galleryColumns + (galleryColumns - 1) * 8,
          height: storedDimensions.height * galleryRows + (galleryRows - 1) * 8 }
      : storedDimensions)
  useEffect(() => {
    if (!smartEditPreview || !smartEditDockHeight) return
    const element = cardRef.current?.closest('.react-flow')
    if (!element) return
    const positionPreview = () => {
      const viewport = element.getBoundingClientRect()
      const availableHeight = Math.max(80, window.innerHeight - smartEditDockHeight - viewport.top)
      const zoom = Math.max(0.1, Math.min(1, getViewport().zoom, (availableHeight - 48) / dimensions.height, (viewport.width - 64) / dimensions.width))
      // Keep the live video in the unobscured canvas area without moving or renaming the saved node.
      void setViewport({ x: viewport.width / 2 - (positionAbsoluteX + dimensions.width / 2) * zoom, y: availableHeight / 2 - (positionAbsoluteY + dimensions.height / 2) * zoom, zoom })
    }
    positionPreview()
    const observer = new ResizeObserver(positionPreview)
    observer.observe(element)
    return () => observer.disconnect()
  }, [dimensions.height, dimensions.width, getViewport, positionAbsoluteX, positionAbsoluteY, setViewport, smartEditDockHeight, smartEditPreview])
  const textContent = cardData.kind === 'text' || cardData.kind === 'storyboard_script'
    ? resolveStudioScriptNodeText(cardData)
    : resolveStudioScriptNodeText(cardData) || cardData.resultSummary || cardData.subtitle || (
      cardData.prompt !== meta.defaultPrompt ? cardData.prompt : ''
    )
  const scriptNode = isStudioScriptContentNode(cardData)
  const imagePendingNode = isStudioImagePendingNode(cardData)
  const imageHdConfigNode = isStudioImageHdConfigNode(cardData)
  const imageMattingPendingNode = isStudioImageMattingPendingNode(cardData)
  const videoContentNode = isStudioVideoContentNode(cardData)
  const videoPendingNode = isStudioVideoPendingNode(cardData)
  const videoHdConfigNode = isStudioVideoHdConfigNode(cardData)
  const videoOperationResultNode = isStudioVideoOperationResultNode(cardData)
  const videoClipDraftNode = isStudioVideoClipDraftNode(cardData)
  const mediaDerivationNode = isStudioMediaDerivationNode(cardData)
    || (cardData.kind === 'voice' && !cardData.flowBinding && Boolean(cardData.mediaUrl || cardData.audioEdit))
  const mediaFillNode = isStudioMediaFillNode(cardData)
  const materialNode = studioMode === 'free' && isStudioMaterialNodeKind(cardData.kind)
  const gridStoryboardNode = isStudioGridStoryboardNode(cardData)
  const frameBreakdownNode = cardData.kind === 'frame_breakdown' || cardData.kind === 'smart_edit'
  const storyboardAwaitingImage = needsStudioStoryboardImage(cardData)
  const hasContent = Boolean(
    cardData.mediaUrl
    || gridStoryboardNode
    || textContent.trim()
    || (cardData.kind === 'director' && cardData.directorSceneId)
  )
  const directorHasPreview = cardData.kind === 'director' && Boolean(cardData.mediaUrl)
  const effectiveMediaKind = resolveStudioNodeMediaKind(cardData.kind, cardData.mediaKind)
  const generationMediaKind: StudioMediaKind = cardData.kind === 'voice'
    ? 'audio'
    : cardData.kind === 'text' || cardData.kind === 'storyboard_script' || cardData.kind === 'note'
      ? 'text'
      : effectiveMediaKind ?? 'image'

  const commitNodeResize = useCallback((params: ResizeParams) => {
    const state = useStudioUiStore.getState()
    const target = state.nodes.find((node) => node.id === id)
    if (!target) return
    const parentGroup = target.data.groupId
      ? state.groups.find((group) => group.id === target.data.groupId)
      : undefined
    state.resizeNodeFrame(id, {
      position: {
        x: params.x + (parentGroup?.position.x ?? 0),
        y: params.y + (parentGroup?.position.y ?? 0)
      },
      width: params.width,
      height: params.height
    })
  }, [id])

  const resizeGridStoryboardWithKeyboard = useCallback((
    direction: 'expand' | 'shrink' | 'widen' | 'narrow',
    step: number
  ) => {
    if (direction === 'widen' || direction === 'narrow') return
    const state = useStudioUiStore.getState()
    const target = state.nodes.find((node) => node.id === id)
    if (!target || !isStudioGridStoryboardNode(target.data)) return
    const current = studioNodeDimensions(target)
    const requestedHeight = current.height + (direction === 'expand' ? step : -step)
    const height = Math.max(
      STUDIO_GRID_STORYBOARD_MIN_HEIGHT,
      Math.min(STUDIO_GRID_STORYBOARD_MAX_HEIGHT, requestedHeight)
    )
    if (height === current.height) return
    state.resizeNodeFrame(id, {
      position: { x: target.position.x, y: target.position.y - (height - current.height) },
      width: current.width,
      height
    })
  }, [id])
  const generating = data.status === 'queued' || data.status === 'generating'
  // Return a primitive reason: pointer frames must not rerender every canvas node.
  const connectionDisabledReason = useStore(state => {
    const connection = state.connection
    if (studioMode !== 'free' || !connection.inProgress) return undefined
    return studioConnectionCandidateDisabledReason({ id: connection.fromNode.id,
      kind: connection.fromNode.data.kind as StudioNodeKind, role: connection.fromHandle.type }, { id, kind: cardData.kind }, studioMode)
  })
  const manualInputAllowed = studioMode !== 'free' || (cardData.kind !== 'voice' && !materialNode)
  const connectionMotionTarget = studioMode === 'free' && !serverReadOnly && !reducedMotion && !connectionDisabledReason && isStudioConnectionMotionTarget(cardData)
  const uploading = uploadProgress !== null
  const emptyPlaceholderNode = !frameBreakdownNode && isStudioEmptyPlaceholderNode({
    data: cardData,
    textContent,
    generating,
    uploading,
    scriptNode,
    mediaFillNode,
    gridStoryboardNode,
    imagePendingNode,
    videoPendingNode,
    imageHdConfigNode,
    imageMattingPendingNode,
    videoHdConfigNode
  })
  const nextStepsEnabled = studioMode === 'free'
    && emptyPlaceholderNode
    && !cardData.emptyNextStepConsumed
  const showExternalTitle = scriptNode || frameBreakdownNode || mediaFillNode || gridStoryboardNode || imagePendingNode || imageHdConfigNode || imageMattingPendingNode || videoPendingNode || videoHdConfigNode || videoOperationResultNode || videoClipDraftNode || mediaDerivationNode || emptyPlaceholderNode
  // 服务端项目服从成员权限；无项目 ID 的本地自由画布仍可编辑并沿用本地持久化。
  const titleBusy = Boolean(canvasRuntime?.isNodeBusy(id)) || data.status === 'queued' || data.status === 'generating'
  const titleEditable = studioMode === 'free' && !titleBusy && (!canvasRuntime || canvasRuntime.canEdit)
  const mediaPlaceholderShell = emptyPlaceholderNode
  const retryKind = cardData.kind === 'image' || cardData.kind === 'video' || cardData.kind === 'text'
    ? cardData.kind
    : undefined
  const retryConfig = useMemo(() => cardData.canvasGenerationRetry ?? (retryKind && cardData.prompt ? {
    kind: retryKind,
    prompt: cardData.prompt,
    model: cardData.model,
    negativePrompt: cardData.negativePrompt,
    generationOptions: cardData.generationOptions
  } : undefined), [cardData.canvasGenerationRetry, cardData.generationOptions, cardData.model,
    cardData.negativePrompt, cardData.prompt, retryKind])
  const retryable = Boolean(canvasRuntime && retryConfig && !serverReadOnly && !cardData.canvasTransient && !cardData.mediaUrl
    && (cardData.status === 'failed'
      || (cardData.status === 'empty' && ['CANCELLED', 'CANCELED'].includes(String(cardData.canvasLatestTaskStatus || '').toUpperCase()))))
  const retryGeneration = useCallback(() => {
    if (!canvasRuntime || !retryConfig || !retryable) return
    useStudioUiStore.getState().updateNodeData(id, {
      ...(retryConfig.model ? { model: retryConfig.model } : {}),
      ...(retryConfig.negativePrompt ? { negativePrompt: retryConfig.negativePrompt } : {})
    })
    selectNodes([id])
    void canvasRuntime.generateNode(retryConfig.kind, id, retryConfig.prompt, retryConfig.generationOptions as {
      sessionId?: string
      imageUpscale?: { sourceNodeId: string; modelCode: string; sourceWidth: number; sourceHeight: number; scale: 2 | 4 | 6 }
      imageEdit?: import('@/hooks/studio/useCanvasProjectWorkspace').CanvasImageEditInput
    }).catch((error: unknown) => message.error(apiErrorMessage(error, '重新生成失败')))
  }, [canvasRuntime, id, retryConfig, retryable, selectNodes])
  const canvasOnlyInFlow = studioMode === 'flow' && !data.flowBinding
  const uploadable = !serverReadOnly && !data.flowBinding && !data.mediaDerivation && !data.videoSubjectEdit && !data.audioEdit && data.videoPurpose !== 'depth_capture' && (
    data.kind === 'image'
    || data.kind === 'video'
    || data.kind === 'voice'
    || data.kind === 'text'
    || data.kind === 'storyboard_script'
  )
  const referenceCandidate = referencePicker && referenceTarget
    ? { id, data }
    : null
  const referenceDisabledReason = referenceCandidate && referenceTarget
    ? studioReferencePickDisabledReason(referenceTarget, referenceCandidate)
    : null
  const referenceTooltip = referencePicker
    ? referenceDisabledReason
      ? referenceDisabledReason
      : <><strong>{data.title}</strong><span>{meta.description}</span></>
    : null

  useEffect(() => {
    // React Flow's shared ResizeObserver already measures free-canvas node bounds.
    if (studioMode === 'free') return
    if (typeof window.requestAnimationFrame !== 'function') {
      updateNodeInternals(id)
      return
    }
    const frame = window.requestAnimationFrame(() => updateNodeInternals(id))
    return () => window.cancelAnimationFrame(frame)
  }, [dimensions.height, dimensions.width, id, studioMode, updateNodeInternals])

  const rememberIntrinsicMediaSize = useCallback((width: number, height: number) => {
    const mediaUrl = cardData.mediaUrl
    if (!mediaUrl) return
    const aspectRatio = rememberStudioMediaAspectRatio(mediaUrl, width, height)
    if (!aspectRatio) return
    setIntrinsicMedia((current) => current && current.url === mediaUrl && Math.abs(current.aspectRatio - aspectRatio) < .0001
      ? current
      : { url: mediaUrl, aspectRatio })
    // Decoded media dimensions are view state. Saving them changes the server input
    // version and invalidates its selected generation result on the next reload.
    if (studioMode === 'free') return
    const persisted = useStudioUiStore.getState().nodes.find((item) => item.id === id)?.data.mediaAspectRatio
    if (typeof persisted === 'number' && Math.abs(persisted - aspectRatio) < 0.0001) return
    useStudioUiStore.getState().updateNodeData(id, { mediaAspectRatio: aspectRatio }, false)
  }, [cardData.mediaUrl, id, studioMode])

  const updateConnectionHandle = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    const card = cardRef.current
    const shell = shellRef.current
    if (!card || !shell || event.buttons) return
    const rect = card.getBoundingClientRect()
    const hit = resolveStudioConnectionHandle({
      pointerX: event.clientX,
      pointerY: event.clientY,
      rect,
      scale: rect.width / card.offsetWidth
    })
    if (hit?.side === 'left') {
      shell.style.setProperty('--studio-connection-handle-left-x', `${hit.x}px`)
      shell.style.setProperty('--studio-connection-handle-left-y', `${hit.y}px`)
    } else {
      shell.style.removeProperty('--studio-connection-handle-left-x')
      shell.style.removeProperty('--studio-connection-handle-left-y')
    }
    if (hit?.side === 'right') {
      shell.style.setProperty('--studio-connection-handle-right-x', `${hit.x}px`)
      shell.style.setProperty('--studio-connection-handle-right-y', `${hit.y}px`)
    } else {
      shell.style.removeProperty('--studio-connection-handle-right-x')
      shell.style.removeProperty('--studio-connection-handle-right-y')
    }
  }, [])

  const clearConnectionHandle = useCallback(() => {
    const shell = shellRef.current
    if (!shell) return
    shell.style.removeProperty('--studio-connection-handle-left-x')
    shell.style.removeProperty('--studio-connection-handle-left-y')
    shell.style.removeProperty('--studio-connection-handle-right-x')
    shell.style.removeProperty('--studio-connection-handle-right-y')
  }, [])

  const openConnectedNodeMenu = useCallback((
    side: 'source' | 'target',
    event: React.MouseEvent<HTMLElement>
  ) => {
    event.preventDefault()
    event.stopPropagation()
    window.dispatchEvent(new CustomEvent('studio:open-connected-node-menu', {
      detail: { nodeId: id, side, clientX: event.clientX, clientY: event.clientY }
    }))
  }, [id])

  const selectFromHeader = useCallback(() => {
    if (!referencePicker) selectNodes([id])
  }, [id, referencePicker, selectNodes])

  const openImageToolsFromHeader = useCallback(() => {
    if (referencePicker) return
    selectNodes([id])
    runOnNextBrowserFrame(() => {
      window.dispatchEvent(new CustomEvent('studio:open-image-tools', { detail: { nodeId: id } }))
    })
  }, [id, referencePicker, selectNodes])

  const openStoryboardEditor = useCallback(() => {
    if (referencePicker) return
    selectNodes([id])
    const binding = useStudioUiStore.getState().nodes.find((item) => item.id === id)?.data.flowBinding
      ?? data.flowBinding
    if (binding) {
      const store = useCreationStore.getState()
      if (!openStudioFlowBoundEntity(binding, store.formData.storyboardScript.panels, store.currentProjectId)) {
        message.warning('未找到对应分镜，请刷新后重试')
      }
      return
    }
    window.requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('studio:open-storyboard-editor', { detail: { nodeId: id } }))
    })
  }, [data.flowBinding, id, referencePicker, selectNodes])

  const openPreview = useCallback(() => {
    const mediaUrl = cardData.mediaUrl
    if (!mediaUrl) return
    if (effectiveMediaKind === 'video' && !isImagePreviewUrl(mediaUrl)) {
      openVideoPreviewModal({ url: mediaUrl, title: cardData.title })
      return
    }
    if (effectiveMediaKind === 'image' || isImagePreviewUrl(mediaUrl)) {
      openImagePreviewModal({ url: mediaUrl, title: cardData.title })
    }
  }, [cardData.mediaUrl, cardData.title, effectiveMediaKind])

  const selectGalleryMain = useCallback(async (resultId: string) => {
    if (!canvasRuntime || selectingGalleryResultId) return
    setSelectingGalleryResultId(resultId)
    try {
      await canvasRuntime.selectNodeResult(id, resultId)
    } catch (error) {
      message.error(apiErrorMessage(error, '设置主图失败'))
    } finally {
      setSelectingGalleryResultId(null)
    }
  }, [canvasRuntime, id, selectingGalleryResultId])

  const downloadGalleryImage = useCallback((result: CanvasImageGalleryResult) => {
    void downloadMediaFileWithToast(result.resultUrl, `${cardData.title}-${result.resultIndex + 1}`, '图片')
  }, [cardData.title])

  const previewGalleryImage = useCallback((result: CanvasImageGalleryResult) => {
    openImagePreviewModal({ url: result.resultUrl, title: `${cardData.title} · 第${result.resultIndex + 1}张` })
  }, [cardData.title])

  const captureFrame = useCallback(async (frame: '首帧' | '当前帧' | '尾帧') => {
    if (!data.mediaUrl || captureInFlight.current || isImagePreviewUrl(data.mediaUrl)
      || canvasRuntime && !canvasRuntime.canMutate) return
    const duration = Number(videoRef.current?.duration)
    if (frame !== '首帧' && (!Number.isFinite(duration) || duration <= 0)) {
      message.warning('视频元数据尚未加载，请稍后再试')
      return
    }
    const targetSeconds = frame === '首帧' ? 0 : frame === '尾帧' ? duration : Number(videoRef.current?.currentTime) || 0
    const initial = useStudioUiStore.getState()
    const source = initial.nodes.find(node => node.id === id)
    if (!source || source.data.mediaUrl !== data.mediaUrl) return
    const scopeKey = initial.scopeKey, sourceUrl = data.mediaUrl
    captureInFlight.current = true
    setCaptureBusy(true)
    const position = placeStudioNodeWithoutOverlap(
      { x: source.position.x + 310, y: source.position.y },
      { width: 240, height: 180 }, initial.nodes.map(toStudioNodeRect)
    )
    const targetId = addNode('image', position, {
      title: `${data.title} · ${frame}`, subtitle: `由 ${data.title} 截取`, zoneId: data.zoneId,
      status: 'generating', canvasTransient: true, mediaKind: 'image',
      imagePurpose: 'reference', prompt: `${data.title} ${frame}`, resultSummary: '正在截取并保存画面'
    }, { nodeId: id, role: 'source', kind: 'reference' })
    const runId = beginStudioOperationRun(scopeKey, [targetId])
    if (!runId) { captureInFlight.current = false; setCaptureBusy(false); return }
    const targetHash = createStudioOperationInputHash(scopeKey, [targetId])
    const targetExists = () => useStudioUiStore.getState().scopeKey === scopeKey
      && useStudioUiStore.getState().nodes.some(node => node.id === targetId)
    const sourceCurrent = () => useStudioUiStore.getState().nodes.some(node => node.id === id && node.data.mediaUrl === sourceUrl)
    const targetCurrent = () => isStudioOperationRunCurrent(scopeKey, runId, [targetId])
      && isStudioOperationInputCurrent(scopeKey, targetHash, [targetId])
    let resultReady = false
    try {
      const file = await captureStudioCanvasVideoFrame(sourceUrl, targetSeconds, `${data.title}-${frame}`, (phase, progress) => {
        if (!targetCurrent() || !sourceCurrent()) return
        const labels = { reading: '正在读取视频', seeking: '正在定位画面', encoding: '正在保存画面' }
        const percent = progress == null ? '' : ` ${Math.round(progress * 100)}%`
        useStudioUiStore.getState().updateNodeData(targetId, { resultSummary: `${labels[phase]}${percent}` }, false)
      })
      if (!targetCurrent()) return
      if (!sourceCurrent()) throw new Error('原视频已变化，请重新截取')
      const { readMediaFileAspectRatio } = await import('@/utils/studio/studioMediaFileAspect')
      const aspectRatio = await readMediaFileAspectRatio(file)
      if (!targetCurrent()) return
      if (!sourceCurrent()) throw new Error('原视频已变化，请重新截取')
      useStudioUiStore.getState().updateNodeData(targetId, { resultSummary: '正在上传截取画面' }, false)
      const resource = canvasRuntime ? await canvasRuntime.uploadResource(file, 'IMAGE') : null
      const mediaUrl = canvasRuntime ? resource?.resourceUrl : await uploadImageToOssWithToast(file, () => undefined)
      if (!targetCurrent()) return
      if (!sourceCurrent()) throw new Error('原视频已变化，请重新截取')
      if (!mediaUrl) throw new Error('截取画面上传失败，请从原视频重试')
      useStudioUiStore.getState().updateNodeData(targetId, {
        status: 'success', canvasTransient: false, mediaUrl, mediaAspectRatio: aspectRatio ?? undefined,
        errorMessage: undefined, resultSummary: `视频 ${formatFrameTime(targetSeconds)} 处画面`,
        operationRunId: undefined,
        ...(resource ? { canvasResourceIds: [String(resource.resourceId)], canvasPrimaryResourceId: String(resource.resourceId) } : {})
      })
      resultReady = true
      if (canvasRuntime) await canvasRuntime.saveNow()
      message.success(`${frame}已生成图片节点`)
    } catch (error: unknown) {
      if (!targetExists() || !resultReady && !targetCurrent()) return
      const detail = (error as Error)?.message || `${frame}截取失败`
      if (!resultReady) useStudioUiStore.getState().updateNodeData(targetId, {
        status: 'failed', operationRunId: undefined, errorMessage: detail, resultSummary: detail
      })
      message.error(resultReady ? `画面已截取，但画布保存失败：${detail}` : detail)
    } finally {
      const store = useStudioUiStore.getState()
      const target = store.scopeKey === scopeKey ? store.nodes.find(node => node.id === targetId) : undefined
      if (!resultReady && target?.data.operationRunId === runId) store.updateNodeData(targetId, {
        operationRunId: undefined,
        ...(target.data.status === 'generating' ? { status: 'failed', errorMessage: '结果节点已修改，请从原视频重新截帧' } : {})
      })
      captureInFlight.current = false
      setCaptureBusy(false)
    }
  }, [addNode, canvasRuntime, data.mediaUrl, data.title, data.zoneId, id])

  useEffect(() => {
    const handleCaptureRequest = (event: Event) => {
      const detail = parseStudioCaptureVideoFrameEvent(event)
      if (detail.nodeId !== id || !detail.frame) return
      void captureFrame(detail.frame)
    }
    window.addEventListener(STUDIO_CAPTURE_VIDEO_FRAME_EVENT, handleCaptureRequest)
    return () => window.removeEventListener(STUDIO_CAPTURE_VIDEO_FRAME_EVENT, handleCaptureRequest)
  }, [captureFrame, id])

  const handleLocalFile = useCallback(async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || data.flowBinding || fileUploadInFlight.current || uploadProgress !== null || (canvasRuntime && !canvasRuntime.canMutate)) return
    fileUploadInFlight.current = true
    setUploadProgress(0)
    const expectedScope = useStudioUiStore.getState().scopeKey
    const expectedWorkspace = canvasRuntime?.project?.workspace.workspaceId
    let expectedUrl = data.mediaUrl
    const current = () => useStudioUiStore.getState().scopeKey === expectedScope
      && canvasRuntime?.project?.workspace.workspaceId === expectedWorkspace
      && useStudioUiStore.getState().nodes.some(node => node.id === id && node.data.kind === data.kind && node.data.mediaUrl === expectedUrl
        && (data.kind !== 'text' && data.kind !== 'storyboard_script' || node.data.documentContent === data.documentContent))
    try {
      if (canvasRuntime) {
        // Keep the existing persisted result until the replacement is registered.
        // A local preview must never be saved alongside the previous resource ID.
        if (data.kind === 'text') {
          await canvasRuntime.importNodeText(id, file)
          return
        }
        if (data.kind === 'image' || data.kind === 'video' || data.kind === 'voice') {
          const { readMediaFileAspectRatio } = await import('@/utils/studio/studioMediaFileAspect')
          const aspectRatio = data.kind === 'voice' ? null : await readMediaFileAspectRatio(file)
          if (!current()) return
          const resource = await canvasRuntime.uploadResource(file, data.kind === 'image' ? 'IMAGE' : data.kind === 'video' ? 'VIDEO' : 'AUDIO')
          if (!current()) return
          if (!resource.resourceUrl) throw new Error('素材上传未返回有效地址，请重试')
          updateNodeData(id, {
            mediaUrl: resource.resourceUrl, mediaKind: data.kind === 'voice' ? 'audio' : data.kind,
            mediaAspectRatio: aspectRatio ?? undefined, status: 'success', canvasTransient: false,
            errorMessage: undefined, resultSummary: file.name,
            canvasResourceIds: [String(resource.resourceId)], canvasPrimaryResourceId: String(resource.resourceId)
          }, true)
          try { await canvasRuntime.saveNow() }
          catch (error) { throw new Error(`素材已替换，但画布保存失败：${apiErrorMessage(error, '请重试保存')}`) }
          return
        }
      }
      if (data.kind === 'image' || data.kind === 'video') {
        const { createTrackedObjectUrl, revokeObjectUrl } = await import('@/utils/objectUrl')
        const { readMediaFileAspectRatio } = await import('@/utils/studio/studioMediaFileAspect')
        const aspectRatio = await readMediaFileAspectRatio(file)
        if (!current()) return
        const localUrl = createTrackedObjectUrl(file)
        const previousUrl = data.mediaUrl
        expectedUrl = localUrl
        updateNodeData(id, {
          mediaUrl: localUrl,
          mediaKind: data.kind === 'video' ? 'video' : 'image',
          mediaAspectRatio: aspectRatio ?? undefined,
          status: 'success',
          resultSummary: file.name
        }, true)
        setUploadProgress(0)
        try {
          const resource = canvasRuntime
            ? await canvasRuntime.uploadResource(file, data.kind === 'image' ? 'IMAGE' : 'VIDEO')
            : null
          const mediaUrl = resource?.resourceUrl || (data.kind === 'image'
            ? await uploadImageToOssWithToast(file, setUploadProgress)
            : await uploadVideoToOssWithToast(file, setUploadProgress))
          if (!current()) { revokeObjectUrl(localUrl); return }
          if (mediaUrl) {
            updateNodeData(id, {
              mediaUrl,
              mediaKind: data.kind === 'video' ? 'video' : 'image',
              mediaAspectRatio: aspectRatio ?? undefined,
              status: 'success',
              canvasTransient: false,
              errorMessage: undefined,
              resultSummary: file.name,
              ...(resource ? { canvasResourceIds: [String(resource.resourceId)], canvasPrimaryResourceId: String(resource.resourceId) } : {})
            }, false)
            revokeObjectUrl(localUrl)
            if (previousUrl?.startsWith('blob:')) revokeObjectUrl(previousUrl)
          } else {
            updateNodeData(id, {
              mediaUrl: previousUrl,
              mediaAspectRatio: data.mediaAspectRatio,
              status: data.status
            }, false)
            revokeObjectUrl(localUrl)
          }
        } catch (error: unknown) {
          if (current()) updateNodeData(id, {
            mediaUrl: previousUrl,
            mediaAspectRatio: data.mediaAspectRatio,
            status: data.status,
            ...(data.canvasTransient ? { errorMessage: apiErrorMessage(error, '上传失败，请重新选择文件') } : {})
          }, false)
          revokeObjectUrl(localUrl)
          throw error
        }
        return
      }
      setUploadProgress(0)
      if (data.kind === 'voice') {
        const resource = canvasRuntime ? await canvasRuntime.uploadResource(file, 'AUDIO') : null
        const mediaUrl = resource?.resourceUrl || await uploadAudioToOssWithToast(file)
        if (mediaUrl && current()) {
          updateNodeData(id, {
            mediaUrl,
            mediaKind: 'audio',
            status: 'success',
            canvasTransient: false,
            errorMessage: undefined,
            resultSummary: file.name,
            ...(resource ? { canvasResourceIds: [String(resource.resourceId)], canvasPrimaryResourceId: String(resource.resourceId) } : {})
          }, true)
        }
        return
      }
      if (data.kind !== 'text' && data.kind !== 'storyboard_script') return
      if (file.size > 2 * 1024 * 1024) {
        message.warning('文本文件不能超过 2MB')
        return
      }
      const content = (await file.text()).trim()
      if (!current()) return
      if (!content) {
        message.warning('文本文件没有可导入的内容')
        return
      }
      updateNodeData(id, {
        documentContent: content,
        mediaKind: 'text',
        status: 'success',
        canvasTransient: false,
        errorMessage: undefined
      }, true)
    } catch (error: unknown) {
      const detail = error as { msg?: string; message?: string }
      if (useStudioUiStore.getState().scopeKey === expectedScope) message.error(detail.msg || detail.message || '文件导入失败')
    } finally {
      fileUploadInFlight.current = false
      setUploadProgress(null)
    }
  }, [canvasRuntime, data.canvasTransient, data.documentContent, data.flowBinding, data.kind, data.mediaAspectRatio, data.mediaUrl, data.status, id, updateNodeData, uploadProgress])

  const card = (
    <div
      ref={shellRef}
      data-connection-tilt={connectionMotionTarget ? 'true' : undefined}
      data-connection-disabled={connectionDisabledReason ? 'true' : undefined}
      className={`studio-node-shell${showExternalTitle ? ' studio-node-shell--titled' : ''}${scriptNode ? ' studio-node-shell--script' : ''}${frameBreakdownNode || mediaFillNode || materialNode || gridStoryboardNode || imagePendingNode || videoPendingNode || imageHdConfigNode || imageMattingPendingNode || videoHdConfigNode || videoOperationResultNode || videoClipDraftNode || mediaDerivationNode || mediaPlaceholderShell ? ' studio-node-shell--image' : ''}${imageEditSession ? ' is-image-editing' : ''}${videoEditSession ? ' is-video-editing' : ''}${selected ? ' is-selected' : ''}`}
      style={{ width: dimensions.width, height: dimensions.height, '--studio-connection-handle-zone': `${STUDIO_CONNECTION_HANDLE_ZONE_PX}px` } as CSSProperties}
      onPointerMove={updateConnectionHandle}
      onPointerLeave={clearConnectionHandle}
    >
      <StudioNodeLabelDecoration data={cardData} />
      {showExternalTitle ? (
        smartEditPreview ? (
          <StudioNodeExternalTitle kind="video" title="剪辑" plain />
        ) : gridStoryboardNode ? (
          <StudioNodeExternalTitle
            kind={cardData.kind}
            title={cardData.title}
            plain
            disabledReason={titleBusy ? '任务运行中，完成后可重命名' : undefined}
            editable={titleEditable}
            onTitleChange={(title) => updateNodeData(id, { title }, true)}
          />
        ) : (
          <StudioNodeExternalTitle
            kind={cardData.kind}
            title={cardData.title}
            disabledReason={titleBusy ? '任务运行中，完成后可重命名' : undefined}
            editable={titleEditable}
            onTitleChange={(title) => updateNodeData(id, { title }, true)}
          />
        )
      ) : null}
      <article
        ref={cardRef}
        className={`studio-node-card studio-node-card--${data.status} studio-node-card--media-${cardData.mediaKind ?? 'none'} studio-node-card--lod-${data.renderLod ?? 'full'}${generating ? ' studio-node-card--generating' : ''}${selected ? ' is-selected' : ''}${canvasOnlyInFlow ? ' is-canvas-only' : ''}${frameBreakdownNode || mediaFillNode || materialNode || gridStoryboardNode || imagePendingNode || videoPendingNode || imageHdConfigNode || imageMattingPendingNode || videoHdConfigNode || videoOperationResultNode || videoClipDraftNode || mediaDerivationNode || mediaPlaceholderShell ? ' studio-node-card--image-only' : ''}${showImageGallery ? ' studio-node-card--image-gallery' : ''}${showImageGallery && galleryCollapsed ? ' is-gallery-collapsed' : ''}${emptyPlaceholderNode ? ' studio-node-card--placeholder' : ''}${frameBreakdownNode ? ' studio-node-card--frame-breakdown' : ''}${scriptNode ? ' studio-node-card--script' : ''}${directorHasPreview ? ' studio-node-card--director-has-preview' : ''}${imageEditSession ? ' is-image-editing' : ''}${videoEditSession ? ' is-video-editing' : ''}${cardData.imagePurpose === 'matting' && cardData.mediaUrl ? ' is-matting-result' : ''}${serverReadOnly ? ' is-server-readonly' : ''}${referencePicker ? referenceDisabledReason ? ' is-reference-disabled' : ' is-reference-candidate' : ''}`}
        aria-label={`${meta.label}节点：${data.title}`}
        aria-busy={generating || uploading}
        style={{ width: dimensions.width, height: dimensions.height }}
      >
        {studioMode === 'free' ? <span className={`studio-node-card__connection-mask${connectionDisabledReason ? ' is-visible' : ''}`} aria-hidden="true"><span>{connectionDisabledReason}</span></span> : null}
        {connectionMotionTarget ? <span className="studio-node-card__connection-glow" aria-hidden="true" /> : null}
        {serverReadOnly ? <span className="studio-node-card__readonly-shield" aria-hidden="true" /> : null}
      {canvasOnlyInFlow ? (
        <span className="studio-node-card__canvas-only-badge">画布专属 · 本地预演</span>
      ) : null}
      {String(cardData.resultSummary || '').includes('背景已锁定') ? (
        <span className="absolute left-2 top-2 z-[2] rounded-md bg-black/65 px-2 py-0.5 text-[11px] text-white">
          背景已锁定
        </span>
      ) : null}
      {studioMode === 'free' && !generating && (hasContent || data.flowBinding) ? (
        !scriptNode && !mediaFillNode && !materialNode && !gridStoryboardNode && !imagePendingNode && !imageHdConfigNode && !imageMattingPendingNode && !videoPendingNode && !showExternalTitle ? (
          <StudioNodeContentHeader
          title={data.title}
          status={data.status}
          mediaKind={effectiveMediaKind}
          videoPlayable={effectiveMediaKind === 'video' && Boolean(data.mediaUrl) && !isImagePreviewUrl(data.mediaUrl || '')}
          captureBusy={captureBusy}
          titleEditable={titleEditable}
          onSelect={selectFromHeader}
          onTitleChange={(title) => updateNodeData(id, { title }, true)}
          onOpenImageTools={!data.flowBinding && data.kind === 'image' ? openImageToolsFromHeader : undefined}
          onPreview={data.mediaUrl && (effectiveMediaKind === 'video' || effectiveMediaKind === 'image') ? openPreview : undefined}
          onDownload={data.mediaUrl ? () => { void downloadMediaFileWithToast(data.mediaUrl!, data.title, studioNodeMediaDownloadType(data.kind, data.mediaKind)) } : undefined}
          onCaptureFirst={data.kind === 'video' ? () => { void captureFrame('首帧') } : undefined}
          onCaptureCurrent={data.kind === 'video' ? () => { void captureFrame('当前帧') } : undefined}
          onCaptureLast={data.kind === 'video' ? () => { void captureFrame('尾帧') } : undefined}
        />
        ) : null
      ) : null}

      <StudioNodeGenerationSurface
        key={`${scopeKey}:${id}`}
        enabled={studioMode === 'free' && !frameBreakdownNode && !materialNode}
        active={generating && !uploading}
        successful={cardData.status === 'success'}
        resultKey={`${cardData.canvasCurrentTaskId ?? ''}:${cardData.canvasCurrentResultId ?? ''}:${cardData.mediaUrl ?? ''}`}
        mediaKind={generationMediaKind}
        queued={data.status === 'queued'}
        awaitingVerification={studioMode === 'free' && task?.canvasAwaitingVerification}
        stage={cardData.canvasTransient ? cardData.resultSummary : task?.stage}
        progress={canvasRuntime ? task?.canvasProgress : task?.progress}
        startedAt={task?.createdAt}
        darkTheme={theme !== 'opal'}
        reducedMotion={reducedMotion}
      >
        {showImageGallery ? (
          <StudioImageResultGallery
            results={imageGallery.results}
            mainResultId={cardData.canvasCurrentResultId}
            title={cardData.title}
            collapsed={galleryCollapsed}
            canEdit={Boolean(canvasRuntime?.canEdit)}
            selectingResultId={selectingGalleryResultId}
            onCollapse={() => { setCollapsedGalleryTaskId(cardData.canvasCurrentTaskId ?? null); selectNodes([id]) }}
            onExpand={() => setCollapsedGalleryTaskId(null)}
            onSelect={() => selectNodes([id])}
            onSelectMain={(resultId) => { void selectGalleryMain(resultId) }}
            onDownload={downloadGalleryImage}
            onPreview={previewGalleryImage}
            onMainIntrinsicSize={rememberIntrinsicMediaSize}
          />
        ) : (
        <StudioNodeBody
          nodeId={id}
          selected={selected}
          data={cardData}
          taskStage={task?.stage}
          progress={uploading ? uploadProgress : canvasRuntime ? task?.canvasProgress : task?.progress}
          generating={generating}
          uploading={uploading}
          freeCanvas={studioMode === 'free'}
          uploadable={uploadable}
          textContent={textContent}
          scriptNode={scriptNode}
          mediaFillNode={mediaFillNode}
          materialNode={materialNode}
          canReplaceMaterial={isConnectable && (!canvasRuntime || canvasRuntime.canMutate)}
          gridStoryboardNode={gridStoryboardNode}
          imagePendingNode={imagePendingNode}
          imageHdConfigNode={imageHdConfigNode}
          imageMattingPendingNode={imageMattingPendingNode}
          videoContentNode={videoContentNode}
          videoPendingNode={videoPendingNode}
          videoHdConfigNode={videoHdConfigNode}
          videoOperationResultNode={videoOperationResultNode}
          videoClipDraftNode={videoClipDraftNode}
          emptyPlaceholderNode={emptyPlaceholderNode}
          nextStepsEnabled={nextStepsEnabled}
          storyboardAwaitingImage={storyboardAwaitingImage}
          captureBusy={captureBusy}
          onPreview={openPreview}
          onDownload={
            cardData.mediaUrl
              ? () => {
                  void downloadMediaFileWithToast(
                    cardData.mediaUrl!,
                    cardData.title,
                    studioNodeMediaDownloadType(cardData.kind, cardData.mediaKind)
                  )
                }
              : undefined
          }
          onCaptureFirst={data.kind === 'video' ? () => { void captureFrame('首帧') } : undefined}
          onCaptureCurrent={data.kind === 'video' ? () => { void captureFrame('当前帧') } : undefined}
          onCaptureLast={data.kind === 'video' ? () => { void captureFrame('尾帧') } : undefined}
          videoRef={videoRef}
          onMediaIntrinsicSize={rememberIntrinsicMediaSize}
          onUpload={() => fileInputRef.current?.click()}
          onViewText={() => setFullTextOpen(true)}
          onOpenStoryboardEditor={openStoryboardEditor}
          onGenerateVideo={
            data.kind === 'video' && data.flowBinding
              ? () => dispatchStudioFlowGenerateVideo(id)
              : undefined
          }
          onGenerateStoryboardImage={
            isStudioFlowStoryboardStillNode(data)
              ? () => {
                  selectNodes([id])
                  dispatchStudioFlowGenerateStoryboardImage(id)
                }
              : undefined
          }
          retryable={retryable}
          onRetry={retryGeneration}
        />
        )}
        {imageGallery.error ? (
          <button type="button" className="studio-image-gallery__retry nodrag" onClick={(event) => { event.stopPropagation(); imageGallery.retry() }}>多图加载失败，重试</button>
        ) : null}

        {emotionSession ? <StudioEmotionFaceOverlay key={emotionSession.id} session={emotionSession} /> : null}
        {imageEditSession?.mode === 'crop' ? <StudioImageCropOverlay nodeId={id} /> : null}
        {imageEditSession?.mode === 'expand' ? <StudioImageExpandOverlay nodeId={id} /> : null}
      </StudioNodeGenerationSurface>

      {cardData.kind === 'director' ? <DirectorNodeEntry nodeId={id} title={cardData.title} /> : null}

      {uploadable ? (
        <input
          ref={fileInputRef}
          hidden
          type="file"
          accept={data.kind === 'image'
            ? 'image/jpeg,image/png,image/webp'
            : data.kind === 'video'
              ? 'video/mp4,video/webm,video/quicktime'
              : data.kind === 'voice'
                ? 'audio/mpeg,audio/wav,audio/mp4,audio/ogg,audio/webm,audio/*'
                : '.txt,.md,.markdown,text/plain,text/markdown'}
          onChange={(event) => void handleLocalFile(event)}
        />
      ) : null}
      {(scriptNode || cardData.textEditingEnabled) && cardData.kind !== 'storyboard_script' && fullTextOpen ? (
        <StudioScriptNodeWorkspaceModal
          open
          nodeId={id}
          title={data.title}
          initialContent={textContent}
          flowBinding={cardData.flowBinding}
          onClose={() => setFullTextOpen(false)}
        />
      ) : null}
      </article>
      {selected && gridStoryboardNode ? (
        <StudioVerticalResizeHandles
          label="调整分镜组高度"
          minHeight={STUDIO_GRID_STORYBOARD_MIN_HEIGHT}
          maxHeight={STUDIO_GRID_STORYBOARD_MAX_HEIGHT}
          onResizeStart={() => useStudioUiStore.getState().beginGraphTransaction()}
          onResize={(_, params) => setResizePreview({ width: params.width, height: params.height })}
          onResizeEnd={(_, params) => {
            setResizePreview(null)
            commitNodeResize(params)
          }}
          onKeyboardResize={resizeGridStoryboardWithKeyboard}
        />
      ) : null}
      {selected && cardData.kind === 'text' && cardData.textEditingEnabled ? (
        <NodeResizeControl
          position="bottom-right"
          minWidth={240}
          minHeight={220}
          maxWidth={960}
          maxHeight={900}
          className="studio-text-node-resize-control nodrag"
          onResizeStart={() => useStudioUiStore.getState().beginGraphTransaction()}
          onResize={(_, params) => setResizePreview({ width: params.width, height: params.height })}
          onResizeEnd={(_, params) => {
            setResizePreview(null)
            commitNodeResize(params)
          }}
        >
          <span aria-hidden />
        </NodeResizeControl>
      ) : null}
      {!materialNode ? <Handle
        type="target"
        id="target-hit"
        position={Position.Left}
        isConnectableStart={false}
        isConnectableEnd={!manualInputAllowed || connectionDisabledReason ? false : undefined}
        className="studio-node-handle studio-node-handle--hitzone"
        aria-label="连接到此节点"
      /> : null}
      <Handle
        type="source"
        isConnectableStart={materialNode && cardData.canvasTransient ? false : undefined}
        isConnectableEnd={connectionDisabledReason ? false : undefined}
        position={Position.Right}
        className="studio-node-handle studio-node-handle--right"
        data-studio-connection-anchor="source"
        aria-label="从右侧连接节点"
        onClick={(event) => {
          if (!materialNode || !cardData.canvasTransient) openConnectedNodeMenu('source', event)
        }}
      >
        <span><PlusOutlined /></span>
      </Handle>
      {!materialNode ? <Handle
        type="target"
        id="target-left"
        isConnectableStart={!manualInputAllowed ? false : undefined}
        isConnectableEnd={!manualInputAllowed || connectionDisabledReason ? false : undefined}
        aria-disabled={!manualInputAllowed || Boolean(connectionDisabledReason)}
        position={Position.Left}
        className="studio-node-handle studio-node-handle--left"
        data-studio-connection-anchor="target"
        aria-label={manualInputAllowed ? '从左侧添加上游节点' : '音频节点不接收连线'}
        onClick={(event) => openConnectedNodeMenu('target', event)}
      >
        <span><PlusOutlined /></span>
      </Handle> : null}
      {invalidReferences > 0 && <span className="studio-node-reference-error" role="img"
        aria-label={`${invalidReferences} 张连线参考图需要调整`}>!</span>}
    </div>
  )
  return referencePicker ? (
    <Tooltip title={referenceTooltip} mouseEnterDelay={0.12} classNames={{ root: 'studio-reference-picker-tooltip' }}>
      {card}
    </Tooltip>
  ) : card
}

function StudioNodeCardWithAccess(props: NodeProps<StudioCanvasNode>) {
  const readOnly = useStudioUiStore((state) => state.readOnly)
  const runtime = useCanvasProjectRuntime()
  return readOnly || Boolean(runtime && !runtime.canEdit)
    ? <StudioReadOnlyNodeCard {...props} /> : <StudioNodeCardComponent {...props} />
}

export const StudioNodeCard = memo(StudioNodeCardWithAccess, (prev, next) => (
  prev.id === next.id
  && prev.selected === next.selected
  && prev.data === next.data
  && prev.dragging === next.dragging
  && prev.isConnectable === next.isConnectable
))

function StudioNodeBody({
  nodeId,
  selected,
  data,
  taskStage,
  progress,
  generating,
  uploading,
  freeCanvas,
  uploadable,
  textContent,
  scriptNode,
  mediaFillNode,
  materialNode,
  canReplaceMaterial,
  gridStoryboardNode,
  imagePendingNode,
  imageHdConfigNode,
  imageMattingPendingNode,
  videoContentNode,
  videoPendingNode,
  videoHdConfigNode,
  videoOperationResultNode,
  videoClipDraftNode,
  emptyPlaceholderNode,
  nextStepsEnabled,
  storyboardAwaitingImage,
  captureBusy,
  onPreview,
  onDownload,
  onCaptureFirst,
  onCaptureCurrent,
  onCaptureLast,
  videoRef,
  onMediaIntrinsicSize,
  onUpload,
  onViewText,
  onOpenStoryboardEditor,
  onGenerateVideo,
  onGenerateStoryboardImage,
  retryable,
  onRetry
}: {
  nodeId: string
  selected: boolean
  data: StudioCanvasNode['data']
  taskStage?: string
  progress?: number | null
  generating: boolean
  uploading: boolean
  freeCanvas: boolean
  uploadable: boolean
  textContent: string
  scriptNode: boolean
  mediaFillNode: boolean
  materialNode: boolean
  canReplaceMaterial: boolean
  gridStoryboardNode: boolean
  imagePendingNode: boolean
  imageHdConfigNode: boolean
  imageMattingPendingNode: boolean
  videoContentNode: boolean
  videoPendingNode: boolean
  videoHdConfigNode: boolean
  videoOperationResultNode: boolean
  videoClipDraftNode: boolean
  emptyPlaceholderNode: boolean
  nextStepsEnabled: boolean
  storyboardAwaitingImage: boolean
  captureBusy: boolean
  onPreview: () => void
  onDownload?: () => void
  onCaptureFirst?: () => void
  onCaptureCurrent?: () => void
  onCaptureLast?: () => void
  videoRef: React.RefObject<HTMLVideoElement | null>
  onMediaIntrinsicSize: (width: number, height: number) => void
  onUpload: () => void
  onViewText: () => void
  onOpenStoryboardEditor: () => void
  onGenerateVideo?: () => void
  onGenerateStoryboardImage?: () => void
  retryable: boolean
  onRetry: () => void
}) {
  if (data.kind === 'frame_breakdown') {
    return <StudioFrameBreakdownNode nodeId={nodeId} data={data} />
  }
  if (data.kind === 'smart_edit') return <StudioSmartEditNode nodeId={nodeId} data={data} />
  if (imageMattingPendingNode) {
    return <StudioImageMattingSparkle label="抠图中" />
  }
  if (generating || uploading) {
    return (
      <div className="studio-node-card__generating">
        <i className="studio-node-card__sheen" />
        <i className="studio-node-card__loader" />
        <span>{uploading ? '上传中' : taskStage ?? '等待实时进度'}</span>
        <b
          role="progressbar"
          aria-label={uploading ? '上传进度' : '生成进度'}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={normalizeStudioProgress(progress)}
        >
          <em style={{ width: `${normalizeStudioProgress(progress)}%` }} />
        </b>
      </div>
    )
  }
  if (retryable) {
    return (
      <StudioNodeEmptyPreview
        kind={data.kind}
        uploadable={false}
        onUpload={onUpload}
        recoveryAction={{ label: '重新生成', onClick: onRetry }}
        statusMessage={data.status === 'failed'
          ? data.errorMessage || '生成未完成，请检查参数后重试'
          : '已取消本次生成'}
      />
    )
  }
  if (freeCanvas && !data.mediaUrl && ['image', 'video', 'voice'].includes(data.kind)
    && (data.status === 'failed' || ['CANCELLED', 'CANCELED'].includes(String(data.canvasLatestTaskStatus || '').toUpperCase()))) {
    return <StudioNodeEmptyPreview kind={data.kind} uploadable={uploadable} onUpload={onUpload}
      statusMessage={data.status === 'failed' ? data.errorMessage || '任务未完成，请调整参数后重试' : '已取消本次生成'} />
  }
  if (data.imagePurpose === 'matting' && data.status === 'failed' && !data.mediaUrl) {
    return <StudioNodeEmptyPreview kind="image" uploadable={uploadable} onUpload={onUpload} statusMessage={data.errorMessage || '抠图未完成，请检查参数后重试'} />
  }
  if (data.canvasTransient && data.status === 'failed' && !data.mediaUrl) {
    return <StudioNodeEmptyPreview kind={data.kind} uploadable={uploadable} onUpload={onUpload} statusMessage={data.errorMessage || '生成未完成，请检查参数后重试'} />
  }
  if (data.kind === 'text' && data.textEditingEnabled) {
    return (
      <StudioTextNodeEditor
        nodeId={nodeId}
        text={textContent}
        background={data.textBackground}
        selected={selected}
        onExpand={onViewText}
      />
    )
  }
  if (data.kind === 'voice' && data.audioEdit && data.status === 'failed' && !data.mediaUrl) {
    return (
      <div className="studio-audio-operation-error" role="alert">
        <WarningOutlined aria-hidden="true" />
        <strong>{AUDIO_OPERATION_LABELS[data.audioEdit.operation]}未完成</strong>
        <span>{data.errorMessage || '音频处理失败，请调整参数后重试'}</span>
      </div>
    )
  }
  if (materialNode) {
    return (
      <StudioStyleLibraryNodePreview
        nodeId={nodeId}
        data={data}
        canReplace={canReplaceMaterial}
        onIntrinsicSize={onMediaIntrinsicSize}
      />
    )
  }
  if (emptyPlaceholderNode) {
    return (
      <StudioNodeEmptyPreview
        kind={data.kind}
        showNextSteps={nextStepsEnabled}
        uploadable={uploadable}
        onUpload={onUpload}
      />
    )
  }
  if (gridStoryboardNode && data.gridStoryboard) {
    return (
      <StudioGridStoryboardNodePreview
        nodeId={nodeId}
        storyboard={data.gridStoryboard}
      />
    )
  }
  if (videoContentNode && data.mediaUrl) {
    return (
      <StudioVideoNodePreview
        nodeId={nodeId}
        mediaUrl={data.mediaUrl}
        directPlayback={freeCanvas}
        title={data.title}
        videoRef={videoRef}
        captureBusy={captureBusy}
        onIntrinsicSize={onMediaIntrinsicSize}
        onPreview={onPreview}
        onDownload={onDownload}
        onCaptureFirst={onCaptureFirst}
        onCaptureCurrent={onCaptureCurrent}
        onCaptureLast={onCaptureLast}
      />
    )
  }
  if (mediaFillNode && data.mediaUrl) {
    return (
      <StudioImageNodePreview
        mediaUrl={data.mediaUrl}
        title={data.title}
        deferOffscreen={freeCanvas}
        onIntrinsicSize={onMediaIntrinsicSize}
        onPreview={onPreview}
        onDownload={onDownload ?? onPreview}
      />
    )
  }
  if (imageHdConfigNode) {
    return (
      <div className="studio-node-card__hd-placeholder" aria-label="高清配置占位">
        配置参数生成高清图像
      </div>
    )
  }
  if (data.mediaDerivation && data.status === 'failed' && !data.mediaUrl) {
    return <StudioNodeEmptyPreview kind={data.kind} uploadable={false} onUpload={onUpload} />
  }
  if (videoHdConfigNode) {
    return (
      <div className="studio-node-card__hd-placeholder" aria-label="视频高清配置占位">
        配置补帧或慢放参数生成高清视频
      </div>
    )
  }
  if (videoOperationResultNode) {
    if (data.videoPurpose === 'depth_capture') {
      return (
        <div className="studio-node-card__hd-placeholder" aria-label="深度动作捕捉待提取">
          <PlayCircleOutlined aria-hidden style={{ fontSize: 42 }} />
        </div>
      )
    }
    if (data.status === 'failed') {
      return <StudioNodeEmptyPreview kind="video" uploadable={false} onUpload={onUpload} />
    }
    return (
      <div className="studio-node-card__hd-placeholder" aria-label="视频处理结果占位">
        视频处理中
      </div>
    )
  }
  if (videoClipDraftNode) {
    return (
      <div className="studio-node-card__hd-placeholder" aria-label="智能续写待生成">
        <PlayCircleOutlined />
        <span>填写续写内容后生成视频</span>
      </div>
    )
  }
  if (videoPendingNode) {
    if (uploadable) {
      return (
        <StudioNodeEmptyPreview
          kind="video"
          uploadable={uploadable}
          onUpload={onUpload}
        />
      )
    }
    return (
      <StudioImagePendingPreview
        kind="video"
        title="尚未生成视频"
        actionLabel={onGenerateVideo ? '生成视频' : undefined}
        onAction={onGenerateVideo}
      />
    )
  }
  if (imagePendingNode) {
    return (
      <StudioImagePendingPreview
        kind="image"
        title={onGenerateStoryboardImage ? '尚未生成分镜图' : undefined}
        actionLabel={onGenerateStoryboardImage ? '生成分镜图' : undefined}
        onAction={onGenerateStoryboardImage}
      />
    )
  }
  if (
    data.flowBinding?.entityType === 'rps_asset' &&
    data.flowBinding.role === 'item' &&
    data.flowAssetForms?.length
  ) {
    return <StudioImagePendingPreview kind="image" />
  }
  if (scriptNode) {
    const isStoryboard = data.kind === 'storyboard_script'
    return (
      <StudioScriptNodePreview
        content={textContent}
        badge={storyboardAwaitingImage ? '待出图' : undefined}
        viewLabel={isStoryboard ? '编辑 →' : '查看 →'}
        onView={isStoryboard ? onOpenStoryboardEditor : onViewText}
      />
    )
  }
  if (data.kind === 'storyboard_script') {
    return (
      <StudioImagePendingPreview
        kind="storyboard_script"
        title="尚未生成分镜脚本"
        actionLabel="编辑脚本"
        onAction={onOpenStoryboardEditor}
      />
    )
  }
  if (data.flowBinding) {
    return (
      <div className="studio-node-card__flow-content">
        <StudioNodeIcon kind={data.kind} variant="watermark" />
        {textContent ? <p>{textContent}</p> : <span>选中节点查看多功能对话框</span>}
        {textContent.length > 140 ? <button type="button" className="nodrag" onClick={onViewText}>查看全部</button> : null}
      </div>
    )
  }
  if ((data.kind === 'text' || data.kind === 'voice' && data.documentContent) && textContent.trim()) {
    return (
      <div className="studio-node-card__text-preview">
        <p>{textContent}</p>
        <button type="button" className="nodrag" onClick={(event) => { event.stopPropagation(); onViewText() }}>
          <ExpandAltOutlined /> 查看
        </button>
      </div>
    )
  }
  if (data.mediaKind === 'audio' && data.mediaUrl) {
    return <StudioAudioNodePreview key={data.mediaUrl} nodeId={nodeId} url={data.mediaUrl} />
  }
  return (
    <StudioNodeEmptyPreview
      kind={data.kind}
      uploadable={uploadable}
      onUpload={onUpload}
    />
  )
}

function normalizeStudioProgress(progress: number | null | undefined): number {
  const value = Number(progress)
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, value))
}

function formatFrameTime(seconds: number): string {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0
  const minutes = Math.floor(safe / 60)
  const remainder = safe - minutes * 60
  return `${String(minutes).padStart(2, '0')}:${remainder.toFixed(2).padStart(5, '0')}`
}

function runOnNextBrowserFrame(callback: () => void): void {
  if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(callback)
  else window.setTimeout(callback, 0)
}
