const ALL_ITEMS_KEY = 'pick_all_items';
const EXPORT_DIR = `${wx.env.USER_DATA_PATH}/pick_exports`;
const AREA_ORDER = ['LJ', 'BLJ', '2H', 'P', 'JH'];

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

Page({
  data: {
    keyword: '',
    allItems: [],
    filtered: [],
    totalCount: 0
  },

  onShow() {
    this.loadAll();
  },

  loadAll() {
    const allItems = sortByArea(wx.getStorageSync(ALL_ITEMS_KEY) || []);
    this.setData({
      allItems,
      filtered: allItems,
      totalCount: allItems.length
    });
  },

  onSearchInput(e) {
    const keyword = (e.detail.value || '').trim().toLowerCase();
    this.setData({ keyword });
    this.applyFilter();
  },

  clearSearch() {
    this.setData({ keyword: '' });
    this.applyFilter();
  },

  applyFilter() {
    const { allItems, keyword } = this.data;
    if (!keyword) {
      this.setData({ filtered: allItems });
      return;
    }
    const filtered = allItems.filter(i =>
      (i.location || '').toLowerCase().includes(keyword) ||
      (i.spec || '').toLowerCase().includes(keyword) ||
      (i.sku || '').toLowerCase().includes(keyword)
    );
    this.setData({ filtered });
  },

  // ============ 导出 ============
  exportHistory() {
    if (this.data.totalCount === 0) {
      wx.showToast({ title: '没有可导出的记录', icon: 'none' });
      return;
    }
    wx.showActionSheet({
      itemList: ['复制为文本', '导出为 JSON 文件'],
      success: (res) => {
        if (res.tapIndex === 0) this.copyAsText();
        if (res.tapIndex === 1) this.exportAsFile();
      }
    });
  },

  copyAsText() {
    const list = this.data.allItems;
    const lines = list.map(i => {
      let status = '待捡货';
      if (i.confirmed) status = '已确认';
      else if (i.outOfStock) status = '缺货';
      return `${i.location} | ${i.spec} | 数量:${i.quantity} | ${i.sku} | ${status}`;
    });
    const header = `总记录导出\n共 ${list.length} 条\n导出时间: ${new Date().toLocaleString()}\n----------\n`;
    wx.setClipboardData({
      data: header + lines.join('\n'),
      success: () => wx.showToast({ title: '已复制', icon: 'success' })
    });
  },

  exportAsFile() {
    const list = this.data.allItems;
    const data = {
      version: 1,
      exportTime: Date.now(),
      count: list.length,
      items: list
    };
    const content = JSON.stringify(data, null, 2);

    // 确保目录存在
    const fs = wx.getFileSystemManager();
    try {
      fs.accessSync(EXPORT_DIR);
    } catch (e) {
      try {
        fs.mkdirSync(EXPORT_DIR, true);
      } catch (e2) {
        console.error('mkdir fail', e2);
      }
    }

    const ts = formatTimestamp(Date.now());
    const filename = `pick_history_${ts}.json`;
    const filePath = `${EXPORT_DIR}/${filename}`;

    try {
      fs.writeFileSync(filePath, content, 'utf8');
      wx.showModal({
        title: '导出成功',
        content: `文件已保存至：\n${filePath}\n\n可以点"打开"用其他应用查看，或点"分享"发送到微信/邮箱。`,
        confirmText: '打开',
        cancelText: '知道了',
        success: (r) => {
          if (r.confirm) {
            wx.openDocument({
              filePath,
              fileType: 'json',   // 有些手机不支持 json，可以改成 txt
              showMenu: true,
              fail: () => {
                // json 打不开时，尝试用 txt 方式打开
                wx.openDocument({
                  filePath,
                  fileType: 'txt',
                  showMenu: true
                });
              }
            });
          }
        }
      });
    } catch (e) {
      console.error(e);
      wx.showToast({ title: '导出失败', icon: 'none' });
    }
  },

  // ============ 上传（恢复） ============
  restoreHistory() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['json', 'txt'],
      success: (res) => {
        const file = res.tempFiles[0];
        const fs = wx.getFileSystemManager();
        try {
          const content = fs.readFileSync(file.path, 'utf8');
          const data = JSON.parse(content);

          if (!data || !Array.isArray(data.items)) {
            wx.showToast({ title: '文件格式错误', icon: 'none' });
            return;
          }

          // 校验每一条
          const incoming = data.items.filter(i =>
            i && i.uid && i.location !== undefined
          );
          if (incoming.length === 0) {
            wx.showToast({ title: '文件无有效数据', icon: 'none' });
            return;
          }

          wx.showModal({
            title: '恢复方式',
            content: `文件包含 ${incoming.length} 条记录。\n\n合并：保留现有 + 添加文件里的\n覆盖：用文件里的替换现有全部`,
            confirmText: '合并',
            cancelText: '覆盖',
            success: (r) => {
              if (r.confirm) {
                this.mergeItems(incoming);
              } else {
                this.overwriteItems(incoming);
              }
            }
          });
        } catch (e) {
          console.error(e);
          wx.showToast({ title: '解析失败', icon: 'none' });
        }
      },
      fail: (err) => {
        if (err.errMsg && err.errMsg.indexOf('cancel') >= 0) return;
        wx.showToast({ title: '未选择文件', icon: 'none' });
      }
    });
  },

  mergeItems(incoming) {
    const existing = wx.getStorageSync(ALL_ITEMS_KEY) || [];
    const map = {};
    existing.forEach(i => { map[i.uid] = i; });
    incoming.forEach(i => { map[i.uid] = i; });   // 文件覆盖旧的
    const merged = Object.values(map);
    wx.setStorageSync(ALL_ITEMS_KEY, merged);
    this.loadAll();
    wx.showToast({ title: `合并完成，共 ${merged.length} 条`, icon: 'success' });
  },

  overwriteItems(incoming) {
    wx.setStorageSync(ALL_ITEMS_KEY, incoming);
    this.loadAll();
    wx.showToast({ title: `覆盖完成，共 ${incoming.length} 条`, icon: 'success' });
  },

  // ============ 删除（清空 + 清文件） ============
  deleteAll() {
    if (this.data.totalCount === 0) {
      wx.showToast({ title: '没有可删除的记录', icon: 'none' });
      return;
    }
    wx.showModal({
      title: '删除历史记录？',
      content: '将清空所有总记录，并删除本地导出的历史文件，不可恢复。',
      confirmColor: '#dc2626',
      success: (res) => {
        if (!res.confirm) return;
        // 1. 清 storage
        wx.removeStorageSync(ALL_ITEMS_KEY);
        // 2. 清导出目录
        this.clearExportDir();
        this.setData({ allItems: [], filtered: [], totalCount: 0, keyword: '' });
        wx.showToast({ title: '已删除', icon: 'success' });
      }
    });
  },

  clearExportDir() {
    const fs = wx.getFileSystemManager();
    try {
      const files = fs.readdirSync(EXPORT_DIR);
      files.forEach(f => {
        try { fs.unlinkSync(`${EXPORT_DIR}/${f}`); } catch (e) {}
      });
    } catch (e) {
      // 目录不存在，忽略
    }
  }
});

function formatTimestamp(ts) {
  const d = new Date(ts);
  const pad = n => (n < 10 ? '0' + n : n);
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}