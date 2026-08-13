// ============================================================
// Lovable Zero — Phase 2: license-gated extension w/ Supabase proxy
// ============================================================
// Guard helper: chrome.runtime becomes invalid when the extension is
// reloaded/updated while old content scripts remain in the page.
function isExtensionContextValid() {
  try { return !!(chrome && chrome.runtime && chrome.runtime.id); }
  catch (_) { return false; }
}

// Backend (TanStack Start) base URL. Override at runtime via
// chrome.storage.local key `lovableZeroApiBase` if you need a custom one.
const DEFAULT_API_BASE = 'https://lovablezero.com';
let API_BASE = DEFAULT_API_BASE;
try {
  chrome.storage.local.get(['lovableZeroApiBase'], (r) => {
    if (r && typeof r.lovableZeroApiBase === 'string' && r.lovableZeroApiBase) API_BASE = r.lovableZeroApiBase;
  });
} catch (_) {}

// =============== Device ID (single-device binding) ===============
// A stable per-browser device id so the backend can bind the license to one device.
let DEVICE_ID = null;
function loadOrCreateDeviceId() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(['lz_device_id'], (r) => {
        if (r && typeof r.lz_device_id === 'string' && r.lz_device_id) {
          DEVICE_ID = r.lz_device_id; resolve(DEVICE_ID); return;
        }
        const id = (crypto && crypto.randomUUID) ? crypto.randomUUID()
          : 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        DEVICE_ID = id;
        try { chrome.storage.local.set({ lz_device_id: id }); } catch (_) {}
        resolve(id);
      });
    } catch (_) {
      DEVICE_ID = 'dev-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      resolve(DEVICE_ID);
    }
  });
}
loadOrCreateDeviceId();

// =============== License state ===============
const licenseState = {
  email: null,
  key: null,
  meta: null,        // { type, expires_at, is_lifetime, assigned_name, assigned_email }
  valid: false,
  lastCheck: 0,
};

function loadLicense() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(['lz_email', 'lz_key', 'lz_meta'], (r) => {
        licenseState.email = r?.lz_email || null;
        licenseState.key = r?.lz_key || null;
        licenseState.meta = r?.lz_meta || null;
        resolve();
      });
    } catch (_) { resolve(); }
  });
}
function saveLicense() {
  try {
    chrome.storage.local.set({
      lz_email: licenseState.email,
      lz_key: licenseState.key,
      lz_meta: licenseState.meta,
    });
  } catch (_) {}
}
function clearLicense() {
  licenseState.email = null;
  licenseState.key = null;
  licenseState.meta = null;
  licenseState.valid = false;
  try { chrome.storage.local.remove(['lz_email', 'lz_key', 'lz_meta']); } catch (_) {}
}

async function validateLicenseRemote(email, key) {
  if (!DEVICE_ID) await loadOrCreateDeviceId();
  const res = await fetch(`${API_BASE}/api/public/license/validate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, license_key: key, device_id: DEVICE_ID }),
  });
  return res.json();
}

// Backend command proxy. The extension sends ONLY minimal info: license auth,
// the command name, the Lovable session credentials, and small per-command
// params. The backend assembles the full upstream HTTP request (URL, headers,
// body) and runs it. The actual POST shape never leaves the backend.
async function runCommand(command, { creds = {}, params = {} } = {}) {
  if (!licenseState.valid || !licenseState.email || !licenseState.key) {
    throw new Error('License not active');
  }
  if (!DEVICE_ID) await loadOrCreateDeviceId();
  const res = await fetch(`${API_BASE}/api/public/license/command`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: licenseState.email,
      license_key: licenseState.key,
      device_id: DEVICE_ID,
      command,
      creds,
      params,
    }),
  });
  const env = await res.json();
  try {
    const hdrs = env && env.headers ? env.headers : {};
    const cfMit = String(hdrs['cf-mitigated'] || hdrs['CF-Mitigated'] || '').toLowerCase();
    const server = String(hdrs['server'] || hdrs['Server'] || '').toLowerCase();
    const challenged = cfMit.includes('challenge') || ((env.status === 403 || env.status === 429) && server.includes('cloudflare'));
    if (challenged && typeof lzShowCfChallenge === 'function') lzShowCfChallenge('https://lovable.dev/');
  } catch (_) {}
  if (!env.ok) {
    if (res.status === 403) { clearLicense(); showActivationOverlay(); }
    throw new Error(env.reason || `Command failed (${res.status})`);
  }
  return env; // { ok, status, headers, body, parsed? }

}

// =============== Activation Overlay ===============
function buildActivationOverlay() {
  if (document.getElementById('lovable-activation-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'lovable-activation-overlay';
  overlay.style.cssText = `
    position:absolute; inset:0; z-index:5;
    background:linear-gradient(180deg,#ffffff,#f7f8fc);
    border-radius:7px;
    display:none; flex-direction:column;
    padding:18px; overflow-y:auto;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
  `;
  overlay.innerHTML = `
    <div style="text-align:center;margin-bottom:14px;">
      <div style="font-size:18px;font-weight:800;color:#111827;letter-spacing:0.3px;">Activate Your License</div>
      <div style="font-size:12px;color:#6b7280;margin-top:4px;">Unlock Lovable Zero</div>
    </div>
    <label style="font-size:12px;font-weight:700;color:#374151;margin-bottom:4px;">Email</label>
    <input id="lz-act-email" type="email" placeholder="you@example.com" autocomplete="email" style="
      padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;outline:none;
      margin-bottom:10px;background:#fff;
    "/>
    <label style="font-size:12px;font-weight:700;color:#374151;margin-bottom:4px;">License Key</label>
    <input id="lz-act-key" type="text" placeholder="PRO-XXXXX-XXXXX-XXXXX-XXXXX" style="
      padding:10px 12px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;outline:none;
      margin-bottom:12px;letter-spacing:1px;text-transform:uppercase;background:#fff;
    "/>
    <button id="lz-act-btn" style="
      padding:11px 16px;background:linear-gradient(90deg,#4f46e5,#7c3aed);color:#fff;border:none;
      border-radius:10px;cursor:pointer;font-weight:700;font-size:14px;
    ">Activate License</button>
    <div id="lz-act-msg" style="margin-top:10px;font-size:12px;text-align:center;min-height:16px;color:#ef4444;font-weight:600;"></div>

    <div style="margin:14px 0 8px;height:1px;background:#e5e7eb;"></div>
    <div style="font-size:12px;font-weight:800;color:#374151;text-transform:uppercase;letter-spacing:0.6px;margin-bottom:8px;">Features</div>
    <ul style="margin:0 0 12px;padding:0 0 0 4px;list-style:none;font-size:13px;color:#374151;">
      <li style="display:flex;gap:8px;align-items:center;margin-bottom:6px;"><span style="color:#10b981;font-weight:800;">✓</span> Built-in Agent Mode</li>
      <li style="display:flex;gap:8px;align-items:center;margin-bottom:6px;"><span style="color:#10b981;font-weight:800;">✓</span> Remove Lovable Badge</li>
      <li style="display:flex;gap:8px;align-items:center;margin-bottom:6px;"><span style="color:#10b981;font-weight:800;">✓</span> Download Project Files</li>
    </ul>
    <div style="display:flex;gap:8px;">
      <a href="https://lovablezero.com" target="_blank" rel="noopener noreferrer" style="
        flex:1;text-align:center;text-decoration:none;
        padding:10px 12px;background:linear-gradient(135deg,#8e48ff,#e12429);color:#fff;
        border-radius:10px;font-weight:700;font-size:13px;
      ">Buy License</a>
      <a href="https://t.me/lovablezero" target="_blank" rel="noopener noreferrer" style="
        flex:1;text-align:center;text-decoration:none;
        padding:10px 12px;background:#0f172a;color:#fff;
        border-radius:10px;font-weight:700;font-size:13px;
      ">Contact</a>
    </div>
    <div style="margin-top:14px;font-size:11px;color:#9ca3af;text-align:center;">
      The chat window is locked until a valid license is activated.
    </div>
  `;
  const win = document.getElementById('lovable-chat-window');
  win.appendChild(overlay);

  // Activation handler
  const emailInput = overlay.querySelector('#lz-act-email');
  const keyInput = overlay.querySelector('#lz-act-key');
  const btn = overlay.querySelector('#lz-act-btn');
  const msg = overlay.querySelector('#lz-act-msg');

  // Prefill if previously entered
  if (licenseState.email) emailInput.value = licenseState.email;
  if (licenseState.key) keyInput.value = licenseState.key;

  btn.addEventListener('click', async () => {
    const email = (emailInput.value || '').trim().toLowerCase();
    const key = (keyInput.value || '').trim().toUpperCase();
    msg.style.color = '#ef4444';
    if (!email || !key) { msg.textContent = 'Email and license key are required.'; return; }
    btn.disabled = true; btn.textContent = 'Activating…';
    msg.textContent = '';
    try {
      const result = await validateLicenseRemote(email, key);
      if (result.valid) {
        licenseState.email = email;
        licenseState.key = key;
        licenseState.meta = result.license;
        licenseState.valid = true;
        licenseState.lastCheck = Date.now();
        saveLicense();
        msg.style.color = '#10b981';
        msg.textContent = '✓ License activated';
        setTimeout(() => { hideActivationOverlay(); updateAccountFromLicense(); }, 400);
      } else {
        msg.textContent = '✗ ' + (result.reason || 'Invalid license');
      }
    } catch (e) {
      msg.textContent = '✗ Network error: ' + (e?.message || e);
    } finally {
      btn.disabled = false; btn.textContent = 'Activate License';
    }
  });
}

function showActivationOverlay() {
  const o = document.getElementById('lovable-activation-overlay');
  if (o) o.style.display = 'flex';
}
function hideActivationOverlay() {
  const o = document.getElementById('lovable-activation-overlay');
  if (o) o.style.display = 'none';
}

function updateAccountFromLicense() {
  const name = document.getElementById('lovable-account-name');
  const email = document.getElementById('lovable-account-email');
  const plan = document.getElementById('lovable-account-plan');
  const cd = document.getElementById('lovable-account-countdown');
  if (!licenseState.meta) return;
  if (name) name.textContent = licenseState.meta.assigned_name || licenseState.email || 'Licensed User';
  if (email) email.textContent = licenseState.meta.assigned_email || licenseState.email || '';
  if (plan) plan.textContent = String(licenseState.meta.type || 'PRO').toUpperCase();
  if (cd) {
    if (licenseState.meta.is_lifetime) cd.textContent = 'LIFETIME';
    else if (licenseState.meta.expires_at) {
      const ms = new Date(licenseState.meta.expires_at).getTime() - Date.now();
      if (ms <= 0) cd.textContent = 'EXPIRED';
      else {
        const totalSec = Math.floor(ms / 1000);
        const d = Math.floor(totalSec / 86400);
        const h = Math.floor((totalSec % 86400) / 3600);
        const m = Math.floor((totalSec % 3600) / 60);
        const s = totalSec % 60;
        const pad = (n) => String(n).padStart(2, '0');
        cd.textContent = d > 0
          ? `${d}d ${pad(h)}:${pad(m)}:${pad(s)}`
          : `${pad(h)}:${pad(m)}:${pad(s)}`;
      }
    }
  }
}

// Heartbeat: revalidate the license periodically. If it becomes invalid the
// extension immediately logs the user out and locks the chat.
async function licenseHeartbeat() {
  if (!licenseState.email || !licenseState.key) {
    licenseState.valid = false;
    showActivationOverlay();
    return;
  }
  try {
    const result = await validateLicenseRemote(licenseState.email, licenseState.key);
    licenseState.lastCheck = Date.now();
    if (result.valid) {
      licenseState.valid = true;
      licenseState.meta = result.license;
      saveLicense();
      hideActivationOverlay();
      updateAccountFromLicense();
    } else {
      clearLicense();
      showActivationOverlay();
      showNotification('License invalid: ' + (result.reason || 'expired'), 3000, false);
    }
  } catch (_) {
    // Network blip — keep current state, retry next tick.
  }
}

// Extract project ID from URL
function extractProjectId() {
  // Match both /project/ and /projects/ (Lovable uses /projects/)
  const match = window.location.pathname.match(/\/projects?\/([a-f0-9\-]+)/);
  return match ? match[1] : null;
}

// Store button position
let buttonPosition = {
  x: window.innerWidth - 70,  // 20px + 50px button
  y: window.innerHeight - 70   // 20px + 50px button
};

// Store window position
let windowPosition = null; // { x, y } once set by user/auto

function saveWindowPosition() {
  try { localStorage.setItem('lovable-window-pos', JSON.stringify(windowPosition)); } catch (e) {}
}
function loadWindowPosition() {
  try {
    const saved = localStorage.getItem('lovable-window-pos');
    if (saved) windowPosition = JSON.parse(saved);
  } catch (e) {}
}

// Save and load position from localStorage
function saveButtonPosition() {
  try {
    localStorage.setItem('lovable-button-pos', JSON.stringify(buttonPosition));
  } catch (e) {
    // Silently fail if localStorage not available
  }
}

function loadButtonPosition() {
  try {
    const saved = localStorage.getItem('lovable-button-pos');
    if (saved) {
      buttonPosition = JSON.parse(saved);
    }
  } catch (e) {
    // Use default position
  }
}

// Calculate optimal window position based on button position
function calculateWindowPosition(buttonX, buttonY) {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const windowWidth = 400;
  const windowHeight = 500;
  const padding = 20;
  
  let posX = buttonX - windowWidth - 20;  // Default: left of button
  let posY = buttonY;  // Default: same vertical
  
  // Determine button position in viewport
  const centerX = viewportWidth / 2;
  const centerY = viewportHeight / 2;
  
  // Button is on the right side
  if (buttonX > centerX) {
    // Try to position window on the left
    posX = buttonX - windowWidth - 20;
    if (posX < padding) {
      posX = padding;
    }
  } else {
    // Button is on the left side, position window on the right
    posX = buttonX + 80;  // Button width (50) + gap (20) + some margin (10)
  }
  
  // Adjust vertical position to keep window visible
  if (buttonY > centerY) {
    // Button is at bottom, position window above
    posY = buttonY - windowHeight - 20;
    if (posY < padding) {
      posY = padding;
    }
  } else {
    // Button is at top, position window below
    posY = buttonY + 70;  // Button height (50) + gap (20)
  }
  
  // Ensure window doesn't go off-screen horizontally
  if (posX + windowWidth > viewportWidth - padding) {
    posX = viewportWidth - windowWidth - padding;
  }
  if (posX < padding) {
    posX = padding;
  }
  
  // Ensure window doesn't go off-screen vertically
  if (posY + windowHeight > viewportHeight - padding) {
    posY = viewportHeight - windowHeight - padding;
  }
  if (posY < padding) {
    posY = padding;
  }
  
  return { x: posX, y: posY };
}

// Update window position based on button position (or saved window position)
function updateWindowPosition(floatingWindow) {
  floatingWindow.style.bottom = 'auto';
  floatingWindow.style.right = 'auto';

  // If user has positioned the window, respect it
  if (windowPosition && typeof windowPosition.x === 'number') {
    floatingWindow.style.left = windowPosition.x + 'px';
    floatingWindow.style.top = windowPosition.y + 'px';
    return;
  }

  const buttonEl = document.getElementById('lovable-chat-toggle');
  if (!buttonEl) return;
  const buttonRect = buttonEl.getBoundingClientRect();
  const windowPos = calculateWindowPosition(
    buttonRect.left + window.scrollX,
    buttonRect.top + window.scrollY
  );
  floatingWindow.style.left = windowPos.x + 'px';
  floatingWindow.style.top = windowPos.y + 'px';
}

// Inject floating button and window
function injectUI() {
  // Load saved positions
  loadButtonPosition();
  // Always re-center the chat window on each page load (don't restore previous position)
  windowPosition = {
    x: Math.max(10, Math.round((window.innerWidth - 400) / 2)),
    y: Math.max(10, Math.round((window.innerHeight - 500) / 2))
  };
  try { localStorage.removeItem('lovable-window-pos'); } catch (e) {}

  // Create button
  const button = document.createElement('button');
  button.id = 'lovable-chat-toggle';
  button.textContent = '💬';
  button.style.cssText = `
    position: fixed;
    left: ${buttonPosition.x}px;
    top: ${buttonPosition.y}px;
    width: 50px;
    height: 50px;
    border-radius: 50%;
    background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
    color: white;
    border: none;
    font-size: 24px;
    cursor: grab;
    z-index: 999999;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    transition: all 0.3s ease;
    user-select: none;
  `;

  // Drag functionality
  let isDragging = false;
  let dragOffsetX = 0;
  let dragOffsetY = 0;

  button.addEventListener('mousedown', (e) => {
    isDragging = true;
    dragOffsetX = e.clientX - button.getBoundingClientRect().left;
    dragOffsetY = e.clientY - button.getBoundingClientRect().top;
    button.style.cursor = 'grabbing';
    button.style.transition = 'none';
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;

    let newX = e.clientX - dragOffsetX;
    let newY = e.clientY - dragOffsetY;

    // Keep button within viewport
    const padding = 10;
    if (newX < padding) newX = padding;
    if (newY < padding) newY = padding;
    if (newX + 50 > window.innerWidth - padding) {
      newX = window.innerWidth - 50 - padding;
    }
    if (newY + 50 > window.innerHeight - padding) {
      newY = window.innerHeight - 50 - padding;
    }

    button.style.left = newX + 'px';
    button.style.top = newY + 'px';

    buttonPosition.x = newX;
    buttonPosition.y = newY;

    // Update window position while dragging
    const floatingWindow = document.getElementById('lovable-chat-window');
    if (floatingWindow) {
      updateWindowPosition(floatingWindow);
    }
  });

  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      button.style.cursor = 'grab';
      button.style.transition = 'all 0.3s ease';
      saveButtonPosition();
    }
  });

  button.onmouseover = () => {
    if (!isDragging) {
      button.style.transform = 'scale(1.1)';
      button.style.boxShadow = '0 6px 16px rgba(0, 0, 0, 0.25)';
    }
  };

  button.onmouseout = () => {
    if (!isDragging) {
      button.style.transform = 'scale(1)';
      button.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.15)';
    }
  };

  // Create floating window
  const floatingWindow = document.createElement('div');
  floatingWindow.id = 'lovable-chat-window';
  floatingWindow.style.cssText = `
    position: fixed;
    left: auto;
    top: auto;
    right: 20px;
    bottom: 80px;
    width: 400px;
     background: linear-gradient(180deg, #f5f6fa, #eef0f5);
     border: 5px solid #4f46e5;
     border-radius: 12px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.1);
    z-index: 999998;
    display: none;
    flex-direction: column;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
  `;

  floatingWindow.innerHTML = `
    <div id="lovable-window-header" style="
      padding: 12px;
      border-bottom: 1px solid #e0e0e0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      background: linear-gradient(90deg, #4f46e5, #7c3aed);
      color: white;
      border-radius: 7px 7px 0 0;
      cursor: move;
      user-select: none;
    ">
      <div style="display: flex; align-items: center; gap: 8px;">
        <img src="https://lovablezero.com/logo.png" alt="Lovable Zero" style="width: 24px; height: 24px; display: block;" />
        <h3 style="margin: 0; font-size: 16px; font-weight: 600;">Lovable Zero</h3>
      </div>
      <button id="lovable-close-btn" style="
        background: transparent;
        border: none;
        color: white;
        font-size: 20px;
        cursor: pointer;
        padding: 0;
        width: 24px;
        height: 24px;
      ">×</button>
    </div>

    <div id="lovable-account" style="
      padding: 10px 12px;
      /* background: linear-gradient(180deg, #ffffff, #f7f8fc) padding-box, linear-gradient(90deg, #8e48ff, #e12429) border-box; */
      /* border: 2px solid transparent; */
      border-bottom: none;
      font-size: 12px;
      color: #1f2937;
      display: flex;
      flex-direction: column;
      gap: 4px;
    ">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <span id="lovable-account-name" style="font-weight:700;font-size:13px;color:#111827;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">User's Name</span>
        <span id="lovable-account-plan" style="
          font-size:10px;font-weight:800;letter-spacing:0.6px;
          padding:2px 7px;border-radius:999px;color:#fff;
          background:linear-gradient(90deg,#8e48ff,#e12429);
          flex-shrink:0;
        ">PRO</span>
      </div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">
        <span id="lovable-account-email" style="color:#6b7280;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">user@gmail.com</span>
        <span id="lovable-account-countdown" style="font-weight:600;color:#6b7280;font-size:12px;flex-shrink:0;">00:00:00</span>
      </div>
    </div>


    <div style="
      padding: 12px;
      background: #f9f9f9;
      font-size: 12px;
      color: #666;
      border-bottom: 1px solid #e0e0e0;
      max-height: 100px;
      overflow-y: auto;
    " id="lovable-status">
      Capturing headers...
    </div>

    <textarea id="lovable-message-input" placeholder="Type your message here..." style="
      flex: 1;
      padding: 12px;
      border: none;
      resize: none;
      font-family: inherit;
      font-size: 14px;
      outline: none;
      min-height: 130px;
    "></textarea>

    <div id="lovable-attachments" style="
      display: none;
      padding: 8px 12px;
      border-top: 1px solid #e0e0e0;
      gap: 8px;
      flex-wrap: wrap;
      max-height: 140px;
      overflow-y: auto;
    "></div>

    <input id="lovable-file-input" type="file" multiple
      style="display:none" />

    <div style="
      padding: 12px;
      border-top: 1px solid #e0e0e0;
      display: flex;
      gap: 8px;
    ">
      <button id="lovable-attach-btn" title="Attach files" style="
        padding: 10px 12px;
        background: linear-gradient(#f0f0f0,#f0f0f0) padding-box, linear-gradient(90deg,#4f46e5,#7c3aed) border-box;
        color: #333;
        border: 3px solid transparent;
        border-radius: 10px;
        cursor: pointer;
        font-weight: 600;
      ">📂</button>
      <button id="lovable-send-btn" style="
        flex: 1;
        padding: 10px 16px;
        background: linear-gradient(90deg, #4f46e5, #7c3aed);
        color: white;
        border: none;
        border-radius: 10px 0 0 10px;
        cursor: pointer;
        font-weight: 600;
        transition: all 0.3s ease;
      ">Send</button>
      <select id="lovable-mode-select" title="Mode" style="
        padding: 10px 8px;
        background: linear-gradient(90deg, #4f46e5, #7c3aed);
        color: white;
        border: none;
        border-left: 1px solid rgba(255,255,255,0.3);
        border-radius: 0 10px 10px 0;
        cursor: pointer;
        font-weight: 600;
        font-size: 13px;
        -webkit-appearance: none;
        appearance: none;
      ">
        <option value="build" style="color:#000">Build</option>
        <option value="plan" style="color:#000">Plan</option>
      </select>
      <button id="lovable-clear-btn" style="
        padding: 10px 16px;
        background: #d1d5dc;
        color: #333;
        border: none;
        border-radius: 10px;
        cursor: pointer;
        font-weight: 600;
        transition: all 0.3s ease;
      ">Clear</button>
    </div>

    <div id="lovable-shortcuts-section" style="
      padding: 14px 14px 16px;
      border-top: 1px solid #ececec;
      background: linear-gradient(180deg, #fbfbfd 0%, #f5f6fa 100%);
    ">
      <div id="lovable-shortcuts-header" style="display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer;user-select:none;" title="Toggle shortcuts">
        <div style="width:4px;height:14px;border-radius:2px;background:linear-gradient(180deg,#4f46e5,#7c3aed);"></div>
        <div style="font-size:11px;color:#3a3a4a;font-weight:700;letter-spacing:0.6px;text-transform:uppercase;">
          Useful Shortcuts
        </div>
        <div style="flex:1;height:1px;background:linear-gradient(90deg,#e5e7ef,transparent);"></div>
        <span id="lovable-shortcuts-chevron" style="font-size:11px;color:#4f46e5;font-weight:700;letter-spacing:0.4px;text-transform:uppercase;display:inline-block;">Hide</span>
      </div>
      <div id="lovable-shortcuts" style="
        display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;
      "></div>
    </div>

    <div style="padding: 0 12px 12px;display:flex;gap:8px;">
      <button id="lovable-remove-badge-btn" title="Remove Lovable Badge by Lovable Zero" style="
        flex:1;min-width:0;
        padding: 8px 14px;
        background: linear-gradient(135deg,#8e48ff,#e12429);
        color:#fff;border:none;border-radius:8px;cursor:pointer;
        font-weight:600;font-size:13px;
        display:inline-flex;align-items:center;justify-content:center;gap:8px;
        transition:transform 0.15s ease,box-shadow 0.2s ease,opacity 0.2s ease;
      ">
        <span id="lovable-remove-badge-label">Remove</span>
        <img src="https://iili.io/CnzRqQ4.png" alt="" style="width:70px;height:16px;object-fit:contain;" />
      </button>
      <button id="lovable-download-btn" title="Download full project source as ZIP" style="
        flex:1;min-width:0;
        padding: 8px 14px;
        background: linear-gradient(135deg,#0f172a,#334155);
        color:#fff;border:none;border-radius:8px;cursor:pointer;
        font-weight:600;font-size:13px;
        display:inline-flex;align-items:center;justify-content:center;gap:8px;
        transition:transform 0.15s ease,box-shadow 0.2s ease,opacity 0.2s ease;
      ">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        <span id="lovable-download-label">Download</span>
      </button>
    </div>


    <div id="lovable-footer" style="
      display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;
      padding:10px 14px;border-top:1px solid #ececec;
      background:linear-gradient(180deg,#f5f6fa 0%,#eef0f5 100%);
      font-size:11px;color:#5a5a6a;font-weight:600;
      border-radius:0 0 12px 12px;
    ">
      <a href="https://t.me/lovablezero" target="_blank" rel="noopener noreferrer" style="
        justify-self:start;text-decoration:none;color:#2a2a3a;
        background:linear-gradient(180deg,#f5f6fa,#eef0f5) padding-box,
                   linear-gradient(90deg,#4f46e5,#7c3aed) border-box;
        border:2px solid transparent;
        padding:4px 12px;border-radius:15px;font-size:11px;font-weight:700;
        display:inline-flex;align-items:center;gap:6px;
      ">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor"><path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg>
        Support
      </a>
      <div style="justify-self:center;text-align:center;white-space:nowrap;">
        Made with <span style="color:#ff7a45;">🧡</span>
      </div>
      <div style="justify-self:end;color:#8a8a9a;">V7.0.0</div>
    </div>
  `;



  // Floating toggle button removed — use the "PopUp" button in the native chat header instead.
  document.body.appendChild(floatingWindow);

  // Open / close helpers
  function openWindow() {
    floatingWindow.style.display = 'flex';
    updateWindowPosition(floatingWindow);
    button.style.display = 'none';
  }
  function closeWindow() {
    floatingWindow.style.display = 'none';
    button.style.display = '';
  }

  // Event listeners
  button.addEventListener('click', () => {
    if (floatingWindow.style.display !== 'none') closeWindow();
    else openWindow();
  });

  document.getElementById('lovable-close-btn').addEventListener('click', closeWindow);

  // Drag the window via its header
  (function enableWindowDrag() {
    const header = document.getElementById('lovable-window-header');
    let wDragging = false, wOffX = 0, wOffY = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.target.closest('#lovable-close-btn')) return;
      wDragging = true;
      const rect = floatingWindow.getBoundingClientRect();
      wOffX = e.clientX - rect.left;
      wOffY = e.clientY - rect.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!wDragging) return;
      const padding = 10;
      const w = floatingWindow.offsetWidth;
      const h = floatingWindow.offsetHeight;
      let nx = e.clientX - wOffX;
      let ny = e.clientY - wOffY;
      if (nx < padding) nx = padding;
      if (ny < padding) ny = padding;
      if (nx + w > window.innerWidth - padding) nx = window.innerWidth - w - padding;
      if (ny + h > window.innerHeight - padding) ny = window.innerHeight - h - padding;
      floatingWindow.style.left = nx + 'px';
      floatingWindow.style.top = ny + 'px';
      floatingWindow.style.right = 'auto';
      floatingWindow.style.bottom = 'auto';
      windowPosition = { x: nx, y: ny };
    });
    document.addEventListener('mouseup', () => {
      if (wDragging) { wDragging = false; saveWindowPosition(); }
    });
  })();

  document.getElementById('lovable-clear-btn').addEventListener('click', () => {
    document.getElementById('lovable-message-input').value = '';
    clearAttachments();
  });

  document.getElementById('lovable-send-btn').addEventListener('click', sendMessage);
  document.getElementById('lovable-download-btn').addEventListener('click', downloadProject);
  document.getElementById('lovable-remove-badge-btn').addEventListener('click', removeLovableBadge);

  // Render shortcut buttons
  const shortcutsWrap = document.getElementById('lovable-shortcuts');
  const templates = window.PROMPT_TEMPLATES || [];
  templates.forEach(t => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = t.prompt;
    btn.innerHTML = `<span style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;opacity:0.85;">${t.icon}</span><span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${t.label}</span>`;
    btn.style.cssText = `
      display:inline-flex;align-items:center;justify-content:center;gap:5px;
      padding:7px 8px;font-size:11.5px;font-weight:600;
      background:#fff;color:#3a3a4a;border:1px solid #e5e7ef;
      border-radius:10px;cursor:pointer;
      box-shadow:0 1px 2px rgba(15,18,40,0.04);
      transition:transform 0.15s ease,background 0.2s ease,color 0.2s ease,border-color 0.2s ease,box-shadow 0.2s ease;
      min-width:0;
    `;
    btn.addEventListener('mouseenter', () => {
      btn.style.background = 'linear-gradient(135deg,#667eea,#764ba2)';
      btn.style.color = '#fff';
      btn.style.borderColor = 'transparent';
      btn.style.transform = 'translateY(-1px)';
      btn.style.boxShadow = '0 6px 14px -4px rgba(102,126,234,0.5)';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.background = '#fff';
      btn.style.color = '#3a3a4a';
      btn.style.borderColor = '#e5e7ef';
      btn.style.transform = 'translateY(0)';
      btn.style.boxShadow = '0 1px 2px rgba(15,18,40,0.04)';
    });
    btn.addEventListener('click', () => {
      const input = document.getElementById('lovable-message-input');
      const cur = input.value.trim();
      input.value = cur ? cur + '\n\n' + t.prompt : t.prompt;
      input.focus();
    });
    shortcutsWrap.appendChild(btn);
  });

  // Collapsible Useful Shortcuts
  (function setupShortcutsCollapse() {
    const header = document.getElementById('lovable-shortcuts-header');
    const body = document.getElementById('lovable-shortcuts');
    const chev = document.getElementById('lovable-shortcuts-chevron');
    if (!header || !body || !chev) return;
    let collapsed = true; // collapsed by default
    try {
      const saved = localStorage.getItem('lovable-shortcuts-collapsed');
      if (saved === '0') collapsed = false;
      else if (saved === '1') collapsed = true;
    } catch (e) {}
    const apply = () => {
      body.style.display = collapsed ? 'none' : 'grid';
      chev.textContent = collapsed ? 'Show' : 'Hide';
    };
    apply();
    header.addEventListener('click', () => {
      collapsed = !collapsed;
      try { localStorage.setItem('lovable-shortcuts-collapsed', collapsed ? '1' : '0'); } catch (e) {}
      apply();
    });
  })();




  // Mode selector (Build / Plan) — persist selection
  const modeSelect = document.getElementById('lovable-mode-select');
  try {
    const savedMode = localStorage.getItem('lovable-mode');
    if (savedMode === 'plan' || savedMode === 'build') modeSelect.value = savedMode;
  } catch (e) {}
  modeSelect.addEventListener('change', () => {
    try { localStorage.setItem('lovable-mode', modeSelect.value); } catch (e) {}
  });

  // Attach button -> file input
  const fileInput = document.getElementById('lovable-file-input');
  document.getElementById('lovable-attach-btn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    handleFiles(Array.from(e.target.files || []));
    fileInput.value = '';
  });

  // Drag & drop onto the window
  ['dragover', 'dragenter'].forEach(ev => floatingWindow.addEventListener(ev, (e) => {
    e.preventDefault();
    floatingWindow.style.outline = '2px dashed #667eea';
  }));
  ['dragleave', 'drop'].forEach(ev => floatingWindow.addEventListener(ev, (e) => {
    e.preventDefault();
    floatingWindow.style.outline = 'none';
  }));
  floatingWindow.addEventListener('drop', (e) => {
    if (e.dataTransfer?.files?.length) handleFiles(Array.from(e.dataTransfer.files));
  });

  // Paste images directly
  document.getElementById('lovable-message-input').addEventListener('paste', (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) handleFiles(files);
  });

  // Allow Enter+Ctrl to send
  document.getElementById('lovable-message-input').addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Enter') {
      sendMessage();
    }
  });

  // Build the license activation overlay and gate the chat behind it.
  buildActivationOverlay();

  // Auto-open chat window centered on every page load
  openWindow();

  // Initial license check (and reveal chat or overlay accordingly).
  loadLicense().then(async () => {
    if (!licenseState.email || !licenseState.key) {
      showActivationOverlay();
      return;
    }
    // Show overlay during initial check so chat can't be used unverified.
    showActivationOverlay();
    await licenseHeartbeat();
  });
}

// =============== File upload (tmpfile.link, any file up to 100MB) ===============
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const IMAGE_EXT = ['jpg','jpeg','png','gif','bmp','webp','heic','heif','avif','tif','tiff','svg'];

// Each attachment: { id, file, name, ext, status: 'uploading'|'done'|'error', url, progress }
const attachments = [];

function uid() { return 'att_' + Math.random().toString(36).slice(2, 10); }

function getExt(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function clearAttachments() {
  attachments.length = 0;
  renderAttachments();
}

function renderAttachments() {
  const wrap = document.getElementById('lovable-attachments');
  if (!wrap) return;
  if (!attachments.length) {
    wrap.style.display = 'none';
    wrap.innerHTML = '';
    return;
  }
  wrap.style.display = 'flex';
  wrap.innerHTML = '';
  attachments.forEach(att => {
    const chip = document.createElement('div');
    chip.style.cssText = `
      position: relative;
      width: 72px; height: 72px;
      border-radius: 8px;
      border: 1px solid #e0e0e0;
      background: #fafafa;
      display: flex; align-items: center; justify-content: center;
      overflow: hidden;
      font-size: 11px; color: #555;
      text-align: center;
    `;
    const isImg = att.status === 'done' && att.url && IMAGE_EXT.includes(att.ext);
    if (isImg) {
      chip.innerHTML = `<img src="${att.url}" style="width:100%;height:100%;object-fit:cover" />`;
    } else {
      chip.innerHTML = `<div style="padding:4px;word-break:break-all">${att.ext.toUpperCase() || 'FILE'}<br/>${att.name.slice(0,12)}</div>`;
    }

    // Status overlay
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:absolute; left:0; right:0; bottom:0;
      background: rgba(0,0,0,0.55); color: white;
      font-size: 10px; padding: 2px 4px; text-align:center;
    `;
    if (att.status === 'uploading') overlay.textContent = 'Uploading…';
    else if (att.status === 'error') { overlay.textContent = 'Failed'; overlay.style.background = 'rgba(239,68,68,0.85)'; }
    else if (att.status === 'done') { overlay.textContent = '✓'; overlay.style.background = 'rgba(16,185,129,0.85)'; }
    chip.appendChild(overlay);

    // Remove button
    const rm = document.createElement('button');
    rm.textContent = '×';
    rm.title = 'Remove';
    rm.style.cssText = `
      position:absolute; top:2px; right:2px;
      width:18px; height:18px; border-radius:50%;
      border:none; background: rgba(0,0,0,0.6); color:white;
      cursor:pointer; font-size:14px; line-height:14px; padding:0;
    `;
    rm.onclick = () => {
      const idx = attachments.findIndex(a => a.id === att.id);
      if (idx >= 0) attachments.splice(idx, 1);
      renderAttachments();
    };
    chip.appendChild(rm);

    wrap.appendChild(chip);
  });
}

function handleFiles(files) {
  files.forEach(file => {
    const ext = getExt(file.name);
    if (file.size > MAX_FILE_SIZE) {
      showNotification(`Too large (max 100MB): ${file.name}`, 2500, false);
      return;
    }
    const att = { id: uid(), file, name: file.name, ext, status: 'uploading', url: null };
    attachments.push(att);
    renderAttachments();
    uploadAttachment(att);
  });
}

async function uploadAttachment(att) {
  try {
    att.url = await uploadToTmpfileLink(att.file);
    att.status = 'done';
  } catch (e) {
    att.status = 'error';
    showNotification(`Upload failed: ${att.name}`, 2500, false);
  }
  renderAttachments();
}

async function uploadToTmpfileLink(file) {
  // tmpfile.link does not send CORS headers, so route through the background
  // service worker (extension origin) which has host permission.
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  const dataB64 = btoa(bin);
  const resp = await new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'uploadFile', name: file.name, mime: file.type, dataB64 },
      (r) => resolve(r || { ok: false, error: 'no response' })
    );
  });
  if (!resp?.ok) throw new Error(resp?.error || 'tmpfile.link error');
  return resp.url;
}

// Show notification inside chat window
function showNotification(message, duration = 2000, isSuccess = true) {
  const floatingWindow = document.getElementById('lovable-chat-window');
  if (!floatingWindow) return;

  // Create notification element
  const notification = document.createElement('div');
  notification.id = 'lovable-notification';
  notification.style.cssText = `
    position: absolute;
    bottom: 60px;
    left: 50%;
    transform: translateX(-50%);
    background: ${isSuccess ? '#10b981' : '#ef4444'};
    color: white;
    padding: 12px 20px;
    border-radius: 8px;
    font-weight: 600;
    font-size: 14px;
    z-index: 1000000;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    animation: slideUp 0.3s ease;
    white-space: nowrap;
  `;
  notification.textContent = message;

  // Add animation keyframes if not already present
  if (!document.getElementById('lovable-notification-styles')) {
    const style = document.createElement('style');
    style.id = 'lovable-notification-styles';
    style.textContent = `
      @keyframes slideUp {
        from {
          opacity: 0;
          transform: translateX(-50%) translateY(10px);
        }
        to {
          opacity: 1;
          transform: translateX(-50%) translateY(0);
        }
      }
      @keyframes slideDown {
        from {
          opacity: 1;
          transform: translateX(-50%) translateY(0);
        }
        to {
          opacity: 0;
          transform: translateX(-50%) translateY(10px);
        }
      }
    `;
    document.head.appendChild(style);
  }

  floatingWindow.appendChild(notification);

  // Auto-remove after duration
  setTimeout(() => {
    notification.style.animation = 'slideDown 0.3s ease';
    setTimeout(() => {
      notification.remove();
    }, 300);
  }, duration);
}

// JSON escape function
function escapeJsonString(str) {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

// Generate random ID
function generateId() {
  return 'umsg_' + Math.random().toString(36).substr(2, 20);
}

// Core send: posts a chat message through the backend proxy.
// `mode` is 'build' or 'plan'. `attachmentUrls` is an array of already-uploaded URLs.
async function performSend({ message, mode = 'build', attachmentUrls = [], onSuccess, onError, onFinally }) {
  if (!licenseState.valid) {
    showActivationOverlay();
    showNotification('Activate a license first', 2000, false);
    onError?.(new Error('no license'));
    onFinally?.();
    return;
  }
  let finalMessage = (message || '').trim();
  if (!finalMessage && attachmentUrls.length === 0) {
    showNotification('Please enter a message or attach a file', 2000, false);
    onError?.(new Error('empty'));
    onFinally?.();
    return;
  }
  if (attachmentUrls.length) {
    const lines = attachmentUrls.map((u, i) => `Check file ${i + 1} : ${u}`);
    finalMessage = (finalMessage ? finalMessage + '\n' : '') + lines.join('\n');
  }
  try {
    chrome.runtime.sendMessage({ type: 'getHeaders' }, async (headers) => {
      const projectId = extractProjectId();
      if (!projectId || !headers?.authorization || !headers?.browserSessionId) {
        showNotification('Missing required headers. Please log in again.', 3000, false);
        onError?.(new Error('no headers'));
        onFinally?.();
        return;
      }
      try {
        const env = await runCommand('chat', {
          creds: {
            authorization: headers.authorization,
            browser_session_id: headers.browserSessionId,
            client_git_sha: headers.clientGitSha,
            cookie: headers.cookies,
          },
          params: {
            project_id: projectId,
            message: finalMessage,
            chat_only: mode === 'plan',
            id: generateId(),
            viewport_width: window.innerWidth,
            viewport_height: window.innerHeight,
            user_timezone: (function(){try{return Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'}catch(e){return 'UTC'}})(), current_page: (location.pathname||'/'), viewport_dpr: (window.devicePixelRatio||1),
          },
        });
        if (env.status >= 200 && env.status < 300) {
          showNotification('✅ Sent Successfully', 2000, true);
          onSuccess?.(env);
        } else {
          throw new Error(`HTTP ${env.status}: ${String(env.body||'').slice(0,200)}`);
        }
      } catch (error) {
        showNotification('❌ Failed to send message: ' + String(error?.message || error).slice(0, 160), 4000, false);
        onError?.(error);
      } finally {
        onFinally?.();
      }
    });
  } catch (error) {
    showNotification('❌ Error occurred', 2000, false);
    onError?.(error);
    onFinally?.();
  }
}

// Send message (from extension popup window)
async function sendMessage() {
  const input = document.getElementById('lovable-message-input');
  const button = document.getElementById('lovable-send-btn');
  const message = input.value.trim();
  // Block if any uploads still in progress
  if (attachments.some(a => a.status === 'uploading')) {
    showNotification('Please wait for uploads to finish', 2000, false);
    return;
  }
  const done = attachments.filter(a => a.status === 'done' && a.url).map(a => a.url);
  button.disabled = true;
  button.textContent = 'Sending...';
  await performSend({
    message,
    mode: (document.getElementById('lovable-mode-select')?.value === 'plan') ? 'plan' : 'build',
    attachmentUrls: done,
    onSuccess: () => { input.value = ''; clearAttachments(); },
    onFinally: () => { button.disabled = false; button.textContent = 'Send'; },
  });
}


// Patch Lovable messages - expand hidden content and update titles
function patchLovableMessages() {
  // Change "Fix build error" to "Lovable Zero"
  document.querySelectorAll('.special-message').forEach(el => {
    if (el.textContent.trim() === 'Fix build error') {
      el.textContent = '❤️ Lovable Zero';
    }
  });

  // Expand hidden content and hide show/hide buttons
  document.querySelectorAll('[data-closed]').forEach(container => {
    // Find and expand the hidden wrapper
    const hiddenWrapper = container.querySelector('div[style*="height: 0px"]');
    if (hiddenWrapper) {
      hiddenWrapper.style.height = 'auto';
      hiddenWrapper.style.overflow = 'visible';
    }

    // Expand pre content
    const pre = container.querySelector('pre');
    if (pre) {
      pre.style.maxHeight = 'none';
      pre.style.display = 'block';
      pre.style.visibility = 'visible';
      pre.style.opacity = '1';
    }

    // Hide Show more/Show less button
    const button = container.querySelector('button');
    if (button) {
      button.style.display = 'none';
    }
  });

  // Also target buttons by text content for robustness
  document.querySelectorAll('button').forEach(btn => {
    const text = btn.textContent?.trim();
    if (text === 'Show more' || text === 'Show less') {
      // Expand parent content
      const parent = btn.closest('[data-closed]');
      if (parent) {
        const hiddenWrapper = parent.querySelector('div[style*="height: 0px"]');
        if (hiddenWrapper) {
          hiddenWrapper.style.height = 'auto';
          hiddenWrapper.style.overflow = 'visible';
        }
        const pre = parent.querySelector('pre');
        if (pre) {
          pre.style.maxHeight = 'none';
          pre.style.display = 'block';
          pre.style.visibility = 'visible';
          pre.style.opacity = '1';
        }
      }
      btn.style.display = 'none';
    }
  });
}

// Run patch on page load
patchLovableMessages();



// Handle React re-renders (Lovable uses React)
const messageObserver = new MutationObserver(() => {
  if (!isExtensionContextValid()) {
    try { messageObserver.disconnect(); } catch (_) {}
    return;
  }
  try { patchLovableMessages(); } catch (_) {}
});

messageObserver.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['style', 'data-closed']
});


// Update status display
function updateStatus() {
  // Capture cookies from document (content script has access to this)
  const documentCookies = document.cookie;
  if (documentCookies) {
    chrome.runtime.sendMessage({
      type: 'setCookies',
      cookies: documentCookies
    });
  }

  chrome.runtime.sendMessage({ type: 'getHeaders' }, (headers) => {
    const projectId = extractProjectId();
    const statusDiv = document.getElementById('lovable-status');

    if (!statusDiv) return;

    const pidText = projectId ? `Project ID: ${projectId}` : 'Project ID: ✗';
    const shieldOn = window.__lovableShieldOn !== false; // default true

    statusDiv.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px;border-radius:10px;background:linear-gradient(180deg,#ffffff,#f7f8fc) padding-box,linear-gradient(90deg,#8e48ff,#e12429) border-box;border:2px solid transparent;box-shadow:0 1px 2px rgba(15,23,42,0.04);">
        <span title="${pidText}" style="font-size:13px;font-weight:600;color:#1f2937;letter-spacing:0.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0;flex:1;">${pidText}</span>
        <label title="Shield: hide native chat input" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;flex-shrink:0;padding:3px 8px;border-radius:999px;background:linear-gradient(180deg,#f5f6fa,#eef0f5) padding-box,linear-gradient(90deg,#8e48ff,#e12429) border-box;border:2px solid transparent;">
          <span style="font-size:11px;color:#4b5563;font-weight:700;letter-spacing:0.4px;text-transform:uppercase;">Shield</span>
          <span style="position:relative;display:inline-block;width:30px;height:16px;">
            <input type="checkbox" id="lovable-shield-toggle" ${shieldOn ? 'checked' : ''}
              style="opacity:0;width:0;height:0;" />
            <span id="lovable-shield-slider" style="
              position:absolute;cursor:pointer;inset:0;
              background:${shieldOn ? 'linear-gradient(90deg,#8e48ff,#e12429)' : '#ccc'};
              border-radius:16px;transition:.2s;box-shadow:${shieldOn ? '0 0 0 1px rgba(142,72,255,0.25)' : 'none'};">
              <span style="position:absolute;height:12px;width:12px;left:${shieldOn ? '16px' : '2px'};top:2px;background:white;border-radius:50%;transition:.2s;box-shadow:0 1px 2px rgba(0,0,0,0.2);"></span>
            </span>
          </span>
        </label>
      </div>
    `;

    const toggle = document.getElementById('lovable-shield-toggle');
    if (toggle) {
      toggle.addEventListener('change', (e) => {
        window.__lovableShieldOn = e.target.checked;
        try { chrome.storage.local.set({ lovableShieldOn: e.target.checked }); } catch (_) {}
        applyShield();
        updateStatus();
      });
    }
  });
}

function isProjectPage() {
  return /^\/projects\/[^/]+/.test(window.location.pathname);
}

function applyShield() {
  const styleId = 'lovable-shield-style';
  let styleEl = document.getElementById(styleId);
  const on = window.__lovableShieldOn !== false && isProjectPage();
  if (on) {
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = styleId;
      document.documentElement.appendChild(styleEl);
    }
    styleEl.textContent = '';
  } else if (styleEl) {
    styleEl.textContent = '';
  }
}

// Re-evaluate shield on SPA navigations
(function watchUrlChanges() {
  let lastPath = window.location.pathname;
  setInterval(() => {
    if (window.location.pathname !== lastPath) {
      lastPath = window.location.pathname;
      applyShield();
    }
  }, 500);
})();

// Load saved shield state
try {
  chrome.storage.local.get(['lovableShieldOn'], (res) => {
    window.__lovableShieldOn = res.lovableShieldOn !== false; // default true
    applyShield();
  });
} catch (_) {
  window.__lovableShieldOn = true;
  applyShield();
}

// Initialize on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectUI);
} else {
  injectUI();
}

// Periodic tasks — bail out cleanly once the extension context is gone.
function safeInterval(fn, ms) {
  const id = setInterval(() => {
    if (!isExtensionContextValid()) { clearInterval(id); return; }
    try { fn(); } catch (_) {}
  }, ms);
  return id;
}
safeInterval(updateStatus, 2000);
safeInterval(licenseHeartbeat, 60 * 1000);
safeInterval(updateAccountFromLicense, 1000);


// ===== Download Project as ZIP =====
function getFirebaseTokenFromIDB() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open('firebaseLocalStorageDb'); }
    catch (e) { return reject(e); }
    req.onerror = () => reject(new Error('Cannot open firebaseLocalStorageDb'));
    req.onsuccess = () => {
      try {
        const db = req.result;
        const tx = db.transaction('firebaseLocalStorage', 'readonly');
        const all = tx.objectStore('firebaseLocalStorage').getAll();
        all.onsuccess = () => {
          let token = null, exp = 0;
          for (const row of all.result || []) {
            const m = row && row.value && row.value.stsTokenManager;
            if (m && m.accessToken && (m.expirationTime || 0) > exp) {
              token = m.accessToken; exp = m.expirationTime || 0;
            }
          }
          token ? resolve(token) : reject(new Error('No token — not logged in'));
        };
        all.onerror = () => reject(new Error('Failed to read store'));
      } catch (e) { reject(e); }
    };
  });
}

async function fetchProjectZip(projectId, token) {
  const env = await runCommand('download_zip', {
    creds: { authorization: `Bearer ${token}` },
    params: { project_id: projectId },
  });
  if (!env || env.status < 200 || env.status >= 300) {
    throw new Error(`HTTP ${env && env.status}: ${(env && env.body || '').slice(0,200)}`);
  }
  // env.body is base64 of the ZIP bytes
  const bin = atob(env.body || '');
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

async function downloadProject() {
  if (!licenseState.valid) { showActivationOverlay(); showNotification('Activate a license first', 2000, false); return; }
  const btn = document.getElementById('lovable-download-btn');
  const label = document.getElementById('lovable-download-label');
  const setLabel = (t) => { if (label) label.textContent = t; };
  const orig = label ? label.textContent : 'Download Project';
  const projectId = extractProjectId();
  if (!projectId) { alert('Open a Lovable /projects/<id> page first'); return; }

  btn.disabled = true; btn.style.opacity = '0.7';
  setLabel('Authenticating…');
  try {
    const token = await getFirebaseTokenFromIDB();
    setLabel('Downloading…');
    const zipBytes = await fetchProjectZip(projectId, token);

    const blob = new Blob([zipBytes], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `lovable-${projectId.slice(0,8)}.zip`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setLabel('Downloaded ✓');
    setTimeout(() => setLabel(orig), 3000);
  } catch (e) {
    console.error('[Lovable Zero] Download failed:', e);
    alert('Download failed: ' + (e && e.message ? e.message : e));
    setLabel(orig);
  } finally {
    btn.disabled = false; btn.style.opacity = '1';
  }
}

// ===== Remove Lovable Badge: inject CSS into src/styles.css =====
async function removeLovableBadge() {
  if (!licenseState.valid) { showActivationOverlay(); showNotification('Activate a license first', 2000, false); return; }
  const btn = document.getElementById('lovable-remove-badge-btn');
  const label = document.getElementById('lovable-remove-badge-label');
  const setLabel = (t) => { if (label) label.textContent = t; };
  const orig = label ? label.textContent : 'Remove';
  const projectId = extractProjectId();
  if (!projectId) { alert('Open a Lovable /projects/<id> page first'); return; }
  if (!window.JSZip) { alert('JSZip not loaded'); return; }

  btn.disabled = true; btn.style.opacity = '0.7';
  setLabel('Authenticating…');
  try {
    const token = await getFirebaseTokenFromIDB();
    setLabel('Fetching project…');
    const zipBytes = await fetchProjectZip(projectId, token);

    const zip = await JSZip.loadAsync(zipBytes);
    // Find styles.css regardless of top-level folder name inside zip
    let entry = null;
    zip.forEach((relPath, file) => {
      if (entry || file.dir) return;
      if (/(^|\/)src\/styles\.css$/.test(relPath)) entry = file;
    });
    if (!entry) throw new Error("'src/styles.css' not found in project");

    const baseContent = await entry.async('string');
    const snippetMarker = '/* Lovable Badge Removed by Lovable Zero */';
    if (baseContent.includes(snippetMarker)) {
      setLabel('Already removed ✓');
      setTimeout(() => setLabel(orig), 3000);
      return;
    }

    const customStyles = `\n\n${snippetMarker}\naside#lovable-badge,\n#lovable-badge,\n#lovable-badge-cta,\n#lovable-badge-text,\n#lovable-badge-divider,\n#lovable-badge-close {\n  display: none !important;\n  opacity: 0 !important;\n  visibility: hidden !important;\n  pointer-events: none !important;\n  position: fixed !important;\n  top: -9999px !important;\n  left: -9999px !important;\n  width: 0 !important;\n  height: 0 !important;\n  overflow: hidden !important;\n  z-index: -99999 !important;\n}`;

    setLabel('Committing…');
    const postEnv = await runCommand('edit_code', {
      creds: { authorization: `Bearer ${token}` },
      params: {
        project_id: projectId,
        changes: [{ path: 'src/styles.css', content: baseContent + customStyles }],
        commit_message: 'Badge Removed by Lovable Zero',
        file_edit_type: 'CodeEdit',
      },
    });
    if (postEnv.status < 200 || postEnv.status >= 300) throw new Error(`Commit rejected (HTTP ${postEnv.status})`);

    setLabel('Badge removed ✓');
    setTimeout(() => setLabel(orig), 3000);
  } catch (e) {
    console.error('[Lovable Zero] Remove badge failed:', e);
    alert('Remove failed: ' + (e && e.message ? e.message : e));
    setLabel(orig);
  } finally {
    btn.disabled = false; btn.style.opacity = '1';
  }
}



// ===== Lovable Zero: UI upgrades (Free/Pro -> Unlimited, project badge) =====
function revertLovableInterface() {
  document.querySelectorAll('span[data-extension-modified="true"]').forEach(el => {
    el.removeAttribute('data-extension-modified');
    el.classList.remove('bg-brand-twilight-primary', 'text-brand-twilight-primary-foreground');
    el.classList.add('bg-muted-active', 'text-tertiary-pulse');
    el.style.removeProperty('background');
    el.style.removeProperty('color');
    el.style.removeProperty('border-radius');
    el.style.removeProperty('padding');
    if (el.textContent === 'Unlimited') el.textContent = el.getAttribute('data-original-text') || 'Free';
  });
  document.querySelectorAll('.lovable-zero-badge').forEach(el => el.remove());
}

function upgradeLovableInterface() {
  if (!licenseState.valid) { revertLovableInterface(); return; }
  const spans = document.querySelectorAll('span');
  spans.forEach(el => {
    const text = el.textContent.trim();
    if (el.childNodes.length === 1 && (text === 'Free' || text === 'Pro')) {
      if (el.getAttribute('data-extension-modified') === 'true') return;
      el.setAttribute('data-extension-modified', 'true');
      el.classList.remove('bg-muted-active', 'text-tertiary-pulse');
      el.classList.add('bg-brand-twilight-primary', 'text-brand-twilight-primary-foreground');
      el.style.setProperty('background', 'repeating-linear-gradient(45deg, #e12429, #8e48ff 100px)', 'important');
      el.style.setProperty('color', '#ffffff', 'important');
      el.style.setProperty('border-radius', '99px', 'important');
      el.style.setProperty('padding', '1px 8px 1px 8px', 'important');
      el.textContent = 'Unlimited';
    }
  });

  const projectTitleContainer = document.querySelector('#main-menu p[translate="no"]');
  if (projectTitleContainer) {
    const parentContainer = projectTitleContainer.parentElement;
    if (parentContainer && !parentContainer.querySelector('.lovable-zero-badge')) {
      const zeroBadge = document.createElement('span');
      zeroBadge.className = 'lovable-zero-badge';
      zeroBadge.textContent = 'Lovable Zero';
      zeroBadge.setAttribute('title', 'Continuous generation and credits are securely and dynamically managed by Lovable Zero.');
      zeroBadge.style.setProperty('background', 'repeating-linear-gradient(45deg, #e12429, #8e48ff 100px)', 'important');
      zeroBadge.style.setProperty('padding', '1px 8px 1px 8px', 'important');
      zeroBadge.style.setProperty('border-radius', '99px', 'important');
      zeroBadge.style.setProperty('color', '#ffffff', 'important');
      zeroBadge.style.setProperty('font-size', '10px', 'important');
      zeroBadge.style.setProperty('font-weight', '500', 'important');
      zeroBadge.style.setProperty('text-transform', 'uppercase', 'important');
      zeroBadge.style.setProperty('display', 'inline-block', 'important');
      zeroBadge.style.setProperty('margin-left', '4px', 'important');
      zeroBadge.style.setProperty('cursor', 'help', 'important');
      projectTitleContainer.insertAdjacentElement('afterend', zeroBadge);
    }
  }
}

upgradeLovableInterface();
const upgradeInterval = setInterval(() => {
  if (!isExtensionContextValid()) { clearInterval(upgradeInterval); return; }
  try { upgradeLovableInterface(); } catch (_) {}
}, 500);
const upgradeObserver = new MutationObserver(() => {
  if (!isExtensionContextValid()) { try { upgradeObserver.disconnect(); } catch (_) {} return; }
  try { upgradeLovableInterface(); } catch (_) {}
});
upgradeObserver.observe(document.documentElement, { childList: true, subtree: true });



// ===== Native Chat Integration =====
// Attaches a "LovableZero" header above the native lovable.dev/projects/* chat
// input form and hijacks send actions to route through this extension.
const __nativeAttach = {
  attachedForm: null,
  fileInput: null,
  fileInputHandler: null,
  pendingAttachments: [], // [{name, status, url}]
};

function getNativeMode() {
  // The Build/Plan switcher button shows the current mode label in its content.
  const form = document.getElementById('chat-input');
  if (!form) return 'build';
  const btns = form.querySelectorAll('button[aria-haspopup="menu"]');
  for (const b of btns) {
    const t = (b.textContent || '').trim().toLowerCase();
    if (t.startsWith('plan')) return 'plan';
    if (t.startsWith('build')) return 'build';
  }
  return 'build';
}

function getNativeMessageText() {
  const form = document.getElementById('chat-input');
  if (!form) return '';
  const editor = form.querySelector('[contenteditable="true"].ProseMirror, [contenteditable="true"][role="textbox"]');
  if (!editor) return '';
  // Preserve newlines roughly: replace <br> and block boundaries with \n
  const clone = editor.cloneNode(true);
  clone.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
  clone.querySelectorAll('p,div').forEach(el => { el.append('\n'); });
  return (clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

function clearNativeEditor() {
  const form = document.getElementById('chat-input');
  if (!form) return;
  const editor = form.querySelector('[contenteditable="true"].ProseMirror, [contenteditable="true"][role="textbox"]');
  if (!editor) return;
  editor.innerHTML = '<p><br class="ProseMirror-trailingBreak"></p>';
  editor.dispatchEvent(new InputEvent('input', { bubbles: true }));
}

function renderNativeAttachmentsHint() {
  const hint = document.getElementById('lovable-native-attachments');
  if (!hint) return;
  const items = __nativeAttach.pendingAttachments;
  if (!items.length) { hint.style.display = 'none'; hint.innerHTML = ''; return; }
  hint.style.display = 'flex';
  hint.innerHTML = items.map(a => {
    const icon = a.status === 'uploading' ? '⏳' : a.status === 'done' ? '✅' : '❌';
    return `<span style="background:rgba(102,126,234,0.12);color:#4f46e5;padding:2px 8px;border-radius:10px;font-size:11px;display:inline-flex;gap:4px;align-items:center;">${icon} ${a.name}</span>`;
  }).join('');
}

async function handleNativeFiles(files) {
  for (const file of files) {
    if (file.size > 100 * 1024 * 1024) {
      showNotification(`Too large (max 100MB): ${file.name}`, 2500, false);
      continue;
    }
    const item = { name: file.name, status: 'uploading', url: null };
    __nativeAttach.pendingAttachments.push(item);
    renderNativeAttachmentsHint();
    try {
      item.url = await uploadToTmpfileLink(file);
      item.status = 'done';
    } catch (e) {
      item.status = 'error';
      showNotification(`Upload failed: ${file.name}`, 2500, false);
    }
    renderNativeAttachmentsHint();
  }
}

async function nativeSendIntercept(e) {
  if (e) { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation(); }
  if (!licenseState.valid) { showActivationOverlay(); showNotification('Activate a license first', 2000, false); return; }
  const message = getNativeMessageText();
  const mode = getNativeMode();
  const uploading = __nativeAttach.pendingAttachments.some(a => a.status === 'uploading');
  if (uploading) { showNotification('Please wait for uploads to finish', 2000, false); return; }
  const urls = __nativeAttach.pendingAttachments.filter(a => a.status === 'done' && a.url).map(a => a.url);

  const sendBtn = document.getElementById('chatinput-send-message-button');
  if (sendBtn) sendBtn.setAttribute('aria-disabled', 'true');

  setNativeSendStatus('sending');
  let sendOk = false;
  await performSend({
    message, mode, attachmentUrls: urls,
    onSuccess: () => {
      sendOk = true;
      clearNativeEditor();
      __nativeAttach.pendingAttachments = [];
      renderNativeAttachmentsHint();
    },
    onFinally: () => {
      if (sendBtn) sendBtn.removeAttribute('aria-disabled');
      setNativeSendStatus(sendOk ? 'sent' : 'error');
    },
  });
}

function injectNativeChatIntegration() {
  // Only run on project pages: https://lovable.dev/projects/*
  if (!/^\/projects\/[^/]+/.test(location.pathname)) {
    const existing = document.getElementById('lovable-native-header');
    if (existing) existing.remove();
    const chips = document.getElementById('lovable-native-attachments');
    if (chips) chips.remove();
    __nativeAttach.attachedForm = null;
    return;
  }
  const form = document.getElementById('chat-input');
  if (!form) return;

  // Header bar (insert once) — placed BELOW the chat-input form.
  if (!document.getElementById('lovable-native-header')) {
    const header = document.createElement('div');
    header.id = 'lovable-native-header';
    header.style.cssText = `
      display:flex;align-items:center;justify-content:space-between;
      gap:8px;padding:6px 10px;margin:6px 0 0 0;
      background:linear-gradient(135deg,#8e48ff,#e12429);
      color:#fff;border-radius:10px;font:600 12px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
      box-shadow:0 2px 8px rgba(142,72,255,0.25);
    `;
    header.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;">
        <span>LovableZero</span>
        <span id="lovable-native-status"
          style="display:inline-flex;align-items:center;gap:4px;background:#ef4444;color:#fff;
                 padding:2px 9px;border-radius:999px;font:700 10px/1.2 inherit;letter-spacing:0.2px;
                 box-shadow:inset 0 0 0 1px rgba(255,255,255,0.25);">Inactive</span>
        <span id="lovable-native-send-status"
          style="display:none;align-items:center;gap:4px;background:rgba(255,255,255,0.18);
                 color:#fff;padding:2px 9px;border-radius:999px;font:600 10px/1.2 inherit;
                 box-shadow:inset 0 0 0 1px rgba(255,255,255,0.3);"></span>
      </div>
      <div style="display:flex;gap:6px;align-items:center;">
        <button type="button" id="lovable-native-popup-btn"
          style="background:rgba(255,255,255,0.18);color:#fff;border:1px solid rgba(255,255,255,0.3);
                 padding:3px 10px;border-radius:8px;font:600 11px/1 inherit;cursor:pointer;display:inline-flex;align-items:center;gap:4px;">
          ↗️ PopUp
        </button>
      </div>
    `;
    form.parentNode.insertBefore(header, form.nextSibling);

    // Attachment chips row (below the header)
    const chips = document.createElement('div');
    chips.id = 'lovable-native-attachments';
    chips.style.cssText = 'display:none;flex-wrap:wrap;gap:6px;margin:6px 0 0 0;padding:0 4px;';
    header.parentNode.insertBefore(chips, header.nextSibling);

    header.querySelector('#lovable-native-popup-btn').addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const fw = document.getElementById('lovable-chat-window');
      if (fw) { fw.style.display = 'flex'; updateWindowPosition(fw); }
    });
  }


  // Hijack submit (covers button click, Enter key, and mobile send button)
  if (__nativeAttach.attachedForm !== form) {
    form.addEventListener('submit', nativeSendIntercept, true);
    // Delegated click: catch any send-like button inside the form
    // (desktop uses #chatinput-send-message-button; mobile may render a
    // different button, or none at all — this covers both).
    form.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest && e.target.closest('button');
      if (!btn) return;
      if (btn.id === 'lovable-native-send-btn' || btn.id === 'lovable-native-popup-btn') return;
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      const isSend =
        btn.id === 'chatinput-send-message-button' ||
        btn.type === 'submit' ||
        /^(send|send message|submit)$/i.test(aria) ||
        aria.includes('send message');
      if (isSend) nativeSendIntercept(e);
    }, true);
    const sendBtn = form.querySelector('#chatinput-send-message-button');
    if (sendBtn) {
      sendBtn.removeAttribute('aria-disabled');
      sendBtn.disabled = false;
    }
    // Intercept Enter key in the contenteditable (desktop). Mobile
    // keyboards rarely fire a usable Enter — the header Send button and
    // form submit delegation cover mobile.
    const editor = form.querySelector('[contenteditable="true"].ProseMirror, [contenteditable="true"][role="textbox"]');
    if (editor && !editor.__lovableZeroHook) {
      editor.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          nativeSendIntercept(e);
        }
      }, true);
      editor.__lovableZeroHook = true;
    }
    __nativeAttach.attachedForm = form;
  }

  // Wire native file <input type="file"> change events through tmpfile.link
  const fi = form.querySelector('input[type="file"]');
  if (fi && __nativeAttach.fileInput !== fi) {
    if (__nativeAttach.fileInput && __nativeAttach.fileInputHandler) {
      try { __nativeAttach.fileInput.removeEventListener('change', __nativeAttach.fileInputHandler, true); } catch (_) {}
    }
    const handler = (e) => {
      const files = Array.from(e.target.files || []);
      if (!files.length) return;
      // Prevent Lovable from also uploading the files itself.
      e.stopPropagation(); e.stopImmediatePropagation();
      handleNativeFiles(files);
      // Reset value so the same file can be re-selected later.
      try { e.target.value = ''; } catch (_) {}
    };
    fi.addEventListener('change', handler, true);
    __nativeAttach.fileInput = fi;
    __nativeAttach.fileInputHandler = handler;
  }

  // Keep send button enabled when license is valid (Lovable disables it on empty input).
  const sendBtn2 = form.querySelector('#chatinput-send-message-button');
  if (sendBtn2 && licenseState.valid) {
    sendBtn2.removeAttribute('aria-disabled');
    sendBtn2.disabled = false;
  }
  const statusEl = document.getElementById('lovable-native-status');
  if (statusEl) {
    if (licenseState.valid) {
      statusEl.textContent = 'Active';
      statusEl.style.background = '#10b981';
      statusEl.style.color = '#fff';
    } else {
      statusEl.textContent = 'Inactive';
      statusEl.style.background = '#ef4444';
      statusEl.style.color = '#fff';
    }
  }
}

function setNativeSendStatus(state) {
  const el = document.getElementById('lovable-native-send-status');
  if (!el) return;
  if (!state) { el.style.display = 'none'; el.textContent = ''; return; }
  el.style.display = 'inline-flex';
  if (state === 'sending') {
    el.textContent = 'Sending...';
    el.style.background = 'rgba(255,255,255,0.18)';
  } else if (state === 'sent') {
    el.textContent = 'Sent ✔️';
    el.style.background = 'rgba(16,185,129,0.85)';
    setTimeout(() => { setNativeSendStatus(null); }, 2500);
  } else if (state === 'error') {
    el.textContent = 'Failed';
    el.style.background = 'rgba(239,68,68,0.9)';
    setTimeout(() => { setNativeSendStatus(null); }, 3000);
  }
}

safeInterval(injectNativeChatIntegration, 1000);
injectNativeChatIntegration();

// ============================================================
// Cloudflare challenge UI surfacing (inline modal, first-party)
// ============================================================
function lzEnsureCfModal() {
  let el = document.getElementById('lovable-cf-modal');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'lovable-cf-modal';
  el.style.cssText = [
    'position:fixed','inset:0','z-index:2147483647',
    'background:rgba(2,6,23,0.75)','backdrop-filter:blur(4px)',
    'display:flex','align-items:center','justify-content:center',
    'font:13px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif'
  ].join(';');
  el.innerHTML = `
    <div style="background:#0b0f17;color:#fff;border:1px solid rgba(255,255,255,0.12);border-radius:14px;width:min(560px,92vw);max-height:92vh;box-shadow:0 20px 60px rgba(0,0,0,0.55);display:flex;flex-direction:column;overflow:hidden;">
      <div style="padding:14px 16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid rgba(255,255,255,0.08);">
        <div style="display:flex;align-items:center;gap:8px;font-weight:600;">
          <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#f59e0b;"></span>
          Cloudflare verification required
        </div>
        <button id="lovable-cf-close" style="background:transparent;color:#94a3b8;border:0;font-size:20px;cursor:pointer;line-height:1;">×</button>
      </div>
      <div style="padding:10px 16px;color:#cbd5e1;font-size:12px;">
        Complete the Cloudflare challenge below to keep sending messages. This page will refresh automatically once you're verified.
      </div>
      <div style="padding:0 16px 12px;">
        <iframe id="lovable-cf-frame" style="width:100%;height:480px;border:1px solid rgba(255,255,255,0.08);border-radius:10px;background:#fff;" referrerpolicy="no-referrer-when-downgrade"></iframe>
      </div>
      <div style="padding:10px 16px 14px;display:flex;gap:8px;justify-content:space-between;align-items:center;border-top:1px solid rgba(255,255,255,0.08);">
        <div style="color:#94a3b8;font-size:11px;">If the challenge doesn't load inline, use "Open in new tab".</div>
        <div style="display:flex;gap:8px;">
          <button id="lovable-cf-open" style="background:transparent;color:#cbd5e1;border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:6px 10px;cursor:pointer;font-size:12px;">Open in new tab</button>
          <button id="lovable-cf-reload" style="background:linear-gradient(135deg,#8e48ff,#e12429);color:#fff;border:0;border-radius:8px;padding:6px 12px;cursor:pointer;font-weight:600;font-size:12px;">I've verified — reload</button>
        </div>
      </div>
    </div>`;
  document.documentElement.appendChild(el);
  el.querySelector('#lovable-cf-close')?.addEventListener('click', () => el.remove());
  el.querySelector('#lovable-cf-reload')?.addEventListener('click', () => { try { location.reload(); } catch (_) {} });
  return el;
}

function lzShowCfChallenge(url) {
  const el = lzEnsureCfModal();
  const target = url || 'https://lovable.dev/';
  const frame = el.querySelector('#lovable-cf-frame');
  if (frame && frame.src !== target) frame.src = target;
  const openBtn = el.querySelector('#lovable-cf-open');
  if (openBtn) openBtn.onclick = () => { try { window.open(target, '_blank'); } catch (_) {} };
}

function lzHideCfChallenge(reload) {
  const el = document.getElementById('lovable-cf-modal');
  if (el) el.remove();
  if (reload) { try { location.reload(); } catch (_) {} }
}

try {
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'CF_CHALLENGE_REQUIRED') lzShowCfChallenge(msg.url);
    else if (msg.type === 'CF_CHALLENGE_SOLVED') lzHideCfChallenge(true);
  });
} catch (_) {}

