// ============================================================
// ganttRenderer.js — Canvas 甘特图渲染器
// ============================================================

const GanttRenderer = (() => {
  const ROW_HEIGHT = 48;
  const HEADER_HEIGHT = 56;
  const TIME_HEADER_HEIGHT = 48;
  const LABEL_WIDTH = 160;
  const MIN_HOUR_WIDTH = 30;
  const MAX_HOUR_WIDTH = 200;
  const TASK_PADDING = 4;
  const TASK_RADIUS = 4;
  const ARROW_SIZE = 6;

  class Gantt {
    constructor(canvas, overlayCanvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.overlay = overlayCanvas;
      this.oCtx = overlayCanvas.getContext('2d');

      this.tasks = [];
      this.rows = [];        // { id, label, type }
      this.conflicts = [];
      this.dependencies = [];
      this.maintenanceWindows = [];
      this.shiftWindows = [];

      // 视图状态
      this.viewMode = 'equipment'; // equipment | order | crew
      this.hourWidth = 60;     // 每小时像素宽度
      this.scrollX = 0;
      this.scrollY = 0;
      this.timeStart = 0;     // 可视范围起始时间戳
      this.timeEnd = 0;

      // 交互状态
      this.hoveredTask = null;
      this.selectedTask = null;
      this.dragTask = null;
      this.dragOffsetX = 0;
      this.dragStartX = 0;
      this.dragStartY = 0;
      this.isDragging = false;

      // 冲突任务ID集
      this.conflictTaskIds = new Set();

      // 回调
      this.onTaskMove = null;   // (taskId, newStart) => void
      this.onTaskClick = null;  // (task) => void
      this.onTaskHover = null;  // (task, x, y) => void

      this._dpr = window.devicePixelRatio || 1;
    }

    // 设置数据
    setData(tasks, rows, conflicts, deps, maintWindows, shiftWindows) {
      this.tasks = tasks || [];
      this.rows = rows || [];
      this.conflicts = conflicts || [];
      this.dependencies = deps || [];
      this.maintenanceWindows = maintWindows || [];
      this.shiftWindows = shiftWindows || [];

      this.conflictTaskIds.clear();
      for (const c of this.conflicts) {
        if (c.taskIds) c.taskIds.forEach(id => this.conflictTaskIds.add(id));
      }

      // 计算时间范围
      if (this.tasks.length > 0) {
        this.timeStart = Math.min(...this.tasks.map(t => t.start));
        this.timeEnd = Math.max(...this.tasks.map(t => t.end));
        // 前后各加12小时缓冲
        this.timeStart = Utils.dayStart(this.timeStart) - 12 * Utils.HOUR;
        this.timeEnd = Utils.dayStart(this.timeEnd) + 36 * Utils.HOUR;
      } else {
        this.timeStart = Date.now();
        this.timeEnd = this.timeStart + 7 * Utils.DAY;
      }

      this.render();
    }

    // 调整 Canvas 尺寸
    resize() {
      const parent = this.canvas.parentElement;
      if (!parent) return;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      this._dpr = window.devicePixelRatio || 1;

      for (const c of [this.canvas, this.overlay]) {
        c.width = w * this._dpr;
        c.height = h * this._dpr;
        c.style.width = w + 'px';
        c.style.height = h + 'px';
      }
      this.ctx.scale(this._dpr, this._dpr);
      this.oCtx.scale(this._dpr, this._dpr);
      this.width = w;
      this.height = h;
      this.render();
    }

    // 时间戳 -> X 坐标
    timeToX(ts) {
      return LABEL_WIDTH + (ts - this.timeStart) / Utils.HOUR * this.hourWidth - this.scrollX;
    }

    // X 坐标 -> 时间戳
    xToTime(x) {
      return ((x + this.scrollX - LABEL_WIDTH) / this.hourWidth) * Utils.HOUR + this.timeStart;
    }

    // 行索引 -> Y 坐标
    rowToY(rowIndex) {
      return HEADER_HEIGHT + TIME_HEADER_HEIGHT + rowIndex * ROW_HEIGHT - this.scrollY;
    }

    // Y 坐标 -> 行索引
    yToRow(y) {
      return Math.floor((y + this.scrollY - HEADER_HEIGHT - TIME_HEADER_HEIGHT) / ROW_HEIGHT);
    }

    // 获取任务所在行
    getTaskRow(task) {
      switch (this.viewMode) {
        case 'equipment': return this.rows.findIndex(r => r.id === task.equipmentId);
        case 'order': return this.rows.findIndex(r => r.id === task.orderId);
        case 'crew': return this.rows.findIndex(r => r.id === task.crew);
        default: return -1;
      }
    }

    // 缩放
    zoom(delta, centerX) {
      const oldWidth = this.hourWidth;
      this.hourWidth = Math.max(MIN_HOUR_WIDTH, Math.min(MAX_HOUR_WIDTH, this.hourWidth + delta));
      // 保持缩放中心不变
      const ratio = this.hourWidth / oldWidth;
      const offsetFromLabel = centerX - LABEL_WIDTH + this.scrollX;
      this.scrollX = offsetFromLabel * ratio - (centerX - LABEL_WIDTH);
      this.scrollX = Math.max(0, this.scrollX);
      this.render();
    }

    // ---- 主渲染 ----
    render() {
      const ctx = this.ctx;
      const w = this.width;
      const h = this.height;
      if (!w || !h) return;

      ctx.clearRect(0, 0, w, h);

      this._drawBackground(ctx, w, h);
      this._drawShiftBands(ctx, w, h);
      this._drawMaintenanceWindows(ctx, w, h);
      this._drawGrid(ctx, w, h);
      this._drawTasks(ctx, w, h);
      this._drawDependencyArrows(ctx);
      this._drawNowLine(ctx, h);
      this._drawRowLabels(ctx, w, h);
      this._drawTimeHeader(ctx, w);
      this._drawCorner(ctx);
    }

    // 绘制背景
    _drawBackground(ctx, w, h) {
      ctx.fillStyle = '#1a1d23';
      ctx.fillRect(0, 0, w, h);

      // 交替行背景
      for (let i = 0; i < this.rows.length; i++) {
        const y = this.rowToY(i);
        if (y + ROW_HEIGHT < HEADER_HEIGHT + TIME_HEADER_HEIGHT || y > h) continue;
        ctx.fillStyle = i % 2 === 0 ? '#1e2128' : '#22252d';
        ctx.fillRect(LABEL_WIDTH, y, w - LABEL_WIDTH, ROW_HEIGHT);
      }
    }

    // 绘制班次色带
    _drawShiftBands(ctx, w, h) {
      if (!this.shiftWindows || this.shiftWindows.length === 0) return;
      for (const sw of this.shiftWindows) {
        const x1 = this.timeToX(sw.start);
        const x2 = this.timeToX(sw.end);
        if (x2 < LABEL_WIDTH || x1 > w) continue;

        ctx.fillStyle = sw.color || 'rgba(255,255,255,0.02)';
        const top = HEADER_HEIGHT + TIME_HEADER_HEIGHT;
        ctx.fillRect(Math.max(x1, LABEL_WIDTH), top, Math.min(x2, w) - Math.max(x1, LABEL_WIDTH), h - top);
      }
    }

    // 绘制维护窗口
    _drawMaintenanceWindows(ctx, w, h) {
      for (const mw of this.maintenanceWindows) {
        const rowIdx = this.rows.findIndex(r => r.id === mw.equipmentId);
        if (rowIdx < 0) continue;
        const y = this.rowToY(rowIdx);
        if (y + ROW_HEIGHT < HEADER_HEIGHT + TIME_HEADER_HEIGHT || y > h) continue;

        const x1 = Math.max(this.timeToX(mw.start), LABEL_WIDTH);
        const x2 = Math.min(this.timeToX(mw.end), w);
        if (x2 <= x1) continue;

        // 斜线填充
        ctx.save();
        ctx.fillStyle = 'rgba(255,80,80,0.08)';
        ctx.fillRect(x1, y, x2 - x1, ROW_HEIGHT);

        ctx.strokeStyle = 'rgba(255,80,80,0.2)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        const step = 8;
        for (let lx = x1 - ROW_HEIGHT; lx < x2; lx += step) {
          ctx.moveTo(lx, y + ROW_HEIGHT);
          ctx.lineTo(lx + ROW_HEIGHT, y);
        }
        ctx.stroke();
        ctx.restore();
      }
    }

    // 绘制网格
    _drawGrid(ctx, w, h) {
      ctx.strokeStyle = '#2a2d35';
      ctx.lineWidth = 0.5;

      // 水平行线
      for (let i = 0; i <= this.rows.length; i++) {
        const y = this.rowToY(i);
        if (y < HEADER_HEIGHT + TIME_HEADER_HEIGHT || y > h) continue;
        ctx.beginPath();
        ctx.moveTo(LABEL_WIDTH, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }

      // 垂直时间线
      const startHour = Math.floor((this.timeStart + this.scrollX / this.hourWidth * Utils.HOUR) / Utils.HOUR);
      const endHour = Math.ceil((this.timeStart + (w - LABEL_WIDTH + this.scrollX) / this.hourWidth * Utils.HOUR) / Utils.HOUR);

      for (let h_ts = startHour * Utils.HOUR; h_ts <= endHour * Utils.HOUR; h_ts += Utils.HOUR) {
        const x = this.timeToX(h_ts);
        if (x < LABEL_WIDTH || x > w) continue;

        const date = new Date(h_ts);
        const isDay = date.getHours() === 0;

        ctx.strokeStyle = isDay ? '#3a3d45' : '#2a2d35';
        ctx.lineWidth = isDay ? 1 : 0.5;
        ctx.beginPath();
        ctx.moveTo(x, HEADER_HEIGHT + TIME_HEADER_HEIGHT);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
    }

    // 绘制当前时间线
    _drawNowLine(ctx, h) {
      const x = this.timeToX(Date.now());
      if (x < LABEL_WIDTH || x > this.width) return;

      ctx.strokeStyle = '#ff4444';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      ctx.moveTo(x, HEADER_HEIGHT + TIME_HEADER_HEIGHT);
      ctx.lineTo(x, h);
      ctx.stroke();
      ctx.setLineDash([]);

      // 顶部三角
      ctx.fillStyle = '#ff4444';
      ctx.beginPath();
      ctx.moveTo(x - 5, HEADER_HEIGHT + TIME_HEADER_HEIGHT);
      ctx.lineTo(x + 5, HEADER_HEIGHT + TIME_HEADER_HEIGHT);
      ctx.lineTo(x, HEADER_HEIGHT + TIME_HEADER_HEIGHT + 8);
      ctx.fill();
    }

    // 绘制任务条
    _drawTasks(ctx, w, h) {
      const topBound = HEADER_HEIGHT + TIME_HEADER_HEIGHT;

      for (const task of this.tasks) {
        const rowIdx = this.getTaskRow(task);
        if (rowIdx < 0) continue;

        const y = this.rowToY(rowIdx) + TASK_PADDING;
        const taskH = ROW_HEIGHT - TASK_PADDING * 2;

        if (y + taskH < topBound || y > h) continue;

        let x1 = this.timeToX(task.start);
        let x2 = this.timeToX(task.end);

        // 拖拽中的任务位置调整
        if (this.isDragging && this.dragTask && this.dragTask.id === task.id) {
          const dx = this._dragCurrentX - this.dragStartX;
          x1 += dx;
          x2 += dx;
        }

        if (x2 < LABEL_WIDTH || x1 > w) continue;

        const taskW = Math.max(x2 - x1, 4);
        const isConflict = this.conflictTaskIds.has(task.id);
        const isSelected = this.selectedTask && this.selectedTask.id === task.id;
        const isHovered = this.hoveredTask && this.hoveredTask.id === task.id;

        // 任务条主体
        const color = task.color || Utils.orderColor(this._orderIndex(task.orderId));

        ctx.save();

        // 圆角矩形
        this._roundRect(ctx, x1, y, taskW, taskH, TASK_RADIUS);

        // 渐变填充
        const grad = ctx.createLinearGradient(x1, y, x1, y + taskH);
        grad.addColorStop(0, Utils.lighten(color, 0.15));
        grad.addColorStop(1, Utils.darken(color, 0.1));
        ctx.fillStyle = grad;
        ctx.fill();

        // 冲突边框
        if (isConflict) {
          ctx.strokeStyle = '#ff4444';
          ctx.lineWidth = 2;
          ctx.setLineDash([4, 2]);
          ctx.stroke();
          ctx.setLineDash([]);
        } else if (isSelected) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.stroke();
        } else if (isHovered) {
          ctx.strokeStyle = 'rgba(255,255,255,0.6)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        // 锁定标记
        if (task.locked) {
          ctx.fillStyle = 'rgba(0,0,0,0.3)';
          ctx.fillRect(x1, y, 3, taskH);
          ctx.fillRect(x1 + taskW - 3, y, 3, taskH);

          // 锁图标
          const lockX = x1 + 6;
          const lockY = y + 4;
          ctx.fillStyle = '#FFD700';
          ctx.font = '10px sans-serif';
          ctx.fillText('🔒', lockX, lockY + 10);
        }

        // 任务文字
        if (taskW > 40) {
          ctx.fillStyle = '#ffffff';
          ctx.font = 'bold 11px "Segoe UI", sans-serif';
          ctx.textBaseline = 'middle';

          const textX = x1 + (task.locked ? 20 : 6);
          const maxTextW = taskW - (task.locked ? 26 : 12);
          const label = task.processName || task.id;

          ctx.save();
          ctx.beginPath();
          ctx.rect(textX, y, maxTextW, taskH);
          ctx.clip();
          ctx.fillText(label, textX, y + taskH / 2 - 1);

          if (taskW > 100) {
            ctx.font = '10px "Segoe UI", sans-serif';
            ctx.fillStyle = 'rgba(255,255,255,0.7)';
            ctx.fillText(task.orderName || task.orderId, textX, y + taskH / 2 + 11);
          }
          ctx.restore();
        }

        ctx.restore();
      }
    }

    // 绘制依赖箭头
    _drawDependencyArrows(ctx) {
      const taskMap = {};
      for (const t of this.tasks) taskMap[t.processId || t.id] = t;

      for (const dep of this.dependencies) {
        const from = taskMap[dep.from];
        const to = taskMap[dep.to];
        if (!from || !to) continue;

        const fromRow = this.getTaskRow(from);
        const toRow = this.getTaskRow(to);
        if (fromRow < 0 || toRow < 0) continue;

        const fx = this.timeToX(from.end);
        const fy = this.rowToY(fromRow) + ROW_HEIGHT / 2;
        const tx = this.timeToX(to.start);
        const ty = this.rowToY(toRow) + ROW_HEIGHT / 2;

        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(fx, fy);

        if (Math.abs(fromRow - toRow) < 1) {
          ctx.lineTo(tx, ty);
        } else {
          const midX = (fx + tx) / 2;
          ctx.lineTo(midX, fy);
          ctx.lineTo(midX, ty);
          ctx.lineTo(tx, ty);
        }
        ctx.stroke();

        // 箭头
        ctx.fillStyle = 'rgba(255,255,255,0.25)';
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - ARROW_SIZE, ty - ARROW_SIZE / 2);
        ctx.lineTo(tx - ARROW_SIZE, ty + ARROW_SIZE / 2);
        ctx.fill();
      }
    }

    // 绘制行标签
    _drawRowLabels(ctx, w, h) {
      // 标签列背景
      ctx.fillStyle = '#161920';
      ctx.fillRect(0, HEADER_HEIGHT + TIME_HEADER_HEIGHT, LABEL_WIDTH, h - HEADER_HEIGHT - TIME_HEADER_HEIGHT);

      ctx.strokeStyle = '#2a2d35';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(LABEL_WIDTH, HEADER_HEIGHT + TIME_HEADER_HEIGHT);
      ctx.lineTo(LABEL_WIDTH, h);
      ctx.stroke();

      ctx.font = '12px "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';

      for (let i = 0; i < this.rows.length; i++) {
        const y = this.rowToY(i);
        if (y + ROW_HEIGHT < HEADER_HEIGHT + TIME_HEADER_HEIGHT || y > h) continue;

        ctx.fillStyle = '#c0c4cc';
        const label = this.rows[i].label || this.rows[i].id;
        ctx.fillText(label, 12, y + ROW_HEIGHT / 2, LABEL_WIDTH - 20);
      }
    }

    // 绘制时间表头
    _drawTimeHeader(ctx, w) {
      // 日期行背景
      ctx.fillStyle = '#161920';
      ctx.fillRect(LABEL_WIDTH, 0, w - LABEL_WIDTH, HEADER_HEIGHT);

      // 小时行背景
      ctx.fillStyle = '#1a1d25';
      ctx.fillRect(LABEL_WIDTH, HEADER_HEIGHT, w - LABEL_WIDTH, TIME_HEADER_HEIGHT);

      const pxPerHour = this.hourWidth;
      const timeRange = (w - LABEL_WIDTH + this.scrollX) / pxPerHour * Utils.HOUR;

      // 根据缩放级别决定标签间隔
      let hourStep = 1;
      if (pxPerHour < 20) hourStep = 6;
      else if (pxPerHour < 40) hourStep = 3;
      else if (pxPerHour < 60) hourStep = 2;

      const firstHour = Math.floor(this.xToTime(LABEL_WIDTH) / Utils.HOUR) * Utils.HOUR;
      const lastHour = this.xToTime(w);

      let lastDateLabel = '';

      for (let ts = firstHour; ts <= lastHour; ts += Utils.HOUR) {
        const x = this.timeToX(ts);
        if (x < LABEL_WIDTH) continue;

        const date = new Date(ts);
        const hour = date.getHours();

        // 日期标签(每天显示一次)
        const dateStr = `${date.getMonth() + 1}/${date.getDate()}`;
        if (hour === 0 || (dateStr !== lastDateLabel && x > LABEL_WIDTH + 30)) {
          lastDateLabel = dateStr;
          ctx.fillStyle = '#e0e4ec';
          ctx.font = 'bold 12px "Segoe UI", sans-serif';
          ctx.textBaseline = 'bottom';
          const weekDays = ['日', '一', '二', '三', '四', '五', '六'];
          ctx.fillText(`${dateStr} 周${weekDays[date.getDay()]}`, x + 4, HEADER_HEIGHT - 4);

          ctx.strokeStyle = '#4a4d55';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, HEADER_HEIGHT + TIME_HEADER_HEIGHT);
          ctx.stroke();
        }

        // 小时标签
        if (hour % hourStep === 0) {
          ctx.fillStyle = '#8a8e96';
          ctx.font = '10px "Segoe UI", sans-serif';
          ctx.textBaseline = 'middle';
          ctx.fillText(`${String(hour).padStart(2, '0')}:00`, x + 2, HEADER_HEIGHT + TIME_HEADER_HEIGHT / 2);
        }
      }
    }

    // 左上角区域
    _drawCorner(ctx) {
      ctx.fillStyle = '#161920';
      ctx.fillRect(0, 0, LABEL_WIDTH, HEADER_HEIGHT + TIME_HEADER_HEIGHT);

      ctx.fillStyle = '#8a8e96';
      ctx.font = '12px "Segoe UI", sans-serif';
      ctx.textBaseline = 'middle';
      const modeLabels = { equipment: '设备', order: '订单', crew: '班组' };
      ctx.fillText(modeLabels[this.viewMode] || this.viewMode, 12, (HEADER_HEIGHT + TIME_HEADER_HEIGHT) / 2);

      // 边框
      ctx.strokeStyle = '#2a2d35';
      ctx.lineWidth = 1;
      ctx.strokeRect(0, 0, LABEL_WIDTH, HEADER_HEIGHT + TIME_HEADER_HEIGHT);
    }

    // 圆角矩形
    _roundRect(ctx, x, y, w, h, r) {
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + r);
      ctx.lineTo(x + w, y + h - r);
      ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
      ctx.lineTo(x + r, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }

    // 订单颜色索引缓存
    _orderIndex(orderId) {
      if (!this._orderColorMap) this._orderColorMap = {};
      if (this._orderColorMap[orderId] === undefined) {
        this._orderColorMap[orderId] = Object.keys(this._orderColorMap).length;
      }
      return this._orderColorMap[orderId];
    }

    resetOrderColors() {
      this._orderColorMap = {};
    }

    // ---- 拖拽覆盖层渲染 ----
    renderOverlay() {
      const ctx = this.oCtx;
      ctx.clearRect(0, 0, this.width, this.height);

      // 拖拽中的时间指示
      if (this.isDragging && this.dragTask) {
        const dx = this._dragCurrentX - this.dragStartX;
        const newStart = this.dragTask.start + (dx / this.hourWidth) * Utils.HOUR;
        const newEnd = newStart + this.dragTask.duration;

        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.font = '11px "Segoe UI", sans-serif';
        ctx.textBaseline = 'bottom';
        ctx.fillText(
          `${Utils.fmtDateTime(newStart)} → ${Utils.fmtDateTime(newEnd)}`,
          this._dragCurrentX, this.dragStartY - 8
        );
      }
    }

    // ---- 碰撞检测：点击/悬停 ----
    hitTest(x, y) {
      if (x < LABEL_WIDTH || y < HEADER_HEIGHT + TIME_HEADER_HEIGHT) return null;

      for (const task of this.tasks) {
        const rowIdx = this.getTaskRow(task);
        if (rowIdx < 0) continue;

        const ty = this.rowToY(rowIdx) + TASK_PADDING;
        const taskH = ROW_HEIGHT - TASK_PADDING * 2;
        const tx1 = this.timeToX(task.start);
        const tx2 = this.timeToX(task.end);

        if (x >= tx1 && x <= tx2 && y >= ty && y <= ty + taskH) {
          return task;
        }
      }
      return null;
    }

    // 获取甘特图总内容尺寸
    getContentSize() {
      const totalHours = (this.timeEnd - this.timeStart) / Utils.HOUR;
      return {
        width: LABEL_WIDTH + totalHours * this.hourWidth,
        height: HEADER_HEIGHT + TIME_HEADER_HEIGHT + this.rows.length * ROW_HEIGHT
      };
    }

    // 滚动到指定任务
    scrollToTask(taskId) {
      const task = this.tasks.find(t => t.id === taskId);
      if (!task) return;

      const x = this.timeToX(task.start);
      const rowIdx = this.getTaskRow(task);
      if (rowIdx < 0) return;

      this.scrollX = (task.start - this.timeStart) / Utils.HOUR * this.hourWidth - (this.width - LABEL_WIDTH) / 3;
      this.scrollY = rowIdx * ROW_HEIGHT - this.height / 3;
      this.scrollX = Math.max(0, this.scrollX);
      this.scrollY = Math.max(0, this.scrollY);
      this.render();
    }
  }

  return { Gantt, ROW_HEIGHT, HEADER_HEIGHT, TIME_HEADER_HEIGHT, LABEL_WIDTH };
})();
