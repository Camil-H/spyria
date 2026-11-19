import { SegmentedChoice } from '@spyria/ui'
import { useState } from 'react'
import { colorModes } from '../domain/color-mode.ts'
import { rememberColorMode, storedColorMode } from './color-mode.ts'

const colorModeLabels = { light: 'Light', dark: 'Dark', system: 'System' } as const

export const ColorModeChoice = () => {
  const [colorMode, setColorMode] = useState(storedColorMode)
  return (
    <SegmentedChoice
      label="Appearance"
      name="color-mode"
      options={colorModes}
      labels={colorModeLabels}
      value={colorMode}
      onChange={(nextColorMode) => {
        rememberColorMode(nextColorMode)
        setColorMode(nextColorMode)
      }}
    />
  )
}
