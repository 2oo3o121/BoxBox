// Offscreen document maintains capture pipeline and WebRTC signaling.
const peerConnections = new Map(); // sessionId -> RTCPeerConnection
const pendingOffers = new Map(); // sessionId -> deferred offer payloads
const pendingOutputIce = new Map(); // sessionId -> queued ICE candidates

const srcDims = new Map(); // sessionId -> { width, height }
const srcViewport = new Map(); // sessionId -> viewport rect used for crop hints
const scaledRegions = new Map(); // sessionId -> effective cropped region after scaling

const videoElements = new Map(); // sessionId -> HTMLVideoElement mirroring capture
const canvasContexts = new Map(); // sessionId -> CanvasRenderingContext2D for crop preview
const cropGeometries = new Map(); // sessionId -> most recent crop payload from source
const animationFrameIds = new Map(); // sessionId -> render loop handles
const originalStreams = new Map(); // sessionId -> original tabCapture MediaStream
const pendingCropPayload = new Map(); // sessionId -> crop payload queued while stream boots
const currentOfferId = new Map(); // sessionId -> latest offer identifier

const baseVideoByTab = new Map(); // tabId -> shared base MediaStreamTrack
const sessionsByTab = new Map(); // tabId -> set of attached sessionIds
const sessionTab = new Map(); // sessionId -> source tab id
const baseOwnerByTab = new Map(); // tabId -> sessionId that owns tabCapture

const pcByOutput = new Map(); // sessionTabKey -> RTCPeerConnection for outputs
const offerByOutput = new Map(); // sessionTabKey -> pending offer payload
const pendingIceByOutput = new Map(); // sessionTabKey -> queued ICE for outputs
const offerIdByOutput = new Map(); // sessionTabKey -> last offer id acknowledged
function keyFor(sessionId, tabId) {
    return `${sessionId}:${tabId}`;
}

const DETAIL_CONTENT_HINT = "detail";
const DEFAULT_MAX_BITRATE = 4_000_000;
const LEGACY_OUTPUT_KEY = "__legacy__";
const activeOutputTabs = new Map(); // sessionId -> Set of tab keys consuming frames
const canvasStreams = new Map(); // sessionId -> MediaStream from canvas.captureStream
const sessionSenderTracks = new Map(); // sessionId -> track feeding session-level PC
const outputSenderTracks = new Map(); // sessionTabKey -> track feeding per-output PC

function setDetailHintForTrack(track) {
    if (!track) return;
    try {
        track.contentHint = DETAIL_CONTENT_HINT;
    } catch {}
}

function boostSenderForHighQuality(sender, maxBitrate = DEFAULT_MAX_BITRATE) {
    if (!sender || typeof sender.getParameters !== "function") return;
    try {
        const params = sender.getParameters() || {};
        if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
        }
        params.degradationPreference = "maintain-resolution";
        const enc = params.encodings[0];
        if (typeof enc.maxBitrate !== "number" || enc.maxBitrate < maxBitrate) {
            enc.maxBitrate = maxBitrate;
        }
        enc.priority = "high";
        if ("networkPriority" in enc) enc.networkPriority = "high";
        const result = sender.setParameters(params);
        if (result && typeof result.catch === "function") {
            result.catch(() => {});
        }
    } catch {}
}

function stopTrack(track) {
    if (!track) return;
    try {
        track.stop();
    } catch {}
}

function initCanvasStream(sessionId) {
    const canvas = canvasContexts.get(sessionId)?.canvas;
    if (!canvas) return null;
    const stream = canvas.captureStream(30);
    setDetailHintForTrack(stream.getVideoTracks?.()[0]);
    canvasStreams.set(sessionId, stream);
    return stream;
}

function getCanvasStream(sessionId) {
    let stream = canvasStreams.get(sessionId);
    const track = stream?.getVideoTracks?.()[0];
    if (!stream || !track || track.readyState === "ended") {
        stream = initCanvasStream(sessionId);
    }
    return stream;
}

function createCanvasTrackClone(sessionId) {
    const stream = getCanvasStream(sessionId);
    const baseTrack = stream?.getVideoTracks?.()[0];
    if (!baseTrack) return null;
    const clone = baseTrack.clone();
    setDetailHintForTrack(clone);
    return clone;
}

function releaseSessionTrack(sessionId) {
    const prev = sessionSenderTracks.get(sessionId);
    if (prev) {
        stopTrack(prev);
        sessionSenderTracks.delete(sessionId);
    }
}

function releaseOutputTrack(sessionId, tabId) {
    const key = keyFor(sessionId, tabId);
    const prev = outputSenderTracks.get(key);
    if (prev) {
        stopTrack(prev);
        outputSenderTracks.delete(key);
    }
}

function normalizeOutputKey(tabId) {
    return tabId == null ? LEGACY_OUTPUT_KEY : String(tabId);
}

function markOutputActive(sessionId, tabId) {
    if (!sessionId) return;
    const key = normalizeOutputKey(tabId);
    let tabs = activeOutputTabs.get(sessionId);
    if (!tabs) {
        tabs = new Set();
        activeOutputTabs.set(sessionId, tabs);
    }
    if (tabs.has(key)) return;
    tabs.add(key);
    startRenderLoop(sessionId);
}

function markOutputInactive(sessionId, tabId) {
    if (!sessionId) return;
    const tabs = activeOutputTabs.get(sessionId);
    if (!tabs) return;
    const key = normalizeOutputKey(tabId);
    if (!tabs.delete(key)) return;
    if (tabs.size === 0) {
        activeOutputTabs.delete(sessionId);
        stopRenderLoop(sessionId);
    }
}

// Primary dispatcher for capture and signaling messages.
chrome.runtime.onMessage.addListener((msg) => {
    if (msg.target !== "offscreen") return;

    const { sessionId, payload, streamId } = msg;

    switch (msg.type) {
        case "start-capture":
            startCapture(sessionId, streamId, msg.tabId);
            break;

        case "attach-session-to-tab-capture": {
            const tabId = msg.tabId;
            console.log(
                `[OFFSCREEN] attach-session-to-tab-capture sid=${sessionId} tabId=${tabId}`,
            );
            try {
                attachSessionToBase(tabId, sessionId);
            } catch (e) {
                console.error(e);
            }
            break;
        }

        case "new-output-added":
            markOutputActive(sessionId, msg.tabId);
            if (msg.tabId) {
                const tabId = msg.tabId;
                console.log(
                    `[OFFSCREEN] 'new-output-added' for session=${sessionId}, tabId=${tabId}`,
                );
                setupPeerConnectionForOutput(sessionId, tabId)
                    .then(() => {
                        const k = keyFor(sessionId, tabId);
                        const offerPayload = offerByOutput.get(k);
                        if (offerPayload) {
                            chrome.runtime.sendMessage({
                                type: "OFFER_GENERATED",
                                payload: offerPayload,
                            });
                        }
                        const r = scaledRegions.get(sessionId);
                        if (r?.w && r?.h) {
                            chrome.runtime.sendMessage({
                                type: "CROP_AR",
                                payload: { sessionId, w: r.w, h: r.h },
                            });
                        }
                    })
                    .catch((e) =>
                        console.error(
                            "[OFFSCREEN] per-output setup failed:",
                            e,
                        ),
                    );
                break;
            }
            console.log(
                `[OFFSCREEN] 'new-output-added' ??recreate PC for ${sessionId}`,
            );
            try {
                const old = peerConnections.get(sessionId);
                if (old) {
                    try {
                        old.onicecandidate = null;
                    } catch {}
                    try {
                        old.close();
                    } catch {}
                }
                peerConnections.delete(sessionId);
                pendingOffers.delete(sessionId);
                pendingOutputIce.delete(sessionId);

                setupPeerConnection(sessionId)
                    .then(() => {
                        const offerPayload = pendingOffers.get(sessionId);
                        if (offerPayload) {
                            console.log(
                                `[OFFSCREEN] Sending fresh OFFER_GENERATED for ${sessionId}`,
                            );
                            chrome.runtime.sendMessage({
                                type: "OFFER_GENERATED",
                                payload: offerPayload,
                            });
                            const currentRegion = scaledRegions.get(sessionId);
                            if (
                                currentRegion &&
                                currentRegion.w &&
                                currentRegion.h
                            ) {
                                chrome.runtime.sendMessage({
                                    type: "CROP_AR",
                                    payload: {
                                        sessionId,
                                        w: currentRegion.w,
                                        h: currentRegion.h,
                                    },
                                });
                            }
                        } else {
                            console.warn(
                                `[OFFSCREEN] Offer not ready right after recreate for ${sessionId}`,
                            );
                        }
                    })
                    .catch((e) => {
                        console.error(
                            "[OFFSCREEN] Failed to recreate PC on 'new-output-added':",
                            e,
                        );
                    });
            } catch (e) {
                console.error(
                    "[OFFSCREEN] Failed (sync) in 'new-output-added':",
                    e,
                );
            }
            break;

        case "ANSWER":
            {
                const sid = payload.sessionId;
                if (payload.tabId) {
                    const tid = payload.tabId;
                    const key = keyFor(sid, tid);
                    const pcAnswer = pcByOutput.get(key);
                    const expected = offerIdByOutput.get(key);
                    const payloadOfferId = payload?.offerId || null;
                    if (!pcAnswer || !payload?.sdp) {
                        console.debug(
                            "[OFFSCREEN] ANSWER skipped (per-output: missing PC/SDP)",
                            JSON.stringify({
                                sid,
                                tid,
                                hasPc: !!pcAnswer,
                                hasSdp: !!payload?.sdp,
                            }),
                        );
                        break;
                    }
                    if (
                        payloadOfferId &&
                        expected &&
                        payloadOfferId !== expected
                    ) {
                        console.debug(
                            "[OFFSCREEN] ANSWER skipped (per-output: stale offer)",
                            JSON.stringify({
                                sid,
                                tid,
                                expected,
                                got: payloadOfferId,
                            }),
                        );
                        break;
                    }
                    if (pcAnswer.signalingState !== "have-local-offer") {
                        console.debug(
                            "[OFFSCREEN] ANSWER skipped (per-output: signalingState mismatch)",
                            JSON.stringify({
                                sid,
                                tid,
                                state: pcAnswer.signalingState,
                            }),
                        );
                        break;
                    }
                    pcAnswer
                        .setRemoteDescription({
                            type: "answer",
                            sdp: payload.sdp,
                        })
                        .then(async () => {
                            const queued = pendingIceByOutput.get(key);
                            if (queued?.length) {
                                for (const c of queued) {
                                    try {
                                        await pcAnswer.addIceCandidate(c);
                                    } catch (err) {
                                        console.warn(
                                            "[OFFSCREEN] addIceCandidate (queue, per-output) failed:",
                                            err?.message,
                                        );
                                    }
                                }
                                pendingIceByOutput.delete(key);
                            }
                        })
                        .catch((e) =>
                            console.error(
                                "Offscreen: setRemoteDescription failed (per-output):",
                                e,
                            ),
                        );
                    break;
                }
                const pcAnswer = peerConnections.get(sid);
                const expected = currentOfferId.get(sid);
                const payloadOfferId = payload?.offerId || null;
                if (!pcAnswer || !payload?.sdp) {
                    console.debug(
                        "[OFFSCREEN] ANSWER skipped (missing PC/SDP)",
                        JSON.stringify({
                            sid,
                            hasPc: !!pcAnswer,
                            hasSdp: !!payload?.sdp,
                        }),
                    );
                    break;
                }
                if (payloadOfferId && expected && payloadOfferId !== expected) {
                    console.debug(
                        "[OFFSCREEN] ANSWER skipped (stale offer)",
                        JSON.stringify({
                            sid,
                            expected,
                            got: payloadOfferId,
                        }),
                    );
                    break;
                }
                if (pcAnswer.signalingState !== "have-local-offer") {
                    console.debug(
                        "[OFFSCREEN] ANSWER skipped (signalingState mismatch)",
                        JSON.stringify({
                            sid,
                            state: pcAnswer.signalingState,
                        }),
                    );
                    break;
                }
                pcAnswer
                    .setRemoteDescription({ type: "answer", sdp: payload.sdp })
                    .then(async () => {
                        const queued = pendingOutputIce.get(sid);
                        if (queued?.length) {
                            for (const c of queued) {
                                try {
                                    await pcAnswer.addIceCandidate(c);
                                } catch (err) {
                                    console.warn(
                                        "[OFFSCREEN] addIceCandidate (from-queue) failed:",
                                        err?.message,
                                    );
                                }
                            }
                            pendingOutputIce.delete(sid);
                        }
                    })
                    .catch((e) =>
                        console.error(
                            "Offscreen: setRemoteDescription failed:",
                            e,
                        ),
                    );
            }
            break;

        case "ICE_FROM_OUTPUT":
            const sid = payload.sessionId;
            if (payload.tabId) {
                const tid = payload.tabId;
                const key = keyFor(sid, tid);
                const pcIce = pcByOutput.get(key);
                const expected = offerIdByOutput.get(key);
                if (pcIce && payload?.candidate) {
                    if (
                        payload.offerId &&
                        expected &&
                        payload.offerId !== expected
                    ) {
                        console.debug(
                            "[OFFSCREEN] ICE dropped (per-output: stale offer)",
                            JSON.stringify({
                                sid,
                                tid,
                                expected,
                                got: payload.offerId,
                            }),
                        );
                        break;
                    }
                    if (!pcIce.remoteDescription) {
                        if (!pendingIceByOutput.has(key))
                            pendingIceByOutput.set(key, []);
                        pendingIceByOutput.get(key).push(payload.candidate);
                    } else {
                        pcIce
                            .addIceCandidate(payload.candidate)
                            .catch((e) =>
                                console.error(
                                    "Offscreen: addIceCandidate failed (per-output):",
                                    e,
                                ),
                            );
                    }
                }
                break;
            }
            const pcIce = peerConnections.get(sid);
            const expected = currentOfferId.get(sid);
            if (pcIce && payload?.candidate) {
                if (
                    payload.offerId &&
                    expected &&
                    payload.offerId !== expected
                ) {
                    console.debug(
                        "[OFFSCREEN] ICE dropped (stale offer)",
                        JSON.stringify({
                            sid,
                            expected,
                            got: payload.offerId,
                        }),
                    );
                    break;
                }
                if (!pcIce.remoteDescription) {
                    if (!pendingOutputIce.has(sid))
                        pendingOutputIce.set(sid, []);
                    pendingOutputIce.get(sid).push(payload.candidate);
                } else {
                    pcIce
                        .addIceCandidate(payload.candidate)
                        .catch((e) =>
                            console.error(
                                "Offscreen: addIceCandidate failed:",
                                e,
                            ),
                        );
                }
            }
            break;

        case "SET_VIDEO_CROP":
            if (payload.sessionId && payload.geom && payload.viewportWidth) {
                const sid = payload.sessionId;
                const video = videoElements.get(sid);
                if (!video || !video.videoWidth || !video.videoHeight) {
                    pendingCropPayload.set(sid, payload);
                    break;
                }

                const videoW = video.videoWidth;
                const videoH = video.videoHeight;
                const g = payload.geom;
                const vpW = Math.max(1, Number(payload.viewportWidth));
                const vpH = Math.max(1, Number(payload.viewportHeight));

                const scaleX = videoW / vpW;
                const scaleY = videoH / vpH;
                const scale = Math.min(scaleX, scaleY);
                const offsetX = (videoW - vpW * scale) / 2;
                const offsetY = (videoH - vpH * scale) / 2;

                const rx = g.x * scale + offsetX;
                const ry = g.y * scale + offsetY;
                const rw = g.width * scale;
                const rh = g.height * scale;

                let left = Math.round(rx);
                let top = Math.round(ry);
                let right = Math.round(rx + rw);
                let bottom = Math.round(ry + rh);

                left = Math.max(0, Math.min(left, videoW - 1));
                top = Math.max(0, Math.min(top, videoH - 1));
                right = Math.max(left + 1, Math.min(right, videoW));
                bottom = Math.max(top + 1, Math.min(bottom, videoH));

                let finalX = left;
                let finalY = top;
                let finalW = right - left;
                let finalH = bottom - top;

                const prev = scaledRegions.get(sid);
                scaledRegions.set(sid, {
                    x: finalX,
                    y: finalY,
                    w: finalW,
                    h: finalH,
                });

                if (!prev || prev.w !== finalW || prev.h !== finalH) {
                    chrome.runtime.sendMessage({
                        type: "CROP_AR",
                        payload: { sessionId: sid, w: finalW, h: finalH },
                    });
                }
            }
            break;

        case "stop-capture":
            stopCapture(sessionId);
            break;

        case "STOP_STREAMING":
            console.log(`[OFFSCREEN] Pausing stream for session: ${sessionId}`);
            const pc = peerConnections.get(sessionId);
            if (pc) pc.close();
            peerConnections.delete(sessionId);
            pendingOffers.delete(sessionId);
            pendingOutputIce.delete(sessionId);
            break;

        case "REQUEST_CROP_AR": {
            try {
                const sid = sessionId || payload?.sessionId;
                if (!sid) break;
                const reg = scaledRegions.get(sid);
                if (reg && reg.w && reg.h) {
                    chrome.runtime.sendMessage({
                        type: "CROP_AR",
                        payload: { sessionId: sid, w: reg.w, h: reg.h },
                    });
                }
            } catch {}
            break;
        }
    }
});

// Boots getUserMedia for a tab capture stream and feeds it into RTC.
async function startCapture(sessionId, streamId, tabId) {
    if (peerConnections.has(sessionId)) {
        stopCapture(sessionId);
    }

    console.log(
        `[OFFSCREEN] Starting capture process for session: ${sessionId}`,
    );

    try {
        let stream;
        if (streamId) {
            console.log(
                "[OFFSCREEN] Step 1: Using tabCapture streamId for current tab...",
            );
            stream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    mandatory: {
                        chromeMediaSource: "tab",
                        chromeMediaSourceId: streamId,
                        maxFrameRate: 30,
                    },
                },
            });
        } else {
            console.log(
                "[OFFSCREEN] Step 1: Falling back to getDisplayMedia...",
            );
            stream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: false,
            });
        }

        originalStreams.set(sessionId, stream);
        console.log("[OFFSCREEN] Step 2: Stream acquired successfully.");

        const [videoTrack] = stream.getVideoTracks();
        setDetailHintForTrack(videoTrack);
        const settings = videoTrack.getSettings();

        console.log("[OFFSCREEN] Step 3: Creating <video> element.");
        const video = document.createElement("video");
        video.srcObject = stream;
        video.muted = true;
        video.playsInline = true;
        Object.assign(video.style, {
            position: "absolute",
            left: "-9999px",
            top: "-9999px",
            width: "1px",
            height: "1px",
        });
        document.body.appendChild(video);
        try {
            await video.play();
        } catch {}
        if (!video.videoWidth) {
            await new Promise((res) => {
                const on = () => {
                    video.removeEventListener("loadedmetadata", on);
                    res();
                };
                video.addEventListener("loadedmetadata", on, { once: true });
                setTimeout(res, 1000);
            });
        }
        videoElements.set(sessionId, video);
        if (tabId) {
            baseVideoByTab.set(tabId, video);
            sessionTab.set(sessionId, tabId);
            if (!sessionsByTab.has(tabId)) sessionsByTab.set(tabId, new Set());
            sessionsByTab.get(tabId).add(sessionId);
            if (!baseOwnerByTab.has(tabId))
                baseOwnerByTab.set(tabId, sessionId);
        }

        console.log("[OFFSCREEN] Step 4: Creating <canvas> element.");
        const canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        const ctx = canvas.getContext("2d");
        Object.assign(canvas.style, {
            position: "absolute",
            left: "-9999px",
            top: "-9999px",
            width: "1px",
            height: "1px",
        });
        document.body.appendChild(canvas);
        canvasContexts.set(sessionId, ctx);

        console.log("[OFFSCREEN] Step 5: Calling canvas.captureStream()...");
        const canvasStream = initCanvasStream(sessionId);
        console.log(
            "[OFFSCREEN] canvas track state:",
            canvasStream?.getVideoTracks?.()[0]?.readyState,
        );
        console.log("[OFFSCREEN] Step 6: Cropped stream created.");

        await setupPeerConnection(sessionId);

        try {
            const pending = pendingCropPayload.get(sessionId);
            if (pending) {
                console.log(
                    "[OFFSCREEN] Applying pending crop payload after metadata ready.",
                );
                chrome.runtime.onMessage.dispatch &&
                    chrome.runtime.onMessage.dispatch({
                        target: "offscreen",
                        type: "SET_VIDEO_CROP",
                        payload: pending,
                    });
                pendingCropPayload.delete(sessionId);
            }
        } catch (e) {}

        startRenderLoop(sessionId);
    } catch (error) {
        console.error(
            "!!!!!!!!!! [OFFSCREEN] CAPTURE FAILED !!!!!!!!!!",
            error,
        );
        stopCapture(sessionId);
    }
}

// Reuses an existing capture when multiple sessions watch the same tab.
function attachSessionToBase(tabId, sessionId) {
    const baseVideo = baseVideoByTab.get(tabId);
    if (!baseVideo) {
        console.warn(
            `[OFFSCREEN] No base video for tabId=${tabId} to attach session ${sessionId}`,
        );
        return;
    }
    sessionTab.set(sessionId, tabId);
    if (!sessionsByTab.has(tabId)) sessionsByTab.set(tabId, new Set());
    sessionsByTab.get(tabId).add(sessionId);

    videoElements.set(sessionId, baseVideo);

    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext("2d");
    Object.assign(canvas.style, {
        position: "absolute",
        left: "-9999px",
        top: "-9999px",
        width: "1px",
        height: "1px",
    });
    document.body.appendChild(canvas);
    canvasContexts.set(sessionId, ctx);
    initCanvasStream(sessionId);

    setupPeerConnection(sessionId)
        .then(() => {
            startRenderLoop(sessionId);
            try {
                const r = scaledRegions.get(sessionId);
                if (r?.w && r?.h) {
                    chrome.runtime.sendMessage({
                        type: "CROP_AR",
                        payload: { sessionId, w: r.w, h: r.h },
                    });
                }
            } catch {}
        })
        .catch((e) =>
            console.error("[OFFSCREEN] attachSessionToBase PC fail", e),
        );
}

// Creates the peer connection for the source side and hooks events.
async function setupPeerConnection(sessionId) {
    if (peerConnections.has(sessionId)) {
        peerConnections.get(sessionId).close();
    }

    const video = videoElements.get(sessionId);
    const settings = video?.srcObject?.getVideoTracks()?.[0]?.getSettings();
    if (!video || !settings) {
        console.error(
            `[OFFSCREEN] Cannot setup PC for ${sessionId}: no video element or settings`,
        );
        return;
    }

    console.log(
        `[OFFSCREEN] Setting up new PeerConnection for session: ${sessionId}`,
    );
    const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    peerConnections.set(sessionId, pc);

    releaseSessionTrack(sessionId);
    const track = createCanvasTrackClone(sessionId);
    if (!track) {
        console.error(
            `[OFFSCREEN] Cannot setup PC for ${sessionId}: failed to clone canvas track`,
        );
        peerConnections.delete(sessionId);
        try {
            pc.close();
        } catch {}
        return;
    }
    const outStream = new MediaStream([track]);
    const sender = pc.addTrack(track, outStream);
    boostSenderForHighQuality(sender);
    sessionSenderTracks.set(sessionId, track);

    pc.onicecandidate = (e) => {
        if (e.candidate) {
            chrome.runtime.sendMessage({
                type: "ICE_FROM_SOURCE",
                payload: { sessionId, candidate: e.candidate },
            });
        }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    console.log(`[OFFSCREEN] New Offer created for session: ${sessionId}`);

    const reg0 = scaledRegions.get(sessionId);
    const cw = reg0?.w || settings.width;
    const ch = reg0?.h || settings.height;
    const offerId = crypto.randomUUID();
    currentOfferId.set(sessionId, offerId);
    const offerPayload = {
        sessionId,
        sdp: offer.sdp,
        srcW: cw,
        srcH: ch,
        offerId,
    };

    pendingOffers.set(sessionId, offerPayload);
    srcDims.set(sessionId, { srcW: settings.width, srcH: settings.height });
    console.log("[OFFSCREEN] Offer stored.");
}

// Builds a peer connection for a specific output tab.
async function setupPeerConnectionForOutput(sessionId, tabId) {
    const video = videoElements.get(sessionId);
    const settings = video?.srcObject?.getVideoTracks()?.[0]?.getSettings();
    if (!video || !settings) {
        console.error(
            `[OFFSCREEN] Cannot setup per-output PC for ${sessionId}/${tabId}: no video/settings`,
        );
        return;
    }

    console.log(
        `[OFFSCREEN] Setting up per-output PC for session=${sessionId} tabId=${tabId}`,
    );
    const pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    const key = keyFor(sessionId, tabId);
    pcByOutput.set(key, pc);

    releaseOutputTrack(sessionId, tabId);
    const track = createCanvasTrackClone(sessionId);
    if (!track) {
        console.error(
            `[OFFSCREEN] Cannot setup per-output PC for ${sessionId}/${tabId}: failed to clone canvas track`,
        );
        pcByOutput.delete(key);
        try {
            pc.close();
        } catch {}
        return;
    }
    const outStream = new MediaStream([track]);
    const sender = pc.addTrack(track, outStream);
    boostSenderForHighQuality(sender);
    outputSenderTracks.set(key, track);

    pc.onicecandidate = (e) => {
        if (e.candidate) {
            chrome.runtime.sendMessage({
                type: "ICE_FROM_SOURCE",
                payload: { sessionId, candidate: e.candidate, tabId },
            });
        }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    console.log(
        `[OFFSCREEN] New Offer (per-output) for session=${sessionId} tabId=${tabId}`,
    );

    const reg0 = scaledRegions.get(sessionId);
    const cw = reg0?.w || settings.width;
    const ch = reg0?.h || settings.height;
    const offerId = crypto.randomUUID();
    offerIdByOutput.set(key, offerId);
    const offerPayload = {
        sessionId,
        sdp: offer.sdp,
        srcW: cw,
        srcH: ch,
        offerId,
        tabId,
    };
    offerByOutput.set(key, offerPayload);
}

function stopRenderLoop(sessionId) {
    if (!animationFrameIds.has(sessionId)) return;
    const handle = animationFrameIds.get(sessionId);
    if (handle?.interval) {
        try {
            clearInterval(handle.interval);
        } catch {}
    }
    const video = handle?.video || videoElements.get(sessionId);
    if (handle?.rvfc && video?.cancelVideoFrameCallback) {
        try {
            video.cancelVideoFrameCallback(handle.rvfc);
        } catch {}
    }
    animationFrameIds.delete(sessionId);
    console.log(`[OFFSCREEN] Render loop stopped for session: ${sessionId}`);
}

function startRenderLoop(sessionId) {
    if (animationFrameIds.has(sessionId)) return;
    const tabs = activeOutputTabs.get(sessionId);
    if (!tabs || tabs.size === 0) {
        return;
    }
    const video = videoElements.get(sessionId);
    const ctx = canvasContexts.get(sessionId);

    console.log(`[OFFSCREEN] startRenderLoop called for session: ${sessionId}`);
    console.log("[OFFSCREEN] Retrieved from Maps:", { video, ctx });

    if (!video || !ctx) {
        console.error(
            "[OFFSCREEN] CRITICAL: Could not find video or canvas context for session. Loop terminating.",
        );
        return;
    }

    const canvas = ctx.canvas;
    let firstDrawLogged = false;
    let frameCount = 0;

    const drawOnce = () => {
        const vw = video.videoWidth || 0;
        const vh = video.videoHeight || 0;
        let reg = scaledRegions.get(sessionId);
        if (!reg || !reg.w || !reg.h) {
            if (vw > 0 && vh > 0) reg = { x: 0, y: 0, w: vw, h: vh };
            else return;
        }
        const W = Math.max(1, reg.w | 0),
            H = Math.max(1, reg.h | 0);
        if (canvas.width !== W || canvas.height !== H) {
            canvas.width = W;
            canvas.height = H;
        }
        try {
            ctx.drawImage(
                video,
                reg.x | 0,
                reg.y | 0,
                W,
                H,
                0,
                0,
                canvas.width,
                canvas.height,
            );
            frameCount++;
            if (!firstDrawLogged) {
                firstDrawLogged = true;
                console.log(
                    "[OFFSCREEN] first draw ??crop=",
                    reg,
                    "canvas=",
                    canvas.width + "x" + canvas.height,
                );
            } else if (frameCount % 60 === 0) {
                console.log(
                    "[OFFSCREEN] drew",
                    frameCount,
                    "frames, crop=",
                    reg,
                    "canvas=",
                    canvas.width + "x" + canvas.height,
                );
            }
        } catch (err) {
            console.warn("[OFFSCREEN] drawImage fail:", err?.message, {
                reg,
                vw,
                vh,
            });
        }
    };

    drawOnce();
    const handles = { interval: 0, rvfc: 0, video };
    if (typeof video.requestVideoFrameCallback === "function") {
        const step = () => {
            drawOnce();
            handles.rvfc = video.requestVideoFrameCallback(step);
        };
        handles.rvfc = video.requestVideoFrameCallback(step);
        animationFrameIds.set(sessionId, handles);
        console.log("[OFFSCREEN] Using requestVideoFrameCallback loop");
    } else {
        handles.interval = setInterval(drawOnce, 33);
        animationFrameIds.set(sessionId, handles);
        console.log("[OFFSCREEN] Using setInterval loop @30fps (legacy)");
    }

    setTimeout(() => {
        if (frameCount === 0) {
            const pc = peerConnections.get(sessionId);
            const st = originalStreams.get(sessionId);
            console.error(
                "[OFFSCREEN] NO FRAMES after 1500ms. videoWH=",
                video.videoWidth,
                "x",
                video.videoHeight,
                "track=",
                st?.getVideoTracks?.()[0]?.readyState,
                "pc=",
                !!pc,
            );
        }
    }, 1500);
}

function stopCapture(sessionId) {
    let shouldStopBase = true;
    let tid = null;
    try {
        tid = sessionTab.get(sessionId);
        if (tid && sessionsByTab.has(tid)) {
            const set = sessionsByTab.get(tid);
            set.delete(sessionId);
            if (set.size > 0) shouldStopBase = false;
            else sessionsByTab.delete(tid);
        }
    } catch {}

    try {
        const pc = peerConnections.get(sessionId);
        if (pc) pc.close();
    } catch {}
    releaseSessionTrack(sessionId);
    try {
        for (const [k, outPc] of pcByOutput.entries()) {
            if (k.startsWith(sessionId + ":")) {
                try {
                    outPc.close();
                } catch {}
                pcByOutput.delete(k);
                offerByOutput.delete(k);
                pendingIceByOutput.delete(k);
                offerIdByOutput.delete(k);
                const [, tabIdStr] = k.split(":");
                const tabIdVal =
                    tabIdStr === "undefined" ? undefined : Number(tabIdStr);
                releaseOutputTrack(sessionId, tabIdVal);
            }
        }
    } catch {}

    if (shouldStopBase) {
        try {
            const baseVideo = tid ? baseVideoByTab.get(tid) : null;
            const baseStream = baseVideo?.srcObject;
            if (baseStream?.getTracks)
                baseStream.getTracks().forEach((t) => {
                    try {
                        t.stop();
                    } catch {}
                });
            if (tid) {
                baseVideoByTab.delete(tid);
                baseOwnerByTab.delete(tid);
            }
        } catch {}
    }

    stopRenderLoop(sessionId);

    [
        peerConnections,
        pendingOffers,
        pendingOutputIce,
        videoElements,
        canvasContexts,
        cropGeometries,
        animationFrameIds,
        srcDims,
        srcViewport,
        scaledRegions,
        pendingCropPayload,
    ].forEach((map) => map.delete(sessionId));

    try {
        if (shouldStopBase) originalStreams.delete(sessionId);
    } catch {}

    const canvasStream = canvasStreams.get(sessionId);
    if (canvasStream) {
        try {
            canvasStream.getTracks()?.forEach((t) => stopTrack(t));
        } catch {}
        canvasStreams.delete(sessionId);
    }
    activeOutputTabs.delete(sessionId);
}

chrome.runtime.onMessage.addListener((msg) => {
    if (msg.target !== "offscreen") return;
    if (msg.type !== "stop-output-peer") return;
    const { sessionId, tabId } = msg;
    const k = keyFor(sessionId, tabId);
    try {
        const pc = pcByOutput.get(k);
        if (pc) pc.close();
    } catch {}
    pcByOutput.delete(k);
    offerByOutput.delete(k);
    pendingIceByOutput.delete(k);
    offerIdByOutput.delete(k);
    releaseOutputTrack(sessionId, tabId);
    markOutputInactive(sessionId, tabId);
});
