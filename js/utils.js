// ============================================================
// utils.js — 工具函数与数据模型定义
// ============================================================

const Utils = (() => {
  // ---- ID 生成 ----
  let _idCounter = 0;
  function genId(prefix = '') {
    return prefix + (++_idCounter) + '_' + Math.random().toString(36).slice(2, 8);
  }

  // ---- 时间工具 ----
  function parseTime(str) {
    if (str instanceof Date) return str.getTime();
    if (typeof str === 'number') return str;
    const d = new Date(str);
    if (isNaN(d.getTime())) throw new Error('无法解析时间: ' + str);
    return d.getTime();
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function fmtDateTime(ts) {
    const d = new Date(ts);
    return fmtDate(ts) + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  function fmtDuration(ms) {
    const hrs = Math.floor(ms / 3600000);
    const mins = Math.floor((ms % 3600000) / 60000);
    if (hrs > 0 && mins > 0) return `${hrs}h${mins}m`;
    if (hrs > 0) return `${hrs}h`;
    return `${mins}m`;
  }

  const HOUR = 3600000;
  const MINUTE = 60000;
  const DAY = 86400000;

  function dayStart(ts) {
    const d = new Date(ts);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }

  function dayEnd(ts) {
    return dayStart(ts) + DAY - 1;
  }

  // 将 HH:MM 转为当天的毫秒偏移
  function hmToOffset(hm) {
    const [h, m] = hm.split(':').map(Number);
    return h * HOUR + m * MINUTE;
  }

  // 展开班次到具体日期范围内的时间窗口
  // shift: { startTime: "08:00", endTime: "16:00" } 或跨天 { startTime: "22:00", endTime: "06:00" }
  function expandShiftWindows(shift, rangeStart, rangeEnd) {
    const windows = [];
    const startOff = hmToOffset(shift.startTime);
    const endOff = hmToOffset(shift.endTime);
    const crossDay = endOff <= startOff;

    let day = dayStart(rangeStart) - DAY; // 从前一天开始，防止跨天遗漏
    while (day <= rangeEnd) {
      let ws = day + startOff;
      let we = crossDay ? day + DAY + endOff : day + endOff;
      if (we > rangeStart && ws < rangeEnd) {
        windows.push({ start: Math.max(ws, rangeStart), end: Math.min(we, rangeEnd) });
      }
      day += DAY;
    }
    return windows;
  }

  // 检查时间点是否在班次窗口内
  function isInShiftWindows(ts, windows) {
    return windows.some(w => ts >= w.start && ts < w.end);
  }

  // 在工作时间窗口内推进 duration 毫秒
  function advanceInWindows(startTs, duration, windows) {
    // 把 windows 排序
    const sorted = [...windows].sort((a, b) => a.start - b.start);
    let remaining = duration;
    let current = startTs;

    for (const w of sorted) {
      if (w.end <= current) continue;
      const effectiveStart = Math.max(current, w.start);
      const available = w.end - effectiveStart;
      if (available >= remaining) {
        return effectiveStart + remaining;
      }
      remaining -= available;
      current = w.end;
    }
    // 如果窗口不够，返回最后窗口结束 + 剩余时间（溢出警告）
    return current + remaining;
  }

  // 两个区间是否重叠
  function intervalsOverlap(s1, e1, s2, e2) {
    return s1 < e2 && s2 < e1;
  }

  // ---- CSV 解析 ----
  function parseCSV(text) {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const headers = parseCSVLine(lines[0]);
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = parseCSVLine(lines[i]);
      if (vals.length === 0 || (vals.length === 1 && vals[0] === '')) continue;
      const obj = {};
      headers.forEach((h, idx) => {
        obj[h.trim()] = (vals[idx] || '').trim();
      });
      rows.push(obj);
    }
    return rows;
  }

  function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuotes) {
        if (c === '"' && line[i + 1] === '"') {
          current += '"';
          i++;
        } else if (c === '"') {
          inQuotes = false;
        } else {
          current += c;
        }
      } else {
        if (c === '"') {
          inQuotes = true;
        } else if (c === ',') {
          result.push(current);
          current = '';
        } else {
          current += c;
        }
      }
    }
    result.push(current);
    return result;
  }

  // ---- 颜色工具 ----
  const ORDER_COLORS = [
    '#4A90D9', '#E67E22', '#2ECC71', '#E74C3C', '#9B59B6',
    '#1ABC9C', '#F39C12', '#3498DB', '#E91E63', '#00BCD4',
    '#8BC34A', '#FF5722', '#607D8B', '#795548', '#CDDC39',
    '#FF9800', '#5C6BC0', '#26A69A', '#EF5350', '#AB47BC'
  ];

  function orderColor(index) {
    return ORDER_COLORS[index % ORDER_COLORS.length];
  }

  function lighten(hex, amount = 0.3) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const nr = Math.min(255, Math.round(r + (255 - r) * amount));
    const ng = Math.min(255, Math.round(g + (255 - g) * amount));
    const nb = Math.min(255, Math.round(b + (255 - b) * amount));
    return `#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}`;
  }

  function darken(hex, amount = 0.2) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    const nr = Math.max(0, Math.round(r * (1 - amount)));
    const ng = Math.max(0, Math.round(g * (1 - amount)));
    const nb = Math.max(0, Math.round(b * (1 - amount)));
    return `#${nr.toString(16).padStart(2, '0')}${ng.toString(16).padStart(2, '0')}${nb.toString(16).padStart(2, '0')}`;
  }

  // ---- 深拷贝 ----
  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  // ---- 事件总线 ----
  class EventBus {
    constructor() { this._listeners = {}; }
    on(evt, fn) {
      (this._listeners[evt] || (this._listeners[evt] = [])).push(fn);
    }
    off(evt, fn) {
      const arr = this._listeners[evt];
      if (arr) this._listeners[evt] = arr.filter(f => f !== fn);
    }
    emit(evt, data) {
      (this._listeners[evt] || []).forEach(fn => fn(data));
    }
  }

  // ---- 数据校验 ----
  function validateOrder(o) {
    if (!o.id || !o.name) return '订单缺少 id 或 name';
    return null;
  }

  function validateProcess(p) {
    if (!p.id || !p.orderId) return '工序缺少 id 或 orderId';
    if (!p.duration || p.duration <= 0) return '工序 duration 无效';
    return null;
  }

  function validateEquipment(e) {
    if (!e.id || !e.name) return '设备缺少 id 或 name';
    return null;
  }

  // ---- 导出报告格式化 ----
  function scheduleToCSV(tasks) {
    const headers = ['订单ID', '订单名称', '工序ID', '工序名称', '设备', '开始时间', '结束时间', '时长(h)', '状态'];
    const lines = [headers.join(',')];
    for (const t of tasks) {
      lines.push([
        t.orderId, t.orderName || '', t.processId, t.processName || '',
        t.equipmentName || t.equipmentId,
        fmtDateTime(t.start), fmtDateTime(t.end),
        ((t.end - t.start) / HOUR).toFixed(1),
        t.conflicts && t.conflicts.length > 0 ? '有冲突' : '正常'
      ].map(v => `"${v}"`).join(','));
    }
    return lines.join('\n');
  }

  function riskReportToText(conflicts) {
    const lines = ['=== 排产风险报告 ===', `生成时间: ${fmtDateTime(Date.now())}`, ''];
    const types = {
      'equipment_conflict': '设备冲突',
      'material_not_ready': '物料未到',
      'deadline_risk': '交期风险',
      'changeover_excess': '换线过多',
      'shift_overload': '班次超负荷',
      'dependency_violation': '工序依赖违反',
      'maintenance_conflict': '维护冲突'
    };
    if (conflicts.length === 0) {
      lines.push('未发现风险项。');
    } else {
      const grouped = {};
      for (const c of conflicts) {
        const type = types[c.type] || c.type;
        (grouped[type] || (grouped[type] = [])).push(c);
      }
      for (const [type, items] of Object.entries(grouped)) {
        lines.push(`## ${type} (${items.length}项)`);
        for (const item of items) {
          lines.push(`  - ${item.message}`);
        }
        lines.push('');
      }
    }
    return lines.join('\n');
  }

  // ---- 文件下载 ----
  function downloadFile(content, filename, mime = 'text/plain') {
    const blob = new Blob([content], { type: mime + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return {
    genId, parseTime, fmtDate, fmtDateTime, fmtDuration,
    HOUR, MINUTE, DAY,
    dayStart, dayEnd, hmToOffset,
    expandShiftWindows, isInShiftWindows, advanceInWindows,
    intervalsOverlap,
    parseCSV, orderColor, lighten, darken,
    deepClone, EventBus,
    validateOrder, validateProcess, validateEquipment,
    scheduleToCSV, riskReportToText, downloadFile
  };
})();
