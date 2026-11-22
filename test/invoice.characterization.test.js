'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const invoice = require('../lib/invoice');
const pricing = require('../lib/pricing');
const coupons = require('../lib/coupons');
const reports = require('../lib/reports');

// Synthetic fixtures only. Do not import the server, routes or file store.
// Stored billing fields match the shape populated by routes/orders.js.
function line(price, hsn = '0902', extra = {}) {
  return { id: 1, sku: 'TEST', name: 'Test item', price, qty: 1, hsn, ...extra };
}
function billedOrder(items, coupon = '', extra = {}) {
  const billed = pricing.computeTotals(items, coupon);
  return {
    id: 1, date: '01/01/2022', customer: 'Test customer', status: 'completed',
    items, coupon, subtotal: billed.subtotal, discount: billed.discount,
    tax: billed.tax, total: billed.total, ...extra
  };
}
function amounts(result) {
  const { subtotal, discount, tax, cgst, sgst, total } = result;
  return { subtotal, discount, tax, cgst, sgst, total };
}

test('18 percent item without coupon agrees with billing and splits GST', () => {
  const order = billedOrder([line(100)]);
  assert.equal(order.total, 118);
  assert.deepEqual(amounts(invoice.computeInvoiceFigures(order)), {
    subtotal: 100, discount: 0, tax: 18, cgst: 9, sgst: 9, total: 118
  });
});

test('mixed HSN slabs use the same 5/12/18 percent rates on billing and invoice', () => {
  const items = [line(100, '1006'), line(100, '0405'), line(100, '0902')];
  const billed = pricing.computeTotals(items, '');
  assert.deepEqual(amounts(billed), {
    subtotal: 300, discount: 0, tax: 35, cgst: 17.5, sgst: 17.5, total: 335
  });
  assert.deepEqual(billed.lines.map(l => l.tax), [5, 12, 18]);
  const printed = invoice.computeInvoiceFigures(billedOrder(items));
  assert.deepEqual(amounts(printed), {
    subtotal: 300, discount: 0, tax: 35, cgst: 17.5, sgst: 17.5, total: 335
  });
  assert.deepEqual(printed.rows.map(r => [r.gstPercent, r.lineTax]), [[5, 5], [12, 12], [18, 18]]);
});

test('unknown HSN falls back to 18 percent in billing and invoice', () => {
  const order = billedOrder([line(100, 'UNKNOWN')]);
  assert.equal(order.tax, 18);
  assert.equal(invoice.computeInvoiceFigures(order).tax, 18);
});

for (const [rate, billedTax, invoiceTax, displayedRate] of [
  [5, 5, 5, 5], [0.05, 5, 5, 5], [0, 0, 0, 0]
]) {
  test(`explicit gstRate ${rate} produces billing tax ${billedTax} and invoice tax ${invoiceTax}`, () => {
    // Direct module input: normal order creation does not copy gstRate.
    const order = billedOrder([line(100, '1006', { gstRate: rate })]);
    assert.equal(order.tax, billedTax);
    const printed = invoice.computeInvoiceFigures(order);
    assert.equal(printed.tax, invoiceTax);
    assert.equal(printed.rows[0].gstPercent, displayedRate);
  });
}

test('SAVE10 invoice agrees with billing on total, tax and discount', () => {
  const items = [line(1000)];
  assert.deepEqual(amounts(pricing.computeTotals(items, 'SAVE10')), {
    subtotal: 1000, discount: 100, tax: 162, cgst: 81, sgst: 81, total: 1062
  });
  assert.deepEqual(amounts(invoice.computeInvoiceFigures(billedOrder(items, 'SAVE10'))), {
    subtotal: 1000, discount: 100, tax: 162, cgst: 81, sgst: 81, total: 1062
  });
});

test('invoice respects percentage coupon cap', () => {
  const order = billedOrder([line(2000)], 'SAVE10');
  assert.deepEqual([order.discount, order.tax, order.total], [150, 333, 2183]);
  const printed = invoice.computeInvoiceFigures(order);
  assert.deepEqual([printed.discount, printed.tax, printed.total], [150, 333, 2183]);
});

test('flat coupon reduces taxable value for billing and invoice GST', () => {
  const order = billedOrder([line(500)], 'FLAT50');
  assert.deepEqual([order.discount, order.tax, order.total], [50, 81, 531]);
  const printed = invoice.computeInvoiceFigures(order);
  assert.deepEqual([printed.discount, printed.tax, printed.total], [50, 81, 531]);
});

for (const [code, price, discount, total] of [
  ['SAVE10', 100, 0, 118],
  ['DIWALI20', 1000, 0, 1180],
  ['FLAT50', 10, 0, 11.8]
]) {
  test(`invoice ignores ineligible ${code} to subtotal ${price}`, () => {
    // Historical/direct invoice input; creation rejects these coupons.
    assert.equal(coupons.validate(code, price).valid, false);
    const order = billedOrder([line(price)], code);
    assert.equal(order.discount, 0);
    const printed = invoice.computeInvoiceFigures(order);
    assert.equal(printed.discount, discount);
    assert.equal(printed.total, total);
  });
}

test('invoice normalizes coupon case and whitespace like billing', () => {
  const order = billedOrder([line(1000)], ' save10 ');
  assert.equal(order.discount, 100);
  const printed = invoice.computeInvoiceFigures(order);
  assert.equal(printed.discount, 100);
  assert.equal(printed.total, 1062);
});

test('invoice sums rounded line taxes like billing', () => {
  const order = billedOrder([line(0.03), line(0.03)]);
  assert.equal(order.tax, 0.02);
  const printed = invoice.computeInvoiceFigures(order);
  assert.deepEqual(printed.rows.map(r => r.lineTax), [0.01, 0.01]);
  assert.deepEqual(amounts(printed), {
    subtotal: 0.06, discount: 0, tax: 0.02, cgst: 0.01, sgst: 0.01, total: 0.08
  });
});

test('CURRENT BEHAVIOUR: invoice recomputes rather than honoring stored billing amounts', () => {
  const order = billedOrder([line(100)], '', { subtotal: 900, discount: 10, tax: 1, total: 891 });
  const before = structuredClone(order);
  assert.deepEqual(amounts(invoice.computeInvoiceFigures(order)), {
    subtotal: 100, discount: 0, tax: 18, cgst: 9, sgst: 9, total: 118
  });
  assert.deepEqual(order, before);
});

test('printable HTML displays billed GST and total without a mismatch warning', () => {
  const html = invoice.render(billedOrder([line(100, '1006')]));
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹5\.00/);
  assert.match(html, /Invoice Total<\/td><td class="r">₹105\.00/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice:/);
});

test('SAVE10 invoice and reconciliation agree with billed tax as well as total', () => {
  const order = billedOrder([line(1000)], 'SAVE10');
  assert.doesNotMatch(invoice.render(order), /Accountant Reconciliation Notice:/);
  const result = reports.getGstReconciliation({ orders: [order] });
  assert.equal(result.mismatchCount, 0);
  assert.equal(result.totalDelta, 0);
  assert.deepEqual([result.rows[0].ledgerTax, result.rows[0].invoiceTax], [162, 162]);
  assert.equal(result.rows[0].matched, true);
});

test('reconciliation skips cancelled orders and marks an unchanged 18 percent order matched', () => {
  const result = reports.getGstReconciliation({ orders: [
    billedOrder([line(100)]),
    billedOrder([line(100, '1006')], '', { id: 2, status: 'cancelled' })
  ] });
  assert.deepEqual([result.totalChecked, result.mismatchCount, result.totalDelta], [1, 0, 0]);
  assert.equal(result.rows[0].matched, true);
});
