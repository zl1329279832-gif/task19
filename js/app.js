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

  // ========== Scenario Manager ==========
  const scenarioManager = new ScenarioManager();
  let sandboxMode = false;
  let scenarioCompareSet = new Set();  // scenario IDs selected for comparison
  let scenarioCalcQueue = [];           // queue of scenario IDs to calculate
  let scenarioCalcRunning = false;

  // ========== Web Worker ==========
  let worker = null;
  let currentRequestVersion = 0;
  let pendingContextId = null;      // scenarioId or null (baseline) when last sent
  let pendingIsBaseline = false;    // whether the last send operated on main state baseline

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
    const { action, data, requestVersion, scenarioId, scenarioVersion } = e.data;

    // === Scenario results: validate by scenarioId + calcVersion ===
    if (action === 'scenarioResult') {
      handleScenarioResult(data, requestVersion, scenarioVersion);
      return;
    }

    // === Main-state operations: discard stale ===
    if (requestVersion !== undefined && requestVersion !== currentRequestVersion) {
      return; // stale result from a superseded request
    }

    // For baseline operations: if user switched to a scenario view after sending, discard
    // UNLESS this result was explicitly sent for a scenario (has scenarioId)
    if (!scenarioId && pendingIsBaseline && sandboxMode && scenarioManager.activeId) {
      return;
    }

    switch (action) {
      case 'autoScheduleResult':
        state.scheduled = data.scheduled;
        state.alerts = data.alerts;
        pushToHistory(state.scheduled, null);
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
        pushToHistory(state.scheduled, null);
        onScheduleUpdated();
        setStatus('插单排产完成');
        break;
      case 'recalcResult':
        handleRecalcResult(data, scenarioId, scenarioVersion);
        break;
    }
  }

  function handleRecalcResult(data, scenarioId, scenarioVersion) {
    // If the recalc was for a scenario (sandbox drag), apply to scenario
    if (scenarioId && sandboxMode) {
      const sc = scenarioManager.getScenario(scenarioId);
      if (sc) {
        // Verify this scenario hasn't been recalculated again (version check)
        if (scenarioVersion !== undefined && scenarioVersion !== sc.calcVersion) {
          return; // stale — scenario was modified after this drag was sent
        }
        sc.scheduled = data.updated;
        sc.alerts = data.alerts;
        pushToHistory(sc.scheduled, sc.id);
        scenarioManager.computeMetrics(sc);
        if (scenarioManager.activeId === sc.id) {
          renderGantt();
          renderAlerts();
          renderStats();
          renderMaintenance();
          renderScenarioCards();
        }
        if (data.cascadeUpdates && data.cascadeUpdates.length > 0) {
          setStatus(`拖拽完成，${data.cascadeUpdates.length} 个后续工序已联动调整`);
        } else {
          setStatus('拖拽调整完成');
        }
        return;
      }
    }
    // Baseline recalc
    state.scheduled = data.updated;
    state.alerts = data.alerts;
    pushToHistory(state.scheduled, null);
    onScheduleUpdated();
    if (data.cascadeUpdates && data.cascadeUpdates.length > 0) {
      setStatus(`拖拽完成，${data.cascadeUpdates.length} 个后续工序已联动调整`);
    } else {
      setStatus('拖拽调整完成');
    }
  }

  function sendToWorker(action, extraData) {
    currentRequestVersion++;
    pendingContextId = (sandboxMode && scenarioManager.activeId) ? scenarioManager.activeId : null;
    pendingIsBaseline = true;  // sendToWorker always operates on main state
    worker.postMessage({
      action,
      data: { ...state, ...extraData },
      requestVersion: currentRequestVersion
    });
  }

  function sendScenarioToWorker(scenarioId, action, extraData) {
    currentRequestVersion++;
    const sc = scenarioManager.getScenario(scenarioId);
    if (!sc) return;
    pendingContextId = scenarioId;
    pendingIsBaseline = false;
    worker.postMessage({
      action,
      data: {
        orders: sc.orders,
        processes: sc.processes,
        equipment: sc.equipment,
        shifts: sc.shifts,
        materials: sc.materials,
        routes: sc.routes,
        maintenanceWindows: sc.maintenanceWindows,
        scheduled: sc.scheduled,
        alerts: sc.alerts,
        risks: sc.risks,
        ...extraData
      },
      requestVersion: currentRequestVersion,
      scenarioId: scenarioId,
      scenarioVersion: sc.calcVersion
    });
  }

  // ========== History ==========
  const history = new HistoryManager(50);
  history.onchange = (canUndo, canRedo) => {
    document.getElementById('btnUndo').disabled = !canUndo;
    document.getElementById('btnRedo').disabled = !canRedo;
  };

  // Push scheduled data to the correct history (scenario or baseline)
  function pushToHistory(scheduled, scenarioId) {
    if (scenarioId) {
      const sc = scenarioManager.getScenario(scenarioId);
      if (sc) sc.history.push(scheduled);
    } else {
      history.push(scheduled);
    }
  }

  // ========== Gantt ==========
  const gantt = new GanttChart(document.getElementById('ganttContainer'));

  gantt.onDragEnd = (movedProcess) => {
    if (sandboxMode && scenarioManager.activeId) {
      const sc = scenarioManager.getActiveScenario();
      if (sc) {
        // Route recalc through scenario-scoped worker call
        sendScenarioToWorker(sc.id, 'recalcAfterDrag', {
          movedProcess,
          allScheduled: sc.scheduled
        });
        return;
      }
    }
    sendToWorker('recalcAfterDrag', {
      movedProcess,
      allScheduled: state.scheduled
    });
  };

  gantt.onBarClick = (task) => {
    showProcessDetail(task);
  };

  gantt.onBarDblClick = (task) => {
    // In sandbox mode, toggle lock on the active scenario's order
    if (sandboxMode && scenarioManager.activeId) {
      const sc = scenarioManager.getActiveScenario();
      if (sc) {
        const order = (sc.orders || []).find(o => o.id === task.orderId);
        if (order) {
          order.locked = !order.locked;
          task.locked = order.locked;
          // Update scheduled items in the scenario
          (sc.scheduled || []).forEach(s => {
            if (s.orderId === order.id) s.locked = order.locked;
          });
          renderGantt();
          setStatus(order.locked ? `[${sc.name}] 订单 ${order.id} 已锁定` : `[${sc.name}] 订单 ${order.id} 已解锁`);
        }
      }
      return;
    }
    // Baseline lock toggle
    const order = state.orders.find(o => o.id === task.orderId);
    if (order) {
      order.locked = !order.locked;
      task.locked = order.locked;
      renderGantt();
      setStatus(order.locked ? `订单 ${order.id} 已锁定` : `订单 ${order.id} 已解锁`);
    }
  };

  // ========== Get Active View Data ==========
  // Returns the data to display (either baseline state or active scenario)
  function getViewData() {
    if (sandboxMode && scenarioManager.activeId) {
      const sc = scenarioManager.getActiveScenario();
      if (sc) return sc;
    }
    return state;
  }

  // ========== Rendering ==========
  function renderGantt() {
    const viewData = getViewData();
    gantt.viewMode = state.viewMode;
    gantt.zoom = state.zoom;
    gantt.render({
      scheduled: viewData.scheduled || [],
      maintenanceWindows: viewData.maintenanceWindows || [],
      shifts: viewData.shifts || [],
      orders: viewData.orders || [],
      equipment: viewData.equipment || []
    });
    document.getElementById('ganttEmpty').classList.toggle('hidden', (viewData.scheduled || []).length > 0);
  }

  function renderAlerts() {
    const viewData = getViewData();
    const list = document.getElementById('alertList');
    const allAlerts = [...(viewData.risks || []), ...(viewData.alerts || [])];
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
    const viewData = getViewData();
    document.getElementById('statOrders').textContent = (viewData.orders || []).length;
    document.getElementById('statProcesses').textContent = (viewData.processes || []).length;
    document.getElementById('statEquipment').textContent = (viewData.equipment || []).length;
    document.getElementById('statShifts').textContent = (viewData.shifts || []).length;
  }

  function renderMaintenance() {
    const viewData = getViewData();
    const list = document.getElementById('maintenanceList');
    const mws = viewData.maintenanceWindows || [];
    if (mws.length === 0) {
      list.innerHTML = '<p class="empty-hint">暂无维护计划</p>';
      return;
    }
    list.innerHTML = mws.map(m =>
      `<div class="maint-item">🔧 ${m.equipmentId}: ${new Date(m.start).toLocaleString('zh-CN')} ~ ${new Date(m.end).toLocaleString('zh-CN')} (${m.type})</div>`
    ).join('');
  }

  function renderScenarioBanner() {
    const banner = document.getElementById('scenarioBanner');
    if (sandboxMode && scenarioManager.activeId) {
      const sc = scenarioManager.getActiveScenario();
      banner.textContent = `🧪 当前查看：方案 "${sc ? sc.name : ''}" — 甘特图、告警、风险均已隔离`;
      banner.style.display = 'block';
    } else {
      banner.style.display = 'none';
    }
  }

  function onScheduleUpdated() {
    renderGantt();
    renderAlerts();
    renderStats();
    renderMaintenance();
    renderScenarioBanner();
    // Run risk analysis
    sendToWorker('analyzeRisks', {});
  }

  // ========== Sandbox Mode ==========
  function enterSandbox() {
    if (sandboxMode) return;
    sandboxMode = true;
    document.body.classList.add('sandbox-mode');
    document.getElementById('sandboxPanel').classList.remove('hidden');
    document.getElementById('btnSandbox').classList.add('active');
    document.getElementById('btnSandbox').textContent = '🧪 退出沙盘';

    // Snapshot current state
    scenarioManager.enterSandbox(state);
    scenarioCompareSet.clear();
    renderScenarioCards();
    renderScenarioBanner();
    setStatus('已进入 What-if 排产沙盘模式');
  }

  function exitSandbox() {
    if (!sandboxMode) return;
    // Restore baseline state
    const baseline = scenarioManager.exitSandbox();
    if (baseline) {
      Object.assign(state, baseline);
    }

    sandboxMode = false;
    scenarioManager.activeId = null;
    document.body.classList.remove('sandbox-mode');
    document.getElementById('sandboxPanel').classList.add('hidden');
    document.getElementById('btnSandbox').classList.remove('active');
    document.getElementById('btnSandbox').textContent = '🧪 沙盘';
    scenarioCompareSet.clear();

    // Re-render baseline
    onScheduleUpdated();
    setStatus('已退出沙盘模式，恢复主排产');
  }

  // ========== Scenario Card Rendering ==========
  function renderScenarioCards() {
    const container = document.getElementById('sandboxCards');
    const scenarios = scenarioManager.getAllScenarios();
    document.getElementById('scenarioCount').textContent = `${scenarios.length} 个方案`;

    if (scenarios.length === 0) {
      container.innerHTML = `
        <div class="sandbox-empty" id="sandboxEmpty">
          <p>📋 点击"新建方案"基于当前排产创建 What-if 方案</p>
          <p class="hint">每个方案可独立调整班次、维护窗口、物料、插单等参数</p>
        </div>`;
      return;
    }

    container.innerHTML = scenarios.map(sc => {
      const isActive = scenarioManager.activeId === sc.id;
      const isCompare = scenarioCompareSet.has(sc.id);
      const statusDot = sc.status || 'pending';
      const statusText = { pending: '待计算', calculating: '计算中...', ready: '已就绪', error: '出错' }[statusDot] || statusDot;
      const m = sc.metrics;

      return `
        <div class="scenario-card ${isActive ? 'active' : ''} ${sc.status === 'calculating' ? 'calculating' : ''}"
             data-id="${sc.id}" onclick="handleCardClick('${sc.id}')">
          <div class="sc-card-header">
            <span class="sc-card-name" title="${sc.name}">${sc.name}</span>
            <div class="sc-card-actions">
              <button class="sc-card-btn" title="调整参数" onclick="event.stopPropagation();openScenarioAdjust('${sc.id}')">⚙</button>
              <button class="sc-card-btn" title="复制方案" onclick="event.stopPropagation();duplicateScenario('${sc.id}')">📋</button>
              <button class="sc-card-btn" title="重算" onclick="event.stopPropagation();recalcScenario('${sc.id}')">🔄</button>
              <button class="sc-card-btn" title="删除" onclick="event.stopPropagation();deleteScenario('${sc.id}')">🗑</button>
            </div>
          </div>
          <div class="sc-card-metrics">
            ${m ? `
              <div class="sc-metric"><span class="sc-metric-label">完工时间</span><span class="sc-metric-value">${m.completionTimeStr || '-'}</span></div>
              <div class="sc-metric"><span class="sc-metric-label">延期订单</span><span class="sc-metric-value ${m.delayedOrders > 0 ? 'bad' : 'good'}">${m.delayedOrders}</span></div>
              <div class="sc-metric"><span class="sc-metric-label">设备利用</span><span class="sc-metric-value">${m.avgUtilization}%</span></div>
              <div class="sc-metric"><span class="sc-metric-label">换线次数</span><span class="sc-metric-value ${m.totalChangeovers > 3 ? 'warn' : ''}">${m.totalChangeovers}</span></div>
              <div class="sc-metric"><span class="sc-metric-label">班次超载</span><span class="sc-metric-value ${m.shiftOverloads > 0 ? 'warn' : ''}">${m.shiftOverloads}</span></div>
              <div class="sc-metric"><span class="sc-metric-label">冲突数</span><span class="sc-metric-value ${m.conflictCount > 0 ? 'bad' : 'good'}">${m.conflictCount}</span></div>
            ` : '<div style="grid-column:span 2;color:#818cf8;font-size:11px;text-align:center;padding:8px">点击"重算"计算排产</div>'}
          </div>
          <div class="sc-card-footer">
            <div class="sc-status">
              <span class="sc-status-dot ${statusDot}"></span>
              <span>${statusText}</span>
            </div>
            <label class="sc-card-checkbox" onclick="event.stopPropagation()">
              <input type="checkbox" ${isCompare ? 'checked' : ''} onchange="toggleCompare('${sc.id}', this.checked)">
              对比
            </label>
          </div>
        </div>`;
    }).join('');
  }

  // ========== Scenario Actions (exposed globally) ==========

  window.handleCardClick = function(scenarioId) {
    switchScenario(scenarioId);
  };

  window.toggleCompare = function(scenarioId, checked) {
    if (checked) scenarioCompareSet.add(scenarioId);
    else scenarioCompareSet.delete(scenarioId);
  };

  window.deleteScenario = function(scenarioId) {
    if (!confirm('确定删除此方案？')) return;
    scenarioManager.deleteScenario(scenarioId);
    scenarioCompareSet.delete(scenarioId);
    renderScenarioCards();
    if (!scenarioManager.activeId) {
      onScheduleUpdated();
    }
    setStatus('方案已删除');
  };

  window.duplicateScenario = function(scenarioId) {
    const dup = scenarioManager.duplicateScenario(scenarioId);
    if (dup) {
      renderScenarioCards();
      setStatus(`已复制方案：${dup.name}`);
    }
  };

  window.recalcScenario = function(scenarioId) {
    const sc = scenarioManager.getScenario(scenarioId);
    if (!sc) return;
    sc.status = 'calculating';
    sc.calcVersion = (sc.calcVersion || 0) + 1;
    renderScenarioCards();
    setStatus(`正在计算方案 "${sc.name}"...`);

    // Send to worker with scenario-scoped version
    worker.postMessage({
      action: 'scenarioCalculate',
      data: {
        scenarioId: sc.id,
        scenarioData: {
          orders: sc.orders,
          processes: sc.processes,
          equipment: sc.equipment,
          shifts: sc.shifts,
          materials: sc.materials,
          routes: sc.routes,
          maintenanceWindows: sc.maintenanceWindows
        }
      },
      requestVersion: currentRequestVersion,
      scenarioId: sc.id,
      scenarioVersion: sc.calcVersion
    });
  };

  function handleScenarioResult(data, requestVersion, scenarioVersion) {
    const sc = scenarioManager.getScenario(data.scenarioId);
    if (!sc) return;

    // Discard stale results: if scenario was recalculated again, this result is outdated
    if (scenarioVersion !== undefined && scenarioVersion !== sc.calcVersion) {
      return;
    }

    if (data.error) {
      sc.status = 'error';
      sc.alerts = [{ type: 'critical', message: data.error }];
    } else {
      sc.scheduled = data.scheduled;
      sc.alerts = data.alerts || [];
      sc.risks = data.risks || [];
      sc.status = 'ready';
      sc.history.push(sc.scheduled);
      // Compute metrics
      scenarioManager.computeMetrics(sc);
    }

    renderScenarioCards();

    // Only re-render views if this scenario is STILL the active one
    if (scenarioManager.activeId === data.scenarioId) {
      renderGantt();
      renderAlerts();
      renderStats();
      renderMaintenance();
    }

    setStatus(data.error
      ? `方案 "${sc.name}" 计算出错: ${data.error}`
      : `方案 "${sc.name}" 计算完成：${(data.scheduled || []).length} 个工序`);

    // Process queue
    processScenarioQueue();
  }

  function processScenarioQueue() {
    if (scenarioCalcQueue.length === 0) {
      scenarioCalcRunning = false;
      return;
    }
    scenarioCalcRunning = true;
    const nextId = scenarioCalcQueue.shift();
    window.recalcScenario(nextId);
  }

  function recalcAllScenarios() {
    scenarioCalcQueue = scenarioManager.getAllScenarios()
      .filter(sc => sc.status !== 'calculating')
      .map(sc => sc.id);
    if (scenarioCalcQueue.length > 0 && !scenarioCalcRunning) {
      processScenarioQueue();
    }
  }

  function switchScenario(scenarioId) {
    if (scenarioManager.activeId === scenarioId) {
      // Toggle off - back to baseline
      scenarioManager.setActive(null);
    } else {
      scenarioManager.setActive(scenarioId);
    }
    // Invalidate any pending baseline worker results — context has changed
    pendingContextId = scenarioManager.activeId;
    pendingIsBaseline = !scenarioManager.activeId;

    renderScenarioCards();
    renderScenarioBanner();
    renderGantt();
    renderAlerts();
    renderStats();
    renderMaintenance();

    const sc = scenarioManager.getActiveScenario();
    setStatus(sc ? `已切换到方案 "${sc.name}"` : '已切换回主排产');
  }

  // ========== Scenario Creation ==========
  function createNewScenario() {
    const count = scenarioManager.getAllScenarios().length;
    const name = `方案 ${count + 1}`;
    // Clone from the baseline state (current main state)
    const sc = scenarioManager.createScenario(name, state);
    renderScenarioCards();
    setStatus(`已创建方案 "${name}"，点击 ⚙ 调整参数后重算`);
    // Auto-open adjustment
    openScenarioAdjust(sc.id);
  }

  // ========== Scenario Adjustment Modal ==========
  let currentAdjustScenarioId = null;

  window.openScenarioAdjust = function(scenarioId) {
    const sc = scenarioManager.getScenario(scenarioId);
    if (!sc) return;
    currentAdjustScenarioId = scenarioId;

    document.getElementById('scenarioAdjustTitle').textContent = `🔧 调整方案：${sc.name}`;

    // Reset tabs
    document.querySelectorAll('.adjust-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.adjust-panel').forEach(p => p.classList.add('hidden'));
    document.querySelector('.adjust-tab[data-atab="shifts"]').classList.add('active');
    document.getElementById('adjustPanelShifts').classList.remove('hidden');

    // Populate adjustment panels
    populateShiftAdjust(sc);
    populateMaintAdjust(sc);
    populateMaterialAdjust(sc);
    populateLockAdjust(sc);
    populatePriorityAdjust(sc);

    openModal('scenarioAdjustModal');
  };

  function populateShiftAdjust(sc) {
    const container = document.getElementById('adjustShiftsList');
    container.innerHTML = (sc.shifts || []).map((s, i) => `
      <div class="adjust-row" data-index="${i}">
        <label>班次名称</label>
        <input type="text" class="adj-shift-name" value="${s.name}">
        <label>班组</label>
        <input type="text" class="adj-shift-team" value="${s.team}">
        <label>开始</label>
        <input type="time" class="adj-shift-start" value="${s.startTime}">
        <label>结束</label>
        <input type="time" class="adj-shift-end" value="${s.endTime}">
        <label>跨天</label>
        <select class="adj-shift-cross">
          <option value="false" ${!s.crossDay ? 'selected' : ''}>否</option>
          <option value="true" ${s.crossDay ? 'selected' : ''}>是</option>
        </select>
        <button class="btn-remove" onclick="this.parentElement.remove()">×</button>
      </div>
    `).join('');
  }

  function populateMaintAdjust(sc) {
    const container = document.getElementById('adjustMaintList');
    container.innerHTML = (sc.maintenanceWindows || []).map((m, i) => `
      <div class="adjust-row" data-index="${i}">
        <label>设备</label>
        <input type="text" class="adj-maint-equip" value="${m.equipmentId}">
        <label>开始</label>
        <input type="datetime-local" class="adj-maint-start" value="${toLocalDatetime(m.start)}">
        <label>结束</label>
        <input type="datetime-local" class="adj-maint-end" value="${toLocalDatetime(m.end)}">
        <label>类型</label>
        <input type="text" class="adj-maint-type" value="${m.type}">
        <button class="btn-remove" onclick="this.parentElement.remove()">×</button>
      </div>
    `).join('');
  }

  function populateMaterialAdjust(sc) {
    const container = document.getElementById('adjustMaterialList');
    container.innerHTML = (sc.materials || []).map((m, i) => `
      <div class="adjust-row" data-index="${i}">
        <label>${m.name}(${m.id})</label>
        <span style="font-size:11px;color:#64748b;min-width:80px">订单: ${m.orderId}</span>
        <label>到料时间</label>
        <input type="datetime-local" class="adj-mat-time" value="${toLocalDatetime(m.arrivalTime)}" data-mat-id="${m.id}">
        <label>数量</label>
        <input type="number" class="adj-mat-qty" value="${m.quantity}" disabled style="width:60px">
      </div>
    `).join('');
  }

  function populateLockAdjust(sc) {
    const container = document.getElementById('adjustLockList');
    container.innerHTML = (sc.orders || []).map(o => `
      <div class="lock-row">
        <div class="order-info">
          <span class="order-id">${o.id}</span>
          <span class="order-product">${o.productType} × ${o.quantity}</span>
        </div>
        <button class="lock-toggle ${o.locked ? 'locked' : ''}"
                data-order-id="${o.id}"
                onclick="toggleLockInAdjust(this)">
          ${o.locked ? '🔒 已锁定' : '🔓 未锁定'}
        </button>
      </div>
    `).join('');
  }

  function populatePriorityAdjust(sc) {
    const container = document.getElementById('adjustPriorityList');
    container.innerHTML = (sc.orders || []).map(o => `
      <div class="priority-row">
        <div class="order-info">
          <strong>${o.id}</strong> ${o.productType} × ${o.quantity}
          ${o.deadline ? `<span style="color:#64748b">交期: ${o.deadline}</span>` : ''}
        </div>
        <input type="number" min="1" max="10" value="${o.priority}"
               data-order-id="${o.id}" class="adj-priority-input">
      </div>
    `).join('');
  }

  window.toggleLockInAdjust = function(btn) {
    const orderId = btn.dataset.orderId;
    const isLocked = btn.classList.contains('locked');
    btn.classList.toggle('locked');
    btn.textContent = isLocked ? '🔓 未锁定' : '🔒 已锁定';
  };

  function toLocalDatetime(str) {
    if (!str) return '';
    // Convert "2026-06-15 08:00" or ISO to datetime-local format
    return str.replace(' ', 'T').slice(0, 16);
  }

  function fromLocalDatetime(val) {
    if (!val) return '';
    return val.replace('T', ' ');
  }

  function collectAdjustments() {
    const sc = scenarioManager.getScenario(currentAdjustScenarioId);
    if (!sc) return [];

    const mods = [];

    // Shifts
    const shiftRows = document.querySelectorAll('#adjustShiftsList .adjust-row');
    const newShifts = [];
    shiftRows.forEach(row => {
      newShifts.push({
        name: row.querySelector('.adj-shift-name').value,
        team: row.querySelector('.adj-shift-team').value,
        startTime: row.querySelector('.adj-shift-start').value,
        endTime: row.querySelector('.adj-shift-end').value,
        crossDay: row.querySelector('.adj-shift-cross').value === 'true'
      });
    });
    if (JSON.stringify(newShifts) !== JSON.stringify(sc.shifts)) {
      mods.push({ type: 'shift_change', shifts: newShifts, description: '调整班次' });
    }

    // Maintenance windows
    const maintRows = document.querySelectorAll('#adjustMaintList .adjust-row');
    const newMaint = [];
    maintRows.forEach(row => {
      newMaint.push({
        equipmentId: row.querySelector('.adj-maint-equip').value,
        start: fromLocalDatetime(row.querySelector('.adj-maint-start').value),
        end: fromLocalDatetime(row.querySelector('.adj-maint-end').value),
        type: row.querySelector('.adj-maint-type').value
      });
    });
    if (JSON.stringify(newMaint) !== JSON.stringify(sc.maintenanceWindows)) {
      mods.push({ type: 'maintenance_change', windows: newMaint, description: '调整维护窗口' });
    }

    // Materials
    const matInputs = document.querySelectorAll('.adj-mat-time');
    const matUpdates = [];
    matInputs.forEach(input => {
      const matId = input.dataset.matId;
      const newTime = fromLocalDatetime(input.value);
      const orig = sc.materials.find(m => m.id === matId);
      if (orig && orig.arrivalTime !== newTime) {
        matUpdates.push({ materialId: matId, newArrivalTime: newTime });
      }
    });
    if (matUpdates.length > 0) {
      mods.push({ type: 'material_batch_update', updates: matUpdates, description: `调整 ${matUpdates.length} 项物料到货时间` });
    }

    // Lock changes
    const lockBtns = document.querySelectorAll('.lock-toggle');
    lockBtns.forEach(btn => {
      const orderId = btn.dataset.orderId;
      const isLocked = btn.classList.contains('locked');
      const orig = sc.orders.find(o => o.id === orderId);
      if (orig && orig.locked !== isLocked) {
        mods.push({ type: 'lock_order', orderId, locked: isLocked, description: `${isLocked ? '锁定' : '解锁'}订单 ${orderId}` });
      }
    });

    // Priority changes
    const prioInputs = document.querySelectorAll('.adj-priority-input');
    const prioChanges = [];
    prioInputs.forEach(input => {
      const orderId = input.dataset.orderId;
      const newPrio = parseInt(input.value);
      const orig = sc.orders.find(o => o.id === orderId);
      if (orig && orig.priority !== newPrio) {
        prioChanges.push({ orderId, priority: newPrio });
      }
    });
    if (prioChanges.length > 0) {
      mods.push({ type: 'priority_batch', changes: prioChanges, description: `调整 ${prioChanges.length} 个订单优先级` });
    }

    return mods;
  }

  function applyAdjustments() {
    if (!currentAdjustScenarioId) return;
    const mods = collectAdjustments();
    const sc = scenarioManager.getScenario(currentAdjustScenarioId);
    if (!sc) return;

    for (const mod of mods) {
      scenarioManager.applyModification(currentAdjustScenarioId, mod);
    }

    // Update maintenance windows from full override if present
    const maintMod = mods.find(m => m.type === 'maintenance_change');
    if (maintMod) {
      sc.maintenanceWindows = deepClone(maintMod.windows);
    }

    closeModal('scenarioAdjustModal');
    renderScenarioCards();

    if (mods.length > 0) {
      // Invalidate any in-flight calculation for this scenario
      sc.calcVersion = (sc.calcVersion || 0) + 1;
      setStatus(`方案 "${sc.name}" 已应用 ${mods.length} 项调整，正在重算...`);
      // Auto recalculate
      window.recalcScenario(currentAdjustScenarioId);
    } else {
      setStatus(`方案 "${sc.name}" 无变更`);
    }
  }

  // Handle inserted order in scenario adjust
  function handleScenarioInsertOrder() {
    const sc = scenarioManager.getScenario(currentAdjustScenarioId);
    if (!sc) return;

    const newOrder = {
      id: document.getElementById('scInsertOrderId').value || 'URGENT-' + Date.now(),
      productType: document.getElementById('scInsertProduct').value || '紧急产品',
      quantity: parseInt(document.getElementById('scInsertQty').value) || 10,
      deadline: fromLocalDatetime(document.getElementById('scInsertDeadline').value) || new Date(Date.now() + 86400000 * 3).toISOString().slice(0, 16),
      priority: parseInt(document.getElementById('scInsertPriority').value) || 5,
      locked: false
    };

    // Create basic processes
    const newProcesses = [];
    if (sc.equipment.length > 0) {
      const eq = sc.equipment[0];
      newProcesses.push({
        id: `INS-${newOrder.id}-P1`,
        name: '紧急加工',
        equipmentId: eq.id,
        duration: 120,
        dependencies: [],
        orderId: newOrder.id
      });
    }

    scenarioManager.applyModification(currentAdjustScenarioId, {
      type: 'insert_order',
      order: newOrder,
      processes: newProcesses,
      description: `插单 ${newOrder.id}(${newOrder.productType})`
    });

    setStatus(`已添加插单 "${newOrder.id}"，点击"应用并重算"提交所有调整`);

    // Clear the form
    document.getElementById('scInsertOrderId').value = '';
    document.getElementById('scInsertProduct').value = '';
    document.getElementById('scInsertQty').value = '10';
  }

  // ========== Comparison ==========
  function showComparison() {
    const selectedIds = Array.from(scenarioCompareSet);
    if (selectedIds.length < 2) {
      alert('请至少选择2个方案进行对比（勾选方案卡片底部的"对比"复选框）');
      return;
    }

    // Build comparison checkboxes
    const selectContainer = document.getElementById('compareSelect');
    const allScenarios = scenarioManager.getAllScenarios();
    selectContainer.innerHTML = allScenarios.map(sc => `
      <label>
        <input type="checkbox" value="${sc.id}" ${selectedIds.includes(sc.id) ? 'checked' : ''}
               onchange="updateCompareSet('${sc.id}', this.checked)">
        ${sc.name}
      </label>
    `).join('');

    renderComparisonTable(selectedIds);
    openModal('compareModal');
  }

  window.updateCompareSet = function(id, checked) {
    if (checked) scenarioCompareSet.add(id);
    else scenarioCompareSet.delete(id);
    renderComparisonTable(Array.from(scenarioCompareSet));
  };

  function renderComparisonTable(scenarioIds) {
    const scenarios = scenarioIds.map(id => scenarioManager.getScenario(id)).filter(Boolean);
    if (scenarios.length === 0) return;

    const head = document.getElementById('compareHead');
    const body = document.getElementById('compareBody');

    // Header row
    head.innerHTML = `<tr>
      <th>指标</th>
      ${scenarios.map(sc => `<th>${sc.name}</th>`).join('')}
    </tr>`;

    // Get comparison data
    const comparison = scenarioManager.compare(scenarioIds);

    // Metric rows
    const metrics = [
      { key: 'completionTimeStr', label: '总完工时间', numericKey: 'totalCompletionTime' },
      { key: 'delayedOrders', label: '延期订单数' },
      { key: 'avgUtilization', label: '平均设备利用率(%)' },
      { key: 'totalChangeovers', label: '换线次数' },
      { key: 'shiftOverloads', label: '班次超负荷数' },
      { key: 'conflictCount', label: '冲突数量' },
      { key: 'totalAlerts', label: '告警总数' },
      { key: 'totalRisks', label: '风险总数' },
      { key: 'scheduledCount', label: '排产工序数' }
    ];

    let rows = metrics.map(m => {
      const values = scenarios.map(sc => {
        const val = sc.metrics ? sc.metrics[m.key] : '-';
        return val !== undefined && val !== null ? val : '-';
      });

      // Highlight best/worst for numeric metrics
      const numKey = m.numericKey || m.key;
      const diff = comparison && comparison.diffs[numKey];
      const highlighted = values.map((v, i) => {
        if (!diff || typeof v !== 'number') return `<td>${v}</td>`;
        const isLowerBetter = diff.isLowerBetter;
        if (v === diff.best && diff.best !== diff.worst) {
          return `<td class="${isLowerBetter ? 'diff-better' : 'diff-worse'}" style="background:rgba(52,211,153,0.1)">${v}</td>`;
        }
        if (v === diff.worst && diff.best !== diff.worst) {
          return `<td class="${isLowerBetter ? 'diff-worse' : 'diff-better'}" style="background:rgba(248,113,113,0.1)">${v}</td>`;
        }
        return `<td>${v}</td>`;
      });

      return `<tr><td class="row-label">${m.label}</td>${highlighted.join('')}</tr>`;
    });

    // Equipment utilization detail row
    const equipUtilRow = scenarios.map(sc => {
      const util = sc.metrics ? sc.metrics.equipUtilization : {};
      if (!util || Object.keys(util).length === 0) return '<td>-</td>';
      return `<td style="font-size:10px;text-align:left">${Object.entries(util).map(([k, v]) => `${k}: ${v}%`).join('<br>')}</td>`;
    });
    rows.push(`<tr><td class="row-label">各设备利用率</td>${equipUtilRow.join('')}</tr>`);

    // Shift load detail row
    const shiftLoadRow = scenarios.map(sc => {
      const load = sc.metrics ? sc.metrics.shiftLoad : {};
      if (!load || Object.keys(load).length === 0) return '<td>-</td>';
      return `<td style="font-size:10px;text-align:left">${Object.entries(load).map(([k, v]) => `${k}: ${v}%`).join('<br>')}</td>`;
    });
    rows.push(`<tr><td class="row-label">各班次负荷</td>${shiftLoadRow.join('')}</tr>`);

    // Delayed orders detail
    const delayDetailRow = scenarios.map(sc => {
      const delays = sc.metrics ? sc.metrics.orderDelays : [];
      if (!delays || delays.length === 0) return '<td style="color:#34d399">✅ 无延期</td>';
      return `<td style="font-size:10px;text-align:left;color:#f87171">${delays.map(d => `${d.orderId}: 超${d.delayHours}h`).join('<br>')}</td>`;
    });
    rows.push(`<tr><td class="row-label">延期详情</td>${delayDetailRow.join('')}</tr>`);

    // Modifications row
    const modsRow = scenarios.map(sc => {
      const mods = sc.modifications || [];
      if (mods.length === 0) return '<td style="color:#94a3b8">无调整</td>';
      return `<td><div class="compare-mods">${mods.map(m => `<span class="compare-mod-tag">${m.description}</span>`).join('')}</div></td>`;
    });
    rows.push(`<tr><td class="row-label">调整项</td>${modsRow.join('')}</tr>`);

    body.innerHTML = rows.join('');
  }

  // ========== Rollback ==========
  function rollbackToScenario() {
    const selectedIds = Array.from(scenarioCompareSet);
    if (selectedIds.length !== 1) {
      alert('请选择恰好一个方案进行回滚（在对比面板中只勾选一个方案）');
      return;
    }
    const scId = selectedIds[0];
    const sc = scenarioManager.getScenario(scId);
    if (!sc) return;

    // Consistency verification: ensure scenario data is fresh
    const validation = scenarioManager.validateConsistency(scId);
    if (!validation.valid) {
      alert(`无法回滚：${validation.reason}\n请先重新计算此方案。`);
      return;
    }

    // Warn if scenario has pending/running calculations
    if (sc.status === 'calculating') {
      alert('方案正在计算中，请等待完成后再回滚');
      return;
    }

    if (!confirm(`确定要将方案 "${sc.name}" 应用为主排产吗？\n当前主排产数据将被替换。`)) return;

    const rollbackData = scenarioManager.rollbackToScenario(scId);
    if (rollbackData) {
      Object.assign(state, rollbackData);
      history.push(state.scheduled);
      closeModal('compareModal');
      onScheduleUpdated();
      setStatus(`已回滚到方案 "${sc.name}"`);
    }
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
      const viewData = getViewData();
      const isScenario = sandboxMode && scenarioManager.activeId;
      Exporter.exportScheduleCSV(
        viewData.scheduled || [],
        viewData.orders || [],
        viewData.equipment || []
      );
      setStatus(isScenario ? `方案排产表已导出` : '排产表已导出');
    });
    document.getElementById('btnExportRisk').addEventListener('click', () => {
      const viewData = getViewData();
      const isScenario = sandboxMode && scenarioManager.activeId;
      Exporter.exportRiskReport(
        viewData.alerts || [],
        viewData.risks || [],
        viewData.scheduled || [],
        viewData.orders || []
      );
      setStatus(isScenario ? `方案风险报告已导出` : '风险报告已导出');
    });

    // Undo/Redo
    document.getElementById('btnUndo').addEventListener('click', () => {
      // If viewing a scenario, undo within that scenario
      if (sandboxMode && scenarioManager.activeId) {
        const sc = scenarioManager.getActiveScenario();
        if (sc) {
          const prev = sc.history.undo();
          if (prev) {
            sc.scheduled = prev;
            renderGantt();
            setStatus('方案内已撤销');
          }
        }
        return;
      }
      const prev = history.undo();
      if (prev) {
        state.scheduled = prev;
        renderGantt();
        setStatus('已撤销');
      }
    });
    document.getElementById('btnRedo').addEventListener('click', () => {
      if (sandboxMode && scenarioManager.activeId) {
        const sc = scenarioManager.getActiveScenario();
        if (sc) {
          const next = sc.history.redo();
          if (next) {
            sc.scheduled = next;
            renderGantt();
            setStatus('方案内已重做');
          }
        }
        return;
      }
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

    // ===== Sandbox / Scenario Events =====

    // Sandbox toggle
    document.getElementById('btnSandbox').addEventListener('click', () => {
      if (sandboxMode) {
        if (confirm('退出沙盘将丢弃所有 What-if 方案，确定退出？')) {
          exitSandbox();
        }
      } else {
        enterSandbox();
      }
    });

    // Add scenario
    document.getElementById('btnAddScenario').addEventListener('click', createNewScenario);

    // Compare scenarios
    document.getElementById('btnCompareScenarios').addEventListener('click', showComparison);

    // Export comparison
    document.getElementById('btnExportComparison').addEventListener('click', () => {
      const selectedIds = Array.from(scenarioCompareSet);
      if (selectedIds.length < 2) {
        alert('请至少选择2个方案导出对比报告');
        return;
      }
      const scenarios = selectedIds.map(id => scenarioManager.getScenario(id)).filter(Boolean);
      if (scenarios.length < 2) {
        alert('选中的方案不存在');
        return;
      }
      // Verify all scenarios are in ready state
      const notReady = scenarios.filter(sc => sc.status !== 'ready');
      if (notReady.length > 0) {
        const names = notReady.map(sc => `"${sc.name}"(${sc.status === 'calculating' ? '计算中' : '未计算'})`).join('、');
        alert(`以下方案尚未完成计算，请先重算后再导出：\n${names}`);
        return;
      }
      // Verify data consistency for each scenario
      const inconsistencies = [];
      for (const sc of scenarios) {
        const v = scenarioManager.validateConsistency(sc.id);
        if (!v.valid) {
          inconsistencies.push(`"${sc.name}": ${v.reason}`);
        }
      }
      if (inconsistencies.length > 0) {
        alert(`以下方案数据不一致，请重新计算后再导出：\n${inconsistencies.join('\n')}`);
        return;
      }
      Exporter.exportComparisonReport(scenarios, scenarioManager.compare(selectedIds));
      setStatus('对比报告已导出');
    });

    // Exit sandbox
    document.getElementById('btnExitSandbox').addEventListener('click', () => {
      if (confirm('退出沙盘将丢弃所有 What-if 方案，确定退出？')) {
        exitSandbox();
      }
    });

    // Adjustment modal tabs
    document.querySelectorAll('.adjust-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.adjust-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.adjust-panel').forEach(p => p.classList.add('hidden'));
        tab.classList.add('active');
        const panelMap = {
          shifts: 'adjustPanelShifts',
          maintenance: 'adjustPanelMaintenance',
          materials: 'adjustPanelMaterials',
          insertOrder: 'adjustPanelInsertOrder',
          lockOrder: 'adjustPanelLockOrder',
          priority: 'adjustPanelPriority'
        };
        const panelId = panelMap[tab.dataset.atab];
        if (panelId) document.getElementById(panelId).classList.remove('hidden');
      });
    });

    // Apply adjustments
    document.getElementById('btnApplyAdjust').addEventListener('click', applyAdjustments);

    // Scenario insert order
    document.getElementById('btnScDoInsert').addEventListener('click', handleScenarioInsertOrder);

    // Add shift button
    document.getElementById('btnAddShift').addEventListener('click', () => {
      const container = document.getElementById('adjustShiftsList');
      const idx = container.children.length;
      const div = document.createElement('div');
      div.className = 'adjust-row';
      div.dataset.index = idx;
      div.innerHTML = `
        <label>班次名称</label>
        <input type="text" class="adj-shift-name" value="新班次">
        <label>班组</label>
        <input type="text" class="adj-shift-team" value="新班组">
        <label>开始</label>
        <input type="time" class="adj-shift-start" value="08:00">
        <label>结束</label>
        <input type="time" class="adj-shift-end" value="16:00">
        <label>跨天</label>
        <select class="adj-shift-cross">
          <option value="false" selected>否</option>
          <option value="true">是</option>
        </select>
        <button class="btn-remove" onclick="this.parentElement.remove()">×</button>`;
      container.appendChild(div);
    });

    // Add maintenance button
    document.getElementById('btnAddMaint').addEventListener('click', () => {
      const container = document.getElementById('adjustMaintList');
      const idx = container.children.length;
      const tomorrow = new Date(Date.now() + 86400000);
      const div = document.createElement('div');
      div.className = 'adjust-row';
      div.dataset.index = idx;
      div.innerHTML = `
        <label>设备</label>
        <input type="text" class="adj-maint-equip" value="${(state.equipment[0] || {}).id || 'EQ01'}">
        <label>开始</label>
        <input type="datetime-local" class="adj-maint-start" value="${tomorrow.toISOString().slice(0, 16)}">
        <label>结束</label>
        <input type="datetime-local" class="adj-maint-end" value="${new Date(tomorrow.getTime() + 3600000 * 4).toISOString().slice(0, 16)}">
        <label>类型</label>
        <input type="text" class="adj-maint-type" value="维护">
        <button class="btn-remove" onclick="this.parentElement.remove()">×</button>`;
      container.appendChild(div);
    });

    // Rollback
    document.getElementById('btnRollbackScenario').addEventListener('click', rollbackToScenario);

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
    const viewData = getViewData();
    const order = (viewData.orders || []).find(o => o.id === task.orderId) || {};
    const equip = (viewData.equipment || []).find(e => e.id === task.equipmentId) || {};
    const deps = (task.dependencies || []).map(d => {
      const depTask = (viewData.processes || []).find(p => p.id === d);
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

  // ========== Utility ==========
  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
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
