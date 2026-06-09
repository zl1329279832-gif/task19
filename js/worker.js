// ========== Web Worker: Scheduling Engine ==========
// Handles: auto-scheduling, conflict detection, risk analysis, dependency resolution

self.onmessage = function(e) {
  const { action, data, requestVersion, scenarioId, calcVersion } = e.data;
  let result;
  switch (action) {
    case 'autoSchedule':
      result = autoSchedule(data);
      self.postMessage({ action: 'autoScheduleResult', data: result, requestVersion, scenarioId, calcVersion });
      break;
    case 'detectConflicts':
      result = detectConflicts(data);
      self.postMessage({ action: 'conflictResult', data: result, requestVersion, scenarioId, calcVersion });
      break;
    case 'analyzeRisks':
      result = analyzeRisks(data);
      self.postMessage({ action: 'riskResult', data: result, requestVersion, scenarioId, calcVersion });
      break;
    case 'insertOrder':
      result = insertOrder(data);
      self.postMessage({ action: 'insertResult', data: result, requestVersion, scenarioId, calcVersion });
      break;
    case 'recalcAfterDrag':
      result = recalcAfterDrag(data);
      self.postMessage({ action: 'recalcResult', data: result, requestVersion, scenarioId, calcVersion });
      break;
    case 'scenarioCalculate':
      result = calculateScenario(data);
      self.postMessage({ action: 'scenarioResult', data: result, requestVersion, scenarioId, calcVersion });
      break;
  }
};

// ========== Utility ==========
function parseTime(str) { return new Date(str).getTime(); }
function fmtDate(ts) { return new Date(ts).toISOString().slice(0, 16).replace('T', ' '); }

// Check if a time range overlaps with any maintenance window
function overlapsMaintenance(start, end, equipId, maintenanceWindows) {
  const wins = maintenanceWindows.filter(m => m.equipmentId === equipId);
  for (const w of wins) {
    const ws = parseTime(w.start), we = parseTime(w.end);
    if (start < we && end > ws) return w;
  }
  return null;
}

// Check if time is within any shift
function getActiveShifts(startTime, endTime, shifts) {
  const sd = new Date(startTime);
  const ed = new Date(endTime);
  const results = [];
  // Iterate each day in range
  let current = new Date(sd.getFullYear(), sd.getMonth(), sd.getDate());
  const endDay = new Date(ed.getFullYear(), ed.getMonth(), ed.getDate());
  while (current <= endDay) {
    for (const shift of shifts) {
      const [sh, sm] = shift.startTime.split(':').map(Number);
      const [eh, em] = shift.endTime.split(':').map(Number);
      let shiftStart, shiftEnd;
      if (shift.crossDay) {
        shiftStart = new Date(current.getFullYear(), current.getMonth(), current.getDate(), sh, sm);
        shiftEnd = new Date(current.getFullYear(), current.getMonth(), current.getDate() + 1, eh, em);
      } else {
        shiftStart = new Date(current.getFullYear(), current.getMonth(), current.getDate(), sh, sm);
        shiftEnd = new Date(current.getFullYear(), current.getMonth(), current.getDate(), eh, em);
      }
      // Check overlap
      if (startTime < shiftEnd.getTime() && endTime > shiftStart.getTime()) {
        results.push({
          shift,
          shiftStart: shiftStart.getTime(),
          shiftEnd: shiftEnd.getTime(),
          overlapStart: Math.max(startTime, shiftStart.getTime()),
          overlapEnd: Math.min(endTime, shiftEnd.getTime())
        });
      }
    }
    current.setDate(current.getDate() + 1);
  }
  return results;
}

// Calculate effective working duration (only counting shift hours)
function getWorkingMinutes(startTs, endTs, shifts) {
  if (!shifts || shifts.length === 0) return (endTs - startTs) / 60000;
  let totalMs = 0;
  const activeShifts = getActiveShifts(startTs, endTs, shifts);
  for (const s of activeShifts) {
    totalMs += (s.overlapEnd - s.overlapStart);
  }
  return totalMs / 60000;
}

// Find next available time slot considering shifts and maintenance
function findNextSlot(equipId, afterTs, durationMin, shifts, maintenanceWindows) {
  let cursor = afterTs;
  let remaining = durationMin;
  let maxIter = 500;
  while (remaining > 0 && maxIter-- > 0) {
    // Find next shift that covers this equipment
    let bestShiftStart = null, bestShiftEnd = null;
    const cursorDate = new Date(cursor);
    // Check next 30 days for a valid shift
    for (let d = 0; d < 30; d++) {
      const checkDate = new Date(cursorDate.getFullYear(), cursorDate.getMonth(), cursorDate.getDate() + d);
      for (const shift of shifts) {
        const [sh, sm] = shift.startTime.split(':').map(Number);
        const [eh, em] = shift.endTime.split(':').map(Number);
        let ss, se;
        if (shift.crossDay) {
          ss = new Date(checkDate.getFullYear(), checkDate.getMonth(), checkDate.getDate(), sh, sm).getTime();
          se = new Date(checkDate.getFullYear(), checkDate.getMonth(), checkDate.getDate() + 1, eh, em).getTime();
        } else {
          ss = new Date(checkDate.getFullYear(), checkDate.getMonth(), checkDate.getDate(), sh, sm).getTime();
          se = new Date(checkDate.getFullYear(), checkDate.getMonth(), checkDate.getDate(), eh, em).getTime();
        }
        if (se > cursor && ss < cursor + 86400000 * 30) {
          const effectiveStart = Math.max(cursor, ss);
          if (!bestShiftStart || effectiveStart < bestShiftStart) {
            bestShiftStart = effectiveStart;
            bestShiftEnd = se;
          }
        }
      }
      if (bestShiftStart) break;
    }
    if (!bestShiftStart) {
      // No shifts available, just use raw time
      return { start: cursor, end: cursor + remaining * 60000 };
    }
    // Check maintenance windows
    const maint = overlapsMaintenance(bestShiftStart, bestShiftEnd, equipId, maintenanceWindows);
    if (maint) {
      cursor = parseTime(maint.end);
      continue;
    }
    // Calculate available minutes in this shift window
    const availableMin = (bestShiftEnd - bestShiftStart) / 60000;
    if (availableMin >= remaining) {
      return { start: bestShiftStart, end: bestShiftStart + remaining * 60000 };
    } else {
      remaining -= availableMin;
      cursor = bestShiftEnd;
    }
  }
  return { start: afterTs, end: afterTs + durationMin * 60000 };
}

// ========== Topological Sort for Dependencies ==========
function topoSort(processes) {
  const map = new Map();
  processes.forEach(p => map.set(p.id, p));
  const visited = new Set();
  const sorted = [];
  const visiting = new Set();

  function visit(id) {
    if (visited.has(id)) return;
    if (visiting.has(id)) return; // cycle
    visiting.add(id);
    const proc = map.get(id);
    if (proc && proc.dependencies) {
      for (const dep of proc.dependencies) {
        if (dep) visit(dep);
      }
    }
    visiting.delete(id);
    visited.add(id);
    sorted.push(id);
  }

  processes.forEach(p => visit(p.id));
  return sorted;
}

// ========== Auto Schedule ==========
function autoSchedule(data) {
  const { orders, processes, equipment, shifts, materials, routes, maintenanceWindows } = data;
  if (!orders || orders.length === 0) return { scheduled: [], alerts: [] };

  const alerts = [];
  const scheduled = [];
  const equipMap = new Map();
  (equipment || []).forEach(eq => equipMap.set(eq.id, eq));

  // Sort orders by priority (descending) then deadline (ascending)
  const sortedOrders = [...orders].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return parseTime(a.deadline) - parseTime(b.deadline);
  });

  // Track equipment timeline: when each equipment becomes free
  const equipTimeline = new Map();
  (equipment || []).forEach(eq => {
    // Start from now or earliest shift
    const now = Date.now();
    equipTimeline.set(eq.id, now);
  });

  // Track changeover counts per equipment
  const changeoverCounts = new Map();
  const lastProductType = new Map();

  for (const order of sortedOrders) {
    if (order.locked) {
      // Check if locked order already has scheduled processes
      const existingProcs = (processes || []).filter(p => p.orderId === order.id && p.scheduledStart && p.scheduledEnd);
      if (existingProcs.length > 0) {
        // Locked orders keep their existing schedule
        for (const p of existingProcs) {
          scheduled.push({ ...p });
          // Update equipment timeline
          if (p.scheduledEnd) {
            const current = equipTimeline.get(p.equipmentId) || 0;
            if (p.scheduledEnd > current) equipTimeline.set(p.equipmentId, p.scheduledEnd);
          }
        }
        continue;
      }
      // If no existing schedule, schedule normally but mark as locked
    }

    // Get process route for this order's product
    const route = (routes || []).find(r => r.productType === order.productType);
    let orderProcesses;
    if (route) {
      orderProcesses = route.processSequence
        .map(pid => (processes || []).find(p => p.id === pid && p.orderId === order.id) ||
                    (processes || []).find(p => p.id === pid))
        .filter(Boolean);
    } else {
      orderProcesses = (processes || []).filter(p => p.orderId === order.id);
    }

    if (orderProcesses.length === 0) continue;

    // Topological sort for dependencies
    const sortedIds = topoSort(orderProcesses);
    const procMap = new Map();
    orderProcesses.forEach(p => procMap.set(p.id, p));

    // Track completion times for dependency resolution
    const completionTimes = new Map();

    for (const pid of sortedIds) {
      const proc = procMap.get(pid);
      if (!proc) continue;

      const eqId = proc.equipmentId;
      const duration = proc.duration || 60;

      // Earliest start: after all dependencies complete
      let earliestStart = equipTimeline.get(eqId) || Date.now();
      if (proc.dependencies) {
        for (const depId of proc.dependencies) {
          const depEnd = completionTimes.get(depId);
          if (depEnd && depEnd > earliestStart) earliestStart = depEnd;
        }
      }

      // Find available slot considering shifts and maintenance
      const slot = findNextSlot(eqId, earliestStart, duration, shifts || [], maintenanceWindows || []);

      // Check for changeover
      const lastProduct = lastProductType.get(eqId);
      if (lastProduct && lastProduct !== order.productType) {
        const cc = (changeoverCounts.get(eqId) || 0) + 1;
        changeoverCounts.set(eqId, cc);
        if (cc > 3) {
          alerts.push({
            type: 'warning',
            message: `设备 ${eqId} 换线次数已达 ${cc} 次，建议优化排产顺序`,
            equipmentId: eqId, orderId: order.id
          });
        }
      }
      lastProductType.set(eqId, order.productType);

      // Update equipment timeline
      equipTimeline.set(eqId, slot.end);
      completionTimes.set(pid, slot.end);

      // Check material availability
      const orderMaterials = (materials || []).filter(m => m.orderId === order.id);
      for (const mat of orderMaterials) {
        const matTime = parseTime(mat.arrivalTime);
        if (matTime > slot.start) {
          alerts.push({
            type: 'critical',
            message: `物料 ${mat.name}(${mat.id}) 到料时间 ${fmtDate(matTime)} 晚于工序 ${proc.name || pid} 开工时间 ${fmtDate(slot.start)}`,
            orderId: order.id, processId: pid, materialId: mat.id
          });
        }
      }

      // Check deadline risk
      if (slot.end > parseTime(order.deadline)) {
        alerts.push({
          type: 'critical',
          message: `订单 ${order.id}(${order.productType}) 交期风险：预计完成 ${fmtDate(slot.end)} 超出交期 ${order.deadline}`,
          orderId: order.id, processId: pid
        });
      }

      // Check maintenance overlap
      const maint = overlapsMaintenance(slot.start, slot.end, eqId, maintenanceWindows || []);
      if (maint) {
        alerts.push({
          type: 'warning',
          message: `工序 ${proc.name || pid} 与设备 ${eqId} 维护窗口冲突 (${maint.type})`,
          equipmentId: eqId, processId: pid
        });
      }

      scheduled.push({
        ...proc,
        orderId: order.id,
        orderPriority: order.priority,
        orderProductType: order.productType,
        locked: order.locked || false,
        scheduledStart: slot.start,
        scheduledEnd: slot.end,
        equipmentId: eqId
      });
    }
  }

  // Detect equipment conflicts (overlapping tasks on same equipment)
  const conflicts = detectConflicts({ scheduled, shifts, maintenanceWindows, materials, orders });
  alerts.push(...conflicts);

  // Check shift overload
  const shiftLoad = calcShiftLoad(scheduled, shifts || []);
  alerts.push(...shiftLoad);

  return { scheduled, alerts };
}

// ========== Conflict Detection ==========
function detectConflicts(data) {
  const { scheduled, maintenanceWindows } = data;
  const alerts = [];
  if (!scheduled) return alerts;

  // Group by equipment
  const byEquip = new Map();
  for (const s of scheduled) {
    if (!s.equipmentId || !s.scheduledStart) continue;
    if (!byEquip.has(s.equipmentId)) byEquip.set(s.equipmentId, []);
    byEquip.get(s.equipmentId).push(s);
  }

  for (const [eqId, tasks] of byEquip) {
    // Sort by start time
    tasks.sort((a, b) => a.scheduledStart - b.scheduledStart);
    for (let i = 0; i < tasks.length - 1; i++) {
      if (tasks[i].scheduledEnd > tasks[i + 1].scheduledStart) {
        alerts.push({
          type: 'critical',
          message: `设备冲突：${eqId} 上工序 "${tasks[i].name || tasks[i].id}" 与 "${tasks[i + 1].name || tasks[i + 1].id}" 时间重叠`,
          equipmentId: eqId,
          processIds: [tasks[i].id, tasks[i + 1].id]
        });
      }
    }
  }

  return alerts;
}

// ========== Shift Load Analysis ==========
function calcShiftLoad(scheduled, shifts) {
  const alerts = [];
  if (!shifts || shifts.length === 0) return alerts;

  // For each shift, calculate total scheduled minutes
  const shiftMinutes = new Map();
  for (const s of scheduled) {
    if (!s.scheduledStart || !s.scheduledEnd) continue;
    const activeShifts = getActiveShifts(s.scheduledStart, s.scheduledEnd, shifts);
    for (const as of activeShifts) {
      const key = `${as.shift.name}-${as.shift.team}`;
      const mins = (as.overlapEnd - as.overlapStart) / 60000;
      shiftMinutes.set(key, (shiftMinutes.get(key) || 0) + mins);
    }
  }

  // Check overload (>90% of shift duration)
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
    const utilization = used / shiftDurationMin;
    if (utilization > 0.9) {
      alerts.push({
        type: utilization > 1.0 ? 'critical' : 'warning',
        message: `班次 ${shift.name}(${shift.team}) 负荷率 ${(utilization * 100).toFixed(0)}%，${utilization > 1.0 ? '已超负荷' : '接近满负荷'}`,
      });
    }
  }

  return alerts;
}

// ========== Risk Analysis ==========
function analyzeRisks(data) {
  const { scheduled, orders, materials, maintenanceWindows, shifts } = data;
  const risks = [];
  if (!scheduled) return risks;

  for (const order of (orders || [])) {
    const orderProcs = scheduled.filter(s => s.orderId === order.id);
    if (orderProcs.length === 0) continue;

    const lastEnd = Math.max(...orderProcs.map(p => p.scheduledEnd || 0));
    const deadline = parseTime(order.deadline);
    const slack = (deadline - lastEnd) / 3600000; // hours

    if (slack < 0) {
      risks.push({
        type: 'critical',
        category: '交期风险',
        message: `订单 ${order.id} 已超期 ${Math.abs(slack).toFixed(1)} 小时`,
        orderId: order.id,
        severity: 10
      });
    } else if (slack < 4) {
      risks.push({
        type: 'warning',
        category: '交期风险',
        message: `订单 ${order.id} 交期余量仅 ${slack.toFixed(1)} 小时`,
        orderId: order.id,
        severity: 7
      });
    }

    // Material risk
    const mats = (materials || []).filter(m => m.orderId === order.id);
    for (const mat of mats) {
      const earliestStart = Math.min(...orderProcs.map(p => p.scheduledStart || Infinity));
      if (parseTime(mat.arrivalTime) > earliestStart) {
        risks.push({
          type: 'critical',
          category: '物料风险',
          message: `订单 ${order.id} 物料 ${mat.name} 未到，到料时间晚于开工`,
          orderId: order.id,
          severity: 9
        });
      }
    }
  }

  // Changeover analysis
  const byEquip = new Map();
  for (const s of scheduled) {
    if (!byEquip.has(s.equipmentId)) byEquip.set(s.equipmentId, []);
    byEquip.get(s.equipmentId).push(s);
  }
  for (const [eqId, tasks] of byEquip) {
    tasks.sort((a, b) => a.scheduledStart - b.scheduledStart);
    let changes = 0;
    for (let i = 1; i < tasks.length; i++) {
      if (tasks[i].orderProductType !== tasks[i - 1].orderProductType) changes++;
    }
    if (changes > 3) {
      risks.push({
        type: 'warning',
        category: '换线风险',
        message: `设备 ${eqId} 换线 ${changes} 次，建议合并同类产品`,
        equipmentId: eqId,
        severity: 5
      });
    }
  }

  // Sort by severity
  risks.sort((a, b) => b.severity - a.severity);
  return risks;
}

// ========== Insert Order ==========
function insertOrder(data) {
  const { newOrder, scheduled, processes, equipment, shifts, materials, routes, maintenanceWindows } = data;

  // Merge scheduled times into processes for locked orders so they are preserved
  const mergedProcesses = (processes || []).map(p => {
    const order = (data.orders || []).find(o => o.id === p.orderId);
    if (order && order.locked) {
      const sched = (scheduled || []).find(s => s.id === p.id);
      if (sched && sched.scheduledStart && sched.scheduledEnd) {
        return { ...p, scheduledStart: sched.scheduledStart, scheduledEnd: sched.scheduledEnd };
      }
    }
    return p;
  });

  // Re-schedule with the new order at highest priority
  const allOrders = [...(data.orders || []), { ...newOrder, priority: 10, locked: false }];
  const result = autoSchedule({
    orders: allOrders,
    processes: mergedProcesses,
    equipment,
    shifts,
    materials,
    routes,
    maintenanceWindows
  });

  // Mark the new order's processes
  result.scheduled = result.scheduled.map(s => {
    if (s.orderId === newOrder.id) {
      return { ...s, isInserted: true };
    }
    return s;
  });

  return result;
}

// ========== Recursive Dependency Cascade ==========
function _cascadeDependents(movedId, movedEnd, updated, cascadeMap) {
  const dependents = updated.filter(s =>
    s.dependencies && s.dependencies.includes(movedId)
  );
  for (const dep of dependents) {
    const currentDep = cascadeMap.get(dep.id) || dep;
    if (currentDep.scheduledStart < movedEnd) {
      const delta = movedEnd - currentDep.scheduledStart;
      const newStart = currentDep.scheduledStart + delta;
      const newEnd = currentDep.scheduledEnd + delta;
      cascadeMap.set(dep.id, { id: dep.id, scheduledStart: newStart, scheduledEnd: newEnd });
      // Update in-place so deeper dependents see the new end time
      const idx = updated.findIndex(s => s.id === dep.id);
      if (idx >= 0) {
        updated[idx] = { ...updated[idx], scheduledStart: newStart, scheduledEnd: newEnd };
      }
      // Recursively cascade to this task's dependents
      _cascadeDependents(dep.id, newEnd, updated, cascadeMap);
    }
  }
}

// ========== Recalc After Drag ==========
function recalcAfterDrag(data) {
  const { movedProcess, allScheduled, shifts, maintenanceWindows, orders, materials } = data;
  const alerts = [];

  // Update the moved process
  const updated = allScheduled.map(s => {
    if (s.id === movedProcess.id) {
      return { ...s, scheduledStart: movedProcess.scheduledStart, scheduledEnd: movedProcess.scheduledEnd };
    }
    return { ...s };
  });

  // Check for conflicts on the moved process's equipment
  const eqTasks = updated
    .filter(s => s.equipmentId === movedProcess.equipmentId && s.id !== movedProcess.id)
    .sort((a, b) => a.scheduledStart - b.scheduledStart);

  for (const t of eqTasks) {
    if (movedProcess.scheduledStart < t.scheduledEnd && movedProcess.scheduledEnd > t.scheduledStart) {
      alerts.push({
        type: 'critical',
        message: `拖拽冲突：工序 "${movedProcess.name || movedProcess.id}" 与 "${t.name || t.id}" 在设备 ${movedProcess.equipmentId} 上重叠`,
        equipmentId: movedProcess.equipmentId,
        processIds: [movedProcess.id, t.id]
      });
    }
  }

  // Check maintenance overlap
  const maint = overlapsMaintenance(movedProcess.scheduledStart, movedProcess.scheduledEnd, movedProcess.equipmentId, maintenanceWindows || []);
  if (maint) {
    alerts.push({
      type: 'warning',
      message: `拖拽后工序 "${movedProcess.name || movedProcess.id}" 进入维护窗口 (${maint.type})`,
      equipmentId: movedProcess.equipmentId
    });
  }

  // Check shift validity
  if (shifts && shifts.length > 0) {
    const activeShifts = getActiveShifts(movedProcess.scheduledStart, movedProcess.scheduledEnd, shifts);
    if (activeShifts.length === 0) {
      alerts.push({
        type: 'warning',
        message: `拖拽后工序 "${movedProcess.name || movedProcess.id}" 不在任何班次时间内`,
      });
    }
  }

  // Check deadline for moved order
  const order = (orders || []).find(o => o.id === movedProcess.orderId);
  if (order && movedProcess.scheduledEnd > parseTime(order.deadline)) {
    alerts.push({
      type: 'critical',
      message: `拖拽后订单 ${order.id} 超出交期`,
      orderId: order.id
    });
  }

  // Check material for moved process
  const mats = (materials || []).filter(m => m.orderId === movedProcess.orderId);
  for (const mat of mats) {
    if (parseTime(mat.arrivalTime) > movedProcess.scheduledStart) {
      alerts.push({
        type: 'warning',
        message: `拖拽后物料 ${mat.name} 未到（到料 ${fmtDate(parseTime(mat.arrivalTime))}）`,
        materialId: mat.id
      });
    }
  }

  // Recursive dependency cascade: propagate through full dependency chain
  const cascadeMap = new Map();
  _cascadeDependents(movedProcess.id, movedProcess.scheduledEnd, updated, cascadeMap);
  const cascadeUpdates = Array.from(cascadeMap.values());

  // Re-run full conflict detection
  const fullConflicts = detectConflicts({ scheduled: updated, shifts, maintenanceWindows, materials, orders });
  alerts.push(...fullConflicts);

  // Re-run shift load
  const shiftLoad = calcShiftLoad(updated, shifts || []);
  alerts.push(...shiftLoad);

  return { updated, alerts, cascadeUpdates };
}

// ========== Scenario Calculation ==========
function calculateScenario(data) {
  const { scenarioId, scenarioData } = data;
  try {
    // Run auto-schedule on the scenario's data
    const schedResult = autoSchedule({
      orders: scenarioData.orders,
      processes: scenarioData.processes,
      equipment: scenarioData.equipment,
      shifts: scenarioData.shifts,
      materials: scenarioData.materials,
      routes: scenarioData.routes,
      maintenanceWindows: scenarioData.maintenanceWindows
    });

    // Run risk analysis on the scheduled result
    const risks = analyzeRisks({
      scheduled: schedResult.scheduled,
      orders: scenarioData.orders,
      materials: scenarioData.materials,
      maintenanceWindows: scenarioData.maintenanceWindows,
      shifts: scenarioData.shifts
    });

    return {
      scenarioId,
      scheduled: schedResult.scheduled,
      alerts: schedResult.alerts,
      risks,
      error: null
    };
  } catch (e) {
    return {
      scenarioId,
      scheduled: [],
      alerts: [],
      risks: [],
      error: e.message || '计算出错'
    };
  }
}
