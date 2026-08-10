# Product decisions (internal)

1. Play bank, escrow-backed settlement path  
2. One global crash curve; cashout mult at server arrival time  
3. USDC bankroll caps (`MAX_ROUND_EXPOSURE`, hourly / per-entry limits)  
4. Deploy on Workers + Static Assets with Durable Objects  

Implementation lives under `cf-worker/` and `contracts/`. Do not document live hostnames, admin paths, or secret values in the repo.
