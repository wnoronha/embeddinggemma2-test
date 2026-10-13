// Playground: one-off OpenRouter Decisions API request.

(function () {
  "use strict";

  function $(id) { return document.getElementById(id); }

  function switchTab(which) {
    var driving = which === "driving";
    $("tabDriving").classList.toggle("active", driving);
    $("tabPlayground").classList.toggle("active", !driving);
    $("drivingView").hidden = !driving;
    $("playgroundView").hidden = driving;
    if (!driving) populateModelSelect();
  }

  function getKey() {
    if (typeof window.RaceGetOpenRouterKey === "function") {
      return window.RaceGetOpenRouterKey();
    }
    var el = $("key-openrouter");
    return el ? el.value.trim() : "";
  }

  function populateModelSelect() {
    var sel = $("pgModel");
    if (!sel || !window.RaceProviders) return;
    var catalog = window.RaceController && window.RaceController.catalog.length
      ? window.RaceController.catalog
      : window.RaceProviders.DECISIONS_CATALOG_FALLBACK;
    sel.innerHTML = catalog.map(function (m) {
      var tag = m.isFree ? " · free" : "";
      return '<option value="' + m.id + '">' + m.label + tag + " (" + m.id + ")</option>";
    }).join("");
  }

  async function onSubmit() {
    var btn = $("pgSubmit");
    var status = $("pgStatus");
    var out = $("pgResponse");
    var key = getKey();
    if (!key) {
      status.textContent = "Add your OpenRouter key on the Race tab.";
      return;
    }

    var model = $("pgModel").value;
    var state;
    var criteria;
    try {
      state = JSON.parse($("pgState").value);
      criteria = JSON.parse($("pgCriteria").value);
    } catch (e) {
      status.textContent = "Invalid JSON in state or criteria.";
      return;
    }

    var instructions = $("pgInstructions").value.trim();
    var RP = window.RaceProviders;
    btn.disabled = true;
    status.textContent = "Calling Decisions API…";
    var t0 = performance.now();
    try {
      var res = await fetch(RP.OPENROUTER_DECISIONS, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + key,
          "Content-Type": "application/json",
          "HTTP-Referer": location.origin + "/",
          "X-Title": "SystemOne Racer Playground",
        },
        body: JSON.stringify({
          model: model,
          state: state,
          questions: {
            lane_choice: {
              type: "choice",
              instructions: instructions,
              criteria: criteria,
            },
          },
        }),
      });
      var text = await res.text();
      var latencyMs = Math.round(performance.now() - t0);
      if (!res.ok) {
        status.textContent = "HTTP " + res.status;
        out.textContent = text;
        return;
      }
      var json;
      try { json = JSON.parse(text); } catch (e) { json = text; }
      out.textContent = JSON.stringify({ latencyMs: latencyMs, response: json }, null, 2);
      status.textContent = "Done in " + latencyMs + " ms";
    } catch (err) {
      status.textContent = "Error — see response.";
      out.textContent = String(err && err.message || err);
    } finally {
      btn.disabled = false;
    }
  }

  window.addEventListener("DOMContentLoaded", function () {
    $("tabDriving").addEventListener("click", function () { switchTab("driving"); });
    $("tabPlayground").addEventListener("click", function () { switchTab("playground"); });
    $("pgSubmit").addEventListener("click", onSubmit);
  });
})();
