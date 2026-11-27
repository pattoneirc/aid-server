import { message } from 'antd'
import type { CanvasProjectWorkspaceRuntime } from '@/hooks/studio/useCanvasProjectWorkspace'
import {
  loadStudioImageSubmitPools,
  submitStudioImageNode
} from '@/hooks/studio/studioImageNodeSubmit'
import { useStudioUiStore } from '@/stores/studioUi'
import { canvasUserModelList } from '@/utils/business/model'
import { canvasErrorMessage } from '@/utils/canvas/canvasErrorMessage'
import { canvasGenerationCapability, compatibleCanvasGenerationModels } from '@/utils/studio/canvasGenerationModels'
import { pickStudioComposerDefaultModel } from '@/utils/studio/studioComposerDefaultModel'
import { studioExplicitModelSelection } from '@/utils/studio/studioExplicitModelSelection'
import { isStudioNodeBatchExecutable, listGroupExecutableNodeIds } from '@/utils/studio/studioGroupActions'
import { planStudioStoryboardCompositionSubmit } from '@/utils/studio/studioStoryboardCompositionSubmit'

export type StudioGroupImageExecution = {
  id: string
  title: string
  status: 'pending' | 'running' | 'completed' | 'accepted' | 'failed'
  reason?: string
}

type GroupImageRuntime = Pick<CanvasProjectWorkspaceRuntime,
  'canEdit' | 'canMutate' | 'canUseFeature' | 'isNodeBusy' | 'generateNodeResult'>

const imageMode = (data: { mediaUrl?: string; composerRefs?: { mediaKind: string }[] }) =>
  canvasGenerationCapability('image', Boolean(data.mediaUrl || data.composerRefs?.some(ref => ref.mediaKind === 'image')))

export async function executeStudioGroupImages(input: {
  scopeKey: string
  groupId: string
  nodes: StudioGroupImageExecution[]
  runtime: GroupImageRuntime
  onUpdate: (node: StudioGroupImageExecution) => void
}) {
  const { scopeKey, groupId, nodes, runtime, onUpdate } = input
  const readNode = (id: string) => {
    const store = useStudioUiStore.getState()
    if (store.scopeKey !== scopeKey) throw new Error('已切换画布，未提交此节点')
    const node = store.nodes.find(item => item.id === id)
    if (!node) throw new Error('节点已删除')
    if (!store.groups.some(group => group.id === groupId && group.childIds.includes(id))) {
      throw new Error('节点已移出此分组')
    }
    if (!isStudioNodeBatchExecutable(node)) throw new Error('节点已变更，无法执行图片生成')
    if (runtime.isNodeBusy(id)) throw new Error('该节点已有进行中的生成任务')
    return node
  }

  for (const entry of nodes) {
    onUpdate({ ...entry, status: 'running' })
    try {
      let node = readNode(entry.id)
      if (!runtime.canEdit || !runtime.canUseFeature('canvas.generate')) {
        throw new Error('当前账号没有画布生成权限')
      }
      if (!runtime.canMutate) throw new Error('画布协作连接尚未就绪，请稍后重试')

      if (!node.data.model?.trim()) {
        const mode = imageMode(node.data)
        const models = await canvasUserModelList({ modelType: 'image', generateMode: mode })
        node = readNode(entry.id)
        if (!node.data.model?.trim()) {
          if (imageMode(node.data) !== mode) throw new Error('参考图片已变化，请重新执行此节点')
          const available = compatibleCanvasGenerationModels(models, 'image', mode === 'image_to_image')
          const model = pickStudioComposerDefaultModel(available)
          if (!model) throw new Error(mode === 'image_to_image' ? '暂无可用的图生图模型' : '暂无可用的文生图模型')
          useStudioUiStore.getState().updateNodeData(entry.id,
            studioExplicitModelSelection('image', model, node.data.generationOptions ?? {}))
        }
      }

      let prompt = node.data.prompt ?? ''
      if (node.data.storyboardCompositionId) {
        const plan = planStudioStoryboardCompositionSubmit({ node, userPrompt: prompt })
        if ('error' in plan) throw new Error(plan.error)
        prompt = plan.finalPrompt
      }
      if (!prompt.trim()) throw new Error('请输入生成提示词')

      const result = await runtime.generateNodeResult('image', entry.id, prompt)
      if (result.status === 'blocked') throw new Error(result.reason)
      onUpdate({ ...entry, status: result.status, reason: result.status === 'accepted' ? result.reason : undefined })
    } catch (error: unknown) {
      onUpdate({ ...entry, status: 'failed', reason: canvasErrorMessage(error, '图片生成失败') })
    }
  }
}

/** 旧流程项目仍沿用原分镜生成入口。 */
export async function executeLegacyStudioGroupImages(childIds: string[]): Promise<number> {
  const store = useStudioUiStore.getState()
  const ids = listGroupExecutableNodeIds(store.nodes, childIds)
  if (!ids.length) {
    message.warning('没有可执行的节点')
    return 0
  }
  message.info(`开始整组执行（${ids.length} 个节点）`)
  let pools
  try {
    pools = await loadStudioImageSubmitPools()
  } catch {
    message.error('读取模型池失败')
    return 0
  }
  let ok = 0
  for (const id of ids) {
    try {
      if (await submitStudioImageNode(id, pools)) ok += 1
    } catch {
      // 单个失败继续
    }
  }
  if (ok) message.success(`整组执行完成：成功 ${ok}/${ids.length}`)
  else message.warning('整组执行未成功提交任何节点')
  return ok
}
