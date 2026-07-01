/**
 * app.js — gimme 主应用逻辑
 * 
 * 协调层：连接 WebSocket 信令 ↔ WebRTC P2P ↔ UI 渲染
 * 职责单一：状态机驱动，不直接操作 DOM（由 ui.js 负责）
 */

const App = (() => {
  // --- 状态 ---
  const state = {
    phase: 'idle',        // idle | creating | waiting | joining | connected | transferring | done | error
    role: null,           // 'sender' | 'receiver'
    roomId: null,
    clientId: null,
    ws: null,
    engine: null,
    cryptoKey: null,
    rawKey: null,
    file: null,
    shareLink: null,
    wsConnected: false,
    reconnectAttempts: 0,
    maxReconnectDelay: 30000,  // 最大重连间隔 30s
    keyReady: null,       // Promise，密钥生成完成信号
    reconnectTimer: null  // 重连定时器引用
  };

  // --- 依赖注入 UI ---
  let UI = null;
  function setUI(uiModule) {
    UI = uiModule;
  }

  // --- 信令消息发送（带状态防御）---
  function sendSignalingMessage(msg) {
    if (!state.wsConnected || !state.ws || state.ws.readyState !== WebSocket.OPEN) {
      console.warn('[WS] 信令通道未就绪，消息已丢弃:', msg.type || msg);
      return;
    }
    state.ws.send(JSON.stringify(msg));
  }

  // --- 指数退避重连 ---
  function scheduleReconnect() {
    if (state.phase === 'done' || state.phase === 'idle') return;
    const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempts), state.maxReconnectDelay);
    state.reconnectAttempts++;
    console.log(`[WS] ${delay}ms 后尝试第 ${state.reconnectAttempts} 次重连...`);
    UI?.onConnectionState?.('reconnecting');
    state.reconnectTimer = setTimeout(() => {
      connectWebSocket();
    }, delay);
  }

  // --- WebSocket 连接 ---
  function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}`;
    state.ws = new WebSocket(wsUrl);

    state.ws.onopen = () => {
      console.log('[WS] 信令连接已建立');
      state.wsConnected = true;
      state.reconnectAttempts = 0;
    };

    state.ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      handleSignalingMessage(msg);
    };

    state.ws.onclose = () => {
      state.wsConnected = false;
      console.log('[WS] 信令连接断开');
      if (state.phase !== 'done') {
        scheduleReconnect();
      }
    };

    state.ws.onerror = () => {
      // onerror 后必然触发 onclose，由 onclose 统一处理重连
      console.error('[WS] 信令连接错误');
    };
  }

  // --- 信令消息处理 ---
  function handleSignalingMessage(msg) {
    switch (msg.type) {
      case 'welcome':
        state.clientId = msg.clientId;
        break;

      case 'room_created':
        state.roomId = msg.roomId;
        state.phase = 'waiting';
        // 等待密钥生成完成（createRoom 已后台启动）
        _waitForKey().then(() => {
          const keyStr = CryptoModule.bufferToBase64(state.rawKey);
          state.shareLink = `${location.origin}/#${msg.roomId}|${keyStr}`;
          UI?.onRoomCreated(msg.roomId, state.shareLink);
        });
        break;

      case 'room_joined':
        state.roomId = msg.roomId;
        state.phase = 'connected';
        state.role = 'receiver';
        UI?.onRoomJoined(msg.roomId);
        // 接收端初始化 WebRTC
        initReceiverEngine(msg.peerId);
        break;

      case 'peer_joined':
        state.phase = 'connected';
        UI?.onPeerJoined();
        // 发送端发起 WebRTC 连接
        initSenderEngine(msg.peerId);
        break;

      case 'signal':
        // 引擎内部已通过 onSignal 回调处理信令
        // 这里不再重复转发，避免 _handleSignal 被调用两次
        break;

      case 'peer_disconnected':
        UI?.onPeerDisconnected();
        // 仅关闭 P2P 引擎，保留 WebSocket 连接
        // 用户可通过"重新开始"按钮手动 cleanup 回到 idle
        state.engine?.close();
        state.engine = null;
        state.phase = 'idle';
        break;

      case 'room_expired':
        UI?.showToast?.('房间已过期（10分钟限制）', 'error');
        cleanup();
        break;

      case 'error':
        UI?.showToast?.(msg.message, 'error');
        // 加入失败时恢复加入按钮状态
        if (state.phase === 'joining') {
          // 通过 UI 恢复按钮状态（如果 UI 已挂载）
          setTimeout(() => {
            const joinBtn = document.querySelector('#joinBtn');
            if (joinBtn) {
              joinBtn.disabled = false;
              joinBtn.textContent = '加入';
            }
          }, 0);
        }
        break;

      case 'pong':
        break;
    }
  }

  // --- 发送端初始化 ---
  async function initSenderEngine(peerId) {
    state.engine = P2PEngine.createSender({
      ws: state.ws,
      onSignal: (handler) => {
        const origHandler = state.ws.onmessage;
        state.ws.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === 'signal' && msg.from === peerId) {
            handler(msg);
          } else {
            origHandler(e);
          }
        };
      },
      onStateChange: (status) => {
        UI?.onConnectionState(status);
        if (status === 'connected') {
          UI?.onTransferReady();
        } else if (status === 'relay_active') {
          UI?.showToast('通过中继服务器转发中（数据仍为端到端加密）', 'warning');
        } else if (status === 'relay_fallback') {
          UI?.showToast('P2P 直连失败，尝试中继转发...', 'warning');
        } else if (status === 'resuming') {
          UI?.onResumeConnected();
        }
      },
      onProgress: (sent, total) => {
        UI?.onProgress(sent, total);
      },
      onComplete: () => {
        state.phase = 'done';
        UI?.onTransferComplete();
      },
      onError: (err) => {
        UI?.showError('传输错误: ' + err.message);
      },
      onIceLoading: (loading) => {
        UI?.onIceLoading(loading);
      }
    });

    await state.engine.init();
    state.engine.setSignalSender((signal) => {
      sendSignalingMessage({ type: 'signal', to: peerId, signal });
    });

    // 发送端发起 Offer
    state.engine.createOffer();
  }

  // --- 接收端初始化 ---
  async function initReceiverEngine(peerId) {
    state.engine = P2PEngine.createReceiver({
      ws: state.ws,
      onSignal: (handler) => {
        const origHandler = state.ws.onmessage;
        state.ws.onmessage = (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === 'signal' && msg.from === peerId) {
            handler(msg);
          } else {
            origHandler(e);
          }
        };
      },
      onStateChange: (status) => {
        UI?.onConnectionState(status);
        if (status === 'receiving') {
          UI?.onTransferStarted();
        } else if (status === 'relay_active') {
          UI?.showToast('通过中继服务器转发中（数据仍为端到端加密）', 'warning');
        } else if (status === 'relay_fallback') {
          UI?.showToast('P2P 直连失败，尝试中继转发...', 'warning');
        } else if (status === 'resuming') {
          UI?.onResumeConnected();
        }
      },
      onProgress: (received, total) => {
        UI?.onProgress(received, total);
      },
      onComplete: (blob, fileName) => {
        state.phase = 'done';
        UI?.onReceiveComplete(blob, fileName);
      },
      onError: (err) => {
        UI?.showError('接收错误: ' + err.message);
      },
      onIceLoading: (loading) => {
        UI?.onIceLoading(loading);
      }
    });

    await state.engine.init();
    state.engine.setSignalSender((signal) => {
      sendSignalingMessage({ type: 'signal', to: peerId, signal });
    });

    // 使用 init() 中预导入的密钥
    if (state.cryptoKey) {
      state.engine.decryptKey = state.cryptoKey;
    } else {
      // 兜底：从 URL Hash 中提取密钥
      const hash = location.hash.slice(1);
      const parts = hash.split('|');
      if (parts.length >= 2) {
        const keyStr = parts[1];
        CryptoModule.importKey(keyStr).then(key => {
          state.engine.decryptKey = key;
        }).catch(err => {
          console.error('[KEY] 接收端密钥导入失败:', err);
          UI?.showToast?.('解密密钥无效，请检查链接是否正确', 'error');
        });
      } else {
        console.error('[KEY] URL Hash 格式错误，缺少密钥');
        UI?.showToast?.('链接格式错误，无法获取解密密钥', 'error');
      }
    }
  }

  // --- 公开 API ---

  /** 等待密钥生成完成 */
  function _waitForKey() {
    return state.keyReady || Promise.resolve();
  }

  function createRoom(file) {
    state.file = file;
    state.role = 'sender';
    state.phase = 'creating';

    // 创建密钥就绪信号
    state.keyReady = new Promise((resolve, reject) => {
      // 后台并行：生成 AES 密钥 + 计算文件哈希指纹
      Promise.all([
        CryptoModule.generateKey(),
        HashModule.computeFingerprint(file)
      ]).then(([{ rawKey, cryptoKey }, fileHash]) => {
        state.rawKey = rawKey;
        state.cryptoKey = cryptoKey;
        state.fileHash = fileHash;
        resolve();
      }).catch(err => {
        UI?.showError('密钥生成失败: ' + err.message);
        reject(err);
      });
    });

    // 立即发送 create_room，让 UI 切换到 waiting 状态
    sendSignalingMessage({ type: 'create_room' });
  }

  function joinRoom(roomId) {
    state.role = 'receiver';
    state.phase = 'joining';
    sendSignalingMessage({ type: 'join_room', roomId });
  }

  function startTransfer() {
    if (state.engine && state.file && state.cryptoKey) {
      state.phase = 'transferring';
      state.engine.startSending(state.file, state.cryptoKey, state.fileHash);
    }
  }

  function cleanup() {
    state.engine?.close();
    state.engine = null;
    // 取消待执行的重连定时器
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    // 关闭 WebSocket 连接
    state.wsConnected = false;
    if (state.ws) {
      state.ws.onclose = null;  // 阻止触发重连
      state.ws.onerror = null;
      state.ws.close();
      state.ws = null;
    }
    state.phase = 'idle';
    state.role = null;
    state.roomId = null;
    state.file = null;
    state.cryptoKey = null;
    state.rawKey = null;
    state.fileHash = null;
    state.reconnectAttempts = 0;
  }

  function init() {
    connectWebSocket();
    // 检查 URL 是否包含房间信息
    // 格式: #ROOMID|BASE64_KEY
    const hash = location.hash.slice(1);
    if (hash && hash.includes('|')) {
      const parts = hash.split('|');
      const roomId = parts[0];
      const keyStr = parts[1];
      if (roomId) {
        // 预导入解密密钥（接收方使用）
        // 必须等待密钥导入完成再触发 joinRoom，否则 initReceiverEngine
        // 执行时 state.cryptoKey 可能还是 null
        const keyPromise = keyStr
          ? CryptoModule.importKey(keyStr).then(key => {
              state.cryptoKey = key;
            }).catch(err => {
              console.error('[KEY] 密钥导入失败:', err);
              UI?.showToast?.('解密密钥无效，请检查链接', 'error');
            })
          : Promise.resolve();
        // 等待密钥就绪后再自动加入房间
        keyPromise.then(() => {
          UI?.onHashDetected(roomId);
        });
      }
    }
  }

  return {
    setUI,
    init,
    createRoom,
    joinRoom,
    startTransfer,
    cleanup,
    getState: () => state
  };
})();
