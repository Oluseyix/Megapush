# Product decisions

1. Play bank, escrow-backed settlement path (`requestWithdraw` → challenge → `withdraw`)  
2. One global crash curve; cashout mult at server arrival time  
3. **`ROUND_SECRET` required** — no house-key fallback; no public default; no betting without it  
4. USDC bankroll caps (`MAX_ROUND_EXPOSURE`, hourly / per-entry limits)  
5. Deploy on **Workers + Static Assets** with Durable Objects only  
6. **`ADMIN_TOKEN`**: admin DO routes exist only when set; otherwise **404**  

Player-facing withdraw and verify recipes: root `README.md`.  
