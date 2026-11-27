'use client'

import { useLayoutEffect, useRef, useState } from 'react'
import type { XYPosition } from '@xyflow/react'
import { studioConnectionPreviewPath } from '@/utils/studio/studioConnectionHandle'

const pendingConnectionAnchorSelector = (side: 'source' | 'target') =>
  `[data-studio-connection-anchor="${side}"]`

export function StudioPendingConnectionLine({
  nodeId,
  side,
  end
}: {
  nodeId: string
  side: 'source' | 'target'
  end: XYPosition
}) {
  const { x: endX, y: endY } = end
  const [path, setPath] = useState('')
  const svgRef = useRef<SVGSVGElement>(null)

  useLayoutEffect(() => {
    const canvas = svgRef.current?.closest('.studio-canvas') as HTMLDivElement | null
    if (!canvas) return
    const safeId = typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
      ? CSS.escape(nodeId)
      : nodeId.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    const node = canvas.querySelector(`.react-flow__node[data-id="${safeId}"]`) as HTMLElement | null
    if (!node) return
    const handle = node.querySelector<HTMLElement>(pendingConnectionAnchorSelector(side))
    const card = handle?.closest<HTMLElement>('.studio-node-card') ?? null
    const update = () => {
      const canvasRect = canvas.getBoundingClientRect()
      const nodeRect = node.getBoundingClientRect()
      const handleRect = handle?.getBoundingClientRect()
      const start = handleRect
        ? {
            x: handleRect.left + handleRect.width / 2 - canvasRect.left,
            y: handleRect.top + handleRect.height / 2 - canvasRect.top
          }
        : {
            x: (side === 'source' ? nodeRect.right : nodeRect.left) - canvasRect.left,
            y: nodeRect.top + nodeRect.height / 2 - canvasRect.top
          }
      const nextPath = studioConnectionPreviewPath(start, { x: endX, y: endY }, side)
      setPath((currentPath) => currentPath === nextPath ? currentPath : nextPath)
    }
    update()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    observer?.observe(canvas)
    observer?.observe(node)
    if (card && card !== node) observer?.observe(card)
    if (handle && handle !== card) observer?.observe(handle)
    window.addEventListener('resize', update)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', update)
    }
  }, [endX, endY, nodeId, side])

  return (
    <svg ref={svgRef} className="studio-pending-connection" aria-hidden>
      {path ? (
        <>
          <path className="studio-pending-connection__halo" d={path} />
          <path className="studio-pending-connection__line" d={path} />
          <circle cx={end.x} cy={end.y} r="4" />
        </>
      ) : null}
    </svg>
  )
}
