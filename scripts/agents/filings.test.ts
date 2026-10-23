import { test } from "node:test";
import assert from "node:assert/strict";
import { isMaterial8K } from "./edgar";
import { materiality } from "./india";

test("an 8-K made only of routine items is not material", () => {
  assert.equal(isMaterial8K("5.07"), false, "shareholder vote tally");
  assert.equal(isMaterial8K("5.03,9.01"), false, "bylaw amendment plus exhibits");
  assert.equal(isMaterial8K("9.01"), false);
  assert.equal(isMaterial8K("2.02,9.01"), true, "earnings release");
  assert.equal(isMaterial8K("5.02"), true, "officer change");
  assert.equal(isMaterial8K("1.01"), true);
  assert.equal(isMaterial8K(""), true, "unknown items count as material");
  assert.equal(isMaterial8K(undefined), true);
});

test("NSE meeting schedules and certificates are procedural; transcripts and results are not", () => {
  const meet = "Analysts/Institutional Investor Meet/Con. Call Updates";
  assert.equal(materiality(meet, "CDSL has informed the Exchange about Schedule of Analyst Call with Lyptus Capital"), 10);
  assert.equal(materiality(meet, "Please note that the Company executives will be participating in the UBS India Summit"), 10);
  assert.equal(materiality(meet, "has informed the Exchange about the link of audio recording of the conference call"), 10);
  assert.equal(materiality(meet, "has informed the Exchange about Transcript of Analysts/Institutional Investor Meet"), 80);
  assert.equal(materiality(meet, "Presentation for the financial results for the quarter ended June 30, 2026."), 100);
  assert.equal(materiality("Copy of Newspaper Publication"), 10);
  assert.equal(materiality("Trading Window"), 10);
  assert.equal(materiality("Certificate under SEBI (Depositories and Participants) Regulations, 2018"), 10);
  assert.equal(materiality("ESOP/ESOS/ESPS", "Allotment of 685 Shares."), 10);
  assert.equal(materiality("Shareholders meeting", "a copy Srutinizers report of Annual General Meeting"), 10);
  assert.equal(materiality("Updates", "regarding 'Decisions at Board Meeting held on 14.10.2026'."), 100);
  assert.equal(materiality("Outcome of Board Meeting"), 100);
  assert.equal(materiality("General Updates", "Proposed Initial Public Offer of Jio Platforms Limited."), 70);
  assert.equal(materiality("Credit Rating"), 50);
  assert.ok(materiality("Change in Management") > 10);
});
