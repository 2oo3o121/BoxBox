// Overlay UI component shared by source and output roles.
const MIN_W = 160;
const MIN_H = 160;
let zSeed = 2147483000;
const DEFAULT_LIGHT_COLOR = "#000000";
const DEFAULT_DARK_COLOR = "#000000";
let colorSchemeMediaQuery = null;

function prefersDarkScheme() {
    try {
        if (!colorSchemeMediaQuery) {
            colorSchemeMediaQuery = window.matchMedia(
                "(prefers-color-scheme: dark)",
            );
        }
        return !!colorSchemeMediaQuery.matches;
    } catch {
        return false;
    }
}

function getDefaultShadowColor() {
    return prefersDarkScheme() ? DEFAULT_DARK_COLOR : DEFAULT_LIGHT_COLOR;
}

function clamp01(v) {
    return Math.max(0, Math.min(1, v));
}
function clampInt(v, lo, hi) {
    return Math.max(lo, Math.min(hi, Math.round(v)));
}

function hexToRgb(hex) {
    let h = (hex || "#000000").replace("#", "");
    if (h.length === 3)
        h = h
            .split("")
            .map((c) => c + c)
            .join("");
    const n = parseInt(h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
const rgbStr = ({ r, g, b }) => `rgb(${r}, ${g}, ${b})`;
const rgbaStr = ({ r, g, b }, a = 1) => `rgba(${r}, ${g}, ${b}, ${a})`;

let __prevUserSelect = null;
function disableTextSelection() {
    const el = document.documentElement;
    __prevUserSelect = el.style.userSelect;
    el.style.userSelect = "none";
}
function restoreTextSelection() {
    const el = document.documentElement;
    el.style.userSelect = __prevUserSelect || "";
    __prevUserSelect = null;
}

function isNoDragTarget(e) {
    const path = (e.composedPath && e.composedPath()) || [];
    for (const n of path) {
        if (!n || n === window) continue;
        if (n.dataset && n.dataset.nodrag === "1") return true;
        if (
            n.classList &&
            (n.classList.contains("resize-br") ||
                n.classList.contains("resize-bl") ||
                n.classList.contains("resize-tr") ||
                n.classList.contains("resize-tl"))
        )
            return true;
    }
    return false;
}

// Mouse-driven drag interactions for the overlay host.
function initDragMouse(self, handleEl) {
    let startX, startY, startX0, startY0;
    let dragging = false,
        moved = false;

    const onMove = (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        if (!moved && Math.abs(dx) + Math.abs(dy) > 3) moved = true;

        const w = self.state.width;
        const h = self.state.height;
        self.state.x = Math.min(
            Math.max(0, startX0 + dx),
            Math.max(0, window.innerWidth - w),
        );
        self.state.y = Math.min(
            Math.max(0, startY0 + dy),
            Math.max(0, window.innerHeight - h),
        );

        self.requestPaint();
    };

    const endDrag = () => {
        if (!dragging) return;
        dragging = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        window.removeEventListener("blur", onUp);
        window.removeEventListener("mouseleave", onUp);
        restoreTextSelection();
        moved = false;
    };
    const onUp = () => endDrag();

    handleEl.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        if (isNoDragTarget(e)) return;
        if (typeof self.raiseZ === "function") self.raiseZ();
        dragging = true;
        moved = false;
        startX = e.clientX;
        startY = e.clientY;
        startX0 = self.state.x;
        startY0 = self.state.y;
        disableTextSelection();
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        window.addEventListener("blur", onUp);
        window.addEventListener("mouseleave", onUp);
        e.preventDefault();
    });
}

// Mouse-driven resize handles for each corner.
function initResizeMouse(self, handleEl, mode = "br") {
    let startX, startY, startW, startH, startX0, startY0, rightEdge, bottomEdge;
    let resizing = false;

    const onMove = (e) => {
        if (!resizing) return;
        const dw = e.clientX - startX;
        const dh = e.clientY - startY;

        let newW = startW,
            newH = startH;
        let newX = startX0,
            newY = startY0;

        const locked =
            self.kind === "output" && typeof self.aspectLock === "number";
        const ar = locked ? Math.max(0.01, self.aspectLock) : null;

        if (!locked) {
            if (mode.includes("r")) newW = startW + dw;
            if (mode.includes("l")) newW = startW - dw;
            if (mode.includes("b")) newH = startH + dh;
            if (mode.includes("t")) newH = startH - dh;
            newW = Math.max(MIN_W, newW);
            newH = Math.max(MIN_H, newH);
            newX = mode.includes("l") ? rightEdge - newW : startX0;
            newY = mode.includes("t") ? bottomEdge - newH : startY0;
        } else {
            const movedHoriz = mode.includes("l") || mode.includes("r");
            if (movedHoriz) {
                newW = mode.includes("r") ? startW + dw : startW - dw;
                newW = Math.max(1, newW);
                newH = Math.max(1, Math.round(newW / ar));
            } else {
                newH = mode.includes("b") ? startH + dh : startH - dh;
                newH = Math.max(1, newH);
                newW = Math.max(1, Math.round(newH * ar));
            }
            if (newW < MIN_W) {
                newW = MIN_W;
                newH = Math.round(newW / ar);
            }
            if (newH < MIN_H) {
                newH = MIN_H;
                newW = Math.round(newH * ar);
            }
            newX = mode.includes("l") ? rightEdge - newW : startX0;
            newY = mode.includes("t") ? bottomEdge - newH : startY0;
            const vw = Math.max(1, window.innerWidth),
                vh = Math.max(1, window.innerHeight);
            const s = Math.min(vw / newW, vh / newH, 1);
            if (s < 1) {
                newW = Math.floor(newW * s);
                newH = Math.floor(newH * s);
                newX = mode.includes("l") ? rightEdge - newW : startX0;
                newY = mode.includes("t") ? bottomEdge - newH : startY0;
            }
        }

        newX = Math.min(
            Math.max(0, newX),
            Math.max(0, window.innerWidth - newW),
        );
        newY = Math.min(
            Math.max(0, newY),
            Math.max(0, window.innerHeight - newH),
        );

        if (!locked) {
            if (mode.includes("l"))
                newW = Math.min(
                    Math.max(MIN_W, rightEdge - newX),
                    window.innerWidth - newX,
                );
            if (mode.includes("t"))
                newH = Math.min(
                    Math.max(MIN_H, bottomEdge - newY),
                    window.innerHeight - newY,
                );
        }

        newX = Math.round(newX);
        newY = Math.round(newY);
        newW = Math.round(newW);
        newH = Math.round(newH);

        self.state.x = newX;
        self.state.y = newY;
        self.state.width = newW;
        self.state.height = newH;

        self.requestPaint();
    };

    const endResize = () => {
        if (!resizing) return;
        resizing = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        window.removeEventListener("blur", onUp);
        window.removeEventListener("mouseleave", onUp);
        restoreTextSelection();
    };
    const onUp = () => endResize();

    handleEl.addEventListener("mousedown", (e) => {
        if (e.button !== 0) return;
        e.stopPropagation();
        resizing = true;
        startX = e.clientX;
        startY = e.clientY;
        startW = self.state.width;
        startH = self.state.height;
        startX0 = self.state.x;
        startY0 = self.state.y;
        rightEdge = startX0 + startW;
        bottomEdge = startY0 + startH;
        disableTextSelection();
        document.addEventListener("mousemove", onMove);
        document.addEventListener("mouseup", onUp);
        window.addEventListener("blur", onUp);
        window.addEventListener("mouseleave", onUp);
        e.preventDefault();
    });
}

export default class Overlay {
    // Manages overlay DOM, media, and toolbar interactions.
    constructor(id, kind = "output") {
        this.id = id;
        this.kind = kind;
        this.root = null;
        this.shadow = null;
        this.__rafId = 0;
        this.state = {
            visible: true,
            x: 16,
            y: 16,
            width: 360,
            height: 260,
        };

        this.aspectLock = null;
        this.__lastW = 0;
        this.__lastH = 0;
        this.onGeomChanged = null;
        this.__ro = null;

        this.media = {
            mode: "none",
            host: null,
            img: null,
            video: null,
            canvas: null,
            currentSrc: null,
            crop: null,
            raf: 0,
            ro: null,
        };
        this.__boundPointer = null;
        this.__onStorage = null;
        this.paused = false;
        this.fixed = false;
        this.pausedPoster = null;
        this.onPauseChanged = null;
    }

    // Sets overlay position and size, clamping into viewport bounds.
    setGeom(x, y, w, h) {
        if (typeof x === "object" && x) {
            ({ x, y, width: w, height: h } = x);
        }
        if (
            !Number.isFinite(x) ||
            !Number.isFinite(y) ||
            !Number.isFinite(w) ||
            !Number.isFinite(h)
        ) {
            return;
        }
        this.state.x = Math.round(x);
        this.state.y = Math.round(y);
        this.state.width = Math.max(MIN_W, Math.round(w));
        this.state.height = Math.max(MIN_H, Math.round(h));
        this.clampIntoViewport();
        this.requestPaint();
    }

    getGeom() {
        const w = this.state.width;
        const h = this.state.height;
        return {
            x: this.state.x,
            y: this.state.y,
            width: w,
            height: h,
        };
    }

    raiseZ() {
        if (this.root) this.root.style.zIndex = String(++zSeed);
    }

    setKind(kind) {
        this.kind = kind;
        if (this.shadow) this.shadow.host.setAttribute("data-kind", this.kind);
    }

    // Updates CSS custom properties used by the overlay skin.
    applyTheme(t) {
        if (!this.shadow) return;
        const { shadowColor, radius, opacity } = t || {};
        const o = clamp01(opacity ?? 0.1);
        const sc = hexToRgb(shadowColor || getDefaultShadowColor());
        const rad = clampInt(radius ?? 12, 0, 64);
        const style = this.shadow.getElementById("themeVars");
        const lines = [];
        lines.push(":host {");
        lines.push(`  --border-color: transparent;`);
        lines.push(`  --border-width: 0px;`);
        lines.push(`  --text-color: rgba(229,231,235,0.92);`);
        lines.push(`  --shadow-color: ${rgbStr(sc)};`);
        lines.push(`  --shadow: 0 0 14px ${rgbaStr(sc, 0.28)};`);
        lines.push(`  --radius: ${rad}px;`);
        if (this.kind === "source") {
            lines.push(`  --panel-bg: rgba(0,0,0,0);`);
        } else if (this.kind === "output") {
        }
        lines.push("}");
        lines.push(`
      .wrap .panel {
        border-radius: var(--radius);
        box-shadow: var(--shadow);
      }
      .wrap:has(.panel:hover) .panel,
      .wrap:has(.toolbar:hover) .panel {
        box-shadow: var(--shadow), 0 0 0 2px var(--shadow-color);
      }
    `);
        style.textContent = lines.join("\n");
    }

    // Creates DOM on first use and refreshes existing nodes.
    ensure() {
        if (this.root && this.root.isConnected) {
            this.applyCollapsed();
            this.clampIntoViewport();
            this.requestPaint();
            return;
        }
        this.create();
    }

    remove() {
        if (this.__ro) {
            try {
                this.__ro.disconnect();
            } catch {}
            this.__ro = null;
        }
        if (this.__boundPointer) {
            try {
                window.removeEventListener("mousemove", this.__boundPointer);
            } catch {}
            this.__boundPointer = null;
        }
        if (this.__onStorage) {
            try {
                chrome.storage.onChanged.removeListener(this.__onStorage);
            } catch {}
            this.__onStorage = null;
        }
        if (this.root) this.root.remove();
    }

    create() {
        const root = document.createElement("div");
        root.dataset.peekOverlayId = this.id;
        root.style.position = "fixed";
        root.style.left = "0";
        root.style.top = "0";
        root.style.willChange = "transform";
        root.style.zIndex = String(++zSeed);
        root.style.pointerEvents = "auto";
        root.style.backfaceVisibility = "hidden";
        root.style.transformStyle = "preserve-3d";
        this.root = root;

        const shadow = root.attachShadow({ mode: "open" });
        shadow.innerHTML = `
      <div class="wrap">
        <div class="panel" id="panel">
          <div class="content" id="contentRoot"></div>
          <div class="resize-br" id="resizeBR" data-nodrag="1"></div>
          <div class="resize-bl" id="resizeBL" data-nodrag="1"></div>
          <div class="resize-tr" id="resizeTR" data-nodrag="1"></div>
          <div class="resize-tl" id="resizeTL" data-nodrag="1"></div>
        </div>
        <div class="hoverpad" id="hoverpad" data-nodrag="1"></div>
        <div class="toolbar" id="toolbar" data-nodrag="1">
          <div class="tool-btn" data-nodrag="1"></div>
          <div class="tool-btn" data-nodrag="1"></div>
          <div class="tool-btn" data-nodrag="1"></div>
        </div>
      </div>
    `;
        shadow.host.setAttribute("data-kind", this.kind);
        const critical = document.createElement("style");
        critical.textContent = `
          :host{all:initial}
          .wrap{width:100%;height:100%}
          .panel{position:relative; width:100%; height:100%; background:var(--panel-bg, rgba(0,0,0,.10)); border-radius: var(--radius, 8px); box-shadow: var(--shadow, 0 0 10px rgba(0,0,0,.15));}
          .resize-br,.resize-bl,.resize-tr,.resize-tl{position:absolute;width:12px;height:12px}
          .resize-br{right:0;bottom:0;cursor:nwse-resize}
          .resize-bl{left:0;bottom:0;cursor:nesw-resize}
          .resize-tr{right:0;top:0;cursor:nesw-resize}
          .resize-tl{left:0;top:0;cursor:nwse-resize}
        `;
        shadow.appendChild(critical);
        const linkEl = document.createElement("link");
        linkEl.rel = "stylesheet";
        linkEl.href = chrome.runtime.getURL("content.css");
        shadow.appendChild(linkEl);
        const styleEl = document.createElement("style");
        styleEl.id = "themeVars";
        shadow.appendChild(styleEl);
        this.shadow = shadow;

        document.documentElement.appendChild(root);

        try {
            this.__ro = new ResizeObserver(() => {
                const rect = this.root.getBoundingClientRect();
                const w = Math.round(rect.width);
                const h = Math.round(rect.height);
                if (w > 0 && h > 0) {
                    if (w !== this.__lastW || h !== this.__lastH) {
                        this.__lastW = w;
                        this.__lastH = h;
                        const cb = this.onGeomChanged;
                        if (typeof cb === "function") {
                            try {
                                cb({
                                    x: this.state.x,
                                    y: this.state.y,
                                    width: w,
                                    height: h,
                                    ratio: w / Math.max(1, h),
                                    kind: this.kind,
                                    id: this.id,
                                });
                            } catch {}
                        }
                    }
                }
            });
            this.__ro.observe(this.root);
        } catch {}

        this.hookLogic();
        this.clampIntoViewport();
        this.requestPaint();
    }

    applyGeom() {
        if (!this.root) return;
        const w = this.state.width;
        const h = this.state.height;
        this.root.style.width = `${w}px`;
        this.root.style.height = `${h}px`;
        this.root.style.transform = `translate3d(${this.state.x}px, ${this.state.y}px, 0)`;

        const x = this.state.x,
            y = this.state.y;
        const changed =
            w !== this.__lastW ||
            h !== this.__lastH ||
            x !== this.__lastX ||
            y !== this.__lastY;
        if (changed) {
            this.__lastW = w;
            this.__lastH = h;
            this.__lastX = x;
            this.__lastY = y;
            const cb = this.onGeomChanged;
            if (typeof cb === "function") {
                try {
                    cb({
                        x,
                        y,
                        width: w,
                        height: h,
                        ratio: w / Math.max(1, h),
                        kind: this.kind,
                        id: this.id,
                    });
                } catch {}
            }
        }
    }
    requestPaint() {
        if (this.__rafId) return;
        this.__rafId = requestAnimationFrame(() => {
            this.applyGeom();
            this.updateToolbarDock();
            this.__rafId = 0;
        });
    }
    applyCollapsed() {}
    clampIntoViewport() {
        const w = this.state.width;
        const h = this.state.height;
        this.state.x = Math.min(
            Math.max(0, this.state.x),
            Math.max(0, window.innerWidth - w),
        );
        this.state.y = Math.min(
            Math.max(0, this.state.y),
            Math.max(0, window.innerHeight - h),
        );
    }

    async hookLogic() {
        const panelEl = this.shadow.getElementById("panel");
        const toolbarEl = this.shadow.getElementById("toolbar");
        const wrapEl = this.shadow.querySelector(".wrap");
        const resizeBR = this.shadow.getElementById("resizeBR");
        const resizeBL = this.shadow.getElementById("resizeBL");
        const resizeTR = this.shadow.getElementById("resizeTR");
        const resizeTL = this.shadow.getElementById("resizeTL");

        panelEl.addEventListener("mousedown", () => this.raiseZ(), {
            capture: true,
        });

        initDragMouse(this, panelEl);
        initResizeMouse(this, resizeBR, "br");
        initResizeMouse(this, resizeBL, "bl");
        initResizeMouse(this, resizeTR, "tr");
        initResizeMouse(this, resizeTL, "tl");

        if (toolbarEl && wrapEl) {
            const ptr = (e) => {
                try {
                    const x = e.clientX,
                        y = e.clientY;
                    const r = this.root.getBoundingClientRect();
                    const tr = toolbarEl.getBoundingClientRect();
                    const insidePanel =
                        x >= r.left &&
                        x <= r.right &&
                        y >= r.top &&
                        y <= r.bottom;
                    const insideToolbar =
                        x >= tr.left &&
                        x <= tr.right &&
                        y >= tr.top &&
                        y <= tr.bottom;
                    let insidePad = false;
                    if (wrapEl.classList.contains("toolbar-bottom")) {
                        const padTop = r.bottom - 4;
                        const padBottom = r.bottom + 28;
                        insidePad =
                            x >= r.left &&
                            x <= r.right &&
                            y >= padTop &&
                            y <= padBottom;
                    } else {
                        const padTop = r.top - 28;
                        const padBottom = r.top + 4;
                        insidePad =
                            x >= r.left &&
                            x <= r.right &&
                            y >= padTop &&
                            y <= padBottom;
                    }
                    const visible = insidePanel || insideToolbar || insidePad;
                    if (visible) wrapEl.classList.add("toolbar-visible");
                    else wrapEl.classList.remove("toolbar-visible");
                } catch {}
            };
            this.__boundPointer = ptr;
            window.addEventListener("mousemove", ptr, { passive: true });
        }

        try {
            const btns = this.shadow.querySelectorAll(".tool-btn");
            const rightBtn = btns?.[btns.length - 1];
            const leftBtn = btns?.[0];
            const midBtn = btns?.[1];
            const applyIconStyle = (btn, sizePx, weight) => {
                if (!btn) return;
                if (sizePx) btn.style.setProperty("--icon-size", sizePx);
                else btn.style.removeProperty("--icon-size");
                if (weight) btn.style.setProperty("--icon-weight", weight);
                else btn.style.removeProperty("--icon-weight");
            };
            const clearIcon = (btn) => {
                if (!btn) return;
                delete btn.dataset.icon;
                btn.style.removeProperty("--icon-size");
                btn.style.removeProperty("--icon-weight");
                btn.style.removeProperty("--icon-scale-x");
                btn.style.removeProperty("--icon-offset-y");
                btn.textContent = "";
            };
            const setIcon = (
                btn,
                icon,
                {
                    size = "md",
                    weight = "600",
                    mirror = false,
                    offsetY = null,
                } = {},
            ) => {
                if (!btn) return;
                if (typeof icon === "string") {
                    btn.dataset.icon = icon;
                    btn.textContent = "";
                    const sizePx =
                        size === "sm" ? "9px" : size === "lg" ? "12px" : "11px";
                    applyIconStyle(btn, sizePx, weight);
                    if (mirror) btn.style.setProperty("--icon-scale-x", "-1");
                    else btn.style.removeProperty("--icon-scale-x");
                    if (offsetY !== null)
                        btn.style.setProperty("--icon-offset-y", offsetY);
                    else btn.style.removeProperty("--icon-offset-y");
                } else {
                    clearIcon(btn);
                }
            };
            if (rightBtn) {
                setIcon(rightBtn, "✕", { size: "md", weight: "800" });
                rightBtn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    const sessionId = this.root?.dataset?.peekSessionId;
                    const overlayId = this.id;
                    if (!sessionId) return;
                    if (this.kind === "source") {
                        chrome.runtime
                            .sendMessage({
                                type: "STOP_SESSION",
                                payload: { sessionId },
                            })
                            .catch(() => {});
                    } else if (this.kind === "output") {
                        chrome.runtime
                            .sendMessage({
                                type: "CLOSE_OUTPUT",
                                payload: { sessionId, overlayId },
                            })
                            .catch(() => {});
                    }
                });
            }
            if (leftBtn) {
                if (this.kind === "source") {
                    const SESSIONS_KEY = "__peek_sessions__";
                    const sessionId = this.root?.dataset?.peekSessionId;
                    const updateCount = async () => {
                        try {
                            const data = await chrome.storage.local.get(
                                SESSIONS_KEY,
                            );
                            const s = data?.[SESSIONS_KEY]?.[sessionId];
                            const cnt =
                                s && s.outputs
                                    ? Object.keys(s.outputs).length
                                    : 0;
                            clearIcon(leftBtn);
                            leftBtn.textContent = String(cnt || 0);
                        } catch {}
                    };
                    updateCount();
                    this.__onStorage = (changes) => {
                        if (changes && changes[SESSIONS_KEY]) updateCount();
                    };
                    try {
                        chrome.storage.onChanged.addListener(this.__onStorage);
                    } catch {}
                } else if (this.kind === "output") {
                    setIcon(leftBtn, "⤴", { weight: "600", mirror: true });
                    leftBtn.addEventListener("click", (e) => {
                        e.stopPropagation();
                        const sessionId = this.root?.dataset?.peekSessionId;
                        if (!sessionId) return;
                        chrome.runtime
                            .sendMessage({
                                type: "FOCUS_SOURCE_TAB",
                                payload: { sessionId },
                            })
                            .catch(() => {});
                    });
                }
            }

            if (midBtn) {
                if (this.kind === "output") {
                    const applyMidIcon = (pausedState = this.paused) => {
                        const isPaused = !!pausedState;
                        setIcon(midBtn, isPaused ? "▶" : "❚❚", {
                            weight: "700",
                        });
                    };
                    this.__syncPauseIcon = applyMidIcon;
                    applyMidIcon();
                    const prevOnPause = this.onPauseChanged;
                    this.onPauseChanged = (state) => {
                        applyMidIcon(state?.paused ?? this.paused);
                        if (typeof prevOnPause === "function") prevOnPause(state);
                    };
                    midBtn.addEventListener("click", (e) => {
                        e.stopPropagation();
                        const now = !this.paused;
                        this.setPaused(now);
                        applyMidIcon();
                        if (!this.paused) {
                            const sessionId = this.root?.dataset?.peekSessionId;
                            if (sessionId) {
                                chrome.runtime
                                    .sendMessage({
                                        type: "REQUEST_CROP_AR",
                                        payload: { sessionId },
                                    })
                                    .catch(() => {});
                            }
                        }
                    });
                } else if (this.kind === "source") {
                    const syncLabel = () => {
                        setIcon(midBtn, this.fixed ? "◼" : "◻", {
                            weight: "700",
                            size: "lg",
                            offsetY: "-0.5px",
                        });
                    };
                    syncLabel();
                    midBtn.addEventListener("click", (e) => {
                        e.stopPropagation();
                        this.setFixed(!this.fixed);
                        syncLabel();
                    });
                }
            }
        } catch {}

        window.addEventListener("resize", () => {
            this.clampIntoViewport();
            this.requestPaint();
        });
    }

    updateToolbarDock() {
        try {
            const wrapEl = this.shadow?.querySelector(".wrap");
            if (!wrapEl) return;
            const r = this.root.getBoundingClientRect();
            const threshold = 28;
            const useBottom = r.top < threshold;
            if (useBottom) wrapEl.classList.add("toolbar-bottom");
            else wrapEl.classList.remove("toolbar-bottom");
        } catch {}
    }

    setAspectLock(ar) {
        if (typeof ar !== "number" || !isFinite(ar) || ar <= 0) {
            this.aspectLock = null;
        } else {
            this.aspectLock = ar;
        }
        return this.aspectLock;
    }

    updateAspectLock(ar) {
        this.setAspectLock(ar);
        if (this.kind !== "output" || typeof this.aspectLock !== "number")
            return;

        const arv = Math.max(0.01, this.aspectLock);

        const anchorX = this.state.x;
        const anchorY = this.state.y;

        let targetH = Math.max(1, this.state.height);
        let targetW = Math.max(1, Math.round(targetH * arv));

        if (targetW < MIN_W) {
            targetW = MIN_W;
            targetH = Math.round(targetW / arv);
        }
        if (targetH < MIN_H) {
            targetH = MIN_H;
            targetW = Math.round(targetH * arv);
        }

        const vw = Math.max(1, window.innerWidth);
        const vh = Math.max(1, window.innerHeight);
        const availW = Math.max(1, vw - anchorX);
        const availH = Math.max(1, vh - anchorY);
        const scale = Math.min(availW / targetW, availH / targetH, 1);
        if (scale < 1) {
            targetW = Math.max(1, Math.floor(targetW * scale));
            targetH = Math.max(1, Math.floor(targetH * scale));
        }

        this.state.x = anchorX;
        this.state.y = anchorY;
        this.state.width = targetW;
        this.state.height = targetH;

        this.requestPaint();
    }

    getContentMode() {
        return this.media?.mode || "none";
    }

    setLeftBadge(text) {
        try {
            const btn = this.shadow?.querySelector(".tool-btn");
            if (btn) {
                delete btn.dataset.icon;
                btn.style.removeProperty("--icon-size");
                btn.style.removeProperty("--icon-weight");
                btn.textContent = text ?? "";
            }
        } catch {}
    }

    setFixed(flag) {
        this.fixed = !!flag;
        try {
            const wrapEl = this.shadow?.querySelector(".wrap");
            if (wrapEl) {
                if (this.fixed) wrapEl.classList.add("fix-through");
                else wrapEl.classList.remove("fix-through");
            }
        } catch {}
        try {
            if (this.root)
                this.root.style.pointerEvents = this.fixed ? "none" : "auto";
        } catch {}
    }
    isFixed() {
        return !!this.fixed;
    }

    ensureMediaHost() {
        if (!this.shadow) return null;
        if (this.media.host && this.media.host.isConnected)
            return this.media.host;
        const root = this.shadow.getElementById("contentRoot");
        const host = document.createElement("div");
        host.className = "media-host __peek_media_host";
        root.style.display = "block";
        root.style.width = "100%";
        root.style.height = "100%";
        host.style.width = "100%";
        host.style.height = "100%";
        host.innerHTML = `<div class="media-fit" style="width:100%;height:100%"></div>`;
        root.appendChild(host);
        this.media.host = host;
        return host;
    }

    showImage(src) {
        this.ensureMediaHost();
        const fit = this.media.host.querySelector(".media-fit");
        if (this.media.video) {
            this.media.video.pause();
            this.media.video.srcObject = null;
            this.media.video.remove();
            this.media.video = null;
        }
        if (this.media.canvas) {
            this.media.canvas.remove();
            this.media.canvas = null;
        }

        if (!this.media.img) {
            const img = document.createElement("img");
            img.className = "media-img";
            img.alt = "overlay image";
            img.draggable = false;
            fit.innerHTML = "";
            fit.appendChild(img);
            this.media.img = img;
        }
        if (src) this.media.img.src = src;
        this.media.currentSrc = src || null;
        this.media.mode = "image";
    }

    // Wires a MediaStream into the overlay video element.
    attachStream(stream, { muted = true, mirror = false } = {}) {
        this.ensureMediaHost();
        const fit = this.media.host.querySelector(".media-fit");

        if (this.media.img) {
            this.media.img.remove();
            this.media.img = null;
        }
        if (this.media.canvas) {
            this.media.canvas.remove();
            this.media.canvas = null;
        }
        try {
            this.media.ro?.disconnect();
        } catch {}
        this.media.ro = null;
        if (this.media.raf) {
            cancelAnimationFrame(this.media.raf);
            this.media.raf = 0;
        }

        if (!this.media.video) {
            const v = document.createElement("video");
            v.className = "media-video __peek_media_video";
            v.style.width = "100%";
            v.style.height = "100%";
            v.style.display = "block";
            v.style.objectFit = "cover";
            v.autoplay = true;
            v.playsInline = true;
            v.muted = !!muted;
            fit.innerHTML = "";
            fit.appendChild(v);
            this.media.video = v;
            this.__playSeq = 0;
            this.__applyPausedPoster();
        }

        const v = this.media.video;
        if (v.srcObject !== stream) {
            try {
                v.pause();
            } catch {}
            try {
                v.srcObject = stream || null;
            } catch {}
        }
        this.media.mode = "video";
        const mySeq = ++this.__playSeq;
        requestAnimationFrame(() => {
            if (!this.media?.video || mySeq !== this.__playSeq) return;
            if (!this.media.video.isConnected) return;
            if (this.paused) {
                try {
                    this.media.video.pause?.();
                } catch {}
                return;
            }
            const p = this.media.video.play?.();
            if (p && typeof p.catch === "function") {
                p.catch((err) => {
                    if (
                        err &&
                        (err.name === "AbortError" ||
                            /interrupted by a new load request/i.test(
                                err.message || "",
                            ))
                    ) {
                        return;
                    }
                    try {
                        console.debug(
                            "[OVERLAY] video.play() rejected:",
                            err?.name || err,
                        );
                    } catch {}
                });
            }
        });

        return this.media.video;
    }

    clearMedia() {
        if (this.media.raf) {
            cancelAnimationFrame(this.media.raf);
            this.media.raf = 0;
        }
        if (this.media.video) {
            try {
                const ms = this.media.video.srcObject;
                if (ms && typeof ms.getTracks === "function")
                    ms.getTracks().forEach((t) => t.stop());
            } catch {}
            this.media.video.srcObject = null;
            this.media.video.remove();
            this.media.video = null;
        }
        if (this.media.canvas) {
            this.media.canvas.remove();
            this.media.canvas = null;
        }
        try {
            this.media.ro?.disconnect();
        } catch {}
        this.media.ro = null;
        if (this.media.img) {
            this.media.img.remove();
            this.media.img = null;
        }
        this.media.mode = "none";
        this.media.currentSrc = null;
        this.media.crop = null;
    }

    async __capturePausedPoster() {
        try {
            const v = this.media?.video;
            if (!v || !v.isConnected) return null;
            if (v.readyState < 2) return null;
            const srcW =
                Math.max(
                    2,
                    v.videoWidth || Math.round(this.state.width) || 0,
                ) || 0;
            const srcH =
                Math.max(
                    2,
                    v.videoHeight || Math.round(this.state.height) || 0,
                ) || 0;
            if (!srcW || !srcH) return null;
            let drawW = srcW;
            let drawH = srcH;
            const MAX_DIM = 960;
            if (drawW > MAX_DIM || drawH > MAX_DIM) {
                const scale = Math.min(MAX_DIM / drawW, MAX_DIM / drawH);
                drawW = Math.max(2, Math.round(drawW * scale));
                drawH = Math.max(2, Math.round(drawH * scale));
            }
            const canvas = document.createElement("canvas");
            canvas.width = drawW;
            canvas.height = drawH;
            const ctx = canvas.getContext("2d");
            if (!ctx) return null;
            ctx.drawImage(v, 0, 0, drawW, drawH);
            return canvas.toDataURL("image/webp", 0.85);
        } catch {
            return null;
        }
    }

    __applyPausedPoster() {
        try {
            const poster =
                this.paused && this.pausedPoster ? this.pausedPoster : null;
            const contentEl = this.shadow?.getElementById("contentRoot");
            if (contentEl) {
                if (poster) {
                    contentEl.style.backgroundImage = `url(${poster})`;
                    contentEl.style.backgroundSize = "cover";
                    contentEl.style.backgroundPosition = "center";
                    contentEl.style.backgroundRepeat = "no-repeat";
                    contentEl.style.backgroundColor = "#000";
                } else {
                    contentEl.style.backgroundImage = "";
                    contentEl.style.backgroundSize = "";
                    contentEl.style.backgroundPosition = "";
                    contentEl.style.backgroundRepeat = "";
                    contentEl.style.backgroundColor = "";
                }
            }
            const v = this.media?.video;
            if (v) {
                v.poster = poster || "";
            }
            const img = this.media?.img;
            if (img && poster) {
                img.src = poster;
                this.media.currentSrc = poster;
            }
        } catch {}
    }

    // Toggles paused state and persists poster frames when needed.
    async setPaused(flag, meta = {}) {
        const prev = this.paused;
        this.paused = !!flag;
        try {
            const wrapEl = this.shadow?.querySelector(".wrap");
            if (wrapEl) {
                if (this.paused) wrapEl.classList.add("ov-paused");
                else wrapEl.classList.remove("ov-paused");
            }
        } catch {}
        const v = this.media?.video;
        if (v) {
            try {
                if (this.paused) v.pause();
                else {
                    const p = v.play?.();
                    if (p && typeof p.catch === "function") p.catch(() => {});
                }
            } catch {}
        }
        if (this.paused) {
            if (meta && typeof meta.poster === "string" && meta.poster) {
                this.pausedPoster = meta.poster;
            } else {
                const captured = await this.__capturePausedPoster();
                if (this.paused && captured) this.pausedPoster = captured;
            }
            if (!this.paused) {
                this.pausedPoster = null;
            }
        } else {
            this.pausedPoster = null;
        }
        this.__applyPausedPoster();
        if (prev !== this.paused && typeof this.onPauseChanged === "function") {
            try {
                this.onPauseChanged({
                    paused: this.paused,
                    poster:
                        this.paused && this.pausedPoster
                            ? this.pausedPoster
                            : undefined,
                });
            } catch {}
        }
        return this.paused;
    }
    isPaused() {
        return !!this.paused;
    }

    __resizeCanvasToHost() {
        const host = this.media.host;
        const c = this.media.canvas;
        if (!host || !c) return;
        const r = host.getBoundingClientRect();
        const w = Math.max(1, Math.floor(r.width));
        const h = Math.max(1, Math.floor(r.height));
        if (c.width !== w || c.height !== h) {
            c.width = w;
            c.height = h;
        }
    }
    __startCanvasLoop(mirror = false) {
        if (this.media.raf) cancelAnimationFrame(this.media.raf);
        const step = () => {
            this.media.raf = requestAnimationFrame(step);
            const v = this.media.video,
                c = this.media.canvas;
            if (!v || !c) return;
            const ctx = c.getContext("2d");
            const sw = v.videoWidth || 0;
            const sh = v.videoHeight || 0;
            if (!sw || !sh) return;
            const crop = this.media.crop || {
                srcW: sw,
                srcH: sh,
                region: { x: 0, y: 0, w: sw, h: sh },
            };
            const { x, y, w, h } = crop.region;
            ctx.save();
            ctx.clearRect(0, 0, c.width, c.height);
            if (mirror) {
                ctx.translate(c.width, 0);
                ctx.scale(-1, 1);
            }
            ctx.drawImage(v, x, y, w, h, 0, 0, c.width, c.height);
            ctx.restore();
        };
        this.media.raf = requestAnimationFrame(step);
    }

    // Persists crop metadata so the canvas draw loop can honor it.
    setVideoCrop(srcW, srcH, region) {
        const r = region || { x: 0, y: 0, w: srcW, h: srcH };
        const rx = Math.max(0, Math.min(srcW, r.x | 0));
        const ry = Math.max(0, Math.min(srcH, r.y | 0));
        const rw = Math.max(1, Math.min(srcW - rx, r.w | 0));
        const rh = Math.max(1, Math.min(srcH - ry, r.h | 0));
        this.media.crop = {
            srcW,
            srcH,
            region: { x: rx, y: ry, w: rw, h: rh },
        };
    }
}
