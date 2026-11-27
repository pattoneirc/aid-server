import { digestSha256Hex } from '../sha256'
import type {
  CanvasModelBundle,
  CanvasResource,
  CanvasSceneDocument,
} from '@/types/canvas-api'
import type { DirectorSceneData, StudioWorkspaceData } from '@/types/studio'
import {
  canvasPublicationFileUrl,
  canvasResourceDisplayUrl,
  fetchCanvasPublicationFile,
} from './canvasPublicationFiles'
import { canvasPublicationModelUpload } from './canvasPublicationApi'
import { canvasResourceUpload } from '@/utils/business/canvas'
import { canvasModelUseByHash } from './canvasModelLibrary'
import { canvasOperationId } from './canvasId'
import { canvasApiBaseUrl } from './canvasApiClient'
import { canvasRetryLedger } from './canvasRetryLedger'
import { canvasQuoteIdentity } from './canvasQuote'
import { directorScenePackages } from '@/utils/studio/directorScenePackages'
import { decodeDirectorEnvironment, encodeDirectorEnvironment } from '@/utils/studio/directorEnvironment'
import {
  DIRECTOR_MANNEQUIN_ASSET_ID as PUBLICATION_MANNEQUIN_ID,
  DIRECTOR_MANNEQUIN_ASSET_PATH,
  DIRECTOR_MANNEQUIN_FILE_NAME,
} from '@/config/directorMannequin'
import { withAppBasePath } from '@/utils/appBasePath'
import { prepareSceneModeling, restoreSceneModeling, type CanvasSceneModeling } from './canvasSceneModeling'

export { PUBLICATION_MANNEQUIN_ID }
const modelRegistrations = new Map<string, Promise<CanvasResource>>()
const preparedResources = new Map<string, CanvasResource>()
const runtimeSceneFields = ['revision', 'spaceGenJob', 'mainCameraPresent', 'weather']
const observerPresetPrefix = 'observer-'
const sceneFields = new Set(
  'id name objects lights camera environmentColor environmentPreset gridVisible gridSnap groundVisible groundOpacity aspectRatio viewMode directorCamera cameraBookmarks modelAssets mainCameraVisible mainCameraLocked mainCameraLens mainCameraAimObjectId activeCameraId panoramaUrl panoramaHistory panoramaYaw panoramaRadius captures timeline prompt sourceNodeIds previewImageUrl actionLibrary scenePackage scenePackages viewportPrefs updatedAt'.split(
    ' ',
  ),
)
const clean = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(clean)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, clean(v)]),
        )
      : value

/** Convert only the named URL/resource fields; preserve all authored transforms, paths, poses and time values. */
export async function prepareCanvasSceneDocument(
  workspace: Pick<StudioWorkspaceData, 'directorScenes' | 'nodes'> & Partial<Pick<StudioWorkspaceData, 'scopeKey'>>,
  options: {
    workspaceId: string
    resources: CanvasResource[]
    current: () => boolean
    referencedSceneIds?: ReadonlySet<string>
    preparedScenes?: ReadonlyMap<string, Record<string, unknown>>
  },
): Promise<CanvasSceneDocument> {
  const byUrl = new Map(
    options.resources.flatMap(
      (r) =>
        [
          [canvasPublicationFileUrl(r.resourceUrl), r],
          [canvasResourceDisplayUrl(r), r],
          ...(r.sceneDataUrl ? [[r.sceneDataUrl, r]] : []),
        ] as Array<[string, CanvasResource]>,
    ),
  )
  const assertCurrent = () => {
    if (!options.current()) throw new Error('画布已切换，未保存场景')
  }
  const imageRequests = new Map<string, Promise<string | undefined>>()
  async function image(url: string | undefined): Promise<string | undefined> {
    if (!url) return undefined
    assertCurrent()
    const key = JSON.stringify([
      canvasQuoteIdentity(),
      canvasApiBaseUrl(),
      options.workspaceId,
      'IMAGE',
      url,
    ])
    const cached = preparedResources.get(key)
    if (cached) return cached.resourceId
    const inflight = imageRequests.get(url)
    if (inflight) return inflight
    const promise = (async () => {
      assertCurrent()
      const existing = byUrl.get(canvasPublicationFileUrl(url))
      if (existing) return existing.resourceId
      const blob = await fetchCanvasPublicationFile(url)
      assertCurrent()
      if (!blob.type.startsWith('image/'))
        throw new Error('场景图片不是有效图片素材')
      const extension = blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png'
      const result = (
        await canvasResourceUpload(options.workspaceId, [
          {
            file: new File([blob], `scene.${extension}`, { type: blob.type }),
            mediaType: 'IMAGE',
          },
        ])
      )[0]
      assertCurrent()
      if (!result) throw new Error('场景图片登记失败')
      byUrl.set(canvasPublicationFileUrl(url), result)
      options.resources.push({ ...result, ...(url.startsWith('data:') ? { sceneDataUrl: url } : {}) })
      preparedResources.set(key, result)
      return result.resourceId
    })()
    imageRequests.set(url, promise)
    return promise
  }
  async function model(
    url: string,
    fileName: string,
    type: 'MODEL' | 'SCENE_PACKAGE',
    existingId?: string,
    bundle?: CanvasModelBundle,
    sceneAsset = false,
  ) {
    assertCurrent()
    if (existingId && bundle) return existingId
    const known = byUrl.get(canvasPublicationFileUrl(url))
    if (known?.bundle) return known.resourceId
    assertCurrent()
    const key = JSON.stringify([
      canvasQuoteIdentity(),
      canvasApiBaseUrl(),
      options.workspaceId,
      type,
      url,
      fileName,
    ])
    const cached = preparedResources.get(key)
    if (cached) return cached.resourceId
    let promise = modelRegistrations.get(key)
    if (!promise) {
      promise = (async () => {
        const blob = await fetchCanvasPublicationFile(url)
        assertCurrent()
        const hash = await digestSha256Hex(await blob.arrayBuffer())
        assertCurrent()
        const fingerprint = JSON.stringify([type, fileName, hash])
        const operationId = canvasRetryLedger.getOrCreate(
          `scene-model:${options.workspaceId}:${hash}`,
          fingerprint,
          () => canvasOperationId('scene-model'),
        )
        if (!sceneAsset && type === 'MODEL' && fileName.toLowerCase().endsWith('.glb')) {
          return canvasModelUseByHash(options.workspaceId, hash, operationId)
        }
        return canvasPublicationModelUpload(
          options.workspaceId,
          operationId,
          type,
          fileName,
          [
            {
              path: fileName,
              file: new File([blob], fileName, { type: blob.type }),
            },
          ],
          sceneAsset,
        )
      })()
      modelRegistrations.set(key, promise)
      void promise
        .finally(() => {
          modelRegistrations.delete(key)
        })
        .catch(() => undefined)
    }
    const result = await promise
    assertCurrent()
    options.resources.push({ ...result, ...(sceneAsset ? { sceneDataUrl: url } : {}) })
    byUrl.set(canvasPublicationFileUrl(url), result)
    preparedResources.set(key, result)
    if (preparedResources.size > 1000)
      preparedResources.delete(preparedResources.keys().next().value!)
    return result.resourceId
  }
  const serializeScene = async (original: DirectorSceneData, historical = false): Promise<Record<string, unknown>> => {
    for (const key of Object.keys(original))
      if (key !== 'modeling' && !sceneFields.has(key) && !runtimeSceneFields.includes(key))
        throw new Error(`场景字段尚不支持发布：${key}`)
    const { modeling, ...base } = original
    const scene = structuredClone(base) as DirectorSceneData
    if (historical) {
      // Old authoring snapshots retain the geometry and baked movement. Workspace
      // sources or live camera sessions may have been removed since this revision.
      delete scene.sourceNodeIds
      for (const object of scene.objects) delete object.sourceNodeId
      for (const clip of scene.timeline?.pathClips ?? []) delete clip.takeId
    }
    const output: Record<string, unknown> = { ...scene }
    runtimeSceneFields.forEach((k) => delete output[k])
    if (scene.weather && scene.weather !== 'clear') {
      output.environmentPreset = encodeDirectorEnvironment(scene.environmentPreset ?? 'day', scene.weather)
    }
    if (scene.mainCameraPresent === false) {
      // The server keeps its required camera and accepts cameraPreset as a scalar.
      // Encode the observer-only preset here so legacy hidden main cameras retain their identity.
      output.mainCameraVisible = false
      output.viewportPrefs = {
        shading: 'solid',
        showNameplates: false,
        ...scene.viewportPrefs,
        cameraPreset: observerPresetPrefix + (scene.viewportPrefs?.cameraPreset ?? 'persp'),
      }
    }
    const assets: Record<string, unknown>[] = []
    for (const a of scene.modelAssets || []) {
      const resourceId = await model(
        a.url,
        a.fileName,
        'MODEL',
        a.resourceId,
        a.bundle,
      )
      const { url: _url, bundle: _bundle, ...rest } = a
      assets.push({ ...rest, resourceId })
    }
    if (scene.objects.some((o) => o.kind === 'actor' && !o.modelAssetId)) {
      const existing = scene.modelAssets?.find(
        (asset) => asset.id === PUBLICATION_MANNEQUIN_ID,
      )
      if (
        existing &&
        (existing.kind !== 'actor' ||
          existing.source !== 'builtin' ||
          existing.format !== 'glb' ||
          existing.fileName !== DIRECTOR_MANNEQUIN_FILE_NAME)
      ) {
        throw new Error('默认人体资源标识与现有模型冲突，请核对模型后保存')
      }
      // Restored and copied scenes already own this registered skeleton. New actors
      // share its source while retaining independent transforms and poses.
      if (!existing) {
        const fileName = DIRECTOR_MANNEQUIN_FILE_NAME
        const resourceId = await model(
          withAppBasePath(DIRECTOR_MANNEQUIN_ASSET_PATH),
          fileName,
          'MODEL',
        )
        assets.push({
          id: PUBLICATION_MANNEQUIN_ID,
          name: 'UE Mannequin',
          fileName,
          resourceId,
          format: 'glb',
          kind: 'actor',
          source: 'builtin',
          createdAt: scene.updatedAt,
        })
      }
    }
    output.modelAssets = assets
    const packageIds = new Map<string, string>()
    const packages = directorScenePackages(scene)
    const savedPackages = []
    for (const p of packages) {
      const resourceId = await model(
        p.url,
        'scene.' + p.format,
        'SCENE_PACKAGE',
        p.resourceId,
        p.bundle,
      )
      packageIds.set(p.mediaId, resourceId)
      const sourceImageResourceIds = []
      for (const mediaId of p.sourceImageMediaIds || []) {
        const node = workspace.nodes.find(
          (node) => node.data.mediaId === mediaId || node.id === mediaId,
        )
        const r = options.resources.find(
          (r) =>
            r.resourceId === mediaId ||
            r.sourceId === mediaId ||
            r.resourceId === node?.data.canvasPrimaryResourceId,
        )
        const resourceId = r?.resourceId || (await image(node?.data.mediaUrl))
        if (!resourceId)
          throw new Error('场景包来源图片尚未登记，请保留草稿并补齐素材')
        sourceImageResourceIds.push(resourceId)
      }
      savedPackages.push({
        resourceId,
        format: p.format,
        partCount: p.partCount,
        sourceImageResourceIds,
        createdAt: p.createdAt,
        ...(p.bounds ? { bounds: p.bounds } : {}),
      })
    }
    output.scenePackages = savedPackages
    delete output.scenePackage
    output.objects = await Promise.all(
      scene.objects.map(async (o) => {
        const { referenceImageUrl, scenery, ...rest } = o
        const result: Record<string, unknown> = {
          ...rest,
          ...(o.kind === 'actor' && !o.modelAssetId
            ? { modelAssetId: PUBLICATION_MANNEQUIN_ID }
            : {}),
        }
        if (referenceImageUrl)
          result.referenceImageResourceId = await image(referenceImageUrl)
        if (scenery) {
          const resourceId = packageIds.get(scenery.scenePackageMediaId)
          if (!resourceId) throw new Error('场景拆件缺少原始场景包')
          const { scenePackageMediaId: _id, ...meta } = scenery
          result.scenery = { ...meta, scenePackageResourceId: resourceId }
        }
        return result
      }),
    )
    for (const [urlKey, idKey] of [
      ['panoramaUrl', 'panoramaResourceId'],
      ['previewImageUrl', 'previewImageResourceId'],
    ] as const) {
      const value = await image(scene[urlKey])
      delete output[urlKey]
      if (value) output[idKey] = value
    }
    delete output.panoramaHistory
    output.panoramaHistoryResourceIds = await Promise.all(
      (scene.panoramaHistory || []).map((url) => image(url)),
    )
    output.cameraBookmarks = await Promise.all(
      (scene.cameraBookmarks || []).map(async (b) => {
        const { thumbnailUrl, ...rest } = b
        const resourceId = await image(thumbnailUrl)
        return {
          ...rest,
          ...(resourceId ? { thumbnailResourceId: resourceId } : {}),
        }
      }),
    )
    output.captures = await Promise.all(
      (scene.captures || []).map(async (c) => {
        const { mediaUrl, ...rest } = c
        return { ...rest, resourceId: await image(mediaUrl) }
      }),
    )
    if (scene.timeline) {
      const { keyframes, ...timeline } = scene.timeline
      if (keyframes?.length)
        throw new Error('旧版平铺关键帧尚未转换，请打开3D预演并保存后重试')
      output.timeline = {
        ...timeline,
        pathClips: timeline.pathClips?.map(
          ({ sessionId: _session, ...clip }) => clip,
        ),
      }
    }
    if (modeling) output.modeling = await prepareSceneModeling(modeling, scene, async (url, kind) => {
      if (kind === 'GLB') return model(url, 'model.glb', 'MODEL', undefined, undefined, true)
      const id = await image(url)
      if (!id) throw new Error('建模图片缺少原始素材')
      return id
    }, history => serializeScene(history, true))
    return clean(output) as Record<string, unknown>
  }
  const referenced = options.referencedSceneIds ?? new Set(workspace.nodes.flatMap(({ data }) =>
    !data.canvasTransient && data.directorSceneId ? [data.directorSceneId] : []))
  const scenes: Record<string, unknown>[] = []
  for (const id of referenced) {
    const original = Object.hasOwn(workspace.directorScenes, id) ? workspace.directorScenes[id] : undefined
    if (!original || original.id !== id) throw new Error('存在无法恢复的3D预演场景，暂不能提交场景文档')
    scenes.push(options.preparedScenes?.get(id) ?? await serializeScene(original))
  }
  assertCurrent()
  return { schemaVersion: scenes.some(scene => scene.modeling) ? 2 : 1, scenes }
}

type Scene = DirectorSceneData
type SceneObject = Scene['objects'][number]
type WireObject = Omit<SceneObject, 'referenceImageUrl' | 'scenery'> & {
  referenceImageResourceId?: string
  scenery?: Omit<NonNullable<SceneObject['scenery']>, 'scenePackageMediaId'> & {
    scenePackageResourceId: string
  }
}
type WireModel = Omit<
  NonNullable<Scene['modelAssets']>[number],
  'url' | 'bundle'
> & { resourceId: string }
type WirePackage = Omit<
  NonNullable<Scene['scenePackages']>[number],
  'url' | 'mediaId' | 'taskId' | 'sourceImageMediaIds' | 'bundle'
> & { resourceId: string; sourceImageResourceIds?: string[] }
type WireBookmark = Omit<
  NonNullable<Scene['cameraBookmarks']>[number],
  'thumbnailUrl'
> & { thumbnailResourceId?: string }
type WireCapture = Omit<NonNullable<Scene['captures']>[number], 'mediaUrl'> & {
  resourceId: string
}
type WireScene = Omit<
  Scene,
  | 'objects'
  | 'modelAssets'
  | 'scenePackage'
  | 'scenePackages'
  | 'cameraBookmarks'
  | 'captures'
  | 'panoramaUrl'
  | 'previewImageUrl'
  | 'panoramaHistory'
  | 'modeling'
  | 'environmentPreset'
  | 'weather'
> & {
  objects: WireObject[]
  modelAssets?: WireModel[]
  scenePackage?: WirePackage
  scenePackages?: WirePackage[]
  cameraBookmarks?: WireBookmark[]
  captures?: WireCapture[]
  panoramaResourceId?: string
  previewImageResourceId?: string
  panoramaHistoryResourceIds?: string[]
  modeling?: CanvasSceneModeling
  environmentPreset?: string
}

export function restoreCanvasScenes(
  document: CanvasSceneDocument | undefined,
  resources: CanvasResource[],
): Record<string, DirectorSceneData> {
  if (!document?.scenes) return {}
  const byId = new Map(
    resources.map((resource) => [resource.resourceId, resource]),
  )
  const resource = (id: string) => {
    const value = byId.get(String(id))
    if (!value) throw new Error(`场景资源缺失：${id}`)
    return value
  }
  const url = (id: string) => canvasResourceDisplayUrl(resource(id))
  const restoreScene = (raw: Record<string, unknown>): DirectorSceneData => {
      const {
        modelAssets = [],
        scenePackage,
        scenePackages = [],
        objects = [],
        cameraBookmarks = [],
        captures = [],
        panoramaResourceId,
        previewImageResourceId,
        panoramaHistoryResourceIds = [],
        modeling,
        ...authored
      } = structuredClone(raw) as unknown as WireScene
      const packages = scenePackages.length
        ? scenePackages
        : scenePackage
          ? [scenePackage]
          : []
      const environment = decodeDirectorEnvironment(authored.environmentPreset)
      const scene: DirectorSceneData = {
        ...authored,
        environmentPreset: authored.environmentPreset === undefined ? undefined : environment.preset,
        ...(environment.weather !== 'clear' ? { weather: environment.weather } : {}),
        modelAssets: modelAssets.map((asset) => {
          const root = byId.get(String(asset.resourceId))
          if (!root?.bundle) throw new Error('模型资源闭包缺失')
          return { ...asset, url: url(asset.resourceId), bundle: root.bundle }
        }),
        scenePackages: packages.map(
          ({ sourceImageResourceIds = [], ...pkg }) => {
            const root = resource(pkg.resourceId)
            if (!root.bundle) throw new Error('场景包资源闭包缺失')
            return {
              ...pkg,
              mediaId: pkg.resourceId,
              url: url(pkg.resourceId),
              bundle: root.bundle,
              sourceImageMediaIds: sourceImageResourceIds,
              taskId: '',
            }
          },
        ),
        objects: objects.map(
          ({ referenceImageResourceId, scenery, ...object }) => {
            const part =
              scenery &&
              (({ scenePackageResourceId, ...fields }) => ({
                ...fields,
                scenePackageMediaId: scenePackageResourceId,
              }))(scenery)
            return {
              ...object,
              ...(referenceImageResourceId
                ? { referenceImageUrl: url(referenceImageResourceId) }
                : {}),
              ...(part ? { scenery: part } : {}),
            }
          },
        ),
        cameraBookmarks: cameraBookmarks.map(
          ({ thumbnailResourceId, ...bookmark }) => ({
            ...bookmark,
            ...(thumbnailResourceId
              ? { thumbnailUrl: url(thumbnailResourceId) }
              : {}),
          }),
        ),
        captures: captures.map(({ resourceId, ...capture }) => ({
          ...capture,
          mediaUrl: url(resourceId),
        })),
        ...(panoramaResourceId ? { panoramaUrl: url(panoramaResourceId) } : {}),
        ...(previewImageResourceId
          ? { previewImageUrl: url(previewImageResourceId) }
          : {}),
        panoramaHistory: panoramaHistoryResourceIds.map(url),
      }
      const preset = scene.viewportPrefs?.cameraPreset
      if (preset?.startsWith(observerPresetPrefix) && scene.viewportPrefs) {
        const observerPreset = preset.slice(observerPresetPrefix.length)
        scene.mainCameraPresent = false
        delete scene.mainCameraVisible
        scene.viewportPrefs.cameraPreset = observerPreset === 'top' || observerPreset === 'front' ? observerPreset : 'persp'
      }
      if (modeling) scene.modeling = restoreSceneModeling(modeling, scene, (id) => {
        const data = resource(id).sceneDataUrl
        if (!data) throw new Error(`建模资源未载入：${id}`)
        return data
      }, restoreScene)
      return scene
  }
  return Object.fromEntries(document.scenes.map(raw => [String(raw.id), restoreScene(raw)]))
}
