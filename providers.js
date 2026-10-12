// Race providers: shared lane-state builder + remote System-One / LLM decision APIs.
// Classic script (no modules) -> exposes window.RaceProviders.
// Local on-device engine (decision-engine.js) stays as the baseline provider.

(function () {
  "use strict";

  var JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";
  // Same-origin proxy (server.py). api.typesafe.ai answers CORS preflights
  // with HTTP 400 and no ACAO header, so browsers refuse direct fetch().
  // Served pages must use the proxy; static hosts without it fall back direct.
  var JEV_PROXY = "/api/jev";
  var OPENAI_DEFAULT_BASE = "https://api.openai.com/v1";

  function parseLaneKey(key) {
    var m = String(key == null ? "" : key).match(/lane[_-]?(\d)/i);
    if (m) {
      var n = parseInt(m[1], 10);
      if (n >= 1 && n <= 3) return n;
    }
    return null;
  }

  var INSTRUCTIONS = "Identify the safest lane that is clear of roadblocks.";

  function laneDescription(lane, isBlocked) {
    return isBlocked
      ? "Lane " + lane + " is blocked by a dangerous roadblock barrier"
      : "Lane " + lane + " is completely clear with unobstructed open road";
  }

  // Canonical shared state. blockedLanes: array of 1..3 currently threatening.
  // Built ONCE per tick by RaceController so every car sees identical roads.
  function buildLaneState(blockedLanes, currentLane) {
    var blocked = {};
    (blockedLanes || []).forEach(function (l) { blocked[l] = true; });
    var criteria = {};
    var choices = [];
    for (var lane = 1; lane <= 3; lane++) {
      var desc = laneDescription(lane, !!blocked[lane]);
      criteria["lane_" + lane] = desc;
      choices.push({ value: "lane_" + lane, description: desc });
    }
    var openLanes = [1, 2, 3].filter(function (l) { return !blocked[l]; });
    var stateObj = {
      currentLane: currentLane || null,
      blockedLanes: (blockedLanes || []).slice().sort(),
      lanes: [1, 2, 3].map(function (l) {
        return {
          lane: l,
          status: blocked[l] ? "blocked" : "clear",
          description: criteria["lane_" + l],
        };
      }),
    };
    var stateText =
      "Car in lane " + (currentLane || "?") +
      ". Blocked lanes: " + (blockedLanes && blockedLanes.length ? blockedLanes.slice().sort().join(", ") : "none") +
      ". " + [1, 2, 3].map(function (l) { return criteria["lane_" + l]; }).join(". ") + ".";
    return {
      blockedLanes: (blockedLanes || []).slice(),
      openLanes: openLanes,
      instructions: INSTRUCTIONS,
      query: "Completely clear with unobstructed open road",
      criteria: criteria,
      choices: choices,
      stateObj: stateObj,
      stateText: stateText,
    };
  }

  function payloadForLocalEngine(laneState) {
    return {
      model: "mediapipe-decisionmaker/embeddinggemma-2-270M (fallback: mediapipe-textembedder/embeddinggemma-300M)",
      query: laneState.query,
      questions: [
        {
          type: "choice",
          name: "lane_choice",
          instructions: laneState.instructions,
          choices: laneState.choices,
        },
      ],
    };
  }

  async function jevFetch(url, opts) {
    // Prefer the same-origin proxy; fall back to direct only when the page is
    // hosted somewhere without the proxy (static hosts answer 404 + HTML).
    if (url === JEV_PROXY) {
      let r;
      try {
        r = await fetch(url, opts);
      } catch (e) {
        throw new Error("jev proxy unreachable (is server.py running?): " + (e && e.message || e));
      }
      const ct = (r.headers.get("content-type") || "").toLowerCase();
      if (r.status === 404 && ct.indexOf("text/html") !== -1) {
        return fetch(JEV_ENDPOINT, opts); // static host: try direct (likely CORS-blocked)
      }
      return r;
    }
    return fetch(url, opts);
  }

  // --- Jev (TypeSafe SystemOne, native Choice) ---
  // POST { state, model, questions:{ lane_choice:{ type:"choice", instructions, criteria } } }
  async function jevDecide(laneState, opts) {
    opts = opts || {};
    var apiKey = (opts.apiKey || "").trim();
    if (!apiKey) throw new Error("missing TypeSafe API key");
    var model = (opts.model || "jev-latest").trim() || "jev-latest";
    var endpoint = (opts.endpoint || JEV_PROXY);
    var t0 = performance.now();
    var res = await jevFetch(endpoint, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        state: laneState.stateObj,
        model: model,
        questions: {
          lane_choice: {
            type: "choice",
            instructions: laneState.instructions,
            criteria: laneState.criteria,
          },
        },
      }),
      signal: opts.signal || null,
    });
    var latencyMs = Math.round(performance.now() - t0);
    if (!res.ok) {
      var text = "";
      try { text = await res.text(); } catch (e) { /* ignore */ }
      throw new Error("jev http " + res.status + (text ? ": " + text.slice(0, 200) : ""));
    }
    var json = await res.json();
    var ans = json && json.answers && json.answers.lane_choice;
    if (!ans || typeof ans.choice !== "string") throw new Error("jev: malformed answer");
    var chosen = parseLaneKey(ans.choice);
    if (!chosen) throw new Error("jev: unparsable choice " + ans.choice);
    return {
      chosen: chosen,
      selected: ans.choice,
      probabilities: ans.probabilities || null,
      confidence: typeof ans.confidence === "number" ? ans.confidence : null,
      latencyMs: latencyMs,
      engine: "jev/" + (json.model || model),
      raw: json,
    };
  }

  // --- OpenAI Decisions API (native Choice, like Jev) ---
  // POST {baseUrl}/decisions { model:"gpt-6-luna", input, questions:[{type:"choice", name, instructions, choices}] }
  // -> { answers:[{type:"choice", name, choice, probabilities:[{value, probability}], confidence}] }
  // Docs: https://developers.openai.com/api/docs/guides/decisions
  async function openaiDecide(laneState, opts) {
    opts = opts || {};
    var apiKey = (opts.apiKey || "").trim();
    if (!apiKey) throw new Error("missing OpenAI API key");
    var model = (opts.model || "gpt-6-luna").trim() || "gpt-6-luna";
    var baseUrl = (opts.baseUrl || OPENAI_DEFAULT_BASE).replace(/\/+$/, "");
    var t0 = performance.now();
    var res = await fetch(baseUrl + "/decisions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model,
        input: laneState.stateText,
        questions: [
          {
            type: "choice",
            name: "lane_choice",
            instructions: laneState.instructions,
            choices: [1, 2, 3].map(function (l) {
              return {
                value: "lane_" + l,
                description: laneState.criteria["lane_" + l],
              };
            }),
          },
        ],
      }),
      signal: opts.signal || null,
    });
    var latencyMs = Math.round(performance.now() - t0);
    if (!res.ok) {
      var text = "";
      try { text = await res.text(); } catch (e) { /* ignore */ }
      throw new Error("openai decisions http " + res.status + (text ? ": " + text.slice(0, 200) : ""));
    }
    var json = await res.json();
    var ans = json && json.answers && json.answers[0];
    if (!ans) throw new Error("openai decisions: empty answers");
    if (ans.type === "refusal") throw new Error("openai decisions: refused (" + (ans.name || "lane_choice") + ")");
    if (ans.type !== "choice" || typeof ans.choice !== "string") {
      throw new Error("openai decisions: unexpected answer type " + ans.type);
    }
    var chosen = parseLaneKey(ans.choice);
    if (!chosen) throw new Error("openai decisions: unparsable choice " + ans.choice);
    // Normalize probability array [{value, probability}] -> {lane_1: p, ...} (Jev uses a map).
    var probabilities = null;
    if (Array.isArray(ans.probabilities)) {
      probabilities = {};
      ans.probabilities.forEach(function (p) {
        if (p && typeof p.value === "string") probabilities[p.value] = p.probability;
      });
    }
    return {
      chosen: chosen,
      selected: ans.choice,
      probabilities: probabilities,
      confidence: typeof ans.confidence === "number" ? ans.confidence : null,
      latencyMs: latencyMs,
      engine: "openai-decisions/" + model,
      raw: json,
    };
  }

  // Generic OpenAI-compatible chat-completions endpoint (OpenRouter, Ollama, ...).
  // NOTE: this is separate from openaiDecide(), which targets the native
  // POST /v1/decisions API (gpt-6-luna). Generic providers have no Decisions
  // endpoint, so they still coerce a lane via json_schema structured output.
  async function genericDecide(laneState, opts) {
    opts = opts || {};
    var apiKey = (opts.apiKey || "").trim();
    if (!apiKey) throw new Error("missing API key");
    var model = (opts.model || "").trim();
    if (!model) throw new Error("missing model");
    var baseUrl = (opts.baseUrl || OPENAI_DEFAULT_BASE).replace(/\/+$/, "");
    var t0 = performance.now();
    var res = await fetch(baseUrl + "/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: model,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              laneState.instructions +
              " Answer with exactly one of lane_1, lane_2, lane_3. Options: " +
              [1, 2, 3].map(function (l) { return "lane_" + l + " (" + laneState.criteria["lane_" + l] + ")"; }).join("; ") +
              ". Pick a clear lane; never pick a blocked lane if any clear lane exists.",
          },
          { role: "user", content: laneState.stateText },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "lane_choice",
            strict: true,
            schema: {
              type: "object",
              properties: {
                lane: { type: "string", enum: ["lane_1", "lane_2", "lane_3"] },
              },
              required: ["lane"],
              additionalProperties: false,
            },
          },
        },
      }),
      signal: opts.signal || null,
    });
    var latencyMs = Math.round(performance.now() - t0);
    if (!res.ok) {
      var text = "";
      try { text = await res.text(); } catch (e) { /* ignore */ }
      throw new Error("provider http " + res.status + (text ? ": " + text.slice(0, 200) : ""));
    }
    var json = await res.json();
    var content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    if (!content) throw new Error("provider: empty response");
    var parsed;
    try {
      parsed = JSON.parse(content);
    } catch (e) {
      var m = String(content).match(/lane[_-]?([123])/i);
      if (!m) throw new Error("provider: unparsable content " + String(content).slice(0, 120));
      parsed = { lane: "lane_" + m[1] };
    }
    var chosen = parseLaneKey(parsed.lane);
    if (!chosen) throw new Error("provider: unparsable lane " + parsed.lane);
    return {
      chosen: chosen,
      selected: parsed.lane,
      probabilities: null,
      confidence: null,
      latencyMs: latencyMs,
      engine: "compat/" + model,
      raw: json,
    };
  }

  window.RaceProviders = {
    JEV_ENDPOINT: JEV_ENDPOINT,
    JEV_PROXY: JEV_PROXY,
    OPENAI_DEFAULT_BASE: OPENAI_DEFAULT_BASE,
    INSTRUCTIONS: INSTRUCTIONS,
    parseLaneKey: parseLaneKey,
    buildLaneState: buildLaneState,
    payloadForLocalEngine: payloadForLocalEngine,
    jevDecide: jevDecide,
    openaiDecide: openaiDecide,
    genericDecide: genericDecide,
  };
})();
