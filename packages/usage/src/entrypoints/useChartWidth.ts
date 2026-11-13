import { useEffect, useRef, useState } from 'react'

const defaultChartWidth = 640

export const useChartWidth = <Element extends HTMLElement>() => {
  const ref = useRef<Element>(null)
  const [width, setWidth] = useState(defaultChartWidth)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const measured = Math.round(entry?.contentRect.width ?? 0)
      if (measured > 0) setWidth(measured)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return { ref, width }
}
