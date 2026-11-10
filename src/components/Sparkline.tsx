import Svg, { Polyline } from 'react-native-svg';

import type { RatePoint } from '@/api/types';
import { colors } from '@/theme';

/**
 * Turn rate points into SVG polyline coordinates.
 * Floats are fine here: this is pixel geometry for a small chart, not money
 * arithmetic. Nothing computed here is ever shown as a number.
 */
export function sparklinePoints(points: readonly RatePoint[], width: number, height: number, padding = 2): string {
  const values = points.map((point) => Number(point.rate)).filter((value) => Number.isFinite(value));
  if (values.length < 2) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;
  const innerWidth = width - padding * 2;
  const innerHeight = height - padding * 2;
  return values
    .map((value, index) => {
      const x = padding + (index / (values.length - 1)) * innerWidth;
      const y = range === 0 ? height / 2 : padding + (1 - (value - min) / range) * innerHeight;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/** Decorative trend line. The rate itself is always shown as text beside it. */
export function Sparkline({ points, width = 72, height = 28 }: { points: readonly RatePoint[]; width?: number; height?: number }) {
  const path = sparklinePoints(points, width, height);
  if (path === '') return null;
  return (
    <Svg width={width} height={height} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" aria-hidden>
      <Polyline points={path} fill="none" stroke={colors.primary} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
    </Svg>
  );
}
