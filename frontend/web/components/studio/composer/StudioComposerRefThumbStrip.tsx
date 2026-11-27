'use client'

/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from 'react'
import { CloseOutlined, ExclamationCircleFilled } from '@ant-design/icons'
import { createPortal } from 'react-dom'
import { useStudioUiStore } from '@/stores/studioUi'
import type { StudioMediaKind } from '@/types/studio'
import {
  fitStudioThumbPreviewSize,
  placeStudioThumbPreview
} from '@/utils/studio/studioComposerThumbPreview'
import { StudioCanvasTooltip } from '@/components/studio/canvas/StudioCanvasTooltip'

export type StudioComposerThumbItem = {
  key: string
  previewUrl: string
  title: string
  mediaKind?: StudioMediaKind
  nodeId?: string
  index?: number
  invalidResourceId?: string
  onInsert: () => void
  onRemove?: () => void
}

function useNaturalMediaSize(url: string, mediaKind: StudioMediaKind | undefined) {
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    if (mediaKind === 'video') {
      const video = document.createElement('video')
      video.preload = 'metadata'
      video.muted = true
      video.onloadedmetadata = () => {
        if (!cancelled) setSize({ width: video.videoWidth || 16, height: video.videoHeight || 9 })
      }
      video.onerror = () => { if (!cancelled) setSize(null) }
      video.src = url
      return () => {
        cancelled = true
        video.onloadedmetadata = null
        video.onerror = null
        video.removeAttribute('src')
        video.load()
      }
    }

    const image = new window.Image()
    image.onload = () => {
      if (!cancelled) setSize({ width: image.naturalWidth || 1, height: image.naturalHeight || 1 })
    }
    image.onerror = () => { if (!cancelled) setSize(null) }
    image.src = url
    return () => {
      cancelled = true
      image.onload = null
      image.onerror = null
    }
  }, [mediaKind, url])

  return size
}

function Thumb({
  item,
  showRemove
}: {
  item: StudioComposerThumbItem
  showRemove?: boolean
}) {
  const [hover, setHover] = useState(false)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const hoverTimer = useRef<number | null>(null)
  const clickTimer = useRef<number | null>(null)
  const rootRef = useRef<HTMLSpanElement>(null)
  const natural = useNaturalMediaSize(item.previewUrl, item.mediaKind)

  useEffect(() => () => {
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
    if (clickTimer.current) window.clearTimeout(clickTimer.current)
  }, [])

  const previewSize = natural ? fitStudioThumbPreviewSize(natural.width, natural.height) : null
  const previewPos = previewSize && rect ? placeStudioThumbPreview(rect, previewSize) : null

  const focusNode = () => {
    if (!item.nodeId) return
    if (clickTimer.current) window.clearTimeout(clickTimer.current)
    useStudioUiStore.getState().selectNodes([item.nodeId])
    window.requestAnimationFrame(() => {
      window.dispatchEvent(new CustomEvent('studio:focus-node', { detail: { nodeId: item.nodeId } }))
    })
  }

  const media = item.mediaKind === 'video'
    ? <video src={item.previewUrl} muted playsInline preload="metadata" aria-label={item.title} />
    : <img src={item.previewUrl} alt="" />

  return (
    <span
      ref={rootRef}
      className={`studio-composer-thumbs__item${item.invalidResourceId ? ' is-invalid' : ''}`}
      data-invalid-reference={item.invalidResourceId}
      onMouseEnter={() => {
        hoverTimer.current = window.setTimeout(() => {
          setRect(rootRef.current?.getBoundingClientRect() ?? null)
          setHover(true)
        }, 280)
      }}
      onMouseLeave={() => {
        if (hoverTimer.current) window.clearTimeout(hoverTimer.current)
        setHover(false)
        setRect(null)
      }}
    >
      <StudioCanvasTooltip title={item.nodeId ? '双击可聚焦到对应节点' : item.title} placement="top">
        <button
          type="button"
          className="studio-composer-thumbs__hit"
          aria-label={item.invalidResourceId ? `第 ${item.index} 张参考图需要调整：${item.title}` : item.title}
          aria-invalid={item.invalidResourceId ? true : undefined}
          onClick={() => {
            if (!item.nodeId) {
              item.onInsert()
              return
            }
            if (clickTimer.current) window.clearTimeout(clickTimer.current)
            clickTimer.current = window.setTimeout(item.onInsert, 220)
          }}
          onDoubleClick={(event) => {
            event.preventDefault()
            event.stopPropagation()
            focusNode()
          }}
        >
          {item.index != null ? <b>{item.index}</b> : null}
          {media}
          {item.invalidResourceId ? <ExclamationCircleFilled className="studio-composer-thumbs__error" aria-hidden /> : null}
        </button>
      </StudioCanvasTooltip>
      {showRemove && item.onRemove ? (
        <button
          type="button"
          className="studio-composer-thumbs__remove"
          aria-label={`移除${item.title}`}
          onClick={(event) => {
            event.stopPropagation()
            item.onRemove?.()
          }}
        >
          <CloseOutlined />
        </button>
      ) : null}
      {hover && previewSize && previewPos && typeof document !== 'undefined'
        ? createPortal(
          <div
            className="studio-composer-thumbs__preview"
            style={{
              top: previewPos.top,
              left: previewPos.left,
              width: previewSize.width,
              height: previewSize.height
            }}
          >
            {item.mediaKind === 'video' ? (
              <video
                src={item.previewUrl}
                muted
                autoPlay
                loop
                playsInline
                preload="auto"
                width={previewSize.width}
                height={previewSize.height}
              />
            ) : (
              <img
                src={item.previewUrl}
                alt=""
                width={previewSize.width}
                height={previewSize.height}
              />
            )}
            {item.nodeId ? <span className="studio-composer-thumbs__preview-hint">双击可聚焦到对应节点</span> : null}
          </div>,
          document.body
        )
        : null}
    </span>
  )
}

export function StudioComposerThumb({
  item,
  showRemove
}: {
  item: StudioComposerThumbItem
  showRemove?: boolean
}) {
  return <Thumb item={item} showRemove={showRemove} />
}

export function StudioComposerRefThumbStrip({
  upstream,
  refs
}: {
  upstream: StudioComposerThumbItem[]
  refs: StudioComposerThumbItem[]
}) {
  if (!upstream.length && !refs.length) return null
  return (
    <div className="studio-composer-thumbs">
      {upstream.map((item) => <Thumb key={`up-${item.key}`} item={item} />)}
      {refs.map((item) => <Thumb key={item.key} item={item} showRemove />)}
    </div>
  )
}
