// Unified score color rule — matches the app's teal/gold/green palette in
// index.css, just as hex values for use in inline SVG/style props.

const RANGES = [
  { min: 85, fill: '#178a52', text: '#136b40' }, // rich green
  { min: 65, fill: '#d99a2b', text: '#a3721c' }, // gold/amber
  { min: 45, fill: '#e0793f', text: '#b5551f' }, // warm orange
  { min: 0,  fill: '#c33f36', text: '#9c2f28' }, // brick red
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
