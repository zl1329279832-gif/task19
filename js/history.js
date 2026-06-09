// ========== History Manager: Undo/Redo ==========
class HistoryManager {
  constructor(maxSize = 50) {
    this.maxSize = maxSize;
    this.stack = [];
    this.pointer = -1;
    this.onchange = null;
  }

  // Save a snapshot of the scheduled data with optional scenarioId binding
  push(state, scenarioId) {
    // Remove any redo states
    this.stack = this.stack.slice(0, this.pointer + 1);
    // Deep clone and bind to scenario
    const snapshot = {
      data: JSON.parse(JSON.stringify(state)),
      scenarioId: scenarioId || null
    };
    this.stack.push(snapshot);
    if (this.stack.length > this.maxSize) {
      this.stack.shift();
    }
    this.pointer = this.stack.length - 1;
    this._notify();
  }

  undo() {
    if (!this.canUndo()) return null;
    this.pointer--;
    const entry = this.stack[this.pointer];
    this._notify();
    return JSON.parse(JSON.stringify(entry.data));
  }

  redo() {
    if (!this.canRedo()) return null;
    this.pointer++;
    const entry = this.stack[this.pointer];
    this._notify();
    return JSON.parse(JSON.stringify(entry.data));
  }

  canUndo() { return this.pointer > 0; }
  canRedo() { return this.pointer < this.stack.length - 1; }

  // Reset the entire stack
  clear() {
    this.stack = [];
    this.pointer = -1;
    this._notify();
  }

  _notify() {
    if (this.onchange) {
      this.onchange(this.canUndo(), this.canRedo());
    }
  }
}
