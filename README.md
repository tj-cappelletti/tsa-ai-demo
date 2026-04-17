# tsa-ai-demo

Browser-based neon air-hockey demo using:
- **three.js** (WebGL rendering)
- **Rapier3D** (physics)
- **MediaPipe Hands** (webcam hand tracking)
- **PeerJS** (host/join sync)

## Run locally

```bash
cd /home/runner/work/tsa-ai-demo/tsa-ai-demo
npm install
python3 -m http.server 8080
```

Open `http://localhost:8080` in two browser tabs/windows for host/join testing.

## Controls

- Allow webcam access.
- Move your hand (index fingertip tracked) to move your mallet.
- Click **Host** to generate a peer ID, or paste peer ID and click **Join**.
- Use the music slider to adjust background volume.
