(function () {
  try {
    const runtimeId = chrome && chrome.runtime && chrome.runtime.id ? chrome.runtime.id : "lovasiri";
    window.__lovasiriInjectedInstances = window.__lovasiriInjectedInstances || {};
    if (window.__lovasiriInjected || window.__lovasiriInjectedInstances[runtimeId]) return;
    window.__lovasiriInjected = true;
    window.__lovasiriInjectedInstances[runtimeId] = true;
  } catch (_) {
    if (window.__lovasiriInjected) return;
    window.__lovasiriInjected = true;
  }

  const BRIDGE_SOURCE = "LOVASIRI_EXTENSION_BRIDGE";
  const PAGE_SOURCE = "LOVASIRI_PAGE_PAYLOAD";

  function injectPayload() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("payload.js");
    script.onload = function () {
      this.remove();
    };
    (document.head || document.documentElement).appendChild(script);
  }

  function respond(id, ok, result, error) {
    window.postMessage({ source: BRIDGE_SOURCE, id, ok, result, error }, "*");
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window) return;
    const msg = event.data || {};

    // Ponte do pageHook (MAIN world) -> background.
    // O download do projeto precisa do Bearer real da Lovable capturado nas
    // próprias requisições da página; sem isso o background cai no token sb-* do
    // Supabase e a API /source-code responde "authorization header required".
    if (msg.type === "lovableTokenFound") {
      const sync = { action: "lovableSync" };
      if (msg.token)
        sync.token = String(msg.token)
          .replace(/^Bearer\s+/i, "")
          .trim();
      if (msg.projectId) sync.projectId = String(msg.projectId).trim();
      if (sync.token || sync.projectId) {
        try {
          chrome.runtime.sendMessage(sync, function () {});
        } catch (_) {}
      }
      return;
    }

    if (msg.source !== PAGE_SOURCE || !msg.id) return;

    try {
      if (msg.type === "storage.get") {
        chrome.storage.local.get(msg.keys, (result) => respond(msg.id, true, result || {}));
        return;
      }
      if (msg.type === "storage.set") {
        chrome.storage.local.set(msg.items || {}, () => respond(msg.id, true, true));
        return;
      }
      if (msg.type === "storage.remove") {
        chrome.storage.local.remove(msg.keys, () => respond(msg.id, true, true));
        return;
      }
      if (msg.type === "runtime.sendMessage") {
        chrome.runtime.sendMessage(msg.message, (result) => {
          const lastError = chrome.runtime.lastError && chrome.runtime.lastError.message;
          if (lastError) respond(msg.id, false, null, lastError);
          else respond(msg.id, true, result);
        });
        return;
      }
    } catch (err) {
      respond(msg.id, false, null, (err && err.message) || String(err));
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    window.postMessage({ source: BRIDGE_SOURCE, event: "storage.changed", changes, area }, "*");
  });

  injectPayload();

  // Pede o token já capturado quando a casca entra depois do pageHook.
  try {
    setTimeout(() => window.postMessage({ type: "lovableRequestToken" }, "*"), 250);
    setTimeout(() => window.postMessage({ type: "lovableRequestToken" }, "*"), 1500);
  } catch (_) {}
})();
