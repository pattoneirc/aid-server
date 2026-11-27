import type { StudioCanvasNode, StudioComposerRef, StudioFlowEdge, StudioMode, StudioNodeData, StudioNodeKind } from '@/types/studio'
import { canvasVideoReferenceAddDisabledReason } from './canvasVideoLinkedNodes'
import { isStudioMaterialNodeKind, STUDIO_NODE_KIND_ORDER } from './studioNodeKind'

export function canConnectStudioNodes(sourceKind: StudioNodeKind, targetKind: StudioNodeKind): boolean {
  if (targetKind === 'smart_edit') return ['video', 'voice', 'image'].includes(sourceKind)
  return !isStudioMaterialNodeKind(sourceKind) || targetKind === 'image'
}

export function allowedKindsFromSource(sourceKind?: StudioNodeKind): StudioNodeKind[] {
  return allowedStudioConnectionKinds(sourceKind)
}

/** User-authored connections are distinct from a tool's persisted provenance edges. */
export function studioManualConnectionDisabledReason(sourceKind: StudioNodeKind, targetKind: StudioNodeKind, mode: StudioMode = 'free'): string | undefined {
  if (mode === 'free' && isStudioMaterialNodeKind(targetKind)) return '素材节点只向图片节点提供参考'
  if (mode === 'free' && targetKind === 'voice') return '音频节点不接收连线'
  if (mode === 'free' && sourceKind === 'voice' && targetKind !== 'video' && targetKind !== 'smart_edit') return '音频节点只能连接视频或剪辑成片节点'
  if (canConnectStudioNodes(sourceKind, targetKind)) return undefined
  return targetKind === 'smart_edit' ? '剪辑成片只接收图片、视频或音频节点' : '风格库与官方素材只能连接图片节点'
}

type StudioConnectionEndpoint = { id?: string; data: Pick<StudioNodeData, 'kind' | 'mediaKind' | 'composerRefs'> }
type StudioConnectionGraph = { studioMode: StudioMode; nodes: readonly StudioCanvasNode[]; edges: readonly StudioFlowEdge[] }

export function studioConnectedVideoDisabledReason(
  source: StudioConnectionEndpoint, target: StudioConnectionEndpoint, graph: StudioConnectionGraph
): string | undefined {
  if (graph.studioMode !== 'free' || target.data.kind !== 'video' || !target.id
    || (source.data.kind !== 'video' && source.data.mediaKind !== 'video')) return undefined
  return canvasVideoReferenceAddDisabledReason({
    node: { id: target.id, data: target.data }, nodes: graph.nodes, edges: graph.edges
  }, source.id)
}

export function studioManualNodeConnectionDisabledReason(
  source: StudioConnectionEndpoint, target: StudioConnectionEndpoint, graph: StudioConnectionGraph
): string | undefined {
  return studioManualConnectionDisabledReason(source.data.kind, target.data.kind, graph.studioMode)
    || studioConnectedVideoDisabledReason(source, target, graph)
}

export function allowedStudioConnectionKinds(anchorKind?: StudioNodeKind, role: 'source' | 'target' = 'source', mode: StudioMode = 'free'): StudioNodeKind[] {
  return STUDIO_NODE_KIND_ORDER.filter(kind => !anchorKind || !(role === 'source'
    ? studioManualConnectionDisabledReason(anchorKind, kind, mode)
    : studioManualConnectionDisabledReason(kind, anchorKind, mode)))
}

export function studioConnectionCandidateDisabledReason(anchor: { id: string; kind: StudioNodeKind; role: 'source' | 'target' } | null, candidate: { id: string; kind: StudioNodeKind }, mode: StudioMode): string | undefined {
  if (!anchor || anchor.id === candidate.id) return undefined
  return anchor.role === 'source'
    ? studioManualConnectionDisabledReason(anchor.kind, candidate.kind, mode)
    : studioManualConnectionDisabledReason(candidate.kind, anchor.kind, mode)
}

export function libraryAutoRef(source: {
  id: string
  data: {
    kind: StudioNodeKind
    title: string
    mediaUrl?: string
  }
}): StudioComposerRef {
  return {
    id: `library:${source.id}`,
    kind: 'library',
    nodeId: source.id,
    title: source.data.title,
    mediaKind: source.data.kind === 'style_library' ? 'text' : 'image',
    previewUrl: source.data.mediaUrl
  }
}
