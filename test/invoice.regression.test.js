'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const invoice = require('../lib/invoice');

test('invoice for a discounted 5 percent sale matches the billed total and GST breakdown', () => {
  // Synthetic copy of the HTTP reproduction, with literal billed amounts.
  const order = {
    id: 1, date: '22/11/2026', customer: 'Test customer', coupon: 'SAVE10',
    items: [{ id: 1, name: 'Test rice', sku: 'TEST', hsn: '1006', price: 640, qty: 1 }],
    subtotal: 640, discount: 64, tax: 28.8, total: 604.8
  };
  const result = invoice.computeInvoiceFigures(order);
  assert.deepEqual({ total: result.total, tax: result.tax, discount: result.discount,
    cgst: result.cgst, sgst: result.sgst, lineTax: result.rows[0].lineTax,
    gstPercent: result.rows[0].gstPercent }, {
    total: 604.8, tax: 28.8, discount: 64, cgst: 14.4, sgst: 14.4,
    lineTax: 28.8, gstPercent: 5
  });
  const html = invoice.render(order);
  assert.match(html, /Invoice Total<\/td><td class="r">₹604\.80/);
  assert.match(html, /CGST \+ SGST \(Total GST\)<\/td><td class="r">₹28\.80/);
  assert.doesNotMatch(html, /Accountant Reconciliation Notice:/);
});
