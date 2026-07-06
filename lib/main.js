const path = require("path");
const { CompositeDisposable } = require("atom");
const SpellerBackend = require("./speller-backend");
const instanceCheckers = new Map();
let menuCache = {event: null, word: "", range: null, editor: null, suggestions: [], isMisspelled: false};
let started = false


function updateMenuCache(event) {
  if (menuCache.event === event) return;
  menuCache = {event, word: "", range: null, editor: null, suggestions: [], isMisspelled: false};
  const editorElement = event.target.closest("atom-text-editor");
  if (!editorElement) return;
  const editor = editorElement.getModel();
  if (!editor) return;
  const checker = instanceCheckers.get(editor.id);
  if (!checker) return;
  let screenPosition;
  if (typeof editorElement.screenPositionForMouseEvent === "function") {
    screenPosition = editorElement.screenPositionForMouseEvent(event);
  } else if (editorElement.getComponent()?.screenPositionForMouseEvent) {
    screenPosition = editorElement.getComponent().screenPositionForMouseEvent(event);
  } else return;
  const bufferPosition = editor.bufferPositionForScreenPosition(screenPosition);
  const markers = checker.markerLayer.findMarkers({containsBufferPosition: bufferPosition});
  if (markers.length === 0) return;
  const marker = markers[0];
  const props = marker.getProperties();
  menuCache.isMisspelled = true;
  menuCache.word = props.word;
  menuCache.suggestions = props.suggestions || [];
  menuCache.range = marker.getBufferRange();
  menuCache.editor = editor;
}


module.exports = {
  config: {
    spellcheckerPath: {
      order: 1,
      type: "string",
      default: "aspell",
      description: "Command or path to ispell-compatible spell checker"
    },
    customFlags: {
      order: 2,
      type: "string",
      default: "",
      description: "Additional command-line parameters passed to the spell checker engine (e.g., --sug-mode=ultra)"
    },
    grammars: {
      order: 3,
      type: "array",
      default: ["source.asciidoc", "source.gfm", "text.git-commit", "text.plain", "text.plain.null-grammar", "source.rst", "text.restructuredtext", "source string", "source comment"],
      items: {type: "string"},
      description: "List of language scopes to check for spelling. Use `Log Cursor Scrope` command to get scopes at cursor position."
    },
    excludedScopes: {
      order: 4,
      type: "array",
      default: ["meta.embedded.line.interpolation.python"],
      items: {type: "string"}
      ,
      description: "List of language sub-scopes to exclude from spell checking."
    },
    language: {
      order: 5,
      type: "string",
      default: "en_US",
      description: "Locale dictionary to use with spell checker (`aspell dump dicts` / `hunspell -D`)."
    },
    minimapIntegration: {
      order: 6,
      type: "boolean",
      default: true,
      description: "Check to make misspelled lined appear green in minimap, if minimap package is installed."
    },
    enabled: {
      order: 7,
      type: "boolean",
      default: true,
      description: "Globally turn the spellchecker ON or OFF"
    },
  },
  minimapService: null,

  activate() {
    this.subscriptions = new CompositeDisposable();
    this.globalLineCache = new Map();
    this.minimapService = null;
    const spellcheckerPath = atom.config.get("fast-spell-check.spellcheckerPath");
    const language = atom.config.get("fast-spell-check.language");
    const customFlags = atom.config.get("fast-spell-check.customFlags") || "";
    const personalDictPath = path.join(atom.getConfigDirPath(), "fast-spell-check-personal.dict");
    this.backend = new SpellerBackend(spellcheckerPath, language, personalDictPath, customFlags);

    // commands
    for (let i = 0; i < 5; i++) {
      this.subscriptions.add(
        atom.commands.add("atom-text-editor", `fast-spell-check:apply-suggestion-${i}`, () => {
          if (menuCache.editor && menuCache.range && menuCache.suggestions[i]) {
            menuCache.editor.setCursorBufferPosition(menuCache.range.end);
            menuCache.editor.transact(() => {
              menuCache.editor.setTextInBufferRange(menuCache.range, menuCache.suggestions[i]);
            });
          }
        })
      );
    }
    this.subscriptions.add(
      atom.commands.add("atom-text-editor", "fast-spell-check:add-to-known-words", () => {
        if (!menuCache.word) return;
        this.backend.addWord(menuCache.word);
        this.globalLineCache.clear();
        for (const checker of instanceCheckers.values()) {
          checker.fullScan();
        }
      })
    );
    this.subscriptions.add(
      atom.commands.add("atom-text-editor", "fast-spell-check:next-misspelled", () => {
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) return;
        const checker = instanceCheckers.get(editor.id);
        if (!checker) return;
        const markers = checker.markerLayer.getMarkers().sort((a, b) =>
          a.getBufferRange().start.compare(b.getBufferRange().start)
        );
        if (markers.length === 0) return;
        const cursor = editor.getCursorBufferPosition();
        const nextMarker = markers.find(m => m.getBufferRange().end.isGreaterThan(cursor));
        const targetMarker = nextMarker || markers[0];
        editor.setCursorBufferPosition(targetMarker.getBufferRange().end);
        showPopupForMarker(editor, targetMarker, this.backend, this.globalLineCache);
      })
    );
    this.subscriptions.add(
      atom.commands.add("atom-text-editor", "fast-spell-check:previous-misspelled", () => {
        const editor = atom.workspace.getActiveTextEditor();
        if (!editor) return;
        const checker = instanceCheckers.get(editor.id);
        if (!checker) return;
        const markers = checker.markerLayer.getMarkers().sort((a, b) =>
          a.getBufferRange().start.compare(b.getBufferRange().start)
        );
        if (markers.length === 0) return;
        const cursor = editor.getCursorBufferPosition();
        const prevMarkers = markers.filter(m => m.getBufferRange().end.isLessThan(cursor));
        const targetMarker = prevMarkers.length > 0 ? prevMarkers[prevMarkers.length - 1] : markers[markers.length - 1];
        editor.setCursorBufferPosition(targetMarker.getBufferRange().end);
        showPopupForMarker(editor, targetMarker, this.backend, this.globalLineCache);
      })
    );
    this.subscriptions.add(
      atom.commands.add("atom-text-editor", "fast-spell-check:toggle", () => {
        const current = atom.config.get("fast-spell-check.enabled");
        atom.config.set("fast-spell-check.enabled", !current);
      })
    );
    this.subscriptions.add(
      atom.config.onDidChange("fast-spell-check.enabled", ({ newValue }) => {
        for (const checker of instanceCheckers.values()) {
          checker.isEnabled = newValue;
          if (newValue) {
            checker.fullScan();
          } else {
            checker.clearAllMarkers();
          }
        }
      })
    );

    // right click context menu items
    const contextMenuItems = [];
    contextMenuItems.push({
      label: "Toggle Spellchecker",
      created() {
        const isEnabled = atom.config.get("fast-spell-check.enabled");
        this.label = isEnabled ? "Disable Spellchecker" : "Enable Spellchecker";
        this.command = "fast-spell-check:toggle";
      }
    });
    contextMenuItems.push({
      type: "separator",
      shouldDisplay(e) {
        updateMenuCache(e);
        return menuCache.isMisspelled && menuCache.suggestions.length > 0;
      }
    });
    for (let i = 0; i < 5; i++) {
      contextMenuItems.push({
        label: `Suggestion ${i + 1}`,
        shouldDisplay(e) {
          updateMenuCache(e);
          return menuCache.isMisspelled && menuCache.suggestions.length > i;
        },
        created(e) {
          updateMenuCache(e);
          this.label = menuCache.suggestions[i] || "";
          this.command = `fast-spell-check:apply-suggestion-${i}`;
        }
      });
    }
    contextMenuItems.push({
      label: "Add to dictionary",
      shouldDisplay(e) {
        updateMenuCache(e);
        return menuCache.isMisspelled;
      },
      created() {
        this.command = "fast-spell-check:add-to-known-words";
      }
    });
    contextMenuItems.push({
      type: "separator",
      shouldDisplay(e) {
        updateMenuCache(e);
        return menuCache.isMisspelled && menuCache.suggestions.length > 0;
      }
    });
    this.subscriptions.add(
      atom.contextMenu.add({ "atom-text-editor": contextMenuItems })
    );

    // on config changes
    let restartNotification = null;
    const triggerRestartNotice = () => {
      if (restartNotification && !restartNotification.isDismissed()) return;
      restartNotification = atom.notifications.addWarning("Speller Configuration Updated", {
        detail: "Window must be reloaded to apply structural daemon changes cleanly.",
        dismissable: true,
        buttons: [{text: "Reload Window Now", onDidClick: () => atom.reload()}]
      });
    };
    this.subscriptions.add(
      atom.config.onDidChange("fast-spell-check.spellcheckerPath", () => triggerRestartNotice())
    );
    this.subscriptions.add(
      atom.config.onDidChange("fast-spell-check.language", () => triggerRestartNotice())
    );
    this.subscriptions.add(
      atom.config.onDidChange("fast-spell-check.customFlags", () => triggerRestartNotice())
    );
    this.subscriptions.add(
      atom.config.onDidChange("fast-spell-check.excludedScopes", () => {
        this.globalLineCache.clear();
        for (const checker of instanceCheckers.values()) checker.fullScan();
      })
    );
    this.subscriptions.add(
      atom.config.onDidChange("fast-spell-check.minimapIntegration", () => {
        this.globalLineCache.clear();
        for (const checker of instanceCheckers.values()) checker.fullScan();
      })
    );

    // start spellchecker on new window
    this.subscriptions.add(
      atom.workspace.observeTextEditors(editor => {
        const checker = new EditorChecker(editor, this.backend, this.globalLineCache, this.minimapService);
        instanceCheckers.set(editor.id, checker);
        this.subscriptions.add(editor.onDidDestroy(() => {
          checker.destroy();
          instanceCheckers.delete(editor.id);
        }));
      })
    );
  },

  deactivate() {
    this.subscriptions.dispose();
    for (const checker of instanceCheckers.values()) checker.destroy();
    instanceCheckers.clear();
    if (this.backend) this.backend.destroy();
  },

  consumeMinimapService(minimapService) {
    this.minimapService = minimapService;
    for (const checker of instanceCheckers.values()) {
      checker.setMinimapService(minimapService);
    }
  }
};


class EditorChecker {
  constructor(editor, backend, globalCache, minimapService) {
    this.editor = editor;
    this.buffer = editor.getBuffer();
    this.backend = backend;
    this.globalCache = globalCache;
    this.minimapService = minimapService;
    this.minimap = null;
    this.dirtyRows = new Set();
    this.dirtyWordEdit = null;
    this.checkTimeout = null;
    this.isProcessingRows = false;
    this.hasAlertedError = false;
    this.subscriptions = new CompositeDisposable();
    this.markerLayer = this.editor.addMarkerLayer();
    this.editor.decorateMarkerLayer(this.markerLayer, {type: "highlight", class: "fast-spell-check-misspelling"});
    this.subscriptions.add(this.buffer.onDidChangeText(event => this.handleBufferChange(event)));

    // delay for startup
    if (!started) {
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      async function delay() {
        await sleep(2000);
      }
      started = true;
      delay();
    }

    this.fullScan();
  }

  setMinimapService(minimapService) {
    this.minimapService = minimapService;
    const minimapIntegration = atom.config.get("fast-spell-check.minimapIntegration");
    if (!minimapIntegration || !this.minimapService) {
      this.minimap = null;
      return;
    }
    this.minimap = this.minimapService.minimapForEditor(this.editor);
    if (this.minimap) {
      for (const marker of this.markerLayer.getMarkers()) {
        this.minimap.decorateMarker(marker, { type: "line", color: "#28a745" });
      }
    }
  }

  handleBufferChange(event) {
    if (!atom.config.get("fast-spell-check.enabled")) return;
    const changes = event.changes || [];
    if (changes.length === 1) {
      const change = changes[0];
      const isSingleLine = change.newRange.start.row === change.newRange.end.row && change.oldRange.start.row === change.oldRange.end.row;
      const isTyping = isSingleLine && !/\s/.test(change.newText) && !/\s/.test(change.oldText);
      if (isTyping) {
        this.dirtyWordEdit = {
          row: change.newRange.start.row,
          column: change.newRange.end.column
        };
        this.scheduleCheck();
        return;
      }
    }
    this.dirtyWordEdit = null;
    for (const change of changes) {
      if (change.newRange) {
        for (let row = change.newRange.start.row; row <= change.newRange.end.row; row++) {
          this.dirtyRows.add(row);
        }
      }
    }
    if (changes.length === 0 && event.newRange) {
      for (let row = event.newRange.start.row; row <= event.newRange.end.row; row++) {
        this.dirtyRows.add(row);
      }
    }
    this.scheduleCheck();
  }

  scheduleCheck() {
    if (this.checkTimeout) clearTimeout(this.checkTimeout);
    this.checkTimeout = setTimeout(() => this.processPendingChecks(), 150);
  }

  async processPendingChecks() {
    if (this.isProcessingRows) {
      this.scheduleCheck();
      return;
    }
    this.isProcessingRows = true;
    try {
      if (this.dirtyWordEdit && this.dirtyRows.size === 0) {
        const { row, column } = this.dirtyWordEdit;
        this.dirtyWordEdit = null;
        await this.processWordCheck(row, column);
        return;
      }
      this.dirtyWordEdit = null;
      await this.processDirtyRowsInternal();
    } finally {
      this.isProcessingRows = false;
    }
  }

  async processWordCheck(row, column) {
    if (row >= this.buffer.getLineCount()) return;
    const lineText = this.buffer.lineForRow(row);
    if (!lineText) return;
    const wordRegex = /[A-Za-z\u00C0-\u017F"-]+/g;
    let match;
    let wordInfo = null;

    while ((match = wordRegex.exec(lineText)) !== null) {
      const start = match.index;
      const end = wordRegex.lastIndex;
      if (column >= start && column <= end) {
        wordInfo = { word: match[0], start, end };
        break;
      }
    }

    if (!wordInfo) {
      const oldMarkers = this.markerLayer.findMarkers({
        intersectsBufferRange: [[row, column], [row, column + 1]]
      });
      for (const marker of oldMarkers) marker.destroy();
      return;
    }

    const { word, start, end } = wordInfo;
    const configuredRules = atom.config.get("fast-spell-check.grammars") || [];
    const excludedScopes = atom.config.get("fast-spell-check.excludedScopes") || [];
    if (!this.isPositionEligible(row, start, configuredRules, excludedScopes)) {
      const oldMarkers = this.markerLayer.findMarkers({ intersectsBufferRange: [[row, start], [row, end]] });
      for (const marker of oldMarkers) marker.destroy();
      return;
    }

    try {
      const misspellings = await this.backend.checkLine(word);
      this.hasAlertedError = false;
      const oldMarkers = this.markerLayer.findMarkers({
        intersectsBufferRange: [[row, start], [row, end]]
      });
      for (const marker of oldMarkers) marker.destroy();

      if (misspellings.length > 0) {
        const item = misspellings[0];
        const startCol = start + item.offset;
        const endCol = startCol + item.word.length;
        const marker = this.markerLayer.markBufferRange([[row, startCol], [row, endCol]], {invalidate: "never", exclusive: true});
        marker.setProperties({word: item.word, suggestions: item.suggestions || []});
        const minimapIntegration = atom.config.get("fast-spell-check.minimapIntegration");
        if (minimapIntegration && this.minimapService) {
          if (!this.minimap) this.minimap = this.minimapService.minimapForEditor(this.editor);
          if (this.minimap) this.minimap.decorateMarker(marker, {type: "line", color: "#28a745"});
        }
      }
    } catch (err) {
      if (!this.hasAlertedError) {
        this.hasAlertedError = true;
        atom.notifications.addError("Spelling Engine Failure", {detail: err.message, dismissable: true});
      }
    }
  }

  async processDirtyRowsInternal() {
    while (this.dirtyRows.size > 0) {
      const rows = Array.from(this.dirtyRows);
      this.dirtyRows.clear();
      const configuredRules = atom.config.get("fast-spell-check.grammars") || [];
      const excludedScopes = atom.config.get("fast-spell-check.excludedScopes") || [];
      const minimapIntegration = atom.config.get("fast-spell-check.minimapIntegration");

      for (const row of rows) {
        if (row >= this.buffer.getLineCount()) continue;
        const lineText = this.buffer.lineForRow(row);
        if (!lineText || !lineText.trim()) {
          const oldMarkers = this.markerLayer.findMarkers({intersectsBufferRange: [[row, 0], [row, Number.MAX_SAFE_INTEGER]]});
          for (const marker of oldMarkers) marker.destroy();
          continue;
        }

        let misspellings = [];
        if (this.globalCache.has(lineText)) {
          misspellings = this.globalCache.get(lineText);
        } else {
          try {
            misspellings = await this.backend.checkLine(lineText);
            this.globalCache.set(lineText, misspellings);
            this.hasAlertedError = false;
          } catch (err) {
            if (!this.hasAlertedError) {
              this.hasAlertedError = true;
              atom.notifications.addError("Spelling Engine Failure", {detail: err.message, dismissable: true});
            }
            continue;
          }
        }

        const oldMarkers = this.markerLayer.findMarkers({intersectsBufferRange: [[row, 0], [row, Number.MAX_SAFE_INTEGER]]});
        for (const marker of oldMarkers) marker.destroy();
        for (const item of misspellings) {
          const startCol = item.offset;
          const endCol = startCol + item.word.length;
          if (this.isPositionEligible(row, startCol, configuredRules, excludedScopes)) {
            const marker = this.markerLayer.markBufferRange([[row, startCol], [row, endCol]], {invalidate: "never", exclusive: true});
            marker.setProperties({word: item.word, suggestions: item.suggestions || []});
            if (minimapIntegration && this.minimapService) {
              if (!this.minimap) this.minimap = this.minimapService.minimapForEditor(this.editor);
              if (this.minimap) this.minimap.decorateMarker(marker, {type: "line", color: "#28a745"});
            }
          }
        }
      }
    }
  }

  isPositionEligible(row, column, configuredRules, excludedScopes) {
    const scopeDescriptor = this.editor.scopeDescriptorForBufferPosition([row, column]);
    const tokenScopes = scopeDescriptor.getScopesArray();
    const handlingExclusion = excludedScopes.some(rule => {
      const parts = rule.split(/\s+/);
      return parts.every(part => tokenScopes.some(scope => scope.includes(part)));
    });
    if (handlingExclusion) return false;
    return configuredRules.some(rule => {
      const parts = rule.split(/\s+/);
      return parts.every(part => tokenScopes.some(scope => scope.includes(part)));
    });
  }

  fullScan() {
    if (!atom.config.get("fast-spell-check.enabled")) return;
    const lineCount = this.buffer.getLineCount();
    for (let i = 0; i < lineCount; i++) this.dirtyRows.add(i);
    this.dirtyWordEdit = null;
    this.processPendingChecks();
  }

  clearAllMarkers() {
    if (this.checkTimeout) clearTimeout(this.checkTimeout);
    this.dirtyRows.clear();
    this.dirtyWordEdit = null;
    const markers = this.markerLayer.getMarkers();
    for (const marker of markers) {
      marker.destroy();
    }
  }

  destroy() {
    if (this.checkTimeout) clearTimeout(this.checkTimeout);
    this.subscriptions.dispose();
    this.markerLayer.destroy();
    this.minimap = null;
  }
}


// popup window stuff

let activePopupDecoration = null;
let popupDisposable = null;


function destroyActivePopup() {
  if (activePopupDecoration) {
    activePopupDecoration.destroy();
    activePopupDecoration = null;
  }
  if (popupDisposable) {
    popupDisposable.dispose();
    popupDisposable = null;
  }
}


function updateActiveButton(buttons, activeIndex) {
  buttons.forEach((btnObj, idx) => {
    if (idx === activeIndex) {
      btnObj.el.classList.add("is-active");
    } else {
      btnObj.el.classList.remove("is-active");
    }
  });
}

function createPopupElement(editor, marker, backend, globalLineCache) {
  const container = document.createElement("div");
  container.classList.add("fast-spell-check-popup-container");
  const props = marker.getProperties();
  const suggestions = props.suggestions || [];
  const word = props.word;
  const buttons = [];
  if (suggestions.length === 0) {
    const noSug = document.createElement("div");
    noSug.classList.add("fast-spell-check-no-suggestions");
    noSug.textContent = "No suggestions found";
    container.appendChild(noSug);
  } else {
    suggestions.forEach(sug => {
      const btn = document.createElement("button");
      btn.classList.add("fast-spell-check-btn", "fast-spell-check-btn-sug");
      btn.textContent = sug;
      btn.addEventListener("mousedown", (e) => e.preventDefault());
      btn.addEventListener("click", () => {
        editor.transact(() => {
          editor.setTextInBufferRange(marker.getBufferRange(), sug);
        });
        destroyActivePopup();
      });
      container.appendChild(btn);
      buttons.push({ el: btn, action: () => btn.click() });
    });
  }

  const hr = document.createElement("div");
  hr.classList.add("fast-spell-check-separator");
  container.appendChild(hr);
  const addBtn = document.createElement("button");
  addBtn.classList.add("fast-spell-check-btn", "fast-spell-check-btn-add");
  addBtn.textContent = "Add to dictionary";
  addBtn.addEventListener("mousedown", (e) => e.preventDefault());
  addBtn.addEventListener("click", () => {
    backend.addWord(word);
    globalLineCache.clear();
    for (const checker of instanceCheckers.values()) {
      checker.fullScan();
    }
    destroyActivePopup();
  });
  container.appendChild(addBtn);
  buttons.push({ el: addBtn, action: () => addBtn.click() });
  return {container, buttons};
}


function showPopupForMarker(editor, marker, backend, globalLineCache) {
  destroyActivePopup();
  const editorElement = atom.views.getView(editor);
  const { container, buttons } = createPopupElement(editor, marker, backend, globalLineCache);
  activePopupDecoration = editor.decorateMarker(marker, {
    type: "overlay",
    item: container,
    class: "fast-spell-check-popup"
  });
  let activeIndex = 0;
  if (buttons.length > 0) {
    updateActiveButton(buttons, activeIndex);
  }

  // mouse synchronization
  buttons.forEach((btnObj, idx) => {
    btnObj.el.addEventListener("mouseenter", () => {
      activeIndex = idx;
      updateActiveButton(buttons, activeIndex);
    });
  });

  const handleKeyDown = (e) => {
    if (buttons.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      e.stopImmediatePropagation();
      activeIndex = (activeIndex + 1) % buttons.length;
      updateActiveButton(buttons, activeIndex);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      e.stopImmediatePropagation();
      activeIndex = (activeIndex - 1 + buttons.length) % buttons.length;
      updateActiveButton(buttons, activeIndex);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopImmediatePropagation();
      buttons[activeIndex].action();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      destroyActivePopup();
    }
  };

  editorElement.addEventListener("keydown", handleKeyDown, true);
  const { CompositeDisposable } = require("atom");
  popupDisposable = new CompositeDisposable();
  popupDisposable.add({dispose: () => {editorElement.removeEventListener("keydown", handleKeyDown, true)}});
  popupDisposable.add(editor.onDidChangeCursorPosition(() => destroyActivePopup()));
  popupDisposable.add(editor.getBuffer().onDidChangeText(() => destroyActivePopup()));
}
