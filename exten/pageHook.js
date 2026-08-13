(function () {
  if (window.__lovasiriPageHookInstalled) {
    try {
      window.postMessage({ type: "lovableRequestToken" }, "*");
    } catch (e) {}
    return;
  }
  window.__lovasiriPageHookInstalled = true;
  console.log("[QuantumHook] Iniciando");

  let capturedToken = null;
  let capturedProjectId = null;

  function isLikelySupabaseJwt(token) {
    try {
      var clean = String(token || "")
        .replace(/^Bearer\s+/i, "")
        .trim();
      var parts = clean.split(".");
      if (parts.length !== 3) return false;
      var payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      while (payload.length % 4) payload += "=";
      var claims = JSON.parse(atob(payload));
      var iss = String((claims && claims.iss) || "").toLowerCase();
      var ref = String((claims && claims.ref) || "").toLowerCase();
      var role = String((claims && claims.role) || "").toLowerCase();
      return (
        iss.indexOf("supabase") !== -1 ||
        ref === "tcnnuaigyavtnenqkjfp" ||
        role === "anon" ||
        role === "authenticated" ||
        role === "service_role"
      );
    } catch (e) {
      return false;
    }
  }

  function isLovableAuthCaptureUrl(url) {
    try {
      var u = new URL(String(url || ""), location.href);
      var host = String(u.hostname || "").toLowerCase();
      return (
        host === "api.lovable.dev" ||
        host === "lovable-api.com" ||
        host === "lovable.dev" ||
        /\.lovable\.dev$/.test(host)
      );
    } catch (e) {
      return false;
    }
  }

  function getProjectFromPage() {
    try {
      const m = window.location.pathname.match(/projects\/([0-9a-fA-F-]{36})/i);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  function extractProjectIdFromUrl(url) {
    try {
      const m = String(url).match(/projects\/([0-9a-fA-F-]{36})/i);
      return m ? m[1] : null;
    } catch {
      return null;
    }
  }

  function normalizeWorkspaceId(value) {
    const id = String(value || "").trim();
    if (!/^[A-Za-z0-9_-]{10,48}$/.test(id)) return "";
    if (/^(projects|workspaces|workspace|skills|users|undefined|null)$/i.test(id)) return "";
    return id;
  }

  function collectWorkspaceIds(input, out, path) {
    out = out || new Set();
    path = path || "";
    if (input == null) return out;
    if (typeof input === "string") {
      const text = input;
      const patterns = [
        /workspaces\/([A-Za-z0-9_-]{10,48})/g,
        /workspace(?:Id|_id)?["'\s:=]+([A-Za-z0-9_-]{10,48})/gi,
        /workspace["']?\s*[:=]\s*["']([A-Za-z0-9_-]{10,48})["']/gi,
      ];
      patterns.forEach((re) => {
        let m;
        while ((m = re.exec(text))) {
          const id = normalizeWorkspaceId(m[1]);
          if (id) out.add(id);
        }
      });
      if (/workspace/i.test(path)) {
        const id = normalizeWorkspaceId(text);
        if (id) out.add(id);
      }
      return out;
    }
    if (Array.isArray(input)) {
      input.forEach((v, i) => collectWorkspaceIds(v, out, path + "[" + i + "]"));
      return out;
    }
    if (typeof input === "object") {
      for (const [key, value] of Object.entries(input)) {
        const nextPath = path ? path + "." + key : key;
        const keyLower = key.toLowerCase();
        const pathHasWorkspace = /workspace/.test(nextPath.toLowerCase());
        if (typeof value === "string") {
          if (/workspace/.test(keyLower) || ((keyLower === "id" || keyLower.endsWith("_id")) && pathHasWorkspace)) {
            const id = normalizeWorkspaceId(value);
            if (id) out.add(id);
          }
        }
        collectWorkspaceIds(value, out, nextPath);
      }
    }
    return out;
  }

  function normalizeSkill(raw) {
    if (!raw || typeof raw !== "object") return null;
    const name = raw.name || raw.slug || raw.handle || raw.key || raw.id;
    if (!name || typeof name !== "string") return null;
    const slug = String(raw.slug || raw.name || raw.handle || raw.key || raw.id || "")
      .trim()
      .replace(/^\/skill:/, "")
      .replace(/\s+/g, "-");
    if (!slug || slug.length > 80) return null;
    const labelSource = raw.title || raw.label || raw.displayName || raw.display_name || raw.name || slug;
    const label = String(labelSource)
      .replace(/^\/skill:/, "")
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return { slug, label, description: raw.description || raw.summary || "", icon: "✨" };
  }

  function collectSkills(input, out, seen, path) {
    out = out || [];
    seen = seen || new Set();
    path = path || "";
    if (!input) return out;
    if (Array.isArray(input)) {
      input.forEach((item) => collectSkills(item, out, seen, path));
      return out;
    }
    if (typeof input === "object") {
      const pathHasSkill = /skill/i.test(path);
      const maybeSkill = pathHasSkill || input.prompt || input.instructions || input.description;
      if (maybeSkill) {
        const skill = normalizeSkill(input);
        if (skill && !seen.has(skill.slug)) {
          seen.add(skill.slug);
          out.push(skill);
        }
      }
      for (const [key, value] of Object.entries(input)) {
        const nextPath = path ? path + "." + key : key;
        if (/^(skills|items|data|results|workspaceSkills|customSkills)$/i.test(key) || /skill/i.test(nextPath)) {
          collectSkills(value, out, seen, nextPath);
        }
      }
    }
    return out;
  }

  function publishLovableDiscovery(url, payload) {
    try {
      const skills = collectSkills(payload);
      const workspaceIds = Array.from(collectWorkspaceIds(payload));
      if (!skills.length && !workspaceIds.length) return;
      window.postMessage({ type: "lovableSkillsFound", url: String(url || ""), skills, workspaceIds }, "*");
    } catch (e) {}
  }

  function inspectLovableResponse(url, response) {
    try {
      const u = String(url || "");
      if (!/(skill|workspace|organization|project)/i.test(u)) return;
      response
        .clone()
        .text()
        .then((text) => {
          if (!text || text.length > 2000000) return;
          let data;
          try {
            data = JSON.parse(text);
          } catch (e) {
            return;
          }
          publishLovableDiscovery(u, data);
        })
        .catch(() => {});
    } catch (e) {}
  }

  function inspectLovableText(url, text) {
    try {
      const u = String(url || "");
      if (!/(skill|workspace|organization|project)/i.test(u)) return;
      if (!text || String(text).length > 2000000) return;
      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        return;
      }
      publishLovableDiscovery(u, data);
    } catch (e) {}
  }

  function notifyFound(token, projectId, force = false) {
    const newProject = projectId || getProjectFromPage();
    const normalizedToken = typeof token === "string" ? token.replace(/^Bearer\s+/i, "").trim() : null;
    if (normalizedToken && isLikelySupabaseJwt(normalizedToken)) {
      if (newProject && newProject !== capturedProjectId) {
        capturedProjectId = newProject;
        window.postMessage({ type: "lovableTokenFound", token: capturedToken, projectId: capturedProjectId }, "*");
      }
      return;
    }
    let changed = false;
    if (normalizedToken && normalizedToken !== capturedToken) {
      capturedToken = normalizedToken;
      try {
        window.__lovasiriLovableToken = normalizedToken;
      } catch (_) {}
      try {
        window.__lovableAuthToken = normalizedToken;
      } catch (_) {}
      changed = true;
    }
    if (newProject && newProject !== capturedProjectId) {
      capturedProjectId = newProject;
      changed = true;
    }
    if (!changed && !force) return;
    console.log("[QuantumHook] ✅ Token capturado!", capturedToken || "null");
    console.log("[QuantumHook] ProjectId:", capturedProjectId);
    window.postMessage({ type: "lovableTokenFound", token: capturedToken, projectId: capturedProjectId }, "*");
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (!event.data || event.data.type !== "lovableRequestToken") return;
    notifyFound(capturedToken, getProjectFromPage() || capturedProjectId, true);
  });

  (function wrapFetch() {
    try {
      const originalFetch = window.fetch;
      window.fetch = async function (...args) {
        let reqUrl = "";
        let reqMethod = "GET";
        let reqBodyText = null;
        let reqBodyRaw = null;
        try {
          reqUrl = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
          let opts = args[1] || {};
          let auth = null;
          if (args[0] instanceof Request) {
            reqUrl = args[0].url || reqUrl;
            reqMethod = (args[0].method || "GET").toUpperCase();
            auth =
              args[0].headers && typeof args[0].headers.get === "function"
                ? args[0].headers.get("Authorization") || args[0].headers.get("authorization")
                : null;
            try {
              if (!opts.body && /^(POST|PUT|PATCH)$/i.test(reqMethod)) {
                const clonedReq = args[0].clone();
                clonedReq
                  .text()
                  .then(function (t) {
                    try {
                      __lovasiriCaptureUploadRequestBody(reqUrl, t);
                    } catch (_) {}
                  })
                  .catch(function () {});
              }
            } catch (_) {}
            try {
              if (!opts.body && /^(PUT|POST)$/i.test(reqMethod) && __lovasiriIsSignedUploadUrl(reqUrl)) {
                const blobReq = args[0].clone();
                blobReq
                  .blob()
                  .then(function (b) {
                    try {
                      if (!b) return;
                      __lovasiriEnrichLast(reqUrl, {
                        name: null,
                        type:
                          b.type ||
                          (args[0].headers && args[0].headers.get && args[0].headers.get("content-type")) ||
                          null,
                        size: typeof b.size === "number" ? b.size : null,
                        ts: Date.now(),
                      });
                    } catch (_) {}
                  })
                  .catch(function () {});
              }
            } catch (_) {}
          }
          if (opts.method) reqMethod = String(opts.method).toUpperCase();
          if (opts.body && typeof opts.body === "string") reqBodyText = opts.body;
          if (opts.body) reqBodyRaw = opts.body;
          if (opts.headers) {
            if (opts.headers instanceof Headers) auth = opts.headers.get("Authorization");
            else if (typeof opts.headers === "object") auth = opts.headers.Authorization || opts.headers.authorization;
          }
          const pid = extractProjectIdFromUrl(reqUrl);
          if (auth && auth.startsWith("Bearer ") && isLovableAuthCaptureUrl(reqUrl)) {
            const rawToken = auth.slice(7);
            notifyFound(rawToken, pid);
          }
          // [LovaSiri] Se for upload direto (PUT/POST binário para signed URL),
          // captura o nome/tipo do File antes de disparar a request.
          try {
            __lovasiriPreCaptureUploadFile(reqUrl, reqMethod, reqBodyRaw, args[0]);
          } catch (_) {}
        } catch (e) {}
        const response = await originalFetch.apply(this, args);
        inspectLovableResponse(reqUrl, response);
        try {
          __lovasiriCaptureUploadUrl(reqUrl, reqMethod, reqBodyText, reqBodyRaw, response);
        } catch (e) {}
        return response;
      };
    } catch (e) {
      console.warn("[QuantumHook] fetch error", e);
    }
  })();

  (function wrapXHR() {
    try {
      const origOpen = XMLHttpRequest.prototype.open;
      const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
      XMLHttpRequest.prototype.open = function (method, url) {
        this._lovable_url = url;
        this._lovable_method = method;
        try {
          this.addEventListener("load", function () {
            try {
              inspectLovableText(this._lovable_url, this.responseText);
            } catch (e) {}
            try {
              if (
                typeof Response !== "undefined" &&
                this.responseText &&
                /\/files\/(?:generate-upload-url|upload-url)(\?|$|#)/i.test(String(this._lovable_url || ""))
              ) {
                var headers = new Headers();
                var ct = this.getResponseHeader && this.getResponseHeader("content-type");
                if (ct) headers.set("content-type", ct);
                __lovasiriCaptureUploadUrl(
                  this._lovable_url,
                  this._lovable_method || "GET",
                  this._lovable_body_text || null,
                  this._lovable_body_raw || null,
                  new Response(this.responseText, { headers: headers }),
                );
              }
            } catch (e) {}
          });
        } catch (e) {}
        return origOpen.apply(this, arguments);
      };
      XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        if (
          name &&
          name.toLowerCase() === "authorization" &&
          value &&
          value.startsWith("Bearer ") &&
          isLovableAuthCaptureUrl(this._lovable_url)
        ) {
          const rawToken = value.slice(7);
          notifyFound(rawToken, extractProjectIdFromUrl(this._lovable_url));
        }
        return origSetHeader.apply(this, arguments);
      };
    } catch (e) {
      console.warn("[QuantumHook] xhr error", e);
    }
  })();

  setInterval(() => {
    const p = getProjectFromPage();
    if (p && p !== capturedProjectId) {
      capturedProjectId = p;
      window.postMessage({ type: "lovableTokenFound", token: capturedToken, projectId: p }, "*");
    }
  }, 1500);

  (function setupLovasiriSpeechBridge() {
    let rec = null;
    let activeRequestId = null;
    let finalText = "";

    function emit(eventType, payload) {
      window.postMessage(
        Object.assign(
          {
            type: "lovasiriSpeechEvent",
            requestId: activeRequestId,
            eventType,
          },
          payload || {},
        ),
        "*",
      );
    }

    function stop() {
      try {
        if (rec) rec.stop();
      } catch (e) {}
    }

    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const msg = event.data || {};
      if (msg.type === "lovasiriSpeechStop") {
        if (!msg.requestId || msg.requestId === activeRequestId) stop();
        return;
      }
      if (msg.type !== "lovasiriSpeechStart") return;

      try {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        activeRequestId = msg.requestId || "speech-" + Date.now();
        finalText = "";
        if (!SR) {
          emit("error", { error: "Web Speech is unavailable in this browser" });
          return;
        }
        if (rec) {
          try {
            rec.stop();
          } catch (e) {}
          rec = null;
        }
        rec = new SR();
        rec.lang = msg.lang || "en-US";
        rec.continuous = true;
        rec.interimResults = true;
        rec.maxAlternatives = 1;
        rec.onstart = () => emit("start");
        rec.onresult = (event) => {
          let interim = "";
          for (let i = event.resultIndex; i < event.results.length; i++) {
            const text = event.results[i][0].transcript;
            if (event.results[i].isFinal) finalText += text + " ";
            else interim += text;
          }
          emit("result", { final: finalText, interim });
        };
        rec.onerror = (event) => emit("error", { error: event.error || "Voice error" });
        rec.onend = () => {
          emit("end", { final: finalText.trim() });
          rec = null;
        };
        rec.start();
      } catch (e) {
        emit("error", { error: (e && e.message) || String(e) });
      }
    });
  })();

  // ─────────────────────────────────────────────────────────────────
  // [Lovasiri Native Intercept v13.42]
  // Envia o POST nativo como intent=fix_error, mas limpa a resposta
  // entregue para a UI para o chat continuar aparecendo como mensagem normal.
  // ─────────────────────────────────────────────────────────────────
  if (typeof window.__lovasiri_native_intercept === "undefined") {
    window.__lovasiri_native_intercept = true;
  }
  if (typeof window.__lovasiri_native_method === "undefined") {
    window.__lovasiri_native_method = "v6";
  }
  if (typeof window.__lovasiri_native_intent === "undefined") {
    window.__lovasiri_native_intent = "fix_error";
  }
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data || {};
    if (d.type === "lovasiriNativePromptSent" && typeof d.text === "string" && d.text.trim()) {
      try {
        __lovasiriRememberNativePrompt(d.text.trim());
      } catch (e) {}
      try {
        __lovasiriScheduleDomRepair();
      } catch (e) {}
      return;
    }
    if (d.type === "lovasiriNativeIntercept" && typeof d.enabled === "boolean") {
      window.__lovasiri_native_intercept = d.enabled;
      if (d.method) window.__lovasiri_native_method = String(d.method || "").toLowerCase() === "v5" ? "v5" : "v6";
      if (d.intent) window.__lovasiri_native_intent = String(d.intent || "");
      console.log(
        "[LovasiriIntercept] enabled =",
        d.enabled,
        "method =",
        window.__lovasiri_native_method,
        "intent =",
        window.__lovasiri_native_intent,
      );
    }
  });

  function __lovasiriIsChatPost(url, method) {
    try {
      if (String(method || "").toUpperCase() !== "POST") return false;
      return /\/projects\/[0-9a-fA-F-]{36}\/chat(?:$|\?)/.test(String(url || ""));
    } catch (e) {
      return false;
    }
  }

  function __lovasiriMakeBuildEventId(payload) {
    try {
      if (payload && typeof payload.build_event_id === "string" && payload.build_event_id)
        return payload.build_event_id;
      if (payload && typeof payload.id === "string" && payload.id) return payload.id;
      if (crypto && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    } catch (e) {}
    return "build_" + Date.now() + "_" + Math.random().toString(36).slice(2);
  }

  function __lovasiriRewriteBody(bodyStr) {
    try {
      if (!bodyStr || typeof bodyStr !== "string") return null;
      var payload = JSON.parse(bodyStr);
      if (!payload || typeof payload !== "object") return null;

      // ─────────────────────────────────────────────────────────────
      // [Lovasiri v14.0.4] Respeitar toggle do Chat Padrão da extensão.
      // Se o Chat Padrão estiver DESATIVADO, NÃO interceptamos nada —
      // deixamos o envio nativo da Lovable seguir intacto (comportamento
      // padrão da plataforma). Se estiver ATIVADO, reescrevemos o payload
      // usando o método selecionado (v6 = fix_error, v5 = security_scan).
      // ─────────────────────────────────────────────────────────────
      try {
        if (document.documentElement.getAttribute("data-ql-native-chat-active") !== "1") {
          return null;
        }
      } catch (_) {
        return null;
      }

      // Leitura SÍNCRONA do método a partir do DOM (setado pelo content.js
      // antes do click). window.__lovasiri_native_method vem de postMessage
      // que é assíncrono e chega tarde demais.
      var domMethod = "";
      try {
        domMethod = document.documentElement.getAttribute("data-lovasiri-method") || "";
      } catch (_) {}
      var rawMethod = domMethod || window.__lovasiri_native_method || "v6";
      var selectedMethod = String(rawMethod).toLowerCase() === "v5" ? "v5" : "v6";
      var selectedIntent = selectedMethod === "v5" ? "security_scan" : "fix_error";
      var currentIntent = String(payload.intent || payload.message_intent || "").toLowerCase();
      // No MÉTODO 2, força security_scan mesmo se a Lovable reaproveitar fix_error
      // no composer. No MÉTODO 1, mantém o comportamento anterior.
      if (currentIntent && selectedMethod !== "v5" && currentIntent !== "fix_error") return null;

      var msg =
        typeof payload.message === "string"
          ? payload.message
          : typeof payload.text === "string"
            ? payload.text
            : typeof payload.content === "string"
              ? payload.content
              : "";
      if (!msg.trim()) return null;
      try {
        __lovasiriRememberNativePrompt(msg.trim());
      } catch (e) {}
      try {
        __lovasiriScheduleDomRepair();
      } catch (e) {}

      var buildEventId = __lovasiriMakeBuildEventId(payload);
      // Payload igual ao padrão Nexus: mensagem original preservada, método aplicado
      // só no request enviado para a API. Método 1 = fix_error; Método 2 = security_scan.
      payload.view = payload.view || "preview";
      payload.message = msg;
      payload.text = msg;
      payload.content = msg;
      payload.user_message = msg;
      payload.userMessage = msg;
      payload.display_text = msg;
      payload.displayText = msg;
      payload.intent = selectedIntent;
      payload.message_intent = selectedIntent;
      payload.send_method = selectedMethod;
      payload.chat_only = false;
      payload.contains_error = selectedIntent === "fix_error";
      if (typeof payload.ai_message_id === "undefined") payload.ai_message_id = null;
      if (selectedIntent === "security_scan") {
        // SECURITY_SCAN não usa metadata no payload oficial da Lovable.
        // Enviar security_scan_metadata dispara o erro de "unsupported metadata variant".
        try {
          delete payload.message_intent_metadata;
        } catch (_) {}
        try {
          delete payload.messageIntentMetadata;
        } catch (_) {}
        try {
          delete payload.contains_error;
        } catch (_) {}
        try {
          delete payload.error_ids;
        } catch (_) {}
        try {
          delete payload.runtime_errors;
        } catch (_) {}
      } else {
        payload.message_intent_metadata = {
          fix_error_metadata: {
            errors: [
              {
                error_type: "build",
                error_message: msg,
                message: msg,
                text: msg,
                user_message: msg,
                display_text: msg,
                build_event_id: buildEventId,
              },
            ],
          },
        };
      }

      console.log("[LovasiriIntercept] ✅ POST nativo enviado como " + selectedIntent + ":", msg.slice(0, 60));
      return JSON.stringify(payload);
    } catch (e) {
      console.warn("[LovasiriIntercept] error rewriting", e);
      return null;
    }
  }

  function __lovasiriRememberNativePrompt(text) {
    try {
      var promptText = String(text || "").trim();
      if (!promptText) return;
      var item = { text: promptText, ts: Date.now() };
      window.__lovasiri_last_native_prompt = item;
      var list = Array.isArray(window.__lovasiri_native_prompt_history) ? window.__lovasiri_native_prompt_history : [];
      list.push(item);
      window.__lovasiri_native_prompt_history = list.slice(-12);
      try {
        sessionStorage.setItem("__lovasiri_last_native_prompt", JSON.stringify(item));
      } catch (_) {}
    } catch (e) {}
  }

  function __lovasiriScrubUiValue(value) {
    try {
      if (typeof value === "string") {
        if (
          !/(fix_error|security_scan|message_intent_metadata|fix_error_metadata|security_scan_metadata|runtime_errors|build_event_id)/.test(
            value,
          )
        )
          return value;
        var trimmed = value.trim();
        if (!/^[\[{]/.test(trimmed)) return value;
        try {
          return JSON.stringify(__lovasiriScrubUiValue(JSON.parse(value)));
        } catch (e) {
          return value;
        }
      }
      if (!value || typeof value !== "object") return value;
      if (Array.isArray(value)) {
        for (var i = 0; i < value.length; i++) __lovasiriScrubUiValue(value[i]);
        return value;
      }

      // Quando o envio é transformado em fix_error, a Lovable pode devolver a
      // mensagem visível como "Fix build error" e guardar o prompt real apenas em
      // message_intent_metadata.fix_error_metadata.errors[].error_message.
      // Se apagarmos o metadata sem substituir esse rótulo pelo prompt, o limpador
      // visual esconde "Fix build error" e a bolha do usuário fica vazia.
      var __lovasiriVisiblePrompt = __lovasiriExtractFixErrorPrompt(value);
      if (!__lovasiriVisiblePrompt && __lovasiriLooksLikeCurrentFixError(value))
        __lovasiriVisiblePrompt = __lovasiriGetRecentNativePrompt();
      if (__lovasiriVisiblePrompt) __lovasiriPromotePromptToVisibleFields(value, __lovasiriVisiblePrompt);

      Object.keys(value).forEach(function (key) {
        if (
          key === "message_intent_metadata" ||
          key === "fix_error_metadata" ||
          key === "security_scan_metadata" ||
          key === "runtime_errors" ||
          key === "error_ids" ||
          key === "build_event_id"
        ) {
          delete value[key];
          return;
        }
        if (
          (key === "intent" || key === "message_intent") &&
          (value[key] === "fix_error" || value[key] === "security_scan")
        ) {
          delete value[key];
          return;
        }
        if (key === "contains_error" && value[key] === true) {
          value[key] = false;
          return;
        }
        value[key] = __lovasiriScrubUiValue(value[key]);
      });
    } catch (e) {}
    return value;
  }

  function __lovasiriExtractFixErrorPrompt(value) {
    try {
      if (!value || typeof value !== "object") return "";
      var meta = value.message_intent_metadata || value.messageIntentMetadata || null;
      var sec = meta && (meta.security_scan_metadata || meta.securityScanMetadata);
      var directSecMessage =
        sec &&
        (sec.error_message ||
          sec.errorMessage ||
          sec.message ||
          sec.text ||
          sec.prompt ||
          sec.user_message ||
          sec.userMessage ||
          sec.display_text ||
          sec.displayText);
      if (
        typeof directSecMessage === "string" &&
        directSecMessage.trim() &&
        !__lovasiriIsFixMethodLabel(directSecMessage)
      )
        return directSecMessage.trim();
      var fix = meta && (meta.fix_error_metadata || meta.fixErrorMetadata);
      var directFixMessage =
        fix &&
        (fix.error_message ||
          fix.errorMessage ||
          fix.message ||
          fix.text ||
          fix.prompt ||
          fix.user_message ||
          fix.userMessage);
      if (
        typeof directFixMessage === "string" &&
        directFixMessage.trim() &&
        !__lovasiriIsFixMethodLabel(directFixMessage)
      )
        return directFixMessage.trim();
      var errors = fix && Array.isArray(fix.errors) ? fix.errors : [];
      for (var i = 0; i < errors.length; i++) {
        var msg =
          errors[i] &&
          (errors[i].error_message ||
            errors[i].errorMessage ||
            errors[i].message ||
            errors[i].text ||
            errors[i].prompt ||
            errors[i].user_message ||
            errors[i].userMessage);
        if (typeof msg === "string" && msg.trim() && !__lovasiriIsFixMethodLabel(msg)) return msg.trim();
      }
    } catch (e) {}
    return "";
  }

  function __lovasiriIsBlankVisibleValue(v) {
    try {
      if (v == null) return true;
      if (typeof v === "string") return !v.trim();
      if (Array.isArray(v)) return v.length === 0;
      if (typeof v === "object") return Object.keys(v).length === 0;
    } catch (e) {}
    return false;
  }

  function __lovasiriIsFixMethodLabel(v) {
    try {
      if (typeof v !== "string") return false;
      var t = v.replace(/\s+/g, " ").trim().toLowerCase();
      return (
        t === "fix build error" ||
        t === "security scan" ||
        t === "security_scan" ||
        t === "fix_error" ||
        t === "〽️ sent by lovable vibeX" ||
        t === "〽️ sent by lovable vibeX 2" ||
        t === "sent by lovable vibeX" ||
        t === "sent by lovable vibeX 2" ||
        t === "〽️ processing..." ||
        t === "processing..." ||
        t === "💬 sent by lovable" ||
        t === "sent by lovable"
      );
    } catch (e) {
      return false;
    }
  }

  function __lovasiriShouldReplaceVisibleValue(v) {
    return __lovasiriIsBlankVisibleValue(v) || __lovasiriIsFixMethodLabel(v);
  }

  function __lovasiriLooksLikeMessageObject(obj) {
    try {
      if (!obj || typeof obj !== "object") return false;
      var role = String(obj.role || obj.author || obj.sender || "").toLowerCase();
      if (role === "user" || role === "human") return true;
      if (obj.ai_message_id || obj.thread_id || obj.message_id || obj.messageId) return true;
    } catch (e) {}
    return false;
  }

  function __lovasiriLooksLikeCurrentFixError(obj) {
    try {
      if (!obj || typeof obj !== "object") return false;
      if (
        obj.intent === "fix_error" ||
        obj.message_intent === "fix_error" ||
        obj.intent === "security_scan" ||
        obj.message_intent === "security_scan"
      )
        return true;
      if (
        obj.message_intent_metadata ||
        obj.messageIntentMetadata ||
        obj.fix_error_metadata ||
        obj.fixErrorMetadata ||
        obj.security_scan_metadata ||
        obj.securityScanMetadata
      )
        return true;
    } catch (e) {}
    return false;
  }

  function __lovasiriPromotePromptToVisibleFields(obj, prompt, forceCreate) {
    try {
      if (!obj || typeof obj !== "object" || !prompt) return;
      if (typeof forceCreate === "undefined") forceCreate = true;

      var keys = [
        "message",
        "text",
        "content",
        "body",
        "prompt",
        "user_message",
        "userMessage",
        "display_text",
        "displayText",
        "value",
        "markdown",
      ];
      var hadVisibleKey = false;
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
          hadVisibleKey = true;
          if (__lovasiriShouldReplaceVisibleValue(obj[k])) obj[k] = prompt;
        }
      }

      if (!hadVisibleKey && (forceCreate || __lovasiriLooksLikeMessageObject(obj))) {
        obj.message = prompt;
        obj.content = prompt;
        obj.text = prompt;
      }

      if (Array.isArray(obj.parts)) {
        var hasTextPart = false;
        for (var p = 0; p < obj.parts.length; p++) {
          var part = obj.parts[p];
          if (part && part.type === "text") {
            hasTextPart = true;
            if (__lovasiriShouldReplaceVisibleValue(part.text)) part.text = prompt;
          }
          if (part && part.type === "text-delta") {
            hasTextPart = true;
            if (__lovasiriShouldReplaceVisibleValue(part.textDelta || part.delta || part.text)) {
              part.textDelta = prompt;
              part.delta = prompt;
              part.text = prompt;
            }
          }
        }
        if (!hasTextPart && obj.parts.length === 0) obj.parts.push({ type: "text", text: prompt });
      }

      if (Array.isArray(obj.segments)) {
        if (obj.segments.length === 0) {
          obj.segments.push({ type: "text", text: prompt });
        } else {
          for (var s = 0; s < obj.segments.length; s++) {
            if (obj.segments[s] && __lovasiriShouldReplaceVisibleValue(obj.segments[s].text))
              obj.segments[s].text = prompt;
          }
        }
      }

      // Propaga o prompt para objetos filhos que carregam campos visíveis com o
      // rótulo do método. Isso cobre respostas em formatos diferentes (message,
      // data.message, optimisticMessage, items[].parts, etc.) sem tocar no envio.
      Object.keys(obj).forEach(function (childKey) {
        if (
          childKey === "message_intent_metadata" ||
          childKey === "fix_error_metadata" ||
          childKey === "security_scan_metadata"
        )
          return;
        var child = obj[childKey];
        if (child && typeof child === "object") {
          if (Array.isArray(child)) {
            child.forEach(function (item) {
              if (item && typeof item === "object") __lovasiriPromotePromptToVisibleFields(item, prompt, false);
            });
          } else {
            __lovasiriPromotePromptToVisibleFields(child, prompt, false);
          }
        }
      });
    } catch (e) {}
  }

  function __lovasiriExtractPromptFromAnyFixMetadata(value) {
    try {
      if (!value || typeof value !== "object") return "";
      var direct = __lovasiriExtractFixErrorPrompt(value);
      if (direct) return direct;
      if (Array.isArray(value)) {
        for (var i = 0; i < value.length; i++) {
          var foundArr = __lovasiriExtractPromptFromAnyFixMetadata(value[i]);
          if (foundArr) return foundArr;
        }
        return "";
      }
      for (var k in value) {
        if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
        var found = __lovasiriExtractPromptFromAnyFixMetadata(value[k]);
        if (found) return found;
      }
    } catch (e) {}
    return "";
  }

  function __lovasiriCleanJsonText(text) {
    try {
      var parsed = JSON.parse(text);
      var prompt = __lovasiriExtractPromptFromAnyFixMetadata(parsed);
      if (!prompt && __lovasiriExtractCurrentFixMarker(parsed)) prompt = __lovasiriGetRecentNativePrompt();
      if (prompt) __lovasiriPromotePromptToVisibleFields(parsed, prompt);
      return JSON.stringify(__lovasiriScrubUiValue(parsed));
    } catch (e) {
      return String(text || "")
        .replace(/("intent"\s*:\s*)"fix_error"/g, "$1null")
        .replace(/("intent"\s*:\s*)"security_scan"/g, "$1null")
        .replace(/("message_intent"\s*:\s*)"fix_error"/g, "$1null")
        .replace(/("message_intent"\s*:\s*)"security_scan"/g, "$1null")
        .replace(/("contains_error"\s*:\s*)true/g, "$1false");
    }
  }

  function __lovasiriExtractCurrentFixMarker(value) {
    try {
      if (!value || typeof value !== "object") return false;
      if (__lovasiriLooksLikeCurrentFixError(value)) return true;
      if (Array.isArray(value)) {
        for (var i = 0; i < value.length; i++) if (__lovasiriExtractCurrentFixMarker(value[i])) return true;
        return false;
      }
      for (var k in value) {
        if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
        if (__lovasiriExtractCurrentFixMarker(value[k])) return true;
      }
    } catch (e) {}
    return false;
  }

  function __lovasiriCleanSseLine(line) {
    try {
      if (!/^data:\s*/.test(line)) return line;
      var prefix = line.match(/^data:\s*/)[0];
      var data = line.slice(prefix.length);
      if (!data || data === "[DONE]") return line;
      return prefix + __lovasiriCleanJsonText(data);
    } catch (e) {
      return line;
    }
  }

  function __lovasiriCleanUiText(text) {
    try {
      if (!text || typeof text !== "string") return text;
      if (/^\s*[\[{]/.test(text)) return __lovasiriCleanJsonText(text);
      return text
        .split(/(\r?\n)/)
        .map(function (part) {
          return /^data:\s*/.test(part) ? __lovasiriCleanSseLine(part) : part;
        })
        .join("");
    } catch (e) {
      return text;
    }
  }

  function __lovasiriSanitizeResponseForUi(response) {
    try {
      if (!response || !response.body || typeof TransformStream === "undefined") return response;
      var contentType = "";
      try {
        contentType = response.headers && response.headers.get ? response.headers.get("content-type") || "" : "";
      } catch (e) {}
      if (!/json|text|event-stream|stream/i.test(contentType)) return response;

      var decoder = new TextDecoder();
      var encoder = new TextEncoder();
      var carry = "";
      var stream = response.body.pipeThrough(
        new TransformStream({
          transform: function (chunk, controller) {
            try {
              var text = carry + decoder.decode(chunk, { stream: true });
              var cut = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
              if (cut < 0) {
                carry = text;
                return;
              }
              var emit = text.slice(0, cut + 1);
              carry = text.slice(cut + 1);
              if (emit) controller.enqueue(encoder.encode(__lovasiriCleanUiText(emit)));
            } catch (e) {
              controller.enqueue(chunk);
            }
          },
          flush: function (controller) {
            try {
              var rest = carry + decoder.decode();
              if (rest) controller.enqueue(encoder.encode(__lovasiriCleanUiText(rest)));
            } catch (e) {}
          },
        }),
      );
      return new Response(stream, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (e) {
      console.warn("[LovasiriIntercept] sanitize response falhou", e);
      return response;
    }
  }

  function __lovasiriRestoreHiddenUi() {
    try {
      var nodes = document.querySelectorAll("[data-lovasiri-hidden-fix-ui], [data-lovasiri-hidden-fix-decoration]");
      nodes.forEach(function (el) {
        el.style.removeProperty("display");
        el.removeAttribute("data-lovasiri-hidden-fix-ui");
        el.removeAttribute("data-lovasiri-hidden-fix-decoration");
      });
    } catch (e) {}
  }

  function __lovasiriGetRecentNativePrompt() {
    try {
      var last = window.__lovasiri_last_native_prompt || null;
      if (!last || !last.text) {
        try {
          last = JSON.parse(sessionStorage.getItem("__lovasiri_last_native_prompt") || "null");
        } catch (_) {}
      }
      if (!last || !last.text) return "";
      if (Date.now() - (last.ts || 0) > 600000) return "";
      return String(last.text || "").trim();
    } catch (e) {
      return "";
    }
  }

  function __lovasiriIsInsideComposer(el) {
    try {
      return !!(
        el &&
        el.closest &&
        el.closest(
          'form#chat-input, textarea, [contenteditable="true"], [data-testid*="chat-input" i], [class*="composer" i]',
        )
      );
    } catch (e) {
      return false;
    }
  }

  function __lovasiriReplaceNodeTextWithPrompt(node, prompt) {
    try {
      var el = node && node.parentElement;
      var best = null;
      var steps = 0;
      while (el && steps < 7) {
        if (__lovasiriIsInsideComposer(el)) return false;
        if (__lovasiriIsFixMethodLabel(el.textContent || "")) best = el;
        if (
          el.getAttribute &&
          (el.getAttribute("role") === "article" ||
            el.getAttribute("data-message-id") ||
            /message/i.test(String(el.getAttribute("data-testid") || "") + " " + String(el.className || "")))
        )
          break;
        el = el.parentElement;
        steps++;
      }
      if (best) best.textContent = prompt;
      else node.nodeValue = prompt;
      return true;
    } catch (e) {
      return false;
    }
  }

  function __lovasiriScheduleDomRepair() {
    try {
      [80, 250, 700, 1500, 3000, 6000].forEach(function (ms) {
        setTimeout(__lovasiriHideFixDecorationsOnly, ms);
      });
    } catch (e) {}
  }

  function __lovasiriTextIsExact(el, labels) {
    try {
      var t = String((el && el.textContent) || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      return labels.indexOf(t) !== -1;
    } catch (e) {
      return false;
    }
  }

  function __lovasiriHideExactElementFromTextNode(node, labels, replaceWithPrompt) {
    try {
      var recentPrompt = __lovasiriGetRecentNativePrompt();
      if (replaceWithPrompt && recentPrompt && !__lovasiriIsInsideComposer(node.parentElement)) {
        if (__lovasiriReplaceNodeTextWithPrompt(node, recentPrompt)) return;
      }
      var el = node.parentElement;
      var best = null;
      var inMessage = false;
      var steps = 0;
      while (el && steps < 4) {
        if (__lovasiriTextIsExact(el, labels)) best = el;
        if (el.getAttribute && (el.getAttribute("role") === "article" || el.getAttribute("data-message-id"))) {
          inMessage = true;
          break;
        }
        el = el.parentElement;
        steps++;
      }
      if (replaceWithPrompt && recentPrompt && inMessage) {
        // No fluxo Nexus a Lovable pode renderizar primeiro o método e depois o
        // texto. Se a troca ainda não veio pelo estado interno, substituímos só o
        // rótulo exato dentro da mensagem pelo prompt real capturado do request.
        if (best) best.textContent = recentPrompt;
        else node.nodeValue = recentPrompt;
        return;
      }
      if (best) {
        best.style.setProperty("display", "none", "important");
        best.setAttribute("data-lovasiri-hidden-fix-decoration", "true");
      } else {
        node.nodeValue = "";
      }
    } catch (e) {}
  }

  // [v13.87] Substituição instantânea do método -> Lovasiri/Lovasiri2.
  // Chamada tanto por MutationObserver(characterData) quanto pelo pass de decorações.
  function __lovasiriInstantSwapLabelNode(node) {
    try {
      if (!node || node.nodeType !== 3) return false;
      if (!/\/projects\/[0-9a-fA-F-]{36}/.test(location.pathname)) return false;
      var raw = String(node.nodeValue || "")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
      if (!raw) return false;
      var securityLabels = ["security scan", "security_scan"];
      var fixLabels = ["fix build error", "fix_error"];
      var isSec = securityLabels.indexOf(raw) !== -1;
      var isFix = fixLabels.indexOf(raw) !== -1;
      if (!isSec && !isFix) return false;
      if (__lovasiriIsInsideComposer(node.parentElement)) return false;
      var lovLabel = "〽️ Processing...";
      var sentLabel = "💬 Sent by Lovable";
      // Sempre mostra primeiro o selo Lovasiri escolhido. Na v13.86, quando o
      // prompt já estava capturado, a troca ia direto para o texto e o usuário
      // não conseguia ver se foi Lovasiri ou Lovasiri2.
      try {
        node.nodeValue = lovLabel;
      } catch (_) {}
      var capturedNode = node;
      var capturedLabel = lovLabel;
      [650, 1100, 1800, 3000].forEach(function (delay) {
        setTimeout(function () {
          try {
            var later = __lovasiriGetRecentNativePrompt();
            if (!later) return;
            var current = String(capturedNode.nodeValue || "")
              .replace(/\s+/g, " ")
              .trim();
            if (current !== capturedLabel && !__lovasiriIsFixMethodLabel(current)) return;
            if (__lovasiriIsInsideComposer(capturedNode.parentElement)) return;
            __lovasiriReplaceNodeTextWithPrompt(capturedNode, later) || (capturedNode.nodeValue = later);
          } catch (_) {}
        }, delay);
      });
      // Settle state: once the request is on its way and no native prompt was
      // captured, stop showing "Processing..." forever and show the sent badge.
      setTimeout(function () {
        try {
          var later = __lovasiriGetRecentNativePrompt();
          var current = String(capturedNode.nodeValue || "")
            .replace(/\s+/g, " ")
            .trim();
          if (current !== capturedLabel) return;
          if (__lovasiriIsInsideComposer(capturedNode.parentElement)) return;
          var finalText = later || sentLabel;
          __lovasiriReplaceNodeTextWithPrompt(capturedNode, finalText) || (capturedNode.nodeValue = finalText);
        } catch (_) {}
      }, 4000);
      return true;
    } catch (e) {
      return false;
    }
  }

  function __lovasiriHideFixDecorationsOnly() {
    try {
      // Só roda dentro de um projeto (editor). Fora disso não existem decorações.
      if (!/\/projects\/[0-9a-fA-F-]{36}/.test(location.pathname)) return;
      var securityLabels = ["security scan", "security_scan"];
      var fixLabels = ["fix build error", "fix_error"];
      var exactLabels = fixLabels.concat(securityLabels);
      var exactToggles = ["show less", "show more", "mostrar menos", "mostrar mais", "ver menos", "ver mais"];
      var walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
      var node;
      while ((node = walker.nextNode())) {
        var value = String(node.nodeValue || "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        if (exactLabels.indexOf(value) !== -1) {
          __lovasiriInstantSwapLabelNode(node);
        } else if (exactToggles.indexOf(value) !== -1) {
          __lovasiriHideExactElementFromTextNode(node, exactToggles, false);
        }
      }
    } catch (e) {}
  }

  (function wrapChatIntercept() {
    try {
      var origFetch = window.fetch;
      window.fetch = async function (input, init) {
        try {
          if (!window.__lovasiri_native_intercept) {
            var disabledRes = await origFetch.apply(this, arguments);
            return __lovasiriSanitizeResponseForUi(disabledRes);
          }
          var url = "",
            method = "GET",
            bodyStr = null;
          if (input instanceof Request) {
            url = input.url;
            method = input.method;
            if (__lovasiriIsChatPost(url, method)) {
              bodyStr = await input.clone().text();
              var rw = __lovasiriRewriteBody(bodyStr);
              if (rw) {
                var newReq = new Request(input, { body: rw });
                var res = await origFetch.call(this, newReq);
                return __lovasiriSanitizeResponseForUi(res);
              }
            }
          } else {
            url = typeof input === "string" ? input : (input && input.url) || "";
            method = (init && init.method) || "GET";
            if (__lovasiriIsChatPost(url, method) && init && typeof init.body === "string") {
              var rw2 = __lovasiriRewriteBody(init.body);
              if (rw2) {
                var newInit = Object.assign({}, init, { body: rw2 });
                var res2 = await origFetch.call(this, input, newInit);
                return __lovasiriSanitizeResponseForUi(res2);
              }
            }
          }
        } catch (e) {
          console.warn("[LovasiriIntercept] fetch wrap err", e);
        }
        var passthroughRes = await origFetch.apply(this, arguments);
        // Também limpa/promove respostas de refetch/polling da conversa. Isso é
        // essencial quando o envio veio pela API da extensão/background: o POST já
        // aconteceu fora da página, mas o histórico volta para a UI contendo
        // fix_error_metadata com o prompt real.
        return __lovasiriSanitizeResponseForUi(passthroughRes);
      };

      // XHR: raro no chat da Lovable, mas cobrimos o envio.
      var origSend = XMLHttpRequest.prototype.send;
      var origOpen2 = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function (method, url) {
        this.__lov_method = method;
        this.__lov_url = url;
        return origOpen2.apply(this, arguments);
      };
      XMLHttpRequest.prototype.send = function (body) {
        try {
          this._lovable_body_raw = body || null;
          this._lovable_body_text = typeof body === "string" ? body : null;
          try {
            __lovasiriPreCaptureUploadFile(
              this.__lov_url || this._lovable_url,
              this.__lov_method || this._lovable_method,
              body,
              null,
            );
          } catch (e) {}
          if (
            window.__lovasiri_native_intercept &&
            __lovasiriIsChatPost(this.__lov_url, this.__lov_method) &&
            typeof body === "string"
          ) {
            var rw = __lovasiriRewriteBody(body);
            if (rw) return origSend.call(this, rw);
          }
        } catch (e) {}
        return origSend.apply(this, arguments);
      };

      // Backup visual: esconde somente os textos exatos do método/expandir.
      // Nunca esconde o card inteiro se ele também contém o prompt do usuário.
      if (document && document.documentElement) {
        var __lovDomBusy = false;
        var __lovDomTimer = null;
        var domClean = function () {
          // Só roda em página de projeto (editor). No dashboard/listagem fica de fora.
          if (!/\/projects\/[0-9a-fA-F-]{36}/.test(location.pathname)) return;
          try {
            __lovasiriRestoreHiddenUi();
          } catch (e) {}
          try {
            __lovasiriHideFixDecorationsOnly();
          } catch (e) {}
        };
        var scheduleDomClean = function () {
          if (__lovDomBusy) return;
          __lovDomBusy = true;
          // Agrupa dentro de rAF + pequeno delay para não repintar constantemente durante stream.
          requestAnimationFrame(function () {
            if (__lovDomTimer) clearTimeout(__lovDomTimer);
            __lovDomTimer = setTimeout(function () {
              __lovDomBusy = false;
              domClean();
            }, 250);
          });
        };
        // Intervalo bem mais longo (só como fallback). O MutationObserver cobre mudanças reais.
        setInterval(function () {
          if (!document.hidden) scheduleDomClean();
        }, 3000);
        try {
          // childList+subtree apenas — sem characterData/attributes (evita disparo em cada re-render).
          new MutationObserver(scheduleDomClean).observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
          });
        } catch (e) {}

        // [v13.87] Observer instantâneo dedicado ao rótulo do método.
        // Roda síncrono a cada mutação de texto/nó — sem rAF, sem debounce —
        // para que "Fix build error" / "Security scan" nunca chegue a
        // aparecer visualmente; no lugar aparece 〽️ Lovasiri/Lovasiri2 antes do prompt.
        try {
          var instantLabelSwap = function (mutations) {
            for (var i = 0; i < mutations.length; i++) {
              var m = mutations[i];
              if (m.type === "characterData") {
                __lovasiriInstantSwapLabelNode(m.target);
              } else if (m.type === "childList" && m.addedNodes && m.addedNodes.length) {
                for (var j = 0; j < m.addedNodes.length; j++) {
                  var n = m.addedNodes[j];
                  if (!n) continue;
                  if (n.nodeType === 3) {
                    __lovasiriInstantSwapLabelNode(n);
                  } else if (n.nodeType === 1 && n.querySelectorAll) {
                    try {
                      var walker = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
                      var tn;
                      while ((tn = walker.nextNode())) {
                        if (__lovasiriInstantSwapLabelNode(tn)) break;
                      }
                    } catch (_) {}
                  }
                }
              }
            }
          };
          new MutationObserver(instantLabelSwap).observe(document.body || document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
          });
        } catch (e) {}
      }

      console.log("[LovasiriIntercept] Instalado (fix_error no request + UI nativa limpa)");
    } catch (e) {
      console.warn("[LovasiriIntercept] failed to install", e);
    }
  })();

  // ─────────────────────────────────────────────────────────────────
  // [LovaSiri Native Upload Capture — método Nexus]
  // Intercepta as respostas de /files/(generate-upload-url|upload-url)
  // da Lovable e repassa para o content script (isolated world) via
  // postMessage. O content acumula em qlLovableNativeAttachments e
  // injeta no payload do send-lovable-prompt6.
  // ─────────────────────────────────────────────────────────────────
  // Guarda o último File "cru" enviado (PUT binário para signed URL) e uma
  // fila de metadados extraídos de FormData / File. Casamos com a resposta
  // de /files/(generate|upload)-url por proximidade temporal.
  var __lovasiriPendingFiles = [];
  var __lovasiriLastRawFile = null;
  var __lovasiriLastUploadRequestBody = null;

  function __lovasiriIsGenericMimeType(type) {
    var t = String(type || "")
      .trim()
      .toLowerCase();
    return !t || t === "application/octet-stream" || t === "binary/octet-stream" || t === "application/unknown";
  }

  function __lovasiriGuessMimeFromName(name, currentType) {
    var type = String(currentType || "").trim();
    var ext = String(name || "")
      .split(".")
      .pop()
      .toLowerCase();
    var map = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
      svg: "image/svg+xml",
      bmp: "image/bmp",
      avif: "image/avif",
      txt: "text/plain",
      md: "text/markdown",
      csv: "text/csv",
      tsv: "text/tab-separated-values",
      json: "application/json",
      env: "text/plain",
      log: "text/plain",
      xml: "application/xml",
      yaml: "application/yaml",
      yml: "application/yaml",
      zip: "application/zip",
      rar: "application/vnd.rar",
      "7z": "application/x-7z-compressed",
      pdf: "application/pdf",
    };
    if (type && !__lovasiriIsGenericMimeType(type)) return type;
    if (map[ext]) return map[ext];
    return type || null;
  }

  function __lovasiriCaptureUploadRequestBody(url, text) {
    try {
      if (!/\/files\/(?:generate-upload-url|upload-url)(\?|$|#)/i.test(String(url || ""))) return;
      var body = null;
      try {
        body = JSON.parse(String(text || ""));
      } catch (_) {
        return;
      }
      __lovasiriLastUploadRequestBody = { body: body, ts: Date.now() };
    } catch (_) {}
  }

  function __lovasiriExtractFileMeta(f) {
    if (!f) return null;
    try {
      return {
        name: (f.name || "").toString() || null,
        type: (f.type || "").toString() || null,
        size: typeof f.size === "number" ? f.size : null,
        ts: Date.now(),
      };
    } catch (_) {
      return null;
    }
  }

  function __lovasiriRememberSelectedFiles(files) {
    try {
      Array.from(files || []).forEach(function (f) {
        var m = __lovasiriExtractFileMeta(f);
        if (m && m.name) {
          m.type = __lovasiriGuessMimeFromName(m.name, m.type) || m.type;
          __lovasiriLastRawFile = m;
          __lovasiriPendingFiles.push(m);
        }
      });
      if (__lovasiriPendingFiles.length > 30) __lovasiriPendingFiles = __lovasiriPendingFiles.slice(-30);
    } catch (_) {}
  }

  (function __lovasiriInstallNativeFileSelectionCapture() {
    try {
      document.addEventListener(
        "change",
        function (e) {
          try {
            var input = e && e.target;
            if (!input || input.tagName !== "INPUT" || input.type !== "file") return;
            if (input.files && input.files.length) __lovasiriRememberSelectedFiles(input.files);
          } catch (_) {}
        },
        true,
      );
      document.addEventListener(
        "drop",
        function (e) {
          try {
            var files = e && e.dataTransfer && e.dataTransfer.files;
            if (files && files.length) __lovasiriRememberSelectedFiles(files);
          } catch (_) {}
        },
        true,
      );
    } catch (_) {}
  })();

  function __lovasiriIsSignedUploadUrl(url) {
    return (
      /supabase\.co\/storage\/v1\/object\//i.test(String(url || "")) ||
      /amazonaws\.com|storage\.googleapis\.com|blob\.core\.windows\.net|r2\.cloudflarestorage\.com/i.test(
        String(url || ""),
      )
    );
  }

  function __lovasiriPreCaptureUploadFile(url, method, body, input) {
    if (!body) return;
    var isUploadPut = /^(PUT|POST)$/i.test(String(method || "")) && __lovasiriIsSignedUploadUrl(url);
    // FormData: procura qualquer File dentro
    try {
      if (typeof FormData !== "undefined" && body instanceof FormData) {
        body.forEach(function (v) {
          if (v && typeof File !== "undefined" && v instanceof File) {
            var m = __lovasiriExtractFileMeta(v);
            if (m && m.name) {
              __lovasiriPendingFiles.push(m);
              if (isUploadPut) __lovasiriEnrichLast(url, m);
            }
          }
        });
        return;
      }
    } catch (_) {}
    // File / Blob direto no body (PUT em signed URL)
    try {
      if (typeof File !== "undefined" && body instanceof File) {
        var m1 = __lovasiriExtractFileMeta(body);
        if (m1) {
          __lovasiriLastRawFile = m1;
          __lovasiriPendingFiles.push(m1);
          if (isUploadPut) __lovasiriEnrichLast(url, m1);
        }
        return;
      }
      if (typeof Blob !== "undefined" && body instanceof Blob) {
        __lovasiriLastRawFile = { name: null, type: body.type || null, size: body.size || null, ts: Date.now() };
        if (isUploadPut) __lovasiriEnrichLast(url, __lovasiriLastRawFile);
        return;
      }
    } catch (_) {}
  }

  // Envia enriquecimento para o content script (casa por upload_url quando possível).
  function __lovasiriEnrichLast(uploadUrl, meta) {
    try {
      window.postMessage(
        {
          type: "lovasiriLovableUploadEnrich",
          upload_url: String(uploadUrl || ""),
          file: {
            file_name: meta.name || null,
            mime_type: __lovasiriGuessMimeFromName(meta.name, meta.type) || null,
            size: meta.size || null,
          },
        },
        "*",
      );
    } catch (_) {}
  }

  function __lovasiriConsumeLatestFileMeta() {
    // Prefere o item com nome mais recente
    for (var i = __lovasiriPendingFiles.length - 1; i >= 0; i--) {
      var it = __lovasiriPendingFiles[i];
      if (it && it.name) {
        __lovasiriPendingFiles.splice(i, 1);
        return it;
      }
    }
    return __lovasiriLastRawFile || null;
  }

  function __lovasiriCaptureUploadUrl(url, method, reqBodyText, reqBodyRaw, response) {
    try {
      var u = String(url || "");
      // Endpoint da Lovable que gera signed URL de upload
      var isCreateUrl = /\/files\/(?:generate-upload-url|upload-url)(\?|$|#)/i.test(u);
      if (!isCreateUrl) return;
      var reqBody = null;
      if (reqBodyText) {
        try {
          reqBody = JSON.parse(reqBodyText);
        } catch (_) {}
      }
      if (!reqBody && __lovasiriLastUploadRequestBody && Date.now() - __lovasiriLastUploadRequestBody.ts < 5000) {
        reqBody = __lovasiriLastUploadRequestBody.body || null;
      }
      // Se o body veio como FormData, tenta extrair name/type/size do File
      var formMeta = null;
      try {
        if (reqBodyRaw && typeof FormData !== "undefined" && reqBodyRaw instanceof FormData) {
          reqBodyRaw.forEach(function (v, k) {
            if (v && typeof File !== "undefined" && v instanceof File && !formMeta) {
              formMeta = __lovasiriExtractFileMeta(v);
            } else if (typeof v === "string" && !formMeta) {
              // alguns backends recebem file_name como campo separado
              if (/^(file_?name|name|filename)$/i.test(k)) formMeta = { name: v };
            }
          });
        }
      } catch (_) {}
      // Fallback: usa o último File visto (PUT binário na signed URL)
      var recent = __lovasiriConsumeLatestFileMeta();
      response
        .clone()
        .json()
        .then(function (j) {
          try {
            var pickName =
              (formMeta && formMeta.name) ||
              (reqBody && (reqBody.file_name || reqBody.name || reqBody.filename)) ||
              (j && (j.file_name || j.name)) ||
              (recent && recent.name) ||
              "anexo";
            var pickType =
              (formMeta && formMeta.type) ||
              (reqBody && (reqBody.content_type || reqBody.mime_type || reqBody.mimeType)) ||
              (j && (j.mime_type || j.content_type)) ||
              (recent && recent.type) ||
              __lovasiriGuessMimeFromName(pickName, null) ||
              "application/octet-stream";
            if (
              recent &&
              recent.name &&
              (pickName === "anexo" ||
                /^file(?:\.|$)/i.test(String(pickName)) ||
                /^attachment(?:\.|$)/i.test(String(pickName)))
            ) {
              pickName = recent.name;
              pickType = __lovasiriGuessMimeFromName(pickName, recent.type || pickType) || pickType;
            }
            var pickSize =
              (formMeta && formMeta.size) ||
              (reqBody && (reqBody.size || reqBody.file_size)) ||
              (j && (j.size || j.file_size)) ||
              (recent && recent.size) ||
              null;
            var meta = {
              file_id: (j && (j.file_id || j.id)) || null,
              url: (j && (j.file_url || j.url || j.public_url || j.download_url)) || null,
              upload_url: (j && (j.upload_url || j.signed_url || j.signedUploadUrl || j.presigned_url)) || null,
              file_name: pickName,
              mime_type: pickType,
              size: pickSize,
              source: "lovable-native",
              ts: Date.now(),
            };
            if (!meta.file_id && !meta.url && !meta.upload_url) return;
            console.log("[LovaSiri] 📎 upload nativo capturado:", meta.file_name, meta.file_id);
            window.postMessage({ type: "lovasiriLovableUpload", file: meta }, "*");
          } catch (_) {}
        })
        .catch(function () {});
    } catch (_) {}
  }
})();

/**
 * Decoder-proof label normaliser (text only).
 *
 * The vendor core keeps its chat label ("Sent by vibeX", "Sent by
 * vibeX2" on the v5 send path) inside an obfuscated string table, so it
 * cannot be patched reliably at the source level. This observer rewrites the
 * rendered text to "Sent by Lovable" wherever it appears. Only text nodes are
 * touched — no attributes, no elements, no logic.
 */
(function () {
  try {
    if (window.__pkLabelNormaliser) return;
    window.__pkLabelNormaliser = true;

    var RE = /Sent\s+by\s+(?:Lovable\s+)?vibeX\s*\d*/gi;

    function fixNode(node) {
      try {
        if (!node || node.nodeType !== 3) return;
        var v = node.nodeValue;
        if (!v || v.indexOf("owerkits") === -1) return;
        var next = v.replace(RE, "Sent by Lovable");
        if (next !== v) node.nodeValue = next;
      } catch (_) {}
    }

    function scan(root) {
      try {
        if (!root) return;
        if (root.nodeType === 3) return fixNode(root);
        if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
        if (String(root.textContent || "").indexOf("owerkits") === -1) return;
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        var n;
        while ((n = walker.nextNode())) fixNode(n);
      } catch (_) {}
    }

    function start() {
      try {
        var target = document.body || document.documentElement;
        if (!target) return setTimeout(start, 100);
        scan(target);
        var obs = new MutationObserver(function (records) {
          for (var i = 0; i < records.length; i++) {
            var r = records[i];
            if (r.type === "characterData") fixNode(r.target);
            else if (r.addedNodes) {
              for (var j = 0; j < r.addedNodes.length; j++) scan(r.addedNodes[j]);
            }
          }
        });
        obs.observe(target, { childList: true, subtree: true, characterData: true });
        window.__pkLabelObserver = obs;
      } catch (_) {}
    }

    if (document.body) start();
    else document.addEventListener("DOMContentLoaded", start, { once: true });
  } catch (_) {}
})();
