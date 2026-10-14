// utils/crypto.js  —— 纯 JS 实现，无任何依赖

// ================= 工具函数 =================
function strToUtf8Bytes(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0xd800 || code >= 0xe000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      i++;
      code = 0x10000 + (((code & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return bytes;
}

function bytesToHex(bytes) {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += ('00' + (bytes[i] & 0xff).toString(16)).slice(-2);
  }
  return hex;
}

function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

// ================= SHA256 =================
const K = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
];

function sha256Bytes(bytes) {
  const H = [
    0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
    0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19
  ];
  const l = bytes.length;
  const bitLen = l * 8;
  bytes = bytes.slice();
  bytes.push(0x80);
  while ((bytes.length % 64) !== 56) bytes.push(0);
  bytes.push(0, 0, 0, 0);
  bytes.push((bitLen >>> 24) & 0xff, (bitLen >>> 16) & 0xff, (bitLen >>> 8) & 0xff, bitLen & 0xff);

  const w = new Array(64);
  for (let i = 0; i < bytes.length; i += 64) {
    for (let j = 0; j < 16; j++) {
      w[j] = (bytes[i + j*4] << 24) | (bytes[i + j*4 + 1] << 16) |
             (bytes[i + j*4 + 2] << 8) | (bytes[i + j*4 + 3]);
    }
    for (let j = 16; j < 64; j++) {
      const s0 = rotr(w[j-15], 7) ^ rotr(w[j-15], 18) ^ (w[j-15] >>> 3);
      const s1 = rotr(w[j-2], 17) ^ rotr(w[j-2], 19) ^ (w[j-2] >>> 10);
      w[j] = (w[j-16] + s0 + w[j-7] + s1) | 0;
    }
    let [a,b,c,d,e,f,g,h] = H;
    for (let j = 0; j < 64; j++) {
      const S1 = rotr(e,6) ^ rotr(e,11) ^ rotr(e,25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[j] + w[j]) | 0;
      const S0 = rotr(a,2) ^ rotr(a,13) ^ rotr(a,22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0]=(H[0]+a)|0; H[1]=(H[1]+b)|0; H[2]=(H[2]+c)|0; H[3]=(H[3]+d)|0;
    H[4]=(H[4]+e)|0; H[5]=(H[5]+f)|0; H[6]=(H[6]+g)|0; H[7]=(H[7]+h)|0;
  }
  const out = [];
  for (let i = 0; i < 8; i++) {
    out.push((H[i]>>>24)&0xff,(H[i]>>>16)&0xff,(H[i]>>>8)&0xff,H[i]&0xff);
  }
  return out;
}

// ================= HMAC-SHA256 =================
function hmacSha256Bytes(keyBytes, msgBytes) {
  const blockSize = 64;
  if (keyBytes.length > blockSize) keyBytes = sha256Bytes(keyBytes);
  const paddedKey = keyBytes.slice();
  while (paddedKey.length < blockSize) paddedKey.push(0);
  const oKey = paddedKey.map(b => b ^ 0x5c);
  const iKey = paddedKey.map(b => b ^ 0x36);
  const inner = sha256Bytes(iKey.concat(msgBytes));
  return sha256Bytes(oKey.concat(inner));
}

function sha256Hex(str) {
  return bytesToHex(sha256Bytes(strToUtf8Bytes(str)));
}

// ⚠️ 注意：腾讯云要求 key 和 msg 都按“hex 字符串的字节”参与 HMAC
function hmacSha256HexWithHexKey(hexKey, msgStr) {
  // hexKey 是 32 位 hex 字符串，转成 16 字节原始 key
  const keyBytes = [];
  for (let i = 0; i < hexKey.length; i += 2) {
    keyBytes.push(parseInt(hexKey.substr(i, 2), 16));
  }
  return bytesToHex(hmacSha256Bytes(keyBytes, strToUtf8Bytes(msgStr)));
}

// ================= 生成签名 =================
function generateAuthorization(secretId, secretKey, endpoint, service, action, version, region, payload, timestamp) {
  const algorithm = 'TC3-HMAC-SHA256';
  const date = new Date(timestamp * 1000).toISOString().split('T')[0];

  const httpRequestMethod = 'POST';
  const canonicalUri = '/';
  const canonicalQueryString = '';
  const canonicalHeaders = `content-type:application/json\nhost:${endpoint}\n`;
  const signedHeaders = 'content-type;host';
  const hashedRequestPayload = sha256Hex(payload);

  const canonicalRequest =
    `${httpRequestMethod}\n${canonicalUri}\n${canonicalQueryString}\n` +
    `${canonicalHeaders}\n${signedHeaders}\n${hashedRequestPayload}`;

  const credentialScope = `${date}/${service}/tc3_request`;
  const hashedCanonicalRequest = sha256Hex(canonicalRequest);
  const stringToSign =
    `${algorithm}\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`;

  // 三步步进式派生密钥
  const secretDate    = hmacSha256HexWithHexKey(
    bytesToHex(strToUtf8Bytes('TC3' + secretKey)), date
  );
  const secretService = hmacSha256HexWithHexKey(secretDate, service);
  const secretSigning = hmacSha256HexWithHexKey(secretService, 'tc3_request');

  const signature = hmacSha256HexWithHexKey(secretSigning, stringToSign);

  return `${algorithm} Credential=${secretId}/${credentialScope}, ` +
         `SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

module.exports = { generateAuthorization };