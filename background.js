// Intercept XHR/Fetch requests to capture headers
let capturedHeaders = {
  projectId: null,
  browserSessionId: null,
  authorization: null,
  clientGitSha: null,
  cookies: null
};

// Listen for messages from content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'getHeaders') {
    sendResponse(capturedHeaders);
  } else if (request.type === 'setHeaders') {
    capturedHeaders = request.data;
    sendResponse({ success: true });
  } else if (request.type === 'setCookies') {
    capturedHeaders.cookies = request.cookies;
    sendResponse({ success: true });
  } else if (request.type === 'uploadFile') {
    (async () => {
      try {
        const { name, mime, dataB64 } = request;
        const bin = atob(dataB64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
        const fd = new FormData();
        fd.append('file', blob, name);
        const res = await fetch('https://tmpfile.link/api/upload', { method: 'POST', body: fd });
        const json = await res.json();
        const url = json?.downloadLinkEncoded || json?.downloadLink;
        if (!url) throw new Error('tmpfile.link error');
        sendResponse({ ok: true, url });
      } catch (e) {
        sendResponse({ ok: false, error: String(e?.message || e) });
      }
    })();
    return true;
  }
});

// Monitor network requests
chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.url.includes('api.lovable.dev')) {
      const headers = details.requestHeaders || [];
      
      headers.forEach(header => {
        if (header.name === 'X-Browser-Session-ID') {
          capturedHeaders.browserSessionId = header.value;
        } else if (header.name === 'Authorization') {
          capturedHeaders.authorization = header.value;
        } else if (header.name === 'X-Client-Git-SHA') {
          capturedHeaders.clientGitSha = header.value;
        } else if (header.name === 'Cookie') {
          capturedHeaders.cookies = header.value;
        }
      });
    }
  },
  { urls: ['https://api.lovable.dev/*'] },
  ['requestHeaders']
);

// ============================================================
// Cloudflare challenge surfacing (do NOT bypass — surface only)
// ============================================================
function lzBroadcastToLovableTabs(message) {
  try {
    chrome.tabs.query({ url: ['https://lovable.dev/*', 'https://*.lovable.dev/*'] }, (tabs) => {
      if (!tabs) return;
      for (const t of tabs) {
        if (t && typeof t.id === 'number') {
          try { chrome.tabs.sendMessage(t.id, message, () => void chrome.runtime.lastError); } catch (_) {}
        }
      }
    });
  } catch (_) {}
}

try {
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      try {
        if (details.statusCode !== 403 && details.statusCode !== 429) return;
        const headers = details.responseHeaders || [];
        let mitigated = false;
        let isCloudflare = false;
        for (const h of headers) {
          const name = (h.name || '').toLowerCase();
          const val = (h.value || '').toLowerCase();
          if (name === 'cf-mitigated' && val.includes('challenge')) mitigated = true;
          if (name === 'server' && val.includes('cloudflare')) isCloudflare = true;
        }
        if (mitigated || (isCloudflare && (details.statusCode === 403 || details.statusCode === 429))) {
          lzBroadcastToLovableTabs({ type: 'CF_CHALLENGE_REQUIRED', url: details.url });
        }
      } catch (_) {}
    },
    { urls: ['https://lovable.dev/*', 'https://*.lovable.dev/*'] },
    ['responseHeaders']
  );
} catch (_) {}

try {
  chrome.cookies.onChanged.addListener((info) => {
    try {
      if (!info || !info.cookie) return;
      const c = info.cookie;
      if (c.name !== 'cf_clearance') return;
      const domain = (c.domain || '').toLowerCase();
      if (!domain.includes('lovable.dev')) return;
      if (info.removed) return;
      lzBroadcastToLovableTabs({ type: 'CF_CHALLENGE_SOLVED' });
    } catch (_) {}
  });
} catch (_) {}
