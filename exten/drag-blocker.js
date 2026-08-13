(function () {
  "use strict";
  if (window.__lovasiriDragBlockerInstalled) return;
  window.__lovasiriDragBlockerInstalled = true;

  // v13.88 — Passthrough mode: NÃO bloqueia nem intercepta o drop.
  // Deixa a Lovable receber o arquivo nativamente (mesmo fluxo do clip)
  // e apenas notifica o overlay visual "Arraste seu arquivo aqui".

  function isNativeChatActive() {
    try {
      return document.documentElement && document.documentElement.getAttribute("data-ql-native-chat-active") === "1";
    } catch (_) {
      return false;
    }
  }
  function hasFiles(event) {
    try {
      var dt = event && event.dataTransfer;
      if (!dt) return false;
      if (dt.files && dt.files.length) return true;
      var types = Array.prototype.slice.call(dt.types || []);
      return types.indexOf("Files") !== -1 || types.indexOf("application/x-moz-file") !== -1;
    } catch (_) {
      return false;
    }
  }
  function getPromptForm() {
    try {
      return document.querySelector("form#chat-input") || document.querySelector('form:has([contenteditable="true"])');
    } catch (_) {
      return document.querySelector("form#chat-input");
    }
  }
  function isPointOverPrompt(event) {
    var form = getPromptForm();
    if (!form || !form.getBoundingClientRect) return false;
    var r = form.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    return event.clientX >= r.left && event.clientX <= r.right && event.clientY >= r.top && event.clientY <= r.bottom;
  }
  function notify(type) {
    try {
      window.postMessage({ __lovasiriDragBlocker: true, type: type, files: [] }, "*");
    } catch (_) {}
  }

  var overPrompt = false;

  function onEvent(event) {
    if (!isNativeChatActive() || !hasFiles(event)) return;
    // Overlay-only; no preventDefault, no stopPropagation → drop nativo funciona.
    if (event.type === "dragenter" || event.type === "dragover") {
      var over = isPointOverPrompt(event);
      if (over && !overPrompt) {
        overPrompt = true;
        notify("drag-over");
      } else if (!over && overPrompt) {
        overPrompt = false;
        notify("drag-leave-prompt");
      }
    } else if (event.type === "dragleave") {
      try {
        if (event.relatedTarget) return;
        if (
          event.clientX <= 0 ||
          event.clientY <= 0 ||
          event.clientX >= (window.innerWidth || 0) ||
          event.clientY >= (window.innerHeight || 0)
        ) {
          overPrompt = false;
          notify("drag-end");
        }
      } catch (_) {}
    } else if (event.type === "drop") {
      overPrompt = false;
      notify("drag-end"); // apenas esconde overlay; NÃO envia files (Lovable trata nativamente)
    }
  }

  ["dragenter", "dragover", "dragleave", "drop"].forEach(function (t) {
    window.addEventListener(t, onEvent, { capture: true, passive: true });
    document.addEventListener(t, onEvent, { capture: true, passive: true });
  });
})();
