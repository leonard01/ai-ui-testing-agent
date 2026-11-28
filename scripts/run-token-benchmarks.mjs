import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";


const configurations = [
  {format:"json", effort:"medium"}, {format:"json", effort:"low"},
  {format:"text", effort:"medium"}, {format:"text", effort:"low"},
];
function parseOptions(args) {
  const options = {total:400, seed:20261126, live:false, verbose:false, validation:false};
  const seen = new Set();
  for (const arg of args) {
    if (arg === "--matrix-child") continue;
    const [key, value] = arg.split("=");
    if (seen.has(key)) throw new Error("Duplicate option: " + key);
    seen.add(key);
    if (key === "--live" && value === undefined) options.live = true;
    else if (key === "--validation" && value === undefined) options.validation = true;
    else if (key === "--verbose" && value === undefined) options.verbose = true;
    else if (key === "--total-tests" && /^\d+$/.test(value ?? "")) options.total = Number(value);
    else if (key === "--seed" && /^\d+$/.test(value ?? "")) options.seed = Number(value);
    else throw new Error("Unknown or invalid option: " + arg);
  }
  if (!Number.isSafeInteger(options.total) || options.total <= 0 || options.total % 4 !== 0)
    throw new Error("--total-tests must be a positive integer divisible by four");
  if (!Number.isSafeInteger(options.seed) || options.seed > 0xffffffff)
    throw new Error("--seed must be an unsigned 32-bit integer");
  if (options.live && !seen.has("--total-tests")) throw new Error("Live mode requires an explicit --total-tests to protect quota");
  if (options.validation && options.total !== 20) throw new Error("--validation requires --total-tests=20 (five independent fixtures x four configurations)");
  return options;
}
function makeCase(index, seed) {
  // Deterministic, paired across configurations; no repeated identical descriptions.
  let state = (seed + Math.imul(index + 1, 2654435761)) >>> 0;
  const pick = (values) => { state = (Math.imul(state,1664525)+1013904223) >>> 0; return values[state % values.length]; };
  const category = ["simple","medium","complex","long","edge"][index % 5];
  const names = ["Review report","Prepare presentation","Buy groceries","Update dashboard","Check invoice","Write notes","Plan meeting","Send feedback"];
  const task = n => pick(names) + " " + (index + 1) + "-" + n;
  const lines = [];
  const count = category === "simple" ? 1 : category === "medium" ? 2 : category === "complex" ? 4 : category === "long" ? 8 : 2;
  for (let n=0;n<count;n++) {
    const name = task(n+1);
    lines.push("Add a task called " + JSON.stringify(name) + ".", "Verify that " + JSON.stringify(name) + " is visible in the task list.");
    if (category === "complex" || category === "long" || category === "edge") {
      lines.push("Delete " + JSON.stringify(name) + ".", "Verify that " + JSON.stringify(name) + " is no longer visible.");
    }
  }
  if (category === "edge") lines.push("Do not log in. Verify the task list heading remains visible; do not treat the input field as proof of a saved task.");
  return {id:index+1,category,requirements:lines.join("\n")};
}
// Wait for the provider's window to replenish, never retry indefinitely.
function resetMilliseconds(value) {
  if (typeof value !== "string") return 0;
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d)/g)];
  if (!parts.length || parts.map(p=>p[0]).join("") !== value) return 0;
  const units = {ms:1,s:1000,m:60000,h:3600000,d:86400000};
  return parts.reduce((total,p)=>total+Number(p[1])*units[p[2]],0);
}
function rateLimitDelay(attempt) {
  const raw = attempt.retryAfter;
  const retry = typeof raw === "string" && /^\d+(?:\.\d+)?$/.test(raw)
    ? Number(raw)*1000 : Math.max(0, Date.parse(raw ?? "")-Date.now()) || 0;
  return Math.max(60000, retry+1000, resetMilliseconds(attempt.resetTokens)+1000);
}
function stats(values) {
  const a=values.filter(Number.isFinite).sort((x,y)=>x-y);
  if (!a.length) return null;
  return {n:a.length,min:a[0],mean:a.reduce((x,y)=>x+y,0)/a.length,p95:a[Math.ceil(a.length*.95)-1],max:a.at(-1)};
}
// Holdout fixtures: different synthetic page snapshots and workflows, not live browser inspections.
const holdouts = [
 {category:"commerce",requirements:"Log in using the displayed demo credentials. Add Sauce Labs Backpack to the cart. Verify the cart contains the backpack and remove it.",url:"https://www.saucedemo.com/",title:"Swag Labs",headings:["Swag Labs"],controls:[{kind:"textbox",name:"Username",placeholder:"Username"},{kind:"textbox",name:"Password",placeholder:"Password"},{kind:"button",name:"Login"}],sampleText:["Accepted usernames are: standard_user, locked_out_user","Password for all users: secret_sauce"]},
 {category:"search",requirements:"Search for wireless headphones. Verify results contain headphones and do not contain refurbished.",url:"https://shop.example.test/search",title:"Product search",headings:["Search products","Popular categories"],controls:[{kind:"textbox",name:"Search",placeholder:"Search products"},{kind:"button",name:"Search"},{kind:"combobox",name:"Category"}],sampleText:["Electronics","Home and garden","Results will appear here"]},
 {category:"form",requirements:"Fill the contact form with a name and email. Leave the message empty. Submit and verify that the required message warning is displayed. Do not send a completed message.",url:"https://forms.example.test/contact",title:"Contact us",headings:["Contact us","Send an enquiry"],controls:[{kind:"textbox",name:"Name"},{kind:"textbox",name:"Email"},{kind:"textbox",name:"Message"},{kind:"checkbox",name:"Accept terms"},{kind:"button",name:"Submit"}],sampleText:["Fields marked * are required","We aim to reply within two business days."]},
 {category:"dashboard",requirements:"Open the reports section. Select November. Verify the revenue heading is visible. Change the period to October and verify the selected period is October.",url:"https://dashboard.example.test/home",title:"Analytics workspace",headings:["Overview","Recent activity","Revenue"],controls:[{kind:"button",name:"Reports"},{kind:"combobox",name:"Period"},{kind:"button",name:"Export"}],sampleText:["Revenue: £12,300","Active customers: 147","Last updated today","October","November","December"]},
 {category:"unicode",requirements:"Search for \"Café 東京 🧪\". Verify the exact search heading, then clear the query. Verify that no results are shown for the previous query.",url:"https://catalogue.example.test/?lang=ja",title:"商品カタログ",headings:["Catalogue","商品検索"],controls:[{kind:"textbox",name:"Search",placeholder:"商品を検索"},{kind:"button",name:"検索"},{kind:"button",name:"Clear"}],sampleText:["Café crème","東京","商品一覧","検索結果","🧪 Test kit"]}
];
async function runMatrix(options) {
  const {makeGenerationPrompt}=await import("../dist/generation.js");
  const {estimateModelTokens}=await import("../dist/token-estimation.js");
  const {requestGroq}=await import("../dist/hosted-providers.js");
  const model="openai/gpt-oss-20b";
  const snapshot={url:"http://127.0.0.1:3000/",title:"Task list",headings:["Task list"],controls:[{kind:"textbox",name:"Task",placeholder:"Task"},{kind:"button",name:"Add"}],statusText:["0 tasks, 0 completed"],sampleText:[],inspection:{mainDocumentStatus:200,blockedCrossOriginRequests:0,allowedCrossOriginRequests:0,pageErrors:0}};
  if (options.live && !process.env.GROQ_API_KEY?.trim()) throw new Error("GROQ_API_KEY is required in live mode");
  const groups=configurations.map(config=>({config,rows:[]}));
  let stopped=false;
  let completed=0;
  for(let i=0;i<options.total/4 && !stopped;i++) {
    const fixture=options.validation ? holdouts[i] : undefined;
    const item=fixture ? {id:i+1,category:fixture.category,requirements:fixture.requirements} : makeCase(i,options.seed);
    const page=fixture ? {...snapshot,...fixture,statusText:[]} : snapshot;
    // Exclude benchmark metadata from the page snapshot sent to the model.
    const {category:ignoredCategory,requirements:ignoredRequirements,...pageSnapshot}=page;
    // Rotate order to reduce time/order bias in live tests.
    for(let offset=0;offset<4;offset++) {
      const group=groups[(i+offset)%4], {format,effort}=group.config;
      const request={model,...makeGenerationPrompt(item.requirements,pageSnapshot,[],true),responseMode:format};
      const estimate=estimateModelTokens(request,undefined,"groqcloud");
      const row={...item,format,effort,...estimate};
      if(options.live) {
        process.env.GROQ_RESPONSE_POLICY=format;
        process.env.GROQ_REASONING_EFFORT=effort;
        const attempts=[];
        for (let retry=0;;retry++) {
          const start=attempts.length;
          try {
            await requestGroq(request,fetch,attempt=>attempts.push(attempt));
            delete row.error;
            break;
          } catch(error) {
            row.error=error.name;
            const rejected=attempts.length>start ? attempts.at(-1) : undefined;
            if(rejected?.httpStatus!==429) break;
            const wait=rateLimitDelay(rejected);
            if(retry>=2 || wait>300000) {
              console.log("Rate limit: stopping; " + (retry>=2 ? "retry limit reached" : "provider reset exceeds five minutes") + ".");
              break;
            }
            console.log("Rate limit: case "+item.id+" "+format+"/"+effort+
              "; waiting "+Math.ceil(wait/1000)+" seconds before retry "+(retry+1)+"/2.");
            await sleep(wait);
          }
        }
        row.attempts=attempts;
        const actual=attempts.at(-1);
        if(actual) {
          row.actualInputTokens=actual.inputTokens;
          row.completionTokens=actual.outputTokens;
          row.reasoningTokens=actual.reasoningTokens;
          row.actualTotalTokens=actual.totalTokens;
          if(Number.isFinite(actual.inputTokens) && actual.inputTokens>0) {
            row.inputErrorPercent=100*(estimate.estimatedInputTokens-actual.inputTokens)/actual.inputTokens;
          }
        }
        row.outcome = actual?.finishReason === "length" ? "truncated" : row.error ? "failed" : actual?.finishReason === "stop" ? "normal-finish" : "other-finish";
        if((row.error && actual?.httpStatus===429) || (row.error && !attempts.length)) stopped=true;
      }
      group.rows.push(row);
      console.log("CASE "+JSON.stringify(row));
      completed++;
      if (completed % (options.live ? 4 : 100) === 0 || completed === options.total || stopped) console.log("Progress: " + completed + "/" + options.total);
      if(stopped) break;
    }
  }
  for(const {config,rows} of groups) {
    console.log("SUMMARY "+JSON.stringify({...config,requested:options.total/4,completed:rows.length,
      estimatedInputTokens:stats(rows.map(r=>r.estimatedInputTokens)),
      actualInputTokens:stats(rows.map(r=>r.actualInputTokens)),
      completionTokens:stats(rows.map(r=>r.completionTokens)),
      reasoningTokens:stats(rows.map(r=>r.reasoningTokens)),
      actualTotalTokens:stats(rows.map(r=>r.actualTotalTokens)),
      signedInputErrorPercent:stats(rows.map(r=>r.inputErrorPercent)),
      absoluteInputErrorPercent:stats(rows.map(r=>Math.abs(r.inputErrorPercent))),
      failedRequests:rows.filter(r=>r.outcome==="failed").length,
      normalFinishes:rows.filter(r=>r.outcome==="normal-finish").length,
      truncatedResponses:rows.filter(r=>r.outcome==="truncated").length,
      otherFinishes:rows.filter(r=>r.outcome==="other-finish").length,
      rateLimitedAttempts:rows.reduce((n,r)=>n+(r.attempts?.filter(a=>a.httpStatus===429).length??0),0)}));
  }
  console.log("OVERALL "+JSON.stringify({requested:options.total,completed:groups.reduce((n,g)=>n+g.rows.length,0),distinctDescriptions:Math.max(...groups.map(g=>g.rows.length)),seed:options.seed,dataset:options.validation?"independent-synthetic-holdout":"original-task-list",mode:options.live?"live":"offline",stopped,
    note:"Offline estimates include provisional GroqCloud GPT-OSS 20B format calibration; actual completion/reasoning tokens require live measurement. Normal finish does not establish functional correctness. Long cases may exceed the generation step limit and are stress cases, not functional assertions."}));
  if(stopped) process.exitCode=1;
}

const options = parseOptions(process.argv.slice(2));
if (process.argv.includes("--matrix-child")) { await runMatrix(options); } else {
const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, "test-results", "token-benchmarks");
await mkdir(directory, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const report = join(directory, "token-benchmark-" + stamp + "-" + process.pid + ".txt");
const latest = join(directory, "latest.txt");
const details = report.replace(/\.txt$/, ".jsonl");
await writeFile(details, "", { flag:"wx" });
await writeFile(report, (options.live ? "Live token benchmark" : "Offline token benchmark") + "\nRequested matrix cases: " + options.total + "\nSeed: " + options.seed + "\nStarted: " + new Date().toISOString() + "\nNode: " + process.version + (options.live ? "\nHosted AI requests enabled explicitly.\n" : "\nNo hosted AI requests are made.\n"), { flag: "wx" });

async function run(label, args) {
  await appendFile(report, "\n--- " + label + " ---\n");
  console.log(label);
  return new Promise((done) => {
    let writes = Promise.resolve();
    const child = spawn(process.execPath, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const capture = (chunk, output) => {
      output.write(chunk);
      writes = writes.then(() => appendFile(report, chunk));
    };
    // Use readline, not chunk boundaries, to classify complete case records.
    const lines = createInterface({input:child.stdout, crlfDelay:Infinity});
    lines.on("line", line => {
      if (label === "Configuration matrix" && line.startsWith("CASE ")) {
        writes = writes.then(() => appendFile(details, line.slice(5) + "\n"));
        if (!options.verbose) return;
      }
      capture(line + "\n", process.stdout);
    });
    child.stderr.on("data", chunk => capture(chunk, process.stderr));
    child.on("error", error => capture(Buffer.from(error.message + "\n"), process.stderr));
    child.on("close", (code, signal) => {
      writes.then(async () => {
        await appendFile(report, "\nExit: " + (code ?? signal ?? "unknown") + "\n");
        done(code ?? 1);
      }).catch(error => { console.error("Report write failed:", error.message); done(1); });
    });
  });
}

let code = 1;
try {
  code = await run("Build", [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"]);
  if (code === 0) {
    code = await run("Token regression tests", ["--test", "tests/unit/token-estimation.test.mjs"]);
    if (code === 0) code = await run("Configuration matrix", [...(options.live ? ["--env-file-if-exists=.env"] : []), fileURLToPath(import.meta.url), "--matrix-child", ...process.argv.slice(2)]);
  } else {
    await appendFile(report, "\nTests not run because the build failed.\n");
  }
} finally {
  await appendFile(report, "\nDetailed case data: " + details + "\nBenchmark execution status: " + (code === 0 ? "PASSED" : "FAILED") + "\nFinished: " + new Date().toISOString() + "\n");
  const { copyFile } = await import("node:fs/promises");
  await copyFile(report, latest);
  console.log("\nReport saved to: " + report);
  console.log("Latest report: " + latest);
  console.log("Detailed case data: " + details);
}
process.exitCode = code;

}
