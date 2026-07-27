import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  checkCompensation,
  compensationGateActive,
  parsePostingPay,
  profileFloorPerYear,
} from "./compensation.ts";
import type { FilterProfile } from "./types.ts";

const floor = (min: number, extra: Partial<FilterProfile> = {}): FilterProfile => ({
  compensation_min: min,
  compensation_currency: "USD",
  compensation_period: "year",
  ...extra,
});

Deno.test("no floor declared leaves the gate off", () => {
  assertEquals(compensationGateActive({}), false);
  assertEquals(profileFloorPerYear({}), null);
  assertEquals(checkCompensation("$40,000", {}).ok, true);
});

Deno.test("a monthly floor normalizes to a yearly figure", () => {
  assertEquals(profileFloorPerYear(floor(5_000, { compensation_period: "month" })), 60_000);
  assertEquals(profileFloorPerYear(floor(120_000)), 120_000);
});

Deno.test("parsePostingPay reads the shapes real sources produce, taking the band's top", () => {
  assertEquals(parsePostingPay("$150K - $200K")?.maxPerYear, 200_000);
  assertEquals(parsePostingPay("€60,000/yr")?.maxPerYear, 60_000);
  assertEquals(parsePostingPay("$120k+")?.maxPerYear, 120_000);
  assertEquals(parsePostingPay("$1.2M")?.maxPerYear, 1_200_000);
  assertEquals(parsePostingPay("₹12,00,000 per annum")?.maxPerYear, 1_200_000);
  assertEquals(parsePostingPay("$150K - $200K")?.currency, "USD");
  assertEquals(parsePostingPay("60000 EUR")?.currency, "EUR");
});

Deno.test("a monthly posting figure is annualized before comparison", () => {
  assertEquals(parsePostingPay("$8,000 per month")?.maxPerYear, 96_000);
});

Deno.test("unreadable, absent, and sub-monthly pay all pass — never disqualifying", () => {
  assertEquals(parsePostingPay(null), null);
  assertEquals(parsePostingPay(""), null);
  assertEquals(parsePostingPay("Competitive"), null);
  assertEquals(parsePostingPay("$75/hr"), null, "hourly rates aren't reliably convertible");
  assertEquals(parsePostingPay("40 hours per week"), null);
  const profile = floor(120_000);
  assertEquals(checkCompensation(null, profile).ok, true);
  assertEquals(checkCompensation("Competitive", profile).ok, true);
  assertEquals(checkCompensation("$75/hr", profile).ok, true);
});

Deno.test("a posting provably below the floor is rejected", () => {
  // The whole band tops out under the floor — this job cannot pay enough.
  const decision = checkCompensation("$80,000 - $95,000", floor(120_000));
  assertEquals(decision.ok, false);
  assertEquals(decision.reason?.postingPerYear, 95_000);
  assertEquals(decision.reason?.floorPerYear, 120_000);
});

Deno.test("a posting at or above the floor passes", () => {
  assertEquals(checkCompensation("$120,000", floor(120_000)).ok, true);
  assertEquals(checkCompensation("$150K - $200K", floor(120_000)).ok, true);
});

Deno.test("a wide band whose top clears the floor passes", () => {
  // "$90K - $200K" against a $120K floor: this job may well pay $150K, so it
  // is not provably too low and belongs in front of the judge.
  assertEquals(checkCompensation("$90,000 - $200,000", floor(120_000)).ok, true);
});

Deno.test("a monthly posting below a monthly floor is rejected on annualized terms", () => {
  const profile = floor(8_000, { compensation_period: "month" }); // $96K/yr
  assertEquals(checkCompensation("$5,000 per month", profile).ok, false);
  assertEquals(checkCompensation("$9,000 per month", profile).ok, true);
  assertEquals(checkCompensation("$120,000", profile).ok, true);
});

Deno.test("a different currency is not screened on pay at all", () => {
  // No FX rates available, so €70,000 against a $120,000 floor is unknowable.
  assertEquals(checkCompensation("€70,000", floor(120_000)).ok, true);
  assertEquals(checkCompensation("£65,000", floor(120_000)).ok, true);
});

Deno.test("a posting stating no currency is read as the seeker's own", () => {
  assertEquals(checkCompensation("80,000 - 95,000", floor(120_000)).ok, false);
});
