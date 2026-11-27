import type { StoryboardImageReference } from '~/types/business-api'
import {
  userAssetRpsCreate, userAssetRpsFormCreate, userAssetRpsFormImageCreate, userAssetRpsFormImageList, userAssetRpsList
} from '~/utils/business/rps'
import { assistantSha256 } from '~/utils/assistant/assistantSha256'
import { setFormImageInUse } from '~/utils/formImageAutoUse'
import { normalizePromptAssetPlaceholderName, formatAssetApiPlaceholder } from '~/utils/storyboardPromptAssetRef'
import { resolveStoryboardImageAssetsFromPlain } from '~/utils/storyboardPromptGenerateFlow'
import { resolveCreatedFormImageId } from '~/utils/seriesAssetDesignFlow'

export interface StoryboardReferencePick {
  url?: string
  thumbnail?: string
  title?: string
  name?: string
  kind?: string
}

export interface StoryboardReferenceImage {
  id: string
  title: string
  promptReferenceName: string
  url: string
  thumbnail: string
}

type ProjectScope = { projectId: number; episodeId: number }

const REFERENCE_ASSET_NAME = '分镜参考图'
const projectImports = new Map<string, Promise<unknown>>()

export function storyboardReferenceImageKey(url?: string) {
  return String(url || '').trim().split(/[?#]/, 1)[0]
}

function referenceImage(id: string, title: string, promptReferenceName: string, url: string): StoryboardReferenceImage {
  return { id, title, promptReferenceName, url, thumbnail: url }
}

async function importImages(scope: ProjectScope, picks: StoryboardReferencePick[], isCurrent: () => boolean) {
  const candidates = new Map<string, { name: string; url: string }>()
  for (const pick of picks) {
    if (pick.kind && pick.kind !== 'image') continue
    const url = String(pick.url || pick.thumbnail || '').trim()
    if (!url || (!/^https?:\/\//i.test(url) && !/^\/[^/]/.test(url))) continue
    const key = storyboardReferenceImageKey(url)
    if (!candidates.has(key)) {
      candidates.set(key, { name: normalizePromptAssetPlaceholderName(pick.title || pick.name, '参考图'), url })
    }
  }
  const sources = [...candidates.values()]
  if (!sources.length || !isCurrent()) return { images: [], failures: [] }

  // Existing project images already have a canonical prompt name and an owned form-image record.
  const lookup = sources.map(({ name }, index) => formatAssetApiPlaceholder(index + 1, name)).join('\n')
  const { resolvedAssets } = await resolveStoryboardImageAssetsFromPlain(lookup, scope)
  const findResolved = (index: number) => resolvedAssets.find(item =>
    item.imageIndex === index + 1 && /^\d+$/.test(item.assetId) &&
    storyboardReferenceImageKey(item.url) === storyboardReferenceImageKey(sources[index].url))

  const images: StoryboardReferenceImage[] = []
  const failures: string[] = []
  let registration: Awaited<ReturnType<typeof loadReferenceAsset>> | undefined
  for (const [index, source] of sources.entries()) {
    if (!isCurrent()) break
    try {
      const existing = findResolved(index)
      if (existing) {
        images.push(referenceImage(existing.assetId, source.name, existing.name, source.url))
        continue
      }

      registration ??= await loadReferenceAsset(scope, isCurrent)
      if (!isCurrent()) break
      const digest = assistantSha256(new TextEncoder().encode(storyboardReferenceImageKey(source.url))).slice(0, 12)
      const name = source.name.slice(0, 84) + ' · 参考图 ' + digest
      const formId = await ensureReferenceForm(scope, registration, '分镜参考图 ' + digest)
      if (!isCurrent()) break
      const registeredImages = await userAssetRpsFormImageList({ formId, isUse: null })
      if (!isCurrent()) break
      const row = registeredImages.find(item =>
        storyboardReferenceImageKey(item.imageUrl ?? undefined) === storyboardReferenceImageKey(source.url))
      let imageId = row ? Number(row.id) : null
      if (!imageId) {
        const created = await userAssetRpsFormImageCreate({
          formId, imageUrl: source.url, name, sourceType: 'upload'
        })
        imageId = resolveCreatedFormImageId(created)
      }
      if (!imageId) throw new Error('登记图片后未返回素材编号')
      if (!isCurrent()) break
      if (!row?.isUse && !await setFormImageInUse(imageId, { projectId: scope.projectId })) {
        throw new Error('参考图尚未启用，请重新导入')
      }
      images.push(referenceImage(String(imageId), source.name, row?.name || name, source.url))
    } catch (cause: unknown) {
      const error = cause as { msg?: string; message?: string }
      failures.push(source.name + '：' + (error?.msg || error?.message || '导入失败'))
    }
  }
  return { images, failures }
}

async function loadReferenceAsset(scope: ProjectScope, isCurrent: () => boolean) {
  const query = { ...scope, assetType: 'prop' as const }
  const findReferenceAsset = async () => {
    const { rows } = await userAssetRpsList(query)
    return rows.find(row => row.assetName === REFERENCE_ASSET_NAME)
  }
  let asset = await findReferenceAsset()
  if (!isCurrent()) throw new Error('分镜已切换')
  if (!asset) {
    try {
      asset = await userAssetRpsCreate({ ...query, name: REFERENCE_ASSET_NAME })
    } catch (error) {
      if (!isCurrent()) throw error
      // Another window may have created the uniquely named project asset since the list was read.
      asset = await findReferenceAsset().catch(() => undefined)
      if (!asset) throw error
    }
  }
  if (!isCurrent()) throw new Error('分镜已切换')
  return { assetId: asset.id, forms: new Map((asset.forms ?? []).map(form => [form.name, form.id])) }
}

// A prop form has exactly one selected image. Give each reference its own form so a later
// import cannot deactivate an image already used by a storyboard prompt.
async function ensureReferenceForm(
  scope: ProjectScope,
  registration: Awaited<ReturnType<typeof loadReferenceAsset>>,
  name: string
) {
  const existing = registration.forms.get(name)
  if (existing) return existing
  const asset = await userAssetRpsFormCreate({
    ...scope, assetId: registration.assetId, name, imageUrl: '', sourceType: 'upload'
  })
  const formId = Number(asset.forms?.find(form => form.name === name)?.id)
  if (!Number.isFinite(formId) || formId <= 0) throw new Error('分镜参考图缺少项目素材形态')
  registration.forms.set(name, formId)
  return formId
}

/** 同一项目串行登记，重试复用同一已登记的图片。 */
export async function importStoryboardReferenceImages(
  scope: ProjectScope, picks: StoryboardReferencePick[], isCurrent: () => boolean
) {
  const key = String(scope.projectId)
  const prior = projectImports.get(key)
  const pending = Promise.resolve(prior).catch(() => undefined).then(() => importImages(scope, picks, isCurrent))
  projectImports.set(key, pending)
  try {
    return await pending
  } finally {
    if (projectImports.get(key) === pending) projectImports.delete(key)
  }
}

/** Register uploaded or library images before sending a saved prompt to the model. */
export async function registerStoryboardImageBindings(
  scope: ProjectScope,
  references: StoryboardImageReference[],
  isCurrent: () => boolean
): Promise<StoryboardImageReference[]> {
  const pending = references.filter(reference => !reference.imageId && reference.sourceUrl)
  if (!pending.length) return references

  const { images, failures } = await importStoryboardReferenceImages(scope,
    pending.map(reference => ({ url: reference.sourceUrl, title: reference.name })), isCurrent)
  if (!isCurrent()) return references
  if (failures.length) throw new Error(failures.join('；'))

  const byUrl = new Map(images.map(image => [storyboardReferenceImageKey(image.url), image.id]))
  return references.map(reference => {
    if (reference.imageId || !reference.sourceUrl) return reference
    const id = byUrl.get(storyboardReferenceImageKey(reference.sourceUrl))
    if (!id) throw new Error('参考图「' + reference.name + '」无法登记，请重新导入')
    return { index: reference.index, name: reference.name, imageId: id }
  })
}
