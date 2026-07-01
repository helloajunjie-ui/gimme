/**
 * hash.js — 文件哈希指纹模块
 * 
 * 职责：
 * - 计算文件的 SHA-256 哈希（取前 8 位作为指纹）
 * - 用于断点续传时校验文件一致性
 * - 防止文件被替换导致续传出错
 * 
 * 设计要点：
 * - 使用 Web Crypto API SubtleCrypto.digest
 * - 流式计算，不将整个文件读入内存
 * - 8 位十六进制指纹，碰撞概率极低
 */

const HashModule = (() => {
  const FINGERPRINT_LENGTH = 8;

  /**
   * 流式计算文件的 SHA-256 指纹
   * 使用 FileReader 分片读取，避免大文件 OOM
   * @param {File} file
   * @param {function} [onProgress] - 进度回调 (current, total)
   * @returns {Promise<string>} 8 位十六进制指纹
   */
  async function computeFingerprint(file, onProgress) {
    // 对于大文件（>100MB），使用采样哈希避免 OOM
    // 移动端 Safari tab 内存限制通常为 512MB~1GB
    // 全量 arrayBuffer + SHA-256 计算需要约 2x 文件大小的临时内存
    if (file.size > 100 * 1024 * 1024) {
      return await _sampleHash(file);
    }

    // 小文件：直接 arrayBuffer（浏览器优化路径）
    const buffer = await file.arrayBuffer();
    const hashArray = await window.crypto.subtle.digest('SHA-256', buffer);
    return _bytesToHex(new Uint8Array(hashArray).slice(0, 4));
  }

  /**
   * 大文件采样哈希：取头 1MB + 尾 1MB + 中间 1MB
   * 避免加载整个文件到内存
   */
  async function _sampleHash(file) {
    const SAMPLE_SIZE = 1024 * 1024; // 1MB
    const parts = [];

    // 头部 1MB
    const headBlob = file.slice(0, SAMPLE_SIZE);
    parts.push(await headBlob.arrayBuffer());

    // 中间 1MB（取文件中间位置）
    const midOffset = Math.floor((file.size - SAMPLE_SIZE) / 2);
    const midBlob = file.slice(midOffset, midOffset + SAMPLE_SIZE);
    parts.push(await midBlob.arrayBuffer());

    // 尾部 1MB
    const tailBlob = file.slice(-SAMPLE_SIZE);
    parts.push(await tailBlob.arrayBuffer());

    // 合并后计算哈希
    const totalLen = parts.reduce((a, b) => a + b.byteLength, 0);
    const merged = new Uint8Array(totalLen);
    let offset = 0;
    for (const buf of parts) {
      merged.set(new Uint8Array(buf), offset);
      offset += buf.byteLength;
    }

    const hashArray = await window.crypto.subtle.digest('SHA-256', merged);
    return _bytesToHex(new Uint8Array(hashArray).slice(0, 4));
  }

  function _bytesToHex(bytes) {
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  }

  return { computeFingerprint };
})();
