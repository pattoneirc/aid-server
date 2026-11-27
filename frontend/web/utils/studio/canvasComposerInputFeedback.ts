interface InputFeedback {
  ruleError?: string | null
  referenceError?: string | null
  quoteError?: string | null
  disabledReason?: string | null
  idleReason?: string
  missingPrompt: boolean
  unmatched: boolean
  loading: boolean
}

const unsupportedInputs: Record<string, string> = {
  '模型不支持视频': '当前模式下，该模型不支持参考视频。请移除参考视频，或切换到支持视频输入的模型。',
  '模型不支持图片': '当前模式下，该模型不支持参考图片。请移除参考图片，或切换到支持图片输入的模型。',
  '模型不支持音频': '当前模式下，该模型不支持参考音频。请移除参考音频，或切换到支持音频输入的模型。'
}

/** 先说明具体输入错误，再说明缺少的输入。报价更新中不展示上一组参数的错误。 */
export function canvasComposerInputFeedback(input: InputFeedback) {
  if (input.ruleError) return input.ruleError
  if (input.loading) return ''
  const reason = input.referenceError || input.quoteError || input.disabledReason
    || (input.unmatched ? '当前参数没有可用计费规则' : '')
    || (input.missingPrompt ? '请输入生成内容。' : '') || input.idleReason || ''
  return unsupportedInputs[reason] ?? reason
}
