import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";
import {
  review,
  check,
  createPr,
  validateReport,
  parseArgs,
  codexInvocation,
  codexEnvironment,
  runProcess,
  authenticateChatGPT,
  extractIssueCriteria,
  readRemoteRefs,
} from "./review.mjs";

const issue = {
  number: 7,
  title: "Entrega",
  body: "## Critérios de aceite\n- Valor deve ser 2.",
  url: "https://github.com/example/project/issues/7",
  comments: [],
};
function ready(meta) {
  return {
    status: "ready",
    base: meta.base,
    head: meta.head,
    contextHash: meta.contextHash,
    summary: "Critério atendido.",
    verification: "sufficient",
    criteria: meta.acceptanceCriteria.map((c) => ({
      criterionId: c.id,
      criterion: c.text,
      status: "met",
      evidence: "value.txt e verificação",
    })),
    findings: [],
    limitations: [],
  };
}
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), "code-review-test-"));
  t.after(() => {
    const target = resolve(cwd);
    const within = relative(resolve(tmpdir()), target);
    assert.ok(
      within.startsWith("code-review-test-") &&
        !within.includes("..") &&
        !within.includes("/") &&
        !within.includes("\\"),
    );
    rmSync(target, { recursive: true, force: true });
  });
  const git = (...args) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const put = (path, text) => {
    mkdirSync(join(cwd, path, ".."), { recursive: true });
    writeFileSync(join(cwd, path), text);
  };
  git("init", "-b", "main");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "Test");
  git("remote", "add", "origin", "https://github.com/example/project.git");
  put(".gitignore", ".checks/code-review/\n");
  put("AGENTS.md", "# Regras\nNão altere código na revisão.");
  put("CLAUDE.md", "@AGENTS.md");
  put(
    "code-review.config.json",
    JSON.stringify({
      version: 1,
      base: "origin/main",
      profiles: {
        light: { maxRounds: 2, requireEvidence: true },
        direct: { maxRounds: 2, requireEvidence: false },
      },
    }),
  );
  put(".tasks/issue-7-example.md", "profile: light\nValor 2.");
  put(".checks/issue-7-example.verified.md", "PASS: valor 2 conferido.");
  put("value.txt", "1");
  git("add", ".");
  git("commit", "-m", "base");
  git("update-ref", "refs/remotes/origin/main", git("rev-parse", "HEAD"));
  git("switch", "-c", "feature");
  put("value.txt", "2");
  git("add", ".");
  git("commit", "-m", "entrega");
  const options = { issue: 7, profile: "light" };
  const calls = [];
  const locations = [];
  const deps = {
    fetch: () => {},
    issue: () => issue,
    authenticate: () => {},
    execute: async ({ cwd: location, snapshot, prompt }) => {
      calls.push(prompt);
      locations.push(location);
      assert.equal(
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: location,
          encoding: "utf8",
        }).trim(),
        snapshot.head,
      );
      assert.equal(readFileSync(join(location, "value.txt"), "utf8"), "2");
      return ready(snapshot);
    },
    remoteHead: () => git("rev-parse", "HEAD"),
    remoteRefs: () => ({
      head: git("rev-parse", "HEAD"),
      base: git("rev-parse", "origin/main"),
    }),
    publish: ({ args }) => {
      calls.push(args);
      return "https://github.com/example/project/pull/1";
    },
  };
  return { cwd, git, put, options, deps, calls, locations };
}

async function inContinuedWorktree(f, operation) {
  const next = join(f.cwd, ".checks/code-review/continued");
  f.git("switch", "--detach");
  try {
    f.git("worktree", "add", next, "feature");
    return await operation(next);
  } finally {
    f.git("worktree", "remove", "--force", next);
    f.git("switch", "feature");
  }
}

test("C1 relatório contraditório, incompleto ou não comprovado nunca libera", () => {
  const meta = {
    base: "a".repeat(40),
    head: "b".repeat(40),
    contextHash: "c".repeat(64),
    requireEvidence: true,
    acceptanceCriteria: [
      { id: "AC1", text: "Valor 2" },
      { id: "AC2", text: "Sem regressão" },
    ],
  };
  assert.doesNotThrow(() => validateReport(ready(meta), meta));
  const note = ready(meta);
  note.findings.push({
    priority: "P2",
    blocking: false,
    file: "value.txt",
    line: 1,
    scenario: "nota",
    expected: "melhoria opcional",
    actual: "critério atendido",
    impact: "sem defeito",
  });
  assert.doesNotThrow(() => validateReport(note, meta));
  for (const mutate of [
    (r) =>
      r.findings.push({
        priority: "P1",
        blocking: false,
        file: "value.txt",
        line: 1,
        scenario: "entrada",
        expected: "2",
        actual: "1",
        impact: "erro",
      }),
    (r) => (r.criteria[0].status = "unverified"),
    (r) => (r.verification = "insufficient"),
    (r) => (r.verification = "not_applicable"),
    (r) => (r.head = "d".repeat(40)),
    (r) => (r.criteria = []),
    (r) => r.criteria.pop(),
    (r) => r.criteria.push({ ...r.criteria[0] }),
    (r) => (r.criteria[1] = { ...r.criteria[0] }),
    (r) => (r.criteria[1].criterionId = "AC3"),
    (r) => (r.criteria[1].criterion = "Critério inventado"),
    (r) => delete r.summary,
    (r) => (r.extra = true),
    (r) =>
      r.findings.push({
        priority: "P2",
        blocking: true,
        file: "value.txt",
        line: 1,
        scenario: "entrada",
        expected: "2",
        actual: "1",
        impact: "erro",
      }),
  ]) {
    const report = ready(meta);
    mutate(report);
    assert.throws(() => validateReport(report, meta));
  }
});

test("C2 contexto ausente, árvore suja, caminho externo e issue errada são recusados", async (t) => {
  for (const title of [
    "Critérios de aceite",
    "Critérios de correção",
    "Acceptance criteria",
    "Correction criteria",
  ]) {
    for (let level = 1; level <= 6; level++) {
      const prefix = "#".repeat(level);
      assert.deepEqual(
        extractIssueCriteria(
          `${prefix} ${title}\n- [ ] X\n${prefix} Restrições\n- Fora`,
        ),
        [{ id: "AC1", text: "X" }],
      );
    }
  }
  assert.deepEqual(
    extractIssueCriteria(
      "## Acceptance criteria\n- [ ] X\n  - Y\n- Z\n## Other\n- W",
    ),
    [
      { id: "AC1", text: "X\n- Y" },
      { id: "AC2", text: "Z" },
    ],
  );
  assert.deepEqual(extractIssueCriteria("## Critérios de aceite\n1. X\n2. Y"), [
    { id: "AC1", text: "X" },
    { id: "AC2", text: "Y" },
  ]);
  for (const body of [
    "Sem seção",
    "## Critérios de aceite\n",
    "## Critérios de aceite\nParágrafo sem lista",
    "## Critérios de aceite\n- X\n## Acceptance criteria\n- Y",
  ])
    assert.throws(() => extractIssueCriteria(body), /critério|Critério|seção/);
  const f = fixture(t);
  f.put("untracked.txt", "x");
  await assert.rejects(review(f.cwd, f.options, f.deps), /limpa/);
  rmSync(join(f.cwd, "untracked.txt"));
  await assert.rejects(
    review(f.cwd, { ...f.options, task: "../outside.md" }, f.deps),
    /caminho|versionado/,
  );
  await assert.rejects(
    review(f.cwd, f.options, {
      ...f.deps,
      issue: () => ({ ...issue, number: 8 }),
    }),
    /issue/,
  );
  await assert.rejects(
    review(f.cwd, f.options, {
      ...f.deps,
      issue: () => ({ ...issue, body: "" }),
    }),
    /issue/,
  );
  rmSync(join(f.cwd, ".checks/issue-7-example.verified.md"));
  f.git("add", ".");
  f.git("commit", "-m", "sem verificação");
  await assert.rejects(review(f.cwd, f.options, f.deps), /verifica/);
});

test("C3 revisão isolada entrega contexto e remove checkout sem tocar original", async (t) => {
  const f = fixture(t);
  const before = f.git("rev-parse", "HEAD");
  const result = await review(f.cwd, f.options, f.deps);
  assert.equal(result.status, "ready");
  assert.equal(f.git("rev-parse", "HEAD"), before);
  assert.equal(f.git("status", "--porcelain"), "");
  assert.match(f.calls[0], /Valor deve ser 2/);
  assert.match(f.calls[0], /Valor 2/);
  assert.match(f.calls[0], /PASS/);
  assert.notEqual(f.locations[0], f.cwd);
  assert.equal(existsSync(f.locations[0]), false);
});

test("C4 erro técnico, saída inválida e mutação não produzem aprovação", async (t) => {
  await assert.rejects(
    runProcess(process.execPath, ["-e", "process.exit(3)"]),
    /Processo falhou \(3\)/,
  );
  await assert.rejects(
    runProcess(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      timeout: 500,
    }),
    /Tempo limite/,
  );
  for (const mode of ["failure", "invalid", "mutation"]) {
    const f = fixture(t);
    const execute = async ({ cwd, snapshot }) => {
      if (mode === "failure") throw new Error("Codex falhou");
      if (mode === "invalid") return { status: "ready" };
      writeFileSync(join(cwd, "value.txt"), "3");
      return ready(snapshot);
    };
    await assert.rejects(review(f.cwd, f.options, { ...f.deps, execute }));
    await assert.rejects(check(f.cwd, f.options, f.deps), /relatório|revisão/);
    assert.equal(f.git("status", "--porcelain"), "");
  }
});

test("C5 revisão repetida reutiliza resultado e alterações invalidam o gate", async (t) => {
  const f = fixture(t);
  await review(f.cwd, f.options, f.deps);
  await review(f.cwd, f.options, f.deps);
  assert.equal(f.calls.length, 1);
  rmSync(join(f.cwd, ".git/code-review/issue-7.state.json"));
  await inContinuedWorktree(f, async (next) => {
    await review(next, f.options, f.deps);
    const result = await check(next, f.options, f.deps);
    assert.equal(result.report.status, "ready");
  });
  assert.equal(f.calls.length, 1, "mudar de worktree não repete a revisão");
  await assert.rejects(
    check(f.cwd, f.options, {
      ...f.deps,
      issue: () => ({ ...issue, body: issue.body + "\n- Novo critério" }),
    }),
    /desatualizada/,
  );
  await review(f.cwd, f.options, {
    ...f.deps,
    issue: () => ({ ...issue, body: issue.body + "\n- Novo critério" }),
  });
  await review(f.cwd, f.options, f.deps);
  assert.equal(
    f.calls.length,
    2,
    "retomar contexto anterior reutiliza a prova existente",
  );
  assert.equal((await check(f.cwd, f.options, f.deps)).report.status, "ready");
  f.put("value.txt", "3");
  f.git("add", ".");
  f.git("commit", "-m", "mudança");
  await assert.rejects(check(f.cwd, f.options, f.deps), /desatualizada/);
  f.git("update-ref", "refs/remotes/origin/main", f.git("rev-parse", "HEAD"));
  await assert.rejects(
    check(f.cwd, f.options, f.deps),
    /desatualizada|alterações/,
  );
});

test("C6 limite de rodadas e exclusão mútua impedem chamadas adicionais", async (t) => {
  const f = fixture(t);
  for (let i = 0; i < 2; i++) {
    await assert.rejects(
      review(f.cwd, f.options, {
        ...f.deps,
        execute: async () => {
          throw new Error("falha");
        },
      }),
    );
    f.put("next.txt", String(i));
    f.git("add", ".");
    f.git("commit", "-m", "correção");
  }
  await assert.rejects(review(f.cwd, f.options, f.deps), /rodadas/);
  await inContinuedWorktree(f, (next) =>
    assert.rejects(review(next, f.options, f.deps), /rodadas/),
  );
  const commonState = join(f.cwd, ".git/code-review/issue-7.state.json");
  rmSync(commonState);
  await inContinuedWorktree(f, (next) =>
    assert.rejects(review(next, f.options, f.deps), /rodadas/),
  );
  assert.equal(
    JSON.parse(readFileSync(commonState, "utf8")).attempts.length,
    2,
    "primeira migração em outra worktree preserva o contador legado",
  );
  assert.equal(
    f.calls.length,
    0,
    "migração não autoriza revisão acima do teto",
  );
  const legacy = readFileSync(
    join(f.cwd, ".checks/code-review/issue-7/state.json"),
    "utf8",
  );
  rmSync(commonState);
  await inContinuedWorktree(f, async (next) => {
    mkdirSync(join(next, ".checks/code-review/issue-7"), { recursive: true });
    writeFileSync(join(next, ".checks/code-review/issue-7/state.json"), legacy);
    await assert.rejects(
      review(next, f.options, f.deps),
      /múltiplas worktrees/,
    );
    await assert.rejects(check(next, f.options, f.deps), /múltiplas worktrees/);
    assert.equal(
      existsSync(commonState),
      false,
      "históricos ambíguos não geram estado comum vazio",
    );
  });
  const config = JSON.parse(
    readFileSync(join(f.cwd, "code-review.config.json"), "utf8"),
  );
  const recordOverride = (issueNumber, override) => {
    config.roundOverrides = { [issueNumber]: override };
    f.put("code-review.config.json", JSON.stringify(config));
    f.git("add", ".");
    f.git("commit", "-m", "exceção de rodada");
  };
  const approved = {
    profile: "light",
    maxRounds: 3,
    approval: "Autorização explícita do proprietário para issue 7.",
  };
  recordOverride(8, approved);
  await assert.rejects(review(f.cwd, f.options, f.deps), /rodadas/);
  for (const invalid of [
    { ...approved, approval: "" },
    { ...approved, profile: "direct" },
    { ...approved, maxRounds: 2 },
    { ...approved, maxRounds: 11 },
  ]) {
    recordOverride(7, invalid);
    await assert.rejects(review(f.cwd, f.options, f.deps), /Exceção/);
  }
  recordOverride(7, approved);
  assert.equal((await review(f.cwd, f.options, f.deps)).status, "ready");
  assert.equal(
    JSON.parse(readFileSync(commonState, "utf8")).attempts.length,
    3,
    "exceção preserva as tentativas anteriores",
  );
  assert.equal(
    config.profiles.light.maxRounds,
    2,
    "exceção por issue não muda o padrão",
  );
  f.put("next.txt", "última correção");
  f.git("add", ".");
  f.git("commit", "-m", "nova cabeça");
  await assert.rejects(review(f.cwd, f.options, f.deps), /rodadas/);
  const g = fixture(t);
  let release;
  let entered;
  const started = new Promise((resolve) => (entered = resolve));
  const first = review(g.cwd, g.options, {
    ...g.deps,
    execute: async ({ snapshot }) => {
      entered();
      await new Promise((resolve) => (release = resolve));
      return ready(snapshot);
    },
  });
  await started;
  await assert.rejects(review(g.cwd, g.options, g.deps), /andamento/);
  const competing = join(g.cwd, ".checks/code-review/competing");
  g.git("worktree", "add", "--force", competing, "feature");
  try {
    await assert.rejects(review(competing, g.options, g.deps), /andamento/);
  } finally {
    g.git("worktree", "remove", "--force", competing);
    release();
  }
  await first;
});

test("C7 abertura exige revisão atual e cabeça remota igual, com resumo no corpo", async (t) => {
  const f = fixture(t);
  f.git("remote", "set-url", "origin", f.cwd);
  try {
    assert.deepEqual(readRemoteRefs(f.cwd, "feature", "origin/main"), {
      head: f.git("rev-parse", "HEAD"),
      base: f.git("rev-parse", "main"),
    });
  } finally {
    f.git(
      "remote",
      "set-url",
      "origin",
      "https://github.com/example/project.git",
    );
  }
  f.put(".checks/code-review/body.md", "Closes #7\nEntrega.");
  const options = {
    ...f.options,
    title: "feat: entrega",
    body: ".checks/code-review/body.md",
  };
  await assert.rejects(createPr(f.cwd, options, f.deps));
  await review(f.cwd, f.options, f.deps);
  await assert.rejects(
    createPr(f.cwd, options, { ...f.deps, remoteHead: () => "a".repeat(40) }),
    /remota/,
  );
  let changed = false;
  let reads = 0;
  let published = false;
  await assert.rejects(
    createPr(f.cwd, options, {
      ...f.deps,
      issue: () => {
        if (++reads === 2) changed = true;
        return issue;
      },
      remoteHead: () => (changed ? "a".repeat(40) : f.git("rev-parse", "HEAD")),
      remoteRefs: () => ({
        head: changed ? "a".repeat(40) : f.git("rev-parse", "HEAD"),
        base: f.git("rev-parse", "origin/main"),
      }),
      publish: () => {
        published = true;
        return "PR";
      },
    }),
    /remota mudou/,
  );
  assert.equal(
    published,
    false,
    "push concorrente na conferência final não publica",
  );
  let baseChanged = false;
  let baseReads = 0;
  await assert.rejects(
    createPr(f.cwd, options, {
      ...f.deps,
      issue: () => {
        if (++baseReads === 2) baseChanged = true;
        return issue;
      },
      remoteRefs: () => ({
        head: f.git("rev-parse", "HEAD"),
        base: baseChanged ? "b".repeat(40) : f.git("rev-parse", "origin/main"),
      }),
      publish: () => {
        published = true;
        return "PR";
      },
    }),
    /Base remota mudou/,
  );
  assert.equal(
    published,
    false,
    "avanço da base durante a leitura final não publica",
  );
  const out = await createPr(f.cwd, options, {
    ...f.deps,
    publish: ({ args, body }) => {
      assert.match(body, /Code review local/);
      assert.match(body, /Closes #7/);
      assert.ok(args.includes("feature"));
      return "PR";
    },
  });
  assert.equal(out, "PR");
  f.put("value.txt", "3");
  await assert.rejects(createPr(f.cwd, options, f.deps), /limpa/);
});

test("C8 raia direta dispensa task e evidência, perfil normal exige ambas", async (t) => {
  const f = fixture(t);
  f.git(
    "rm",
    ".tasks/issue-7-example.md",
    ".checks/issue-7-example.verified.md",
  );
  f.git("commit", "-m", "direta");
  await assert.rejects(review(f.cwd, f.options, f.deps), /task|plano/);
  await review(
    f.cwd,
    { ...f.options, profile: "direct" },
    {
      ...f.deps,
      execute: async ({ snapshot }) => ({
        ...ready(snapshot),
        verification: "not_applicable",
      }),
    },
  );
});

test("C9 argumentos estritos e launcher Windows sem shell ou API key", () => {
  const launcher = (message) => ({
    executable: process.execPath,
    prefix: ["-e", `process.stderr.write(${JSON.stringify(message)})`, "--"],
  });
  assert.doesNotThrow(() =>
    authenticateChatGPT(launcher("Logged in using ChatGPT")),
  );
  assert.throws(
    () => authenticateChatGPT(launcher("Logged in using an API key")),
    /autenticado com ChatGPT/,
  );
  assert.deepEqual(
    parseArgs(["review", "--issue", "7", "--profile", "light"]),
    { command: "review", issue: 7, profile: "light" },
  );
  for (const args of [
    ["review", "--issue", "0"],
    ["review", "--issue", "7", "--issue", "8"],
    ["review", "--unknown", "x"],
    ["merge", "--issue", "7"],
  ])
    assert.throws(() => parseArgs(args));
  assert.deepEqual(
    codexInvocation("win32", ["C:\\tools\\codex.cmd"], (p) =>
      p.endsWith("codex.js"),
    ),
    {
      executable: process.execPath,
      prefix: ["C:\\tools\\node_modules\\@openai\\codex\\bin\\codex.js"],
    },
  );
  const env = codexEnvironment({
    OPENAI_API_KEY: "secret",
    CODEX_API_KEY: "secret",
    PATH: "path",
  });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.PATH, "path");
});
