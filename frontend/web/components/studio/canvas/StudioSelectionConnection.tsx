'use client'

import { PlusOutlined } from '@ant-design/icons'
import { useEffect, useImperativeHandle, useRef, useState, type PointerEvent, type Ref } from 'react'
import type { XYPosition } from '@xyflow/react'
import { useStudioUiStore } from '@/stores/studioUi'
import {
  resolveStudioConnectionHandle,
  STUDIO_CONNECTION_HANDLE_OUTSET_PX,
  STUDIO_CONNECTION_RADIUS_PX,
  studioConnectionPreviewPath
} from '@/utils/studio/studioConnectionHandle'
import type { StudioAgentDockRect } from '@/utils/studio/studioNodeAgentDockLayout'
import { StudioCanvasTooltip } from './StudioCanvasTooltip'

export type StudioSelectionConnectionHandle = {
  reposition: (bounds: StudioAgentDockRect) => void
}

type ConnectionTarget = XYPosition & { id: string }

const NODE_SELECTOR = '.react-flow__node-studioNode'
const INTERACTIVE_SELECTOR = 'button, input, textarea, select, a, [contenteditable="true"], .react-flow__handle'

function targetAtPoint(canvas: HTMLElement, point: XYPosition, sources: readonly string[]) {
  const hit = (x: number) => canvas.ownerDocument.elementFromPoint(x, point.y)?.closest<HTMLElement>(NODE_SELECTOR)
  const node = hit(point.x) ?? hit(point.x + STUDIO_CONNECTION_RADIUS_PX)
  const id = node?.dataset.id
  if (!node || !canvas.contains(node) || !id || sources.includes(id)) return null

  const rect = node.getBoundingClientRect()
  const handle = node.querySelector<HTMLElement>('[data-studio-connection-anchor="target"]')
  const anchor = handle?.getBoundingClientRect()
  const x = anchor ? anchor.left + anchor.width / 2 : rect.left
  const y = anchor ? anchor.top + anchor.height / 2 : rect.top + rect.height / 2
  if (point.x < rect.left && Math.hypot(point.x - x, point.y - y) > STUDIO_CONNECTION_RADIUS_PX) return null
  return { id, x, y }
}

export function StudioSelectionConnection({
  ref,
  sources,
  onConnect,
  resolveOverviewTarget,
  onDragStart,
  onDragEnd
}: {
  ref: Ref<StudioSelectionConnectionHandle>
  sources: readonly string[]
  onConnect: (sources: readonly string[], targetId: string) => void
  resolveOverviewTarget?: (point: XYPosition) => ConnectionTarget | null
  onDragStart: (sources: readonly string[]) => void
  onDragEnd: () => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const bounds = useRef<StudioAgentDockRect>(null)
  const line = useRef<SVGSVGElement>(null)
  const halo = useRef<SVGPathElement>(null)
  const stroke = useRef<SVGPathElement>(null)
  const pointer = useRef<{ id: number; point: XYPosition; scope: string; dragging: boolean } | null>(null)
  const [armedScope, setArmedScope] = useState<string | null>(null)

  useImperativeHandle(ref, () => ({
    reposition(next) {
      bounds.current = next
      const handle = root.current
      if (!handle) return
      handle.style.left = `${next.right}px`
      handle.style.top = `${next.top + next.height / 2}px`
      handle.style.visibility = 'visible'
    }
  }), [])

  useEffect(() => () => {
    if (pointer.current?.dragging) onDragEnd()
  }, [onDragEnd])

  useEffect(() => {
    const canvas = root.current?.parentElement
    if (!canvas || armedScope === null) return

    const onTarget = (event: Event) => {
      const target = event.target
      if (!(target instanceof Element) || target.closest('.studio-selection-connection')) return
      if (event.type === 'keydown' && (event as KeyboardEvent).key !== 'Enter') return
      if (target.closest(INTERACTIVE_SELECTOR)) return
      const overview = event instanceof MouseEvent && target.closest('.studio-lod-layer')
        ? resolveOverviewTarget?.({ x: event.clientX, y: event.clientY })
        : null
      const id = overview?.id ?? target.closest<HTMLElement>(NODE_SELECTOR)?.dataset.id
      if (!id || sources.includes(id)) return
      // React Flow normally replaces the selection on pointer-down. Keep it
      // intact until the user activates the target, then apply the whole batch.
      event.stopPropagation()
      event.preventDefault()
      if (event.type === 'pointerdown') return
      setArmedScope(null)
      if (armedScope === useStudioUiStore.getState().scopeKey) onConnect(sources, id)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setArmedScope(null)
        button.current?.focus({ preventScroll: true })
      }
    }
    canvas.addEventListener('pointerdown', onTarget, true)
    canvas.addEventListener('click', onTarget, true)
    canvas.addEventListener('keydown', onTarget, true)
    canvas.addEventListener('keydown', escape, true)
    return () => {
      canvas.removeEventListener('pointerdown', onTarget, true)
      canvas.removeEventListener('click', onTarget, true)
      canvas.removeEventListener('keydown', onTarget, true)
      canvas.removeEventListener('keydown', escape, true)
    }
  }, [armedScope, onConnect, resolveOverviewTarget, sources])

  const clearMagnet = () => {
    button.current?.style.removeProperty('--studio-connection-handle-right-x')
    button.current?.style.removeProperty('--studio-connection-handle-right-y')
  }

  const resetDrag = () => {
    const session = pointer.current
    pointer.current = null
    line.current?.removeAttribute('data-dragging')
    clearMagnet()
    if (session?.dragging) onDragEnd()
    if (session && button.current?.hasPointerCapture(session.id)) button.current.releasePointerCapture(session.id)
    return session
  }

  const findTarget = (canvas: HTMLElement, point: XYPosition) => {
    if (!resolveOverviewTarget) return targetAtPoint(canvas, point, sources)
    const target = resolveOverviewTarget(point)
    return target && !sources.includes(target.id) ? target : null
  }

  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const canvas = root.current?.parentElement
    const selection = bounds.current
    if (!canvas || !selection) return
    const rect = canvas.getBoundingClientRect()
    const point = { x: event.clientX, y: event.clientY }
    const session = pointer.current
    if (!session) {
      const hit = resolveStudioConnectionHandle({
        pointerX: point.x - rect.left,
        pointerY: point.y - rect.top,
        rect: selection
      })
      if (hit?.side !== 'right') return clearMagnet()
      event.currentTarget.style.setProperty('--studio-connection-handle-right-x', `${hit.x}px`)
      event.currentTarget.style.setProperty('--studio-connection-handle-right-y', `${hit.y}px`)
      return
    }
    if (session.id !== event.pointerId) return
    if (!session.dragging) {
      if (Math.hypot(point.x - session.point.x, point.y - session.point.y) < 4) return
      session.dragging = true
      clearMagnet()
      onDragStart(sources)
      line.current?.setAttribute('data-dragging', '')
    }
    const target = findTarget(canvas, point)
    const path = studioConnectionPreviewPath(
      { x: selection.right + STUDIO_CONNECTION_HANDLE_OUTSET_PX, y: selection.top + selection.height / 2 },
      { x: (target?.x ?? point.x) - rect.left, y: (target?.y ?? point.y) - rect.top }
    )
    halo.current?.setAttribute('d', path)
    stroke.current?.setAttribute('d', path)
  }

  return (
    <>
      <svg ref={line} className="studio-pending-connection studio-selection-connection-line" aria-hidden="true">
        <path ref={halo} className="studio-pending-connection__halo" />
        <path ref={stroke} className="studio-pending-connection__line" />
      </svg>
      <div ref={root} className="studio-selection-connection">
        <StudioCanvasTooltip
          title={armedScope === null ? '拖动连线，或点击后选择目标节点' : '选择目标节点 · Esc 取消'}
          placement="top"
          trigger={['hover', 'focus']}
          styles={{ root: { pointerEvents: 'none' } }}
        >
          <button
            ref={button}
            type="button"
            className="studio-node-handle studio-node-handle--right nodrag nopan"
            aria-label="连接所选节点"
            aria-pressed={armedScope !== null}
            onPointerDown={(event) => {
              if (!event.isPrimary || event.button !== 0) return
              event.stopPropagation()
              delete event.currentTarget.dataset.dragged
              pointer.current = {
                id: event.pointerId,
                point: { x: event.clientX, y: event.clientY },
                scope: useStudioUiStore.getState().scopeKey,
                dragging: false
              }
              event.currentTarget.setPointerCapture(event.pointerId)
            }}
            onPointerMove={move}
            onPointerLeave={clearMagnet}
            onPointerCancel={resetDrag}
            onLostPointerCapture={resetDrag}
            onPointerUp={(event) => {
              if (pointer.current?.id !== event.pointerId) return
              const session = resetDrag()
              if (!session?.dragging) return
              // The click emitted after pointer capture still targets the same
              // button. Mark this pointer-up so it cannot arm a second action.
              event.currentTarget.dataset.dragged = 'true'
              setArmedScope(null)
              const canvas = root.current?.parentElement
              if (!canvas || session.scope !== useStudioUiStore.getState().scopeKey) return
              const target = findTarget(canvas, { x: event.clientX, y: event.clientY })
              if (target) onConnect(sources, target.id)
            }}
            onClick={(event) => {
              event.stopPropagation()
              if (event.currentTarget.dataset.dragged && event.detail > 0) {
                delete event.currentTarget.dataset.dragged
                return
              }
              setArmedScope(scope => scope === null ? useStudioUiStore.getState().scopeKey : null)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape' || !pointer.current) return
              event.stopPropagation()
              resetDrag()
            }}
          >
            <span aria-hidden="true"><PlusOutlined /></span>
          </button>
        </StudioCanvasTooltip>
      </div>
    </>
  )
}
