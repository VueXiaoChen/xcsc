const HISTORY_KEY = 'pick_history';
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
    batch: null,
    items: []
  },

  onLoad(options) {
    const id = options.id;
    if (!id) {
      wx.showToast({ title: '参数错误', icon: 'none' });
      return;
    }

    const history = wx.getStorageSync(HISTORY_KEY) || [];
    const batch = history.find(b => b.id === id);
    if (!batch) {
      wx.showToast({ title: '记录不存在', icon: 'none' });
      return;
    }

    const items = sortByArea(batch.items || []);

    this.setData({
      batch: {
        id: batch.id,
        timeText: formatTime(batch.time),
        total: items.length,
        confirmed: items.filter(i => i.confirmed).length,
        outOfStock: items.filter(i => i.outOfStock && !i.confirmed).length
      },
      items
    });

    wx.setNavigationBarTitle({
      title: formatTime(batch.time)
    });
  },

  copyBatch() {
    if (!this.data.batch) return;
    const lines = this.data.items.map(i => {
      let status = '待捡货';
      if (i.confirmed) status = '已确认';
      else if (i.outOfStock) status = '缺货';
      return `${i.location} | ${i.spec} | 数量:${i.quantity} | ${i.sku} | ${status}`;
    });
    const header = `时间: ${this.data.batch.timeText}\n合计 ${this.data.batch.total} 条\n----------\n`;
    wx.setClipboardData({
      data: header + lines.join('\n'),
      success: () => wx.showToast({ title: '已复制', icon: 'success' })
    });
  },

  deleteBatch() {
    wx.showModal({
      title: '删除这次扫描？',
      success: (res) => {
        if (!res.confirm) return;
        const history = wx.getStorageSync(HISTORY_KEY) || [];
        const filtered = history.filter(b => b.id !== this.data.batch.id);
        wx.setStorageSync(HISTORY_KEY, filtered);
        wx.showToast({ title: '已删除', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 500);
      }
    });
  }
});

function formatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = n => (n < 10 ? '0' + n : n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}