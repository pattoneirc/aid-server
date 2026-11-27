'use client'

import { useCallback, useEffect, useState } from 'react'
import type { AgentInfoVO, UserModelListItem } from '@/types/business-api'
import type { StudioMediaKind } from '@/types/studio'
import type { UserSkillDefinition } from '@/types/user-skill'
import { aidAgentList, canvasUserModelList, canvasUserModelListByFuncCodes, userModelList } from '@/utils/business/model'
import { userSkillRuntimeCatalog } from '@/utils/business/skill'
import { canvasQuoteIdentity } from '@/utils/canvas/canvasQuote'
import { useCanvasGatewayIdentity } from './useCanvasGatewayIdentity'

type CatalogState<T> = { data: T[]; loading: boolean; error: string; defaultModelCode?: string }

const modelCache = new Map<string, UserModelListItem[]>()
const funcDefaults = new Map<string, string | undefined>()
const modelInflight = new Map<string, Promise<UserModelListItem[]>>()
let modelSessionToken: string | null | undefined
let modelCanvasIdentity: string | undefined
let modelSessionGeneration = 0
let skillCache: UserSkillDefinition[] | null = null
let skillInflight: Promise<UserSkillDefinition[]> | null = null
let agentCache: AgentInfoVO[] | null = null
let agentInflight: Promise<AgentInfoVO[]> | null = null

function modelCatalogKey(mediaKind: StudioMediaKind, generateMode?: string, canvas = false): string {
  const token = typeof window === 'undefined' ? null : window.localStorage.getItem('token')
  const canvasIdentity = canvas ? canvasQuoteIdentity() : undefined
  if (token !== modelSessionToken || canvas && canvasIdentity !== modelCanvasIdentity) {
    modelSessionToken = token
    if (canvas) modelCanvasIdentity = canvasIdentity
    modelSessionGeneration += 1
    modelCache.clear()
    funcDefaults.clear()
    modelInflight.clear()
  }
  return `${modelSessionGeneration}:${canvas ? canvasIdentity : 'main'}:${mediaKind}:${generateMode ?? ''}`
}

function loadModels(mediaKind: StudioMediaKind, generateMode?: string, canvas = false): Promise<UserModelListItem[]> {
  if (process.env.NODE_ENV === 'test') return Promise.resolve([])
  const key = modelCatalogKey(mediaKind, generateMode, canvas)
  const cached = modelCache.get(key)
  if (cached) return Promise.resolve(cached)
  const running = modelInflight.get(key)
  if (running) return running
  const source = (canvas ? canvasUserModelList : userModelList)({ modelType: mediaKind, ...(generateMode ? { generateMode } : {}) })
  const request = source
    .then((items) => {
      if (!canvas || key === modelCatalogKey(mediaKind, generateMode, true)) modelCache.set(key, items)
      return items
    })
    .finally(() => { if (modelInflight.get(key) === request) modelInflight.delete(key) })
  modelInflight.set(key, request)
  return request
}

function canvasFuncCatalogKey(funcCode: string, projectId: string): string {
  return modelCatalogKey('image', `func:${projectId}:${funcCode}`, true)
}

function loadCanvasModelsByFunc(funcCode: string, projectId: string): Promise<UserModelListItem[]> {
  const normalizedFuncCode = String(funcCode || '').trim()
  const normalizedProjectId = String(projectId || '').trim()
  if (!normalizedFuncCode || !normalizedProjectId) return Promise.resolve([])
  const key = canvasFuncCatalogKey(normalizedFuncCode, normalizedProjectId)
  const cached = modelCache.get(key)
  if (cached) return Promise.resolve(cached)
  const running = modelInflight.get(key)
  if (running) return running
  const request = canvasUserModelListByFuncCodes([normalizedFuncCode], normalizedProjectId)
    .then((groups) => {
      const group = groups.find((item) => item.funcCode === normalizedFuncCode)
      const items = [...(group?.models ?? [])]
      const defaultIndex = items.findIndex((item) => item.modelCode === group?.defaultModelCode)
      if (defaultIndex > 0) items.unshift(...items.splice(defaultIndex, 1))
      if (key === canvasFuncCatalogKey(normalizedFuncCode, normalizedProjectId)) {
        funcDefaults.set(key, group?.defaultModelCode ?? undefined)
        modelCache.set(key, items)
      }
      return items
    })
    .finally(() => { if (modelInflight.get(key) === request) modelInflight.delete(key) })
  modelInflight.set(key, request)
  return request
}

function loadSkills(): Promise<UserSkillDefinition[]> {
  if (process.env.NODE_ENV === 'test') return Promise.resolve([])
  if (skillCache) return Promise.resolve(skillCache)
  if (skillInflight) return skillInflight
  skillInflight = userSkillRuntimeCatalog()
    .then((items) => {
      skillCache = items
      return items
    })
    .finally(() => { skillInflight = null })
  return skillInflight
}

function loadAgents(): Promise<AgentInfoVO[]> {
  if (process.env.NODE_ENV === 'test') return Promise.resolve([])
  if (agentCache) return Promise.resolve(agentCache)
  if (agentInflight) return agentInflight
  agentInflight = aidAgentList()
    .then((groups) => {
      agentCache = groups.flatMap((group) => group.agents ?? [])
        .filter((agent) => agent.agentCode && agent.name)
      return agentCache
    })
    .finally(() => { agentInflight = null })
  return agentInflight
}

function useCatalog<T>(
  loader: () => Promise<T[]>,
  initial: T[] = [],
  enabled = true,
  key?: string
): CatalogState<T> {
  const [state, setState] = useState<CatalogState<T> & { key?: string }>({
    key, data: initial,
    loading: enabled,
    error: ''
  })
  useEffect(() => {
    if (!enabled) return
    let active = true
    Promise.resolve().then(() => {
      if (active) setState((current) => ({ ...(current.key === key ? current : { data: [] }), key, loading: true, error: '' }))
      return loader()
    }).then((data) => {
      if (active) setState({ key, data, loading: false, error: '' })
    }).catch(() => {
      if (active) setState({ key, data: [], loading: false, error: '数据加载失败' })
    })
    return () => { active = false }
  }, [enabled, loader, key])
  return state.key === key ? state : { data: initial, loading: enabled, error: '' }
}

export function useStudioModels(
  mediaKind: StudioMediaKind = 'image',
  options?: { enabled?: boolean; generateMode?: string; canvas?: boolean }
): CatalogState<UserModelListItem> {
  const generateMode = options?.generateMode
  const canvas = options?.canvas ?? false
  const { connected } = useCanvasGatewayIdentity()
  const loader = useCallback(() => loadModels(mediaKind, generateMode, canvas), [mediaKind, generateMode, canvas])
  const key = modelCatalogKey(mediaKind, generateMode, canvas)
  const enabled = options?.enabled !== false && (!canvas || connected)
  // 连接完成的首个render也须保持loading，不能把尚未请求的空目录投影成下架。
  const catalog = useCatalog(loader, modelCache.get(key) ?? [], enabled, canvas ? `${key}:${enabled}` : undefined)
  return canvas && options?.enabled !== false && !connected
    ? { data: [], loading: true, error: '' }
    : { ...catalog, defaultModelCode: canvas && enabled ? catalog.data[0]?.modelCode : undefined }
}

/** Canvas business model pool from POST /api/user/model/listByFunc. */
export function useStudioCanvasModelsByFunc(
  funcCode: string,
  projectId: string,
  enabled = true
): CatalogState<UserModelListItem> {
  const { connected } = useCanvasGatewayIdentity()
  const normalizedFuncCode = String(funcCode || '').trim()
  const normalizedProjectId = String(projectId || '').trim()
  const key = canvasFuncCatalogKey(normalizedFuncCode, normalizedProjectId)
  const requestEnabled = enabled && connected && Boolean(normalizedFuncCode && normalizedProjectId)
  const initial = modelCache.get(key) ?? []
  const stateKey = `${key}:${requestEnabled}`
  const [state, setState] = useState<CatalogState<UserModelListItem> & { key: string }>({
    key: stateKey,
    data: initial,
    loading: requestEnabled,
    error: ''
  })

  useEffect(() => {
    if (!requestEnabled) return
    let active = true
    void Promise.resolve().then(() => {
      if (active) setState({ key: stateKey, data: modelCache.get(key) ?? [], loading: true, error: '' })
      return loadCanvasModelsByFunc(normalizedFuncCode, normalizedProjectId)
    }).then((data) => {
      if (active) setState({ key: stateKey, data, loading: false, error: '' })
    }).catch(() => {
      if (active) setState({ key: stateKey, data: [], loading: false, error: '数据加载失败' })
    })
    return () => { active = false }
  }, [key, normalizedFuncCode, normalizedProjectId, requestEnabled, stateKey])

  if (!requestEnabled) return { data: [], loading: enabled && (!connected || !normalizedProjectId), error: '' }
  return { ...(state.key === stateKey ? state : { data: initial, loading: true, error: '' }), defaultModelCode: funcDefaults.get(key) }
}

export function useStudioSkills(): CatalogState<UserSkillDefinition> {
  return useCatalog(loadSkills, skillCache ?? [])
}

export function useStudioAgents(): CatalogState<AgentInfoVO> {
  return useCatalog(loadAgents, agentCache ?? [])
}
