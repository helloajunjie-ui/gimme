# gimme · 给我

零信任端到端加密 P2P 文件传输。无需注册，阅后即焚。

**中文名：** 给我  
**英文名：** gimme（口语化的"给我"）

---

## 一句话

把整个项目丢到一台服务器上，`npm start`，完事。

---

## 快速开始

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

---

## 怎么用

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

## 部署到服务器

### 需要上传的文件

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
└── package-lock.json
```

### 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3000` |
| `TURN_SECRET` | TURN 中继密钥（可选） | `change_this_to_your_turn_secret` |

### 用 Nginx 反代（可选，绑定域名用）

```nginx
server {
    listen 80;
    server_name gimme.your.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```

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

---

## 技术栈

| 模块 | 技术 |
|------|------|
| 信令服务 | Node.js + ws |
| 加密 | AES-GCM 256-bit（Web Crypto API） |
| P2P 传输 | WebRTC（ICE Racing: Host → STUN → TURN） |
| 断点续传 | OPFS（Origin Private File System） |
| 文件指纹 | SHA-256 采样哈希 |
| 防凭证盗用 | HMAC-SHA1 动态凭证（5分钟过期） |
| 防锁屏 | Screen Wake Lock API |

---

## 本地开发

```bash
npm install
npm start
# 打开 http://localhost:3000
```

同一 WiFi 下的设备用 `http://192.168.x.x:3000` 访问即可互传。
