import { createProgressThrottle } from '../../src/modules/imports/application/progressThrottle';

describe('createProgressThrottle', () => {
  it('emits only when both the row and the time thresholds are crossed', () => {
    let clock = 0;
    const throttle = createProgressThrottle({ everyRows: 100, everyMs: 1000, now: () => clock });

    expect(throttle.shouldEmit(50)).toBe(false); // too few rows
    clock = 2000;
    expect(throttle.shouldEmit(99)).toBe(false); // enough time, too few rows
    expect(throttle.shouldEmit(100)).toBe(true);

    clock = 2500;
    expect(throttle.shouldEmit(5000)).toBe(false); // enough rows, too little time
    clock = 3000;
    expect(throttle.shouldEmit(5000)).toBe(true);
  });

  it('measures thresholds from the last emission, not from the start', () => {
    let clock = 0;
    const throttle = createProgressThrottle({ everyRows: 10, everyMs: 100, now: () => clock });

    clock = 100;
    expect(throttle.shouldEmit(10)).toBe(true);
    clock = 150;
    expect(throttle.shouldEmit(25)).toBe(false);
    clock = 200;
    expect(throttle.shouldEmit(19)).toBe(false);
    expect(throttle.shouldEmit(20)).toBe(true);
  });

  it('bounds the number of events for a large import', () => {
    let clock = 0;
    const throttle = createProgressThrottle({ everyRows: 500, everyMs: 250, now: () => clock });
    let events = 0;
    for (let row = 1; row <= 100_000; row++) {
      clock += 1; // 1ms per row
      if (throttle.shouldEmit(row)) events++;
    }
    expect(events).toBe(200);
  });
});
