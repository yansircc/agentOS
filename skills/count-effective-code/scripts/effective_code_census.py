#!/usr/bin/env python3
from __future__ import annotations

import argparse
import collections
import dataclasses
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path


CODE_EXTENSIONS = {
    ".astro",
    ".bash",
    ".c",
    ".cc",
    ".cjs",
    ".clj",
    ".cljs",
    ".cpp",
    ".cs",
    ".css",
    ".erl",
    ".ex",
    ".exs",
    ".fish",
    ".go",
    ".h",
    ".hpp",
    ".hrl",
    ".java",
    ".js",
    ".jsx",
    ".kt",
    ".kts",
    ".less",
    ".lua",
    ".mjs",
    ".php",
    ".pl",
    ".pm",
    ".py",
    ".r",
    ".rb",
    ".rs",
    ".sass",
    ".scala",
    ".scss",
    ".sh",
    ".sql",
    ".svelte",
    ".swift",
    ".ts",
    ".tsx",
    ".vue",
    ".zsh",
}

CODE_BASENAMES = {
    "Dockerfile",
    "Gemfile",
    "Justfile",
    "Makefile",
    "Rakefile",
}

DOC_PREFIXES = (
    "decisions/",
    "docs/",
    "doc/",
    "documentation/",
)

EXCLUDED_PREFIXES = (
    ".cache/",
    ".cst/",
    ".git/",
    ".next/",
    ".nuxt/",
    ".parallel/",
    ".parcel-cache/",
    ".svelte-kit/",
    ".turbo/",
    ".wrangler/",
    "build/",
    "coverage/",
    "dist/",
    "node_modules/",
    "out/",
    "target/",
    "tmp/",
    "vendor/",
)

EXCLUDED_PARTS = {
    ".cache",
    ".next",
    ".nuxt",
    ".parcel-cache",
    ".svelte-kit",
    ".turbo",
    ".wrangler",
    "build",
    "coverage",
    "dist",
    "node_modules",
    "out",
    "target",
    "tmp",
    "vendor",
}

GENERATED_PARTS = {
    "__generated__",
    "generated",
    "gen",
}

EXCLUDED_BASENAMES = {
    ".effect-skill.json",
    "AGENTS.md",
    "CHANGELOG.md",
    "LICENSE",
    "NOTICE",
    "PUBLIC_API.md",
    "README.md",
    "bun.lock",
    "composer.lock",
    "package-lock.json",
    "pnpm-lock.yaml",
    "poetry.lock",
    "yarn.lock",
}

GENERATED_SUFFIXES = (
    ".generated.ts",
    ".generated.tsx",
    ".generated.js",
    ".generated.jsx",
    ".gen.ts",
    ".gen.tsx",
    ".pb.go",
)

PACKAGE_MANIFESTS = {
    "Cargo.toml",
    "Gemfile",
    "composer.json",
    "go.mod",
    "package.json",
    "pyproject.toml",
}

PACKAGE_PARENT_PREFIXES = {
    "apps",
    "crates",
    "libs",
    "packages",
    "services",
    "tooling",
}


@dataclasses.dataclass(frozen=True)
class FileStat:
    path: str
    language: str
    blanks: int
    comments: int
    code: int


@dataclasses.dataclass
class Total:
    files: int = 0
    blanks: int = 0
    comments: int = 0
    code: int = 0

    def add(self, stat: FileStat) -> None:
        self.files += 1
        self.blanks += stat.blanks
        self.comments += stat.comments
        self.code += stat.code

    def as_dict(self) -> dict[str, int]:
        return {
            "files": self.files,
            "code": self.code,
            "comments": self.comments,
            "blanks": self.blanks,
            "lines": self.code + self.comments + self.blanks,
        }


@dataclasses.dataclass(frozen=True)
class Census:
    ref: str
    commit: str
    tree_paths: list[str]
    candidates: list[str]
    excluded: collections.Counter[str]
    records: list[FileStat]


@dataclasses.dataclass
class ChurnTotal:
    added: int = 0
    deleted: int = 0
    commits: set[str] = dataclasses.field(default_factory=set)

    @property
    def changed(self) -> int:
        return self.added + self.deleted


def run(cmd: list[str], *, cwd: Path, input_bytes: bytes | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        cmd,
        cwd=cwd,
        input=input_bytes,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )


def git_root(path: Path) -> Path:
    try:
        result = run(["git", "rev-parse", "--show-toplevel"], cwd=path)
    except subprocess.CalledProcessError as exc:
        sys.stderr.write(exc.stderr.decode("utf-8", errors="replace"))
        raise SystemExit(f"not a git repository: {path}") from exc
    return Path(result.stdout.decode().strip()).resolve()


def rev_parse(repo: Path, ref: str) -> str:
    try:
        result = run(["git", "rev-parse", "--verify", f"{ref}^{{commit}}"], cwd=repo)
    except subprocess.CalledProcessError as exc:
        sys.stderr.write(exc.stderr.decode("utf-8", errors="replace"))
        raise SystemExit(f"invalid git ref: {ref}") from exc
    return result.stdout.decode().strip()


def git_tree_paths(repo: Path, ref: str) -> list[str]:
    try:
        result = run(["git", "ls-tree", "-r", "-z", "--name-only", ref], cwd=repo)
    except subprocess.CalledProcessError as exc:
        sys.stderr.write(exc.stderr.decode("utf-8", errors="replace"))
        raise SystemExit(f"failed to list git tree: {ref}") from exc
    raw = result.stdout.split(b"\0")
    return [
        entry.decode("utf-8", errors="surrogateescape")
        for entry in raw
        if entry
    ]


def is_generated_path(path: str) -> bool:
    basename = os.path.basename(path)
    if basename.endswith(GENERATED_SUFFIXES):
        return True
    parts = path.split("/")
    return any(part in GENERATED_PARTS for part in parts)


def path_extension(path: str) -> str:
    basename = os.path.basename(path)
    if basename.endswith(".d.ts"):
        return ".ts"
    return Path(basename).suffix


def exclusion_reason(path: str, *, include_docs: bool, include_generated: bool) -> str | None:
    normalized = path.replace("\\", "/")
    basename = os.path.basename(normalized)
    if basename in EXCLUDED_BASENAMES:
        return "excluded-file"
    if not include_docs and normalized.startswith(DOC_PREFIXES):
        return "docs-or-prose"
    if normalized.startswith(EXCLUDED_PREFIXES) or any(
        part in EXCLUDED_PARTS for part in normalized.split("/")
    ):
        return "dependency-build-cache-or-vendor"
    if not include_generated and is_generated_path(normalized):
        return "generated"
    if basename not in CODE_BASENAMES and path_extension(normalized) not in CODE_EXTENSIONS:
        return "non-code-extension"
    return None


def filter_paths(
    paths: list[str],
    *,
    include_docs: bool,
    include_generated: bool,
) -> tuple[list[str], collections.Counter[str]]:
    kept: list[str] = []
    excluded: collections.Counter[str] = collections.Counter()
    for path in paths:
        reason = exclusion_reason(
            path,
            include_docs=include_docs,
            include_generated=include_generated,
        )
        if reason is None:
            kept.append(path)
        else:
            excluded[reason] += 1
    return kept, excluded


def safe_extract_git_archive(repo: Path, ref: str, target: Path) -> None:
    try:
        archive = run(["git", "archive", "--format=tar", ref], cwd=repo)
    except subprocess.CalledProcessError as exc:
        sys.stderr.write(exc.stderr.decode("utf-8", errors="replace"))
        raise SystemExit(f"failed to archive git ref: {ref}") from exc

    target_root = target.resolve()
    with tarfile.open(fileobj=io.BytesIO(archive.stdout), mode="r:") as tar:
        for member in tar.getmembers():
            if member.issym() or member.islnk():
                continue
            member_target = (target_root / member.name).resolve()
            if target_root != member_target and target_root not in member_target.parents:
                raise SystemExit(f"unsafe path in git archive: {member.name}")
            tar.extract(member, target_root)


def chunks(items: list[str], size: int) -> list[list[str]]:
    return [items[index : index + size] for index in range(0, len(items), size)]


def choose_counter(requested: str) -> str:
    if requested == "auto":
        if shutil.which("tokei"):
            return "tokei"
        if shutil.which("cloc"):
            return "cloc"
        raise SystemExit("no code counter found: install tokei or cloc")
    if shutil.which(requested) is None:
        raise SystemExit(f"requested counter is not installed: {requested}")
    return requested


def count_with_tokei(tree_root: Path, paths: list[str]) -> list[FileStat]:
    stats: list[FileStat] = []
    for group in chunks(paths, 400):
        result = run(["tokei", "--output", "json", *group], cwd=tree_root)
        data = json.loads(result.stdout.decode())
        for language, payload in data.items():
            if language == "Total":
                continue
            for report in payload.get("reports", []):
                raw_stats = report["stats"]
                stats.append(
                    FileStat(
                        path=report["name"].replace("\\", "/"),
                        language=language,
                        blanks=int(raw_stats.get("blanks", 0)),
                        comments=int(raw_stats.get("comments", 0)),
                        code=int(raw_stats.get("code", 0)),
                    ),
                )
    return stats


def count_with_cloc(tree_root: Path, paths: list[str]) -> list[FileStat]:
    stats: list[FileStat] = []
    for group in chunks(paths, 300):
        result = run(
            ["cloc", "--timeout", "0", "--json", "--by-file", "--quiet", *group],
            cwd=tree_root,
        )
        data = json.loads(result.stdout.decode())
        for name, payload in data.items():
            if name in {"header", "SUM"}:
                continue
            stats.append(
                FileStat(
                    path=name.replace("\\", "/"),
                    language=str(payload.get("language", "unknown")),
                    blanks=int(payload.get("blank", 0)),
                    comments=int(payload.get("comment", 0)),
                    code=int(payload.get("code", 0)),
                ),
            )
    return stats


def count_ref(
    *,
    repo: Path,
    ref: str,
    counter: str,
    include_docs: bool,
    include_generated: bool,
) -> Census:
    commit = rev_parse(repo, ref)
    tree_paths = git_tree_paths(repo, ref)
    candidates, excluded = filter_paths(
        tree_paths,
        include_docs=include_docs,
        include_generated=include_generated,
    )
    with tempfile.TemporaryDirectory(prefix="effective-code-") as tmp:
        tree_root = Path(tmp)
        safe_extract_git_archive(repo, ref, tree_root)
        materialized = [
            path
            for path in candidates
            if (tree_root / path).is_file() and not os.path.islink(tree_root / path)
        ]
        if counter == "tokei":
            records = count_with_tokei(tree_root, materialized)
        else:
            records = count_with_cloc(tree_root, materialized)
    return Census(
        ref=ref,
        commit=commit,
        tree_paths=tree_paths,
        candidates=candidates,
        excluded=excluded,
        records=records,
    )


def classify_bucket(path: str) -> str:
    parts = path.split("/")
    basename = parts[-1]
    lower = basename.lower()
    has_test_dir = any(part in {"test", "tests", "__tests__"} for part in parts)
    is_test_file = bool(re.search(r"(^test_|[._-](test|spec)\\.)", lower))

    if parts[0] == "packages" and (has_test_dir or is_test_file):
        return "package-tests"
    if parts[0] == "packages" and "src" in parts:
        return "package-source"
    if parts[0] == "packages":
        return "package-config"
    if has_test_dir or is_test_file:
        return "tests"
    if parts[0] in {"scripts", "skills", "tooling", "tools", "types"}:
        return "tooling"
    if lower.endswith((".config.js", ".config.mjs", ".config.ts", ".config.cjs")):
        return "tooling"
    if "src" in parts or parts[0] in {"app", "src", "lib"}:
        return "source"
    return "other-code"


def detect_package_roots(paths: list[str]) -> list[str]:
    roots: set[str] = set()
    for path in paths:
        parts = path.split("/")
        if len(parts) < 2 or parts[-1] not in PACKAGE_MANIFESTS:
            continue
        if parts[0] not in PACKAGE_PARENT_PREFIXES:
            continue
        roots.add("/".join(parts[:-1]))
    return sorted(roots, key=lambda root: (-len(root.split("/")), root))


def package_root_for(path: str, roots: list[str]) -> str | None:
    for root in roots:
        if path == root or path.startswith(f"{root}/"):
            return root
    return None


def role_for_record(record: FileStat) -> str:
    bucket = classify_bucket(record.path)
    if bucket in {"package-tests", "tests"}:
        return "tests"
    if bucket in {"package-source", "source"}:
        return "source"
    return "other"


def package_role_totals(records: list[FileStat], roots: list[str]) -> dict[str, dict[str, Total]]:
    totals: dict[str, dict[str, Total]] = {}
    for record in records:
        root = package_root_for(record.path, roots)
        if root is None:
            continue
        roles = totals.setdefault(
            root,
            {
                "source": Total(),
                "tests": Total(),
                "other": Total(),
            },
        )
        roles[role_for_record(record)].add(record)
    return totals


def aggregate(records: list[FileStat], key_fn) -> dict[str, Total]:
    totals: dict[str, Total] = collections.defaultdict(Total)
    for record in records:
        totals[key_fn(record)].add(record)
    return dict(sorted(totals.items(), key=lambda item: (-item[1].code, item[0])))


def total(records: list[FileStat]) -> Total:
    out = Total()
    for record in records:
        out.add(record)
    return out


def total_delta(current: Total, base: Total) -> dict[str, int]:
    return {
        "files": current.files,
        "base_files": base.files,
        "files_delta": current.files - base.files,
        "code": current.code,
        "base_code": base.code,
        "code_delta": current.code - base.code,
        "comments": current.comments,
        "base_comments": base.comments,
        "comments_delta": current.comments - base.comments,
        "blanks": current.blanks,
        "base_blanks": base.blanks,
        "blanks_delta": current.blanks - base.blanks,
        "lines": current.code + current.comments + current.blanks,
        "base_lines": base.code + base.comments + base.blanks,
        "lines_delta": (
            current.code
            + current.comments
            + current.blanks
            - base.code
            - base.comments
            - base.blanks
        ),
    }


def totals_delta(current: dict[str, Total], base: dict[str, Total]) -> dict[str, dict[str, int]]:
    names = sorted(set(current) | set(base))
    rows = {
        name: total_delta(current.get(name, Total()), base.get(name, Total()))
        for name in names
    }
    return dict(
        sorted(
            rows.items(),
            key=lambda item: (-abs(item[1]["code_delta"]), -item[1]["code"], item[0]),
        ),
    )


def package_ratio_rows(records: list[FileStat], roots: list[str], top: int) -> list[dict]:
    package_totals = package_role_totals(records, roots)
    rows: list[dict] = []
    for root, roles in package_totals.items():
        source = roles["source"]
        tests = roles["tests"]
        if source.code == 0 and tests.code == 0:
            continue
        ratio = None if source.code == 0 else round(tests.code / source.code, 4)
        rows.append(
            {
                "package": root,
                "source_code": source.code,
                "source_files": source.files,
                "test_code": tests.code,
                "test_files": tests.files,
                "test_source_ratio": ratio,
            },
        )
    rows.sort(
        key=lambda row: (
            -(int(row["source_code"]) + int(row["test_code"])),
            str(row["package"]),
        ),
    )
    return rows[:top]


def package_delta_rows(
    current_records: list[FileStat],
    base_records: list[FileStat],
    roots: list[str],
    top: int,
) -> list[dict]:
    current_totals = package_role_totals(current_records, roots)
    base_totals = package_role_totals(base_records, roots)
    rows: list[dict] = []
    for root in sorted(set(current_totals) | set(base_totals)):
        current_roles = current_totals.get(
            root,
            {"source": Total(), "tests": Total(), "other": Total()},
        )
        base_roles = base_totals.get(
            root,
            {"source": Total(), "tests": Total(), "other": Total()},
        )
        source_delta = current_roles["source"].code - base_roles["source"].code
        test_delta = current_roles["tests"].code - base_roles["tests"].code
        other_delta = current_roles["other"].code - base_roles["other"].code
        if (
            current_roles["source"].code
            + current_roles["tests"].code
            + current_roles["other"].code
            + base_roles["source"].code
            + base_roles["tests"].code
            + base_roles["other"].code
            == 0
        ):
            continue
        rows.append(
            {
                "package": root,
                "source_code": current_roles["source"].code,
                "base_source_code": base_roles["source"].code,
                "source_delta": source_delta,
                "test_code": current_roles["tests"].code,
                "base_test_code": base_roles["tests"].code,
                "test_delta": test_delta,
                "other_code": current_roles["other"].code,
                "base_other_code": base_roles["other"].code,
                "other_delta": other_delta,
            },
        )
    rows.sort(
        key=lambda row: (
            -(abs(int(row["source_delta"])) + abs(int(row["test_delta"]))),
            str(row["package"]),
        ),
    )
    return rows[:top]


def parse_numstat_int(value: str) -> int | None:
    if value == "-":
        return None
    try:
        return int(value)
    except ValueError:
        return None


def normalize_numstat_path(path: str) -> str:
    normalized = path.replace("\\", "/")
    if " => " not in normalized:
        return normalized
    open_brace = normalized.rfind("{")
    close_brace = normalized.rfind("}")
    if open_brace != -1 and close_brace > open_brace:
        prefix = normalized[:open_brace]
        suffix = normalized[close_brace + 1 :]
        body = normalized[open_brace + 1 : close_brace]
        return prefix + body.split(" => ", 1)[1] + suffix
    return normalized.split(" => ", 1)[1]


def git_churn(repo: Path, ref: str, since: str) -> dict[str, ChurnTotal]:
    try:
        result = run(
            [
                "git",
                "-c",
                "core.quotePath=false",
                "log",
                "--find-renames",
                "--numstat",
                f"--since={since}",
                "--format=@@%H",
                ref,
            ],
            cwd=repo,
        )
    except subprocess.CalledProcessError as exc:
        sys.stderr.write(exc.stderr.decode("utf-8", errors="replace"))
        raise SystemExit(f"failed to compute churn for {ref} since {since}") from exc

    churn: dict[str, ChurnTotal] = {}
    current_commit = ""
    for line in result.stdout.decode("utf-8", errors="replace").splitlines():
        if not line:
            continue
        if line.startswith("@@"):
            current_commit = line[2:]
            continue
        fields = line.split("\t")
        if len(fields) < 3:
            continue
        added = parse_numstat_int(fields[0])
        deleted = parse_numstat_int(fields[1])
        if added is None or deleted is None:
            continue
        path = normalize_numstat_path("\t".join(fields[2:]))
        stat = churn.setdefault(path, ChurnTotal())
        stat.added += added
        stat.deleted += deleted
        if current_commit:
            stat.commits.add(current_commit)
    return churn


def churn_projection(records: list[FileStat], churn: dict[str, ChurnTotal], top: int) -> dict:
    records_by_path = {record.path: record for record in records}
    rows: list[dict] = []
    for path, stat in churn.items():
        record = records_by_path.get(path)
        if record is None or stat.changed == 0:
            continue
        rows.append(
            {
                "path": path,
                "language": record.language,
                "code": record.code,
                "added": stat.added,
                "deleted": stat.deleted,
                "changed": stat.changed,
                "commits": len(stat.commits),
                "hotspot_score": record.code * stat.changed,
            },
        )
    top_churn = sorted(
        rows,
        key=lambda row: (-int(row["changed"]), -int(row["code"]), str(row["path"])),
    )[:top]
    hotspots = sorted(
        rows,
        key=lambda row: (
            -int(row["hotspot_score"]),
            -int(row["changed"]),
            str(row["path"]),
        ),
    )[:top]
    return {
        "counted_files_with_churn": len(rows),
        "top_churn_files": top_churn,
        "hotspots": hotspots,
    }


def table(headers: list[str], rows: list[list[str]]) -> str:
    widths = [
        max(len(header), *(len(row[index]) for row in rows)) if rows else len(header)
        for index, header in enumerate(headers)
    ]
    rendered = [
        "  ".join(header.ljust(widths[index]) for index, header in enumerate(headers)),
        "  ".join("-" * width for width in widths),
    ]
    for row in rows:
        rendered.append("  ".join(cell.rjust(widths[index]) if index else cell.ljust(widths[index]) for index, cell in enumerate(row)))
    return "\n".join(rendered)


def totals_rows(totals: dict[str, Total]) -> list[list[str]]:
    return [
        [
            name,
            str(stat.files),
            str(stat.code),
            str(stat.comments),
            str(stat.blanks),
            str(stat.code + stat.comments + stat.blanks),
        ]
        for name, stat in totals.items()
    ]


def totals_from_report(mapping: dict[str, dict[str, int]]) -> dict[str, Total]:
    return {
        name: Total(
            files=int(stat["files"]),
            code=int(stat["code"]),
            comments=int(stat["comments"]),
            blanks=int(stat["blanks"]),
        )
        for name, stat in mapping.items()
    }


def build_report(
    *,
    repo: Path,
    current: Census,
    counter: str,
    top: int,
    include_docs: bool,
    include_generated: bool,
    base: Census | None,
    churn_since: str | None,
) -> dict:
    records = current.records
    by_bucket = aggregate(records, lambda record: classify_bucket(record.path))
    by_language = aggregate(records, lambda record: record.language)
    largest = sorted(records, key=lambda record: (-record.code, record.path))[:top]
    package_roots = detect_package_roots(current.tree_paths)
    if base is not None:
        package_roots = sorted(
            set(package_roots) | set(detect_package_roots(base.tree_paths)),
            key=lambda root: (-len(root.split("/")), root),
        )
    report = {
        "repo": str(repo),
        "ref": current.ref,
        "commit": current.commit,
        "counter": counter,
        "policy": {
            "tree": "tracked git tree",
            "include_docs": include_docs,
            "include_generated": include_generated,
            "excluded_classes": sorted(current.excluded.keys()),
        },
        "tracked_files": len(current.tree_paths),
        "candidate_files": len(current.candidates),
        "counted_files": len(records),
        "excluded": dict(sorted(current.excluded.items())),
        "total": total(records).as_dict(),
        "buckets": {name: stat.as_dict() for name, stat in by_bucket.items()},
        "languages": {name: stat.as_dict() for name, stat in by_language.items()},
        "package_roots": package_roots,
        "package_test_source_ratios": package_ratio_rows(records, package_roots, top),
        "largest_files": [
            {
                "path": record.path,
                "language": record.language,
                "code": record.code,
                "comments": record.comments,
                "blanks": record.blanks,
            }
            for record in largest
        ],
    }
    if base is not None:
        base_by_bucket = aggregate(base.records, lambda record: classify_bucket(record.path))
        report["base"] = {
            "ref": base.ref,
            "commit": base.commit,
            "tracked_files": len(base.tree_paths),
            "candidate_files": len(base.candidates),
            "counted_files": len(base.records),
            "excluded": dict(sorted(base.excluded.items())),
            "total": total(base.records).as_dict(),
            "buckets": {name: stat.as_dict() for name, stat in base_by_bucket.items()},
        }
        report["total_delta"] = total_delta(total(records), total(base.records))
        report["bucket_deltas"] = totals_delta(by_bucket, base_by_bucket)
        report["package_deltas"] = package_delta_rows(
            records,
            base.records,
            package_roots,
            top,
        )
    if churn_since:
        projection = churn_projection(records, git_churn(repo, current.ref, churn_since), top)
        report["churn"] = {
            "ref": current.ref,
            "since": churn_since,
            **projection,
        }
    return report


def signed(value: int) -> str:
    return f"{value:+d}"


def ratio_text(value: float | None) -> str:
    if value is None:
        return "n/a"
    return f"{value:.2f}"


def print_text_report(report: dict) -> None:
    print("Effective code census")
    print(f"repo: {report['repo']}")
    print(f"ref: {report['ref']} ({report['commit'][:12]})")
    if "base" in report:
        print(f"base: {report['base']['ref']} ({report['base']['commit'][:12]})")
    print(f"counter: {report['counter']}")
    excluded_policy = ["vendor/dependency/build/cache", "lockfiles"]
    if not report["policy"]["include_docs"]:
        excluded_policy.insert(0, "docs/prose")
    if not report["policy"]["include_generated"]:
        insert_at = 1 if "docs/prose" in excluded_policy else 0
        excluded_policy.insert(insert_at, "generated")
    print(f"policy: tracked git tree; exclude {', '.join(excluded_policy)}")
    print(
        "files: "
        f"{report['counted_files']} counted / {report['candidate_files']} candidates / "
        f"{report['tracked_files']} tracked"
    )
    total_stat = report["total"]
    print(
        "total: "
        f"{total_stat['code']} code, {total_stat['comments']} comments, "
        f"{total_stat['blanks']} blanks, {total_stat['lines']} lines"
    )
    if "total_delta" in report:
        delta = report["total_delta"]
        print(
            "delta: "
            f"{signed(int(delta['code_delta']))} code, "
            f"{signed(int(delta['comments_delta']))} comments, "
            f"{signed(int(delta['blanks_delta']))} blanks vs base"
        )
    print()
    print("Buckets")
    print(
        table(
            ["bucket", "files", "code", "comments", "blanks", "lines"],
            totals_rows(totals_from_report(report["buckets"])),
        ),
    )
    if "bucket_deltas" in report:
        print()
        print("Bucket deltas")
        rows = [
            [
                name,
                str(entry["base_code"]),
                str(entry["code"]),
                signed(int(entry["code_delta"])),
                str(entry["base_files"]),
                str(entry["files"]),
                signed(int(entry["files_delta"])),
            ]
            for name, entry in report["bucket_deltas"].items()
        ]
        print(table(["bucket", "base code", "code", "delta", "base files", "files", "delta"], rows))
    print()
    print("Languages")
    print(
        table(
            ["language", "files", "code", "comments", "blanks", "lines"],
            totals_rows(totals_from_report(report["languages"])),
        ),
    )
    if report["package_test_source_ratios"]:
        print()
        print("Package test/source ratios")
        rows = [
            [
                entry["package"],
                str(entry["source_code"]),
                str(entry["test_code"]),
                ratio_text(entry["test_source_ratio"]),
            ]
            for entry in report["package_test_source_ratios"]
        ]
        print(table(["package", "source", "tests", "test/source"], rows))
    if report.get("package_deltas"):
        print()
        print("Package source/test deltas")
        rows = [
            [
                entry["package"],
                str(entry["base_source_code"]),
                str(entry["source_code"]),
                signed(int(entry["source_delta"])),
                str(entry["base_test_code"]),
                str(entry["test_code"]),
                signed(int(entry["test_delta"])),
            ]
            for entry in report["package_deltas"]
        ]
        print(
            table(
                [
                    "package",
                    "base source",
                    "source",
                    "delta",
                    "base tests",
                    "tests",
                    "delta",
                ],
                rows,
            ),
        )
    if report["excluded"]:
        print()
        print("Excluded")
        excluded_rows = [[name, str(count)] for name, count in sorted(report["excluded"].items())]
        print(table(["reason", "files"], excluded_rows))
    if report["largest_files"]:
        print()
        print("Largest files")
        rows = [
            [entry["path"], entry["language"], str(entry["code"])]
            for entry in report["largest_files"]
        ]
        print(table(["path", "language", "code"], rows))
    if "churn" in report:
        churn = report["churn"]
        print()
        print(f"Churn since {churn['since']}")
        print(f"counted files with churn: {churn['counted_files_with_churn']}")
        if churn["top_churn_files"]:
            print()
            print("Top churn files")
            rows = [
                [
                    entry["path"],
                    str(entry["code"]),
                    str(entry["changed"]),
                    str(entry["added"]),
                    str(entry["deleted"]),
                    str(entry["commits"]),
                ]
                for entry in churn["top_churn_files"]
            ]
            print(table(["path", "code", "changed", "added", "deleted", "commits"], rows))
        if churn["hotspots"]:
            print()
            print("Hotspots")
            rows = [
                [
                    entry["path"],
                    str(entry["code"]),
                    str(entry["changed"]),
                    str(entry["hotspot_score"]),
                ]
                for entry in churn["hotspots"]
            ]
            print(table(["path", "code", "changed", "score"], rows))


def main() -> None:
    parser = argparse.ArgumentParser(description="Measure effective code size for a git tree.")
    parser.add_argument("--repo", default=".", help="repository path, default: current directory")
    parser.add_argument("--ref", default="HEAD", help="git ref to measure, default: HEAD")
    parser.add_argument("--base-ref", help="optional git ref for growth/delta tables")
    parser.add_argument("--churn-since", help="optional git log --since window for churn/hotspots")
    parser.add_argument("--counter", choices=["auto", "tokei", "cloc"], default="auto")
    parser.add_argument("--include-docs", action="store_true", help="include docs/prose paths")
    parser.add_argument("--include-generated", action="store_true", help="include generated-looking code paths")
    parser.add_argument("--json", action="store_true", help="emit JSON instead of text")
    parser.add_argument("--top", type=int, default=15, help="number of rows to show in top-N tables")
    args = parser.parse_args()

    repo = git_root(Path(args.repo).resolve())
    counter = choose_counter(args.counter)
    current = count_ref(
        repo=repo,
        ref=args.ref,
        counter=counter,
        include_docs=args.include_docs,
        include_generated=args.include_generated,
    )
    base = None
    if args.base_ref:
        base = count_ref(
            repo=repo,
            ref=args.base_ref,
            counter=counter,
            include_docs=args.include_docs,
            include_generated=args.include_generated,
        )

    report = build_report(
        repo=repo,
        current=current,
        counter=counter,
        top=max(0, args.top),
        include_docs=args.include_docs,
        include_generated=args.include_generated,
        base=base,
        churn_since=args.churn_since,
    )
    if args.json:
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print_text_report(report)


if __name__ == "__main__":
    main()
