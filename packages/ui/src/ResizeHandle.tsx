import { type KeyboardEvent, type PointerEvent, useRef } from 'react'
import { focusRing } from './classes.ts'

const keyboardStep = 16

export const ResizeHandle = ({
  label,
  edge,
  width,
  minimumWidth,
  maximumWidth,
  widthVariable,
  resizeTo,
}: {
  label: string
  edge: 'left' | 'right'
  width: number
  minimumWidth: number
  maximumWidth: number
  widthVariable: `--${string}`
  resizeTo: (width: number) => void
}) => {
  const growthPerPixel = edge === 'left' ? -1 : 1
  const boundedWidthOf = (nextWidth: number) => Math.min(maximumWidth, Math.max(minimumWidth, nextWidth))
  const drag = useRef<{ startX: number; startWidth: number; draggedWidth: number } | null>(null)
  const startDrag = (event: PointerEvent<HTMLHRElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { startX: event.clientX, startWidth: width, draggedWidth: width }
  }
  const moveDrag = (event: PointerEvent<HTMLHRElement>) => {
    if (!drag.current) return
    const draggedWidth = boundedWidthOf(
      drag.current.startWidth + growthPerPixel * (event.clientX - drag.current.startX),
    )
    drag.current.draggedWidth = draggedWidth
    event.currentTarget.parentElement?.style.setProperty(widthVariable, `${draggedWidth}px`)
    event.currentTarget.setAttribute('aria-valuenow', String(draggedWidth))
  }
  const endDrag = () => {
    if (drag.current) resizeTo(drag.current.draggedWidth)
    drag.current = null
  }
  const resizeWithKey = (event: KeyboardEvent<HTMLHRElement>) => {
    if (event.key === 'ArrowLeft') resizeTo(boundedWidthOf(width - growthPerPixel * keyboardStep))
    if (event.key === 'ArrowRight') resizeTo(boundedWidthOf(width + growthPerPixel * keyboardStep))
  }
  return (
    <hr
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={minimumWidth}
      aria-valuemax={maximumWidth}
      tabIndex={0}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={resizeWithKey}
      className={`absolute inset-y-0 ${edge === 'left' ? 'left-0' : 'right-0'} m-0 h-auto w-1.5 border-0 cursor-col-resize touch-none hover:bg-selected focus-visible:bg-selected ${focusRing}`}
    />
  )
}
