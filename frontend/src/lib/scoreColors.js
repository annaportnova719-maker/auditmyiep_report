// Unified score color rule — matches the app's teal/gold/green palette in
// index.css, just as hex values for use in inline SVG/style props.

const RANGES = [
  { min: 85, fill: '#1E8A5B', text: '#166B45' }, // brand green
  { min: 65, fill: '#C07A1E', text: '#8F5A14' }, // brand gold/amber
  { min: 45, fill: '#C9622C', text: '#9C4A20' }, // warm orange
  { min: 0,  fill: '#B7402F', text: '#8E2F25' }, // brand red
]

function pick(score) {
  const s = Math.max(0, Math.min(100, score))
  return RANGES.find((r) => s >= r.min) || RANGES[RANGES.length - 1]
}

export function scoreColor(score) {
  return pick(score).fill
}

export function scoreTextColor(score) {
  return pick(score).text
}
