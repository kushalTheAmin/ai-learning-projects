/**
 * Authored gold extraction targets: 12 invoice records with the shapes that
 * break naive scoring — unicode vendor names, an empty line-item list, a
 * single item, two identical items, a null optional field, zero amounts.
 * Dates are ISO, money is plain numbers; that IS the schema contract the
 * extractors are graded against.
 */

export interface LineItem {
  description: string;
  qty: number;
  unit_price: number;
  total: number;
}

export interface Invoice {
  invoice_number: string;
  date: string;
  currency: string;
  vendor: { name: string; address: string };
  line_items: LineItem[];
  totals: { subtotal: number; tax: number; total: number };
  notes: string | null;
}

function item(description: string, qty: number, unit_price: number): LineItem {
  return { description, qty, unit_price, total: Math.round(qty * unit_price * 100) / 100 };
}

function totals(items: LineItem[], taxRate: number): Invoice["totals"] {
  const subtotal = Math.round(items.reduce((s, it) => s + it.total, 0) * 100) / 100;
  const tax = Math.round(subtotal * taxRate * 100) / 100;
  return { subtotal, tax, total: Math.round((subtotal + tax) * 100) / 100 };
}

function invoice(
  invoice_number: string,
  date: string,
  currency: string,
  vendor: Invoice["vendor"],
  items: LineItem[],
  taxRate: number,
  notes: string | null,
): Invoice {
  return { invoice_number, date, currency, vendor, line_items: items, totals: totals(items, taxRate), notes };
}

export const INVOICES: Invoice[] = [
  invoice(
    "INV-2024-0001",
    "2024-01-05",
    "USD",
    { name: "Acme Industrial Supply", address: "830 Foundry Rd, Dayton, OH 45402" },
    [item("M6 hex bolts, box of 500", 4, 23.5), item("Thread locker, 50ml", 2, 8.99), item("Torque wrench 5-25Nm", 1, 118.0)],
    0.0725,
    "net 30",
  ),
  invoice(
    "INV-2024-0002",
    "2024-01-19",
    "EUR",
    { name: "Müller & Söhne GmbH", address: "Hafenstraße 12, 20457 Hamburg" },
    [item("Kugellager 6204-2RS", 12, 4.85), item("Wellendichtring 25x40x7", 12, 1.6)],
    0.19,
    null,
  ),
  invoice(
    "INV-2024-0003",
    "2024-02-02",
    "USD",
    { name: "Blue Harbor Analytics", address: "410 Pier Ave, Suite 9, Santa Monica, CA 90405" },
    [item("Data pipeline audit, fixed fee", 1, 4800.0)],
    0.0,
    "paid on receipt",
  ),
  invoice(
    "INV-2024-0004",
    "2024-02-14",
    "JPY",
    { name: "北京烤鸭店株式会社", address: "東京都港区芝浦3-4-1" },
    [item("業務用ダクトフード", 2, 48500), item("排気ファン 350mm", 2, 21800), item("設置工事", 1, 60000)],
    0.1,
    "設置は2月末まで",
  ),
  invoice(
    "INV-2024-0005",
    "2024-02-27",
    "USD",
    { name: "Prairie Field Services LLC", address: "PO Box 118, Grand Island, NE 68802" },
    [],
    0.055,
    "retainer only, no billable items this cycle",
  ),
  invoice(
    "INV-2024-0006",
    "2024-03-08",
    "GBP",
    { name: "Wren & Co. Bookbinders", address: "14 Chandos Pl, London WC2N 4HS" },
    [item("Case binding, archival buckram", 30, 12.75), item("Foil stamping setup", 1, 45.0), item("Foil stamping per cover", 30, 1.1)],
    0.2,
    null,
  ),
  invoice(
    "INV-2024-0007",
    "2024-03-21",
    "USD",
    { name: "Sierra Rock & Aggregate", address: "7710 Quarry Loop, Reno, NV 89506" },
    [item("3/4\" crushed rock, per ton", 18, 34.0), item("3/4\" crushed rock, per ton", 18, 34.0)],
    0.0685,
    "two identical deliveries, billed per truck",
  ),
  invoice(
    "INV-2024-0008",
    "2024-04-01",
    "USD",
    { name: "Café Léon Wholesale", address: "221 Rue Royale, New Orleans, LA 70130" },
    [item("Chicory blend, 5lb bag", 24, 19.25), item("Espresso roast, 5lb bag", 16, 22.4), item("Burlap tote, printed", 50, 3.15)],
    0.0945,
    "deliver before 6am",
  ),
  invoice(
    "INV-2024-0009",
    "2024-04-16",
    "CAD",
    { name: "Northshore Marine Electric", address: "88 Dock St, Halifax, NS B3J 1B4" },
    [item("Shore power pedestal rebuild", 3, 640.0)],
    0.15,
    "warranty work excluded",
  ),
  invoice(
    "INV-2024-0010",
    "2024-05-03",
    "USD",
    { name: "Vega Print Bureau", address: "1900 Mission St, San Francisco, CA 94103" },
    [
      item("A2 poster, 200gsm matte", 120, 2.6),
      item("A5 flyer, 130gsm gloss", 2000, 0.08),
      item("Banner 3m vinyl", 4, 74.5),
      item("Design revision hour", 3, 95.0),
      item("Rush surcharge", 1, 0.0),
    ],
    0.0863,
    "rush order",
  ),
  invoice(
    "INV-2024-0011",
    "2024-05-22",
    "USD",
    { name: "Ridgeview Orchard Co-op", address: "5202 Orchard Rd, Wenatchee, WA 98801" },
    [item("Honeycrisp, 40lb crate", 55, 61.0), item("Cold storage, per crate-week", 220, 1.45)],
    0.0,
    null,
  ),
  invoice(
    "INV-2024-0012",
    "2024-06-09",
    "USD",
    { name: "Delta Test & Measurement", address: "312 Calibration Ct, Huntsville, AL 35805" },
    [
      item("DMM calibration w/ cert", 6, 88.0),
      item("Oscilloscope calibration", 2, 240.0),
      item("Shipping & handling", 1, 62.3),
      item("Expedite fee", 1, 120.0),
    ],
    0.09,
    "certs emailed as PDF",
  ),
];
