/** AI 模型与智能体域：模型列表、按功能编码查询可用模型、智能体分组列表。 */
import { request } from '~/utils/api'
import { canvasApiPost } from '~/utils/canvas/canvasApiClient'
import { CANVAS_QUOTE_TIMEOUT_MS, canvasQuoteIdentity } from '@/utils/canvas/canvasQuote'
import { normalizeListByFuncGroups } from '~/utils/modelListByFuncBatch'
import { modelSupportsCapability } from '~/utils/modelCapability'
import {
  unwrap,
  stableRequestKey,
  runListDedupe,
  type ListBurstSlot
} from '~/utils/business/shared'
import type {
  ApiEnvelope,
  UserModelListByFuncRequest,
  AidAgentListRequest,
  AgentListGroupVO,
  UserModelListItem,
  UserModelListByFuncGroupVO,
  UserModelListRequest
} from '~/types/business-api'

const modelListByFuncInflight = new Map<string, Promise<UserModelListByFuncGroupVO[]>>()
const modelListByFuncBurst: ListBurstSlot<UserModelListByFuncGroupVO[]> = { current: null }

const modelListInflight = new Map<string, Promise<UserModelListItem[]>>()
const modelListBurst: ListBurstSlot<UserModelListItem[]> = { current: null }

/** Composer 会因节点切换重新挂载；模型目录按请求键做必要的短时复用。 */
const MODEL_CATALOG_BURST_MS = 30_000

const aidAgentListInflight = new Map<string, Promise<AgentListGroupVO[]>>()
const aidAgentListBurst: ListBurstSlot<AgentListGroupVO[]> = { current: null }

let modelSessionToken: string | undefined
let modelSessionGeneration = 0
function modelRequestKey(body: unknown): string {
  const token = typeof window === 'undefined' ? '' : window.localStorage.getItem('token') || ''
  if (token !== modelSessionToken) {
    modelSessionToken = token
    modelSessionGeneration++
    modelListBurst.current = null
    modelListByFuncBurst.current = null
  }
  return `${modelSessionGeneration}:${stableRequestKey(body)}`
}

/** AI 模型列表：POST /api/user/model/list */
export async function userModelList(body: UserModelListRequest = {}): Promise<UserModelListItem[]> {
  const key = modelRequestKey(body)
  return runListDedupe(key, modelListInflight, modelListBurst, async () => {
    const res = await request.post<ApiEnvelope<UserModelListItem[]>>('/api/user/model/list', body)
    const data = unwrap(res)
    return Array.isArray(data) ? data : []
  }, MODEL_CATALOG_BURST_MS)
}

/** 自由画布模型必须与画布服务的能力配置同源，不能混用主站模型目录。 */
export async function canvasUserModelList(body: UserModelListRequest = {}, force = false): Promise<UserModelListItem[]> {
  const poolCodes = canvasCatalogPools(body)
  if (poolCodes.length > 0) {
    const groups = await canvasUserModelListByFuncCodes(poolCodes, undefined, force)
    const seen = new Set<string>()
    const videoCapability = body.modelType === 'video' ? body.generateMode?.trim().toLowerCase().replaceAll('-', '_') : undefined
    return groups.flatMap(({ models, defaultModelCode }) => {
      const ordered = [...(models ?? [])]
      const index = ordered.findIndex(model => model.modelCode === defaultModelCode)
      if (index > 0) ordered.unshift(...ordered.splice(index, 1))
      return ordered.filter(model => {
        if (videoCapability && !modelSupportsCapability(model, videoCapability)) return false
        if (seen.has(model.modelCode)) return false
        seen.add(model.modelCode)
        return true
      })
    })
  }
  const identity = canvasQuoteIdentity()
  const key = `${identity}:${modelRequestKey(body)}`
  return runListDedupe(key, modelListInflight, modelListBurst, async () => {
    const response = await canvasApiPost<UserModelListItem[]>('/api/user/model/list', body, { requestTimeoutMs: CANVAS_QUOTE_TIMEOUT_MS })
    if (canvasQuoteIdentity() !== identity) throw new Error('画布账号或连接已变化，请重新读取模型')
    const data = unwrap(response)
    return Array.isArray(data) ? data : []
  }, force ? 0 : MODEL_CATALOG_BURST_MS)
}

function canvasCatalogPools({ modelType, generateMode }: UserModelListRequest): string[] {
  const mode = generateMode?.trim().toLowerCase().replaceAll('-', '_')
  if (modelType === 'text' && (!mode || mode === 'text')) return ['canvas.text.generate']
  if (modelType === 'video') return ['canvas.video.generate']
  if (modelType !== 'image') return []
  if (!mode) return ['canvas.image.text_to_image', 'canvas.image.image_to_image']
  if (mode === 'text_to_image' || mode === 'image_to_image') return [`canvas.image.${mode}`]
  if (mode === 'image_upscale') return ['canvas.image.upscale']
  return []
}

/** 按多个功能编码批量查询模型列表：POST /api/user/model/listByFunc */
export async function userModelListByFuncCodes(
  funcCodes: readonly string[],
  scope?: Pick<UserModelListByFuncRequest, 'projectId' | 'episodeId'>
): Promise<UserModelListByFuncGroupVO[]> {
  const codes = [...new Set(funcCodes.map((c) => String(c || '').trim()).filter(Boolean))]
  if (!codes.length) return []
  const body: UserModelListByFuncRequest = { funcCodes: codes }
  const projectId = Number(scope?.projectId)
  if (Number.isFinite(projectId) && projectId > 0) {
    body.projectId = projectId
    if (scope?.episodeId != null && Number.isFinite(Number(scope.episodeId))) {
      body.episodeId = Number(scope.episodeId)
    }
  }
  // 请求体保留业务优先级；仅请求键归一化 funcCodes 顺序以合并同集合并发调用。
  const key = modelRequestKey({ ...body, funcCodes: [...codes].sort() })
  return runListDedupe(key, modelListByFuncInflight, modelListByFuncBurst, async () => {
    const res = await request.post<ApiEnvelope<UserModelListByFuncGroupVO[] | UserModelListItem[]>>(
      '/api/user/model/listByFunc',
      body
    )
    return normalizeListByFuncGroups(unwrap(res), codes)
  }, MODEL_CATALOG_BURST_MS)
}

/** Canvas gateway business pool; project IDs remain strings to preserve Long precision. */
export async function canvasUserModelListByFuncCodes(funcCodes: readonly string[], projectId?: string, force = false): Promise<UserModelListByFuncGroupVO[]> {
  const codes = [...new Set(funcCodes.map((code) => code.trim()).filter(Boolean))]
  if (!codes.length) return []
  const body = { funcCodes: codes, ...(projectId ? { projectId } : {}) }
  const identity = canvasQuoteIdentity()
  const key = `${identity}:${modelRequestKey({ ...body, funcCodes: [...codes].sort() })}`
  return runListDedupe(key, modelListByFuncInflight, modelListByFuncBurst, async () => {
    const response = await canvasApiPost<UserModelListByFuncGroupVO[] | UserModelListItem[]>('/api/user/model/listByFunc', body, { requestTimeoutMs: CANVAS_QUOTE_TIMEOUT_MS })
    if (canvasQuoteIdentity() !== identity) throw new Error('画布账号或连接已变化，请重新读取模型')
    return normalizeListByFuncGroups(unwrap(response), codes)
  }, force ? 0 : MODEL_CATALOG_BURST_MS)
}

/** 按功能编码查询可用模型列表：POST /api/user/model/listByFunc（v2.34.0） */
export async function userModelListByFunc(
  funcCode: string,
  scope?: Pick<UserModelListByFuncRequest, 'projectId' | 'episodeId'>
): Promise<UserModelListItem[]> {
  const normalized = String(funcCode || '').trim()
  if (!normalized) return []
  const groups = await userModelListByFuncCodes([normalized], scope)
  // 专业版可能把 main_storyboard_video 重映射为 multi_pro，按首个非空分组取模型
  const hit =
    groups.find((g) => String(g.funcCode || '').trim() === normalized) ||
    groups.find((g) => Array.isArray(g.models) && g.models.length > 0)
  return Array.isArray(hit?.models) ? hit!.models! : []
}

/** C 端：按业务分类分组查询启用智能体列表 POST /aid/agent/list */
export async function aidAgentList(body?: AidAgentListRequest): Promise<AgentListGroupVO[]> {
  const payload = body ?? {}
  const key = stableRequestKey(payload)
  return runListDedupe(key, aidAgentListInflight, aidAgentListBurst, async () => {
    const res = await request.post<ApiEnvelope<AgentListGroupVO[]>>('/aid/agent/list', payload)
    const data = unwrap(res)
    return Array.isArray(data) ? data : []
  })
}
