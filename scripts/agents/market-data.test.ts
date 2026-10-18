import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import {
  ySym, parseChart, parseTimeseries, parseProfile, parseRss, shortCompanyName, isNoiseHeadline, parseDmy, parseNsePit,
  nyTimeMs, parseCboeChain, unzipFirst, parseFrenchCsv, parseFredCsv, levelsOnOrBefore,
} from "./market-data";

const close = (a: number, b: number, tol: number, msg?: string) =>
  assert.ok(Math.abs(a - b) <= tol, `${msg ?? ""} expected ${b}, got ${a}`);

const now = new Date("2026-10-18T12:00:00Z");
const sec = (iso: string) => Date.parse(iso) / 1000;

test("Yahoo symbols: NSE suffix, class-share dash, indices and FX pass through", () => {
  assert.equal(ySym("BRK.B", "US"), "BRK-B");
  assert.equal(ySym("M&M", "IN"), "M&M.NS");
  assert.equal(ySym("reliance.ns", "IN"), "RELIANCE.NS");
  assert.equal(ySym("^NSEI", "IN"), "^NSEI");
  assert.equal(ySym("USDINR=X", "US"), "USDINR=X");
});

test("chart: exchange-calendar dates, null closes skipped, the live quote replaces today's bar", () => {
  const ts = [sec("2026-10-15T13:30:00Z"), sec("2026-10-16T13:30:00Z"), sec("2026-10-16T19:59:00Z"), sec("2026-10-19T03:30:00Z")];
  const payload = {
    chart: {
      result: [{
        meta: { currency: "USD", gmtoffset: -14400 },
        timestamp: ts,
        indicators: {
          quote: [{ open: [10, 11, 11, null], high: [11, 12, 12, 13], low: [9, 10, 10, 12], close: [10.5, 11.5, 11.8, null], volume: [100, 200, 250, 0] }],
          adjclose: [{ adjclose: [10.4, 11.4, 11.7, null] }],
        },
      }],
    },
  };
  const c = parseChart(payload)!;
  assert.equal(c.currency, "USD");
  assert.deepEqual(c.bars.map((b) => [b.date, b.close, b.adjClose]), [["2026-10-15", 10.5, 10.4], ["2026-10-16", 11.8, 11.7]]);
  assert.equal(parseChart(payload, false)!.bars.length, 3, "intraday keeps every timestamp");
  // 03:30Z on the 19th is still the 18th in New York.
  const late = parseChart({ chart: { result: [{ meta: { gmtoffset: -14400 }, timestamp: [ts[3]], indicators: { quote: [{ close: [5] }] } }] } })!;
  assert.deepEqual([late.bars[0].date, late.bars[0].open, late.bars[0].adjClose, late.bars[0].volume], ["2026-10-18", 5, 5, 0]);
  assert.equal(parseChart({ chart: { result: [] } }), null);
  assert.equal(parseChart("garbage"), null);
});

test("statements: preference order, outflows made positive without −0, stub rows dropped, TTM only when current", () => {
  const s = (type: string, points: [string, number, string?][]) => ({
    meta: { type: [type] },
    [type]: points.map(([asOfDate, raw, currencyCode]) => ({ asOfDate, reportedValue: { raw }, currencyCode })),
  });
  const results = [
    s("annualNormalizedEBITDA", [["2025-09-30", 999]]),
    s("annualEBITDA", [["2025-09-30", 120], ["2024-09-30", 110]]),
    s("annualTotalRevenue", [["2025-09-30", 400, "USD"], ["2024-09-30", 380, "USD"], ["2023-09-30", 1, "EUR"]]),
    s("annualNetIncome", [["2025-09-30", 90], ["2024-09-30", 85]]),
    s("annualCapitalExpenditure", [["2025-09-30", -10], ["2024-09-30", 0]]),
    s("annualOperatingCashFlow", [["2025-09-30", 110], ["2024-09-30", 100]]),
    s("annualTotalAssets", [["2025-09-30", 350], ["2024-09-30", 340]]),
    s("trailingTotalRevenue", [["2026-06-30", 420]]),
    s("trailingCapitalExpenditure", [["2026-06-30", -12]]),
    s("quarterlyTotalRevenue", [["2026-06-30", 100]]),
    { meta: { type: ["annualSomethingUnknown"] }, annualSomethingUnknown: [{ asOfDate: "2025-09-30", reportedValue: { raw: 1 } }] },
  ];
  const f = parseTimeseries(results)!;
  assert.equal(f.currency, "USD", "the mode of revenue currencies");
  assert.deepEqual(f.annual.map((r) => r.asOf), ["2024-09-30", "2025-09-30"], "2023 has one line item: a stub");
  const last = f.annual[1];
  assert.equal(last.ebitda, 120, "EBITDA outranks normalized EBITDA whatever the order");
  assert.equal(last.capex, 10);
  assert.ok(Object.is(f.annual[0].capex, 0), "zero spend stays +0");
  assert.equal(f.quarterly.length, 0, "a one-field quarter is a stub");
  assert.deepEqual([f.ttm?.asOf, f.ttm?.revenue, f.ttm?.capex], ["2026-06-30", 420, 12]);

  const stale = parseTimeseries([...results.slice(0, 7), s("trailingTotalRevenue", [["2025-06-30", 390]])])!;
  assert.equal(stale.ttm, null, "a trailing row older than the last annual filing is not TTM");
  assert.equal(parseTimeseries([s("annualTotalRevenue", [["2025-09-30", 1]])]), null);
});

test("profile: short interest, a year of rating changes, open-market insiders only, EPS trend and history", () => {
  const qs = {
    price: { longName: "Acme Corp", currency: "USD", exchangeName: "NasdaqGS", regularMarketPrice: { raw: 100 }, marketCap: { raw: 1e9 } },
    summaryDetail: { beta: { raw: 1.2 }, dividendRate: { raw: 2 } },
    defaultKeyStatistics: { shortPercentOfFloat: { raw: 0.03 }, shortRatio: { raw: 2.5 }, sharesShort: { raw: 3e5 }, sharesShortPriorMonth: { raw: 2e5 }, dateShortInterest: { raw: sec("2026-09-30T00:00:00Z") }, sharesOutstanding: { raw: 1e7 } },
    financialData: { financialCurrency: "USD", targetMeanPrice: { raw: 120 }, numberOfAnalystOpinions: { raw: 12 }, recommendationKey: "buy" },
    assetProfile: { sector: "Technology", auditRisk: 2, overallRisk: 3, longBusinessSummary: "x".repeat(2000), companyOfficers: [{ name: "Jane Doe", title: "CEO", age: 50 }, { title: "nameless" }] },
    recommendationTrend: { trend: [{ period: "0m", strongBuy: 3, buy: 5, hold: 4 }] },
    upgradeDowngradeHistory: {
      history: [
        { epochGradeDate: sec("2026-09-01T00:00:00Z"), firm: "Old Firm", action: "main", priceTargetAction: "Raises" },
        { epochGradeDate: sec("2026-10-01T00:00:00Z"), firm: "New Firm", action: "Up", fromGrade: "Hold", toGrade: "Buy", currentPriceTarget: 130, priorPriceTarget: 110 },
        { epochGradeDate: sec("2025-01-01T00:00:00Z"), firm: "Ancient", action: "down" },
        { epochGradeDate: sec("2026-08-01T00:00:00Z"), firm: "Same", action: "main", priceTargetAction: "Maintains", currentPriceTarget: 90, priorPriceTarget: 100 },
      ],
    },
    earningsTrend: { trend: [{ period: "0q", epsTrend: { current: { raw: 1 } } }, { period: "0y", epsTrend: { current: { raw: 6 }, "30daysAgo": { raw: 5.9 }, "90daysAgo": { raw: 5.7 } }, epsRevisions: { upLast30days: { raw: 3 }, downLast30days: { raw: 1 } } }] },
    earningsHistory: { history: [{ quarter: { fmt: "2026-06-30" }, epsActual: { raw: 1.2 }, epsEstimate: { raw: 1 } }, { quarter: { fmt: "2026-03-31" }, epsActual: { raw: 1 }, epsEstimate: { raw: 1.1 } }, { quarter: { fmt: "2025-12-31" }, epsActual: null, epsEstimate: { raw: 1 } }] },
    insiderTransactions: {
      transactions: [
        { startDate: { raw: sec("2026-09-15T00:00:00Z") }, transactionText: "Purchase at price 95.00 per share.", filerName: "A Buyer", shares: { raw: 1000 } },
        { startDate: { raw: sec("2026-09-10T00:00:00Z") }, transactionText: "Sale at price 99.00 per share.", shares: { raw: 400 } },
        { startDate: { raw: sec("2026-09-05T00:00:00Z") }, transactionText: "Stock Award(Grant) at price 0.00 per share.", shares: { raw: 9000 } },
        { startDate: { raw: sec("2026-01-05T00:00:00Z") }, transactionText: "Purchase at price 80.00 per share.", shares: { raw: 5000 } },
      ],
    },
    calendarEvents: { earnings: { earningsDate: [{ raw: sec("2026-10-30T20:00:00Z") }] } },
  };
  const p = parseProfile("ACME", qs, now);
  assert.deepEqual([p.name, p.price, p.beta, p.sector, p.analyst.targetMean, p.analyst.trend?.buy, p.analyst.trend?.sell], ["Acme Corp", 100, 1.2, "Technology", 120, 5, 0]);
  assert.equal(p.description?.length, 1500, "the vendor summary is truncated");
  assert.deepEqual(p.officers.map((o) => o.name), ["Jane Doe"]);
  assert.deepEqual([p.governance?.audit, p.governance?.board, p.governance?.overall], [2, null, 3]);
  assert.deepEqual(p.shortInterest, { pctFloat: 0.03, daysToCover: 2.5, shares: 3e5, priorShares: 2e5, asOf: "2026-09-30" });
  assert.deepEqual(p.ratingChanges.map((r) => [r.firm, r.action, r.priceTarget]), [["New Firm", "up", "raise"], ["Old Firm", "main", "raise"], ["Same", "main", null]]);
  assert.deepEqual(p.epsTrend, { current: 6, d30: 5.9, d90: 5.7 }, "the fiscal-year trend, not the quarter's");
  assert.deepEqual(p.epsRevisions, { up30: 3, down30: 1 });
  assert.deepEqual(p.earnings.map((e) => e.date), ["2026-03-31", "2026-06-30"]);
  assert.deepEqual([p.insiders?.buys, p.insiders?.sells, p.insiders?.netShares], [1, 1, 600], "the grant and the stale purchase are ignored");
  assert.equal(p.nextEarningsDate, "2026-10-30");
  assert.equal(parseProfile("X", {}, now).insiders, null, "no insider module, no insider read");
});

test("RSS: CDATA, entities and the publisher suffix", () => {
  const xml = `<rss><channel><item><title><![CDATA[Acme beats &amp; raises - Wire Daily]]></title><pubDate>Fri, 16 Oct 2026 14:00:00 GMT</pubDate><source url="x">Wire Daily</source></item>
    <item><title>Acme &#8217;s plant &#x26; more</title><pubDate>Thu, 15 Oct 2026 09:00:00 +0530</pubDate></item>
    <item><title>No date</title></item></channel></rss>`;
  assert.deepEqual(parseRss(xml), [
    { title: "Acme beats & raises", publishedAt: "2026-10-16T14:00:00.000Z", publisher: "Wire Daily" },
    { title: "Acme ’s plant & more", publishedAt: "2026-10-15T03:30:00.000Z", publisher: undefined },
  ]);
});

test("company names lose legal suffixes, including a dangling ampersand", () => {
  assert.equal(shortCompanyName("Apple Inc."), "Apple");
  assert.equal(shortCompanyName("JPMorgan Chase & Co."), "JPMorgan Chase");
  assert.equal(shortCompanyName("The Coca-Cola Company"), "Coca-Cola");
  assert.equal(shortCompanyName("Meta Platforms, Inc."), "Meta Platforms");
  assert.equal(shortCompanyName("Mahindra & Mahindra Limited"), "Mahindra & Mahindra");
  assert.equal(shortCompanyName("Reliance Industries Limited"), "Reliance Industries");
});

test("news filter: 13F notices, quote pages and broker calls on other stocks go; company news stays", () => {
  const noise: [string, string, string][] = [
    ["Apple Inc. $AAPL Shares Acquired by Sapient Capital LLC", "AAPL", "Apple"],
    ["Apple Inc. $AAPL Stock: HWG Holdings LP Raises Stake", "AAPL", "Apple"],
    ["Fenimore Asset Management Inc Purchases 550,558 Shares of Apple Inc. $AAPL", "AAPL", "Apple"],
    ["1,837 Apple Inc. $AAPL Shares Sold by Green Ridge Wealth Planning LLC", "AAPL", "Apple"],
    ["10,450 Shares in JPMorgan Chase & Co. $JPM Bought by Neumann Capital Management LLC", "JPM", "JPMorgan Chase"],
    ["JPMorgan Chase & Co. $JPM Stock Holdings Lessened by InvesTrust", "JPM", "JPMorgan Chase"],
    ["Banque Pictet & Cie SA Sells 47,638 Shares of HDFC Bank Limited $HDB", "HDFCBANK", "HDFC Bank"],
    ["JPMorgan Chase & Co. Issues Pessimistic Forecast for Mondelez International (NASDAQ:MDLZ) Stock Price", "JPM", "JPMorgan Chase"],
    ["Echostar (NASDAQ:ECHO) Now Covered by JPMorgan Chase & Co.", "JPM", "JPMorgan Chase"],
    ["Meta Platforms' (META) Overweight Rating Reiterated at JPMorgan Chase & Co.", "JPM", "JPMorgan Chase"],
    ["REG - Gamma Communications JPMorgan Chase & Co - Holding(s) in Company", "JPM", "JPMorgan Chase"],
    ["JPMorgan Chase & Co. (JPMUS19.BK) interactive stock chart", "JPM", "JPMorgan Chase"],
    ["Exxon Mobil Tokenized Stock (Robinhood) USD (XOM-USD) price history and historical data", "XOM", "Exxon Mobil"],
    ["Reliance Industries Share Price Prediction for Monday, 19 Oct", "RELIANCE", "Reliance Industries"],
  ];
  for (const [title, t, name] of noise) assert.ok(isNoiseHeadline(title, t, name), title);
  const news: [string, string, string][] = [
    ["Freedom Broker Upgrades JPMorgan Chase & Co. (NYSE:JPM) to Strong-Buy", "JPM", "JPMorgan Chase"],
    ["HDFC Bank Limited 2027 Q2 - Results - Earnings Call Presentation (NYSE:HDB)", "HDFCBANK", "HDFC Bank"],
    ["Reliance Industries acquires 51% stake in Acme Retail", "RELIANCE", "Reliance Industries"],
    ["SoftBank cuts stake in Paytm", "PAYTM", "One 97 Communications"],
    ["Reliance Industries jumps on Nomura price upgrade", "RELIANCE", "Reliance Industries"],
    ["Apple invests $500 billion in US manufacturing", "AAPL", "Apple"],
    ["What Does JPMorgan Chase (JPM) Face If Jamie Dimon Is Right On Rates?", "JPM", "JPMorgan Chase"],
    ["HDFC Bank Q2 Results: Net profit rises 5% to ₹19,510 crore, NII jumps 10%", "HDFCBANK", "HDFC Bank"],
  ];
  for (const [title, t, name] of news) assert.ok(!isNoiseHeadline(title, t, name), title);
});

test("NSE: dates, open-market trades only, the reported side first, a 180-day window", () => {
  assert.equal(parseDmy("27-Mar-2026 10:00"), "2026-03-27");
  assert.equal(parseDmy("5-oct-2026"), "2026-10-05");
  assert.equal(parseDmy("31-Foo-2026"), null);
  assert.equal(parseDmy(undefined), null);
  const rows = [
    { acqMode: "Market Purchase", acqfromDt: "01-Oct-2026", secAcq: "1,000", secVal: "2,50,000", acqName: "Promoter A", personCategory: "Promoters" },
    { acqMode: "Market Sale", acqfromDt: "15-Sep-2026", secAcq: "400" },
    { acqMode: "Market Purchase", tdpTransactionType: "Sell", acqfromDt: "10-Sep-2026", secAcq: "50" },
    { acqMode: "Off Market", acqfromDt: "02-Oct-2026", secAcq: "9000" },
    { acqMode: "ESOP", acqfromDt: "02-Oct-2026", secAcq: "9000" },
    { acqMode: "Market Purchase", acqfromDt: "01-Jan-2026", secAcq: "7000" },
    { acqMode: "Market Purchase", acqfromDt: "25-Oct-2026", secAcq: "7000" },
    { acqMode: "Market Sale", intimDt: "12-Oct-2026", secAcq: "10" },
  ];
  const r = parseNsePit(rows, now);
  assert.deepEqual([r.buys, r.sells, r.netShares, r.period], [1, 3, 1000 - 400 - 50 - 10, "180d"]);
  assert.deepEqual(r.trades.map((t) => t.date), ["2026-10-12", "2026-10-01", "2026-09-15", "2026-09-10"]);
  assert.deepEqual([r.trades[1].shares, r.trades[1].value, r.trades[1].name], [1000, 250000, "Promoter A"]);
});

test("New York wall-clock times, across both DST regimes and the spring-forward gap", () => {
  assert.equal(new Date(nyTimeMs("2026-10-16T15:59:59")).toISOString(), "2026-10-16T19:59:59.000Z");
  assert.equal(new Date(nyTimeMs("2026-01-15 09:30:00")).toISOString(), "2026-01-15T14:30:00.000Z");
  assert.equal(new Date(nyTimeMs("2026-03-08T03:30:00")).toISOString(), "2026-03-08T07:30:00.000Z");
  assert.ok(Number.isNaN(nyTimeMs("16/10/2026")));
});

test("CBOE chain: the last trade sets the as-of, quotes are trimmed, iv30 comes in percent", () => {
  const payload = {
    timestamp: "2026-10-18 05:59:09",
    data: {
      current_price: 100,
      last_trade_time: "2026-10-16T15:59:59",
      iv30: 27.5,
      options: [
        { option: "ACME261120C00100000", bid: 5, ask: 5.5, iv: 0.3, delta: 0.52, open_interest: 10, volume: 2 },
        { option: "ACME261120P00200000", bid: 100, ask: 101, iv: 0.5 },
        { option: "ACME261016C00100000", bid: 1, ask: 1.1 },
        { option: "ACME261120P00090000", bid: 0, ask: 0, iv: 0 },
        { option: "ACME261120P00090000X", bid: 1, ask: 1 },
        { option: "ACME261120P00095000", bid: 0, ask: 1.2, iv: 0 },
      ],
    },
  };
  const c = parseCboeChain(payload, now)!;
  assert.equal(c.asOf, "2026-10-16T19:59:59.000Z");
  close(c.iv30!, 0.275, 1e-12);
  assert.deepEqual(c.quotes.map((q) => [q.type, q.strike, q.iv]), [["call", 100, 0.3], ["put", 95, null]]);
  assert.deepEqual([c.quotes[0].delta, c.quotes[0].openInterest], [0.52, 10]);

  const noTrade = parseCboeChain({ ...payload, data: { ...payload.data, last_trade_time: undefined } }, now)!;
  assert.equal(noTrade.asOf, "2026-10-18T05:59:09.000Z", "the file timestamp is UTC");
  const future = parseCboeChain(payload, new Date("2026-10-16T12:00:00Z"))!;
  assert.equal(future.asOf, "2026-10-16T12:00:00.000Z", "never later than now");
  assert.equal(parseCboeChain({ data: { current_price: 0 } }, now), null);
});

/** A one-file zip archive, built by hand (CRCs are not checked by the reader). */
function zip(text: string, method: 0 | 8): Buffer {
  const name = Buffer.from("F-F_test.CSV");
  const raw = Buffer.from(text, "latin1");
  const data = method === 8 ? deflateRawSync(raw) : raw;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(method, 10);
  cd.writeUInt32LE(data.length, 20);
  cd.writeUInt32LE(raw.length, 24);
  cd.writeUInt16LE(name.length, 28);
  cd.writeUInt32LE(0, 42);
  const cdOffset = local.length + name.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length + name.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, name, data, cd, name, eocd]);
}

test("zip: stored and deflated entries; truncated or foreign bytes give null", () => {
  const text = "line one\r\nline two é\r\n".repeat(20);
  assert.equal(unzipFirst(zip(text, 0)), text);
  assert.equal(unzipFirst(zip(text, 8)), text);
  const z = zip(text, 8);
  assert.equal(unzipFirst(z.subarray(0, z.length - 30)), null);
  assert.equal(unzipFirst(Buffer.from("not a zip at all, just some bytes")), null);
});

test("Ken French CSV: percent to decimal, sentinels dropped, the annual table ignored", () => {
  const csv = [
    "This file was created using the 202608 CRSP database.",
    "",
    ",Mkt-RF,SMB,HML,RMW,CMA,RF",
    "20111230,  0.50,  0.10,  0.20,  0.00,  0.00,  0.00",
    "20260102,  1.00, -0.50,  0.25,  0.10, -0.05,  0.02",
    "20260105,-99.99,  0.10,  0.00,  0.00,  0.00,  0.02",
    "",
    " Annual Factors: January-December ",
    ",Mkt-RF,SMB,HML,RMW,CMA,RF",
    "20250000, 10.0, 1.0, 1.0, 1.0, 1.0, 4.0",
  ].join("\r\n");
  const m = parseFrenchCsv(csv);
  assert.deepEqual([...m.keys()], ["2026-01-02", "2026-01-05"]);
  const r = m.get("2026-01-02")!;
  close(r.MKT, 0.01, 1e-12);
  close(r.SMB, -0.005, 1e-12);
  close(r.RF, 0.0002, 1e-12);
  assert.equal(m.get("2026-01-05")!.MKT, undefined);
  close(parseFrenchCsv("x\n,Mom   \n20260102, 0.30\n").get("2026-01-02")!.MOM, 0.003, 1e-12);
});

test("FRED CSV and as-of alignment: missing prints skipped, gaps over a week left empty", () => {
  const pts = parseFredCsv("observation_date,DGS10\n2026-01-01,4.10\n2026-01-05,.\n2026-01-08,4.20\nbad,1\n");
  assert.deepEqual(pts, [{ date: "2026-01-01", value: 4.1 }, { date: "2026-01-08", value: 4.2 }]);
  assert.deepEqual(levelsOnOrBefore(pts, ["2025-12-31", "2026-01-05", "2026-01-08", "2026-01-20"]), [null, 4.1, 4.2, null]);
  assert.deepEqual(levelsOnOrBefore(pts, ["2026-01-20"], 14), [4.2]);
});
