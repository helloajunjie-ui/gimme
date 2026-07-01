/**
 * webrtc.js — WebRTC P2P 连接引擎（v3.0 断点续传）
 * 
 * 职责：
 * - 通过信令服务器交换 SDP / ICE Candidate
 * - 管理 DataChannel 生命周期
 * - 分片发送 / 接收文件数据
 * - 应用层重传机制（Chunk ACK）
 * - ICE 中继检测（TURN 兜底识别）
 * - P2P 断点续传（OPFS 持久化 + SYNC_STATE 握手）
 * 
 * 设计要点：
 * - 64KB 分片，防止内存爆破
 * - 每片带 ChunkID 头部，支持接收端排序和重传请求
 * - 连接状态回调，驱动 UI 更新
 * - ICE 节点动态获取（Serverless JSON API），带优雅降级
 * - 断网重连后 SYNC_STATE 对齐 offset，精准续传
 */

const P2PEngine = (() => {
  const CHUNK_SIZE = 64 * 1024; // 64KB

  // 绝对兜底：免费 STUN 节点
  const FALLBACK_ICE = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  /**
   * 动态获取 ICE 服务器列表
   */
  async function fetchIceServers(onLoading) {
    onLoading?.(true);
    try {
      const resp = await fetch('/api/nodes', {
        cache: 'no-store',
        signal: AbortSignal.timeout(5000)
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const nodes = await resp.json();
      if (!Array.isArray(nodes) || nodes.length === 0) throw new Error('空节点列表');
      return nodes;
    } catch (err) {
      console.warn('[ICE] 动态节点获取失败，降级为直连模式:', err.message);
      return FALLBACK_ICE;
    } finally {
      onLoading?.(false);
    }
  }

  function createSender(callbacks) {
    return new P2PInstance('sender', callbacks);
  }

  function createReceiver(callbacks) {
    return new P2PInstance('receiver', callbacks);
  }

  class P2PInstance {
    constructor(role, callbacks) {
      this.role = role;
      this.ws = callbacks.ws;
      this.onSignal = callbacks.onSignal;
      this.onStateChange = callbacks.onStateChange;
      this.onProgress = callbacks.onProgress;
      this.onComplete = callbacks.onComplete;
      this.onError = callbacks.onError;
      this.onIceLoading = callbacks.onIceLoading;

      this.peerConnection = null;
      this.dataChannel = null;
      this.connected = false;

      // 发送端状态
      this.file = null;
      this.fileSize = 0;
      this.fileName = '';
      this.fileType = '';
      this.fileHash = '';
      this.offset = 0;
      this.sending = false;
      this.cryptoKey = null;

      // 接收端状态
      this.receivedChunks = new Map();
      this.totalChunks = 0;
      this.receivedSize = 0;
      this.metadata = null;
      this.decryptKey = null;
      this.nextExpectedChunk = 0;
      this.storage = null;        // OPFS 存储会话
      this.sessionId = '';        // 文件哈希作为会话 ID
      this._assembling = false;   // 正在组装中，防止并发

      // 断点续传状态
      this.resumeMode = false;    // 是否处于续传模式
      this.syncResolve = null;    // 等待 SYNC_STATE 的 Promise

      // 绑定信令回调
      this._bindSignalHandler();
    }

    /**
     * 初始化 PeerConnection（动态获取 ICE 节点）
     */
    async init() {
      const iceServers = await fetchIceServers(this.onIceLoading);
      console.log('[ICE] 使用节点:', iceServers.map(s => s.urls).filter(Boolean));

      this.peerConnection = new RTCPeerConnection({ iceServers });

      this.peerConnection.onicecandidate = (e) => {
        if (e.candidate) {
          this._sendSignal({ type: 'candidate', candidate: e.candidate });
        }
      };

      this.peerConnection.oniceconnectionstatechange = () => {
        const state = this.peerConnection.iceConnectionState;
        console.log('[ICE] 状态:', state);
        if (state === 'connected') {
          this._checkRelayUsage();
        } else if (state === 'failed') {
          this.onStateChange?.('relay_fallback');
        }
      };

      this.peerConnection.onconnectionstatechange = () => {
        const state = this.peerConnection.connectionState;
        this.connected = state === 'connected';
        this.onStateChange?.(state);
      };

      this.peerConnection.ondatachannel = (e) => {
        this._setupDataChannel(e.channel);
      };

      if (this.role === 'sender') {
        this.dataChannel = this.peerConnection.createDataChannel('fileTransfer', {
          ordered: false,
          maxRetransmits: 0
        });
        this._setupDataChannel(this.dataChannel);
      }
    }

    /**
     * 检测是否使用了 TURN 中继
     */
    async _checkRelayUsage() {
      if (!this.peerConnection) return;
      try {
        const stats = await this.peerConnection.getStats();
        let usingRelay = false;
        stats.forEach(report => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            const localCandidate = stats.get(report.localCandidateId);
            if (localCandidate && localCandidate.candidateType === 'relay') {
              usingRelay = true;
            }
          }
        });
        if (usingRelay) {
          console.log('[ICE] 使用 TURN 中继转发');
          this.onStateChange?.('relay_active');
        }
      } catch (e) {}
    }

    _setupDataChannel(channel) {
      this.dataChannel = channel;
      channel.binaryType = 'arraybuffer';

      channel.onopen = () => {
        this.connected = true;
        this.onStateChange?.('connected');
      };

      channel.onclose = () => {
        this.connected = false;
        this.onStateChange?.('disconnected');
      };

      channel.onmessage = (e) => {
        this._handleMessage(e.data);
      };
    }

    // ==================== 断点续传核心逻辑 ====================

    /**
     * 发送端：开始发送文件（支持续传）
     */
    async startSending(file, cryptoKey, fileHash) {
      this.file = file;
      this.fileSize = file.size;
      this.fileName = file.name;
      this.fileType = file.type;
      this.fileHash = fileHash;
      this.cryptoKey = cryptoKey;
      this.offset = 0;
      this.sending = true;

      // 先发送文件元数据（含哈希指纹）
      const meta = {
        type: 'meta',
        name: file.name,
        size: file.size,
        mimeType: file.type,
        totalChunks: Math.ceil(file.size / CHUNK_SIZE),
        hash: fileHash
      };
      this.dataChannel.send(JSON.stringify(meta));

      // 等待接收端的 SYNC_STATE（如果有本地缓存则续传）
      // 设置超时：如果 3 秒内没有收到 SYNC_STATE，从头开始传
      let syncTimer = null;
      const syncPromise = new Promise(resolve => { this.syncResolve = resolve; });
      const syncTimeout = new Promise(resolve => {
        syncTimer = setTimeout(() => resolve(null), 3000);
      });

      try {
        const syncMsg = await Promise.race([syncPromise, syncTimeout]);
        clearTimeout(syncTimer);
        if (syncMsg && syncMsg.receivedOffset > 0) {
          this.offset = syncMsg.receivedOffset;
          this.resumeMode = true;
          console.log(`[续传] 从 offset ${this.offset} 继续发送`);
          this.onStateChange?.('resuming');
        }
      } catch {
        console.log('[续传] 无缓存状态，从头开始传输');
      }

      // 续传状态确认后，恢复进度条为正常传输色
      this.onStateChange?.('connected');

      // 开始发送数据块
      await this._sendNextChunk();
    }

    /**
     * 接收端：发送 SYNC_STATE 同步状态
     */
    async _sendSyncState() {
      if (!this.dataChannel || this.dataChannel.readyState !== 'open') return;

      try {
        const savedChunkIds = await this.storage.getSavedChunkIds();
        // 计算已收到的连续最大 offset
        let maxContiguous = 0;
        for (const id of savedChunkIds) {
          if (id === maxContiguous) {
            maxContiguous++;
          } else {
            break; // 只取连续块
          }
        }
        const receivedOffset = maxContiguous * CHUNK_SIZE;

        const syncMsg = JSON.stringify({
          type: 'SYNC_STATE',
          fileHash: this.sessionId,
          receivedOffset
        });
        this.dataChannel.send(syncMsg);
        console.log(`[续传] 发送 SYNC_STATE: offset=${receivedOffset}`);
      } catch (e) {
        console.warn('[续传] SYNC_STATE 发送失败:', e.message);
      }
    }

    /**
     * 发送端：处理接收到的 SYNC_STATE
     */
    _handleSyncState(msg) {
      if (msg.fileHash !== this.fileHash) {
        console.error('[续传] 文件哈希不匹配，从头开始');
        this.offset = 0;
        if (this.syncResolve) {
          this.syncResolve({ receivedOffset: 0 });
          this.syncResolve = null;
        }
        return;
      }
      if (this.syncResolve) {
        this.syncResolve(msg);
        this.syncResolve = null;
      }
    }

    // ==================== 发送逻辑 ====================

    async _sendNextChunk(retryCount = 0) {
      if (!this.sending || this.offset >= this.fileSize) {
        if (this.offset >= this.fileSize) {
          this.sending = false;
          this.onComplete?.();
        }
        return;
      }

      const chunk = this.file.slice(this.offset, this.offset + CHUNK_SIZE);
      const arrayBuffer = await chunk.arrayBuffer();
      const chunkId = Math.floor(this.offset / CHUNK_SIZE);

      const encrypted = await CryptoModule.encryptChunk(arrayBuffer, this.cryptoKey);

      const header = new ArrayBuffer(4);
      const headerView = new DataView(header);
      headerView.setUint32(0, chunkId, true);

      const packet = new Uint8Array(header.byteLength + encrypted.byteLength);
      packet.set(new Uint8Array(header), 0);
      packet.set(new Uint8Array(encrypted), header.byteLength);

      try {
        this.dataChannel.send(packet.buffer);
      } catch (e) {
        if (retryCount >= 3) {
          this.onError?.(new Error('发送失败，已达最大重试次数'));
          this.sending = false;
          return;
        }
        await new Promise(resolve => {
          this.dataChannel.onbufferedamountlow = resolve;
        });
        this._sendNextChunk(retryCount + 1);
        return;
      }

      this.offset += CHUNK_SIZE;
      this.onProgress?.(Math.min(this.offset, this.fileSize), this.fileSize);

      setTimeout(() => this._sendNextChunk(), 0);
    }

    // ==================== 接收逻辑 ====================

    async _handleMessage(data) {
      // JSON 消息
      if (data instanceof ArrayBuffer === false) {
        try {
          const msg = JSON.parse(data);
          switch (msg.type) {
            case 'meta':
              await this._handleMeta(msg);
              break;
            case 'SYNC_STATE':
              this._handleSyncState(msg);
              break;
            case 'retry_request':
              this._handleRetryRequest(msg.chunkId);
              break;
          }
        } catch {}
        return;
      }

      // 二进制数据：ChunkID(4) + IV(12) + 密文
      const packet = new Uint8Array(data);
      const headerView = new DataView(data, 0, 4);
      const chunkId = headerView.getUint32(0, true);
      const encryptedData = packet.slice(4).buffer;

      // 存储收到的块（内存 + OPFS）
      if (!this.receivedChunks.has(chunkId)) {
        this.receivedChunks.set(chunkId, encryptedData);
        this.receivedSize += encryptedData.byteLength - CryptoModule.IV_LENGTH - CryptoModule.AUTH_TAG_LENGTH;
        this.onProgress?.(this.receivedSize, this.metadata?.size || 1);

        // 持久化到 OPFS
        if (this.storage) {
          this.storage.saveChunk(chunkId, encryptedData).catch(e =>
            console.warn('[Storage] 保存分片失败:', e.message)
          );
        }
      }

      // 所有分片收齐后组装（避免重试场景下重复触发）
      if (this.receivedChunks.size >= this.totalChunks && !this._assembling) {
        await this._assembleFile();
      }
    }

    async _handleMeta(msg) {
      this.metadata = msg;
      this.totalChunks = msg.totalChunks;
      this.sessionId = msg.hash;
      this.receivedChunks = new Map();
      this.receivedSize = 0;
      this.nextExpectedChunk = 0;

      // 创建 OPFS 存储会话
      this.storage = await StorageModule.createSession(this.sessionId);

      // 检查是否有本地缓存
      const savedChunkIds = await this.storage.getSavedChunkIds();
      if (savedChunkIds.length > 0) {
        // 加载已保存的分片到内存
        for (const id of savedChunkIds) {
          const data = await this.storage.loadChunk(id);
          if (data) {
            this.receivedChunks.set(id, data);
            this.receivedSize += data.byteLength - CryptoModule.IV_LENGTH - CryptoModule.AUTH_TAG_LENGTH;
          }
        }
        this.onProgress?.(this.receivedSize, msg.size);
        console.log(`[续传] 从本地加载了 ${savedChunkIds.length} 个分片`);
        // 有缓存 → 续传模式，先触发 resuming 状态（UI 琥珀色进度条）
        this.onStateChange?.('resuming');
        // 延迟触发 receiving，让用户先看到续传提示
        setTimeout(() => {
          this.onStateChange?.('receiving');
        }, 1500);
      } else {
        this.onStateChange?.('receiving');
      }

      // 发送 SYNC_STATE 给发送端
      this._sendSyncState();
    }

    async _assembleFile() {
      if (this._assembling) return;
      this._assembling = true;
      this.onStateChange?.('assembling');
      const chunks = [];
      for (let i = 0; i < this.totalChunks; i++) {
        const encrypted = this.receivedChunks.get(i);
        if (!encrypted) {
          // 缺失分片，请求重传后等待下次触发
          this._requestRetry(i);
          this._assembling = false;
          return;
        }
        const decrypted = await CryptoModule.decryptChunk(encrypted, this.decryptKey);
        chunks.push(decrypted);
      }

      const totalLength = chunks.reduce((acc, c) => acc + c.byteLength, 0);
      const merged = new Uint8Array(totalLength);
      let pos = 0;
      for (const chunk of chunks) {
        merged.set(new Uint8Array(chunk), pos);
        pos += chunk.byteLength;
      }

      const blob = new Blob([merged], { type: this.metadata.mimeType });

      // 清理 OPFS 缓存
      if (this.storage) {
        await this.storage.clear();
      }

      this._assembling = false;
      this.onComplete?.(blob, this.metadata.name);
    }

    _requestRetry(chunkId) {
      if (this.dataChannel?.readyState === 'open') {
        this.dataChannel.send(JSON.stringify({ type: 'retry_request', chunkId }));
      }
    }

    _handleRetryRequest(chunkId) {
      const startOffset = chunkId * CHUNK_SIZE;
      const endOffset = Math.min(startOffset + CHUNK_SIZE, this.fileSize);
      if (startOffset < this.fileSize && this.file) {
        const chunk = this.file.slice(startOffset, endOffset);
        chunk.arrayBuffer().then(async (buf) => {
          const encrypted = await CryptoModule.encryptChunk(buf, this.cryptoKey);
          const header = new ArrayBuffer(4);
          const headerView = new DataView(header);
          headerView.setUint32(0, chunkId, true);
          const packet = new Uint8Array(header.byteLength + encrypted.byteLength);
          packet.set(new Uint8Array(header), 0);
          packet.set(new Uint8Array(encrypted), header.byteLength);
          this.dataChannel.send(packet.buffer);
        }).catch(err => {
          console.error('[重传] 读取文件分片失败:', err.message);
          this.onError?.(new Error(`分片 ${chunkId} 重传失败: ${err.message}`));
        });
      }
    }

    // --- 信令 ---
    _bindSignalHandler() {
      this._signalHandler = (msg) => {
        if (msg.type === 'signal') {
          this._handleSignal(msg.signal);
        }
      };
      this.onSignal(this._signalHandler);
    }

    async _handleSignal(signal) {
      if (!this.peerConnection) return;
      try {
        if (signal.type === 'offer') {
          await this.peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
          const answer = await this.peerConnection.createAnswer();
          await this.peerConnection.setLocalDescription(answer);
          this._sendSignal(answer);
        } else if (signal.type === 'answer') {
          await this.peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
        } else if (signal.type === 'candidate') {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
        }
      } catch (e) {
        this.onError?.(e);
      }
    }

    async createOffer() {
      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);
      this._sendSignal(offer);
    }

    _sendSignal(signal) {
      if (this._signalSender) {
        this._signalSender(signal);
      }
    }

    setSignalSender(fn) {
      this._signalSender = fn;
    }

    async close() {
      this.sending = false;
      this.dataChannel?.close();
      this.peerConnection?.close();
      this.connected = false;
      // 清理 OPFS 会话
      if (this.storage && !this.resumeMode) {
        await this.storage.clear().catch(() => {});
      }
    }
  }

  return { createSender, createReceiver, CHUNK_SIZE };
})();
