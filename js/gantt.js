// ========== Gantt Chart Renderer (Canvas) ==========
class GanttChart {
  constructor(container) {
    this.container = container;
    this.headerCanvas = document.getElementById('ganttHeaderCanvas');
    this.canvas = document.getElementById('ganttCanvas');
    this.headerCtx = this.headerCanvas.getContext('2d');
    this.ctx = this.canvas.getContext('2d');
    this.tooltip = document.getElementById('ganttTooltip');

    this.rows = [];
    this.scheduled = [];
    this.maintenanceWindows = [];
    this.viewMode = 'equipment'; // equipment | order | team
    this.zoom = 5; // 1-10, pixels per minute
    this.scrollX = 0;
    this.scrollY = 0;
    this.rowHeight = 36;
    this.headerHeight = 48;
    this.labelWidth = 160;
    this.timeOrigin = 0; // timestamp of leftmost visible pixel
    this.colors = {
      bar: '#6366f1',
      barHover: '#818cf8',
      barDrag: '#a5b4fc',
      barLocked: '#94a3b8',
      barInserted: '#f59e0b',
      barRisk: '#ef4444',
      maintenance: 'rgba(239,68,68,0.15)',
      maintBorder: '#ef4444',
      grid: '#f1f5f9',
      gridMajor: '#e2e8f0',
      nowLine: '#ef4444',
      shiftBg: 'rgba(16,185,129,0.05)',
      rowAlt: '#f8fafc',
      text: '#1a1a2e',
      textLight: '#64748b'
    };

    // Drag state
    this.dragging = null; // { processId, startX, origStart, origEnd }
    this.hoveredBar = null;

    // Callbacks
    this.onDragEnd = null;
    this.onBarClick = null;
    this.onBarDblClick = null;

    this._bindEvents();
  }

  setPixelRatio() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.parentElement.getBoundingClientRect();
    // Calculate total content width based on time range
    const totalMinutes = (this.timeEnd - this.timeStart) / 60000;
    const contentWidth = this.labelWidth + totalMinutes * this.pxPerMin + 60;
    const width = Math.max(contentWidth, rect.width);
    const height = Math.max(this.rows.length * this.rowHeight + 20, rect.height);

    this.canvas.width = width * dpr;
    this.canvas.height = height * dpr;
    this.canvas.style.width = width + 'px';
    this.canvas.style.height = height + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Header canvas - same width
    this.headerCanvas.width = width * dpr;
    this.headerCanvas.height = this.headerHeight * dpr;
    this.headerCanvas.style.width = width + 'px';
    this.headerCanvas.style.height = this.headerHeight + 'px';
    this.headerCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.displayWidth = width;
    this.displayHeight = height;
  }

  get pxPerMin() { return this.zoom * 0.5; }

  render(data) {
    this.scheduled = data.scheduled || [];
    this.maintenanceWindows = data.maintenanceWindows || [];
    this.shifts = data.shifts || [];
    this.orders = data.orders || [];
    this.equipment = data.equipment || [];

    this._buildRows();
    this._calcTimeRange();
    this.setPixelRatio();
    this._drawHeader();
    this._drawBody();
  }

  _buildRows() {
    this.rows = [];
    if (this.viewMode === 'equipment') {
      const byEquip = new Map();
      for (const s of this.scheduled) {
        if (!s.equipmentId) continue;
        if (!byEquip.has(s.equipmentId)) byEquip.set(s.equipmentId, []);
        byEquip.get(s.equipmentId).push(s);
      }
      for (const eq of this.equipment) {
        const tasks = byEquip.get(eq.id) || [];
        tasks.sort((a, b) => (a.scheduledStart || 0) - (b.scheduledStart || 0));
        this.rows.push({
          id: eq.id,
          label: `${eq.name} (${eq.id})`,
          sublabel: eq.type || '',
          tasks
        });
      }
    } else if (this.viewMode === 'order') {
      const byOrder = new Map();
      for (const s of this.scheduled) {
        if (!s.orderId) continue;
        if (!byOrder.has(s.orderId)) byOrder.set(s.orderId, []);
        byOrder.get(s.orderId).push(s);
      }
      for (const order of this.orders) {
        const tasks = (byOrder.get(order.id) || []).sort((a, b) => (a.scheduledStart || 0) - (b.scheduledStart || 0));
        this.rows.push({
          id: order.id,
          label: `${order.id} - ${order.productType}`,
          sublabel: `数量:${order.quantity} 优先级:${order.priority}${order.locked ? ' 🔒' : ''}`,
          tasks
        });
      }
    } else if (this.viewMode === 'team') {
      const byTeam = new Map();
      for (const s of this.scheduled) {
        // Find which shift/team this task falls in
        const taskStart = s.scheduledStart;
        if (!taskStart) continue;
        let teamKey = '未分配';
        for (const shift of this.shifts) {
          const sd = new Date(taskStart);
          const [sh, sm] = shift.startTime.split(':').map(Number);
          const [eh, em] = shift.endTime.split(':').map(Number);
          let matched = false;
          if (shift.crossDay) {
            // Check current day's cross-day shift (e.g. today 22:00 ~ tomorrow 06:00)
            let ss = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate(), sh, sm).getTime();
            let se = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate() + 1, eh, em).getTime();
            if (taskStart >= ss && taskStart < se) matched = true;
            // Check previous day's cross-day shift (e.g. yesterday 22:00 ~ today 06:00)
            if (!matched) {
              ss = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate() - 1, sh, sm).getTime();
              se = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate(), eh, em).getTime();
              if (taskStart >= ss && taskStart < se) matched = true;
            }
          } else {
            const ss = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate(), sh, sm).getTime();
            const se = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate(), eh, em).getTime();
            if (taskStart >= ss && taskStart < se) matched = true;
          }
          if (matched) {
            teamKey = `${shift.team} (${shift.name})`;
            break;
          }
        }
        if (!byTeam.has(teamKey)) byTeam.set(teamKey, []);
        byTeam.get(teamKey).push(s);
      }
      for (const [team, tasks] of byTeam) {
        tasks.sort((a, b) => (a.scheduledStart || 0) - (b.scheduledStart || 0));
        this.rows.push({ id: team, label: team, sublabel: `${tasks.length}个工序`, tasks });
      }
    }
  }

  _calcTimeRange() {
    if (this.scheduled.length === 0) {
      this.timeStart = Date.now() - 86400000;
      this.timeEnd = Date.now() + 86400000 * 7;
      return;
    }
    const starts = this.scheduled.map(s => s.scheduledStart).filter(Boolean);
    const ends = this.scheduled.map(s => s.scheduledEnd).filter(Boolean);
    const minStart = Math.min(...starts, Date.now());
    const maxEnd = Math.max(...ends, Date.now() + 86400000);
    // Add padding
    const range = maxEnd - minStart;
    this.timeStart = minStart - range * 0.05;
    this.timeEnd = maxEnd + range * 0.1;
  }

  timeToX(ts) {
    return this.labelWidth + (ts - this.timeStart) / 60000 * this.pxPerMin;
  }

  xToTime(x) {
    return this.timeStart + (x - this.labelWidth) / this.pxPerMin * 60000;
  }

  _drawHeader() {
    const ctx = this.headerCtx;
    const w = this.displayWidth;
    const h = this.headerHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, w, h);

    // Label column header
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, this.labelWidth, h);
    ctx.strokeStyle = '#e2e8f0';
    ctx.strokeRect(0, 0, this.labelWidth, h);
    ctx.fillStyle = this.colors.text;
    ctx.font = 'bold 12px sans-serif';
    ctx.textBaseline = 'middle';
    const viewLabel = this.viewMode === 'equipment' ? '设备' : this.viewMode === 'order' ? '订单' : '班组';
    ctx.fillText(viewLabel, 12, h / 2);

    // Time axis
    const rangeMs = this.timeEnd - this.timeStart;
    const rangeDays = rangeMs / 86400000;
    let interval; // in ms
    if (rangeDays <= 2) interval = 3600000; // 1 hour
    else if (rangeDays <= 7) interval = 3600000 * 3; // 3 hours
    else if (rangeDays <= 14) interval = 3600000 * 6; // 6 hours
    else if (rangeDays <= 30) interval = 86400000; // 1 day
    else interval = 86400000 * 7; // 1 week

    const startTick = Math.ceil(this.timeStart / interval) * interval;
    ctx.font = '11px sans-serif';
    ctx.textBaseline = 'top';
    for (let t = startTick; t < this.timeEnd; t += interval) {
      const x = this.timeToX(t);
      if (x < this.labelWidth || x > w) continue;

      ctx.strokeStyle = this.colors.gridMajor;
      ctx.beginPath();
      ctx.moveTo(x, h - 14);
      ctx.lineTo(x, h);
      ctx.stroke();

      const d = new Date(t);
      let label;
      if (interval >= 86400000) {
        label = `${d.getMonth() + 1}/${d.getDate()}`;
      } else {
        label = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      }
      ctx.fillStyle = this.colors.textLight;
      ctx.fillText(label, x + 3, h - 28);

      // Date label for hour-level intervals
      if (interval < 86400000 && d.getHours() === 0) {
        ctx.font = 'bold 11px sans-serif';
        ctx.fillText(`${d.getMonth() + 1}/${d.getDate()}`, x + 3, h - 42);
        ctx.font = '11px sans-serif';
      }
    }

    ctx.strokeStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.moveTo(0, h - 0.5);
    ctx.lineTo(w, h - 0.5);
    ctx.stroke();
  }

  _drawBody() {
    const ctx = this.ctx;
    const w = this.displayWidth;
    const h = this.displayHeight;
    ctx.clearRect(0, 0, w, h);

    // Draw rows
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      const y = i * this.rowHeight;

      // Alternating row background
      if (i % 2 === 1) {
        ctx.fillStyle = this.colors.rowAlt;
        ctx.fillRect(0, y, w, this.rowHeight);
      }

      // Row separator
      ctx.strokeStyle = this.colors.grid;
      ctx.beginPath();
      ctx.moveTo(0, y + this.rowHeight - 0.5);
      ctx.lineTo(w, y + this.rowHeight - 0.5);
      ctx.stroke();

      // Label
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, y, this.labelWidth, this.rowHeight);
      ctx.strokeStyle = '#e2e8f0';
      ctx.beginPath();
      ctx.moveTo(this.labelWidth - 0.5, y);
      ctx.lineTo(this.labelWidth - 0.5, y + this.rowHeight);
      ctx.stroke();

      ctx.fillStyle = this.colors.text;
      ctx.font = 'bold 11px sans-serif';
      ctx.textBaseline = 'middle';
      const labelText = row.label.length > 18 ? row.label.slice(0, 18) + '…' : row.label;
      ctx.fillText(labelText, 8, y + this.rowHeight / 2 - 6);
      ctx.fillStyle = this.colors.textLight;
      ctx.font = '10px sans-serif';
      const subText = (row.sublabel || '').slice(0, 22);
      ctx.fillText(subText, 8, y + this.rowHeight / 2 + 8);
    }

    // Draw vertical grid lines (time axis)
    const rangeMs = this.timeEnd - this.timeStart;
    const rangeDays = rangeMs / 86400000;
    let interval;
    if (rangeDays <= 2) interval = 3600000;
    else if (rangeDays <= 7) interval = 3600000 * 3;
    else if (rangeDays <= 14) interval = 3600000 * 6;
    else if (rangeDays <= 30) interval = 86400000;
    else interval = 86400000 * 7;

    const startTick = Math.ceil(this.timeStart / interval) * interval;
    for (let t = startTick; t < this.timeEnd; t += interval) {
      const x = this.timeToX(t);
      if (x < this.labelWidth || x > w) continue;
      ctx.strokeStyle = this.colors.grid;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.rows.length * this.rowHeight);
      ctx.stroke();

      // Day boundary - thicker line
      const d = new Date(t);
      if (d.getHours() === 0 && d.getMinutes() === 0) {
        ctx.strokeStyle = this.colors.gridMajor;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, this.rows.length * this.rowHeight);
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }

    // Draw maintenance windows
    for (const mw of this.maintenanceWindows) {
      const mwStart = new Date(mw.start).getTime();
      const mwEnd = new Date(mw.end).getTime();
      // Find affected rows based on view mode
      const affectedRows = [];
      if (this.viewMode === 'equipment') {
        const idx = this.rows.findIndex(r => r.id === mw.equipmentId);
        if (idx >= 0) affectedRows.push(idx);
      } else {
        // In order/team view, show maintenance on rows containing tasks that use this equipment
        for (let ri = 0; ri < this.rows.length; ri++) {
          if (this.rows[ri].tasks.some(t => t.equipmentId === mw.equipmentId)) {
            affectedRows.push(ri);
          }
        }
      }
      for (const rowIdx of affectedRows) {
        const x1 = Math.max(this.timeToX(mwStart), this.labelWidth);
        const x2 = Math.min(this.timeToX(mwEnd), w);
        if (x2 > this.labelWidth) {
          const y = rowIdx * this.rowHeight;
          ctx.fillStyle = this.colors.maintenance;
          ctx.fillRect(x1, y, x2 - x1, this.rowHeight);
          ctx.strokeStyle = this.colors.maintBorder;
          ctx.setLineDash([4, 3]);
          ctx.strokeRect(x1, y, x2 - x1, this.rowHeight);
          ctx.setLineDash([]);
          ctx.fillStyle = this.colors.maintBorder;
          ctx.font = '9px sans-serif';
          ctx.fillText(`🔧 ${mw.type}`, x1 + 3, y + 12);
        }
      }
    }

    // Draw task bars
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      for (const task of row.tasks) {
        if (!task.scheduledStart || !task.scheduledEnd) continue;
        const x1 = this.timeToX(task.scheduledStart);
        const x2 = this.timeToX(task.scheduledEnd);
        if (x2 < this.labelWidth || x1 > w) continue;

        const barX = Math.max(x1, this.labelWidth);
        const barW = Math.max(x2 - barX, 4);
        const barY = i * this.rowHeight + 6;
        const barH = this.rowHeight - 12;

        // Determine color
        let color = this.colors.bar;
        if (task.locked || (this.orders.find(o => o.id === task.orderId) || {}).locked) {
          color = this.colors.barLocked;
        } else if (task.isInserted) {
          color = this.colors.barInserted;
        }
        if (this.hoveredBar === task.id) color = this.colors.barHover;
        if (this.dragging && this.dragging.processId === task.id) color = this.colors.barDrag;

        // Draw bar with rounded corners
        this._roundRect(ctx, barX, barY, barW, barH, 4, color);

        // Bar border
        ctx.strokeStyle = 'rgba(0,0,0,0.1)';
        ctx.lineWidth = 1;
        this._roundRectStroke(ctx, barX, barY, barW, barH, 4);

        // Progress indicator (inner line)
        if (barW > 20) {
          ctx.fillStyle = 'rgba(255,255,255,0.3)';
          ctx.fillRect(barX + 2, barY + barH - 4, barW - 4, 2);
        }

        // Task label on bar
        if (barW > 50) {
          ctx.fillStyle = '#fff';
          ctx.font = '10px sans-serif';
          ctx.textBaseline = 'middle';
          const text = (task.name || task.id).slice(0, Math.floor(barW / 6));
          ctx.fillText(text, barX + 6, barY + barH / 2);
        }

        // Lock icon
        if (task.locked || (this.orders.find(o => o.id === task.orderId) || {}).locked) {
          ctx.fillStyle = '#fff';
          ctx.font = '10px sans-serif';
          ctx.fillText('🔒', barX + barW - 16, barY + barH / 2);
        }
      }
    }

    // Draw "now" line
    const nowX = this.timeToX(Date.now());
    if (nowX > this.labelWidth && nowX < w) {
      ctx.strokeStyle = this.colors.nowLine;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 3]);
      ctx.beginPath();
      ctx.moveTo(nowX, 0);
      ctx.lineTo(nowX, this.rows.length * this.rowHeight);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;

      // "Now" label
      ctx.fillStyle = this.colors.nowLine;
      ctx.font = 'bold 10px sans-serif';
      ctx.fillText('现在', nowX + 4, 12);
    }

    // Draw dependency arrows
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i];
      for (const task of row.tasks) {
        if (!task.dependencies || !task.scheduledStart) continue;
        for (const depId of task.dependencies) {
          // Find the dependency task (could be in any row)
          let depTask = null, depRowIdx = -1;
          for (let ri = 0; ri < this.rows.length; ri++) {
            depTask = this.rows[ri].tasks.find(t => t.id === depId);
            if (depTask) { depRowIdx = ri; break; }
          }
          if (!depTask || !depTask.scheduledEnd) continue;

          const fromX = this.timeToX(depTask.scheduledEnd);
          const fromY = depRowIdx * this.rowHeight + this.rowHeight / 2;
          const toX = this.timeToX(task.scheduledStart);
          const toY = i * this.rowHeight + this.rowHeight / 2;

          if (fromX < this.labelWidth || toX > w) continue;

          ctx.strokeStyle = 'rgba(99,102,241,0.4)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.moveTo(fromX, fromY);
          ctx.lineTo(toX, toY);
          ctx.stroke();
          // Arrow head
          ctx.beginPath();
          ctx.moveTo(toX, toY);
          ctx.lineTo(toX - 6, toY - 4);
          ctx.lineTo(toX - 6, toY + 4);
          ctx.closePath();
          ctx.fillStyle = 'rgba(99,102,241,0.4)';
          ctx.fill();
          ctx.lineWidth = 1;
        }
      }
    }
  }

  _roundRect(ctx, x, y, w, h, r, fill) {
    ctx.fillStyle = fill;
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
    ctx.fill();
  }

  _roundRectStroke(ctx, x, y, w, h, r) {
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
    ctx.stroke();
  }

  _getBarAtPos(x, y) {
    const rowIdx = Math.floor(y / this.rowHeight);
    if (rowIdx < 0 || rowIdx >= this.rows.length) return null;
    const row = this.rows[rowIdx];
    for (const task of row.tasks) {
      if (!task.scheduledStart || !task.scheduledEnd) continue;
      const x1 = Math.max(this.timeToX(task.scheduledStart), this.labelWidth);
      const x2 = Math.max(this.timeToX(task.scheduledEnd), x1 + 4);
      const barY = rowIdx * this.rowHeight + 6;
      const barH = this.rowHeight - 12;
      if (x >= x1 && x <= x2 && y >= barY && y <= barY + barH) {
        return { task, rowIdx };
      }
    }
    return null;
  }

  _bindEvents() {
    const body = this.canvas.parentElement;

    // Mouse move: hover & drag
    this.canvas.addEventListener('mousemove', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (this.dragging) {
        const timeDelta = (e.clientX - this.dragging.lastClientX) / this.pxPerMin * 60000;
        this.dragging.currentStart = this.dragging.origStart + (x - this.dragging.startX) / this.pxPerMin * 60000;
        this.dragging.currentEnd = this.dragging.origEnd + (x - this.dragging.startX) / this.pxPerMin * 60000;
        // Update visual
        const task = this.scheduled.find(s => s.id === this.dragging.processId);
        if (task) {
          task.scheduledStart = this.dragging.currentStart;
          task.scheduledEnd = this.dragging.currentEnd;
          this._drawBody();
        }
        this.canvas.style.cursor = 'grabbing';
        return;
      }

      const hit = this._getBarAtPos(x, y);
      if (hit) {
        this.hoveredBar = hit.task.id;
        this.canvas.style.cursor = 'grab';
        this._showTooltip(e.clientX, e.clientY, hit.task);
        this._drawBody();
      } else {
        if (this.hoveredBar) {
          this.hoveredBar = null;
          this._drawBody();
        }
        this.canvas.style.cursor = 'default';
        this.tooltip.style.display = 'none';
      }
    });

    this.canvas.addEventListener('mousedown', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = this._getBarAtPos(x, y);
      if (hit) {
        const task = hit.task;
        const order = this.orders.find(o => o.id === task.orderId);
        if (task.locked || (order && order.locked)) {
          this._showStatus('🔒 该订单已锁定，无法拖动');
          return;
        }
        this.dragging = {
          processId: task.id,
          startX: x,
          lastClientX: e.clientX,
          origStart: task.scheduledStart,
          origEnd: task.scheduledEnd,
          currentStart: task.scheduledStart,
          currentEnd: task.scheduledEnd
        };
        this.canvas.style.cursor = 'grabbing';
        e.preventDefault();
      }
    });

    window.addEventListener('mouseup', (e) => {
      if (this.dragging) {
        const task = this.scheduled.find(s => s.id === this.dragging.processId);
        if (task && (this.dragging.currentStart !== this.dragging.origStart)) {
          task.scheduledStart = this.dragging.currentStart;
          task.scheduledEnd = this.dragging.currentEnd;
          if (this.onDragEnd) {
            this.onDragEnd({
              ...task,
              scheduledStart: this.dragging.currentStart,
              scheduledEnd: this.dragging.currentEnd
            });
          }
        }
        this.dragging = null;
        this.canvas.style.cursor = 'default';
        this._drawBody();
      }
    });

    this.canvas.addEventListener('click', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = this._getBarAtPos(x, y);
      if (hit && this.onBarClick) {
        this.onBarClick(hit.task);
      }
    });

    this.canvas.addEventListener('dblclick', (e) => {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const hit = this._getBarAtPos(x, y);
      if (hit && this.onBarDblClick) {
        this.onBarDblClick(hit.task);
      }
    });

    this.canvas.addEventListener('mouseleave', () => {
      this.hoveredBar = null;
      this.tooltip.style.display = 'none';
      this._drawBody();
    });

    // Scroll sync: header follows body scroll
    body.addEventListener('scroll', () => {
      this.headerCanvas.parentElement.scrollLeft = body.scrollLeft;
    });

    // Resize
    window.addEventListener('resize', () => {
      this.setPixelRatio();
      this._drawHeader();
      this._drawBody();
    });
  }

  _showTooltip(clientX, clientY, task) {
    const order = this.orders.find(o => o.id === task.orderId) || {};
    const equip = this.equipment.find(e => e.id === task.equipmentId) || {};
    const start = task.scheduledStart ? new Date(task.scheduledStart).toLocaleString('zh-CN') : '-';
    const end = task.scheduledEnd ? new Date(task.scheduledEnd).toLocaleString('zh-CN') : '-';
    const dur = task.scheduledStart && task.scheduledEnd
      ? Math.round((task.scheduledEnd - task.scheduledStart) / 60000) + ' 分钟' : '-';

    let html = `<div class="tt-title">${task.name || task.id}</div>`;
    html += `<div class="tt-row"><span class="tt-label">订单</span><span>${task.orderId || '-'}</span></div>`;
    html += `<div class="tt-row"><span class="tt-label">设备</span><span>${equip.name || task.equipmentId || '-'}</span></div>`;
    html += `<div class="tt-row"><span class="tt-label">开始</span><span>${start}</span></div>`;
    html += `<div class="tt-row"><span class="tt-label">结束</span><span>${end}</span></div>`;
    html += `<div class="tt-row"><span class="tt-label">时长</span><span>${dur}</span></div>`;
    html += `<div class="tt-row"><span class="tt-label">优先级</span><span>${order.priority || '-'}</span></div>`;
    if (order.locked) html += `<div class="tt-risk">🔒 已锁定</div>`;
    if (task.isInserted) html += `<div class="tt-risk">⚡ 插单工序</div>`;
    if (order.deadline && task.scheduledEnd && task.scheduledEnd > new Date(order.deadline).getTime()) {
      html += `<div class="tt-risk">⚠️ 超出交期</div>`;
    }

    this.tooltip.innerHTML = html;
    this.tooltip.style.display = 'block';

    // Position
    const container = this.canvas.parentElement.parentElement.getBoundingClientRect();
    let tx = clientX - container.left + 16;
    let ty = clientY - container.top - 10;
    if (tx + 260 > container.width) tx = tx - 280;
    if (ty + 200 > container.height) ty = container.height - 210;
    this.tooltip.style.left = tx + 'px';
    this.tooltip.style.top = ty + 'px';
  }

  _showStatus(msg) {
    const el = document.getElementById('statusText');
    if (el) el.textContent = msg;
  }
}
