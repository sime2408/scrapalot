#!/usr/bin/env python3
"""
Universal Pre-commit Linting Setup and Management Tool
======================================================

This script provides a complete, portable linting solution for Python projects.
It can be easily copied to any project and provides all necessary functionality
for setting up and managing automated code quality tools.

Features:
- Automatic installation of linting tools
- Pre-commit hooks setup and management
- Code formatting and linting
- IDE-agnostic configuration
- Team-ready setup

Usage:
    python pre_commit_lint.py setup     # Initial setup for new projects
    python pre_commit_lint.py install   # Install dependencies and hooks
    python pre_commit_lint.py format    # Format code
    python pre_commit_lint.py lint      # Run linting checks
    python pre_commit_lint.py check     # Check formatting without changes
    python pre_commit_lint.py fix       # Fix common issues automatically (auto-commits by default)
    python pre_commit_lint.py duplicates # Check for duplicate code
    python pre_commit_lint.py clean     # Clean temporary files
    python pre_commit_lint.py create-config  # Create .pre-commit-config.yaml
    python pre_commit_lint.py commit-fix -m "message"  # Smart commit that handles pre-commit hook failures

    Options:
    --no-auto-commit                     # Disable automatic git staging and commit amendment
"""

import argparse
import os
from pathlib import Path
import re
import subprocess
import sys


class PreCommitLintManager:
    """Manages pre-commit linting setup and operations."""

    # Configuration for linting tools
    LINTING_PACKAGES = [
        "flake8==7.3.0",
        "black==25.1.0",
        "isort==6.0.1",
        "pre-commit==4.3.0",
        "autopep8==2.3.1",
        "pylint==3.3.8",
        # language-tool-python removed - was corrupting code references in comments mistakenly grammar autocorrecting them
    ]

    # Pre-commit configuration template
    PRECOMMIT_CONFIG = """# Pre-commit configuration optimized for team development
# This configuration ensures consistent code quality across all commits
default_install_hook_types: [pre-commit, prepare-commit-msg]
repos:
  # Python code formatting with Black
  - repo: https://github.com/psf/black
    rev: 23.12.1
    hooks:
      - id: black
        language_version: python3
        args: [--line-length=150]

  # Import sorting with isort (compatible with Black)
  - repo: https://github.com/pycqa/isort
    rev: 5.13.2
    hooks:
      - id: isort
        args: [--profile=black, --line-length=150, --multi-line=3, --trailing-comma, --force-sort-within-sections, --skip=alembic/versions/proto]

  # General file quality checks
  - repo: https://github.com/pre-commit/pre-commit-hooks
    rev: v4.5.0
    hooks:
      - id: trailing-whitespace
        args: [--markdown-linebreak-ext=md]
      - id: end-of-file-fixer
      - id: check-yaml
      - id: check-json
      - id: check-added-large-files
        args: [--maxkb=5000]
      - id: check-merge-conflict
      - id: check-case-conflict
      - id: mixed-line-ending
        args: [--fix=lf]

  # Python-specific checks
  - repo: https://github.com/pre-commit/pygrep-hooks
    rev: v1.10.0
    hooks:
      - id: python-check-blanket-noqa
      - id: python-check-mock-methods
      - id: python-no-log-warn

  # Custom fixes (runs after all formatters) - SQLAlchemy only
  - repo: local
    hooks:
      - id: sqlalchemy-fixes
        name: SQLAlchemy type fixes
        entry: python pre_commit_lint.py fix --no-auto-commit --sqlalchemy-only
        language: system
        pass_filenames: false
        always_run: true
        stages: [pre-commit]
"""

    def __init__(self):
        self.project_root = Path.cwd()

    @staticmethod
    def run_command(cmd, description, check=True, capture_output=True):
        """Run a command and handle errors."""
        print(f"[*] {description}...")
        try:
            if isinstance(cmd, str):
                result = subprocess.run(cmd, shell=True, check=check, capture_output=capture_output, text=True, encoding="utf-8")  # noqa: S602
            else:
                result = subprocess.run(cmd, check=check, capture_output=capture_output, text=True, encoding="utf-8")

            if result.returncode == 0:
                print(f"[OK] {description} completed successfully")
                return result.stdout if capture_output else None
            else:
                print(f"[WARN] {description} completed with warnings")
                if capture_output and result.stderr:
                    print(f"   {result.stderr.strip()}")
                return result.stdout if capture_output else None

        except subprocess.CalledProcessError as e:
            print(f"[ERROR] {description} failed: {e}")
            if capture_output and e.stderr:
                print(f"   Error: {e.stderr.strip()}")
            return None
        except FileNotFoundError:
            print(f"[ERROR] {description} failed: Command not found")
            return None

    def install_packages(self):
        """Install required linting packages."""
        print("\n[*] Installing linting packages...")

        # Try to install packages
        packages_str = " ".join(self.LINTING_PACKAGES)
        result = self.run_command(f"pip install {packages_str}", "Installing linting tools", check=False)

        if result is None:
            print("[WARN] Some packages may have failed to install. Continuing...")

        return True

    def create_precommit_config(self):
        """Create a.pre-commit-config.yaml file."""
        config_path = self.project_root / ".pre-commit-config.yaml"

        if config_path.exists():
            response = input(f"[?] {config_path} already exists. Overwrite? (y/N): ")
            if response.lower() != "y":
                print("[SKIP] Skipping config creation")
                return True

        try:
            with open(config_path, "w", encoding="utf-8") as f:
                f.write(self.PRECOMMIT_CONFIG)
            print(f"[OK] Created {config_path}")
            return True
        except Exception as e:
            print(f"[ERROR] Failed to create config file: {e}")
            return False

    def install_hooks(self):
        """Install pre-commit hooks."""
        if not (self.project_root / ".pre-commit-config.yaml").exists():
            print("[ERROR] .pre-commit-config.yaml not found. Run 'create-config' first.")
            return False

        return self.run_command("pre-commit install", "Installing pre-commit hooks") is not None

    def format_code(self):
        """Format code using black and isort."""
        print("\n[*] Formatting code...")

        # Format with black (Windows-compatible excludes including Docker logs)
        exclude_pattern = r"(\.git|\.venv|venv|env|__pycache__|\.pytest_cache|alembic|proto|docker-composes|logs|\.docker)"
        self.run_command(
            f'black . --line-length=150 --exclude="{exclude_pattern}"',
            "Formatting code with Black",
            check=False,
        )

        # Sort imports with isort
        self.run_command(
            "isort . --profile=black --line-length=150 --force-sort-within-sections --skip=alembic,proto,docker-composes,logs",
            "Sorting imports with isort",
            check=False,
        )

    def lint_code(self):
        """Run linting checks including duplicate detection."""
        print("\n[*] Running linting checks...")

        # Run flake8 linting with detailed output
        flake8_ok = self._run_flake8_with_prioritized_output()

        # Run duplicate code detection as part of linting
        duplicates_ok = self.check_duplicates()

        return flake8_ok and duplicates_ok

    def _run_flake8_with_prioritized_output(self):
        """Run flake8 and show prioritized issues."""
        print("[*] Running flake8 linting...")

        try:
            result = subprocess.run(
                [
                    "flake8",
                    ".",
                    "--max-line-length=150",
                    "--extend-ignore=E203,W503,E501",
                    "--exclude=venv,env,.git,__pycache__,alembic,proto,docker-composes,logs,*_pb2.py,*_pb2_grpc.py,data,.claude",
                    "--format=%(path)s:%(row)d:%(col)d: %(code)s %(text)s",
                ],
                capture_output=True,
                text=True,
                cwd=self.project_root,
            )

            if result.returncode == 0:
                print("[OK] No flake8 issues found!")
                return True

            # Parse flake8 output and prioritize issues
            issues = self._parse_and_prioritize_flake8_issues(result.stdout)

            if not issues:
                print("[OK] No significant flake8 issues found!")
                return True

            # Show the top 20 most critical issues
            self._display_prioritized_flake8_issues(issues[:20])

            total_issues = len(issues)
            if total_issues > 20:
                print(f"\n[INFO] Showing top 20 of {total_issues} total issues. Run flake8 directly for full output.")

            print(f"[WARN] Found {total_issues} flake8 issues")
            return False

        except FileNotFoundError:
            print("[WARN] flake8 not found. Install with: pip install flake8")
            return False
        except Exception as e:
            print(f"[ERROR] Error running flake8: {e}")
            return False

    @staticmethod
    def _parse_and_prioritize_flake8_issues(flake8_output):
        """Parse flake8 output and prioritize by severity."""
        issues = []

        # Define severity levels (higher number = more critical)
        severity_map = {
            # Errors (most critical)
            "E9": 100,  # Runtime errors
            "F8": 90,  # Undefined names, imports
            "F4": 85,  # Future feature not defined
            "F6": 80,  # Invalid escape sequence
            "F5": 75,  # Assert tuple
            "F7": 70,  # Syntax errors
            "F1": 65,  # Import issues
            "F2": 60,  # Undefined/unused variables
            "F3": 55,  # Format string issues
            # Style errors (medium priority)
            "E1": 50,  # Indentation
            "E2": 45,  # Whitespace
            "E3": 40,  # Blank lines
            "E4": 35,  # Imports
            "E5": 30,  # Line length
            "E7": 25,  # Statements
            # Warnings (lower priority)
            "W1": 20,  # Indentation warning
            "W2": 15,  # Whitespace warning
            "W3": 10,  # Blank line warning
            "W5": 5,  # Line break warning
            "W6": 3,  # Deprecated features
        }

        for line in flake8_output.strip().split("\n"):
            if not line.strip():
                continue

            # Parse: path:row:col: code message
            parts = line.split(":", 3)
            if len(parts) >= 4:
                file_path = parts[0]
                row = parts[1]
                col = parts[2]
                code_and_message = parts[3].strip()

                # Extract error code
                code_parts = code_and_message.split(" ", 1)
                if len(code_parts) >= 2:
                    error_code = code_parts[0]
                    message = code_parts[1]

                    # Determine severity
                    severity = 1  # Default low severity
                    for prefix, sev in severity_map.items():
                        if error_code.startswith(prefix):
                            severity = sev
                            break

                    issues.append(
                        {
                            "file": file_path,
                            "line": row,
                            "col": col,
                            "code": error_code,
                            "message": message,
                            "severity": severity,
                            "full_line": line,
                        }
                    )

        # Sort by severity (highest first), then by file/line
        issues.sort(key=lambda x: (-x["severity"], x["file"], int(x["line"])))
        return issues

    @staticmethod
    def _display_prioritized_flake8_issues(issues):
        """Display flake8 issues grouped by severity."""
        print("\n[FLAKE8 ISSUES - Prioritized by Severity]")

        # Group by severity level
        critical_issues = [i for i in issues if i["severity"] >= 70]
        error_issues = [i for i in issues if 50 <= i["severity"] < 70]
        warning_issues = [i for i in issues if i["severity"] < 50]

        if critical_issues:
            print(f"\n[CRITICAL] ({len(critical_issues)} issues):")
            for issue in critical_issues:
                print(f"  {issue['file']}:{issue['line']}:{issue['col']} {issue['code']} {issue['message']}")

        if error_issues:
            print(f"\n[ERROR] ({len(error_issues)} issues):")
            for issue in error_issues:
                print(f"  {issue['file']}:{issue['line']}:{issue['col']} {issue['code']} {issue['message']}")

        if warning_issues:
            print(f"\n[WARNING] ({len(warning_issues)} issues):")
            for issue in warning_issues:
                print(f"  {issue['file']}:{issue['line']}:{issue['col']} {issue['code']} {issue['message']}")

        print()

    def check_formatting(self):
        """Check if code is properly formatted without making changes."""
        print("\n[*] Checking code formatting...")

        # Check black formatting (Windows-compatible excludes including Docker logs)
        exclude_pattern = r"(\.git|\.venv|venv|env|__pycache__|\.pytest_cache|alembic|proto|docker-composes|logs|\.docker)"
        black_ok = (
            self.run_command(
                f'black . --check --line-length=150 --exclude="{exclude_pattern}"',
                "Checking Black formatting",
                check=False,
            )
            is not None
        )

        # Check isort formatting
        isort_ok = (
            self.run_command(
                "isort . --check-only --profile=black --line-length=150 --force-sort-within-sections --skip=alembic,proto,docker-composes,logs",
                "Checking import sorting",
                check=False,
            )
            is not None
        )

        return black_ok and isort_ok

    def fix_issues(self, skip_grammar=False):
        """Fix common linting issues automatically."""
        # Check if we're in SQLAlchemy-only mode (for pre-commit hooks)
        sqlalchemy_mode = hasattr(self, "sqlalchemy_only_mode") and getattr(self, "sqlalchemy_only_mode", False)

        # Check if git operation is in progress (rebase, merge, etc.)
        git_operation = self._is_git_operation_in_progress()

        if sqlalchemy_mode or git_operation:
            if git_operation:
                print(f"\n[*] Git {git_operation} detected - running minimal fixes to avoid conflicts...")
                print("[INFO] Skipping file modifications that could interfere with git operation")
            else:
                print("\n[*] Running SQLAlchemy-only fixes...")

            # Only run non-file-modifying checks during git operations
            self.fix_sqlalchemy_type_issues()

            # Never call `git add` here: pre-commit manages staging itself,
            # and an extra `git add .` marks untouched files as modified,
            # which makes pre-commit report the hook as "files modified by
            # this hook" even when nothing actually changed.
            return

        print("\n[*] Fixing common issues...")

        # Format code
        self.format_code()

        # Fix SQLAlchemy type checker issues
        self.fix_sqlalchemy_type_issues()

        # Fix grammar issues in comments (optional during setup)
        if not skip_grammar:
            self.fix_comment_grammar()
        else:
            print("[SKIP] Skipping grammar check during setup (can be run later with 'python pre_commit_lint.py fix')")

        # Fix with autopep8
        self.run_command(
            "autopep8 --in-place --recursive --max-line-length=120 . --exclude=venv,env,.git,__pycache__,alembic,proto,docker-composes,logs",
            "Fixing issues with autopep8",
            check=False,
        )

        # Stage any files that were modified during fixes (prevents pre-commit hook failures)
        print("\n[*] Staging files modified during fixes...")
        self.run_command(
            "git add .",
            "Staging modified files",
            check=False,
        )

        # Auto-commit fixes if requested
        if hasattr(self, "auto_commit_fixes") and self.auto_commit_fixes:
            self.handle_auto_commit_fixes()

    @staticmethod
    def fix_sqlalchemy_type_issues():
        """Add noinspection comments for common SQLAlchemy type checker issues."""
        print("\n[*] Fixing SQLAlchemy type checker issues...")

        # Common SQLAlchemy patterns that trigger false positives
        sqlalchemy_patterns = [
            # Query patterns with .first(), .count(), .exists(), etc.
            (
                r"(\s*)(while\s+.*\.query\([^)]+\)\.filter\([^)]+\)\.(?:first|count|scalar|exists)\(\)[^:]*:)",
                r"\1# noinspection PyTypeChecker\n\1\2",
            ),
            # Query patterns in if statements
            (
                r"(\s*)(if\s+.*\.query\([^)]+\)\.filter\([^)]+\)\.(?:first|count|scalar|exists)\(\)[^:]*:)",
                r"\1# noinspection PyTypeChecker\n\1\2",
            ),
            # Variable assignments from SQLAlchemy queries (return type issues)
            (
                r"(\s*)([a-zA-Z_][a-zA-Z0-9_]*\s*=\s*.*\.query\([^)]+\)\.filter\([^)]+\)\.(?:first|one|one_or_none|scalar)\(\))",
                r"\1# noinspection PyTypeChecker\n\1\2",
            ),
            # Parenthesized variable assignments with SQLAlchemy queries only
            (
                r"(\s*)([a-zA-Z_][a-zA-Z0-9_]*\s*=\s*\(\s*.*\.(?:query|session|db)\(.*$)",
                r"\1# noinspection PyTypeChecker\n\1\2",
            ),
            # Return statements with SQLAlchemy queries only
            (
                r"(\s*)(return\s+.*\.query\([^)]+\)\.filter\([^)]+\)\.(?:first|one|one_or_none|scalar)\(\))",
                r"\1# noinspection PyTypeChecker\n\1\2",
            ),
            # Return statements with SQLAlchemy session queries only
            (
                r"(\s*)(return\s+.*\.(?:session|db)\.query\([^)]+\)\.(?:filter|filter_by)\([^)]*\)\.(?:first|one|one_or_none|scalar|all)\(\))",
                r"\1# noinspection PyTypeChecker\n\1\2",
            ),
            # Filter patterns with comparisons
            (r"(\s*)(.*\.filter\([^)]+\s*[><=!]+\s*[^)]+\))", r"\1# noinspection PyTypeChecker\n\1\2"),
        ]

        fixed_files = []

        # Process Python files in src directory
        src_path = Path("src")
        if src_path.exists():
            for py_file in src_path.rglob("*.py"):
                try:
                    content = py_file.read_text(encoding="utf-8")
                    original_content = content
                    lines = content.split("\n")

                    # Track lines that need noinspection comments and their priority
                    noinspection_needed = {}  # line_index -> (priority, pattern_name)

                    # First pass: identify all lines that need noinspection comments
                    for pattern_idx, (pattern, _replacement) in enumerate(sqlalchemy_patterns):
                        pattern_name = [
                            "while_query",
                            "if_query",
                            "variable_assignment",
                            "parenthesized_assignment",
                            "return_query",
                            "return_session_query",
                            "filter_comparison",
                        ][pattern_idx]

                        for i, line in enumerate(lines):
                            if re.search(pattern, line):
                                # Assign priority (lower number = higher priority)
                                priority = 1 if pattern_name == "parenthesized_assignment" else 2

                                # Only update if this is a higher priority or line not yet marked
                                if i not in noinspection_needed or priority < noinspection_needed[i][0]:
                                    noinspection_needed[i] = (priority, pattern_name)

                    # Second pass: apply noinspection comments with proper placement
                    new_lines = []
                    for i, line in enumerate(lines):
                        # Check if this line needs a noinspection comment
                        if i in noinspection_needed:
                            priority, pattern_name = noinspection_needed[i]

                            # Check if the previous line already has noinspection
                            prev_line = lines[i - 1] if i > 0 else ""
                            if "# noinspection PyTypeChecker" not in prev_line:
                                # Add the noinspection comment with proper indentation
                                indent = re.match(r"(\s*)", line).group(1)
                                new_lines.append(f"{indent}# noinspection PyTypeChecker")
                            elif pattern_name == "parenthesized_assignment":
                                # For parenthesized assignments, ensure comment is in the right place
                                # Remove any existing noinspection from previous line if it's misplaced
                                if new_lines and "# noinspection PyTypeChecker" in new_lines[-1]:
                                    # Check if the previous noinspection is for a filter line (misplaced)
                                    if i > 1 and ".filter(" in lines[i - 2]:
                                        new_lines[-1] = lines[i - 1]  # Replace with original line
                                        indent = re.match(r"(\s*)", line).group(1)
                                        new_lines.append(f"{indent}# noinspection PyTypeChecker")

                        new_lines.append(line)

                    content = "\n".join(new_lines)

                    # Write back if changed
                    if content != original_content:
                        py_file.write_text(content, encoding="utf-8")
                        fixed_files.append(str(py_file))

                except Exception as e:
                    print(f"[WARN] Error processing {py_file}: {e}")

        if fixed_files:
            print(f"[OK] Added PyTypeChecker suppressions to {len(fixed_files)} files:")
            for file in fixed_files:
                print(f"   - {file}")
        else:
            print("[OK] No SQLAlchemy type checker issues found to fix")

    def handle_auto_commit_fixes(self):
        """Automatically stage fixes and commit appropriately based on the git state."""
        print("\n[*] Checking for modified files to auto-commit...")

        try:
            # Check if there are any modified files
            result = subprocess.run(["git", "diff", "--name-only"], capture_output=True, text=True, check=False)

            modified_files = result.stdout.strip().split("\n") if result.stdout.strip() else []

            if modified_files:
                print(f"[*] Found {len(modified_files)} modified files:")
                for file in modified_files:
                    print(f"   - {file}")

                # Stage the modified files
                print("[*] Staging modified files...")
                subprocess.run(["git", "add"] + modified_files, check=True)

                # Check if we're in the middle of a commit (has staged changes), or if there's a recent commit to amend
                staged_result = subprocess.run(["git", "diff", "--cached", "--name-only"], capture_output=True, text=True, check=False)
                has_staged_changes = bool(staged_result.stdout.strip())

                # Check if there's a recent local commit (not pushed) that we could amend
                try:
                    # Check if HEAD exists and if there are unpushed commits
                    head_result = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=False)
                    if head_result.returncode == 0:
                        # Check if the last commit is unpushed (ahead of origin)
                        status_result = subprocess.run(["git", "status", "--porcelain=v1", "--branch"], capture_output=True, text=True, check=False)
                        is_ahead = "ahead" in status_result.stdout if status_result.returncode == 0 else False

                        if is_ahead and has_staged_changes:
                            # We have staged changes and unpushed commits - safe to amend
                            print("[*] Amending recent commit with fixes...")
                            self._commit_with_restaging("--amend", "--no-edit")
                            print("[✓] Successfully amended commit with fixes!")
                        else:
                            # Create a new commit for the fixes
                            print("[*] Creating new commit with fixes...")
                            self._commit_with_restaging("-m", "Auto-fix: Code formatting and linting fixes")
                            print("[✓] Successfully created new commit with fixes!")
                    else:
                        # No HEAD (initial commit scenario) - create new commit
                        print("[*] Creating initial commit with fixes...")
                        self._commit_with_restaging("-m", "Auto-fix: Code formatting and linting fixes")
                        print("[✓] Successfully created initial commit with fixes!")

                except subprocess.CalledProcessError:
                    # Fallback to new commit if anything goes wrong with git status checks
                    print("[*] Creating new commit with fixes (fallback)...")
                    self._commit_with_restaging("-m", "Auto-fix: Code formatting and linting fixes")
                    print("[✓] Successfully created new commit with fixes!")

                return True
            else:
                print("[OK] No modified files found - no auto-commit needed")
                return False

        except subprocess.CalledProcessError as e:
            print(f"[WARN] Auto-commit failed: {e}")
            print("[INFO] You may need to manually stage and commit the fixes")
            return False

    @staticmethod
    def _commit_with_restaging(*commit_args):
        """
        Commit with automatic restaging to handle pre-commit hook reformatting.

        This method handles the issue where pre-commit hooks (like black, isort)
        reformat files after staging, causing commits to fail. It automatically
        re-stages files if the commit fails due to pre-commit hook modifications.

        Args:
            *commit_args: Arguments to pass to git commit command
        """
        max_attempts = 3

        for attempt in range(max_attempts):
            try:
                # Attempt the commit
                subprocess.run(["git", "commit"] + list(commit_args), check=True)
                return  # Success!

            except subprocess.CalledProcessError as e:
                if attempt < max_attempts - 1:
                    print(f"[INFO] Commit attempt {attempt + 1} failed (likely due to pre-commit hook reformatting)")
                    print("[INFO] Re-staging modified files and retrying...")

                    # Re-stage all modified files (pre-commit hooks may have reformatted them)
                    subprocess.run(["git", "add", "--update"], check=False)

                    # Also stage any new files that might have been created
                    subprocess.run(["git", "add", "."], check=False)

                    # Wait a moment for file system to settle
                    import time

                    time.sleep(0.5)
                else:
                    # Final attempt failed, re-raise the exception
                    raise e

    @staticmethod
    def commit_with_hooks(commit_message):
        """
        Perform a commit with automatic handling of pre-commit hook file modifications.

        This is a standalone commit function that can be used instead of 'git commit'
        to automatically handle cases where pre-commit hooks modify files.

        Args:
            commit_message: The commit message to use
        """
        print("[*] Starting commit with automatic pre-commit hook handling...")

        try:
            # First, try a normal commit
            result = subprocess.run(["git", "commit", "-m", commit_message], capture_output=True, text=True, check=False)

            if result.returncode == 0:
                print("[OK] Commit successful!")
                return True

            # Check if the failure was due to pre-commit hooks modifying files
            if "files were modified by this hook" in result.stdout or "files were modified by this hook" in result.stderr:
                print("[*] Pre-commit hooks modified files, attempting automatic restaging...")

                # Get list of modified files
                modified_result = subprocess.run(["git", "diff", "--name-only"], capture_output=True, text=True, check=False)

                modified_files = [f.strip() for f in modified_result.stdout.split("\n") if f.strip()]

                if modified_files:
                    print(f"[*] Restaging {len(modified_files)} modified files...")

                    # Stage the modified files
                    for file in modified_files:
                        if os.path.exists(file):
                            subprocess.run(["git", "add", file], check=False)

                    # Try the commit again
                    retry_result = subprocess.run(["git", "commit", "-m", commit_message], capture_output=True, text=True, check=False)

                    if retry_result.returncode == 0:
                        print("[OK] Commit successful after restaging!")
                        return True
                    else:
                        print(f"[ERROR] Commit failed after restaging: {retry_result.stderr}")
                        return False
                else:
                    print("[ERROR] No modified files found to restage")
                    return False
            else:
                print(f"[ERROR] Commit failed: {result.stderr}")
                return False

        except Exception as e:
            print(f"[ERROR] Unexpected error during commit: {e}")
            return False

    @staticmethod
    def commit_fix(commit_message):
        """
        Smart commit that handles pre-commit hook failures automatically.

        This method specifically addresses the workflow issue where:
        1. Pre-commit hooks (black, isort, trailing-whitespace) fix files
        2. Hooks fail because they modified files
        3. User needs to manually stage and commit again

        This method automates the entire process in one command.

        Args:
            commit_message: The commit message to use
        """
        print("[*] Starting smart commit with automatic pre-commit fix handling...")
        print("[INFO] This will automatically handle pre-commit hook file modifications")

        max_attempts = 3

        for attempt in range(max_attempts):
            try:
                print(f"\n[*] Commit attempt {attempt + 1}/{max_attempts}...")

                # Try the commit
                result = subprocess.run(["git", "commit", "-m", commit_message], capture_output=True, text=True, check=False)

                if result.returncode == 0:
                    print("[✓] Commit successful!")
                    return True

                # Check if it's a pre-commit hook failure
                output_text = result.stdout + result.stderr

                if any(
                    keyword in output_text
                    for keyword in [
                        "files were modified by this hook",
                        "black....................................................................Failed",
                        "isort....................................................................Failed",
                        "trailing-whitespace.................................................Failed",
                        "reformatted",
                        "Fixing",
                    ]
                ):
                    print("[*] Pre-commit hooks fixed files and failed (expected behavior)")
                    print("[*] Automatically staging fixed files and retrying commit...")

                    # Stage all modified files (hooks fixed them)
                    stage_result = subprocess.run(["git", "add", "-A"], capture_output=True, text=True, check=False)

                    if stage_result.returncode == 0:
                        print("[✓] Successfully staged all fixed files")
                        # Continue to next attempt
                        continue
                    else:
                        print(f"[WARN] Failed to stage files: {stage_result.stderr}")

                else:
                    # Different kind of failure
                    print("[ERROR] Commit failed for non-hook reason:")
                    print(f"   {result.stderr.strip()}")
                    return False

            except subprocess.CalledProcessError as e:
                print(f"[ERROR] Commit attempt {attempt + 1} failed: {e}")
                if attempt == max_attempts - 1:
                    return False
            except Exception as e:
                print(f"[ERROR] Unexpected error during commit: {e}")
                return False

        print(f"[ERROR] Failed to commit after {max_attempts} attempts")
        return False

    @staticmethod
    def handle_pre_commit_restaging():
        """
        Handle automatic restaging of files modified by pre-commit hooks.

        This method is designed to be called from pre-commit hooks to automatically
        restage files that were modified during the hook execution.
        """
        try:
            # Get list of files that are currently modified (unstaged changes)
            result = subprocess.run(["git", "diff", "--name-only"], capture_output=True, text=True, check=False)

            modified_files = [f.strip() for f in result.stdout.split("\n") if f.strip()]

            if modified_files:
                print(f"[*] Auto-restaging {len(modified_files)} files modified by pre-commit hooks...")

                # Stage the modified files
                for file in modified_files:
                    if os.path.exists(file):
                        subprocess.run(["git", "add", file], check=False)

                print("[OK] Files successfully restaged")
                return True
            else:
                return False

        except Exception as e:
            print(f"[WARN] Could not auto-restage files: {e}")
            return False

    @staticmethod
    def _is_git_operation_in_progress():
        """Check if a git operation (rebase, merge, etc.) is in progress."""
        # noinspection PyBroadException
        try:
            # Check for various git operation states
            git_dir = ".git"

            # Check for rebase in progress
            if os.path.exists(os.path.join(git_dir, "rebase-merge")) or os.path.exists(os.path.join(git_dir, "rebase-apply")):
                return "rebase"

            # Check for merge in progress
            if os.path.exists(os.path.join(git_dir, "MERGE_HEAD")):
                return "merge"

            # Check for cherry-pick in progress
            if os.path.exists(os.path.join(git_dir, "CHERRY_PICK_HEAD")):
                return "cherry-pick"

            # Check for revert in progress
            if os.path.exists(os.path.join(git_dir, "REVERT_HEAD")):
                return "revert"

            return None

        except Exception:
            # If we can't determine git state, assume no operation in progress
            return None

    def setup_pre_commit(self):
        """Set up pre-commit hooks if not already configured."""
        # noinspection PyBroadException
        try:
            self.run_command("pre-commit install", "Installing pre-commit hooks")
            print("[OK] Pre-commit hooks installed successfully")
        except Exception as e:
            print(f"[ERROR] Failed to install pre-commit hooks: {e}")
            return False
        return True

    def fix_comment_grammar(self):
        """Fix grammar issues in Python comments using code-aware basic fixes."""
        print("\n[*] Fixing grammar issues in comments using code-aware grammar fixes...")
        print("[WARN] LanguageTool DISABLED - it corrupts code references in comments:")
        print("   [X] engine.url -> engine.URL")
        print("   [X] pg_params -> pg_parameters")
        print("   [X] PYTHONPATH -> PSYCHOPATH")
        print("   [X] ensure_sqlite_dir -> ensure_SQLite_DIR")
        print("   [X] SQLALCHEMY_DATABASE_URL_ASYNC -> ALCHEMY_DATABASE_URL_ASYNC")
        print("[INFO] Using safer code-aware grammar fixes to preserve technical terms...")

        # Always use code-aware basic grammar fixes to avoid corrupting code references
        self._fix_comment_grammar_basic()

    @staticmethod
    def _fix_comment_grammar_basic():
        """Fallback basic grammar fixes if LanguageTool is not available."""
        print("[*] Using basic grammar fixes...")

        # Basic fixes for common issues (code-aware, preserves technical terms)
        basic_fixes = [
            # Removed problematic capitalization rule - was corrupting variable names in comments
            # Article corrections: "a" → "an" before vowel sounds
            (
                r"(\s*#.*?)(\b)a\s+(error|issue|object|array|element|item|instance|operation|action|event|update|upgrade|option|example|email|url|api|endpoint|interface|implementation|end|execution|exception|attempt)(\b)",
                r"\1\2an \3\4",
            ),
            # Article corrections: "an" → "a" before consonant sounds
            (
                r"(\s*#.*?)(\b)an\s+(user|method|function|class|variable|parameter|result|response|request|file|directory|process|service|handler|manager|controller|model|view|component|module|package|library|framework|database|table|column|field|record|query|connection|session|transaction|cache|config|setting|property|attribute|value|key|string|number|boolean|list|dict|tuple|set)(\b)",
                r"\1\2a \3\4",
            ),
            # Common missing articles
            (
                r"(\s*#.*?)(\b)(at|in|on|to|from|with|by|for|of)\s+(end|beginning|start|middle|top|bottom|left|right|center)(\b)",
                r"\1\2\3 the \4\5",
            ),
            # Add period at the end of comments
            (r"(\s*#.*[a-zA-Z])(\s*)$", r"\1.\2"),
        ]

        fixed_files = []
        src_path = Path("src")
        if src_path.exists():
            for py_file in src_path.rglob("*.py"):
                try:
                    content = py_file.read_text(encoding="utf-8")
                    original_content = content

                    for pattern, replacement in basic_fixes:
                        if callable(replacement):
                            # noinspection PyTypeChecker
                            content = re.sub(pattern, replacement, content)
                        else:
                            # noinspection PyTypeChecker
                            content = re.sub(pattern, replacement, content)

                    if content != original_content:
                        # noinspection PyTypeChecker
                        py_file.write_text(content, encoding="utf-8")
                        fixed_files.append(str(py_file))

                except Exception as e:
                    print(f"[WARN] Error processing {py_file}: {e}")

        if fixed_files:
            print(f"[OK] Applied basic grammar fixes to {len(fixed_files)} files:")
            for file in fixed_files:
                print(f"   - {file}")
        else:
            print("[OK] No basic grammar issues found")

    def check_duplicates(self):
        """Check for duplicate code using both pylint and custom detection."""
        print("\n[*] Checking for duplicate code...")

        # Run pylint duplicate detection
        pylint_result = self.run_command(
            "pylint --disable=all --enable=duplicate-code --min-similarity-lines=4 --ignore=venv,env,.git,__pycache__,alembic,proto,docker-composes,logs src/",
            "Running pylint duplicate code detection",
            check=False,
        )

        pylint_found_duplicates = pylint_result and "Similar lines in" in pylint_result

        if pylint_found_duplicates:
            print("\n[FOUND] Pylint detected code duplication:")
            print(pylint_result)

        if not pylint_found_duplicates:
            print("\n[OK] No significant code duplication found")
            return True
        else:
            return False

    @staticmethod
    def _calculate_similarity(text1, text2):
        """Calculate similarity between two text strings."""
        # Simple similarity calculation based on common characters
        set1 = set(text1.lower())
        set2 = set(text2.lower())
        intersection = set1.intersection(set2)
        union = set1.union(set2)
        return len(intersection) / len(union) if union else 0

    def clean_files(self):
        """Clean up temporary files."""
        print("\n[*] Cleaning temporary files...")

        # Windows-compatible cleanup
        import platform

        if platform.system() == "Windows":
            # Use PowerShell for Windows
            self.run_command(
                'powershell -Command "Get-ChildItem -Path . -Recurse -Name *.pyc | Remove-Item -Force"', "Removing .pyc files", check=False
            )
            self.run_command(
                'powershell -Command "Get-ChildItem -Path . -Recurse -Name __pycache__ | Remove-Item -Recurse -Force"',
                "Removing __pycache__ directories",
                check=False,
            )
            self.run_command(
                'powershell -Command "Get-ChildItem -Path . -Recurse -Name *.egg-info | Remove-Item -Recurse -Force"',
                "Removing .egg-info directories",
                check=False,
            )
        else:
            # Unix/Linux commands
            self.run_command('find . -type f -name "*.pyc" -delete', "Removing .pyc files", check=False)
            self.run_command('find . -type d -name "__pycache__" -exec rm -rf {} +', "Removing __pycache__ directories", check=False)
            self.run_command('find . -type d -name "*.egg-info" -exec rm -rf {} +', "Removing .egg-info directories", check=False)

    def setup_project(self):
        """Complete setup for a new project."""
        print("[*] Setting up automated linting for Python project...")
        print("=" * 60)

        # Create config file
        if not self.create_precommit_config():
            return False

        # Install packages
        if not self.install_packages():
            print("[WARN] Package installation had issues, but continuing...")

        # Install hooks
        if not self.install_hooks():
            return False

        # Fix common issues and format code automatically (skip grammar during setup)
        self.fix_issues(skip_grammar=True)

        # Run linting check
        self.lint_code()

        print("\n" + "=" * 60)
        print("[OK] SETUP COMPLETE!")
        print("=" * 60)
        print("\n[*] Available commands:")
        print("  python pre_commit_lint.py format    - Format code with black and isort")
        print("  python pre_commit_lint.py lint      - Run linting checks")
        print("  python pre_commit_lint.py check     - Check formatting without changes")
        print("  python pre_commit_lint.py fix       - Fix common issues automatically")
        print("  python pre_commit_lint.py commit    - Commit with automatic pre-commit hook handling")
        print("  python pre_commit_lint.py commit-fix - Smart commit that handles pre-commit hook failures")
        print("  python pre_commit_lint.py clean     - Clean temporary files")
        print("\n[OK] Pre-commit hooks are now active and will run automatically on git commits!")
        print("[OK] Works seamlessly with IntelliJ IDEA, VS Code, PyCharm, and any other IDE!")

        return True

    @staticmethod
    def show_help():
        """Show help information."""
        print(__doc__)


def main():
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Universal Pre-commit Linting Setup and Management Tool",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )

    parser.add_argument(
        "command",
        choices=[
            "setup",
            "install",
            "format",
            "lint",
            "check",
            "fix",
            "clean",
            "duplicates",
            "create-config",
            "commit",
            "commit-fix",
            "restage",
            "help",
        ],
        help="Command to run",
    )

    parser.add_argument("--sqlalchemy-only", action="store_true", help="Only run SQLAlchemy-specific fixes")
    parser.add_argument("--no-auto-commit", action="store_true", help="Disable automatic git staging and commit amendment")
    parser.add_argument("--restage", action="store_true", help="Auto-restage files modified by pre-commit hooks")
    parser.add_argument("--message", "-m", type=str, help="Commit message (required for commit command)")

    args = parser.parse_args()
    manager = PreCommitLintManager()

    # Set auto-commit mode based on arguments
    manager.auto_commit_mode = not args.no_auto_commit
    if manager.auto_commit_mode:
        manager.auto_commit_fixes = True
        print("[INFO] Auto-commit mode enabled - fixes will be automatically staged and committed")
    else:
        manager.auto_commit_fixes = False
        print("[INFO] Auto-commit mode disabled - you'll need to manually stage and commit fixes")
    # Set SQLAlchemy-only mode if requested
    if hasattr(args, "sqlalchemy_only") and args.sqlalchemy_only:
        manager.sqlalchemy_only_mode = True
        print("[INFO] SQLAlchemy-only mode enabled - only running type checker fixes")

    try:
        if args.command == "setup":
            success = manager.setup_project()
            sys.exit(0 if success else 1)
        elif args.command == "install":
            success = manager.install_packages() and manager.install_hooks()
            sys.exit(0 if success else 1)
        elif args.command == "format":
            manager.format_code()
        elif args.command == "lint":
            success = manager.lint_code()
            sys.exit(0 if success else 1)
        elif args.command == "check":
            success = manager.check_formatting()
            sys.exit(0 if success else 1)
        elif args.command == "fix":
            manager.fix_issues()
        elif args.command == "clean":
            manager.clean_files()
        elif args.command == "duplicates":
            success = manager.check_duplicates()
            sys.exit(0 if success else 1)
        elif args.command == "create-config":
            success = manager.create_precommit_config()
            sys.exit(0 if success else 1)
        elif args.command == "commit":
            if not args.message:
                print("[ERROR] Commit message is required. Use --message or -m to specify it.")
                print('Example: python pre_commit_lint.py commit -m "Your commit message"')
                sys.exit(1)
            success = manager.commit_with_hooks(args.message)
            sys.exit(0 if success else 1)
        elif args.command == "commit-fix":
            if not args.message:
                print("[ERROR] Commit message is required. Use --message or -m to specify it.")
                print('Example: python pre_commit_lint.py commit-fix -m "Your commit message"')
                sys.exit(1)
            success = manager.commit_fix(args.message)
            sys.exit(0 if success else 1)
        elif args.command == "help":
            manager.show_help()
        elif args.command == "restage" or args.restage:
            success = manager.handle_pre_commit_restaging()
            sys.exit(0 if success else 1)

    except KeyboardInterrupt:
        print("\n[*] Operation cancelled by user")
        sys.exit(1)
    except Exception as e:
        print(f"\n[ERROR] Unexpected error: {e}")
        sys.exit(1)


if __name__ == "__main__":
    main()
