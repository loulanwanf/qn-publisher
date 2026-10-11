/**
 * 简易日志：内存环形缓冲 + 落盘
 * v1.1 商用打磨：
 *  - 单日文件超 5MB 自动滚动（.old1/.old2 最多两份，当天新开继续写）
 *  - 启动时自动清理 15 天前的旧日志（防磁盘无限累积）
 */
const fs = require('fs');
const path = require('path');

const MAX_FILE_MB = 5;
const MAX_ROLLS = 2;        // 当天最多保留 2 个滚动副本
const KEEP_DAYS = 15;       // 旧日志保留天数

class Logger {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.buf = [];
    this.maxBuf = 2000;
    this._cleanupOldLogs();
    this.filePath = path.join(dir, `app-${new Date().toISOString().slice(0, 10)}.log`);
  }
  log(level, tag, message, detail) {
    const entry = {
      time: new Date().toISOString(),
      level, tag,
      message: String(message),
      detail: detail === undefined ? null : detail,
    };
    this.buf.push(entry);
    if (this.buf.length > this.maxBuf) this.buf.shift();
    try {
      this._appendWithRoll(entry);
    } catch (_) {}
    return entry;
  }
  /** 落盘 + 文件大小滚动（单文件超限改名 .old1，继续写新文件） */
  _appendWithRoll(entry) {
    const line = `[${entry.time}] [${entry.level}] [${entry.tag}] ${entry.message}` +
      (entry.detail !== undefined ? ` :: ${safeStr(entry.detail)}` : '') + '\n';
    try {
      const st = fs.statSync(this.filePath);
      if (st.size > MAX_FILE_MB * 1024 * 1024) {
        // 滚动：.old2 删、.old1→.old2、当前→.old1
        try { fs.unlinkSync(this.filePath + '.old2'); } catch (_) {}
        try { fs.renameSync(this.filePath + '.old1', this.filePath + '.old2'); } catch (_) {}
        try { fs.renameSync(this.filePath, this.filePath + '.old1'); } catch (_) {}
      }
    } catch (_) {}
    fs.appendFileSync(this.filePath, line);
  }
  /** 启动时清理 N 天前的日志文件（含滚动副本） */
  _cleanupOldLogs() {
    try {
      const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
      const files = fs.readdirSync(this.dir);
      for (const f of files) {
        const m = f.match(/^app-(\d{4}-\d{2}-\d{2})\.log/);
        if (!m) continue;
        const st = fs.statSync(path.join(this.dir, f));
        if (st.mtimeMs < cutoff) {
          try { fs.unlinkSync(path.join(this.dir, f)); } catch (_) {}
        }
      }
    } catch (_) {}
  }
  info(tag, msg, d) { return this.log('INFO', tag, msg, d); }
  warn(tag, msg, d) { return this.log('WARN', tag, msg, d); }
  error(tag, msg, d) { return this.log('ERROR', tag, msg, d); }
  success(tag, msg, d) { return this.log('SUCCESS', tag, msg, d); }
  recent(n = 300) { return this.buf.slice(-n); }
}
function safeStr(d) {
  if (d === null || d === undefined) return '';
  if (typeof d === 'string') return d;
  try { return JSON.stringify(d).slice(0, 2000); } catch (_) { return String(d); }
}
module.exports = { Logger };