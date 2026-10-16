// pages/multi/multi.js
const crypto = require('../../utils/crypto.js');
const { preprocessImage } = require('../../utils/imageProcess.js');

const HISTORY_KEY  = 'pick_history';
const ALL_ITEMS_KEY = 'pick_all_items';
const STATE_KEY    = 'multi_state';

// ⭐ 判断库位是否包含大写字母
function hasUpperCase(str) {
  return /[A-Z]/.test(str || '');
}

// ⭐ 从通用识别结果重建表格（每一列独立收集，按 Y 依次分配给每一行）
function parseGeneralResult(textDetections) {
  if (!textDetections || textDetections.length === 0) return [];

  const blocks = textDetections.map(t => {
    const poly = t.Polygon || [];
    const xs = poly.map(p => p.X);
    const ys = poly.map(p => p.Y);
    const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const cy = ys.reduce((a, b) => a + b, 0) / ys.length;
    return { text: (t.DetectedText || '').trim(), cx, cy };
  }).filter(b => b.text);

  if (blocks.length === 0) return [];

  const headerKeywords = ['拣货库位', '库位', '货号', 'SKU', '拣货数量', '数量', '颜色'];
  const headerWords = ['SKU', '拣货库位', '库位', '货号', '颜色_尺码', '拣货数量', '产品类别', '颜色尺码', '规格'];

  const headerBlocks = blocks.filter(b =>
    headerKeywords.some(k => b.text.includes(k))
  );

  if (headerBlocks.length < 3) {
    console.log('[parseGeneral] 表头太少，走旧逻辑');
    return legacyParse(blocks);
  }

  const headerYs = headerBlocks.map(b => b.cy).sort((a, b) => a - b);
  const headerY = headerYs[Math.floor(headerYs.length / 2)];
  console.log('[parseGeneral] 表头基准 Y:', Math.round(headerY));

  const headerRowBlocks = blocks.filter(b => Math.abs(b.cy - headerY) < 30);

  const colMap = {};
  headerRowBlocks.forEach(b => {
    const text = b.text;
    if (/拣货库位|^库位$|货位|位置/.test(text)) colMap.location = b.cx;
    else if (/货号|^编码$|商品编码/.test(text)) colMap.productCode = b.cx;
    else if (/颜色|尺码|规格/.test(text)) colMap.spec = b.cx;
    else if (/拣货数量|^数量$|件数/.test(text)) colMap.quantity = b.cx;
    else if (/SKU/i.test(text)) colMap.sku = b.cx;
  });

  console.log('[parseGeneral] 列锚点:', JSON.stringify(colMap));

  // 只取表头下方的数据块
  const dataBlocks = blocks.filter(b => b.cy > headerY + 10);

  // ⭐ 每一列独立收集，按 Y 排序
  const columns = {};

  Object.keys(colMap).forEach(col => {
    const colX = colMap[col];
    const list = dataBlocks.filter(b => {
      if (headerWords.includes(b.text)) return false;
      if (Math.abs(b.cx - colX) > 130) return false;
      return true;
    }).sort((a, b) => a.cy - b.cy);

    columns[col] = list;
    console.log(`[parseGeneral] 列 "${col}" (x=${Math.round(colX)}) 候选:`, list.map(b => `${b.text}@${Math.round(b.cy)}`).join(' / '));
  });

  // ⭐ 用"库位"列的数量作为总行数
  const locList = columns.location || [];
  if (locList.length === 0) return [];

  const rowCount = locList.length;
  console.log('[parseGeneral] 总行数:', rowCount);

  // ⭐ 每一列的第 i 个值，配到第 i 行
  const rowDataList = [];
  for (let i = 0; i < rowCount; i++) {
    const rowData = {
      location: locList[i] ? locList[i].text : '',
      productCode: '',
      spec: '',
      quantity: '',
      sku: ''
    };

    ['productCode', 'spec', 'quantity', 'sku'].forEach(col => {
      const list = columns[col] || [];
      // 优先取 Y 与当前库位最接近的那一个
      const rowY = locList[i].cy;
      let best = null;
      let bestDist = Infinity;
      list.forEach(item => {
        const d = Math.abs(item.cy - rowY);
        if (d < bestDist) {
          bestDist = d;
          best = item;
        }
      });

      // 兜底：如果找不到最近的，就用第 i 个
      if (!best || bestDist > 120) {
        best = list[i] || null;
      }

      if (best) {
        rowData[col] = best.text;
        const idx = list.indexOf(best);
        if (idx >= 0) list.splice(idx, 1);
      }
    });

    rowDataList.push(rowData);
  }

  console.log('[parseGeneral] 结构化行:');
  rowDataList.forEach((r, i) => {
    console.log(`  行 ${i + 1}: 库位=${r.location} 货号=${r.productCode} 规格=${r.spec} 数量=${r.quantity} SKU=${r.sku}`);
  });

  return rowDataList;
}

// 旧版简单聚类（兜底）
function legacyParse(blocks) {
  blocks.sort((a, b) => a.cy - b.cy);
  const rows = [];
  let currentRow = [blocks[0]];

  for (let i = 1; i < blocks.length; i++) {
    const b = blocks[i];
    const prevRow = currentRow[0];
    if (Math.abs(b.cy - prevRow.cy) < 15) {
      currentRow.push(b);
    } else {
      rows.push(currentRow);
      currentRow = [b];
    }
  }
  if (currentRow.length > 0) rows.push(currentRow);

  rows.forEach(r => r.sort((a, b) => a.cx - b.cx));
  return rows;
}

// ⭐ 从"结构化行"里提取条目
function extractItemsFromRows(rows) {
  // 兼容 legacyParse 返回格式
  if (rows.length > 0 && Array.isArray(rows[0])) {
    const items = [];
    rows.forEach(row => {
      if (row.length < 2) return;
      const locCell = row.find(cell =>
        /[A-Z]/.test(cell.text) && /-/.test(cell.text) &&
        cell.text.length >= 5 && cell.text.length <= 25
      );
      if (!locCell) return;
      const location = locCell.text.toUpperCase();
      const qtyCell = row.find(cell => /^\d{1,4}$/.test(cell.text) && cell.cx > locCell.cx);
      const skuCell = row.find(cell =>
        cell.text.length >= 8 && /[A-Z]/.test(cell.text) && /\d/.test(cell.text) &&
        cell.text !== locCell.text && (!qtyCell || cell.text !== qtyCell.text)
      );
      const specCell = row.find(cell =>
        /[\u4e00-\u9fa5]/.test(cell.text) &&
        cell !== locCell && cell !== skuCell && cell !== qtyCell
      );
      items.push({
        location,
        spec: specCell ? specCell.text : '',
        quantity: qtyCell ? parseInt(qtyCell.text) : 0,
        sku: skuCell ? skuCell.text : ''
      });
    });
    return items;
  }

  return rows
    .filter(r => r.location && hasUpperCase(r.location))
    .map(r => ({
      location: r.location.toUpperCase().trim(),
      spec: r.spec || '',
      quantity: parseInt(r.quantity) || 0,
      sku: r.sku || ''
    }));
}

Page({
  data: {
    loading: false,
    batches: [],
    grouped: [],
    currentIndex: 0,
    currentLoc: null,
    allDone: false,
    showThumbModal: false,
    handledBatches: [],
    unhandledBatches: [],
    currentBatchId: ''
  },

  onLoad() { this.restoreState(true); },
  onShow() { this.restoreState(false); },

  restoreState(cleanIfDone) {
    const state = wx.getStorageSync(STATE_KEY);
    if (!state || !state.grouped || state.grouped.length === 0) return;

    const wasAllDone = state.grouped.every(g => g.confirmed || g.outOfStock);

    if (wasAllDone && cleanIfDone) {
      wx.removeStorageSync(STATE_KEY);
      this.setData({
        batches: [], grouped: [], currentIndex: 0, currentLoc: null, allDone: false,
        showThumbModal: false, handledBatches: [], unhandledBatches: [],
        currentBatchId: ''
      });
      return;
    }

    this.setData({
      batches: state.batches || [],
      grouped: state.grouped,
      currentIndex: state.currentIndex || 0,
      currentLoc: state.grouped[state.currentIndex || 0] || null,
      allDone: wasAllDone,
      currentBatchId: state.currentBatchId || ''
    });
    this.refreshThumbGroups();
  },

  saveState() {
    wx.setStorageSync(STATE_KEY, {
      batches: this.data.batches,
      grouped: this.data.grouped,
      currentIndex: this.data.currentIndex,
      currentBatchId: this.data.currentBatchId
    });
  },

  saveBatchToAllItems() {
    const { batches } = this.data;
    if (!batches.length) return;

    const allItems = wx.getStorageSync(ALL_ITEMS_KEY) || [];
    const map = {};
    allItems.forEach(i => { map[i.uid] = i; });

    batches.forEach(batch => {
      batch.items.forEach(item => {
        const uid = `${item.location}__${item.spec}__${item.sku}`;
        const existing = map[uid];
        if (existing) {
          existing.location = item.location || existing.location;
          existing.spec = item.spec || existing.spec;
          existing.sku = item.sku || existing.sku;
          existing.quantity = item.quantity || existing.quantity;
          existing.lastTime = Date.now();
        } else {
          map[uid] = {
            uid,
            location: item.location || '',
            spec: item.spec || '',
            sku: item.sku || '',
            quantity: item.quantity || 0,
            confirmed: false,
            outOfStock: false,
            lastTime: Date.now()
          };
        }
      });
    });

    wx.setStorageSync(ALL_ITEMS_KEY, Object.values(map));
  },

  saveBatchToHistory() {
    const { batches, grouped, currentBatchId } = this.data;
    if (!batches.length || !currentBatchId) return;

    const items = [];
    batches.forEach(batch => {
      batch.items.forEach(item => {
        const locGroup = grouped.find(g => g.location === item.location);
        const uid = `${item.location}__${item.spec}__${item.sku}__${batch.soNumber}`;
        items.push({
          uid,
          soNumber: batch.soNumber,
          location: item.location,
          spec: item.spec,
          sku: item.sku,
          quantity: item.quantity,
          confirmed: locGroup ? !!locGroup.confirmed : false,
          outOfStock: locGroup ? !!locGroup.outOfStock : false
        });
      });
    });

    const history = wx.getStorageSync(HISTORY_KEY) || [];
    const idx = history.findIndex(b => b.id === currentBatchId);
    const batch = {
      id: currentBatchId,
      time: Date.now(),
      fingerprint: '',
      lastIndex: 0,
      items
    };

    if (idx >= 0) history[idx] = batch;
    else history.push(batch);

    wx.setStorageSync(HISTORY_KEY, history);
  },

  updateHistoryLocStatus() {
    const { batches, grouped, currentBatchId } = this.data;
    if (!currentBatchId) return;

    const history = wx.getStorageSync(HISTORY_KEY) || [];
    const batch = history.find(b => b.id === currentBatchId);
    if (!batch) return;

    batch.items.forEach(it => {
      const locGroup = grouped.find(g => g.location === it.location);
      if (locGroup) {
        it.confirmed = !!locGroup.confirmed;
        it.outOfStock = !!locGroup.outOfStock;
      }
    });

    wx.setStorageSync(HISTORY_KEY, history);
  },

  updateAllItemsStatus() {
    const { grouped } = this.data;
    const allItems = wx.getStorageSync(ALL_ITEMS_KEY) || [];
    const map = {};
    allItems.forEach(i => { map[i.uid] = i; });

    grouped.forEach(g => {
      g.products.forEach(prod => {
        const uid = `${g.location}__${prod.spec}__${prod.sku}`;
        if (map[uid]) {
          map[uid].confirmed = !!g.confirmed;
          map[uid].outOfStock = !!g.outOfStock;
          map[uid].lastTime = Date.now();
        }
      });
    });

    wx.setStorageSync(ALL_ITEMS_KEY, Object.values(map));
  },

  refreshThumbGroups() {
    const { batches, grouped } = this.data;

    const soToLocs = {};
    batches.forEach(b => {
      if (!soToLocs[b.soNumber]) soToLocs[b.soNumber] = new Set();
      b.items.forEach(item => soToLocs[b.soNumber].add(item.location));
    });

    const handledLocs = new Set();
    grouped.forEach(g => {
      if (g.confirmed || g.outOfStock) handledLocs.add(g.location);
    });

    const handled = [];
    const unhandled = [];

    batches.forEach(b => {
      const locs = Array.from(soToLocs[b.soNumber] || []);
      const allHandled = locs.length > 0 && locs.every(l => handledLocs.has(l));
      if (allHandled) handled.push(b);
      else unhandled.push(b);
    });

    this.setData({ handledBatches: handled, unhandledBatches: unhandled });
  },

  openThumbnail() {
    this.refreshThumbGroups();
    this.setData({ showThumbModal: true });
  },

  closeThumbnail() {
    this.setData({ showThumbModal: false });
  },

  noop() {},

  previewImage(e) {
    const { index, group } = e.currentTarget.dataset;
    const list = group === 'handled' ? this.data.handledBatches : this.data.unhandledBatches;
    const urls = list.map(b => b.imagePath);
    wx.previewImage({ current: urls[index], urls });
  },

  chooseAndRecognize() {
    wx.chooseMedia({
      count: 9,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const files = res.tempFiles.map(f => f.tempFilePath);
        if (files.length === 0) return;
        this.processSequentially(files, 0, []);
      }
    });
  },

  async processSequentially(files, idx, accumulated) {
    if (idx >= files.length) {
      const hasValid = accumulated.some(batch =>
        batch.items.some(item => hasUpperCase(item.location))
      );

      if (accumulated.length === 0 || !hasValid) {
        wx.showModal({
          title: '未识别到有效库位',
          content: '这次上传的图片里没有识别到包含大写字母的库位，请检查拍摄是否清晰，或换几张重试。',
          showCancel: false,
          confirmText: '返回',
          success: () => {
            wx.navigateBack({
              fail: () => wx.reLaunch({ url: '/pages/home/home' })
            });
          }
        });
        this.setData({ loading: false });
        return;
      }

      const grouped = this.buildGrouped(accumulated);
      const batchId = 'multi_' + Date.now();

      this.setData({
        loading: false,
        batches: accumulated,
        grouped,
        currentIndex: 0,
        currentLoc: grouped[0],
        allDone: grouped.every(g => g.confirmed || g.outOfStock),
        currentBatchId: batchId
      });

      this.saveBatchToAllItems();
      this.saveBatchToHistory();
      this.saveState();
      this.refreshThumbGroups();

      wx.showToast({ title: `共 ${grouped.length} 个库位`, icon: 'success' });
      return;
    }

    this.setData({ loading: true });

    wx.showLoading({ title: `处理第 ${idx + 1} / ${files.length} 张...` });
    let processedPath = files[idx];
    try {
      const compressed = await new Promise((resolve) => {
        wx.compressImage({
          src: files[idx], quality: 85,
          success: (r) => resolve(r.tempFilePath),
          fail: () => resolve(files[idx])
        });
      });
      processedPath = await preprocessImage(compressed);
    } catch (e) {
      console.warn('预处理失败，用原图', e);
    }

    wx.showLoading({ title: `识别第 ${idx + 1} / ${files.length} 张...` });
    let result = { items: [], soNumber: '' };
    try {
      result = await this.recognizeOne(processedPath);
    } catch (e) {
      console.error(`第 ${idx + 1} 张识别失败:`, e);
      wx.hideLoading();
      wx.showModal({
        title: `第 ${idx + 1} 张识别失败`,
        content: '跳过这张继续？',
        showCancel: false,
        success: () => this.processSequentially(files, idx + 1, accumulated)
      });
      return;
    }

    wx.hideLoading();

    if (result.items.length === 0) {
      wx.showModal({
        title: `第 ${idx + 1} 张未识别到明细`,
        content: '跳过这张继续？',
        showCancel: false,
        success: () => this.processSequentially(files, idx + 1, accumulated)
      });
      return;
    }

    accumulated.push({
      imagePath: files[idx],
      soNumber: result.soNumber || `未命名-${idx + 1}`,
      items: result.items
    });

    this.processSequentially(files, idx + 1, accumulated);
  },

  async recognizeOne(filePath) {
    const cfg = wx.getStorageSync('tc_secret_config');
    const secretId = (cfg && cfg.secretId) || 'AKIDGXceU6VkmdHixzoQtoW5VikbFkw9HPch';
    const secretKey = (cfg && cfg.secretKey) || 'BKWXN1Tr58ydR7ey99xYMybCexAC1gFj';

    const fs = wx.getFileSystemManager();
    const base64Img = fs.readFileSync(filePath, 'base64');

    console.log('\n\n========== 开始识别一张图片 ==========');
    console.log('图片大小(base64长度):', base64Img.length);

    let items = [];
    let soNumber = '';

    console.log('\n---------- 第 1 步：表格识别 RecognizeTableAccurateOCR ----------');
    try {
      const tableRes = await this.callOCR(secretId, secretKey, 'RecognizeTableAccurateOCR', base64Img);
      if (tableRes.Error) {
        console.log('表格识别接口返回错误:', tableRes.Error);
      } else {
        console.log('TableDetections 数量:', (tableRes.TableDetections || []).length);
      }
      items = this.parseTable(tableRes);
      console.log('表格识别解析出条目数:', items.length);
    } catch (e) {
      console.warn('表格识别失败:', e);
    }

    if (items.length === 0) {
      console.log('\n---------- 第 2 步：降级通用识别 GeneralAccurateOCR ----------');
      try {
        const generalRes = await this.callOCR(secretId, secretKey, 'GeneralAccurateOCR', base64Img);

        if (generalRes.Error) {
          console.log('通用识别接口返回错误:', generalRes.Error);
        } else {
          const detections = generalRes.TextDetections || [];
          console.log('TextDetections 数量:', detections.length);

          console.log('\n========== 通用识别原始返回 ==========');
          detections.forEach((t, i) => {
            const poly = t.Polygon || [];
            const xs = poly.map(p => p.X);
            const ys = poly.map(p => p.Y);
            const cx = xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0;
            const cy = ys.length ? Math.round(ys.reduce((a, b) => a + b, 0) / ys.length) : 0;
            console.log(`  [${i}] "${t.DetectedText}"  (x=${cx}, y=${cy})`);
          });

          const rows = parseGeneralResult(detections);
          items = extractItemsFromRows(rows);
          soNumber = this.extractSO(generalRes);

          console.log('\n========== 从结构化行里提取的条目 ==========');
          console.log('提取条目数:', items.length);
          items.forEach((it, i) => {
            console.log(`  条目 ${i + 1}: 库位=${it.location} 规格=${it.spec} 数量=${it.quantity} SKU=${it.sku}`);
          });
          console.log('识别出的 SO 号:', soNumber || '(未识别到)');
        }
      } catch (e) {
        console.warn('通用识别失败:', e);
      }
    } else {
      console.log('\n---------- 表格识别成功，额外调通用识别抓 SO 号 ----------');
      try {
        const generalRes = await this.callOCR(secretId, secretKey, 'GeneralAccurateOCR', base64Img);
        soNumber = this.extractSO(generalRes);
        console.log('识别出的 SO 号:', soNumber || '(未识别到)');
      } catch (e) {
        console.warn('抓 SO 号失败:', e);
      }
    }

    const valid = items.filter(i => hasUpperCase(i.location));
    console.log('\n========== 最终有效条目 ==========');
    console.log('有效条目数:', valid.length);
    valid.forEach((it, i) => {
      console.log(`  ${i + 1}. 库位=${it.location} 规格=${it.spec} 数量=${it.quantity} SKU=${it.sku}`);
    });

    return {
      items: valid,
      soNumber
    };
  },

  callOCR(secretId, secretKey, action, base64Img) {
    return new Promise((resolve, reject) => {
      const endpoint = 'ocr.tencentcloudapi.com';
      const service = 'ocr';
      const version = '2018-11-19';
      const region = 'ap-guangzhou';

      const payload = JSON.stringify({ ImageBase64: base64Img });
      const timestamp = Math.floor(Date.now() / 1000);
      const authorization = crypto.generateAuthorization(
        secretId, secretKey, endpoint, service, action, version, region, payload, timestamp
      );

      wx.request({
        url: `https://${endpoint}`,
        method: 'POST',
        header: {
          'Content-Type': 'application/json',
          'Host': endpoint,
          'Authorization': authorization,
          'X-TC-Action': action,
          'X-TC-Timestamp': timestamp.toString(),
          'X-TC-Version': version,
          'X-TC-Region': region
        },
        data: payload,
        success: (res) => {
          if (res.data.Response && res.data.Response.Error) {
            return reject(new Error(res.data.Response.Error.Message));
          }
          resolve(res.data.Response);
        },
        fail: reject
      });
    });
  },

  extractSO(response) {
    if (!response || !response.TextDetections) return '';
    const allText = response.TextDetections.map(t => t.DetectedText).join(' ');
    let match = allText.match(/SO\d{8,20}/i);
    if (match) return match[0].toUpperCase();
    match = allText.match(/订单号[：: ]*([A-Z0-9\-]{6,30})/i);
    if (match) return match[1].toUpperCase();
    for (const t of response.TextDetections) {
      const txt = (t.DetectedText || '').trim();
      if (/^SO\d{6,}$/i.test(txt)) return txt.toUpperCase();
    }
    return '';
  },

  parseTable(response) {
    if (!response || !response.TableDetections || response.TableDetections.length === 0) {
      return [];
    }
    const tableDetections = response.TableDetections;
    let mainTable = tableDetections.reduce((max, cur) => {
      const a = (cur.Cells && cur.Cells.length) || 0;
      const b = (max.Cells && max.Cells.length) || 0;
      return a > b ? cur : max;
    }, tableDetections[0]);

    const cells = mainTable.Cells;
    if (!cells || cells.length === 0) return [];

    let maxRow = 0, maxCol = 0;
    cells.forEach(cell => {
      if (cell.RowTl > maxRow) maxRow = cell.RowTl;
      if (cell.ColTl > maxCol) maxCol = cell.ColTl;
    });

    const matrix = [];
    for (let r = 0; r <= maxRow; r++) {
      matrix[r] = [];
      for (let c = 0; c <= maxCol; c++) matrix[r][c] = '';
    }
    cells.forEach(cell => {
      const r = cell.RowTl, c = cell.ColTl;
      if (r >= 0 && c >= 0 && matrix[r] && matrix[r][c] !== undefined) {
        matrix[r][c] = (cell.Text || '').trim();
      }
    });

    const headers = matrix[0].map(h => h.replace(/\s/g, ''));
    const findCol = (kw) => headers.findIndex(h => kw.some(k => h.includes(k)));

    const locationIdx    = findCol(['库位', '货位', '位置']);
    const specIdx        = findCol(['颜色', '尺码', '规格']);
    const qtyIdx         = findCol(['数量', '件数', '拣货数']);
    const skuIdx         = headers.findIndex(h => h.toUpperCase().includes('SKU'));

    const list = [];
    for (let r = 1; r <= maxRow; r++) {
      const row = matrix[r];
      if (!row || row.filter(v => v).length < 2) continue;
      const location = locationIdx >= 0 ? (row[locationIdx] || '').trim() : '';
      if (!location) continue;
      if (!hasUpperCase(location)) continue;

      list.push({
        location,
        spec: specIdx >= 0 ? row[specIdx] : '',
        quantity: parseInt(qtyIdx >= 0 ? row[qtyIdx] : '0') || 0,
        sku: skuIdx >= 0 ? row[skuIdx] : ''
      });
    }
    return list;
  },

  buildGrouped(batches) {
    const map = {};
    batches.forEach(batch => {
      batch.items.forEach(item => {
        const loc = item.location;
        if (!loc) return;

        if (!map[loc]) {
          map[loc] = {
            location: loc, products: [], totalItems: 0,
            confirmed: false, outOfStock: false
          };
        }

        const pk = `${item.sku}__${item.spec}`;
        let product = map[loc].products.find(p => p.key === pk);
        if (!product) {
          product = { key: pk, sku: item.sku, spec: item.spec, total: 0, soList: [] };
          map[loc].products.push(product);
        }

        let so = product.soList.find(s => s.soNumber === batch.soNumber);
        if (!so) {
          so = { soNumber: batch.soNumber, quantity: 0 };
          product.soList.push(so);
        }
        so.quantity += item.quantity;
        product.total += item.quantity;
        map[loc].totalItems++;
      });
    });

    Object.values(map).forEach(loc => {
      loc.products.forEach(p => {
        p.soList.sort((a, b) =>
          (a.soNumber || '').localeCompare(b.soNumber || '', 'zh-CN', { numeric: true })
        );
      });
    });

    return Object.values(map);
  },

  onConfirm() {
    if (this.data.allDone) return;
    const { grouped, currentIndex } = this.data;
    if (!grouped.length) return;

    const newGrouped = grouped.slice();
    newGrouped[currentIndex] = { ...newGrouped[currentIndex], confirmed: true, outOfStock: false };

    const next = this.findNextUnhandled(newGrouped, currentIndex);

    if (next === -1) {
      this.setData({ grouped: newGrouped, currentLoc: newGrouped[currentIndex], allDone: true });
      this.updateHistoryLocStatus();
      this.updateAllItemsStatus();
      this.saveState();
      this.refreshThumbGroups();
      wx.showToast({ title: '已全部完成 🎉', icon: 'success' });
      return;
    }

    this.setData({
      grouped: newGrouped,
      currentIndex: next,
      currentLoc: newGrouped[next]
    });
    this.updateHistoryLocStatus();
    this.updateAllItemsStatus();
    this.saveState();
    this.refreshThumbGroups();
    wx.showToast({ title: '已确认', icon: 'success' });
  },

  onOutOfStock() {
    if (this.data.allDone) return;
    const { grouped, currentIndex } = this.data;
    if (!grouped.length) return;

    const newGrouped = grouped.slice();
    newGrouped[currentIndex] = { ...newGrouped[currentIndex], confirmed: false, outOfStock: true };

    const next = this.findNextUnhandled(newGrouped, currentIndex);

    if (next === -1) {
      this.setData({ grouped: newGrouped, currentLoc: newGrouped[currentIndex], allDone: true });
      this.updateHistoryLocStatus();
      this.updateAllItemsStatus();
      this.saveState();
      this.refreshThumbGroups();
      wx.showToast({ title: '已全部处理完成 🎉', icon: 'success' });
      return;
    }

    this.setData({
      grouped: newGrouped,
      currentIndex: next,
      currentLoc: newGrouped[next]
    });
    this.updateHistoryLocStatus();
    this.updateAllItemsStatus();
    this.saveState();
    this.refreshThumbGroups();
    wx.showToast({ title: '已标记缺货', icon: 'none' });
  },

  findNextUnhandled(list, currentIndex) {
    for (let i = currentIndex + 1; i < list.length; i++) {
      if (!list[i].confirmed && !list[i].outOfStock) return i;
    }
    for (let i = 0; i < currentIndex; i++) {
      if (!list[i].confirmed && !list[i].outOfStock) return i;
    }
    return -1;
  },

  resetAll() {
    wx.showModal({
      title: '重新开始？',
      content: '会清空当前多张拣货单任务（历史记录会保留）。',
      success: (r) => {
        if (!r.confirm) return;
        wx.removeStorageSync(STATE_KEY);
        this.setData({
          batches: [], grouped: [], currentIndex: 0, currentLoc: null, allDone: false,
          showThumbModal: false, handledBatches: [], unhandledBatches: [],
          currentBatchId: ''
        });
      }
    });
  }
});