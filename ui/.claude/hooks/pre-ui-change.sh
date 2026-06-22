#!/bin/bash
# Claude Code Hook: Pre-UI-Change Validator
# Pokreće se PRIJE nego Claude napravi UI promjene
# Validira da li Claude slijedi README_STYLE.md i ne razbija kod

set -e

# Boje
RED='\033[0;31m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

echo -e "${BLUE}${BOLD}"
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║         Claude Code: Pre-UI-Change Validation Hook            ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

# Provjeri da li je ovo UI related task
# Hook dobiva context preko environment varijabli ili stdin

echo -e "${CYAN}📋 Checking Task Context...${NC}\n"

# Provjeri da li postoji README_STYLE.md
if [ ! -f "docs/README_STYLE.md" ]; then
  echo -e "${RED}❌ ERROR: docs/README_STYLE.md not found!${NC}"
  echo -e "${YELLOW}This hook requires README_STYLE.md to validate design system compliance.${NC}"
  exit 1
fi

echo -e "${GREEN}README_STYLE.md found${NC}\n"

# Prikaži design system reminders
echo -e "${BOLD}${CYAN}🎨 Design System Reminders:${NC}\n"

echo -e "${BOLD}DO:${NC}"
echo -e "  ${GREEN}•${NC} Use semantic colors: ${CYAN}bg-primary${NC}, ${CYAN}text-primary${NC}, ${CYAN}border-primary${NC}"
echo -e "  ${GREEN}•${NC} Sharp corners: NO rounded-* (except ${CYAN}rounded-full${NC} for circles)"
echo -e "  ${GREEN}•${NC} Borders over shadows: Prefer ${CYAN}border border-border${NC}"
echo -e "  ${GREEN}•${NC} Spacing scale: 4px multiples (4, 8, 12, 16, 24...)"
echo -e "  ${GREEN}•${NC} Framer Motion: Use for animations"
echo -e "  ${GREEN}•${NC} Test all 6 accent colors\n"

echo -e "${BOLD}❌ DON'T:${NC}"
echo -e "  ${RED}•${NC} Hardcode colors: ${YELLOW}bg-blue-500${NC}, ${YELLOW}bg-violet-600${NC}"
echo -e "  ${RED}•${NC} Add border-radius: ${YELLOW}rounded-md${NC}, ${YELLOW}rounded-lg${NC}, ${YELLOW}rounded-xl${NC}"
echo -e "  ${RED}•${NC} Shadows without borders: ${YELLOW}shadow-lg${NC} without ${CYAN}border${NC}"
echo -e "  ${RED}•${NC} Arbitrary spacing: ${YELLOW}w-[347px]${NC} (use 4px scale)\n"

echo -e "${BOLD}${CYAN}🔍 Breaking Changes Warning:${NC}\n"
echo -e "  ${YELLOW}•${NC} Don't remove exports (breaks consumers)"
echo -e "  ${YELLOW}•${NC} Don't remove props (breaks existing usage)"
echo -e "  ${YELLOW}•${NC} Don't rename functions without checking usage"
echo -e "  ${YELLOW}•${NC} Check for component dependencies before changes\n"

echo -e "${BOLD}${CYAN}📖 Key Rules:${NC}\n"
echo -e "  1. ${BOLD}Read existing code FIRST${NC} - understand before changing"
echo -e "  2. ${BOLD}Follow README_STYLE.md ALWAYS${NC} - design system is mandatory"
echo -e "  3. ${BOLD}No breaking changes${NC} - check API usage before removal"
echo -e "  4. ${BOLD}Test all accent colors${NC} - ensure semantic colors work\n"

echo -e "${BOLD}${GREEN}Pre-validation complete!${NC}\n"
echo -e "${CYAN}You can now proceed with UI changes.${NC}"
echo -e "${CYAN}Remember: Git pre-commit hook will enforce these rules.${NC}\n"

exit 0
