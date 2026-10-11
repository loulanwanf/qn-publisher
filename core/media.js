/**
 * 图片模块：1688 图片下载到本地缓存（发布时上传到淘宝）
 */
const { net } = require('electron');
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

class Media {
  constructor(store, logger) {
    this.store = store;
    this.logger = logger;
  }

  /** 清洗1688图片URL：去尺寸后缀/webp转jpg，拿原图 */
  static normalize(url) {
    let u = String(url || '').split('?')[0];
    // .jpg_.webp → .jpg （1688新版详情页图片格式）
    u = u.replace(/\.jpe?g_\.webp$/i, '.jpg');
    u = u.replace(/\.png_\.webp$/i, '.png');
    u = u.replace(/_\.webp$/i, '.jpg');
    // .310x310.jpg / _sum.jpg 等压缩后缀 → 原图
    u = u.replace(/\.\d+x\d+[a-zA-Z-]*\.(jpg|png|webp)$/i, '.$1');
    u = u.replace(/_\d+x\d+[a-zA-Z-]*\.(jpg|png)$/i, '.$1');
    u = u.replace(/_sum\.(jpg|png)$/i, '.$1');
    u = u.replace(/_\d+x\d+[a-zA-Z-]*\.jpg$/i, '.jpg');
    if (/\.png(_|$)/i.test(u)) u = u.replace(/\.png.*$/i, '.png');
    if (/\.webp($|_)/i.test(u)) u = u.replace(/\.webp.*$/i, '.jpg');
    if (!/^https?:/.test(u)) u = 'https:' + (u.startsWith('//') ? '' : '//') + u;
    return u;
  }

  _dir(offerId, type) {
    const d = path.join(this.store.imgDir, String(offerId), type);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  /**
   * 批量下载图片
   * @returns 本地路径数组
   */
  async downloadImages(offerId, type, urls) {
    const dir = this._dir(offerId, type);
    const tasks = (urls || []).slice(0, type === 'main' ? 5 : 80);
    const out = [];
    for (let i = 0; i < tasks.length; i++) {
      const raw = tasks[i];
      if (!raw) continue;
      const url = Media.normalize(raw);
      const ext = /\.(png|gif)$/i.test(url) ? (url.match(/\.(png|gif)$/i)[1]) : 'jpg';
      const file = path.join(dir, `${i + 1}.${ext}`);
      try {
        if (fs.existsSync(file) && fs.statSync(file).size > 5000) { out.push(file); continue; }
        const buf = await this._fetch(url);
        fs.writeFileSync(file, buf);
        out.push(file);
      } catch (e) {
        this.logger.warn('media', `图片下载失败 ${url.slice(0, 90)}`, e.message);
      }
      // 轻微限速，礼貌抓取
      await new Promise(r => setTimeout(r, 150 + Math.random() * 250));
    }
    return out;
  }

  _fetch(url, retries = 2) {
    return new Promise((resolve, reject) => {
      const doFetch = (attempt) => {
        // Electron net.request：headers 必须在 options 里（ClientRequest 没有 setHeader）
        const req = net.request({
          url,
          redirect: 'follow',
          headers: {
            'User-Agent': UA,
            'Referer': 'https://detail.1688.com/',
            'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
          },
        });
        const chunks = [];
        req.on('response', (res) => {
          if (res.statusCode >= 300) {
            if (attempt < retries) return doFetch(attempt + 1);
            return reject(new Error('HTTP ' + res.statusCode));
          }
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', (e) => {
          if (attempt < retries) return doFetch(attempt + 1);
          reject(e);
        });
        req.end();
      };
      doFetch(0);
    });
  }

  _list(dir) {
    try {
      return fs.readdirSync(dir)
        .filter(f => /\.(jpg|png|gif|jpeg)$/i.test(f))
        .sort((a, b) => parseInt(a) - parseInt(b) || a.localeCompare(b))
        .map(f => path.join(dir, f));
    } catch (_) { return []; }
  }

  /** 下载1688主图视频（mp4），带缓存。返回本地路径或 null */
  async downloadVideo(offerId, url) {
    if (!url) return null;
    let u = String(url).split('|')[0].trim(); // 黑鲸鱼同款：多地址取第一个
    if (u.startsWith('//')) u = 'https:' + u;
    if (!/^https?:/.test(u)) return null;
    const dir = path.join(this.store.imgDir, String(offerId));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'video.mp4');
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 20000) return file;
      const buf = await this._fetch(u);
      if (!buf || buf.length < 20000) return null;
      fs.writeFileSync(file, buf);
      this.logger.info('media', `视频下载完成 ${Math.round(buf.length / 1024)}KB`);
      return file;
    } catch (e) {
      this.logger.warn('media', `视频下载失败 ${u.slice(0, 90)}`, e.message);
      return null;
    }
  }

  /** 已下载的本地图 + 视频（发布时用） */
  localPaths(offerId) {
    const base = path.join(this.store.imgDir, String(offerId));
    const mains = this._list(path.join(base, 'main'));
    const details = this._list(path.join(base, 'detail'));
    const video = path.join(base, 'video.mp4');
    let videoFile = '';
    try {
      if (fs.existsSync(video) && fs.statSync(video).size > 20000) videoFile = video;
    } catch (_) {}
    return { main: mains, detail: details, video: videoFile };
  }
}

module.exports = Media;
