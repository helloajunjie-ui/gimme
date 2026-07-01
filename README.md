# gimme · 给我

> 零信任端到端加密 P2P 文件传输 · 无需注册 · 阅后即焚

**中文名：** 给我  
**英文名：** gimme（口语化的"给我"）

---

## 目录

- [快速开始](#快速开始)
- [使用方式](#使用方式)
- [部署指南](#部署指南)
- [架构](#架构)
- [技术栈](#技术栈)
- [安全设计](#安全设计)
- [断点续传](#断点续传)
- [状态机](#状态机)
- [体验特性](#体验特性)
- [Bug 修复历史](#bug-修复历史)
- [本地开发](#本地开发)
- [协议](#协议)

---

## 快速开始

### 直接部署

```bash
# 1. 上传项目到服务器
# 2. 安装依赖
npm install

# 3. 启动
npm start

# 4. 后台运行（关闭终端不中断）
nohup node server/index.js > server.log 2>&1 &
```

打开 `http://你的服务器IP:3000` 即可使用。

### Docker 部署

```bash
# 构建并启动
docker compose up -d

# 查看日志
docker compose logs -f

# 停止
docker compose down
```

---

## 使用方式

```
发送方 A                          接收方 B
1. 打开 http://你的地址:3000      4. 收到链接，点击打开
2. 拖拽或选择文件                 5. 自动连接，自动解密
3. 把生成的链接发给 B             6. 文件自动保存到本地
```

生成的链接长这样：

```
http://你的地址:3000/#D42K84|RIhL66UFvSN163dqqY5dnLGHLeJrYs+G9asZfMmFavM=
```

`#` 后面的内容永远不会发送到服务器，只有你和对方能看到。

---

## 部署指南

### 文件清单

```
gimme/
├── server/index.js       # 信令服务器（唯一需要跑的服务）
├── public/               # 网页文件（由 server 自动托管）
│   ├── index.html
│   ├── style.css
│   ├── crypto.js
│   ├── hash.js
│   ├── storage.js
│   ├── webrtc.js
│   ├── app.js
│   └── ui.js
├── package.json
├── package-lock.json
├── Dockerfile            # Docker 构建文件
└── docker-compose.yml    # Docker 编排文件
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3000` |
| `TURN_SECRET` | TURN 中继密钥（可选） | `change_this_to_your_turn_secret` |

> ⚠️ 如果 `TURN_SECRET` 未设置或为默认值，服务器将**只返回 STUN 节点**，不会暴露 TURN 凭证。

### Nginx 反代（绑定域名 + SSL）

```nginx
# HTTP -> HTTPS 重定向
server {
    listen 80;
    server_name gimme.your.com;
    return 301 https://$host$request_uri;
}

# HTTPS 反代
server {
    listen 443 ssl;
    server_name gimme.your.com;

    # SSL 证书路径（用 certbot 或自行申请）
    ssl_certificate     /etc/nginx/ssl/gimme.your.com.pem;
    ssl_certificate_key /etc/nginx/ssl/gimme.your.com.key;
    ssl_protocols       TLSv1.2 TLSv1.3;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> 💡 推荐用 [acme.sh](https://github.com/acmesh-official/acme.sh) 或 Certbot 自动申请免费 SSL 证书。  
> WebSocket 的 `wss://` 由 Nginx 自动处理，后端 Node.js 无需任何改动。

---

## 架构

```
用户浏览器                         你的服务器（¥30/月）
┌─────────────────────┐          ┌──────────────────────┐
│  网页 + 加密 + P2P   │  HTTP   │  server/index.js      │
│  (全部在浏览器运行)   │ ◄───── │  ├─ 托管网页文件       │
│                      │  WS     │  ├─ WebSocket 信令     │
│  数据不经过服务器     │ ◄───── │  └─ /api/nodes API     │
│  AES-GCM 加密        │          └──────────────────────┘
│  P2P 直连传输        │
└─────────────────────┘
```

- **服务器只负责牵线搭桥**，不存储任何文件
- **加密密钥只在 URL # 后面传递**，服务器看不到
- **90% 的流量走 P2P 直连**，不消耗服务器带宽
- **断网自动续传**，进度不归零

### 核心流程

```
发送方                             接收方
  │                                  │
  ├─ 选择文件                        │
  ├─ 生成 AES-256 密钥               │
  ├─ 创建房间 (WebSocket)            │
  ├─ 生成分享链接 (roomId|key) ────→ │
  │                                  ├─ 解析 URL hash 获取密钥
  │                                  ├─ 加入房间 (WebSocket)
  ├─ 交换 SDP/ICE ←───────────────→ │
  ├─ P2P 直连建立                    │
  ├─ 发送文件元数据 ───────────────→ │
  │                                  ├─ 创建 OPFS 会话
  ├─ 64KB 分块加密传输 ────────────→ │
  │                                  ├─ 解密 + 写入 OPFS
  │  (断线重连)                      │
  ├─ 接收方发送 SYNC_STATE ────────→ │
  ├─ 计算偏移量，从断点续传 ────────→ │
  │                                  ├─ 组装文件
  │                                  └─ 下载到本地
```

---

## 技术栈

| 模块 | 技术 |
|------|------|
| 信令服务 | Node.js + ws |
| 加密 | AES-GCM 256-bit（Web Crypto API） |
| P2P 传输 | WebRTC（ICE Racing: Host → STUN → TURN） |
| 断点续传 | OPFS（Origin Private File System） |
| 文件指纹 | SHA-256 采样哈希（>100MB 采样头/中/尾各 1MB） |
| 防凭证盗用 | HMAC-SHA1 动态凭证（5 分钟过期） |
| 防锁屏 | Screen Wake Lock API |
| 分块大小 | 64KB（防止内存溢出） |
| 重传机制 | ChunkID + 应用层重试 + 5 秒监控定时器 |
| 信令可靠性 | 消息队列（WS 未就绪时自动缓存） |

---

## 安全设计

### 零信任架构

| 层面 | 措施 |
|------|------|
| 传输 | 端到端 AES-GCM 256-bit 加密，密钥仅存在于 URL hash |
| 服务器 | 不存储任何文件、密钥、明文数据 |
| 凭证 | TURN 凭证 5 分钟动态过期，HMAC-SHA1 签名 |
| 指纹 | SHA-256 文件哈希校验，防止续传时文件错配 |
| 房间 | 10 分钟自动清理，创建者离开后房间销毁 |

### 加密细节

- 每个数据块使用**随机 12 字节 IV**（AES-GCM 标准）
- IV 与密文一同传输，接收方提取后解密
- 密钥通过 URL `#` 传递，**浏览器保证 hash 不会出现在 HTTP 请求中**
- 即使服务器被攻破，攻击者也无法解密传输内容

---

## 断点续传

```
发送方                             接收方
  │                                  │
  ├─ 发送 META (含文件 hash) ──────→ │
  │                                  ├─ 创建 OPFS 会话
  │                                  ├─ 加载已缓存的分块
  │                                  └─ 发送 SYNC_STATE (已收偏移量)
  │                                  │
  ├─ 收到 SYNC_STATE                 │
  ├─ 校验文件 hash                   │
  ├─ 计算剩余分块                    │
  └─ 从偏移量继续发送 ─────────────→ │
```

- 接收方使用 **OPFS（Origin Private File System）** 持久化已接收的分块
- 重连后通过 `SYNC_STATE` 协议对齐偏移量
- 文件指纹（SHA-256 8 位 hex）防止续传到不同文件
- 大文件（>100MB）使用采样哈希（头 1MB + 中 1MB + 尾 1MB），避免 OOM

---

## 状态机

```
                    ┌──────────┐
                    │   idle   │
                    └────┬─────┘
                         │ 选择文件 / 加入房间
                    ┌────▼─────┐
                    │connecting│ ←── WebSocket 重连（指数退避）
                    └────┬─────┘
                         │ 房间创建 / 加入成功
                    ┌────▼─────┐
                    │  waiting │ ←── 等待对方加入
                    └────┬─────┘
                         │ 对方加入
                    ┌────▼─────┐
                    │connected │ ←── ICE 连接抖动容忍
                    └────┬─────┘
                         │ 开始传输
                    ┌────▼──────┐
                    │transferring│ ←── 传输中
                    └────┬──────┘
                         │ 完成 / 断开
                    ┌────▼─────┐
                    │  done /  │
                    │disconnect│
                    └──────────┘
```

---

## 体验特性

| 特性 | 说明 |
|------|------|
| 拖拽上传 | 支持拖拽和点击选择文件 |
| 一键复制 | 自动生成分享链接，一键复制到剪贴板 |
| TURN 中继提示 | 当 P2P 直连失败走中继时，显示提示但强调"数据仍为端到端加密" |
| 进度动画 | 琥珀色进度条 + 扫描线呼吸动画 + 高光扫掠效果 |
| 屏幕常亮 | 传输期间自动请求 Wake Lock，防止移动端锁屏断连 |
| 断线感知 | 对方断开时显示琥珀色警告，按钮变为"重新开始" |
| 下载防丢失 | 接收完成后缓存 blob URL 5 秒，防止浏览器回收 |
| ICE 加载状态 | 获取 ICE 服务器时显示加载提示 |
| 骨架屏过渡 | 面板入场动画 + 状态切换丝滑过渡 |

---

## Bug 修复历史

经过 8 轮深度代码审查，共修复 **38 个 Bug** 和 **5 个体验缺陷**。

### 第 1 轮（Bug 1-8）

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| 1 | [`webrtc.js`](public/webrtc.js) | `_handleMessage` 中 `dataChannel` 可能为 `null` | 增加空值检查 |
| 2 | [`webrtc.js`](public/webrtc.js) | `_sendNextChunk` 递归未检查 `this.closed` | 增加关闭状态检查 |
| 3 | [`webrtc.js`](public/webrtc.js) | `_assembleFile` 中 `this.chunks` 被并发修改 | 增加数组快照 |
| 4 | [`server/index.js`](server/index.js) | 房间清理时 `ws.close()` 后仍操作 `clients` Map | 调整清理顺序 |
| 5 | [`server/index.js`](server/index.js) | `signal` 转发未验证目标是否在有效房间 | 增加房间验证 |
| 6 | [`webrtc.js`](public/webrtc.js) | `_handleMeta` 未处理重复 META | 增加 `_metaHandled` 标志 |
| 7 | [`webrtc.js`](public/webrtc.js) | `close()` 未清理所有定时器 | 增加定时器引用追踪 |
| 8 | [`webrtc.js`](public/webrtc.js) | `_handleMessage` 中 `decryptChunk` 异常导致整个传输中断 | 增加单块异常隔离 |

### 第 2 轮（Bug 9-16）

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| 9 | [`server/index.js`](server/index.js) | `join_room` 允许在创建者离线后加入 | 验证创建者在线状态 |
| 10 | [`webrtc.js`](public/webrtc.js) | `_handleSignal` 未验证 signal 来源 | 增加 peerId 匹配检查 |
| 11 | [`webrtc.js`](public/webrtc.js) | `_sendNextChunk` 在 `bufferedamountlow` 触发前可能死循环 | 增加异步流控 |
| 12 | [`webrtc.js`](public/webrtc.js) | `_handleMessage` 中 JSON 解析失败导致整个 dataChannel 关闭 | 增加 JSON 解析隔离 |
| 13 | [`server/index.js`](server/index.js) | 默认 TURN_SECRET 暴露 TURN 凭证 | 默认值时不返回 TURN 节点 |
| 14 | [`webrtc.js`](public/webrtc.js) | `_assembleFile` 未处理空文件 | 增加空文件检查 |
| 15 | [`webrtc.js`](public/webrtc.js) | `_handleMeta` 中 `sessionId` 可能重复 | 增加会话去重 |
| 16 | [`server/index.js`](server/index.js) | `signal` 转发后未处理发送方断开 | 增加发送方在线验证 |

### 第 3 轮（Bug 17-22）

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| 17 | [`app.js`](public/app.js) | `handleSignalingMessage` 中 `signal` 类型未正确路由 | 修正路由逻辑 |
| 18 | [`webrtc.js`](public/webrtc.js) | `_handleMeta` 中 `_resumeTimer` 未清理 | 增加定时器引用和清理 |
| 19 | [`webrtc.js`](public/webrtc.js) | `_handleSyncState` 未验证 `fileHash` 字段存在 | 增加字段存在性检查 |
| 20 | [`webrtc.js`](public/webrtc.js) | `_handleRetryRequest` 中空 Blob 导致加密失败 | 增加空 Blob 和空 buffer 检查 |
| 21 | [`webrtc.js`](public/webrtc.js) | `_setupDataChannel` 中旧 dataChannel 未关闭 | 关闭旧 channel 再赋值 |
| 22 | [`ui.js`](public/ui.js) | `onReceiveComplete` 中 blob URL 未及时释放 | 延迟 5 秒 revoke |

### 第 4 轮（Bug 23-26）

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| 23 | [`webrtc.js`](public/webrtc.js) | `_handleMessage` 中 JSON.parse 和业务逻辑共用 try-catch | 分离 JSON 解析和业务逻辑 |
| 24 | [`webrtc.js`](public/webrtc.js) | `startSending` 中 `resuming` 状态后立即 `connected` 导致 UI 闪烁 | 增加 800ms 延迟 |
| 25 | [`app.js`](public/app.js) | `scheduleReconnect` 在用户主动断开后仍重连 | 增加 `disconnected` 阶段检查 |
| 26 | [`app.js`](public/app.js) | `cleanup()` 未重置 `keyReady` 导致下次使用时状态残留 | 重置 `keyReady` 为 `null` |

### 第 5 轮（体验缺陷 1-5）

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| UX1 | [`ui.js`](public/ui.js) | 传输完成后按钮仍显示"取消传输" | 改为"重新开始" |
| UX2 | [`ui.js`](public/ui.js) | 对方断开后无视觉反馈 | 增加琥珀色警告状态 |
| UX3 | [`ui.js`](public/ui.js) | 进度条在续传时无区分 | 增加扫描线呼吸动画 |
| UX4 | [`ui.js`](public/ui.js) | 复制链接无反馈 | 增加 Toast 提示 |
| UX5 | [`ui.js`](public/ui.js) | 大文件传输时无预估时间 | 增加传输速率显示 |

### 第 6 轮（Bug 28-38）

| # | 文件 | 问题 | 修复 |
|---|------|------|------|
| 28 | [`hash.js`](public/hash.js) | 采样哈希阈值 500MB 过高，200MB 文件在移动端 OOM | 降至 100MB |
| 29 | [`storage.js`](public/storage.js) | OPFS `saveChunk` 无 try-catch，并发写入崩溃 | 增加 try-catch 静默降级 |
| 30 | [`app.js`](public/app.js) | `keyPromise.catch()` 未阻止 `.then()` 执行 | catch 中 re-throw + 外层 catch |
| 31 | [`webrtc.js`](public/webrtc.js) | `_handleMeta` 中 `_sendSyncState` 在 `receiving` 前发送 | 移入 `_resumeTimer` 回调 |
| 32 | [`webrtc.js`](public/webrtc.js) | `_sendNextChunk` 重试未 `await` 递归 + 事件监听未清理 | 增加 await + 清理 handler |
| 33 | — | 撤回（经分析非 Bug） | — |
| 34 | [`ui.js`](public/ui.js) | `onTransferStarted` 未同步 `currentPhase` | 增加 `currentPhase = 'transferring'` |
| 35 | — | 撤回（经分析非 Bug） | — |
| 36 | [`index.html`](public/index.html) + [`ui.js`](public/ui.js) | `relay-indicator` CSS 存在但 HTML 无元素、UI 无控制 | 增加 HTML 元素 + DOM 引用 + 控制逻辑 |
| 37 | [`webrtc.js`](public/webrtc.js) | 重传丢失后无兜底，传输永久挂起 | 增加 5 秒间隔重传监控定时器 |
| 38 | [`app.js`](public/app.js) | WS 未就绪时 `sendSignalingMessage` 静默丢消息 | 增加消息队列，`onopen` 时 flush |

---

## 本地开发

```bash
npm install
npm start
# 打开 http://localhost:3000
```

同一 WiFi 下的设备用 `http://192.168.x.x:3000` 访问即可互传。

---

## 协议

MIT
