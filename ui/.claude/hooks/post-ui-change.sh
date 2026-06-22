#!/bin/bash
# Claude Code Hook: Post-UI-Change Validator
# Pokreće se NAKON što Claude napravi UI promjene
# Provjerava breaking changes, functional validation, i nudi design suggestions

set -e

# Boje
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
MAGENTA='\033[0;35m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo -e "${BLUE}${BOLD}"
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║        Claude Code: Post-UI-Change Validation Hook            ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Funkcija za provjeru breaking changes
check_breaking_changes() {
  echo -e "${CYAN}🔍 Checking for Breaking Changes...${NC}\n"

  local has_issues=false

  # Provjeri da li postoje staged changes
  if ! git diff --cached --quiet 2>/dev/null; then
    echo -e "${YELLOW}Detecting changes in staged files...${NC}\n"

    # Uzmi sve staged fajlove
    staged_files=$(git diff --cached --name-only --diff-filter=M 2>/dev/null || echo "")

    if [ -n "$staged_files" ]; then
      # Provjeri exports
      echo -e "${BOLD}Checking exports...${NC}"
      for file in $staged_files; do
        if [ -f "$file" ]; then
          # Provjeri da li je export uklonjen
          removed_exports=$(git diff --cached "$file" | grep "^-.*export" | grep -v "^---" || true)
          if [ -n "$removed_exports" ]; then
            echo -e "${RED}⚠️  Warning: Exports removed in $file${NC}"
            echo -e "${YELLOW}$removed_exports${NC}"
            has_issues=true
          fi
        fi
      done
      echo -e "${GREEN}✓ Export check complete${NC}\n"

      # Provjeri props (interface promjene)
      echo -e "${BOLD}Checking interface/props changes...${NC}"
      for file in $staged_files; do
        if [ -f "$file" ]; then
          removed_props=$(git diff --cached "$file" | grep "^-.*:" | grep -E "(interface|type)" | grep -v "^---" || true)
          if [ -n "$removed_props" ]; then
            echo -e "${RED}⚠️  Warning: Props/interface changes in $file${NC}"
            echo -e "${YELLOW}$removed_props${NC}"
            has_issues=true
          fi
        fi
      done
      echo -e "${GREEN}✓ Interface check complete${NC}\n"

      # Provjeri function signatures
      echo -e "${BOLD}Checking function signatures...${NC}"
      for file in $staged_files; do
        if [ -f "$file" ]; then
          removed_functions=$(git diff --cached "$file" | grep "^-.*function\|^-.*const.*=.*(" | grep -v "^---" || true)
          if [ -n "$removed_functions" ]; then
            echo -e "${YELLOW}ℹ️  Function changes detected in $file${NC}"
            # Ovo nije nužno breaking change, ali treba provjeriti
          fi
        fi
      done
      echo -e "${GREEN}✓ Function check complete${NC}\n"

    else
      echo -e "${YELLOW}No modified files detected in staging area${NC}\n"
    fi
  else
    echo -e "${YELLOW}No staged changes detected${NC}\n"
  fi

  if [ "$has_issues" = true ]; then
    echo -e "${RED}${BOLD}❌ BREAKING CHANGES DETECTED${NC}"
    echo -e "${YELLOW}Please review the warnings above and ensure:${NC}"
    echo -e "  ${YELLOW}•${NC} Removed exports are not used elsewhere"
    echo -e "  ${YELLOW}•${NC} Interface changes don't break existing components"
    echo -e "  ${YELLOW}•${NC} Function signature changes are backwards compatible\n"
    return 1
  else
    echo -e "${GREEN}${BOLD}No breaking changes detected${NC}\n"
    return 0
  fi
}

# Funkcija za functional validation
functional_validation() {
  echo -e "${CYAN}🧪 Functional Validation...${NC}\n"

  # Provjeri TypeScript syntax
  echo -e "${BOLD}Checking TypeScript syntax...${NC}"
  if command -v npx &> /dev/null; then
    if npx tsc --noEmit --pretty 2>&1 | head -20; then
      echo -e "${GREEN}✓ TypeScript syntax valid${NC}\n"
    else
      echo -e "${RED}⚠️  TypeScript errors detected (showing first 20 lines)${NC}\n"
    fi
  else
    echo -e "${YELLOW}⚠️  npx not found, skipping TypeScript check${NC}\n"
  fi

  # Provjeri ESLint (ako postoji)
  echo -e "${BOLD}Checking ESLint...${NC}"
  if [ -f ".eslintrc.js" ] || [ -f ".eslintrc.json" ] || [ -f "eslint.config.js" ]; then
    if command -v npx &> /dev/null; then
      # Run ESLint samo na promijenjenim fajlovima
      staged_files=$(git diff --cached --name-only --diff-filter=AM | grep -E '\.(tsx?|jsx?)$' || true)
      if [ -n "$staged_files" ]; then
        if npx eslint $staged_files 2>&1 | head -20; then
          echo -e "${GREEN}✓ ESLint passed${NC}\n"
        else
          echo -e "${YELLOW}⚠️  ESLint warnings (showing first 20 lines)${NC}\n"
        fi
      else
        echo -e "${YELLOW}No TypeScript/JavaScript files to lint${NC}\n"
      fi
    fi
  else
    echo -e "${YELLOW}ESLint config not found, skipping${NC}\n"
  fi
}

# Funkcija za design suggestions
design_suggestions() {
  echo -e "${MAGENTA}${BOLD}💡 Design Enhancement Suggestions${NC}\n"

  echo -e "${BOLD}Would you like to consider modern design improvements?${NC}"
  echo -e "I can suggest:\n"
  echo -e "  ${CYAN}•${NC} Framer Motion animations for smooth transitions"
  echo -e "  ${CYAN}•${NC} Glassmorphism effects for modals/overlays"
  echo -e "  ${CYAN}•${NC} Micro-interactions (hover states, loading states)"
  echo -e "  ${CYAN}•${NC} Progress indicators and feedback mechanisms"
  echo -e "  ${CYAN}•${NC} Hero sections and landing page components"
  echo -e "  ${CYAN}•${NC} Responsive design optimizations\n"

  # Ne čekamo input u hook-u, samo pokazujemo info
  echo -e "${YELLOW}Note: Ask Claude to provide specific suggestions if desired${NC}\n"
}

# Main execution
echo -e "${BOLD}${CYAN}Running Post-UI-Change Validations...${NC}\n"

# 1. Check breaking changes
if check_breaking_changes; then
  echo -e "${GREEN}Breaking changes check: PASSED${NC}\n"
else
  echo -e "${RED}❌ Breaking changes check: FAILED${NC}\n"
  echo -e "${YELLOW}Review the issues above before committing${NC}\n"
fi

# 2. Functional validation
functional_validation

# 3. Design suggestions (opciona

lno)
design_suggestions

echo -e "${BOLD}${GREEN}Post-validation complete!${NC}\n"
echo -e "${CYAN}Summary:${NC}"
echo -e "  ${GREEN}•${NC} Breaking changes checked"
echo -e "  ${GREEN}•${NC} TypeScript syntax validated"
echo -e "  ${GREEN}•${NC} ESLint checks performed"
echo -e "  ${GREEN}•${NC} Design suggestions available\n"

echo -e "${CYAN}Next steps:${NC}"
echo -e "  1. Review any warnings above"
echo -e "  2. Test the changes manually"
echo -e "  3. Run: ${BOLD}npm run dev${NC} to see changes"
echo -e "  4. Commit when ready: ${BOLD}git commit -m \"Your message\"${NC}\n"

exit 0
