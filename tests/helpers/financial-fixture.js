const account = (id, nature, type) => ({
  id,
  name: id,
  nature,
  type,
  currency: "USD",
  allowTransactions: true,
  isActive: true,
  openingBalance: 0,
  currentBalance: 0,
  currentBalanceUSD: 0,
  currentBalanceSYP: 0,
});
const companyFixture = () => ({
  users: {
    owner: { username: "owner", password: "local-only", role: "admin" },
  },
  accounts: {
    cash: account("cash", "Debit", "Asset"),
    receivable: account("receivable", "Debit", "Asset"),
    sales: account("sales", "Credit", "Revenue"),
    inventory: account("inventory", "Debit", "Asset"),
    payable: account("payable", "Credit", "Liability"),
  },
  products: {
    main: {
      p1: {
        id: "p1",
        code: "P1",
        name: "Test product",
        warehouse: "main",
        quantity: 50,
        reservedQuantity: 0,
        sellPrice: 10,
        payPrice: 4,
      },
    },
  },
  customer: {
    c1: {
      id: "c1",
      name: "Test customer",
      balance: 0,
      balanceUSD: 0,
      balanceSYP: 0,
      purchases: [],
    },
  },
  supplier: {
    s1: {
      id: "s1",
      name: "Test supplier",
      balance: 0,
      balanceUSD: 0,
      balanceSYP: 0,
      purchases: [],
    },
  },
  customSetting: { preserved: "unknown legacy configuration" },
});
const sale = (status = "cash") => ({
  customerId: "c1",
  products: [
    {
      id: "p1",
      code: "P1",
      name: "Test product",
      warehouse: "main",
      quantity: 50,
      qty: 2,
      sellPrice: 10,
      payPrice: 4,
      selectedPriceType: "sellPrice",
    },
  ],
  paymentStatus: status,
  paymentAccountId: "cash",
  salesAccountId: "sales",
  receivableAccountId: "receivable",
  currency: "USD",
  exchangeRate: 1,
  totalPrice: 20,
  remainingDebt: status === "debt" ? 20 : 0,
});
module.exports = { companyFixture, sale };
