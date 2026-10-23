import { useId, useSyncExternalStore } from 'react'

type Coil = { growth: number; turns: number; phase: number; wobble: number }
type Spire = {
  x: number
  y: number
  size: number
  strands: number
  coils: readonly Coil[]
  turnSeconds: number
  morphSeconds: number
  tone: string
  opacity: number
  width: number
}

const pointsPerStrand = 64
const reducedMotionQuery = '(prefers-reduced-motion: reduce)'

const spires: readonly Spire[] = [
  {
    x: 22,
    y: 30,
    size: 34,
    strands: 5,
    coils: [
      { growth: 0.18, turns: 2.6, phase: 0, wobble: 0.08 },
      { growth: 0.24, turns: 2.1, phase: 0.6, wobble: 0.16 },
      { growth: 0.14, turns: 3.1, phase: 1.3, wobble: 0.05 },
    ],
    turnSeconds: 140,
    morphSeconds: 38,
    tone: 'text-accent',
    opacity: 0.45,
    width: 1.6,
  },
  {
    x: 80,
    y: 72,
    size: 42,
    strands: 7,
    coils: [
      { growth: 0.2, turns: 2.4, phase: 2.1, wobble: 0.12 },
      { growth: 0.13, turns: 3.3, phase: 2.9, wobble: 0.04 },
      { growth: 0.26, turns: 1.9, phase: 1.7, wobble: 0.2 },
    ],
    turnSeconds: -180,
    morphSeconds: 52,
    tone: 'text-link',
    opacity: 0.32,
    width: 1.2,
  },
  {
    x: 64,
    y: 12,
    size: 20,
    strands: 4,
    coils: [
      { growth: 0.3, turns: 1.7, phase: 4, wobble: 0.1 },
      { growth: 0.2, turns: 2.5, phase: 4.8, wobble: 0.22 },
      { growth: 0.34, turns: 1.5, phase: 3.4, wobble: 0.06 },
    ],
    turnSeconds: 110,
    morphSeconds: 30,
    tone: 'text-muted',
    opacity: 0.3,
    width: 1,
  },
]

const pointOf = (spire: Spire, coil: Coil, offset: number, angle: number, outermost: number) => {
  const radius =
    (spire.size * Math.exp(coil.growth * angle) * (1 + coil.wobble * Math.sin(angle * 3 + offset))) / outermost
  return [spire.x + radius * Math.cos(angle + offset), spire.y + radius * Math.sin(angle + offset)] as const
}

const strandPath = (spire: Spire, coil: Coil, strand: number) => {
  const offset = (strand / spire.strands) * 2 * Math.PI + coil.phase
  const sweep = coil.turns * 2 * Math.PI
  const outermost = Math.exp(coil.growth * sweep)
  const points = Array.from({ length: pointsPerStrand }, (_, index) =>
    pointOf(spire, coil, offset, (index / (pointsPerStrand - 1)) * sweep, outermost),
  )
  const at = (index: number) => points[Math.min(Math.max(index, 0), points.length - 1)] ?? [spire.x, spire.y]
  const format = (value: number) => value.toFixed(2)
  const [startX, startY] = at(0)
  return points.slice(1).reduce(
    (path, [x, y], previous) => {
      const [fromX, fromY] = at(previous)
      const [beforeX, beforeY] = at(previous - 1)
      const [afterX, afterY] = at(previous + 2)
      const controls = [
        fromX + (x - beforeX) / 6,
        fromY + (y - beforeY) / 6,
        x - (afterX - fromX) / 6,
        y - (afterY - fromY) / 6,
      ]
      return `${path}C${controls.map(format).join(' ')} ${format(x)} ${format(y)}`
    },
    `M${format(startX)} ${format(startY)}`,
  )
}

const strandsOf = (spire: Spire, restingCoil: Coil) =>
  Array.from({ length: spire.strands }, (_, strand) => ({
    id: `strand-${strand}`,
    shapes: [...spire.coils, restingCoil].map((coil) => strandPath(spire, coil, strand)),
    morphSeconds: spire.morphSeconds + strand * 3,
  }))

const subscribeToReducedMotion = (onChange: () => void) => {
  const query = matchMedia(reducedMotionQuery)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
const prefersReducedMotion = () => matchMedia(reducedMotionQuery).matches

const SpireStrands = ({ spire, isStill }: { spire: Spire; isStill: boolean }) => {
  const fadeId = useId()
  const glowId = useId()
  const [restingCoil] = spire.coils
  if (!restingCoil) return null
  return (
    <g className={spire.tone} opacity={spire.opacity}>
      <defs>
        <radialGradient id={fadeId} cx={spire.x} cy={spire.y} r={spire.size} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="white" />
          <stop offset="0.55" stopColor="white" stopOpacity="0.7" />
          <stop offset="1" stopColor="white" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={glowId} cx={spire.x} cy={spire.y} r={spire.size * 0.6} gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="currentColor" stopOpacity="0.35" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
        <mask id={`${fadeId}-mask`} maskUnits="userSpaceOnUse" x="-50" y="-50" width="200" height="200">
          <rect x="-50" y="-50" width="200" height="200" fill={`url(#${fadeId})`} />
        </mask>
      </defs>
      <circle cx={spire.x} cy={spire.y} r={spire.size * 0.6} fill={`url(#${glowId})`}>
        {!isStill && (
          <animate attributeName="opacity" values="0.5;1;0.5" dur={`${spire.morphSeconds}s`} repeatCount="indefinite" />
        )}
      </circle>
      <g mask={`url(#${fadeId}-mask)`}>
        {!isStill && (
          <animateTransform
            attributeName="transform"
            type="rotate"
            from={`0 ${spire.x} ${spire.y}`}
            to={`${Math.sign(spire.turnSeconds) * 360} ${spire.x} ${spire.y}`}
            dur={`${Math.abs(spire.turnSeconds)}s`}
            repeatCount="indefinite"
          />
        )}
        {strandsOf(spire, restingCoil).map(({ id, shapes, morphSeconds }) => (
          <path
            key={id}
            d={shapes[0]}
            fill="none"
            stroke="currentColor"
            strokeWidth={spire.width}
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          >
            {!isStill && (
              <animate
                attributeName="d"
                values={shapes.join(';')}
                dur={`${morphSeconds}s`}
                calcMode="spline"
                keySplines={spire.coils.map(() => '0.45 0 0.55 1').join(';')}
                repeatCount="indefinite"
              />
            )}
          </path>
        ))}
      </g>
    </g>
  )
}

export const SpiresBackground = () => {
  const isStill = useSyncExternalStore(subscribeToReducedMotion, prefersReducedMotion)
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid slice"
    >
      {spires.map((spire) => (
        <SpireStrands key={`${spire.x}-${spire.y}`} spire={spire} isStill={isStill} />
      ))}
    </svg>
  )
}
