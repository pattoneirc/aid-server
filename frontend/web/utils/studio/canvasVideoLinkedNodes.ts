import type { StudioCanvasNode, StudioComposerRef, StudioNodeData } from '@/types/studio'
import { studioNodeToComposerRef } from '@/utils/studio/studioReferencePicker'

export interface CanvasVideoNodeLinks {
  imageCount: number
  videoCount: number
  audioCount?: number
}

export interface CanvasVideoCapabilityAvailability {
  allowed: boolean
  /** 仅在不可选时给出，供菜单悬停说明。 */
  disabledHint?: string
}

const IMAGE_TO_VIDEO_HINT = '需要连接图片节点（至少1个）'
const START_END_HINT = '需要连接图片节点（1-2个）'
const REFERENCE_HINT = '需要链接图片/视频节点（1-10个）'
export const CANVAS_VIDEO_REFERENCE_LIMIT_REASON = '仅支持一个参考视频'

type LinkEdge = {
  source: string
  target: string
  data?: { kind?: string | null; inputOrder?: number; inputRole?: StudioComposerRef['inputRole'] } | null
}

type CanvasVideoReferenceInput = {
  node: { id: string; data: Pick<StudioNodeData, 'composerRefs'> }
  nodes?: readonly StudioCanvasNode[]
  edges?: readonly LinkEdge[]
}

/**
 * 视频生成真正消费的引用：节点上的附件，加上引用连线指向的图片/视频节点。
 * 正文 mention 不算连接；同一节点只保留一份。
 */
export function canvasVideoLinkedRefs(input: CanvasVideoReferenceInput): StudioComposerRef[] {
  const own = (input.node.data.composerRefs ?? []).map(ref => ({ ...ref }))
  // Reclassify links saved before style covers became display-only.
  const byId = new Map((input.nodes ?? []).map((node) => [node.id, node]))
  for (const ref of own) {
    if (ref.nodeId && byId.get(ref.nodeId)?.data.kind === 'style_library') {
      ref.kind = 'library'
      ref.mediaKind = 'text'
    }
  }
  if (!input.edges?.length) return own
  const seen = new Set(own.flatMap((ref) => ref.channel === 'mention' || !ref.nodeId ? [] : [ref.nodeId]))
  const selectedBySource = new Map<string, StudioComposerRef>()
  for (const ref of own) if (ref.channel !== 'mention' && ref.nodeId && !selectedBySource.has(ref.nodeId)) selectedBySource.set(ref.nodeId, ref)
  const extra: StudioComposerRef[] = []
  const invalid = (source: string, message: string) => extra.push({ id: `invalid:${source}`, kind: 'node',
    nodeId: source, title: source, mediaKind: 'image', channel: 'attachment', inputError: message })
  // Old edges retain their relative order. Explicit relationship order survives persistence/reload.
  const incoming = input.edges.filter(edge => edge.target === input.node.id && edge.data?.kind === 'reference')
    .map((edge, index) => ({ edge, index }))
    .sort((a, b) => (Number.isInteger(a.edge.data?.inputOrder) ? a.edge.data!.inputOrder! : Number.MAX_SAFE_INTEGER)
      - (Number.isInteger(b.edge.data?.inputOrder) ? b.edge.data!.inputOrder! : Number.MAX_SAFE_INTEGER) || a.index - b.index)
  for (const { edge } of incoming) {
    if (edge.target !== input.node.id || edge.data?.kind !== 'reference') continue
    const source = byId.get(edge.source)
    const declaredRole = edge.data?.inputRole
    const role = declaredRole ?? (source?.data.kind === 'voice' ? 'audio' : undefined)
    if (role !== undefined && !['reference', 'first_frame', 'last_frame', 'text', 'audio'].includes(role)) {
      invalid(edge.source, '引用连线的素材角色无效，请检查连线')
      continue
    }
    if (source && ((role === 'first_frame' || role === 'last_frame') && source.data.kind !== 'image'
      || role === 'audio' && source.data.kind !== 'voice' || role === 'text' && source.data.kind !== 'text')) {
      invalid(edge.source, '连线的素材类型与引用角色不一致')
      continue
    }
    if (seen.has(edge.source)) {
      const existing = selectedBySource.get(edge.source)
      if (existing && role && (declaredRole || !existing.inputRole)) {
        if (existing.inputRole && existing.inputRole !== role) {
          existing.inputError = '同一素材的引用角色冲突，请检查连线'
          continue
        }
        existing.inputRole = role
      }
      continue
    }
    if (!source || (source.data.kind !== 'image' && source.data.kind !== 'video'
      && !(role === 'audio' && source.data.kind === 'voice')
      && !(role === 'text' && source.data.kind === 'text'))) {
      if (role !== undefined) invalid(edge.source, '引用来源不存在或尚不能作为当前视频的媒体输入')
      continue
    }
    seen.add(source.id)
    const ref: StudioComposerRef = { ...studioNodeToComposerRef(source), channel: 'attachment', ...(role ? { inputRole: role } : {}) }
    extra.push(ref)
    selectedBySource.set(source.id, ref)
  }
  return extra.length ? [...own, ...extra] : own
}

export function canvasVideoReferenceAddDisabledReason(input: CanvasVideoReferenceInput, sourceNodeId?: string): string | undefined {
  const videos = canvasVideoLinkedRefs(input).filter(ref => !ref.inputError && ref.mediaKind === 'video')
  if (sourceNodeId && videos.some(ref => ref.nodeId === sourceNodeId)) return undefined
  return videos.length ? CANVAS_VIDEO_REFERENCE_LIMIT_REASON : undefined
}

/** 可消费的节点与附件数量；尚未登记的个人录音也能决定目标生成模式。 */
export function canvasVideoNodeLinks(refs: readonly StudioComposerRef[]): CanvasVideoNodeLinks {
  const images = new Set<string>()
  const videos = new Set<string>()
  const audios = new Set<string>()
  for (const ref of refs) {
    if (ref.inputError || ref.channel === 'mention' || ref.kind === 'library') continue
    if (ref.mediaKind === 'audio' && ref.personalAudioAssetId) {
      audios.add(`personal:${ref.personalAudioAssetId}`)
      continue
    }
    if (ref.kind === 'asset') continue
    const key = ref.nodeId || (ref.previewUrl ? ref.sourceKey || ref.assetId || ref.id : undefined)
    if (!key) continue
    if (ref.mediaKind === 'image') images.add(key)
    else if (ref.mediaKind === 'video') videos.add(key)
    else if (ref.mediaKind === 'audio') audios.add(key)
  }
  return { imageCount: images.size, videoCount: videos.size, ...(audios.size ? { audioCount: audios.size } : {}) }
}

export function canvasVideoNodeLinkKey(
  nodeId: string,
  nodes: readonly StudioCanvasNode[],
  edges: readonly LinkEdge[]
): string {
  const node = nodes.find((item) => item.id === nodeId)
  if (!node) return '0:0:0'
  const links = canvasVideoNodeLinks(canvasVideoLinkedRefs({ node, nodes, edges }))
  return `${links.imageCount}:${links.videoCount}:${links.audioCount ?? 0}`
}

export function canvasVideoNodeLinksFromKey(key: string): CanvasVideoNodeLinks {
  const [imageCount, videoCount, audioCount] = key.split(':').map((part) => Number(part))
  return {
    imageCount: Number.isFinite(imageCount) ? imageCount : 0,
    videoCount: Number.isFinite(videoCount) ? videoCount : 0,
    ...(audioCount > 0 ? { audioCount } : {})
  }
}

type LinkChoice = {
  code: string
  label?: string | null
  maxReferenceImages?: number
  supportsReferenceAudio?: boolean
  referenceAudioRequiresVisualInput?: boolean
}

function linkRule(choice: LinkChoice): ((links: CanvasVideoNodeLinks) => boolean) | null {
  const text = `${choice.code} ${choice.label ?? ''}`
  if (/全能参考|参考生视频|reference_to_video|omni_reference|multimodal_reference/.test(text)) {
    return (links) => {
      const total = links.imageCount + links.videoCount
      if (total === 0 && links.audioCount) {
        return choice.supportsReferenceAudio === true && !choice.referenceAudioRequiresVisualInput
      }
      return total >= 1 && (choice.maxReferenceImages === undefined ? total <= 10 : links.imageCount <= choice.maxReferenceImages)
    }
  }
  if (/首尾帧|收尾帧|start_end_to_video|first_last|edge_to_video/.test(text)) {
    return (links) => links.imageCount >= 1 && links.imageCount <= 2
  }
  if (choice.code === 'image_to_video' || /图生视频|image_to_video/.test(text)) {
    return (links) => links.imageCount >= 1 && (choice.maxReferenceImages === undefined || links.imageCount <= choice.maxReferenceImages)
  }
  return null
}

function disabledHint(choice: LinkChoice, links: CanvasVideoNodeLinks): string | undefined {
  const text = `${choice.code} ${choice.label ?? ''}`
  if (/全能参考|参考生视频|reference_to_video|omni_reference|multimodal_reference/.test(text)) {
    if (links.audioCount && choice.referenceAudioRequiresVisualInput) {
      return '当前模型引用音频时需要同时添加图片或视频'
    }
    return choice.maxReferenceImages === undefined ? REFERENCE_HINT : `需要连接参考素材（最多 ${choice.maxReferenceImages} 张图片）`
  }
  if (/首尾帧|收尾帧|start_end_to_video|first_last|edge_to_video/.test(text)) return START_END_HINT
  if (choice.code === 'image_to_video' || /图生视频|image_to_video/.test(text)) {
    return choice.maxReferenceImages === 1 ? '需要连接 1 个首帧图片节点' : IMAGE_TO_VIDEO_HINT
  }
  return undefined
}

/** 文生视频始终可选。图生视频、首尾帧、全能参考按已连接节点数量判断。 */
export function canvasVideoCapabilityAvailability(
  choice: LinkChoice,
  links: CanvasVideoNodeLinks
): CanvasVideoCapabilityAvailability {
  const allowed = linkRule(choice)?.(links) ?? true
  return allowed ? { allowed: true } : { allowed: false, disabledHint: disabledHint(choice, links) }
}
