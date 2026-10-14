// pages/multi/multi.js
const crypto = require('../../utils/crypto.js');
const { preprocessImage } = require('../../utils/imageProcess.js');

const HISTORY_KEY  = 'pick_history';      // ⭐ 扫描批次记录
const ALL_ITEMS_KEY = 'pick_all_items';   // ⭐ 总历史记录
const STATE_KEY    = 'multi_state';

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
    currentBatchId: ''      // ⭐ 本次任务的批次 id
  },

  onLoad() {
    this.restoreState(true);
  },

  onShow() {
    this.restoreState(false);
  },

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

  // ============ 历史记录写入 ============
  // ⭐ 把识别到的所有明细写入 pick_all_items（去重）
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

  // ⭐ 把本次任务写入 pick_history（一个任务 = 一个批次）
  saveBatchToHistory() {
    const { batches, grouped, currentBatchId } = this.data;
    if (!batches.length || !currentBatchId) return;

    // 把每个批次里的明细展平，并打上 SO 号 + 该库位状态
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

  // ⭐ 更新历史里的库位状态
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

  // ⭐ 同步更新总记录里的状态
  updateAllItemsStatus() {
    const { grouped } = this.data;
    const allItems = wx.getStorageSync(ALL_ITEMS_KEY) || [];
    const map = {};
    allItems.forEach(i => { map[i.uid] = i; });

    grouped.forEach(g => {
      g.products.forEach(prod => {
        prod.soList.forEach(so => {
          const uid = `${g.location}__${prod.spec}__${prod.sku}`;
          if (map[uid]) {
            map[uid].confirmed = !!g.confirmed;
            map[uid].outOfStock = !!g.outOfStock;
            map[uid].lastTime = Date.now();
          }
        });
      });
    });

    wx.setStorageSync(ALL_ITEMS_KEY, Object.values(map));
  },

  // ============ 缩略图分组 ============
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

  // ============ 上传 ============
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
      if (accumulated.length === 0) {
        wx.showToast({ title: '未识别到任何内容', icon: 'none' });
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

      // ⭐ 写入两个历史记录
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

    const [tableRes, generalRes] = await Promise.all([
      this.callOCR(secretId, secretKey, 'RecognizeTableAccurateOCR', base64Img),
      this.callOCR(secretId, secretKey, 'GeneralAccurateOCR', base64Img)
    ]);

    return {
      items: this.parseTable(tableRes),
      soNumber: this.extractSO(generalRes)
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
      const location = locationIdx >= 0 ? row[locationIdx] : '';
      if (!location) continue;

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