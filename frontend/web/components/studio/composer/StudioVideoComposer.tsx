'use client'

import { useEffect, useMemo, useState } from 'react'
import { DatabaseOutlined, LinkOutlined, SwapOutlined } from '@ant-design/icons'
import { StudioChromeIcon } from '../theme/StudioChromeIcon'
import { useCreationStore } from '@/stores/creation'
import { useStudioUiStore } from '@/stores/studioUi'
import { useUserStore } from '@/stores/user'
import type { StudioCanvasNode, StudioComposerRef, StudioVideoGenMode } from '@/types/studio'
import { replaceStudioVideoReference, revokeStudioComposerRefPreview } from '@/utils/studio/studioComposerRefs'
import { hasSignedStudioDisclaimer, signStudioDisclaimer } from '@/utils/studio/studioDisclaimer'
import { studioVideoModeChoices, studioVideoModes } from '@/utils/studio/studioVideoModes'
import { resolveStudioComposerGenSceneCode } from '@/utils/studio/studioComposerDefaultModel'
import { useStudioStoryboardRecommendedDuration } from '@/hooks/studio/useStudioStoryboardRecommendedDuration'
import { useStudioVideoOperation } from '@/hooks/studio/useStudioVideoOperation'
import { useCanvasVideoToolQuote } from '@/hooks/studio/useCanvasVideoToolQuote'
import { createStudioVideoClipRange } from '@/utils/studio/studioVideoClip'
import {
  replaceStudioVideoOperationPromptLead,
  studioVideoOperationPromptLead,
  studioVideoOperationUserPrompt
} from '@/utils/studio/studioVideoOperationPrompt'
import { studioNodeToComposerRef } from '@/utils/studio/studioReferencePicker'
import { getStudioComposerPopupContainer } from '@/utils/studio/studioComposerPopupContainer'
import { StudioCanvasDropdownPopover } from '@/components/studio/canvas/StudioCanvasDropdownMenu'
import { StudioAssetLibraryModal } from './StudioAssetLibraryModal'
import { StudioCameraMovePanel } from './StudioCameraMovePanel'
import { StudioComposerChip } from './StudioComposerChip'
import { StudioComposerFrame } from './StudioComposerFrame'
import { StudioDisclaimerModal } from './StudioDisclaimerModal'
import { StudioModelPicker } from './StudioModelPicker'
import { StudioParamsPopover } from './StudioParamsPopover'
import { useCanvasComposerModel } from '@/hooks/studio/useCanvasComposerModel'
import { studioExplicitModelSelection } from '@/utils/studio/studioExplicitModelSelection'
import { StudioPromptAssistant } from './StudioPromptAssistant'
import { StudioVideoClipTimeline } from './StudioVideoClipTimeline'
import { useCanvasProjectRuntime } from '@/components/studio/free/CanvasProjectRuntimeContext'
import { useStudioCanvasModelsByFunc, useStudioModels } from '@/hooks/studio/useStudioCatalog'
import { canvasOrdinaryVideoModels, canvasVideoCapabilityChoices, canvasVideoCapabilityLabel, resolveCanvasVideoCapability } from '@/utils/studio/canvasGenerationModels'
import { canvasVideoCapabilityAvailability, canvasVideoNodeLinkKey, canvasVideoNodeLinksFromKey } from '@/utils/studio/canvasVideoLinkedNodes'
import { modelForCapability, modelSupportsCapability } from '@/utils/modelCapability'
import { parseReferenceVideoCapability } from '@/utils/referenceVideoCapability'
import { resolveVideoGenerationRequestSettings } from '@/utils/videoGenerationRequest'

const MODE_LABEL: Record<StudioVideoGenMode, string> = {
  imageToVideo: '图生视频',
  multiParam: '多参数',
  gridVideo: '宫格视频'
}

const EMPTY_STUDIO_NODES: StudioCanvasNode[] = []

export function StudioVideoComposer({ node: original }: { node: StudioCanvasNode }) {
  const canvasRuntime = useCanvasProjectRuntime()
  const specialPurpose = original.data.videoPurpose === 'reshoot' || original.data.videoPurpose === 'continuation'
    ? original.data.videoPurpose
    : null
  const specialFuncCode = specialPurpose === 'reshoot' ? 'canvas.video.reshoot'
    : specialPurpose === 'continuation' ? 'canvas.video.continue' : null
  const specialCapability = specialPurpose === 'reshoot' ? 'video_edit' : 'video_extend'
  const specialCatalog = useStudioCanvasModelsByFunc(specialFuncCode ?? '', String(canvasRuntime?.project?.projectId ?? ''), Boolean(canvasRuntime && specialFuncCode))
  const specialPool = { ...specialCatalog, models: specialCatalog.data.filter((item) => modelSupportsCapability(item, specialCapability)) }
  const hasImageReference = Boolean(original.data.composerRefs?.some((ref) => ref.mediaKind === 'image'))
  const linkKey = useStudioUiStore((state) => canvasVideoNodeLinkKey(original.id, state.nodes, state.edges))
  const videoLinks = useMemo(() => canvasVideoNodeLinksFromKey(linkKey), [linkKey])
  const canvasModels = useStudioModels('video', { enabled: Boolean(canvasRuntime), canvas: Boolean(canvasRuntime) })
  const requiresReferenceVideo = original.data.operationOrigin === 'director_reference'
  const canvasVideoModels = specialFuncCode ? specialPool.models : canvasOrdinaryVideoModels(canvasModels.data).filter((model) =>
    !requiresReferenceVideo || parseReferenceVideoCapability(model).supportsReferenceVideo
      && Boolean(resolveCanvasVideoCapability({ node: original, model, links: videoLinks })))
  const { node, commit: commitModel } = useCanvasComposerModel(original, specialPurpose ? canvasVideoModels.map((item) => modelForCapability(item, specialCapability) ?? item) : canvasVideoModels, {
    enabled: Boolean(canvasRuntime), loading: specialFuncCode ? specialPool.loading : canvasModels.loading,
    preferredModelCode: specialFuncCode ? specialPool.defaultModelCode : canvasModels.defaultModelCode,
    capability: specialPurpose ? specialCapability : undefined
  })
  const [disclaimerOpen, setDisclaimerOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  const [quoteDraft, setQuoteDraft] = useState(() => ({ nodeId: node.id, source: node.data.prompt, value: node.data.prompt }))
  const quotePrompt = quoteDraft.nodeId === node.id && quoteDraft.source === node.data.prompt
    ? quoteDraft.value : node.data.prompt
  /** 资料库关闭时返回稳定空数组，避免视频 Composer 跟整表 nodes 抖动。 */
  const nodes = useStudioUiStore((state) => (libraryOpen ? state.nodes : EMPTY_STUDIO_NODES))
  const assets = useStudioUiStore((state) => state.savedAssets)
  const studioMode = useStudioUiStore((state) => state.studioMode)
  const referencePicker = useStudioUiStore((state) => state.referencePicker)
  const beginReferencePick = useStudioUiStore((state) => state.beginReferencePick)
  const cancelReferencePick = useStudioUiStore((state) => state.cancelReferencePick)
  const updateNodeData = useStudioUiStore((state) => state.updateNodeData)
  const sourceNode = useStudioUiStore((state) => state.nodes.find(
    (item) => item.id === node.data.videoToolOptions?.sourceNodeId
  ))
  const creationMode = useCreationStore((state) => state.formData.globalSetting.creationMode)
  const projectId = useCreationStore((state) => state.currentProjectId)
  const episodeId = useCreationStore((state) => state.currentEpisodeId)
  const userId = useUserStore((state) => state.user?.id)
  const sceneCode = resolveStudioComposerGenSceneCode(node.data, creationMode)
  const recommendedDurationSeconds = useStudioStoryboardRecommendedDuration(node)
  const operation = useStudioVideoOperation()
  const selectedClipRange = node.data.videoToolOptions?.clipRange
  const clipRange = selectedClipRange ?? createStudioVideoClipRange(10, 5)
  const rawOptions = node.data.generationOptions ?? {}
  const creationModeKey = creationMode === 'auto_grid' ? 'grid' : creationMode
  const modes = studioVideoModes({ studioMode, creationMode: creationModeKey })
  const modeChoices = studioVideoModeChoices({
    studioMode,
    creationMode: creationModeKey,
    videoPurpose: node.data.videoPurpose
  })
  const activeMode = rawOptions.videoMode && modes.includes(rawOptions.videoMode)
    ? rawOptions.videoMode
    : modes[0]
  const options = { ...rawOptions, videoMode: activeMode }
  const selectedVideoModel = canvasVideoModels.find((model) => model.modelCode === node.data.model)
  const videoCapability = specialPurpose ? specialCapability : resolveCanvasVideoCapability({ node, model: selectedVideoModel, links: videoLinks })
  const videoCapabilityChoices = specialPurpose ? [] : canvasVideoCapabilityChoices(selectedVideoModel)
  const videoModeItems = (videoCapabilityChoices.length
    ? videoCapabilityChoices
    : videoCapability ? [{ code: videoCapability, label: canvasVideoCapabilityLabel(videoCapability) }] : []
  ).map((choice) => {
    const availability = canvasVideoCapabilityAvailability(choice, videoLinks)
    return {
      key: choice.code,
      label: choice.label,
      disabled: !availability.allowed,
      disabledHint: availability.disabledHint
    }
  })
  const projectedVideoModel = selectedVideoModel ? modelForCapability(selectedVideoModel, videoCapability) ?? selectedVideoModel : undefined
  const specialModel = specialPurpose ? modelForCapability(selectedVideoModel, specialCapability) : null
  const specialSettings = (() => {
    try { return { value: specialModel ? resolveVideoGenerationRequestSettings(options, specialModel) : undefined, error: '' } }
    catch (error) { return { value: undefined, error: error instanceof Error ? error.message : '当前模型规格不可用' } }
  })()
  const composerNode = rawOptions.videoMode === activeMode
    ? node
    : { ...node, data: { ...node.data, generationOptions: options } }
  const addRef = (ref: StudioComposerRef) => {
    const replacement = replaceStudioVideoReference(node.data.composerRefs, options, ref)
    updateNodeData(node.id, {
      composerRefs: replacement.composerRefs,
      generationOptions: replacement.generationOptions,
      ...(canvasRuntime && ref.assetId && /^\d+$/.test(ref.assetId)
        ? { canvasResourceIds: [...new Set([...(Array.isArray(node.data.canvasResourceIds) ? node.data.canvasResourceIds.map(String) : []), ref.assetId])] }
        : {})
    })
    if (replacement.previousRef && replacement.previousRef.previewUrl !== ref.previewUrl) {
      revokeStudioComposerRefPreview(replacement.previousRef)
    }
  }
  const requestLibrary = () => {
    if (hasSignedStudioDisclaimer(window.localStorage, userId)) setLibraryOpen(true)
    else setDisclaimerOpen(true)
  }

  const promptContext = specialPurpose && sourceNode
    ? studioVideoOperationPromptLead(specialPurpose, sourceNode.data.title, selectedClipRange)
    : undefined
  const toolQuote = useCanvasVideoToolQuote(specialPurpose && sourceNode && specialSettings.value ? {
    source: sourceNode,
    targetNodeId: node.id,
    operation: specialPurpose === 'reshoot' ? 'RESHOOT' : 'CONTINUE',
    label: specialPurpose === 'reshoot' ? '片段重拍' : '智能续写',
    modelCode: node.data.model,
    generationSettings: specialSettings.value,
    clipRange: specialPurpose === 'reshoot' ? selectedClipRange : undefined,
    prompt: studioVideoOperationUserPrompt(quotePrompt, node.data.videoToolOptions?.promptContext)
  } : null, canvasRuntime)
  useEffect(() => {
    if (!promptContext || !sourceNode || node.data.videoToolOptions?.promptContext) return
    updateNodeData(node.id, {
      prompt: replaceStudioVideoOperationPromptLead(node.data.prompt, undefined, promptContext),
      composerRefs: node.data.composerRefs?.some((ref) => ref.nodeId === sourceNode.id)
        ? node.data.composerRefs
        : [...(node.data.composerRefs ?? []), { ...studioNodeToComposerRef(sourceNode), channel: 'mention' }],
      videoToolOptions: { ...node.data.videoToolOptions, promptContext }
    })
  }, [node.data.composerRefs, node.data.prompt, node.data.videoToolOptions, node.id, promptContext, sourceNode, updateNodeData])

  const submitSpecialOperation = specialPurpose && sourceNode
    ? (prompt: string) => operation.run({
        source: sourceNode,
        targetNodeId: node.id,
        operation: specialPurpose === 'reshoot' ? 'RESHOOT' : 'CONTINUE',
        label: specialPurpose === 'reshoot' ? '片段重拍' : '智能续写',
        modelCode: node.data.model,
        generationSettings: specialSettings.value,
        clipRange: specialPurpose === 'reshoot' ? selectedClipRange : undefined,
        prompt: studioVideoOperationUserPrompt(prompt, node.data.videoToolOptions?.promptContext)
      })
    : undefined

  return (
    <div className={specialPurpose ? 'studio-video-operation-composer' : undefined}>
      {specialPurpose === 'reshoot' && sourceNode?.data.mediaUrl ? (
        <StudioVideoClipTimeline
          videoUrl={sourceNode.data.mediaUrl}
          value={clipRange}
          selected={Boolean(selectedClipRange)}
          onChange={(range) => {
            const latest = useStudioUiStore.getState().nodes.find((item) => item.id === node.id) ?? node
            const previous = latest.data.videoToolOptions?.promptContext
            const next = studioVideoOperationPromptLead('reshoot', sourceNode.data.title, range)
            updateNodeData(node.id, {
              prompt: replaceStudioVideoOperationPromptLead(latest.data.prompt, previous, next),
              videoToolOptions: { ...latest.data.videoToolOptions, clipRange: range, promptContext: next }
            }, false)
          }}
        />
      ) : null}
      <StudioComposerFrame
        node={composerNode}
        cameraLibrary={!node.data.videoPurpose}
        quoteOverride={specialPurpose ? specialSettings.error ? { quote: null, loading: false, error: specialSettings.error, status: 'BLOCKED' } : toolQuote : undefined}
        onPromptDraftChange={specialPurpose ? (value) => setQuoteDraft({ nodeId: node.id, source: node.data.prompt, value }) : undefined}
        pricingModel={canvasRuntime ? specialPurpose ? specialModel ?? undefined : selectedVideoModel : undefined}
        pricingLoading={Boolean(canvasRuntime && (specialFuncCode ? specialPool.loading : canvasModels.loading))}
        showCredits={Boolean(canvasRuntime)}
        placeholder={specialPurpose === 'reshoot'
          ? '留空可原样重拍，也可以描述需要修改的内容'
          : specialPurpose === 'continuation'
            ? '请输入需要续写的内容'
            : undefined}
        allowEmptySubmit={specialPurpose === 'reshoot'}
        onSubmit={canvasRuntime ? (prompt) => {
          commitModel()
          return submitSpecialOperation ? submitSpecialOperation(prompt) : canvasRuntime.generateNode('video', node.id, prompt)
        } : submitSpecialOperation}
        submitDisabledReason={canvasRuntime && !canvasRuntime.canEdit
          ? '当前账号只有查看权限'
          : canvasRuntime && !canvasRuntime.canUseFeature('canvas.generate')
            ? '当前账号没有画布生成权限'
          : canvasRuntime && canvasRuntime.isNodeBusy(node.id)
            ? '该节点正在生成中'
          : canvasRuntime && (specialFuncCode ? specialPool.loading : canvasModels.loading)
            ? '正在读取视频模型'
          : canvasRuntime && (specialFuncCode ? specialPool.error : canvasModels.error)
            ? specialFuncCode ? specialPool.error : canvasModels.error
          : canvasRuntime && !canvasVideoModels.length
            ? specialFuncCode ? '该视频工具暂无可用模型' : requiresReferenceVideo ? '暂无支持参考视频的成片模型' : hasImageReference ? '暂无可用的图生视频模型' : '暂无可用的文生视频模型，请添加图片参考'
          : canvasRuntime && !canvasVideoModels.some(item => item.modelCode === node.data.model)
            ? '请选择生成模型'
          : canvasRuntime && !specialPurpose && selectedVideoModel && !videoCapability
            ? '请连接图片或视频节点后再选择生成模式'
          : specialPurpose && !sourceNode
          ? '未找到源视频节点'
          : specialPurpose === 'reshoot' && !selectedClipRange
            ? '请先在时间轴中截取需要重拍的片段'
            : null}
        topLeft={
          <>
            <StudioComposerChip
              icon={<StudioChromeIcon name="link" fallback={<LinkOutlined />} />}
              label={referencePicker?.targetNodeId === node.id ? '点选参考节点' : '参考'}
              active={referencePicker?.targetNodeId === node.id}
              onClick={() => referencePicker?.targetNodeId === node.id
                ? cancelReferencePick()
                : beginReferencePick(node.id)}
            />
            {!node.data.videoPurpose ? <StudioCameraMovePanel /> : null}
            <StudioComposerChip icon={<StudioChromeIcon name="library" fallback={<DatabaseOutlined />} />} label="资料库" arrow={false} onClick={requestLibrary} />
          </>
        }
        topRight={<StudioPromptAssistant nodeId={node.id} mediaKind="video" prompt={node.data.prompt} onApply={(prompt) => updateNodeData(node.id, { prompt })} />}
        bottomLeft={
          <>
            <StudioModelPicker
              value={node.data.model}
              mediaKind="video"
              sceneCode={sceneCode}
              options={canvasRuntime ? canvasVideoModels : undefined}
              optionsLoading={Boolean(canvasRuntime && (specialFuncCode ? specialPool.loading : canvasModels.loading))}
              optionsError={canvasRuntime ? specialFuncCode ? specialPool.error : canvasModels.error : undefined}
              preferredModelCode={specialFuncCode ? specialPool.defaultModelCode : canvasModels.defaultModelCode}
              selectedModelMeta={{ modelName: node.data.modelName, isFree: node.data.modelIsFree, costCredits: node.data.modelCostCredits }}
              syncDefaults={!canvasRuntime}
              preserveInvalidSelection={Boolean(canvasRuntime)}
              onChange={(model, item) => {
                if (!canvasRuntime) {
                  updateNodeData(node.id, { model, modelName: item.modelName, modelCostCredits: item.costCredits, modelIsFree: item.isFree })
                  return
                }
                const nextCapability = specialPurpose ? specialCapability : resolveCanvasVideoCapability({
                  node: { ...node, data: { ...node.data, generationOptions: { ...options, videoCapability: undefined } } },
                  model: item,
                  links: videoLinks
                })
                updateNodeData(node.id, studioExplicitModelSelection(
                  'video',
                  modelForCapability(item, nextCapability) ?? item,
                  { ...options, videoCapability: specialPurpose ? options.videoCapability : nextCapability },
                  Boolean(specialPurpose)
                ))
              }}
            />
            {canvasRuntime && !node.data.videoPurpose ? (
              <StudioCanvasDropdownPopover
                items={videoModeItems}
                activeKey={videoCapability}
                onSelect={(code) => {
                  if (videoModeItems.some((item) => item.key === code && item.disabled)) return
                  commitModel({ generationOptions: { ...options, videoCapability: code } })
                }}
                open={modeOpen}
                onOpenChange={setModeOpen}
                nodePlacement
                ariaLabel="视频生成模式"
                getPopupContainer={getStudioComposerPopupContainer}
                trigger={<StudioComposerChip className="studio-composer-chip--mode" icon={<StudioChromeIcon name="videoMode" fallback={<SwapOutlined />} />} label={videoCapabilityChoices.find((choice) => choice.code === videoCapability)?.label || (videoCapability ? canvasVideoCapabilityLabel(videoCapability) : '生成模式')} active={modeOpen} />}
              />
            ) : !canvasRuntime && modeChoices.length > 1 ? (
              <StudioCanvasDropdownPopover
                items={modeChoices.map((mode) => ({ key: mode, label: MODE_LABEL[mode] }))}
                activeKey={activeMode}
                onSelect={(mode) => updateNodeData(node.id, { generationOptions: { ...options, videoMode: mode as StudioVideoGenMode } })}
                open={modeOpen}
                onOpenChange={setModeOpen}
                nodePlacement
                ariaLabel="视频生成模式"
                getPopupContainer={getStudioComposerPopupContainer}
                trigger={<StudioComposerChip className="studio-composer-chip--mode" icon={<StudioChromeIcon name="videoMode" fallback={<SwapOutlined />} />} label={MODE_LABEL[activeMode]} active={modeOpen} />}
              />
            ) : null}
            <StudioParamsPopover
              mode="video"
              singleResultVideo={Boolean(canvasRuntime)}
              audioControls={Boolean(canvasRuntime && !node.data.videoPurpose)}
              syncDefaults={!canvasRuntime}
              allowAutomaticDuration={Boolean(specialPurpose)}
              value={specialPurpose ? options : { ...options, videoCapability }}
              modelCode={node.data.model}
              mediaKind="video"
              sceneCode={sceneCode}
              modelOptions={canvasRuntime ? specialPurpose ? canvasVideoModels.map((model) => modelForCapability(model, specialCapability)!) : canvasVideoModels.map((model) => model.modelCode === node.data.model ? projectedVideoModel! : model) : undefined}
              recommendedDurationSeconds={specialPurpose ? undefined : recommendedDurationSeconds}
              onChange={(generationOptions) => canvasRuntime ? commitModel({ generationOptions }) : updateNodeData(node.id, { generationOptions })}
            />
          </>
        }
      />
      {options.endFrameEnabled ? (
        <div className="studio-composer-frame-slots">
          <button type="button" style={options.startFrameUrl ? { backgroundImage: `url(${options.startFrameUrl})` } : undefined} onClick={() => updateNodeData(node.id, { generationOptions: { ...options, startFrameUrl: node.data.composerRefs?.find((ref) => ref.mediaKind === 'image')?.previewUrl } })}>首帧</button>
          <button type="button" style={options.endFrameUrl ? { backgroundImage: `url(${options.endFrameUrl})` } : undefined} onClick={() => updateNodeData(node.id, { generationOptions: { ...options, endFrameUrl: [...(node.data.composerRefs ?? [])].reverse().find((ref) => ref.mediaKind === 'image')?.previewUrl } })}>尾帧</button>
        </div>
      ) : null}
      <StudioDisclaimerModal
        open={disclaimerOpen}
        variant={studioMode}
        onCancel={() => setDisclaimerOpen(false)}
        onAgree={() => {
          signStudioDisclaimer(window.localStorage, userId)
          setDisclaimerOpen(false)
          setLibraryOpen(true)
        }}
      />
      <StudioAssetLibraryModal
        open={libraryOpen}
        variant={studioMode}
        onOpenChange={setLibraryOpen}
        nodes={nodes}
        assets={assets}
        projectId={Number(projectId) || 0}
        episodeId={Number(episodeId) || null}
        onSelect={addRef}
      />
    </div>
  )
}
