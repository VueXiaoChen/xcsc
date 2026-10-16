// utils/imageProcess.js
// 图像预处理：去阴影 + 对比度增强（纯 JS，无第三方依赖）
// ⭐ 所有异步步骤都加超时保护，App 环境也能稳定返回

/**
 * 预处理图片：去阴影 + 增强
 * @param {string} filePath 输入图片路径
 * @param {number} maxSize  最长边限制（默认 1600）
 * @returns {Promise<string>} 处理后的临时图片路径（失败/超时时返回原图）
 */
function preprocessImage(filePath, maxSize = 1600) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(totalTimer);
      console.log('[imageProcess] 结束，返回:', result === filePath ? '原图' : '处理后的图');
      resolve(result);
    };

    // ⭐ 总超时：8 秒内必须 resolve
    const totalTimer = setTimeout(() => {
      console.warn('[imageProcess] 总超时 8s，用原图');
      done(filePath);
    }, 8000);

    console.log('[imageProcess] 开始处理:', filePath);

    // 第 1 步：读取图片信息
    try {
      wx.getImageInfo({
        src: filePath,
        success: (info) => {
          console.log('[imageProcess] getImageInfo 成功:', info.width, 'x', info.height);
          processImage(info, filePath, maxSize, done);
        },
        fail: (e) => {
          console.warn('[imageProcess] getImageInfo 失败', e);
          done(filePath);
        }
      });
    } catch (e) {
      console.warn('[imageProcess] getImageInfo 抛异常', e);
      done(filePath);
    }
  });
}

function processImage(info, filePath, maxSize, done) {
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
    console.warn('[imageProcess] createOffscreenCanvas 抛异常', e);
    return done(filePath);
  }

  if (!canvas || !canvas.getContext) {
    console.warn('[imageProcess] createOffscreenCanvas 返回无效');
    return done(filePath);
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    console.warn('[imageProcess] getContext 失败');
    return done(filePath);
  }

  const img = canvas.createImage();
  if (!img) {
    console.warn('[imageProcess] createImage 失败');
    return done(filePath);
  }

  // ⭐ 图片加载超时：3 秒
  const imgTimer = setTimeout(() => {
    console.warn('[imageProcess] 图片加载超时 3s');
    done(filePath);
  }, 3000);

  img.onload = () => {
    clearTimeout(imgTimer);
    console.log('[imageProcess] 图片加载完成，开始处理像素');

    try {
      ctx.drawImage(img, 0, 0, width, height);
      const imageData = ctx.getImageData(0, 0, width, height);
      processPixels(imageData, width, height);
      ctx.putImageData(imageData, 0, 0);
      console.log('[imageProcess] 像素处理完成，开始导出');
    } catch (e) {
      console.warn('[imageProcess] 像素处理抛异常', e);
      return done(filePath);
    }

    // ⭐ 导出超时：3 秒
    const exportTimer = setTimeout(() => {
      console.warn('[imageProcess] canvasToTempFilePath 超时 3s');
      done(filePath);
    }, 3000);

    try {
      wx.canvasToTempFilePath({
        canvas,
        fileType: 'jpg',
        quality: 0.92,
        success: (res) => {
          clearTimeout(exportTimer);
          console.log('[imageProcess] 导出成功:', res.tempFilePath);
          done(res.tempFilePath);
        },
        fail: (err) => {
          clearTimeout(exportTimer);
          console.warn('[imageProcess] canvasToTempFilePath 失败', err);
          done(filePath);
        }
      });
    } catch (e) {
      clearTimeout(exportTimer);
      console.warn('[imageProcess] canvasToTempFilePath 抛异常', e);
      done(filePath);
    }
  };

  img.onerror = (e) => {
    clearTimeout(imgTimer);
    console.warn('[imageProcess] 图片加载失败', e);
    done(filePath);
  };

  try {
    img.src = filePath;
  } catch (e) {
    clearTimeout(imgTimer);
    console.warn('[imageProcess] 设置 img.src 抛异常', e);
    done(filePath);
  }
}

/**
 * 核心像素处理：灰度化 → 积分图求局部均值 → 减背景 → 对比度拉伸
 */
function processPixels(imageData, width, height) {
  const data = imageData.data;
  const total = width * height;

  const gray = new Uint8ClampedArray(total);
  for (let i = 0; i < total; i++) {
    const p = i * 4;
    gray[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
  }

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
      let v = gray[y * width + x] - bg + 200;
      v = (v - 128) * 1.6 + 128;

      if (v < 0) v = 0;
      else if (v > 255) v = 255;
      enhanced[y * width + x] = v;
    }
  }

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