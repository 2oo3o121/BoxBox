(function () {
    const BOOT_FLAG = "__peek_content_initialized__";
    try {
        if (window[BOOT_FLAG]) return;
        window[BOOT_FLAG] = true;
    } catch {}
    (() => {
        // Injected into tabs to render overlays and relay RTC messages.
        const OPTIONS_KEY = "__peek_ui_options__";
        const GEOM_KEY = "__peek_overlay_geom__";
        const STATE_KEY_PREFIX = "__peek_overlay_state__::";
        const BOOT_PING_SENT = "__peek_boot_ping_sent__";

        const peerConnections = new Map(); // sessionId -> RTCPeerConnection
        const overlayMap = new Map(); // overlayId -> Overlay instance
        const pendingIceBySession = new Map(); // sessionId -> ICE candidates queued before remote desc
        const offerIdBySession = new Map(); // sessionId -> offer id for deduping
        const streamBySession = new Map(); // sessionId -> MediaStream

        let OverlayClass = null;
        const overlayImportPromise = import(
            chrome.runtime.getURL("overlay.js")
        ).then((mod) => {
            OverlayClass = mod.default;
        });

        try {
            const link = document.createElement("link");
            link.rel = "modulepreload";
            link.href = chrome.runtime.getURL("overlay.js");
            document.documentElement.firstElementChild?.appendChild(link);
        } catch {}

        const lastCountBySession = new Map();
        const countTimerBySession = new Map();

        // Defer handling until overlay module is ready.
        chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
            if (!OverlayClass) {
                overlayImportPromise.then(() => handleMessage(msg));
                return;
            }
            handleMessage(msg);
        });

        try {
            if (!window[BOOT_PING_SENT]) {
                window[BOOT_PING_SENT] = true;
                chrome.runtime
                    .sendMessage({ type: "OUTPUT_TAB_BOOT" })
                    .catch(() => {});
            }
        } catch {}

        // Routes runtime messages to overlay helpers.
        function handleMessage(msg) {
            if (!msg?.type) return;

            switch (msg.type) {
                case "PEEK_SET_KIND":
                case "PEEK_SHOW":
                case "PEEK_HIDE":
                case "THEME_UPDATE":
                    handleOverlayCommands(msg);
                    break;

                case "CREATE_OUTPUT_OVERLAY":
                    handleCreateOutputOverlay(msg.payload);
                    break;

                case "OFFER_GENERATED":
                    handleRtcOffer(msg.payload);
                    break;

                case "CROP_AR":
                    const { sessionId, w, h } = msg.payload || {};
                    if (!sessionId || !w || !h) break;
                    for (const ov of overlayMap.values()) {
                        if (
                            ov.kind === "output" &&
                            ov.root?.dataset?.peekSessionId === sessionId &&
                            typeof ov.isPaused === "function" &&
                            !ov.isPaused()
                        ) {
                            ov.updateAspectLock(w / Math.max(1, h));
                        }
                    }
                    break;

                case "OUTPUTS_UPDATED": {
                    const { sessionId, count } = msg.payload || {};
                    if (!sessionId) break;
                    const applyCount = (cnt) => {
                        if (cnt === 0) {
                            if (countTimerBySession.has(sessionId))
                                clearTimeout(
                                    countTimerBySession.get(sessionId),
                                );
                            const t = setTimeout(() => {
                                lastCountBySession.set(sessionId, 0);
                                for (const ov of overlayMap.values()) {
                                    if (
                                        ov.kind === "source" &&
                                        ov.root?.dataset?.peekSessionId ===
                                            sessionId &&
                                        typeof ov.setLeftBadge === "function"
                                    ) {
                                        ov.setLeftBadge("0");
                                    }
                                }
                                countTimerBySession.delete(sessionId);
                            }, 200);
                            countTimerBySession.set(sessionId, t);
                        } else {
                            if (countTimerBySession.has(sessionId)) {
                                clearTimeout(
                                    countTimerBySession.get(sessionId),
                                );
                                countTimerBySession.delete(sessionId);
                            }
                            lastCountBySession.set(sessionId, cnt);
                            for (const ov of overlayMap.values()) {
                                if (
                                    ov.kind === "source" &&
                                    ov.root?.dataset?.peekSessionId ===
                                        sessionId &&
                                    typeof ov.setLeftBadge === "function"
                                ) {
                                    ov.setLeftBadge(String(cnt));
                                }
                            }
                        }
                    };
                    if (typeof count === "number") {
                        applyCount(count);
                        break;
                    }
                    chrome.storage.local
                        .get("__peek_sessions__")
                        .then((res) => {
                            const s = res?.["__peek_sessions__"]?.[sessionId];
                            let cnt = 0;
                            try {
                                for (const tid of Object.keys(
                                    s?.outputs || {},
                                )) {
                                    const v = s.outputs[tid];
                                    cnt += Array.isArray(v)
                                        ? v.length
                                        : v?.overlayId
                                        ? 1
                                        : 0;
                                }
                            } catch {}
                            applyCount(cnt);
                        })
                        .catch(() => {});
                    break;
                }

                case "ICE_FROM_SOURCE":
                    {
                        const { sessionId, candidate } = msg.payload || {};
                        const pc = peerConnections.get(sessionId);
                        if (!pc) return;
                        if (!pc.remoteDescription) {
                            if (!pendingIceBySession.has(sessionId))
                                pendingIceBySession.set(sessionId, []);
                            pendingIceBySession.get(sessionId).push(candidate);
                        } else {
                            pc.addIceCandidate(candidate).catch((err) => {
                                console.warn(
                                    "[CONTENT] addIceCandidate failed (post-remoteDesc):",
                                    err?.message,
                                );
                            });
                        }
                    }
                    break;

                case "RESTORE_SOURCE_GEOM": {
                    const { overlayId, geom } = msg.payload || {};
                    if (!overlayId || !geom) break;
                    let ov = overlayMap.get(overlayId);
                    if (!ov) {
                        ov = new OverlayClass(overlayId, "source");
                        overlayMap.set(overlayId, ov);
                        ov.ensure();
                    }
                    ov.__suppressPersist = true;
                    ov.setGeom(geom.x, geom.y, geom.width, geom.height);
                    break;
                }
            }
        }

        const geomCache = new Map();
        const geomSaveTimers = new Map();
        const pendingGeoms = new Map();
        let geomLoadPromise = null;
        let geomCacheLoaded = false;
        let geomFlushListenersBound = false;
        function ensureGeomCache() {
            if (geomCacheLoaded) return Promise.resolve();
            if (geomLoadPromise) return geomLoadPromise;
            geomLoadPromise = chrome.storage.local
                .get(GEOM_KEY)
                .then((res) => {
                    geomCache.clear();
                    try {
                        const map = res?.[GEOM_KEY] || {};
                        for (const [key, value] of Object.entries(map)) {
                            geomCache.set(key, value);
                        }
                    } catch {}
                })
                .catch(() => {})
                .finally(() => {
                    geomCacheLoaded = true;
                    geomLoadPromise = null;
                });
            return geomLoadPromise;
        }
        function normalizeGeomInput(g) {
            if (
                !g ||
                !Number.isFinite(g.x) ||
                !Number.isFinite(g.y) ||
                !Number.isFinite(g.width) ||
                !Number.isFinite(g.height)
            )
                return null;
            return {
                x: Math.round(g.x),
                y: Math.round(g.y),
                width: Math.max(1, Math.round(g.width)),
                height: Math.max(1, Math.round(g.height)),
            };
        }
        async function flushGeomCacheForOverlay(overlayId, geom) {
            await ensureGeomCache();
            const next =
                normalizeGeomInput(geom) ||
                pendingGeoms.get(overlayId) ||
                geomCache.get(overlayId);
            if (next) geomCache.set(overlayId, next);
            else geomCache.delete(overlayId);
            const payload = Object.fromEntries(geomCache.entries());
            try {
                await chrome.storage.local.set({ [GEOM_KEY]: payload });
            } catch {}
        }
        function ensureGeomFlushListeners() {
            if (geomFlushListenersBound) return;
            const handler = () => flushAllScheduledGeoms(true);
            window.addEventListener("mouseup", handler);
            window.addEventListener("touchend", handler, { passive: true });
            window.addEventListener("blur", handler);
            geomFlushListenersBound = true;
        }
        function flushAllScheduledGeoms(immediate = false) {
            if (!geomSaveTimers.size) return;
            for (const [overlayId] of Array.from(geomSaveTimers.entries())) {
                scheduleGeomSave(
                    overlayId,
                    pendingGeoms.get(overlayId),
                    immediate,
                );
            }
        }
        function scheduleGeomSave(overlayId, geom, immediate = false) {
            ensureGeomFlushListeners();
            const normalized =
                normalizeGeomInput(geom) ||
                pendingGeoms.get(overlayId) ||
                geomCache.get(overlayId);
            if (normalized) pendingGeoms.set(overlayId, normalized);
            else pendingGeoms.delete(overlayId);
            const perform = () => {
                geomSaveTimers.delete(overlayId);
                const latest = pendingGeoms.get(overlayId);
                pendingGeoms.delete(overlayId);
                flushGeomCacheForOverlay(overlayId, latest);
            };
            clearTimeout(geomSaveTimers.get(overlayId));
            if (immediate) {
                perform();
                return;
            }
            const id = setTimeout(perform, 100);
            geomSaveTimers.set(overlayId, id);
        }
        async function deleteGeom(overlayId) {
            const timer = geomSaveTimers.get(overlayId);
            if (timer) {
                clearTimeout(timer);
                geomSaveTimers.delete(overlayId);
            }
            pendingGeoms.delete(overlayId);
            await flushGeomCacheForOverlay(overlayId, null);
        }

        const stateWriteQueue = new Map();
        function enqueueStateWrite(overlayId, task) {
            const prev = stateWriteQueue.get(overlayId) || Promise.resolve();
            const next = prev
                .catch(() => {})
                .then(task)
                .catch(() => {});
            stateWriteQueue.set(overlayId, next);
            next.finally(() => {
                if (stateWriteQueue.get(overlayId) === next) {
                    stateWriteQueue.delete(overlayId);
                }
            });
        }
        function saveState(overlayId, state) {
            const key = `${STATE_KEY_PREFIX}${overlayId}`;
            enqueueStateWrite(overlayId, async () => {
                try {
                    if (state && state.paused) {
                        const payload = { paused: true };
                        if (
                            typeof state.poster === "string" &&
                            state.poster.length > 0
                        ) {
                            payload.poster = state.poster;
                        }
                        await chrome.storage.local.set({
                            [key]: payload,
                        });
                    } else {
                        await chrome.storage.local.remove(key);
                    }
                } catch {}
            });
        }
        async function loadState(overlayId) {
            const key = `${STATE_KEY_PREFIX}${overlayId}`;
            try {
                const res = await chrome.storage.local.get(key);
                return res?.[key] || null;
            } catch {
                return null;
            }
        }
        function deleteState(overlayId) {
            const key = `${STATE_KEY_PREFIX}${overlayId}`;
            enqueueStateWrite(overlayId, async () => {
                try {
                    await chrome.storage.local.remove(key);
                } catch {}
            });
        }

        // Applies a remote offer and responds with an answer per session.
        async function handleRtcOffer(payload) {
            const { sessionId, sdp, srcW, srcH, offerId } = payload || {};
            if (!sessionId) return;
            console.log("[CONTENT] OFFER received", {
                sessionId,
                sdpLen: sdp?.length,
                srcW,
                srcH,
                offerId,
            });
            if (offerId) offerIdBySession.set(sessionId, offerId);

            if (peerConnections.has(sessionId)) {
                peerConnections.get(sessionId).close();
            }
            const pc = new RTCPeerConnection({
                iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
            });
            peerConnections.set(sessionId, pc);

            pc.onicecandidate = (e) => {
                if (e.candidate) {
                    chrome.runtime.sendMessage({
                        type: "ICE_FROM_OUTPUT",
                        payload: {
                            sessionId,
                            candidate: e.candidate,
                            offerId: offerIdBySession.get(sessionId),
                        },
                    });
                }
            };

            pc.ontrack = (e) => {
                console.log(
                    "[CONTENT] ontrack attaching stream",
                    sessionId,
                    "streams=",
                    e.streams?.length,
                );
                const stream = e.streams[0];
                try {
                    streamBySession.set(sessionId, stream);
                } catch {}
                for (const ov of overlayMap.values()) {
                    if (
                        ov.kind === "output" &&
                        ov.root.dataset.peekSessionId === sessionId
                    ) {
                        ov.attachStream(stream, { muted: true });
                    }
                }
            };

            pc.onconnectionstatechange = () => {
                console.log(
                    "[CONTENT] pc.connectionState:",
                    pc.connectionState,
                );
            };

            await pc.setRemoteDescription({ type: "offer", sdp });

            const queued = pendingIceBySession.get(sessionId);
            if (queued?.length) {
                for (const c of queued) {
                    try {
                        await pc.addIceCandidate(c);
                    } catch (err) {
                        console.warn(
                            "[CONTENT] addIceCandidate (from-queue) failed:",
                            err?.message,
                        );
                    }
                }
                pendingIceBySession.delete(sessionId);
            }

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            chrome.runtime
                .sendMessage({
                    type: "ANSWER",
                    payload: {
                        sessionId,
                        sdp: answer.sdp,
                        offerId: offerIdBySession.get(sessionId),
                    },
                })
                .catch(() => {});
        }

        // Ensures an overlay exists for a new output stream.
        function handleCreateOutputOverlay(payload) {
            const { sessionId, overlayId, options } = payload;
            if (!sessionId || !overlayId) return;

            let ov = overlayMap.get(overlayId);
            if (!ov) {
                ov = new OverlayClass(overlayId, "output");
                overlayMap.set(overlayId, ov);
            }

            ov.ensure();
            if (options) {
                ov.applyTheme(options);
            } else {
                chrome.storage.local
                    .get(OPTIONS_KEY)
                    .then((res) => {
                        const opt = res?.[OPTIONS_KEY];
                        if (opt) ov.applyTheme(opt);
                    })
                    .catch(() => {});
            }

            ov.root.dataset.peekSessionId = sessionId;

            if (sessionId) {
                chrome.runtime
                    .sendMessage({
                        type: "REQUEST_CROP_AR",
                        payload: { sessionId },
                    })
                    .catch(() => {});
            }

            let suppressPausePersist = false;
            ov.onPauseChanged = (state) => {
                if (suppressPausePersist) return;
                if (!state || typeof state.paused !== "boolean") return;
                saveState(overlayId, state);
            };
            loadState(overlayId)
                .then(async (st) => {
                    if (!st || typeof st.paused !== "boolean") return;
                    suppressPausePersist = true;
                    try {
                        await ov.setPaused(!!st.paused, {
                            poster:
                                typeof st.poster === "string"
                                    ? st.poster
                                    : undefined,
                        });
                        if (typeof ov.__syncPauseIcon === "function") {
                            ov.__syncPauseIcon(!!st.paused);
                        }
                    } finally {
                        suppressPausePersist = false;
                    }
                })
                .catch(() => {});

            ensureGeomCache()
                .then(() => {
                    const g = geomCache.get(overlayId);
                    if (g && Number.isFinite(g.x)) {
                        ov.setGeom(g.x, g.y, g.width, g.height);
                    }
                })
                .catch(() => {});

            ov.onGeomChanged = (geom) => {
                scheduleGeomSave(overlayId, geom || ov.getGeom());
            };

            if (ov.getContentMode() === "none") {
                ov.showImage(buildDemoSvg());
            }
            try {
                const __existing = streamBySession.get(sessionId);
                const __live = !!(
                    __existing &&
                    __existing.getVideoTracks &&
                    __existing
                        .getVideoTracks()
                        .some((t) => t && t.readyState === "live")
                );
                if (__live) {
                    ov.attachStream(__existing, { muted: true });
                    return;
                } else if (__existing) {
                    streamBySession.delete(sessionId);
                }
            } catch {}
            console.log(
                `[CONTENT] Output overlay created. Requesting Offer for session: ${sessionId}`,
            );
            chrome.runtime
                .sendMessage({ type: "REQUEST_OFFER", payload: { sessionId } })
                .catch(() => {});
        }

        // Handles per-overlay show, hide, and theme updates.
        function handleOverlayCommands(msg) {
            const { overlayId, kind, sessionId } = msg.payload || {};

            if (msg.type === "PEEK_SHOW") {
                if (!overlayId) return;
                let ov = overlayMap.get(overlayId);
                if (!ov) {
                    ov = new OverlayClass(overlayId, kind || "source");
                    overlayMap.set(overlayId, ov);
                }
                ov.ensure();
                chrome.storage.local
                    .get(OPTIONS_KEY)
                    .then((res) => {
                        const opt = res?.[OPTIONS_KEY];
                        if (opt) ov.applyTheme(opt);
                    })
                    .catch(() => {});
            }

            if (msg.type === "PEEK_SET_KIND") {
                if (!overlayId || !kind) return;
                let ov = overlayMap.get(overlayId);
                if (!ov) {
                    ov = new OverlayClass(overlayId, kind);
                    overlayMap.set(overlayId, ov);
                } else {
                    ov.setKind(kind);
                }
                console.log(`[CONTENT] PEEK_SET_KIND received:`, {
                    kind,
                    sessionId,
                });

                ov.ensure();

                if (kind === "source" && sessionId) {
                    try {
                        ensureGeomCache()
                            .then(() => {
                                const g = geomCache.get(overlayId);
                                if (g && Number.isFinite(g.x)) {
                                    ov.setGeom(g.x, g.y, g.width, g.height);
                                }
                            })
                            .catch(() => {});
                    } catch {}
                    if (ov.root) ov.root.dataset.peekSessionId = sessionId;
                    const cropScheduler =
                        ov.__cropScheduler ||
                        (() => {
                            const state = {
                                frame: 0,
                                pending: null,
                                lastSent: null,
                            };
                            const flush = () => {
                                state.frame = 0;
                                const next = state.pending;
                                if (!next) return;
                                state.pending = null;
                                const prev = state.lastSent;
                                const same =
                                    prev &&
                                    prev.x === next.geom.x &&
                                    prev.y === next.geom.y &&
                                    prev.width === next.geom.width &&
                                    prev.height === next.geom.height;
                                if (same) return;
                                state.lastSent = next.geom;
                                chrome.runtime
                                    .sendMessage({
                                        type: "UPDATE_CROP_GEOMETRY",
                                        payload: next,
                                    })
                                    .catch(() => {});
                            };
                            const request = () => {
                                if (state.frame) return;
                                state.frame = requestAnimationFrame(flush);
                            };
                            return {
                                queue(geomPayload) {
                                    state.pending = geomPayload;
                                    request();
                                },
                                flushNow() {
                                    if (state.frame) {
                                        cancelAnimationFrame(state.frame);
                                        state.frame = 0;
                                    }
                                    flush();
                                },
                            };
                        })();
                    ov.__cropScheduler = cropScheduler;
                    const computeCropPayload = () => {
                        const host = ov.root;
                        if (!host) return null;
                        const r = host.getBoundingClientRect();
                        const vv = window.visualViewport;
                        const layoutX = r.left + (vv ? vv.offsetLeft : 0);
                        const layoutY = r.top + (vv ? vv.offsetTop : 0);
                        const layoutW = r.width;
                        const layoutH = r.height;
                        const vpW = Math.max(1, window.innerWidth || 0);
                        const vpH = Math.max(1, window.innerHeight || 0);
                        const dpr = window.devicePixelRatio || 1;
                        return {
                            sessionId,
                            geom: {
                                x: layoutX,
                                y: layoutY,
                                width: layoutW,
                                height: layoutH,
                            },
                            viewportWidth: vpW,
                            viewportHeight: vpH,
                            dpr,
                        };
                    };
                    const enqueueCropUpdate = () => {
                        const payload = computeCropPayload();
                        if (!payload) return;
                        cropScheduler.queue(payload);
                    };
                    if (!ov.__peekScrollBinded) {
                        ov.__peekScrollBinded = true;
                        const onScrollOrResize = () => enqueueCropUpdate();
                        const vv = window.visualViewport;
                        window.addEventListener("scroll", onScrollOrResize, {
                            passive: true,
                        });
                        window.addEventListener("resize", onScrollOrResize);
                        if (vv) {
                            vv.addEventListener("resize", onScrollOrResize);
                            vv.addEventListener("scroll", onScrollOrResize, {
                                passive: true,
                            });
                        }
                        ov.onGeomChanged = (geom) => {
                            scheduleGeomSave(overlayId, geom || ov.getGeom());
                            enqueueCropUpdate();
                        };
                    }

                    enqueueCropUpdate();
                    try {
                        chrome.runtime
                            .sendMessage({
                                type: "REQUEST_OUTPUT_COUNT",
                                payload: { sessionId },
                            })
                            .catch(() => {});
                    } catch {}
                }
            }

            if (msg.type === "PEEK_HIDE") {
                if (!overlayId) return;
                const ov = overlayMap.get(overlayId);
                if (ov) {
                    ov.remove();
                    overlayMap.delete(overlayId);
                }
                try {
                    const sid = ov?.root?.dataset?.peekSessionId;
                    if (sid) {
                        let anyLeft = false;
                        for (const o of overlayMap.values()) {
                            if (
                                o.kind === "output" &&
                                o.root?.dataset?.peekSessionId === sid
                            ) {
                                anyLeft = true;
                                break;
                            }
                        }
                        if (!anyLeft) streamBySession.delete(sid);
                    }
                } catch {}
                deleteGeom(overlayId);
                deleteState(overlayId);
            }

            if (msg.type === "THEME_UPDATE") {
                for (const ov of overlayMap.values()) {
                    const __p = msg.payload || {};
                    const __sid = __p.__sessionId || __p.sessionId || null;
                    const __theme = __p.theme || __p;
                    if (
                        !__sid ||
                        ov.root?.dataset?.peekSessionId === String(__sid)
                    ) {
                        ov.applyTheme(__theme);
                    }
                }
            }
        }

        function buildDemoSvg() {
            const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 160 90'>
      <rect width='100%' height='100%' fill='#222'/>
      <text x='50%' y='50%' font-family='system-ui' font-size='8' fill='#eee' text-anchor='middle' dy='.3em'>Waiting for stream...</text>
    </svg>`;
            return `data:image/svg+xml;utf8,` + encodeURIComponent(svg);
        }

        window.addEventListener("beforeunload", () => {
            for (const pc of peerConnections.values()) {
                pc.close();
            }
            peerConnections.clear();
        });

        window.addEventListener("pageshow", (event) => {
            if (event.persisted) {
                console.log("[CONTENT] Page restored from bfcache.");
                for (const [overlayId, ov] of overlayMap.entries()) {
                    if (ov.kind !== "output") continue;
                    const sessionId = ov.root?.dataset?.peekSessionId;
                    if (!sessionId) continue;
                    chrome.runtime
                        .sendMessage({
                            type: "VERIFY_OUTPUT_VALID",
                            payload: { sessionId, overlayId },
                        })
                        .then((res) => {
                            const valid = !!res?.valid;
                            if (!valid) {
                                try {
                                    ov.remove();
                                } catch {}
                                overlayMap.delete(overlayId);
                                console.log(
                                    "[CONTENT] Stale output overlay removed after bfcache restore:",
                                    { overlayId, sessionId },
                                );
                                return;
                            }
                            console.log(
                                `[CONTENT] Requesting reconnect for session ${sessionId}`,
                            );
                            chrome.runtime
                                .sendMessage({
                                    type: "REQUEST_RECONNECT",
                                    payload: { sessionId },
                                })
                                .catch(() => {});
                        })
                        .catch(() => {});
                }
            }
        });
    })();
})();
