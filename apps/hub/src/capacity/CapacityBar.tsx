/**
 * One person, one bar.
 *
 * Colour is never the only signal: the bar always ships with the load
 * percentage as a number and, when it is over the threshold or built on
 * an incomplete capacity record, with a marker badge as well.
 */
import type { CSSProperties } from 'react';
import type { CapacityFigures } from './load';

export type CapacityBarProps = {
  readonly figures: CapacityFigures;
  /** Rendered into the bar's accessible name instead of the default. */
  readonly label?: string;
};

type BarStyle = CSSProperties & {
  '--eg-bar-value': string;
  '--eg-bar-threshold': string;
};

/**
 * The track alone. `data-over` drives the colour, `aria-label` carries
 * the same information for a screen reader, and an unknown denominator
 * renders an empty dashed track rather than a full one.
 */
export function CapacityBar({ figures, label }: CapacityBarProps): JSX.Element {
  const style: BarStyle = {
    '--eg-bar-value': `${figures.barPercent}%`,
    '--eg-bar-threshold': `${figures.thresholdPercent}%`,
  };
  return (
    <div
      className="eg-bar eg-capacity__bar"
      data-over={figures.over ? 'true' : 'false'}
      data-unknown={figures.hasCapacity ? 'false' : 'true'}
      style={style}
      role="img"
      aria-label={label ?? figures.summary}
    >
      <div className="eg-bar__fill" />
      <div
        className="eg-bar__threshold"
        data-over={figures.over ? 'true' : 'false'}
      />
    </div>
  );
}

export default CapacityBar;
