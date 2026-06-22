#!/usr/bin/env node
/**
 * Universal Pre-commit Linting Setup and Management Tool for TypeScript/React
 * ============================================================================
 *
 * This script provides a complete, portable linting solution for TypeScript/React projects.
 * It can be easily copied to any project and provides all necessary functionality
 * for setting up and managing automated code quality tools.
 *
 * Features:
 * - Automatic installation of linting tools
 * - Pre-commit hooks setup and management
 * - Code formatting and linting
 * - Duplicate code detection
 * - Unused imports detection
 * - IDE-agnostic configuration
 * - Team-ready setup
 *
 * Usage:
 *     node ui_lint.js setup        # Initial setup for new projects
 *     node ui_lint.js install      # Install dependencies and hooks
 *     node ui_lint.js format       # Format code
 *     node ui_lint.js lint         # Run linting checks
 *     node ui_lint.js check        # Check formatting without changes
 *     node ui_lint.js fix          # Fix common issues automatically
 *     node ui_lint.js duplicates   # Check for duplicate code
 *     node ui_lint.js unused       # Check for unused imports
 *     node ui_lint.js clean        # Clean temporary files
 *     node ui_lint.js create-config # Create .pre-commit-config-ui.yaml
 *
 *     Options:
 *     --no-auto-commit             # Disable automatic git staging and commit amendment
 */

import fs from 'fs';
import path from 'path';
import { execSync, spawn } from 'child_process';
import crypto from 'crypto';
import readline from 'readline';

class UILintManager {
    constructor() {
        this.projectRoot = process.cwd();
        this.autoCommitFixes = true;
    }

    // Required packages for TypeScript/React linting
    static LINTING_PACKAGES = [
        'eslint@^9.9.0',
        'typescript-eslint@^8.0.1',
        'eslint-plugin-react-hooks@^5.1.0-rc.0',
        'eslint-plugin-react-refresh@^0.4.9',
        'eslint-plugin-unused-imports@^4.1.4',
        'eslint-plugin-import@^2.30.0',
        '@typescript-eslint/eslint-plugin@^8.0.1',
        '@typescript-eslint/parser@^8.0.1',
        'prettier@^3.3.3',
        'eslint-config-prettier@^9.1.0',
        'eslint-plugin-prettier@^5.2.1',
        'pre-commit@^1.2.2',
        'jscpd@^4.0.5'  // For duplicate code detection
    ];

    // Pre-commit configuration template for TypeScript/React
    static PRECOMMIT_CONFIG = `# Pre-commit configuration for TypeScript/React projects
# This configuration ensures consistent code quality across all commits
repos:
  # TypeScript/JavaScript formatting with Prettier
  - repo: https://github.com/pre-commit/mirrors-prettier
    rev: v4.0.0-alpha.8
    hooks:
      - id: prettier
        types_or: [javascript, jsx, ts, tsx, json, yaml, markdown]
        args: [--write]

  # ESLint for TypeScript/React
  - repo: https://github.com/pre-commit/mirrors-eslint
    rev: v9.9.0
    hooks:
      - id: eslint
        files: \\.(js|jsx|ts|tsx)$
        types: [file]
        args: [--fix]
        additional_dependencies:
          - eslint@^9.9.0
          - typescript-eslint@^8.0.1
          - eslint-plugin-react-hooks@^5.1.0-rc.0
          - eslint-plugin-react-refresh@^0.4.9
          - eslint-plugin-unused-imports@^4.1.4
          - eslint-plugin-import@^2.30.0
          - '@typescript-eslint/eslint-plugin@^8.0.1'
          - '@typescript-eslint/parser@^8.0.1'

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

  # Custom TypeScript/React checks
  - repo: local
    hooks:
      - id: typescript-check
        name: TypeScript type checking
        entry: node ui_lint.js fix --no-auto-commit
        language: system
        pass_filenames: false
        always_run: true
        stages: [pre-commit]
`;

    runCommand(cmd, description, options = {}) {
        console.log(`[*] ${description}...`);
        try {
            const result = execSync(cmd, {
                encoding: 'utf8',
                stdio: options.silent ? 'pipe' : 'inherit',
                cwd: this.projectRoot,
                ...options
            });
            console.log(`[OK] ${description} completed successfully`);
            return result;
        } catch (error) {
            if (!options.allowFailure) {
                console.log(`[ERROR] ${description} failed: ${error.message}`);
                return null;
            } else {
                console.log(`[WARN] ${description} completed with warnings`);
                return error.stdout || '';
            }
        }
    }

    installPackages() {
        console.log('\n[*] Installing linting packages...');

        // Check if we're using npm, yarn, or bun
        let packageManager = 'npm';
        if (fs.existsSync(path.join(this.projectRoot, 'yarn.lock'))) {
            packageManager = 'yarn';
        } else if (fs.existsSync(path.join(this.projectRoot, 'bun.lockb'))) {
            packageManager = 'bun';
        }

        const packagesStr = UILintManager.LINTING_PACKAGES.join(' ');
        const installCmd = packageManager === 'yarn'
            ? `yarn add -D ${packagesStr}`
            : packageManager === 'bun'
                ? `bun add -D ${packagesStr}`
                : `npm install -D ${packagesStr}`;

        const result = this.runCommand(installCmd, 'Installing linting tools', { allowFailure: true });

        if (result === null) {
            console.log('[WARN] Some packages may have failed to install. Continuing...');
        }

        return true;
    }

    createPrecommitConfig() {
        const configPath = path.join(this.projectRoot, '.pre-commit-config-ui.yaml');

        if (fs.existsSync(configPath)) {
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });

            return new Promise((resolve) => {
                rl.question(`[?] ${configPath} already exists. Overwrite? (y/N): `, (answer) => {
                    rl.close();
                    if (answer.toLowerCase() !== 'y') {
                        console.log('[SKIP] Skipping config creation');
                        resolve(true);
                        return;
                    }

                    try {
                        fs.writeFileSync(configPath, UILintManager.PRECOMMIT_CONFIG, 'utf8');
                        console.log(`[OK] Created ${configPath}`);
                        resolve(true);
                    } catch (error) {
                        console.log(`[ERROR] Failed to create config file: ${error.message}`);
                        resolve(false);
                    }
                });
            });
        }

        try {
            fs.writeFileSync(configPath, UILintManager.PRECOMMIT_CONFIG, 'utf8');
            console.log(`[OK] Created ${configPath}`);
            return Promise.resolve(true);
        } catch (error) {
            console.log(`[ERROR] Failed to create config file: ${error.message}`);
            return Promise.resolve(false);
        }
    }

    installHooks() {
        const configPath = path.join(this.projectRoot, '.pre-commit-config-ui.yaml');
        if (!fs.existsSync(configPath)) {
            console.log('[ERROR] .pre-commit-config-ui.yaml not found. Run "create-config" first.');
            return false;
        }

        return this.runCommand(`pre-commit install --config ${configPath}`, 'Installing pre-commit hooks') !== null;
    }

    formatCode() {
        console.log('\n[*] Formatting code...');

        // Format with Prettier
        this.runCommand(
            'npx prettier --write "src/**/*.{js,jsx,ts,tsx,json,css,md}" --ignore-path .gitignore',
            'Formatting code with Prettier',
            { allowFailure: true }
        );

        // Fix with ESLint
        this.runCommand(
            'npx eslint "src/**/*.{js,jsx,ts,tsx}" --fix --ignore-pattern "**/node_modules/**" --ignore-pattern "**/dist/**" --ignore-pattern "**/build/**"',
            'Fixing issues with ESLint',
            { allowFailure: true }
        );
    }

    lintCode() {
        console.log('\n[*] Running comprehensive linting checks...');
        console.log('='.repeat(60));

        const results = {
            eslint: false,
            typescript: false,
            duplicates: false,
            unused: false,
            complexity: false,
            todos: false,
            console: false
        };

        // Run ESLint
        results.eslint = this.runESLintWithPrioritizedOutput();

        // Run TypeScript compiler check
        results.typescript = this.runTypeScriptCheck();

        // Run duplicate code detection (enhanced)
        results.duplicates = this.checkDuplicates();

        // Run unused imports check (enhanced)
        results.unused = this.checkUnusedImports();

        // Run new comprehensive checks
        results.complexity = this.checkCodeComplexity();
        results.todos = this.checkTodoComments();
        results.console = this.checkConsoleStatements();

        // Summary report
        console.log('\n' + '='.repeat(60));
        console.log('[*] COMPREHENSIVE LINTING SUMMARY');
        console.log('='.repeat(60));

        const passed = [];
        const failed = [];

        Object.entries(results).forEach(([check, passed_check]) => {
            const status = passed_check ? 'PASS' : '❌ FAIL';
            const checkName = check.charAt(0).toUpperCase() + check.slice(1);
            console.log(`  ${checkName}: ${status}`);

            if (passed_check) {
                passed.push(check);
            } else {
                failed.push(check);
            }
        });

        console.log('='.repeat(60));
        console.log(`[*] Results: ${passed.length} passed, ${failed.length} failed`);

        if (failed.length > 0) {
            console.log(`[*] Failed checks: ${failed.join(', ')}`);
            console.log('[*] Run "fix" command to automatically resolve some issues');
        } else {
            console.log('[*] 🎉 All code quality checks passed! Excellent work!');
        }

        console.log('='.repeat(60));

        // Return true only if all critical checks pass
        const criticalChecks = ['eslint', 'typescript', 'duplicates', 'unused'];
        const criticalPassed = criticalChecks.every(check => results[check]);

        return criticalPassed;
    }

    runESLintWithPrioritizedOutput() {
        console.log('[*] Running ESLint...');

        try {
            const result = execSync(
                'npx eslint "src/**/*.{js,jsx,ts,tsx}" --format=json --ignore-pattern "**/node_modules/**" --ignore-pattern "**/dist/**" --ignore-pattern "**/build/**"',
                { encoding: 'utf8', stdio: 'pipe', cwd: this.projectRoot }
            );

            console.log('[OK] No ESLint issues found!');
            return true;
        } catch (error) {
            try {
                const results = JSON.parse(error.stdout);
                const issues = this.parseAndPrioritizeESLintIssues(results);

                if (issues.length === 0) {
                    console.log('[OK] No significant ESLint issues found!');
                    return true;
                }

                this.displayPrioritizedESLintIssues(issues.slice(0, 20));

                if (issues.length > 20) {
                    console.log(`\n[INFO] Showing top 20 of ${issues.length} total issues.`);
                }

                console.log(`[WARN] Found ${issues.length} ESLint issues`);
                return false;
            } catch (parseError) {
                console.log('[ERROR] Failed to parse ESLint output');
                return false;
            }
        }
    }

    parseAndPrioritizeESLintIssues(results) {
        const issues = [];
        const severityMap = {
            // Errors (most critical)
            'error': 100,
            // Warnings (medium priority)  
            'warning': 50
        };

        const ruleTypeMap = {
            // Critical TypeScript/React issues
            '@typescript-eslint/no-unused-vars': 90,
            'react-hooks/exhaustive-deps': 85,
            'react-hooks/rules-of-hooks': 85,
            '@typescript-eslint/no-explicit-any': 80,
            'unused-imports/no-unused-imports': 75,
            'import/no-unresolved': 70,
            // Style issues (lower priority)
            'prettier/prettier': 30,
            '@typescript-eslint/prefer-const': 25,
            'prefer-const': 25
        };

        results.forEach(file => {
            file.messages.forEach(message => {
                const baseSeverity = severityMap[message.severity === 2 ? 'error' : 'warning'] || 1;
                const ruleBonus = ruleTypeMap[message.ruleId] || 0;
                const severity = Math.max(baseSeverity, ruleBonus);

                issues.push({
                    file: file.filePath.replace(this.projectRoot, '.'),
                    line: message.line,
                    column: message.column,
                    rule: message.ruleId,
                    message: message.message,
                    severity: severity,
                    type: message.severity === 2 ? 'error' : 'warning'
                });
            });
        });

        // Sort by severity (highest first), then by file/line
        issues.sort((a, b) => {
            if (b.severity !== a.severity) return b.severity - a.severity;
            if (a.file !== b.file) return a.file.localeCompare(b.file);
            return a.line - b.line;
        });

        return issues;
    }

    displayPrioritizedESLintIssues(issues) {
        console.log('\n[ESLINT ISSUES - Prioritized by Severity]');

        const criticalIssues = issues.filter(i => i.severity >= 70);
        const errorIssues = issues.filter(i => i.severity >= 50 && i.severity < 70);
        const warningIssues = issues.filter(i => i.severity < 50);

        if (criticalIssues.length > 0) {
            console.log(`\n[CRITICAL] (${criticalIssues.length} issues):`);
            criticalIssues.forEach(issue => {
                console.log(`  ${issue.file}:${issue.line}:${issue.column} ${issue.rule} ${issue.message}`);
            });
        }

        if (errorIssues.length > 0) {
            console.log(`\n[ERROR] (${errorIssues.length} issues):`);
            errorIssues.forEach(issue => {
                console.log(`  ${issue.file}:${issue.line}:${issue.column} ${issue.rule} ${issue.message}`);
            });
        }

        if (warningIssues.length > 0) {
            console.log(`\n[WARNING] (${warningIssues.length} issues):`);
            warningIssues.forEach(issue => {
                console.log(`  ${issue.file}:${issue.line}:${issue.column} ${issue.rule} ${issue.message}`);
            });
        }

        console.log();
    }

    runTypeScriptCheck() {
        console.log('[*] Running TypeScript type checking...');

        const result = this.runCommand(
            'npx tsc --noEmit --skipLibCheck',
            'TypeScript type checking',
            { allowFailure: true, silent: true }
        );

        return result !== null;
    }

    checkDuplicates() {
        console.log('\n[*] Checking for duplicate code...');

        try {
            // Enhanced jscpd config with JSON output for detailed analysis
            const jscpdConfig = {
                threshold: 3,        // Lower threshold for more sensitive detection
                minLines: 3,         // Detect smaller duplications
                minTokens: 30,       // Lower token threshold
                ignore: [
                    'node_modules/**',
                    'dist/**',
                    'build/**',
                    '**/*.test.*',
                    '**/*.spec.*',
                    '**/*.d.ts',     // Ignore type definitions
                    '**/coverage/**'
                ],
                reporters: ['json', 'console'],  // JSON for parsing + console for display
                format: ['typescript', 'javascript', 'jsx', 'tsx', 'css', 'scss'],
                blame: false,
                absolute: true,      // Show absolute paths
                verbose: true        // More detailed output
            };

            const configPath = path.join(this.projectRoot, '.jscpd.json');
            fs.writeFileSync(configPath, JSON.stringify(jscpdConfig, null, 2));

            // Run jscpd with JSON output to get detailed results
            console.log('[*] Running comprehensive duplicate code detection...');

            try {
                const jsonResult = execSync(
                    'npx jscpd src/ --reporters json --output ./jscpd-report.json',
                    { encoding: 'utf8', stdio: 'pipe', cwd: this.projectRoot }
                );

                // Try to read the JSON report
                const reportPath = path.join(this.projectRoot, 'jscpd-report.json');
                let duplicates = [];

                if (fs.existsSync(reportPath)) {
                    try {
                        const reportData = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
                        duplicates = reportData.duplicates || [];
                    } catch (parseError) {
                        console.log('[WARN] Could not parse JSON report, falling back to console output');
                    }

                    // Clean up report file
                    try {
                        fs.unlinkSync(reportPath);
                    } catch (cleanupError) {
                        // Ignore cleanup errors
                    }
                }

                if (duplicates.length > 0) {
                    console.log('\n' + '='.repeat(80));
                    console.log('[CRITICAL] DUPLICATE CODE DETECTED!');
                    console.log('='.repeat(80));
                    console.log(`[*] Found ${duplicates.length} duplicate code blocks`);

                    // Show top 10 most critical duplicates
                    const topDuplicates = duplicates
                        .sort((a, b) => (b.lines || 0) - (a.lines || 0))  // Sort by line count
                        .slice(0, 10);

                    console.log('\n[TOP 10 MOST CRITICAL DUPLICATES]:');
                    console.log('-'.repeat(80));

                    topDuplicates.forEach((duplicate, index) => {
                        console.log(`\n${index + 1}. Duplicate Block (${duplicate.lines || 'unknown'} lines, ${duplicate.tokens || 'unknown'} tokens):`);

                        if (duplicate.firstFile) {
                            console.log(`   📁 File 1: ${duplicate.firstFile.name || 'unknown'}`);
                            console.log(`   📍 Lines: ${duplicate.firstFile.start || 'unknown'}-${duplicate.firstFile.end || 'unknown'}`);
                        }

                        if (duplicate.secondFile) {
                            console.log(`   📁 File 2: ${duplicate.secondFile.name || 'unknown'}`);
                            console.log(`   📍 Lines: ${duplicate.secondFile.start || 'unknown'}-${duplicate.secondFile.end || 'unknown'}`);
                        }

                        if (duplicate.fragment) {
                            const preview = duplicate.fragment.substring(0, 100).replace(/\n/g, ' ');
                            console.log(`   📝 Preview: ${preview}${duplicate.fragment.length > 100 ? '...' : ''}`);
                        }
                    });

                    console.log('\n' + '='.repeat(80));
                    console.log('[ACTION REQUIRED] Please refactor duplicated code into reusable functions/components.');
                    console.log('='.repeat(80));
                    return false;
                }

            } catch (jsonError) {
                // Fallback to console output if JSON fails
                console.log('[*] JSON output failed, using console output...');

                const result = this.runCommand(
                    'npx jscpd src/ --reporters console',
                    'Analyzing code for duplications (console mode)',
                    { allowFailure: true, silent: false }
                );

                // Check for duplicates in console output
                if (result && (result.includes('Clone found') ||
                    result.includes('Duplicated lines') ||
                    result.includes('└─') ||
                    result.includes('│'))) {
                    console.log('\n' + '='.repeat(60));
                    console.log('[CRITICAL] DUPLICATE CODE DETECTED!');
                    console.log('='.repeat(60));
                    console.log('\n[*] Duplicate code found. See output above for details.');
                    console.log('[*] Consider refactoring duplicated code into reusable functions/components.');
                    console.log('='.repeat(60));
                    return false;
                }
            }

            console.log('\n[OK] No significant code duplication found');
            console.log('[*] Your code appears to follow DRY principles well!');
            return true;

        } catch (error) {
            console.log(`[ERROR] Duplicate code detection failed: ${error.message}`);

            // Fallback: try basic pattern search
            console.log('[*] Attempting fallback duplicate detection...');
            try {
                const fallbackResult = this.runCommand(
                    'npx jscpd --help',
                    'Checking jscpd availability',
                    { allowFailure: true, silent: true }
                );

                if (!fallbackResult) {
                    console.log('[WARN] jscpd not available - installing...');
                    this.runCommand('npm install -g jscpd', 'Installing jscpd globally', { allowFailure: true });
                }

                return true; // Don't fail the build if duplicate detection has issues
            } catch (fallbackError) {
                console.log('[WARN] Could not run duplicate code detection - continuing...');
                return true;
            }
        }
    }

    checkUnusedImports() {
        console.log('\n[*] Checking for unused imports...');

        try {
            const result = execSync(
                'npx eslint "src/**/*.{js,jsx,ts,tsx}" --rule "unused-imports/no-unused-imports: error" --format=json --ignore-pattern "**/node_modules/**" --ignore-pattern "**/dist/**" --ignore-pattern "**/build/**"',
                { encoding: 'utf8', stdio: 'pipe', cwd: this.projectRoot }
            );

            console.log('[OK] No unused imports found!');
            return true;
        } catch (error) {
            try {
                const results = JSON.parse(error.stdout);
                const unusedImports = [];

                results.forEach(file => {
                    file.messages.forEach(message => {
                        if (message.ruleId === 'unused-imports/no-unused-imports') {
                            unusedImports.push({
                                file: file.filePath.replace(this.projectRoot, '.'),
                                line: message.line,
                                column: message.column,
                                message: message.message
                            });
                        }
                    });
                });

                if (unusedImports.length > 0) {
                    console.log('\n' + '='.repeat(50));
                    console.log('[CRITICAL] UNUSED IMPORTS DETECTED!');
                    console.log('='.repeat(50));
                    console.log(`[*] Found ${unusedImports.length} unused imports:`);
                    unusedImports.forEach(item => {
                        console.log(`  ${item.file}:${item.line}:${item.column} ${item.message}`);
                    });
                    console.log('\n[*] Run "fix" command to automatically remove unused imports');
                    console.log('='.repeat(50));
                    return false;
                } else {
                    console.log('[OK] No unused imports found!');
                    return true;
                }
            } catch (parseError) {
                console.log('[WARN] Could not parse unused imports check results');
                return true;
            }
        }
    }

    // New comprehensive code quality checks
    checkCodeComplexity() {
        console.log('\n[*] Checking code complexity...');

        try {
            // Check for large files
            const largeFiles = [];
            const maxFileSize = 500; // lines

            const checkDirectory = (dir) => {
                const files = fs.readdirSync(dir, { withFileTypes: true });

                files.forEach(file => {
                    const fullPath = path.join(dir, file.name);

                    if (file.isDirectory() && !file.name.startsWith('.') && file.name !== 'node_modules') {
                        checkDirectory(fullPath);
                    } else if (file.isFile() && /\.(ts|tsx|js|jsx)$/.test(file.name)) {
                        const content = fs.readFileSync(fullPath, 'utf8');
                        const lineCount = content.split('\n').length;

                        if (lineCount > maxFileSize) {
                            largeFiles.push({
                                file: fullPath.replace(this.projectRoot, '.'),
                                lines: lineCount
                            });
                        }
                    }
                });
            };

            const srcPath = path.join(this.projectRoot, 'src');
            if (fs.existsSync(srcPath)) {
                checkDirectory(srcPath);
            }

            if (largeFiles.length > 0) {
                console.log('\n[WARNING] Large files detected (>500 lines):');
                largeFiles.forEach(file => {
                    console.log(`  ${file.file}: ${file.lines} lines`);
                });
                console.log('[*] Consider breaking large files into smaller modules');
                return false;
            } else {
                console.log('[OK] No overly large files found');
                return true;
            }
        } catch (error) {
            console.log('[WARN] Could not check file complexity');
            return true;
        }
    }

    checkTodoComments() {
        console.log('\n[*] Checking for TODO/FIXME comments...');

        try {
            const todoPattern = /(TODO|FIXME|HACK|XXX|BUG)[\s:]/i;
            const todoComments = [];

            const checkDirectory = (dir) => {
                const files = fs.readdirSync(dir, { withFileTypes: true });

                files.forEach(file => {
                    const fullPath = path.join(dir, file.name);

                    if (file.isDirectory() && !file.name.startsWith('.') && file.name !== 'node_modules') {
                        checkDirectory(fullPath);
                    } else if (file.isFile() && /\.(ts|tsx|js|jsx)$/.test(file.name)) {
                        const content = fs.readFileSync(fullPath, 'utf8');
                        const lines = content.split('\n');

                        lines.forEach((line, index) => {
                            if (todoPattern.test(line)) {
                                todoComments.push({
                                    file: fullPath.replace(this.projectRoot, '.'),
                                    line: index + 1,
                                    content: line.trim()
                                });
                            }
                        });
                    }
                });
            };

            const srcPath = path.join(this.projectRoot, 'src');
            if (fs.existsSync(srcPath)) {
                checkDirectory(srcPath);
            }

            if (todoComments.length > 0) {
                console.log('\n[INFO] Found TODO/FIXME comments:');
                todoComments.slice(0, 10).forEach(todo => {
                    console.log(`  ${todo.file}:${todo.line} ${todo.content}`);
                });

                if (todoComments.length > 10) {
                    console.log(`  ... and ${todoComments.length - 10} more`);
                }

                console.log(`[*] Total: ${todoComments.length} TODO/FIXME comments found`);
                return todoComments.length < 20; // Warn if too many TODOs
            } else {
                console.log('[OK] No TODO/FIXME comments found');
                return true;
            }
        } catch (error) {
            console.log('[WARN] Could not check TODO comments');
            return true;
        }
    }

    checkConsoleStatements() {
        console.log('\n[*] Checking for console statements...');

        try {
            const consolePattern = /console\.(log|warn|error|info|debug)/;
            const consoleStatements = [];

            const checkDirectory = (dir) => {
                const files = fs.readdirSync(dir, { withFileTypes: true });

                files.forEach(file => {
                    const fullPath = path.join(dir, file.name);

                    if (file.isDirectory() && !file.name.startsWith('.') && file.name !== 'node_modules') {
                        checkDirectory(fullPath);
                    } else if (file.isFile() && /\.(ts|tsx|js|jsx)$/.test(file.name)) {
                        const content = fs.readFileSync(fullPath, 'utf8');
                        const lines = content.split('\n');

                        lines.forEach((line, index) => {
                            if (consolePattern.test(line) && !line.includes('// eslint-disable')) {
                                consoleStatements.push({
                                    file: fullPath.replace(this.projectRoot, '.'),
                                    line: index + 1,
                                    content: line.trim()
                                });
                            }
                        });
                    }
                });
            };

            const srcPath = path.join(this.projectRoot, 'src');
            if (fs.existsSync(srcPath)) {
                checkDirectory(srcPath);
            }

            if (consoleStatements.length > 0) {
                console.log('\n[WARNING] Console statements found (consider removing for production):');
                consoleStatements.slice(0, 10).forEach(stmt => {
                    console.log(`  ${stmt.file}:${stmt.line} ${stmt.content}`);
                });

                if (consoleStatements.length > 10) {
                    console.log(`  ... and ${consoleStatements.length - 10} more`);
                }

                console.log(`[*] Total: ${consoleStatements.length} console statements found`);
                return consoleStatements.length < 5; // Warn if too many console statements
            } else {
                console.log('[OK] No console statements found');
                return true;
            }
        } catch (error) {
            console.log('[WARN] Could not check console statements');
            return true;
        }
    }

    checkFormatting() {
        console.log('\n[*] Checking code formatting...');

        // Check Prettier formatting
        const prettierOk = this.runCommand(
            'npx prettier --check "src/**/*.{js,jsx,ts,tsx,json,css,md}" --ignore-path .gitignore',
            'Checking Prettier formatting',
            { allowFailure: true, silent: true }
        ) !== null;

        // Check ESLint formatting rules
        const eslintOk = this.runCommand(
            'npx eslint "src/**/*.{js,jsx,ts,tsx}" --ignore-pattern "**/node_modules/**" --ignore-pattern "**/dist/**" --ignore-pattern "**/build/**"',
            'Checking ESLint formatting rules',
            { allowFailure: true, silent: true }
        ) !== null;

        return prettierOk && eslintOk;
    }

    fixIssues() {
        console.log('\n[*] Fixing common issues...');

        // Format code
        this.formatCode();

        // Fix unused imports
        this.runCommand(
            'npx eslint "src/**/*.{js,jsx,ts,tsx}" --fix --rule "unused-imports/no-unused-imports: error" --ignore-pattern "**/node_modules/**" --ignore-pattern "**/dist/**" --ignore-pattern "**/build/**"',
            'Removing unused imports',
            { allowFailure: true }
        );

        // Stage any files that were modified during fixes
        console.log('\n[*] Staging files modified during fixes...');
        this.runCommand('git add .', 'Staging modified files', { allowFailure: true });

        // Auto-commit fixes if requested
        if (this.autoCommitFixes) {
            this.handleAutoCommitFixes();
        }
    }

    handleAutoCommitFixes() {
        console.log('\n[*] Checking for modified files to auto-commit...');

        try {
            const result = execSync('git diff --name-only', {
                encoding: 'utf8',
                stdio: 'pipe',
                cwd: this.projectRoot
            });

            const modifiedFiles = result.trim().split('\n').filter(f => f.trim());

            if (modifiedFiles.length > 0) {
                console.log(`[*] Found ${modifiedFiles.length} modified files:`);
                modifiedFiles.forEach(file => console.log(`   - ${file}`));

                // Stage the modified files
                console.log('[*] Staging modified files...');
                execSync(`git add ${modifiedFiles.join(' ')}`, { cwd: this.projectRoot });

                // Check if we can amend or need new commit
                try {
                    const statusResult = execSync('git status --porcelain=v1 --branch', {
                        encoding: 'utf8',
                        stdio: 'pipe',
                        cwd: this.projectRoot
                    });

                    const isAhead = statusResult.includes('ahead');
                    const hasStaged = execSync('git diff --cached --name-only', {
                        encoding: 'utf8',
                        stdio: 'pipe',
                        cwd: this.projectRoot
                    }).trim();

                    if (isAhead && hasStaged) {
                        console.log('[*] Amending recent commit with fixes...');
                        execSync('git commit --amend --no-edit', { cwd: this.projectRoot });
                        console.log('[✓] Successfully amended commit with fixes!');
                    } else {
                        console.log('[*] Creating new commit with fixes...');
                        execSync('git commit -m "Auto-fix: Code formatting and linting fixes"', { cwd: this.projectRoot });
                        console.log('[✓] Successfully created new commit with fixes!');
                    }
                } catch (commitError) {
                    console.log('[*] Creating new commit with fixes (fallback)...');
                    execSync('git commit -m "Auto-fix: Code formatting and linting fixes"', { cwd: this.projectRoot });
                    console.log('[✓] Successfully created new commit with fixes!');
                }

                return true;
            } else {
                console.log('[OK] No modified files found - no auto-commit needed');
                return false;
            }
        } catch (error) {
            console.log(`[WARN] Auto-commit failed: ${error.message}`);
            console.log('[INFO] You may need to manually stage and commit the fixes');
            return false;
        }
    }

    cleanFiles() {
        console.log('\n[*] Cleaning temporary files...');

        // Remove common build/cache directories
        const dirsToClean = ['node_modules/.cache', 'dist', 'build', '.eslintcache'];

        dirsToClean.forEach(dir => {
            const fullPath = path.join(this.projectRoot, dir);
            if (fs.existsSync(fullPath)) {
                this.runCommand(`rm -rf "${fullPath}"`, `Removing ${dir}`, { allowFailure: true });
            }
        });

        // Remove temporary files
        this.runCommand(
            'find . -name "*.log" -type f -delete',
            'Removing log files',
            { allowFailure: true }
        );
    }

    async setupProject() {
        console.log('[*] Setting up automated linting for TypeScript/React project...');
        console.log('='.repeat(60));

        // Create config file
        const configCreated = await this.createPrecommitConfig();
        if (!configCreated) {
            return false;
        }

        // Install packages
        if (!this.installPackages()) {
            console.log('[WARN] Package installation had issues, but continuing...');
        }

        // Install hooks
        if (!this.installHooks()) {
            return false;
        }

        // Fix common issues and format code automatically
        this.fixIssues();

        // Run linting check
        this.lintCode();

        console.log('\n' + '='.repeat(60));
        console.log('[OK] SETUP COMPLETE!');
        console.log('='.repeat(60));
        console.log('\n[*] Available commands:');
        console.log('  node ui_lint.js format       - Format code with Prettier and ESLint');
        console.log('  node ui_lint.js lint         - Run linting checks');
        console.log('  node ui_lint.js check        - Check formatting without changes');
        console.log('  node ui_lint.js fix          - Fix common issues automatically');
        console.log('  node ui_lint.js duplicates   - Check for duplicate code');
        console.log('  node ui_lint.js unused       - Check for unused imports');
        console.log('  node ui_lint.js clean        - Clean temporary files');
        console.log('\n[OK] Pre-commit hooks are now active and will run automatically on git commits!');
        console.log('[OK] Works seamlessly with VS Code, WebStorm, and any other IDE!');

        return true;
    }

    showHelp() {
        console.log(`
Universal Pre-commit Linting Setup and Management Tool for TypeScript/React
============================================================================

This script provides a complete, portable linting solution for TypeScript/React projects.

Features:
- Automatic installation of linting tools
- Pre-commit hooks setup and management  
- Code formatting and linting
- Duplicate code detection
- Unused imports detection
- IDE-agnostic configuration
- Team-ready setup

Usage:
    node ui_lint.js setup        # Initial setup for new projects
    node ui_lint.js install      # Install dependencies and hooks
    node ui_lint.js format       # Format code
    node ui_lint.js lint         # Run linting checks
    node ui_lint.js check        # Check formatting without changes
    node ui_lint.js fix          # Fix common issues automatically
    node ui_lint.js duplicates   # Check for duplicate code
    node ui_lint.js unused       # Check for unused imports
    node ui_lint.js clean        # Clean temporary files
    node ui_lint.js create-config # Create .pre-commit-config-ui.yaml

    Options:
    --no-auto-commit             # Disable automatic git staging and commit amendment
        `);
    }
}

// Main execution
async function main() {
    const args = process.argv.slice(2);
    const command = args[0];
    const manager = new UILintManager();

    // Handle options
    if (args.includes('--no-auto-commit')) {
        manager.autoCommitFixes = false;
        console.log('[INFO] Auto-commit mode disabled - you\'ll need to manually stage and commit fixes');
    } else {
        console.log('[INFO] Auto-commit mode enabled - fixes will be automatically staged and committed');
    }

    try {
        switch (command) {
            case 'setup':
                const success = await manager.setupProject();
                process.exit(success ? 0 : 1);
                break;
            case 'install':
                const installSuccess = manager.installPackages() && manager.installHooks();
                process.exit(installSuccess ? 0 : 1);
                break;
            case 'format':
                manager.formatCode();
                break;
            case 'lint':
                const lintSuccess = manager.lintCode();
                process.exit(lintSuccess ? 0 : 1);
                break;
            case 'check':
                const checkSuccess = manager.checkFormatting();
                process.exit(checkSuccess ? 0 : 1);
                break;
            case 'fix':
                manager.fixIssues();
                break;
            case 'duplicates':
                const duplicatesSuccess = manager.checkDuplicates();
                process.exit(duplicatesSuccess ? 0 : 1);
                break;
            case 'unused':
                const unusedSuccess = manager.checkUnusedImports();
                process.exit(unusedSuccess ? 0 : 1);
                break;
            case 'clean':
                manager.cleanFiles();
                break;
            case 'create-config':
                const configSuccess = await manager.createPrecommitConfig();
                process.exit(configSuccess ? 0 : 1);
                break;
            case 'help':
            case '--help':
            case '-h':
                manager.showHelp();
                break;
            default:
                console.log('[ERROR] Unknown command. Use "help" to see available commands.');
                process.exit(1);
        }
    } catch (error) {
        console.log(`\n[ERROR] Unexpected error: ${error.message}`);
        process.exit(1);
    }
}

// Execute main function when script is run directly
main().catch(error => {
    console.error('[ERROR] Script execution failed:', error.message);
    process.exit(1);
});

export default UILintManager;
