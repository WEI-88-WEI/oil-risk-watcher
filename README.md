# Oil Risk Watcher

24/7 server-side monitor for Yahoo Finance crude oil futures alerts.

## Current rules

- `BZ=F` (BRENTOIL): alert when price rises to within 5 of liquidation, danger within 3
- `CL=F` (CL): alert when price falls to within 5 of liquidation, danger within 3
- Normal polling: every 60s
- Danger polling + reminders: every 10s
- Warn cooldown: 2 minutes
- No clear/exit notifications

## Commands

```bash
npm start
npm run test:fetch
npm run test:alert
```

## Deployment

The repository includes a systemd unit at `oil-risk-watcher/deploy/oil-risk-watcher.service`.
