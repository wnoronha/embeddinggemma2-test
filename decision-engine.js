// Real Decision API engine: MediaPipe + EmbeddingGemma.
// Primary:   MediaPipe DecisionMaker (@mediapipe/tasks-decision) + EmbeddingGemma-2 270M (.litertlm, HF)
// Fallback:  MediaPipe TextEmbedder (@mediapipe/tasks-text) + EmbeddingGemma 300M (.task, GCS)
//            choice ranking via cosine similarity, argmax (no probabilities anywhere).
// The engine returns a lane number only: { chosen, similarities, latencyMs, engine }.
// Similarities are raw cosine scores (audit aid), not probabilities.
//
// Verified model URLs (2026-10-11):
// - TextEmbedder .task -> 200 OK, 183MB:
//   https://storage.googleapis.com/mediapipe-models/text_embedder/embedding_gemma/int4int8/latest/embedding_gemma.task
// - DecisionMaker docs URL 404s, so we use the official sample app's HF model:
//   https://huggingface.co/litert-community/embeddinggemma-2-text-270m-litert-lm
//   (file embeddinggemma-2-text-270m.litertlm, ~165MB, CORS-enabled)

const DECISION_WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-decision@1.1.0/wasm";
const TEXT_WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-text@1.1.0/wasm";

export const DECISION_MODEL_URL =
  "https://huggingface.co/litert-community/embeddinggemma-2-text-270m-litert-lm/resolve/main/embeddinggemma-2-text-270m.litertlm";
export const EMBED_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/text_embedder/embedding_gemma/int4int8/latest/embedding_gemma.task";

export function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export function argmaxLaneOf(arr) {
  let best = 0;
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > arr[best]) best = i;
  }
  return best + 1; // lanes are 1-indexed
}

export function parseLaneKey(key) {
  const m = String(key).match(/lane[_-]?(\d)/i);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 3) return n;
  }
  return null;
}

// Convert the demo's Decision-API-style payload into a MediaPipe ChoiceQuestion.
export function payloadToChoiceQuestion(payload) {
  const q = payload?.questions?.[0];
  const options = (q?.choices || []).map((c) => ({
    label: c.value,
    description: c.description,
  }));
  return {
    instructions: q?.instructions || "Identify the safest lane that is clear of roadblocks.",
    context: "Autonomous vehicle lane selection on a 3-lane highway.",
    options,
    normalizePrior: true,
  };
}

const engine = {
  status: "idle", // idle | loading-decision | loading-embed | ready-decision | ready-embed | failed
  engineName: "none",
  modelUrl: null,
  loadError: null,
  loadProgress: "",
  _decisionMaker: null,
  _embedder: null,
  _TextEmbedderNS: null,
};

function setStatus(patch) {
  Object.assign(engine, patch);
  try {
    const dot = document.getElementById("serverStatusDot");
    const txt = document.getElementById("serverStatusText");
    const eng = document.getElementById("engineDisplay");
    if (eng) {
      if (engine.status === "ready-decision") eng.textContent = "DecisionMaker + EmbeddingGemma2-270M";
      else if (engine.status === "ready-embed") eng.textContent = "TextEmbedder + EmbeddingGemma-300M";
      else if (engine.status.startsWith("loading")) eng.textContent = `Loading… ${engine.loadProgress}`;
      else if (engine.status === "failed") eng.textContent = "model failed — car holding lane";
      else eng.textContent = "initializing…";
    }
    if (txt) {
      if (engine.status === "ready-decision") txt.textContent = "On-device AI: EmbeddingGemma2 DecisionMaker";
      else if (engine.status === "ready-embed") txt.textContent = "On-device AI: EmbeddingGemma TextEmbedder";
      else if (engine.status.startsWith("loading")) txt.textContent = `Loading model… ${engine.loadProgress}`;
      else if (engine.status === "failed") txt.textContent = `Model failed — car holding lane`;
      else txt.textContent = "Initializing…";
      txt.title = engine.loadError || engine.modelUrl || "";
    }
    if (dot) {
      dot.className = "status-dot " + (
        engine.status.startsWith("ready") ? "connected" :
        engine.status.startsWith("loading") || engine.status === "idle" ? "loading" : "failed"
      );
    }
  } catch { /* DOM not ready yet */ }
  window.dispatchEvent(new CustomEvent("decision-engine-status", { detail: { ...engine } }));
}

export function getEngineStatus() {
  return { status: engine.status, engineName: engine.engineName, modelUrl: engine.modelUrl, error: engine.loadError };
}

export function isModelReady() {
  return engine.status === "ready-decision" || engine.status === "ready-embed";
}

async function tryInitDecisionMaker() {
  setStatus({ status: "loading-decision", loadProgress: "decision wasm…", modelUrl: DECISION_MODEL_URL });
  const mod = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-decision@1.1.0/decision_bundle.mjs");
  const { DecisionMaker, FilesetResolver } = mod;
  const fileset = await FilesetResolver.forDecisionTasks(DECISION_WASM_BASE);
  setStatus({ loadProgress: "downloading EmbeddingGemma2-270M (~165MB)…" });
  let maker;
  try {
    maker = await DecisionMaker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: DECISION_MODEL_URL, delegate: "GPU" },
      maxNumTokens: 512,
    });
  } catch (e) {
    // GPU delegate often fails on desktop WASM — retry CPU before giving up.
    console.warn("[decision-engine] GPU init failed, retrying CPU:", e);
    maker = await DecisionMaker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: DECISION_MODEL_URL, delegate: "CPU" },
      maxNumTokens: 512,
    });
  }
  // Warm-up call proves the model actually runs before we claim "ready".
  const warmQ = {
    instructions: "Identify the safest lane that is clear of roadblocks.",
    options: [
      { label: "lane_1", description: "Lane 1 is completely clear with unobstructed open road" },
      { label: "lane_2", description: "Lane 2 is completely clear with unobstructed open road" },
      { label: "lane_3", description: "Lane 3 is completely clear with unobstructed open road" },
    ],
    normalizePrior: true,
  };
  await maker.evaluateChoice("Completely clear with unobstructed open road", warmQ);
  engine._decisionMaker = maker;
  setStatus({ status: "ready-decision", engineName: "mediapipe-decisionmaker/embeddinggemma-2-270M", loadProgress: "ready" });
  console.info("[decision-engine] READY: DecisionMaker + EmbeddingGemma2-270M");
}

async function tryInitTextEmbedder() {
  setStatus({ status: "loading-embed", loadProgress: "text wasm…", modelUrl: EMBED_MODEL_URL });
  const mod = await import("https://cdn.jsdelivr.net/npm/@mediapipe/tasks-text@1.1.0/text_bundle.mjs");
  const { TextEmbedder, FilesetResolver } = mod;
  const fileset = await FilesetResolver.forTextTasks(TEXT_WASM_BASE);
  setStatus({ loadProgress: "downloading EmbeddingGemma-300M (~184MB)…" });
  const embedder = await TextEmbedder.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: EMBED_MODEL_URL },
  });
  // Warm-up: real embed calls. Throws if the model is corrupt.
  embedder.embed("warmup clear open road", { type: "SEMANTIC_SIMILARITY" });
  engine._embedder = embedder;
  engine._TextEmbedderNS = { TextEmbedder };
  setStatus({ status: "ready-embed", engineName: "mediapipe-textembedder/embeddinggemma-300M", loadProgress: "ready" });
  console.info("[decision-engine] READY: TextEmbedder + EmbeddingGemma-300M (fallback path)");
}

export async function initDecisionEngine() {
  setStatus({ status: "loading-decision", loadProgress: "starting…" });
  try {
    await tryInitDecisionMaker();
    return engine;
  } catch (e1) {
    console.warn("[decision-engine] DecisionMaker init failed, trying TextEmbedder fallback:", e1);
    try {
      await tryInitTextEmbedder();
      return engine;
    } catch (e2) {
      console.error("[decision-engine] ALL model init failed:", e2);
      setStatus({ status: "failed", engineName: "none", loadError: String(e2?.message || e2) });
      return engine;
    }
  }
}

// Core Decision API: query + choice descriptions -> winning lane number.
// Returns { chosen, similarities, latencyMs, engine }.
// `chosen` ALWAYS comes from the model (selectedKey / argmax of cosine sims).
// No probabilities, no confidence scores, nothing hardcoded.
export async function evaluateLaneChoice(payload) {
  if (engine.status === "ready-decision" && engine._decisionMaker) {
    const question = payloadToChoiceQuestion(payload);
    const t0 = performance.now();
    const result = await engine._decisionMaker.evaluateChoice(payload.query, question);
    const latencyMs = Math.round(performance.now() - t0);
    const chosen = parseLaneKey(result.selectedKey) ?? 2;
    console.info(`[decision-engine/engine=decisionmaker] chosen=${chosen} selectedKey=${result.selectedKey} ${latencyMs}ms`);
    return { chosen, similarities: null, latencyMs, engine: engine.engineName, raw: result };
  }
  if (engine.status === "ready-embed" && engine._embedder) {
    const t0 = performance.now();
    const q = payload?.questions?.[0];
    const queryEmb = engine._embedder.embed(payload.query, { type: "SEMANTIC_SIMILARITY" }).embeddings[0];
    const sims = [];
    for (const c of q.choices) {
      const cEmb = engine._embedder.embed(c.description, { type: "SEMANTIC_SIMILARITY" }).embeddings[0];
      sims.push(engine._TextEmbedderNS.TextEmbedder.cosineSimilarity(queryEmb, cEmb));
    }
    const latencyMs = Math.round(performance.now() - t0);
    const chosen = argmaxLaneOf(sims);
    console.info(`[decision-engine/engine=textembedder] sims=${sims.map((s) => s.toFixed(3))} chosen=${chosen} ${latencyMs}ms`);
    return { chosen, similarities: { 1: sims[0], 2: sims[1], 3: sims[2] }, latencyMs, engine: engine.engineName };
  }
  throw new Error(`model not ready (status=${engine.status})`);
}

// Legacy global for game.js (classic script). Module sets window.DecisionEngine.
if (typeof window !== "undefined") {
  window.DecisionEngine = {
    initDecisionEngine,
    evaluateLaneChoice,
    isModelReady,
    getEngineStatus,
    payloadToChoiceQuestion,
    DECISION_MODEL_URL,
    EMBED_MODEL_URL,
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => { setStatus({}); initDecisionEngine(); });
  } else {
    setStatus({});
    initDecisionEngine();
  }
}
