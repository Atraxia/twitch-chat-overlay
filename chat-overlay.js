(() => {
  if (window.__tctLoaded) return;
  window.__tctLoaded = true;

  const DEFAULTS = {
    left: 20,
    top: 60,
    width: 360,
    height: 320,
    visible: true,
    moveMode: false,
    fontSize: 14,
    fadeMode: false,
    fadeDelay: 10,
    bold: false,
    hideEvents: false,
    hideBots: false,
    hideCommands: false,
    highlightUsers: [],
  };
  const MAX_MESSAGES = 80;
  const SYNC_DELAY = 300; // laisse le temps à 7TV de remplacer le texte par les émotes
  const FADE_DURATION = 1000; // durée de l'effacement en ms

  let settings = { ...DEFAULTS };
  let overlay = null;
  let list = null;
  let scroller = null;
  let observer = null;
  let drag = null;

  const tracked = new WeakSet();   // lignes originales du chat Twitch
  const pairs = new WeakMap();     // ligne originale -> copie dans l'overlay
  const scheduled = new Set();     // lignes en attente de synchronisation

  function createOverlay() {
    overlay = document.createElement("div");
    overlay.id = "tct-overlay";
    overlay.innerHTML = `<div class="tct-list"></div>`;
    list = overlay.querySelector(".tct-list");

    overlay.addEventListener("pointerdown", (e) => {
      if (!overlay.classList.contains("tct-move")) return;
      const r = overlay.getBoundingClientRect();
      // Ne pas déplacer quand on attrape la poignée de redimensionnement (coin bas-droit)
      if (e.clientX > r.right - 16 && e.clientY > r.bottom - 16) return;
      drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
      overlay.setPointerCapture(e.pointerId);
      e.preventDefault();
    });

    overlay.addEventListener("pointermove", (e) => {
      if (!drag) return;
      overlay.style.left = drag.left + (e.clientX - drag.x) + "px";
      overlay.style.top = drag.top + (e.clientY - drag.y) + "px";
    });

    overlay.addEventListener("pointerup", () => {
      if (!drag) return;
      drag = null;
      saveGeometry();
    });
  }

  // Enregistre la position et la taille après un déplacement ou un redimensionnement
  function saveGeometry() {
    if (!overlay.classList.contains("tct-move")) return;
    const r = overlay.getBoundingClientRect();
    settings.left = Math.round(r.left);
    settings.top = Math.round(r.top);
    settings.width = Math.round(r.width);
    settings.height = Math.round(r.height);
    chrome.storage.local.set({
      left: settings.left,
      top: settings.top,
      width: settings.width,
      height: settings.height,
    });
  }

  // Applique les réglages courants à l'overlay
  function applySettings() {
    overlay.style.left = settings.left + "px";
    overlay.style.top = settings.top + "px";
    overlay.style.width = settings.width + "px";
    overlay.style.height = settings.height + "px";
    overlay.style.display = settings.visible ? "flex" : "none";
    overlay.style.setProperty("--tct-font-size", settings.fontSize + "px");
    overlay.classList.toggle("tct-move", settings.moveMode);
    overlay.classList.toggle("tct-bold", settings.bold);
    overlay.classList.toggle("tct-hide-events", settings.hideEvents);
    overlay.classList.toggle("tct-hide-bots", settings.hideBots);
    overlay.classList.toggle("tct-hide-commands", settings.hideCommands);
    applyHighlights();
    document.querySelectorAll(".tct-toggle-btn").forEach((b) => {
      b.classList.toggle("tct-off", !settings.visible);
    });
  }

  // L'overlay n'existe que quand Twitch est en plein écran
  function mount() {
    let host = document.fullscreenElement;

    if (!host) {
      if (overlay.isConnected) overlay.remove();
      return;
    }

    // Une balise <video> ne peut pas contenir d'enfants : on utilise son parent
    if (host.tagName === "VIDEO") host = host.parentElement;

    if (overlay.parentElement !== host) {
      host.appendChild(overlay);
    }
  }

  // Mode fade : efface les messages plus anciens que le délai choisi
  function tickFade() {
    if (!settings.fadeMode) {
      list.querySelectorAll(".tct-fade-out").forEach((el) => el.classList.remove("tct-fade-out"));
      return;
    }

    const limit = settings.fadeDelay * 1000;
    const now = Date.now();

    for (const el of Array.from(list.children)) {
      if (el.classList.contains("tct-fade-out")) continue;
      if (now - Number(el.dataset.tctTime) < limit) continue;

      el.classList.add("tct-fade-out");
      setTimeout(() => {
        // Ne supprime que si le message est toujours en fondu (le mode n'a pas été coupé entre-temps)
        if (el.classList.contains("tct-fade-out")) el.remove();
      }, FADE_DURATION);
    }
  }

  function findScroller() {
    return (
      document.querySelector('[data-a-target="chat-scroller"]') ||
      document.querySelector(".chat-scrollable-area__message-container")
    );
  }

  function isChatMessage(node) {
    return (
      node.matches?.(".chat-line__message") ||
      node.querySelector?.(".chat-line__message")
    );
  }

  // Remonte depuis un élément modifié jusqu'à la ligne de chat suivie
  function findTrackedLine(node) {
    let el = node;
    while (el && el !== scroller) {
      if (tracked.has(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  // Pseudo Twitch : lettres, chiffres et underscore uniquement, en minuscules
  function normalizeName(raw) {
    return raw.trim().replace(/^@/, "").toLowerCase().replace(/[^a-z0-9_]/g, "");
  }

  function getAuthorName(line) {
    const el = line.querySelector('[data-a-target="chat-message-username"], .chat-author__display-name');
    return el ? el.textContent.trim().toLowerCase() : "";
  }

  // Surligne les messages des pseudos activés dans la liste
  function applyHighlights() {
    const active = new Set((settings.highlightUsers || []).filter((u) => u.on).map((u) => u.name));
    for (const line of Array.from(list.children)) {
      line.classList.toggle("tct-highlight", active.has(getAuthorName(line)));
    }
  }

  // Bots connus (noms en minuscules)
  const BOT_NAMES = ["nightbot", "streamelements", "streamlabs", "moobot", "fossabot", "wizebot"];

  // Détermine si une ligne est un abonnement / événement, un message de bot ou une commande
  function getLineInfo(original) {
    const isEvent = !!(
      original.matches?.('.user-notice-line, [data-a-target="user-notice-line"]') ||
      original.querySelector?.('.user-notice-line, [data-a-target="user-notice-line"]')
    );

    const nameEl = original.querySelector('[data-a-target="chat-message-username"], .chat-author__display-name');
    const name = nameEl ? nameEl.textContent.trim().toLowerCase() : "";
    const isBot = BOT_NAMES.includes(name);

    const textEl = original.querySelector('[data-a-target="chat-message-text"], .text-fragment');
    const text = textEl ? textEl.textContent.trim() : "";
    const isCommand = text.startsWith("!");

    return { isEvent, isBot, isCommand };
  }

  // Copie la ligne dans l'overlay, en remplaçant l'ancienne copie si elle existe
  function syncLine(original) {
    scheduled.delete(original);

    const clone = original.cloneNode(true);
    clone.removeAttribute("id");

    const info = getLineInfo(original);
    clone.classList.toggle("tct-kind-event", info.isEvent);
    clone.classList.toggle("tct-kind-bot", info.isBot);
    clone.classList.toggle("tct-kind-command", info.isCommand);

    const old = pairs.get(original);
    if (old && old.isConnected) {
      clone.dataset.tctTime = old.dataset.tctTime;
      old.replaceWith(clone);
    } else {
      clone.dataset.tctTime = Date.now();
      list.appendChild(clone);
    }
    pairs.set(original, clone);

    while (list.children.length > MAX_MESSAGES) {
      list.firstChild.remove();
    }
    applyHighlights();
    list.scrollTop = list.scrollHeight;
  }

  function scheduleSync(original) {
    if (scheduled.has(original)) return;
    scheduled.add(original);
    setTimeout(() => syncLine(original), SYNC_DELAY);
  }

  function attachChat() {
    const s = findScroller();
    if (!s || s === scroller) return;

    scroller = s;
    if (observer) observer.disconnect();

    observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        // Modification d'une ligne déjà copiée (ex. émote 7TV ajoutée après coup)
        const line = findTrackedLine(m.target);
        if (line) scheduleSync(line);

        // Nouveau message du chat
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1 || !isChatMessage(node)) continue;
          tracked.add(node);
          scheduleSync(node);
        }
      }
    });

    observer.observe(scroller, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  // Panneau de réglages dans le lecteur, dans le style du menu paramètres de Twitch
  let panelEl = null;
  let panelView = "main"; // "main" | "fontSize" | "fadeDelay"

  const FONT_OPTIONS = [
    { value: 12, label: "Petite" },
    { value: 14, label: "Moyenne" },
    { value: 16, label: "Grande" },
    { value: 18, label: "Très grande" },
    { value: 22, label: "Énorme" },
  ];
  const FADE_OPTIONS = [3, 5, 10, 20, 30, 60].map((v) => ({ value: v, label: v + " s" }));

  const ICON_CLOSE = `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M5.3 4.2 10 8.9l4.7-4.7 1.1 1.1-4.7 4.7 4.7 4.7-1.1 1.1L10 11.1l-4.7 4.7-1.1-1.1 4.7-4.7-4.7-4.7z"/></svg>`;
  const ICON_BACK = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M9.5 3.5 5 8l4.5 4.5.9-.9L6.8 8l3.6-3.6z"/></svg>`;
  const ICON_CHEVRON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6 3.5 10.5 8 6 12.5l-.9-.9L8.7 8 5.1 4.4z"/></svg>`;
  const ICON_CHECK = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6.3 11.3 3.5 8.5l.9-.9 1.9 1.9 5.3-5.3.9.9z"/></svg>`;

  const FILTER_ROWS = [
    ["hideEvents", "Masquer abonnements et événements"],
    ["hideBots", "Masquer les bots"],
    ["hideCommands", "Masquer les commandes (!)"],
  ];

  const TOGGLE_ROWS = [
    ["visible", "Afficher le chat"],
    ["bold", "Texte en gras"],
    ["moveMode", "Mode déplacement"],
    ["fadeMode", "Mode fade"],
  ];

  const formatValue = (key, value) => {
    const list = key === "fontSize" ? FONT_OPTIONS : FADE_OPTIONS;
    const found = list.find((o) => o.value === value);
    return found ? found.label : String(value);
  };

  const toggleRow = (key, label) => `
    <label class="tct-row">
      <span>${label}</span>
      <span class="tct-switch">
        <input type="checkbox" data-key="${key}" ${settings[key] ? "checked" : ""}>
        <span class="tct-track"></span>
      </span>
    </label>`;

  const navRow = (view, label) => `
    <button type="button" class="tct-row" data-action="open" data-view="${view}">
      <span>${label}</span>
      <span class="tct-right">
        <span class="tct-value">${formatValue(view, settings[view])}</span>${ICON_CHEVRON}
      </span>
    </button>`;

  function renderMain() {
    return `
      <div class="tct-head">
        <button type="button" class="tct-close" data-action="close">${ICON_CLOSE}<span>Fermer</span></button>
      </div>
      ${TOGGLE_ROWS.map(([key, label]) => toggleRow(key, label)).join("")}
      ${navRow("fontSize", "Taille du texte")}
      ${navRow("fadeDelay", "Disparition après")}
      ${highlightRow()}
      <div class="tct-divider"></div>
      <div class="tct-section">Filtres</div>
      ${FILTER_ROWS.map(([key, label]) => toggleRow(key, label)).join("")}
      <div class="tct-divider"></div>
      <button type="button" class="tct-row tct-plain" data-action="reset">Réinitialiser</button>`;
  }

  function renderOptions(view) {
    const list = view === "fontSize" ? FONT_OPTIONS : FADE_OPTIONS;
    const title = view === "fontSize" ? "Taille du texte" : "Disparition après";
    return `
      <div class="tct-head">
        <button type="button" class="tct-close" data-action="back">${ICON_BACK}<span>${title}</span></button>
      </div>
      ${list.map((o) => `
        <button type="button" class="tct-row tct-option" data-action="set" data-key="${view}" data-value="${o.value}">
          <span>${o.label}</span>
          ${settings[view] === o.value ? `<span class="tct-check">${ICON_CHECK}</span>` : ""}
        </button>`).join("")}`;
  }

  const highlightRow = () => `
    <button type="button" class="tct-row" data-action="open" data-view="highlight">
      <span>Utilisateurs surlignés</span>
      <span class="tct-right">
        <span class="tct-value">${(settings.highlightUsers || []).length}</span>${ICON_CHEVRON}
      </span>
    </button>`;

  function renderHighlight() {
    const users = settings.highlightUsers || [];
    return `
      <div class="tct-head">
        <button type="button" class="tct-close" data-action="back">${ICON_BACK}<span>Utilisateurs surlignés</span></button>
      </div>
      <div class="tct-add">
        <input type="text" id="tct-add-input" placeholder="Pseudo Twitch" maxlength="40">
        <button type="button" class="tct-add-btn" data-action="add">Ajouter</button>
      </div>
      ${users.length === 0 ? '<div class="tct-empty">Aucun utilisateur ajouté.</div>' : ""}
      ${users.map((u) => `
        <div class="tct-user-row">
          <span class="tct-user-name">${u.name}</span>
          <span class="tct-switch">
            <input type="checkbox" data-action="toggle-user" data-name="${u.name}" ${u.on ? "checked" : ""}>
            <span class="tct-track"></span>
          </span>
          <button type="button" class="tct-remove" data-action="remove" data-name="${u.name}" aria-label="Retirer">×</button>
        </div>`).join("")}`;
  }

  function saveHighlightUsers(users) {
    chrome.storage.local.set({ highlightUsers: users });
  }

  function addHighlightUser() {
    const input = panelEl.querySelector("#tct-add-input");
    const name = normalizeName(input ? input.value : "");
    if (!name) return;
    const users = settings.highlightUsers || [];
    if (users.some((u) => u.name === name)) return;
    saveHighlightUsers([...users, { name, on: true }]);
  }

  function removeHighlightUser(name) {
    saveHighlightUsers((settings.highlightUsers || []).filter((u) => u.name !== name));
  }

  function toggleHighlightUser(name, on) {
    saveHighlightUsers((settings.highlightUsers || []).map((u) => (u.name === name ? { ...u, on } : u)));
  }

  // Redessine le panneau selon la vue courante (principale ou sous-menu)
  function syncPanel() {
    if (!panelEl) return;
    if (panelView === "main") panelEl.innerHTML = renderMain();
    else if (panelView === "highlight") panelEl.innerHTML = renderHighlight();
    else panelEl.innerHTML = renderOptions(panelView);
  }

  // Le panneau se place dans la même zone que l'overlay (plein écran ou lecteur)
  function getHost() {
    let host = document.fullscreenElement || document.querySelector(".video-player");
    if (host && host.tagName === "VIDEO") host = host.parentElement;
    return host;
  }

  function createPanel() {
    panelEl = document.createElement("div");
    panelEl.id = "tct-panel";

    // Les clics dans le panneau ne doivent pas mettre le stream en pause
    ["pointerdown", "mousedown", "click", "wheel", "keydown"].forEach((type) => {
      panelEl.addEventListener(type, (e) => e.stopPropagation());
    });

    panelEl.addEventListener("click", (e) => {
      const el = e.target.closest("[data-action]");
      if (!el) return;

      switch (el.dataset.action) {
        case "close":
          closePanel();
          break;
        case "open":
          panelView = el.dataset.view;
          syncPanel();
          break;
        case "back":
          panelView = "main";
          syncPanel();
          break;
        case "set":
          panelView = "main";
          chrome.storage.local.set({ [el.dataset.key]: Number(el.dataset.value) });
          break;
        case "add":
          addHighlightUser();
          break;
        case "remove":
          removeHighlightUser(el.dataset.name);
          break;
        case "reset":
          chrome.storage.local.set(DEFAULTS);
          break;
      }
    });

    panelEl.addEventListener("change", (e) => {
      if (e.target.dataset.action === "toggle-user") {
        toggleHighlightUser(e.target.dataset.name, e.target.checked);
        return;
      }
      const key = e.target.dataset.key;
      if (!key || e.target.type !== "checkbox") return;
      chrome.storage.local.set({ [key]: e.target.checked });
    });

    panelEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.target.id === "tct-add-input") addHighlightUser();
    });
  }

  function openPanel() {
    const host = getHost();
    if (!host) return;
    if (!panelEl) createPanel();
    panelView = "main";
    if (panelEl.parentElement !== host) host.appendChild(panelEl);
    syncPanel();
  }

  function closePanel() {
    if (panelEl) panelEl.remove();
  }

  function togglePanel() {
    if (panelEl && panelEl.isConnected) closePanel();
    else openPanel();
  }

  // Bouton dans la barre de contrôle du lecteur, à côté de Clip
  const CHAT_ICON = `<svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M2 3.5A1.5 1.5 0 0 1 3.5 2h13A1.5 1.5 0 0 1 18 3.5v9a1.5 1.5 0 0 1-1.5 1.5H8.5L5 17.5V14H3.5A1.5 1.5 0 0 1 2 12.5z"/></svg>`;

  function makeButton(className, label, icon, onClick) {
    const btn = document.createElement("button");
    btn.className = className;
    btn.type = "button";
    btn.title = label;
    btn.setAttribute("aria-label", label);
    btn.innerHTML = icon;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    return btn;
  }

  // Ajoute le bouton chat au début de la barre de droite, à côté de Clip
  function ensureToggleButton() {
    const group = document.querySelector(".player-controls__right-control-group");
    if (!group || group.querySelector(".tct-toggle-btn")) return;

    const chatBtn = makeButton(
      "tct-toggle-btn",
      "Afficher / masquer le chat overlay",
      CHAT_ICON,
      () => chrome.storage.local.set({ visible: !settings.visible })
    );
    chatBtn.classList.toggle("tct-off", !settings.visible);

    group.prepend(chatBtn);
  }

  // Ajoute « Chat overlay » dans le menu paramètres de Twitch
  function closeTwitchMenu() {
    const btn = document.querySelector('[data-a-target="player-settings-button"]');
    if (btn) btn.click();
  }

  const MENU_CHEVRON = `<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M6 3.5 10.5 8 6 12.5l-.9-.9L8.7 8 5.1 4.4z"/></svg>`;

  function ensureMenuItem() {
    const menu = document.querySelector('[data-a-target="player-settings-menu"]');
    if (!menu || menu.querySelector(".tct-menu-item")) return;

    // Entrée propre, sans copie du style des autres lignes
    const item = document.createElement("button");
    item.type = "button";
    item.className = "tct-menu-item";
    item.innerHTML = `<span>Chat overlay</span>${MENU_CHEVRON}`;

    item.addEventListener(
      "click",
      (e) => {
        e.preventDefault();
        e.stopPropagation();
        closeTwitchMenu();
        togglePanel();
      },
      true
    );

    menu.appendChild(item);
  }

  // Clic droit sur un pseudo : on retient le pseudo pour le menu Chrome
  let lastRightClickedName = null;

  document.addEventListener(
    "contextmenu",
    (e) => {
      const el = e.target.closest?.('[data-a-target="chat-message-username"], .chat-author__display-name');
      lastRightClickedName = el ? normalizeName(el.textContent) : null;
    },
    true
  );

  // Le menu Chrome demande de basculer le surlignage du pseudo retenu
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type !== "toggleHighlight" || !lastRightClickedName) return;

    const name = lastRightClickedName;
    const current = settings.highlightUsers || [];
    const entry = current.find((u) => u.name === name);
    const on = !(entry && entry.on);
    const next = entry
      ? current.map((u) => (u.name === name ? { ...u, on } : u))
      : [...current, { name, on }];
    chrome.storage.local.set({ highlightUsers: next });
  });

  createOverlay();
  ensureToggleButton();

  chrome.storage.local.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
    applySettings();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    for (const key in changes) {
      if (key in DEFAULTS) settings[key] = changes[key].newValue;
    }
    if (!drag) applySettings();
    syncPanel();
  });

  mount();
  attachChat();

  document.addEventListener("fullscreenchange", () => {
    mount();
    closePanel();
  });

  // Twitch est une application dynamique : on vérifie régulièrement l'état
  setInterval(() => {
    attachChat();
    mount();
    tickFade();
    ensureToggleButton();
    ensureMenuItem();
  }, 500);
})();
