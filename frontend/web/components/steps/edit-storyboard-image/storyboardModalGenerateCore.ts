'use client'

import { message } from 'antd'
import { EDIT_ASSET_PROMPT_MAX_CHARS } from '~/utils/htmlPlain'
import { resolveModelPromptCharacterLimit } from '~/utils/modelCapability'
import {
captureCreationLiveGenScope,
matchesCreationLiveGenScope
} from '~/composables/useCreationLiveGenScopeGuard'
import {
findStoryboardImageGenTaskInScopes
} from '~/composables/useCreationStoreHydration'
import { buildModalTaskOverlayKey } from '~/composables/useModalTaskScope'
import {
followStoryboardImageGenerateTask,
runStoryboardImageGenerateTask
} from '~/composables/useStoryboardImageGenerateTask'
import { modalGenSessionScopeFromScopeKey } from '~/utils/modalGenSessionScope'
import {
clearModalImageGenSession,
persistModalImageGenSession
} from '~/utils/storyboardImageModalGenSession'
import { activeStoryboardImageModalGenFollowIds } from '~/utils/storyboardImageModalOwnedFollow'
import { resolveStoryScriptSaveContext } from '~/utils/storyScriptSaveContext'
import {
formatTaskSseLiveText,
formatTaskSseLiveTextWithCounts
} from '~/utils/taskSseProgressText'
import type { EditStoryboardImageModalCtx } from './types'
import { storyboardImageBindingsFromHtml } from '~/utils/storyboardImageBindings'
import { invalidateUserStoryboardDetailCache } from '~/utils/storyboardDetailOnce'
import { buildStoryboardModalGenerateRequest } from './storyboardModalGenerateRequest'
import { registerStoryboardImageBindings } from './storyboardReferenceImages'

const activeStoryboardImageFollowStoryboardIds = activeStoryboardImageModalGenFollowIds

export function createStoryboardModalGenerateCore(ctx: EditStoryboardImageModalCtx) {
  const showStoryboardGenerateOverlay = () => {
    const sceneIdx = ctx.currentSceneIndex.get()
    const sid = ctx.currentStoryboardId()
    if (sid != null && ctx.isDialogueGenerationInProgress(sid)) return false

    if (ctx.isModalStoryboardImageUiActive(sid, sceneIdx)) return true

    const creationStore = ctx.store()
    if (
      creationStore.isGeneratingStoryboardImageBatch &&
      sid != null &&
      ctx.isStoryboardPanelImageGenerating(sid) &&
      !findStoryboardImageGenTaskInScopes(creationStore, sid, ctx.route())
    ) {
      return true
    }

    return false
  }

  const showCanvasImageGenMask = () => {
    const sid = ctx.currentStoryboardId()
    if (
      sid != null &&
      (ctx.isDialogueGenerationInProgress(sid) || ctx.isModalOverlayGenerationInProgress(sid))
    ) {
      return false
    }
    return showStoryboardGenerateOverlay()
  }

  const sceneImageGenMaskText = () => {
    const sid = ctx.currentStoryboardId()
    if (sid != null && ctx.isDialogueGenerationInProgress(sid)) {
      return ctx.upscaleProgressText.get() || '对话作图中...'
    }
    if (sid != null && ctx.isModalOverlayGenerationInProgress(sid)) {
      const session = ctx.readSessionForScene(ctx.currentSceneIndex.get())
      const overlayKind = ctx.resolveCanvasOverlayTaskKind(
        ctx.getModalImageGenTask(sid),
        session?.tab
      )
      return (
        ctx.upscaleProgressText.get() ||
        (overlayKind ? ctx.canvasOverlayDefaultProgressText(overlayKind) : '生成中...')
      )
    }
    return storyboardGenerateOverlayText()
  }

  const showStoryboardGenerateButtonLoading = () => showStoryboardGenerateOverlay()

  const storyboardGenerateOverlayText = () => {
    const sid = ctx.currentStoryboardId()
    const creationStore = ctx.store()
    if (
      creationStore.isGeneratingStoryboardImageBatch &&
      ctx.isStoryboardPanelImageGenerating(sid)
    ) {
      return formatTaskSseLiveTextWithCounts(
        creationStore.storyboardImageBatchProgress,
        '分镜图生成中'
      )
    }
    const persisted =
      sid != null ? findStoryboardImageGenTaskInScopes(creationStore, sid, ctx.route()) : null
    const fromStore = formatTaskSseLiveText(persisted || {}, '')
    if (fromStore) return fromStore
    return formatTaskSseLiveText(
      { message: ctx.storyboardGenerateProgressText.get() },
      ctx.storyboardGenerateProgressText.get() || '分镜图生成中…'
    )
  }

  const handleStartGenerate = async () => {
    if (showStoryboardGenerateButtonLoading()) return

    const promptPlain = ctx.storyboardPromptPlainText().trim()
    if (!promptPlain) {
      message.warning('请输入描述内容或先生成提示词')
      return
    }
    const promptMaxLength = resolveModelPromptCharacterLimit(
      ctx.selectedRawModel(),
      promptPlain,
      EDIT_ASSET_PROMPT_MAX_CHARS
    )
    if (promptPlain.length > promptMaxLength) {
      message.warning(`提示词不能超过 ${promptMaxLength.toLocaleString('zh-CN')} 个字符`)
      return
    }
    if (!ctx.currentStoryboardId()) {
      message.warning('分镜ID缺失，无法发起生成')
      return
    }

    const modelCode = String(ctx.selectedModel()?.id || '').trim()
    if (!modelCode) {
      message.warning('请先选择生图模型')
      return
    }

    const quality = String(ctx.generationSettings.get().quality || '').trim()
    const size = quality ? quality.toUpperCase() : ''
    const aspectRatio = String(ctx.generationSettings.get().aspectRatio || '').trim() || '16:9'
    const count = Math.max(1, Math.min(8, Number(ctx.generationSettings.get().count) || 1))
    const creationStore = ctx.store()
    const agentCode = String(
      creationStore.storyboardStylistGenerateSettings?.agentId ||
        creationStore.storyboardStylistAgent?.id ||
        ''
    ).trim()

    const sceneIdx = ctx.currentSceneIndex.get()
    const beforeCount = (ctx.props().scenes[sceneIdx]?.images || []).length

    const submitBody = buildStoryboardModalGenerateRequest({
      storyboardIds: [ctx.currentStoryboardId()!],
      ...(agentCode ? { agentCode } : {}),
      imagePrompt: promptPlain,
      imageReferences: storyboardImageBindingsFromHtml(ctx.storyboardPrompt.get()),
      modelName: modelCode,
      aspectRatio,
      size: size || undefined,
      count
    })

    // size=清晰度档（1K/2K…），与 aspectRatio 同时下发；对齐对话作图 / 场景弹窗 / 批量出图
    await runStoryboardImageGenerateForScene(sceneIdx, {
      submitBody,
      beforeCount,
      progressSubmitText: '分镜图提交中…'
    })
  }

  async function runStoryboardImageGenerateForScene(
    sceneIdx: number,
    opts: {
      submitBody?: Parameters<typeof runStoryboardImageGenerateTask>[0]['body']
      resumeTaskId?: number
      resumeRecordId?: number | null
      beforeCount?: number
      progressSubmitText?: string
      silentComplete?: boolean
    }
  ) {
    const storyboardId = Number(ctx.props().scenes[sceneIdx]?.storyboardId)
    if (!Number.isFinite(storyboardId) || storyboardId <= 0) return
    if (!opts.submitBody) {
      const session = ctx.readSessionForScene(sceneIdx)
      const task = ctx.getModalImageGenTask(storyboardId)
      if (
        ctx.isDialogueModalTask(task) ||
        ctx.isCanvasOverlayModalTask(task) ||
        session?.tab === 'dialogue' ||
        ctx.isModalOverlaySessionTab(session?.tab)
      ) {
        return
      }
    }

    /** 剧集隔离：任务归属启动时 scope；切集后终态收尾不得写当前集扁平 store、不得 toast、不得回写记录 */
    const taskScope = captureCreationLiveGenScope()
    const taskSessionScope = modalGenSessionScopeFromScopeKey(taskScope.scopeKey)

    const overlayParts = ctx.overlayKeyParts(sceneIdx, -1, 'storyboard-gen')
    ctx.storyboardGenerateTargetKey.set(buildModalTaskOverlayKey(overlayParts))
    ctx.isGeneratingStoryboardImage.set(true)
    if (opts.resumeTaskId) {
      const persisted = findStoryboardImageGenTaskInScopes(ctx.store(), storyboardId, ctx.route())
      const batchLive = formatTaskSseLiveTextWithCounts(
        ctx.store().storyboardImageBatchProgress,
        '分镜图生成中'
      )
      const singleLive = formatTaskSseLiveText(persisted || {}, '')
      ctx.storyboardGenerateProgressText.set(
        singleLive ||
          (ctx.store().isGeneratingStoryboardImageBatch ? batchLive : '') ||
          '分镜图生成中…'
      )
    } else {
      ctx.storyboardGenerateProgressText.set(opts.progressSubmitText || '分镜图生成中…')
    }
    persistModalImageGenSession(
      storyboardId,
      sceneIdx,
      taskScope.scopeKey,
      { tab: 'generate' },
      taskSessionScope
    )
    ctx.ensureGeneratingPlaceholderImage(sceneIdx)

    const beforeCount = opts.beforeCount
    let keepPendingUi = false

    const onProgress = (p: {
      successCount?: number
      totalCount?: number
      stepTitle?: string
      message?: string
    }) => {
      if (!matchesCreationLiveGenScope(taskScope)) return
      const live = String(p.message || p.stepTitle || '').trim()
      if (live) {
        ctx.storyboardGenerateProgressText.set(live)
        const task = findStoryboardImageGenTaskInScopes(ctx.store(), storyboardId, ctx.route())
        if (task?.taskId) {
          ctx.store().setStoryboardImageGenTask(
            storyboardId,
            {
              taskId: task.taskId,
              sceneIdx,
              kind: 'storyboard',
              message: p.message,
              stepTitle: p.stepTitle
            },
            taskScope.scopeKey
          )
        }
      } else if (p.successCount != null && p.totalCount != null) {
        ctx.storyboardGenerateProgressText.set(`已生成 ${p.successCount}/${p.totalCount} 张…`)
      }
    }

    activeStoryboardImageFollowStoryboardIds.add(storyboardId)

    try {
      const projectEpisode = await resolveStoryScriptSaveContext(ctx.store(), ctx.route())
      if (!matchesCreationLiveGenScope(taskScope)) {
        ctx.store().clearStoryboardImageGenTask(storyboardId, taskScope.scopeKey)
        clearModalImageGenSession(taskSessionScope)
        return
      }

      let result: Awaited<ReturnType<typeof runStoryboardImageGenerateTask>>

      if (opts.resumeTaskId) {
        result = await followStoryboardImageGenerateTask({
          taskId: opts.resumeTaskId,
          storyboardId,
          recordId: opts.resumeRecordId ?? null,
          projectEpisode,
          onProgress
        })
      } else if (opts.submitBody) {
        let body = opts.submitBody
        if (projectEpisode && body.imageReferences?.some(reference => !reference.imageId && reference.sourceUrl)) {
          const isCurrent = () => matchesCreationLiveGenScope(taskScope) &&
            ctx.props().open && ctx.currentStoryboardId() === storyboardId
          ctx.storyboardGenerateProgressText.set('正在登记参考图…')
          const imageReferences = await registerStoryboardImageBindings(projectEpisode, body.imageReferences, isCurrent)
          if (!isCurrent()) {
            ctx.clearModalStoryboardImageLoadingUi(storyboardId, sceneIdx)
            return
          }
          body = { ...body, imageReferences }
        }
        result = await runStoryboardImageGenerateTask({
          body,
          projectEpisode,
          onSubmitted: ({ taskId }) => {
            invalidateUserStoryboardDetailCache(storyboardId)
            ctx.store().setStoryboardImageGenTask(
              storyboardId,
              { taskId, sceneIdx, kind: 'storyboard' },
              taskScope.scopeKey
            )
            ctx.syncModalImageGenSessionTaskId(
              storyboardId,
              sceneIdx,
              taskId,
              { tab: 'generate' },
              taskSessionScope,
              taskScope.scopeKey
            )
            ctx.suspendLateModalImageFollowIfScopeChanged(taskId, taskScope)
          },
          onProgress
        })
      } else {
        return
      }

      if (!result.ok && 'deferred' in result && result.deferred) {
        keepPendingUi = true
        return
      }

      if (!matchesCreationLiveGenScope(taskScope)) {
        ctx.store().clearStoryboardImageGenTask(storyboardId, taskScope.scopeKey)
        clearModalImageGenSession(taskSessionScope)
        return
      }
      ctx.clearModalStoryboardImageLoadingUi(storyboardId, sceneIdx)
      if (!result.ok) {
        if (!opts.silentComplete) {
          message.error('errorMessage' in result ? result.errorMessage || '生图失败' : '生图失败')
        }
        await ctx.refreshSceneRecordsAfterTask(storyboardId, {})
        return
      }

      await ctx.refreshSceneRecordsAfterTask(storyboardId, result, beforeCount)
      if (!opts.silentComplete && matchesCreationLiveGenScope(taskScope)) message.success('分镜图生成成功')
    } catch (e: unknown) {
      if (!matchesCreationLiveGenScope(taskScope)) {
        ctx.store().clearStoryboardImageGenTask(storyboardId, taskScope.scopeKey)
        clearModalImageGenSession(taskSessionScope)
        return
      }
      if (!opts.silentComplete) {
        const err = e as { msg?: string; message?: string }
        message.error(String(err?.msg || err?.message || '生图失败'))
      }
      ctx.clearModalStoryboardImageLoadingUi(storyboardId, sceneIdx)
      await ctx.refreshSceneRecordsAfterTask(storyboardId, {})
    } finally {
      activeStoryboardImageFollowStoryboardIds.delete(storyboardId)
      if (!keepPendingUi && !activeStoryboardImageFollowStoryboardIds.size) {
        ctx.isGeneratingStoryboardImage.set(false)
      }
    }
  }

  /** 刷新或重新打开弹窗后，恢复当前分镜的生图 loading 与 SSE 追踪（按 storyboardId 隔离） */
  return {
    handleStartGenerate,
    runStoryboardImageGenerateForScene,
    sceneImageGenMaskText,
    showCanvasImageGenMask,
    showStoryboardGenerateButtonLoading,
    showStoryboardGenerateOverlay,
    storyboardGenerateOverlayText,
  }
}
