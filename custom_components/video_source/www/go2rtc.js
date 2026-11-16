// WebRTC client for go2RTC streams provided by Home Assistant.
//
// Home Assistant's built-in go2rtc is not exposed directly to browsers; the supported
// way to negotiate a WebRTC session is the `camera/webrtc/*` websocket API, which proxies
// the offer/answer/candidates to go2rtc. `config.resource` must therefore be a camera
// entity_id (e.g. "camera.front_door").
//
// This class exposes the same interface as WHEPClient (webrtc_v2.js).

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

export class Go2RtcClient {
    constructor(config, options) {
        this.entityId = config.resource;
        this.pc = null;
        this.unsubscribe = null;
        this.sessionId = null;
        this.generation = 0; // invalidates callbacks from stale sessions
        this.connectionState = 'disconnected';
        this.onTrackCb = options?.onTrackCb || null;
        this.connectionStateCb = options?.connectionStateCb || null;
        this.retryCb = options?.retryCb || null;
    }

    setDelay(delay) {
        return new Promise((res) => setTimeout(res, delay || 0));
    }

    async start() {
        const gen = ++this.generation;
        try {
            const conn = await getHassConnection();
            if (gen !== this.generation) return;

            let rtcConfig = {};
            let dataChannel = null;
            try {
                const clientConfig = await conn.sendMessagePromise({
                    type: 'camera/webrtc/get_client_config',
                    entity_id: this.entityId,
                });
                rtcConfig = clientConfig?.configuration || {};
                dataChannel = clientConfig?.dataChannel || null;
            } catch (e) {
                console.log(`go2rtc: unable to get client config, using defaults: ${JSON.stringify(e)}`);
            }
            if (gen !== this.generation) return;

            const pc = new RTCPeerConnection(rtcConfig);
            this.pc = pc;
            if (dataChannel) {
                pc.createDataChannel(dataChannel);
            }
            pc.addTransceiver('video', { direction: 'recvonly' });
            pc.addTransceiver('audio', { direction: 'recvonly' });

            pc.ontrack = (evt) => {
                if (gen === this.generation && this.onTrackCb) this.onTrackCb(evt);
            };
            pc.oniceconnectionstatechange = () => {
                if (gen === this.generation) this.onConnectionState();
            };
            pc.onicecandidate = (evt) => {
                if (gen !== this.generation || !evt.candidate) return;
                this.sendCandidate(conn, evt.candidate);
            };

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            if (gen !== this.generation) return;

            this.unsubscribe = await conn.subscribeMessage(
                (msg) => {
                    if (gen === this.generation) this.onServerMessage(conn, msg);
                },
                {
                    type: 'camera/webrtc/offer',
                    entity_id: this.entityId,
                    offer: offer.sdp,
                }
            );
            if (gen !== this.generation) {
                this.unsubscribeSession();
            }
        } catch (err) {
            if (gen === this.generation) {
                return this.handleConnectionError(err);
            }
        }
    }

    async sendCandidate(conn, candidate) {
        // Candidates can only be sent once the server has given us a session id
        if (!this.sessionId) {
            this.pendingCandidates = this.pendingCandidates || [];
            this.pendingCandidates.push(candidate);
            return;
        }
        try {
            await conn.sendMessagePromise({
                type: 'camera/webrtc/candidate',
                entity_id: this.entityId,
                session_id: this.sessionId,
                candidate: candidate.toJSON(),
            });
        } catch (e) {
            console.log(`go2rtc: error sending candidate: ${JSON.stringify(e)}`);
        }
    }

    async onServerMessage(conn, msg) {
        switch (msg?.type) {
            case 'session':
                this.sessionId = msg.session_id;
                if (this.pendingCandidates?.length) {
                    const pending = this.pendingCandidates;
                    this.pendingCandidates = [];
                    pending.forEach((c) => this.sendCandidate(conn, c));
                }
                break;
            case 'answer':
                try {
                    await this.pc?.setRemoteDescription({ type: 'answer', sdp: msg.answer });
                } catch (err) {
                    this.handleConnectionError(err);
                }
                break;
            case 'candidate':
                try {
                    if (msg.candidate?.candidate !== undefined) {
                        await this.pc?.addIceCandidate(msg.candidate);
                    }
                } catch (err) {
                    console.log(`go2rtc: error adding candidate: ${err}`);
                }
                break;
            case 'error':
                this.handleConnectionError(`${msg.code || 'error'}: ${msg.message || ''}`);
                break;
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

    unsubscribeSession() {
        if (this.unsubscribe) {
            try {
                this.unsubscribe();
            } catch (e) { /* ignore */ }
            this.unsubscribe = null;
        }
        this.sessionId = null;
        this.pendingCandidates = [];
    }

    scheduleRestart() {
        return this.stop().then(() => {
            this.connectionState = 'disconnected';
            return this.start();
        });
    }

    stop() {
        this.generation++; // ignore anything from the old session
        this.unsubscribeSession();
        if (this.pc !== null) {
            this.pc.ontrack = null;
            this.pc.onicecandidate = null;
            this.pc.oniceconnectionstatechange = null;
            this.pc.close();
            this.pc = null;
        }
        return Promise.resolve();
    }
}
