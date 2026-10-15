'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeShopifyOrder, paypalFeeFromReceipt, shopifyTransactionFee } = require('../src/Shopify.js');

const money = (a) => ({ shopMoney: { amount: String(a) } });

test('Shopify 訂單轉換：目前數量、折扣分配、運費（扣折扣後）、手續費', () => {
  const o = normalizeShopifyOrder({
    name: '#CA53041D', createdAt: '2026-10-12T22:10:00Z', sourceName: 'web', displayFinancialStatus: 'PAID', cancelledAt: null, email: 'x@example.com',
    shippingAddress: { countryCodeV2: 'CA' },
    shippingLines: { nodes: [{ title: 'Flat Rate Shipping', discountedPriceSet: money('0.00') }] },
    lineItems: { nodes: [
      { name: 'A', quantity: 2, currentQuantity: 1, sku: '1', requiresShipping: true, originalUnitPriceSet: money(100), discountAllocations: [{ allocatedAmountSet: money(10) }], variant: { barcode: '0045' }, product: { descriptionHtml: 'd' } },
      { name: 'B', quantity: 1, currentQuantity: 1, sku: '', requiresShipping: false, originalUnitPriceSet: money(5), discountAllocations: [], variant: null, product: null }
    ] },
    transactions: [
      { kind: 'AUTHORIZATION', status: 'SUCCESS', gateway: 'shopify_payments', amountSet: money(1), fees: [] },
      { kind: 'SALE', status: 'SUCCESS', gateway: 'shopify_payments', createdAt: 't1', amountSet: money(110), fees: [{ amount: { amount: '3.49' } }] },
      { kind: 'SALE', status: 'FAILURE', gateway: 'paypal', amountSet: money(110), fees: [] },
      { kind: 'REFUND', status: 'SUCCESS', gateway: 'shopify_payments', amountSet: money(50), fees: [] }
    ]
  }, () => '2026-10-12');
  assert.equal(o.name, 'CA53041D');
  assert.equal(o.financialStatus, 'paid');
  assert.equal(o.shippingCharged, 0);
  assert.deepEqual([o.lines[0].qty, o.lines[0].discount, o.lines[0].barcode], [1, 5, '0045']);
  assert.equal(o.lines[1].requiresShipping, false);
  assert.equal(o.payments.length, 1);
  assert.equal(o.payments[0].fee, 3.49);
});

test('PayPal 手續費從 receipt 讀', () => {
  assert.deepEqual(paypalFeeFromReceipt('{"paypal_fee":"23.44","x":1}'), { fee: 23.44, key: 'paypal_fee' });
  assert.deepEqual(paypalFeeFromReceipt({ PAYMENTINFO_0_FEEAMT: '4.59' }), { fee: 4.59, key: 'PAYMENTINFO_0_FEEAMT' });
  assert.deepEqual(paypalFeeFromReceipt({ seller_receivable_breakdown: { paypal_fee: { value: '1.20', currency_code: 'CAD' } } }), { fee: 1.2, key: 'paypal_fee' });
  assert.equal(paypalFeeFromReceipt('{"id":"x"}'), null);
  assert.equal(paypalFeeFromReceipt('not json'), null);
});

test('現金沒有手續費；Shopify Payments 還沒有 fees 時回傳 null', () => {
  assert.equal(shopifyTransactionFee({ gateway: 'Cash', fees: [] }).fee, 0);
  assert.equal(shopifyTransactionFee({ gateway: 'shopify_payments', fees: [] }).fee, null);
  assert.equal(shopifyTransactionFee({ gateway: 'paypal', fees: [], receiptJson: '{}' }).fee, null);
});
