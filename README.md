# TRAE Bridge VPS Demo

Minimal low-memory bridge demo for testing a persistent TRAE web login profile on a VPS.

## Local Run

```powershell
npm install
copy .env.example .env
npm start
```

For local Windows/macOS validation, use:

```env
HOST=127.0.0.1
PORT=39280
REMOTE_DISPLAY=false
HEADLESS_SERVICE=false
```

Open `http://127.0.0.1:39280/admin`, enter `ADMIN_PASSWORD`, then start login mode. A local Chrome window opens and saves login state in `data/profile/`.

Run the adapter-only test:

```powershell
npm run test:adapter
```

## VPS Run

On a headless VPS, install temporary login-mode dependencies:

```bash
sudo apt update
sudo apt install -y xvfb x11vnc novnc websockify
```

Login mode starts `Xvfb + x11vnc + noVNC` only when requested. Open the noVNC URL shown in `/admin`, finish TRAE login, then stop login mode and use service mode.

If the TRAE login dialog returns a region/risk `403`, route Chrome through a proxy:

```env
PROXY_SERVER=http://host:port
# or socks5://host:port
PROXY_USERNAME=
PROXY_PASSWORD=
```

## Shape

- `/admin` small management UI
- `/admin/api/browser/start-login` starts headful login mode
- `/admin/api/browser/start-service` starts headless service mode
- `/v1/models` and `/v1/chat/completions` expose an OpenAI-compatible shell
- `data/profile/` stores the persistent browser profile

This demo does not extract cookies or tokens. It reuses the official browser login state through a persistent profile.
