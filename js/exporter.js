// ========== Exporter: CSV/JSON Export ==========
const Exporter = {
  download(filename, content, type = 'text/csv') {
    const blob = new Blob(['\uFEFF' + content], { type: type + ';charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },

  exportScheduleCSV(scheduled, orders, equipment) {
    const orderMap = new Map();
    (orders || []).forEach(o => orderMap.set(o.id, o));
    const equipMap = new Map();
    (equipment || []).forEach(e => equipMap.set(e.id, e));

    let csv = '工序编号,工序名称,订单编号,产品名称,设备编号,设备名称,计划开始,计划结束,时长(分钟),优先级,状态\n';
    const sorted = [...scheduled].sort((a, b) => (a.scheduledStart || 0) - (b.scheduledStart || 0));
    for (const s of sorted) {
      const order = orderMap.get(s.orderId) || {};
      const equip = equipMap.get(s.equipmentId) || {};
      const start = s.scheduledStart ? new Date(s.scheduledStart).toLocaleString('zh-CN') : '';
      const end = s.scheduledEnd ? new Date(s.scheduledEnd).toLocaleString('zh-CN') : '';
      const dur = s.scheduledStart && s.scheduledEnd ? Math.round((s.scheduledEnd - s.scheduledStart) / 60000) : '';
      csv += `${s.id},${s.name || ''},${s.orderId || ''},${order.productType || ''},${s.equipmentId || ''},${equip.name || ''},${start},${end},${dur},${order.priority || ''},${s.isInserted ? '插单' : '正常'}\n`;
    }
    this.download(`排产计划_${this.dateStr()}.csv`, csv);
  },

  exportRiskReport(alerts, risks, scheduled, orders) {
    let report = '=== 生产排产风险报告 ===\n';
    report += `生成时间: ${new Date().toLocaleString('zh-CN')}\n`;
    report += `排产工序数: ${(scheduled || []).length}\n`;
    report += `订单数: ${(orders || []).length}\n\n`;

    report += '--- 风险项 ---\n';
    const allIssues = [...(risks || []), ...(alerts || [])];
    const criticals = allIssues.filter(i => i.type === 'critical');
    const warnings = allIssues.filter(i => i.type === 'warning');
    const infos = allIssues.filter(i => i.type === 'info');

    report += `\n严重风险 (${criticals.length}):\n`;
    criticals.forEach((r, i) => {
      report += `  ${i + 1}. [${r.category || '冲突'}] ${r.message}\n`;
    });

    report += `\n警告 (${warnings.length}):\n`;
    warnings.forEach((r, i) => {
      report += `  ${i + 1}. [${r.category || '提示'}] ${r.message}\n`;
    });

    report += `\n信息 (${infos.length}):\n`;
    infos.forEach((r, i) => {
      report += `  ${i + 1}. ${r.message}\n`;
    });

    report += '\n--- 订单交期分析 ---\n';
    for (const order of (orders || [])) {
      const orderProcs = (scheduled || []).filter(s => s.orderId === order.id);
      if (orderProcs.length === 0) continue;
      const lastEnd = Math.max(...orderProcs.map(p => p.scheduledEnd || 0));
      const deadline = new Date(order.deadline).getTime();
      const slack = ((deadline - lastEnd) / 3600000).toFixed(1);
      const status = slack < 0 ? '❌ 超期' : slack < 4 ? '⚠️ 紧张' : '✅ 正常';
      report += `  ${order.id} (${order.productType}): 交期余量 ${slack}h ${status}\n`;
    }

    this.download(`风险报告_${this.dateStr()}.txt`, report, 'text/plain');
  },

  exportFullJSON(state) {
    const json = JSON.stringify(state, null, 2);
    this.download(`排产方案_${this.dateStr()}.json`, json, 'application/json');
  },

  exportComparisonReport(scenarios, comparison) {
    let report = '=== 多方案 What-if 排产沙盘对比报告 ===\n';
    report += `生成时间: ${new Date().toLocaleString('zh-CN')}\n`;
    report += `对比方案数: ${scenarios.length}\n`;

    // Data consistency warning
    const issues = this.validateExportConsistency(scenarios);
    if (issues.length > 0) {
      report += '\n⚠️ 数据一致性警告:\n';
      for (const issue of issues) {
        report += `  - ${issue}\n`;
      }
    }
    report += '\n';

    // Summary table header
    report += '--- 方案概览 ---\n';
    for (const sc of scenarios) {
      report += `\n【${sc.name}】(${sc.id})\n`;
      report += `  创建时间: ${new Date(sc.createdAt).toLocaleString('zh-CN')}\n`;
      report += `  调整项: ${(sc.modifications || []).length} 项\n`;
      if (sc.modifications && sc.modifications.length > 0) {
        for (const mod of sc.modifications) {
          report += `    - ${mod.description || mod.type}\n`;
        }
      }
    }

    // Metrics comparison
    report += '\n--- 指标对比 ---\n';
    const metricsLabels = {
      completionTimeStr: '总完工时间',
      delayedOrders: '延期订单数',
      avgUtilization: '平均设备利用率(%)',
      totalChangeovers: '换线次数',
      shiftOverloads: '班次超负荷数',
      conflictCount: '冲突数量',
      totalAlerts: '告警总数',
      totalRisks: '风险总数',
      scheduledCount: '排产工序数'
    };

    // Build table-like format
    const nameWidth = 16;
    report += `${''.padEnd(nameWidth)}`;
    for (const sc of scenarios) {
      report += ` | ${sc.name.padEnd(20)}`;
    }
    report += '\n' + '-'.repeat(nameWidth + scenarios.length * 23) + '\n';

    for (const [key, label] of Object.entries(metricsLabels)) {
      report += `${label.padEnd(nameWidth)}`;
      for (const sc of scenarios) {
        const val = sc.metrics ? (sc.metrics[key] !== undefined ? String(sc.metrics[key]) : '-') : '-';
        report += ` | ${val.padEnd(20)}`;
      }
      report += '\n';
    }

    // Diff highlights
    if (comparison && comparison.diffs) {
      report += '\n--- 差异高亮 ---\n';
      const diffLabels = {
        totalCompletionTime: '总完工时间',
        delayedOrders: '延期订单数',
        avgUtilization: '设备利用率',
        totalChangeovers: '换线次数',
        shiftOverloads: '班次超负荷',
        conflictCount: '冲突数量'
      };

      for (const [key, label] of Object.entries(diffLabels)) {
        const diff = comparison.diffs[key];
        if (!diff) continue;
        const isLower = diff.isLowerBetter;
        const bestIdx = diff.values.indexOf(diff.best);
        const worstIdx = diff.values.indexOf(diff.worst);
        if (diff.best !== diff.worst) {
          report += `  ${label}: 最优=${scenarios[bestIdx].name}(${diff.best}), 最差=${scenarios[worstIdx].name}(${diff.worst})\n`;
        } else {
          report += `  ${label}: 各方案一致(${diff.best})\n`;
        }
      }
    }

    // Equipment utilization detail
    report += '\n--- 设备利用率明细 ---\n';
    for (const sc of scenarios) {
      report += `\n【${sc.name}】\n`;
      const util = sc.metrics ? sc.metrics.equipUtilization : {};
      if (util && Object.keys(util).length > 0) {
        for (const [eqId, pct] of Object.entries(util)) {
          report += `  ${eqId}: ${pct}%\n`;
        }
      } else {
        report += '  (无数据)\n';
      }
    }

    // Shift load detail
    report += '\n--- 班次负荷明细 ---\n';
    for (const sc of scenarios) {
      report += `\n【${sc.name}】\n`;
      const load = sc.metrics ? sc.metrics.shiftLoad : {};
      if (load && Object.keys(load).length > 0) {
        for (const [key, pct] of Object.entries(load)) {
          const overloaded = Number(pct) > 90;
          report += `  ${key}: ${pct}%${overloaded ? ' ⚠️' : ''}\n`;
        }
      } else {
        report += '  (无数据)\n';
      }
    }

    // Delay details
    report += '\n--- 延期订单明细 ---\n';
    for (const sc of scenarios) {
      report += `\n【${sc.name}】\n`;
      const delays = sc.metrics ? sc.metrics.orderDelays : [];
      if (delays && delays.length > 0) {
        for (const d of delays) {
          report += `  ${d.orderId}(${d.product}): 超期 ${d.delayHours} 小时\n`;
        }
      } else {
        report += '  ✅ 无延期\n';
      }
    }

    // Risk summary per scenario
    report += '\n--- 风险概览 ---\n';
    for (const sc of scenarios) {
      report += `\n【${sc.name}】\n`;
      const allIssues = [...(sc.risks || []), ...(sc.alerts || [])];
      const criticals = allIssues.filter(i => i.type === 'critical');
      const warnings = allIssues.filter(i => i.type === 'warning');
      report += `  严重: ${criticals.length}, 警告: ${warnings.length}\n`;
      for (const c of criticals.slice(0, 5)) {
        report += `  🔴 ${c.message}\n`;
      }
      for (const w of warnings.slice(0, 5)) {
        report += `  🟡 ${w.message}\n`;
      }
    }

    this.download(`方案对比报告_${this.dateStr()}.txt`, report, 'text/plain');
  },

  validateExportConsistency(scenarios) {
    const issues = [];
    for (const sc of (scenarios || [])) {
      if (sc.status === 'calculating') {
        issues.push(`方案 "${sc.name}" 正在计算中，数据可能不完整`);
      }
      if (sc.status === 'error') {
        issues.push(`方案 "${sc.name}" 计算出错，数据可能不准确`);
      }
      if (sc.status === 'pending') {
        issues.push(`方案 "${sc.name}" 尚未计算`);
      }
    }
    return issues;
  },

  dateStr() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  }
};
