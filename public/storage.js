/**
 * storage.js — OPFS 本地持久化模块
 * 
 * 职责：
 * - 将接收到的加密分片写入浏览器 Origin Private File System
 * - 断网重连后读取已保存的进度
 * - 文件传输完成后清理临时数据
 * 
 * 设计要点：
 * - 使用 OPFS（现代浏览器支持）或降级到 IndexedDB
 * - 每个传输会话独立目录，防止冲突
 * - 存储格式：分片文件按 chunkId 命名
 */

const StorageModule = (() => {
  // --- 检测 OPFS 支持 ---
  const supportsOPFS = () => {
    return navigator.storage?.getDirectory !== undefined;
  };

  /**
   * 创建传输会话的存储目录
   * @param {string} sessionId - 文件哈希（用作目录名）
   * @returns {Promise<{save: Function, load: Function, getSavedSize: Function, clear: Function}>}
   */
  async function createSession(sessionId) {
    if (!supportsOPFS()) {
      console.warn('[Storage] OPFS 不可用，降级为内存模式');
      return createMemoryFallback(sessionId);
    }

    const root = await navigator.storage.getDirectory();
    const sessionDir = await root.getDirectoryHandle(sessionId, { create: true });

    /**
     * 保存一个加密分片
     * @param {number} chunkId
     * @param {ArrayBuffer} data
     */
    async function saveChunk(chunkId, data) {
      const fileName = `${chunkId}`;
      const fileHandle = await sessionDir.getFileHandle(fileName, { create: true });
      const writable = await fileHandle.createWritable();
      await writable.write(data);
      await writable.close();
    }

    /**
     * 读取一个加密分片
     */
    async function loadChunk(chunkId) {
      try {
        const fileName = `${chunkId}`;
        const fileHandle = await sessionDir.getFileHandle(fileName);
        const file = await fileHandle.getFile();
        return await file.arrayBuffer();
      } catch {
        return null;
      }
    }

    /**
     * 获取已保存的总字节数
     */
    async function getSavedSize() {
      let totalSize = 0;
      for await (const [name, handle] of sessionDir.entries()) {
        if (handle.kind === 'file') {
          const file = await handle.getFile();
          totalSize += file.size;
        }
      }
      return totalSize;
    }

    /**
     * 获取已保存的 chunkId 列表（用于断点续传对齐）
     */
    async function getSavedChunkIds() {
      const ids = [];
      for await (const [name] of sessionDir.entries()) {
        const id = parseInt(name, 10);
        if (!isNaN(id)) ids.push(id);
      }
      return ids.sort((a, b) => a - b);
    }

    /**
     * 清理会话数据
     */
    async function clear() {
      try {
        await root.removeEntry(sessionId, { recursive: true });
      } catch (e) {
        console.warn('[Storage] 清理失败:', e.message);
      }
    }

    return { saveChunk, loadChunk, getSavedSize, getSavedChunkIds, clear };
  }

  /**
   * 内存降级方案（不支持 OPFS 时使用）
   */
  function createMemoryFallback(sessionId) {
    const store = new Map();

    return {
      async saveChunk(chunkId, data) {
        store.set(chunkId, data.slice(0));
      },
      async loadChunk(chunkId) {
        const data = store.get(chunkId);
        return data ? data.slice(0) : null;
      },
      async getSavedSize() {
        let total = 0;
        for (const data of store.values()) {
          total += data.byteLength;
        }
        return total;
      },
      async getSavedChunkIds() {
        return Array.from(store.keys()).sort((a, b) => a - b);
      },
      async clear() {
        store.clear();
      }
    };
  }

  return { createSession, supportsOPFS };
})();
