import { describe, expect, it } from 'vitest';
import { IMPORT_LEASE_MS, ImportSessionStore, type KeyValueStorage } from './import-session';

function memoryStorage(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k)
  };
}

function setup(now: { value: number }) {
  let seq = 0;
  const store = new ImportSessionStore(memoryStorage(), 'test-sessions', () => now.value, () => `s-${++seq}`);
  return store;
}

describe('导入会话：并发与断点', () => {
  it('两人同时导入同一份报告，只让先到的生效', () => {
    const now = { value: 1_000 };
    const store = setup(now);
    const first = store.beginOrResume('hash-1', 'report-1', 10, 'alice');
    expect(first.type).toBe('started');
    const second = store.beginOrResume('hash-1', 'report-1', 10, 'bob');
    expect(second.type).toBe('locked');
    if (second.type === 'locked') expect(second.session.owner).toBe('alice');
  });

  it('先到的完成后，重复导入判定为 duplicate，不重复写入', () => {
    const now = { value: 1_000 };
    const store = setup(now);
    store.beginOrResume('hash-1', 'report-1', 10, 'alice');
    store.checkpoint('hash-1', 10);
    store.complete('hash-1');
    const again = store.beginOrResume('hash-1', 'report-1', 10, 'bob');
    expect(again.type).toBe('duplicate');
  });

  it('中途失败保留断点，下次从 cursor 接着做', () => {
    const now = { value: 1_000 };
    const store = setup(now);
    store.beginOrResume('hash-1', 'report-1', 10, 'alice');
    store.checkpoint('hash-1', 6);
    store.fail('hash-1', '网络中断');
    now.value = 2_000;
    const resumed = store.beginOrResume('hash-1', 'report-1', 10, 'alice');
    expect(resumed.type).toBe('started');
    if (resumed.type === 'started') {
      expect(resumed.resumed).toBe(true);
      expect(resumed.session.cursor).toBe(6);
    }
  });

  it('持有者崩溃租约过期后，其他人可接管断点', () => {
    const now = { value: 1_000 };
    const store = setup(now);
    store.beginOrResume('hash-1', 'report-1', 10, 'alice');
    store.checkpoint('hash-1', 4);
    now.value = 1_000 + IMPORT_LEASE_MS + 1;
    const takeover = store.beginOrResume('hash-1', 'report-1', 10, 'bob');
    expect(takeover.type).toBe('started');
    if (takeover.type === 'started') {
      expect(takeover.session.owner).toBe('bob');
      expect(takeover.session.cursor).toBe(4);
    }
  });

  it('同一持有者重复进入视为续传而非冲突', () => {
    const now = { value: 1_000 };
    const store = setup(now);
    store.beginOrResume('hash-1', 'report-1', 10, 'alice');
    store.checkpoint('hash-1', 3);
    const again = store.beginOrResume('hash-1', 'report-1', 10, 'alice');
    expect(again.type).toBe('started');
    if (again.type === 'started') expect(again.session.cursor).toBe(3);
  });

  it('不同报告互不影响', () => {
    const now = { value: 1_000 };
    const store = setup(now);
    store.beginOrResume('hash-1', 'report-1', 10, 'alice');
    const other = store.beginOrResume('hash-2', 'report-2', 5, 'bob');
    expect(other.type).toBe('started');
  });
});
