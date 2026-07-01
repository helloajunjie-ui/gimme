/**
 * gimme 信令服务器
 *
 * 职责 ONLY：牵线搭桥 + 静态文件服务 + 动态节点分发
 * - 不存储任何文件数据
 * - 不记录任何传输日志
 * - 房间号过期自动清理
 * - /api/nodes 返回 HMAC 时效凭证（防盗刷）
 *
 * 架构：HTTP (静态文件 + JSON API) + WebSocket (信令)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const ROOM_EXPIRE_MS = 10 * 60 * 1000; // 10分钟过期
const ROOM_ID_LENGTH = 6;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// --- TURN 中继配置（部署时替换）---
const TURN_CONFIG = {
  // 共享密钥 — 与 coturn 的 static-auth-secret 一致
  secret: process.env.TURN_SECRET || 'change_this_to_your_turn_secret',
  // 中继服务器地址列表（多节点容灾阵列）
  relays: [
    { domain: 'turn:relay-asia.your-app.com:3478', realm: 'your-app.com' },
    // { domain: 'turn:relay-us.your-app.com:3478', realm: 'your-app.com' },
    // { domain: 'turn:relay-eu.your-app.com:3478', realm: 'your-app.com' },
  ]
};

// --- MIME 类型映射 ---
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// --- 内存状态 ---
const rooms = new Map();
const clients = new Map();

// --- 工具函数 ---
function generateRoomId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < ROOM_ID_LENGTH; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

function generateClientId() {
  return uuidv4().slice(0, 8);
}

// --- HMAC 时效凭证生成 ---
function generateTurnCredentials(relayDomain, realm) {
  const unixTimestamp = Math.floor(Date.now() / 1000) + 300; // 5分钟有效期
  const username = `${unixTimestamp}:${uuidv4().slice(0, 8)}`;
  const hmac = crypto.createHmac('sha1', TURN_CONFIG.secret);
  hmac.update(username);
  const credential = hmac.digest('base64');

  return {
    urls: relayDomain,
    username,
    credential,
    realm
  };
}

// --- HTTP 服务器（静态文件 + API）---
const httpServer = http.createServer((req, res) => {
  // ===== API 路由：动态节点分发 =====
  if (req.url === '/api/nodes') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store, max-age=0');

    const nodes = [
      // 免费 STUN（打洞牵线）
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
    ];

    // 仅当用户配置了自定义 TURN secret 时才返回 TURN 节点
    // 默认值 'change_this_to_your_turn_secret' 会生成无效凭证，导致 ICE 超时
    if (TURN_CONFIG.secret && TURN_CONFIG.secret !== 'change_this_to_your_turn_secret') {
      for (const relay of TURN_CONFIG.relays) {
        nodes.push(generateTurnCredentials(relay.domain, relay.realm));
      }
    }

    res.end(JSON.stringify(nodes));
    return;
  }

  // ===== 静态文件服务 =====
  let filePath = req.url === '/' ? '/index.html' : req.url;

  if (!path.extname(filePath)) {
    filePath = '/index.html';
  }

  const fullPath = path.join(PUBLIC_DIR, filePath);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      if (err.code === 'ENOENT') {
        fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, data2) => {
          if (err2) {
            res.writeHead(500);
            res.end('Internal Server Error');
            return;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(data2);
        });
      } else {
        res.writeHead(500);
        res.end('Internal Server Error');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
});

// --- 房间过期清理 ---
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms.entries()) {
    if (now - room.createdAt > ROOM_EXPIRE_MS) {
      for (const clientId of [room.creator, room.joiner].filter(Boolean)) {
        const clientData = clients.get(clientId);
        if (clientData?.ws.readyState === 1) {
          clientData.ws.send(JSON.stringify({ type: 'room_expired', roomId }));
        }
        // 先清理 clients Map，避免 close 事件触发后其他逻辑拿到 stale 引用
        clients.delete(clientId);
        clientData?.ws.close();
      }
      rooms.delete(roomId);
      console.log(`[过期] 房间 ${roomId} 已清理`);
    }
  }
}, 30_000);

// --- WebSocket 服务器 ---
const wss = new WebSocketServer({ server: httpServer });
console.log(`[信令] gimme 服务器启动于 http://localhost:${PORT}`);

wss.on('connection', (ws) => {
  const clientId = generateClientId();
  clients.set(clientId, { ws, roomId: null, role: null });
  console.log(`[连接] 客户端 ${clientId} 加入`);

  ws.send(JSON.stringify({ type: 'welcome', clientId }));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return ws.send(JSON.stringify({ type: 'error', message: '无效消息格式' }));
    }

    const client = clients.get(clientId);
    if (!client) return;

    switch (msg.type) {
      case 'create_room': {
        const roomId = generateRoomId();
        rooms.set(roomId, { creator: clientId, joiner: null, createdAt: Date.now() });
        client.roomId = roomId;
        client.role = 'creator';
        ws.send(JSON.stringify({ type: 'room_created', roomId }));
        console.log(`[房间] ${clientId} 创建房间 ${roomId}`);
        break;
      }

      case 'join_room': {
        const { roomId } = msg;
        const room = rooms.get(roomId);
        if (!room) {
          return ws.send(JSON.stringify({ type: 'error', message: '房间不存在或已过期' }));
        }
        if (room.joiner) {
          return ws.send(JSON.stringify({ type: 'error', message: '房间已满' }));
        }
        // 验证创建者是否在线
        const creator = clients.get(room.creator);
        if (!creator || creator.ws.readyState !== 1) {
          rooms.delete(roomId);
          return ws.send(JSON.stringify({ type: 'error', message: '创建者已离线，房间已关闭' }));
        }
        room.joiner = clientId;
        client.roomId = roomId;
        client.role = 'joiner';

        creator.ws.send(JSON.stringify({ type: 'peer_joined', peerId: clientId }));
        ws.send(JSON.stringify({ type: 'room_joined', roomId, peerId: room.creator }));
        console.log(`[房间] ${clientId} 加入房间 ${roomId}`);
        break;
      }

      case 'signal': {
        const { to, signal } = msg;
        // 验证发送方仍在有效房间中，防止断开连接后的残留消息转发
        const sender = clients.get(clientId);
        if (!sender || !sender.roomId || !rooms.has(sender.roomId)) {
          return;
        }
        const target = clients.get(to);
        if (target?.ws.readyState === 1) {
          target.ws.send(JSON.stringify({
            type: 'signal',
            from: clientId,
            signal
          }));
        }
        break;
      }

      case 'ping': {
        ws.send(JSON.stringify({ type: 'pong' }));
        break;
      }

      default:
        ws.send(JSON.stringify({ type: 'error', message: '未知消息类型' }));
    }
  });

  ws.on('close', () => {
    const client = clients.get(clientId);
    if (client?.roomId) {
      const room = rooms.get(client.roomId);
      if (room) {
        const otherId = room.creator === clientId ? room.joiner : room.creator;
        if (otherId) {
          const other = clients.get(otherId);
          if (other?.ws.readyState === 1) {
            other.ws.send(JSON.stringify({ type: 'peer_disconnected', peerId: clientId }));
          }
        }
        if (room.creator === clientId) {
          rooms.delete(client.roomId);
          console.log(`[房间] 创建者离开，房间 ${client.roomId} 已销毁`);
        } else {
          room.joiner = null;
        }
      }
    }
    clients.delete(clientId);
    console.log(`[断开] 客户端 ${clientId} 离开`);
  });
});

// --- 启动 ---
httpServer.listen(PORT, () => {
  console.log(`[HTTP] 静态文件服务: http://localhost:${PORT}`);
});
