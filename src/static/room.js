(() => {
  const root = document.querySelector('#room')
  if (!root) return

  const roomId = root.dataset.roomId
  const role = root.dataset.role
  const isDj = role === 'dj'
  const djToken = root.dataset.djToken
  const peerId = crypto.randomUUID()

  const logElement = document.querySelector('#log')
  const connectionState = document.querySelector('#connection-state')
  const iceSummary = document.querySelector('#ice-summary')
  const mediaSummary = document.querySelector('#media-summary')
  const connectionHelp = document.querySelector('#connection-help')
  const peers = new Map()
  let socket
  let djPeerId
  let guestDataChannel
  let reservedIncomingBytes = 0

  const maxTrackBytes = 150 * 1024 * 1024
  const maxIncomingBytes = 200 * 1024 * 1024
  const maxIncomingChunkBytes = 64 * 1024
  const rtcConfig = {
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  }

  let audioContext
  let mixOutput
  let mediaDestination
  let monitorConnected = false
  const decks = {
    a: { buffer: null, source: null, gain: null, name: 'Empty' },
    b: { buffer: null, source: null, gain: null, name: 'Empty' },
  }

  function log(message) {
    const time = new Date().toLocaleTimeString()
    logElement.textContent += `[${time}] ${message}\n`
    logElement.scrollTop = logElement.scrollHeight
  }

  function setConnectionState(value) {
    connectionState.textContent = value
  }

  function connectSignaling() {
    if (socket && socket.readyState < WebSocket.CLOSING) return

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const params = new URLSearchParams({ room: roomId, peer: peerId, role })
    if (isDj) params.set('token', djToken)
    socket = new WebSocket(`${protocol}//${location.host}/ws?${params}`)

    socket.addEventListener('open', () => {
      setConnectionState('signaling')
      log(`Joined signaling as ${role} ${peerId.slice(0, 8)}`)
    })

    socket.addEventListener('message', async (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }

      try {
        await handleSignal(message)
      } catch (error) {
        log(`Signaling error: ${error.message}`)
        console.error(error)
      }
    })

    socket.addEventListener('close', (event) => {
      setConnectionState('offline')
      log(`Signaling closed (${event.code}) ${event.reason}`)
    })

    socket.addEventListener('error', () => log('Signaling socket error'))
  }

  async function handleSignal(message) {
    if (message.type === 'peers') {
      await handleRoster(message.peers)
      return
    }

    const from = message.from
    if (!from) return

    if (message.type === 'offer' && !isDj) {
      const peer = ensurePeer(from)
      djPeerId = from
      await peer.pc.setRemoteDescription(message.description)
      await flushCandidates(peer)
      await peer.pc.setLocalDescription(await peer.pc.createAnswer())
      sendSignal(from, { type: 'answer', description: peer.pc.localDescription })
      log('Answered DJ connection')
      return
    }

    if (message.type === 'answer' && isDj) {
      const peer = peers.get(from)
      if (!peer) return
      await peer.pc.setRemoteDescription(message.description)
      await flushCandidates(peer)
      log(`Connected signaling with guest ${from.slice(0, 8)}`)
      return
    }

    if (message.type === 'ice') {
      const peer = ensurePeer(from)
      if (!message.candidate) return
      if (peer.pc.remoteDescription) {
        await peer.pc.addIceCandidate(message.candidate)
      } else {
        peer.pendingCandidates.push(message.candidate)
      }
    }
  }

  async function handleRoster(roster) {
    const remotePeers = roster.filter((peer) => peer.id !== peerId)
    const liveIds = new Set(remotePeers.map((peer) => peer.id))

    for (const [id, peer] of peers) {
      if (!liveIds.has(id)) {
        clearTimeout(peer.connectionTimer)
        peer.pc.close()
        peers.delete(id)
      }
    }

    if (isDj) {
      for (const remote of remotePeers.filter((peer) => peer.role === 'guest')) {
        const peer = ensurePeer(remote.id)
        if (!peer.offered) await offerToGuest(remote.id, peer)
      }
    } else {
      const dj = remotePeers.find((peer) => peer.role === 'dj')
      djPeerId = dj?.id
      setConnectionState(dj ? 'DJ found' : 'waiting for DJ')
    }
    updateConnectionBadge()
    renderDiagnostics()
  }

  function ensurePeer(remoteId) {
    const existing = peers.get(remoteId)
    if (existing) return existing

    const pc = new RTCPeerConnection(rtcConfig)
    const peer = {
      remoteId,
      pc,
      pendingCandidates: [],
      offered: false,
      channel: null,
      connectionTimer: null,
      lastSample: null,
      iceText: 'Checking…',
      mediaText: 'Waiting for samples',
    }
    peers.set(remoteId, peer)
    scheduleConnectionTimeout(peer)

    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) {
        sendSignal(remoteId, { type: 'ice', candidate: event.candidate })
      }
    })

    pc.addEventListener('connectionstatechange', () => {
      log(`Peer ${remoteId.slice(0, 8)}: ${pc.connectionState}`)
      updateConnectionBadge()

      if (pc.connectionState === 'connected') {
        clearTimeout(peer.connectionTimer)
        connectionHelp.classList.add('hidden')
        updatePeerStats(peer)
      } else if (pc.connectionState === 'failed') {
        showConnectionProblem(peer, 'ICE negotiation failed')
      } else if (pc.connectionState === 'disconnected') {
        scheduleConnectionTimeout(peer, 10_000)
      }
    })

    pc.addEventListener('icecandidateerror', (event) => {
      log(`ICE server error ${event.errorCode}: ${event.errorText || 'unknown error'}`)
    })

    if (isDj) {
      const track = mediaDestination.stream.getAudioTracks()[0]
      track.contentHint = 'music'
      const sender = pc.addTrack(track, mediaDestination.stream)
      preferMusicBitrate(sender)

      const channel = pc.createDataChannel('tracks', { ordered: true })
      peer.channel = channel
      receiveTracks(channel, remoteId)
    } else {
      pc.addEventListener('track', (event) => {
        const audio = document.querySelector('#live-audio')
        audio.srcObject = event.streams[0] || new MediaStream([event.track])
        audio.play().catch(() => log('Autoplay blocked; press play on the audio control'))
        log('Live mix track received')
      })

      pc.addEventListener('datachannel', (event) => {
        guestDataChannel = event.channel
        prepareGuestChannel(guestDataChannel)
      })
    }

    return peer
  }

  function scheduleConnectionTimeout(peer, delay = 15_000) {
    clearTimeout(peer.connectionTimer)
    peer.connectionTimer = setTimeout(() => {
      if (peer.pc.connectionState !== 'connected') {
        showConnectionProblem(peer, 'Direct connection timed out')
      }
    }, delay)
  }

  function showConnectionProblem(peer, reason) {
    peer.iceText = `${reason}; no viable direct path`
    connectionHelp.classList.remove('hidden')
    setConnectionState('connection failed')
    renderDiagnostics()
    log(`${reason} with ${peer.remoteId.slice(0, 8)}. This network may require TURN.`)
  }

  function updateConnectionBadge() {
    const all = Array.from(peers.values())
    const connected = all.filter((peer) => peer.pc.connectionState === 'connected').length

    if (isDj) {
      setConnectionState(all.length ? `${connected}/${all.length} connected` : 'waiting for guests')
    } else if (connected) {
      setConnectionState('connected')
    }
  }

  async function updatePeerStats(peer) {
    if (peer.pc.connectionState !== 'connected') return

    try {
      const stats = await peer.pc.getStats()
      const transport = Array.from(stats.values()).find(
        (stat) => stat.type === 'transport' && stat.selectedCandidatePairId,
      )
      let pair = transport ? stats.get(transport.selectedCandidatePairId) : null
      if (!pair) {
        pair = Array.from(stats.values()).find(
          (stat) => stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated,
        )
      }

      if (pair) {
        const local = stats.get(pair.localCandidateId)
        const remote = stats.get(pair.remoteCandidateId)
        const localType = local?.candidateType || 'unknown'
        const remoteType = remote?.candidateType || 'unknown'
        const protocol = local?.protocol || remote?.protocol || 'unknown'
        peer.iceText = `${localType} ↔ ${remoteType} / ${protocol}`

        const rtt = Number.isFinite(pair.currentRoundTripTime)
          ? `${Math.round(pair.currentRoundTripTime * 1000)} ms RTT`
          : 'RTT pending'
        const bytes = Array.from(stats.values())
          .filter((stat) =>
            stat.type === (isDj ? 'outbound-rtp' : 'inbound-rtp') &&
            (stat.kind === 'audio' || stat.mediaType === 'audio'),
          )
          .reduce(
            (total, stat) => total + (isDj ? stat.bytesSent || 0 : stat.bytesReceived || 0),
            0,
          )
        const now = performance.now()
        let bitrate = 'sampling bitrate'
        if (peer.lastSample && now > peer.lastSample.at) {
          const bits = (bytes - peer.lastSample.bytes) * 8
          const seconds = (now - peer.lastSample.at) / 1000
          bitrate = `${Math.max(0, Math.round(bits / seconds / 1000))} kbps`
        }
        peer.lastSample = { bytes, at: now }
        peer.mediaText = `${bitrate} · ${rtt}`
      }
    } catch (error) {
      log(`Stats error for ${peer.remoteId.slice(0, 8)}: ${error.message}`)
    }

    renderDiagnostics()
  }

  function renderDiagnostics() {
    const active = Array.from(peers.values()).filter(
      (peer) => peer.pc.connectionState !== 'closed',
    )
    if (!active.length) {
      iceSummary.textContent = 'Not connected'
      mediaSummary.textContent = 'Waiting for samples'
      return
    }

    const label = (peer) => isDj ? `${peer.remoteId.slice(0, 8)}: ` : ''
    iceSummary.textContent = active.map((peer) => `${label(peer)}${peer.iceText}`).join(' | ')
    mediaSummary.textContent = active.map((peer) => `${label(peer)}${peer.mediaText}`).join(' | ')
  }

  async function updateConnectedStats() {
    await Promise.all(Array.from(peers.values(), updatePeerStats))
  }

  async function offerToGuest(remoteId, peer) {
    peer.offered = true
    await peer.pc.setLocalDescription(await peer.pc.createOffer())
    sendSignal(remoteId, { type: 'offer', description: peer.pc.localDescription })
    log(`Offered media connection to ${remoteId.slice(0, 8)}`)
  }

  async function flushCandidates(peer) {
    for (const candidate of peer.pendingCandidates.splice(0)) {
      await peer.pc.addIceCandidate(candidate)
    }
  }

  function sendSignal(to, payload) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ ...payload, to }))
  }

  async function preferMusicBitrate(sender) {
    try {
      const parameters = sender.getParameters()
      if (!parameters.encodings?.length) parameters.encodings = [{}]
      parameters.encodings[0].maxBitrate = 192_000
      await sender.setParameters(parameters)
    } catch (error) {
      log(`Could not set audio bitrate: ${error.message}`)
    }
  }

  async function startDjEngine() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext
    audioContext = new AudioContextClass({ latencyHint: 'playback', sampleRate: 48000 })
    mediaDestination = audioContext.createMediaStreamDestination()
    mixOutput = audioContext.createDynamicsCompressor()
    mixOutput.connect(mediaDestination)

    decks.a.gain = audioContext.createGain()
    decks.b.gain = audioContext.createGain()
    decks.a.gain.connect(mixOutput)
    decks.b.gain.connect(mixOutput)
    updateCrossfader()
    updateMonitor()

    await audioContext.resume()
    document.querySelector('#start-engine').disabled = true
    document.querySelector('#engine-state').textContent = `Running at ${audioContext.sampleRate} Hz`
    log('DJ audio graph started')
    connectSignaling()
  }

  function updateMonitor() {
    if (!mixOutput || !audioContext) return
    const enabled = document.querySelector('#monitor-output').checked
    if (enabled && !monitorConnected) {
      mixOutput.connect(audioContext.destination)
      monitorConnected = true
    } else if (!enabled && monitorConnected) {
      mixOutput.disconnect(audioContext.destination)
      monitorConnected = false
    }
  }

  function updateCrossfader() {
    if (!decks.a.gain || !decks.b.gain) return
    const value = Number(document.querySelector('#crossfader').value)
    const angle = ((value + 1) * Math.PI) / 4
    decks.a.gain.gain.setValueAtTime(Math.cos(angle), audioContext.currentTime)
    decks.b.gain.gain.setValueAtTime(Math.sin(angle), audioContext.currentTime)
  }

  async function decodeIntoDeck(deckName, bytes, name) {
    if (!audioContext) throw new Error('Start the DJ engine first')
    const deck = decks[deckName]
    document.querySelector(`#deck-${deckName}-name`).textContent = `Decoding ${name}…`
    deck.buffer = await audioContext.decodeAudioData(bytes)
    deck.name = name
    document.querySelector(`#deck-${deckName}-name`).textContent = `${name} — ${formatDuration(deck.buffer.duration)}`
    document.querySelector(`#deck-${deckName}-play`).disabled = false
    log(`Loaded ${name} into deck ${deckName.toUpperCase()}`)
  }

  function playDeck(deckName) {
    const deck = decks[deckName]
    if (!deck.buffer) return
    stopDeck(deckName)
    const source = audioContext.createBufferSource()
    source.buffer = deck.buffer
    source.connect(deck.gain)
    source.addEventListener('ended', () => {
      if (deck.source === source) {
        deck.source = null
        document.querySelector(`#deck-${deckName}-stop`).disabled = true
      }
    })
    source.start(audioContext.currentTime + 0.03)
    deck.source = source
    document.querySelector(`#deck-${deckName}-stop`).disabled = false
    log(`Playing deck ${deckName.toUpperCase()}: ${deck.name}`)
  }

  function stopDeck(deckName) {
    const deck = decks[deckName]
    if (!deck.source) return
    try {
      deck.source.stop()
    } catch {}
    deck.source.disconnect()
    deck.source = null
    document.querySelector(`#deck-${deckName}-stop`).disabled = true
  }

  function receiveTracks(channel, remoteId) {
    channel.binaryType = 'arraybuffer'
    let transfer = null

    const releaseReservation = (item) => {
      if (!item?.reserved) return
      item.reserved = false
      reservedIncomingBytes = Math.max(0, reservedIncomingBytes - item.size)
    }

    const rejectTransfer = (reason) => {
      releaseReservation(transfer)
      transfer = null
      log(`Rejected track from ${remoteId.slice(0, 8)}: ${reason}`)
      channel.close()
    }

    channel.addEventListener('open', () => log(`Track channel open with ${remoteId.slice(0, 8)}`))
    channel.addEventListener('close', () => {
      releaseReservation(transfer)
      transfer = null
      log(`Track channel closed with ${remoteId.slice(0, 8)}`)
    })
    channel.addEventListener('message', async (event) => {
      if (typeof event.data === 'string') {
        if (event.data.length > 4_096) {
          rejectTransfer('metadata is too large')
          return
        }

        let message
        try {
          message = JSON.parse(event.data)
        } catch {
          rejectTransfer('invalid metadata')
          return
        }

        if (message.type === 'track-start') {
          const validId = typeof message.id === 'string' && /^[a-zA-Z0-9-]{1,64}$/.test(message.id)
          const validName = typeof message.name === 'string' && message.name.length > 0 && message.name.length <= 255
          const validSize = Number.isSafeInteger(message.size) && message.size > 0 && message.size <= maxTrackBytes

          if (transfer) return rejectTransfer('overlapping transfers are not allowed')
          if (!validId || !validName || !validSize) return rejectTransfer('invalid track declaration')
          if (reservedIncomingBytes + message.size > maxIncomingBytes) {
            return rejectTransfer('DJ receive buffer is full')
          }

          transfer = {
            id: message.id,
            name: message.name,
            size: message.size,
            chunks: [],
            received: 0,
            reserved: true,
          }
          reservedIncomingBytes += message.size
          log(`Receiving ${message.name} (${formatBytes(message.size)})`)
        } else if (message.type === 'track-end') {
          if (!transfer || transfer.id !== message.id) {
            return rejectTransfer('unexpected transfer end')
          }
          if (transfer.received !== transfer.size) {
            return rejectTransfer(`incomplete transfer: ${transfer.received}/${transfer.size} bytes`)
          }

          const completed = transfer
          transfer = null
          try {
            const bytes = await new Blob(completed.chunks).arrayBuffer()
            const targetDeck = decks.a.buffer ? 'b' : 'a'
            await decodeIntoDeck(targetDeck, bytes, completed.name)
          } catch (error) {
            log(`Decode failed: ${error.message}`)
          } finally {
            releaseReservation(completed)
          }
        }
        return
      }

      if (!transfer) return
      const chunk = event.data instanceof ArrayBuffer
        ? event.data
        : event.data instanceof Blob
          ? await event.data.arrayBuffer()
          : null
      if (!chunk) return rejectTransfer('unsupported binary message')
      if (chunk.byteLength === 0 || chunk.byteLength > maxIncomingChunkBytes) {
        return rejectTransfer('invalid chunk size')
      }
      if (transfer.received + chunk.byteLength > transfer.size) {
        return rejectTransfer('received more bytes than declared')
      }

      transfer.chunks.push(chunk)
      transfer.received += chunk.byteLength
    })
  }

  function prepareGuestChannel(channel) {
    channel.binaryType = 'arraybuffer'
    const sendButton = document.querySelector('#send-track')
    const fileInput = document.querySelector('#guest-file')

    const update = () => {
      sendButton.disabled = channel.readyState !== 'open' || !fileInput.files.length
    }

    channel.addEventListener('open', () => {
      document.querySelector('#transfer-state').textContent = 'Ready to send.'
      log('Track data channel open')
      update()
    })
    channel.addEventListener('close', () => {
      document.querySelector('#transfer-state').textContent = 'Track channel closed.'
      update()
    })
    fileInput.addEventListener('change', update)
    sendButton.addEventListener('click', () => sendGuestTrack(channel))
    update()
  }

  async function sendGuestTrack(channel) {
    const file = document.querySelector('#guest-file').files[0]
    if (!file || channel.readyState !== 'open') return
    if (file.size > maxTrackBytes) {
      document.querySelector('#transfer-state').textContent = 'Prototype limit: 150 MB.'
      return
    }

    const button = document.querySelector('#send-track')
    const progress = document.querySelector('#transfer-progress')
    const state = document.querySelector('#transfer-state')
    const id = crypto.randomUUID()
    const chunkSize = 32 * 1024

    button.disabled = true
    progress.value = 0
    channel.bufferedAmountLowThreshold = 256 * 1024
    channel.send(JSON.stringify({ type: 'track-start', id, name: file.name, size: file.size, mime: file.type }))

    try {
      for (let offset = 0; offset < file.size; offset += chunkSize) {
        if (channel.readyState !== 'open') throw new Error('Data channel closed')
        await waitForBuffer(channel)
        const chunk = await file.slice(offset, offset + chunkSize).arrayBuffer()
        channel.send(chunk)
        progress.value = Math.min(1, (offset + chunk.byteLength) / file.size)
        state.textContent = `Sending ${Math.round(progress.value * 100)}% — ${formatBytes(file.size)}`
      }

      await waitForBuffer(channel)
      channel.send(JSON.stringify({ type: 'track-end', id }))
      state.textContent = `Sent ${file.name}`
      log(`Sent ${file.name} to the DJ`)
    } catch (error) {
      state.textContent = `Transfer failed: ${error.message}`
      log(state.textContent)
    } finally {
      button.disabled = channel.readyState !== 'open'
    }
  }

  async function waitForBuffer(channel) {
    while (channel.bufferedAmount > 1024 * 1024) {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Transfer buffer stalled')), 10_000)
        const onLow = () => {
          clearTimeout(timeout)
          channel.removeEventListener('bufferedamountlow', onLow)
          resolve()
        }
        channel.addEventListener('bufferedamountlow', onLow)
        if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) onLow()
      })
    }
  }

  function formatBytes(bytes) {
    return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }

  function formatDuration(seconds) {
    return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
  }

  setInterval(updateConnectedStats, 2_000)

  if (isDj) {
    document.querySelector('#start-engine').addEventListener('click', () => {
      startDjEngine().catch((error) => log(`Audio startup failed: ${error.message}`))
    })
    document.querySelector('#monitor-output').addEventListener('change', updateMonitor)
    document.querySelector('#crossfader').addEventListener('input', updateCrossfader)
    document.querySelector('#copy-invite').addEventListener('click', async () => {
      const url = `${location.origin}/rooms/${roomId}`
      await navigator.clipboard.writeText(url)
      document.querySelector('#copy-invite').textContent = 'Copied'
    })

    for (const deckName of ['a', 'b']) {
      document.querySelector(`#deck-${deckName}-file`).addEventListener('change', async (event) => {
        const file = event.target.files[0]
        if (!file) return
        try {
          await decodeIntoDeck(deckName, await file.arrayBuffer(), file.name)
        } catch (error) {
          log(`Decode failed: ${error.message}`)
        }
      })
      document.querySelector(`#deck-${deckName}-play`).addEventListener('click', () => playDeck(deckName))
      document.querySelector(`#deck-${deckName}-stop`).addEventListener('click', () => stopDeck(deckName))
    }
  } else {
    connectSignaling()
  }
})()
