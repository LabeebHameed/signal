import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { checkLocation, locationGateActive } from "./locations.ts";
import type { FilterProfile } from "./types.ts";

const include = (...places: string[]): FilterProfile => ({ locations_include: places });
const exclude = (...places: string[]): FilterProfile => ({ locations_exclude: places });

Deno.test("no lists declared leaves the gate off", () => {
  assertEquals(locationGateActive({}), false);
  assertEquals(checkLocation("Anywhere", {}).ok, true);
  assertEquals(checkLocation(null, {}).ok, true);
});

Deno.test("an undisclosed location always passes an include list", () => {
  // The majority of postings never state a location; rejecting them would
  // throw away most real matches.
  const profile = include("Germany");
  assertEquals(checkLocation(null, profile).ok, true);
  assertEquals(checkLocation("", profile).ok, true);
  assertEquals(checkLocation("   ", profile).ok, true);
});

Deno.test("include admits a substring match and rejects everything else", () => {
  const profile = include("Germany", "Remote");
  assertEquals(checkLocation("Berlin, Germany", profile).ok, true);
  assertEquals(checkLocation("Remote (EU)", profile).ok, true);
  const rejected = checkLocation("Austin, TX", profile);
  assertEquals(rejected.ok, false);
  assertEquals(rejected.reason?.kind, "not-included");
});

Deno.test("include matching is case- and punctuation-insensitive", () => {
  const profile = include("U.S.A.");
  assertEquals(checkLocation("usa", profile).ok, true);
  assertEquals(checkLocation("Remote — USA", profile).ok, true);
});

Deno.test("exclude beats include when both match the same posting", () => {
  const profile: FilterProfile = {
    locations_include: ["Remote"],
    locations_exclude: ["United States"],
  };
  const decision = checkLocation("Remote — United States only", profile);
  assertEquals(decision.ok, false);
  assertEquals(decision.reason?.kind, "excluded");
  assertEquals(decision.reason?.term, "United States");
});

Deno.test("exclude alone lets every other location through", () => {
  const profile = exclude("India");
  assertEquals(checkLocation("Bengaluru, India", profile).ok, false);
  assertEquals(checkLocation("Lisbon, Portugal", profile).ok, true);
  assertEquals(checkLocation(null, profile).ok, true);
});

Deno.test("blank and non-string entries are ignored rather than matching everything", () => {
  const profile: FilterProfile = { locations_include: ["", "   "], locations_exclude: [] };
  assertEquals(locationGateActive(profile), false);
  assertEquals(checkLocation("Anywhere at all", profile).ok, true);
});
