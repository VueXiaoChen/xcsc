Page({
  data: {},

  onLoad() {
    // 可选：如果还没配置密钥，可以先放行
    // const cfg = wx.getStorageSync('tc_secret_config');
    // if (!cfg || !cfg.secretId) {
    //   wx.reLaunch({ url: '/pages/setup/setup' });
    // }
  },

  goMulti() {
    wx.navigateTo({ url: '/pages/multi/multi' });
  },

  goScan() {
    wx.navigateTo({ url: '/pages/scan/scan' });
  },

  goHistory() {
    wx.navigateTo({ url: '/pages/history/history' });
  }
});