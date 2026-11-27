import type { StoryboardImageReference } from '~/types/business-api'
import { formatAssetApiPlaceholder, type PromptAssetItem } from './storyboardPromptAssetCore'

const imageToken = /@图片(\d+)\[([^\]]+)\]/g

/** Read the selected image from the editor before flattening its label to text. */
export function storyboardImageBindingsFromHtml(html: string): StoryboardImageReference[] {
  const document = new DOMParser().parseFromString(html, 'text/html')
  const bindings: StoryboardImageReference[] = []
  const seen = new Set<string>()
  for (const node of document.querySelectorAll<HTMLElement>('.scp-prompt-asset-ref')) {
    const { assetType, assetId, imageIndex, name, url } = node.dataset
    if (assetType === 'audio' || assetType === 'video' || !name) continue
    const index = Number(imageIndex)
    if (!Number.isInteger(index) || index < 1) continue
    const identity = index + ':' + (assetId || url)
    if (seen.has(identity)) continue
    seen.add(identity)
    if (assetId && /^\d+$/.test(assetId)) {
      bindings.push({ index, name, imageId: assetId })
    } else if (url) {
      bindings.push({ index, name, sourceUrl: url })
    }
  }
  return bindings
}

/** Attach explicitly selected script assets to the corresponding prompt positions. */
export function placeStoryboardScriptImageBindings(prompt: string, references: StoryboardImageReference[]) {
  const positions = Array.from(prompt.matchAll(imageToken), (match) => ({
    index: Number(match[1]),
    name: match[2]
  }))
  let nextIndex = Math.max(0, ...positions.map((position) => position.index)) + 1
  const used = new Set<number>()
  const bindings = references.map((reference) => {
    const match = positions.find((position) => position.name === reference.name && !used.has(position.index))
    const index = match?.index ?? nextIndex++
    if (!match) prompt += '\n参考「' + reference.name + '」对应 ' + formatAssetApiPlaceholder(index, reference.name)
    used.add(index)
    return { ...reference, index }
  })
  return { prompt, bindings }
}

export function storyboardBindingsToPromptAssets(references: StoryboardImageReference[]): PromptAssetItem[] {
  return references.map((reference) => ({
    assetType: 'other',
    assetId: String(reference.imageId ?? 'upload-' + reference.index),
    name: reference.name,
    imageIndex: reference.index,
    url: reference.sourceUrl,
    label: '@' + reference.name
  }))
}
