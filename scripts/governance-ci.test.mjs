import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parse } from "yaml";
import {
  changedFiles,
  DOCUMENTATION_PATTERNS,
  requiresVerification,
} from "./ci-change-filter.mjs";
import { ciPassed } from "./ci-result.mjs";
const root = path.resolve(import.meta.dirname, "..");

test("governance-C2 filtro de mudanças preserva os caminhos documentais explícitos", () => {
  assert.deepEqual(DOCUMENTATION_PATTERNS, [
    ".checks/**",
    ".tasks/**",
    "docs/**",
    "CLAUDE.md",
    "AGENTS.md",
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "GROK.md",
    ".github/ISSUE_TEMPLATE/**",
    ".github/pull_request_template.md",
  ]);
  const docs = [
    ".checks/prova.md",
    ".tasks/plano.md",
    "docs/a/b.md",
    "CLAUDE.md",
    "AGENTS.md",
    "README.md",
    "CHANGELOG.md",
    "CONTRIBUTING.md",
    "GROK.md",
    ".github/ISSUE_TEMPLATE/bug.yml",
    ".github/pull_request_template.md",
  ];
  assert.equal(requiresVerification(docs), false);
  for (const file of [
    ".github/workflows/ci.yml",
    "scripts/a.mjs",
    "apps/api/a.ts",
    "packages/a.ts",
    "package.json",
    "package-lock.json",
    "compose.yaml",
    "Dockerfile",
    "design-system/mock.html",
    "docs-extra/a.md",
    "AGENTS.md.ts",
  ]) {
    assert.equal(requiresVerification([file]), true, file);
    assert.equal(requiresVerification([...docs, file]), true, file);
  }
  assert.equal(requiresVerification([]), true);
});

test("governance-C2 diff real inclui exclusões, renomes e caminhos com espaços", () => {
  const scratch = mkdtempSync(path.join(tmpdir(), "ci-diff-"));
  const git = (args) =>
    execFileSync("git", args, { cwd: scratch, encoding: "utf8" });
  const put = (file, content) => {
    const target = path.join(scratch, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  try {
    git(["-c", "init.templateDir=", "init", "-q"]);
    git(["config", "core.autocrlf", "false"]);
    git(["config", "core.hooksPath", path.join(scratch, "no-hooks")]);
    git(["config", "user.name", "CI proof"]);
    git(["config", "user.email", "ci@example.invalid"]);
    put("src/code.js", "export const x = 1;\n");
    put("src/deleted.js", "export const y = 2;\n");
    git(["add", "."]);
    git(["commit", "-qm", "base"]);
    const base = git(["rev-parse", "HEAD"]).trim();
    mkdirSync(path.join(scratch, "docs"), { recursive: true });
    git(["mv", "src/code.js", "docs/code.js"]);
    git(["rm", "src/deleted.js"]);
    put("docs/com espaços.md", "Documento.\n");
    for (let index = 0; index < 3100; index++)
      put("docs/item-" + index + ".md", "Documento.\n");
    git(["add", "."]);
    git(["commit", "-qm", "mudanças"]);
    const head = git(["rev-parse", "HEAD"]).trim();
    const files = changedFiles(
      "pull_request",
      { pull_request: { base: { sha: base }, head: { sha: head } } },
      git,
    );
    for (const file of [
      "src/code.js",
      "src/deleted.js",
      "docs/code.js",
      "docs/com espaços.md",
    ])
      assert.ok(files.includes(file), file);
    assert.equal(
      files.filter((file) => file.startsWith("docs/item-")).length,
      3100,
    );
    assert.equal(requiresVerification(files), true);
    assert.deepEqual(
      changedFiles("push", { before: base, after: head }, git),
      files,
    );
    const eventFile = path.join(scratch, "event.json");
    const outputFile = path.join(scratch, "outputs");
    writeFileSync(eventFile, JSON.stringify({ before: base, after: head }));
    writeFileSync(outputFile, "");
    const cli = spawnSync(
      process.execPath,
      [path.join(root, "scripts/ci-change-filter.mjs")],
      {
        cwd: scratch,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "push",
          GITHUB_EVENT_PATH: eventFile,
          GITHUB_OUTPUT: outputFile,
        },
      },
    );
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(readFileSync(outputFile, "utf8"), "code=true\n");
  } finally {
    assert.equal(path.dirname(scratch), path.resolve(tmpdir()));
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("governance-C2 eventos manuais e referências inválidas não dispensam verificação", () => {
  assert.equal(
    requiresVerification(changedFiles("workflow_dispatch", {})),
    true,
  );
  assert.equal(
    requiresVerification(
      changedFiles("push", { before: "0".repeat(40), after: "a".repeat(40) }),
    ),
    true,
  );
  assert.throws(
    () => changedFiles("push", { before: "--help", after: "a".repeat(40) }),
    /Referências/,
  );
  assert.throws(() => changedFiles("pull_request", {}), /Referências/);
  assert.throws(() => changedFiles("unknown", {}), /Evento/);
  assert.throws(
    () =>
      changedFiles(
        "push",
        { before: "a".repeat(40), after: "b".repeat(40) },
        () => {
          throw new Error("diff indisponível");
        },
      ),
    /diff indisponível/,
  );
});

test("governance-C4 resultado obrigatório recusa falhas, cancelamento e skip inesperado", () => {
  const accepted = new Set(["success,true,success", "success,false,skipped"]);
  for (const detection of ["success", "failure", "cancelled", "skipped", ""])
    for (const code of ["true", "false", ""])
      for (const verification of [
        "success",
        "failure",
        "cancelled",
        "skipped",
        "",
      ]) {
        const key = [detection, code, verification].join(",");
        assert.equal(
          ciPassed(detection, code, verification),
          accepted.has(key),
          key,
        );
      }
  for (const [detection, code, verification, exit] of [
    ["success", "false", "skipped", 0],
    ["success", "true", "success", 0],
    ["failure", "false", "skipped", 1],
    ["success", "true", "skipped", 1],
    ["success", "true", "failure", 1],
    ["success", "false", "cancelled", 1],
  ]) {
    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts/ci-result.mjs")],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          DETECTION_RESULT: detection,
          CODE_CHANGED: code,
          VERIFY_RESULT: verification,
        },
      },
    );
    assert.equal(result.status, exit, result.stderr);
    if (code === "false" && exit === 0)
      assert.match(result.stdout, /dispensada intencionalmente/);
  }
});

test("governance-C1 C3 workflow sempre publica CI sem IA nem release", () => {
  const workflow = parse(
    readFileSync(path.join(root, ".github/workflows/governance.yml"), "utf8"),
  );
  assert.deepEqual(Object.keys(workflow.on).sort(), [
    "pull_request",
    "push",
    "workflow_dispatch",
  ]);
  assert.deepEqual(workflow.on.pull_request, { branches: ["main"] });
  assert.deepEqual(workflow.on.push, { branches: ["main"] });
  assert.deepEqual(workflow.permissions, { contents: "read" });
  const detector = workflow.jobs.changes;
  assert.equal(detector.outputs.code, "$" + "{{ steps.filter.outputs.code }}");
  assert.equal(detector.steps[0].with["fetch-depth"], 0);
  assert.equal(detector.steps[0].with["persist-credentials"], false);
  assert.equal(
    detector.steps.find((step) => step.id === "filter").run,
    "node scripts/ci-change-filter.mjs",
  );
  const tools = workflow.jobs.verify;
  assert.equal(tools.needs, "changes");
  assert.equal(tools.if, "needs.changes.outputs.code == 'true'");
  assert.deepEqual(
    tools.steps.filter((step) => step.run).map((step) => step.run),
    [
      "npm ci --ignore-scripts",
      "npm run test:governance",
      "npm run test:code-review",
    ],
  );
  const ci = workflow.jobs.ci;
  assert.equal(ci.name, "CI");
  assert.equal(ci.if, "always()");
  assert.deepEqual(ci.needs, ["changes", "verify"]);
  const result = ci.steps.find((step) => step.run);
  assert.equal(result.run, "node scripts/ci-result.mjs");
  assert.deepEqual(result.env, {
    DETECTION_RESULT: "$" + "{{ needs.changes.result }}",
    CODE_CHANGED: "$" + "{{ needs.changes.outputs.code }}",
    VERIFY_RESULT: "$" + "{{ needs.verify.result }}",
  });
  assert.equal(ci["continue-on-error"], undefined);
  assert.equal(result["continue-on-error"], undefined);
  assert.deepEqual(Object.keys(workflow.jobs).sort(), [
    "changes",
    "ci",
    "verify",
  ]);
  for (const job of Object.values(workflow.jobs))
    for (const step of job.steps ?? []) {
      if (step.uses) assert.match(step.uses, /@[a-f0-9]{40}$/);
      if (step.run)
        assert.doesNotMatch(
          step.run,
          /codex|grok|claude|npm publish|deploy|git push/i,
        );
    }
});
