/**
 * crypto.js — 浏览器端 AES-GCM 加密模块
 * 
 * 设计要点：
 * - 使用 Web Crypto API（原生，无依赖）
 * - 每片独立 IV，防止相同密钥块被识别
 * - 密钥仅存在于内存和 URL Hash 中，永不触达服务器
 */

const CryptoModule = (() => {
  // 每片加密的附加开销：IV(12) + AuthTag(16) = 28 bytes
  const IV_LENGTH = 12;
  const AUTH_TAG_LENGTH = 16;

  /**
   * 生成 256-bit AES-GCM 密钥
   * @returns {Promise<{rawKey: Uint8Array, cryptoKey: CryptoKey}>}
   */
  async function generateKey() {
    const cryptoKey = await window.crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt', 'decrypt']
    );
    const rawKey = new Uint8Array(await window.crypto.subtle.exportKey('raw', cryptoKey));
    return { rawKey, cryptoKey };
  }

  /**
   * 从 base64 字符串导入密钥
   */
  async function importKey(base64Key) {
    const rawKey = base64ToBuffer(base64Key);
    return await window.crypto.subtle.importKey(
      'raw', rawKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']
    );
  }

  /**
   * 加密单个数据块
   * @param {ArrayBuffer} data - 明文数据
   * @param {CryptoKey} key - AES-GCM 密钥
   * @returns {Promise<ArrayBuffer>} IV(12) + 密文 + AuthTag(16)
   */
  async function encryptChunk(data, key) {
    const iv = window.crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const encrypted = await window.crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      key,
      data
    );
    // 拼接 IV + 密文
    const result = new Uint8Array(IV_LENGTH + encrypted.byteLength);
    result.set(iv, 0);
    result.set(new Uint8Array(encrypted), IV_LENGTH);
    return result.buffer;
  }

  /**
   * 解密单个数据块
   * @param {ArrayBuffer} data - IV(12) + 密文 + AuthTag(16)
   * @param {CryptoKey} key - AES-GCM 密钥
   * @returns {Promise<ArrayBuffer>} 明文
   */
  async function decryptChunk(data, key) {
    const encrypted = new Uint8Array(data);
    const iv = encrypted.slice(0, IV_LENGTH);
    const ciphertext = encrypted.slice(IV_LENGTH);
    return await window.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv },
      key,
      ciphertext
    );
  }

  // --- 工具函数 ---
  function bufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function base64ToBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  return {
    generateKey,
    importKey,
    encryptChunk,
    decryptChunk,
    bufferToBase64,
    base64ToBuffer,
    IV_LENGTH,
    AUTH_TAG_LENGTH
  };
})();
