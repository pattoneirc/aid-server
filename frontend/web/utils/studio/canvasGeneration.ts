import type { CanvasMediaType } from '@/types/canvas-api'
import type {
  UserGenerationKind,
  UserGenerationNodeReference,
  UserGenerationReference,
  UserGenerationReferenceRole,
  UserImageGenerationRequest,
  UserTextGenerationRequest,
  UserVideoGenerationRequest
} from '@/types/generation-api'
import type { StudioCanvasNode, StudioComposerRef } from '@/types/studio'
import type { UserModelListItem } from '@/types/business-api'
import { CanvasGenerationInputError, validateCanvasGenerationReferenceLimits } from './canvasModelInputValidation'
import { canvasVideoUsesFirstFrame } from './canvasGenerationModels'
import { CANVAS_VIDEO_REFERENCE_LIMIT_REASON } from './canvasVideoLinkedNodes'
import { studioCanvasImageParameters, studioCanvasImagePrompt, studioCanvasVideoParameters } from './studioCanvasGenerationParameters'

export { validateCanvasGenerationReferenceLimits } from './canvasModelInputValidation'

export type CanvasGenerationMediaType = CanvasMediaType | 'DOCUMENT'

export interface CanvasGenerationReferenceCandidate {
  resourceId: string
  title: string
  mediaType: CanvasGenerationMediaType
  role?: UserGenerationReferenceRole
}

export function canvasGenerationReferenceRole(kind: UserGenerationKind, node: StudioCanvasNode, ref: StudioComposerRef, mediaType: string) {
  if (ref.inputRole === 'first_frame' || ref.inputRole === 'last_frame') {
    if (kind !== 'video' || mediaType !== 'IMAGE') throw new Error('首尾帧引用必须是视频生成使用的图片素材')
    return ref.inputRole === 'first_frame' ? 'FIRST_FRAME' : 'LAST_FRAME'
  }
  if (ref.inputRole) return 'REFERENCE'
  const options = node.data.generationOptions ?? {}
  return kind === 'video' && mediaType === 'IMAGE'
    ? ref.previewUrl && ref.previewUrl === options.startFrameUrl ? 'FIRST_FRAME'
      : options.endFrameEnabled && ref.previewUrl && ref.previewUrl === options.endFrameUrl ? 'LAST_FRAME' : 'REFERENCE'
    : 'REFERENCE'
}

export function ensureCanvasGenerationFirstFrame(references: UserGenerationReference[], candidates: CanvasGenerationReferenceCandidate[]) {
  if (references.some(ref => ref.role === 'FIRST_FRAME')) return
  const first = references.find(ref => ref.role !== 'LAST_FRAME'
    && candidates.some(candidate => candidate.resourceId === ref.resourceId && candidate.mediaType === 'IMAGE'))
  if (first) first.role = 'FIRST_FRAME'
  else if (references.some(ref => ref.role === 'LAST_FRAME')) throw new CanvasGenerationInputError('已指定尾帧，还需要指定首帧图片')
}

export function prepareCanvasVideoGenerationReferences(
  capabilityCode: string,
  model: UserModelListItem | undefined,
  references: UserGenerationReference[],
  candidates: CanvasGenerationReferenceCandidate[]
) {
  const referenceIds = new Set(references.map(ref => ref.resourceId))
  const videoIds = new Set(candidates.filter(candidate => candidate.mediaType === 'VIDEO'
    && referenceIds.has(candidate.resourceId)).map(candidate => candidate.resourceId))
  if (videoIds.size > 1) throw new CanvasGenerationInputError(CANVAS_VIDEO_REFERENCE_LIMIT_REASON)
  if (!capabilityCode) throw new CanvasGenerationInputError('请添加所选模型需要的素材，或切换视频模型')
  if (canvasVideoUsesFirstFrame(capabilityCode)) ensureCanvasGenerationFirstFrame(references, candidates)
  validateCanvasGenerationReferenceLimits(model, capabilityCode, references, candidates)
}

export function buildCanvasTextNodeReferences(input: {
  prompt: string
  candidates: Array<{ objectId: string; expectedVersion: number; title: string }>
  usedMentions?: string[]
}): { prompt: string; nodeReferences: UserGenerationNodeReference[] } {
  const usedIds = new Set<string>()
  const usedMentions = new Set(input.usedMentions ?? [])
  const aliases = new Map<string, string>()
  const nodeReferences: UserGenerationNodeReference[] = []
  for (const candidate of input.candidates) {
    if (usedIds.has(candidate.objectId)) continue
    usedIds.add(candidate.objectId)
    const mention = uniqueMention(candidate.title, nodeReferences.length + 1, usedMentions)
    nodeReferences.push({ objectId: candidate.objectId, expectedVersion: candidate.expectedVersion, mention })
    if (!aliases.has(candidate.title)) aliases.set(candidate.title, mention)
    if (nodeReferences.length >= 20) break
  }
  let prompt = input.prompt
  for (const [title, mention] of [...aliases.entries()].sort(([a], [b]) => b.length - a.length)) {
    if (title && title !== mention) prompt = prompt.split(`@${title}`).join(`@${mention}`)
  }
  return { prompt, nodeReferences }
}

export function normalizeCanvasGenerationMention(value: string, fallbackIndex = 1): string {
  const normalized = value.normalize('NFKC')
    .replace(/[^\p{L}\p{N}_-]+/gu, '_')
    .replace(/^[_-]+|[_-]+$/g, '')
  return normalized.slice(0, 32) || `素材${fallbackIndex}`
}

function uniqueMention(value: string, index: number, used: Set<string>): string {
  const base = normalizeCanvasGenerationMention(value, index)
  let mention = base
  let suffix = 2
  while (used.has(mention)) {
    const tail = `_${suffix}`
    mention = `${base.slice(0, Math.max(1, 32 - tail.length))}${tail}`
    suffix += 1
  }
  used.add(mention)
  return mention
}

// The request protocol limits accepted media independently of the selected model.
export function assertCanvasReferenceTransport(kind: UserGenerationKind, mediaType: string, title: string) {
  if (kind === 'image' && mediaType !== 'IMAGE') {
    throw new CanvasGenerationInputError(`图片节点无法提交「${title}」作为参考图，请选择图片素材。`)
  }
  if (kind === 'video' && !['IMAGE', 'VIDEO', 'AUDIO'].includes(mediaType)) {
    throw new CanvasGenerationInputError(`视频节点无法提交参考素材「${title}」，请选择图片、视频或音频素材。`)
  }
}

/**
 * 将 Composer 的展示标题转换为服务端允许的显式别名，并按资源编号去重。
 * 工作区 NODE 最多持久化 20 个 resourceIds，因此提交也只消费同一组可恢复资源。
 */
export function buildCanvasGenerationReferences(input: {
  kind: UserGenerationKind
  prompt: string
  candidates: CanvasGenerationReferenceCandidate[]
}): { prompt: string; references: UserGenerationReference[] } {
  const usedIds = new Set<string>()
  const usedMentions = new Set<string>()
  const titleAliases = new Map<string, string>()
  const references: UserGenerationReference[] = []

  for (const candidate of input.candidates) {
    const resourceId = String(candidate.resourceId || '').trim()
    if (!/^\d+$/.test(resourceId) || resourceId === '0' || usedIds.has(resourceId)) continue
    assertCanvasReferenceTransport(input.kind, candidate.mediaType, candidate.title)
    if (references.length === 20) throw new CanvasGenerationInputError('本画布节点一次最多可保存 20 个不同的素材引用，请移除多余素材。')
    usedIds.add(resourceId)
    const mention = uniqueMention(candidate.title, references.length + 1, usedMentions)
    if (!titleAliases.has(candidate.title)) titleAliases.set(candidate.title, mention)
    const requestedRole = candidate.role ?? 'REFERENCE'
    const role = input.kind === 'video' && candidate.mediaType === 'IMAGE'
      ? requestedRole
      : 'REFERENCE'
    references.push({ resourceId, mention, role })
  }

  let prompt = input.prompt
  const aliases = [...titleAliases.entries()].sort(([left], [right]) => right.length - left.length)
  for (const [title, mention] of aliases) {
    if (!title || title === mention) continue
    prompt = prompt.split(`@${title}`).join(`@${mention}`)
  }
  return { prompt, references }
}

function compactParameters(entries: Array<[string, unknown]>): Record<string, unknown> | undefined {
  const value = Object.fromEntries(entries.filter(([, item]) => item !== undefined && item !== null && item !== ''))
  return Object.keys(value).length ? value : undefined
}

export function buildCanvasGenerationRequest(input: {
  kind: UserGenerationKind
  projectId: string
  workspaceId: string
  clientRequestId: string
  canvasNode?: UserTextGenerationRequest['canvasNode']
  prompt: string
  node: StudioCanvasNode
  model?: UserModelListItem | null
  references: UserGenerationReference[]
  nodeReferences?: UserGenerationNodeReference[]
  capabilityCode?: string
  session?: UserTextGenerationRequest['session']
}): UserTextGenerationRequest | UserImageGenerationRequest | UserVideoGenerationRequest {
  const common = {
    modelName: input.node.data.model || undefined,
    capabilityCode: input.capabilityCode,
    projectId: input.projectId,
    workspaceId: input.workspaceId,
    clientRequestId: input.clientRequestId,
    canvasNode: input.canvasNode
  }
  if (input.kind === 'text') {
    return {
      ...common,
      prompt: input.prompt,
      ...(input.node.data.imageDescribe ? { funcCode: 'canvas.text.image_describe' } : { session: input.session }),
      references: input.references.length ? input.references : undefined,
      nodeReferences: !input.node.data.imageDescribe && input.nodeReferences?.length ? input.nodeReferences : undefined,
      resultFormat: 'TEXT',
      reasoningEnabled: false,
      includeReasoning: false
    }
  }
  if (input.kind === 'image') {
    const settings = studioCanvasImageParameters(input.node, input.model)
    return {
      ...common,
      prompt: studioCanvasImagePrompt(input.node, input.prompt),
      nodeReferences: input.nodeReferences?.length ? input.nodeReferences : undefined,
      negativePrompt: input.node.data.negativePrompt || undefined,
      size: settings.size,
      expectedImageCount: settings.expectedImageCount,
      references: input.references.length ? input.references : undefined,
      parameters: compactParameters([
        ['aspectRatio', settings.aspectRatio],
        ['styleId', settings.styleId]
      ])
    }
  }
  if (input.kind === 'audio') return { ...common, prompt: input.prompt }
  const settings = studioCanvasVideoParameters(input.node, input.prompt, input.model)
  return {
    ...common,
    ...settings,
    nodeReferences: input.nodeReferences?.length ? input.nodeReferences : undefined,
    references: input.references.length ? input.references : undefined,
  }
}

export function canvasGenerationTaskMessage(task: {
  userMessage?: string | null
  errorMessage?: string | null
}, fallback = '生成失败'): string {
  return String(task.userMessage || task.errorMessage || fallback).trim() || fallback
}
