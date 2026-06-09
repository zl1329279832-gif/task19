// ========== Sandbox Manager - Multi-Scenario What-If Analysis ==========

const KPI_DEFS = [
  { key: 'makespan',           label: '总完工时间', unit: '小时', better: 'lower' },
  { key: 'overdueCount',       label: '延期订单数', unit: '个',   better: 'lower' },
  { key: 'equipUtilization',   label: '设备利用率', unit: '%',    better: 'higher' },
  { key: 'changeoverCount',    label: '换线次数',   unit: '次',   better: 'lower' },
  { key: 'shiftOverloadCount', label: '班次超负荷', unit: '个',   better: 'lower' },
  { key: 'conflictCount',      label: '冲突数量',   unit: '个',   better: 'lower' }
];

class SandboxManager {
  constructor() {
    this.scenarios = [];
    this.activeScenarioId = null;
    this.isSandboxMode = false;
    this.computeQueue = [];
    this.isComputing = false;
    this.maxScenarios = 10;
    this._editingId = null;
    this._editTab = 'shifts';

    // Callbacks bound by app.js
    this.onScenarioSwitch = null;
    this.onScenarioCompute = null;
    this.onScenariosChange = null;
  }

  // ==================== Scenario CRUD ====================

  createScenario(name, stateSnapshot) {
    if (this.scenarios.length >= this.maxScenarios) return null;
    const sc = {
      id: 'sc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name: name,
      createdAt: Date.now(),
      orders: JSON.parse(JSON.stringify(stateSnapshot.orders || [])),
      processes: JSON.parse(JSON.stringify(stateSnapshot.processes || [])),
      equipment: JSON.parse(JSON.stringify(stateSnapshot.equipment || [])),
      shifts: JSON.parse(JSON.stringify(stateSnapshot.shifts || [])),
      materials: JSON.parse(JSON.stringify(stateSnapshot.materials || [])),
      routes: JSON.parse(JSON.stringify(stateSnapshot.routes || [])),
      maintenanceWindows: JSON.parse(JSON.stringify(stateSnapshot.maintenanceWindows || [])),
      scheduled: JSON.parse(JSON.stringify(stateSnapshot.scheduled || [])),
      alerts: stateSnapshot.alerts ? [...stateSnapshot.alerts] : [],
      risks: stateSnapshot.risks ? [...stateSnapshot.risks] : [],
      kpi: { makespan: 0, overdueCount: 0, equipUtilization: 0, changeoverCount: 0, shiftOverloadCount: 0, conflictCount: 0 },
      history: new HistoryManager(50),
      calcStatus: 'done'
    };
    if (sc.scheduled.length > 0) {
      sc.history.push(sc.scheduled);
      this.calcKPI(sc);
    }
    this.scenarios.push(sc);
    if (this.onScenariosChange) this.onScenariosChange();
    return sc;
  }

  deleteScenario(id) {
    const idx = this.scenarios.findIndex(s => s.id === id);
    if (idx === -1) return;
    this.scenarios.splice(idx, 1);
    if (this.activeScenarioId === id) {
      this.activeScenarioId = null;
      if (this.scenarios.length > 0) {
        this.switchTo(this.scenarios[0].id);
      }
    }
    if (this._editingId === id) {
      this._editingId = null;
    }
    if (this.onScenariosChange) this.onScenariosChange();
  }

  duplicateScenario(id) {
    const src = this.getScenario(id);
    if (!src || this.scenarios.length >= this.maxScenarios) return null;
    return this.createScenario(src.name + ' (副本)', src);
  }

  renameScenario(id, newName) {
    const sc = this.getScenario(id);
    if (sc) { sc.name = newName; if (this.onScenariosChange) this.onScenariosChange(); }
  }

  getScenario(id) {
    return this.scenarios.find(s => s.id === id) || null;
  }

  getActiveScenario() {
    return this.activeScenarioId ? this.getScenario(this.activeScenarioId) : null;
  }

  // ==================== Scenario Switch ====================

  switchTo(id) {
    const sc = this.getScenario(id);
    if (!sc) return;
    this.activeScenarioId = id;
    if (this.onScenarioSwitch) this.onScenarioSwitch(sc);
    this.renderPanel();
  }

  // ==================== Compute Scheduling ====================

  computeAll() {
    this.computeQueue = [];
    for (const sc of this.scenarios) {
      if (sc.calcStatus === 'pending' || sc.calcStatus === 'done') {
        sc.calcStatus = 'pending';
        this.computeQueue.push(sc.id);
      }
    }
    this.renderPanel();
    this._processQueue();
  }

  computeOne(id) {
    const sc = this.getScenario(id);
    if (!sc) return;
    sc.calcStatus = 'pending';
    if (!this.computeQueue.includes(id)) this.computeQueue.push(id);
    this.renderPanel();
    if (!this.isComputing) this._processQueue();
  }

  _processQueue() {
    if (this.computeQueue.length === 0) { this.isComputing = false; return; }
    this.isComputing = true;
    const id = this.computeQueue.shift();
    const sc = this.getScenario(id);
    if (!sc) { this._processQueue(); return; }
    sc.calcStatus = 'computing';
    this.renderPanel();
    if (this.onScenarioCompute) this.onScenarioCompute(sc);
  }

  handleComputeResult(scenarioId, result) {
    const sc = this.getScenario(scenarioId);
    if (!sc) { this.isComputing = false; this._processQueue(); return; }
    sc.scheduled = result.scheduled || [];
    sc.alerts = result.alerts || [];
    sc.calcStatus = 'done';
    sc.history.push(sc.scheduled);
    this.calcKPI(sc);

    // If this scenario is currently active, sync UI
    if (this.activeScenarioId === scenarioId && this.onScenarioSwitch) {
      this.onScenarioSwitch(sc);
    }
    this.isComputing = false;
    this._processQueue();
    if (this.onScenariosChange) this.onScenariosChange();
  }

  // ==================== KPI Calculation ====================

  calcKPI(scenario) {
    const { scheduled, alerts, orders, equipment, maintenanceWindows } = scenario;
    const kpi = { makespan: 0, overdueCount: 0, equipUtilization: 0, changeoverCount: 0, shiftOverloadCount: 0, conflictCount: 0 };

    if (!scheduled || scheduled.length === 0) { scenario.kpi = kpi; return; }

    const allStarts = scheduled.map(s => s.scheduledStart).filter(Boolean);
    const allEnds = scheduled.map(s => s.scheduledEnd).filter(Boolean);
    if (allStarts.length === 0 || allEnds.length === 0) { scenario.kpi = kpi; return; }

    const minStart = Math.min(...allStarts);
    const maxEnd = Math.max(...allEnds);

    // 1. Makespan (hours)
    kpi.makespan = Math.round(((maxEnd - minStart) / 3600000) * 10) / 10;

    // 2. Overdue orders
    for (const order of (orders || [])) {
      const procs = scheduled.filter(s => s.orderId === order.id);
      if (procs.length === 0) continue;
      const lastEnd = Math.max(...procs.map(p => p.scheduledEnd || 0));
      const deadline = new Date(order.deadline).getTime();
      if (deadline && lastEnd > deadline) kpi.overdueCount++;
    }

    // 3. Equipment utilization
    const equipBusy = new Map();
    for (const s of scheduled) {
      if (!s.equipmentId || !s.scheduledStart || !s.scheduledEnd) continue;
      equipBusy.set(s.equipmentId, (equipBusy.get(s.equipmentId) || 0) + (s.scheduledEnd - s.scheduledStart));
    }
    const totalRange = maxEnd - minStart;
    let totalBusy = 0, totalAvailable = 0;
    for (const eq of (equipment || [])) {
      totalBusy += (equipBusy.get(eq.id) || 0);
      let maintTime = 0;
      for (const mw of (maintenanceWindows || [])) {
        if (mw.equipmentId === eq.id) {
          const ms = new Date(mw.start).getTime();
          const me = new Date(mw.end).getTime();
          const overlap = Math.min(me, maxEnd) - Math.max(ms, minStart);
          if (overlap > 0) maintTime += overlap;
        }
      }
      totalAvailable += (totalRange - maintTime);
    }
    kpi.equipUtilization = totalAvailable > 0 ? Math.round((totalBusy / totalAvailable) * 1000) / 1000 : 0;

    // 4. Changeover count
    const byEquip = new Map();
    for (const s of scheduled) {
      if (!s.equipmentId) continue;
      if (!byEquip.has(s.equipmentId)) byEquip.set(s.equipmentId, []);
      byEquip.get(s.equipmentId).push(s);
    }
    let totalChangeovers = 0;
    for (const [, tasks] of byEquip) {
      tasks.sort((a, b) => (a.scheduledStart || 0) - (b.scheduledStart || 0));
      for (let i = 1; i < tasks.length; i++) {
        if (tasks[i].orderProductType !== tasks[i - 1].orderProductType) totalChangeovers++;
      }
    }
    kpi.changeoverCount = totalChangeovers;

    // 5. Shift overload count (from alerts)
    kpi.shiftOverloadCount = (alerts || []).filter(a => a.message && a.message.includes('负荷率')).length;

    // 6. Conflict count (critical alerts)
    kpi.conflictCount = (alerts || []).filter(a => a.type === 'critical').length;

    scenario.kpi = kpi;
  }

  // ==================== Comparison Data ====================

  getComparisonData() {
    const done = this.scenarios.filter(s => s.calcStatus === 'done' && s.scheduled.length > 0);
    if (done.length < 2) return null;
    const result = [];
    for (const def of KPI_DEFS) {
      const vals = done.map(s => s.kpi[def.key]);
      let bestIdx = -1, worstIdx = -1;
      if (def.better === 'lower') {
        bestIdx = vals.indexOf(Math.min(...vals));
        worstIdx = vals.indexOf(Math.max(...vals));
      } else {
        bestIdx = vals.indexOf(Math.max(...vals));
        worstIdx = vals.indexOf(Math.min(...vals));
      }
      // Only highlight if values differ
      if (vals[bestIdx] === vals[worstIdx]) { bestIdx = -1; worstIdx = -1; }
      result.push({ def, vals, bestIdx, worstIdx });
    }
    return { scenarios: done, rows: result };
  }

  // ==================== Export ====================

  exportComparisonCSV() {
    const done = this.scenarios.filter(s => s.calcStatus === 'done');
    if (done.length === 0) return;
    let csv = '指标';
    for (const sc of done) csv += ',' + sc.name;
    csv += '\n';
    for (const def of KPI_DEFS) {
      csv += def.label + '(' + def.unit + ')';
      for (const sc of done) {
        let val = sc.kpi[def.key];
        if (def.key === 'equipUtilization') val = (val * 100).toFixed(1);
        else if (typeof val === 'number' && val % 1 !== 0) val = val.toFixed(1);
        csv += ',' + val;
      }
      csv += '\n';
    }
    csv += '\n创建时间';
    for (const sc of done) csv += ',' + new Date(sc.createdAt).toLocaleString('zh-CN');
    csv += '\n计算状态';
    for (const sc of done) csv += ',' + sc.calcStatus;
    csv += '\n排程工序数';
    for (const sc of done) csv += ',' + sc.scheduled.length;
    csv += '\n告警数';
    for (const sc of done) csv += ',' + (sc.alerts || []).length;
    csv += '\n';

    if (typeof Exporter !== 'undefined') {
      Exporter.download('方案对比报告_' + Exporter.dateStr() + '.csv', csv);
    }
  }

  // ==================== UI Rendering ====================

  renderPanel() {
    this.renderScenarioList();
    this.renderKPIComparison();
    if (this._editingId) this.renderParamEditor(this._editingId);
  }

  renderScenarioList() {
    const el = document.getElementById('scenarioList');
    if (!el) return;
    if (this.scenarios.length === 0) {
      el.innerHTML = '<p class="empty-hint">点击"+ 新建方案"开始对比分析</p>';
      return;
    }
    let html = '';
    for (const sc of this.scenarios) {
      const isActive = sc.id === this.activeScenarioId;
      const statusClass = sc.calcStatus === 'computing' ? 'computing' : sc.calcStatus === 'done' ? 'done' : sc.calcStatus === 'error' ? 'error' : '';
      const statusText = sc.calcStatus === 'computing' ? '计算中...' : sc.calcStatus === 'done' ? '已完成' : sc.calcStatus === 'error' ? '计算失败' : '待计算';
      html += '<div class="scenario-card' + (isActive ? ' active' : '') + '" onclick="switchScenario(\'' + sc.id + '\')">';
      html += '<div class="sc-name">' + this._esc(sc.name) + '</div>';
      html += '<div class="sc-status ' + statusClass + '">' + statusText;
      if (sc.calcStatus === 'done' && sc.scheduled.length > 0) {
        html += ' | ' + sc.scheduled.length + '工序';
      }
      html += '</div>';
      html += '<div class="sc-actions">';
      html += '<button onclick="event.stopPropagation();editScenarioParams(\'' + sc.id + '\')" title="编辑参数">编辑</button>';
      html += '<button onclick="event.stopPropagation();duplicateScenario(\'' + sc.id + '\')" title="复制方案">复制</button>';
      html += '<button class="btn-apply" onclick="event.stopPropagation();applyScenarioToMain(\'' + sc.id + '\')" title="应用为当前排产">应用</button>';
      html += '<button class="btn-delete" onclick="event.stopPropagation();deleteScenario(\'' + sc.id + '\')" title="删除方案">删除</button>';
      html += '</div></div>';
    }
    el.innerHTML = html;
  }

  renderKPIComparison() {
    const el = document.getElementById('kpiComparison');
    if (!el) return;
    const comp = this.getComparisonData();
    if (!comp) {
      el.innerHTML = this.scenarios.length > 0
        ? '<p class="empty-hint">至少需要2个已完成计算的方案才能对比</p>'
        : '';
      return;
    }
    let html = '<h4 class="kpi-title">KPI 对比</h4>';
    html += '<table class="kpi-table"><thead><tr><th>指标</th>';
    for (const sc of comp.scenarios) {
      const isActive = sc.id === this.activeScenarioId;
      html += '<th' + (isActive ? ' class="kpi-active-col"' : '') + '>' + this._esc(sc.name) + '</th>';
    }
    html += '</tr></thead><tbody>';
    for (const row of comp.rows) {
      html += '<tr><td>' + row.def.label + '<span class="kpi-unit">(' + row.def.unit + ')</span></td>';
      for (let i = 0; i < row.vals.length; i++) {
        let val = row.vals[i];
        if (row.def.key === 'equipUtilization') val = (val * 100).toFixed(1);
        else if (typeof val === 'number' && val % 1 !== 0) val = val.toFixed(1);
        let cls = '';
        if (i === row.bestIdx) cls = ' class="kpi-best"';
        else if (i === row.worstIdx) cls = ' class="kpi-worst"';
        html += '<td' + cls + '>' + val + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    el.innerHTML = html;
  }

  renderParamEditor(id) {
    const sc = this.getScenario(id);
    const editorEl = document.getElementById('scenarioEditor');
    if (!sc || !editorEl) { if (editorEl) editorEl.classList.add('hidden'); return; }

    this._editingId = id;
    editorEl.classList.remove('hidden');
    document.getElementById('editorTitle').textContent = '参数调整: ' + sc.name;

    // Bind tab clicks
    const tabs = editorEl.querySelectorAll('.editor-tab');
    tabs.forEach(t => {
      t.classList.toggle('active', t.dataset.etab === this._editTab);
      t.onclick = () => { this._editTab = t.dataset.etab; tabs.forEach(tt => tt.classList.toggle('active', tt === t)); this._renderEditorContent(sc); };
    });

    this._renderEditorContent(sc);
  }

  _renderEditorContent(sc) {
    const el = document.getElementById('editorContent');
    if (!el) return;
    let html = '';

    switch (this._editTab) {
      case 'shifts':
        html += '<div class="param-section-title">班次列表</div>';
        for (let i = 0; i < sc.shifts.length; i++) {
          const s = sc.shifts[i];
          html += '<div class="param-row">';
          html += '<label>' + this._esc(s.name) + ' (' + this._esc(s.team) + ')</label>';
          html += '<input type="time" value="' + (s.startTime || '') + '" onchange="sandboxUpdateShift(\'' + sc.id + '\',' + i + ',\'startTime\',this.value)">';
          html += '<span>~</span>';
          html += '<input type="time" value="' + (s.endTime || '') + '" onchange="sandboxUpdateShift(\'' + sc.id + '\',' + i + ',\'endTime\',this.value)">';
          html += '<label class="param-checkbox"><input type="checkbox"' + (s.crossDay ? ' checked' : '') + ' onchange="sandboxUpdateShift(\'' + sc.id + '\',' + i + ',\'crossDay\',this.checked)"> 跨天</label>';
          html += '</div>';
        }
        html += '<button class="btn btn-sm" onclick="sandboxAddShift(\'' + sc.id + '\')">+ 添加班次</button>';
        break;

      case 'maintenance':
        html += '<div class="param-section-title">设备维护窗口</div>';
        for (let i = 0; i < sc.maintenanceWindows.length; i++) {
          const mw = sc.maintenanceWindows[i];
          html += '<div class="param-row">';
          html += '<label>' + this._esc(mw.equipmentId) + ' (' + this._esc(mw.type || '') + ')</label>';
          html += '<input type="datetime-local" value="' + this._toLocalISOStr(mw.start) + '" onchange="sandboxUpdateMaint(\'' + sc.id + '\',' + i + ',\'start\',this.value)">';
          html += '<span>~</span>';
          html += '<input type="datetime-local" value="' + this._toLocalISOStr(mw.end) + '" onchange="sandboxUpdateMaint(\'' + sc.id + '\',' + i + ',\'end\',this.value)">';
          html += '<button class="btn-delete btn-xs" onclick="sandboxRemoveMaint(\'' + sc.id + '\',' + i + ')">x</button>';
          html += '</div>';
        }
        html += '<button class="btn btn-sm" onclick="sandboxAddMaint(\'' + sc.id + '\')">+ 添加维护窗口</button>';
        break;

      case 'materials':
        html += '<div class="param-section-title">物料到货时间</div>';
        for (let i = 0; i < sc.materials.length; i++) {
          const m = sc.materials[i];
          html += '<div class="param-row">';
          html += '<label>' + this._esc(m.name || m.id) + ' (' + this._esc(m.orderId) + ')</label>';
          html += '<input type="datetime-local" value="' + this._toLocalISOStr(m.arrivalTime) + '" onchange="sandboxUpdateMaterial(\'' + sc.id + '\',' + i + ',this.value)">';
          html += '</div>';
        }
        break;

      case 'orders':
        html += '<div class="param-section-title">订单优先级与锁定</div>';
        for (let i = 0; i < sc.orders.length; i++) {
          const o = sc.orders[i];
          html += '<div class="param-row">';
          html += '<label>' + this._esc(o.id) + ' (' + this._esc(o.productType) + ')</label>';
          html += '<select onchange="sandboxUpdateOrder(\'' + sc.id + '\',' + i + ',\'priority\',+this.value)">';
          for (let p = 5; p >= 1; p--) {
            html += '<option value="' + p + '"' + (o.priority === p ? ' selected' : '') + '>' + p + '</option>';
          }
          html += '</select>';
          html += '<label class="param-checkbox"><input type="checkbox"' + (o.locked ? ' checked' : '') + ' onchange="sandboxUpdateOrder(\'' + sc.id + '\',' + i + ',\'locked\',this.checked)"> 锁定</label>';
          html += '</div>';
        }
        // Urgent insert
        html += '<div class="param-divider"></div>';
        html += '<div class="param-section-title">紧急插单</div>';
        html += '<div class="param-row">';
        html += '<input type="text" id="sbInsertId" placeholder="订单编号" style="width:80px">';
        html += '<input type="text" id="sbInsertProduct" placeholder="产品名称" style="width:80px">';
        html += '<input type="number" id="sbInsertQty" placeholder="数量" value="10" style="width:60px">';
        html += '<input type="datetime-local" id="sbInsertDeadline" style="width:160px">';
        html += '<button class="btn btn-sm" onclick="sandboxInsertOrder(\'' + sc.id + '\')">插入</button>';
        html += '</div>';
        break;
    }
    el.innerHTML = html;
  }

  // ==================== Param Update Helpers ====================

  updateShift(id, index, field, value) {
    const sc = this.getScenario(id);
    if (!sc || !sc.shifts[index]) return;
    sc.shifts[index][field] = value;
    sc.calcStatus = 'pending';
    this.renderPanel();
  }

  addShift(id) {
    const sc = this.getScenario(id);
    if (!sc) return;
    sc.shifts.push({ name: '新班次', team: '新班组', startTime: '08:00', endTime: '16:00', crossDay: false });
    sc.calcStatus = 'pending';
    this._renderEditorContent(sc);
  }

  updateMaintenance(id, index, field, value) {
    const sc = this.getScenario(id);
    if (!sc || !sc.maintenanceWindows[index]) return;
    sc.maintenanceWindows[index][field] = value;
    sc.calcStatus = 'pending';
    this.renderPanel();
  }

  addMaintenance(id) {
    const sc = this.getScenario(id);
    if (!sc || sc.equipment.length === 0) return;
    const now = new Date();
    const later = new Date(now.getTime() + 4 * 3600000);
    sc.maintenanceWindows.push({
      equipmentId: sc.equipment[0].id,
      start: now.toISOString().slice(0, 16).replace('T', ' '),
      end: later.toISOString().slice(0, 16).replace('T', ' '),
      type: '临时维护'
    });
    sc.calcStatus = 'pending';
    this._renderEditorContent(sc);
  }

  removeMaintenance(id, index) {
    const sc = this.getScenario(id);
    if (!sc) return;
    sc.maintenanceWindows.splice(index, 1);
    sc.calcStatus = 'pending';
    this._renderEditorContent(sc);
  }

  updateMaterial(id, index, value) {
    const sc = this.getScenario(id);
    if (!sc || !sc.materials[index]) return;
    sc.materials[index].arrivalTime = value.replace('T', ' ');
    sc.calcStatus = 'pending';
    this.renderPanel();
  }

  updateOrder(id, index, field, value) {
    const sc = this.getScenario(id);
    if (!sc || !sc.orders[index]) return;
    sc.orders[index][field] = value;
    sc.calcStatus = 'pending';
    this.renderPanel();
  }

  insertUrgentOrder(id, orderData) {
    const sc = this.getScenario(id);
    if (!sc) return;
    sc.orders.push(orderData);
    sc.calcStatus = 'pending';
    this.renderPanel();
  }

  // ==================== Utility ====================

  _esc(str) {
    if (!str) return '';
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  _toLocalISOStr(dateStr) {
    if (!dateStr) return '';
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return '';
      const pad = (n) => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    } catch (e) { return ''; }
  }
}
