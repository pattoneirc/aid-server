import type { UserModelListItem } from '@/types/business-api'
import type { UserGenerationReference } from '@/types/generation-api'
import { resolveCapabilityRecord } from '@/utils/modelCapability'
import { canvasVideoCapabilityLabel } from './canvasGenerationModels'
import type { CanvasGenerationReferenceCandidate } from './canvasGeneration'

export class CanvasGenerationInputError extends Error {}

type Capability = Record<string, unknown>
interface ReferenceContext {
  mode: string
  sources: Capability[]
  inputs: { media: string; role: UserGenerationReference['role'] }[]
}

type ReferenceRule = (context: ReferenceContext) => string | undefined

const modeLabels: Record<string, string> = {
  image_to_video: '首帧', last_frame_to_video: '尾帧', image_to_image: '图生图', text_to_image: '文生图'
}

function limits(sources: Capability[], field: string): number[] {
  return sources.map(source => source[field]).filter((n): n is number =>
    typeof n === 'number' && Number.isInteger(n) && n >= 0)
}

const referenceCounts: ReferenceRule = ({ inputs, sources, mode }) => {
  const counts = { IMAGE: 0, VIDEO: 0, AUDIO: 0 }
  for (const { media } of inputs) {
    if (media === 'IMAGE' || media === 'VIDEO' || media === 'AUDIO') counts[media]++
  }
  const maximums = [
    ['maxReferenceImages', counts.IMAGE, '参考图', '张'],
    ['maxReferenceVideos', counts.VIDEO, '参考视频', '个'],
    ['maxReferenceAudios', counts.AUDIO, '参考音频', '个'],
    ['maxReferenceMaterials', counts.IMAGE + counts.VIDEO + counts.AUDIO, '参考素材', '个']
  ] as const
  for (const [field, count, label, unit] of maximums) {
    const max = Math.min(...limits(sources, field))
    if (count > max) return max === 0
      ? `${mode}下，该模型不支持${label}，请移除该素材或切换模式、模型`
      : `${mode}下，该模型最多支持 ${max} ${unit}${label}，已选 ${count} ${unit}，请移除多余素材或切换模式、模型`
  }
  const minimum = Math.max(...limits(sources, 'minReferenceImages'))
  if (counts.IMAGE < minimum) return `${mode}至少需要 ${minimum} 张参考图，已选 ${counts.IMAGE} 张，请添加参考图或切换模式。`
}

const mediaLabels: Record<string, string> = {
  image: '参考图', video: '参考视频', audio: '参考音频', firstframe: '首帧图片', lastframe: '尾帧图片'
}

function inputName(input: string) {
  const name = input.trim().toLowerCase().replace(/[_-]/g, '')
  if (/^start(frame|image)$/.test(name)) return 'firstframe'
  if (/^end(frame|image)$/.test(name)) return 'lastframe'
  return name.replace(/^(?:reference)?(image|video|audio)s?$/, '$1')
}

const referenceTypes: ReferenceRule = ({ inputs, sources, mode }) => {
  for (const { media, role } of inputs) {
    const frame = role === 'FIRST_FRAME' || role === 'LAST_FRAME'
    const name = inputName(frame ? role : media)
    if (!mediaLabels[name]) continue
    for (const source of sources) {
      const allowed = Array.isArray(source.allowedInputs) ? source.allowedInputs.filter((v): v is string => typeof v === 'string').map(inputName) : []
      if ((name === 'video' && source.supportsVideoInput === false)
        || (name === 'audio' && source.supportsReferenceAudio === false)
        || (allowed.length > 0 && !allowed.includes(name) && !(frame && allowed.includes('image')))) {
        return `${mode}不支持${mediaLabels[name]}，请移除该素材或切换模式、模型`
      }
    }
  }
}

const referenceRules: ReferenceRule[] = [referenceCounts, referenceTypes]

/** 报价和正式提交使用同一组规则。根目录限制只属于其默认能力。 */
export function validateCanvasGenerationReferenceLimits(
  model: UserModelListItem | undefined, code: string,
  references: UserGenerationReference[], candidates: CanvasGenerationReferenceCandidate[]
) {
  if (!model) return
  const capability = resolveCapabilityRecord(model)
  const option = model.availableCapabilities?.find(item => item.code === code)
  const modeCode = option?.generateMode || code
  const scene = modeCode.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
  const sceneRule = (capability.sceneRules as Record<string, Capability> | undefined)?.[scene]
  const defaultCode = model.capabilityCode || model.generateMode
  const sources = [!defaultCode || defaultCode === code ? capability : undefined, sceneRule, option?.presentation]
    .filter((source): source is Capability => source != null)
  const label = modeLabels[modeCode] ?? canvasVideoCapabilityLabel(modeCode, option?.label)
  const mode = !label || label === modeCode ? '当前模式' : label.endsWith('模式') ? label : `${label}模式`
  const media = new Map(candidates.map(item => [item.resourceId, item.mediaType]))
  const inputs = references.map(ref => ({ media: media.get(ref.resourceId) ?? '', role: ref.role }))
  for (const rule of referenceRules) {
    const message = rule({ mode, sources, inputs })
    if (message) throw new CanvasGenerationInputError(message)
  }
}

/** 普通生成模型允许无提示词时，报价与提交均保留真实的空输入。 */
export function canvasModelPromptPolicy(model: UserModelListItem | null | undefined, code?: string | null) {
  const presentation = model?.availableCapabilities?.find(option => option.code === code)?.presentation
  const acceptsText = (presentation?.supportsTextInput ?? model?.supportsTextInput) !== false
  const optional = !acceptsText || (presentation?.promptOptional ?? resolveCapabilityRecord(model).promptOptional) === true
  return { acceptsText, optional }
}
