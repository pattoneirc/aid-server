import { resolveStudioComposerPromptCharacterLimit } from './studioPromptCharacterLimit'
import { assertCanvasReferenceTransport } from './canvasGeneration'
import { describe, expect, it } from 'vitest'
import type { UserModelListItem } from '@/types/business-api'
import type { UserGenerationReference } from '@/types/generation-api'
import { canvasModelPromptPolicy, validateCanvasGenerationReferenceLimits } from './canvasModelInputValidation'
import { canvasComposerInputFeedback } from './canvasComposerInputFeedback'
import { buildStudioCanvasGenerationQuote } from './studioCanvasGenerationQuote'
import type { StudioCanvasNode } from '@/types/studio'

const reference: UserGenerationReference = { resourceId: '23', role: 'REFERENCE', mention: 'asset_1' }
function model(capability: Record<string, unknown>, code = 'chat'): UserModelListItem {
  return { modelCode: 'any-provider-model', capabilityCode: code, capability } as UserModelListItem
}

describe('canvas input contracts', () => {
  it.each(['chat', 'image_to_image', 'reference_to_video'])('enforces the active contract for %s', code => {
    const refs = [{ resourceId: '23', mediaType: 'IMAGE' as const, title: '照片' }]
    expect(() => validateCanvasGenerationReferenceLimits(model({maxReferenceImages: 0}, code), code, [reference], refs)).toThrow('不支持参考图')
    for (const max of [1, -1, undefined]) {
      expect(() => validateCanvasGenerationReferenceLimits(model({maxReferenceImages: max}, code), code, [reference], refs)).not.toThrow()
    }
  })
  it('does not invent a limit when the model has none, and uses the selected language and capability limits', () => {
    expect(resolveStudioComposerPromptCharacterLimit(model({}), '任意内容')).toBe(Infinity)
    const m = model({maxPromptCharacters:90, maxPromptCharactersCjk:30})
    m.availableCapabilities = [{code:'short',presentation:{maxPromptCharactersCjk:8}}]
    expect(resolveStudioComposerPromptCharacterLimit(m, 'hello', 'short')).toBe(90)
    expect(resolveStudioComposerPromptCharacterLimit(m, '你好', 'short')).toBe(8)
    expect(resolveStudioComposerPromptCharacterLimit(m, '你好')).toBe(30)
  })
  it('explains a reference the host endpoint cannot submit', () => {
    expect(() => assertCanvasReferenceTransport('image', 'AUDIO', '声音1')).toThrow('声音1')
    expect(() => assertCanvasReferenceTransport('video', 'AUDIO', '声音1')).not.toThrow()
  })
  it('honors optional prompts and forbids text only for capabilities that declare it', () => {
    const m = model({promptOptional:true}, 'image_to_image')
    m.availableCapabilities = [{code:'text_to_image', presentation:{promptOptional:false}}]
    expect(canvasModelPromptPolicy(m, 'image_to_image').optional).toBe(true)
    expect(canvasModelPromptPolicy(m, 'text_to_image').optional).toBe(false)
    expect(canvasModelPromptPolicy({...m, supportsTextInput:false})).toEqual({optional:true, acceptsText:false})
  })
  it('uses different constraints for two modes of the same model', () => {
    const m = model({ maxReferenceVideos: 0 }, 'text_to_video')
    m.availableCapabilities = [{ code: 'reference_to_video', presentation: { maxReferenceVideos: 1 } }]
    const refs = [{resourceId: '23', mediaType: 'VIDEO' as const, title: '素材'}]
    expect(() => validateCanvasGenerationReferenceLimits(m, 'text_to_video', [reference], refs)).toThrow('不支持参考视频')
    expect(() => validateCanvasGenerationReferenceLimits(m, 'reference_to_video', [reference], refs)).not.toThrow()
  })
  it('honors an explicit minimum and actual referenced media type', () => {
    expect(() => validateCanvasGenerationReferenceLimits(model({minReferenceImages: 2}), 'chat', [], [])).toThrow('至少需要 2 张')
    expect(() => validateCanvasGenerationReferenceLimits(model({allowedInputs:['text','image']}), 'chat', [reference], [
      {resourceId:'23', mediaType:'AUDIO', title:'录音'}
    ])).toThrow('不支持参考音频')
  })
  it('validates text references at the normal quotation entry point', () => {
    const node = {id:'n', data:{kind:'text',model:'any-provider-model', composerRefs:[
      {id:'r',kind:'upload',assetId:'23',mediaKind:'image',title:'样图'}
    ]}} as StudioCanvasNode
    const quote = (limit: number) => buildStudioCanvasGenerationQuote({
      kind:'text', node, model:model({maxReferenceImages:limit}), prompt:'描述这张图',
      snapshot:{projectId:'1',workspaceId:'2',nodes:[node],resource:()=>({resourceId:'23',mediaType:'IMAGE',resourceUrl:'/test.png'}),version:()=>1}
    })
    expect(() => quote(0)).toThrow('不支持参考图')
    expect(quote(1).references?.map(ref => ref.resourceId)).toEqual(['23'])
  })
  it('shows concrete reasons, suppresses stale quote errors, and clears on valid input', () => {
    const ready = { missingPrompt:false, unmatched:false, loading:false }
    expect(canvasComposerInputFeedback({...ready, idleReason:'请先选择文本模型'})).toBe('请先选择文本模型')
    expect(canvasComposerInputFeedback({...ready, missingPrompt:true})).toBe('请输入生成内容。')
    expect(canvasComposerInputFeedback({...ready, quoteError:'时长超过模型上限 30 秒'})).toBe('时长超过模型上限 30 秒')
    expect(canvasComposerInputFeedback({...ready, quoteError:'旧报价错误',loading:true})).toBe('')
    expect(canvasComposerInputFeedback(ready)).toBe('')
  })
})
