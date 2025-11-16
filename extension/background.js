// Handles session routing and capture orchestration.
const SESSIONS_KEY = "__peek_sessions__";
const OPTIONS_KEY = "__peek_ui_options__";
const GEOM_KEY = "__peek_overlay_geom__";
const STATE_KEY_PREFIX = "__peek_overlay_state__::";

// Tracks transient reload and restore flags per session.
const sessionRuntimeState = new Map();
const recentSessionOrder = [];
const DEFAULT_THEME = {
    shadowColor: "#000000",
    radius: 2,
    borderWidth: 0,
    opacity: 0.1,
};

function getDefaultTheme() {
    return { ...DEFAULT_THEME };
}

// Route messages between popup, content, and offscreen contexts.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg?.type) return;

    let isAsync = false;

    switch (msg.type) {
        case "PREPARE_OFFSCREEN":
            setupOffscreenDocument();
            break;

        case "START_CAPTURE_ON_SOURCE":
            handleStartCapture(msg.payload.sourceTab)
                .then((sessionId) => sendResponse({ sessionId }))
                .catch((e) => console.error(e));
            isAsync = true;
            break;

        case "ASSOCIATE_SOURCE_OVERLAY":
            handleAssociateSourceOverlay(msg.payload);
            break;

        case "CREATE_OUTPUT_FOR_SESSION":
            handleCreateOutput(msg.payload);
            break;

        case "STOP_SESSION":
            handleStopSession(msg.payload.sessionId);
            break;

        case "CLOSE_OUTPUT": {
            const tabIdFromSender = sender?.tab?.id;
            const payload = {
                ...(msg.payload || {}),
                tabId: msg.payload?.tabId ?? tabIdFromSender,
            };
            handleCloseOutput(payload);
            break;
        }

        case "REQUEST_RECONNECT":
            handleReconnect(msg.payload, sender.tab);
            break;

        case "REQUEST_OFFER":
            console.log(
                `[BACKGROUND] Received REQUEST_OFFER. Relaying to offscreen for session: ${msg.payload.sessionId}`,
            );
            chrome.runtime.sendMessage({
                target: "offscreen",
                type: "new-output-added",
                sessionId: msg.payload.sessionId,
                tabId: sender?.tab?.id,
            });
            try {
                sendResponse({ ok: true });
            } catch {}
            break;

        case "OUTPUT_TAB_BOOT":
            if (sender?.tab?.id) {
                earlyRestoreIfOutput(sender.tab.id);
            }
            break;

        case "UPDATE_CROP_GEOMETRY":
            chrome.runtime.sendMessage({
                target: "offscreen",
                type: "SET_VIDEO_CROP",
                payload: msg.payload,
            });
            try {
                sendResponse({ ok: true });
            } catch {}
            break;

        case "OFFER_GENERATED":
        case "ICE_FROM_SOURCE":
        case "CROP_AR":
            console.log(
                `[BACKGROUND] Received ${msg.type} from offscreen. session: ${msg.payload.sessionId}, tabId: ${msg.payload?.tabId}`,
            );
            if (msg.payload?.tabId) {
                const tid = msg.payload.tabId;
                chrome.tabs.sendMessage(tid, msg).catch(() => {});
            } else {
                relayToOutputs(msg);
            }
            break;

        case "ANSWER":
        case "ICE_FROM_OUTPUT":
            if (msg.type === "STOP_STREAMING") {
                chrome.runtime.sendMessage({ target: "offscreen", ...msg });
                break;
            }
            chrome.runtime.sendMessage({
                target: "offscreen",
                ...msg,
                payload: {
                    ...(msg.payload || {}),
                    sessionId: msg.payload?.sessionId,
                    tabId: sender?.tab?.id,
                },
            });

            break;

        case "BROADCAST_THEME":
            broadcastThemeToAll(msg.payload);
            break;

        case "BROADCAST_SESSION_THEME": {
            const { sessionId, options } = msg.payload || {};
            if (sessionId && options) {
                broadcastThemeToSession(sessionId, options);
            }
            break;
        }

        case "REQUEST_CROP_AR": {
            const { sessionId } = msg.payload || {};
            if (sessionId) {
                chrome.runtime.sendMessage({
                    target: "offscreen",
                    type: "REQUEST_CROP_AR",
                    sessionId,
                });
            }
            break;
        }

        case "REQUEST_OUTPUT_COUNT": {
            (async () => {
                try {
                    const sid = msg.payload?.sessionId;
                    const tabId = sender?.tab?.id;
                    if (!sid || !tabId) return;
                    const data = await chrome.storage.local.get(SESSIONS_KEY);
                    const s = data[SESSIONS_KEY]?.[sid];
                    if (!s) return;
                    let cnt = 0;
                    for (const tid of Object.keys(s.outputs || {})) {
                        const v = s.outputs[tid];
                        cnt += Array.isArray(v)
                            ? v.length
                            : v?.overlayId
                            ? 1
                            : 0;
                    }
                    await chrome.tabs.sendMessage(tabId, {
                        type: "OUTPUTS_UPDATED",
                        payload: { sessionId: sid, count: cnt },
                    });
                } catch {}
            })();
            break;
        }

        case "FOCUS_SOURCE_TAB": {
            (async () => {
                try {
                    const { sessionId } = msg.payload || {};
                    if (!sessionId) return;
                    const data = await chrome.storage.local.get(SESSIONS_KEY);
                    const s = data[SESSIONS_KEY]?.[sessionId];
                    const tabId = s?.sourceTabId;
                    if (!tabId) return;
                    const tab = await chrome.tabs.get(tabId);
                    try {
                        await chrome.windows.update(tab.windowId, {
                            focused: true,
                        });
                    } catch {}
                    await chrome.tabs.update(tabId, { active: true });
                } catch {}
            })();
            break;
        }

        case "VERIFY_OUTPUT_VALID": {
            isAsync = true;
            (async () => {
                try {
                    const { sessionId, overlayId } = msg.payload || {};
                    const tabId = sender?.tab?.id;
                    if (!sessionId || !overlayId || !tabId) {
                        sendResponse({ valid: false });
                        return;
                    }
                    const data = await chrome.storage.local.get(SESSIONS_KEY);
                    const s = data[SESSIONS_KEY]?.[sessionId];
                    let valid = false;
                    if (s && s.outputs?.[tabId]) {
                        const __val = s.outputs[tabId];
                        if (Array.isArray(__val)) {
                            valid = __val.includes(overlayId);
                        } else {
                            valid = __val?.overlayId === overlayId;
                        }
                    }
                    sendResponse({ valid });
                } catch {
                    try {
                        sendResponse({ valid: false });
                    } catch {}
                }
            })();
            break;
        }
    }

    return isAsync;
});

async function safeSendToTab(tabId, message) {
    try {
        await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
        const msg = String(e?.message || "").toLowerCase();
        if (msg.includes("receiving end")) {
            try {
                await chrome.scripting.executeScript({
                    target: { tabId },
                    files: ["content.js"],
                });
                await chrome.tabs.sendMessage(tabId, message);
            } catch {}
        }
    }
}

async function computeSessionOutputCount(session) {
    try {
        let cnt = 0;
        for (const tid of Object.keys(session?.outputs || {})) {
            const v = session.outputs[tid];
            cnt += Array.isArray(v) ? v.length : v?.overlayId ? 1 : 0;
        }
        return cnt;
    } catch {
        return 0;
    }
}

async function pushOutputCountToSource(sessionId) {
    try {
        const data = await chrome.storage.local.get(SESSIONS_KEY);
        const s = data[SESSIONS_KEY]?.[sessionId];
        if (!s?.sourceTabId) return;
        const cnt = await computeSessionOutputCount(s);
        await safeSendToTab(s.sourceTabId, {
            type: "OUTPUTS_UPDATED",
            payload: { sessionId, count: cnt },
        });
    } catch {}
}

async function pushOutputCountToTab(sessionId, tabId) {
    try {
        const data = await chrome.storage.local.get(SESSIONS_KEY);
        const s = data[SESSIONS_KEY]?.[sessionId];
        if (!s || !tabId) return;
        const cnt = await computeSessionOutputCount(s);
        await safeSendToTab(tabId, {
            type: "OUTPUTS_UPDATED",
            payload: { sessionId, count: cnt },
        });
    } catch {}
}

function scheduleAllCountsBroadcast(delayMs = 250) {
    try {
        pushAllCountsToSources();
    } catch {}
    try {
        setTimeout(() => {
            try {
                pushAllCountsToSources();
            } catch {}
        }, delayMs);
    } catch {}

    try {
        pushAllCountsToSources();
    } catch {}
}

async function pushAllCountsToSources() {
    try {
        const data = await chrome.storage.local.get(SESSIONS_KEY);
        const sessions = data[SESSIONS_KEY] || {};
        for (const sid of Object.keys(sessions)) {
            const s = sessions[sid];
            if (!s?.sourceTabId) continue;
            const cnt = await computeSessionOutputCount(s);
            await safeSendToTab(s.sourceTabId, {
                type: "OUTPUTS_UPDATED",
                payload: { sessionId: sid, count: cnt },
            });
        }
    } catch {}
}
async function safeSendToTab(tabId, message) {
    try {
        await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
        const msg = String(e?.message || "").toLowerCase();
        if (msg.includes("receiving end")) {
            try {
                await chrome.scripting.executeScript({
                    target: { tabId },
                    files: ["content.js"],
                });
                await chrome.tabs.sendMessage(tabId, message);
            } catch {}
        }
    }
}

async function broadcastThemeToAll(options) {
    try {
        const data = await chrome.storage.local.get(SESSIONS_KEY);
        const sessions = data[SESSIONS_KEY] || {};
        const tabIds = new Set();
        for (const sid in sessions) {
            const s = sessions[sid];
            if (s?.sourceTabId) tabIds.add(s.sourceTabId);
            if (s?.outputs) {
                for (const tid of Object.keys(s.outputs))
                    tabIds.add(Number(tid));
            }
        }
        for (const id of tabIds) {
            chrome.tabs
                .sendMessage(id, { type: "THEME_UPDATE", payload: options })
                .catch(() => {});
        }
    } catch {}
}

// Starts capture for a tab and registers a new session record.
async function handleStartCapture(sourceTab) {
    await setupOffscreenDocument();
    const sessionId = crypto.randomUUID();
    const data = await chrome.storage.local.get(SESSIONS_KEY);
    const sessions = data[SESSIONS_KEY] || {};
    const tabId = sourceTab.id;
    let nextOrdinal = 1;
    for (const sid in sessions) {
        const s = sessions[sid];
        if (s?.sourceTabId === tabId) {
            const ord =
                typeof s.sourceOrdinal === "number" ? s.sourceOrdinal : 0;
            if (ord >= nextOrdinal) nextOrdinal = ord + 1;
        }
    }
    const newSession = {
        sessionId,
        sourceTabId: sourceTab.id,
        sourceTabTitle: sourceTab.title,
        sourceOrdinal: nextOrdinal,
        sourceOverlayId: null,
        outputs: {},
    };
    let hasExistingForTab = false;
    for (const sid in sessions) {
        if (sessions[sid]?.sourceTabId === tabId) {
            hasExistingForTab = true;
            break;
        }
    }
    sessions[sessionId] = newSession;
    await chrome.storage.local.set({ [SESSIONS_KEY]: sessions });
    recentSessionOrder.push(sessionId);

    if (hasExistingForTab) {
        chrome.runtime.sendMessage({
            target: "offscreen",
            type: "attach-session-to-tab-capture",
            sessionId,
            tabId,
        });
        try {
            scheduleAllCountsBroadcast();
        } catch {}
        return sessionId;
    }

    chrome.tabCapture.getMediaStreamId(
        { targetTabId: sourceTab.id },
        (streamId) => {
            if (chrome.runtime.lastError) {
                console.error(
                    "[BACKGROUND] getMediaStreamId failed:",
                    chrome.runtime.lastError.message,
                );
                return;
            }
            if (!streamId) {
                console.error("[BACKGROUND] empty streamId");
                return;
            }
            chrome.runtime.sendMessage({
                target: "offscreen",
                type: "start-capture",
                sessionId,
                streamId,
                tabId,
            });
            try {
                scheduleAllCountsBroadcast();
            } catch {}
        },
    );
    return sessionId;
}

async function handleRestartCapture(sessionId) {
    const session = sessions[sessionId];
    if (!session) return;

    await setupOffscreenDocument();

    return new Promise((resolve) => {
        chrome.tabCapture.getMediaStreamId(
            { targetTabId: session.sourceTabId },
            (streamId) => {
                if (chrome.runtime.lastError || !streamId) {
                    console.warn(
                        "[BACKGROUND] restartCapture getMediaStreamId failed (or refreshing source):",
                        chrome.runtime.lastError?.message,
                    );
                    resolve(false);
                    return;
                }
                chrome.runtime.sendMessage({
                    target: "offscreen",
                    type: "start-capture",
                    sessionId,
                    streamId,
                });
                resolve(true);
            },
        );
    });
}

async function handleAssociateSourceOverlay(payload) {
    const { sessionId, overlayId } = payload;
    const data = await chrome.storage.local.get(SESSIONS_KEY);
    const sessions = data[SESSIONS_KEY] || {};
    if (sessions[sessionId]) {
        sessions[sessionId].sourceOverlayId = overlayId;
        await chrome.storage.local.set({ [SESSIONS_KEY]: sessions });
        pushAllCountsToSources();
    }
}

// Spawns an output overlay on the requested tab and notifies content.
async function handleCreateOutput(payload) {
    const { sessionId, outputTab, options } = payload;
    const data = await chrome.storage.local.get(SESSIONS_KEY);
    const sessions = data[SESSIONS_KEY] || {};
    const session = sessions[sessionId];
    if (!session) return;

    if (!session.outputs) session.outputs = {};
    const __prev = session.outputs[outputTab.id];
    const list = Array.isArray(__prev)
        ? __prev
        : __prev && __prev.overlayId
        ? [__prev.overlayId]
        : [];
    const newOverlayId = crypto.randomUUID();
    list.push(newOverlayId);
    session.outputs[outputTab.id] = list;
    await chrome.storage.local.set({ [SESSIONS_KEY]: sessions });

    let resolvedOptions = null;
    try {
        if (session?.theme) resolvedOptions = session.theme;
        if (!resolvedOptions) {
            const { [OPTIONS_KEY]: globalOpt } = await chrome.storage.local.get(
                OPTIONS_KEY,
            );
            resolvedOptions = globalOpt || null;
        }
    } catch {}

    const sendMessageToContent = async () => {
        await chrome.tabs.sendMessage(outputTab.id, {
            type: "CREATE_OUTPUT_OVERLAY",
            payload: {
                sessionId: sessionId,
                overlayId: newOverlayId,
                options: resolvedOptions,
            },
        });
    };

    try {
        await sendMessageToContent();
    } catch (e) {
        if (e.message.includes("Receiving end does not exist")) {
            await chrome.scripting.executeScript({
                target: { tabId: outputTab.id },
                files: ["content.js"],
            });
            await sendMessageToContent();
        }
    }

    pushAllCountsToSources();
}

async function earlyRestoreIfOutput(tabId) {
    try {
        const { [SESSIONS_KEY]: sessions = {} } =
            await chrome.storage.local.get(SESSIONS_KEY);
        for (const sid of Object.keys(sessions)) {
            const s = sessions[sid];
            if (s?.outputs && s.outputs[tabId]) {
                let options = s?.theme;
                if (!options) {
                    const __optres = await chrome.storage.local.get(
                        OPTIONS_KEY,
                    );
                    options = __optres?.[OPTIONS_KEY];
                }
                const __val = s.outputs[tabId];
                const __list = Array.isArray(__val)
                    ? __val
                    : [__val?.overlayId].filter(Boolean);
                for (const overlayId of __list) {
                    chrome.tabs
                        .sendMessage(tabId, {
                            type: "CREATE_OUTPUT_OVERLAY",
                            payload: { sessionId: sid, overlayId, options },
                        })
                        .catch(() => {});
                }
                try {
                    const __val = s.outputs[tabId];
                    const __list = Array.isArray(__val) ? __val.slice(1) : [];
                    for (const overlayId2 of __list) {
                        chrome.tabs
                            .sendMessage(tabId, {
                                type: "CREATE_OUTPUT_OVERLAY",
                                payload: {
                                    sessionId: sid,
                                    overlayId: overlayId2,
                                    options,
                                },
                            })
                            .catch(() => {});
                    }
                } catch {}

                chrome.runtime.sendMessage({
                    target: "offscreen",
                    type: "new-output-added",
                    sessionId: sid,
                    tabId,
                });
                break;
            }
        }
    } catch {}
}

// Stops capture and tears down all overlays tied to the session.
async function handleStopSession(sessionId) {
    const data = await chrome.storage.local.get(SESSIONS_KEY);
    const sessions = data[SESSIONS_KEY] || {};
    const session = sessions[sessionId];
    if (!session) return;

    chrome.runtime.sendMessage({
        target: "offscreen",
        type: "stop-capture",
        sessionId,
    });

    for (const tabIdStr in session.outputs) {
        const tabId = parseInt(tabIdStr, 10);
        const __val = session.outputs[tabId];
        const __list = Array.isArray(__val)
            ? __val
            : [__val?.overlayId].filter(Boolean);
        for (const overlayId of __list) {
            chrome.tabs
                .sendMessage(tabId, {
                    type: "PEEK_HIDE",
                    payload: { overlayId },
                })
                .catch(() => {});
            try {
                await hideOverlayIfNeeded(tabId, overlayId);
            } catch {}
        }
    }

    if (session.sourceTabId && session.sourceOverlayId) {
        try {
            await hideOverlayIfNeeded(
                session.sourceTabId,
                session.sourceOverlayId,
            );
        } catch {}
    }

    delete sessions[sessionId];
    await chrome.storage.local.set({ [SESSIONS_KEY]: sessions });
    const recentIdx = recentSessionOrder.indexOf(sessionId);
    if (recentIdx !== -1) recentSessionOrder.splice(recentIdx, 1);

    try {
        const store = await chrome.storage.local.get(GEOM_KEY);
        const all = store?.[GEOM_KEY] || {};
        if (session.sourceOverlayId && all[session.sourceOverlayId]) {
            delete all[session.sourceOverlayId];
        }
        for (const tid of Object.keys(session.outputs || {})) {
            const val = session.outputs[tid];
            const list = Array.isArray(val)
                ? val
                : [val?.overlayId].filter(Boolean);
            for (const ovId of list) {
                if (ovId && all[ovId]) delete all[ovId];
            }
        }
        await chrome.storage.local.set({ [GEOM_KEY]: all });
    } catch {}
    try {
        const keysToRemove = [];
        if (session.sourceOverlayId) {
            keysToRemove.push(`${STATE_KEY_PREFIX}${session.sourceOverlayId}`);
        }
        for (const tid of Object.keys(session.outputs || {})) {
            const val = session.outputs[tid];
            const list = Array.isArray(val)
                ? val
                : [val?.overlayId].filter(Boolean);
            for (const ovId of list) {
                if (ovId) {
                    keysToRemove.push(`${STATE_KEY_PREFIX}${ovId}`);
                }
            }
        }
        if (keysToRemove.length > 0) {
            await chrome.storage.local.remove(keysToRemove);
        }
    } catch {}

    try {
        scheduleAllCountsBroadcast();
    } catch {}
}

async function broadcastThemeToSession(sessionId, options) {
    try {
        const data = await chrome.storage.local.get(SESSIONS_KEY);
        const session = data[SESSIONS_KEY]?.[sessionId];
        if (!session) return;
        const tabIds = new Set();
        if (session.sourceTabId) tabIds.add(session.sourceTabId);
        if (session.outputs) {
            for (const tid of Object.keys(session.outputs)) {
                tabIds.add(Number(tid));
            }
        }
        for (const id of tabIds) {
            chrome.tabs
                .sendMessage(id, {
                    type: "THEME_UPDATE",
                    payload: { ...options, __sessionId: sessionId },
                })
                .catch(() => {});
        }
    } catch {}
}

async function hideOverlayIfNeeded(tabId, overlayId) {
    try {
        await chrome.tabs.sendMessage(tabId, {
            type: "PEEK_HIDE",
            payload: { overlayId },
        });
        return;
    } catch (e) {
        const msg = String(e?.message || "").toLowerCase();
        if (msg.includes("receiving end")) {
            try {
                await chrome.scripting.executeScript({
                    target: { tabId },
                    files: ["content.js"],
                });
                await chrome.tabs.sendMessage(tabId, {
                    type: "PEEK_HIDE",
                    payload: { overlayId },
                });
            } catch {}
        }
    }
}

// Removes a single output overlay and pauses capture if none remain.
async function handleCloseOutput(payload) {
    const { sessionId, tabId, overlayId } = payload;
    const data = await chrome.storage.local.get(SESSIONS_KEY);
    const sessions = data[SESSIONS_KEY] || {};
    const session = sessions[sessionId];
    if (!session || !session.outputs[tabId]) return;

    chrome.tabs
        .sendMessage(tabId, { type: "PEEK_HIDE", payload: { overlayId } })
        .catch(() => {});

    const __val = session.outputs[tabId];
    let __list = Array.isArray(__val)
        ? __val.slice()
        : [__val?.overlayId].filter(Boolean);
    __list = __list.filter((id) => id !== overlayId);
    if (__list.length > 0) {
        session.outputs[tabId] = __list;
    } else {
        delete session.outputs[tabId];
        chrome.runtime.sendMessage({
            target: "offscreen",
            type: "stop-output-peer",
            sessionId,
            tabId,
        });
    }
    await chrome.storage.local.set({ [SESSIONS_KEY]: sessions });

    if (Object.keys(session.outputs).length === 0) {
        chrome.runtime.sendMessage({
            target: "offscreen",
            type: "STOP_STREAMING",
            sessionId,
        });
    }

    pushAllCountsToSources();

    try {
        const store = await chrome.storage.local.get(GEOM_KEY);
        const all = store?.[GEOM_KEY] || {};
        if (overlayId && all[overlayId]) {
            delete all[overlayId];
            await chrome.storage.local.set({ [GEOM_KEY]: all });
        }
    } catch {}
    try {
        if (overlayId) {
            await chrome.storage.local.remove(
                `${STATE_KEY_PREFIX}${overlayId}`,
            );
        }
    } catch {}
}

async function relayToOutputs(message) {
    const { sessionId } = message.payload || {};
    if (!sessionId) return;

    const data = await chrome.storage.local.get(SESSIONS_KEY);
    const session = data[SESSIONS_KEY]?.[sessionId];
    if (!session || !session.outputs) return;

    for (const tabIdStr in session.outputs) {
        const tabId = parseInt(tabIdStr, 10);
        console.log(
            `[BACKGROUND] Relaying '${message.type}' to tabId: ${tabId}`,
        );
        chrome.tabs.sendMessage(tabId, message).catch(() => {});
    }
}

// Rehydrates overlays when a tab returns from BFCache or reload.
async function handleReconnect(payload, tab) {
    if (!tab?.id) return;
    const { sessionId } = payload;
    const data = await chrome.storage.local.get(SESSIONS_KEY);
    const sessions = data[SESSIONS_KEY] || {};
    const session = sessions[sessionId];

    if (session && session.outputs[tab.id]) {
        console.log(
            `[BACKGROUND] Reconnecting output on tab ${tab.id} for session ${sessionId} (bfcache restore).`,
        );
        let options = session?.theme;
        if (!options) {
            const __optres = await chrome.storage.local.get(OPTIONS_KEY);
            options = __optres?.[OPTIONS_KEY];
        }
        const outputInfo = session.outputs[tab.id];

        try {
            const __val = session.outputs[tab.id];
            const __list = Array.isArray(__val)
                ? __val
                : [__val?.overlayId].filter(Boolean);
            for (const overlayId of __list) {
                chrome.tabs
                    .sendMessage(tab.id, {
                        type: "CREATE_OUTPUT_OVERLAY",
                        payload: {
                            sessionId: sessionId,
                            overlayId,
                            options: options,
                        },
                    })
                    .catch(() => {});
            }
        } catch {}
        try {
            const __val = sessionForTab.outputs[tabId];
            const __list = Array.isArray(__val) ? __val.slice(1) : [];
            for (const overlayId of __list) {
                chrome.tabs
                    .sendMessage(tabId, {
                        type: "CREATE_OUTPUT_OVERLAY",
                        payload: {
                            sessionId: sessionIdForTab,
                            overlayId,
                            options,
                        },
                    })
                    .catch(() => {});
            }
        } catch {}
    }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
    const data = await chrome.storage.local.get(SESSIONS_KEY);
    const sessions = data[SESSIONS_KEY] || {};

    for (const sessionId in sessions) {
        const session = sessions[sessionId];
        if (session.sourceTabId === tabId) {
            console.log(
                `[BACKGROUND] Source tab ${tabId} closed. Stopping session ${sessionId}.`,
            );
            await handleStopSession(sessionId);
            return;
        }
    }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
    const data = await chrome.storage.local.get(SESSIONS_KEY);
    const sessions = data[SESSIONS_KEY] || {};
    let sessionForTab = null;
    let sessionIdForTab = null;

    for (const sessionId in sessions) {
        if (
            sessions[sessionId].sourceTabId === tabId ||
            sessions[sessionId].outputs[tabId]
        ) {
            sessionForTab = sessions[sessionId];
            sessionIdForTab = sessionId;
            break;
        }
    }

    if (!sessionForTab) return;

    if (sessionForTab.sourceTabId === tabId) {
        const st = sessionRuntimeState.get(sessionIdForTab) || {};
        if (changeInfo.status === "loading" && !changeInfo.url) {
            sessionRuntimeState.set(sessionIdForTab, {
                ...st,
                reloading: true,
            });
        }
        if (changeInfo.status === "loading" && changeInfo.url) {
            try {
                console.log(
                    `[BACKGROUND] Source tab ${tabId} started navigation to ${changeInfo.url} → stopping session ${sessionIdForTab}.`,
                );
            } catch {}
            await handleStopSession(sessionIdForTab);
            return;
        }
        if (changeInfo.status === "complete") {
            const cur = sessionRuntimeState.get(sessionIdForTab) || {};
            if (cur.reloading) {
                await restoreSourceAfterReload(sessionIdForTab);
                sessionRuntimeState.set(sessionIdForTab, {
                    reloading: false,
                    restoring: false,
                });
                return;
            }
            if (changeInfo.url) {
                console.log(
                    `[BACKGROUND] Source tab ${tabId} navigated (not reload) → stop session ${sessionIdForTab}`,
                );
                await handleStopSession(sessionIdForTab);
                return;
            }
        }
    }

    if (
        sessionForTab.outputs[tabId] &&
        (changeInfo.status === "loading" || changeInfo.status === "complete")
    ) {
        console.log(
            `[BACKGROUND] Output tab ${tabId} ${changeInfo.status}. Restoring overlay.`,
        );
        let options = sessionForTab?.theme;
        if (!options) {
            const __optres = await chrome.storage.local.get(OPTIONS_KEY);
            options = __optres?.[OPTIONS_KEY];
        }
        const outputInfo = sessionForTab.outputs[tabId];
        chrome.tabs
            .sendMessage(tabId, {
                type: "CREATE_OUTPUT_OVERLAY",
                payload: {
                    sessionId: sessionIdForTab,
                    overlayId: outputInfo.overlayId,
                    options,
                },
            })
            .catch(() => {});
        try {
            const __val = sessionForTab.outputs[tabId];
            const __list = Array.isArray(__val) ? __val.slice(1) : [];
            for (const overlayId of __list) {
                chrome.tabs
                    .sendMessage(tabId, {
                        type: "CREATE_OUTPUT_OVERLAY",
                        payload: {
                            sessionId: sessionIdForTab,
                            overlayId,
                            options,
                        },
                    })
                    .catch(() => {});
            }
        } catch {}
        chrome.runtime.sendMessage({
            target: "offscreen",
            type: "new-output-added",
            sessionId: sessionIdForTab,
            tabId,
        });
    }
});

try {
    if (chrome.webNavigation?.onCommitted) {
        chrome.webNavigation.onCommitted.addListener(async (details) => {
            if (details.frameId !== 0) return;
            const tabId = details.tabId;
            const data = await chrome.storage.local.get(SESSIONS_KEY);
            const sessions = data[SESSIONS_KEY] || {};
            for (const sid in sessions) {
                if (sessions[sid].sourceTabId === tabId) {
                    if (details.transitionType === "reload") {
                        console.log(
                            `[BACKGROUND] webNavigation reload detected on source tab ${tabId} for session ${sid}.`,
                        );
                        sessionRuntimeState.set(sid, { reloading: true });
                    } else {
                        console.log(
                            `[BACKGROUND] navigation on source tab ${tabId} (type=${details.transitionType}) → stop session ${sid}.`,
                        );
                        await handleStopSession(sid);
                    }
                    break;
                }
            }
        });
    }
} catch {}

async function restoreSourceAfterReload(sessionId) {
    const state = sessionRuntimeState.get(sessionId) || {};
    if (state.restoringPromise) {
        try {
            await state.restoringPromise;
        } catch {}
        return;
    }
    let resolvePromise;
    let rejectPromise;
    const pending = new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    sessionRuntimeState.set(sessionId, {
        ...state,
        restoring: true,
        restoringPromise: pending,
    });

    const data = await chrome.storage.local.get([
        SESSIONS_KEY,
        "__peek_overlay_geom__",
        OPTIONS_KEY,
    ]);
    const sessions = data[SESSIONS_KEY] || {};
    const session = sessions[sessionId];
    if (!session) {
        sessionRuntimeState.set(sessionId, {
            reloading: false,
            restoring: false,
        });
        resolvePromise();
        return;
    }
    const sourceTabId = session.sourceTabId;
    let overlayId = session.sourceOverlayId;
    if (!overlayId) {
        overlayId = crypto.randomUUID();
        session.sourceOverlayId = overlayId;
        await chrome.storage.local.set({ [SESSIONS_KEY]: sessions });
    }
    const allGeoms = data["__peek_overlay_geom__"] || {};
    const saved = overlayId ? allGeoms[overlayId] : null;
    const options = session?.theme || data[OPTIONS_KEY] || null;

    async function safeSend(type, payload) {
        try {
            return await chrome.tabs.sendMessage(sourceTabId, {
                type,
                payload,
            });
        } catch (e) {
            const msg = String(e?.message || "").toLowerCase();
            if (msg.includes("receiving end")) {
                try {
                    await chrome.scripting.executeScript({
                        target: { tabId: sourceTabId },
                        files: ["content.js"],
                    });
                } catch {}
                try {
                    return await chrome.tabs.sendMessage(sourceTabId, {
                        type,
                        payload,
                    });
                } catch {}
            }
        }
    }

    try {
        await safeSend("PEEK_SET_KIND", {
            overlayId,
            kind: "source",
            sessionId,
        });
        await safeSend("PEEK_SHOW", { overlayId });
        if (options)
            await safeSend("THEME_UPDATE", {
                ...options,
                __sessionId: sessionId,
            });
        try {
            let cnt = 0;
            for (const tid of Object.keys(session.outputs || {})) {
                const v = session.outputs[tid];
                cnt += Array.isArray(v) ? v.length : v?.overlayId ? 1 : 0;
            }
            await safeSend("OUTPUTS_UPDATED", { sessionId, count: cnt });
        } catch {}
        if (saved && Number.isFinite(saved.x)) {
            await safeSend("RESTORE_SOURCE_GEOM", { overlayId, geom: saved });
        }

        await handleRestartCapture(sessionId);
        chrome.runtime.sendMessage({
            target: "offscreen",
            type: "new-output-added",
            sessionId,
        });
        resolvePromise();
    } catch (err) {
        rejectPromise(err);
        throw err;
    } finally {
        const cur = sessionRuntimeState.get(sessionId) || {};
        delete cur.restoringPromise;
        cur.restoring = false;
        sessionRuntimeState.set(sessionId, cur);
    }
}

async function getActiveTabForShortcuts() {
    const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
    });
    return tab || null;
}

async function startCaptureFromShortcut() {
    try {
        const tab = await getActiveTabForShortcuts();
        if (!tab) return;
        const sessionId = await handleStartCapture(tab);
        if (!sessionId) return;
        const overlayId = crypto.randomUUID();
        await handleAssociateSourceOverlay({ sessionId, overlayId });
        await safeSendToTab(tab.id, {
            type: "PEEK_SET_KIND",
            payload: { overlayId, kind: "source", sessionId },
        });
        await safeSendToTab(tab.id, {
            type: "PEEK_SHOW",
            payload: { overlayId },
        });
        try {
            const [storedOpt, storedSessions] = await Promise.all([
                chrome.storage.local.get(OPTIONS_KEY),
                chrome.storage.local.get(SESSIONS_KEY),
            ]);
            let opt = storedOpt[OPTIONS_KEY];
            if (!opt) opt = getDefaultTheme();
            const sessions = storedSessions[SESSIONS_KEY] || {};
            if (sessions[sessionId]) {
                sessions[sessionId].theme = opt;
                await chrome.storage.local.set({ [SESSIONS_KEY]: sessions });
            }
            await safeSendToTab(tab.id, {
                type: "THEME_UPDATE",
                payload: { ...opt, __sessionId: sessionId },
            });
        } catch {}
    } catch (err) {
        console.warn("[BACKGROUND] startCapture shortcut failed", err);
    }
}

async function getMostRecentSessionRecord() {
    const data = await chrome.storage.local.get(SESSIONS_KEY);
    const sessions = data[SESSIONS_KEY] || {};
    for (let i = recentSessionOrder.length - 1; i >= 0; i--) {
        const sid = recentSessionOrder[i];
        if (sessions[sid]) return { sessionId: sid, session: sessions[sid] };
        recentSessionOrder.splice(i, 1);
    }
    return null;
}

async function addOutputFromShortcut() {
    try {
        const tab = await getActiveTabForShortcuts();
        if (!tab) return;
        const record = await getMostRecentSessionRecord();
        if (!record) return;
        const { sessionId } = record;
        const stored = await chrome.storage.local.get(OPTIONS_KEY);
        const options = stored[OPTIONS_KEY] || getDefaultTheme();
        await handleCreateOutput({
            sessionId,
            outputTab: tab,
            options,
        });
    } catch (err) {
        console.warn("[BACKGROUND] addOutput shortcut failed", err);
    }
}

async function setupOffscreenDocument() {
    const existingContexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
    });
    if (existingContexts.length > 0) {
        return;
    }
    await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["USER_MEDIA"],
        justification: "For WebRTC connections.",
    });
}

chrome.storage.onChanged.addListener((changes) => {
    if (changes[OPTIONS_KEY]?.newValue) {
        broadcastThemeToAll(changes[OPTIONS_KEY].newValue);
    }
});

try {
    if (chrome.commands && chrome.commands.onCommand) {
        chrome.commands.onCommand.addListener((command) => {
            if (command === "start-capture-box") {
                startCaptureFromShortcut();
            } else if (command === "add-output-for-latest-box") {
                addOutputFromShortcut();
            }
        });
    }
} catch {}
