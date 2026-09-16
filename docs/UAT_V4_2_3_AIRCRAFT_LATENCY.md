# World Select v4.2.3 — Aircraft latency hotfix

- Replaces `Promise.allSettled()` with first-success `Promise.any()`.
- Fallback providers start with short hedge delays (0/250/500/750 ms).
- Per-provider timeout reduced to 2.8 s.
- Cloudflare Cache API stores successful regional snapshots for fast repeat loads.
- No UI feature changes; this is a fetch-latency hotfix.
