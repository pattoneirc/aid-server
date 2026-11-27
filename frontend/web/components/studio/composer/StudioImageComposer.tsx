'use client'

import { LinkOutlined, RobotOutlined } from '@ant-design/icons'
import { StudioChromeIcon } from '../theme/StudioChromeIcon'
import { SkillPickerPopover } from '@/components/common/skill-picker/SkillPickerPopover'
import { useStudioModels, useStudioSkills } from '@/hooks/studio/useStudioCatalog'
import { useStudioImageActions } from '@/hooks/studio/useStudioImageActions'
import { useStudioUiStore } from '@/stores/studioUi'
import type { StudioCanvasNode } from '@/types/studio'
import { StudioBenchPanel } from './StudioBenchPanel'
import { StudioCameraMovePanel } from './StudioCameraMovePanel'
import { StudioComposerChip } from './StudioComposerChip'
import { StudioComposerFrame } from './StudioComposerFrame'
import { StudioModelPicker } from './StudioModelPicker'
import { StudioParamsPopover } from './StudioParamsPopover'
import { StudioPromptAssistant } from './StudioPromptAssistant'
import { StudioStylePicker } from './StudioStylePicker'
import { StudioStoryboardCompositionTag } from './StudioStoryboardCompositionTag'
import { resolveStudioComposerGenSceneCode } from '@/utils/studio/studioComposerDefaultModel'
import { getStudioStoryboardComposition } from '@/utils/studio/studioStoryboardComposition'
import { resolveStudioImageActionSourceUrl } from '@/utils/studio/studioImageActionCapabilities'
import { canvasGenerationCapability, compatibleCanvasGenerationModels } from '@/utils/studio/canvasGenerationModels'
import { useCanvasProjectRuntime } from '@/components/studio/free/CanvasProjectRuntimeContext'
import { useCanvasComposerModel } from '@/hooks/studio/useCanvasComposerModel'
import { studioExplicitModelSelection } from '@/utils/studio/studioExplicitModelSelection'

export function StudioImageComposer({ node: original }: { node: StudioCanvasNode }) {
  const referencePicker = useStudioUiStore((state) => state.referencePicker)
  const beginReferencePick = useStudioUiStore((state) => state.beginReferencePick)
  const cancelReferencePick = useStudioUiStore((state) => state.cancelReferencePick)
  const updateNodeData = useStudioUiStore((state) => state.updateNodeData)
  const studioMode = useStudioUiStore((state) => state.studioMode)
  const canvasRuntime = useCanvasProjectRuntime()
  const hasImageReference = Boolean(original.data.mediaUrl || original.data.composerRefs?.some((ref) => ref.mediaKind === 'image'))
  const canvasModels = useStudioModels('image', { enabled: Boolean(canvasRuntime), generateMode: canvasGenerationCapability('image', hasImageReference), canvas: Boolean(canvasRuntime) })
  const { data: skills, loading: skillsLoading } = useStudioSkills()
  const actions = useStudioImageActions(original)
  const composition = getStudioStoryboardComposition(original.data.storyboardCompositionId)
  const hasComposition = Boolean(composition)
  const hasSource = Boolean(resolveStudioImageActionSourceUrl(original))
  const composerModels = canvasRuntime
    ? compatibleCanvasGenerationModels(canvasModels.data, 'image', hasImageReference)
    : hasSource || hasComposition
      ? actions.pools.edit
      : actions.pools.storyboard
  const { node, commit: commitModel } = useCanvasComposerModel(original, composerModels, { enabled: Boolean(canvasRuntime), loading: canvasModels.loading, preferredModelCode: canvasModels.defaultModelCode })
  const options = node.data.generationOptions ?? {}
  const sceneCode = resolveStudioComposerGenSceneCode(node.data)
  const submitDisabledReason = canvasRuntime && canvasModels.loading
    ? '正在读取图片模型'
    : canvasRuntime && canvasModels.error
    ? canvasModels.error
    : canvasRuntime && !composerModels.some(item => item.modelCode === node.data.model)
    ? '请选择生成模型'
    : hasComposition
    ? (hasSource ? actions.reasonFor('edit') : '请保留参考图后再生成')
    : node.data.mediaUrl
      ? actions.reasonFor('edit')
      : actions.reasonFor('storyboard')

  const togglePicking = () => {
    if (referencePicker?.targetNodeId === node.id) cancelReferencePick()
    else beginReferencePick(node.id)
  }
  const pickingRef = referencePicker?.targetNodeId === node.id

  return (
    <StudioComposerFrame
      node={node}
      cameraLibrary={Boolean(canvasRuntime)}
      pricingModel={canvasRuntime ? composerModels.find(item => item.modelCode === node.data.model) : undefined}
      pricingLoading={Boolean(canvasRuntime && canvasModels.loading)}
      placeholder={composition?.description}
      promptLeading={composition ? <StudioStoryboardCompositionTag node={node} /> : null}
      allowEmptySubmit={hasComposition}
      submitDisabledReason={submitDisabledReason}
      resolveBillingRequest={actions.resolveBillingRequest}
      onSubmit={(prompt) => {
        if (canvasRuntime) commitModel()
        if (hasComposition) return actions.runStoryboardComposition(prompt)
        return node.data.mediaUrl ? actions.edit(prompt) : actions.regenerate(prompt)
      }}
      topLeft={
        <>
          <StudioComposerChip icon={<StudioChromeIcon name="link" fallback={<LinkOutlined />} />} label={pickingRef ? '点选参考节点' : '参考'} active={pickingRef} onClick={togglePicking} />
          <StudioStylePicker node={node} />
          {canvasRuntime ? <StudioCameraMovePanel imageOnly /> : null}
          <StudioComposerChip
            icon={<StudioChromeIcon name="agentChat" fallback={<RobotOutlined />} />}
            label="Agent 对话"
            active={Boolean(node.data.composerAgentOpen)}
            arrow={false}
            onClick={() => updateNodeData(node.id, { composerAgentOpen: !node.data.composerAgentOpen })}
          />
        </>
      }
      topRight={<StudioPromptAssistant nodeId={node.id} mediaKind="image" prompt={node.data.prompt} onApply={(prompt) => updateNodeData(node.id, { prompt })} />}
      bottomLeft={
        <>
          <StudioModelPicker
            value={node.data.model}
            mediaKind="image"
            sceneCode={sceneCode}
            options={composerModels}
            optionsLoading={Boolean(canvasRuntime && canvasModels.loading)}
            optionsError={canvasRuntime ? canvasModels.error : undefined}
            ariaLabel="选择生成模型"
            selectedModelMeta={{ modelName: node.data.modelName, isFree: node.data.modelIsFree, costCredits: node.data.modelCostCredits }}
            syncDefaults={!canvasRuntime}
            preserveInvalidSelection={Boolean(canvasRuntime)}
            onChange={(model, item) => updateNodeData(node.id, canvasRuntime
              ? studioExplicitModelSelection('image', item, options)
              : { model, modelName: item.modelName, modelCostCredits: item.costCredits, modelIsFree: item.isFree })}
          />
          <StudioParamsPopover
            mode="image"
            value={options}
            modelCode={node.data.model}
            mediaKind="image"
            sceneCode={sceneCode}
            modelOptions={composerModels}
            syncDefaults={!canvasRuntime}
            onChange={(generationOptions) => canvasRuntime ? commitModel({ generationOptions }) : updateNodeData(node.id, { generationOptions })}
          />
          {studioMode !== 'free' ? (
            <StudioBenchPanel
              node={node}
              onChange={(generationOptions, imagePurpose) => updateNodeData(node.id, { generationOptions, ...(imagePurpose ? { imagePurpose } : {}) })}
              onDerive={(generationOptions, imagePurpose) => updateNodeData(node.id, { generationOptions, imagePurpose })}
            />
          ) : null}
          {node.data.composerAgentOpen ? (
            <SkillPickerPopover
              skills={skills}
              loading={skillsLoading}
              selectedSkillCode={node.data.composerSkillId ?? ''}
              showSkillCode={false}
              onSelect={(composerSkillId) => updateNodeData(node.id, { composerSkillId })}
            />
          ) : null}
        </>
      }
    />
  )
}
