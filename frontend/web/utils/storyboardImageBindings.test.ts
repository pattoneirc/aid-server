// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { buildAspectRatioSelectOptions, coerceGenerationSettings, parseModelCapability } from './modelCapability'
import { placeStoryboardScriptImageBindings, storyboardImageBindingsFromHtml } from './storyboardImageBindings'

describe('分镜图明确引用', () => {
  it('从编辑器保留两个同名图的独立身份和顺序', () => {
    const ref = (index: number, id: string) => `<span class="scp-prompt-asset-ref" data-image-index="${index}"
      data-name="小狗" data-asset-type="other" data-asset-id="${id}">@小狗</span>`
    expect(storyboardImageBindingsFromHtml(ref(1, '90071992547409930') + ref(2, '90071992547409931') + ref(1, '90071992547409930'))).toEqual([
      { index: 1, name: '小狗', imageId: '90071992547409930' },
      { index: 2, name: '小狗', imageId: '90071992547409931' }
    ])
  })

  it('给提示词中遗漏的脚本图片补引用', () => {
    const result = placeStoryboardScriptImageBindings('@图片1[爷爷] 带着小狗', [
      { index: 1, name: '小狗', imageId: '90071992547409931' }
    ])
    expect(result.prompt).toContain('@图片2[小狗]')
    expect(result.bindings).toEqual([{ index: 2, name: '小狗', imageId: '90071992547409931' }])
  })
})

describe('固定像素图规格', () => {
  const snapshot = parseModelCapability({
    supportsAspectRatio: false,
    capability: { sizeOptions: ['1024x1024', '1536x1024', '1024x1536'] }
  } as Parameters<typeof parseModelCapability>[0])
  it.each([['1024x1024', '1:1'], ['1536x1024', '3:2'], ['1024x1536', '2:3']])(
    '%s 根据选中的尺寸得出 %s', (quality, aspectRatio) => {
      expect(coerceGenerationSettings({ quality, aspectRatio: '16:9', count: 1 }, snapshot))
        .toMatchObject({ quality, aspectRatio })
      expect(buildAspectRatioSelectOptions(snapshot, quality).map(option => option.value)).toEqual([aspectRatio])
    }
  )
})
