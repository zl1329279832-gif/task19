// ========== Main Application Controller ==========
(function () {
  'use strict';

  // ========== State ==========
  const state = {
    orders: [],
    processes: [],
    equipment: [],
    shifts: [],
    materials: [],
    routes: [],
    maintenanceWindows: [],
    scheduled: [],
    alerts: [],
    risks: [],
    viewMode: 'equipment',
    zoom: 5
  };

  // ========== Web Worker ==========
  let worker = null;
  let currentRequestVersion = 0;

  function initWorker() {
    if (worker) worker.terminate();
    worker = new Worker('js/worker.js');
    worker.onmessage = handleWorkerMessage;
    worker.onerror = (e) => {
      console.error('Worker error:', e);
      setStatus('排产计算出错，请检查数据');
    };
  }

  function handleWorkerMessage(e) {
    const { action, data, requestVersion } = e.data;
    // Discard stale responses: only accept results matching the latest request
    if (requestVersion !== undefined && requestVersion !== currentRequestVersion) return;
    switch (action) {
      case 'autoScheduleResult':
        state.scheduled = data.scheduled;
        state.alerts = data.alerts;
        history.push(state.scheduled);
        onScheduleUpdated();
        setStatus(`自动排产完成：${data.scheduled.length} 个工序已排程`);
        break;
      case 'conflictResult':
        state.alerts = data;
        renderAlerts();
        break;
      case 'riskResult':
        state.risks = data;
        renderAlerts();
        setStatus(`风险分析完成：${data.length} 项风险`);
        break;
      case 'insertResult':
        state.scheduled = data.scheduled;
        state.alerts = data.alerts;
        history.push(state.scheduled);
        onScheduleUpdated();
        setStatus('插单排产完成');
        break;
      case 'recalcResult':
        state.scheduled = data.updated;
        state.alerts = data.alerts;
        history.push(state.scheduled);
        onScheduleUpdated();
        if (data.cascadeUpdates && data.cascadeUpdates.length > 0) {
          setStatus(`拖拽完成，${data.cascadeUpdates.length} 个后续工序已联动调整`);
        } else {
          setStatus('拖拽调整完成');
        }
        break;
    }
  }

  function sendToWorker(action, extraData) {
    currentRequestVersion++;
    worker.postMessage({
      action,
      data: { ...state, ...extraData },
      requestVersion: currentRequestVersion
    });
  }

  // ========== History ==========
  const history = new HistoryManager(50);
  history.onchange = (canUndo, canRedo) => {
    document.getElementById('btnUndo').disabled = !canUndo;
    document.getElementById('btnRedo').disabled = !canRedo;
  };

  // ========== Gantt ==========
  const gantt = new GanttChart(document.getElementById('ganttContainer'));

  gantt.onDragEnd = (movedProcess) => {
    sendToWorker('recalcAfterDrag', {
      movedProcess,
      allScheduled: state.scheduled
    });
  };

  gantt.onBarClick = (task) => {
    showProcessDetail(task);
  };

  gantt.onBarDblClick = (task) => {
    // Toggle lock
    const order = state.orders.find(o => o.id === task.orderId);
    if (order) {
      order.locked = !order.locked;
      task.locked = order.locked;
      renderGantt();
      setStatus(order.locked ? `订单 ${order.id} 已锁定` : `订单 ${order.id} 已解锁`);
    }
  };

  // ========== Rendering ==========
  function renderGantt() {
    gantt.viewMode = state.viewMode;
    gantt.zoom = state.zoom;
    gantt.render({
      scheduled: state.scheduled,
      maintenanceWindows: state.maintenanceWindows,
      shifts: state.shifts,
      orders: state.orders,
      equipment: state.equipment
    });
    document.getElementById('ganttEmpty').classList.toggle('hidden', state.scheduled.length > 0);
  }

  function renderAlerts() {
    const list = document.getElementById('alertList');
    const allAlerts = [...(state.risks || []), ...(state.alerts || [])];
    const count = allAlerts.length;
    document.getElementById('alertCount').textContent = count;

    if (count === 0) {
      list.innerHTML = '<p class="empty-hint">✅ 暂无告警，排产正常</p>';
      return;
    }

    list.innerHTML = allAlerts.map(a =>
      `<div class="alert-item ${a.type}">
        ${a.type === 'critical' ? '🔴' : a.type === 'warning' ? '🟡' : '🔵'}
        <strong>${a.category || ''}</strong> ${a.message}
      </div>`
    ).join('');
  }

  function renderStats() {
    document.getElementById('statOrders').textContent = state.orders.length;
    document.getElementById('statProcesses').textContent = state.processes.length;
    document.getElementById('statEquipment').textContent = state.equipment.length;
    document.getElementById('statShifts').textContent = state.shifts.length;
  }

  function renderMaintenance() {
    const list = document.getElementById('maintenanceList');
    if (state.maintenanceWindows.length === 0) {
      list.innerHTML = '<p class="empty-hint">暂无维护计划</p>';
      return;
    }
    list.innerHTML = state.maintenanceWindows.map(m =>
      `<div class="maint-item">🔧 ${m.equipmentId}: ${new Date(m.start).toLocaleString('zh-CN')} ~ ${new Date(m.end).toLocaleString('zh-CN')} (${m.type})</div>`
    ).join('');
  }

  function onScheduleUpdated() {
    renderGantt();
    renderAlerts();
    renderStats();
    renderMaintenance();
    // Run risk analysis
    sendToWorker('analyzeRisks', {});
  }

  // ========== Event Bindings ==========
  function bindEvents() {
    // Import modal
    document.getElementById('btnImport').addEventListener('click', () => openModal('importModal'));

    // Import tabs
    document.querySelectorAll('.import-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.import-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.import-panel').forEach(p => p.classList.add('hidden'));
        tab.classList.add('active');
        const panelId = 'importPanel' + tab.dataset.tab.charAt(0).toUpperCase() + tab.dataset.tab.slice(1);
        const panel = document.getElementById(panelId);
        if (panel) panel.classList.remove('hidden');
      });
    });

    // Import button
    document.getElementById('btnDoImport').addEventListener('click', doImportCurrentTab);
    document.getElementById('btnImportAll').addEventListener('click', doImportAll);

    // File input
    document.getElementById('fileInput').addEventListener('change', handleFileImport);

    // Save/Load
    document.getElementById('btnSave').addEventListener('click', saveSchedule);
    document.getElementById('btnLoad').addEventListener('click', loadSchedule);

    // Export
    document.getElementById('btnExportSchedule').addEventListener('click', () => {
      Exporter.exportScheduleCSV(state.scheduled, state.orders, state.equipment);
      setStatus('排产表已导出');
    });
    document.getElementById('btnExportRisk').addEventListener('click', () => {
      Exporter.exportRiskReport(state.alerts, state.risks, state.scheduled, state.orders);
      setStatus('风险报告已导出');
    });

    // Undo/Redo
    document.getElementById('btnUndo').addEventListener('click', () => {
      const prev = history.undo();
      if (prev) {
        state.scheduled = prev;
        renderGantt();
        setStatus('已撤销');
      }
    });
    document.getElementById('btnRedo').addEventListener('click', () => {
      const next = history.redo();
      if (next) {
        state.scheduled = next;
        renderGantt();
        setStatus('已重做');
      }
    });

    // View switch
    document.querySelectorAll('.view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.viewMode = btn.dataset.view;
        renderGantt();
      });
    });

    // Zoom
    document.getElementById('zoomSlider').addEventListener('input', (e) => {
      state.zoom = parseInt(e.target.value);
      document.getElementById('zoomLabel').textContent = state.zoom;
      renderGantt();
    });

    // Auto schedule
    document.getElementById('btnAutoSchedule').addEventListener('click', () => {
      if (state.orders.length === 0) {
        alert('请先导入订单数据');
        return;
      }
      setStatus('正在自动排产...');
      sendToWorker('autoSchedule', {});
    });

    // Insert order
    document.getElementById('btnInsertOrder').addEventListener('click', () => openModal('insertModal'));
    document.getElementById('btnDoInsert').addEventListener('click', doInsertOrder);

    // Close modals
    document.querySelectorAll('.modal-close').forEach(btn => {
      btn.addEventListener('click', () => {
        const modalId = btn.dataset.close;
        closeModal(modalId);
      });
    });
    document.querySelectorAll('.modal').forEach(modal => {
      modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal(modal.id);
      });
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.key === 'z') { e.preventDefault(); document.getElementById('btnUndo').click(); }
      if (e.ctrlKey && e.key === 'y') { e.preventDefault(); document.getElementById('btnRedo').click(); }
      if (e.ctrlKey && e.key === 's') { e.preventDefault(); document.getElementById('btnSave').click(); }
    });
  }

  // ========== Import Logic ==========
  function doImportCurrentTab() {
    const activeTab = document.querySelector('.import-tab.active');
    if (!activeTab) return;
    const tabName = activeTab.dataset.tab;
    importTabData(tabName);
    onScheduleUpdated();
    closeModal('importModal');
    setStatus(`${tabName} 数据已导入`);
  }

  function doImportAll() {
    const tabs = ['orders', 'processes', 'equipment', 'shifts', 'materials', 'routes', 'maintenance'];
    tabs.forEach(t => importTabData(t));
    onScheduleUpdated();
    closeModal('importModal');
    setStatus('全部数据已导入');
  }

  function importTabData(tabName) {
    const panelMap = {
      orders: 'importOrders',
      processes: 'importProcesses',
      equipment: 'importEquipment',
      shifts: 'importShifts',
      materials: 'importMaterials',
      routes: 'importRoutes',
      maintenance: 'importMaintenance'
    };
    const textarea = document.getElementById(panelMap[tabName]);
    if (!textarea || !textarea.value.trim()) return;

    const text = textarea.value.trim();
    // Check if JSON
    if (text.startsWith('{') || text.startsWith('[')) {
      const json = Importer.importJSON(text);
      if (json) {
        if (json.orders) state.orders = json.orders;
        if (json.processes) state.processes = json.processes;
        if (json.equipment) state.equipment = json.equipment;
        if (json.shifts) state.shifts = json.shifts;
        if (json.materials) state.materials = json.materials;
        if (json.routes) state.routes = json.routes;
        if (json.maintenanceWindows) state.maintenanceWindows = json.maintenanceWindows;
      }
      return;
    }

    switch (tabName) {
      case 'orders': state.orders = Importer.importOrders(text); break;
      case 'processes': state.processes = Importer.importProcesses(text); break;
      case 'equipment': state.equipment = Importer.importEquipment(text); break;
      case 'shifts': state.shifts = Importer.importShifts(text); break;
      case 'materials': state.materials = Importer.importMaterials(text); break;
      case 'routes': state.routes = Importer.importRoutes(text); break;
      case 'maintenance': state.maintenanceWindows = Importer.importMaintenance(text); break;
    }
  }

  function handleFileImport(e) {
    const files = e.target.files;
    if (!files.length) return;

    Array.from(files).forEach(file => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const content = ev.target.result;
        if (file.name.endsWith('.json')) {
          const json = Importer.importJSON(content);
          if (json) {
            if (json.orders) state.orders = json.orders;
            if (json.processes) state.processes = json.processes;
            if (json.equipment) state.equipment = json.equipment;
            if (json.shifts) state.shifts = json.shifts;
            if (json.materials) state.materials = json.materials;
            if (json.routes) state.routes = json.routes;
            if (json.maintenanceWindows) state.maintenanceWindows = json.maintenanceWindows;
          }
        } else {
          // Auto-detect CSV type by header or first column
          const firstLine = content.split('\n')[0].toLowerCase();
          if (firstLine.includes('订单') || firstLine.includes('order')) {
            state.orders = Importer.importOrders(content);
          } else if (firstLine.includes('工序') || firstLine.includes('process')) {
            state.processes = Importer.importProcesses(content);
          } else if (firstLine.includes('设备') || firstLine.includes('equipment')) {
            state.equipment = Importer.importEquipment(content);
          } else if (firstLine.includes('班次') || firstLine.includes('shift')) {
            state.shifts = Importer.importShifts(content);
          } else if (firstLine.includes('物料') || firstLine.includes('material')) {
            state.materials = Importer.importMaterials(content);
          } else {
            // Try as orders by default
            state.orders = Importer.importOrders(content);
          }
        }
        onScheduleUpdated();
        setStatus(`文件 ${file.name} 已导入`);
      };
      reader.readAsText(file);
    });
    e.target.value = '';
  }

  // ========== Insert Order ==========
  function doInsertOrder() {
    const newOrder = {
      id: document.getElementById('insertOrderId').value || 'URGENT-' + Date.now(),
      productType: document.getElementById('insertProduct').value || '紧急产品',
      quantity: parseInt(document.getElementById('insertQty').value) || 10,
      deadline: document.getElementById('insertDeadline').value || new Date(Date.now() + 86400000 * 3).toISOString().slice(0, 16),
      priority: parseInt(document.getElementById('insertPriority').value) || 5,
      locked: false
    };

    // Create basic processes for the new order using existing equipment
    const newProcesses = [];
    if (state.equipment.length > 0) {
      const eq = state.equipment[0];
      newProcesses.push({
        id: `INS-${newOrder.id}-P1`,
        name: '紧急加工',
        equipmentId: eq.id,
        duration: 120,
        dependencies: [],
        orderId: newOrder.id
      });
    }

    setStatus('正在执行插单排产...');
    sendToWorker('insertOrder', {
      newOrder,
      orders: state.orders,
      processes: [...state.processes, ...newProcesses],
      equipment: state.equipment,
      shifts: state.shifts,
      materials: state.materials,
      routes: state.routes,
      maintenanceWindows: state.maintenanceWindows
    });

    // Add to state
    state.orders.push(newOrder);
    state.processes.push(...newProcesses);

    closeModal('insertModal');
  }

  // ========== Save/Load ==========
  function saveSchedule() {
    const saveData = {
      orders: state.orders,
      processes: state.processes,
      equipment: state.equipment,
      shifts: state.shifts,
      materials: state.materials,
      routes: state.routes,
      maintenanceWindows: state.maintenanceWindows,
      scheduled: state.scheduled,
      savedAt: new Date().toISOString()
    };
    localStorage.setItem('productionSchedule', JSON.stringify(saveData));
    // Also offer download
    Exporter.exportFullJSON(saveData);
    setStatus('排产方案已保存');
  }

  function loadSchedule() {
    const saved = localStorage.getItem('productionSchedule');
    if (saved) {
      try {
        const data = JSON.parse(saved);
        Object.assign(state, data);
        onScheduleUpdated();
        setStatus(`已加载方案 (保存于 ${new Date(data.savedAt).toLocaleString('zh-CN')})`);
      } catch (e) {
        alert('加载失败：数据格式错误');
      }
    } else {
      alert('未找到已保存的排产方案');
    }
  }

  // ========== Process Detail ==========
  function showProcessDetail(task) {
    const order = state.orders.find(o => o.id === task.orderId) || {};
    const equip = state.equipment.find(e => e.id === task.equipmentId) || {};
    const deps = (task.dependencies || []).map(d => {
      const depTask = state.processes.find(p => p.id === d);
      return depTask ? `${depTask.name || d}` : d;
    }).join(', ') || '无';

    const start = task.scheduledStart ? new Date(task.scheduledStart).toLocaleString('zh-CN') : '未排程';
    const end = task.scheduledEnd ? new Date(task.scheduledEnd).toLocaleString('zh-CN') : '未排程';
    const dur = task.scheduledStart && task.scheduledEnd
      ? Math.round((task.scheduledEnd - task.scheduledStart) / 60000) + ' 分钟' : '-';

    let deadlineRisk = '';
    if (order.deadline && task.scheduledEnd) {
      const slack = (new Date(order.deadline).getTime() - task.scheduledEnd) / 3600000;
      if (slack < 0) deadlineRisk = `<p style="color:#ef4444;font-weight:bold">⚠️ 超出交期 ${Math.abs(slack).toFixed(1)} 小时</p>`;
      else if (slack < 4) deadlineRisk = `<p style="color:#f59e0b">⚠️ 交期余量仅 ${slack.toFixed(1)} 小时</p>`;
    }

    document.getElementById('detailTitle').textContent = `工序：${task.name || task.id}`;
    document.getElementById('detailBody').innerHTML = `
      <div class="form-group"><label>工序编号</label><p>${task.id}</p></div>
      <div class="form-group"><label>所属订单</label><p>${task.orderId || '-'} (${order.productType || '-'})</p></div>
      <div class="form-group"><label>设备</label><p>${equip.name || task.equipmentId || '-'} (${equip.type || '-'})</p></div>
      <div class="form-group"><label>计划时间</label><p>${start} ~ ${end}</p></div>
      <div class="form-group"><label>时长</label><p>${dur}</p></div>
      <div class="form-group"><label>前置工序</label><p>${deps}</p></div>
      <div class="form-group"><label>订单交期</label><p>${order.deadline || '-'}</p></div>
      <div class="form-group"><label>优先级</label><p>${order.priority || '-'} ${order.locked ? '🔒 已锁定' : ''}</p></div>
      ${deadlineRisk}
      <div style="margin-top:16px;display:flex;gap:8px">
        <button class="btn ${order.locked ? 'btn-warning' : ''}" onclick="toggleLock('${task.orderId}')">
          ${order.locked ? '🔓 解锁订单' : '🔒 锁定订单'}
        </button>
      </div>
    `;
    openModal('detailModal');
  }

  // ========== Modal Helpers ==========
  function openModal(id) {
    document.getElementById(id).classList.add('active');
  }
  function closeModal(id) {
    document.getElementById(id).classList.remove('active');
  }

  // ========== Status ==========
  function setStatus(msg) {
    document.getElementById('statusText').textContent = msg;
  }

  function updateTime() {
    document.getElementById('statusTime').textContent = new Date().toLocaleString('zh-CN');
  }

  // ========== Sample Data ==========
  window.loadSampleData = function () {
    const today = new Date();
    const d = (days, hours = 8) => {
      const dt = new Date(today.getFullYear(), today.getMonth(), today.getDate() + days, hours, 0);
      return dt.toISOString().slice(0, 16).replace('T', ' ');
    };

    state.orders = [
      { id: 'ORD001', productType: '精密齿轮', quantity: 200, deadline: d(5, 18), priority: 5, locked: false },
      { id: 'ORD002', productType: '传动轴', quantity: 150, deadline: d(7, 12), priority: 4, locked: false },
      { id: 'ORD003', productType: '精密齿轮', quantity: 100, deadline: d(4, 16), priority: 3, locked: true },
      { id: 'ORD004', productType: '轴承座', quantity: 300, deadline: d(10, 18), priority: 3, locked: false },
      { id: 'ORD005', productType: '传动轴', quantity: 80, deadline: d(3, 14), priority: 5, locked: false },
      { id: 'ORD006', productType: '液压缸', quantity: 50, deadline: d(8, 16), priority: 2, locked: false }
    ];

    state.equipment = [
      { id: 'EQ01', name: '数控车床A', type: '车削', status: '正常' },
      { id: 'EQ02', name: '数控铣床B', type: '铣削', status: '正常' },
      { id: 'EQ03', name: '磨床C', type: '磨削', status: '正常' },
      { id: 'EQ04', name: '热处理炉D', type: '热处理', status: '正常' },
      { id: 'EQ05', name: '检测仪E', type: '检测', status: '正常' }
    ];

    state.shifts = [
      { name: '早班', team: 'A组', startTime: '06:00', endTime: '14:00', crossDay: false },
      { name: '中班', team: 'B组', startTime: '14:00', endTime: '22:00', crossDay: false },
      { name: '夜班', team: 'C组', startTime: '22:00', endTime: '06:00', crossDay: true }
    ];

    state.processes = [
      // ORD001 精密齿轮: 车削→热处理→磨削→检测
      { id: 'P001', name: '粗车', equipmentId: 'EQ01', duration: 180, dependencies: [], orderId: 'ORD001' },
      { id: 'P002', name: '热处理', equipmentId: 'EQ04', duration: 240, dependencies: ['P001'], orderId: 'ORD001' },
      { id: 'P003', name: '精磨', equipmentId: 'EQ03', duration: 120, dependencies: ['P002'], orderId: 'ORD001' },
      { id: 'P004', name: '终检', equipmentId: 'EQ05', duration: 60, dependencies: ['P003'], orderId: 'ORD001' },
      // ORD002 传动轴: 车削→铣削→热处理→检测
      { id: 'P005', name: '车削', equipmentId: 'EQ01', duration: 200, dependencies: [], orderId: 'ORD002' },
      { id: 'P006', name: '铣键槽', equipmentId: 'EQ02', duration: 90, dependencies: ['P005'], orderId: 'ORD002' },
      { id: 'P007', name: '热处理', equipmentId: 'EQ04', duration: 180, dependencies: ['P006'], orderId: 'ORD002' },
      { id: 'P008', name: '终检', equipmentId: 'EQ05', duration: 45, dependencies: ['P007'], orderId: 'ORD002' },
      // ORD003 精密齿轮 (locked)
      { id: 'P009', name: '粗车', equipmentId: 'EQ01', duration: 150, dependencies: [], orderId: 'ORD003' },
      { id: 'P010', name: '热处理', equipmentId: 'EQ04', duration: 200, dependencies: ['P009'], orderId: 'ORD003' },
      { id: 'P011', name: '精磨', equipmentId: 'EQ03', duration: 100, dependencies: ['P010'], orderId: 'ORD003' },
      { id: 'P012', name: '终检', equipmentId: 'EQ05', duration: 40, dependencies: ['P011'], orderId: 'ORD003' },
      // ORD004 轴承座: 铣削→磨削→检测
      { id: 'P013', name: '粗铣', equipmentId: 'EQ02', duration: 240, dependencies: [], orderId: 'ORD004' },
      { id: 'P014', name: '精铣', equipmentId: 'EQ02', duration: 180, dependencies: ['P013'], orderId: 'ORD004' },
      { id: 'P015', name: '磨削', equipmentId: 'EQ03', duration: 150, dependencies: ['P014'], orderId: 'ORD004' },
      { id: 'P016', name: '终检', equipmentId: 'EQ05', duration: 60, dependencies: ['P015'], orderId: 'ORD004' },
      // ORD005 传动轴 (urgent)
      { id: 'P017', name: '车削', equipmentId: 'EQ01', duration: 120, dependencies: [], orderId: 'ORD005' },
      { id: 'P018', name: '铣削', equipmentId: 'EQ02', duration: 80, dependencies: ['P017'], orderId: 'ORD005' },
      { id: 'P019', name: '检测', equipmentId: 'EQ05', duration: 30, dependencies: ['P018'], orderId: 'ORD005' },
      // ORD006 液压缸
      { id: 'P020', name: '车削', equipmentId: 'EQ01', duration: 160, dependencies: [], orderId: 'ORD006' },
      { id: 'P021', name: '镗孔', equipmentId: 'EQ02', duration: 120, dependencies: ['P020'], orderId: 'ORD006' },
      { id: 'P022', name: '磨削', equipmentId: 'EQ03', duration: 90, dependencies: ['P021'], orderId: 'ORD006' },
      { id: 'P023', name: '检测', equipmentId: 'EQ05', duration: 50, dependencies: ['P022'], orderId: 'ORD006' }
    ];

    state.materials = [
      { id: 'M001', name: '40Cr钢棒', orderId: 'ORD001', arrivalTime: d(0, 6), quantity: 500 },
      { id: 'M002', name: '45#钢圆棒', orderId: 'ORD002', arrivalTime: d(1, 8), quantity: 300 },
      { id: 'M003', name: '20CrMnTi', orderId: 'ORD003', arrivalTime: d(-1, 10), quantity: 200 },
      { id: 'M004', name: 'HT250铸件', orderId: 'ORD004', arrivalTime: d(2, 8), quantity: 400 },
      { id: 'M005', name: '45#钢圆棒', orderId: 'ORD005', arrivalTime: d(3, 10), quantity: 150 }, // Late arrival risk
      { id: 'M006', name: '27SiMn钢管', orderId: 'ORD006', arrivalTime: d(1, 14), quantity: 100 }
    ];

    state.routes = [
      { productType: '精密齿轮', processSequence: ['P001', 'P002', 'P003', 'P004'] },
      { productType: '传动轴', processSequence: ['P005', 'P006', 'P007', 'P008'] },
      { productType: '轴承座', processSequence: ['P013', 'P014', 'P015', 'P016'] },
      { productType: '液压缸', processSequence: ['P020', 'P021', 'P022', 'P023'] }
    ];

    state.maintenanceWindows = [
      { equipmentId: 'EQ02', start: d(2, 8), end: d(2, 14), type: '定期保养' },
      { equipmentId: 'EQ04', start: d(4, 22), end: d(5, 6), type: '炉衬更换' }
    ];

    onScheduleUpdated();
    setStatus('示例数据已加载，点击"自动排产"开始排程');
  };

  // Global helper for lock toggle
  window.toggleLock = function (orderId) {
    const order = state.orders.find(o => o.id === orderId);
    if (order) {
      order.locked = !order.locked;
      state.scheduled.forEach(s => {
        if (s.orderId === orderId) s.locked = order.locked;
      });
      renderGantt();
      closeModal('detailModal');
      setStatus(order.locked ? `订单 ${orderId} 已锁定` : `订单 ${orderId} 已解锁`);
    }
  };

  // ========== Init ==========
  function init() {
    initWorker();
    bindEvents();
    renderStats();
    renderAlerts();
    renderMaintenance();
    updateTime();
    setInterval(updateTime, 1000);

    // Try loading saved data
    const saved = localStorage.getItem('productionSchedule');
    if (saved) {
      try {
        const data = JSON.parse(saved);
        Object.assign(state, data);
        onScheduleUpdated();
        setStatus('已自动加载上次保存的方案');
      } catch (e) { /* ignore */ }
    }
  }

  init();
})();
