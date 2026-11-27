'use client'

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { StudioCanvasNode, StudioComposerRef } from '@/types/studio'
import type { CanvasProjectWorkspaceRuntime } from './useCanvasProjectWorkspace'
import { useStudioUiStore } from '@/stores/studioUi'
import { useCanvasGatewayIdentity } from './useCanvasGatewayIdentity'
import { CANVAS_QUOTE_TIMEOUT_MS, canvasQuoteIdentity } from '@/utils/canvas/canvasQuote'
import { studioNodeToComposerRef } from '@/utils/studio/studioReferencePicker'
import { canvasErrorMessage } from '@/utils/canvas/canvasErrorMessage'

function inputSignature(node: StudioCanvasNode, nodes: StudioCanvasNode[]) {
  return JSON.stringify([node.data.kind, node.data.mediaUrl, node.data.imageDescribe, node.data.composerRefs,
    (node.data.composerRefs ?? []).flatMap(ref => ref.nodeId ? [ref.nodeId] : [])
      .concat(node.data.imageDescribe ? [node.data.imageDescribe.sourceNodeId] : [])
      .map(id => { const source = nodes.find(item => item.id === id); return [id, source?.data.kind, source?.data.mediaUrl, source?.data.documentContent, source?.data.prompt] })])
}

/** Prepare only the current authorized references; never generate media or apply late results to another scope. */
export function useCanvasQuoteReferencePreparation(node: StudioCanvasNode, runtime: CanvasProjectWorkspaceRuntime | null,
  options?: { onlySelf?: boolean; ownerNodeId?: string; auto?: boolean }) {
  const { identity, connected } = useCanvasGatewayIdentity()
  const scopeKey = useStudioUiStore(state => state.scopeKey)
  const ownerNodeId = options?.ownerNodeId ?? node.id
  const key = JSON.stringify([identity, scopeKey, node.id, ownerNodeId, Boolean(options?.onlySelf)])
  const active = useRef(key)
  active.current = key
  const owner = useRef<{ key: string; active: boolean; isCurrent?: () => boolean } | null>(null)
  const [state, setState] = useState({ key: '', signature: '', busy: false, error: '', revision: 0 })
  useEffect(() => () => { if (owner.current?.key === key) owner.current.active = false }, [key])
  const prepare = useCallback(async () => {
    if (!runtime || !connected || !runtime.canEdit || !runtime.canMutate || owner.current?.isCurrent?.()) return
    const store = useStudioUiStore.getState()
    const original = store.nodes.find(item => item.id === node.id)
    if (!original) return
    let signature = inputSignature(original, store.nodes)
    if (owner.current) owner.current.active = false
    const token: NonNullable<typeof owner.current> = { key, active: true }
    owner.current = token
    const isCurrent = () => {
      const latest = useStudioUiStore.getState(), target = latest.nodes.find(item => item.id === node.id)
      return token.active && active.current === key && canvasQuoteIdentity() === identity && latest.scopeKey === scopeKey
        && latest.activeNodeId === ownerNodeId
        && Boolean(target && inputSignature(target, latest.nodes) === signature)
    }
    token.isCurrent = isCurrent
    setState(current => ({ key, signature, busy: true, error: '', revision: current.revision }))
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
      token.active = false
      reject(new Error('补齐引用超时，请重试'))
    }, CANVAS_QUOTE_TIMEOUT_MS) })
    try {
      const work = async () => {
        const refs: StudioComposerRef[] = []
        if ((original.data.kind === 'image' || options?.onlySelf) && original.data.mediaUrl) refs.push(studioNodeToComposerRef(original))
        if (!options?.onlySelf && original.data.imageDescribe) {
          const source = store.nodes.find(item => item.id === original.data.imageDescribe?.sourceNodeId)
          if (!source) throw new Error('原图已失效，请重新选择')
          refs.push(studioNodeToComposerRef(source))
        }
        refs.push(...(options?.onlySelf || original.data.imageDescribe ? [] : original.data.composerRefs ?? []).filter(ref =>
          original.data.kind === 'image' ? ref.mediaKind === 'image'
            : original.data.kind === 'video' ? ['image', 'video', 'audio'].includes(ref.mediaKind)
              : !(ref.nodeId && ref.mediaKind === 'text')))
        const prepared = new Map<string, Awaited<ReturnType<CanvasProjectWorkspaceRuntime['resolveResourceReference']>>>()
        for (const ref of refs) {
          if (!isCurrent()) throw new Error('画布或引用已变化，请重新准备')
          const sourceKey = JSON.stringify([ref.kind, ref.nodeId, ref.assetId, ref.personalAudioAssetId, ref.mediaKind])
          const resource = prepared.get(sourceKey) ?? await runtime.resolveResourceReference(ref, { isCurrent })
          prepared.set(sourceKey, resource)
        }
        if (!isCurrent()) throw new Error('画布或引用已变化，请重新准备')
        const target = useStudioUiStore.getState().nodes.find(item => item.id === node.id)!
        const references = target.data.composerRefs?.map(ref => {
          const resource = prepared.get(JSON.stringify([ref.kind, ref.nodeId, ref.assetId, ref.personalAudioAssetId, ref.mediaKind]))
          return resource ? { ...ref, assetId: String(resource.resourceId), previewUrl: resource.resourceUrl,
            kind: ref.kind === 'asset' || ref.kind === 'library' ? 'upload' as const : ref.kind } : ref
        })
        // 一个原子本地更新，不覆盖提示词和其他编辑；保存沿用现有权限/CAS。
        useStudioUiStore.getState().updateNodeData(node.id, {
          composerRefs: references,
          canvasResourceIds: [...new Set([...(target.data.canvasResourceIds ?? []), ...[...prepared.values()].map(resource => String(resource.resourceId))])]
        })
        // 只接纳本次原子引用更新；之后的用户编辑仍使本次结果失效。
        const updated = useStudioUiStore.getState()
        signature = inputSignature(updated.nodes.find(item => item.id === node.id)!, updated.nodes)
        if (!isCurrent()) throw new Error('画布或引用已变化，请重新准备')
        await runtime.saveNow()
        if (!isCurrent()) throw new Error('画布或引用已变化，请重新准备')
      }
      await Promise.race([work(), deadline])
      if (isCurrent()) {
        setState(current => ({ key, signature, busy: false, error: '', revision: current.revision + 1 }))
      }
    } catch (error) {
      if (owner.current === token && active.current === key && canvasQuoteIdentity() === identity) {
        setState(current => ({ key, signature, busy: false, error: canvasErrorMessage(error, '补齐引用失败，请重试'), revision: current.revision }))
      }
    } finally {
      clearTimeout(timer)
      token.active = false
      if (owner.current === token) owner.current = null
    }
  }, [connected, identity, key, node.id, options?.onlySelf, ownerNodeId, runtime, scopeKey])
  const latest = useStudioUiStore.getState()
  const target = latest.nodes.find(item => item.id === node.id)
  const sameInput = state.key === key && Boolean(target && inputSignature(target, latest.nodes) === state.signature)
  const automaticKey = key + inputSignature(node, latest.nodes)
  const automaticAttempt = useRef('')
  const prepareRef = useRef(prepare)
  useLayoutEffect(() => { prepareRef.current = prepare }, [prepare])
  const automaticallyPrepare = Boolean(options?.auto && connected && runtime?.canEdit && runtime.canMutate && target && latest.activeNodeId === ownerNodeId)
  useEffect(() => {
    if (!automaticallyPrepare || automaticAttempt.current === automaticKey) return
    automaticAttempt.current = automaticKey
    void prepareRef.current()
  }, [automaticallyPrepare, automaticKey])
  return { prepare, busy: state.key === key && state.busy && Boolean(owner.current?.isCurrent?.()),
    error: sameInput ? state.error : '', revision: state.key === key ? state.revision : 0 }
}
