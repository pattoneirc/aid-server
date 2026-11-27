'use client'

import { forwardRef, useCallback, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useStore, type Viewport, type XYPosition } from '@xyflow/react'
import { STUDIO_NODE_META } from '@/config/studioMeta'
import type { StudioCanvasNode, StudioCanvasTool, StudioFlowEdge } from '@/types/studio'
import { studioNodeDimensions } from '@/utils/studio/studioNodeLod'
import { useStudioUiStore } from '@/stores/studioUi'
import { useStudioLabels } from '@/stores/studioLabels'
import { studioLabel } from '@/utils/studio/studioNodeLabels'
import { canvasAssistantMarqueeSelection, canvasAssistantPointerSelection, publishCanvasAssistantReferenceSelection } from '@/utils/studio/canvasAssistantReferenceSelection'
import { useStudioFreeTheme } from '../theme/StudioFreeThemeProvider'

export interface StudioCanvasLodLayerHandle {
  draw: (viewport: Viewport) => void
  connectionTargetAt: (point: XYPosition) => { id: string; x: number; y: number } | null
}

interface StudioCanvasLodLayerProps {
  nodes: StudioCanvasNode[]
  edges: StudioFlowEdge[]
  viewport: Viewport
  selectedNodeIds: string[]
  tool: StudioCanvasTool
  onSelect: (ids: string[]) => void
  onFocusNode: (node: StudioCanvasNode) => void
}

interface Marquee {
  start: XYPosition
  current: XYPosition
  additive: boolean
}

export const StudioCanvasLodLayer = forwardRef<StudioCanvasLodLayerHandle, StudioCanvasLodLayerProps>(function StudioCanvasLodLayer(
  { nodes, edges, viewport, selectedNodeIds, tool, onSelect, onFocusNode },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const flowRoot = useStore(state => state.domNode)
  // Put the interactive overview inside React Flow's unscaled gesture surface.
  const renderer = useMemo(() => flowRoot?.querySelector('.react-flow__renderer'), [flowRoot])
  const scopeKey = useStudioUiStore((state) => state.scopeKey)
  const mode = useStudioUiStore((state) => state.studioMode)
  const { theme } = useStudioFreeTheme()
  const activeLabel = useStudioLabels((state) => state.scopeKey === scopeKey ? state.active : null)
  const viewportRef = useRef(viewport)
  const frameRef = useRef<number | null>(null)
  const [marquee, setMarquee] = useState<Marquee | null>(null)
  const scene = useMemo(() => prepareLodScene(nodes, edges, mode === 'free'), [edges, mode, nodes])
  const selection = useMemo(() => new Set(selectedNodeIds), [selectedNodeIds])
  const surface = useRef<{ width: number; height: number; ratio: number } | null>(null)
  const palette = useRef(DEFAULT_STUDIO_LOD_PALETTE)
  const paint = useRef(() => {})
  useLayoutEffect(() => {
    paint.current = () => {
      const context = canvasRef.current?.getContext('2d')
      if (context && surface.current) {
        paintLod(context, surface.current, scene, selection, viewportRef.current, activeLabel, palette.current)
      }
    }
    paint.current()
  }, [activeLabel, scene, selection])

  const draw = useCallback((nextViewport: Viewport) => {
    viewportRef.current = nextViewport
    if (frameRef.current != null) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null
      paint.current()
    })
  }, [])

  useImperativeHandle(ref, () => ({
    draw,
    connectionTargetAt(point) {
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return null
      const localPoint = { x: point.x - rect.left, y: point.y - rect.top }
      const current = viewportRef.current
      const node = findHitNode(scene.cards, current, localPoint)
      if (!node) return null
      return {
        id: node.id,
        x: rect.left + current.x + node.position.x * current.zoom,
        y: rect.top + current.y + (node.position.y + studioNodeDimensions(node).height / 2) * current.zoom
      }
    }
  }), [draw, scene])
  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const resize = () => {
      const { clientWidth: width, clientHeight: height } = canvas
      const ratio = Math.min(window.devicePixelRatio || 1, 1.25)
      if (surface.current?.width === width && surface.current.height === height && surface.current.ratio === ratio) return
      surface.current = { width, height, ratio }
      canvas.width = Math.max(1, Math.round(width * ratio))
      canvas.height = Math.max(1, Math.round(height * ratio))
      paint.current()
    }
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize)
    if (canvas.parentElement) observer?.observe(canvas.parentElement)
    window.addEventListener('resize', resize)
    resize()
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', resize)
      if (frameRef.current != null) window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [renderer])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (canvas) palette.current = mode === 'free' ? readStudioLodPalette(canvas) : DEFAULT_STUDIO_LOD_PALETTE
    paint.current()
  }, [mode, renderer, theme])

  const pointFromEvent = (event: React.PointerEvent<HTMLDivElement>): XYPosition => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (tool !== 'select' || event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    const point = pointFromEvent(event)
    const hit = findHitNode(scene.cards, viewportRef.current, point)
    if (hit) {
      const next = canvasAssistantPointerSelection(selectedNodeIds, hit.id, event.shiftKey)
      if (mode === 'free') publishCanvasAssistantReferenceSelection(scopeKey, next)
      onSelect(next)
      return
    }
    setMarquee({ start: point, current: point, additive: event.shiftKey })
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!marquee) return
    setMarquee({ ...marquee, current: pointFromEvent(event) })
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!marquee) return
    const current = pointFromEvent(event)
    const ids = nodesInScreenRect(scene.cards, viewportRef.current, marquee.start, current)
    const next = canvasAssistantMarqueeSelection(selectedNodeIds, ids, marquee.additive)
    if (mode === 'free') publishCanvasAssistantReferenceSelection(scopeKey, next)
    onSelect(next)
    setMarquee(null)
  }

  const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    const hit = findHitNode(scene.cards, viewportRef.current, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    })
    if (!hit) return
    event.preventDefault()
    event.stopPropagation()
    if (mode === 'free') publishCanvasAssistantReferenceSelection(scopeKey, [hit.id])
    onSelect([hit.id])
    onFocusNode(hit)
  }

  const rect = marquee ? normalizedRect(marquee.start, marquee.current) : null
  return renderer ? createPortal(
    <div className={`studio-lod-layer${tool === 'select' ? ' is-interactive' : ''}`} aria-hidden="true"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => setMarquee(null)}
      onDoubleClick={handleDoubleClick}>
      <canvas ref={canvasRef} />
      {rect ? <i className="studio-lod-marquee" style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }} /> : null}
    </div>,
    renderer
  ) : null
})

function prepareLodScene(nodes: StudioCanvasNode[], edges: StudioFlowEdge[], showLabels: boolean) {
  const cards = nodes.filter(node => !node.hidden).map(node => ({
    node,
    ...studioNodeDimensions(node),
    title: (node.data.title.trim() || STUDIO_NODE_META[node.data.kind].label).slice(0, 14),
    label: showLabels && !node.data.flowBinding ? studioLabel(node.data.labelColor) : undefined
  }))
  const byId = new Map(cards.map(card => [card.node.id, card]))
  const lines = new Path2D()
  for (const edge of edges) {
    const source = byId.get(edge.source)
    const target = byId.get(edge.target)
    if (!source || !target) continue
    lines.moveTo(source.node.position.x + source.width, source.node.position.y + source.height / 2)
    lines.lineTo(target.node.position.x, target.node.position.y + target.height / 2)
  }
  const frames = new Path2D()
  const failures = new Path2D()
  const media = new Path2D()
  for (const { node, width, height } of cards) {
    const { x, y } = node.position
    const frame = node.data.status === 'failed' ? failures : frames
    frame.rect(x, y, width, height)
    if (node.data.mediaUrl && width > 24 && height > 24) media.rect(x + 12, y + 12, width - 24, height - 24)
  }
  return { cards, lines, frames, failures, media }
}

function paintLod(
  context: CanvasRenderingContext2D,
  { width, height, ratio }: { width: number; height: number; ratio: number },
  { cards, lines, frames, failures, media }: ReturnType<typeof prepareLodScene>,
  selected: ReadonlySet<string>,
  { x, y, zoom }: Viewport,
  activeLabel: string | null,
  palette: StudioLodPalette
) {
  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, context.canvas.width, context.canvas.height)
  // Geometry only changes with the graph. Panning and zooming draw the same
  // paths using the viewport transform, including links crossing the viewport.
  context.setTransform(ratio * zoom, 0, 0, ratio * zoom, x * ratio, y * ratio)
  context.strokeStyle = palette.edge
  context.lineWidth = 1 / zoom
  context.stroke(lines)
  context.fillStyle = palette.node
  context.fill(frames)
  context.fillStyle = palette.failedNode
  context.fill(failures)
  if (zoom >= .08) {
    context.fillStyle = palette.media
    context.fill(media)
  }

  context.setTransform(ratio, 0, 0, ratio, 0, 0)
  const left = -x / zoom
  const top = -y / zoom
  const right = left + width / zoom
  const bottom = top + height / zoom
  const showTitles = zoom >= .16
  context.font = `${Math.max(7, Math.min(12, 6 + zoom * 10))}px sans-serif`
  context.textBaseline = 'middle'
  let titles = 0
  for (const card of cards) {
    const { node, label } = card
    const position = node.position
    const isSelected = selected.has(node.id)
    if (!showTitles && !label && !isSelected) continue
    if (position.x > right || position.y > bottom || position.x + card.width < left || position.y + card.height < top) continue
    const leftPx = position.x * zoom + x
    const topPx = position.y * zoom + y
    const nodeWidth = card.width * zoom
    const nodeHeight = card.height * zoom
    if (showTitles && titles < 120 && nodeWidth >= 34 && nodeHeight >= 18) {
      context.fillStyle = palette.text
      context.fillText(card.title, leftPx + 5, topPx + nodeHeight / 2, nodeWidth - 10)
      titles++
    }
    if (isSelected) {
      context.strokeStyle = palette.selection
      context.lineWidth = 2
      context.strokeRect(leftPx - 1, topPx - 1, nodeWidth + 2, nodeHeight + 2)
    }
    if (label) {
      context.fillStyle = label.color
      context.beginPath()
      context.arc(leftPx + nodeWidth - 4, topPx - 5, 3, 0, Math.PI * 2)
      context.fill()
      if (activeLabel === label.id) {
        context.save()
        context.strokeStyle = label.color
        context.shadowColor = label.color
        context.shadowBlur = 8
        context.lineWidth = 2
        context.strokeRect(leftPx - 1, topPx - 1, nodeWidth + 2, nodeHeight + 2)
        context.restore()
      }
    }
  }
}

interface StudioLodPalette {
  edge: string
  node: string
  failedNode: string
  selection: string
  media: string
  text: string
}

const DEFAULT_STUDIO_LOD_PALETTE: StudioLodPalette = {
  edge: 'rgba(147, 156, 171, .18)',
  node: 'rgba(70, 76, 88, .9)',
  failedNode: 'rgba(164, 76, 84, .78)',
  selection: '#c8d1e2',
  media: 'rgba(150,164,187,.24)',
  text: 'rgba(242,244,248,.92)'
}

function readStudioLodPalette(canvas: HTMLCanvasElement): StudioLodPalette {
  const styles = getComputedStyle(canvas)
  const read = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback
  return {
    edge: read('--studio-theme-lod-edge', DEFAULT_STUDIO_LOD_PALETTE.edge),
    node: read('--studio-theme-lod-node', DEFAULT_STUDIO_LOD_PALETTE.node),
    failedNode: read('--studio-theme-lod-node-failed', DEFAULT_STUDIO_LOD_PALETTE.failedNode),
    selection: read('--studio-theme-lod-selection', DEFAULT_STUDIO_LOD_PALETTE.selection),
    media: read('--studio-theme-lod-media', DEFAULT_STUDIO_LOD_PALETTE.media),
    text: read('--studio-theme-lod-text', DEFAULT_STUDIO_LOD_PALETTE.text)
  }
}

function toScreen(point: XYPosition, viewport: Viewport): XYPosition {
  return { x: point.x * viewport.zoom + viewport.x, y: point.y * viewport.zoom + viewport.y }
}

function findHitNode(cards: ReturnType<typeof prepareLodScene>['cards'], viewport: Viewport, point: XYPosition): StudioCanvasNode | undefined {
  for (let index = cards.length - 1; index >= 0; index -= 1) {
    const { node, width, height } = cards[index]
    const topLeft = toScreen(node.position, viewport)
    if (point.x >= topLeft.x && point.y >= topLeft.y && point.x <= topLeft.x + width * viewport.zoom && point.y <= topLeft.y + height * viewport.zoom) return node
  }
}

function nodesInScreenRect(cards: ReturnType<typeof prepareLodScene>['cards'], viewport: Viewport, start: XYPosition, end: XYPosition): string[] {
  const rect = normalizedRect(start, end)
  return cards.flatMap(({ node, width, height }) => {
    const point = toScreen(node.position, viewport)
    const overlaps = point.x < rect.left + rect.width && point.x + width * viewport.zoom > rect.left && point.y < rect.top + rect.height && point.y + height * viewport.zoom > rect.top
    return overlaps ? [node.id] : []
  })
}

function normalizedRect(start: XYPosition, end: XYPosition) {
  const left = Math.min(start.x, end.x)
  const top = Math.min(start.y, end.y)
  return { left, top, width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }
}
