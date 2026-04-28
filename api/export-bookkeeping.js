import verifyAdmin from "./_verifyAdmin.js";
import { createClient } from "@supabase/supabase-js";
import ExcelJS from "exceljs";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const SETTINGS_LISTS = {
  pmt_method: ["Cash", "PayPal", "Venmo", "Check"],
  booking_status: ["Completed", "Cancelled", "Refunded"],
  payment_status: ["Paid", "Partial", "Unpaid", "Refunded"],
  service_category: ["Interior", "Exterior", "Combined", "Paint Correction", "Maintenance", "Add-On", "Other"],
  expense_category: [
    "Chemicals", "Towels / Supplies", "Equipment", "Fuel",
    "Truck Maintenance / Repairs", "Advertising / Marketing",
    "Website / Software", "Insurance", "Phone",
    "Payment Processing Fees", "Business Meals", "Office / Admin",
    "Taxes / Fees", "Other"
  ],
  expense_type: [
    "Direct Cost", "Operating Expense", "Asset Purchase",
    "Owner Draw", "Owner Contribution", "Liability Payment"
  ],
  expense_payment_method: [
    "Cash", "PayPal", "Venmo", "Check", "Credit Card", "Bank Transfer", "Other"
  ],
  yes_no: ["Yes", "No"],
  data_source: ["Manual", "Booking System", "Import"]
};

const HEADER_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
const HEADER_FONT = { name: "Calibri", size: 11, bold: true, color: { argb: "FFFFFFFF" } };
const TITLE_FONT = { name: "Calibri", size: 18, bold: true, color: { argb: "FF1F3864" } };
const SUBTITLE_FONT = { name: "Calibri", size: 12, bold: true, color: { argb: "FF1F3864" } };

const MONEY_FMT = '$#,##0;[Red]($#,##0);"-"';
const MONEY_FMT_2DP = '$#,##0.00;[Red]($#,##0.00);"-"';
const PCT_FMT = "0.0%";
const DATE_FMT = "yyyy-mm-dd";
const MONTH_FMT = "mmm yyyy";

function styleHeaderRow(ws, rowNum, ncols) {
  for (let c = 1; c <= ncols; c++) {
    const cell = ws.getRow(rowNum).getCell(c);
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { horizontal: "left", vertical: "middle" };
  }
}

function setColWidths(ws, widths) {
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });
}

function bookingServiceCategory(b) {
  return b.service_variants?.services?.category || "Other";
}

function bookingServiceLevel(b) {
  return b.service_variants?.services?.level || "";
}

function bookingDescription(b) {
  const cat = bookingServiceCategory(b);
  const lvl = bookingServiceLevel(b);
  const veh = b.vehicles
    ? `${b.vehicles.vehicle_year || ""} ${b.vehicles.vehicle_make || ""} ${b.vehicles.vehicle_model || ""}`.trim()
    : "";
  return [cat, lvl, veh].filter(Boolean).join(" — ");
}

function paymentStatusFromCollected(expectedTotal, amountCollected) {
  const exp = Number(expectedTotal) || 0;
  const got = Number(amountCollected) || 0;
  if (got <= 0) return "Unpaid";
  if (got + 0.01 < exp) return "Partial";
  return "Paid";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-session");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  try {
    await verifyAdmin(req);
  } catch (err) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    const supabase = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY")
    );

    // ---------- Fetch data ----------
    const { data: bookings, error: bookErr } = await supabase
      .from("bookings")
      .select(`
        id,
        scheduled_start,
        status,
        service_address,
        base_price,
        travel_fee,
        total_price,
        discount_code,
        discount_percent,
        discount_amount,
        customer_notes,
        customers:customer_id ( full_name ),
        vehicles:vehicle_id ( vehicle_year, vehicle_make, vehicle_model, vehicle_size ),
        service_variants:service_variant_id ( services:service_id ( category, level ) ),
        job_payments ( amount_collected, tip_amount, payment_method, notes )
      `)
      .in("status", ["completed", "cancelled"])
      .order("scheduled_start", { ascending: true });

    if (bookErr) {
      console.error("export-bookkeeping bookings query failed", bookErr);
      return res.status(500).json({ error: "Bookings query failed" });
    }

    const { data: expenses, error: expErr } = await supabase
      .from("expenses")
      .select("id, expense_date, vendor, category, expense_type, description, amount, payment_method, receipt_saved, notes")
      .order("expense_date", { ascending: true });

    if (expErr) {
      console.error("export-bookkeeping expenses query failed", expErr);
      return res.status(500).json({ error: "Expenses query failed" });
    }

    // ---------- Build workbook ----------
    const wb = new ExcelJS.Workbook();
    wb.creator = "Moon Auto Detailing";
    wb.created = new Date();

    // === README ===
    const readme = wb.addWorksheet("README");
    readme.getCell("A1").value = "Moon Auto Detailing — Bookkeeping Workbook";
    readme.getCell("A1").font = TITLE_FONT;
    readme.mergeCells("A1:D1");

    const readmeLines = [
      ["", ""],
      ["Generated", new Date().toISOString().split("T")[0]],
      ["", ""],
      ["Source", "Live export from Supabase. Read-only — do not edit."],
      ["", ""],
      ["WHAT'S IN HERE", ""],
      ["Jobs", "Every completed and cancelled booking. Revenue uses Amount Collected."],
      ["Expenses", "Every expense logged via the admin Expenses panel."],
      ["Monthly Summary", "Auto-aggregated by month. Drives statements + dashboard."],
      ["Income Statement", "Revenue, costs, profit, margin by month."],
      ["Cash Flow", "Beginning balance, inflows, outflows, ending balance by month."],
      ["Balance Sheet", "Assets, liabilities, equity. Yellow cells are manual."],
      ["Dashboard", "Quick visual overview."],
      ["", ""],
      ["EXPENSE TYPE GUIDE", ""],
      ["Direct Cost", "Chemicals, towels, supplies consumed on jobs. Hits gross profit."],
      ["Operating Expense", "Insurance, phone, ads, software, fuel, truck maint, meals, office. Hits net profit."],
      ["Asset Purchase", "Polisher, pressure washer, vacuum. Goes to Balance Sheet, NOT P&L."],
      ["Owner Draw", "Money taken out for personal use. Cash flow + Equity, NOT an expense."],
      ["Owner Contribution", "Personal money put in. Cash flow + Equity, NOT income."],
      ["Liability Payment", "Paying down credit card or loan principal. Reduces cash + liability, not an expense."]
    ];
    readmeLines.forEach((pair, i) => {
      const r = i + 2;
      readme.getCell(`A${r}`).value = pair[0];
      readme.getCell(`B${r}`).value = pair[1];
      if (pair[0] && pair[0] === pair[0].toUpperCase() && pair[0].length > 3) {
        readme.getCell(`A${r}`).font = { bold: true };
      }
      readme.getCell(`B${r}`).alignment = { wrapText: true, vertical: "top" };
    });
    setColWidths(readme, [22, 90]);

    // === Settings ===
    const settings = wb.addWorksheet("Settings");
    settings.getCell("A1").value = "Settings — Dropdown Lists (reference only)";
    settings.getCell("A1").font = TITLE_FONT;
    settings.getCell("A3").value = "Lists used elsewhere in this workbook.";
    settings.getCell("A3").font = { italic: true, color: { argb: "FF595959" } };

    const headerRow = 5;
    let col = 1;
    const namedRanges = {};
    Object.entries(SETTINGS_LISTS).forEach(([name, values]) => {
      const cellHeader = settings.getRow(headerRow).getCell(col);
      cellHeader.value = name;
      cellHeader.fill = HEADER_FILL;
      cellHeader.font = HEADER_FONT;
      values.forEach((v, i) => {
        settings.getRow(headerRow + 1 + i).getCell(col).value = v;
      });
      const colLetter = settings.getColumn(col).letter;
      namedRanges[name] = `Settings!$${colLetter}$${headerRow + 1}:$${colLetter}$${headerRow + values.length}`;
      col += 1;
    });
    setColWidths(settings, Object.keys(SETTINGS_LISTS).map(() => 22));

    Object.entries(namedRanges).forEach(([name, ref]) => {
      try {
        wb.definedNames.add(ref, name);
      } catch (e) {
        // exceljs definedNames API quirks; non-fatal
      }
    });

    // === Jobs ===
    const jobs = wb.addWorksheet("Jobs");
    const jobsHeaders = [
      "Job ID", "Booking ID", "Date Completed", "Customer Name",
      "Service Category", "Service Description", "Base Price",
      "Add-On Price", "Travel Fee", "Discount Amount", "Expected Total",
      "Amount Collected", "Tip Amount", "Payment Method", "Payment Status",
      "Booking Status", "Notes", "Data Source"
    ];
    jobs.addRow(jobsHeaders);
    styleHeaderRow(jobs, 1, jobsHeaders.length);
    setColWidths(jobs, [12, 14, 14, 22, 18, 32, 11, 11, 11, 13, 13, 14, 11, 14, 14, 14, 30, 14]);

    // Sort/group bookings by year for J-YYYY-### numbering
    const completedBookings = (bookings || []).filter(b => b.status === "completed" || b.status === "cancelled");
    const yearCounters = {};
    completedBookings.forEach((b, idx) => {
      const dateStr = b.scheduled_start ? b.scheduled_start.split("T")[0] : "";
      const year = dateStr ? dateStr.split("-")[0] : "0000";
      yearCounters[year] = (yearCounters[year] || 0) + 1;
      const jobId = `J-${year}-${String(yearCounters[year]).padStart(3, "0")}`;

      const payment = (b.job_payments && b.job_payments.length > 0) ? b.job_payments[0] : null;
      const amountCollected = payment ? Number(payment.amount_collected) || 0 : 0;
      const tipAmount = payment ? Number(payment.tip_amount) || 0 : 0;
      const paymentMethod = payment ? payment.payment_method : "";
      const expectedTotal = Number(b.total_price) || 0;
      const paymentStatus = b.status === "cancelled"
        ? "Refunded"
        : paymentStatusFromCollected(expectedTotal, amountCollected);
      const bookingStatus = b.status === "cancelled" ? "Cancelled" : "Completed";

      const dateValue = dateStr ? new Date(dateStr + "T00:00:00") : null;

      jobs.addRow([
        jobId,
        b.id,
        dateValue,
        b.customers?.full_name || "",
        bookingServiceCategory(b),
        bookingDescription(b),
        Number(b.base_price) || 0,
        0,
        Number(b.travel_fee) || 0,
        Number(b.discount_amount) || 0,
        expectedTotal,
        amountCollected,
        tipAmount,
        paymentMethod,
        paymentStatus,
        bookingStatus,
        payment?.notes || b.customer_notes || "",
        "Booking System"
      ]);
    });

    // Number formats
    const jobsLastRow = jobs.lastRow ? jobs.lastRow.number : 1;
    for (let r = 2; r <= jobsLastRow; r++) {
      jobs.getRow(r).getCell(3).numFmt = DATE_FMT;
      [7, 8, 9, 10, 11, 12, 13].forEach(c => {
        jobs.getRow(r).getCell(c).numFmt = MONEY_FMT_2DP;
      });
    }

    jobs.views = [{ state: "frozen", ySplit: 1 }];

    // === Expenses ===
    const expensesSheet = wb.addWorksheet("Expenses");
    const expHeaders = [
      "Expense ID", "Date", "Vendor", "Expense Category", "Expense Type",
      "Description", "Amount", "Payment Method", "Receipt Saved?", "Notes"
    ];
    expensesSheet.addRow(expHeaders);
    styleHeaderRow(expensesSheet, 1, expHeaders.length);
    setColWidths(expensesSheet, [14, 12, 22, 22, 20, 30, 12, 14, 14, 30]);

    const yearCountersExp = {};
    (expenses || []).forEach((e) => {
      const dateStr = e.expense_date || "";
      const year = dateStr ? dateStr.split("-")[0] : "0000";
      yearCountersExp[year] = (yearCountersExp[year] || 0) + 1;
      const expId = `E-${year}-${String(yearCountersExp[year]).padStart(3, "0")}`;

      const dateValue = dateStr ? new Date(dateStr + "T00:00:00") : null;

      expensesSheet.addRow([
        expId,
        dateValue,
        e.vendor || "",
        e.category || "",
        e.expense_type || "",
        e.description || "",
        Number(e.amount) || 0,
        e.payment_method || "",
        e.receipt_saved ? "Yes" : "No",
        e.notes || ""
      ]);
    });

    const expLastRow = expensesSheet.lastRow ? expensesSheet.lastRow.number : 1;
    for (let r = 2; r <= expLastRow; r++) {
      expensesSheet.getRow(r).getCell(2).numFmt = DATE_FMT;
      expensesSheet.getRow(r).getCell(7).numFmt = MONEY_FMT_2DP;
    }
    expensesSheet.views = [{ state: "frozen", ySplit: 1 }];

    // === Monthly Summary ===
    const monthly = wb.addWorksheet("Monthly Summary");
    const msHeaders = [
      "Month", "Completed Paid Jobs", "Revenue Collected", "Direct Costs",
      "Gross Profit", "Operating Expenses", "Net Profit", "Profit Margin",
      "Cash Collected", "PayPal Collected", "Venmo Collected", "Check Collected",
      "Total Expenses", "Owner Draws", "Owner Contributions"
    ];
    monthly.addRow(msHeaders);
    styleHeaderRow(monthly, 1, msHeaders.length);
    setColWidths(monthly, [11, 14, 16, 14, 14, 16, 14, 12, 14, 16, 16, 16, 16, 14, 18]);

    // Determine month range: from earliest activity to current month + 6 months ahead
    const allDates = [];
    completedBookings.forEach(b => { if (b.scheduled_start) allDates.push(b.scheduled_start.split("T")[0]); });
    (expenses || []).forEach(e => { if (e.expense_date) allDates.push(e.expense_date); });
    const today = new Date();
    const todayStr = today.toISOString().split("T")[0];
    allDates.push(todayStr);

    let earliest = allDates.sort()[0] || todayStr;
    const startYear = Number(earliest.split("-")[0]);
    const startMonth = Number(earliest.split("-")[1]);

    const months = [];
    let cy = startYear, cm = startMonth;
    for (let i = 0; i < 36; i++) {
      months.push(new Date(cy, cm - 1, 1));
      cm += 1;
      if (cm > 12) { cm = 1; cy += 1; }
    }

    months.forEach((mDate, i) => {
      const r = i + 2;
      monthly.getRow(r).getCell(1).value = mDate;
      monthly.getRow(r).getCell(1).numFmt = MONTH_FMT;

      // Completed Paid Jobs
      monthly.getRow(r).getCell(2).value = {
        formula: `COUNTIFS(Jobs!C:C,">="&A${r},Jobs!C:C,"<"&EDATE(A${r},1),Jobs!P:P,"Completed",Jobs!L:L,">0")`
      };
      // Revenue Collected
      monthly.getRow(r).getCell(3).value = {
        formula: `SUMIFS(Jobs!L:L,Jobs!C:C,">="&A${r},Jobs!C:C,"<"&EDATE(A${r},1),Jobs!P:P,"Completed")`
      };
      // Direct Costs
      monthly.getRow(r).getCell(4).value = {
        formula: `SUMIFS(Expenses!G:G,Expenses!B:B,">="&A${r},Expenses!B:B,"<"&EDATE(A${r},1),Expenses!E:E,"Direct Cost")`
      };
      // Gross Profit
      monthly.getRow(r).getCell(5).value = { formula: `C${r}-D${r}` };
      // Operating Expenses
      monthly.getRow(r).getCell(6).value = {
        formula: `SUMIFS(Expenses!G:G,Expenses!B:B,">="&A${r},Expenses!B:B,"<"&EDATE(A${r},1),Expenses!E:E,"Operating Expense")`
      };
      // Net Profit
      monthly.getRow(r).getCell(7).value = { formula: `E${r}-F${r}` };
      // Profit Margin
      monthly.getRow(r).getCell(8).value = { formula: `IF(C${r}=0,0,G${r}/C${r})` };
      // Cash Collected
      monthly.getRow(r).getCell(9).value = {
        formula: `SUMIFS(Jobs!L:L,Jobs!C:C,">="&A${r},Jobs!C:C,"<"&EDATE(A${r},1),Jobs!P:P,"Completed",Jobs!N:N,"Cash")`
      };
      // PayPal Collected
      monthly.getRow(r).getCell(10).value = {
        formula: `SUMIFS(Jobs!L:L,Jobs!C:C,">="&A${r},Jobs!C:C,"<"&EDATE(A${r},1),Jobs!P:P,"Completed",Jobs!N:N,"PayPal")`
      };
      // Venmo Collected
      monthly.getRow(r).getCell(11).value = {
        formula: `SUMIFS(Jobs!L:L,Jobs!C:C,">="&A${r},Jobs!C:C,"<"&EDATE(A${r},1),Jobs!P:P,"Completed",Jobs!N:N,"Venmo")`
      };
      // Check Collected
      monthly.getRow(r).getCell(12).value = {
        formula: `SUMIFS(Jobs!L:L,Jobs!C:C,">="&A${r},Jobs!C:C,"<"&EDATE(A${r},1),Jobs!P:P,"Completed",Jobs!N:N,"Check")`
      };
      // Total Expenses
      monthly.getRow(r).getCell(13).value = { formula: `D${r}+F${r}` };
      // Owner Draws
      monthly.getRow(r).getCell(14).value = {
        formula: `SUMIFS(Expenses!G:G,Expenses!B:B,">="&A${r},Expenses!B:B,"<"&EDATE(A${r},1),Expenses!E:E,"Owner Draw")`
      };
      // Owner Contributions
      monthly.getRow(r).getCell(15).value = {
        formula: `SUMIFS(Expenses!G:G,Expenses!B:B,">="&A${r},Expenses!B:B,"<"&EDATE(A${r},1),Expenses!E:E,"Owner Contribution")`
      };

      [3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15].forEach(c => {
        monthly.getRow(r).getCell(c).numFmt = MONEY_FMT;
      });
      monthly.getRow(r).getCell(8).numFmt = PCT_FMT;
    });

    monthly.views = [{ state: "frozen", xSplit: 1, ySplit: 1 }];

    // === Income Statement === (months across columns B..M, line items down rows)
    const income = wb.addWorksheet("Income Statement");
    income.getCell("A1").value = "Income Statement";
    income.getCell("A1").font = TITLE_FONT;

    income.getCell("A3").value = "Line Item";
    for (let i = 0; i < 12; i++) {
      const colIdx = 2 + i;
      const colLetter = income.getColumn(colIdx).letter;
      income.getRow(3).getCell(colIdx).value = { formula: `'Monthly Summary'!A${2 + i}` };
      income.getRow(3).getCell(colIdx).numFmt = MONTH_FMT;
    }
    styleHeaderRow(income, 3, 13);

    const incomeLines = [
      { label: "Revenue Collected", srcCol: "C" },
      { label: "Direct Costs", srcCol: "D" },
      { label: "Gross Profit", formula: (col) => `${col}4-${col}5` },
      { label: "Operating Expenses", srcCol: "F" },
      { label: "Net Profit", formula: (col) => `${col}6-${col}7` },
      { label: "Profit Margin", formula: (col) => `IF(${col}4=0,0,${col}8/${col}4)`, pct: true }
    ];
    incomeLines.forEach((line, idx) => {
      const r = 4 + idx;
      income.getRow(r).getCell(1).value = line.label;
      if (["Gross Profit", "Net Profit", "Profit Margin"].indexOf(line.label) !== -1) {
        income.getRow(r).getCell(1).font = { bold: true };
      }
      for (let i = 0; i < 12; i++) {
        const colIdx = 2 + i;
        const colLetter = income.getColumn(colIdx).letter;
        const cell = income.getRow(r).getCell(colIdx);
        if (line.formula) {
          cell.value = { formula: line.formula(colLetter) };
        } else {
          cell.value = { formula: `'Monthly Summary'!${line.srcCol}${2 + i}` };
        }
        cell.numFmt = line.pct ? PCT_FMT : MONEY_FMT;
      }
    });
    setColWidths(income, [22, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12]);
    income.views = [{ state: "frozen", xSplit: 1, ySplit: 3 }];

    // === Cash Flow ===
    const cashflow = wb.addWorksheet("Cash Flow");
    cashflow.getCell("A1").value = "Cash Flow";
    cashflow.getCell("A1").font = TITLE_FONT;
    cashflow.getCell("A3").value = "Enter starting cash for the first month in B6. Yellow.";
    cashflow.getCell("A3").font = { italic: true, color: { argb: "FF595959" } };

    for (let i = 0; i < 12; i++) {
      const colIdx = 2 + i;
      const cell = cashflow.getRow(5).getCell(colIdx);
      cell.value = { formula: `'Monthly Summary'!A${2 + i}` };
      cell.numFmt = MONTH_FMT;
    }
    styleHeaderRow(cashflow, 5, 13);

    const cfLabels = [
      "Beginning Cash Balance",
      "Cash Inflows from Jobs",
      "Owner Contributions",
      "Expense Outflows",
      "Owner Draws",
      "Net Cash Flow",
      "Ending Cash Balance"
    ];
    cfLabels.forEach((label, idx) => {
      const r = 6 + idx;
      cashflow.getRow(r).getCell(1).value = label;
      if (label === "Net Cash Flow" || label === "Ending Cash Balance") {
        cashflow.getRow(r).getCell(1).font = { bold: true };
      }
    });

    cashflow.getCell("B6").value = 0;
    cashflow.getCell("B6").fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };

    for (let i = 0; i < 12; i++) {
      const colIdx = 2 + i;
      const colLetter = cashflow.getColumn(colIdx).letter;
      if (i > 0) {
        const prev = cashflow.getColumn(colIdx - 1).letter;
        cashflow.getRow(6).getCell(colIdx).value = { formula: `${prev}12` };
      }
      cashflow.getRow(7).getCell(colIdx).value = { formula: `'Monthly Summary'!C${2 + i}` };
      cashflow.getRow(8).getCell(colIdx).value = { formula: `'Monthly Summary'!O${2 + i}` };
      cashflow.getRow(9).getCell(colIdx).value = { formula: `'Monthly Summary'!M${2 + i}` };
      cashflow.getRow(10).getCell(colIdx).value = { formula: `'Monthly Summary'!N${2 + i}` };
      cashflow.getRow(11).getCell(colIdx).value = { formula: `${colLetter}7+${colLetter}8-${colLetter}9-${colLetter}10` };
      cashflow.getRow(12).getCell(colIdx).value = { formula: `${colLetter}6+${colLetter}11` };
    }
    for (let r = 6; r <= 12; r++) {
      for (let c = 2; c <= 13; c++) {
        cashflow.getRow(r).getCell(c).numFmt = MONEY_FMT;
      }
    }
    setColWidths(cashflow, [26, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12]);
    cashflow.views = [{ state: "frozen", xSplit: 1, ySplit: 5 }];

    // === Balance Sheet ===
    const bs = wb.addWorksheet("Balance Sheet");
    bs.getCell("A1").value = "Balance Sheet";
    bs.getCell("A1").font = TITLE_FONT;
    bs.getCell("A3").value = "Snapshot — yellow cells are manual entries.";
    bs.getCell("A3").font = { italic: true, color: { argb: "FF595959" } };
    bs.getCell("A5").value = "As of:";
    bs.getCell("B5").value = { formula: "EOMONTH(TODAY(),-1)" };
    bs.getCell("B5").numFmt = DATE_FMT;

    bs.getCell("A7").value = "ASSETS";
    bs.getCell("A7").font = SUBTITLE_FONT;
    bs.getCell("A8").value = "Cash";
    bs.getCell("B8").value = { formula: "'Cash Flow'!M12" };
    bs.getCell("A9").value = "Equipment";
    bs.getCell("B9").value = 0;
    bs.getCell("A10").value = "Supplies Inventory";
    bs.getCell("B10").value = 0;
    bs.getCell("A11").value = "Total Assets";
    bs.getCell("B11").value = { formula: "SUM(B8:B10)" };
    bs.getCell("A11").font = { bold: true };
    bs.getCell("B11").font = { bold: true };

    bs.getCell("A13").value = "LIABILITIES";
    bs.getCell("A13").font = SUBTITLE_FONT;
    bs.getCell("A14").value = "Credit Card Balance";
    bs.getCell("B14").value = 0;
    bs.getCell("A15").value = "Loans";
    bs.getCell("B15").value = 0;
    bs.getCell("A16").value = "Taxes Payable";
    bs.getCell("B16").value = 0;
    bs.getCell("A17").value = "Total Liabilities";
    bs.getCell("B17").value = { formula: "SUM(B14:B16)" };
    bs.getCell("A17").font = { bold: true };
    bs.getCell("B17").font = { bold: true };

    bs.getCell("A19").value = "EQUITY";
    bs.getCell("A19").font = SUBTITLE_FONT;
    bs.getCell("A20").value = "Owner Contributions (YTD)";
    bs.getCell("B20").value = { formula: "SUM('Monthly Summary'!O2:O13)" };
    bs.getCell("A21").value = "Owner Draws (YTD)";
    bs.getCell("B21").value = { formula: "-SUM('Monthly Summary'!N2:N13)" };
    bs.getCell("A22").value = "Retained Earnings (YTD)";
    bs.getCell("B22").value = { formula: "SUM('Monthly Summary'!G2:G13)" };
    bs.getCell("A23").value = "Total Equity";
    bs.getCell("B23").value = { formula: "SUM(B20:B22)" };
    bs.getCell("A23").font = { bold: true };
    bs.getCell("B23").font = { bold: true };

    bs.getCell("A25").value = "Check (Assets − Liab − Equity)";
    bs.getCell("B25").value = { formula: "B11-B17-B23" };
    bs.getCell("A25").font = { bold: true, italic: true };

    const yellow = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
    ["B9", "B10", "B14", "B15", "B16"].forEach(addr => { bs.getCell(addr).fill = yellow; });
    ["B8", "B9", "B10", "B11", "B14", "B15", "B16", "B17", "B20", "B21", "B22", "B23", "B25"]
      .forEach(addr => { bs.getCell(addr).numFmt = MONEY_FMT; });
    setColWidths(bs, [32, 16]);

    // === Dashboard ===
    const dash = wb.addWorksheet("Dashboard");
    dash.getCell("A1").value = "Dashboard";
    dash.getCell("A1").font = TITLE_FONT;
    dash.getCell("A3").value = "Selected Month:";
    dash.getCell("A3").font = { bold: true };
    dash.getCell("B3").value = { formula: "DATE(YEAR(TODAY()),MONTH(TODAY()),1)" };
    dash.getCell("B3").numFmt = MONTH_FMT;
    dash.getCell("B3").fill = yellow;

    function dashLookup(colIdx) {
      const colLetter = monthly.getColumn(colIdx).letter;
      return `IFERROR(INDEX('Monthly Summary'!${colLetter}:${colLetter},MATCH($B$3,'Monthly Summary'!A:A,0)),0)`;
    }

    const dashRows = [
      ["Revenue this month", { formula: dashLookup(3) }, MONEY_FMT],
      ["Expenses this month", { formula: dashLookup(13) }, MONEY_FMT],
      ["Net Profit this month", { formula: dashLookup(7) }, MONEY_FMT],
      ["Profit Margin", { formula: dashLookup(8) }, PCT_FMT],
      ["Jobs Completed", { formula: dashLookup(2) }, "#,##0"],
      ["Average Collected per Job", { formula: "IFERROR(B5/B9,0)" }, MONEY_FMT],
      ["Cash Collected", { formula: dashLookup(9) }, MONEY_FMT],
      ["PayPal Collected", { formula: dashLookup(10) }, MONEY_FMT],
      ["Venmo Collected", { formula: dashLookup(11) }, MONEY_FMT],
      ["Check Collected", { formula: dashLookup(12) }, MONEY_FMT]
    ];
    dashRows.forEach((row, i) => {
      const r = 5 + i;
      dash.getRow(r).getCell(1).value = row[0];
      dash.getRow(r).getCell(1).font = { bold: true };
      dash.getRow(r).getCell(2).value = row[1];
      dash.getRow(r).getCell(2).numFmt = row[2];
    });

    setColWidths(dash, [28, 16]);

    // ---------- Stream response ----------
    const buffer = await wb.xlsx.writeBuffer();
    const filename = `MoonAutoDetailing_Bookkeeping_${new Date().toISOString().split("T")[0]}.xlsx`;

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", buffer.byteLength);

    console.log("BOOKKEEPING_EXPORTED", {
      bookings_count: completedBookings.length,
      expenses_count: (expenses || []).length,
      filename
    });

    return res.status(200).send(Buffer.from(buffer));
  } catch (err) {
    console.error("export-bookkeeping error:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
}
