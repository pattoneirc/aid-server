import type { UserModelListItem } from '@/types/business-api'
import { resolveCapabilityRecord, resolveModelPromptCharacterLimit } from '@/utils/modelCapability'

export function resolveStudioComposerPromptCharacterLimit(
  model: UserModelListItem | null | undefined,
  prompt: string,
  capabilityCode = model?.capabilityCode
): number {
  const presentation = model?.availableCapabilities?.find(option => option.code === capabilityCode)?.presentation
  const selected = model && presentation ? { ...model, capability: { ...resolveCapabilityRecord(model), ...presentation } } : model
  return resolveModelPromptCharacterLimit(
    selected,
    prompt,
    Number.POSITIVE_INFINITY
  )
}

/** 已有内容超过新模型上限时仍允许用户继续删除，直至回到有效范围。 */
export function canApplyStudioComposerPromptChange(
  previousPrompt: string,
  nextPrompt: string,
  resolveLimit: (prompt: string) => number
): boolean {
  return nextPrompt.length <= resolveLimit(nextPrompt)
    || nextPrompt.length < previousPrompt.length
}
