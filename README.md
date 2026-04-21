# BrainOS · Guardian Control Panel

**BrainOS-v2.html** — Single-file canvas control panel for the Guardian/NEXUS bridge mesh.

## Features
- Live canvas mesh showing Guardian, NEXUS, Bridge, and Callto nodes
- Nodes turn red with animated ring when pulse stops (30s timeout)
- Right-click any node: connect, disconnect, repair, diagnose, wire callto
- Short ID display — copy to share with other systems
- Labeled pulse packets on tunnel lines (green=guardian, purple=callto, cyan=data)
- Pipeline builder: chain AI steps, Guardian as first-class node type
- SSE events auto-create nodes: guardian-pulse → Guardian node, callto.captured → Callto node

## Connection
The bridge must be running: `node bridge/nexus-bridge-server.js`

Bridge now listens on `0.0.0.0` — connect from any device on your LAN:
1. Open `BrainOS-v2.html` in a browser
2. Enter your bridge URL: `http://{LAN_IP}:3747` (find it with `GET /network/info`)
3. Click SCAN — nodes appear on canvas

## Versions
- Bridge: v3.11.0
- Guardian: v3.4.0  
- NEXUS: v0.51.0

## API Reference
See `guardian-bridge-api.html` for the complete endpoint reference.
