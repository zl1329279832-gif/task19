// ============================================================
// app.js — 应用主控制器
// ============================================================

const App = (() => {
  // ---- 应用状态 ----
  const state = {
    orders: [],
    processes: [],
    equipment: [],
    shifts: [],
    materials: [],
    routes: [],
    scheduledTasks: [],
    conflicts: [],
    viewMode: 'equipment',   // equipment | order | crew
    selectedTaskId: null,
    isScheduling: false
  };

  let gantt = null;
  let worker = null;
  let history = null;
  let requestId = 0;

  // ---- 初始化 ----
  function init() {
    // 创建 Web Worker
    worker = new Worker('js/scheduler.worker.js');
    worker.onmessage = handleWorkerMessage;
    worker.onerror = (e) => showToast('Worker 错误: ' + e.message, 'error');

    // 创建撤销/重做
    history = new HistoryManager.History();
    history.onChange = updateUndoRedoButtons;

    // 创建甘特图
    const canvas = document.getElementById('gantt-canvas');
    const overlay = document.getElementById('gantt-overlay');
    gantt = new GanttRenderer.Gantt(canvas, overlay);
    gantt.onTaskMove = handleTaskMove;
    gantt.onTaskClick = handleTaskClick;

    // 初始化UI
    gantt.resize();
    bindEvents();
    loadSavedPlans();
    updateStats();

    // 尝试加载上次的数据
    const lastData = localStorage.getItem('scheduler_lastData');
    if (lastData) {
      try {
        const data = JSON.parse(lastData);
        Object.assign(state, data);
        runSchedule();
        showToast('已恢复上次数据', 'info');
      } catch (e) { /* ignore */ }
    }
  }

  // ---- Worker 消息处理 ----
  function handleWorkerMessage(e) {
    const { type, result, message } = e.data;
    switch (type) {
      case 'scheduleResult':
        state.scheduledTasks = result;
        state.isScheduling = false;
        assignTaskColors();
        updateGantt();
        updateStats();
        document.getElementById('schedule-btn').disabled = false;
        document.getElementById('loading-indicator').classList.add('hidden');
        showToast(`排产完成, ${result.length} 道工序已安排`, 'success');
        break;
      case 'conflictsResult':
        state.conflicts = result;
        updateConflictPanel();
        updateGantt();
        break;
      case 'error':
        state.isScheduling = false;
        document.getElementById('schedule-btn').disabled = false;
        document.getElementById('loading-indicator').classList.add('hidden');
        showToast('排产计算错误: ' + message, 'error');
        break;
    }
  }

  // ---- 排产 ----
  function runSchedule() {
    if (state.orders.length === 0 || state.processes.length === 0 || state.equipment.length === 0) {
      showToast('请先导入订单、工序和设备数据', 'warning');
      return;
    }

    state.isScheduling = true;
    document.getElementById('schedule-btn').disabled = true;
    document.getElementById('loading-indicator').classList.remove('hidden');

    // 保存当前状态用于撤销
    const prevSnapshot = Utils.deepClone(state.scheduledTasks);

    worker.postMessage({
      type: 'schedule',
      requestId: ++requestId,
      payload: {
        orders: state.orders,
        processes: state.processes,
        equipment: state.equipment,
        shifts: state.shifts,
        materials: state.materials,
        routes: state.routes,
        config: { startTime: new Date().toISOString() }
      }
    });

    if (prevSnapshot.length > 0) {
      history.push({
        type: 'reschedule',
        description: '重新排产',
        previous: prevSnapshot,
        snapshot: null // 会在收到结果后更新
      });
    }
  }

  // ---- 冲突检测 ----
  function recheckConflicts() {
    if (state.scheduledTasks.length === 0) return;
    worker.postMessage({
      type: 'checkConflicts',
      requestId: ++requestId,
      payload: {
        scheduledTasks: state.scheduledTasks,
        orders: state.orders,
        equipment: state.equipment,
        shifts: state.shifts,
        materials: state.materials,
        processes: state.processes
      }
    });
  }

  // ---- 甘特图更新 ----
  function updateGantt() {
    // 为 crew 视图分配班组
    if (state.viewMode === 'crew') {
      assignCrewToTasks();
    }
    const rows = buildRows();
    const deps = buildDependencies();
    const maintWindows = buildMaintenanceWindows();
    const shiftWindows = buildShiftWindows();
    gantt.viewMode = state.viewMode;
    gantt.setData(state.scheduledTasks, rows, state.conflicts, deps, maintWindows, shiftWindows);
  }

  function assignCrewToTasks() {
    for (const task of state.scheduledTasks) {
      task.crew = '默认班组';
      for (const shift of state.shifts) {
        const startOff = Utils.hmToOffset(shift.startTime);
        const endOff = Utils.hmToOffset(shift.endTime);
        const crossDay = endOff <= startOff;
        const taskDate = new Date(task.start);
        const taskOff = taskDate.getHours() * Utils.HOUR + taskDate.getMinutes() * Utils.MINUTE;

        let inShift = false;
        if (crossDay) {
          inShift = taskOff >= startOff || taskOff < endOff;
        } else {
          inShift = taskOff >= startOff && taskOff < endOff;
        }
        if (inShift && shift.crew) {
          task.crew = shift.crew;
          break;
        }
      }
    }
  }

  function buildRows() {
    switch (state.viewMode) {
      case 'equipment':
        return state.equipment.map(e => ({ id: e.id, label: e.name, type: 'equipment' }));
      case 'order':
        return state.orders.map(o => ({
          id: o.id,
          label: (o.locked ? '🔒 ' : '') + o.name,
          type: 'order'
        }));
      case 'crew': {
        const crews = new Set();
        state.shifts.forEach(s => { if (s.crew) crews.add(s.crew); });
        if (crews.size === 0) crews.add('默认班组');
        return [...crews].map(c => ({ id: c, label: c, type: 'crew' }));
      }
      default: return [];
    }
  }

  function buildDependencies() {
    const deps = [];
    for (const p of state.processes) {
      if (p.dependencies) {
        for (const depId of p.dependencies) {
          deps.push({ from: depId, to: p.id });
        }
      }
    }
    return deps;
  }

  function buildMaintenanceWindows() {
    const windows = [];
    for (const eq of state.equipment) {
      if (eq.maintenance) {
        for (const m of eq.maintenance) {
          const start = typeof m.start === 'number' ? m.start : new Date(m.start).getTime();
          const end = typeof m.end === 'number' ? m.end : new Date(m.end).getTime();
          if (!isNaN(start) && !isNaN(end)) {
            windows.push({ equipmentId: eq.id, start, end, reason: m.reason });
          }
        }
      }
    }
    return windows;
  }

  function buildShiftWindows() {
    if (state.shifts.length === 0 || state.scheduledTasks.length === 0) return [];
    const rangeStart = Math.min(...state.scheduledTasks.map(t => t.start));
    const rangeEnd = Math.max(...state.scheduledTasks.map(t => t.end));
    const windows = [];
    const shiftColors = ['rgba(65,105,225,0.04)', 'rgba(50,205,50,0.04)', 'rgba(255,165,0,0.04)'];
    state.shifts.forEach((s, i) => {
      const expanded = Utils.expandShiftWindows(s, rangeStart, rangeEnd);
      expanded.forEach(w => {
        windows.push({ ...w, color: shiftColors[i % shiftColors.length], shiftName: s.name });
      });
    });
    return windows;
  }

  function assignTaskColors() {
    const orderColorMap = {};
    let colorIdx = 0;
    for (const t of state.scheduledTasks) {
      if (!orderColorMap[t.orderId]) {
        orderColorMap[t.orderId] = Utils.orderColor(colorIdx++);
      }
      t.color = orderColorMap[t.orderId];
    }
  }

  // ---- 拖拽处理 ----
  function handleTaskMove(taskId, newStartTs) {
    const task = state.scheduledTasks.find(t => t.id === taskId);
    if (!task) return;
    if (task.locked) {
      showToast('该工序已锁定, 无法移动', 'warning');
      return;
    }

    const prevSnapshot = Utils.deepClone(state.scheduledTasks);
    const duration = task.end - task.start;

    // 时间对齐到30分钟
    const aligned = Math.round(newStartTs / (30 * Utils.MINUTE)) * (30 * Utils.MINUTE);
    task.start = aligned;
    task.end = aligned + duration;

    history.push({
      type: 'move',
      description: `移动工序 "${task.processName}"`,
      previous: prevSnapshot,
      snapshot: Utils.deepClone(state.scheduledTasks)
    });

    recheckConflicts();
    updateGantt();
  }

  function handleTaskClick(task) {
    state.selectedTaskId = task ? task.id : null;
    gantt.selectedTask = task;
    updateDetailPanel(task);
    gantt.render();
  }

  // ---- 视图切换 ----
  function switchView(mode) {
    state.viewMode = mode;
    document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
    const activeBtn = document.querySelector(`[data-view="${mode}"]`);
    if (activeBtn) activeBtn.classList.add('active');
    updateGantt();
  }

  // ---- 锁定/解锁 ----
  function toggleLock(orderId) {
    const order = state.orders.find(o => o.id === orderId);
    if (!order) return;

    const prevSnapshot = Utils.deepClone(state.scheduledTasks);
    order.locked = !order.locked;

    // 更新排产任务的锁定状态
    state.scheduledTasks.forEach(t => {
      if (t.orderId === orderId) t.locked = order.locked;
    });

    history.push({
      type: 'lock',
      description: `${order.locked ? '锁定' : '解锁'}订单 "${order.name}"`,
      previous: prevSnapshot,
      snapshot: Utils.deepClone(state.scheduledTasks)
    });

    updateGantt();
    updateOrderList();
    showToast(`订单 "${order.name}" 已${order.locked ? '锁定' : '解锁'}`, 'info');
  }

  // ---- 撤销/重做 ----
  function undo() {
    const action = history.undo();
    if (action && action.previous) {
      state.scheduledTasks = Utils.deepClone(action.previous);
      recheckConflicts();
      updateGantt();
      showToast(`已撤销: ${action.description}`, 'info');
    }
  }

  function redo() {
    const action = history.redo();
    if (action && action.snapshot) {
      state.scheduledTasks = Utils.deepClone(action.snapshot);
      recheckConflicts();
      updateGantt();
      showToast(`已重做: ${action.description}`, 'info');
    }
  }

  function updateUndoRedoButtons(canUndo, canRedo) {
    const undoBtn = document.getElementById('undo-btn');
    const redoBtn = document.getElementById('redo-btn');
    if (undoBtn) {
      undoBtn.disabled = !canUndo;
      undoBtn.title = canUndo ? `撤销: ${history.lastUndoDesc()}` : '撤销';
    }
    if (redoBtn) {
      redoBtn.disabled = !canRedo;
      redoBtn.title = canRedo ? `重做: ${history.lastRedoDesc()}` : '重做';
    }
  }

  // ---- 数据导入 ----
  function importFile(fileType) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,.json';
    if (fileType === 'all') input.accept = '.json';
    input.onchange = (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        const text = evt.target.result;
        try {
          let data;
          if (file.name.endsWith('.json')) {
            data = JSON.parse(text);
            if (fileType === 'all') {
              // 整体导入: 对象则按键分发, 数组则猜测类型
              if (Array.isArray(data)) {
                showToast('整体导入请使用包含 orders/processes/equipment 等键的 JSON 对象', 'warning');
                return;
              }
              importDataObject(data);
            } else if (Array.isArray(data)) {
              importDataArray(fileType, data);
            } else {
              importDataObject(data);
            }
          } else {
            if (fileType === 'all') {
              showToast('CSV 只能按类型分项导入', 'warning');
              return;
            }
            data = Utils.parseCSV(text);
            importDataArray(fileType, data);
          }
          saveDataToLocal();
          showToast(`成功导入 ${file.name}`, 'success');
        } catch (err) {
          showToast(`导入失败: ${err.message}`, 'error');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  }

  function importDataArray(type, data) {
    switch (type) {
      case 'orders':
        state.orders = data.map(o => ({
          id: o.id || Utils.genId('O'),
          name: o.name || o.orderName || o.id,
          dueDate: o.dueDate || o.due_date || null,
          priority: parseInt(o.priority) || 0,
          locked: o.locked === true || o.locked === 'true',
          quantity: parseInt(o.quantity) || 1,
          customer: o.customer || ''
        }));
        updateOrderList();
        break;
      case 'processes':
        state.processes = data.map(p => ({
          id: p.id || Utils.genId('P'),
          orderId: p.orderId || p.order_id,
          name: p.name || p.processName || p.id,
          equipmentId: p.equipmentId || p.equipment_id,
          duration: parseFloat(p.duration) || 1,
          sequence: parseInt(p.sequence) || 0,
          dependencies: p.dependencies ? (typeof p.dependencies === 'string' ? p.dependencies.split(';').filter(Boolean) : p.dependencies) : [],
          fixedStart: p.fixedStart || p.fixed_start || null
        }));
        break;
      case 'equipment':
        state.equipment = data.map(e => ({
          id: e.id || Utils.genId('E'),
          name: e.name || e.equipmentName || e.id,
          type: e.type || '',
          capacity: parseInt(e.capacity) || 1,
          maintenance: e.maintenance || []
        }));
        break;
      case 'shifts':
        state.shifts = data.map(s => ({
          id: s.id || Utils.genId('S'),
          name: s.name || s.shiftName || s.id,
          startTime: s.startTime || s.start_time || '08:00',
          endTime: s.endTime || s.end_time || '16:00',
          crew: s.crew || s.team || '',
          equipmentIds: s.equipmentIds ? (typeof s.equipmentIds === 'string' ? s.equipmentIds.split(';') : s.equipmentIds) : []
        }));
        break;
      case 'materials':
        state.materials = data.map(m => ({
          id: m.id || Utils.genId('M'),
          name: m.name || m.materialName || m.id,
          processId: m.processId || m.process_id,
          arrivalTime: m.arrivalTime || m.arrival_time,
          quantity: parseInt(m.quantity) || 1
        }));
        break;
      case 'routes':
        state.routes = data.map(r => ({
          orderId: r.orderId || r.order_id,
          steps: r.steps ? (typeof r.steps === 'string' ? r.steps.split(';') : r.steps) : []
        }));
        break;
    }
    updateDataSummary();
  }

  function importDataObject(data) {
    if (data.orders) importDataArray('orders', data.orders);
    if (data.processes) importDataArray('processes', data.processes);
    if (data.equipment) importDataArray('equipment', data.equipment);
    if (data.shifts) importDataArray('shifts', data.shifts);
    if (data.materials) importDataArray('materials', data.materials);
    if (data.routes) importDataArray('routes', data.routes);
  }

  // ---- 一键导入示例数据 ----
  function loadSampleData() {
    fetch('sample/data.json')
      .then(r => r.json())
      .then(data => {
        importDataObject(data);
        saveDataToLocal();
        showToast('示例数据已加载', 'success');
      })
      .catch(() => showToast('加载示例数据失败', 'error'));
  }

  // ---- 导出 ----
  function exportSchedule() {
    if (state.scheduledTasks.length === 0) {
      showToast('暂无排产数据可导出', 'warning');
      return;
    }
    const csv = Utils.scheduleToCSV(state.scheduledTasks);
    Utils.downloadFile(csv, `排产表_${Utils.fmtDate(Date.now())}.csv`, 'text/csv');
    showToast('排产表已导出', 'success');
  }

  function exportRiskReport() {
    const report = Utils.riskReportToText(state.conflicts);
    Utils.downloadFile(report, `风险报告_${Utils.fmtDate(Date.now())}.txt`, 'text/plain');
    showToast('风险报告已导出', 'success');
  }

  // ---- 保存/加载排产方案 ----
  function savePlan() {
    const name = prompt('请输入方案名称:', `方案_${Utils.fmtDate(Date.now())}`);
    if (!name) return;

    const plans = JSON.parse(localStorage.getItem('scheduler_plans') || '[]');
    plans.push({
      name,
      timestamp: Date.now(),
      data: {
        orders: state.orders,
        processes: state.processes,
        equipment: state.equipment,
        shifts: state.shifts,
        materials: state.materials,
        routes: state.routes,
        scheduledTasks: state.scheduledTasks
      }
    });
    localStorage.setItem('scheduler_plans', JSON.stringify(plans));
    loadSavedPlans();
    showToast(`方案 "${name}" 已保存`, 'success');
  }

  function loadPlan(index) {
    const plans = JSON.parse(localStorage.getItem('scheduler_plans') || '[]');
    if (index < 0 || index >= plans.length) return;

    const plan = plans[index];
    Object.assign(state, plan.data);
    assignTaskColors();
    recheckConflicts();
    updateGantt();
    updateOrderList();
    updateDataSummary();
    updateStats();
    showToast(`方案 "${plan.name}" 已加载`, 'success');
  }

  function deletePlan(index) {
    const plans = JSON.parse(localStorage.getItem('scheduler_plans') || '[]');
    if (index < 0 || index >= plans.length) return;
    const name = plans[index].name;
    plans.splice(index, 1);
    localStorage.setItem('scheduler_plans', JSON.stringify(plans));
    loadSavedPlans();
    showToast(`方案 "${name}" 已删除`, 'info');
  }

  function loadSavedPlans() {
    const list = document.getElementById('plan-list');
    if (!list) return;
    const plans = JSON.parse(localStorage.getItem('scheduler_plans') || '[]');

    if (plans.length === 0) {
      list.innerHTML = '<div class="empty-hint">暂无保存的方案</div>';
      return;
    }

    list.innerHTML = plans.map((p, i) => `
      <div class="plan-item">
        <div class="plan-info">
          <span class="plan-name">${p.name}</span>
          <span class="plan-time">${Utils.fmtDateTime(p.timestamp)}</span>
        </div>
        <div class="plan-actions">
          <button class="btn-sm" onclick="App.loadPlan(${i})" title="加载">&#9654;</button>
          <button class="btn-sm btn-danger" onclick="App.deletePlan(${i})" title="删除">&times;</button>
        </div>
      </div>
    `).join('');
  }

  function saveDataToLocal() {
    localStorage.setItem('scheduler_lastData', JSON.stringify({
      orders: state.orders,
      processes: state.processes,
      equipment: state.equipment,
      shifts: state.shifts,
      materials: state.materials,
      routes: state.routes
    }));
  }

  // ---- 插单 ----
  function rushInsert() {
    if (state.scheduledTasks.length === 0) {
      showToast('请先排产后再进行插单', 'warning');
      return;
    }
    const name = prompt('请输入插单订单名称:');
    if (!name) return;

    const newOrder = {
      id: Utils.genId('O'),
      name: name,
      priority: 999,
      locked: false,
      dueDate: new Date(Date.now() + 3 * Utils.DAY).toISOString()
    };

    // 为新订单创建一些默认工序
    const eqIds = state.equipment.map(e => e.id);
    const newProcesses = [{
      id: Utils.genId('P'),
      orderId: newOrder.id,
      name: name + '-工序1',
      equipmentId: eqIds[0] || 'E1',
      duration: 2,
      sequence: 1,
      dependencies: []
    }];

    const prevSnapshot = Utils.deepClone(state.scheduledTasks);

    state.orders.push(newOrder);
    state.processes.push(...newProcesses);

    worker.postMessage({
      type: 'rushInsert',
      requestId: ++requestId,
      payload: {
        scheduledTasks: state.scheduledTasks,
        newOrder,
        newProcesses,
        equipment: state.equipment,
        shifts: state.shifts,
        materials: state.materials,
        routes: state.routes,
        orders: state.orders,
        processes: state.processes
      }
    });

    history.push({
      type: 'rushInsert',
      description: `插单 "${name}"`,
      previous: prevSnapshot,
      snapshot: null
    });

    updateOrderList();
    document.getElementById('loading-indicator').classList.remove('hidden');
  }

  // ---- UI 更新 ----
  function updateConflictPanel() {
    const panel = document.getElementById('conflict-list');
    if (!panel) return;

    const badge = document.getElementById('conflict-count');
    if (badge) {
      badge.textContent = state.conflicts.length;
      badge.className = 'badge ' + (state.conflicts.length > 0 ? (state.conflicts.some(c => c.severity === 'error') ? 'badge-error' : 'badge-warning') : 'badge-ok');
    }

    if (state.conflicts.length === 0) {
      panel.innerHTML = '<div class="empty-hint success-hint">没有发现风险项</div>';
      return;
    }

    const icons = {
      'equipment_conflict': '⚠',
      'material_not_ready': '📦',
      'deadline_risk': '⏰',
      'changeover_excess': '🔄',
      'shift_overload': '💪',
      'dependency_violation': '🔗',
      'maintenance_conflict': '🔧'
    };

    panel.innerHTML = state.conflicts.map((c, i) => `
      <div class="conflict-item conflict-${c.severity}" data-idx="${i}">
        <span class="conflict-icon">${icons[c.type] || '!'}</span>
        <span class="conflict-msg">${c.message}</span>
      </div>
    `).join('');

    // 点击冲突项定位到相关任务
    panel.querySelectorAll('.conflict-item').forEach(el => {
      el.addEventListener('click', () => {
        const idx = parseInt(el.dataset.idx);
        const conflict = state.conflicts[idx];
        if (conflict && conflict.taskIds && conflict.taskIds.length > 0) {
          gantt.scrollToTask(conflict.taskIds[0]);
          const task = state.scheduledTasks.find(t => t.id === conflict.taskIds[0]);
          if (task) handleTaskClick(task);
        }
      });
    });
  }

  function updateDetailPanel(task) {
    const panel = document.getElementById('detail-panel');
    if (!panel) return;

    if (!task) {
      panel.innerHTML = '<div class="empty-hint">点击工序查看详情</div>';
      return;
    }

    const order = state.orders.find(o => o.id === task.orderId);
    const relatedConflicts = state.conflicts.filter(c => c.taskIds && c.taskIds.includes(task.id));

    panel.innerHTML = `
      <div class="detail-section">
        <h4>${task.processName || task.id}</h4>
        <div class="detail-row"><span>订单:</span><span>${task.orderName || task.orderId}</span></div>
        <div class="detail-row"><span>设备:</span><span>${task.equipmentName || task.equipmentId}</span></div>
        <div class="detail-row"><span>开始:</span><span>${Utils.fmtDateTime(task.start)}</span></div>
        <div class="detail-row"><span>结束:</span><span>${Utils.fmtDateTime(task.end)}</span></div>
        <div class="detail-row"><span>时长:</span><span>${Utils.fmtDuration(task.end - task.start)}</span></div>
        <div class="detail-row"><span>状态:</span><span>${task.locked ? '🔒 已锁定' : '可调整'}</span></div>
        ${order && order.dueDate ? `<div class="detail-row"><span>交期:</span><span>${Utils.fmtDate(new Date(order.dueDate).getTime())}</span></div>` : ''}
      </div>
      ${relatedConflicts.length > 0 ? `
        <div class="detail-section">
          <h4>相关风险 (${relatedConflicts.length})</h4>
          ${relatedConflicts.map(c => `<div class="conflict-item conflict-${c.severity}" style="margin:4px 0">${c.message}</div>`).join('')}
        </div>
      ` : ''}
      <div class="detail-actions">
        ${!task.locked ? `<button class="btn btn-sm" onclick="App.toggleLock('${task.orderId}')">锁定该订单</button>` : `<button class="btn btn-sm" onclick="App.toggleLock('${task.orderId}')">解锁该订单</button>`}
      </div>
    `;
  }

  function updateOrderList() {
    const list = document.getElementById('order-list');
    if (!list) return;

    if (state.orders.length === 0) {
      list.innerHTML = '<div class="empty-hint">暂无订单数据</div>';
      return;
    }

    list.innerHTML = state.orders.map(o => `
      <div class="order-item ${o.locked ? 'locked' : ''}" data-id="${o.id}">
        <div class="order-info">
          <span class="order-name">${o.locked ? '🔒 ' : ''}${o.name}</span>
          ${o.dueDate ? `<span class="order-due">交期: ${Utils.fmtDate(new Date(o.dueDate).getTime())}</span>` : ''}
        </div>
        <div class="order-actions">
          <button class="btn-sm" onclick="App.toggleLock('${o.id}')" title="${o.locked ? '解锁' : '锁定'}">${o.locked ? '🔓' : '🔒'}</button>
        </div>
      </div>
    `).join('');
  }

  function updateDataSummary() {
    const el = document.getElementById('data-summary');
    if (!el) return;
    el.innerHTML = `
      <span class="summary-item">订单 <b>${state.orders.length}</b></span>
      <span class="summary-item">工序 <b>${state.processes.length}</b></span>
      <span class="summary-item">设备 <b>${state.equipment.length}</b></span>
      <span class="summary-item">班次 <b>${state.shifts.length}</b></span>
    `;
  }

  function updateStats() {
    const el = document.getElementById('stats-bar');
    if (!el) return;

    if (state.scheduledTasks.length === 0) {
      el.innerHTML = '<span class="stat">暂无排产数据</span>';
      return;
    }

    const totalTasks = state.scheduledTasks.length;
    const conflicts = state.conflicts.length;
    const minStart = Math.min(...state.scheduledTasks.map(t => t.start));
    const maxEnd = Math.max(...state.scheduledTasks.map(t => t.end));
    const span = Utils.fmtDuration(maxEnd - minStart);

    el.innerHTML = `
      <span class="stat">工序: <b>${totalTasks}</b></span>
      <span class="stat">周期: <b>${span}</b></span>
      <span class="stat ${conflicts > 0 ? 'stat-warn' : ''}">风险: <b>${conflicts}</b></span>
    `;
  }

  // ---- 事件绑定 ----
  function bindEvents() {
    // 按钮
    document.getElementById('schedule-btn')?.addEventListener('click', runSchedule);
    document.getElementById('undo-btn')?.addEventListener('click', undo);
    document.getElementById('redo-btn')?.addEventListener('click', redo);
    document.getElementById('export-schedule-btn')?.addEventListener('click', exportSchedule);
    document.getElementById('export-risk-btn')?.addEventListener('click', exportRiskReport);
    document.getElementById('save-plan-btn')?.addEventListener('click', savePlan);
    document.getElementById('rush-btn')?.addEventListener('click', rushInsert);
    document.getElementById('load-sample-btn')?.addEventListener('click', loadSampleData);

    // 导入按钮
    document.querySelectorAll('[data-import]').forEach(btn => {
      btn.addEventListener('click', () => importFile(btn.dataset.import));
    });

    // 视图切换
    document.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    // 缩放
    document.getElementById('zoom-in-btn')?.addEventListener('click', () => gantt.zoom(10, gantt.width / 2));
    document.getElementById('zoom-out-btn')?.addEventListener('click', () => gantt.zoom(-10, gantt.width / 2));

    // Canvas 交互
    const overlay = document.getElementById('gantt-overlay');
    if (overlay) {
      let isPanning = false;
      let panStartX = 0, panStartY = 0;

      overlay.addEventListener('mousedown', (e) => {
        const rect = overlay.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const task = gantt.hitTest(x, y);

        if (task && !e.ctrlKey) {
          // 开始拖拽任务
          if (task.locked) {
            handleTaskClick(task);
            return;
          }
          gantt.dragTask = task;
          gantt.dragStartX = x;
          gantt.dragStartY = y;
          gantt._dragCurrentX = x;
          gantt.isDragging = false;
          handleTaskClick(task);
        } else {
          // 开始平移
          isPanning = true;
          panStartX = e.clientX + gantt.scrollX;
          panStartY = e.clientY + gantt.scrollY;
          overlay.style.cursor = 'grabbing';
        }
      });

      overlay.addEventListener('mousemove', (e) => {
        const rect = overlay.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        if (gantt.dragTask) {
          if (!gantt.isDragging && Math.abs(x - gantt.dragStartX) > 4) {
            gantt.isDragging = true;
          }
          if (gantt.isDragging) {
            gantt._dragCurrentX = x;
            gantt.render();
            gantt.renderOverlay();
          }
        } else if (isPanning) {
          gantt.scrollX = Math.max(0, panStartX - e.clientX);
          gantt.scrollY = Math.max(0, panStartY - e.clientY);
          gantt.render();
        } else {
          // 悬停检测
          const task = gantt.hitTest(x, y);
          if (task !== gantt.hoveredTask) {
            gantt.hoveredTask = task;
            overlay.style.cursor = task ? (task.locked ? 'not-allowed' : 'grab') : 'default';
            gantt.render();
            showTooltip(task, e.clientX, e.clientY);
          }
        }
      });

      overlay.addEventListener('mouseup', (e) => {
        if (gantt.isDragging && gantt.dragTask) {
          const rect = overlay.getBoundingClientRect();
          const x = e.clientX - rect.left;
          const dx = x - gantt.dragStartX;
          const timeDelta = (dx / gantt.hourWidth) * Utils.HOUR;
          const newStart = gantt.dragTask.start + timeDelta;
          handleTaskMove(gantt.dragTask.id, newStart);
        }
        gantt.dragTask = null;
        gantt.isDragging = false;
        isPanning = false;
        overlay.style.cursor = 'default';
        gantt.oCtx.clearRect(0, 0, gantt.width, gantt.height);
        gantt.render();
      });

      overlay.addEventListener('mouseleave', () => {
        if (isPanning) isPanning = false;
        if (gantt.isDragging) {
          gantt.dragTask = null;
          gantt.isDragging = false;
          gantt.render();
        }
        gantt.hoveredTask = null;
        gantt.render();
        hideTooltip();
      });

      // 滚轮缩放
      overlay.addEventListener('wheel', (e) => {
        e.preventDefault();
        if (e.ctrlKey) {
          const rect = overlay.getBoundingClientRect();
          gantt.zoom(-e.deltaY * 0.1, e.clientX - rect.left);
        } else {
          gantt.scrollX = Math.max(0, gantt.scrollX + e.deltaX);
          gantt.scrollY = Math.max(0, gantt.scrollY + e.deltaY);
          gantt.render();
        }
      }, { passive: false });
    }

    // 键盘快捷键
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(); }
      if (e.ctrlKey && e.key === 'y') { e.preventDefault(); redo(); }
      if (e.key === 'Escape') { handleTaskClick(null); }
      if (e.key === 'Delete' && state.selectedTaskId) {
        // 可选：删除选中任务
      }
    });

    // 窗口调整
    window.addEventListener('resize', () => gantt.resize());

    // 侧栏折叠
    document.getElementById('toggle-sidebar')?.addEventListener('click', () => {
      document.getElementById('sidebar')?.classList.toggle('collapsed');
      setTimeout(() => gantt.resize(), 300);
    });

    // 选项卡切换
    document.querySelectorAll('.tab-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const target = btn.dataset.tab;
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(`tab-${target}`)?.classList.add('active');
      });
    });

    // 全屏JSON导入
    document.getElementById('import-all-btn')?.addEventListener('click', () => {
      importFile('all');
    });
  }

  // ---- 提示气泡 ----
  function showTooltip(task, x, y) {
    let tip = document.getElementById('gantt-tooltip');
    if (!task) { hideTooltip(); return; }

    if (!tip) {
      tip = document.createElement('div');
      tip.id = 'gantt-tooltip';
      tip.className = 'tooltip';
      document.body.appendChild(tip);
    }

    const order = state.orders.find(o => o.id === task.orderId);
    tip.innerHTML = `
      <div><b>${task.processName}</b></div>
      <div>订单: ${task.orderName || task.orderId}</div>
      <div>设备: ${task.equipmentName || task.equipmentId}</div>
      <div>${Utils.fmtDateTime(task.start)} ~ ${Utils.fmtDateTime(task.end)}</div>
      <div>时长: ${Utils.fmtDuration(task.end - task.start)}</div>
      ${task.locked ? '<div style="color:#FFD700">🔒 已锁定</div>' : ''}
    `;
    tip.style.display = 'block';
    tip.style.left = (x + 12) + 'px';
    tip.style.top = (y + 12) + 'px';
  }

  function hideTooltip() {
    const tip = document.getElementById('gantt-tooltip');
    if (tip) tip.style.display = 'none';
  }

  // ---- Toast 通知 ----
  function showToast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = msg;
    container.appendChild(toast);

    requestAnimationFrame(() => toast.classList.add('show'));
    setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ---- 公开 API ----
  return {
    init, runSchedule, switchView, toggleLock,
    undo, redo, importFile, loadSampleData,
    exportSchedule, exportRiskReport,
    savePlan, loadPlan, deletePlan, rushInsert,
    state, showToast
  };
})();

// 启动
document.addEventListener('DOMContentLoaded', App.init);
