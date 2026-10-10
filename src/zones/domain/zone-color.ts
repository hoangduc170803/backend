export const ZONE_COLOR_PALETTE = [
  '#2563eb',
  '#dc2626',
  '#16a34a',
  '#d97706',
  '#7c3aed',
  '#0891b2',
  '#db2777',
  '#65a30d',
  '#ea580c',
  '#0d9488',
  '#9333ea',
  '#ca8a04',
  '#e11d48',
  '#4f46e5',
  '#059669',
  '#c026d3',
  '#0284c7',
  '#b45309',
  '#15803d',
  '#be123c',
] as const;

export function pickLeastUsedColor(
  palette: readonly string[],
  usedColors: readonly string[],
): string {
  const usage = new Map<string, number>();
  for (const color of usedColors) {
    usage.set(color, (usage.get(color) ?? 0) + 1);
  }
  let best = palette[0];
  let bestCount = Infinity;
  for (const color of palette) {
    const count = usage.get(color) ?? 0;
    if (count < bestCount) {
      bestCount = count;
      best = color;
    }
  }
  return best;
}
