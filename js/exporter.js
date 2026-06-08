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

  dateStr() {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
  }
};
