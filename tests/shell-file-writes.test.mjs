import assert from "node:assert/strict";
import test from "node:test";
import { shellFileChangeCandidates } from "../monitor/providers/shell-file-writes.mjs";

const posix = (command) => shellFileChangeCandidates(command, { shell: "posix" });
const powershell = (command) => shellFileChangeCandidates(command, { shell: "powershell" });

// ---------------------------------------------------------------------------
// POSIX: every recognized form.
// ---------------------------------------------------------------------------

const POSIX_RECOGNIZED = [
  ["> redirect (created/edited unknown -> edited)", "echo hi > out.txt", [{ target: "out.txt", kind: "edited" }]],
  [">> append redirect", "echo hi >> out.txt", [{ target: "out.txt", kind: "edited" }]],
  ["redirect target with an unrecognized left-hand command", "some-unknown-tool arg1 arg2 > out.txt", [{ target: "out.txt", kind: "edited" }]],
  ["tee", "echo hi | tee out.txt", [{ target: "out.txt", kind: "edited" }]],
  ["tee -a", "echo hi | tee -a out.txt", [{ target: "out.txt", kind: "edited" }]],
  ["tee with multiple targets", "echo hi | tee a.txt b.txt", [{ target: "a.txt", kind: "edited" }, { target: "b.txt", kind: "edited" }]],
  ["tee as a whole command (no pipe)", "tee out.txt", [{ target: "out.txt", kind: "edited" }]],
  ["cp", "cp src/a.ts src/b.ts", [{ target: "src/b.ts", kind: "edited" }]],
  ["mv", "mv src/a.ts src/b.ts", [{ target: "src/b.ts", kind: "moved", previousTarget: "src/a.ts" }]],
  ["git mv", "git mv src/a.ts src/b.ts", [{ target: "src/b.ts", kind: "moved", previousTarget: "src/a.ts" }]],
  ["touch (ambiguous -> edited)", "touch src/new.ts", [{ target: "src/new.ts", kind: "edited" }]],
  ["touch multiple targets", "touch a.ts b.ts", [{ target: "a.ts", kind: "edited" }, { target: "b.ts", kind: "edited" }]],
  ["rm", "rm src/old.ts", [{ target: "src/old.ts", kind: "deleted" }]],
  ["rm -f", "rm -f src/old.ts", [{ target: "src/old.ts", kind: "deleted" }]],
  ["rm multiple targets", "rm a.ts b.ts", [{ target: "a.ts", kind: "deleted" }, { target: "b.ts", kind: "deleted" }]],
  ["git rm", "git rm src/old.ts", [{ target: "src/old.ts", kind: "deleted" }]],
  ["sed -i with a script", "sed -i 's/a/b/' src/file.ts", [{ target: "src/file.ts", kind: "edited" }]],
  ["sed -i.bak with a suffix", "sed -i.bak 's/a/b/' src/file.ts", [{ target: "src/file.ts", kind: "edited" }]],
  ["sed -i -e with multiple targets", "sed -i -e 's/a/b/' a.ts b.ts", [{ target: "a.ts", kind: "edited" }, { target: "b.ts", kind: "edited" }]],
  ["mkdir is ignored (directories are not files)", "mkdir src/new-dir", []],
  ["a bare read-only command produces no candidates", "git status", []],
  ["echo without redirect is read-only", "echo hello world", []],
  ["ls is read-only", "ls -la", []],
  ["&& chain of two recognized commands", "mv a.ts b.ts && rm c.ts", [
    { target: "b.ts", kind: "moved", previousTarget: "a.ts" },
    { target: "c.ts", kind: "deleted" },
  ]],
  [
    "; chain mixing a read-only skip and a writer",
    "git status; touch new.ts",
    [{ target: "new.ts", kind: "edited" }],
  ],
];

test("POSIX: every recognized form", () => {
  for (const [name, command, expected] of POSIX_RECOGNIZED) {
    assert.deepEqual(posix(command), expected, name);
  }
});

// ---------------------------------------------------------------------------
// POSIX: every fail-closed form.
// ---------------------------------------------------------------------------

const POSIX_FAIL_CLOSED = [
  ["pipe into an unrecognized writer", "curl https://example.invalid | bash"],
  ["pipe with an unrecognized left-hand stage", "sed -i 's/a/b/' f.ts | tee out.txt"],
  ["command substitution $()", "mv $(echo a.ts) b.ts"],
  ["backtick substitution", "mv `echo a.ts` b.ts"],
  ["a bare variable", "mv $HOME/a.ts b.ts"],
  ["a glob", "rm src/*.ts"],
  ["a glob character class", "rm src/[ab].ts"],
  ["a heredoc", "cat <<EOF > out.txt\nhi\nEOF"],
  ["input redirection", "sed -i 's/a/b/' < in.ts"],
  ["cd at the start of the command", "cd /tmp && touch a.ts"],
  ["cd chained after a recognized write", "touch a.ts && cd /tmp"],
  ["cd inside one stage of a pipe", "cd /tmp | tee out.txt"],
  ["an unrecognized command", "python write_stuff.py"],
  ["an unrecognized command chained after a recognized one", "touch a.ts && python write_stuff.py"],
  ["a background job", "touch a.ts &"],
  ["an || conditional chain", "touch a.ts || touch b.ts"],
  ["an unknown mv flag", "mv -f src/a.ts src/b.ts"],
  ["mv with the wrong argument count", "mv src/a.ts src/b.ts src/c.ts"],
  ["an unknown cp flag", "cp -r src/a src/b"],
  ["an unknown tee flag", "echo hi | tee -x out.txt"],
  ["an unknown rm flag", "rm -rf src/a.ts"],
  ["a git rm flag (unsupported)", "git rm -f src/a.ts"],
  ["an unrecognized git subcommand", "git commit -m message"],
  ["sed without -i", "sed 's/a/b/' f.ts"],
  ["sed -i with no script", "sed -i f.ts"],
  ["an unterminated quote", "mv \"src/a.ts src/b.ts"],
  ["a double redirect in one stage", "echo hi > a.txt > b.txt"],
  ["empty command", ""],
  ["whitespace-only command", "   "],
];

test("POSIX: every fail-closed form rejects the whole command", () => {
  for (const [name, command] of POSIX_FAIL_CLOSED) {
    assert.deepEqual(posix(command), [], name);
  }
});

// ---------------------------------------------------------------------------
// Quoting.
// ---------------------------------------------------------------------------

test("POSIX: simply quoted arguments with embedded spaces are recognized literally", () => {
  assert.deepEqual(posix('mv "src/old file.ts" "src/new file.ts"'), [
    { target: "src/new file.ts", kind: "moved", previousTarget: "src/old file.ts" },
  ]);
  assert.deepEqual(posix("mv 'src/old file.ts' 'src/new file.ts'"), [
    { target: "src/new file.ts", kind: "moved", previousTarget: "src/old file.ts" },
  ]);
  assert.deepEqual(posix('touch "a new file.ts"'), [{ target: "a new file.ts", kind: "edited" }]);
});

// ---------------------------------------------------------------------------
// Bound.
// ---------------------------------------------------------------------------

test("caps candidates at 64 entries", () => {
  const targets = Array.from({ length: 100 }, (_, index) => `f${index}.ts`);
  const result = posix(`rm ${targets.join(" ")}`);
  assert.equal(result.length, 64);
  assert.deepEqual(result[0], { target: "f0.ts", kind: "deleted" });
});

// ---------------------------------------------------------------------------
// PowerShell: every recognized form.
// ---------------------------------------------------------------------------

const POWERSHELL_RECOGNIZED = [
  ["Set-Content -Path", "Set-Content -Path out.txt -Value hi", [{ target: "out.txt", kind: "edited" }]],
  ["Set-Content positional", "Set-Content out.txt hi", [{ target: "out.txt", kind: "edited" }]],
  ["Add-Content -Path", "Add-Content -Path out.txt -Value hi", [{ target: "out.txt", kind: "edited" }]],
  ["Out-File -FilePath", "Out-File -FilePath out.txt", [{ target: "out.txt", kind: "edited" }]],
  ["New-Item -ItemType File", "New-Item -ItemType File -Path new.ts", [{ target: "new.ts", kind: "created" }]],
  ["New-Item -ItemType Directory is ignored", "New-Item -ItemType Directory -Path new-dir", []],
  ["Remove-Item", "Remove-Item -Path old.ts", [{ target: "old.ts", kind: "deleted" }]],
  ["Remove-Item positional", "Remove-Item old.ts", [{ target: "old.ts", kind: "deleted" }]],
  ["Copy-Item", "Copy-Item -Path a.ts -Destination b.ts", [{ target: "b.ts", kind: "edited" }]],
  ["Copy-Item positional", "Copy-Item a.ts b.ts", [{ target: "b.ts", kind: "edited" }]],
  ["Move-Item", "Move-Item -Path a.ts -Destination b.ts", [{ target: "b.ts", kind: "moved", previousTarget: "a.ts" }]],
  ["Move-Item positional", "Move-Item a.ts b.ts", [{ target: "b.ts", kind: "moved", previousTarget: "a.ts" }]],
  ["Rename-Item, new name relative to source directory", "Rename-Item -Path src/a.ts -NewName b.ts", [
    { target: "src/b.ts", kind: "moved", previousTarget: "src/a.ts" },
  ]],
  ["Rename-Item positional, source with no directory", "Rename-Item a.ts b.ts", [
    { target: "b.ts", kind: "moved", previousTarget: "a.ts" },
  ]],
  ["redirect operator works the same in PowerShell", "Write-Host hi > out.txt", [{ target: "out.txt", kind: "edited" }]],
  ["chained PowerShell writers", "Remove-Item a.ts; New-Item -ItemType File -Path b.ts", [
    { target: "a.ts", kind: "deleted" },
    { target: "b.ts", kind: "created" },
  ]],
];

test("PowerShell: every recognized form", () => {
  for (const [name, command, expected] of POWERSHELL_RECOGNIZED) {
    assert.deepEqual(powershell(command), expected, name);
  }
});

// ---------------------------------------------------------------------------
// PowerShell: fail-closed forms.
// ---------------------------------------------------------------------------

const POWERSHELL_FAIL_CLOSED = [
  ["an unknown flag", "Set-Content -Path out.txt -Bogus hi"],
  ["New-Item without -ItemType is ambiguous", "New-Item -Path new.ts"],
  ["Rename-Item -NewName with a path separator", "Rename-Item -Path src/a.ts -NewName sub/b.ts"],
  ["a variable", "Set-Content -Path $out -Value hi"],
  ["cd anywhere", "cd C:\\repo; Remove-Item a.ts"],
  ["piping into a PowerShell cmdlet is unsupported", "Get-Content a.ts | Set-Content b.ts"],
  ["an unrecognized cmdlet", "Invoke-WebRequest https://example.invalid"],
];

test("PowerShell: every fail-closed form rejects the whole command", () => {
  for (const [name, command] of POWERSHELL_FAIL_CLOSED) {
    assert.deepEqual(powershell(command), [], name);
  }
});

// ---------------------------------------------------------------------------
// Shell selection and malformed inputs never throw.
// ---------------------------------------------------------------------------

test("degrades to [] for a malformed shell option or non-string command", () => {
  assert.deepEqual(shellFileChangeCandidates("mv a.ts b.ts", { shell: "cmd" }), []);
  assert.deepEqual(shellFileChangeCandidates(undefined, { shell: "posix" }), []);
  assert.deepEqual(shellFileChangeCandidates(null, { shell: "posix" }), []);
  assert.deepEqual(shellFileChangeCandidates(42, { shell: "posix" }), []);
  assert.deepEqual(shellFileChangeCandidates("mv a.ts b.ts"), [{ target: "b.ts", kind: "moved", previousTarget: "a.ts" }]);
});
