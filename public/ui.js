/**
 * ui.js — gimme UI 渲染层
 *
 * 设计语言：Cyber-Minimalism
 * - 深色主题，仅使用关键色（青蓝 #00f0ff / 翠绿 #00ff88）
 * - 零冗余元素，每个像素都有意义
 * - 状态变化通过微动效传递
 *
 * 状态流：idle → creating → waiting → connected → transferring → done
 *
 * 防御机制：
 * - Screen Wake Lock API：防止手机端传输时锁屏断连
 * - 强干预提示：传输期间警告用户不要切换应用
 */

const UI = (() => {
  // --- DOM 缓存 ---
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  let dom = {};

  // --- Wake Lock 句柄 ---
  let wakeLock = null;

  function cacheDOM() {
    dom = {
      app: $('#app'),
      dropZone: $('#dropZone'),
      dropOverlay: $('#dropOverlay'),
      fileInput: $('#fileInput'),
      phaseIdle: $('#phaseIdle'),
      phaseActive: $('#phaseActive'),
      phaseDone: $('#phaseDone'),

      // 空闲状态
      uploadIcon: $('#uploadIcon'),

      // 活跃状态
      roomDisplay: $('#roomDisplay'),
      roomCode: $('#roomCode'),
      copyBtn: $('#copyBtn'),
      copyTooltip: $('#copyTooltip'),
      qrContainer: $('#qrContainer'),
      statusIndicator: $('#statusIndicator'),
      statusText: $('#statusText'),
      statusDot: $('#statusDot'),
      fileName: $('#fileName'),
      fileSize: $('#fileSize'),
      progressContainer: $('#progressContainer'),
      progressBar: $('#progressBar'),
      progressText: $('#progressText'),
      speedText: $('#speedText'),
      lockIcon: $('#lockIcon'),
      cancelBtn: $('#cancelBtn'),
      startBtn: $('#startBtn'),
      wakeLockWarning: $('#wakeLockWarning'),

      // 完成状态
      doneIcon: $('#doneIcon'),
      doneTitle: $('#doneTitle'),
      doneAction: $('#doneAction'),
      doneBtn: $('#doneBtn'),

      // 加入模式
      joinInput: $('#joinInput'),
      joinBtn: $('#joinBtn'),
      joinError: $('#joinError'),

      // Toast
      toast: $('#toast'),
      toastMessage: $('#toastMessage'),
    };
  }

  // --- 状态管理 ---
  let currentPhase = 'idle';
  let transferStartTime = 0;
  let lastBytes = 0;

  // --- Screen Wake Lock 管理 ---
  async function requestWakeLock() {
    if (!navigator.wakeLock) {
      console.log('[WakeLock] API 不可用（非安全上下文或不支持）');
      return;
    }
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        console.log('[WakeLock] 已释放');
        dom.wakeLockWarning?.classList.remove('hidden');
      });
      console.log('[WakeLock] 屏幕常亮已激活');
      dom.wakeLockWarning?.classList.add('hidden');
    } catch (err) {
      console.warn('[WakeLock] 激活失败:', err.message);
      // 失败时显示警告
      dom.wakeLockWarning?.classList.remove('hidden');
    }
  }

  function releaseWakeLock() {
    if (wakeLock) {
      wakeLock.release().catch(() => {});
      wakeLock = null;
    }
    dom.wakeLockWarning?.classList.add('hidden');
  }

  // 页面可见性变化时重新获取 Wake Lock
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && currentPhase === 'transferring') {
      requestWakeLock();
    }
  });

  function showPhase(phase) {
    dom.phaseIdle.classList.toggle('hidden', phase !== 'idle' && phase !== 'creating');
    dom.phaseActive.classList.toggle('hidden', phase === 'idle' || phase === 'done');
    dom.phaseDone.classList.toggle('hidden', phase !== 'done');
    currentPhase = phase;
  }

  // --- Toast 通知 ---
  function showToast(message, type = 'error') {
    dom.toastMessage.textContent = message;
    dom.toast.className = `toast toast-${type} show`;
    setTimeout(() => {
      dom.toast.classList.remove('show');
    }, 4000);
  }

  // --- 文件大小格式化 ---
  function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function formatSpeed(bytesPerSec) {
    return formatSize(bytesPerSec) + '/s';
  }

  // --- 房间号分段显示 ---
  function formatRoomCode(code) {
    return code.split('').join(' ');
  }

  // ==================== 公开 API ====================

  function init() {
    cacheDOM();
    showPhase('idle');

    // --- 拖拽上传 ---
    dom.dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dom.dropOverlay.classList.add('active');
    });

    dom.dropZone.addEventListener('dragleave', () => {
      dom.dropOverlay.classList.remove('active');
    });

    dom.dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dom.dropOverlay.classList.remove('active');
      const files = e.dataTransfer.files;
      if (files.length > 0) {
        handleFileSelected(files[0]);
      }
    });

    dom.dropZone.addEventListener('click', () => {
      dom.fileInput.click();
    });

    dom.fileInput.addEventListener('change', () => {
      if (dom.fileInput.files.length > 0) {
        handleFileSelected(dom.fileInput.files[0]);
      }
    });

    // --- 复制房间号 ---
    dom.copyBtn.addEventListener('click', () => {
      const text = dom.roomCode.textContent.replace(/\s/g, '');
      navigator.clipboard.writeText(text).then(() => {
        dom.copyTooltip.classList.add('show');
        setTimeout(() => dom.copyTooltip.classList.remove('show'), 1500);
      });
    });

    // --- 取消 ---
    dom.cancelBtn.addEventListener('click', () => {
      releaseWakeLock();
      App.cleanup();
      showPhase('idle');
    });

    // --- 开始传输 ---
    dom.startBtn.addEventListener('click', () => {
      App.startTransfer();
    });

    // --- 完成按钮 ---
    dom.doneBtn.addEventListener('click', () => {
      App.cleanup();
      showPhase('idle');
      dom.fileInput.value = '';
    });

    // --- 加入房间 ---
    dom.joinBtn.addEventListener('click', () => {
      const code = dom.joinInput.value.trim().toUpperCase();
      if (code.length < 4) {
        dom.joinError.textContent = '请输入有效的房间号';
        dom.joinError.classList.remove('hidden');
        return;
      }
      dom.joinError.classList.add('hidden');
      App.joinRoom(code);
    });

    dom.joinInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') dom.joinBtn.click();
    });

    dom.joinInput.addEventListener('input', () => {
      dom.joinInput.value = dom.joinInput.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });

    // 初始化 App
    App.setUI(UI);
    App.init();
  }

  // --- 文件选择处理 ---
  function handleFileSelected(file) {
    if (file.size === 0) {
      showToast('不支持空文件');
      return;
    }
    if (file.size > 2 * 1024 * 1024 * 1024) {
      showToast('文件超过 2GB 限制（浏览器限制）');
      return;
    }
    App.createRoom(file);
  }

  // ==================== App 回调 ====================

  function onRoomCreated(roomId, shareLink) {
    showPhase('waiting');
    dom.roomCode.textContent = formatRoomCode(roomId);
    dom.statusText.textContent = '等待对方连接...';
    dom.statusDot.className = 'status-dot pulse';
    dom.lockIcon.className = 'lock-icon secure';
    dom.progressContainer.classList.add('hidden');
    dom.startBtn.classList.add('hidden');

    // 显示文件信息
    const file = App.getState().file;
    dom.fileName.textContent = file.name;
    dom.fileSize.textContent = formatSize(file.size);

    // 自动复制链接
    navigator.clipboard.writeText(shareLink).then(() => {
      showToast('分享链接已复制到剪贴板', 'success');
    }).catch(() => {
      // 手动复制
    });
  }

  function onRoomJoined(roomId) {
    showPhase('connected');
    dom.roomCode.textContent = formatRoomCode(roomId);
    dom.statusText.textContent = '已连接到房间';
    dom.statusDot.className = 'status-dot connected';
    dom.lockIcon.className = 'lock-icon secure';
    dom.progressContainer.classList.add('hidden');
    dom.startBtn.classList.add('hidden');
    dom.fileName.textContent = '等待发送方...';
    dom.fileSize.textContent = '';
  }

  function onPeerJoined() {
    dom.statusText.textContent = '对方已加入 ✓';
    dom.statusDot.className = 'status-dot connected';
    dom.startBtn.classList.remove('hidden');
  }

  function onPeerDisconnected() {
    showToast('对方已断开连接', 'warning');
    dom.statusText.textContent = '对方已离开';
    dom.statusDot.className = 'status-dot disconnected';
    dom.startBtn.classList.add('hidden');
  }

  function onConnectionState(status) {
    switch (status) {
      case 'connected':
        // 传输中收到 connected：仅在续传模式下恢复进度条
        if (currentPhase === 'transferring' && dom.progressBar.classList.contains('resuming')) {
          dom.progressBar.classList.remove('resuming');
          dom.statusText.textContent = '隧道已重连，继续安全传输';
        } else if (currentPhase === 'transferring') {
          // 普通 ICE 抖动，不改变状态文本
          dom.statusDot.className = 'status-dot connected';
          return;
        } else {
          dom.statusText.textContent = 'P2P 通道已建立 ✓';
        }
        dom.statusDot.className = 'status-dot connected';
        break;
      case 'disconnected':
        dom.statusText.textContent = '连接断开';
        dom.statusDot.className = 'status-dot disconnected';
        break;
      case 'failed':
        dom.statusText.textContent = '连接失败（尝试中继...）';
        dom.statusDot.className = 'status-dot warning';
        break;
      case 'receiving':
        dom.statusText.textContent = '正在接收文件...';
        dom.statusDot.className = 'status-dot transferring';
        break;
      case 'assembling':
        dom.statusText.textContent = '正在解密组装...';
        dom.statusDot.className = 'status-dot transferring';
        break;
      case 'resuming':
        // 断网续传 — 琥珀色状态，不弹错误弹窗
        dom.statusText.textContent = '检测到网络波动，正在维持加密隧道...';
        dom.statusDot.className = 'status-dot warning';
        dom.progressBar.classList.add('resuming');
        break;
      case 'reconnecting':
        // 信令断开 — 指数退避重连，不弹错误弹窗
        dom.statusText.textContent = '信令连接断开，正在重连...';
        dom.statusDot.className = 'status-dot disconnected';
        break;
    }
  }

  function onTransferReady() {
    dom.statusText.textContent = 'P2P 通道已就绪，点击开始传输';
    dom.statusDot.className = 'status-dot connected';
  }

  function onTransferStarted() {
    dom.progressContainer.classList.remove('hidden');
    transferStartTime = Date.now();
    lastBytes = 0;
    // 激活屏幕常亮（防止手机锁屏断连）
    requestWakeLock();
  }

  function onProgress(current, total) {
    dom.progressContainer.classList.remove('hidden');
    const pct = total > 0 ? Math.min((current / total) * 100, 100) : 0;
    dom.progressBar.style.width = pct + '%';
    dom.progressText.textContent = `${formatSize(current)} / ${formatSize(total)}`;

    // 续传后首次进度更新：移除琥珀色，触发高光扫掠
    if (dom.progressBar.classList.contains('resuming')) {
      dom.progressBar.classList.remove('resuming');
      dom.progressBar.classList.add('sweep');
      setTimeout(() => {
        dom.progressBar.classList.remove('sweep');
      }, 800);
    }

    // 速度计算
    const elapsed = (Date.now() - transferStartTime) / 1000;
    if (elapsed > 0) {
      const speed = current / elapsed;
      dom.speedText.textContent = formatSpeed(speed);
    }
  }

  /**
   * 续传成功回调 — 断境重圆
   * - 进度条闪过一道高光（Sweep Effect）
   * - 移除琥珀色 resuming 类
   * - 状态文本优雅提示
   */
  function onResumeConnected() {
    dom.progressBar.classList.remove('resuming');
    // 触发 sweep 动画：先加类，动画结束后自动移除
    dom.progressBar.classList.add('sweep');
    setTimeout(() => {
      dom.progressBar.classList.remove('sweep');
    }, 800);
    dom.statusText.textContent = '隧道已重连，继续安全传输';
    dom.statusDot.className = 'status-dot connected';
  }

  function onTransferComplete() {
    releaseWakeLock();
    dom.statusText.textContent = '文件已发送 ✓';
    dom.statusDot.className = 'status-dot done';
    dom.progressBar.style.width = '100%';
    dom.progressBar.classList.remove('resuming');
    dom.progressBar.classList.remove('sweep');
    dom.startBtn.classList.add('hidden');
    showPhase('done');
    dom.doneIcon.textContent = '✓';
    dom.doneTitle.textContent = '传输完成';
    dom.doneAction.textContent = '文件已安全送达对方';
    dom.doneBtn.textContent = '发送新文件';
  }

  function onReceiveComplete(blob, fileName) {
    releaseWakeLock();
    showPhase('done');
    dom.doneIcon.textContent = '📥';
    dom.doneTitle.textContent = '文件已接收';
    dom.doneAction.textContent = `${fileName} (${formatSize(blob.size)})`;
    dom.doneBtn.textContent = '下载文件';

    // 替换按钮行为
    dom.doneBtn.onclick = () => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      setTimeout(() => {
        App.cleanup();
        showPhase('idle');
        dom.doneBtn.onclick = null;
      }, 1000);
    };
  }

  function onHashDetected(roomId) {
    dom.joinInput.value = roomId;
    dom.joinBtn.click();
  }

  function showError(message) {
    showToast(message, 'error');
  }

  /**
   * ICE 节点加载状态 — 微光效应
   * 获取中继节点时显示加载提示，让用户感知系统正在工作
   */
  function onIceLoading(loading) {
    if (loading && currentPhase === 'waiting') {
      dom.statusText.textContent = '正在获取最优路由节点...';
      dom.statusDot.className = 'status-dot pulse';
    }
  }

  return {
    init,
    onRoomCreated,
    onRoomJoined,
    onPeerJoined,
    onPeerDisconnected,
    onConnectionState,
    onTransferReady,
    onTransferStarted,
    onProgress,
    onTransferComplete,
    onReceiveComplete,
    onHashDetected,
    showError,
    onIceLoading,
    onResumeConnected
  };
})();

// --- 启动 ---
document.addEventListener('DOMContentLoaded', () => {
  UI.init();
});
