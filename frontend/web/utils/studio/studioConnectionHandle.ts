export const STUDIO_CONNECTION_RADIUS_PX = 28
export const STUDIO_CONNECTION_HANDLE_SIZE_PX = 22
/** 外侧命中区：用于跟随吸附，不改变连线锚点默认位置 */
export const STUDIO_CONNECTION_HANDLE_ZONE_PX = 48
/** 图标跟随行程，允许在侧缘附近更自然地跟随指针 */
export const STUDIO_CONNECTION_HANDLE_TRAVEL_PX = 12
/** 连线锚点相对卡片边缘向外的偏移，保证图标在卡外且与连线端点同心 */
export const STUDIO_CONNECTION_HANDLE_OUTSET_PX = 10

export type StudioConnectionSide = 'left' | 'right'

export interface StudioConnectionHandleHit {
  side: StudioConnectionSide
  x: number
  y: number
}

export function resolveStudioConnectionHandle(input: {
  pointerX: number
  pointerY: number
  rect: { left: number; top: number; right: number; bottom: number; height: number }
  /** Canvas zoom: pointer coordinates are screen pixels; handle offsets are canvas pixels. */
  scale?: number
}): StudioConnectionHandleHit | null {
  const { pointerX, pointerY, rect } = input
  const scale = input.scale && Number.isFinite(input.scale) && input.scale > 0 ? input.scale : 1
  const centerY = rect.top + rect.height / 2
  const zone = STUDIO_CONNECTION_HANDLE_ZONE_PX * scale
  const halfZone = zone / 2

  const inLeftZone =
    pointerX >= rect.left - zone &&
    pointerX <= rect.left &&
    pointerY >= centerY - halfZone &&
    pointerY <= centerY + halfZone

  const inRightZone =
    pointerX >= rect.right &&
    pointerX <= rect.right + zone &&
    pointerY >= centerY - halfZone &&
    pointerY <= centerY + halfZone

  const side = inLeftZone ? 'left' : inRightZone ? 'right' : null
  if (!side) return null

  // 跟随中心取卡片外缘中点外侧，图标默认就停在卡外，而不是压在描边上
  const centerX = side === 'left'
    ? rect.left - STUDIO_CONNECTION_HANDLE_OUTSET_PX * scale
    : rect.right + STUDIO_CONNECTION_HANDLE_OUTSET_PX * scale
  const clampTravel = (value: number) => Math.max(
    -STUDIO_CONNECTION_HANDLE_TRAVEL_PX,
    Math.min(STUDIO_CONNECTION_HANDLE_TRAVEL_PX, value)
  )

  return {
    side,
    x: clampTravel((pointerX - centerX) / scale),
    y: clampTravel((pointerY - centerY) / scale)
  }
}

export function studioConnectionPreviewPath(
  start: { x: number; y: number },
  end: { x: number; y: number },
  side: 'source' | 'target' = 'source'
): string {
  const bend = Math.max(56, Math.abs(end.x - start.x) * 0.45)
  const direction = side === 'source' ? 1 : -1
  return `M ${start.x} ${start.y} C ${start.x + bend * direction} ${start.y}, ${end.x - bend * direction} ${end.y}, ${end.x} ${end.y}`
}
