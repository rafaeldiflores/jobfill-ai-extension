/**
 * JobFill AI - Popup Script
 */

document.addEventListener("DOMContentLoaded", async () => {
  const btnAutofill = document.getElementById("btnAutofill");
  const btnOpenOptions = document.getElementById("btnOpenOptions");
  const linkEditData = document.getElementById("linkEditData");
  const statusMessage = document.getElementById("statusMessage");
  const userNameDisplay = document.getElementById("userNameDisplay");
  const userRoleDisplay = document.getElementById("userRoleDisplay");
  const userInitial = document.getElementById("userInitial");
  const aiStatusBadge = document.getElementById("aiStatusBadge");

  const popupCvProfileSelect = document.getElementById("popupCvProfileSelect");
  const enabledToggle = document.getElementById("extensionEnabledToggle");
  const enabledLabel = document.getElementById("extensionEnabledLabel");
  const disabledBanner = document.getElementById("disabledBanner");
  const popupContainer = document.querySelector(".popup-container");

  // Load storage
  let storedData = await chrome.storage.local.get(null);
  let activeProfile = null;

  /**
   * `candidateBase` es único — no varía por índice — así que cambiar de
   * índice ya NO reescribe ningún "espejo" de identidad (nombre, email,
   * teléfono...): eso simplifica lo que antes hacía este archivo, no lo
   * complica. Lo único que cambia por índice es el nombre/título de la
   * faceta, para el desplegable y el rol mostrado.
   */
  function updatePopupUI() {
    const candidateBase = storedData.candidateBase || {};
    const cvIndexes = storedData.cvIndexes || [];
    const activeIndex = cvIndexes.find(i => i.id === storedData.activeCvIndexId) || cvIndexes[0];

    activeProfile = { ...candidateBase, headline: activeIndex?.targetRole || candidateBase.headline || candidateBase.currentTitle || "" };

    const name = activeProfile.fullName || `${activeProfile.firstName || ""} ${activeProfile.lastName || ""}`.trim() || "Tu Nombre";
    const role = activeProfile.headline || "Profesional";

    userNameDisplay.textContent = name;
    userRoleDisplay.textContent = role;
    userInitial.textContent = name.charAt(0).toUpperCase() || "U";

    if (popupCvProfileSelect) {
      popupCvProfileSelect.innerHTML = "";
      if (cvIndexes.length > 0) {
        cvIndexes.forEach(idx => {
          const opt = document.createElement("option");
          opt.value = idx.id;
          opt.textContent = `${idx.area} ${idx.targetRole ? `(${idx.targetRole})` : ""}`;
          if (idx.id === activeIndex?.id) opt.selected = true;
          popupCvProfileSelect.appendChild(opt);
        });
      } else {
        const opt = document.createElement("option");
        opt.textContent = "Perfil Principal";
        popupCvProfileSelect.appendChild(opt);
      }
    }

    if (JobFillAi.hasAiCredentials(storedData)) {
      const ai = JobFillAi.readAiSettings(storedData);
      aiStatusBadge.textContent = ai.provider === "gemini"
        ? "Gemini IA Activo"
        : JobFillAi.hasGeminiFallback(ai) ? "Claude IA Activo (+ Gemini)" : "Claude IA Activo";
      aiStatusBadge.classList.remove("inactive");
    } else {
      aiStatusBadge.textContent = "IA Sin Configurar";
      aiStatusBadge.classList.add("inactive");
    }
  }

  updatePopupUI();

  /**
   * Interruptor global. El estado vive en `extensionEnabled` de
   * chrome.storage.local (ausente = activa): el content script de cada
   * pestaña y el service worker escuchan ese cambio y reaccionan al instante,
   * sin recargar páginas.
   */
  function renderEnabledState(enabled) {
    enabledToggle.checked = enabled;
    enabledLabel.textContent = enabled ? "Activa" : "Apagada";
    disabledBanner.hidden = enabled;
    popupContainer.classList.toggle("is-disabled", !enabled);
    btnAutofill.disabled = !enabled;
  }
  renderEnabledState(storedData.extensionEnabled !== false);

  enabledToggle.addEventListener("change", async () => {
    const enabled = enabledToggle.checked;
    renderEnabledState(enabled);
    await chrome.storage.local.set({ extensionEnabled: enabled });
  });

  if (popupCvProfileSelect) {
    popupCvProfileSelect.addEventListener("change", async () => {
      const newActiveId = popupCvProfileSelect.value;
      const cvIndexes = storedData.cvIndexes || [];
      const selected = cvIndexes.find(i => i.id === newActiveId);
      if (selected) {
        storedData.activeCvIndexId = newActiveId;
        await chrome.storage.local.set({ activeCvIndexId: newActiveId });

        updatePopupUI();
        setStatus(`🎯 Índice activo: ${selected.area}`, "success");
      }
    });
  }

  // Handle Autofill trigger
  btnAutofill.addEventListener("click", async () => {
    if (!enabledToggle.checked) return;
    setStatus("Analizando formulario...", "info");
    
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.id) {
        setStatus("No se encontró pestaña activa.", "error");
        return;
      }

      // Check if URL is special (chrome:// etc.)
      if (tab.url && (tab.url.startsWith("chrome://") || tab.url.startsWith("edge://") || tab.url.startsWith("about:"))) {
        setStatus("No se puede ejecutar en páginas del sistema.", "error");
        return;
      }

      // Send message to content script
      chrome.tabs.sendMessage(tab.id, { type: "TRIGGER_AUTOFILL" }, async (response) => {
        if (chrome.runtime.lastError) {
          // If content script was not injected, inject programmatically
          try {
            await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content/autofill.css"] });
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content/autofill.js"] });
            
            // Retry message
            setTimeout(() => {
              chrome.tabs.sendMessage(tab.id, { type: "TRIGGER_AUTOFILL" }, (res2) => {
                if (res2 && res2.count > 0) {
                  setStatus(`✅ ¡${res2.count} campos rellenados!`, "success");
                } else {
                  setStatus("Formulario analizado.", "info");
                }
              });
            }, 150);
          } catch (injectErr) {
            setStatus("Recarga la pestaña para rellenar.", "error");
          }
        } else if (response && response.count > 0) {
          setStatus(`✅ ¡${response.count} campos rellenados!`, "success");
        } else {
          setStatus("Revisa la página o tus datos.", "info");
        }
      });
    } catch (err) {
      setStatus(err.message || "Error al auto-rellenar.", "error");
    }
  });

  // Handle quick copy buttons
  document.querySelectorAll(".chip").forEach((chip) => {
    chip.addEventListener("click", async () => {
      const fieldKey = chip.getAttribute("data-field");
      let valToCopy = "";

      if (activeProfile && activeProfile[fieldKey]) {
        valToCopy = activeProfile[fieldKey];
      } else if (storedData && storedData[fieldKey]) {
        valToCopy = storedData[fieldKey];
      }

      if (!valToCopy) {
        setStatus(`Campo ${fieldKey} no configurado.`, "error");
        return;
      }

      try {
        await navigator.clipboard.writeText(valToCopy);
        const originalText = chip.innerHTML;
        chip.classList.add("copied");
        chip.innerHTML = "<span>✓</span> Copiado";
        
        setTimeout(() => {
          chip.classList.remove("copied");
          chip.innerHTML = originalText;
        }, 1500);
      } catch (err) {
        setStatus("Error al copiar al portapapeles.", "error");
      }
    });
  });

  function setStatus(msg, type = "info") {
    statusMessage.textContent = msg;
    statusMessage.className = `status-msg ${type}`;
  }

  // Open Options Page
  const openOptions = (e) => {
    e.preventDefault();
    if (chrome.runtime.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    } else {
      window.open(chrome.runtime.getURL("options/options.html"));
    }
  };

  btnOpenOptions.addEventListener("click", openOptions);
  linkEditData.addEventListener("click", openOptions);
});
