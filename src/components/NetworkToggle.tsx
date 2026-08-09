import type { NetworkKey } from '../config/networks';
import { NETWORKS } from '../config/networks';

type Props = {
  value: NetworkKey;
  onChange: (key: NetworkKey) => void;
  size?: 'sm' | 'md';
};

export function NetworkToggle({ value, onChange, size = 'md' }: Props) {
  return (
    <div
      className={`net-toggle net-toggle--${size}`}
      role="group"
      aria-label="Network"
    >
      {(Object.keys(NETWORKS) as NetworkKey[]).map((key) => (
        <button
          key={key}
          type="button"
          className={value === key ? 'on' : undefined}
          onClick={() => onChange(key)}
        >
          {NETWORKS[key].shortLabel}
        </button>
      ))}
    </div>
  );
}
