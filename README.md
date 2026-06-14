# TRAE Bridge VPS Demo

Minimal low-memory bridge demo for testing a persistent TRAE web login profile on a VPS.

## Run

```powershell
npm install
copy .env.example .env
npm start
```

Open `http://127.0.0.1:39280/admin`, enter `ADMIN_PASSWORD`, then start login mode.

## Shape

- `/admin` small management UI
- `/admin/api/browser/start-login` starts headful login mode
- `/admin/api/browser/start-service` starts headless service mode
- `/v1/models` and `/v1/chat/completions` expose an OpenAI-compatible shell
- `data/profile/` stores the persistent browser profile

This demo does not extract cookies or tokens. It reuses the official browser login state through a persistent profile.
