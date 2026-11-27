'use client'

import { StudioCanvasPopover } from '@/components/studio/canvas/StudioCanvasPopover'
import { StudioComposerReferenceMentionButton } from './StudioComposerReferenceMentionButton'
import {
  CloseOutlined,
  FileImageOutlined,
  FileTextOutlined,
  PlayCircleOutlined
} from '@ant-design/icons'
import { useStudioUiStore } from '@/stores/studioUi'
import type { StudioComposerRef, StudioMediaKind } from '@/types/studio'
import { isComposerRefStripVisible } from '@/utils/studio/studioComposerRefs'
import { resolveStudioScriptNodeText } from '@/utils/studio/studioScriptNode'
import { getStudioComposerPopupContainer } from '@/utils/studio/studioComposerPopupContainer'

function iconFor(mediaKind: StudioMediaKind | undefined) {
  if (mediaKind === 'video') return <PlayCircleOutlined />
  if (mediaKind === 'image') return <FileImageOutlined />
  return <FileTextOutlined />
}

export function StudioComposerReferenceCard({
  refItem,
  title,
  summary,
  mediaKind,
  index,
  onInsert,
  onRemove
}: {
  refItem: StudioComposerRef
  title: string
  summary: string
  mediaKind: StudioMediaKind | undefined
  index: number
  onInsert?: (ref: StudioComposerRef) => void
  onRemove?: (ref: StudioComposerRef) => void
}) {
  const audio = mediaKind === 'audio'
  return (
    <span className="studio-composer-reference-card">
      <StudioCanvasPopover
        trigger="click"
        nodePlacement
        arrow={false}
        getPopupContainer={getStudioComposerPopupContainer}
        content={(
          <article className="studio-composer-reference-detail studio-canvas-popover-scroll">
            <strong>{title}</strong>
            {summary || !audio ? <p>{summary || '暂无文本内容'}</p> : null}
          </article>
        )}
        classNames={{ root: 'studio-composer-popover studio-composer-popover--canvas' }}
      >
        <button
          type="button"
          className="studio-composer-reference-card__hit"
          aria-label={`查看引用：${title}`}
        >
          <b>{index}</b>
          {audio ? (
            // The cover is presentation only. The reference keeps its original audio URL.
            // eslint-disable-next-line @next/next/no-img-element
            <img className="studio-composer-reference-card__cover" src="/studio/audio-reference-cover.webp"
              alt="" width={44} height={44} draggable={false} />
          ) : <i aria-hidden>{iconFor(mediaKind)}</i>}
        </button>
      </StudioCanvasPopover>
      {onInsert ? (
        <StudioComposerReferenceMentionButton title={title} onInsert={() => onInsert(refItem)} />
      ) : null}
      {onRemove ? (
        <button
          type="button"
          className="studio-composer-reference-card__remove"
          aria-label={`移除引用：${title}`}
          onClick={(event) => {
            event.stopPropagation()
            onRemove(refItem)
          }}
        >
          <CloseOutlined />
        </button>
      ) : null}
    </span>
  )
}

export function listStudioComposerReferenceCards(
  refs: StudioComposerRef[] | undefined
): Array<{
  ref: StudioComposerRef
  mediaKind: StudioMediaKind | undefined
  title: string
  summary: string
  index: number
}> {
  const nodes = useStudioUiStore.getState().nodes
  const byId = new Map(nodes.map((node) => [node.id, node]))
  return (refs ?? [])
    .filter((ref) => isComposerRefStripVisible(ref))
    .flatMap((ref, index) => {
      const source = ref.nodeId ? byId.get(ref.nodeId) : undefined
      const mediaKind = source?.data.mediaKind ?? ref.mediaKind
      const previewUrl = source?.data.mediaUrl ?? ref.previewUrl
      if (previewUrl && (mediaKind === 'image' || mediaKind === 'video')) return []
      const summary = source ? resolveStudioScriptNodeText(source.data) : ref.textContent || ''
      return [{
        ref,
        mediaKind,
        title: source?.data.title ?? ref.title,
        summary,
        index: index + 1
      }]
    })
}

export function StudioComposerReferenceCards({
  refs,
  onRemove
}: {
  refs: StudioComposerRef[] | undefined
  onRemove?: (ref: StudioComposerRef) => void
}) {
  const nodeIds = new Set((refs ?? []).flatMap((ref) => ref.nodeId ? [ref.nodeId] : []))
  const sourceSignature = useStudioUiStore((state) => state.nodes
    .filter((node) => nodeIds.has(node.id))
    .map((node) => `${node.id}\0${node.data.title}\0${node.data.mediaKind ?? ''}\0${node.data.mediaUrl ?? ''}\0${resolveStudioScriptNodeText(node.data)}\0${node.data.prompt}`)
    .join('\n'))
  void sourceSignature
  const cards = listStudioComposerReferenceCards(refs)
  if (!cards.length) return null

  return (
    <div className="studio-composer-reference-cards studio-canvas-popover-scroll" aria-label="上游引用内容">
      {cards.map(({ ref, mediaKind, title, summary, index }) => (
        <StudioComposerReferenceCard
          key={ref.id}
          refItem={ref}
          title={title}
          summary={summary}
          mediaKind={mediaKind}
          index={index}
          onRemove={onRemove}
        />
      ))}
    </div>
  )
}
