(() => {
  const root = document.querySelector('#room')
  if (!root) return

  const roomId = root.dataset.roomId
  const ownerToken = root.dataset.ownerToken
  const peerId = crypto.randomUUID()
  const maxTrackBytes = 150 * 1024 * 1024
  let rtcConfig = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] }
  const peers = new Map()
  const localTracks = new Map()

  let socket
  let roomState = null
  let displayName = ''
  let audioContext
  let broadcastOutput
  let mediaDestination
  let audioUnlockDestination
  let pendingTrack = null
  let preparingEpoch = null
  let preparedTrack = null
  let activePlayback = null
  let toastTimer
  let rtcRefreshTimer

  const $ = (selector) => document.querySelector(selector)
  const logElement = $('#log')
  const connectionState = $('#connection-state')
  const iceSummary = $('#ice-summary')
  const mediaSummary = $('#media-summary')
  const connectionHelp = $('#connection-help')
  const remoteAudio = $('#remote-audio')
  const resumeAudioButton = $('#resume-audio')

  function log(message) {
    const time = new Date().toLocaleTimeString()
    logElement.textContent += `[${time}] ${message}\n`
    logElement.scrollTop = logElement.scrollHeight
  }

  function showToast(message) {
    const toast = $('#toast')
    toast.textContent = message
    toast.classList.remove('hidden')
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 4_000)
  }

  function setConnectionState(label, connected = false) {
    connectionState.querySelector('span').textContent = label
    connectionState.classList.toggle('connected', connected)
  }

  async function enterRoom(event) {
    event.preventDefault()
    const name = $('#display-name').value.trim().slice(0, 40)
    if (!name) return

    $('#enter-room').disabled = true
    $('#join-error').textContent = ''
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext
      audioContext = new AudioContextClass({ latencyHint: 'playback', sampleRate: 48_000 })
      mediaDestination = audioContext.createMediaStreamDestination()
      audioUnlockDestination = audioContext.createMediaStreamDestination()
      broadcastOutput = audioContext.createDynamicsCompressor()
      broadcastOutput.connect(mediaDestination)
      broadcastOutput.connect(audioContext.destination)
      remoteAudio.srcObject = audioUnlockDestination.stream
      await audioContext.resume()
      await remoteAudio.play()
      await loadRtcConfig()

      displayName = name
      try { localStorage.setItem('panster-display-name', name) } catch {}
      $('#join-gate').classList.add('hidden')
      $('#room-app').classList.remove('hidden')
      connectSignaling()
    } catch (error) {
      $('#join-error').textContent = `Audio could not start: ${error.message}`
      $('#enter-room').disabled = false
    }
  }

  async function loadRtcConfig() {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 5_000)
    try {
      const params = new URLSearchParams({ peer: peerId })
      const response = await fetch(`/rooms/${encodeURIComponent(roomId)}/ice-servers?${params}`, {
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      })
      if (!response.ok) throw new Error(`credential request failed (${response.status})`)

      const config = await response.json()
      if (
        !Array.isArray(config.iceServers) ||
        !config.iceServers.length ||
        !Number.isFinite(config.expiresAt)
      ) {
        throw new Error('credential response was invalid')
      }
      rtcConfig = { iceServers: config.iceServers }
      for (const peer of peers.values()) peer.pc.setConfiguration(rtcConfig)
      scheduleRtcRefresh(config.expiresAt)
      return true
    } catch (error) {
      log(`TURN unavailable; using direct connections only: ${error.message}`)
      clearTimeout(rtcRefreshTimer)
      rtcRefreshTimer = setTimeout(refreshRtcConfig, 60_000)
      return false
    } finally {
      clearTimeout(timeout)
    }
  }

  function scheduleRtcRefresh(expiresAt) {
    clearTimeout(rtcRefreshTimer)
    const refreshAt = expiresAt * 1_000 - 5 * 60_000
    rtcRefreshTimer = setTimeout(refreshRtcConfig, Math.max(60_000, refreshAt - Date.now()))
  }

  async function refreshRtcConfig() {
    if (!await loadRtcConfig()) return

    const broadcasterId = roomState?.playback?.entry.ownerPeerId
    if (!broadcasterId) return
    if (broadcasterId === peerId) {
      await Promise.all([...peers.values()].map(restartPeerIce))
    } else {
      send({ type: 'ice:restart-request', to: broadcasterId })
    }
  }

  function connectSignaling() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const params = new URLSearchParams({ room: roomId, peer: peerId, name: displayName })
    if (ownerToken) params.set('token', ownerToken)
    socket = new WebSocket(`${protocol}//${location.host}/ws?${params}`)
    setConnectionState('connecting')

    socket.addEventListener('open', () => {
      setConnectionState('room open', true)
      log(`Entered room as ${displayName}`)
    })

    socket.addEventListener('message', async (event) => {
      let message
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }

      try {
        await handleMessage(message)
      } catch (error) {
        log(`Room error: ${error.message}`)
        console.error(error)
      }
    })

    socket.addEventListener('close', (event) => {
      setConnectionState('offline')
      closeAllPeers()
      $('#room-note').textContent = 'Connection lost. Reload to rejoin the room.'
      log(`Room connection closed (${event.code}) ${event.reason}`)
    })

    socket.addEventListener('error', () => log('Room connection error'))
  }

  async function handleMessage(message) {
    if (message.type === 'room:snapshot') {
      const previousState = roomState
      roomState = message.room
      releaseRemovedQueueTracks(previousState, roomState)
      renderRoom(message.you)
      await reconcileMedia()
      return
    }

    if (message.type === 'room:error') {
      showToast(message.message)
      $('#track-status').textContent = message.message
      return
    }

    if (message.type === 'playback:go') {
      await startAssignedTrack(message.epoch)
      return
    }

    if (message.type === 'playback:stopped') {
      stopLocalPlayback(message.epoch)
      if (message.reason !== 'finished') showToast(`Song stopped: ${message.reason}.`)
      return
    }

    const from = message.from
    if (!from || !roomState?.playback) return
    const broadcasterId = roomState.playback.entry.ownerPeerId

    if (message.type === 'offer' && from === broadcasterId && broadcasterId !== peerId) {
      const peer = ensurePeer(from, 'listen')
      await peer.pc.setRemoteDescription(message.description)
      await flushCandidates(peer)
      await peer.pc.setLocalDescription(await peer.pc.createAnswer())
      send({ type: 'answer', to: from, description: peer.pc.localDescription })
      log(`Connected to ${nameFor(from)}'s song`)
    } else if (message.type === 'answer' && broadcasterId === peerId) {
      const peer = peers.get(from)
      if (!peer || peer.mode !== 'broadcast') return
      await peer.pc.setRemoteDescription(message.description)
      await flushCandidates(peer)
    } else if (message.type === 'ice:restart-request' && broadcasterId === peerId) {
      const peer = peers.get(from)
      if (peer?.mode === 'broadcast') await restartPeerIce(peer)
    } else if (message.type === 'ice') {
      const mode = broadcasterId === peerId ? 'broadcast' : 'listen'
      const peer = ensurePeer(from, mode)
      if (!message.candidate) return
      if (peer.pc.remoteDescription) {
        await peer.pc.addIceCandidate(message.candidate)
      } else {
        peer.pendingCandidates.push(message.candidate)
      }
    }
  }

  async function reconcileMedia() {
    const playback = roomState?.playback
    if (!playback) {
      closeAllPeers()
      if (activePlayback) stopLocalPlayback(activePlayback.epoch)
      renderConnectionSummary()
      return
    }

    const broadcasterId = playback.entry.ownerPeerId
    const participantIds = new Set(roomState.participants.map((participant) => participant.id))
    const desiredIds = broadcasterId === peerId
      ? new Set([...participantIds].filter((id) => id !== peerId))
      : new Set([broadcasterId])
    const mode = broadcasterId === peerId ? 'broadcast' : 'listen'

    for (const [id, peer] of peers) {
      if (!desiredIds.has(id) || peer.mode !== mode) closePeer(id)
    }
    for (const id of desiredIds) ensurePeer(id, mode)

    if (broadcasterId === peerId && playback.phase === 'starting') {
      prepareAssignedTrack(playback).catch((error) => {
        log(`Track preparation failed: ${error.message}`)
        send({ type: 'playback:failed', epoch: playback.epoch })
      })
    } else if (broadcasterId !== peerId && activePlayback) {
      stopLocalPlayback(activePlayback.epoch)
    }

    renderConnectionSummary()
  }

  function ensurePeer(remoteId, mode) {
    const existing = peers.get(remoteId)
    if (existing?.mode === mode) return existing
    if (existing) closePeer(remoteId)

    const pc = new RTCPeerConnection(rtcConfig)
    const peer = {
      remoteId,
      mode,
      pc,
      offered: false,
      pendingCandidates: [],
      connectionTimer: null,
      remoteStream: null,
      lastSample: null,
      iceText: 'Checking…',
      mediaText: 'Waiting for samples',
    }
    peers.set(remoteId, peer)
    scheduleConnectionTimeout(peer)

    pc.addEventListener('icecandidate', (event) => {
      if (event.candidate) send({ type: 'ice', to: remoteId, candidate: event.candidate })
    })

    pc.addEventListener('connectionstatechange', () => {
      log(`${nameFor(remoteId)}: ${pc.connectionState}`)
      if (pc.connectionState === 'connected') {
        clearTimeout(peer.connectionTimer)
        connectionHelp.classList.add('hidden')
        updatePeerStats(peer)
      } else if (pc.connectionState === 'failed') {
        showConnectionProblem(peer, 'Direct connection failed')
      } else if (pc.connectionState === 'disconnected') {
        scheduleConnectionTimeout(peer, 10_000)
      }
      renderConnectionSummary()
    })

    pc.addEventListener('icecandidateerror', (event) => {
      log(`ICE server error ${event.errorCode}: ${event.errorText || 'unknown error'}`)
    })

    if (mode === 'broadcast') {
      const track = mediaDestination.stream.getAudioTracks()[0]
      track.contentHint = 'music'
      const sender = pc.addTrack(track, mediaDestination.stream)
      preferMusicBitrate(sender)
      offerToListener(peer).catch((error) => log(`Offer failed: ${error.message}`))
    } else {
      pc.addEventListener('track', (event) => {
        const stream = event.streams[0] || new MediaStream([event.track])
        peer.remoteStream = stream
        remoteAudio.srcObject = stream
        event.track.addEventListener('mute', () => log(`${nameFor(remoteId)}’s audio paused`))
        event.track.addEventListener('unmute', () => log(`${nameFor(remoteId)}’s audio resumed`))
        event.track.addEventListener('ended', () => log(`${nameFor(remoteId)}’s audio track ended`))
        enableAudio().then(() => {
          log(`Receiving live audio from ${nameFor(remoteId)}`)
        }).catch((error) => {
          requestAudioGesture(error)
        })
      })
    }

    return peer
  }

  async function offerToListener(peer) {
    if (peer.offered) return
    peer.offered = true
    await peer.pc.setLocalDescription(await peer.pc.createOffer())
    send({ type: 'offer', to: peer.remoteId, description: peer.pc.localDescription })
  }

  async function restartPeerIce(peer) {
    if (peer.pc.signalingState !== 'stable') return
    peer.pc.setConfiguration(rtcConfig)
    peer.pc.restartIce()
    peer.offered = false
    await offerToListener(peer)
  }

  function closePeer(remoteId) {
    const peer = peers.get(remoteId)
    if (!peer) return
    clearTimeout(peer.connectionTimer)
    if (peer.remoteStream && remoteAudio.srcObject === peer.remoteStream) {
      remoteAudio.srcObject = audioUnlockDestination?.stream ?? null
      remoteAudio.play().catch(() => resumeAudioButton.classList.remove('hidden'))
    }
    peer.pc.close()
    peers.delete(remoteId)
  }

  function closeAllPeers() {
    for (const id of [...peers.keys()]) closePeer(id)
    renderDiagnostics()
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
    renderDiagnostics()
    log(`${reason} with ${nameFor(peer.remoteId)}. This network may require TURN.`)
  }

  async function enableAudio() {
    if (audioContext?.state !== 'running') await audioContext.resume()
    await remoteAudio.play()
    resumeAudioButton.classList.add('hidden')
  }

  function requestAudioGesture(error) {
    resumeAudioButton.classList.remove('hidden')
    showToast('Your browser paused room audio. Tap Enable sound.')
    log(`Audio output needs a tap: ${error?.message || 'playback was blocked'}`)
  }

  function renderConnectionSummary() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    const playback = roomState?.playback
    if (!playback) {
      setConnectionState('room open', true)
      return
    }

    const connected = [...peers.values()].filter((peer) => peer.pc.connectionState === 'connected').length
    if (playback.entry.ownerPeerId === peerId) {
      setConnectionState(playback.phase === 'playing' ? `broadcasting · ${connected}` : `preparing · ${connected}`, true)
    } else {
      setConnectionState(connected ? 'listening live' : 'connecting audio', connected > 0)
    }
  }

  async function prepareAssignedTrack(playback) {
    if (preparingEpoch === playback.epoch || preparedTrack?.epoch === playback.epoch) return
    preparingEpoch = playback.epoch
    const local = localTracks.get(playback.entry.localTrackId)
    if (!local) throw new Error('The local file is no longer available in this tab')

    $('#track-status').textContent = `Preparing “${playback.entry.title}”…`
    const bytes = await local.file.arrayBuffer()
    const buffer = await audioContext.decodeAudioData(bytes)
    if (roomState?.playback?.epoch !== playback.epoch) return

    preparedTrack = { epoch: playback.epoch, entry: playback.entry, buffer }
    preparingEpoch = null
    await waitForAudience(2_000)
    if (roomState?.playback?.epoch === playback.epoch) {
      send({ type: 'playback:ready', epoch: playback.epoch })
      $('#track-status').textContent = 'Your song is ready to play.'
    }
  }

  async function waitForAudience(timeoutMs) {
    const expected = roomState.participants.filter((participant) => participant.id !== peerId).length
    if (!expected) return
    const deadline = performance.now() + timeoutMs
    while (performance.now() < deadline) {
      const connected = [...peers.values()].filter((peer) => peer.pc.connectionState === 'connected').length
      if (connected >= expected) return
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }

  async function startAssignedTrack(epoch) {
    if (!preparedTrack || preparedTrack.epoch !== epoch || roomState?.playback?.epoch !== epoch) {
      send({ type: 'playback:failed', epoch })
      return
    }

    if (activePlayback) stopLocalPlayback(activePlayback.epoch)
    await audioContext.resume()
    const source = audioContext.createBufferSource()
    source.buffer = preparedTrack.buffer
    source.connect(broadcastOutput)
    const entry = preparedTrack.entry
    activePlayback = { epoch, source, entry }
    preparedTrack = null

    source.addEventListener('ended', () => {
      if (activePlayback?.epoch !== epoch) return
      activePlayback = null
      releaseLocalTrack(entry.localTrackId)
      send({ type: 'playback:ended', epoch })
      log(`Finished ${entry.title}`)
    })
    source.start(audioContext.currentTime + 0.04)
    send({ type: 'playback:started', epoch })
    log(`Playing ${entry.title}`)
  }

  function stopLocalPlayback(epoch) {
    if (activePlayback?.epoch === epoch) {
      const stopped = activePlayback
      activePlayback = null
      try { stopped.source.stop() } catch {}
      stopped.source.disconnect()
      releaseLocalTrack(stopped.entry.localTrackId)
    }
    if (preparedTrack?.epoch === epoch) {
      releaseLocalTrack(preparedTrack.entry.localTrackId)
      preparedTrack = null
    }
    if (preparingEpoch === epoch) preparingEpoch = null
  }

  function releaseLocalTrack(localTrackId) {
    const local = localTracks.get(localTrackId)
    if (!local) return
    URL.revokeObjectURL(local.url)
    localTracks.delete(localTrackId)
  }

  function releaseRemovedQueueTracks(previous, current) {
    if (!previous) return
    const retainedIds = new Set([
      ...current.queue.filter((entry) => entry.ownerPeerId === peerId).map((entry) => entry.localTrackId),
      ...(current.playback?.entry.ownerPeerId === peerId ? [current.playback.entry.localTrackId] : []),
    ])
    for (const entry of previous.queue) {
      if (entry.ownerPeerId === peerId && !retainedIds.has(entry.localTrackId)) {
        releaseLocalTrack(entry.localTrackId)
      }
    }
  }

  async function selectTrack(event) {
    const file = event.target.files[0]
    if (!file) return
    if (file.size > maxTrackBytes) {
      $('#track-status').textContent = 'That file is over the 150 MB room limit.'
      event.target.value = ''
      return
    }
    if (!file.name.toLowerCase().endsWith('.mp3') && file.type !== 'audio/mpeg') {
      $('#track-status').textContent = 'Panster currently accepts MP3 files.'
      event.target.value = ''
      return
    }

    if (pendingTrack) URL.revokeObjectURL(pendingTrack.url)
    $('#track-status').textContent = 'Reading the record label…'
    $('#track-editor').classList.add('hidden')

    let url
    try {
      url = URL.createObjectURL(file)
      const [tags, duration] = await Promise.all([
        readId3(file),
        readDuration(url),
      ])
      pendingTrack = {
        id: crypto.randomUUID(),
        file,
        url,
        duration,
        album: tags.album || null,
      }
      $('#track-title').value = tags.title || titleFromFilename(file.name)
      $('#track-artist').value = tags.artist || ''
      $('#track-filename').textContent = file.name
      $('#track-duration').textContent = formatDuration(duration)
      $('#track-editor').classList.remove('hidden')
      $('#track-editor').classList.add('grid')
      $('#track-status').textContent = tags.title || tags.artist
        ? 'Found the tags. Make any edits, then add it.'
        : 'No useful tags found—give it a quick look.'
      $('#track-title').focus()
    } catch (error) {
      if (url) URL.revokeObjectURL(url)
      $('#track-status').textContent = `Could not read that MP3: ${error.message}`
      event.target.value = ''
    }
  }

  function enqueueTrack(event) {
    event.preventDefault()
    if (!pendingTrack || hasWaitingTrack()) return

    const title = $('#track-title').value.trim()
    const artist = $('#track-artist').value.trim()
    if (!title) return

    localTracks.set(pendingTrack.id, pendingTrack)
    send({
      type: 'queue:add',
      localTrackId: pendingTrack.id,
      title,
      artist,
      album: pendingTrack.album,
      durationSeconds: pendingTrack.duration,
      size: pendingTrack.file.size,
    })
    pendingTrack = null
    $('#track-file').value = ''
    $('#track-editor').classList.add('hidden')
    $('#track-editor').classList.remove('grid')
    $('#track-status').textContent = `“${title}” joined the room.`
  }

  function hasWaitingTrack() {
    return Boolean(roomState?.queue.some((entry) => entry.ownerPeerId === peerId))
  }

  function renderRoom(you) {
    const participants = roomState.participants
    const playback = roomState.playback
    const isOwner = Boolean(you?.isOwner)
    $('#owner-badge').classList.toggle('hidden', !isOwner)
    $('#owner-controls').classList.toggle('hidden', !isOwner || !playback)
    $('#owner-controls').classList.toggle('flex', isOwner && Boolean(playback))
    $('#room-note').textContent = participants.length === 1
      ? 'Just you for now. Add something good.'
      : `${participants.length} here · music travels directly between browsers`

    renderNowPlaying(playback)
    renderQueue(isOwner)
    renderPeople()
    renderAddState()
    renderConnectionSummary()
  }

  function renderNowPlaying(playback) {
    const liveLabel = $('#live-label')
    if (!playback) {
      $('#now-title').textContent = 'The queue is open'
      $('#now-artist').textContent = 'Add the first song from your computer.'
      $('#now-by').textContent = 'MP3s stay between browsers.'
      $('#duration-time').textContent = '—'
      $('#elapsed-time').textContent = '0:00'
      $('#playback-progress').style.width = '0%'
      $('#now-art').style.setProperty('--art-hue', '82')
      liveLabel.querySelector('span').textContent = 'quiet'
      liveLabel.classList.remove('live')
      return
    }

    const entry = playback.entry
    $('#now-title').textContent = entry.title
    $('#now-artist').textContent = entry.artist || 'Unknown artist'
    $('#now-by').textContent = `${playback.phase === 'starting' ? 'Getting ready with' : 'Played by'} ${nameFor(entry.ownerPeerId)}`
    $('#duration-time').textContent = formatDuration(entry.durationSeconds)
    $('#now-art').style.setProperty('--art-hue', hueFor(entry.id))
    liveLabel.querySelector('span').textContent = playback.phase === 'playing' ? 'live' : 'connecting'
    liveLabel.classList.toggle('live', playback.phase === 'playing')
    if (playback.phase === 'starting') {
      $('#elapsed-time').textContent = '0:00'
      $('#playback-progress').style.width = '0%'
    } else {
      updateProgress()
    }
  }

  function renderQueue(isOwner) {
    const list = $('#queue-list')
    list.replaceChildren()
    roomState.queue.forEach((entry, index) => {
      const row = document.createElement('li')
      row.className = 'queue-row'

      const position = document.createElement('span')
      position.className = 'queue-position'
      position.textContent = String(index + 1).padStart(2, '0')

      const art = document.createElement('span')
      art.className = 'track-art track-art-small'
      art.style.setProperty('--art-hue', hueFor(entry.id))
      art.append(document.createElement('span'))

      const copy = document.createElement('div')
      copy.className = 'queue-copy'
      const title = document.createElement('p')
      title.className = 'queue-title'
      title.textContent = entry.title
      const meta = document.createElement('p')
      meta.className = 'queue-meta'
      meta.textContent = `${entry.artist || 'Unknown artist'} · ${nameFor(entry.ownerPeerId)} · ${formatDuration(entry.durationSeconds)}`
      copy.append(title, meta)
      row.append(position, art, copy)

      if (entry.ownerPeerId === peerId || isOwner) {
        const remove = document.createElement('button')
        remove.className = 'queue-remove'
        remove.type = 'button'
        remove.title = 'Remove from queue'
        remove.setAttribute('aria-label', `Remove ${entry.title} from queue`)
        remove.textContent = '×'
        remove.addEventListener('click', () => {
          if (entry.ownerPeerId === peerId) releaseLocalTrack(entry.localTrackId)
          send({ type: 'queue:remove', entryId: entry.id })
        })
        row.append(remove)
      } else {
        row.append(document.createElement('span'))
      }
      list.append(row)
    })

    $('#queue-count').textContent = `${roomState.queue.length} ${roomState.queue.length === 1 ? 'song' : 'songs'}`
    $('#queue-empty').classList.toggle('hidden', roomState.queue.length > 0)
  }

  function renderPeople() {
    const list = $('#people-list')
    list.replaceChildren()
    const broadcasterId = roomState.playback?.entry.ownerPeerId
    for (const participant of roomState.participants) {
      const item = document.createElement('li')
      item.className = `person-chip${participant.id === broadcasterId ? ' broadcasting' : ''}`
      const dot = document.createElement('i')
      const label = document.createElement('span')
      label.textContent = `${participant.displayName}${participant.id === peerId ? ' · you' : ''}${participant.isOwner ? ' · keeper' : ''}`
      item.append(dot, label)
      list.append(item)
    }
    $('#people-count').textContent = String(roomState.participants.length)
  }

  function renderAddState() {
    const waiting = roomState.queue.find((entry) => entry.ownerPeerId === peerId)
    const fileInput = $('#track-file')
    const picker = $('#file-picker')
    fileInput.disabled = Boolean(waiting)
    picker.classList.toggle('disabled', Boolean(waiting))

    if (waiting) {
      $('#track-status').textContent = `“${waiting.title}” is waiting in the queue.`
    } else if (!pendingTrack && roomState.playback?.entry.ownerPeerId === peerId) {
      $('#track-status').textContent = 'Keep it going—add what should play after this.'
    } else if (!pendingTrack && !localTracks.size) {
      $('#track-status').textContent = 'Choose something you want the room to hear.'
    }
  }

  function updateProgress() {
    const playback = roomState?.playback
    if (!playback || playback.phase !== 'playing' || !playback.startedAt) return
    const elapsed = Math.max(0, (Date.now() - new Date(playback.startedAt).getTime()) / 1_000)
    const progress = Math.min(1, elapsed / playback.entry.durationSeconds)
    $('#elapsed-time').textContent = formatDuration(elapsed)
    $('#playback-progress').style.width = `${progress * 100}%`
  }

  function nameFor(id) {
    return roomState?.participants.find((participant) => participant.id === id)?.displayName || 'Someone'
  }

  function hueFor(value) {
    let hash = 0
    for (const character of value) hash = ((hash << 5) - hash + character.charCodeAt(0)) | 0
    return String(Math.abs(hash) % 300 + 20)
  }

  function send(value) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value))
  }

  async function flushCandidates(peer) {
    for (const candidate of peer.pendingCandidates.splice(0)) {
      await peer.pc.addIceCandidate(candidate)
    }
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

  async function updatePeerStats(peer) {
    if (peer.pc.connectionState !== 'connected') return
    try {
      const stats = await peer.pc.getStats()
      const transport = [...stats.values()].find((stat) => stat.type === 'transport' && stat.selectedCandidatePairId)
      let pair = transport ? stats.get(transport.selectedCandidatePairId) : null
      if (!pair) {
        pair = [...stats.values()].find((stat) => stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated)
      }
      if (pair) {
        const local = stats.get(pair.localCandidateId)
        const remote = stats.get(pair.remoteCandidateId)
        peer.iceText = `${local?.candidateType || 'unknown'} ↔ ${remote?.candidateType || 'unknown'} / ${local?.protocol || remote?.protocol || 'unknown'}`
        const outbound = peer.mode === 'broadcast'
        const bytes = [...stats.values()]
          .filter((stat) => stat.type === (outbound ? 'outbound-rtp' : 'inbound-rtp') && (stat.kind === 'audio' || stat.mediaType === 'audio'))
          .reduce((total, stat) => total + (outbound ? stat.bytesSent || 0 : stat.bytesReceived || 0), 0)
        const now = performance.now()
        let bitrate = 'sampling bitrate'
        if (peer.lastSample && now > peer.lastSample.at) {
          bitrate = `${Math.max(0, Math.round(((bytes - peer.lastSample.bytes) * 8) / ((now - peer.lastSample.at) / 1_000) / 1_000))} kbps`
        }
        const rtt = Number.isFinite(pair.currentRoundTripTime) ? `${Math.round(pair.currentRoundTripTime * 1_000)} ms RTT` : 'RTT pending'
        peer.lastSample = { bytes, at: now }
        peer.mediaText = `${bitrate} · ${rtt}`
      }
    } catch (error) {
      log(`Stats error: ${error.message}`)
    }
    renderDiagnostics()
  }

  function renderDiagnostics() {
    const active = [...peers.values()].filter((peer) => peer.pc.connectionState !== 'closed')
    if (!active.length) {
      iceSummary.textContent = 'Not connected'
      mediaSummary.textContent = 'Waiting for samples'
      return
    }
    const label = (peer) => peers.size > 1 ? `${nameFor(peer.remoteId)}: ` : ''
    iceSummary.textContent = active.map((peer) => `${label(peer)}${peer.iceText}`).join(' | ')
    mediaSummary.textContent = active.map((peer) => `${label(peer)}${peer.mediaText}`).join(' | ')
  }

  async function readDuration(url) {
    return new Promise((resolve, reject) => {
      const audio = new Audio()
      const timeout = setTimeout(() => reject(new Error('metadata timed out')), 10_000)
      audio.preload = 'metadata'
      audio.addEventListener('loadedmetadata', () => {
        clearTimeout(timeout)
        if (Number.isFinite(audio.duration) && audio.duration > 0) resolve(audio.duration)
        else reject(new Error('duration is unavailable'))
      }, { once: true })
      audio.addEventListener('error', () => {
        clearTimeout(timeout)
        reject(new Error('the browser could not read it'))
      }, { once: true })
      audio.src = url
    })
  }

  async function readId3(file) {
    const headSize = Math.min(file.size, 512 * 1024)
    const [head, tail] = await Promise.all([
      file.slice(0, headSize).arrayBuffer(),
      file.slice(Math.max(0, file.size - 128)).arrayBuffer(),
    ])
    return { ...readId3v1(tail), ...readId3v2(head) }
  }

  function readId3v2(buffer) {
    const bytes = new Uint8Array(buffer)
    if (bytes.length < 10 || String.fromCharCode(...bytes.slice(0, 3)) !== 'ID3') return {}
    const version = bytes[3]
    const tagEnd = Math.min(bytes.length, 10 + synchsafe(bytes, 6))
    const tags = {}
    let offset = 10

    while (offset < tagEnd) {
      const shortFrames = version === 2
      const headerSize = shortFrames ? 6 : 10
      if (offset + headerSize > tagEnd) break
      const idLength = shortFrames ? 3 : 4
      const id = String.fromCharCode(...bytes.slice(offset, offset + idLength))
      if (!/^[A-Z0-9]+$/.test(id)) break
      const size = shortFrames
        ? (bytes[offset + 3] << 16) | (bytes[offset + 4] << 8) | bytes[offset + 5]
        : version === 4
          ? synchsafe(bytes, offset + 4)
          : new DataView(buffer).getUint32(offset + 4)
      const bodyStart = offset + headerSize
      const bodyEnd = bodyStart + size
      if (size <= 0 || bodyEnd > tagEnd) break
      const value = decodeTextFrame(bytes.slice(bodyStart, bodyEnd))
      if ((id === 'TIT2' || id === 'TT2') && value) tags.title = value
      if ((id === 'TPE1' || id === 'TP1') && value) tags.artist = value
      if ((id === 'TALB' || id === 'TAL') && value) tags.album = value
      offset = bodyEnd
    }
    return tags
  }

  function readId3v1(buffer) {
    const bytes = new Uint8Array(buffer)
    if (bytes.length !== 128 || String.fromCharCode(...bytes.slice(0, 3)) !== 'TAG') return {}
    const decoder = new TextDecoder('iso-8859-1')
    const clean = (start, length) => decoder.decode(bytes.slice(start, start + length)).replace(/\0/g, '').trim()
    return { title: clean(3, 30) || undefined, artist: clean(33, 30) || undefined, album: clean(63, 30) || undefined }
  }

  function decodeTextFrame(bytes) {
    if (bytes.length < 2) return ''
    const encoding = bytes[0]
    let payload = bytes.slice(1)
    let charset = 'iso-8859-1'
    if (encoding === 1) {
      if (payload[0] === 0xff && payload[1] === 0xfe) {
        charset = 'utf-16le'
        payload = payload.slice(2)
      } else if (payload[0] === 0xfe && payload[1] === 0xff) {
        charset = 'utf-16be'
        payload = payload.slice(2)
      } else {
        charset = 'utf-16le'
      }
    } else if (encoding === 2) {
      charset = 'utf-16be'
    } else if (encoding === 3) {
      charset = 'utf-8'
    }
    try {
      return new TextDecoder(charset).decode(payload).replace(/\0/g, '').trim().slice(0, 120)
    } catch {
      return ''
    }
  }

  function synchsafe(bytes, offset) {
    return ((bytes[offset] & 0x7f) << 21) |
      ((bytes[offset + 1] & 0x7f) << 14) |
      ((bytes[offset + 2] & 0x7f) << 7) |
      (bytes[offset + 3] & 0x7f)
  }

  function titleFromFilename(filename) {
    return filename.replace(/\.mp3$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Untitled track'
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return '—'
    return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`
  }

  try { $('#display-name').value = localStorage.getItem('panster-display-name') || '' } catch {}
  $('#join-form').addEventListener('submit', enterRoom)
  $('#track-file').addEventListener('change', selectTrack)
  $('#track-editor').addEventListener('submit', enqueueTrack)
  resumeAudioButton.addEventListener('click', () => {
    enableAudio().catch(requestAudioGesture)
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && roomState?.playback) {
      enableAudio().catch(() => resumeAudioButton.classList.remove('hidden'))
    }
  })
  $('#skip-track').addEventListener('click', () => {
    if (roomState?.playback) send({ type: 'owner:skip', epoch: roomState.playback.epoch })
  })
  $('#copy-invite')?.addEventListener('click', async () => {
    await navigator.clipboard.writeText(`${location.origin}/rooms/${roomId}`)
    $('#copy-invite').textContent = 'Copied'
    setTimeout(() => { $('#copy-invite').textContent = 'Copy room link' }, 1_500)
  })

  setInterval(() => {
    updateProgress()
    for (const peer of peers.values()) updatePeerStats(peer)
  }, 2_000)
})()
