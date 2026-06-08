// ========== Data Importer: CSV/JSON ==========
const Importer = {
  parseCSV(text) {
    const lines = text.trim().split('\n').filter(l => l.trim());
    return lines.map(line => {
      const parts = [];
      let current = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') { inQuotes = !inQuotes; }
        else if (line[i] === ',' && !inQuotes) { parts.push(current.trim()); current = ''; }
        else { current += line[i]; }
      }
      parts.push(current.trim());
      return parts;
    });
  },

  importOrders(text) {
    const rows = this.parseCSV(text);
    return rows.map(cols => ({
      id: cols[0] || '',
      productType: cols[1] || '',
      quantity: parseInt(cols[2]) || 0,
      deadline: cols[3] || '',
      priority: parseInt(cols[4]) || 3,
      locked: (cols[5] || '').trim() === '是'
    })).filter(o => o.id);
  },

  importProcesses(text) {
    const rows = this.parseCSV(text);
    return rows.map(cols => ({
      id: cols[0] || '',
      name: cols[1] || '',
      equipmentId: cols[2] || '',
      duration: parseInt(cols[3]) || 60,
      dependencies: cols[4] ? cols[4].split(';').map(s => s.trim()).filter(Boolean) : [],
      orderId: cols[5] || '',
      scheduledStart: null,
      scheduledEnd: null
    })).filter(p => p.id);
  },

  importEquipment(text) {
    const rows = this.parseCSV(text);
    return rows.map(cols => ({
      id: cols[0] || '',
      name: cols[1] || '',
      type: cols[2] || '',
      status: cols[3] || '正常'
    })).filter(e => e.id);
  },

  importShifts(text) {
    const rows = this.parseCSV(text);
    return rows.map(cols => ({
      name: cols[0] || '',
      team: cols[1] || '',
      startTime: cols[2] || '08:00',
      endTime: cols[3] || '16:00',
      crossDay: (cols[4] || '').trim() === '是'
    })).filter(s => s.name);
  },

  importMaterials(text) {
    const rows = this.parseCSV(text);
    return rows.map(cols => ({
      id: cols[0] || '',
      name: cols[1] || '',
      orderId: cols[2] || '',
      arrivalTime: cols[3] || '',
      quantity: parseInt(cols[4]) || 0
    })).filter(m => m.id);
  },

  importRoutes(text) {
    const rows = this.parseCSV(text);
    return rows.map(cols => ({
      productType: cols[0] || '',
      processSequence: cols[1] ? cols[1].split('>').map(s => s.trim()).filter(Boolean) : []
    })).filter(r => r.productType);
  },

  importMaintenance(text) {
    const rows = this.parseCSV(text);
    return rows.map(cols => ({
      equipmentId: cols[0] || '',
      start: cols[1] || '',
      end: cols[2] || '',
      type: cols[3] || '维护'
    })).filter(m => m.equipmentId);
  },

  importJSON(jsonStr) {
    try {
      const data = JSON.parse(jsonStr);
      return data;
    } catch (e) {
      console.error('JSON parse error:', e);
      return null;
    }
  }
};
