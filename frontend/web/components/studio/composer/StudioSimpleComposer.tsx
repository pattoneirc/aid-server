'use client'

import { StudioPromptAssistant } from './StudioPromptAssistant'
import { StudioAudioComposer } from './StudioAudioComposer'
import { useCanvasComposerModel } from '@/hooks/studio/useCanvasComposerModel'
import type { StudioCanvasNode } from '@/types/studio'
import { useStudioUiStore } from '@/stores/studioUi'
import { StudioComposerFrame } from './StudioComposerFrame'
import { StudioModelPicker } from './StudioModelPicker'
import { resolveStudioComposerGenSceneCode } from '@/utils/studio/studioComposerDefaultModel'
import { useCanvasProjectRuntime } from '@/components/studio/free/CanvasProjectRuntimeContext'
import { useStudioCanvasModelsByFunc, useStudioModels } from '@/hooks/studio/useStudioCatalog'
import { StudioTextTools } from './StudioTextTools'

export function StudioSimpleComposer({ node }: { node: StudioCanvasNode }) {
  return node.data.kind === 'voice' ? <StudioAudioComposer node={node} /> : <StudioSimpleTextComposer node={node} />
}

function StudioSimpleTextComposer({ node: original }: { node: StudioCanvasNode }) {
  const canvasRuntime = useCanvasProjectRuntime()
  const describingImage = original.data.kind === 'text' && Boolean(original.data.imageDescribe)
  const ordinaryModels = useStudioModels('text', { enabled: Boolean(canvasRuntime && original.data.kind === 'text' && !describingImage), canvas: Boolean(canvasRuntime) })
  const describeModels = useStudioCanvasModelsByFunc('canvas.text.image_describe', String(canvasRuntime?.project?.projectId || ''), Boolean(canvasRuntime && describingImage))
  const textModels = describingImage ? describeModels : ordinaryModels
  const { node, commit: commitModel } = useCanvasComposerModel(original, textModels.data, { enabled: Boolean(canvasRuntime && original.data.kind === 'text'), loading: textModels.loading, preferredModelCode: textModels.defaultModelCode })
  const updateNodeData = useStudioUiStore((state) => state.updateNodeData)
  const canGenerateText = original.data.kind === 'text' && Boolean(canvasRuntime)
  return (
    <StudioComposerFrame
      node={node}
      pricingModel={canGenerateText ? textModels.data.find(model => model.modelCode === node.data.model) : undefined}
      pricingLoading={canGenerateText && textModels.loading}
      topRight={canGenerateText ? <StudioPromptAssistant nodeId={node.id} mediaKind="text" prompt={node.data.prompt} onApply={prompt => updateNodeData(node.id, { prompt })} /> : undefined}
      showCredits={canGenerateText}
      topLeft={canGenerateText && canvasRuntime && !describingImage ? (
        <>
          <StudioTextTools nodeId={node.id} runtime={canvasRuntime} />
        </>
      ) : undefined}
      placeholder="描述你想要生成的文本内容"
      onSubmit={canGenerateText
        ? (prompt) => {
          commitModel()
          return canvasRuntime!.generateNode('text', node.id, prompt)
        }
        : undefined}
      submitDisabledReason={canvasRuntime && !canvasRuntime.canEdit
        ? '当前账号只有查看权限'
        : canvasRuntime && !canvasRuntime.canUseFeature('canvas.generate')
            ? '当前账号没有画布生成权限'
            : canvasRuntime && canvasRuntime.isNodeBusy(node.id)
              ? '该节点正在生成中'
            : canGenerateText && textModels.loading
              ? '正在读取文本模型'
            : canGenerateText && !textModels.data.length
              ? '暂无可用的文本模型'
            : canGenerateText && !textModels.data.some(model => model.modelCode === node.data.model)
              ? '请先选择当前业务可用的文本模型'
          : null}
      bottomLeft={
        <>
          <StudioModelPicker
            value={node.data.model}
            mediaKind={original.data.kind === 'text' ? 'text' : node.data.mediaKind}
            sceneCode={resolveStudioComposerGenSceneCode(node.data)}
            options={canGenerateText ? textModels.data : undefined}
            optionsLoading={canGenerateText && textModels.loading}
            optionsError={canGenerateText ? textModels.error : undefined}
            syncDefaults={!canvasRuntime}
            preserveInvalidSelection={Boolean(canvasRuntime)}
            selectedModelMeta={{ modelName: node.data.modelName, isFree: node.data.modelIsFree, costCredits: node.data.modelCostCredits }}
            onChange={(model, item) => updateNodeData(node.id, { model, modelName: item.modelName, modelCostCredits: item.costCredits, modelIsFree: item.isFree })}
          />
        </>
      }
    />
  )
}
