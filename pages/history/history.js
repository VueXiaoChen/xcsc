const HISTORY_KEY = 'pick_history';
const STATE_KEY   = 'pick_state';

Page({
  data: {
    batches: []
  },

  onShow() {
    this.loadHistory();
  },

  loadHistory() {
    let batches = wx.getStorageSync(HISTORY_KEY) || [];
    batches = batches.filter(b =>
      b && typeof b === 'object' && Array.isArray(b.items)
    );

    batches.sort((a, b) => (b.time || 0) - (a.time || 0));

    const list = batches.map(b => {
      const total = b.items.length;
      const confirmed = b.items.filter(i => i.confirmed).length;
      const outOfStock = b.items.filter(i => i.outOfStock && !i.confirmed).length;
      const allHandled = total > 0 && b.items.every(i => i.confirmed || i.outOfStock);
      return {
        id: b.id,
        time: b.time,
        timeText: formatTime(b.time),
        total,
        confirmed,
        outOfStock,
        allDone: allHandled
      };
    });

    this.setData({ batches: list });
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({
      url: `/pages/detail/detail?id=${id}`
    });
  },

  goAll() {
    wx.navigateTo({ url: '/pages/all/all' });
  },

  // ⭐ 清空扫描记录时，同时清首页进度状态
  clearAll() {
    wx.showModal({
      title: '清空全部数据？',
      content: '将清除所有扫描批次和当前进度（不影响总历史记录）',
      success: (res) => {
        if (!res.confirm) return;
        wx.removeStorageSync(HISTORY_KEY);
        wx.removeStorageSync(STATE_KEY);
        this.setData({ batches: [] });
        wx.showToast({ title: '已清空', icon: 'success' });
      }
    });
  },

  deleteBatch(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: '删除这次扫描？',
      content: '删除后无法恢复',
      success: (res) => {
        if (!res.confirm) return;
        const history = wx.getStorageSync(HISTORY_KEY) || [];
        const filtered = history.filter(b => b.id !== id);
        wx.setStorageSync(HISTORY_KEY, filtered);
        this.loadHistory();
        wx.showToast({ title: '已删除', icon: 'success' });
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