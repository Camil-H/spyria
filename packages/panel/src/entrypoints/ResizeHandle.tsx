import { focusRing } from '@spyria/ui'
import { type KeyboardEvent, type PointerEvent, useRef } from 'react'
import { minimumPanelWidth, panelWidthVariable, usePanel } from './providers.tsx'

const keyboardStep = 16

export const ResizeHandle = () => {
  const { width, maximumWidth, resizeTo, boundedWidthOf } = usePanel()
  const drag = useRef<{ startX: number; startWidth: number; draggedWidth: number } | null>(null)
  const startDrag = (event: PointerEvent<HTMLHRElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId)
    drag.current = { startX: event.clientX, startWidth: width, draggedWidth: width }
  }
  const moveDrag = (event: PointerEvent<HTMLHRElement>) => {
    if (!drag.current) return
    const draggedWidth = boundedWidthOf(drag.current.startWidth + drag.current.startX - event.clientX)
    drag.current.draggedWidth = draggedWidth
    event.currentTarget.parentElement?.style.setProperty(panelWidthVariable, `${draggedWidth}px`)
    event.currentTarget.setAttribute('aria-valuenow', String(draggedWidth))
  }
  const endDrag = () => {
    if (drag.current) resizeTo(drag.current.draggedWidth)
    drag.current = null
  }
  const resizeWithKey = (event: KeyboardEvent<HTMLHRElement>) => {
    if (event.key === 'ArrowLeft') resizeTo(width + keyboardStep)
    if (event.key === 'ArrowRight') resizeTo(width - keyboardStep)
  }
  return (
    <hr
      aria-label="Resize panel"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={minimumPanelWidth}
      aria-valuemax={maximumWidth}
      tabIndex={0}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={resizeWithKey}
      className={`absolute inset-y-0 left-0 m-0 h-auto w-1.5 border-0 cursor-col-resize touch-none hover:bg-selected focus-visible:bg-selected ${focusRing}`}
    />
  )
}
