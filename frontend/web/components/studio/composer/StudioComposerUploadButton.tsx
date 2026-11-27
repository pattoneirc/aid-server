'use client'

import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import { LoadingOutlined, PaperClipOutlined } from '@ant-design/icons'
import { message } from 'antd'
import { StudioCanvasTooltip } from '@/components/studio/canvas/StudioCanvasTooltip'
import { useStudioUiStore } from '@/stores/studioUi'
import type { StudioCanvasNode, StudioComposerRef } from '@/types/studio'
import { uploadImageToOssWithToast, uploadVideoToOssWithToast } from '@/utils/ossUpload'
import { appendComposerRefInstance, replaceStudioVideoReference } from '@/utils/studio/studioComposerRefs'
import { useCanvasProjectRuntime } from '@/components/studio/free/CanvasProjectRuntimeContext'

export function StudioComposerUploadButton({ node, replaceRef }: {
  node: StudioCanvasNode
  replaceRef?: Pick<StudioComposerRef, 'id' | 'assetId' | 'previewUrl'>
}) {
  const canvasRuntime = useCanvasProjectRuntime()
  const inputRef = useRef<HTMLInputElement>(null)
  const inFlight = useRef(false)
  const mounted = useRef(true)
  const updateNodeData = useStudioUiStore((state) => state.updateNodeData)
  const [progress, setProgress] = useState<number | null>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const accept = replaceRef ? 'image/jpeg,image/png,image/webp' : node.data.kind === 'video'
    ? 'image/jpeg,image/png,image/webp,video/mp4,video/webm,video/quicktime'
    : node.data.kind === 'image'
      ? 'image/jpeg,image/png,image/webp'
      : '.txt,.md,.markdown,text/plain,text/markdown'

  const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || inFlight.current || canvasRuntime && !canvasRuntime.canMutate) return
    const scopeKey = useStudioUiStore.getState().scopeKey
    const targetId = node.id, targetKind = node.data.kind
    const currentTarget = () => {
      const store = useStudioUiStore.getState()
      return store.scopeKey === scopeKey ? store.nodes.find(item => item.id === targetId && item.data.kind === targetKind) : undefined
    }
    inFlight.current = true
    setProgress(0)
    try {
      if (targetKind !== 'image' && targetKind !== 'video') {
        if (canvasRuntime && targetKind === 'text') {
          await canvasRuntime.importNodeText(targetId, file)
        } else {
          if (file.size > 2 * 1024 * 1024) throw new Error('文本文件不能超过 2MB')
          const content = (await file.text()).trim()
          if (!content) throw new Error('文件没有可导入的文本')
          const target = currentTarget()
          if (!target) return
          if (target.data.prompt !== node.data.prompt || target.data.documentContent !== node.data.documentContent) {
            throw new Error('文本已修改，导入结果未覆盖当前内容，请重新导入')
          }
          if (canvasRuntime) updateNodeData(targetId, { documentContent: content, mediaKind: 'text', status: 'success' })
          else {
            const existing = target.data.status === 'empty' ? '' : target.data.prompt
            const prompt = `${existing}\n${content}`.trim()
            updateNodeData(targetId, { prompt, resultSummary: prompt, mediaKind: 'text', status: 'success' })
          }
        }
        return
      }
      const mediaKind = file.type.startsWith('video/') ? 'video' : 'image'
      const resource = canvasRuntime
        ? await canvasRuntime.uploadResource(file, mediaKind === 'video' ? 'VIDEO' : 'IMAGE')
        : null
      const reportProgress = (value: number) => { if (mounted.current && currentTarget()) setProgress(value) }
      const previewUrl = canvasRuntime ? resource?.resourceUrl : (mediaKind === 'video'
        ? await uploadVideoToOssWithToast(file, reportProgress)
        : await uploadImageToOssWithToast(file, reportProgress))
      if (!previewUrl) throw new Error('素材上传未返回有效地址，请重试')
      const target = currentTarget()
      if (!target) return
      const base: Omit<StudioComposerRef, 'id'> = {
        kind: 'upload',
        ...(resource ? { assetId: String(resource.resourceId) } : {}),
        title: file.name,
        mediaKind,
        previewUrl,
        sourceKey: `upload:${file.name}:${file.lastModified}`,
        channel: 'attachment'
      }
      if (replaceRef) {
        const refs = target.data.composerRefs ?? []
        const previous = refs.find(ref => ref.id === replaceRef.id)
        if (!previous || previous.nodeId || previous.assetId !== replaceRef.assetId
          || previous.previewUrl !== replaceRef.previewUrl) {
          throw new Error('这张参考图已变化，请重新选择')
        }
        updateNodeData(target.id, {
          composerRefs: refs.map(ref => ref === previous ? { ...ref, ...base } : ref),
          ...(resource ? { canvasResourceIds: [...new Set([
            ...(target.data.canvasResourceIds ?? []).map(String), String(resource.resourceId)
          ])] } : {})
        })
        return
      }
      // Merge with the current refs/options, including edits made during upload.
      const appended = appendComposerRefInstance(target.data.composerRefs, base)
      if (targetKind === 'video') {
        const replacement = replaceStudioVideoReference(
          appended.refs,
          target.data.generationOptions ?? {},
          appended.ref
        )
        updateNodeData(node.id, {
          composerRefs: replacement.composerRefs,
          generationOptions: replacement.generationOptions,
          ...(resource ? { canvasResourceIds: [...new Set([...(target.data.canvasResourceIds || []).map(String), String(resource.resourceId)])] } : {})
        })
      } else {
        updateNodeData(node.id, {
          composerRefs: appended.refs,
          ...(resource ? { canvasResourceIds: [...new Set([...(target.data.canvasResourceIds || []).map(String), String(resource.resourceId)])] } : {})
        })
      }
    } catch (error: unknown) {
      if (currentTarget()) message.error((error as Error)?.message || '素材上传失败')
    } finally {
      inFlight.current = false
      if (mounted.current) setProgress(null)
    }
  }

  return (
    <>
      {replaceRef ? <button type="button"
        disabled={progress !== null || !!canvasRuntime && !canvasRuntime.canMutate}
        onClick={() => inputRef.current?.click()}>{progress == null ? '更换参考图' : '上传中…'}</button> :
      <StudioCanvasTooltip title={canvasRuntime && !canvasRuntime.canMutate ? '当前画布不可编辑，请检查成员权限或协作连接' : progress == null ? '上传素材' : `上传中 ${Math.round(progress)}%`}>
        <button type="button" className="studio-composer__upload" disabled={progress !== null || !!canvasRuntime && !canvasRuntime.canMutate} onClick={() => inputRef.current?.click()} aria-label="上传素材">
          {progress == null ? <PaperClipOutlined /> : <LoadingOutlined spin />}
        </button>
      </StudioCanvasTooltip>}
      <input ref={inputRef} hidden type="file" accept={accept} onChange={(event) => { void handleFile(event) }} />
    </>
  )
}
