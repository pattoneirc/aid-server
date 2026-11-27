'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { message } from 'antd'
import { runStoryboardEditImageTask } from '@/hooks/useStoryboardEditImageTask'
import { runStoryboardImageGenerateTask } from '@/hooks/useStoryboardImageGenerateTask'
import { runStoryboardImageUpscaleTask } from '@/hooks/useStoryboardImageUpscaleTask'
import { runStoryboardMultiViewGridImageTask } from '@/hooks/useStoryboardMultiViewGridImageTask'
import { useCreationStore } from '@/stores/creation'
import { useStudioUiStore } from '@/stores/studioUi'
import type { UserModelListItem } from '@/types/business-api'
import type { StudioCanvasNode, StudioImagePurpose } from '@/types/studio'
import { uploadImageToOssWithToast } from '@/utils/ossUpload'
import { AI_MODEL_FUNC_CODE, IMAGE_MULTI_GRID_FUNC_CODE_FALLBACKS, STORYBOARD_IMAGE_FUNC_CODE_FALLBACKS } from '@/utils/aiModelFuncCodes'
import { userModelListByFuncCodes } from '@/utils/businessApi'
import { modelsFromListByFuncGroups, pickFirstNonEmptyModelPool, uniqueTrimmedCodes } from '@/utils/modelListByFuncBatch'
import {
  resolveStudioStoryboardImageBinding,
  studioImageActionDisabledReason
} from '@/utils/studio/studioImageActionCapabilities'
import { ensureStudioFreeStoryboardBinding } from '@/utils/studio/ensureStudioFreeStoryboardBinding'
import { resolveStudioComposerModelFromNode } from '@/utils/studio/studioComposerDefaultModel'
import {
  buildStudioStoryboardEditImageSubmission,
  buildStudioStoryboardImageSubmission
} from '@/utils/studio/studioComposerSubmission'
import { planStudioStoryboardCompositionSubmit } from '@/utils/studio/studioStoryboardCompositionSubmit'
import { splitStudioImageGrid } from '@/utils/studio/studioImageGrid'
import type { TaskSseProgressInput } from '@/utils/taskSseProgressText'
import { runStudioRequestSingleFlight } from '@/utils/studio/studioRequestSingleFlight'
import { runStudioImageActionTask } from '@/hooks/studio/studioImageNodeSubmit'
import { useCanvasProjectRuntime } from '@/components/studio/free/CanvasProjectRuntimeContext'
import { useStudioModels } from '@/hooks/studio/useStudioCatalog'
import { canvasGenerationCapability, compatibleCanvasGenerationModels } from '@/utils/studio/canvasGenerationModels'
import { modelSupportsCapability } from '@/utils/modelCapability'

type PoolName = 'edit' | 'upscale' | 'multiView' | 'nineGrid' | 'storyboard'
type ModelPools = Record<PoolName, UserModelListItem[]>

const EMPTY_POOLS: ModelPools = { edit: [], upscale: [], multiView: [], nineGrid: [], storyboard: [] }

export function useStudioImageActions(
  node: StudioCanvasNode,
  options?: { resultNodeId?: string | null }
) {
  const resultNodeId = options?.resultNodeId ?? null
  const canvasRuntime = useCanvasProjectRuntime()
  const hasCanvasImageReference = Boolean(node.data.mediaUrl || node.data.composerRefs?.some((ref) => ref.mediaKind === 'image'))
  const canvasModels = useStudioModels('image', { enabled: Boolean(canvasRuntime), generateMode: canvasGenerationCapability('image', hasCanvasImageReference), canvas: Boolean(canvasRuntime) })
  const canvasUpscaleModels = useStudioModels('image', { enabled: Boolean(canvasRuntime), generateMode: 'image_upscale', canvas: true })
  const panels = useCreationStore((state) => state.formData.storyboardScript.panels)
  const projectId = useCreationStore((state) => state.currentProjectId)
  const episodeId = useCreationStore((state) => state.currentEpisodeId)
  const deriveImageNode = useStudioUiStore((state) => state.deriveImageNode)
  const addNode = useStudioUiStore((state) => state.addNode)
  const addConnection = useStudioUiStore((state) => state.addConnection)
  const [pools, setPools] = useState<ModelPools>(EMPTY_POOLS)
  const [modelsLoading, setModelsLoading] = useState(true)
  const [localGridBusy, setLocalGridBusy] = useState(false)
  const binding = useMemo(
    () => resolveStudioStoryboardImageBinding(node, panels),
    [node, panels]
  )

  useEffect(() => {
    let active = true
    const codes = uniqueTrimmedCodes([
      ...STORYBOARD_IMAGE_FUNC_CODE_FALLBACKS,
      AI_MODEL_FUNC_CODE.IMAGE_EDIT,
      AI_MODEL_FUNC_CODE.IMAGE_UPSCALE,
      AI_MODEL_FUNC_CODE.IMAGE_MULTI_VIEW,
      ...IMAGE_MULTI_GRID_FUNC_CODE_FALLBACKS
    ])
    const pid = Number(projectId)
    const eid = Number(episodeId)
    void Promise.resolve().then(() => {
      if (active) setModelsLoading(true)
      return userModelListByFuncCodes(codes, Number.isFinite(pid) && pid > 0
        ? { projectId: pid, ...(Number.isFinite(eid) && eid >= 0 ? { episodeId: eid } : {}) }
        : undefined)
    })
      .then((groups) => {
        if (!active) return
        setPools({
          edit: modelsFromListByFuncGroups(groups, AI_MODEL_FUNC_CODE.IMAGE_EDIT),
          upscale: modelsFromListByFuncGroups(groups, AI_MODEL_FUNC_CODE.IMAGE_UPSCALE),
          multiView: modelsFromListByFuncGroups(groups, AI_MODEL_FUNC_CODE.IMAGE_MULTI_VIEW),
          nineGrid: pickFirstNonEmptyModelPool(groups, IMAGE_MULTI_GRID_FUNC_CODE_FALLBACKS),
          storyboard: pickFirstNonEmptyModelPool(groups, STORYBOARD_IMAGE_FUNC_CODE_FALLBACKS)
        })
      })
      .catch(() => {
        if (active) setPools(EMPTY_POOLS)
      })
      .finally(() => {
        if (active) setModelsLoading(false)
      })
    return () => { active = false }
  }, [episodeId, projectId])

  const reasonFor = useCallback((action: PoolName | 'grid') => {
    const studioMode = useStudioUiStore.getState().studioMode
    if (action === 'grid') {
      if (canvasRuntime && !canvasRuntime.canEdit) return '当前账号只有查看权限'
      if (canvasRuntime && !canvasRuntime.canMutate) return '画布协作连接尚未就绪，请稍后重试'
      return node.data.mediaUrl ? null : '请先上传或生成源图片'
    }
    if (canvasRuntime) {
      if (!canvasRuntime.canEdit) return '当前账号只有查看权限'
      if (!canvasRuntime.canUseFeature('canvas.generate')) return '当前账号没有画布生成权限'
      if (canvasRuntime.isNodeBusy(node.id)) return '该节点正在生成中'
      if (action === 'upscale') {
        if (!resultNodeId) return '请先创建高清结果节点'
        if (!node.data.mediaUrl) return '请先上传或生成源图片'
        if (canvasRuntime.isNodeBusy(resultNodeId)) return '高清节点正在生成中'
        if (canvasUpscaleModels.loading) return '正在读取高清模型'
        if (!canvasUpscaleModels.data.some((model) => modelSupportsCapability(model, 'image_upscale'))) return '暂无可用的图片高清模型'
      } else if (action === 'storyboard' || action === 'edit') {
        if (canvasModels.loading) return '正在读取图片模型'
        const hasImageReference = Boolean(node.data.mediaUrl || node.data.composerRefs?.some((ref) => ref.mediaKind === 'image'))
        if (!compatibleCanvasGenerationModels(canvasModels.data, 'image', hasImageReference).length) {
          return hasImageReference ? '暂无可用的图生图模型' : '暂无可用的文生图模型'
        }
      } else {
        if (modelsLoading) return '正在读取生图功能模型池'
        if (!pools[action].length) return '当前功能模型池暂无可用模型'
      }
      return null
    }
    if (action === 'storyboard') {
      if (studioMode !== 'free' && !binding.storyboardId) {
        return '仅绑定到真实分镜的数据节点可提交重新生成'
      }
      if (modelsLoading) return '正在读取生图功能模型池'
      if (!pools.storyboard.length) return '生图功能模型池暂无可用模型'
      return null
    }
    return studioImageActionDisabledReason({
      node,
      binding,
      requiresRecord: action === 'upscale',
      modelAvailable: modelsLoading ? false : pools[action].length > 0,
      studioMode
    })
  }, [binding, canvasModels, canvasRuntime, canvasUpscaleModels, modelsLoading, node, pools, resultNodeId])

  /**
   * 自由画布：节点本身没有「分镜」业务概念。
   * 底层图片任务 API / 计费仍需要 numeric storyboardId，因此在首次提交时懒创建一个
   * 仅用于任务归属的服务端记录，并回写到节点；对用户侧不表现为流程分镜。
   */
  const resolveStoryboardIdForSubmit = useCallback(async (): Promise<number | null> => {
    const latestNode = useStudioUiStore.getState().nodes.find((item) => item.id === node.id) ?? node
    const existing = Number(latestNode.data.storyboardId)
    if (Number.isFinite(existing) && existing > 0) return existing

    const studioMode = useStudioUiStore.getState().studioMode
    if (studioMode !== 'free') {
      message.warning('仅绑定到真实分镜的数据节点可提交该任务')
      return null
    }

    const ensured = await ensureStudioFreeStoryboardBinding({
      nodeId: node.id,
      projectId,
      episodeId,
      title: latestNode.data.title
    })
    if ('error' in ensured) {
      message.warning(ensured.error)
      return null
    }
    return ensured.storyboardId
  }, [episodeId, node, projectId])

  const writeImageResultToNode = useCallback((targetId: string, label: string, prompt: string, purpose?: StudioImagePurpose) => {
    const store = useStudioUiStore.getState()
    const target = store.nodes.find((item) => item.id === targetId)
    if (!target) return null
    store.updateNodeData(targetId, {
      status: 'queued',
      prompt: prompt.trim() || target.data.prompt,
      imagePurpose: purpose ?? target.data.imagePurpose ?? 'generic',
      resultSummary: undefined,
      errorMessage: undefined,
      mediaUrl: undefined
    })
    store.selectNodes([targetId])
    return targetId
  }, [])

  const createDerived = useCallback((label: string, prompt: string, purpose?: StudioImagePurpose, generationOptions?: StudioCanvasNode['data']['generationOptions']) => {
    if (resultNodeId) {
      return writeImageResultToNode(resultNodeId, label, prompt, purpose)
    }
    const latestNode = useStudioUiStore.getState().nodes.find((item) => item.id === node.id) ?? node
    // 分镜构图空下游节点：写回自身，避免再派生一层且参考图丢失
    if (
      latestNode.data.storyboardCompositionId
      && !String(latestNode.data.mediaUrl || '').trim()
    ) {
      return writeImageResultToNode(latestNode.id, label, prompt, purpose)
    }
    return deriveImageNode(
      node.id,
      structuredClone(generationOptions ?? latestNode.data.generationOptions ?? {}),
      purpose ?? latestNode.data.imagePurpose ?? 'generic',
      label,
      prompt
    )
  }, [deriveImageNode, node, resultNodeId, writeImageResultToNode])

  const runTask = useCallback(async (input: {
    label: string
    prompt: string
    purpose?: StudioImagePurpose
    generationOptions?: StudioCanvasNode['data']['generationOptions']
    model?: UserModelListItem
    execute: (callbacks: {
      onSubmitted: (info: { taskId: number }) => void
      onProgress: (info: TaskSseProgressInput & { percent?: number }) => void
    }) => Promise<{ ok: boolean; errorMessage?: string; deferred?: boolean; imageUrl?: string | null; recordId?: number | null; items?: Array<{ imageUrl?: string; recordId?: number; imageId?: number }> }>
  }) => {
    const targetId = createDerived(input.label, input.prompt, input.purpose, input.generationOptions)
    if (!targetId) return false
    if (input.model) useStudioUiStore.getState().updateNodeData(targetId, { model: input.model.modelCode, modelName: input.model.modelName, modelCostCredits: undefined, modelIsFree: undefined })
    return runStudioImageActionTask({
      sourceNodeId: node.id,
      sourceTitle: node.data.title,
      targetId,
      label: input.label,
      execute: input.execute
    })
  }, [createDerived, node.data.title, node.id])

  const edit = useCallback(async (
    prompt: string,
    label = '图片编辑',
    purpose?: StudioImagePurpose,
    options?: { referenceImage?: string; generationOptions?: StudioCanvasNode['data']['generationOptions']; modelCode?: string; expectedSourceUrl?: string; isCurrent?: () => boolean }
  ) => {
    const reason = reasonFor('edit')
    if (reason) { message.warning(reason); return false }
    if (canvasRuntime) {
      const latestNode = useStudioUiStore.getState().nodes.find((item) => item.id === node.id) ?? node
      return canvasRuntime.generateNode('image', latestNode.id, prompt)
    }
    const requestKey = `${useStudioUiStore.getState().scopeKey}:${node.id}`
    return runStudioRequestSingleFlight(`${requestKey}:image-edit-submit`, async () => {
      const storyboardId = await resolveStoryboardIdForSubmit()
      if (!storyboardId || (options?.isCurrent && !options.isCurrent())) return false
      const latestNode = useStudioUiStore.getState().nodes.find((item) => item.id === node.id)
      if (!latestNode || (options?.expectedSourceUrl && latestNode.data.mediaUrl !== options.expectedSourceUrl)) return false
      const model = options?.modelCode ? pools.edit.find((item) => item.modelCode === options.modelCode)
        : resolveStudioComposerModelFromNode(pools.edit, latestNode) ?? pools.edit[0]
      if (!model) return false
      const generationOptions = { ...latestNode.data.generationOptions, ...options?.generationOptions }
      const submission = buildStudioStoryboardEditImageSubmission({
        node: { ...latestNode, data: { ...latestNode.data, generationOptions } },
        model, storyboardId, prompt, referenceImage: options?.referenceImage
      })
      if (!submission) return false
      return await runTask({ label, prompt, purpose, generationOptions, model,
        execute: (callbacks) => runStoryboardEditImageTask({ ...submission.body, ...callbacks }) })
    })

  }, [canvasRuntime, node, pools.edit, reasonFor, resolveStoryboardIdForSubmit, runTask])

  const upscale = useCallback(async (settings?: { modelCode: string; sourceWidth: number; sourceHeight: number; scale: 2 | 4 | 6 }) => {
    const reason = reasonFor('upscale')
    if (reason) { message.warning(reason); return false }
    if (canvasRuntime) {
      if (!resultNodeId || !settings) { message.warning('请先确认高清型号和原图尺寸'); return false }
      return canvasRuntime.generateNode('image', resultNodeId, '', {
        imageUpscale: { sourceNodeId: node.id, ...settings }
      })
    }
    const model = pools.upscale.find((item) => item.modelCode === settings?.modelCode) ?? pools.upscale[0]!
    return runTask({
      label: '图片高清',
      prompt: node.data.prompt,
      execute: (callbacks) => runStoryboardImageUpscaleTask({
        genRecordId: binding.genRecordId!,
        modelCode: model.modelCode,
        resolution: model.defaultSizeCode || '2K',
        ...callbacks
      })
    })
  }, [binding.genRecordId, canvasRuntime, node.data.prompt, node.id, pools.upscale, reasonFor, resultNodeId, runTask])

  const multiView = useCallback(async (
    anglePrompt: string,
    options?: {
      imageUrl?: string
      label?: string
      purpose?: StudioImagePurpose
      model?: UserModelListItem
    }
  ) => {
    const model = options?.model ?? pools.multiView[0]
    if (!model) {
      message.warning(reasonFor('multiView') || '多机位功能模型池暂无可用模型')
      return false
    }
    const reason = options?.model ? null : reasonFor('multiView')
    if (reason) { message.warning(reason); return false }
    const prompt = anglePrompt.trim()
    if (!prompt) { message.warning('请填写目标机位描述'); return false }
    if (canvasRuntime) return canvasRuntime.generateNode('image', node.id, anglePrompt)
    const storyboardId = await resolveStoryboardIdForSubmit()
    if (!storyboardId) return false
    const latestNode = useStudioUiStore.getState().nodes.find((item) => item.id === node.id) ?? node
    const imageUrl = String(options?.imageUrl || latestNode.data.mediaUrl || '').trim()
    if (!imageUrl) { message.warning('请先上传或生成源图片'); return false }
    return runTask({
      label: options?.label || '多机位',
      prompt: `${latestNode.data.prompt}\n机位要求：${prompt}`.trim(),
      purpose: options?.purpose,
      execute: (callbacks) => runStoryboardMultiViewGridImageTask({
        storyboardId,
        imageUrl,
        angles: [prompt],
        modelCode: model.modelCode,
        aspectRatio: latestNode.data.generationOptions?.aspectRatio || model.defaultAspectRatio || '1:1',
        ...callbacks
      })
    })
  }, [canvasRuntime, node, pools.multiView, reasonFor, resolveStoryboardIdForSubmit, runTask])

  const runStoryboardComposition = useCallback(async (userPrompt: string) => {
    const latest = useStudioUiStore.getState().nodes.find((item) => item.id === node.id) ?? node
    const planned = planStudioStoryboardCompositionSubmit({ node: latest, userPrompt })
    if ('error' in planned) {
      message.warning(planned.error)
      return false
    }

    if (planned.route === 'multi_view' || planned.route === 'nine_grid') {
      const gridModel = planned.route === 'nine_grid'
        ? (pools.nineGrid[0] ?? pools.multiView[0])
        : (pools.multiView[0] ?? pools.nineGrid[0])
      if (gridModel) {
        return multiView(planned.finalPrompt, {
          imageUrl: planned.referenceImage,
          label: planned.label,
          purpose: planned.purpose,
          model: gridModel
        })
      }
      // 无专用池时降级编辑，保持同一提交入口
      return edit(planned.finalPrompt, planned.label, planned.purpose, {
        referenceImage: planned.referenceImage
      })
    }

    return edit(planned.finalPrompt, planned.label, planned.purpose, {
      referenceImage: planned.referenceImage
    })
  }, [edit, multiView, node, pools.multiView, pools.nineGrid])

  const regenerate = useCallback(async (promptOverride?: string) => {
    const reason = reasonFor('storyboard')
    if (reason) { message.warning(reason); return false }
    const latestNode = useStudioUiStore.getState().nodes.find((item) => item.id === node.id) ?? node
    const prompt = promptOverride?.trim() || latestNode.data.prompt
    if (canvasRuntime) {
      const canvasPrompt = promptOverride ?? latestNode.data.prompt
      return canvasRuntime.generateNode('image', latestNode.id, canvasPrompt)
    }
    const storyboardId = await resolveStoryboardIdForSubmit()
    if (!storyboardId) return false
    const model = resolveStudioComposerModelFromNode(pools.storyboard, latestNode) ?? pools.storyboard[0]
    if (!model) return false
    const pid = Number(projectId)
    const eid = Number(episodeId)
    const submission = buildStudioStoryboardImageSubmission({
      node: latestNode,
      model,
      storyboardId,
      prompt
    })
    return runTask({
      label: '重新生成',
      prompt,
      execute: (callbacks) => runStoryboardImageGenerateTask({
        body: submission.body,
        projectEpisode: Number.isFinite(pid) && pid > 0 && Number.isFinite(eid) && eid >= 0
          ? { projectId: pid, episodeId: eid }
          : null,
        ...callbacks
      })
    })
  }, [canvasRuntime, episodeId, node, pools.storyboard, projectId, reasonFor, resolveStoryboardIdForSubmit, runTask])

  const resolveBillingRequest = useCallback((prompt: string) => {
    if (canvasRuntime) return null
    const latestNode = useStudioUiStore.getState().nodes.find((item) => item.id === node.id) ?? node
    const storyboardId = Number(latestNode.data.storyboardId)
    // 自由画布未绑定时报价可为空；提交时会懒创建任务绑定。流程画布仍要求已有绑定。
    if (!Number.isFinite(storyboardId) || storyboardId <= 0) return null
    if (latestNode.data.mediaUrl) {
      const model = resolveStudioComposerModelFromNode(pools.edit, latestNode) ?? pools.edit[0]
      return model
        ? buildStudioStoryboardEditImageSubmission({
            node: latestNode,
            model,
            storyboardId,
            prompt
          })?.billingRequest ?? null
        : null
    }
    const model = resolveStudioComposerModelFromNode(pools.storyboard, latestNode) ?? pools.storyboard[0]
    return model
      ? buildStudioStoryboardImageSubmission({
          node: latestNode,
          model,
          storyboardId,
          prompt
        }).billingRequest
      : null
  }, [canvasRuntime, node, pools.edit, pools.storyboard])

  const splitGrid = useCallback(async (size: 2 | 3) => {
    const reason = reasonFor('grid')
    if (reason || localGridBusy) { if (reason) message.warning(reason); return false }
    setLocalGridBusy(true)
    try {
      if (canvasRuntime) {
        await runStudioRequestSingleFlight(`image-grid:${useStudioUiStore.getState().scopeKey}:${node.id}:${size}`, async () => {
          const result = await canvasRuntime.splitImage(node.id, size, size)
          if (result.outputs.length !== size * size) throw new Error('切分结果数量不完整，请刷新后重试')
          const source = useStudioUiStore.getState().nodes.find((item) => item.id === node.id)
          if (!source) throw new Error('源图片节点已删除，切分结果未加入画布')
          const sourceResourceId = String(source.data.canvasPrimaryResourceId || source.data.canvasResourceIds?.[0] || '')
          useStudioUiStore.getState().beginGraphTransaction()
          try {
            for (const output of result.outputs) {
              const row = output.row ?? Math.floor(output.index / size)
              const col = output.col ?? output.index % size
              addNode('image', {
                x: source.position.x + 310 + col * 42,
                y: source.position.y + row * 42
              }, {
                title: `${source.data.title} · 宫格 ${String(output.index + 1).padStart(2, '0')}`,
                subtitle: `由 ${source.data.title} 确定性切分`,
                zoneId: source.data.zoneId,
                status: 'success',
                mediaKind: 'image',
                mediaUrl: output.resourceUrl,
                mediaAspectRatio: output.width / output.height,
                canvasResourceIds: [String(output.resourceId)],
                canvasPrimaryResourceId: String(output.resourceId),
                imagePurpose: 'reference',
                composerHidden: true,
                imageSplitOrigin: { sourceNodeId: source.id, sourceResourceId, row, col, x: output.x, y: output.y, width: output.width, height: output.height },
                resultSummary: `${size}×${size} 宫格第 ${output.index + 1} 格（无模型费用）`
              }, { nodeId: source.id, role: 'source', kind: 'reference' })
            }
          } finally {
            useStudioUiStore.getState().commitGraphTransaction()
          }
          await canvasRuntime.saveNow()
        })
        message.success(`已创建 ${size * size} 个宫格图片节点`)
        return true
      }
      const files = await splitStudioImageGrid(node.data.mediaUrl!, {
        rows: size,
        columns: size,
        fileBaseName: `${node.data.title}-${size}x${size}`
      })
      const source = useStudioUiStore.getState().nodes.find((item) => item.id === node.id)
      let successCount = 0
      for (let index = 0; index < files.length; index += 1) {
        const mediaUrl = await uploadImageToOssWithToast(files[index]!, () => undefined)
        if (!mediaUrl) continue
        const targetId = addNode('image', source
          ? { x: source.position.x + 310 + (index % size) * 42, y: source.position.y + Math.floor(index / size) * 42 }
          : undefined, {
          title: `${node.data.title} · 宫格 ${String(index + 1).padStart(2, '0')}`,
          subtitle: `由 ${node.data.title} 浏览器确定性切分`,
          zoneId: node.data.zoneId,
          status: 'success',
          mediaKind: 'image',
          mediaUrl,
          imagePurpose: node.data.imagePurpose ?? 'reference',
          composerHidden: true,
          prompt: node.data.prompt,
          storyboardId: node.data.storyboardId,
          resultSummary: `${size}×${size} 宫格第 ${index + 1} 格（非 AI）`
        })
        addConnection({ source: node.id, target: targetId, sourceHandle: null, targetHandle: null }, 'reference')
        successCount += 1
      }
      if (!successCount) throw new Error('宫格切片上传失败')
      message.success(`已生成 ${successCount} 个宫格图片节点（浏览器切分）`)
      return true
    } catch (error: unknown) {
      message.error((error as Error)?.message || '宫格切分失败')
      return false
    } finally {
      setLocalGridBusy(false)
    }
  }, [addConnection, addNode, canvasRuntime, localGridBusy, node, reasonFor])

  return {
    binding,
    pools,
    canvasUpscaleModels,
    modelsLoading,
    localGridBusy,
    reasonFor,
    resolveBillingRequest,
    edit,
    upscale,
    multiView,
    regenerate,
    splitGrid,
    runStoryboardComposition
  }
}

export type StudioImageActions = ReturnType<typeof useStudioImageActions>
