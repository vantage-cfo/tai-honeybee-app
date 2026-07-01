// Single source of truth for both renderer dropdowns and RunParams mapping.
module.exports = {
  // customerId values extracted from the live TAI collections-summary hrefs
  // (invoice-search?customerId=…) on 2026-07-01.
  PAYERS: [
    { label: 'CM - Binghamton (2031) c/o CTSI', customerId: '793141' },
    { label: 'CM - Bloomington (2407) c/o CTSI', customerId: '793148' },
    { label: 'CM - El Paso (2406) c/o CTSI',     customerId: '793144' },
    { label: 'CM - Medina (2047) c/o CTSI',      customerId: '793146' },
    { label: 'CM - Solon (2407) c/o CTSI',       customerId: '817810' },
    { label: 'CM - Urbandale (2033) c/o CTSI',   customerId: '793142' },
    { label: 'CM - VENDOR',                       customerId: '871305' },
    { label: 'CM - West Bend (2040) c/o CTSI',   customerId: '789678' },
    { label: 'CM - Westfield (2039) c/o CTSI',   customerId: '793145' },
  ],
  ACCOUNTS: [
    { label: '2036 - CENTROMOTION [USD]',        account: '2036' },
    { label: '2407 - CMBF PRODUCTS, INC. [USD]', account: '2407' },
  ],
};
