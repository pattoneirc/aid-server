import { STUDIO_NODE_META } from '@/config/studioMeta'
import type {
  StudioCanvasNode,
  StudioComposerRef,
  StudioNodeData,
  StudioNodeKind
} from '@/types/studio'
import { isStudioFrameBreakdownVideoCandidate } from '@/utils/studio/studioFrameBreakdown'
import { isSmartEditSourceCandidate } from './studioSmartEdit'

export type StudioReferenceTargetKind = 'image' | 'video' | 'frame_breakdown' | 'smart_edit'

export interface StudioReferencePickerState {
  targetNodeId: string
  targetKind: StudioReferenceTargetKind
  previousNodeFilter: 'all' | 'rerun'
}

const IMAGE_BLOCKED_KINDS = new Set<StudioNodeKind>([
  'video',
  'director',
  'style_library',
  'official_asset'
])

/** 返回不可作为引用的原因；空值代表可以选择。 */
export function studioReferencePickDisabledReason(
  target: Pick<StudioCanvasNode, 'id' | 'data'>,
  candidate: Pick<StudioCanvasNode, 'id' | 'data'>
): string | null {
  if (target.id === candidate.id) return '当前节点不能引用自身'
  if (target.data.kind === 'smart_edit') return isSmartEditSourceCandidate(target.id, candidate)
    ? null : '剪辑成片只能引用已有内容的视频、图片或音频节点'

  if (target.data.kind === 'image') {
    if (IMAGE_BLOCKED_KINDS.has(candidate.data.kind)) {
      return `${STUDIO_NODE_META[candidate.data.kind].label}节点不能作为图片参考`
    }
    return null
  }

  if (target.data.kind === 'frame_breakdown') {
    return isStudioFrameBreakdownVideoCandidate(target.id, candidate)
      ? null
      : '逐帧拉片只能选择已有视频内容的视频节点'
  }

  if (target.data.kind === 'video') {
    if (candidate.data.kind === 'style_library') return '风格封面不能作为视频参考图'
    const candidateIsImage = candidate.data.kind === 'image' || candidate.data.mediaKind === 'image'
    const candidateIsAudio = candidate.data.kind === 'voice' || candidate.data.mediaKind === 'audio'
    const candidateIsVideo = candidate.data.kind === 'video' || candidate.data.mediaKind === 'video'
    const candidateIsAsset = candidate.data.kind === 'official_asset' && Boolean(candidate.data.mediaUrl)
    const acceptsSourceVideo = target.data.videoPurpose === 'reshoot'
      || target.data.videoPurpose === 'continuation'
    // 普通视频节点要能连视频，全能参考才有「链接图片/视频节点」可满足。
    if (candidate.data.kind === 'video' && !acceptsSourceVideo) return null
    if (acceptsSourceVideo && candidateIsVideo && candidate.data.mediaUrl) return null
    if (!candidateIsImage && !candidateIsAudio && !candidateIsAsset) {
      return '视频仅支持引用图片、音频、配音或有内容的资产节点'
    }
    return null
  }

  return '当前节点不支持从画布选择参考'
}

export function studioNodeToComposerRef(node: StudioCanvasNode): StudioComposerRef {
  const textContent = node.data.kind === 'text'
    ? (node.data.documentContent || node.data.resultSummary || node.data.prompt || '')
    : undefined
  return {
    id: `node:${node.id}`,
    kind: 'node',
    nodeId: node.id,
    title: node.data.title,
    mediaKind: node.data.mediaKind ?? (
      node.data.kind === 'video'
        ? 'video'
        : node.data.kind === 'voice'
          ? 'audio'
          : node.data.kind === 'text' || node.data.kind === 'storyboard_script'
            ? 'text'
            : 'image'
    ),
    previewUrl: node.data.mediaUrl,
    textContent,
    sourceKey: `node:${node.id}`
  }
}

/** 图片引用按先后顺序安全填入视频首帧和尾帧，其它媒体不影响帧参数。 */
export function withStudioVideoReference(
  value: NonNullable<StudioNodeData['generationOptions']>,
  ref: StudioComposerRef
): NonNullable<StudioNodeData['generationOptions']> {
  if (ref.channel === 'mention') return value
  if (ref.mediaKind !== 'image' || !ref.previewUrl) return value
  if (!value.startFrameUrl) return { ...value, startFrameUrl: ref.previewUrl }
  if (value.endFrameEnabled && !value.endFrameUrl) return { ...value, endFrameUrl: ref.previewUrl }
  return value
}
