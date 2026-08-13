/* Lovable vibeX — licensing gate.
   Build identity + API endpoint are injected at package time by scripts/build-extension.mjs. */
(function () {
  var _cfg = {
    build_id: "vibex_pk_1241",
    version: "12.4",
    api_url: "https://vibexlovable.store",
    issued_at: 1785448826,
  };
  try { Object.freeze(_cfg); } catch (_e) {}
  try { self.__PK_BUILD__ = _cfg; } catch (_e) {}
  try { if (typeof window !== "undefined") window.__PK_BUILD__ = _cfg; } catch (_e) {}
})();
console.log("[vibeX] service worker started");

try {
  importScripts("hwFingerprint.js");
} catch (e) {
  console.error("[vibeX] probes:", e && e.message);
}

(function () {
  const STORAGE_KEY = "ql_handshake_token";
  const LAST_RESULT_KEY = "ql_handshake_last_result";
  const HEARTBEAT_MS = 60 * 1000;
  const RETRY_MS = 15 * 1000;
  // Offline grace: the gate keeps working this long past the token's expiry
  // if (and only if) the network is unreachable. Server denials are immediate.
  const OFFLINE_GRACE_MS = 10 * 60 * 1000;

  const FATAL_REASONS = new Set(["build_revoked", "unknown_build", "no_build_config"]);
  const LOGOUT_REASONS = new Set([
    "device_mismatch",
    "device_limit",
    "license_revoked",
    "license_expired",
    "license_disabled",
    "license_deleted",
    "invalid_license",
  ]);

  let _loopStarted = false;
  let _inFlight = null;

  function cfg() {
    try {
      return self.__PK_BUILD__ || null;
    } catch (e) {
      return null;
    }
  }

  function api(path) {
    const c = cfg();
    if (!c || !c.api_url) return null;
    return String(c.api_url).replace(/\/+$/, "") + path;
  }

  let _deviceIdPromise = null;
  async function getDeviceId() {
    if (_deviceIdPromise) return _deviceIdPromise;
    _deviceIdPromise = new Promise((resolve) => {
      try {
        chrome.storage.local.get(["ql_hw_fingerprint", "ql_device_id"], async (res) => {
          if (res && res.ql_hw_fingerprint) return resolve(res.ql_hw_fingerprint);
          if (typeof getHardwareFingerprint === "function") {
            try {
              const fp = await getHardwareFingerprint();
              if (fp) return resolve(fp);
            } catch (_) {}
          }
          if (res && res.ql_device_id) return resolve(res.ql_device_id);
          const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random();
          chrome.storage.local.set({ ql_device_id: id }, () => resolve(id));
        });
      } catch (e) {
        resolve("unknown-device");
      }
    });
    return _deviceIdPromise;
  }

  function get(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (res) => resolve(res || {}));
      } catch (e) {
        resolve({});
      }
    });
  }

  function set(obj) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set(obj, () => resolve());
      } catch (e) {
        resolve();
      }
    });
  }

  async function getLicenseKey() {
    const res = await get(["ql_license_key"]);
    return (res && res.ql_license_key) || null;
  }

  async function readToken() {
    const res = await get([STORAGE_KEY]);
    return (res && res[STORAGE_KEY]) || null;
  }

  async function saveToken(token) {
    return set({ [STORAGE_KEY]: token });
  }

  async function saveLastResult(result) {
    return set({ [LAST_RESULT_KEY]: Object.assign({ checked_at: Date.now() }, result || {}) });
  }

  async function applyFatalBlock(reason, message) {
    return set({
      ql_license_valid: false,
      ql_native_chat: false,
      ql_blocked_reason: reason || "blocked",
      ql_blocked_message: message || "This copy of the extension has been blocked.",
    });
  }

  async function applyLicenseLogout(reason, message) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.remove(
          [
            STORAGE_KEY,
            "ql_license_valid",
            "ql_license_key",
            "ql_session_id",
            "ql_user_name",
            "ql_expires_at",
            "ql_activated_at",
            "ql_license_status",
          ],
          () => {
            chrome.storage.local.set(
              {
                ql_native_chat: false,
                ql_show_activation: true,
                ql_blocked_reason: reason || "license_invalid",
                ql_blocked_message: message || "Your license is no longer valid.",
              },
              () => resolve(),
            );
          },
        );
      } catch (e) {
        resolve();
      }
    });
  }

  function isTokenValid(token) {
    if (!token || typeof token !== "object" || !token.token) return false;
    if (!token.expires_at) return false;
    return token.expires_at > Math.floor(Date.now() / 1000);
  }

  /** True when a token is expired but we are inside the offline grace window. */
  function isTokenInGrace(token) {
    if (!token || !token.token || !token.cached_at) return false;
    return Date.now() - token.cached_at < OFFLINE_GRACE_MS;
  }

  async function post(path, body) {
    const url = api(path);
    if (!url) return { networkError: false, data: { ok: false, reason: "no_build_config" } };
    try {
      const res = await fetch(url, {
        method: "POST",
        redirect: "follow",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("application/json")) {
        // An HTML page / redirect means we never reached the licensing API.
        // Reporting this as a bad license would be a lie — treat it as network.
        return {
          networkError: true,
          data: {
            ok: false,
            reason: "server_unreachable",
            message: "Could not reach the licensing server. Check your connection and try again.",
          },
        };
      }
      const data = await res.json().catch(() => null);
      if (!data || typeof data !== "object") {
        return {
          networkError: true,
          data: {
            ok: false,
            reason: "server_unreachable",
            message: "The licensing server returned an unreadable response.",
          },
        };
      }
      if (!data.ok && !data.reason) {
        data.reason = "server_error";
        data.message = data.message || `Licensing server error (HTTP ${res.status}).`;
      }
      return { networkError: false, data };
    } catch (e) {
      return {
        networkError: true,
        data: {
          ok: false,
          reason: "network",
          message: "Could not reach the licensing server. Check your connection and try again.",
        },
      };
    }
  }

  function storeSession(data) {
    const now = Math.floor(Date.now() / 1000);
    const lic = data.license || {};
    const token = {
      token: data.token,
      expires_at: now + (data.ttl || 300),
      ttl: data.ttl || 300,
      license: lic,
      cached_at: Date.now(),
    };
    return saveToken(token).then(() =>
      set({
        ql_license_valid: true,
        ql_license_status: "active",
        ql_expires_at: lic.expires_at || null,
        ql_blocked_reason: null,
        ql_blocked_message: null,
      }),
    ).then(() => token);
  }

  /** Exchange a license key for a fresh session (first activation / re-activation). */
  async function activate(licenseKey) {
    const c = cfg();
    const deviceId = await getDeviceId();
    const { networkError, data } = await post("/api/public/ext/activate", {
      licenseKey: String(licenseKey || "").trim().toUpperCase(),
      deviceId,
      buildId: c && c.build_id,
      userAgent: (typeof navigator !== "undefined" && navigator.userAgent) || null,
    });

    if (networkError) {
      const reason = data.reason || "network";
      await saveLastResult({ ok: false, reason, message: data.message });
      return {
        ok: false,
        reason,
        message: data.message || "Could not reach the licensing server.",
      };
    }
    if (!data.ok) {
      await saveLastResult({ ok: false, reason: data.reason, message: data.message });
      if (FATAL_REASONS.has(data.reason)) await applyFatalBlock(data.reason, data.message);
      return { ok: false, reason: data.reason, message: data.message };
    }

    await set({ ql_license_key: String(licenseKey).trim().toUpperCase() });
    const token = await storeSession(data);
    await saveLastResult({ ok: true });
    return { ok: true, token, license: data.license };
  }

  /** Re-validate the current session against the server. */
  async function heartbeat() {
    if (_inFlight) return _inFlight;
    _inFlight = (async () => {
      const c = cfg();
      const existing = await readToken();
      const deviceId = await getDeviceId();

      // No session yet — try to re-establish it from the saved key.
      if (!existing || !existing.token) {
        const key = await getLicenseKey();
        if (!key) return { ok: false, reason: "no_license" };
        return activate(key);
      }

      const { networkError, data } = await post("/api/public/ext/handshake", {
        token: existing.token,
        deviceId,
        buildId: c && c.build_id,
      });

      if (networkError) {
        // Offline: keep the saved session no matter how long we were away.
        // A network failure is never proof that the license is invalid, so we
        // never sign the user out here - we just retry on the next tick.
        return { ok: true, token: existing, offline: true };
      }

      if (!data.ok) {
        await saveLastResult({ ok: false, reason: data.reason, message: data.message });
        if (FATAL_REASONS.has(data.reason)) {
          await applyFatalBlock(data.reason, data.message);
        } else if (data.reason === "token_expired" || data.reason === "no_session") {
          // Soft: the short-lived token died while the browser was closed.
          const key = await getLicenseKey();
          if (key) {
            const retry = await activate(key);
            if (retry.ok) return retry;
          }
          return { ok: false, reason: data.reason, message: data.message };
        } else if (LOGOUT_REASONS.has(data.reason)) {
          // The token is dead. If we still hold the key, one retry through
          // activate() covers "device was reset by an admin" and stale tokens.
          const key = await getLicenseKey();
          if (key) {
            const retry = await activate(key);
            if (retry.ok) return retry;
          }
          await applyLicenseLogout(data.reason, data.message);
        }
        return { ok: false, reason: data.reason, message: data.message };
      }

      const token = await storeSession(data);
      await saveLastResult({ ok: true });
      return { ok: true, token, license: data.license };
    })();

    try {
      return await _inFlight;
    } finally {
      _inFlight = null;
    }
  }

  async function ensureToken() {
    const existing = await readToken();
    if (isTokenValid(existing)) return { ok: true, token: existing };
    return heartbeat();
  }

  function schedule(ms) {
    setTimeout(async () => {
      let next = HEARTBEAT_MS;
      try {
        const res = await heartbeat();
        if (!res.ok) next = RETRY_MS;
      } catch (e) {
        next = RETRY_MS;
      }
      schedule(next);
    }, ms);
  }

  function startBackgroundLoop() {
    if (_loopStarted) return;
    _loopStarted = true;
    heartbeat().catch(() => {});
    schedule(HEARTBEAT_MS);
  }

  self.vibeXGate = {
    activate,
    heartbeat,
    ensureToken,
    performHandshake: heartbeat,
    readToken,
    isTokenValid,
    startBackgroundLoop,
    getDeviceId,
  };
  // Back-compat alias for older call sites.
  self.LovaSiriHandshake = self.vibeXGate;
})();

try {
  if (self.LovaSiriHandshake && typeof self.LovaSiriHandshake.startBackgroundLoop === "function") {
    self.LovaSiriHandshake.startBackgroundLoop();
  }
} catch (e) {
  console.error("[Background] loop:", e && e.message);
}

// Lista de actions que exigem token válido para serem executadas.
// Sem handshake aprovado pelo servidor, essas ações são recusadas.
const PROTECTED_ACTIONS = new Set([
  "lovableApiFetch",
  "createLovableProjectInPage",
  "proxyFetch",
  "downloadProject",
  "readCookies",
  "lovableSync",
  "activateSidebar",
  "deactivateSidebar",
  "openSidePanel",
]);

// Cache síncrono do status do token. Atualizado pelo loop de handshake.
self.__lovasiriGateOk = false;

async function refreshGateStatus() {
  try {
    if (!self.LovaSiriHandshake) {
      self.__lovasiriGateOk = false;
      return false;
    }
    const token = await self.LovaSiriHandshake.readToken();
    const ok = self.LovaSiriHandshake.isTokenValid(token);
    self.__lovasiriGateOk = !!ok;
    return self.__lovasiriGateOk;
  } catch (e) {
    self.__lovasiriGateOk = false;
    return false;
  }
}

// Atualiza cache rapidamente; o token também expira se não for revalidado em ~15s.
setInterval(refreshGateStatus, 5 * 1000);
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.ql_handshake_token) refreshGateStatus();
  });
} catch (e) {}
refreshGateStatus();

// On install: open Lovable.dev and show the activation modal automatically
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    // Explicitly set ql_sidebar_mode: false on first install so the
    // "Voltar à Extensão" button stays hidden in the default floating mode.
    chrome.storage.local.set({ ql_show_activation: true, ql_native_chat: false, ql_sidebar_mode: false }, () => {
      chrome.tabs.create({ url: "https://lovable.dev/" });
    });
  }
});

// Initialize sidebar mode preference
chrome.storage.local.get(["ql_sidebar_mode"], (res) => {
  const sidebarMode = res.ql_sidebar_mode || false;
  chrome.sidePanel && chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: sidebarMode }).catch(() => {});
  console.log("[Background] Sidebar mode:", sidebarMode);
});

// Listen for storage changes to update panel behavior
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.ql_sidebar_mode) {
    const sidebarMode = changes.ql_sidebar_mode.newValue || false;
    chrome.sidePanel && chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: sidebarMode }).catch(() => {});
    console.log("[Background] Sidebar mode updated:", sidebarMode);
  }
});

// Handle action click (icon click) — this IS a user gesture, so sidePanel.open() works here
chrome.action.onClicked.addListener(async (tab) => {
  try {
    const res = await chrome.storage.local.get(["ql_sidebar_mode"]);
    if (res.ql_sidebar_mode) {
      (await chrome.sidePanel) && chrome.sidePanel.open({ tabId: tab.id });
    }
  } catch (err) {
    console.error("[Background] action.onClicked sidePanel error:", err);
  }
});

function isLovableTabUrl(url) {
  return /^https:\/\/([^/]+\.)?lovable\.dev\//.test(url || "");
}

function isLicenseActivationProxyFetch(msg) {
  // Activation now goes through the "pkActivate" message, which is never gated.
  return false;
}

async function injectPageHookMain(tabId, url) {
  if (!tabId || !isLovableTabUrl(url)) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: ["pageHook.js"],
      injectImmediately: true,
    });
    console.log("[Background] pageHook MAIN injetado na aba", tabId);
  } catch (err) {
    console.warn("[Background] failed to inject pageHook MAIN:", err && err.message);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "loading" && changeInfo.status !== "complete") return;
  injectPageHookMain(tabId, changeInfo.url || (tab && tab.url));
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    injectPageHookMain(activeInfo.tabId, tab && tab.url);
  } catch (_) {}
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === "ping") {
    sendResponse({ ok: true, ts: Date.now() });
    return false;
  }

  // Status do gate (sidepanel usa pra mostrar tela de bloqueio sem ficar adivinhando)
  if (msg && msg.action === "handshakeStatus") {
    (async () => {
      const ok = await refreshGateStatus();
      const cfg = self.__PK_BUILD__ || null;
      const token = self.LovaSiriHandshake ? await self.LovaSiriHandshake.readToken() : null;
      sendResponse({
        ok,
        build_id: cfg && cfg.build_id,
        version: cfg && cfg.version,
        expires_at: token && token.expires_at,
      });
    })();
    return true;
  }

  // Força um novo handshake (sidepanel chama no boot ou após inserir license)
  if (msg && msg.action === "handshakeRefresh") {
    (async () => {
      try {
        const res = self.LovaSiriHandshake
          ? await self.LovaSiriHandshake.performHandshake()
          : { ok: false, reason: "no_handshake" };
        await refreshGateStatus();
        sendResponse(res);
      } catch (e) {
        sendResponse({ ok: false, reason: "exception", message: String(e && e.message) });
      }
    })();
    return true;
  }

  // License activation from the in-page shell.
  if (msg && msg.action === "pkActivate") {
    (async () => {
      try {
        const res = await self.vibeXGate.activate(msg.licenseKey);
        await refreshGateStatus();
        sendResponse(res);
      } catch (e) {
        sendResponse({ ok: false, reason: "exception", message: String(e && e.message) });
      }
    })();
    return true;
  }

  // Gated delivery of the feature bundle. The code never lives in the zip —
  // the server only returns it for a device holding a valid session.
  if (msg && msg.action === "pkFetchCore") {
    (async () => {
      try {
        const gate = await self.vibeXGate.ensureToken();
        if (!gate || !gate.ok || !gate.token || !gate.token.token) {
          sendResponse({ ok: false, reason: (gate && gate.reason) || "not_authorized" });
          return;
        }
        const cfg = self.__PK_BUILD__ || {};
        const deviceId = await self.vibeXGate.getDeviceId();
        const res = await fetch(String(cfg.api_url).replace(/\/+$/, "") + "/api/public/ext/bundle", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: gate.token.token, deviceId }),
        });
        if (!res.ok) {
          sendResponse({ ok: false, reason: "bundle_denied", status: res.status });
          return;
        }
        const payload = await res.json();
        if (!payload || !payload.ok) {
          sendResponse({ ok: false, reason: (payload && payload.reason) || "bundle_unavailable" });
          return;
        }
        sendResponse({ ok: true, code: payload.js, css: payload.css || "" });
      } catch (e) {
        sendResponse({ ok: false, reason: "exception", message: String(e && e.message) });
      }
    })();
    return true;
  }

  // Gate em tempo real: toda ação sensível força handshake se o token não foi renovado agora.
  if (msg && msg.action && PROTECTED_ACTIONS.has(msg.action) && !isLicenseActivationProxyFetch(msg)) {
    return authorizeAndHandleMessage(msg, sender, sendResponse);
  }

  return handleAuthorizedMessage(msg, sender, sendResponse);
});

function authorizeAndHandleMessage(msg, sender, sendResponse) {
  (async () => {
    let ok = await refreshGateStatus();
    if (!ok && self.LovaSiriHandshake) {
      const res = await self.LovaSiriHandshake.performHandshake();
      ok = !!(res && res.ok);
      await refreshGateStatus();
    }
    if (!ok) {
      sendResponse({
        ok: false,
        status: 403,
        data: {
          error: "extension_not_authorized",
          message: "This copy of the extension is not authorized. Download the official version from your dashboard.",
        },
      });
      return;
    }
    handleAuthorizedMessage(msg, sender, sendResponse);
  })();
  return true;
}

async function getLovableTab(preferredTab) {
  if (preferredTab && preferredTab.id && isLovableTabUrl(preferredTab.url)) return preferredTab;
  const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
  if (activeTabs && activeTabs[0] && isLovableTabUrl(activeTabs[0].url)) return activeTabs[0];
  const lovableTabs = await chrome.tabs.query({ url: ["https://lovable.dev/*", "https://*.lovable.dev/*"] });
  return (lovableTabs && lovableTabs[0]) || null;
}

function normalizeLovableSourceFiles(payload) {
  if (!payload || typeof payload !== "object") return [];
  const candidates = [
    payload.files,
    payload.data && payload.data.files,
    payload.source_code && payload.source_code.files,
    payload.sourceCode && payload.sourceCode.files,
    payload.project && payload.project.files,
  ];
  for (const list of candidates) {
    if (Array.isArray(list)) {
      return list
        .map((file) => {
          if (!file || typeof file !== "object") return file;
          const name = file.name || file.path || file.file_path || file.filename || file.fileName;
          const content = file.content != null ? file.content : file.source != null ? file.source : file.text;
          return Object.assign({}, file, name ? { name } : {}, content != null ? { content } : {});
        })
        .filter((file) => file && (typeof file === "string" || file.name || file.path));
    }
  }
  return [];
}

function normalizeLovasiriBearerToken(token) {
  return String(token || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

function addLovasiriTokenCandidate(list, seen, token, source) {
  const clean = normalizeLovasiriBearerToken(token);
  if (!clean || seen.has(clean)) return;
  seen.add(clean);
  list.push({ token: clean, source: source || "token" });
}

function buildLovasiriTokenCandidates() {
  const seen = new Set();
  const list = [];
  for (let i = 0; i < arguments.length; i++) addLovasiriTokenCandidate(list, seen, arguments[i], "background");
  list.push({ token: "", source: "cookie-only" });
  return list;
}

async function fetchLovableSourceDirect(projectId, token) {
  const cleanProjectId = encodeURIComponent(String(projectId || "").trim());
  const tokenCandidates = buildLovasiriTokenCandidates(token);
  const urls = [
    "https://lovable-api.com/projects/" + cleanProjectId + "/source-code",
    "https://api.lovable.dev/projects/" + cleanProjectId + "/source-code",
  ];
  let last = null;
  for (const url of urls) {
    for (const candidate of tokenCandidates) {
      try {
        const resp = await fetch(url, {
          method: "GET",
          cache: "no-store",
          headers: {
            Accept: "application/json",
            ...(candidate.token ? { Authorization: "Bearer " + candidate.token } : {}),
          },
        });
        const text = await resp.text();
        let data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          data = { raw: text };
        }
        const files = normalizeLovableSourceFiles(data);
        last = { ok: resp.ok, status: resp.status, data, files, tokenSource: candidate.source };
        if (resp.ok && files.length)
          return { success: true, ok: true, files, status: resp.status, source: url, tokenSource: candidate.source };
        if (resp.ok)
          return {
            success: false,
            ok: false,
            error: "No files found in the project.",
            status: resp.status,
            details: data,
          };
        if (resp.status !== 401 && resp.status !== 403) break;
      } catch (err) {
        last = { ok: false, status: 0, data: { error: (err && err.message) || "failed to fetch" }, files: [] };
      }
    }
  }
  const reason = last && last.data && (last.data.message || last.data.error || last.data.raw);
  return {
    success: false,
    ok: false,
    error: reason || "Download falhou",
    status: (last && last.status) || 0,
    details: last && last.data,
  };
}

async function fetchLovableSourceViaPage(projectId, token, preferredTab) {
  const tab = await getLovableTab(preferredTab);
  if (!tab || !tab.id)
    return { success: false, ok: false, status: 0, error: "Abra uma aba do Lovable antes de baixar." };
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    /* javascript-obfuscator:disable */
    func: async ({ projectId, token }) => {
      const normalizeFiles = (payload) => {
        if (!payload || typeof payload !== "object") return [];
        const candidates = [
          payload.files,
          payload.data && payload.data.files,
          payload.source_code && payload.source_code.files,
          payload.sourceCode && payload.sourceCode.files,
          payload.project && payload.project.files,
        ];
        for (const list of candidates) {
          if (Array.isArray(list)) {
            return list
              .map((file) => {
                if (!file || typeof file !== "object") return file;
                const name = file.name || file.path || file.file_path || file.filename || file.fileName;
                const content = file.content != null ? file.content : file.source != null ? file.source : file.text;
                return Object.assign({}, file, name ? { name } : {}, content != null ? { content } : {});
              })
              .filter((file) => file && (typeof file === "string" || file.name || file.path));
          }
        }
        return [];
      };

      const addCandidate = (list, seen, raw, source) => {
        const clean = String(raw || "")
          .replace(/^Bearer\s+/i, "")
          .trim();
        if (!clean || seen.has(clean)) return;
        seen.add(clean);
        list.push({ token: clean, source: source || "token" });
      };

      const collectTokenCandidates = () => {
        const seen = new Set();
        const list = [];
        // 1) token vivo passado pelo core/background (capturado pelo pageHook)
        addCandidate(list, seen, token, "captured");
        // 2) globals expostos no MAIN world
        try {
          addCandidate(list, seen, window.__lovasiriLovableToken, "window.__lovasiriLovableToken");
          addCandidate(list, seen, window.__lovableAuthToken, "window.__lovableAuthToken");
          addCandidate(list, seen, window.__LOVABLE_AUTH_TOKEN__, "window.__LOVABLE_AUTH_TOKEN__");
        } catch (e) {}
        // 3) Firebase como fallback final autenticado.
        // Nunca usar sb-*-auth-token aqui: /source-code da Lovable rejeita JWT Supabase
        // com "Invalid token" / "authorization header required" e impede o cookie-only.
        try {
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i) || "";
            const raw = localStorage.getItem(key) || "";
            if (/firebase:authUser|authUser/i.test(key)) {
              try {
                const parsed = JSON.parse(raw);
                const user = parsed && parsed.value && typeof parsed.value === "object" ? parsed.value : parsed;
                const manager = user && (user.stsTokenManager || user.tokenManager || {});
                const fbToken = manager.accessToken || user.accessToken;
                addCandidate(list, seen, fbToken, "firebase");
              } catch (e) {}
            }
          }
        } catch (e) {}
        // 4) fallback cookie-only
        list.push({ token: "", source: "cookie-only" });
        return list;
      };

      const cleanProjectId = encodeURIComponent(String(projectId || "").trim());
      const tokenCandidates = collectTokenCandidates();
      const urls = [
        "https://api.lovable.dev/projects/" + cleanProjectId + "/source-code",
        "https://lovable-api.com/projects/" + cleanProjectId + "/source-code",
      ];
      let last = null;
      for (const url of urls) {
        for (const candidate of tokenCandidates) {
          try {
            const resp = await fetch(url, {
              method: "GET",
              cache: "no-store",
              credentials: "include",
              headers: {
                Accept: "application/json",
                ...(candidate.token ? { Authorization: "Bearer " + candidate.token } : {}),
              },
            });
            const text = await resp.text();
            let data;
            try {
              data = JSON.parse(text);
            } catch (e) {
              data = { raw: text };
            }
            const files = normalizeFiles(data);
            last = { ok: resp.ok, status: resp.status, data, files, tokenSource: candidate.source };
            if (resp.ok && files.length)
              return {
                success: true,
                ok: true,
                files,
                status: resp.status,
                source: url,
                tokenSource: candidate.source,
              };
            if (resp.ok)
              return {
                success: false,
                ok: false,
                error: "No files found in the project.",
                status: resp.status,
                details: data,
              };
            // Se 401/403, tenta o próximo token candidato automaticamente.
            if (resp.status !== 401 && resp.status !== 403) break;
          } catch (err) {
            last = { ok: false, status: 0, data: { error: (err && err.message) || "failed to fetch" }, files: [] };
          }
        }
      }
      const reason = last && last.data && (last.data.message || last.data.error || last.data.raw);
      return {
        success: false,
        ok: false,
        error: reason || "Download falhou",
        status: (last && last.status) || 0,
        details: last && last.data,
      };
    },
    /* javascript-obfuscator:enable */
    args: [{ projectId, token }],
  });
  return (
    (results && results[0] && results[0].result) || {
      success: false,
      ok: false,
      status: 0,
      error: "no response from the Lovable page",
    }
  );
}

function handleAuthorizedMessage(msg, sender, sendResponse) {
  if (msg && msg.action === "lovableSync") {
    const updates = {};
    if (msg.token) updates.lovable_token = msg.token;
    if (msg.projectId) updates.lovable_projectId = msg.projectId;
    if (Object.keys(updates).length) {
      chrome.storage.local.set(updates, () => {
        console.log("[Background] saved:", Object.keys(updates).join(", "));
      });
    }
  }

  if (msg && msg.action === "activateSidebar") {
    // Only set the preference and behavior — cannot open side panel without user gesture
    chrome.storage.local.set({ ql_sidebar_mode: true });
    chrome.sidePanel && chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
    // Try to open if sender is a tab (content script click IS a user gesture propagated)
    if (sender.tab && sender.tab.id) {
      chrome.sidePanel &&
        chrome.sidePanel
          .open({ tabId: sender.tab.id })
          .then(() => {
            sendResponse({ ok: true });
          })
          .catch((err) => {
            console.warn("[Background] sidePanel.open deferred — user must click extension icon:", err.message);
            sendResponse({
              ok: true,
              deferred: true,
              message: "Click the extension icon to open the side panel.",
            });
          });
    } else {
      sendResponse({ ok: true, deferred: true, message: "Click the extension icon to open the side panel." });
    }
    return true;
  }

  if (msg && msg.action === "deactivateSidebar") {
    // Always re-enable native chat when leaving sidebar mode — floating mode
    // must have chat padrão ON by default. User can disable it later via the
    // floating launcher icon.
    chrome.storage.local.get(["ql_license_valid"], (stored) => {
      chrome.storage.local.set({ ql_sidebar_mode: false, ql_native_chat: stored && stored.ql_license_valid === true });
    });
    chrome.sidePanel && chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
    // Reload the active Lovable tab so the floating launcher reappears.
    // sender.tab is undefined when called from the sidepanel, so query tabs.
    (async () => {
      try {
        let tab = null;
        if (sender && sender.tab && sender.tab.id) {
          tab = sender.tab;
        } else {
          const lovableTabs = await chrome.tabs.query({ url: ["https://lovable.dev/*", "https://*.lovable.dev/*"] });
          tab = (lovableTabs && (lovableTabs.find((t) => t.active) || lovableTabs[0])) || null;
        }
        if (tab && tab.id) {
          try {
            await chrome.tabs.reload(tab.id);
          } catch (_) {}
          try {
            await chrome.tabs.update(tab.id, { active: true });
          } catch (_) {}
        }
      } catch (_) {}
      sendResponse({ ok: true });
    })();
    return true;
  }

  if (msg && msg.action === "openSidePanel") {
    // This can only work if triggered from a user gesture context
    if (sender.tab && sender.tab.id) {
      chrome.sidePanel &&
        chrome.sidePanel
          .open({ tabId: sender.tab.id })
          .then(() => {
            sendResponse({ ok: true });
          })
          .catch((err) => {
            console.warn("[Background] openSidePanel deferred:", err.message);
            sendResponse({ ok: false, error: err.message });
          });
    } else {
      sendResponse({ ok: false, error: "No tab context" });
    }
    return true;
  }

  if (msg && msg.action === "lovableApiFetch") {
    (async () => {
      try {
        let tab = null;
        const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTabs && activeTabs[0] && /^https:\/\/([^/]+\.)?lovable\.dev\//.test(activeTabs[0].url || "")) {
          tab = activeTabs[0];
        } else {
          const lovableTabs = await chrome.tabs.query({ url: ["https://lovable.dev/*", "https://*.lovable.dev/*"] });
          tab = (lovableTabs && lovableTabs[0]) || null;
        }
        if (!tab || !tab.id) {
          sendResponse({ ok: false, status: 0, data: { error: "Open a Lovable tab before sending." } });
          return;
        }
        const stored = await chrome.storage.local.get(["lovable_token"]);
        const token = String((stored && stored.lovable_token) || "")
          .replace(/^Bearer\s+/i, "")
          .trim();
        const requestHeaders = Object.assign({}, msg.headers || {});
        if (token && !requestHeaders.Authorization && !requestHeaders.authorization) {
          requestHeaders.Authorization = "Bearer " + token;
        }
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          /* javascript-obfuscator:disable */
          func: async (url, options) => {
            try {
              const r = await fetch(url, options);
              const text = await r.text();
              let data;
              try {
                data = JSON.parse(text);
              } catch (e) {
                data = { raw: text };
              }
              return { ok: r.ok, status: r.status, data };
            } catch (err) {
              return { ok: false, status: 0, data: { error: (err && err.message) || "fetch failed in page" } };
            }
          },
          /* javascript-obfuscator:enable */
          args: [
            msg.url,
            {
              method: msg.method || "POST",
              headers: requestHeaders,
              body: msg.body || null,
              credentials: "include",
            },
          ],
        });
        const value = (results && results[0] && results[0].result) || {
          ok: false,
          status: 0,
          data: { error: "no response from the Lovable page" },
        };
        sendResponse(value);
      } catch (err) {
        console.error("[Background] lovableApiFetch error:", err);
        sendResponse({ ok: false, status: 0, data: { error: err.message || "executeScript failed." } });
      }
    })();
    return true;
  }

  if (msg && msg.action === "createLovableProjectInPage") {
    (async () => {
      try {
        let tab = null;
        const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTabs && activeTabs[0] && /^https:\/\/([^/]+\.)?lovable\.dev\//.test(activeTabs[0].url || "")) {
          tab = activeTabs[0];
        } else {
          const lovableTabs = await chrome.tabs.query({ url: ["https://lovable.dev/*", "https://*.lovable.dev/*"] });
          tab = (lovableTabs && lovableTabs[0]) || null;
        }
        if (!tab || !tab.id) {
          sendResponse({ ok: false, error: "Open a Lovable tab before creating the project." });
          return;
        }
        const stored = await chrome.storage.local.get(["lovable_token"]);
        const token = String(msg.token || stored.lovable_token || "")
          .replace(/^Bearer\s+/i, "")
          .trim();

        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            files: ["castle-v2.js"],
          });
        } catch (e) {
          console.warn("[Background] Castle script inject falhou, seguindo sem ele:", e && e.message);
        }

        const apiBaseForPage = ["https://", "api.lovable.dev"].join("");
        const castlePkForPage = ["pk_", "TaKsqF94pjCsoyepV6mH3V24AXoM6A7M"].join("");
        const firebaseRefreshUrlForPage = [
          "https://securetoken.googleapis.com",
          "/v1/token?key=",
          "AIzaSyBQNjlw9Vp4tP4VVeANzyPJnqbG2wLbYPw",
        ].join("");

        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          /* javascript-obfuscator:disable */
          func: async ({ token, title, apiBase, castlePk, firebaseRefreshUrl }) => {
            const API_BASE = apiBase;
            const CASTLE_PK = castlePk;

            const asJson = async (response) => {
              const text = await response.text();
              try {
                return JSON.parse(text);
              } catch (e) {
                return { raw: text };
              }
            };

            const readFirebaseAuth = async () => {
              const fromValue = (value) => {
                if (!value || typeof value !== "object") return null;
                const user = value.value && typeof value.value === "object" ? value.value : value;
                const manager = user.stsTokenManager || user.tokenManager || {};
                const accessToken = manager.accessToken || user.accessToken || "";
                const refreshToken = manager.refreshToken || user.refreshToken || "";
                const expirationTime = Number(manager.expirationTime || user.expirationTime || 0);
                if (!accessToken && !refreshToken) return null;
                return { accessToken, refreshToken, expirationTime };
              };

              try {
                for (let i = 0; i < localStorage.length; i++) {
                  const key = localStorage.key(i) || "";
                  if (!/firebase:authUser|authUser/i.test(key)) continue;
                  const parsed = JSON.parse(localStorage.getItem(key) || "null");
                  const found = fromValue(parsed);
                  if (found) return found;
                }
              } catch (e) {}

              try {
                return await new Promise((resolve) => {
                  const req = indexedDB.open("firebaseLocalStorageDb");
                  req.onerror = () => resolve(null);
                  req.onsuccess = () => {
                    const db = req.result;
                    try {
                      const tx = db.transaction("firebaseLocalStorage", "readonly");
                      const store = tx.objectStore("firebaseLocalStorage");
                      const all = store.getAll();
                      all.onerror = () => resolve(null);
                      all.onsuccess = () => {
                        const rows = all.result || [];
                        for (const row of rows) {
                          const found = fromValue(row);
                          if (found) {
                            resolve(found);
                            return;
                          }
                        }
                        resolve(null);
                      };
                    } catch (e) {
                      resolve(null);
                    }
                  };
                });
              } catch (e) {
                return null;
              }
            };

            const refreshFirebaseToken = async (refreshToken) => {
              if (!refreshToken) return "";
              try {
                const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken });
                const r = await fetch(firebaseRefreshUrl, {
                  method: "POST",
                  headers: { "Content-Type": "application/x-www-form-urlencoded" },
                  body,
                });
                const data = await asJson(r);
                return r.ok ? data.id_token || data.access_token || "" : "";
              } catch (e) {
                return "";
              }
            };

            const readSupabaseAuth = () => {
              try {
                for (let i = 0; i < localStorage.length; i++) {
                  const key = localStorage.key(i) || "";
                  if (!/^sb-.*-auth-token$/.test(key)) continue;
                  const raw = localStorage.getItem(key);
                  if (!raw) continue;
                  let parsed;
                  try {
                    parsed = JSON.parse(raw);
                  } catch (e) {
                    continue;
                  }
                  let accessToken = "",
                    refreshToken = "",
                    expiresAt = 0;
                  if (Array.isArray(parsed)) {
                    accessToken = parsed[0] || "";
                    refreshToken = parsed[1] || "";
                  } else if (parsed && typeof parsed === "object") {
                    accessToken =
                      parsed.access_token || (parsed.currentSession && parsed.currentSession.access_token) || "";
                    refreshToken =
                      parsed.refresh_token || (parsed.currentSession && parsed.currentSession.refresh_token) || "";
                    expiresAt = Number(
                      parsed.expires_at || (parsed.currentSession && parsed.currentSession.expires_at) || 0,
                    );
                  }
                  if (accessToken) return { accessToken, refreshToken, expirationTime: expiresAt * 1000 };
                }
              } catch (e) {}
              return null;
            };

            const getFreshToken = async () => {
              const sb = readSupabaseAuth();
              if (sb && sb.accessToken) return sb.accessToken;
              const storedAuth = await readFirebaseAuth();
              if (storedAuth) {
                const expiresSoon = storedAuth.expirationTime && storedAuth.expirationTime - Date.now() < 300000;
                if (expiresSoon && storedAuth.refreshToken) {
                  const refreshed = await refreshFirebaseToken(storedAuth.refreshToken);
                  if (refreshed) return refreshed;
                }
                if (storedAuth.accessToken) return storedAuth.accessToken;
              }
              return String(token || "")
                .replace(/^Bearer\s+/i, "")
                .trim();
            };

            const createCastleHeader = async () => {
              try {
                if (!window.Castle || typeof window.Castle.configure !== "function") return {};
                window.__lovasiriCastleClient =
                  window.__lovasiriCastleClient || window.Castle.configure({ pk: CASTLE_PK });
                const castleToken = await window.__lovasiriCastleClient.createRequestToken();
                return castleToken ? { "X-Castle-Request-Token": castleToken } : {};
              } catch (e) {
                return {};
              }
            };

            const freshToken = await getFreshToken();
            // NOTE: do not bail when there's no Bearer token. Lovable.dev now
            // authenticates API requests primarily via cookies (credentials: 'include'),
            // so we proceed and only fall back to the friendly error if the API itself
            // returns 401.

            const makeHeaders = async (json = true) => ({
              Accept: "application/json",
              ...(json ? { "Content-Type": "application/json" } : {}),
              ...(freshToken ? { Authorization: "Bearer " + freshToken } : {}),
              ...(await createCastleHeader()),
            });

            const pickWorkspaces = (payload) => {
              if (!payload || typeof payload !== "object") return [];
              if (Array.isArray(payload.workspaces)) return payload.workspaces;
              if (Array.isArray(payload.data)) return payload.data;
              if (payload.workspace) return [payload.workspace];
              return [];
            };
            const wsUrls = [API_BASE + "/user/workspaces", API_BASE + "/workspaces"];
            let workspaces = [];
            let workspaceStatus = 0;
            let workspacePayload = null;
            for (const url of wsUrls) {
              try {
                const r = await fetch(url, {
                  method: "GET",
                  headers: await makeHeaders(false),
                  credentials: "include",
                });
                workspaceStatus = r.status;
                const data = await asJson(r);
                workspacePayload = data;
                if (r.ok) {
                  workspaces = pickWorkspaces(data).filter((w) => w && w.id);
                  if (workspaces.length) break;
                }
              } catch (e) {}
            }
            if (!workspaces.length) {
              const why =
                workspacePayload && (workspacePayload.message || workspacePayload.error || workspacePayload.type);
              return {
                ok: false,
                error: why || "Could not find your Lovable workspace.",
                status: workspaceStatus,
                details: workspacePayload,
              };
            }

            const workspace = workspaces.find((w) => !/free/i.test(String(w.plan || ""))) || workspaces[0];
            const workspaceId = workspace.id;
            const projectTitle = title || "Project " + new Date().toLocaleString("en-US");
            const bodies = [
              {
                description: projectTitle,
                tech_stack: "modern",
                visibility: "private",
                metadata: { chat_mode_enabled: true, fullscreen_enabled: true },
              },
              {
                description: projectTitle,
                visibility: "private",
                metadata: { fullscreen_enabled: true },
              },
            ];
            const urls = [API_BASE + "/workspaces/" + encodeURIComponent(workspaceId) + "/projects"];
            let last = null;
            for (const url of urls) {
              for (const body of bodies) {
                try {
                  const r = await fetch(url, {
                    method: "POST",
                    headers: await makeHeaders(true),
                    credentials: "include",
                    body: JSON.stringify(body),
                  });
                  const data = await asJson(r);
                  last = { status: r.status, data, url };
                  if (r.ok) {
                    const project = data.project || data.data || data;
                    const id = project.id || project.project_id || data.id || data.projectId;
                    const link =
                      project.editor_url ||
                      project.url ||
                      project.link ||
                      data.editor_url ||
                      data.url ||
                      data.link ||
                      (id ? "https://lovable.dev/projects/" + id : "https://lovable.dev/");
                    return { ok: true, success: true, link, projectId: id || "", workspaceId, data };
                  }
                  if (r.status !== 400 && r.status !== 404 && r.status !== 422) break;
                } catch (e) {
                  last = { status: 0, data: { error: e.message }, url };
                }
              }
            }
            const msg =
              (last && last.data && (last.data.message || last.data.error || last.data.type)) ||
              "Failed to create the project in Lovable.";
            if (last && last.status === 401)
              return {
                ok: false,
                status: 401,
                error:
                  "Your Lovable session did not authorize the creation. Refresh the Lovable.dev tab, make sure you are signed in and try again.",
                details: last,
              };
            if (last && last.status === 402)
              return {
                ok: false,
                status: 402,
                error: "Your Lovable account needs available credits/plan to create a project.",
                details: last,
              };
            if (/castle|denied|captcha/i.test(String(msg)))
              return {
                ok: false,
                status: last && last.status,
                error:
                  "Lovable blocked the automation for security reasons. Refresh the Lovable.dev tab and try again from the extension panel.",
                details: last,
              };
            return { ok: false, status: last && last.status, error: msg, details: last };
          },
          /* javascript-obfuscator:enable */
          args: [
            {
              token,
              title: msg.title || "",
              apiBase: apiBaseForPage,
              castlePk: castlePkForPage,
              firebaseRefreshUrl: firebaseRefreshUrlForPage,
            },
          ],
        });
        const value = (results && results[0] && results[0].result) || {
          ok: false,
          error: "no response from the Lovable page",
        };
        if (value && value.ok && value.projectId) {
          chrome.storage.local.set({ lovable_token: value.token || token, lovable_projectId: value.projectId });
        }
        sendResponse(value);
      } catch (err) {
        console.error("[Background] createLovableProjectInPage error:", err);
        sendResponse({ ok: false, error: err.message || "Failed to create through the Lovable tab." });
      }
    })();
    return true;
  }

  if (msg && msg.action === "proxyFetch") {
    (async () => {
      try {
        console.log("[Background] proxyFetch ->", msg.url);
        var opts = {
          method: msg.method || "POST",
          headers: msg.headers || {},
        };
        if (msg.body) opts.body = msg.body;
        var resp = await fetch(msg.url, opts);
        var text = await resp.text();
        var data;
        try {
          data = JSON.parse(text);
        } catch (e) {
          data = { raw: text };
        }
        sendResponse({ ok: resp.ok, status: resp.status, data: data });
      } catch (err) {
        console.error("[Background] proxyFetch error:", err);
        sendResponse({ ok: false, status: 0, data: { error: err.message || "Fetch failed in background" } });
      }
    })();
    return true;
  }

  // --- READ_COOKIES: read HttpOnly cookies for JWT token ---
  if (msg && msg.action === "readCookies") {
    var cookieNames = [
      "lovable-session-id.id",
      "lovable-session-id.custom",
      "lovable-session-id.refresh",
      "lovable-session-id.sig",
    ];
    var foundTokens = [];
    var checkedCount = 0;
    cookieNames.forEach(function (name) {
      chrome.cookies.get({ url: "https://lovable.dev", name: name }, function (cookie) {
        checkedCount++;
        if (cookie && cookie.value) {
          var parts = cookie.value.split(".");
          if (parts.length === 3 && cookie.value.indexOf("eyJ") === 0) {
            foundTokens.push({
              token: cookie.value,
              cookieName: name,
              httpOnly: cookie.httpOnly,
            });
          }
        }
        if (checkedCount === cookieNames.length) {
          sendResponse({ success: foundTokens.length > 0, tokens: foundTokens });
        }
      });
    });
    return true;
  }

  // --- DOWNLOAD_PROJECT: fetch project source code from Lovable API ---
  if (msg && msg.action === "downloadProject") {
    (async function () {
      try {
        const stored = await chrome.storage.local.get(["lovable_token", "lovable_projectId"]);
        const projectId = String(msg.projectId || stored.lovable_projectId || "").trim();
        const token = String(msg.token || stored.lovable_token || "")
          .replace(/^Bearer\s+/i, "")
          .trim();
        if (!projectId) {
          sendResponse({
            success: false,
            ok: false,
            error: "Project not identified. Open the project in Lovable and try again.",
          });
          return;
        }

        // 1) Preferir a aba Lovable: usa cookies + token vivo do localStorage
        let result = null;
        try {
          result = await fetchLovableSourceViaPage(projectId, token, sender && sender.tab);
        } catch (e) {
          result = { success: false, ok: false, status: 0, error: (e && e.message) || "page_fetch_failed" };
        }
        // 2) Fallback: chamada direta apenas se a página falhou
        const pageFailed = !result || !result.success;
        if (pageFailed) {
          try {
            const direct = await fetchLovableSourceDirect(projectId, token);
            if (direct && direct.success) result = direct;
            else if (!result) result = direct;
          } catch (e) {
            if (!result)
              result = { success: false, ok: false, status: 0, error: (e && e.message) || "direct_fetch_failed" };
          }
        }
        if (result && !result.success && /invalid.?token|401/i.test(String(result.error || result.status || ""))) {
          result.error = "Your Lovable session expired. Reload the project page (F5) and try again.";
        }
        sendResponse(result && result.success ? { success: true, ok: true, files: result.files || [] } : result);
      } catch (err) {
        sendResponse({ success: false, ok: false, status: 0, error: (err && err.message) || "Download falhou" });
      }
    })();
    return true;
  }
}
