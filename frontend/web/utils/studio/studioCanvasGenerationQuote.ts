import { canvasModelPromptPolicy } from './canvasModelInputValidation'
import type { CanvasResource } from '@/types/canvas-api'
import type { UserModelListItem } from '@/types/business-api'
import type { UserGenerationKind } from '@/types/generation-api'
import type { StudioCanvasNode } from '@/types/studio'
import { modelForCapability } from '@/utils/modelCapability'
import { canvasResourceMatchesNodeMedia } from '@/utils/canvas/canvasCurrentResultResource'
import {
  assertCanvasReferenceTransport, buildCanvasGenerationReferences, buildCanvasGenerationRequest, buildCanvasTextNodeReferences,
  canvasGenerationReferenceRole, prepareCanvasVideoGenerationReferences, validateCanvasGenerationReferenceLimits,
  type CanvasGenerationMediaType, type CanvasGenerationReferenceCandidate
} from './canvasGeneration'
import { canvasGenerationCapability, resolveCanvasVideoCapability } from './canvasGenerationModels'
import { canvasVideoLinkedRefs, canvasVideoNodeLinks } from './canvasVideoLinkedNodes'
import { planStudioStoryboardCompositionSubmit } from './studioStoryboardCompositionSubmit'

export type StudioCanvasQuoteSnapshot = {
  projectId: string
  workspaceId: string
  nodes: readonly StudioCanvasNode[]
  edges?: readonly { source: string; target: string; data?: { kind?: string | null } | null }[]
  resource: (id: string) => CanvasResource | undefined
  version: (id: string) => number | undefined
}

export class CanvasQuoteReferenceNotReadyError extends Error {
  readonly requiresPreparation = true
}

function resourceId(value: unknown): string | undefined {
  const id = String(value ?? '')
  return /^\d+$/.test(id) && id !== '0' ? id : undefined
}

/** 只读当前工作区已有的资源回执；不登记资源、不保存节点、不获取编辑租约。 */
export function buildStudioCanvasGenerationQuote(input: {
  kind: UserGenerationKind
  node: StudioCanvasNode
  model: UserModelListItem
  prompt: string
  snapshot: StudioCanvasQuoteSnapshot
  sessionId?: string | null
}) {
  const { kind, node, model, snapshot } = input
  if (kind === 'audio') throw new Error('音频使用当前能力的音频报价入口')
  let inputPrompt = input.prompt
  if (kind === 'image' && node.data.storyboardCompositionId) {
    const planned = planStudioStoryboardCompositionSubmit({ node, userPrompt: inputPrompt })
    if ('error' in planned) throw new Error(planned.error)
    inputPrompt = planned.finalPrompt
  }
  const candidates: CanvasGenerationReferenceCandidate[] = []
  const textCandidates: Array<{ objectId: string; expectedVersion: number; title: string }> = []
  const fromNode = (source: StudioCanvasNode | undefined, wanted: CanvasGenerationMediaType) => {
    if (!source) return undefined
    const ids = [source.data.canvasPrimaryResourceId, ...(source.data.canvasResourceIds ?? [])]
    return ids.map(resourceId).filter((id): id is string => Boolean(id)).map(snapshot.resource)
      .find(resource => resource?.mediaType === wanted && (!source.data.mediaUrl || canvasResourceMatchesNodeMedia(resource, source.data)))
  }
  const requireResource = (resource: CanvasResource | undefined, title: string, wanted: string) => {
    if (!resource || resource.mediaType !== wanted || !resourceId(resource.resourceId)) {
      throw new CanvasQuoteReferenceNotReadyError(`引用「${title}」尚未准备好，请先补齐引用后报价`)
    }
    return resource
  }
  if (kind === 'image' && node.data.mediaUrl) {
    const resource = requireResource(fromNode(node, 'IMAGE'), '当前图片', 'IMAGE')
    candidates.push({ resourceId: String(resource.resourceId), title: '当前图片', mediaType: 'IMAGE' })
  }
  if (kind === 'text' && node.data.imageDescribe) {
    const source = snapshot.nodes.find(item => item.id === node.data.imageDescribe?.sourceNodeId)
    const resource = requireResource(fromNode(source, 'IMAGE'), '原图', 'IMAGE')
    candidates.push({ resourceId: String(resource.resourceId), title: '原图', mediaType: 'IMAGE' })
  }
  const linkedVideoRefs = kind === 'video' || kind === 'image'
    ? canvasVideoLinkedRefs({ node, nodes: snapshot.nodes, edges: snapshot.edges })
    : undefined
  const composerRefs = linkedVideoRefs ?? node.data.composerRefs ?? []
  for (const ref of node.data.imageDescribe ? [] : composerRefs) {
    if (ref.kind === 'library' && ref.mediaKind === 'text') continue
    if (ref.inputError) throw new CanvasQuoteReferenceNotReadyError(ref.inputError)
    const wanted = ref.mediaKind === 'text' ? 'DOCUMENT' : ref.mediaKind.toUpperCase()
    if (!(ref.mediaKind === 'text' && ref.nodeId)) assertCanvasReferenceTransport(kind, ref.mediaKind.toUpperCase(), ref.title)
    const source = snapshot.nodes.find(item => item.id === ref.nodeId)
    if (ref.nodeId && ref.mediaKind === 'text') {
      const version = snapshot.version(ref.nodeId)
      if (source?.data.kind !== 'text' || !version) throw new CanvasQuoteReferenceNotReadyError(`文本引用「${ref.title}」尚未保存或已失效，请先补齐引用`)
      textCandidates.push({ objectId: ref.nodeId, expectedVersion: version, title: ref.title })
      continue
    }
    // 素材库条目的 ID 不是工作区资源 ID；显式准备后才使用登记回执。
    const directId = ref.kind === 'asset' || ref.kind === 'library' ? undefined : resourceId(ref.assetId)
    const resource = requireResource(directId ? snapshot.resource(directId) : fromNode(source, wanted as CanvasGenerationMediaType), ref.title, wanted)
    candidates.push({ resourceId: String(resource.resourceId), title: ref.title,
      mediaType: resource.mediaType as CanvasGenerationMediaType, role: canvasGenerationReferenceRole(kind, node, ref, resource.mediaType) })
  }
  const prepared = buildCanvasGenerationReferences({ kind, prompt: inputPrompt, candidates })
  if (new Set(textCandidates.map(item => item.objectId)).size > 20) throw new CanvasQuoteReferenceNotReadyError('文本节点引用不能超过20个')
  const textNodes = textCandidates.length ? buildCanvasTextNodeReferences({ prompt: prepared.prompt, candidates: textCandidates,
    usedMentions: prepared.references.map(ref => ref.mention) }) : undefined
  const submittedIds = new Set(prepared.references.map(ref => ref.resourceId))
  const hasImageReference = candidates.some(item => item.mediaType === 'IMAGE' && submittedIds.has(item.resourceId))
  let capabilityCode: string | undefined
  if (kind === 'text') {
    capabilityCode = model.capabilityCode || undefined
    validateCanvasGenerationReferenceLimits(model, capabilityCode ?? '', prepared.references, candidates)
  } else if (kind === 'video') {
    const videoCapability = resolveCanvasVideoCapability({
      node,
      model,
      links: canvasVideoNodeLinks(linkedVideoRefs ?? [])
    })
    capabilityCode = videoCapability
    prepareCanvasVideoGenerationReferences(videoCapability, model, prepared.references, candidates)
  } else {
    capabilityCode = canvasGenerationCapability(kind, hasImageReference)
    validateCanvasGenerationReferenceLimits(model, capabilityCode, prepared.references, candidates)
  }
  const prompt = textNodes?.prompt ?? prepared.prompt
  return buildCanvasGenerationRequest({
    kind, node, model: kind === 'video' && capabilityCode ? modelForCapability(model, capabilityCode) : model,
    projectId: snapshot.projectId, workspaceId: snapshot.workspaceId,
    clientRequestId: 'canvas_quote_preview', capabilityCode,
    // 选型占位只进入只读报价，发送按钮仍沿用真实输入必填规则。
    prompt: prompt.trim() || canvasModelPromptPolicy(model, capabilityCode).optional ? prompt : kind === 'image' ? '图片报价' : kind === 'video' ? '生成' : prompt,
    references: prepared.references, nodeReferences: textNodes?.nodeReferences,
    session: kind === 'text' && input.sessionId ? { sessionId: input.sessionId } : undefined
  })
}
