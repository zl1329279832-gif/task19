// ============================================================
// scheduler.worker.js — Web Worker: 排产计算 + 冲突检测
// ============================================================
// 消息协议:
//   { type: 'schedule', payload: { orders, processes, equipment, shifts, materials, routes, config } }
//   { type: 'checkConflicts', payload: { scheduledTasks, orders, equipment, shifts, materials } }
//   { type: 'reschedule', payload: { ... same as schedule + movedTask } }

const HOUR = 3600000;
const MINUTE = 60000;
const DAY = 86400000;

// ---- 时间工具 (Worker 内复制, 不共享主线程模块) ----
function dayStart(ts) {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function hmToOffset(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * HOUR + m * MINUTE;
}

function intervalsOverlap(s1, e1, s2, e2) {
  return s1 < e2 && s2 < e1;
}

// 展开班次到具体时间窗口
function expandShiftWindows(shift, rangeStart, rangeEnd) {
  const windows = [];
  const startOff = hmToOffset(shift.startTime);
  const endOff = hmToOffset(shift.endTime);
  const crossDay = endOff <= startOff;
  let day = dayStart(rangeStart) - DAY;
  while (day <= rangeEnd + DAY) {
    const ws = day + startOff;
    const we = crossDay ? day + DAY + endOff : day + endOff;
    if (we > rangeStart && ws < rangeEnd + DAY) {
      windows.push({ start: ws, end: we, shiftId: shift.id, shiftName: shift.name, crew: shift.crew || '' });
    }
    day += DAY;
  }
  return windows;
}

// 展开设备维护窗口
function expandMaintenanceWindows(equipment, rangeStart, rangeEnd) {
  const windows = [];
  if (!equipment.maintenance) return windows;
  for (const m of equipment.maintenance) {
    if (m.start && m.end) {
      const ms = typeof m.start === 'number' ? m.start : new Date(m.start).getTime();
      const me = typeof m.end === 'number' ? m.end : new Date(m.end).getTime();
      if (intervalsOverlap(ms, me, rangeStart, rangeEnd)) {
        windows.push({ start: ms, end: me, reason: m.reason || '设备维护' });
      }
    }
    // 支持周期性维护: { dayOfWeek: 0, startTime: "06:00", endTime: "08:00" }
    if (m.dayOfWeek !== undefined && m.startTime && m.endTime) {
      let day = dayStart(rangeStart) - DAY;
      while (day <= rangeEnd + DAY) {
        const d = new Date(day);
        if (d.getDay() === m.dayOfWeek) {
          const ms = day + hmToOffset(m.startTime);
          const me = day + hmToOffset(m.endTime);
          if (intervalsOverlap(ms, me, rangeStart, rangeEnd)) {
            windows.push({ start: ms, end: me, reason: m.reason || '周期维护' });
          }
        }
        day += DAY;
      }
    }
  }
  return windows;
}

// 合并和排序时间窗口
function mergeWindows(windows) {
  if (windows.length === 0) return [];
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  const merged = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push({ ...sorted[i] });
    }
  }
  return merged;
}

// 获取设备在某段时间内的可用工作窗口(考虑班次和维护)
function getAvailableWindows(equipmentId, rangeStart, rangeEnd, shifts, equipmentList) {
  const eq = equipmentList.find(e => e.id === equipmentId);
  // 获取适用于该设备的班次
  const eqShifts = shifts.filter(s =>
    !s.equipmentIds || s.equipmentIds.length === 0 || s.equipmentIds.includes(equipmentId)
  );

  let workWindows = [];
  if (eqShifts.length === 0) {
    // 无班次限制，全天可用
    workWindows = [{ start: rangeStart, end: rangeEnd }];
  } else {
    for (const s of eqShifts) {
      workWindows.push(...expandShiftWindows(s, rangeStart, rangeEnd));
    }
    workWindows = mergeWindows(workWindows);
  }

  // 去除维护窗口
  if (eq) {
    const maintWindows = expandMaintenanceWindows(eq, rangeStart, rangeEnd);
    if (maintWindows.length > 0) {
      workWindows = subtractWindows(workWindows, maintWindows);
    }
  }

  return workWindows;
}

// 从可用窗口中减去不可用窗口
function subtractWindows(available, blocked) {
  let result = [...available];
  for (const b of blocked) {
    const next = [];
    for (const a of result) {
      if (b.start >= a.end || b.end <= a.start) {
        next.push(a);
      } else {
        if (a.start < b.start) next.push({ ...a, end: b.start });
        if (a.end > b.end) next.push({ ...a, start: b.end });
      }
    }
    result = next;
  }
  return result;
}

// 在可用窗口内推进 duration 毫秒, 返回结束时间
function advanceInWindows(startTs, duration, windows) {
  const sorted = windows.filter(w => w.end > startTs).sort((a, b) => a.start - b.start);
  let remaining = duration;
  for (const w of sorted) {
    const effectiveStart = Math.max(startTs, w.start);
    const available = w.end - effectiveStart;
    if (available >= remaining) {
      return { end: effectiveStart + remaining, actualStart: effectiveStart };
    }
    remaining -= available;
  }
  // 窗口不够，溢出
  const lastEnd = sorted.length > 0 ? sorted[sorted.length - 1].end : startTs;
  return { end: lastEnd + remaining, actualStart: startTs, overflow: true };
}

// 找到最早可用的开始时间 (>= earliest, 在窗口内, 且不与已排任务冲突)
function findEarliestSlot(earliest, duration, windows, occupied) {
  const sorted = windows.filter(w => w.end > earliest).sort((a, b) => a.start - b.start);

  for (const w of sorted) {
    let candidate = Math.max(earliest, w.start);
    const windowEnd = w.end;

    // 尝试在这个窗口内找空位
    while (candidate + duration <= windowEnd) {
      const candEnd = candidate + duration;
      // 检查是否与已占用时间冲突
      const conflict = occupied.find(o => intervalsOverlap(candidate, candEnd, o.start, o.end));
      if (!conflict) {
        return { start: candidate, end: candEnd };
      }
      // 跳过冲突区间
      candidate = conflict.end;
    }
  }

  // 找不到合适窗口, 放在最后
  const lastEnd = occupied.length > 0 ? Math.max(...occupied.map(o => o.end)) : earliest;
  return { start: Math.max(lastEnd, earliest), end: Math.max(lastEnd, earliest) + duration, overflow: true };
}

// ============================================================
// 排产算法
// ============================================================
function autoSchedule(data) {
  const { orders, processes, equipment, shifts, materials, routes, config } = data;
  const scheduledTasks = [];
  const equipmentTimelines = {}; // equipmentId -> [{start, end, processId}]

  // 初始化设备时间线
  for (const eq of equipment) {
    equipmentTimelines[eq.id] = [];
  }

  // 计算排产范围
  const now = config && config.startTime ? new Date(config.startTime).getTime() : Date.now();
  const rangeStart = now;
  const maxDue = Math.max(...orders.map(o => o.dueDate ? new Date(o.dueDate).getTime() : now + 30 * DAY));
  const rangeEnd = maxDue + 7 * DAY;

  // 建立工序依赖图
  const processMap = {};
  for (const p of processes) processMap[p.id] = p;

  // 物料到达时间映射
  const materialMap = {};
  if (materials) {
    for (const m of materials) {
      if (m.processId) {
        materialMap[m.processId] = typeof m.arrivalTime === 'number' ? m.arrivalTime : new Date(m.arrivalTime).getTime();
      }
    }
  }

  // 订单排序: locked优先 > 优先级高优先 > 交期早优先
  const sortedOrders = [...orders].sort((a, b) => {
    if (a.locked && !b.locked) return -1;
    if (!a.locked && b.locked) return 1;
    const pa = a.priority || 0;
    const pb = b.priority || 0;
    if (pa !== pb) return pb - pa; // 高优先级在前
    const da = a.dueDate ? new Date(a.dueDate).getTime() : Infinity;
    const db = b.dueDate ? new Date(b.dueDate).getTime() : Infinity;
    return da - db;
  });

  // 按工艺路线获取订单的工序序列
  function getOrderProcesses(orderId) {
    const route = routes ? routes.find(r => r.orderId === orderId) : null;
    const orderProcs = processes.filter(p => p.orderId === orderId);
    if (route && route.steps && route.steps.length > 0) {
      // 按路线步骤排序
      const ordered = [];
      for (const stepId of route.steps) {
        const proc = orderProcs.find(p => p.id === stepId);
        if (proc) ordered.push(proc);
      }
      // 补充不在路线中的工序
      for (const p of orderProcs) {
        if (!ordered.find(o => o.id === p.id)) ordered.push(p);
      }
      return ordered;
    }
    // 无路线, 按 sequence 或 dependencies 排序
    return topologicalSort(orderProcs);
  }

  // 拓扑排序
  function topologicalSort(procs) {
    const sorted = [];
    const visited = new Set();
    const procMap = {};
    for (const p of procs) procMap[p.id] = p;

    function visit(p) {
      if (visited.has(p.id)) return;
      visited.add(p.id);
      if (p.dependencies) {
        for (const depId of p.dependencies) {
          if (procMap[depId]) visit(procMap[depId]);
        }
      }
      sorted.push(p);
    }
    // 按 sequence 字段排序后再做拓扑
    const bySeq = [...procs].sort((a, b) => (a.sequence || 0) - (b.sequence || 0));
    for (const p of bySeq) visit(p);
    return sorted;
  }

  // 排产每个订单
  for (const order of sortedOrders) {
    const orderProcs = getOrderProcesses(order.id);
    const processEndTimes = {}; // processId -> end time (用于依赖约束)

    for (const proc of orderProcs) {
      const eqId = proc.equipmentId;
      if (!eqId || !equipmentTimelines[eqId]) continue;

      const duration = (proc.duration || 1) * HOUR; // duration 以小时为单位

      // 计算最早开始时间
      let earliest = rangeStart;

      // 工序依赖约束
      if (proc.dependencies && proc.dependencies.length > 0) {
        for (const depId of proc.dependencies) {
          if (processEndTimes[depId]) {
            earliest = Math.max(earliest, processEndTimes[depId]);
          }
        }
      }

      // 物料到达约束
      if (materialMap[proc.id]) {
        earliest = Math.max(earliest, materialMap[proc.id]);
      }

      // 锁定任务使用预设时间
      if (order.locked && proc.fixedStart) {
        const fixedStart = typeof proc.fixedStart === 'number' ? proc.fixedStart : new Date(proc.fixedStart).getTime();
        const task = {
          id: proc.id,
          processId: proc.id,
          processName: proc.name,
          orderId: order.id,
          orderName: order.name,
          equipmentId: eqId,
          start: fixedStart,
          end: fixedStart + duration,
          duration: duration,
          locked: true,
          color: order.color || null
        };
        scheduledTasks.push(task);
        equipmentTimelines[eqId].push({ start: task.start, end: task.end, processId: proc.id });
        processEndTimes[proc.id] = task.end;
        continue;
      }

      // 获取设备可用窗口
      const availWindows = getAvailableWindows(eqId, rangeStart, rangeEnd, shifts, equipment);
      const occupied = equipmentTimelines[eqId];

      // 找最早可用时段
      const slot = findEarliestSlot(earliest, duration, availWindows, occupied);

      const task = {
        id: proc.id,
        processId: proc.id,
        processName: proc.name,
        orderId: order.id,
        orderName: order.name,
        equipmentId: eqId,
        equipmentName: (equipment.find(e => e.id === eqId) || {}).name || eqId,
        start: slot.start,
        end: slot.end,
        duration: duration,
        locked: !!order.locked,
        color: order.color || null,
        overflow: slot.overflow || false
      };

      scheduledTasks.push(task);
      equipmentTimelines[eqId].push({ start: task.start, end: task.end, processId: proc.id });
      processEndTimes[proc.id] = task.end;
    }
  }

  return scheduledTasks;
}

// ============================================================
// 冲突检测
// ============================================================
function detectConflicts(data) {
  const { scheduledTasks, orders, equipment, shifts, materials, processes } = data;
  const conflicts = [];

  if (!scheduledTasks || scheduledTasks.length === 0) return conflicts;

  const orderMap = {};
  for (const o of orders) orderMap[o.id] = o;
  const processMap = {};
  if (processes) {
    for (const p of processes) processMap[p.id] = p;
  }
  const equipMap = {};
  for (const e of equipment) equipMap[e.id] = e;

  // 1. 设备冲突: 同一设备上的任务时间重叠
  const byEquip = {};
  for (const t of scheduledTasks) {
    (byEquip[t.equipmentId] || (byEquip[t.equipmentId] = [])).push(t);
  }
  for (const [eqId, tasks] of Object.entries(byEquip)) {
    const sorted = tasks.sort((a, b) => a.start - b.start);
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[j].start >= sorted[i].end) break;
        conflicts.push({
          type: 'equipment_conflict',
          severity: 'error',
          taskIds: [sorted[i].id, sorted[j].id],
          equipmentId: eqId,
          message: `设备 ${equipMap[eqId]?.name || eqId} 冲突: "${sorted[i].processName}" 与 "${sorted[j].processName}" 时间重叠`
        });
      }
    }
  }

  // 2. 物料未到: 任务开始时间早于物料到达时间
  if (materials) {
    const matMap = {};
    for (const m of materials) {
      if (m.processId) {
        matMap[m.processId] = typeof m.arrivalTime === 'number' ? m.arrivalTime : new Date(m.arrivalTime).getTime();
      }
    }
    for (const t of scheduledTasks) {
      if (matMap[t.processId] && t.start < matMap[t.processId]) {
        const d = new Date(matMap[t.processId]);
        conflicts.push({
          type: 'material_not_ready',
          severity: 'error',
          taskIds: [t.id],
          message: `工序 "${t.processName}" (订单 ${t.orderName}) 排产开始于物料到达前, 物料预计 ${d.toLocaleString()} 到达`
        });
      }
    }
  }

  // 3. 交期风险: 订单所有工序的最后完成时间晚于交期
  const orderEndTimes = {};
  for (const t of scheduledTasks) {
    if (!orderEndTimes[t.orderId] || t.end > orderEndTimes[t.orderId]) {
      orderEndTimes[t.orderId] = t.end;
    }
  }
  for (const [orderId, endTime] of Object.entries(orderEndTimes)) {
    const order = orderMap[orderId];
    if (order && order.dueDate) {
      const due = typeof order.dueDate === 'number' ? order.dueDate : new Date(order.dueDate).getTime();
      if (endTime > due) {
        const delayHours = ((endTime - due) / HOUR).toFixed(1);
        conflicts.push({
          type: 'deadline_risk',
          severity: endTime > due + 24 * HOUR ? 'error' : 'warning',
          taskIds: scheduledTasks.filter(t => t.orderId === orderId).map(t => t.id),
          orderId,
          message: `订单 "${order.name}" 预计延期 ${delayHours} 小时, 交期 ${new Date(due).toLocaleDateString()}`
        });
      }
    }
  }

  // 4. 换线过多: 同一设备上连续不同订单超过阈值
  const CHANGEOVER_THRESHOLD = 5;
  for (const [eqId, tasks] of Object.entries(byEquip)) {
    const sorted = tasks.sort((a, b) => a.start - b.start);
    let changeovers = 0;
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].orderId !== sorted[i - 1].orderId) changeovers++;
    }
    if (changeovers > CHANGEOVER_THRESHOLD) {
      conflicts.push({
        type: 'changeover_excess',
        severity: 'warning',
        equipmentId: eqId,
        message: `设备 ${equipMap[eqId]?.name || eqId} 换线 ${changeovers} 次, 超过阈值 ${CHANGEOVER_THRESHOLD} 次`
      });
    }
  }

  // 5. 班次超负荷: 计算每个班次窗口内的工作时长占比
  if (shifts && shifts.length > 0) {
    const rangeStart = Math.min(...scheduledTasks.map(t => t.start));
    const rangeEnd = Math.max(...scheduledTasks.map(t => t.end));
    const OVERLOAD_RATIO = 0.95;

    for (const shift of shifts) {
      const windows = expandShiftWindows(shift, rangeStart, rangeEnd);
      for (const w of windows) {
        const shiftDuration = w.end - w.start;
        let workload = 0;
        for (const t of scheduledTasks) {
          const overlap = Math.min(t.end, w.end) - Math.max(t.start, w.start);
          if (overlap > 0) workload += overlap;
        }
        const ratio = workload / shiftDuration;
        if (ratio > OVERLOAD_RATIO) {
          conflicts.push({
            type: 'shift_overload',
            severity: 'warning',
            shiftId: shift.id,
            message: `班次 "${shift.name}" (${new Date(w.start).toLocaleDateString()}) 负荷率 ${(ratio * 100).toFixed(0)}%, 超过 ${(OVERLOAD_RATIO * 100)}% 阈值`
          });
        }
      }
    }
  }

  // 6. 工序依赖违反: 前置工序未在依赖工序前完成
  if (processes) {
    const taskMap = {};
    for (const t of scheduledTasks) taskMap[t.processId] = t;

    for (const proc of processes) {
      if (proc.dependencies && proc.dependencies.length > 0) {
        const task = taskMap[proc.id];
        if (!task) continue;
        for (const depId of proc.dependencies) {
          const depTask = taskMap[depId];
          if (depTask && depTask.end > task.start) {
            conflicts.push({
              type: 'dependency_violation',
              severity: 'error',
              taskIds: [task.id, depTask.id],
              message: `工序 "${task.processName}" 开始于依赖工序 "${depTask.processName}" 完成前`
            });
          }
        }
      }
    }
  }

  // 7. 维护冲突: 任务时间与设备维护窗口重叠
  for (const t of scheduledTasks) {
    const eq = equipMap[t.equipmentId];
    if (!eq || !eq.maintenance) continue;
    const maintWindows = expandMaintenanceWindows(eq, t.start, t.end);
    for (const mw of maintWindows) {
      if (intervalsOverlap(t.start, t.end, mw.start, mw.end)) {
        conflicts.push({
          type: 'maintenance_conflict',
          severity: 'error',
          taskIds: [t.id],
          equipmentId: t.equipmentId,
          message: `工序 "${t.processName}" 与设备 ${eq.name} 维护时间冲突 (${mw.reason})`
        });
      }
    }
  }

  return conflicts;
}

// ============================================================
// 插单重排: 在已有排程中插入新订单, 重新计算受影响部分
// ============================================================
function rushOrderInsert(data) {
  const { scheduledTasks, newOrder, newProcesses, equipment, shifts, materials, routes, orders, processes: allProcesses } = data;

  // 将新订单标记为高优先级
  const updatedOrders = [...orders, { ...newOrder, priority: 999 }];
  const updatedProcesses = [...allProcesses, ...newProcesses];
  const updatedRoutes = routes ? [...routes] : [];
  if (newOrder.route) {
    updatedRoutes.push({ orderId: newOrder.id, steps: newOrder.route });
  }

  // 移除非锁定任务的排程, 保留锁定任务
  const lockedTasks = scheduledTasks.filter(t => t.locked);

  // 完全重排（保留锁定）
  const result = autoSchedule({
    orders: updatedOrders,
    processes: updatedProcesses,
    equipment,
    shifts,
    materials,
    routes: updatedRoutes,
    config: { startTime: new Date().toISOString() }
  });

  return result;
}

// ============================================================
// Worker 消息处理
// ============================================================
self.onmessage = function (e) {
  const { type, payload, requestId } = e.data;

  try {
    let result;
    switch (type) {
      case 'schedule':
        result = autoSchedule(payload);
        self.postMessage({ type: 'scheduleResult', result, requestId });
        // 自动检测冲突
        const conflicts = detectConflicts({
          scheduledTasks: result,
          orders: payload.orders,
          equipment: payload.equipment,
          shifts: payload.shifts,
          materials: payload.materials,
          processes: payload.processes
        });
        self.postMessage({ type: 'conflictsResult', result: conflicts, requestId });
        break;

      case 'checkConflicts':
        result = detectConflicts(payload);
        self.postMessage({ type: 'conflictsResult', result, requestId });
        break;

      case 'rushInsert':
        result = rushOrderInsert(payload);
        self.postMessage({ type: 'scheduleResult', result, requestId });
        const rushConflicts = detectConflicts({
          scheduledTasks: result,
          orders: [...payload.orders, payload.newOrder],
          equipment: payload.equipment,
          shifts: payload.shifts,
          materials: payload.materials,
          processes: [...(payload.processes || []), ...payload.newProcesses]
        });
        self.postMessage({ type: 'conflictsResult', result: rushConflicts, requestId });
        break;

      default:
        self.postMessage({ type: 'error', message: '未知消息类型: ' + type, requestId });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message, stack: err.stack, requestId });
  }
};
