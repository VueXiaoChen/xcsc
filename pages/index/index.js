// pages/index/index.js
const crypto = require('../../utils/crypto.js');
const { preprocessImage } = require('../../utils/imageProcess.js');

const HISTORY_KEY  = 'pick_history';
const ALL_ITEMS_KEY = 'pick_all_items';
const STATE_KEY    = 'pick_state';

const AREA_ORDER = ['LJ', 'BLJ', '2H', 'P', 'JH'];

const FIELD_OPTIONS = [
  { label: '库位', value: 'location' },
  { label: '颜色尺码', value: 'spec' },
  { label: 'SKU', value: 'sku' },
  { label: '全部', value: 'all' }
];

function makeUid(item) {
  return `${item.location}__${item.spec}__${item.sku}`;
}

function makeFingerprint(items) {
  const ids = items.map(i => i.uid).sort().join('|');
  let hash = 5381;
  for (let i = 0; i < ids.length; i++) {
    hash = ((hash << 5) + hash + ids.charCodeAt(i)) >>> 0;
  }
  return 'fp_' + hash.toString(36) + '_' + items.length;
}

function sortByArea(list) {
  const getRank = (loc) => {
    const up = (loc || '').toUpperCase();
    for (let i = 0; i < AREA_ORDER.length; i++) {
      if (up.startsWith(AREA_ORDER[i])) return i;
    }
    return AREA_ORDER.length;
  };
  return list.slice().sort((a, b) => {
    const ra = getRank(a.location);
    const rb = getRank(b.location);
    if (ra !== rb) return ra - rb;
    return (a.location || '').localeCompare(b.location || '', 'zh-CN', { numeric: true });
  });
}

function findFirstUnhandled(list) {
  for (let i = 0; i < list.length; i++) {
    if (!list[i].confirmed && !list[i].outOfStock) return i;
  }
  return -1;
}

function isHandled(item) {
  return !!item.confirmed || !!item.outOfStock;
}

Page({
  data: {
    loading: false,
    tableData: [],
    filteredList: [],
    keyword: '',
    fieldOptions: FIELD_OPTIONS,
    fieldIndex: 0,
    currentIndex: 0,
    currentItem: null,
    allDone: false,
    currentBatchId: ''
  },

  onLoad() {
    // ⭐ 未配置密钥时强制去配置页（如果不想要这功能可删掉这段）
    const cfg = wx.getStorageSync('tc_secret_config');
    if (!cfg || !cfg.secretId || !cfg.secretKey) {
      // 如果你还是用硬编码密钥，就把这段删除
    }
    this.restoreState();
  },

  onShow() {
    this.restoreState();
  },

  // ============ 状态保存 / 恢复 ============
  restoreState() {
    const state = wx.getStorageSync(STATE_KEY);
    if (!state || !state.tableData || state.tableData.length === 0) return;

    const history = wx.getStorageSync(HISTORY_KEY) || [];
    const batchExists = state.currentBatchId && history.some(b => b.id === state.currentBatchId);

    if (!batchExists) {
      wx.removeStorageSync(STATE_KEY);
      this.setData({
        tableData: [],
        filteredList: [],
        currentItem: null,
        currentIndex: 0,
        keyword: '',
        allDone: false,
        currentBatchId: ''
      });
      return;
    }

    this.setData({
      tableData: state.tableData,
      currentIndex: state.currentIndex || 0,
      currentItem: state.tableData[state.currentIndex || 0],
      currentBatchId: state.currentBatchId || ''
    });
    this.refreshFilteredList();
    this.mergeHistoryStatus();
  },

  saveState() {
    wx.setStorageSync(STATE_KEY, {
      tableData: this.data.tableData,
      currentIndex: this.data.currentIndex,
      currentBatchId: this.data.currentBatchId
    });
  },

  checkAllDone(tableData) {
    const all = tableData.length > 0 && tableData.every(i => isHandled(i));
    this.setData({ allDone: all });
  },

  refreshFilteredList() {
    const { tableData, keyword, fieldOptions, fieldIndex } = this.data;
    let filteredList = tableData;

    if (keyword) {
      const kw = keyword.toLowerCase();
      const field = fieldOptions[fieldIndex].value;

      filteredList = tableData.filter(i => {
        if (field === 'location') {
          return (i.location || '').toLowerCase().includes(kw);
        }
        if (field === 'spec') {
          return (i.spec || '').toLowerCase().includes(kw);
        }
        if (field === 'sku') {
          return (i.sku || '').toLowerCase().includes(kw);
        }
        return (i.location || '').toLowerCase().includes(kw) ||
               (i.spec || '').toLowerCase().includes(kw) ||
               (i.sku || '').toLowerCase().includes(kw);
      });
    }

    this.setData({ filteredList });
  },

  onSearchInput(e) {
    this.setData({ keyword: (e.detail.value || '').trim() }, () => {
      this.refreshFilteredList();
    });
  },

  onFieldChange(e) {
    const idx = parseInt(e.detail.value);
    if (idx === this.data.fieldIndex) return;
    this.setData({ fieldIndex: idx }, () => {
      this.refreshFilteredList();
    });
  },

  clearSearch() {
    this.setData({ keyword: '' }, () => {
      this.refreshFilteredList();
    });
  },

  onResultTap(e) {
    const uid = e.currentTarget.dataset.uid;
    const realIdx = this.data.tableData.findIndex(i => i.uid === uid);
    if (realIdx < 0) return;

    this.setData({
      currentIndex: realIdx,
      currentItem: this.data.tableData[realIdx]
    });
    this.saveState();
  },

  onCurrentPickerChange(e) {
    const idx = parseInt(e.detail.value);
    if (idx < 0 || idx >= this.data.tableData.length) return;
    this.setData({
      currentIndex: idx,
      currentItem: this.data.tableData[idx]
    });
    this.saveState();
  },

  // ============ 选择图片 ============
  chooseAndRecognize() {
    wx.chooseMedia({
      count: 9,
      mediaType: ['image'],
      sourceType: ['album', 'camera'],
      success: (res) => {
        const files = res.tempFiles.map(f => f.tempFilePath);
        if (files.length === 0) return;

        wx.showLoading({ title: '图像处理中...' });

        this.processAll(files)
          .then(processed => {
            wx.hideLoading();
            this.recognizeAll(processed);
          })
          .catch(err => {
            wx.hideLoading();
            console.error('处理失败:', err);
            wx.showToast({ title: '处理失败', icon: 'none' });
          });
      }
    });
  },

  // ⭐ 逐张处理：压缩 → 去阴影 + 对比度增强
  async processAll(files) {
    const result = [];
    for (let i = 0; i < files.length; i++) {
      wx.showLoading({ title: `处理第 ${i + 1}/${files.length} 张...` });
      try {
        // 1. 压缩
        const compressed = await new Promise((resolve) => {
          wx.compressImage({
            src: files[i],
            quality: 85,
            success: (r) => resolve(r.tempFilePath),
            fail: () => resolve(files[i])
          });
        });

        // 2. 去阴影 + 对比度增强
        const processed = await preprocessImage(compressed);
        result.push(processed);
      } catch (e) {
        console.warn(`第 ${i + 1} 张处理失败，用原图`, e);
        result.push(files[i]);
      }
    }
    return result;
  },

  async recognizeAll(filePaths) {
    this.setData({
      loading: true,
      tableData: [],
      currentItem: null,
      allDone: false,
      keyword: '',
      fieldIndex: 0
    });

    const allItems = [];

    for (let i = 0; i < filePaths.length; i++) {
      wx.showLoading({ title: `识别第 ${i + 1} / ${filePaths.length} 张...` });
      try {
        const items = await this.recognizeOne(filePaths[i]);
        allItems.push(...items);
      } catch (e) {
        console.error(`第 ${i + 1} 张识别失败:`, e);
      }
    }

    wx.hideLoading();

    if (allItems.length === 0) {
      wx.showToast({ title: '未识别到任何内容', icon: 'none' });
      this.setData({ loading: false });
      return;
    }

    const seen = {};
    const parsed = [];
    allItems.forEach(item => {
      if (seen[item.uid]) return;
      seen[item.uid] = true;
      parsed.push(item);
    });

    const sorted = sortByArea(parsed);
    const fingerprint = makeFingerprint(sorted);

    this.saveBatchToAllItems(sorted);

    const duplicated = this.findBatchByFingerprint(fingerprint);

    if (duplicated) {
      const allHandled = duplicated.items.length > 0 &&
                         duplicated.items.every(i => isHandled(i));

      if (allHandled) {
        wx.showModal({
          title: '订单已完成',
          content: '这个订单之前已经处理完成了，无需重复扫描。',
          showCancel: false,
          confirmText: '知道了'
        });
        this.setData({ loading: false });
        return;
      }

      const restored = this.restoreFromBatch(duplicated);
      let targetIndex = typeof duplicated.lastIndex === 'number'
                        ? duplicated.lastIndex
                        : findFirstUnhandled(restored);

      if (targetIndex < 0 || targetIndex >= restored.length) {
        targetIndex = findFirstUnhandled(restored);
      }
      if (targetIndex < 0) targetIndex = 0;

      this.setData({
        tableData: restored,
        currentIndex: targetIndex,
        currentItem: restored[targetIndex],
        currentBatchId: duplicated.id,
        keyword: '',
        fieldIndex: 0,
        loading: false
      }, () => {
        this.refreshFilteredList();
      });
      this.checkAllDone(restored);
      this.saveState();

      wx.showModal({
        title: '检测到重复订单',
        content: '上次未完成，已恢复上次的拣货进度。',
        showCancel: false,
        confirmText: '继续拣货'
      });
      return;
    }

    const batchId = 'batch_' + Date.now();
    this.setData({
      tableData: sorted,
      currentIndex: 0,
      currentItem: sorted[0],
      currentBatchId: batchId,
      keyword: '',
      fieldIndex: 0,
      loading: false
    }, () => {
      this.refreshFilteredList();
    });

    this.saveBatchToHistory(batchId, sorted, fingerprint, 0);
    this.mergeHistoryStatus();
    this.saveState();

    wx.showToast({ title: `共识别 ${sorted.length} 条`, icon: 'success' });
  },

  findBatchByFingerprint(fp) {
    const history = wx.getStorageSync(HISTORY_KEY) || [];
    return history.find(b => b.fingerprint === fp) || null;
  },

  restoreFromBatch(batch) {
    return batch.items.map(i => ({
      location: i.location,
      spec: i.spec,
      quantity: i.quantity,
      sku: i.sku,
      confirmed: !!i.confirmed,
      outOfStock: !!i.outOfStock,
      uid: i.uid
    }));
  },

  recognizeOne(filePath) {
    return new Promise((resolve, reject) => {
      const cfg = wx.getStorageSync('tc_secret_config');
      const secretId = (cfg && cfg.secretId) || 'AKIDGXceU6VkmdHixzoQtoW5VikbFkw9HPch';
      const secretKey = (cfg && cfg.secretKey) || 'BKWXN1Tr58ydR7ey99xYMybCexAC1gFj';

      const fs = wx.getFileSystemManager();
      let base64Img;
      try {
        base64Img = fs.readFileSync(filePath, 'base64');
      } catch (e) {
        return reject(e);
      }

      const endpoint = 'ocr.tencentcloudapi.com';
      const service = 'ocr';
      const action = 'RecognizeTableAccurateOCR';
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
            const code = res.data.Response.Error.Code || '';
            if (code.startsWith('AuthFailure')) {
              wx.showModal({
                title: '密钥验证失败',
                content: res.data.Response.Error.Message,
                showCancel: false
              });
            }
            return reject(new Error(res.data.Response.Error.Message));
          }
          if (res.data.Response &&
              res.data.Response.TableDetections &&
              res.data.Response.TableDetections.length > 0) {
            try {
              resolve(this.parseOne(res.data.Response.TableDetections));
            } catch (e) {
              reject(e);
            }
          } else {
            resolve([]);
          }
        },
        fail: (err) => reject(err)
      });
    });
  },

  parseOne(tableDetections) {
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

    const locationIdx = findCol(['库位', '货位', '位置']);
    const specIdx     = findCol(['颜色', '尺码', '规格']);
    const qtyIdx      = findCol(['数量', '件数', '拣货数']);
    const skuIdx      = headers.findIndex(h => h.toUpperCase().includes('SKU'));

    const list = [];
    for (let r = 1; r <= maxRow; r++) {
      const row = matrix[r];
      if (!row || row.filter(v => v).length < 2) continue;
      const location = locationIdx >= 0 ? row[locationIdx] : '';
      if (!location) continue;

      const spec = specIdx >= 0 ? row[specIdx] : '';
      const sku  = skuIdx  >= 0 ? row[skuIdx]  : '';

      list.push({
        location,
        spec,
        quantity: parseInt(qtyIdx >= 0 ? row[qtyIdx] : '0') || 0,
        sku,
        confirmed: false,
        outOfStock: false,
        uid: makeUid({ location, spec, sku })
      });
    }
    return list;
  },

  saveBatchToHistory(batchId, items, fingerprint, lastIndex) {
    const history = wx.getStorageSync(HISTORY_KEY) || [];
    const idx = history.findIndex(b => b.id === batchId);

    const batch = {
      id: batchId,
      time: Date.now(),
      fingerprint: fingerprint || '',
      lastIndex: typeof lastIndex === 'number' ? lastIndex : 0,
      items: items.map(i => ({ ...i }))
    };

    if (idx >= 0) history[idx] = batch;
    else history.push(batch);

    wx.setStorageSync(HISTORY_KEY, history);
  },

  saveBatchToAllItems(items) {
    const allItems = wx.getStorageSync(ALL_ITEMS_KEY) || [];
    const map = {};
    allItems.forEach(i => { map[i.uid] = i; });

    items.forEach(item => {
      const existing = map[item.uid];
      if (existing) {
        existing.location = item.location || existing.location;
        existing.spec = item.spec || existing.spec;
        existing.sku = item.sku || existing.sku;
        existing.quantity = item.quantity || existing.quantity;
        existing.lastTime = Date.now();
      } else {
        map[item.uid] = {
          uid: item.uid,
          location: item.location || '',
          spec: item.spec || '',
          sku: item.sku || '',
          quantity: item.quantity || 0,
          confirmed: !!item.confirmed,
          outOfStock: !!item.outOfStock,
          lastTime: Date.now()
        };
      }
    });

    wx.setStorageSync(ALL_ITEMS_KEY, Object.values(map));
  },

  updateAllItem(item) {
    if (!item) return;
    const allItems = wx.getStorageSync(ALL_ITEMS_KEY) || [];
    const idx = allItems.findIndex(i => i.uid === item.uid);

    const record = {
      uid: item.uid,
      location: item.location || '',
      spec: item.spec || '',
      sku: item.sku || '',
      quantity: item.quantity || 0,
      confirmed: !!item.confirmed,
      outOfStock: !!item.outOfStock,
      lastTime: Date.now()
    };

    if (idx >= 0) allItems[idx] = record;
    else allItems.push(record);

    wx.setStorageSync(ALL_ITEMS_KEY, allItems);
  },

  updateHistoryItem(batchId, uid, updates, lastIndex) {
    if (!batchId) return;
    const history = wx.getStorageSync(HISTORY_KEY) || [];
    const batch = history.find(b => b.id === batchId);
    if (!batch) return;

    const item = batch.items.find(i => i.uid === uid);
    if (item) {
      Object.assign(item, updates, { time: Date.now() });
      this.updateAllItem(item);
    }

    if (typeof lastIndex === 'number') {
      batch.lastIndex = lastIndex;
    }

    wx.setStorageSync(HISTORY_KEY, history);
  },

  mergeHistoryStatus() {
    const { currentBatchId } = this.data;
    const history = wx.getStorageSync(HISTORY_KEY) || [];
    const batch = history.find(b => b.id === currentBatchId);
    if (!batch) return;

    const map = {};
    batch.items.forEach(i => {
      map[i.uid] = { confirmed: !!i.confirmed, outOfStock: !!i.outOfStock };
    });

    const tableData = this.data.tableData.map(item => {
      if (map[item.uid]) {
        return {
          ...item,
          confirmed: map[item.uid].confirmed,
          outOfStock: map[item.uid].outOfStock
        };
      }
      return item;
    });

    const currentIndex = this.data.currentIndex;
    const currentItem = tableData[currentIndex] || null;

    this.setData({ tableData, currentItem }, () => {
      this.refreshFilteredList();
    });
    this.checkAllDone(tableData);
  },

  findNextUnhandled(newTable, currentIndex) {
    let next = -1;
    for (let i = currentIndex + 1; i < newTable.length; i++) {
      if (!isHandled(newTable[i])) { next = i; break; }
    }
    if (next === -1) {
      for (let i = 0; i < currentIndex; i++) {
        if (!isHandled(newTable[i])) { next = i; break; }
      }
    }
    return next;
  },

  onConfirm() {
    if (this.data.allDone) return;

    const { currentIndex, tableData, currentBatchId } = this.data;
    if (!tableData.length) return;

    const item = tableData[currentIndex];
    const newTable = tableData.slice();
    newTable[currentIndex] = { ...item, confirmed: true, outOfStock: false };

    const next = this.findNextUnhandled(newTable, currentIndex);

    if (next === -1) {
      this.updateHistoryItem(currentBatchId, item.uid,
        { confirmed: true, outOfStock: false }, currentIndex);
      this.setData({
        tableData: newTable,
        currentItem: newTable[currentIndex],
        allDone: true
      }, () => {
        this.refreshFilteredList();
      });
      this.saveState();
      wx.showToast({ title: '已全部拣货完成 🎉', icon: 'success' });
      return;
    }

    this.updateHistoryItem(currentBatchId, item.uid,
      { confirmed: true, outOfStock: false }, next);

    this.setData({
      tableData: newTable,
      currentIndex: next,
      currentItem: newTable[next]
    }, () => {
      this.refreshFilteredList();
    });
    this.checkAllDone(newTable);
    this.saveState();
    wx.showToast({ title: '已确认', icon: 'success' });
  },

  onOutOfStock() {
    if (this.data.allDone) return;

    const { currentIndex, tableData, currentBatchId } = this.data;
    if (!tableData.length) return;

    const item = tableData[currentIndex];
    const newTable = tableData.slice();
    newTable[currentIndex] = { ...item, confirmed: false, outOfStock: true };

    const next = this.findNextUnhandled(newTable, currentIndex);

    if (next === -1) {
      this.updateHistoryItem(currentBatchId, item.uid,
        { confirmed: false, outOfStock: true }, currentIndex);
      this.setData({
        tableData: newTable,
        currentItem: newTable[currentIndex],
        allDone: true
      }, () => {
        this.refreshFilteredList();
      });
      this.saveState();
      wx.showToast({ title: '已全部处理完成 🎉', icon: 'success' });
      return;
    }

    this.updateHistoryItem(currentBatchId, item.uid,
      { confirmed: false, outOfStock: true }, next);

    this.setData({
      tableData: newTable,
      currentIndex: next,
      currentItem: newTable[next]
    }, () => {
      this.refreshFilteredList();
    });
    this.checkAllDone(newTable);
    this.saveState();
    wx.showToast({ title: '已标记缺货', icon: 'none' });
  },

  goHistory() {
    wx.navigateTo({ url: '/pages/history/history' });
  },
  goMulti() {
    wx.navigateTo({ url: '/pages/multi/multi' });
  },
});