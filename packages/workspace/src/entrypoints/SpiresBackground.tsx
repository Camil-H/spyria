import { useId, useSyncExternalStore } from 'react'

type Depth = 'far' | 'mid' | 'near'
type Layer = {
  depth: Depth
  count: number
  apex: number
  lean: number
  radius: number
  twist: number
  width: number
  turnSeconds: number
  hasPulses: boolean
  hasThresholds: boolean
}
type Spire = Layer & { x: number; key: string }
type Point = readonly [number, number]

const reducedMotionQuery = '(prefers-reduced-motion: reduce)'
const baseY = 104
const pixel = 0.075
const vanishingPoint: Point = [50, 16]
const pointsPerStrand = 48
const turnSteps = 6
const toneOf: Record<Depth, string> = {
  far: 'text-spire-far',
  mid: 'text-spire-mid',
  near: 'text-spire-near',
}
const layers: readonly Layer[] = [
  {
    depth: 'far',
    count: 7,
    apex: 36,
    lean: 0.8,
    radius: 2.4,
    twist: 2.6,
    width: 1,
    turnSeconds: 46,
    hasPulses: false,
    hasThresholds: false,
  },
  {
    depth: 'mid',
    count: 5,
    apex: 28,
    lean: 0.6,
    radius: 4,
    twist: 2.2,
    width: 1.4,
    turnSeconds: 34,
    hasPulses: true,
    hasThresholds: false,
  },
  {
    depth: 'near',
    count: 4,
    apex: 20,
    lean: 0.4,
    radius: 6.5,
    twist: 1.8,
    width: 2,
    turnSeconds: 26,
    hasPulses: true,
    hasThresholds: true,
  },
]

const seededRandom = (seed: number) => {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296
  }
}

const edgenessOf = (x: number) => Math.min(Math.abs(x - vanishingPoint[0]) / 50, 1)

const spiresOf = (layer: Layer, random: () => number): Spire[] =>
  Array.from({ length: layer.count }, (_, index) => {
    const x = ((index + 0.5) / layer.count) * 124 - 12 + (random() - 0.5) * (70 / layer.count)
    const edgeness = edgenessOf(x)
    return {
      ...layer,
      x,
      apex: layer.apex - 16 * edgeness ** 1.5,
      lean: layer.lean * (1 - 0.6 * edgeness),
      key: `${layer.depth}-${index}`,
    }
  })

const random = seededRandom(11)
const spires = layers.flatMap((layer) => spiresOf(layer, random))
const motes = Array.from({ length: 26 }, (_, index) => ({
  key: `mote-${index}`,
  x: random() * 100,
  radius: 0.12 + random() * 0.3,
  seconds: 16 + random() * 20,
  delay: random(),
}))

const heightOf = (spire: Spire, along: number) => baseY - along * (baseY - spire.apex)
const radiusOf = (spire: Spire, along: number) => spire.radius * (1 - along) ** 1.15 + 0.1
const axisOf = (spire: Spire, along: number) => spire.x + (vanishingPoint[0] - spire.x) * spire.lean * along ** 1.6
const strandPointOf = (spire: Spire, along: number, phase: number): Point => [
  axisOf(spire, along) + radiusOf(spire, along) * Math.sin(spire.twist * along * 2 * Math.PI + phase),
  heightOf(spire, along),
]

const format = (value: number) => value.toFixed(2)
const smoothPathOf = (points: readonly Point[]) => {
  const at = (index: number) => points[Math.min(Math.max(index, 0), points.length - 1)] ?? [0, 0]
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

const strandShapesOf = (spire: Spire, strandPhase: number) =>
  Array.from({ length: turnSteps + 1 }, (_, step) =>
    smoothPathOf(
      Array.from({ length: pointsPerStrand }, (_, index) =>
        strandPointOf(spire, index / (pointsPerStrand - 1), strandPhase + (step / turnSteps) * 2 * Math.PI),
      ),
    ),
  )

const linksOf = (linked: readonly Spire[]) => {
  const byPosition = linked.toSorted((first, second) => first.x - second.x)
  return byPosition.slice(1).flatMap((to, index) => {
    const from = byPosition[index]
    if (!from) return []
    const [fromAlong, toAlong] = index % 2 === 0 ? [0.22, 0.58] : [0.4, 0.8]
    const start: Point = [axisOf(from, fromAlong) + radiusOf(from, fromAlong), heightOf(from, fromAlong)]
    const end: Point = [axisOf(to, toAlong) - radiusOf(to, toAlong), heightOf(to, toAlong)]
    const lift = (start[1] - end[1]) * 0.6
    const controls = [start[0], start[1] - lift, end[0], end[1] + lift, ...end].map(format).join(' ')
    return [
      {
        key: `link-${from.key}-${to.key}`,
        d: `M${format(start[0])} ${format(start[1])}C${controls}`,
        seconds: 9 + index * 2.5,
      },
    ]
  })
}
const links = linksOf(spires.filter((spire) => spire.depth !== 'far'))

const subscribeToReducedMotion = (onChange: () => void) => {
  const query = matchMedia(reducedMotionQuery)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}
const prefersReducedMotion = () => matchMedia(reducedMotionQuery).matches

const TravellingLight = ({ seconds, delay = 0 }: { seconds: number; delay?: number }) => (
  <animate
    attributeName="stroke-dashoffset"
    values="100;0"
    dur={`${seconds}s`}
    begin={`${-delay * seconds}s`}
    repeatCount="indefinite"
  />
)

const Strand = ({
  spire,
  strandPhase,
  tipFadeId,
  isStill,
}: {
  spire: Spire
  strandPhase: number
  tipFadeId: string
  isStill: boolean
}) => {
  const shapes = strandShapesOf(spire, strandPhase)
  const turning = !isStill && (
    <animate attributeName="d" values={shapes.join(';')} dur={`${spire.turnSeconds}s`} repeatCount="indefinite" />
  )
  return (
    <>
      <path
        d={shapes[0]}
        fill="none"
        stroke={`url(#${tipFadeId})`}
        strokeWidth={spire.width * pixel}
        strokeLinecap="round"
      >
        {turning}
      </path>
      {spire.hasPulses && !isStill && (
        <path
          d={shapes[0]}
          fill="none"
          className="text-spire-light"
          stroke="currentColor"
          strokeWidth={spire.width * 1.8 * pixel}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray="5 95"
        >
          {turning}
          <TravellingLight seconds={spire.turnSeconds / 2} delay={strandPhase / (2 * Math.PI)} />
        </path>
      )}
    </>
  )
}

const Threshold = ({ spire, along, isStill }: { spire: Spire; along: number; isStill: boolean }) => {
  const width = radiusOf(spire, along) * 1.7
  const seconds = spire.turnSeconds * 0.7 + along * 10
  const timing = { keyTimes: '0;0.3;0.7;1', dur: `${seconds}s`, begin: `${-along * seconds}s` }
  return (
    <ellipse
      cx={axisOf(spire, along)}
      cy={heightOf(spire, along)}
      rx={width}
      ry={width * 0.26}
      fill="none"
      className="text-spire-light"
      stroke="currentColor"
      strokeWidth={spire.width * 0.8 * pixel}
      opacity={isStill ? 0.6 : 0}
    >
      {!isStill && (
        <>
          <animate attributeName="rx" values={`0;${width};${width};0`} {...timing} repeatCount="indefinite" />
          <animate
            attributeName="ry"
            values={`0;${width * 0.26};${width * 0.26};0`}
            {...timing}
            repeatCount="indefinite"
          />
          <animate attributeName="opacity" values="0;0.9;0.9;0" {...timing} repeatCount="indefinite" />
        </>
      )}
    </ellipse>
  )
}

const Mote = ({ mote, isStill }: { mote: (typeof motes)[number]; isStill: boolean }) => {
  const timing = { dur: `${mote.seconds}s`, begin: `${-mote.delay * mote.seconds}s` }
  return (
    <circle cx={mote.x} cy={isStill ? 84 - mote.delay * 66 : 86} r={mote.radius} fill="currentColor">
      {!isStill && (
        <>
          <animate attributeName="cy" values="86;14" {...timing} repeatCount="indefinite" />
          <animate
            attributeName="opacity"
            values="0;0.9;0.9;0"
            keyTimes="0;0.15;0.75;1"
            {...timing}
            repeatCount="indefinite"
          />
        </>
      )}
    </circle>
  )
}

export const SpiresBackground = () => {
  const isStill = useSyncExternalStore(subscribeToReducedMotion, prefersReducedMotion)
  const glowId = useId()
  const fadeId = useId()
  return (
    <svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 100 100"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <radialGradient id={glowId} cx="50" cy="14" r="60" gradientUnits="userSpaceOnUse">
          <stop offset="0" className="text-spire-glow" stopColor="currentColor" />
          <stop offset="1" className="text-spire-glow" stopColor="currentColor" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${fadeId}-gradient`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0.15" stopColor="white" stopOpacity="0.4" />
          <stop offset="0.45" stopColor="white" />
          <stop offset="1" stopColor="white" stopOpacity="0.85" />
        </linearGradient>
        <mask id={fadeId} maskUnits="userSpaceOnUse" x="-20" y="-20" width="140" height="140">
          <rect x="-20" y="-20" width="140" height="140" fill={`url(#${fadeId}-gradient)`} />
        </mask>
      </defs>
      <rect x="-20" y="-20" width="140" height="140" fill={`url(#${glowId})`} />
      <g mask={`url(#${fadeId})`}>
        {spires.map((spire) => (
          <g key={spire.key} className={toneOf[spire.depth]}>
            <defs>
              <linearGradient
                id={`${fadeId}-${spire.key}`}
                x1="0"
                y1={spire.apex}
                x2="0"
                y2={spire.apex + 22}
                gradientUnits="userSpaceOnUse"
              >
                <stop offset="0" stopColor="currentColor" stopOpacity="0" />
                <stop offset="1" stopColor="currentColor" />
              </linearGradient>
            </defs>
            <Strand spire={spire} strandPhase={0} tipFadeId={`${fadeId}-${spire.key}`} isStill={isStill} />
            <Strand spire={spire} strandPhase={Math.PI} tipFadeId={`${fadeId}-${spire.key}`} isStill={isStill} />
            {spire.hasThresholds &&
              [0.42].map((along) => <Threshold key={along} spire={spire} along={along} isStill={isStill} />)}
          </g>
        ))}
        <g className="text-spire-mid">
          {links.map((link) => (
            <g key={link.key}>
              <path d={link.d} fill="none" stroke="currentColor" strokeWidth={pixel} />
              {!isStill && (
                <path
                  d={link.d}
                  fill="none"
                  className="text-spire-light"
                  stroke="currentColor"
                  strokeWidth={2 * pixel}
                  strokeLinecap="round"
                  pathLength={100}
                  strokeDasharray="8 92"
                >
                  <TravellingLight seconds={link.seconds} />
                </path>
              )}
            </g>
          ))}
        </g>
        <ellipse
          cx="50"
          cy="72"
          rx="30"
          ry="4.5"
          fill="none"
          className="text-spire-near"
          stroke="currentColor"
          strokeWidth={1.6 * pixel}
          pathLength={100}
          strokeDasharray={isStill ? '100 0' : '0 100'}
        >
          {!isStill && (
            <animate
              attributeName="stroke-dasharray"
              values="0 100;100 0;100 0;0 100"
              keyTimes="0;0.4;0.6;1"
              dur="28s"
              repeatCount="indefinite"
            />
          )}
        </ellipse>
        <g className="text-spire-light">
          {motes.map((mote) => (
            <Mote key={mote.key} mote={mote} isStill={isStill} />
          ))}
        </g>
      </g>
    </svg>
  )
}
