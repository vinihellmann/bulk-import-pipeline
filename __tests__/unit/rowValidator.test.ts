import { validateRow } from '../../src/modules/imports/domain/rowValidator';

const valid = {
  sku: ' SKU-001 ',
  name: 'Cordless drill',
  description: '',
  price: '199.90',
  stock: '12',
  category: 'tools',
};

describe('validateRow', () => {
  it('coerces a valid row and trims text', () => {
    const result = validateRow(valid);
    expect(result).toEqual({
      success: true,
      data: {
        sku: 'SKU-001',
        name: 'Cordless drill',
        description: null,
        price: 199.9,
        stock: 12,
        category: 'tools',
      },
    });
  });

  it('keeps a non-empty description', () => {
    const result = validateRow({ ...valid, description: 'Two batteries included' });
    expect(result.success && result.data.description).toBe('Two batteries included');
  });

  it('treats a missing optional description column as null', () => {
    const { description: _omit, ...withoutDescription } = valid;
    const result = validateRow(withoutDescription);
    expect(result.success && result.data.description).toBeNull();
  });

  it.each([
    ['0', 'must be greater than 0'],
    ['-5', 'must be greater than 0'],
    ['abc', 'must be a decimal number with at most 2 decimal places'],
    ['1.999', 'must be a decimal number with at most 2 decimal places'],
    ['', 'is required'],
  ])('rejects price %p', (price, message) => {
    expect(validateRow({ ...valid, price })).toEqual({
      success: false,
      issues: [{ field: 'price', message }],
    });
  });

  it.each([
    ['-1', 'must be greater than or equal to 0'],
    ['2.5', 'must be a whole number'],
    ['99999999999', 'must be at most 2147483647'],
  ])('rejects stock %p', (stock, message) => {
    expect(validateRow({ ...valid, stock })).toEqual({
      success: false,
      issues: [{ field: 'stock', message }],
    });
  });

  it('accepts zero stock', () => {
    expect(validateRow({ ...valid, stock: '0' }).success).toBe(true);
  });

  it('reports every invalid field of a row', () => {
    const result = validateRow({ sku: '', name: '', price: '0', stock: 'x', category: '' });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.issues.map((i) => i.field).sort()).toEqual([
      'category',
      'name',
      'price',
      'sku',
      'stock',
    ]);
  });

  it('enforces column length limits', () => {
    const result = validateRow({ ...valid, sku: 'x'.repeat(65) });
    expect(result).toEqual({
      success: false,
      issues: [{ field: 'sku', message: 'must be at most 64 characters' }],
    });
  });
});
