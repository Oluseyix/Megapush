import { useCallback, useMemo, useState } from 'react';
import {
  DEFAULT_NETWORK,
  HOUSE_BUY_URL,
  NETWORKS,
  REFERRER,
  gameUrl,
  shortAddress,
} from './config/networks';

type Mode = 'shell' | 'play';

function initialMode(): Mode {
  if (typeof window === 'undefined') return 'shell';
  return new URLSearchParams(window.location.search).get('play') === '1'
    ? 'play'
    : 'shell';
}

export default function App() {
  const network = DEFAULT_NETWORK;
  const cfg = NETWORKS[network];
  const [mode, setMode] = useState<Mode>(initialMode);

  const openPlay = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('play', '1');
    window.history.replaceState(null, '', url.pathname + url.search);
    setMode('play');
  }, []);

  const backToShell = useCallback(() => {
    const url = new URL(window.location.href);
    url.searchParams.delete('play');
    window.history.replaceState(null, '', url.pathname + url.search);
    setMode('shell');
  }, []);

  const iframeSrc = useMemo(() => gameUrl(network), [network]);

  if (mode === 'play') {
    return (
      <div className="play-frame">
        <div className="play-bar">
          <button type="button" className="ghost" onClick={backToShell}>
            ← Shell
          </button>
          <div className="brand-mini">
            MEGA<em>PUSH</em>
          </div>
          <span className="net-pill">{cfg.shortLabel}</span>
        </div>
        <iframe
          title="MegaPush game"
          src={iframeSrc}
          className="game-iframe"
          allow="clipboard-write; ethereum"
        />
      </div>
    );
  }

  return (
    <div className="shell">
      <div className="bg" aria-hidden />
      <header className="shell-header">
        <div className="brand">
          MEGA<em>PUSH</em>
        </div>
        <span className="net-pill">{cfg.label}</span>
      </header>

      <main className="shell-main">
        <p className="eyebrow">Aviator-style · Megapot tickets · {cfg.label}</p>
        <h1>Cash out for lottery tickets — house pays the USDC.</h1>
        <p className="lede">
          Stake from your wallet, ride the multiplier, cash out before it flies.
          Tickets ≈ floor(stake × mult). You are never charged USDC again on
          cash-out — the house buys tickets for you.
        </p>

        <div className="cta-row">
          <button type="button" className="primary" onClick={openPlay}>
            Play MegaPush
          </button>
          <a className="secondary" href={iframeSrc}>
            Open game.html
          </a>
        </div>

        <ol className="loop">
          <li>Connect wallet ({cfg.shortLabel})</li>
          <li>Stake from your wallet → climb</li>
          <li>Cash out → house buys Megapot tickets for you</li>
          <li>Tickets enter the daily draw</li>
          <li>Claim wins on-chain → USDC (from draw, not cash-out)</li>
        </ol>

        <section className="card">
          <h2>Config</h2>
          <dl className="kv">
            <div>
              <dt>Chain</dt>
              <dd>
                {cfg.label} · {cfg.chainId}
              </dd>
            </div>
            <div>
              <dt>RPC</dt>
              <dd className="mono">{cfg.rpc}</dd>
            </div>
            <div>
              <dt>REFERRER</dt>
              <dd className="mono" title={REFERRER}>
                {shortAddress(REFERRER)}
                {REFERRER.endsWith('0001') ? ' (placeholder)' : ''}
              </dd>
            </div>
            <div>
              <dt>HOUSE_BUY_URL</dt>
              <dd className="mono">
                {HOUSE_BUY_URL || '(empty → demo house)'}
              </dd>
            </div>
            <div>
              <dt>Jackpot</dt>
              <dd className="mono">{shortAddress(cfg.jackpot)}</dd>
            </div>
            <div>
              <dt>RandomBuyer</dt>
              <dd className="mono">{shortAddress(cfg.randomBuyer)}</dd>
            </div>
          </dl>
          <p className="hint">
            Edit <code>REFERRER</code> + <code>HOUSE_BUY_URL</code> at the top of
            the Megapot module in <code>public/game.html</code>.
          </p>
        </section>

        <footer className="shell-foot">
          <a href="https://docs.megapot.io" target="_blank" rel="noreferrer">
            Docs
          </a>
          <a
            href="https://llms.megapot.io/tasks/buy-random"
            target="_blank"
            rel="noreferrer"
          >
            Buy random
          </a>
          <a
            href="https://llms.megapot.io/tasks/claim-winnings"
            target="_blank"
            rel="noreferrer"
          >
            Claim
          </a>
        </footer>
      </main>
    </div>
  );
}
