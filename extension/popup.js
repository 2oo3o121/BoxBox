// Popup UI for managing sessions and appearance defaults.
const OPTIONS_KEY = "__peek_ui_options__";
const SESSIONS_KEY = "__peek_sessions__";
const DEFAULT_LIGHT_COLOR = "#000000";
const DEFAULT_DARK_COLOR = "#000000";

let cachedGlobalTheme = null;
let colorSchemeMediaQuery = null;
const MAX_NAME_LENGTH = 13;

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

const $ = (s) => document.querySelector(s);

function escapeHtml(str = "") {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function escapeAttr(str = "") {
    return escapeHtml(str).replace(/"/g, "&quot;");
}

function formatDisplayName(name, max = MAX_NAME_LENGTH) {
    if (typeof name !== "string" || !name.length) {
        return { short: "", full: "" };
    }
    const trimmed = name.trim();
    if (trimmed.length <= max) return { short: trimmed, full: trimmed };
    return {
        short: trimmed.slice(0, Math.max(1, max - 1)) + "…",
        full: trimmed,
    };
}

function ensureHexColor(value, fallback = getDefaultShadowColor()) {
    const normalize = (val) => {
        if (typeof val !== "string") return null;
        const trimmed = val.trim();
        if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
        if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
            const [r, g, b] = trimmed.slice(1).split("");
            return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
        }
        return null;
    };
    const normalizedFallback = normalize(fallback) ?? getDefaultShadowColor();
    return normalize(value) ?? normalizedFallback;
}

function snapshotTheme(options) {
    const theme = options || {};
    return {
        shadowColor: ensureHexColor(theme.shadowColor, getDefaultShadowColor()),
        radius: typeof theme.radius === "number" ? theme.radius : 2,
        borderWidth:
            typeof theme.borderWidth === "number" ? theme.borderWidth : 0,
        opacity: typeof theme.opacity === "number" ? theme.opacity : 0.1,
    };
}

function themesEqual(a, b) {
    if (!a || !b) return false;
    return (
        a.shadowColor === b.shadowColor &&
        a.radius === b.radius &&
        a.borderWidth === b.borderWidth &&
        a.opacity === b.opacity
    );
}

async function getActiveTab() {
    const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
    });
    return tab;
}

async function sendTo(tabId, message) {
    try {
        return await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
        const msg = String(e?.message || "").toLowerCase();
        if (msg.includes("receiving end")) {
            try {
                await chrome.scripting.executeScript({
                    target: { tabId },
                    files: ["content.js"],
                });
                return await chrome.tabs.sendMessage(tabId, message);
            } catch (err) {}
        }
    }
}

function buildTheme(color) {
    const shadowColor = ensureHexColor(color);
    return { shadowColor, radius: 2, borderWidth: 0, opacity: 0.1 };
}
async function broadcastSessionTheme(sessionId, theme) {
    if (!sessionId || !theme) return;
    try {
        await chrome.runtime.sendMessage({
            type: "BROADCAST_SESSION_THEME",
            payload: { sessionId, options: theme },
        });
    } catch {}
}
async function persistSessionTheme(sessionId, theme) {
    if (!sessionId || !theme) return;
    const store = await chrome.storage.local.get(SESSIONS_KEY);
    const sessions = store[SESSIONS_KEY] || {};
    const s = sessions[sessionId];
    if (!s) return;
    s.theme = theme;
    await chrome.storage.local.set({ [SESSIONS_KEY]: sessions });
}
// Persists and broadcasts a session-specific overlay theme.
async function setSessionTheme(sessionId, color) {
    const theme = buildTheme(color);
    await persistSessionTheme(sessionId, theme);
    await broadcastSessionTheme(sessionId, theme);
}

// Launches capture on the active tab and prepares its overlay.
async function startCaptureOnSourceTab() {
    const sourceTab = await getActiveTab();
    if (!sourceTab) return;

    const { sessionId } = await chrome.runtime.sendMessage({
        type: "START_CAPTURE_ON_SOURCE",
        payload: { sourceTab },
    });

    const overlayId = crypto.randomUUID();
    chrome.runtime.sendMessage({
        type: "ASSOCIATE_SOURCE_OVERLAY",
        payload: { sessionId, overlayId },
    });

    await sendTo(sourceTab.id, {
        type: "PEEK_SET_KIND",
        payload: { overlayId, kind: "source", sessionId },
    });
    await sendTo(sourceTab.id, { type: "PEEK_SHOW", payload: { overlayId } });

    try {
        await setSessionTheme(sessionId, getDefaultShadowColor());
    } catch {}
}

// Adds an output overlay for the active tab tied to the session.
async function createOutputForSession(sessionId) {
    const outputTab = await getActiveTab();
    if (!outputTab) return;
    const { [OPTIONS_KEY]: options } = await chrome.storage.local.get(
        OPTIONS_KEY,
    );

    chrome.runtime.sendMessage({
        type: "CREATE_OUTPUT_FOR_SESSION",
        payload: { sessionId, outputTab, options },
    });
}

// Closes a single overlay that belongs to this tab.
async function closeOutputOnCurrentTab(sessionId, overlayId) {
    const tab = await getActiveTab();
    if (!tab) return;
    chrome.runtime.sendMessage({
        type: "CLOSE_OUTPUT",
        payload: { sessionId, overlayId, tabId: tab.id },
    });
}

// Stops an entire session from the popup context.
async function stopSession(sessionId) {
    chrome.runtime.sendMessage({
        type: "STOP_SESSION",
        payload: { sessionId },
    });
}

// Applies the global fallback theme used by new overlays.
function onAppearanceChange() {
    const radius = 2;
    const inputEl = $("#shadowColor");
    const shadowColor = ensureHexColor(inputEl?.value);
    const payload = { shadowColor, radius, borderWidth: 0, opacity: 0.1 };
    if (themesEqual(payload, cachedGlobalTheme)) {
        return;
    }
    cachedGlobalTheme = payload;
    chrome.storage.local.set({ [OPTIONS_KEY]: payload });

    getActiveTab().then((tab) => {
        if (tab?.id) sendTo(tab.id, { type: "THEME_UPDATE", payload });
    });
    chrome.runtime.sendMessage({ type: "BROADCAST_THEME", payload });
}

// Renders the session list and per-tab controls.
async function refreshUI() {
    const [store, currentTab, defaults] = await Promise.all([
        chrome.storage.local.get(SESSIONS_KEY),
        getActiveTab(),
        chrome.storage.local.get(OPTIONS_KEY),
    ]);
    const sessions = store[SESSIONS_KEY] || {};
    const defaultColor = ensureHexColor(
        defaults?.[OPTIONS_KEY]?.shadowColor,
        getDefaultShadowColor(),
    );

    const managerDiv = $("#sessionManager");
    const activeSessions = Object.values(sessions);
    const outputsOnCurrentTab = activeSessions
        .map((s) => ({ session: s, raw: s.outputs[currentTab.id] }))
        .filter((x) => !!x.raw)
        .map(({ session, raw }) => ({
            session,
            overlays: Array.isArray(raw)
                ? raw
                : [raw?.overlayId].filter(Boolean),
        }));

    const overlaysBySession = new Map(
        outputsOnCurrentTab.map(({ session, overlays }) => [
            session.sessionId,
            overlays,
        ]),
    );

    const sourceCounts = activeSessions.reduce((acc, session) => {
        const key = session.sourceTabId;
        acc[key] = (acc[key] || 0) + 1;
        return acc;
    }, {});
    const sourceOrdinalBySession = new Map();
    const runningIndex = {};
    activeSessions.forEach((session) => {
        const key = session.sourceTabId;
        if ((sourceCounts[key] || 0) > 1) {
            const idx = (runningIndex[key] || 0) + 1;
            runningIndex[key] = idx;
            sourceOrdinalBySession.set(session.sessionId, idx);
        }
    });

    const parts = [];
    parts.push(`
        <div class="action-bar">
            <button class="btn btn-primary" data-action="start-capture">
                New Capture Box
            </button>
        </div>
    `);

    if (activeSessions.length > 0) {
        const sessionCards = activeSessions
            .map((session) => {
                const ordinalFromMap =
                    sourceOrdinalBySession.get(session.sessionId) || 1;
                const assignedOrdinal =
                    typeof session.sourceOrdinal === "number"
                        ? session.sourceOrdinal
                        : ordinalFromMap;
                const displayName = `${session.sourceTabTitle} ${assignedOrdinal}`;
                const formattedName = formatDisplayName(displayName);
                const overlays = overlaysBySession.get(session.sessionId) || [];
                const overlayButtons = overlays
                    .map(
                        (overlayId, idx) => `
                            <button class="chip" data-action="close-output" data-session-id="${
                                session.sessionId
                            }" data-overlay-id="${overlayId}">
                                Remove ${idx + 1}
                            </button>
                        `,
                    )
                    .join("");
                const cardClass =
                    session.sourceTabId === currentTab.id
                        ? "session-card current-tab"
                        : "session-card";
                const secondaryAction = `<button class="btn btn-muted" data-action="create-output" data-session-id="${session.sessionId}">
                            Add Output
                       </button>`;
                return `
                    <div class="${cardClass}">
                        <div class="session-card__header">
                            <div class="session-card__title">
                                <span class="session-card__name" title="${escapeAttr(
                                    formattedName.full,
                                )}">${escapeHtml(formattedName.short)}</span>
                            </div>
                            <div class="session-card__actions">
                                <button class="btn btn-danger" data-action="stop-session" data-session-id="${
                                    session.sessionId
                                }">
                                    Stop
                                </button>
                                ${secondaryAction}
                                <input type="color" data-action="set-session-color" data-session-id="${
                                    session.sessionId
                                }" value="${ensureHexColor(
                    session.theme?.shadowColor,
                    defaultColor,
                )}" />
                            </div>
                        </div>
                        ${
                            overlays.length > 0
                                ? `<div class="session-card__body">
                                    <div class="overlay-chips">${overlayButtons}</div>
                                </div>`
                                : ""
                        }
                    </div>
                `;
            })
            .join("");
        parts.push(`<div class="session-list">${sessionCards}</div>`);
    }

    managerDiv.innerHTML = parts.join("");
}

// Bootstraps the popup once DOM and storage are ready.
async function init() {
    chrome.runtime.sendMessage({ type: "PREPARE_OFFSCREEN" });

    document.body.addEventListener("click", (e) => {
        const action = e.target.dataset.action;
        const sessionId = e.target.dataset.sessionId;
        const overlayId = e.target.dataset.overlayId;
        if (!action) return;

        if (action === "start-capture") startCaptureOnSourceTab();
        if (action === "create-output") createOutputForSession(sessionId);
        if (action === "stop-session") stopSession(sessionId);
        if (action === "close-output")
            closeOutputOnCurrentTab(sessionId, overlayId);
    });

    document.body.addEventListener("input", (e) => {
        const action = e.target?.dataset?.action;
        if (action === "set-session-color") {
            const sid = e.target.dataset.sessionId;
            const val = ensureHexColor(e.target.value);
            if (sid && val) broadcastSessionTheme(sid, buildTheme(val));
        }
    });
    document.body.addEventListener("change", (e) => {
        const action = e.target?.dataset?.action;
        if (action === "set-session-color") {
            const sid = e.target.dataset.sessionId;
            const val = ensureHexColor(e.target.value);
            if (sid && val) setSessionTheme(sid, val);
        }
    });

    $("#shadowColor").addEventListener("input", onAppearanceChange);

    const { [OPTIONS_KEY]: opt } = await chrome.storage.local.get(OPTIONS_KEY);
    cachedGlobalTheme = snapshotTheme(opt);

    $("#shadowColor").value = cachedGlobalTheme.shadowColor;

    await refreshUI();

    chrome.storage.onChanged.addListener((changes) => {
        if (changes[SESSIONS_KEY]) {
            refreshUI();
        }
    });
}

init();
