// ========== Scenario Manager: What-if Sandbox ==========
// Manages multiple production schedule scenarios for comparison

class ScenarioManager {
  constructor() {
    this.scenarios = new Map();   // id -> Scenario
    this.activeId = null;         // currently viewed scenario (null = baseline)
    this.baseline = null;         // snapshot of state when sandbox opened
    this.nextId = 1;
  }

  // ========== Lifecycle ==========

  // Enter sandbox mode: snapshot current state as baseline
  enterSandbox(baseState) {
    this.baseline = deepClone(baseState);
    this.scenarios.clear();
    this.activeId = null;
    this.nextId = 1;
  }

  // Exit sandbox: return baseline state
  exitSandbox() {
    const result = this.baseline ? deepClone(this.baseline) : null;
    this.scenarios.clear();
    this.baseline = null;
    this.activeId = null;
    return result;
  }

  // ========== Scenario CRUD ==========

  // Create a new scenario cloned from baseline (or current state)
  createScenario(name, sourceState) {
    const id = 'SC-' + String(this.nextId++).padStart(3, '0');
    const source = sourceState || this.baseline;
    const scenario = {
      id,
      name: name || `方案 ${this.nextId - 1}`,
      createdAt: new Date().toISOString(),
      // Isolated data copies
      orders: deepClone(source.orders || []),
      processes: deepClone(source.processes || []),
      equipment: deepClone(source.equipment || []),
      shifts: deepClone(source.shifts || []),
      materials: deepClone(source.materials || []),
      routes: deepClone(source.routes || []),
      maintenanceWindows: deepClone(source.maintenanceWindows || []),
      // Computed results
      scheduled: [],
      alerts: [],
      risks: [],
      // Isolated undo/redo stack
      history: new HistoryManager(30),
      // Modifications log
      modifications: [],
      // Metrics (computed after scheduling)
      metrics: null,
      // Status: pending | calculating | ready | error
      status: 'pending'
    };
    this.scenarios.set(id, scenario);
    return scenario;
  }

  // Duplicate an existing scenario
  duplicateScenario(sourceId, name) {
    const source = this.scenarios.get(sourceId);
    if (!source) return null;
    const dup = this.createScenario(name || `${source.name} (副本)`, source);
    // Copy scheduled results and metrics too
    dup.scheduled = deepClone(source.scheduled);
    dup.alerts = deepClone(source.alerts);
    dup.risks = deepClone(source.risks);
    dup.metrics = source.metrics ? { ...source.metrics } : null;
    dup.status = source.status;
    dup.modifications = deepClone(source.modifications);
    return dup;
  }

  deleteScenario(id) {
    this.scenarios.delete(id);
    if (this.activeId === id) this.activeId = null;
  }

  getScenario(id) {
    return this.scenarios.get(id) || null;
  }

  getActiveScenario() {
    return this.activeId ? this.scenarios.get(this.activeId) : null;
  }

  setActive(id) {
    if (id === null || this.scenarios.has(id)) {
      this.activeId = id;
    }
  }

  getAllScenarios() {
    return Array.from(this.scenarios.values());
  }

  // ========== Modifications ==========

  // Apply a modification to a scenario and log it
  applyModification(scenarioId, mod) {
    const sc = this.scenarios.get(scenarioId);
    if (!sc) return;

    switch (mod.type) {
      case 'shift_change':
        // Replace shifts array
        sc.shifts = deepClone(mod.shifts);
        break;

      case 'maintenance_change':
        // Replace or update maintenance windows
        if (mod.index !== undefined) {
          sc.maintenanceWindows[mod.index] = deepClone(mod.window);
        } else if (mod.action === 'add') {
          sc.maintenanceWindows.push(deepClone(mod.window));
        } else if (mod.action === 'remove') {
          sc.maintenanceWindows.splice(mod.index, 1);
        } else {
          sc.maintenanceWindows = deepClone(mod.windows);
        }
        break;

      case 'material_delay':
        // Update material arrival time
        const mat = sc.materials.find(m => m.id === mod.materialId);
        if (mat) {
          mat.arrivalTime = mod.newArrivalTime;
        }
        break;

      case 'material_batch_update':
        // Batch update material arrival times
        if (mod.updates) {
          for (const u of mod.updates) {
            const m = sc.materials.find(m => m.id === u.materialId);
            if (m) m.arrivalTime = u.newArrivalTime;
          }
        }
        break;

      case 'insert_order':
        // Add an urgent order
        sc.orders.push(deepClone(mod.order));
        if (mod.processes) {
          sc.processes.push(...deepClone(mod.processes));
        }
        break;

      case 'lock_order':
        // Toggle order lock
        const lockOrder = sc.orders.find(o => o.id === mod.orderId);
        if (lockOrder) {
          lockOrder.locked = mod.locked;
        }
        break;

      case 'priority_change':
        // Change order priority
        const prioOrder = sc.orders.find(o => o.id === mod.orderId);
        if (prioOrder) {
          prioOrder.priority = mod.priority;
        }
        break;

      case 'priority_batch':
        // Batch priority changes
        if (mod.changes) {
          for (const c of mod.changes) {
            const o = sc.orders.find(o => o.id === c.orderId);
            if (o) o.priority = c.priority;
          }
        }
        break;

      case 'full_override':
        // Replace any data field
        if (mod.field && mod.value !== undefined) {
          sc[mod.field] = deepClone(mod.value);
        }
        break;
    }

    sc.modifications.push({
      type: mod.type,
      description: mod.description || mod.type,
      timestamp: new Date().toISOString(),
      ...mod
    });
  }

  // ========== Metrics Computation ==========

  // Compute metrics for a scenario (call after scheduled is populated)
  computeMetrics(scenario) {
    const scheduled = scenario.scheduled || [];
    const orders = scenario.orders || [];
    const equipment = scenario.equipment || [];
    const shifts = scenario.shifts || [];

    // Total completion time (makespan)
    let totalCompletionTime = 0;
    if (scheduled.length > 0) {
      const minStart = Math.min(...scheduled.map(s => s.scheduledStart || Infinity));
      const maxEnd = Math.max(...scheduled.map(s => s.scheduledEnd || 0));
      totalCompletionTime = maxEnd - minStart; // ms
    }

    // Delayed orders count
    let delayedOrders = 0;
    const orderDelays = [];
    for (const order of orders) {
      const orderProcs = scheduled.filter(s => s.orderId === order.id);
      if (orderProcs.length === 0) continue;
      const lastEnd = Math.max(...orderProcs.map(p => p.scheduledEnd || 0));
      const deadline = new Date(order.deadline).getTime();
      if (lastEnd > deadline) {
        delayedOrders++;
        orderDelays.push({
          orderId: order.id,
          product: order.productType,
          delayHours: ((lastEnd - deadline) / 3600000).toFixed(1)
        });
      }
    }

    // Equipment utilization
    const equipUtil = {};
    if (scheduled.length > 0) {
      const minStart = Math.min(...scheduled.map(s => s.scheduledStart || Infinity));
      const maxEnd = Math.max(...scheduled.map(s => s.scheduledEnd || 0));
      const totalSpan = maxEnd - minStart;

      for (const eq of equipment) {
        const eqTasks = scheduled.filter(s => s.equipmentId === eq.id);
        let busyTime = 0;
        for (const t of eqTasks) {
          if (t.scheduledStart && t.scheduledEnd) {
            busyTime += t.scheduledEnd - t.scheduledStart;
          }
        }
        equipUtil[eq.id] = totalSpan > 0 ? ((busyTime / totalSpan) * 100).toFixed(1) : '0.0';
      }
    }
    // Average utilization
    const utilValues = Object.values(equipUtil).map(Number);
    const avgUtilization = utilValues.length > 0
      ? (utilValues.reduce((a, b) => a + b, 0) / utilValues.length).toFixed(1)
      : '0.0';

    // Changeover count
    let totalChangeovers = 0;
    for (const eq of equipment) {
      const eqTasks = scheduled
        .filter(s => s.equipmentId === eq.id)
        .sort((a, b) => (a.scheduledStart || 0) - (b.scheduledStart || 0));
      for (let i = 1; i < eqTasks.length; i++) {
        if (eqTasks[i].orderProductType !== eqTasks[i - 1].orderProductType) {
          totalChangeovers++;
        }
      }
    }

    // Shift overload count
    let shiftOverloads = 0;
    const shiftLoadData = {};
    if (shifts.length > 0) {
      const shiftMinutes = new Map();
      for (const s of scheduled) {
        if (!s.scheduledStart || !s.scheduledEnd) continue;
        for (const shift of shifts) {
          const sd = new Date(s.scheduledStart);
          const ed = new Date(s.scheduledEnd);
          let current = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate());
          const endDay = new Date(ed.getFullYear(), ed.getMonth(), ed.getDate());
          while (current <= endDay) {
            const [sh, sm] = shift.startTime.split(':').map(Number);
            const [eh, em] = shift.endTime.split(':').map(Number);
            let ss, se;
            if (shift.crossDay) {
              ss = new Date(current.getFullYear(), current.getMonth(), current.getDate(), sh, sm).getTime();
              se = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1, eh, em).getTime();
            } else {
              ss = new Date(current.getFullYear(), current.getMonth(), current.getDate(), sh, sm).getTime();
              se = new Date(current.getFullYear(), current.getMonth(), current.getDate(), eh, em).getTime();
            }
            if (s.scheduledStart < se && s.scheduledEnd > ss) {
              const overlapStart = Math.max(s.scheduledStart, ss);
              const overlapEnd = Math.min(s.scheduledEnd, se);
              const key = `${shift.name}-${shift.team}`;
              shiftMinutes.set(key, (shiftMinutes.get(key) || 0) + (overlapEnd - overlapStart) / 60000);
            }
            current.setDate(current.getDate() + 1);
          }
        }
      }

      for (const shift of shifts) {
        const [sh, sm] = shift.startTime.split(':').map(Number);
        const [eh, em] = shift.endTime.split(':').map(Number);
        let shiftDurationMin;
        if (shift.crossDay) {
          shiftDurationMin = ((24 - sh) * 60 - sm) + (eh * 60 + em);
        } else {
          shiftDurationMin = (eh * 60 + em) - (sh * 60 + sm);
        }
        const key = `${shift.name}-${shift.team}`;
        const used = shiftMinutes.get(key) || 0;
        const util = used / shiftDurationMin;
        shiftLoadData[key] = (util * 100).toFixed(0);
        if (util > 0.9) shiftOverloads++;
      }
    }

    // Conflict count (from alerts)
    const conflictCount = (scenario.alerts || []).filter(
      a => a.type === 'critical' && (a.message || '').includes('冲突')
    ).length;

    scenario.metrics = {
      totalCompletionTime,
      completionTimeStr: formatDuration(totalCompletionTime),
      delayedOrders,
      orderDelays,
      avgUtilization,
      equipUtilization: equipUtil,
      totalChangeovers,
      shiftOverloads,
      shiftLoad: shiftLoadData,
      conflictCount,
      totalAlerts: (scenario.alerts || []).length,
      totalRisks: (scenario.risks || []).length,
      scheduledCount: scheduled.length
    };

    return scenario.metrics;
  }

  // ========== Comparison ==========

  // Compare multiple scenarios and return diff data
  compare(scenarioIds) {
    const scenarios = scenarioIds
      .map(id => this.scenarios.get(id))
      .filter(Boolean);

    if (scenarios.length === 0) return null;

    const metricsKeys = [
      'totalCompletionTime', 'delayedOrders', 'avgUtilization',
      'totalChangeovers', 'shiftOverloads', 'conflictCount'
    ];

    // Find best/worst for each metric
    const comparison = {
      scenarios: scenarios.map(sc => ({
        id: sc.id,
        name: sc.name,
        metrics: sc.metrics || {},
        modifications: sc.modifications || []
      })),
      diffs: {}
    };

    for (const key of metricsKeys) {
      const values = scenarios.map(sc => (sc.metrics && sc.metrics[key]) || 0);
      const min = Math.min(...values);
      const max = Math.max(...values);

      comparison.diffs[key] = {
        values: values,
        best: min,
        worst: max,
        isLowerBetter: key !== 'avgUtilization' // utilization: higher is better
      };
    }

    return comparison;
  }

  // ========== Rollback ==========

  // Apply a scenario's state back to the main state
  rollbackToScenario(scenarioId) {
    const sc = this.scenarios.get(scenarioId);
    if (!sc) return null;
    return {
      orders: deepClone(sc.orders),
      processes: deepClone(sc.processes),
      equipment: deepClone(sc.equipment),
      shifts: deepClone(sc.shifts),
      materials: deepClone(sc.materials),
      routes: deepClone(sc.routes),
      maintenanceWindows: deepClone(sc.maintenanceWindows),
      scheduled: deepClone(sc.scheduled),
      alerts: deepClone(sc.alerts),
      risks: deepClone(sc.risks)
    };
  }

  // ========== Serialization ==========

  toJSON() {
    const data = {
      baseline: this.baseline,
      activeId: this.activeId,
      nextId: this.nextId,
      scenarios: []
    };
    for (const [id, sc] of this.scenarios) {
      data.scenarios.push({
        id: sc.id,
        name: sc.name,
        createdAt: sc.createdAt,
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
        modifications: sc.modifications,
        metrics: sc.metrics,
        status: sc.status
      });
    }
    return data;
  }

  fromJSON(data) {
    if (!data) return;
    this.baseline = data.baseline;
    this.activeId = data.activeId;
    this.nextId = data.nextId || 1;
    this.scenarios.clear();
    for (const scData of (data.scenarios || [])) {
      const sc = {
        ...scData,
        history: new HistoryManager(30)
      };
      this.scenarios.set(sc.id, sc);
    }
  }
}

// ========== Utility ==========

function deepClone(obj) {
  if (obj === null || obj === undefined) return obj;
  return JSON.parse(JSON.stringify(obj));
}

function formatDuration(ms) {
  if (!ms || ms <= 0) return '0h';
  const hours = Math.floor(ms / 3600000);
  const days = Math.floor(hours / 24);
  const remainH = hours % 24;
  if (days > 0) return `${days}天${remainH}小时`;
  return `${hours}小时`;
}
