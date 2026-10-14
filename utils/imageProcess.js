// utils/imageProcess.js
// 图像预处理：去阴影 + 对比度增强（纯 JS，无第三方依赖）

/**
 * 预处理图片：去阴影 + 增强
 * @param {string} filePath 输入图片路径
 * @param {number} maxSize  最长边限制（默认 1600）
 * @returns {Promise<string>} 处理后的临时图片路径（失败时返回原图）
 */
function preprocessImage(filePath, maxSize = 1600) {
  return new Promise((resolve) => {
    wx.getImageInfo({
      src: filePath,
      success: (info) => {
        let { width, height } = info;

        if (Math.max(width, height) > maxSize) {
          const ratio = maxSize / Math.max(width, height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }

        let canvas;
        try {
          canvas = wx.createOffscreenCanvas({ type: '2d', width, height });
        } catch (e) {
          console.warn('离屏画布不可用，跳过预处理', e);
          return resolve(filePath);
        }

        const ctx = canvas.getContext('2d');
        const img = canvas.createImage();

        img.onload = () => {
          try {
            ctx.drawImage(img, 0, 0, width, height);
            const imageData = ctx.getImageData(0, 0, width, height);
            processPixels(imageData, width, height);
            ctx.putImageData(imageData, 0, 0);

            wx.canvasToTempFilePath({
              canvas,
              fileType: 'jpg',
              quality: 0.92,
              success: (res) => resolve(res.tempFilePath),
              fail: (err) => {
                console.warn('canvasToTempFilePath 失败，用原图', err);
                resolve(filePath);
              }
            });
          } catch (e) {
            console.warn('图像处理失败，用原图', e);
            resolve(filePath);
          }
        };
        img.onerror = () => resolve(filePath);
        img.src = filePath;
      },
      fail: () => resolve(filePath)
    });
  });
}

/**
 * 核心像素处理：灰度化 → 积分图求局部均值 → 减背景 → 对比度拉伸
 */
function processPixels(imageData, width, height) {
  const data = imageData.data;
  const total = width * height;

  // 1. 灰度化
  const gray = new Uint8ClampedArray(total);
  for (let i = 0; i < total; i++) {
    const p = i * 4;
    gray[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
  }

  // 2. 积分图（加速局部均值计算）
  const W1 = width + 1;
  const integral = new Float64Array(W1 * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      rowSum += gray[y * width + x];
      integral[(y + 1) * W1 + (x + 1)] =
        integral[y * W1 + (x + 1)] + rowSum;
    }
  }

  // 3. 局部均值作为背景，减去背景 → 消除阴影
  const radius = Math.max(12, Math.round(Math.min(width, height) / 30));
  const enhanced = new Uint8ClampedArray(total);

  for (let y = 0; y < height; y++) {
    const y1 = Math.max(0, y - radius);
    const y2 = Math.min(height - 1, y + radius);
    for (let x = 0; x < width; x++) {
      const x1 = Math.max(0, x - radius);
      const x2 = Math.min(width - 1, x + radius);

      const area = (x2 - x1 + 1) * (y2 - y1 + 1);
      const sum =
        integral[(y2 + 1) * W1 + (x2 + 1)] -
        integral[y1 * W1 + (x2 + 1)] -
        integral[(y2 + 1) * W1 + x1] +
        integral[y1 * W1 + x1];

      const bg = sum / area;

      // 原灰度 - 背景 + 偏移（让背景趋向白色）
      let v = gray[y * width + x] - bg + 200;

      // 对比度拉伸
      v = (v - 128) * 1.6 + 128;

      if (v < 0) v = 0;
      else if (v > 255) v = 255;
      enhanced[y * width + x] = v;
    }
  }

  // 4. 写回 RGBA
  for (let i = 0; i < total; i++) {
    const p = i * 4;
    const v = enhanced[i];
    data[p] = v;
    data[p + 1] = v;
    data[p + 2] = v;
    data[p + 3] = 255;
  }
}

module.exports = { preprocessImage };