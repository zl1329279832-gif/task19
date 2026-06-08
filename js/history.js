// ========== History Manager: Undo/Redo ==========
class HistoryManager {
  constructor(maxSize = 50) {
    this.maxSize = maxSize;
    this.stack = [];
    this.pointer = -1;
    this.onchange = null;
  }

  // Save a snapshot of the scheduled data
  push(state) {
    // Remove any redo states
    this.stack = this.stack.slice(0, this.pointer + 1);
    // Deep clone
    const snapshot = JSON.parse(JSON.stringify(state));
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
    const state = JSON.parse(JSON.stringify(this.stack[this.pointer]));
    this._notify();
    return state;
  }

  redo() {
    if (!this.canRedo()) return null;
    this.pointer++;
    const state = JSON.parse(JSON.stringify(this.stack[this.pointer]));
    this._notify();
    return state;
  }

  canUndo() { return this.pointer > 0; }
  canRedo() { return this.pointer < this.stack.length - 1; }

  _notify() {
    if (this.onchange) {
      this.onchange(this.canUndo(), this.canRedo());
    }
  }
}
