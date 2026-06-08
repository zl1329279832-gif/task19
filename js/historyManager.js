// ============================================================
// historyManager.js — 撤销/重做 (命令模式 + 状态快照)
// ============================================================

const HistoryManager = (() => {
  const MAX_HISTORY = 50;

  class History {
    constructor() {
      this.undoStack = [];
      this.redoStack = [];
      this.onChange = null; // (canUndo, canRedo) => void
    }

    // 记录一个动作
    push(action) {
      // action: { type, description, snapshot (排产状态快照), previous (之前的状态快照) }
      this.undoStack.push(action);
      if (this.undoStack.length > MAX_HISTORY) this.undoStack.shift();
      this.redoStack = [];
      this._notify();
    }

    // 撤销
    undo() {
      if (this.undoStack.length === 0) return null;
      const action = this.undoStack.pop();
      this.redoStack.push(action);
      this._notify();
      return action;
    }

    // 重做
    redo() {
      if (this.redoStack.length === 0) return null;
      const action = this.redoStack.pop();
      this.undoStack.push(action);
      this._notify();
      return action;
    }

    canUndo() { return this.undoStack.length > 0; }
    canRedo() { return this.redoStack.length > 0; }

    // 获取最近操作描述
    lastUndoDesc() {
      return this.undoStack.length > 0 ? this.undoStack[this.undoStack.length - 1].description : '';
    }
    lastRedoDesc() {
      return this.redoStack.length > 0 ? this.redoStack[this.redoStack.length - 1].description : '';
    }

    clear() {
      this.undoStack = [];
      this.redoStack = [];
      this._notify();
    }

    _notify() {
      if (this.onChange) this.onChange(this.canUndo(), this.canRedo());
    }
  }

  return { History };
})();
