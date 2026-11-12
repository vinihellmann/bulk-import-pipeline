import {
  TERMINAL_STATUSES,
  TRANSITIONS,
  canTransition,
  isTerminal,
  sourcesOf,
} from '../../src/modules/imports/domain/status';
import { IMPORT_STATUSES } from '../../src/modules/imports/domain/types';

describe('import status machine', () => {
  it('describes every status', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...IMPORT_STATUSES].sort());
  });

  it('allows the documented transitions and nothing else', () => {
    expect(canTransition('AWAITING_UPLOAD', 'QUEUED')).toBe(true);
    expect(canTransition('AWAITING_UPLOAD', 'PROCESSING')).toBe(false);
    expect(canTransition('QUEUED', 'AWAITING_UPLOAD')).toBe(true); // enqueue rollback
    expect(canTransition('QUEUED', 'PROCESSING')).toBe(true);
    expect(canTransition('QUEUED', 'COMPLETED')).toBe(false);
    expect(canTransition('PROCESSING', 'PROCESSING')).toBe(true); // takeover on redelivery
    expect(canTransition('PROCESSING', 'COMPLETED')).toBe(true);
    expect(canTransition('PROCESSING', 'COMPLETED_WITH_ERRORS')).toBe(true);
    expect(canTransition('PROCESSING', 'QUEUED')).toBe(false);
  });

  it('never leaves a terminal status', () => {
    for (const from of ['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED'] as const) {
      expect(isTerminal(from)).toBe(true);
      for (const to of IMPORT_STATUSES) expect(canTransition(from, to)).toBe(false);
    }
    expect([...TERMINAL_STATUSES].sort()).toEqual(['COMPLETED', 'COMPLETED_WITH_ERRORS', 'FAILED']);
  });

  it('derives the allowed source statuses of a target', () => {
    expect(sourcesOf('QUEUED')).toEqual(['AWAITING_UPLOAD']);
    expect(sourcesOf('AWAITING_UPLOAD')).toEqual(['QUEUED']);
    expect(sourcesOf('PROCESSING')).toEqual(['QUEUED', 'PROCESSING']);
    expect(sourcesOf('FAILED')).toEqual(['QUEUED', 'PROCESSING']);
    expect(sourcesOf('COMPLETED')).toEqual(['PROCESSING']);
  });

  it('is consistent: sourcesOf is the inverse of canTransition', () => {
    for (const to of IMPORT_STATUSES) {
      for (const from of IMPORT_STATUSES) {
        expect(sourcesOf(to).includes(from)).toBe(canTransition(from, to));
      }
    }
  });
});
