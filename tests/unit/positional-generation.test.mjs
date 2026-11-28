import { test } from "node:test";
import assert from "node:assert/strict";
import { makeGenerationPrompt } from "../../dist/generation.js";

const snapshot={url:"https://example.test/",title:"Controls",headings:[],controls:[],statusText:[],sampleText:[]};

test("generation prompt distinguishes explicit ordinal controls from invented positions",()=>{
  const {system,prompt}=makeGenerationPrompt("Click the second Delete button.",snapshot);
  assert.match(system,/nth\?:/);
  assert.match(system,/second Delete button[^\n]*nth:1/);
  assert.match(system,/first[^\n]*nth:0/);
  assert.match(system,/only when the tester explicitly requests/i);
  assert.match(system,/never invent an index/i);
  assert.ok(prompt.includes("Click the second Delete button."));
});

test("generation prompt does not encourage resolving unspecified ambiguous controls by position",()=>{
  const {system}=makeGenerationPrompt("Click Delete.",snapshot);
  assert.match(system,/do not choose an index to resolve ambiguity/i);
});
