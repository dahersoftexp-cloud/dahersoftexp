const assert = require("node:assert/strict");

const BASE_URL = (process.env.API_BASE_URL || "https://dahersoftexp.onrender.com").replace(/\/+$/, "");
const RUN_ID = process.env.SMOKE_RUN_ID || Date.now().toString(36);
const TENANT_ID = process.env.SMOKE_TENANT_ID || `qa-smoke-${RUN_ID}`;
const PASSWORD = process.env.SMOKE_PASSWORD || "123123";

const results = [];
const state = {
  token: "",
  tenantId: TENANT_ID,
  username: TENANT_ID,
  headers: {},
  accounts: {},
  ids: {},
};

const nowStamp = () => new Date().toISOString().replace(/[:.]/g, "-");
const suffix = `${RUN_ID}-${Math.random().toString(36).slice(2, 6)}`;

const names = {
  mainWarehouse: `QA-Main-${suffix}`,
  secondWarehouse: `QA-Second-${suffix}`,
  vehicleWarehouse: `QA-Vehicle-${suffix}`,
  supplier: `QA Supplier ${suffix}`,
  customer: `QA Customer ${suffix}`,
  productCode: `QA-PROD-${suffix}`,
  directProductCode: `QA-DIRECT-${suffix}`,
  transferProductCode: `QA-TRANSFER-${suffix}`,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function mark(name, status, details = {}) {
  results.push({
    name,
    status,
    ...details,
  });

  const icon = status === "pass" ? "PASS" : status === "skip" ? "SKIP" : "FAIL";
  console.log(`${icon} ${name}${details.message ? ` - ${details.message}` : ""}`);
}

function summarizePayload(payload) {
  if (payload === null || payload === undefined) return payload;
  if (Array.isArray(payload)) return { type: "array", count: payload.length, first: payload[0] };
  if (typeof payload === "object") {
    const keys = Object.keys(payload);
    return { type: "object", keys: keys.slice(0, 12), sample: keys.slice(0, 5).reduce((out, key) => {
      out[key] = payload[key];
      return out;
    }, {}) };
  }
  return payload;
}

async function request(method, path, body, options = {}) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.auth === false ? {} : state.headers),
    ...(options.headers || {}),
  };
  const response = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  return {
    ok: response.ok,
    status: response.status,
    data,
    text,
  };
}

async function expect(name, method, path, body, options = {}) {
  const expected = options.expected || [200, 201];

  try {
    const response = await request(method, path, body, options);
    if (!expected.includes(response.status)) {
      mark(name, "fail", {
        method,
        path,
        statusCode: response.status,
        message: response.data?.message || response.data?.error || response.text || "Unexpected status",
        response: summarizePayload(response.data),
      });
      return response;
    }

    if (options.validate) {
      options.validate(response.data, response);
    }

    mark(name, "pass", { method, path, statusCode: response.status });
    return response;
  } catch (error) {
    mark(name, "fail", {
      method,
      path,
      message: error.message,
      stack: error.stack,
    });
    return { ok: false, status: 0, data: null, error };
  }
}

async function skip(name, reason) {
  mark(name, "skip", { message: reason });
}

function findAccount(accounts, id, code) {
  return accounts.find((account) => account.id === id) || accounts.find((account) => account.code === code);
}

function requireId(name, value) {
  assert.ok(value, `${name} is required`);
  return value;
}

async function getProducts() {
  const response = await expect("products list refresh", "GET", "/api/products?pricing=full");
  return Array.isArray(response.data) ? response.data : [];
}

function hasProductCode(products, code) {
  return Array.isArray(products) && products.some((product) => product?.code === code);
}

function saleProduct(product, qty = 1) {
  return {
    id: product.id,
    code: product.code,
    name: product.name,
    category: product.category || "Smoke",
    warehouse: product.warehouse,
    quantity: Number(product.quantity || 0),
    reservedQuantity: Number(product.reservedQuantity || 0),
    qty,
    sellPrice: Number(product.sellPrice || 1),
    payPrice: Number(product.payPrice || 0),
    wholesalePrice: Number(product.wholesalePrice || 0),
    superWholesalePrice: Number(product.superWholesalePrice || 0),
    selectedPriceType: "sellPrice",
    unit: product.unit || "pcs",
    updatedDate: product.updatedDate || "",
  };
}

async function main() {
  console.log(`Smoke test base: ${BASE_URL}`);
  console.log(`Smoke tenant: ${TENANT_ID}`);

  await expect("root health", "GET", "/", undefined, {
    auth: false,
    expected: [200],
  });

  await expect("trial create isolated tenant", "POST", "/api/trials", {
    tenantId: TENANT_ID,
    companyCode: TENANT_ID,
    companyName: `QA Smoke ${RUN_ID}`,
    username: TENANT_ID,
    password: PASSWORD,
    durationDays: 14,
  }, {
    auth: false,
    expected: [201, 409],
  });

  const loginResponse = await expect("auth login isolated admin", "POST", "/api/auth/login", {
    username: TENANT_ID,
    password: PASSWORD,
  }, {
    auth: false,
    validate(data) {
      assert.equal(data?.user?.tenantId, TENANT_ID);
      assert.ok(data?.token);
    },
  });

  state.token = loginResponse.data?.token || "";
  state.headers = {
    Authorization: `Bearer ${state.token}`,
    "X-Inventory-Tenant-Id": encodeURIComponent(TENANT_ID),
  };

  const accountsResponse = await expect("accounts get defaults", "GET", "/api/account/get-account");
  const accounts = Array.isArray(accountsResponse.data) ? accountsResponse.data : [];
  state.accounts.cash = requireId("cash account", findAccount(accounts, "default-cash", "1000")?.id);
  state.accounts.bank = requireId("bank account", findAccount(accounts, "default-bank", "1010")?.id);
  state.accounts.receivable = requireId("receivable account", findAccount(accounts, "default-accounts-receivable", "1100")?.id);
  state.accounts.inventory = requireId("inventory account", findAccount(accounts, "default-inventory", "1200")?.id);
  state.accounts.payable = requireId("payable account", findAccount(accounts, "default-accounts-payable", "2000")?.id);
  state.accounts.sales = requireId("sales account", findAccount(accounts, "default-sales-revenue", "4000")?.id);
  state.accounts.expense = requireId("expense account", findAccount(accounts, "default-operating-expenses", "6000")?.id);

  const customAccount = await expect("account create custom", "POST", "/api/account/create-account", {
    name: `QA Cash ${suffix}`,
    code: `QA-${RUN_ID}`,
    type: "Asset",
    category: "Cash",
    openingBalance: 12,
    currency: "USD",
    description: "smoke",
  }, {
    expected: [201],
    validate(data) {
      assert.ok(data?.id);
    },
  });
  state.ids.customAccount = customAccount.data?.id;
  await expect("account get details", "GET", `/api/account/get-account/${state.ids.customAccount}`);
  await expect("account update custom", "PUT", `/api/account/update-account/${state.ids.customAccount}`, {
    name: `QA Cash Updated ${suffix}`,
    code: `QA-${RUN_ID}`,
    type: "Asset",
    currentBalance: 14,
    currency: "USD",
  });
  await expect("account delete custom", "DELETE", `/api/account/delete-account/${state.ids.customAccount}`);

  await expect("users list admin", "GET", "/api/users", undefined, {
    validate(data) {
      assert.ok(Array.isArray(data));
      assert.ok(data.some((user) => user.username === TENANT_ID));
    },
  });

  const tempUser = `qa-user-${suffix}`;
  const driverUser = `qa-driver-${suffix}`;
  await expect("users create normal", "POST", "/api/users", {
    username: tempUser,
    password: PASSWORD,
    role: "user",
    permissions: ["home", "products"],
  });
  await expect("users update normal", "PUT", `/api/users/${tempUser}`, {
    role: "user",
    permissions: ["home", "products", "customers"],
    password: "123456",
  });
  await expect("users create driver", "POST", "/api/users", {
    username: driverUser,
    password: PASSWORD,
    role: "driver",
    permissions: ["driver-sales"],
  });
  await expect("users delete normal", "DELETE", `/api/users/${tempUser}`);

  const warehouseMain = await expect("warehouses create main", "POST", "/api/warehouses", {
    name: names.mainWarehouse,
    location: "QA",
  }, {
    validate(data) {
      assert.ok(data?.data?.id);
    },
  });
  state.ids.mainWarehouse = warehouseMain.data?.data?.id;
  await expect("warehouses create second", "POST", "/api/warehouses", {
    name: names.secondWarehouse,
    location: "QA",
  });
  await expect("warehouses list", "GET", "/api/warehouses", undefined, {
    validate(data) {
      assert.ok(Array.isArray(data));
      assert.ok(data.some((warehouse) => warehouse.name === names.mainWarehouse));
    },
  });

  const supplier = await expect("suppliers create", "POST", "/api/suppliers", {
    name: names.supplier,
    number: `09${RUN_ID.slice(-6)}`,
    balance: 0,
    balanceUSD: 0,
    balanceSYP: 0,
    purchases: [],
    defaultPaymentAccountId: state.accounts.cash,
    defaultPayableAccountId: state.accounts.payable,
    defaultInventoryAccountId: state.accounts.inventory,
  }, {
    validate(data) {
      assert.ok(data?.data?.id);
    },
  });
  state.ids.supplier = supplier.data?.data?.id;
  await expect("suppliers list", "GET", "/api/suppliers");
  await expect("suppliers by id", "POST", "/api/suppliers/byId", { id: state.ids.supplier });
  await expect("suppliers update", "PUT", `/api/suppliers/${state.ids.supplier}`, {
    name: `${names.supplier} Updated`,
    number: `09${RUN_ID.slice(-6)}`,
    defaultPaymentAccountId: state.accounts.cash,
    defaultPayableAccountId: state.accounts.payable,
    defaultInventoryAccountId: state.accounts.inventory,
  });

  const customer = await expect("customers create", "POST", "/api/customers", {
    name: names.customer,
    number: `09${RUN_ID.slice(-6)}`,
    balance: 0,
    balanceUSD: 0,
    balanceSYP: 0,
    purchases: [],
    defaultPaymentAccountId: state.accounts.cash,
    defaultReceivableAccountId: state.accounts.receivable,
    defaultSalesAccountId: state.accounts.sales,
  }, {
    validate(data) {
      assert.ok(data?.data?.id);
    },
  });
  state.ids.customer = customer.data?.data?.id;
  await expect("customers list", "GET", "/api/customers");
  await expect("customers by id", "POST", "/api/customers/byId", { id: state.ids.customer });
  await expect("customers update", "PUT", `/api/customers/${state.ids.customer}`, {
    name: `${names.customer} Updated`,
    number: `09${RUN_ID.slice(-6)}`,
    defaultPaymentAccountId: state.accounts.cash,
    defaultReceivableAccountId: state.accounts.receivable,
    defaultSalesAccountId: state.accounts.sales,
  });

  const directProduct = await expect("products create direct", "POST", "/api/products", {
    name: `QA Direct Product ${suffix}`,
    code: names.directProductCode,
    category: "Smoke",
    warehouse: names.mainWarehouse,
    payPrice: 5,
    wholesalePrice: 7,
    superWholesalePrice: 8,
    sellPrice: 10,
    unit: "pcs",
    quantity: 20,
    alertQuantity: 2,
  }, {
    validate(data) {
      assert.ok(data?.data?.id);
    },
  });
  state.ids.directProduct = directProduct.data?.data?.id;
  await expect("products by id", "POST", "/api/products/byId", { id: state.ids.directProduct });
  await expect("products by warehouse", "POST", "/api/products/getByWarehouse", { warehouse: names.mainWarehouse });
  await expect("products bulk update prices", "POST", "/api/products/bulk-update-prices", {
    productIds: [state.ids.directProduct],
    percentageIncrease: 5,
    priceType: "sellPrice",
  });
  await expect("products update", "PUT", `/api/products/${state.ids.directProduct}`, {
    alertQuantity: 3,
    sellPrice: 11,
  });

  const directPurchase = await expect("purchases create direct", "POST", "/api/purchases", {
    supplierId: state.ids.supplier,
    name: `QA Direct Purchase ${suffix}`,
    code: `DP-${suffix}`,
    warehouse: names.secondWarehouse,
    quantity: 1,
    payPrice: 4,
    totalPrice: 4,
    paymentStatus: "cash",
    remainingDebt: 0,
    currency: "USD",
    exchangeRate: 1,
    amount_base: 4,
    inventoryAccountId: state.accounts.inventory,
    payableAccountId: state.accounts.payable,
    paymentAccountId: state.accounts.cash,
    products: [{
      name: `QA Direct Purchase Product ${suffix}`,
      code: `DP-PROD-${suffix}`,
      category: "Smoke",
      warehouse: names.secondWarehouse,
      quantity: 1,
      payPrice: 4,
      sellPrice: 8,
      unit: "pcs",
      lineTotal: 4,
    }],
  }, {
    validate(data) {
      assert.ok(data?.data?.id);
    },
  });
  state.ids.directPurchase = directPurchase.data?.data?.id;
  await expect("purchases list", "GET", "/api/purchases");

  const purchaseTxn = await expect("transactions purchase single", "POST", "/api/transactions/purchase", {
    newPurchase: {
      id: "",
      supplierId: state.ids.supplier,
      name: `QA Txn Product ${suffix}`,
      code: names.productCode,
      warehouse: names.mainWarehouse,
      quantity: 10,
      payPrice: 6,
      totalPrice: 60,
      paymentStatus: "part",
      remainingDebt: 40,
      currency: "USD",
      paymentCurrency: "USD",
      exchangeRate: 1,
      amount_base: 20,
      partValue: 20,
      inventoryAccountId: state.accounts.inventory,
      payableAccountId: state.accounts.payable,
      paymentAccountId: state.accounts.cash,
      date: "",
    },
    newProduct: {
      id: "",
      name: `QA Txn Product ${suffix}`,
      code: names.productCode,
      category: "Smoke",
      warehouse: names.mainWarehouse,
      quantity: 10,
      payPrice: 6,
      wholesalePrice: 8,
      superWholesalePrice: 9,
      sellPrice: 12,
      unit: "pcs",
      alertQuantity: 2,
    },
  }, {
    validate(data) {
      assert.ok(data?.data?.id);
    },
  });
  state.ids.purchaseTxn = purchaseTxn.data?.data?.id;

  await expect("transactions purchase invoice bulk", "POST", "/api/transactions/purchase-invoice", {
    newPurchase: {
      id: "",
      supplierId: state.ids.supplier,
      code: `BULK-${suffix}`,
      paymentStatus: "debt",
      remainingDebt: 18,
      currency: "USD",
      paymentCurrency: "USD",
      exchangeRate: 1,
      amount_base: 18,
      inventoryAccountId: state.accounts.inventory,
      payableAccountId: state.accounts.payable,
      products: [{
        name: `QA Bulk Product ${suffix}`,
        code: `BULK-PROD-${suffix}`,
        category: "Smoke",
        warehouse: names.secondWarehouse,
        quantity: 2,
        payPrice: 9,
        sellPrice: 13,
        unit: "pcs",
        lineTotal: 18,
      }],
    },
  });

  const productsAfterPurchase = await getProducts();
  const txnProduct = productsAfterPurchase.find((product) => product.code === names.productCode);
  state.ids.txnProduct = requireId("transaction product id", txnProduct?.id);

  const sellDebt = await expect("transactions sell part", "POST", "/api/transactions/sell", {
    newSell: {
      customerId: state.ids.customer,
      products: [saleProduct(txnProduct, 2)],
      paymentStatus: "part",
      totalPrice: 24,
      remainingDebt: 14,
      partValue: 10,
      paymentAccountId: state.accounts.cash,
      receivableAccountId: state.accounts.receivable,
      salesAccountId: state.accounts.sales,
      currency: "USD",
      paymentCurrency: "USD",
      exchangeRate: 1,
      amount_base: 24,
    },
  }, {
    validate(data) {
      assert.ok(data?.data?.id);
    },
  });
  state.ids.sellDebt = sellDebt.data?.data?.id;

  await expect("transactions customer payment", "POST", "/api/transactions/customerPayment", {
    paymentData: {
      type: "income",
      customerId: state.ids.customer,
      sellId: state.ids.sellDebt,
      amount: 5,
      amountUSD: 5,
      amountOriginal: 5,
      amount_base: 5,
      currency: "USD",
      paymentCurrency: "USD",
      exchangeRate: 1,
      paymentAccountId: state.accounts.cash,
      receivableAccountId: state.accounts.receivable,
      note: "QA customer payment",
    },
  });

  await expect("transactions supplier payment", "POST", "/api/transactions/supplierPayment", {
    paymentData: {
      type: "expense",
      supplierId: state.ids.supplier,
      purchaseId: state.ids.purchaseTxn,
      amount: -10,
      amountUSD: -10,
      amountOriginal: -10,
      amount_base: -10,
      currency: "USD",
      paymentCurrency: "USD",
      exchangeRate: 1,
      paymentAccountId: state.accounts.cash,
      payableAccountId: state.accounts.payable,
      note: "QA supplier payment",
    },
  });

  await expect("transactions after sell discount", "POST", "/api/transactions/afterSellDiscount", {
    discount: 1,
    sellId: state.ids.sellDebt,
    customerId: state.ids.customer,
  });

  const sellCash = await expect("transactions sell cash for update/delete", "POST", "/api/transactions/sell", {
    newSell: {
      customerId: state.ids.customer,
      products: [saleProduct(txnProduct, 1)],
      paymentStatus: "cash",
      totalPrice: 12,
      remainingDebt: 0,
      partValue: 12,
      paymentAccountId: state.accounts.cash,
      salesAccountId: state.accounts.sales,
      currency: "USD",
      paymentCurrency: "USD",
      exchangeRate: 1,
      amount_base: 12,
    },
  }, {
    validate(data) {
      assert.ok(data?.data?.id);
    },
  });
  state.ids.sellCash = sellCash.data?.data?.id;
  await expect("sells list", "GET", "/api/sells");
  await expect("sells get by id", "GET", `/api/sells/${state.ids.sellCash}`);
  await expect("sells by warehouse date", "POST", "/api/sells/byWarehouseDate", {
    warehouse: names.mainWarehouse,
  });
  await expect("sells update by id", "PUT", `/api/sells/${state.ids.sellCash}`, {
    data: {
      products: [saleProduct(txnProduct, 1)],
    },
  });
  await expect("sells delete by id", "DELETE", `/api/sells/${state.ids.sellCash}`);

  await expect("transactions customer return", "POST", "/api/transactions/CustomerReturn", {
    newReturn: {
      customerId: state.ids.customer,
      referenceId: state.ids.sellDebt,
      returnType: "debt",
      partValue: 0,
      reason: "QA customer return",
      salesAccountId: state.accounts.sales,
      receivableAccountId: state.accounts.receivable,
      paymentAccountId: state.accounts.cash,
      products: [{
        productId: state.ids.txnProduct,
        code: names.productCode,
        warehouse: names.mainWarehouse,
        qty: 1,
      }],
    },
  });

  await expect("transactions supplier return", "POST", "/api/transactions/SupplierReturn", {
    newReturn: {
      supplierId: state.ids.supplier,
      referenceId: state.ids.purchaseTxn,
      productCode: names.productCode,
      productId: state.ids.txnProduct,
      warehouse: names.mainWarehouse,
      qty: 1,
      returnValue: 6,
      returnType: "debt",
      partValue: 0,
      reason: "QA supplier return",
      inventoryAccountId: state.accounts.inventory,
      payableAccountId: state.accounts.payable,
      paymentAccountId: state.accounts.cash,
    },
  });

  const transferProductResponse = await expect("products create transfer source", "POST", "/api/products", {
    name: `QA Transfer Product ${suffix}`,
    code: names.transferProductCode,
    category: "Smoke",
    warehouse: names.mainWarehouse,
    payPrice: 3,
    sellPrice: 7,
    unit: "pcs",
    quantity: 5,
  });
  state.ids.transferProduct = transferProductResponse.data?.data?.id;
  await expect("transactions warehouse transfer", "POST", "/api/transactions/warehouseTransfer", {
    transferData: {
      productId: state.ids.transferProduct,
      oldWarehouse: names.mainWarehouse,
      newWarehouse: names.secondWarehouse,
      quantity: 1,
      amount: 0,
      amount_base: 0,
      currency: "USD",
      exchangeRate: 1,
      note: "QA warehouse transfer",
      newSellPrice: 8,
    },
  });

  await expect("returns create direct using product id key", "POST", "/api/returns", {
    productCode: state.ids.directProduct,
    warehouse: names.mainWarehouse,
    qty: 1,
    type: "sale-return",
    referenceId: state.ids.sellDebt,
    reason: "QA direct return",
  }, {
    validate(data) {
      assert.ok(data?.data?.returnRecord?.id);
      state.ids.directReturn = data.data.returnRecord.id;
    },
  });
  await expect("returns list", "GET", "/api/returns");
  await expect("returns by id route", "POST", "/api/returns/byId", {
    id: state.ids.directReturn,
  });

  const quotation = await expect("quotations create", "POST", "/api/quotations", {
    customerId: state.ids.customer,
    customerName: names.customer,
    products: [saleProduct(txnProduct, 1)],
    currency: "USD",
    exchangeRate: 1,
    status: "draft",
  }, {
    expected: [201],
    validate(data) {
      assert.ok(data?.id);
    },
  });
  state.ids.quotation = quotation.data?.id;
  await expect("quotations list", "GET", "/api/quotations");
  await expect("quotations get by id", "GET", `/api/quotations/${state.ids.quotation}`);
  await expect("quotations update", "PUT", `/api/quotations/${state.ids.quotation}`, {
    customerId: state.ids.customer,
    customerName: names.customer,
    products: [saleProduct(txnProduct, 1)],
    status: "sent",
  });
  await expect("quotations mark converted", "POST", `/api/quotations/${state.ids.quotation}/converted`, {
    sellId: state.ids.sellDebt,
  });
  await expect("quotations delete", "DELETE", `/api/quotations/${state.ids.quotation}`);

  const reservation = await expect("material reservations create", "POST", "/api/material-reservations", {
    customerId: state.ids.customer,
    technicianName: "QA Technician",
    note: "QA reservation",
    items: [{
      productId: state.ids.txnProduct,
      warehouse: names.mainWarehouse,
      reservedQty: 1,
      sellPrice: 12,
    }],
  }, {
    validate(data) {
      assert.ok(data?.data?.id);
    },
  });
  state.ids.reservation = reservation.data?.data?.id;
  await expect("material reservations list", "GET", "/api/material-reservations");
  await expect("material reservations get by id", "GET", `/api/material-reservations/${state.ids.reservation}`);
  await expect("material reservations close", "POST", `/api/material-reservations/${state.ids.reservation}/close`, {
    items: [{
      productId: state.ids.txnProduct,
      warehouse: names.mainWarehouse,
      usedQty: 1,
    }],
    sell: {
      paymentStatus: "cash",
      currency: "USD",
      exchangeRate: 1,
      paymentAccountId: state.accounts.cash,
      salesAccountId: state.accounts.sales,
      receivableAccountId: state.accounts.receivable,
    },
  });
  const reservationCancel = await expect("material reservations create for cancel", "POST", "/api/material-reservations", {
    customerId: state.ids.customer,
    technicianName: "QA Technician",
    items: [{
      productId: state.ids.txnProduct,
      warehouse: names.mainWarehouse,
      reservedQty: 1,
      sellPrice: 12,
    }],
  });
  state.ids.reservationCancel = reservationCancel.data?.data?.id;
  await expect("material reservations cancel", "POST", `/api/material-reservations/${state.ids.reservationCancel}/cancel`);

  const vehicle = await expect("vehicles create", "POST", "/api/vehicles", {
    name: names.vehicleWarehouse,
    location: "QA route",
    plateNumber: `QA-${RUN_ID.slice(-4)}`,
    driverId: driverUser,
    driverName: driverUser,
    defaultPaymentAccountId: state.accounts.cash,
    defaultReceivableAccountId: state.accounts.receivable,
    defaultSalesAccountId: state.accounts.sales,
  }, {
    validate(data) {
      assert.ok(data?.data?.id);
    },
  });
  state.ids.vehicle = vehicle.data?.data?.id;
  await expect("vehicles list admin", "GET", "/api/vehicles");
  await expect("vehicles update", "PUT", `/api/vehicles/${state.ids.vehicle}`, {
    location: "QA route updated",
    plateNumber: `QA-${RUN_ID.slice(-4)}`,
    driverId: driverUser,
    driverName: driverUser,
    defaultPaymentAccountId: state.accounts.cash,
    defaultReceivableAccountId: state.accounts.receivable,
    defaultSalesAccountId: state.accounts.sales,
  });
  await expect("vehicles load", "POST", `/api/vehicles/${state.ids.vehicle}/load`, {
    sourceWarehouse: names.mainWarehouse,
    note: "QA vehicle load",
    items: [{
      productId: state.ids.transferProduct,
      quantity: 1,
      sellPrice: 8,
    }],
  });

  const driverLogin = await expect("auth login driver with tenant", "POST", "/api/auth/login", {
    tenantId: TENANT_ID,
    username: driverUser,
    password: PASSWORD,
  }, {
    auth: false,
    validate(data) {
      assert.ok(data?.token);
    },
  });
  const adminHeaders = state.headers;
  const driverHeaders = {
    Authorization: `Bearer ${driverLogin.data?.token}`,
    "X-Inventory-Tenant-Id": encodeURIComponent(TENANT_ID),
  };
  state.headers = driverHeaders;
  await expect("vehicles me diagnostics driver", "GET", "/api/vehicles/me/diagnostics");
  const myVehicle = await expect("vehicles me dashboard driver", "GET", "/api/vehicles/me");
  const vehicleProduct = myVehicle.data?.data?.products?.[0];
  if (vehicleProduct?.id) {
    await expect("vehicles me sell driver", "POST", "/api/vehicles/me/sell", {
      newSell: {
        customerId: state.ids.customer,
        products: [{
          id: vehicleProduct.id,
          qty: 1,
        }],
        paymentStatus: "cash",
        currency: "USD",
        exchangeRate: 1,
        paymentAccountId: state.accounts.cash,
        salesAccountId: state.accounts.sales,
        receivableAccountId: state.accounts.receivable,
      },
    });
  } else {
    await skip("vehicles me sell driver", "Vehicle product was not available after load");
  }
  state.headers = adminHeaders;

  await expect("invoice draft get empty", "GET", "/api/invoice-draft/me");
  await expect("invoice draft update", "PUT", "/api/invoice-draft/me", {
    draft: {
      customerId: state.ids.customer,
      products: [saleProduct(txnProduct, 1)],
      paymentStatus: "cash",
      currency: "USD",
      exchangeRate: 1,
      paymentAccountId: state.accounts.cash,
      salesAccountId: state.accounts.sales,
      receivableAccountId: state.accounts.receivable,
    },
  });
  await expect("invoice draft clear", "DELETE", "/api/invoice-draft/me");
  await expect("invoice draft checkout", "POST", "/api/invoice-draft/me/checkout", {
    newSell: {
      customerId: state.ids.customer,
      products: [saleProduct(txnProduct, 1)],
      paymentStatus: "cash",
      totalPrice: 12,
      remainingDebt: 0,
      partValue: 12,
      paymentAccountId: state.accounts.cash,
      salesAccountId: state.accounts.sales,
      currency: "USD",
      paymentCurrency: "USD",
      exchangeRate: 1,
      amount_base: 12,
    },
  });

  await expect("exchange create", "POST", "/api/exchange/createExchangeInternal", {
    id: `EX-${suffix}`,
    from: "USD",
    to: "SYP",
    amount_from: 10,
    amount_to: 100000,
    rate: 10000,
    note: "QA exchange",
  }, {
    expected: [201],
  });
  await expect("exchange list", "GET", "/api/exchange/getAll");
  await expect("transactions end exchange", "POST", "/api/transactions/endExchange", {
    id: `EX-${suffix}`,
    realRate: 10100,
    amount_final: 101000,
    exchangeData: {
      id: `EX-${suffix}`,
      from: "USD",
      to: "SYP",
      amount_from: 10,
      amount_to: 100000,
      rate: 10000,
    },
  });
  await expect("done exchange list", "GET", "/api/doneExchange/getAll");

  await expect("journal entries create manual", "POST", "/api/journal-entries/create", {
    journalEntry: {
      description: "QA balanced entry",
      lines: [
        { accountId: state.accounts.cash, debit: 1, credit: 0 },
        { accountId: state.accounts.sales, debit: 0, credit: 1 },
      ],
    },
  }, {
    expected: [201],
  });
  await expect("journal entries list", "GET", "/api/journal-entries");

  await expect("payments create direct", "POST", "/api/payments/create", {
    newPayment: {
      type: "income",
      customerId: state.ids.customer,
      paymentAccountId: state.accounts.cash,
      salesAccountId: state.accounts.sales,
      amount: 1,
      amountUSD: 1,
      amountOriginal: 1,
      amount_base: 1,
      currency: "USD",
      paymentCurrency: "USD",
      exchangeRate: 1,
      note: "QA direct payment",
    },
  });
  await expect("payments list", "GET", "/api/payments");
  const date = new Date();
  await expect("payments month", "GET", `/api/payments/month?month=${date.getMonth() + 1}&year=${date.getFullYear()}`);

  await expect("warehouses migrate from existing data", "GET", "/api/warehouses/migrate");

  await expect("ai save report", "POST", "/api/ai/save", {
    title: "QA AI Report",
    summary: "Smoke test report",
    sections: [{ title: "Status", content: "All checked by smoke test" }],
  });
  await expect("ai latest", "GET", "/api/ai/latest", undefined, {
    expected: [200, 404],
  });
  await expect("ai all data", "GET", "/api/ai/allData", undefined, {
    expected: [200, 404],
  });
  await expect("ai snapshot get", "GET", "/api/ai/snapshot/get", undefined, {
    expected: [200, 404],
  });
  await skip("ai ask", "Not executed to avoid external OpenAI API cost during smoke test");

  await expect("currency migration preview", "GET", "/api/currency-migration/preview");
  await expect("currency migration run isolated tenant", "POST", "/api/currency-migration/run");

  await expect("tenant isolation qa products still visible", "GET", "/api/products?pricing=full", undefined, {
    validate(data) {
      assert.ok(hasProductCode(data, names.productCode), "QA tenant product should be visible in its own tenant");
    },
  });

  const defaultLogin = await expect("tenant isolation default login", "POST", "/api/auth/login", {
    username: "and",
    password: "123123",
  }, {
    auth: false,
  });

  await expect("tenant isolation default products do not include qa data", "GET", "/api/products?pricing=full", undefined, {
    auth: false,
    headers: {
      Authorization: `Bearer ${defaultLogin.data?.token || ""}`,
    },
    validate(data) {
      assert.ok(
        !hasProductCode(data, names.productCode) &&
          !hasProductCode(data, names.directProductCode) &&
          !hasProductCode(data, names.transferProductCode),
        "Default tenant should not see QA tenant products"
      );
    },
  });

  const failureCount = results.filter((result) => result.status === "fail").length;
  const skipCount = results.filter((result) => result.status === "skip").length;
  const passCount = results.filter((result) => result.status === "pass").length;
  const report = {
    baseUrl: BASE_URL,
    tenantId: TENANT_ID,
    runId: RUN_ID,
    finishedAt: new Date().toISOString(),
    summary: {
      pass: passCount,
      fail: failureCount,
      skip: skipCount,
      total: results.length,
    },
    results,
  };

  console.log("\nSMOKE_TEST_REPORT");
  console.log(JSON.stringify(report, null, 2));

  if (failureCount > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  mark("smoke runner", "fail", {
    message: error.message,
    stack: error.stack,
  });
  console.log(JSON.stringify({ results }, null, 2));
  process.exitCode = 1;
});
