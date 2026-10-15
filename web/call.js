import { sharedAudioContext } from './sound.js';

// Full-mesh WebRTC call: one RTCPeerConnection per other participant.
//
// For each pair, the member with the lexically smaller id is the initiator. It
// creates one audio and one video transceiver and sends all offers, including
// ICE restarts, and the other side only answers. That rules out offer collisions.
// Turning the camera or screen share on or off later is a replaceTrack on the
// existing video sender, so no renegotiation is needed. Signalling goes through
// `signal(to, payload)`, which the app encrypts with the room key. The server
// therefore can't swap DTLS fingerprints, so it can't intercept the media.
export class Call {
  constructor({ me, iceServers, signal, onChange }) {
    this.me = me;
    this.iceServers = iceServers;
    this.signal = signal;
    this.onChange = onChange;
    this.peers = new Map();
    this.local = new MediaStream();
    this.micTrack = null;
    this.camTrack = null;
    this.screenTrack = null;
    this.mic = true;
    this.meters = new Map();
    this.ended = false;
  }

  async start({ video }) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: video ? cameraConstraints() : false,
    });
    this.micTrack = stream.getAudioTracks()[0] ?? null;
    this.camTrack = stream.getVideoTracks()[0] ?? null;
    this.rebuildLocal();
    this.watchLevel(this.me, this.local);
  }

  get camOn() {
    return !!this.camTrack;
  }

  get screenOn() {
    return !!this.screenTrack;
  }

  videoTrack() {
    return this.screenTrack ?? this.camTrack;
  }

  state() {
    return { type: 'state', mic: this.mic, cam: this.camOn, screen: this.screenOn };
  }

  rebuildLocal() {
    for (const track of this.local.getTracks()) this.local.removeTrack(track);
    if (this.micTrack) this.local.addTrack(this.micTrack);
    if (this.videoTrack()) this.local.addTrack(this.videoTrack());
  }

  // Brings peer connections in line with who is currently in the call.
  sync(members) {
    if (this.ended) return;
    const inCall = new Set(members.filter((m) => m.inCall && m.id !== this.me).map((m) => m.id));
    for (const id of inCall) if (!this.peers.has(id)) this.createPeer(id);
    for (const id of this.peers.keys()) if (!inCall.has(id)) this.closePeer(id);
    this.onChange();
  }

  createPeer(id) {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer = {
      id,
      pc,
      initiator: this.me < id,
      stream: new MediaStream(),
      transceivers: {},
      state: { mic: true, cam: false, screen: false },
      connection: 'new',
    };
    this.peers.set(id, peer);

    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.signal(id, { type: 'ice', candidate: candidate.toJSON() });
    };
    pc.ontrack = ({ track }) => {
      peer.stream.addTrack(track);
      if (track.kind === 'audio') this.watchLevel(id, peer.stream);
      this.onChange();
    };
    pc.onconnectionstatechange = () => {
      peer.connection = pc.connectionState;
      if (pc.connectionState === 'connected') this.signal(id, this.state());
      if (pc.connectionState === 'failed' && peer.initiator) pc.restartIce();
      this.onChange();
    };

    if (peer.initiator) {
      peer.transceivers.audio = pc.addTransceiver(this.micTrack ?? 'audio', { direction: 'sendrecv' });
      peer.transceivers.video = pc.addTransceiver(this.videoTrack() ?? 'video', { direction: 'sendrecv' });
      pc.onnegotiationneeded = async () => {
        if (pc.signalingState !== 'stable') return;
        await pc.setLocalDescription();
        this.signal(id, { type: 'offer', sdp: pc.localDescription.sdp });
      };
    }
    this.signal(id, this.state());
    return peer;
  }

  async handleSignal(from, msg) {
    if (this.ended) return;
    const peer = this.peers.get(from) ?? this.createPeer(from);
    const { pc } = peer;
    switch (msg.type) {
      case 'offer':
        if (peer.initiator) return;
        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
        // The first offer creates our transceivers, so attach local tracks to them.
        for (const transceiver of pc.getTransceivers()) {
          const kind = transceiver.receiver.track.kind;
          if (peer.transceivers[kind]) continue;
          peer.transceivers[kind] = transceiver;
          transceiver.direction = 'sendrecv';
          await transceiver.sender.replaceTrack(kind === 'audio' ? this.micTrack : this.videoTrack());
        }
        await pc.setLocalDescription();
        this.signal(from, { type: 'answer', sdp: pc.localDescription.sdp });
        break;
      case 'answer':
        if (peer.initiator && pc.signalingState === 'have-local-offer') {
          await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        }
        break;
      case 'ice':
        try {
          await pc.addIceCandidate(msg.candidate);
        } catch {
          // Candidates for a superseded negotiation are harmless to drop.
        }
        break;
      case 'state':
        peer.state = { mic: !!msg.mic, cam: !!msg.cam, screen: !!msg.screen };
        this.onChange();
        break;
    }
  }

  closePeer(id) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.pc.close();
    this.peers.delete(id);
    this.unwatchLevel(id);
  }

  broadcastState() {
    for (const id of this.peers.keys()) this.signal(id, this.state());
    this.onChange();
  }

  async updateVideoSenders() {
    this.rebuildLocal();
    const track = this.videoTrack();
    await Promise.all(
      [...this.peers.values()].map((peer) => peer.transceivers.video?.sender.replaceTrack(track).catch(() => {})),
    );
    this.broadcastState();
  }

  toggleMic() {
    this.mic = !this.mic;
    if (this.micTrack) this.micTrack.enabled = this.mic;
    this.broadcastState();
  }

  async toggleCamera() {
    if (this.camTrack) {
      this.camTrack.stop();
      this.camTrack = null;
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints() });
      this.camTrack = stream.getVideoTracks()[0];
    }
    await this.updateVideoSenders();
  }

  async toggleScreen() {
    if (this.screenTrack) {
      this.screenTrack.stop();
      this.screenTrack = null;
    } else {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15 } }, audio: false });
      this.screenTrack = stream.getVideoTracks()[0];
      this.screenTrack.contentHint = 'detail';
      // The browser's own "Stop sharing" button ends the track.
      this.screenTrack.addEventListener('ended', () => {
        if (this.screenTrack?.readyState === 'ended') {
          this.screenTrack = null;
          this.updateVideoSenders();
        }
      });
    }
    await this.updateVideoSenders();
  }

  // Voice activity: a smoothed RMS level per participant, read by the UI each frame.
  watchLevel(id, stream) {
    if (this.meters.has(id) || !stream.getAudioTracks().length) return;
    try {
      const ac = sharedAudioContext();
      const source = ac.createMediaStreamSource(stream);
      const analyser = ac.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      this.meters.set(id, { source, analyser, data: new Uint8Array(analyser.fftSize), level: 0 });
    } catch {
      // No Web Audio: speaking indicators simply stay off.
    }
  }

  unwatchLevel(id) {
    const meter = this.meters.get(id);
    if (!meter) return;
    meter.source.disconnect();
    this.meters.delete(id);
  }

  level(id) {
    const meter = this.meters.get(id);
    if (!meter) return 0;
    if (id === this.me && !this.mic) return 0;
    meter.analyser.getByteTimeDomainData(meter.data);
    let sum = 0;
    for (const v of meter.data) sum += (v - 128) ** 2;
    const rms = Math.sqrt(sum / meter.data.length) / 128;
    meter.level = Math.max(rms, meter.level * 0.85);
    return meter.level;
  }

  hangup() {
    this.ended = true;
    for (const id of [...this.peers.keys()]) this.closePeer(id);
    for (const id of [...this.meters.keys()]) this.unwatchLevel(id);
    for (const track of [this.micTrack, this.camTrack, this.screenTrack]) track?.stop();
    this.micTrack = this.camTrack = this.screenTrack = null;
  }
}

function cameraConstraints() {
  return { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: 'user' };
}
