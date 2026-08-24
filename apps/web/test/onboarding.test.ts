import test from "node:test";
import assert from "node:assert/strict";
import { completedSteps, nextIncompleteStep, ONBOARDING_STEPS, type OnboardingStatus } from "../app/components/onboarding-wizard";

test("onboarding follows the safe connector sequence", () => {
  assert.deepEqual(ONBOARDING_STEPS, ["Workspace", "GitHub", "Search Console", "Conversions", "Safety", "First scan", "Health"]);
  assert.equal(nextIncompleteStep({}), 0);
});

test("optional PostHog may be explicitly skipped", () => {
  const status: OnboardingStatus = { organization:{id:"org",name:"Acme",slug:"acme"},site:{id:"site",name:"Site",url:"https://example.com"},github:{state:"healthy"},gsc:{state:"healthy"},posthog:{state:"skipped"},configuration:{branch:"main",protectedPaths:[]},scan:{state:"complete"} };
  assert.deepEqual(completedSteps(status), [true,true,true,true,true,true,false]);
  assert.equal(nextIncompleteStep(status), 6);
});

test("failed connectors remain incomplete and return users to that step", () => {
  const status: OnboardingStatus = { organization:{id:"org",name:"Acme",slug:"acme"},site:{id:"site",name:"Site",url:"https://example.com"},github:{state:"error",message:"Installation cannot access repository."} };
  assert.equal(nextIncompleteStep(status), 1);
});
