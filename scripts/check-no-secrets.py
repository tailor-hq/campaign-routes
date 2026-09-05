"""Refuse a commit that carries a credential.

Runs in CI on the standalone repository, over the working tree and the whole
commit history. Read-only; prints findings and exits non-zero on any.

# Why this is not the audit that produced this repository

There are two jobs and only one of them belongs in public.

Deciding whether a tree is *ready* to be published means looking for the names
of customers, prospects, internal systems and internal hostnames — and a tool
that does that has to carry those names as patterns. Publishing it would leak
exactly what it exists to catch. That audit stays private and runs before code
reaches this repository.

What belongs here is the half that needs no secrets to describe: credentials.
The patterns below name no company, no customer and no internal system, so this
file is safe to read by anyone, which is the whole test for whether it belongs
in a public repository at all.
"""

import pathlib
import re
import subprocess
import sys

# The repository to scan: this one, or the directory named on the command
# line, which is how the test suite points it at a fixture.
ROOT = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else pathlib.Path(__file__).resolve().parent.parent

# (pattern, why it matters). Deliberately generic: a credential looks the same
# whoever issued it.
PATTERNS = [
    (r"-----BEGIN [A-Z ]*PRIVATE KEY", "private key"),
    (r"\bsk_live_[A-Za-z0-9]{8,}", "live secret key"),
    (r"\bpk_live_[A-Za-z0-9]{8,}", "live publishable key"),
    (r"\bghp_[A-Za-z0-9]{20,}", "GitHub personal access token"),
    (r"\bgithub_pat_[A-Za-z0-9_]{20,}", "GitHub fine-grained token"),
    (r"\bxox[baprs]-[A-Za-z0-9-]{10,}", "Slack token"),
    (r"\bAKIA[0-9A-Z]{16}\b", "AWS access key id"),
    (r"\bCFPAT-[A-Za-z0-9_\-]{10,}", "Contentful management token"),
    (r"\bnpm_[A-Za-z0-9]{30,}", "npm token"),
    (
        r"(?i)\b(secret|password|api[_-]?key|access[_-]?token)\s*[:=]\s*['\"][A-Za-z0-9_\-]{16,}['\"]",
        "hard-coded credential",
    ),
]

SKIP_DIRS = {".git", "node_modules", "dist"}
# This file quotes every pattern above, so scanning it finds itself.
SKIP_FILES = {pathlib.Path(__file__).name}


def scan(label, text, findings):
    for pattern, why in PATTERNS:
        for match in re.finditer(pattern, text):
            line = text[: match.start()].count("\n") + 1
            findings.append((label, line, match.group(0)[:24], why))


def main():
    findings = []

    for path in ROOT.rglob("*"):
        if not path.is_file():
            continue
        if any(part in SKIP_DIRS for part in path.parts):
            continue
        if path.name in SKIP_FILES:
            continue
        try:
            scan(str(path.relative_to(ROOT)), path.read_text(encoding="utf8"), findings)
        except (UnicodeDecodeError, OSError):
            continue

    # History is public too, and a credential removed in a later commit is still
    # in the one that added it. `-- .` scopes the walk to this package, which is
    # the whole repository here and keeps the check usable if it is ever vendored
    # back into a larger one.
    history = subprocess.run(
        ["git", "log", "-p", "--format=%H%n%an <%ae>%n%B", "--", "."],
        cwd=ROOT, capture_output=True, text=True, check=False,
    ).stdout
    scan("<git history>", history, findings)

    if not findings:
        print("Clean: no credential patterns in the tree or the history.")
        return 0

    for label, line, hit, why in findings:
        print(f"{label}:{line}  {hit!r} — {why}")
    print(f"\n{len(findings)} finding(s).")
    return 1


if __name__ == "__main__":
    sys.exit(main())
