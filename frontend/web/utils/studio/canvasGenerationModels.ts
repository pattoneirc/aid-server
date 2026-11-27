import type { UserModelListItem } from '@/types/business-api'
import type { StudioCanvasNode } from '@/types/studio'
import { resolveCapabilityRecord } from '@/utils/modelCapability'
import {
  canvasVideoCapabilityAvailability,
  canvasVideoNodeLinks,
  type CanvasVideoNodeLinks
} from '@/utils/studio/canvasVideoLinkedNodes'

export type CanvasVisualKind = 'image' | 'video'

const VIDEO_CAPABILITY_LABELS: Record<string, string> = {
  text_to_video: '文生视频',
  image_to_video: '图生视频',
  start_end_to_video: '首尾帧',
  reference_to_video: '全能参考',
  video_to_video: '视频生视频',
  multi_param: '多参数'
}

type AvailableCapability = NonNullable<UserModelListItem['availableCapabilities']>[number]

export interface CanvasVideoCapabilityChoice {
  code: string
  label: string
  maxReferenceImages?: number
  supportsReferenceAudio?: boolean
  referenceAudioRequiresVisualInput?: boolean
}

export function canvasGenerationCapability(kind: CanvasVisualKind, hasImageReference: boolean): string {
  if (kind === 'image') return hasImageReference ? 'image_to_image' : 'text_to_image'
  return hasImageReference ? 'image_to_video' : 'text_to_video'
}

/** 普通视频节点可选的生成方式。工具能力（编辑、延长、高清）不进这道选择。 */
export function canvasVideoCapabilityCode(code?: string | null, generateMode?: string | null, label?: string | null): string {
  const value = String(code || generateMode || '').trim()
  const text = String(label || '').trim()
  if (VIDEO_CAPABILITY_LABELS[value] && value !== 'multi_param') return value
  if (/全能参考|参考生视频/.test(text) || /reference_to_video|omni_reference|multimodal_reference/.test(value)) return value || 'reference_to_video'
  if (/多参数|多参/.test(text)) return value || 'multi_param'
  if (/首尾帧/.test(text)) return value || 'start_end_to_video'
  if (/图生/.test(text)) return value || 'image_to_video'
  if (/文生/.test(text)) return value || 'text_to_video'
  if (/视频生视频/.test(text)) return value || 'video_to_video'
  return ''
}

export function canvasVideoCapabilityLabel(code: string, label?: string | null): string {
  if (VIDEO_CAPABILITY_LABELS[code]) return VIDEO_CAPABILITY_LABELS[code]
  const provided = label?.trim()
  return provided || code
}

export function canvasVideoUsesFirstFrame(capability: string): boolean {
  return capability === 'image_to_video' || capability === 'start_end_to_video'
}

export function canvasVideoCapabilityChoices(model?: UserModelListItem | null): CanvasVideoCapabilityChoice[] {
  const seen = new Map<string, CanvasVideoCapabilityChoice>()
  const capability = resolveCapabilityRecord(model)
  const sceneRules = capability.sceneRules as Record<string, Record<string, unknown>> | undefined
  const add = (code?: string | null, generateMode?: string | null, label?: string | null, presentation?: AvailableCapability['presentation']) => {
    const resolved = canvasVideoCapabilityCode(code, generateMode, label)
    if (!resolved || seen.has(resolved)) return
    const maxImages = presentation?.maxReferenceImages
    const maxReferenceImages = typeof maxImages === 'number' && Number.isSafeInteger(maxImages) && maxImages > 0 ? maxImages : undefined
    const scene = (generateMode || resolved).replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
    const settings = { ...capability, ...sceneRules?.[scene], ...presentation }
    seen.set(resolved, {
      code: resolved,
      label: canvasVideoCapabilityLabel(resolved, label),
      maxReferenceImages,
      supportsReferenceAudio: settings.supportsReferenceAudio === true,
      referenceAudioRequiresVisualInput: settings.referenceAudioRequiresVisualInput === true
    })
  }
  for (const option of model?.availableCapabilities ?? []) add(option.code, option.generateMode, option.label, option.presentation)
  add(model?.capabilityCode, model?.generateMode)
  return [...seen.values()]
}

/**
 * 同一模型可能按能力拆成多行。普通视频节点要看到全部生成方式，不能只留下上游图片推断出的那一种。
 */
export function canvasOrdinaryVideoModels(models: UserModelListItem[]): UserModelListItem[] {
  const grouped = new Map<string, UserModelListItem>()
  const capabilities = new Map<string, Map<string, AvailableCapability>>()
  for (const model of models) {
    const bucket = capabilities.get(model.modelCode) ?? new Map<string, AvailableCapability>()
    for (const capability of model.availableCapabilities ?? []) {
      const code = canvasVideoCapabilityCode(capability.code, capability.generateMode, capability.label)
      if (code && !bucket.has(code)) bucket.set(code, { ...capability, code })
    }
    const own = canvasVideoCapabilityCode(model.capabilityCode, model.generateMode)
    if (own && !bucket.has(own)) {
      bucket.set(own, {
        code: own,
        generateMode: model.generateMode || own,
        parameterSchema: model.parameterSchema,
        parameterRules: model.parameterRules,
        billing: model.billing
      })
    }
    capabilities.set(model.modelCode, bucket)
    if (!grouped.has(model.modelCode)) grouped.set(model.modelCode, model)
  }
  return [...grouped.values()].flatMap((model) => {
    const available = [...(capabilities.get(model.modelCode)?.values() ?? [])]
    return available.length ? [{ ...model, availableCapabilities: available }] : []
  })
}

function isOmniChoice(choice: CanvasVideoCapabilityChoice): boolean {
  return choice.code === 'reference_to_video'
    || /全能参考|参考生视频|reference_to_video|omni_reference|multimodal_reference/.test(`${choice.code} ${choice.label}`)
}

function isMultiChoice(choice: CanvasVideoCapabilityChoice): boolean {
  return choice.code === 'multi_param' || /多参数|多参/.test(`${choice.code} ${choice.label}`)
}

/**
 * 用户明确选过、且当前模型和已连接节点都允许的方式优先。
 * 否则在允许的方式里默认全能参考；没有全能参考时默认多参数。
 * 空节点没有任何图片/视频连接时，只剩下文生视频。
 * 模型未声明的能力不会被选中。
 */
export function resolveCanvasVideoCapability(input: {
  node: Pick<StudioCanvasNode, 'data'>
  model?: UserModelListItem | null
  links?: CanvasVideoNodeLinks
}): string {
  const links = input.links ?? canvasVideoNodeLinks(input.node.data.composerRefs ?? [])
  const choices = canvasVideoCapabilityChoices(input.model)
  const allowed = (choice: CanvasVideoCapabilityChoice) => canvasVideoCapabilityAvailability(choice, links).allowed
  const explicitCode = input.node.data.generationOptions?.videoCapability?.trim()
  const explicit = explicitCode
    ? choices.find((choice) => choice.code === explicitCode) ?? { code: explicitCode, label: canvasVideoCapabilityLabel(explicitCode) }
    : undefined
  const referenceForAudio = links.audioCount
    ? choices.find(choice => choice.supportsReferenceAudio && isOmniChoice(choice) && allowed(choice))
    : undefined
  if (referenceForAudio && explicit?.code === 'text_to_video') return referenceForAudio.code
  if (explicit && allowed(explicit) && (!choices.length || choices.some((choice) => choice.code === explicit.code))) return explicit.code
  const available = choices.filter(allowed)
  const omni = available.find(isOmniChoice)
  if (omni) return omni.code
  const multi = available.find(isMultiChoice)
  if (multi) return multi.code
  const inferred = canvasGenerationCapability('video', links.imageCount > 0)
  const inferredChoice = available.find((choice) => choice.code === inferred)
    ?? (!choices.length && allowed({ code: inferred, label: canvasVideoCapabilityLabel(inferred) })
      ? { code: inferred, label: canvasVideoCapabilityLabel(inferred) }
      : undefined)
  if (inferredChoice) return inferredChoice.code
  const text = available.find((choice) => choice.code === 'text_to_video')
    ?? (!choices.length ? { code: 'text_to_video', label: canvasVideoCapabilityLabel('text_to_video') } : undefined)
  if (text && allowed(text)) return text.code
  return available[0]?.code ?? ''
}

export function compatibleCanvasGenerationModels(
  models: UserModelListItem[],
  kind: CanvasVisualKind,
  hasImageReference: boolean
): UserModelListItem[] {
  const capability = canvasGenerationCapability(kind, hasImageReference)
  return models.filter((model) =>
    (model.generateMode === capability || model.capabilityCode === capability)
    && !(kind === 'image' && hasImageReference && model.capability?.maxReferenceImages === 0)
  )
}
