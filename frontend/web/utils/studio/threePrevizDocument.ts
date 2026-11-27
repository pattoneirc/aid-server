import type { DirectorCamera, DirectorSceneData } from '@/types/studio'
import type { PrevizNode, PrevizProject, PrevizScene } from '@/types/previz'
import type { ThreePrevizDirectorLayer, ThreePrevizProjectPackage } from '@/types/threePreviz'
import { createNode, createProject, validateScene, resizeDuration, applyCommands } from '@/utils/previz/core'
import { getDirectorMotionEnd, normalizeDirectorTimeline } from './directorTimeline'
import { removeDirectorObjects } from './directorScene'
import { editorSceneDigest } from '@/utils/previz/editorSnapshot'
import { digestSha256Hex } from '@/utils/sha256'
import { PREVIZ_DIRECTOR_VIEW_ID } from '@/utils/previz/nativeCameras'
import { listDirectorAuthoredCameras, resolveDirectorActiveCameraId } from '@/components/studio/director/directorCameraState'

export const THREE_PREVIZ_FORMAT = 'AID-3D-PREVIZ'
export const THREE_PREVIZ_MAX_BYTES = 128 * 1024 * 1024
const radians = (degrees: number) => degrees * Math.PI / 180
const degrees = (radians: number) => radians * 180 / Math.PI

export function createThreePrevizModeling(scene: DirectorSceneData): PrevizProject {
  const project = createProject(scene.name || '3D预演')
  project.id = `canvas-${scene.id}`
  project.scene.nodes = []
  // A generated shot must not turn a legacy physical camera into an authored dependency.
  project.scene.shots[0].cameraId = PREVIZ_DIRECTOR_VIEW_ID
  const frames = Math.max(30, Math.round(normalizeDirectorTimeline(scene.timeline).duration * 30))
  project.scene.timeline.frameCount = frames
  project.scene.shots.at(-1)!.endFrameExclusive = frames
  project.scene.environment = { presetCode: scene.environmentPreset ?? 'studio', background: scene.environmentColor, exposure: 1 }
  if (scene.aspectRatio && scene.aspectRatio !== 'adaptive') project.scene.aspectRatio = scene.aspectRatio
  return project
}

/** Build an editable view of the union. Common values have one authoring owner. */
export function projectThreePreviz(scene: DirectorSceneData, project = scene.modeling?.project ?? createThreePrevizModeling(scene)): PrevizProject {
  const bindings: ThreePrevizDirectorLayer['bindings'] = {}
  const ids = new Set(project.scene.nodes.map(node => node.id))
  const id = (kind: 'object' | 'camera' | 'light', sourceId: string) => {
    let value = Object.entries(scene.modeling?.directorBindings ?? {}).find(([, binding]) => binding.kind === kind && binding.id === sourceId)?.[0] ?? `director-${kind}-${sourceId}`
    while (ids.has(value)) value = `d-${value}`
    ids.add(value)
    bindings[value] = { kind, id: sourceId }
    return value
  }
  const nodes: PrevizNode[] = []
  for (const object of scene.objects) {
    const node = createNode(object.kind === 'actor' ? 'ACTOR' : object.shape === 'sphere' ? 'SPHERE' : object.shape === 'cone' || object.shape === 'pyramid' ? 'CONE' : 'BOX', object.name)
    Object.assign(node, { id: id('object', object.id), color: object.color, visible: object.visible !== false, locked: !!object.locked, localTransform: structuredClone(object.transform) })
    nodes.push(node)
  }
  for (const camera of listDirectorAuthoredCameras(scene)) {
    const node = createNode('CAMERA', camera.name)
    node.id = id('camera', camera.id)
    node.localTransform.position = [...camera.camera.position]
    node.camera = { ...node.camera!, target: [...camera.camera.target], fov: camera.camera.fov, roll: radians(camera.camera.roll ?? 0) }
    node.visible = camera.visible !== false
    node.locked = !!camera.locked
    nodes.push(node)
  }
  for (const light of scene.lights) {
    // Ambient light is rendered by the director layer, not represented as a directional light.
    if (light.kind === 'ambient') continue
    const node = createNode('LIGHT', light.name)
    node.id = id('light', light.id)
    node.localTransform.position = [...light.position]
    node.color = light.color
    node.light = { kind: light.kind, intensity: light.intensity }
    node.visible = light.enabled
    nodes.push(node)
  }
  const { modeling: _modeling, ...director } = scene
  for (const node of nodes) node.directorBinding = bindings[node.id]
  const frameCount = Math.max(project.scene.timeline.frameCount, Math.round(normalizeDirectorTimeline(scene.timeline).duration * 30))
  const graph = { ...project.scene, nodes: [...project.scene.nodes, ...nodes], directorLayer: { scene: director, bindings } }
  const resized = frameCount === graph.timeline.frameCount ? graph : applyCommands(graph, [resizeDuration(graph, frameCount)])
  return { ...project, title: scene.name, scene: { ...resized, aspectRatio: scene.aspectRatio && scene.aspectRatio !== 'adaptive' ? scene.aspectRatio : resized.aspectRatio, environment: { ...resized.environment, presetCode: scene.environmentPreset ?? resized.environment.presetCode, background: scene.environmentColor } } }
}

function cameraFromNode(node: PrevizNode, previous: DirectorCamera): DirectorCamera {
  return { ...previous, position: [...node.localTransform.position], target: [...node.camera!.target], fov: node.camera!.fov, roll: degrees(node.camera!.roll ?? 0) }
}

/** Inverse projection: update each entity's owner, never keep duplicate authored transforms. */
export function applyThreePrevizProject(scene: DirectorSceneData, project: PrevizProject): DirectorSceneData {
  const layer = project.scene.directorLayer
  if (!layer) return { ...scene, modeling: { schemaVersion: 1, project }, updatedAt: new Date().toISOString() }
  const bindings = layer.bindings
  for (const node of project.scene.nodes) {
    if (!bindings[node.id] && node.directorBinding) throw new Error('请使用场景对象的复制操作，以保留姿态、镜头和资源数据')
    if (bindings[node.id] && node.parentId) throw new Error('表演对象使用原有编组；模型对象支持父子层级')
    if (!bindings[node.id] && node.parentId && bindings[node.parentId]) throw new Error('请在建模对象之间设置父子层级；表演对象可作为机位跟随目标')
    if (bindings[node.id]?.kind === 'object' && (node.motionFacing || node.action && node.action !== 'idle')) throw new Error('请在动作库中设置人物动作')
    if (bindings[node.id]?.kind === 'camera' && (node.camera?.projection === 'orthographic' || node.camera?.followNodeId || node.camera?.near !== 0.1 || node.camera?.far !== 200)) throw new Error('请在此机位的属性面板设置镜头与跟随；导入机位支持正交相机')
  }
  const duration = project.scene.timeline.frameCount / 30
  const directorTimeline = normalizeDirectorTimeline(scene.timeline)
  if (duration + 1 / 30 < getDirectorMotionEnd(directorTimeline) && (directorTimeline.tracks.length || directorTimeline.cameraTracks.length || directorTimeline.poseTracks.length || directorTimeline.actionClips?.length || directorTimeline.pathClips?.length)) throw new Error('时长不能截断已有表演或手机轨迹，请先在时间轴调整对应片段')
  const bySource = (kind: 'object' | 'camera' | 'light', sourceId: string) => project.scene.nodes.find(node => bindings[node.id]?.kind === kind && bindings[node.id]?.id === sourceId)
  const removed = scene.objects.filter(object => !bySource('object', object.id)).map(object => object.id)
  const next = removed.length ? removeDirectorObjects(scene, removed) : { ...scene }
  next.objects = next.objects.map(object => {
    const node = bySource('object', object.id)!
    return { ...object, name: node.name, color: node.color, visible: node.visible, locked: node.locked, transform: structuredClone(node.localTransform) }
  })
  const main = bySource('camera', 'main-camera')
  if (main?.camera) {
    next.camera = cameraFromNode(main, scene.camera)
    next.mainCameraVisible = main.visible
    next.mainCameraLocked = main.locked
  } else {
    next.mainCameraPresent = false
    delete next.mainCameraAimObjectId
    delete next.mainCameraLens
    delete next.mainCameraLocked
    delete next.mainCameraVisible
  }
  next.cameraBookmarks = next.cameraBookmarks?.flatMap(camera => {
    const node = bySource('camera', camera.id)
    return node?.camera ? [{ ...camera, name: node.name, visible: node.visible, locked: node.locked, camera: cameraFromNode(node, camera.camera) }] : []
  })
  next.lights = next.lights.flatMap(light => {
    if (light.kind === 'ambient') return [light]
    const node = bySource('light', light.id)
    return node?.light ? [{ ...light, name: node.name, color: node.color, enabled: node.visible, position: [...node.localTransform.position] as [number, number, number], intensity: node.light.intensity, kind: node.light.kind }] : []
  })
  // References to projected entities are retained as graph references. Keep their immutable
  // binding map, not a second scene snapshot, in the native slice when tracks/parents use them.
  const referenced = new Set(project.scene.nodes.filter(node => node.parentId && bindings[node.parentId]).map(node => node.parentId!))
  for (const track of project.scene.timeline.tracks) if (bindings[track.nodeId]) referenced.add(track.nodeId)
  for (const shot of project.scene.shots) if (bindings[shot.cameraId]) referenced.add(shot.cameraId)
  for (const annotation of project.annotations) for (const id of annotation.nodeIds) if (bindings[id]) referenced.add(id)
  for (const node of project.scene.nodes) if (node.camera?.followNodeId && bindings[node.camera.followNodeId]) referenced.add(node.camera.followNodeId)
  const { directorLayer: _layer, ...graph } = project.scene
  const owned = graph.nodes.filter(node => !bindings[node.id])
  const retainedBindings = Object.fromEntries(Object.entries(bindings).filter(([id]) => referenced.has(id)))
  const native: PrevizProject = { ...project, scene: { ...graph, nodes: owned } }
  next.modeling = { schemaVersion: 1, project: native, directorBindings: retainedBindings }
  next.name = project.title
  next.aspectRatio = graph.aspectRatio
  next.environmentColor = graph.environment.background
  next.environmentPreset = graph.environment.presetCode
  const cameraIds = new Set(listDirectorAuthoredCameras(next).map(camera => camera.id))
  if (!cameraIds.has(next.activeCameraId ?? '')) {
    next.activeCameraId = resolveDirectorActiveCameraId(next) || undefined
    if (scene.activeCameraId || !next.activeCameraId) next.viewMode = 'director'
  }
  const retainedTimeline = normalizeDirectorTimeline(next.timeline)
  next.timeline = { ...retainedTimeline, duration, currentTime: Math.min(retainedTimeline.currentTime, duration), cameraTracks: retainedTimeline.cameraTracks.filter(track => cameraIds.has(track.cameraId)), laneIds: retainedTimeline.laneIds?.filter(id => !id.startsWith('camera:') || cameraIds.has(id.slice(7))) }
  next.updatedAt = new Date().toISOString()
  return next
}

export function threePrevizDuration(scene: DirectorSceneData) {
  return Math.max(normalizeDirectorTimeline(scene.timeline).duration, scene.modeling ? scene.modeling.project.scene.timeline.frameCount / 30 : 0)
}

/** Playback, direct download and canvas recording consume the same edited end time. */
export function threePrevizPlaybackEnd(scene: DirectorSceneData) {
  return Math.max(getDirectorMotionEnd(normalizeDirectorTimeline(scene.timeline)), scene.modeling ? scene.modeling.project.scene.timeline.frameCount / 30 : 0)
}

export function serializeThreePreviz(scene: DirectorSceneData): string {
  const packed = packThreePrevizAssets(scene)
  const value: ThreePrevizProjectPackage = { format: THREE_PREVIZ_FORMAT, packageVersion: 1, ...packed }
  const text = JSON.stringify(value)
  if (new TextEncoder().encode(text).byteLength > THREE_PREVIZ_MAX_BYTES) throw new Error('3D预演工程超过128MiB，请先清理不再使用的素材与版本')
  return text
}

/** Immutable asset pooling avoids writing the same GLB once for every historical scene. */
export function packThreePrevizAssets(scene: DirectorSceneData): { scene: DirectorSceneData; assetPool?: string[] } {
  if (!scene.modeling) return { scene }
  const assetPool: string[] = []
  const indices = new Map<string, number>()
  const pool = (url: string) => {
    if (!url.startsWith('data:')) return url
    let index = indices.get(url)
    if (index === undefined) { index = assetPool.length; indices.set(url, index); assetPool.push(url) }
    return `@asset:${index}`
  }
  const graph = (value: PrevizScene): PrevizScene => ({ ...value, assets: value.assets.map(asset => ({ ...asset, dataUrl: pool(asset.dataUrl) })) })
  const project = scene.modeling.project
  return { scene: { ...scene, modeling: { ...scene.modeling, project: { ...project, scene: graph(project.scene), versions: project.versions.map(version => ({ ...version, scene: graph(version.scene) })), annotations: project.annotations.map(annotation => ({ ...annotation, image: pool(annotation.image) })), thumbnail: project.thumbnail ? pool(project.thumbnail) : undefined } } }, assetPool }
}

export function unpackThreePrevizAssets(scene: DirectorSceneData, assetPool?: string[]): DirectorSceneData {
  if (!assetPool) return scene
  if (!Array.isArray(assetPool) || assetPool.length > 2048 || assetPool.some(value => typeof value !== 'string' || !/^data:(model\/gltf-binary|image\/(png|jpeg|webp));base64,/.test(value))) throw new Error('3D预演工程素材池无效')
  const decode = (value: string) => {
    if (!value.startsWith('@asset:')) return value
    const match = /^@asset:(0|[1-9]\d*)$/.exec(value)
    const url = match ? assetPool[Number(match[1])] : undefined
    if (!url) throw new Error('3D预演工程缺少被引用的素材')
    return url
  }
  const modeling = scene.modeling
  if (!modeling) return scene
  const project = modeling.project
  const graph = (value: PrevizScene): PrevizScene => ({ ...value, assets: value.assets.map(asset => ({ ...asset, dataUrl: decode(asset.dataUrl) })) })
  return { ...scene, modeling: { ...modeling, project: { ...project, scene: graph(project.scene), versions: project.versions.map(version => ({ ...version, scene: graph(version.scene) })), annotations: project.annotations.map(annotation => ({ ...annotation, image: decode(annotation.image) })), thumbnail: project.thumbnail ? decode(project.thumbnail) : undefined } } }
}

export function isThreePrevizPackage(value: unknown): value is ThreePrevizProjectPackage {
  return !!value && typeof value === 'object' && (value as ThreePrevizProjectPackage).format === THREE_PREVIZ_FORMAT && (value as ThreePrevizProjectPackage).packageVersion === 1
}

export function validateThreePrevizModeling(scene: DirectorSceneData) {
  if (!scene.modeling) return
  const { project, schemaVersion } = scene.modeling
  if (schemaVersion !== 1 || typeof project?.id !== 'string' || !project.id) throw new Error('3D预演建模文档版本或身份无效')
  if (!project.scene || project.scene.directorLayer || !Array.isArray(project.versions) || project.versions.length > 20 || !Array.isArray(project.annotations)) throw new Error('3D预演建模文档内容无效')
  if (hasMissingThreePrevizBinding(scene)) throw new Error('建模分镜或轨道引用了不存在的场景对象')
  validateScene(projectThreePreviz(scene).scene)
  for (const version of project.versions) validateScene(version.scene)
}

export function hasMissingThreePrevizBinding(scene: DirectorSceneData) {
  const bindings = scene.modeling?.directorBindings
  if (!bindings) return false
  const objects = new Set(scene.objects.map(object => object.id))
  const lights = new Set(scene.lights.map(light => light.id))
  const cameras = new Set(listDirectorAuthoredCameras(scene).map(camera => camera.id))
  return Object.values(bindings).some(binding => {
    if (binding.kind === 'object') return !objects.has(binding.id)
    if (binding.kind === 'light') return !lights.has(binding.id)
    return binding.kind !== 'camera' || !cameras.has(binding.id)
  })
}

export function threePrevizObjectCount(scene: DirectorSceneData) {
  const graph = scene.modeling?.project.scene
  return scene.objects.length + (graph?.nodes.filter(node => !['CAMERA', 'LIGHT'].includes(node.kind)).length ?? 0)
}

export async function threePrevizHistoryFingerprint(scene: DirectorSceneData): Promise<string> {
  const graph = await editorSceneDigest(projectThreePreviz(scene).scene)
  const { modeling: _modeling, updatedAt: _time, revision: _revision, spaceGenJob: _job, ...director } = scene
  const data = new TextEncoder().encode(JSON.stringify([graph, director]))
  return digestSha256Hex(data)
}
