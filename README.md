# System-One Racer — Jev vs OpenAI vs Local EmbeddingGemma (fair-race demo)

Three cars, each with its own 3 lanes, racing the **same road**. One canonical
obstacle set is mirrored to every track, one shared `state` is built, and the
same lane-choice question is fanned out **in parallel** (`Promise.allSettled`)
to three decision providers. Pure client-side; API keys stay in `localStorage`.

| Track | Provider | Wire format | Returns |
| --- | --- | --- | --- |
| Local | MediaPipe `DecisionMaker` + `embeddinggemma-2-text-270m` (fallback `TextEmbedder` + `embedding_gemma.task`) | on-device | lane only (+ cosine sims on fallback path) |

Model weights (~165MB) download once and persist in the Cache API
(`decision-models-v1`); reloads serve from cache with a live `%` progress readout
while downloading. `DecisionEngine.clearModelCache()` (DevTools console) wipes it.
| Jev | `POST https://api.typesafe.ai/v1/systemone` (`jev-latest`) | `{ state, model, questions: { lane_choice: { type: "choice", instructions, criteria } } }` | `choice` + `probabilities` + `confidence` |
| OpenAI | `POST https://api.openai.com/v1/decisions` (`gpt-6-luna`, native `choice`) | `{ model, input, questions: [{ type: "choice", name, instructions, choices }] }` | `choice` + `probabilities` + `confidence` |

## Run it

```bash
python3 server.py 8080   # static files + POST /api/jev proxy (required for Jev)
```

Open `http://localhost:8080`. (`python3 -m http.server` serves the page but Jev
calls will fail: `api.typesafe.ai` answers CORS preflights with HTTP 400 and no
`Access-Control-Allow-Origin`, so browsers refuse direct `fetch()`. OpenAI works
direct — it sends `Access-Control-Allow-Origin: *`.)

## Fair-race rule

`race.js` (`RaceController`) owns the canonical lanes. `Block 1/2/3`, `Random`,
`Clear` write once and clone to all `CarTrack` obstacles. Random tracks loop
fixed lanes (no per-track divergent re-roll). Each tick builds one
`buildLaneState(blockedLanes)` (`providers.js`) and injects per-car
`currentLane` before the parallel fan-out.

## Auto race (self-running grid)

`Auto race: on` (default) keeps the grid alive with zero clicks: crashed cars
auto-recover after ~3s (overlapping barriers are nudged back up so they don't
instantly re-crash) and a fresh 1–2-lane wave spawns ~7s after the previous one
clears the cars. A deliberate pause (all cars paused, none crashed) suspends
waves. Toggle it off for fully manual control.

An interactive, pure client-side autonomous vehicle lane selection demo powered by
**real on-device inference**: MediaPipe + EmbeddingGemma.

## How the AI really works (not faked)

- **Primary engine:** MediaPipe `@mediapipe/tasks-decision` **DecisionMaker** +
  `embeddinggemma-2-text-270m.litertlm` (HuggingFace `litert-community`, ~165MB).
  The game's Decision-API-style payload (`query` + 3 lane `choices`) is passed to
  `decisionMaker.evaluateChoice(query, {instructions, options, normalizePrior})`.
  Returned `selectedKey` drives the steering — lane number only, no probabilities.
- **Fallback engine:** MediaPipe `@mediapipe/tasks-text` **TextEmbedder** +
  `embedding_gemma.task` (GCS `mediapipe-models`, ~184MB). Query and each lane
  description are embedded (`SEMANTIC_SIMILARITY`), ranked by raw cosine similarity,
  argmax wins. See `decision-engine.js`.
- **Honesty rules:** the car steers ONLY from a model result. Until the model loads
  it shows `Waiting for model…` and holds its lane; if both models fail it holds its
  lane. Road-clear and all-blocked states also hold (no model call needed).
  Per-inference `chosen / sims / latency` are logged to the DevTools console and
  shown in the debug row. There is no heuristic steering and no probability code.

## Features
- **3-Lane Highway Simulation**: Smooth canvas animation with real-time scrolling highway markers, top-down sedan, and obstacle collision dynamics.
- **Decision Engine Logic**: Evaluates road conditions against a choice schema (`lane_1`, `lane_2`, `lane_3`) via real EmbeddingGemma inference; winning lane drives steering.
- **Dynamic Obstacle Spawning**: Block specific lanes with toggleable barriers or generate random continuous obstacles (`1 Random`, `2 Random`).
- **Collision & Crash Physics**: Visual damage detection with crack effects and particle explosions.
- **Zero Dependencies**: Pure HTML, CSS, and JavaScript. Runs directly in any web browser or via GitHub Pages.

## Local Development
Run with Python's built-in web server:
```bash
python3 -m http.server 8080
```
Open [http://localhost:8080](http://localhost:8080) in your browser.
