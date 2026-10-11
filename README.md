# Autonomous Car Lane Selector — Decisions API Demo (real on-device AI)

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
