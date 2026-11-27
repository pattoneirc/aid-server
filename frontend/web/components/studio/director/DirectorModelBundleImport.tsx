'use client'

import { digestSha256Hex } from '@/utils/sha256'
import { useEffect, useRef, useState } from 'react'
import { canvasQuoteIdentity } from '@/utils/canvas/canvasQuote'
import { Button, Modal } from 'antd'
import type { DirectorModelAssetKind, DirectorModelAsset } from '@/types/studio'
import { useCanvasProjectRuntime } from '@/components/studio/free/CanvasProjectRuntimeContext'
import { StudioCanvasDropdownPopover } from '@/components/studio/canvas/StudioCanvasDropdownMenu'
import { canvasPublicationModelUpload } from '@/utils/canvas/canvasPublicationApi'
import { canvasOperationId } from '@/utils/canvas/canvasId'
import { canvasRetryLedger } from '@/utils/canvas/canvasRetryLedger'
import { loadCanvasModelBundle } from '@/utils/canvas/canvasModelBundle'
import { disposeDirectorObjectTree } from './directorRuntimeResources'
import { apiErrorMessage } from '@/utils/apiError'
import { useStudioUiStore } from '@/stores/studioUi'
import { studioId } from '@/utils/studio/studioGraph'
import { StudioCanvasTooltip } from '@/components/studio/canvas/StudioCanvasTooltip'

export function DirectorModelBundleImport({
  kind,
  onImport,
  sceneId,
}: {
  kind: DirectorModelAssetKind
  sceneId: string
  onImport: (asset: DirectorModelAsset) => void
}) {
  const runtime = useCanvasProjectRuntime(),
    [open, setOpen] = useState(false),
    [files, setFiles] = useState<Array<{ path: string; file: File }>>([]),
    [rootPath, setRootPath] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null),
    folder = useRef<HTMLInputElement>(null),
    lock = useRef(false),
    scope = useRef('')
  const mounted = useRef(true),
    currentScene = useRef(sceneId),
    openedScene = useRef('')
  currentScene.current = sceneId
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const roots = files.filter((f) => /\.(glb|gltf|fbx|obj)$/i.test(f.path))
  function pick(selected: FileList | null) {
    if (!selected) return
    const items = Array.from(selected).map((file) => ({
      file,
      path: file.webkitRelativePath
        ? file.webkitRelativePath.split('/').slice(1).join('/')
        : file.name,
    }))
    setFiles(items)
    setRootPath(
      items.find((f) => /\.(glb|gltf|fbx|obj)$/i.test(f.path))?.path || '',
    )
    setError('')
  }
  async function submit() {
    if (lock.current || !runtime?.project || !rootPath) return
    lock.current = true
    setBusy(true)
    setError('')
    const workspaceId = runtime.project.workspace.workspaceId,
      currentScope = useStudioUiStore.getState().scopeKey
    const identity = canvasQuoteIdentity()
    const current = () =>
      mounted.current &&
      openedScene.current === currentScene.current &&
      canvasQuoteIdentity() === identity &&
      scope.current === currentScope &&
      useStudioUiStore.getState().scopeKey === currentScope &&
      runtime.project?.workspace.workspaceId === workspaceId
    try {
      if (
        files.length > 256 ||
        files.some((f) => f.file.size > 64 * 1024 * 1024) ||
        files.reduce((s, f) => s + f.file.size, 0) > 256 * 1024 * 1024
      )
        throw new Error('模型最多256份文件，单文件64MiB，整包256MiB')
      const hashes = []
      for (const item of files) {
        const hash = await digestSha256Hex(await item.file.arrayBuffer())
        hashes.push([item.path, hash])
      }
      if (!current()) throw new Error('画布已切换')
      const fingerprint = JSON.stringify([workspaceId, rootPath, hashes]),
        operationId = canvasRetryLedger.getOrCreate(
          'model-bundle:' + workspaceId,
          fingerprint,
          () => canvasOperationId('model-bundle'),
        )
      const resource = await canvasPublicationModelUpload(
        workspaceId,
        operationId,
        'MODEL',
        rootPath,
        files,
      )
      if (!current()) return
      const parsed = await loadCanvasModelBundle(resource.bundle)
      disposeDirectorObjectTree(parsed)
      if (!current()) return
      const root = resource.bundle.files.find(
        (f) => f.path === resource.bundle.rootPath,
      )
      if (!root) throw new Error('模型根资源缺失')
      onImport({
        id: studioId('director-model'),
        name: rootPath
          .split('/')
          .pop()!
          .replace(/\.[^.]+$/, ''),
        fileName: rootPath.split('/').pop()!,
        url: root.resourceUrl,
        format: resource.bundle.format,
        kind,
        source: 'local',
        resourceId: resource.resourceId,
        bundle: resource.bundle,
        byteSize: files.find((f) => f.path === rootPath)!.file.size,
        createdAt: new Date().toISOString(),
      })
      canvasRetryLedger.clear('model-bundle:' + workspaceId, fingerprint)
      setOpen(false)
      setFiles([])
    } catch (e) {
      if (current())
        setError(apiErrorMessage(e, '完整模型登记失败，请保留原文件重试'))
    } finally {
      lock.current = false
      if (mounted.current) setBusy(false)
    }
  }
  if (!runtime) return null
  return (
    <>
      <StudioCanvasTooltip
        title={!runtime.canEdit ? '当前画布没有编辑权限' : undefined}
      >
        <Button
          onClick={() => {
            scope.current = useStudioUiStore.getState().scopeKey
            openedScene.current = sceneId
            setOpen(true)
          }}
          disabled={!runtime.canEdit}
        >
          导入完整模型与依赖
        </Button>
      </StudioCanvasTooltip>
      <Modal
        open={open}
        title="导入完整模型"
        centered
        className="director-recording-modal"
        onCancel={() => {
          if (!busy) setOpen(false)
        }}
        mask={{ closable: !busy }}
        closable={!busy}
        footer={
          <Button
            type="primary"
            disabled={!rootPath || busy}
            loading={busy}
            onClick={() => void submit()}
          >
            登记并导入模型
          </Button>
        }
      >
        <p>
          支持GLB、GLTF、FBX、OBJ。请同时选择根模型、缓冲区、纹理和MTL文件，或选择完整文件夹。保留原文件字节和目录关系。
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button disabled={busy} onClick={() => input.current?.click()}>
            选择文件
          </Button>
          <Button disabled={busy} onClick={() => folder.current?.click()}>
            选择文件夹
          </Button>
        </div>
        <input
          hidden
          multiple
          type="file"
          ref={input}
          onChange={(e) => {
            pick(e.target.files)
            e.target.value = ''
          }}
        />
        <input
          hidden
          multiple
          type="file"
          ref={(node) => {
            folder.current = node
            node?.setAttribute('webkitdirectory', '')
          }}
          onChange={(e) => {
            pick(e.target.files)
            e.target.value = ''
          }}
        />
        <p>已选择 {files.length} 份文件</p>
        {roots.length > 0 && (
          <StudioCanvasDropdownPopover
            activeKey={rootPath}
            items={roots.map((f) => ({ key: f.path, label: f.path }))}
            onSelect={setRootPath}
            ariaLabel="选择模型根文件"
            trigger={
              <Button disabled={busy}>{rootPath || '选择根模型'}</Button>
            }
          />
        )}
        {error && <p role="alert">{error}</p>}
      </Modal>
    </>
  )
}
