import type { DirectorSceneryMeta, DirectorActorMeta, DirectorActorActionClip, DirectorActionAsset, DirectorLensSpec, DirectorPathClip, DirectorViewportPrefs, DirectorScenePackageRef, DirectorSpaceGenJob } from './directorPreviz'
export type * from './directorPreviz'
import type { Edge, Node, Viewport, XYPosition } from '@xyflow/react'

import type { StudioVideoSubjectEdit } from './studio-video-subject'
import type { StudioAudioEdit } from './studio-audio'
import type { StudioSmartEditState } from './studio-smart-edit'
export type * from './studio-smart-edit'

export type StudioNodeKind =
  | 'image'
  | 'video'
  | 'frame_breakdown'
  | 'smart_edit'
  | 'text'
  | 'storyboard_script'
  | 'director'
  | 'style_library'
  | 'official_asset'
  | 'voice'
  | 'note'

export type StudioImagePurpose =
  | 'generic'
  | 'character'
  | 'scene'
  | 'prop'
  | 'storyboard'
  | 'reference'
  | 'hd'
  | 'outpaint'
  | 'crop'
  | 'matting'
  | 'erase'
  | 'repaint'
  | 'grid_storyboard'
  | 'layer_separation'
  | 'layer_extract'

export type StudioImageAiToolKind = 'hd' | 'expand' | 'repaint' | 'erase' | 'matting' | 'crop'

export type StudioImageHdScale = 2 | 4 | 6
export type StudioImageFineness = 'high' | 'medium' | 'low'

export type StudioVideoPurpose =
  | 'hd'
  | 'subtitle_removal'
  | 'reshoot'
  | 'continuation'
  | 'trim'
  | 'crop'
  | 'depth_capture'
  | 'audio_separation'
  | 'vocal_extraction'
  | 'background_audio_extraction'
  | 'subject_edit'
export type StudioVideoAudioTool = 'separate' | 'extract_vocals' | 'extract_background_audio'
export type StudioMediaDerivationRole = 'video' | 'audio'

/** 一次音轨处理任务产生的视频/音频配对关系，用于任务回填、恢复与画布溯源。 */
export interface StudioMediaDerivation {
  groupId: string
  sourceNodeId: string
  sourceVideoUrl: string
  sourceRecordId?: number
  operation: StudioVideoAudioTool
  outputRole: StudioMediaDerivationRole
  pairedNodeId: string
}
export type StudioVideoDepthResolution = '480' | '720'
export type StudioVideoResolution = '720' | '1080' | '2K' | '4K'
export type StudioVideoInterpolationMode = 'none' | 'high_quality'
export type StudioVideoFrameRate = 23.976 | 24 | 25 | 29.97 | 30 | 48 | 50 | 59.94 | 60 | 120
export type StudioVideoSlowMotionFactor = 1 | 2 | 3 | 4 | 5
export type StudioVideoSubtitleMode = 'auto' | 'region'

export interface StudioVideoClipRange {
  startSeconds: number
  endSeconds: number
  durationSeconds: number
}

export interface StudioEditorSourceIdentity {
  resultId?: string
  resourceId?: string
  mediaUrl?: string
}

export interface StudioNodeEditorSession {
  /** Local editing source, never persisted as workspace business data. */
  sourceIdentity?: StudioEditorSourceIdentity
}

export interface StudioVideoClipSession extends StudioNodeEditorSession {
  nodeId: string
  range: StudioVideoClipRange
  mode?: 'continuation' | 'trim' | 'crop'
  snapToSeconds?: boolean
  loopSelection?: boolean
  cropRect?: StudioLayerSplitRect
}

export interface StudioVideoSubtitleRegion {
  id: string
  rect: StudioLayerSplitRect
}

/** 视频字幕消除编辑会话：框选历史只存在当前会话，不写入工作区快照。 */
export interface StudioVideoEditSession extends StudioNodeEditorSession {
  nodeId: string
  mode: StudioVideoSubtitleMode
  regions: StudioVideoSubtitleRegion[]
  historyPast: StudioVideoSubtitleRegion[][]
  historyFuture: StudioVideoSubtitleRegion[][]
}

/** 擦除 / 重绘画笔工具 */
export type StudioImageMaskTool = 'brush' | 'rect' | 'eraser'

/** 图层分离：归一化矩形，相对图片内容区 0–1 */
export interface StudioLayerSplitRect {
  x: number
  y: number
  w: number
  h: number
}

export interface StudioLayerSplitRegion {
  id: string
  rect: StudioLayerSplitRect
  prompt: string
  thumbnailDataUrl?: string
}

export interface StudioLayerSplitSession extends StudioNodeEditorSession {
  nodeId: string
  regions: StudioLayerSplitRegion[]
  activeRegionId: string | null
  draftPrompt: string
  historyPast: StudioLayerSplitRegion[][]
  historyFuture: StudioLayerSplitRegion[][]
}

export interface StudioLayerTransform {
  rect: StudioLayerSplitRect
  rotationDeg: number
  flipX: boolean
  flipY: boolean
  opacity: number
  visible: boolean
}

export interface StudioLayerItem {
  id: string
  resourceId?: string
  mediaUrl: string
  label?: string
  transform: StudioLayerTransform
}

export interface StudioLayerSeparationState {
  sourceNodeId: string
  backgroundResourceId?: string
  backgroundUrl: string
  canvasWidth?: number
  canvasHeight?: number
  backgroundLocked: true
  layers: StudioLayerItem[]
  activeLayerId: string | null
  dirty: boolean
}

export type StudioGridCellCoord = { row: number; col: number }

export type StudioGridStoryboardCellStatus = 'empty' | 'uploading' | 'generating' | 'success' | 'failed'
export type StudioMediaKind = 'image' | 'video' | 'audio' | 'text'

/** 逐帧拉片把成片反向拆成镜头结构、画面运动和声音节奏，至少选择一个维度。 */
export type StudioFrameBreakdownDimension = 'storyboard' | 'motion' | 'music'

export interface StudioFrameBreakdownConfig {
  dimensions: StudioFrameBreakdownDimension[]
  /** 从画布选择时保留来源节点；本地上传没有此字段。 */
  sourceNodeId?: string
  sourceTitle?: string
}

export interface StudioFrameBreakdownSourceInput {
  nodeId?: string
  title: string
  mediaUrl: string
  resourceIds?: string[]
  primaryResourceId?: string
}

export interface StudioGridStoryboardCell {
  id: string
  row: number
  col: number
  mediaUrl?: string
  /** Registered workspace resource for recovery after URLs are stripped from metadata. */
  resourceId?: string
  mediaKind?: Extract<StudioMediaKind, 'image' | 'video'>
  /** 实际格槽媒体宽高比；拖出为独立节点时直接用于节点尺寸。 */
  mediaAspectRatio?: number
  /** 宫格切分后的画布显示尺寸；不能由宽高比推回面积。 */
  canvasWidth?: number
  canvasHeight?: number
  title?: string
  status?: StudioGridStoryboardCellStatus
}

export interface StudioGridStoryboardOrigin {
  gridNodeId: string
  cellId: string
  /** 宫格切分的原始媒体节点；拖出节点的引用边应回到这里，而不是分镜组。 */
  sourceNodeId?: string
  canvasWidth?: number
  canvasHeight?: number
}

export interface StudioGridStoryboard {
  rows: number
  columns: number
  aspectRatio: string
  showSerial: boolean
  cells: StudioGridStoryboardCell[]
  sourceNodeId?: string
}

/** 图片 AI 工具会话：裁剪 / 扩图 / 擦除 / 重绘 / 宫格在源节点上叠加交互，不落盘。 */
export interface StudioImageEditSession extends StudioNodeEditorSession {
  mode: 'crop' | 'expand' | 'erase' | 'repaint' | 'grid'
  nodeId: string
  aspectRatio: string
  /** 归一化裁剪/扩图框，相对图片内容区 0–1 */
  rect: { x: number; y: number; w: number; h: number }
  /** 扩图拖拽中才显示九宫格 */
  showGrid?: boolean
  /** 擦除 / 重绘：当前工具 */
  maskTool?: StudioImageMaskTool
  /** 擦除 / 重绘：笔刷直径（相对图片短边的比例 0–1） */
  brushSize?: number
  /** 重绘提示词 */
  repaintPrompt?: string
  /** 宫格切分：行数 */
  gridRows?: number
  /** 宫格切分：列数 */
  gridColumns?: number
  /** 宫格切分：已选格子（0-based） */
  selectedCells?: StudioGridCellCoord[]
  /** GRID keeps cell selection; REGIONS uses rect as a single source-pixel region. */
  splitMode?: 'GRID' | 'REGIONS'
  regionSelected?: boolean
  /** 宫格切分：生成高清倍数 */
  hdScale?: 2 | 4
}

/** 元素编辑（TouchEdit）工具 */
export type StudioTouchEditTool = 'point' | 'marquee' | 'brush'
export type StudioTouchEditRegionKind = 'modify' | 'move'
export type StudioTouchEditMenuPhase = 'action' | 'modifyInput' | 'moveConfirm'

export interface StudioTouchEditRect {
  x: number
  y: number
  w: number
  h: number
}

export interface StudioTouchEditRegion {
  id: string
  source: StudioTouchEditTool
  kind: StudioTouchEditRegionKind
  rect: StudioTouchEditRect
  fromRect?: StudioTouchEditRect
  brushPath?: { x: number; y: number }[]
  brushSize?: number
  detectLabel?: string
  instruction: string
  thumbnailDataUrl?: string
}

/** 元素编辑会话：独立于 imageEditSession，不落盘。 */
export interface StudioTouchEditSession extends StudioNodeEditorSession {
  nodeId: string
  tool: StudioTouchEditTool
  brushSize: number
  /** 进行中的草稿（未点「添加」） */
  draft: StudioTouchEditRegion | null
  menuPhase: StudioTouchEditMenuPhase
  activeRegionId: string | null
  edits: StudioTouchEditRegion[]
  /** 可 JSON 化的历史快照，供撤销 */
  history: Array<{
    draft: StudioTouchEditRegion | null
    edits: StudioTouchEditRegion[]
    menuPhase: StudioTouchEditMenuPhase
    activeRegionId: string | null
  }>
  draftInstruction: string
}

export type StudioNodeStatus = 'empty' | 'queued' | 'generating' | 'success' | 'failed'
export type StudioEdgeKind = 'sequence' | 'reference' | 'flow'
export type StudioTextBackgroundId = 'neutral' | 'paper' | 'mist' | 'lavender' | 'sage'
export type StudioTaskStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'cancelled'

export type StudioAutonomyMode = 'structure' | 'ask' | 'semi' | 'auto'
export type StudioMode = 'free' | 'flow'
export type StudioCanvasTool = 'select' | 'pan'
export type StudioVideoGenMode = 'imageToVideo' | 'multiParam' | 'gridVideo'

export type StudioFlowStep =
  | 'global-setting'
  | 'story-script'
  | 'scene-character'
  | 'storyboard-script'
  | 'storyboard-video'
  | 'dubbing'
  | 'preview'

export type StudioFlowEntityType =
  | 'project'
  | 'story_script'
  | 'rps_asset'
  | 'storyboard'
  | 'storyboard_video'
  | 'dubbing'
  | 'preview'

/**
 * 流程画布节点与服务端业务实体的稳定绑定。
 * 有此绑定的节点只能派发到七步流程能力，不允许回落到 Studio Mock。
 */
export interface StudioFlowBinding {
  role: 'step' | 'item'
  step: StudioFlowStep
  entityType: StudioFlowEntityType
  projectId: number
  episodeId: number
  serverId?: number
  assetType?: 'scene' | 'character' | 'prop'
  bindingKey: string
}

/** attachment：缩略图条 / 连线 / 上传；mention：仅正文 @chip，不上缩略图条 */
export type StudioComposerRefChannel = 'attachment' | 'mention'

export interface StudioComposerRef {
  id: string
  kind: 'node' | 'asset' | 'library' | 'upload' | 'frame' | 'likeness'
  nodeId?: string
  assetId?: string
  sourceCategoryCode?: string
  personalAudioAssetId?: string
  title: string
  mediaKind: StudioMediaKind
  previewUrl?: string
  /** 文本引用的完整正文；chip 只展示 title，详情通过浮层读取。 */
  textContent?: string
  /** 同源键，多实例共享；如 node:xxx / asset:yyy */
  sourceKey?: string
  /**
   * 展示通道。缺省按 attachment 兼容旧数据。
   * mention 只进正文 chip，不进上方缩略图条，也不驱动视频首尾帧。
   */
  channel?: StudioComposerRefChannel
  /** Explicit role from a persisted reference edge; absent on legacy/manual attachments. */
  inputRole?: 'reference' | 'first_frame' | 'last_frame' | 'text' | 'audio'
  /** Transient validation result; rendering remains safe, submission reports the problem. */
  inputError?: string
}

export type StudioStoryboardDialogueKind = 'dialogue' | 'narration'

export interface StudioStoryboardDialogueItem {
  id: string
  kind: StudioStoryboardDialogueKind
  speaker?: string
  content: string
}

export interface StudioStoryboardTableRow {
  id: string
  shot: string
  duration: number
  description: string
  shotSize: string
  lighting: string
  dialogue: StudioStoryboardDialogueItem[]
  soundEffect: string
  cameraMovement: string
  finalPrompt: string
  motionPrompt: string
  rowColor?: string
}

export type StudioStoryboardAssetKind = 'scene' | 'character' | 'prop'

export interface StudioStoryboardAssetRef {
  kind: StudioStoryboardAssetKind
  nodeId: string
  title: string
  imageUrl: string
}

export interface StudioFlowAssetImagePreview {
  imageId: number | string
  name?: string
  imageUrl: string
  selected: boolean
}

export interface StudioFlowAssetFormPreview {
  formId: number
  name: string
  prompt: string
  selectedImageUrl?: string
  images: StudioFlowAssetImagePreview[]
}

export interface StudioNodeData extends Record<string, unknown> {
  /** 画布生成失败后，在当前节点重试所需的原始提交参数。 */
  canvasGenerationRetry?: {
    kind: 'image' | 'video' | 'text' | 'audio'
    prompt: string
    model?: string
    negativePrompt?: string
    generationOptions?: Record<string, unknown>
  }
  mediaId?: string
  /** 服务端自由画布已登记的素材 ID；持久化时同时投影到 NODE 顶层 resourceIds。 */
  canvasResourceIds?: string[]
  /** 多素材节点用于恢复主预览的资源 ID。 */
  canvasPrimaryResourceId?: string
  /** 浏览器本地处理中占位节点；完成并登记资源前不得进入服务端工作区快照。 */
  canvasTransient?: boolean
  /** Deterministic image split provenance; output bytes and URL live in the resource registry. */
  imageSplitOrigin?: { sourceNodeId: string; sourceResourceId: string; row?: number; col?: number; x: number; y: number; width: number; height: number }
  /** 当前服务端生成任务，仅属客户端运行态，序列化时必须剔除。 */
  canvasCurrentTaskId?: string
  /** 最近服务端任务状态，用于保留已取消空节点的显式重试入口。 */
  canvasLatestTaskStatus?: string
  /** 工作区 currentResults 投影中的当前结果 ID；仅作运行态资源登记。 */
  canvasCurrentResultId?: string
  previzOfSceneId?: string
  previzOfNodeId?: string
  previzRecordMode?: 'active_camera' | 'director'
  /** 画布操作派生节点来源；普通手工添加节点没有此标记。 */
  operationOrigin?: 'director_reference' | 'director_recording'
  previzFps?: number
  previzWidth?: number
  previzHeight?: number
  previzBurnedNameplates?: boolean
  labelColor?: import('@/utils/studio/studioNodeLabels').StudioLabelId
  kind: StudioNodeKind
  title: string
  subtitle?: string
  zoneId?: string
  status: StudioNodeStatus
  prompt: string
  /** 文本节点正文；与底部 Composer 的生成提示词 prompt 分开持久化。 */
  documentContent?: string
  /** 空节点“下一步”已消费；组合内新节点不再递归展示引导。 */
  emptyNextStepConsumed?: boolean
  /** 文本“自己编写”态；正文写入 documentContent。 */
  textEditingEnabled?: boolean
  /** 自由画布可调整尺寸节点（文本/分镜组）由用户拖拽后的展示尺寸。 */
  displayWidth?: number
  displayHeight?: number
  /** 文本卡背景，与 labelColor 的分组标记职责分离。 */
  textBackground?: StudioTextBackgroundId
  imagePurpose?: StudioImagePurpose
  /** 图片描述结果文本节点；模型仍由 canvas.text.image_describe 业务池显式选择。 */
  imageDescribe?: { sourceNodeId: string }
  composerAgentOpen?: boolean
  composerSkillId?: string
  composerRefs?: StudioComposerRef[]
  /** 自由画布分镜构图功能 ID；见 studioStoryboardComposition */
  storyboardCompositionId?: string
  highlightRefNodeId?: string
  negativePrompt?: string
  model?: string
  modelName?: string
  modelCostCredits?: number | null
  modelIsFree?: boolean
  recommendedDurationSeconds?: number | null
  recommendedDurationSource?: string | null
  recommendedDurationDescription?: string | null
  composerAgentCode?: string
  composerAgentName?: string
  mediaKind?: StudioMediaKind
  frameBreakdown?: StudioFrameBreakdownConfig
  smartEdit?: StudioSmartEditState
  smartEditOrigin?: { nodeId: string; kind: 'video' | 'voice'; sourceNodeId?: string }
  generationOptions?: {
    aspectRatio?: string
    duration?: number
    /** 视频生成音频开关；与通用请求 audio 对应，缺省沿用模型默认。 */
    audioEnabled?: boolean
    motion?: string
    shootingTechnique?: string
    voice?: string
    quality?: string
    count?: number
    videoMode?: StudioVideoGenMode
    /** 用户选择的普通视频生成能力；缺省由模型能力决定，不按上游图片锁死。 */
    videoCapability?: string
    endFrameEnabled?: boolean
    startFrameUrl?: string
    endFrameUrl?: string
    styleId?: string
    styleName?: string
    stylePreviewUrl?: string
    stylePrompt?: string
    benchPreset?: 'three_view' | 'multi_camera' | 'quad_grid'
    texture?: { preset?: string; sharpness?: number; contrast?: number; grain?: number }
    narrative?: { shotSize?: string; cameraHeight?: string; moods?: string[] }
    /** 智能引用 AutoLink；缺省视为 true（默认开） */
    autoLink?: boolean
    /** 当前业务目录中的能力与完整官方参数；切换能力时显式重置。 */
    audioCapability?: string
    audioParameters?: Record<string, unknown>
    audioFiles?: import('./audio-model').AudioFileReference[]
    audioResourceIds?: string[]
    /** 音频节点：配音或音乐。缺省按配音展示，用户选择后才写入。 */
    audioPurpose?: 'speech' | 'music'
    /** 音频语种。 */
    audioLanguage?: 'zh' | 'en'
    /** 采样率，单位 Hz。 */
    sampleRate?: 8000 | 16000 | 24000 | 48000
    /** 输出格式。 */
    audioFormat?: 'wav' | 'mp3' | 'pcm' | 'ogg_opus'
    /** 音乐歌词来源。只有音乐模式才展示，自定义时才打开歌词输入。 */
    lyricsMode?: 'adaptive' | 'custom'
    /** 自定义歌词。切回自适应或配音时保留，避免来回切换丢稿。 */
    lyrics?: string
  }
  mediaUrl?: string
  /** 浏览器解码/本地文件测得的媒体宽高比；用于布局，避免刷新后先闪默认 16:9 */
  mediaAspectRatio?: number
  resultSummary?: string
  /** 隐藏节点底部多功能输入框；图片工具派生结果在成功后仍保留该意图 */
  composerHidden?: boolean
  /** 图层分离结果节点持久态（imagePurpose === layer_separation） */
  layerSeparation?: StudioLayerSeparationState
  /** 宫格分镜组：格槽数据（imagePurpose === grid_storyboard） */
  gridStoryboard?: StudioGridStoryboard
  /** 从宫格分镜拖出的节点来源；仅允许放回该分镜组的空格槽。 */
  gridStoryboardOrigin?: StudioGridStoryboardOrigin
  /** 高清 / 扩图配置节点参数 */
  imageToolOptions?: {
    provider?: string
    modelCode?: string
    scale?: StudioImageHdScale
    fineness?: StudioImageFineness
    aspectRatio?: string
    quality?: string
    count?: number
    sourceNodeId?: string
  }
  /** 视频高清 / 字幕消除派生节点参数。 */
  videoPurpose?: StudioVideoPurpose
  videoSubjectEdit?: StudioVideoSubjectEdit
  audioEdit?: StudioAudioEdit
  audioRunId?: string
  /** 异步媒体操作的前端 compare-and-set 令牌；晚到结果只能回填同一次运行。 */
  operationRunId?: string
  audioDurationSeconds?: number
  /** 音视频分离、人声或背景音提取生成的双节点关系。 */
  mediaDerivation?: StudioMediaDerivation
  videoToolOptions?: {
    sourceNodeId?: string
    sourceResourceId?: string
    /** 富文本内的视频操作语句；选择片段变化时只替换这一段。 */
    promptContext?: string
    /** 深度提取使用创建时的源文件快照，不能随源节点后续生成而改变。 */
    sourceVideoUrl?: string
    sourceRecordId?: number
    depthResolution?: StudioVideoDepthResolution
    clipRange?: StudioVideoClipRange
    cropRect?: StudioLayerSplitRect
    resolution?: StudioVideoResolution
    interpolationMode?: StudioVideoInterpolationMode
    frameRate?: StudioVideoFrameRate
    slowMotionFactor?: StudioVideoSlowMotionFactor
    subtitleMode?: StudioVideoSubtitleMode
    subtitleRegions?: StudioVideoSubtitleRegion[]
  }
  storyboardRows?: StudioStoryboardTableRow[]
  storyboardAssets?: StudioStoryboardAssetRef[]
  /** 流程素材的服务端只读投影；流程布局持久化时不会保存。 */
  flowAssetForms?: StudioFlowAssetFormPreview[]
  storyboardWorkflowStep?: 1 | 2 | 3
  storyboardPromptMode?: 'smart' | 'balanced'
  storyboardPromptTaskId?: number
  storyboardPromptTaskStatus?: 'QUEUED' | 'PENDING' | 'PROCESSING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED'
  storyboardPromptTaskRowIds?: string[]
  errorMessage?: string
  storyboardId?: string
  assetId?: string
  bindingKey?: string
  flowBinding?: StudioFlowBinding
  /** 仅含绑定键与布局的持久化占位；不能当作上一次成功业务快照。 */
  flowLayoutOnly?: boolean
  directorSceneId?: string
  groupId?: string
  renderLod?: 'ghost' | 'compact' | 'full'
  createdAt: string
  updatedAt: string
}

export interface StudioZoneData extends Record<string, unknown> {
  zoneId: string
  title: string
  caption: string
  color: string
  collapsed: boolean
}

export type StudioCanvasNode = Node<StudioNodeData, 'studioNode'>
export type StudioZoneNode = Node<StudioZoneData, 'studioZone'>

export interface StudioGroupData extends Record<string, unknown> {
  title: string
  childIds: string[]
  colorTag?: string | null
  layoutMode?: 'auto' | 'manual'
}

export type StudioGroupNode = Node<StudioGroupData, 'studioGroup'>
export type StudioFlowNode = StudioCanvasNode | StudioGroupNode | StudioZoneNode

export interface StudioEdgeData extends Record<string, unknown> {
  kind: StudioEdgeKind
  label: string
  flowManaged?: boolean
  bindingKey?: string
  /** Whether to render flowing energy overlays (set by prepareStudioVisibleEdges). */
  energy?: boolean
}

export type StudioFlowEdge = Edge<StudioEdgeData>

export interface StudioZone {
  id: string
  title: string
  caption: string
  color: string
  position: XYPosition
  width: number
  height: number
  collapsed: boolean
}

export interface StudioGroup {
  id: string
  title: string
  position: XYPosition
  width: number
  height: number
  childIds: string[]
  /** auto 跟随成员紧凑包围；manual 保留用户调整的画布区域并确保成员不被裁切。 */
  layoutMode?: 'auto' | 'manual'
  /** 色标；null/undefined = 无色（默认底） */
  colorTag?: string | null
}

export interface StudioSavedAsset {
  id: string
  sourceNodeId: string
  kind: 'image' | 'video'
  title: string
  mediaUrl: string
  mediaKind?: StudioMediaKind
  createdAt: string
}

export interface StudioTask {
  id: string
  title: string
  nodeId?: string
  /** 同一个远端任务同时驱动的目标节点；节点卡片据此共享实时进度。 */
  targetNodeIds?: string[]
  runId?: string
  stage: string
  progress: number
  status: StudioTaskStatus
  errorMessage?: string
  remoteTaskId?: number
  /** 自由画布统一媒体任务 ID；按字符串保留 Long 精度。 */
  canvasProgress?: number | null
  canvasVideoFinishEta?: { p50: number; p90: number }
  /** 当前任务提交结果未知；不等同于尚未开始的队列任务。 */
  canvasAwaitingVerification?: boolean
  canvasTaskId?: string
  /** 自由画布生成幂等标识；SUBMITTING 尚无 taskId 时仍用于标记真实任务。 */
  canvasOperationId?: string
  /** 服务端按当前查看者计算的取消权限。 */
  canCancel?: boolean
  remoteTaskType?: 'storyboard_prompt' | 'director_space_gen'
  /** 页面刷新后恢复任务结果时使用；旧任务缺省按目标节点媒体类型推断。 */
  resultKind?: 'image' | 'video' | 'audio' | 'video_audio' | 'layer_split' | 'touch_edit' | 'director_space'
  /** 提交时目标节点的 compare-and-set 令牌。 */
  inputSnapshotHash?: string
  /** 参与输入快照校验的节点，刷新恢复时重新计算。 */
  inputNodeIds?: string[]
  autonomyMode?: StudioAutonomyMode
  completedNodeIds?: string[]
  createdAt: string
  updatedAt: string
}

export type StudioConversationPhase =
  | 'idle'
  | 'clarifying'
  | 'planning'
  | 'awaiting_confirmation'
  | 'executing'
  | 'paused'
  | 'completed'
  | 'failed'

export interface StudioConversationPlanStep {
  id: 'screenplay' | 'assets' | 'storyboard' | 'video'
  label: string
  status: 'pending' | 'waiting' | 'running' | 'completed' | 'failed'
  credits?: number
}

export interface StudioConversationState {
  phase: StudioConversationPhase
  goal: string
  parameters: { durationSeconds?: number; style?: string }
  pendingField?: 'durationSeconds' | 'style'
  planSteps: StudioConversationPlanStep[]
  updatedAt: string
}

import type { AgentThinkingStep } from '@/utils/agentThinkingSteps'

export interface StudioChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  status?: 'thinking' | 'generating' | 'complete' | 'failed'
  reasoning?: string
  thinkingSteps?: AgentThinkingStep[]
  thinkingStartedAt?: string
  thinkingCompletedAt?: string
  actionable?: boolean
  nodeIds?: string[]
  nodeReferences?: Array<{ id: string; title: string; kind: StudioNodeKind }>
  quickReplies?: Array<{ label: string; value: string }>
  quickReplyField?: 'durationSeconds' | 'style'
  actions?: Array<{ id: 'confirm_plan' | 'revise_plan'; label: string; primary?: boolean }>
  createdAt: string
}

export type DirectorObjectKind = 'actor' | 'prop' | 'scenery'
export type DirectorPropShape = 'box' | 'sphere' | 'cylinder' | 'torus' | 'cone' | 'pyramid' | 'capsule'
export type DirectorViewMode = 'director' | 'camera'
export type DirectorAspectRatio = 'adaptive' | '21:9' | '16:9' | '4:3' | '1:1' | '3:4' | '9:16'
export type DirectorModelFormat = 'fbx' | 'obj' | 'glb' | 'gltf'
export type DirectorModelAssetKind = 'actor' | 'prop'

export interface DirectorModelAsset {
  resourceId?: string
  bundle?: import('./canvas-api').CanvasModelBundle
  id: string
  name: string
  fileName: string
  url: string
  format: DirectorModelFormat
  kind: DirectorModelAssetKind
  source: 'local' | 'library' | 'builtin'
  byteSize?: number
  createdAt: string
}

export interface DirectorTransform {
  position: [number, number, number]
  rotation: [number, number, number]
  scale: [number, number, number]
}

export interface DirectorObject {
  scenery?: DirectorSceneryMeta
  actorMeta?: DirectorActorMeta
  id: string
  kind: DirectorObjectKind
  name: string
  color: string
  shape?: DirectorPropShape
  sourceNodeId?: string
  referenceImageUrl?: string
  modelAssetId?: string
  crowdGroupId?: string
  visible?: boolean
  locked?: boolean
  transform: DirectorTransform
  pose: Record<string, number>
}

export type DirectorLightKind = 'ambient' | 'directional' | 'point' | 'spot'

export interface DirectorLight {
  id: string
  kind: DirectorLightKind
  name: string
  color: string
  intensity: number
  position: [number, number, number]
  enabled: boolean
}

export interface DirectorCamera {
  position: [number, number, number]
  target: [number, number, number]
  fov: number
  /** 绕镜头光轴旋转的角度，单位为度；旧工程缺省为 0。 */
  roll?: number
}

export interface DirectorCameraBookmark {
  lens?: DirectorLensSpec
  aimObjectId?: string
  id: string
  name: string
  camera: DirectorCamera
  preset?: string
  thumbnailUrl?: string
  visible?: boolean
  locked?: boolean
  createdAt?: string
}

export interface DirectorCapture {
  id: string
  name: string
  mediaUrl: string
  camera: DirectorCamera
  createdAt: string
}

export type DirectorTransformTuple = [number, number, number]

export interface DirectorKeyframeTransformValue {
  position: DirectorTransformTuple
  rotation: DirectorTransformTuple
  scale: DirectorTransformTuple
}

export interface DirectorObjectTimelineKeyframe {
  id: string
  time: number
  value: DirectorKeyframeTransformValue
}

export interface DirectorObjectTimelineTrack {
  objectId: string
  keyframes: DirectorObjectTimelineKeyframe[]
}

export interface DirectorCameraKeyframeValue {
  position: DirectorTransformTuple
  target: DirectorTransformTuple
  fov: number
  roll?: number
}

export interface DirectorCameraTimelineKeyframe {
  id: string
  time: number
  value: DirectorCameraKeyframeValue
}

export interface DirectorCameraTimelineTrack {
  cameraId: string
  keyframes: DirectorCameraTimelineKeyframe[]
}

/** Flat joint pose snapshot used by mannequin pose tracks. */
export type DirectorPoseKeyframeValue = Record<string, number>

export interface DirectorPoseTimelineKeyframe {
  id: string
  time: number
  value: DirectorPoseKeyframeValue
}

export interface DirectorPoseTimelineTrack {
  objectId: string
  keyframes: DirectorPoseTimelineKeyframe[]
}

/** @deprecated Flat keyframes kept only for reading legacy scenes / projects. */
export interface DirectorTimelineKeyframe {
  id: string
  objectId: string
  time: number
  transform: DirectorTransform
}

export interface DirectorTimeline {
  actionClips?: DirectorActorActionClip[]
  pathClips?: DirectorPathClip[]
  /** Explicitly opened timeline lanes. The main camera is always visible. */
  laneIds?: string[]
  fps?: 30
  duration: number
  currentTime: number
  tracks: DirectorObjectTimelineTrack[]
  cameraTracks: DirectorCameraTimelineTrack[]
  poseTracks: DirectorPoseTimelineTrack[]
  /** Legacy flat keyframes; normalized away on read. */
  keyframes?: DirectorTimelineKeyframe[]
}

export interface DirectorSceneData {
  modeling?: import('./threePreviz').ThreePrevizModeling
  actionLibrary?: DirectorActionAsset[]
  revision?: number
  scenePackage?: DirectorScenePackageRef
  scenePackages?: DirectorScenePackageRef[]
  spaceGenJob?: DirectorSpaceGenJob
  viewportPrefs?: DirectorViewportPrefs
  id: string
  name: string
  objects: DirectorObject[]
  lights: DirectorLight[]
  camera: DirectorCamera
  environmentColor: string
  environmentPreset?: import('@/utils/studio/directorEnvironment').DirectorEnvironment
  weather?: import('@/utils/studio/directorEnvironment').DirectorWeather
  gridVisible?: boolean
  gridSnap?: boolean
  groundVisible?: boolean
  groundOpacity?: number
  aspectRatio?: DirectorAspectRatio
  viewMode?: DirectorViewMode
  directorCamera?: DirectorCamera
  cameraBookmarks?: DirectorCameraBookmark[]
  modelAssets?: DirectorModelAsset[]
  /** Older scenes with no flag retain their original main camera. */
  mainCameraPresent?: false
  mainCameraVisible?: boolean
  mainCameraLocked?: boolean
  mainCameraLens?: DirectorLensSpec
  mainCameraAimObjectId?: string
  activeCameraId?: string
  panoramaUrl?: string
  panoramaHistory?: string[]
  panoramaYaw?: number
  panoramaRadius?: number
  captures?: DirectorCapture[]
  timeline?: DirectorTimeline
  prompt?: string
  sourceNodeIds?: string[]
  previewImageUrl?: string
  updatedAt: string
}

export interface StudioWorkspaceSnapshot {
  nodes: StudioCanvasNode[]
  edges: StudioFlowEdge[]
  zones: StudioZone[]
  groups: StudioGroup[]
}

export interface StudioWorkspaceData extends StudioWorkspaceSnapshot {
  version: 1 | 2 | 3
  scopeKey: string
  studioMode: StudioMode
  title: string
  viewport: Viewport
  tasks: StudioTask[]
  messages: StudioChatMessage[]
  conversation: StudioConversationState
  savedAssets: StudioSavedAsset[]
  directorScenes: Record<string, DirectorSceneData>
  personalTemplates: StudioTemplate[]
  personalSkills: StudioSkill[]
  reducedMotion: boolean
  savedAt: string
}

export interface StudioDiagnostic {
  id: string
  severity: 'info' | 'warning' | 'error'
  nodeId?: string
  title: string
  reason: string
  action: string
}

export interface StudioTemplate {
  id: string
  name: string
  description: string
  source?: 'preset' | 'personal'
  nodes: Array<{
    kind: StudioNodeKind
    title: string
    zoneId: string
    position: XYPosition
    mediaKind?: StudioMediaKind
    imagePurpose?: StudioImagePurpose
  }>
  edges: Array<{ sourceIndex: number; targetIndex: number; kind: StudioEdgeKind }>
}

export interface StudioSkill {
  id: string
  name: string
  description: string
  action:
    | 'structure_only'
    | 'gen_script'
    | 'gen_assets'
    | 'gen_unit_chain'
    | 'diagnose'
    | 'quality_check'
  source: 'preset' | 'personal'
}

export interface StudioEmotionFaceRect { x: number; y: number; w: number; h: number }
export interface StudioEmotionFace {
  id: string
  label: string
  rect: StudioEmotionFaceRect
  source: 'auto' | 'manual' | 'default'
  affinity: number
  arousal: number
}
export interface StudioEmotionSession {
  id: string
  nodeId: string
  sourceUrl: string
  phase: 'picking' | 'editing'
  faces: StudioEmotionFace[]
  selectedFaceId: string | null
  detectionStatus: 'pending' | 'ready' | 'empty' | 'failed'
  manualMode: boolean
  quality: string
  count: number
}
