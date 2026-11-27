import type { DirectorSceneData } from '@/types/studio'
import { DIRECTOR_MANNEQUIN_ASSET_ID } from '@/config/directorMannequin'
import { assistantDigest } from '@/utils/assistant/assistantRequestCoordinator'
import { digestSha256Hex } from '@/utils/sha256'
import { normalizeDirectorScene } from './directorScene'
import type { ThreePrevizLocalRecord } from './threePrevizStorage'
import { validateThreePrevizModeling } from './threePrevizDocument'

function resourceLocation(value?: string) {
  if (!value || !/^https?:/i.test(value)) return value
  try {
    const url = new URL(value)
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:x-oss-|x-amz-)/i.test(key) || /^(?:OSSAccessKeyId|Signature|Expires|SecurityToken)$/i.test(key)) url.searchParams.delete(key)
    }
    url.searchParams.sort()
    return url.href
  } catch { return value }
}

/** Compare authored values, independent of the published resource envelope and editor position. */
export async function threePrevizCanvasBase(scene: DirectorSceneData): Promise<string> {
  const {
    modeling, updatedAt, revision, spaceGenJob, viewportPrefs, directorCamera, viewMode, activeCameraId,
    previewImageUrl, cameraBookmarks, captures, objects, modelAssets, timeline, scenePackage, scenePackages,
    panoramaUrl, panoramaHistory, ...authored
  } = normalizeDirectorScene(scene)
  const packages = scenePackages?.length ? scenePackages : scenePackage ? [scenePackage] : []
  const byMediaId = new Map(packages.map(item => [item.mediaId, resourceLocation(item.url)]))
  const content = assistantDigest({
    ...authored,
    objects: objects.map(({ modelAssetId, referenceImageUrl, scenery, ...object }) => ({
      ...object,
      modelAssetId: modelAssetId === DIRECTOR_MANNEQUIN_ASSET_ID ? undefined : modelAssetId,
      referenceImageUrl: resourceLocation(referenceImageUrl),
      scenery: scenery ? { ...scenery, scenePackageMediaId: byMediaId.get(scenery.scenePackageMediaId) ?? scenery.scenePackageMediaId } : undefined
    })),
    modelAssets: modelAssets?.filter(asset => asset.id !== DIRECTOR_MANNEQUIN_ASSET_ID)
      .map(({ bundle, resourceId, url, ...asset }) => ({ ...asset, url: asset.source === 'builtin' ? undefined : resourceLocation(url) })),
    cameraBookmarks: cameraBookmarks?.map(({ thumbnailUrl, ...bookmark }) => bookmark),
    captures: captures?.map(capture => ({ ...capture, mediaUrl: resourceLocation(capture.mediaUrl) })),
    timeline: timeline ? { ...timeline, currentTime: undefined } : undefined,
    scenePackages: packages.map(({ url, format, partCount, bounds }) => ({ url: resourceLocation(url), format, partCount, bounds })),
    panoramaUrl: resourceLocation(panoramaUrl),
    panoramaHistory: panoramaHistory?.map(resourceLocation)
  })
  if (!globalThis.crypto?.subtle) return 'canonical:' + content
  return digestSha256Hex(new TextEncoder().encode(content))
}

interface ThreePrevizRecoveryDecision {
  canvasBase?: string
  recovered?: DirectorSceneData
  conflict: boolean
  canvasWithModeling?: DirectorSceneData
}

export async function resolveThreePrevizRecovery(record?: ThreePrevizLocalRecord, canvas?: DirectorSceneData): Promise<ThreePrevizRecoveryDecision> {
  const canvasBase = canvas && await threePrevizCanvasBase(canvas)
  if (canvas?.modeling) {
    validateThreePrevizModeling(canvas)
    if (!record || record.scene.updatedAt <= canvas.updatedAt) {
      return { canvasBase, recovered: canvas, conflict: false }
    }
    validateThreePrevizModeling(record.scene)
    const localBase = await threePrevizCanvasBase(record.scene)
    if (localBase === canvasBase && assistantDigest(record.scene.modeling) === assistantDigest(canvas.modeling)) {
      return { canvasBase, recovered: canvas, conflict: false }
    }
    return { canvasBase, conflict: true, canvasWithModeling: canvas }
  }
  if (record) validateThreePrevizModeling(record.scene)
  if (!record || !canvas) return { canvasBase, recovered: record?.scene, conflict: false }
  const local = await threePrevizCanvasBase(record.scene)
  if (local === canvasBase || record.canvasBase === canvasBase) {
    return { canvasBase, recovered: record.scene, conflict: false }
  }
  const merged = { ...canvas, modeling: record.scene.modeling }
  let canvasWithModeling: DirectorSceneData | undefined
  try {
    validateThreePrevizModeling(merged)
    canvasWithModeling = merged
  } catch {
    // The canvas version may have removed objects referenced by the local modeling graph.
  }
  if (record.canvasBase === local && canvasWithModeling) {
    return { canvasBase, recovered: canvasWithModeling, conflict: false }
  }
  return { canvasBase, conflict: true, canvasWithModeling }
}
