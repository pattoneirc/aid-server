'use client'

/* eslint-disable @next/next/no-img-element -- Studio 需预览 blob/data URL，静态 image loader 不适用。 */
import { useMemo, useRef, useState } from 'react'
import { Button, Modal, message } from 'antd'
import { CloudUploadOutlined, FolderOpenOutlined, PictureOutlined } from '@ant-design/icons'
import { HomeSegmented } from '@/components/home/theme/HomeSegmented'
import './studio-library-modals.css'
import { PersonalVoiceLibrary } from '@/components/steps/PersonalVoiceLibrary'
import { CaptureVideoFrameModal } from '@/components/steps/CaptureVideoFrameModal'
import type { StudioCanvasNode, StudioComposerRef, StudioSavedAsset } from '@/types/studio'
import { createTrackedObjectUrl } from '@/utils/objectUrl'
import { useCanvasProjectRuntime } from '@/components/studio/free/CanvasProjectRuntimeContext'

type LibraryTab = 'image' | 'audio' | 'video' | 'frame' | 'likeness' | 'personalVoice'

const LIBRARY_TAB_ITEMS: Array<{ value: LibraryTab; label: string }> = [
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频 / 配音' },
  { value: 'personalVoice', label: '我的音色' },
  { value: 'frame', label: '截取帧' },
  { value: 'likeness', label: '真人真像' }
]

export function StudioAssetLibraryModal({
  open,
  onOpenChange,
  nodes,
  assets,
  projectId,
  episodeId,
  onSelect,
  variant = 'free',
  allowedTabs
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  nodes: StudioCanvasNode[]
  assets: StudioSavedAsset[]
  projectId: number
  episodeId?: number | null
  onSelect: (ref: StudioComposerRef) => void
  variant?: 'free' | 'flow'
  allowedTabs?: LibraryTab[]
}) {
  const canvasRuntime = useCanvasProjectRuntime()
  const [selectedTab, setTab] = useState<LibraryTab>('image')
  const [captureOpen, setCaptureOpen] = useState(false)
  const [savedOnly, setSavedOnly] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const tabItems = LIBRARY_TAB_ITEMS.filter(item => item.value === 'personalVoice'
    ? Boolean(canvasRuntime) && (!allowedTabs?.length || allowedTabs.includes('audio'))
    : !allowedTabs?.length || allowedTabs.includes(item.value))
  const tab = tabItems.some((item) => item.value === selectedTab) ? selectedTab : tabItems[0].value
  const mediaKind = tab === 'audio' ? 'audio' : tab === 'video' ? 'video' : 'image'
  const candidates = useMemo(() => {
    const savedCandidates = assets.filter((asset) => asset.mediaKind === mediaKind || asset.kind === mediaKind)
    const nodeCandidates = nodes.filter((node) => node.data.mediaUrl && node.data.mediaKind === mediaKind).map((node) => ({
      id: node.id,
      title: node.data.title,
      mediaUrl: node.data.mediaUrl!,
      mediaKind: node.data.mediaKind,
      kind: node.data.kind,
      sourceNodeId: node.id,
      createdAt: node.data.createdAt
    }))
    const all = savedOnly ? savedCandidates : [...savedCandidates, ...nodeCandidates]
    return [...new Map(all.map((item) => [`${item.sourceNodeId}:${item.mediaUrl}`, item])).values()]
  }, [assets, mediaKind, nodes, savedOnly])

  const addRef = (ref: StudioComposerRef) => {
    onSelect(ref)
    onOpenChange(false)
  }
  return (
    <>
      <Modal
        open={open}
        title={
          <span className="studio-asset-library-modal__title">
            <strong>项目资料库</strong>
            <small>{variant === 'flow' ? '作品资产' : '画布资产'}</small>
          </span>
        }
        footer={null}
        width="min(960px, calc(100vw - 32px))"
        centered
        className="studio-asset-library-modal--canvas"
        onCancel={() => onOpenChange(false)}
      >
        <div className="studio-asset-library-modal__tab-scroll">
          <HomeSegmented
            value={tab}
            options={tabItems}
            onChange={setTab}
            ariaLabel="资料类型"
            className="flow-segmented studio-asset-library-modal__tabs"
          />
        </div>
        <input
          ref={fileRef}
          hidden
          type="file"
          accept={tab === 'audio' ? 'audio/*' : tab === 'video' ? 'video/*' : 'image/*'}
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (!file) return
            event.target.value = ''
            void (async () => {
              try {
                const resource = canvasRuntime
                  ? await canvasRuntime.uploadResource(file, mediaKind === 'audio' ? 'AUDIO' : mediaKind === 'video' ? 'VIDEO' : 'IMAGE')
                  : null
                addRef({
                  id: `upload:${file.name}:${file.lastModified}`,
                  kind: tab === 'likeness' ? 'likeness' : 'upload',
                  ...(resource ? { assetId: String(resource.resourceId) } : {}),
                  title: file.name,
                  mediaKind,
                  previewUrl: resource?.resourceUrl || createTrackedObjectUrl(file)
                })
              } catch (error: unknown) {
                message.error((error as Error)?.message || '素材上传失败')
              }
            })()
          }}
        />
        <div className="studio-asset-library-modal__content">
          {tab === 'personalVoice' ? (open && <PersonalVoiceLibrary onSelect={voice => addRef({
            id: 'personal-audio:' + voice.id,
            kind: 'asset',
            personalAudioAssetId: String(voice.id),
            mediaKind: 'audio',
            title: voice.assetTitle,
            previewUrl: voice.audioUrl
          })} />) : tab === 'likeness' && !candidates.length ? (
            <div className="studio-asset-library-modal__empty">上传一张清晰正面照片，作为人物真像参考</div>
          ) : tab === 'frame' ? (
            <div className="studio-asset-library-modal__empty">从画布视频或项目视频中截取画面，作为图片参考</div>
          ) : candidates.length ? (
            <div className="studio-asset-library-modal__grid">
            {candidates.map((item) => (
              <button key={`${item.sourceNodeId}:${item.id}`} type="button" onClick={() => {
                const canvasSource = canvasRuntime && nodes.some((node) => node.id === item.sourceNodeId)
                addRef({
                  id: canvasSource ? `node:${item.sourceNodeId}` : `asset:${item.id}`,
                  kind: canvasSource ? 'node' : 'asset',
                  ...(canvasSource ? { nodeId: item.sourceNodeId } : { assetId: item.id }),
                  title: item.title,
                  mediaKind,
                  previewUrl: item.mediaUrl
                })
              }}>
                {mediaKind === 'image'
                  ? <img src={item.mediaUrl} alt="" />
                  : mediaKind === 'video'
                    ? <video src={item.mediaUrl} muted preload="metadata" />
                    : <i>♫</i>}
                <span>{item.title}</span>
              </button>
            ))}
            </div>
          ) : <div className="studio-asset-library-modal__empty">当前项目暂无可用素材</div>}
        </div>
        {tab !== 'personalVoice' && <footer className="studio-asset-library-modal__actions">
          <Button className={savedOnly ? 'is-active' : ''} icon={<FolderOpenOutlined />} onClick={() => setSavedOnly((value) => !value)}>项目资产 / 历史生成</Button>
          {tab === 'frame' ? (
            <Button icon={<PictureOutlined />} onClick={() => setCaptureOpen(true)}>截取视频帧</Button>
          ) : (
            <Button icon={<CloudUploadOutlined />} onClick={() => fileRef.current?.click()}>本地上传</Button>
          )}
        </footer>}
      </Modal>
      <CaptureVideoFrameModal
        open={captureOpen}
        projectId={projectId}
        episodeId={episodeId}
        onOpenChange={setCaptureOpen}
        onCaptured={(frame) => {
          addRef({
            id: `frame:${frame.sourceVideoId ?? 'upload'}:${frame.capturedAtMs}`,
            kind: 'frame',
            title: frame.name,
            mediaKind: 'image',
            previewUrl: frame.url
          })
          setCaptureOpen(false)
        }}
      />
    </>
  )
}
