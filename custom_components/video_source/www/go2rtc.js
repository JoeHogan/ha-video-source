// WebRTC client for go2rtc streams.
//
// Two flavours of go2rtc are supported, picked by the integration entry the card uses:
//
//  * Home Assistant's built-in go2rtc (`config.builtin`). It isn't exposed to browsers, so
//    the offer/answer/candidates go through HA's `camera/webrtc/*` websocket API and
//    `config.resource` must be a camera entity_id (e.g. "camera.front_door").
//
//  * Your own go2rtc instance. Signaling is an HTTP POST of the SDP offer to go2rtc's
//    `/api/webrtc?src=<stream>` endpoint, sent through this integration's authenticated
//    proxy (`/api/ha-video-source/<entry_id>/...`). `config.resource` is a stream name
//    from your go2rtc configuration.
//
// This class exposes the same interface as WHEPClient (webrtc_v2.js), plus two-way audio
// (startTwoWayAudio / stopTwoWayAudio).

import { getAccessToken } from "./refreshToken.js";

const getHassConnection = () => {
    const hc = window.hassConnection || window.parent?.hassConnection;
    if (!hc) {
        return Promise.reject('Home Assistant connection is not available');
    }
    return hc.then((c) => {
        if (!c?.conn) {
            throw new Error('Home Assistant websocket connection is not available');
        }
        return c.conn;
    });
};

// unsubscribe() may return a promise that rejects if the connection is already gone
const safeUnsubscribe = (unsubscribe) => {
    try {
        Promise.resolve(unsubscribe()).catch(() => { /* ignore */ });
    } catch (e) { /* ignore */ }
};

// Resolves once ICE gathering has finished (or after a timeout). Needed for signaling
// that can't trickle candidates (plain HTTP): the offer must already contain them.
const waitForIceGathering = (pc, timeout = 2500) => new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
        resolve();
        return;
    }
    let timer = null;
    const done = () => {
        pc.removeEventListener('icegatheringstatechange', check);
        clearTimeout(timer);
        resolve();
    };
    const check = () => {
        if (pc.iceGatheringState === 'complete') done();
    };
    timer = setTimeout(done, timeout);
    pc.addEventListener('icegatheringstatechange', check);
});

// ---------------------------------------------------------------------------
// Signaling: Home Assistant's built-in go2rtc (websocket, trickle ICE)
// ---------------------------------------------------------------------------

class HassSession {
    constructor(entityId) {
        this.entityId = entityId;
        this.conn = null;
        this.sessionId = null;
        this.pending = [];
        this.unsubscribe = null;
        this.closed = false;
    }

    get trickle() {
        return true;
    }

    async start(offerSdp, handlers) {
        const conn = await getHassConnection();
        if (this.closed) return;
        this.conn = conn;
        const unsubscribe = await conn.subscribeMessage(
            (msg) => this.onMessage(msg, handlers),
            {
                type: 'camera/webrtc/offer',
                entity_id: this.entityId,
                offer: offerSdp,
            }
        );
        if (this.closed) {
            safeUnsubscribe(unsubscribe);
            return;
        }
        this.unsubscribe = unsubscribe;
    }

    onMessage(msg, handlers) {
        if (this.closed) return;
        switch (msg?.type) {
            case 'session':
                this.sessionId = msg.session_id;
                if (this.pending.length) {
                    const pending = this.pending;
                    this.pending = [];
                    pending.forEach((c) => this.postCandidate(c));
                }
                break;
            case 'answer':
                handlers.onAnswer(msg.answer);
                break;
            case 'candidate':
                if (msg.candidate?.candidate !== undefined) {
                    handlers.onCandidate(msg.candidate);
                }
                break;
            case 'error':
                handlers.onError(`${msg.code || 'error'}: ${msg.message || ''}`);
                break;
        }
    }

    sendCandidate(candidate) {
        if (this.closed) return;
        // Candidates can only be sent once the server has given us a session id
        if (!this.sessionId) {
            this.pending.push(candidate);
            return;
        }
        this.postCandidate(candidate);
    }

    async postCandidate(candidate) {
        try {
            await this.conn.sendMessagePromise({
                type: 'camera/webrtc/candidate',
                entity_id: this.entityId,
                session_id: this.sessionId,
                candidate: candidate.toJSON(),
            });
        } catch (e) {
            console.log(`go2rtc: error sending candidate: ${JSON.stringify(e)}`);
        }
    }

    close() {
        this.closed = true;
        this.pending = [];
        if (this.unsubscribe) {
            safeUnsubscribe(this.unsubscribe);
            this.unsubscribe = null;
        }
        this.sessionId = null;
    }
}

class HassSignaling {
    constructor(entityId) {
        this.entityId = entityId;
    }

    async getRtcConfig() {
        try {
            const conn = await getHassConnection();
            const clientConfig = await conn.sendMessagePromise({
                type: 'camera/webrtc/get_client_config',
                entity_id: this.entityId,
            });
            return {
                configuration: clientConfig?.configuration || {},
                dataChannel: clientConfig?.dataChannel || null,
            };
        } catch (e) {
            console.log(`go2rtc: unable to get client config, using defaults: ${JSON.stringify(e)}`);
            return { configuration: {}, dataChannel: null };
        }
    }

    createSession() {
        return new HassSession(this.entityId);
    }
}

// ---------------------------------------------------------------------------
// Signaling: your own go2rtc (HTTP POST of the offer through the integration proxy)
// ---------------------------------------------------------------------------

class HttpSession {
    constructor(baseUrl, src) {
        this.baseUrl = baseUrl;
        this.src = src;
        this.abort = null;
        this.closed = false;
    }

    // go2rtc's answer already contains its candidates and it learns ours from connectivity
    // checks, so there is no trickle ICE: the offer has to be sent with candidates included.
    get trickle() {
        return false;
    }

    async start(offerSdp, handlers) {
        const token = await getAccessToken();
        if (this.closed) return;
        this.abort = new AbortController();
        try {
            const res = await fetch(`${this.baseUrl}/api/webrtc?src=${encodeURIComponent(this.src)}`, {
                method: 'POST',
                headers: {
                    "Authorization": `Bearer ${token}`,
                    "Content-Type": 'application/sdp',
                },
                body: offerSdp,
                signal: this.abort.signal,
            });
            if (!res.ok) {
                const detail = (await res.text().catch(() => '')).trim().slice(0, 200);
                throw new Error(
                    `go2rtc responded with HTTP ${res.status} for stream "${this.src}"${detail ? `: ${detail}` : ''}` +
                    (res.status === 404
                        ? ' (the resource must be a stream name from your go2rtc config, not a Home Assistant entity id)'
                        : '')
                );
            }
            const contentType = res.headers.get('content-type') || '';
            const answer = contentType.includes('json') ? (await res.json())?.sdp : await res.text();
            if (!answer) {
                throw new Error('go2rtc returned an empty SDP answer');
            }
            if (!this.closed) {
                handlers.onAnswer(answer);
            }
        } catch (err) {
            if (!this.closed && err?.name !== 'AbortError') {
                handlers.onError(err?.message || String(err));
            }
        }
    }

    sendCandidate() { /* not supported / needed */ }

    close() {
        this.closed = true;
        this.abort?.abort();
        this.abort = null;
    }
}

class HttpSignaling {
    constructor(baseUrl, src) {
        this.baseUrl = baseUrl;
        this.src = src;
    }

    async getRtcConfig() {
        // No ICE servers: go2rtc is expected to be reachable on the local network
        return { configuration: {}, dataChannel: null };
    }

    createSession() {
        return new HttpSession(this.baseUrl, this.src);
    }
}

// ---------------------------------------------------------------------------

export class Go2RtcClient {
    constructor(config, options) {
        this.signaling = config.builtin
            ? new HassSignaling(config.resource)
            : new HttpSignaling(`/api/ha-video-source/${config.entry_id || 'default'}`, config.resource);
        this.pc = null;
        this.session = null;
        this.generation = 0; // invalidates callbacks from stale sessions
        this.connectionState = 'disconnected';
        this.onTrackCb = options?.onTrackCb || null;
        this.connectionStateCb = options?.connectionStateCb || null;
        this.retryCb = options?.retryCb || null;
        this.twoWayAudioErrorCb = options?.twoWayAudioErrorCb || null;

        // Backchannel (two-way audio) state
        this.backchannelActive = false;
        this.backchannelGeneration = 0;
        this.backchannel = null; // { stream, pc, session } of the current talk session
    }

    setDelay(delay) {
        return new Promise((res) => setTimeout(res, delay || 0));
    }

    // Limit the offer to H.264 (plus its retransmission/FEC helper codecs). Without this,
    // newer browsers also offer H.265/AV1/VP9 and go2rtc may answer with a codec that
    // the browser connects to but never decodes (packets arrive, framesDecoded stays 0).
    preferH264(transceiver) {
        try {
            const codecs = RTCRtpReceiver.getCapabilities?.('video')?.codecs;
            if (!codecs || !transceiver.setCodecPreferences) return;
            const h264 = codecs.filter((c) => c.mimeType.toLowerCase() === 'video/h264');
            if (!h264.length) return;
            const helpers = codecs.filter((c) => /\/(rtx|red|ulpfec)$/i.test(c.mimeType));
            transceiver.setCodecPreferences([...h264, ...helpers]);
        } catch (e) {
            console.log(`go2rtc: unable to set codec preferences: ${e}`);
        }
    }

    async start() {
        const gen = ++this.generation;
        const current = () => gen === this.generation;
        try {
            const { configuration, dataChannel } = await this.signaling.getRtcConfig();
            if (!current()) return;

            const pc = new RTCPeerConnection(configuration);
            this.pc = pc;
            if (dataChannel) {
                pc.createDataChannel(dataChannel);
            }
            const videoTransceiver = pc.addTransceiver('video', { direction: 'recvonly' });
            this.preferH264(videoTransceiver);
            pc.addTransceiver('audio', { direction: 'recvonly' });

            const session = this.signaling.createSession();
            this.session = session;

            pc.ontrack = (evt) => {
                if (current() && this.onTrackCb) this.onTrackCb(evt);
            };
            pc.oniceconnectionstatechange = () => {
                if (current()) this.onConnectionState();
            };
            pc.onicecandidate = (evt) => {
                if (!current() || !evt.candidate) return;
                session.sendCandidate(evt.candidate);
            };

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            if (!session.trickle) {
                await waitForIceGathering(pc);
            }
            if (!current()) return;

            await session.start(session.trickle ? offer.sdp : pc.localDescription.sdp, {
                onAnswer: (sdp) => {
                    if (current()) this.onAnswer(sdp);
                },
                onCandidate: (candidate) => {
                    if (current()) {
                        pc.addIceCandidate(candidate).catch((err) => {
                            console.log(`go2rtc: error adding candidate: ${err}`);
                        });
                    }
                },
                onError: (message) => {
                    if (current()) this.handleConnectionError(message);
                },
            });
            if (!current()) {
                session.close();
            }
        } catch (err) {
            if (current()) {
                return this.handleConnectionError(err);
            }
        }
    }

    async onAnswer(sdp) {
        try {
            await this.pc?.setRemoteDescription({ type: 'answer', sdp });
        } catch (err) {
            this.handleConnectionError(err);
        }
    }

    onConnectionState() {
        const state = this.pc ? this.pc.iceConnectionState : 'disconnected';
        this.connectionState = state;
        console.log('go2rtc peer connection state:', state);
        if (this.connectionStateCb) {
            this.connectionStateCb(state);
        }
        if (this.isDisconnected()) {
            console.log('go2rtc restarting...');
            return this.scheduleRestart();
        }
        return Promise.resolve(state);
    }

    isDisconnected() {
        return ['failed', 'closed', 'disconnected'].indexOf(this.connectionState) > -1;
    }

    handleConnectionError(err) {
        console.log('go2rtc error: ' + (typeof err === 'string' ? err : (err?.message || JSON.stringify(err))));
        if (this.retryCb && !this.retryCb(this.pc)) {
            return err;
        }
        const gen = this.generation;
        return this.setDelay(5000).then(() => {
            if (gen === this.generation) return this.scheduleRestart();
        });
    }

    closeSession() {
        if (this.session) {
            this.session.close();
            this.session = null;
        }
    }

    scheduleRestart() {
        return this.stop().then(() => {
            this.connectionState = 'disconnected';
            return this.start();
        });
    }

    stop() {
        this.generation++; // ignore anything from the old session
        this.stopTwoWayAudio();
        this.closeSession();
        if (this.pc !== null) {
            this.pc.ontrack = null;
            this.pc.onicecandidate = null;
            this.pc.oniceconnectionstatechange = null;
            this.pc.close();
            this.pc = null;
        }
        return Promise.resolve();
    }

    // -----------------------------------------------------------------------
    // Two-way audio: a separate, short-lived send-only session that carries the
    // microphone to go2rtc, which forwards it to the camera's audio backchannel.
    // The main (receive) session is untouched.
    // -----------------------------------------------------------------------

    async startTwoWayAudio() {
        if (this.backchannelActive) {
            return;
        }
        this.backchannelActive = true;
        const gen = ++this.backchannelGeneration;
        const current = () => gen === this.backchannelGeneration && this.backchannelActive;
        let bc = null;

        try {
            if (!navigator.mediaDevices?.getUserMedia) {
                this.backchannelActive = false;
                this.reportTwoWayAudioError('Two-way audio requires a secure (HTTPS) connection to Home Assistant');
                return;
            }

            // Request the microphone and fetch the RTC config in parallel to minimise the
            // delay between pressing the button and audio being sent.
            const configPromise = this.signaling.getRtcConfig();

            let stream;
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                    },
                    video: false,
                });
            } catch (e) {
                if (gen === this.backchannelGeneration) {
                    this.backchannelActive = false;
                    this.reportTwoWayAudioError(
                        e?.name === 'NotAllowedError'
                            ? 'Microphone access was denied'
                            : `Unable to access the microphone (${e?.name || e})`
                    );
                }
                return;
            }

            bc = { stream, pc: null, session: null };
            if (!current()) {
                this.destroyBackchannel(bc);
                return;
            }
            this.backchannel = bc;

            const { configuration, dataChannel } = await configPromise;
            if (!current()) {
                this.destroyBackchannel(bc);
                return;
            }

            const pc = new RTCPeerConnection(configuration);
            bc.pc = pc;
            if (dataChannel) {
                pc.createDataChannel(dataChannel);
            }
            stream.getAudioTracks().forEach((track) => {
                pc.addTransceiver(track, { direction: 'sendonly' });
            });

            const session = this.signaling.createSession();
            bc.session = session;

            pc.onicecandidate = (evt) => {
                if (!current() || !evt.candidate) return;
                session.sendCandidate(evt.candidate);
            };
            pc.oniceconnectionstatechange = () => {
                if (!current()) return;
                console.log(`go2rtc backchannel connection state: ${pc.iceConnectionState}`);
                if (pc.iceConnectionState === 'failed') {
                    this.stopTwoWayAudio();
                    this.reportTwoWayAudioError('Two-way audio connection failed');
                }
            };

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            if (!session.trickle) {
                await waitForIceGathering(pc);
            }
            if (!current()) {
                this.destroyBackchannel(bc);
                return;
            }

            await session.start(session.trickle ? offer.sdp : pc.localDescription.sdp, {
                onAnswer: async (sdp) => {
                    if (!current()) return;
                    try {
                        await pc.setRemoteDescription({ type: 'answer', sdp });
                        // If the camera exposes no audio backchannel, go2rtc rejects/inactivates
                        // the audio section and our microphone audio goes nowhere.
                        const direction = pc.getTransceivers()[0]?.currentDirection;
                        if (current() && !['sendonly', 'sendrecv'].includes(direction)) {
                            this.stopTwoWayAudio();
                            this.reportTwoWayAudioError('This camera does not support two-way audio');
                        }
                    } catch (err) {
                        console.error(`go2rtc backchannel answer error: ${err}`);
                        if (current()) {
                            this.stopTwoWayAudio();
                            this.reportTwoWayAudioError('Two-way audio negotiation failed');
                        }
                    }
                },
                onCandidate: (candidate) => {
                    if (current()) {
                        pc.addIceCandidate(candidate).catch((err) => {
                            console.log(`go2rtc backchannel: error adding candidate: ${err}`);
                        });
                    }
                },
                onError: (message) => {
                    if (current()) {
                        this.stopTwoWayAudio();
                        this.reportTwoWayAudioError(`Two-way audio error: ${message}`.trim());
                    }
                },
            });
            if (!current()) {
                this.destroyBackchannel(bc);
            }
        } catch (err) {
            console.error(`go2rtc backchannel error: ${err?.message || err}`);
            if (bc) {
                this.destroyBackchannel(bc);
            }
            if (gen === this.backchannelGeneration) {
                this.stopTwoWayAudio();
                this.reportTwoWayAudioError('Two-way audio failed to start');
            }
        }
    }

    reportTwoWayAudioError(message) {
        console.error(`go2rtc: ${message}`);
        if (this.twoWayAudioErrorCb) {
            this.twoWayAudioErrorCb(message);
        }
    }

    // Tears down one specific talk session. Operates on the session object (not on
    // this.backchannel) so a stale, in-flight start can never kill a newer one.
    destroyBackchannel(bc) {
        if (!bc) return;
        bc.session?.close();
        bc.stream?.getTracks().forEach((t) => t.stop());
        if (bc.pc) {
            bc.pc.onicecandidate = null;
            bc.pc.oniceconnectionstatechange = null;
            bc.pc.close();
        }
        if (this.backchannel === bc) {
            this.backchannel = null;
        }
    }

    stopTwoWayAudio() {
        if (this.backchannel) {
            console.log('go2rtc backchannel stopped (microphone released, session closed)');
        }
        this.backchannelActive = false;
        this.backchannelGeneration++;
        this.destroyBackchannel(this.backchannel);
    }
}
